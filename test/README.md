# test

`npm test` runs `test/*.test.ts`. `npm run test:integration` runs `test/integration/*.test.ts`. The trusted gate discovers the same files through the `testGlobs` in `.github/factory/gates/gates.json`, and `npm run check:layout` fails if the two sets differ. A test file anywhere else never runs, so the guard fails any test outside `test/*.test.ts` and `test/integration/*.test.ts`. The only exceptions are the held-out suites under `test/acceptance/**` and the payloads under `test/fixtures/**`.

| Path | What it holds |
| --- | --- |
| `<name>.test.ts` | Tests for `src/<name>.ts` or `server/<name>.ts`, plus cross-module tests such as `pipeline.test.ts`. |
| `sandbox.test.ts`, `sandbox/*.cases.ts` | Sandbox and gateway cases. `sandbox.test.ts` imports each `.cases.ts` file once. Other files in `sandbox/` are helpers. |
| `integration/` | Slow tests that drive real scripts, such as the replay driver. |
| `fixtures/` | Data that tests read: corpora, patches, captures and snapshots. Nothing here runs on its own. |
| `acceptance/` | Held-out suites that the factory publishes. Builders never read or edit them. Static checks and the layout guard exclude this folder. |
| `helpers.ts`, `fake-ticket-adapter.ts`, `ledger-git.ts` | Shared helpers. They hold no tests. |

## Add a test

- Name it `test/<name>.test.ts`, or `test/integration/<name>.test.ts` if it is slow.
- Add a sandbox case file as `test/sandbox/<name>.cases.ts` and add one `import "./sandbox/<name>.cases.ts";` line to `sandbox.test.ts`. A cases file that no discovered test imports, or that two discovered tests import, fails `npm run check:layout`.
- Create temporary files under `os.tmpdir()`. The gate runs the tree read-only.

## Frozen acceptance suites: do not edit

Five published suites import source files by the paths they had when they were written:

- `acceptance/621/checks/exact-fit.test.ts`
- `acceptance/621/checks/oversized.test.ts`
- `acceptance/621/checks/prompt-exact.test.ts`
- `acceptance/645/checks/exact-empty.test.ts`
- `acceptance/645/checks/unavailable.test.ts`

They are historical outputs, not tests that current main runs. Do not edit them, even when the source files they import move. Their imports resolve only at the revision that published them.
