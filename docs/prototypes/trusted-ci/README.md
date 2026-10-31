# Trusted candidate gate evidence

F07b runs main's checks against exact candidate code without trusting candidate scripts, configuration, or test deletions. The host writes the receipt outside candidate mounts.

## Fix round 1 proof

All **34 fixture expectations** matched locally through bubblewrap and on the [hosted Docker runner](https://github.com/giuseppecrj/pi-herdr-factorio/actions/runs/41131601940). The hosted run is red because negative candidate jobs must fail. The six positive jobs are green, including the held-out missing-result probe described below.

The verified gate revision is `4b3fcfd0a2b03995bffe7ba3be632a67ce8f30e8`. [fix1-proof.json](fix1-proof.json) records each candidate SHA, receipt version, named results, typed refusal, replacement digest, duration, and job URL. `collect.mjs` checks those records against the fixture manifest and actual hosted conclusions. Later evidence and prototype-driver edits do not change this gate code or its tests.

| Fixture | Local | Hosted | Result |
|---|---|---|---|
| known-good | passed | passed | Candidate-only import, new test, read-only mounts, absent credentials |
| wrong-behavior | failed | failed | Preserved main tests |
| noop-scripts | failed | failed | Preserved main tests despite no-op candidate scripts |
| deleted-regression | failed | failed | Deleted main regression remains mandatory |
| weakened-typecheck | failed | failed | Main's typecheck rejects the error |
| weakened-lint | failed | failed | Main's lint rejects the error |
| weakened-format | failed | failed | Main's formatter rejects the error |
| assert-monkeypatch | failed | failed | `runtime_patching` |
| exit-import | failed | failed | Guarded early exit |
| really-exit | failed | failed | Guarded early exit |
| exit-hook | failed | failed | `runtime_patching` |
| skip | failed | failed | Skipped candidate test |
| todo | failed | failed | Todo candidate test |
| only | failed | failed | Exclusive-test diagnostic |
| npmrc | failed | failed | `npmrc_changed` |
| git-dependency | failed | failed | `invalid_dependency_spec` |
| named-replacement | passed | passed | Exact authorized files and before/after digests |
| unnamed-replacement | failed | failed | Main's original behavior tests remain mandatory |
| new-test-fails | failed | failed | A new `.cases.ts` failure vetoes passing main tests |
| lint-ignore | failed | failed | Nested ignore file cannot hide the lint error |
| stream-forgery | failed | failed | `runtime_patching`, with file and line |
| serializer-forgery | failed | failed | `runtime_patching`, with file and line |
| forgery-control | failed | failed | The shared behavior defect without either cheat |
| suppression-types | failed | failed | `suppression_added` |
| suppression-lint | failed | failed | `suppression_added` |
| suppression-format | failed | failed | `suppression_added` |
| deleted-replacement | failed | failed | `replacement_deleted` |
| heldout-pass | passed | passed | Exact-byte digest and one passing held-out test |
| heldout-fail | failed | failed | Held-out assertion failure, with no assertion text in artifacts |
| heldout-digest | failed | failed | `heldout_digest_mismatch` |
| heldout-missing-result | passed | passed | Real passing suite, followed by rejection of a copied partial receipt |
| package-swap | failed | failed | `package_swap` |
| registry-dependency | passed | passed | `is-number@7.0.0`, `newDependency: true` |
| glob-dependency | passed | passed | `glob@10.4.5`, transitive npm aliases, `newDependency: true` |

The stream and serializer fixtures retain audit B's source blobs `2d0edfd` and `45d9c50`. Both now fail before installation. Their shared control contains the same terminal-state defect without the forged reporting code. A separate preload unit test proves that the reporting methods cannot be reassigned and that Node crypto still works. The final audit patches use zero context to avoid patch-context whitespace warnings. Reapplying all 34 patches reconstructs exactly the verified candidate trees.

The replacement fixture changes how `inlined` counts a trailing empty line. Both specify and orchestrator tests pin that behavior. The named case authorizes both files. The unnamed case supplies the same patch without authorization.

The known-good fixture adds a candidate-only export and a test that imports it. The recorded fix-round-1 candidate also updated its manifest for the ordinary root check. Fix round 2 removes that workaround: neither this fixture nor `new-thing` edits `.github/`.

## Test discovery (fix round 2)

Main owns `testGlobs` in `gates.json`: `test/*.test.ts` and `test/sandbox/*.cases.ts`. The gate expands these against main's exported Git tree at `gateSha`, before overlaying the candidate. Each glob must match at least one file. Top-level tests run directly; `test/sandbox.test.ts` imports the sandbox cases, whose per-file counts remain in the baseline.

There is no hand-maintained file list or file-count drift assertion. The root unit checks the globs against the `npm test` command, not against a frozen list of files. A factory patch can add `test/new-thing.test.ts` without editing `.github/`. It runs as `candidate_tests` on that dispatch and joins the main baseline after merge. Synthetic mini-repo tests prove both steps without changing the manifest, and cover newly imported main sandbox cases.

At gate revision `fa8cb3d28b92f816f3f03ab64a69297504e49cad`, all **35/35 local fixture expectations** match through the real gates CLI with bubblewrap. The previous 34 outcomes are unchanged. [fix2-proof.json](fix2-proof.json) records these receipts and the [successful hosted scratch run](https://github.com/giuseppecrj/pi-herdr-factorio/actions/runs/41139016757).

The new candidate `f0017db8c1f4711b1e814246665f333c4ff4169b` changes only `test/new-thing.test.ts`; its manifest blob is unchanged. Both local and hosted gates pass all seven mandatory checks, with 1,058 main baseline tests and one separately executed candidate test. The candidate's ordinary root `npm run check` also passes locally and in hosted Docker with **1,059/1,059** tests, no skips or todos. Three delivery checks pass **1,058/1,058** each. The scratch branch was deleted after downloading its artifacts. This round reran the complete local batch and one hosted fixture, not the full hosted batch or three-pair benchmark.

## Held-out checks and exclusions

The four held-out fixtures publish synthetic files with deliberate type and formatting violations. The style checks pass, and the separately named `heldout` check executes the files under the same preload. The failing suite fails only `heldout`. No held-out log is written. Artifact checks found neither the synthetic private title nor assertion message in any of these final fixture artifacts.

The receipt is version 2 and lists `requiredChecks`. The missing-result fixture first runs a real passing suite, then removes `heldout` from a copied receipt. The exported `receiptPasses` predicate refuses that copy even though its remaining checks and claimed status are green. This is producer-side proof, not F07c controller-ingestion proof.

Root TypeScript, oxlint, and Biome exclude exactly `test/acceptance/**`. The gate's oxlint argv needs the same explicit exclusion because `/g/lint.json` resolves config patterns elsewhere. Biome uses main's preserved root configuration at `/w/biome.json`, so its exclusion resolves against the checked tree. Both Biome configs retain the exact pattern. Nested candidate configurations and ignore files are removed.

The isolated root-command probe passes with a synthetic published suite. All three tools still reject the four nearby controls at `test/planted.test.ts`, `test/acceptance.test.ts`, `test/acceptance-other/y.test.ts`, and `src/acceptance/z.ts`.

## Runtime boundary

The Docker image is pinned to `node@sha256:6d2c7d5d074bf72f81ddc252b4fbb5d625bc028eeda49cb4b8c2ff8eda1ee617`. Checks run as UID 1001 without network access or capabilities. The root filesystem, candidate tree, and gate tools are read-only. `/tmp` is an executable 1 GiB tmpfs. The receipt directory is not mounted. Checkout uses GitHub's ephemeral read-only token with `persist-credentials: false`. Candidate execution never receives that token.

The Docker runner requires host UID 1001. Operators with another UID use `--runner local`, which creates a new bubblewrap session with unshared namespaces. Local receipts say `local-bwrap`, not Docker.

The host accepts registry tarballs only, rejects redirects, binds each tarball path to its real package name and version, and verifies SHA-512 integrity. A lockfile alias must be declared under its alias name by its parent's dependency group, including hoisted resolutions. The alias entry must name the real package and resolve to its registry path. A parent with unchanged version, tarball, and integrity cannot change an alias declaration from main's lockfile. Offline installation disables lifecycle scripts. Main's compiler, lint plugin, and formatter use a separate main-owned installation. The listed install-script packages are `@google/genai` and `protobufjs`. Neither script runs.

Tree export reads exact Git blobs. Candidate export attributes cannot omit or rewrite files. Symlinks, submodules, unsafe paths, and `.npmrc` changes fail policy checks. NUL-bearing or non-UTF-8 JavaScript and TypeScript source fails with `invalid_source_encoding`. Candidate files under `test/acceptance/` must belong to the dispatch's digest-matched `checks/*` list, or fail with `unauthorized_acceptance`.

The preload freezes `node:assert` and `node:test` exports. It pins `Readable.prototype.push` and `read`; `Serializer.prototype` and `DefaultSerializer.prototype` methods `writeHeader`, `writeValue`, `writeRawBytes`, and `releaseBuffer`; stdout's `write` and `_write`; and guarded `process.exit` and `process.reallyExit`. It does not freeze whole stream prototypes, which breaks Node crypto. A main-owned host scan reads changed lines with `git diff --text` and records matched paths and lines in `tamperSignals`. Added `@ts-nocheck`, `@ts-ignore`, `@ts-expect-error`, `oxlint-disable*`, `eslint-disable*`, and `biome-ignore*` patterns fail with `suppression_added`. Unchanged main directives and dispatched held-out files are exempt from that rule.

The runtime scan is a tripwire, not a complete defense. It follows literal built-in imports, literal `require` and dynamic imports, and aliases from variable initializers within the scanned file. It flags direct assignments, updates, deletions, and the `Object` and `Reflect` mutators listed in `scan-rules.json` targeting built-in members, `Module`, `module`, `require.extensions`, and process `exit`, `reallyExit`, `exitCode`, `on`, `once`, `addListener`, `prependListener`, and `prependOnceListener`. It also flags `module.register` and `registerHooks` calls and process listeners with literal `exit`, `beforeExit`, or `uncaughtException` event names. Matches fail with `runtime_patching`, including in held-out files. The scan does not follow helper parameters, variable event names, later assignments, computed strings, or evaluated code. Review candidate C1 patched `Readable.prototype.read` through a helper without a scan hit. The new `read` pin blocks C1, but analogous helpers on unpinned members remain outside the scan.

These in-process gates are strong against accidental and lazy cheating, not a model that deliberately subverts Node's test runner. Candidate code produces the reporter events. Held-out tests share that exposure. The owner's v1 review and F08 review are further defenses.

Each invocation has a 60-second Node test timeout. The first baseline process has a 90-second deadline. Candidate checks get the greater of 90 seconds or three times measured baseline test time plus 30 seconds. After a candidate process timeout, a main-on-main control runs with the same deadline. If main also times out, the result is incomplete rather than a candidate failure. Docker exits 125 through 127 and runner errors are incomplete. Units cover those infrastructure classifications. They were not induced on the hosted runner.

## Corrections found by the full batch

The first fix-round batch was not a pass. [Run 41127174790](https://github.com/giuseppecrj/pi-herdr-factorio/actions/runs/41127174790) reproduced two positive-case failures. The manifest unit counted candidate additions as main's files, and Biome's `/g` configuration still formatted the held-out suite. The corrected trusted-tree paths pass the complete local and hosted rerun above. [The initial perf attempt](https://github.com/giuseppecrj/pi-herdr-factorio/actions/runs/41127178399) stopped at the ordinary check before producing a gate receipt. It is not a performance sample.

The previous rounds remain historical evidence in [proof.json](proof.json), [delta-proof.json](delta-proof.json), and [perf.json](perf.json). They do not establish fix-round behavior.

## Performance proof

[The revised three-pair hosted benchmark](https://github.com/giuseppecrj/pi-herdr-factorio/actions/runs/41131604785) passes. Both commands use the same fixed known-good candidate and pinned Docker profile on one runner. The existing `npm run check` command runs first in each pair. Its log records 1,053 passing tests, including the new candidate-only test. [fix1-perf.json](fix1-perf.json) contains exact identities and raw timings.

| Pair | Existing check | Trusted gate | Install | Gate budget |
|---|---|---|---|---|
| 1 | 55.588 s | 136.033 s | 35.336 s | 171.176 s |
| 2 | 52.685 s | 130.786 s | 31.823 s | 165.370 s |
| 3 | 52.764 s | 136.896 s | 36.797 s | 165.528 s |

The existing-command median is 52.764 seconds. The gate median is 136.033 seconds, including a 35.336-second median install and 46.841-second median main-on-main test run. Every gate stays below twice its paired baseline plus 60 seconds and below ten minutes. Queue time is three seconds. The full benchmark job takes 610 seconds. Image pull and queue time are outside gate receipts. No model call or token is used.

## Bootstrap boundary

Hosted proof uses temporary push-triggered copies of the production workflow. Each scratch commit changes only the workflow interface, not the gate implementation. The production workflow remains dispatch-only on `main`, with one read-only `gates` job and one artifact named `gate-receipt`. Only fixture matrices use artifact-name suffixes. The existing required `check` and its workflow are unchanged.

All scratch and fixture branches from this fix round were deleted after their runs completed. Receipts and runs remain available. No VM change, model spend, Docker installation, merge, settings change, PR comment, or new PR occurred.

Protected-main dispatch remains pending until the bootstrap merge. F07c must prove publication, bot-side collection, private-suite binding, and rejection of partial receipts through its actual controller. This leaf does not claim independent review or a complete program verdict.

## Reproduction

Run the fixture driver from the repository root. `generate` writes fixture patches. `prepare` uses a private Git index without changing the checkout. `local` invokes `server/cli.ts gates` for every case. Publication and deletion require the operator's grant.

```bash
node docs/prototypes/trusted-ci/fixtures.mjs generate "$GATE_SHA" "$TRAIL"
node docs/prototypes/trusted-ci/fixtures.mjs prepare "$GATE_SHA" "$TRAIL" --publish
node docs/prototypes/trusted-ci/fixtures.mjs local "$GATE_SHA" "$TRAIL"
node docs/prototypes/trusted-ci/fixtures.mjs scratch "$GATE_SHA" "$TRAIL"
```

After the run completes, save `gh run view <id> --json headSha,status,conclusion,url,jobs` as `$TRAIL/hosted-run.json`. Download artifacts to `$TRAIL/hosted-artifacts`, then run `node docs/prototypes/trusted-ci/collect.mjs "$TRAIL" <id>`.

For the single fix-round-2 proof, omit `--publish` from `prepare` and use `scratch "$GATE_SHA" "$TRAIL" --fix2 --case=new-thing`. This pushes only `proto/f07b-fix2-*`; the candidate is an ancestor of that scratch commit, not a separate remote branch. The hosted job checks that the candidate changes only `test/new-thing.test.ts`, runs the trusted gates, then runs the candidate's ordinary root check. Delete that exact scratch ref after saving its results. The full-matrix collector above expects every hosted case and is not used for this single-fixture run.

`scratch --perf` runs three interleaved existing-check and gate pairs for the known-good fixture. It preserves command logs and receipts. Use a separate trail directory with the same `fixtures.json`, because each scratch invocation writes its own `scratch.json`.
