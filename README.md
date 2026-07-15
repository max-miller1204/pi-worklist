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
- A new Pi session starts with an empty Session Task list.
- Project Goals persist at `<git-root>/.pi/worklist.json` and can be committed with the repository.
- `/tasks` opens an interactive two-section dashboard.
- A compact widget shows the active Project Goal and up to three unfinished Session Tasks.
- The `worklist` model tool manages both scopes through one consistent API.
- Project Goal completion, reopening, archival, and deletion require explicit user intent.
- Cross-process locking and atomic replacement prevent concurrent Pi processes from losing updates or corrupting the project file.

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
Use Tab to switch lists, arrow keys to navigate, `a` to add, `e` to edit, Space or Enter to advance status, `d` to delete, and Escape to close.
Session Task edits change the title, while Project Goal edits can also change the description.

Direct commands are useful in RPC mode and scripts:

```text
/tasks session list
/tasks session add Write RPC regression tests
/tasks session add Verify the dashboard behavior
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
Typing a Project Goal lifecycle command is explicit user intent.
The model-facing tool instead requires `confirm=true`, and its prompt rules prohibit setting that flag without an explicit request.

## Storage semantics

Session Tasks are stored as versioned Pi custom entries in the current session tree.
Snapshots written by earlier releases are still loaded, and any legacy Session Task descriptions are dropped during migration.
Session Tasks do not enter model context directly.
Only the active goal and an intentionally bounded list of incomplete tasks are added to the current turn's system prompt.

Project Goals use a schema-versioned JSON file at `.pi/worklist.json` in the canonical Git root.
The file is human-readable and suitable for version control.
A malformed or unsupported file is reported and never overwritten automatically.
Project Goal operations are unavailable outside a Git repository, while Session Tasks continue to work normally.

## Model tool

The `worklist` tool accepts `scope=session|project` and actions including `list`, `add`, `update`, `set_status`, `set_active`, `complete`, `reopen`, `archive`, and `delete`.
Session Tasks use concise, self-contained titles without descriptions.
Agents are instructed to split non-trivial work into several concrete, independently completable Session Tasks instead of copying the broad end goal into one task.
Session Task statuses are `todo`, `doing`, and `done`.
Project Goal statuses are `open`, `active`, `done`, and `archived`.
Only activation is a non-destructive direct Project Goal status change.

## Development

```sh
git clone https://github.com/max-miller1204/pi-worklist.git
cd pi-worklist
npm install
npm run check
npm run pack:check
```

The test suite includes a real Pi RPC load test in a temporary Git repository.
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
