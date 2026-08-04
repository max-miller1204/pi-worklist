import {
	MAX_REPORTED_GOAL_CANDIDATES,
	resolveGoalSelector,
	type UnresolvedGoalSelector,
} from "./goal-selection.ts";
import {
	activateProjectGoal,
	addProjectGoal,
	deleteProjectGoal,
	listProjectGoals,
	migrateProjectGoalIds,
	PROJECT_LIFECYCLE_TARGET_STATUS,
	ProjectGoalActivationBlockedError,
	ProjectGoalNotFoundError,
	type ProjectGoalUpdate,
	readProjectGoals,
	transitionProjectGoal,
	updateProjectGoal,
} from "./project-mutations.ts";
import {
	ProjectGoalConflictError,
	type ProjectGoalPrecondition,
	type ProjectMutationOptions,
	ProjectRevisionConflictError,
} from "./project-store.ts";
import {
	canonicalChangedFields,
	WORKLIST_ERROR_CODES,
	type WorklistChangedEntities,
	type WorklistError,
	type WorklistResultMeta,
} from "./result-envelope.ts";
import type { SessionStore } from "./session-store.ts";
import type {
	ProjectGoal,
	ProjectGoalStatus,
	SessionTask,
	SessionTaskPlacement,
	SessionTaskStatus,
	WorklistOperationResult,
} from "./types.ts";

export type WorklistOperationSource = "tool" | "command" | "dashboard" | "cli";

export interface WorklistOperationContext {
	source: WorklistOperationSource;
}

export interface WorklistOperation {
	scope: "session" | "project";
	action: string;
	id?: string;
	title?: string;
	description?: string;
	/** Project Goal only: append a paragraph instead of replacing the description. */
	appendDescription?: string;
	status?: SessionTaskStatus | ProjectGoalStatus;
	goalId?: string;
	beforeId?: string;
	afterId?: string;
	confirm?: boolean;
	expectedRevision?: string;
	/** Project Goal only: the target goal's `updatedAt` as the caller last read it. */
	expectedUpdatedAt?: string;
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
	error: WorklistError;
}

export type WorklistApplicationResult = WorklistApplicationSuccess | WorklistApplicationFailure;

export interface WorklistApplicationServiceOptions {
	sessionStore?: SessionStore;
	projectPath?: string | null;
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
	code: WorklistError["code"],
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

/**
 * The typed failure for a selector that named no goal, or more than one.
 *
 * An ambiguous prefix is refused with the goals it matched rather than resolved
 * by picking one, because every guess a caller cannot see is a mutation applied
 * to a goal they did not mean. Interfaces share this so a prefix behaves the
 * same whether it arrived from the CLI, the model tool, or the dashboard.
 */
export function projectGoalSelectionError(
	selector: string,
	resolution: UnresolvedGoalSelector,
): WorklistApplicationError {
	if (resolution.kind === "not-found") return notFoundError("project-goal", selector);
	const reported = resolution.candidates.slice(0, MAX_REPORTED_GOAL_CANDIDATES);
	const listed = reported.map((goal) => goal.id).join(", ");
	const remainder = resolution.candidates.length - reported.length;
	return validationError(
		`Goal ID ${selector} matches ${resolution.candidates.length} goals: ${listed}${remainder > 0 ? `, and ${remainder} more` : ""}. Use a longer prefix or the full ID.`,
		{
			fields: ["id"],
			resolution: "provide-unambiguous-goal-id",
			candidateCount: resolution.candidates.length,
			candidates: reported.map((goal) => ({ id: goal.id, title: goal.title })),
		},
	);
}

/** The explicit-intent gate every irreversible or bulk Project Goal action passes through. */
function requireConfirmation(operation: WorklistOperation): void {
	if (operation.confirm === true) return;
	throw createApplicationError(
		WORKLIST_ERROR_CODES.APPROVAL_REQUIRED,
		`Project ${operation.action} requires explicit confirmation.`,
		{
			confirmation: "confirm=true",
			resolution: "request-explicit-user-confirmation",
		},
	);
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

/** Fields describing a Project Goal's prose or baseline, which a Session Task has no counterpart for. */
const PROJECT_ONLY_FIELDS = [
	{ field: "description", resolution: "remove-description" },
	{ field: "appendDescription", resolution: "remove-append-description" },
	{ field: "expectedUpdatedAt", resolution: "remove-expected-updated-at" },
] as const;

function rejectProjectOnlyFields(operation: WorklistOperation): void {
	const unsupported = PROJECT_ONLY_FIELDS.find((entry) => operation[entry.field] !== undefined);
	if (!unsupported) return;
	throw validationError(`${unsupported.field} is only supported for project goals.`, {
		fields: [unsupported.field],
		resolution: unsupported.resolution,
	});
}

/**
 * The caller's baseline for the one goal an operation targets.
 *
 * Callers echo back the `updatedAt` they read, so a mutation built on a stale
 * read is refused as a conflict instead of silently overwriting whoever wrote
 * in between. It is deliberately narrower than the whole-store revision, which
 * moves for every unrelated goal and so cannot guard a single goal usefully.
 */
function normalizeExpectedGoal(operation: WorklistOperation): ProjectGoalPrecondition | undefined {
	if (operation.expectedUpdatedAt === undefined) return undefined;
	const updatedAt = operation.expectedUpdatedAt;
	if (!updatedAt.trim()) {
		throw validationError("expectedUpdatedAt must not be blank.", {
			fields: ["expectedUpdatedAt"],
			resolution: "provide-non-blank-expected-updated-at",
		});
	}
	if (!operation.id) {
		throw validationError("expectedUpdatedAt requires the id of the goal it guards.", {
			fields: ["expectedUpdatedAt", "id"],
			resolution: "provide-project-goal-id",
		});
	}
	return { id: operation.id, updatedAt };
}

/** Exactly one kind of description change per update: replace the whole blob, or add to it. */
function normalizeDescriptionUpdate(operation: WorklistOperation): ProjectGoalUpdate {
	if (operation.appendDescription === undefined) return { description: operation.description };
	if (operation.description !== undefined) {
		throw validationError(
			"description and appendDescription are mutually exclusive; replace the description or append to it.",
			{
				fields: ["appendDescription", "description"],
				resolution: "provide-one-description-change",
			},
		);
	}
	const appendDescription = operation.appendDescription.trim();
	if (!appendDescription) {
		throw validationError("appendDescription must not be blank.", {
			fields: ["appendDescription"],
			resolution: "provide-non-blank-append-text",
		});
	}
	return { appendDescription };
}

const READ_ACTIONS = new Set(["list"]);
const EXPECTED_UPDATED_AT_ACTIONS = new Set([
	"update",
	"set_active",
	"complete",
	"reopen",
	"archive",
	"delete",
]);

/** Project actions whose `id` is a caller-supplied selector rather than a stored ID. */
const GOAL_SELECTOR_ACTIONS = new Set([...EXPECTED_UPDATED_AT_ACTIONS, "set_status"]);

/**
 * Refuses Project Goal options an action would otherwise accept and ignore.
 *
 * Silently dropping either one is the failure they exist to prevent: an ignored
 * append still rewrites nothing, and an ignored baseline still lets a stale
 * caller overwrite a concurrent edit.
 */
function rejectUnsupportedProjectOptions(operation: WorklistOperation): void {
	if (operation.appendDescription !== undefined && operation.action !== "update") {
		throw validationError("appendDescription is only supported for project update.", {
			fields: ["appendDescription"],
			resolution: "use-project-update",
		});
	}
	if (operation.expectedUpdatedAt !== undefined && !EXPECTED_UPDATED_AT_ACTIONS.has(operation.action)) {
		throw validationError("expectedUpdatedAt is only supported for target-goal mutations.", {
			fields: ["expectedUpdatedAt"],
			resolution: "remove-expected-updated-at",
		});
	}
}

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

function isSessionTaskAnchorNotFoundError(error: unknown): error is Error & { anchorId: string } {
	return (
		error instanceof Error &&
		error.name === "SessionTaskAnchorNotFoundError" &&
		typeof (error as { anchorId?: unknown }).anchorId === "string"
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

function persistenceError(operation: WorklistOperation, error: unknown): WorklistError {
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
	readonly code: WorklistError["code"];
	readonly retryable: boolean;
	readonly conflict?: WorklistError["conflict"];
	readonly details?: Record<string, unknown>;

	constructor(error: WorklistError) {
		super(error.message);
		this.name = error.code;
		this.code = error.code;
		this.retryable = error.retryable;
		this.conflict = error.conflict;
		this.details = error.details;
	}

	toResultError(): WorklistError {
		return {
			code: this.code,
			message: this.message,
			retryable: this.retryable,
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
		_context: WorklistOperationContext,
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
			return {
				ok: true,
				scope: operation.scope,
				action: operation.action,
				result,
				meta,
			};
		} catch (error) {
			let typedError: WorklistError;
			let failureMeta = cloneEmptyResultMeta();
			if (error instanceof WorklistApplicationError) typedError = error.toResultError();
			else if (error instanceof ProjectGoalNotFoundError) {
				typedError = notFoundError("project-goal", error.goalId).toResultError();
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
			} else if (error instanceof ProjectGoalConflictError) {
				typedError = {
					code: WORKLIST_ERROR_CODES.CONFLICT,
					message: error.message,
					retryable: true,
					conflict: {
						type: "goal-updated-at",
						id: error.goalId,
						expectedUpdatedAt: error.expectedUpdatedAt,
						actualUpdatedAt: error.actualUpdatedAt,
						resolution: "refresh-and-retry",
					},
				};
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
		rejectProjectOnlyFields(operation);

		switch (operation.action) {
			case "list":
				return {
					result: { scope: "session", action: "list", tasks: sessionStore.getTasks() },
					changed: false,
					revision: sessionStore.getRevision(),
				};
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
			default:
				throw createApplicationError(
					WORKLIST_ERROR_CODES.INVALID_REQUEST,
					`Unknown session action: ${operation.action}.`,
					{
						supportedActions: ["add", "delete", "list", "move", "set_status", "update"],
					},
				);
		}
	}

	private async executeProject(rawOperation: WorklistOperation): Promise<ProjectExecutionResult> {
		const projectPath = this.requireProjectPath();
		rejectUnsupportedProjectOptions(rawOperation);
		const operation = await this.withResolvedGoalId(projectPath, rawOperation);
		const options: ProjectMutationOptions = {
			expectedRevision: operation.expectedRevision,
			expectedGoal: normalizeExpectedGoal(operation),
		};
		switch (operation.action) {
			case "list": {
				const { goals, revision } = await readProjectGoals(projectPath);
				return { result: { scope: "project", action: "list", goals }, revision, changed: false };
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
					{ title: operation.title, ...normalizeDescriptionUpdate(operation) },
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
				return this.activateProjectGoal(projectPath, operation, options);
			case "set_active":
				return this.activateProjectGoal(projectPath, operation, options);
			case "complete":
			case "reopen":
			case "archive":
			case "delete":
				return this.transitionProjectGoal(projectPath, operation, options);
			case "migrate_ids":
				return this.runGoalIdMigration(projectPath, operation, options);
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
							"list",
							"migrate_ids",
							"reopen",
							"set_active",
							"set_status",
							"update",
						],
					},
				);
		}
	}

	/**
	 * The operation with its goal selector replaced by the stored ID it names.
	 *
	 * Resolution reads the worklist before the mutation takes the lock, so a goal
	 * created in between could in principle have made the prefix ambiguous. That
	 * is benign: IDs are frozen at creation, the resolved ID is exact, and it
	 * either still exists, producing the ordinary not-found, or it does not.
	 * A selector that matches nothing is passed through untouched so the mutation
	 * itself reports the miss, which keeps one not-found path instead of two.
	 */
	private async withResolvedGoalId(
		projectPath: string,
		operation: WorklistOperation,
	): Promise<WorklistOperation> {
		if (!operation.id || !GOAL_SELECTOR_ACTIONS.has(operation.action)) return operation;
		const { goals } = await readProjectGoals(projectPath);
		const resolution = resolveGoalSelector(goals, operation.id);
		if (resolution.kind === "ambiguous") throw projectGoalSelectionError(operation.id, resolution);
		if (resolution.kind === "not-found") return operation;
		return { ...operation, id: resolution.goal.id };
	}

	private async runGoalIdMigration(
		projectPath: string,
		operation: WorklistOperation,
		options: ProjectMutationOptions,
	): Promise<ProjectExecutionResult> {
		requireConfirmation(operation);
		const { goals, migrations, revision, changed } = await migrateProjectGoalIds(projectPath, options);
		return {
			result: { scope: "project", action: "migrate_ids", goals, migrations },
			revision,
			changed,
			changedGoalIds: migrations.map((migration) => migration.to),
		};
	}

	private async activateProjectGoal(
		projectPath: string,
		operation: WorklistOperation,
		options: ProjectMutationOptions,
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
			options,
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
		options: ProjectMutationOptions,
	): Promise<ProjectExecutionResult> {
		if (!operation.id) {
			throw validationError(`id is required for project ${operation.action}.`, {
				fields: ["id"],
				resolution: "provide-project-goal-id",
			});
		}
		requireConfirmation(operation);
		if (operation.action === "delete") {
			const { goals, revision, changed } = await deleteProjectGoal(projectPath, operation.id, options);
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
			options,
		);
		return {
			result: { scope: "project", action, goal, goals },
			revision,
			changed,
			changedGoalIds: [operation.id],
		};
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
