# Held-out CI publication proof

F07c publishes a builder patch and then controller-owned checks as two deterministic Git Data commits. Validate is controller-only. It dispatches main's gates for the exact candidate, waits without a slot or model, and stores a bound verdict before deleting the fixture branch. Repair orchestration remains F08 work.

## Real run

The complete real-model run used controller `c3cba00889c350d7968235a219b014956e713d45` on pi-factorio, trusted main `37dce5f4da727a5a47cd017c0c8c9d74c7272257` and fixture [510](https://github.com/giuseppecrj/pi-herdr-factorio/issues/510). Its issue requested a NUL-path policy regression. The fixture is closed.

[Hosted CI 41158101470](https://github.com/giuseppecrj/pi-herdr-factorio/actions/runs/41158101470) passed. `proof.json` records the actual verdict, commit parents, bot identity, check paths and exact-byte digests. It contains no private suite source or raw session.

| Step | Observed result |
| --- | --- |
| Specify | 8,000 tokens, 18.734 seconds including its tool-less reviewer |
| Accept | 7,557 tokens, 29.483 seconds, fresh same-family session |
| Build | 42,294 tokens, 27.330 seconds of model work; controller-visible tests passed afterward |
| Publish | Patch `89684dc029f55188eb3af38f28804e07e835ebc9`, then suite/candidate `1e3b761caa27c370afe5b447bfca925c6703e7c1`; the whole publication command took 11.233 seconds including preflight and recovery |
| Restart during CI | A new controller process adopted marker 8, found the existing run, posted marker 9, retained attempt 1 and usage 57,851, held zero slots and dispatched nothing twice |
| Held-out CI | Seven tests in two files passed in 317 ms; all eight receipt-required checks passed; zero CI model calls |
| Collect | The controller stored all identities, listed scenario S5 as unjudged, deleted the branch, and posted `stage_passed` at validate; collection after adoption took 2.151 seconds |
| Repair sandbox | Fresh install passed; 21,731 files searched; no canary or suite-body hits; empty Git mask; no acceptance directory; approved feedback only; direct, npm and hosted-tool GitHub retrieval denied; zero model requests |

All VM model calls used `openai/gpt-6.1-sol`. Total usage was 57,851 tokens against the 400,000-token grant. Provider monetary pricing was unavailable. No exe.dev-credit route was used. Same-family acceptance is not cross-family independence.

These are one-shot controller commands, so manual gaps between ticks are not controller latency. This is one full live run and a repair probe, not the plan's later three-pair performance benchmark or ten-lane swarm.

## Final model-free verification

At `43c2f8d792f68eaafbdf2eab34ab245ea54d61bc`, `npm run check` passed 1,122 tests with no failures, skips or todos. `closure-proof.json` records a fresh download and collection of the same real CI receipt, another fresh-install repair sandbox, and a terminal controller tick with zero launches, tokens or occupied slots. The sweep stored `cleanup.json` and left no fixture branch.

The final probes exposed two cleanup details. A completed transient systemd scope may already be gone when stop runs, so the probe now verifies absence. GitHub returns 422, not 404, when deleting an already-missing ref. Publication now reads the ref back and accepts only confirmed absence. The repeated-delete regression failed before that fix. Neither correction spent model tokens.

## Recovery and fail-closed tests

`test/publication.test.ts`, `test/validation.test.ts`, `test/markers.test.ts`, `test/orchestrator.test.ts`, `test/stages.test.ts` and `test/policy.test.ts` cover missing and empty check sets, stale identities, suite-digest mismatches, deterministic commit order, crash-after-ref, lost dispatch responses, bounded redispatch, two late-visible dispatch tries, clean and conflicting stale-base reapply, slot-free v1 adoption on a legacy workflow, marker-v2 size and types, sanitized repair trees and approved feedback. A released candidate is swept only after existing CI finishes or the deadline, without redispatching or touching `factory/ledger`.

The initial empty-check and missing-check regressions failed before implementation. Later marker-type and collector-identity regressions failed on `c3cba00` before the closure fixes. Red and green output is retained in the coordinator's F07c build trail.

TLC checked the full controller model over 4,428 states. The journey model still reports the known `MergeEndsRun` counterexample, which F10 owns; its other invariants and deadlock check hold. The typed replay still reproduces that path against `advance()`.

## Repeat the model-free probes

From a lane checkout with the original private run state retained:

```sh
export GH_HOST=github.int.exe.xyz XDG_RUNTIME_DIR=/run/user/1000
node docs/prototypes/heldout-ci/collect-probe.ts <state-dir> <run-id>
node docs/prototypes/heldout-ci/repair-probe.ts <state-dir> <run-id>
```

The collection probe downloads the real receipt again through the repository-scoped artifact API and checks fresh GitHub run metadata against the private patch and suite. It does not dispatch or rewrite the run. The repair probe seeds the prior suite in a disposable base, sanitizes base plus prior patch, launches the real build-profile sandbox and removes its owned files and scope. Neither probe calls a model.

Drain the controller before deploying marker v2. Deployment is roll-forward only; legacy controllers reject v2. The parser still adopts old workflow digests and ignores legacy `validate.model` with a warning. New workflow settings omit that key.

Main's existing gate requires flat test files directly under `checks/`. F07c does not broaden that layout; a suite outside it fails closed. No nested-layout success is claimed.

Independent review, Comment Sicko, the program swarm and merging remain coordinator work. No user-facing factory PR, merge, settings change, GitHub Actions workflow or gate-script edit, non-fixture ref mutation or subagent launch was performed by this builder.
