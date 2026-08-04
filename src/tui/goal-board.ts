import type { WorklistOperation } from "../application-service.ts";
import { matchesGoalQuery } from "../goal-selection.ts";
import type { ProjectGoal, ProjectGoalStatus } from "../types.ts";
import type { KeyEvent } from "./keys.ts";
import { isInterrupt } from "./keys.ts";
import type { Palette, Style } from "./style.ts";
import type { Frame } from "./terminal.ts";
import { fitToWidth, singleLine, truncateToWidth, visibleWidth, wrapText } from "./text.ts";

/**
 * The Project Goal board: all state and rendering, no input or output.
 *
 * Every side effect leaves as a `BoardIntent` for the runtime to perform, and
 * every frame is a pure function of state plus the terminal size. That keeps the
 * whole interaction model testable by feeding keys in and reading frames back,
 * without a pseudo-terminal.
 *
 * Mutating intents carry a ready-made `WorklistOperation` so the runtime can
 * hand it straight to `WorklistApplicationService`, which is the only path
 * allowed to write `.pi/worklist.json`.
 */

export const GOAL_FILTERS = ["open", "done", "archived", "all"] as const;
export type GoalFilter = (typeof GOAL_FILTERS)[number];

const FILTER_LABELS: Readonly<Record<GoalFilter, string>> = {
	open: "Open",
	done: "Done",
	archived: "Archived",
	all: "All",
};

const STATUS_MARKERS: Readonly<Record<ProjectGoalStatus, string>> = {
	active: "●",
	open: "○",
	done: "✓",
	archived: "◌",
};

/** Active goals lead the board, then open work, then everything already settled. */
const STATUS_RANK: Readonly<Record<ProjectGoalStatus, number>> = {
	active: 0,
	open: 1,
	done: 2,
	archived: 3,
};

/** Below this width the two panes stack instead of sitting side by side. */
const MIN_SPLIT_WIDTH = 76;
const MIN_LIST_WIDTH = 24;
const MAX_LIST_WIDTH = 54;
const LIST_WIDTH_RATIO = 0.42;
const DETAIL_LABEL_WIDTH = 10;
const PAGE_STEP = 8;
const MESSAGE_TITLE_LIMIT = 48;

/** Divider between hints in the header, key bar, and status summary. */
const SEPARATOR = " · ";

export type MessageTone = "info" | "success" | "error";

export interface BoardMessage {
	text: string;
	tone: MessageTone;
}

export type BoardIntent =
	| { kind: "quit" }
	| { kind: "reload" }
	| { kind: "operation"; operation: WorklistOperation; success: string }
	| { kind: "edit-description"; goal: ProjectGoal };

interface PromptState {
	label: string;
	/** One entry per grapheme, so cursor movement is never split mid-character. */
	cells: string[];
	cursor: number;
	submit: (value: string) => BoardIntent | undefined;
}

interface SearchState {
	cells: string[];
	cursor: number;
	/** Restored when the search is abandoned with Escape. */
	previousQuery: string;
}

interface ConfirmState {
	question: string;
	intent: BoardIntent;
	openedByInputBatch?: number;
}

type BoardMode =
	| { kind: "browse" }
	| { kind: "prompt"; prompt: PromptState }
	| { kind: "search"; search: SearchState }
	| { kind: "confirm"; confirm: ConfirmState }
	| { kind: "help" };

export interface GoalBoardOptions {
	palette: Palette;
	/** Shown in the header so a board opened with `--cwd` names its repository. */
	repositoryLabel: string;
	goals?: ProjectGoal[];
}

interface HelpEntry {
	keys: string;
	description: string;
}

const HELP_ENTRIES: readonly HelpEntry[] = [
	{ keys: "↑ ↓ / j k", description: "Move the selection, or scroll the detail pane" },
	{ keys: "← → / tab", description: "Move focus between the list and the detail pane" },
	{ keys: "enter", description: "Focus the detail pane" },
	{ keys: "g / G", description: "Jump to the first or last goal" },
	{ keys: "pgup / pgdn", description: "Page through the list or the detail pane" },
	{ keys: "space", description: "Advance: open activates, active completes, done reopens" },
	{ keys: "s", description: "Make the selected goal the single active goal" },
	{ keys: "a", description: "Add a goal" },
	{ keys: "e", description: "Rename the selected goal" },
	{ keys: "E", description: "Edit the description in $EDITOR" },
	{ keys: "c / r / x", description: "Complete, reopen, or archive (asks first)" },
	{ keys: "d", description: "Delete permanently (asks first)" },
	{ keys: "f", description: "Cycle the status filter" },
	{ keys: "/", description: "Search titles and descriptions" },
	{ keys: "R", description: "Reload from disk" },
	{ keys: "?", description: "Show this help" },
	{ keys: "q / esc", description: "Quit" },
];

function matchesFilter(goal: ProjectGoal, filter: GoalFilter): boolean {
	if (filter === "all") return true;
	if (filter === "open") return goal.status === "open" || goal.status === "active";
	if (filter === "done") return goal.status === "done";
	return goal.status === "archived";
}

function compareGoals(left: ProjectGoal, right: ProjectGoal): number {
	const rank = STATUS_RANK[left.status] - STATUS_RANK[right.status];
	if (rank !== 0) return rank;
	const created = Date.parse(left.createdAt) - Date.parse(right.createdAt);
	if (Number.isFinite(created) && created !== 0) return created;
	return left.id.localeCompare(right.id);
}

/** Render an ISO timestamp as local `YYYY-MM-DD HH:MM`, or pass it through unchanged. */
function formatTimestamp(value: string): string {
	const parsed = new Date(value);
	if (Number.isNaN(parsed.getTime())) return value;
	const pad = (part: number) => String(part).padStart(2, "0");
	const date = `${parsed.getFullYear()}-${pad(parsed.getMonth() + 1)}-${pad(parsed.getDate())}`;
	return `${date} ${pad(parsed.getHours())}:${pad(parsed.getMinutes())}`;
}

function quoteTitle(title: string): string {
	return `"${truncateToWidth(singleLine(title), MESSAGE_TITLE_LIMIT)}"`;
}

function toCellArray(value: string): string[] {
	return [...new Intl.Segmenter(undefined, { granularity: "grapheme" }).segment(value)].map(
		(entry) => entry.segment,
	);
}

export class GoalBoard {
	private readonly palette: Palette;
	private readonly repositoryLabel: string;
	private goals: ProjectGoal[];
	private filter: GoalFilter = "open";
	private query = "";
	private selectedId: string | undefined;
	private focus: "list" | "detail" = "list";
	private listScroll = 0;
	private detailScroll = 0;
	private mode: BoardMode = { kind: "browse" };
	private message: BoardMessage | undefined;
	/** Where the selection sat before a reload, so a deletion lands on a neighbor. */
	private lastSelectedIndex = 0;

	constructor(options: GoalBoardOptions) {
		this.palette = options.palette;
		this.repositoryLabel = options.repositoryLabel;
		this.goals = options.goals ? [...options.goals] : [];
		this.selectedId = this.visibleGoals()[0]?.id;
	}

	/** Replace the goal set, keeping the selection on the same goal when it survives. */
	setGoals(goals: ProjectGoal[]): void {
		const previousIndex = this.selectedIndex();
		if (previousIndex >= 0) this.lastSelectedIndex = previousIndex;
		this.goals = [...goals];
		const visible = this.visibleGoals();
		if (this.selectedId !== undefined && visible.some((goal) => goal.id === this.selectedId)) return;
		const fallback = Math.min(this.lastSelectedIndex, visible.length - 1);
		this.selectedId = fallback >= 0 ? visible[fallback]?.id : undefined;
		this.detailScroll = 0;
	}

	setMessage(text: string, tone: MessageTone): void {
		this.message = { text, tone };
	}

	get selectedGoal(): ProjectGoal | undefined {
		return this.visibleGoals()[this.selectedIndex()];
	}

	private visibleGoals(): ProjectGoal[] {
		return this.goals
			.filter((goal) => matchesFilter(goal, this.filter) && matchesGoalQuery(goal, this.query))
			.sort(compareGoals);
	}

	private selectedIndex(): number {
		if (this.selectedId === undefined) return -1;
		return this.visibleGoals().findIndex((goal) => goal.id === this.selectedId);
	}

	private selectIndex(index: number): void {
		const visible = this.visibleGoals();
		if (visible.length === 0) {
			this.selectedId = undefined;
			return;
		}
		const bounded = Math.min(Math.max(0, index), visible.length - 1);
		const next = visible[bounded];
		if (next.id !== this.selectedId) this.detailScroll = 0;
		this.selectedId = next.id;
		this.lastSelectedIndex = bounded;
	}

	private moveSelection(delta: number): void {
		const current = this.selectedIndex();
		this.selectIndex((current < 0 ? 0 : current) + delta);
	}

	// ------------------------------------------------------------------ input

	handleKey(key: KeyEvent): BoardIntent | undefined {
		if (isInterrupt(key)) return { kind: "quit" };
		if (key.paste && this.mode.kind !== "prompt" && this.mode.kind !== "search") return undefined;
		if (this.mode.kind === "prompt") return this.handlePromptKey(key, this.mode.prompt);
		if (this.mode.kind === "search") return this.handleSearchKey(key, this.mode.search);
		if (this.mode.kind === "confirm") return this.handleConfirmKey(key, this.mode.confirm);
		if (this.mode.kind === "help") return this.handleHelpKey(key);
		return this.handleBrowseKey(key);
	}

	private handleHelpKey(key: KeyEvent): BoardIntent | undefined {
		if (key.name === "escape" || key.name === "enter" || key.char === "?" || key.char === "q") {
			this.mode = { kind: "browse" };
		}
		return undefined;
	}

	private handleConfirmKey(key: KeyEvent, confirm: ConfirmState): BoardIntent | undefined {
		if (
			key.inputBatch !== undefined &&
			confirm.openedByInputBatch !== undefined &&
			key.inputBatch === confirm.openedByInputBatch
		) {
			return undefined;
		}
		if (key.char === "y" || key.char === "Y") {
			this.mode = { kind: "browse" };
			return confirm.intent;
		}
		// Anything other than an explicit yes cancels: a lifecycle change must never
		// happen because a stray key looked close enough to consent.
		this.mode = { kind: "browse" };
		this.message = { text: "Cancelled.", tone: "info" };
		return undefined;
	}

	/** Shared line-editing behavior for the add, rename, and search inputs. */
	private editCells(
		key: KeyEvent,
		state: { cells: string[]; cursor: number },
	): "edited" | "submit" | "cancel" | "ignored" {
		if (key.name === "escape") return "cancel";
		if (key.name === "enter") return "submit";
		if (key.name === "backspace") {
			if (state.cursor > 0) {
				state.cells.splice(state.cursor - 1, 1);
				state.cursor -= 1;
			}
			return "edited";
		}
		if (key.name === "delete") {
			if (state.cursor < state.cells.length) state.cells.splice(state.cursor, 1);
			return "edited";
		}
		if (key.name === "left") {
			state.cursor = Math.max(0, state.cursor - 1);
			return "edited";
		}
		if (key.name === "right") {
			state.cursor = Math.min(state.cells.length, state.cursor + 1);
			return "edited";
		}
		if (key.name === "home") {
			state.cursor = 0;
			return "edited";
		}
		if (key.name === "end") {
			state.cursor = state.cells.length;
			return "edited";
		}
		if (key.ctrl && key.char === "u") {
			state.cells.splice(0, state.cursor);
			state.cursor = 0;
			return "edited";
		}
		if (key.ctrl && key.char === "k") {
			state.cells.splice(state.cursor);
			return "edited";
		}
		if (key.ctrl && key.char === "w") {
			let index = state.cursor;
			while (index > 0 && state.cells[index - 1] === " ") index -= 1;
			while (index > 0 && state.cells[index - 1] !== " ") index -= 1;
			state.cells.splice(index, state.cursor - index);
			state.cursor = index;
			return "edited";
		}
		if (!key.ctrl && !key.alt && key.char !== undefined) {
			state.cells.splice(state.cursor, 0, key.char);
			state.cursor += 1;
			return "edited";
		}
		return "ignored";
	}

	private handlePromptKey(key: KeyEvent, prompt: PromptState): BoardIntent | undefined {
		const outcome = this.editCells(key, prompt);
		if (outcome === "cancel") {
			this.mode = { kind: "browse" };
			return undefined;
		}
		if (outcome !== "submit") return undefined;
		this.mode = { kind: "browse" };
		const value = prompt.cells.join("").trim();
		if (value === "") {
			this.message = { text: "Cancelled: nothing entered.", tone: "info" };
			return undefined;
		}
		return prompt.submit(value);
	}

	private handleSearchKey(key: KeyEvent, search: SearchState): BoardIntent | undefined {
		const outcome = this.editCells(key, search);
		if (outcome === "cancel") {
			this.query = search.previousQuery;
			this.mode = { kind: "browse" };
			this.selectIndex(this.selectedIndex());
			return undefined;
		}
		if (outcome === "submit") {
			this.mode = { kind: "browse" };
			return undefined;
		}
		// Filter as the user types so the list narrows under the cursor.
		this.query = search.cells.join("");
		if (this.selectedIndex() < 0) this.selectIndex(0);
		return undefined;
	}

	private handleBrowseKey(key: KeyEvent): BoardIntent | undefined {
		this.message = undefined;
		const navigated = this.handleNavigationKey(key);
		if (navigated) return undefined;

		if (key.char === "q") return { kind: "quit" };
		if (key.name === "escape") return this.handleEscape();
		if (key.char === "?") {
			this.mode = { kind: "help" };
			return undefined;
		}
		if (key.char === "f") {
			this.cycleFilter();
			return undefined;
		}
		if (key.char === "/") {
			const cells = toCellArray(this.query);
			this.mode = {
				kind: "search",
				search: { cells, cursor: cells.length, previousQuery: this.query },
			};
			return undefined;
		}
		if (key.char === "R" || (key.ctrl && key.char === "r")) return { kind: "reload" };
		if (key.char === "a") {
			this.openAddPrompt();
			return undefined;
		}
		return this.handleGoalKey(key);
	}

	private handleNavigationKey(key: KeyEvent): boolean {
		const detailFocused = this.focus === "detail";
		if (key.name === "up" || key.char === "k") {
			if (detailFocused) this.detailScroll = Math.max(0, this.detailScroll - 1);
			else this.moveSelection(-1);
			return true;
		}
		if (key.name === "down" || key.char === "j") {
			if (detailFocused) this.detailScroll += 1;
			else this.moveSelection(1);
			return true;
		}
		if (key.name === "pageup") {
			if (detailFocused) this.detailScroll = Math.max(0, this.detailScroll - PAGE_STEP);
			else this.moveSelection(-PAGE_STEP);
			return true;
		}
		if (key.name === "pagedown") {
			if (detailFocused) this.detailScroll += PAGE_STEP;
			else this.moveSelection(PAGE_STEP);
			return true;
		}
		if (key.name === "home" || key.char === "g") {
			if (detailFocused) this.detailScroll = 0;
			else this.selectIndex(0);
			return true;
		}
		if (key.name === "end" || key.char === "G") {
			if (detailFocused) this.detailScroll = Number.MAX_SAFE_INTEGER;
			else this.selectIndex(this.visibleGoals().length - 1);
			return true;
		}
		if (key.name === "left" || key.char === "h") {
			this.focus = "list";
			return true;
		}
		if (key.name === "right" || key.char === "l" || key.name === "enter") {
			this.focus = "detail";
			return true;
		}
		if (key.name === "tab") {
			this.focus = this.focus === "list" ? "detail" : "list";
			return true;
		}
		return false;
	}

	private handleEscape(): BoardIntent | undefined {
		if (this.focus === "detail") {
			this.focus = "list";
			return undefined;
		}
		if (this.query !== "") {
			this.query = "";
			this.selectIndex(this.selectedIndex());
			return undefined;
		}
		return { kind: "quit" };
	}

	private handleGoalKey(key: KeyEvent): BoardIntent | undefined {
		const goal = this.selectedGoal;
		if (!goal) return undefined;
		if (key.name === "space") return this.advance(goal, key.inputBatch);
		if (key.char === "s") return this.activate(goal);
		if (key.char === "e") {
			this.openRenamePrompt(goal);
			return undefined;
		}
		if (key.char === "E") return { kind: "edit-description", goal };
		if (key.char === "c") return this.confirmLifecycle(goal, "complete", key.inputBatch);
		if (key.char === "r") return this.confirmLifecycle(goal, "reopen", key.inputBatch);
		if (key.char === "x") return this.confirmLifecycle(goal, "archive", key.inputBatch);
		if (key.char === "d") {
			this.mode = {
				kind: "confirm",
				confirm: {
					question: `Permanently delete ${quoteTitle(goal.title)}? This cannot be undone.`,
					openedByInputBatch: key.inputBatch,
					intent: {
						kind: "operation",
						operation: { scope: "project", action: "delete", id: goal.id, confirm: true },
						success: `Deleted ${quoteTitle(goal.title)}`,
					},
				},
			};
			return undefined;
		}
		return undefined;
	}

	private cycleFilter(): void {
		const index = GOAL_FILTERS.indexOf(this.filter);
		this.filter = GOAL_FILTERS[(index + 1) % GOAL_FILTERS.length];
		this.listScroll = 0;
		if (this.selectedIndex() < 0) this.selectIndex(0);
	}

	private openAddPrompt(): void {
		this.mode = {
			kind: "prompt",
			prompt: {
				label: "Add goal",
				cells: [],
				cursor: 0,
				submit: (title) => ({
					kind: "operation",
					operation: { scope: "project", action: "add", title },
					success: `Added ${quoteTitle(title)} - press E to write its description`,
				}),
			},
		};
	}

	private openRenamePrompt(goal: ProjectGoal): void {
		const initial = toCellArray(singleLine(goal.title));
		this.mode = {
			kind: "prompt",
			prompt: {
				label: "Rename goal",
				cells: initial,
				cursor: initial.length,
				submit: (title) =>
					title === goal.title
						? undefined
						: {
								kind: "operation",
								operation: { scope: "project", action: "update", id: goal.id, title },
								success: `Renamed to ${quoteTitle(title)}`,
							},
			},
		};
	}

	/** Mirror Pi's dashboard: open activates, active completes, anything settled reopens. */
	private advance(goal: ProjectGoal, inputBatch?: number): BoardIntent | undefined {
		if (goal.status === "open") return this.activate(goal);
		if (goal.status === "active") return this.confirmLifecycle(goal, "complete", inputBatch);
		return this.confirmLifecycle(goal, "reopen", inputBatch);
	}

	private activate(goal: ProjectGoal): BoardIntent | undefined {
		if (goal.status === "active") {
			this.message = { text: "Already the active goal.", tone: "info" };
			return undefined;
		}
		return {
			kind: "operation",
			operation: { scope: "project", action: "set_active", id: goal.id },
			success: `Activated ${quoteTitle(goal.title)}`,
		};
	}

	/**
	 * Stage a lifecycle change behind a yes-or-no prompt.
	 *
	 * The prompt is the explicit user intent the application service requires;
	 * `confirm` is only ever set on the intent the prompt returns.
	 */
	private confirmLifecycle(
		goal: ProjectGoal,
		action: "complete" | "reopen" | "archive",
		openedByInputBatch?: number,
	): BoardIntent | undefined {
		const outcome = action === "complete" ? "done" : action === "reopen" ? "open" : "archived";
		this.mode = {
			kind: "confirm",
			confirm: {
				question: `${action[0].toUpperCase()}${action.slice(1)} ${quoteTitle(goal.title)}?`,
				openedByInputBatch,
				intent: {
					kind: "operation",
					operation: { scope: "project", action, id: goal.id, confirm: true },
					success: `${quoteTitle(goal.title)} is now ${outcome}`,
				},
			},
		};
		return undefined;
	}

	// ----------------------------------------------------------------- render

	render(width: number, rows: number): Frame {
		const bodyRows = Math.max(3, rows - 3);
		const body =
			this.mode.kind === "help" ? this.renderHelp(width, bodyRows) : this.renderPanes(width, bodyRows);
		const status = this.renderStatus(width);
		const lines = [this.renderHeader(width), ...body, status.line, this.renderKeyBar(width)];
		// The frame is exactly the size it was asked for, whatever the panes produced,
		// so the status line and key bar always land on the last two rows.
		while (lines.length < rows) lines.splice(lines.length - 2, 0, "");
		if (lines.length > rows) lines.splice(rows - 2, lines.length - rows);
		return {
			lines,
			...(status.cursorColumn === undefined
				? {}
				: { cursor: { row: rows - 2, column: status.cursorColumn } }),
		};
	}

	private renderHeader(width: number): string {
		const { accent, bold, muted, dim } = this.palette;
		const total = this.goals.length;
		const shown = this.visibleGoals().length;
		const left = ` ${accent(bold("Project Goals"))} ${dim("·")} ${muted(this.repositoryLabel)}`;
		const search = this.query === "" ? "" : ` ${dim("·")} ${accent(`/${singleLine(this.query)}`)}`;
		const right = `${muted(FILTER_LABELS[this.filter])} ${dim("·")} ${muted(`${shown} of ${total}`)} `;
		const gap = Math.max(1, width - visibleWidth(left) - visibleWidth(search) - visibleWidth(right));
		return truncateToWidth(`${left}${search}${" ".repeat(gap)}${right}`, width);
	}

	private renderPanes(width: number, bodyRows: number): string[] {
		const contentRows = Math.max(1, bodyRows - 2);
		const listWidth = Math.min(
			MAX_LIST_WIDTH,
			Math.max(MIN_LIST_WIDTH, Math.round((width - 3) * LIST_WIDTH_RATIO)),
		);
		const detailWidth = width - 3 - listWidth;
		if (width >= MIN_SPLIT_WIDTH && detailWidth >= MIN_LIST_WIDTH) {
			return this.renderSplit(listWidth, detailWidth, contentRows);
		}
		return this.renderStacked(width, bodyRows);
	}

	private renderSplit(listWidth: number, detailWidth: number, contentRows: number): string[] {
		const { border } = this.palette;
		const listRows = this.renderListContent(listWidth, contentRows);
		const detailRows = this.renderDetailContent(detailWidth, contentRows);
		const lines = [
			border("╭") +
				this.renderBorderRule(listWidth, { text: this.listTitle(), focused: this.focus === "list" }) +
				border("┬") +
				this.renderBorderRule(detailWidth, { text: " Detail ", focused: this.focus === "detail" }) +
				border("╮"),
		];
		for (let row = 0; row < contentRows; row += 1) {
			lines.push(border("│") + listRows.lines[row] + border("│") + detailRows.lines[row] + border("│"));
		}
		lines.push(
			border("╰") +
				this.renderBorderRule(listWidth, undefined, listRows.hint) +
				border("┴") +
				this.renderBorderRule(detailWidth, undefined, detailRows.hint) +
				border("╯"),
		);
		return lines;
	}

	private renderStacked(width: number, bodyRows: number): string[] {
		const { border } = this.palette;
		const inner = width - 2;
		// Three rows go to the top border, the divider, and the bottom border.
		const usable = Math.max(2, bodyRows - 3);
		const listRowCount = Math.max(1, Math.min(usable - 1, Math.round(usable * 0.5)));
		const detailRowCount = Math.max(1, usable - listRowCount);
		const listRows = this.renderListContent(inner, listRowCount);
		const detailRows = this.renderDetailContent(inner, detailRowCount);
		const lines = [
			border("╭") +
				this.renderBorderRule(inner, { text: this.listTitle(), focused: this.focus === "list" }) +
				border("╮"),
		];
		for (const line of listRows.lines) lines.push(border("│") + line + border("│"));
		// The divider carries the list's scroll hint, which has no border of its own here.
		lines.push(
			border("├") +
				this.renderBorderRule(inner, { text: " Detail ", focused: this.focus === "detail" }, listRows.hint) +
				border("┤"),
		);
		for (const line of detailRows.lines) lines.push(border("│") + line + border("│"));
		lines.push(border("╰") + this.renderBorderRule(inner, undefined, detailRows.hint) + border("╯"));
		return lines;
	}

	private listTitle(): string {
		const visible = this.visibleGoals().length;
		return ` ${FILTER_LABELS[this.filter]} goals (${visible}) `;
	}

	/**
	 * Draw one pane border: a horizontal rule with an optional title on the left
	 * and an optional scroll hint on the right, filling exactly `width` cells.
	 */
	private renderBorderRule(width: number, title?: { text: string; focused: boolean }, hint?: string): string {
		const { border, accent, bold } = this.palette;
		const titleText =
			title && title.text.trim() !== "" ? truncateToWidth(title.text, Math.max(0, width - 2)) : "";
		const hintBudget = Math.max(0, width - visibleWidth(titleText) - 2);
		const hintText = hint && hint.trim() !== "" ? truncateToWidth(hint, hintBudget) : "";
		const styledTitle = title?.focused ? accent(bold(titleText)) : border(titleText);
		const fill = Math.max(0, width - visibleWidth(titleText) - visibleWidth(hintText) - 1);
		return `${border("─")}${styledTitle}${border("─".repeat(fill))}${border(hintText)}`;
	}

	private statusStyle(status: ProjectGoalStatus): Style {
		const { accent, muted, success, dim } = this.palette;
		if (status === "active") return accent;
		if (status === "done") return success;
		if (status === "archived") return dim;
		return muted;
	}

	private renderListContent(width: number, height: number): { lines: string[]; hint: string } {
		const { accent, muted, dim, bold } = this.palette;
		const goals = this.visibleGoals();
		const available = Math.max(1, width - 2);

		if (goals.length === 0) {
			// The way out of an empty list depends on why it is empty: a search that
			// matched nothing, a filter hiding real goals, or a genuinely empty roadmap.
			const [empty, wayOut] =
				this.query !== ""
					? ["Nothing matches this search.", "Press esc to clear it."]
					: this.goals.length === 0
						? ["No goals here yet.", "Press a to add one."]
						: [`No ${FILTER_LABELS[this.filter].toLowerCase()} goals.`, "Press f to change the filter."];
			const lines = [
				` ${dim(truncateToWidth(empty, available))}`,
				` ${dim(truncateToWidth(wayOut, available))}`,
			];
			while (lines.length < height) lines.push("");
			return { lines: lines.slice(0, height).map((line) => fitToWidth(line, width)), hint: "" };
		}

		const selected = Math.max(0, this.selectedIndex());
		this.listScroll = Math.min(this.listScroll, Math.max(0, goals.length - height));
		if (selected < this.listScroll) this.listScroll = selected;
		if (selected >= this.listScroll + height) this.listScroll = selected - height + 1;

		const lines: string[] = [];
		for (let offset = 0; offset < height; offset += 1) {
			const index = this.listScroll + offset;
			const goal = goals[index];
			if (!goal) {
				lines.push(fitToWidth("", width));
				continue;
			}
			const isSelected = index === selected;
			const pointer = isSelected ? (this.focus === "list" ? accent("❯") : muted("❯")) : " ";
			const marker = this.statusStyle(goal.status)(STATUS_MARKERS[goal.status]);
			const title = truncateToWidth(singleLine(goal.title), Math.max(1, available - 4));
			const label = isSelected && this.focus === "list" ? bold(title) : title;
			lines.push(fitToWidth(` ${pointer} ${marker} ${label}`, width));
		}

		const hidden = goals.length - this.listScroll - height;
		const hint = hidden > 0 ? ` ${hidden} more ` : "";
		return { lines, hint };
	}

	private buildDetailLines(width: number): string[] {
		const { accent, bold, muted, dim } = this.palette;
		const goal = this.selectedGoal;
		if (!goal) return [dim("No goal selected.")];

		const lines: string[] = [];
		for (const line of wrapText(goal.title, width)) lines.push(accent(bold(line)));
		lines.push("");

		const field = (label: string, value: string, style: Style) =>
			`${muted(label.padEnd(DETAIL_LABEL_WIDTH))}${style(value)}`;
		lines.push(field("STATUS", goal.status.toUpperCase(), this.statusStyle(goal.status)));
		lines.push(field("UPDATED", formatTimestamp(goal.updatedAt), dim));
		lines.push(field("CREATED", formatTimestamp(goal.createdAt), dim));
		// The ID is what every CLI command takes, so it must be readable in full.
		for (const [index, chunk] of wrapText(goal.id, Math.max(1, width - DETAIL_LABEL_WIDTH)).entries()) {
			lines.push(index === 0 ? field("ID", chunk, dim) : `${" ".repeat(DETAIL_LABEL_WIDTH)}${dim(chunk)}`);
		}
		lines.push("");

		const description = goal.description?.trim();
		if (description) for (const line of wrapText(description, width)) lines.push(line);
		else lines.push(dim("No description. Press E to write one."));
		return lines;
	}

	private renderDetailContent(width: number, height: number): { lines: string[]; hint: string } {
		const available = Math.max(1, width - 2);
		const content = this.buildDetailLines(available);
		const maxScroll = Math.max(0, content.length - height);
		this.detailScroll = Math.min(this.detailScroll, maxScroll);
		const visible = content.slice(this.detailScroll, this.detailScroll + height);
		const lines: string[] = [];
		for (let row = 0; row < height; row += 1) lines.push(fitToWidth(` ${visible[row] ?? ""}`, width));
		const remaining = maxScroll - this.detailScroll;
		const hint = maxScroll > 0 ? ` ${this.detailScroll} above · ${remaining} below ` : "";
		return { lines, hint };
	}

	private renderHelp(width: number, bodyRows: number): string[] {
		const { border, accent, bold, muted } = this.palette;
		const inner = Math.max(20, width - 2);
		const keyWidth = Math.min(14, Math.max(...HELP_ENTRIES.map((entry) => entry.keys.length)) + 1);
		const lines = [
			border("╭") + this.renderBorderRule(inner, { text: " Keys ", focused: true }) + border("╮"),
		];
		const rows = Math.max(1, bodyRows - 2);
		const body: string[] = [];
		for (const entry of HELP_ENTRIES) {
			body.push(` ${accent(entry.keys.padEnd(keyWidth))}${muted(entry.description)}`);
		}
		body.push("");
		body.push(` ${bold("Press any key to return.")}`);
		for (let row = 0; row < rows; row += 1)
			lines.push(border("│") + fitToWidth(body[row] ?? "", inner) + border("│"));
		lines.push(border("╰") + border("─".repeat(inner)) + border("╯"));
		return lines;
	}

	/** The prompt line, which also carries the cursor column when input is open. */
	private renderStatus(width: number): { line: string; cursorColumn?: number } {
		const { accent, muted, dim, success, danger, warning, bold } = this.palette;
		if (this.mode.kind === "prompt") {
			return this.renderInputLine(`${this.mode.prompt.label}: `, this.mode.prompt, width, accent);
		}
		if (this.mode.kind === "search") {
			return this.renderInputLine("/", this.mode.search, width, accent);
		}
		if (this.mode.kind === "confirm") {
			const suffix = ` ${dim("[")}${bold("y")}${dim("/")}N${dim("]")}`;
			const question = truncateToWidth(this.mode.confirm.question, Math.max(1, width - 8));
			return { line: ` ${warning(question)}${suffix}` };
		}
		if (this.message) {
			const style =
				this.message.tone === "error" ? danger : this.message.tone === "success" ? success : muted;
			return { line: ` ${style(truncateToWidth(this.message.text, Math.max(1, width - 2)))}` };
		}
		return { line: ` ${dim(truncateToWidth(this.statusSummary(), Math.max(1, width - 2)))}` };
	}

	/**
	 * Roadmap shape at a glance.
	 *
	 * The list is filtered, so counts across every status are the one thing the
	 * board cannot otherwise show without changing the filter.
	 */
	private statusSummary(): string {
		if (this.goals.length === 0) return "No project goals yet. Press a to add one.";
		const order: ProjectGoalStatus[] = ["active", "open", "done", "archived"];
		const parts = order
			.map((status) => ({ status, count: this.goals.filter((goal) => goal.status === status).length }))
			.filter((entry) => entry.count > 0)
			.map((entry) => `${entry.count} ${entry.status}`);
		return parts.join(SEPARATOR);
	}

	/**
	 * Draw a single-line editor, scrolling horizontally so the cursor stays visible
	 * even when the value is longer than the terminal is wide.
	 */
	private renderInputLine(
		prefix: string,
		state: { cells: string[]; cursor: number },
		width: number,
		style: Style,
	): { line: string; cursorColumn: number } {
		const prefixWidth = visibleWidth(prefix) + 1;
		const available = Math.max(1, width - prefixWidth - 1);
		let start = 0;
		let cursorOffset = 0;
		for (let index = 0; index < state.cursor; index += 1) {
			cursorOffset += visibleWidth(state.cells[index]);
		}
		while (cursorOffset - start >= available) start += 1;
		let rendered = "";
		let used = 0;
		let skipped = 0;
		for (const cell of state.cells) {
			const cellWidth = visibleWidth(cell);
			if (skipped < start) {
				skipped += cellWidth;
				continue;
			}
			if (used + cellWidth > available) break;
			rendered += cell;
			used += cellWidth;
		}
		return {
			line: ` ${style(prefix)}${rendered}`,
			cursorColumn: prefixWidth + (cursorOffset - start),
		};
	}

	private renderKeyBar(width: number): string {
		const { dim } = this.palette;
		if (this.mode.kind === "prompt" || this.mode.kind === "search") {
			return ` ${dim(truncateToWidth("enter confirm · esc cancel", Math.max(1, width - 2)))}`;
		}
		if (this.mode.kind === "confirm") {
			return ` ${dim(truncateToWidth("y confirm · any other key cancels", Math.max(1, width - 2)))}`;
		}
		if (this.mode.kind === "help") {
			return ` ${dim(truncateToWidth("esc close", Math.max(1, width - 2)))}`;
		}
		// `? keys` and `q quit` are the two hints a stuck user needs, so they are
		// reserved first and the rest fill whatever width is left.
		const reserved = ["? keys", "q quit"];
		const optional = [
			"↑↓ move",
			"tab pane",
			"space advance",
			"a add",
			"e rename",
			"E describe",
			"f filter",
			"/ search",
		];
		const available = Math.max(1, width - 2);
		const chosen: string[] = [];
		for (const part of optional) {
			if (visibleWidth([...chosen, part, ...reserved].join(SEPARATOR)) > available) break;
			chosen.push(part);
		}
		return ` ${dim(truncateToWidth([...chosen, ...reserved].join(SEPARATOR), available))}`;
	}
}
