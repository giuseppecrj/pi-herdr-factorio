# serve

`node server/cli.ts serve` is the controller daemon. It takes the lock, checks that `gh` acts as `exe-dev-github-integration[bot]`, logs `event=controller_ready`, then runs one tick every `polling.interval_ms` (30 seconds) until SIGTERM or SIGINT. A stop lets the current tick finish and removes the lock. The command reference is the "Controller" section of `docs/operations/factory-cli.md`. `server/factory.service` runs it under systemd; nothing installs that unit automatically.

## Sub-features

- `serve-ready`: the structured `event=controller_ready pid=<pid> repo=<repo> scope=<issues>` line.
- `serve-single-authority`: while `serve` holds the state directory's lock, the abstract socket `@pi-herdr-factorio/<sha256 of its real path>`, any other `tick`, `run` or `serve` on that state directory exits 2 with `controller_running` before any `gh` call. Deleting `<state>/controller.lock` does not free it; only the holder's exit does. `grep pi-herdr-factorio /proc/net/unix` on the VM shows the bound name.
- `serve-reconcile`: an issue closed while `serve` runs is released on the next tick, and a queued issue takes its slot in the same tick.
- `serve-stop`: SIGTERM ends with `event=controller_stopping`, exit 0 and no lock file.
- `serve-identity`: without `GH_HOST`, `serve` logs `controller_refused reason=identity_unavailable` and exits 1.

## How to get to it (user POV)

- `node server/cli.ts serve --repo giuseppecrj/pi-herdr-factorio --state-dir <dir> --issue <n>...`

## Driving it with ssh

Preconditions:

- The doctor reports `doctor=ok`, and `lane-setup.sh <pr-id> <worker-n>` printed `lane=... sha=...`.
- Fixture issues labeled `factory:ready` by the owner, as in `tick-once.md`.
- Never start a second `serve` on the same issues from another lane.

- **Start.** `.pi/skills/verify-factory/scripts/vm.sh .pi/skills/verify-factory/scripts/drive-serve.sh <pr-id> <worker-n> start <issue>...`. The script refuses to start without an issue. It runs `serve` in its own session, records the PID in `<lane>/serve.pid`, appends stderr to `/tmp/swarm-<pr-id>/worker-<n>/serve.log`, and waits up to 60 seconds for that PID's `controller_ready`. It prints `serve=ready pid=<pid>` or `serve=not_ready` and exits 1.
- **Second controller.** While it runs, drive `drive-tick.sh <pr-id> <worker-n> tick <issue>`. Expect `exit=2` and `error=controller_running pid=<serve pid>`.
- **Reconcile.** Close one claimed fixture as the owner, wait at least 30 seconds, and read `serve.log`. Expect `claim_released ... why=closed`, its `released` marker, and a `claim_taken` for a queued issue in the same tick.
- **Stop.** `drive-serve.sh <pr-id> <worker-n> stop` sends SIGTERM to the recorded PID only, waits up to 120 seconds, and prints `serve=stopped pid=<pid> ms=<ms> lock=absent`.

Results observed on 2026-10-29 at `add4f6b`, scoped to fixtures #66, #67 and #68:

| Step | Result |
| --- | --- |
| Start | `controller_ready` after 1 s; the first tick adopted #66 and #67 from their markers and left #68 queued |
| `tick --once` on the same state | exit 2, `controller_running`, 168 ms |
| Close #66 | 33 s later, the next tick released #66 (seq 3) and claimed #68 (seq 1 and 2) |
| Stop | `controller_stopping`, stopped in 1 s, lock absent |

## Gotchas

- Stop only the PID in `<lane>/serve.pid`. Never kill `node` processes by name: the production controller may be one of them.
- `serve` prints nothing on stdout. Everything is in the log lines on stderr.
- The poll interval comes from `WORKFLOW.md` on `main`. Waiting less than one interval after a change shows nothing.
- A `serve` left running keeps posting markers for its scoped issues. Stop it before `cleanup.sh`, which removes the lane directory and with it `serve.pid`.
