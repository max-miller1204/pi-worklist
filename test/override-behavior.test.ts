import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { describe, expect, it } from "vitest";
import { WorklistApplicationService } from "../src/application-service.ts";
import type { WorklistChangeDescription } from "../src/change-events.ts";
import type { ManagedSessionTaskInput } from "../src/integration-contract.ts";
import { normalizeManagedSessionTaskProjection } from "../src/managed-projection.ts";
import { SessionStore } from "../src/session-store.ts";

function managedInput(
	externalId: string,
	title: string,
	status: ManagedSessionTaskInput["status"] = "todo",
): ManagedSessionTaskInput {
	return {
		external: { system: "pi-orchestrator", kind: "workflow-step", id: externalId },
		title,
		status,
		producer: { id: "pi-orchestrator", version: "0.9.0" },
		planRevision: 1,
		approvedPlanRevision: 1,
		execution: {
			state: "planned",
			updatedAt: "2026-07-25T12:00:00.000Z",
			runId: "run-14",
		},
	};
}

async function createManagedFixture() {
	const projectPath = join(await mkdtemp(join(tmpdir(), "pi-worklist-override-")), ".pi", "worklist.json");
	const entries: Array<{ type: string; customType: string; data: unknown }> = [];
	const pi = {
		appendEntry: (customType: string, data: unknown) => entries.push({ type: "custom", customType, data }),
	} as unknown as ExtensionAPI;
	const sessionStore = new SessionStore(pi);
	const events: WorklistChangeDescription[] = [];
	const service = new WorklistApplicationService({
		projectPath,
		sessionStore,
		publishChange: (description) => events.push(description),
	});
	const addedGoal = await service.execute(
		{ scope: "project", action: "add", title: "Overridable goal" },
		{ source: "command" },
	);
	if (!addedGoal.ok || !addedGoal.result.goal) throw new Error("Expected goal creation");
	const goal = addedGoal.result.goal;
	const reconciled = await service.execute(
		{
			scope: "session",
			action: "reconcile",
			reconciliation: {
				idempotencyKey: "run-14:plan-1",
				goalId: goal.id,
				expectedGoalUpdatedAt: goal.updatedAt,
				owner: "pi-orchestrator",
				tasks: [managedInput("step-a", "Projected A"), managedInput("step-b", "Projected B")],
			},
		},
		{ source: "protocol" },
	);
	if (!reconciled.ok || !reconciled.result.reconciliation) throw new Error("Expected reconciliation");
	const taskIds = new Map(
		reconciled.result.reconciliation.tasks.map((task) => [task.external.id, task.taskId] as const),
	);
	events.length = 0;
	return { entries, events, goal, service, sessionStore, taskIds };
}

function lastSnapshotTask(entries: Array<{ customType: string; data: unknown }>, taskId: string) {
	const snapshots = entries.filter((entry) => entry.customType === "worklist-session-snapshot");
	const data = snapshots.at(-1)?.data as { tasks: Array<Record<string, unknown>> };
	return data.tasks.find((task) => task.id === taskId);
}

describe("managed Session Task override behavior", () => {
	it("marks manual edits as user overrides and emits a divergence event", async () => {
		const { entries, events, service, taskIds } = await createManagedFixture();
		const taskId = taskIds.get("step-a");
		if (!taskId) throw new Error("Expected managed task");

		const edited = await service.execute(
			{ scope: "session", action: "update", id: taskId, title: "My own title" },
			{ source: "dashboard" },
		);
		expect(edited).toMatchObject({ ok: true, meta: { changed: true } });
		expect(events).toHaveLength(1);
		expect(events[0]).toMatchObject({
			mutation: "session-tasks.user-overridden",
			changedEntities: { sessionTaskIds: [taskId] },
		});

		const stored = lastSnapshotTask(entries, taskId);
		expect(stored).toMatchObject({
			title: "My own title",
			managed: { userOverride: { overriddenFields: ["title"] } },
		});

		const statusChanged = await service.execute(
			{ scope: "session", action: "set_status", id: taskId, status: "done" },
			{ source: "tool" },
		);
		expect(statusChanged).toMatchObject({ ok: true });
		expect(events).toHaveLength(2);
		expect(events[1]?.mutation).toBe("session-tasks.user-overridden");
		expect(lastSnapshotTask(entries, taskId)).toMatchObject({
			managed: { userOverride: { overriddenFields: ["status", "title"] } },
		});

		// Ordinary user tasks never emit override events.
		const userTask = await service.execute(
			{ scope: "session", action: "add", title: "Plain task" },
			{ source: "tool" },
		);
		if (!userTask.ok || !userTask.result.task) throw new Error("Expected task");
		await service.execute(
			{ scope: "session", action: "set_status", id: userTask.result.task.id, status: "doing" },
			{ source: "tool" },
		);
		expect(events.at(-1)?.mutation).toBe("session-tasks.changed-manually");
	});

	it("preserves overridden tasks during reconciliation instead of restoring stale data", async () => {
		const { events, goal, service, sessionStore, taskIds } = await createManagedFixture();
		const taskId = taskIds.get("step-a");
		if (!taskId) throw new Error("Expected managed task");
		await service.execute(
			{ scope: "session", action: "update", id: taskId, title: "User decision" },
			{ source: "dashboard" },
		);
		events.length = 0;

		const reconciled = await service.execute(
			{
				scope: "session",
				action: "reconcile",
				reconciliation: {
					idempotencyKey: "run-14:plan-2",
					goalId: goal.id,
					expectedGoalUpdatedAt: goal.updatedAt,
					owner: "pi-orchestrator",
					tasks: [
						managedInput("step-a", "Stale projected title", "doing"),
						managedInput("step-b", "Projected B"),
					],
				},
			},
			{ source: "protocol" },
		);
		expect(reconciled).toMatchObject({
			ok: true,
			result: {
				reconciliation: {
					tasks: [
						{ external: { id: "step-a" }, taskId, action: "preserved-user-override" },
						{ external: { id: "step-b" }, action: "unchanged" },
					],
				},
			},
			meta: { changed: false, semanticNoOp: true },
		});
		const preserved = sessionStore.getTasks().find((task) => task.id === taskId);
		expect(preserved).toMatchObject({ title: "User decision", status: "todo" });
	});

	it("preserves overridden execution state and detaches stale overridden projections", async () => {
		const { events, goal, service, sessionStore, taskIds } = await createManagedFixture();
		const taskId = taskIds.get("step-a");
		if (!taskId) throw new Error("Expected managed task");
		await service.execute(
			{ scope: "session", action: "set_status", id: taskId, status: "done" },
			{ source: "dashboard" },
		);
		events.length = 0;

		const executionUpdate = await service.execute(
			{
				scope: "session",
				action: "update_execution",
				executionUpdate: {
					idempotencyKey: "run-14:execution-1",
					owner: "pi-orchestrator",
					updates: [
						{
							external: { system: "pi-orchestrator", kind: "workflow-step", id: "step-a" },
							execution: {
								state: "running",
								updatedAt: "2026-07-25T12:10:00.000Z",
								runId: "run-14",
							},
						},
					],
				},
			},
			{ source: "protocol" },
		);
		expect(executionUpdate).toMatchObject({
			ok: true,
			result: {
				reconciliation: {
					tasks: [{ external: { id: "step-a" }, taskId, action: "preserved-user-override" }],
				},
			},
			meta: { changed: false, semanticNoOp: true },
		});

		// The producer stops projecting step-a: the overridden task detaches as a user task.
		const detached = await service.execute(
			{
				scope: "session",
				action: "reconcile",
				reconciliation: {
					idempotencyKey: "run-14:plan-3",
					goalId: goal.id,
					expectedGoalUpdatedAt: goal.updatedAt,
					owner: "pi-orchestrator",
					tasks: [managedInput("step-b", "Projected B")],
				},
			},
			{ source: "protocol" },
		);
		expect(detached).toMatchObject({
			ok: true,
			result: {
				reconciliation: {
					tasks: [
						{ external: { id: "step-b" }, action: "unchanged" },
						{ external: { id: "step-a" }, taskId, action: "preserved-user-override" },
					],
				},
			},
			meta: { changed: true },
		});
		const detachedTask = sessionStore.getStoredTasks().find((task) => task.id === taskId);
		expect(detachedTask).toBeDefined();
		expect(detachedTask?.managed).toBeUndefined();
		expect(detachedTask).toMatchObject({ title: "Projected A", status: "done", goalId: goal.id });
	});

	it("never silently recreates a manually deleted managed task", async () => {
		const { events, goal, service, sessionStore, taskIds } = await createManagedFixture();
		const taskId = taskIds.get("step-a");
		if (!taskId) throw new Error("Expected managed task");

		const deleted = await service.execute(
			{ scope: "session", action: "delete", id: taskId },
			{ source: "dashboard" },
		);
		expect(deleted).toMatchObject({ ok: true });
		expect(events.at(-1)?.mutation).toBe("session-tasks.user-overridden");

		// Same projection set again: the deleted step must stay deleted.
		const reconciled = await service.execute(
			{
				scope: "session",
				action: "reconcile",
				reconciliation: {
					idempotencyKey: "run-14:plan-retry",
					goalId: goal.id,
					expectedGoalUpdatedAt: goal.updatedAt,
					owner: "pi-orchestrator",
					tasks: [managedInput("step-a", "Projected A"), managedInput("step-b", "Projected B")],
				},
			},
			{ source: "protocol" },
		);
		expect(reconciled).toMatchObject({
			ok: true,
			result: {
				reconciliation: {
					tasks: [
						{ external: { id: "step-a" }, taskId, action: "preserved-user-override" },
						{ external: { id: "step-b" }, action: "unchanged" },
					],
				},
			},
			meta: { changed: false, semanticNoOp: true },
		});
		expect(sessionStore.getTasks().some((task) => task.id === taskId)).toBe(false);

		// Execution updates for the deleted projection are preserved, not NOT_FOUND.
		const executionUpdate = await service.execute(
			{
				scope: "session",
				action: "update_execution",
				executionUpdate: {
					idempotencyKey: "run-14:execution-deleted",
					owner: "pi-orchestrator",
					updates: [
						{
							external: { system: "pi-orchestrator", kind: "workflow-step", id: "step-a" },
							execution: {
								state: "running",
								updatedAt: "2026-07-25T12:15:00.000Z",
								runId: "run-14",
							},
						},
					],
				},
			},
			{ source: "protocol" },
		);
		expect(executionUpdate).toMatchObject({
			ok: true,
			result: {
				reconciliation: {
					tasks: [{ external: { id: "step-a" }, taskId, action: "preserved-user-override" }],
				},
			},
		});

		// Once the producer stops projecting the step, the tombstone clears and a
		// later run may project it again as a brand new task.
		await service.execute(
			{
				scope: "session",
				action: "reconcile",
				reconciliation: {
					idempotencyKey: "run-14:plan-4",
					goalId: goal.id,
					expectedGoalUpdatedAt: goal.updatedAt,
					owner: "pi-orchestrator",
					tasks: [managedInput("step-b", "Projected B")],
				},
			},
			{ source: "protocol" },
		);
		const recreated = await service.execute(
			{
				scope: "session",
				action: "reconcile",
				reconciliation: {
					idempotencyKey: "run-14:plan-5",
					goalId: goal.id,
					expectedGoalUpdatedAt: goal.updatedAt,
					owner: "pi-orchestrator",
					tasks: [managedInput("step-a", "Projected A again"), managedInput("step-b", "Projected B")],
				},
			},
			{ source: "protocol" },
		);
		if (!recreated.ok || !recreated.result.reconciliation) throw new Error("Expected reconciliation");
		const recreatedTask = recreated.result.reconciliation.tasks.find((task) => task.external.id === "step-a");
		expect(recreatedTask).toMatchObject({ action: "created" });
		expect(recreatedTask?.taskId).not.toBe(taskId);
	});

	it("survives session reconstruction and never auto-completes the associated goal", async () => {
		const { entries, goal, service, taskIds } = await createManagedFixture();
		const taskId = taskIds.get("step-a");
		if (!taskId) throw new Error("Expected managed task");
		await service.execute({ scope: "session", action: "delete", id: taskId }, { source: "dashboard" });
		await service.execute(
			{ scope: "session", action: "set_status", id: taskIds.get("step-b") ?? "", status: "done" },
			{ source: "dashboard" },
		);

		const recovered = new SessionStore({
			appendEntry: () => undefined,
		} as unknown as ExtensionAPI);
		recovered.reconstruct({ sessionManager: { getBranch: () => entries } } as never);
		const stored = recovered.getStoredTasks();
		expect(stored.some((task) => task.id === taskId)).toBe(false);
		expect(stored.find((task) => task.managed?.external.id === "step-b")?.managed?.userOverride).toEqual({
			overriddenAt: expect.any(String),
			overriddenFields: ["status"],
		});

		// All projected work done, one task even deleted: the goal still is not completed.
		const goals = await service.getProjectGoals();
		expect(goals.find((candidate) => candidate.id === goal.id)?.status).toBe("open");
	});

	it("round-trips override markers through projection normalization", () => {
		const projection = {
			version: 1,
			owner: "pi-orchestrator",
			producer: { id: "pi-orchestrator", version: "0.9.0" },
			external: { system: "pi-orchestrator", kind: "workflow-step", id: "step-a" },
			planRevision: 1,
			approvedPlanRevision: 1,
			createdAt: "2026-07-25T12:00:00.000Z",
			updatedAt: "2026-07-25T12:00:00.000Z",
			execution: { state: "planned", updatedAt: "2026-07-25T12:00:00.000Z", runId: "run-14" },
			userOverride: {
				overriddenAt: "2026-07-25T12:30:00.000Z",
				overriddenFields: ["title", "status", "title", "attempts"],
			},
		};
		expect(normalizeManagedSessionTaskProjection(projection)?.userOverride).toEqual({
			overriddenAt: "2026-07-25T12:30:00.000Z",
			overriddenFields: ["status", "title"],
		});
		expect(
			normalizeManagedSessionTaskProjection({
				...projection,
				userOverride: { overriddenAt: "not-a-timestamp", overriddenFields: ["title"] },
			})?.userOverride,
		).toBeUndefined();
	});
});
