# Review and merge a factory PR

Use this guide to inspect a factory handoff, decide whether to merge, and confirm the controller recorded your action. The factory never merges or arms auto-merge. Approval alone does not resume an automatic merge path.

F09a implements this protocol locally. Main-backed reporter/P4 proof, production protection, real owner-action lanes, and live/performance qualification remain pending. A source check, scratch GitHub experiment, or saved-state test is not a certified factory run. See the [plan's F09a gates](../plans/factory-v1.md#hand-off-verified-prs-and-require-human-merge-f09a) and [formal proof limits](../statecharts/README.md).

## Inspect the handoff

1. Open the issue's handoff comment and follow its PR and CI links. Expect one non-draft PR against `main`, on `factory/pr/<issue>-<runId12>`, labeled `factory:review`, with the reviewers named by `handoff.reviewers` in the run's pinned `WORKFLOW.md` requested. The controller adopts only its own bot PR with the matching repository, base, branch, and run trailer. It reconciles a lost create response rather than opening another PR.

   The reviewers are an explicit trusted setting, today `giuseppecrj`. Handoff never derives a reviewer from the repository owner, which for `nublai/pi-herdr-factorio` is an organization. A run pinned to a `WORKFLOW.md` from before the field existed requests no reviewer. Its handoff still completes and the controller logs `event=handoff_reviewer_unconfigured` with the issue, run, PR and pinned workflow SHA, so request a reviewer by hand. If the pinned file cannot be read or no longer matches its recorded digest, handoff waits and retries rather than guessing.
2. Compare the PR head with the handoff candidate SHA. Inspect the contract summary, changed paths, findings, and family disclosure. The suite-bearing candidate is the exact commit certified before handoff. Its held-out check files remain visible in the PR and inert on `main`. They are not builder inputs.
3. Inspect both required checks on that head. `check` is the ordinary PR check. `factory-gates` must come from the main-owned dispatch and its separate reporter, not a same-named job or a green rollup. Use the [CI identity reference](factory-cli.md#trusted-candidate-gates-f07b) when auditing receipts.
4. On the VM, read status without advancing the controller:

```bash
node server/cli.ts status --json --repo nublai/pi-herdr-factorio --state-dir "$STATE"
```

`STATE` is the existing private controller state directory. Set `GH_HOST=github.int.exe.xyz` only in the trusted VM environment, never on your workstation. Status reads the workflow through `gh` and local evidence from disk. It launches no model and writes no marker. `executionEnabled: false` at the top level describes this status command, not the daemon's readiness.

Expect `waiting` at the merge checkpoint and one `attention.groups.pr_review` entry. Waiting is nonterminal, holds no model slot, spends no tokens, and schedules no model timer. The controller still polls. Two other model stages can use the normal capacity of two.

Do not merge from a label alone. A PR can remain open while its readiness is withdrawn. Status and the [viewer](viewer.md) distinguish the published certificate from work in progress.

## Handle a changed base or blocked handoff

If `main` moves under a factory-authored head, let the controller refresh the same PR within its existing allowances. Refresh reapplies the stored patch and acceptance bytes, builds the final candidate, then runs fresh CI and fresh review. An unchanged patch does not preserve review because its base can change behavior. Old seats and receipts are never rebound to a new generation.

For a successor, the suite commit has ordered parents `[new patch commit, previous published head]` before CI and review. Promotion checks the expected predecessor, writes with `force:false`, and rereads the ref. This protects ancestry, not atomic expected-head compare-and-swap. The PR API can lag the ref. Handoff waits for both heads to converge, then requires the ordinary PR `check` on the promoted head.

If status reports a blocked PR, inspect its reason and evidence gaps before acting. Limits remain cumulative across refresh and restart:

- At most three refreshes per run, two shared repairs, and six retained generations.
- At most three issued review attempts per repair round, or the stricter configured value of one or two. Early-stage `retry.max_attempts: 5` remains valid without raising that review ceiling.
- Review shares 120,000 tokens per round. Repair build shares 300,000. The configured run limit is currently 800,000 tokens. Failed, interrupted, fallback, and child usage remains charged. Existing wall and turn limits still apply per attempt.

Before the first PR, complete failing CI or blocking review can use the shared repair allowance. After a PR exists, conflict, failure, or exhaustion leaves it open, not-ready, and observed. An authorized change-request review can start one feedback repair on the same PR at a stage boundary. Do not delete private state or start a replacement run to reset the same handoff's budget. Escalate unresolved holds with the run ID, PR head, reason, and redacted evidence.

## Submit review feedback

On an open factory PR, the controller reads conversation comments, submitted reviews and each review's inline comments. It classifies each item once. Only a submitted **Request changes** review from an actor with repository write access, reviewing the promoted head, is actionable. Conversation comments, approvals, questions and dismissed reviews do not request repair. The factory ignores its own messages. A failed permission read defers intake rather than treating the author as unauthorized.

Intake waits until the PR head, branch ref and promoted certified head agree. A review on a successor being promoted is not consumed as stale. A genuinely old-head review is refused. Inline comments under `test/acceptance/` are refused; their text and diff hunks never enter feedback cards or the private full-text file. The review body is the owner's own text and is forwarded when actionable.

An actionable review becomes a durable queued batch. At the next idle boundary, the controller durably records `not_ready: feedback_repair`, then removes `factory:review` and posts one repair-start notice on the issue **before** issuing a build. A restart between the label write and its acknowledgement retains that readiness withdrawal. Any held-out inline refusal gets its own intake notice without quoting the text. Busy stages keep their work; feedback waits in the book. The builder works from the current factory patch in a fresh sanitized workspace. It cannot push or reply. The controller validates and reviews the repaired candidate, promotes it onto the same PR, and restores readiness only after fresh exact-head proof.

Feedback shares the existing two-round cap and cumulative budgets with repairs made before publication. An exhausted cap, refused preflight, or unusable current assessment produces one explanation with no build, no budget reset, and no readiness change. A blocking repaired review, failed validation, unchanged patch (`repair_no_progress`), repeated blocking finding (`repair_repeated_finding`), or unavailable evidence holds the published run rather than failing it. A stopped feedback round cannot regain readiness from its old certificate. A later authorized change request may request another round within the remaining allowances. An unchanged patch does not advance the round: the next change request reuses it with attempt +1, still under the attempt cap and cumulative round and run budgets.

Queued F10-1 batches are picked up without another intake notice. Batches carry forward across controller refreshes only along the promoted generation lineage with the **same patch digest**; the raw head SHA need not remain the same. Dismissing all actionable reviews, an owner push, or promotion of that or a later repair supersedes a queued batch. An owner push enters the owner-head recertification path below, never a feedback build.

Each completed or stopped round posts one keyed summary on the PR, including rounds that hold or are cancelled by closing the PR or withdrawing the issue. Cancellation stops and charges active work before the summary and terminal record. A merge interrupts the round with a merged receipt instead of a summary; an owner push supersedes it through the drift path. Other notices stay on the issue; there are no per-comment replies or PR-body edits. The summary lists dispositions and the new head when one exists. Adoption is explicitly **builder-reported**, not proof by the controller. Unreported decisions are recorded as `builder_declined`; held-out inline items are rejected without quoting them. Reviewers receive the same owner cards and earlier findings. Later rounds block only on an unfixed earlier finding or a concrete defect in the repair diff. Each finished attempt has an immutable private `round-<n>-a<k>.json` receipt. The `round-<n>.json` index names the latest attempt, its outcome and its receipt; that latest receipt is the final round receipt. Earlier attempts remain readable. The controller updates its own keyed summary in place with cumulative attempts and the latest result, PATCHing only when the body differs. A deleted summary is recreated; a foreign author's forged key is never edited. Receipt and index recovery after a restart needs no rebuild. A stopped batch is settled before its summary is attempted, and a failed summary write remains owed across restart or main movement. Its hold age is the original observation time, not the epoch or a later retry time. Pending PR checks and API/ref lag are temporary waits, not stopped rounds; they resume when the forge converges. Successful handoff settles only the batch that built the certified repair, never unrelated applying feedback.

Private batches and, when truncated, their digest-bound full-text JSON live under `handoff/<run>/feedback/`, mode 0600. Cards are capped at 8 KiB and carry path and line hints. When GitHub omits `line`, the controller maps `position` or `original_position` through the PR's file diff when available. A truncated card's full forwarded text is written as `.factory-feedback-full.json` in the repair workspace; both feedback filenames are protected paths and are removed before collecting the patch. If metadata alone exceeds that bound, the batch records `overflow: true` with empty cards and the complete forwardable text bound by digest. Intake records and the seen cursor are committed before the run holds as `feedback_overflow`. A torn content-addressed file is restored from the expected payload with an atomic write.

The book's seen set and batch status survive restarts. Cursor overflow also holds as `feedback_overflow`, without consuming unstored events. Both overflow holds wait for the current stage to settle, appear in attention with their original age, and post one keyed issue notice. They leave readiness and budgets unchanged. While held, intake reads only reviews for dismissals of stored batches; it does not classify new feedback again. The owner can still merge or close the PR. A notice whose POST failed is retried after checking for its bot-authored key. Pre-F10 books still load with an empty feedback cursor; do not roll an older controller back over new feedback history.

After merge, a model-free sweep checks landed ledger PRs at most once an hour per PR. A non-empty write-access review submitted after the merge files one deduplicated `factory:proposed` issue, regardless of review state. Conversation comments never file proposals. Held-out inline text is not quoted. The proposal has no `factory:ready` label and cannot be admitted automatically. Feedback never revives a terminal run.

## Push an owner change

The factory never builds on or overwrites an owner commit. At the next eligible observation, a changed PR ref stops and charges active model work, supersedes queued or applying feedback, removes `factory:review`, and posts one issue notice keyed by the owner head H. An already-issued effect finishes at its boundary first. Readiness stays withdrawn during recertification.

The controller derives H's patch against current `main`. The compare must be strictly `ahead`; identical, behind and diverged heads are refused. The full held-out tree must match the trusted suite and unchanged base acceptance files. Forbidden paths, incomplete tree reads and a diff over the existing review bound also refuse certification. Acceptance files are replaced with the base's tree **before** patch collection. The private owner receipt and patch live at `handoff/<run>/owner/<H>-<base>.json`, mode 0600, independently of round-keyed builder patches. Legacy head-only files are adopted only when their recorded base matches. A reset detected before derivation skips the abandoned head without CI or a failure notice. Unreadable derivation retries on later ticks, at most three attempts including the first; exhaustion holds with the refusal reason visible.

The owner validator skips builder patch reads, builder visible tests and candidate commit publication. It creates or adopts only a temporary `factory/run/<issue>-<run12>-r<n>-g<n>` pin at H, then dispatches the trusted workflow on `main` with `candidate_sha = H` and the generation nonce. There are no separate base or gate SHA inputs. No factory commit or write to `factory/pr/*` occurs. Existing cleanup removes only the pin, and only if its tip is still H.

The trusted gates and fresh review must both pass on H. Review receives the stored owner patch in a sanitized workspace, never the held-out files; its builder family is explicitly unavailable. Success restores readiness through the ordinary handoff and records an owner-origin certification. Failure or refusal holds with one issue notice per head and reason. A completed failing ordinary `check` on a certified head also withdraws readiness and posts one notice for that head. Holds retain their original age. A new owner push can be recertified within the existing generation and review allowances; generation 3 or a full history holds `refresh_limit` before derivation.

**Coverage limit:** changes that touch only test files can appear in the trusted receipt's `ignoredChanges`. In that case `candidate_tests` may not execute owner-added tests. A green exact-head receipt is not proof that every new owner test ran. No gate is weakened to hide this limit.

An authorized change request on an owner-authored head is refused as `owner_authored_head`, with a notice and no build. If `main` moves under a promoted owner head, or while an owner generation is validating or reviewing, the run holds `owner_head_behind` and asks the owner to update the branch. Automatic reconciliation is not implemented. Resetting the branch to its previously promoted certified head restores that historical handoff after its exact-head checks are confirmed. Any running owner review is stopped and charged first. The restored factory generation becomes current for feedback and repair. Failed owner generations and cumulative usage remain in the book; neither retained evidence nor allowances are rewound. Later owner generations use the next unused slot. A later push to the owner head requires recertification again.

A merge of a certified owner head remains `factory_verified`; version 5 ledger assurance adds `authored: "owner"`. Factory-authored certificates use `authored: "factory"`. A failed or unrecognized owner head is `owner_override` if merged. Versions 1–4 retain their exact bytes. Roll forward after deploying the new book or row format; older controllers cannot interpret owner-origin history.

## Merge or close as the owner

1. Recheck the current head and required checks in GitHub. If you accept the patch, merge through your owner account. The factory has no merge command. A review approval is not itself a merge.
2. If you reject the delivery, close the PR without merging. The controller records `cancelled`, not `landed`. A closed PR's non-null synthetic `merge_commit_sha` is not proof of a merge.
3. After the next controller ticks, read status and the viewer again. A merge observation takes precedence over issue closure, label removal, switch holds, and working refresh state in every PR-backed phase, including restart. The controller stops captured work and reconciles known charges before terminal bookkeeping or workspace reuse. It records the actual merged head and merge SHA, with an unknown actor when GitHub supplies none, then closes the issue idempotently.

Check assurance separately from current readiness. A merged head with matching complete historical certification is `factory_verified`, even if another generation was refreshing or repairing. A merge of the old certified head during feedback repair records that assurance together with `not_ready: feedback_repair`; it stops and charges captured work and marks the in-flight batch merged. Readiness withdrawal is an advisory merge fence, not a draft conversion or a forced failing check. A merged head without a matching certificate is `owner_override`. Neither label proves the exact time at which GitHub changed relative to a later poll. F09b's durable ledger writer remains separate work.

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

Use the [F09a verification recipe](../../.pi/skills/verify-factory/features/handoff.md) for lane prerequisites and cleanup ownership. Keep saved-state/fake-transport checks separate from real VM, Actions, and owner-action results. F08's accepted gaps remain tracked in [issue 543](https://github.com/nublai/pi-herdr-factorio/issues/543). R8 cross-family review remains incomplete. Both substantive formal explorations timed out, not passed. Never export raw private sessions or held-out material into a PR or repair session.
