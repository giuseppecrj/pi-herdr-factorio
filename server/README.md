# server

`server/` runs the factory on a host: the CLI, the controller loop, stage sandboxes, the egress gateway, the trusted candidate gates, the owner viewer and the VM installer. The rules it applies live in `src/`. `docs/plans/codebase-layout.md` renames this folder to `host/` in L13.

| Path | What it does | Planned owner |
| --- | --- | --- |
| `cli.ts` | Every `node server/cli.ts <verb>` command. `docs/operations/factory-cli.md` documents the verbs. | `host/cli` |
| `cli/` | Host collectors for the read verbs: `owner-feed.ts` and `measurement.ts` read controller state and stage receipts for the views in `src/views/feed.ts` and `src/views/explain.ts`, and `replay.ts` checks installed asset bundles. Verb dispatch stays in `cli.ts`. | `host/cli` |
| `controller/` | Host ports, private state and the serve loop. Its README routes to each owner. | `host/controller` |
| `sandbox/executor.ts` | `sandboxExecutor`, the controller's stage executor. It runs the preflight and scope reconcile, prepares checkouts and skills, cleans up builds and assembles each stage execution. | `host/sandbox` |
| `sandbox/run-stage.ts` | Drives one stage attempt: Pi sessions, the gateway gate, fallback, the cleanup window and the final receipt. Settlement waits for all owned work. | `host/sandbox` |
| `sandbox/launch.ts` | The real stage host: a private stage directory, the bwrap scope, the Pi command and stderr capture. | `host/sandbox` |
| `sandbox/specify.ts`, `sandbox/review.ts` | The bounded specify session sequence and the review seat sequence, each with an aggregate receipt. | `host/sandbox` |
| `sandbox/visible-tests.ts` | Runs a candidate's visible tests in a model-free sandbox. `VISIBLE_LIMIT_MS` is read by the replay driver. | `host/sandbox` |
| `sandbox/receipts.ts` | Durable stage-directory writes and bounded readers of receipts, usage, outputs, charges and patches. | `host/sandbox` |
| `sandbox/` | Gateway, isolation, route tables, metering, the bundle manifest and `assets/` copied into the bundle. `docs/operations/sandbox.md` explains the boundary. | `host/gateway`, `host/isolation`, `host/bundle`, `host/sandbox` |
| `gates.ts`, `gates/` | Materializes a candidate over the gate tree and runs the trusted checks. | `host/gates` |
| `viewer.ts`, `viewer/` | The owner dashboard. `viewer/design/tokens.css` is generated; see `scripts/README.md`. | `host/viewer` |
| `provision.sh`, `install-exe-dev.sh`, `factory.service` | VM provisioning, the one-command installer and the systemd unit. `docs/operations/install-exe-dev.md` is the runbook. | `host/install` |

`scripts/layout-baseline.json` gives every file here an owner and its required review seats. The `owner` column above summarizes it.

## Change a path a reader depends on

Several files find others by a fixed path or depth rather than an import. Examples are `provision.sh` resolving the checkout one level up, `controller/checkers.ts` byte-comparing the gate tree's `server/gates.ts` with its own copy (`sameMaterializer`), and `factory.service` starting `server/cli.ts`. The `readers` and `shell` sections of `scripts/layout-baseline.json` list each one. If you move or rename a file, update every reader and its entry in the same PR, then run `npm run check:layout`.

## Add a file

Add it beside the subsystem that owns it and classify it under `classification.files` in `scripts/layout-baseline.json`. Add a shell script's path tokens under `shell.inventory`. Put its tests under `test/`, and sandbox cases under `test/sandbox/` (see `test/README.md`).

## Add a CLI verb or a controller feature

- A new CLI verb is a new arm in the dispatch table in `server/cli.ts`, documented in `docs/operations/factory-cli.md`. Do not split `server/cli.ts` before L13, which moves it to `host/cli/` in one step.
- A new controller feature puts its decision rules in `src/` and its host side in the matching owner under `server/controller/`. Keep mutable jobs and caches with the factory that owns them; `serve-loop.ts` runs the host loop, not another scheduler.
- A new stage execution behavior goes in the `server/sandbox/` owner above that already holds its state. Session driving, the cleanup window and receipt assembly share one attempt's mutable state, so they stay together in `run-stage.ts`. Import the owning file directly; there is no sandbox barrel.
