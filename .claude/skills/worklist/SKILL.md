---
name: worklist
description: "Manage pi-worklist Project Goals (the shared roadmap in a repo's .pi/worklist.json) from any Claude session. Use when the user asks to add, list, find, update, activate, complete, reopen, archive, or delete a project goal; migrate goal IDs; or capture brainstormed ideas or future goals on a project's worklist or roadmap."
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
add <title...> [--description <text> | -- <description...>]
update <id> [title...] [--description <text> | -- <description...>]
move <id> up|down|before <id>|after <id>
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
- `--confirm` - Acknowledge an action that requires confirmation; pass it only for an explicit user request.
- `--cwd <dir>` - Resolve the git root from this directory instead of the working directory.
- `--description <text>` - Set the whole description from one argv token; order-independent and preferred for agents and scripts; only for project add and update.
- `--append-description <text>` - Add one argv token as a new description paragraph without replacing stored prose; cannot be combined with a title change; only for project update.
- `--append` - Interactive compatibility form that adds the text after -- as a new paragraph; cannot be combined with a title change; only for project update.
- `--group <name>` - Put the goal in a free-form section, such as Foundation; an empty name clears it; only for project add and update.
- `--depends-on <id>` - Require that goal to land first; repeat it to name several, and pass an empty id alone to clear every edge; only for project add and update.
- `--expect-updated-at <timestamp>` - Refuse the change as a conflict unless the goal's updatedAt still matches this value; only for project update, set_active, complete, reopen, archive, and delete.
- `--dry-run` - Report the ID rewrites without writing them, and without needing --confirm; only for project migrate_ids.

Prefer `--json` whenever you need to read IDs, statuses, or errors back rather than parsing human output.
`list` output is compact and omits descriptions; use `show <id>` when you need a goal's complete description.
Programmatic callers and agents must use `--description <text>` for a replacement, passing the whole value in one argv token. The flag is order-independent, and its value may itself look like a known flag.
Use `--append-description <text>` to add a paragraph without replaying stored prose. Replacing and appending are mutually exclusive, and an append cannot be combined with a title change.
Reserve `-- <description...>` for a human typing unquoted prose interactively. A standalone known flag after the separator is a usage error with exit code 2; move a real flag before the separator or put flag-looking prose in `--description`.
The legacy `--append -- <text>` interactive form remains supported, while agents and scripts use `--append-description <text>`.
Programmatic callers clear a description with `--description ''`; the interactive `update <id> --` form remains supported.
`--expect-updated-at <updatedAt>`, copied from your own `show` of that goal, refuses the change when someone edited the goal after you read it.
Pass it on every change you make to a goal you did not just create: without it, your mutation proceeds even if the goal changed after you read it.

Examples:

```sh
npx -y pi-worklist@latest project list --json
npx -y pi-worklist@latest project add Support goal templates --description "Let teams share reusable goal outlines"
npx -y pi-worklist@latest project find templates --json
npx -y pi-worklist@latest project show support-goal-templates --json
npx -y pi-worklist@latest project update support-goal-templates --description "Replace only the description"
npx -y pi-worklist@latest project update support-goal-templates Support shared goal templates
npx -y pi-worklist@latest project update support-goal-templates --append-description "Blocked on the template schema until it lands"
npx -y pi-worklist@latest project update support-goal-templates --expect-updated-at 2026-05-04T09:12:31.004Z --append-description "Reviewed and still current"
npx -y pi-worklist@latest project update support-goal-templates --group Foundation
npx -y pi-worklist@latest project add Retire the legacy importer --depends-on support-goal-templates --depends-on ship-the-new-parser
npx -y pi-worklist@latest project update retire-the-legacy-importer --depends-on support-goal-templates
npx -y pi-worklist@latest project update retire-the-legacy-importer --depends-on ''
npx -y pi-worklist@latest project move support-goal-templates up
npx -y pi-worklist@latest project move support-goal-templates before retire-the-legacy-importer
npx -y pi-worklist@latest project set_active support-goal-templates
```

The full generated command reference lives in the package's `docs/cli.md`, rendered from the same contract as this skill.

## Goal IDs

- A goal's ID is derived from its title when the goal is created and frozen from then on, so it reads as words and a later rename never invalidates a reference written down elsewhere.
- A title-derived ID never uses the legacy random-ID shape, so `migrate_ids` can identify generated IDs without consulting a title that may have changed.
- Read an ID back from `list`, `find`, or `add` instead of deriving it from a title yourself: truncation and collision suffixes make a guessed slug unreliable.
- Every `<id>` argument also accepts a unique prefix of an ID, or an ID the goal answered to before `migrate_ids` renamed it.
- An ambiguous prefix is refused with the goals it matched instead of resolved by guesswork, so widen the prefix rather than retrying it.
- Deleting a goal permanently retires its current and former IDs: they stop resolving, but no later goal can claim them and inherit stale references.
- `find <text>` searches titles and descriptions, so locating a goal never needs `list --json` plus client-side filtering.

## Goal order and grouping

- Goals are stored and listed in one canonical order: `add` appends to the end, and `move` is the only action that rearranges them.
- `move <id> up` and `move <id> down` step one place, while `move <id> before <anchor>` and `move <id> after <anchor>` land the goal beside a named one.
- A move changes the roadmap's order without touching the moved goal's `updatedAt`, so rearranging the list never reads as editing the goals on it.
- Reordering needs no confirmation, because it names no new state for a goal, only a new position among the others.
- `--group <name>` on `add` and `update` files a goal under a free-form section; a group exists exactly when some goal names it, and `--group ''` clears the field.

## Dependencies

- `--depends-on <id>` on `add` and `update` records that the named goal must land before this one; repeat the flag to name several, and `--depends-on ''` on its own clears every edge.
- An `update` replaces the whole set rather than adding to it, so name every edge the goal should end up with, not just the new one.
- An edge means must-land-before whatever its reason, so a logical prerequisite and two goals that would collide in the same files are recorded the same way.
- A dependency is satisfied once its target is done or archived, and a goal with an unsatisfied dependency is blocked.
- Blocked is derived from the edges on every read and never stored: there is no blocked status, and `set_active` warns about a blocked goal instead of refusing it.
- Only the forward direction is stored, and `show <id>` derives what the goal blocks, so an edge is written once and the two directions cannot drift apart.
- An update that would form a cycle, including an existing goal naming itself, is refused with `DEPENDENCY_CYCLE`.
- Add resolves dependencies before minting the new goal's ID, so an edge naming a guessed future slug is refused with `NOT_FOUND`, like any ID that names no existing goal.
- Deleting a goal drops the edges naming it in the same atomic change.
- File order is presentation and a tiebreak while the dependency graph is the source of truth for what may start; the two are allowed to disagree, and neither should be edited to mirror the other.

## Guardrails

- `complete`, `reopen`, `archive`, `delete`, and `migrate_ids` are reserved for explicit user intent.
  Pass `--confirm` only for the exact action the user requested and, when the action names a goal, only for that exact goal.
  Never pass it because a goal merely looks finished or stale.
- `migrate_ids` names no goal and rewrites every generated ID in the repository at once, so it needs an explicit request of its own.
  `--dry-run` reports the rewrites it would make without writing them and without `--confirm`; prefer it when you are showing the user what would change.
- Exit code 3 (confirmation required) means the command needs `--confirm`; stop and ask the user instead of retrying with the flag.
- Exit code 4 (conflict) means a concurrent change conflicted with yours; re-read current state with `list` or `show` before retrying.
  A conflicting change wrote nothing at all, so rebuild it against the goal you just re-read and pass that goal's new `updatedAt`.
- `list`, `show`, `find`, `add`, `update`, `move`, and `set_active` are safe to run whenever they serve the user's request.
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
