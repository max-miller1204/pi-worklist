<!-- Generated from src/cli-contract.ts by scripts/generate-docs.ts. Do not edit manually. -->

# pi-worklist CLI

Manage repository-wide Project Goals in <git-root>/.pi/worklist.json through the same application service, cross-process lock, and atomic replacement as a live Pi session. Session Tasks live inside a Pi session and are deliberately out of scope.

## Invocation

Use the explicit `@latest` package specifier so a stale local npx cache cannot select an older CLI build:

```sh
npx -y pi-worklist@latest project <action> [arguments] [flags]
```

Every `--json` result envelope reports the running package version as `meta.cliVersion`.

## Commands

| Command | Description |
| --- | --- |
| `npx -y pi-worklist@latest project list` | Show a compact bounded list of project goals |
| `npx -y pi-worklist@latest project show <id>` | Show one goal with its full description |
| `npx -y pi-worklist@latest project find <text...>` | List the goals whose title or description contains the text |
| `npx -y pi-worklist@latest project ui` | Open the interactive goal board for a human at the keyboard. Requires a terminal; not for scripts or agents |
| `npx -y pi-worklist@latest project add <title...> [-- <description...>]` | Add an open goal |
| `npx -y pi-worklist@latest project update <id> [title...] [-- <description...>]` | Edit a goal; "-- " alone clears the description |
| `npx -y pi-worklist@latest project set_active <id>` | Make a goal the single active goal |
| `npx -y pi-worklist@latest project complete <id> --confirm` | Mark a goal done. Requires explicit user confirmation |
| `npx -y pi-worklist@latest project reopen <id> --confirm` | Reopen a done or archived goal. Requires explicit user confirmation |
| `npx -y pi-worklist@latest project archive <id> --confirm` | Archive a goal. Requires explicit user confirmation |
| `npx -y pi-worklist@latest project delete <id> --confirm` | Delete a goal permanently. Requires explicit user confirmation |
| `npx -y pi-worklist@latest project migrate_ids --confirm` | Rewrite randomly generated goal IDs as title-derived ones. Requires explicit user confirmation |
| `npx -y pi-worklist@latest project help` | Print this help |

## Flags

| Flag | Description |
| --- | --- |
| `--json` | Print the deterministic result envelope as JSON (stdout on success, stderr on failure) |
| `--confirm` | Acknowledge a lifecycle action; pass it only for an explicit user request |
| `--cwd <dir>` | Resolve the git root from this directory instead of the working directory |
| `--append` | Add the text after -- as a new paragraph instead of replacing the description; cannot be combined with a title change; only for project update |
| `--expect-updated-at <timestamp>` | Refuse the change as a conflict unless the goal's updatedAt still matches this value; only for project update, set_active, complete, reopen, archive, and delete |
| `--dry-run` | Report the ID rewrites without writing them, and without needing --confirm; only for project migrate_ids |

Put every flag before `--`, because each token after it is description text. A known flag there remains in the description and triggers a warning: stderr for human output, or the JSON envelope's `warnings` array if `--json` was already enabled. A trailing `--json` therefore does not select JSON output; the command prints human output and still exits 0.

## Goal IDs

- A goal's ID is derived from its title when the goal is created and frozen from then on, so it reads as words and a later rename never invalidates a reference written down elsewhere.
- Read an ID back from `list`, `find`, or `add` instead of deriving it from a title yourself: truncation and collision suffixes make a guessed slug unreliable.
- Every `<id>` argument also accepts a unique prefix of an ID, or an ID the goal answered to before `migrate_ids` renamed it.
- An ambiguous prefix is refused with the goals it matched instead of resolved by guesswork, so widen the prefix rather than retrying it.
- `find <text>` searches titles and descriptions, so locating a goal never needs `list --json` plus client-side filtering.

## Exit codes

| Code | Meaning |
| --- | --- |
| `0` | success |
| `1` | error |
| `2` | usage error |
| `3` | confirmation required |
| `4` | conflict |

## Agent guidance

- Prefer --json and read the deterministic result envelope instead of parsing human output.
- Write every flag before the -- separator, and read the CLI's own exit code rather than a shell pipeline's, so a swallowed flag cannot look like a failure or a success.
- Never run ui: it is an interactive board for a human, it holds the terminal until they quit, and it refuses to start without one.
- Never pass --confirm for complete, reopen, archive, delete, or migrate_ids unless the user explicitly requested that exact action.
- Treat exit code 3 as a request for explicit user confirmation, not as a retryable failure.
- Treat exit code 4 as a concurrent-change conflict: re-read current state before retrying.
- Use list for orientation, find <text> to locate a goal by wording, and show <id> when you need a goal's complete description.
- Pass a full ID or a prefix long enough to be unique; an ambiguous prefix is refused with candidates rather than resolved by guesswork.
- Run migrate_ids only when the user explicitly asks for it; it rewrites stored IDs, though every old ID keeps resolving afterwards.
- Add a note with --append instead of resending a description you did not write, so nothing in the existing text can be lost in transcription.
- Pass --expect-updated-at with the updatedAt from your own read whenever you change a goal, so your mutation conflicts if the goal changed in the meantime.
- Broad outcomes belong in Project Goals; do not mirror your internal step-by-step plan into them.
