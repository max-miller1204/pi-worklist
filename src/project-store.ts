import { randomBytes } from "node:crypto";
import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import lockfile from "proper-lockfile";
import type { ProjectGoal, ProjectWorklist, RevisionedProjectWorklist } from "./types.ts";
import { PROJECT_WORKLIST_VERSION } from "./types.ts";

export interface ProjectStoreResult<T> {
	data: T;
	revision?: number;
	error?: string;
	/** Present and false only when a successful mutation made no canonical change. */
	changed?: false;
}

export interface ProjectMutationOptions {
	expectedRevision?: string;
}

export type ProjectMutation<T> = (current: RevisionedProjectWorklist) => {
	worklist: RevisionedProjectWorklist;
	result: T;
	/** Set false when validation produced a result without a canonical state change. */
	changed?: boolean;
};

export class ProjectRevisionConflictError extends Error {
	readonly expectedRevision: string;
	readonly actualRevision: string;

	constructor(expectedRevision: string, actualRevision: string) {
		super(`Project worklist revision changed from ${expectedRevision} to ${actualRevision}.`);
		this.name = "ProjectRevisionConflictError";
		this.expectedRevision = expectedRevision;
		this.actualRevision = actualRevision;
	}
}

export function isProjectWorklist(value: unknown): value is ProjectWorklist {
	if (typeof value !== "object" || value === null) return false;
	const obj = value as Record<string, unknown>;
	if (obj.version !== PROJECT_WORKLIST_VERSION) return false;
	if (obj.revision !== undefined && (!Number.isSafeInteger(obj.revision) || Number(obj.revision) < 0)) {
		return false;
	}
	if (!Array.isArray(obj.goals)) return false;
	for (const g of obj.goals) {
		if (typeof g !== "object" || g === null) return false;
		const goal = g as Record<string, unknown>;
		if (typeof goal.id !== "string") return false;
		if (typeof goal.title !== "string") return false;
		if (goal.description !== undefined && typeof goal.description !== "string") return false;
		if (!["open", "active", "done", "archived"].includes(goal.status as string)) return false;
		if (typeof goal.createdAt !== "string") return false;
		if (typeof goal.updatedAt !== "string") return false;
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
		if (err instanceof ProjectRevisionConflictError) throw err;
		return {
			data: undefined as unknown as T,
			error: `Project mutation failed: ${String(err)}`,
		};
	} finally {
		if (tempName) await rm(tempName, { force: true });
		await release();
	}
}

export function sortGoals(goals: ProjectGoal[]): ProjectGoal[] {
	return [...goals].sort((a, b) => new Date(a.createdAt).getTime() - new Date(b.createdAt).getTime());
}

export function generateId(prefix?: string): string {
	return `${prefix ? `${prefix}-` : ""}${Date.now().toString(36)}-${randomBytes(4).toString("hex")}`;
}
