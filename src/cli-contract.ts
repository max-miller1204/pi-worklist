/**
 * The single command contract for the pi-worklist CLI.
 *
 * CLI usage text, the generated skill guide in docs/cli.md, and agent guidance
 * are all rendered from this structure so they cannot drift from each other or
 * from the implemented command surface.
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

export const CLI_COMMAND_CONTRACT = {
	binary: "pi-worklist",
	scope: "project",
	intro:
		"Manage repository-wide Project Goals in <git-root>/.pi/worklist.json through the same application service, cross-process lock, and atomic replacement as a live Pi session. Session Tasks live inside a Pi session and are deliberately out of scope.",
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

/** The generated skill and agent guidance document, written to docs/cli.md. */
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
		"<!-- Generated from src/cli-contract.ts by scripts/generate-cli-docs.ts. Do not edit manually. -->",
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
