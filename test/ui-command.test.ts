import { describe, expect, it } from "vitest";
import { buildPromptSummary, buildWidgetLines } from "../src/ui.ts";
import { parseTasksCommand, WORKLIST_PROMPT_GUIDELINES } from "../src/extension.ts";
import type { ProjectGoal, SessionTask } from "../src/types.ts";

const tasks: SessionTask[] = Array.from({ length: 6 }, (_, index) => ({
	id: `t${index}`,
	title: `Task ${index}`,
	status: index === 0 ? "done" : index === 1 ? "doing" : "todo",
}));
const goals: ProjectGoal[] = [
	{
		id: "g1",
		title: "Ship v1",
		description: "Release the first stable version",
		status: "active",
		createdAt: "2026-01-01T00:00:00Z",
		updatedAt: "2026-01-01T00:00:00Z",
	},
];

describe("widget and prompt summary", () => {
	it("caps the widget and hides completed tasks", () => {
		const lines = buildWidgetLines(tasks, goals);
		expect(lines).toHaveLength(5);
		expect(lines.join("\n")).not.toContain("Task 0");
		expect(lines.at(-1)).toBe("+2 more");
	});

	it("caps prompt task detail", () => {
		const summary = buildPromptSummary(tasks, goals, 2);
		expect(summary).toContain("Ship v1 - Release the first stable version");
		expect(summary).toContain("Task 1");
		expect(summary).toContain("and 3 more");
		expect(summary).not.toContain("Task 4");
	});

	it("hides an empty worklist", () => {
		expect(buildWidgetLines([], [])).toEqual([]);
		expect(buildPromptSummary([], [])).toBe("");
	});
});

describe("command parser", () => {
	it("keeps multi-word titles", () => {
		expect(parseTasksCommand("session add write regression tests")).toMatchObject({
			scope: "session",
			action: "add",
			title: "write regression tests",
		});
	});

	it("rejects descriptions for session tasks", () => {
		expect(parseTasksCommand("session add write regression tests -- Cover RPC and TUI usage")).toBeNull();
		expect(parseTasksCommand("session update task-1 -- Replacement context")).toBeNull();
	});

	it("parses optional project goal descriptions", () => {
		expect(parseTasksCommand("project add ship stable release -- Cover RPC and TUI usage")).toEqual({
			scope: "project",
			action: "add",
			title: "ship stable release",
			description: "Cover RPC and TUI usage",
		});
		expect(parseTasksCommand("project update goal-1 -- Replacement context")).toEqual({
			scope: "project",
			action: "update",
			id: "goal-1",
			description: "Replacement context",
		});
	});

	it("treats typed project lifecycle commands as explicit intent", () => {
		expect(parseTasksCommand("project complete goal-1")).toEqual({
			scope: "project",
			action: "complete",
			id: "goal-1",
			confirm: true,
		});
	});

	it("rejects unknown syntax", () => {
		expect(parseTasksCommand("global add nope")).toBeNull();
	});
});

describe("model guidance", () => {
	it("directs agents to split broad work into small session chunks", () => {
		const guidance = WORKLIST_PROMPT_GUIDELINES.join("\n");
		expect(guidance).toContain("several small, concrete, independently completable Session Tasks");
		expect(guidance).toContain("Do not create one Session Task");
		expect(guidance).toContain("Session Tasks do not have descriptions");
		expect(guidance).toContain("Broad outcomes belong in Project Goals");
	});
});
