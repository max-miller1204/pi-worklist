import { generateId, mutateProjectWorklist, readProjectWorklist, sortGoals } from "./project-store.ts";
import type { ProjectGoal, ProjectGoalStatus, ProjectWorklist } from "./types.ts";

/**
 * Pi-free mutation service for Project Goals. Every interface (model tool,
 * /tasks command, dashboard, CLI, future inter-extension API) must route
 * project mutations through these functions so validation, locking, and
 * persistence rules stay identical everywhere.
 */

export const PROJECT_LIFECYCLE_TARGET_STATUS: Record<"complete" | "reopen" | "archive", ProjectGoalStatus> = {
	complete: "done",
	reopen: "open",
	archive: "archived",
};

export class ProjectGoalNotFoundError extends Error {
	constructor(id: string) {
		super(`Project goal ${id} not found`);
		this.name = "ProjectGoalNotFoundError";
	}
}

export class ProjectGoalActivationBlockedError extends Error {
	constructor(id: string) {
		super(`Project goal ${id} is done or archived and must be reopened before activation`);
		this.name = "ProjectGoalActivationBlockedError";
	}
}

export interface ProjectMutationOutcome {
	goal: ProjectGoal;
	goals: ProjectGoal[];
}

export interface ProjectGoalUpdate {
	title?: string;
	description?: string;
}

export async function listProjectGoals(path: string): Promise<ProjectGoal[]> {
	const { data, error } = await readProjectWorklist(path);
	if (error) throw new Error(error);
	return data.goals;
}

export async function addProjectGoal(
	path: string,
	title: string,
	description?: string,
): Promise<ProjectMutationOutcome> {
	const now = new Date().toISOString();
	const goal: ProjectGoal = {
		id: generateId("goal"),
		title,
		description,
		status: "open",
		createdAt: now,
		updatedAt: now,
	};
	const result = await mutateProjectWorklist(path, (worklist) => {
		const goals = sortGoals([...worklist.goals, goal]);
		return { worklist: { ...worklist, goals }, result: { goal, goals } };
	});
	if (result.error) throw new Error(result.error);
	return result.data;
}

export async function updateProjectGoal(
	path: string,
	id: string,
	updates: ProjectGoalUpdate,
): Promise<ProjectMutationOutcome> {
	const result = await mutateProjectWorklist(path, (worklist) => {
		const index = worklist.goals.findIndex((goal) => goal.id === id);
		if (index === -1) return { worklist, result: null };
		const updated: ProjectGoal = { ...worklist.goals[index] };
		if (updates.title !== undefined) updated.title = updates.title;
		if (updates.description !== undefined) updated.description = updates.description;
		updated.updatedAt = new Date().toISOString();
		const goals = [...worklist.goals];
		goals[index] = updated;
		return { worklist: { ...worklist, goals }, result: { goal: updated, goals } };
	});
	if (result.error) throw new Error(result.error);
	if (!result.data) throw new ProjectGoalNotFoundError(id);
	return result.data;
}

export async function activateProjectGoal(path: string, id: string): Promise<ProjectMutationOutcome> {
	type ActivationResult = { outcome: ProjectMutationOutcome | null; blocked: boolean };
	const result = await mutateProjectWorklist(
		path,
		(worklist): { worklist: ProjectWorklist; result: ActivationResult } => {
			const target = worklist.goals.find((goal) => goal.id === id);
			if (!target) return { worklist, result: { outcome: null, blocked: false } };
			if (target.status === "done" || target.status === "archived") {
				return { worklist, result: { outcome: null, blocked: true } };
			}
			const now = new Date().toISOString();
			const goals = worklist.goals.map((goal) =>
				goal.id === id
					? { ...goal, status: "active" as ProjectGoalStatus, updatedAt: now }
					: goal.status === "active"
						? { ...goal, status: "open" as ProjectGoalStatus, updatedAt: now }
						: goal,
			);
			const activated = goals.find((goal) => goal.id === id);
			return {
				worklist: { ...worklist, goals },
				result: { outcome: activated ? { goal: activated, goals } : null, blocked: false },
			};
		},
	);
	if (result.error) throw new Error(result.error);
	if (result.data.blocked) throw new ProjectGoalActivationBlockedError(id);
	if (!result.data.outcome) throw new ProjectGoalNotFoundError(id);
	return result.data.outcome;
}

export async function transitionProjectGoal(
	path: string,
	id: string,
	status: ProjectGoalStatus,
): Promise<ProjectMutationOutcome> {
	const result = await mutateProjectWorklist(path, (worklist) => {
		const index = worklist.goals.findIndex((goal) => goal.id === id);
		if (index === -1) return { worklist, result: null };
		const updated: ProjectGoal = {
			...worklist.goals[index],
			status,
			updatedAt: new Date().toISOString(),
		};
		const goals = [...worklist.goals];
		goals[index] = updated;
		return { worklist: { ...worklist, goals }, result: { goal: updated, goals } };
	});
	if (result.error) throw new Error(result.error);
	if (!result.data) throw new ProjectGoalNotFoundError(id);
	return result.data;
}

export async function deleteProjectGoal(path: string, id: string): Promise<{ goals: ProjectGoal[] }> {
	const result = await mutateProjectWorklist(path, (worklist) => {
		const goals = worklist.goals.filter((goal) => goal.id !== id);
		const removed = goals.length !== worklist.goals.length;
		return { worklist: { ...worklist, goals }, result: removed ? { goals } : null };
	});
	if (result.error) throw new Error(result.error);
	if (!result.data) throw new ProjectGoalNotFoundError(id);
	return result.data;
}
