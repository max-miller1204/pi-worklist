# pi-worklist agent notes

- Read Pi's installed `docs/extensions.md`, `docs/tui.md`, `docs/packages.md`, and `docs/session-format.md` before changing extension APIs.
- Session Tasks are canonical versioned custom-entry snapshots and must remain branch-aware.
- Project Goals are canonical in `<git-root>/.pi/worklist.json` and every mutation must use the cross-process lock plus atomic rename.
- Never add a project lifecycle path that bypasses explicit confirmation.
- Keep the widget compact and width-safe.
- Keep the model-facing schema compatible with Google providers by using `StringEnum` for string enums.
- Run `npm run check`, `npm audit`, `npm run pack:check`, and the real Pi RPC test before release.
- Do not manually add a changelog.
