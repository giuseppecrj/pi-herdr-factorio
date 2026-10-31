# Published held-out validation (F07c)

Reserve the full specify, accept and build allowances before a fixture run. Validate adds no model usage. Use only the task's authorized model and fixture refs.

1. Follow doctor, snapshot and lane setup. The first scoped tick specifies and accepts; the second builds. Confirm `running` at validate with `active: 0`.
2. Tick once more to publish and dispatch. Read the claim's `validation` object privately. It records base, branch, patch and candidate SHAs, dispatch try, deadline and CI run. Keep the same state directory.
3. Inspect the candidate's two commits with repository-scoped `gh api repos/<repo>/git/commits/<sha>`. Patch comes first, suite second. Read only `checks/*` bytes to recompute the held-out digest privately. Never export test content into a build session.
4. Stop and start the scoped controller during the wait. Confirm the same candidate, nonce, attempt and usage, no second dispatch, no model launch and no occupied slot. One-shot tick commands are separate controller processes and also exercise this recovery.
5. Collect after CI completes. On the VM use the repository-scoped artifact API; `gh run download` follows absolute URLs that the proxy refuses. Require stored `verdict.json` with patch, acceptance, held-out, candidate, gate and CI run identities. Every required check must pass exactly once. Confirm the candidate branch is deleted only after evidence exists.
6. Run `node docs/prototypes/heldout-ci/repair-probe.ts <state> <runId>`. It reconstructs a base plus the exact prior patch, seeds a prior published suite in the base, sanitizes it, and launches a real build-profile sandbox. Require a fresh install, empty Git objects, no acceptance directory or canary/body hits, approved feedback only, denied direct/npm/model-tool GitHub retrieval, and zero model requests.
7. Close every fixture and confirm CLOSED. Confirm the fixture refs are gone with `git ls-remote origin 'factory/run/*'`. Take the final snapshot and clean only this lane.

`test/publication.test.ts` and `test/validation.test.ts` cover lost dispatch responses, crash-after-ref, bounded redispatch, stale-base reapply/conflict, receipt identities and missing results. `test/orchestrator.test.ts` covers old-workflow/v1 adoption and slot-free waiting. Roll forward only after marker v2; drain the controller before deployment.
