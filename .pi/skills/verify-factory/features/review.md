# Candidate review and bounded repair (F08/F09a)

Reserve a full run's allowances before starting each fixture, then charge actual receipt usage. Use only the task's authorized models.

## Sub-features

- Fresh review seats bind the candidate, contract, suite, workflow pin, and CI identity.
- Pre-PR CI failures and blocking review share two repair rounds.
- F10 accepts authorized owner feedback on the same PR and recertifies an owner head without a build.

## How to get to it (user POV)

Follow the fixture's CI and review summaries on GitHub. A certified candidate proceeds to handoff and waits for the owner. Only a write-access `CHANGES_REQUESTED` review bound to the promoted head can request feedback repair. Read target restrictions in `../SKILL.md` first.

## Driving it with the named tooling

1. Run doctor, take the initial snapshot, commit and set up a lane. Re-provision the sandbox bundle when skills change.
2. Use a tiny lane-owned `[F09a-review]` issue. Scoped ticks specify, accept, qualify the suite on the base, and build. Later scoped ticks publish, collect CI, and run review. Follow the stored phase rather than a fixed tick count. F09a clean review certifies the candidate, then deterministic handoff waits for the owner; it no longer ends at F08's terminal review stop. Native handoff requires the owner-merged bootstrap and main-backed reporter proof.
3. Read `review/<runId>/r0/receipt.json` privately at generation zero, or the matching round's `g<N>/receipt.json` after refresh. Bind its captured execution/attempt/generation, full input manifest, admitted workflow SHA/digest, candidate/source base, and CI identity. A seats-only manifest or same-patch receipt cannot be rebound. Require all expected seats, exact candidate SHA, patch digest, acceptance and contract digests, CI run, per-seat tokens and honest same-family labels. Judge-only IDs appear exactly once in code-review judgments. If main moved, compare review bytes with `verdict.baseSha` plus the stored patch, not `originalBase` plus patch. Confirm the separate review-base export leaves the original pristine repair base unchanged. Review instructions must still use the admitted `workflowSha` and match `workflowDigest`, even if the certified base changes or removes `WORKFLOW.md`. Check the same pin on stored-output recovery. Missing or mismatched pinned evidence must never approve or select newer instructions. An ordinary patch gets only three seats despite unchanged dependencies with install scripts.
4. Seed a concrete defect in a separate fixture candidate before its first publication. Preserve the initial patch receipt. Passing executable CI must not suppress blocking review. Confirm a durable round increment, a fresh repair build with only sanitized feedback, round-qualified patch storage, a new immutable `-r1` branch, fresh CI and new SHA-bound review.
5. Before publication, review and CI failures share the cap of two. A third failure ends failed. After publication, a failed repair holds instead. Neither malformed seats nor refusals consume a repair. Review retries share 120,000 tokens per round. Repair-build retries share 300,000 tokens per round. The configured run cap is 800,000 tokens. Check remaining launch allowances after retry and recovery, including retained seats of that exact execution. Fresh generations require fresh seats. Issued review attempts stay round-global across refresh, at most three or the stricter configured one/two limit. Review/repair/run spend never resets. Early retry-5 acceptance does not grant five review attempts. Stop and charge every captured account before workspace reuse or terminal bookkeeping. Exhaustion permits no new model request or approval. Both security models refusing cannot approve. An unpublished run fails. A published run holds and remains observed. Prove the fallback with an injected refusal and label that evidence `fallback proved by injected refusal only`; never claim the primary naturally refused unless it did.
6. Fetch the viewer through its loopback HTTP surface. Round 1 must display its own verdict. Missing round receipts must be named gaps. Preserve every viewer guard; no public exposure without owner authorization.
7. Close owned fixtures, confirm CLOSED, and use `git ls-remote origin 'factory/run/*'` to inventory their exact validation refs. Other lanes' refs may remain. Preserve moved refs and pending cleanup reasons; never generically delete stable PR refs or private claims/books. Preserve private evidence, take the final snapshot, then clean only owned lane work.

## Gotchas

Before the first PR, complete CI failure and blocking review share two repairs. After a PR exists, failure, conflict, or exhaustion leaves it open, not-ready, and observed. F10 feedback repair is enabled within the same shared cap. Owner-head repair is refused. Verify observed model families from receipts rather than assuming independence from requested IDs. Follow [handoff](handoff.md) for the separate owner-action, refresh, attention, and protection lanes. Record original pin/head/generation identities, command exits, model-call expectation, and actual usage in each receipt. This recipe is source-checked/unrun in the docs round; local saved-state tests and injected fallback are not natural-refusal/live proof. F08's accepted gaps remain in issue 543; R8 remains incomplete.
