import { randomBytes } from "node:crypto";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import type {
	ManagedExecutionUpdate,
	ManagedSessionTaskInput,
	ReconciledSessionTaskProjection,
} from "./integration-contract.ts";
import {
	type ManagedOverridableField,
	normalizeManagedSessionTaskProjection,
	withManagedUserOverride,
} from "./managed-projection.ts";
import {
	assertRecordedIdentitiesBelongToGoal,
	boundManagedOverrideTombstones,
	boundProjectionReconciliationRecords,
	executionUpdateFingerprint,
	normalizeManagedOverrideTombstone,
	normalizeProjectionReconciliationRecord,
	planManagedExecutionUpdate,
	planManagedProjectionReconciliation,
	projectionIdempotencyKeyConflictError,
	projectionReconciliationFingerprint,
} from "./projection-reconciliation.ts";
import type {
	ManagedOverrideTombstone,
	SessionProjectionReconciliationRecord,
	SessionSnapshot,
	SessionTask,
	SessionTaskPlacement,
	SessionTaskStatus,
	StoredSessionTask,
} from "./types.ts";
import {
	MANAGED_SESSION_TASK_SNAPSHOT_VERSION,
	READABLE_SESSION_SNAPSHOT_VERSIONS,
	SESSION_SNAPSHOT_VERSION,
} from "./types.ts";

export const SESSION_SNAPSHOT_TYPE = "worklist-session-snapshot";
export const SESSION_RECONCILIATION_RECEIPT_TYPE = "worklist-session-reconciliation-receipt";

const SESSION_TASK_STATUSES: readonly SessionTaskStatus[] = ["todo", "doing", "done"];

export class SessionTaskAnchorNotFoundError extends Error {
	readonly anchorId: string;

	constructor(anchorId: string) {
		super(`Session task anchor ${anchorId} not found`);
		this.name = "SessionTaskAnchorNotFoundError";
		this.anchorId = anchorId;
	}
}

export interface SessionMutationOptions {
	expectedRevision?: string;
}

export interface SessionMutationOutcome<T> {
	result: T;
	changed: boolean;
	revision: string;
	/** True when the mutation diverged from an orchestrator-managed projection. */
	overrode?: boolean;
}

export interface ManagedTaskReconciliationOutcome {
	tasks: ReconciledSessionTaskProjection[];
	changed: boolean;
	revision: string;
}

export class SessionRevisionConflictError extends Error {
	readonly expectedRevision: string;
	readonly actualRevision: string;

	constructor(expectedRevision: string, actualRevision: string) {
		super(`Session task revision changed from ${expectedRevision} to ${actualRevision}.`);
		this.name = "SessionRevisionConflictError";
		this.expectedRevision = expectedRevision;
		this.actualRevision = actualRevision;
	}
}

function isValidSessionTask(value: unknown): value is SessionTask {
	if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
	const task = value as Record<string, unknown>;
	if (typeof task.id !== "string") return false;
	if (typeof task.title !== "string") return false;
	if (!SESSION_TASK_STATUSES.includes(task.status as SessionTaskStatus)) return false;
	if (task.goalId !== undefined && typeof task.goalId !== "string") return false;
	return true;
}

function toPublicSessionTask(task: StoredSessionTask): SessionTask {
	const { id, title, status, goalId } = task;
	return { id, title, status, ...(goalId !== undefined ? { goalId } : {}) };
}

function normalizeStoredSessionTask(value: unknown, readManaged: boolean): StoredSessionTask | undefined {
	if (!isValidSessionTask(value)) return undefined;
	const task = toPublicSessionTask(value);
	if (!readManaged) return task;
	const managed = normalizeManagedSessionTaskProjection(
		(value as unknown as Record<string, unknown>).managed,
	);
	return {
		...task,
		...(managed !== undefined && task.goalId !== undefined && task.goalId.length > 0 ? { managed } : {}),
	};
}

function createSessionTaskId(): string {
	return `st-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`;
}

function upsertReconciliationRecord(
	records: SessionProjectionReconciliationRecord[],
	record: SessionProjectionReconciliationRecord,
): SessionProjectionReconciliationRecord[] {
	return boundProjectionReconciliationRecords([
		...records.filter((candidate) => candidate.idempotencyKey !== record.idempotencyKey),
		record,
	]);
}

export class SessionStore {
	private readonly pi: ExtensionAPI;
	private tasks: StoredSessionTask[] = [];
	private revision = "0";
	private projectionReconciliations: SessionProjectionReconciliationRecord[] = [];
	private managedOverrideTombstones: ManagedOverrideTombstone[] = [];
	private mutationQueue: Promise<unknown> = Promise.resolve();

	// A plain assignment keeps this module loadable under Node's strip-only TypeScript mode.
	constructor(pi: ExtensionAPI) {
		this.pi = pi;
	}

	getTasks(): SessionTask[] {
		return this.tasks.map(toPublicSessionTask);
	}

	/**
	 * Protocol-facing read that retains managed metadata for bounded projections.
	 * Ordinary Session Task reads must keep using getTasks, which omits it.
	 */
	getStoredTasks(): StoredSessionTask[] {
		return this.tasks.map((task) => ({
			...toPublicSessionTask(task),
			...(task.managed !== undefined ? { managed: structuredClone(task.managed) } : {}),
		}));
	}

	getRevision(): string {
		return this.revision;
	}

	setTasks(tasks: SessionTask[]): void {
		this.tasks = tasks.map(toPublicSessionTask);
	}

	reconstruct(ctx: ExtensionContext): void {
		this.tasks = [];
		this.revision = "0";
		this.projectionReconciliations = [];
		this.managedOverrideTombstones = [];
		const branch = ctx.sessionManager.getBranch();
		for (const entry of branch) {
			if (entry.type !== "custom") continue;
			if (entry.customType === SESSION_RECONCILIATION_RECEIPT_TYPE) {
				const record = normalizeProjectionReconciliationRecord(entry.data);
				if (record) {
					this.projectionReconciliations = upsertReconciliationRecord(this.projectionReconciliations, record);
				}
				continue;
			}
			if (entry.customType !== SESSION_SNAPSHOT_TYPE) continue;
			const data = entry.data as SessionSnapshot | undefined;
			if (data && READABLE_SESSION_SNAPSHOT_VERSIONS.includes(data.version) && Array.isArray(data.tasks)) {
				this.tasks = data.tasks.flatMap((task) => {
					const normalized = normalizeStoredSessionTask(
						task,
						data.version >= MANAGED_SESSION_TASK_SNAPSHOT_VERSION,
					);
					return normalized === undefined ? [] : [normalized];
				});
				this.projectionReconciliations = [];
				if (Array.isArray(data.projectionReconciliations)) {
					for (const record of data.projectionReconciliations) {
						const normalized = normalizeProjectionReconciliationRecord(record);
						if (normalized !== undefined) this.projectionReconciliations.push(normalized);
					}
				}
				this.managedOverrideTombstones = [];
				if (Array.isArray(data.managedOverrideTombstones)) {
					for (const tombstone of data.managedOverrideTombstones) {
						const normalized = normalizeManagedOverrideTombstone(tombstone);
						if (normalized !== undefined) this.managedOverrideTombstones.push(normalized);
					}
				}
				this.revision = "0";
				if (typeof data.revision === "string" && data.revision.length > 0) {
					this.revision = data.revision;
				} else if (typeof entry.id === "string" && entry.id.length > 0) {
					this.revision = entry.id;
				}
			}
		}
		this.projectionReconciliations = boundProjectionReconciliationRecords(this.projectionReconciliations);
		this.managedOverrideTombstones = boundManagedOverrideTombstones(this.managedOverrideTombstones);
	}

	private serialized<T>(fn: () => T | Promise<T>): Promise<T> {
		const next = this.mutationQueue.then(fn);
		this.mutationQueue = next.catch(() => undefined);
		return next;
	}

	private assertExpectedRevision(options: SessionMutationOptions): void {
		if (options.expectedRevision !== undefined && options.expectedRevision !== this.revision) {
			throw new SessionRevisionConflictError(options.expectedRevision, this.revision);
		}
	}

	addTask(
		title: string,
		goalId?: string,
		placement?: SessionTaskPlacement,
		options: SessionMutationOptions = {},
	): Promise<SessionMutationOutcome<SessionTask>> {
		return this.serialized(() => {
			this.assertExpectedRevision(options);
			let insertionIndex = this.tasks.length;
			if (placement) {
				const anchorId = placement.beforeId ?? placement.afterId;
				const anchorIndex = this.tasks.findIndex((task) => task.id === anchorId);
				if (anchorIndex === -1) throw new SessionTaskAnchorNotFoundError(anchorId);
				insertionIndex = placement.beforeId !== undefined ? anchorIndex : anchorIndex + 1;
			}
			const id = createSessionTaskId();
			const task: SessionTask = {
				id,
				title,
				status: "todo",
				...(goalId !== undefined ? { goalId } : {}),
			};
			const revision = this.persist([
				...this.tasks.slice(0, insertionIndex),
				task,
				...this.tasks.slice(insertionIndex),
			]);
			return { result: task, changed: true, revision };
		});
	}

	moveTask(
		id: string,
		placement: SessionTaskPlacement,
		options: SessionMutationOptions = {},
	): Promise<SessionMutationOutcome<SessionTask | null>> {
		return this.serialized(() => {
			this.assertExpectedRevision(options);
			const sourceIndex = this.tasks.findIndex((task) => task.id === id);
			if (sourceIndex === -1) return { result: null, changed: false, revision: this.revision };
			const task = this.tasks[sourceIndex];
			const anchorId = placement.beforeId ?? placement.afterId;
			if (anchorId === id) {
				return { result: toPublicSessionTask(task), changed: false, revision: this.revision };
			}

			const remaining = [...this.tasks.slice(0, sourceIndex), ...this.tasks.slice(sourceIndex + 1)];
			const anchorIndex = remaining.findIndex((candidate) => candidate.id === anchorId);
			if (anchorIndex === -1) throw new SessionTaskAnchorNotFoundError(anchorId);
			const insertionIndex = placement.beforeId !== undefined ? anchorIndex : anchorIndex + 1;
			const next = [...remaining.slice(0, insertionIndex), task, ...remaining.slice(insertionIndex)];
			if (next.every((candidate, index) => candidate.id === this.tasks[index]?.id)) {
				return { result: toPublicSessionTask(task), changed: false, revision: this.revision };
			}
			const revision = this.persist(next);
			return { result: toPublicSessionTask(task), changed: true, revision };
		});
	}

	updateTask(
		id: string,
		updates: Partial<Pick<SessionTask, "title" | "goalId">>,
		options: SessionMutationOptions = {},
	): Promise<SessionMutationOutcome<SessionTask | null>> {
		return this.serialized(() => {
			this.assertExpectedRevision(options);
			const index = this.tasks.findIndex((task) => task.id === id);
			if (index === -1) return { result: null, changed: false, revision: this.revision };
			const current = this.tasks[index];
			const updated = { ...current, ...updates };
			if (updated.title === current.title && updated.goalId === current.goalId) {
				return { result: toPublicSessionTask(current), changed: false, revision: this.revision };
			}
			const overriddenFields: ManagedOverridableField[] = [
				...(updated.title !== current.title ? (["title"] as const) : []),
				...(updated.goalId !== current.goalId ? (["goalId"] as const) : []),
			];
			const next = this.markUserOverride(updated, current, overriddenFields);
			const revision = this.persist([...this.tasks.slice(0, index), next, ...this.tasks.slice(index + 1)]);
			return {
				result: toPublicSessionTask(next),
				changed: true,
				revision,
				...(current.managed !== undefined ? { overrode: true } : {}),
			};
		});
	}

	setTaskStatus(
		id: string,
		status: SessionTaskStatus,
		options: SessionMutationOptions = {},
	): Promise<SessionMutationOutcome<SessionTask | null>> {
		return this.serialized(() => {
			this.assertExpectedRevision(options);
			const index = this.tasks.findIndex((task) => task.id === id);
			if (index === -1) return { result: null, changed: false, revision: this.revision };
			const current = this.tasks[index];
			if (current.status === status) {
				return { result: toPublicSessionTask(current), changed: false, revision: this.revision };
			}
			const next = this.markUserOverride({ ...current, status }, current, ["status"]);
			const revision = this.persist([...this.tasks.slice(0, index), next, ...this.tasks.slice(index + 1)]);
			return {
				result: toPublicSessionTask(next),
				changed: true,
				revision,
				...(current.managed !== undefined ? { overrode: true } : {}),
			};
		});
	}

	deleteTask(id: string, options: SessionMutationOptions = {}): Promise<SessionMutationOutcome<boolean>> {
		return this.serialized(() => {
			this.assertExpectedRevision(options);
			const removedTask = this.tasks.find((task) => task.id === id);
			const tasks = this.tasks.filter((task) => task.id !== id);
			if (removedTask === undefined || tasks.length === this.tasks.length) {
				return { result: false, changed: false, revision: this.revision };
			}
			const managed = removedTask.managed;
			let tombstones = this.managedOverrideTombstones;
			if (managed !== undefined && removedTask.goalId !== undefined) {
				tombstones = boundManagedOverrideTombstones([
					...tombstones.filter((tombstone) => tombstone.external.id !== managed.external.id),
					{
						external: managed.external,
						taskId: removedTask.id,
						goalId: removedTask.goalId,
						overriddenAt: new Date().toISOString(),
					},
				]);
			}
			const revision = this.persist(tasks, this.projectionReconciliations, tombstones);
			return {
				result: true,
				changed: true,
				revision,
				...(managed !== undefined ? { overrode: true } : {}),
			};
		});
	}

	private markUserOverride(
		updated: StoredSessionTask,
		current: StoredSessionTask,
		fields: ManagedOverridableField[],
	): StoredSessionTask {
		if (current.managed === undefined || fields.length === 0) return updated;
		return {
			...updated,
			managed: withManagedUserOverride(current.managed, fields, new Date().toISOString()),
		};
	}

	getManagedTaskReconciliationReplay(
		goalId: string,
		desiredTasks: ManagedSessionTaskInput[],
		idempotencyKey: string,
	): ManagedTaskReconciliationOutcome | undefined {
		const record = this.projectionReconciliations.find(
			(candidate) => candidate.idempotencyKey === idempotencyKey,
		);
		if (!record) return undefined;
		if (record.fingerprint !== projectionReconciliationFingerprint(goalId, desiredTasks)) {
			throw projectionIdempotencyKeyConflictError(idempotencyKey);
		}
		return { tasks: record.tasks, changed: false, revision: this.revision };
	}

	reconcileManagedTasks(
		goalId: string,
		desiredTasks: ManagedSessionTaskInput[],
		idempotencyKey: string,
		options: SessionMutationOptions = {},
	): Promise<ManagedTaskReconciliationOutcome> {
		return this.serialized(() => {
			const replay = this.getManagedTaskReconciliationReplay(goalId, desiredTasks, idempotencyKey);
			if (replay) return replay;
			this.assertExpectedRevision(options);
			assertRecordedIdentitiesBelongToGoal(this.projectionReconciliations, goalId, desiredTasks);
			const { tasks, nextTasks, nextTombstones, changed } = planManagedProjectionReconciliation({
				currentTasks: this.tasks,
				goalId,
				desiredTasks,
				now: new Date().toISOString(),
				createTaskId: createSessionTaskId,
				tombstones: this.managedOverrideTombstones,
			});
			const record = {
				idempotencyKey,
				fingerprint: projectionReconciliationFingerprint(goalId, desiredTasks),
				goalId,
				tasks,
			};
			const projectionReconciliations = upsertReconciliationRecord(this.projectionReconciliations, record);
			if (!changed) {
				this.pi.appendEntry(SESSION_RECONCILIATION_RECEIPT_TYPE, record);
				this.projectionReconciliations = projectionReconciliations;
				return { tasks, changed: false, revision: this.revision };
			}
			return {
				tasks,
				changed: true,
				revision: this.persist(nextTasks, projectionReconciliations, nextTombstones),
			};
		});
	}

	getManagedExecutionUpdateReplay(
		updates: ManagedExecutionUpdate[],
		idempotencyKey: string,
	): ManagedTaskReconciliationOutcome | undefined {
		const record = this.projectionReconciliations.find(
			(candidate) => candidate.idempotencyKey === idempotencyKey,
		);
		if (!record) return undefined;
		if (record.fingerprint !== executionUpdateFingerprint(updates)) {
			throw projectionIdempotencyKeyConflictError(idempotencyKey);
		}
		return { tasks: record.tasks, changed: false, revision: this.revision };
	}

	/** Resolves the Project Goals behind the targeted managed projections without mutating state. */
	resolveManagedExecutionGoalIds(updates: ManagedExecutionUpdate[]): string[] {
		return planManagedExecutionUpdate({
			currentTasks: this.tasks,
			updates,
			now: "1970-01-01T00:00:00.000Z",
			tombstones: this.managedOverrideTombstones,
		}).goalIds;
	}

	updateManagedExecution(
		updates: ManagedExecutionUpdate[],
		idempotencyKey: string,
		options: SessionMutationOptions = {},
	): Promise<ManagedTaskReconciliationOutcome> {
		return this.serialized(() => {
			const replay = this.getManagedExecutionUpdateReplay(updates, idempotencyKey);
			if (replay) return replay;
			this.assertExpectedRevision(options);
			const { tasks, nextTasks, changed } = planManagedExecutionUpdate({
				currentTasks: this.tasks,
				updates,
				now: new Date().toISOString(),
				tombstones: this.managedOverrideTombstones,
			});
			const record = {
				idempotencyKey,
				fingerprint: executionUpdateFingerprint(updates),
				operation: "session-tasks.update-execution" as const,
				tasks,
			};
			const projectionReconciliations = upsertReconciliationRecord(this.projectionReconciliations, record);
			if (!changed) {
				this.pi.appendEntry(SESSION_RECONCILIATION_RECEIPT_TYPE, record);
				this.projectionReconciliations = projectionReconciliations;
				return { tasks, changed: false, revision: this.revision };
			}
			return {
				tasks,
				changed: true,
				revision: this.persist(nextTasks, projectionReconciliations),
			};
		});
	}

	private persist(
		tasks: StoredSessionTask[],
		projectionReconciliations = this.projectionReconciliations,
		managedOverrideTombstones = this.managedOverrideTombstones,
	): string {
		const revision = randomBytes(16).toString("hex");
		this.pi.appendEntry(SESSION_SNAPSHOT_TYPE, {
			version: SESSION_SNAPSHOT_VERSION,
			revision,
			tasks: [...tasks],
			...(projectionReconciliations.length > 0
				? { projectionReconciliations: [...projectionReconciliations] }
				: {}),
			...(managedOverrideTombstones.length > 0
				? { managedOverrideTombstones: [...managedOverrideTombstones] }
				: {}),
		});
		this.tasks = tasks;
		this.projectionReconciliations = projectionReconciliations;
		this.managedOverrideTombstones = managedOverrideTombstones;
		this.revision = revision;
		return revision;
	}
}
