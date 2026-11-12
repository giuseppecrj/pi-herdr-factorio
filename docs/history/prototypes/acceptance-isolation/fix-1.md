# F06b fix round 1 verification

2026-10-30, PR #462. Preserved local commit `e6e5b01`. Runtime/storage fixes are in `ced3440`; the final detector is in `8f8ac13`. Later changes are verification documentation and a more precise wrong-Git-type control, not runtime code.

## Local regressions

`npm run check`: three passing runs, **957/957** each (typecheck, lint, format and tests). The final one is the checked-push gate. One additional full run hit the previously reported, unchanged real-Pi wrapper-test flake (`GET !== POST`): **956/957**. Its failure is preserved in `check-flaky.txt`; the complete rerun passed without changing assertions or the wrapper test. Red output is retained in `pi-herdr-factorio-trails/F06b/fix-1/red.txt`, including reruns of the final regressions against an archive of `e6e5b01` with unchanged production code.

| Item | Verification |
| --- | --- |
| Directory-aware, prerequisite-gated isolation detector | `self-test.mjs`: 18 controls, including uncanaried raw output, renamed test bodies, private paths, primary/replay/fallback sessions, directory symlinks, failed discovery, child exit, missing roots, wrong/writable Git mounts, and clean/canaried controls. `test/artifacts.test.ts` runs them in the normal gate. |
| Exact 256 KiB model payload remains usable | `stores an exact-limit model payload and reuses it after restart`; `rejects an oversized suite before creating the regeneration guard`. The stored-suite cap is 262,237 bytes. |
| Integrity reasons | `blocks changed bytes without regenerating` asserts `acceptance_changed`, not merely `blocked`. Symlink, mode, directory-mode, root-mode and oversize cases assert `acceptance_invalid`; missing file/directory cases assert `acceptance_missing`. |
| Failure and spend accounting | `counts an acceptance store failure once`; `counts unmarked accept spend on claimed-marker reuse` (success and integrity-stop cases); `recovers after suite storage without regenerating, blocking changed bytes` asserts the failure total. |
| Recovered receipt identity | `recovers model identity from passed output before storing the suite`; sandbox executor test `returns the recorded primary or fallback identity with recovered acceptance output`. |
| Surviving mutations and cleanup | Dropping orphan rejection fails `rejects an unreferenced check file with coverage even when all criteria are covered`. Relabeling a byte mismatch as missing fails `blocks changed bytes without regenerating`. Both mutations were reverted. The probe shares `launchSandbox` with production; canary planting and the regeneration guard have explicit names. |

## VM fixture

Fixture [#472](https://github.com/giuseppecrj/pi-herdr-factorio/issues/472), `[F06b-fix1] Add a clamp helper in src/clamp.ts`, owner label event `34677364232`.

- Lane: `F06b-fix1-w1`, VM `pi-factorio`.
- Stage code: `ced34405de59b306a317a95ad543ee077b478578`.
- Bundle: `0e2b7ea8faceb746b2abdc39510208a63d61b241cc1beb0ec90ee87e335b1f68`, unchanged; no reprovisioning.
- Run: `1f293d538c214dc632fa8c2565a1b0600faa63b3f386b5412ee1305763bee99d`.
- Acceptance digest: `8f37a372e3aeee24046b0d450394ba6a68faf46665a37f118ee386d8cc9c822a`.
- Five scenarios cover A1–A5, one check file. Modes, canary placement, receipt bindings and a fresh artifact read passed. The public summary was redacted and disclosed same-family context isolation.

The real `runCli` tick/controller and normal `sandboxExecutor` ran with a verification wrapper that only narrowed each launch's remaining token allowance to the unused part of the **25,000-token combined grant**. It rejected any non-`openai/gpt-6.1-sol` model or fallback. No output was substituted; no workflow, skill or sandbox assets were changed.

| Stage | Tokens | Model requests | Receipt wall |
| --- | ---: | ---: | ---: |
| Specify, including its reviewer | 11,573 | 4 | 22.269 s |
| Accept | 3,867 | 1 | 36.655 s |
| Total | **15,440** | **5** | Tick: **73.901 s** |

Only `openai/gpt-6.1-sol` answered; no xAI requests. The accept receipt retained the observed model. All markers landed in order: specify claimed/running, accept claimed/running/stage_passed, terminal usage 15,440.

## Fixed detector on the stored suite

The initial strengthened detector correctly returned INCONCLUSIVE: this production workspace has an empty read-only trusted `.git` bind, not tmpfs, and the OS exposes two dangling symlinks plus one permission-denied SSL directory. The final detector validates the actual launch layout and distinguishes those unreachable entries from unexpected I/O failures. Controls pin both supported layouts and reject a writable/wrong-type mount; missing or unreadable required roots still cannot pass.

The final probe and shared launcher matched local source hashes on the VM. All **18 detector controls passed on the VM**. Separate live build-profile sandboxes then produced:

| Live control | Expected / observed | Hits |
| --- | --- | --- |
| Clean suite boundary | PASS / PASS, process exit 0 | No canary, fingerprint or private-path hits |
| Uncanaried raw accept output copied into workspace | FAIL / FAIL, process exit 1 | 1 fingerprint, 7 path matches, no canary |
| Renamed canary-free test body copied into workspace | FAIL / FAIL, process exit 1 | 1 fingerprint, 2 path matches, no canary |
| Private test-path reference only | FAIL / FAIL, process exit 1 | 1 path match |
| Canary only | FAIL / FAIL, process exit 1 | 1 canary hit |
| Clean after removing injections | PASS / PASS, process exit 0 | No hits; stored digest unchanged |

Clean scans read **23,108 files**, tried **43 private paths**, and found no reachable private record or earlier-stage mount. Git and own sessions were empty; the Git mount was read-only; fresh tmpfs/environment/tool checks passed. One permission-denied non-root directory and two dangling OS links were counted, with **0 unexpected scan errors**. Gateway GitHub returned 403; direct GitHub was denied. Probes made **0 model requests**. Their child exits were zero; the wrapper's deliberate leak detections returned one.

Receipt metadata and counts only were exported. No suite code, private check path, private fingerprint or canary value was published. See the README for exact scan coverage and limitations; this is not universal proof against transformed/partial copies or every process/kernel channel.

## Closure

Fixture #472 confirmed CLOSED at `2026-10-30T10:04:41Z`. Lane removed; no remaining stage scopes or sandbox processes. VM snapshots before/after differ only in timestamps and their evidence filenames. `factory:enabled` was untouched.

Evidence: `pi-herdr-factorio-trails/F06b/fix-1/` and `/tmp/swarm-F06b-fix1/worker-1/` on the VM. Private suite bytes were removed with the lane. The design's cross-family acceptance requirement, actual F07a build layout verification and F07c post-publication repair isolation remain outside this fix round. No merge was performed.
