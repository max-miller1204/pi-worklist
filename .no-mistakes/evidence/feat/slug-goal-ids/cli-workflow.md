# Slug goal IDs: end-to-end CLI evidence

Captured on 2026-08-04 by running the real TypeScript CLI with Bun against isolated Git repositories. Exit codes are shown after each command.

## Creation, collision suffixes, frozen IDs, search, and ambiguity

```console
$ bun ./src/cli.ts project add Support goal templates --cwd <repo> -- "Reusable outlines"
Added project goal support-goal-templates: Support goal templates
[exit 0]

$ bun ./src/cli.ts project add Support goal templates --cwd <repo> -- "Collision candidate"
Added project goal support-goal-templates-2: Support goal templates
[exit 0]

$ bun ./src/cli.ts project add Ship the CLI --cwd <repo> -- "External agent access"
Added project goal ship-the-cli: Ship the CLI
[exit 0]

$ bun ./src/cli.ts project list --cwd <repo>
[open] support-goal-templates: Support goal templates
[open] support-goal-templates-2: Support goal templates
[open] ship-the-cli: Ship the CLI
[exit 0]

$ bun ./src/cli.ts project update ship "Ship the compiled bin" --cwd <repo>
Updated project goal ship-the-cli
[exit 0]

$ bun ./src/cli.ts project show ship --cwd <repo>
ship-the-cli: Ship the compiled bin
status: open
created: 2026-08-04T06:21:40.037Z
updated: 2026-08-04T06:21:40.127Z
description:
External agent access
[exit 0]

$ bun ./src/cli.ts project find external agent --cwd <repo>
[open] ship-the-cli: Ship the compiled bin
[exit 0]

$ bun ./src/cli.ts project show support --cwd <repo>
Goal ID support matches 2 goals: support-goal-templates, support-goal-templates-2. Use a longer prefix or the full ID.
[exit 1]
```

The update used only the unique `ship` prefix. Its subsequent detail output retains `ship-the-cli` after the title changes, demonstrating that the ID is frozen. `find` locates the renamed goal through its description without a list-and-grep workflow. The ambiguous `support` prefix is rejected and lists both candidates.

## Unique prefixes on every CLI ID action

```console
$ bun ./src/cli.ts project add Lifecycle target --cwd <repo>
Added project goal lifecycle-target: Lifecycle target
[exit 0]

$ bun ./src/cli.ts project show life --cwd <repo>
lifecycle-target: Lifecycle target
status: open
created: 2026-08-04T06:21:40.292Z
updated: 2026-08-04T06:21:40.292Z
[exit 0]

$ bun ./src/cli.ts project update life "Lifecycle target renamed" --cwd <repo>
Updated project goal lifecycle-target
[exit 0]

$ bun ./src/cli.ts project set_active life --cwd <repo>
Activated project goal lifecycle-target
[exit 0]

$ bun ./src/cli.ts project complete life --confirm --cwd <repo>
Project goal lifecycle-target is now done
[exit 0]

$ bun ./src/cli.ts project reopen life --confirm --cwd <repo>
Project goal lifecycle-target is now open
[exit 0]

$ bun ./src/cli.ts project archive life --confirm --cwd <repo>
Project goal lifecycle-target is now archived
[exit 0]

$ bun ./src/cli.ts project delete life --confirm --cwd <repo>
Deleted project goal life
[exit 0]
```

The `life` prefix succeeds for all seven ID-bearing CLI actions: `show`, `update`, `set_active`, `complete`, `reopen`, `archive`, and `delete`.

## Migration preview, confirmation gate, historical statuses, and former IDs

The migration fixture contained one done goal and one archived goal with legacy random IDs.

```console
$ bun ./src/cli.ts project migrate_ids --dry-run --cwd <migration-repo>
2 goal ID(s) would change:
  goal-ms6gwxrg-56c1bde6 -> completed-rollout
  goal-mryb1h5b-f5473d74 -> archived-prototype
[exit 0]

$ bun ./src/cli.ts project migrate_ids --cwd <migration-repo>
Project migrate_ids requires explicit confirmation. Pass --confirm only when the user explicitly requested this action.
[exit 3]

$ bun ./src/cli.ts project migrate_ids --confirm --cwd <migration-repo>
Migrated 2 goal ID(s):
  goal-ms6gwxrg-56c1bde6 -> completed-rollout
  goal-mryb1h5b-f5473d74 -> archived-prototype
[exit 0]

$ bun ./src/cli.ts project show goal-ms6gwxrg-56c1bde6 --cwd <migration-repo>
completed-rollout: Completed rollout
status: done
created: 2026-05-04T09:12:31.004Z
updated: 2026-08-04T06:21:40.749Z
former ids: goal-ms6gwxrg-56c1bde6
description:
Historical done-goal reference
[exit 0]

$ bun ./src/cli.ts project show goal-mryb1h5b-f5473d74 --cwd <migration-repo>
archived-prototype: Archived prototype
status: archived
created: 2026-04-01T09:12:31.004Z
updated: 2026-08-04T06:21:40.749Z
former ids: goal-mryb1h5b-f5473d74
description:
Historical archived-goal reference
[exit 0]
```

Persisted `.pi/worklist.json` after confirmation:

```json
{
  "version": 1,
  "revision": 8,
  "goals": [
    {
      "id": "completed-rollout",
      "title": "Completed rollout",
      "description": "Historical done-goal reference",
      "status": "done",
      "createdAt": "2026-05-04T09:12:31.004Z",
      "updatedAt": "2026-08-04T06:21:40.749Z",
      "previousIds": ["goal-ms6gwxrg-56c1bde6"]
    },
    {
      "id": "archived-prototype",
      "title": "Archived prototype",
      "description": "Historical archived-goal reference",
      "status": "archived",
      "createdAt": "2026-04-01T09:12:31.004Z",
      "updatedAt": "2026-08-04T06:21:40.749Z",
      "previousIds": ["goal-mryb1h5b-f5473d74"]
    }
  ]
}
```

Dry-run previews without writing, the unconfirmed mutation exits 3, and confirmation rewrites both historical statuses. Each old random ID still resolves to the same goal and is persisted in `previousIds`.
