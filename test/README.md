# test

`npm test` runs `test/src/**/*.test.ts` and `test/host/**/*.test.ts`. The recursive globs are quoted so Node, rather than the shell, expands them at every depth. `npm run test:integration` runs `test/integration/*.test.ts` separately. Both keep concurrency 1. The trusted gate uses those same three globs from `.github/factory/gates/gates.json` at concurrency 2. `npm run check:layout` checks their parity and rejects executable tests outside discovery.

| Path | What it holds |
| --- | --- |
| `src/<group>/*.test.ts` | Tests for the matching `src/<group>/` owner. The extension's domain-view tests live in `src/views/`. |
| `host/<group>/*.test.ts` | Tests for the matching host subsystem. Repository guard and package tests live in `host/gates/`. |
| `src/controller/orchestrator-*.test.ts` | The original orchestrator behavior groups, split at top-level `describe` boundaries. `orchestrator-fixtures.ts` owns their shared fake world and temporary-state cleanup; it registers no tests. |
| `host/sandbox/` | Directly discovered sandbox tests, plus non-test support. There is no aggregator. |
| `host/gateway/` | Gateway audit, credentials, policy, routes and transport tests, plus their fixtures. Sandbox tests reuse the gateway fixtures. |
| `integration/` | Slow tests that drive real scripts, such as the replay driver. |
| `fixtures/`, `sandbox/fixtures/` | Existing data roots. Captures, corpora, patches and snapshots stay where their readers expect them. Nothing here runs on its own. |
| `acceptance/` | Published held-out suites. Builders never read or edit them. Static checks and visible discovery exclude this folder. |
| `helpers.ts`, `fake-ticket-adapter.ts`, `ledger-git.ts`, `ledger-real-git.ts` | Shared non-test helpers. |

## Add a test

- Name it `test/src/<group>/<name>.test.ts` or `test/host/<group>/<name>.test.ts`. Deeper owner subfolders are discovered too. Slow script tests belong in `test/integration/<name>.test.ts`.
- Tests for `extension/` belong in `test/src/views/`. Repository-tool checks for `scripts/` belong in `test/host/gates/`; slow script and `.pi/skills/` driver tests belong in `test/integration/`.
- Keep support files as ordinary `.ts` files without test registrations. Do not import a directly discovered test from another test. A retained `.cases.ts` must still have exactly one runtime importer and one discovered owner.
- Create temporary files under `os.tmpdir()`. The gate runs the tree read-only.
- New candidate tests run separately through `candidate_tests`. Once landed, a nested test joins the trusted baseline without a manifest edit.

## Frozen acceptance suites: do not edit

Five published suites retain their original-revision imports:

- `acceptance/621/checks/exact-fit.test.ts`
- `acceptance/621/checks/oversized.test.ts`
- `acceptance/621/checks/prompt-exact.test.ts`
- `acceptance/645/checks/exact-empty.test.ts`
- `acceptance/645/checks/unavailable.test.ts`

They are historical outputs, not tests that current main runs. Their imports resolve only at the revision that published them.
