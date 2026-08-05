import { randomBytes } from "node:crypto";
import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import lockfile from "proper-lockfile";
import { findGoalByStoredId } from "./goal-selection.ts";
import type { ProjectWorklist, RevisionedProjectWorklist } from "./types.ts";
import { PROJECT_WORKLIST_VERSION } from "./types.ts";

export interface ProjectStoreResult<T> {
	data: T;
	revision?: number;
	error?: string;
	/** Present and false only when a successful mutation made no canonical change. */
	changed?: false;
}

/** The caller's baseline for one goal, as read from that goal's `updatedAt`. */
export interface ProjectGoalPrecondition {
	id: string;
	updatedAt: string;
}

export interface ProjectMutationOptions {
	expectedRevision?: string;
	expectedGoal?: ProjectGoalPrecondition;
}

export type ProjectMutation<T> = (current: RevisionedProjectWorklist) => {
	worklist: RevisionedProjectWorklist;
	result: T;
	/** Set false when validation produced a result without a canonical state change. */
	changed?: boolean;
};

/**
 * A mutation refused on its own terms, rather than one that failed to persist.
 *
 * `mutateProjectWorklist` turns an unexpected throw into a persistence error,
 * because a caller cannot act on a stack trace from the middle of a write. A
 * refusal is different: it is the answer, decided under the lock against
 * canonical state, so it is rethrown unchanged and keeps its type all the way to
 * the interface that has to explain it. Every deliberate rejection a mutation
 * raises must extend this, or it arrives as an unexplained persistence failure.
 */
export class ProjectMutationRefusedError extends Error {}

export class ProjectRevisionConflictError extends ProjectMutationRefusedError {
	readonly expectedRevision: string;
	readonly actualRevision: string;

	constructor(expectedRevision: string, actualRevision: string) {
		super(`Project worklist revision changed from ${expectedRevision} to ${actualRevision}.`);
		this.name = "ProjectRevisionConflictError";
		this.expectedRevision = expectedRevision;
		this.actualRevision = actualRevision;
	}
}

export class ProjectGoalConflictError extends ProjectMutationRefusedError {
	readonly goalId: string;
	readonly expectedUpdatedAt: string;
	readonly actualUpdatedAt: string;

	constructor(goalId: string, expectedUpdatedAt: string, actualUpdatedAt: string) {
		super(`Project goal ${goalId} changed from ${expectedUpdatedAt} to ${actualUpdatedAt}.`);
		this.name = "ProjectGoalConflictError";
		this.goalId = goalId;
		this.expectedUpdatedAt = expectedUpdatedAt;
		this.actualUpdatedAt = actualUpdatedAt;
	}
}

/**
 * Two timestamps naming the same instant, so a caller that echoes back a goal's
 * `updatedAt` in a different but equivalent ISO 8601 spelling is not told its
 * baseline moved. Unparseable values only match themselves, which fails closed.
 */
function isSameInstant(left: string, right: string): boolean {
	if (left === right) return true;
	const leftTime = Date.parse(left);
	return !Number.isNaN(leftTime) && leftTime === Date.parse(right);
}

/**
 * Rejects a mutation whose caller read the target goal before someone else
 * changed it.
 *
 * The whole-store revision cannot express this: it moves for every goal, so
 * guarding one goal with it rejects unrelated concurrent work, while guarding
 * nothing lets two readers of the same goal silently clobber each other. A goal
 * that no longer exists is left to the mutation itself, whose not-found is more
 * precise than a conflict about a timestamp nothing carries any more.
 */
function assertGoalPrecondition(
	worklist: RevisionedProjectWorklist,
	precondition: ProjectGoalPrecondition | undefined,
): void {
	if (!precondition) return;
	const target = findGoalByStoredId(worklist.goals, precondition.id, worklist.retiredIds ?? []);
	if (!target || isSameInstant(precondition.updatedAt, target.updatedAt)) return;
	throw new ProjectGoalConflictError(target.id, precondition.updatedAt, target.updatedAt);
}

function isStringArray(value: unknown): value is string[] {
	return Array.isArray(value) && value.every((entry) => typeof entry === "string");
}

/** Optional goal fields carrying a single string, validated the same way. */
const OPTIONAL_GOAL_STRING_FIELDS = ["description", "group", "completedAt", "branch"] as const;

/** Optional goal fields carrying a list of strings. */
const OPTIONAL_GOAL_STRING_ARRAY_FIELDS = ["links", "previousIds", "dependsOn"] as const;

export function isProjectWorklist(value: unknown): value is ProjectWorklist {
	if (typeof value !== "object" || value === null) return false;
	const obj = value as Record<string, unknown>;
	if (obj.version !== PROJECT_WORKLIST_VERSION) return false;
	if (obj.revision !== undefined && (!Number.isSafeInteger(obj.revision) || Number(obj.revision) < 0)) {
		return false;
	}
	if (obj.retiredIds !== undefined && !isStringArray(obj.retiredIds)) return false;
	if (!Array.isArray(obj.goals)) return false;
	for (const g of obj.goals) {
		if (typeof g !== "object" || g === null) return false;
		const goal = g as Record<string, unknown>;
		if (typeof goal.id !== "string") return false;
		if (typeof goal.title !== "string") return false;
		if (!["open", "active", "done", "archived"].includes(goal.status as string)) return false;
		if (typeof goal.createdAt !== "string") return false;
		if (typeof goal.updatedAt !== "string") return false;
		for (const field of OPTIONAL_GOAL_STRING_FIELDS) {
			if (goal[field] !== undefined && typeof goal[field] !== "string") return false;
		}
		for (const field of OPTIONAL_GOAL_STRING_ARRAY_FIELDS) {
			if (goal[field] !== undefined && !isStringArray(goal[field])) return false;
		}
	}
	return true;
}

function isRevisionedProjectWorklist(value: unknown): value is RevisionedProjectWorklist {
	return isProjectWorklist(value) && value.revision !== undefined;
}

export function createEmptyWorklist(): RevisionedProjectWorklist {
	return { version: PROJECT_WORKLIST_VERSION, revision: 0, goals: [] };
}

export async function readProjectWorklist(
	path: string,
): Promise<ProjectStoreResult<RevisionedProjectWorklist>> {
	try {
		const text = await readFile(path, "utf8");
		let parsed: unknown;
		try {
			parsed = JSON.parse(text);
		} catch {
			return {
				data: createEmptyWorklist(),
				error: `Malformed project file ${path}: invalid JSON`,
			};
		}
		if (!isProjectWorklist(parsed)) {
			return {
				data: createEmptyWorklist(),
				error: `Malformed or unsupported schema in ${path}. Fix the file manually; it will not be overwritten.`,
			};
		}
		return { data: { ...parsed, revision: parsed.revision ?? 0 } };
	} catch (err) {
		const code = (err as NodeJS.ErrnoException).code;
		if (code === "ENOENT") {
			return { data: createEmptyWorklist() };
		}
		return {
			data: createEmptyWorklist(),
			error: `Cannot read project file ${path}: ${String(err)}`,
		};
	}
}

export async function mutateProjectWorklist<T>(
	path: string,
	mutate: ProjectMutation<T>,
	options: ProjectMutationOptions = {},
): Promise<ProjectStoreResult<T>> {
	const dir = dirname(path);
	await mkdir(dir, { recursive: true });

	const release = await lockfile.lock(dir, {
		lockfilePath: resolve(dir, ".worklist.lock"),
		retries: { retries: 20, factor: 1.5, minTimeout: 10, maxTimeout: 250 },
		stale: 10000,
	});
	let tempName: string | undefined;

	try {
		const readResult = await readProjectWorklist(path);
		if (readResult.error) {
			return { data: undefined as unknown as T, error: readResult.error };
		}

		const actualRevision = String(readResult.data.revision);
		if (options.expectedRevision !== undefined && options.expectedRevision !== actualRevision) {
			throw new ProjectRevisionConflictError(options.expectedRevision, actualRevision);
		}
		assertGoalPrecondition(readResult.data, options.expectedGoal);

		const { worklist, result, changed = true } = mutate(readResult.data);
		if (!isRevisionedProjectWorklist(worklist)) {
			return {
				data: undefined as unknown as T,
				error: "Project mutation produced an invalid worklist",
			};
		}
		if (!changed) return { data: result, revision: readResult.data.revision, changed: false };

		const revision = readResult.data.revision + 1;
		if (!Number.isSafeInteger(revision)) {
			return {
				data: undefined as unknown as T,
				error: "Project worklist revision cannot be incremented safely",
			};
		}
		const revisedWorklist = { ...worklist, revision };

		tempName = resolve(dir, `.worklist-${randomBytes(8).toString("hex")}.tmp`);
		await writeFile(tempName, `${JSON.stringify(revisedWorklist, null, 2)}\n`, "utf8");
		await rename(tempName, path);
		tempName = undefined;
		return { data: result, revision };
	} catch (err) {
		if (err instanceof ProjectMutationRefusedError) throw err;
		return {
			data: undefined as unknown as T,
			error: `Project mutation failed: ${String(err)}`,
		};
	} finally {
		if (tempName) await rm(tempName, { force: true });
		await release();
	}
}
