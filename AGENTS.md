# pi-worklist agent notes

- Read Pi's installed `docs/extensions.md`, `docs/tui.md`, `docs/packages.md`, and `docs/session-format.md` before changing extension APIs.
- Session Tasks are canonical versioned custom-entry snapshots and must remain branch-aware.
- Project Goals are canonical in `<git-root>/.pi/worklist.json` and every mutation, from any interface (tool, command, dashboard, terminal board, CLI), must go through the shared `WorklistApplicationService` in `src/application-service.ts`, whose writes run through `src/project-mutations.ts` so the cross-process lock plus atomic rename apply everywhere.
- Never add a project lifecycle path that bypasses explicit confirmation.
- Goal IDs are derived from the title in `src/goal-selection.ts` and frozen at creation; every ID a live goal has had stays resolvable and reserved, while deleting a goal retires all its IDs so they stay reserved but no longer resolve. Any new live-reference field that stores a goal ID must resolve through `findGoalByStoredId` and be rewritten by `migrateProjectGoalIds`.
- Nothing reachable from `src/cli.ts`, including the terminal board in `src/tui/`, may import `@earendil-works/*`; the compiled bin has to run with nothing installed but Node.
- Keep the board's rendering pure in `src/tui/goal-board.ts` and all I/O in `src/tui/goal-board-runtime.ts`, so frames stay testable without a pseudo-terminal.
- Keep the widget compact and width-safe.
- Keep the model-facing schema compatible with Google providers by using `StringEnum` for string enums.
- Run `npm run check`, `npm audit`, `npm run pack:check`, and the real Pi RPC test before release.
- Do not manually add a changelog.
