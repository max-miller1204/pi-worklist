/**
 * The single command contract for the pi-worklist CLI.
 *
 * CLI usage text, the command reference in docs/cli.md, the installable agent
 * skill in .claude/skills/worklist/SKILL.md, and agent guidance are all
 * rendered from this structure so they cannot drift from each other or from
 * the implemented command surface.
 */

export interface CliActionContract {
	name: string;
	usage: string;
	summary: string;
	/** Requires --confirm and an explicit user request. */
	confirmRequired?: boolean;
}

export interface CliFlagContract {
	name: string;
	usage: string;
	summary: string;
}

export interface CliExitCodeContract {
	code: number;
	meaning: string;
}

/** Repository-relative path of the script that writes every generated artifact. */
export const GENERATOR_PATH = "scripts/generate-docs.ts";

/** Repository-relative path of the generated command reference. */
export const DOCS_PATH = "docs/cli.md";

/** Repository-relative path of the generated agent skill. */
export const SKILL_PATH = ".claude/skills/worklist/SKILL.md";

export const CLI_COMMAND_CONTRACT = {
	binary: "pi-worklist",
	scope: "project",
	intro:
		"Manage repository-wide Project Goals in <git-root>/.pi/worklist.json through the same application service, cross-process lock, and atomic replacement as a live Pi session. Session Tasks live inside a Pi session and are deliberately out of scope.",
	/**
	 * Trigger text agents match against to auto-load the skill. Deliberately
	 * repository-neutral: one skill file serves every checkout, so it must never
	 * assume it was installed alongside this source tree.
	 */
	skillDescription:
		"Manage pi-worklist Project Goals (the shared roadmap in a repo's .pi/worklist.json) from any Claude session. Use when the user asks to add, list, update, activate, complete, reopen, archive, or delete a project goal, or to capture brainstormed ideas or future goals on a project's worklist or roadmap.",
	runtime: {
		/** Node floor for the published compiled bin. Asserted against package.json engines.node. */
		binaryNodeFloor: "20",
		/** Node floor for running src/cli.ts directly, which relies on native type stripping. */
		sourceNodeFloor: "22.18",
	},
	actions: [
		{
			name: "list",
			usage: "list",
			summary: "Show a compact bounded list of project goals",
		},
		{
			name: "show",
			usage: "show <id>",
			summary: "Show one goal with its full description",
		},
		{
			name: "add",
			usage: "add <title...> [-- <description...>]",
			summary: "Add an open goal",
		},
		{
			name: "update",
			usage: "update <id> [title...] [-- <description...>]",
			summary: 'Edit a goal; "-- " alone clears the description',
		},
		{
			name: "set_active",
			usage: "set_active <id>",
			summary: "Make a goal the single active goal",
		},
		{
			name: "complete",
			usage: "complete <id> --confirm",
			summary: "Mark a goal done",
			confirmRequired: true,
		},
		{
			name: "reopen",
			usage: "reopen <id> --confirm",
			summary: "Reopen a done or archived goal",
			confirmRequired: true,
		},
		{
			name: "archive",
			usage: "archive <id> --confirm",
			summary: "Archive a goal",
			confirmRequired: true,
		},
		{
			name: "delete",
			usage: "delete <id> --confirm",
			summary: "Delete a goal permanently",
			confirmRequired: true,
		},
		{
			name: "help",
			usage: "help",
			summary: "Print this help",
		},
	] satisfies CliActionContract[],
	flags: [
		{
			name: "--json",
			usage: "--json",
			summary: "Print the deterministic result envelope as JSON (stdout on success, stderr on failure)",
		},
		{
			name: "--confirm",
			usage: "--confirm",
			summary: "Acknowledge a lifecycle action; pass it only for an explicit user request",
		},
		{
			name: "--cwd",
			usage: "--cwd <dir>",
			summary: "Resolve the git root from this directory instead of the working directory",
		},
	] satisfies CliFlagContract[],
	exitCodes: [
		{ code: 0, meaning: "success" },
		{ code: 1, meaning: "error" },
		{ code: 2, meaning: "usage error" },
		{ code: 3, meaning: "confirmation required" },
		{ code: 4, meaning: "conflict" },
	] satisfies CliExitCodeContract[],
	agentGuidelines: [
		"Prefer --json and read the deterministic result envelope instead of parsing human output.",
		"Never pass --confirm for complete, reopen, archive, or delete unless the user explicitly requested that exact action.",
		"Treat exit code 3 as a request for explicit user confirmation, not as a retryable failure.",
		"Treat exit code 4 as a concurrent-change conflict: re-read current state before retrying.",
		"Use list for orientation and show <id> when you need a goal's complete description.",
		"Broad outcomes belong in Project Goals; do not mirror your internal step-by-step plan into them.",
	],
} as const;

function padUsage(usage: string): string {
	return usage.length >= 41 ? `${usage}\n${" ".repeat(43)}` : usage.padEnd(41);
}

/** Look up a documented exit code, failing loudly if the contract drops it. */
function exitCodeMeaning(code: number): string {
	const match = CLI_COMMAND_CONTRACT.exitCodes.find((exitCode) => exitCode.code === code);
	if (!match) {
		throw new Error(`Exit code ${code} is referenced by the skill but missing from the contract`);
	}
	return match.meaning;
}

/** Render `a`, `b`, and `c` from a set of actions. */
function actionNameList(actions: readonly CliActionContract[]): string {
	const names = actions.map((action) => `\`${action.name}\``);
	if (names.length < 2) {
		return names.join("");
	}
	return `${names.slice(0, -1).join(", ")}, and ${names[names.length - 1]}`;
}

export function renderCliUsage(): string {
	const contract = CLI_COMMAND_CONTRACT;
	const actionLines = contract.actions.map((action) => `  ${padUsage(action.usage)}${action.summary}`);
	const flagLines = contract.flags.map((flag) => `  ${flag.usage.padEnd(15)}${flag.summary}`);
	const exitCodes = contract.exitCodes.map((exitCode) => `${exitCode.code} ${exitCode.meaning}`).join(", ");
	return [
		`Usage: ${contract.binary} ${contract.scope} <action> [arguments] [flags]`,
		"",
		"Actions:",
		...actionLines,
		"",
		"Flags:",
		...flagLines,
		"",
		`Exit codes: ${exitCodes}.`,
	].join("\n");
}

/**
 * The installable agent skill, written to .claude/skills/worklist/SKILL.md.
 *
 * Every invocation is the non-interactive `npx -y` form so the same file works
 * from any repository; scope is chosen at install time, never in the content.
 */
export function renderSkillMarkdown(): string {
	const contract = CLI_COMMAND_CONTRACT;
	const lifecycleActions = contract.actions.filter((action) => action.confirmRequired);
	const safeActions = contract.actions.filter((action) => !action.confirmRequired && action.name !== "help");
	return [
		"---",
		"name: worklist",
		`description: ${JSON.stringify(contract.skillDescription)}`,
		"---",
		"",
		`<!-- Generated from src/cli-contract.ts by ${GENERATOR_PATH}. Do not edit manually. -->`,
		"",
		"# Managing pi-worklist Project Goals",
		"",
		"Project Goals are a repository-wide roadmap stored in `<git-root>/.pi/worklist.json` and shared with Pi sessions.",
		"Never edit that file directly: a concurrent Pi session may hold the cross-process lock, and direct edits bypass validation, ID generation, and timestamps.",
		`Always go through the ${contract.binary} CLI, which routes every mutation through the same application service, cross-process lock, and atomic replacement as a live Pi session.`,
		"",
		"## Invoking the CLI",
		"",
		`The published package ships a compiled \`${contract.binary}\` bin (Node ${contract.runtime.binaryNodeFloor} or newer), usable from any repository without installing anything first:`,
		"",
		"```sh",
		`npx -y ${contract.binary} ${contract.scope} <action> [arguments] [flags]`,
		"```",
		"",
		"Run it from inside the target repository, or pass `--cwd <repo-root>` to target another one.",
		`Inside a ${contract.binary} development checkout, prefer the TypeScript entry point so unreleased changes apply: \`node <checkout>/src/cli.ts ${contract.scope} <action>\` (needs Node ${contract.runtime.sourceNodeFloor} or newer for native type stripping).`,
		"",
		"Actions:",
		"",
		"```text",
		...contract.actions.map((action) => action.usage),
		"```",
		"",
		"Flags:",
		"",
		...contract.flags.map((flag) => `- \`${flag.usage}\` - ${flag.summary}.`),
		"",
		"Prefer `--json` whenever you need to read IDs, statuses, or errors back rather than parsing human output.",
		"`list` output is compact and omits descriptions; use `show <id>` when you need a goal's complete description.",
		"Text after `--` becomes the goal description.",
		"`update <id> --` with nothing after the separator clears the description.",
		`The full generated command reference lives in the package's \`${DOCS_PATH}\`, rendered from the same contract as this skill.`,
		"",
		"## Guardrails",
		"",
		`- ${actionNameList(lifecycleActions)} are lifecycle actions reserved for explicit user intent.`,
		"  Pass `--confirm` only when the user explicitly requested that exact action on that goal in this conversation.",
		"  Never pass it because a goal merely looks finished or stale.",
		`- Exit code 3 (${exitCodeMeaning(3)}) means the command needs \`--confirm\`; stop and ask the user instead of retrying with the flag.`,
		`- Exit code 4 (${exitCodeMeaning(4)}) means a concurrent change conflicted with yours; re-read current state with \`list\` or \`show\` before retrying.`,
		`- ${actionNameList(safeActions)} are safe to run whenever they serve the user's request.`,
		"- Session Tasks cannot be managed from outside a Pi session; the CLI intentionally rejects `session` scope.",
		"  For your own in-session tracking, use your normal task tools instead.",
		"",
		"## Failure modes",
		"",
		`- Exit code 1 (${exitCodeMeaning(1)}) with a "Malformed" message means the target \`.pi/worklist.json\` is corrupt; report it to the user and never rewrite the file by hand.`,
		'- Exit code 1 with a "git repository" message means the working directory is outside a repo; rerun with `--cwd <repo-root>`.',
		"  With `--json`, that failure also arrives as the deterministic result envelope on stderr.",
		`- Exit code 2 (${exitCodeMeaning(2)}) means the action or its flags were not recognized; re-read the action list above instead of guessing.`,
		`- If \`npx -y ${contract.binary}\` cannot resolve the package, check network access to the npm registry; a local development checkout remains a fallback.`,
		"",
	].join("\n");
}

/** The generated command reference and agent guidance document, written to docs/cli.md. */
export function renderCliGuide(): string {
	const contract = CLI_COMMAND_CONTRACT;
	const actionRows = contract.actions.map(
		(action) =>
			`| \`${contract.binary} ${contract.scope} ${action.usage}\` | ${action.summary}${action.confirmRequired ? ". Requires explicit user confirmation" : ""} |`,
	);
	const flagRows = contract.flags.map((flag) => `| \`${flag.usage}\` | ${flag.summary} |`);
	const exitCodeRows = contract.exitCodes.map((exitCode) => `| \`${exitCode.code}\` | ${exitCode.meaning} |`);
	const guidelineLines = contract.agentGuidelines.map((guideline) => `- ${guideline}`);
	return [
		`<!-- Generated from src/cli-contract.ts by ${GENERATOR_PATH}. Do not edit manually. -->`,
		"",
		"# pi-worklist CLI",
		"",
		contract.intro,
		"",
		"## Commands",
		"",
		"| Command | Description |",
		"| --- | --- |",
		...actionRows,
		"",
		"## Flags",
		"",
		"| Flag | Description |",
		"| --- | --- |",
		...flagRows,
		"",
		"## Exit codes",
		"",
		"| Code | Meaning |",
		"| --- | --- |",
		...exitCodeRows,
		"",
		"## Agent guidance",
		"",
		...guidelineLines,
		"",
	].join("\n");
}
