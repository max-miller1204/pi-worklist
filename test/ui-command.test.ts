import type { Theme } from "@earendil-works/pi-coding-agent";
import { visibleWidth } from "@earendil-works/pi-tui";
import { describe, expect, it } from "vitest";
import { parseTasksCommand, WORKLIST_PROMPT_GUIDELINES } from "../src/extension.ts";
import type { ProjectGoal, SessionTask } from "../src/types.ts";
import {
	buildPromptSummary,
	buildWidgetLines,
	Dashboard,
	DashboardDetail,
	type DashboardResult,
	type DashboardState,
} from "../src/ui.ts";

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

	it("does not expose managed projection metadata in normal model context", () => {
		const managedTask = {
			id: "managed-task",
			title: "Projected work",
			status: "doing" as const,
			managed: {
				version: 1,
				owner: "pi-orchestrator",
				producer: { id: "pi-orchestrator", version: "producer-secret" },
				external: { system: "pi-orchestrator", kind: "workflow-step", id: "step-secret" },
				planRevision: 4,
				approvedPlanRevision: 3,
				createdAt: "2026-07-24T20:00:00.000Z",
				updatedAt: "2026-07-24T20:05:00.000Z",
				execution: {
					state: "running",
					updatedAt: "2026-07-24T20:05:00.000Z",
					runId: "run-secret",
					summary: "summary-secret",
					runReference: "run-reference-secret",
				},
				resultReference: "result-reference-secret",
				sessionContributionReference: "session-contribution-secret",
			},
		} as SessionTask;

		const summary = buildPromptSummary([managedTask], []);
		expect(summary).toContain("Projected work");
		for (const hiddenValue of [
			"producer-secret",
			"step-secret",
			"run-secret",
			"summary-secret",
			"run-reference-secret",
			"result-reference-secret",
			"session-contribution-secret",
		]) {
			expect(summary).not.toContain(hiddenValue);
		}
	});

	it("preserves canonical relative order when completed tasks are filtered", () => {
		const reordered = [tasks[4], tasks[0], tasks[2], tasks[1]];
		expect(buildWidgetLines(reordered, []).map((line) => line.slice(2))).toEqual([
			"Task 4",
			"Task 2",
			"Task 1",
		]);
		const summary = buildPromptSummary(reordered, []);
		expect(summary.indexOf("Task 4")).toBeLessThan(summary.indexOf("Task 2"));
		expect(summary.indexOf("Task 2")).toBeLessThan(summary.indexOf("Task 1"));
		expect(summary).not.toContain("Task 0");
	});

	it("hides an empty worklist", () => {
		expect(buildWidgetLines([], [])).toEqual([]);
		expect(buildPromptSummary([], [])).toBe("");
	});
});

function dashboardInput(
	data: string,
	initialState?: DashboardState,
	taskItems: SessionTask[] = tasks,
): DashboardResult | undefined {
	let result: DashboardResult | undefined;
	const dashboard = new Dashboard(
		taskItems,
		goals,
		{} as Theme,
		(value) => {
			result = value;
		},
		initialState,
	);
	dashboard.handleInput(data);
	return result;
}

describe("dashboard ordering controls", () => {
	it("opens details with Enter and reserves Space for status changes", () => {
		const state: DashboardState = { scope: "project", selectedId: "g1" };
		expect(dashboardInput("\r", state)).toEqual({
			action: { kind: "view", scope: "project", id: "g1" },
			state,
		});
		expect(dashboardInput(" ", state)).toEqual({
			action: { kind: "advance", scope: "project", id: "g1" },
			state,
		});
	});

	it("inserts before the selected Session Task and appends separately", () => {
		const state: DashboardState = { scope: "session", selectedId: "t3" };
		expect(dashboardInput("i", state)).toEqual({
			action: { kind: "insert", scope: "session", beforeId: "t3" },
			state,
		});
		expect(dashboardInput("a", state)).toEqual({
			action: { kind: "add", scope: "session" },
			state,
		});
	});

	it("moves the selected Session Task and preserves its selection", () => {
		const state: DashboardState = { scope: "session", selectedId: "t3" };
		expect(dashboardInput("\u001b[1;2A", state)).toEqual({
			action: { kind: "move", scope: "session", id: "t3", beforeId: "t2" },
			state,
		});
		expect(dashboardInput("\u001b[1;2B", state)).toEqual({
			action: { kind: "move", scope: "session", id: "t3", afterId: "t4" },
			state,
		});

		const reordered = [...tasks.slice(0, 2), tasks[3], tasks[2], ...tasks.slice(4)];
		expect(dashboardInput("a", state, reordered)).toEqual({
			action: { kind: "add", scope: "session" },
			state,
		});
	});

	it("does not expose insertion or movement in Project Goal scope", () => {
		const state: DashboardState = { scope: "project", selectedId: "g1" };
		expect(dashboardInput("i", state)).toBeUndefined();
		expect(dashboardInput("\u001b[1;2A", state)).toBeUndefined();
		expect(dashboardInput("a", state)).toEqual({
			action: { kind: "add", scope: "project" },
			state,
		});
	});
});

describe("dashboard detail view", () => {
	const theme = {
		fg: (_color: string, text: string) => text,
		bold: (text: string) => text,
	} as Theme;

	it("wraps and displays the complete Project Goal description", () => {
		const goal = {
			...goals[0],
			description:
				"A complete description that should wrap across several terminal lines without being truncated or hidden.\n\nSecond paragraph remains separate.",
		};
		const detail = new DashboardDetail({
			item: { scope: "project", goal },
			theme,
			terminalRows: () => 40,
			done: () => {},
		});
		const lines = detail.render(42);
		const output = lines.join("\n");

		expect(output).toContain("Project Goal Details");
		expect(output).toContain("A complete description that should");
		expect(output).toContain("wrap across several terminal lines");
		expect(output).toContain("Second paragraph remains separate.");
		expect(output).toContain(goal.id);
		expect(lines.every((line) => visibleWidth(line) <= 42)).toBe(true);
	});

	it("shows the associated Project Goal details for a Session Task", () => {
		const task = { ...tasks[1], goalId: goals[0].id };
		const detail = new DashboardDetail({
			item: { scope: "session", task, goal: goals[0] },
			theme,
			terminalRows: () => 40,
			done: () => {},
		});
		const output = detail.render(60).join("\n");

		expect(output).toContain("Session Task Details");
		expect(output).toContain("Associated Project Goal");
		expect(output).toContain(goals[0].description);
	});

	it("scrolls long details and closes with Escape", () => {
		let closed = false;
		const goal = { ...goals[0], description: "line ".repeat(200) };
		const detail = new DashboardDetail({
			item: { scope: "project", goal },
			theme,
			terminalRows: () => 12,
			done: () => {
				closed = true;
			},
		});
		const before = detail.render(42).join("\n");
		detail.handleInput("\u001b[B");
		const after = detail.render(42).join("\n");
		detail.handleInput("\u001b");

		expect(before).not.toBe(after);
		expect(after).toContain("above");
		expect(closed).toBe(true);
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

	it("parses relative insertion and movement", () => {
		expect(parseTasksCommand("session add --before task-1 write regression tests")).toEqual({
			scope: "session",
			action: "add",
			beforeId: "task-1",
			title: "write regression tests",
		});
		expect(parseTasksCommand("session add --after task-1 verify the fix")).toEqual({
			scope: "session",
			action: "add",
			afterId: "task-1",
			title: "verify the fix",
		});
		expect(parseTasksCommand("session move task-2 --before task-1")).toEqual({
			scope: "session",
			action: "move",
			id: "task-2",
			beforeId: "task-1",
		});
		expect(parseTasksCommand("session move task-2 --after task-1")).toEqual({
			scope: "session",
			action: "move",
			id: "task-2",
			afterId: "task-1",
		});
	});

	it("accepts a trailing anchor flag", () => {
		expect(parseTasksCommand("session add write regression tests --before task-1")).toEqual({
			scope: "session",
			action: "add",
			beforeId: "task-1",
			title: "write regression tests",
		});
		expect(parseTasksCommand("session add verify the fix --after task-1")).toEqual({
			scope: "session",
			action: "add",
			afterId: "task-1",
			title: "verify the fix",
		});
		expect(parseTasksCommand("project add another goal --after goal-1")).toEqual({
			scope: "project",
			action: "add",
			afterId: "goal-1",
			title: "another goal",
		});
	});

	it("rejects malformed or unsupported placement syntax", () => {
		expect(parseTasksCommand("session add --before task-1 --after task-2 title")).toBeNull();
		expect(parseTasksCommand("session add title --before task-1 --after task-2")).toBeNull();
		expect(parseTasksCommand("session add --before")).toBeNull();
		expect(parseTasksCommand("session add write tests --before")).toBeNull();
		expect(parseTasksCommand("session add write --before task-1 more tests")).toBeNull();
		expect(parseTasksCommand("session move task-1")).toBeNull();
		expect(parseTasksCommand("session move task-1 --before task-2 extra")).toBeNull();
		expect(parseTasksCommand("session list --before task-1")).toBeNull();
		expect(parseTasksCommand("session update task-1 --after task-2")).toBeNull();
		expect(parseTasksCommand("project delete goal-1 --before goal-2")).toBeNull();
	});

	it("passes Project Goal ordering syntax to runtime rejection", () => {
		expect(parseTasksCommand("project move goal-1 --before goal-2")).toEqual({
			scope: "project",
			action: "move",
			id: "goal-1",
			beforeId: "goal-2",
		});
		expect(parseTasksCommand("project add --after goal-1 another goal")).toEqual({
			scope: "project",
			action: "add",
			afterId: "goal-1",
			title: "another goal",
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
