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
| `pi-worklist project list` | Show a compact bounded list of project goals |
| `pi-worklist project show <id>` | Show one goal with its full description |
| `pi-worklist project ui` | Open the interactive goal board for a human at the keyboard. Requires a terminal; not for scripts or agents |
| `pi-worklist project add <title...> [-- <description...>]` | Add an open goal |
| `pi-worklist project update <id> [title...] [-- <description...>]` | Edit a goal; "-- " alone clears the description |
| `pi-worklist project set_active <id>` | Make a goal the single active goal |
| `pi-worklist project complete <id> --confirm` | Mark a goal done. Requires explicit user confirmation |
| `pi-worklist project reopen <id> --confirm` | Reopen a done or archived goal. Requires explicit user confirmation |
| `pi-worklist project archive <id> --confirm` | Archive a goal. Requires explicit user confirmation |
| `pi-worklist project delete <id> --confirm` | Delete a goal permanently. Requires explicit user confirmation |
| `pi-worklist project help` | Print this help |

## Flags

| Flag | Description |
| --- | --- |
| `--json` | Print the deterministic result envelope as JSON (stdout on success, stderr on failure) |
| `--confirm` | Acknowledge a lifecycle action; pass it only for an explicit user request |
| `--cwd <dir>` | Resolve the git root from this directory instead of the working directory |

Put every flag before `--`, because each token after it is description text. A known global flag there remains in the description and triggers a warning: stderr for human output, or the JSON envelope's `warnings` array if `--json` was already enabled. A trailing `--json` therefore does not select JSON output; the command prints human output and still exits 0.

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
- Never pass --confirm for complete, reopen, archive, or delete unless the user explicitly requested that exact action.
- Treat exit code 3 as a request for explicit user confirmation, not as a retryable failure.
- Treat exit code 4 as a concurrent-change conflict: re-read current state before retrying.
- Use list for orientation and show <id> when you need a goal's complete description.
- Broad outcomes belong in Project Goals; do not mirror your internal step-by-step plan into them.
