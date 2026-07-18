import type { ProjectGoal, SessionTask, SessionTaskPlacement } from "./types.ts";
import type { Theme } from "@earendil-works/pi-coding-agent";
import { Key, matchesKey, truncateToWidth } from "@earendil-works/pi-tui";
import { compactDescription } from "./format.ts";

export function buildWidgetLines(tasks: SessionTask[], goals: ProjectGoal[]): string[] {
	const active = goals.find((goal) => goal.status === "active");
	const pending = tasks.filter((task) => task.status !== "done");
	if (!active && pending.length === 0) return [];
	const lines: string[] = [];
	if (active) lines.push(`Goal: ${active.title}`);
	for (const task of pending.slice(0, 3)) {
		lines.push(`${task.status === "doing" ? "●" : "○"} ${task.title}`);
	}
	if (pending.length > 3) lines.push(`+${pending.length - 3} more`);
	return lines;
}

export function buildPromptSummary(tasks: SessionTask[], goals: ProjectGoal[], maxItems = 8): string {
	const active = goals.find((goal) => goal.status === "active");
	const pending = tasks.filter((task) => task.status !== "done").slice(0, maxItems);
	if (!active && pending.length === 0) return "";
	const lines = ["[WORKLIST]"];
	if (active) {
		const description = active.description ? ` - ${compactDescription(active.description)}` : "";
		lines.push(`Active project goal: ${active.title}${description}`);
	}
	if (pending.length) {
		lines.push("Incomplete session tasks:");
		for (const task of pending) {
			lines.push(`- [${task.status === "doing" ? "doing" : "todo"}] ${task.title}`);
		}
	}
	const remaining = tasks.filter((task) => task.status !== "done").length - pending.length;
	if (remaining > 0) lines.push(`- ...and ${remaining} more`);
	return lines.join("\n");
}

export type DashboardAction =
	| { kind: "close" }
	| { kind: "add"; scope: "session" | "project" }
	| { kind: "insert"; scope: "session"; beforeId: string }
	| ({ kind: "move"; scope: "session"; id: string } & SessionTaskPlacement)
	| { kind: "edit"; scope: "session" | "project"; id: string }
	| { kind: "advance"; scope: "session" | "project"; id: string }
	| { kind: "delete"; scope: "session" | "project"; id: string };

export interface DashboardState {
	scope: "session" | "project";
	selectedId?: string;
}

export interface DashboardResult {
	action: DashboardAction;
	state: DashboardState;
}

export class Dashboard {
	private scope: "session" | "project";
	private selected: number;
	constructor(
		private readonly tasks: SessionTask[],
		private readonly goals: ProjectGoal[],
		private readonly theme: Theme,
		private readonly done: (result: DashboardResult) => void,
		initialState?: DashboardState,
	) {
		this.scope = initialState?.scope ?? "session";
		const selectedIndex = initialState?.selectedId
			? this.items().findIndex((item) => item.id === initialState.selectedId)
			: -1;
		this.selected = selectedIndex >= 0 ? selectedIndex : 0;
	}

	private items(): Array<SessionTask | ProjectGoal> {
		return this.scope === "session" ? this.tasks : this.goals.filter((goal) => goal.status !== "archived");
	}

	private finish(action: DashboardAction): void {
		const selectedId = this.items()[this.selected]?.id;
		this.done({
			action,
			state: { scope: this.scope, ...(selectedId !== undefined ? { selectedId } : {}) },
		});
	}

	private handleSessionMove(data: string, items: Array<{ id: string }>): boolean {
		const item = items[this.selected];
		if (matchesKey(data, Key.shift("up"))) {
			const anchor = items[this.selected - 1];
			if (item && anchor) {
				this.finish({ kind: "move", scope: "session", id: item.id, beforeId: anchor.id });
			}
			return true;
		}
		if (matchesKey(data, Key.shift("down"))) {
			const anchor = items[this.selected + 1];
			if (item && anchor) {
				this.finish({ kind: "move", scope: "session", id: item.id, afterId: anchor.id });
			}
			return true;
		}
		return false;
	}

	handleInput(data: string): void {
		const items = this.items();
		if (matchesKey(data, Key.escape) || matchesKey(data, Key.ctrl("c"))) {
			this.finish({ kind: "close" });
			return;
		}
		if (matchesKey(data, Key.tab) || matchesKey(data, Key.left) || matchesKey(data, Key.right)) {
			this.scope = this.scope === "session" ? "project" : "session";
			this.selected = 0;
			return;
		}
		if (this.scope === "session" && this.handleSessionMove(data, items)) return;
		if (matchesKey(data, Key.up)) this.selected = Math.max(0, this.selected - 1);
		if (matchesKey(data, Key.down))
			this.selected = Math.min(Math.max(0, items.length - 1), this.selected + 1);
		if (data === "a") {
			this.finish({ kind: "add", scope: this.scope });
			return;
		}
		const item = items[this.selected];
		if (!item) return;
		if (data === "i" && this.scope === "session") {
			this.finish({ kind: "insert", scope: "session", beforeId: item.id });
		} else if (data === "e") this.finish({ kind: "edit", scope: this.scope, id: item.id });
		else if (data === "d") this.finish({ kind: "delete", scope: this.scope, id: item.id });
		else if (matchesKey(data, Key.enter) || matchesKey(data, Key.space)) {
			this.finish({ kind: "advance", scope: this.scope, id: item.id });
		}
	}

	render(width: number): string[] {
		const th = this.theme;
		const lines = [
			th.fg("accent", th.bold("Worklist")),
			`${this.scope === "session" ? th.fg("accent", "[Session Tasks]") : "Session Tasks"}  ${this.scope === "project" ? th.fg("accent", "[Project Goals]") : "Project Goals"}`,
			"",
		];
		const items = this.items();
		if (!items.length) lines.push(th.fg("dim", "  No items. Press a to add one."));
		items.forEach((item, index) => {
			const status = item.status;
			const marker = status === "done" ? "✓" : status === "doing" || status === "active" ? "●" : "○";
			const prefix = index === this.selected ? th.fg("accent", ">") : " ";
			lines.push(`${prefix} ${marker} ${item.title} ${th.fg("dim", item.id)}`);
		});
		const selected = items[this.selected];
		if (this.scope === "project" && selected && "description" in selected && selected.description) {
			lines.push("", th.fg("muted", `Description: ${compactDescription(selected.description)}`));
		}
		const help =
			this.scope === "session"
				? "tab switch  ↑↓ navigate  a append  i insert  shift+↑↓ move  e edit  space/enter advance  d delete  esc close"
				: "tab switch  ↑↓ navigate  a add  e edit  space/enter advance  d delete  esc close";
		lines.push("", th.fg("dim", help));
		return lines.map((line) => truncateToWidth(line, width));
	}

	invalidate(): void {}
}
