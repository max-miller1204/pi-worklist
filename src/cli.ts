#!/usr/bin/env node
import {
	WorklistApplicationError,
	type WorklistApplicationResult,
	WorklistApplicationService,
	type WorklistOperation,
} from "./application-service.ts";
import { renderCliUsage } from "./cli-contract.ts";
import { getWorklistPath, resolveGitRoot } from "./git.ts";
import { WORKLIST_ERROR_CODES, type WorklistErrorCode } from "./integration-contract.ts";
import type { ProjectGoal } from "./types.ts";

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

const COMPACT_TITLE_LIMIT = 96;

const USAGE = renderCliUsage();

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

function exitCodeForError(code: WorklistErrorCode): number {
	if (code === WORKLIST_ERROR_CODES.APPROVAL_REQUIRED) return 3;
	if (code === WORKLIST_ERROR_CODES.CONFLICT) return 4;
	return 1;
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
			if (!value || value.startsWith("--")) fail(`--cwd requires a directory\n\n${USAGE}`, 2);
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

function compactTitle(title: string): string {
	const flattened = title.replace(/\s+/g, " ").trim();
	if (flattened.length <= COMPACT_TITLE_LIMIT) return flattened;
	return `${flattened.slice(0, COMPACT_TITLE_LIMIT - 1)}…`;
}

/** Compact bounded list line: one goal per line, no descriptions. */
function formatGoalLine(goal: ProjectGoal): string {
	return `[${goal.status}] ${goal.id}: ${compactTitle(goal.title)}`;
}

function formatGoalList(goals: ProjectGoal[]): string {
	if (goals.length === 0) return "No project goals.";
	return goals.map(formatGoalLine).join("\n");
}

/** Explicit full-detail read: every stored field, including the complete description. */
function formatGoalDetail(goal: ProjectGoal): string {
	return [
		`${goal.id}: ${goal.title}`,
		`status: ${goal.status}`,
		`created: ${goal.createdAt}`,
		`updated: ${goal.updatedAt}`,
		...(goal.description !== undefined ? ["description:", goal.description] : []),
	].join("\n");
}

async function executeCliOperation(
	service: WorklistApplicationService,
	operation: WorklistOperation,
): Promise<WorklistApplicationResult> {
	const envelope = await service.execute(operation, { source: "cli" });
	if (!envelope.ok) throw new WorklistApplicationError(envelope.error);
	return envelope;
}

function report(invocation: CliInvocation, envelope: WorklistApplicationResult, message: string): void {
	if (invocation.json) {
		process.stdout.write(`${JSON.stringify(envelope, null, 2)}\n`);
		return;
	}
	process.stdout.write(`${message}\n`);
}

async function runLifecycle(
	invocation: CliInvocation,
	service: WorklistApplicationService,
	action: LifecycleAction,
): Promise<void> {
	const id = requireId(invocation);
	const envelope = await executeCliOperation(service, {
		scope: "project",
		action,
		id,
		confirm: invocation.confirm,
	});
	if (action === "delete") {
		report(invocation, envelope, `Deleted project goal ${id}`);
		return;
	}
	const goal = envelope.ok ? envelope.result.goal : undefined;
	if (!goal) throw new Error(`Project goal ${id} was not returned after ${action}`);
	report(invocation, envelope, `Project goal ${goal.id} is now ${goal.status}`);
}

async function runSetActive(invocation: CliInvocation, service: WorklistApplicationService): Promise<void> {
	const id = requireId(invocation);
	try {
		const envelope = await executeCliOperation(service, { scope: "project", action: "set_active", id });
		const goal = envelope.ok ? envelope.result.goal : undefined;
		if (!goal) throw new Error(`Activated Project Goal ${id} was not returned`);
		report(invocation, envelope, `Activated project goal ${goal.id}`);
	} catch (error) {
		if (error instanceof Error && error.message.includes("must be reopened")) {
			fail(`${error.message} Reopen it first: pi-worklist project reopen ${id} --confirm`, 1);
		}
		throw error;
	}
}

async function run(invocation: CliInvocation): Promise<void> {
	if (invocation.scope !== "project") {
		if (invocation.scope === "session") {
			fail("Session Tasks live inside a Pi session and cannot be managed externally. Use /tasks in Pi.", 2);
		}
		fail(`Unknown scope ${invocation.scope}\n\n${USAGE}`, 2);
	}
	const service = new WorklistApplicationService({ projectPath: resolveProjectPath(invocation.cwd) });

	switch (invocation.action) {
		case "help": {
			process.stdout.write(`${USAGE}\n`);
			return;
		}
		case "list": {
			const envelope = await executeCliOperation(service, { scope: "project", action: "list" });
			const goals = (envelope.ok ? envelope.result.goals : undefined) ?? [];
			report(invocation, envelope, formatGoalList(goals));
			return;
		}
		case "show": {
			const id = requireId(invocation);
			const envelope = await executeCliOperation(service, { scope: "project", action: "list" });
			const goal = envelope.ok ? envelope.result.goals?.find((candidate) => candidate.id === id) : undefined;
			if (!goal) {
				throw new WorklistApplicationError({
					code: WORKLIST_ERROR_CODES.NOT_FOUND,
					message: `Project goal ${id} was not found.`,
					retryable: false,
					details: { entity: "project-goal", id, resolution: "refresh-and-select-existing" },
				});
			}
			const detailEnvelope: WorklistApplicationResult = {
				ok: true,
				scope: "project",
				action: "show",
				result: { scope: "project", action: "show", goal },
				meta: envelope.meta,
			};
			report(invocation, detailEnvelope, formatGoalDetail(goal));
			return;
		}
		case "add": {
			const title = invocation.rest.join(" ").trim();
			if (!title) fail(`project add requires a title\n\n${USAGE}`, 2);
			const description = invocation.description?.trim() || undefined;
			const envelope = await executeCliOperation(service, {
				scope: "project",
				action: "add",
				title,
				description,
			});
			const goal = envelope.ok ? envelope.result.goal : undefined;
			if (!goal) throw new Error("Added Project Goal was not returned");
			report(invocation, envelope, `Added project goal ${goal.id}: ${goal.title}`);
			return;
		}
		case "update": {
			const id = requireId(invocation);
			const title = invocation.rest.slice(1).join(" ").trim() || undefined;
			if (title === undefined && invocation.description === undefined) {
				fail(`project update requires a new title, a -- description, or both\n\n${USAGE}`, 2);
			}
			const envelope = await executeCliOperation(service, {
				scope: "project",
				action: "update",
				id,
				title,
				description: invocation.description,
			});
			const goal = envelope.ok ? envelope.result.goal : undefined;
			if (!goal) throw new Error(`Updated Project Goal ${id} was not returned`);
			report(invocation, envelope, `Updated project goal ${goal.id}`);
			return;
		}
		case "set_active":
			await runSetActive(invocation, service);
			return;
		case "complete":
		case "reopen":
		case "archive":
		case "delete":
			await runLifecycle(invocation, service, invocation.action);
			return;
		default:
			fail(`Unknown project action ${invocation.action}\n\n${USAGE}`, 2);
	}
}

const invocation = parseArgs(process.argv.slice(2));
try {
	await run(invocation);
} catch (error) {
	if (error instanceof WorklistApplicationError) {
		const code = exitCodeForError(error.code);
		if (invocation.json) {
			process.stderr.write(`${JSON.stringify({ ok: false, error: error.toResultError() }, null, 2)}\n`);
			process.exit(code);
		}
		if (error.code === WORKLIST_ERROR_CODES.APPROVAL_REQUIRED) {
			fail(`${error.message} Pass --confirm only when the user explicitly requested this action.`, code);
		}
		fail(error.message, code);
	}
	fail(error instanceof Error ? error.message : String(error), 1);
}
