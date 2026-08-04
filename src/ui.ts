import type { Theme } from "@earendil-works/pi-coding-agent";
import { Key, matchesKey, truncateToWidth, visibleWidth, wrapTextWithAnsi } from "@earendil-works/pi-tui";
import { compactDescription } from "./format.ts";
import type { ProjectGoal, SessionTask, SessionTaskPlacement } from "./types.ts";

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
	| { kind: "view"; scope: "session" | "project"; id: string }
	| { kind: "add"; scope: "session" | "project" }
	| { kind: "insert"; scope: "session"; beforeId: string }
	| ({ kind: "move"; scope: "session" | "project"; id: string } & SessionTaskPlacement)
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

	/**
	 * Reorder the selected item within the list it is shown in.
	 *
	 * The anchor is the neighboring row rather than a stored index, so a move
	 * lands where the user watched it land even when the list is a filtered view
	 * of a longer one.
	 */
	private handleMove(data: string, items: Array<{ id: string }>): boolean {
		const item = items[this.selected];
		if (matchesKey(data, Key.shift("up"))) {
			const anchor = items[this.selected - 1];
			if (item && anchor) {
				this.finish({ kind: "move", scope: this.scope, id: item.id, beforeId: anchor.id });
			}
			return true;
		}
		if (matchesKey(data, Key.shift("down"))) {
			const anchor = items[this.selected + 1];
			if (item && anchor) {
				this.finish({ kind: "move", scope: this.scope, id: item.id, afterId: anchor.id });
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
		if (this.handleMove(data, items)) return;
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
		else if (data === "v" || matchesKey(data, Key.enter)) {
			this.finish({ kind: "view", scope: this.scope, id: item.id });
		} else if (matchesKey(data, Key.space)) {
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
				? "tab switch  ↑↓ navigate  enter view  space advance  a append  i insert  shift+↑↓ move  e edit  d delete  esc close"
				: "tab switch  ↑↓ navigate  enter view  space advance  a add  shift+↑↓ move  e edit  d delete  esc close";
		lines.push("", th.fg("dim", help));
		return lines.map((line) => truncateToWidth(line, width));
	}

	invalidate(): void {}
}

export type DashboardDetailItem =
	| { scope: "session"; task: SessionTask; goal?: ProjectGoal }
	| { scope: "project"; goal: ProjectGoal };

export interface DashboardDetailOptions {
	item: DashboardDetailItem;
	theme: Theme;
	terminalRows: () => number;
	done: () => void;
}

function buildDetailContent(item: DashboardDetailItem, theme: Theme, width: number): string[] {
	const content: string[] = [];
	const addSection = (label: string, value: string, color: "text" | "accent" | "muted" = "text") => {
		content.push(theme.fg("dim", label));
		for (const line of wrapTextWithAnsi(value || "Not provided", width)) {
			content.push(theme.fg(color, line));
		}
		content.push("");
	};

	if (item.scope === "project") {
		const { goal } = item;
		addSection("Title", goal.title, "accent");
		addSection("Status", goal.status.toUpperCase());
		addSection("Description", goal.description?.trim() || "Not provided");
		addSection("ID", goal.id, "muted");
		addSection("Created", goal.createdAt, "muted");
		addSection("Updated", goal.updatedAt, "muted");
	} else {
		const { task, goal } = item;
		addSection("Title", task.title, "accent");
		addSection("Status", task.status.toUpperCase());
		addSection("ID", task.id, "muted");
		if (goal) {
			addSection("Associated Project Goal", goal.title, "accent");
			addSection("Goal Description", goal.description?.trim() || "Not provided");
			addSection("Goal ID", goal.id, "muted");
		} else if (task.goalId) {
			addSection("Associated Goal ID", task.goalId, "muted");
		}
	}
	if (content.at(-1) === "") content.pop();
	return content;
}

function renderDetailPanel(
	options: DashboardDetailOptions,
	scrollOffset: number,
	width: number,
): { lines: string[]; scrollOffset: number } {
	const { item, theme, terminalRows } = options;
	const innerWidth = Math.max(1, width - 2);
	const content = buildDetailContent(item, theme, Math.max(1, innerWidth - 2));
	const bodyRows = Math.max(4, Math.floor(terminalRows() * 0.8) - 3);
	const maxOffset = Math.max(0, content.length - bodyRows);
	const boundedOffset = Math.min(scrollOffset, maxOffset);
	const visible = content.slice(boundedOffset, boundedOffset + bodyRows);
	const border = (text: string) => theme.fg("border", text);
	const panelLine = (text: string) =>
		`${border("│")}${truncateToWidth(` ${text}`, innerWidth, "", true)}${border("│")}`;
	const panelTitle = item.scope === "project" ? " Project Goal Details " : " Session Task Details ";
	const title = truncateToWidth(panelTitle, innerWidth, "");
	const titleRule = "─".repeat(Math.max(0, innerWidth - visibleWidth(title)));
	const lines = [`${border("╭")}${theme.fg("accent", theme.bold(title))}${border(`${titleRule}╮`)}`];

	for (const line of visible) lines.push(panelLine(line));
	for (let index = visible.length; index < bodyRows; index += 1) lines.push(panelLine(""));

	const remaining = maxOffset - boundedOffset;
	const help =
		maxOffset > 0 ? `${boundedOffset} above • ${remaining} below • ↑↓ scroll • esc close` : "enter/esc close";
	lines.push(panelLine(theme.fg("dim", help)));
	lines.push(border(`╰${"─".repeat(innerWidth)}╯`));
	return { lines, scrollOffset: boundedOffset };
}

export class DashboardDetail {
	private scrollOffset = 0;

	constructor(private readonly options: DashboardDetailOptions) {}

	handleInput(data: string): void {
		if (matchesKey(data, Key.escape) || matchesKey(data, Key.enter) || matchesKey(data, Key.ctrl("c"))) {
			this.options.done();
			return;
		}
		if (matchesKey(data, Key.up) || data === "k") {
			this.scrollOffset = Math.max(0, this.scrollOffset - 1);
		} else if (matchesKey(data, Key.down) || data === "j") {
			this.scrollOffset += 1;
		} else if (matchesKey(data, Key.pageUp)) {
			this.scrollOffset = Math.max(0, this.scrollOffset - 8);
		} else if (matchesKey(data, Key.pageDown)) {
			this.scrollOffset += 8;
		}
	}

	render(width: number): string[] {
		const result = renderDetailPanel(this.options, this.scrollOffset, width);
		this.scrollOffset = result.scrollOffset;
		return result.lines;
	}

	invalidate(): void {}
}
