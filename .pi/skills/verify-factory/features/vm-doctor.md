# VM doctor

The doctor shows that the `pi-factorio` VM is reachable, has the pinned tools, and can read the repository through the exe.dev GitHub integration.

## Sub-features

- `doctor-ssh` connects as `exedev` through the headless agent socket.
- `doctor-versions` reports node, Pi, Herdr and `gh` versions.
- `doctor-gh-scope` reads the repository through the integration.

## How to get to it (user POV)

- `SSH_AUTH_SOCK=$HOME/.ssh/headless-agent.sock ssh exedev@pi-factorio.exe.xyz`

## Driving it with ssh

Preconditions:

- The headless agent socket exists at `$HOME/.ssh/headless-agent.sock`.

- **Run doctor.** `.pi/skills/verify-factory/scripts/vm.sh .pi/skills/verify-factory/scripts/doctor.sh`. Exit code 0. Output has `node=v22.`, `pi=1.4.0`, `herdr=herdr 0.9.5`, `repo=giuseppecrj/pi-herdr-factorio default=main`, and `doctor=ok`.
- **Reconcile versions.** Compare with `PI_VERSION` and `HERDR_VERSION` in `server/provision.sh`. They match.

## Gotchas

- `PATH` lacks mise shims in a non-interactive ssh shell. The scripts set it. A hand-typed command may report `node: command not found`.
- `gh api user` fails by design. Use repository-scoped calls.
- A provisioning change makes the expected versions move. Update this file with `server/provision.sh`.
