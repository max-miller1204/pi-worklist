import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { describe, expect, it } from "vitest";
import worklistExtension from "../src/extension.ts";
import { formatSessionTasks } from "../src/format.ts";
import { WORKLIST_ERROR_CODES } from "../src/integration-contract.ts";
import { SESSION_SNAPSHOT_TYPE, SessionStore } from "../src/session-store.ts";
import { executeWorklist } from "../src/tool.ts";

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

	it("restores branch-specific revisions and derives tokens for legacy snapshots", () => {
		const { api } = fakePi();
		const store = new SessionStore(api);
		const legacySnapshot = {
			type: "custom",
			id: "legacy-common",
			customType: SESSION_SNAPSHOT_TYPE,
			data: { version: 1, tasks: [{ id: "common", title: "Common", status: "todo" }] },
		};
		const branches = {
			first: [
				legacySnapshot,
				{
					type: "custom",
					id: "entry-first",
					customType: SESSION_SNAPSHOT_TYPE,
					data: {
						version: 2,
						revision: "branch-first",
						tasks: [{ id: "first", title: "First branch", status: "doing" }],
					},
				},
			],
			second: [
				legacySnapshot,
				{
					type: "custom",
					id: "entry-second",
					customType: SESSION_SNAPSHOT_TYPE,
					data: {
						version: 2,
						revision: "branch-second",
						tasks: [{ id: "second", title: "Second branch", status: "done" }],
					},
				},
			],
		};
		const reconstruct = (branch: unknown[]) =>
			store.reconstruct({
				sessionManager: { getBranch: () => branch },
			} as unknown as ExtensionContext);

		reconstruct(branches.first);
		expect(store.getRevision()).toBe("branch-first");
		expect(store.getTasks()[0]?.id).toBe("first");

		reconstruct(branches.second);
		expect(store.getRevision()).toBe("branch-second");
		expect(store.getTasks()[0]?.id).toBe("second");

		reconstruct([legacySnapshot]);
		expect(store.getRevision()).toBe("legacy-common");
		expect(store.getTasks()[0]?.id).toBe("common");
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

	it("does not append snapshots or advance revisions for semantic no-ops", async () => {
		const { api, entries } = fakePi();
		const store = new SessionStore(api);
		store.setTasks([
			{ id: "a", title: "Stable", status: "doing", goalId: "goal-1" },
			{ id: "b", title: "Anchor", status: "todo" },
		]);

		await expect(
			store.updateTask("a", { title: "Stable", goalId: "goal-1" }, { expectedRevision: "0" }),
		).resolves.toMatchObject({ result: { id: "a" }, changed: false, revision: "0" });
		await expect(store.setTaskStatus("a", "doing", { expectedRevision: "0" })).resolves.toMatchObject({
			result: { id: "a" },
			changed: false,
			revision: "0",
		});
		await expect(store.moveTask("a", { beforeId: "a" }, { expectedRevision: "0" })).resolves.toMatchObject({
			result: { id: "a" },
			changed: false,
			revision: "0",
		});
		expect(entries).toHaveLength(0);
		expect(store.getRevision()).toBe("0");

		await store.updateTask("a", { title: "Changed" }, { expectedRevision: "0" });
		const changedRevision = store.getRevision();
		expect(changedRevision).not.toBe("0");
		expect(entries).toHaveLength(1);
		expect(entries[0]).toMatchObject({
			type: "custom",
			customType: SESSION_SNAPSHOT_TYPE,
			data: { version: 2, revision: changedRevision },
		});

		await expect(
			store.updateTask("a", { title: "Changed" }, { expectedRevision: changedRevision }),
		).resolves.toMatchObject({ result: { id: "a" }, changed: false, revision: changedRevision });
		expect(entries).toHaveLength(1);
		expect(store.getRevision()).toBe(changedRevision);
		await expect(
			store.updateTask("a", { title: "Changed" }, { expectedRevision: "0" }),
		).rejects.toMatchObject({
			name: "SessionRevisionConflictError",
			expectedRevision: "0",
			actualRevision: changedRevision,
		});
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
		).rejects.toMatchObject({
			code: WORKLIST_ERROR_CODES.NOT_FOUND,
			details: { entity: "session-task-anchor", id: "missing" },
		});
		await expect(
			executeWorklist({ scope: "session", action: "move", id: "missing", beforeId: "a" }, ctx, {
				sessionStore: store,
				projectPath: null,
			}),
		).rejects.toMatchObject({
			code: WORKLIST_ERROR_CODES.NOT_FOUND,
			details: { entity: "session-task", id: "missing" },
		});
		await expect(
			executeWorklist({ scope: "session", action: "move", id: "a", afterId: "missing" }, ctx, {
				sessionStore: store,
				projectPath: null,
			}),
		).rejects.toMatchObject({
			code: WORKLIST_ERROR_CODES.NOT_FOUND,
			details: { entity: "session-task-anchor", id: "missing" },
		});

		const deleting = store.deleteTask("b");
		const staleAdd = store.addTask("Stale anchor", undefined, { afterId: "b" });
		const staleAddExpectation = expect(staleAdd).rejects.toThrow("anchor b not found");
		await expect(deleting).resolves.toMatchObject({ result: true, changed: true });
		await staleAddExpectation;
		await expect(store.addTask("Queue recovered")).resolves.toMatchObject({
			result: { title: "Queue recovered" },
			changed: true,
		});
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
		const staleMoveExpectation = expect(staleMove).rejects.toThrow("anchor b not found");
		await expect(deleteAnchor).resolves.toMatchObject({ result: true, changed: true });
		await staleMoveExpectation;
		await expect(store.moveTask("c", { beforeId: "a" })).resolves.toMatchObject({
			result: { id: "c" },
			changed: true,
		});
		expect(store.getTasks().map((task) => task.id)).toEqual(["c", "a"]);
		expect(entries).toHaveLength(2);

		const deleteSource = store.deleteTask("c");
		const missingSourceMove = store.moveTask("c", { afterId: "a" });
		await expect(deleteSource).resolves.toMatchObject({ result: true, changed: true });
		await expect(missingSourceMove).resolves.toMatchObject({ result: null, changed: false });
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
			await expect(
				executeWorklist({ scope: "project", action, id }, ctx, {
					sessionStore: store,
					projectPath: path,
				}),
			).rejects.toMatchObject({
				code: WORKLIST_ERROR_CODES.APPROVAL_REQUIRED,
				retryable: false,
			});
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
