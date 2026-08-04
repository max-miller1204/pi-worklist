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
	/** Takes over the terminal until the user quits; agents must never run it. */
	interactive?: boolean;
}

export interface CliFlagContract {
	name: string;
	usage: string;
	summary: string;
	/** Actions the flag applies to. Absent means every action accepts it. */
	actions?: readonly string[];
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
		"Manage pi-worklist Project Goals (the shared roadmap in a repo's .pi/worklist.json) from any Claude session. Use when the user asks to add, list, find, update, activate, complete, reopen, archive, or delete a project goal; migrate goal IDs; or capture brainstormed ideas or future goals on a project's worklist or roadmap.",
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
			name: "find",
			usage: "find <text...>",
			summary: "List the goals whose title or description contains the text",
		},
		{
			name: "ui",
			usage: "ui",
			summary: "Open the interactive goal board for a human at the keyboard",
			interactive: true,
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
			name: "migrate_ids",
			usage: "migrate_ids --confirm",
			summary: "Rewrite randomly generated goal IDs as title-derived ones",
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
			summary: "Acknowledge an action that requires confirmation; pass it only for an explicit user request",
		},
		{
			name: "--cwd",
			usage: "--cwd <dir>",
			summary: "Resolve the git root from this directory instead of the working directory",
		},
		{
			name: "--append",
			usage: "--append",
			summary:
				"Add the text after -- as a new paragraph instead of replacing the description; cannot be combined with a title change",
			actions: ["update"],
		},
		{
			name: "--expect-updated-at",
			usage: "--expect-updated-at <timestamp>",
			summary: "Refuse the change as a conflict unless the goal's updatedAt still matches this value",
			actions: ["update", "set_active", "complete", "reopen", "archive", "delete"],
		},
		{
			name: "--dry-run",
			usage: "--dry-run",
			summary: "Report the ID rewrites without writing them, and without needing --confirm",
			actions: ["migrate_ids"],
		},
	] satisfies CliFlagContract[],
	/**
	 * A rule that is easy to violate silently, so every generated surface
	 * states it rather than leaving it implied by the separator's definition.
	 */
	separatorRule:
		"Put every flag before `--`, because each token after it is description text. A known flag there remains in the description and triggers a warning: stderr for human output, or the JSON envelope's `warnings` array if `--json` was already enabled. A trailing `--json` therefore does not select JSON output; the command prints human output and still exits 0.",
	/**
	 * How an ID comes to exist and how a caller names one.
	 *
	 * Every surface states these, because a caller who assumes IDs are opaque
	 * random strings keeps paying for `list --json` plus client-side filtering to
	 * find the goal they already know the name of.
	 */
	idRules: [
		"A goal's ID is derived from its title when the goal is created and frozen from then on, so it reads as words and a later rename never invalidates a reference written down elsewhere.",
		"A title-derived ID never uses the legacy random-ID shape, so `migrate_ids` can identify generated IDs without consulting a title that may have changed.",
		"Read an ID back from `list`, `find`, or `add` instead of deriving it from a title yourself: truncation and collision suffixes make a guessed slug unreliable.",
		"Every `<id>` argument also accepts a unique prefix of an ID, or an ID the goal answered to before `migrate_ids` renamed it.",
		"An ambiguous prefix is refused with the goals it matched instead of resolved by guesswork, so widen the prefix rather than retrying it.",
		"Deleting a goal permanently retires its current and former IDs: they stop resolving, but no later goal can claim them and inherit stale references.",
		"`find <text>` searches titles and descriptions, so locating a goal never needs `list --json` plus client-side filtering.",
	],
	exitCodes: [
		{ code: 0, meaning: "success" },
		{ code: 1, meaning: "error" },
		{ code: 2, meaning: "usage error" },
		{ code: 3, meaning: "confirmation required" },
		{ code: 4, meaning: "conflict" },
	] satisfies CliExitCodeContract[],
	agentGuidelines: [
		"Prefer --json and read the deterministic result envelope instead of parsing human output.",
		"Write every flag before the -- separator, and read the CLI's own exit code rather than a shell pipeline's, so a swallowed flag cannot look like a failure or a success.",
		"Never run ui: it is an interactive board for a human, it holds the terminal until they quit, and it refuses to start without one.",
		"Never pass --confirm for complete, reopen, archive, delete, or migrate_ids unless the user explicitly requested that exact action.",
		"Treat exit code 3 as a request for explicit user confirmation, not as a retryable failure.",
		"Treat exit code 4 as a concurrent-change conflict: re-read current state before retrying.",
		"Use list for orientation, find <text> to locate a goal by wording, and show <id> when you need a goal's complete description.",
		"Pass a full ID or a prefix long enough to be unique; an ambiguous prefix is refused with candidates rather than resolved by guesswork.",
		"Run migrate_ids only when the user explicitly asks for it; it rewrites stored IDs, though every old ID keeps resolving afterwards.",
		"Add a note with --append instead of resending a description you did not write, so nothing in the existing text can be lost in transcription.",
		"Pass --expect-updated-at with the updatedAt from your own read whenever you change a goal, so your mutation conflicts if the goal changed in the meantime.",
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

/** Render `a`, `b`, and `c`. */
function joinWithAnd(items: readonly string[]): string {
	if (items.length < 2) {
		return items.join("");
	}
	return `${items.slice(0, -1).join(", ")}, and ${items[items.length - 1]}`;
}

/** Render `a`, `b`, and `c` from a set of actions. */
function actionNameList(actions: readonly CliActionContract[]): string {
	return joinWithAnd(actions.map((action) => `\`${action.name}\``));
}

/**
 * A flag's summary, stating which actions accept it.
 *
 * The applicable actions are rendered from the same list the CLI enforces, so
 * no surface can promise a flag the command line rejects.
 */
function flagSummary(flag: CliFlagContract): string {
	if (!flag.actions) return flag.summary;
	return `${flag.summary}; only for ${CLI_COMMAND_CONTRACT.scope} ${joinWithAnd(flag.actions)}`;
}

export function renderCliUsage(): string {
	const contract = CLI_COMMAND_CONTRACT;
	const flagColumn = Math.max(...contract.flags.map((flag) => flag.usage.length)) + 2;
	const actionLines = contract.actions.map((action) => `  ${padUsage(action.usage)}${action.summary}`);
	const flagLines = contract.flags.map((flag) => `  ${flag.usage.padEnd(flagColumn)}${flagSummary(flag)}`);
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
 * Every published invocation is the non-interactive `npx -y <binary>@latest`
 * form so the same file works from any repository without stale-cache selection;
 * scope is chosen at install time, never in the content.
 */
export function renderSkillMarkdown(): string {
	const contract = CLI_COMMAND_CONTRACT;
	const publishedBinary = `${contract.binary}@latest`;
	const lifecycleActions = contract.actions.filter((action) => action.confirmRequired);
	const safeActions = contract.actions.filter(
		(action) => !action.confirmRequired && !action.interactive && action.name !== "help",
	);
	const interactiveActions = contract.actions.filter((action) => action.interactive);
	// A title-derived ID in the shape `add` actually mints, so the examples show
	// what `list` and `find` hand back rather than a placeholder.
	const exampleId = "support-goal-templates";
	// An `updatedAt` in the stored ISO 8601 shape, as `show` reports it.
	const exampleUpdatedAt = "2026-05-04T09:12:31.004Z";
	const examples = [
		"list --json",
		"add Support goal templates -- Let teams share reusable goal outlines",
		"find templates --json",
		`show ${exampleId} --json`,
		`update ${exampleId} -- Replace only the description`,
		`update ${exampleId} Support shared goal templates`,
		`update ${exampleId} --append -- Blocked on the template schema until it lands`,
		`update ${exampleId} --expect-updated-at ${exampleUpdatedAt} --append -- Reviewed and still current`,
		`set_active ${exampleId}`,
	];
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
		`npx -y ${publishedBinary} ${contract.scope} <action> [arguments] [flags]`,
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
		...contract.flags.map((flag) => `- \`${flag.usage}\` - ${flagSummary(flag)}.`),
		"",
		"Prefer `--json` whenever you need to read IDs, statuses, or errors back rather than parsing human output.",
		"`list` output is compact and omits descriptions; use `show <id>` when you need a goal's complete description.",
		"Text after `--` becomes the goal description.",
		contract.separatorRule,
		"`update <id> --` with nothing after the separator clears the description.",
		"`update <id> --append -- <text>` adds that text as a new paragraph instead, so recording a note never rewrites, and never risks losing, prose you did not author.",
		"`--expect-updated-at <updatedAt>`, copied from your own `show` of that goal, refuses the change when someone edited the goal after you read it.",
		"Pass it on every change you make to a goal you did not just create: without it, your mutation proceeds even if the goal changed after you read it.",
		"",
		"Examples:",
		"",
		"```sh",
		...examples.map((example) => `npx -y ${publishedBinary} ${contract.scope} ${example}`),
		"```",
		"",
		`The full generated command reference lives in the package's \`${DOCS_PATH}\`, rendered from the same contract as this skill.`,
		"",
		"## Goal IDs",
		"",
		...contract.idRules.map((rule) => `- ${rule}`),
		"",
		"## Guardrails",
		"",
		`- ${actionNameList(lifecycleActions)} are reserved for explicit user intent.`,
		"  Pass `--confirm` only for the exact action the user requested and, when the action names a goal, only for that exact goal.",
		"  Never pass it because a goal merely looks finished or stale.",
		"- `migrate_ids` names no goal and rewrites every generated ID in the repository at once, so it needs an explicit request of its own.",
		"  `--dry-run` reports the rewrites it would make without writing them and without `--confirm`; prefer it when you are showing the user what would change.",
		`- Exit code 3 (${exitCodeMeaning(3)}) means the command needs \`--confirm\`; stop and ask the user instead of retrying with the flag.`,
		`- Exit code 4 (${exitCodeMeaning(4)}) means a concurrent change conflicted with yours; re-read current state with \`list\` or \`show\` before retrying.`,
		"  A conflicting change wrote nothing at all, so rebuild it against the goal you just re-read and pass that goal's new `updatedAt`.",
		`- ${actionNameList(safeActions)} are safe to run whenever they serve the user's request.`,
		`- ${actionNameList(interactiveActions)} opens a full-screen board for the human at the keyboard, not for you.`,
		"  Never run it: it holds the terminal until the user quits, and it exits with an error when stdin or stdout is not a terminal.",
		`  Suggest \`npx -y ${publishedBinary} ${contract.scope} ui\` when the user wants to browse or edit goals themselves; read state with \`list\` and \`show\` instead.`,
		"- Session Tasks cannot be managed from outside a Pi session; the CLI intentionally rejects `session` scope.",
		"  For your own in-session tracking, use your normal task tools instead.",
		"",
		"## Failure modes",
		"",
		`- Exit code 1 (${exitCodeMeaning(1)}) with a "Malformed" message means the target \`.pi/worklist.json\` is corrupt; report it to the user and never rewrite the file by hand.`,
		'- Exit code 1 with a "git repository" message means the working directory is outside a repo; rerun with `--cwd <repo-root>`.',
		"  With `--json`, that failure also arrives as the deterministic result envelope on stderr.",
		`- Exit code 2 (${exitCodeMeaning(2)}) means the action or its flags were not recognized; re-read the action list above instead of guessing.`,
		`- If \`npx -y ${publishedBinary}\` cannot resolve the package, check network access to the npm registry; a local development checkout remains a fallback.`,
		`- Read \`meta.cliVersion\` from any \`--json\` result envelope when you need to verify which published build ran.`,
		"  This reports the package's runtime version directly instead of requiring inspection of the npx cache.",
		"",
	].join("\n");
}

/** The generated command reference and agent guidance document, written to docs/cli.md. */
export function renderCliGuide(): string {
	const contract = CLI_COMMAND_CONTRACT;
	const publishedBinary = `${contract.binary}@latest`;
	const actionRows = contract.actions.map((action) => {
		const notes = [
			action.confirmRequired ? ". Requires explicit user confirmation" : "",
			action.interactive ? ". Requires a terminal; not for scripts or agents" : "",
		].join("");
		return `| \`npx -y ${publishedBinary} ${contract.scope} ${action.usage}\` | ${action.summary}${notes} |`;
	});
	const flagRows = contract.flags.map((flag) => `| \`${flag.usage}\` | ${flagSummary(flag)} |`);
	const exitCodeRows = contract.exitCodes.map((exitCode) => `| \`${exitCode.code}\` | ${exitCode.meaning} |`);
	const guidelineLines = contract.agentGuidelines.map((guideline) => `- ${guideline}`);
	return [
		`<!-- Generated from src/cli-contract.ts by ${GENERATOR_PATH}. Do not edit manually. -->`,
		"",
		"# pi-worklist CLI",
		"",
		contract.intro,
		"",
		"## Invocation",
		"",
		"Use the explicit `@latest` package specifier so a stale local npx cache cannot select an older CLI build:",
		"",
		"```sh",
		`npx -y ${publishedBinary} ${contract.scope} <action> [arguments] [flags]`,
		"```",
		"",
		"Every `--json` result envelope reports the running package version as `meta.cliVersion`.",
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
		contract.separatorRule,
		"",
		"## Goal IDs",
		"",
		...contract.idRules.map((rule) => `- ${rule}`),
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
