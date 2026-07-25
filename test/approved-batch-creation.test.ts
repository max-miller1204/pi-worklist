import { EventEmitter } from "node:events";
import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { WorklistApplicationService } from "../src/application-service.ts";
import { approvedGoalBatchContentDigest } from "../src/approved-goal-batches.ts";
import type { WorklistChangeDescription } from "../src/change-events.ts";
import {
	type ApprovedProjectGoalInput,
	CURRENT_WORKLIST_PROTOCOL_VERSION,
	type ExplicitGoalBatchApproval,
	WORKLIST_PROTOCOL_ID,
	type WorklistOperationPayloads,
} from "../src/integration-contract.ts";
import { requestWorklistOperation } from "../src/protocol-consumer.ts";
import { registerWorklistProtocolProvider, type WorklistProtocolEventBus } from "../src/protocol-provider.ts";

function approvedGoal(externalId: string, title: string): ApprovedProjectGoalInput {
	return {
		external: { system: "pi-orchestrator", kind: "phase", id: externalId },
		title,
		description: `Outcome for ${title}`,
		roadmapReference: `pi-orchestrator://roadmaps/roadmap-1/phases/${externalId}`,
	};
}

function approvalFor(goals: ApprovedProjectGoalInput[]): ExplicitGoalBatchApproval {
	return {
		type: "explicit-user-approval",
		approvalId: "approval-9",
		approvedAt: "2026-07-25T12:00:00.000Z",
		approvedBy: { type: "user", id: "local-user" },
		contentDigest: approvedGoalBatchContentDigest(goals),
	};
}

function batchPayload(
	goals: ApprovedProjectGoalInput[],
	overrides: Partial<WorklistOperationPayloads["project-goals.create-approved-batch"]> = {},
): WorklistOperationPayloads["project-goals.create-approved-batch"] {
	return {
		idempotencyKey: "roadmap-1:revision-4",
		approval: approvalFor(goals),
		goals,
		...overrides,
	};
}

async function createFixture() {
	const projectPath = join(
		await mkdtemp(join(tmpdir(), "pi-worklist-approved-batch-")),
		".pi",
		"worklist.json",
	);
	const events: WorklistChangeDescription[] = [];
	const service = new WorklistApplicationService({
		projectPath,
		publishChange: (description) => events.push(description),
	});
	return { events, projectPath, service };
}

describe("approved Project Goal batch creation", () => {
	it("creates the whole batch atomically with stable identity mapping and one revision", async () => {
		const { events, projectPath, service } = await createFixture();
		const goals = [approvedGoal("phase-1", "Phase one"), approvedGoal("phase-2", "Phase two")];

		const created = await service.execute(
			{ scope: "project", action: "create_approved_batch", approvedBatch: batchPayload(goals) },
			{ source: "protocol", actor: { type: "extension", id: "pi-orchestrator" } },
		);
		expect(created).toMatchObject({
			ok: true,
			result: {
				approvedBatch: [
					{
						external: { kind: "phase", id: "phase-1" },
						goal: { title: "Phase one", status: "open", description: "Outcome for Phase one" },
					},
					{
						external: { kind: "phase", id: "phase-2" },
						goal: { title: "Phase two", status: "open" },
					},
				],
			},
			meta: {
				changed: true,
				semanticNoOp: false,
				changedFields: ["/goals"],
				revisions: { project: "1" },
			},
		});
		if (!created.ok || !created.result.approvedBatch) throw new Error("Expected batch result");
		const createdIds = created.result.approvedBatch.map((entry) => entry.goal.id);
		expect(new Set(createdIds).size).toBe(2);
		expect(created.meta.changedEntities?.projectGoalIds).toEqual([...createdIds].sort());

		const file = JSON.parse(await readFile(projectPath, "utf8")) as {
			revision: number;
			goals: Array<{ id: string }>;
			externalMutations: Array<{ idempotencyKey: string; approvalId: string }>;
		};
		expect(file.revision).toBe(1);
		expect(file.goals.map((goal) => goal.id).sort()).toEqual([...createdIds].sort());
		expect(file.externalMutations).toEqual([
			expect.objectContaining({
				idempotencyKey: "roadmap-1:revision-4",
				operation: "project-goals.create-approved-batch",
				approvalId: "approval-9",
			}),
		]);
		expect(events).toEqual([
			expect.objectContaining({
				mutation: "project-goals.created-approved-batch",
				actor: { type: "extension", id: "pi-orchestrator" },
			}),
		]);
	});

	it("replays identical keys before revision checks and without writing", async () => {
		const { events, projectPath, service } = await createFixture();
		const goals = [approvedGoal("phase-1", "Phase one")];
		const payload = batchPayload(goals, { expectedProjectRevision: "0" });
		const created = await service.execute(
			{ scope: "project", action: "create_approved_batch", approvedBatch: payload },
			{ source: "protocol" },
		);
		if (!created.ok || !created.result.approvedBatch) throw new Error("Expected creation");
		const createdId = created.result.approvedBatch[0]?.goal.id;
		const fileAfterCreate = await readFile(projectPath, "utf8");
		events.length = 0;

		// Same key and content with a now-stale expected revision: replay wins.
		const replayed = await service.execute(
			{ scope: "project", action: "create_approved_batch", approvedBatch: payload },
			{ source: "protocol" },
		);
		expect(replayed).toMatchObject({
			ok: true,
			result: { approvedBatch: [{ goal: { id: createdId } }] },
			meta: { changed: false, semanticNoOp: true, revisions: { project: "1" } },
		});
		expect(await readFile(projectPath, "utf8")).toBe(fileAfterCreate);
		expect(events).toHaveLength(0);

		// A different batch under the same key is a typed idempotency conflict.
		const conflictingGoals = [approvedGoal("phase-1", "Different content")];
		const keyConflict = await service.execute(
			{
				scope: "project",
				action: "create_approved_batch",
				approvedBatch: batchPayload(conflictingGoals),
			},
			{ source: "protocol" },
		);
		expect(keyConflict).toMatchObject({
			ok: false,
			error: {
				code: "CONFLICT",
				retryable: false,
				conflict: { type: "idempotency-key", resolution: "use-new-idempotency-key" },
			},
		});
		expect(await readFile(projectPath, "utf8")).toBe(fileAfterCreate);
	});

	it("checks expected revisions for new keys and refuses to recreate user-deleted goals", async () => {
		const { service } = await createFixture();
		const first = await service.execute(
			{
				scope: "project",
				action: "create_approved_batch",
				approvedBatch: batchPayload([approvedGoal("phase-1", "Phase one")]),
			},
			{ source: "protocol" },
		);
		expect(first).toMatchObject({ ok: true, meta: { revisions: { project: "1" } } });

		const staleRevision = await service.execute(
			{
				scope: "project",
				action: "create_approved_batch",
				approvedBatch: batchPayload([approvedGoal("phase-2", "Phase two")], {
					idempotencyKey: "roadmap-1:revision-5",
					expectedProjectRevision: "0",
				}),
			},
			{ source: "protocol" },
		);
		expect(staleRevision).toMatchObject({
			ok: false,
			error: {
				code: "CONFLICT",
				conflict: {
					type: "revision",
					expectedRevision: "0",
					actualRevision: "1",
					resolution: "refresh-and-retry",
				},
			},
		});

		// The user deletes a materialized goal; the original key must not recreate it.
		if (!first.ok || !first.result.approvedBatch) throw new Error("Expected creation");
		const createdId = first.result.approvedBatch[0]?.goal.id;
		await service.execute(
			{ scope: "project", action: "delete", id: createdId, confirm: true },
			{ source: "command" },
		);
		const replayAfterDelete = await service.execute(
			{
				scope: "project",
				action: "create_approved_batch",
				approvedBatch: batchPayload([approvedGoal("phase-1", "Phase one")]),
			},
			{ source: "protocol" },
		);
		expect(replayAfterDelete).toMatchObject({
			ok: false,
			error: {
				code: "CONFLICT",
				retryable: false,
				conflict: {
					type: "user-override",
					conflictingIds: [createdId],
					resolution: "request-user-decision",
				},
			},
		});
		const goals = await service.getProjectGoals();
		expect(goals.some((goal) => goal.id === createdId)).toBe(false);
	});

	it("serves negotiated approved batch creation over the protocol", async () => {
		const { service } = await createFixture();
		const emitter = new EventEmitter();
		const events: WorklistProtocolEventBus = {
			emit: (channel, data) => {
				emitter.emit(channel, data);
			},
			on: (channel, handler) => {
				emitter.on(channel, handler);
				return () => emitter.off(channel, handler);
			},
		};
		registerWorklistProtocolProvider({
			events,
			applicationService: service,
			provider: { id: "pi-worklist", version: "0.4.0", instanceId: "batch-provider" },
		});

		const goals = [approvedGoal("phase-1", "Wire phase")];
		const created = await requestWorklistOperation(
			events,
			{
				protocol: WORKLIST_PROTOCOL_ID,
				protocolVersion: CURRENT_WORKLIST_PROTOCOL_VERSION,
				requestId: "wire-batch-1",
				operation: "project-goals.create-approved-batch",
				actor: { type: "extension", id: "pi-orchestrator" },
				payload: batchPayload(goals),
			},
			{ timeoutMs: 1_000 },
		);
		expect(created).toMatchObject({
			ok: true,
			provider: { instanceId: "batch-provider" },
			result: {
				goals: [{ external: { id: "phase-1" }, goal: { title: "Wire phase", status: "open" } }],
			},
			meta: { changed: true },
		});

		const unauthorized = await requestWorklistOperation(
			events,
			{
				protocol: WORKLIST_PROTOCOL_ID,
				protocolVersion: CURRENT_WORKLIST_PROTOCOL_VERSION,
				requestId: "wire-batch-2",
				operation: "project-goals.create-approved-batch",
				actor: { type: "extension", id: "pi-orchestrator" },
				payload: batchPayload(goals, {
					idempotencyKey: "roadmap-1:revision-6",
					approval: {
						...approvalFor(goals),
						approvedBy: { type: "extension", id: "pi-orchestrator" },
					},
				}),
			},
			{ timeoutMs: 1_000 },
		);
		expect(unauthorized).toMatchObject({
			ok: false,
			error: { code: "APPROVAL_REQUIRED", details: { field: "approval.approvedBy" } },
		});
	});
});
