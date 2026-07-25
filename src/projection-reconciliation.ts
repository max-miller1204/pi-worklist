import { createHash } from "node:crypto";
import type {
	ManagedExecutionUpdate,
	ManagedSessionTaskInput,
	ReconciledSessionTaskProjection,
} from "./integration-contract.ts";
import {
	MANAGED_SESSION_TASK_PROJECTION_VERSION,
	type ManagedExecutionProjection,
} from "./managed-projection.ts";
import type { SessionProjectionReconciliationRecord, StoredSessionTask } from "./types.ts";

const RECONCILIATION_ACTIONS = [
	"created",
	"updated",
	"unchanged",
	"removed",
	"preserved-user-override",
] as const;

export interface ManagedProjectionReconciliationPlan {
	tasks: ReconciledSessionTaskProjection[];
	nextTasks: StoredSessionTask[];
	changed: boolean;
}

export interface ManagedProjectionReconciliationInput {
	currentTasks: StoredSessionTask[];
	goalId: string;
	desiredTasks: ManagedSessionTaskInput[];
	now: string;
	createTaskId: () => string;
}

function normalizeReconciledTask(value: unknown): ReconciledSessionTaskProjection | undefined {
	if (typeof value !== "object" || value === null || Array.isArray(value)) return undefined;
	const task = value as Record<string, unknown>;
	const external = task.external as Record<string, unknown> | undefined;
	if (
		external?.system !== "pi-orchestrator" ||
		external.kind !== "workflow-step" ||
		typeof external.id !== "string" ||
		!external.id ||
		typeof task.taskId !== "string" ||
		!task.taskId ||
		!RECONCILIATION_ACTIONS.includes(task.action as (typeof RECONCILIATION_ACTIONS)[number])
	) {
		return undefined;
	}
	return {
		external: {
			system: "pi-orchestrator",
			kind: "workflow-step",
			id: external.id,
		},
		taskId: task.taskId,
		action: task.action as ReconciledSessionTaskProjection["action"],
	};
}

export function normalizeProjectionReconciliationRecord(
	value: unknown,
): SessionProjectionReconciliationRecord | undefined {
	if (typeof value !== "object" || value === null || Array.isArray(value)) return undefined;
	const record = value as Record<string, unknown>;
	if (typeof record.idempotencyKey !== "string" || !record.idempotencyKey) return undefined;
	if (typeof record.fingerprint !== "string" || !record.fingerprint) return undefined;
	if (!Array.isArray(record.tasks)) return undefined;
	const tasks: ReconciledSessionTaskProjection[] = [];
	for (const valueTask of record.tasks) {
		const task = normalizeReconciledTask(valueTask);
		if (!task) return undefined;
		tasks.push(task);
	}
	if (record.operation === "session-tasks.update-execution") {
		return {
			idempotencyKey: record.idempotencyKey,
			fingerprint: record.fingerprint,
			operation: record.operation,
			tasks,
		};
	}
	if (record.operation !== undefined && record.operation !== "session-tasks.reconcile") return undefined;
	if (typeof record.goalId !== "string" || !record.goalId) return undefined;
	return {
		idempotencyKey: record.idempotencyKey,
		fingerprint: record.fingerprint,
		...(record.operation === "session-tasks.reconcile" ? { operation: record.operation } : {}),
		goalId: record.goalId,
		tasks,
	};
}

function canonicalExternal(input: ManagedSessionTaskInput) {
	return {
		system: "pi-orchestrator" as const,
		kind: "workflow-step" as const,
		id: input.external.id,
	};
}

function canonicalExecution(execution: ManagedExecutionProjection): ManagedExecutionProjection {
	return {
		state: execution.state,
		updatedAt: execution.updatedAt,
		runId: execution.runId,
		...(execution.summary !== undefined ? { summary: execution.summary } : {}),
		...(execution.runReference !== undefined ? { runReference: execution.runReference } : {}),
	};
}

export function projectionReconciliationFingerprint(
	goalId: string,
	tasks: ManagedSessionTaskInput[],
): string {
	const semanticInput = {
		goalId,
		tasks: tasks.map((task) => ({
			external: canonicalExternal(task),
			title: task.title,
			status: task.status,
			producer: { id: "pi-orchestrator", version: task.producer.version },
			planRevision: task.planRevision,
			approvedPlanRevision: task.approvedPlanRevision,
			execution: canonicalExecution(task.execution),
			...(task.resultReference !== undefined ? { resultReference: task.resultReference } : {}),
			...(task.sessionContributionReference !== undefined
				? { sessionContributionReference: task.sessionContributionReference }
				: {}),
		})),
	};
	return createHash("sha256").update(JSON.stringify(semanticInput)).digest("hex");
}

export function projectionIdempotencyKeyConflictError(idempotencyKey: string): Error & {
	idempotencyKey: string;
} {
	return Object.assign(
		new Error(`Session projection idempotency key ${idempotencyKey} was reused for different input.`),
		{ name: "SessionIdempotencyKeyConflictError", idempotencyKey },
	);
}

export function projectionGoalConflictError(
	externalId: string,
	taskId: string,
	existingGoalId: string,
	requestedGoalId: string,
): Error & {
	externalId: string;
	taskId: string;
	existingGoalId: string;
	requestedGoalId: string;
} {
	return Object.assign(
		new Error(
			`Managed projection ${externalId} belongs to Project Goal ${existingGoalId}, not ${requestedGoalId}.`,
		),
		{
			name: "SessionProjectionGoalConflictError",
			externalId,
			taskId,
			existingGoalId,
			requestedGoalId,
		},
	);
}

function managedProjectionForInput(input: ManagedSessionTaskInput, createdAt: string, updatedAt: string) {
	return {
		version: MANAGED_SESSION_TASK_PROJECTION_VERSION,
		owner: "pi-orchestrator" as const,
		producer: { id: "pi-orchestrator" as const, version: input.producer.version },
		external: canonicalExternal(input),
		planRevision: input.planRevision,
		approvedPlanRevision: input.approvedPlanRevision,
		createdAt,
		updatedAt,
		execution: canonicalExecution(input.execution),
		...(input.resultReference !== undefined ? { resultReference: input.resultReference } : {}),
		...(input.sessionContributionReference !== undefined
			? { sessionContributionReference: input.sessionContributionReference }
			: {}),
	};
}

function tasksAreEqual(left: StoredSessionTask, right: StoredSessionTask): boolean {
	return JSON.stringify(left) === JSON.stringify(right);
}

interface ExistingTaskReconciliation {
	nextTask?: StoredSessionTask;
	outcome?: ReconciledSessionTaskProjection;
	removed?: ReconciledSessionTaskProjection;
	matchedExternalId?: string;
	changed: boolean;
}

interface ExistingTaskReconciliationInput {
	current: StoredSessionTask;
	goalId: string;
	desiredByExternalId: ReadonlyMap<string, ManagedSessionTaskInput>;
	matched: ReadonlySet<string>;
	now: string;
}

function reconcileExistingTask({
	current,
	goalId,
	desiredByExternalId,
	matched,
	now,
}: ExistingTaskReconciliationInput): ExistingTaskReconciliation {
	const externalId = current.managed?.external.id;
	const desired = externalId === undefined ? undefined : desiredByExternalId.get(externalId);
	if (externalId !== undefined && desired && !matched.has(externalId)) {
		const unchangedCandidate: StoredSessionTask = {
			id: current.id,
			title: desired.title,
			status: desired.status,
			goalId,
			managed: managedProjectionForInput(
				desired,
				current.managed?.createdAt ?? now,
				current.managed?.updatedAt ?? now,
			),
		};
		const unchanged = tasksAreEqual(current, unchangedCandidate);
		return {
			nextTask: unchanged
				? unchangedCandidate
				: {
						...unchangedCandidate,
						managed: managedProjectionForInput(desired, current.managed?.createdAt ?? now, now),
					},
			outcome: {
				external: canonicalExternal(desired),
				taskId: current.id,
				action: unchanged ? "unchanged" : "updated",
			},
			matchedExternalId: externalId,
			changed: !unchanged,
		};
	}
	if (current.managed?.owner === "pi-orchestrator" && current.goalId === goalId) {
		return {
			removed: {
				external: current.managed.external,
				taskId: current.id,
				action: "removed",
			},
			changed: true,
		};
	}
	return { nextTask: current, changed: false };
}

export function assertRecordedIdentitiesBelongToGoal(
	records: SessionProjectionReconciliationRecord[],
	goalId: string,
	desiredTasks: ManagedSessionTaskInput[],
): void {
	const desiredIds = new Set(desiredTasks.map((task) => task.external.id));
	for (const record of records) {
		// Execution updates carry no goal ownership claim.
		if (record.goalId === undefined || record.goalId === goalId) continue;
		const conflict = record.tasks.find((task) => desiredIds.has(task.external.id));
		if (conflict) {
			throw projectionGoalConflictError(conflict.external.id, conflict.taskId, record.goalId, goalId);
		}
	}
}

function assertDesiredIdentitiesBelongToGoal(
	currentTasks: StoredSessionTask[],
	goalId: string,
	desiredByExternalId: ReadonlyMap<string, ManagedSessionTaskInput>,
): void {
	for (const current of currentTasks) {
		const externalId = current.managed?.external.id;
		if (
			externalId !== undefined &&
			desiredByExternalId.has(externalId) &&
			current.goalId !== undefined &&
			current.goalId !== goalId
		) {
			throw projectionGoalConflictError(externalId, current.id, current.goalId, goalId);
		}
	}
}

export function planManagedProjectionReconciliation({
	currentTasks,
	goalId,
	desiredTasks,
	now,
	createTaskId,
}: ManagedProjectionReconciliationInput): ManagedProjectionReconciliationPlan {
	const desiredByExternalId = new Map(desiredTasks.map((task) => [task.external.id, task] as const));
	assertDesiredIdentitiesBelongToGoal(currentTasks, goalId, desiredByExternalId);
	const outcomesByExternalId = new Map<string, ReconciledSessionTaskProjection>();
	const removed: ReconciledSessionTaskProjection[] = [];
	const matched = new Set<string>();
	let changed = false;
	const nextTasks: StoredSessionTask[] = [];

	for (const current of currentTasks) {
		const reconciliation = reconcileExistingTask({
			current,
			goalId,
			desiredByExternalId,
			matched,
			now,
		});
		if (reconciliation.nextTask) nextTasks.push(reconciliation.nextTask);
		if (reconciliation.removed) removed.push(reconciliation.removed);
		if (reconciliation.matchedExternalId) matched.add(reconciliation.matchedExternalId);
		if (reconciliation.outcome) {
			outcomesByExternalId.set(reconciliation.outcome.external.id, reconciliation.outcome);
		}
		if (reconciliation.changed) changed = true;
	}

	for (const desired of desiredTasks) {
		if (matched.has(desired.external.id)) continue;
		const id = createTaskId();
		nextTasks.push({
			id,
			title: desired.title,
			status: desired.status,
			goalId,
			managed: managedProjectionForInput(desired, now, now),
		});
		matched.add(desired.external.id);
		changed = true;
		outcomesByExternalId.set(desired.external.id, {
			external: canonicalExternal(desired),
			taskId: id,
			action: "created",
		});
	}

	const tasks = [
		...desiredTasks.flatMap((task) => {
			const outcome = outcomesByExternalId.get(task.external.id);
			return outcome === undefined ? [] : [outcome];
		}),
		...removed,
	];
	return { tasks, nextTasks, changed };
}

export function executionUpdateFingerprint(updates: ManagedExecutionUpdate[]): string {
	const semanticInput = {
		operation: "session-tasks.update-execution",
		updates: updates.map((update) => ({
			external: {
				system: "pi-orchestrator" as const,
				kind: "workflow-step" as const,
				id: update.external.id,
			},
			execution: canonicalExecution(update.execution),
		})),
	};
	return createHash("sha256").update(JSON.stringify(semanticInput)).digest("hex");
}

export function executionTargetNotFoundError(externalId: string): Error & { externalId: string } {
	return Object.assign(
		new Error(`No managed Session Task projection exists for workflow step ${externalId}.`),
		{ name: "SessionExecutionTargetNotFoundError", externalId },
	);
}

export interface ManagedExecutionUpdatePlan {
	tasks: ReconciledSessionTaskProjection[];
	nextTasks: StoredSessionTask[];
	/** Sorted distinct Project Goal IDs of the targeted managed projections. */
	goalIds: string[];
	changed: boolean;
}

export interface ManagedExecutionUpdateInput {
	currentTasks: StoredSessionTask[];
	updates: ManagedExecutionUpdate[];
	now: string;
}

/**
 * Applies lightweight execution-state updates to existing managed projections.
 *
 * Targets are resolved only by stable external workflow-step identity. The user-facing
 * todo, doing, and done lifecycle is deliberately untouched; reconciliation owns it.
 */
export function planManagedExecutionUpdate({
	currentTasks,
	updates,
	now,
}: ManagedExecutionUpdateInput): ManagedExecutionUpdatePlan {
	const updatesByExternalId = new Map(updates.map((update) => [update.external.id, update] as const));
	const outcomesByExternalId = new Map<string, ReconciledSessionTaskProjection>();
	const goalIds = new Set<string>();
	const nextTasks: StoredSessionTask[] = [];
	let changed = false;

	for (const current of currentTasks) {
		const externalId = current.managed?.external.id;
		const update =
			current.managed !== undefined && externalId !== undefined && !outcomesByExternalId.has(externalId)
				? updatesByExternalId.get(externalId)
				: undefined;
		if (current.managed === undefined || externalId === undefined || update === undefined) {
			nextTasks.push(current);
			continue;
		}
		if (current.goalId !== undefined) goalIds.add(current.goalId);
		const execution = canonicalExecution(update.execution);
		const unchanged = JSON.stringify(current.managed.execution) === JSON.stringify(execution);
		nextTasks.push(
			unchanged ? current : { ...current, managed: { ...current.managed, execution, updatedAt: now } },
		);
		if (!unchanged) changed = true;
		outcomesByExternalId.set(externalId, {
			external: { system: "pi-orchestrator", kind: "workflow-step", id: externalId },
			taskId: current.id,
			action: unchanged ? "unchanged" : "updated",
		});
	}

	const tasks = updates.map((update) => {
		const outcome = outcomesByExternalId.get(update.external.id);
		if (outcome === undefined) throw executionTargetNotFoundError(update.external.id);
		return outcome;
	});
	return { tasks, nextTasks, goalIds: [...goalIds].sort(), changed };
}
