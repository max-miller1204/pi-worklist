import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { describe, expect, it } from "vitest";
import {
	unwrapWorklistApplicationResult,
	WorklistApplicationService,
	type WorklistOperationSource,
} from "../src/application-service.ts";
import { WORKLIST_ERROR_CODES } from "../src/integration-contract.ts";
import { SessionStore } from "../src/session-store.ts";

function createSessionStore() {
	const entries: unknown[] = [];
	const pi = {
		appendEntry: (customType: string, data: unknown) => entries.push({ type: "custom", customType, data }),
	} as unknown as ExtensionAPI;
	return { entries, store: new SessionStore(pi) };
}

describe("worklist application service", () => {
	it("returns the same deterministic success and error envelopes to every interface", async () => {
		const { store } = createSessionStore();
		store.setTasks([{ id: "task-1", title: "Deterministic", status: "doing" }]);
		const service = new WorklistApplicationService({ sessionStore: store });
		const sources = [
			"tool",
			"command",
			"dashboard",
			"cli",
			"protocol",
		] as const satisfies readonly WorklistOperationSource[];

		const successes = await Promise.all(
			sources.map((source) => service.execute({ scope: "session", action: "list" }, { source })),
		);
		expect(successes).toEqual(
			sources.map(() => ({
				ok: true,
				scope: "session",
				action: "list",
				result: {
					scope: "session",
					action: "list",
					tasks: [{ id: "task-1", title: "Deterministic", status: "doing" }],
				},
				meta: { changed: false, semanticNoOp: false, changedFields: [] },
			})),
		);

		const failures = await Promise.all(
			sources.map((source) =>
				service.execute({ scope: "session", action: "move", id: "task-1" }, { source }),
			),
		);
		expect(failures).toEqual(
			sources.map(() => ({
				ok: false,
				scope: "session",
				action: "move",
				error: {
					code: WORKLIST_ERROR_CODES.VALIDATION_FAILED,
					message: "Session move requires exactly one of beforeId or afterId.",
					retryable: false,
					details: {
						fields: ["afterId", "beforeId"],
						resolution: "provide-one-placement-anchor",
					},
				},
				meta: { changed: false, semanticNoOp: false, changedFields: [] },
			})),
		);

		await expect(
			service.execute(
				{ scope: "session", action: "move", id: "task-1", beforeId: "task-1" },
				{ source: "dashboard" },
			),
		).resolves.toMatchObject({
			ok: true,
			meta: { changed: false, semanticNoOp: true, changedFields: [] },
		});
	});

	it("returns actionable not-found and approval errors without rejecting", async () => {
		const projectPath = join(
			await mkdtemp(join(tmpdir(), "pi-worklist-application-errors-")),
			".pi",
			"worklist.json",
		);
		const { store } = createSessionStore();
		const service = new WorklistApplicationService({ sessionStore: store, projectPath });

		await expect(
			service.execute({ scope: "session", action: "delete", id: "missing" }, { source: "tool" }),
		).resolves.toEqual({
			ok: false,
			scope: "session",
			action: "delete",
			error: {
				code: WORKLIST_ERROR_CODES.NOT_FOUND,
				message: "Session task missing was not found.",
				retryable: false,
				details: { entity: "session-task", id: "missing", resolution: "refresh-and-select-existing" },
			},
			meta: { changed: false, semanticNoOp: false, changedFields: [] },
		});

		const added = await service.execute(
			{ scope: "project", action: "add", title: "Protected goal" },
			{ source: "command" },
		);
		expect(added.ok).toBe(true);
		if (!added.ok) return;
		const id = added.result.goal?.id;
		expect(id).toBeTruthy();
		await expect(
			service.execute({ scope: "project", action: "complete", id }, { source: "protocol" }),
		).resolves.toEqual({
			ok: false,
			scope: "project",
			action: "complete",
			error: {
				code: WORKLIST_ERROR_CODES.APPROVAL_REQUIRED,
				message: "Project complete requires explicit confirmation.",
				retryable: false,
				details: { confirmation: "confirm=true", resolution: "request-explicit-user-confirmation" },
			},
			meta: { changed: false, semanticNoOp: false, changedFields: [] },
		});
	});

	it("classifies malformed persistence deterministically without exposing raw exceptions", async () => {
		const projectPath = join(
			await mkdtemp(join(tmpdir(), "pi-worklist-application-persistence-")),
			".pi",
			"worklist.json",
		);
		await mkdir(join(projectPath, ".."), { recursive: true });
		await writeFile(projectPath, "not json\n");
		const service = new WorklistApplicationService({ projectPath });

		await expect(service.execute({ scope: "project", action: "list" }, { source: "cli" })).resolves.toEqual({
			ok: false,
			scope: "project",
			action: "list",
			error: {
				code: WORKLIST_ERROR_CODES.PERSISTENCE_FAILED,
				message:
					"Malformed project worklist or unsupported schema. Repair .pi/worklist.json before retrying.",
				retryable: false,
				details: { resolution: "repair-project-file" },
			},
			meta: { changed: false, semanticNoOp: false, changedFields: [] },
		});
	});

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
		const goalId = unwrapWorklistApplicationResult(added).goal?.id;
		expect(goalId).toBeTruthy();
		await service.execute(
			{ scope: "project", action: "update", id: goalId, title: "Updated through protocol" },
			{ source: "protocol" },
		);
		const listed = unwrapWorklistApplicationResult(
			await service.execute({ scope: "project", action: "list" }, { source: "tool" }),
		);
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
		const id = unwrapWorklistApplicationResult(added).goal?.id;

		for (const source of ["tool", "command", "dashboard", "cli", "protocol"] as const) {
			await expect(
				service.execute(
					{ scope: "session", action: "add", title: "Invalid", beforeId: "a", afterId: "b" },
					{ source },
				),
			).resolves.toMatchObject({
				ok: false,
				error: { code: WORKLIST_ERROR_CODES.VALIDATION_FAILED, retryable: false },
			});
			await expect(
				service.execute({ scope: "project", action: "complete", id }, { source }),
			).resolves.toMatchObject({
				ok: false,
				error: { code: WORKLIST_ERROR_CODES.APPROVAL_REQUIRED, retryable: false },
			});
		}

		expect((await service.getProjectGoals()).find((goal) => goal.id === id)?.status).toBe("open");
		await expect(
			service.execute({ scope: "project", action: "complete", id, confirm: true }, { source: "dashboard" }),
		).resolves.toMatchObject({ ok: true, result: { goal: { id, status: "done" } } });
	});
});
