---
name: verify-factory
description: Verify pi-herdr-factorio on its real surfaces. Use to prove a change on the pi-factorio exe.dev VM, through repository-scoped gh reads, the /factory status command and the factory CLI (workflow-check, status --json), and when a PR needs live evidence.
---

# Verify pi-herdr-factorio

The factory is a Pi package plus a controller that runs on the exe.dev VM `pi-factorio`. You drive three surfaces:

- the VM, over ssh as `exedev`;
- GitHub, through `gh` with `GH_HOST=github.int.exe.xyz`, scoped to `giuseppecrj/pi-herdr-factorio`;
- the `/factory status` extension command;
- the factory CLI, `node server/cli.ts`, documented in `docs/operations/factory-cli.md`.

Run every command from the repository root of the checkout under test. Helpers live in `.pi/skills/verify-factory/scripts/`. Below, `S` means that directory.

Read `.pi/skills/verify-factory/features/README.md` for the feature map and the baseline rules before you drive anything.

## Launch

There is no long-running server to start. Launch means giving each lane its own workspace and state directory, then installing the committed dependencies there.

```bash
S=.pi/skills/verify-factory/scripts
$S/lane-setup.sh <pr-id> <worker-n>
```

This ships `git archive HEAD` of your checkout to `/home/exedev/factory-verification/<pr-id>-w<n>/ws` and runs `npm ci` there. State goes in `.../state`. It never touches the controller's production checkout. Commit first: uncommitted changes are not shipped. Ready means the script prints `lane=<dir> sha=<sha>`.

Live lanes always use a per-lane workspace and state directory under `/home/exedev/factory-verification/`. Never share one between lanes.

A later PR that adds `serve` starts it here with `--state-dir <lane>/state`. Until then there is no controller to start, and you must not start one.

## Doctor

Read-only. Run it first, and again whenever anything looks off.

```bash
$S/vm.sh $S/doctor.sh
```

It connects with `SSH_AUTH_SOCK=$HOME/.ssh/headless-agent.sock ssh exedev@pi-factorio.exe.xyz`, sets `PATH` to include `$HOME/.local/bin` and `$HOME/.local/share/mise/shims`, and prints the node, Pi, Herdr and `gh` versions and the OS image. It then proves a repository-scoped read with `GH_HOST=github.int.exe.xyz gh repo view giuseppecrj/pi-herdr-factorio`. Expected today: node 26.x (at least 26.12.1), pi 1.4.0, herdr 0.9.5, and `doctor=ok` on the last line.

Do not call `gh api user`. The integration is repository-scoped and that call fails. The doctor prints no credentials.

## Drive

Send multi-line scripts with `ssh host bash -s < script`. `vm.sh <script> [args]` does that for you. Never put a multi-line script inside an inline ssh string.

`vm.sh` quotes each argument with bash `printf %q`, and the remote login shell parses that quoting. So the VM user's login shell must be bash. It is bash for `exedev` today.

```bash
$S/vm.sh $S/drive-status.sh <pr-id> <worker-n>   # /factory status
$S/vm.sh $S/drive-gh.sh <pr-id> <worker-n>       # gh repo, label and issue reads
$S/vm.sh $S/drive-workflow.sh <pr-id> <worker-n> [branch...]  # workflow-check and status --json
```

Feature recipes are in `.pi/skills/verify-factory/features/`. Each lists the command and the observable result that proves it.

Pi's print mode (`pi -p "/factory status"`) sends the text to the model instead of running the command, and spends credits. `status-driver.ts` registers the real extension on a stub Pi and calls the registered `factory` handler. That is the same handler Pi runs.

Mutations (creating fixture issues, labels, comments, restarts) need the fixture grant from the task. Use one fixture issue per lane, named with the PR ID and worker number. A step that needs the owner to review or merge stays unchecked until the owner acts.

## Evidence

Save each lane's evidence under `/tmp/swarm-<pr-id>/worker-<n>/` on the VM and return that absolute path. The drive scripts write it. Each lane directory has:

- the raw output (`status.txt`, `repo.json`, `labels.txt`, `issues.json`, `workflow-check-<ref>.json`, `status-<ref>.json`);
- an evidence file with the command, start and end timestamps, head SHA, expected result, actual result and exit status.

Proof standards:

- Run the real path: the registered command, the real `gh` against the real repository. Do not call internal functions to fake a result.
- Capture the action and the resulting state.
- Record fixture URLs and label-event IDs for any mutation.
- Never simulate a stage that is not implemented. Stop and report it.
- No credentials in evidence. Export only redacted output.

Copy evidence into `docs/plans/media/<pr-id>/` only when the task authorizes it.

## Cleanup

```bash
$S/vm.sh $S/cleanup.sh <pr-id> <worker-n>
```

This removes that lane's workspace and state under `/home/exedev/factory-verification/` and nothing else. It never kills processes by name. If you started a process, stop it by the PID you recorded. Evidence in `/tmp/swarm-<pr-id>/worker-<n>/` survives cleanup. Confirm with the `ls` the script prints.

Run cleanup after a failed attempt too.

## Helpers

| Script | Where it runs | Invocation |
| --- | --- | --- |
| `vm.sh` | local | `vm.sh <script> [args]` |
| `doctor.sh` | VM | `vm.sh doctor.sh` |
| `lane-setup.sh` | local, calls `remote-setup.sh` | `lane-setup.sh <pr-id> <n>` |
| `drive-status.sh` | VM | `vm.sh drive-status.sh <pr-id> <n>` |
| `drive-gh.sh` | VM | `vm.sh drive-gh.sh <pr-id> <n>` |
| `drive-workflow.sh` | VM | `vm.sh drive-workflow.sh <pr-id> <n> [branch...]` |
| `cleanup.sh` | VM | `vm.sh cleanup.sh <pr-id> <n>` |
| `status-driver.ts` | VM, copied by `drive-status.sh` | not run directly |

Use `SSH_AUTH_SOCK_OVERRIDE` to point `vm.sh` at a different agent socket.
