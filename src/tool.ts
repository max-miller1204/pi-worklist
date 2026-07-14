/* eslint-disable no-case-declarations */
import type { ExtensionContext, ToolExecutionMode } from "@earendil-works/pi-coding-agent";
import type {
	ProjectGoal,
	ProjectGoalStatus,
	ProjectWorklist,
	SessionTask,
	SessionTaskStatus,
	WorklistToolDetails,
} from "./types.ts";
import { generateId, mutateProjectWorklist, readProjectWorklist, sortGoals } from "./project-store.ts";
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

export function formatSessionTasks(tasks: SessionTask[]): string {
	if (tasks.length === 0) return "No session tasks.";
	return tasks
		.map((t) => {
			const marker = t.status === "done" ? "[x]" : t.status === "doing" ? "[~]" : "[ ]";
			const goal = t.goalId ? ` (goal:${t.goalId})` : "";
			const description = t.description ? ` - ${t.description.replace(/\s+/g, " ").trim()}` : "";
			return `${marker} ${t.id}: ${t.title}${goal}${description}`;
		})
		.join("\n");
}

export function formatProjectGoals(goals: ProjectGoal[]): string {
	if (goals.length === 0) return "No project goals.";
	return sortGoals(goals)
		.map(
			(g) =>
				`[${g.status}] ${g.id}: ${g.title}${g.description ? ` - ${g.description.replace(/\s+/g, " ").trim()}` : ""}`,
		)
		.join("\n");
}

function updateProjectGoal(
	worklist: ProjectWorklist,
	id: string,
	title: string | undefined,
	description: string | undefined,
) {
	const index = worklist.goals.findIndex((goal) => goal.id === id);
	if (index === -1) return { worklist, result: null };
	const updated: ProjectGoal = { ...worklist.goals[index] };
	if (title !== undefined) updated.title = title;
	if (description !== undefined) updated.description = description;
	updated.updatedAt = new Date().toISOString();
	const goals = [...worklist.goals];
	goals[index] = updated;
	return { worklist: { ...worklist, goals }, result: updated };
}

function activateProjectGoal(worklist: ProjectWorklist, id: string) {
	const target = worklist.goals.find((goal) => goal.id === id);
	if (!target) return { worklist, result: { goal: null, blocked: false } };
	if (target.status === "done" || target.status === "archived") {
		return { worklist, result: { goal: target, blocked: true } };
	}
	const now = new Date().toISOString();
	const goals = worklist.goals.map((goal) =>
		goal.id === id
			? { ...goal, status: "active" as ProjectGoalStatus, updatedAt: now }
			: goal.status === "active"
				? { ...goal, status: "open" as ProjectGoalStatus, updatedAt: now }
				: goal,
	);
	return {
		worklist: { ...worklist, goals },
		result: { goal: goals.find((goal) => goal.id === id) ?? null, blocked: false },
	};
}

function transitionProjectGoal(worklist: ProjectWorklist, id: string, status: ProjectGoalStatus) {
	const index = worklist.goals.findIndex((goal) => goal.id === id);
	if (index === -1) return { worklist, result: null };
	const updated: ProjectGoal = {
		...worklist.goals[index],
		status,
		updatedAt: new Date().toISOString(),
	};
	const goals = [...worklist.goals];
	goals[index] = updated;
	return { worklist: { ...worklist, goals }, result: updated };
}

async function deleteProjectGoal(
	projectPath: string,
	id: string,
): Promise<{ content: string; details: WorklistToolDetails }> {
	const result = await mutateProjectWorklist(projectPath, (worklist) => {
		const goals = worklist.goals.filter((goal) => goal.id !== id);
		const removed = goals.length !== worklist.goals.length;
		return { worklist: { ...worklist, goals }, result: removed };
	});
	if (result.error) throw new Error(result.error);
	if (!result.data) throw new Error(`Project goal ${id} not found`);
	return {
		content: `Deleted project goal ${id}`,
		details: {
			scope: "project",
			action: "delete",
			goals: (await readProjectWorklist(projectPath)).data.goals,
		},
	};
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
		confirm?: boolean;
	},
	_ctx: ExtensionContext,
	deps: ToolDeps,
): Promise<{ content: string; details: WorklistToolDetails }> {
	const { sessionStore, projectPath } = deps;

	if (params.scope === "session") {
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
				const task = await sessionStore.addTask(params.title, params.description, params.goalId);
				const tasks = sessionStore.getTasks();
				return {
					content: `Added session task ${task.id}: ${task.title}`,
					details: { scope: "session", action: "add", tasks },
				};
			}
			case "update": {
				if (!params.id) throw new Error("id is required for session update");
				const updates: Partial<Pick<SessionTask, "title" | "description" | "goalId">> = {};
				if (params.title !== undefined) updates.title = params.title;
				if (params.description !== undefined) updates.description = params.description;
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
				const { data, error } = await readProjectWorklist(projectPath);
				if (error) throw new Error(error);
				return {
					content: formatProjectGoals(data.goals),
					details: { scope: "project", action: "list", goals: data.goals },
				};
			}
			case "add": {
				if (!params.title) throw new Error("title is required for project add");
				const now = new Date().toISOString();
				const goal: ProjectGoal = {
					id: generateId("goal"),
					title: params.title,
					description: params.description,
					status: "open",
					createdAt: now,
					updatedAt: now,
				};
				const result = await mutateProjectWorklist(projectPath, (worklist) => ({
					worklist: {
						...worklist,
						goals: sortGoals([...worklist.goals, goal]),
					},
					result: goal,
				}));
				if (result.error) throw new Error(result.error);
				return {
					content: `Added project goal ${result.data.id}: ${result.data.title}`,
					details: {
						scope: "project",
						action: "add",
						goals: sortGoals([...(await readProjectWorklist(projectPath)).data.goals]),
					},
				};
			}
			case "update": {
				const id = params.id;
				if (!id) throw new Error("id is required for project update");
				const result = await mutateProjectWorklist(projectPath, (worklist) =>
					updateProjectGoal(worklist, id, params.title, params.description),
				);
				if (result.error) throw new Error(result.error);
				if (!result.data) throw new Error(`Project goal ${params.id} not found`);
				return {
					content: `Updated project goal ${result.data.id}`,
					details: {
						scope: "project",
						action: "update",
						goals: (await readProjectWorklist(projectPath)).data.goals,
					},
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
				const id = params.id;
				if (!id) throw new Error("id is required for project set_active");
				const result = await mutateProjectWorklist(projectPath, (worklist) =>
					activateProjectGoal(worklist, id),
				);
				if (result.error) throw new Error(result.error);
				if (result.data.blocked)
					throw new Error(
						"A done or archived Project Goal must be reopened with confirm=true before activation.",
					);
				if (!result.data.goal) throw new Error(`Project goal ${params.id} not found`);
				return {
					content: `Activated project goal ${result.data.goal.id}`,
					details: {
						scope: "project",
						action: "set_active",
						goals: (await readProjectWorklist(projectPath)).data.goals,
					},
				};
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
				if (params.action === "delete") return deleteProjectGoal(projectPath, id);
				const targetStatus: ProjectGoalStatus =
					params.action === "complete" ? "done" : params.action === "reopen" ? "open" : "archived";
				const result = await mutateProjectWorklist(projectPath, (worklist) =>
					transitionProjectGoal(worklist, id, targetStatus),
				);
				if (result.error) throw new Error(result.error);
				if (!result.data) throw new Error(`Project goal ${params.id} not found`);
				return {
					content: `Project goal ${result.data.id} is now ${result.data.status}`,
					details: {
						scope: "project",
						action: params.action,
						goals: (await readProjectWorklist(projectPath)).data.goals,
					},
				};
			}
			default:
				throw new Error(`Unknown project action: ${params.action}`);
		}
	}

	throw new Error(`Unknown scope: ${params.scope}`);
}

export const WORKLIST_EXECUTION_MODE = "sequential" as ToolExecutionMode;
