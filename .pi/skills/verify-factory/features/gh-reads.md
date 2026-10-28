# Repository reads

A user can read the repository, its labels and its issues through `gh` as the exe.dev integration bot, without a personal token.

## Sub-features

- `gh-repo-view` shows name and default branch.
- `gh-labels` lists labels and finds the four factory labels.
- `gh-issues` lists recent issues.

## How to get to it (user POV)

- `GH_HOST=github.int.exe.xyz gh repo view giuseppecrj/pi-herdr-factorio`
- `GH_HOST=github.int.exe.xyz gh label list -R giuseppecrj/pi-herdr-factorio`
- `GH_HOST=github.int.exe.xyz gh issue list -R giuseppecrj/pi-herdr-factorio`

## Driving it with ssh

Preconditions:

- The doctor reports `doctor=ok`.

- **Read repo, labels and issues.** `.pi/skills/verify-factory/scripts/vm.sh .pi/skills/verify-factory/scripts/drive-gh.sh <pr-id> <worker-n>`. Exit code 0 and `missing_labels=none`. Files `repo.json`, `labels.txt`, `issues.json` and `gh-evidence.txt` appear under `/tmp/swarm-<pr-id>/worker-<n>/`.

## Gotchas

- This feature is read-only. Creating issues, labels or comments needs the fixture grant.
- If a factory label is renamed, `drive-gh.sh` reports it missing. Update the label list in the script and in `docs/design.md` together.
