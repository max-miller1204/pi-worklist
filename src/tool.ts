/* eslint-disable no-case-declarations */
import type { ExtensionContext, ToolExecutionMode } from "@earendil-works/pi-coding-agent";
import type {
	ProjectGoalStatus,
	SessionTask,
	SessionTaskPlacement,
	SessionTaskStatus,
	WorklistToolDetails,
} from "./types.ts";
import { formatProjectGoals, formatSessionTasks } from "./format.ts";
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
import { getWorklistPath, resolveGitRoot } from "./git.ts";

export interface ToolDeps {
	sessionStore: SessionStore;
	projectPath: string | null;
}

export function getProjectPath(cwd: string): string | null {
	const result = resolveGitRoot(cwd);
	if (!result.isGit || !result.root) return null;
	return getWorklistPath(result.root);
}

function readPlacement(params: { beforeId?: string; afterId?: string }): SessionTaskPlacement | undefined {
	if (params.beforeId !== undefined) return { beforeId: params.beforeId.trim() };
	if (params.afterId !== undefined) return { afterId: params.afterId.trim() };
	return undefined;
}

function normalizePlacement(params: {
	scope: "session" | "project";
	action: string;
	beforeId?: string;
	afterId?: string;
}): SessionTaskPlacement | undefined {
	if (params.beforeId !== undefined && params.afterId !== undefined) {
		throw new Error("beforeId and afterId are mutually exclusive; provide exactly one placement anchor");
	}
	const anchor = params.beforeId ?? params.afterId;
	if (anchor !== undefined && !anchor.trim()) throw new Error("Placement anchor must not be blank");
	const placement = readPlacement(params);

	if (params.scope === "project" && (params.action === "move" || placement)) {
		throw new Error("Project Goal reordering is not supported");
	}
	if (params.scope === "session" && placement && params.action !== "add" && params.action !== "move") {
		throw new Error("beforeId and afterId are only supported for session add and move");
	}
	return placement;
}

export async function executeWorklist(
	params: {
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
	},
	_ctx: ExtensionContext,
	deps: ToolDeps,
): Promise<{ content: string; details: WorklistToolDetails }> {
	const { sessionStore, projectPath } = deps;
	const placement = normalizePlacement(params);

	if (params.scope === "session") {
		if (params.description !== undefined) {
			throw new Error("description is only supported for project goals");
		}
		switch (params.action) {
			case "list": {
				const tasks = sessionStore.getTasks();
				return {
					content: formatSessionTasks(tasks),
					details: { scope: "session", action: "list", tasks },
				};
			}
			case "add": {
				if (!params.title) throw new Error("title is required for session add");
				const task = await sessionStore.addTask(params.title, params.goalId, placement);
				const tasks = sessionStore.getTasks();
				return {
					content: `Added session task ${task.id}: ${task.title}`,
					details: { scope: "session", action: "add", tasks },
				};
			}
			case "move": {
				if (!params.id) throw new Error("id is required for session move");
				if (!placement) throw new Error("session move requires exactly one of beforeId or afterId");
				const task = await sessionStore.moveTask(params.id, placement);
				if (!task) throw new Error(`Session task ${params.id} not found`);
				const tasks = sessionStore.getTasks();
				return {
					content: `Moved session task ${task.id}`,
					details: { scope: "session", action: "move", tasks },
				};
			}
			case "update": {
				if (!params.id) throw new Error("id is required for session update");
				const updates: Partial<Pick<SessionTask, "title" | "goalId">> = {};
				if (params.title !== undefined) updates.title = params.title;
				if (params.goalId !== undefined) updates.goalId = params.goalId;
				const task = await sessionStore.updateTask(params.id, updates);
				if (!task) throw new Error(`Session task ${params.id} not found`);
				const tasks = sessionStore.getTasks();
				return {
					content: `Updated session task ${task.id}`,
					details: { scope: "session", action: "update", tasks },
				};
			}
			case "set_status": {
				if (!params.id) throw new Error("id is required for session set_status");
				if (!params.status || !["todo", "doing", "done"].includes(params.status)) {
					throw new Error("status must be todo, doing, or done for session tasks");
				}
				const task = await sessionStore.setTaskStatus(params.id, params.status as SessionTaskStatus);
				if (!task) throw new Error(`Session task ${params.id} not found`);
				const tasks = sessionStore.getTasks();
				return {
					content: `Set session task ${task.id} to ${task.status}`,
					details: { scope: "session", action: "set_status", tasks },
				};
			}
			case "delete": {
				if (!params.id) throw new Error("id is required for session delete");
				const removed = await sessionStore.deleteTask(params.id);
				if (!removed) throw new Error(`Session task ${params.id} not found`);
				const tasks = sessionStore.getTasks();
				return {
					content: `Deleted session task ${params.id}`,
					details: { scope: "session", action: "delete", tasks },
				};
			}
			default:
				throw new Error(`Unknown session action: ${params.action}`);
		}
	}

	if (params.scope === "project") {
		if (!projectPath) {
			throw new Error(
				"Project goals require a git repository. Session tasks are still available outside git.",
			);
		}

		switch (params.action) {
			case "list": {
				const goals = await listProjectGoals(projectPath);
				return {
					content: formatProjectGoals(goals),
					details: { scope: "project", action: "list", goals },
				};
			}
			case "add": {
				if (!params.title) throw new Error("title is required for project add");
				const { goal, goals } = await addProjectGoal(projectPath, params.title, params.description);
				return {
					content: `Added project goal ${goal.id}: ${goal.title}`,
					details: { scope: "project", action: "add", goals },
				};
			}
			case "update": {
				if (!params.id) throw new Error("id is required for project update");
				const { goal, goals } = await updateProjectGoal(projectPath, params.id, {
					title: params.title,
					description: params.description,
				});
				return {
					content: `Updated project goal ${goal.id}`,
					details: { scope: "project", action: "update", goals },
				};
			}
			case "set_status": {
				if (params.status !== "active") {
					throw new Error(
						"Project set_status only accepts active. Use complete, reopen, or archive with confirm=true for lifecycle changes.",
					);
				}
				return executeWorklist({ ...params, action: "set_active" }, _ctx, deps);
			}
			case "set_active": {
				if (!params.id) throw new Error("id is required for project set_active");
				try {
					const { goal, goals } = await activateProjectGoal(projectPath, params.id);
					return {
						content: `Activated project goal ${goal.id}`,
						details: { scope: "project", action: "set_active", goals },
					};
				} catch (error) {
					if (error instanceof ProjectGoalActivationBlockedError) {
						throw new Error(
							"A done or archived Project Goal must be reopened with confirm=true before activation.",
						);
					}
					throw error;
				}
			}
			case "complete":
			case "reopen":
			case "archive":
			case "delete": {
				const id = params.id;
				if (!id) throw new Error(`id is required for project ${params.action}`);
				if (params.confirm !== true) {
					return {
						content: `Project goal ${params.action} requires explicit user intent. Set confirm=true only when the user explicitly requested this action.`,
						details: {
							scope: "project",
							action: params.action,
							requiresConfirm: true,
						},
					};
				}
				if (params.action === "delete") {
					const { goals } = await deleteProjectGoal(projectPath, id);
					return {
						content: `Deleted project goal ${id}`,
						details: { scope: "project", action: "delete", goals },
					};
				}
				const targetStatus = PROJECT_LIFECYCLE_TARGET_STATUS[params.action];
				const { goal, goals } = await transitionProjectGoal(projectPath, id, targetStatus);
				return {
					content: `Project goal ${goal.id} is now ${goal.status}`,
					details: { scope: "project", action: params.action, goals },
				};
			}
			default:
				throw new Error(`Unknown project action: ${params.action}`);
		}
	}

	throw new Error(`Unknown scope: ${params.scope}`);
}

export const WORKLIST_EXECUTION_MODE = "sequential" as ToolExecutionMode;
