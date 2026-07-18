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
import {
	buildPromptSummary,
	buildWidgetLines,
	Dashboard,
	type DashboardAction,
	type DashboardResult,
	type DashboardState,
} from "./ui.ts";

export interface ParsedCommand {
	scope: "session" | "project";
	action: string;
	id?: string;
	title?: string;
	description?: string;
	status?: SessionTaskStatus | ProjectGoalStatus;
	beforeId?: string;
	afterId?: string;
	confirm?: boolean;
}

export const WORKLIST_PROMPT_GUIDELINES = [
	"For non-trivial multi-step work, use worklist to create several small, concrete, independently completable Session Tasks before implementation, then update them as verified work progresses.",
	"Do not create one Session Task that merely restates the user's broad request or end goal. Broad outcomes belong in Project Goals; Session Tasks should name the next executable chunks.",
	"Keep Session Task titles concise and self-contained. Session Tasks do not have descriptions.",
	"Use worklist with scope=project only when the user asks to manage the project roadmap.",
	"Never set worklist confirm=true for a project lifecycle action unless the user explicitly requested that exact completion, reopening, archival, or deletion.",
] as const;

function parsePlacement(
	parts: string[],
): { parts: string[]; placement?: Pick<ParsedCommand, "beforeId" | "afterId"> } | null {
	const flag = parts[0];
	if (flag !== "--before" && flag !== "--after") {
		if (parts.some((part) => part === "--before" || part === "--after")) return null;
		return { parts };
	}
	const anchorId = parts[1];
	if (!anchorId || anchorId === "--" || anchorId === "--before" || anchorId === "--after") return null;
	const remaining = parts.slice(2);
	if (remaining.some((part) => part === "--before" || part === "--after")) return null;
	return {
		parts: remaining,
		placement: flag === "--before" ? { beforeId: anchorId } : { afterId: anchorId },
	};
}

function parseProjectDetails(parts: string[]): Pick<ParsedCommand, "title" | "description"> {
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
	const hasPlacementFlag = parts.some((part) => part === "--before" || part === "--after");
	if (action !== "add" && action !== "move" && hasPlacementFlag) return null;
	if (action === "list") return { scope, action };
	if (action === "add") {
		const parsed = parsePlacement(parts);
		if (!parsed) return null;
		if (scope === "session") {
			if (parsed.parts.includes("--")) return null;
			if (parsed.parts.length === 0) return null;
			return { scope, action, ...parsed.placement, title: parsed.parts.join(" ") };
		}
		return { scope, action, ...parsed.placement, ...parseProjectDetails(parsed.parts) };
	}
	if (action === "move") {
		const id = parts.shift();
		if (!id) return null;
		const parsed = parsePlacement(parts);
		if (!parsed?.placement || parsed.parts.length > 0) return null;
		return { scope, action, id, ...parsed.placement };
	}
	if (action === "update") {
		const id = parts.shift();
		if (scope === "session") {
			if (parts.includes("--")) return null;
			return { scope, action, id, ...(parts.length ? { title: parts.join(" ") } : {}) };
		}
		const details = parseProjectDetails(parts);
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
			"Manage branch-aware, ordered Session Tasks or repository-wide Project Goals. Session add accepts optional beforeId or afterId; session move requires exactly one. Project Goals cannot be reordered. Project complete, reopen, archive, and delete require confirm=true after explicit user intent.",
		promptSnippet: "Manage small Session Task chunks and repository-scoped Project Goals",
		promptGuidelines: [...WORKLIST_PROMPT_GUIDELINES],
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
		if (action.kind === "add" || action.kind === "insert") {
			const title = await ctx.ui.input(
				action.kind === "insert"
					? "Insert session task"
					: `Add ${action.scope === "session" ? "session task" : "project goal"}`,
				"Title",
			);
			if (!title?.trim()) return true;
			if (action.scope === "session") {
				await execute(
					{
						scope: "session",
						action: "add",
						title: title.trim(),
						...(action.kind === "insert" ? { beforeId: action.beforeId } : {}),
					},
					ctx,
				);
				return true;
			}
			const description = await ctx.ui.editor("Add description (optional)", "");
			await execute(
				{
					scope: "project",
					action: "add",
					title: title.trim(),
					description: description?.trim() || undefined,
				},
				ctx,
			);
			return true;
		}
		if (action.kind === "move") {
			await execute(
				{
					scope: "session",
					action: "move",
					id: action.id,
					...(action.beforeId !== undefined ? { beforeId: action.beforeId } : {}),
					...(action.afterId !== undefined ? { afterId: action.afterId } : {}),
				},
				ctx,
			);
			return true;
		}
		if (action.kind === "edit") {
			if (action.scope === "session") {
				const task = sessionStore.getTasks().find((candidate) => candidate.id === action.id);
				if (!task) return true;
				const title = await ctx.ui.input("Edit title (leave blank to keep)", task.title);
				if (title === undefined) return true;
				const nextTitle = title.trim() || undefined;
				if (nextTitle === undefined || nextTitle === task.title) return true;
				await execute({ scope: "session", action: "update", id: action.id, title: nextTitle }, ctx);
				return true;
			}
			const goal = projectGoals.find((candidate) => candidate.id === action.id);
			if (!goal) return true;
			const title = await ctx.ui.input("Edit title (leave blank to keep)", goal.title);
			if (title === undefined) return true;
			const nextTitle = title.trim() || undefined;
			const description = await ctx.ui.editor("Edit description", goal.description ?? "");
			if (description === undefined) return true;
			const nextDescription = description.trim();
			if (
				(nextTitle === undefined || nextTitle === goal.title) &&
				nextDescription === (goal.description ?? "")
			) {
				return true;
			}
			await execute(
				{
					scope: "project",
					action: "update",
					id: action.id,
					title: nextTitle,
					description: nextDescription,
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
			"Open Worklist, or use: /tasks <session|project> <list|add|move|update|status|complete|reopen|archive|delete|set_active> ...",
		handler: async (args, ctx) => {
			if (args.trim()) {
				const parsed = parseTasksCommand(args);
				if (!parsed || (parsed.action === "add" && !parsed.title)) {
					ctx.ui.notify(
						"Usage: /tasks <session|project> <action> [id/status/title] [-- project description]",
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
			let dashboardState: DashboardState | undefined;
			while (again) {
				// Each dashboard action depends on the previous interaction and must run sequentially.
				// pi-lens-ignore: await-in-loop
				await refreshProject();
				const result = await ctx.ui.custom<DashboardResult>((tui, theme, _keys, done) => {
					const dashboard = new Dashboard(sessionStore.getTasks(), projectGoals, theme, done, dashboardState);
					return {
						render: (width) => dashboard.render(width),
						invalidate: () => dashboard.invalidate(),
						handleInput: (data) => {
							dashboard.handleInput(data);
							tui.requestRender();
						},
					};
				});
				dashboardState = result?.state;
				again = result ? await handleDashboardAction(result.action, ctx) : false;
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
