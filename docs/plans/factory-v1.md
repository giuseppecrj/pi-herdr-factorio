# Deliver the factory v1 plan

Build the GitHub-first factory for `giuseppecrj/pi-herdr-factorio` on the exe.dev VM `pi-factorio`.
Take authorized issues through fixed stages to a ready PR labeled `factory:review`. The owner merges every PR.
Keep GitHub writes in the controller, model execution in a sandbox, and required checks in secret-free GitHub-hosted CI.
Implement build-order units 4 through 13 in this order.
`F04a`, `F04b`, `F04c`, `F05`, `F06a`, `F06b`, `F07a`, `F07b`, `F07c`, `F07d`, `F08`, `F09a`, `F10b`, `F09b`, `F10c`, `F10`, `F12a`, `F09c`, `F11`, `F12`, `F13`.
`F07d` is an operator tool, build-order row 7d, not a runtime stage.
`F09d` is an optional research unit after `F09c`. It ships a decision memo and a throwaway prototype, not product code, and blocks nothing.
Treat units 0 through 3 as historical prototype evidence, not work to repeat.

## How to read this

One box is one unit of work. Every box names the evidence that checks it. A nested box is a sub-step of the box above it. Check a box only when its evidence exists, such as a file, a log, a test result, or a SHA. The body is a how-to. The appendices explain and record.

The program runs the poteto-mode playbook `playbooks/autopilot-full.md`, with merge-then-branch for this serial chain. The root's historical merge grant covered build PRs through F08. From F09a onward, every build PR stops at merge-ready for the owner after its exact-head review and checks. The owner alone merges the F09a bootstrap and later build PRs. No agent arms auto-merge. The factory's runtime still stops at Human Review, and the owner merges every PR the factory opens. This document grants no other execution, commit, push, PR, issue, service, or configuration action.

Use the **Factory CLI control procedure** below as the control skill. It combines `ssh`, `gh`, and the factory CLI and extension. The maintained recipes are in `.pi/skills/verify-factory/`. This backend has no visual interface to verify. Live lanes drive real scenarios on `pi-factorio` against real GitHub issues in this repository, not fake-adapter tests. Save redacted logs, JSON snapshots, and issue or PR URLs instead of screenshots or video. Appendix C records this template adaptation and the other exceptions.

Treat every new path, symbol, command, log field, and numerical budget below as a proposed implementation contract, not an existing capability. At the planning base `04b69c3`, only the pure state machine, policy helpers, fake adapter, provisioning script, and `/factory status` exist. Do not check future boxes with those prototypes alone.

The owner's 2026-10-30 decision limited VM stages to OpenAI models through exe.dev's ChatGPT subscription and superseded the earlier xAI fallback. The owner's 2026-11-02 decision allows Anthropic models on the VM through exe.dev's integration. OpenAI stays the builder family. `F10c` moves the accept stage and one blocking review seat to an Anthropic model. Until `F10c` merges, every stage stays on OpenAI. F08 configures `openai/gpt-6.1-sol` for review and `openai/gpt-6.1-terra` for one retry after a recorded security-seat refusal. Count both models' usage. Anthropic usage counts against the same caps. xAI stays unused. Use fresh acceptance and review sessions. Today F08 labels each review seat `context-isolated, <same|different> model, same family, not cross-family`, comparing its answering model with the builder, and R8 stays incomplete until `F10c` merges.

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

- [ ] Give each PR one owner role with the full lifecycle that `autopilot-full` names. The root coordinated merges through F08. From F09a onward, the owner alone merges. Launch each round as a fresh bare leaf with `fork: false`, bounded files, explicit model and thinking, verification, and commit policy. Keep one retained checkout and one canonical branch per owner.
- [ ] Follow this dependency graph. Branch dependent work from `main` after its parent merges, or stack it on the parent's committed tip while the parent is still in review. Record the parent SHA in each brief.
  - [ ] Start `F04a` from `main`. Follow `F04a -> F04b -> F04c -> F05 -> F06a -> F06b -> F07a -> F07b -> F07c -> F07d -> F08 -> F09a -> F10b -> F09b -> F10c -> F10 -> F12a -> F09c -> F11 -> F12 -> F13`.
  - [ ] Run `F09d` after `F09c` as optional docs-only work. It writes only `docs/prototypes/ios-app/`, so it may run beside later code units, and no unit depends on it.
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
- [ ] Merge a PR only at the verified head, subject to the explicit `F04a`, `F07b`, and owner-merged `F09a` bootstrap exceptions. Record the verdict SHA, base SHA, patch-id, and evidence paths. Apply the patch-id rule in `playbooks/shipping.md` after rebases. Re-run CI and mergeability after rewritten pushes. Through F08, the root squash-merged under the historical build-PR grant. From F09a onward, the root hands the reviewed PR to the owner and waits for the owner's merge before branching the next unit from `main`. Never arm auto-merge, and never infer a verdict from a green check.

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
- [ ] Probe. Interleave three metric calculations on the same ledger copy and three previous/head replay pairs for one fixed tiny ticket. Record trunk's unsupported metric command separately. Save `perf.json`. The owner reduced the three replay pairs to one, and lane 6 never completed that pair, so the probe is not met. Trunk's unsupported metric command is recorded separately (exit 2).
- [ ] Baseline. Record trunk's unsupported metric response and the previous factory's tiny-ticket stage timings and usage first. Trunk's response is recorded, but the previous factory's tiny-ticket timings come only from the c3 specify stage, so the baseline is not met.
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
- [ ] Probe. Interleave three metric calculations on the same ledger copy and three previous/head replay pairs for one fixed tiny ticket. Record trunk's unsupported metric command separately. Save `perf.json`. The owner reduced the three replay pairs to one, and lane 6 never completed that pair, so the probe is not met. Trunk's unsupported metric command is recorded separately (exit 2).
- [ ] Baseline. Record trunk's unsupported metric response and the previous factory's tiny-ticket stage timings and usage first. Trunk's response is recorded, but the previous factory's tiny-ticket timings come only from the c3 specify stage, so the baseline is not met.
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
- [ ] Probe. Interleave three metric calculations on the same ledger copy and three previous/head replay pairs for one fixed tiny ticket. Record trunk's unsupported metric command separately. Save `perf.json`. The owner reduced the three replay pairs to one, and lane 6 never completed that pair, so the probe is not met. Trunk's unsupported metric command is recorded separately (exit 2).
- [ ] Baseline. Record trunk's unsupported metric response and the previous factory's tiny-ticket stage timings and usage first. Trunk's response is recorded, but the previous factory's tiny-ticket timings come only from the c3 specify stage, so the baseline is not met.
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
- [ ] Probe. Interleave three metric calculations on the same ledger copy and three previous/head replay pairs for one fixed tiny ticket. Record trunk's unsupported metric command separately. Save `perf.json`. The owner reduced the three replay pairs to one, and lane 6 never completed that pair, so the probe is not met. Trunk's unsupported metric command is recorded separately (exit 2).
- [ ] Baseline. Record trunk's unsupported metric response and the previous factory's tiny-ticket stage timings and usage first. Trunk's response is recorded, but the previous factory's tiny-ticket timings come only from the c3 specify stage, so the baseline is not met.
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
- [ ] Probe. Interleave three metric calculations on the same ledger copy and three previous/head replay pairs for one fixed tiny ticket. Record trunk's unsupported metric command separately. Save `perf.json`. The owner reduced the three replay pairs to one, and lane 6 never completed that pair, so the probe is not met. Trunk's unsupported metric command is recorded separately (exit 2).
- [ ] Baseline. Record trunk's unsupported metric response and the previous factory's tiny-ticket stage timings and usage first. Trunk's response is recorded, but the previous factory's tiny-ticket timings come only from the c3 specify stage, so the baseline is not met.
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
- [ ] Probe. Interleave three metric calculations on the same ledger copy and three previous/head replay pairs for one fixed tiny ticket. Record trunk's unsupported metric command separately. Save `perf.json`. The owner reduced the three replay pairs to one, and lane 6 never completed that pair, so the probe is not met. Trunk's unsupported metric command is recorded separately (exit 2).
- [ ] Baseline. Record trunk's unsupported metric response and the previous factory's tiny-ticket stage timings and usage first. Trunk's response is recorded, but the previous factory's tiny-ticket timings come only from the c3 specify stage, so the baseline is not met.
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
- [ ] Probe. Interleave three metric calculations on the same ledger copy and three previous/head replay pairs for one fixed tiny ticket. Record trunk's unsupported metric command separately. Save `perf.json`. The owner reduced the three replay pairs to one, and lane 6 never completed that pair, so the probe is not met. Trunk's unsupported metric command is recorded separately (exit 2).
- [ ] Baseline. Record trunk's unsupported metric response and the previous factory's tiny-ticket stage timings and usage first. Trunk's response is recorded, but the previous factory's tiny-ticket timings come only from the c3 specify stage, so the baseline is not met.
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
- [ ] Probe. Interleave three metric calculations on the same ledger copy and three previous/head replay pairs for one fixed tiny ticket. Record trunk's unsupported metric command separately. Save `perf.json`. The owner reduced the three replay pairs to one, and lane 6 never completed that pair, so the probe is not met. Trunk's unsupported metric command is recorded separately (exit 2).
- [ ] Baseline. Record trunk's unsupported metric response and the previous factory's tiny-ticket stage timings and usage first. Trunk's response is recorded, but the previous factory's tiny-ticket timings come only from the c3 specify stage, so the baseline is not met.
- [ ] Rule. Fail if head's comparable gate execution exceeds twice trunk plus 60 seconds, or exceeds 10 minutes. Fail any model use in CI. Bound time from dispatch to a terminal receipt at 20 minutes, with queue outages reported separately rather than hidden. Give main's baseline test run 180 seconds. The owner raised it from 90 seconds on 2026-11-03, after main's own baseline took 89.9 seconds on the hosted runner for fixture 568.

**Review gate.** The operator reviews before merge.

- [ ] Post good/bad candidate receipts to the operator. Use logs and run URLs instead of a screenshot or video. Record the bootstrap exception in the PR before the root merges the workflow. Do not call that bootstrap fully verified until the hosted lanes pass.

**Merge.**

- [ ] Record the exact-head local verdict and Bugbot triage. Record the CI bootstrap merge, made by the root under the owner's build-PR grant, separately from the later full hosted verdict.
- [ ] Apply the patch-id rule in `playbooks/shipping.md`. Merge the bootstrap after its parent PRs, then finish hosted proof on the resulting trusted revision. No dependent runtime publication proceeds on a local-only verdict.

## Publish held-out tests and bind CI verdicts (F07c)

**Depends on.** F07b with hosted proof complete. This completes unit 7.

**Files.**

- [ ] Create `src/validation.ts`, `src/publication.ts`, `test/validation.test.ts`, `test/publication.test.ts`, and `docs/prototypes/heldout-ci/`.
- [ ] Edit `src/run.ts`, `src/stages.ts`, `src/policy.ts`, `src/orchestrator.ts`, `src/markers.ts`, `src/workflow.ts`, `src/build.ts`, `server/controller.ts`, `server/sandbox.ts`, and their tests for publication, recovery and exact-head CI evidence. Edit `test/helpers.ts`, `test/pipeline.test.ts`, `test/stages.test.ts`, and `test/policy.test.ts` for the bound pipeline.
- [ ] Edit `.github/factory/WORKFLOW.md` only for controller-only validate. Edit `docs/statecharts/**`, `docs/operations/sandbox.md`, `docs/operations/factory-cli.md`, `.pi/skills/verify-factory/**`, and this Files block for the F07c contracts. The held-out gate and static exclusions already landed in F07b.

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
- [ ] Probe. Interleave three metric calculations on the same ledger copy and three previous/head replay pairs for one fixed tiny ticket. Record trunk's unsupported metric command separately. Save `perf.json`. The owner reduced the three replay pairs to one, and lane 6 never completed that pair, so the probe is not met. Trunk's unsupported metric command is recorded separately (exit 2).
- [ ] Baseline. Record trunk's unsupported metric response and the previous factory's tiny-ticket stage timings and usage first. Trunk's response is recorded, but the previous factory's tiny-ticket timings come only from the c3 specify stage, so the baseline is not met.
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
- [ ] Edit `server/cli.ts` and `docs/operations/factory-cli.md` only for the `viewer` subcommand and its documentation. Edit `.pi/skills/verify-factory/**` for its viewer feature recipe. Edit this F07d Files block.
- [ ] Edit `server/sandbox.ts`, `server/controller.ts`, and their tests only to extract pure stage receipt and stored-verdict readers. Keep every existing caller's behavior identical. The coordinator granted this extraction after the first build's reader-scope report.
- [ ] Edit `server/sandbox.ts`, `test/sandbox/**`, and `docs/operations/sandbox.md` for private session retention at build cleanup. The fix-round grant permits this cleanup change only, keeping newest whole parent and child sessions within 8 MiB per execution and recording dropped paths as `session_truncated` in the receipt.

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
- [ ] Probe. Interleave three metric calculations on the same ledger copy and three previous/head replay pairs for one fixed tiny ticket. Record trunk's unsupported metric command separately. Save `perf.json`. The owner reduced the three replay pairs to one, and lane 6 never completed that pair, so the probe is not met. Trunk's unsupported metric command is recorded separately (exit 2).
- [ ] Baseline. Record trunk's unsupported metric response and the previous factory's tiny-ticket stage timings and usage first. Trunk's response is recorded, but the previous factory's tiny-ticket timings come only from the c3 specify stage, so the baseline is not met.
- [ ] Rule. Fail if the viewer takes over 2 seconds to start, any view takes over 1 second to render for the fixture run, resident memory exceeds 200 MB, or any request calls a model or GitHub.

**Review gate.** The operator reviews before merge.

- [ ] Post `viewer.html`, the escape canary, and the read-only log to the operator. Use saved HTML and logs instead of a screenshot or video. Publish a live page only through an owner-authorized `tailscale serve` link. Merge on a clean verdict and a passing `check`.

**Merge.**

- [ ] Record the exact-head verdict and complete Bugbot triage.
- [ ] Apply the patch-id rule in `playbooks/shipping.md`. Squash-merge `F07d` on a clean verdict and a passing `check`, then branch the next PR from the new `main`.

## Review candidates and bound repair rounds (F08)

**Depends on.** F07c. Start it after `F07d` merges so the chain stays serial. It needs nothing from the viewer. This implements unit 8.

**Files.**

- [ ] Create `src/review.ts`, `test/review.test.ts` with inline fixtures, and `skills/code-review/`, `skills/security-review/`, `skills/simplify/`, `skills/ultrareview/` with provenance.
- [ ] Edit `src/stages.ts`, `src/run.ts`, `src/orchestrator.ts`, `src/build.ts`, `src/validation.ts`, `src/workflow.ts`, `src/artifacts.ts`, `src/policy.ts`, `server/controller.ts`, `server/sandbox.ts`, and `server/sandbox/routes.ts` for review, round storage, repair and OpenAI fallback.
- [ ] Edit `test/stages.test.ts`, `test/pipeline.test.ts`, `test/orchestrator.test.ts`, `test/build.test.ts`, `test/review.test.ts`, `test/workflow.test.ts`, `test/policy.test.ts`, `test/helpers.ts`, and `test/sandbox/runner.cases.ts` for bindings, shared caps, recovery and refusal tests.
- [ ] Edit `server/viewer/claim.ts`, `server/viewer/evidence.ts`, `test/viewer.test.ts`, and `docs/operations/viewer.md` for round-aware evidence without compatibility aliases.
- [ ] Edit `skills/README.md`, `.github/factory/WORKFLOW.md` (review only), `docs/statecharts/**`, `docs/operations/sandbox.md`, `docs/operations/factory-cli.md`, `.pi/skills/verify-factory/**`, and this Files block for the shipped contracts.

**Build.**

- [ ] Implement `reviewCandidate` using fresh sessions over the validated candidate and contract. Adapt the selected licensed code-review and security-review sources. Write simplify and ultrareview from permitted documentation and pstack patterns, not unlicensed prompt copies.
- [ ] Bind findings to candidate SHA and patch digest. Use deterministic risk selection for extra review on policy, security, dependency, and factory-skill changes. Label every same-family seat honestly. Leave cross-family enforcement incomplete under R8.
- [ ] Set the security-review seat to `openai/gpt-6.1-sol` with `fallback_model: openai/gpt-6.1-terra`. Prove the fallback on a seeded vulnerability whose review prompt the primary refuses. If no such prompt can be found, record that the fallback path was tested only by an injected refusal. A security review that both models refuse blocks handoff.
- [ ] Label every review seat `context-isolated, <same|different> model, same family, not cross-family`. Save the round's `receipt.json` with the seat, requested and observed model, fallback evidence, usage and R8 still marked incomplete. An OpenAI fallback is not cross-family.
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
- [ ] Lane 6. Make a repair edit or change stored patch bytes after prior checks. Save `simplify-invalidates.json`. Pass when old checks cannot certify the changed bytes. Simplify itself stays advisory and read-only.
- [ ] Lane 7. Exhaust a reviewer budget. Save `review-budget.json`. Pass when the missing review cannot become a passing verdict and usage stays charged to the run.
- [ ] Lane 8. Inspect review input and model identity. Save `review-context.json`. Pass when the session is fresh and the receipt says context-isolated rather than cross-family.
- [ ] Lane 9. Change a policy or dependency path in a fixture candidate. Save `risk-review.json`. Pass when the deterministic risk selector adds the required extra review.
- [ ] Lane 10. Interrupt during repair and restart. Save `repair-recovery.json`. Pass when the same repair count and candidate identity survive without repeating a completed build.

**Verify, perf.** Tests alone are not sufficient verification. A PR is verified only when its unit, live, and perf boxes are all checked.

- [ ] Metric. Measure each review seat, each repair, and whole-run wall time and tokens/spend on both revisions.
- [ ] Probe. Interleave three metric calculations on the same ledger copy and three previous/head replay pairs for one fixed tiny ticket. Record trunk's unsupported metric command separately. Save `perf.json`. The owner reduced the three replay pairs to one, and lane 6 never completed that pair, so the probe is not met. Trunk's unsupported metric command is recorded separately (exit 2).
- [ ] Baseline. Record trunk's unsupported metric response and the previous factory's tiny-ticket stage timings and usage first. Trunk's response is recorded, but the previous factory's tiny-ticket timings come only from the c3 specify stage, so the baseline is not met.
- [ ] Rule. Fail if review of the tiny fixture exceeds 5 minutes or 30,000 tokens across seats, or one repair plus revalidation exceeds 20 minutes or 80,000 additional tokens. Enforce cumulative configured caps, including failed attempts.

**Review gate.** The operator reviews before merge.

- [ ] Post the planted-defect and two-round-cap receipts to the operator. Use JSON instead of a screenshot or video. Merge on a clean verdict and disclose the incomplete cross-family requirement.

**Merge.**

- [ ] Record the exact-head behavior verdict and Bugbot triage with model-family limitations.
- [ ] Apply the patch-id rule in `playbooks/shipping.md`. Squash-merge `F08` on a clean verdict and a passing `check`, then branch the next PR from the new `main`.

## Hand off verified PRs and require human merge (F09a)

**Depends on.** F08. This implements unit 9's handoff and branch-protection contract.

**Files.**

- [ ] Create `src/handoff.ts`, `src/attention.ts`, `test/handoff.test.ts`, `test/attention.test.ts`, and `docs/operations/human-review.md`.
- [ ] Edit `src/run.ts`, `src/stages.ts`, `src/policy.ts`, `src/orchestrator.ts`, `src/validation.ts`, `src/publication.ts`, `src/review.ts`, `src/markers.ts`, `src/tickets.ts`, and `src/adapters/github.ts` for the candidate book, immutable generations, cumulative accounting, trusted reports and owner handoff.
- [ ] Edit `server/controller.ts`, `server/sandbox.ts`, `server/cli.ts`, `server/viewer/claim.ts`, `server/viewer/evidence.ts`, `server/viewer/render.ts`, and `extension/index.ts` for the single controller interpreter, captured executions and shared local attention view.
- [ ] Edit `test/helpers.ts`, `test/fake-ticket-adapter.ts`, `test/pipeline.test.ts`, `test/stages.test.ts`, `test/policy.test.ts`, `test/orchestrator.test.ts`, `test/validation.test.ts`, `test/publication.test.ts`, `test/review.test.ts`, `test/markers.test.ts`, `test/github-adapter.test.ts`, `test/extension.test.ts`, `test/viewer.test.ts`, and `test/sandbox/runner.cases.ts` for these contracts.
- [ ] Edit `.github/workflows/ci.yml` and `.github/workflows/check.yml` under the owner's explicit workflow-authoring grant. Keep candidate execution read-only and the checks-write reporter separate.
- [ ] Edit `docs/operations/factory-cli.md`, `docs/operations/sandbox.md`, `docs/operations/viewer.md`, `docs/design.md`, this plan, `docs/statecharts/**`, and `.pi/skills/verify-factory/**` only for F09a contracts and verification recipes. No live pass is implied.

**Build.**

- [ ] Add `Progress.waiting` for the mandatory merge checkpoint. Preserve the future contract-checkpoint type without enabling it. Keep `land` deterministic. Use one candidate policy for the public core and controller, with immutable generation evidence and captured execution accounts. Waiting holds no model slot or timer. Accept `landed` only from a controller-observed external merge after stop and charge, never a model response.
- [ ] Implement `handoffCandidate` with fresh switch checks, allowed paths, complete verdict, exact current head, and passing required CI. Build the final suite-bearing candidate before CI and fresh review. Promote its stable owned PR ref with `force:false`, not an expected-head CAS claim. Reconcile ref/PR lag and the ordinary PR check. Create one ready non-draft `factory:review` PR, request the owner, and post redacted evidence links. Refresh that same PR within three run-wide refreshes, two shared repairs, three issued reviews per round, and six generations. Preserve stricter configured review attempts and every existing token/time limit. No old-seat rebind or F10 repair is enabled.
- [ ] Prototype how the main-owned validation result becomes a required check on the candidate SHA. Keep any write-capable check-reporting step separate from untrusted candidate execution, with no stored CI secret. Validate the trusted workflow identity and exact run/head association before reporting. Do not use an arbitrary same-named check as proof.
- [ ] Document and verify the owner's branch-protection setup with required main-owned checks, review requirements, and no factory bypass. Settings changes need a separate grant. If integration permissions cannot inspect or set them, give the owner exact manual steps and leave the protection gate incomplete.
- [ ] Watch the PR without model usage while waiting. Observe merge before issue closure, unlabel, switch guards, or working refresh in every PR-backed phase and restart. Stop and charge captured work before finalizing. Record the actual merged head, merge SHA, and unknown actor when absent. Match historical certification independently of active readiness; record unmatched heads as owner overrides. Close the issue idempotently and retain evidence for the later ledger writer. Closed-unmerged is cancelled. Missing private evidence grants no reconstructed certification or budget.
- [ ] Remove stale runtime claims that imply automatic merging. Leave full autonomy and configurable contract approval for a later checkpoint-policy release.
- [ ] Give the kill switch one meaning. While either switch is off, block new claims, model launches, candidate publication, and handoff. Hold early-stage runs and their claims for resumption when both switches are on, subject to normal issue reconciliation. Continue existing-PR observation before switch holds, including stop, charge, and terminal bookkeeping. An observed merge can still end a run as landed, and a closed-unmerged PR or positive authorization withdrawal can still cancel it after captured work is stopped and charged. Remove the unused `kill_switch_off` runtime event and its `disabled` reject reason. Keep disabled admission refusals separate from runtime holds. Test held-run resumption when both switches are on, disabled handoff refusal, and existing-PR terminal observation while dispatch is held.
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
- [ ] Probe. Interleave three metric calculations on the same ledger copy and three previous/head replay pairs for one fixed tiny ticket. Record trunk's unsupported metric command separately. Save `perf.json`. The owner reduced the three replay pairs to one, and lane 6 never completed that pair, so the probe is not met. Trunk's unsupported metric command is recorded separately (exit 2).
- [ ] Baseline. Record trunk's unsupported metric response and the previous factory's tiny-ticket stage timings and usage first. Trunk's response is recorded, but the previous factory's tiny-ticket timings come only from the c3 specify stage, so the baseline is not met.
- [ ] Rule. Fail if a ready candidate takes over 90 seconds to produce its PR without throttling, owner merge takes over two ticks to observe, or waiting spends model tokens. Report full fixture execution against a 35-minute budget excluding human wait and CI queue outages.

**Review gate.** The operator reviews before merge.

- [ ] Post the real PR URL, available required-check proof, and owner-action receipts to the operator. Use text artifacts instead of a screenshot or video. Stop this build PR at merge-ready for the owner. The owner merges its single R3 reporter bootstrap containing both approved workflow edits after local gates and independent review, with main-only P4, native Actions, production protection, owner-action, live, and perf proof explicitly pending. Never perform the owner's test merge of a factory-opened fixture PR yourself.

**Merge.**

- [ ] Record the exact-head verdict and Bugbot triage. Leave branch-protection or owner-action boxes unchecked when their evidence is missing.
- [ ] Apply the patch-id rule in `playbooks/shipping.md`. The owner alone squash-merges `F09a` on the reviewed exact head with a passing `check`. Complete main-backed reporter and protection proof after bootstrap before enabling runtime handoff. From F09a onward every build PR stops at merge-ready for the owner; no agent gains merge authority.

## Prove held-out tests fail on the base (F10b)

**Depends on.** F09a. This adds a base-tree check and oracle-quality diagnosis to the acceptance suite from `F06b`, before build spends tokens. On 2026-11-02 the owner moved F10b ahead of F09b, because generated suites with broken checks killed fixtures 558, 561 and 568 after their build tokens were spent, and the paused F09a lanes need that blocker fixed first.

**Split.** F10b ships as two sequential PRs.

- [ ] `F10b-1` refuses broken suites before build. It adds criterion kinds, suite version 2, the reporter's private facts, the asynchronous base-check subphase with its receipts and keyed refusal notice, the 558, 561 and 568 base replays on recorded base files with a positive control, and the receipt-derived "Not proven" entries for judge-only criteria, `r8` and pending live proof. It has no oracle veto, because each of the three fixtures refuses on its own observed base result. The paused F09a lanes resume after it merges. On 2026-11-05 the owner allowed one private accept retry after a base refusal the author can fix, inside the same accept allowance and run cap, with the refusal facts only in the retry prompt and the public notice only on the final refusal.
- [ ] `F10b-2` diagnoses failed CI before repairing. It adds the private VM replay, `classifyFailure` with a mandatory validation assessment, outcome-only judgments, the remaining "Not proven" entries and the adjudicated patch-level oracle corpus. Oracle classification belongs here. The live lanes below run after it merges. On 2026-11-03 the coordinator chose a dual-tree replay. Every diagnosable held-out failure runs the published suite on both the gate tree and the full candidate tree. Any disagreement between CI, the gate tree and the full tree is `missing_evidence` and spends no repair, which is how #576's correct candidate would have stopped. The base check runs the suite twice in fresh trees inside its one 180-second cap and refuses as `base_nondeterministic` when the per-test outcomes differ.

**Files.**

- [ ] Create `src/diagnosis.ts`, `test/base-check.test.ts`, `test/diagnosis.test.ts`, `test/fixtures/oracle-corpus/`, and `docs/prototypes/base-check/`.
- [ ] Edit `src/specify.ts`, `src/accept.ts`, `src/stages.ts`, `src/orchestrator.ts`, `server/gates.ts`, `server/controller.ts`, `skills/acceptance/SKILL.md`, `test/accept.test.ts`, `test/specify.test.ts`, `test/candidate-gates.test.ts`, and `test/orchestrator.test.ts` for scenario kinds, the base run, private failure details, failure classes, and their receipts.
- [ ] Edit `src/handoff.ts`, `src/review.ts`, `server/controller.ts`, `test/handoff.test.ts`, and `test/review.test.ts` for the "Not proven" section and the closed set of non-pass judgment outcomes.

**Build.**

- [ ] Give each acceptance criterion in `Contract` a kind, `new_behavior` or `preservation`. Specify chooses the kind. A missing or unknown kind fails contract validation. Each accept scenario takes the kind of the criteria it maps, and a scenario that maps both kinds fails suite validation. The base rule covers only scenarios with checks. A judge-only scenario has no assertion, so the base run skips it and review still judges it. Each checked scenario owns exactly one check file, never shared with another scenario, so each file's result is that scenario's result. Every `new_behavior` criterion needs at least one checked scenario. A suite whose new-behavior criterion maps only to judge-only scenarios fails suite validation.
- [ ] Add a named held-out base runner, `runHeldoutBase`, to `server/gates.ts`. Do not reuse `runVisibleTests`, which applies a patch and runs the visible command, not the private suite. After `accept` stores the suite, extract a fresh copy of the run's pinned GitHub tarball, which has no `.git`. Never reuse a stage workspace, because the accept sandbox can write it. Refuse a refused or partial extraction, such as one that omitted a symlink, as `base_tree_unsupported`. Run the reporter and freeze preload from that tarball's own `.github/factory/gates/`, the same main-owned copy CI runs at the base SHA, so the gate SHA is the base SHA. Record their digest on the receipt, and refuse when they are absent. A unit test pins its tree digest to the CI gate's `exportTree` output for the repository, so new export attributes, symlinks or submodules fail closed. Install dependencies once per `package-lock.json` digest with the gate's prefetch and offline install, and bind that cache read-only. Run only the private suite there, through the existing `GateRunner` isolation in `server/gates.ts`, with no network, no credentials, and no publication route. Never run generated checks directly on the controller host. Run inside an owner-named systemd user scope, so the startup reconcile stops a leftover after a restart. Run it as an asynchronous subphase of `accept`, not a new stage. Cap it at the lesser of 180 seconds and the accept wall still unspent, including setup, and charge an interruption once to the accept attempt per R11. An interruption on every accept attempt refuses as `base_interrupted`. Every build round, repair rounds included, starts only on a matching qualified proof read back from the receipt store and bound to the run, contract, suite, base and gate.
- [ ] Judge each scenario against its kind. A new-behavior scenario must fail at least one assertion on the base, with its other tests passing or failing by assertion. Only an assertion failure counts as that expected red. A preservation scenario must pass on the base. Any other result ends the run `failed` before build with a public, redacted reason, such as "acceptance does not reproduce the ticket" or "a preservation check fails on the base".
- [ ] Never count a broken run as an expected red. A module-load failure, zero registered tests, a runner error, and a timeout each end the run `failed` with its own redacted reason, such as `base_load_error`, `base_no_tests`, `base_runner_error`, or `base_timeout`.
- [ ] Keep assertion-level held-out failures in private state for both the base run and CI validation. Record each failing test's name and its bounded assertion message beside the file path. Today `server/gates.ts:1437-1443` keeps only file paths. Public evidence carries only a redacted summary, never held-out test names or messages.
- [ ] Add `classifyFailure` to `src/diagnosis.ts`. Before any repair round, classify a hard failure as `candidate`, `oracle`, `missing_evidence`, or `infrastructure` from the private failure details and receipts. Classification is deterministic code and calls no model. A runner error, timeout, or unavailable runner is `infrastructure`. A receipt that lacks a required fact is `missing_evidence`. A failure is `oracle` only when it matches an adjudicated corpus entry, or when its scenario's base result was not the expected one. An expected red on the base, a new-behavior assertion failure, does not make a later failure of that scenario an oracle. Every other assertion failure is `candidate`. Only a `candidate` failure spends a repair. An `infrastructure` failure follows the existing retry caps. An `oracle` or `missing_evidence` failure ends the run `failed` with its own redacted reason and spends no repair.
- [ ] In `F10b-1`, store base replays in `test/fixtures/oracle-corpus/`. Each entry keeps the published checks, their version 2 one-file-per-scenario mapping, the base files the suite reads with their commit and blob, and the observed expected refusal. Fixture 558 refuses as `base_load_error`. Fixture 561, on its real base `f42ab42`, refuses as `preservation_failed` on S7. Fixture 568 refuses as `preservation_failed` on its preservation scenario. A minimal correct suite qualifies as the positive control. Run them in `npm run check`.
- [ ] In `F10b-2`, add a small adjudicated patch corpus for `classifyFailure`. Include a proposed three known-good patches and a proposed three known-bad patches. Each entry records its expected class and who adjudicated it.
- [ ] Record a base-run receipt with the base SHA, suite digest, each scenario's kind and result, exit code, wall time, and runner version. Keep it in private state. Keep the gates from `main`, held-out isolation, and budgets unchanged. Build and repair sessions never see the suite, its receipt, or the private failure details. Update `skills/acceptance/SKILL.md` to say each scenario has a kind and the suite runs against the base.
- [ ] Add a code-written "Not proven" section to the handoff PR body. It lists judge-only criteria, same-family review while the receipt records `r8: "incomplete"`, non-pass judgment outcomes, and live proof still pending. The controller derives each entry from receipts and calls no model. Replace the fixed sentence `R8 cross-family review remains incomplete.` in `publicBody` at `server/controller.ts:2739` with this section, so the body never claims more or less than the receipts show.
- [ ] Record `oracle` and `missing_evidence` on the run's pre-build failure record, not in the handoff body. Those classes end the run `failed` before build, so they never reach a PR.
- [ ] Add a closed set of non-pass judgment outcomes for review scenarios, `unverifiable`, `inconclusive`, and `timeout`. Today a judgment is `{scenario, pass, reason}` in `src/review.ts`. A non-pass outcome can never set `pass: true`, and an unknown outcome fails validation. Leave CI's boolean `Verdict.pass` and the existing `refused` and `malformed` stage errors unchanged.

**You see.**

- [ ] Save a bug fixture whose new-behavior scenarios fail on the base by assertion and whose preservation scenarios pass, so it goes on to build. Save replays of fixtures 558 and 561 that end `failed` before build. Each has its base-run receipt.

**Verify, unit.** Tests alone are not sufficient verification. A PR is verified only when its unit, live, and perf boxes are all checked.

- [ ] Test kind parsing and validation, per-scenario judging, each non-assertion failure reason, the no-`.git` export, receipt contents, the redacted public reason, and that build never starts after a refusal in `test/base-check.test.ts`, `test/accept.test.ts`, and `test/specify.test.ts`. Test private failure details for base and CI runs in `test/candidate-gates.test.ts`. Test every failure class, that only `candidate` spends a repair, and the full corpus in `test/diagnosis.test.ts` and `test/orchestrator.test.ts`. Test the "Not proven" entries, the scenario rule for each `new_behavior` criterion, and that no non-pass verdict renders green in `test/handoff.test.ts` and `test/accept.test.ts`. Run `npm run check`.

**Verify, live.** Tests alone are not sufficient verification. A PR is verified only when its unit, live, and perf boxes are all checked. Ten lanes on `task:qa` at the PR head, per the boot recipe.

- [ ] Lane 1. Regression lane against trunk. Run the same tiny bug fixture on trunk and head. Save `base-check.json`. Pass when head records a base run whose new-behavior scenarios fail by assertion and whose preservation scenarios pass, the run continues to build, and trunk's missing base run is recorded. When head's run reaches handoff, its PR body has a code-written "Not proven" section that lists same-family review and `r8: "incomplete"`.
- [ ] Lane 2. Replay fixture 558, whose generated check calls `git` at load. Save `replay-558.json`. Pass when the base run reports `base_load_error` in the no-`.git` export and the run ends `failed` before build with no build tokens spent.
- [ ] Lane 3. Replay fixture 561, whose preservation scenario S7 depends on the new heading and asserts whole-document equality. Save `replay-561.json`. Pass when the run ends `failed` before build with no build tokens spent, with S7's actual base result recorded and `preservation_failed` as the reason.
- [ ] Lane 4. Run a fixture whose requested behavior already exists on the base. Save `base-passes.json`. Pass when its new-behavior scenarios pass on the base and the run ends `failed` before build with the redacted reason.
- [ ] Lane 5. Inspect the base run's tree and sandbox. Save `base-export.json`. Pass when the tree has no `.git` and its recorded tree digest matches the CI gate's export of the same SHA, the gateway audit shows no GitHub route, and no branch or CI run appears.
- [ ] Lane 6. Run a fixture whose suite registers zero tests, and one whose suite hangs. Save `base-broken.json`. Pass when each ends `failed` with its own reason, `base_no_tests` or `base_timeout`, never an expected red.
- [ ] Lane 7. Drive one candidate whose held-out CI failure is a real defect, and one that fails only an adjudicated overconstrained oracle from the corpus. Save `failure-class.json`. Pass when the first is classified `candidate` and spends one repair, and the second is classified `oracle`, spends no repair, and ends `failed`.
- [ ] Lane 8. Read private state and public evidence for a run with held-out failures. Save `failure-details.json`. Pass when private state holds each failing test's name and assertion message for the base and CI runs, and the public marker shows only the redacted summary.
- [ ] Lane 9. Inspect the build session's mounts and history after a base run. Save `base-isolation.json`. Pass when the build sees no held-out file, test name, failure message, or base-run receipt.
- [ ] Lane 10. Restart the controller during the base run, then compare run totals with and without the base run. Save `base-restart.json`. Pass when recovery charges the interrupted attempt per R11 and does not skip the base check, the base run uses no model tokens, and its wall time counts against the accept stage.

**Verify, perf.** Tests alone are not sufficient verification. A PR is verified only when its unit, live, and perf boxes are all checked.

- [ ] Metric. Measure base-run wall time, accept-stage wall time, failure classification time, full run time, and tokens per run on trunk and head.
- [ ] Probe. Interleave three metric calculations on the same ledger copy and three previous/head replay pairs for one fixed tiny ticket. Record trunk's unsupported metric command separately. Save `perf.json`. The owner reduced the three replay pairs to one, and lane 6 never completed that pair, so the probe is not met. Trunk's unsupported metric command is recorded separately (exit 2).
- [ ] Baseline. Record trunk's unsupported metric response and the previous factory's tiny-ticket stage timings and usage first. Trunk's response is recorded, but the previous factory's tiny-ticket timings come only from the c3 specify stage, so the baseline is not met.
- [ ] Rule. Fail if the base run takes over the proposed 180 seconds on the tiny fixture, calls a model, or lets a refused run spend build tokens. Report the added accept-stage time against trunk.

**Review gate.** The operator reviews before merge.

- [ ] Post the base-run receipts for the bug fixture and the 558 and 561 replays, and the failure-class receipt, to the operator. Use JSON instead of a screenshot or video. Merge on a clean verdict and a passing `check`.

**Merge.**

- [ ] Record the exact-head verdict and complete Bugbot triage.
- [ ] Apply the patch-id rule in `playbooks/shipping.md`. Hand `F10b` to the owner on a clean verdict and a passing `check`. After the owner's merge, branch the next PR from the new `main`.

## Record finished runs on the ledger branch (F09b)

**Depends on.** F10b. This completes unit 9's ledger and usage accounting.

**Files.**

- [ ] Create `src/ledger.ts`, `test/ledger.test.ts`, `test/ledger-git.ts`, `docs/prototypes/ledger-branch/`, and `docs/operations/ledger.md`.
- [ ] Edit `src/run.ts`, `src/markers.ts`, `src/orchestrator.ts`, `server/controller.ts`, and `server/cli.ts` for durable totals and terminal publication.
- [ ] Edit `src/publication.ts` and `src/gh.ts` for the exact `factory/ledger` ref methods, the shared hash-checked object helpers, the root tree without `base_tree` and bounded ledger transport calls. Candidate branch guards stay unchanged.
- [ ] Edit `server/sandbox.ts`, `server/sandbox/result.ts`, `server/sandbox/audit.ts`, and `server/sandbox/gateway.ts` for the synced request dispatch and result journal, execution high-water marks and durable charge recovery. The owner amended this block on 2026-11-04, because the before-request durability rule cannot hold without them.
- [ ] Edit `test/orchestrator.test.ts`, `test/workflow.test.ts`, `test/publication.test.ts`, `test/sandbox/audit.cases.ts`, `test/sandbox/gateway.cases.ts`, `test/sandbox/runner.cases.ts`, `test/viewer.test.ts`, `test/attention.test.ts`, and `docs/operations/factory-cli.md` for these contracts at their call sites and for old-reader compatibility.

**Build.**

- [ ] Prototype controller-only append to `ledger/runs.jsonl` on the `factory/ledger` orphan branch. Keep its controller-private ledger receipts outside all stage mounts. Verify that the branch has no main ancestry and is never a source branch for product PRs.
- [ ] Implement `appendRun` keyed by run ID with terminal outcome, issue/PR URLs, SHAs, artifact digests, stage timings, repair count, model versions, token totals, spend availability, and evidence links. Append each finished run once, including failures and `needs_info`, not only merges.
- [ ] Freeze the trusted `WORKFLOW.md` digest, the gate-set digest, and the autonomy level into each ledger row. In v1 the autonomy level is always `approve_merge: always`, which R13 calls `land: propose`. They are two names for the same current policy, not two levels. Do not add a per-tick decision log.
- [ ] Serialize writes in the single controller. Reconcile a pushed row before retrying after a crash. On a remote advance, fetch and reapply only the missing row, without force-pushing the ledger. Preserve unknown or corrupt rows for diagnosis instead of rewriting history.
- [ ] Count interrupted attempts apart from failed ones. Today a controller restart during a stage ends that attempt as failed, so restarts use up the attempt cap. Keep that charge, because the interrupted attempt may already have spent tokens. Record each run's interrupted attempts in its ledger row, so `F12a` can tell restarts from real failures. Source is the controller statechart in `docs/statecharts/README.md`.
- [ ] Persist usage at stage boundaries and before dispatching another request. Restore totals after restart. Block new work when a configured token, wall, or known spend cap is exhausted. Keep raw sessions private and publish only redacted evidence.

**You see.**

- [ ] Save one ledger row for the owner's merged fixture run and one for a failed run. Repeated reconciliation leaves exactly one row per run ID and preserves earlier rows.

**Verify, unit.** Tests alone are not sufficient verification. A PR is verified only when its unit, live, and perf boxes are all checked.

- [ ] Test append deduplication, remote advance, crash-after-push, redaction, unknown spend, restored totals, frozen policy digests, and corrupt rows in `test/ledger.test.ts`. Run `npm run check`.

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
- [ ] Probe. Interleave three metric calculations on the same ledger copy and three previous/head replay pairs for one fixed tiny ticket. Record trunk's unsupported metric command separately. Save `perf.json`. The owner reduced the three replay pairs to one, and lane 6 never completed that pair, so the probe is not met. Trunk's unsupported metric command is recorded separately (exit 2).
- [ ] Baseline. Record trunk's unsupported metric response and the previous factory's tiny-ticket stage timings and usage first. Trunk's response is recorded, but the previous factory's tiny-ticket timings come only from the c3 specify stage, so the baseline is not met.
- [ ] Rule. Fail if a normal terminal row takes over 60 seconds to reach the ledger, parsing 1,000 rows takes over 1 second, or ledger work calls a model. Fail if recorded totals omit a completed child or retry.

**Review gate.** The operator reviews before merge.

- [ ] Post redacted ledger rows and the restart receipt to the operator. Use JSON instead of a screenshot or video. Merge on a clean verdict and a passing `check`.

**Merge.**

- [ ] Record the exact-head verdict and complete Bugbot triage after the orphan-branch prototype passes.
- [ ] Apply the patch-id rule in `playbooks/shipping.md`. Hand `F09b` to the owner on a clean verdict and a passing `check`. After the owner's merge, branch the next PR from the new `main`.

## Write acceptance and review with a second model family (F10c)

**Depends on.** F09b. This closes R8 and R12 under the owner's 2026-11-02 decision to allow Anthropic models on the VM. It moves the accept stage and one blocking review seat to an Anthropic model. The builder and repair stay on OpenAI. The Anthropic route does not exist today. It is a planned prototype.

**Files.**

- [ ] Create `docs/prototypes/anthropic-route/` for the route prototype's receipts.
- [ ] Edit `server/sandbox/routes.ts`, `server/sandbox/meter.ts`, `server/sandbox/gateway.ts`, and `server/provision.sh` for the Anthropic route, its usage meter, and the sandbox provider entry.
- [ ] Edit `src/review.ts`, `src/handoff.ts`, `src/accept.ts`, `src/workflow.ts`, and `server/controller.ts` for the family check, seat labels, cross-family certification, and named fallbacks.
- [ ] Edit `test/sandbox/routes.cases.ts`, `test/sandbox/gateway.cases.ts`, `test/review.test.ts`, `test/handoff.test.ts`, `test/accept.test.ts`, and `test/workflow.test.ts` for these contracts. Create a new test file only when a case fits none of them.
- [ ] Edit `docs/operations/sandbox.md` and `docs/operations/factory-cli.md` for the route, the family labels, and the fallback receipts.
- [ ] Edit `.github/factory/WORKFLOW.md` for the accept model, the Anthropic review seat, and any named same-family fallback. It is main-owned, so the owner authors that edit, the same as other trusted configuration.

**Build.**

- [ ] Prototype the Anthropic route before wiring any stage. Stop and report if `pi-factorio` cannot complete one metered call.
  - [ ] Add a `model-anthropic` route to `server/sandbox/routes.ts`. Today `MODEL_ROUTE_IDS` at `server/sandbox/routes.ts:164` lists `model-openai` and `model-xai`. The gateway has one meter, `openai-responses-sse`, the only `Meter` value at `server/sandbox/routes.ts:112`. It always mounts `/openai/v1/` at `server/sandbox/routes.ts:336`, and mounts `model-xai` at `/xai/v1/` for any fallback that does not start with `openai/`, at `server/sandbox/routes.ts:343-349`. Make `model-anthropic` a third route id with its own prefix. Never reach it through that non-OpenAI fallback branch.
  - [ ] Add an Anthropic value to `Meter` and a metered parser for Anthropic's streamed usage in `server/sandbox/meter.ts`. Today the OpenAI meter counts a stream with no usage as `unmetered` and still forwards it, per `server/sandbox/gateway.ts:995`. For the Anthropic route, a stream with a missing usage block fails the stage instead.
  - [ ] Add the `anthropic` provider to the sandbox bundle's `models.json` in `server/provision.sh`, through the in-sandbox forwarder. Today that file lists only `openai` and `xai`, per `server/provision.sh:145-149`. The host's Pi config already names `anthropic` at `$LLM/anthropic`, per `server/provision.sh:82-86`. The sandbox still holds no credential.
  - [ ] Prove one metered accept-stage call on `pi-factorio` before wiring stages. Save the gateway audit and meter receipt in `docs/prototypes/anthropic-route/`.
- [ ] Move the accept stage to an Anthropic model set in trusted `.github/factory/WORKFLOW.md`. Today every model stage there is `openai/gpt-6.1-sol`. Keep the builder and repair on OpenAI. Choose the exact Anthropic model ID from the live integration catalog when building.
- [ ] Add one blocking review seat on an Anthropic model, or move the code-review seat to it. Keep the other seats, the security fallback, and the shared review budget.
- [ ] Add a `familyOf` check in code.
  - [ ] Classify the acceptance author and each review seat by the observed answering model ID in its stage receipt, never by the requested or configured ID. A missing, null, or unknown observed ID is never cross-family. Label a seat `cross-family` only when that observed family differs from the builder's. Today `src/review.ts:412` builds the label from the requested ID and always appends `same family, not cross-family`, and `SeatReceipt.observed` may be null.
  - [ ] Change certification in `src/handoff.ts`. Today `src/handoff.ts:931-940` requires `r8 === "incomplete"` and every seat label ending `same family, not cross-family`. Recompute the families from observed IDs inside certification, rather than trusting a label string. Accept `r8: "complete"` only when the accept author and at least one blocking review seat are observed cross-family, and reject it otherwise. Widen the `r8: "incomplete"` literal on `ReviewReceipt` at `src/review.ts:105` and the guard in the review wiring in the same change.
  - [ ] Keep same-family runs certifiable with `r8: "incomplete"`. List them under the handoff's "Not proven" section from `F10b`.
- [ ] Never substitute a model silently. If the Anthropic route is unavailable or refuses, the stage follows the existing retry and refusal rules. The security seat's named `openai/gpt-6.1-terra` retry stays on that seat only. Another stage gets a same-family fallback only when trusted `WORKFLOW.md` names one for that stage, and that run records `r8: "incomplete"`.
- [ ] Charge Anthropic tokens and wall time to the existing per-stage and run caps. Report spend as known only where the integration meters it, and otherwise as unavailable. Mark any new number in this unit as proposed. On 2026-11-05 the owner raised the accept attempt ceiling from 25,000 to 50,000 tokens. Anthropic accept counts cache tokens as input, and Pi 1.4.0 sends adaptive thinking for `claude-sonnet-5-5` even with thinking off. Live lane H5 spent 34,678 tokens on one accept attempt. On 2026-11-06 the coordinator raised it again to 100,000 under the owner's standing cap grant, after lane H7 spent 56,279 tokens in a three-turn accept attempt on the same ticket that H6 accepted in one turn with 16,514. On 2026-11-06 the coordinator raised the build allowance from 200,000 to 400,000 and the run cap from 500,000 to 800,000 under the owner's standing grant, after pilot 1's build spent 213,476 tokens. On 2026-11-06 the owner moved the accept model from `anthropic/claude-sonnet-5-5` to `anthropic/claude-opus-5-5` after Sonnet's accept attempts proved erratic across ten live runs, with spend from 16,514 to 121,591 tokens and one tool-call loop in pilot 1. The code-review seat stays on `claude-sonnet-5-5`. Later on 2026-11-06 the owner moved every factory stage back to `openai/gpt-6.1-sol`, under the ChatGPT subscription, to stop exe.dev credit spend. Certification therefore records `r8` as incomplete again. The F10c route, meter, family evidence and certification code stay in place, and one `WORKFLOW.md` change re-enables an Anthropic accept author or code-review seat.

**You see.**

- [ ] Save one run whose accept author and one blocking seat answered from an Anthropic model, certified with `r8: "complete"`, at a ready `factory:review` PR. Save one forced same-family fallback run that certifies with `r8: "incomplete"` and shows under "Not proven".

**Verify, unit.** Tests alone are not sufficient verification. A PR is verified only when its unit, live, and perf boxes are all checked.

- [ ] Test the Anthropic route, the usage parser, unknown-usage fail-closed, and denial of an unlisted provider in `test/sandbox/routes.cases.ts` and `test/sandbox/gateway.cases.ts`. Test `familyOf`, seat labels, unknown families, and cross-family certification in `test/review.test.ts` and `test/handoff.test.ts`. Test the accept model choice and named fallbacks in `test/accept.test.ts` and `test/workflow.test.ts`. Run `npm run check`.

**Verify, live.** Tests alone are not sufficient verification. A PR is verified only when its unit, live, and perf boxes are all checked. Ten lanes on `task:qa` at the PR head, per the boot recipe.

- [ ] Lane 1. Regression lane against trunk. Run the same tiny bug fixture on trunk and head. Save `anthropic-accept.json`. Pass when trunk's accept stays on OpenAI, and head's accept makes one metered call through the `model-anthropic` route with tokens in the meter receipt, while build and repair stay on OpenAI.
- [ ] Lane 2. Request an unlisted provider route from a stage sandbox. Save `unlisted-provider.log`. Pass when the gateway denies it and no upstream request leaves the sandbox.
- [ ] Lane 3. Replay an Anthropic stream with missing usage through the gateway's echo fixture. Save `unknown-usage.json`. Pass when the Anthropic stage fails on the missing usage block and cannot succeed on unmetered usage, while the OpenAI route's existing `unmetered` count is unchanged.
- [ ] Lane 4. Drive a real fixture issue to handoff with the Anthropic accept stage and review seat. Save `cross-family-run.json`. Pass when certification records `r8: "complete"`, the PR is ready and labeled `factory:review`, and its "Not proven" section omits same-family review.
- [ ] Lane 5. Make the Anthropic route unavailable while a verification `WORKFLOW.md` names a same-family fallback. Save `same-family-fallback.json`. Pass when the run certifies with `r8: "incomplete"` and the PR body lists same-family review under "Not proven".
- [ ] Lane 6. Inspect seat labels on a run where an OpenAI model answered a seat that requested Anthropic. Save `label-check.json`. Pass when that seat is never labeled `cross-family`, and no seat with an unknown family is labeled `cross-family`.
- [ ] Lane 7. Make the Anthropic review seat refuse. Save `anthropic-refusal.json`. Pass when the seat follows the existing refusal rule, no unnamed model substitutes for it, and the missing seat never becomes a pass.
- [ ] Lane 8. Run one fixture whose stages use both providers. Save `two-provider-budget.json`. Pass when both providers' tokens and wall time count against the per-stage and run caps, each stage reserves its full allowance before launch, and spend shows unavailable where the integration meters none.
- [ ] Lane 9. Inspect the build and repair sessions' mounts, history, and gateway audit after an Anthropic accept stage. Save `heldout-isolation.json`. Pass when the builder sees no held-out file, test name, or acceptance session, the same as on trunk.
- [ ] Lane 10. Restart the controller during the Anthropic accept stage. Save `accept-restart.json`. Pass when recovery charges the interrupted attempt per R11, retries accept on the same Anthropic model, and keeps both providers' totals.

**Verify, perf.** Tests alone are not sufficient verification. A PR is verified only when its unit, live, and perf boxes are all checked.

- [ ] Metric. Measure accept-stage wall time and tokens on trunk and head, and the gateway meter time added per Anthropic call.
- [ ] Probe. Interleave three metric calculations on the same ledger copy and three previous/head replay pairs for one fixed tiny ticket. Record trunk's unsupported metric command separately. Save `perf.json`. The owner reduced the three replay pairs to one, and lane 6 never completed that pair, so the probe is not met. Trunk's unsupported metric command is recorded separately (exit 2).
- [ ] Baseline. Record trunk's unsupported metric response and the previous factory's tiny-ticket stage timings and usage first. Trunk's response is recorded, but the previous factory's tiny-ticket timings come only from the c3 specify stage, so the baseline is not met.
- [ ] Rule. Fail if head's median accept-stage wall time exceeds trunk's by more than a proposed 50%, or the meter adds more than a proposed 50 milliseconds per call. Fail if any Anthropic call goes unmetered. Report spend as unavailable where the integration meters none.

**Review gate.** The operator reviews before merge.

- [ ] Post the cross-family run's PR URL, its certification receipt, the fallback receipt, and the Anthropic meter receipt to the operator. Use JSON instead of a screenshot or video. Merge on a clean verdict and a passing `check`.

**Merge.**

- [ ] Record the exact-head verdict and complete Bugbot triage, with each seat's observed family.
- [ ] Apply the patch-id rule in `playbooks/shipping.md`. Hand `F10c` to the owner on a clean verdict and a passing `check`. After the owner's merge, branch the next PR from the new `main`.

## Apply authorized PR feedback in place (F10)

**Depends on.** F10c. This implements unit 10 and completes the GitHub feedback part of the definition of done. It ships as four sequential PRs, F10-1 to F10-4, each mergeable on its own and verified by the lanes it names. The owner settled the product calls on 2026-11-07 in `../pi-herdr-factorio-trails/F10/owner-decisions.md` and in the decision rows `f10-merged-feedback` and `f10-owner-grant`. The design is `../pi-herdr-factorio-trails/F10/design.md`.

**Files.**

- [x] F10-1. Create `src/feedback.ts` and `test/feedback.test.ts`. Edit `src/tickets.ts`, `src/adapters/github.ts`, `src/handoff.ts`, `src/orchestrator.ts`, `server/controller.ts`, `test/fake-ticket-adapter.ts`, `test/github-adapter.test.ts`, `test/handoff.test.ts`, `test/orchestrator.test.ts`, `test/pipeline.test.ts`, and `docs/operations/human-review.md` for feedback readers, intake bound to the promoted head, the immutable feedback batch, the book's idempotent feedback cursor, intake notices, and merged-PR proposals.
- [x] F10-2. Create `skills/address-pr-comments/` with provenance. Edit `src/handoff.ts`, `src/orchestrator.ts`, `src/review.ts`, `src/build.ts`, `src/policy.ts`, `src/feedback.ts`, `server/sandbox.ts`, `server/controller.ts`, `skills/README.md`, `test/handoff.test.ts`, `test/orchestrator.test.ts`, `test/publication.test.ts`, `test/review.test.ts`, `test/build.test.ts`, `test/policy.test.ts`, and `test/feedback.test.ts` for the feedback repair cause, same-PR successor publication, round summaries, the repair stop rules, and published holds at every stop site.
- [x] F10-3. Edit `src/handoff.ts`, `src/orchestrator.ts`, `src/publication.ts`, `src/ledger.ts`, `server/controller.ts`, `server/sandbox.ts`, `docs/operations/human-review.md`, `docs/operations/ledger.md`, `test/handoff.test.ts`, `test/orchestrator.test.ts`, `test/publication.test.ts`, `test/validation.test.ts`, `test/sandbox/runner.cases.ts`, and `test/ledger.test.ts` for owner-head drift, the owner validate-and-review path, and the version 5 ledger row.
- [x] F10-4. Create `docs/statecharts/journey/Feedback.cfg`. Edit `docs/statecharts/journey/Journey.tla`, `docs/statecharts/journey/Journey.cfg`, `docs/statecharts/journey/replay-merge-mid-repair.ts`, `docs/statecharts/README.md`, and `test/handoff.test.ts`. Edit `docs/statecharts/controller/Controller.tla` only as far as its instance of Journey needs.

**Build.**

- [x] F10-1. Read feedback once per tick for a published run whose PR is open and whose PR head and ref head both equal the promoted generation's certified head. Read nothing while they differ, which covers the window between `promote_pr` and `complete_handoff` at `src/handoff.ts:1476-1491`, so no review is judged against a book head that lags the branch. Read conversation comments with `readComments` at `src/adapters/github.ts:686`, submitted reviews from `pulls/<n>/reviews`, and each review's inline comments from `pulls/<n>/reviews/<id>/comments`. Give every event a provider-qualified ID, such as `github:<owner>/<repo>:review:<id>` for a review and `github:<owner>/<repo>:review-comment:<id>` for an inline comment. Drop the controller's own messages. Never read or store `diff_hunk`.
- [x] F10-1. Classify each new event once. A submitted `CHANGES_REQUESTED` review from a write-access actor on the promoted head is actionable, together with its inline comments. Today that actor is only the owner. Conversation comments, approvals, `COMMENTED` reviews, and dismissed reviews never start a repair. A non-writer's event is refused and adds no card. A permission read failure records nothing and moves no cursor.
- [x] F10-1. Refuse inline comments on `test/acceptance/*`. Post one notice on the issue and never forward them to the builder, the full-text file, or a summary. The refusal never settles the rest of the review.
- [x] F10-1. Write each tick's new events as one immutable, content-addressed feedback batch under the run's private state, with every event's intake, before the book records it. Record the batch reference and the seen event IDs in the book's feedback cursor in the same claim write, which is the cursor advance. Keep a seen-ID set rather than a high-water mark, because a review submitted later can carry a lower ID. Hold `feedback_overflow` rather than forget IDs past a proposed 500. Leave the public marker unchanged.
- [x] F10-1. Decide what is new from the book, never from the observation. `#observeCandidates` applies one observation twice when it consumes a queued callback at `src/orchestrator.ts:4832-4922`. A batch whose IDs are all unseen and whose digest is unknown adds exactly one batch reference, and any other overlap changes nothing. Apply the cursor update before every later row, so every fall-through return carries it.
- [x] F10-1. Store an actionable batch as queued and post one issue notice that the repair arrives with F10-2, leaving readiness and budgets unchanged. Never refuse it in this slice, because the seen set is permanent and a refused batch could never be repaired. Ship the full batch status codec now. Post a notice only from waiting or a non-sticky hold, and keep it due in the book while a stage runs. Supersede a queued batch whose reviews the owner dismisses.
- [x] F10-1. Give each PR one repair owner, the run that published it. Defer delivering feedback to other runs bound to the same PR. Add related-run delivery only when a real case needs it.
- [x] F10-1. Never revive a terminal run. Feedback on a run that ended `needs_info` needs fresh readiness and a linked successor run. Feedback on a cancelled or failed run starts nothing. For each write-access review submitted after the merge of a landed factory PR, with a non-empty body or inline comments, file one deduplicated `factory:proposed` issue instead of modifying the merged branch, and keep it ineligible for automatic admission. Conversation comments never file one. Find landed PRs from the ledger and the merge time from `pulls/<n>`.
- [x] F10-2. Start a feedback repair only from the oldest queued batch on a run that is waiting or held without an owner or identity hold, and only while the PR head and ref head equal the batch's head, which is still the promoted head. Consume batches queued under F10-1 the same way, with no migration. Add a `feedback` repair cause bound to the batch digest and to the stored assessment and blocking review receipt of the generation it repairs. Add it to `RepairCause` at `src/handoff.ts:94-96`, `wireCause` at `src/handoff.ts:1836`, `#repairAuthorized` at `src/orchestrator.ts:5677-5701`, and the sandbox checkout at `server/sandbox.ts:4109-4185`. Hand the batch to a fresh build only at a stage boundary. Keep a batch that arrives during a running round queued, and supersede it if the round promotes a new head.
- [x] F10-2. Share the existing two-round repair cap and the cumulative repair and review budgets with pre-PR repairs. Feedback past the cap, or past a preflight budget refusal, posts one notice and leaves readiness and budgets unchanged. Revisit the shared cap only if a real PR runs out of rounds.
- [x] F10-2. Withdraw readiness when a feedback repair starts. Remove `factory:review` and post one notice on the issue before any build is issued. Do not convert the PR to a draft, because the controller identity gets `FORBIDDEN` on both GraphQL draft mutations, per `/tmp/f09a-scripts/p1.out:54-58`, and REST cannot change `draft` on an existing PR. Do not force a failing `factory-gates`. GitHub already refuses to merge a head without a successful `factory-gates` from app 15368, and only the controller-dispatched reporter posts it. Keep the PR at the old certified head until the repaired generation certifies.
- [x] F10-2. Validate the repaired head on `factory/run/*` and promote it onto the same PR. Give `repair_built` at `src/handoff.ts:1150-1168` a `successor` publication whose expected head is the published head, as the refresh path does at `src/handoff.ts:1191-1244`, so `promote_pr` fast-forwards. Re-run validate and review at the new head before restoring `factory:review`. Have only the controller push and post. Accept the certified successor head between `promote_pr` and `complete_handoff` in the refresh head check at `src/handoff.ts:1201-1212`, because `published.promoted` changes only at `complete_handoff`.
- [x] F10-2. Post one summary comment on the PR for each repair round, keyed by run and round, whether the round ends with a ready head or a hold. List each feedback item's disposition and the new head. Keep every other notice on the issue, as `#postKeyed` does at `src/orchestrator.ts:6666-6688`. Post no per-comment replies.
- [x] F10-2. Deliver feedback to the build session as bounded cards in `.factory-feedback.json` version 2. Each card carries the event ID, the head, a bounded excerpt, and a truncation flag. When an excerpt is cut, the card points to `.factory-feedback-full.json`, which holds the full text and its digest and which the path policy forbids editing. Add the same truncation flag to the acceptance and build prompts' inlined sources. Cap the cards at a proposed 8 KiB per round. Describe the cards as untrusted requests rather than CI facts in `feedbackPrompt` at `src/review.ts:787` and in the build rules in `src/build.ts`.
- [x] F10-2. Treat comments as requested work within the original contract, not permission to edit forbidden files or broaden scope. The builder reports a bounded disposition for each card, and the review seats see the same cards. Route an incompatible request to a rejected disposition in the round summary.
- [x] F10-2. Adapt the MIT address-pr-comments skill without its direct pushes or replies. Use a fresh sanitized build session, the same branch and PR, and cumulative repair and cost budgets. Persist the feedback cursor before retries can redispatch it.
- [x] F10-2. Keep merge observation working through repair rounds. Since F09a, `observed` in `src/handoff.ts` ends a run when it sees a merged PR in any non-terminal candidate state, at `src/handoff.ts:1076-1077`, before every repair step. It stops and charges captured work, records the merged SHA, and records `owner_override` when no certified generation matches the merged head. Keep the published generation in `history`, so a merge of the old certified head during a repair records `factory_verified`, with the readiness at merge time beside it. This matches `terminalFor` at `src/handoff.ts:791-811` and `MergeAssuranceTruthful`. Record the in-flight feedback batch as merged.
- [x] F10-2. Stop a repair that makes no progress. Today the sandbox already returns `blocked` with reason `repair_no_change` for an unchanged patch at `server/sandbox.ts:3858-3870`. Both orchestrator sites at `src/orchestrator.ts:5087-5097` and `src/orchestrator.ts:5593-5603` collapse it to `failed`, so `repair_settled` at `src/handoff.ts:1694-1752` falls through to another `repair_due` attempt at `src/handoff.ts:1730-1748`. Carry the sandbox's reason through as a `no_change` result. Keep the digest test at `src/handoff.ts:1720` as a backstop. Return `patch_missing` instead of `repair_no_change` when the previous round's patch is missing. A failed or invalid repair patch still uses the existing attempt cap and repair limit.
- [x] F10-2. Stop a repair with a proposed reason `repair_repeated_finding` when the same blocking finding repeats across rounds. Match a repeat by seat plus a finding fingerprint of category, path, and normalized claim without line numbers. A later review round blocks only on an unfixed earlier finding or on a defect inside the repair diff. Add no separate signature limit, because the two-round cap already bounds repeats.
- [x] F10-2. End an unpublished run `failed` on `repair_no_progress` or `repair_repeated_finding`. Hold a published run on the same reason instead, with readiness withdrawn and the round summary posted, because a terminal run would stop observing its open PR. When the repaired head fails validation or its review blocks, hold and post the round summary without starting a round. The owner's next `CHANGES_REQUESTED` review can start the next round within the cap.
- [x] F10-2. Hold a published run instead of ending it `failed` at every other stop site, through one pure function that still fails an unpublished run. The sites are the preflight refusal in `repair_settled` at `src/handoff.ts:1730-1748`, build inputs failing at launch at `src/orchestrator.ts:5474-5510`, an unauthorized repair at `src/orchestrator.ts:5425-5458`, and an oversized review input at `src/orchestrator.ts:4960-4986`, which a refresh review can already reach today. Keep a hold's start time when the reason does not change, rather than rewriting it every tick in `hold` at `src/handoff.ts:747-757`.
- [x] F10-2. Record a disposition, `adopted`, `rejected`, or `merged`, for each feedback item and each blocking finding. Store it with the feedback batch and the round receipt.
- [x] F10-3. Detect an owner push before more spend. When the PR's ref head is neither the published head, nor the certified successor being promoted, nor the owner head being recertified, stop any live execution, supersede any in-flight batch, remove `factory:review`, and post one notice on the issue keyed by that head. Record the head so the notice and derivation happen once per head. Today `head_drift` at `src/handoff.ts:1212` and `src/handoff.ts:1303` keeps the label, posts nothing, rewrites its hold time every tick, and is reached only after a full build, validation, and review.
- [x] F10-3. Recertify the owner's exact head with no build and no commit. Hold `refresh_limit` instead when the generation number is already 3, because the nonce grammar at `.github/workflows/ci.yml:113` stops at `-g3`. Derive the patch from the owner tree after replacing `test/acceptance` with the base's tree, and refuse a changed held-out suite, a path the path policy forbids, a head whose compare status against `main` is not ahead, or a diff over the review input bound. Validate through an owner path that skips `readPatch`, the builder visible-test check at `server/controller.ts:4098-4115`, and `publishCandidate` at `server/controller.ts:4508`. Pin the owner head with a controller-owned `factory/run/*` ref that the existing cleanup deletes, and never write `factory/pr/*`, because cleanup deletes the publication branch on pass and failure at `server/controller.ts:3947-3973`. Bind the verdict to the owner head, certify with an owner patch check and an unavailable builder family, and review the stored owner patch in the sandbox. On a pass, restore readiness through `complete_handoff`. On a failure or refusal, hold and post one head-bound notice. A failing `check` on the certified head also holds with one notice for each head. Run a model-free prototype of this integrated path before the builder starts.
- [x] F10-3. Record owner authorship in a version 5 ledger row, with `authored` beside a `factory_verified` landing, derived from the certifying generation's origin. Leave versions 1 to 4 byte-identical. An older controller then blocks appends on the unknown version instead of misreading a row, as `docs/operations/ledger.md` already requires. Roll forward only.
- [x] F10-3. Never rewrite owner commits. Defer automatic reconciliation, which builds on top of owner commits, until after F10. Refuse a feedback repair on an owner-authored head with a notice. When `main` moves under an owner-authored head, or under an owner generation still in validation or review, hold and ask the owner to update the branch instead of refreshing.
- [x] F10-4. Change the journey model's locks on repair after publication. Replace `NoPostPrRepair` at `docs/statecharts/journey/Journey.tla:249` with invariants that a published repair phase has a feedback cause and no readiness, that no generation is built on an owner head, and that a factory-verified merge names its author truthfully. Widen the `RepairDue` guard `b.published = 0` at `Journey.tla:105-108` to admit that cause. Keep the published holds in `FailOrRepair` at `Journey.tla:74-76` and in `ReviewResult` at `Journey.tla:146`, as the owner decided for a blocked repaired head. Add an owner-review event, a feedback repair entry within the shared repair cap, the owner-push event, and an owner-head recertification in a new `feedback` partition, each enabled only while the PR is open, as `observed` orders merge and close first. Hold instead of refreshing an owner-authored head. Add the new book fields to `InitialBook`. Keep every other path held, and keep every other run out of repair.

**You see.**

- [x] Save a write-access `CHANGES_REQUESTED` review and the resulting new head on the same PR, followed by fresh CI and review receipts and one round summary on the PR. A repeated poll produces no second repair. Save one owner push that the factory recertifies without a build.

**Verify, unit.** Tests alone are not sufficient verification. A PR is verified only when its unit, live, and perf boxes are all checked.

- [x] F10-1. Cover all comment sources, provider-qualified IDs, permission checks, permission read failures, stale heads, deferred reads during the promotion window, held-out inline refusal, the seen-ID set, one observation applied twice with and without a queued callback, cursor carry through every later row, a queued actionable batch with one notice and no repair, notices held during a running stage, dismissal, cursor recovery across crash boundaries, and merged-PR proposals in `test/feedback.test.ts`, `test/github-adapter.test.ts`, `test/handoff.test.ts`, and `test/orchestrator.test.ts`. Unit-test that a non-writer's review, comment, and inline comment add no card. Run `npm run check`.
- [x] F10-2. Test readiness withdrawal before any build, shared repair caps, queued and superseded batches, a book written by F10-1 resuming into one repair, the successor publication, the promotion window, round summaries, a merge during each repair phase, `repair_no_progress` from the sandbox's reason, repeated findings by fingerprint, later-round blocking scope, published holds at every stop site, card truncation, and dispositions in `test/handoff.test.ts`, `test/orchestrator.test.ts`, `test/publication.test.ts`, `test/review.test.ts`, and `test/feedback.test.ts`. Run `npm run check`.
- [x] F10-3. Test drift detection before spend, one notice for each head, a stable hold time, the generation limit, each derivation refusal, an owner validation that records no commit and no write to the PR branch, owner certification and its refusals, review preparation with no held-out path, recertification pass and failure, owner-authored merges, the version 5 ledger row, refused repairs on owner-authored heads, and the behind-main hold in `test/handoff.test.ts`, `test/orchestrator.test.ts`, `test/publication.test.ts`, `test/validation.test.ts`, `test/sandbox/runner.cases.ts`, and `test/ledger.test.ts`. Run `npm run check`.
- [x] F10-4. Give `docs/statecharts/journey/Journey.tla` the changes above and run TLC. The structural config with the new invariants must complete within 1,200 seconds. Witness invariants for a published repair, an owner-authored ready head, an owner-authored merge, and a merge during a feedback repair must each fail with a trace within 300 seconds, so the invariants are not passing vacuously. `MergeAssuranceTruthful` must still hold, so every merge without an owner override names a head whose checks and review passed. A counterexample blocks. Pending owner approval, the new feedback partition gets one 1,800-second attempt and one retry without main movement, and a timeout there is recorded in `docs/statecharts/README.md` with its unchecked properties without blocking delivery. Without that approval, rerun TLC until every invariant holds, shrinking only recorded bounds, and bring the owner the log after a second timeout. Extend `replay-merge-mid-repair.ts` with the F10 `formal` tests.

**Verify, live.** Tests alone are not sufficient verification. A PR is verified only when its unit, live, and perf boxes are all checked. Ten lanes on `task:qa` at the PR head, per the boot recipe. Each lane runs at the head of the slice that closes it, and lanes share fixtures as the design's token plan describes. On `[F10-...]` fixtures the coordinator acts as the owner under the grant recorded on 2026-11-07, including reviews, pushes, and merges.

- [ ] Lane 1. Regression lane against trunk, closed by F10-2. Publish one tiny fixture PR on trunk, submit an owner `CHANGES_REQUESTED` review, then deploy head over the same state. Save `feedback-round.json`. Pass when trunk leaves the PR unchanged with no model call, and head reads the stored book, repairs, and updates the same PR. **Left unchecked. Only part of this was proven.** On trunk 7d73c51 an owner review on fixture A's PR #651 produced no repair, reply or notice in 200 s and left the head unchanged, and on head the same kind of review repaired fixture B's PR #659 in place, from bad5019 to 834e3a5. Head was not deployed over the same PR and state that trunk left unchanged, so the two halves ran on different PRs.
- [ ] Lane 2. Closed by F10-2. Submit a long owner `CHANGES_REQUESTED` review, and on a separate fixture merge the old head during its repair. Save `review-feedback.json`. Pass when one repair starts, the build receives the review as a bounded card with a truncation pointer, `factory:review` is absent and one issue notice exists while the repair runs, the PR stays at the old certified head until fresh evidence passes, and the mid-repair merge records `factory_verified` with readiness beside it and stopped, charged repair work. Run the merge half last, only if the remaining program budget covers its fixture, and otherwise report it to the owner as a gap. **Left unchecked. Only part of this was proven.** The 9.4 KB review became truncated cards with a full-text digest, one repair started, `factory:review` came off with one issue notice and returned only after fresh validation and review, and the PR kept its old head meanwhile. The merge of the old head mid-repair was never run live and rests on unit and formal replay tests.
- [ ] Lane 3. Closed by F10-1. Add inline comments inside a `CHANGES_REQUESTED` review, one of them on `test/acceptance/`, and add an owner conversation comment, an approval, and a `COMMENTED` review. Save `inline-feedback.json`. Pass when the adapter associates each comment with the correct PR and head under a provider-qualified event ID, the held-out comment is refused with one issue notice, no held-out text reaches a card, a file, or a summary, the review stays queued for F10-2, the other three are recorded as ignored, and a repeated poll records no second batch. **Left unchecked. Only part of this was proven live.** The inline comment was bound to the PR head under a provider-qualified id, the held-out inline comment was refused with one issue notice, and the review stayed queued. The owner conversation comment, approval and `COMMENTED` review were never posted on the lane's PR, so their ignored records rest on unit tests.
- [x] Lane 4. Closed by F10-1 at unit level only. The live half needs a real non-writer identity and is an explicit gap, accepted by the owner on 2026-11-07 and filed as a follow-up. Save `feedback-authority.json` with the unit test names and results. Pass when the unit tests in `test/feedback.test.ts` show a non-writer's review, comment, and inline comment refused with no card, no repair round, and no run, and the follow-up issue is linked. The live half is tracked in #665.
- [x] Lane 5. Closed by F10-2. Poll a processed review twice, including across a restart. Save `feedback-dedup.log`. Pass when only one repair and one round summary occur.
- [ ] Lane 6. Closed by F10-2. Restart after the repair push but before the round summary is acknowledged. Save `feedback-restart.json`. Pass when recovery keeps the same branch and head mapping, posts one summary, and does not rebuild. **Left unchecked. Only a variant was proven.** A controller restart at 22:47:51Z during round 2's repair build, after the patch was collected, recovered with no rebuild, ran validation and review, and posted one summary. A restart after the repair push but before the round summary is acknowledged was not hit live and rests on unit tests C4 and C5.
- [x] Lane 7. Closed by F10-2. Request a workflow edit in feedback. Save `feedback-scope.json`. Pass when the item is rejected in the round summary and the controller never weakens path policy.
- [x] Lane 8. Closed by F10-3. Add an owner commit while a repair is prepared, then add a second owner commit that fails `check`. Save `owner-head-drift.json`. Pass when the factory detects drift before any build spend, removes `factory:review`, posts one notice for each head, never overwrites the owner's commits or writes the PR branch, restores readiness as owner-authored after trusted gates and review pass on the first head without a build, deletes its pin ref, and holds with one notice on the failing head.
- [ ] Lane 9. Closed by F10-1. Submit an owner review with text on the already-merged #644, as the owner allowed, and post feedback on a `needs_info` fixture issue. Save `merged-feedback.json`. Pass when one proposed issue appears, a repeated sweep files no second one, no merged branch is changed, and neither terminal run revives. **Left unchecked. Only the merged half was proven.** Review 5813332175 on merged #644 produced exactly one proposal, #655, labeled `factory:proposed` with no `factory:ready`, and no merged branch changed. Feedback on a `needs_info` fixture issue was never posted live.
- [x] Lane 10. Closed by F10-2. Submit another `CHANGES_REQUESTED` review after the shared two-repair cap or the run token cap, whichever the fixture reaches first. Save `feedback-budget.json`. Pass when the run posts one explanation naming the reason and starts no repair, rather than resetting its repair budget.

**Verify, perf.** Tests alone are not sufficient verification. A PR is verified only when its unit, live, and perf boxes are all checked.

- [x] Metric. Measure review-to-dispatch latency, repair-stage wall time, full feedback-to-ready time, and cumulative tokens and spend on both revisions.
- [x] Probe. Use three small comment-fix rounds on head. On trunk record polling and unchanged PR state, not a successful repair. Reuse the lane rounds as the three head samples, labeled n=3 and not interleaved, only under a recorded coordinator grant, and otherwise interleave three fresh scenarios. Save `perf.json`. Recorded 2026-11-08 in `../pi-herdr-factorio-trails/F10/lanes/perf.json` and `perf.md`. The coordinator granted reuse of fixture B round 1, fixture B round 2 and the #654 round 1 repair as the three head samples, labeled n=3 and not interleaved. B1 and B2 are one fixture run.
- [x] Baseline. Record trunk's PR polling latency and existing run usage first. Recorded after the fact from the issue's run markers. On trunk 7d73c51 nothing was dispatched in 200 s, the PR head was unchanged, and run usage stayed at 257,429. Usage is a marker count, not a model-call meter.
- [ ] Rule. Fail if computing the metric over 1,000 rows exceeds 2 seconds, the metric calls a model, or a replay creates a production issue or PR. Flag over 20% higher median tokens or stage time for the same successful replay as a regression unless approved before the run. Computation, no-model and isolation checks held. The regression check has no median sample, since the one c3 pair shows +18.35% specify tokens, so the rule is not fully evaluated.

**Review gate.** The operator reviews before merge.

- [ ] Post the same-PR before and after URLs, head SHAs, fresh checks, and the round summary to the operator for each slice that changes PR behavior. Use text artifacts instead of a screenshot or video. Merge on a clean verdict and a passing `check`. Left unchecked. Every slice's PR carries an exact-head verdict comment with its head SHA and checks, and the round summaries are on #659 and #654, but no before and after URL bundle was posted to the operator for each slice.

**Merge.**

- [x] Record the exact-head verdict and Bugbot triage. Verdicts are in the per-PR review and verify files. Keep immature-cohort evidence gaps explicit.
- [x] Apply the patch-id rule in `playbooks/shipping.md`. Merge F10-1 to F10-4 in order under the owner's grant of 2026-11-07, each after a cross-family review, a clean verdict, and a passing `check`. F10-1 (#649, #653) and F10-2 (#656) had Grok reviews. F10-3 (#661), the notice fix (#663) and F10-4 (#662) had Opus reviews, because Grok's provider was unavailable (decision row `grok-outage`). The author was GPT, so Opus is still cross-family. After each merge, branch the next slice from the new `main`.

## Measure ticket outcomes before adding work (F12a)

**Depends on.** F10. This implements unit 12's primary outcome metric before `F11` adds scheduled work. It does not depend on `F11`'s cadence.

**Efficiency groundwork, owner-approved 2026-11-06.** Before the next pilot, efficiency PR 2 replaces accept/build/repair file prefixes with checkout-bound evidence ranges and nearby context, targeting 6 KiB with the existing 16 KiB source ceiling. Complete criteria, accepted contract digests, held-out isolation and token/time/retry caps stay unchanged. Receipts retain execution cost facts, stage summaries and new v3 ledger rows include them, and v1/v2 bytes stay unchanged. A pinned synthetic zero-token replay must retain every required fact and the good/bad outcomes while reducing serialized provider input by at least 20% at equal build-and-repair work. Interrupted and failed work stays in the charged denominator. The full F12a metrics system and a live all-GPT pilot remain separate work.

**Efficiency accept generation, owner-approved 2026-11-06.** Efficiency PR 3 adds existing public test imports and test entry points to accept's evidence pack. It keeps the 6 KiB soft source target and the 16 KiB ceiling, excluding held-out material and controller state. Accept requests one complete suite, prefers zero tools and names any missing fact before its bounded fallback. The existing two-call and three-request guards, truncation failure, criterion coverage, base qualification, tamper scan, one feedback retry and cumulative caps stay unchanged. Trusted `stages.accept.reasoning_effort` accepts low, medium or high and defaults to today's medium. The OpenAI route forwards it, with a zero-token serialized-request replay under `test/fixtures/efficiency/`. Low is the recommended live-pilot comparison, not a measured quality or token saving. This PR does not change the committed workflow, raise caps, call models or deploy a bundle.

**Files.**

- [x] Create `src/metrics.ts`, `src/replay.ts`, `test/metrics.test.ts`, `test/replay.test.ts`, `test/fixtures/replay/`, and `docs/operations/metrics.md`.
- [x] Edit `src/ledger.ts`, `server/cli.ts`, and `.github/factory/WORKFLOW.md` for the metric and replay commands, mature-cohort settings, and the replay cap.

**Build.**

- [x] Implement the primary metric from `docs/design.md`. Report the share of `factory:ready` tickets that landed with zero repair rounds and no linked follow-up defect within seven days. Report it against all tokens spent on that cohort, including failed, cancelled, and `needs_info` runs, as tokens per clean landing. Count a ticket once across clarification attempts.
- [x] Exclude verification runs from every cohort. Drop each row with `provenance.kind: "verification"`. Also drop `factory/ledger` line 13, run `199df6dc85d53522b12bded884ebe6351dffcb80f7e456d42124ab39e994489f` (issue #621, PR #622), an F10c verification run whose row says `production` by mistake, as `docs/operations/ledger.md` records.
- [x] Apply mature-cohort rules. A landed ticket matures seven days after its merge. Report a cohort with immature tickets as pending, and report unknown defect follow-up separately instead of treating missing evidence as clean. Serve the report as `metrics --json`. It reads only the ledger and redacted receipts and calls no model.
- [x] Add measurements that decide deferred work. Report context pressure, the share of stage prompts that hit a truncation flag or a prompt cap, to decide on full context packs. Report restart-ended runs, failed runs with interrupted attempts on the ledger, to decide R11. Report explicit-intake demand, write-access requests for factory work on issues without `factory:ready`, to decide on a model intake router. Each report names its revisit threshold, proposed at 10% of mature runs. None of them builds the deferred work.
- [x] Pin a small versioned replay corpus in `test/fixtures/replay/` of a proposed five sanitized past tickets, including known-good, known-bad, and vague cases. Replay it on the previous trusted factory and a candidate factory in clean environments, with previous-policy gates and isolated state. Report the primary metric, wall time, tokens, and spend for each factory. Prevent replay from creating ordinary production issues or PRs without a dedicated fixture grant.
- [x] Charge replay tokens and wall time to a configured replay cap in trusted `WORKFLOW.md`. No metric or replay result gates, advances, or promotes a run. The owner set the cap at 1,100,000 tokens on 2026-11-08 and raised it to 1,650,000 the same day. An interrupted replay run had kept its full 540,000 reservation, which left too little for the lane 6 comparison.

**You see.**

- [x] Save a metric report with numerator, denominator, tokens per clean landing, mature-cohort count, and unknowns. Save one replay comparison of the previous and candidate factories on the fixed corpus.

**Verify, unit.** Tests alone are not sufficient verification. A PR is verified only when its unit, live, and perf boxes are all checked.

- [x] Test cohort boundaries, duplicate attempts, the token denominator, seven-day defects, missing evidence, and the deferred-work thresholds in `test/metrics.test.ts`. Test corpus pinning, previous-policy selection, and replay isolation in `test/replay.test.ts`. Run `npm run check`.

**Verify, live.** Tests alone are not sufficient verification. A PR is verified only when its unit, live, and perf boxes are all checked. Ten lanes on `task:qa` at the PR head, per the boot recipe.

- [x] Lane 1. Regression lane against trunk. Read the same real ledger cohort on trunk and head. Save `outcome-metric.json`. Pass when head computes the defined metric and the deferred-work report, marks counts below their revisit thresholds, and does not invent mature history absent on trunk.
- [x] Lane 2. Inspect a recent cohort younger than seven days that includes a ticket with several clarification attempts. Save `immature-cohort.json`. Pass when the cohort is reported as pending rather than zero-defect success, and the ticket is counted once with its attempts visible.
- [ ] Lane 3. Link an authorized follow-up defect issue to a fixture run. Save `defect-window.json`. Pass when the affected mature cohort's result changes according to the seven-day rule. **Not run live.** It needs one owner-created `factory:defect` issue that references a fixture PR within 7 days of merge.
- [x] Lane 4. Include a failed run and a `needs_info` run in a fixture cohort. Save `token-denominator.json`. Pass when their tokens count in the denominator and neither counts as a clean landing.
- [x] Lane 5. Include a fixture ticket that landed after one repair round. Save `repaired-landing.json`. Pass when it counts as landed but not clean, and its repair tokens count.
- [ ] Lane 6. Replay a known-good real fixture ticket on the previous and candidate factories. Save `replay.json`. Pass when both factories use clean state and the ticket produces comparable behavior receipts. **Not met.** The c1 comparison never completed. Six attempts each surfaced a different blocker (the driver had no user bus in #671, the visible suite took longer than 180 s in #675, the cap ledger refused a policy change in #677, a long `TMPDIR` broke a harness socket path, the replay used a different umask from production in #679, and the trusted gate baseline took longer than 180 s in #681). All six are fixed and verified, but no c1 pair has run.
- [x] Lane 7. Run a replay and inspect side effects through `gh`. Save `replay-isolation.json`. Pass when no production issue, PR, or ticket dispatch appears and replay state stays apart from production state. Checked on the c3 pair from replay attempt 2.
- [x] Lane 8. Read ledger rows that include truncation flags and restart-ended runs. Save `deferred-work.json`. Pass when each report names its count, its share of mature runs, and its revisit threshold, and no deferred work is built.
- [x] Lane 9. Remove a fixture run's receipt from a verification copy of the state. Save `metric-unknowns.json`. Pass when its ticket appears under unknowns, not as a clean landing.
- [x] Lane 10. Compare replay session/model and policy versions. Save `replay-provenance.json`. Pass when the report records exact versions, same-family limitations, and unavailable spend without claiming improvement from incomparable runs. Checked on the c3 pair from replay attempt 2.

**Verify, perf.** Tests alone are not sufficient verification. A PR is verified only when its unit, live, and perf boxes are all checked.

- [ ] Metric. Metric computation is measured at 0.11 to 0.15 s over 1,000 rows against the 2 s limit, with no model call. The online CLI over 1,000 landed PRs takes 5.1 s because it spawns `gh` processes, so the 2 s rule is read as computation only. Lane 6 never completed, so the replay perf sample (wall time per stage, tokens and spend per replayed run on trunk and head) is missing. Only the c3 pair from replay attempt 2 exists.
- [ ] Probe. Interleave three metric calculations on the same ledger copy and three previous/head replay pairs for one fixed tiny ticket. Record trunk's unsupported metric command separately. Save `perf.json`. The owner reduced the three replay pairs to one, and lane 6 never completed that pair, so the probe is not met. Trunk's unsupported metric command is recorded separately (exit 2).
- [ ] Baseline. Record trunk's unsupported metric response and the previous factory's tiny-ticket stage timings and usage first. Trunk's response is recorded, but the previous factory's tiny-ticket timings come only from the c3 specify stage, so the baseline is not met.
- [ ] Rule. Fail if computing the metric over 1,000 rows exceeds 2 seconds, the metric calls a model, or a replay creates a production issue or PR. Flag over 20% higher median tokens or stage time for the same successful replay as a regression unless approved before the run. Computation, no-model and isolation checks held. The regression check has no median sample, since the one c3 pair shows +18.35% specify tokens, so the rule is not fully evaluated.

**Review gate.** The operator reviews before merge.

- [x] The owner reviewed and merged each PR, and the coordinator merged some under grants. Cross-family review used Opus while Grok was unavailable. Post the metric report, the pending-cohort receipt, and the replay comparison to the operator. Use JSON instead of a screenshot or video. Merge on a clean verdict and a passing `check`. Do not count the seven-day claim as verified before real mature evidence exists. No mature cohort exists yet, so the seven-day claim is not verified.

**Merge.**

- [x] Record the exact-head verdict and Bugbot triage. Verdicts are in the per-PR review and verify files. Keep immature-cohort evidence gaps explicit.
- [x] Apply the patch-id rule in `playbooks/shipping.md`. The owner merged #667, #668, #675 and #679 at the owner's word. The coordinator merged #671, #676, #677 and #681 under grants, at the owner's word. Production runs 15673a6. After a merge, branch the next PR from the new `main`.

## Give the owner a dashboard and harden controller health (F09c)

**Depends on.** F12a, a separate design-foundation PR that adds `DESIGN.md` and `server/viewer/design/tokens.css`, and a viewer restyle PR that moves the existing viewer pages onto those tokens. Both design PRs merge before F09c starts. This unit adds controller liveness, attention thresholds, a read-only owner feed, an owner dashboard on the existing viewer with one hold control, and a backup runbook. Owner decision 2026-11-02 added the dashboard. It adds no cancel or retry verbs. Removing `factory:ready` already releases an early-stage run, per `docs/operations/factory-cli.md:455`. A terminal run never restarts, and removing and re-adding `factory:ready` starts a fresh run, per `docs/operations/factory-cli.md:534`.

**Program cap raise, owner decision 2026-11-09.** The owner raised the program cap by 6M tokens, from 8.6M to 14.6M, to cover F09c, F11, F12, F13 and the F12a lane 6 pair. The coordinator checks in after each unit with actual spend against the 3.7M to 7.6M token estimate, and before exceeding it. The decision row is `program-cap-raise-14.6M` in `docs/decisions.tsv`.

**Design system, owner decisions 2026-11-09.** The dashboard ships on Shep's design system, so it never needs a restyle. It is built on `server/viewer/design/tokens.css` and follows `DESIGN.md`. It is dark only. Shep's tokens are pinned at commit `df025761ddb25472f0e86cd96911533b1132745e`. Tabler Icons outline glyphs (v3.50.0, MIT) are vendored with their notice. The owner approved layout mockup v2 with twelve rulings, and the Build and You see boxes below carry them.

**Files.**

- [ ] Create `src/feed.ts`, `server/viewer/dashboard.ts`, `test/feed.test.ts`, `test/dashboard.test.ts`, `test/fixtures/owner-feed/`, and `docs/operations/backup.md`. Also create the web-app manifest and its icons. Add any new Tabler glyph to `server/viewer/design/icons/`, which the viewer restyle PR creates with the vendored SVGs and their NOTICE.
- [ ] Edit `src/attention.ts`, `src/workflow.ts`, `.github/factory/WORKFLOW.md`, `server/controller.ts`, `server/cli.ts`, `server/viewer.ts`, `server/viewer/render.ts`, `server/viewer/style.css`, `server/factory.service`, `extension/index.ts`, `test/attention.test.ts`, `test/viewer.test.ts`, `test/viewer-style.test.ts`, `test/extension.test.ts`, `DESIGN.md` for new glyph roles only, `docs/operations/viewer.md`, and `docs/operations/factory-cli.md` for liveness, thresholds, the feed, the dashboard, and the hold control.

**Build.**

- [ ] Add controller liveness. Set `Type=notify` and `WatchdogSec=120` in `server/factory.service`, and keep `Restart=on-failure` and `RestartPreventExitStatus=2`. Have `serveLoop` in `server/controller.ts` send `READY=1` once and `WATCHDOG=1` after each `writeStatus`. systemd then restarts a controller that is alive but has stopped ticking. Node has no Unix datagram socket, so first prove the notify route, such as `systemd-notify` with the matching `NotifyAccess`, under `systemd-run --user -p WatchdogSec=10s` on the VM.
- [ ] Add age thresholds to `src/attention.ts`. Mark a `waiting` entry stale after a proposed 3 days and a blocked entry stale after a proposed 6 hours. Read both from trusted `.github/factory/WORKFLOW.md`. A stale entry stays in its group, and no threshold launches work or calls a model.
- [ ] Keep `budget_exhausted` distinct from `blocked`. Give it its own attention kind, `budget`, instead of folding it into blocked. The attention view then has seven kinds.
- [ ] Add a title and a status to each attention entry. Take the title from the admission snapshot, cap it at 120 characters, and treat it as untrusted plain text. The status is the claim's run status.
- [ ] Build the read-only owner feed in `src/feed.ts` from `readAttention` and the controller status. It returns versioned JSON, `OwnerFeed` v1, with controller state, last tick, local switch, entries, counts per kind, an explicit working-run count, and evidence gaps. The working-run count is the number of non-terminal claims with no attention kind. `groupOf` in `src/attention.ts` returns null for terminal runs and for unpublished in-progress runs. It returns `blocked` for a published run that is not `waiting`, so a published run in active refresh counts as blocked, not working. Neither path below writes state, calls `gh`, or calls a model.
- [ ] Serve the feed as `owner-feed --json` and as a GET-only route on the existing loopback viewer in `server/viewer.ts`, not a second port. Save golden feed output in `test/fixtures/owner-feed/` for `F09d`.
- [ ] Build an owner dashboard as the viewer's home page in `server/viewer/dashboard.ts`, rendered from `OwnerFeed` v1. Show every run in a group, with its title, stage, status, round, tokens against the run cap, CI result, PR link, and age. The groups are Needs you, Failed, Working and Done recently, in that order. Working and Done recently are display groups, not attention kinds, so the attention view stays at seven kinds. Done recently is folded. Show the run's "Not proven" entries from `F10b`, its failure class when it has one, and `F12a`'s primary metric when the ledger has a mature cohort. The metric comes from a local snapshot that the controller writes, and nothing calls GitHub at request time. Keep the existing single-run timeline pages as the drill-down. The dashboard reads private state and calls no model and no `gh`.
- [ ] Build the dashboard on the design system, using the rulings the owner settled on 2026-11-09.
  - [ ] Bundle `server/viewer/design/tokens.css` into the existing `/style.css`. Add no route, so the CSP does not change. Style only through tokens, with dark only and no `prefers-color-scheme`.
  - [ ] Map states as the `DESIGN.md` state table does. Blocked by an owner hold and out of budget go under Needs you, each with its own reason word. Stale is an age shown on the row, such as "Waiting 3 days", and never a group. Working is neutral and never green. Failed uses the `error` colour with `alert-triangle`.
  - [ ] Draw Needs you rows as the orange glyph plus the word in `attentionText`, with no tinted pill. Use `alert-circle` for "Your review", "Out of budget" and "On hold", and `message-question` (Shep `questionmark.bubble`) for "Your answer". `help-circle` keeps Shep's "Not confirmed" meaning, as in exmach.
  - [ ] Show the count badge on the "need you" tile only, and never repeat it on rows. Give that tile a neutral surface, not `attentionTint`, and keep the orange badge and the word.
  - [ ] Draw links in `textAccent`. Keep the `external-link` glyph on links to GitHub.
  - [ ] Put no counts in group headers. Order each group newest first, and let the age words flag old waits.
  - [ ] Use `title` for the issue title on run pages, and `largeTitle` only for "Factory" on the home page.
  - [ ] Below the phone breakpoint, put the status line ("Running · last tick 12s ago") on its own line under the title. Every page uses the same header.
  - [ ] Put the failure glyph on the stage that failed. For example, `review_input_too_large` puts it on Review, not on PR.
  - [ ] Inline Tabler outline glyphs from `server/viewer/design/icons/`, adding any new glyph with its Shep role in `DESIGN.md`. Add no icon font and no client script.
  - [ ] Keep `test/viewer-style.test.ts`, which the viewer restyle PR adds, passing on the new dashboard CSS. It fails on any raw hex, `rgb()` or `hsl()` colour, any `prefers-color-scheme` block, or a variable `tokens.css` does not define.
- [ ] Write the dashboard and the viewer for the owner, not the controller. Owner feedback on 2026-11-02 found the current viewer hard to read.
  - [ ] Name each run by its issue number and title, not by its run ID. Show the run ID only on the detail page.
  - [ ] Lead each run with one plain sentence that says what it is doing, or what it needs from the owner. For example, "Waiting for your review on PR 562" or "Stopped before build because a hidden test can never pass".
  - [ ] Show the timeline as stages and outcomes, namely spec, tests, build, CI, review and PR. Each row has its result, time and tokens. Move raw session events, such as `model_change` and `toolResult`, behind a details toggle.
  - [ ] Separate expected gaps from real problems. A landed run whose marker history isn't kept locally must not open with "Evidence incomplete". Keep the full gap list on the detail page, and explain each gap in a plain sentence.
  - [ ] Replace internal terms with plain words throughout, such as "generation", "certification", "settlement" and "evidence round". Keep a short glossary on the detail page for anyone who needs the exact term.
- [ ] Send every ticket action to GitHub. The dashboard links to the issue or PR for labeling, answering questions, review, merge, and close, so those actions keep the owner's GitHub identity. Add no merge, approve, label, retry, stage, or cap control.
- [ ] Add one control, a hold switch. A POST to a dashboard route creates or removes only the controller's local `disabled` file, the same hold `docs/operations/factory-cli.md` describes. Accept it only from the loopback or the authorized tailnet host, with a matching `Origin` and a per-process token. Send the form with CSP `form-action 'self'` and carry the token in a hidden field. This is the only change to the security posture. Refuse every other method and route. Log each change with its time and source, and write nothing else in private state.
- [ ] Expose the viewer on the owner's tailnet only, as the owner authorized on 2026-11-02. The viewer still binds `127.0.0.1`. Publish it with `tailscale serve` and its `--allowed-host` check, through an SSH tunnel from a tailnet machine, because the VM has no tailnet. Mount it at `/factory/` with `tailscale serve --set-path=/factory/` and the viewer's `--base-path /factory`, so the host root stays free. Every dashboard link, redirect, and the hold control's form target carry that prefix. Document starting, stopping, and the one-host rule in `docs/operations/viewer.md`. Build no public ingress, VM-to-VM, or exe.dev integration exposure.
- [ ] Make the dashboard an installable web app, with a manifest and icons, so it opens like an app on a phone. Cache no private data in the browser. A service worker, if any, caches only static assets.
- [ ] Write `docs/operations/backup.md`, a backup and restore runbook for VM state. Name every private path the controller needs to recover, including claims, receipts, candidate books, the ledger checkout, and status. Describe how to copy them with the controller stopped and how to restore them onto a VM set up by `server/provision.sh`.

**You see.**

- [ ] See the dashboard with an absent problem drawing nothing. An empty group is absent, and no text such as "No failed runs right now" appears. The colour legend is in `DESIGN.md` or behind a small help link, not on the dashboard.
- [ ] Save `owner-feed.json` from `owner-feed --json`, with a waiting PR, a blocked run, and a budget run under their own kinds, each with a title and a status, and a working-run count. Save the journal line where systemd restarts a live controller that stopped sending `WATCHDOG=1`.

**Verify, unit.** Tests alone are not sufficient verification. A PR is verified only when its unit, live, and perf boxes are all checked.

- [ ] Test thresholds, the separate budget kind, titles and statuses, feed shape, counts, the working-run count, and the offline extension view in `test/attention.test.ts`, `test/feed.test.ts`, and `test/extension.test.ts`. Test that the feed route refuses every method except GET and that the viewer refuses a non-loopback bind in `test/viewer.test.ts`. Test the dashboard's groups, state table, links, escaping, and metric panel read from the snapshot, and that the hold route refuses a missing token, a foreign `Origin`, an unlisted host, and any write but the `disabled` file in `test/dashboard.test.ts`. Run `npm run check`.

**Verify, live.** Tests alone are not sufficient verification. A PR is verified only when its unit, live, and perf boxes are all checked. Ten lanes on `task:qa` at the PR head, per the boot recipe.

- [ ] Lane 1. Regression lane against trunk. Run `status --json` on trunk and head with the same fixtures. Save `attention-diff.json`. Pass when head adds titles, statuses, and the budget kind, and every trunk entry still appears.
- [ ] Lane 2. Hang the tick loop of a scoped verification controller in a live, runnable process, so it stops sending `WATCHDOG=1`. Do not use `kill -STOP`, because a stopped process waits out `TimeoutStopSec=300`. Save `watchdog.log`. Pass when the journal shows a watchdog timeout, systemd restarts the controller within `WatchdogSec` plus `RestartSec` plus one poll, 120 plus 30 plus 30 seconds, and recovery leaves one claim per run.
- [ ] Lane 3. Leave a fixture PR waiting past a shortened verification threshold. Save `stale-wait.json`. Pass when the entry is marked stale, stays under PR review, and its model usage does not increase.
- [ ] Lane 4. Lower a scoped verification run's token cap in the verification workflow, then exhaust that lowered cap with a fixture run. Save `budget-kind.json`. Pass when the run appears under the budget kind, not under blocked, and the production caps are unchanged.
- [ ] Lane 5. Hold fixture runs that are working, waiting, and terminal at the same tick. Save `working-count.json`. Pass when the feed's working-run count equals the non-terminal claims with no attention kind, those runs appear in no attention kind, and terminal runs appear in neither.
- [ ] Lane 6. Read the feed over the CLI and the viewer route at the same tick. Save `owner-feed.json`. Pass when both return the same entries, each count equals its list length, and no `gh` or model process starts during the reads.
- [ ] Lane 7. Send a POST to the feed route, send the hold POST without a token and with a foreign `Origin`, connect from the VM's external address, and read a fixture title that contains HTML and control characters. Save `feed-boundary.log`. Pass when every POST is refused, the external connection fails, and the title arrives as escaped plain text within 120 characters.
- [ ] Lane 8. Open the dashboard at `/factory/` on the owner's tailnet through `tailscale serve`, with fixture runs in several kinds, then switch the hold on and off from it. Save `dashboard.json` and the rendered HTML. Pass when every run shows in its display group (Needs you, Failed, Working or Done recently) by issue number and title, budget stays a separate attention kind in the feed with a one-sentence status and working GitHub links, no second listening port appears, no internal link or form leaves `/factory/` (GitHub action links are required and exempt), the page has no sideways scroll at 390 and 320 px widths, the existing timeline pages still render, the controller reports `locally_disabled` while held and dispatch again after release, and a hash of private state shows that only the `disabled` file changed.
- [ ] Lane 9. Follow `docs/operations/backup.md` to back up the verification state and restore it into a scratch state directory. Save `backup-restore.json`. Pass when `status --json` on the restored directory matches the source and production state is unchanged.
- [ ] Lane 10. Remove `factory:ready` from an early-stage fixture run before handoff, then end a second fixture run and relabel its issue. Save `release-relabel.json`. Pass when the controller releases the first run through its existing `unlabeled` path with no CLI command, and the relabel starts a fresh run rather than reviving the ended one.

**Verify, perf.** Tests alone are not sufficient verification. A PR is verified only when its unit, live, and perf boxes are all checked.

- [ ] Metric. Measure `status --json` and `owner-feed --json` wall time, feed route and dashboard response time, the tick time the notify call adds, and model tokens on trunk and head.
- [ ] Probe. Interleave three metric calculations on the same ledger copy and three previous/head replay pairs for one fixed tiny ticket. Record trunk's unsupported metric command separately. Save `perf.json`. The owner reduced the three replay pairs to one, and lane 6 never completed that pair, so the probe is not met. Trunk's unsupported metric command is recorded separately (exit 2).
- [ ] Baseline. Record trunk's unsupported metric response and the previous factory's tiny-ticket stage timings and usage first. Trunk's response is recorded, but the previous factory's tiny-ticket timings come only from the c3 specify stage, so the baseline is not met.
- [ ] Rule. Fail if a feed read or a dashboard render exceeds 500 milliseconds, the notify call adds over 10 milliseconds to a tick, or any read calls a model. Fail if systemd takes over `WatchdogSec` plus `RestartSec` plus one poll interval, 180 seconds at the proposed settings, to restart a live controller that stopped sending `WATCHDOG=1`.

**Review gate.** The operator reviews before merge.

- [ ] Post `owner-feed.json`, `dashboard.json`, the rendered dashboard HTML, `watchdog.log`, and `backup-restore.json` to the operator, with the tailnet dashboard link. Use text artifacts instead of a screenshot or video. Keep public exposure out of scope. Merge on a clean verdict and a passing `check`.

**Merge.**

- [ ] Record the exact-head verdict and complete Bugbot triage after the notify prototype passes.
- [ ] Apply the patch-id rule in `playbooks/shipping.md`. Hand `F09c` to the owner on a clean verdict and a passing `check`. After the owner's merge, branch the next PR from the new `main`.

## Investigate a factorio iOS app (F09d)

**Depends on.** F09c. This unit is optional and blocks nothing. It writes only `docs/prototypes/ios-app/`, so it may run beside later code units. Its prototype decodes real F09c feed output. This is research and prototype work only, and no product code ships.

**Files.**

- [ ] Create `docs/prototypes/ios-app/` with `decision.md`, `screens.md`, `feed-contract.md`, `shep-lessons.md`, `apple-setup.md`, `fixtures/`, and a throwaway Swift package in `model/`.
- [ ] Edit nothing outside `docs/prototypes/ios-app/`. Make no change to the shep repository.

**Build.**

- [ ] Write `decision.md`. Compare a dedicated new app, a Factory section in Shep, and F09c's installable dashboard on fit to the job, one-time owner actions, per-change cost, push, and inbox. Name the dedicated app as the current lean and state what would change it.
- [ ] Write `screens.md` with three sketches. Home orders runs by what needs the owner, with working runs as the feed's working-run count. Run detail shows status, stages, repairs, and tokens against caps, with buttons that open GitHub. Notification rules push only owner decisions, cap each push at 100 words, and suppress pushes for a run while the owner is viewing it.
- [ ] Write `feed-contract.md`. Describe how the app reads F09c's `OwnerFeed` v1, which fields it needs, including the working-run count, and how it treats unknown fields and a newer version. Every action opens GitHub and none calls the factory.
- [ ] Write `shep-lessons.md` with the Shep practices that transfer as copied code or rules, not a shared package. Include seeding without a push, suppression while viewing, the protocol document as the contract, and a fake backend by default.
- [ ] Write `apple-setup.md` with the owner's Apple steps and costs. Cover the bundle ID, the Push capability, the App Store Connect record, internal TestFlight testers, APNs key scope, and where a push sender may run.
- [ ] Capture real feed output into `fixtures/`. Run the F09c controller on `pi-factorio` through the boot recipe with fixture runs in each attention kind and at least one working run, and save redacted `owner-feed --json` output.
- [ ] Build a throwaway SwiftUI or ShepKit-style model in `model/` on a machine with Xcode. Decode every fixture, order Home, and apply the notification rules in Swift Testing cases. Record the Xcode and Swift versions. The model never becomes product code.
- [ ] Record the open exposure question in `decision.md`. Name the choices, such as an exe.dev VM-to-VM integration, the exe.dev HTTPS proxy, and a relay on another VM, and leave the choice to the owner. Take no Apple account action, build no TestFlight release, and run no VM-to-VM check.

**You see.**

- [ ] Save `decision.md` with a recommendation, the three screen sketches, and a Swift Testing run that decodes real F09c fixtures.

**Verify, unit.** Tests alone are not sufficient verification. A PR is verified only when its unit, live, and perf boxes are all checked.

- [ ] Run the one Swift Testing suite in `model/` against F09c's captured feeds on the Xcode machine and save its output in `swift-tests.log`. Run `npm run check` to show the factorio code is unchanged and green.
- [ ] Have an independent reviewer read the five memos against the captured fixtures. Save the review in `memo-review.md`.

**Verify, live.** Tests alone are not sufficient verification. A PR is verified only when its unit, live, and perf boxes are all checked. Ten lanes on `task:qa` at the PR head, satisfied by the scoped adaptation in Appendix C R10 item 11. No lane runs on the VM. Each lane is a Swift Testing case, the memo review, or a local scope check.

- [ ] Lane 1. Satisfied by the scoped adaptation. Run `npm run check` on trunk and head. Save `check-trunk-head.log`. Pass when both pass.
- [ ] Lane 2. Satisfied by the scoped adaptation. The Swift suite decodes every captured feed. Save `decode.log`. Pass when every entry decodes and none is dropped.
- [ ] Lane 3. Satisfied by the scoped adaptation. The Swift suite decodes a copy with an unknown field and a copy with `v` set to 2. Save `decode-versions.log`. Pass when the model ignores the unknown field and refuses version 2 with a visible error.
- [ ] Lane 4. Satisfied by the scoped adaptation. The Swift suite orders Home from a captured feed. Save `home-order.json`. Pass when runs that wait on the owner come first, then blocked, budget, and failed runs, and working runs appear only as the feed's working-run count.
- [ ] Lane 5. Satisfied by the scoped adaptation. The Swift suite applies the notification rules to two consecutive captures. Save `push-diff.json`. Pass when the first capture seeds without a push, the second pushes only new owner decisions, and a repeat pushes nothing.
- [ ] Lane 6. Satisfied by the scoped adaptation. The Swift suite counts the words in every generated push. Save `push-words.json`. Pass when each push has 100 words or fewer and carries no issue body or model text.
- [ ] Lane 7. Satisfied by the scoped adaptation. The Swift suite marks one run as on screen while its entry changes. Save `push-suppressed.json`. Pass when that run produces no push and other runs still do.
- [ ] Lane 8. Satisfied by the scoped adaptation. The Swift suite renders each captured title, including a fixture title with Markdown and HTML. Save `title-plain.log`. Pass when every title renders as plain text.
- [ ] Lane 9. Satisfied by the scoped adaptation. Read the independent memo review. Save `memo-review.md`. Pass when every memo claim about `OwnerFeed` v1 matches the captured fixtures and the exposure question is left to the owner.
- [ ] Lane 10. Satisfied by the scoped adaptation. Inspect the PR diff and the shep repository head. Save `scope.json`. Pass when only `docs/prototypes/ios-app/` changed and the shep repository head is unchanged.

**Verify, perf.** Tests alone are not sufficient verification. A PR is verified only when its unit, live, and perf boxes are all checked.

- [ ] Metric. Satisfied by the scoped adaptation. This unit ships no product code, so it has no perf probe. Record the Swift suite's wall time and model calls.
- [ ] Probe. Interleave three metric calculations on the same ledger copy and three previous/head replay pairs for one fixed tiny ticket. Record trunk's unsupported metric command separately. Save `perf.json`. The owner reduced the three replay pairs to one, and lane 6 never completed that pair, so the probe is not met. Trunk's unsupported metric command is recorded separately (exit 2).
- [ ] Baseline. Record trunk's unsupported metric response and the previous factory's tiny-ticket stage timings and usage first. Trunk's response is recorded, but the previous factory's tiny-ticket timings come only from the c3 specify stage, so the baseline is not met.
- [ ] Rule. Satisfied by the scoped adaptation. Fail if any step calls a model.

**Review gate.** The operator reviews before merge.

- [ ] Post `decision.md`, the screen sketches, `swift-tests.log`, and `memo-review.md` to the operator. Use text artifacts instead of a screenshot or video. Bring the owner the app choice and the exposure question. Merge on a clean verdict and a passing `check`.

**Merge.**

- [ ] Record the exact-head verdict and complete Bugbot triage. Confirm that no Apple account, TestFlight, VM-to-VM, or shep repository action happened.
- [ ] Apply the patch-id rule in `playbooks/shipping.md`. Hand `F09d` to the owner on a clean verdict and a passing `check`. No later unit waits for this merge.

## File bounded maintenance proposals on a schedule (F11)

**Depends on.** F09c. This implements unit 11.

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
- [ ] Probe. Interleave three metric calculations on the same ledger copy and three previous/head replay pairs for one fixed tiny ticket. Record trunk's unsupported metric command separately. Save `perf.json`. The owner reduced the three replay pairs to one, and lane 6 never completed that pair, so the probe is not met. Trunk's unsupported metric command is recorded separately (exit 2).
- [ ] Baseline. Record trunk's unsupported metric response and the previous factory's tiny-ticket stage timings and usage first. Trunk's response is recorded, but the previous factory's tiny-ticket timings come only from the c3 specify stage, so the baseline is not met.
- [ ] Rule. Fail if local idle schedule evaluation adds over 100 milliseconds, a small audit exceeds 10 minutes or 40,000 tokens, or one finding takes over 60 seconds after settlement to become a proposed issue. Enforce the maintenance spend cap.

**Review gate.** The operator reviews before merge.

- [ ] Post the proposed issue and no-duplicate receipt to the operator. Use logs instead of a screenshot or video. Merge on a clean verdict and a passing `check`.

**Merge.**

- [ ] Record the exact-head verdict, license review, and Bugbot triage.
- [ ] Apply the patch-id rule in `playbooks/shipping.md`. Hand `F11` to the owner on a clean verdict and a passing `check`. After the owner's merge, branch the next PR from the new `main`.

## Score runs and propose tested factory improvements (F12)

**Depends on.** F11. This implements the rest of unit 12 without self-promoting changes. The primary metric is `F12a`'s, and every other measure here is secondary to it.

**Files.**

- [ ] Create `src/scorers.ts`, `src/benchmarks.ts`, `src/explain.ts`, `test/scorers.test.ts`, `test/benchmarks.test.ts`, `test/explain.test.ts`, `test/fixtures/benchmarks/`, `skills/agent-loop-spec/`, `skills/reflect-ledger/`, and `docs/operations/improvement.md`.
- [ ] Edit `src/metrics.ts`, `src/replay.ts`, `src/cadence.ts`, `src/ledger.ts`, `server/cli.ts`, `.github/factory/WORKFLOW.md`, `skills/README.md`, `test/replay.test.ts`, and `test/fixtures/replay/` for scorer, benchmark, and explain commands, score records, proposal cadence, and the wider replay corpus.

**Build.**

- [ ] Use `F12a`'s metric as the primary measure. Every proposal, replay comparison, and benchmark recommendation reports its effect on that metric first.
- [ ] Adapt agent-loop-spec and pstack reflect to read the ledger rather than private transcripts. Generate bounded `factory:proposed` issues with the baseline, proposed change, evidence, and keep-or-reject rule. Never edit a skill or enable a proposal automatically.
- [ ] Extend `F12a`'s replay corpus with forbidden-path, budget-exhausted, and feedback cases. Report acceptance quality, missed defects, false rejection, wall time, tokens, and spend. Require no seeded bad acceptance and no regression in mandatory behavior or in the primary metric before proposing promotion.
- [ ] Add scorers. Source is owner decision 2026-10-29, after comparing Warp Factories. A scorer is an LLM judge declared in trusted `WORKFLOW.md`. It returns exactly one label from a declared set, and each label carries a score from 0 to 1. Each scorer has a `passingScore` and a `samplingRate`. Record the label, score, reasoning, judge model, and scored run ID on the ledger. Let a scorer include child runs, and let `score --run <id>` score on demand. A re-score replaces the earlier result and keeps its history. Reject an undeclared label as a failed scoring, never a pass.
- [ ] Add benchmark tasks. A task has a prompt, success criteria, and repository state pinned to a full 40-character SHA. Reject branches and tags. Let `benchmark task --from-run <id>` build a task from a past ledger run. Keep task inputs immutable so later edits do not change past results.
- [ ] Add benchmark runs. A run is a matrix of up to N model or configuration variants, tasks, and repetitions. Show the trial count before launch. Report correctness against tokens and known cost per variant, plus a recommendation that needs at least two comparable variants. Label unknown spend unavailable. Run trials through the replay isolation above, with no production issue or PR.
- [ ] Add the improvement trigger. After K unreviewed failing scores for one scorer, or when the oldest is D days old, file one deduplicated `factory:proposed` issue that cites the failing runs. Never open a code PR from this trigger. That keeps the never-self-promote rule. Read N, K, and D from trusted `WORKFLOW.md`. Start at Warp's published values of 6 variants, 25 failures, and 7 days, and tune them only from ledger evidence.
- [ ] Add `explain --run <id>`, an on-demand diagnosis of why a run ended as it did. It reads the run's ledger row and redacted receipts, never raw sessions, and prints plain-text findings. It is a hint for the owner. No command runs from it, and no timer triggers it.
- [ ] Add secondary benchmark rows that replicate the measures from DeepSeek's "Exploring Super-agent Design" where they apply to fixed stages. Report them below the primary metric. Measure feedback-routing tokens on a fixed feedback corpus with F10's feedback batch and with a full-PR-thread rebuild ablation, which rebuilds each round's context from the whole PR thread. Report p50 ticket time from `factory:ready` to the ready PR as a secondary row. Leave out the article's router measures, because this controller has no router.
- [ ] Add replay thresholds measured on `F12a`'s primary metric. A proposal fails replay when the pass rate drops by more than a proposed 0.05, or any case falls from a proposed 3/3 to 1/3 or fewer. A within-noise result is a primary-metric change of at most that proposed 0.05 that trips no case rule. It blocks the proposal from claiming an improvement and has no other effect.
- [ ] Fingerprint the scorer and the replay corpus, and void any candidate that touches either. Pin the grader model by exact ID in trusted `WORKFLOW.md`, and refuse to score with an unpinned grader.
- [ ] Keep never-self-promote. A proposal never edits prompts or gates. A score is never a gate, even after calibration.
- [ ] Run judges, benchmark trials, and `explain --run` in the `F05` sandbox, through the egress gateway. Charge their tokens and wall time to the configured usage caps. Choose a judge model family different from the builder's where one is available. Otherwise record `context-isolated, same family, not cross-family` on the score. A score is a measurement, never a gate. A failing hard check still vetoes, and no score can advance a run.

**You see.**

- [ ] Save one improvement proposal and a replay comparison that rejects a deliberately weakened validator.
- [ ] Save one scorer result with its label, score, reasoning, and judge family, and one benchmark report with the primary metric first, a correctness against cost table, the secondary article rows, and a recommendation. Save one `explain --run` report for a failed run.

**Verify, unit.** Tests alone are not sufficient verification. A PR is verified only when its unit, live, and perf boxes are all checked.

- [ ] Test the extended corpus pinning and previous-policy selection in `test/replay.test.ts`. Test declared labels, undeclared labels, sampling, re-scoring, SHA pinning, matrix limits, the K and D trigger, and the hard-check veto in `test/scorers.test.ts` and `test/benchmarks.test.ts`. Test that `explain` reads only redacted inputs, charges the caps, and triggers no command in `test/explain.test.ts`. Test the replay thresholds, voided candidates that touch the scorer or corpus, and refusal of an unpinned grader in `test/replay.test.ts` and `test/scorers.test.ts`. Test the secondary article rows and that every report puts the primary metric first in `test/benchmarks.test.ts`. Run `npm run check`.

**Verify, live.** Tests alone are not sufficient verification. A PR is verified only when its unit, live, and perf boxes are all checked. Ten lanes on `task:qa` at the PR head, per the boot recipe.

- [ ] Lane 1. Regression lane against trunk. Read the same real ledger cohort with `F12a`'s metric on trunk and head. Save `primary-metric.json`. Pass when both revisions report the same primary metric, and head adds scorer and benchmark records without changing it.
- [ ] Lane 2. Score a finished fixture run on demand, then re-score it. Save `rescore.json`. Pass when the new result replaces the old one, the history keeps both, and the scorer's `passingScore` decides pass or fail.
- [ ] Lane 3. Build benchmark tasks from a past ledger run with a branch name, a tag, and a 40-character SHA. Save `task-pinning.json`. Pass when the branch and the tag are refused, the SHA task is accepted, and a later edit to the task does not change past results.
- [ ] Lane 4. Run reflect twice against unchanged redacted ledger data. Save `reflect-proposal.json`. Pass when one evidence-backed proposed issue appears, the second run files no duplicate, and no skill file changes.
- [ ] Lane 5. Replay a deliberately weakened validator against a seeded bad ticket from the extended corpus on previous and candidate factories. Save `replay.json`. Pass when both factories use clean state and previous trusted gates reject promotion of the weakened validator.
- [ ] Lane 6. Run `explain --run` on a real failed fixture run. Save `explain-run.json`. Pass when the findings cite ledger and receipt evidence, the gateway audit shows it ran in the sandbox, its tokens count against the caps, and no command or GitHub write follows.
- [ ] Lane 7. Score a finished fixture run on demand, including its child runs, then score a run whose hard check failed. Save `scorer-result.json`. Pass when each score has one declared label, a 0 to 1 score, reasoning, and a judge family label, the gateway audit shows the judge ran in the sandbox, its tokens count against the run caps, and the failed run stays failed despite a passing score.
- [ ] Lane 8. Build a task from a past ledger run and launch a two-variant, one-task, two-repetition benchmark with the article rows. Inspect side effects through `gh`. Save `benchmark-run.json`. Pass when the task pins a 40-character SHA, the report shows the primary metric first, correctness against cost, feedback-routing tokens for F10's feedback batch and for the full-PR-thread rebuild ablation, p50 ticket time as a secondary row, and a recommendation, and no production issue, PR, or ticket dispatch appears.
- [ ] Lane 9. Seed K unreviewed failing scores for one scorer, then run the trigger twice. Save `improvement-trigger.json`. Pass when one `factory:proposed` issue cites the failing runs, no PR or skill change appears, and the second run files no duplicate.
- [ ] Lane 10. Request a benchmark matrix above the configured N variants, then launch one that reaches its token cap. Save `benchmark-limits.json`. Pass when the trial count shows before launch, the oversized matrix is refused, the capped run stops at its cap, and no production issue or PR appears.

**Verify, perf.** Tests alone are not sufficient verification. A PR is verified only when its unit, live, and perf boxes are all checked.

- [ ] Metric. Measure replay wall time per stage, tokens/spend per run, and outcome quality on trunk and head. Measure scorer tokens as a share of the scored runs' tokens, benchmark trial tokens against the benchmark cap, and `explain --run` tokens and wall time.
- [ ] Probe. Interleave three metric calculations on the same ledger copy and three previous/head replay pairs for one fixed tiny ticket. Record trunk's unsupported metric command separately. Save `perf.json`. The owner reduced the three replay pairs to one, and lane 6 never completed that pair, so the probe is not met. Trunk's unsupported metric command is recorded separately (exit 2).
- [ ] Baseline. Record trunk's unsupported metric response and the previous factory's tiny-ticket stage timings and usage first. Trunk's response is recorded, but the previous factory's tiny-ticket timings come only from the c3 specify stage, so the baseline is not met.
- [ ] Rule. Fail if any seeded bad candidate passes, or candidate replay regresses mandatory behavior. Flag over 20% higher median tokens or elapsed stage time for the same successful scenario as a failed improvement claim unless approved before the run. Fail if scoring at the configured sampling rate exceeds 10% of the scored runs' tokens, or a benchmark run exceeds its configured cap. Fail if one `explain --run` exceeds a proposed 30,000 tokens or 5 minutes. Warp reports scoring near 3% of its own tokens. Record that figure as a reference, not a budget.

**Review gate.** The operator reviews before merge.

- [ ] Post the replay comparison, a scorer result, a benchmark report, and the proposed issue to the operator. Use JSON instead of a screenshot or video. Merge on a clean verdict.

**Merge.**

- [ ] Record the exact-head verdict and Bugbot triage.
- [ ] Apply the patch-id rule in `playbooks/shipping.md`. Hand `F12` to the owner on a clean verdict and a passing `check`. After the owner's merge, branch the next PR from the new `main`.

## Add a polled Linear adapter without changing stages (F13)

**Depends on.** F12. This implements unit 13 after the GitHub path is working.

**Files.**

- [ ] Create `src/adapters/linear.ts`, `test/linear-adapter.test.ts`, `test/adapter-contract.test.ts`, `docs/prototypes/linear-polling/`, and `docs/operations/linear.md`.
- [ ] Edit `src/tickets.ts`, `src/admission.ts`, `src/orchestrator.ts`, `src/run.ts`, `src/workflow.ts`, `src/markers.ts`, `server/controller.ts`, `server/cli.ts`, `test/fake-ticket-adapter.ts`, `test/admission.test.ts`, `test/orchestrator.test.ts`, and `.github/factory/WORKFLOW.md` only for provider configuration, capability ports, and shared adapter contract support.

**Build.**

- [ ] Prototype polled Linear issue/event reads, authorization, state transitions, comment reporting, and stable cursors with an owner-approved workspace and controller-only credential route. Keep Linear disabled until that authorization and access exist. Do not introduce an App receiver, webhook, or Tailscale.
- [ ] Put each tracker behind capability ports in `src/tickets.ts`. A `SourceReader` polls with a cursor and implements `proveReady`, which returns the source actor, an immutable snapshot, and a proof digest, or nothing. Admission in `src/admission.ts` refuses a run without that proof. Keep GitHub's historical proof algorithm behind its port, and never infer GitHub write authority from a Linear identity. A separate controller port reports questions, progress, and closure. Add no plugin registry.
- [ ] Implement `LinearTicketAdapter` against those same ports. Reuse F10's provider-qualified thread and event IDs for ticket keys. Normalize readiness actor, immutable snapshot, questions, progress, and closure. Keep GitHub branch/PR/CI publication in the existing publisher.
- [ ] Prove the readiness actor and snapshot contract through Linear's actual history APIs. If polling cannot establish them, block that admission instead of assuming an assignee or current label grants authority. Map the approved workspace/team to this repository explicitly.
- [ ] Bring the owner the choice between an anchor issue and native identity, and record the decision before building either. With an anchor, the paired GitHub evidence issue is the run's execution identity, and the Linear-origin provenance is stored beside it. With native identity, claim keys and run IDs in `src/run.ts` and `src/orchestrator.ts` move to provider-qualified keys with explicit legacy decoding. Never fabricate a ready-label event to make a Linear ticket fit.
- [ ] Run the shared adapter tests against GitHub, Linear, and the fake. Reuse the state machine, budgets, marker reconciliation semantics, and Human Review checkpoint without tracker-specific stage forks. Keep Linear credentials outside all agent containers.
- [ ] Link real Linear verification tickets to paired GitHub evidence issues and PRs in this repository. Do not claim native Linear agent-session acknowledgments. This adapter polls generic tickets and reports progress through comments.

**You see.**

- [ ] Save a Linear ticket URL, its paired GitHub evidence issue, and one verified ready PR in this repository. The factory waits for the owner just as it does for a GitHub ticket.

**Verify, unit.** Tests alone are not sufficient verification. A PR is verified only when its unit, live, and perf boxes are all checked.

- [ ] Run the shared admission, clarification, recovery, reporting, and closure tests through all three adapters. Add pagination, GraphQL error, rate-limit, and missing-authority cases in `test/linear-adapter.test.ts`. Test that admission refuses a missing or mismatched proof in `test/admission.test.ts`, and test the chosen identity, including legacy decoding when native identity is chosen, in `test/orchestrator.test.ts`. Run `npm run check`.

**Verify, live.** Tests alone are not sufficient verification. A PR is verified only when its unit, live, and perf boxes are all checked. Ten lanes on `task:qa` at the PR head, per the boot recipe. Each Linear scenario includes a paired real GitHub evidence issue in this repository.

- [ ] Lane 1. Regression lane against trunk. Drive the same GitHub fixture on trunk and head, then its equivalent Linear ticket on head. Save `adapter-parity.json`. Pass when GitHub behavior is preserved and Linear reaches the same Human Review state.
- [ ] Lane 2. Apply the approved readiness signal through an authorized Linear actor. Save `linear-admission.json`. Pass when `proveReady` returns the actor, the snapshot, and a proof digest, and exactly one run starts.
- [ ] Lane 3. Apply an unauthorized readiness signal under the test identity grant. Save `linear-unauthorized.json`. Pass when no run or GitHub branch appears.
- [ ] Lane 4. Submit a vague Linear ticket and answer its questions with fresh readiness. Save `linear-clarification.json`. Pass when the linked attempt preserves the first outcome and uses the updated authorized snapshot.
- [ ] Lane 5. Restart the controller during a Linear-origin run. Save `linear-recovery.json`. Pass when one run and one GitHub PR mapping survive under the chosen identity.
- [ ] Lane 6. Disable either factory switch before Linear dispatch. Save `linear-disabled.json`. Pass when both trackers stop new work under the same policy.
- [ ] Lane 7. Exercise pagination and a real bounded rate-limit/error response. Save `linear-polling.log`. Pass when cursors do not skip tickets and errors cannot create authorization.
- [ ] Lane 8. Add owner feedback to the resulting GitHub PR. Save `linear-pr-feedback.json`. Pass when the existing feedback loop updates that PR and reports status back to Linear.
- [ ] Lane 9. Have the owner merge the known-good Linear-origin fixture PR. Save `linear-owner-merge.json`. Pass when Linear closure and one ledger row reflect the real merge SHA. Remain BLOCKED until the owner acts.
- [ ] Lane 10. Inspect stage mounts and provider configuration. Save `linear-credential-isolation.json`. Pass when Linear credentials remain controller-only and no webhook or public listener is required.

**Verify, perf.** Tests alone are not sufficient verification. A PR is verified only when its unit, live, and perf boxes are all checked.

- [ ] Metric. Measure poll/admission wall time, stage timings, and tokens/spend per GitHub and Linear run on trunk and head. Compare equivalent ticket contracts, not raw tracker response sizes.
- [ ] Probe. Interleave three metric calculations on the same ledger copy and three previous/head replay pairs for one fixed tiny ticket. Record trunk's unsupported metric command separately. Save `perf.json`. The owner reduced the three replay pairs to one, and lane 6 never completed that pair, so the probe is not met. Trunk's unsupported metric command is recorded separately (exit 2).
- [ ] Baseline. Record trunk's unsupported metric response and the previous factory's tiny-ticket stage timings and usage first. Trunk's response is recorded, but the previous factory's tiny-ticket timings come only from the c3 specify stage, so the baseline is not met.
- [ ] Rule. Fail if head GitHub polling exceeds 120% of comparable trunk time plus 1 second, Linear admission exceeds two configured ticks without throttling, or equivalent stage execution exceeds the existing run budgets. Do not compare Linear end-to-end speed to trunk's unsupported response.

**Review gate.** The operator reviews before merge.

- [ ] Post the paired ticket/PR URLs and adapter-parity evidence to the operator. Use logs instead of a screenshot or video. Merge on a clean verdict. Keep the Linear live gate incomplete if workspace access is unavailable.

**Merge.**

- [ ] Record the exact-head verdict, live adapter proof, and Bugbot triage.
- [ ] Apply the patch-id rule in `playbooks/shipping.md`. Hand `F13` to the owner on a clean verdict and a passing `check`. Leave deployment and package publication manual.

## Close the program

- [ ] Check every completed box against its artifact and exact revision. Leave blocked boxes unchecked. Do not describe this program as fully verified while Linear live proof, branch protection, mature metrics, or the required cross-family acceptance evidence is absent.
- [ ] Re-run the eight definition-of-done scenarios from `docs/design.md` on the assembled GitHub controller. Link the results from `F04b`, `F04c`, `F06a`, `F07b`, `F07c`, `F09a`, `F09b`, `F10c`, and `F10`. Verify item 2's cross-family clause through `F10c`'s cross-family certified run, rather than reporting it as incomplete.
- [ ] Deliver the `autopilot-full` report with each PR's URL, merge commit, one-line verdict and exact verified head, the external actions taken and their grants, and excluded work with reasons. Include evidence and decision-trail paths.
- [ ] Confirm that the factory stops at Human Review, uses no stored GitHub token on the VM, uses no GitHub secrets for model access, and has no GitHub App, webhook receiver, or Tailscale dependency. Leave npm publishing and any future deployment outside this program.
- [ ] Name the measured next steps after the core loop. Run real production tickets and report them with `F12a`'s metric. Then run the same factory on a second target repository. This program builds neither.
- [ ] Leave computer-use verification out of v1. `docs/design.md` Known risks records the deferred pattern for a future UI target. Source is owner decision 2026-10-29, after comparing Warp Factories.

## Appendix A. Prototype evidence

The planning checkout was clean at `04b69c3b72b68ee8d4351d40bd42daf68d42a67f`. No implementation, external mutation, or new execution prototype ran while authoring this plan. The evidence below comes from `docs/decisions.tsv`, the prototype report, and bounded read-only VM inspection.

| Unit | Recorded proof | Revision or branch | What it does not prove |
| --- | --- | --- | --- |
| 0 | [Run 40767252647](https://github.com/giuseppecrj/pi-herdr-factorio/actions/runs/40767252647) printed `factory-smoke-ok` | The decisions row identifies the run, not its source SHA or branch. Read run metadata if reproducing historical provenance. | Current VM isolation or current CI architecture. Tailnet workflows and credentials were removed in `a893370`. Do not recreate them. |
| 1 | [Run 40768344796](https://github.com/giuseppecrj/pi-herdr-factorio/actions/runs/40768344796), [job 123098473635](https://github.com/giuseppecrj/pi-herdr-factorio/actions/runs/40768344796/job/123098473635), `docs/prototypes/herdr-on-runner.md` | Tested commit `a8f1285bb4e358bcfe6d56b4e7234b14fdaa2299`. Report committed at `1a345ea`, prototype merged at `fc34d66`. Decisions identify retained branch `factory-herdr-probe`, worktree removed with approval. | Rootless containment, allowed egress, full pstack execution, concurrent capacity, or cross-family review. The old runner used revoked tailnet access. |
| 2 | `npm run check` with 60 of 60 tests, `docs/decisions.tsv` | Skeleton `8ef1924`, widened `.github/` path protection `db91d1a`. Decisions identify retained branch `factory-skeleton`, worktree removed with approval. | Polling, service state, real adapter, sandbox, CI, or publication. Existing pipeline tests call the pure transition function through a fake. |
| 3 | VM `gh` reads, clone and label writes. Four model smoke replies. Later default-model smoke replied `default-ok`. All recorded in `docs/decisions.tsv`. | VM bring-up under `8154ca8`, provisioning `3228ca1`, default model `04b69c3`. No hosted run URL is recorded for these VM checks. | Current Anthropic authorization, sandbox egress, service recovery, or hosted candidate validation. Earlier Anthropic success did not authorize its use. The owner's 2026-11-02 decision does, through `F10c`. |

The unit 1 report records 10 seconds of setup, 22 seconds for the probe, and 34 seconds for the full CI job. Those are historical measurements on another execution setup, not budgets or comparative baselines for the new sandbox.

Read-only planning inspection used `SSH_AUTH_SOCK=$HOME/.ssh/headless-agent.sock ssh exedev@pi-factorio.exe.xyz`. It observed UID 1000, membership in the `docker` group, Docker 29.1.3, and daemon security options `seccomp` and `cgroupns`, without a `rootless` option. `newuidmap`, `slirp4netns`, and `rootlesskit` were not found on that non-login PATH. This does not prove rootless execution is impossible. It does prove that the active daemon's output is not rootless evidence.

Both `github.int.exe.xyz` and `llm.int.exe.xyz` resolved to `169.254.169.254`. Pi reported 1.4.0. Herdr was absent from the initial non-login PATH but reported 0.9.5 after adding the provisioned user bin directories. Repository-scoped `gh repo view` and label listing succeeded through `GH_HOST=github.int.exe.xyz`, and no `~/.config/gh/hosts.yml` existed. A global `gh api user` call failed JSON parsing. Use repository-scoped probes rather than assuming the integration implements every GitHub endpoint. The bot identity is an owner decision and prior recorded evidence, not a new successful global-user lookup.

No new sandbox, snapshot-at-label-time, main-gates, post-publication holdout, ledger, or Linear prototype is claimed here. Their first build boxes are explicit stop gates. The plan-only authorization prevents settling them through mutations now.

## Appendix B. Alternatives rejected

- A GitHub App or webhook receiver conflicts with the chosen `gh` polling controller. No public ingress is needed.
- Tailscale and hosted model execution belong to the retired prototypes. The VM now uses exe.dev integrations, and hosted CI runs deterministic checks without stored secrets.
- Automatic merge of factory-opened PRs conflicts with v1's Human Review boundary. Later autonomy belongs in checkpoint policy, not a hidden merge command. The root's separate historical build-PR merge grant ended at F08. From F09a onward the owner alone merges build PRs too.
- A one-shot `pi -p` parent cannot stand in for persistent Herdr RPC orchestration. Unit 1 proved result delivery only while the parent remained alive.
- A workspace directory, Git worktree, non-root container UID, or prompt prohibition is not the OS and network boundary required by the integration's VM-wide authority.
- Candidate-owned checks alone can be weakened by editing scripts or deleting tests. Main-owned gates, candidate tests, and held-out tests must all pass.
- A sanitized working tree with the original Git object database still leaks an acceptance commit. Repair gets a clean export and restricted network, not a checkout with the suite merely deleted.
- Same-family sessions cannot establish cross-family judgment. They are the approved interim execution choice until `F10c` merges, with the missing independence claim explicit.
- Linear-native agent sessions introduce webhook acknowledgement requirements outside the selected polling model. Unit 13 uses ordinary polled tickets through the existing adapter.
- A database or distributed claim service adds no demonstrated value for the single VM/controller scope. Marker comments, workspace receipts, and serialized ledger writes cover the specified restart cases. Revisit only if an observed failure requires it.
- Decomposition, multi-PR splitting, and large agent swarms stay out of v1, by owner decision on 2026-11-02. They do not serve one authorized issue to one ready PR.
- Reports 4 and 5 contain earlier recommendations about draft PRs, Apps, tailnets, and automatic landing. The later owner decisions in `docs/design.md` and `docs/decisions.tsv` supersede those recommendations.

## Appendix C. Risks

### R1. Rootless isolation and same-IP integrations remain unproved

`F05` owns this blocker. The VM has Docker, but active rootless operation has not been proved. Both integrations share an address, so an IP allowlist either blocks both or exposes both. The prototype must prove the specific gateway and container policy against Host/SNI changes and direct-route bypass while preserving npm and model access. If exe.dev routes an allowed model connection to GitHub based on a controllable header, the proposed gateway is insufficient. Stop and report that concrete limitation before adding a more complex design. Do not silently fall back to rootful or unrestricted workers.

### R2. Polling cannot assume a historical body snapshot

`F04b` and `F04c` own label-event identity, actor authority, and restart markers. Current issue text is not necessarily the text at label time. The adapter prototype must establish available event/version evidence and a conservative fail-closed rule for edits before collection. If GitHub cannot supply the required historical snapshot, keep that case blocked and explain the needed owner-approved contract adjustment. Never call a poll-time body a proven label-time snapshot. A marker written by anyone other than the integration bot is not controller state.

### R3. Main-owned configuration and CI need bootstrap merges

`F04a` introduces the first `.github/factory/WORKFLOW.md`. Its parser and fail-closed behavior can be tested before merge, but a valid production-main read cannot be claimed before that file lands on `main`. The root merges it under the owner's build-PR grant. Keep those live checks pending until it lands, and complete them before dispatch is enabled. Never add an untrusted candidate-config fallback merely to make the test pass.

`F07b`, `F07c`, and `F09a` own the CI trust path. The repository's only CI workflow is `.github/workflows/check.yml`, which runs the candidate's own `npm run check`. A workflow that must come from `main` cannot prove its hosted dispatch path before it exists on `main`. The root merges the bootstrap under the owner's build-PR grant after local and container proof, with the hosted boxes explicitly pending. This is an exception to the normal rule that every lane passes before merge, and it is not a claimed full pass. If that proof fails, stop the hosted path rather than run untrusted candidate workflow code as a substitute.

The gate prototype must settle test import routing, dependencies, read-only trusted files, and result ownership. F09a's one owner-merged bootstrap contains both approved `ci.yml` and `check.yml` edits. Main-backed reporter/P4 proof follows that merge, not a local-only pass. `F09a` must prove how the trusted validation result becomes a required candidate-SHA check without exposing a write credential to candidate code. After supported proof, only the owner applies the conditional two-ruleset protection policy in `docs/operations/human-review.md`. Missing or unrelated checks never pass. Branch-rule mutations require the owner's separate authorization and may need manual application if the integration lacks permission.

### R4. Public acceptance commits complicate repair secrecy

`F06b` proves the initial private suite. `F07c` proves repair isolation after publication. Once pushed to this public repository, the suite is not globally secret. The enforceable claim is that the builder and repair sessions cannot access it through their workspaces, Git history, session history, caches, tools, or allowed network. Npm package scripts and public fetch services must not become a route to GitHub. A passing initial-mount test does not settle this risk. Failed secrecy proof blocks repair rather than lowering the claim.

### R5. Ledger writes and restart effects are not automatically exactly-once

`F04c` and `F09b` own bounded crash-window tests. External writes can succeed before a local receipt exists. Markers, branch/PR identity, and run-ID ledger deduplication must reconcile actual remote state before retry. The ledger is an orphan branch, not an in-tree database. Only the controller writes it, serially and without force-push. The owner watches for missing artifacts, corrupt markers, duplicate rows, or remote advances. No distributed-controller claim is made.

### R6. Workflow and budget changes can weaken the factory

`F04a`, `F05`, and `F09b` own trusted workflow loading and cumulative accounting. `.github/factory/WORKFLOW.md` must come from the recorded main revision. Candidate changes cannot choose their own limits or gate commands. This plan's timings and token counts are proposed verification limits for tiny fixtures, not measured service guarantees. Record real baselines before tuning them. Some subscription-backed model responses may not report spend. Record unknown spend, retain token/time enforcement, and do not claim a dollar cap is enforced without a reliable price source. If a monetary cap is mandatory and cannot be evaluated, fail closed before more model work.

### R7. Linear access and historical authorization are not provisioned

`F13` owns the adapter but does not authorize a new credential, workspace, or integration. The owner must supply an approved controller-only access path and test identities. Polling history must establish readiness authority and snapshot identity. Leave Linear disabled and its live lanes blocked until those facts are proved. GitHub v1 delivery need not wait for Linear access, but unit 13 remains incomplete.

### R8. Cross-family review is incomplete until F10c

All current stages use `openai/gpt-6.1-sol`. The design's cross-family acceptance criterion remains unmet even if every behavior lane passes. `F06b` and `F08` record identities and disclosure so a later provider change does not require a new state machine. `F10c` closes this risk. It first proves one metered Anthropic call on `pi-factorio` without changing shared preferences silently. Then it moves the accept stage and one blocking review seat to an Anthropic model and records each seat's observed family in evidence. Only a run whose accept author and at least one blocking seat are cross-family records `r8: "complete"`. Until `F10c` merges, keep the incomplete cross-family label.

### R9. Human gates and real identities cannot be simulated away

`F04b`, `F09a`, `F10`, and `F13` need actual actor permissions and some owner actions. A read-only account generally cannot apply GitHub labels, while a triage account may label without write access. Use an explicitly authorized test identity rather than a forged payload for the live admission lane. Fake adapters remain unit evidence only. Owner merges, closure tests, and branch rules are real gates. Missing authorization leaves them blocked. The seven-day metric in `F12a` also needs mature evidence before a real zero-defect claim.

### R10. The plan template needs backend-specific adaptations

These are every intentional template adaptation in this document.

1. The control skill is a named CLI procedure, not a preinstalled UI automation skill. `docs/operations/factory-cli.md` arrives in `F04a`. The installed swarm skill is present and retains its real path.
2. Each live lane saves a concrete text/JSON artifact or URL list instead of a `.png`. The checker calls this a screenshot requirement but only enforces a literal `Save` path. Those artifacts prove backend behavior without invented screenshots.
3. Each review gate explicitly says that logs replace a screenshot or video. Those words satisfy the checker's literal review-block requirements. No recording or screenshot is claimed or required where it adds no evidence.
4. Until `F10c` merges, the template's cross-family reviewer language becomes context-isolated same-family seats under the owner's explicit interim model decision. The missing cross-family gate remains visible, not silently waived as passed. After `F10c`, a run records `r8: "complete"` only when its accept author and at least one blocking seat are cross-family.
5. Every PR gets a full verdict before merge, including changes without a visual interaction. This is stricter than the template's optional interaction-only review gate. The root's merge grant covered build PRs through F08. From F09a onward build PRs and runtime factory PRs both stop for the owner's merge.
6. The dependency graph is one serial chain for code writes rather than a fabricated pair of independent first PRs. Only the optional docs-only `F09d` sits beside it. `F10c` sits in the chain between `F09b` and `F10`. Shared contracts and the CI bootstrap justify that choice. Ten verifier lanes mean ten scenarios, not ten concurrent controllers on a two-vCPU VM. Read-only lanes may run concurrently, while mutation/resource-heavy scenarios use scoped fixtures and service capacity limits.
7. The `F04a` main-owned configuration and the `F07b` main-owned CI workflow must land on `main` before their main-backed proof can run. The root merges both under the owner's build-PR grant. These explicit exceptions do not create false all-green verdicts. Their main-backed boxes stay pending until the post-merge checks pass.
8. The playbook's prototype-before-plan and child investigation steps were constrained by this leaf's plan-only authorization. Existing prototypes are recorded, code was read directly, no children were launched, and unproved engineering choices became named prototype-first gates.
9. The check script is not silent on success. It always prints one box-count line per PR and a summary. The success predicate is exit code 0 and `22 PR sections, 0 problems`, with no diagnostic lines. Its source was read before writing this plan.
10. New CLI commands, runtime symbols, and paths are planned deliverables. Trunk lanes record unsupported features instead of pretending that the skeleton already runs the controller. Performance uses absolute budgets for new work rather than ratios to missing behavior.
11. `F09d` is an optional research unit that ships no product code. Its scoped adaptation replaces ten live lanes and a perf probe with one Swift Testing suite against F09c's captured feeds, an independent memo review, and `npm run check`. The checker still requires ten lane boxes and four perf boxes, so each of them says the scoped adaptation satisfies it. No `F09d` lane runs on the VM. The one feed capture on `pi-factorio` is a build step, not a lane.

### R11. Restarts use up attempts

`F04c` charges a restart during a stage as a failed attempt. With the default of 3 attempts, two badly timed restarts and one real failure end a run as failed. That charge is the safe default, because the interrupted attempt may already have spent tokens. `F09b` records interrupted attempts in each ledger row. If `F12a`'s data shows restarts end runs, revisit the charge then, not before.

### R12. Cross-family acceptance is decided and closed by F10c

`docs/design.md` item 2 requires the held-out suite to come from a different model family than the builder. Until 2026-11-02 this was an open owner decision, because the VM ran OpenAI models only and no plan unit closed the gap. On 2026-11-02 the owner allowed Anthropic models on the VM, and `F10c` moves the accept stage to an Anthropic model. A run that uses a named same-family fallback records `r8: "incomplete"` and lists it under the handoff's "Not proven" section. Before `F10c` merges, report item 2's cross-family clause as incomplete.

### R13. Loosening autonomy needs a designed ladder

This is a design note only. Each stage gets a level, `observe`, `propose`, or `act`. The effective level is the strictest of the requested level, the policy on `main`, and a `factory:hold` label. Tightening takes effect at once. Loosening takes effect only when a policy change merges to `main` with an owner-issued, single-use grant bound to that policy SHA. The controller never counts its own comments as approval. A CI check rejects a policy diff that loosens a level unless it carries the owner's label. Today `land` is `propose`, because the owner merges every PR. Build none of this before `F13`, and name no auto-merge candidate.

## Appendix D. Links and reading list

The normative product specification is [Factory design](../design.md), with chronology in [the decision trail](../decisions.tsv). [The Herdr prototype](../prototypes/herdr-on-runner.md) bounds what unit 1 proved. The skill inventory is [the synthesis](../../research/SYNTHESIS.md), with licensing in [provenance](../../research/PROVENANCE.md). Read [integration research](../../research/reports/factory-research-4.md), [validation research](../../research/reports/factory-research-5.md), and [the owner-skill audit](../../research/reports/factory-review-1.md) as supporting evidence, subject to the later owner decisions.

The coordination reference is [Symphony SPEC at be10a1b](https://github.com/openai/symphony/blob/be10a1b79df723d6d7612b5651c8522704dafb2e/SPEC.md), especially workflow loading, scheduling, workspaces, and recovery. Pi RPC implementers must read the installed `/home/g/.local/share/mise/installs/pi/1.4.0/pi/docs/rpc.md`, its command/event cross-references, and `docs/security.md` from that same Pi installation before `F05`. Read package and extension documentation there before changing extension loading. Do not infer RPC settlement behavior from process exit alone.

The installed writing skills are `/home/g/.pi/agent/npm/node_modules/pi-herdr-pstack/skills/technical-writing/SKILL.md` and `/home/g/.pi/agent/npm/node_modules/pi-herdr-pstack/skills/unslop/SKILL.md`. Cleanup uses `/home/g/.pi/agent/npm/node_modules/pi-herdr-pstack/skills/no-comments/SKILL.md`.

Use `/home/g/.pi/agent/npm/node_modules/pi-herdr-pstack/skills/how/SKILL.md` before `F04a`, `F04c`, `F05`, `F07b`, `F07c`, `F09a`, and `F13` to explain the affected ownership and trust boundaries. Use `/home/g/.pi/agent/npm/node_modules/pi-herdr-pstack/skills/interrogate/SKILL.md` for their adversarial review and for `F06b`, `F08`, and `F09b`. The root runs any delegated lanes. Leaf implementers do not launch grandchildren. Same-family reviews use the disclosed limitation in R8.

Keep future execution trails per `/home/g/.pi/agent/npm/node_modules/pi-herdr-pstack/skills/show-me-your-work/SKILL.md` in each retained owner's uncommitted `decisions.tsv`, with a root trail linking those files. This plan-authoring task writes only this plan, not a second trail. The runtime's `factory/ledger` is a product feature, not a substitute for implementation decision trails.

Read the existing code and callers before each edit. `src/run.ts` owns `Run`, `Progress`, `Verdict`, and digests. `src/stages.ts` owns `advance`, stage order, and the shared two-round repair cap. `src/policy.ts` owns admission, fail-closed switch parsing, forbidden paths, and the current digest-only handoff precondition. `src/tickets.ts` currently has `fetch`, not polling methods. `extension/index.ts` currently registers only `/factory status`. `test/pipeline.test.ts` exercises the pure core through `test/fake-ticket-adapter.ts`, not a service. `server/provision.sh` sets the default model and installs Pi/Herdr packages but does not implement the sandbox or controller.

The plan checker command is `node /home/g/.pi/agent/npm/node_modules/pi-herdr-pstack/skills/poteto-mode/scripts/check-plan.mjs docs/plans/factory-v1.md`. Its successful stdout contains counts by design. Preserve that output in the handoff rather than suppressing it to imitate a silent check.
