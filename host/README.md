# host

`host/` runs the factory on a host. Factory rules and portable data live in `src/`. Import each implementation directly, not through a barrel.

| Folder | Owner |
| --- | --- |
| `cli/` | `index.ts` is the only command entry. Verb handlers own serve, owner-feed, metrics, replay, cadence and measurement. `platform.ts` holds shared CLI contracts and the process runtime. See `docs/operations/factory-cli.md`. |
| `controller/` | Host ports, private state, checkouts, publication pumps and the serve loop. Its README routes to each owner. |
| `sandbox/` | Stage execution, session driving, visible tests, review/specify sequences and receipts. Mutable attempt state stays with its runner. |
| `isolation/` | Bubblewrap arguments, seccomp, preflight and user scopes. |
| `gateway/` | The egress gateway, child entry `main.ts`, process client, routes, policy, control, credentials, audit and metering. |
| `gates/` | `gates.ts` composes candidate checks and CLI dispatch; `materialize.ts` owns tree overlays and identity; `manifest.ts` validates dependencies and test selection; `runner.ts` owns execution and dependency caching; `base.ts` runs private base/diagnosis checks beside `draft-reporter.mjs`. |
| `viewer/` | `server.ts` serves the owner dashboard and run viewer. Generated tokens, styles and web-app assets stay beside it. See `DESIGN.md`. |
| `bundle/` | `manifest.ts` compares source assets with installed content. `assets/` ships into the same bundle-relative names as before relocation. |
| `install/` | The exe.dev installer, provisioner and service unit. See `docs/operations/install-exe-dev.md`. |

## Change a path

`scripts/layout-baseline.json` inventories imports, executable path readers, shell tokens, ownership and required review seats. Update those entries and `docs/history/path-map.md` with every move, then run `npm run check:layout` and `npm run check`.

CLI source roots resolve two parents up from `cli/platform.ts`; the provisioner resolves two parents up from `install/`. Controller roots still resolve two parents up. Diagnosis compares every executable gate implementation member, including the draft reporter, before trusting its materialization.

## Add behavior

A CLI verb adds dispatch in `cli/index.ts`, implementation beside its closest handler and documentation in the CLI reference. Controller decision rules belong in `src/`; host effects belong under their matching owner here. Keep mutable jobs and caches with the function that owns them. A new file needs classification and inherited review seats in the layout baseline. Tests stay under `test/` until L14 mirrors them.
