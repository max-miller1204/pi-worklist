import type { ProjectGoalSelector } from "./integration-contract.ts";
import { ProjectGoalNotFoundError, readProjectGoals } from "./project-mutations.ts";
import type { ProjectGoal, ProjectGoalStatus } from "./types.ts";

export type ManagedGoalAssociationState = "eligible" | "closed" | "missing";

export interface ProjectGoalAssociationSnapshot {
	goal: ProjectGoal;
	revision: string;
}

export interface EmptyProjectGoalAssociationSnapshot {
	goal: null;
	revision: string;
}

export type ProjectGoalSelectionSnapshot =
	| ProjectGoalAssociationSnapshot
	| EmptyProjectGoalAssociationSnapshot;

type OrchestratableProjectGoal = ProjectGoal & { status: "open" | "active" };
type ClosedProjectGoal = ProjectGoal & { status: "done" | "archived" };

export type ManagedGoalAssociationInspection =
	| {
			goalId: string;
			state: "eligible";
			goal: OrchestratableProjectGoal;
			revision: string;
	  }
	| {
			goalId: string;
			state: "closed";
			goal: ClosedProjectGoal;
			revision: string;
	  }
	| {
			goalId: string;
			state: "missing";
			revision: string;
	  };

export interface ManagedGoalAssociationValidationOptions {
	/** The selected goal timestamp captured before planning or approval. */
	expectedGoalUpdatedAt?: string;
}

export class ProjectGoalOrchestrationBlockedError extends Error {
	readonly name = "ProjectGoalOrchestrationBlockedError";
	readonly goalId: string;
	readonly status: Extract<ProjectGoalStatus, "done" | "archived">;

	constructor(goalId: string, status: Extract<ProjectGoalStatus, "done" | "archived">) {
		super(`Project goal ${goalId} is ${status} and must be explicitly reopened before orchestration`);
		this.goalId = goalId;
		this.status = status;
	}
}

export class ProjectGoalAssociationChangedError extends Error {
	readonly name = "ProjectGoalAssociationChangedError";
	readonly goalId: string;
	readonly expectedGoalUpdatedAt: string;
	readonly actualGoalUpdatedAt: string;

	constructor(goalId: string, expectedGoalUpdatedAt: string, actualGoalUpdatedAt: string) {
		super(
			`Project goal ${goalId} changed from ${expectedGoalUpdatedAt} to ${actualGoalUpdatedAt}; refresh the goal before continuing`,
		);
		this.goalId = goalId;
		this.expectedGoalUpdatedAt = expectedGoalUpdatedAt;
		this.actualGoalUpdatedAt = actualGoalUpdatedAt;
	}
}

/**
 * Inspects an association without mutating either Project Goals or Session Tasks.
 *
 * Missing and closed associations are retained as explicit states so callers can preserve an existing
 * managed projection while refusing to start or continue orchestration against it.
 */
export async function inspectManagedGoalAssociation(
	path: string,
	goalId: string,
): Promise<ManagedGoalAssociationInspection> {
	const { goals, revision } = await readProjectGoals(path);
	const goal = goals.find((candidate) => candidate.id === goalId);
	if (!goal) return { goalId, state: "missing", revision };
	if (goal.status === "done" || goal.status === "archived") {
		return { goalId, state: "closed", goal: { ...goal, status: goal.status }, revision };
	}
	return { goalId, state: "eligible", goal: { ...goal, status: goal.status }, revision };
}

/** Resolves an active or explicitly selected Project Goal for orchestration. */
export async function resolveProjectGoalForOrchestration(
	path: string,
	selector: ProjectGoalSelector,
): Promise<ProjectGoalSelectionSnapshot> {
	if (selector.type === "active") {
		const { goals, revision } = await readProjectGoals(path);
		return { goal: goals.find((goal) => goal.status === "active") ?? null, revision };
	}
	return validateManagedGoalAssociation(path, selector.id);
}

/**
 * Validates the Project Goal used by a managed Session Task operation.
 *
 * The check is intentionally separate from Session Task reconstruction. Existing managed projections
 * remain readable when a user archives or deletes their goal, but no new orchestration mutation may use
 * the closed or missing association. Reopening the same goal ID makes the association eligible again.
 */
export async function validateManagedGoalAssociation(
	path: string,
	goalId: string,
	options: ManagedGoalAssociationValidationOptions = {},
): Promise<ProjectGoalAssociationSnapshot> {
	const association = await inspectManagedGoalAssociation(path, goalId);
	if (association.state === "missing") throw new ProjectGoalNotFoundError(goalId);
	if (association.state === "closed") {
		throw new ProjectGoalOrchestrationBlockedError(goalId, association.goal.status);
	}
	if (
		options.expectedGoalUpdatedAt !== undefined &&
		options.expectedGoalUpdatedAt !== association.goal.updatedAt
	) {
		throw new ProjectGoalAssociationChangedError(
			goalId,
			options.expectedGoalUpdatedAt,
			association.goal.updatedAt,
		);
	}
	return { goal: association.goal, revision: association.revision };
}
