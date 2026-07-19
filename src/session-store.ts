import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { SessionSnapshot, SessionTask, SessionTaskPlacement, SessionTaskStatus } from "./types.ts";
import { READABLE_SESSION_SNAPSHOT_VERSIONS, SESSION_SNAPSHOT_VERSION } from "./types.ts";

export const SESSION_SNAPSHOT_TYPE = "worklist-session-snapshot";

const SESSION_TASK_STATUSES: readonly SessionTaskStatus[] = ["todo", "doing", "done"];

function isValidSessionTask(value: unknown): value is SessionTask {
	if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
	const task = value as Record<string, unknown>;
	if (typeof task.id !== "string") return false;
	if (typeof task.title !== "string") return false;
	if (!SESSION_TASK_STATUSES.includes(task.status as SessionTaskStatus)) return false;
	if (task.goalId !== undefined && typeof task.goalId !== "string") return false;
	return true;
}

export class SessionStore {
	private tasks: SessionTask[] = [];
	private mutationQueue: Promise<unknown> = Promise.resolve();

	constructor(private readonly pi: ExtensionAPI) {}

	getTasks(): SessionTask[] {
		return this.tasks.slice();
	}

	setTasks(tasks: SessionTask[]): void {
		this.tasks = tasks.slice();
	}

	reconstruct(ctx: ExtensionContext): void {
		this.tasks = [];
		const branch = ctx.sessionManager.getBranch();
		for (const entry of branch) {
			if (entry.type !== "custom") continue;
			if (entry.customType !== SESSION_SNAPSHOT_TYPE) continue;
			const data = entry.data as SessionSnapshot | undefined;
			if (data && READABLE_SESSION_SNAPSHOT_VERSIONS.includes(data.version) && Array.isArray(data.tasks)) {
				this.tasks = data.tasks.filter(isValidSessionTask).map(({ id, title, status, goalId }) => ({
					id,
					title,
					status,
					...(goalId !== undefined ? { goalId } : {}),
				}));
			}
		}
	}

	private async serialized<T>(fn: () => Promise<T>): Promise<T> {
		const next = this.mutationQueue.then(fn);
		this.mutationQueue = next.catch(() => undefined);
		return next;
	}

	async addTask(title: string, goalId?: string, placement?: SessionTaskPlacement): Promise<SessionTask> {
		return this.serialized(async () => {
			let insertionIndex = this.tasks.length;
			if (placement) {
				const anchorId = placement.beforeId ?? placement.afterId;
				const anchorIndex = this.tasks.findIndex((task) => task.id === anchorId);
				if (anchorIndex === -1) throw new Error(`Session task anchor ${anchorId} not found`);
				insertionIndex = placement.beforeId !== undefined ? anchorIndex : anchorIndex + 1;
			}
			const id = `st-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`;
			const task: SessionTask = {
				id,
				title,
				status: "todo",
				...(goalId !== undefined ? { goalId } : {}),
			};
			this.tasks = [...this.tasks.slice(0, insertionIndex), task, ...this.tasks.slice(insertionIndex)];
			this.persist();
			return task;
		});
	}

	async moveTask(id: string, placement: SessionTaskPlacement): Promise<SessionTask | null> {
		return this.serialized(async () => {
			const sourceIndex = this.tasks.findIndex((task) => task.id === id);
			if (sourceIndex === -1) return null;
			const task = this.tasks[sourceIndex];
			const anchorId = placement.beforeId ?? placement.afterId;
			if (anchorId === id) return task;

			const remaining = [...this.tasks.slice(0, sourceIndex), ...this.tasks.slice(sourceIndex + 1)];
			const anchorIndex = remaining.findIndex((candidate) => candidate.id === anchorId);
			if (anchorIndex === -1) throw new Error(`Session task anchor ${anchorId} not found`);
			const insertionIndex = placement.beforeId !== undefined ? anchorIndex : anchorIndex + 1;
			const next = [...remaining.slice(0, insertionIndex), task, ...remaining.slice(insertionIndex)];
			if (next.every((candidate, index) => candidate.id === this.tasks[index]?.id)) return task;
			this.tasks = next;
			this.persist();
			return task;
		});
	}

	async updateTask(
		id: string,
		updates: Partial<Pick<SessionTask, "title" | "goalId">>,
	): Promise<SessionTask | null> {
		return this.serialized(async () => {
			const index = this.tasks.findIndex((t) => t.id === id);
			if (index === -1) return null;
			const updated = { ...this.tasks[index], ...updates };
			this.tasks = [...this.tasks.slice(0, index), updated, ...this.tasks.slice(index + 1)];
			this.persist();
			return updated;
		});
	}

	async setTaskStatus(id: string, status: SessionTaskStatus): Promise<SessionTask | null> {
		return this.serialized(async () => {
			const index = this.tasks.findIndex((t) => t.id === id);
			if (index === -1) return null;
			const updated = { ...this.tasks[index], status };
			this.tasks = [...this.tasks.slice(0, index), updated, ...this.tasks.slice(index + 1)];
			this.persist();
			return updated;
		});
	}

	async deleteTask(id: string): Promise<boolean> {
		return this.serialized(async () => {
			const before = this.tasks.length;
			this.tasks = this.tasks.filter((t) => t.id !== id);
			if (this.tasks.length === before) return false;
			this.persist();
			return true;
		});
	}

	private persist(): void {
		this.pi.appendEntry(SESSION_SNAPSHOT_TYPE, {
			version: SESSION_SNAPSHOT_VERSION,
			tasks: this.tasks.slice(),
		});
	}
}
