# admit

`node server/cli.ts admit` decides whether one issue's latest `factory:ready` label event is admitted, and prints a receipt. It reads GitHub through the integration, writes at most one admission record under the lane's state directory, and never starts a model. The command reference is the `admit` section of `docs/operations/factory-cli.md`.

## Sub-features

- `admit-receipt`: a receipt with issue URL, event ID, actor, actor permission, snapshot digest and source, base SHA and decision.
- `admit-actor`: the decision follows the label actor's permission, not the issue author.
- `admit-snapshot`: the digest is the label-time title and body. An edit after the label is proved from GitHub's edit history or refused as `ambiguous_snapshot`.
- `admit-switches`: the repository variable `FACTORY_ENABLED` and the file `<state-dir>/disabled`.
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
- **Expected today.** The integration cannot read `FACTORY_ENABLED`, so every receipt has `decision` `refused` and its first reason is `repo_switch_unavailable` with `failure.status` 403. The receipt still shows the event, actor and snapshot the admission would bind, and a second reason when the issue itself fails a check. Nothing is recorded, so `duplicate_event` cannot be observed live until the switch is readable.
- **Local switch.** `touch /home/exedev/factory-verification/<pr-id>-w<n>/state/disabled` in a script sent with `vm.sh`, then rerun. The only reason is `locally_disabled`, and the receipt has no event or snapshot fields set.
- **Snapshot binding.** Compute the expected digest locally as the sha256 hex of `JSON.stringify([title, body])` with the label-time title and body, and compare it with `snapshotDigest`.

Results observed on 2026-10-29 at `ed6e61d`, all exit 1:

| Issue | Reasons | `snapshotSource` |
| --- | --- | --- |
| #14, labeled by `giuseppecrj`, never edited | `repo_switch_unavailable` | `unedited` |
| #15, edited twice after the label | `repo_switch_unavailable` | `edit_history`, the digest of body version 1 |
| #16, edited before the label | `repo_switch_unavailable` | `unedited` |
| #17, labeled by the integration bot | `repo_switch_unavailable`, `unauthorized` with permission `none` | `null` |
| #13, closed | `repo_switch_unavailable`, `issue_closed` | `null` |
| #4, a pull request | `repo_switch_unavailable`, `pull_request` | `null` |

## Gotchas

- `admit` takes no `--ref`. It always loads `WORKFLOW.md` from `main`, and `baseSha` is `main`'s SHA at that moment.
- The state directory must exist. `lane-setup.sh` creates `<lane>/state`. A missing directory is refused as `state_unavailable` before any `gh` call.
- A refusal is exit 1, not a script failure. Exit 2 is a usage error.
- Never print an issue title or body in evidence. The receipt carries only a digest. The snapshot text is in the admission record under the state directory, with mode 0600, only after an admission.
- A label applied by the integration bot is always refused: the bot's permission reads as `none`.
- Lane 2 of the plan needs a real account with triage but no write access. Without one, report it BLOCKED.
