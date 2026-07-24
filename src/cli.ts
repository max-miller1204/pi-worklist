#!/usr/bin/env node
import { formatProjectGoals } from "./format.ts";
import { getWorklistPath, resolveGitRoot } from "./git.ts";
import {
	activateProjectGoal,
	addProjectGoal,
	deleteProjectGoal,
	listProjectGoals,
	ProjectGoalActivationBlockedError,
	transitionProjectGoal,
	updateProjectGoal,
} from "./project-mutations.ts";
import type { ProjectGoal, ProjectGoalStatus } from "./types.ts";

/**
 * Pi-free command line for Project Goals, so external agents and scripts can
 * manage `<git-root>/.pi/worklist.json` through the same mutation service,
 * cross-process lock, and atomic replacement as a live Pi session.
 *
 * Session Tasks are deliberately out of scope: they live inside a Pi session
 * tree and have no meaning outside one.
 */

const LIFECYCLE_ACTIONS = ["complete", "reopen", "archive", "delete"] as const;
type LifecycleAction = (typeof LIFECYCLE_ACTIONS)[number];

const USAGE = `Usage: pi-worklist project <action> [arguments] [flags]

Actions:
  list                                     Show all project goals
  add <title...> [-- <description...>]     Add an open goal
  update <id> [title...] [-- <description...>]
                                           Edit a goal; "-- " alone clears the description
  set_active <id>                          Make a goal the single active goal
  complete <id> --confirm                  Mark a goal done
  reopen <id> --confirm                    Reopen a done or archived goal
  archive <id> --confirm                   Archive a goal
  delete <id> --confirm                    Delete a goal permanently

Flags:
  --json         Print the result as JSON on stdout
  --confirm      Acknowledge a lifecycle action; pass it only for an explicit user request
  --cwd <dir>    Resolve the git root from this directory instead of the working directory

Exit codes: 0 success, 1 error, 2 usage error, 3 confirmation required.
Errors are always written to stderr; --json output is emitted only on success.`;

interface CliInvocation {
	scope: string;
	action: string;
	rest: string[];
	description?: string;
	json: boolean;
	confirm: boolean;
	cwd: string;
}

function fail(message: string, code: number): never {
	process.stderr.write(`${message}\n`);
	process.exit(code);
}

function parseArgs(argv: string[]): CliInvocation {
	const separator = argv.indexOf("--");
	const head = separator === -1 ? argv : argv.slice(0, separator);
	const description = separator === -1 ? undefined : argv.slice(separator + 1).join(" ");

	const positionals: string[] = [];
	let json = false;
	let confirm = false;
	let cwd = process.cwd();
	for (let index = 0; index < head.length; index++) {
		const part = head[index];
		if (part === "--json") json = true;
		else if (part === "--confirm") confirm = true;
		else if (part === "--cwd") {
			const value = head[index + 1];
			if (!value) fail(`--cwd requires a directory\n\n${USAGE}`, 2);
			cwd = value;
			index++;
		} else if (part.startsWith("--")) fail(`Unknown flag ${part}\n\n${USAGE}`, 2);
		else positionals.push(part);
	}

	const [scope, action, ...rest] = positionals;
	if (!scope || !action) fail(USAGE, 2);
	return { scope, action, rest, description, json, confirm, cwd };
}

function resolveProjectPath(cwd: string): string {
	const result = resolveGitRoot(cwd);
	if (!result.isGit || !result.root) {
		fail("Project goals require a git repository. Run inside a repository or pass --cwd <dir>.", 1);
	}
	return getWorklistPath(result.root);
}

function requireId(invocation: CliInvocation): string {
	const id = invocation.rest[0];
	if (!id) fail(`project ${invocation.action} requires a goal id\n\n${USAGE}`, 2);
	return id;
}

function report(invocation: CliInvocation, message: string, goals: ProjectGoal[], goal?: ProjectGoal): void {
	if (invocation.json) {
		const payload: Record<string, unknown> = { ok: true, action: invocation.action, goals };
		if (goal) payload.goal = goal;
		process.stdout.write(`${JSON.stringify(payload, null, 2)}\n`);
		return;
	}
	process.stdout.write(`${message}\n`);
}

async function runLifecycle(
	invocation: CliInvocation,
	projectPath: string,
	action: LifecycleAction,
): Promise<void> {
	const id = requireId(invocation);
	if (!invocation.confirm) {
		fail(
			`project ${action} is a lifecycle action and requires --confirm. ` +
				"Pass --confirm only when the user explicitly requested this action.",
			3,
		);
	}
	if (action === "delete") {
		const { goals } = await deleteProjectGoal(projectPath, id);
		report(invocation, `Deleted project goal ${id}`, goals);
		return;
	}
	const status: ProjectGoalStatus =
		action === "complete" ? "done" : action === "reopen" ? "open" : "archived";
	const { goal, goals } = await transitionProjectGoal(projectPath, id, status);
	report(invocation, `Project goal ${goal.id} is now ${goal.status}`, goals, goal);
}

async function run(invocation: CliInvocation): Promise<void> {
	if (invocation.scope !== "project") {
		if (invocation.scope === "session") {
			fail("Session Tasks live inside a Pi session and cannot be managed externally. Use /tasks in Pi.", 2);
		}
		fail(`Unknown scope ${invocation.scope}\n\n${USAGE}`, 2);
	}
	const projectPath = resolveProjectPath(invocation.cwd);

	switch (invocation.action) {
		case "list": {
			const goals = await listProjectGoals(projectPath);
			report(invocation, formatProjectGoals(goals), goals);
			return;
		}
		case "add": {
			const title = invocation.rest.join(" ").trim();
			if (!title) fail(`project add requires a title\n\n${USAGE}`, 2);
			const description = invocation.description?.trim() || undefined;
			const { goal, goals } = await addProjectGoal(projectPath, title, description);
			report(invocation, `Added project goal ${goal.id}: ${goal.title}`, goals, goal);
			return;
		}
		case "update": {
			const id = requireId(invocation);
			const title = invocation.rest.slice(1).join(" ").trim() || undefined;
			if (title === undefined && invocation.description === undefined) {
				fail(`project update requires a new title, a -- description, or both\n\n${USAGE}`, 2);
			}
			const { goal, goals } = await updateProjectGoal(projectPath, id, {
				title,
				description: invocation.description,
			});
			report(invocation, `Updated project goal ${goal.id}`, goals, goal);
			return;
		}
		case "set_active": {
			const id = requireId(invocation);
			try {
				const { goal, goals } = await activateProjectGoal(projectPath, id);
				report(invocation, `Activated project goal ${goal.id}`, goals, goal);
			} catch (error) {
				if (error instanceof ProjectGoalActivationBlockedError) {
					fail(`${error.message}. Reopen it first: pi-worklist project reopen ${id} --confirm`, 1);
				}
				throw error;
			}
			return;
		}
		case "complete":
		case "reopen":
		case "archive":
		case "delete":
			await runLifecycle(invocation, projectPath, invocation.action);
			return;
		default:
			fail(`Unknown project action ${invocation.action}\n\n${USAGE}`, 2);
	}
}

try {
	await run(parseArgs(process.argv.slice(2)));
} catch (error) {
	fail(error instanceof Error ? error.message : String(error), 1);
}
