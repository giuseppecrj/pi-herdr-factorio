# Factory verification map

This directory is the maintained source for verifying pi-herdr-factorio. Read this index, then use the matching feature file as the recipe.

## Baseline preconditions

- Run `.pi/skills/verify-factory/scripts/vm.sh .pi/skills/verify-factory/scripts/doctor.sh` and require `doctor=ok`.
- Commit the change under test, then run `.pi/skills/verify-factory/scripts/lane-setup.sh <pr-id> <worker-n>`.
- Work only in `/home/exedev/factory-verification/<pr-id>-w<n>/`.
- Never drive a process this run did not start. Never run two controllers over the same issues.

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

- **VM doctor** (`vm-doctor.md`): VM reachability, tool versions, scoped repository read.
- **Repository reads** (`gh-reads.md`): `gh` repo view, label list, issue list.
- **Factory status command** (`factory-status.md`): `/factory status`.
- **workflow-check** (`workflow-check.md`): stub, arrives in F04a.
- **status --json** (`status-json.md`): stub, arrives in F04a.
- **admit** (`admit.md`): stub, not implemented.
- **tick --once** (`tick-once.md`): stub, not implemented.
- **serve** (`serve.md`): stub, not implemented.
