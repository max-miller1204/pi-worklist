import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Text } from "@earendil-works/pi-tui";
import { WorklistParamsSchema } from "./schema.ts";
import { readProjectWorklist } from "./project-store.ts";
import { SessionStore } from "./session-store.ts";
import {
	executeWorklist,
	formatProjectGoals,
	formatSessionTasks,
	getProjectPath,
	WORKLIST_EXECUTION_MODE,
} from "./tool.ts";
import type { ProjectGoal, ProjectGoalStatus, SessionTaskStatus } from "./types.ts";
import { buildPromptSummary, buildWidgetLines, Dashboard, type DashboardAction } from "./ui.ts";

export interface ParsedCommand {
	scope: "session" | "project";
	action: string;
	id?: string;
	title?: string;
	description?: string;
	status?: SessionTaskStatus | ProjectGoalStatus;
	confirm?: boolean;
}

function parseTitleAndDescription(parts: string[]): Pick<ParsedCommand, "title" | "description"> {
	const separator = parts.indexOf("--");
	if (separator === -1) return { title: parts.join(" ") };
	return {
		title: parts.slice(0, separator).join(" "),
		description: parts.slice(separator + 1).join(" "),
	};
}

export function parseTasksCommand(args: string): ParsedCommand | null {
	const parts = args.trim().split(/\s+/).filter(Boolean);
	if (parts.length < 2 || !["session", "project"].includes(parts[0])) return null;
	const scope = parts.shift() as "session" | "project";
	const action = parts.shift();
	if (!action) return null;
	if (action === "list") return { scope, action };
	if (action === "add") return { scope, action, ...parseTitleAndDescription(parts) };
	if (action === "update") {
		const id = parts.shift();
		const details = parseTitleAndDescription(parts);
		return {
			scope,
			action,
			id,
			...(details.title ? { title: details.title } : {}),
			...(details.description !== undefined ? { description: details.description } : {}),
		};
	}
	if (action === "status")
		return { scope, action: "set_status", id: parts[0], status: parts[1] as ParsedCommand["status"] };
	if (["complete", "reopen", "archive", "delete", "set_active"].includes(action)) {
		return { scope, action, id: parts[0], confirm: scope === "project" && action !== "set_active" };
	}
	return null;
}

export default function worklistExtension(pi: ExtensionAPI): void {
	const sessionStore = new SessionStore(pi);
	let projectPath: string | null = null;
	let projectGoals: ProjectGoal[] = [];
	let latestContext: ExtensionContext | undefined;

	async function refreshProject(): Promise<void> {
		if (!projectPath) {
			projectGoals = [];
			return;
		}
		const result = await readProjectWorklist(projectPath);
		if (result.error) throw new Error(result.error);
		projectGoals = result.data.goals;
	}

	async function updateUi(ctx: ExtensionContext): Promise<void> {
		latestContext = ctx;
		await refreshProject();
		const lines = buildWidgetLines(sessionStore.getTasks(), projectGoals);
		if (!lines.length) ctx.ui.setWidget("pi-worklist", undefined);
		else if (ctx.mode === "tui") {
			ctx.ui.setWidget(
				"pi-worklist",
				(_tui, theme) =>
					new Text(
						lines.map((line, index) => (index === 0 ? theme.fg("accent", line) : line)).join("\n"),
						0,
						0,
					),
			);
		} else ctx.ui.setWidget("pi-worklist", lines);
	}

	async function execute(params: ParsedCommand, ctx: ExtensionContext) {
		const result = await executeWorklist(params, ctx, { sessionStore, projectPath });
		await updateUi(ctx);
		return result;
	}

	pi.registerTool({
		name: "worklist",
		label: "Worklist",
		description:
			"Manage branch-aware session tasks with optional descriptions or repository-wide project goals. Project complete, reopen, archive, and delete require confirm=true after explicit user intent.",
		promptSnippet: "Manage Session Tasks and repository-scoped Project Goals",
		promptGuidelines: [
			"Use worklist to maintain Session Tasks for multi-step work and update them as verified work progresses.",
			"Add a concise worklist description when a Session Task title does not capture important context or acceptance criteria.",
			"Use worklist with scope=project only when the user asks to manage the project roadmap.",
			"Never set worklist confirm=true for a project lifecycle action unless the user explicitly requested that exact completion, reopening, archival, or deletion.",
		],
		parameters: WorklistParamsSchema,
		executionMode: WORKLIST_EXECUTION_MODE,
		async execute(_id, params, _signal, _onUpdate, ctx) {
			const result = await executeWorklist(params, ctx, { sessionStore, projectPath });
			await updateUi(ctx);
			return { content: [{ type: "text", text: result.content }], details: result.details };
		},
		renderCall(args, theme) {
			return new Text(
				theme.fg("toolTitle", theme.bold("worklist ")) + theme.fg("muted", `${args.scope} ${args.action}`),
				0,
				0,
			);
		},
		renderResult(result, _options, theme) {
			const block = result.content.find((item) => item.type === "text");
			return new Text(theme.fg("muted", block?.type === "text" ? block.text : ""), 0, 0);
		},
	});

	async function handleDashboardAction(action: DashboardAction, ctx: ExtensionContext): Promise<boolean> {
		if (action.kind === "close") return false;
		if (action.kind === "add") {
			const title = await ctx.ui.input(
				`Add ${action.scope === "session" ? "session task" : "project goal"}`,
				"Title",
			);
			if (!title?.trim()) return true;
			const description = await ctx.ui.editor("Add description (optional)", "");
			if (description === undefined) return true;
			await execute(
				{
					scope: action.scope,
					action: "add",
					title: title.trim(),
					description: description.trim() || undefined,
				},
				ctx,
			);
			return true;
		}
		if (action.kind === "edit") {
			const item =
				action.scope === "session"
					? sessionStore.getTasks().find((candidate) => candidate.id === action.id)
					: projectGoals.find((candidate) => candidate.id === action.id);
			if (!item) return true;
			const title = await ctx.ui.input("Edit title (leave blank to keep)", item.title);
			if (title === undefined) return true;
			const description = await ctx.ui.editor("Edit description", item.description ?? "");
			if (description === undefined) return true;
			await execute(
				{
					scope: action.scope,
					action: "update",
					id: action.id,
					title: title.trim() || undefined,
					description: description.trim(),
				},
				ctx,
			);
			return true;
		}
		if (action.kind === "delete") {
			const confirmed = await ctx.ui.confirm("Delete item?", "This cannot be undone.");
			if (confirmed)
				await execute(
					{ scope: action.scope, action: "delete", id: action.id, confirm: action.scope === "project" },
					ctx,
				);
			return true;
		}
		if (action.scope === "session") {
			const task = sessionStore.getTasks().find((item) => item.id === action.id);
			if (task) {
				const status: SessionTaskStatus =
					task.status === "todo" ? "doing" : task.status === "doing" ? "done" : "todo";
				await execute({ scope: "session", action: "set_status", id: task.id, status }, ctx);
			}
			return true;
		}
		const goal = projectGoals.find((item) => item.id === action.id);
		if (!goal) return true;
		if (goal.status === "open") await execute({ scope: "project", action: "set_active", id: goal.id }, ctx);
		else {
			const actionName = goal.status === "active" ? "complete" : "reopen";
			const confirmed = await ctx.ui.confirm(`${actionName} project goal?`, goal.title);
			if (confirmed) await execute({ scope: "project", action: actionName, id: goal.id, confirm: true }, ctx);
		}
		return true;
	}

	pi.registerCommand("tasks", {
		description:
			"Open Worklist, or use: /tasks <session|project> <list|add|update|status|complete|reopen|archive|delete|set_active> ...",
		handler: async (args, ctx) => {
			if (args.trim()) {
				const parsed = parseTasksCommand(args);
				if (!parsed || (parsed.action === "add" && !parsed.title)) {
					ctx.ui.notify(
						"Usage: /tasks <session|project> <action> [id/status/title] [-- description]",
						"error",
					);
					return;
				}
				try {
					const result = await execute(parsed, ctx);
					ctx.ui.notify(result.content, "info");
				} catch (error) {
					ctx.ui.notify(String(error), "error");
				}
				return;
			}
			if (ctx.mode !== "tui") {
				ctx.ui.notify(
					`${formatSessionTasks(sessionStore.getTasks())}\n\n${formatProjectGoals(projectGoals)}`,
					"info",
				);
				return;
			}
			let again = true;
			while (again) {
				// Each dashboard action depends on the previous interaction and must run sequentially.
				// pi-lens-ignore: await-in-loop
				await refreshProject();
				const action = await ctx.ui.custom<DashboardAction>((tui, theme, _keys, done) => {
					const dashboard = new Dashboard(sessionStore.getTasks(), projectGoals, theme, done);
					return {
						render: (width) => dashboard.render(width),
						invalidate: () => dashboard.invalidate(),
						handleInput: (data) => {
							dashboard.handleInput(data);
							tui.requestRender();
						},
					};
				});
				again = action ? await handleDashboardAction(action, ctx) : false;
			}
		},
	});

	pi.on("session_start", async (_event, ctx) => {
		sessionStore.reconstruct(ctx);
		projectPath = getProjectPath(ctx.cwd);
		try {
			await updateUi(ctx);
		} catch (error) {
			ctx.ui.notify(String(error), "error");
		}
	});
	pi.on("session_tree", async (_event, ctx) => {
		sessionStore.reconstruct(ctx);
		try {
			await updateUi(ctx);
		} catch (error) {
			ctx.ui.notify(String(error), "error");
		}
	});
	pi.on("before_agent_start", async (event) => {
		const summary = buildPromptSummary(sessionStore.getTasks(), projectGoals);
		if (!summary) return;
		return { systemPrompt: `${event.systemPrompt}\n\n${summary}` };
	});
	pi.on("session_shutdown", () => {
		latestContext?.ui.setWidget("pi-worklist", undefined);
		latestContext = undefined;
	});
}
