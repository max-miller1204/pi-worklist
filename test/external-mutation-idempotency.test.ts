import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { describe, expect, it } from "vitest";
import { WorklistApplicationService } from "../src/application-service.ts";
import { approvedGoalBatchContentDigest } from "../src/approved-goal-batches.ts";
import type { WorklistChangeDescription } from "../src/change-events.ts";
import type {
	ApprovedProjectGoalInput,
	ManagedExecutionUpdate,
	ManagedSessionTaskInput,
} from "../src/integration-contract.ts";
import { SessionStore } from "../src/session-store.ts";

/**
 * Cross-cutting verification of the external mutation rules:
 * an identical idempotency-key replay wins before expected-revision validation,
 * a new mutation checks its expected revision before semantic no-op detection,
 * conflicting key reuse returns a typed conflict, and semantic no-ops never
 * rewrite canonical state, advance revisions, append snapshots, or emit events.
 */

interface Fixture {
	entries: Array<{ customType: string; data: unknown }>;
	events: WorklistChangeDescription[];
	projectPath: string;
	service: WorklistApplicationService;
	goal: { id: string; updatedAt: string };
	sessionRevision: string;
	snapshotCount: () => number;
}

function managedInput(externalId: string, title: string): ManagedSessionTaskInput {
	return {
		external: { system: "pi-orchestrator", kind: "workflow-step", id: externalId },
		title,
		status: "todo",
		producer: { id: "pi-orchestrator", version: "0.9.0" },
		planRevision: 1,
		approvedPlanRevision: 1,
		execution: { state: "planned", updatedAt: "2026-07-25T12:00:00.000Z", runId: "run-17" },
	};
}

function executionUpdate(
	externalId: string,
	state: ManagedExecutionUpdate["execution"]["state"],
	updatedAt: string,
): ManagedExecutionUpdate {
	return {
		external: { system: "pi-orchestrator", kind: "workflow-step", id: externalId },
		execution: { state, updatedAt, runId: "run-17" },
	};
}

function approvedGoal(externalId: string, title: string): ApprovedProjectGoalInput {
	return { external: { system: "pi-orchestrator", kind: "phase", id: externalId }, title };
}

function approvedBatch(idempotencyKey: string, goals: ApprovedProjectGoalInput[], revision?: string) {
	return {
		idempotencyKey,
		...(revision !== undefined ? { expectedProjectRevision: revision } : {}),
		approval: {
			type: "explicit-user-approval" as const,
			approvalId: "approval-17",
			approvedAt: "2026-07-25T12:00:00.000Z",
			approvedBy: { type: "user" as const, id: "local-user" },
			contentDigest: approvedGoalBatchContentDigest(goals),
		},
		goals,
	};
}

async function createFixture(): Promise<Fixture> {
	const projectPath = join(
		await mkdtemp(join(tmpdir(), "pi-worklist-idempotency-matrix-")),
		".pi",
		"worklist.json",
	);
	const entries: Array<{ customType: string; data: unknown }> = [];
	const pi = {
		appendEntry: (customType: string, data: unknown) => entries.push({ customType, data }),
	} as unknown as ExtensionAPI;
	const sessionStore = new SessionStore(pi);
	const events: WorklistChangeDescription[] = [];
	const service = new WorklistApplicationService({
		projectPath,
		sessionStore,
		publishChange: (description) => events.push(description),
	});
	const added = await service.execute(
		{ scope: "project", action: "add", title: "Idempotency goal" },
		{ source: "command" },
	);
	if (!added.ok || !added.result.goal) throw new Error("Expected goal");
	const goal = added.result.goal;
	const reconciled = await service.execute(
		{
			scope: "session",
			action: "reconcile",
			reconciliation: {
				idempotencyKey: "run-17:seed",
				goalId: goal.id,
				expectedGoalUpdatedAt: goal.updatedAt,
				owner: "pi-orchestrator",
				tasks: [managedInput("step-a", "Seeded step")],
			},
		},
		{ source: "protocol" },
	);
	if (!reconciled.ok || !reconciled.meta.revisions?.session) throw new Error("Expected reconciliation");
	events.length = 0;
	return {
		entries,
		events,
		projectPath,
		service,
		goal,
		sessionRevision: reconciled.meta.revisions.session,
		snapshotCount: () => entries.filter((entry) => entry.customType === "worklist-session-snapshot").length,
	};
}

describe("external mutation idempotency matrix", () => {
	it("replays reconciliation keys before revision checks and keeps no-ops writeless", async () => {
		const fixture = await createFixture();
		const { service, goal } = fixture;
		const snapshotsBefore = fixture.snapshotCount();

		// Identical replay with a stale session revision: replay wins, nothing written.
		const replayed = await service.execute(
			{
				scope: "session",
				action: "reconcile",
				reconciliation: {
					expectedSessionRevision: "stale-session-revision",
					idempotencyKey: "run-17:seed",
					goalId: goal.id,
					expectedGoalUpdatedAt: goal.updatedAt,
					owner: "pi-orchestrator",
					tasks: [managedInput("step-a", "Seeded step")],
				},
			},
			{ source: "protocol" },
		);
		expect(replayed).toMatchObject({
			ok: true,
			meta: { changed: false, semanticNoOp: true, revisions: { session: fixture.sessionRevision } },
		});

		// New key with a stale revision conflicts even though the state already matches.
		const staleNoOp = await service.execute(
			{
				scope: "session",
				action: "reconcile",
				reconciliation: {
					expectedSessionRevision: "stale-session-revision",
					idempotencyKey: "run-17:new-key",
					goalId: goal.id,
					expectedGoalUpdatedAt: goal.updatedAt,
					owner: "pi-orchestrator",
					tasks: [managedInput("step-a", "Seeded step")],
				},
			},
			{ source: "protocol" },
		);
		expect(staleNoOp).toMatchObject({
			ok: false,
			error: { code: "CONFLICT", conflict: { type: "revision", resolution: "refresh-and-retry" } },
		});

		// Correct revision and matching state: a semantic no-op with no snapshot and no event.
		const noOp = await service.execute(
			{
				scope: "session",
				action: "reconcile",
				reconciliation: {
					expectedSessionRevision: fixture.sessionRevision,
					idempotencyKey: "run-17:no-op",
					goalId: goal.id,
					expectedGoalUpdatedAt: goal.updatedAt,
					owner: "pi-orchestrator",
					tasks: [managedInput("step-a", "Seeded step")],
				},
			},
			{ source: "protocol" },
		);
		expect(noOp).toMatchObject({
			ok: true,
			meta: { changed: false, semanticNoOp: true, revisions: { session: fixture.sessionRevision } },
		});
		expect(fixture.snapshotCount()).toBe(snapshotsBefore);
		expect(fixture.events).toHaveLength(0);
	});

	it("applies the same matrix to execution status updates, sharing one key namespace", async () => {
		const fixture = await createFixture();
		const { service } = fixture;
		const update = executionUpdate("step-a", "running", "2026-07-25T12:10:00.000Z");

		const first = await service.execute(
			{
				scope: "session",
				action: "update_execution",
				executionUpdate: {
					expectedSessionRevision: fixture.sessionRevision,
					idempotencyKey: "run-17:execution",
					owner: "pi-orchestrator",
					updates: [update],
				},
			},
			{ source: "protocol" },
		);
		expect(first).toMatchObject({ ok: true, meta: { changed: true } });
		const revisionAfterUpdate = first.meta.revisions?.session;
		const snapshotsAfterUpdate = fixture.snapshotCount();
		fixture.events.length = 0;

		// Identical replay with stale revision: original result, no write, no event.
		const replayed = await service.execute(
			{
				scope: "session",
				action: "update_execution",
				executionUpdate: {
					expectedSessionRevision: "stale-session-revision",
					idempotencyKey: "run-17:execution",
					owner: "pi-orchestrator",
					updates: [update],
				},
			},
			{ source: "protocol" },
		);
		expect(replayed).toMatchObject({
			ok: true,
			result: first.ok ? { reconciliation: first.result.reconciliation } : undefined,
			meta: { changed: false, semanticNoOp: true, revisions: { session: revisionAfterUpdate } },
		});

		// The same key with different semantic input is a typed conflict.
		const keyReuse = await service.execute(
			{
				scope: "session",
				action: "update_execution",
				executionUpdate: {
					idempotencyKey: "run-17:execution",
					owner: "pi-orchestrator",
					updates: [executionUpdate("step-a", "failed", "2026-07-25T12:15:00.000Z")],
				},
			},
			{ source: "protocol" },
		);
		expect(keyReuse).toMatchObject({
			ok: false,
			error: { code: "CONFLICT", conflict: { type: "idempotency-key" } },
		});

		// Session mutation keys share one namespace across operations.
		const crossOperationReuse = await service.execute(
			{
				scope: "session",
				action: "update_execution",
				executionUpdate: {
					idempotencyKey: "run-17:seed",
					owner: "pi-orchestrator",
					updates: [update],
				},
			},
			{ source: "protocol" },
		);
		expect(crossOperationReuse).toMatchObject({
			ok: false,
			error: { code: "CONFLICT", conflict: { type: "idempotency-key" } },
		});

		// Revision check precedes no-op detection for new keys.
		const staleNoOp = await service.execute(
			{
				scope: "session",
				action: "update_execution",
				executionUpdate: {
					expectedSessionRevision: "stale-session-revision",
					idempotencyKey: "run-17:execution-2",
					owner: "pi-orchestrator",
					updates: [update],
				},
			},
			{ source: "protocol" },
		);
		expect(staleNoOp).toMatchObject({
			ok: false,
			error: { code: "CONFLICT", conflict: { type: "revision" } },
		});

		const noOp = await service.execute(
			{
				scope: "session",
				action: "update_execution",
				executionUpdate: {
					expectedSessionRevision: revisionAfterUpdate,
					idempotencyKey: "run-17:execution-3",
					owner: "pi-orchestrator",
					updates: [update],
				},
			},
			{ source: "protocol" },
		);
		expect(noOp).toMatchObject({
			ok: true,
			meta: { changed: false, semanticNoOp: true, revisions: { session: revisionAfterUpdate } },
		});
		expect(fixture.snapshotCount()).toBe(snapshotsAfterUpdate);
		expect(fixture.events).toHaveLength(0);
	});

	it("applies the same matrix to approved goal batches against the canonical project file", async () => {
		const fixture = await createFixture();
		const { projectPath, service } = fixture;
		const goals = [approvedGoal("phase-1", "Materialized phase")];

		const projectRevisionBefore = (
			await service.execute({ scope: "project", action: "list" }, { source: "protocol" })
		).meta.revisions?.project;
		if (!projectRevisionBefore) throw new Error("Expected project revision");

		const created = await service.execute(
			{
				scope: "project",
				action: "create_approved_batch",
				approvedBatch: approvedBatch("roadmap-17:batch", goals, projectRevisionBefore),
			},
			{ source: "protocol" },
		);
		expect(created).toMatchObject({ ok: true, meta: { changed: true } });
		const fileAfterCreate = await readFile(projectPath, "utf8");
		fixture.events.length = 0;

		// Identical replay with a stale expected revision still wins.
		const replayed = await service.execute(
			{
				scope: "project",
				action: "create_approved_batch",
				approvedBatch: approvedBatch("roadmap-17:batch", goals, "0"),
			},
			{ source: "protocol" },
		);
		expect(replayed).toMatchObject({ ok: true, meta: { changed: false, semanticNoOp: true } });

		// New key, stale revision: conflict before any creation.
		const staleRevision = await service.execute(
			{
				scope: "project",
				action: "create_approved_batch",
				approvedBatch: approvedBatch("roadmap-17:batch-2", goals, projectRevisionBefore),
			},
			{ source: "protocol" },
		);
		expect(staleRevision).toMatchObject({
			ok: false,
			error: { code: "CONFLICT", conflict: { type: "revision" } },
		});

		// Same key, different content: typed idempotency conflict.
		const keyReuse = await service.execute(
			{
				scope: "project",
				action: "create_approved_batch",
				approvedBatch: approvedBatch("roadmap-17:batch", [approvedGoal("phase-2", "Other phase")]),
			},
			{ source: "protocol" },
		);
		expect(keyReuse).toMatchObject({
			ok: false,
			error: { code: "CONFLICT", conflict: { type: "idempotency-key" } },
		});

		expect(await readFile(projectPath, "utf8")).toBe(fileAfterCreate);
		expect(fixture.events).toHaveLength(0);
	});
});
