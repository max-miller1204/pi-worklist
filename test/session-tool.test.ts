import { describe, expect, it } from "vitest";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { SessionStore, SESSION_SNAPSHOT_TYPE } from "../src/session-store.ts";
import { executeWorklist, formatSessionTasks } from "../src/tool.ts";
import worklistExtension from "../src/extension.ts";
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

	it("inserts and moves tasks by stable anchor ID", async () => {
		const { api, entries } = fakePi();
		const store = new SessionStore(api);
		const associated = { id: "b", title: "Completed", status: "done" as const, goalId: "goal-1" };
		store.setTasks([
			{ id: "a", title: "First", status: "todo" },
			associated,
			{ id: "c", title: "Current", status: "doing" },
		]);

		await executeWorklist({ scope: "session", action: "add", title: "Before", beforeId: "a" }, ctx, {
			sessionStore: store,
			projectPath: null,
		});
		await executeWorklist({ scope: "session", action: "add", title: "After", afterId: "b" }, ctx, {
			sessionStore: store,
			projectPath: null,
		});
		await executeWorklist({ scope: "session", action: "add", title: "Appended" }, ctx, {
			sessionStore: store,
			projectPath: null,
		});
		expect(store.getTasks().map((task) => task.title)).toEqual([
			"Before",
			"First",
			"Completed",
			"After",
			"Current",
			"Appended",
		]);

		await executeWorklist({ scope: "session", action: "move", id: "b", beforeId: "a" }, ctx, {
			sessionStore: store,
			projectPath: null,
		});
		await executeWorklist({ scope: "session", action: "move", id: "b", afterId: "c" }, ctx, {
			sessionStore: store,
			projectPath: null,
		});
		expect(store.getTasks().map((task) => task.title)).toEqual([
			"Before",
			"First",
			"After",
			"Current",
			"Completed",
			"Appended",
		]);
		expect(store.getTasks().find((task) => task.id === "b")).toEqual(associated);
		expect(entries).toHaveLength(5);
	});

	it("does not persist self-placement or already-satisfied moves", async () => {
		const { api, entries } = fakePi();
		const store = new SessionStore(api);
		store.setTasks([
			{ id: "a", title: "First", status: "todo" },
			{ id: "b", title: "Second", status: "doing" },
			{ id: "c", title: "Third", status: "done" },
		]);

		for (const params of [
			{ scope: "session" as const, action: "move", id: "a", beforeId: "a" },
			{ scope: "session" as const, action: "move", id: "a", beforeId: "b" },
			{ scope: "session" as const, action: "move", id: "b", afterId: "a" },
		]) {
			await expect(
				executeWorklist(params, ctx, { sessionStore: store, projectPath: null }),
			).resolves.toMatchObject({ details: { action: "move" } });
		}
		expect(entries).toHaveLength(0);

		await executeWorklist({ scope: "session", action: "move", id: "c", beforeId: "a" }, ctx, {
			sessionStore: store,
			projectPath: null,
		});
		expect(store.getTasks().map((task) => task.id)).toEqual(["c", "a", "b"]);
		expect(entries).toHaveLength(1);
	});

	it("rejects invalid placement without poisoning serialized mutations", async () => {
		const { api, entries } = fakePi();
		const store = new SessionStore(api);
		store.setTasks([
			{ id: "a", title: "First", status: "todo" },
			{ id: "b", title: "Second", status: "todo" },
		]);

		const invalidCalls = [
			{
				params: { scope: "session" as const, action: "add", title: "Both", beforeId: "a", afterId: "b" },
				error: "exactly one",
			},
			{
				params: { scope: "session" as const, action: "add", title: "Blank", beforeId: "  " },
				error: "must not be blank",
			},
			{ params: { scope: "session" as const, action: "move", id: "a" }, error: "requires exactly one" },
			{ params: { scope: "session" as const, action: "list", beforeId: "a" }, error: "only supported" },
			{
				params: { scope: "project" as const, action: "add", title: "Goal", afterId: "a" },
				error: "Project Goal reordering",
			},
			{
				params: { scope: "project" as const, action: "move", id: "a", beforeId: "b" },
				error: "Project Goal reordering",
			},
		];
		for (const { params, error } of invalidCalls) {
			await expect(executeWorklist(params, ctx, { sessionStore: store, projectPath: null })).rejects.toThrow(
				error,
			);
		}
		expect(entries).toHaveLength(0);

		await expect(
			executeWorklist({ scope: "session", action: "add", title: "Unknown", beforeId: "missing" }, ctx, {
				sessionStore: store,
				projectPath: null,
			}),
		).rejects.toThrow("anchor missing not found");
		await expect(
			executeWorklist({ scope: "session", action: "move", id: "missing", beforeId: "a" }, ctx, {
				sessionStore: store,
				projectPath: null,
			}),
		).rejects.toThrow("Session task missing not found");
		await expect(
			executeWorklist({ scope: "session", action: "move", id: "a", afterId: "missing" }, ctx, {
				sessionStore: store,
				projectPath: null,
			}),
		).rejects.toThrow("anchor missing not found");

		const deleting = store.deleteTask("b");
		const staleAdd = store.addTask("Stale anchor", undefined, { afterId: "b" });
		await expect(deleting).resolves.toBe(true);
		await expect(staleAdd).rejects.toThrow("anchor b not found");
		await expect(store.addTask("Queue recovered")).resolves.toMatchObject({ title: "Queue recovered" });
		expect(store.getTasks().map((task) => task.title)).toEqual(["First", "Queue recovered"]);
		expect(entries).toHaveLength(2);
	});

	it("resolves move sources and anchors in serialized mutation order", async () => {
		const { api, entries } = fakePi();
		const store = new SessionStore(api);
		store.setTasks([
			{ id: "a", title: "First", status: "todo" },
			{ id: "b", title: "Anchor", status: "done" },
			{ id: "c", title: "Moving", status: "doing" },
		]);

		const deleteAnchor = store.deleteTask("b");
		const staleMove = store.moveTask("c", { afterId: "b" });
		await expect(deleteAnchor).resolves.toBe(true);
		await expect(staleMove).rejects.toThrow("anchor b not found");
		await expect(store.moveTask("c", { beforeId: "a" })).resolves.toMatchObject({ id: "c" });
		expect(store.getTasks().map((task) => task.id)).toEqual(["c", "a"]);
		expect(entries).toHaveLength(2);

		const deleteSource = store.deleteTask("c");
		const missingSourceMove = store.moveTask("c", { afterId: "a" });
		await expect(deleteSource).resolves.toBe(true);
		await expect(missingSourceMove).resolves.toBeNull();
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

describe("registered model tool", () => {
	function registerExtension() {
		let tool: Record<string, unknown> | undefined;
		const api = {
			appendEntry: () => {},
			registerTool: (config: Record<string, unknown>) => {
				tool = config;
			},
			registerCommand: () => {},
			on: () => {},
		} as unknown as ExtensionAPI;
		worklistExtension(api);
		if (!tool) throw new Error("worklist tool was not registered");
		return tool;
	}

	it("keeps model tool execution sequential so ordering mutations stay serialized", () => {
		expect(registerExtension().executionMode).toBe("sequential");
	});

	it("exposes the session ordering surface to the model", () => {
		const parameters = registerExtension().parameters as {
			properties: Record<string, { enum?: string[]; description?: string }>;
		};
		expect(parameters.properties.action.enum).toContain("move");
		expect(parameters.properties.beforeId).toBeDefined();
		expect(parameters.properties.afterId).toBeDefined();
	});
});
