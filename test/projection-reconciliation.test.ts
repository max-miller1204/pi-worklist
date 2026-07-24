import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { afterEach, describe, expect, it, vi } from "vitest";
import { WorklistApplicationService } from "../src/application-service.ts";
import type { ManagedSessionTaskInput } from "../src/integration-contract.ts";
import { SessionStore } from "../src/session-store.ts";

function managedInput(
	externalId: string,
	title: string,
	state: ManagedSessionTaskInput["execution"]["state"],
): ManagedSessionTaskInput {
	return {
		external: { system: "pi-orchestrator", kind: "workflow-step", id: externalId },
		title,
		status: state === "succeeded" ? "done" : state === "running" ? "doing" : "todo",
		producer: { id: "pi-orchestrator", version: "0.9.0" },
		planRevision: 3,
		approvedPlanRevision: 2,
		execution: {
			state,
			updatedAt: "2026-07-25T10:05:00.000Z",
			runId: "run-7",
			runReference: "pi-orchestrator://runs/run-7",
		},
	};
}

afterEach(() => {
	vi.useRealTimers();
});

describe("managed Session Task projection reconciliation", () => {
	it("atomically upserts a run by external identity without disturbing the user queue", async () => {
		vi.useFakeTimers();
		vi.setSystemTime(new Date("2026-07-25T10:00:00.000Z"));
		const projectPath = join(
			await mkdtemp(join(tmpdir(), "pi-worklist-projection-reconcile-")),
			".pi",
			"worklist.json",
		);
		const entries: Array<{ type: string; customType: string; data: unknown }> = [];
		const pi = {
			appendEntry: (customType: string, data: unknown) => entries.push({ type: "custom", customType, data }),
		} as unknown as ExtensionAPI;
		const sessionStore = new SessionStore(pi);
		const service = new WorklistApplicationService({ projectPath, sessionStore });
		const addedGoal = await service.execute(
			{ scope: "project", action: "add", title: "Ship the run" },
			{ source: "command" },
		);
		if (!addedGoal.ok || !addedGoal.result.goal) throw new Error("Expected goal creation");
		const goal = addedGoal.result.goal;

		sessionStore.reconstruct({
			sessionManager: {
				getBranch: () => [
					{
						type: "custom",
						id: "session-before-reconcile",
						customType: "worklist-session-snapshot",
						data: {
							version: 3,
							revision: "session-before-reconcile",
							tasks: [
								{ id: "user-a", title: "Keep first", status: "todo" },
								{
									id: "managed-a",
									title: "Old projected title",
									status: "todo",
									goalId: goal.id,
									managed: {
										version: 1,
										owner: "pi-orchestrator",
										producer: { id: "pi-orchestrator", version: "0.8.0" },
										external: {
											system: "pi-orchestrator",
											kind: "workflow-step",
											id: "step-a",
										},
										planRevision: 1,
										approvedPlanRevision: 1,
										createdAt: "2026-07-25T09:00:00.000Z",
										updatedAt: "2026-07-25T09:00:00.000Z",
										execution: {
											state: "planned",
											updatedAt: "2026-07-25T09:00:00.000Z",
											runId: "run-7",
										},
									},
								},
								{ id: "user-b", title: "Keep last", status: "doing", goalId: goal.id },
								{
									id: "managed-stale",
									title: "No longer projected",
									status: "todo",
									goalId: goal.id,
									managed: {
										version: 1,
										owner: "pi-orchestrator",
										producer: { id: "pi-orchestrator", version: "0.8.0" },
										external: {
											system: "pi-orchestrator",
											kind: "workflow-step",
											id: "step-stale",
										},
										planRevision: 1,
										approvedPlanRevision: 1,
										createdAt: "2026-07-25T09:00:00.000Z",
										updatedAt: "2026-07-25T09:00:00.000Z",
										execution: {
											state: "planned",
											updatedAt: "2026-07-25T09:00:00.000Z",
											runId: "run-7",
										},
									},
								},
							],
						},
					},
				],
			},
		} as never);

		vi.setSystemTime(new Date("2026-07-25T10:05:00.000Z"));
		const updatedStep = managedInput("step-a", "Updated projected title", "running");
		(updatedStep.execution as ManagedSessionTaskInput["execution"] & { attempt: number }).attempt = 4;
		(
			updatedStep.external as ManagedSessionTaskInput["external"] & { repositoryRunId: string }
		).repositoryRunId = "repository-run-secret";
		const reconciliation = {
			expectedSessionRevision: "session-before-reconcile",
			idempotencyKey: "run-7:plan-3",
			goalId: goal.id,
			expectedGoalUpdatedAt: goal.updatedAt,
			owner: "pi-orchestrator" as const,
			tasks: [updatedStep, managedInput("step-b", "New projected task", "planned")],
		};
		const first = await service.execute(
			{ scope: "session", action: "reconcile", reconciliation },
			{ source: "protocol" },
		);

		expect(first).toMatchObject({
			ok: true,
			result: {
				reconciliation: {
					tasks: [
						{ external: { id: "step-a" }, taskId: "managed-a", action: "updated" },
						{ external: { id: "step-b" }, taskId: expect.any(String), action: "created" },
						{ external: { id: "step-stale" }, taskId: "managed-stale", action: "removed" },
					],
				},
			},
			meta: {
				changed: true,
				semanticNoOp: false,
				changedFields: ["/tasks"],
				revisions: { session: expect.any(String) },
			},
		});
		expect(entries).toHaveLength(1);
		expect(entries[0]).toMatchObject({
			customType: "worklist-session-snapshot",
			data: {
				version: 3,
				projectionReconciliations: [{ idempotencyKey: "run-7:plan-3", fingerprint: expect.any(String) }],
			},
		});
		expect(JSON.stringify(entries[0])).not.toContain("attempt");
		expect(JSON.stringify(entries[0])).not.toContain("repository-run-secret");
		expect(sessionStore.getTasks()).toEqual([
			{ id: "user-a", title: "Keep first", status: "todo" },
			{
				id: "managed-a",
				title: "Updated projected title",
				status: "doing",
				goalId: goal.id,
			},
			{ id: "user-b", title: "Keep last", status: "doing", goalId: goal.id },
			{
				id: expect.stringMatching(/^st-/),
				title: "New projected task",
				status: "todo",
				goalId: goal.id,
			},
		]);

		const retry = await service.execute(
			{ scope: "session", action: "reconcile", reconciliation },
			{ source: "protocol" },
		);
		expect(retry).toMatchObject({
			ok: true,
			result: {
				reconciliation: {
					tasks: [
						{ external: { id: "step-a" }, taskId: "managed-a", action: "updated" },
						{ external: { id: "step-b" }, taskId: expect.any(String), action: "created" },
						{ external: { id: "step-stale" }, taskId: "managed-stale", action: "removed" },
					],
				},
			},
			meta: {
				changed: false,
				semanticNoOp: true,
				changedFields: [],
				revisions: { session: first.meta.revisions?.session },
			},
		});
		expect(entries).toHaveLength(1);

		const conflictingReuse = await service.execute(
			{
				scope: "session",
				action: "reconcile",
				reconciliation: {
					...reconciliation,
					tasks: [managedInput("step-a", "Different semantic input", "running")],
				},
			},
			{ source: "protocol" },
		);
		expect(conflictingReuse).toMatchObject({
			ok: false,
			error: {
				code: "CONFLICT",
				retryable: false,
				conflict: { type: "idempotency-key", resolution: "use-new-idempotency-key" },
				details: { idempotencyKey: "run-7:plan-3" },
			},
		});
		expect(entries).toHaveLength(1);

		const noOpReconciliation = {
			...reconciliation,
			expectedSessionRevision: first.meta.revisions?.session,
			idempotencyKey: "run-7:already-reconciled",
		};
		const firstNoOp = await service.execute(
			{ scope: "session", action: "reconcile", reconciliation: noOpReconciliation },
			{ source: "protocol" },
		);
		expect(firstNoOp).toMatchObject({
			ok: true,
			meta: { changed: false, semanticNoOp: true, revisions: first.meta.revisions },
		});
		expect(entries).toHaveLength(2);
		expect(entries[1]).toMatchObject({
			customType: "worklist-session-reconciliation-receipt",
			data: { idempotencyKey: "run-7:already-reconciled", fingerprint: expect.any(String) },
		});

		await service.execute({ scope: "session", action: "add", title: "Later user task" }, { source: "tool" });
		expect(entries).toHaveLength(3);
		const replayedNoOp = await service.execute(
			{ scope: "session", action: "reconcile", reconciliation: noOpReconciliation },
			{ source: "protocol" },
		);
		expect(replayedNoOp).toMatchObject({
			ok: true,
			meta: {
				changed: false,
				semanticNoOp: true,
				revisions: { session: expect.not.stringMatching(/^session-before/) },
			},
		});
		expect(entries).toHaveLength(3);

		const recoveredEntries: unknown[] = [];
		const recoveredStore = new SessionStore({
			appendEntry: (customType: string, data: unknown) => recoveredEntries.push({ customType, data }),
		} as unknown as ExtensionAPI);
		recoveredStore.reconstruct({ sessionManager: { getBranch: () => entries } } as never);
		const recoveredService = new WorklistApplicationService({ projectPath, sessionStore: recoveredStore });
		const recoveredReplay = await recoveredService.execute(
			{ scope: "session", action: "reconcile", reconciliation: noOpReconciliation },
			{ source: "protocol" },
		);
		expect(recoveredReplay).toMatchObject({
			ok: true,
			meta: { changed: false, semanticNoOp: true },
		});
		expect(recoveredEntries).toHaveLength(0);

		const removeFirstProjection = await service.execute(
			{
				scope: "session",
				action: "reconcile",
				reconciliation: {
					idempotencyKey: "run-7:remove-step-a",
					goalId: goal.id,
					expectedGoalUpdatedAt: goal.updatedAt,
					owner: "pi-orchestrator",
					tasks: [managedInput("step-b", "New projected task", "planned")],
				},
			},
			{ source: "protocol" },
		);
		expect(removeFirstProjection).toMatchObject({
			ok: true,
			result: {
				reconciliation: {
					tasks: [
						{ external: { id: "step-b" }, action: "unchanged" },
						{ external: { id: "step-a" }, taskId: "managed-a", action: "removed" },
					],
				},
			},
			meta: { changed: true },
		});
		expect(entries).toHaveLength(4);

		const secondGoalResult = await service.execute(
			{ scope: "project", action: "add", title: "Unrelated goal" },
			{ source: "command" },
		);
		if (!secondGoalResult.ok || !secondGoalResult.result.goal) {
			throw new Error("Expected second goal creation");
		}
		const secondGoal = secondGoalResult.result.goal;
		const crossGoalConflict = await service.execute(
			{
				scope: "session",
				action: "reconcile",
				reconciliation: {
					idempotencyKey: "run-8:cross-goal",
					goalId: secondGoal.id,
					expectedGoalUpdatedAt: secondGoal.updatedAt,
					owner: "pi-orchestrator",
					tasks: [managedInput("step-a", "Must not steal", "planned")],
				},
			},
			{ source: "protocol" },
		);
		expect(crossGoalConflict).toMatchObject({
			ok: false,
			error: {
				code: "CONFLICT",
				retryable: false,
				conflict: {
					type: "user-override",
					conflictingIds: ["managed-a"],
					resolution: "request-user-decision",
				},
				details: {
					externalId: "step-a",
					existingGoalId: goal.id,
					requestedGoalId: secondGoal.id,
				},
			},
		});
		expect(entries).toHaveLength(4);
	});

	it("rejects invalid goal, revision, and duplicate batches before appending a snapshot", async () => {
		vi.useFakeTimers();
		vi.setSystemTime(new Date("2026-07-25T11:00:00.000Z"));
		const projectPath = join(
			await mkdtemp(join(tmpdir(), "pi-worklist-projection-guards-")),
			".pi",
			"worklist.json",
		);
		const entries: unknown[] = [];
		const pi = {
			appendEntry: (customType: string, data: unknown) => entries.push({ customType, data }),
		} as unknown as ExtensionAPI;
		const sessionStore = new SessionStore(pi);
		const service = new WorklistApplicationService({ projectPath, sessionStore });
		const added = await service.execute(
			{ scope: "project", action: "add", title: "Guarded goal" },
			{ source: "command" },
		);
		if (!added.ok || !added.result.goal) throw new Error("Expected goal creation");
		const selectedGoal = added.result.goal;
		await service.execute(
			{ scope: "project", action: "update", id: selectedGoal.id, title: "Edited goal" },
			{ source: "dashboard" },
		);
		const currentGoal = (await service.getProjectGoals()).find((goal) => goal.id === selectedGoal.id);
		if (!currentGoal) throw new Error("Expected current goal");

		const staleGoal = await service.execute(
			{
				scope: "session",
				action: "reconcile",
				reconciliation: {
					idempotencyKey: "stale-goal",
					goalId: selectedGoal.id,
					expectedGoalUpdatedAt: selectedGoal.updatedAt,
					owner: "pi-orchestrator",
					tasks: [managedInput("step-guarded", "Guarded", "planned")],
				},
			},
			{ source: "protocol" },
		);
		expect(staleGoal).toMatchObject({
			ok: false,
			error: {
				code: "CONFLICT",
				conflict: {
					type: "revision",
					expectedRevision: selectedGoal.updatedAt,
					actualRevision: currentGoal.updatedAt,
					resolution: "refresh-and-retry",
				},
			},
		});

		const staleSession = await service.execute(
			{
				scope: "session",
				action: "reconcile",
				reconciliation: {
					expectedSessionRevision: "stale-session",
					idempotencyKey: "stale-session",
					goalId: currentGoal.id,
					expectedGoalUpdatedAt: currentGoal.updatedAt,
					owner: "pi-orchestrator",
					tasks: [managedInput("step-guarded", "Guarded", "planned")],
				},
			},
			{ source: "protocol" },
		);
		expect(staleSession).toMatchObject({
			ok: false,
			error: {
				code: "CONFLICT",
				conflict: {
					type: "revision",
					expectedRevision: "stale-session",
					actualRevision: "0",
				},
			},
			meta: { revisions: { session: "0" } },
		});

		const duplicate = managedInput("step-duplicate", "Duplicate", "planned");
		const duplicateBatch = await service.execute(
			{
				scope: "session",
				action: "reconcile",
				reconciliation: {
					idempotencyKey: "duplicates",
					goalId: currentGoal.id,
					expectedGoalUpdatedAt: currentGoal.updatedAt,
					owner: "pi-orchestrator",
					tasks: [duplicate, duplicate],
				},
			},
			{ source: "protocol" },
		);
		expect(duplicateBatch).toMatchObject({
			ok: false,
			error: {
				code: "VALIDATION_FAILED",
				details: {
					id: "step-duplicate",
					resolution: "deduplicate-external-identities",
				},
			},
		});
		expect(entries).toHaveLength(0);
	});
});
