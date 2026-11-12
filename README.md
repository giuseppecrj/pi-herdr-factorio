# pi-herdr-factorio

A ticket-triggered software factory for [Pi](https://github.com/earendil-works/pi), built on [pi-herdr-pstack](https://github.com/giuseppecrj/pi-herdr-pstack).

Status: in development. The controller runs on one exe.dev VM and has opened PRs the owner merged, the first being #562. Production dispatch is held between verification batches, and no production tickets run until the F10c pilots.

A maintainer labels a GitHub issue, and the factory takes it from intake through clarification, research, build, review, merge and follow-up, then files its own improvement tickets on a schedule. Linear support follows GitHub.

## Where things live

Each folder has a `README.md` that says what belongs in it and where new files go.

| Folder | What it holds |
| --- | --- |
| `src/` | The factory's rules: runs, stages, contracts, the ledger and the controller's decisions. |
| `host/` | Host execution: the CLI, controller loop, sandboxes, gateway, gates, viewer and installer. |
| `extension/` | The Pi extension that adds `/factory`. |
| `skills/` | Stage skills that ship in the sandbox bundle. |
| `test/` | Tests, fixtures and published held-out suites. |
| `docs/` | Decisions, plans, runbooks, models and historical evidence. |
| `scripts/` | Repository tools, including the layout and decisions guards. |
| `tools/` | The vendored lint plugin. |
| `.pi/` | Coordinator skills for Pi sessions in this checkout. |
| `.github/` | CI workflows and the trusted factory gate configuration. |
| `research/` | The original design research. Historical. |

`npm run check` runs typecheck, lint, format, both guards and every test.

## Records

`docs/plans/factory-v1.md` tracks what is built and what remains, and `docs/decisions.tsv` records every decision and verdict. `docs/operations/` documents how to run each part. `research/SYNTHESIS.md` is the original design research. `research/reports/` holds the evidence behind it. Upstream skill captures stay local; `research/PROVENANCE.md` records their URLs, pinned SHAs and licenses, because several upstreams carry no license.
