---
name: verify-factory
description: Verify pi-herdr-factorio on its real surfaces. Use for authorized VM/CLI/extension/viewer verification, exact-head CI and human handoff, and live evidence. Keep source-only recipes and local saved-state checks separate from native proof.
---

# Verify pi-herdr-factorio

The factory is a Pi package plus a controller that runs on a verification VM, selected by name (see [Target](#target)). Drive these interfaces only under the task's grants:

- the VM, over ssh as `exedev`;
- GitHub, through repository-scoped `gh`, with the target's `GH_HOST` only in the trusted VM environment, never locally;
- the `/factory status` and `/factory run <issue>` extension commands;
- the factory CLI, `node server/cli.ts`, documented in `docs/operations/factory-cli.md`.

Run every command from the repository root of the checkout under test. Helpers live in `.pi/skills/verify-factory/scripts/`. Below, `S` means that directory.

Read `.pi/skills/verify-factory/features/README.md` for the feature map and the baseline rules before you drive anything.

## Target

`FACTORY_VM` names the VM every helper drives. It defaults to `pi-factorio`, the exe.dev VM. `.pi/skills/verify-factory/targets.env` holds one line per target: its name, its ssh destination and the `GH_HOST` that VM uses. `vm.sh` and `lane-setup.sh` read it locally through `target.sh`.

```bash
FACTORY_VM=pi-factorio $S/vm.sh $S/doctor.sh   # same as leaving FACTORY_VM unset
```

An unknown target, or one with an empty value, exits 2 with `unknown target <name>` or `target <name> not configured`, and opens no ssh connection. The `factorio` target (exmach) stays unconfigured until that VM exists. The lane root `/home/exedev/factory-verification/` and the `exedev` user are the same on every target.

## Launch

For short CLI drives, give each lane its own workspace and state directory, then install its committed dependencies. A scoped controller or read-only viewer can remain running only for its authorized drive; record its PID and stop it when finished.

```bash
S=.pi/skills/verify-factory/scripts
$S/lane-setup.sh <pr-id> <worker-n>
```

This ships `git archive HEAD` of your checkout to `/home/exedev/factory-verification/<pr-id>-w<n>/ws`, makes it a Git repository whose `origin` is `https://github.com/giuseppecrj/pi-herdr-factorio.git` so `/factory status` finds the repository, and runs `npm ci` there. State goes in `.../state`. It never touches the controller's production checkout. Commit first: uncommitted changes are not shipped. Ready means the script prints `lane=<dir> sha=<sha>`.

Live lanes always use a per-lane workspace and state directory under `/home/exedev/factory-verification/`. Never share one between lanes.

Never run a verification controller against this repository while production `factory.service` is running. Stop the service under an explicit grant, not just dispatch with a hold. A held controller still adopts runs from public markers.

Start a controller only with `drive-serve.sh`, which scopes it to the lane's fixture issues with `--issue` and records its PID. Never start `serve` without `--issue` from a lane.

## Doctor

Read-only. Run it first, and again whenever anything looks off.

```bash
$S/vm.sh $S/doctor.sh
```

Running `$S/doctor.sh` directly does the same thing, because it sends itself through `vm.sh`. It connects with `SSH_AUTH_SOCK=$HOME/.ssh/headless-agent.sock ssh <target ssh destination>`, prints `target=<name>` first, sets `PATH` to include `$HOME/.local/bin` and `$HOME/.local/share/mise/shims`, and prints the node, Pi, Herdr and `gh` versions and the OS image. It then proves a repository-scoped read with `gh repo view giuseppecrj/pi-herdr-factorio` under the target's `GH_HOST`. Expected today on `pi-factorio`: node 26.x (at least 26.12.1), pi 1.4.0, herdr 0.9.5, and `doctor=ok` on the last line.

Do not call `gh api user`. The integration is repository-scoped and that call fails. The doctor prints no credentials.

## Drive

Send multi-line scripts with `ssh host bash -s < script`. `vm.sh <script> [args]` does that for you, for the selected target, and sends `export FACTORY_VM=<name> GH_HOST=<target GH_HOST>` ahead of the script. Never put a multi-line script inside an inline ssh string.

`vm.sh` quotes each argument with bash `printf %q`, and the remote login shell parses that quoting. So the VM user's login shell must be bash. It is bash for `exedev` today.

```bash
$S/vm.sh $S/drive-status.sh <pr-id> <worker-n>   # /factory status
$S/vm.sh $S/drive-gh.sh <pr-id> <worker-n>       # gh repo, label and issue reads
$S/vm.sh $S/drive-workflow.sh <pr-id> <worker-n> [branch...]  # workflow-check and status --json
$S/vm.sh $S/drive-admit.sh <pr-id> <worker-n> <issue>...       # admit --json
$S/vm.sh $S/drive-tick.sh <pr-id> <worker-n> tick <issue>...   # tick --once, scoped
$S/vm.sh $S/drive-tick.sh <pr-id> <worker-n> run <issue>       # run --issue
$S/vm.sh $S/drive-stage.sh <pr-id> <worker-n> <issue> [unavailable]  # tick --once with a sandboxed stage, plus its receipt
$S/vm.sh $S/drive-serve.sh <pr-id> <worker-n> start <issue>... # serve, scoped, until stop
$S/vm.sh $S/drive-serve.sh <pr-id> <worker-n> stop             # SIGTERM the recorded PID
```

Every drive script sent through `vm.sh` requires the `GH_HOST` that `vm.sh` exports and stops if it is unset. `drive-replay.sh` is the exception. It runs on the VM as a file, so its operator exports that target's `GH_HOST` from `targets.env` in the VM shell first (see `features/replay.md`).

Feature recipes are in `.pi/skills/verify-factory/features/`. Each lists the command and the observable result that proves it.

Pi's print mode (`pi -p "/factory status"`) sends the text to the model instead of running the command, and spends credits. `status-driver.ts` registers the real extension on a stub Pi and calls the registered `factory` handler. That is the same handler Pi runs.

Mutations (creating fixture issues, labels, comments, restarts, and every `tick`, `run` or `serve`, which post marker comments) need the fixture grant from the task. A `tick`, `run` or `serve` whose sandbox preflight passes also runs a model stage and spends tokens, so it needs the model-spend grant too. See `features/sandbox-stage.md`. Use one fixture issue per lane, named with the PR ID and worker number. A step that needs the owner to review or merge stays unchecked until the owner acts. Only the owner changes `factory:enabled` or production rules. Read `features/handoff.md` for F09a bootstrap/P4, protection, exact-head identity, refresh, and merge observation. `status` and viewer reads spend no model tokens; `tick` is not a dry run. F09a rollout is forward-only from a drained controller, never deletion of private books/claims to restart.

## Snapshot

Run this before every swarm and again after it:

```bash
$S/vm.sh $S/vm-snapshot.sh <pr-id> 0 <minutes> '<glob>'
```

It prints, and saves to `/tmp/swarm-<pr-id>/worker-0/vm-snapshot-<UTC time>.txt`:

- the lane directories under `/home/exedev/factory-verification`;
- the PID, parent PID and name of every `node`, `gh` and `pi` process owned by `exedev`;
- files under `~` changed in the last `<minutes>` minutes, except under `factory-verification`, `.npm` and `.cache`;
- entries directly under `/tmp` that match `<glob>`, such as `factory-pwned*` for a sentinel a hostile-text lane would create.

`<minutes>` is a whole number. `<glob>` may contain only letters, digits, `.`, `_`, `-`, `*` and `?`. Set `<minutes>` to cover the swarm. Then diff the two files with `diff`. After a clean swarm, the only differences are the snapshot time, lanes the swarm still has to clean up, and files the lanes were expected to change. A leftover process, an unexpected file or a sentinel is a finding.

## Evidence

Save each lane's evidence under `/tmp/swarm-<pr-id>/worker-<n>/` on the VM and return that absolute path. The drive scripts write it. Each lane directory has:

- the raw output (`status.txt`, `repo.json`, `labels.txt`, `issues.json`, `workflow-check-<ref>.json`, `status-<ref>.json`, `admission-<issue>.json`);
- an evidence file with the command, start and end timestamps, head SHA, expected result, actual result and exit status.

Proof standards:

- Run the real path: the registered command, the real `gh` against the real repository. Do not call internal functions to fake a result.
- Capture the action and the resulting state.
- Record fixture URLs and label-event IDs for any mutation.
- Never simulate a stage that is not implemented. Stop and report it.
- Label source-checked/unrun, local saved-state/fake transport, historical scratch, and native VM/Actions/owner-action evidence separately. Recipe edits do not prove their live steps ran.
- Bind F09a evidence to the original instruction pin, exact tested head/tree, round/generation/intent, captured execution/attempt, candidate/gate/CI run/nonce, and reporter-owned check ID. See `features/handoff.md`.
- Keep native reporter/P4, production protection, real owner-action, and live/perf gates pending until their prerequisites and actual receipts exist. Both substantive formal checks timed out; completed partitions do not establish full formal qualification.
- No credentials in evidence. Export only redacted output.

Copy evidence into `docs/plans/media/<pr-id>/` only when the task authorizes it.

## Trusted reporter gate

Before merging any factory source PR, run `npm run check` and main's concurrency-2 gate tests locally through the trusted reporter. The following command matches the baseline and main-tree `testArgv` in `server/gates.ts`:

```bash
node --import ./.github/factory/gates/freeze.mjs --experimental-strip-types --test --test-concurrency=2 --test-timeout=60000 --test-reporter ./.github/factory/gates/reporter.mjs test/*.test.ts test/integration/*.test.ts
```

The manifest discovers `test/*.test.ts`, `test/sandbox/*.cases.ts`, and `test/integration/*.test.ts`. Pass the top-level and integration globs above. The gate drops `test/sandbox/*.cases.ts` from its argv because `test/sandbox.test.ts` imports them. Passing the cases separately runs each sandbox case twice. Keep the caller's umask; tests must pass under both 022 and the stricter 077. The replay driver keeps its own files private under 077 and launches `serve` with the factory unit's effective `UMask`, falling back to 022.

Require `"complete":true`, `"bad":false` and `"failures":[]` in the final JSON line. `npm run check` uses Node's default reporter and does not exercise the trusted reporter.

## Dependency gate

A gates lane reports every changed dependency manifest and lockfile. When the brief limits dependency changes to the sandbox assets, two files may change: the asset manifest `server/sandbox/assets/package.json` and its lockfile `server/sandbox/assets/package-lock.json`. A change to either passes. A change to any other manifest or lockfile fails, including the root `package.json` and `package-lock.json`.

## Cleanup

```bash
$S/vm.sh $S/cleanup.sh <pr-id> <worker-n>
```

Stop any `serve` the lane started with `drive-serve.sh ... stop` first. Cleanup removes that lane's workspace and state under `/home/exedev/factory-verification/` and nothing else. It never kills processes by name. If you started a process, stop it by the PID you recorded. Evidence in `/tmp/swarm-<pr-id>/worker-<n>/` survives cleanup. Confirm with the `ls` the script prints.

Run cleanup after a failed attempt too.

## Helpers

| Script | Where it runs | Invocation |
| --- | --- | --- |
| `vm.sh` | local | `[FACTORY_VM=<target>] vm.sh <script> [args]` |
| `target.sh` | local, sourced by `vm.sh` and `lane-setup.sh` | not run directly |
| `doctor.sh` | VM | `vm.sh doctor.sh`, or `doctor.sh`, which calls `vm.sh` |
| `lane-setup.sh` | local, calls `remote-setup.sh` | `lane-setup.sh <pr-id> <n>` |
| `drive-status.sh` | VM | `vm.sh drive-status.sh <pr-id> <n>` |
| `drive-gh.sh` | VM | `vm.sh drive-gh.sh <pr-id> <n>` |
| `drive-workflow.sh` | VM | `vm.sh drive-workflow.sh <pr-id> <n> [branch...]` |
| `drive-admit.sh` | VM | `vm.sh drive-admit.sh <pr-id> <n> <issue>...` |
| `drive-tick.sh` | VM | `vm.sh drive-tick.sh <pr-id> <n> tick\|run <issue>...` |
| `drive-stage.sh` | VM | `vm.sh drive-stage.sh <pr-id> <n> <issue> [unavailable]` |
| `drive-serve.sh` | VM | `vm.sh drive-serve.sh <pr-id> <n> start <issue>...` or `stop` |
| `vm-snapshot.sh` | VM | `vm.sh vm-snapshot.sh <pr-id> <n> <minutes> <glob>` |
| `cleanup.sh` | VM | `vm.sh cleanup.sh <pr-id> <n>` |
| `status-driver.ts` | VM, copied by `drive-status.sh` | not run directly |

Use `SSH_AUTH_SOCK_OVERRIDE` to point `vm.sh` at a different agent socket.
