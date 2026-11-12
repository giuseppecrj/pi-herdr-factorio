# Run the run ledger

The controller records one public row per finished run in `ledger/runs.jsonl`, on the orphan branch `factory/ledger`. Only the controller writes it. It uses the narrow Git Data API in `src/ledger/git.ts` through `gh`, with no clone, no new credentials, no force and no delete.

## What the branch holds

The branch starts at a parentless root whose tree holds only an empty `ledger/runs.jsonl`. It shares no history with `main`. On GitHub the root is `959b3a4`. The four commits after it carry a `Factory-Probe: ledger-branch` trailer and an empty file. They are the 2026-11-04 proxy probe, kept as ordinary history.

Each later commit appends exactly one line to a stream and names the observed tip as its only parent. A terminal-row commit carries `Factory-Run: <runId>` and `Factory-Row: <row digest>`. A score-event commit carries `Factory-Score: <eventId>` and `Factory-Event: <event digest>`. The ref moves only by `PATCH ... force:false`.

Ruleset `26531115`, "Factory ledger append-only", forbids deletion and non-fast-forward updates on `refs/heads/factory/ledger`. The controller does not depend on it. It checks lineage itself before every append.

## What a row says

A row is one canonical JSON line with `v: 1`, `v: 2`, `v: 3`, `v: 4` or `v: 5`. Its keys come in a fixed order, it ends in one LF, and its digest is SHA-256 over those exact bytes. It holds:

- the run's identity;
- the frozen workflow pin and autonomy policy;
- the terminal outcome, and the PR and merge evidence a landing requires;
- the artifact digests reached;
- usage, and a sorted `gaps` list;
- from version 2, the stop's cause and each accept attempt's final disposition.

### Version 2: the real cause

Version 2 introduced two fields after the version 1 fields and before `gaps`. Version 3 keeps them:

- `failure` is `null` unless the outcome is `failed` or `budget_exhausted`. Otherwise it is a fact whose value holds:
  - `stage`, the stage that caused the stop. It can differ from `outcome.stage`, which stays the run's projected stage. A validation dead end ends at `land` but names `validate`.
  - `class`, one of `budget`, `attempts`, `input`, `base`, `provider`, `label`, `candidate`, `oracle`, `infrastructure`, `missing_evidence`, `review` or `handoff`.
  - `reason`, a fixed controller code. A `budget` reason is the exhausted cap: `run_tokens`, `stage_tokens`, `round_tokens`, `wall` or `turns`. The four diagnosis classes carry the `src/candidate/diagnosis.ts` reason, such as `tree_replays_disagree`. `base` carries the base refusal reason, such as `base_timeout`. `input` carries the logged `why`, and `attempts` the last retry cause.
  - `failedVisibleChecks`, the failed visible check names of a validation stop, in gate order. These are only `baseline_tests`, `typecheck`, `lint`, `format`, `main_tests` or `candidate_tests`, never `heldout` or a detail.
  - `retainedPatch`, the digest of the private patch a validation stop retains, or `null`.
- `acceptAttempts` is a fact listing each round-0 accept attempt in order, as `{attempt, disposition}`. The disposition is one of:
  - `suite_qualified`, `base_refused` or `retried`, for a refusal that granted the one feedback retry;
  - `model_failed`, `model_refused`, `budget_stopped`, `interrupted` or `aborted`.

  The final base refusal of a checked suite records its attempt before the terminal snapshot, so the accept stage summary counts it as `refused`, not as zero attempts.

With a recorded cause, version 2 also fills the version 1 fields. `outcome.cap` is the cap. `outcome.cause` is the class's cause: `attempts_exhausted`, `input_refused`, `base_refused`, `provider_refused`, `label_write_failed`, `candidate_failed`, `evidence_missing`, `oracle_invalid`, `infrastructure_failed`, `review_failed` or `handoff_stopped`. The last four, and the cap `round_tokens`, exist in version 2 and later rows. A cause the controller did not record is `{"kind":"unavailable","reason":"receipt_missing"}`, never guessed. One example is a run whose stop decision a restart replayed from a bare attempt record.

The controller records a candidate stop from the durable handoff terminal and the current generation's stored assessment, so a restart keeps it. Every other stop it records when it decides it.

Version 1–4 rows and stored terminal snapshots still parse and freeze to the same bytes; no shipped row is rewritten. An older controller that does not recognize a row version blocks appends as `ledger_version_unsupported`. Roll forward rather than back after publishing a new row version.

### Version 3: execution cost facts

Version 3 introduced execution cost facts, retained in later versions. Each stage summary and the run have an `efficiency` object with these numeric fields:

- `assistantTurns`, assistant messages completed by the parent and readable children, distinct from the existing turn-budget counter;
- `modelRequests`, unique dispatched requests from the execution journal, including children, fallbacks and internal requests;
- metered `inputTokens`, `outputTokens`, `firstInputTokens`, `lastInputTokens` and `maxInputTokens` per request;
- `toolResultBytes`, UTF-8 text bytes in tool-result messages, excluding images;
- `initialPromptBytes`, initial user-prompt bytes, including bundled skills, and `initialSourceBytes`, the source pack including its labels and omission markers;
- `excerptOmissions`, the count of incomplete excerpts and entirely skipped excerpts, `sourceCapHits`, executions whose source pack hit a byte ceiling, and `guardStops`, fixed accept guard stops.

Every unavailable number is `null`, not zero. `ledgerEfficiency` exposes all-null facts for v1/v2 without altering their bytes. A missing or cut journal cannot establish complete metering. A dispatched but interrupted request counts as a request, while its missing token measurements stay null. Unknown parts propagate through sums; the charged total remains available independently. First/last stage inputs follow attempt and repair order; run first/last inputs are null without complete execution timestamps. Maxima are maxima, not sums.

`usage.tokens` and stage `tokens` remain the authoritative charged amounts, with their existing exact, lower-bound and uncertain coverage. The new metering never replaces them, converts an absent value to zero, or changes a cap. Processed tokens per assistant turn is charged tokens divided by `assistantTurns`, not input per request. Metered input per request is `inputTokens / modelRequests`; a missing value or zero denominator makes either ratio unavailable.

The controller sums each execution once, including failed attempts, retries and interrupted executions. Specify/review aggregate receipts cover their leaves; they are never added to those leaves again. Thus every terminal outcome retains the full charged token denominator needed for later cost-per-trustworthy-landing metrics. This is not the F12a cohort report.

When all source observations are available, `contextPressure.truncated` means at least one excerpt or source pack omitted content, and `promptCapHit` means a source byte ceiling was reached. Intentional evidence windows are incomplete files, even when well below the ceiling. Missing historical observations leave context pressure unavailable.

A fact the controller did not record is `{"kind":"unavailable","reason":...}`, never zero. Every reason also appears in `gaps`. Money is always unavailable, including deterministic zero-token work, because no validated price source exists.

### Version 4: admitted context, not inferred provenance

Version 4 introduced the admitted context retained in new rows. `runContext` is the admission-time `RunContextV2`, and `provenance` is its validated projection. Both ordinary and candidate terminal construction require that context.

Before the first native claim, `accounting/<runId>/policy.json` writes a version 2 start record containing `runId`, `startedAt` and `context`. The context is one of:

- `production`, with the admitted `policy` and positive `trustedCap`;
- `verification`, with that policy and trusted cap, the pinned `manifestDigest`, and `effectiveCap`, the smaller of the trusted cap and manifest cap;
- `legacy`, with `known` facts and explicit `gaps`. Unknown caps are unavailable facts, never omitted arguments or a reason to select production.

The policy freezes the workflow SHA/digest, gate-set digest from that same SHA, and canonical autonomy digest. The controller requires a complete safe export, hashes gate paths/modes/content with the base-check algorithm, and caches the result by trusted SHA. A missing source or unwritable pin defers the claim and dispatch. The verification manifest is read at this boundary, not inferred later from process options. Mixed manifest bytes, scope or production reuse are refused. Recovery reuses the original pin, not current main.

`terminalWorkflowObservation` separately records the last successfully loaded workflow SHA/digest available when the terminal snapshot was collected, or an unavailable fact if none was loaded. It is only an observation. It does not prove which policy governed any earlier attempt. Per-attempt execution-policy recording is deferred; hot-loaded safety tightening remains unchanged.

Rows project validated stage receipts and write-once attempt dispositions into stage summaries; requested and observed model identities stay separate. Aggregate receipts cover their child sessions for usage, while model observations come from the leaves and retain fallbacks and available runtime/assets versions. Provider versions stay unavailable. Each validation export also retains `gate-policy.json` for its exact base SHA when the export is complete and safe; generation rows use that pin or their bound diagnosis base receipt. Interrupted attempts consume attempts but do not add tokens a second time. Linked runs retain `previousRunId` without adding the predecessor's usage again.

Token totals are charged amounts, not necessarily measured spend. They are `lower_bound` where receipt coverage is incomplete. A request is `uncertain`, with `reason: "request_unsettled"`, when it has a dispatch but no result, a result with no metered usage, or a response that ended in an error. Per owner policy, an uncertain request is charged its recorded input-size estimate plus its enforced maximum output, and is never replayed. A non-2xx provider status at the response headers whose response then completes is journaled with `reason: "provider_rejected"` and is not uncertain: it is charged the usage the provider reported, or a known zero when it reported none. The gateway's own 502 or 504, answered before any upstream response headers arrived, is journaled with `reason: "upstream_unreachable"` and stays uncertain like any other error. Legacy dispatches without those bounds remain incomplete. A metered request body that is not a JSON object is forwarded unchanged and bounded by its byte length plus the execution's token ceiling. A later aggregate or leaf receipt does not erase uncertainty. A run whose stages directory exists but cannot be read gets unavailable stages, models and usage split, and a `lower_bound` token total with `reason: "receipt_invalid"`, never a known empty list. Available parent/child usage is counted once; the residual charge is unattributed.

At landing, the existing repository-scoped PR read retains valid `merged_at` metadata bound to repository, run, PR number, head and merge SHA. Missing or invalid merge time remains unavailable, never the observation time. Omitted checkout paths do not prove prompt truncation; v3 source observations supply context-pressure flags separately. Repair-round aggregate counts remain unavailable where authorization/start/completion coverage is not established.

Version 1 start records decode as explicit `legacy` contexts without rewriting their bytes. They retain their recorded policy and optional `runTokenCap`; a pinned state-directory manifest can identify legacy verification, but cannot supply a missing trusted or effective cap. Without recorded mode evidence the projection is `legacy_import`, never production. Missing start records also require an explicit legacy context; start and interruption histories remain unavailable, and an attempt number never proves zero interruptions.

An admitted verification context keeps `verification` provenance even before the process's first workflow load, after a failed load, or when process verification options are absent on recovery. Neither a later workflow load nor a candidate's captured cap fills historical gaps. The gap is `legacy_not_recorded` for version 1 pins, and `receipt_missing` for missing evidence. Stored terminal snapshots and frozen rows retain their exact original provenance on every retry.

One published row says `production` by mistake: `factory/ledger` line 13, commit `8785f92`, run `199df6dc85d53522b12bded884ebe6351dffcb80f7e456d42124ab39e994489f` (issue #621, PR #622, `landed`). It is an F10c verification run whose landed row was built before its controller's first workflow load, and F12a must exclude it from every production cohort. The ledger is append-only, so the row is not rewritten.

The row holds no private test names, messages, paths, prompts or session content. Its only links are constructed issue, PR and Actions URLs.

### Version 5: certified head authorship

Every new terminal snapshot and row uses version 5. It equals version 4 except that a landed `factory_verified` assurance is `{kind: "factory_verified", generationDigest, authored: "factory" | "owner"}`. The controller derives `authored` from the origin of the generation that certified the actual merged head, including historical certifications. It does not infer authorship from readiness or the active generation. An owner head that passed trusted gates and fresh review without a build is therefore certified, not an override. `owner_override` and non-landed outcomes are unchanged.

Owner validation records H as `publication.candidateSha` through a temporary controller-owned pin, so the existing landing check still binds the merged head to that generation. Versions 1–4 parse and re-freeze byte-identically, without adding an authorship field. Their absence of that field is not a claim about owner authorship.

An older controller reports the first version 5 line as `unknown_version` and blocks appends with `ledger_version_unsupported`, rather than misreading it as a corrupt version 4 row. Roll forward only. Never rewrite older rows or lower their version to resume appends.

## Score stream

F12b adds `ledger/scores.jsonl` on the same `factory/ledger` branch. The original empty root and all v1–v5 terminal row bytes stay unchanged. No v6 terminal row is needed. Each writer uses the current base tree, so a run append preserves scores and a score append preserves runs.

A score event contains `id`, `scoredRunId`, `scorerId`, `scorerDigest`, `inputDigest`, `includeChildren`, `label`, `score`, `passingScore`, bounded `reasoning`, exact `judgeModel`, `judgeFamily`, `familyNote`, `usage`, `supersedes`, `at`, `status` and `voided`. `usage` holds tokens, wall milliseconds and exactness. `status` is `scored`, `failed` or `voided`. Failed or voided events have no numeric score or declared label; `voided` is `scorer_touched` only for a void. Missing or invalid judge output is never promoted to a pass.

A re-score appends a new event pointing at the previous known event for that run and scorer. Event IDs include a private per-state-directory random nonce. `supersedes` is informational, so concurrent forks or foreign predecessors do not corrupt history. `latestScores` projects the last event in public stream order; the stream retains all events. Passing is `score >= passingScore` from that event. It is a measurement only and never changes a terminal outcome or overrides a hard-check veto.

The controller's private score outbox is `measure/score-outbox/<eventId>/event.json`. Event bytes are write-once. `published.json` records the verified public tip and line; `retry.json` stores exponential backoff and blocked status. The stream's separate `anchor.json` records its verified prefix and lineage, and per-event `adoption.json` resumes bounded lineage walks. Publication uses the existing Git Data transport, hash checks, empty-root validation, event-ID idempotency, prefix checks and shared-ref fast-forward retries. A moving run-ledger head is reread, never force-pushed. A mismatching event ID or prefix blocks publication without rewriting history. A forked supersession link is not corruption. Only the run writer may create the empty ledger root; scores require that root to exist.

Score publication runs after the judge, with pending events also pumped separately after the serve loop's status write and WATCHDOG ping. It is not awaited by the loop and cannot widen the watchdog gap. A score pump has its own 5-second transport slice, with each call capped by the remaining slice. In-process score pumps serialize per state directory. A score-side failure logs `score_pump_failed`, never `ledger_pump_failed`; the run pump retains its separate 20-second slice. Publication retry never invokes a model. Explain writes no ledger stream. Measurement allowances and native receipts stay separately accounted under `measure/`, outside ticket claims, run rows and F12a cohorts. See [Measure runs](improvement.md) for trusted configuration, commands, privacy and limits.

## Private state

The outbox lives under `<state>/ledger/` with mode 0600 in 0700 directories, outside every stage mount. Back it up with `<state>/accounting/`, stage receipts and claims. `accounting/<runId>/attempts/<stage>-r<round>-<attempt>.json` records each disposition and recovery action once. Execution `usage.json` retains token high-water, turns, numeric efficiency progress and the original deadline; `egress.requests.jsonl` syncs dispatch bounds before upstream and results after completion.

| Path | Written | Meaning |
| --- | --- | --- |
| `<runId>/terminal.json` | once, before the terminal marker | The terminal snapshot, including the fixed `terminalObservedAt`. |
| `<runId>/row.json` | once, after the marker is confirmed | The exact public row bytes. |
| `<runId>/retry.json` | replaced | Attempts, next try time, last fixed error, and whether the job is blocked. |
| `<runId>/blocked.json` | once, instead of `terminal.json` | The terminal snapshot could not be encoded; the job is blocked as `row_invalid`. |
| `<runId>/published.json` | once | The row digest, the tip where it was read back, the blob and the line number. |
| `anchor.json` | replaced | The last verified root, tip, blob, byte length and prefix digest. |
| `<runId>/adoption.json` | replaced | Tip/base-bound lineage cursor and total walk count for resumable adoption. |

If `terminal.json` cannot be written or its snapshot cannot be encoded, the run stays ending and posts no terminal marker until it can. A failed `row.json` freeze is retried on later ticks. A corrupt or unreadable record in one run's directory blocks only that job as `state_invalid`; a directory with no `terminal.json` or `blocked.json` is not enrolled yet and is skipped. A row is never rebuilt with different bytes. A write-once mismatch blocks the job.

## How a row reaches the branch

`tick --once`, `run` and every `serve` tick pump the outbox after the tick. The pump calls no model and launches no stage. For each due job it:

1. Reads the ref, the commit and the ledger blob at exact SHAs. It checks every hash.
2. Verifies lineage. With no anchor it walks a linear history to the empty parentless root. With an anchor it walks back to the anchored tip and checks the byte prefix. A persisted cursor bounds each pass to 16 parent links without resetting the total walk limit.
3. Parses every line. It refuses to write past any corrupt line, newer-version line or repeated run ID.
4. Records success without writing when the run ID is already there with the same digest. A different row for the same run is `row_conflict`.
5. Otherwise appends the frozen bytes, PATCHes with `force:false`, and reads the row back. A non-fast-forward or a lost response leads to a reread, and at most three rebases.

Each job has a 20-second slice; each `gh` call is capped at the smaller of 5 seconds and the remaining slice. Budgeted calls do not retry inline. Retry time and exponential backoff are persisted from completion time.

## Status and errors

`status --json --state-dir <dir>` reads backlog counts, oldest age, next attempt and integrity state without pumping or launching models. Unknown counts are null. It also exposes durable per-run accounting, including ended claims, with process counters clearly labeled. See [factory-cli.md](factory-cli.md#ledger-backlog-and-accounting).

Each pump that has work logs `ledger_backlog`, with the published, pending and blocked counts, the oldest pending terminal time and the last error. A pending row is not an active run. It never holds a slot or blocks the next run.

| Error | Kind | Meaning |
| --- | --- | --- |
| `transport_unavailable` | retried | GitHub could not be reached or the slice expired. Retries back off from 5 seconds to 5 minutes and never stop. |
| `adoption_pending` | retried | Another bounded ancestry slice is needed; the saved cursor resumes it. |
| `state_unwritable` | retried | A private record could not be written. |
| `ledger_contended` | retried | The branch kept moving through three rebases. |
| `ref_missing` | blocked | The ref is absent after an anchor or a published receipt exists. The controller creates the root only when neither exists, and never recreates it. |
| `state_invalid` | blocked | A private outbox record, including `anchor.json`, is unreadable or corrupt. A corrupt anchor blocks every job and never creates a root. |
| `row_invalid` | blocked | The terminal snapshot could not be encoded, so no terminal marker was posted. |
| `lineage_changed` | blocked | History was rewritten, branched or rooted in a source tree. |
| `ledger_corrupt`, `ledger_version_unsupported` | blocked | A line the writer cannot index, such as a version 2 line read by an older controller. It is preserved, never repaired. |
| `row_conflict` | blocked | The run ID is present with different bytes, or twice. |
| `object_mismatch` | blocked | A hash or object read did not match. |

A blocked job needs the owner. Fix the cause outside the controller, then delete that run's `retry.json` to retry it at once. Never edit `row.json` or the branch to make a row fit.

## Outcome metrics

Use the read-only [`metrics --json` command](factory-cli.md#ticket-outcome-metrics)
to report cohort outcomes and charged token totals. [Factory ticket metrics](metrics.md)
defines the seven-day window, exclusions and unknowns. Versions 1–5 do not
record complete owner-feedback history. The metric instead reads the landed
PR's submitted reviews and timeline online: a non-factory-bot
`CHANGES_REQUESTED` review before merge counts as intervention, deliberately
without a permission check. A dismissed change request originally submitted
before merge by a non-bot reviewer still counts; dismissed approvals and
comments do not. Offline, failed or incomplete reads give
`unknown: intervention_unreadable`. All GitHub reads share a 120-second report
deadline; unfinished and remaining intervention reads become unknown.
Owner-authored heads and owner overrides still establish intervention from
the ledger.
The owner must create `factory:defect` before no-defect evidence is available.
The report neither edits the ledger nor dispatches work.

## Not yet built

Retrospective backfill of runs that ended before this build is not implemented. Historical context pressure and complete repair-round aggregates remain unavailable where they were not recorded, rather than inferred. Complete intervention history on the ledger and money pricing remain unimplemented.
