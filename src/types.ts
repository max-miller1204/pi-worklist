import type {
	ProjectGoalDetailProjection,
	ReconciledSessionTaskProjection,
	SessionTaskSummaryProjection,
	WorklistProjectionPage,
} from "./integration-contract.ts";
import type {
	ExternalWorkflowStepIdentity,
	ExternalWorkItemIdentity,
	ManagedSessionTaskProjection,
} from "./managed-projection.ts";

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

/**
 * Records a managed projection the user deleted manually.
 * Reconciliation must not silently recreate the projection while its tombstone
 * exists; the tombstone clears once the producer stops projecting the step.
 */
export interface ManagedOverrideTombstone {
	external: ExternalWorkflowStepIdentity;
	taskId: string;
	goalId: string;
	overriddenAt: string;
}

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
	/** Bounded markers for manually deleted managed projections. */
	managedOverrideTombstones?: ManagedOverrideTombstone[];
}

/**
 * Replay record for a committed external Project Goal mutation.
 * Persisted in `.pi/worklist.json` so approved batch creation stays idempotent
 * across process restarts, bounded to the most recent records.
 */
export interface ProjectExternalMutationRecord {
	idempotencyKey: string;
	fingerprint: string;
	operation: "project-goals.create-approved-batch";
	approvalId: string;
	createdGoals: Array<{ external: ExternalWorkItemIdentity; goalId: string }>;
}

export interface ProjectWorklist {
	version: number;
	/** Absent only in legacy version 1 files, which readers normalize to revision 0. */
	revision?: number;
	goals: ProjectGoal[];
	/** Bounded replay records for committed external mutations. */
	externalMutations?: ProjectExternalMutationRecord[];
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
	approvedBatch?: Array<{ external: ExternalWorkItemIdentity; goal: ProjectGoalDetailProjection }>;
}

export type WorklistToolDetails = WorklistOperationResult;

export const MANAGED_SESSION_TASK_SNAPSHOT_VERSION = 3;
export const SESSION_SNAPSHOT_VERSION = MANAGED_SESSION_TASK_SNAPSHOT_VERSION;
export const READABLE_SESSION_SNAPSHOT_VERSIONS: readonly number[] = [1, 2, 3];
export const PROJECT_WORKLIST_VERSION = 1;
