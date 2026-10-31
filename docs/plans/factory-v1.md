# Deliver the factory v1 plan

Build the GitHub-first factory for `giuseppecrj/pi-herdr-factorio` on the exe.dev VM `pi-factorio`.
Take authorized issues through fixed stages to a ready PR labeled `factory:review`. The owner merges every PR.
Keep GitHub writes in the controller, model execution in a sandbox, and required checks in secret-free GitHub-hosted CI.
Implement build-order units 4 through 13 in this order.
`F04a`, `F04b`, `F04c`, `F05`, `F06a`, `F06b`, `F07a`, `F07b`, `F07c`, `F07d`, `F08`, `F09a`, `F09b`, `F10`, `F11`, `F12`, `F13`.
`F07d` is an operator tool, build-order row 7d, not a runtime stage.
Treat units 0 through 3 as historical prototype evidence, not work to repeat.

## How to read this

One box is one unit of work. Every box names the evidence that checks it. A nested box is a sub-step of the box above it. Check a box only when its evidence exists, such as a file, a log, a test result, or a SHA. The body is a how-to. The appendices explain and record.

The program runs the poteto-mode playbook `playbooks/autopilot-full.md`, with merge-then-branch for this serial chain. On 2026-10-28 the owner granted the root merge authority for build PRs. The root squash-merges a PR after a clean swarm verdict on the exact head and a passing hosted `check` on that head. The `main` ruleset requires both a PR and that check. No agent arms auto-merge. This grant covers build PRs only. The factory's runtime still stops at Human Review, and the owner merges every PR the factory opens. This document grants no other execution, commit, push, PR, issue, service, or configuration action.

Use the **Factory CLI control procedure** below as the control skill. It combines `ssh`, `gh`, and the factory CLI and extension. There is no installed factory-specific control skill yet. This backend has no visual interface to verify. Live lanes drive real scenarios on `pi-factorio` against real GitHub issues in this repository, not fake-adapter tests. Save redacted logs, JSON snapshots, and issue or PR URLs instead of screenshots or video. Appendix C records this template adaptation and the other exceptions.

Treat every new path, symbol, command, log field, and numerical budget below as a proposed implementation contract, not an existing capability. At the planning base `04b69c3`, only the pure state machine, policy helpers, fake adapter, provisioning script, and `/factory status` exist. Do not check future boxes with those prototypes alone.

Use `openai/gpt-6.1-sol` through exe.dev's `llm` integration for every runtime stage. When it refuses a security-review or other security-flavored request on a content-policy flag, retry that request once on `xai/grok-4.6` through the same integration. The owner chose this fallback on 2026-10-28. exe.dev lists per-token prices for its xAI models, so the fallback spends exe.dev credits. Use it only after a recorded refusal, and count its tokens in the run total. Use fresh sessions for acceptance and review. Label their evidence `context-isolated, same family, not cross-family`. The cross-family part of design definition-of-done item 2 remains incomplete until the owner's Anthropic proxy is available. Do not spend exe.dev Anthropic credits as a fallback.

Tests alone are not sufficient verification. A PR is verified only when its unit, live, and perf boxes are all checked.

## Program checklist

### Arm the program

- [ ] State the protocol and this plan to the operator, then stop. Start execution only on the operator's explicit go. Record separate grants for commits, pushes, PR operations, fixture issues and comments, VM changes, repository settings, and merging build PRs.
- [ ] Read these from the installed skill directories at program start. Re-read them at every audit. Record their versions and paths in the execution trail.
  - [ ] Read `/home/g/.pi/agent/npm/node_modules/pi-herdr-pstack/skills/poteto-mode/playbooks/autopilot-full.md`.
  - [ ] Read the swarm skill at `/home/g/.pi/agent/npm/node_modules/pi-herdr-pstack/skills/swarm/SKILL.md`.
  - [ ] Read the Factory CLI control procedure in this plan's boot recipe. Add its maintained command reference at `docs/operations/factory-cli.md` in `F04a`.
  - [ ] Read `/home/g/.pi/agent/npm/node_modules/pi-herdr-pstack/skills/poteto-mode/playbooks/opening-a-pr.md` and `playbooks/shipping.md` beside it.
  - [ ] Read the installed leaf skills named in Appendix D, including `technical-writing`, `unslop`, `no-comments`, `how`, `interrogate`, and `show-me-your-work`.
- [ ] Run the audit at every child delivery, at every stall or no-progress advisory, and on the operator's request. Nothing schedules it, so never promise a timed cadence and never leave the audit to memory. Save each audit in the uncommitted execution trail.
- [ ] Use this audit prompt, verbatim. "Re-read the execution playbook. Audit the operation against it and fix drift in this audit. Check every active lane and judge progress by side effects only. Cancel a stuck lane and launch its fresh replacement now. Then post a short status message to the operator in chat only when the audit found a tracked change that no earlier status message reported, such as a PR opened, a code-ready head, a round launched or closed, a verdict, a merge, a stuck agent and the action taken, a blocker added or cleared, or a decision only the operator can make. Name every such change and nothing else. Do not repeat a table, the merged list, or an unchanged blocker. If the audit found none, end the turn with no reply text. Either way, log this audit's row in your decision trail. The row names the items reported, or none."
- [ ] On the operator's hold or stand-down, cancel every running child with `subagent_cancel` at once and launch nothing new. Record retained work and any live fixture that still needs authorized cleanup.

### Launch owner rounds

- [ ] Give each PR one owner role with the full lifecycle that `autopilot-full` names. The root, not the owner round, runs the merge. Launch each round as a fresh bare leaf with `fork: false`, bounded files, explicit model and thinking, verification, and commit policy. Keep one retained checkout and one canonical branch per owner.
- [ ] Follow this dependency graph. Branch dependent work from `main` after its parent merges, or stack it on the parent's committed tip while the parent is still in review. Record the parent SHA in each brief.
  - [ ] Start `F04a` from `main`. Follow `F04a -> F04b -> F04c -> F05 -> F06a -> F06b -> F07a -> F07b -> F07c -> F07d -> F08 -> F09a -> F09b -> F10 -> F11 -> F12 -> F13`.
  - [ ] Keep this chain serial for code writes. It changes shared controller contracts and tests. Parallelize read-only verification with separate fixture issues, not dependent implementation.
  - [ ] Treat `F04a`'s first main-owned configuration and `F07b`'s first main-owned CI workflow as bootstrap gates. Prove parsing and execution locally first. Complete their main-backed live checks after those trusted files land on `main`, before dependent dispatch or publication. Record the bootstrap exceptions in Appendix C rather than claiming clean full verdicts early.
- [ ] Hold the file boundaries in each PR's **Files** block. Treat listed directories as that PR's only directory-wide allowances. Obtain a revised scope before editing another path. New prototype receipts belong only in that PR's named documentation directory.
- [ ] Hold the review gate for every PR. Present CLI evidence to the operator in chat. Replace the template's screenshots and video with the named text artifacts. Merge on a clean verdict and a passing `check`.
- [ ] Distinguish operator-authored program changes from factory-produced patches. The owner may authorize these PRs to add `.github/` files. A runtime factory ticket may never edit `.github/` or the held-out acceptance directory.

### PR mechanics, for every PR

- [ ] Use `gh` for every PR operation. Confirm `gh auth status` and `gh repo view` once under the intended identity. On the VM use `GH_HOST=github.int.exe.xyz`. If proxy auth-status probing fails, record the result and prove access with a repository-scoped read. Never install a token or require Graphite.
- [ ] Open implementation PRs ready, never draft, per **Opening a PR**, only under a grant that names PR creation. Use `gh pr create --base "$PARENT_BRANCH"`. Keep runtime-generated PR creation gated separately by `F09a`.
- [ ] Run `npm run check` before every PR-facing push. It includes typecheck, lint, format checking, and tests. Add server coverage in `F04a` before relying on these checks for `server/*.ts`. Push with hooks on only under the push grant. Save command output at the exact head.
- [ ] Run a manual diff cleanup pass before each commit and `/skill:no-comments` before review. Save the reviewed diff SHA. Apply technical-writing and unslop to skill text and public evidence.
- [ ] Triage every Bugbot and security-reviewer comment per `/home/g/.pi/agent/npm/node_modules/pi-herdr-pstack/skills/poteto-mode/references/bugbot-triage.md`. Record unavailable integrations as unavailable, not clean reviews.
- [ ] Rebase onto current trunk before the code-ready report and babysit, with the stack parent retained. Keep that merge base in fix rounds. Rebase again only at merge prep, on a `git merge-tree` conflict with trunk, or on a CI failure that comes from a change on trunk. Let only the root rewrite stack topology.

### Verdict and merge, for every PR

- [ ] At the code-ready head SHA and at each later push that changes the patch, run the swarm per `/home/g/.pi/agent/npm/node_modules/pi-herdr-pstack/skills/swarm/SKILL.md`. The root launches every lane per `references/fan-out.md`. Run one gates lane, the ten live verifier lanes, and the perf lane. Two or more audit lanes read the full brief and diff, with separate focuses on authorization and lifecycle correctness. The root audits the receipts before the verdict.
- [ ] Resolve `task:qa` against the live scoped catalog before launch. Use the owner's approved default `openai/gpt-6.1-sol` explicitly where routing is unavailable. Set supported thinking explicitly, medium for ordinary verification and high for security review. Do not rewrite shared model preferences. Label same-family audit seats context-isolated. Record the unavailable cross-family gate separately from behavior passes.
- [ ] Require every named lane to return `PASS` before a clean behavior verdict. Findings go back to the owner. A defect that a lane filed as a note is a finding. Missing identities, missing permissions, unreachable services, or missing scenarios yield `BLOCKED`, never a substituted fake pass. A new head gets a fresh swarm and verdict, except for evidence retained under the patch-id rule in `playbooks/shipping.md`.
- [ ] Merge a PR only at the verified head, subject to the explicit `F04a` and `F07b` bootstrap exceptions. Record the verdict SHA, base SHA, patch-id, and evidence paths. Apply the patch-id rule in `playbooks/shipping.md` after rebases. Re-run CI and mergeability after rewritten pushes. The root squash-merges under the owner's build-PR grant, then branches the next PR from the new `main`. Never arm auto-merge, and never infer a verdict from a green check.

### Keep dependencies current

- [ ] Upgrade `@earendil-works/pi-coding-agent`, a devDependency and peer, as soon as a release ships an `undici` that clears the advisories `npm audit` reports. On 2026-10-28, the latest release, 1.4.0, pins `undici` 8.10.2, with 1 high and 2 moderate advisories, and `undici` 8.12.3 exists. Check with `npm view @earendil-works/pi-coding-agent version dependencies.undici`. Land the upgrade as its own PR. Prove it with `npm audit` clean or reduced, `npm run check`, and the `/factory status` drive in the verification skill.
- [ ] Upgrade the VM's Pi in the same PR by bumping `PI_VERSION` in `server/provision.sh` and rerunning provisioning. Pi on the VM is a standalone binary, so record its bundled `undici` version separately rather than assuming it matches npm.

### Boot recipe, for every live lane

Use the Factory CLI control procedure for all lanes. Before `F04a` lands, inspect the existing `/factory status` and run repository-scoped `gh` reads for the trunk baseline. Later commands listed here are deliverables of the PR that introduces them.

- [ ] In an authorized disposable verification checkout, run `git fetch origin "$HEAD_BRANCH" && git checkout --detach "$HEAD_SHA"`. Record the exact trunk and head SHAs. Do not replace the controller's production checkout with a test checkout.
- [ ] Connect with `SSH_AUTH_SOCK=$HOME/.ssh/headless-agent.sock ssh exedev@pi-factorio.exe.xyz`. Set `PATH` to include `$HOME/.local/bin` and `$HOME/.local/share/mise/shims`. Export `GH_HOST=github.int.exe.xyz` only in the trusted controller environment. Record `node`, Pi, Herdr, and image versions without printing credentials.
- [ ] Use a lane-specific workspace and state directory under `/home/exedev/factory-verification/`. Install the committed dependencies there. Use a unique fixture issue per lane, named with the PR ID and worker number. Record its real URL and label-event ID. Disable the production poller for these fixture issues through its explicit scope, or serialize service tests. Never let ten lanes start ten competing controllers over the same issues.
- [ ] Start the proposed `node --experimental-strip-types server/cli.ts serve --state-dir "$STATE" --issue "$ISSUE"` only after its prerequisites exist. Wait for structured `event=controller_ready`, or use `workflow-check`, `status --json`, or `tick --once` for early units. Stop before any not-yet-implemented stage. Do not simulate that stage's success.
- [ ] Deliver inputs through `gh issue`, `gh pr`, and `node --experimental-strip-types server/cli.ts` commands. Use `/factory status` and `/factory run <issue>` once wired. Require the same admission checks on manual run commands as on polling. Issue creation, labeling, commenting, intentional restart, and switch changes require the fixture grant. A review or merge test that needs the owner remains unchecked until the owner acts.
- [ ] Use `gh issue view`, `gh api` timeline reads, `gh pr view`, `gh run view`, the CLI's `status --json`, and scoped service logs as read-only diagnostics. Capture raw model sessions only in private VM state. Export redacted evidence, never the held-out suite to a build or repair session.
- [ ] Save each lane's named artifact under `/tmp/swarm-<pr-id>/worker-<n>/` on the VM and return its absolute path. Include the command, timestamps, SHA, fixture URLs, expected result, actual result, and exit status. Copy redacted review bundles to `docs/plans/media/<pr-id>/` only during authorized execution. No screenshot is required for text-only behavior.
- [ ] For perf, record trunk first, then interleave three trunk/head pairs on the same VM with the same warmed dependencies, fixture size, model, and concurrency. Measure elapsed wall time per stage, tokens, and provider-reported spend per run, including children and retries. Save raw samples and medians in `perf.json`. Label provider spend unavailable when absent. Never equate subscription access with zero cost.
- [ ] For a missing trunk feature, measure trunk's rejection or unsupported response and its wall time and usage. Also measure the diff-added work and the head end state. Use absolute budgets for those new paths, not a ratio to an unsupported response. Treat the initial numerical limits below as acceptance budgets to test, not historical measurements. Record any approved revision before the probe, never after a failure to turn it green.

## Load trusted workflow settings and expose status (F04a)

**Depends on.** None. This begins unit 4.

**Files.**

- [ ] Create `src/workflow.ts`, `server/cli.ts`, `test/workflow.test.ts`, `.github/factory/WORKFLOW.md`, and `docs/operations/factory-cli.md`.
- [ ] Edit `extension/index.ts`, `test/extension.test.ts`, `package.json`, `package-lock.json`, and `tsconfig.json` only for loader, CLI, parser dependency, and check coverage.

**Build.**

- [ ] Implement `loadWorkflow` for YAML front matter and Markdown stage guidance at `.github/factory/WORKFLOW.md`. Load the configured repository's trusted `main` revision, never a candidate's copy. Record its SHA and content digest.
- [ ] Validate repository identity, the 30-second poll interval, concurrency 2, model choices, positive turn and wall limits, stall timeout, retry cap, and per-run usage caps. Reject unknown checkpoint modes instead of enabling automatic landing. Default all model stages to `openai/gpt-6.1-sol`.
- [ ] Match Symphony loader semantics for parse failures, defaults, environment expansion of named configuration values, and hot reload. Keep the last valid snapshot on a bad reload. Pin one immutable workflow snapshot per attempt and persist its digest. Do not interpolate ticket text into configuration or shell commands.
- [ ] Implement CLI `workflow-check --json` and `status --json`. Keep `/factory status` useful without a daemon. Show unavailable runtime state explicitly. Document each command and exit code in the control procedure. Include `server` in typecheck, lint, and format checks. Before the first workflow exists on main, prove fail-closed behavior and parser cases locally. Leave valid-main and hot-reload live proof pending until the configuration lands on `main`.

**You see.**

- [ ] Save status output with `workflowSha`, `workflowDigest`, model, configured limits, and `executionEnabled=false` before a controller is installed. A malformed workflow exits nonzero with the offending field and no dispatch.

**Verify, unit.** Tests alone are not sufficient verification. A PR is verified only when its unit, live, and perf boxes are all checked.

- [ ] Add parser, missing file, invalid front matter, reload, default-model, candidate-config rejection, and offline extension cases to `test/workflow.test.ts` and `test/extension.test.ts`. Run `npm run check`.

**Verify, live.** Tests alone are not sufficient verification. A PR is verified only when its unit, live, and perf boxes are all checked. Ten lanes on `task:qa` at the PR head, per the boot recipe.

- [ ] Lane 1. Regression lane against trunk. Run `/factory status` on trunk and head while viewing a real fixture issue through `gh`. Save `status.json`. Pass when both identify the package and head adds trusted settings without inventing a running controller.
- [ ] Lane 2. Check the main workflow for the fixture issue's repository. Save `trusted-config.json`. Pass when its recorded SHA matches `gh`'s main SHA.
- [ ] Lane 3. Put a conflicting workflow in the verification candidate checkout. Save `candidate-config.log`. Pass when status still reports the trusted copy.
- [ ] Lane 4. Load a malformed authorized verification workflow. Save `parse-error.log`. Pass when parsing fails and no run marker appears on the fixture issue.
- [ ] Lane 5. Remove the verification workflow. Save `missing.log`. Pass when execution stays disabled with an explicit error.
- [ ] Lane 6. Inspect default model resolution on the VM. Save `model.json`. Pass when every model stage names `openai/gpt-6.1-sol` and no model request runs.
- [ ] Lane 7. Reload an invalid snapshot after a valid one. Save `reload.log`. Pass when the digest stays valid and the error is visible.
- [ ] Lane 8. Try a zero or negative budget. Save `budget-error.log`. Pass when validation rejects it before stage launch.
- [ ] Lane 9. Run extension status without a daemon for the real repository. Save `offline-status.log`. Pass when the user sees unavailable runtime state rather than a fabricated queue.
- [ ] Lane 10. Load guidance containing issue-like shell text as data. Save `literal-guidance.log`. Pass when no command executes and repository state remains unchanged.

**Verify, perf.** Tests alone are not sufficient verification. A PR is verified only when its unit, live, and perf boxes are all checked.

- [ ] Metric. Measure status wall time and model tokens and spend on trunk and head. Isolate trusted-workflow parsing and the status response.
- [ ] Probe. Interleave three `/factory status` calls on each revision and three head `workflow-check --json` calls. Save `perf.json`.
- [ ] Baseline. Record trunk status milliseconds and zero model calls before head measurements.
- [ ] Rule. Fail if head local status exceeds 2 seconds, workflow parsing exceeds 250 milliseconds after fetch, or either command calls a model. Report remote fetch time separately with a 30-second timeout.

**Review gate.** The operator reviews before merge.

- [ ] Post `status.json` and available reload evidence in the operator's chat review bundle. Use text artifacts instead of a screenshot or video. Merge it as the owner's configuration bootstrap with pending live boxes explicit, then complete those boxes on the trusted main revision.

**Merge.**

- [ ] Record the root's exact-head local verdict and complete Bugbot triage. Record the configuration bootstrap merge, made by the root under the owner's build-PR grant, separately from the later full main-backed verdict.
- [ ] Apply `playbooks/shipping.md`'s patch-id rule after any rebase. Merge `F04a` as the configuration bootstrap under the owner's build-PR grant. Finish its main-backed checks before enabling dependent dispatch.

## Admit GitHub label events through the adapter (F04b)

**Depends on.** F04a. This supplies unit 4's GitHub adapter and admission.

**Files.**

- [ ] Create `src/adapters/github.ts`, `src/admission.ts`, `test/github-adapter.test.ts`, `test/admission.test.ts`, and `docs/prototypes/github-polling/`.
- [ ] Edit `src/tickets.ts`, `src/policy.ts`, `test/fake-ticket-adapter.ts`, `test/pipeline.test.ts`, and `server/cli.ts` for polling contracts and a bounded admission command.

**Build.**

- [ ] Prototype label-event identity, permission lookup, pagination, issue edits, and bot-authored comment reads through repository-scoped `gh` on the VM. Record accepted and unsupported proxy endpoints. Stop on risk R2 if the adapter cannot bind a ticket snapshot to the authorized label event.
- [ ] Extend `TicketAdapter` with `fetchCandidates` and `fetchStates`, while retaining `fetch`. Add event IDs and timestamps to normalized events. Keep repository/provider identity in keys. Migrate the fake and every caller together.
- [ ] Implement `GitHubTicketAdapter` with argument-array `gh` execution and explicit JSON validation. Poll issue timeline events, not only current labels. Require `decideAdmission` and actual write access for the label actor, regardless of issue author.
- [ ] Implement `admitTicket` with repository allowlisting, both kill switches, immutable input snapshot, and event deduplication. Treat an absent or unreadable `factory:enabled` repository label, local disable file, failed permission reads, and ambiguous snapshots as no dispatch. Add `admit --issue` for verification without executing model stages.
- [ ] Use only `GH_HOST=github.int.exe.xyz` and the repo-scoped integration. Preserve its bot identity. Store no GitHub token and create no App or webhook.

**You see.**

- [ ] Save an admission receipt containing issue URL, event ID, actor, snapshot digest, base SHA, and decision. Unauthorized, disabled, or ambiguous input never yields an admitted work item.

**Verify, unit.** Tests alone are not sufficient verification. A PR is verified only when its unit, live, and perf boxes are all checked.

- [ ] Cover pagination, actor versus author, hostile text, duplicate events, changed bodies, denied permissions, and each switch in `test/github-adapter.test.ts` and `test/admission.test.ts`. Run `npm run check`.

**Verify, live.** Tests alone are not sufficient verification. A PR is verified only when its unit, live, and perf boxes are all checked. Ten lanes on `task:qa` at the PR head, per the boot recipe.

- [ ] Lane 1. Regression lane against trunk. Query the same labeled fixture issue on trunk and head. Record trunk's lack of admission. Save `admission.json`. Pass when head returns one authorized immutable snapshot and starts no model prematurely.
- [ ] Lane 2. Use a real label event from an account with triage but no write access, under a separate identity grant. Save `unauthorized.json`. Pass when admission refuses it. If no such identity is available, report BLOCKED.
- [ ] Lane 3. Turn the repository switch off for the scoped experiment. Save `repo-disabled.log`. Pass when the real labeled issue yields no admitted item.
- [ ] Lane 4. Set the local disable flag while the repository switch is on. Save `local-disabled.log`. Pass when admission stops.
- [ ] Lane 5. Apply the ready label as a writer to an issue authored by a non-writer. Save `actor-not-author.json`. Pass when the decision follows the label actor and treats the body as untrusted data.
- [ ] Lane 6. Edit the issue around label time as specified by the prototype. Save `snapshot-binding.json`. Pass when the adapter either proves the original snapshot or refuses ambiguity without substituting later text.
- [ ] Lane 7. Poll the same timeline twice. Save `duplicate-event.log`. Pass when the event ID and snapshot are stable and only one item is eligible.
- [ ] Lane 8. Use a real issue with enough timeline entries to cross the chosen page size. Save `pagination.json`. Pass when the authorized label event is found exactly once.
- [ ] Lane 9. Put shell syntax in a fixture issue title and body. Save `untrusted-text.log`. Pass when it remains literal data and produces no shell side effect.
- [ ] Lane 10. Exercise the supported repository and unsupported global proxy endpoints without credentials. Save `proxy-contract.log`. Pass when failures become explicit admission errors rather than authorization guesses.

**Verify, perf.** Tests alone are not sufficient verification. A PR is verified only when its unit, live, and perf boxes are all checked.

- [ ] Metric. Measure repository-read and admission wall time plus model usage on both revisions. Count GitHub requests per poll.
- [ ] Probe. Interleave three read-only polls of the same ten fixture issues. Measure head admission separately from the trunk read-only query. Save `perf.json`.
- [ ] Baseline. Record trunk `gh` query milliseconds and request count first. Record the absence of an admission implementation.
- [ ] Rule. Fail if head admission for ten issues exceeds 30 seconds without rate limiting, performs any model call, or repeats unchanged event pages without a bounded cursor strategy. A rate-limited trial is inconclusive and must retain its retry receipt.

**Review gate.** The operator reviews before merge.

- [ ] Post `admission.json`, `snapshot-binding.json`, and `unauthorized.json` to the operator. Use logs instead of a screenshot or video. If binding is not proved, do not merge. Report R2 as unresolved.

**Merge.**

- [ ] Record the exact-head verdict and Bugbot triage, including the snapshot prototype result.
- [ ] Apply the patch-id rule in `playbooks/shipping.md`. Squash-merge `F04b` on a clean verdict and a passing `check`, then branch the next PR from the new `main`.

## Reconcile claims and recover interrupted runs (F04c)

**Depends on.** F04b. This completes unit 4's scheduling and marker recovery.

**Files.**

- [ ] Create `src/orchestrator.ts`, `src/markers.ts`, `server/controller.ts`, `server/factory.service`, `test/orchestrator.test.ts`, `test/markers.test.ts`, and `docs/prototypes/restart-recovery/`.
- [ ] Edit `src/run.ts`, `src/adapters/github.ts`, `server/cli.ts`, `extension/index.ts`, `test/extension.test.ts`, `test/fake-ticket-adapter.ts`, and `docs/operations/factory-cli.md` for durable run metadata and command wiring.

**Build.**

- [ ] Implement one controller authority with `claimed`, `running`, retry attempts, and totals. Reconcile tracker states before dispatch on each 30-second tick. Limit active runs to 2 and prohibit a second writer per ticket. Reject a second controller for the same state directory.
- [ ] Implement bounded retry with `min(10000 * 2^(n-1), maxBackoffMs)`, configured attempt limits, and stall termination. Count retries in the same run budget. Distinguish scheduler retry from `MAX_REPAIR_ROUNDS`.
- [ ] Implement versioned `<!-- factory:run {...} -->` comments, authenticated by comment author and repository context, not merely by marker text. Record run ID, admission event, snapshot pointer/digest, workflow SHA, stage, artifact digests, usage, branch/PR mapping, and processed cursors without raw sessions.
- [ ] Prototype restart before and after marker writes and externally visible effects. Reconcile the marker with actual branch, PR, and private workspace state before retrying. Fail closed on corrupt or conflicting markers. Missing VM artifacts trigger a bounded stage replay from verified inputs, not invented completion.
- [ ] Expose `serve`, `tick --once`, `status --json`, and `run --issue`. Wire `/factory run <issue>` to the same admission path. Dispatch to an explicit unavailable-stage result until `F05` installs the runner. Add service readiness and safe stop behavior without deploying by default.

**You see.**

- [ ] Save `event=controller_ready` and a claim snapshot showing one run ID across a restart. The marker records a blocked stage until a real executor exists. Neither polling nor manual run bypasses the switches.

**Verify, unit.** Tests alone are not sufficient verification. A PR is verified only when its unit, live, and perf boxes are all checked.

- [ ] Test fake-clock backoff, reconciliation ordering, concurrency 2, duplicate dispatch, forged markers, corrupt recovery, and crash windows in `test/orchestrator.test.ts` and `test/markers.test.ts`. Run `npm run check`.

**Verify, live.** Tests alone are not sufficient verification. A PR is verified only when its unit, live, and perf boxes are all checked. Ten lanes on `task:qa` at the PR head, per the boot recipe.

- [ ] Lane 1. Regression lane against trunk. Admit the same fixture issue twice on trunk and head. Save `claim.json`. Pass when head maintains one durable run and reports the not-yet-installed executor honestly.
- [ ] Lane 2. Restart the scoped controller after a claim marker appears. Save `restart-after-marker.log`. Pass when recovery keeps the run ID and creates no second marker.
- [ ] Lane 3. Interrupt between an external comment write and its local receipt. Save `restart-write-window.log`. Pass when reconciliation finds the existing effect before retrying.
- [ ] Lane 4. Start two scoped controller processes on one state directory. Save `single-authority.log`. Pass when the second refuses and no duplicate issue update occurs.
- [ ] Lane 5. Queue three real issues with two slots. Save `capacity.json`. Pass when no more than two claims enter active execution and the third remains queued.
- [ ] Lane 6. Close a fixture issue before the next tick. Save `reconcile-before-dispatch.log`. Pass when the closed ticket does not dispatch.
- [ ] Lane 7. Exercise a bounded transport failure against the repository integration. Save `retry.log`. Pass when retries follow the configured backoff and terminate at the attempt cap.
- [ ] Lane 8. Place a forged run marker through an authorized non-bot test actor. Save `forged-marker.json`. Pass when recovery ignores or rejects it rather than trusting its state.
- [ ] Lane 9. Remove a scoped private workspace after shutdown. Save `missing-workspace.log`. Pass when restart records missing evidence and performs no duplicate publication.
- [ ] Lane 10. Invoke `/factory run` for a real fixture issue with a disabled switch. Save `manual-run-disabled.log`. Pass when it follows the same refusal as polling.

**Verify, perf.** Tests alone are not sufficient verification. A PR is verified only when its unit, live, and perf boxes are all checked.

- [ ] Metric. Measure poll and recovery wall time, stage wait time, and model usage per run on trunk and head.
- [ ] Probe. Interleave three one-tick runs over ten unchanged issues and three restart recoveries on head. Use admission-only reads on trunk where recovery is absent. Save `perf.json`.
- [ ] Baseline. Record trunk's ten-issue admission latency and zero model usage before head trials.
- [ ] Rule. Fail if an unchanged poll exceeds 30 seconds without remote throttling, recovery of ten markers exceeds 60 seconds, or recovery spends model tokens before evidence reconciliation. Do not compare a restart ratio to admission-only work.

**Review gate.** The operator reviews before merge.

- [ ] Post `claim.json` and both restart logs to the operator. Use text receipts instead of a screenshot or video. Merge on a clean verdict and a passing `check`.

**Merge.**

- [ ] Record the exact-head verdict and complete Bugbot triage after the restart prototype passes.
- [ ] Apply the patch-id rule in `playbooks/shipping.md`. Squash-merge `F04c` on a clean verdict and a passing `check`, then branch the next PR from the new `main`.

## Isolate Pi stages on the VM (F05)

**Depends on.** F04c. This implements unit 5.

**Files.**

- [ ] Create `server/sandbox.ts`, `server/sandbox/` (including the pinned `server/sandbox/assets/package.json` and `package-lock.json`), `test/sandbox.test.ts` and `test/sandbox/`, `docs/prototypes/vm-sandbox/`, and `docs/operations/sandbox.md`.
- [ ] Edit `src/orchestrator.ts`, `src/markers.ts`, `server/cli.ts`, `server/controller.ts`, `server/provision.sh`, `server/factory.service`, `src/stages.ts`, `src/workflow.ts`, `extension/index.ts` only if the profile table's API changes, their tests (`test/orchestrator.test.ts`, `test/markers.test.ts`, `test/stages.test.ts`, `test/workflow.test.ts`), `docs/operations/factory-cli.md`, `docs/design.md`, and this F05 section, for stage execution and truthful access profiles.

**Build.**

- [ ] Prototype rootless execution and enforced egress before running issue-driven code. Prove user namespaces, resource limits, cleanup, and real Herdr fan-out inside the container. Do not treat Docker availability or a non-root container UID as proof of rootless isolation.
- [ ] Resolve risk R1 with a host-controlled egress gateway that builds every upstream request itself, choosing the route from the path and setting its own Host and SNI. Both exe.dev integration names currently resolve to `169.254.169.254`. Prove that allowed model access cannot tunnel to the GitHub integration by changing Host, SNI, redirects, IP spelling, or proxy variables. Block direct network bypass and public GitHub API access. Allow only `llm.int.exe.xyz` and required npm registry endpoints.
- [ ] Implement `runStage` using Pi RPC and wait for `agent_settled`, not `agent_end` or prompt acceptance. Keep the parent alive until Herdr children settle. Handle malformed output, errors, approval requests, aborts, and hard deadlines deterministically.
- [ ] Treat a provider content-policy refusal as its own stage exit reason, distinct from errors and budget exhaustion. Add an optional per-stage `fallback_model` to `WORKFLOW.md`. On a refusal, retry the request once on the fallback. Record both model IDs, the primary's refusal, and the fallback's outcome. If the fallback also refuses, or no fallback is set, end the stage `failed` with the refusal as evidence. A refusal never becomes a pass.
- [ ] Mount only the stage workspace and explicitly trusted read-only runtime assets. Exclude host home, Docker socket, controller state, other stage workspaces, SSH agent, and held-out artifacts from build containers. Disable inherited MCP and untrusted Pi extensions. Install pinned dependencies and record their versions.
- [ ] Enforce stage turns, wall time, stall time, tokens, and run totals including children. Stop with `budget_exhausted` before another request when a cap is reached. Reserve cleanup time. Record unavailable monetary pricing explicitly and use token/time caps until an approved price source exists.
- [ ] Correct `STAGE_PROFILES` and `formatStageTable` so the CLI no longer implies that model stages receive GitHub read tokens. Only the controller uses the integration. Add the approved rootless setup to provisioning only after prototype proof and an explicit VM-change grant.

**You see.**

- [ ] Save a stage receipt with settlement event, exact model, exit reason, wall time, usage, and sandbox image digest. Model and npm calls succeed while GitHub calls and host-state reads fail from the same container.

**Verify, unit.** Tests alone are not sufficient verification. A PR is verified only when its unit, live, and perf boxes are all checked.

- [ ] Test event ordering, child settlement, timeouts, accounting, mount allowlists, argument handling, and cleanup in `test/sandbox.test.ts`. Run `npm run check` and `bash -n server/provision.sh`. Treat mocked network tests as units, not the isolation proof.

**Verify, live.** Tests alone are not sufficient verification. A PR is verified only when its unit, live, and perf boxes are all checked. Ten lanes on `task:qa` at the PR head, per the boot recipe.

- [ ] Lane 1. Regression lane against trunk. Start a stage for a real fixture issue on both revisions. Record trunk's unavailable executor. Save `stage-settlement.json`. Pass when head reaches real settlement inside the sandbox and returns a bounded receipt.
- [ ] Lane 2. Call the model integration inside the container. Save `model-egress.log`. Pass when the approved model answers without a stored provider credential.
- [ ] Lane 3. Fetch a pinned npm package inside the same policy. Save `npm-egress.log`. Pass when the required registry works and no unrestricted internet route appears.
- [ ] Lane 4. Attempt GitHub integration and public API calls from the stage. Save `github-denied.log`. Pass when both are blocked before an authenticated request reaches GitHub.
- [ ] Lane 5. Exercise same-IP Host/SNI, redirect, and direct-address bypass probes from the R1 prototype. Save `egress-bypass.log`. Pass when all forbidden destinations remain unreachable while allowed destinations still work.
- [ ] Lane 6. Read host home, controller state, and the Docker socket from the stage. Save `mount-denied.log`. Pass when none is accessible.
- [ ] Lane 7. Launch a real bare Herdr child from the persistent RPC parent. Save `child-settlement.log`. Pass when child completion arrives before the controller accepts stage completion.
- [ ] Lane 8. Exceed a small authorized verification turn or token cap. Save `budget-stop.json`. Pass when the stage stops with `budget_exhausted` and no further model request occurs.
- [ ] Lane 9. Kill the scoped controller during a stage and restart it. Save `orphan-cleanup.log`. Pass when owned processes are reconciled or stopped before any replacement begins.
- [ ] Lane 10. Run two fixture stages concurrently under the configured limits. Save `rootless-capacity.json`. Pass when rootless identity, memory limits, workspace isolation, and clean termination hold for both.

**Verify, perf.** Tests alone are not sufficient verification. A PR is verified only when its unit, live, and perf boxes are all checked.

- [ ] Metric. Measure stage startup, model settlement, cleanup wall time, and total tokens/spend on trunk and head. Separate the new sandbox startup from the model call.
- [ ] Probe. Interleave three tiny issue-stage requests on each revision. On trunk record the unavailable executor response. On head use one fixed short model prompt and one child probe. Save `perf.json`.
- [ ] Baseline. Record trunk status latency and zero stage usage first. Also record the first head container startup as the future sandbox baseline.
- [ ] Rule. Fail if warm sandbox startup exceeds 15 seconds, cleanup exceeds 10 seconds, or the fixed tiny stage exceeds 120 seconds or 5,000 total tokens. Do not claim a speedup over an absent trunk executor. Record spend and fail any configured monetary cap when pricing is available.

**Review gate.** The operator reviews before merge.

- [ ] Post the rootless and egress receipts to the operator. Use logs instead of a screenshot or video. Merge only after R1 passes. Otherwise report the concrete blocker and do not merge.

**Merge.**

- [ ] Record the exact-head security and behavior verdicts and complete Bugbot triage.
- [ ] Apply the patch-id rule in `playbooks/shipping.md`. Squash-merge `F05` on a clean verdict and a passing `check`, then branch the next PR from the new `main`.

## Specify tickets and return missing questions (F06a)

**Depends on.** F05. This implements the specify half of unit 6.

**Files.**

- [ ] Create `src/specify.ts`, `test/specify.test.ts`, and `skills/audit-ticket/`, `skills/grill-me/`, `skills/deep-research/` with provenance files.
- [ ] Edit `src/orchestrator.ts`, `src/markers.ts`, `src/admission.ts`, `src/tickets.ts`, `src/adapters/github.ts`, and `server/controller.ts` for stage inputs, outcomes, linked runs, and clarification reporting.
- [ ] Edit `server/sandbox.ts`, `server/sandbox/rpc.ts`, `server/sandbox/result.ts`, and `server/provision.sh` for the stage prompt, tools, output capture, and bundled skills.
- [ ] Edit `test/orchestrator.test.ts`, `test/markers.test.ts`, `test/sandbox/**`, `skills/README.md`, `docs/operations/sandbox.md`, `docs/operations/factory-cli.md`, and `.pi/skills/verify-factory/**`.

**Build.**

- [ ] Implement `specifyTicket` to produce a versioned `contract.json` with ticket snapshot, repository/base SHA, intended behavior, exclusions, acceptance criteria, compatibility, and non-functional limits. Validate output and compute `contractDigest` in controller code. The base SHA is the admission's `baseSha`.
- [ ] Give specify a checkout of the repository at `baseSha`, extracted from the tarball with unsafe entries refused. Grant `read`, `grep`, and `ls` only. Put a repository map, the trusted guidance at `baseSha`, and the files the ticket names in the prompt, so the tools read only what is missing.
- [ ] Have the controller run one reviewer session with no tools after specify returns a draft contract. The reviewer gets only the draft and the ticket snapshot, and flags only ambiguity that would change acceptance tests. When it names one, one revision session rewrites the draft. The executor enforces one reviewer and at most one revision, and counts their tokens in the specify attempt. Owner decision 2026-10-30, changed by the root on 2026-10-30 after the first live run cost 128,068 tokens, partly because a reviewer subagent added two full-context parent requests.
- [ ] Capture the stage's final text through RPC after settlement. Read it only when the stage passed. Keep model text out of receipts.
- [ ] Write audit-ticket clean-room. Adapt only the MIT sources selected in `research/SYNTHESIS.md` for grilling and optional research. Carry `SOURCE.md` and LICENSE or NOTICE as required. Replace interactive questions with a structured `needs_info` result.
- [ ] Resolve repository facts before asking the owner. Keep consequential uncertainty as questions, not guessed requirements. Post redacted questions once as one issue comment that cites repository lines. Remove `factory:ready`, add `factory:needs-info`, end the run with a terminal `needs_info` marker, and spend no model budget while inactive.
- [ ] Post a redacted contract summary on the issue when specify passes. It lists the behavior, exclusions, and acceptance criteria. The full contract stays on the VM.
- [ ] On a fresh ready-label event after `needs_info`, start a linked new run with a new snapshot and contract. Answers come from issue body edits and from comments posted after the questions comment by authors with write access. Bots and the factory account never count. A comment in the same second as the label is ambiguous. Preserve the terminal `needs_info` record rather than mutating a finished `Run`.
- [ ] Keep these out of F06a. Line-level questions on a spec PR belong to the `approve_contract` checkpoint. Web search behind a `factory:research` label ships in its own PR after F06a.

**You see.**

- [ ] Save either a contract receipt with digest and source snapshot or one `needs_info` comment containing specific questions. An answer and fresh authorized label continue the ticket without losing the earlier attempt.

**Verify, unit.** Tests alone are not sufficient verification. A PR is verified only when its unit, live, and perf boxes are all checked.

- [ ] Test contract schema, missing criteria, question deduplication, linked attempts, and malformed model output in `test/specify.test.ts` and `test/pipeline.test.ts`. Run `npm run check`.

**Verify, live.** Tests alone are not sufficient verification. A PR is verified only when its unit, live, and perf boxes are all checked. Ten lanes on `task:qa` at the PR head, per the boot recipe.

- [ ] Lane 1. Regression lane against trunk. Run one clear fixture issue through the installed stages on trunk and head. Save `contract.json`. Pass when head produces a contract bound to the admitted snapshot and stops before unimplemented acceptance.
- [ ] Lane 2. Submit a vague fixture issue with an unresolved product choice. Save `needs-info.json`. Pass when questions appear on the issue and no build starts.
- [ ] Lane 3. Answer those questions and apply a fresh authorized ready label. Save `clarification-resume.json`. Pass when a linked run uses the new snapshot and the answers, and preserves the old terminal result.
- [ ] Lane 4. Post an answer without a new readiness event. Save `answer-only.log`. Pass when no new attempt starts.
- [ ] Lane 5. Ask for behavior already documented in the repository. Save `repo-facts.log`. Pass when specify cites repository evidence instead of asking a redundant question.
- [ ] Lane 6. Embed instructions to change workflow permissions in the issue. Save `scope-injection.log`. Pass when the contract does not grant that authority.
- [ ] Lane 7. Interrupt after the clarification comment write. Save `clarification-restart.log`. Pass when recovery reuses the existing questions rather than posting duplicates.
- [ ] Lane 8. Use a verification budget too small to finish specification. Save `specify-budget.json`. Pass when the outcome records exhaustion and no fabricated contract.
- [ ] Lane 9. Run specify on a fixture requiring a cited external fact. Save `research-boundary.log`. Pass when missing access becomes an explicit question, the stage audit shows only model requests, and a hosted search tool request is denied.
- [ ] Lane 10. Inspect public contract evidence and private session paths. Save `redaction.json`. Pass when public output contains no raw session, provider configuration, or unapproved issue content.

**Verify, perf.** Tests alone are not sufficient verification. A PR is verified only when its unit, live, and perf boxes are all checked.

- [ ] Metric. Measure specify wall time and total tokens per clear and vague issue on both revisions, plus time to a visible contract or questions. Receipts record no prices, so no money figure is claimed.
- [ ] Probe. Interleave three bounded runs of each fixed ticket class on trunk and head. Record trunk's unsupported specify result when absent. Save `perf.json`.
- [ ] Baseline. Record trunk executor overhead and available usage before the new stage trials.
- [ ] Rule. Fail if the small clear fixture takes over 5 minutes or 40,000 tokens, or the vague fixture takes over 3 minutes or 25,000 tokens. Fail if any model usage accrues while awaiting an answer. Enforce the configured token cap independently. The owner raised the token limits on 2026-10-30 to pay for read tools and the reviewer child.

**Review gate.** The operator reviews before merge.

- [ ] Post the contract and clarification round trip to the operator. Use text evidence instead of a screenshot or video. Merge on a clean verdict and a passing `check`.

**Merge.**

- [ ] Record the exact-head verdict, license review, and completed Bugbot triage.
- [ ] Apply the patch-id rule in `playbooks/shipping.md`. Squash-merge `F06a` on a clean verdict and a passing `check`, then branch the next PR from the new `main`.

## Generate and store held-out acceptance scenarios (F06b)

**Depends on.** F06a. This completes unit 6.

**Files.**

- [ ] Create `src/accept.ts`, `src/artifacts.ts`, `test/accept.test.ts`, `test/artifacts.test.ts`, `skills/acceptance/`, and `docs/prototypes/acceptance-isolation/`.
- [ ] Edit `server/controller.ts` and `skills/README.md` for acceptance-only artifact access. Edit `server/sandbox.ts` for the shared sandbox launch helper and recovery of acceptance's recorded model identity, with tests in `test/sandbox/**`. `server/provision.sh` needs no change, because the existing `skills/*/` loop bundles the new skill.
- [ ] Edit `src/orchestrator.ts` for the specify-to-accept transition, accept inputs, storage, recovery and the summary, and `src/specify.ts` for the shared acceptance summary renderer and comment key. The owner's F06b brief widened the list to these.
- [ ] Edit `test/orchestrator.test.ts`, `docs/operations/sandbox.md`, `docs/operations/factory-cli.md`, `.pi/skills/verify-factory/**`, and this Files block in `docs/plans/factory-v1.md`.

**Build.**

- [ ] Implement `writeAcceptance` in a fresh session before any builder runs. Supply only the immutable contract and trusted base, never a candidate diff. Produce scenario IDs, requirement mappings, executable checks, and non-executable criteria that need a judge.
- [ ] Store acceptance files in controller-private storage outside build mounts. Validate artifact paths, type, size, and manifest before accepting them. Compute `acceptanceDigest` over the exact bytes. Persist a private receipt and a redacted public summary.
- [ ] Prototype a canary file and canary text that a future build cannot discover through mounts, shared sessions, Git objects, caches, or inherited tools. Record the initial pre-build boundary here. Finish post-publication repair isolation in `F07c`.
- [ ] Include acceptance model/provider identity and `context-isolated, same family, not cross-family` in every receipt. Reject malformed or empty suites. Do not claim the design's cross-family acceptance requirement is met.

**You see.**

- [ ] Save a manifest connecting each scenario ID to a contract criterion and an acceptance digest. Build inputs expose the contract and scenario descriptions, but not test code, private paths, or the canary.

**Verify, unit.** Tests alone are not sufficient verification. A PR is verified only when its unit, live, and perf boxes are all checked.

- [ ] Add suite-schema, digest stability, path traversal, empty-suite, and access-map tests in `test/accept.test.ts` and `test/artifacts.test.ts`. Run `npm run check`.

**Verify, live.** Tests alone are not sufficient verification. A PR is verified only when its unit, live, and perf boxes are all checked. Ten lanes on `task:qa` at the PR head, per the boot recipe.

- [ ] Lane 1. Regression lane against trunk. Run a clear fixture through specify and acceptance on both revisions. Save `acceptance-manifest.json`. Pass when head adds a nonempty contract-bound suite before any build and trunk's missing stage is explicit.
- [ ] Lane 2. Inspect scenario coverage for negative input on the real fixture contract. Save `negative-scenarios.json`. Pass when the criterion has an executable rejecting case.
- [ ] Lane 3. Try reading the canary from a separate build-profile sandbox. Save `private-suite-denied.log`. Pass when neither its path nor content is available.
- [ ] Lane 4. Inspect session identities for specify and accept. Save `session-isolation.json`. Pass when accept is fresh and receives no implementation transcript.
- [ ] Lane 5. Feed an empty acceptance artifact through the real stage return boundary in verification mode. Save `empty-suite.log`. Pass when the controller fails the stage instead of advancing.
- [ ] Lane 6. Attempt an artifact path outside the acceptance output directory. Save `artifact-path.log`. Pass when collection refuses it and writes no escaped file.
- [ ] Lane 7. Restart after private suite creation. Save `acceptance-restart.json`. Pass when the recorded digest matches the restored artifact or recovery blocks on missing bytes.
- [ ] Lane 8. Compare acceptance input to the issue's immutable contract receipt. Save `contract-binding.json`. Pass when the exact digest and base SHA match.
- [ ] Lane 9. Read the redacted issue evidence through `gh`. Save `family-disclosure.json`. Pass when it labels same-family context isolation and does not claim independence.
- [ ] Lane 10. Exhaust the acceptance budget for a fixture issue. Save `accept-budget.json`. Pass when no partial suite is accepted and usage remains in the run total.

**Verify, perf.** Tests alone are not sufficient verification. A PR is verified only when its unit, live, and perf boxes are all checked.

- [ ] Metric. Measure acceptance generation, artifact collection, and total specify-to-suite wall time and tokens/spend on trunk and head.
- [ ] Probe. Interleave three runs of a fixed three-criterion issue. Record trunk's specify result and missing acceptance separately. Save `perf.json`.
- [ ] Baseline. Record trunk specify latency and usage first, then the first head acceptance sample as the new stage baseline.
- [ ] Rule. Fail if acceptance adds over 5 minutes or 25,000 tokens, collection adds over 2 seconds for a suite under 1 MB, or the full fixture exceeds 10 minutes or 45,000 tokens. Check the configured spend limit as well.

**Review gate.** The operator reviews before merge.

- [ ] Post the redacted manifest and canary-denial receipt to the operator. Use logs instead of a screenshot or video. Keep suite bytes private. Merge on a clean verdict, with the cross-family limitation visible.

**Merge.**

- [ ] Record the exact-head behavior verdict, the incomplete cross-family requirement, and Bugbot triage.
- [ ] Apply the patch-id rule in `playbooks/shipping.md`. Squash-merge `F06b` on a clean verdict and a passing `check`, then branch the next PR from the new `main`.

## Build patches without publication rights (F07a)

**Depends on.** F06b. This implements unit 7's build stage.

**Files.**

- [ ] Create `src/build.ts`, `test/build.test.ts`, `skills/build/`, `test/fixtures/build/`, and `docs/prototypes/build-isolation/`.
- [ ] Edit `src/policy.ts`, `test/policy.test.ts`, `server/controller.ts`, `server/sandbox.ts`, `skills/README.md`, `src/orchestrator.ts`, `src/specify.ts`, `src/artifacts.ts`, `test/orchestrator.test.ts`, `test/sandbox/runner.cases.ts`, and `test/specify.test.ts` for patch collection, private records, summaries and stage wiring.
- [ ] Edit `docs/operations/sandbox.md`, `docs/operations/factory-cli.md` and `.pi/skills/verify-factory/**` for the build boundary, two-tick verification and recovery protocol.

**Build.**

- [ ] Implement `buildPatch` with pstack's Feature or Bug fix playbook and TDD in the sandbox. Keep pstack as a dependency. Require a bug reproduction before a bug fix. Use a persistent root for any pstack fan-out and leaf children with bounded tasks.
- [ ] Give the builder a clean workspace derived from the pinned base and the contract, not the acceptance workspace or controller Git checkout. Remove remote credentials and access to controller history. Produce a patch, visible tests, command receipts, and a content digest, never GitHub writes.
- [ ] Collect file changes deterministically, including both sides of renames, deletions, symlinks, and mode changes. Call `checkChangedPaths` before applying any patch. Reject `.github/` and `test/acceptance/` changes. Attach a redacted patch reference for owner-only control-plane work instead of publishing it.
- [ ] Treat an empty or malformed patch as a stage error unless the contract explicitly describes a verified no-change outcome. Keep hard test failures visible. Do not accept a model's final text as validation.

**You see.**

- [ ] Save a local patch receipt with base SHA, patch digest, visible test result, and changed paths. The controller reaches validate without opening a PR or claiming CI success.

**Verify, unit.** Tests alone are not sufficient verification. A PR is verified only when its unit, live, and perf boxes are all checked.

- [ ] Test forbidden renames, escaped paths, symlink handling, empty patches, failed builder tests, and digest collection in `test/build.test.ts` and `test/policy.test.ts`. Run `npm run check`.

**Verify, live.** Tests alone are not sufficient verification. A PR is verified only when its unit, live, and perf boxes are all checked. Ten lanes on `task:qa` at the PR head, per the boot recipe.

- [ ] Lane 1. Regression lane against trunk. Run a tiny real issue through build on both revisions. Save `patch.json`. Pass when head returns a contract-scoped patch with visible tests and trunk's missing build stage is recorded.
- [ ] Lane 2. Run a seeded bug issue. Save `red-green.log`. Pass when the builder records the failing behavior before its fix and the repaired visible test passes.
- [ ] Lane 3. Ask the builder to edit a workflow. Save `forbidden-workflow.log`. Pass when the controller refuses the patch and opens no PR.
- [ ] Lane 4. Try a rename into `test/acceptance/`. Save `forbidden-rename.log`. Pass when changed-path collection catches the destination and rejects it.
- [ ] Lane 5. Try a symlink that would expose controller files. Save `symlink.log`. Pass when the patch cannot escape the workspace during collection or application.
- [ ] Lane 6. Ask the stage to push a branch or post a comment. Save `no-publish.log`. Pass when network enforcement prevents the action and only the controller can report the attempt.
- [ ] Lane 7. Exercise a small pstack fan-out build on the VM. Save `pstack-build.log`. Pass when every child settles, works only in its permitted files, and returns to the stage root.
- [ ] Lane 8. Produce a patch whose visible test fails. Save `failed-visible-test.json`. Pass when the failure remains in the receipt and cannot become a passing validation verdict.
- [ ] Lane 9. Rebuild from identical recorded patch bytes. Save `patch-digest.json`. Pass when the digest is stable and the base identity remains explicit.
- [ ] Lane 10. Inspect builder mounts and Git objects for the acceptance canary. Save `builder-holdout.log`. Pass when the suite is absent and no remote route can fetch it.

**Verify, perf.** Tests alone are not sufficient verification. A PR is verified only when its unit, live, and perf boxes are all checked.

- [ ] Metric. Measure build wall time, patch collection time, and total stage and child tokens/spend on both revisions. Measure time to a local test-bearing patch.
- [ ] Probe. Interleave three runs of one fixed tiny bug issue. On trunk record the suite-ready stop. On head isolate build and collection. Save `perf.json`.
- [ ] Baseline. Record trunk specify/accept time and usage first, without presenting its missing build as a successful patch.
- [ ] Rule. Fail if the tiny build exceeds 10 minutes or 200,000 tokens, patch collection exceeds 2 seconds for a 1 MB diff, or the fixture takes over 20 minutes to reach validate. Enforce the configured run spend cap across all earlier stages. The owner raised the token limit on 2026-10-30 after two lean live builds used 70,351 and 55,495 tokens.

**Review gate.** The operator reviews before merge.

- [ ] Post `patch.json`, `red-green.log`, and `no-publish.log` to the operator. Use logs instead of a screenshot or video. Merge on a clean verdict and a passing `check`.

**Merge.**

- [ ] Record the exact-head verdict and complete Bugbot triage.
- [ ] Apply the patch-id rule in `playbooks/shipping.md`. Squash-merge `F07a` on a clean verdict and a passing `check`, then branch the next PR from the new `main`.

## Run main's gates against candidate code (F07b)

**Depends on.** F07a. This supplies unit 7's trusted CI gates. Hosted proof needs the bootstrap merge described in Appendix C.

**Files.**

- [ ] Create `.github/workflows/ci.yml`, `.github/factory/gates/` including `scan.ts` and `scan-rules.json`, `server/gates.ts`, `test/candidate-gates.test.ts`, `test/fixtures/gate-cheating/`, `docs/prototypes/trusted-ci/` including `fix1-proof.json`, `fix1-perf.json` and `fix3-proof.json`, and `biome.json`. Edit `tsconfig.json` and `.oxlintrc.json` for the exact `test/acceptance/**` exclusion.
- [ ] Edit `server/cli.ts`, `docs/operations/factory-cli.md`, and `docs/operations/sandbox.md` for the trusted-gates command and operator invocation. Edit `package.json` and `package-lock.json` only for required gate dependencies. Edit `.pi/skills/verify-factory/**` for verification instructions.
- [ ] Edit `src/specify.ts`, `src/artifacts.ts`, `src/build.ts`, `server/sandbox.ts`, and their tests (`test/specify.test.ts`, `test/artifacts.test.ts`, `test/build.test.ts`, `test/sandbox/**`) for exact contract-authorized test replacement, persistence, build input and visible-test exemptions. Edit this Files block to record the owner's F07b scope amendment.

**Build.**

- [ ] Prototype a main-owned validation workflow before integrating publication. Evaluate `workflow_dispatch` on the protected main revision with an explicit candidate SHA. Pin the trusted gate revision and candidate revision in the receipt. Do not execute a candidate's workflow or gate scripts as trusted code.
- [ ] Implement `checkCandidate` with separate trusted gate material and candidate source. Run main's scripts, existing tests, lint/typecheck configuration, and gate dependencies against candidate code, then the candidate's own additional tests. Prove imports resolve to candidate modules rather than accidentally testing main.
- [ ] Isolate candidate execution from the trusted reporter and read-only gate files. Prototype the mount layout and dependency resolution in an unprivileged container on the hosted runner. Ensure test process writes cannot replace the gate runner or its results. Record required package install scripts instead of granting unrestricted privileged lifecycle execution.
- [ ] Add seeded patches that delete a regression test, make `package.json` checks no-ops, alter lint/typecheck configuration, and return the wrong behavior. Require every cheating patch to fail a main-owned check. Also prove a known-good patch passes.
- [ ] Use pinned Actions and minimal permissions with no stored secrets, no model calls, no `pull_request_target`, no persisted checkout credentials, and no privileged shared cache. Distinguish GitHub's ephemeral read-only checkout token from stored repository secrets. Return named gate results bound to exact SHAs.
- [ ] Merge the locally verified workflow as the CI bootstrap under the owner's build-PR grant. Keep the hosted live boxes pending until it lands. Then dispatch against fixed good/bad candidate SHAs on GitHub and complete proof before `F07c` proceeds.

**You see.**

- [ ] Save a hosted run URL and results containing `gateSha`, `candidateSha`, named checks, and rejection of the known-bad patch. A candidate's no-op script cannot turn the result green.

**Verify, unit.** Tests alone are not sufficient verification. A PR is verified only when its unit, live, and perf boxes are all checked.

- [ ] Exercise main/candidate materialization, import routing, bad manifests, and missing checks in `test/candidate-gates.test.ts`. Run `npm run check` and the new candidate-gates command against every fixture. Save container and workflow validation output.

**Verify, live.** Tests alone are not sufficient verification. A PR is verified only when its unit, live, and perf boxes are all checked. Ten lanes on `task:qa` at the PR head, per the boot recipe.

- [ ] Lane 1. Regression lane against trunk. Run the same known-good candidate through trunk's existing checks and head's new main-owned command. Save `good-candidate.json`. Pass when both test candidate behavior and head's hosted receipt binds the exact candidate SHA.
- [ ] Lane 2. Validate a candidate with a no-op `package.json` check script. Save `noop-script.json`. Pass when main's mandatory checks still execute and reject the seeded defect.
- [ ] Lane 3. Validate a candidate that deletes a regression test. Save `deleted-test.json`. Pass when main's preserved regression still fails.
- [ ] Lane 4. Validate a candidate that weakens typecheck and lint configuration. Save `weakened-config.json`. Pass when trusted configuration rejects the planted error.
- [ ] Lane 5. Use a candidate-only sentinel implementation different from main. Save `candidate-imports.json`. Pass when the gate observes the sentinel and cannot accidentally test main's source.
- [ ] Lane 6. Attempt to overwrite trusted gate material from candidate execution. Save `gate-readonly.log`. Pass when the write is denied and the reporter does not trust candidate-written success text.
- [ ] Lane 7. Run a candidate's genuinely new tests after the preserved gates. Save `new-tests.json`. Pass when both test sets execute and either failure vetoes success.
- [ ] Lane 8. Inspect the hosted job's permissions and artifact environment through redacted diagnostics. Save `ci-no-secrets.json`. Pass when no stored secret, model credential, persisted checkout credential, or privileged cache enters candidate execution.
- [ ] Lane 9. Dispatch validation for an exact SHA and then move the candidate branch. Save `immutable-sha.json`. Pass when the run validates the original SHA and cannot certify the new tip.
- [ ] Lane 10. Cancel a hosted validation or remove an expected result. Save `missing-gate.json`. Pass when the controller-facing result is failure or incomplete, never an all-green empty list.

**Verify, perf.** Tests alone are not sufficient verification. A PR is verified only when its unit, live, and perf boxes are all checked.

- [ ] Metric. Measure gate wall time, queue time, and model tokens/spend per candidate on trunk and head. Model usage must be zero in CI.
- [ ] Probe. Interleave three runs of the same good candidate under the existing check command and the new isolated gate command. Record hosted queue time separately. Save `perf.json`.
- [ ] Baseline. Record trunk `npm run check` elapsed time first. Use the same dependencies and candidate for comparable gate execution.
- [ ] Rule. Fail if head's comparable gate execution exceeds twice trunk plus 60 seconds, or exceeds 10 minutes. Fail any model use in CI. Bound time from dispatch to a terminal receipt at 20 minutes, with queue outages reported separately rather than hidden.

**Review gate.** The operator reviews before merge.

- [ ] Post good/bad candidate receipts to the operator. Use logs and run URLs instead of a screenshot or video. Record the bootstrap exception in the PR before the root merges the workflow. Do not call that bootstrap fully verified until the hosted lanes pass.

**Merge.**

- [ ] Record the exact-head local verdict and Bugbot triage. Record the CI bootstrap merge, made by the root under the owner's build-PR grant, separately from the later full hosted verdict.
- [ ] Apply the patch-id rule in `playbooks/shipping.md`. Merge the bootstrap after its parent PRs, then finish hosted proof on the resulting trusted revision. No dependent runtime publication proceeds on a local-only verdict.

## Publish held-out tests and bind CI verdicts (F07c)

**Depends on.** F07b with hosted proof complete. This completes unit 7.

**Files.**

- [ ] Create `src/validation.ts`, `src/publication.ts`, `test/validation.test.ts`, `test/publication.test.ts`, and `docs/prototypes/heldout-ci/`.
- [ ] Edit `src/run.ts`, `src/stages.ts`, `src/policy.ts`, `server/controller.ts`, `server/sandbox.ts`, `test/helpers.ts`, `test/pipeline.test.ts`, `test/stages.test.ts`, `test/policy.test.ts`, and `.github/factory/gates/` for exact-head CI evidence and separate holdout execution.

**Build.**

- [ ] Prototype risk R4 before repair exists. After build finishes, have the controller push the builder patch and then its own acceptance commit under `test/acceptance/<ticket>/`. Keep separate builder patch digest, acceptance digest, candidate head SHA, and trusted gate SHA. Verify the suite commit bytes against the private manifest.
- [ ] Use an unpublished-to-review candidate branch and dispatch main's validation workflow on its exact SHA. Do not open the user-facing ready PR before CI and review pass. Keep branch and dispatch IDs in the marker so a restart finds an existing effect.
- [ ] Run the held-out suite as a separately named mandatory result after main's gates and candidate tests. Require every expected check, successful completion, and exact SHA match. Extend `Verdict`, `advance`, and `checkLandPrecondition` so a patch digest alone cannot certify a different CI head.
- [ ] Build repair workspaces from a controller-produced sanitized tree without acceptance files, Git objects containing the suite, remotes, caches, or CI logs. Supply only failing scenario IDs and approved failure summaries. Prove the builder cannot fetch the public suite through any allowed npm or model route. If it can, block repair and report R4 rather than claiming secrecy.
- [ ] Invalidate CI evidence after every factory change to candidate bytes, acceptance bytes, gate revision, or base. Fail on skipped, cancelled, missing, or stale results. Retry only according to the bounded transport policy, not until a flaky check passes.

**You see.**

- [ ] Save a controller-authored acceptance commit, a hosted run URL, and a verdict with all four identities. The public branch has the suite after build, while a repair container cannot read it.

**Verify, unit.** Tests alone are not sufficient verification. A PR is verified only when its unit, live, and perf boxes are all checked.

- [ ] Cover missing check names, stale SHAs, suite digest mismatch, duplicate dispatch, crash-after-push, and sanitized repair inputs in `test/validation.test.ts` and `test/publication.test.ts`. Run `npm run check`.

**Verify, live.** Tests alone are not sufficient verification. A PR is verified only when its unit, live, and perf boxes are all checked. Ten lanes on `task:qa` at the PR head, per the boot recipe.

- [ ] Lane 1. Regression lane against trunk. Validate the same fixture candidate on both revisions. Save `holdout-verdict.json`. Pass when head adds the held-out suite result and binds it to the real hosted candidate SHA.
- [ ] Lane 2. Inspect branch commit order and suite bytes through `gh`. Save `suite-commit.json`. Pass when the controller adds the suite only after the builder patch and its digest matches the private manifest.
- [ ] Lane 3. Search a repair container's filesystem and Git object database for the canary. Save `repair-canary.log`. Pass when no acceptance bytes are accessible.
- [ ] Lane 4. Try retrieving the published suite through public GitHub and the approved egress routes. Save `public-holdout-denied.log`. Pass when the repair sandbox cannot retrieve it. Treat any successful route as a blocker.
- [ ] Lane 5. Run the seeded bad patch against the actual held-out suite. Save `bad-patch-ci.json`. Pass when CI fails and no review-ready PR opens.
- [ ] Lane 6. Move the branch after a passing run. Save `stale-head.json`. Pass when the old verdict cannot advance the new candidate.
- [ ] Lane 7. Change suite bytes without updating the authorized manifest. Save `suite-tamper.json`. Pass when collection or validation rejects the mismatch.
- [ ] Lane 8. Restart after candidate push but before recording dispatch completion. Save `push-recovery.log`. Pass when the controller reconciles branch and run IDs without a duplicate PR or lost candidate.
- [ ] Lane 9. Cancel the held-out job. Save `cancelled-ci.json`. Pass when cancellation vetoes progress despite other green checks.
- [ ] Lane 10. Inspect feedback delivered to a future repair stage. Save `sanitized-feedback.json`. Pass when only scenario IDs and approved summaries appear, with no test code or public CI log dump.

**Verify, perf.** Tests alone are not sufficient verification. A PR is verified only when its unit, live, and perf boxes are all checked.

- [ ] Metric. Measure acceptance publication, CI wall/queue time, verdict collection, and total run tokens/spend on both revisions.
- [ ] Probe. Interleave three validations of one fixed candidate on trunk and head, with the same main gates. Measure head's additional suite commit and holdout run separately. Save `perf.json`.
- [ ] Baseline. Record trunk gate duration and usage first, along with its lack of controller-owned holdout publication.
- [ ] Rule. Fail if publication takes over 60 seconds, verdict collection exceeds two poll ticks after CI completion, or the small held-out suite adds over 2 minutes to gate execution. Cap dispatch-to-verdict at 20 minutes and require zero model usage for deterministic validation.

**Review gate.** The operator reviews before merge.

- [ ] Post the exact-head CI receipt and holdout-denial logs to the operator. Use text artifacts instead of a screenshot or video. Merge only when R3 and R4 have evidence.

**Merge.**

- [ ] Record the exact-head verdict and complete Bugbot triage.
- [ ] Apply the patch-id rule in `playbooks/shipping.md`. Squash-merge `F07c` on a clean verdict and a passing `check`, then branch the next PR from the new `main`.

## Show one run in a read-only local viewer (F07d)

**Depends on.** F07c. This adds build-order row 7d, an operator tool outside the runtime stages. Source is owner decision 2026-10-29, after comparing Warp Factories. Warp's run page shows a timeline, cost, and a sub-agents tab. This section adapts that idea to local evidence.

**Files.**

- [ ] Create `server/viewer.ts`, `server/viewer/`, `test/viewer.test.ts`, `test/fixtures/viewer/`, and `docs/operations/viewer.md`.
- [ ] Edit `server/cli.ts` and `docs/operations/factory-cli.md` only for the `viewer` subcommand and its documentation.

**Build.**

- [ ] Add `factory viewer --state-dir "$STATE" [--run <id>] [--port <n>]`. Bind to `127.0.0.1` only. Use `node:http` with no new dependency. Exit nonzero on a missing state directory or a port in use.
- [ ] Read one run's evidence from disk. Sources are stage receipts, gateway audit lines, stage stderr metadata, marker comments as recorded locally, `status.json`, and the run's Pi session JSONL files. Treat a missing or corrupt source as a visible gap, never as an empty success.
- [ ] Render four views. The run timeline shows stages, attempts, repair rounds, and settlement events in order. The usage view totals tokens and known cost per model for the parent and each child, and marks unavailable spend as unavailable. The children tab lists each subagent session with its own timeline. The gateway view lists each allow and deny decision with destination and stage.
- [ ] Keep the viewer read-only. Serve only `GET` routes. Never call `gh`, never write to GitHub, and never write to the state directory or the ledger. Open every source file read-only.
- [ ] Treat every displayed string as untrusted. Model output, stderr, issue text, and session content are HTML-escaped and never executed. Send a strict Content-Security-Policy with no inline script from data. Render no Markdown or HTML from run content.
- [ ] Follow pstack's `make-bot-ui` pattern where it applies. Check the `Host` header to block DNS rebinding, reject a foreign `Origin`, and send no CORS headers. The viewer has no action route, so it needs no key.
- [ ] Keep exposure beyond loopback behind owner authorization. When the owner authorizes it, publish through `tailscale serve` and hand over the Tailscale link, never `localhost`. Add the served hostname to the `Host` allowlist only then. The factory itself still has no Tailscale dependency.

**You see.**

- [ ] Save `viewer.html` for a finished fixture run, fetched with `curl` over loopback. It shows the stage timeline, per-model token totals for parent and children, a children tab, and gateway decisions. A canary `<script>` in issue text shows as literal text.

**Verify, unit.** Tests alone are not sufficient verification. A PR is verified only when its unit, live, and perf boxes are all checked.

- [ ] Test source parsing, missing and corrupt sources, child aggregation, unavailable spend, HTML escaping, `Host` and `Origin` rejection, and the absence of write routes in `test/viewer.test.ts`. Run `npm run check`.

**Verify, live.** Tests alone are not sufficient verification. A PR is verified only when its unit, live, and perf boxes are all checked. Ten lanes on `task:qa` at the PR head, per the boot recipe.

- [ ] Lane 1. Regression lane against trunk. Run `factory viewer` against the same finished fixture run on trunk and head. Save `viewer-regression.log`. Pass when trunk reports the unsupported command and head serves the run without changing `status --json` output.
- [ ] Lane 2. Fetch the timeline for a run with one repair round. Save `timeline.json`. Pass when stages, attempts, and settlement events match the stage receipts in order.
- [ ] Lane 3. Fetch usage for a run with Herdr children. Save `usage-totals.json`. Pass when per-model parent and child tokens sum to the receipt totals and unavailable spend is labeled unavailable.
- [ ] Lane 4. Open the children tab for the same run. Save `children.json`. Pass when every child session appears once under its parent with its own timeline.
- [ ] Lane 5. Open the gateway view for a run with a denied GitHub request. Save `gateway-view.json`. Pass when the deny decision appears with its destination and stage.
- [ ] Lane 6. View a real fixture issue whose text holds a script and HTML canary. Save `escape-canary.html`. Pass when the canary shows as escaped text and no script runs in a headless fetch.
- [ ] Lane 7. Send `POST`, `PUT`, and `DELETE` requests and compare state before and after. Save `read-only.log`. Pass when each request is refused and the state directory, ledger, and fixture issue are unchanged.
- [ ] Lane 8. Send requests with a foreign `Host` and a foreign `Origin`, and probe the VM's non-loopback address. Save `binding.log`. Pass when the foreign requests get `403` and the port is not reachable off loopback.
- [ ] Lane 9. Remove one session file and corrupt one receipt. Save `missing-sources.json`. Pass when the viewer shows both gaps and does not report the run as complete.
- [ ] Lane 10. Inspect the process and network activity while the viewer serves a run. Save `no-github.log`. Pass when it makes no `gh` call, no model call, and no outbound request.

**Verify, perf.** Tests alone are not sufficient verification. A PR is verified only when its unit, live, and perf boxes are all checked.

- [ ] Metric. Measure viewer start time, page render time per view, and memory for one finished run, plus model tokens on trunk and head.
- [ ] Probe. Interleave three `status --json` calls on each revision with three head viewer loads of the same run. Use a fixture run with at least 1,000 session lines and two children. Save `perf.json`.
- [ ] Baseline. Record trunk `status --json` milliseconds and zero model calls first. Record trunk's unsupported viewer response.
- [ ] Rule. Fail if the viewer takes over 2 seconds to start, any view takes over 1 second to render for the fixture run, resident memory exceeds 200 MB, or any request calls a model or GitHub.

**Review gate.** The operator reviews before merge.

- [ ] Post `viewer.html`, the escape canary, and the read-only log to the operator. Use saved HTML and logs instead of a screenshot or video. Publish a live page only through an owner-authorized `tailscale serve` link. Merge on a clean verdict and a passing `check`.

**Merge.**

- [ ] Record the exact-head verdict and complete Bugbot triage.
- [ ] Apply the patch-id rule in `playbooks/shipping.md`. Squash-merge `F07d` on a clean verdict and a passing `check`, then branch the next PR from the new `main`.

## Review candidates and bound repair rounds (F08)

**Depends on.** F07c. Start it after `F07d` merges so the chain stays serial. It needs nothing from the viewer. This implements unit 8.

**Files.**

- [ ] Create `src/review.ts`, `test/review.test.ts`, `test/fixtures/review/`, and `skills/code-review/`, `skills/security-review/`, `skills/simplify/`, `skills/ultrareview/` with provenance.
- [ ] Edit `src/stages.ts`, `src/run.ts`, `server/controller.ts`, `test/stages.test.ts`, `test/pipeline.test.ts`, `skills/README.md`, and `.github/factory/WORKFLOW.md` for review orchestration, repair receipts, and the security-review fallback model.

**Build.**

- [ ] Implement `reviewCandidate` using fresh sessions over the validated candidate and contract. Adapt the selected licensed code-review and security-review sources. Write simplify and ultrareview from permitted documentation and pstack patterns, not unlicensed prompt copies.
- [ ] Bind findings to candidate SHA and patch digest. Use deterministic risk selection for extra review on policy, security, dependency, and factory-skill changes. Label every same-family seat honestly. Leave cross-family enforcement incomplete under R8.
- [ ] Set the security-review seat to `openai/gpt-6.1-sol` with `fallback_model: xai/grok-4.6`. Prove the fallback on a seeded vulnerability whose review prompt the primary refuses. If no such prompt can be found, record that the fallback path was tested only by an injected refusal. A security review that both models refuse blocks handoff.
- [ ] Label a review answered by the xAI fallback as cross-family for that seat only. It does not settle R8 for acceptance. Save `review-receipt.json` with the seat, the model that answered, its family label, and R8 still marked incomplete.
- [ ] Preserve `MAX_REPAIR_ROUNDS = 2` across validation and review. Send blocking findings to a fresh sanitized builder session. Clear stale candidate, verdict, and review evidence. Run CI and review again for the new head.
- [ ] Keep simplify changes inside build before validation or treat them as a new patch requiring full revalidation. Treat malformed reviews, missing expected seats, and budget exhaustion as failure, never approval. Let no model judge override a failing hard check.

**You see.**

- [ ] Save a planted vulnerability's blocking finding, a first repair receipt, and fresh CI/review evidence on the repaired SHA. A third attempted repair ends with failure, not a loop.

**Verify, unit.** Tests alone are not sufficient verification. A PR is verified only when its unit, live, and perf boxes are all checked.

- [ ] Test risk selection, findings schema, missing seats, hard-failure veto, stale evidence, and the shared two-round cap in `test/review.test.ts` and `test/stages.test.ts`. Run `npm run check`.

**Verify, live.** Tests alone are not sufficient verification. A PR is verified only when its unit, live, and perf boxes are all checked. Ten lanes on `task:qa` at the PR head, per the boot recipe.

- [ ] Lane 1. Regression lane against trunk. Run a known-good candidate through validation and review on both revisions. Save `review.json`. Pass when head adds SHA-bound findings and trunk's missing review execution is explicit.
- [ ] Lane 2. Use a real fixture issue whose seeded patch contains a known injection defect. Save `blocking-security.json`. Pass when review blocks handoff and identifies the seeded defect.
- [ ] Lane 3. Repair that defect. Save `repair-round.json`. Pass when the controller returns to build, reruns CI, and reviews the new SHA.
- [ ] Lane 4. Keep a fixture failing across validation and review attempts. Save `repair-cap.json`. Pass when the shared count stops at two repair rounds.
- [ ] Lane 5. Force a deterministic CI failure while reviewers approve. Save `hard-veto.json`. Pass when the factory refuses handoff.
- [ ] Lane 6. Apply a simplify edit after prior checks. Save `simplify-invalidates.json`. Pass when old checks cannot certify the changed bytes.
- [ ] Lane 7. Exhaust a reviewer budget. Save `review-budget.json`. Pass when the missing review cannot become a passing verdict and usage stays charged to the run.
- [ ] Lane 8. Inspect review input and model identity. Save `review-context.json`. Pass when the session is fresh and the receipt says context-isolated rather than cross-family.
- [ ] Lane 9. Change a policy or dependency path in a fixture candidate. Save `risk-review.json`. Pass when the deterministic risk selector adds the required extra review.
- [ ] Lane 10. Interrupt during repair and restart. Save `repair-recovery.json`. Pass when the same repair count and candidate identity survive without repeating a completed build.

**Verify, perf.** Tests alone are not sufficient verification. A PR is verified only when its unit, live, and perf boxes are all checked.

- [ ] Metric. Measure each review seat, each repair, and whole-run wall time and tokens/spend on both revisions.
- [ ] Probe. Interleave three good-candidate runs and three seeded-defect trials on trunk and head. Separate new review/repair work from shared validation. Save `perf.json`.
- [ ] Baseline. Record trunk validation duration and usage first. Record its absent reviewer result rather than assigning it zero findings.
- [ ] Rule. Fail if review of the tiny fixture exceeds 5 minutes or 30,000 tokens across seats, or one repair plus revalidation exceeds 20 minutes or 80,000 additional tokens. Enforce cumulative configured caps, including failed attempts.

**Review gate.** The operator reviews before merge.

- [ ] Post the planted-defect and two-round-cap receipts to the operator. Use JSON instead of a screenshot or video. Merge on a clean verdict and disclose the incomplete cross-family requirement.

**Merge.**

- [ ] Record the exact-head behavior verdict and Bugbot triage with model-family limitations.
- [ ] Apply the patch-id rule in `playbooks/shipping.md`. Squash-merge `F08` on a clean verdict and a passing `check`, then branch the next PR from the new `main`.

## Hand off verified PRs and require human merge (F09a)

**Depends on.** F08. This implements unit 9's handoff and branch-protection contract.

**Files.**

- [ ] Create `src/handoff.ts`, `test/handoff.test.ts`, and `docs/operations/human-review.md`.
- [ ] Edit `src/run.ts`, `src/stages.ts`, `src/policy.ts`, `src/publication.ts`, `src/adapters/github.ts`, `server/controller.ts`, `test/helpers.ts`, `test/pipeline.test.ts`, `test/stages.test.ts`, `test/policy.test.ts`, and `.github/workflows/ci.yml` for waiting state and exact-head required-check reporting. Edit `extension/index.ts`, `server/cli.ts`, `test/extension.test.ts`, and `docs/operations/factory-cli.md` for the attention view.

**Build.**

- [ ] Add `Progress.waiting` for the mandatory merge checkpoint. Preserve the future contract-checkpoint type without enabling autonomous merge. Keep the internal `land` stage as deterministic handoff preparation if that minimizes churn. Accept `landed` only from a controller-observed external merge event, not a model response.
- [ ] Implement `handoffCandidate` with fresh switch checks, allowed paths, complete verdict, exact current head, and passing required CI. Create one ready, non-draft PR labeled `factory:review`, request the owner, and post redacted contract/verdict/findings/CI links on the issue.
- [ ] Prototype how the main-owned validation result becomes a required check on the candidate SHA. Keep any write-capable check-reporting step separate from untrusted candidate execution, with no stored CI secret. Validate the trusted workflow identity and exact run/head association before reporting. Do not use an arbitrary same-named check as proof.
- [ ] Document and verify the owner's branch-protection setup with required main-owned checks, review requirements, and no factory bypass. Settings changes need a separate grant. If integration permissions cannot inspect or set them, give the owner exact manual steps and leave the protection gate incomplete.
- [ ] Watch the PR without model usage while waiting. Record owner merge as `landed` with its actual merge SHA, close the issue idempotently, and notify the later ledger writer. Record closed-without-merge as `cancelled`. A new factory push invalidates prior readiness.
- [ ] Remove stale runtime claims that imply automatic merging. Leave full autonomy and configurable contract approval for a later checkpoint-policy release.
- [ ] Give the kill switch one meaning. Today `advance()` ends a run as `rejected: disabled` on a `kill_switch_off` event, but the controller never sends that event. While either switch is off, the controller keeps each held run and its claim and launches nothing, then resumes when both are on. Keep that behavior, which matches `docs/design.md`. Make handoff refuse while either switch is off, and leave the run waiting rather than ending it. Remove the `kill_switch_off` event and the `disabled` reject reason, or keep `disabled` only for admission refusals. Test that a run held while a switch is off resumes once both are on, and that handoff refuses while a switch is off.
- [ ] Add an attention view to `/factory status` and `status --json`. Group runs that need the owner into six kinds. Question asked is a `needs_info` run. Question answered is a run re-labeled after an answer. Spec review is a future `approve_contract` wait, shown as not enabled in v1. PR review is `waiting` at the merge checkpoint. Blocked is `sandbox_unavailable` or an exhausted budget. Failed is a `failed` outcome. Each entry names the issue, the PR when one exists, and the age. Derive the view from run state with no model call. An item leaves the view when its run moves on. Source is owner decision 2026-10-29, after comparing Warp Factories.

**You see.**

- [ ] Save one ready `factory:review` PR with the owner requested and all evidence bound to its head. Status says `waiting` at the merge checkpoint. No controller path calls `gh pr merge` or arms auto-merge.
- [ ] Save `attention.json` from `status --json`. The waiting PR appears under PR review, and fixtures in the other states appear under their own kinds.

**Verify, unit.** Tests alone are not sufficient verification. A PR is verified only when its unit, live, and perf boxes are all checked.

- [ ] Update state-machine callers and helpers together. Test waiting, stale heads, disabled handoff, incomplete checks, duplicate PR creation, owner merge, and unmerged close in `test/handoff.test.ts` and `test/pipeline.test.ts`. Test attention grouping for all six kinds and the offline extension view in `test/extension.test.ts`. Run `npm run check`.

**Verify, live.** Tests alone are not sufficient verification. A PR is verified only when its unit, live, and perf boxes are all checked. Ten lanes on `task:qa` at the PR head, per the boot recipe.

- [ ] Lane 1. Regression lane against trunk. Run the same tiny issue to the last available stage on trunk and head. Save `human-review.json`. Pass when head opens one ready PR with the owner requested and waits instead of merging.
- [ ] Lane 2. Read the PR through `gh`. Save `ready-pr.json`. Pass when it is non-draft, labeled `factory:review`, and its current SHA matches the verdict and required check.
- [ ] Lane 3. Disable either switch just before handoff in a scoped fixture. Save `handoff-disabled.log`. Pass when no ready PR is created and the refusal is visible.
- [ ] Lane 4. Move the candidate branch after validation. Save `handoff-stale.json`. Pass when the new tip cannot inherit readiness.
- [ ] Lane 5. Restart after PR creation before the local receipt is durable. Save `pr-recovery.json`. Pass when reconciliation finds the existing PR rather than opening another.
- [ ] Lane 6. Inspect branch rules and the trusted check identity. Save `branch-protection.json`. Pass when required checks and owner review prevent an unvalidated merge without granting the factory bypass.
- [ ] Lane 7. Have the owner merge the known-good fixture PR. Save `owner-merge.json`. Pass when the controller observes the actual merge SHA and closes the issue once. Remain BLOCKED until the owner acts.
- [ ] Lane 8. Have the owner close a different fixture PR without merging. Save `closed-unmerged.json`. Pass when the run becomes cancelled rather than landed.
- [ ] Lane 9. Leave a ready PR waiting for two ticks while other fixtures sit in `needs_info`, answered, blocked, and failed states. Run `status --json` and `/factory status`. Save `attention.json`. Pass when each run appears under its own kind, spec review shows not enabled, and the waiting run's model usage and repair count do not increase.
- [ ] Lane 10. Present a stale or unrelated same-named CI check for a fixture candidate. Save `check-identity.json`. Pass when handoff rejects it and the real trusted check alone can satisfy the gate.

**Verify, perf.** Tests alone are not sufficient verification. A PR is verified only when its unit, live, and perf boxes are all checked.

- [ ] Metric. Measure post-review handoff latency, polling latency after owner action, and per-stage/run tokens/spend on trunk and head. Separate human waiting time from execution time.
- [ ] Probe. Interleave three fixed issue runs to each revision's terminal available state. Measure head PR creation and observation of authorized owner actions. Save `perf.json`.
- [ ] Baseline. Record trunk's validated/reviewed candidate time and usage first, with no invented PR handoff.
- [ ] Rule. Fail if a ready candidate takes over 90 seconds to produce its PR without throttling, owner merge takes over two ticks to observe, or waiting spends model tokens. Report full fixture execution against a 35-minute budget excluding human wait and CI queue outages.

**Review gate.** The operator reviews before merge.

- [ ] Post the real PR URL, required-check proof, and owner-action receipts to the operator. Use text artifacts instead of a screenshot or video. Merge this build PR on a clean verdict. Never perform the owner's test merge of a factory-opened fixture PR yourself.

**Merge.**

- [ ] Record the exact-head verdict and Bugbot triage. Leave branch-protection or owner-action boxes unchecked when their evidence is missing.
- [ ] Apply the patch-id rule in `playbooks/shipping.md`. Squash-merge `F09a` on a clean verdict and a passing `check`, then branch the next PR from the new `main`. No agent gains merge authority from this PR.

## Record finished runs on the ledger branch (F09b)

**Depends on.** F09a. This completes unit 9's ledger and usage accounting.

**Files.**

- [ ] Create `src/ledger.ts`, `test/ledger.test.ts`, `docs/prototypes/ledger-branch/`, and `docs/operations/ledger.md`.
- [ ] Edit `src/run.ts`, `src/markers.ts`, `src/orchestrator.ts`, `server/controller.ts`, and `server/cli.ts` for durable totals and terminal publication.

**Build.**

- [ ] Prototype controller-only append to `ledger/runs.jsonl` on the `factory/ledger` orphan branch. Keep its Git checkout outside all stage mounts. Verify that the branch has no main ancestry and is never a source branch for product PRs.
- [ ] Implement `appendRun` keyed by run ID with terminal outcome, issue/PR URLs, SHAs, artifact digests, stage timings, repair count, model versions, token totals, spend availability, and evidence links. Append each finished run once, including failures and `needs_info`, not only merges.
- [ ] Serialize writes in the single controller. Reconcile a pushed row before retrying after a crash. On a remote advance, fetch and reapply only the missing row, without force-pushing the ledger. Preserve unknown or corrupt rows for diagnosis instead of rewriting history.
- [ ] Count interrupted attempts apart from failed ones. Today a controller restart during a stage ends that attempt as failed, so restarts use up the attempt cap. Keep that charge, because the interrupted attempt may already have spent tokens. Record each run's interrupted attempts in its ledger row, so `F12` can tell restarts from real failures. Source is the controller statechart in `docs/statecharts/README.md`.
- [ ] Persist usage at stage boundaries and before dispatching another request. Restore totals after restart. Block new work when a configured token, wall, or known spend cap is exhausted. Keep raw sessions private and publish only redacted evidence.

**You see.**

- [ ] Save one ledger row for the owner's merged fixture run and one for a failed run. Repeated reconciliation leaves exactly one row per run ID and preserves earlier rows.

**Verify, unit.** Tests alone are not sufficient verification. A PR is verified only when its unit, live, and perf boxes are all checked.

- [ ] Test append deduplication, remote advance, crash-after-push, redaction, unknown spend, restored totals, and corrupt rows in `test/ledger.test.ts`. Run `npm run check`.

**Verify, live.** Tests alone are not sufficient verification. A PR is verified only when its unit, live, and perf boxes are all checked. Ten lanes on `task:qa` at the PR head, per the boot recipe.

- [ ] Lane 1. Regression lane against trunk. Observe the same finished fixture run on trunk and head. Save `ledger-row.json`. Pass when head adds one durable row and trunk's missing ledger writer is recorded.
- [ ] Lane 2. Inspect `factory/ledger` ancestry and files through read-only GitHub calls. Save `orphan-branch.json`. Pass when it contains the ledger without main's history or source tree.
- [ ] Lane 3. Reconcile the same finished run twice. Save `ledger-dedup.json`. Pass when its run ID appears exactly once.
- [ ] Lane 4. Restart after a ledger push before its receipt is recorded. Save `ledger-restart.json`. Pass when recovery finds the row and does not append a duplicate.
- [ ] Lane 5. Complete two real fixture runs close together. Save `concurrent-finish.json`. Pass when both rows survive in serialized order without a lost update.
- [ ] Lane 6. Cause an authorized remote ledger advance in the prototype branch. Save `remote-advance.log`. Pass when append fetches/retries without force-pushing or deleting the other row.
- [ ] Lane 7. Finish a `needs_info` and a failed run. Save `terminal-outcomes.json`. Pass when both appear with distinct IDs and truthful outcomes.
- [ ] Lane 8. Restart with an almost-exhausted run budget. Save `restored-budget.json`. Pass when totals survive and no fresh budget is granted.
- [ ] Lane 9. Inspect public ledger evidence for a fixture containing a redaction canary. Save `ledger-redaction.json`. Pass when private raw content and sessions remain off the branch.
- [ ] Lane 10. Use a provider response without monetary pricing. Save `unknown-spend.json`. Pass when spend is marked unavailable, tokens remain counted, and no zero-cost claim appears.

**Verify, perf.** Tests alone are not sufficient verification. A PR is verified only when its unit, live, and perf boxes are all checked.

- [ ] Metric. Measure terminal-observation-to-ledger latency and run wall time, tokens, and spend on trunk and head. Measure append cost separately.
- [ ] Probe. Interleave three terminal reconciliations and append trials. Use a controlled 1,000-row ledger copy for local parsing, with real remote append proof on scoped runs. Save `perf.json`.
- [ ] Baseline. Record trunk terminal observation and usage totals before the new append trials.
- [ ] Rule. Fail if a normal terminal row takes over 60 seconds to reach the ledger, parsing 1,000 rows takes over 1 second, or ledger work calls a model. Fail if recorded totals omit a completed child or retry.

**Review gate.** The operator reviews before merge.

- [ ] Post redacted ledger rows and the restart receipt to the operator. Use JSON instead of a screenshot or video. Merge on a clean verdict and a passing `check`.

**Merge.**

- [ ] Record the exact-head verdict and complete Bugbot triage after the orphan-branch prototype passes.
- [ ] Apply the patch-id rule in `playbooks/shipping.md`. Squash-merge `F09b` on a clean verdict and a passing `check`, then branch the next PR from the new `main`.

## Apply authorized PR feedback in place (F10)

**Depends on.** F09b. This implements unit 10 and completes the GitHub feedback part of the definition of done.

**Files.**

- [ ] Create `src/feedback.ts`, `test/feedback.test.ts`, and `skills/address-pr-comments/` with provenance.
- [ ] Edit `src/tickets.ts`, `src/adapters/github.ts`, `src/run.ts`, `src/stages.ts`, `src/markers.ts`, `server/controller.ts`, `test/fake-ticket-adapter.ts`, `test/pipeline.test.ts`, and `skills/README.md` for feedback cursors and fresh repair rounds.

**Build.**

- [ ] Poll PR conversation comments, submitted reviews, and inline review comments. Normalize stable IDs, actor permissions, PR identity, and referenced head. Deduplicate bot messages and already-processed feedback.
- [ ] Implement `applyFeedback` only for an open factory PR and a write-access actor. Treat comments as requested work within the original contract, not permission to edit forbidden files or broaden scope. Route incompatible requests to a question or proposal.
- [ ] Adapt the MIT address-pr-comments skill without its direct pushes or replies. Use a fresh sanitized build session, the same branch and PR, and cumulative repair and cost budgets. Persist the feedback cursor before retries can redispatch it.
- [ ] Remove readiness while a factory repair is active. Convert the PR to a draft with `gh pr ready --undo` and remove `factory:review`, because a missing label does not block a merge but GitHub refuses to merge a draft. Re-run validate and review at the new head before marking the PR ready and restoring `factory:review`. Have only the controller push and reply. Do not rewrite unexpected owner commits without explicit reconciliation and scope confirmation.
- [ ] Handle a merge that lands during a repair anyway, such as after the owner marks the draft ready. Today `advance()` accepts `landed` only during `land` and returns `invalid` in any other stage, so the run keeps building on a merged PR. Keep the PR's published head and its verdict apart from the repair in progress, because a repair round clears the working patch and verdict. Once a PR exists, a merge ends the run as landed from any stage, aborts the repair stage, and records the merged SHA. Record whether that SHA carries a passing factory verdict and review. A head without one, such as a head the owner marked ready during a repair, is recorded as an owner override, never as a factory-verified landing. `docs/statecharts/README.md` shows the current gap as the `MergeEndsRun` break.
- [ ] For feedback on a merged PR, file a deduplicated `factory:proposed` issue instead of modifying the merged branch. Keep it ineligible for automatic admission.

**You see.**

- [ ] Save a write-access review comment and the resulting new head on the same PR, followed by fresh CI and review receipts. A repeated poll produces no second repair.

**Verify, unit.** Tests alone are not sufficient verification. A PR is verified only when its unit, live, and perf boxes are all checked.

- [ ] Cover all comment sources, permission checks, stale heads, cursor recovery, owner commits, scope expansion, shared repair caps, and a merge during a repair round in `test/feedback.test.ts`. Run `npm run check`. Give `docs/statecharts/journey/Journey.tla` the same published-head split, and rerun it until `MergeEndsRun` holds and every merge without an owner override names a head whose checks and review passed.

**Verify, live.** Tests alone are not sufficient verification. A PR is verified only when its unit, live, and perf boxes are all checked. Ten lanes on `task:qa` at the PR head, per the boot recipe.

- [ ] Lane 1. Regression lane against trunk. Post the same authorized fixture feedback to each revision's open PR. Save `feedback-round.json`. Pass when head updates its existing PR and trunk's missing feedback behavior is recorded.
- [ ] Lane 2. Submit an owner review with requested changes. Save `review-feedback.json`. Pass when one repair starts, the PR is a draft that GitHub refuses to merge, and readiness is withheld until fresh evidence passes.
- [ ] Lane 3. Add an inline review comment. Save `inline-feedback.json`. Pass when the adapter associates it with the correct PR and head.
- [ ] Lane 4. Post a non-writer comment to a real fixture PR under the identity grant. Save `unauthorized-feedback.json`. Pass when it starts no run.
- [ ] Lane 5. Poll a processed comment twice. Save `feedback-dedup.log`. Pass when only one repair and one reply occur.
- [ ] Lane 6. Restart after the repair push but before acknowledging the comment. Save `feedback-restart.json`. Pass when recovery keeps the same branch/head mapping and does not rebuild twice.
- [ ] Lane 7. Request a workflow edit in feedback. Save `feedback-scope.json`. Pass when the controller refuses or routes owner-only work without weakening path policy.
- [ ] Lane 8. Add an owner commit while a repair is prepared. Save `owner-head-drift.json`. Pass when the factory detects drift and does not overwrite the owner's work.
- [ ] Lane 9. Post authorized feedback on a merged fixture PR. Save `merged-feedback.json`. Pass when one proposed issue appears and no merged branch is changed.
- [ ] Lane 10. Send more feedback after the shared two-repair cap. Save `feedback-budget.json`. Pass when the run stops with an explanation rather than resetting its repair budget.

**Verify, perf.** Tests alone are not sufficient verification. A PR is verified only when its unit, live, and perf boxes are all checked.

- [ ] Metric. Measure comment-to-dispatch latency, repair-stage wall time, full feedback-to-ready time, and cumulative tokens/spend on both revisions.
- [ ] Probe. Interleave three small comment-fix scenarios. On trunk record polling and unchanged PR state, not a successful repair. Save `perf.json`.
- [ ] Baseline. Record trunk's PR polling latency and existing run usage first.
- [ ] Rule. Fail if authorized feedback takes over two ticks to dispatch, a tiny repair takes over 20 minutes excluding CI queue delay, or it consumes over 80,000 extra tokens. Fail any repair that resets cumulative spend or turn limits.

**Review gate.** The operator reviews before merge.

- [ ] Post the same-PR before/after URLs, head SHAs, and fresh checks to the operator. Use text artifacts instead of a screenshot or video. Merge on a clean verdict and a passing `check`.

**Merge.**

- [ ] Record the exact-head verdict and Bugbot triage, including a real owner-feedback round trip.
- [ ] Apply the patch-id rule in `playbooks/shipping.md`. Squash-merge `F10` on a clean verdict and a passing `check`, then branch the next PR from the new `main`.

## File bounded maintenance proposals on a schedule (F11)

**Depends on.** F10. This implements unit 11.

**Files.**

- [ ] Create `src/cadence.ts`, `test/cadence.test.ts`, `skills/improve-codebase-architecture/`, `skills/audit-instructions/`, `skills/agent-loop-hygiene/`, and `docs/operations/cadence.md`.
- [ ] Edit `src/workflow.ts`, `.github/factory/WORKFLOW.md`, `src/markers.ts`, `server/controller.ts`, `server/cli.ts`, and `skills/README.md` for weekly schedules and a bounded one-shot trigger.

**Build.**

- [ ] Implement `runCadence` with weekly due times, durable watermarks, overlap prevention, and an explicit `cadence --once --job` command for verification. Use the controller tick for scheduling, not a second unsupervised process.
- [ ] Adapt the selected architecture, domain-modeling, instruction audit, and owner hygiene sources with provenance and licenses. Use the existing security-review skill for the whole-repo job. Replace interactive choices and direct edits with structured proposals.
- [ ] File only `factory:proposed` issues through the controller. Deduplicate by job, repository, and finding fingerprint. Record no-delta runs without filing issues. Do not label proposals ready or mutate code.
- [ ] Give cadence jobs their own configured turn, token, wall, and spend caps while respecting global concurrency and kill switches. Keep evidence redacted and ensure routine jobs do not starve active tickets.

**You see.**

- [ ] Save one due job receipt and one proposed issue with provenance and evidence. A second identical job creates no duplicate, PR, or code change.

**Verify, unit.** Tests alone are not sufficient verification. A PR is verified only when its unit, live, and perf boxes are all checked.

- [ ] Test weekly due calculations, watermarks, restart overlap, no-delta output, deduplication, and priority in `test/cadence.test.ts`. Run `npm run check`.

**Verify, live.** Tests alone are not sufficient verification. A PR is verified only when its unit, live, and perf boxes are all checked. Ten lanes on `task:qa` at the PR head, per the boot recipe.

- [ ] Lane 1. Regression lane against trunk. Trigger one architecture audit through the CLI on both revisions against the real repository. Save `cadence-proposal.json`. Pass when head files one proposed issue and trunk's unsupported command is recorded.
- [ ] Lane 2. Run the same job against unchanged evidence. Save `cadence-dedup.json`. Pass when it creates no duplicate issue.
- [ ] Lane 3. Run the security cadence job with a seeded finding in the authorized verification checkout. Save `security-proposal.json`. Pass when it files a proposal but edits no code.
- [ ] Lane 4. Run the instruction audit in unattended mode. Save `instructions-proposal.json`. Pass when it returns without an interactive wait and only files scoped proposals.
- [ ] Lane 5. Run hygiene against real redacted ledger rows. Save `hygiene-proposal.json`. Pass when missing evidence is called unknown rather than success.
- [ ] Lane 6. Trigger a not-yet-due scheduled job through the normal tick. Save `not-due.log`. Pass when no model stage runs.
- [ ] Lane 7. Restart after a job files its issue. Save `cadence-restart.json`. Pass when the watermark and fingerprint prevent a duplicate.
- [ ] Lane 8. Fill both active ticket slots before a cadence tick. Save `cadence-priority.json`. Pass when maintenance cannot exceed global concurrency or displace active work.
- [ ] Lane 9. Disable the factory before a due job. Save `cadence-disabled.log`. Pass when no proposal or model request occurs.
- [ ] Lane 10. Inspect the new issue's labels and repository diff. Save `proposal-only.json`. Pass when it has `factory:proposed`, lacks `factory:ready`, and no PR or code mutation exists.

**Verify, perf.** Tests alone are not sufficient verification. A PR is verified only when its unit, live, and perf boxes are all checked.

- [ ] Metric. Measure idle schedule-check time and per-job wall time/tokens/spend on trunk and head, plus time to a proposed issue.
- [ ] Probe. Interleave three idle ticks and three bounded one-shot audits on each revision, recording unsupported jobs on trunk. Save `perf.json`.
- [ ] Baseline. Record trunk idle-tick latency and usage before head audits.
- [ ] Rule. Fail if local idle schedule evaluation adds over 100 milliseconds, a small audit exceeds 10 minutes or 40,000 tokens, or one finding takes over 60 seconds after settlement to become a proposed issue. Enforce the maintenance spend cap.

**Review gate.** The operator reviews before merge.

- [ ] Post the proposed issue and no-duplicate receipt to the operator. Use logs instead of a screenshot or video. Merge on a clean verdict and a passing `check`.

**Merge.**

- [ ] Record the exact-head verdict, license review, and Bugbot triage.
- [ ] Apply the patch-id rule in `playbooks/shipping.md`. Squash-merge `F11` on a clean verdict and a passing `check`, then branch the next PR from the new `main`.

## Measure outcomes and propose tested factory improvements (F12)

**Depends on.** F11. This implements unit 12 without self-promoting changes.

**Files.**

- [ ] Create `src/metrics.ts`, `src/replay.ts`, `src/scorers.ts`, `src/benchmarks.ts`, `test/metrics.test.ts`, `test/replay.test.ts`, `test/scorers.test.ts`, `test/benchmarks.test.ts`, `test/fixtures/replay/`, `test/fixtures/benchmarks/`, `skills/agent-loop-spec/`, `skills/reflect-ledger/`, and `docs/operations/improvement.md`.
- [ ] Edit `src/cadence.ts`, `src/ledger.ts`, `server/cli.ts`, `.github/factory/WORKFLOW.md`, and `skills/README.md` for metric, replay, scorer, and benchmark commands, score records, and proposal cadence.

**Build.**

- [ ] Implement the metric from the design using ready-ticket cohorts, zero-repair landed outcomes, and linked follow-up defects within seven days. Count a ticket once across clarification attempts. Report immature cohorts and unknown defect follow-up separately instead of treating missing evidence as clean.
- [ ] Adapt agent-loop-spec and pstack reflect to read the ledger rather than private transcripts. Generate bounded `factory:proposed` issues with the baseline, proposed change, evidence, and keep-or-reject rule. Never edit a skill or enable a proposal automatically.
- [ ] Implement replay of a versioned fixed corpus on the previous trusted factory and a candidate factory in clean environments. Use previous-policy gates, isolated state, and sanitized historic tickets. Prevent replay from creating ordinary production issues or PRs without a dedicated fixture grant.
- [ ] Include known-good, known-bad, vague, forbidden-path, budget-exhausted, and feedback cases. Report acceptance quality, missed defects, false rejection, wall time, tokens, and spend. Require no seeded bad acceptance and no regression in mandatory behavior before proposing promotion.
- [ ] Add scorers. Source is owner decision 2026-10-29, after comparing Warp Factories. A scorer is an LLM judge declared in trusted `WORKFLOW.md`. It returns exactly one label from a declared set, and each label carries a score from 0 to 1. Each scorer has a `passingScore` and a `samplingRate`. Record the label, score, reasoning, judge model, and scored run ID on the ledger. Let a scorer include child runs, and let `score --run <id>` score on demand. A re-score replaces the earlier result and keeps its history. Reject an undeclared label as a failed scoring, never a pass.
- [ ] Add benchmark tasks. A task has a prompt, success criteria, and repository state pinned to a full 40-character SHA. Reject branches and tags. Let `benchmark task --from-run <id>` build a task from a past ledger run. Keep task inputs immutable so later edits do not change past results.
- [ ] Add benchmark runs. A run is a matrix of up to N model or configuration variants, tasks, and repetitions. Show the trial count before launch. Report correctness against tokens and known cost per variant, plus a recommendation that needs at least two comparable variants. Label unknown spend unavailable. Run trials through the replay isolation above, with no production issue or PR.
- [ ] Add the improvement trigger. After K unreviewed failing scores for one scorer, or when the oldest is D days old, file one deduplicated `factory:proposed` issue that cites the failing runs. Never open a code PR from this trigger. That keeps the never-self-promote rule. Read N, K, and D from trusted `WORKFLOW.md`. Start at Warp's published values of 6 variants, 25 failures, and 7 days, and tune them only from ledger evidence.
- [ ] Run judges and benchmark trials in the `F05` sandbox, through the egress gateway. Charge their tokens and wall time to the configured usage caps. Choose a judge model family different from the builder's where one is available. Otherwise record `context-isolated, same family, not cross-family` on the score. A score is a measurement, never a gate. A failing hard check still vetoes, and no score can advance a run.

**You see.**

- [ ] Save a metric report with numerator, denominator, mature-cohort count, and unknowns. Save one improvement proposal and a replay comparison that rejects a deliberately weakened validator.
- [ ] Save one scorer result with its label, score, reasoning, and judge family, and one benchmark report with a correctness against cost table and a recommendation.

**Verify, unit.** Tests alone are not sufficient verification. A PR is verified only when its unit, live, and perf boxes are all checked.

- [ ] Test cohort boundaries, duplicate attempts, seven-day defects, missing evidence, corpus pinning, and previous-policy selection in `test/metrics.test.ts` and `test/replay.test.ts`. Test declared labels, undeclared labels, sampling, re-scoring, SHA pinning, matrix limits, the K and D trigger, and the hard-check veto in `test/scorers.test.ts` and `test/benchmarks.test.ts`. Run `npm run check`.

**Verify, live.** Tests alone are not sufficient verification. A PR is verified only when its unit, live, and perf boxes are all checked. Ten lanes on `task:qa` at the PR head, per the boot recipe.

- [ ] Lane 1. Regression lane against trunk. Read the same real ledger cohort on trunk and head. Save `outcome-metric.json`. Pass when head computes the defined metric and does not invent mature history absent on trunk.
- [ ] Lane 2. Inspect a recent cohort younger than seven days that includes a ticket with several clarification attempts. Save `immature-cohort.json`. Pass when the cohort is reported as pending rather than zero-defect success, and the ticket is counted once with its attempts visible.
- [ ] Lane 3. Link an authorized follow-up defect issue to a fixture run. Save `defect-window.json`. Pass when the affected mature cohort's result changes according to the seven-day rule.
- [ ] Lane 4. Run reflect twice against unchanged redacted ledger data. Save `reflect-proposal.json`. Pass when one evidence-backed proposed issue appears, the second run files no duplicate, and no skill file changes.
- [ ] Lane 5. Replay a known-good real fixture ticket on previous and candidate factories. Save `replay-good.json`. Pass when both use clean state and produce comparable behavior receipts.
- [ ] Lane 6. Replay a deliberately weakened validator against a seeded bad ticket. Save `replay-bad.json`. Pass when previous trusted gates reject promotion.
- [ ] Lane 7. Score a finished fixture run on demand, including its child runs, then score a run whose hard check failed. Save `scorer-result.json`. Pass when each score has one declared label, a 0 to 1 score, reasoning, and a judge family label, the gateway audit shows the judge ran in the sandbox, its tokens count against the run caps, and the failed run stays failed despite a passing score.
- [ ] Lane 8. Build a task from a past ledger run and launch a two-variant, one-task, two-repetition benchmark. Inspect side effects through `gh`. Save `benchmark-run.json`. Pass when the task pins a 40-character SHA, the report shows correctness against cost and a recommendation, and no production issue, PR, or ticket dispatch appears.
- [ ] Lane 9. Seed K unreviewed failing scores for one scorer, then run the trigger twice. Save `improvement-trigger.json`. Pass when one `factory:proposed` issue cites the failing runs, no PR or skill change appears, and the second run files no duplicate.
- [ ] Lane 10. Compare replay session/model and policy versions. Save `replay-provenance.json`. Pass when the report records exact versions, same-family limitations, and unavailable spend without claiming improvement from incomparable runs.

**Verify, perf.** Tests alone are not sufficient verification. A PR is verified only when its unit, live, and perf boxes are all checked.

- [ ] Metric. Measure ledger-analysis time, replay wall time per stage, tokens/spend per run, and outcome quality on trunk and head. Measure scorer tokens as a share of the scored runs' tokens, and benchmark trial tokens against the benchmark cap.
- [ ] Probe. Interleave three metric calculations on the same corpus and three previous/head replay pairs for the fixed tiny ticket. Score the same head runs at the configured sampling rate. Keep fixture and model versions fixed. Save `perf.json`.
- [ ] Baseline. Record previous-factory behavior, stage timings, and usage before the candidate comparison. For absent metric commands, record unsupported behavior separately.
- [ ] Rule. Fail if local analysis of 1,000 rows exceeds 2 seconds, any seeded bad candidate passes, or candidate replay regresses mandatory behavior. Flag over 20% higher median tokens or elapsed stage time for the same successful scenario as a failed improvement claim unless approved before the run. Fail if scoring at the configured sampling rate exceeds 10% of the scored runs' tokens, or a benchmark run exceeds its configured cap. Warp reports scoring near 3% of its own tokens. Record that figure as a reference, not a budget.

**Review gate.** The operator reviews before merge.

- [ ] Post the metric, replay comparison, and proposed issue to the operator. Use JSON instead of a screenshot or video. Merge on a clean verdict. Do not count the seven-day claim as verified before real mature evidence exists.

**Merge.**

- [ ] Record the exact-head verdict and Bugbot triage. Keep immature-cohort evidence gaps explicit.
- [ ] Apply the patch-id rule in `playbooks/shipping.md`. Squash-merge `F12` on a clean verdict and a passing `check`, then branch the next PR from the new `main`.

## Add a polled Linear adapter without changing stages (F13)

**Depends on.** F12. This implements unit 13 after the GitHub path is working.

**Files.**

- [ ] Create `src/adapters/linear.ts`, `test/linear-adapter.test.ts`, `test/adapter-contract.test.ts`, `docs/prototypes/linear-polling/`, and `docs/operations/linear.md`.
- [ ] Edit `src/tickets.ts`, `src/workflow.ts`, `src/markers.ts`, `server/controller.ts`, `server/cli.ts`, `test/fake-ticket-adapter.ts`, and `.github/factory/WORKFLOW.md` only for provider configuration and shared adapter contract support.

**Build.**

- [ ] Prototype polled Linear issue/event reads, authorization, state transitions, comment reporting, and stable cursors with an owner-approved workspace and controller-only credential route. Keep Linear disabled until that authorization and access exist. Do not introduce an App receiver, webhook, or Tailscale.
- [ ] Implement `LinearTicketAdapter` against the same `TicketAdapter` contract used by GitHub. Normalize provider-qualified ticket keys, readiness actor, immutable snapshot, questions, progress, and closure. Keep GitHub branch/PR/CI publication in the existing publisher.
- [ ] Prove the readiness actor and snapshot contract through Linear's actual history APIs. If polling cannot establish them, block that admission instead of assuming an assignee or current label grants authority. Map the approved workspace/team to this repository explicitly.
- [ ] Run the shared adapter tests against GitHub, Linear, and the fake. Reuse the state machine, budgets, marker reconciliation semantics, and Human Review checkpoint without tracker-specific stage forks. Keep Linear credentials outside all agent containers.
- [ ] Link real Linear verification tickets to paired GitHub evidence issues and PRs in this repository. Do not claim native Linear agent-session acknowledgments. This adapter polls generic tickets and reports progress through comments.

**You see.**

- [ ] Save a Linear ticket URL, its paired GitHub evidence issue, and one verified ready PR in this repository. The factory waits for the owner just as it does for a GitHub ticket.

**Verify, unit.** Tests alone are not sufficient verification. A PR is verified only when its unit, live, and perf boxes are all checked.

- [ ] Run the shared admission, clarification, recovery, reporting, and closure tests through all three adapters. Add pagination, GraphQL error, rate-limit, and missing-authority cases in `test/linear-adapter.test.ts`. Run `npm run check`.

**Verify, live.** Tests alone are not sufficient verification. A PR is verified only when its unit, live, and perf boxes are all checked. Ten lanes on `task:qa` at the PR head, per the boot recipe. Each Linear scenario includes a paired real GitHub evidence issue in this repository.

- [ ] Lane 1. Regression lane against trunk. Drive the same GitHub fixture on trunk and head, then its equivalent Linear ticket on head. Save `adapter-parity.json`. Pass when GitHub behavior is preserved and Linear reaches the same Human Review state.
- [ ] Lane 2. Apply the approved readiness signal through an authorized Linear actor. Save `linear-admission.json`. Pass when the normalized actor and snapshot are proved and exactly one run starts.
- [ ] Lane 3. Apply an unauthorized readiness signal under the test identity grant. Save `linear-unauthorized.json`. Pass when no run or GitHub branch appears.
- [ ] Lane 4. Submit a vague Linear ticket and answer its questions with fresh readiness. Save `linear-clarification.json`. Pass when the linked attempt preserves the first outcome and uses the updated authorized snapshot.
- [ ] Lane 5. Restart the controller during a Linear-origin run. Save `linear-recovery.json`. Pass when one run and one GitHub PR mapping survive.
- [ ] Lane 6. Disable either factory switch before Linear dispatch. Save `linear-disabled.json`. Pass when both trackers stop new work under the same policy.
- [ ] Lane 7. Exercise pagination and a real bounded rate-limit/error response. Save `linear-polling.log`. Pass when cursors do not skip tickets and errors cannot create authorization.
- [ ] Lane 8. Add owner feedback to the resulting GitHub PR. Save `linear-pr-feedback.json`. Pass when the existing feedback loop updates that PR and reports status back to Linear.
- [ ] Lane 9. Have the owner merge the known-good Linear-origin fixture PR. Save `linear-owner-merge.json`. Pass when Linear closure and one ledger row reflect the real merge SHA. Remain BLOCKED until the owner acts.
- [ ] Lane 10. Inspect stage mounts and provider configuration. Save `linear-credential-isolation.json`. Pass when Linear credentials remain controller-only and no webhook or public listener is required.

**Verify, perf.** Tests alone are not sufficient verification. A PR is verified only when its unit, live, and perf boxes are all checked.

- [ ] Metric. Measure poll/admission wall time, stage timings, and tokens/spend per GitHub and Linear run on trunk and head. Compare equivalent ticket contracts, not raw tracker response sizes.
- [ ] Probe. Interleave three GitHub regression runs and three paired Linear-origin head runs. Record trunk's unsupported Linear behavior separately. Save `perf.json`.
- [ ] Baseline. Record trunk GitHub poll and tiny-ticket totals first. Record the first Linear sample as its initial tracker baseline.
- [ ] Rule. Fail if head GitHub polling exceeds 120% of comparable trunk time plus 1 second, Linear admission exceeds two configured ticks without throttling, or equivalent stage execution exceeds the existing run budgets. Do not compare Linear end-to-end speed to trunk's unsupported response.

**Review gate.** The operator reviews before merge.

- [ ] Post the paired ticket/PR URLs and adapter-parity evidence to the operator. Use logs instead of a screenshot or video. Merge on a clean verdict. Keep the Linear live gate incomplete if workspace access is unavailable.

**Merge.**

- [ ] Record the exact-head verdict, live adapter proof, and Bugbot triage.
- [ ] Apply the patch-id rule in `playbooks/shipping.md`. Squash-merge `F13` on a clean verdict and a passing `check`, then branch the next PR from the new `main`. Leave deployment and package publication manual.

## Close the program

- [ ] Check every completed box against its artifact and exact revision. Leave blocked boxes unchecked. Do not describe this program as fully verified while Linear live proof, branch protection, mature metrics, or the required cross-family acceptance evidence is absent.
- [ ] Re-run the eight definition-of-done scenarios from `docs/design.md` on the assembled GitHub controller. Link the results from `F04b`, `F04c`, `F06a`, `F07b`, `F07c`, `F09a`, `F09b`, and `F10`. Explicitly report item 2's cross-family clause as incomplete under the approved same-family v1 limitation.
- [ ] Deliver the `autopilot-full` report with each PR's URL, merge commit, one-line verdict and exact verified head, the external actions taken and their grants, and excluded work with reasons. Include evidence and decision-trail paths.
- [ ] Confirm that the factory stops at Human Review, uses no stored GitHub token on the VM, uses no GitHub secrets for model access, and has no GitHub App, webhook receiver, or Tailscale dependency. Leave npm publishing and any future deployment outside this program.
- [ ] Leave computer-use verification out of v1. `docs/design.md` Known risks records the deferred pattern for a future UI target. Source is owner decision 2026-10-29, after comparing Warp Factories.

## Appendix A. Prototype evidence

The planning checkout was clean at `04b69c3b72b68ee8d4351d40bd42daf68d42a67f`. No implementation, external mutation, or new execution prototype ran while authoring this plan. The evidence below comes from `docs/decisions.tsv`, the prototype report, and bounded read-only VM inspection.

| Unit | Recorded proof | Revision or branch | What it does not prove |
| --- | --- | --- | --- |
| 0 | [Run 40767252647](https://github.com/giuseppecrj/pi-herdr-factorio/actions/runs/40767252647) printed `factory-smoke-ok` | The decisions row identifies the run, not its source SHA or branch. Read run metadata if reproducing historical provenance. | Current VM isolation or current CI architecture. Tailnet workflows and credentials were removed in `a893370`. Do not recreate them. |
| 1 | [Run 40768344796](https://github.com/giuseppecrj/pi-herdr-factorio/actions/runs/40768344796), [job 123098473635](https://github.com/giuseppecrj/pi-herdr-factorio/actions/runs/40768344796/job/123098473635), `docs/prototypes/herdr-on-runner.md` | Tested commit `a8f1285bb4e358bcfe6d56b4e7234b14fdaa2299`. Report committed at `1a345ea`, prototype merged at `fc34d66`. Decisions identify retained branch `factory-herdr-probe`, worktree removed with approval. | Rootless containment, allowed egress, full pstack execution, concurrent capacity, or cross-family review. The old runner used revoked tailnet access. |
| 2 | `npm run check` with 60 of 60 tests, `docs/decisions.tsv` | Skeleton `8ef1924`, widened `.github/` path protection `db91d1a`. Decisions identify retained branch `factory-skeleton`, worktree removed with approval. | Polling, service state, real adapter, sandbox, CI, or publication. Existing pipeline tests call the pure transition function through a fake. |
| 3 | VM `gh` reads, clone and label writes. Four model smoke replies. Later default-model smoke replied `default-ok`. All recorded in `docs/decisions.tsv`. | VM bring-up under `8154ca8`, provisioning `3228ca1`, default model `04b69c3`. No hosted run URL is recorded for these VM checks. | Current Anthropic authorization, sandbox egress, service recovery, or hosted candidate validation. Earlier Anthropic success does not authorize its use now. |

The unit 1 report records 10 seconds of setup, 22 seconds for the probe, and 34 seconds for the full CI job. Those are historical measurements on another execution setup, not budgets or comparative baselines for the new sandbox.

Read-only planning inspection used `SSH_AUTH_SOCK=$HOME/.ssh/headless-agent.sock ssh exedev@pi-factorio.exe.xyz`. It observed UID 1000, membership in the `docker` group, Docker 29.1.3, and daemon security options `seccomp` and `cgroupns`, without a `rootless` option. `newuidmap`, `slirp4netns`, and `rootlesskit` were not found on that non-login PATH. This does not prove rootless execution is impossible. It does prove that the active daemon's output is not rootless evidence.

Both `github.int.exe.xyz` and `llm.int.exe.xyz` resolved to `169.254.169.254`. Pi reported 1.4.0. Herdr was absent from the initial non-login PATH but reported 0.9.5 after adding the provisioned user bin directories. Repository-scoped `gh repo view` and label listing succeeded through `GH_HOST=github.int.exe.xyz`, and no `~/.config/gh/hosts.yml` existed. A global `gh api user` call failed JSON parsing. Use repository-scoped probes rather than assuming the integration implements every GitHub endpoint. The bot identity is an owner decision and prior recorded evidence, not a new successful global-user lookup.

No new sandbox, snapshot-at-label-time, main-gates, post-publication holdout, ledger, or Linear prototype is claimed here. Their first build boxes are explicit stop gates. The plan-only authorization prevents settling them through mutations now.

## Appendix B. Alternatives rejected

- A GitHub App or webhook receiver conflicts with the chosen `gh` polling controller. No public ingress is needed.
- Tailscale and hosted model execution belong to the retired prototypes. The VM now uses exe.dev integrations, and hosted CI runs deterministic checks without stored secrets.
- Automatic merge of factory-opened PRs conflicts with v1's Human Review boundary. Later autonomy belongs in checkpoint policy, not a hidden merge command. The root's merges of its own build PRs are a separate owner grant from 2026-10-28, and they need a clean verdict and a passing hosted check.
- A one-shot `pi -p` parent cannot stand in for persistent Herdr RPC orchestration. Unit 1 proved result delivery only while the parent remained alive.
- A workspace directory, Git worktree, non-root container UID, or prompt prohibition is not the OS and network boundary required by the integration's VM-wide authority.
- Candidate-owned checks alone can be weakened by editing scripts or deleting tests. Main-owned gates, candidate tests, and held-out tests must all pass.
- A sanitized working tree with the original Git object database still leaks an acceptance commit. Repair gets a clean export and restricted network, not a checkout with the suite merely deleted.
- Same-family sessions cannot establish cross-family judgment. They are the approved interim execution choice, with the missing independence claim explicit.
- Linear-native agent sessions introduce webhook acknowledgement requirements outside the selected polling model. Unit 13 uses ordinary polled tickets through the existing adapter.
- A database or distributed claim service adds no demonstrated value for the single VM/controller scope. Marker comments, workspace receipts, and serialized ledger writes cover the specified restart cases. Revisit only if an observed failure requires it.
- Reports 4 and 5 contain earlier recommendations about draft PRs, Apps, tailnets, and automatic landing. The later owner decisions in `docs/design.md` and `docs/decisions.tsv` supersede those recommendations.

## Appendix C. Risks

### R1. Rootless isolation and same-IP integrations remain unproved

`F05` owns this blocker. The VM has Docker, but active rootless operation has not been proved. Both integrations share an address, so an IP allowlist either blocks both or exposes both. The prototype must prove the specific gateway and container policy against Host/SNI changes and direct-route bypass while preserving npm and model access. If exe.dev routes an allowed model connection to GitHub based on a controllable header, the proposed gateway is insufficient. Stop and report that concrete limitation before adding a more complex design. Do not silently fall back to rootful or unrestricted workers.

### R2. Polling cannot assume a historical body snapshot

`F04b` and `F04c` own label-event identity, actor authority, and restart markers. Current issue text is not necessarily the text at label time. The adapter prototype must establish available event/version evidence and a conservative fail-closed rule for edits before collection. If GitHub cannot supply the required historical snapshot, keep that case blocked and explain the needed owner-approved contract adjustment. Never call a poll-time body a proven label-time snapshot. A marker written by anyone other than the integration bot is not controller state.

### R3. Main-owned configuration and CI need bootstrap merges

`F04a` introduces the first `.github/factory/WORKFLOW.md`. Its parser and fail-closed behavior can be tested before merge, but a valid production-main read cannot be claimed before that file lands on `main`. The root merges it under the owner's build-PR grant. Keep those live checks pending until it lands, and complete them before dispatch is enabled. Never add an untrusted candidate-config fallback merely to make the test pass.

`F07b`, `F07c`, and `F09a` own the CI trust path. The repository's only CI workflow is `.github/workflows/check.yml`, which runs the candidate's own `npm run check`. A workflow that must come from `main` cannot prove its hosted dispatch path before it exists on `main`. The root merges the bootstrap under the owner's build-PR grant after local and container proof, with the hosted boxes explicitly pending. This is an exception to the normal rule that every lane passes before merge, and it is not a claimed full pass. If that proof fails, stop the hosted path rather than run untrusted candidate workflow code as a substitute.

The gate prototype must settle test import routing, dependencies, read-only trusted files, and result ownership. `F09a` must prove how the trusted validation result becomes a required candidate-SHA check without exposing a write credential to candidate code. Missing or unrelated checks never pass. Branch-rule mutations require the owner's separate authorization and may need manual application if the integration lacks permission.

### R4. Public acceptance commits complicate repair secrecy

`F06b` proves the initial private suite. `F07c` proves repair isolation after publication. Once pushed to this public repository, the suite is not globally secret. The enforceable claim is that the builder and repair sessions cannot access it through their workspaces, Git history, session history, caches, tools, or allowed network. Npm package scripts and public fetch services must not become a route to GitHub. A passing initial-mount test does not settle this risk. Failed secrecy proof blocks repair rather than lowering the claim.

### R5. Ledger writes and restart effects are not automatically exactly-once

`F04c` and `F09b` own bounded crash-window tests. External writes can succeed before a local receipt exists. Markers, branch/PR identity, and run-ID ledger deduplication must reconcile actual remote state before retry. The ledger is an orphan branch, not an in-tree database. Only the controller writes it, serially and without force-push. The owner watches for missing artifacts, corrupt markers, duplicate rows, or remote advances. No distributed-controller claim is made.

### R6. Workflow and budget changes can weaken the factory

`F04a`, `F05`, and `F09b` own trusted workflow loading and cumulative accounting. `.github/factory/WORKFLOW.md` must come from the recorded main revision. Candidate changes cannot choose their own limits or gate commands. This plan's timings and token counts are proposed verification limits for tiny fixtures, not measured service guarantees. Record real baselines before tuning them. Some subscription-backed model responses may not report spend. Record unknown spend, retain token/time enforcement, and do not claim a dollar cap is enforced without a reliable price source. If a monetary cap is mandatory and cannot be evaluated, fail closed before more model work.

### R7. Linear access and historical authorization are not provisioned

`F13` owns the adapter but does not authorize a new credential, workspace, or integration. The owner must supply an approved controller-only access path and test identities. Polling history must establish readiness authority and snapshot identity. Leave Linear disabled and its live lanes blocked until those facts are proved. GitHub v1 delivery need not wait for Linear access, but unit 13 remains incomplete.

### R8. Cross-family review remains incomplete

All current stages use `openai/gpt-6.1-sol`. The design's cross-family acceptance criterion remains unmet even if every behavior lane passes. `F06b` and `F08` record identities and disclosure so a later provider change does not require a new state machine. When the owner's Anthropic proxy returns, first verify reachability and supported exact model IDs without changing shared preferences silently. Then run fresh acceptance and review seats on that family, repeat the seeded-defect corpus, and record family identities in evidence. Only then remove the incomplete cross-family label. This later provider enablement is not a hidden v1 dependency or permission to spend exe.dev credits.

### R9. Human gates and real identities cannot be simulated away

`F04b`, `F09a`, `F10`, and `F13` need actual actor permissions and some owner actions. A read-only account generally cannot apply GitHub labels, while a triage account may label without write access. Use an explicitly authorized test identity rather than a forged payload for the live admission lane. Fake adapters remain unit evidence only. Owner merges, closure tests, and branch rules are real gates. Missing authorization leaves them blocked. The seven-day metric in `F12` also needs mature evidence before a real zero-defect claim.

### R10. The plan template needs backend-specific adaptations

These are every intentional template adaptation in this document.

1. The control skill is a named CLI procedure, not a preinstalled UI automation skill. `docs/operations/factory-cli.md` arrives in `F04a`. The installed swarm skill is present and retains its real path.
2. Each live lane saves a concrete text/JSON artifact or URL list instead of a `.png`. The checker calls this a screenshot requirement but only enforces a literal `Save` path. Those artifacts prove backend behavior without invented screenshots.
3. Each review gate explicitly says that logs replace a screenshot or video. Those words satisfy the checker's literal review-block requirements. No recording or screenshot is claimed or required where it adds no evidence.
4. The template's cross-family reviewer language becomes context-isolated same-family seats under the owner's explicit interim model decision. The missing cross-family gate remains visible, not silently waived as passed.
5. Every PR gets a full verdict before merge, including changes without a visual interaction. This is stricter than the template's optional interaction-only review gate. Since 2026-10-28 the root merges build PRs under the owner's grant. PRs the factory opens at runtime still stop for the owner.
6. The dependency graph is one serial chain rather than a fabricated pair of independent first PRs. Shared contracts and the CI bootstrap justify that choice. Ten verifier lanes mean ten scenarios, not ten concurrent controllers on a two-vCPU VM. Read-only lanes may run concurrently, while mutation/resource-heavy scenarios use scoped fixtures and service capacity limits.
7. The `F04a` main-owned configuration and the `F07b` main-owned CI workflow must land on `main` before their main-backed proof can run. The root merges both under the owner's build-PR grant. These explicit exceptions do not create false all-green verdicts. Their main-backed boxes stay pending until the post-merge checks pass.
8. The playbook's prototype-before-plan and child investigation steps were constrained by this leaf's plan-only authorization. Existing prototypes are recorded, code was read directly, no children were launched, and unproved engineering choices became named prototype-first gates.
9. The check script is not silent on success. It always prints one box-count line per PR and a summary. The success predicate is exit code 0 and `17 PR sections, 0 problems`, with no diagnostic lines. Its source was read before writing this plan.
10. New CLI commands, runtime symbols, and paths are planned deliverables. Trunk lanes record unsupported features instead of pretending that the skeleton already runs the controller. Performance uses absolute budgets for new work rather than ratios to missing behavior.

### R11. Restarts use up attempts

`F04c` charges a restart during a stage as a failed attempt. With the default of 3 attempts, two badly timed restarts and one real failure end a run as failed. That charge is the safe default, because the interrupted attempt may already have spent tokens. `F09b` records interrupted attempts in each ledger row. If `F12`'s data shows restarts end runs, revisit the charge then, not before.

## Appendix D. Links and reading list

The normative product specification is [Factory design](../design.md), with chronology in [the decision trail](../decisions.tsv). [The Herdr prototype](../prototypes/herdr-on-runner.md) bounds what unit 1 proved. The skill inventory is [the synthesis](../../research/SYNTHESIS.md), with licensing in [provenance](../../research/PROVENANCE.md). Read [integration research](../../research/reports/factory-research-4.md), [validation research](../../research/reports/factory-research-5.md), and [the owner-skill audit](../../research/reports/factory-review-1.md) as supporting evidence, subject to the later owner decisions.

The coordination reference is [Symphony SPEC at be10a1b](https://github.com/openai/symphony/blob/be10a1b79df723d6d7612b5651c8522704dafb2e/SPEC.md), especially workflow loading, scheduling, workspaces, and recovery. Pi RPC implementers must read the installed `/home/g/.local/share/mise/installs/pi/1.4.0/pi/docs/rpc.md`, its command/event cross-references, and `docs/security.md` from that same Pi installation before `F05`. Read package and extension documentation there before changing extension loading. Do not infer RPC settlement behavior from process exit alone.

The installed writing skills are `/home/g/.pi/agent/npm/node_modules/pi-herdr-pstack/skills/technical-writing/SKILL.md` and `/home/g/.pi/agent/npm/node_modules/pi-herdr-pstack/skills/unslop/SKILL.md`. Cleanup uses `/home/g/.pi/agent/npm/node_modules/pi-herdr-pstack/skills/no-comments/SKILL.md`.

Use `/home/g/.pi/agent/npm/node_modules/pi-herdr-pstack/skills/how/SKILL.md` before `F04a`, `F04c`, `F05`, `F07b`, `F07c`, `F09a`, and `F13` to explain the affected ownership and trust boundaries. Use `/home/g/.pi/agent/npm/node_modules/pi-herdr-pstack/skills/interrogate/SKILL.md` for their adversarial review and for `F06b`, `F08`, and `F09b`. The root runs any delegated lanes. Leaf implementers do not launch grandchildren. Same-family reviews use the disclosed limitation in R8.

Keep future execution trails per `/home/g/.pi/agent/npm/node_modules/pi-herdr-pstack/skills/show-me-your-work/SKILL.md` in each retained owner's uncommitted `decisions.tsv`, with a root trail linking those files. This plan-authoring task writes only this plan, not a second trail. The runtime's `factory/ledger` is a product feature, not a substitute for implementation decision trails.

Read the existing code and callers before each edit. `src/run.ts` owns `Run`, `Progress`, `Verdict`, and digests. `src/stages.ts` owns `advance`, stage order, and the shared two-round repair cap. `src/policy.ts` owns admission, fail-closed switch parsing, forbidden paths, and the current digest-only handoff precondition. `src/tickets.ts` currently has `fetch`, not polling methods. `extension/index.ts` currently registers only `/factory status`. `test/pipeline.test.ts` exercises the pure core through `test/fake-ticket-adapter.ts`, not a service. `server/provision.sh` sets the default model and installs Pi/Herdr packages but does not implement the sandbox or controller.

The plan checker command is `node /home/g/.pi/agent/npm/node_modules/pi-herdr-pstack/skills/poteto-mode/scripts/check-plan.mjs docs/plans/factory-v1.md`. Its successful stdout contains counts by design. Preserve that output in the handoff rather than suppressing it to imitate a silent check.
