# Verify a replay pair

Use this recipe only under a fixture, model-spend, and production-stop grant.
The replay commands themselves are read-only. `drive-replay.sh start` launches
a real scoped controller, spends model tokens, and writes fixture evidence to
GitHub. This recipe does not authorize those actions.

Local unit tests and saved-row reports are not live isolation proof. Keep the
F12a lanes 6, 7, and 10 and replay performance evidence pending until the
corresponding live drives run.

## Check the pins without a live run

From the repository root, run:

```sh
node server/cli.ts replay check --json \
  --main-sha "$MAIN_SHA" --previous-sha "$PREVIOUS_SHA" \
  --candidate-sha "$CANDIDATE_SHA" > replay-check.json
```

Use full SHAs whose Git objects exist locally. Inspect every case's status and
`bundle`. The inventory does not grant launch permission. Case c5 is offline
only. A live case with changed guarded paths is stale and must not run.
See [Replay checks](../../../../docs/operations/metrics.md#replay-checks) for
flags, corpus pins, budget accounting, and report limitations.

Run the local tests and syntax check:

```sh
TMPDIR=/home/g/.cache/f12a2-tmp node --experimental-strip-types \
  --test test/replay.test.ts
bash -n .pi/skills/verify-factory/scripts/drive-replay.sh
```

The tests cover the bound production socket through the public CLI, including
when its holder file is absent. Driver guards are source-checked, not executed.
The tests do not create fixture issues, start a live controller, or call models.

## Prepare an authorized live window

1. Record the grant ID, deployed previous factory SHA, candidate SHA, frozen main
   SHA, corpus digest, bundle digests, and permitted token spend.
2. Run the doctor and take the before snapshot described in `SKILL.md`.
3. Stop production under the explicit grant. A dispatch hold is insufficient
   because a held controller still observes public markers. Keep production
   stopped and main frozen through both sides.
4. Create separate managed checkouts at the two factory SHAs. From each checkout,
   run `lane-setup.sh` with a distinct `F12a-replay-...` lane ID. Use a fresh state
   directory for every side, including after an interrupted run.
5. Keep a separate candidate control checkout on the VM with the pinned Git
   objects, dependencies, corpus, and `drive-replay.sh`. Set
   `REPLAY_CONTROL_CHECKOUT` to that repository root. The lane archives alone do
   not contain the history required by `replay check`.
6. Under the fixture grant, create one issue per side. Start its title with
   `[F12a-replay-<case>-previous]` or `[F12a-replay-<case>-candidate]`. Copy the
   case's entire `issue.md` as its body without edits. Add `factory:ready` from
   the authorized owner account. Never dispatch an ordinary production issue.
7. If `bundle_switch_required` appears, provision the matching bundle under a
   separate VM-change grant before that side. Plan restoration of production's
   bundle before restarting production. Without a grant for a required switch,
   stop here.

Do not use the ordinary `drive-serve.sh` for replay. It does not reserve the
replay budget or pass the verification cap.

## Start one side on the VM

Run these commands in the trusted VM environment, not locally. Use a unique
lane for each side. The script supports direct VM invocation and also the
existing `vm.sh` transport when an authorized wrapper supplies these variables.
`vm.sh` does not forward local environment variables automatically.

```sh
export FIXTURE_GRANT='<owner decision ID>'
export REPLAY_CONTROL_CHECKOUT='<candidate control repository on the VM>'
export REPLAY_CASE=c3
export REPLAY_SIDE=previous
export REPLAY_MAIN_SHA='<frozen main SHA>'
export REPLAY_PREVIOUS_SHA='<deployed trusted factory SHA>'
export REPLAY_CANDIDATE_SHA='<candidate factory SHA>'
S="$REPLAY_CONTROL_CHECKOUT/.pi/skills/verify-factory/scripts"
bash "$S/drive-replay.sh" F12a-replay-c3-previous 1 start '<fixture issue number>'
```

Require `replay=ready`, then inspect the scoped controller's marker and stage
receipts. Capture timestamps, issue URL, label event, exact lane head, expected
outcome, actual outcome, exit code, and charged tokens.

The start path requires `FIXTURE_GRANT`, matching lane and factory pins, an
unchanged local main pin, the fixture title and body, and empty isolated state.
It holds `/home/exedev/factory-verification/replay-driver.lock` through the
controller's lifetime. It checks production's real socket lock and the frozen
main replay policy before reserving 540,000 tokens in the shared
`/home/exedev/factory-verification/replay-budget.json`. Only then does it launch
`serve --issue <fixture> --verification-token-cap 540000` from that side's lane.

A failed readiness wait keeps the PID and budget reservation. Inspect the saved
log and stop that recorded process. Never launch another side to work around a
failed start, and never delete the shared budget to make room.

## Stop, settle, and compare

1. Capture handoff evidence before closure if the expected outcome is handoff.
   Do not merge a replay PR. Under the fixture grant, close the fixture PR
   unmerged and close its issue. For `needs_info`, capture the questions and
   terminal marker. Let the scoped controller publish its terminal row.
2. With the same grant and control-checkout environment, stop only the recorded
   replay process:

   ```sh
   bash "$S/drive-replay.sh" F12a-replay-c3-previous 1 stop
   ```

   Require `replay=stopped`. A missing terminal row retains the full reservation.
   Do not claim that a retained reservation measures actual usage. The script
   settles only one terminal verification row whose manifest digest matches
   that lane's `verification.json`.
3. Repeat with `REPLAY_SIDE=candidate` and a separate candidate lane and issue.
   Run the sides sequentially. Preserve both frozen
   `<state>/ledger/<runId>/row.json` files.
4. Run `replay report --json --case <id>` with both row paths and both factory
   SHAs. Save `replay.json`. Require matching original bases and previous-policy
   pins for a comparable result. Declare both expected asset digests only when
   the authorized procedure deliberately switched bundles.
5. Retain stage times, models, runtime versions, token coverage, and unavailable
   spend. A cancelled terminal row is not proof of earlier readiness. Keep its
   handoff receipts beside the report. Report the primary seven-day metric as
   unavailable rather than inventing a clean landing.
6. Audit the real GitHub effects. Confirm every issue and PR belongs to the named
   fixtures, every fixture issue is closed, and no production dispatch occurred.
   Compare the before and after snapshots and production state. Restore the
   production bundle and restart production only under the corresponding grant.
7. Stop every recorded lane process before authorized lane cleanup. Retain the
   budget and `/tmp/swarm-<lane>/worker-<n>/` evidence.

Lane 7 needs the real side-effect audit and isolated-state evidence. Lane 10
needs exact policy, model, and runtime provenance for both sides. Lane 6 and the
replay performance baseline need the authorized tiny-case pair. A read-only
report on historical rows proves none of these live claims.
