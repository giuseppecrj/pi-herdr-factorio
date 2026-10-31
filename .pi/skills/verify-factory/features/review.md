# Candidate review and bounded repair (F08)

Reserve a full run's allowances before starting each fixture, then charge actual receipt usage. Use only the task's authorized OpenAI models.

1. Run doctor, take the initial snapshot, commit and set up a lane. Re-provision the sandbox bundle when skills change.
2. Use a tiny `[F08-build]` issue. The first tick specifies and accepts; the second builds. Subsequent scoped ticks publish, collect CI and run review. A clean run ends `stage_passed` at review, with no ready PR.
3. Read `review/<runId>/r0/receipt.json` privately. Require all expected seats, exact candidate SHA, patch digest, acceptance and contract digests, CI run, per-seat tokens and honest same-family labels. Judge-only IDs appear exactly once in code-review judgments.
4. Seed a concrete defect in a separate fixture candidate before its first publication. Preserve the initial patch receipt. Passing executable CI must not suppress blocking review. Confirm a durable round increment, a fresh repair build with only sanitized feedback, round-qualified patch storage, a new immutable `-r1` branch, fresh CI and new SHA-bound review.
5. Review and CI failures share the cap of two. A third failure ends failed. Neither malformed seats nor refusals consume a repair. Both security models refusing end failed. Prove the fallback with an injected refusal and label that evidence `fallback proved by injected refusal only`; never claim the primary naturally refused unless it did.
6. Fetch the viewer through its loopback HTTP surface. Round 1 must display its own verdict. Missing round receipts must be named gaps. Preserve every viewer guard; no public exposure without owner authorization.
7. Close fixtures, confirm CLOSED, and confirm `git ls-remote origin 'factory/run/*'` is empty. Preserve private evidence, take the final snapshot, then clean only owned lane work.

Main-owned workflow bootstrap: before F08 merges, main's review entry has no OpenAI fallback. Prove explicit fallback settings through the real runner and gateway; after merge, confirm the trusted workflow parses. R8 remains incomplete.
