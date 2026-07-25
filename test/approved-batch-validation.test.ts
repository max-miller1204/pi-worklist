import { describe, expect, it } from "vitest";
import {
	approvedGoalBatchContentDigest,
	approvedGoalBatchFingerprint,
	findApprovedGoalBatchIssue,
} from "../src/approved-goal-batches.ts";
import type {
	ApprovedProjectGoalInput,
	ExplicitGoalBatchApproval,
	WorklistOperationPayloads,
} from "../src/integration-contract.ts";
import { WORKLIST_PROVIDER_LIMITS } from "../src/integration-contract.ts";

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

function validPayload(): WorklistOperationPayloads["project-goals.create-approved-batch"] {
	const goals = [approvedGoal("phase-1", "Phase one"), approvedGoal("phase-2", "Phase two")];
	return {
		expectedProjectRevision: "3",
		idempotencyKey: "roadmap-1:revision-4",
		approval: approvalFor(goals),
		goals,
	};
}

describe("approved goal batch validation", () => {
	it("accepts a fully approved bounded batch", () => {
		expect(findApprovedGoalBatchIssue(validPayload())).toBeUndefined();
	});

	it("computes an order-sensitive canonical content digest", () => {
		const goals = [approvedGoal("phase-1", "Phase one"), approvedGoal("phase-2", "Phase two")];
		const digest = approvedGoalBatchContentDigest(goals);
		expect(digest).toMatch(/^sha256:[0-9a-f]{64}$/);
		expect(approvedGoalBatchContentDigest([...goals])).toBe(digest);
		expect(approvedGoalBatchContentDigest([goals[1], goals[0]])).not.toBe(digest);
		expect(
			approvedGoalBatchContentDigest([goals[0], { ...goals[1], title: "Edited after approval" }]),
		).not.toBe(digest);

		const approval = approvalFor(goals);
		expect(approvedGoalBatchFingerprint(approval, goals)).toBe(
			approvedGoalBatchFingerprint({ ...approval, approvedAt: "2026-07-25T13:00:00.000Z" }, goals),
		);
		expect(approvedGoalBatchFingerprint(approval, goals)).not.toBe(
			approvedGoalBatchFingerprint({ ...approval, approvalId: "approval-10" }, goals),
		);
	});

	it("requires complete explicit user approval evidence", () => {
		const payload = validPayload();
		expect(findApprovedGoalBatchIssue({ ...payload, approval: undefined })).toMatchObject({
			code: "APPROVAL_REQUIRED",
			details: { field: "approval" },
		});
		expect(
			findApprovedGoalBatchIssue({
				...payload,
				approval: { ...payload.approval, type: "implicit" as never },
			}),
		).toMatchObject({ code: "APPROVAL_REQUIRED", details: { field: "approval.type" } });
		expect(
			findApprovedGoalBatchIssue({
				...payload,
				approval: { ...payload.approval, approvedBy: { type: "extension", id: "pi-orchestrator" } },
			}),
		).toMatchObject({ code: "APPROVAL_REQUIRED", details: { field: "approval.approvedBy" } });
		expect(
			findApprovedGoalBatchIssue({
				...payload,
				approval: { ...payload.approval, approvedAt: "yesterday" },
			}),
		).toMatchObject({ code: "APPROVAL_REQUIRED", details: { field: "approval.approvedAt" } });
		expect(
			findApprovedGoalBatchIssue({
				...payload,
				approval: { ...payload.approval, contentDigest: "sha256:not-hex" },
			}),
		).toMatchObject({ code: "APPROVAL_REQUIRED", details: { field: "approval.contentDigest" } });
	});

	it("rejects approval evidence produced for different content", () => {
		const payload = validPayload();
		const tampered = {
			...payload,
			goals: [payload.goals[0], { ...payload.goals[1], title: "Silently rewritten" }],
		};
		expect(findApprovedGoalBatchIssue(tampered)).toMatchObject({
			code: "APPROVAL_REQUIRED",
			message: expect.stringContaining("does not match the exact batch content"),
			details: { field: "approval.contentDigest" },
		});
	});

	it("bounds batch size, titles, descriptions, and roadmap references", () => {
		const payload = validPayload();
		const oversizedBatchGoals = Array.from({ length: WORKLIST_PROVIDER_LIMITS.maxBatchItems + 1 }, (_, i) =>
			approvedGoal(`phase-${i}`, `Phase ${i}`),
		);
		expect(
			findApprovedGoalBatchIssue({
				...payload,
				approval: approvalFor(oversizedBatchGoals),
				goals: oversizedBatchGoals,
			}),
		).toMatchObject({
			code: "VALIDATION_FAILED",
			details: { maxBatchItems: WORKLIST_PROVIDER_LIMITS.maxBatchItems },
		});

		const longTitleGoals = [
			{ ...approvedGoal("phase-1", "x".repeat(WORKLIST_PROVIDER_LIMITS.maxTitleBytes + 1)) },
		];
		expect(
			findApprovedGoalBatchIssue({
				...payload,
				approval: approvalFor(longTitleGoals),
				goals: longTitleGoals,
			}),
		).toMatchObject({ code: "VALIDATION_FAILED", details: { field: "goals[0].title" } });

		const longReferenceGoals = [
			{
				...approvedGoal("phase-1", "Phase one"),
				roadmapReference: "x".repeat(WORKLIST_PROVIDER_LIMITS.maxReferenceBytes + 1),
			},
		];
		expect(
			findApprovedGoalBatchIssue({
				...payload,
				approval: approvalFor(longReferenceGoals),
				goals: longReferenceGoals,
			}),
		).toMatchObject({ code: "VALIDATION_FAILED", details: { field: "goals[0].roadmapReference" } });

		expect(findApprovedGoalBatchIssue({ ...payload, goals: [] })).toMatchObject({
			code: "VALIDATION_FAILED",
			details: { field: "goals" },
		});
		expect(findApprovedGoalBatchIssue({ ...payload, idempotencyKey: " " })).toMatchObject({
			code: "VALIDATION_FAILED",
			details: { field: "idempotencyKey" },
		});
	});

	it("rejects unsupported external identities and duplicates", () => {
		const payload = validPayload();
		const workflowStepGoals = [
			{
				...approvedGoal("phase-1", "Phase one"),
				external: { system: "pi-orchestrator", kind: "workflow-step", id: "step-1" } as never,
			},
		];
		expect(
			findApprovedGoalBatchIssue({
				...payload,
				approval: approvalFor(workflowStepGoals),
				goals: workflowStepGoals,
			}),
		).toMatchObject({
			code: "VALIDATION_FAILED",
			details: { supportedKinds: ["phase", "project-goal"] },
		});

		const duplicateGoals = [approvedGoal("phase-1", "Phase one"), approvedGoal("phase-1", "Phase clone")];
		expect(
			findApprovedGoalBatchIssue({
				...payload,
				approval: approvalFor(duplicateGoals),
				goals: duplicateGoals,
			}),
		).toMatchObject({
			code: "VALIDATION_FAILED",
			details: { resolution: "deduplicate-external-identities" },
		});
	});
});
