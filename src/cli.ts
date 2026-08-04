#!/usr/bin/env node
import { createRequire } from "node:module";
import { basename } from "node:path";
import {
	type WorklistApplicationFailure,
	type WorklistApplicationResult,
	WorklistApplicationService,
	type WorklistOperation,
} from "./application-service.ts";
import { CLI_COMMAND_CONTRACT, type CliFlagContract, renderCliUsage } from "./cli-contract.ts";
import { getWorklistPath, resolveGitRoot } from "./git.ts";
import { WORKLIST_ERROR_CODES, type WorklistErrorCode, type WorklistResultMeta } from "./result-envelope.ts";
import { runGoalBoard } from "./tui/goal-board-runtime.ts";
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

const packageVersion = (createRequire(import.meta.url)("../package.json") as { version: string }).version;
const USAGE = renderCliUsage();

interface CliInvocation {
	scope: string;
	action: string;
	rest: string[];
	description?: string;
	/** Treat the text after `--` as an addition to the description rather than a replacement. */
	append: boolean;
	expectedUpdatedAt?: string;
	json: boolean;
	confirm: boolean;
	cwd: string;
	/** Flag names as written, so action-scoped flags can be refused where they would be ignored. */
	flagsUsed: ReadonlySet<string>;
	warnings: CliWarning[];
}

interface CliWarning {
	code: "MISPLACED_GLOBAL_FLAG";
	flag: string;
	usage: string;
}

interface CliResultMeta extends WorklistResultMeta {
	cliVersion: string;
}

type CliResultEnvelope = WorklistApplicationResult & {
	meta: CliResultMeta;
	warnings?: CliWarning[];
};

function fail(message: string, code: number): never {
	process.stderr.write(`${message}\n`);
	process.exit(code);
}

function exitCodeForError(code: WorklistErrorCode): number {
	if (code === WORKLIST_ERROR_CODES.APPROVAL_REQUIRED) return 3;
	if (code === WORKLIST_ERROR_CODES.CONFLICT) return 4;
	return 1;
}

const GLOBAL_FLAGS_BY_NAME: ReadonlyMap<string, CliFlagContract> = new Map(
	CLI_COMMAND_CONTRACT.flags.map((flag) => [flag.name, flag]),
);

/**
 * Warns when a global flag was written after the `--` separator.
 *
 * Every token after the separator is description text, so a trailing `--json`
 * silently becomes part of the description instead of selecting JSON output,
 * and the caller gets human output it never asked for. The flag still stays
 * description text, because letting a description contain anything at all is
 * the separator's whole purpose; only the silence is a defect. A flag before
 * the separator is already validated strictly, so this closes the asymmetry.
 */
function findMisplacedFlagWarnings(tokens: readonly string[]): CliWarning[] {
	const misplaced = [...new Set(tokens)].flatMap((token) => {
		const flag = GLOBAL_FLAGS_BY_NAME.get(token);
		return flag ? [{ code: "MISPLACED_GLOBAL_FLAG" as const, flag: flag.name, usage: flag.usage }] : [];
	});
	return misplaced;
}

function warnMisplacedFlags(warnings: readonly CliWarning[]): void {
	if (warnings.length === 0) return;
	const binary = CLI_COMMAND_CONTRACT.binary;
	const names = warnings.map((warning) => warning.flag);
	process.stderr.write(
		`Warning: ${names.join(", ")} came after -- and became description text, not ${names.length === 1 ? "a flag" : "flags"}.\n` +
			`Flags must come before the -- separator, for example:\n` +
			`  ${binary} ${CLI_COMMAND_CONTRACT.scope} <action> [arguments] ${warnings[0].usage} -- <description>\n`,
	);
}

/**
 * Refuses an action-scoped flag on an action that would ignore it.
 *
 * The scopes come from the same contract entry the help text and skill render,
 * so a flag can never be quietly dropped by a command they said would honor it.
 */
function validateFlagActions(invocation: CliInvocation): void {
	for (const flag of CLI_COMMAND_CONTRACT.flags) {
		if (!flag.actions || !invocation.flagsUsed.has(flag.name)) continue;
		if (flag.actions.includes(invocation.action)) continue;
		fail(
			`${flag.name} is only supported by ${CLI_COMMAND_CONTRACT.scope} ${flag.actions.join(", ")}\n\n${USAGE}`,
			2,
		);
	}
}

function readFlagValue(head: readonly string[], index: number, flag: string, expected: string): string {
	const value = head[index + 1];
	if (!value || value.startsWith("--")) fail(`${flag} requires ${expected}\n\n${USAGE}`, 2);
	return value;
}

function parseArgs(argv: string[]): CliInvocation {
	const separator = argv.indexOf("--");
	const head = separator === -1 ? argv : argv.slice(0, separator);
	const descriptionTokens = separator === -1 ? [] : argv.slice(separator + 1);
	const description = separator === -1 ? undefined : descriptionTokens.join(" ");
	const warnings = findMisplacedFlagWarnings(descriptionTokens);

	const positionals: string[] = [];
	const flagsUsed = new Set<string>();
	let json = false;
	let confirm = false;
	let append = false;
	let expectedUpdatedAt: string | undefined;
	let cwd = process.cwd();
	for (let index = 0; index < head.length; index++) {
		const part = head[index];
		if (!part.startsWith("--")) {
			positionals.push(part);
			continue;
		}
		flagsUsed.add(part);
		if (part === "--json") json = true;
		else if (part === "--confirm") confirm = true;
		else if (part === "--append") append = true;
		else if (part === "--cwd") {
			cwd = readFlagValue(head, index, part, "a directory");
			index++;
		} else if (part === "--expect-updated-at") {
			expectedUpdatedAt = readFlagValue(head, index, part, "a timestamp");
			index++;
		} else fail(`Unknown flag ${part}\n\n${USAGE}`, 2);
	}

	const [scope, action, ...rest] = positionals;
	if (!scope || !action) fail(USAGE, 2);
	return {
		scope,
		action,
		rest,
		description,
		append,
		expectedUpdatedAt,
		json,
		confirm,
		cwd,
		flagsUsed,
		warnings,
	};
}

interface ProjectLocation {
	/** Canonical git root, whose basename names the repository in the board header. */
	root: string;
	/** Absolute path of `<git-root>/.pi/worklist.json`. */
	path: string;
}

function resolveProjectLocation(invocation: CliInvocation): ProjectLocation {
	const result = resolveGitRoot(invocation.cwd);
	if (!result.isGit || !result.root) {
		throw new WorklistCliFailure({
			ok: false,
			scope: "project",
			action: invocation.action,
			error: {
				code: WORKLIST_ERROR_CODES.UNAVAILABLE,
				message: "Project goals require a git repository. Run inside a repository or pass --cwd <dir>.",
				retryable: false,
				details: { resolution: "run-inside-git-repository" },
			},
			meta: { changed: false, semanticNoOp: false, changedFields: [] },
		});
	}
	return { root: result.root, path: getWorklistPath(result.root) };
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

/** A failed operation, carrying the full deterministic failure envelope for --json output. */
class WorklistCliFailure extends Error {
	readonly envelope: WorklistApplicationFailure;

	constructor(envelope: WorklistApplicationFailure) {
		super(envelope.error.message);
		this.name = envelope.error.code;
		this.envelope = envelope;
	}
}

async function executeCliOperation(
	service: WorklistApplicationService,
	operation: WorklistOperation,
): Promise<WorklistApplicationResult> {
	const envelope = await service.execute(operation, { source: "cli" });
	if (!envelope.ok) throw new WorklistCliFailure(envelope);
	return envelope;
}

function report(invocation: CliInvocation, envelope: WorklistApplicationResult, message: string): void {
	if (invocation.json) {
		process.stdout.write(`${JSON.stringify(withCliMetadata(invocation, envelope), null, 2)}\n`);
		return;
	}
	process.stdout.write(`${message}\n`);
}

function withCliMetadata(invocation: CliInvocation, envelope: WorklistApplicationResult): CliResultEnvelope {
	const cliEnvelope = {
		...envelope,
		meta: { ...envelope.meta, cliVersion: packageVersion },
	};
	if (invocation.warnings.length === 0) return cliEnvelope;
	return { ...cliEnvelope, warnings: invocation.warnings };
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
		expectedUpdatedAt: invocation.expectedUpdatedAt,
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
		const envelope = await executeCliOperation(service, {
			scope: "project",
			action: "set_active",
			id,
			expectedUpdatedAt: invocation.expectedUpdatedAt,
		});
		const goal = envelope.ok ? envelope.result.goal : undefined;
		if (!goal) throw new Error(`Activated Project Goal ${id} was not returned`);
		report(invocation, envelope, `Activated project goal ${goal.id}`);
	} catch (error) {
		if (
			error instanceof WorklistCliFailure &&
			error.envelope.error.details?.resolution === "reopen-project-goal" &&
			!invocation.json
		) {
			fail(
				`${error.message} Reopen it first: pi-worklist project reopen ${id} --confirm`,
				exitCodeForError(error.envelope.error.code),
			);
		}
		throw error;
	}
}

/**
 * Open the full-screen goal board.
 *
 * The board owns the terminal, so it is refused wherever there is no human to
 * drive it: piped output, CI, and agent shells are directed to `list --json`,
 * the machine-readable read path.
 */
async function runInteractiveBoard(
	invocation: CliInvocation,
	service: WorklistApplicationService,
	location: ProjectLocation,
): Promise<void> {
	if (invocation.json) {
		fail(`project ui is interactive and cannot be combined with --json\n\n${USAGE}`, 2);
	}
	if (!process.stdin.isTTY || !process.stdout.isTTY) {
		fail(
			"project ui needs an interactive terminal. Use 'pi-worklist project list --json' in scripts and agents.",
			1,
		);
	}
	// Surface a malformed or unreadable worklist through the normal failure path
	// rather than opening an empty board over a file that could not be read.
	const envelope = await executeCliOperation(service, { scope: "project", action: "list" });
	await runGoalBoard({
		service,
		projectPath: location.path,
		repositoryLabel: basename(location.root),
		initialGoals: (envelope.ok ? envelope.result.goals : undefined) ?? [],
		input: process.stdin,
		output: process.stdout,
		env: process.env,
	});
}

async function run(invocation: CliInvocation): Promise<void> {
	if (invocation.scope !== "project") {
		if (invocation.scope === "session") {
			fail("Session Tasks live inside a Pi session and cannot be managed externally. Use /tasks in Pi.", 2);
		}
		fail(`Unknown scope ${invocation.scope}\n\n${USAGE}`, 2);
	}
	validateFlagActions(invocation);
	if (invocation.action === "help") {
		process.stdout.write(`${USAGE}\n`);
		return;
	}
	const location = resolveProjectLocation(invocation);
	const service = new WorklistApplicationService({ projectPath: location.path });

	switch (invocation.action) {
		case "ui":
			await runInteractiveBoard(invocation, service, location);
			return;
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
				throw new WorklistCliFailure({
					ok: false,
					scope: "project",
					action: "show",
					error: {
						code: WORKLIST_ERROR_CODES.NOT_FOUND,
						message: `Project goal ${id} was not found.`,
						retryable: false,
						details: { entity: "project-goal", id, resolution: "refresh-and-select-existing" },
					},
					meta: { changed: false, semanticNoOp: false, changedFields: [] },
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
			if (invocation.append) {
				if (!invocation.description?.trim()) {
					fail(`project update --append requires the text to append after --\n\n${USAGE}`, 2);
				}
				// --append takes no value of its own, so text written as though it did
				// arrives here as a title. Refusing the combination turns that mistake
				// into a usage error instead of a silent rename.
				if (title !== undefined) {
					fail(`project update cannot change the title while appending to the description\n\n${USAGE}`, 2);
				}
			}
			if (title === undefined && invocation.description === undefined) {
				fail(`project update requires a new title, a -- description, or both\n\n${USAGE}`, 2);
			}
			const envelope = await executeCliOperation(service, {
				scope: "project",
				action: "update",
				id,
				title,
				...(invocation.append
					? { appendDescription: invocation.description }
					: { description: invocation.description }),
				expectedUpdatedAt: invocation.expectedUpdatedAt,
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
if (!invocation.json) warnMisplacedFlags(invocation.warnings);
try {
	await run(invocation);
} catch (error) {
	if (error instanceof WorklistCliFailure) {
		const code = exitCodeForError(error.envelope.error.code);
		if (invocation.json) {
			process.stderr.write(`${JSON.stringify(withCliMetadata(invocation, error.envelope), null, 2)}\n`);
			process.exit(code);
		}
		if (error.envelope.error.code === WORKLIST_ERROR_CODES.APPROVAL_REQUIRED) {
			fail(`${error.message} Pass --confirm only when the user explicitly requested this action.`, code);
		}
		fail(error.message, code);
	}
	fail(error instanceof Error ? error.message : String(error), 1);
}
