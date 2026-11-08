# Verify a replay pair

Use only under an owner grant for fixture writes, model spend, production stop
and selection of installed bundles. Provisioning a missing bundle needs its own
VM-change grant. This recipe grants none of those actions.

`replay check` and `replay report` are read-only. The driver launches a real
scoped controller and can spend tokens and write fixture evidence to GitHub.
Local fake-transport tests do not prove native isolation, production restoration
or model quality. Keep F12a live lanes 6, 7, 10 and performance pending until
those drives actually run.

## Check the pins locally

```sh
node server/cli.ts replay check --json \
  --main-sha "$MAIN_SHA" --previous-sha "$PREVIOUS_SHA" \
  --candidate-sha "$CANDIDATE_SHA" > replay-check.json
TMPDIR=/home/g/.cache/f12a2-tmp node --experimental-strip-types \
  --test --test-concurrency=1 test/replay.test.ts test/replay-driver.test.ts
bash -n .pi/skills/verify-factory/scripts/drive-replay.sh
```

Supply full SHAs with local Git objects. Inspect every case status and `bundle`.
c5 is offline only. Stale or unavailable cases must not run. c1 uses
`git diff -G'BRANCH_NAME|isBranchName'` on `src/workflow.ts`, not a whole-file
workflow guard. The manifest pins both title and body. Copy its exact `title`
for both sides; never add a side name or free-text suffix to the live title.

Tests reuse the reviewer's fake `gh` and fake controller harness, with real
socket and file locks, local bundles and fake systemd commands. They exercise
refusals, preflight, accounting, signals and restoration without a VM or model.
See [Replay checks](../../../../docs/operations/metrics.md#replay-checks).

## Prepare an authorized window

1. Record the grant ID, previous/candidate SHAs, frozen main SHA, corpus digest,
   expected bundle digests and spend allowance. The grant ID must exist in the
   control checkout's `docs/decisions.tsv`; confirm its actual scope yourself.
2. Run the doctor and before snapshot in `SKILL.md`. Keep main frozen throughout
   both sides. The driver reads GitHub main before launch and at stop, not just
   the local tracking ref.
3. Make separate managed lane checkouts at the two factory SHAs. Run
   `lane-setup.sh` from each, with distinct `F12a-replay-...` lane IDs. Never reuse
   state or a lane's durable `replay.json`.
4. Prepare a **clean frozen-main control checkout** with dependencies, corpus,
   Git history and this driver. Its `HEAD` must equal `REPLAY_MAIN_SHA`. Invoke
   the driver from there: its trusted code enforces isolation, bundle checks,
   preflight and budget accounting. Never invoke the candidate's driver after
   this PR merges.
5. For the first pre-merge lane only, `--bootstrap-candidate` permits control
   `HEAD` at `REPLAY_CANDIDATE_SHA`. Pass it explicitly to start and stop. Output
   and `replay.json` record `bootstrap=true`, control SHA and grant. This is the
   one code-trust exception, not an enduring candidate bypass. It does not enable
   replay when frozen main lacks the replay cap or omit the recorded grant.
6. Under the fixture grant, create one **fresh issue per side**. Use the corpus
   title exactly and copy the entire case `issue.md` as the body, including its
   final newline. Add `factory:ready` from the authorized owner account. Missing
   labels, a closed issue, changed text or any prior factory run marker refuse
   before budget reservation. After an interruption use a fresh issue as well
   as fresh state; a new state directory cannot adopt another lane's claim.
7. Install both expected bundles under the VM-change grant before starting.
   Record each authorized provision's full manifest digest. The driver verifies
   both installed digests and all copied inputs against the pinned Git trees,
   including deleted skills. A provisioning-recipe change requires distinct
   expected bundle digests. It selects the side's installed bundle while
   production is stopped, then restores the original `current` target on exit.
   It does not build or download a bundle.

## Run one side on the VM

Run in the trusted VM environment, not locally. `vm.sh` does not forward local
environment variables automatically. Keep the supervising process attached to
an ordinary durable terminal; **start stays running** until the controller ends
or you stop it. Do not detach it and forget it.

```sh
export FIXTURE_GRANT='<recorded owner decision ID>'
export REPLAY_CONTROL_CHECKOUT='<clean frozen-main control repository>'
export REPLAY_CASE=c3
export REPLAY_SIDE=previous
export REPLAY_MAIN_SHA='<frozen main SHA>'
export REPLAY_PREVIOUS_SHA='<previous trusted factory SHA>'
export REPLAY_CANDIDATE_SHA='<candidate factory SHA>'
export REPLAY_PREVIOUS_ASSETS='<installed previous bundle digest>'
export REPLAY_CANDIDATE_ASSETS='<installed candidate bundle digest>'
S="$REPLAY_CONTROL_CHECKOUT/.pi/skills/verify-factory/scripts"
bash "$S/drive-replay.sh" F12a-replay-c3-previous 1 start '<fixture issue>'
# Only for the first pre-merge lane, append: --bootstrap-candidate
```

The driver takes the shared replay lock, pins the fixture, places the production
hold **before** `systemctl stop factory.service`, and verifies no production
controller process or bound socket remains. Explicit stop cancels the service's
`Restart=on-failure` restart. It checks both bundles and runs trusted sandbox
preflight before reserving anything. It re-checks production's lock and remote
main immediately before reservation and launch. `serve` gets only the named
fixture, isolated lane state and `--verification-token-cap 540000`.

The 540k reservation **equals the run's hard limit**, including review and
repair. Their full allowances are not reserved in addition. A heavy replay can
exhaust at review where production's 800k cap would continue. This is a known
comparability limit, even with equal replay caps. Overshoot is charged as used;
uncertain usage retains at least the reservation. Never delete the shared
`/home/exedev/factory-verification/replay-budget.json` to make room.

Require `replay=ready`, then inspect actual stage receipts and fixture markers;
controller readiness alone is not proof a stage ran. Record issue/PR URLs,
label-event ID, timestamps, factory SHA, outcome and tokens. `replay.json` beside
state durably records case, corpus digest, issue digest, side, fixture, main,
control SHA, grant, stage caps and stop disposition. Preserve it with the row.

## Stop, settle and compare

1. Capture handoff evidence before closure. Do not merge replay PRs. Under the
   fixture grant close the fixture PR unmerged and close its issue; for
   `needs_info`, capture the questions and terminal marker. Let the controller
   write its terminal row.
2. From another terminal with the same environment, stop the recorded lane:

   ```sh
   bash "$S/drive-replay.sh" F12a-replay-c3-previous 1 stop
   # First-lane bootstrap exception: append --bootstrap-candidate here too.
   ```

   The driver verifies the PID's actual `serve --state-dir` argv before sending
   TERM. The supervisor's exit trap stops the child, settles or retains the
   reservation, restores the bundle, original hold and original service state,
   and releases the replay lock. Before production resumes it removes the
   fixture's `factory:ready` label and verifies removal, including after preflight
   refusal, so production cannot pick up an unbudgeted replay fixture. The same
   trap runs on errors and catchable signals. If disarming or restoring the
   bundle fails, or the child cannot be stopped, production stays held for safety;
   treat that as a failed window, not successful restoration. SIGKILL or host
   loss cannot run a shell trap and needs operator recovery.

   One terminal verification row settles only when its fixture and verification
   manifest match. Without a row, unreadable accounting or any stage/usage
   evidence retains the full reservation. Only proven zero stages and zero
   usage is `voided`, releases the reservation and records the reason. A failed
   settlement keeps the PID metadata: fix the evidence problem and retry stop.
3. Require `replay=stopped` and the supervisor's `replay=window_closed`. Confirm
   production's original state. Repeat on a separate candidate lane and fresh
   fixture with `REPLAY_SIDE=candidate`. Each side is its own stopped-production
   window. Keep main frozen between them.
4. Compare both durable records and terminal rows:

   ```sh
   node server/cli.ts replay report --json --case c3 \
     --previous-sha "$REPLAY_PREVIOUS_SHA" --candidate-sha "$REPLAY_CANDIDATE_SHA" \
     --previous-row "$PREVIOUS_ROW" --candidate-row "$CANDIDATE_ROW" \
     --previous-record "$PREVIOUS_LANE/replay.json" \
     --candidate-record "$CANDIDATE_LANE/replay.json" > replay.json
   ```

   The report shows each side's own recorded corpus digest. It will not compare
   a row with itself, attach a row to another fixture or case, mix corpus pins
   or sides, or call different model/run-cap/stage-cap/policy/base/asset evidence
   comparable. Main movement during either side is incomparable. Declare both
   expected asset digests only for an authorized bundle switch. An incomparable
   report exits 0 because measurement never gates or promotes a run.
5. Retain handoff receipts separately; a cancelled terminal row does not prove
   earlier readiness. Keep stage times, model and runtime identity, token
   coverage and unavailable spend. The seven-day primary metric is unavailable.
6. Audit real GitHub effects, confirm every fixture issue is closed, and diff
   before/after snapshots. Verify no ordinary production dispatch or unrelated
   issue/PR mutation. Stop all lane processes before authorized cleanup; retain
   the budget, driver records and `/tmp/swarm-<lane>/worker-<n>/` evidence.

`REPLAY_ROOT`, `REPLAY_OUTPUT_ROOT` and `REPLAY_SANDBOX_ROOT` exist for isolated
local harness tests. Native lanes use the defaults. Fake-transport restoration
and accounting passes are not native VM proof.
