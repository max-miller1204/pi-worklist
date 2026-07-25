export const MANAGED_SESSION_TASK_PROJECTION_VERSION = 1 as const;
export const MAX_MANAGED_IDENTITY_BYTES = 256;
export const MAX_MANAGED_EXECUTION_SUMMARY_BYTES = 4_096;
export const MAX_MANAGED_REFERENCE_BYTES = 2_048;

export const MANAGED_EXECUTION_STATES = [
	"planned",
	"ready",
	"blocked",
	"running",
	"validating",
	"paused",
	"succeeded",
	"failed",
	"cancelled",
] as const;

export type ManagedExecutionState = (typeof MANAGED_EXECUTION_STATES)[number];

export interface ExternalWorkItemIdentity {
	system: "pi-orchestrator";
	kind: "roadmap" | "phase" | "project-goal" | "repository-run" | "workflow-step";
	id: string;
}

export interface ExternalWorkflowStepIdentity extends ExternalWorkItemIdentity {
	kind: "workflow-step";
}

export interface WorklistProjectionProducer {
	id: "pi-orchestrator";
	version: string;
}

/**
 * This is a lightweight, read-only projection.
 * Attempts, logs, dependencies, retries, artifacts, workers, readiness, evidence, and recovery remain canonical in pi-orchestrator.
 */
export interface ManagedExecutionProjection {
	state: ManagedExecutionState;
	updatedAt: string;
	runId: string;
	summary?: string;
	runReference?: string;
}

export const MANAGED_OVERRIDABLE_FIELDS = ["goalId", "status", "title"] as const;

export type ManagedOverridableField = (typeof MANAGED_OVERRIDABLE_FIELDS)[number];

/**
 * Marks a projection the user diverged from.
 * Reconciliation and execution updates must preserve the user's version instead of
 * silently restoring projected data; pi-orchestrator resolves the divergence explicitly.
 */
export interface ManagedUserOverride {
	overriddenAt: string;
	/** Sorted unique user-changed fields. */
	overriddenFields: ManagedOverridableField[];
}

export interface ManagedSessionTaskProjection {
	version: typeof MANAGED_SESSION_TASK_PROJECTION_VERSION;
	owner: "pi-orchestrator";
	producer: WorklistProjectionProducer;
	/** The external workflow-step identity. Its id is the canonical orchestration step ID. */
	external: ExternalWorkflowStepIdentity;
	planRevision: number;
	approvedPlanRevision: number;
	createdAt: string;
	updatedAt: string;
	execution: ManagedExecutionProjection;
	resultReference?: string;
	sessionContributionReference?: string;
	userOverride?: ManagedUserOverride;
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isBoundedString(value: unknown, maxBytes: number): value is string {
	return typeof value === "string" && value.length > 0 && Buffer.byteLength(value, "utf8") <= maxBytes;
}

function isOptionalBoundedString(value: unknown, maxBytes: number): value is string | undefined {
	return value === undefined || isBoundedString(value, maxBytes);
}

const ISO_UTC_TIMESTAMP = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{3})?Z$/;

function isTimestamp(value: unknown): value is string {
	if (!isBoundedString(value, MAX_MANAGED_IDENTITY_BYTES) || !ISO_UTC_TIMESTAMP.test(value)) {
		return false;
	}
	const timestamp = Date.parse(value);
	if (!Number.isFinite(timestamp)) return false;
	const normalized = value.includes(".") ? value : value.replace("Z", ".000Z");
	return new Date(timestamp).toISOString() === normalized;
}

function isRevision(value: unknown): value is number {
	return Number.isSafeInteger(value) && (value as number) >= 0;
}

function normalizeProducer(value: unknown): WorklistProjectionProducer | undefined {
	if (!isRecord(value) || value.id !== "pi-orchestrator") return undefined;
	if (!isBoundedString(value.version, MAX_MANAGED_IDENTITY_BYTES)) return undefined;
	return { id: "pi-orchestrator", version: value.version };
}

export function normalizeExternalWorkflowStepIdentity(
	value: unknown,
): ExternalWorkflowStepIdentity | undefined {
	if (!isRecord(value)) return undefined;
	if (value.system !== "pi-orchestrator" || value.kind !== "workflow-step") return undefined;
	if (!isBoundedString(value.id, MAX_MANAGED_IDENTITY_BYTES)) return undefined;
	return { system: "pi-orchestrator", kind: "workflow-step", id: value.id };
}

export function normalizeManagedExecutionProjection(value: unknown): ManagedExecutionProjection | undefined {
	if (!isRecord(value)) return undefined;
	if (!MANAGED_EXECUTION_STATES.includes(value.state as ManagedExecutionState)) return undefined;
	if (!isTimestamp(value.updatedAt)) return undefined;
	if (!isBoundedString(value.runId, MAX_MANAGED_IDENTITY_BYTES)) return undefined;
	if (!isOptionalBoundedString(value.summary, MAX_MANAGED_EXECUTION_SUMMARY_BYTES)) return undefined;
	if (!isOptionalBoundedString(value.runReference, MAX_MANAGED_REFERENCE_BYTES)) return undefined;
	return {
		state: value.state as ManagedExecutionState,
		updatedAt: value.updatedAt,
		runId: value.runId,
		...(value.summary !== undefined ? { summary: value.summary } : {}),
		...(value.runReference !== undefined ? { runReference: value.runReference } : {}),
	};
}

export function withManagedUserOverride(
	managed: ManagedSessionTaskProjection,
	fields: ManagedOverridableField[],
	overriddenAt: string,
): ManagedSessionTaskProjection {
	const overriddenFields = [
		...new Set([...(managed.userOverride?.overriddenFields ?? []), ...fields]),
	].sort() as ManagedOverridableField[];
	return { ...managed, userOverride: { overriddenAt, overriddenFields } };
}

export function normalizeManagedUserOverride(value: unknown): ManagedUserOverride | undefined {
	if (!isRecord(value)) return undefined;
	if (!isTimestamp(value.overriddenAt)) return undefined;
	if (!Array.isArray(value.overriddenFields)) return undefined;
	const fields = [
		...new Set(
			value.overriddenFields.filter((field): field is ManagedOverridableField =>
				MANAGED_OVERRIDABLE_FIELDS.includes(field as ManagedOverridableField),
			),
		),
	].sort();
	if (fields.length === 0) return undefined;
	return { overriddenAt: value.overriddenAt, overriddenFields: fields };
}

/**
 * Validates and canonicalizes persisted managed metadata.
 * Unknown fields are intentionally omitted so orchestrator-owned attempt, artifact, evidence, and recovery data cannot leak into worklist snapshots.
 */
export function normalizeManagedSessionTaskProjection(
	value: unknown,
): ManagedSessionTaskProjection | undefined {
	if (!isRecord(value)) return undefined;
	if (value.version !== MANAGED_SESSION_TASK_PROJECTION_VERSION) return undefined;
	if (value.owner !== "pi-orchestrator") return undefined;
	const producer = normalizeProducer(value.producer);
	const external = normalizeExternalWorkflowStepIdentity(value.external);
	const execution = normalizeManagedExecutionProjection(value.execution);
	if (!producer || !external || !execution) return undefined;
	if (!isRevision(value.planRevision) || !isRevision(value.approvedPlanRevision)) return undefined;
	if (value.approvedPlanRevision > value.planRevision) return undefined;
	if (!isTimestamp(value.createdAt) || !isTimestamp(value.updatedAt)) return undefined;
	if (!isOptionalBoundedString(value.resultReference, MAX_MANAGED_REFERENCE_BYTES)) {
		return undefined;
	}
	if (!isOptionalBoundedString(value.sessionContributionReference, MAX_MANAGED_REFERENCE_BYTES)) {
		return undefined;
	}

	const userOverride = normalizeManagedUserOverride(value.userOverride);
	return {
		version: MANAGED_SESSION_TASK_PROJECTION_VERSION,
		owner: "pi-orchestrator",
		producer,
		external,
		planRevision: value.planRevision,
		approvedPlanRevision: value.approvedPlanRevision,
		createdAt: value.createdAt,
		updatedAt: value.updatedAt,
		execution,
		...(value.resultReference !== undefined ? { resultReference: value.resultReference } : {}),
		...(value.sessionContributionReference !== undefined
			? { sessionContributionReference: value.sessionContributionReference }
			: {}),
		...(userOverride !== undefined ? { userOverride } : {}),
	};
}
