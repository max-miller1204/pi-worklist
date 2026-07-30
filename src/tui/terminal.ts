import type { KeyEvent } from "./keys.ts";
import { KeyDecoder } from "./keys.ts";
import { fitToWidth } from "./text.ts";

/**
 * Full-screen terminal control for the standalone Project Goal board.
 *
 * The board owns the whole screen while it runs, so this wrapper takes the
 * alternate buffer, raw input, and the cursor on open, and gives all three back
 * on close. Restoration is registered against process teardown as well, because
 * a terminal left in raw mode with a hidden cursor is unusable and the user
 * would have to blindly type `reset`.
 *
 * Frames are diffed line by line: only rows whose content changed are rewritten,
 * which keeps a 60-goal board flicker-free without a damage-tracking layer.
 */

const CSI = "\u001b[";

const ENTER_ALTERNATE_BUFFER = `${CSI}?1049h`;
const LEAVE_ALTERNATE_BUFFER = `${CSI}?1049l`;
const HIDE_CURSOR = `${CSI}?25l`;
const SHOW_CURSOR = `${CSI}?25h`;
const DISABLE_AUTO_WRAP = `${CSI}?7l`;
const ENABLE_AUTO_WRAP = `${CSI}?7h`;
const CLEAR_SCREEN = `${CSI}2J`;
const CLEAR_LINE = `${CSI}2K`;
const RESET_STYLE = `${CSI}0m`;
const ENABLE_BRACKETED_PASTE = `${CSI}?2004h`;
const DISABLE_BRACKETED_PASTE = `${CSI}?2004l`;

// biome-ignore lint/suspicious/noControlCharactersInRegex: only SGR escapes are safe frame content.
const SGR_AT_START = /^\u001b\[[0-9;]*m/;

const DEFAULT_COLUMNS = 80;
const DEFAULT_ROWS = 24;

export interface TerminalInput extends NodeJS.EventEmitter {
	setRawMode?(mode: boolean): unknown;
	resume(): unknown;
	pause(): unknown;
	setEncoding(encoding: BufferEncoding): unknown;
	isTTY?: boolean;
}

export interface TerminalOutput extends NodeJS.EventEmitter {
	write(chunk: string): unknown;
	columns?: number;
	rows?: number;
	isTTY?: boolean;
}

export interface CursorPosition {
	/** Zero-based row within the rendered frame. */
	row: number;
	/** Zero-based column within the rendered frame. */
	column: number;
}

export interface Frame {
	lines: string[];
	/** Shown only while a text prompt is open; the cursor stays hidden otherwise. */
	cursor?: CursorPosition;
}

export interface TerminalOptions {
	input: TerminalInput;
	output: TerminalOutput;
	/** Used when the output stream does not report a size, as in tests. */
	fallbackSize?: { columns: number; rows: number };
}

export class Terminal {
	private readonly input: TerminalInput;
	private readonly output: TerminalOutput;
	private readonly fallbackSize: { columns: number; rows: number };
	private readonly keyHandlers: Array<(key: KeyEvent) => void> = [];
	private readonly resizeHandlers: Array<() => void> = [];
	private readonly keyDecoder = new KeyDecoder();
	private previousLines: string[] = [];
	private previousCursor: CursorPosition | undefined;
	private active = false;
	private rawModeApplied = false;
	private inputBatch = 0;
	private pendingInputFlush: NodeJS.Immediate | undefined;

	private readonly onData = (chunk: string | Buffer): void => {
		const text = typeof chunk === "string" ? chunk : chunk.toString("utf8");
		if (this.pendingInputFlush) clearImmediate(this.pendingInputFlush);
		this.pendingInputFlush = undefined;
		this.inputBatch += 1;
		const batch = this.inputBatch;
		this.deliverKeys(this.keyDecoder.push(text), batch);
		if (this.active) {
			this.pendingInputFlush = setImmediate(() => {
				this.pendingInputFlush = undefined;
				this.deliverKeys(this.keyDecoder.flush(), batch);
			});
		}
	};

	private deliverKeys(keys: KeyEvent[], inputBatch: number): void {
		for (const decoded of keys) {
			const key = { ...decoded, inputBatch };
			// Handlers may close the terminal, so re-check between deliveries.
			if (!this.active) return;
			for (const handler of [...this.keyHandlers]) handler(key);
		}
	}

	private readonly onResize = (): void => {
		// A resize invalidates every cached row: the terminal reflows content itself.
		this.previousLines = [];
		for (const handler of [...this.resizeHandlers]) handler();
	};

	private readonly onProcessExit = (): void => {
		this.restore();
	};

	constructor(options: TerminalOptions) {
		this.input = options.input;
		this.output = options.output;
		this.fallbackSize = options.fallbackSize ?? { columns: DEFAULT_COLUMNS, rows: DEFAULT_ROWS };
	}

	get columns(): number {
		return Math.max(20, this.output.columns ?? this.fallbackSize.columns);
	}

	get rows(): number {
		return Math.max(6, this.output.rows ?? this.fallbackSize.rows);
	}

	open(): void {
		if (this.active) return;
		this.active = true;
		this.previousLines = [];
		this.previousCursor = undefined;

		if (this.input.setRawMode && this.input.isTTY) {
			this.input.setRawMode(true);
			this.rawModeApplied = true;
		}
		this.input.setEncoding("utf8");
		this.input.resume();
		this.input.on("data", this.onData);
		this.output.on("resize", this.onResize);
		process.once("exit", this.onProcessExit);

		this.output.write(
			`${ENTER_ALTERNATE_BUFFER}${HIDE_CURSOR}${DISABLE_AUTO_WRAP}${ENABLE_BRACKETED_PASTE}${RESET_STYLE}${CLEAR_SCREEN}`,
		);
	}

	close(): void {
		if (!this.active) return;
		this.active = false;
		this.input.off("data", this.onData);
		this.output.off("resize", this.onResize);
		process.off("exit", this.onProcessExit);
		if (this.pendingInputFlush) clearImmediate(this.pendingInputFlush);
		this.pendingInputFlush = undefined;
		this.restore();
	}

	/** Return the terminal to the state it was in before `open`, safe to call twice. */
	private restore(): void {
		if (this.rawModeApplied && this.input.setRawMode) {
			this.input.setRawMode(false);
			this.rawModeApplied = false;
		}
		this.input.pause();
		this.output.write(
			`${RESET_STYLE}${DISABLE_BRACKETED_PASTE}${ENABLE_AUTO_WRAP}${SHOW_CURSOR}${LEAVE_ALTERNATE_BUFFER}`,
		);
	}

	onKey(handler: (key: KeyEvent) => void): void {
		this.keyHandlers.push(handler);
	}

	onResizeRequest(handler: () => void): void {
		this.resizeHandlers.push(handler);
	}

	/** Discard the diff cache so the next render repaints every row. */
	invalidate(): void {
		this.previousLines = [];
	}

	render(frame: Frame): void {
		if (!this.active) return;
		const columns = this.columns;
		const rows = this.rows;
		const next = frame.lines.slice(0, rows).map((line) => fitToWidth(sanitizeFrameLine(line), columns));
		while (next.length < rows) next.push(" ".repeat(columns));

		let output = "";
		const repaintAll = this.previousLines.length !== rows;
		for (let row = 0; row < rows; row += 1) {
			if (!repaintAll && this.previousLines[row] === next[row]) continue;
			output += `${CSI}${row + 1};1H${CLEAR_LINE}${next[row]}${RESET_STYLE}`;
		}
		this.previousLines = next;

		const cursor = frame.cursor;
		if (cursor) {
			const row = Math.min(Math.max(0, cursor.row), rows - 1);
			const column = Math.min(Math.max(0, cursor.column), columns - 1);
			output += `${CSI}${row + 1};${column + 1}H`;
			if (!this.previousCursor) output += SHOW_CURSOR;
		} else if (this.previousCursor) {
			output += HIDE_CURSOR;
		}
		this.previousCursor = cursor;

		if (output !== "") this.output.write(output);
	}

	/**
	 * Hand the terminal back for the duration of `action`, then take it again.
	 *
	 * Used to run the user's external editor, which needs the normal screen, cooked
	 * input, and a visible cursor of its own.
	 */
	async suspend<T>(action: () => Promise<T>): Promise<T> {
		const wasActive = this.active;
		if (wasActive) {
			this.input.off("data", this.onData);
			if (this.pendingInputFlush) clearImmediate(this.pendingInputFlush);
			this.pendingInputFlush = undefined;
			if (this.rawModeApplied && this.input.setRawMode) {
				this.input.setRawMode(false);
				this.rawModeApplied = false;
			}
			this.input.pause();
			this.output.write(
				`${RESET_STYLE}${DISABLE_BRACKETED_PASTE}${ENABLE_AUTO_WRAP}${SHOW_CURSOR}${LEAVE_ALTERNATE_BUFFER}`,
			);
		}
		try {
			return await action();
		} finally {
			if (wasActive && this.active) {
				if (this.input.setRawMode && this.input.isTTY) {
					this.input.setRawMode(true);
					this.rawModeApplied = true;
				}
				this.input.setEncoding("utf8");
				this.input.resume();
				this.input.on("data", this.onData);
				this.output.write(
					`${ENTER_ALTERNATE_BUFFER}${HIDE_CURSOR}${DISABLE_AUTO_WRAP}${ENABLE_BRACKETED_PASTE}${RESET_STYLE}${CLEAR_SCREEN}`,
				);
				this.previousLines = [];
				this.previousCursor = undefined;
			}
		}
	}
}

function sanitizeFrameLine(line: string): string {
	let output = "";
	for (let index = 0; index < line.length; index += 1) {
		const code = line.charCodeAt(index);
		if (code === 0x1b) {
			const sgr = SGR_AT_START.exec(line.slice(index));
			if (sgr) {
				output += sgr[0];
				index += sgr[0].length - 1;
			}
			continue;
		}
		if (code < 0x20 || (code >= 0x7f && code <= 0x9f)) continue;
		output += line[index];
	}
	return output;
}
