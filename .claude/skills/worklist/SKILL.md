---
name: worklist
description: Manage this repository's pi-worklist Project Goals (the shared roadmap in .pi/worklist.json) from a Claude session. Use when the user asks to add, list, update, activate, complete, reopen, archive, or delete a project goal, or to capture brainstormed ideas or future goals on the project worklist or roadmap.
---

# Managing pi-worklist Project Goals

Project Goals are the repository-wide roadmap stored in `.pi/worklist.json` and shared with Pi sessions.
Never edit that file directly: a concurrent Pi session may hold the cross-process lock, and direct edits bypass validation, ID generation, and timestamps.
Always go through the CLI, which routes every mutation through the same service, lock, and atomic replacement as Pi itself.

## Invoking the CLI

Installed copies of the package ship a compiled `pi-worklist` bin; in this repository, run the TypeScript entry point directly from the root:

```sh
npx pi-worklist project <action> [arguments] [flags]
node src/cli.ts project <action> [arguments] [flags]
```

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

Add `--json` to get the deterministic result envelope as JSON, on stdout for success and stderr for failure; prefer it whenever you need to read IDs, statuses, or errors back.
`list` output is compact and omits descriptions; use `show <id>` when you need a goal's complete description.
Text after `--` becomes the goal description.
`update <id> --` with nothing after the separator clears the description.
The full generated command reference lives in `docs/cli.md`, rendered from `src/cli-contract.ts`.

Examples:

```sh
node src/cli.ts project add Support goal templates -- Let teams share reusable goal outlines
node src/cli.ts project list --json
node src/cli.ts project show goal-abc123-deadbeef
node src/cli.ts project set_active goal-abc123-deadbeef
```

## Guardrails

- `complete`, `reopen`, `archive`, and `delete` are lifecycle actions reserved for explicit user intent.
  Pass `--confirm` only when the user explicitly requested that exact action on that goal in this conversation.
  Never pass it because a goal merely looks finished or stale.
- Exit code 3 means the command needs `--confirm`; stop and ask the user instead of retrying with the flag.
- Exit code 4 means a concurrent change conflicted with yours; re-read current state with `list` or `show` before retrying.
- `add`, `list`, `show`, `update`, and `set_active` are safe to run whenever they serve the user's request.
- Session Tasks cannot be managed from outside a Pi session; the CLI intentionally rejects `session` scope.
  For your own in-session tracking, use your normal task tools instead.

## Failure modes

- Exit code 1 with a "Malformed" message means `.pi/worklist.json` is corrupt; report it to the user and never rewrite the file by hand.
- Exit code 1 with a "git repository" message means the working directory is outside a repo; rerun with `--cwd <repo-root>`.
- An `Unknown file extension ".ts"` error means the Node version is too old; the CLI runs TypeScript through native type stripping and needs Node 22.18 or newer (for example Node 24).
