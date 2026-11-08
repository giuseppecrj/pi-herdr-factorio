# Factory ticket metrics

`metrics --json` measures outcomes. It does not dispatch work, call a model,
change GitHub, gate a run or promote a factory revision. The separate
`replay check` and `replay report` commands compare pinned replay evidence.
They make no GitHub or model calls.

## Run it

Fetch the ledger into a local remote-tracking ref, then run the report:

```sh
git fetch origin refs/heads/factory/ledger:refs/remotes/origin/factory/ledger
node --experimental-strip-types server/cli.ts metrics --json \
  --repo giuseppecrj/pi-herdr-factorio --offline
```

The command never fetches automatically. By default it reads
`refs/remotes/origin/factory/ledger:ledger/runs.jsonl` with local `git show`.
That read has a 256 MiB buffer limit; exceeding it exits 1 with
`ledger_too_large`, never a partial report.

Use `--ledger-file <path>` for a frozen or constructed JSONL copy. The report
labels this `source: file`, rather than `source: ledger`. The input is read-only.
`--ledger <file>` remains an alias; passing both is a usage error. Verification
lanes 3 and 4 use constructed production-provenance rows through this input,
not a verification cohort on the real ledger. Verification exclusions still
apply to file inputs.

Options:

- `--json` and `--repo <owner/name>` are required.
- `--now <instant>` fixes the evaluation time, for example
  `2026-11-08T06:00:00Z`. It accepts UTC ISO instants, optionally with three
  millisecond digits. This changes maturity evaluation, not the ledger snapshot
  or the current GitHub labels. Online mode refuses an instant later than the
  actual defect read, with exit 1 and `now_after_defect_read`. A future instant
  is allowed offline, but offline defects remain unknown, never clean.
- `--state-dir <dir>` also verifies every listed redacted receipt digest for
  included runs. Only `receipt.json` files under `stages/<runId>/<attempt>/`
  and its session directories are read. Zero listed digests, or missing or
  changed bytes, make the ticket unknown, including when the receipt belongs
  to an earlier failed run.
  Without this option, `receiptVerification` is `not_requested`; the ledger
  facts are used without claiming a local receipt audit.
- `--offline` makes no GitHub call. Defect follow-up and review intervention
  are unknown, never assumed absent. Ledger-proven owner authorship or an
  owner override still establishes intervention.
- `--intervention-file <fixture>` is a test/verification-lane override, permitted
  only with `--offline` and `--ledger-file` (or its `--ledger` alias). Its shape
  is described below. It is not a production evidence source.
- `--cohort production` is the only supported cohort. Verification runs are
  excluded from every report. There is no verification-cohort escape hatch.

Exit codes are 0 for a report (including pending or unknown), 1 for an unreadable
ledger, an invalid intervention fixture or a future online evaluation instant,
and 2 for invalid arguments. An empty ledger is insufficient data, not a
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
   refreshes at round 0 are not repairs. An unavailable `repairRounds`
   aggregate never means zero; a known positive started count disqualifies
   a landing. Owner-feedback rounds count as repairs too.
3. No review intervention before merge under the rule below: a submitted
   `CHANGES_REQUESTED` review from an actor other than the factory bot, or a
   dismissed change request originally submitted by a non-bot actor. Dismissal
   does not erase intervention, even if no repair started or the original
   round-0 head remained certified.
4. A v5 landing is not `authored: owner`. Older rows lack that field and use
   their recorded assurance and generation. An `owner_override` is landed but
   never clean.
5. Seven days have elapsed since the merge, and the defect query found no
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

### Intervention rule

Online mode reads submitted reviews and the timeline of each included landed
row's `pr`, independently of the defect query and whether the landing already
needed a repair. Each distinct PR is read once using repository-scoped
`gh api` GET requests, with no write or permission lookup:

```sh
gh api 'repos/<repo>/pulls/<n>/reviews?per_page=100&page=1'
gh api 'repos/<repo>/issues/<n>/timeline?per_page=100&page=1'
```

Each endpoint allows at most ten numbered pages of 100 items within 30 seconds.
A short page proves completion; ten full pages, a failed page, invalid data or
truncated output gives `unknown: intervention_unreadable`. Both reads must
complete, even if an earlier page contained a change request. Offline reads
are unknown too. All GitHub reads for the report, including the defect-label
check and defect query, share a 120-second overall deadline. Each request is
limited to the time remaining. When the deadline is hit, unfinished and
remaining landings have `unknown: intervention_unreadable`; completed reads
remain usable. Ledger-proven intervention still takes precedence. Ledger
versions 1–5 need no new field.

A review counts when its current returned `state` is `CHANGES_REQUESTED`, its
`submitted_at` is strictly before the row's merge time, and `user.login` is not
`exe-dev-github-integration[bot]` (case-insensitive).

A timeline `review_dismissed` event also counts when `dismissed_review.state`
is `changes_requested` or `CHANGES_REQUESTED` and the original review was
submitted strictly before merge by a non-bot reviewer. The event's `review_id`
is matched to the reviews list for the original `submitted_at` and reviewer,
not the actor who dismissed it. A reviewer with `user.type: Bot` or a login
ending in `[bot]` (case-insensitive) is a bot. An unmatchable dismissed change
request makes intervention unreadable. Dismissed approvals and comment reviews
do not count. Pending reviews and reviews submitted at or after merge do not
count either. Dismissal never cancels a human change request for this metric.

The metric deliberately does **not** check write permission. The owner is the
only writer today, but a non-writer's change request still means a human had
to step in. This measures intervention, not F10's repair authorization gate.
Deleted reviews are not reconstructed.

Each landing reports `intervention` as `{kind: known, value: true|false,
source: github_reviews}` (covering both reviews and timeline) or an unknown
with reason `intervention_unreadable`.
Owner-authored v5 heads and owner overrides always report true with
`source: ledger`, even offline or with a false fixture. True intervention adds
`owner_intervention` to the landing's reasons. A validation repair alone does
not establish human intervention; it still disqualifies the landing separately
as `repair_round`. Unknown review evidence cannot make an otherwise-clean
landing clean; a known repair still proves it not clean.

#### Fixture override for tests and verification lanes only

An optional JSON file supplies explicit review-intervention facts for a frozen
or constructed ledger, keyed by run ID:

```json
{
  "version": 1,
  "landings": [
    { "runId": "<64-character run ID>", "intervention": false }
  ]
}
```

Use `--ledger-file <ledger.jsonl> --offline --intervention-file <fixture.json>`.
Every override is labeled `source: fixture` on the landing. Omitted runs stay
unknown. Invalid files exit 1 with `intervention_fixture_invalid`; online use
or use with the real default ledger is a usage error. This does not override
owner authorship, owner overrides, defect evidence, maturity or repairs.
In particular, offline defects remain unknown, so a false intervention fixture
alone cannot establish a clean landing.

### Defect rule

The owner must create the `factory:defect` label before an absence of defects
can be established. The metric never creates it. Online mode first confirms
its existence read-only; a missing label or an unconfirmed existence gives
`unknown: label_missing`, not "no defects".

```sh
gh api 'repos/<repo>/labels/factory%3Adefect'
gh issue list --repo <repo> --label factory:defect --state all \
  --limit 10000 --json number,title,body,createdAt,labels
```

A follow-up must be another issue in that repository, carry `factory:defect`
at evaluation time, and have been created strictly after the merge and no more
than seven days later. Its title or body must reference the original issue or
PR using `#N`, `GH-N`, `PR#N`, `owner/repo#N` or a GitHub issue/PR URL.
URLs accept bare `github.com`, `www.github.com`, `http://` and `https://` forms.
Matching respects number and repository boundaries and indexes references
once per defect, rather than scanning every defect for every landing.
Every labeled issue matching no included ticket is listed by number under
`unmatchedDefects`, even if outside a landing window, so typos cannot disappear.
Generic `bug` or `factory:proposed` labels alone do not count. Issue text is used for matching but never exported.

The command may paginate internally. A nonzero exit, transport failure,
invalid JSON or a saturated 10,000-issue limit makes the read unknown. It does
not treat a truncated list as proof that no defect exists. No label is created
by this command. Labels are current observations, not historical label events.

### Exclusions

Rows outside the exact requested repository are counted separately under
`excludedRowCounts.otherRepo` and `excludedRowCounts.repoCasingMismatch`.
A casing mismatch is not silently treated as an empty history.

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
- `tokensPerCleanLanding`: all included tokens divided by the clean numerator,
  only for a complete cohort. It is null for pending or unknown cohorts, with
  reason `cohort_pending` or `cohort_unknown`, even if a clean landing is already
  observed. Otherwise a zero numerator gives `no_clean_landings`. A number
  inherits token coverage. `spend` is unavailable, not zero dollars.
- `tickets`: attempts, tokens, maturity, landings, certified rounds, authorship,
  intervention and defect results and reasons. Ticket unknowns never enter the
  clean numerator.
- `unknowns`, `excluded`, `legacyRuns`, `defectRead` and `receiptVerification`:
  the evidence and coverage limitations.
- `deferred`: the measurements below. None causes an action.

## Deferred-work signals

The coordinator defaults are centralized in `METRIC_POLICY` in `src/metrics.ts`.
The seven-day window and 0.10 revisit thresholds are reviewed constants, not
`WORKFLOW.md` settings. The owner approved these defaults for F12a.

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

Signals use all known production facts, not only mature runs; each threshold
flag carries `flagBasis: includes immature runs`, and `matureCount` keeps that
distinction visible. `belowThreshold` is true only below 0.10 and
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
Both landed tickets required a repair. Online review evidence reports no
intervention on #644 (no pre-merge change request) and intervention on #654 (owner change
request 5815738464). This is not mature seven-day evidence.
The unit suite includes synthetic clarification chains, defect windows, missing
receipts, owner heads, intervention unknowns and a two-second computation
budget for 1,000 landings with 1,000 in-window labeled defects.

## Replay checks

`replay check --json` reads the local pinned corpus and Git objects. It never
fetches, creates a fixture, starts a controller, or writes a budget. From the
repository root:

```sh
node server/cli.ts replay check --json
```

The defaults are `test/fixtures/replay/`, local `origin/main` for both the main
and previous factory pins, and `HEAD` for the candidate factory. These defaults
are an inventory check, not a claim about which revision is deployed. Live
verification supplies explicit full 40-character SHAs:

```sh
node server/cli.ts replay check --json \
  --main-sha "$MAIN_SHA" --previous-sha "$PREVIOUS_SHA" \
  --candidate-sha "$CANDIDATE_SHA" --case c3 \
  --production-state-dir "$PRODUCTION_STATE" --budget-file "$REPLAY_BUDGET"
```

`--corpus <dir>` selects another pinned corpus. Its manifest digest covers
`JSON.stringify({v: 1, cases})`; each case also pins its issue text's SHA-256.
A changed digest refuses the check. The issue text includes its title as a
Markdown heading. It contains no active issue reference, GitHub URL, or mention.

Each live case compares its guarded paths between `baseSha` and the main pin.
Changed paths report `stale`, unavailable Git evidence reports `unavailable`,
and an offline case reports `offline_only`. The check also compares the two
factories' sandbox bundle inputs. Different inputs report
`bundle_switch_required`, not permission to re-provision production.

A selected case requires a readable production lock check, a budget path,
and a positive `replay.max_tokens` in the frozen main workflow. A bound
production socket refuses even when `controller.lock` is missing. A missing
state directory or unreadable lock refuses too. The check does not take the
production lock or stop the service. The operator must keep production stopped
throughout the authorized replay window.

Without `--case`, `allowed` is null and the output is an inventory, not launch
permission. With `--case`, `allowed` reflects the preconditions. A grant and the
operator's freeze of main remain separate requirements. Exit 0 means the check
completed without a refusal or unavailable case. Exit 1 means refused or
unreadable evidence, and exit 2 means invalid command syntax. A stale or offline
case in an unselected inventory does not by itself cause exit 1.

### Corpus version 1

The manifest is `test/fixtures/replay/corpus.json`. Its digest is
`22c4fd06d8f8f2c48ce592b68577bad071875db08f8cc53659a7ff6cb1945c81`.
The live cases pin base `28e700f745d7dea0809651d7c9711ca085de55d0`.

| Case | Historical issue | Guarded paths | Expected outcome | Mode |
| --- | --- | --- | --- | --- |
| c1 | 658 | `src/workflow.ts` | handoff, round 0 | live when unchanged |
| c2 | 650 | `server/viewer.ts` | handoff, round 0 | live when unchanged |
| c3 | 597 | `README.md` | `needs_info` | live when unchanged |
| c4 | 605 family, including 608, 610, 612 | `scripts/provenance.sh` | handoff, round 0 | live when unchanged |
| c5 | 645 | `server/cli.ts` | handoff | offline only |

Case c5 pins historical base `07852698ebdd1281f3ad21975ddd5d13f1ff0fc3`.
Its defect is already fixed on main. Replay does not add a historical-base
controller mode. Case c4 records failed historical runs, but its expected
successful result remains handoff. Historical token counts are corpus context,
not new model spend.

### Replay budget

Trusted `.github/factory/WORKFLOW.md` sets `replay.max_tokens: 1100000`.
An absent block disables live replay. A present block requires a positive safe
integer. The ordinary run, stage, turn, time, retry, and repair caps do not change.
Before this workflow change reaches main, a selected check against the older
main reports `replay_disabled`; candidate workflow bytes cannot enable it.

The VM driver serializes replay controllers and budget updates with `flock`.
Before launch, `reserveReplay` writes a private reservation for 540,000 tokens,
the per-run verification cap. A run cannot start with less than that much room.
Two outstanding reservations charge 1,080,000 tokens. The next run refuses.
The budget path is shared across both sides and subsequent replay pairs.
Deleting it would reset accounting and is not part of the replay procedure.

After stop, one terminal verification row with a matching verification-manifest
digest settles the reservation. Exact usage replaces the reserved token amount,
including failed runs. Lower-bound or uncertain usage retains at least 540,000,
or more if the charged total exceeds it. An interruption without a terminal
row retains the entire reservation. Repeated settlement of the same run is
idempotent. A changed cap, duplicate reservation, or duplicate run refuses.

The budget records elapsed wall time from reservation to settlement. An open
reservation continues to accrue elapsed time when read. This includes controller
waiting and is distinct from the report's sum of stage wall times. There is no
new replay wall-time ceiling; existing controller time limits still apply.

## Replay reports

`replay report --json` reads two frozen terminal ledger rows. It starts no
subprocess and calls neither GitHub nor a model:

```sh
node server/cli.ts replay report --json --case c3 \
  --previous-sha "$PREVIOUS_SHA" --candidate-sha "$CANDIDATE_SHA" \
  --previous-row "$PREVIOUS_ROW" --candidate-row "$CANDIDATE_ROW"
```

Each input must contain exactly one supported ledger row with verification
provenance. Production and legacy rows refuse. The report carries the corpus
digest, supplied factory SHAs, original base, workflow and gate pins, stage
usage, requested and observed models, runtime versions, and asset digests.
Factory SHAs are operator-supplied lane identities, not reconstructed from a row.

Different repositories, original bases, or policy pins make a pair
`incomparable`. Missing gate or asset evidence also makes it incomparable.
Assets must match unless both `--previous-assets <digest>` and
`--candidate-assets <digest>` declare the expected different bundle digests.
Those options permit a recorded bundle switch, not a missing asset receipt.
An incomparable report still exits 0; it is a measurement, never a gate.
Unreadable inputs exit 1. Invalid command syntax exits 2.

A `needs_info` outcome can match directly. A terminal cancelled fixture row
cannot prove that its PR previously reached handoff. Handoff expectations
therefore report `unknown`; keep the readiness receipt and PR evidence separately.
`expectedRound`, `certifiedRound`, and `lastGenerationRound` remain separate facts,
not an inferred handoff pass.

The primary seven-day metric is unavailable for replay. Replay does not wait
seven days or establish clean production landings. Spend remains unavailable,
not zero, and same-family stages do not establish cross-family independence.
Neither command gates, advances, or promotes a run. The authorized live driver
and evidence procedure are in
[Verify a replay pair](../../.pi/skills/verify-factory/features/replay.md).
