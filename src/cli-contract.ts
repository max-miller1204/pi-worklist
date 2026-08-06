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
			usage: "add <title...> [--description <text> | -- <description...>]",
			summary: "Add an open goal",
		},
		{
			name: "update",
			usage: "update <id> [title...] [--description <text> | -- <description...>]",
			summary: "Edit a goal's title or description",
		},
		{
			name: "move",
			usage: "move <id> up|down|before <id>|after <id>",
			summary: "Reorder a goal in the roadmap's canonical file order",
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
			name: "--description",
			usage: "--description <text>",
			summary:
				"Set the whole description from one argv token; order-independent and preferred for agents and scripts",
			actions: ["add", "update"],
		},
		{
			name: "--append-description",
			usage: "--append-description <text>",
			summary:
				"Add one argv token as a new description paragraph without replacing stored prose; cannot be combined with a title change",
			actions: ["update"],
		},
		{
			name: "--append",
			usage: "--append",
			summary:
				"Interactive compatibility form that adds the text after -- as a new paragraph; cannot be combined with a title change",
			actions: ["update"],
		},
		{
			name: "--group",
			usage: "--group <name>",
			summary: "Put the goal in a free-form section, such as Foundation; an empty name clears it",
			actions: ["add", "update"],
		},
		{
			name: "--depends-on",
			usage: "--depends-on <id>",
			summary:
				"Require that goal to land first; repeat it to name several, and pass an empty id alone to clear every edge",
			actions: ["add", "update"],
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
	/** Description input rules rendered onto every generated caller surface. */
	descriptionRules: [
		"Programmatic callers and agents must use `--description <text>` for a replacement, passing the whole value in one argv token. The flag is order-independent, and its value may itself look like a known flag.",
		"Use `--append-description <text>` to add a paragraph without replaying stored prose. Replacing and appending are mutually exclusive, and an append cannot be combined with a title change.",
		"Reserve `-- <description...>` for a human typing unquoted prose interactively. A standalone known flag after the separator is a usage error with exit code 2; move a real flag before the separator or put flag-looking prose in `--description`.",
		"The legacy `--append -- <text>` interactive form remains supported, while agents and scripts use `--append-description <text>`.",
	],
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
	/**
	 * How the roadmap is ordered, and what that order does and does not mean.
	 *
	 * Stated everywhere because a caller who assumes the list is sorted for them
	 * will read `move` as cosmetic and re-sort the file to "fix" an order someone
	 * arranged deliberately.
	 */
	orderRules: [
		"Goals are stored and listed in one canonical order: `add` appends to the end, and `move` is the only action that rearranges them.",
		"`move <id> up` and `move <id> down` step one place, while `move <id> before <anchor>` and `move <id> after <anchor>` land the goal beside a named one.",
		"A move changes the roadmap's order without touching the moved goal's `updatedAt`, so rearranging the list never reads as editing the goals on it.",
		"Reordering needs no confirmation, because it names no new state for a goal, only a new position among the others.",
	],
	/**
	 * What a dependency edge means, and what follows from it.
	 *
	 * Stated on every surface because the graph and the file order answer two
	 * different questions, and a caller who reads them as one thing will either
	 * re-sort the roadmap to match the edges or add edges to justify an order
	 * somebody arranged for another reason entirely.
	 */
	dependencyRules: [
		"`--depends-on <id>` on `add` and `update` records that the named goal must land before this one; repeat the flag to name several, and `--depends-on ''` on its own clears every edge.",
		"An `update` replaces the whole set rather than adding to it, so name every edge the goal should end up with, not just the new one.",
		"An edge means must-land-before whatever its reason, so a logical prerequisite and two goals that would collide in the same files are recorded the same way.",
		"A dependency is satisfied once its target is done or archived, and a goal with an unsatisfied dependency is blocked.",
		"Blocked is derived from the edges on every read and never stored: there is no blocked status, and `set_active` warns about a blocked goal instead of refusing it.",
		"Only the forward direction is stored, and `show <id>` derives what the goal blocks, so an edge is written once and the two directions cannot drift apart.",
		"An update that would form a cycle, including an existing goal naming itself, is refused with `DEPENDENCY_CYCLE`.",
		"Add resolves dependencies before minting the new goal's ID, so an edge naming a guessed future slug is refused with `NOT_FOUND`, like any ID that names no existing goal.",
		"Deleting a goal drops the edges naming it in the same atomic change.",
		"File order is presentation and a tiebreak while the dependency graph is the source of truth for what may start; the two are allowed to disagree, and neither should be edited to mirror the other.",
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
		"Use --description <text> and --append-description <text> for every programmatic description input; reserve the -- separator for a human typing prose interactively.",
		"Read the CLI's own exit code rather than a shell pipeline's; a known flag after the description separator is a usage error with exit code 2.",
		"Never run ui: it is an interactive board for a human, it holds the terminal until they quit, and it refuses to start without one.",
		"Never pass --confirm for complete, reopen, archive, delete, or migrate_ids unless the user explicitly requested that exact action.",
		"Treat exit code 3 as a request for explicit user confirmation, not as a retryable failure.",
		"Treat exit code 4 as a concurrent-change conflict: re-read current state before retrying.",
		"Use list for orientation, find <text> to locate a goal by wording, and show <id> when you need a goal's complete description.",
		"Pass a full ID or a prefix long enough to be unique; an ambiguous prefix is refused with candidates rather than resolved by guesswork.",
		"Run migrate_ids only when the user explicitly asks for it; it rewrites stored IDs, though every old ID keeps resolving afterwards.",
		"Add a note with --append-description instead of resending a description you did not write, so nothing in the existing text can be lost in transcription.",
		"Group related goals with --group <name> on add or update, and leave the file order alone unless the user asked for a different sequence.",
		"Record a real must-land-before relationship with --depends-on <id>, including one that exists only because two goals would collide in the same files; do not add an edge merely to justify the order the file happens to be in.",
		"Send the complete set of edges on every --depends-on update, because it replaces the stored set rather than adding to it.",
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

/** Render `a`, `a and b`, or `a`, `b`, and `c`. */
function joinWithAnd(items: readonly string[]): string {
	if (items.length < 2) return items.join("");
	const last = items[items.length - 1];
	const leading = items.slice(0, -1);
	// A two-item list takes no serial comma, so a flag scoped to two actions
	// reads as a sentence rather than as a truncated longer list.
	return leading.length === 1 ? `${leading[0]} and ${last}` : `${leading.join(", ")}, and ${last}`;
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
	// A second real-looking ID, so the anchor form of `move` reads unambiguously.
	const anchorExampleId = "retire-the-legacy-importer";
	// A third, so a repeated --depends-on names two different goals.
	const secondDependencyId = "ship-the-new-parser";
	// An `updatedAt` in the stored ISO 8601 shape, as `show` reports it.
	const exampleUpdatedAt = "2026-05-04T09:12:31.004Z";
	const examples = [
		"list --json",
		'add Support goal templates --description "Let teams share reusable goal outlines"',
		"find templates --json",
		`show ${exampleId} --json`,
		`update ${exampleId} --description "Replace only the description"`,
		`update ${exampleId} Support shared goal templates`,
		`update ${exampleId} --append-description "Blocked on the template schema until it lands"`,
		`update ${exampleId} --expect-updated-at ${exampleUpdatedAt} --append-description "Reviewed and still current"`,
		`update ${exampleId} --group Foundation`,
		`add Retire the legacy importer --depends-on ${exampleId} --depends-on ${secondDependencyId}`,
		`update ${anchorExampleId} --depends-on ${exampleId}`,
		`update ${anchorExampleId} --depends-on ''`,
		`move ${exampleId} up`,
		`move ${exampleId} before ${anchorExampleId}`,
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
		...contract.descriptionRules,
		"Programmatic callers clear a description with `--description ''`; the interactive `update <id> --` form remains supported.",
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
		"## Goal order and grouping",
		"",
		...contract.orderRules.map((rule) => `- ${rule}`),
		"- `--group <name>` on `add` and `update` files a goal under a free-form section; a group exists exactly when some goal names it, and `--group ''` clears the field.",
		"",
		"## Dependencies",
		"",
		...contract.dependencyRules.map((rule) => `- ${rule}`),
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
		"## Description input",
		"",
		...contract.descriptionRules,
		"",
		"## Goal IDs",
		"",
		...contract.idRules.map((rule) => `- ${rule}`),
		"",
		"## Goal order and grouping",
		"",
		...contract.orderRules.map((rule) => `- ${rule}`),
		"- `--group <name>` on `add` and `update` files a goal under a free-form section; a group exists exactly when some goal names it, and `--group ''` clears the field.",
		"",
		"## Dependencies",
		"",
		...contract.dependencyRules.map((rule) => `- ${rule}`),
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
