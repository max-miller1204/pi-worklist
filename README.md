# pi-worklist

`pi-worklist` gives Pi two deliberately different lists.
Session Tasks track the concrete work in the current coding session.
Project Goals track the larger outcomes shared by every Pi session in a Git repository.

## Features

- Branch-aware Session Tasks survive `/resume` and follow `/tree`, `/fork`, and `/clone`.
- A new Pi session starts with an empty Session Task list.
- Project Goals persist at `<git-root>/.pi/worklist.json` and can be committed with the repository.
- `/tasks` opens an interactive two-section dashboard.
- A compact widget shows the active Project Goal and up to three unfinished Session Tasks.
- The `worklist` model tool manages both scopes through one consistent API.
- Project Goal completion, reopening, archival, and deletion require explicit user intent.
- Cross-process locking and atomic replacement prevent concurrent Pi processes from losing updates or corrupting the project file.

## Install

Install from npm after the first release:

```sh
pi install npm:pi-worklist
```

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

Direct commands are useful in RPC mode and scripts:

```text
/tasks session list
/tasks session add Write regression tests
/tasks session status <id> doing
/tasks project list
/tasks project add Replace legacy authentication
/tasks project set_active <id>
/tasks project complete <id>
```

Typing a Project Goal lifecycle command is explicit user intent.
The model-facing tool instead requires `confirm=true`, and its prompt rules prohibit setting that flag without an explicit request.

## Storage semantics

Session Tasks are stored as versioned Pi custom entries in the current session tree.
They do not enter model context directly.
Only the active goal and an intentionally bounded list of incomplete tasks are added to the current turn's system prompt.

Project Goals use a schema-versioned JSON file at `.pi/worklist.json` in the canonical Git root.
The file is human-readable and suitable for version control.
A malformed or unsupported file is reported and never overwritten automatically.
Project Goal operations are unavailable outside a Git repository, while Session Tasks continue to work normally.

## Model tool

The `worklist` tool accepts `scope=session|project` and actions including `list`, `add`, `update`, `set_status`, `set_active`, `complete`, `reopen`, `archive`, and `delete`.
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

The package contains the `pi-package` npm keyword and a `pi.extensions` manifest.
Publishing it to npm makes it discoverable by the package gallery at <https://pi.dev/packages> without a separate submission process.
Run the full validation suite before `npm publish`.

## License

MIT
