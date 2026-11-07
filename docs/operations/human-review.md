# Review and merge a factory PR

Use this guide to inspect a factory handoff, decide whether to merge, and confirm the controller recorded your action. The factory never merges or arms auto-merge. Approval alone does not resume an automatic merge path.

F09a implements this protocol locally. Main-backed reporter/P4 proof, production protection, real owner-action lanes, and live/performance qualification remain pending. A source check, scratch GitHub experiment, or saved-state test is not a certified factory run. See the [plan's F09a gates](../plans/factory-v1.md#hand-off-verified-prs-and-require-human-merge-f09a) and [formal proof limits](../statecharts/README.md).

## Inspect the handoff

1. Open the issue's handoff comment and follow its PR and CI links. Expect one non-draft PR against `main`, on `factory/pr/<issue>-<runId12>`, labeled `factory:review`, with the repository owner requested. The controller adopts only its own bot PR with the matching repository, base, branch, and run trailer. It reconciles a lost create response rather than opening another PR.
2. Compare the PR head with the handoff candidate SHA. Inspect the contract summary, changed paths, findings, and family disclosure. The suite-bearing candidate is the exact commit certified before handoff. Its held-out check files remain visible in the PR and inert on `main`. They are not builder inputs.
3. Inspect both required checks on that head. `check` is the ordinary PR check. `factory-gates` must come from the main-owned dispatch and its separate reporter, not a same-named job or a green rollup. Use the [CI identity reference](factory-cli.md#trusted-candidate-gates-f07b) when auditing receipts.
4. On the VM, read status without advancing the controller:

```bash
node server/cli.ts status --json --repo giuseppecrj/pi-herdr-factorio --state-dir "$STATE"
```

`STATE` is the existing private controller state directory. Set `GH_HOST=github.int.exe.xyz` only in the trusted VM environment, never on your workstation. Status reads the workflow through `gh` and local evidence from disk. It launches no model and writes no marker. `executionEnabled: false` at the top level describes this status command, not the daemon's readiness.

Expect `waiting` at the merge checkpoint and one `attention.groups.pr_review` entry. Waiting is nonterminal, holds no model slot, spends no tokens, and schedules no model timer. The controller still polls. Two other model stages can use the normal capacity of two.

Do not merge from a label alone. A PR can remain open while its readiness is withdrawn. Status and the [viewer](viewer.md) distinguish the published certificate from work in progress.

## Handle a changed base or blocked handoff

If `main` moves, let the controller refresh the same PR within its existing allowances. Refresh reapplies the stored patch and acceptance bytes, builds the final candidate, then runs fresh CI and fresh review. An unchanged patch does not preserve review because its base can change behavior. Old seats and receipts are never rebound to a new generation.

For a successor, the suite commit has ordered parents `[new patch commit, previous published head]` before CI and review. Promotion checks the expected predecessor, writes with `force:false`, and rereads the ref. This protects ancestry, not atomic expected-head compare-and-swap. The PR API can lag the ref. Handoff waits for both heads to converge, then requires the ordinary PR `check` on the promoted head.

If status reports a blocked PR, inspect its reason and evidence gaps before acting. Limits remain cumulative across refresh and restart:

- At most three refreshes per run, two shared repairs, and six retained generations.
- At most three issued review attempts per repair round, or the stricter configured value of one or two. Early-stage `retry.max_attempts: 5` remains valid without raising that review ceiling.
- Review shares 120,000 tokens per round. Repair build shares 200,000. The configured run limit is currently 800,000 tokens. Failed, interrupted, fallback, and child usage remains charged. Existing wall and turn limits still apply per attempt.

Before the first PR, complete failing CI or blocking review can use the shared repair allowance. After a PR exists, conflict, failure, or exhaustion leaves it open, not-ready, and observed. F09a does not implement F10's owner-comment repair loop. Do not delete private state or start a replacement run to reset the same handoff's budget. Escalate unresolved holds with the run ID, PR head, reason, and redacted evidence.

## Merge or close as the owner

1. Recheck the current head and required checks in GitHub. If you accept the patch, merge through your owner account. The factory has no merge command. A review approval is not itself a merge.
2. If you reject the delivery, close the PR without merging. The controller records `cancelled`, not `landed`. A closed PR's non-null synthetic `merge_commit_sha` is not proof of a merge.
3. After the next controller ticks, read status and the viewer again. A merge observation takes precedence over issue closure, label removal, switch holds, and working refresh state in every PR-backed phase, including restart. The controller stops captured work and reconciles known charges before terminal bookkeeping or workspace reuse. It records the actual merged head and merge SHA, with an unknown actor when GitHub supplies none, then closes the issue idempotently.

Check assurance separately from current readiness. A merged head with matching complete historical certification is `factory_verified`, even if another generation was refreshing. A merged head without a matching certificate is `owner_override`. Neither label proves the exact time at which GitHub changed relative to a later poll. F09b's durable ledger writer remains separate work.

If private candidate evidence is unavailable, preserve it as a gap. The narrow existing-PR observer can record a merge observation, but cannot reconstruct certification, accounts, terminal completion, or fresh budget from public markers.

## Hold work without losing its history

For read-only diagnosis, use `status`, `/factory status`, the viewer, and repository-scoped GitHub reads. `/factory run <issue>` is only an admission dry run, not a dispatch or recovery command.

If you have explicit VM/state-write authority, create the local `disabled` entry to hold new claims, model launches, publication, and handoff notifications. The hold retains claims. Existing-PR merge observation and necessary stop/account/terminal bookkeeping continue. Removing the entry permits eligible work to resume. Only the owner creates or deletes the repository's `factory:enabled` label.

Do not stop a service, change its checkout, edit claims, or delete private books as part of diagnosis. Those actions require explicit service or VM authority. Switching off is not an instantaneous abort of already-issued model work.

## Roll forward from a drained controller

Use this sequence only under a deployment grant. This documentation is not that grant.

1. Stop admitting new work under the authorized hold procedure. Let in-flight executions settle and their charges become durable. Arrange owner disposition of any open PR-backed run before the version change.
2. Confirm the old controller is drained, then stop it under the service grant. Preserve the private state, claims, and evidence. A snapshot is diagnostic preservation, not a supported arbitrary backup-rollback guarantee.
3. Install the approved revision and any required sandbox bundle under the VM grant. Restart one controller against the preserved state. Check readiness and status before allowing new work. A merge of the build PR alone does not deploy it.
4. Keep v1/v2 records as generation-zero history. Never revive a terminal F08 `stage_passed` run. New v3 markers are compact and limited to 4096 UTF-8 bytes. Do not roll older controllers back over this new history. There is no migration daemon.

Missing or corrupt private books block candidate work. Do not recreate a book from a marker, remove claims to force replay, or promise recovery from power loss or manually rolled-back private files. The [sandbox reference](sandbox.md) describes private execution evidence and the [CLI reference](factory-cli.md#markers) describes public marker fields.

## Bootstrap and enable protection as the owner

Keep runtime handoff disabled until the main-backed proof is complete. Follow these owner-only gates in order:

1. Review and merge the one F09a bootstrap containing both approved workflow edits, `ci.yml` and `check.yml`, after local gates and independent review. Keep native Actions/P4, owner-action, live, and perf boxes pending. Do not treat the F08 exception as an F09a pass.
2. Run the supported main-backed reporter/P4 recipes at the recorded main and candidate SHAs. Confirm read-only candidate execution and a separate checks-write reporter with no candidate checkout or artifact-supplied code. `check.yml` uses `factory-compatibility`, not `factory-gates`, for factory heads and bot PRs. A skipped job under the required name can satisfy GitHub and is not acceptable proof.
3. Only after that proof, apply two separate active rulesets targeting `refs/heads/main` in repository **Settings > Rules > Rulesets**. Keep the integrity/check ruleset without bypass actors. Require a PR, `check` and `factory-gates` from GitHub Actions app `15368`, and strict up-to-date checks. Preserve deletion and force-push protection. Use squash-only PRs. In the integrity rule, keep the approval count at zero. The separate approval rule supplies the one-approval requirement.
4. In the separate approval ruleset, require one approval and dismiss stale approvals on push. The tested approval-only exception is `actor_type: RepositoryRole`, `actor_id: 5`, `bypass_mode: pull_request`. It covers every eligible repository admin, currently the owner, not a permanently named username. Do not add that exception to the integrity/check ruleset. The tested shape leaves code-owner review, last-push approval, required thread resolution, and extra approval for unattributed changes off. A zero approval count plus the unattributed-change flag alone did not require approval in the scratch cases.
5. Keep GitHub Actions approval disabled in **Settings > Actions > General > Workflow permissions**. Read back the applied rules and permissions, then run the authorized native enforcement lanes. Record unsupported permission reads as blocked, not clean. The tested integration update of an owned scratch rule returned 403. Production settings remain owner-only.

The scratch evidence supports this conditional two-rule shape, not current production enforcement. It observed bot self-approval denial, Actions approval denial, bot merge denial without approval, and an admin approval exception that did not bypass failed checks. It did not separately test missing checks under the two-rule exception, the integration approving another author's PR, or a second foreign App. The corrected historical audit found duplicate reporter fixtures, a failed initial CI setup, and a faulty guard self-test. Those are not native P4 passes. GitHub role policy also cannot prove a human is at the keyboard or protect against future permission changes. Reverify when eligible identities or permissions change.

## Keep proof labels and private evidence intact

Use the [F09a verification recipe](../../.pi/skills/verify-factory/features/handoff.md) for lane prerequisites and cleanup ownership. Keep saved-state/fake-transport checks separate from real VM, Actions, and owner-action results. F08's accepted gaps remain tracked in [issue 543](https://github.com/giuseppecrj/pi-herdr-factorio/issues/543). R8 cross-family review remains incomplete. Both substantive formal explorations timed out, not passed. Never export raw private sessions or held-out material into a PR or repair session.
