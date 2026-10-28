# workflow-check

`node server/cli.ts workflow-check --json` loads `.github/factory/WORKFLOW.md` from a branch of the repository on GitHub and prints the parsed snapshot or the error. It resolves the branch to a SHA first, then fetches the file at that SHA. It never reads the lane workspace's copy.

## Sub-features

- `check-valid` exits 0 with `valid: true`, the SHA, the sha256 digest of the fetched bytes and the parsed config.
- `check-missing` exits 1 with `error.kind` `missing_workflow_file` when the branch has no workflow. Main is in this state until the owner lands F04a.
- `check-invalid` exits 1 with `error.kind` `workflow_validation_error` and `error.field` naming the offending YAML path, or with `workflow_parse_error`, `workflow_front_matter_missing` or `workflow_front_matter_not_a_map`.
- `check-unresolved` exits 1 with `error.kind` `source_unavailable` and `sha: null` when the branch does not resolve or `gh` fails.
- `check-verification` reports `verification: true` for any `--ref` other than `main`.
- `check-reload` with `--reload-ref <branch>` reports in `reload.inForce` the snapshot that stays in force. An invalid reload keeps the `--ref` snapshot.
- `check-usage` exits 2 and prints usage to stderr for a missing `--json` or `--repo`, an unknown flag or a bad branch name.

## How to get to it (user POV)

- `node server/cli.ts workflow-check --json --repo giuseppecrj/pi-herdr-factorio [--ref <branch>] [--reload-ref <branch>]`

## Driving it with ssh

Preconditions:

- The doctor reports `doctor=ok`.
- A lane exists from `lane-setup.sh <pr-id> <worker-n>` at the commit under test.
- Any non-main branch you name is pushed to GitHub. The command reads GitHub, not the lane.

- **Check main and a branch.** `.pi/skills/verify-factory/scripts/vm.sh .pi/skills/verify-factory/scripts/drive-workflow.sh <pr-id> <worker-n> <branch>`. The script exits 0 when every `workflow-check` exits 0 or 1 and every `status` exits 0. `workflow-evidence.txt` has one `command=... exit=... valid=... sha=... error_kind=...` line per call. Before the owner lands F04a, main gives `exit=1 valid=false error_kind="missing_workflow_file"`. A branch with a valid file gives `exit=0 valid=true verification=true`. Raw output is in `workflow-check-<ref>.json`, with `/` in the ref replaced by `_`.
- **Confirm the SHA.** Compare the `sha` field with `GH_HOST=github.int.exe.xyz gh api repos/giuseppecrj/pi-herdr-factorio/git/ref/heads/<branch> --jq .object.sha`. They are equal.
- **Check a reload.** In the lane workspace, run `node server/cli.ts workflow-check --json --repo giuseppecrj/pi-herdr-factorio --ref <valid-branch> --reload-ref <invalid-branch>`. It exits 1. `reload.outcome` is `kept`, `reload.error` names the problem, and `reload.inForce.digest` equals the top-level `digest`.

## Gotchas

- Export `GH_HOST=github.int.exe.xyz` on the VM. The drive script does it.
- The lane workspace's own `.github/factory/WORKFLOW.md` has no effect on the output. To test a different workflow, push it to a fixture branch and pass `--ref`. Creating that branch needs the fixture grant.
- Exit 1 is a result, not a script failure. Exit 2 means the command line is wrong.
- Node 26 strips types by default, so `--experimental-strip-types` is not needed.
