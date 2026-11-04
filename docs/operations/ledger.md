# Run the run ledger

The controller records one public row per finished run in `ledger/runs.jsonl`, on the orphan branch `factory/ledger`. Only the controller writes it. It uses the narrow Git Data API in `src/publication.ts` through `gh`, with no clone, no new credentials, no force and no delete.

## What the branch holds

The branch starts at a parentless root whose tree holds only an empty `ledger/runs.jsonl`. It shares no history with `main`. On GitHub the root is `959b3a4`. The four commits after it carry a `Factory-Probe: ledger-branch` trailer and an empty file. They are the 2026-11-04 proxy probe, kept as ordinary history.

Each later commit appends exactly one line and names the observed tip as its only parent. Its message carries `Factory-Run: <runId>` and `Factory-Row: <row digest>`. The ref moves only by `PATCH ... force:false`.

Ruleset `26531115`, "Factory ledger append-only", forbids deletion and non-fast-forward updates on `refs/heads/factory/ledger`. The controller does not depend on it. It checks lineage itself before every append.

## What a row says

A row is one canonical JSON line with `v: 1`. Its keys come in a fixed order, it ends in one LF, and its digest is SHA-256 over those exact bytes. It holds:

- the run's identity;
- the frozen workflow pin and autonomy policy;
- the terminal outcome, and the PR and merge evidence a landing requires;
- the artifact digests reached;
- usage, and a sorted `gaps` list.

A fact the controller did not record is `{"kind":"unavailable","reason":...}`, never zero. Every reason also appears in `gaps`. Money is always unavailable, including deterministic zero-token work, because no validated price source exists.

Before the first native claim, `accounting/<runId>/policy.json` freezes the start time, workflow SHA/digest, gate-set digest from that same SHA, and canonical autonomy digest. The controller requires a complete safe export, hashes gate paths/modes/content with the base-check algorithm, and caches the result by trusted SHA. A missing source or unwritable pin defers the claim and dispatch. Recovery reuses the original pin, not current main.

Rows project validated stage receipts and write-once attempt dispositions into stage summaries; requested and observed model identities stay separate. Aggregate receipts cover their child sessions for usage, while model observations come from the leaves and retain fallbacks and available runtime/assets versions. Provider versions stay unavailable. Each validation export also retains `gate-policy.json` for its exact base SHA when the export is complete and safe; generation rows use that pin or their bound diagnosis base receipt. Interrupted attempts consume attempts but do not add tokens a second time. Linked runs retain `previousRunId` without adding the predecessor's usage again.

Token totals are charged amounts, not necessarily measured spend. They are `lower_bound` where receipt coverage is incomplete, and `uncertain` with `reason: "request_unsettled"` if a request has a dispatch but no result, or a result with no metered usage. Per owner policy, such requests charge the recorded input-size estimate plus their enforced maximum output and are never replayed. Legacy dispatches without those bounds remain incomplete. A metered request body that is not a JSON object is forwarded unchanged and bounded by its byte length plus the execution's token ceiling. A later aggregate or leaf receipt does not erase uncertainty. A run whose stages directory exists but cannot be read gets unavailable stages, models and usage split, and a `lower_bound` token total with `reason: "receipt_invalid"`, never a known empty list. Available parent/child usage is counted once; the residual charge is unattributed.

At landing, the existing repository-scoped PR read retains valid `merged_at` metadata bound to repository, run, PR number, head and merge SHA. Missing or invalid merge time remains unavailable, never the observation time. Context-pressure flags are not instrumented; omitted checkout paths do not prove prompt truncation. Repair-round aggregate counts remain unavailable where authorization/start/completion coverage is not established.

Runs lacking an admission-time accounting pin are distinguishable as `legacy_import` (verification state remains explicitly verification). Their unrecorded start and interruption histories remain unavailable; an attempt number never proves zero interruptions.

The row holds no private test names, messages, paths, prompts or session content. Its only links are constructed issue, PR and Actions URLs.

## Private state

The outbox lives under `<state>/ledger/` with mode 0600 in 0700 directories, outside every stage mount. Back it up with `<state>/accounting/`, stage receipts and claims. `accounting/<runId>/attempts/<stage>-r<round>-<attempt>.json` records each disposition and recovery action once. Execution `usage.json` retains token high-water, turns and the original deadline; `egress.requests.jsonl` syncs dispatch bounds before upstream and results after completion.

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
| `ledger_corrupt`, `ledger_version_unsupported` | blocked | A line the writer cannot index. It is preserved, never repaired. |
| `row_conflict` | blocked | The run ID is present with different bytes, or twice. |
| `object_mismatch` | blocked | A hash or object read did not match. |

A blocked job needs the owner. Fix the cause outside the controller, then delete that run's `retry.json` to retry it at once. Never edit `row.json` or the branch to make a row fit.

## Not yet built

Retrospective backfill of runs that ended before this build is not implemented. Context-pressure flags and complete repair-round aggregates are not yet recorded. Those facts remain unavailable rather than inferred. F12a cohort metrics and money pricing are not part of this build.
