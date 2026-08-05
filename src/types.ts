export type SessionTaskStatus = "todo" | "doing" | "done";
export type ProjectGoalStatus = "open" | "active" | "done" | "archived";

export interface SessionTask {
	id: string;
	title: string;
	status: SessionTaskStatus;
	goalId?: string;
}

export type SessionTaskPlacement =
	| { beforeId: string; afterId?: never; direction?: never }
	| { beforeId?: never; afterId: string; direction?: never };

/** Move one step through canonical file order, whatever a display sort shows. */
export type ProjectGoalDirection = "up" | "down";

/**
 * Where a Project Goal lands in canonical file order.
 *
 * An anchor is the general form and the one a filtered view needs, because the
 * caller has already decided which goal to land beside. A direction is resolved
 * under the lock instead, so a one-step move cannot read a neighbor that another
 * writer has moved by the time the mutation runs.
 */
export type ProjectGoalPlacement =
	| SessionTaskPlacement
	| { beforeId?: never; afterId?: never; direction: ProjectGoalDirection };

export interface ProjectGoal {
	id: string;
	title: string;
	description?: string;
	status: ProjectGoalStatus;
	createdAt: string;
	updatedAt: string;
	/**
	 * Free-form section this goal belongs to. A group exists exactly when some
	 * goal names it, so there is no separate list of groups to keep in step.
	 */
	group?: string;
	/**
	 * When the goal was completed. Set by `complete` and cleared by `reopen`,
	 * so it always agrees with the status rather than recording a stale run.
	 *
	 * Absent on a goal completed before this field existed: the moment is
	 * genuinely unknown, and stamping "now" onto it would invent history.
	 */
	completedAt?: string;
	/**
	 * Informational URLs. Deliberately carries no machine semantics, so nothing
	 * can come to depend on parsing a link for state.
	 */
	links?: string[];
	/**
	 * The branch this goal is being worked on, written when a goal is dispatched.
	 *
	 * State markers get a dedicated field rather than being encoded into `links`,
	 * so reading whether a goal is in flight never becomes a string heuristic
	 * over prose a user is free to edit.
	 */
	branch?: string;
	/**
	 * Goals that must land before this one, stored as IDs in one direction only.
	 *
	 * The reverse direction, which goals this one blocks, is derived at read time
	 * rather than stored, so the two halves of an edge cannot disagree. An edge
	 * means must-land-before whatever its reason, logical or a file both goals
	 * would touch, and it is satisfied once its target is done or archived.
	 */
	dependsOn?: string[];
	/**
	 * IDs this goal answered to before an ID migration renamed it, oldest first.
	 * They stay resolvable and reserved, so references written down elsewhere
	 * keep working and no later goal can claim a name still in use.
	 */
	previousIds?: string[];
}

/** One goal's ID rewrite, as planned or applied by an ID migration. */
export interface GoalIdMigration {
	from: string;
	to: string;
	title: string;
}

export interface SessionSnapshot {
	version: number;
	/** Opaque branch-aware concurrency token. Legacy snapshots derive this from their entry ID. */
	revision?: string;
	tasks: SessionTask[];
}

export interface ProjectWorklist {
	version: number;
	/** Absent only in legacy version 1 files, which readers normalize to revision 0. */
	revision?: number;
	/**
	 * Goals in canonical order. The array order is the roadmap's order: it is what
	 * a new goal is appended to, what `move` rearranges, and what every reader
	 * displays unless the reader was explicitly asked for another arrangement.
	 */
	goals: ProjectGoal[];
	/** IDs formerly owned by deleted goals. Reserved permanently, but not resolvable. */
	retiredIds?: string[];
}

export interface RevisionedProjectWorklist extends ProjectWorklist {
	revision: number;
}

export interface WorklistOperationResult {
	scope: "session" | "project";
	action: string;
	task?: SessionTask;
	tasks?: SessionTask[];
	goal?: ProjectGoal;
	goals?: ProjectGoal[];
	/** Whether the shown goal is blocked, derived from its current dependency edges. */
	blocked?: boolean;
	/** Goal IDs the shown goal blocks, derived from other goals' forward edges. */
	blocks?: string[];
	/** Goal IDs reserved by deletions and excluded from resolution. */
	retiredIds?: string[];
	/** Project Goal ID rewrites, applied or planned, from an ID migration. */
	migrations?: GoalIdMigration[];
	/**
	 * Unsatisfied dependencies of the goal that was just activated.
	 *
	 * Advisory rather than a refusal: blocked is a derived reading of the graph,
	 * and someone who says a goal is the one in flight knows something the edges
	 * do not. Present only when the activation left a goal blocked.
	 */
	blockedBy?: string[];
}

export type WorklistToolDetails = WorklistOperationResult;

export const SESSION_SNAPSHOT_VERSION = 3;
export const READABLE_SESSION_SNAPSHOT_VERSIONS: readonly number[] = [1, 2, 3];
export const PROJECT_WORKLIST_VERSION = 1;
