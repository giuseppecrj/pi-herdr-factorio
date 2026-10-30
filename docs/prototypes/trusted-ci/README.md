# Trusted candidate gate evidence

F07b runs main's checks against a candidate without using the candidate's workflow, scripts, test deletions, or check configuration. The dispatcher supplies an exact candidate SHA. The host writes the receipt from process results outside the candidate mounts.

## Fixture proof

All 20 fixtures matched their expected result locally and on GitHub's Docker runner. [The hosted run](https://github.com/giuseppecrj/pi-herdr-factorio/actions/runs/41104183215) is red because its bad-candidate jobs must fail. The known-good, registry-dependency, and contract-named replacement jobs are green. Each job uploaded its receipt, including failing jobs.

The fixture gate revision is `b82ea6584676611334544f05c34457d36223c208`. [proof.json](proof.json) records every candidate SHA, local and hosted exit codes, durations, replacement authorization, dependency changes, and job URL. `collect.mjs` checked those identities against the prepared fixture list and the actual hosted conclusions. The later production main-ref guard does not change the gate implementation or fixture patches.

| Fixture | Local | Hosted | Rejecting result or positive proof |
|---|---|---|---|
| known-good | passed | passed | Main tests, new sentinel test, read-only mounts, absent credentials |
| wrong-behavior | failed | failed | `main_tests` |
| noop-scripts | failed | failed | `main_tests` despite candidate scripts that return success |
| deleted-regression | failed | failed | Preserved `main_tests` |
| weakened-typecheck | failed | failed | Trusted `typecheck` |
| weakened-lint | failed | failed | Trusted `lint` and `format` |
| weakened-format | failed | failed | Trusted `format` after nested configuration removal |
| assert-monkeypatch | failed | failed | Frozen assert exports, `main_tests` |
| exit-import | failed | failed | Guarded process exit, `main_tests` |
| really-exit | failed | failed | Guarded process exit, `main_tests` |
| exit-hook | failed | failed | `main_tests` despite an exit hook that clears the exit code |
| skip | failed | failed | `candidate_tests` rejects skipped work |
| todo | failed | failed | `candidate_tests` rejects todo work |
| only | failed | failed | `candidate_tests` rejects the only diagnostic |
| npmrc | incomplete | incomplete | Refused before dependency installation |
| git-dependency | incomplete | incomplete | Refused before dependency installation |
| named-replacement | passed | passed | Both exact contract-named tests replaced |
| unnamed-replacement | failed | failed | Unnamed main tests preserved |
| new-test-fails | failed | failed | New test failure vetoes passing main tests |
| registry-dependency | passed | passed | `is-number@7.0.0` installed, `newDependency: true` |

The replacement fixture changes the treatment of a trailing empty line in `inlined`. Both `test/specify.test.ts` and `test/orchestrator.test.ts` pin that behavior. The named fixture authorizes both files. The unnamed fixture contains the same patch with no authorization.

The known-good fixture adds a candidate-only export and a new test that imports it. It also verifies that writes to `/g/freeze.mjs` and the candidate source fail, that checkout credentials and the Docker socket are absent, and that the candidate process has no GitHub token or inherited Actions environment. Local receipts identify `local-bwrap`; hosted receipts identify `docker`. Local proof is not Docker proof.

## Final discovery regression

A final focused regression found that new `.cases.ts` files were copied but not executed. This repository uses that convention under `test/sandbox`. Candidate discovery now runs both `.test` and `.cases` additions. The regression was red before the one-expression fix and green afterward.

[The final two-case hosted check](https://github.com/giuseppecrj/pi-herdr-factorio/actions/runs/41111873838) verifies gate revision `b50b4cf05506f38fcc49f0a4edb821f842a28891`. The known-good patch still passes. A new failing `.cases.ts` file fails `candidate_tests` while every preserved check passes, both locally and in Docker. [delta-proof.json](delta-proof.json) records the exact identities and named results. This temporary workflow asserts the expected receipt after running the production CLI, so its green job attests an expected rejection rather than approving the bad candidate. The other fixture scenarios are unchanged.

## Runtime boundary

The Docker image is pinned to `node@sha256:6d2c7d5d074bf72f81ddc252b4fbb5d625bc028eeda49cb4b8c2ff8eda1ee617`. Checks run as UID 1001 with no network or capabilities, a read-only root and repository, and an executable 1 GiB temporary filesystem. The gate tool installation and reporter are read-only. The receipt directory is not mounted. Checkout uses GitHub's ephemeral read-only token with `persist-credentials: false`; that token never enters candidate execution.

The host accepts registry tarball dependencies only, rejects redirects, and verifies SHA-512 before populating an offline npm cache. Installation runs unprivileged with `--ignore-scripts` and no network. Main's compiler, lint plugin, and formatter dependencies remain separate from candidate dependencies. The recorded install-script packages are `@google/genai` and `protobufjs`; neither script runs.

Tree export reads exact Git blobs, not `git archive`, so candidate export attributes cannot omit or rewrite files. The unit test with `src/value.ts export-ignore` failed before that change and passes afterward. The exporter refuses symlinks, submodules, and unsafe paths rather than dereferencing them on the host.

Per-file counts come from a fresh main-on-main run. The fixture baseline contains 1,020 leaf tests across 22 reporting files. A main test can import candidate modules, so freezing built-ins and checking counts are detection guards, not a proof against every possible in-process attack. F08 review and F07c's held-out checks remain necessary.

## Corrections during the build

The first local smoke found that `cpSync` rewrote dependency bin links to host paths. Copies now preserve the original relative symlink bytes. The first hosted fixture round exposed an incomplete replacement fixture, not a replacement-runner defect. It named only one of the two tests that pinned the changed behavior.

Seeded terminal-state defects left some existing tests waiting. Each invocation now has a 60-second test timeout and a 90-second process deadline. The corrected fixture run rejects those patches in under three minutes, rather than waiting about ten minutes for the outer process timeout.

## Performance proof

[The three-pair hosted benchmark](https://github.com/giuseppecrj/pi-herdr-factorio/actions/runs/41109240907) passed. Both commands used the same fixed known-good candidate in the pinned, read-only Docker profile on one runner. [perf.json](perf.json) contains exact identities and raw samples.

The existing command's median was 35.048 seconds. The trusted gate median was 115.404 seconds, including a 47.551-second median dependency installation. Gate time without installation was 66.615 seconds at the median. Every pair stayed below twice its baseline plus 60 seconds, and every gate stayed below ten minutes. Queue time was three seconds. The full three-pair job took 526 seconds. No model call or token was used.

The benchmark gate revision is `c736bb52ac66eca55a25d1a9856252e96ec92b32`. The later `.cases.ts` discovery fix does not change this known-good candidate's test set or execution path.

## Bootstrap boundary

This proof uses a temporary push-triggered copy of the workflow body. The production workflow remains dispatch-only, restricted to `main`, with one read-only `gates` job. The existing required `check` and its workflow are unchanged. No stored secret, model route, write token, privileged cache, or `pull_request_target` is introduced.

Dispatch from protected `main` remains pending until the coordinator merges the bootstrap. F07c must then prove exact-head verdict collection and held-out execution before publication proceeds. F07b does not publish runtime branches, label PRs, or report a required check on the candidate SHA. No independent review or complete program verdict is claimed here. All fixture and prototype branches created for these checks were deleted after their runs finished. Action runs, downloaded receipts, and the canonical PR branch were retained.

## Reproduction commands

The fixture driver runs from the repository root. `generate` creates zero-context patch files for the current gate revision. `prepare` applies them in a private Git index and records immutable candidate SHAs without changing the working tree. `local` invokes the real `server/cli.ts gates` command for every fixture. `scratch` pushes the temporary workflow. Publication and deletion require the operator's grant.

```bash
node docs/prototypes/trusted-ci/fixtures.mjs generate "$GATE_SHA" "$TRAIL"
node docs/prototypes/trusted-ci/fixtures.mjs prepare "$GATE_SHA" "$TRAIL" --publish
node docs/prototypes/trusted-ci/fixtures.mjs local "$GATE_SHA" "$TRAIL"
node docs/prototypes/trusted-ci/fixtures.mjs scratch "$GATE_SHA" "$TRAIL"
```

`scratch --perf` uses only the known-good fixture and runs three baseline and gate pairs on one hosted runner. Both commands test the same exact candidate in the pinned Docker profile. The baseline is the existing `npm run check`; the new command also measures dependency installation and its preserved-test baseline. Image pull and hosted queue time are outside the receipt's elapsed time.
