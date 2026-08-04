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
}

export type WorklistToolDetails = WorklistOperationResult;

export const SESSION_SNAPSHOT_VERSION = 3;
export const READABLE_SESSION_SNAPSHOT_VERSIONS: readonly number[] = [1, 2, 3];
export const PROJECT_WORKLIST_VERSION = 1;
