# status --json

`node server/cli.ts status --json` prints the factory's status as JSON without a running controller. It loads the trusted workflow the same way `workflow-check` does and reports the result in its fields.

## Sub-features

- `status-settings` prints `workflowSha`, `workflowDigest`, `models` for the five model stages, and `limits` with the poll interval, concurrency, retry, usage and per-stage budgets.
- `status-disabled` always prints `executionEnabled: false` and `controller.state: "unavailable"`. This release has no controller.
- `status-invalid` still exits 0 when the workflow is missing or invalid. Then `workflow` is `invalid`, `workflowError` carries the error, and `models`, `limits` and `checkpoints` are `null`.
- `status-usage` exits 2 for a missing `--json` or `--repo`, an unknown flag, a bad branch name or `--reload-ref`.

## How to get to it (user POV)

- `node server/cli.ts status --json --repo giuseppecrj/pi-herdr-factorio [--ref <branch>]`

## Driving it with ssh

Preconditions:

- The doctor reports `doctor=ok`.
- A lane exists from `lane-setup.sh <pr-id> <worker-n>` at the commit under test.

- **Run status for main and a branch.** `.pi/skills/verify-factory/scripts/vm.sh .pi/skills/verify-factory/scripts/drive-workflow.sh <pr-id> <worker-n> <branch>`. Each `status` line in `workflow-evidence.txt` shows `exit=0 executionEnabled=false controller="unavailable"`. For main before the owner lands F04a, the line shows `workflow="invalid"`. For a branch with a valid file, it shows `workflow="valid"` and `build_model="openai/gpt-6.1-sol"`. Raw output is in `status-<ref>.json`.
- **Check that no model runs.** The command calls only `gh`. Pi usage on the VM does not change between runs.

## Gotchas

- `status --json` exits 0 even when the workflow is broken. Read `workflow` and `workflowError`, not the exit code.
- `/factory status` in Pi shows the same workflow line as text, but only for `main` of the repository behind `origin`. A lane workspace from `git archive` has no `.git`, so its `/factory status` shows `workflow unavailable: no git remote named origin`. That output is expected.
