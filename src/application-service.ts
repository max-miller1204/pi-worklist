import type { WorklistChangePublisher } from "./change-events.ts";
import {
	ProjectGoalAssociationChangedError,
	ProjectGoalOrchestrationBlockedError,
	resolveProjectGoalForOrchestration,
	validateManagedGoalAssociation,
} from "./goal-associations.ts";
import {
	canonicalChangedFields,
	type ManagedExecutionUpdate,
	type ManagedSessionTaskInput,
	type ProjectGoalSelector,
	WORKLIST_ERROR_CODES,
	WORKLIST_PROVIDER_LIMITS,
	type WorklistActor,
	type WorklistChangedEntities,
	type WorklistCorrelation,
	type WorklistMutationType,
	type WorklistOperationPayloads,
	type WorklistProtocolError,
	type WorklistResultMeta,
} from "./integration-contract.ts";
import {
	MANAGED_SESSION_TASK_PROJECTION_VERSION,
	normalizeExternalWorkflowStepIdentity,
	normalizeManagedExecutionProjection,
	normalizeManagedSessionTaskProjection,
} from "./managed-projection.ts";
import {
	activateProjectGoal,
	addProjectGoal,
	deleteProjectGoal,
	listProjectGoals,
	PROJECT_LIFECYCLE_TARGET_STATUS,
	ProjectGoalActivationBlockedError,
	ProjectGoalNotFoundError,
	readProjectGoals,
	transitionProjectGoal,
	updateProjectGoal,
} from "./project-mutations.ts";
import { ProjectRevisionConflictError } from "./project-store.ts";
import {
	ListCursorError,
	planSessionTaskListProjection,
	toProjectGoalDetailProjection,
} from "./projections.ts";
import { SessionRevisionConflictError, type SessionStore } from "./session-store.ts";
import type {
	ProjectGoal,
	ProjectGoalStatus,
	SessionTask,
	SessionTaskPlacement,
	SessionTaskStatus,
	WorklistOperationResult,
} from "./types.ts";

export type WorklistOperationSource = "tool" | "command" | "dashboard" | "cli" | "protocol";

export interface WorklistOperationContext {
	source: WorklistOperationSource;
	/** Overrides the source-derived default actor in results and change events. */
	actor?: WorklistActor;
	correlation?: WorklistCorrelation;
	/** Protocol request ID that caused the mutation, echoed on change events. */
	sourceRequestId?: string;
}

export interface WorklistOperation {
	scope: "session" | "project";
	action: string;
	id?: string;
	title?: string;
	description?: string;
	status?: SessionTaskStatus | ProjectGoalStatus;
	goalId?: string;
	beforeId?: string;
	afterId?: string;
	confirm?: boolean;
	expectedRevision?: string;
	reconciliation?: WorklistOperationPayloads["session-tasks.reconcile"];
	executionUpdate?: WorklistOperationPayloads["session-tasks.update-execution"];
	listProjection?: WorklistOperationPayloads["session-tasks.list"];
	goalSelector?: ProjectGoalSelector;
}

interface WorklistApplicationResultBase {
	scope: WorklistOperation["scope"];
	action: string;
	meta: WorklistResultMeta;
}

interface SessionExecutionResult {
	result: WorklistOperationResult;
	revision: string;
	projectRevision?: string;
	changed: boolean;
	changedTaskIds?: string[];
}

interface ProjectExecutionResult {
	result: WorklistOperationResult;
	revision: string;
	changed: boolean;
	changedGoalIds?: string[];
}

export interface WorklistApplicationSuccess extends WorklistApplicationResultBase {
	ok: true;
	result: WorklistOperationResult;
	error?: never;
}

export interface WorklistApplicationFailure extends WorklistApplicationResultBase {
	ok: false;
	result?: never;
	error: WorklistProtocolError;
}

export type WorklistApplicationResult = WorklistApplicationSuccess | WorklistApplicationFailure;

export interface WorklistApplicationServiceOptions {
	sessionStore?: SessionStore;
	projectPath?: string | null;
	/** Invoked after every committed canonical change. Never invoked for reads, failures, or semantic no-ops. */
	publishChange?: WorklistChangePublisher;
}

type ProjectLifecycleAction = keyof typeof PROJECT_LIFECYCLE_TARGET_STATUS;

const EMPTY_RESULT_META: WorklistResultMeta = {
	changed: false,
	semanticNoOp: false,
	changedFields: [],
};

function cloneEmptyResultMeta(): WorklistResultMeta {
	return { ...EMPTY_RESULT_META, changedFields: [] };
}

function isProjectLifecycleAction(action: string): action is ProjectLifecycleAction {
	return action === "complete" || action === "reopen" || action === "archive";
}

function createApplicationError(
	code: WorklistProtocolError["code"],
	message: string,
	details?: Record<string, unknown>,
	retryable = false,
): WorklistApplicationError {
	return new WorklistApplicationError({ code, message, retryable, details });
}

function validationError(message: string, details?: Record<string, unknown>): WorklistApplicationError {
	return createApplicationError(WORKLIST_ERROR_CODES.VALIDATION_FAILED, message, details);
}

function notFoundError(entity: "session-task" | "project-goal" | "session-task-anchor", id: string) {
	let message = `Session task anchor ${id} not found.`;
	if (entity === "session-task") message = `Session task ${id} was not found.`;
	else if (entity === "project-goal") message = `Project goal ${id} was not found.`;
	return createApplicationError(WORKLIST_ERROR_CODES.NOT_FOUND, message, {
		entity,
		id,
		resolution: "refresh-and-select-existing",
	});
}

function readPlacement(operation: WorklistOperation): SessionTaskPlacement | undefined {
	if (operation.beforeId !== undefined) return { beforeId: operation.beforeId.trim() };
	if (operation.afterId !== undefined) return { afterId: operation.afterId.trim() };
	return undefined;
}

function placementField(operation: WorklistOperation): "beforeId" | "afterId" {
	return operation.beforeId !== undefined ? "beforeId" : "afterId";
}

function validatePlacementValue(operation: WorklistOperation): void {
	if (operation.beforeId !== undefined && operation.afterId !== undefined) {
		throw validationError(
			"beforeId and afterId are mutually exclusive; provide exactly one placement anchor.",
			{
				fields: ["afterId", "beforeId"],
				resolution: "provide-one-placement-anchor",
			},
		);
	}
	const anchor = operation.beforeId ?? operation.afterId;
	if (anchor !== undefined && !anchor.trim()) {
		throw validationError("Placement anchor must not be blank.", {
			fields: [placementField(operation)],
			resolution: "provide-non-blank-placement-anchor",
		});
	}
}

function validatePlacementSupport(
	operation: WorklistOperation,
	placement: SessionTaskPlacement | undefined,
): void {
	if (operation.scope === "project") {
		if (operation.action === "move" || placement) {
			throw validationError("Project Goal reordering is not supported.", {
				resolution: "remove-placement-fields",
			});
		}
		return;
	}
	if (placement && operation.action !== "add" && operation.action !== "move") {
		throw validationError("beforeId and afterId are only supported for session add and move.", {
			fields: [placementField(operation)],
			resolution: "remove-placement-fields",
		});
	}
}

function normalizePlacement(operation: WorklistOperation): SessionTaskPlacement | undefined {
	validatePlacementValue(operation);
	const placement = readPlacement(operation);
	validatePlacementSupport(operation, placement);
	return placement;
}

const READ_ACTIONS = new Set(["list", "list_projection", "get_projection"]);

interface SuccessMetadataInput {
	operation: WorklistOperation;
	changed: boolean;
	sessionRevision?: string;
	projectRevision?: string;
	changedTaskIds?: string[];
	changedGoalIds?: string[];
}

function canonicalIds(ids: string[] | undefined): string[] {
	return [...new Set(ids ?? [])].sort();
}

function metadataForSuccess(input: SuccessMetadataInput): WorklistResultMeta {
	const { operation, changed, sessionRevision, projectRevision } = input;
	const revisions = {
		...(sessionRevision !== undefined ? { session: sessionRevision } : {}),
		...(projectRevision !== undefined ? { project: projectRevision } : {}),
	};
	if (READ_ACTIONS.has(operation.action)) {
		return {
			...cloneEmptyResultMeta(),
			...(Object.keys(revisions).length > 0 ? { revisions } : {}),
		};
	}

	const changedEntities: WorklistChangedEntities = {
		projectGoalIds: canonicalIds(input.changedGoalIds),
		sessionTaskIds: canonicalIds(input.changedTaskIds),
	};
	const changedRoot = operation.scope === "session" ? "/tasks" : "/goals";
	return {
		changed,
		semanticNoOp: !changed,
		changedFields: changed ? canonicalChangedFields([changedRoot]) : [],
		...(changed ? { changedEntities } : {}),
		...(Object.keys(revisions).length > 0 ? { revisions } : {}),
	};
}

const SOURCE_ACTOR_TYPES: Record<WorklistOperationSource, WorklistActor["type"]> = {
	tool: "tool",
	command: "command",
	dashboard: "dashboard",
	cli: "cli",
	protocol: "extension",
};

function actorForContext(context: WorklistOperationContext): WorklistActor {
	return context.actor ?? { type: SOURCE_ACTOR_TYPES[context.source], id: "pi-worklist" };
}

function mutationTypeFor(operation: WorklistOperation): WorklistMutationType {
	if (operation.scope === "session") {
		if (operation.action === "reconcile") return "session-tasks.reconciled";
		if (operation.action === "update_execution") return "session-tasks.execution-updated";
		return "session-tasks.changed-manually";
	}
	return "project-goals.changed-manually";
}

function isSessionTaskAnchorNotFoundError(error: unknown): error is Error & { anchorId: string } {
	return (
		error instanceof Error &&
		error.name === "SessionTaskAnchorNotFoundError" &&
		typeof (error as { anchorId?: unknown }).anchorId === "string"
	);
}

function isSessionExecutionTargetNotFoundError(error: unknown): error is Error & { externalId: string } {
	return (
		error instanceof Error &&
		error.name === "SessionExecutionTargetNotFoundError" &&
		typeof (error as { externalId?: unknown }).externalId === "string"
	);
}

function isSessionIdempotencyKeyConflictError(error: unknown): error is Error & { idempotencyKey: string } {
	return (
		error instanceof Error &&
		error.name === "SessionIdempotencyKeyConflictError" &&
		typeof (error as { idempotencyKey?: unknown }).idempotencyKey === "string"
	);
}

function isSessionProjectionGoalConflictError(error: unknown): error is Error & {
	externalId: string;
	taskId: string;
	existingGoalId: string;
	requestedGoalId: string;
} {
	if (!(error instanceof Error) || error.name !== "SessionProjectionGoalConflictError") return false;
	const conflict = error as Partial<{
		externalId: unknown;
		taskId: unknown;
		existingGoalId: unknown;
		requestedGoalId: unknown;
	}>;
	return [conflict.externalId, conflict.taskId, conflict.existingGoalId, conflict.requestedGoalId].every(
		(value) => typeof value === "string",
	);
}

function isSessionRevisionConflictError(
	error: unknown,
): error is Error & { expectedRevision: string; actualRevision: string } {
	return (
		error instanceof Error &&
		error.name === "SessionRevisionConflictError" &&
		typeof (error as { expectedRevision?: unknown }).expectedRevision === "string" &&
		typeof (error as { actualRevision?: unknown }).actualRevision === "string"
	);
}

function persistenceError(operation: WorklistOperation, error: unknown): WorklistProtocolError {
	const rawMessage = error instanceof Error ? error.message : String(error);
	if (
		operation.scope === "project" &&
		(rawMessage.startsWith("Malformed project file") ||
			rawMessage.startsWith("Malformed or unsupported schema"))
	) {
		return {
			code: WORKLIST_ERROR_CODES.PERSISTENCE_FAILED,
			message: "Malformed project worklist or unsupported schema. Repair .pi/worklist.json before retrying.",
			retryable: false,
			details: { resolution: "repair-project-file" },
		};
	}
	let message = "Session task persistence failed. Retry in the active Pi session.";
	let resolution = "retry-active-session";
	if (operation.scope === "project") {
		message =
			"Project worklist persistence failed. Retry after checking repository access and the worklist lock.";
		resolution = "check-repository-and-retry";
	}
	return {
		code: WORKLIST_ERROR_CODES.PERSISTENCE_FAILED,
		message,
		retryable: true,
		details: { resolution },
	};
}

/** A throwable adapter for interfaces whose host signals failures with exceptions. */
export class WorklistApplicationError extends Error {
	readonly code: WorklistProtocolError["code"];
	readonly retryable: boolean;
	readonly retryAfterMs?: number;
	readonly conflict?: WorklistProtocolError["conflict"];
	readonly details?: Record<string, unknown>;

	constructor(error: WorklistProtocolError) {
		super(error.message);
		this.name = error.code;
		this.code = error.code;
		this.retryable = error.retryable;
		this.retryAfterMs = error.retryAfterMs;
		this.conflict = error.conflict;
		this.details = error.details;
	}

	toResultError(): WorklistProtocolError {
		return {
			code: this.code,
			message: this.message,
			retryable: this.retryable,
			...(this.retryAfterMs !== undefined ? { retryAfterMs: this.retryAfterMs } : {}),
			...(this.conflict !== undefined ? { conflict: this.conflict } : {}),
			...(this.details !== undefined ? { details: this.details } : {}),
		};
	}
}

export function unwrapWorklistApplicationResult(
	envelope: WorklistApplicationResult,
): WorklistOperationResult {
	if (!envelope.ok) throw new WorklistApplicationError(envelope.error);
	return envelope.result;
}

function requireOperationId(operation: WorklistOperation, entity: "session-task" | "project-goal"): string {
	if (operation.id) return operation.id;
	const resolution = entity === "session-task" ? "provide-session-task-id" : "provide-project-goal-id";
	throw validationError(`id is required for ${operation.scope} ${operation.action}.`, {
		fields: ["id"],
		resolution,
	});
}

async function addSessionTask(
	sessionStore: SessionStore,
	operation: WorklistOperation,
	placement: SessionTaskPlacement | undefined,
): Promise<SessionExecutionResult> {
	if (!operation.title) {
		throw validationError("title is required for session add.", {
			fields: ["title"],
			resolution: "provide-title",
		});
	}
	const {
		result: task,
		changed,
		revision,
	} = await sessionStore.addTask(operation.title, operation.goalId, placement, {
		expectedRevision: operation.expectedRevision,
	});
	return {
		result: { scope: "session", action: "add", task, tasks: sessionStore.getTasks() },
		changed,
		revision,
		changedTaskIds: [task.id],
	};
}

async function moveSessionTask(
	sessionStore: SessionStore,
	operation: WorklistOperation,
	placement: SessionTaskPlacement | undefined,
): Promise<SessionExecutionResult> {
	const id = requireOperationId(operation, "session-task");
	if (!placement) {
		throw validationError("Session move requires exactly one of beforeId or afterId.", {
			fields: ["afterId", "beforeId"],
			resolution: "provide-one-placement-anchor",
		});
	}
	const {
		result: task,
		changed,
		revision,
	} = await sessionStore.moveTask(id, placement, {
		expectedRevision: operation.expectedRevision,
	});
	if (!task) throw notFoundError("session-task", id);
	return {
		result: { scope: "session", action: "move", task, tasks: sessionStore.getTasks() },
		changed,
		revision,
		changedTaskIds: [id],
	};
}

async function updateSessionTask(
	sessionStore: SessionStore,
	operation: WorklistOperation,
): Promise<SessionExecutionResult> {
	const id = requireOperationId(operation, "session-task");
	const updates: Partial<Pick<SessionTask, "title" | "goalId">> = {};
	if (operation.title !== undefined) updates.title = operation.title;
	if (operation.goalId !== undefined) updates.goalId = operation.goalId;
	const {
		result: task,
		changed,
		revision,
	} = await sessionStore.updateTask(id, updates, {
		expectedRevision: operation.expectedRevision,
	});
	if (!task) throw notFoundError("session-task", id);
	return {
		result: { scope: "session", action: "update", task, tasks: sessionStore.getTasks() },
		changed,
		revision,
		changedTaskIds: [id],
	};
}

async function setSessionTaskStatus(
	sessionStore: SessionStore,
	operation: WorklistOperation,
): Promise<SessionExecutionResult> {
	const id = requireOperationId(operation, "session-task");
	if (!operation.status || !["todo", "doing", "done"].includes(operation.status)) {
		throw validationError("status must be todo, doing, or done for session tasks.", {
			fields: ["status"],
			resolution: "provide-supported-session-status",
			supportedStatuses: ["doing", "done", "todo"],
		});
	}
	const {
		result: task,
		changed,
		revision,
	} = await sessionStore.setTaskStatus(id, operation.status as SessionTaskStatus, {
		expectedRevision: operation.expectedRevision,
	});
	if (!task) throw notFoundError("session-task", id);
	return {
		result: { scope: "session", action: "set_status", task, tasks: sessionStore.getTasks() },
		changed,
		revision,
		changedTaskIds: [id],
	};
}

async function deleteSessionTask(
	sessionStore: SessionStore,
	operation: WorklistOperation,
): Promise<SessionExecutionResult> {
	const id = requireOperationId(operation, "session-task");
	const {
		result: removed,
		changed,
		revision,
	} = await sessionStore.deleteTask(id, {
		expectedRevision: operation.expectedRevision,
	});
	if (!removed) throw notFoundError("session-task", id);
	return {
		result: { scope: "session", action: "delete", tasks: sessionStore.getTasks() },
		changed,
		revision,
		changedTaskIds: [id],
	};
}

function validateManagedTaskInput(value: unknown, index: number): asserts value is ManagedSessionTaskInput {
	if (typeof value !== "object" || value === null || Array.isArray(value)) {
		throw validationError(`Reconciliation task ${index} must be an object.`, {
			field: `tasks[${index}]`,
			resolution: "provide-valid-managed-projection",
		});
	}
	const task = value as ManagedSessionTaskInput;
	if (typeof task.title !== "string" || !task.title.trim()) {
		throw validationError(`Reconciliation task ${index} requires a non-blank title.`, {
			field: `tasks[${index}].title`,
			resolution: "provide-title",
		});
	}
	if (Buffer.byteLength(task.title, "utf8") > WORKLIST_PROVIDER_LIMITS.maxTitleBytes) {
		throw validationError(
			`Reconciliation task ${index} title exceeds ${WORKLIST_PROVIDER_LIMITS.maxTitleBytes} bytes.`,
			{
				field: `tasks[${index}].title`,
				maxTitleBytes: WORKLIST_PROVIDER_LIMITS.maxTitleBytes,
				resolution: "shorten-title",
			},
		);
	}
	if (!(["todo", "doing", "done"] as const).includes(task.status)) {
		throw validationError(`Reconciliation task ${index} has an unsupported status.`, {
			field: `tasks[${index}].status`,
			resolution: "provide-supported-session-status",
			supportedStatuses: ["doing", "done", "todo"],
		});
	}
	const timestamp = "1970-01-01T00:00:00.000Z";
	const normalized = normalizeManagedSessionTaskProjection({
		version: MANAGED_SESSION_TASK_PROJECTION_VERSION,
		owner: "pi-orchestrator",
		producer: task.producer,
		external: task.external,
		planRevision: task.planRevision,
		approvedPlanRevision: task.approvedPlanRevision,
		createdAt: timestamp,
		updatedAt: timestamp,
		execution: task.execution,
		resultReference: task.resultReference,
		sessionContributionReference: task.sessionContributionReference,
	});
	if (!normalized) {
		throw validationError(`Reconciliation task ${index} has invalid managed projection data.`, {
			field: `tasks[${index}]`,
			resolution: "provide-valid-managed-projection",
		});
	}
}

function requireReconciliationPayload(
	operation: WorklistOperation,
): WorklistOperationPayloads["session-tasks.reconcile"] {
	const payload = operation.reconciliation;
	if (!payload || typeof payload !== "object") {
		throw validationError("reconciliation is required for session reconcile.", {
			fields: ["reconciliation"],
			resolution: "provide-reconciliation-payload",
		});
	}
	if (payload.owner !== "pi-orchestrator") {
		throw validationError("Reconciliation owner must be pi-orchestrator.", {
			field: "reconciliation.owner",
			resolution: "provide-supported-owner",
		});
	}
	if (!payload.idempotencyKey?.trim()) {
		throw validationError("Reconciliation idempotencyKey must not be blank.", {
			field: "reconciliation.idempotencyKey",
			resolution: "provide-idempotency-key",
		});
	}
	if (!payload.goalId?.trim()) {
		throw validationError("Reconciliation goalId must not be blank.", {
			field: "reconciliation.goalId",
			resolution: "provide-project-goal-id",
		});
	}
	if (!payload.expectedGoalUpdatedAt?.trim()) {
		throw validationError("Reconciliation expectedGoalUpdatedAt must not be blank.", {
			field: "reconciliation.expectedGoalUpdatedAt",
			resolution: "refresh-project-goal",
		});
	}
	if (!Array.isArray(payload.tasks)) {
		throw validationError("Reconciliation tasks must be an array.", {
			field: "reconciliation.tasks",
			resolution: "provide-task-array",
		});
	}
	const externalIds = new Set<string>();
	for (const [index, task] of payload.tasks.entries()) {
		validateManagedTaskInput(task, index);
		if (externalIds.has(task.external.id)) {
			throw validationError(`Reconciliation contains duplicate external identity ${task.external.id}.`, {
				field: `tasks[${index}].external.id`,
				id: task.external.id,
				resolution: "deduplicate-external-identities",
			});
		}
		externalIds.add(task.external.id);
	}
	return payload;
}

function requireListProjectionPayload(
	operation: WorklistOperation,
): WorklistOperationPayloads["session-tasks.list"] {
	const payload = operation.listProjection ?? {};
	if (typeof payload !== "object" || payload === null || Array.isArray(payload)) {
		throw validationError("listProjection must be an object for session list_projection.", {
			fields: ["listProjection"],
			resolution: "provide-list-projection-payload",
		});
	}
	if (payload.goalId !== undefined && (typeof payload.goalId !== "string" || !payload.goalId.trim())) {
		throw validationError("listProjection goalId must be a non-blank string.", {
			field: "listProjection.goalId",
			resolution: "provide-project-goal-id",
		});
	}
	if (payload.statuses !== undefined) {
		const supported = ["todo", "doing", "done"];
		if (!Array.isArray(payload.statuses) || payload.statuses.some((status) => !supported.includes(status))) {
			throw validationError("listProjection statuses must contain only todo, doing, or done.", {
				field: "listProjection.statuses",
				resolution: "provide-supported-session-status",
				supportedStatuses: ["doing", "done", "todo"],
			});
		}
	}
	if (
		payload.limit !== undefined &&
		(!Number.isSafeInteger(payload.limit) || (payload.limit as number) < 1)
	) {
		throw validationError("listProjection limit must be a positive integer.", {
			field: "listProjection.limit",
			maxLimit: WORKLIST_PROVIDER_LIMITS.maxListLimit,
			resolution: "provide-positive-limit",
		});
	}
	if (payload.cursor !== undefined && (typeof payload.cursor !== "string" || !payload.cursor)) {
		throw validationError("listProjection cursor must be a non-empty string.", {
			field: "listProjection.cursor",
			resolution: "restart-list-from-beginning",
		});
	}
	return payload;
}

function requireGoalSelector(operation: WorklistOperation): ProjectGoalSelector {
	const selector = operation.goalSelector;
	if (selector?.type === "active") return { type: "active" };
	if (selector?.type === "id") {
		if (typeof selector.id !== "string" || !selector.id.trim()) {
			throw validationError("goalSelector id must be a non-blank string.", {
				field: "goalSelector.id",
				resolution: "provide-project-goal-id",
			});
		}
		return { type: "id", id: selector.id };
	}
	throw validationError('goalSelector must be { type: "active" } or { type: "id", id }.', {
		fields: ["goalSelector"],
		resolution: "provide-goal-selector",
	});
}

function validateExecutionUpdateItem(value: unknown, index: number): asserts value is ManagedExecutionUpdate {
	if (typeof value !== "object" || value === null || Array.isArray(value)) {
		throw validationError(`Execution update ${index} must be an object.`, {
			field: `updates[${index}]`,
			resolution: "provide-valid-execution-update",
		});
	}
	const update = value as ManagedExecutionUpdate;
	if (!normalizeExternalWorkflowStepIdentity(update.external)) {
		throw validationError(`Execution update ${index} requires a workflow-step external identity.`, {
			field: `updates[${index}].external`,
			resolution: "provide-workflow-step-identity",
		});
	}
	if (!normalizeManagedExecutionProjection(update.execution)) {
		throw validationError(`Execution update ${index} has an invalid or unbounded execution projection.`, {
			field: `updates[${index}].execution`,
			resolution: "provide-valid-execution-projection",
		});
	}
}

function requireExecutionUpdatePayload(
	operation: WorklistOperation,
): WorklistOperationPayloads["session-tasks.update-execution"] {
	const payload = operation.executionUpdate;
	if (!payload || typeof payload !== "object") {
		throw validationError("executionUpdate is required for session update_execution.", {
			fields: ["executionUpdate"],
			resolution: "provide-execution-update-payload",
		});
	}
	if (payload.owner !== "pi-orchestrator") {
		throw validationError("Execution update owner must be pi-orchestrator.", {
			field: "executionUpdate.owner",
			resolution: "provide-supported-owner",
		});
	}
	if (!payload.idempotencyKey?.trim()) {
		throw validationError("Execution update idempotencyKey must not be blank.", {
			field: "executionUpdate.idempotencyKey",
			resolution: "provide-idempotency-key",
		});
	}
	if (!Array.isArray(payload.updates) || payload.updates.length === 0) {
		throw validationError("Execution updates must be a non-empty array.", {
			field: "executionUpdate.updates",
			resolution: "provide-execution-updates",
		});
	}
	const externalIds = new Set<string>();
	for (const [index, update] of payload.updates.entries()) {
		validateExecutionUpdateItem(update, index);
		if (externalIds.has(update.external.id)) {
			throw validationError(`Execution updates contain duplicate external identity ${update.external.id}.`, {
				field: `updates[${index}].external.id`,
				id: update.external.id,
				resolution: "deduplicate-external-identities",
			});
		}
		externalIds.add(update.external.id);
	}
	return payload;
}

async function updateManagedExecutionProjections(
	sessionStore: SessionStore,
	projectPath: string,
	operation: WorklistOperation,
): Promise<SessionExecutionResult> {
	const payload = requireExecutionUpdatePayload(operation);
	const replay = sessionStore.getManagedExecutionUpdateReplay(payload.updates, payload.idempotencyKey);
	if (replay) {
		return {
			result: {
				scope: "session",
				action: "update_execution",
				reconciliation: { tasks: replay.tasks },
			},
			changed: false,
			revision: replay.revision,
		};
	}
	if (
		payload.expectedSessionRevision !== undefined &&
		payload.expectedSessionRevision !== sessionStore.getRevision()
	) {
		throw new SessionRevisionConflictError(payload.expectedSessionRevision, sessionStore.getRevision());
	}
	for (const goalId of sessionStore.resolveManagedExecutionGoalIds(payload.updates)) {
		// Closed and missing goal associations must block new execution mutations one at a time.
		// pi-lens-ignore: await-in-loop
		await validateManagedGoalAssociation(projectPath, goalId);
	}
	const { tasks, changed, revision } = await sessionStore.updateManagedExecution(
		payload.updates,
		payload.idempotencyKey,
		{ expectedRevision: payload.expectedSessionRevision },
	);
	return {
		result: {
			scope: "session",
			action: "update_execution",
			reconciliation: { tasks },
		},
		changed,
		revision,
		changedTaskIds: changedProjectionTaskIds(tasks),
	};
}

function changedProjectionTaskIds(tasks: Array<{ taskId: string; action: string }>): string[] {
	return tasks
		.filter((task) => task.action !== "unchanged" && task.action !== "preserved-user-override")
		.map((task) => task.taskId);
}

async function reconcileSessionTaskProjections(
	sessionStore: SessionStore,
	projectPath: string,
	operation: WorklistOperation,
): Promise<SessionExecutionResult> {
	const payload = requireReconciliationPayload(operation);
	const replay = sessionStore.getManagedTaskReconciliationReplay(
		payload.goalId,
		payload.tasks,
		payload.idempotencyKey,
	);
	if (replay) {
		return {
			result: {
				scope: "session",
				action: "reconcile",
				reconciliation: { tasks: replay.tasks },
			},
			changed: false,
			revision: replay.revision,
		};
	}
	const association = await validateManagedGoalAssociation(projectPath, payload.goalId, {
		expectedGoalUpdatedAt: payload.expectedGoalUpdatedAt,
	});
	const { tasks, changed, revision } = await sessionStore.reconcileManagedTasks(
		payload.goalId,
		payload.tasks,
		payload.idempotencyKey,
		{ expectedRevision: payload.expectedSessionRevision },
	);
	return {
		result: {
			scope: "session",
			action: "reconcile",
			reconciliation: { tasks },
		},
		changed,
		revision,
		projectRevision: association.revision,
		changedTaskIds: changedProjectionTaskIds(tasks),
	};
}

/**
 * Canonical application boundary for every worklist interface.
 *
 * Adapters are responsible only for parsing input and presenting this service's
 * deterministic result envelope. Validation, state transitions, locking, and
 * persistence are owned by this service and the stores it coordinates.
 */
export class WorklistApplicationService {
	private readonly options: WorklistApplicationServiceOptions;
	private projectPath: string | null;

	constructor(options: WorklistApplicationServiceOptions) {
		this.options = options;
		this.projectPath = options.projectPath ?? null;
	}

	setProjectPath(projectPath: string | null): void {
		this.projectPath = projectPath;
	}

	getSessionTasks(): SessionTask[] {
		return this.requireSessionStore()
			.getTasks()
			.map((task) => ({ ...task }));
	}

	async getProjectGoals(): Promise<ProjectGoal[]> {
		if (!this.projectPath) return [];
		try {
			return await listProjectGoals(this.projectPath);
		} catch (error) {
			throw new WorklistApplicationError(persistenceError({ scope: "project", action: "list" }, error));
		}
	}

	async execute(
		operation: WorklistOperation,
		context: WorklistOperationContext,
	): Promise<WorklistApplicationResult> {
		try {
			const placement = normalizePlacement(operation);
			let result: WorklistOperationResult;
			let changed = false;
			let sessionRevision: string | undefined;
			let projectRevision: string | undefined;
			let changedTaskIds: string[] | undefined;
			let changedGoalIds: string[] | undefined;
			if (operation.scope === "session") {
				const sessionExecution = await this.executeSession(operation, placement);
				result = sessionExecution.result;
				changed = sessionExecution.changed;
				sessionRevision = sessionExecution.revision;
				projectRevision = sessionExecution.projectRevision;
				changedTaskIds = sessionExecution.changedTaskIds;
			} else if (operation.scope === "project") {
				const projectExecution = await this.executeProject(operation);
				result = projectExecution.result;
				changed = projectExecution.changed;
				projectRevision = projectExecution.revision;
				changedGoalIds = projectExecution.changedGoalIds;
			} else {
				throw createApplicationError(
					WORKLIST_ERROR_CODES.INVALID_REQUEST,
					`Unknown worklist scope: ${String(operation.scope)}.`,
					{ supportedScopes: ["project", "session"] },
				);
			}
			const meta = metadataForSuccess({
				operation,
				changed,
				sessionRevision,
				projectRevision,
				changedTaskIds,
				changedGoalIds,
			});
			if (meta.changed) this.publishCommittedChange(operation, context, meta);
			return {
				ok: true,
				scope: operation.scope,
				action: operation.action,
				result,
				meta,
			};
		} catch (error) {
			let typedError: WorklistProtocolError;
			let failureMeta = cloneEmptyResultMeta();
			if (error instanceof WorklistApplicationError) typedError = error.toResultError();
			else if (error instanceof ProjectGoalNotFoundError) {
				typedError = notFoundError("project-goal", error.goalId).toResultError();
			} else if (error instanceof ListCursorError) {
				typedError = validationError(error.message, {
					field: "listProjection.cursor",
					resolution: "restart-list-from-beginning",
				}).toResultError();
			} else if (isSessionExecutionTargetNotFoundError(error)) {
				typedError = createApplicationError(WORKLIST_ERROR_CODES.NOT_FOUND, error.message, {
					entity: "managed-session-task",
					externalId: error.externalId,
					resolution: "reconcile-managed-projections-first",
				}).toResultError();
			} else if (error instanceof ProjectGoalAssociationChangedError) {
				typedError = {
					code: WORKLIST_ERROR_CODES.CONFLICT,
					message: error.message,
					retryable: true,
					conflict: {
						type: "revision",
						expectedRevision: error.expectedGoalUpdatedAt,
						actualRevision: error.actualGoalUpdatedAt,
						conflictingIds: [error.goalId],
						resolution: "refresh-and-retry",
					},
				};
			} else if (error instanceof ProjectGoalOrchestrationBlockedError) {
				typedError = validationError(
					`Project goal ${error.goalId} is ${error.status} and must be explicitly reopened before orchestration.`,
					{
						id: error.goalId,
						status: error.status,
						resolution: "reopen-project-goal",
					},
				).toResultError();
			} else if (isSessionIdempotencyKeyConflictError(error)) {
				typedError = {
					code: WORKLIST_ERROR_CODES.CONFLICT,
					message: error.message,
					retryable: false,
					conflict: {
						type: "idempotency-key",
						resolution: "use-new-idempotency-key",
					},
					details: { idempotencyKey: error.idempotencyKey },
				};
			} else if (isSessionProjectionGoalConflictError(error)) {
				typedError = {
					code: WORKLIST_ERROR_CODES.CONFLICT,
					message: error.message,
					retryable: false,
					conflict: {
						type: "user-override",
						conflictingIds: [error.taskId],
						resolution: "request-user-decision",
					},
					details: {
						externalId: error.externalId,
						existingGoalId: error.existingGoalId,
						requestedGoalId: error.requestedGoalId,
					},
				};
			} else if (error instanceof ProjectRevisionConflictError) {
				typedError = {
					code: WORKLIST_ERROR_CODES.CONFLICT,
					message: error.message,
					retryable: true,
					conflict: {
						type: "revision",
						expectedRevision: error.expectedRevision,
						actualRevision: error.actualRevision,
						resolution: "refresh-and-retry",
					},
				};
				failureMeta = { ...failureMeta, revisions: { project: error.actualRevision } };
			} else if (isSessionRevisionConflictError(error)) {
				typedError = {
					code: WORKLIST_ERROR_CODES.CONFLICT,
					message: error.message,
					retryable: true,
					conflict: {
						type: "revision",
						expectedRevision: error.expectedRevision,
						actualRevision: error.actualRevision,
						resolution: "refresh-and-retry",
					},
				};
				failureMeta = { ...failureMeta, revisions: { session: error.actualRevision } };
			} else if (error instanceof ProjectGoalActivationBlockedError) {
				typedError = validationError(
					"A done or archived Project Goal must be reopened with confirm=true before activation.",
					{
						confirmation: "confirm=true",
						id: operation.id,
						resolution: "reopen-project-goal",
					},
				).toResultError();
			} else if (isSessionTaskAnchorNotFoundError(error)) {
				typedError = notFoundError("session-task-anchor", error.anchorId).toResultError();
			} else {
				typedError = persistenceError(operation, error);
			}
			return {
				ok: false,
				scope: operation.scope,
				action: operation.action,
				error: typedError,
				meta: failureMeta,
			};
		}
	}

	private async executeSession(
		operation: WorklistOperation,
		placement: SessionTaskPlacement | undefined,
	): Promise<SessionExecutionResult> {
		const sessionStore = this.requireSessionStore();
		if (operation.description !== undefined) {
			throw validationError("description is only supported for project goals.", {
				fields: ["description"],
				resolution: "remove-description",
			});
		}

		switch (operation.action) {
			case "list":
				return {
					result: { scope: "session", action: "list", tasks: sessionStore.getTasks() },
					changed: false,
					revision: sessionStore.getRevision(),
				};
			case "list_projection": {
				const payload = requireListProjectionPayload(operation);
				const projection = planSessionTaskListProjection(sessionStore.getStoredTasks(), payload);
				return {
					result: { scope: "session", action: "list_projection", taskProjections: projection },
					changed: false,
					revision: sessionStore.getRevision(),
				};
			}
			case "add":
				return addSessionTask(sessionStore, operation, placement);
			case "move":
				return moveSessionTask(sessionStore, operation, placement);
			case "update":
				return updateSessionTask(sessionStore, operation);
			case "set_status":
				return setSessionTaskStatus(sessionStore, operation);
			case "delete":
				return deleteSessionTask(sessionStore, operation);
			case "reconcile":
				return reconcileSessionTaskProjections(sessionStore, this.requireProjectPath(), operation);
			case "update_execution":
				return updateManagedExecutionProjections(sessionStore, this.requireProjectPath(), operation);
			default:
				throw createApplicationError(
					WORKLIST_ERROR_CODES.INVALID_REQUEST,
					`Unknown session action: ${operation.action}.`,
					{
						supportedActions: [
							"add",
							"delete",
							"list",
							"list_projection",
							"move",
							"reconcile",
							"set_status",
							"update",
							"update_execution",
						],
					},
				);
		}
	}

	private async executeProject(operation: WorklistOperation): Promise<ProjectExecutionResult> {
		const projectPath = this.requireProjectPath();
		const options = { expectedRevision: operation.expectedRevision };
		switch (operation.action) {
			case "list": {
				const { goals, revision } = await readProjectGoals(projectPath);
				return { result: { scope: "project", action: "list", goals }, revision, changed: false };
			}
			case "get_projection": {
				const selector = requireGoalSelector(operation);
				const snapshot = await resolveProjectGoalForOrchestration(projectPath, selector);
				return {
					result: {
						scope: "project",
						action: "get_projection",
						goalProjection: snapshot.goal === null ? null : toProjectGoalDetailProjection(snapshot.goal),
					},
					revision: snapshot.revision,
					changed: false,
				};
			}
			case "add": {
				if (!operation.title) {
					throw validationError("title is required for project add.", {
						fields: ["title"],
						resolution: "provide-title",
					});
				}
				const { goal, goals, revision, changed } = await addProjectGoal(
					projectPath,
					operation.title,
					operation.description,
					options,
				);
				return {
					result: { scope: "project", action: "add", goal, goals },
					revision,
					changed,
					changedGoalIds: [goal.id],
				};
			}
			case "update": {
				if (!operation.id) {
					throw validationError("id is required for project update.", {
						fields: ["id"],
						resolution: "provide-project-goal-id",
					});
				}
				const { goal, goals, revision, changed } = await updateProjectGoal(
					projectPath,
					operation.id,
					{
						title: operation.title,
						description: operation.description,
					},
					options,
				);
				return {
					result: { scope: "project", action: "update", goal, goals },
					revision,
					changed,
					changedGoalIds: [operation.id],
				};
			}
			case "set_status":
				if (operation.status !== "active") {
					throw validationError(
						"Project set_status only accepts active. Use complete, reopen, or archive with confirm=true for lifecycle changes.",
						{
							fields: ["status"],
							resolution: "use-explicit-project-lifecycle-action",
						},
					);
				}
				return this.activateProjectGoal(projectPath, operation);
			case "set_active":
				return this.activateProjectGoal(projectPath, operation);
			case "complete":
			case "reopen":
			case "archive":
			case "delete":
				return this.transitionProjectGoal(projectPath, operation);
			default:
				throw createApplicationError(
					WORKLIST_ERROR_CODES.INVALID_REQUEST,
					`Unknown project action: ${operation.action}.`,
					{
						supportedActions: [
							"add",
							"archive",
							"complete",
							"delete",
							"get_projection",
							"list",
							"reopen",
							"set_active",
							"set_status",
							"update",
						],
					},
				);
		}
	}

	private async activateProjectGoal(
		projectPath: string,
		operation: WorklistOperation,
	): Promise<ProjectExecutionResult> {
		if (!operation.id) {
			throw validationError("id is required for project set_active.", {
				fields: ["id"],
				resolution: "provide-project-goal-id",
			});
		}
		const { goal, goals, revision, changed, changedGoalIds } = await activateProjectGoal(
			projectPath,
			operation.id,
			{ expectedRevision: operation.expectedRevision },
		);
		return {
			result: { scope: "project", action: "set_active", goal, goals },
			revision,
			changed,
			changedGoalIds,
		};
	}

	private async transitionProjectGoal(
		projectPath: string,
		operation: WorklistOperation,
	): Promise<ProjectExecutionResult> {
		if (!operation.id) {
			throw validationError(`id is required for project ${operation.action}.`, {
				fields: ["id"],
				resolution: "provide-project-goal-id",
			});
		}
		if (operation.confirm !== true) {
			throw createApplicationError(
				WORKLIST_ERROR_CODES.APPROVAL_REQUIRED,
				`Project ${operation.action} requires explicit confirmation.`,
				{
					confirmation: "confirm=true",
					resolution: "request-explicit-user-confirmation",
				},
			);
		}
		if (operation.action === "delete") {
			const { goals, revision, changed } = await deleteProjectGoal(projectPath, operation.id, {
				expectedRevision: operation.expectedRevision,
			});
			return {
				result: { scope: "project", action: "delete", goals },
				revision,
				changed,
				changedGoalIds: [operation.id],
			};
		}
		if (!isProjectLifecycleAction(operation.action)) {
			throw createApplicationError(
				WORKLIST_ERROR_CODES.INVALID_REQUEST,
				`Unknown project lifecycle action: ${operation.action}.`,
			);
		}
		const action = operation.action;
		const { goal, goals, revision, changed } = await transitionProjectGoal(
			projectPath,
			operation.id,
			PROJECT_LIFECYCLE_TARGET_STATUS[action],
			{ expectedRevision: operation.expectedRevision },
		);
		return {
			result: { scope: "project", action, goal, goals },
			revision,
			changed,
			changedGoalIds: [operation.id],
		};
	}

	private publishCommittedChange(
		operation: WorklistOperation,
		context: WorklistOperationContext,
		meta: WorklistResultMeta,
	): void {
		if (!this.options.publishChange) return;
		try {
			this.options.publishChange({
				mutation: mutationTypeFor(operation),
				actor: actorForContext(context),
				...(context.correlation !== undefined ? { correlation: context.correlation } : {}),
				...(context.sourceRequestId !== undefined ? { sourceRequestId: context.sourceRequestId } : {}),
				changedFields: meta.changedFields,
				changedEntities: meta.changedEntities ?? { projectGoalIds: [], sessionTaskIds: [] },
				revisions: meta.revisions ?? {},
			});
		} catch {
			// A faulty change subscriber must never turn a committed mutation into a failure.
		}
	}

	private requireSessionStore(): SessionStore {
		if (!this.options.sessionStore) {
			throw createApplicationError(
				WORKLIST_ERROR_CODES.UNAVAILABLE,
				"Session Tasks require a live Pi session.",
				{ resolution: "run-inside-pi-session" },
			);
		}
		return this.options.sessionStore;
	}

	private requireProjectPath(): string {
		if (!this.projectPath) {
			throw createApplicationError(
				WORKLIST_ERROR_CODES.UNAVAILABLE,
				"Project goals require a git repository. Session tasks are still available outside git.",
				{ resolution: "run-inside-git-repository" },
			);
		}
		return this.projectPath;
	}
}
