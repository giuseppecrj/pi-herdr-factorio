# admit

`node server/cli.ts admit` decides whether one issue's latest `factory:ready` label event is admitted, and prints a receipt. It reads GitHub through the integration, writes at most one admission record under the lane's state directory, and never starts a model. The command reference is the `admit` section of `docs/operations/factory-cli.md`.

## Sub-features

- `admit-receipt`: a receipt with issue URL, event ID, actor, actor permission, snapshot digest and source, base SHA and decision.
- `admit-actor`: the decision follows the label actor's permission, not the issue author.
- `admit-snapshot`: the digest is the label-time title and body. An edit after the label is proved from GitHub's edit history or refused as `ambiguous_snapshot`.
- `admit-switches`: the repository label `factory:enabled` and the file `<state-dir>/disabled`.
- `admit-dedup`: a second admission of the same event is refused as `duplicate_event`.
- `admit-pagination`: the label event is found across timeline pages.

## How to get to it (user POV)

- `node server/cli.ts admit --json --repo giuseppecrj/pi-herdr-factorio --issue <n> --state-dir <dir>`

## Driving it with ssh

Preconditions:

- The doctor reports `doctor=ok`, and `lane-setup.sh <pr-id> <worker-n>` printed `lane=... sha=...`.
- One fixture issue per lane, titled with the PR ID and worker number. Creating, labeling and editing it needs the fixture grant.
- Run `vm-snapshot.sh` before the first lane and after the last one, as the skill describes.

- **Admit issues.** `.pi/skills/verify-factory/scripts/vm.sh .pi/skills/verify-factory/scripts/drive-admit.sh <pr-id> <worker-n> <issue>...`. Each issue gets `admission-<issue>.json` under `/tmp/swarm-<pr-id>/worker-<n>/`, and `admit-evidence.txt` has one line per issue with its exit code, wall time in milliseconds, decision, reasons, event ID, actor, permission, snapshot source and digest, and base SHA. The script exits 0 when every `admit` exited 0 or 1.
- **Repository switch.** The switch is on while a repository label named exactly `factory:enabled` exists. Check it with `gh api repos/giuseppecrj/pi-herdr-factorio/labels/factory%3Aenabled`: HTTP 404 means off. Turning it off or on means deleting or creating that label. That is a fixture-grant mutation, made as the owner from the workstation `gh` without `GH_HOST`, or through the integration. Record which one you used. With the label absent, the first reason is `repo_switch_off`. When the rest of the evaluation passes, the receipt still shows the event, actor and snapshot the admission would bind. When it stops earlier, for example because `WORKFLOW.md` does not load, the second reason names that step and the later fields are `null`. A failed read, such as a 403 or a network error, gives `repo_switch_unavailable` with `failure`. Nothing is recorded on any refusal.
- **One switch lane at a time.** The label is shared repository state, so every lane reads the same switch. Run lanes that delete or create `factory:enabled` one at a time, never in parallel with any other `admit` lane. Restore the label when they finish.
- **Local switch.** `touch /home/exedev/factory-verification/<pr-id>-w<n>/state/disabled` in a script sent with `vm.sh`, then rerun. The only reason is `locally_disabled`, and the receipt has no event or snapshot fields set.
- **Snapshot binding.** Compute the expected digest locally as the sha256 hex of `JSON.stringify([title, body])` with the label-time title and body, and compare it with `snapshotDigest`.

Results observed on 2026-10-29 at `16b0f04`, on fixture #21 labeled by `giuseppecrj` (event `34539997461`), run in this order on one lane:

| Case | Exit | Reasons | Receipt |
| --- | --- | --- | --- |
| Label absent, flag absent | 1 | `repo_switch_off` | event, actor, `admin`, `unedited` snapshot and base SHA set; nothing recorded |
| Label present, flag absent | 0 | none | `admitted`, every field set; one record with mode 0600 |
| Label present, flag present | 1 | `locally_disabled` | no event or snapshot fields; no `gh` call |
| Label present, flag absent, same event again | 1 | `duplicate_event` | same event and digest; the record is unchanged |

Earlier, under the variable switch at `ed6e61d`: #15, edited twice after the label, bound the `edit_history` digest of body version 1. #17, labeled by the integration bot, was `unauthorized` with permission `none`. #13 was `issue_closed` and #4 was `pull_request`.

## Gotchas

- `admit` takes no `--ref`. It always loads `WORKFLOW.md` from `main`, and `baseSha` is `main`'s SHA at that moment.
- The state directory must exist as a real directory owned by `exedev` and not writable by group or others. `lane-setup.sh` creates `<lane>/state` with `mkdir -p`, which gives mode 0755 under the default umask. A missing, symlinked, foreign-owned or group- or world-writable directory is refused as `state_unavailable` before any `gh` call.
- Any entry named `<state>/disabled`, even a dangling symlink, is the local switch. Remove it with `rm -f`, not by fixing its target.
- A refusal is exit 1, not a script failure. Exit 2 is a usage error.
- Never print an issue title or body in evidence. The receipt carries only a digest. The snapshot text is in the admission record under the state directory, with mode 0600, only after an admission.
- A label applied by the integration bot is always refused: the bot's permission reads as `none`.
- Lane 2 of the plan needs a real account with triage but no write access. Without one, report it BLOCKED.
