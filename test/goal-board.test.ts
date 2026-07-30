import { describe, expect, it } from "vitest";
import type { BoardIntent } from "../src/tui/goal-board.ts";
import { GoalBoard } from "../src/tui/goal-board.ts";
import { decodeKeys } from "../src/tui/keys.ts";
import { createPalette } from "../src/tui/style.ts";
import { visibleWidth } from "../src/tui/text.ts";
import type { ProjectGoal } from "../src/types.ts";

const ESC = "\u001b";

function goal(overrides: Partial<ProjectGoal> & Pick<ProjectGoal, "id" | "title">): ProjectGoal {
	return {
		status: "open",
		createdAt: "2026-01-01T00:00:00.000Z",
		updatedAt: "2026-01-02T00:00:00.000Z",
		...overrides,
	};
}

const GOALS: ProjectGoal[] = [
	goal({
		id: "g-active",
		title: "Replace legacy authentication",
		status: "active",
		description: "Migrate every supported client onto the new token exchange before the old one is retired.",
		createdAt: "2026-01-01T00:00:00.000Z",
	}),
	goal({ id: "g-open-1", title: "Add focus mode", createdAt: "2026-01-02T00:00:00.000Z" }),
	goal({ id: "g-open-2", title: "日本語のタイトルです", createdAt: "2026-01-03T00:00:00.000Z" }),
	goal({ id: "g-done", title: "Ship the CLI", status: "done", createdAt: "2026-01-04T00:00:00.000Z" }),
	goal({ id: "g-archived", title: "Old idea", status: "archived", createdAt: "2026-01-05T00:00:00.000Z" }),
];

function createBoard(goals: ProjectGoal[] = GOALS, color = false): GoalBoard {
	return new GoalBoard({ palette: createPalette(color), repositoryLabel: "demo", goals });
}

/** Feed raw terminal input and collect every intent the board produced. */
function press(board: GoalBoard, input: string): BoardIntent[] {
	const intents: BoardIntent[] = [];
	for (const key of decodeKeys(input)) {
		const intent = board.handleKey(key);
		if (intent) intents.push(intent);
	}
	return intents;
}

function plainFrame(board: GoalBoard, width = 100, rows = 20): string[] {
	// Strip styling so assertions read as the user sees the board.
	// biome-ignore lint/suspicious/noControlCharactersInRegex: stripping the ESC byte is the point here.
	return board.render(width, rows).lines.map((line) => line.replace(/\u001b\[[0-9;]*m/g, ""));
}

const BORDER_CHARACTERS = ["│", "╭", "╰", "├", "┤", "╮", "╯", "┬", "┴"];

describe("goal board layout", () => {
	const sizes: Array<[number, number]> = [
		[120, 40],
		[100, 24],
		[80, 24],
		[76, 20],
		[75, 20],
		[60, 16],
		[44, 12],
		[30, 10],
		[20, 8],
	];

	for (const [width, rows] of sizes) {
		it(`fills exactly ${rows} rows without overflowing ${width} columns`, () => {
			const board = createBoard(GOALS, true);
			const frame = board.render(width, rows);
			expect(frame.lines).toHaveLength(rows);
			for (const line of frame.lines) {
				expect(visibleWidth(line)).toBeLessThanOrEqual(width);
			}
		});

		it(`aligns every box row to ${width} columns`, () => {
			const board = createBoard(GOALS, true);
			for (const line of board.render(width, rows).lines) {
				if (!BORDER_CHARACTERS.some((character) => line.includes(character))) continue;
				expect(visibleWidth(line), `misaligned row: ${JSON.stringify(line)}`).toBe(width);
			}
		});
	}

	it("splits into two panes when wide and stacks them when narrow", () => {
		expect(plainFrame(createBoard(), 100, 20).some((line) => line.includes("┬"))).toBe(true);
		expect(plainFrame(createBoard(), 60, 20).some((line) => line.includes("┬"))).toBe(false);
		expect(plainFrame(createBoard(), 60, 20).some((line) => line.includes("Detail"))).toBe(true);
	});

	it("keeps rows aligned when a title contains wide characters", () => {
		const board = createBoard(GOALS, true);
		press(board, `${ESC}[B${ESC}[B`);
		const frame = board.render(80, 20);
		expect(plainFrame(board, 80, 20).join("\n")).toContain("日本語");
		for (const line of frame.lines) {
			if (!line.includes("│")) continue;
			expect(visibleWidth(line)).toBe(80);
		}
	});
});

describe("goal board presentation", () => {
	it("shows active goals first, then open, then settled work", () => {
		const board = createBoard();
		press(board, "fff");
		const listed = plainFrame(board)
			.filter((line) => /[●○✓◌]/.test(line))
			.map((line) => line.replace(/^[^●○✓◌]*([●○✓◌])\s*/, "$1 ").trim());
		expect(listed[0]).toContain("Replace legacy authentication");
		expect(listed.at(-1)).toContain("Old idea");
	});

	it("summarizes every status even though the list is filtered", () => {
		const frame = plainFrame(createBoard());
		expect(frame.at(-2)?.trim()).toBe("1 active · 2 open · 1 done · 1 archived");
	});

	it("always keeps the help and quit hints in the key bar", () => {
		for (const width of [120, 100, 80, 60, 44, 30]) {
			const bar = plainFrame(createBoard(), width, 20).at(-1) ?? "";
			expect(bar, `width ${width}`).toContain("q quit");
			expect(bar, `width ${width}`).toContain("? keys");
		}
	});

	it("shows the selected goal's full description and identity in the detail pane", () => {
		const frame = plainFrame(createBoard()).join("\n");
		expect(frame).toContain("STATUS");
		expect(frame).toContain("ACTIVE");
		expect(frame).toContain("g-active");
		expect(frame).toContain("Migrate every supported client");
	});

	it("offers the right way out of each empty list", () => {
		const empty = createBoard([]);
		expect(plainFrame(empty).join("\n")).toContain("Press a to add one.");

		const archivedOnly = createBoard([goal({ id: "a", title: "Old", status: "archived" })]);
		expect(plainFrame(archivedOnly).join("\n")).toContain("Press f to change the filter.");

		const board = createBoard();
		press(board, "/zzzz");
		expect(plainFrame(board).join("\n")).toContain("Press esc to clear it.");
	});

	it("lists the complete key map in the help overlay", () => {
		const board = createBoard();
		press(board, "?");
		const frame = plainFrame(board, 100, 30).join("\n");
		expect(frame).toContain("Edit the description in $EDITOR");
		expect(frame).toContain("Delete permanently (asks first)");
		press(board, ESC);
		expect(plainFrame(board, 100, 30).join("\n")).not.toContain("Delete permanently");
	});
});

describe("goal board navigation", () => {
	it("moves the selection and jumps to the ends of the list", () => {
		const board = createBoard();
		expect(board.selectedGoal?.id).toBe("g-active");
		press(board, `${ESC}[B`);
		expect(board.selectedGoal?.id).toBe("g-open-1");
		press(board, "G");
		expect(board.selectedGoal?.id).toBe("g-open-2");
		press(board, "g");
		expect(board.selectedGoal?.id).toBe("g-active");
	});

	it("stops at the ends instead of wrapping", () => {
		const board = createBoard();
		press(board, `${ESC}[A${ESC}[A`);
		expect(board.selectedGoal?.id).toBe("g-active");
		press(board, "jjjjjjjj");
		expect(board.selectedGoal?.id).toBe("g-open-2");
	});

	it("scrolls the detail pane once it has focus, leaving the selection alone", () => {
		const board = createBoard(GOALS, false);
		const before = plainFrame(board, 60, 14);
		press(board, "\r");
		press(board, "jjj");
		expect(board.selectedGoal?.id).toBe("g-active");
		expect(plainFrame(board, 60, 14)).not.toEqual(before);
		press(board, ESC);
		press(board, "j");
		expect(board.selectedGoal?.id).toBe("g-open-1");
	});

	it("cycles the filter through open, done, archived, and all", () => {
		const board = createBoard();
		const label = () => plainFrame(board)[0];
		expect(label()).toContain("Open · 3 of 5");
		press(board, "f");
		expect(label()).toContain("Done · 1 of 5");
		press(board, "f");
		expect(label()).toContain("Archived · 1 of 5");
		press(board, "f");
		expect(label()).toContain("All · 5 of 5");
		press(board, "f");
		expect(label()).toContain("Open · 3 of 5");
	});

	it("narrows the list while typing a search and restores it on escape", () => {
		const board = createBoard();
		press(board, "/focus");
		expect(plainFrame(board)[0]).toContain("1 of 5");
		expect(board.selectedGoal?.id).toBe("g-open-1");
		press(board, "\r");
		expect(plainFrame(board)[0]).toContain("/focus");
		press(board, ESC);
		expect(plainFrame(board)[0]).toContain("Open · 3 of 5");
	});

	it("reopens a search prefilled so the query can be refined", () => {
		const board = createBoard();
		press(board, "/focus\r");
		press(board, "/");
		press(board, " mode");
		expect(plainFrame(board)[0]).toContain("1 of 5");
		press(board, "\r");
		expect(plainFrame(board)[0]).toContain("/focus mode");
	});

	it("reopens a grapheme search with its cursor in bounds", () => {
		const board = createBoard();
		press(board, "/🚀\r/");
		expect(() => board.render(100, 20)).not.toThrow();
	});

	it("abandons a refined search back to the committed query", () => {
		const board = createBoard();
		press(board, "/focus\r");
		press(board, "/ mode and more");
		press(board, ESC);
		expect(plainFrame(board)[0]).toContain("/focus");
		expect(plainFrame(board)[0]).toContain("1 of 5");
	});
});

describe("goal board editing", () => {
	it("adds a goal from the prompt", () => {
		const board = createBoard();
		expect(press(board, "a")).toEqual([]);
		const intents = press(board, "New goal\r");
		expect(intents).toEqual([
			{
				kind: "operation",
				operation: { scope: "project", action: "add", title: "New goal" },
				success: expect.stringContaining("New goal"),
			},
		]);
	});

	it("cancels an add on escape or empty input", () => {
		const board = createBoard();
		expect(press(board, `aNew goal${ESC}`)).toEqual([]);
		expect(press(board, "a   \r")).toEqual([]);
	});

	it("edits the prompt buffer with cursor and word keys", () => {
		const board = createBoard();
		press(board, "a");
		press(board, "one two");
		press(board, "\u0017");
		const [intent] = press(board, "three\r");
		expect(intent).toMatchObject({ operation: { title: "one three" } });
	});

	it("prefills a rename and treats an unchanged title as no work", () => {
		const board = createBoard();
		press(board, "e");
		expect(plainFrame(board).at(-2)).toContain("Replace legacy authentication");
		expect(press(board, "\r")).toEqual([]);

		// Ctrl+U clears the prefilled title so the new one replaces it outright.
		press(board, "e");
		expect(press(board, "\u0015Renamed\r")).toEqual([
			{
				kind: "operation",
				operation: { scope: "project", action: "update", id: "g-active", title: "Renamed" },
				success: expect.stringContaining("Renamed"),
			},
		]);
	});

	it("hands description editing to the runtime", () => {
		const board = createBoard();
		expect(press(board, "E")).toEqual([{ kind: "edit-description", goal: GOALS[0] }]);
	});

	it("reloads on demand", () => {
		expect(press(createBoard(), "R")).toEqual([{ kind: "reload" }]);
	});
});

describe("goal board lifecycle guardrails", () => {
	it("activates an open goal without asking, since that is not a lifecycle change", () => {
		const board = createBoard();
		press(board, `${ESC}[B`);
		expect(press(board, " ")).toEqual([
			{
				kind: "operation",
				operation: { scope: "project", action: "set_active", id: "g-open-1" },
				success: expect.any(String),
			},
		]);
	});

	it("asks before completing the active goal and passes confirm only after yes", () => {
		const board = createBoard();
		expect(press(board, " ")).toEqual([]);
		expect(plainFrame(board).at(-2)).toContain("Complete");
		expect(plainFrame(board).at(-2)).toContain("[y/N]");
		expect(press(board, "y")).toEqual([
			{
				kind: "operation",
				operation: { scope: "project", action: "complete", id: "g-active", confirm: true },
				success: expect.any(String),
			},
		]);
	});

	it("reopens a settled goal rather than completing it again", () => {
		const board = createBoard();
		press(board, "f");
		expect(board.selectedGoal?.id).toBe("g-done");
		press(board, " ");
		const [intent] = press(board, "y");
		expect(intent).toMatchObject({ operation: { action: "reopen", id: "g-done", confirm: true } });
	});

	it("cancels every lifecycle prompt unless the answer is exactly yes", () => {
		for (const answer of ["n", "N", "\r", ESC, " ", "x", "q"]) {
			const board = createBoard();
			press(board, " ");
			expect(press(board, answer), `answer ${JSON.stringify(answer)} must not confirm`).toEqual([]);
		}
	});

	it("requires confirmation before a permanent delete", () => {
		const board = createBoard();
		expect(press(board, "d")).toEqual([]);
		expect(plainFrame(board).at(-2)).toContain("cannot be undone");
		expect(press(board, "y")).toEqual([
			{
				kind: "operation",
				operation: { scope: "project", action: "delete", id: "g-active", confirm: true },
				success: expect.any(String),
			},
		]);
	});

	it("asks before archiving and before completing through the direct keys", () => {
		for (const [key, action] of [
			["c", "complete"],
			["r", "reopen"],
			["x", "archive"],
		] as const) {
			const board = createBoard();
			expect(press(board, key)).toEqual([]);
			const [intent] = press(board, "y");
			expect(intent).toMatchObject({ operation: { action, confirm: true } });
		}
	});

	it("refuses to re-activate the goal that is already active", () => {
		const board = createBoard();
		expect(press(board, "s")).toEqual([]);
		expect(plainFrame(board).at(-2)).toContain("Already the active goal");
	});
});

describe("goal board state after reload", () => {
	it("keeps the selection on the same goal", () => {
		const board = createBoard();
		press(board, `${ESC}[B`);
		board.setGoals([...GOALS].reverse());
		expect(board.selectedGoal?.id).toBe("g-open-1");
	});

	it("falls back to a neighbor when the selected goal disappears", () => {
		const board = createBoard();
		press(board, `${ESC}[B`);
		expect(board.selectedGoal?.id).toBe("g-open-1");
		board.setGoals(GOALS.filter((entry) => entry.id !== "g-open-1"));
		expect(board.selectedGoal?.id).toBe("g-open-2");
	});

	it("clears the selection when nothing is left", () => {
		const board = createBoard();
		board.setGoals([]);
		expect(board.selectedGoal).toBeUndefined();
		expect(plainFrame(board).join("\n")).toContain("No goal selected.");
	});

	it("shows a message set by the runtime", () => {
		const board = createBoard();
		board.setMessage("Something went wrong.", "error");
		expect(plainFrame(board).at(-2)).toContain("Something went wrong.");
	});
});

describe("goal board exit", () => {
	it("quits on q, on escape from the top level, and on ctrl+c from any mode", () => {
		expect(press(createBoard(), "q")).toEqual([{ kind: "quit" }]);
		expect(press(createBoard(), ESC)).toEqual([{ kind: "quit" }]);
		expect(press(createBoard(), "\u0003")).toEqual([{ kind: "quit" }]);
		expect(press(createBoard(), "a\u0003")).toEqual([{ kind: "quit" }]);
		expect(press(createBoard(), "d\u0003")).toEqual([{ kind: "quit" }]);
	});

	it("uses escape to back out of the detail pane and the search before quitting", () => {
		const board = createBoard();
		press(board, "\r");
		expect(press(board, ESC)).toEqual([]);
		press(board, "/focus\r");
		expect(press(board, ESC)).toEqual([]);
		expect(press(board, ESC)).toEqual([{ kind: "quit" }]);
	});
});
