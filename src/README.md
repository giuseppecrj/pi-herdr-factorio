# src

`src/` holds the factory's rules: what a run is, which stages may run, what a contract, ledger row, verdict or marker may contain, and what the controller does next. `extension/index.ts` imports it, and the published package ships it.

Host work stays in `server/`. That means processes, sandboxes, the gateway, gates, the viewer and installation. New code in `src/` must not import `server/`. `npm run check:layout` fails a new `src` to `server` import. The 5 existing ones are listed in `scripts/layout-baseline.json` under `imports.reverseEdges`, and that list may only shrink.

## `src/core`

`src/core/` holds the facts every other part of the factory shares, with no host code. `run.ts` defines runs, outcomes, verdicts and digests. `json.ts` parses JSON at I/O boundaries. `models.ts` holds the Anthropic limits table and model-family evidence. `journal.ts` reads a gateway request journal back into settlements and charges. `execution.ts` holds stage outcomes, usage and efficiency facts. `stages.ts` owns stage names, order and the run, model, sandbox and execution subsets. Transition policy stays in `src/stages.ts`. A core file never imports `server/` or `host/`. The gateway's audit writer and the host's stage receipt stay in `server/sandbox/`.

## `src/trust`

`protected-paths.ts` owns the control-plane, acceptance-suite and feedback-file names. Callers keep their own normalization, case handling and authority. A read filter, a replacement-test check and a patch-write check do not grant the same access.

## Files by planned owner

`docs/plans/codebase-layout.md` moves these files into the owner folders below. Until a file moves, it stays at the path shown. Do not create a planned owner folder before the PR that moves files into it.

| Planned owner | Files |
| --- | --- |
| `src/trust` | `policy.ts`, `platform.ts`, `admission.ts`, `markers.ts` |
| `src/config` | `workflow.ts` |
| `src/github` | `adapters/github.ts`, `gh.ts`, `tickets.ts`, `publication.ts` |
| `src/contract` | `specify.ts`, `accept.ts`, `artifacts.ts` |
| `src/candidate` | `handoff.ts`, `build.ts`, `review.ts`, `validation.ts`, `feedback.ts`, `diagnosis.ts`, `stages.ts` |
| `src/ledger` | `ledger.ts` |
| `src/controller` | `orchestrator.ts` |
| `src/views` | `feed.ts`, `attention.ts`, `explain.ts`, `metrics.ts` |
| `src/maintenance` | `cadence.ts`, `replay.ts`, `scorers.ts` |

The `owner` field of each entry in `scripts/layout-baseline.json` records the same mapping.

## Add a file

1. Put it beside the code that owns its responsibility. Import owner modules directly. Do not add an index file that re-exports other modules.
2. Add an entry under `classification.files` in `scripts/layout-baseline.json` with its `owner`, the review `seats` that `reviewSeats` in `review.ts` gives it, `from` (the files it was extracted from, or `[]`) and `since` (the PR that classified it).
3. Add its tests as `test/<name>.test.ts`. See `test/README.md`.

A file extracted from others must keep every review seat its sources required. If `reviewSeats` gives it fewer, widen the review rule in `review.ts` in the same PR.
