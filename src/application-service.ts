import {
	activateProjectGoal,
	addProjectGoal,
	deleteProjectGoal,
	listProjectGoals,
	PROJECT_LIFECYCLE_TARGET_STATUS,
	ProjectGoalActivationBlockedError,
	transitionProjectGoal,
	updateProjectGoal,
} from "./project-mutations.ts";
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
}

export type WorklistApplicationResult = WorklistOperationResult;

export interface WorklistApplicationServiceOptions {
	sessionStore?: SessionStore;
	projectPath?: string | null;
}

type ProjectLifecycleAction = keyof typeof PROJECT_LIFECYCLE_TARGET_STATUS;

function isProjectLifecycleAction(action: string): action is ProjectLifecycleAction {
	return action === "complete" || action === "reopen" || action === "archive";
}

function readPlacement(operation: WorklistOperation): SessionTaskPlacement | undefined {
	if (operation.beforeId !== undefined) return { beforeId: operation.beforeId.trim() };
	if (operation.afterId !== undefined) return { afterId: operation.afterId.trim() };
	return undefined;
}

function normalizePlacement(operation: WorklistOperation): SessionTaskPlacement | undefined {
	if (operation.beforeId !== undefined && operation.afterId !== undefined) {
		throw new Error("beforeId and afterId are mutually exclusive; provide exactly one placement anchor");
	}
	const anchor = operation.beforeId ?? operation.afterId;
	if (anchor !== undefined && !anchor.trim()) throw new Error("Placement anchor must not be blank");
	const placement = readPlacement(operation);

	if (operation.scope === "project" && (operation.action === "move" || placement)) {
		throw new Error("Project Goal reordering is not supported");
	}
	if (
		operation.scope === "session" &&
		placement &&
		operation.action !== "add" &&
		operation.action !== "move"
	) {
		throw new Error("beforeId and afterId are only supported for session add and move");
	}
	return placement;
}

/**
 * Canonical application boundary for every worklist interface.
 *
 * Adapters are responsible only for parsing input and presenting this service's
 * result. Validation, state transitions, locking, and persistence are owned by
 * this service and the stores it coordinates.
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
		return this.requireSessionStore().getTasks();
	}

	async getProjectGoals(): Promise<ProjectGoal[]> {
		if (!this.projectPath) return [];
		return listProjectGoals(this.projectPath);
	}

	async execute(
		operation: WorklistOperation,
		_context: WorklistOperationContext,
	): Promise<WorklistApplicationResult> {
		const placement = normalizePlacement(operation);

		if (operation.scope === "session") return this.executeSession(operation, placement);
		if (operation.scope === "project") return this.executeProject(operation, _context);
		throw new Error(`Unknown scope: ${operation.scope}`);
	}

	private async executeSession(
		operation: WorklistOperation,
		placement: SessionTaskPlacement | undefined,
	): Promise<WorklistApplicationResult> {
		const sessionStore = this.requireSessionStore();
		if (operation.description !== undefined) {
			throw new Error("description is only supported for project goals");
		}

		switch (operation.action) {
			case "list": {
				const tasks = sessionStore.getTasks();
				return { scope: "session", action: "list", tasks };
			}
			case "add": {
				if (!operation.title) throw new Error("title is required for session add");
				const task = await sessionStore.addTask(operation.title, operation.goalId, placement);
				return { scope: "session", action: "add", task, tasks: sessionStore.getTasks() };
			}
			case "move": {
				if (!operation.id) throw new Error("id is required for session move");
				if (!placement) throw new Error("session move requires exactly one of beforeId or afterId");
				const task = await sessionStore.moveTask(operation.id, placement);
				if (!task) throw new Error(`Session task ${operation.id} not found`);
				return { scope: "session", action: "move", task, tasks: sessionStore.getTasks() };
			}
			case "update": {
				if (!operation.id) throw new Error("id is required for session update");
				const updates: Partial<Pick<SessionTask, "title" | "goalId">> = {};
				if (operation.title !== undefined) updates.title = operation.title;
				if (operation.goalId !== undefined) updates.goalId = operation.goalId;
				const task = await sessionStore.updateTask(operation.id, updates);
				if (!task) throw new Error(`Session task ${operation.id} not found`);
				return { scope: "session", action: "update", task, tasks: sessionStore.getTasks() };
			}
			case "set_status": {
				if (!operation.id) throw new Error("id is required for session set_status");
				if (!operation.status || !["todo", "doing", "done"].includes(operation.status)) {
					throw new Error("status must be todo, doing, or done for session tasks");
				}
				const task = await sessionStore.setTaskStatus(operation.id, operation.status as SessionTaskStatus);
				if (!task) throw new Error(`Session task ${operation.id} not found`);
				return { scope: "session", action: "set_status", task, tasks: sessionStore.getTasks() };
			}
			case "delete": {
				if (!operation.id) throw new Error("id is required for session delete");
				const removed = await sessionStore.deleteTask(operation.id);
				if (!removed) throw new Error(`Session task ${operation.id} not found`);
				return { scope: "session", action: "delete", tasks: sessionStore.getTasks() };
			}
			default:
				throw new Error(`Unknown session action: ${operation.action}`);
		}
	}

	private async executeProject(
		operation: WorklistOperation,
		context: WorklistOperationContext,
	): Promise<WorklistApplicationResult> {
		const projectPath = this.requireProjectPath();
		switch (operation.action) {
			case "list": {
				const goals = await listProjectGoals(projectPath);
				return { scope: "project", action: "list", goals };
			}
			case "add": {
				if (!operation.title) throw new Error("title is required for project add");
				const { goal, goals } = await addProjectGoal(projectPath, operation.title, operation.description);
				return { scope: "project", action: "add", goal, goals };
			}
			case "update": {
				if (!operation.id) throw new Error("id is required for project update");
				const { goal, goals } = await updateProjectGoal(projectPath, operation.id, {
					title: operation.title,
					description: operation.description,
				});
				return { scope: "project", action: "update", goal, goals };
			}
			case "set_status":
				if (operation.status !== "active") {
					throw new Error(
						"Project set_status only accepts active. Use complete, reopen, or archive with confirm=true for lifecycle changes.",
					);
				}
				return this.execute({ ...operation, action: "set_active" }, context);
			case "set_active":
				return this.activateProjectGoal(projectPath, operation);
			case "complete":
			case "reopen":
			case "archive":
			case "delete":
				return this.transitionProjectGoal(projectPath, operation);
			default:
				throw new Error(`Unknown project action: ${operation.action}`);
		}
	}

	private async activateProjectGoal(
		projectPath: string,
		operation: WorklistOperation,
	): Promise<WorklistApplicationResult> {
		if (!operation.id) throw new Error("id is required for project set_active");
		try {
			const { goal, goals } = await activateProjectGoal(projectPath, operation.id);
			return { scope: "project", action: "set_active", goal, goals };
		} catch (error) {
			if (error instanceof ProjectGoalActivationBlockedError) {
				throw new Error(
					"A done or archived Project Goal must be reopened with confirm=true before activation.",
				);
			}
			throw error;
		}
	}

	private async transitionProjectGoal(
		projectPath: string,
		operation: WorklistOperation,
	): Promise<WorklistApplicationResult> {
		if (!operation.id) throw new Error(`id is required for project ${operation.action}`);
		if (operation.confirm !== true) {
			return {
				scope: "project",
				action: operation.action,
				requiresConfirm: true,
			};
		}
		if (operation.action === "delete") {
			const { goals } = await deleteProjectGoal(projectPath, operation.id);
			return { scope: "project", action: "delete", goals };
		}
		if (!isProjectLifecycleAction(operation.action)) {
			throw new Error(`Unknown project lifecycle action: ${operation.action}`);
		}
		const action = operation.action;
		const { goal, goals } = await transitionProjectGoal(
			projectPath,
			operation.id,
			PROJECT_LIFECYCLE_TARGET_STATUS[action],
		);
		return { scope: "project", action, goal, goals };
	}

	private requireSessionStore(): SessionStore {
		if (!this.options.sessionStore) {
			throw new Error("Session Tasks require a live Pi session");
		}
		return this.options.sessionStore;
	}

	private requireProjectPath(): string {
		if (!this.projectPath) {
			throw new Error(
				"Project goals require a git repository. Session tasks are still available outside git.",
			);
		}
		return this.projectPath;
	}
}
