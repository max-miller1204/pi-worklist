/**
 * Decodes raw terminal input into key events.
 *
 * A raw-mode read delivers bytes, not keys: arrows arrive as CSI sequences,
 * Ctrl-letter chords arrive as C0 control codes, and a paste arrives as one
 * large chunk. This module turns a chunk into the ordered key events it
 * represents so the board's state machine never parses escape sequences itself.
 */

const GRAPHEME_SEGMENTER = new Intl.Segmenter(undefined, { granularity: "grapheme" });

const ESCAPE_CHARACTER = "\u001b";
const BRACKETED_PASTE_START = `${ESCAPE_CHARACTER}[200~`;
const BRACKETED_PASTE_END = `${ESCAPE_CHARACTER}[201~`;
const MAX_PASTED_TEXT_LENGTH = 1024 * 1024;

export type KeyName =
	| "up"
	| "down"
	| "left"
	| "right"
	| "home"
	| "end"
	| "pageup"
	| "pagedown"
	| "insert"
	| "delete"
	| "enter"
	| "escape"
	| "tab"
	| "backspace"
	| "space"
	| "char"
	| "unknown";

export interface KeyEvent {
	name: KeyName;
	/** The raw bytes this event was decoded from. */
	sequence: string;
	ctrl: boolean;
	alt: boolean;
	shift: boolean;
	/** The typed grapheme, present for `char` and `space`. */
	char?: string;
	/** True when the terminal identified this event as pasted text. */
	paste?: boolean;
	/** Identifies the raw input read that delivered this event. */
	inputBatch?: number;
}

/** Final byte of a CSI sequence to the key it represents. */
const CSI_FINAL_KEYS: Readonly<Record<string, KeyName>> = {
	A: "up",
	B: "down",
	C: "right",
	D: "left",
	H: "home",
	F: "end",
};

/** Leading parameter of a `CSI <n> ~` sequence to the key it represents. */
const CSI_TILDE_KEYS: Readonly<Record<string, KeyName>> = {
	"1": "home",
	"2": "insert",
	"3": "delete",
	"4": "end",
	"5": "pageup",
	"6": "pagedown",
	"7": "home",
	"8": "end",
};

/** `CSI [params] final`, covering both `1;5A` and `3~` shapes. */
// biome-ignore lint/suspicious/noControlCharactersInRegex: matching the ESC byte is the purpose of this terminal decoder.
const CSI_PATTERN = /^\u001b\[(\d*)(?:;(\d+))?([A-Za-z~])/;

/** `SS3 final`, emitted for arrows while the terminal is in application mode. */
// biome-ignore lint/suspicious/noControlCharactersInRegex: matching the ESC byte is the purpose of this terminal decoder.
const SS3_PATTERN = /^\u001bO([A-Za-z])/;

function baseEvent(name: KeyName, sequence: string): KeyEvent {
	return { name, sequence, ctrl: false, alt: false, shift: false };
}

/**
 * xterm encodes modifiers as `1 + bitmask` in the last CSI parameter,
 * where the bits are shift, alt, and ctrl in that order.
 */
function applyModifiers(event: KeyEvent, parameter: string | undefined): KeyEvent {
	if (parameter === undefined) return event;
	const bits = Number.parseInt(parameter, 10) - 1;
	if (!Number.isInteger(bits) || bits < 0) return event;
	return {
		...event,
		shift: (bits & 1) !== 0,
		alt: (bits & 2) !== 0,
		ctrl: (bits & 4) !== 0,
	};
}

function readEscapeSequence(input: string, index: number): { event: KeyEvent; length: number } {
	const remainder = input.slice(index);

	const csi = CSI_PATTERN.exec(remainder);
	if (csi) {
		const [sequence, first, modifier, final] = csi;
		if (final === "~") {
			const name = CSI_TILDE_KEYS[first] ?? "unknown";
			return { event: applyModifiers(baseEvent(name, sequence), modifier), length: sequence.length };
		}
		const name = CSI_FINAL_KEYS[final] ?? "unknown";
		// `CSI 1;5A` puts the modifier second, but bare `CSI 5A` has it first.
		const modifierParameter = modifier ?? (first === "" ? undefined : first);
		return { event: applyModifiers(baseEvent(name, sequence), modifierParameter), length: sequence.length };
	}

	const ss3 = SS3_PATTERN.exec(remainder);
	if (ss3) {
		const name = CSI_FINAL_KEYS[ss3[1]] ?? "unknown";
		return { event: baseEvent(name, ss3[0]), length: ss3[0].length };
	}

	// Anything else beginning with ESC is the Escape key, consuming only that byte.
	//
	// A terminal cannot distinguish Alt+q from Escape then q without timing the
	// gap between bytes, and pressing Escape quickly followed by another key would
	// then be swallowed as one Alt chord. Escape is bound throughout the board and
	// Alt is bound nowhere, so the ambiguity is always resolved in Escape's favor.
	return { event: baseEvent("escape", ESCAPE_CHARACTER), length: 1 };
}

function readControlCharacter(input: string, index: number): KeyEvent {
	const code = input.charCodeAt(index);
	const sequence = input[index];
	if (code === 0x0d || code === 0x0a) return baseEvent("enter", sequence);
	if (code === 0x09) return baseEvent("tab", sequence);
	if (code === 0x08 || code === 0x7f) return baseEvent("backspace", sequence);
	if (code >= 0x01 && code <= 0x1a) {
		return {
			name: "char",
			sequence,
			ctrl: true,
			alt: false,
			shift: false,
			char: String.fromCharCode(code + 0x60),
		};
	}
	return baseEvent("unknown", sequence);
}

function isControlCode(code: number): boolean {
	return code < 0x20 || code === 0x7f;
}

function decodeRegularKeys(input: string): KeyEvent[] {
	const events: KeyEvent[] = [];
	let index = 0;
	while (index < input.length) {
		if (input[index] === ESCAPE_CHARACTER) {
			const { event, length } = readEscapeSequence(input, index);
			events.push(event);
			index += length;
			continue;
		}
		if (isControlCode(input.charCodeAt(index))) {
			events.push(readControlCharacter(input, index));
			index += 1;
			continue;
		}
		// Printable text may be a paste; segment it so wide and composed
		// characters each arrive as a single insertable key.
		let end = index;
		while (end < input.length && !isControlCode(input.charCodeAt(end))) end += 1;
		for (const { segment } of GRAPHEME_SEGMENTER.segment(input.slice(index, end))) {
			events.push({
				name: segment === " " ? "space" : "char",
				sequence: segment,
				ctrl: false,
				alt: false,
				shift: false,
				char: segment,
			});
		}
		index = end;
	}
	return events;
}

function decodePastedText(input: string): KeyEvent[] {
	const normalized = input
		.replace(/\r\n?/g, "\n")
		.replace(/[\n\t]/g, " ")
		// biome-ignore lint/suspicious/noControlCharactersInRegex: pasted controls must not become commands.
		.replace(/[\u0000-\u001f\u007f-\u009f]/g, "");
	return [...GRAPHEME_SEGMENTER.segment(normalized)].map(({ segment }) => ({
		name: segment === " " ? "space" : "char",
		sequence: segment,
		ctrl: false,
		alt: false,
		shift: false,
		char: segment,
		paste: true,
	}));
}

function partialMarkerLength(input: string, marker: string): number {
	for (let length = Math.min(input.length, marker.length - 1); length >= 1; length -= 1) {
		if (marker.startsWith(input.slice(-length))) return length;
	}
	return 0;
}

export class KeyDecoder {
	private pending = "";
	private pasted = "";
	private pasteEndPending = "";
	private inPaste = false;

	push(input: string): KeyEvent[] {
		let remaining = this.pending + input;
		this.pending = "";
		const events: KeyEvent[] = [];

		while (remaining !== "") {
			if (this.inPaste) {
				remaining = this.pasteEndPending + remaining;
				this.pasteEndPending = "";
				const end = remaining.indexOf(BRACKETED_PASTE_END);
				if (end < 0) {
					const partialLength = partialMarkerLength(remaining, BRACKETED_PASTE_END);
					this.appendPasted(partialLength === 0 ? remaining : remaining.slice(0, -partialLength));
					if (partialLength > 0) this.pasteEndPending = remaining.slice(-partialLength);
					return events;
				}
				this.appendPasted(remaining.slice(0, end));
				events.push(...decodePastedText(this.pasted));
				this.pasted = "";
				this.inPaste = false;
				remaining = remaining.slice(end + BRACKETED_PASTE_END.length);
				continue;
			}

			const start = remaining.indexOf(BRACKETED_PASTE_START);
			if (start >= 0) {
				events.push(...decodeRegularKeys(remaining.slice(0, start)));
				remaining = remaining.slice(start + BRACKETED_PASTE_START.length);
				this.inPaste = true;
				continue;
			}

			const partialLength = partialMarkerLength(remaining, BRACKETED_PASTE_START);
			if (partialLength > 0) {
				this.pending = remaining.slice(-partialLength);
				remaining = remaining.slice(0, -partialLength);
			}
			events.push(...decodeRegularKeys(remaining));
			return events;
		}

		return events;
	}

	flush(): KeyEvent[] {
		if (this.pending === "") return [];
		const pending = this.pending;
		this.pending = "";
		return decodeRegularKeys(pending);
	}

	private appendPasted(input: string): void {
		const available = MAX_PASTED_TEXT_LENGTH - this.pasted.length;
		if (available > 0) this.pasted += input.slice(0, available);
	}
}

/** Decode one complete chunk of raw terminal input into its key events. */
export function decodeKeys(input: string): KeyEvent[] {
	const decoder = new KeyDecoder();
	return [...decoder.push(input), ...decoder.flush()];
}

/** True when the event is Ctrl+C, which must always abandon the board. */
export function isInterrupt(key: KeyEvent): boolean {
	return key.ctrl && key.char === "c";
}
