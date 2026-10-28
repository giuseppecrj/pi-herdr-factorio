# workflow-check

**Not implemented yet.** The plan introduces this CLI command in F04a. Do not report it as verified. The PR that adds it fills in this file.

## Sub-features

- `workflow-check-todo` to be listed by the introducing PR.

## How to get to it (user POV)

- `node --experimental-strip-types server/cli.ts workflow-check --json`

## Driving it with ssh

Preconditions:

- To be set by the introducing PR. A lane from `lane-setup.sh` is the baseline.

- **Planned check.** Exits 0 with the loaded settings for a valid trusted workflow. A malformed workflow exits nonzero and names the offending field. Add the exact command, the evidence file and the expected exit code.

## Gotchas

- Until the command exists, running it fails. Report that as "not implemented", never as a pass.
