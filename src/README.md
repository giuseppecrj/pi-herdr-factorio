# src

`src/` holds the factory's rules: what a run is, which stages may run, what a contract, ledger row, verdict or marker may contain, and what the controller does next. `extension/index.ts` imports it, and the published package ships it.

Host work stays in `server/`. That means processes, sandboxes, the gateway, gates, the viewer and installation. Code in `src/` never imports `server/` or `host/`, not even for a type. `npm run check:layout` fails any such import, and the baseline has no allowance for one. When a view needs host evidence, such as the controller lock, a stage receipt or an installed bundle, a host collector under `server/cli/` reads it and passes the data or a reader in. `server/cli/owner-feed.ts` does this for `src/views/feed.ts` and `server/cli/measurement.ts` for `src/views/explain.ts`.

## `src/core`

`src/core/` holds the facts every other part of the factory shares, with no host code. `run.ts` defines runs, outcomes, verdicts and digests. `json.ts` parses JSON at I/O boundaries. `models.ts` holds the Anthropic limits table and model-family evidence. `journal.ts` reads a gateway request journal back into settlements and charges. `execution.ts` holds stage outcomes, usage and efficiency facts. `stages.ts` owns stage names, order and the run, model, sandbox and execution subsets. Transition policy stays in `src/candidate/stages.ts`. A core file never imports `server/` or `host/`. The gateway's audit writer and the host's stage receipt stay in `server/sandbox/`.

## `src/trust`

`protected-paths.ts` owns the control-plane, acceptance-suite and feedback-file names. Callers keep their own normalization, case handling and authority. A read filter, a replacement-test check and a patch-write check do not grant the same access.

Two matchers keep their own spelling on purpose. They match the gate container's absolute paths under `/w/test/acceptance/`, which no repository-relative constant describes. They are the held-out file check in `server/gates.ts` and the draft reporter in `server/gates/draft-reporter.mjs`.

`policy.ts` decides which patch paths a candidate may write. `platform.ts` resolves the platform profile and its repository allowlist. `admission.ts` decides whether an issue may start a run. `markers.ts` reads and writes the trusted run markers on issues.

## Other folders

`src/github/` talks to GitHub: `adapter.ts` is the tracker adapter, `tickets.ts` holds the tracker-neutral ticket types, and `exec.ts` holds the shared `Exec` process-runner type that replay and sandbox preflight also use for `git`. `src/config/` reads `WORKFLOW.md`. `schema.ts` holds the workflow types and limits, `parse.ts` parses the front matter into them, `load.ts` fetches and reloads the file from a pinned revision, and `views.ts` derives the per-stage settings other code reads. `src/contract/` holds what a run promises. `contract.ts` holds the contract types, `parse.ts` parses specify output into a contract (a different job from the config parser), `render.ts` renders contracts and summaries, `prompt.ts` builds the specify and review prompts, `acceptance.ts` holds the acceptance suite and its binding, and `artifacts.ts` stores them. `src/candidate/` judges a candidate: build, review, validation, feedback, diagnosis and stage transitions. Its stored book has three homes. `state.ts` holds the book's types, limits, identity, freezing and receipt binding. `codec.ts` decodes the stored wire format and migrates older versions. `handoff.ts` holds the policy: transitions, accounting and certification. A new persisted field usually touches `state.ts` and `codec.ts` together. A new wire version goes in `codec.ts`. A new policy rule goes in `handoff.ts`. `src/views/` turns stored state into the owner feed, attention list, explanations and metrics. `src/maintenance/` holds scheduled and replay work: cadence audits, replay and scorers.

## Review seats

`reviewSeats` in `src/candidate/review.ts` names the files that get the `ultrareview` seat. It covers all of `src/core/` and all of `src/config/`, and in `src/trust/` only `protected-paths.ts`, `policy.ts` and `admission.ts`. In `src/github/` it covers `adapter.ts` and `exec.ts`, not the whole folder. Apart from `src/core/run.ts`, which gained the seat in L03, these are the seats the files had before the layout program. Widening them costs review budget and needs the owner.

## `src/ledger`

`schema.ts` owns the stored ledger formats: run rows versions 1 to 5, score events, run starts and attempt ends, with their codecs and parsers. Stored lines never change, so a codec change must still read every old line to the same bytes. `git.ts` keeps the runs and scores files on `factory/ledger` through the Git Data API, without force. `append.ts` appends one frozen row or proves it is already there. `terminal.ts` turns a finished run into its row. `outbox.ts` holds the controller's private publication queue and its bounded pump. Candidate branches and owner patches belong to `src/github/publish.ts`.

## `src/controller`

`orchestrator.ts` is the one scheduling authority. `Orchestrator` is the single owner of every mutable field: the run table, the seen and corrupt caches, the totals, claim observations, reservations, draining stages and queued candidate results. No other module keeps them. Three paths change them. `tick` does the scheduling (`cadenceOnce` runs its claim loading and workflow gate for a one-shot audit). `drain` repeats a tick's stage-end steps until no stage runs: late usage, stage ends, base-check polls, accept launches and marker sync. Callbacks a launch hands to the executor run between ticks: a stage's `progress` raises its phase's `usage` and `lastProgressAt`, its settlement sets the phase's `result`, a candidate execution's progress and settlement append to the queued candidate results and its settlement marks the execution settled, and each settlement removes its promise from the running stages. The next tick or drain acts on what the callbacks wrote; a callback never dispatches or posts. Tick order, slot arbitration, adoption, dispatch, stage ends, retries and marker publication stay there. The other files hold what can run without the `Orchestrator` object. Their functions take the controller input and the run record as parameters, and any mutable state they touch is passed in by name.

- `claims.ts` holds a claimed run (`ActiveRun`, `RunPhase`), its stored `ClaimRecord`, the `RunFiles` port that stores it, claim observations, and the projections between a run, its record and its marker.
- `admission.ts` holds the seen-issue watermark, the refusal policy and clarification linking: answer history and the answers record of a relabeled run.
- `launch.ts` holds the `StageExecutor` port, what a launch gets and returns, workspace preparation and stage input reads.
- `effects.ts` holds the effects a reporting stage owes and the keyed comment writes, and turns specify and accept output into them.
- `accounting.ts` holds the totals and charges: late usage, adopted and released spend, attempt ends and accept spend.
- `base-check.ts` holds the acceptance receipt, the accept retry's refused suite and feedback, and the refusal notice.
- `recovery.ts` turns unsettled candidate execution accounts back into candidate events after a restart.

A new method that reads or writes `Orchestrator` fields belongs in `orchestrator.ts`. Move it out only when it needs at most four of them, passed explicitly, and calls no `Orchestrator` method.

## Files by planned owner

L06 moved the intact modules into their owner folders. Files marked pending stay at their root paths until the named PR moves and splits them. Do not create a pending owner folder before that PR.

| Owner | Files in that folder | Pending move and split |
| --- | --- | --- |
| `src/trust` | `protected-paths.ts`, `policy.ts`, `platform.ts`, `admission.ts`, `markers.ts` | None |
| `src/config` | `schema.ts`, `parse.ts`, `load.ts`, `views.ts` | None |
| `src/github` | `adapter.ts`, `exec.ts`, `tickets.ts`, `publish.ts` | None |
| `src/contract` | `contract.ts`, `parse.ts`, `render.ts`, `prompt.ts`, `acceptance.ts`, `artifacts.ts` | None |
| `src/candidate` | `state.ts`, `codec.ts`, `handoff.ts`, `build.ts`, `review.ts`, `validation.ts`, `feedback.ts`, `diagnosis.ts`, `stages.ts` | None |
| `src/ledger` | `schema.ts`, `git.ts`, `append.ts`, `terminal.ts`, `outbox.ts` | None |
| `src/controller` | `orchestrator.ts`, `claims.ts`, `admission.ts`, `launch.ts`, `effects.ts`, `accounting.ts`, `base-check.ts`, `recovery.ts` | None |
| `src/views` | `feed.ts`, `attention.ts`, `explain.ts`, `metrics.ts` | None |
| `src/maintenance` | `cadence.ts`, `replay.ts`, `scorers.ts` | None |

The `owner` field of each entry in `scripts/layout-baseline.json` records the same mapping.

## Add a file

1. Put it beside the code that owns its responsibility. Import owner modules directly. Do not add an index file that re-exports other modules.
2. Add an entry under `classification.files` in `scripts/layout-baseline.json` with its `owner`, the review `seats` that `reviewSeats` in `src/candidate/review.ts` gives it, `from` (the files it was extracted from, or `[]`) and `since` (the PR that classified it).
3. Add its tests as `test/<name>.test.ts`. See `test/README.md`.

A file extracted from others must keep every review seat its sources required. If `reviewSeats` gives it fewer, widen the review rule in `src/candidate/review.ts` in the same PR.
