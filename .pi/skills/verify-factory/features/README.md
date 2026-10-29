# Factory verification map

`.pi/skills/verify-factory/features/` is the maintained source for verifying pi-herdr-factorio. Read this index, then use the matching feature file in that directory as the recipe.

## Baseline preconditions

- Run `.pi/skills/verify-factory/scripts/vm.sh .pi/skills/verify-factory/scripts/doctor.sh` and require `doctor=ok`.
- Commit the change under test, then run `.pi/skills/verify-factory/scripts/lane-setup.sh <pr-id> <worker-n>`.
- Work only in `/home/exedev/factory-verification/<pr-id>-w<n>/`.
- Take a VM snapshot before the first lane and after the last one, and diff the two. See "Snapshot" in `SKILL.md`.
- Never drive a process this run did not start. Never run two controllers over the same issues. Always scope `tick`, `run` and `serve` with `--issue` to the lane's fixtures.

## Driving conventions

- `S` is `.pi/skills/verify-factory/scripts`. Run commands from the repository root.
- Send scripts with `$S/vm.sh`. Do not inline multi-line scripts in ssh.
- Use `GH_HOST=github.int.exe.xyz` and `-R giuseppecrj/pi-herdr-factorio`. Do not call `gh api user`.
- Do not remove evidence during cleanup.

## Proof and skip reporting

- Evidence goes to `/tmp/swarm-<pr-id>/worker-<n>/` on the VM.
- Record the command, timestamps, head SHA, expected result, actual result and exit status.
- Report an unreachable path with the attempted command and the unmet precondition.
- A stub feature is not verified. Report it as not implemented.

## Features

- **VM doctor** (`.pi/skills/verify-factory/features/vm-doctor.md`): VM reachability, tool versions, scoped repository read.
- **Repository reads** (`.pi/skills/verify-factory/features/gh-reads.md`): `gh` repo view, label list, issue list.
- **Factory status command** (`.pi/skills/verify-factory/features/factory-status.md`): `/factory status`.
- **workflow-check** (`.pi/skills/verify-factory/features/workflow-check.md`): load and validate the trusted `WORKFLOW.md` from a branch.
- **status --json** (`.pi/skills/verify-factory/features/status-json.md`): trusted settings and disabled execution as JSON, without a controller.
- **admit** (`.pi/skills/verify-factory/features/admit.md`): admission receipts for `factory:ready` label events, both kill switches, snapshot binding and deduplication.
- **tick --once and run --issue** (`.pi/skills/verify-factory/features/tick-once.md`): one controller tick, claims, markers, capacity, restart recovery, forged and corrupt markers, missing workspaces and the switches.
- **serve** (`.pi/skills/verify-factory/features/serve.md`): the controller daemon, `controller_ready`, the single-controller lock, reconcile before dispatch and SIGTERM stop.
