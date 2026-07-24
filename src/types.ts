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
	tasks: SessionTask[];
}

export interface ProjectWorklist {
	version: number;
	goals: ProjectGoal[];
}

export interface WorklistOperationResult {
	scope: "session" | "project";
	action: string;
	task?: SessionTask;
	tasks?: SessionTask[];
	goal?: ProjectGoal;
	goals?: ProjectGoal[];
	error?: string;
	requiresConfirm?: boolean;
}

export type WorklistToolDetails = WorklistOperationResult;

export const SESSION_SNAPSHOT_VERSION = 2;
export const READABLE_SESSION_SNAPSHOT_VERSIONS: readonly number[] = [1, 2];
export const PROJECT_WORKLIST_VERSION = 1;
