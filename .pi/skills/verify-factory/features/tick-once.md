# tick --once and run --issue

`node server/cli.ts tick --once` runs one controller tick and prints the claim snapshot. `run --issue <n>` is the same tick limited to one issue, through the same switches and admission as polling. Both take the controller lock, check that `gh` acts as `exe-dev-github-integration[bot]`, post run markers on the issue and exit. No model runs: the only stage executor reports `stage_runner_not_installed`, and the run stays `blocked`. The command reference is the "Controller" section of `docs/operations/factory-cli.md`.

## Sub-features

- `tick-claim`: an admitted issue gets a `claimed` marker, then a `blocked` marker at stage `specify`, and a workspace under `<state>/workspaces/<runId>/`.
- `tick-capacity`: at most `agent.max_concurrent` (2) claims hold a slot; the next candidate is listed in `queued` with no marker.
- `tick-restart`: a second `tick --once` adopts each run from its markers, keeps its `runId`, and posts nothing.
- `tick-release`: a closed or unlabeled issue, or one with a newer ready event, gets a `released` marker on the next tick.
- `tick-terminal-record`: a run that ends keeps its claim record with the terminal status until a ledger read shows that marker or a later one, then `claim_removed` removes it. While it is kept, a fresh process whose comments read omits the terminal marker posts nothing, and a reopened issue's ended event is not admitted, recovered or adopted.
- `tick-relabel`: after `factory:ready` is removed and added again, the next tick posts `released` for the old run and `claimed`, then `blocked`, for a new `runId`, in that one tick.
- `tick-forged`: a marker comment from any account but the bot is ignored.
- `tick-corrupt`: an edited or malformed bot marker, or any edited bot comment, lists the issue in `corrupt` and nothing dispatches for it.
- `tick-ledger-behind`: when a fresh process's comments read for a blocked run comes back empty or short, the claim record carries the run. The tick logs `ledger_behind`, lists the issue in `ledgerBehind`, keeps the run and its slot, posts nothing, and leaves a queued issue queued.
- `tick-workspace`: a deleted workspace is reported as `missing_replayed` and recreated, with no new marker.
- `tick-switches`: with either switch off, `dispatch.enabled` is `false` and existing runs stay as they were.
- `run-issue`: `run --issue` exits 0 when the issue holds a run and 1 otherwise.

## How to get to it (user POV)

- `node server/cli.ts tick --once --json --repo giuseppecrj/pi-herdr-factorio --state-dir <dir> --issue <n>...`
- `node server/cli.ts run --json --repo giuseppecrj/pi-herdr-factorio --issue <n> --state-dir <dir>`

## Driving it with ssh

Preconditions:

- The doctor reports `doctor=ok`, and `lane-setup.sh <pr-id> <worker-n>` printed `lane=... sha=...`.
- One fixture issue per lane, titled with the PR ID and worker number, labeled `factory:ready` by the owner from the workstation `gh` without `GH_HOST`. The bot's own label is refused as `unauthorized`. Creating and labeling fixtures needs the fixture grant.
- No `serve` from this lane is running, unless the step tests the lock.

- **Tick.** `.pi/skills/verify-factory/scripts/vm.sh .pi/skills/verify-factory/scripts/drive-tick.sh <pr-id> <worker-n> tick <issue>...`. The script refuses to run without an issue, so a lane never ticks the whole repository. It saves `tick-<UTC time>.json`, `.log` and `-evidence.txt` under `/tmp/swarm-<pr-id>/worker-<n>/`. The evidence has the command, exit code and wall time, a one-line summary of the snapshot (`dispatch`, `reasons`, each run as `#issue:status@stage/attempt/seq/runId-prefix/workspace`, `queued`, `absent`, `refused`, `corrupt`, `ledgerBehind` as `#issue:ledgerSeq<localSeq`, `markersPosted`), every bot marker on each issue as `seq:status:runId-prefix`, and the controller log.
- **Run one issue.** The same script with `run <issue>`.
- **Restart.** Run the tick a second time. Expect `claim_adopted` in the log, the same run IDs and `markersPosted=0`.
- **Forged marker.** As the owner, post a comment whose body is a well-formed `<!-- factory:run {...} -->` marker for the run. The next tick ignores it and the bot markers are unchanged.
- **Missing workspace.** Delete `<lane>/state/workspaces/<runId>` in a script sent with `vm.sh`, then tick. Expect `workspace_missing` in the log, `missing_replayed` in the summary and no new marker.
- **Ledger behind.** Open three fixtures and tick until two are `blocked` and the third is `queued`. Run one tick whose CLI child sees a `gh` wrapper that answers `[]` to every GET of `repos/<repo>/issues/<a>/comments*`, as in `F04c/fix-5/behind-tick.sh` in the trail. Put the wrapper only on the `node` PATH, so the evidence read uses the real `gh`, and `export -f node require_lane_ids valid_lane_id`. Expect `event=ledger_behind issue=<a> ledgerSeq=0 localSeq=2`, `ledgerBehind=#<a>:0<2`, both runs still `blocked`, the third issue still `queued`, `corrupt=none` and `markersPosted=0`. A normal tick after it changes nothing and posts nothing. Deleting the bot comments as the owner gives the same result. The claim record under `<lane>/state/claims/` holds `seq`, `status`, `stage`, `attempt` and `usage`.
- **Terminal record.** Open one fixture and tick until it is `blocked`. Close it as the owner, wait about 10 s for the candidate list, and tick: expect `claim_released ... why=closed`, a `3:released` marker and the claim record kept with `"status":"released","seq":3`. A fresh tick logs `claim_removed ... seq=3 status=released` and leaves no record. For the lag case, start a new event (remove and re-add `factory:ready`), tick until `blocked`, close, and tick with a `gh` wrapper on the `node` PATH that drops comments containing `"status":"released"` from the issue's comments GETs, as in `F04c/fix-6/hide-tick.sh` in the trail: the release posts and the record stays. A fresh tick with that wrapper logs `ledger_behind` and posts nothing. Reopen without relabeling and run a fresh tick whose wrapper answers `[]`, as in `F04c/fix-6/empty-tick.sh`: expect `ledger_behind ... ledgerSeq=0`, no `claim_taken`, `admission_recovered` or `claim_adopted`, `markersPosted=0` and the record kept. A normal tick then logs `claim_removed`. Once the record is removed, a reopen whose read omits the terminal marker is the documented deletion gap; do not run it on a fixture you still need.
- **Local switch.** `touch <lane>/state/disabled`, then `run`. Expect `reasons=locally_disabled`; an existing run is still listed, and nothing new is claimed.

Results observed on 2026-10-29 at `add4f6b`, on fixtures #66, #67 and #68, each labeled by `giuseppecrj`:

| Step | Exit | Result |
| --- | --- | --- |
| First tick | 0 | #66 and #67 `blocked` at `specify`, seq 2 each; #68 `queued` with no marker; 7.9 s |
| Second tick, a restart | 0 | both adopted with the same run IDs, `markersPosted=0`; 4.2 s |
| Tick while `serve` held the lock | 2 | `controller_running pid=<serve pid>`, no `gh` call, 168 ms |
| Owner-forged `released` marker with seq 99 on #67, and its workspace deleted, then tick | 0 | the forged marker ignored; #67 `missing_replayed`, still `blocked`, no new marker |
| `run --issue 67` with `<state>/disabled` | 0 | `reasons=locally_disabled`; #67 still `blocked` |
| #67 and #68 closed, then tick | 0 | each got a `released` marker, seq 3; `absent=66+67+68` |
Observed on 2026-10-29 at `feb9173`, lane `F04c-fix5 1`, on fixtures #175, #176 and #177, each labeled by `giuseppecrj`:

| Step | Exit | Result |
| --- | --- | --- |
| First tick | 0 | #175 and #176 `blocked`, seq 2 each; `queued=177`; claim records hold `seq: 2`, `status: blocked`, `stage: specify`, `attempt: 1` |
| Fresh tick whose `gh` answers `[]` to #175's comments GET | 0 | `event=ledger_behind issue=175 ledgerSeq=0 localSeq=2`, `ledgerBehind=#175:0<2`; both runs `blocked` seq 2; `queued=177`; `corrupt=none`; `markersPosted=0`; no POST through the wrapper |
| Normal fresh tick | 0 | the same runs and queue, `ledgerBehind=none`, `markersPosted=0` |
| All three closed, then tick | 0 | `claim_released ... why=closed` and a `3:released` marker on #175 and #176, none on #177; no claim records left |

Observed on 2026-10-29 at `47b1ed2`, lane `F04c-fix6 1`, on fixture #204, labeled by `giuseppecrj` (events 34564217866, then 34564300487):

| Step | Exit | Result |
| --- | --- | --- |
| First tick | 0 | `blocked` seq 2; the record holds `"usage":0` |
| Closed, then a fresh tick | 0 | `claim_released ... why=closed`, `3:released`; the record kept as `released` seq 3 |
| Fresh tick | 0 | `claim_removed ... seq=3 status=released`; no records; `markersPosted=0` |
| Reopened, relabeled, then tick | 0 | the first event not revived; the new event `4:claimed`, `5:blocked` |
| Closed, then a fresh tick hiding `released` comments | 0 | `6:released` posted; the record kept as `released` seq 6 |
| Fresh tick, still hiding | 0 | `ledger_behind issue=204 ledgerSeq=5 localSeq=6`; `markersPosted=0`; the record kept |
| Reopened without relabeling, fresh tick whose `gh` answers `[]` | 0 | `absent=none`, `ledger_behind ... ledgerSeq=0 localSeq=6`; no claim, recovery or adoption; no POST through the wrapper; the record kept |
| Normal fresh tick | 0 | `claim_removed ... seq=6 status=released`; no records; `markersPosted=0` |

## Gotchas

- Always pass `--issue`. Without it the tick reads every `factory:ready` issue in the repository and may claim one that another lane or the production controller owns.
- The state directory must be private. `drive-tick.sh` runs `chmod 700` on `<lane>/state` because `lane-setup.sh` creates it with mode 0755 under the default umask, which is accepted, but a looser umask would not be.
- Markers are real comments on public issues and are never edited or deleted by the controller. Use fixture issues only.
- A claim posts two markers and every later status change posts one. Posting changes the issue's `updated_at`, so the next tick re-reads that issue once.
- A run blocked at `specify` keeps its slot until its issue is closed or unlabeled. Close fixtures at the end so their claims are released.
- After a release the claim record stays, with status `released`, until a later tick reads the marker. Expect `no claim records` only after that tick's `claim_removed`.
- A claim record whose run has not ended holds a slot from the moment a process loads it, even if its comments read fails, so a third issue stays `queued` until that claim is adopted, released or dropped.
