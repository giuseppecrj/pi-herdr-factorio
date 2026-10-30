# Sandboxed stage

From F05 on, a claimed run's `specify` stage runs in the stage sandbox described in `docs/operations/sandbox.md`. It is a bwrap sandbox in its own `systemd-run --user` scope, and its only egress is a per-stage gateway. The controller first runs the sandbox preflight. When the preflight passes, it runs the specify stage on the stage's model. F05 ran one fixed probe prompt. From F06a the stage specifies the issue, which `specify.md` covers. A questions result ends `needs_info`. From F07a a contract continues through accept and leaves build `claimed` after the first tick. `tick --once` and `run --issue` wait through accept; a later scoped tick launches build and ends `stage_passed` or `failed` there. The command reference is "Runs" under "Controller" in `docs/operations/factory-cli.md`.

A passing stage spends real model tokens. The F05 probe spent 446 `openai/gpt-6.1-sol` tokens in round 2. The first F06a clear fixture spent 128,068, before the F06a token cuts. Every passing lane needs the model-spend grant as well as the fixture grant.

## Sub-features

- `stage-passed`: the first tick posts `1:claimed`, `2:running` at specify, `3:claimed`, `4:running` at accept, then `5:claimed` at build. The slot remains held. A second scoped tick posts `6:running`, then `7:stage_passed` or `7:failed` at build; see `acceptance.md` and `build.md`. The last marker's text is `stopped: stage passed; the next stage is not installed`. The run frees its slot. The tick logs `sandbox_preflight ok=true`, `stage_launched ... result=started` and `stage_ended ... cause=passed next=stage_passed`, and prints `executionEnabled=true`.
- `stage-receipt`: `<state>/stages/<runId>/specify-<attempt>/receipt.json`, mode 0600, holds `outcome`, `settlement` (`agent_settled`, `aborted: false`), the requested and observed models, `fallback`, `refusal`, `wallMs`, `turns`, `usage` (parent, children and gateway), `egress`, `stderr`, `assetsDigest`, `versions` and `pricing: "unavailable"`. It never appears in a marker.
- `stage-bundle-digest`: the receipt's `assetsDigest` equals the sha256 in the name `/var/lib/factory-sandbox/current` points to, `assets-<sha256>`. The tick's `sandbox_preflight` line shows its first 12 characters.
- `stage-egress`: `egress.jsonl` beside the receipt has one line per gateway request. A probe shows `model-openai:POST:200:forward`, and the receipt's gateway usage equals the parent's.
- `stage-stderr`: each Pi session's sandbox stderr is kept in `pi-stderr-<session>.log` beside the receipt, mode 0600, at most 65536 bytes, the tail. The receipt's `output`, set only on a pass, names `output.txt` with `bytes` and `kept`, and never holds its text. The receipt's `stderr` entry holds only `session`, `file` and `bytes`, the total the sandbox wrote. The text is untrusted. It is never in the tick output, the controller log or a marker.
- `sandbox-unavailable`: when the preflight fails, the run is `blocked` at `specify` with reason `sandbox_unavailable`, `executionEnabled` is `false`, and no model runs. It never falls back to an unsandboxed run. The next tick whose preflight passes launches it again.
- `stage-cleanup`: after the tick, no `factory-stage-*` user scope and no `bwrap`, `gateway-main` or `herdr --session factory` process is left.
- `stage-fallback`: a stage whose `WORKFLOW.md` entry sets `fallback_model` gets it as the launch's fallback. A structured refusal on the primary opens the `model-xai` route for one fresh session. `.github/factory/WORKFLOW.md` on `main` sets no fallback in F05, so a lane cannot drive this live yet. The unit tests cover it.

## How to get to it (user POV)

- `node server/cli.ts tick --once --json --repo giuseppecrj/pi-herdr-factorio --state-dir <dir> --issue <n>`, on the VM with the sandbox bundle installed.

## Driving it with ssh

Preconditions:

- The doctor reports `doctor=ok`, and `lane-setup.sh <pr-id> <worker-n>` printed `lane=... sha=...`.
- The bundle is installed. A read-only `readlink /var/lib/factory-sandbox/current` sent with `vm.sh` prints `assets-<sha256>`. Installing or replacing it (`bash server/provision.sh sandbox`) is a VM change and needs its own grant.
- One fixture issue per lane, labeled `factory:ready` by the owner, as in `tick-once.md`.
- The fixture grant and the model-spend grant.

- **Run a stage.** `.pi/skills/verify-factory/scripts/vm.sh .pi/skills/verify-factory/scripts/drive-stage.sh <pr-id> <worker-n> <issue>`. It runs one `tick --once` scoped to that issue and saves `stage-<UTC time>.json`, `.log` and `-evidence.txt` under `/tmp/swarm-<pr-id>/worker-<n>/`. It copies each new receipt there as `receipt-<runId prefix>-<stage>-<attempt>-<UTC time>.json`. The evidence has the command, exit code and wall time, the tick summary, the issue's bot markers as `seq:status:runId-prefix`, one line per new receipt, the egress lines as `route:method:status:decision:reason`, each stderr file as `name:mode:size:sha256-prefix`, the counts of leftover scopes and processes, and the controller log. Expect `exit=0` and the first-tick markers through `5:claimed` at build (then drive the second tick for build), `outcome=passed settlement=agent_settled:aborted=false`, `assets=` equal to the bundle digest, `egress=model-openai:POST:200:forward:null`, `stderr=0:pi-stderr-0.log:<bytes>`, and `leftover_scopes=0 leftover_processes=0`.
- **Sandbox unavailable.** Open a fresh fixture and run the same script with a fourth argument, `unavailable`. The tick's CLI child then sees a `bwrap` that exits 1 on its `PATH`. Expect `sandbox_preflight ok=false failed=bwrap`, `executionEnabled=false`, markers `1:claimed` and `2:blocked`, `receipts: none`, and no model spend. Then run the script again without `unavailable`. The preflight passes, and the blocked run continues through accept to build claimed; a later tick runs build.
- **Hold runs blocked for the capacity lanes.** The `tick-once.md` lanes that tick "until two are `blocked`" need runs that keep their slots. With a passing preflight a clear run holds its slot as build claimed after the first tick and frees it only after the second tick finishes build. So drive those lanes with `drive-stage.sh ... unavailable`, or put the same failing `bwrap` on the CLI's `PATH` in their wrapper scripts.
- **Read a stderr file.** Do not. The evidence records its size and hash. Its text is untrusted, so do not paste it into evidence or a report. Diagnose a crash from the receipt's `outcome` and the controller log.

Results observed on 2026-10-29 at `1f34dad`, lane `f05-w1`, on fixture #404 labeled by `giuseppecrj` (event 34613593830), before `drive-stage.sh` existed. The tick ran through `drive-tick.sh` and the receipt was read with a lane script.

| Step | Exit | Result |
| --- | --- | --- |
| `tick --once --issue 404` | 0 | `sandbox_reconciled stopped=0`, `sandbox_preflight ok=true assets=1111d27ad9f3`, markers `1:claimed`, `2:running`, `3:stage_passed`; `executionEnabled=true`; 18.2 s |
| Receipt | n/a | mode 600, `outcome: passed`, `agent_settled` with `aborted: false`, `openai/gpt-6.1-sol` requested and observed, `wallMs` 4773, `turns` 1, usage 446 (parent 446, gateway 446), `assetsDigest` `1111d27a…`, `pricing: "unavailable"` |
| After the tick | n/a | no `factory-stage-*` scope and no sandbox process |

`stderr` files, the `unavailable` mode and the receipt's `stderr` field come from F05 round 3. They have not been observed live yet.

## Gotchas

- Over `ssh bash -s`, `XDG_RUNTIME_DIR` is unset, so `systemctl --user` fails with `Failed to connect to bus: No medium found`. The CLI sets it to `/run/user/1000` itself, and `drive-stage.sh` exports it for its own scope check. Do the same in any lane script that lists or stops user scopes.
- The preflight result is cached for the life of the process. A one-shot `tick` runs it fresh each time. A `serve` that passed once does not notice a later failure.
- Each passing stage spends model tokens. Count them from the receipts' `usage` and keep the lane under its grant.
- Receipts and `pi-stderr-*.log` files live under the lane's state directory and go away with `cleanup.sh`. The copies in `/tmp/swarm-<pr-id>/worker-<n>/` stay.
- Every stage attempt gets a fresh directory. A replay of the same attempt is `specify-<attempt>.2`, so match receipts by the new-file check that `drive-stage.sh` does, not by a fixed path.
