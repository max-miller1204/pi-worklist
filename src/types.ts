export type SessionTaskStatus = "todo" | "doing" | "done";
export type ProjectGoalStatus = "open" | "active" | "done" | "archived";

export interface SessionTask {
	id: string;
	title: string;
	status: SessionTaskStatus;
	goalId?: string;
}

export type SessionTaskPlacement =
	| { beforeId: string; afterId?: never }
	| { beforeId?: never; afterId: string };

export interface ProjectGoal {
	id: string;
	title: string;
	description?: string;
	status: ProjectGoalStatus;
	createdAt: string;
	updatedAt: string;
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
	goals: ProjectGoal[];
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
	/** Project Goal ID rewrites, applied or planned, from an ID migration. */
	migrations?: GoalIdMigration[];
}

export type WorklistToolDetails = WorklistOperationResult;

export const SESSION_SNAPSHOT_VERSION = 3;
export const READABLE_SESSION_SNAPSHOT_VERSIONS: readonly number[] = [1, 2, 3];
export const PROJECT_WORKLIST_VERSION = 1;
