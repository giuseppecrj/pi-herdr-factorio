# server

`server/` runs the factory on a host: the CLI, the controller loop, stage sandboxes, the egress gateway, the trusted candidate gates, the owner viewer and the VM installer. The rules it applies live in `src/`. `docs/plans/codebase-layout.md` renames this folder to `host/` in L13.

| Path | What it does | Planned owner |
| --- | --- | --- |
| `cli.ts` | Every `node server/cli.ts <verb>` command. `docs/operations/factory-cli.md` documents the verbs. | `host/cli` |
| `cli/` | Host collectors for the read verbs: `owner-feed.ts` and `measurement.ts` read controller state and stage receipts for the views in `src/views/feed.ts` and `src/views/explain.ts`, and `replay.ts` checks installed asset bundles. Verb dispatch stays in `cli.ts`. | `host/cli` |
| `controller.ts` | The serve loop, controller lock, run files, outbox, measurement and validation sweep. | `host/controller` |
| `controller/state.ts` | Reads the controller's status file, lock and stored verdicts without taking the lock. | `host/controller` |
| `sandbox.ts` | Runs one stage in a bwrap sandbox and settles its receipt. | `host/sandbox` |
| `sandbox/receipts.ts` | Reads a stage receipt back, bounded in size. | `host/sandbox` |
| `sandbox/` | Gateway, isolation, route tables, metering, the bundle manifest and `assets/` copied into the bundle. `docs/operations/sandbox.md` explains the boundary. | `host/gateway`, `host/isolation`, `host/bundle`, `host/sandbox` |
| `gates.ts`, `gates/` | Materializes a candidate over the gate tree and runs the trusted checks. | `host/gates` |
| `viewer.ts`, `viewer/` | The owner dashboard. `viewer/design/tokens.css` is generated; see `scripts/README.md`. | `host/viewer` |
| `provision.sh`, `install-exe-dev.sh`, `factory.service` | VM provisioning, the one-command installer and the systemd unit. `docs/operations/install-exe-dev.md` is the runbook. | `host/install` |

`scripts/layout-baseline.json` gives every file here an owner and its required review seats. The `owner` column above summarizes it.

## Change a path a reader depends on

Several files find others by a fixed path or depth rather than an import. Examples are `provision.sh` resolving the checkout one level up, `controller.ts` byte-comparing the gate tree's `server/gates.ts` with its own copy (`sameMaterializer`), and `factory.service` starting `server/cli.ts`. The `readers` and `shell` sections of `scripts/layout-baseline.json` list each one. If you move or rename a file, update every reader and its entry in the same PR, then run `npm run check:layout`.

## Add a file

Add it beside the subsystem that owns it and classify it under `classification.files` in `scripts/layout-baseline.json`. Add a shell script's path tokens under `shell.inventory`. Put its tests under `test/`, and sandbox cases under `test/sandbox/` (see `test/README.md`).

## Add a CLI verb or a controller feature

- A new CLI verb is a new arm in the dispatch table in `server/cli.ts`, documented in `docs/operations/factory-cli.md`. Do not split `server/cli.ts` before L13, which moves it to `host/cli/` in one step.
- A new controller feature puts its decision rules in `src/` and its host side (files, locks, processes and the serve loop) in `server/controller.ts`, beside the code it extends. L11 splits that file into `server/controller/`.
