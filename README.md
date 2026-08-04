<!-- markdownlint-disable MD013 -->

# pi-worklist

[![npm version](https://img.shields.io/npm/v/pi-worklist.svg)](https://www.npmjs.com/package/pi-worklist)
[![CI](https://github.com/max-miller1204/pi-worklist/actions/workflows/ci.yml/badge.svg)](https://github.com/max-miller1204/pi-worklist/actions/workflows/ci.yml)
[![Pi package](https://img.shields.io/badge/Pi-package-8a76b5)](https://pi.dev/packages/pi-worklist)

`pi-worklist` gives Pi two deliberately different lists.
Session Tasks track the concrete work in the current coding session.
Project Goals track the larger outcomes shared by every Pi session in a Git repository.

## Features

- Branch-aware Session Tasks survive `/resume` and follow `/tree`, `/fork`, and `/clone`.
- Session Tasks stay intentionally small and title-only, so they represent executable chunks rather than broad outcomes.
- Session Task array order is a canonical queue that supports stable-ID insertion and movement.
- A new Pi session starts with an empty Session Task list.
- Project Goals persist at `<git-root>/.pi/worklist.json` and can be committed with the repository.
- `/tasks` opens an interactive two-section dashboard.
- A compact widget shows the active Project Goal and up to three unfinished Session Tasks.
- The `worklist` model tool manages both scopes through one consistent API.
- A Pi-free external CLI lets scripts and other agents manage Project Goals without a running Pi session.
- `npx -y pi-worklist@latest project ui` opens a dependency-free terminal board for browsing and editing Project Goals outside Pi.
- An installable agent skill, generated from the same command contract as the CLI, teaches coding agents to drive that CLI in any repository.
- Project Goal completion, reopening, archival, and deletion require explicit user intent.
- Cross-process locking and atomic replacement serialize writes and prevent project-file corruption; optional goal baselines detect stale mutations.

## Install

Install the published package from npm:

```sh
pi install npm:pi-worklist
```

View it in the [Pi package gallery](https://pi.dev/packages/pi-worklist) or on [npm](https://www.npmjs.com/package/pi-worklist).

Install directly from GitHub:

```sh
pi install git:github.com/max-miller1204/pi-worklist
```

Try a checkout without installing it:

```sh
pi -e ./src/extension.ts
```

## Usage

Run `/tasks` with no arguments to open the dashboard.
Use Tab to switch lists and arrow keys to navigate.
In Session Tasks, `a` appends, `i` inserts before the selected task, and Shift+Up or Shift+Down moves the selected task.
Project Goals support `a` to add but do not support insertion or reordering.
In either scope, press Enter to open a detail window, Space to advance status, `e` to edit, `d` to delete, and Escape to close.
The detail window wraps complete descriptions and metadata instead of truncating them.
Use Up and Down or `j` and `k` to scroll long details, with Page Up and Page Down for larger jumps, then Enter or Escape to return to the dashboard.
For a Session Task associated with a Project Goal, the detail window also shows the goal title and full description.
The dashboard keeps the current list and the selected task across each action, so a moved task stays selected at its new position.
Session Task edits change the title, while Project Goal edits can also change the description.

Direct commands are useful in RPC mode and scripts:

```text
/tasks session list
/tasks session add Write RPC regression tests
/tasks session add --before <anchor-id> Reproduce the failure first
/tasks session add --after <anchor-id> Verify the dashboard behavior
/tasks session add Verify the dashboard behavior --after <anchor-id>
/tasks session move <task-id> --before <anchor-id>
/tasks session move <task-id> --after <anchor-id>
/tasks session update <id> Replace the task title
/tasks session status <id> doing
/tasks project list
/tasks project add Replace legacy authentication -- Migrate every supported client
/tasks project update <id> -- Replace the goal description
/tasks project set_active <id>
/tasks project complete <id>
```

Text after `--` is stored as the optional Project Goal description for `add` and `update` commands.
Session Tasks do not support descriptions.
Session Task `add` accepts either `--before <anchor-id>` or `--after <anchor-id>` and appends when neither is supplied.
Session Task `move` requires exactly one of those stable-ID anchors.
An anchor flag and its ID may lead the arguments or trail them, but only one anchor flag is accepted per command.
Project Goals do not accept placement or movement.
Typing a Project Goal lifecycle command is explicit user intent.
The model-facing tool instead requires `confirm=true`, and its prompt rules prohibit setting that flag without an explicit request.

## Storage semantics

Session Tasks are stored as versioned Pi custom entries in the current session tree.
Each snapshot carries an opaque concurrency token that follows the active `/tree`, `/fork`, `/clone`, or resumed branch.
Snapshots written by earlier releases are still loaded, derive their token from the Pi custom entry ID when necessary, retain existing task IDs, and drop legacy descriptions and legacy orchestrator metadata during in-memory migration.
The next Session Task mutation writes the migrated state as snapshot version 3.
A branch without a snapshot uses the opaque baseline token `0`.
Completed tasks remain in canonical queue order.
Only the active goal and an intentionally bounded list of incomplete task titles and statuses are added to the current turn's system prompt, preserving their relative queue order.

Project Goals use a schema-versioned JSON file at `.pi/worklist.json` in the canonical Git root.
The file carries a monotonic numeric revision, while application callers receive that revision as an opaque string.
Legacy files without a revision remain readable at revision `0` and gain revision `1` on their next mutation.
Optional expected-revision checks run under the same cross-process lock as persistence and return a typed conflict without rewriting stale state.
A Project Goal mutation can also carry the target goal's `updatedAt` as a precondition, checked under that same lock, which guards exactly one goal where the file-wide revision would reject every unrelated concurrent change instead.
Appending to a description resolves against the stored text under the lock, so an added note composes with a concurrent edit rather than replaying the caller's baseline over it.
Session Task expected-revision checks run inside the serialized mutation queue and return the active branch token in conflicts.
A semantic no-op preserves the Project Worklist file bytes, Project Goal timestamps, Project Worklist revision, Session Task snapshot count, and Session Task branch token.
The file is human-readable and suitable for version control.
A malformed or unsupported file is reported and never overwritten automatically.
Project Goal operations are unavailable outside a Git repository, while Session Tasks continue to work normally.

## Model tool

The `worklist` tool accepts `scope=session|project` and actions including `list`, `add`, `move`, `update`, `set_status`, `set_active`, `complete`, `reopen`, `archive`, and `delete`.
For Session Tasks, `add` optionally accepts exactly one of `beforeId` or `afterId`, while `move` requires exactly one.
Moves preserve the task ID, title, status, and Project Goal association.
Self-placement, already-satisfied placement, identical Session Task updates, and repeated status changes succeed without writing another session snapshot.
Session Tasks use concise, self-contained titles without descriptions.
Agents are instructed to split non-trivial work into several concrete, independently completable Session Tasks instead of copying the broad end goal into one task.
Session Task statuses are `todo`, `doing`, and `done`.
Project Goal statuses are `open`, `active`, `done`, and `archived`.
Only activation is a non-destructive direct Project Goal status change.

## External CLI

External agents and scripts can manage Project Goals without a running Pi session.
The published package ships a compiled `pi-worklist` bin, so no development checkout is needed:

```sh
npx -y pi-worklist@latest project list
npx -y pi-worklist@latest project show <id>
npx -y pi-worklist@latest project add Support goal templates -- Let teams share reusable goal outlines
npx -y pi-worklist@latest project update <id> Replace the title -- Replace the description
npx -y pi-worklist@latest project update <id> --append -- Add a note as a new paragraph
npx -y pi-worklist@latest project update <id> --expect-updated-at <updatedAt> --append -- Add it only if nobody edited first
npx -y pi-worklist@latest project set_active <id>
npx -y pi-worklist@latest project complete <id> --confirm
```

The CLI routes every mutation through the same service, cross-process lock, and atomic replacement as a live Pi session, so physical writes are serialized and atomic.
`list` output is deliberately compact without descriptions; `show <id>` prints one goal in full detail.
Lifecycle actions (`complete`, `reopen`, `archive`, `delete`) require `--confirm`, mirroring the model tool's explicit-intent rule; an omitted flag exits with code 3 and changes nothing.
`--append` adds the text after `--` as a new paragraph instead of replacing the description, so recording a note never re-sends, and never risks losing, prose the caller did not write.
`--expect-updated-at <timestamp>` carries the goal's `updatedAt` from the caller's own read, and applies to `update`, `set_active`, and the lifecycle actions.
Without it, a mutation built on a stale read proceeds unreported; a full description replacement can silently overwrite newer prose because the cross-process lock serializes writes without tracking the caller's baseline.
Exit code 4 reports a concurrent-change conflict, whether the file-wide revision or a single goal moved; nothing is written, so re-read current state, rebuild the change on it, and retry.
The explicit `@latest` package specifier prevents a stale local npx cache from selecting an older CLI build.
`--json` prints a deterministic CLI result envelope, preserving the full application result while adding the running package version in `meta.cliVersion`, on stdout for success and stderr for failure; `--cwd <dir>` resolves the Git root from another directory.
The complete command reference in [docs/cli.md](docs/cli.md) is generated from `src/cli-contract.ts`, the same contract that renders the CLI help and agent guidance.
In a development checkout, `node src/cli.ts project <action>` runs the same CLI; running the TypeScript entry point directly requires Node 22.18 or newer (for example Node 24), which strips types natively.
On older Node versions, including the Node 20 floor of the package's `engines` range, the TypeScript entry point fails with an `Unknown file extension ".ts"` error, while the compiled bin has no such requirement.
Session Tasks are intentionally unavailable here because they live inside a Pi session tree.

## Terminal goal board

`npx -y pi-worklist@latest project ui` opens an interactive board over the same Project Goals, so the roadmap can be read and edited from a shell without starting a Pi session:

```sh
npx -y pi-worklist@latest project ui
```

The board is a split view: the goal list on the left, the selected goal's status, timestamps, identifier, and complete description on the right.
Below about 76 columns the two panes stack instead, and the layout stays aligned for titles containing wide or combined characters.

| Key | Action |
| --- | --- |
| `↑` `↓` or `j` `k` | Move the selection, or scroll the detail pane once it has focus |
| `←` `→` or Tab | Move focus between the list and the detail pane |
| `g` `G`, Page Up, Page Down | Jump to the ends, or page through either pane |
| Space | Advance: an open goal activates, the active goal completes, a settled goal reopens |
| `s` | Make the selected open goal the single active goal |
| `a`, `e` | Add a goal, or rename the selected one |
| `E` | Edit the selected goal's description in `$VISUAL` or `$EDITOR` |
| `c` `r` `x` `d` | Complete, reopen, archive, or delete the selected goal |
| `f`, `/` | Cycle the status filter, or search titles and descriptions |
| `R`, `?`, `q` | Reload from disk, show the key map, or quit |

Every change routes through the same application service, cross-process lock, and atomic replacement as `/tasks` and the rest of the CLI, so a Pi session may be open on the same repository at the same time.
The board reloads automatically when another process writes the file.
Completing, reopening, archiving, and deleting each ask for confirmation first, and only an explicit `y` proceeds; that answer is the explicit user intent the application service requires.
The board is drawn with no runtime dependencies, so the compiled bin needs nothing installed but Node.
It requires a terminal and refuses to start without one, which keeps `list` and `--json` the read path for scripts and agents.

## Agent skill

A skill in `.claude/skills/worklist/` teaches coding agents to drive the CLI under the same guardrails, so a session manages goals correctly without being walked through it each time.
Install it for every project:

```sh
npx skills add max-miller1204/pi-worklist --skill worklist -g
```

Drop `-g` to install it for the current project only, or add `-a claude-code` to target one agent instead of choosing interactively.
The [`skills` CLI](https://github.com/vercel-labs/skills) reads `.claude/skills/` directly from this repository, symlinks it into each agent's skill directory, and refreshes it later with `npx skills update`.
Installing the npm package does not install the skill: the tarball carries `.claude/skills/worklist/SKILL.md` so the published package stays self-describing, but `node_modules` is not a directory agents scan for skills.

`SKILL.md` is generated from `src/cli-contract.ts` by `scripts/generate-docs.ts`, the same contract that renders the CLI help and [docs/cli.md](docs/cli.md).
Never hand-edit it; run `npm run docs` and commit the result, which `npm run docs:check` and the test suite both enforce.
The generated skill is deliberately repository-neutral and invokes the CLI as `npx -y pi-worklist@latest`, so a single file serves every checkout without letting a stale npx cache select an older build.
Working on the skill itself is the one case for symlinking `.claude/skills/worklist` into `~/.claude/skills/`, which makes the installed skill track your working tree.

## Development

```sh
git clone https://github.com/max-miller1204/pi-worklist.git
cd pi-worklist
npm install
npm run check
npm run pack:check
```

The test suite includes real Pi RPC load tests in temporary repositories.
The package uses TypeScript source directly because Pi loads extensions through jiti.

## Publishing and the Pi gallery

The package is published to npm and listed in the [Pi package gallery](https://pi.dev/packages/pi-worklist).
The `pi-package` npm keyword and `pi.extensions` manifest let the gallery discover releases automatically without a separate submission process.

### Future releases

Start from a clean, current `main` branch and authenticate with npm:

```sh
git switch main
git pull --ff-only
npm login --auth-type=web
npm whoami
```

Install the locked dependencies and run every release check:

```sh
npm ci
npm run verify
npm audit --audit-level=high
```

Create the release commit and tag with the appropriate semantic version bump:

```sh
npm version patch
# Use `npm version minor` or `npm version major` when appropriate.
```

Publish the new public package, then push the version commit and tag:

```sh
npm publish --access public
git push origin main --follow-tags
```

Verify npm, Pi installation, and the gallery after publication:

```sh
npm view pi-worklist version
pi update npm:pi-worklist
```

Each npm version is immutable, so bump the version before every subsequent publication.
If publication succeeds but the Git push fails, fix the Git problem and retry only the push rather than publishing the same version again.
The Pi gallery may take a short time to refresh after npm accepts a release.

## License

MIT
