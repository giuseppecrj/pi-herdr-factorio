# Factory ticket metrics

`metrics --json` measures outcomes. It does not dispatch work, call a model,
change GitHub, gate a run or promote a factory revision. Replay is a separate
F12a slice and is not implemented by this command.

## Run it

Fetch the ledger into a local remote-tracking ref, then run the report:

```sh
git fetch origin refs/heads/factory/ledger:refs/remotes/origin/factory/ledger
node --experimental-strip-types server/cli.ts metrics --json \
  --repo giuseppecrj/pi-herdr-factorio --offline
```

The command never fetches automatically. Without `--ledger`, it reads
`refs/remotes/origin/factory/ledger:ledger/runs.jsonl` with local `git show`.
Alternatively, use `--ledger <file>` for a frozen JSONL copy.

Options:

- `--json` and `--repo <owner/name>` are required.
- `--now <instant>` fixes the evaluation time, for example
  `2026-11-08T06:00:00Z`. It accepts UTC ISO instants, optionally with three
  millisecond digits. This changes maturity evaluation, not the ledger snapshot
  or the current GitHub labels.
- `--state-dir <dir>` also verifies every listed redacted receipt digest for
  included runs. Only `receipt.json` files under `stages/<runId>/<attempt>/`
  and its session directories are read. Missing or changed bytes make the
  ticket unknown, including when the receipt belongs to an earlier failed run.
  Without this option, `receiptVerification` is `not_requested`; the ledger
  facts are used without claiming a local receipt audit.
- `--offline` makes no GitHub call. Defect follow-up is unknown, never assumed
  absent.
- `--cohort production` is the only supported cohort. Verification runs are
  excluded from every report. There is no verification-cohort escape hatch.

Exit codes are 0 for a report (including pending or unknown), 1 for an unreadable
ledger and 2 for invalid arguments. An empty ledger is insufficient data, not a
successful zero-defect history. Corrupt or unsupported rows are reported under
`unknowns`, not silently discarded.

## What counts

A ticket is `(repo, issue)`. Clarification attempts and fresh readiness events
remain visible in `tickets[].attempts` but count as one ticket. Every included
run's charged tokens count once, including failed, budget-exhausted, cancelled,
released and `needs_info` runs. Predecessor usage is not re-added. Duplicate run
IDs are reported as ledger anomalies and are not charged twice.

A clean landing needs all of these facts:

1. The run landed with `factory_verified` assurance.
2. The generation matching `assurance.generationDigest` has round 0. Main-move
   refreshes at round 0 are not repairs. The uninstrumented `repairRounds`
   aggregate is not used. Owner-feedback rounds count as repairs too.
3. A v5 landing is not `authored: owner`. Older rows lack that field and use
   their recorded assurance and generation. An `owner_override` is landed but
   never clean.
4. Seven days have elapsed since the merge, and the defect query found no
   linked follow-up defect in that window.

A ticket is clean if any of its mature landings is clean. Otherwise a mature
landing is landed-not-clean or unknown. A missing merge time or ambiguous
certifying generation is unknown, never clean. A ticket without a landing
matures seven days after its last terminal observation, allowing a fresh
readiness event to produce a later outcome.

Any immature ticket makes the cohort `pending`, even if it also lacks a receipt.
Unknowns are listed separately. A known repair or owner override proves a
landing is not clean even when its defect follow-up is unknown. The unknown
follow-up is still listed; it can never turn that landing into a clean one.

### Defect rule

Online mode makes one read-only command:

```sh
gh issue list --repo <repo> --label factory:defect --state all \
  --limit 10000 --json number,title,body,createdAt,labels
```

A follow-up must be another issue in that repository, carry `factory:defect`
at evaluation time, and have been created strictly after the merge and no more
than seven days later. Its title or body must reference the original issue or
PR using `#N`, `owner/repo#N` or a full GitHub issue/PR URL. Matching respects
number and repository boundaries. Generic `bug` or `factory:proposed` labels
alone do not count. Issue text is used for matching but never exported.

The command may paginate internally. A nonzero exit, transport failure,
invalid JSON or a saturated 10,000-issue limit makes the read unknown. It does
not treat a truncated list as proof that no defect exists. No label is created
by this command. Labels are current observations, not historical label events.

### Exclusions

All `provenance.kind: verification` rows are excluded. Legacy contexts carrying
a verification manifest are excluded too. Other `legacy_import` rows remain
included and appear under `legacyRuns`.

`EXCLUDED_RUNS` in `src/metrics.ts` is append-only. These verification runs were
written with production provenance:

| Run ID | Reason |
| --- | --- |
| `199df6dc85d53522b12bded884ebe6351dffcb80f7e456d42124ab39e994489f` | F10c issue 621, PR 622, ledger line 13 |
| `bd3db33b9ed3951db0800d381f3ea4a61eadcc1e615091eb4024dd9b4a465f22` | F10 fixture issue 650 |
| `89290787949a04cdbdc956f3b57356fa48c57f604823d232acba61108b266783` | F10 fixture issue 658 |

## Report fields

The version-1 report contains:

- `status`: `pending`, `unknown`, `insufficient_data` or `complete`.
- `primary`: clean-ticket numerator, unique-ticket denominator, landed,
  mature, pending and unknown ticket counts. `share` is null until the cohort
  is complete. Counts are observations so far, not a forecast.
- `tokens`: the sum of charged run totals, coverage and uncertain run IDs.
  Coverage is `lower_bound` if any included row is lower-bound; otherwise it
  is `uncertain` if any row is uncertain, else `exact`. Uncertain rows stay
  listed even when aggregate coverage is lower-bound. Unreadable ledger rows
  have unknown cost and are not part of the known total.
- `tokensPerCleanLanding`: all included tokens divided by the clean numerator.
  It is null with `tokensPerCleanLandingReason: no_clean_landings` when that
  numerator is zero. It remains provisional for a pending/unknown cohort and
  inherits the token coverage. `spend` is unavailable, not zero dollars.
- `tickets`: attempts, tokens, maturity, landings, certified rounds, authorship,
  defect results and reasons. Ticket unknowns never enter the clean numerator.
- `unknowns`, `excluded`, `legacyRuns`, `defectRead` and `receiptVerification`:
  the evidence and coverage limitations.
- `deferred`: the measurements below. None causes an action.

## Deferred-work signals

The coordinator defaults are centralized in `METRIC_POLICY` in `src/metrics.ts`.
The seven-day window and 0.10 revisit thresholds are reviewed constants, not
`WORKFLOW.md` settings. These defaults await the owner's design-call approval.

- **Context pressure:** `promptCapHit` is the decision signal. Report its share
  among all included runs with a known flag, the unknown-run count, and the
  mature count beside it. Per-stage shares use v3+ stage summaries whose
  `sourceCapHits` is known, with a hit meaning greater than zero. These are
  stage-summary shares, not individual provider-request measurements.
  `truncated` is information only, derived per stage from `excerptOmissions`.
  Intentional evidence windows can be truncated without hitting a source cap.
- **Restart-ended runs:** report failed or budget-exhausted runs with known
  interrupted attempts greater than zero, divided by all runs with a known
  interrupted-attempt count. Include the final failure class. An interruption
  contributed work; it does not prove that the restart caused the final stop.
- **Intake demand:** `unavailable: no_intake_signal`. No source currently records
  authorized requests for factory work on non-ready issues.

Signals use all known production facts, not only mature runs; `matureCount`
keeps that distinction visible. `belowThreshold` is true only below 0.10 and
null when there is no known denominator. `insufficientData` marks that case.
No signal builds the deferred feature or authorizes a cap increase.

## Pinned baseline

`test/fixtures/metrics/runs-2026-11-08.jsonl` contains the 26 public ledger rows
at ledger commit `48c885d`. Under these rules, 14 rows are excluded. The remaining
12 runs group into two tickets:

| Ticket | Runs | Charged tokens | Landed PR | Certified round | Matures |
| --- | ---: | ---: | --- | ---: | --- |
| 625 | 9 | 3,488,382 | 644 | 1 | 2026-11-14T07:31:17Z |
| 645 | 3 | 664,554 | 654 | 1 | 2026-11-15T02:01:33Z |

At 2026-11-08 the cohort is pending, with zero clean landings so far,
4,152,936 lower-bound charged tokens and undefined tokens per clean landing.
Both landed tickets required a repair. This is not mature seven-day evidence.
The unit suite includes synthetic clarification chains, defect windows, missing
receipts, owner heads and a 1,000-row computation budget of two seconds.
