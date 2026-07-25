import { createHash } from "node:crypto";
import type {
	ApprovedProjectGoalInput,
	ExplicitGoalBatchApproval,
	WorklistOperationPayloads,
} from "./integration-contract.ts";
import { WORKLIST_PROVIDER_LIMITS } from "./integration-contract.ts";
import type { ExternalWorkItemIdentity } from "./managed-projection.ts";
import { MAX_MANAGED_IDENTITY_BYTES } from "./managed-projection.ts";

/**
 * Validation for explicitly approved Project Goal batches.
 *
 * Approval evidence must reference the exact content being created: the provider
 * recomputes the canonical content digest and refuses batches whose evidence was
 * produced for different goals. Actor metadata never substitutes for approval.
 */

/** External identities allowed to materialize Project Goals. */
const APPROVED_GOAL_EXTERNAL_KINDS = new Set<ExternalWorkItemIdentity["kind"]>(["phase", "project-goal"]);

const CONTENT_DIGEST_PATTERN = /^sha256:[0-9a-f]{64}$/;

function canonicalApprovedGoal(goal: ApprovedProjectGoalInput) {
	return {
		external: {
			system: goal.external.system,
			kind: goal.external.kind,
			id: goal.external.id,
		},
		title: goal.title,
		...(goal.description !== undefined ? { description: goal.description } : {}),
		...(goal.roadmapReference !== undefined ? { roadmapReference: goal.roadmapReference } : {}),
	};
}

/** The canonical digest of the exact approved batch content, order-sensitive. */
export function approvedGoalBatchContentDigest(goals: ApprovedProjectGoalInput[]): string {
	const canonical = { goals: goals.map(canonicalApprovedGoal) };
	return `sha256:${createHash("sha256").update(JSON.stringify(canonical)).digest("hex")}`;
}

/** Semantic fingerprint used for idempotency-key replay detection. */
export function approvedGoalBatchFingerprint(
	approval: ExplicitGoalBatchApproval,
	goals: ApprovedProjectGoalInput[],
): string {
	const semanticInput = {
		operation: "project-goals.create-approved-batch",
		approval: { approvalId: approval.approvalId, contentDigest: approval.contentDigest },
		goals: goals.map(canonicalApprovedGoal),
	};
	return createHash("sha256").update(JSON.stringify(semanticInput)).digest("hex");
}

export interface ApprovedBatchIssue {
	code: "APPROVAL_REQUIRED" | "VALIDATION_FAILED";
	message: string;
	details: Record<string, unknown>;
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isBoundedString(value: unknown, maxBytes: number): value is string {
	return typeof value === "string" && value.trim().length > 0 && Buffer.byteLength(value, "utf8") <= maxBytes;
}

const ISO_UTC_TIMESTAMP = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{3})?Z$/;

function approvalIssue(message: string, details: Record<string, unknown>): ApprovedBatchIssue {
	return { code: "APPROVAL_REQUIRED", message, details };
}

function validationIssue(message: string, details: Record<string, unknown>): ApprovedBatchIssue {
	return { code: "VALIDATION_FAILED", message, details };
}

function validateApproval(value: unknown): ApprovedBatchIssue | undefined {
	if (!isRecord(value)) {
		return approvalIssue("Approved batch creation requires explicit approval evidence.", {
			field: "approval",
			resolution: "request-explicit-user-approval",
		});
	}
	const approval = value as Partial<ExplicitGoalBatchApproval>;
	if (approval.type !== "explicit-user-approval") {
		return approvalIssue("Approval evidence must have type explicit-user-approval.", {
			field: "approval.type",
			resolution: "request-explicit-user-approval",
		});
	}
	if (!isBoundedString(approval.approvalId, MAX_MANAGED_IDENTITY_BYTES)) {
		return approvalIssue("Approval evidence requires a bounded approvalId.", {
			field: "approval.approvalId",
			resolution: "request-explicit-user-approval",
		});
	}
	if (typeof approval.approvedAt !== "string" || !ISO_UTC_TIMESTAMP.test(approval.approvedAt)) {
		return approvalIssue("Approval evidence requires an ISO UTC approvedAt timestamp.", {
			field: "approval.approvedAt",
			resolution: "request-explicit-user-approval",
		});
	}
	const approvedBy = approval.approvedBy;
	if (!isRecord(approvedBy) || approvedBy.type !== "user" || !isBoundedString(approvedBy.id, 256)) {
		return approvalIssue("Approval evidence must be granted by a user actor.", {
			field: "approval.approvedBy",
			resolution: "request-explicit-user-approval",
		});
	}
	if (typeof approval.contentDigest !== "string" || !CONTENT_DIGEST_PATTERN.test(approval.contentDigest)) {
		return approvalIssue("Approval evidence requires a sha256 content digest.", {
			field: "approval.contentDigest",
			expectedFormat: "sha256:<64 hex characters>",
			resolution: "request-explicit-user-approval",
		});
	}
	return undefined;
}

function validateApprovedGoal(value: unknown, index: number): ApprovedBatchIssue | undefined {
	if (!isRecord(value)) {
		return validationIssue(`Approved goal ${index} must be an object.`, {
			field: `goals[${index}]`,
			resolution: "provide-valid-approved-goal",
		});
	}
	const goal = value as Partial<ApprovedProjectGoalInput>;
	const external = goal.external;
	if (
		!isRecord(external) ||
		external.system !== "pi-orchestrator" ||
		!APPROVED_GOAL_EXTERNAL_KINDS.has(external.kind as ExternalWorkItemIdentity["kind"]) ||
		!isBoundedString(external.id, MAX_MANAGED_IDENTITY_BYTES)
	) {
		return validationIssue(
			`Approved goal ${index} requires a bounded pi-orchestrator phase or project-goal identity.`,
			{
				field: `goals[${index}].external`,
				supportedKinds: ["phase", "project-goal"],
				resolution: "provide-valid-external-identity",
			},
		);
	}
	if (!isBoundedString(goal.title, WORKLIST_PROVIDER_LIMITS.maxTitleBytes)) {
		return validationIssue(
			`Approved goal ${index} requires a non-blank title within ${WORKLIST_PROVIDER_LIMITS.maxTitleBytes} bytes.`,
			{
				field: `goals[${index}].title`,
				maxTitleBytes: WORKLIST_PROVIDER_LIMITS.maxTitleBytes,
				resolution: "provide-title",
			},
		);
	}
	if (
		goal.description !== undefined &&
		!isBoundedString(goal.description, WORKLIST_PROVIDER_LIMITS.maxDescriptionBytes)
	) {
		return validationIssue(
			`Approved goal ${index} description exceeds ${WORKLIST_PROVIDER_LIMITS.maxDescriptionBytes} bytes.`,
			{
				field: `goals[${index}].description`,
				maxDescriptionBytes: WORKLIST_PROVIDER_LIMITS.maxDescriptionBytes,
				resolution: "shorten-description",
			},
		);
	}
	if (
		goal.roadmapReference !== undefined &&
		!isBoundedString(goal.roadmapReference, WORKLIST_PROVIDER_LIMITS.maxReferenceBytes)
	) {
		return validationIssue(
			`Approved goal ${index} roadmap reference exceeds ${WORKLIST_PROVIDER_LIMITS.maxReferenceBytes} bytes.`,
			{
				field: `goals[${index}].roadmapReference`,
				maxReferenceBytes: WORKLIST_PROVIDER_LIMITS.maxReferenceBytes,
				resolution: "shorten-roadmap-reference",
			},
		);
	}
	return undefined;
}

/**
 * Returns the first issue in an approved batch payload, or undefined when the
 * payload is valid and its approval evidence matches the exact batch content.
 */
export function findApprovedGoalBatchIssue(
	payload: Partial<WorklistOperationPayloads["project-goals.create-approved-batch"]>,
): ApprovedBatchIssue | undefined {
	if (!isBoundedString(payload.idempotencyKey, MAX_MANAGED_IDENTITY_BYTES)) {
		return validationIssue("Approved batch creation requires a bounded idempotencyKey.", {
			field: "idempotencyKey",
			resolution: "provide-idempotency-key",
		});
	}
	if (
		payload.expectedProjectRevision !== undefined &&
		(typeof payload.expectedProjectRevision !== "string" || !payload.expectedProjectRevision.trim())
	) {
		return validationIssue("expectedProjectRevision must be a non-blank string when present.", {
			field: "expectedProjectRevision",
			resolution: "provide-project-revision",
		});
	}
	const approvalIssueFound = validateApproval(payload.approval);
	if (approvalIssueFound) return approvalIssueFound;

	if (!Array.isArray(payload.goals) || payload.goals.length === 0) {
		return validationIssue("Approved batches must contain at least one goal.", {
			field: "goals",
			resolution: "provide-approved-goals",
		});
	}
	if (payload.goals.length > WORKLIST_PROVIDER_LIMITS.maxBatchItems) {
		return validationIssue(
			`Approved batches are limited to ${WORKLIST_PROVIDER_LIMITS.maxBatchItems} goals.`,
			{
				field: "goals",
				maxBatchItems: WORKLIST_PROVIDER_LIMITS.maxBatchItems,
				resolution: "split-into-smaller-approved-batches",
			},
		);
	}
	const externalIds = new Set<string>();
	for (const [index, goal] of payload.goals.entries()) {
		const issue = validateApprovedGoal(goal, index);
		if (issue) return issue;
		const externalId = (goal as ApprovedProjectGoalInput).external.id;
		if (externalIds.has(externalId)) {
			return validationIssue(`Approved batch contains duplicate external identity ${externalId}.`, {
				field: `goals[${index}].external.id`,
				id: externalId,
				resolution: "deduplicate-external-identities",
			});
		}
		externalIds.add(externalId);
	}

	const approval = payload.approval as ExplicitGoalBatchApproval;
	const expectedDigest = approvedGoalBatchContentDigest(payload.goals as ApprovedProjectGoalInput[]);
	if (approval.contentDigest !== expectedDigest) {
		return approvalIssue(
			"Approval evidence does not match the exact batch content; the approved content digest differs.",
			{
				field: "approval.contentDigest",
				expectedContentDigest: expectedDigest,
				resolution: "request-explicit-user-approval",
			},
		);
	}
	return undefined;
}
