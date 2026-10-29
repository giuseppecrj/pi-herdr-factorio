# tick --once and run --issue

`node server/cli.ts tick --once` runs one controller tick and prints the claim snapshot. `run --issue <n>` is the same tick limited to one issue, through the same switches and admission as polling. Both take the controller lock, check that `gh` acts as `exe-dev-github-integration[bot]`, post run markers on the issue and exit. No model runs: the only stage executor reports `stage_runner_not_installed`, and the run stays `blocked`. The command reference is the "Controller" section of `docs/operations/factory-cli.md`.

## Sub-features

- `tick-claim`: an admitted issue gets a `claimed` marker, then a `blocked` marker at stage `specify`, and a workspace under `<state>/workspaces/<runId>/`.
- `tick-capacity`: at most `agent.max_concurrent` (2) claims hold a slot; the next candidate is listed in `queued` with no marker.
- `tick-restart`: a second `tick --once` adopts each run from its markers, keeps its `runId`, and posts nothing.
- `tick-release`: a closed or unlabeled issue, or one with a newer ready event, gets a `released` marker on the next tick.
- `tick-relabel`: after `factory:ready` is removed and added again, the next tick posts `released` for the old run and `claimed`, then `blocked`, for a new `runId`, in that one tick.
- `tick-forged`: a marker comment from any account but the bot is ignored.
- `tick-corrupt`: an edited or malformed bot marker, or any edited bot comment, lists the issue in `corrupt` and nothing dispatches for it.
- `tick-deleted-marker`: after the owner deletes a blocked run's bot comments, the next tick, a fresh process, lists the issue in `corrupt` as `marker_missing` and posts nothing.
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

- **Tick.** `.pi/skills/verify-factory/scripts/vm.sh .pi/skills/verify-factory/scripts/drive-tick.sh <pr-id> <worker-n> tick <issue>...`. The script refuses to run without an issue, so a lane never ticks the whole repository. It saves `tick-<UTC time>.json`, `.log` and `-evidence.txt` under `/tmp/swarm-<pr-id>/worker-<n>/`. The evidence has the command, exit code and wall time, a one-line summary of the snapshot (`dispatch`, `reasons`, each run as `#issue:status@stage/attempt/seq/runId-prefix/workspace`, `queued`, `absent`, `refused`, `corrupt`, `markersPosted`), every bot marker on each issue as `seq:status:runId-prefix`, and the controller log.
- **Run one issue.** The same script with `run <issue>`.
- **Restart.** Run the tick a second time. Expect `claim_adopted` in the log, the same run IDs and `markersPosted=0`.
- **Forged marker.** As the owner, post a comment whose body is a well-formed `<!-- factory:run {...} -->` marker for the run. The next tick ignores it and the bot markers are unchanged.
- **Missing workspace.** Delete `<lane>/state/workspaces/<runId>` in a script sent with `vm.sh`, then tick. Expect `workspace_missing` in the log, `missing_replayed` in the summary and no new marker.
- **Deleted marker.** Tick until the run is `blocked`. As the owner, without `GH_HOST`, delete each bot comment with `gh api -X DELETE repos/giuseppecrj/pi-herdr-factorio/issues/comments/<id>`, then tick. Expect `corrupt=#<issue>:marker_missing`, `markersPosted=0` and `event=marker_corrupt ... defect=marker_missing` in the log. The claim record under `<lane>/state/claims/` keeps its `seq`.
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

Observed on 2026-10-29 at `b6acf4e`, on fixture #120 labeled by `giuseppecrj`:

| Step | Exit | Result |
| --- | --- | --- |
| First tick | 0 | `blocked`, markers `1:claimed,2:blocked`; claim record `seq: 2` |
| Owner deleted both bot comments, then a tick | 0 | `corrupt=#120:marker_missing`, `markersPosted=0`, no run |
| Another tick | 0 | the same; the claim record still `seq: 2` |

## Gotchas

- Always pass `--issue`. Without it the tick reads every `factory:ready` issue in the repository and may claim one that another lane or the production controller owns.
- The state directory must be private. `drive-tick.sh` runs `chmod 700` on `<lane>/state` because `lane-setup.sh` creates it with mode 0755 under the default umask, which is accepted, but a looser umask would not be.
- Markers are real comments on public issues and are never edited or deleted by the controller. Use fixture issues only.
- A claim posts two markers and every later status change posts one. Posting changes the issue's `updated_at`, so the next tick re-reads that issue once.
- A run blocked at `specify` keeps its slot until its issue is closed or unlabeled. Close fixtures at the end so their claims are released.
