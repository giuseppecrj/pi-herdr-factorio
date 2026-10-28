# tick --once

**Not implemented yet.** The plan introduces this CLI command in a later PR. Do not report it as verified. The PR that adds it fills in this file.

## Sub-features

- `tick-once-todo` to be listed by the introducing PR.

## How to get to it (user POV)

- `node --experimental-strip-types server/cli.ts tick --once`

## Driving it with ssh

Preconditions:

- To be set by the introducing PR. A lane from `lane-setup.sh` is the baseline.

- **Planned check.** Runs one poll tick and exits. Read the introducing PR for the exact output. Add the exact command, the evidence file and the expected exit code.

## Gotchas

- Until the command exists, running it fails. Report that as "not implemented", never as a pass.
