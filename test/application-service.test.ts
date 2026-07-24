import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { describe, expect, it } from "vitest";
import { WorklistApplicationService, type WorklistOperationSource } from "../src/application-service.ts";
import { SessionStore } from "../src/session-store.ts";

function createSessionStore() {
	const entries: unknown[] = [];
	const pi = {
		appendEntry: (customType: string, data: unknown) => entries.push({ type: "custom", customType, data }),
	} as unknown as ExtensionAPI;
	return { entries, store: new SessionStore(pi) };
}

describe("worklist application service", () => {
	it("applies one operation contract for tool, command, dashboard, CLI, and protocol callers", async () => {
		const projectPath = join(
			await mkdtemp(join(tmpdir(), "pi-worklist-application-service-")),
			".pi",
			"worklist.json",
		);
		const { entries, store } = createSessionStore();
		const service = new WorklistApplicationService({ sessionStore: store, projectPath });
		const sources = [
			"tool",
			"command",
			"dashboard",
			"cli",
			"protocol",
		] as const satisfies readonly WorklistOperationSource[];

		for (const [index, source] of sources.entries()) {
			await service.execute({ scope: "session", action: "add", title: `${source} task` }, { source });
			const id = service.getSessionTasks().at(-1)?.id;
			expect(id).toBeTruthy();
			await service.execute(
				{ scope: "session", action: "set_status", id, status: index % 2 === 0 ? "doing" : "done" },
				{ source },
			);
		}

		expect(service.getSessionTasks().map(({ title, status }) => ({ title, status }))).toEqual([
			{ title: "tool task", status: "doing" },
			{ title: "command task", status: "done" },
			{ title: "dashboard task", status: "doing" },
			{ title: "cli task", status: "done" },
			{ title: "protocol task", status: "doing" },
		]);
		expect(entries).toHaveLength(10);

		const added = await service.execute(
			{ scope: "project", action: "add", title: "Shared goal", description: "One rule set" },
			{ source: "cli" },
		);
		const goalId = added.goal?.id;
		expect(goalId).toBeTruthy();
		await service.execute(
			{ scope: "project", action: "update", id: goalId, title: "Updated through protocol" },
			{ source: "protocol" },
		);
		const listed = await service.execute({ scope: "project", action: "list" }, { source: "tool" });
		expect(listed.goals).toEqual([
			expect.objectContaining({
				id: goalId,
				title: "Updated through protocol",
				description: "One rule set",
			}),
		]);
	});

	it("enforces shared validation and explicit confirmation regardless of caller", async () => {
		const projectPath = join(
			await mkdtemp(join(tmpdir(), "pi-worklist-application-validation-")),
			".pi",
			"worklist.json",
		);
		const { store } = createSessionStore();
		const service = new WorklistApplicationService({ sessionStore: store, projectPath });
		const added = await service.execute(
			{ scope: "project", action: "add", title: "Protected goal" },
			{ source: "command" },
		);
		const id = added.goal?.id;

		for (const source of ["tool", "command", "dashboard", "cli", "protocol"] as const) {
			await expect(
				service.execute(
					{ scope: "session", action: "add", title: "Invalid", beforeId: "a", afterId: "b" },
					{ source },
				),
			).rejects.toThrow("mutually exclusive");
			await expect(
				service.execute({ scope: "project", action: "complete", id }, { source }),
			).resolves.toMatchObject({ requiresConfirm: true });
		}

		expect((await service.getProjectGoals()).find((goal) => goal.id === id)?.status).toBe("open");
		await expect(
			service.execute({ scope: "project", action: "complete", id, confirm: true }, { source: "dashboard" }),
		).resolves.toMatchObject({ goal: { id, status: "done" } });
	});
});
