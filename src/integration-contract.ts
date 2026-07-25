import type {
	ExternalWorkflowStepIdentity,
	ExternalWorkItemIdentity,
	ManagedExecutionProjection,
	ManagedSessionTaskProjection,
	WorklistProjectionProducer,
} from "./managed-projection.ts";
import type { ProjectGoalStatus, SessionTaskStatus } from "./types.ts";

export type {
	ExternalWorkflowStepIdentity,
	ExternalWorkItemIdentity,
	ManagedExecutionProjection,
	ManagedExecutionState,
	ManagedSessionTaskProjection,
	WorklistProjectionProducer,
} from "./managed-projection.ts";
export {
	MANAGED_EXECUTION_STATES,
	MANAGED_SESSION_TASK_PROJECTION_VERSION,
	MAX_MANAGED_EXECUTION_SUMMARY_BYTES,
	MAX_MANAGED_IDENTITY_BYTES,
	MAX_MANAGED_REFERENCE_BYTES,
	normalizeManagedSessionTaskProjection,
} from "./managed-projection.ts";

/**
 * Stable wire contract shared by pi-worklist providers and automation consumers.
 *
 * The event names are intentionally unversioned. Version negotiation happens in
 * the envelope so an incompatible consumer can receive a typed response instead
 * of waiting until its local timeout expires.
 */
export const WORKLIST_PROTOCOL_ID = "pi-worklist" as const;
export const CURRENT_WORKLIST_PROTOCOL_VERSION = 1 as const;
export const SUPPORTED_WORKLIST_PROTOCOL_VERSIONS = [CURRENT_WORKLIST_PROTOCOL_VERSION] as const;

export const WORKLIST_REQUEST_EVENT = "pi-worklist:request" as const;
export const WORKLIST_RESULT_EVENT = "pi-worklist:result" as const;
export const WORKLIST_CHANGE_EVENT = "pi-worklist:change" as const;

export const DEFAULT_WORKLIST_REQUEST_TIMEOUT_MS = 2_000;
export const MAX_WORKLIST_REQUEST_TIMEOUT_MS = 30_000;

/**
 * Bounds enforced by this provider implementation and advertised during negotiation.
 * Consumers must obey the limits reported by the provider they selected.
 */
export const WORKLIST_PROVIDER_LIMITS = {
	defaultListLimit: 20,
	maxListLimit: 100,
	maxBatchItems: 20,
	maxTitleBytes: 512,
	maxDescriptionBytes: 4_096,
	maxSummaryBytes: 4_096,
	maxReferenceBytes: 2_048,
	defaultTimeoutMs: DEFAULT_WORKLIST_REQUEST_TIMEOUT_MS,
	maxTimeoutMs: MAX_WORKLIST_REQUEST_TIMEOUT_MS,
} as const;

export const WORKLIST_CAPABILITIES = {
	PROJECT_GOALS_READ: "project-goals.read",
	PROJECT_GOALS_CREATE_APPROVED_BATCH: "project-goals.create-approved-batch",
	SESSION_TASKS_LIST: "session-tasks.list",
	SESSION_TASKS_RECONCILE: "session-tasks.reconcile",
	SESSION_TASKS_UPDATE_EXECUTION: "session-tasks.update-execution",
	CHANGES_SUBSCRIBE: "changes.subscribe",
} as const;

export type WorklistCapabilityId = (typeof WORKLIST_CAPABILITIES)[keyof typeof WORKLIST_CAPABILITIES];

export const WORKLIST_OPERATIONS = {
	CAPABILITIES_NEGOTIATE: "capabilities.negotiate",
	PROJECT_GOALS_GET: "project-goals.get",
	PROJECT_GOALS_CREATE_APPROVED_BATCH: "project-goals.create-approved-batch",
	SESSION_TASKS_LIST: "session-tasks.list",
	SESSION_TASKS_RECONCILE: "session-tasks.reconcile",
	SESSION_TASKS_UPDATE_EXECUTION: "session-tasks.update-execution",
} as const;

export type WorklistOperation = (typeof WORKLIST_OPERATIONS)[keyof typeof WORKLIST_OPERATIONS];

export const WORKLIST_ERROR_CODES = {
	UNAVAILABLE: "UNAVAILABLE",
	INCOMPATIBLE_VERSION: "INCOMPATIBLE_VERSION",
	UNSUPPORTED_CAPABILITY: "UNSUPPORTED_CAPABILITY",
	INVALID_REQUEST: "INVALID_REQUEST",
	VALIDATION_FAILED: "VALIDATION_FAILED",
	NOT_FOUND: "NOT_FOUND",
	APPROVAL_REQUIRED: "APPROVAL_REQUIRED",
	CONFLICT: "CONFLICT",
	USER_OVERRIDE: "USER_OVERRIDE",
	TIMEOUT: "TIMEOUT",
	SHUTTING_DOWN: "SHUTTING_DOWN",
	PERSISTENCE_FAILED: "PERSISTENCE_FAILED",
	INTERNAL: "INTERNAL",
} as const;

export type WorklistErrorCode = (typeof WORKLIST_ERROR_CODES)[keyof typeof WORKLIST_ERROR_CODES];
export type WorklistActorType = "extension" | "user" | "tool" | "command" | "dashboard" | "cli" | "system";

export interface WorklistActor {
	type: WorklistActorType;
	id: string;
	version?: string;
	displayName?: string;
}

/** Correlation metadata is descriptive and must not be used as an authorization grant. */
export interface WorklistCorrelation {
	correlationId?: string;
	repositoryId?: string;
	sessionId?: string;
	roadmapId?: string;
	phaseId?: string;
	repositoryRunId?: string;
	runId?: string;
	stepId?: string;
	attemptId?: string;
}

export interface WorklistRevisionSet {
	project?: string;
	session?: string;
}

export interface WorklistCapabilityLimits {
	defaultLimit?: number;
	maxLimit?: number;
	maxBatchItems?: number;
	maxTitleBytes?: number;
	maxDescriptionBytes?: number;
	maxSummaryBytes?: number;
	maxReferenceBytes?: number;
	defaultTimeoutMs?: number;
	maxTimeoutMs?: number;
}

export interface WorklistCapability {
	id: WorklistCapabilityId;
	version: number;
	limits?: WorklistCapabilityLimits;
}

export interface WorklistProviderIdentity {
	id: "pi-worklist";
	version: string;
	instanceId: string;
}

export interface WorklistProjectionPage {
	limit: number;
	returned: number;
	truncated: boolean;
	nextCursor?: string;
}

export interface WorklistProjectionNotice {
	truncatedFields: string[];
}

export interface ProjectGoalSummaryProjection {
	id: string;
	title: string;
	status: ProjectGoalStatus;
	createdAt: string;
	updatedAt: string;
}

export interface ProjectGoalDetailProjection extends ProjectGoalSummaryProjection {
	description?: string;
	projection: WorklistProjectionNotice;
}

export type ProjectGoalSelector = { type: "active" } | { type: "id"; id: string };

export interface SessionTaskSummaryProjection {
	id: string;
	title: string;
	status: SessionTaskStatus;
	goalId?: string;
	managed?: ManagedSessionTaskProjection;
	/** Present only when projected text was truncated to the advertised byte limits. */
	projection?: WorklistProjectionNotice;
}

export interface ReconciledSessionTaskProjection {
	external: ExternalWorkItemIdentity;
	taskId: string;
	action: "created" | "updated" | "unchanged" | "removed" | "preserved-user-override";
}

export interface ExplicitGoalBatchApproval {
	type: "explicit-user-approval";
	approvalId: string;
	approvedAt: string;
	approvedBy: WorklistActor;
	contentDigest: string;
}

export interface ApprovedProjectGoalInput {
	external: ExternalWorkItemIdentity;
	title: string;
	description?: string;
	roadmapReference?: string;
}

export interface ManagedSessionTaskInput {
	external: ExternalWorkflowStepIdentity;
	title: string;
	status: SessionTaskStatus;
	producer: WorklistProjectionProducer;
	planRevision: number;
	approvedPlanRevision: number;
	execution: ManagedExecutionProjection;
	resultReference?: string;
	sessionContributionReference?: string;
}

export interface ManagedExecutionUpdate {
	external: ExternalWorkflowStepIdentity;
	execution: ManagedExecutionProjection;
}

export interface WorklistOperationPayloads {
	"capabilities.negotiate": {
		supportedProtocolVersions: number[];
		requestedCapabilities?: WorklistCapabilityId[];
	};
	"project-goals.get": {
		selector: ProjectGoalSelector;
	};
	"project-goals.create-approved-batch": {
		expectedProjectRevision?: string;
		idempotencyKey: string;
		approval: ExplicitGoalBatchApproval;
		goals: ApprovedProjectGoalInput[];
	};
	"session-tasks.list": {
		goalId?: string;
		statuses?: SessionTaskStatus[];
		limit?: number;
		cursor?: string;
	};
	"session-tasks.reconcile": {
		expectedSessionRevision?: string;
		idempotencyKey: string;
		goalId: string;
		/** Project Goal updatedAt captured by project-goals.get before planning or approval. */
		expectedGoalUpdatedAt: string;
		owner: "pi-orchestrator";
		tasks: ManagedSessionTaskInput[];
	};
	"session-tasks.update-execution": {
		expectedSessionRevision?: string;
		idempotencyKey: string;
		owner: "pi-orchestrator";
		updates: ManagedExecutionUpdate[];
	};
}

export interface WorklistOperationResults {
	"capabilities.negotiate": {
		provider: WorklistProviderIdentity;
		supportedProtocolVersions: number[];
		selectedProtocolVersion: number;
		capabilities: WorklistCapability[];
	};
	"project-goals.get": {
		goal: ProjectGoalDetailProjection | null;
	};
	"project-goals.create-approved-batch": {
		goals: Array<{ external: ExternalWorkItemIdentity; goal: ProjectGoalDetailProjection }>;
	};
	"session-tasks.list": {
		tasks: SessionTaskSummaryProjection[];
		page: WorklistProjectionPage;
	};
	"session-tasks.reconcile": {
		tasks: ReconciledSessionTaskProjection[];
	};
	"session-tasks.update-execution": {
		tasks: ReconciledSessionTaskProjection[];
	};
}

interface WorklistRequestBase<TOperation extends WorklistOperation> {
	protocol: typeof WORKLIST_PROTOCOL_ID;
	protocolVersion: number;
	requestId: string;
	operation: TOperation;
	actor: WorklistActor;
	correlation?: WorklistCorrelation;
	/** Omitted for broadcast negotiation, then set to the selected provider instance. */
	targetProviderInstanceId?: string;
	/** ISO timestamp after which the consumer ignores responses. */
	deadlineAt?: string;
}

export type WorklistRequest<TOperation extends WorklistOperation = WorklistOperation> =
	TOperation extends WorklistOperation
		? WorklistRequestBase<TOperation> & { payload: WorklistOperationPayloads[TOperation] }
		: never;

export type WorklistRequestEnvelope = WorklistRequestBase<WorklistOperation> & {
	payload: Record<string, unknown>;
};

export interface WorklistChangedEntities {
	projectGoalIds: string[];
	sessionTaskIds: string[];
}

export interface WorklistResultMeta {
	changed: boolean;
	/** True only when a valid mutation already matched the requested semantic state. */
	semanticNoOp: boolean;
	/** Sorted, unique JSON Pointer paths. */
	changedFields: string[];
	changedEntities?: WorklistChangedEntities;
	revisions?: WorklistRevisionSet;
}

export interface WorklistConflictDetails {
	type: "revision" | "user-override" | "idempotency-key";
	expectedRevision?: string;
	actualRevision?: string;
	conflictingIds?: string[];
	changedFields?: string[];
	resolution: "refresh-and-retry" | "request-user-decision" | "use-new-idempotency-key";
}

export interface WorklistProtocolError {
	code: WorklistErrorCode;
	message: string;
	retryable: boolean;
	retryAfterMs?: number;
	conflict?: WorklistConflictDetails;
	details?: Record<string, unknown>;
}

interface WorklistResultBase<TOperation extends WorklistOperation> {
	protocol: typeof WORKLIST_PROTOCOL_ID;
	protocolVersion: number;
	requestId: string;
	operation: TOperation;
	/** Echoes the initiating actor so persisted results retain provenance. */
	actor: WorklistActor;
	/** Echoes request correlation metadata without granting additional authority. */
	correlation?: WorklistCorrelation;
	/** Present on provider responses and absent on consumer-synthesized fallbacks. */
	provider?: WorklistProviderIdentity;
	meta: WorklistResultMeta;
}

export type WorklistSuccessResult<TOperation extends WorklistOperation = WorklistOperation> =
	TOperation extends WorklistOperation
		? WorklistResultBase<TOperation> & {
				ok: true;
				result: WorklistOperationResults[TOperation];
				error?: never;
			}
		: never;

export type WorklistErrorResult<TOperation extends WorklistOperation = WorklistOperation> =
	WorklistResultBase<TOperation> & {
		ok: false;
		result?: never;
		error: WorklistProtocolError;
	};

export type WorklistResult<TOperation extends WorklistOperation = WorklistOperation> =
	| WorklistSuccessResult<TOperation>
	| WorklistErrorResult<TOperation>;

export type WorklistResultEnvelope =
	| (WorklistResultBase<WorklistOperation> & {
			ok: true;
			result: Record<string, unknown>;
			error?: never;
	  })
	| (WorklistResultBase<WorklistOperation> & {
			ok: false;
			result?: never;
			error: WorklistProtocolError;
	  });

export type WorklistMutationType =
	| "project-goals.created-approved-batch"
	| "session-tasks.reconciled"
	| "session-tasks.execution-updated"
	| "session-tasks.user-overridden"
	| "session-tasks.changed-manually"
	| "project-goals.changed-manually";

export interface WorklistChangeEvent {
	protocol: typeof WORKLIST_PROTOCOL_ID;
	protocolVersion: number;
	eventId: string;
	occurredAt: string;
	mutation: WorklistMutationType;
	provider: WorklistProviderIdentity;
	actor: WorklistActor;
	correlation?: WorklistCorrelation;
	sourceRequestId?: string;
	changedFields: string[];
	changedEntities: WorklistChangedEntities;
	revisions: WorklistRevisionSet;
}

const KNOWN_OPERATIONS = new Set<string>(Object.values(WORKLIST_OPERATIONS));
const KNOWN_ERROR_CODES = new Set<string>(Object.values(WORKLIST_ERROR_CODES));
const KNOWN_ACTOR_TYPES = new Set<string>([
	"extension",
	"user",
	"tool",
	"command",
	"dashboard",
	"cli",
	"system",
] satisfies WorklistActorType[]);

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isWorklistActor(value: unknown): value is WorklistActor {
	return (
		isRecord(value) &&
		typeof value.type === "string" &&
		KNOWN_ACTOR_TYPES.has(value.type) &&
		typeof value.id === "string" &&
		value.id.length > 0
	);
}

function compareChangedFields(left: string, right: string): number {
	if (left < right) return -1;
	if (left > right) return 1;
	return 0;
}

export function canonicalChangedFields(fields: Iterable<string>): string[] {
	return [...new Set(fields)].sort(compareChangedFields);
}

function hasCanonicalChangedFields(value: unknown): value is string[] {
	if (!Array.isArray(value) || !value.every((field) => typeof field === "string")) return false;
	const canonical = canonicalChangedFields(value);
	return canonical.length === value.length && canonical.every((field, index) => field === value[index]);
}

/** Shallow envelope guard. Operation handlers remain responsible for payload validation. */
export function isWorklistRequest(value: unknown): value is WorklistRequestEnvelope {
	if (!isRecord(value) || !isWorklistActor(value.actor) || !isRecord(value.payload)) return false;
	return (
		value.protocol === WORKLIST_PROTOCOL_ID &&
		Number.isSafeInteger(value.protocolVersion) &&
		Number(value.protocolVersion) > 0 &&
		typeof value.requestId === "string" &&
		value.requestId.length > 0 &&
		typeof value.operation === "string" &&
		KNOWN_OPERATIONS.has(value.operation)
	);
}

function hasWorklistResultBase(value: Record<string, unknown>): boolean {
	if (!isRecord(value.meta) || !isWorklistActor(value.actor)) return false;
	return (
		value.protocol === WORKLIST_PROTOCOL_ID &&
		Number.isSafeInteger(value.protocolVersion) &&
		Number(value.protocolVersion) > 0 &&
		typeof value.requestId === "string" &&
		typeof value.operation === "string" &&
		KNOWN_OPERATIONS.has(value.operation) &&
		typeof value.ok === "boolean" &&
		typeof value.meta.changed === "boolean" &&
		typeof value.meta.semanticNoOp === "boolean" &&
		hasCanonicalChangedFields(value.meta.changedFields)
	);
}

function hasWorklistProtocolError(value: unknown): value is WorklistProtocolError {
	return (
		isRecord(value) &&
		typeof value.code === "string" &&
		KNOWN_ERROR_CODES.has(value.code) &&
		typeof value.message === "string" &&
		typeof value.retryable === "boolean"
	);
}

/** Shallow envelope guard suitable for filtering the shared result channel. */
export function isWorklistResult(value: unknown): value is WorklistResultEnvelope {
	if (!isRecord(value) || !hasWorklistResultBase(value)) return false;
	if (value.ok) return isRecord(value.result) && value.error === undefined;
	return hasWorklistProtocolError(value.error);
}

export function createWorklistErrorResult<TOperation extends WorklistOperation>(
	request: WorklistRequestBase<TOperation>,
	error: WorklistProtocolError,
): WorklistErrorResult<TOperation> {
	return {
		protocol: WORKLIST_PROTOCOL_ID,
		protocolVersion: request.protocolVersion,
		requestId: request.requestId,
		operation: request.operation,
		actor: request.actor,
		correlation: request.correlation,
		ok: false,
		error,
		meta: {
			changed: false,
			semanticNoOp: false,
			changedFields: [],
		},
	};
}
