import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { SessionSnapshot, SessionTask, SessionTaskStatus } from "./types.ts";
import { SESSION_SNAPSHOT_VERSION } from "./types.ts";

export const SESSION_SNAPSHOT_TYPE = "worklist-session-snapshot";

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
			if (data && data.version === SESSION_SNAPSHOT_VERSION && Array.isArray(data.tasks)) {
				this.tasks = data.tasks.slice();
			}
		}
	}

	private async serialized<T>(fn: () => Promise<T>): Promise<T> {
		const next = this.mutationQueue.then(fn);
		this.mutationQueue = next.catch(() => undefined);
		return next;
	}

	async addTask(title: string, goalId?: string): Promise<SessionTask> {
		return this.serialized(async () => {
			const id = `st-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`;
			const task: SessionTask = { id, title, status: "todo", goalId };
			this.tasks = [...this.tasks, task];
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
