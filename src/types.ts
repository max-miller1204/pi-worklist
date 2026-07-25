import type {
	ProjectGoalDetailProjection,
	ReconciledSessionTaskProjection,
	SessionTaskSummaryProjection,
	WorklistProjectionPage,
} from "./integration-contract.ts";
import type { ManagedSessionTaskProjection } from "./managed-projection.ts";

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

export interface StoredSessionTask extends SessionTask {
	/** Hidden orchestrator-owned metadata that ordinary Session Task reads must omit. */
	managed?: ManagedSessionTaskProjection;
}

interface SessionExternalMutationRecordBase {
	idempotencyKey: string;
	fingerprint: string;
	tasks: ReconciledSessionTaskProjection[];
}

export interface SessionProjectionBatchRecord extends SessionExternalMutationRecordBase {
	/** Absent in records persisted before execution updates existed. */
	operation?: "session-tasks.reconcile";
	goalId: string;
}

export interface SessionExecutionUpdateRecord extends SessionExternalMutationRecordBase {
	operation: "session-tasks.update-execution";
	goalId?: never;
}

export type SessionProjectionReconciliationRecord =
	| SessionProjectionBatchRecord
	| SessionExecutionUpdateRecord;

export interface SessionSnapshot {
	version: number;
	/** Opaque branch-aware concurrency token. Legacy snapshots derive this from their entry ID. */
	revision?: string;
	tasks: StoredSessionTask[];
	/**
	 * Replay records for committed managed projection mutations, bounded to the most
	 * recent MAX_PROJECTION_RECONCILIATION_RECORDS entries in mutation order.
	 */
	projectionReconciliations?: SessionProjectionReconciliationRecord[];
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
	reconciliation?: { tasks: ReconciledSessionTaskProjection[] };
	taskProjections?: { tasks: SessionTaskSummaryProjection[]; page: WorklistProjectionPage };
	goalProjection?: ProjectGoalDetailProjection | null;
}

export type WorklistToolDetails = WorklistOperationResult;

export const MANAGED_SESSION_TASK_SNAPSHOT_VERSION = 3;
export const SESSION_SNAPSHOT_VERSION = MANAGED_SESSION_TASK_SNAPSHOT_VERSION;
export const READABLE_SESSION_SNAPSHOT_VERSIONS: readonly number[] = [1, 2, 3];
export const PROJECT_WORKLIST_VERSION = 1;
