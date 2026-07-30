import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import { describe, expect, it } from "vitest";
import { decodeKeys, isInterrupt, KeyDecoder } from "../src/tui/keys.ts";
import { createPalette, supportsColor } from "../src/tui/style.ts";
import { Terminal } from "../src/tui/terminal.ts";
import { fitToWidth, singleLine, truncateToWidth, visibleWidth, wrapText } from "../src/tui/text.ts";

const ESC = "\u001b";
const ACCENT = `${ESC}[36m`;
const RESET_FOREGROUND = `${ESC}[39m`;

describe("terminal text measurement", () => {
	it("counts plain characters as one cell each", () => {
		expect(visibleWidth("hello")).toBe(5);
		expect(visibleWidth("")).toBe(0);
	});

	it("ignores styling when measuring", () => {
		expect(visibleWidth(`${ACCENT}hello${RESET_FOREGROUND}`)).toBe(5);
	});

	it("counts East Asian characters as two cells", () => {
		expect(visibleWidth("日本語")).toBe(6);
		expect(visibleWidth("ab日")).toBe(4);
	});

	it("counts a combining mark as part of its base character", () => {
		expect(visibleWidth("é")).toBe(1);
		expect(visibleWidth("café")).toBe(4);
	});

	it("counts emoji and flags as two cells", () => {
		expect(visibleWidth("🚀")).toBe(2);
		expect(visibleWidth("🇺🇸")).toBe(2);
		// A base character promoted to emoji presentation widens to two cells.
		expect(visibleWidth("❤️")).toBe(2);
	});
});

describe("truncateToWidth", () => {
	it("leaves text that already fits untouched", () => {
		expect(truncateToWidth("hello", 10)).toBe("hello");
		expect(truncateToWidth("hello", 5)).toBe("hello");
	});

	it("cuts to the requested width including the ellipsis", () => {
		const result = truncateToWidth("abcdefghij", 5);
		expect(visibleWidth(result)).toBe(5);
		expect(result).toBe("abcd…");
	});

	it("never splits a wide character across the boundary", () => {
		// The budget is 3 cells but 日 needs 2, so only one fits before the ellipsis.
		const result = truncateToWidth("日本語", 4);
		expect(visibleWidth(result)).toBe(4);
		expect(result).toContain("日");
		expect(result).not.toContain("本");
	});

	it("closes styling it may have cut in half", () => {
		const result = truncateToWidth(`${ACCENT}abcdefghij${RESET_FOREGROUND}`, 5);
		expect(result.endsWith(`${ESC}[0m`)).toBe(true);
		expect(visibleWidth(result)).toBe(5);
	});

	it("returns nothing for a non-positive width", () => {
		expect(truncateToWidth("abc", 0)).toBe("");
	});
});

describe("fitToWidth", () => {
	it("pads short text and truncates long text to an exact width", () => {
		expect(fitToWidth("ab", 5)).toBe("ab   ");
		expect(visibleWidth(fitToWidth("abcdefgh", 5))).toBe(5);
		expect(visibleWidth(fitToWidth("日本語", 4))).toBe(4);
	});
});

describe("wrapText", () => {
	it("wraps on word boundaries", () => {
		expect(wrapText("the quick brown fox", 10)).toEqual(["the quick", "brown fox"]);
	});

	it("preserves explicit line and paragraph breaks", () => {
		expect(wrapText("one\n\ntwo", 20)).toEqual(["one", "", "two"]);
		expect(wrapText("one\r\ntwo", 20)).toEqual(["one", "two"]);
	});

	it("breaks a word that cannot fit on a line of its own", () => {
		const lines = wrapText("supercalifragilistic", 8);
		expect(lines).toEqual(["supercal", "ifragili", "stic"]);
		for (const line of lines) expect(visibleWidth(line)).toBeLessThanOrEqual(8);
	});

	it("keeps every line within the requested width for wide characters", () => {
		for (const line of wrapText("日本語 のテキスト を折り返す", 7)) {
			expect(visibleWidth(line)).toBeLessThanOrEqual(7);
		}
	});
});

describe("singleLine", () => {
	it("collapses whitespace so a value fits one row", () => {
		expect(singleLine("  a\n\tb   c ")).toBe("a b c");
	});
});

describe("key decoding", () => {
	it("decodes arrow keys in both normal and application mode", () => {
		expect(decodeKeys(`${ESC}[A`)[0]).toMatchObject({ name: "up" });
		expect(decodeKeys(`${ESC}[B`)[0]).toMatchObject({ name: "down" });
		expect(decodeKeys(`${ESC}OC`)[0]).toMatchObject({ name: "right" });
		expect(decodeKeys(`${ESC}OD`)[0]).toMatchObject({ name: "left" });
	});

	it("decodes navigation and editing keys", () => {
		expect(decodeKeys(`${ESC}[5~`)[0]).toMatchObject({ name: "pageup" });
		expect(decodeKeys(`${ESC}[6~`)[0]).toMatchObject({ name: "pagedown" });
		expect(decodeKeys(`${ESC}[3~`)[0]).toMatchObject({ name: "delete" });
		expect(decodeKeys(`${ESC}[H`)[0]).toMatchObject({ name: "home" });
		expect(decodeKeys(`${ESC}[F`)[0]).toMatchObject({ name: "end" });
		expect(decodeKeys("\r")[0]).toMatchObject({ name: "enter" });
		expect(decodeKeys("\t")[0]).toMatchObject({ name: "tab" });
		expect(decodeKeys("\u007f")[0]).toMatchObject({ name: "backspace" });
		expect(decodeKeys(" ")[0]).toMatchObject({ name: "space", char: " " });
	});

	it("decodes modifier bitmasks on arrow keys", () => {
		expect(decodeKeys(`${ESC}[1;2A`)[0]).toMatchObject({ name: "up", shift: true, ctrl: false });
		expect(decodeKeys(`${ESC}[1;5B`)[0]).toMatchObject({ name: "down", ctrl: true, shift: false });
	});

	it("decodes a lone escape byte as the Escape key", () => {
		expect(decodeKeys(ESC)).toEqual([
			{ name: "escape", sequence: ESC, ctrl: false, alt: false, shift: false },
		]);
	});

	it("resolves escape ambiguity in favor of the Escape key", () => {
		// Alt is bound nowhere, so ESC followed by a printable must not be swallowed
		// as one chord: pressing Escape then q has to still reach q.
		expect(decodeKeys(`${ESC}q`).map((key) => key.name)).toEqual(["escape", "char"]);
		expect(decodeKeys(`${ESC}${ESC}`).map((key) => key.name)).toEqual(["escape", "escape"]);
	});

	it("decodes Ctrl chords as control characters", () => {
		const [key] = decodeKeys("\u0003");
		expect(key).toMatchObject({ name: "char", char: "c", ctrl: true });
		expect(isInterrupt(key)).toBe(true);
		expect(isInterrupt(decodeKeys("c")[0])).toBe(false);
	});

	it("splits a pasted chunk into one event per grapheme", () => {
		const keys = decodeKeys("ab日");
		expect(keys.map((key) => key.char)).toEqual(["a", "b", "日"]);
		expect(decodeKeys("é").map((key) => key.char)).toEqual(["é"]);
	});

	it("keeps ordering across mixed control and printable input", () => {
		expect(decodeKeys(`a${ESC}[Ab\r`).map((key) => key.name)).toEqual(["char", "up", "char", "enter"]);
	});

	it("decodes bracketed paste across every marker boundary", () => {
		const input = `${ESC}[200~pasted${ESC}[201~q`;
		const boundaries = [
			1,
			3,
			`${ESC}[200~`.length - 1,
			`${ESC}[200~pasted${ESC}`.length,
			`${ESC}[200~pasted${ESC}[20`.length,
			input.length - 2,
		];

		for (const boundary of boundaries) {
			const decoder = new KeyDecoder();
			const keys = [
				...decoder.push(input.slice(0, boundary)),
				...decoder.push(input.slice(boundary)),
				...decoder.flush(),
			];
			expect(
				keys.filter((key) => key.paste).map((key) => key.char),
				`boundary ${boundary}`,
			).toEqual(["p", "a", "s", "t", "e", "d"]);
			expect(keys.at(-1), `boundary ${boundary}`).toMatchObject({ char: "q" });
			expect(keys.at(-1)?.paste, `boundary ${boundary}`).toBeUndefined();
		}
	});
});

describe("terminal rendering", () => {
	it("strips terminal controls while preserving generated SGR styling", () => {
		const input = new PassThrough();
		const chunks: string[] = [];
		const output = Object.assign(new EventEmitter(), {
			columns: 80,
			rows: 6,
			write: (chunk: string) => chunks.push(chunk),
		});
		const terminal = new Terminal({ input, output });
		terminal.open();
		terminal.render({
			lines: [`${ESC}[31mred${ESC}[39m ${ESC}]0;owned\u0007title ${ESC}[5nprobe`],
		});
		terminal.close();

		const rendered = chunks.join("");
		expect(rendered).toContain(`${ESC}[31mred${ESC}[39m`);
		expect(rendered).not.toContain(`${ESC}]0;owned`);
		expect(rendered).not.toContain(`${ESC}[5n`);
	});
});

describe("color support", () => {
	it("honors NO_COLOR above every other signal", () => {
		expect(supportsColor({ isTTY: true }, { NO_COLOR: "1", FORCE_COLOR: "1" })).toBe(false);
	});

	it("lets FORCE_COLOR override TTY detection in both directions", () => {
		expect(supportsColor({ isTTY: false }, { FORCE_COLOR: "1" })).toBe(true);
		expect(supportsColor({ isTTY: true }, { FORCE_COLOR: "0" })).toBe(false);
	});

	it("follows the stream otherwise, and refuses a dumb terminal", () => {
		expect(supportsColor({ isTTY: true }, {})).toBe(true);
		expect(supportsColor({ isTTY: false }, {})).toBe(false);
		expect(supportsColor(undefined, {})).toBe(false);
		expect(supportsColor({ isTTY: true }, { TERM: "dumb" })).toBe(false);
	});

	it("emits nothing measurable when disabled", () => {
		const plain = createPalette(false);
		expect(plain.accent("x")).toBe("x");
		expect(plain.enabled).toBe(false);
		const colored = createPalette(true);
		expect(colored.accent("x")).not.toBe("x");
		expect(visibleWidth(colored.accent("x"))).toBe(1);
	});
});
