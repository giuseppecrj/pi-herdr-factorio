# Path map

Every file that the layout program in `docs/plans/codebase-layout.md` moves, renames or splits gets one row here, in the PR that moves it. Use this map to read a historical document, decision row or acceptance suite that names an old path.

Each row is bound to the revision that made the move. The old path is valid at the parent of that revision, and the new path is valid at the revision itself. Write a line citation to an old path as `<sha>:path:line`, so the citation check validates its form instead of looking for the file at HEAD.

| PR | Revision | Old path | New path | Symbols that moved |
| --- | --- | --- | --- | --- |
| L02 | 102e993 | `docs/prototypes/acceptance-isolation/probe.ts` | `.pi/skills/verify-factory/probes/acceptance-isolation/probe.ts` | The whole file |
| L02 | 102e993 | `docs/prototypes/acceptance-isolation/self-test.mjs` | `.pi/skills/verify-factory/probes/acceptance-isolation/self-test.mjs` | The whole file |
| L02 | 102e993 | `docs/prototypes/build-isolation/probe.ts` | `.pi/skills/verify-factory/probes/build-isolation/probe.ts` | The whole file |
| L02 | 102e993 | `docs/prototypes/build-isolation/self-test.mjs` | `.pi/skills/verify-factory/probes/build-isolation/self-test.mjs` | The whole file |
| L02 | 102e993 | `docs/prototypes/heldout-ci/repair-probe.ts` | `.pi/skills/verify-factory/probes/heldout-ci/repair-probe.ts` | The whole file |
| L02 | fb25df3 | `.pi/skills/verify-factory/scripts/drive-replay.sh` | `.pi/skills/verify-factory/scripts/drive-replay.ts` | Not a rename: `drive-replay.sh` stays the driver, and its eleven inline node programs became `drive-replay.ts` subcommands `owned`, `visible-limit`, `production-free`, `settle`, `recovery-command`, `restore-fields`, `fixture-disarmed`, `fixture-ready`, `journal`, `preflight` and `prepare` |

L00 moves no files. L02 rows name commits on the `layout-l02-probes` branch. When L02 lands, its squash commit is the revision that makes these moves.
