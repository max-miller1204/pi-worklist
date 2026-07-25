import {
	approvedGoalBatchFingerprint,
	boundProjectExternalMutationRecords,
	normalizeProjectExternalMutationRecord,
} from "./approved-goal-batches.ts";
import type { ApprovedProjectGoalInput, ExplicitGoalBatchApproval } from "./integration-contract.ts";
import type { ExternalWorkItemIdentity } from "./managed-projection.ts";
import {
	generateId,
	mutateProjectWorklist,
	type ProjectMutationOptions,
	ProjectRevisionConflictError,
	readProjectWorklist,
	sortGoals,
} from "./project-store.ts";
import type { ProjectExternalMutationRecord, ProjectGoal, ProjectGoalStatus } from "./types.ts";

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

export interface ApprovedBatchCreationInput {
	idempotencyKey: string;
	expectedProjectRevision?: string;
	approval: ExplicitGoalBatchApproval;
	goals: ApprovedProjectGoalInput[];
}

export interface CreatedApprovedGoal {
	external: ExternalWorkItemIdentity;
	goal: ProjectGoal;
}

export type ApprovedBatchCreationOutcome =
	| {
			kind: "created";
			createdGoals: CreatedApprovedGoal[];
			goals: ProjectGoal[];
			revision: string;
			changed: true;
	  }
	| { kind: "replayed"; createdGoals: CreatedApprovedGoal[]; revision: string; changed: false }
	| { kind: "idempotency-key-conflict"; revision: string; changed: false }
	| {
			kind: "replayed-goal-missing";
			goalId: string;
			external: ExternalWorkItemIdentity;
			revision: string;
			changed: false;
	  };

/**
 * Creates every approved goal atomically or creates nothing.
 *
 * Under the store lock, an identical idempotency-key replay wins before
 * expected-revision validation, and a new mutation checks its expected revision
 * before any canonical write. Validation of the approval evidence itself belongs
 * to the application service; this primitive only persists.
 */
export async function createApprovedProjectGoalBatch(
	path: string,
	input: ApprovedBatchCreationInput,
): Promise<ApprovedBatchCreationOutcome> {
	type MutationOutcome =
		| { kind: "created"; createdGoals: CreatedApprovedGoal[]; goals: ProjectGoal[]; changed: true }
		| { kind: "replayed"; createdGoals: CreatedApprovedGoal[]; changed: false }
		| { kind: "idempotency-key-conflict"; changed: false }
		| {
				kind: "replayed-goal-missing";
				goalId: string;
				external: ExternalWorkItemIdentity;
				changed: false;
		  };

	const fingerprint = approvedGoalBatchFingerprint(input.approval, input.goals);
	const result = await mutateProjectWorklist<MutationOutcome>(path, (worklist) => {
		const existing = (worklist.externalMutations ?? [])
			.map(normalizeProjectExternalMutationRecord)
			.find((candidate) => candidate?.idempotencyKey === input.idempotencyKey);
		if (existing) {
			if (existing.fingerprint !== fingerprint) {
				return { worklist, result: { kind: "idempotency-key-conflict", changed: false }, changed: false };
			}
			const createdGoals: CreatedApprovedGoal[] = [];
			for (const created of existing.createdGoals) {
				const goal = worklist.goals.find((candidate) => candidate.id === created.goalId);
				if (!goal) {
					return {
						worklist,
						result: {
							kind: "replayed-goal-missing",
							goalId: created.goalId,
							external: created.external,
							changed: false,
						},
						changed: false,
					};
				}
				createdGoals.push({ external: created.external, goal });
			}
			return { worklist, result: { kind: "replayed", createdGoals, changed: false }, changed: false };
		}

		if (
			input.expectedProjectRevision !== undefined &&
			input.expectedProjectRevision !== String(worklist.revision)
		) {
			throw new ProjectRevisionConflictError(input.expectedProjectRevision, String(worklist.revision));
		}

		const now = new Date().toISOString();
		const createdGoals: CreatedApprovedGoal[] = input.goals.map((approved) => ({
			external: {
				system: approved.external.system,
				kind: approved.external.kind,
				id: approved.external.id,
			},
			goal: {
				id: generateId("goal"),
				title: approved.title,
				...(approved.description !== undefined ? { description: approved.description } : {}),
				status: "open" as const,
				createdAt: now,
				updatedAt: now,
			},
		}));
		const record: ProjectExternalMutationRecord = {
			idempotencyKey: input.idempotencyKey,
			fingerprint,
			operation: "project-goals.create-approved-batch",
			approvalId: input.approval.approvalId,
			createdGoals: createdGoals.map(({ external, goal }) => ({ external, goalId: goal.id })),
		};
		const goals = sortGoals([...worklist.goals, ...createdGoals.map(({ goal }) => goal)]);
		const externalMutations = boundProjectExternalMutationRecords([
			...(worklist.externalMutations ?? []),
			record,
		]);
		return {
			worklist: { ...worklist, goals, externalMutations },
			result: { kind: "created", createdGoals, goals, changed: true },
		};
	});
	if (result.error) throw new Error(result.error);
	if (result.revision === undefined) throw new Error("Project mutation did not return a revision");
	return { ...result.data, revision: String(result.revision) } as ApprovedBatchCreationOutcome;
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
