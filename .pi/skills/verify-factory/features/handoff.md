# Human handoff and bounded refresh (F09a)

Use this recipe for the ten F09a live lanes in the [plan](../../../../docs/plans/factory-v1.md#hand-off-verified-prs-and-require-human-merge-f09a). It is a source-backed recipe, not a live result. Follow [the owner guide](../../../../docs/operations/human-review.md) for decisions and conditional protection setup.

## Sub-features

- Exact-head CI/review certification and one owned ready PR.
- Same-PR refresh with fresh evidence and cumulative limits.
- Slot/token-free waiting, merge-first drain, and truthful assurance.
- Local attention/viewer gaps and conditional owner-applied protection.

## How to get to it (user POV)

1. Obtain explicit fixture, model-spend, VM, and scoped-controller grants. Owner reviews/merges, repository settings, and service deployment need separate authority. Only the owner changes `factory:enabled`.
2. Pin the tested commit and tree. Record the trusted main/gate SHA separately from the candidate SHA and admitted workflow SHA/digest. Run doctor and take the before snapshot from [SKILL.md](../SKILL.md). Commit before lane setup; setup ships committed HEAD only.
3. Allocate a unique `[F09a-<lane>]` issue and private state directory. Never run competing controllers on the same issue or replace production state. Reserve full specify, accept, build, review, and any planned retry allowances before launch. Do not lower a stage below the plan's rule unless testing exhaustion.
4. Before positive native reporter/P4 or runtime handoff proof, require the owner-merged bootstrap containing both `ci.yml` and `check.yml`. Without it, mark that proof blocked. Local emitter tests and historical scratch checks cannot substitute. Production protections remain owner-applied after supported P4.

All commands below run in the authorized VM lane checkout. `STATE`, `ISSUE`, `PR`, `HEAD`, and `RUN_ID` are captured fixture values, not invented IDs. Use the target's `GH_HOST` from `../targets.env` only there. Start from the standard lane setup, which creates the private state directory.

## Driving it with CLI and gh

### Drive one delivery

```bash
node host/cli/index.ts tick --once --json --repo nublai/pi-herdr-factorio --state-dir "$STATE" --issue "$ISSUE"
node host/cli/index.ts status --json --repo nublai/pi-herdr-factorio --state-dir "$STATE"
gh api "repos/nublai/pi-herdr-factorio/pulls/$PR"
gh api "repos/nublai/pi-herdr-factorio/commits/$HEAD/check-runs?filter=all&per_page=100"
```

The tick mutates state and can spend model tokens. It is not a preview. Use subsequent authorized scoped ticks to advance the recorded phase, or one scoped `drive-serve.sh` instance. Return an incomplete CI wait to the coordinator with its run ID and saved deadline; do not start a polling loop or duplicate dispatch.

Require one owned, non-draft `factory:review` PR on `factory/pr/<issue>-<runId12>`, targeting main with the owner requested. Record the actual run trailer, ref head, PR head, label, review request, issue handoff comment, and their read-back. Require nonterminal `waiting` at merge. A lost create response must reconcile that same PR, including closed/merged discovery, never open a second PR.

### Verify the identities before calling it ready

- Recompute the private patch, acceptance, and held-out digests. Inspect Git commit parents through `gh api "repos/nublai/pi-herdr-factorio/git/commits/$HEAD"`. For a published-PR refresh, require ordered parents `[new patch commit, previous published head]` on the final suite-bearing head before CI and review. Do not create a merge commit after certification.
- Record repair round, generation, intent digest, review execution ID/attempt, original base, certified base, admitted workflow pin, CI run/gate, dispatch nonce, and reporter check ID. Verify `generation.json`, immutable archives, verdict, review receipt, and certification against the private book. Keep private bytes off public evidence.
- Require complete hard receipt v2, including `install` and all eight mandatory checks, each passing once, plus any receipt-required checks. Require nonempty held-out identity and zero CI model calls. Bind the reporter's `factory-report` record to actual check ID, run/head/gate/nonce, workflow/event/main ref, bot actor and triggering actor. Require exact completed-success `check` at the final PR head too.
- Check `filter=all` and complete `total_count`. Duplicate reports, truncated lists, foreign same-named statuses, skipped/cancelled/missing checks, stale heads, or unrelated rollups cannot certify handoff. Do not use the compatibility job as factory proof. Factory heads and bot PRs must get `factory-compatibility`, not a skipped `factory-gates` job.

### Cover refresh, waits, and interruption

1. With an authorized base-movement fixture, record the predecessor before refresh. Require the same PR, fresh immutable generation, new CI and new review seats. Promotion uses expected-predecessor reads and `force:false`, not CAS. During ref/PR lag, require not-ready; after convergence, wait for the ordinary PR check.
2. Compare account/attempt floors before and after refresh/restart. Refresh consumes no repair but does consume one of three run-wide refreshes. The shared bounds stay two repairs, three issued reviews per round, six generations, 30k review/50k repair per round, and the configured 500k run cap. Respect configured review limits one/two. Early retry-5 acceptance is not five review attempts. No old-seat carry, same-patch rebind, or reset run is permitted.
3. Leave a certified PR waiting for two ticks. Compare private usage, issued attempts, execution accounts, and model gateway requests before/after. Require zero new model calls and no model slot/timer while waiting. Use separate authorized fixtures to show normal capacity two remains available. Fresh review must consume normal capacity.
4. Under an explicit local-switch grant, hold before publication/handoff. Require no new publication/model/notification effects. Existing PR merge observation and stop/account/terminal bookkeeping remain possible. A switch hold is not proof an already-issued request was instantly aborted.
5. For stop/restart cases, capture the full execution descriptor and account state. Require every unsettled account to drain before terminal effects or workspace reuse. Keep callbacks charged to their original round/generation/attempt. Unknown spend or missing private evidence grants no new allowance. Use disposable state copies only for damage cases. Do not delete the live book or claims to force recovery.

### Observe real owner actions

Keep these lanes blocked until the owner acts on the named fixture PRs. Never impersonate the owner or merge a main-targeting fixture yourself.

- Owner merge must win from each tested PR-backed phase/restart before issue-close/unlabel/switch logic. Require actual merged head, distinct actual merge SHA, actor or unknown, stopped/charged work, and idempotent issue closure. A matching historical certificate remains `factory_verified` during refresh or readiness void; an unmatched head is `owner_override`.
- Owner closed-unmerged must cancel. `merged: false` plus synthetic `merge_commit_sha` is not a merge.
- With missing private evidence, require blocked work and visible gaps. A narrow recorded merge observation must not fabricate certification, account totals, terminal completion, or budget.
- For protection, have the owner read back the two rulesets and disabled Actions approval after applying the conditional policy. Require no-bypass integrity/check rules, app15368 `check` plus `factory-gates`, strict up-to-date checks, and separate one-approval/stale-dismiss with the role-5 admin PR exception. The exception must not bypass failed checks.

Historical scratch results are bounded component evidence, not production enforcement. The corrected audit retains duplicate reporter fixtures, a failed initial CI setup, and a faulty guard self-test. Missing checks under the two-rule exception and bot approval of another author's PR were not separately tested. Do not reuse the self-test or label those cases passed. Record any new proof only under its own grant and exact identities.

### Check attention and the viewer

Use [status JSON](status-json.md), [the registered command](factory-status.md), and [the viewer recipe](viewer.md). Compare the same VM-local private state. Require six groups with disabled `spec_review`, truthful unknown ages and gaps, and no duplicate blocked/PR-ready item. Require the viewer to separate published historical certification from selected working generation and active execution. Receipt/session/gateway totals and accounting high-water are different evidence; gaps must remain visible.

## Gotchas

### Return evidence and clean only owned work

Save command, timestamps, exact tested head/tree, fixture URLs, all binding identities, expected/actual behavior, exit codes, model-call expectations and actual usage under the lane evidence directory. Label each result `source-checked/unrun`, `local saved-state/fake transport`, `historical scratch`, or `native VM/Actions/owner action` as appropriate. These labels are not interchangeable. Formal accounting 1200s and Controller 1800s both timed out with exit 143; neither is a pass or a reported counterexample. Full crash/manifest/max-marker, main-backed P4, owner-action, full swarm, and live/perf qualification remain separate obligations.

The coordinator owns CI waits, integration, verdicts, and external cleanup authority. The lane stops its recorded controller/viewer PIDs, closes every owned fixture and confirms CLOSED, and removes only exact authorized validation refs after preserving evidence. Never delete the stable PR ref, owner refs, private books, or claims as a generic cleanup step. Take the after snapshot. Run lane cleanup only after private evidence needed by later lanes is preserved and its hashes verified. No exposure, deployment, settings change, or merge is authorized by this recipe.
