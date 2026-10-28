# serve

**Not implemented yet.** The plan introduces this CLI command in a later PR. Do not report it as verified. The PR that adds it fills in this file.

## Sub-features

- `serve-todo` to be listed by the introducing PR.

## How to get to it (user POV)

- `node --experimental-strip-types server/cli.ts serve --state-dir "$STATE" --issue "$ISSUE"`

## Driving it with ssh

Preconditions:

- To be set by the introducing PR. A lane from `lane-setup.sh` is the baseline.

- **Planned check.** Logs a structured `event=controller_ready` line. Stop on a not-yet-implemented stage. Add the exact command, the evidence file and the expected exit code.

## Gotchas

- Until the command exists, running it fails. Report that as "not implemented", never as a pass.
