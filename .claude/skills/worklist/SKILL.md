---
name: worklist
description: "Manage pi-worklist Project Goals (the shared roadmap in a repo's .pi/worklist.json) from any Claude session. Use when the user asks to add, list, update, activate, complete, reopen, archive, or delete a project goal, or to capture brainstormed ideas or future goals on a project's worklist or roadmap."
---

<!-- Generated from src/cli-contract.ts by scripts/generate-docs.ts. Do not edit manually. -->

# Managing pi-worklist Project Goals

Project Goals are a repository-wide roadmap stored in `<git-root>/.pi/worklist.json` and shared with Pi sessions.
Never edit that file directly: a concurrent Pi session may hold the cross-process lock, and direct edits bypass validation, ID generation, and timestamps.
Always go through the pi-worklist CLI, which routes every mutation through the same application service, cross-process lock, and atomic replacement as a live Pi session.

## Invoking the CLI

The published package ships a compiled `pi-worklist` bin (Node 20 or newer), usable from any repository without installing anything first:

```sh
npx -y pi-worklist project <action> [arguments] [flags]
```

Run it from inside the target repository, or pass `--cwd <repo-root>` to target another one.
Inside a pi-worklist development checkout, prefer the TypeScript entry point so unreleased changes apply: `node <checkout>/src/cli.ts project <action>` (needs Node 22.18 or newer for native type stripping).

Actions:

```text
list
show <id>
add <title...> [-- <description...>]
update <id> [title...] [-- <description...>]
set_active <id>
complete <id> --confirm
reopen <id> --confirm
archive <id> --confirm
delete <id> --confirm
help
```

Flags:

- `--json` - Print the deterministic result envelope as JSON (stdout on success, stderr on failure).
- `--confirm` - Acknowledge a lifecycle action; pass it only for an explicit user request.
- `--cwd <dir>` - Resolve the git root from this directory instead of the working directory.

Prefer `--json` whenever you need to read IDs, statuses, or errors back rather than parsing human output.
`list` output is compact and omits descriptions; use `show <id>` when you need a goal's complete description.
Text after `--` becomes the goal description.
`update <id> --` with nothing after the separator clears the description.

Examples:

```sh
npx -y pi-worklist project list --json
npx -y pi-worklist project add Support goal templates -- Let teams share reusable goal outlines
npx -y pi-worklist project show goal-ms6gwxrg-56c1bde6 --json
npx -y pi-worklist project update goal-ms6gwxrg-56c1bde6 -- Replace only the description
npx -y pi-worklist project update goal-ms6gwxrg-56c1bde6 Support shared goal templates
npx -y pi-worklist project set_active goal-ms6gwxrg-56c1bde6
```

Goal IDs are opaque: read them back from `list` or `add` output instead of constructing them.
The full generated command reference lives in the package's `docs/cli.md`, rendered from the same contract as this skill.

## Guardrails

- `complete`, `reopen`, `archive`, and `delete` are lifecycle actions reserved for explicit user intent.
  Pass `--confirm` only when the user explicitly requested that exact action on that goal in this conversation.
  Never pass it because a goal merely looks finished or stale.
- Exit code 3 (confirmation required) means the command needs `--confirm`; stop and ask the user instead of retrying with the flag.
- Exit code 4 (conflict) means a concurrent change conflicted with yours; re-read current state with `list` or `show` before retrying.
- `list`, `show`, `add`, `update`, and `set_active` are safe to run whenever they serve the user's request.
- Session Tasks cannot be managed from outside a Pi session; the CLI intentionally rejects `session` scope.
  For your own in-session tracking, use your normal task tools instead.

## Failure modes

- Exit code 1 (error) with a "Malformed" message means the target `.pi/worklist.json` is corrupt; report it to the user and never rewrite the file by hand.
- Exit code 1 with a "git repository" message means the working directory is outside a repo; rerun with `--cwd <repo-root>`.
  With `--json`, that failure also arrives as the deterministic result envelope on stderr.
- Exit code 2 (usage error) means the action or its flags were not recognized; re-read the action list above instead of guessing.
- If `npx -y pi-worklist` cannot resolve the package, check network access to the npm registry; a local development checkout remains a fallback.
