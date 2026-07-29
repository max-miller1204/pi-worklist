<!-- Generated from src/cli-contract.ts by scripts/generate-docs.ts. Do not edit manually. -->

# pi-worklist CLI

Manage repository-wide Project Goals in <git-root>/.pi/worklist.json through the same application service, cross-process lock, and atomic replacement as a live Pi session. Session Tasks live inside a Pi session and are deliberately out of scope.

## Commands

| Command | Description |
| --- | --- |
| `pi-worklist project list` | Show a compact bounded list of project goals |
| `pi-worklist project show <id>` | Show one goal with its full description |
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
- Never pass --confirm for complete, reopen, archive, or delete unless the user explicitly requested that exact action.
- Treat exit code 3 as a request for explicit user confirmation, not as a retryable failure.
- Treat exit code 4 as a concurrent-change conflict: re-read current state before retrying.
- Use list for orientation and show <id> when you need a goal's complete description.
- Broad outcomes belong in Project Goals; do not mirror your internal step-by-step plan into them.
