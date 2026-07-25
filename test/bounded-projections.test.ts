import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { describe, expect, it } from "vitest";
import { WorklistApplicationService } from "../src/application-service.ts";
import { WORKLIST_PROVIDER_LIMITS } from "../src/integration-contract.ts";
import { SessionStore } from "../src/session-store.ts";
import type { StoredSessionTask } from "../src/types.ts";

function managedMetadata(externalId: string) {
	return {
		version: 1,
		owner: "pi-orchestrator",
		producer: { id: "pi-orchestrator", version: "0.9.0" },
		external: { system: "pi-orchestrator", kind: "workflow-step", id: externalId },
		planRevision: 2,
		approvedPlanRevision: 2,
		createdAt: "2026-07-25T09:00:00.000Z",
		updatedAt: "2026-07-25T09:05:00.000Z",
		execution: {
			state: "running",
			updatedAt: "2026-07-25T09:05:00.000Z",
			runId: "run-12",
			runReference: "pi-orchestrator://runs/run-12",
		},
	};
}

function createSessionWithTasks(tasks: StoredSessionTask[]) {
	const pi = {
		appendEntry: () => undefined,
	} as unknown as ExtensionAPI;
	const sessionStore = new SessionStore(pi);
	sessionStore.reconstruct({
		sessionManager: {
			getBranch: () => [
				{
					type: "custom",
					id: "projection-fixture",
					customType: "worklist-session-snapshot",
					data: { version: 3, revision: "projection-fixture", tasks },
				},
			],
		},
	} as never);
	return new WorklistApplicationService({ sessionStore });
}

function syntheticTasks(count: number): StoredSessionTask[] {
	return Array.from({ length: count }, (_, index) => ({
		id: `task-${index}`,
		title: `Task ${index}`,
		status: index % 3 === 0 ? "done" : index % 3 === 1 ? "doing" : "todo",
		...(index % 2 === 0 ? { goalId: "goal-even" } : { goalId: "goal-odd" }),
	}));
}

describe("bounded session task list projections", () => {
	it("applies the default limit, reports truncation, and continues with an opaque cursor", async () => {
		const service = createSessionWithTasks(syntheticTasks(25));
		const first = await service.execute(
			{ scope: "session", action: "list_projection" },
			{ source: "protocol" },
		);
		expect(first).toMatchObject({
			ok: true,
			meta: {
				changed: false,
				semanticNoOp: false,
				changedFields: [],
				revisions: { session: "projection-fixture" },
			},
		});
		if (!first.ok || !first.result.taskProjections) throw new Error("Expected list projection");
		const page = first.result.taskProjections.page;
		expect(page).toMatchObject({
			limit: WORKLIST_PROVIDER_LIMITS.defaultListLimit,
			returned: WORKLIST_PROVIDER_LIMITS.defaultListLimit,
			truncated: true,
			nextCursor: expect.any(String),
		});
		expect(first.result.taskProjections.tasks).toHaveLength(WORKLIST_PROVIDER_LIMITS.defaultListLimit);
		expect(first.result.taskProjections.tasks[0]).toEqual({
			id: "task-0",
			title: "Task 0",
			status: "done",
			goalId: "goal-even",
		});

		const rest = await service.execute(
			{ scope: "session", action: "list_projection", listProjection: { cursor: page.nextCursor } },
			{ source: "protocol" },
		);
		if (!rest.ok || !rest.result.taskProjections) throw new Error("Expected list continuation");
		expect(rest.result.taskProjections.page).toMatchObject({ returned: 5, truncated: false });
		expect(rest.result.taskProjections.page.nextCursor).toBeUndefined();
		expect(rest.result.taskProjections.tasks[0]?.id).toBe("task-20");
	});

	it("filters by goal and status, clamps limits, and rejects invalid input", async () => {
		const service = createSessionWithTasks(syntheticTasks(12));
		const filtered = await service.execute(
			{
				scope: "session",
				action: "list_projection",
				listProjection: { goalId: "goal-even", statuses: ["done"], limit: 2 },
			},
			{ source: "protocol" },
		);
		if (!filtered.ok || !filtered.result.taskProjections) throw new Error("Expected filtered projection");
		expect(filtered.result.taskProjections.tasks.map((task) => task.id)).toEqual(["task-0", "task-6"]);
		expect(filtered.result.taskProjections.page).toMatchObject({ limit: 2, returned: 2 });

		const clamped = await service.execute(
			{
				scope: "session",
				action: "list_projection",
				listProjection: { limit: WORKLIST_PROVIDER_LIMITS.maxListLimit + 400 },
			},
			{ source: "protocol" },
		);
		if (!clamped.ok || !clamped.result.taskProjections) throw new Error("Expected clamped projection");
		expect(clamped.result.taskProjections.page.limit).toBe(WORKLIST_PROVIDER_LIMITS.maxListLimit);

		const invalidLimit = await service.execute(
			{ scope: "session", action: "list_projection", listProjection: { limit: 0 } },
			{ source: "protocol" },
		);
		expect(invalidLimit).toMatchObject({
			ok: false,
			error: { code: "VALIDATION_FAILED", details: { field: "listProjection.limit" } },
		});

		const invalidStatus = await service.execute(
			{
				scope: "session",
				action: "list_projection",
				listProjection: { statuses: ["blocked" as never] },
			},
			{ source: "protocol" },
		);
		expect(invalidStatus).toMatchObject({
			ok: false,
			error: { code: "VALIDATION_FAILED", details: { field: "listProjection.statuses" } },
		});

		const malformedCursor = await service.execute(
			{ scope: "session", action: "list_projection", listProjection: { cursor: "not-a-cursor" } },
			{ source: "protocol" },
		);
		expect(malformedCursor).toMatchObject({
			ok: false,
			error: {
				code: "VALIDATION_FAILED",
				details: { field: "listProjection.cursor", resolution: "restart-list-from-beginning" },
			},
		});
	});

	it("keeps list items compact while including managed metadata and truncation notices", async () => {
		const longTitle = `${"long ".repeat(200)}end`;
		const service = createSessionWithTasks([
			{ id: "user-1", title: longTitle, status: "todo" },
			{
				id: "managed-1",
				title: "Managed step",
				status: "doing",
				goalId: "goal-1",
				managed: managedMetadata("step-1") as StoredSessionTask["managed"],
			},
		]);
		const listed = await service.execute(
			{ scope: "session", action: "list_projection" },
			{ source: "protocol" },
		);
		if (!listed.ok || !listed.result.taskProjections) throw new Error("Expected projection");
		const [truncatedTask, managedTask] = listed.result.taskProjections.tasks;
		expect(truncatedTask?.projection).toEqual({ truncatedFields: ["title"] });
		expect(Buffer.byteLength(truncatedTask?.title ?? "", "utf8")).toBeLessThanOrEqual(
			WORKLIST_PROVIDER_LIMITS.maxTitleBytes,
		);
		expect(managedTask).toMatchObject({
			id: "managed-1",
			managed: {
				owner: "pi-orchestrator",
				external: { id: "step-1" },
				execution: { state: "running", runId: "run-12" },
			},
		});
		expect(managedTask?.projection).toBeUndefined();
	});
});

describe("explicit project goal detail projections", () => {
	async function createProject() {
		const projectPath = join(
			await mkdtemp(join(tmpdir(), "pi-worklist-goal-projection-")),
			".pi",
			"worklist.json",
		);
		return new WorklistApplicationService({ projectPath });
	}

	it("returns the active goal or null and full bounded detail by ID", async () => {
		const service = await createProject();
		const emptyActive = await service.execute(
			{ scope: "project", action: "get_projection", goalSelector: { type: "active" } },
			{ source: "protocol" },
		);
		expect(emptyActive).toMatchObject({
			ok: true,
			result: { goalProjection: null },
			meta: { changed: false, semanticNoOp: false, revisions: { project: "0" } },
		});

		const description = `${"detail ".repeat(700)}end`;
		const added = await service.execute(
			{ scope: "project", action: "add", title: "Detailed goal", description },
			{ source: "command" },
		);
		if (!added.ok || !added.result.goal) throw new Error("Expected goal");
		const goal = added.result.goal;
		const activated = await service.execute(
			{ scope: "project", action: "set_active", id: goal.id },
			{ source: "command" },
		);
		if (!activated.ok || !activated.result.goal) throw new Error("Expected activation");

		const activeProjection = await service.execute(
			{ scope: "project", action: "get_projection", goalSelector: { type: "active" } },
			{ source: "protocol" },
		);
		expect(activeProjection).toMatchObject({
			ok: true,
			result: { goalProjection: { id: goal.id, status: "active" } },
			meta: { revisions: { project: "2" } },
		});

		const detail = await service.execute(
			{ scope: "project", action: "get_projection", goalSelector: { type: "id", id: goal.id } },
			{ source: "protocol" },
		);
		if (!detail.ok || !detail.result.goalProjection) throw new Error("Expected detail projection");
		expect(detail.result.goalProjection.projection).toEqual({ truncatedFields: ["description"] });
		expect(Buffer.byteLength(detail.result.goalProjection.description ?? "", "utf8")).toBeLessThanOrEqual(
			WORKLIST_PROVIDER_LIMITS.maxDescriptionBytes,
		);
		expect(detail.result.goalProjection.updatedAt).toBe(activated.result.goal.updatedAt);
	});

	it("rejects missing and closed goals with actionable errors", async () => {
		const service = await createProject();
		const missing = await service.execute(
			{ scope: "project", action: "get_projection", goalSelector: { type: "id", id: "goal-missing" } },
			{ source: "protocol" },
		);
		expect(missing).toMatchObject({
			ok: false,
			error: { code: "NOT_FOUND", details: { entity: "project-goal", id: "goal-missing" } },
		});

		const added = await service.execute(
			{ scope: "project", action: "add", title: "Closed goal" },
			{ source: "command" },
		);
		if (!added.ok || !added.result.goal) throw new Error("Expected goal");
		await service.execute(
			{ scope: "project", action: "complete", id: added.result.goal.id, confirm: true },
			{ source: "command" },
		);
		const closed = await service.execute(
			{
				scope: "project",
				action: "get_projection",
				goalSelector: { type: "id", id: added.result.goal.id },
			},
			{ source: "protocol" },
		);
		expect(closed).toMatchObject({
			ok: false,
			error: {
				code: "VALIDATION_FAILED",
				details: { id: added.result.goal.id, status: "done", resolution: "reopen-project-goal" },
			},
		});

		const badSelector = await service.execute(
			{ scope: "project", action: "get_projection" },
			{ source: "protocol" },
		);
		expect(badSelector).toMatchObject({
			ok: false,
			error: { code: "VALIDATION_FAILED", details: { fields: ["goalSelector"] } },
		});
	});
});
