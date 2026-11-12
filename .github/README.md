# .github

This folder holds CI workflows and the trusted factory configuration. Only the owner edits this folder. The factory refuses any candidate patch that touches it (`checkChangedPaths` in `src/trust/policy.ts`), and the controller reads `factory/` only from `main`.

| Path | What it holds |
| --- | --- |
| `workflows/check.yml` | The ordinary `check` job. It runs `npm run check` on every PR and push to `main`, with real sandbox tests enabled. |
| `workflows/ci.yml` | The `candidate gates` workflow. The controller dispatches it on `main` to run the trusted gates against an exact candidate commit, then reports the result. |
| `factory/WORKFLOW.md` | The factory's settings: repository, polling, limits, models and stage guidance. `docs/operations/factory-cli.md` documents each field. |
| `factory/gates/gates.json` | The trusted gate manifest: the check commands and the test globs the gate runs. |
| `factory/gates/scan.ts`, `scan-rules.json` | The runtime-patching scan the gate runs over candidate source. |
| `factory/gates/freeze.mjs`, `reporter.mjs` | The test preload and reporter the gate runs candidate tests with. |

A change to `factory/` or `workflows/ci.yml` takes effect only once it is on `main`, because the controller reads `factory/` from `main` and dispatches `ci.yml` there. `workflows/check.yml` runs from the PR's own copy, so a PR that edits it runs the edited job. Changing a path that this folder names, such as the gate's source roots or the CLI entry in `ci.yml`, needs an owner edit in the same PR. `docs/plans/later/codebase-layout.md` lists each one.
