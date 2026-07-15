import { describe, expect, it } from "vitest";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { SessionStore, SESSION_SNAPSHOT_TYPE } from "../src/session-store.ts";
import { executeWorklist, formatSessionTasks } from "../src/tool.ts";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

function fakePi(entries: unknown[] = []) {
	return {
		entries,
		api: {
			appendEntry: (customType: string, data: unknown) => entries.push({ type: "custom", customType, data }),
		} as unknown as ExtensionAPI,
	};
}

const ctx = { cwd: process.cwd() } as ExtensionContext;

describe("session state and tool", () => {
	it("reconstructs the latest snapshot on the active branch", () => {
		const { api } = fakePi();
		const store = new SessionStore(api);
		store.reconstruct({
			sessionManager: {
				getBranch: () => [
					{
						type: "custom",
						customType: SESSION_SNAPSHOT_TYPE,
						data: { version: 1, tasks: [{ id: "a", title: "old", status: "todo" }] },
					},
					{ type: "custom", customType: "other", data: {} },
					{
						type: "custom",
						customType: SESSION_SNAPSHOT_TYPE,
						data: {
							version: 1,
							tasks: [{ id: "b", title: "new", description: "Legacy context", status: "doing" }],
						},
					},
				],
			},
		} as unknown as ExtensionContext);
		expect(store.getTasks()).toEqual([{ id: "b", title: "new", status: "doing" }]);
	});

	it("skips malformed tasks while keeping valid ones during reconstruction", () => {
		const { api } = fakePi();
		const store = new SessionStore(api);
		store.reconstruct({
			sessionManager: {
				getBranch: () => [
					{
						type: "custom",
						customType: SESSION_SNAPSHOT_TYPE,
						data: {
							version: 2,
							tasks: [
								null,
								["id", "title", "status"],
								{ title: "missing id", status: "todo" },
								{ id: 42, title: "numeric id", status: "todo" },
								{ id: "bad-title", title: null, status: "todo" },
								{ id: "bad-status", title: "Bad status", status: "paused" },
								{ id: "bad-goal", title: "Bad goal", status: "todo", goalId: 7 },
								{ id: "ok", title: "Valid", status: "doing" },
								{ id: "ok-goal", title: "Valid with goal", status: "done", goalId: "g-1" },
							],
						},
					},
				],
			},
		} as unknown as ExtensionContext);
		expect(store.getTasks()).toEqual([
			{ id: "ok", title: "Valid", status: "doing" },
			{ id: "ok-goal", title: "Valid with goal", status: "done", goalId: "g-1" },
		]);
	});

	it("ignores snapshots with unsupported versions", () => {
		const { api } = fakePi();
		const store = new SessionStore(api);
		store.reconstruct({
			sessionManager: {
				getBranch: () => [
					{
						type: "custom",
						customType: SESSION_SNAPSHOT_TYPE,
						data: { version: 2, tasks: [{ id: "a", title: "Supported", status: "todo" }] },
					},
					{
						type: "custom",
						customType: SESSION_SNAPSHOT_TYPE,
						data: { version: 3, tasks: [{ id: "b", title: "Future", status: "todo" }] },
					},
				],
			},
		} as unknown as ExtensionContext);
		expect(store.getTasks()).toEqual([{ id: "a", title: "Supported", status: "todo" }]);
	});

	it("supports session CRUD and persists snapshots", async () => {
		const { api, entries } = fakePi();
		const store = new SessionStore(api);
		await expect(
			executeWorklist(
				{
					scope: "session",
					action: "add",
					title: "Test it",
					description: "Cover the RPC and UI paths",
				},
				ctx,
				{ sessionStore: store, projectPath: null },
			),
		).rejects.toThrow("only supported for project goals");
		expect(entries).toHaveLength(0);
		const added = await executeWorklist({ scope: "session", action: "add", title: "Test it" }, ctx, {
			sessionStore: store,
			projectPath: null,
		});
		const id = added.details.tasks?.[0]?.id;
		expect(id).toBeTruthy();
		expect(formatSessionTasks(store.getTasks())).toContain("Test it");
		await executeWorklist({ scope: "session", action: "update", id, title: "Test it well" }, ctx, {
			sessionStore: store,
			projectPath: null,
		});
		expect(store.getTasks()[0]?.title).toBe("Test it well");
		await executeWorklist({ scope: "session", action: "set_status", id, status: "done" }, ctx, {
			sessionStore: store,
			projectPath: null,
		});
		expect(store.getTasks()[0]?.status).toBe("done");
		expect(entries).toHaveLength(3);
	});

	it("guards every destructive project lifecycle path", async () => {
		const path = join(await mkdtemp(join(tmpdir(), "pi-worklist-tool-")), ".pi", "worklist.json");
		const { api } = fakePi();
		const store = new SessionStore(api);
		const added = await executeWorklist({ scope: "project", action: "add", title: "Ship" }, ctx, {
			sessionStore: store,
			projectPath: path,
		});
		const id = added.details.goals?.[0]?.id;
		for (const action of ["complete", "reopen", "archive", "delete"]) {
			const result = await executeWorklist({ scope: "project", action, id }, ctx, {
				sessionStore: store,
				projectPath: path,
			});
			expect(result.details.requiresConfirm).toBe(true);
		}
		await expect(
			executeWorklist({ scope: "project", action: "set_status", id, status: "done" }, ctx, {
				sessionStore: store,
				projectPath: path,
			}),
		).rejects.toThrow("only accepts active");
		const completed = await executeWorklist(
			{ scope: "project", action: "complete", id, confirm: true },
			ctx,
			{ sessionStore: store, projectPath: path },
		);
		expect(completed.details.goals?.[0]?.status).toBe("done");
		await expect(
			executeWorklist({ scope: "project", action: "set_active", id }, ctx, {
				sessionStore: store,
				projectPath: path,
			}),
		).rejects.toThrow("must be reopened");
	});
});
