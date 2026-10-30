# Acceptance isolation: the pre-build boundary (F06b)

Question: once accept has stored a held-out suite, can a later build-profile sandbox for the same run reach the stored files or an earlier stage's records?

## Private records

`<state-dir>/acceptance/<runId>/` holds `suite.json`, `manifest.json`, `checks/*`, `canary.txt` and `receipt.json`, mode 0600 in 0700 directories, plus the regeneration guard `<state-dir>/acceptance/<runId>.json`. The random `factory-holdout-<64 hex>` canary is in `canary.txt`, `suite.json` and every stored check. The receipt, guard, raw model output and session transcripts are **not** canaried. Searching only for the canary cannot detect every copy of test code.

## Probe

On the VM, run:

```sh
node docs/prototypes/acceptance-isolation/probe.ts <lane-state-dir> <runId>
```

The host first verifies the contract and stored suite. It inventories every existing specify/accept attempt and replay directory recursively, including draft/review/revision directories and each fallback agent's sessions. It fingerprints all accept `output.txt` files and the validated test bodies with SHA-256, and fingerprints private test paths. These hashes and the private reachability inventory go to the child through stdin; they are not printed. Missing inputs stop the probe, rather than substituting nonexistent paths.

The probe calls the same exported `launchSandbox` helper as `sandboxHost`: scoped bwrap, seccomp, fresh bundle-derived agent dir, run workspace, and build tools `read,grep,ls,bash,write,edit`. Its separate build gateway allows zero model requests. It runs fixed Node code, not Pi. The detector:

- requires host-state discovery from `/proc/1/cmdline` to identify this run (known disclosure #425);
- tries the private suite/guard/contract roots and every inventoried earlier-stage path. A directory is reachable when `readdir` succeeds, even if empty; it also recursively tries its contents;
- checks mountinfo for acceptance or inventoried earlier-stage mounts;
- requires all scan roots and its own sessions directory to be readable directories, `/workspace/.git` to be an empty read-only mount matching the launch layout (masked tmpfs, or a trusted bind with the workspace's filesystem type), its own sessions to be empty, and `/home`, `/tmp`, `/run` to be tmpfs;
- checks the fixed tool list, credential-related environment variables, and cache/credential/root paths;
- reads complete readable regular files under `/workspace`, `/run`, `/home`, `/tmp`, `/opt/factory`, `/etc`, following symlinks with inode deduplication. It searches for canary patterns, exact-file SHA-256 matches to raw output/test bodies, and hashed test-path tokens (including path suffixes). There is no 4 MiB exemption. Permission-denied non-root entries and dangling symlinks are counted separately as unreachable, not scanned. Unexpected I/O errors, unreadable/missing required roots or zero scanned files make the result inconclusive;
- requires a GitHub gateway denial (403) and a failed direct HTTPS request to `api.github.com`.

The host also checks stdout/stderr for the canary and exact private texts/paths. Reports contain only counts, booleans and receipt metadata, never fingerprints, hit paths, test code or canary values. PASS requires successful prerequisites, a zero child exit, and no detected reachability/content/path leak. A failed prerequisite is INCONCLUSIVE or a nonzero host error, never PASS. Cleanup stops the scope/gateway and removes the probe's private directories; separately verify no scope remains.

## Detector controls

```sh
node --test docs/prototypes/acceptance-isolation/self-test.mjs
```

This executes the actual embedded detector and PASS expression against an isolated real temporary filesystem, with filesystem paths redirected and network replies stubbed. It is a detector test, **not** a live sandbox measurement. `test/artifacts.test.ts` includes it in `npm run check`.

The clean positive control must pass. Copied uncanaried raw output, a renamed copied test body, a private test-path reference, readable prior primary/fallback session directories, failed host discovery, a nonzero child exit, missing roots and an absent, wrong-type or writable Git mount must not pass. Additional clean controls cover the production read-only trusted Git bind, dangling OS symlinks and permission-denied non-root directories. A canaried check is the positive leak-detection control and must fail. Run these controls on the VM alongside a fresh stored-suite probe. Live copied-output and canary injections belong only in an authorized disposable lane; remove them before the clean probe.

## What this establishes

A clean result records the observed **initial pre-build** boundary for this sandbox layout, bundle and run. The workspace contains only the trusted base checkout; neither the private stores nor previous stage contexts are mounted. Future build inputs must keep that layout and supply only the contract and scenario IDs, as `ARTIFACT_ACCESS.build` records.

This is not proof against every oracle-copy channel. Exact-file hashes do not detect arbitrary transformed or partial bodies; path matching is token-based and may conservatively flag a public file with the same name. The scan does not cover `/usr`, arbitrary kernel/device streams, process memory or every possible proc alias. Git objects are excluded by requiring the empty read-only Git root, not by exhaustively searching an exposed repository. The known host-path disclosure is not fixed. F07a must rerun the probe on its actual tool/network layout; post-publication repair isolation remains F07c.

## Fixed-probe observation

[Fix round 1 verification](./fix-1.md) records fixture #472: 18/18 detector controls on the VM, clean PASS before/after four deliberate live leak injections, and FAIL for each injection. The clean scan read 23,108 files and tried 43 private paths, with no leak hits or unexpected scan errors. Its empty Git root was a read-only trusted bind; one denied OS directory and two dangling links were counted explicitly. Total fixture model usage was 15,440 tokens; probes spent none.

## Earlier observations

The old canary-only detector passed on 2026-10-30 on fixtures #460 (`1611c7b`) and #461 (`fff4922`), bundle `0e2b7ea8faceb746…`, scanning 22,891 files with no canary hits. Those observations did **not** rule out uncanaried copies or readable session directories; round-1 audit negative controls exposed those gaps. They are not evidence for the stronger detector above.
