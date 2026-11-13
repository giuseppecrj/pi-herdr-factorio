# VM doctor

The doctor shows that the explicitly selected `FACTORY_VM` is reachable, reports tool versions, and can read the repository through that target's GitHub host from `targets.env`. There is no default target. `nubl-factory` is held production; routine access is read-only. `pi-factorio` was retired and deleted on 2026-11-13 (#734), with its state archived.

## Sub-features

- `doctor-ssh` connects as `exedev` through the headless agent socket.
- `doctor-versions` reports node, Pi, Herdr and `gh` versions.
- `doctor-gh-scope` reads the repository through the integration.

## How to get to it (user POV)

- `SSH_AUTH_SOCK=$HOME/.ssh/headless-agent.sock ssh <target ssh destination>`, from `../targets.env`

## Driving it with ssh

Preconditions:

- The headless agent socket exists at `$HOME/.ssh/headless-agent.sock`.
- Set `FACTORY_VM=nubl-factory` for a production read. Follow [the target restrictions](../SKILL.md#target).

- **Run doctor.** `.pi/skills/verify-factory/scripts/vm.sh .pi/skills/verify-factory/scripts/doctor.sh`. Exit code 0. Output starts with `target=<name>` and has `node=v26.`, `pi=1.4.0`, `herdr=herdr 0.9.5`, `repo=nublai/pi-herdr-factorio default=main`, and `doctor=ok`.
- **Reconcile versions.** Compare with `PI_VERSION` and `HERDR_VERSION` in `host/install/provision.sh`. They match.

## Gotchas

- `PATH` lacks mise shims in a non-interactive ssh shell. The scripts set it. A hand-typed command may report `node: command not found`.
- An unknown or unconfigured target exits 2 before any ssh connection. `factorio` is unconfigured until the exmach VM exists.
- `gh api user` fails by design. Use repository-scoped calls.
- A provisioning change makes the expected versions move. Update this file with `host/install/provision.sh`.
