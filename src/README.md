# src

`src/` holds the factory's rules: what a run is, which stages may run, what a contract, ledger row, verdict or marker may contain, and what the controller does next. `extension/index.ts` imports it, and the published package ships it.

Host work stays in `server/`. That means processes, sandboxes, the gateway, gates, the viewer and installation. Code in `src/` never imports `server/` or `host/`, not even for a type. `npm run check:layout` fails any such import, and the baseline has no allowance for one. When a view needs host evidence, such as the controller lock, a stage receipt or an installed bundle, a host collector under `server/cli/` reads it and passes the data or a reader in. `server/cli/owner-feed.ts` does this for `src/views/feed.ts` and `server/cli/measurement.ts` for `src/views/explain.ts`.

## `src/core`

`src/core/` holds the facts every other part of the factory shares, with no host code. `run.ts` defines runs, outcomes, verdicts and digests. `json.ts` parses JSON at I/O boundaries. `models.ts` holds the Anthropic limits table and model-family evidence. `journal.ts` reads a gateway request journal back into settlements and charges. `execution.ts` holds stage outcomes, usage and efficiency facts. `stages.ts` owns stage names, order and the run, model, sandbox and execution subsets. Transition policy stays in `src/candidate/stages.ts`. A core file never imports `server/` or `host/`. The gateway's audit writer and the host's stage receipt stay in `server/sandbox/`.

## `src/trust`

`protected-paths.ts` owns the control-plane, acceptance-suite and feedback-file names. Callers keep their own normalization, case handling and authority. A read filter, a replacement-test check and a patch-write check do not grant the same access.

Two matchers keep their own spelling on purpose. They match the gate container's absolute paths under `/w/test/acceptance/`, which no repository-relative constant describes. They are the held-out file check in `server/gates.ts` and the draft reporter in `server/gates/draft-reporter.mjs`. Every file under `src/trust/` gets the `ultrareview` seat.

## Files by planned owner

L06 moved the intact modules into their owner folders. Files marked pending stay at their root paths until the named PR moves and splits them. Do not create a pending owner folder before that PR.

| Owner | Files in that folder | Pending move and split |
| --- | --- | --- |
| `src/trust` | `protected-paths.ts`, `policy.ts`, `platform.ts`, `admission.ts`, `markers.ts` | None |
| `src/config` | Not created | `src/workflow.ts` in L08 |
| `src/github` | `adapter.ts`, `exec.ts`, `tickets.ts` | `src/publication.ts` in L09 |
| `src/contract` | `acceptance.ts`, `artifacts.ts` | `src/specify.ts` in L08 |
| `src/candidate` | `build.ts`, `review.ts`, `validation.ts`, `feedback.ts`, `diagnosis.ts`, `stages.ts` | `src/handoff.ts` in L07 |
| `src/ledger` | Not created | `src/ledger.ts` in L09 |
| `src/controller` | Not created | `src/orchestrator.ts` in L10 |
| `src/views` | `feed.ts`, `attention.ts`, `explain.ts`, `metrics.ts` | None |
| `src/maintenance` | `cadence.ts`, `replay.ts`, `scorers.ts` | None |

The `owner` field of each entry in `scripts/layout-baseline.json` records the same mapping.

## Add a file

1. Put it beside the code that owns its responsibility. Import owner modules directly. Do not add an index file that re-exports other modules.
2. Add an entry under `classification.files` in `scripts/layout-baseline.json` with its `owner`, the review `seats` that `reviewSeats` in `src/candidate/review.ts` gives it, `from` (the files it was extracted from, or `[]`) and `since` (the PR that classified it).
3. Add its tests as `test/<name>.test.ts`. See `test/README.md`.

A file extracted from others must keep every review seat its sources required. If `reviewSeats` gives it fewer, widen the review rule in `src/candidate/review.ts` in the same PR.
