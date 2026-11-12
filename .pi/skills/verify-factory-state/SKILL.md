---
name: verify-factory-state
description: Rerun the existing bounded factory state checks and runtime correspondence after candidate or controller policy changes. Preserve F1 to F4 bounds, expected witness failures, and incomplete properties.
---

# Verify bounded factory state

Use this wrapper for the existing checks in [docs/statecharts/README.md](../../../docs/statecharts/README.md). It adds no model, proof, or release gate. Run commands from the repository root. No VM, GitHub mutation, or model inference is needed.

The checked promise is that modeled candidate work uses bound CI and settled execution evidence before readiness or terminal bookkeeping. A violation can certify the wrong head, lose charged work, or finish while work remains live. An owner may merge an uncertified head. The model must record that as an owner override, not forbid it.

## Coverage and correspondence

The last recorded runtime correspondence revision is `3c62fc7`. Do not treat the current HEAD as synced merely because unchanged models pass. Before moving that revision forward, compare these owners with the model actions and the README's explicit abstraction limits:

| Runtime owner | Model responsibility |
| --- | --- |
| `src/candidate/state.ts`, `src/candidate/codec.ts`, `src/candidate/handoff.ts` | Candidate generations, execution accounts, certification, feedback repair, owner-head recertification, stop, and finish. `state.ts` holds the book shape and generation identity, `codec.ts` the stored-book decoding, `handoff.ts` the policy |
| `src/candidate/stages.ts` | Public `advance` delegates candidate policy to `handoffCandidate` |
| `src/orchestrator.ts` | Persisted intent, effect interpretation, captured callback, and restart recovery |
| `src/github/publish.ts`, `server/controller/validation-sweep.ts`, `server/controller/candidate-port.ts` | Publication, non-force promotion, CI deadlines, and owned ref cleanup |
| `test/handoff.test.ts`, `test/orchestrator.test.ts`, `test/publication.test.ts` | Runtime correspondence through the named F4 runner |

The configs retain six total generations, two shared repairs, three run-wide refreshes, and three issued review attempts per round. Abstract review, repair, and run quotas are 3, 3, and 8. Usage classes are 0 and 1, with prior usage 1. These are not substitutes for real token caps. Controller transport represents one restart and one fixed cleanup-focus generation per behavior, not concurrent cleanup of all refs.

Read every TLA result with `/skill:statechart`. Explain a violation as the shortest sequence of candidate/controller steps. Presentation diagrams are not substantive proof. Use the installed skill's current procedure rather than copying its renderer commands.

## Tools and identities

F1, F2, and F3 use the owner-approved `tla-ts` 0.0.8 CLI with Node, `timeout`, and `/usr/bin/time`. Resolve the installed package path on this machine and set `TLA_TS_CLI` to its `dist/cli.js`. Record its package version and CLI hash before running. Do not install a missing tool or silently substitute another checker. Installation or a changed checker needs the owner. F4 uses Node and the checkout's installed dependencies, not tla-ts or Java.

Record the exact HEAD/tree, Node version, checker version/hash, commands, exits, wall time, state counts, queue, and complete logs in a private output directory. Hash the model and configs on every run. Compare them with this historical qualification record before reusing evidence:

| File under `docs/statecharts/` | SHA-256 |
| --- | --- |
| `journey/Journey.tla` | `d01519d194898cbdf272fb7a214aeb503bd8ea0d8055c655ba0c6f8ffa9ab845` |
| `journey/Journey.cfg` | `527ce37abb50939091de41d9ad141edcc6e62ce3805cd19f1bb0aff3603236f5` |
| `journey/Feedback.cfg` | `6cff4baa68a65f5106efd41c7f5d023f09c3295f2ea0c82343ed25753ca74103` |
| `journey/PublishedRepairWitness.cfg` | `a7fcacaad4c12a4c48f4c61b531191cf8ca532ac6b6daabc827eb6ef58e9f8c0` |
| `journey/OwnerReadyWitness.cfg` | `a4ff583a5df053551b27d79492b7ca015a21c0108a5e7a908938282f6b1e10e8` |
| `journey/MergeMidRepairWitness.cfg` | `f257d8eb6eb3c656f3c09feec5d74bb91f0104bf8536227680c63384f7b7f6ce` |
| `journey/OwnerAuthoredMergeWitness.cfg` | `104babc250c7d1168b132c770c4b4608f4a9e0b8c66326775e24ce77bac12818` |
| `journey/Chart.cfg` | `d6bff8a9ff7154923e971f214638b8b68854e6ca268a0c499366685938bdb783` |
| `controller/Controller.tla` | `498fe16f509c1b8bb23e1988c056bb49414e877f703993c81538ae4a0b65a5a6` |
| `controller/Chart.cfg` | `aedbc63300b06b9f1a4650efad5bb8c1794343fcc307d77d2c44106993fd8f0f` |

Use `sha256sum docs/statecharts/journey/*.tla docs/statecharts/journey/*.cfg docs/statecharts/controller/*.tla docs/statecharts/controller/*.cfg` for the current inventory. `controller/Controller.cfg` belongs to the historical F09a row in the README, with hash `ddc0cae91effbed82a890574c14f24b6af9abd5822532ea29465fb746b326bae`. It is not an F10 qualification file. Record the F4 runner hash too. A hash mismatch invalidates unchanged-model evidence until reviewed. Never reduce a bound to obtain a pass.

## Run the existing checks

Create the temporary parent directory first. Run this in bash after resolving `TLA_TS_CLI`. For a bounded task naming only F1 and one witness, run only those named calls, not the entire block.

```bash
set -eu
: "${TLA_TS_CLI:?Set this to the installed tla-ts 0.0.8 dist/cli.js}"
CHECKER="$TLA_TS_CLI"
J=docs/statecharts/journey
OUT=$(mktemp -d "${TMPDIR:-$HOME/.herdr/tmp}/factory-state.XXXXXX")
node --version > "$OUT/node-version.txt"
sha256sum "$CHECKER" "$J"/*.tla "$J"/*.cfg > "$OUT/hashes.txt"
git rev-parse HEAD HEAD^{tree} > "$OUT/revision.txt"
run() {
	name=$1 seconds=$2 cfg=$3 expected=$4
	printf 'timeout %s node --max-old-space-size=24000 %s %s -config %s -workers 8 -fp 0\n' \
		"$seconds" "$CHECKER" "$J/Journey.tla" "$cfg" > "$OUT/$name.command"
	status=0
	/usr/bin/time -f 'wall_seconds=%e\nmax_rss_kb=%M' -o "$OUT/$name.time" \
		timeout "$seconds" node --max-old-space-size=24000 "$CHECKER" "$J/Journey.tla" \
		-config "$cfg" -workers 8 -fp 0 > "$OUT/$name.log" 2>&1 || status=$?
	printf '%s\n' "$status" > "$OUT/$name.exit"
	printf '%s exit=%s\n' "$name" "$status"
	test "$status" -eq "$expected"
}
run F1 1200 "$J/Journey.cfg" 0
for witness in PublishedRepair OwnerReady MergeMidRepair OwnerAuthoredMerge; do
	run "F3-$witness" 300 "$J/${witness}Witness.cfg" 12
	grep "Invariant No${witness}Witness is violated" "$OUT/F3-$witness.log"
done
node --experimental-strip-types "$J/replay-merge-mid-repair.ts" > "$OUT/F4.tap" 2>&1
```

F1 must finish with all configured properties holding and an empty queue within 1,200 seconds. The recorded unchanged-model result has 1,670,069 distinct states. A timeout, unsupported construct, or semantic failure is incomplete, not a pass.

F3 deliberately checks four false invariants. Require exit 12, the named invariant, and a trace reaching the intended state. A different invariant failure is not witness success. The expected endpoints are:

| Witness | Required endpoint |
| --- | --- |
| PublishedRepair | A published run repairs only for feedback, with readiness false |
| OwnerReady | The exact owner head is certified and ready without a build or promotion |
| MergeMidRepair | The owner merges the old certified head during feedback repair, with truthful factory assurance |
| OwnerAuthoredMerge | The owner head merges after certification, with owner authorship, even before readiness |

Inspect the final states, not just the exit. Witness queues need not drain. Each run has a 300-second bound.

F4 is the named-test correspondence runner, not a generic trace decoder. Require exit 0, at least 40 selected tests, all passing, zero skips, all five F10 replays, the six-generation trace, saved-intent restart, and unexpected-predecessor refusal. It calls the real reducer and public `advance`. F4 remains required independently of a model pass. Run the ordinary project checks separately.

### F2 is historical completed evidence

On 2026-11-08, tla-ts 0.0.8 completed `Feedback.cfg` in 468.99 seconds with 69,051,765 distinct states, an empty queue, and all configured properties holding. The unchanged-model evidence carried across runtime correspondence integration at `3c62fc7`. Writing or reading this wrapper makes no new F2 claim.

Only when the task authorizes an F2 rerun, use `run F2 1800 "$J/Feedback.cfg" 0` with the function above. The historical contract permits one narrower 1,800-second retry after exit 124 only. Change only the scratch config's profile to `feedback_no_main`. Record every configured invariant and property as unqualified on timeout. There is no third attempt. A safety counterexample blocks. Do not add accounting or substantive Controller runs to this bounded wrapper task.

## Report the limits

Unrestricted accounting, substantive Controller checking, concurrent all-ref cleanup interleavings, and composed faults remain incomplete. Historical timeouts qualify none of those properties. F1 excludes feedback and owner recertification. F2 excludes switch/capacity changes, unavailable launches, and late receipts, and restricts main movement to waiting or held states.

The model does not qualify reset-to-factory-head behavior, protected notice delivery, the full promotion window, main movement during owner checking, or token-exhaustion readiness withdrawal. Runtime tests cover some of these cases. Read the README for the exact differences, fairness assumptions, symbolic identities, and historical negative controls. Cryptographic bytes, malformed wire data, filesystem durability, and native Actions identity remain runtime boundaries.

Report model errors separately from product defects. Do not weaken a property to accept a trace. This wrapper reuses the existing qualification and mutation evidence. It does not claim a new real-code mutation test, complete protocol proof, independent formal review, live qualification, or permission to merge.
