# Factory status command

`/factory status` prints the package name, version and the stage table. It needs no daemon.

## Sub-features

- `status-text` prints `pi-herdr-factorio <version>` and the stage table. Its columns are `stage`, `runs in`, `model access` and `github access`. `admit` and `land` run in the `controller`. Every model stage runs in the `sandbox` with GitHub access `none`.
- `status-attention` appends the shared VM-local attention snapshot when `FACTORY_STATE_DIR` names owned private controller state. Without it, attention says `state_not_configured`, not an empty success. See [status JSON](status-json.md) for the six groups, unknown ages, private-evidence gaps, and duplicate suppression.
- `status-usage` prints `Usage: /factory status | /factory run <issue>` for an unsupported subcommand or malformed run request. `/factory run <issue>` is read-only admission, not dispatch.

## How to get to it (user POV)

- Type `/factory status` in a Pi session with the extension loaded.

## Driving it with node

Preconditions:

- A lane exists from `lane-setup.sh <pr-id> <worker-n>`.

- **Run status.** `.pi/skills/verify-factory/scripts/vm.sh .pi/skills/verify-factory/scripts/drive-status.sh <pr-id> <worker-n>`. Exit code 0. The first line of `status.txt` is `pi-herdr-factorio <version>` and matches `package.json`. The stage table follows.
- **Check the unknown subcommand.** On the VM in the lane workspace, run `node --experimental-strip-types .status-driver.ts bogus`. The output is `Usage: /factory status | /factory run <issue>`.

## Compare attention on the VM

After the drive copies `.status-driver.ts` into the lane checkout, run there with the same `STATE` used for CLI status:

```bash
FACTORY_STATE_DIR="$STATE" node --experimental-strip-types .status-driver.ts status
```

Require the same six group counts and issue/PR membership as CLI `attention.groups`, with `spec_review` not enabled and unknown ages preserved. The extension still prints its separate controller-unavailable/execution-disabled lines; local attention does not imply a daemon is running. Lane setup supplies a Git origin. Outside that setup, a checkout without origin cannot identify its repository.

Capture tested head/tree, state provenance, command, output, timestamps, zero model requests, and unchanged private state. Saved synthetic state and fake transport prove only registered-handler composition. Native VM attention remains a separate lane with real prerequisites. This source-backed recipe was not driven in the F09a docs round. No persistent process is started; fixture cleanup belongs to the fixture owner.

## Gotchas

- `pi -p "/factory status"` does not run the command. It sends the text to the model and spends credits. Use the driver.
- The driver registers the extension on a stub Pi. It proves the registered handler and its output, not Pi's TUI rendering.
