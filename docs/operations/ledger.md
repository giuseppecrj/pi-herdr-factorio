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

A fact the controller did not record is `{"kind":"unavailable","reason":...}`, never zero. Every reason also appears in `gaps`. Money is always unavailable, because no provider reports a price. Tokens are a `lower_bound` until per-request accounting lands.

These facts are still `not_instrumented`:

- the gate digest;
- stage and model summaries;
- attempt dispositions, including interrupted attempts;
- usage attribution, previous run, start time and context pressure.

The row holds no private test names, messages, paths, prompts or session content. Its only links are constructed issue, PR and Actions URLs.

## Private state

Everything lives under `<state>/ledger/` with mode 0600 in 0700 directories, outside every stage mount. Back these up with the claims.

| Path | Written | Meaning |
| --- | --- | --- |
| `<runId>/terminal.json` | once, before the terminal marker | The terminal snapshot, including the fixed `terminalObservedAt`. |
| `<runId>/row.json` | once, after the marker is confirmed | The exact public row bytes. |
| `<runId>/retry.json` | replaced | Attempts, next try time, last fixed error, and whether the job is blocked. |
| `<runId>/published.json` | once | The row digest, the tip where it was read back, the blob and the line number. |
| `anchor.json` | replaced | The last verified root, tip, blob, byte length and prefix digest. |

If `terminal.json` cannot be written, the run stays ending and posts no terminal marker until it can. A row is never rebuilt with different bytes. A write-once mismatch blocks the job.

## How a row reaches the branch

`tick --once`, `run` and every `serve` tick pump the outbox after the tick. The pump calls no model and launches no stage. For each due job it:

1. Reads the ref, the commit and the ledger blob at exact SHAs. It checks every hash.
2. Verifies lineage. With no anchor it walks a linear history to the empty parentless root. With an anchor it walks back to the anchored tip and checks the byte prefix.
3. Parses every line. It refuses to write past any corrupt line, newer-version line or repeated run ID.
4. Records success without writing when the run ID is already there with the same digest. A different row for the same run is `row_conflict`.
5. Otherwise appends the frozen bytes, PATCHes with `force:false`, and reads the row back. A non-fast-forward or a lost response leads to a reread, and at most three rebases.

## Status and errors

Each pump that has work logs `ledger_backlog`, with the published, pending and blocked counts, the oldest pending terminal time and the last error. A pending row is not an active run. It never holds a slot or blocks the next run.

| Error | Kind | Meaning |
| --- | --- | --- |
| `transport_unavailable` | retried | GitHub could not be reached. Retries back off from 5 seconds to 5 minutes and never stop. |
| `state_unwritable` | retried | A private record could not be written. |
| `ledger_contended` | retried | The branch kept moving through three rebases. |
| `ref_missing` | blocked | The ref vanished after an anchor was verified. The controller never recreates it. |
| `lineage_changed` | blocked | History was rewritten, branched or rooted in a source tree. |
| `ledger_corrupt`, `ledger_version_unsupported` | blocked | A line the writer cannot index. It is preserved, never repaired. |
| `row_conflict` | blocked | The run ID is present with different bytes, or twice. |
| `object_mismatch` | blocked | A hash or object read did not match. |

A blocked job needs the owner. Fix the cause outside the controller, then delete that run's `retry.json` to retry it at once. Never edit `row.json` or the branch to make a row fit.

## Not yet built

These parts of the F09b design are not in this build:

- the per-request dispatch and result journal;
- execution charge settlement and interrupted-attempt dispositions;
- `--verification-token-cap`;
- the admission policy pin with the gate digest;
- the `status --json` backlog fields;
- bounded per-call `gh` timeouts for the pump;
- legacy import of runs that ended before this build.

Until they land, rows mark those facts unavailable.
