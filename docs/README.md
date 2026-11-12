# docs

Each path below is authoritative, current, later, background or historical. Read current documents as guidance. A later document plans work that waits on something else or records a closed program's evidence. Read background and historical documents as evidence of why and what happened, never as instructions. For what is built, read `plans/active/factory-v1.md` and `git log`.

| Path | Status | What it holds |
| --- | --- | --- |
| `decisions.tsv` | Authoritative | Every decision, grant and verdict, oldest first. Append only. The coordinator adds rows with the pstack `show-me-your-work` skill's `log.sh`. `npm run check:decisions` checks the format and that the committed prefix is unchanged. |
| `plans/active/` | Current | Plans for programs in progress. `factory-v1.md` is the factory program, PRs F04a to F13. |
| `plans/later/` | Later | Plans that wait on other work, and closed programs kept for their evidence. `exmach-move.md` and `factorio-vm.md` are host moves. `codebase-layout.md` is the layout program, PRs L00 to L15, with its completed-PR evidence and the owner's post-program checklist. |
| `operations/` | Current | Runbooks and contracts for each part of the factory. Tests and `.github/factory/WORKFLOW.md` read some of these files by path. |
| `architecture.md` | Background | The v1 architecture and the owner decisions behind it. Parts are pending or superseded, so it is not current guidance. Root `DESIGN.md` is the viewer's visual design. |
| `models/` | Current | Bounded TLA+ models of the factory and the TypeScript that replays them against runtime tests. |
| `history/path-map.md` | Current | Old path to new path for every file the layout program moves, bound to a revision. |
| `history/handoff.md` | Historical | The original 2026-10-28 handoff. `AGENTS.md` replaces it. |
| `history/prototypes/` | Historical | Early experiment evidence. The probes that current recipes run moved to `.pi/skills/verify-factory/probes/` in L02. |

## Citations

`npm run check:layout` checks citations in every current Markdown file. A citation written `path:line` or `` `path` line N `` must name an existing file and a line within it at HEAD. To cite an older revision, write `<sha>:path:line`. The check validates its form only. `docs/operations/sandbox.md` states that its repository paths refer to `f88069f`, so the check validates its citations' form only.

## Add a document

- A runbook goes in `operations/`.
- A plan for a program in progress goes in `plans/active/`. A plan that waits on other work goes in `plans/later/`.
- Experiment evidence goes in a dated directory under `history/prototypes/` with a README that names its verdict.
- When a document becomes historical, move it under `history/`, add a banner on its first line rather than rewriting it, and add a row to `history/path-map.md`.
