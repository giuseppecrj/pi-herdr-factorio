# Factory status command

`/factory status` prints the package name, version and the stage table. It needs no daemon.

## Sub-features

- `status-text` prints `pi-herdr-factorio <version>` and the stage table. Its columns are `stage`, `runs in`, `model access` and `github access`. `admit` and `land` run in the `controller`. Every model stage runs in the `sandbox` with GitHub access `none`.
- `status-usage` prints `Usage: /factory status | /factory run <issue>` for any other subcommand.

## How to get to it (user POV)

- Type `/factory status` in a Pi session with the extension loaded.

## Driving it with node

Preconditions:

- A lane exists from `lane-setup.sh <pr-id> <worker-n>`.

- **Run status.** `.pi/skills/verify-factory/scripts/vm.sh .pi/skills/verify-factory/scripts/drive-status.sh <pr-id> <worker-n>`. Exit code 0. The first line of `status.txt` is `pi-herdr-factorio <version>` and matches `package.json`. The stage table follows.
- **Check the unknown subcommand.** On the VM in the lane workspace, run `node --experimental-strip-types .status-driver.ts bogus`. The output is `Usage: /factory status | /factory run <issue>`.

## Gotchas

- `pi -p "/factory status"` does not run the command. It sends the text to the model and spends credits. Use the driver.
- The driver registers the extension on a stub Pi. It proves the registered handler and its output, not Pi's TUI rendering.
