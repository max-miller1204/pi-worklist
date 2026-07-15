export type SessionTaskStatus = "todo" | "doing" | "done";
export type ProjectGoalStatus = "open" | "active" | "done" | "archived";

export interface SessionTask {
	id: string;
	title: string;
	status: SessionTaskStatus;
	goalId?: string;
}

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

export interface WorklistToolDetails {
	scope: "session" | "project";
	action: string;
	tasks?: SessionTask[];
	goals?: ProjectGoal[];
	error?: string;
	requiresConfirm?: boolean;
}

export const SESSION_SNAPSHOT_VERSION = 2;
export const PROJECT_WORKLIST_VERSION = 1;
