import { generateGoalId, planGoalIdMigration, takenGoalIds } from "./goal-selection.ts";
import {
	mutateProjectWorklist,
	type ProjectMutationOptions,
	readProjectWorklist,
	sortGoals,
} from "./project-store.ts";
import type { GoalIdMigration, ProjectGoal, ProjectGoalStatus } from "./types.ts";

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
	readonly goalId: string;

	constructor(id: string) {
		super(`Project goal ${id} not found`);
		this.name = "ProjectGoalNotFoundError";
		this.goalId = id;
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
	/** Additive alternative to `description`, so a note never rewrites the whole blob. */
	appendDescription?: string;
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

/**
 * The description a goal ends up with, resolved under the lock against whatever
 * is stored right now.
 *
 * Appending reads the current description here rather than in the caller, so an
 * additive note composes with a concurrent edit instead of replaying a baseline
 * the caller captured earlier. Appended text becomes its own paragraph, which
 * keeps a note distinct from the sentence it follows in every Markdown reader.
 */
function resolveDescription(current: string | undefined, updates: ProjectGoalUpdate): string | undefined {
	if (updates.appendDescription === undefined) return updates.description ?? current;
	const existing = current?.trimEnd();
	return existing ? `${existing}\n\n${updates.appendDescription}` : updates.appendDescription;
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

/**
 * Adds an open goal whose ID is derived from its title.
 *
 * The ID is minted inside the mutation, against the goals the lock guarantees
 * are current, because a slug is only unique relative to what already exists:
 * choosing it beforehand would let two concurrent adds of the same title agree
 * on the same ID and leave the second one unreachable.
 */
export async function addProjectGoal(
	path: string,
	title: string,
	description?: string,
	options?: ProjectMutationOptions,
): Promise<ProjectMutationOutcome> {
	const now = new Date().toISOString();
	const result = await mutateProjectWorklist(
		path,
		(worklist) => {
			const goal: ProjectGoal = {
				id: generateGoalId(title, takenGoalIds(worklist.goals)),
				title,
				description,
				status: "open",
				createdAt: now,
				updatedAt: now,
			};
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
			const description = resolveDescription(current.description, updates);
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

export interface ProjectActivationOutcome extends ProjectMutationOutcome {
	/** Every goal whose status or timestamp changed, including demoted previously active goals. */
	changedGoalIds: string[];
}

export async function activateProjectGoal(
	path: string,
	id: string,
	options?: ProjectMutationOptions,
): Promise<ProjectActivationOutcome> {
	type ActivationResult = {
		outcome: (Omit<ProjectMutationOutcome, "revision" | "changed"> & { changedGoalIds: string[] }) | null;
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
					result: {
						outcome: { goal: target, goals: worklist.goals, changedGoalIds: [] },
						blocked: false,
					},
					changed: false,
				};
			}
			const changedGoalIds: string[] = [];
			const goals = worklist.goals.map((goal) => {
				if (goal.id === id) {
					changedGoalIds.push(goal.id);
					return {
						...goal,
						status: "active" as ProjectGoalStatus,
						updatedAt: nextGoalUpdatedAt(goal.updatedAt),
					};
				}
				if (goal.status === "active") {
					changedGoalIds.push(goal.id);
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
				result: {
					outcome: activated ? { goal: activated, goals, changedGoalIds } : null,
					blocked: false,
				},
			};
		},
		options,
	);
	if (result.error) throw new Error(result.error);
	if (result.data.blocked) throw new ProjectGoalActivationBlockedError(id);
	if (!result.data.outcome) throw new ProjectGoalNotFoundError(id);
	const { changedGoalIds, ...outcome } = result.data.outcome;
	return { ...mutationOutcome({ ...result, data: outcome }), changedGoalIds };
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

export interface GoalIdMigrationOutcome {
	goals: ProjectGoal[];
	migrations: GoalIdMigration[];
	revision: string;
	changed: boolean;
}

/**
 * Rewrites randomly generated goal IDs into title-derived ones.
 *
 * Each rewritten goal keeps its old ID as a former ID, so the references a
 * migration cannot reach, a Session Task's `goalId`, a PR description, an
 * evidence file, all keep resolving to the same goal afterwards. That is what
 * makes migrating a done or archived goal safe rather than a decision to weigh:
 * no historical reference is invalidated by giving a goal a readable name.
 *
 * A future field that stores a goal ID inside the worklist itself, such as
 * dependency edges, must be rewritten here as well: former IDs keep an outside
 * reference working, but leaving a stored edge on an old name would let the
 * file disagree with itself.
 */
export async function migrateProjectGoalIds(
	path: string,
	options?: ProjectMutationOptions,
): Promise<GoalIdMigrationOutcome> {
	const result = await mutateProjectWorklist(
		path,
		(worklist) => {
			const migrations = planGoalIdMigration(worklist.goals);
			if (migrations.length === 0) {
				return { worklist, result: { goals: worklist.goals, migrations }, changed: false };
			}
			const byPreviousId = new Map(migrations.map((migration) => [migration.from, migration]));
			const goals = worklist.goals.map((goal) => {
				const migration = byPreviousId.get(goal.id);
				if (!migration) return goal;
				return {
					...goal,
					id: migration.to,
					previousIds: [...new Set([...(goal.previousIds ?? []), migration.from])],
					updatedAt: nextGoalUpdatedAt(goal.updatedAt),
				};
			});
			return { worklist: { ...worklist, goals }, result: { goals, migrations } };
		},
		options,
	);
	if (result.error) throw new Error(result.error);
	if (result.revision === undefined) throw new Error("Project mutation did not return a revision");
	return { ...result.data, revision: String(result.revision), changed: result.changed !== false };
}
