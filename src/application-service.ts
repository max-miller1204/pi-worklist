import {
	canonicalChangedFields,
	WORKLIST_ERROR_CODES,
	type WorklistProtocolError,
	type WorklistResultMeta,
} from "./integration-contract.ts";
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
import type { SessionStore } from "./session-store.ts";
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
}

interface WorklistApplicationResultBase {
	scope: WorklistOperation["scope"];
	action: string;
	meta: WorklistResultMeta;
}

interface ProjectExecutionResult {
	result: WorklistOperationResult;
	revision: string;
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

function metadataForSuccess(
	operation: WorklistOperation,
	result: WorklistOperationResult,
	previousSessionTasks?: SessionTask[],
	projectRevision?: string,
): WorklistResultMeta {
	if (operation.action === "list") {
		return {
			...cloneEmptyResultMeta(),
			...(projectRevision !== undefined ? { revisions: { project: projectRevision } } : {}),
		};
	}

	let changed = true;
	if (operation.scope === "session" && previousSessionTasks && result.tasks) {
		changed = JSON.stringify(previousSessionTasks) !== JSON.stringify(result.tasks);
	}
	const changedRoot = operation.scope === "session" ? "/tasks" : "/goals";
	return {
		changed,
		semanticNoOp: !changed,
		changedFields: changed ? canonicalChangedFields([changedRoot]) : [],
		...(projectRevision !== undefined ? { revisions: { project: projectRevision } } : {}),
	};
}

function isSessionTaskAnchorNotFoundError(error: unknown): error is Error & { anchorId: string } {
	return (
		error instanceof Error &&
		error.name === "SessionTaskAnchorNotFoundError" &&
		typeof (error as { anchorId?: unknown }).anchorId === "string"
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
): Promise<WorklistOperationResult> {
	if (!operation.title) {
		throw validationError("title is required for session add.", {
			fields: ["title"],
			resolution: "provide-title",
		});
	}
	const task = await sessionStore.addTask(operation.title, operation.goalId, placement);
	return { scope: "session", action: "add", task, tasks: sessionStore.getTasks() };
}

async function moveSessionTask(
	sessionStore: SessionStore,
	operation: WorklistOperation,
	placement: SessionTaskPlacement | undefined,
): Promise<WorklistOperationResult> {
	const id = requireOperationId(operation, "session-task");
	if (!placement) {
		throw validationError("Session move requires exactly one of beforeId or afterId.", {
			fields: ["afterId", "beforeId"],
			resolution: "provide-one-placement-anchor",
		});
	}
	const task = await sessionStore.moveTask(id, placement);
	if (!task) throw notFoundError("session-task", id);
	return { scope: "session", action: "move", task, tasks: sessionStore.getTasks() };
}

async function updateSessionTask(
	sessionStore: SessionStore,
	operation: WorklistOperation,
): Promise<WorklistOperationResult> {
	const id = requireOperationId(operation, "session-task");
	const updates: Partial<Pick<SessionTask, "title" | "goalId">> = {};
	if (operation.title !== undefined) updates.title = operation.title;
	if (operation.goalId !== undefined) updates.goalId = operation.goalId;
	const task = await sessionStore.updateTask(id, updates);
	if (!task) throw notFoundError("session-task", id);
	return { scope: "session", action: "update", task, tasks: sessionStore.getTasks() };
}

async function setSessionTaskStatus(
	sessionStore: SessionStore,
	operation: WorklistOperation,
): Promise<WorklistOperationResult> {
	const id = requireOperationId(operation, "session-task");
	if (!operation.status || !["todo", "doing", "done"].includes(operation.status)) {
		throw validationError("status must be todo, doing, or done for session tasks.", {
			fields: ["status"],
			resolution: "provide-supported-session-status",
			supportedStatuses: ["doing", "done", "todo"],
		});
	}
	const task = await sessionStore.setTaskStatus(id, operation.status as SessionTaskStatus);
	if (!task) throw notFoundError("session-task", id);
	return { scope: "session", action: "set_status", task, tasks: sessionStore.getTasks() };
}

async function deleteSessionTask(
	sessionStore: SessionStore,
	operation: WorklistOperation,
): Promise<WorklistOperationResult> {
	const id = requireOperationId(operation, "session-task");
	const removed = await sessionStore.deleteTask(id);
	if (!removed) throw notFoundError("session-task", id);
	return { scope: "session", action: "delete", tasks: sessionStore.getTasks() };
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
			const previousSessionTasks =
				operation.scope === "session" && this.options.sessionStore
					? this.options.sessionStore.getTasks()
					: undefined;
			const placement = normalizePlacement(operation);
			let result: WorklistOperationResult;
			let projectRevision: string | undefined;
			if (operation.scope === "session") result = await this.executeSession(operation, placement);
			else if (operation.scope === "project") {
				const projectExecution = await this.executeProject(operation);
				result = projectExecution.result;
				projectRevision = projectExecution.revision;
			} else {
				throw createApplicationError(
					WORKLIST_ERROR_CODES.INVALID_REQUEST,
					`Unknown worklist scope: ${String(operation.scope)}.`,
					{ supportedScopes: ["project", "session"] },
				);
			}
			return {
				ok: true,
				scope: operation.scope,
				action: operation.action,
				result,
				meta: metadataForSuccess(operation, result, previousSessionTasks, projectRevision),
			};
		} catch (error) {
			let typedError: WorklistProtocolError;
			let failureMeta = cloneEmptyResultMeta();
			if (error instanceof WorklistApplicationError) typedError = error.toResultError();
			else if (error instanceof ProjectGoalNotFoundError) {
				typedError = notFoundError("project-goal", operation.id ?? "unknown").toResultError();
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
	): Promise<WorklistOperationResult> {
		const sessionStore = this.requireSessionStore();
		if (operation.description !== undefined) {
			throw validationError("description is only supported for project goals.", {
				fields: ["description"],
				resolution: "remove-description",
			});
		}

		switch (operation.action) {
			case "list":
				return { scope: "session", action: "list", tasks: sessionStore.getTasks() };
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
					{ supportedActions: ["add", "delete", "list", "move", "set_status", "update"] },
				);
		}
	}

	private async executeProject(operation: WorklistOperation): Promise<ProjectExecutionResult> {
		const projectPath = this.requireProjectPath();
		const options = { expectedRevision: operation.expectedRevision };
		switch (operation.action) {
			case "list": {
				const { goals, revision } = await readProjectGoals(projectPath);
				return { result: { scope: "project", action: "list", goals }, revision };
			}
			case "add": {
				if (!operation.title) {
					throw validationError("title is required for project add.", {
						fields: ["title"],
						resolution: "provide-title",
					});
				}
				const { goal, goals, revision } = await addProjectGoal(
					projectPath,
					operation.title,
					operation.description,
					options,
				);
				return { result: { scope: "project", action: "add", goal, goals }, revision };
			}
			case "update": {
				if (!operation.id) {
					throw validationError("id is required for project update.", {
						fields: ["id"],
						resolution: "provide-project-goal-id",
					});
				}
				const { goal, goals, revision } = await updateProjectGoal(
					projectPath,
					operation.id,
					{
						title: operation.title,
						description: operation.description,
					},
					options,
				);
				return { result: { scope: "project", action: "update", goal, goals }, revision };
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
		const { goal, goals, revision } = await activateProjectGoal(projectPath, operation.id, {
			expectedRevision: operation.expectedRevision,
		});
		return { result: { scope: "project", action: "set_active", goal, goals }, revision };
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
			const { goals, revision } = await deleteProjectGoal(projectPath, operation.id, {
				expectedRevision: operation.expectedRevision,
			});
			return { result: { scope: "project", action: "delete", goals }, revision };
		}
		if (!isProjectLifecycleAction(operation.action)) {
			throw createApplicationError(
				WORKLIST_ERROR_CODES.INVALID_REQUEST,
				`Unknown project lifecycle action: ${operation.action}.`,
			);
		}
		const action = operation.action;
		const { goal, goals, revision } = await transitionProjectGoal(
			projectPath,
			operation.id,
			PROJECT_LIFECYCLE_TARGET_STATUS[action],
			{ expectedRevision: operation.expectedRevision },
		);
		return { result: { scope: "project", action, goal, goals }, revision };
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
