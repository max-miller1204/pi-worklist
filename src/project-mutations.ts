import {
	generateId,
	mutateProjectWorklist,
	type ProjectMutationOptions,
	readProjectWorklist,
	sortGoals,
} from "./project-store.ts";
import type { ProjectGoal, ProjectGoalStatus } from "./types.ts";

/**
 * Pi-free Project Goal persistence primitives.
 *
 * Interface adapters must call WorklistApplicationService rather than these
 * functions directly so application validation and persistence stay unified.
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
	revision: string;
	changed: boolean;
}

export interface ProjectGoalsSnapshot {
	goals: ProjectGoal[];
	revision: string;
}

export interface ProjectGoalUpdate {
	title?: string;
	description?: string;
}

export async function readProjectGoals(path: string): Promise<ProjectGoalsSnapshot> {
	const { data, error } = await readProjectWorklist(path);
	if (error) throw new Error(error);
	return { goals: data.goals, revision: String(data.revision) };
}

export async function listProjectGoals(path: string): Promise<ProjectGoal[]> {
	const snapshot = await readProjectGoals(path);
	return snapshot.goals;
}

function nextGoalUpdatedAt(previous: string): string {
	const previousTime = Date.parse(previous);
	const nextTime = Number.isNaN(previousTime) ? Date.now() : Math.max(Date.now(), previousTime + 1);
	return new Date(nextTime).toISOString();
}

function mutationOutcome(result: {
	data: Omit<ProjectMutationOutcome, "revision" | "changed">;
	revision?: number;
	error?: string;
	changed?: false;
}): ProjectMutationOutcome {
	if (result.error) throw new Error(result.error);
	if (result.revision === undefined) throw new Error("Project mutation did not return a revision");
	return { ...result.data, revision: String(result.revision), changed: result.changed !== false };
}

export async function addProjectGoal(
	path: string,
	title: string,
	description?: string,
	options?: ProjectMutationOptions,
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
	const result = await mutateProjectWorklist(
		path,
		(worklist) => {
			const goals = sortGoals([...worklist.goals, goal]);
			return { worklist: { ...worklist, goals }, result: { goal, goals } };
		},
		options,
	);
	return mutationOutcome(result);
}

export async function updateProjectGoal(
	path: string,
	id: string,
	updates: ProjectGoalUpdate,
	options?: ProjectMutationOptions,
): Promise<ProjectMutationOutcome> {
	const result = await mutateProjectWorklist(
		path,
		(worklist) => {
			const index = worklist.goals.findIndex((goal) => goal.id === id);
			if (index === -1) return { worklist, result: null, changed: false };
			const current = worklist.goals[index];
			const title = updates.title ?? current.title;
			const description = updates.description ?? current.description;
			if (title === current.title && description === current.description) {
				return {
					worklist,
					result: { goal: current, goals: worklist.goals },
					changed: false,
				};
			}
			const updated: ProjectGoal = {
				...current,
				title,
				...(description !== undefined ? { description } : {}),
				updatedAt: nextGoalUpdatedAt(current.updatedAt),
			};
			const goals = [...worklist.goals];
			goals[index] = updated;
			return { worklist: { ...worklist, goals }, result: { goal: updated, goals } };
		},
		options,
	);
	if (result.error) throw new Error(result.error);
	if (!result.data) throw new ProjectGoalNotFoundError(id);
	return mutationOutcome({ ...result, data: result.data });
}

export async function activateProjectGoal(
	path: string,
	id: string,
	options?: ProjectMutationOptions,
): Promise<ProjectMutationOutcome> {
	type ActivationResult = {
		outcome: Omit<ProjectMutationOutcome, "revision" | "changed"> | null;
		blocked: boolean;
	};
	const result = await mutateProjectWorklist(
		path,
		(
			worklist,
		): {
			worklist: typeof worklist;
			result: ActivationResult;
			changed?: boolean;
		} => {
			const target = worklist.goals.find((goal) => goal.id === id);
			if (!target) {
				return { worklist, result: { outcome: null, blocked: false }, changed: false };
			}
			if (target.status === "done" || target.status === "archived") {
				return { worklist, result: { outcome: null, blocked: true }, changed: false };
			}
			const alreadyExclusivelyActive =
				target.status === "active" &&
				!worklist.goals.some((goal) => goal.id !== id && goal.status === "active");
			if (alreadyExclusivelyActive) {
				return {
					worklist,
					result: { outcome: { goal: target, goals: worklist.goals }, blocked: false },
					changed: false,
				};
			}
			const goals = worklist.goals.map((goal) => {
				if (goal.id === id) {
					return {
						...goal,
						status: "active" as ProjectGoalStatus,
						updatedAt: nextGoalUpdatedAt(goal.updatedAt),
					};
				}
				if (goal.status === "active") {
					return {
						...goal,
						status: "open" as ProjectGoalStatus,
						updatedAt: nextGoalUpdatedAt(goal.updatedAt),
					};
				}
				return goal;
			});
			const activated = goals.find((goal) => goal.id === id);
			return {
				worklist: { ...worklist, goals },
				result: { outcome: activated ? { goal: activated, goals } : null, blocked: false },
			};
		},
		options,
	);
	if (result.error) throw new Error(result.error);
	if (result.data.blocked) throw new ProjectGoalActivationBlockedError(id);
	if (!result.data.outcome) throw new ProjectGoalNotFoundError(id);
	return mutationOutcome({ ...result, data: result.data.outcome });
}

export async function transitionProjectGoal(
	path: string,
	id: string,
	status: ProjectGoalStatus,
	options?: ProjectMutationOptions,
): Promise<ProjectMutationOutcome> {
	const result = await mutateProjectWorklist(
		path,
		(worklist) => {
			const index = worklist.goals.findIndex((goal) => goal.id === id);
			if (index === -1) return { worklist, result: null, changed: false };
			const current = worklist.goals[index];
			if (current.status === status) {
				return {
					worklist,
					result: { goal: current, goals: worklist.goals },
					changed: false,
				};
			}
			const updated: ProjectGoal = {
				...current,
				status,
				updatedAt: nextGoalUpdatedAt(current.updatedAt),
			};
			const goals = [...worklist.goals];
			goals[index] = updated;
			return { worklist: { ...worklist, goals }, result: { goal: updated, goals } };
		},
		options,
	);
	if (result.error) throw new Error(result.error);
	if (!result.data) throw new ProjectGoalNotFoundError(id);
	return mutationOutcome({ ...result, data: result.data });
}

export async function deleteProjectGoal(
	path: string,
	id: string,
	options?: ProjectMutationOptions,
): Promise<{ goals: ProjectGoal[]; revision: string; changed: boolean }> {
	const result = await mutateProjectWorklist(
		path,
		(worklist) => {
			const goals = worklist.goals.filter((goal) => goal.id !== id);
			const removed = goals.length !== worklist.goals.length;
			return {
				worklist: removed ? { ...worklist, goals } : worklist,
				result: removed ? { goals } : null,
				changed: removed,
			};
		},
		options,
	);
	if (result.error) throw new Error(result.error);
	if (!result.data) throw new ProjectGoalNotFoundError(id);
	if (result.revision === undefined) throw new Error("Project mutation did not return a revision");
	return { ...result.data, revision: String(result.revision), changed: true };
}
