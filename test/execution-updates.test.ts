import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { afterEach, describe, expect, it, vi } from "vitest";
import { WorklistApplicationService } from "../src/application-service.ts";
import type { ManagedExecutionUpdate, ManagedSessionTaskInput } from "../src/integration-contract.ts";
import { MAX_MANAGED_EXECUTION_SUMMARY_BYTES } from "../src/managed-projection.ts";
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
			updatedAt: "2026-07-25T10:00:00.000Z",
			runId: "run-9",
			runReference: "pi-orchestrator://runs/run-9",
		},
	};
}

function executionUpdate(
	externalId: string,
	state: ManagedExecutionUpdate["execution"]["state"],
	options: { summary?: string; updatedAt?: string } = {},
): ManagedExecutionUpdate {
	return {
		external: { system: "pi-orchestrator", kind: "workflow-step", id: externalId },
		execution: {
			state,
			updatedAt: options.updatedAt ?? "2026-07-25T10:10:00.000Z",
			runId: "run-9",
			runReference: "pi-orchestrator://runs/run-9",
			...(options.summary !== undefined ? { summary: options.summary } : {}),
		},
	};
}

/** Matches the execution projection stored by the fixture reconciliation exactly. */
function identicalExecutionUpdate(
	externalId: string,
	state: ManagedExecutionUpdate["execution"]["state"],
): ManagedExecutionUpdate {
	return executionUpdate(externalId, state, { updatedAt: "2026-07-25T10:00:00.000Z" });
}

async function createReconciledFixture() {
	vi.useFakeTimers();
	vi.setSystemTime(new Date("2026-07-25T10:00:00.000Z"));
	const projectPath = join(
		await mkdtemp(join(tmpdir(), "pi-worklist-execution-updates-")),
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
		{ scope: "project", action: "add", title: "Execute the run" },
		{ source: "command" },
	);
	if (!addedGoal.ok || !addedGoal.result.goal) throw new Error("Expected goal creation");
	const goal = addedGoal.result.goal;

	await service.execute({ scope: "session", action: "add", title: "User task first" }, { source: "tool" });
	const reconciled = await service.execute(
		{
			scope: "session",
			action: "reconcile",
			reconciliation: {
				idempotencyKey: "run-9:plan-3",
				goalId: goal.id,
				expectedGoalUpdatedAt: goal.updatedAt,
				owner: "pi-orchestrator",
				tasks: [
					managedInput("step-a", "Implement change", "running"),
					managedInput("step-b", "Validate change", "planned"),
				],
			},
		},
		{ source: "protocol" },
	);
	if (!reconciled.ok) throw new Error("Expected reconciliation");
	const sessionRevision = reconciled.meta.revisions?.session;
	if (!sessionRevision) throw new Error("Expected session revision");
	return { entries, goal, projectPath, service, sessionStore, sessionRevision };
}

afterEach(() => {
	vi.useRealTimers();
});

describe("idempotent external Session Task execution updates", () => {
	it("updates projected execution state by stable external identity in one snapshot", async () => {
		const { entries, service, sessionStore, sessionRevision } = await createReconciledFixture();
		const snapshotsBefore = entries.length;

		vi.setSystemTime(new Date("2026-07-25T10:10:00.000Z"));
		const succeeded = executionUpdate("step-a", "succeeded", { summary: "Focused validation passed" });
		(succeeded.execution as ManagedExecutionUpdate["execution"] & { attempt: number }).attempt = 2;
		const payload = {
			expectedSessionRevision: sessionRevision,
			idempotencyKey: "run-9:execution-1",
			owner: "pi-orchestrator" as const,
			updates: [succeeded, identicalExecutionUpdate("step-b", "planned")],
		};
		const first = await service.execute(
			{ scope: "session", action: "update_execution", executionUpdate: payload },
			{ source: "protocol" },
		);

		expect(first).toMatchObject({
			ok: true,
			scope: "session",
			action: "update_execution",
			result: {
				reconciliation: {
					tasks: [
						{ external: { id: "step-a" }, taskId: expect.any(String), action: "updated" },
						{ external: { id: "step-b" }, taskId: expect.any(String), action: "unchanged" },
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
		expect(first.meta.revisions?.session).not.toBe(sessionRevision);
		expect(entries).toHaveLength(snapshotsBefore + 1);
		const snapshot = entries.at(-1);
		expect(snapshot).toMatchObject({ customType: "worklist-session-snapshot" });
		const snapshotText = JSON.stringify(snapshot);
		expect(snapshotText).toContain('"state":"succeeded"');
		expect(snapshotText).toContain("Focused validation passed");
		expect(snapshotText).not.toContain("attempt");

		// The user-facing lifecycle is owned by reconciliation, not execution updates.
		expect(sessionStore.getTasks().map(({ title, status }) => ({ title, status }))).toEqual([
			{ title: "User task first", status: "todo" },
			{ title: "Implement change", status: "doing" },
			{ title: "Validate change", status: "todo" },
		]);
	});

	it("replays identical idempotency keys before expected-revision validation", async () => {
		const { entries, service, sessionRevision } = await createReconciledFixture();
		const payload = {
			expectedSessionRevision: sessionRevision,
			idempotencyKey: "run-9:execution-1",
			owner: "pi-orchestrator" as const,
			updates: [executionUpdate("step-a", "succeeded")],
		};
		const first = await service.execute(
			{ scope: "session", action: "update_execution", executionUpdate: payload },
			{ source: "protocol" },
		);
		expect(first).toMatchObject({ ok: true, meta: { changed: true } });
		const snapshotCount = entries.length;

		const replayed = await service.execute(
			{
				scope: "session",
				action: "update_execution",
				executionUpdate: { ...payload, expectedSessionRevision: "stale-session-revision" },
			},
			{ source: "protocol" },
		);
		expect(replayed).toMatchObject({
			ok: true,
			result: first.ok ? { reconciliation: first.result.reconciliation } : undefined,
			meta: {
				changed: false,
				semanticNoOp: true,
				changedFields: [],
				revisions: first.meta.revisions,
			},
		});
		expect(entries).toHaveLength(snapshotCount);

		const conflictingReuse = await service.execute(
			{
				scope: "session",
				action: "update_execution",
				executionUpdate: { ...payload, updates: [executionUpdate("step-a", "failed")] },
			},
			{ source: "protocol" },
		);
		expect(conflictingReuse).toMatchObject({
			ok: false,
			error: {
				code: "CONFLICT",
				retryable: false,
				conflict: { type: "idempotency-key", resolution: "use-new-idempotency-key" },
				details: { idempotencyKey: "run-9:execution-1" },
			},
		});
		expect(entries).toHaveLength(snapshotCount);
	});

	it("checks expected revisions before semantic no-op detection and never rewrites state for no-ops", async () => {
		const { entries, service, sessionRevision } = await createReconciledFixture();
		const snapshotCount = entries.length;

		const staleMatchingState = await service.execute(
			{
				scope: "session",
				action: "update_execution",
				executionUpdate: {
					expectedSessionRevision: "stale-session-revision",
					idempotencyKey: "run-9:execution-stale",
					owner: "pi-orchestrator",
					updates: [identicalExecutionUpdate("step-b", "planned")],
				},
			},
			{ source: "protocol" },
		);
		expect(staleMatchingState).toMatchObject({
			ok: false,
			error: {
				code: "CONFLICT",
				retryable: true,
				conflict: {
					type: "revision",
					expectedRevision: "stale-session-revision",
					actualRevision: sessionRevision,
					resolution: "refresh-and-retry",
				},
			},
			meta: { revisions: { session: sessionRevision } },
		});
		expect(entries).toHaveLength(snapshotCount);

		const noOp = await service.execute(
			{
				scope: "session",
				action: "update_execution",
				executionUpdate: {
					expectedSessionRevision: sessionRevision,
					idempotencyKey: "run-9:execution-no-op",
					owner: "pi-orchestrator",
					updates: [identicalExecutionUpdate("step-b", "planned")],
				},
			},
			{ source: "protocol" },
		);
		expect(noOp).toMatchObject({
			ok: true,
			result: {
				reconciliation: {
					tasks: [{ external: { id: "step-b" }, action: "unchanged" }],
				},
			},
			meta: {
				changed: false,
				semanticNoOp: true,
				changedFields: [],
				revisions: { session: sessionRevision },
			},
		});
		expect(entries).toHaveLength(snapshotCount + 1);
		expect(entries.at(-1)).toMatchObject({
			customType: "worklist-session-reconciliation-receipt",
			data: { idempotencyKey: "run-9:execution-no-op", operation: "session-tasks.update-execution" },
		});
	});

	it("survives session reconstruction so recovery replays instead of duplicating updates", async () => {
		const { entries, projectPath, service, sessionRevision } = await createReconciledFixture();
		const payload = {
			expectedSessionRevision: sessionRevision,
			idempotencyKey: "run-9:execution-1",
			owner: "pi-orchestrator" as const,
			updates: [executionUpdate("step-a", "succeeded")],
		};
		const first = await service.execute(
			{ scope: "session", action: "update_execution", executionUpdate: payload },
			{ source: "protocol" },
		);
		expect(first).toMatchObject({ ok: true });

		const recoveredEntries: unknown[] = [];
		const recoveredStore = new SessionStore({
			appendEntry: (customType: string, data: unknown) => recoveredEntries.push({ customType, data }),
		} as unknown as ExtensionAPI);
		recoveredStore.reconstruct({ sessionManager: { getBranch: () => entries } } as never);
		const recoveredService = new WorklistApplicationService({ projectPath, sessionStore: recoveredStore });
		const replayed = await recoveredService.execute(
			{ scope: "session", action: "update_execution", executionUpdate: payload },
			{ source: "protocol" },
		);
		expect(replayed).toMatchObject({
			ok: true,
			result: first.ok ? { reconciliation: first.result.reconciliation } : undefined,
			meta: { changed: false, semanticNoOp: true },
		});
		expect(recoveredEntries).toHaveLength(0);
	});

	it("rejects unknown identities, closed goals, and unbounded payloads without writing", async () => {
		const { entries, goal, service } = await createReconciledFixture();
		const snapshotCount = entries.length;

		const unknownIdentity = await service.execute(
			{
				scope: "session",
				action: "update_execution",
				executionUpdate: {
					idempotencyKey: "run-9:unknown-step",
					owner: "pi-orchestrator",
					updates: [executionUpdate("step-missing", "running")],
				},
			},
			{ source: "protocol" },
		);
		expect(unknownIdentity).toMatchObject({
			ok: false,
			error: {
				code: "NOT_FOUND",
				retryable: false,
				details: {
					entity: "managed-session-task",
					externalId: "step-missing",
					resolution: "reconcile-managed-projections-first",
				},
			},
		});

		const oversizedSummary = await service.execute(
			{
				scope: "session",
				action: "update_execution",
				executionUpdate: {
					idempotencyKey: "run-9:oversized",
					owner: "pi-orchestrator",
					updates: [
						executionUpdate("step-a", "running", {
							summary: "x".repeat(MAX_MANAGED_EXECUTION_SUMMARY_BYTES + 1),
						}),
					],
				},
			},
			{ source: "protocol" },
		);
		expect(oversizedSummary).toMatchObject({
			ok: false,
			error: { code: "VALIDATION_FAILED", details: { field: "updates[0].execution" } },
		});

		const duplicateIdentity = await service.execute(
			{
				scope: "session",
				action: "update_execution",
				executionUpdate: {
					idempotencyKey: "run-9:duplicates",
					owner: "pi-orchestrator",
					updates: [executionUpdate("step-a", "running"), executionUpdate("step-a", "failed")],
				},
			},
			{ source: "protocol" },
		);
		expect(duplicateIdentity).toMatchObject({
			ok: false,
			error: { code: "VALIDATION_FAILED", details: { resolution: "deduplicate-external-identities" } },
		});

		await service.execute(
			{ scope: "project", action: "archive", id: goal.id, confirm: true },
			{ source: "command" },
		);
		const closedGoal = await service.execute(
			{
				scope: "session",
				action: "update_execution",
				executionUpdate: {
					idempotencyKey: "run-9:closed-goal",
					owner: "pi-orchestrator",
					updates: [executionUpdate("step-a", "running")],
				},
			},
			{ source: "protocol" },
		);
		expect(closedGoal).toMatchObject({
			ok: false,
			error: { code: "VALIDATION_FAILED", details: { id: goal.id, resolution: "reopen-project-goal" } },
		});

		await service.execute(
			{ scope: "project", action: "delete", id: goal.id, confirm: true },
			{ source: "command" },
		);
		const missingGoal = await service.execute(
			{
				scope: "session",
				action: "update_execution",
				executionUpdate: {
					idempotencyKey: "run-9:missing-goal",
					owner: "pi-orchestrator",
					updates: [executionUpdate("step-a", "running")],
				},
			},
			{ source: "protocol" },
		);
		expect(missingGoal).toMatchObject({
			ok: false,
			error: { code: "NOT_FOUND", details: { entity: "project-goal", id: goal.id } },
		});
		expect(entries).toHaveLength(snapshotCount);
	});
});
