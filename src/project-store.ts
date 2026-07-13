import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { randomBytes } from "node:crypto";
import lockfile from "proper-lockfile";
import type { ProjectGoal, ProjectWorklist } from "./types.ts";
import { PROJECT_WORKLIST_VERSION } from "./types.ts";

export interface ProjectStoreResult<T> {
	data: T;
	error?: string;
}

export type ProjectMutation<T> = (current: ProjectWorklist) => {
	worklist: ProjectWorklist;
	result: T;
};

export function isProjectWorklist(value: unknown): value is ProjectWorklist {
	if (typeof value !== "object" || value === null) return false;
	const obj = value as Record<string, unknown>;
	if (obj.version !== PROJECT_WORKLIST_VERSION) return false;
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

export function createEmptyWorklist(): ProjectWorklist {
	return { version: PROJECT_WORKLIST_VERSION, goals: [] };
}

export async function readProjectWorklist(path: string): Promise<ProjectStoreResult<ProjectWorklist>> {
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
		return { data: parsed };
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

		const { worklist, result } = mutate(readResult.data);
		if (!isProjectWorklist(worklist)) {
			return {
				data: undefined as unknown as T,
				error: "Project mutation produced an invalid worklist",
			};
		}

		tempName = resolve(dir, `.worklist-${randomBytes(8).toString("hex")}.tmp`);
		await writeFile(tempName, `${JSON.stringify(worklist, null, 2)}\n`, "utf8");
		await rename(tempName, path);
		tempName = undefined;
		return { data: result };
	} catch (err) {
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
	return goals.slice().sort((a, b) => new Date(a.createdAt).getTime() - new Date(b.createdAt).getTime());
}

export function generateId(prefix?: string): string {
	return `${prefix ? `${prefix}-` : ""}${Date.now().toString(36)}-${randomBytes(4).toString("hex")}`;
}
