/**
 * Colors for the standalone Project Goal board.
 *
 * Only the 8 basic ANSI colors plus their bright variants are used, so the board
 * inherits whatever palette the user configured in their terminal instead of
 * fighting it with hard-coded RGB. Every style is a plain function, and the
 * disabled palette returns identity functions, so callers never branch on
 * whether color is available.
 */

const CSI = "\u001b[";

export type Style = (text: string) => string;

export interface Palette {
	accent: Style;
	bold: Style;
	dim: Style;
	muted: Style;
	success: Style;
	warning: Style;
	danger: Style;
	border: Style;
	inverse: Style;
	/** True when the palette emits escape sequences. */
	readonly enabled: boolean;
}

function sgr(open: number, close: number): Style {
	const prefix = `${CSI}${open}m`;
	const suffix = `${CSI}${close}m`;
	return (text: string) => (text === "" ? text : `${prefix}${text}${suffix}`);
}

const identity: Style = (text) => text;

export interface ColorSupportEnvironment {
	NO_COLOR?: string;
	FORCE_COLOR?: string;
	TERM?: string;
}

/**
 * Decide whether to emit color.
 *
 * `NO_COLOR` wins over everything per the no-color.org convention; `FORCE_COLOR`
 * then overrides TTY detection so the board can be exercised through a pipe in
 * tests. Otherwise color follows the output stream being a terminal.
 */
export function supportsColor(
	stream: { isTTY?: boolean } | undefined,
	env: ColorSupportEnvironment,
): boolean {
	if (env.NO_COLOR !== undefined && env.NO_COLOR !== "") return false;
	if (env.FORCE_COLOR !== undefined && env.FORCE_COLOR !== "") return env.FORCE_COLOR !== "0";
	if (env.TERM === "dumb") return false;
	return stream?.isTTY === true;
}

export function createPalette(enabled: boolean): Palette {
	if (!enabled) {
		return {
			accent: identity,
			bold: identity,
			dim: identity,
			muted: identity,
			success: identity,
			warning: identity,
			danger: identity,
			border: identity,
			inverse: identity,
			enabled: false,
		};
	}
	return {
		accent: sgr(36, 39),
		bold: sgr(1, 22),
		dim: sgr(2, 22),
		muted: sgr(90, 39),
		success: sgr(32, 39),
		warning: sgr(33, 39),
		danger: sgr(31, 39),
		border: sgr(90, 39),
		inverse: sgr(7, 27),
		enabled: true,
	};
}
