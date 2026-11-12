# Private build patches (F07a)

A passing accept stores its held-out suite and claims build on the same run. Build produces a private patch, not a branch, PR, CI verdict or publication. Reserve specify + accept + the 400,000-token build allowance before starting each model run (about 540,000 tokens total: specify about 40,000, accept 100,000, build 400,000), against the task's remaining cap. Do not narrow stage allowances to fit a lane. Use only the model authorized by the task.

## Sub-features

- `build-flow`: scoped ticks specify, accept, and qualify the suite on the pinned base before claiming build. The claimed build keeps its slot until its later execution ends. A passing build advances to slot-free validate. Further ticks publish and wait for CI. Follow the recorded phase, not fixed tick counts or marker numbers. See `validation.md`.
- `build-workspace`: an independent pinned pristine base and a fresh attempt workspace, including on replay. Neither the acceptance store nor prior sessions are mounted. The build workspace/agent trees and visible-test tree are removed after use; private stores and receipts remain.
- `build-tools`: coding tools only, with `subagent` and the bundled Herdr extension added exactly when the validated contract names more than eight files. Tiny contracts do not fan out. No GitHub route exists.
- `build-collection`: deterministic raw-byte patch digest, sorted changed paths, modes, deletions, binaries and safe links. Forbidden paths stay private. Symlinked dependency caches and top-level directory replacements are refused. Empty patches fail; untrusted prose cannot enable a no-change outcome.
- `build-visible`: a separate model-free sandbox applies the exact patch and rechecks its digest. npm script references come from the base manifest, with lifecycle scripts suppressed. Deleted base test files are restored; modified and added tests remain candidate input. The receipt records the actual command and script/test-input changes. A measured nonzero test exit never passes.
- `build-receipt`: mode 0600 under 0700 `patches/<runId>/`; the receipt binds run, base SHA, contract digest, acceptance digest and patch digest. Command records are `builder-reported`, capped with an omitted count, never controller validation. Test output is private and bounded.
- `build-summary`: one `factory-build` key, patch prefix, bounded path list with omitted count, controller test result and script-change disclosures. No code, suite digest, commands or output.
- `build-recovery`: stored patch digests are checked, matching bound `tests.json` is reused and missing tests rerun without a builder. Preflight failure waits. Infrastructure failures are typed `visible_tests_unavailable` and retry under the attempt cap without claiming tests failed.
- `build-disk`: post-stage 1 GiB / 100,000-entry checks include caches and empty directories, failing as `build_disk_limit`. This is not an instantaneous filesystem quota. Patch and receipt limits are 64 MiB and 8 MiB, respectively.
- `build-isolation`: the shipped canary probe and its self-test pass, without model requests. The probe covers the builder launch shape, not the visible-test sandbox or arbitrary transformed oracle copies.

## How to get to it (user POV)

A qualified private acceptance suite permits build. Follow the run's patch summary on GitHub. Build produces no public branch or PR. Read `../SKILL.md` for grants and target restrictions before a drive.

## Driving it with the named tooling

1. Follow the doctor, snapshot and lane setup in `SKILL.md`. Commit first. Re-provision the bundle if bundled assets or skill text changed.
2. Create and owner-label one authorized fixture. Never touch `factory:enabled`. Scope every command to that issue.
3. Run `vm.sh drive-stage.sh <pr-id> <worker-n> <issue>` for specify and accept. Continue scoped ticks through base qualification. Verify the held-out store and qualification privately, then require build claimed.
4. Run the same scoped command for build. Read build's stage receipt, private patch receipt and bound test receipt. Record tokens, requests and wall time per stage. Count each root receipt once.
5. Through repository-scoped `gh`, inspect the build summary and validate transition marker. Require a measured visible pass and the base's resolved script in `tests.json`; the builder's prose or command reports do not prove it.
6. On the VM run `node --test docs/prototypes/build-isolation/self-test.mjs`, then `XDG_RUNTIME_DIR=/run/user/1000 node docs/prototypes/build-isolation/probe.ts <state> <runId> <attempt>`. After cleanup the probe reconstructs a disposable workspace from the pinned base and stored patch, uses the real build mount shape, and removes the reconstruction afterward. Export only redacted results.
7. Close and confirm every fixture. Preserve receipts/evidence, snapshot again, check lane-owned scopes/processes and run lane cleanup.

## Gotchas

Legacy drivers and probes keep their current paths until L02. Source-checked instructions are not native proof. Never lower a stage allowance to fit a lane cap.

Deterministic recovery, hostile patches, exact storage limits, command provenance, delegation and sandbox-result regressions also run through `test/build.test.ts`, `test/orchestrator.test.ts`, `test/specify.test.ts` and `test/sandbox/runner.cases.ts`.
