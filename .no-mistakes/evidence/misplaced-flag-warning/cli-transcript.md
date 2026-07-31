# Misplaced global flag CLI evidence

The development entry point `node <checkout>/src/cli.ts` was invoked from a fresh temporary Git repository. For readability, it is displayed below using the shipped binary name, `pi-worklist`.

```console
$ pi-worklist project add "Ship the CLI" -- "External agent access" --json
exit: 0
stdout:
Added project goal goal-ms9bm5bg-e9857f3d: Ship the CLI
stderr:
Warning: --json came after -- and became description text, not a flag.
Global flags must come before the -- separator, for example:
  pi-worklist project add <title> --json -- <description>
persisted description: "External agent access --json"

$ pi-worklist project add "Deduplicate flags" -- "Literal tokens" --confirm --json --confirm --cwd
exit: 0
stderr:
Warning: --confirm, --json, --cwd came after -- and became description text, not flags.
Global flags must come before the -- separator, for example:
  pi-worklist project add <title> --confirm -- <description>
persisted description: "Literal tokens --confirm --json --confirm --cwd"

$ pi-worklist project add "Legitimate prose" -- "Keep --custom literally"
exit: 0
stderr: (empty)
persisted description: "Keep --custom literally"

$ pi-worklist project add "Correct placement" --json -- "Machine readable"
exit: 0
stdout (selected fields):
{
  "ok": true,
  "action": "add",
  "title": "Correct placement",
  "description": "Machine readable"
}
stderr: (empty)

$ pi-worklist project add "Strict validation" --unknown -- "Description"
exit: 2
stderr (first line):
Unknown flag --unknown
```

The committed human reference and agent skill were also compared with their generated renders using the contract's exact `separatorRule` value:

```json
{
  "docs_rule_occurrences": 1,
  "skill_rule_occurrences": 1,
  "docs_match_generated_render": true,
  "skill_matches_generated_render": true,
  "matching_agent_guideline_occurrences": 1
}
```
