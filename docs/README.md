# docs

Each path below is authoritative, current, or historical. Read current documents as guidance. Read historical documents as evidence of what happened, never as instructions.

| Path | Status | What it holds |
| --- | --- | --- |
| `decisions.tsv` | Authoritative | Every decision, grant and verdict, oldest first. Append only. The coordinator adds rows with the pstack `show-me-your-work` skill's `log.sh`. `npm run check:decisions` checks the format and that the committed prefix is unchanged. |
| `plans/factory-v1.md` | Current | The factory program, PRs F04a to F13. |
| `plans/codebase-layout.md` | Current | The layout program, PRs L00 to L15. |
| `plans/exmach-move.md`, `plans/factorio-vm.md` | Later | Host moves that wait on other work. |
| `operations/` | Current | Runbooks and contracts for each part of the factory. Tests and `.github/factory/WORKFLOW.md` read some of these files by path. |
| `design.md` | Current | The architecture and the owner decisions behind it. Root `DESIGN.md` is the viewer's visual design. |
| `statecharts/` | Current | Bounded TLA+ models of the factory and the TypeScript that replays them against runtime tests. |
| `history/path-map.md` | Current | Old path to new path for every file the layout program moves, bound to a revision. |
| `handoff.md` | Historical | The original 2026-10-28 handoff. `AGENTS.md` replaces it. |
| `prototypes/` | Historical | Early experiment evidence. Some directories still hold probes that `.pi/skills/verify-factory` recipes run until L02 moves them. |

## Citations

`npm run check:layout` checks citations in every current Markdown file. A citation written `path:line` or `` `path` line N `` must name an existing file and a line within it at HEAD. To cite an older revision, write `<sha>:path:line`. The check validates its form only. `docs/operations/sandbox.md` states that its repository paths refer to `f88069f`, so the check validates its citations' form only.

## Add a document

- A runbook goes in `operations/`.
- A plan for the current program goes in `plans/`. A plan that waits on other work is marked later.
- Experiment evidence goes in a dated directory under `prototypes/` with a README that names its verdict.
- When a document becomes historical, add a banner on its first line rather than rewriting it.
