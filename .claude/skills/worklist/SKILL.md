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
npx -y pi-worklist@latest project <action> [arguments] [flags]
```

Run it from inside the target repository, or pass `--cwd <repo-root>` to target another one.
Inside a pi-worklist development checkout, prefer the TypeScript entry point so unreleased changes apply: `node <checkout>/src/cli.ts project <action>` (needs Node 22.18 or newer for native type stripping).

Actions:

```text
list
show <id>
find <text...>
ui
add <title...> [-- <description...>]
update <id> [title...] [-- <description...>]
set_active <id>
complete <id> --confirm
reopen <id> --confirm
archive <id> --confirm
delete <id> --confirm
migrate_ids --confirm
help
```

Flags:

- `--json` - Print the deterministic result envelope as JSON (stdout on success, stderr on failure).
- `--confirm` - Acknowledge a lifecycle action; pass it only for an explicit user request.
- `--cwd <dir>` - Resolve the git root from this directory instead of the working directory.
- `--append` - Add the text after -- as a new paragraph instead of replacing the description; cannot be combined with a title change; only for project update.
- `--expect-updated-at <timestamp>` - Refuse the change as a conflict unless the goal's updatedAt still matches this value; only for project update, set_active, complete, reopen, archive, and delete.
- `--dry-run` - Report the ID rewrites without writing them, and without needing --confirm; only for project migrate_ids.

Prefer `--json` whenever you need to read IDs, statuses, or errors back rather than parsing human output.
`list` output is compact and omits descriptions; use `show <id>` when you need a goal's complete description.
Text after `--` becomes the goal description.
Put every flag before `--`, because each token after it is description text. A known flag there remains in the description and triggers a warning: stderr for human output, or the JSON envelope's `warnings` array if `--json` was already enabled. A trailing `--json` therefore does not select JSON output; the command prints human output and still exits 0.
`update <id> --` with nothing after the separator clears the description.
`update <id> --append -- <text>` adds that text as a new paragraph instead, so recording a note never rewrites, and never risks losing, prose you did not author.
`--expect-updated-at <updatedAt>`, copied from your own `show` of that goal, refuses the change when someone edited the goal after you read it.
Pass it on every change you make to a goal you did not just create: without it, your mutation proceeds even if the goal changed after you read it.

Examples:

```sh
npx -y pi-worklist@latest project list --json
npx -y pi-worklist@latest project add Support goal templates -- Let teams share reusable goal outlines
npx -y pi-worklist@latest project find templates --json
npx -y pi-worklist@latest project show support-goal-templates --json
npx -y pi-worklist@latest project update support-goal-templates -- Replace only the description
npx -y pi-worklist@latest project update support-goal-templates Support shared goal templates
npx -y pi-worklist@latest project update support-goal-templates --append -- Blocked on the template schema until it lands
npx -y pi-worklist@latest project update support-goal-templates --expect-updated-at 2026-05-04T09:12:31.004Z --append -- Reviewed and still current
npx -y pi-worklist@latest project set_active support-goal-templates
```

The full generated command reference lives in the package's `docs/cli.md`, rendered from the same contract as this skill.

## Goal IDs

- A goal's ID is derived from its title when the goal is created and frozen from then on, so it reads as words and a later rename never invalidates a reference written down elsewhere.
- Read an ID back from `list`, `find`, or `add` instead of deriving it from a title yourself: truncation and collision suffixes make a guessed slug unreliable.
- Every `<id>` argument also accepts a unique prefix of an ID, or an ID the goal answered to before `migrate_ids` renamed it.
- An ambiguous prefix is refused with the goals it matched instead of resolved by guesswork, so widen the prefix rather than retrying it.
- Deleting a goal permanently retires its current and former IDs: they stop resolving, but no later goal can claim them and inherit stale references.
- `find <text>` searches titles and descriptions, so locating a goal never needs `list --json` plus client-side filtering.

## Guardrails

- `complete`, `reopen`, `archive`, `delete`, and `migrate_ids` are reserved for explicit user intent.
  Pass `--confirm` only for the exact action, on the exact goal, that the user requested in this conversation.
  Never pass it because a goal merely looks finished or stale.
- `migrate_ids` names no goal and rewrites every generated ID in the repository at once, so it needs an explicit request of its own.
  `--dry-run` reports the rewrites it would make without writing them and without `--confirm`; prefer it when you are showing the user what would change.
- Exit code 3 (confirmation required) means the command needs `--confirm`; stop and ask the user instead of retrying with the flag.
- Exit code 4 (conflict) means a concurrent change conflicted with yours; re-read current state with `list` or `show` before retrying.
  A conflicting change wrote nothing at all, so rebuild it against the goal you just re-read and pass that goal's new `updatedAt`.
- `list`, `show`, `find`, `add`, `update`, and `set_active` are safe to run whenever they serve the user's request.
- `ui` opens a full-screen board for the human at the keyboard, not for you.
  Never run it: it holds the terminal until the user quits, and it exits with an error when stdin or stdout is not a terminal.
  Suggest `npx -y pi-worklist@latest project ui` when the user wants to browse or edit goals themselves; read state with `list` and `show` instead.
- Session Tasks cannot be managed from outside a Pi session; the CLI intentionally rejects `session` scope.
  For your own in-session tracking, use your normal task tools instead.

## Failure modes

- Exit code 1 (error) with a "Malformed" message means the target `.pi/worklist.json` is corrupt; report it to the user and never rewrite the file by hand.
- Exit code 1 with a "git repository" message means the working directory is outside a repo; rerun with `--cwd <repo-root>`.
  With `--json`, that failure also arrives as the deterministic result envelope on stderr.
- Exit code 2 (usage error) means the action or its flags were not recognized; re-read the action list above instead of guessing.
- If `npx -y pi-worklist@latest` cannot resolve the package, check network access to the npm registry; a local development checkout remains a fallback.
- Read `meta.cliVersion` from any `--json` result envelope when you need to verify which published build ran.
  This reports the package's runtime version directly instead of requiring inspection of the npx cache.
