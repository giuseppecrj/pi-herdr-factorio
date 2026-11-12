# Make the codebase describe its ownership plan

Reorganize `nublai/pi-herdr-factorio` around factory rules in `src/` and host execution in `host/`.
Deliver the owner's option C, chosen on 2026-11-11, including the navigation and initialization work from A and B.
Preserve behavior, serialized bytes, authorization, exact-head checks, cumulative budgets, and command names.
Use L00 to L21, with the independent initialization rounds shown below.
This is a plan against `5bd77d572cb2bccc9c1e636c0bbe56f086658a56`, not permission to execute it.

## How to read this

One box is one unit of work. Every box names the evidence that checks it. A nested box is a sub-step of the box above it. Check a box only when its evidence exists, a file, a log line, a test run, or a SHA. The body is a how-to. The appendices explain and record.

The program runs the poteto-mode playbook `playbooks/autopilot-stack.md`. The owner lands every PR, L00 to L21. There is no standing merge grant. Stop each PR at STACK-READY. The existing factory program remains separate and paused during this migration.

Use `<pstack>` for the installed `pi-herdr-pstack` package root. Resolve it through the installed skill inventory at execution time and record its version in the private trail. All `<pstack>/skills/.../SKILL.md` references below identify installed skills without pinning a workstation path.

Use `.pi/skills/verify-factory/SKILL.md` as the control skill. Its commands drive the CLI, registered extension handler, native sandbox, and authorized VM reads. New checks and paths below are deliverables, not tools available at the planning base. Appendix C adapts the live lanes to a refactor rather than ten model-driven tickets per PR.

Tests alone are not sufficient verification. A PR is verified only when its unit, live, and perf boxes are all checked.

## Program checklist

### Arm the program

- [ ] State the protocol and this plan to the operator, then stop. Start execution only on the operator's explicit go. Record separate grants for local commits, managed worktrees, pushes, ready PRs, trusted edits, VM reads, disposable VM creation and deletion, fixture writes, model spend, and production upgrade. This plan grants none of them.
- [ ] Confirm the sole coordinator and the current held state before the first move. Factory dispatch stays paused throughout L00 to L20. `pi-factorio` is held at its old commit, reported as `349934b` in the audit. `nubl-factory` is about to receive a held install at `5bd77d5`. Verify these reported facts under a read grant rather than treating installation intent as proof. Inventory unfinished runs before source moves. A hold does not stop observation or in-flight work. If any run could cross the layout boundary, obtain the owner's drain/stop action before L05 and retain its private evidence.
- [ ] Read these from the installed skill directories at program start. Re-read them at every audit.
  - [ ] Read `<pstack>/skills/poteto-mode/playbooks/autopilot-stack.md` and its referenced `autopilot-full.md`. The stack playbook's no-merge rule governs this program.
  - [ ] Read the swarm skill at `<pstack>/skills/swarm/SKILL.md`.
  - [ ] Read the control skill at `.pi/skills/verify-factory/SKILL.md` and its feature index.
  - [ ] Read `<pstack>/skills/poteto-mode/playbooks/opening-a-pr.md`, `playbooks/shipping.md`, and `playbooks/refactoring.md`.
  - [ ] Read the leaf skills in Appendix D and their relevant references before using them.
- [ ] Run a report-only `/setup-pstack` before delegation. Resolve task categories from the live authenticated catalog. Set each child's exact model and supported thinking level explicitly. Shared preference changes require the supported approval flow, not repository configuration edits.
- [ ] Obtain the owner's explicit maintenance-transition approval. Human-authored layout PRs use ordinary exact-head `check` and compatibility CI. They are not factory-certified candidates against old-main tests. Keep old-main incompatibility evidence visible, run the head-owned gate locally before landing, and finish the main-backed gate after landing before the next dependent move. Do not weaken trusted tests or retain old import paths to hide the transition.
- [ ] Run the audit at every child delivery, at every stall or no-progress advisory, and on the operator's request. Nothing schedules it, so never promise a timed cadence and never leave the audit to memory.
- [ ] Use this audit prompt, verbatim. "Re-read the execution playbook. Audit the operation against it and fix drift in this audit. Check every active lane and judge progress by side effects only. Cancel a stuck lane and launch its fresh replacement now. Then post a short status message to the operator in chat only when the audit found a tracked change that no earlier status message reported, such as a PR opened, a code-ready head, a round launched or closed, a verdict, a merge, a stuck agent and the action taken, a blocker added or cleared, or a decision only the operator can make. Name every such change and nothing else. Do not repeat a table, the merged list, or an unchanged blocker. If the audit found none, end the turn with no reply text. Either way, log this audit's row in your decision trail. The row names the items reported, or none."
- [ ] On the operator's hold or stand-down, cancel every running child with `subagent_cancel` at once and launch nothing new. Preserve retained work and report any fixture cleanup that still needs authorization.

### Launch owner rounds

- [ ] Give each PR one owner role with the full lifecycle the execution playbook names. Each round is a fresh bare leaf child, with `fork: false`, a bounded brief, explicit model and thinking, and a commit policy. The root owns integration, topology, verification, and acceptance.
- [ ] Follow this dependency graph. Start dependent work after its parent merges, or base it on the parent's committed branch under the stack playbook. Never set an upstream to `origin/main`.
  - [ ] Start L00 alone from `main`. It protects every later move.
  - [ ] Start L01, L02, and L04 after L00. These are parallel group P1, with disjoint files. L01 owns entry instructions and plans, L02 owns the existing verification skill, and L04 owns the new formal-maintenance skill.
  - [ ] Start L03 after L01, L02, and L04. It integrates check coverage for their maintained TypeScript. Start L05 after L03.
  - [ ] Follow the serial source chain L05, L06, L07, L08, L09, L10. Then follow the split chain L11, L12, L13, L14, L15, L16, L17.
  - [ ] Start L18 after L17 and the owner's disposable-VM grant. Start L19 after L18's main-backed and held-upgrade proofs. Start L20 after L19. Start L21 after L20 and all pending native and main-backed proofs.
  - [ ] Keep code writers serial because import consumers, layout checks, and giant tests overlap. Read-only gates and independent audits form parallel group P2 for every PR. Serialize resource-heavy native and perf runs. No ten-controller fan-out on one VM.
- [ ] Hold the file boundaries in each Files block. For a move, generate an exact caller list before launch from imports, literal paths, maintained probes, and current citations. Attach that list to the brief. The shared migration allowance below permits reference-only changes, not unrelated edits to those files.
- [ ] Use the shared migration allowance for L05 to L20 only. Update import specifiers and path literals in `src/**`, `server/**` until L18, `host/**` from L18, `extension/index.ts`, non-held-out `test/**`, maintained `.pi/skills/**`, `scripts/**`, `docs/statecharts/**` until L20, `docs/models/**` from L20, `docs/operations/**`, the active plans, root and directory READMEs, `AGENTS.md`, and `DESIGN.md`. Update layout guards and their path inventory in the same wave. Also update the still-maintained `docs/prototypes/**` programs listed by L00, until L20 moves them beside verify-factory. For `test/fixtures/gate-cheating/**`, allow only relocation of patch targets and matching context, with the same planted behavior and expected rejection. Prove each patch applies before judging it. Rewrite no historical experiment payload. No `.github/**` or `test/acceptance/**` edit follows from this allowance.
- [ ] Keep current docs correct in every PR, not only in L20. Change current citations when their code moves. Use revision-pinned links for historical claims. Record old-to-new paths in the migration inventory. Leave `docs/decisions.tsv` byte-identical except authorized coordinator appends.
- [ ] Hold the review gate. None of L00 to L21 changes an interaction, so none is interaction review-gated. Exact-head independent technical review and the owner's landing remain mandatory.
- [ ] Run `how` before each split and `architect` before a split crosses a function boundary. Reuse the six-explorer audit and settled target instead of reopening option C. Bound each new exploration to the affected module and one characterization design. Bring only consequential product changes to the owner.

### PR mechanics, for every PR

- [ ] Use `gh` for every PR operation. Confirm `gh auth status` and the repository once under the intended identity. Never require Graphite or set `GH_HOST` locally.
- [ ] Open each PR ready, never draft, per Opening a PR, only under the grant that names PR creation. Use `gh pr create --base <base-branch>`. A stack child targets its parent branch.
- [ ] Run `npm run check` before every PR-facing push. It includes lint, typecheck, format, unit tests, and integration tests. Push with hooks on under the push grant, using the checked-push helper or an explicit `HEAD:refs/heads/<branch>`.
- [ ] Run a manual diff cleanup pass before each commit and `/skill:no-comments` before review. Keep required `SAFETY:` comments. Apply technical-writing and unslop to prose.
- [ ] Triage every Bugbot and security-reviewer comment per `<pstack>/skills/poteto-mode/references/bugbot-triage.md`. Report unavailable integrations as unavailable.
- [ ] Rebase onto current trunk before the code-ready report and babysit, retaining the stack parent where needed. Keep that merge base in fix rounds. Rebase again only at merge prep, on a `git merge-tree` conflict with trunk, on a CI failure caused by trunk, or when a known overlapping change lands. Only the root rewrites topology.
- [ ] Pin behavior before every split. Commit the characterization first, prove it passes on the parent, then split without changing expected results. For pure moves, retain the full suite and layout guards. Report executed test names, per-file counts, pass/fail/skip/todo counts, and the move map on parent and head. An added pin increases the expected count explicitly. No test may disappear or run twice.

### Verdict and merge, for every PR

- [ ] At the code-ready head SHA and at each later push that changes the patch, run the swarm per `<pstack>/skills/swarm/SKILL.md`. The root launches lanes per `references/fan-out.md`. Use one gates lane, ten verifier lanes on `task:qa`, and the perf lane. Two or more audit lanes read the full brief, diff, and receipts, with separate trust-boundary and behavior-parity focuses. Choose exact authenticated review models from a different provider and family than the author. The root audits the receipts before the verdict.
- [ ] Clean only when every required lane is `PASS`. A defect filed as a note is a finding. Batch corrections into one fix round. After that round, block only for a user-hit bug, a failed gate, or a wrong shipped doc. File the remainder as one follow-up under an issue grant. A minor fix gets one affected verifier and wording alone gets none. Carry evidence only under the execution playbook and the patch-id rule in `playbooks/shipping.md`.
- [ ] Record a pre-merge maintenance verdict separately from the post-merge main-backed verdict. Missing native evidence is BLOCKED, never a local substitute. The sole bootstrap exception is the old-baseline transition approved at Arm the program. L18 still requires its real throwaway upgrade before landing, and L21 cannot resume until all post-merge gates pass.
- [ ] Stop at STACK-READY with the exact head, base, patch-id, checks, findings, and pending bootstrap evidence. The owner squash-merges with `gh pr merge --squash --match-head-commit <sha>` after a verdict comment, green `check`, and clean merge-tree. No agent merges or arms auto-merge. Re-run CI and mergeability after rewritten pushes under `playbooks/shipping.md`. Branch and worktree cleanup needs its own grant.

### Boot recipe, for every live lane

- [ ] Fetch and check out the exact head only under the read/network grant. Record the parent and head SHAs. Use isolated local clones and state beneath `$HOME/.herdr/tmp/`, or managed worktrees beneath `$HOME/.herdr/worktrees/`. Never reuse production state as writable test state.
- [ ] Run maintained CLI and extension commands from that checkout. Until L18 use `node --experimental-strip-types server/cli.ts`; from L18 use `node --experimental-strip-types host/cli/index.ts`. Keep verbs, flags, outputs, and exit codes unchanged. For read comparisons, copy saved state, fix the clock where the supported test entry permits it, and use a read-only GitHub fixture transport. Byte-compare output without removing arbitrary fields. Record unavoidable clock/process fields separately.
- [ ] Start a held scoped controller only in an authorized disposable environment, using the control skill and isolated issue scope. Wait for the actual `event=controller_ready`, not a file timestamp or a fixed sleep. A hold blocks dispatch but not observation. Keep production stopped if a lane can observe the same repository's mutable markers. Use a denied-egress local transport for model-free startup tests. Label that local evidence, not native VM qualification.
- [ ] For native isolation, run `FACTORY_REQUIRE_SANDBOX_TESTS=1 npm run check` on a capable authorized host. Missing bwrap, user namespaces, user bus, or bundle yields BLOCKED. Do not install tools without authorization. Run the trusted reporter at concurrency 2 under both umask 022 and 077, using the runner's discovered files and never passing aggregated cases twice.
- [ ] For the candidate-gate lane, run parent-owned gates against head and retain the incompatibility result. Also run the head-owned `gates` CLI against a disposable candidate with the same layout, retaining real test execution, checks, and the receipt. After the owner lands the PR, repeat against the new trusted `main`. Never pass candidate-owned tests off as old-main certification. Use local committed fixture revisions from the granted execution work, not public fixture issues unless separately granted.
- [ ] Use explicit `FACTORY_VM=pi-factorio` only for authorized read-only doctor, version, status, and hold reads. Do not upload head, start a lane controller there, provision, or upgrade it. Reuse the unchanged read receipt across code-only rounds. If retirement makes it unavailable, obtain an owner-approved replacement read target before claiming that lane complete. Never make `nubl-factory` the default verification target.
- [ ] Save each lane's commands, timestamps, SHAs, expected and actual results, exit codes, and redacted logs under `$HOME/.herdr/tmp/swarm-<pr-id>/worker-<n>/` locally, or `/tmp/swarm-<pr-id>/worker-<n>/` on the disposable VM. Return the paths. The coordinator copies durable receipts to the private trails before authorized cleanup. Logs replace screenshots for these unchanged text interfaces.
- [ ] Measure perf on an otherwise idle identical machine and dependency set. Record trunk first, then interleave three trunk/head pairs. Time `npm run check` and process launch to the real `controller_ready` event separately. Require zero model requests. Fail if head median check duration exceeds trunk by both 20 percent and 10 seconds, or startup exceeds trunk by both 20 percent and 250 ms. Existing project deadlines still apply. Proposed regression thresholds require owner acceptance at Arm the program. Never raise an existing budget to pass this plan.

## Install navigation and path guards (L00)

**Depends on.** None. Phase 0.

**Files.**

- [ ] Create `src/README.md`, `server/README.md`, `test/README.md`, `docs/README.md`, `scripts/README.md`, `.pi/README.md`, `.pi/skills/README.md`, `extension/README.md`, `tools/README.md`, and `research/README.md`. Edit root `README.md` and `skills/README.md` only for the ownership map.
- [ ] Create `scripts/check-layout.mjs`, `scripts/layout-baseline.json`, and `test/layout.test.ts`. Edit `package.json` to run the guard. Fix current broken citations in `docs/operations/**` and `docs/plans/factory-v1.md`. Add historical banners to `docs/handoff.md` and prototype index pages without changing recorded evidence.
- [ ] Have the owner, or coordinator under a specific grant, add `.github/README.md`. No other trusted file changes in L00.

**Build.**

- [ ] Build one small guard using the existing TypeScript parser, filesystem checks, and behavior tests. Resolve import, export, type-import, and literal dynamic-import edges. Start with the measured 23 `src` to `server` file-pair edges in 16 files, and reject any edge outside the exact shrinking allowlist. Include future `host` edges in the same rule. Document that host may depend on src, src may not depend on host, core holds portable contracts, and sibling domain imports name their owner directly rather than traversing a barrel.
- [ ] Reject tests outside runner discovery, excluding non-executable fixture data and the separately dispatched acceptance directory explicitly. Require each `.cases.ts` exactly once through one aggregator, never also as a runner entry. Check every maintained first-party top-level folder for a README, including hidden `.pi` and owner-controlled `.github`.
- [ ] Pin all current high-risk path branches through `reviewSeats`, not regex text alone. Assert the matched files exist and keep their seats. Each extracted implementation file inherits its source file's required seats through the move map. Exercise `replayStageCaps` for all four constants at the baseline and candidate revision.
- [ ] Check actual CLI/controller repository roots, `SOURCE` and `BUNDLE_PATHS` entries, gate materializer byte identity paths, gateway child entry, draft reporter resolution, provisioning depth, installer re-execution, service entry, verification-script targets, and the acceptance prompt depth. Use actual readers or child entry smoke tests where available. BUNDLE_PATHS contains a script as well as directories, so check each entry by its expected kind.
- [ ] Check existing in-range `file:line` citations in operations and active plans. Support explicit revision-pinned history and the documented prototype alias rather than silently ignoring broken references. Reject new broken citations immediately. Run negative controls for every guard before declaring this prerequisite complete. Inventory every still-executed prototype and its transitive helpers in the layout baseline. That maintained list receives reference updates with each source move, before L20 relocates it.

**You see.**

- [ ] A planted missing root, unrun test, extra dependency edge, or lost review seat fails the guard before any move.

**Verify, unit.** Tests alone are not sufficient verification. A PR is verified only when its unit, live, and perf boxes are all checked.

- [ ] Add negative controls in `test/layout.test.ts` for each listed hazard. Run `npm run check`, the new guard, and the existing factory plan checker, which must still report 22 sections and zero problems.

**Verify, live.** Tests alone are not sufficient verification. A PR is verified only when its unit, live, and perf boxes are all checked. Ten lanes on `task:qa` at the PR head, per the boot recipe.

- [ ] Lane 1. Regression lane against trunk. Run `npm run check` on parent and head with the same native-test setting. Save `check-pair.log`. Pass when both pass, or a pre-existing failure is reproduced and reported as BLOCKED rather than hidden.
- [ ] Lane 2. Compare executed test names and counts using the trusted reporter and the PR move map. Save `test-counts.json`. Pass when every original test runs once, with each added pin accounted for and no unexplained skip.
- [ ] Lane 3. Mutate an allowed import and add a new reverse edge in a scratch copy. Save `edges.json`. Pass when the existing baseline passes and the added edge fails.
- [ ] Lane 4. Plant nested and colocated executable tests and duplicate a cases import. Save `discovery.json`. Pass when all three negative controls fail and the current suite runs once.
- [ ] Lane 5. Exercise every high-risk branch and all four replay cap lookups. Save `routing-caps.json`. Pass when the recorded seats and caps match the parent.
- [ ] Lane 6. Resolve repository, materializer, gateway, reporter, provisioner, and installer paths. Save `entrypaths.json`. Pass when each points at the real expected file or root.
- [ ] Lane 7. Check README coverage and current citations, then plant a missing path and an out-of-range line. Save `navigation.json`. Pass when the real tree passes and both planted citations fail.
- [ ] Lane 8. Read a saved-state status and owner feed on parent and head. Save `outputs.json`. Pass when the bytes and private-state hashes agree.
- [ ] Lane 9. Run the maintained path and command checks touched by this PR, including their stated negative controls. Save `commands.log`. Pass when the documented commands resolve and negative controls reject for their intended reasons, not setup errors.
- [ ] Lane 10. Read the held pi-factorio revision/status through verify-factory under its read grant, or cite a still-valid unchanged receipt. Save `retiring-host.json`. Pass when no write or upgrade occurs and the read result is explicitly old-revision evidence, never head qualification. An unavailable retired host needs the owner-approved replacement read described in the boot recipe.

**Verify, perf.** Tests alone are not sufficient verification. A PR is verified only when its unit, live, and perf boxes are all checked.

- [ ] Metric. Measure process start to `controller_ready` and `npm run check` elapsed time on parent and head. Count model requests separately.
- [ ] Probe. Use the boot recipe on identical isolated held state and dependencies, interleaving three parent/head pairs. Save `perf.json` with raw samples and medians.
- [ ] Baseline. Record the parent startup and check durations before head measurements. For prose-only changes, reuse a valid runtime-identical baseline with the compared blob identities recorded.
- [ ] Rule. Fail if median check time rises by both 20 percent and 10 seconds, startup rises by both 20 percent and 250 ms, an existing deadline fails, or the probe calls a model. Missing readiness or native capacity is BLOCKED, not a zero-duration pass.

**Review gate.** None. L00 is not review-gated.

**Merge.**

- [ ] Record the root's exact-head verdict and complete Bugbot triage. Bind evidence to head, parent, and patch-id.
- [ ] Apply the patch-id rule in `playbooks/shipping.md` at merge prep. Confirm green exact-head CI and clean `git merge-tree`.
- [ ] Hand L00 to the owner as STACK-READY. The owner lands it. Complete any main-backed transition check before its dependent PR proceeds.

## Route agents and preserve decision history (L01)

**Depends on.** L00. Phase 1. Parallel group P1.

**Files.**

- [ ] Edit `AGENTS.md` and `docs/plans/factory-v1.md`, `docs/plans/exmach-move.md`, `docs/plans/factorio-vm.md`, and this plan only for portable installed-skill references and routing.
- [ ] Create `scripts/check-decisions.mjs` and `test/decisions-format.test.ts`. Do not edit `docs/decisions.tsv`. L03 wires the new check into aggregate commands.

**Build.**

- [ ] Shorten AGENTS to purpose, program routing, authority, placement rules, and per-path checks. Name autopilot-stack for this layout program without replacing the historical factory playbook. Link the plan and verification skill instead of repeating their procedures.
- [ ] Validate the exact six-column TSV header, row arity, timestamps, and a byte-identical prefix against the trusted base. Permit existing free-text phase values. Require coordinator-only appends through the installed show-me-your-work `log.sh`. Never reserialize old rows.
- [ ] Replace workstation paths in all tracked plans with `<pstack>`, `$HOME`, or a documented repo-relative reference. Retain historical grants, evidence status, and all 22 factory PR sections.

**You see.**

- [ ] A cold agent finds the correct program, destination folder, and checks without reading an obsolete handoff as instructions.

**Verify, unit.** Tests alone are not sufficient verification. A PR is verified only when its unit, live, and perf boxes are all checked.

- [ ] Run `test/decisions-format.test.ts` against a valid append, a truncated row, and a one-byte historical edit. Run all three existing plan checkers and this plan checker. Run `npm run check`.

**Verify, live.** Tests alone are not sufficient verification. A PR is verified only when its unit, live, and perf boxes are all checked. Ten lanes on `task:qa` at the PR head, per the boot recipe.

- [ ] Lane 1. Regression lane against trunk. Run `npm run check` on parent and head with the same native-test setting. Save `check-pair.log`. Pass when both pass, or a pre-existing failure is reproduced and reported as BLOCKED rather than hidden.
- [ ] Lane 2. Compare executed test names and counts using the trusted reporter and the PR move map. Save `test-counts.json`. Pass when every original test runs once, with each added pin accounted for and no unexplained skip.
- [ ] Lane 3. Validate the real decisions file and a valid appended scratch row. Save `trail.json`. Pass when the real file and append pass with the original prefix intact.
- [ ] Lane 4. Change one old byte and truncate one TSV row in scratch copies. Save `trail-negative.json`. Pass when both copies fail.
- [ ] Lane 5. Resolve every installed-skill reference using the recorded package root. Save `skill-links.json`. Pass when all named files resolve without a workstation path.
- [ ] Lane 6. Run the four plan checkers. Save `plans.log`. Pass when all report zero problems and factory-v1 retains 22 sections.
- [ ] Lane 7. Trace a candidate change and a host change through AGENTS placement rules. Save `routing.md`. Pass when the routes agree with the actual folders and grants.
- [ ] Lane 8. Compare parent/head registered extension status. Save `status.json`. Pass when routing prose changes no handler output.
- [ ] Lane 9. Run the maintained path and command checks touched by this PR, including their stated negative controls. Save `commands.log`. Pass when the documented commands resolve and negative controls reject for their intended reasons, not setup errors.
- [ ] Lane 10. Read the held pi-factorio revision/status through verify-factory under its read grant, or cite a still-valid unchanged receipt. Save `retiring-host.json`. Pass when no write or upgrade occurs and the read result is explicitly old-revision evidence, never head qualification. An unavailable retired host needs the owner-approved replacement read described in the boot recipe.

**Verify, perf.** Tests alone are not sufficient verification. A PR is verified only when its unit, live, and perf boxes are all checked.

- [ ] Metric. Measure process start to `controller_ready` and `npm run check` elapsed time on parent and head. Count model requests separately.
- [ ] Probe. Use the boot recipe on identical isolated held state and dependencies, interleaving three parent/head pairs. Save `perf.json` with raw samples and medians.
- [ ] Baseline. Record the parent startup and check durations before head measurements. For prose-only changes, reuse a valid runtime-identical baseline with the compared blob identities recorded.
- [ ] Rule. Fail if median check time rises by both 20 percent and 10 seconds, startup rises by both 20 percent and 250 ms, an existing deadline fails, or the probe calls a model. Missing readiness or native capacity is BLOCKED, not a zero-duration pass.

**Review gate.** None. L01 is not review-gated.

**Merge.**

- [ ] Record the root's exact-head verdict and complete Bugbot triage. Bind evidence to head, parent, and patch-id.
- [ ] Apply the patch-id rule in `playbooks/shipping.md` at merge prep. Confirm green exact-head CI and clean `git merge-tree`.
- [ ] Hand L01 to the owner as STACK-READY. The owner lands it. Complete any main-backed transition check before its dependent PR proceeds.

## Repair the verification feature map (L02)

**Depends on.** L00. Phase 1. Parallel group P1.

**Files.**

- [ ] Edit `.pi/skills/verify-factory/SKILL.md`, `features/README.md`, and `features/{factory-status,acceptance,specify,build,replay,review,validation,viewer}.md`. Add `features/installer.md`. No script behavior or target default changes.

**Build.**

- [ ] Index replay and normalize the eight named files to exactly four H2 sections in order. Use Sub-features, How to get to it (user POV), Driving it with the named CLI tooling, and Gotchas.
- [ ] Cover installer preflight, fresh held install, same-SHA rerun, upgrade, failure stop, and fresh hold proof. Select `nubl-factory` explicitly for authorized reads only. Keep installation and production qualification distinct.
- [ ] Document which existing probes remain maintained and which commands mutate GitHub or call models. Mark read-only pi-factorio evidence as old-revision evidence, never head qualification.

**You see.**

- [ ] The feature index lists every recipe once and the installer recipe cannot imply permission to deploy.

**Verify, unit.** Tests alone are not sufficient verification. A PR is verified only when its unit, live, and perf boxes are all checked.

- [ ] Check feature-index equality, heading order, helper paths, and shell syntax. Run `npm run check`; do not claim full install proof from prose.

**Verify, live.** Tests alone are not sufficient verification. A PR is verified only when its unit, live, and perf boxes are all checked. Ten lanes on `task:qa` at the PR head, per the boot recipe.

- [ ] Lane 1. Regression lane against trunk. Run `npm run check` on parent and head with the same native-test setting. Save `check-pair.log`. Pass when both pass, or a pre-existing failure is reproduced and reported as BLOCKED rather than hidden.
- [ ] Lane 2. Compare executed test names and counts using the trusted reporter and the PR move map. Save `test-counts.json`. Pass when every original test runs once, with each added pin accounted for and no unexplained skip.
- [ ] Lane 3. Compare the feature index with every feature file. Save `feature-index.json`. Pass when there are no missing, duplicate, or dead entries.
- [ ] Lane 4. Check the eight repaired entries and installer heading order. Save `headings.json`. Pass when each follows the four-section contract.
- [ ] Lane 5. Resolve replay commands against the real replay CLI help. Save `replay-help.log`. Pass when verbs and arguments agree.
- [ ] Lane 6. Inspect build, acceptance, and validation probe paths. Save `probe-links.json`. Pass when each maintained probe exists and its caller is named.
- [ ] Lane 7. Drive the registered status handler through its maintained helper in an isolated checkout. Save `status.log`. Pass when the handler returns the expected package and stage table.
- [ ] Lane 8. Check installer recipe against actual --check and install control flow. Save `installer-review.md`. Pass when the recipe preserves explicit target, hold, no-model preflight, and separate VM grants.
- [ ] Lane 9. Run the maintained path and command checks touched by this PR, including their stated negative controls. Save `commands.log`. Pass when the documented commands resolve and negative controls reject for their intended reasons, not setup errors.
- [ ] Lane 10. Read the held pi-factorio revision/status through verify-factory under its read grant, or cite a still-valid unchanged receipt. Save `retiring-host.json`. Pass when no write or upgrade occurs and the read result is explicitly old-revision evidence, never head qualification. An unavailable retired host needs the owner-approved replacement read described in the boot recipe.

**Verify, perf.** Tests alone are not sufficient verification. A PR is verified only when its unit, live, and perf boxes are all checked.

- [ ] Metric. Measure process start to `controller_ready` and `npm run check` elapsed time on parent and head. Count model requests separately.
- [ ] Probe. Use the boot recipe on identical isolated held state and dependencies, interleaving three parent/head pairs. Save `perf.json` with raw samples and medians.
- [ ] Baseline. Record the parent startup and check durations before head measurements. For prose-only changes, reuse a valid runtime-identical baseline with the compared blob identities recorded.
- [ ] Rule. Fail if median check time rises by both 20 percent and 10 seconds, startup rises by both 20 percent and 250 ms, an existing deadline fails, or the probe calls a model. Missing readiness or native capacity is BLOCKED, not a zero-duration pass.

**Review gate.** None. L02 is not review-gated.

**Merge.**

- [ ] Record the root's exact-head verdict and complete Bugbot triage. Bind evidence to head, parent, and patch-id.
- [ ] Apply the patch-id rule in `playbooks/shipping.md` at merge prep. Confirm green exact-head CI and clean `git merge-tree`.
- [ ] Hand L02 to the owner as STACK-READY. The owner lands it. Complete any main-backed transition check before its dependent PR proceeds.

## Check repository-maintenance TypeScript (L03)

**Depends on.** L01, L02, and L04. Phase 1 integration.

**Files.**

- [ ] Edit `package.json`, `tsconfig.json`, `.oxlintrc.json`, `biome.json`, `.pi/skills/verify-factory/scripts/{status-driver.ts,drive-status.sh}`, `server/gates.ts`, `test/candidate-gates.test.ts`, and `test/extension.test.ts`. Add focused maintenance-driver tests under `test/`.
- [ ] Have the owner edit `.github/factory/gates/gates.json` lint and format roots in this PR only, adding maintained `.pi/skills` coverage while retaining the exact held-out ignore.

**Build.**

- [ ] Make status-driver import the extension from its actual checked-in location and remove root-copy execution from drive-status. Type the adapter against the extension contract without chained assertions. Pin handler output before changing this convention.
- [ ] Include maintained `.pi/skills/**/*.ts` in typecheck, lint, and format. Exclude private sessions, loops, and daily logs. Materialize only `.pi/skills` into candidate gate trees, not all `.pi`. Do not classify its Markdown as skipped documentation if it belongs to the maintained skill tree.
- [ ] Wire the layout and decision-format checks into `npm run check`. Keep existing tests last where their guard expects it. Prove a seeded maintained TypeScript error fails ordinary CI and the head-owned trusted gate.

**You see.**

- [ ] The status driver runs where it lives and a broken maintained skill cannot pass either check path.

**Verify, unit.** Tests alone are not sufficient verification. A PR is verified only when its unit, live, and perf boxes are all checked.

- [ ] Pin status handler output in `test/extension.test.ts` first. Test candidate materialization and planted type/lint errors. Run `npm run check` and trusted-reporter checks.

**Verify, live.** Tests alone are not sufficient verification. A PR is verified only when its unit, live, and perf boxes are all checked. Ten lanes on `task:qa` at the PR head, per the boot recipe.

- [ ] Lane 1. Regression lane against trunk. Run `npm run check` on parent and head with the same native-test setting. Save `check-pair.log`. Pass when both pass, or a pre-existing failure is reproduced and reported as BLOCKED rather than hidden.
- [ ] Lane 2. Compare executed test names and counts using the trusted reporter and the PR move map. Save `test-counts.json`. Pass when every original test runs once, with each added pin accounted for and no unexplained skip.
- [ ] Lane 3. Run the status driver without copying it to repository root. Save `driver.log`. Pass when it resolves the extension and matches pinned output.
- [ ] Lane 4. Plant a type error in a maintained .pi script. Save `type-negative.log`. Pass when both ordinary and head-owned gate typechecks fail.
- [ ] Lane 5. Plant a lint violation in the same checked scope. Save `lint-negative.log`. Pass when both lint paths reject it.
- [ ] Lane 6. Inspect the materialized candidate tree. Save `pi-tree.json`. Pass when maintained skills are copied and private state is absent.
- [ ] Lane 7. Inspect held-out exclusions and run a negative isolation case. Save `exclusions.json`. Pass when test/acceptance remains excluded and never becomes visible input.
- [ ] Lane 8. Run decision-prefix and layout checks through npm run check. Save `aggregate.log`. Pass when the aggregate command executes both new guards.
- [ ] Lane 9. Run the real head-owned candidate gate and required native sandbox checks per the boot recipe. Save `native-gate.log`. Pass when every required test runs, the receipt is complete, and old-main transition evidence remains separately labeled.
- [ ] Lane 10. Read the held pi-factorio revision/status through verify-factory under its read grant, or cite a still-valid unchanged receipt. Save `retiring-host.json`. Pass when no write or upgrade occurs and the read result is explicitly old-revision evidence, never head qualification. An unavailable retired host needs the owner-approved replacement read described in the boot recipe.

**Verify, perf.** Tests alone are not sufficient verification. A PR is verified only when its unit, live, and perf boxes are all checked.

- [ ] Metric. Measure process start to `controller_ready` and `npm run check` elapsed time on parent and head. Count model requests separately.
- [ ] Probe. Use the boot recipe on identical isolated held state and dependencies, interleaving three parent/head pairs. Save `perf.json` with raw samples and medians.
- [ ] Baseline. Record the parent startup and check durations before head measurements. For prose-only changes, reuse a valid runtime-identical baseline with the compared blob identities recorded.
- [ ] Rule. Fail if median check time rises by both 20 percent and 10 seconds, startup rises by both 20 percent and 250 ms, an existing deadline fails, or the probe calls a model. Missing readiness or native capacity is BLOCKED, not a zero-duration pass.

**Review gate.** None. L03 is not review-gated.

**Merge.**

- [ ] Record the root's exact-head verdict and complete Bugbot triage. Bind evidence to head, parent, and patch-id.
- [ ] Apply the patch-id rule in `playbooks/shipping.md` at merge prep. Confirm green exact-head CI and clean `git merge-tree`.
- [ ] Hand L03 to the owner as STACK-READY. The owner lands it. Complete any main-backed transition check before its dependent PR proceeds.

## Wrap the existing bounded model checks (L04)

**Depends on.** L00. Phase 1. Parallel group P1.

**Files.**

- [ ] Create only `.pi/skills/verify-factory-state/SKILL.md` and its small coverage and command references. Use existing `docs/statecharts/**` and runtime correspondence code unchanged.

**Build.**

- [ ] Wrap the existing bounded checks without adding properties or a new proof program. Record model/config hashes, the checked runtime revision, source correspondence, limits, and which evidence is historical.
- [ ] Expose the existing F1 structural check, the four F3 witnesses, and the F4 runtime replay as separate procedures. Keep F2 and incomplete accounting/controller work explicit. Use the documented bounds and stop rules, never a new exhaustive-completion gate.
- [ ] Require explicit authorization for a missing checker install. Verify the procedure with one existing bounded check and one existing deliberately false witness. Retain the trace and expected exit, not just a process success claim.

**You see.**

- [ ] A maintainer can rerun a bounded check without mistaking a witness failure or timeout for a safety pass.

**Verify, unit.** Tests alone are not sufficient verification. A PR is verified only when its unit, live, and perf boxes are all checked.

- [ ] Validate skill links and command paths. Run the existing F4 replay and one bounded check plus its existing witness if tooling is available. Missing tooling blocks that evidence, not a reason to install it silently. Run `npm run check`.

**Verify, live.** Tests alone are not sufficient verification. A PR is verified only when its unit, live, and perf boxes are all checked. Ten lanes on `task:qa` at the PR head, per the boot recipe.

- [ ] Lane 1. Regression lane against trunk. Run `npm run check` on parent and head with the same native-test setting. Save `check-pair.log`. Pass when both pass, or a pre-existing failure is reproduced and reported as BLOCKED rather than hidden.
- [ ] Lane 2. Compare executed test names and counts using the trusted reporter and the PR move map. Save `test-counts.json`. Pass when every original test runs once, with each added pin accounted for and no unexplained skip.
- [ ] Lane 3. Resolve the documented checker and record its version. Save `checker.json`. Pass when the tool matches the documented version or the mismatch is blocked.
- [ ] Lane 4. Run the existing F1 structural check within its 1200-second bound. Save `structural.log`. Pass when all configured properties finish with an empty queue.
- [ ] Lane 5. Run one existing F3 witness within 300 seconds. Save `witness.log`. Pass when the intended false invariant fails with the expected trace and exit 12.
- [ ] Lane 6. Run the existing F4 runtime correspondence command. Save `runtime.tap`. Pass when every selected test passes with zero skips.
- [ ] Lane 7. Compare the coverage reference to model configs and runtime symbols. Save `coverage.md`. Pass when all covered and unproved properties are named honestly.
- [ ] Lane 8. Verify the procedure leaves model/config hashes unchanged. Save `model-hashes.json`. Pass when no proof scope or runtime behavior changed.
- [ ] Lane 9. Run the maintained path and command checks touched by this PR, including their stated negative controls. Save `commands.log`. Pass when the documented commands resolve and negative controls reject for their intended reasons, not setup errors.
- [ ] Lane 10. Read the held pi-factorio revision/status through verify-factory under its read grant, or cite a still-valid unchanged receipt. Save `retiring-host.json`. Pass when no write or upgrade occurs and the read result is explicitly old-revision evidence, never head qualification. An unavailable retired host needs the owner-approved replacement read described in the boot recipe.

**Verify, perf.** Tests alone are not sufficient verification. A PR is verified only when its unit, live, and perf boxes are all checked.

- [ ] Metric. Measure process start to `controller_ready` and `npm run check` elapsed time on parent and head. Count model requests separately.
- [ ] Probe. Use the boot recipe on identical isolated held state and dependencies, interleaving three parent/head pairs. Save `perf.json` with raw samples and medians.
- [ ] Baseline. Record the parent startup and check durations before head measurements. For prose-only changes, reuse a valid runtime-identical baseline with the compared blob identities recorded.
- [ ] Rule. Fail if median check time rises by both 20 percent and 10 seconds, startup rises by both 20 percent and 250 ms, an existing deadline fails, or the probe calls a model. Missing readiness or native capacity is BLOCKED, not a zero-duration pass.

**Review gate.** None. L04 is not review-gated.

**Merge.**

- [ ] Record the root's exact-head verdict and complete Bugbot triage. Bind evidence to head, parent, and patch-id.
- [ ] Apply the patch-id rule in `playbooks/shipping.md` at merge prep. Confirm green exact-head CI and clean `git merge-tree`.
- [ ] Hand L04 to the owner as STACK-READY. The owner lands it. Complete any main-backed transition check before its dependent PR proceeds.

## Extract shared contracts and remove reverse cycles (L05)

**Depends on.** L03. Phase 2.

**Files.**

- [ ] Create `src/core/{run,json,models,stages,execution,journal}.ts` and `src/trust/protected-paths.ts`. Move shared declarations from `src/run.ts`, `src/tickets.ts`, `src/review.ts`, `src/workflow.ts`, `src/stages.ts`, and `server/sandbox/{json,anthropic-limits,result,audit}.ts`. Delete `src/run.ts` and the old JSON and model-limit module homes after migrating all callers. Use the shared migration allowance.
- [ ] Keep the execution and journal host writers in `server/sandbox/` until L18. Edit `test/{pipeline,policy,review,workflow,ledger,replay}.test.ts` and sandbox cases for pins.

**Build.**

- [ ] Pin JSON rejection, model-family evidence, unknown usage, settlement interpretation, stage order, and protected-path behavior first. Extract pure result/accounting contracts and journal interpretation, not the gateway audit writer.
- [ ] Put one stage vocabulary in core and derive the existing subsets. Keep transition policy outside core. Remove upward type references from run identity by assigning candidate and review types to their owners, not by widening them.
- [ ] Make protected-path decisions consume one `.github` and `test/acceptance` definition. Keep distinct policy actions distinct, including feedback files, symlinks, review routing, and cadence exclusions. Do not let this consolidation change authorization.
- [ ] Migrate all callers and remove internal re-exports. Break artifacts-to-review model-family coupling. Decrease the exact reverse-edge baseline. Update historical replay cap lookup to recognize the reviewed old and new declaration locations as data, never execute code from either revision. Refuse missing or ambiguous declarations.

**You see.**

- [ ] Core declares shared facts without importing host code, and extraction does not change a single refusal or budget.

**Verify, unit.** Tests alone are not sufficient verification. A PR is verified only when its unit, live, and perf boxes are all checked.

- [ ] Use parent/head golden inputs for JSON, families, settlements, protected-path decisions, and stage subsets before extraction. Run the full suite, trusted reporter, layout checks, cap lookup on the old SHA and head, and test-count parity.

**Verify, live.** Tests alone are not sufficient verification. A PR is verified only when its unit, live, and perf boxes are all checked. Ten lanes on `task:qa` at the PR head, per the boot recipe.

- [ ] Lane 1. Regression lane against trunk. Run `npm run check` on parent and head with the same native-test setting. Save `check-pair.log`. Pass when both pass, or a pre-existing failure is reproduced and reported as BLOCKED rather than hidden.
- [ ] Lane 2. Compare executed test names and counts using the trusted reporter and the PR move map. Save `test-counts.json`. Pass when every original test runs once, with each added pin accounted for and no unexplained skip.
- [ ] Lane 3. Compare JSON and model-family outputs with the pre-extraction pins. Save `core-parity.json`. Pass when values, rejection cases, and observed identity labels match.
- [ ] Lane 4. Compare settlement and unknown-usage interpretation. Save `usage.json`. Pass when all known and unknown costs retain their meaning.
- [ ] Lane 5. Drive protected paths through build, feedback, publication, and acceptance checks. Save `paths.json`. Pass when every pre-existing refusal still refuses.
- [ ] Lane 6. Run replay cap lookup on 5bd77d5 and the new head. Save `caps.json`. Pass when the same four positive limits are read without executing revision code.
- [ ] Lane 7. Run review-seat selection for every moved sensitive file. Save `seats.json`. Pass when no file loses its required seat.
- [ ] Lane 8. Count resolved reverse edges and check removed internal exports. Save `edges.json`. Pass when the allowlist shrinks with no old-path shim.
- [ ] Lane 9. Run the real head-owned candidate gate and required native sandbox checks per the boot recipe. Save `native-gate.log`. Pass when every required test runs, the receipt is complete, and old-main transition evidence remains separately labeled.
- [ ] Lane 10. Read the held pi-factorio revision/status through verify-factory under its read grant, or cite a still-valid unchanged receipt. Save `retiring-host.json`. Pass when no write or upgrade occurs and the read result is explicitly old-revision evidence, never head qualification. An unavailable retired host needs the owner-approved replacement read described in the boot recipe.

**Verify, perf.** Tests alone are not sufficient verification. A PR is verified only when its unit, live, and perf boxes are all checked.

- [ ] Metric. Measure process start to `controller_ready` and `npm run check` elapsed time on parent and head. Count model requests separately.
- [ ] Probe. Use the boot recipe on identical isolated held state and dependencies, interleaving three parent/head pairs. Save `perf.json` with raw samples and medians.
- [ ] Baseline. Record the parent startup and check durations before head measurements. For prose-only changes, reuse a valid runtime-identical baseline with the compared blob identities recorded.
- [ ] Rule. Fail if median check time rises by both 20 percent and 10 seconds, startup rises by both 20 percent and 250 ms, an existing deadline fails, or the probe calls a model. Missing readiness or native capacity is BLOCKED, not a zero-duration pass.

**Review gate.** None. L05 is not review-gated.

**Merge.**

- [ ] Record the root's exact-head verdict and complete Bugbot triage. Bind evidence to head, parent, and patch-id.
- [ ] Apply the patch-id rule in `playbooks/shipping.md` at merge prep. Confirm green exact-head CI and clean `git merge-tree`.
- [ ] Hand L05 to the owner as STACK-READY. The owner lands it. Complete any main-backed transition check before its dependent PR proceeds.

## Separate host collection and close the package (L06)

**Depends on.** L05. Phase 2.

**Files.**

- [ ] Edit `src/{feed,explain,replay}.ts`, `server/{cli,controller,sandbox,viewer}.ts`, and `server/viewer/evidence.ts`. Create `server/controller/state.ts`, `server/sandbox/receipts.ts`, and host collectors under `server/cli/{owner-feed,measurement,replay}.ts`. Edit `package.json` files and add `test/package-load.test.ts`. Use the shared migration allowance.

**Build.**

- [ ] Pin parent saved-state output for status, owner-feed, explain inputs, and replay bundle refusals before extraction. Preserve missing, corrupt, permission-denied, and unknown-evidence behavior.
- [ ] Make domain projections consume explicit input data while host collectors read status, locks, verdicts, stage receipts, and installed bundles. Keep bundle hashing and installed-source comparison on the host. Leave one read implementation per responsibility.
- [ ] Reach zero src-to-server and src-to-host edges, including type and literal dynamic imports. Delete the shrinking allowance after it reaches zero.
- [ ] Make package.json files explicitly list `package.json`, `extension/`, `src/`, `skills/`, `README.md`, and `LICENSE`. Repair the source/manifest mismatch by removing transitive host imports, not by relying on unpublished checkout files. Do not ship the whole host merely to hide the missing boundary. First reproduce the original missing-file problem by packing 5bd77d5 in isolation. Add a pack-to-temp and unpacked-extension load check with only declared dependencies and an isolated Pi command adapter. Publish nothing.

**You see.**

- [ ] The packed extension loads outside the source checkout, and domain code no longer imports host execution.

**Verify, unit.** Tests alone are not sufficient verification. A PR is verified only when its unit, live, and perf boxes are all checked.

- [ ] Pin saved-state outputs first. Run package-load from an isolated npm tarball, full suite, layout guards, and byte comparisons. Test absent and corrupt private files without weakening their permission checks.

**Verify, live.** Tests alone are not sufficient verification. A PR is verified only when its unit, live, and perf boxes are all checked. Ten lanes on `task:qa` at the PR head, per the boot recipe.

- [ ] Lane 1. Regression lane against trunk. Run `npm run check` on parent and head with the same native-test setting. Save `check-pair.log`. Pass when both pass, or a pre-existing failure is reproduced and reported as BLOCKED rather than hidden.
- [ ] Lane 2. Compare executed test names and counts using the trusted reporter and the PR move map. Save `test-counts.json`. Pass when every original test runs once, with each added pin accounted for and no unexplained skip.
- [ ] Lane 3. Read status and owner-feed from identical saved state on both revisions. Save `read-parity.json`. Pass when bytes agree and both state copies stay unchanged.
- [ ] Lane 4. Read missing, corrupt, and wrong-mode receipt fixtures. Save `read-errors.json`. Pass when the same unavailable evidence is reported.
- [ ] Lane 5. Check replay bundles with valid and changed contents. Save `bundle-refusal.json`. Pass when valid content passes and corruption still refuses.
- [ ] Lane 6. Resolve the full src import graph. Save `zero-edges.json`. Pass when both reverse-edge sets are empty.
- [ ] Lane 7. Pack, unpack, and load the extension outside the source tree. Save `package-load.log`. Pass when the real entry registers factory without a missing file or host import.
- [ ] Lane 8. Compare explain input and redaction on a failed-run fixture. Save `explain.json`. Pass when the same permitted facts and no private text reach the output.
- [ ] Lane 9. Run the real head-owned candidate gate and required native sandbox checks per the boot recipe. Save `native-gate.log`. Pass when every required test runs, the receipt is complete, and old-main transition evidence remains separately labeled.
- [ ] Lane 10. Read the held pi-factorio revision/status through verify-factory under its read grant, or cite a still-valid unchanged receipt. Save `retiring-host.json`. Pass when no write or upgrade occurs and the read result is explicitly old-revision evidence, never head qualification. An unavailable retired host needs the owner-approved replacement read described in the boot recipe.

**Verify, perf.** Tests alone are not sufficient verification. A PR is verified only when its unit, live, and perf boxes are all checked.

- [ ] Metric. Measure process start to `controller_ready` and `npm run check` elapsed time on parent and head. Count model requests separately.
- [ ] Probe. Use the boot recipe on identical isolated held state and dependencies, interleaving three parent/head pairs. Save `perf.json` with raw samples and medians.
- [ ] Baseline. Record the parent startup and check durations before head measurements. For prose-only changes, reuse a valid runtime-identical baseline with the compared blob identities recorded.
- [ ] Rule. Fail if median check time rises by both 20 percent and 10 seconds, startup rises by both 20 percent and 250 ms, an existing deadline fails, or the probe calls a model. Missing readiness or native capacity is BLOCKED, not a zero-duration pass.

**Review gate.** None. L06 is not review-gated.

**Merge.**

- [ ] Record the root's exact-head verdict and complete Bugbot triage. Bind evidence to head, parent, and patch-id.
- [ ] Apply the patch-id rule in `playbooks/shipping.md` at merge prep. Confirm green exact-head CI and clean `git merge-tree`.
- [ ] Hand L06 to the owner as STACK-READY. The owner lands it. Complete any main-backed transition check before its dependent PR proceeds.

## Move trust rules and GitHub access (L07)

**Depends on.** L06. Phase 3.

**Files.**

- [ ] Move `src/{policy,platform,admission,markers}.ts` into `src/trust/`. Move `src/adapters/github.ts` to `src/github/adapter.ts`, `src/gh.ts` to `src/github/exec.ts`, `src/tickets.ts` to `src/github/tickets.ts`, and `src/publication.ts` to `src/github/publish.ts`. Delete the empty adapters folder. Use the shared migration allowance.

**Build.**

- [ ] Move these modules without changing call structure. Keep publication and ledger Git extraction for L13. Update the high-risk path rule and cap/root inventory in the same wave.
- [ ] Preserve marker authentication, event identity, repository aliases only for history, and configured handoff reviewers. Keep WORKFLOW loading main-owned. Migrate every caller and remove each old module path.

**You see.**

- [ ] Authority and external GitHub operations have named homes, with no change to admission or publication.

**Verify, unit.** Tests alone are not sufficient verification. A PR is verified only when its unit, live, and perf boxes are all checked.

- [ ] Hold behavior against the full existing policy, platform, admission, markers, adapter, and publication suites plus layout checks and per-test parity. Do not edit held-out tests.

**Verify, live.** Tests alone are not sufficient verification. A PR is verified only when its unit, live, and perf boxes are all checked. Ten lanes on `task:qa` at the PR head, per the boot recipe.

- [ ] Lane 1. Regression lane against trunk. Run `npm run check` on parent and head with the same native-test setting. Save `check-pair.log`. Pass when both pass, or a pre-existing failure is reproduced and reported as BLOCKED rather than hidden.
- [ ] Lane 2. Compare executed test names and counts using the trusted reporter and the PR move map. Save `test-counts.json`. Pass when every original test runs once, with each added pin accounted for and no unexplained skip.
- [ ] Lane 3. Run admission switch, actor, and event cases. Save `admission.log`. Pass when all accepted and refused cases match the parent.
- [ ] Lane 4. Parse authenticated, forged, and historical markers. Save `markers.json`. Pass when history remains readable but cannot authorize an active run.
- [ ] Lane 5. Exercise publication on an isolated Git fixture. Save `publication.log`. Pass when ordered parents, exact heads, and no-force promotion remain unchanged.
- [ ] Lane 6. Select review seats for moved trust and adapter files. Save `seats.json`. Pass when each retains its parent seats.
- [ ] Lane 7. Inspect all old module paths and resolved imports. Save `moves.json`. Pass when old paths are deleted and all callers resolve directly.
- [ ] Lane 8. Compare status and platform command output on saved inputs. Save `platform.json`. Pass when the CLI contract is unchanged.
- [ ] Lane 9. Run the real head-owned candidate gate and required native sandbox checks per the boot recipe. Save `native-gate.log`. Pass when every required test runs, the receipt is complete, and old-main transition evidence remains separately labeled.
- [ ] Lane 10. Read the held pi-factorio revision/status through verify-factory under its read grant, or cite a still-valid unchanged receipt. Save `retiring-host.json`. Pass when no write or upgrade occurs and the read result is explicitly old-revision evidence, never head qualification. An unavailable retired host needs the owner-approved replacement read described in the boot recipe.

**Verify, perf.** Tests alone are not sufficient verification. A PR is verified only when its unit, live, and perf boxes are all checked.

- [ ] Metric. Measure process start to `controller_ready` and `npm run check` elapsed time on parent and head. Count model requests separately.
- [ ] Probe. Use the boot recipe on identical isolated held state and dependencies, interleaving three parent/head pairs. Save `perf.json` with raw samples and medians.
- [ ] Baseline. Record the parent startup and check durations before head measurements. For prose-only changes, reuse a valid runtime-identical baseline with the compared blob identities recorded.
- [ ] Rule. Fail if median check time rises by both 20 percent and 10 seconds, startup rises by both 20 percent and 250 ms, an existing deadline fails, or the probe calls a model. Missing readiness or native capacity is BLOCKED, not a zero-duration pass.

**Review gate.** None. L07 is not review-gated.

**Merge.**

- [ ] Record the root's exact-head verdict and complete Bugbot triage. Bind evidence to head, parent, and patch-id.
- [ ] Apply the patch-id rule in `playbooks/shipping.md` at merge prep. Confirm green exact-head CI and clean `git merge-tree`.
- [ ] Hand L07 to the owner as STACK-READY. The owner lands it. Complete any main-backed transition check before its dependent PR proceeds.

## Move configuration and contract modules (L08)

**Depends on.** L07. Phase 3.

**Files.**

- [ ] Move `src/workflow.ts` to `src/config/workflow.ts`, `src/specify.ts` to `src/contract/specify.ts`, `src/accept.ts` to `src/contract/acceptance.ts`, and `src/artifacts.ts` to `src/contract/artifacts.ts`. Use the shared migration allowance.

**Build.**

- [ ] Keep workflow and specify whole in this pure-move PR. L12 deletes these temporary real implementation files after the splits. They are not forwarding modules.
- [ ] Update replay cap data lookup for acceptance, prompts naming module paths, and the review risk map. Preserve the acceptance directory and its four-parent import hint.

**You see.**

- [ ] Configuration and immutable contracts are findable without changing parsing, prompts, or private artifact storage.

**Verify, unit.** Tests alone are not sufficient verification. A PR is verified only when its unit, live, and perf boxes are all checked.

- [ ] Run the full workflow, specify, accept, artifacts, and isolation suites. Compare test identities and run layout checks, including historical/current cap lookup and the maintained acceptance-isolation probe.

**Verify, live.** Tests alone are not sufficient verification. A PR is verified only when its unit, live, and perf boxes are all checked. Ten lanes on `task:qa` at the PR head, per the boot recipe.

- [ ] Lane 1. Regression lane against trunk. Run `npm run check` on parent and head with the same native-test setting. Save `check-pair.log`. Pass when both pass, or a pre-existing failure is reproduced and reported as BLOCKED rather than hidden.
- [ ] Lane 2. Compare executed test names and counts using the trusted reporter and the PR move map. Save `test-counts.json`. Pass when every original test runs once, with each added pin accounted for and no unexplained skip.
- [ ] Lane 3. Parse valid and invalid trusted workflows through workflow-check. Save `workflow.json`. Pass when snapshots and refusals match the parent.
- [ ] Lane 4. Render a fixed contract and clarification fixture. Save `contract.json`. Pass when all stable output bytes match.
- [ ] Lane 5. Store and read private acceptance artifacts. Save `acceptance.json`. Pass when digests and private modes match.
- [ ] Lane 6. Execute a generated acceptance import at its real test/acceptance depth. Save `depth.log`. Pass when four parents resolve the root and a three-parent control fails.
- [ ] Lane 7. Run historical and current replay cap reads. Save `caps.json`. Pass when acceptance limits remain discoverable.
- [ ] Lane 8. Run the maintained acceptance-isolation self-test. Save `isolation.log`. Pass when the canary remains inaccessible to build inputs.
- [ ] Lane 9. Run the real head-owned candidate gate and required native sandbox checks per the boot recipe. Save `native-gate.log`. Pass when every required test runs, the receipt is complete, and old-main transition evidence remains separately labeled.
- [ ] Lane 10. Read the held pi-factorio revision/status through verify-factory under its read grant, or cite a still-valid unchanged receipt. Save `retiring-host.json`. Pass when no write or upgrade occurs and the read result is explicitly old-revision evidence, never head qualification. An unavailable retired host needs the owner-approved replacement read described in the boot recipe.

**Verify, perf.** Tests alone are not sufficient verification. A PR is verified only when its unit, live, and perf boxes are all checked.

- [ ] Metric. Measure process start to `controller_ready` and `npm run check` elapsed time on parent and head. Count model requests separately.
- [ ] Probe. Use the boot recipe on identical isolated held state and dependencies, interleaving three parent/head pairs. Save `perf.json` with raw samples and medians.
- [ ] Baseline. Record the parent startup and check durations before head measurements. For prose-only changes, reuse a valid runtime-identical baseline with the compared blob identities recorded.
- [ ] Rule. Fail if median check time rises by both 20 percent and 10 seconds, startup rises by both 20 percent and 250 ms, an existing deadline fails, or the probe calls a model. Missing readiness or native capacity is BLOCKED, not a zero-duration pass.

**Review gate.** None. L08 is not review-gated.

**Merge.**

- [ ] Record the root's exact-head verdict and complete Bugbot triage. Bind evidence to head, parent, and patch-id.
- [ ] Apply the patch-id rule in `playbooks/shipping.md` at merge prep. Confirm green exact-head CI and clean `git merge-tree`.
- [ ] Hand L08 to the owner as STACK-READY. The owner lands it. Complete any main-backed transition check before its dependent PR proceeds.

## Move candidate policy and ledger state (L09)

**Depends on.** L08. Phase 3.

**Files.**

- [ ] Move `src/{handoff,build,review,validation,feedback,diagnosis}.ts` into `src/candidate/`. Move the transition implementation from `src/stages.ts` to `src/candidate/stages.ts` and `src/ledger.ts` to `src/ledger/ledger.ts`. Use the shared migration allowance.

**Build.**

- [ ] Move implementations intact. Keep codec and ledger splits for L11 and L13. Migrate direct imports rather than adding directory index barrels.
- [ ] Preserve CI/head binding, repair limits, owner edits, held-out refusal, append-only ledger versions, and reviewer routing. Update historical cap lookup for build.

**You see.**

- [ ] Candidate lifecycle and ledger ownership are visible without any wire-format migration.

**Verify, unit.** Tests alone are not sufficient verification. A PR is verified only when its unit, live, and perf boxes are all checked.

- [ ] Run full candidate, feedback, diagnosis, ledger, and pipeline suites, the formal correspondence replay, layout guards, and executed test-count parity.

**Verify, live.** Tests alone are not sufficient verification. A PR is verified only when its unit, live, and perf boxes are all checked. Ten lanes on `task:qa` at the PR head, per the boot recipe.

- [ ] Lane 1. Regression lane against trunk. Run `npm run check` on parent and head with the same native-test setting. Save `check-pair.log`. Pass when both pass, or a pre-existing failure is reproduced and reported as BLOCKED rather than hidden.
- [ ] Lane 2. Compare executed test names and counts using the trusted reporter and the PR move map. Save `test-counts.json`. Pass when every original test runs once, with each added pin accounted for and no unexplained skip.
- [ ] Lane 3. Replay certified, stale-head, and owner-head transitions. Save `candidate.json`. Pass when effects and refusals match the parent.
- [ ] Lane 4. Read all supported persisted candidate versions. Save `codec.json`. Pass when valid books decode identically and invalid books refuse.
- [ ] Lane 5. Run feedback intake and repeated observation cases. Save `feedback.log`. Pass when no duplicate repair or weakened permission appears.
- [ ] Lane 6. Append to a temporary ledger Git repository. Save `ledger.log`. Pass when row bytes and idempotent append behavior agree.
- [ ] Lane 7. Exercise moved build/review risk and cap lookup. Save `risk-caps.json`. Pass when seats and caps are unchanged.
- [ ] Lane 8. Run the bounded runtime correspondence replay. Save `formal-runtime.tap`. Pass when all selected behavior cases pass with no skips.
- [ ] Lane 9. Run the real head-owned candidate gate and required native sandbox checks per the boot recipe. Save `native-gate.log`. Pass when every required test runs, the receipt is complete, and old-main transition evidence remains separately labeled.
- [ ] Lane 10. Read the held pi-factorio revision/status through verify-factory under its read grant, or cite a still-valid unchanged receipt. Save `retiring-host.json`. Pass when no write or upgrade occurs and the read result is explicitly old-revision evidence, never head qualification. An unavailable retired host needs the owner-approved replacement read described in the boot recipe.

**Verify, perf.** Tests alone are not sufficient verification. A PR is verified only when its unit, live, and perf boxes are all checked.

- [ ] Metric. Measure process start to `controller_ready` and `npm run check` elapsed time on parent and head. Count model requests separately.
- [ ] Probe. Use the boot recipe on identical isolated held state and dependencies, interleaving three parent/head pairs. Save `perf.json` with raw samples and medians.
- [ ] Baseline. Record the parent startup and check durations before head measurements. For prose-only changes, reuse a valid runtime-identical baseline with the compared blob identities recorded.
- [ ] Rule. Fail if median check time rises by both 20 percent and 10 seconds, startup rises by both 20 percent and 250 ms, an existing deadline fails, or the probe calls a model. Missing readiness or native capacity is BLOCKED, not a zero-duration pass.

**Review gate.** None. L09 is not review-gated.

**Merge.**

- [ ] Record the root's exact-head verdict and complete Bugbot triage. Bind evidence to head, parent, and patch-id.
- [ ] Apply the patch-id rule in `playbooks/shipping.md` at merge prep. Confirm green exact-head CI and clean `git merge-tree`.
- [ ] Hand L09 to the owner as STACK-READY. The owner lands it. Complete any main-backed transition check before its dependent PR proceeds.

## Move projections, maintenance, and scheduling (L10)

**Depends on.** L09. Phase 3.

**Files.**

- [ ] Move `src/{feed,attention,explain,metrics}.ts` into `src/views/`, `src/{cadence,replay,scorers}.ts` into `src/maintenance/`, and `src/orchestrator.ts` into `src/controller/orchestrator.ts`. Use the shared migration allowance.

**Build.**

- [ ] Keep these implementations intact. Update cadence path groups and exclusions without widening which work it proposes. Preserve measurement-only behavior and no self-promotion.
- [ ] Record the temporary unsplit orchestrator as a real module whose tick and slot ownership L14 retains. Keep current test files at their runnable locations until L19.

**You see.**

- [ ] Readers find projections, maintenance work, and the scheduling authority in separate folders.

**Verify, unit.** Tests alone are not sufficient verification. A PR is verified only when its unit, live, and perf boxes are all checked.

- [ ] Run all projection, maintenance, and orchestrator suites, the full check, runtime correspondence, layout guards, and test-count parity. Byte-compare saved-state CLI reads.

**Verify, live.** Tests alone are not sufficient verification. A PR is verified only when its unit, live, and perf boxes are all checked. Ten lanes on `task:qa` at the PR head, per the boot recipe.

- [ ] Lane 1. Regression lane against trunk. Run `npm run check` on parent and head with the same native-test setting. Save `check-pair.log`. Pass when both pass, or a pre-existing failure is reproduced and reported as BLOCKED rather than hidden.
- [ ] Lane 2. Compare executed test names and counts using the trusted reporter and the PR move map. Save `test-counts.json`. Pass when every original test runs once, with each added pin accounted for and no unexplained skip.
- [ ] Lane 3. Compare owner-feed and attention on the fixed saved state. Save `views.json`. Pass when bytes and grouping agree.
- [ ] Lane 4. Compute metrics with failed, immature, and repaired runs. Save `metrics.json`. Pass when denominators and unknowns match.
- [ ] Lane 5. Resolve replay caps and bundle source selection across old and new revisions. Save `replay.json`. Pass when historical input remains data and malformed input refuses.
- [ ] Lane 6. Run cadence scope and no-delta cases. Save `cadence.json`. Pass when excluded paths stay excluded and no runtime promotion is introduced.
- [ ] Lane 7. Run queue capacity and restart orchestration cases. Save `scheduler.log`. Pass when the same events retain the same slots and charges.
- [ ] Lane 8. Resolve every root module old path and review risk sample. Save `layout.json`. Pass when all migrated callers are direct and no sensitive path loses a seat.
- [ ] Lane 9. Run the real head-owned candidate gate and required native sandbox checks per the boot recipe. Save `native-gate.log`. Pass when every required test runs, the receipt is complete, and old-main transition evidence remains separately labeled.
- [ ] Lane 10. Read the held pi-factorio revision/status through verify-factory under its read grant, or cite a still-valid unchanged receipt. Save `retiring-host.json`. Pass when no write or upgrade occurs and the read result is explicitly old-revision evidence, never head qualification. An unavailable retired host needs the owner-approved replacement read described in the boot recipe.

**Verify, perf.** Tests alone are not sufficient verification. A PR is verified only when its unit, live, and perf boxes are all checked.

- [ ] Metric. Measure process start to `controller_ready` and `npm run check` elapsed time on parent and head. Count model requests separately.
- [ ] Probe. Use the boot recipe on identical isolated held state and dependencies, interleaving three parent/head pairs. Save `perf.json` with raw samples and medians.
- [ ] Baseline. Record the parent startup and check durations before head measurements. For prose-only changes, reuse a valid runtime-identical baseline with the compared blob identities recorded.
- [ ] Rule. Fail if median check time rises by both 20 percent and 10 seconds, startup rises by both 20 percent and 250 ms, an existing deadline fails, or the probe calls a model. Missing readiness or native capacity is BLOCKED, not a zero-duration pass.

**Review gate.** None. L10 is not review-gated.

**Merge.**

- [ ] Record the root's exact-head verdict and complete Bugbot triage. Bind evidence to head, parent, and patch-id.
- [ ] Apply the patch-id rule in `playbooks/shipping.md` at merge prep. Confirm green exact-head CI and clean `git merge-tree`.
- [ ] Hand L10 to the owner as STACK-READY. The owner lands it. Complete any main-backed transition check before its dependent PR proceeds.

## Separate candidate state from its codec (L11)

**Depends on.** L10. Phase 4.

**Files.**

- [ ] Split `src/candidate/handoff.ts` into `state.ts`, `codec.ts`, and policy-only `handoff.ts`. Edit `test/handoff.test.ts`, formal runtime imports, and direct callers through the shared migration allowance.

**Build.**

- [ ] Before splitting, pin all supported stored books and invalid books through parse, serialize, transition, serialize, and fresh-process reload. Include unknown usage, owner-head recertification, pending effects, captured attempts, and old ledger references.
- [ ] Move state definitions and immutable state operations to state.ts, wire decoders and migrations to codec.ts, and retain decisions in handoff.ts. Delete old internal exports and redundant re-exports. Introduce no schema or migration change.
- [ ] Split the giant test only by existing behavior groups if useful, keeping each registered test identity and expectation. L19 performs the directory move.

**You see.**

- [ ] The policy file describes decisions rather than wire decoding, while stored runs resume identically.

**Verify, unit.** Tests alone are not sufficient verification. A PR is verified only when its unit, live, and perf boxes are all checked.

- [ ] Create characterization cases before extraction in `test/handoff.test.ts`. Replay serialized books in a fresh process on both revisions. Run the full suite, layout checks, formal runtime replay, and per-test parity.

**Verify, live.** Tests alone are not sufficient verification. A PR is verified only when its unit, live, and perf boxes are all checked. Ten lanes on `task:qa` at the PR head, per the boot recipe.

- [ ] Lane 1. Regression lane against trunk. Run `npm run check` on parent and head with the same native-test setting. Save `check-pair.log`. Pass when both pass, or a pre-existing failure is reproduced and reported as BLOCKED rather than hidden.
- [ ] Lane 2. Compare executed test names and counts using the trusted reporter and the PR move map. Save `test-counts.json`. Pass when every original test runs once, with each added pin accounted for and no unexplained skip.
- [ ] Lane 3. Parse and serialize every supported book version. Save `book-bytes.json`. Pass when serialized bytes and rejection classes match the pin.
- [ ] Lane 4. Restart from a pending effect in a fresh process. Save `restart.json`. Pass when the same next effect appears without duplicate work.
- [ ] Lane 5. Replay stale and captured execution callbacks. Save `identity.json`. Pass when old receipts cannot certify a new generation.
- [ ] Lane 6. Exercise owner drift and recertification. Save `owner.json`. Pass when owner commits and cumulative usage stay intact.
- [ ] Lane 7. Run formal runtime correspondence. Save `formal.tap`. Pass when all selected cases pass without a new model claim.
- [ ] Lane 8. Compare registered test identities before and after any suite split. Save `test-map.json`. Pass when no case is lost or duplicated.
- [ ] Lane 9. Run the real head-owned candidate gate and required native sandbox checks per the boot recipe. Save `native-gate.log`. Pass when every required test runs, the receipt is complete, and old-main transition evidence remains separately labeled.
- [ ] Lane 10. Read the held pi-factorio revision/status through verify-factory under its read grant, or cite a still-valid unchanged receipt. Save `retiring-host.json`. Pass when no write or upgrade occurs and the read result is explicitly old-revision evidence, never head qualification. An unavailable retired host needs the owner-approved replacement read described in the boot recipe.

**Verify, perf.** Tests alone are not sufficient verification. A PR is verified only when its unit, live, and perf boxes are all checked.

- [ ] Metric. Measure process start to `controller_ready` and `npm run check` elapsed time on parent and head. Count model requests separately.
- [ ] Probe. Use the boot recipe on identical isolated held state and dependencies, interleaving three parent/head pairs. Save `perf.json` with raw samples and medians.
- [ ] Baseline. Record the parent startup and check durations before head measurements. For prose-only changes, reuse a valid runtime-identical baseline with the compared blob identities recorded.
- [ ] Rule. Fail if median check time rises by both 20 percent and 10 seconds, startup rises by both 20 percent and 250 ms, an existing deadline fails, or the probe calls a model. Missing readiness or native capacity is BLOCKED, not a zero-duration pass.

**Review gate.** None. L11 is not review-gated.

**Merge.**

- [ ] Record the root's exact-head verdict and complete Bugbot triage. Bind evidence to head, parent, and patch-id.
- [ ] Apply the patch-id rule in `playbooks/shipping.md` at merge prep. Confirm green exact-head CI and clean `git merge-tree`.
- [ ] Hand L11 to the owner as STACK-READY. The owner lands it. Complete any main-backed transition check before its dependent PR proceeds.

## Split configuration and contract knowledge (L12)

**Depends on.** L11. Phase 4.

**Files.**

- [ ] Split `src/config/workflow.ts` into `schema.ts`, `parse.ts`, `load.ts`, and `views.ts`, deleting workflow.ts. Split `src/contract/specify.ts` into `contract.ts`, `parse.ts`, `render.ts`, and `prompt.ts`, deleting specify.ts. Move acceptance binding from `src/candidate/diagnosis.ts` into `src/contract/acceptance.ts`. Use the shared migration allowance.

**Build.**

- [ ] Pin valid/invalid YAML, loaded snapshot identity, last-valid reload, rendered status, contract digest bytes, prompt framing, and acceptance binding before splitting. Pin random nonce behavior by matching the nonce-bound payload, not by deleting untrusted content from comparisons.
- [ ] Keep GitHub fetch mechanics in config/load through the existing exec contract. Keep contract prompts beside their domain. Do not introduce a universal parser or prompt service.
- [ ] Remove the old implementation files and re-exports in the same wave. Keep the single core stage vocabulary and the same main-only workflow trust boundary.

**You see.**

- [ ] The folder separates configuration parsing from loading, and contract representation from prompts, without changing results.

**Verify, unit.** Tests alone are not sufficient verification. A PR is verified only when its unit, live, and perf boxes are all checked.

- [ ] Add characterization fixtures to `test/workflow.test.ts`, `test/specify.test.ts`, and `test/diagnosis.test.ts` before extraction. Run full checks and compare digests, refusals, framing, and test counts.

**Verify, live.** Tests alone are not sufficient verification. A PR is verified only when its unit, live, and perf boxes are all checked. Ten lanes on `task:qa` at the PR head, per the boot recipe.

- [ ] Lane 1. Regression lane against trunk. Run `npm run check` on parent and head with the same native-test setting. Save `check-pair.log`. Pass when both pass, or a pre-existing failure is reproduced and reported as BLOCKED rather than hidden.
- [ ] Lane 2. Compare executed test names and counts using the trusted reporter and the PR move map. Save `test-counts.json`. Pass when every original test runs once, with each added pin accounted for and no unexplained skip.
- [ ] Lane 3. Parse the full valid and invalid workflow corpus. Save `parse.json`. Pass when all results and error kinds match.
- [ ] Lane 4. Reload invalid settings after a valid trusted snapshot. Save `reload.json`. Pass when the previous digest remains and the error is visible.
- [ ] Lane 5. Render contracts and clarification comments. Save `render.json`. Pass when stable bytes and inert text handling match.
- [ ] Lane 6. Compare prompts with fixed inputs and inspected nonce framing. Save `prompts.json`. Pass when all payload bytes and delimiters retain their contract.
- [ ] Lane 7. Validate acceptance/base binding mismatches. Save `binding.json`. Pass when each identity mismatch still refuses.
- [ ] Lane 8. Run the packed extension check after caller migration. Save `package.log`. Pass when config loads without a deleted module path.
- [ ] Lane 9. Run the real head-owned candidate gate and required native sandbox checks per the boot recipe. Save `native-gate.log`. Pass when every required test runs, the receipt is complete, and old-main transition evidence remains separately labeled.
- [ ] Lane 10. Read the held pi-factorio revision/status through verify-factory under its read grant, or cite a still-valid unchanged receipt. Save `retiring-host.json`. Pass when no write or upgrade occurs and the read result is explicitly old-revision evidence, never head qualification. An unavailable retired host needs the owner-approved replacement read described in the boot recipe.

**Verify, perf.** Tests alone are not sufficient verification. A PR is verified only when its unit, live, and perf boxes are all checked.

- [ ] Metric. Measure process start to `controller_ready` and `npm run check` elapsed time on parent and head. Count model requests separately.
- [ ] Probe. Use the boot recipe on identical isolated held state and dependencies, interleaving three parent/head pairs. Save `perf.json` with raw samples and medians.
- [ ] Baseline. Record the parent startup and check durations before head measurements. For prose-only changes, reuse a valid runtime-identical baseline with the compared blob identities recorded.
- [ ] Rule. Fail if median check time rises by both 20 percent and 10 seconds, startup rises by both 20 percent and 250 ms, an existing deadline fails, or the probe calls a model. Missing readiness or native capacity is BLOCKED, not a zero-duration pass.

**Review gate.** None. L12 is not review-gated.

**Merge.**

- [ ] Record the root's exact-head verdict and complete Bugbot triage. Bind evidence to head, parent, and patch-id.
- [ ] Apply the patch-id rule in `playbooks/shipping.md` at merge prep. Confirm green exact-head CI and clean `git merge-tree`.
- [ ] Hand L12 to the owner as STACK-READY. The owner lands it. Complete any main-backed transition check before its dependent PR proceeds.

## Separate ledger schema, appends, and Git storage (L13)

**Depends on.** L12. Phase 4.

**Files.**

- [ ] Split `src/ledger/ledger.ts` into `schema.ts`, `append.ts`, `terminal.ts`, and `outbox.ts`, deleting ledger.ts. Move ledger Git operations and file constants from `src/github/publish.ts` to `src/ledger/git.ts`. Update ledger and publication tests and use the shared migration allowance.

**Build.**

- [ ] Pin v1 through v5 row parsing and exact output bytes, append/adopt/conflict outcomes, terminal evidence, and outbox restart recovery before the split.
- [ ] Keep GitHub candidate publication in github/publish. Give ledger/git only ledger branch storage. Preserve one serial writer, no force-push, monotonic usage, and unknown-evidence semantics.
- [ ] Read the ledger after a fresh-process restart and prove deduplication from persisted artifacts rather than reusing a prepared object.

**You see.**

- [ ] Ledger persistence has one owner per concern, with historical rows and remote-write behavior unchanged.

**Verify, unit.** Tests alone are not sufficient verification. A PR is verified only when its unit, live, and perf boxes are all checked.

- [ ] Add real temporary-Git characterization to `test/ledger.test.ts` and `test/publication.test.ts` before extraction. Run full checks, interruption/restart parity, and test-count mapping.

**Verify, live.** Tests alone are not sufficient verification. A PR is verified only when its unit, live, and perf boxes are all checked. Ten lanes on `task:qa` at the PR head, per the boot recipe.

- [ ] Lane 1. Regression lane against trunk. Run `npm run check` on parent and head with the same native-test setting. Save `check-pair.log`. Pass when both pass, or a pre-existing failure is reproduced and reported as BLOCKED rather than hidden.
- [ ] Lane 2. Compare executed test names and counts using the trusted reporter and the PR move map. Save `test-counts.json`. Pass when every original test runs once, with each added pin accounted for and no unexplained skip.
- [ ] Lane 3. Read and reserialize all ledger row versions. Save `rows.json`. Pass when old bytes remain identical.
- [ ] Lane 4. Append the same run twice to a real temporary Git ledger. Save `append.log`. Pass when one row remains and the tip is verified.
- [ ] Lane 5. Interrupt after the Git write and reload from disk in a fresh process. Save `restart.log`. Pass when the outbox reconciles instead of duplicating the append.
- [ ] Lane 6. Advance the remote ledger tip between read and append. Save `conflict.log`. Pass when the same bounded conflict result appears.
- [ ] Lane 7. Compare terminal evidence for merged, failed, and unknown-cost runs. Save `terminal.json`. Pass when outcomes and charged totals match.
- [ ] Lane 8. Run candidate publication separately. Save `publication.log`. Pass when moving ledger storage changes no candidate commit or PR request.
- [ ] Lane 9. Run the real head-owned candidate gate and required native sandbox checks per the boot recipe. Save `native-gate.log`. Pass when every required test runs, the receipt is complete, and old-main transition evidence remains separately labeled.
- [ ] Lane 10. Read the held pi-factorio revision/status through verify-factory under its read grant, or cite a still-valid unchanged receipt. Save `retiring-host.json`. Pass when no write or upgrade occurs and the read result is explicitly old-revision evidence, never head qualification. An unavailable retired host needs the owner-approved replacement read described in the boot recipe.

**Verify, perf.** Tests alone are not sufficient verification. A PR is verified only when its unit, live, and perf boxes are all checked.

- [ ] Metric. Measure process start to `controller_ready` and `npm run check` elapsed time on parent and head. Count model requests separately.
- [ ] Probe. Use the boot recipe on identical isolated held state and dependencies, interleaving three parent/head pairs. Save `perf.json` with raw samples and medians.
- [ ] Baseline. Record the parent startup and check durations before head measurements. For prose-only changes, reuse a valid runtime-identical baseline with the compared blob identities recorded.
- [ ] Rule. Fail if median check time rises by both 20 percent and 10 seconds, startup rises by both 20 percent and 250 ms, an existing deadline fails, or the probe calls a model. Missing readiness or native capacity is BLOCKED, not a zero-duration pass.

**Review gate.** None. L13 is not review-gated.

**Merge.**

- [ ] Record the root's exact-head verdict and complete Bugbot triage. Bind evidence to head, parent, and patch-id.
- [ ] Apply the patch-id rule in `playbooks/shipping.md` at merge prep. Confirm green exact-head CI and clean `git merge-tree`.
- [ ] Hand L13 to the owner as STACK-READY. The owner lands it. Complete any main-backed transition check before its dependent PR proceeds.

## Split scheduling by owned state (L14)

**Depends on.** L13. Phase 4.

**Files.**

- [ ] Split `src/controller/orchestrator.ts` into tick/slots orchestration plus `claims.ts`, `accounting.ts`, `admission.ts`, `launch.ts`, `effects.ts`, `recovery.ts`, and `base-check.ts`. Edit `test/orchestrator.test.ts` and related test helpers. Use the shared migration allowance.

**Build.**

- [ ] Map private-field access before extraction. Pin ordered observable events, persisted claim bytes, external requests, slot occupancy, and cumulative accounting across a tick, stage completion, and restart. Keep one authority for each mutable value.
- [ ] Extract cohesive responsibilities behind narrow data inputs and explicit effects. Do not pass the entire mutable orchestrator through a new service interface. Keep tick ordering and slot arbitration in orchestrator.ts.
- [ ] Use the existing crash windows and captured callback tests as the equivalence contract. Add missing pins before moving code. Split the 19,049-line test by behavior only, with an explicit registration map and unchanged assertions.

**You see.**

- [ ] A reader can locate claims, charging, launch, recovery, and effects without following a second scheduling authority.

**Verify, unit.** Tests alone are not sufficient verification. A PR is verified only when its unit, live, and perf boxes are all checked.

- [ ] Run the pre-split event and fresh-process recovery pins, full orchestrator suite, full check, native sandbox suite, layout checks, and per-test parity. Keep real persistence and preparation in the path; fake only external infrastructure.

**Verify, live.** Tests alone are not sufficient verification. A PR is verified only when its unit, live, and perf boxes are all checked. Ten lanes on `task:qa` at the PR head, per the boot recipe.

- [ ] Lane 1. Regression lane against trunk. Run `npm run check` on parent and head with the same native-test setting. Save `check-pair.log`. Pass when both pass, or a pre-existing failure is reproduced and reported as BLOCKED rather than hidden.
- [ ] Lane 2. Compare executed test names and counts using the trusted reporter and the PR move map. Save `test-counts.json`. Pass when every original test runs once, with each added pin accounted for and no unexplained skip.
- [ ] Lane 3. Compare tick event/request traces under identical fake external responses. Save `tick.json`. Pass when observable order and persisted state match.
- [ ] Lane 4. Drive three issues with two slots. Save `slots.json`. Pass when the same claims hold capacity without duplicate writers.
- [ ] Lane 5. Restart at claim, launch, and completion persistence boundaries. Save `recovery.json`. Pass when fresh processes preserve captured identity and usage floors.
- [ ] Lane 6. Deliver late, duplicate, and unknown-cost results. Save `accounting.json`. Pass when charges and refusals match the pinned contract.
- [ ] Lane 7. Drive acceptance refusal and bounded retry through the controller. Save `base-check.json`. Pass when no extra retry or uncharged work appears.
- [ ] Lane 8. Compare every registered orchestrator test before/after the split. Save `test-map.json`. Pass when no behavior case disappears or runs twice.
- [ ] Lane 9. Run the real head-owned candidate gate and required native sandbox checks per the boot recipe. Save `native-gate.log`. Pass when every required test runs, the receipt is complete, and old-main transition evidence remains separately labeled.
- [ ] Lane 10. Read the held pi-factorio revision/status through verify-factory under its read grant, or cite a still-valid unchanged receipt. Save `retiring-host.json`. Pass when no write or upgrade occurs and the read result is explicitly old-revision evidence, never head qualification. An unavailable retired host needs the owner-approved replacement read described in the boot recipe.

**Verify, perf.** Tests alone are not sufficient verification. A PR is verified only when its unit, live, and perf boxes are all checked.

- [ ] Metric. Measure process start to `controller_ready` and `npm run check` elapsed time on parent and head. Count model requests separately.
- [ ] Probe. Use the boot recipe on identical isolated held state and dependencies, interleaving three parent/head pairs. Save `perf.json` with raw samples and medians.
- [ ] Baseline. Record the parent startup and check durations before head measurements. For prose-only changes, reuse a valid runtime-identical baseline with the compared blob identities recorded.
- [ ] Rule. Fail if median check time rises by both 20 percent and 10 seconds, startup rises by both 20 percent and 250 ms, an existing deadline fails, or the probe calls a model. Missing readiness or native capacity is BLOCKED, not a zero-duration pass.

**Review gate.** None. L14 is not review-gated.

**Merge.**

- [ ] Record the root's exact-head verdict and complete Bugbot triage. Bind evidence to head, parent, and patch-id.
- [ ] Apply the patch-id rule in `playbooks/shipping.md` at merge prep. Confirm green exact-head CI and clean `git merge-tree`.
- [ ] Hand L14 to the owner as STACK-READY. The owner lands it. Complete any main-backed transition check before its dependent PR proceeds.

## Split the host controller without moving its root (L15)

**Depends on.** L14. Phase 4.

**Files.**

- [ ] Split `server/controller.ts` into `server/controller/{serve-loop,lock,checkout,checkers,run-files,outbox,terminal,measurement,cadence,validation-sweep,candidate-port,state}.ts`. Merge with the state module from L06. Delete controller.ts after all callers migrate. Use the shared migration allowance.

**Build.**

- [ ] Pin real preparation, persisted files, subprocess stop/settlement, candidate publication requests, and restart recovery before extraction. Preserve differing private-file permission and corruption behavior rather than consolidating readers by appearance.
- [ ] Move serve-loop as the composition point, with controller authority still in src/controller. Place the repository-root calculation in a direct owned location and test the new depth. Keep the exact gate-materializer comparison for diagnosis.
- [ ] Keep one outbox and one validation sweep. Verify captured executions, cleanup ownership, deadlines, and terminal charges through disk reload.

**You see.**

- [ ] Host I/O is split by what it persists or runs, and readiness and recovery remain unchanged.

**Verify, unit.** Tests alone are not sufficient verification. A PR is verified only when its unit, live, and perf boxes are all checked.

- [ ] Add pre-split host characterization in existing candidate-gates, diagnosis, orchestrator, and pipeline tests. Run full checks, real native isolation, saved-state parity, and fresh-process restart tests.

**Verify, live.** Tests alone are not sufficient verification. A PR is verified only when its unit, live, and perf boxes are all checked. Ten lanes on `task:qa` at the PR head, per the boot recipe.

- [ ] Lane 1. Regression lane against trunk. Run `npm run check` on parent and head with the same native-test setting. Save `check-pair.log`. Pass when both pass, or a pre-existing failure is reproduced and reported as BLOCKED rather than hidden.
- [ ] Lane 2. Compare executed test names and counts using the trusted reporter and the PR move map. Save `test-counts.json`. Pass when every original test runs once, with each added pin accounted for and no unexplained skip.
- [ ] Lane 3. Prepare and persist a candidate through real local checkout code. Save `prepare.json`. Pass when tree and receipt identities match.
- [ ] Lane 4. Restart with pending outbox and terminal files. Save `restart.json`. Pass when effects reconcile once and accounting survives.
- [ ] Lane 5. Resolve the cadence checkout root from the extracted module. Save `root.json`. Pass when git operates on the repository rather than server/.
- [ ] Lane 6. Compare stored and executing gate-materializer bytes. Save `materializer.json`. Pass when matching code passes and an altered materializer refuses.
- [ ] Lane 7. Sweep expired validation with owned and foreign refs. Save `sweep.json`. Pass when only owned refs are removed and deadlines do not reset.
- [ ] Lane 8. Start a held isolated controller and observe readiness. Save `ready.log`. Pass when the real event arrives with dispatch disabled.
- [ ] Lane 9. Run the real head-owned candidate gate and required native sandbox checks per the boot recipe. Save `native-gate.log`. Pass when every required test runs, the receipt is complete, and old-main transition evidence remains separately labeled.
- [ ] Lane 10. Read the held pi-factorio revision/status through verify-factory under its read grant, or cite a still-valid unchanged receipt. Save `retiring-host.json`. Pass when no write or upgrade occurs and the read result is explicitly old-revision evidence, never head qualification. An unavailable retired host needs the owner-approved replacement read described in the boot recipe.

**Verify, perf.** Tests alone are not sufficient verification. A PR is verified only when its unit, live, and perf boxes are all checked.

- [ ] Metric. Measure process start to `controller_ready` and `npm run check` elapsed time on parent and head. Count model requests separately.
- [ ] Probe. Use the boot recipe on identical isolated held state and dependencies, interleaving three parent/head pairs. Save `perf.json` with raw samples and medians.
- [ ] Baseline. Record the parent startup and check durations before head measurements. For prose-only changes, reuse a valid runtime-identical baseline with the compared blob identities recorded.
- [ ] Rule. Fail if median check time rises by both 20 percent and 10 seconds, startup rises by both 20 percent and 250 ms, an existing deadline fails, or the probe calls a model. Missing readiness or native capacity is BLOCKED, not a zero-duration pass.

**Review gate.** None. L15 is not review-gated.

**Merge.**

- [ ] Record the root's exact-head verdict and complete Bugbot triage. Bind evidence to head, parent, and patch-id.
- [ ] Apply the patch-id rule in `playbooks/shipping.md` at merge prep. Confirm green exact-head CI and clean `git merge-tree`.
- [ ] Hand L15 to the owner as STACK-READY. The owner lands it. Complete any main-backed transition check before its dependent PR proceeds.

## Split stage execution and receipt handling (L16)

**Depends on.** L15. Phase 4.

**Files.**

- [ ] Split `server/sandbox.ts` into `server/sandbox/{run-stage,launch,executor,receipts,visible-tests,review,specify}.ts`, merging the receipt reader from L06. Delete sandbox.ts. Keep gateway and isolation filenames here until L18. Use the shared migration allowance.

**Build.**

- [ ] Pin settlement ordering, executor receipts, captured model identity, refusal/fallback outcomes, cleanup, and cumulative limits before extraction. Keep the pure shared facts already in core.
- [ ] Move execution responsibilities into their real modules. Keep bwrap, gateway processes, and RPC lifetimes explicit. Do not introduce a forwarding sandbox index.
- [ ] Split the 9,394-line runner cases by behavior if useful, retaining the single aggregator and every test until L19.

**You see.**

- [ ] Run-stage and execution assembly are separate, but a stage still settles only after its owned work settles.

**Verify, unit.** Tests alone are not sufficient verification. A PR is verified only when its unit, live, and perf boxes are all checked.

- [ ] Pin stage and child settlement behavior before extraction. Run full checks with required native sandbox tests, trusted reporter, request/receipt parity, and runner-case count parity.

**Verify, live.** Tests alone are not sufficient verification. A PR is verified only when its unit, live, and perf boxes are all checked. Ten lanes on `task:qa` at the PR head, per the boot recipe.

- [ ] Lane 1. Regression lane against trunk. Run `npm run check` on parent and head with the same native-test setting. Save `check-pair.log`. Pass when both pass, or a pre-existing failure is reproduced and reported as BLOCKED rather than hidden.
- [ ] Lane 2. Compare executed test names and counts using the trusted reporter and the PR move map. Save `test-counts.json`. Pass when every original test runs once, with each added pin accounted for and no unexplained skip.
- [ ] Lane 3. Run the native scripted-model stage through the real gateway. Save `stage.json`. Pass when settlement and receipt fields match the parent.
- [ ] Lane 4. Settle a stage with an owned child still running. Save `child.json`. Pass when completion waits for the child.
- [ ] Lane 5. Exercise refusal, fallback, and budget stop fixtures. Save `limits.json`. Pass when the same exits and cumulative charges appear.
- [ ] Lane 6. Cancel and restart an owned stage. Save `cleanup.json`. Pass when the same owned processes stop before replacement.
- [ ] Lane 7. Run visible tests and review against held-out canaries. Save `holdout.json`. Pass when neither builder nor repair receives private test bytes.
- [ ] Lane 8. Compare every runner-case registration and aggregator import. Save `cases.json`. Pass when all cases run exactly once.
- [ ] Lane 9. Run the real head-owned candidate gate and required native sandbox checks per the boot recipe. Save `native-gate.log`. Pass when every required test runs, the receipt is complete, and old-main transition evidence remains separately labeled.
- [ ] Lane 10. Read the held pi-factorio revision/status through verify-factory under its read grant, or cite a still-valid unchanged receipt. Save `retiring-host.json`. Pass when no write or upgrade occurs and the read result is explicitly old-revision evidence, never head qualification. An unavailable retired host needs the owner-approved replacement read described in the boot recipe.

**Verify, perf.** Tests alone are not sufficient verification. A PR is verified only when its unit, live, and perf boxes are all checked.

- [ ] Metric. Measure process start to `controller_ready` and `npm run check` elapsed time on parent and head. Count model requests separately.
- [ ] Probe. Use the boot recipe on identical isolated held state and dependencies, interleaving three parent/head pairs. Save `perf.json` with raw samples and medians.
- [ ] Baseline. Record the parent startup and check durations before head measurements. For prose-only changes, reuse a valid runtime-identical baseline with the compared blob identities recorded.
- [ ] Rule. Fail if median check time rises by both 20 percent and 10 seconds, startup rises by both 20 percent and 250 ms, an existing deadline fails, or the probe calls a model. Missing readiness or native capacity is BLOCKED, not a zero-duration pass.

**Review gate.** None. L16 is not review-gated.

**Merge.**

- [ ] Record the root's exact-head verdict and complete Bugbot triage. Bind evidence to head, parent, and patch-id.
- [ ] Apply the patch-id rule in `playbooks/shipping.md` at merge prep. Confirm green exact-head CI and clean `git merge-tree`.
- [ ] Hand L16 to the owner as STACK-READY. The owner lands it. Complete any main-backed transition check before its dependent PR proceeds.

## Split CLI dispatch and trusted gate execution (L17)

**Depends on.** L16. Phase 4.

**Files.**

- [ ] Split `server/cli.ts` into `server/cli/{index,serve,owner-feed,metrics,replay,cadence,measurement,platform}.ts`. Merge the L06 collector modules. Split `server/gates.ts` into `server/gates/{gates,materialize,manifest,runner,base}.ts` beside draft-reporter.mjs. Delete the old root modules. Edit service/install/provision entry references and use the shared migration allowance.
- [ ] Have the owner edit only `.github/workflows/ci.yml` command path from server/cli.ts to server/cli/index.ts in the same PR. Keep line 133 held-out validation and actor/check binding unchanged.

**Build.**

- [ ] Pin CLI help, verbs, flags, exits, status/feed bytes, gate receipts, and main-test materialization before extraction. Make index.ts a real dispatch table, not a re-export barrel.
- [ ] Preserve the three trusted glob forms until L19. Update scanner import depth, reporter URL, service ExecStart, installer verified re-execution paths, and provisioner CLI invocation together. Keep WorkingDirectory and checkout identity unchanged.
- [ ] Define the diagnosis materializer identity over every executable module that now implements materialization, not only a thin gates.ts shell. Bind exact source bytes to a deterministic file inventory. Pin a mutation in each extracted materializer file before accepting this split.

**You see.**

- [ ] All existing CLI verbs work through the new real entry, and no gate module disappears from its identity check.

**Verify, unit.** Tests alone are not sufficient verification. A PR is verified only when its unit, live, and perf boxes are all checked.

- [ ] Add CLI and gate receipt characterization before splitting. Run full suite, actual head-owned gate CLI, trusted reporter, root-path and source-identity negative controls, and shell syntax checks.

**Verify, live.** Tests alone are not sufficient verification. A PR is verified only when its unit, live, and perf boxes are all checked. Ten lanes on `task:qa` at the PR head, per the boot recipe.

- [ ] Lane 1. Regression lane against trunk. Run `npm run check` on parent and head with the same native-test setting. Save `check-pair.log`. Pass when both pass, or a pre-existing failure is reproduced and reported as BLOCKED rather than hidden.
- [ ] Lane 2. Compare executed test names and counts using the trusted reporter and the PR move map. Save `test-counts.json`. Pass when every original test runs once, with each added pin accounted for and no unexplained skip.
- [ ] Lane 3. Run every CLI help/argument/exit fixture through the new entry. Save `cli.json`. Pass when the external command contract matches.
- [ ] Lane 4. Compare status and owner-feed on saved state. Save `reads.json`. Pass when stable output bytes match.
- [ ] Lane 5. Run the candidate gate with trusted main-test materialization. Save `gate.json`. Pass when real checks and counts agree with the parent.
- [ ] Lane 6. Mutate each materializer implementation module separately. Save `materializer-negative.json`. Pass when every byte change refuses identity matching.
- [ ] Lane 7. Launch gateway and resolve the draft reporter from the split modules. Save `children.json`. Pass when the actual child and reporter load.
- [ ] Lane 8. Render the service and inspect installer/provisioner invocations. Save `install-paths.json`. Pass when each command names the new real CLI while retaining hold behavior.
- [ ] Lane 9. Run the real head-owned candidate gate and required native sandbox checks per the boot recipe. Save `native-gate.log`. Pass when every required test runs, the receipt is complete, and old-main transition evidence remains separately labeled.
- [ ] Lane 10. Read the held pi-factorio revision/status through verify-factory under its read grant, or cite a still-valid unchanged receipt. Save `retiring-host.json`. Pass when no write or upgrade occurs and the read result is explicitly old-revision evidence, never head qualification. An unavailable retired host needs the owner-approved replacement read described in the boot recipe.

**Verify, perf.** Tests alone are not sufficient verification. A PR is verified only when its unit, live, and perf boxes are all checked.

- [ ] Metric. Measure process start to `controller_ready` and `npm run check` elapsed time on parent and head. Count model requests separately.
- [ ] Probe. Use the boot recipe on identical isolated held state and dependencies, interleaving three parent/head pairs. Save `perf.json` with raw samples and medians.
- [ ] Baseline. Record the parent startup and check durations before head measurements. For prose-only changes, reuse a valid runtime-identical baseline with the compared blob identities recorded.
- [ ] Rule. Fail if median check time rises by both 20 percent and 10 seconds, startup rises by both 20 percent and 250 ms, an existing deadline fails, or the probe calls a model. Missing readiness or native capacity is BLOCKED, not a zero-duration pass.

**Review gate.** None. L17 is not review-gated.

**Merge.**

- [ ] Record the root's exact-head verdict and complete Bugbot triage. Bind evidence to head, parent, and patch-id.
- [ ] Apply the patch-id rule in `playbooks/shipping.md` at merge prep. Confirm green exact-head CI and clean `git merge-tree`.
- [ ] Hand L17 to the owner as STACK-READY. The owner lands it. Complete any main-backed transition check before its dependent PR proceeds.

## Rename the host and rehearse the held upgrade (L18)

**Depends on.** L17. Phase 5.

**Files.**

- [ ] Rename `server/` to `host/` and use the target subsystem map in Appendix B. Move isolation, gateway, bundle, viewer entry, and install files into their named folders. Edit `package.json`, `tsconfig.json`, `.oxlintrc.json`, `biome.json`, `scripts/design-tokens.mjs`, `DESIGN.md`, installer/provision tests, maintenance replay host code, and current install/bridge docs. Use the shared migration allowance.
- [ ] Have the owner replace server roots with host in `.github/factory/gates/gates.json` and change `.github/workflows/ci.yml` to `host/cli/index.ts gates`, in this PR. Keep held-out exclusions, testGlobs, reporter binding, and CI actor checks unchanged.

**Build.**

- [ ] Move modules without changing behavior. Update SOURCE and documentation classification, replay BUNDLE_PATHS, source/bundle asset maps, cadence exclusions, review-seat coverage, verification scripts, scanner relative import, gateway-main URL, reporter URL, all depth calculations, and every materializer identity entry.
- [ ] Keep `host/install/provision.sh` resolving the repository two parents up. Keep install checkout identity at `$HOME/pi-herdr-factorio` and WorkingDirectory unchanged. Rewrite every unit, same-SHA rerun, staging re-exec, continuation validation, and post-install status path to the new real files.
- [ ] Keep old public raw install URLs valid at their old commit pins. Document a full new SHA with host/install/install-exe-dev.sh for new installs. Use the new pinned bootstrap script to upgrade an old install. Do not promise that an old downloaded bootstrap can find a new-revision path.
- [ ] Preserve bundle-relative names and bytes. Update historical replay source selection per revision without executing candidate code. The existing recipe guard rejects equal digests after a changed provision script. Permit only the exact reviewed old/new relocation recipe hash pair as equivalent, with every tool pin and command otherwise unchanged. Any other changed recipe with equal bundle digest still refuses. Record the pair and negative controls in the receipt.
- [ ] Under the owner grant, create a throwaway exe.dev VM and repo integration. Run old pinned installer --check, full held install at 5bd77d5, new pinned --check, upgrade across the rename, same-SHA rerun, and interrupted/failed-upgrade recovery. Prove fresh controller_ready, held status, unchanged state/hold metadata, real sandbox preflight and native stage execution. Retain logs before authorized cleanup. Never upgrade pi-factorio.
- [ ] Hand the new Shep bridge owner-feed command to its owner. Do not edit or restart Shep from this repository task. Defer the actual nubl-factory upgrade to L21 and the owner.

**You see.**

- [ ] The new pinned installer upgrades a real old install while held, and every head command uses host/ with no server shim.

**Verify, unit.** Tests alone are not sufficient verification. A PR is verified only when its unit, live, and perf boxes are all checked.

- [ ] Run full checks, native sandbox tests, package load, trusted gate, shell syntax, service rendering, review routing, cap and bundle lookup, source-root checks, and test-count parity. Preserve generated design token bytes.

**Verify, live.** Tests alone are not sufficient verification. A PR is verified only when its unit, live, and perf boxes are all checked. Ten lanes on `task:qa` at the PR head, per the boot recipe.

- [ ] Lane 1. Regression lane against trunk. Run `npm run check` on parent and head with the same native-test setting. Save `check-pair.log`. Pass when both pass, or a pre-existing failure is reproduced and reported as BLOCKED rather than hidden.
- [ ] Lane 2. Compare executed test names and counts using the trusted reporter and the PR move map. Save `test-counts.json`. Pass when every original test runs once, with each added pin accounted for and no unexplained skip.
- [ ] Lane 3. Run the old and new source mappings against equal-content bundles. Save `bundle.json`. Pass when the digest agrees and both revision-specific source checks pass.
- [ ] Lane 4. Change an unapproved recipe command with the same bundle digest. Save `recipe-negative.json`. Pass when replay refuses while the exact approved relocation pair passes.
- [ ] Lane 5. Resolve SOURCE, BUNDLE_PATHS, materializer identity, gateway, reporter, and roots. Save `paths.json`. Pass when every actual reader reaches the intended file or directory.
- [ ] Lane 6. Run review routing and all four cap lookups across the rename. Save `risk-caps.json`. Pass when no required seat or historical cap disappears.
- [ ] Lane 7. Run --check and fresh held installation on the granted throwaway VM. Save `fresh-install.log`. Pass when preflight is read-only and installation proves fresh readiness with no dispatch.
- [ ] Lane 8. Upgrade that old installation using the new pinned installer, rerun it, and exercise failure recovery. Save `upgrade.log`. Pass when hold/state survive, same-SHA rerun avoids restart, failure stays stopped/disabled/held, and recovery succeeds.
- [ ] Lane 9. Run native sandbox isolation and the real head-owned candidate gate on the disposable VM after upgrade. Save `native-gate.log`. Pass when required sandbox tests run without skips, gate receipts pass, and no production state or model allowance changes.
- [ ] Lane 10. Read the held pi-factorio revision/status through verify-factory under its read grant, or cite a still-valid unchanged receipt. Save `retiring-host.json`. Pass when no write or upgrade occurs and the read result is explicitly old-revision evidence, never head qualification. An unavailable retired host needs the owner-approved replacement read described in the boot recipe.

**Verify, perf.** Tests alone are not sufficient verification. A PR is verified only when its unit, live, and perf boxes are all checked.

- [ ] Metric. Measure process start to `controller_ready` and `npm run check` elapsed time on parent and head. Count model requests separately.
- [ ] Probe. Use the boot recipe on identical isolated held state and dependencies, interleaving three parent/head pairs. Save `perf.json` with raw samples and medians.
- [ ] Baseline. Record the parent startup and check durations before head measurements. For prose-only changes, reuse a valid runtime-identical baseline with the compared blob identities recorded.
- [ ] Rule. Fail if median check time rises by both 20 percent and 10 seconds, startup rises by both 20 percent and 250 ms, an existing deadline fails, or the probe calls a model. Missing readiness or native capacity is BLOCKED, not a zero-duration pass.

**Review gate.** None. L18 is not review-gated.

**Merge.**

- [ ] Record the root's exact-head verdict and complete Bugbot triage. Bind evidence to head, parent, and patch-id.
- [ ] Apply the patch-id rule in `playbooks/shipping.md` at merge prep. Confirm green exact-head CI and clean `git merge-tree`.
- [ ] Hand L18 to the owner as STACK-READY. The owner lands it. Complete any main-backed transition check before its dependent PR proceeds.

## Mirror tests without losing discovery (L19)

**Depends on.** L18, including its main-backed gate and disposable held-upgrade proof. Phase 6.

**Files.**

- [ ] Move non-held-out tests to `test/src/<group>/*.test.ts` and `test/host/<group>/*.test.ts`. Keep `test/integration/`, `test/fixtures/`, and `test/acceptance/` in place. Move sandbox support and fixtures beneath `test/host/sandbox/` without changing their contents. Keep extension and cross-domain cases in named test/src groups as explained in Appendix B.
- [ ] Edit `package.json`, `host/gates/manifest.ts`, the moved candidate-gate coverage test, layout checks, formal runtime test selection, and verification runner commands. Have the owner replace `.github/factory/gates/gates.json` testGlobs atomically with this move. Use the shared migration allowance.

**Build.**

- [ ] Convert the eight sandbox .cases.ts modules into directly discovered .test.ts modules and delete the aggregator. Evidence in Appendix A shows why the old globs cannot remain. Keep fixture helpers non-tests. Preserve execution concurrency and heavy-integration separation.
- [ ] Use visible globs `test/src/**/*.test.ts` and `test/host/**/*.test.ts`, plus the unchanged separate `test/integration/*.test.ts` command. Validate exactly those three forms in the trusted manifest. Keep test/acceptance outside both visible and integration discovery.
- [ ] Run the trusted reporter and compare complete registration identities through an old-to-new test map. Account for every original case, including the 19,049-line orchestrator and 9,394-line runner suites. Permit splits, not deleted or weakened tests. Keep new-candidate-test discovery under test/ and prove a new nested candidate test really runs.
- [ ] Remove obsolete cases filtering only after no maintained .cases.ts files remain. Keep the layout rule rejecting orphan/duplicate cases if a later PR introduces them. Update visible-test planning and test examples in build skills and prompts.

**You see.**

- [ ] The tree mirrors ownership, and visible, trusted, candidate-added, and integration tests all run exactly once.

**Verify, unit.** Tests alone are not sufficient verification. A PR is verified only when its unit, live, and perf boxes are all checked.

- [ ] Pin test inventory before moving. Run full check, native sandbox tests, trusted reporter at both umasks, nested candidate discovery controls, held-out isolation, and formal runtime selection parity.

**Verify, live.** Tests alone are not sufficient verification. A PR is verified only when its unit, live, and perf boxes are all checked. Ten lanes on `task:qa` at the PR head, per the boot recipe.

- [ ] Lane 1. Regression lane against trunk. Run `npm run check` on parent and head with the same native-test setting. Save `check-pair.log`. Pass when both pass, or a pre-existing failure is reproduced and reported as BLOCKED rather than hidden.
- [ ] Lane 2. Compare executed test names and counts using the trusted reporter and the PR move map. Save `test-counts.json`. Pass when every original test runs once, with each added pin accounted for and no unexplained skip.
- [ ] Lane 3. Compare full executed test identities through the move map. Save `test-parity.json`. Pass when every original case occurs once with unchanged pass/skip/todo expectations.
- [ ] Lane 4. Add a deliberately failing nested candidate test. Save `candidate-discovery.log`. Pass when the real candidate_tests gate executes and fails it.
- [ ] Lane 5. Plant a misplaced test and a duplicate cases import. Save `discovery-negative.json`. Pass when layout checks reject both.
- [ ] Lane 6. Run visible tests separately from heavy integration tests. Save `visible.json`. Pass when the heavy replay driver is absent from visible runs and present in integration runs.
- [ ] Lane 7. Run native sandbox tests and trusted reporter at both umasks. Save `native-reporter.log`. Pass when no case is skipped or doubled and receipts are complete.
- [ ] Lane 8. Run formal correspondence selection and held-out checks. Save `formal-heldout.log`. Pass when named runtime cases still run while acceptance stays separately controlled.
- [ ] Lane 9. Run the real head-owned candidate gate and required native sandbox checks per the boot recipe. Save `native-gate.log`. Pass when every required test runs, the receipt is complete, and old-main transition evidence remains separately labeled.
- [ ] Lane 10. Read the held pi-factorio revision/status through verify-factory under its read grant, or cite a still-valid unchanged receipt. Save `retiring-host.json`. Pass when no write or upgrade occurs and the read result is explicitly old-revision evidence, never head qualification. An unavailable retired host needs the owner-approved replacement read described in the boot recipe.

**Verify, perf.** Tests alone are not sufficient verification. A PR is verified only when its unit, live, and perf boxes are all checked.

- [ ] Metric. Measure process start to `controller_ready` and `npm run check` elapsed time on parent and head. Count model requests separately.
- [ ] Probe. Use the boot recipe on identical isolated held state and dependencies, interleaving three parent/head pairs. Save `perf.json` with raw samples and medians.
- [ ] Baseline. Record the parent startup and check durations before head measurements. For prose-only changes, reuse a valid runtime-identical baseline with the compared blob identities recorded.
- [ ] Rule. Fail if median check time rises by both 20 percent and 10 seconds, startup rises by both 20 percent and 250 ms, an existing deadline fails, or the probe calls a model. Missing readiness or native capacity is BLOCKED, not a zero-duration pass.

**Review gate.** None. L19 is not review-gated.

**Merge.**

- [ ] Record the root's exact-head verdict and complete Bugbot triage. Bind evidence to head, parent, and patch-id.
- [ ] Apply the patch-id rule in `playbooks/shipping.md` at merge prep. Confirm green exact-head CI and clean `git merge-tree`.
- [ ] Hand L19 to the owner as STACK-READY. The owner lands it. Complete any main-backed transition check before its dependent PR proceeds.

## Move documentation by authority and freshness (L20)

**Depends on.** L19. Phase 7.

**Files.**

- [ ] Move `docs/design.md` to `docs/architecture.md`, factory-v1.md to `docs/plans/active/factory-v1.md`, exmach-move.md and factorio-vm.md to `docs/plans/later/`, and `docs/statecharts/` to `docs/models/`. Move handoff.md and historical prototypes under `docs/history/`. Create `docs/history/path-map.md` and update indexes.
- [ ] Move still-executed prototype probes into `.pi/skills/verify-factory/probes/`, including their required helpers, and update their test/recipe callers. Edit current docs, AGENTS, READMEs, skills, cadence exclusions, and maintained fixture patch consumers through the shared migration allowance. Keep `docs/decisions.tsv` unchanged.
- [ ] Keep `docs/operations/` and its field reference in `.github/factory/WORKFLOW.md:4` unchanged. If a necessary trusted link change is discovered, stop for a specific owner grant and include it in this PR, never a later broken-main repair.

**Build.**

- [ ] Classify every prototype by actual caller before moving it. Keep acceptance-isolation self-test, build-isolation, held-out repair, trusted-ci fixture driver, and any transitively invoked helper maintained. Move the rest as historical bytes with a banner at the directory index.
- [ ] Update current operations, active plan, AGENTS, and README links and in-range citations. Manually check that cited symbols still support their claims. Historical text retains its old paths behind a banner and the revision-bound old-to-new path map. Do not rewrite decision rows or old experiment results.
- [ ] Move formal models with bytes unchanged, except maintained runtime/view import references and current source-correspondence links. Preserve bounded-result limitations and replay the current runtime selection.
- [ ] Keep this plan at docs/plans/codebase-layout.md until L21 closes it, then move it to plans/later. Update relative links for the deeper active/later plan locations. Keep external operations paths stable for the trusted workflow and published acceptance readers.

**You see.**

- [ ] Current instructions resolve to current code, while historical evidence remains identifiable and unchanged.

**Verify, unit.** Tests alone are not sufficient verification. A PR is verified only when its unit, live, and perf boxes are all checked.

- [ ] Run all plan checkers at their new paths, requiring factory-v1 22/0. Run layout/citation checks, maintained probe self-tests, formal runtime replay, and full check. Compare decision history and archived payload bytes.

**Verify, live.** Tests alone are not sufficient verification. A PR is verified only when its unit, live, and perf boxes are all checked. Ten lanes on `task:qa` at the PR head, per the boot recipe.

- [ ] Lane 1. Regression lane against trunk. Run `npm run check` on parent and head with the same native-test setting. Save `check-pair.log`. Pass when both pass, or a pre-existing failure is reproduced and reported as BLOCKED rather than hidden.
- [ ] Lane 2. Compare executed test names and counts using the trusted reporter and the PR move map. Save `test-counts.json`. Pass when every original test runs once, with each added pin accounted for and no unexplained skip.
- [ ] Lane 3. Resolve current operations, active plan, AGENTS, and README citations. Save `citations.json`. Pass when paths exist, lines are in range, and sampled claims name the correct symbols.
- [ ] Lane 4. Compare decision and archived evidence bytes through the move map. Save `history.json`. Pass when all old rows and archived payloads are unchanged.
- [ ] Lane 5. Execute maintained acceptance/build/repair probe entry checks. Save `probes.log`. Pass when no active recipe depends on an archived or missing program.
- [ ] Lane 6. Run the trusted-ci fixture driver against mapped current paths. Save `fixtures.log`. Pass when patch application failures cannot masquerade as rejected cheating.
- [ ] Lane 7. Run model runtime correspondence from docs/models. Save `models.log`. Pass when the same selected runtime cases pass and model/config hashes agree.
- [ ] Lane 8. Run every plan checker after relocation. Save `plans.log`. Pass when all pass and factory-v1 retains exactly 22 sections.
- [ ] Lane 9. Run the real head-owned candidate gate and required native sandbox checks per the boot recipe. Save `native-gate.log`. Pass when every required test runs, the receipt is complete, and old-main transition evidence remains separately labeled.
- [ ] Lane 10. Read the held pi-factorio revision/status through verify-factory under its read grant, or cite a still-valid unchanged receipt. Save `retiring-host.json`. Pass when no write or upgrade occurs and the read result is explicitly old-revision evidence, never head qualification. An unavailable retired host needs the owner-approved replacement read described in the boot recipe.

**Verify, perf.** Tests alone are not sufficient verification. A PR is verified only when its unit, live, and perf boxes are all checked.

- [ ] Metric. Measure process start to `controller_ready` and `npm run check` elapsed time on parent and head. Count model requests separately.
- [ ] Probe. Use the boot recipe on identical isolated held state and dependencies, interleaving three parent/head pairs. Save `perf.json` with raw samples and medians.
- [ ] Baseline. Record the parent startup and check durations before head measurements. For prose-only changes, reuse a valid runtime-identical baseline with the compared blob identities recorded.
- [ ] Rule. Fail if median check time rises by both 20 percent and 10 seconds, startup rises by both 20 percent and 250 ms, an existing deadline fails, or the probe calls a model. Missing readiness or native capacity is BLOCKED, not a zero-duration pass.

**Review gate.** None. L20 is not review-gated.

**Merge.**

- [ ] Record the root's exact-head verdict and complete Bugbot triage. Bind evidence to head, parent, and patch-id.
- [ ] Apply the patch-id rule in `playbooks/shipping.md` at merge prep. Confirm green exact-head CI and clean `git merge-tree`.
- [ ] Hand L20 to the owner as STACK-READY. The owner lands it. Complete any main-backed transition check before its dependent PR proceeds.

## Qualify the final tree and hand resume to the owner (L21)

**Depends on.** L20 and every pending native, head-owned, and post-merge main-backed check. Last phase.

**Files.**

- [ ] Edit the completion record in this plan and current operations/verification instructions only for verified receipts. Move this plan to `docs/plans/later/codebase-layout.md` when complete and update its index links. Coordinator decision appends require the normal explicit scope. No product implementation or trusted config change belongs here.

**Build.**

- [ ] Run final exact-main CI and the trusted gate against a representative same-layout candidate. Prove held-out isolation, nested test discovery, review routing, replay caps and bundles, package closure, and unchanged CLI contracts. Do not call a local saved-state replay a live factory run.
- [ ] Have the owner upgrade a drained, held nubl-factory using the tested new pinned installer. The owner updates the Shep bridge command and confirms feed polling before any release. Read back fresh readiness, sandbox availability, installed SHA, bundle digest, and held status.
- [ ] Keep pi-factorio at its old commit. Its drain and retirement belong to #712 and #734, not an upgrade in this program. Confirm the separate cutover prerequisites without executing those issues implicitly.
- [ ] Obtain a separate owner resume decision only after all structural PRs L00 to L20 are landed, new-main gates pass, the disposable upgrade is proven, nubl-factory is qualified held, and the old controller is drained/stopped under its own plan. Only the owner removes the local hold or changes factory:enabled. Run one authorized fixture through real stages and exact-head CI after that decision, within unchanged stage allowances, then close the fixture and preserve evidence.
- [ ] Archive this plan only after the completion evidence exists. If any grant or native check is missing, leave the program held and report the exact blocker instead of checking the resume box.

**You see.**

- [ ] The owner receives a qualified held controller and an explicit resume choice, with no upgrade of the retiring VM.

**Verify, unit.** Tests alone are not sufficient verification. A PR is verified only when its unit, live, and perf boxes are all checked.

- [ ] Run final full check, layout guards, packed load, all plan checkers, trusted reporter, and model runtime correspondence. Compare total test identities with the pre-move baseline plus documented added pins.

**Verify, live.** Tests alone are not sufficient verification. A PR is verified only when its unit, live, and perf boxes are all checked. Ten lanes on `task:qa` at the PR head, per the boot recipe.

- [ ] Lane 1. Regression lane against trunk. Run `npm run check` on parent and head with the same native-test setting. Save `check-pair.log`. Pass when both pass, or a pre-existing failure is reproduced and reported as BLOCKED rather than hidden.
- [ ] Lane 2. Compare executed test names and counts using the trusted reporter and the PR move map. Save `test-counts.json`. Pass when every original test runs once, with each added pin accounted for and no unexplained skip.
- [ ] Lane 3. Run all final layout, package, and test-inventory checks. Save `final-layout.json`. Pass when zero reverse edges, complete package closure, and exact case accounting hold.
- [ ] Lane 4. Run trusted main gates on the representative same-layout candidate. Save `main-gate.json`. Pass when every real check passes at the recorded main and candidate SHAs.
- [ ] Lane 5. Read replay caps/bundles for the old baseline and final tree. Save `historical-replay.json`. Pass when both layouts work without executing untrusted historical code.
- [ ] Lane 6. Read back the owner-performed held nubl-factory upgrade. Save `production-held.json`. Pass when fresh readiness, pinned revision, bundle, and dispatch-disabled state are proven.
- [ ] Lane 7. Have the Shep owner confirm the new owner-feed command. Save `bridge.json`. Pass when polling reads the same schema without a missing CLI path.
- [ ] Lane 8. After the separate resume grant, run and close the authorized real fixture. Save `resume.json`. Pass when real stages and exact-head CI reach the expected handoff and cleanup is confirmed.
- [ ] Lane 9. Run the real head-owned candidate gate and required native sandbox checks per the boot recipe. Save `native-gate.log`. Pass when every required test runs, the receipt is complete, and old-main transition evidence remains separately labeled.
- [ ] Lane 10. Read the held pi-factorio revision/status through verify-factory under its read grant, or cite a still-valid unchanged receipt. Save `retiring-host.json`. Pass when no write or upgrade occurs and the read result is explicitly old-revision evidence, never head qualification. An unavailable retired host needs the owner-approved replacement read described in the boot recipe.

**Verify, perf.** Tests alone are not sufficient verification. A PR is verified only when its unit, live, and perf boxes are all checked.

- [ ] Metric. Measure process start to `controller_ready` and `npm run check` elapsed time on parent and head. Count model requests separately.
- [ ] Probe. Use the boot recipe on identical isolated held state and dependencies, interleaving three parent/head pairs. Save `perf.json` with raw samples and medians.
- [ ] Baseline. Record the parent startup and check durations before head measurements. For prose-only changes, reuse a valid runtime-identical baseline with the compared blob identities recorded.
- [ ] Rule. Fail if median check time rises by both 20 percent and 10 seconds, startup rises by both 20 percent and 250 ms, an existing deadline fails, or the probe calls a model. Missing readiness or native capacity is BLOCKED, not a zero-duration pass.

**Review gate.** None. L21 is not review-gated.

**Merge.**

- [ ] Record the root's exact-head verdict and complete Bugbot triage. Bind evidence to head, parent, and patch-id.
- [ ] Apply the patch-id rule in `playbooks/shipping.md` at merge prep. Confirm green exact-head CI and clean `git merge-tree`.
- [ ] Hand L21 to the owner as STACK-READY. The owner lands it. Complete any main-backed transition check before its dependent PR proceeds.

## Close the program

- [ ] Check every box above only against its named evidence. Keep pending grant, bootstrap, native, and production items unchecked.
- [ ] Confirm that the final tree matches Appendix B, all old internal paths are gone, and the dependency guard permits zero reverse edges. Preserve the original test inventory plus documented additions.
- [ ] Confirm that every owner-only action has its grant and result in the coordinator's append-only trail. Preserve `docs/decisions.tsv` history byte for byte.
- [ ] Move this completed plan to `docs/plans/later/codebase-layout.md` in L21 and update its index. Keep factory-v1 under active and the exmach/ms-a2 plans parked.
- [ ] Reply with the autopilot-stack report. Name each PR's verdict, owner landing, grants used, native evidence, resume state, and anything incomplete. Do not equate a green layout check with permission to resume production.

## Appendix A. Prototype evidence

### Four local probes ran at the planning base

The throwaway clone is `$HOME/.herdr/tmp/layout-proto/repo`. It is detached at `5bd77d572cb2bccc9c1e636c0bbe56f086658a56`. No prototype branch or commit was created, consistent with the single-plan-commit policy. The staged rename tree is `e4cee7e28a588bb64ebec10864f2419bf93c915d`. It is a Git tree object, not a commit. Node was v26.13.0.

The instruments and raw output are local artifacts, not shipped verification tools. The coordinator must preserve them in the private trail before scratch cleanup. No VM, model, GitHub mutation, installation, or subagent was used. Existing local dependencies were linked into the scratch clone. The target was settled, so no visual alternatives or moodboard were needed.

Commands run were the following. The source repository was the authorized plan worktree, at the exact base above.

```sh
mkdir -p "$HOME/.herdr/tmp/layout-proto"
git clone --quiet --no-hardlinks --no-checkout . "$HOME/.herdr/tmp/layout-proto/repo"
git -C "$HOME/.herdr/tmp/layout-proto/repo" checkout --quiet --detach 5bd77d572cb2bccc9c1e636c0bbe56f086658a56
# DEPENDENCY_TREE names the existing compatible local dependency tree used by the author.
ln -s "$DEPENDENCY_TREE" "$HOME/.herdr/tmp/layout-proto/repo/node_modules"
node --experimental-strip-types "$HOME/.herdr/tmp/layout-proto/probe.mjs" > "$HOME/.herdr/tmp/layout-proto/probe.log" 2>&1
node "$HOME/.herdr/tmp/layout-proto/edges.mjs" > "$HOME/.herdr/tmp/layout-proto/edges.log"
```

Both Node commands exited 0. `probe.mjs` called the real manifest, review-seat, and replay-cap functions. To inspect trusted discovery without running a full gate, the scratch copy exported the existing private `manifestOf` function without changing its body. This is discovery evidence only, not full candidate-gate or native proof.

### Moving only asset sources preserves the bundle digest

The probe copied the four asset files and every top-level shipped skill file into the existing bundle-relative destinations with mode 0644. It computed the real `manifestDigest`, moved asset sources to `host/bundle/assets`, repeated the copy, and checked the source mappings before and after changing them.

```text
bundle_before=72246ff72955a5eedac3aef19ea07e0b99fa804279ba1c2f3d3546bc868f8499
source_match_before=true
bundle_after=72246ff72955a5eedac3aef19ea07e0b99fa804279ba1c2f3d3546bc868f8499
source_match_stale_mapping=false
source_match_updated_mapping=true
```

The hash covers bundle-relative paths, bytes, symlink targets, and executable bits, not checkout source paths. The probe did not install Node, Herdr, or npm dependencies into a full production bundle. It proves that relocating the source inputs alone does not alter their bundle digest. L18 must still prove complete provisioning and the installed bundle on the throwaway VM.

A separate code finding matters here. The recipe comparison near the end of `checkReplayBundles` refuses a changed `server/provision.sh` when both bundle digests are equal. A rename can trigger that guard despite equal content. L18 preserves the guard with one exact reviewed relocation hash pair, rather than ignoring recipe changes generally. That pair cannot be filled before the actual L18 diff exists.

### The current trusted manifest does not discover mirrored tests

The real manifest reader discovered 40 runner entries, including the integration test and excluding aggregated cases. The probe added failing tests at `test/src/core/layout-probe.test.ts` and `src/layout-probe.test.ts`, then called the same reader again. It next added a mirrored glob to the scratch trusted manifest.

```text
gate_default_tests=40 unchanged=true
gate_tests=40 nested_discovered=false colocated_discovered=false
gate_new_glob=invalid_gate_manifest
```

This settles the baseline-discovery question. It does not mean every candidate-added nested test is ignored. The separate overlay path adds new test files under `test/` to `candidate_tests`, even outside the three baseline globs. L19 must prove that path through a real failing nested candidate test. A test already on trusted main but outside its globs is the silent loss demonstrated here. Colocated `src` tests are not the approved target.

### Review routing and replay caps break on trial renames

The probe loaded `reviewSeats` and `replayStageCaps`, then moved `src/policy.ts` to `src/trust/policy.ts` and `src/run.ts` to `src/core/run.ts` in the scratch index. The replay reader used actual `git show` calls against the baseline and staged tree. No model or fake Git output was used.

```text
review_old=["code-review","security-review","simplify","ultrareview"]
review_trial_rename=["code-review","security-review","simplify"]
caps_base={"accept":100000,"build":400000,"review":120000,"repair":300000}
trial_tree=e4cee7e28a588bb64ebec10864f2419bf93c915d
caps_trial=replay_stage_caps_unavailable
```

The missing seat is silent behavior loss. The cap lookup fails at runtime. L00's guards precede both moves. Historical revision lookup must support the old stored layout as data without preserving old internal import APIs.

### Import counts constrain the move order

`edges.mjs` parsed all 29 `src` files at the exact baseline with TypeScript's AST. It counted distinct ordered file pairs from static imports/exports, type `import()`, and literal dynamic imports. It excluded package imports. Internal means within the proposed group. Outgoing and incoming src columns count cross-group file pairs, not group-to-group pairs.

| Proposed group | Files | Internal | Outgoing src | Incoming src | Outgoing server |
| --- | --- | --- | --- | --- | --- |
| core | 2 | 1 | 5 | 28 | 0 |
| trust | 4 | 3 | 12 | 21 | 1 |
| config | 1 | 0 | 4 | 19 | 1 |
| github | 4 | 3 | 13 | 19 | 1 |
| contract | 3 | 3 | 11 | 17 | 2 |
| candidate | 6 | 10 | 28 | 25 | 6 |
| ledger | 1 | 0 | 6 | 7 | 2 |
| controller | 1 | 0 | 21 | 0 | 1 |
| views | 4 | 1 | 24 | 2 | 5 |
| maintenance | 3 | 0 | 15 | 1 | 4 |

The provisional map assigns run and stages to core, publication to github, artifacts to contract, and diagnosis to candidate. Later splits move particular declarations to their final owner. The baseline has 23 reverse file-pair edges in 16 src files. Fourteen files import sandbox/json.ts.

The group graph is cyclic, so a strict topological order does not exist yet. Even core points upward through type imports and stage transitions. L05 removes those upward shared-contract dependencies first. L06 removes host readers from projections. L07 then moves near-leaf trust and GitHub contracts, followed by config/contracts, candidate/ledger, and finally projection/maintenance/controller consumers. Callers migrate in each PR, so moving a low-level file never requires a shim until a later group moves. The strongly connected candidate/config/contract region stays serial. No claim of a fully acyclic src graph is made.

### What these probes did not settle

No full test suite, npm package load, native sandbox, model check, controller startup timing, installer, or VM upgrade ran during plan authoring. Shared mutable-field boundaries need the per-split characterization and field-access review. The old-to-new installer transition, exact recipe hash pair, full bundle equivalence, and final test-count map remain execution evidence, with named PRs above. This authoring task does not invent their results.

## Appendix B. Alternatives rejected

### The approved target keeps ownership visible

The owner chose option C despite the synthesis recommending B. A would leave mixed ownership intact. B would repair some boundaries but keep the visual distinction between factory and host rules weak. This plan delivers C, with checks and behavior pins before the expensive moves.

The final folder set is the approved set. Extra filenames below fill gaps that source inspection exposed. They add no new top-level architecture layer.

```text
src/
  README.md
  core/
    run.ts json.ts models.ts stages.ts execution.ts journal.ts
  trust/
    policy.ts platform.ts admission.ts markers.ts protected-paths.ts
  config/
    schema.ts parse.ts load.ts views.ts
  github/
    adapter.ts exec.ts tickets.ts publish.ts
  contract/
    contract.ts parse.ts render.ts prompt.ts acceptance.ts artifacts.ts
  candidate/
    state.ts codec.ts handoff.ts build.ts review.ts validation.ts feedback.ts diagnosis.ts stages.ts
  ledger/
    schema.ts append.ts terminal.ts outbox.ts git.ts
  controller/
    orchestrator.ts claims.ts accounting.ts admission.ts launch.ts effects.ts recovery.ts base-check.ts
  views/
    feed.ts attention.ts explain.ts metrics.ts
  maintenance/
    cadence.ts replay.ts scorers.ts
host/
  README.md
  cli/
    index.ts serve.ts owner-feed.ts metrics.ts replay.ts cadence.ts measurement.ts platform.ts
  controller/
    serve-loop.ts lock.ts checkout.ts checkers.ts run-files.ts outbox.ts terminal.ts
    measurement.ts cadence.ts validation-sweep.ts candidate-port.ts state.ts
  sandbox/
    run-stage.ts launch.ts executor.ts receipts.ts visible-tests.ts review.ts specify.ts
    rpc.ts lines.ts settle.ts
  isolation/
    bwrap.ts seccomp.ts preflight.ts scope.ts
  gateway/
    gateway.ts main.ts client.ts routes.ts policy.ts control.ts audit.ts credentials.ts meter.ts
  gates/
    gates.ts materialize.ts manifest.ts runner.ts base.ts draft-reporter.mjs
  viewer/
    server.ts evidence.ts dashboard.ts render.ts claim.ts style.css design/
  bundle/
    assets/ manifest.ts
  install/
    provision.sh install-exe-dev.sh factory.service
test/
  README.md
  src/<group>/*.test.ts
  host/<group>/*.test.ts
  integration/ fixtures/ acceptance/
docs/
  README.md architecture.md decisions.tsv
  plans/active/factory-v1.md
  plans/later/exmach-move.md factorio-vm.md codebase-layout.md
  operations/ models/
  history/handoff.md prototypes/ path-map.md
extension/ skills/ .pi/skills/ .github/ scripts/ tools/ research/
```

In the last two tree rows, the plan filenames all live under plans/later, and the historical prototypes and path map live under history. Unchanged top-level paths stay unchanged. Existing subsystem support files remain alongside their owner rather than disappearing from this abbreviated tree.

These filename adjustments are deliberate.

- `core/execution.ts` holds portable execution results and usage facts currently under sandbox/result. `core/journal.ts` holds pure settlement interpretation currently in audit. The gateway audit writer stays host-side. Moving that entire writer into core would recreate the reverse boundary under another name.
- `candidate/stages.ts` keeps transition policy separate from the shared stage vocabulary in `core/stages.ts`. Treating the current run Stage, SandboxStage, workflow ModelStage, and execution stages as interchangeable would change behavior. Derive constrained subsets from one vocabulary instead.
- `contract/artifacts.ts` retains private contract/acceptance artifact storage omitted from the proposed tree. Its permission and integrity behavior stays pinned. Model-family helpers leave it for core, breaking its direct cycle with review.
- `config/workflow.ts`, `contract/specify.ts`, and `ledger/ledger.ts` are temporary real implementation homes between pure moves and splits. L11 to L13 delete the relevant old APIs. No forwarding file remains at program completion.
- `host/gates/{materialize,manifest,runner,base}.ts` is the concrete split behind the target's gates.ts split. Exact materializer identity covers the executable closure, so extraction cannot hide changed logic behind an unchanged wrapper.
- `host/sandbox/{rpc,lines,settle}.ts` retains process transport helpers. Gateway client/main lose their redundant gateway prefix inside host/gateway. The echo fixture moves to test/host/sandbox support in L19 with its caller; it is not a production entry point.
- Host collection for feed, explain, and replay lives with the CLI modules and reusable host readers created in L06. Domain views accept data. No extra host top-level folder or generic service layer is needed.
- The eight sandbox cases become direct `.test.ts` modules in L19. One test-runner discovery contract is easier to check than preserving an aggregator plus exclusions. Source-only fixtures remain fixtures. The explicit count map prevents duplicate registration.
- The extension test goes to `test/src/views/extension.test.ts` because it checks the domain read interface exposed by the extension. Cross-domain pipeline cases go to `test/src/controller/`. Gate/discovery tests go to `test/host/gates/`; installer tests go to `test/host/install/`; the package test goes to `test/src/core/`. Test README lists these exceptions rather than inventing another group.
- Maintained prototype programs move to `.pi/skills/verify-factory/probes/`, beside their control recipes and under maintained check coverage. Historical payloads move under docs/history unchanged. The trusted-ci patch corpus remains at test/fixtures; its maintained driver gains the current path mapping and must prove each patch applies before judging rejection.

### The sequence avoids shims without breaking trusted main

A wholesale rename first would break review-seat selection, roots, bundle comparison, gate imports, and installed services at once. L00 makes those failures observable. Shared extraction then repairs direction before domain moves. Pure moves precede function splits so a failing pin identifies one kind of change.

Host controller, sandbox, CLI, and gates split under server before the rename. This is a deliberate sequencing adjustment. It separates call-structure changes from filesystem/deployment changes. L17 therefore needs one owner CI entry-path edit; L18 needs the final host edit. Each lands with its matching real entry. Neither requires an old-path wrapper.

The owner approval at program start covers the maintenance transition, not a hidden weakened gate. Old trusted tests really do import old paths. Pausing dispatch prevents the factory from trying to certify these refactors against that incompatible baseline. The ordinary human-PR workflow already distinguishes compatibility from factory certification. After each landing, the new trusted main tests exercise a same-layout candidate before another dependent move proceeds.

### Other rejected approaches

- Keeping `src` dependent on host while adding the entire host to package files would ship a controller merely to load an extension. L06 removes the actual dependency and tests the tarball.
- Compatibility barrels, dual old/new implementations, and symlink aliases would leave two apparent owners. All internal callers migrate and old paths disappear in one PR.
- Colocated src tests would violate the approved test tree and today's gate discovery. L19 changes the exact trusted globs with the tests.
- Rewriting history to fix paths would falsify old evidence and grants. Current docs change; historical artifacts get status banners and a revision-bound map.
- A universal parser, prompts service, or mutable controller facade would add layers without reducing knowledge a reader must hold. Splits follow the existing domain responsibilities and measurable field access.
- A full new formal-verification effort is outside layout work. The maintenance skill wraps existing bounded checks and preserves their incomplete properties.
- Upgrading pi-factorio would spend effort on a host being retired. The owner upgrades nubl-factory only after a separate disposable rehearsal.

## Appendix C. Risks

### Owner-only actions are explicit gates

| Action | PR or phase | Authority and stop condition |
| --- | --- | --- |
| Start program and approve maintenance-transition evidence | Arm | Owner's explicit go, pause confirmation, and scoped grants. No old grant is inferred. |
| Resolve model-routing changes if needed | Arm | Report-only setup first. Owner approval through the supported change flow. |
| Add `.github/README.md` | L00 | Owner edit or coordinator under a grant naming this trusted file. Lands with README coverage. |
| Extend trusted lint/format coverage | L03 | Owner edits gates.json with .pi coverage and preserves test/acceptance ignore. Lands with materialization and root checks. |
| Change trusted CLI entry to server/cli/index.ts | L17 | Owner edits ci.yml with the split entry. Held-out regex and actor/check binding stay unchanged. |
| Replace server with host in trusted roots and CLI command | L18 | Owner edits gates.json and ci.yml in the rename PR. Test globs remain unchanged until L19. |
| Create disposable exe.dev VM/integration, install, upgrade, recover, and clean up | L18 | Separate owner grant for all mutations and any model spend. A real held upgrade precedes production. Cleanup follows evidence capture and its own authorization. |
| Change trusted test globs | L19 | Owner edits gates.json with runner, parser, coverage test, and test moves in one PR. |
| Change a trusted docs reference if discovered necessary | L20 | No change expected because docs/operations stays. Any actual need requires a specific grant before landing the move. |
| Land every PR and any branch/worktree cleanup | L00 to L21 | Owner lands exact verified heads. No standing agent merge grant. Cleanup is separately authorized. |
| Install formal/native verification tools | L04 or any blocked lane | Owner authorization before installation. Missing tools remain a visible evidence gap. |
| Publish branches, open/retarget PRs, write fixtures, comments, labels, or verdicts | Execution only | Each class needs its own grant. A plan or local commit is not such a grant. |
| Upgrade held nubl-factory and change the Shep command | L21 | Owner actions after L18 proof. This repo's agents do not deploy to Shep. |
| Drain/retire pi-factorio | Separate #712/#734 work | Verify prerequisites, but do not execute retirement or upgrade it under the layout plan. |
| Resume dispatch, remove local hold, or change factory:enabled | L21 | Separate owner decision after all code/main/native/held-upgrade gates and cutover prerequisites. |
| Raise a token/time budget or approve proposed perf thresholds | Arm or before the relevant probe | Owner approval before measurement. Existing stage and run limits never shrink to fit a lane. |

The coordinator's explicit trusted edit grant never transfers to a factory builder. Runtime factory patches still cannot edit `.github` or acceptance. Published acceptance files on main are intentional historical outputs, not ordinary tests to rewrite. Any unfinished old-layout run or held-out suite must be drained or kept blocked before resume. No migration deletes its private evidence to start over.

### Code-verified path contracts

These anchors refer to the planning base `5bd77d5`, not current line promises after moves. The author read the implementation, manifest, installer, service, and relevant callers. L00 turns these facts into executable guards.

| Baseline contract | Verified behavior and owner PR |
| --- | --- |
| `server/gates.ts` SOURCE near line 61 and documentation classification near 69 | Candidate source roots are copied from a fixed list. A forgotten host root can disappear or be misclassified as documentation. L03 adds only maintained .pi/skills; L18 replaces server with host. |
| gates overlay near lines 384 to 474 | Main-owned existing tests are retained while candidate source overlays them. Candidate test-import rewrites do not fix old baseline tests. All source moves use the approved paused maintenance transition. |
| gates manifest near 756 to 797 and candidate-gates test near 509 to 552 | Exactly three glob forms are accepted, and cases are omitted from direct runner arguments. L19 changes all sides together. |
| `.github/factory/gates/gates.json` | Lint and format name src, extension, server, test. The explicit held-out ignore stays. L03 adds maintained skill checks; L18 renames the host root; L19 changes testGlobs. |
| `.github/workflows/ci.yml` near 67 and 133 | The CLI file is literal. The held-out directory regex remains test/acceptance with a positive numeric issue. L17/L18 change only the CLI path, not trust binding. |
| `.github/factory/WORKFLOW.md` line 4 | The field reference points at docs/operations/factory-cli.md, which does not move. No gratuitous owner edit is needed. |
| gates scanner import near line 20 | Its relative depth must change with gates.ts. L17 and L18 test the actual import. |
| `src/review.ts` near 604 | Path regex adds ultrareview. L00 pins each branch and every later move updates routing. |
| `src/replay.ts` near 35 and 923 to 926 | BUNDLE_PATHS mixes directories and a provisioner file. Cap lookup reads four constants by file/name via git show. L05/L08/L09 and L18 keep historical and current data layouts explicit. |
| `server/cli.ts` near 516 and controller near 5405 | A one-parent URL assumes root files under server. L15/L17 adjust depth; L18 proves the final root against the actual repository. |
| controller near 2115 and 2149 | Diagnosis compares gate materializer source bytes from a literal path. L17 expands identity to the extracted implementation, L18 updates all mapped paths. |
| gateway-client near 21 and gates near 1596 | The child entry and draft reporter are URL-relative runtime paths. L17/L18 execute their readers. |
| `.pi/skills/verify-factory/scripts/*` | Drivers name CLI and source paths. drive-status copies status-driver to root because its import assumes that location. L03 fixes the staging convention before L17/L18 repoint commands. |
| `src/accept.ts` near 504 | Generated imports assume test/acceptance/issue/checks is four parents below root. That directory does not move. L08/L19 exercise the depth instead of changing the hint to match src depth. |
| `server/factory.service` | WorkingDirectory is the existing checkout and ExecStart names server/cli.ts. L17/L18 change the entry but not checkout identity or service semantics. |
| installer near 64, 69, 115 to 118, 130, 143, 163, 165, 200 | Unit rendering, status, checkout identity, re-execution, provisioning, and continuation all name paths. L18 updates all of them and proves an upgrade on an actual throwaway VM. |
| provisioner near 18 and 149 to 160; manifest near 84 to 87 | Root depth and asset copy maps must agree. L18 keeps bundle destinations unchanged and tests the complete installed result. |
| replay near 977, 987, and its recipe comparison | Historical asset paths and provisioning changes are checked independently of digest. Equal content does not imply the current replay guard accepts a relocated recipe. L18 owns exact relocation-pair evidence. |
| install runbook near 28 and 38 | Raw URLs are commit-pinned. Old URLs keep their files; new pins use host/install. L18 documents both, and L21 hands the new bridge command to its owner. |

### The template is adapted for unchanged runtime behavior

These are intentional adaptations, not completed checks.

1. The six read-only explorers and synthesis already exist. This leaf authored the plan and ran only the four cheap scratch probes. It did not launch another exploration round or a reviewer, contact a VM, or author product code.
2. Installed skill paths use `<pstack>` with runtime resolution instead of a machine-specific home. The checker accepts this. No unavailable skill was silently substituted.
3. Ten lanes remain per PR on `task:qa`, but they are ten named scenarios on real local commands, files, packages, and permitted native systems, not ten model tickets. Logs and JSON replace screenshots. No PR changes an interaction, so each has the required not-review-gated line.
4. Local saved-state and scripted-transport checks prove refactor equivalence, not native service qualification. Required sandbox checks, L18's real installer upgrade, L21's owner upgrade, and the authorized final fixture remain separate gates. A missing grant or machine yields BLOCKED.
5. The retiring-host lane reads pi-factorio only and may carry valid unchanged evidence. If it has been retired, the owner chooses a replacement read target before that lane closes. Head qualification never depends on installing new code there. Production is never the default test target.
6. Prose-only initialization and docs changes may reuse runtime-identical perf or native evidence under the execution playbook, with blob identities recorded. Changed implementation or probe logic needs fresh affected evidence. Reusing a receipt never changes its source revision label.
7. Each code move has two gate verdicts. Before owner landing, the head-owned local gate qualifies the new layout while old-main incompatibility is recorded. After landing, the new trusted-main gate must pass before dependent work. The explicit maintenance approval and paused dispatch make this possible without weakening baseline preservation or adding shims.
8. Formal maintenance uses existing bounded results and commands only. Missing tools or a timeout is not a pass. It does not impose a new requirement to finish previously incomplete accounting or controller state spaces. A safety counterexample still blocks the affected change.
9. Perf thresholds here are proposed comparison rules, not measured baselines or permission to raise program limits. Measure startup to the readiness event, not status polling or an unsupported command. L21's real fixture uses its existing full stage allowances and requires a separate spend grant.
10. The checker prints one count line per PR, then a summary. Success is exit 0 with `22 PR sections, 0 problems`, not silent output. Run it on the new plan and require the unchanged factory plan's own `22 PR sections, 0 problems` at authoring time.

### Risks that remain bounded

The largest uncertainty is how much mutable state the orchestrator and host controller share across proposed splits. L14 and L15 map field access and pin actual persistence/recovery before extracting. If a proposed boundary needs the whole mutable parent or changes a guarantee, stop for a bounded redesign within that PR, not a new framework or weaker test.

Current docs contain substantial path coupling. The audit counted 224 doc lines citing src TypeScript and 275 lines mentioning server. These are audit inventory counts, not promises that every citation is correct. L00 checks existence and range, every move updates current references, and L20 manually checks meaning. A line-range check cannot prove semantic accuracy.

Historical replay is a separate contract from internal import compatibility. Its readers may recognize two stored layouts, but they execute neither revision's code and retain fail-closed identity checks. The exact recipe equivalence pair is deliberately narrow. Any additional recipe or data-format migration needs a separate reviewed change.

The reported pre-existing accept-selfcheck flake and Node provisioning pin discrepancy are tracked in #744. They are not layout fixes. Reproduce and report any failure at both revisions; never remove cases or relax assertions to produce a green refactor verdict.

## Appendix D. Links and reading list

Read the repository's `AGENTS.md`, `docs/plans/factory-v1.md`, `docs/plans/exmach-move.md`, and `docs/decisions.tsv` at the planning base. After L20, use their moved paths from Appendix B. Read `docs/operations/{factory-cli,sandbox,install-exe-dev,owner-feed,human-review,ledger}.md` before changing their commands or claims. Read `DESIGN.md` before any viewer-path work; generated token bytes remain unchanged.

The audit is in the private trails directory under `layout-audit/`. Read `context.md`, `explore-1.md` through `explore-6.md`, and `synthesis.md`. The context's coordinator corrections override the explorers' conflicting JSON-import counts, and synthesis corrects the acceptance-publication and parked-plan claims. The owner's option C choice overrides synthesis's B recommendation. The authoring brief is `layout-audit/plan-brief.md`.

The execution trail follows `<pstack>/skills/show-me-your-work/SKILL.md`. Keep PR briefs, move maps, prototype outputs, exact commands, raw results, and verdicts under the coordinator-resolved private `pi-herdr-factorio-trails/layout/<PR>/` directory. Append decision rows with that skill's `scripts/log.sh`. A model summary is not a receipt. Never put secrets or raw private acceptance/session data into public evidence.

Use these installed skills and playbooks.

- `<pstack>/skills/poteto-mode/playbooks/multi-phase-plan.md` supplies this skeleton. `playbooks/refactoring.md` supplies behavior-pin-first, same-wave caller migration, deletion, and equivalence proof. `playbooks/autopilot-stack.md` governs execution.
- `<pstack>/skills/how/SKILL.md` applies before L05/L06 and L11 through L18. `<pstack>/skills/architect/SKILL.md` applies before those PRs cross function boundaries. Reuse settled evidence rather than reopening option C.
- `<pstack>/skills/interrogate/SKILL.md` applies to the dependency/trust changes in L03/L05/L06, persistence splits L11/L13/L14/L15, and gate/install/discovery changes L17/L18/L19. Reviewers must inspect actual artifacts.
- `<pstack>/skills/technical-writing/SKILL.md`, `unslop/SKILL.md`, and `no-comments/SKILL.md` govern prose and cleanup. Keep required safety comments.
- `<pstack>/skills/create-verification-skill/SKILL.md` and `maintain-verification-skill/SKILL.md` govern L02. `<pstack>/skills/create-formal-verification-skill/SKILL.md` governs the bounded maintenance wrapper in L04, not new proof scope.
- The principles read for this plan are `principle-model-the-domain`, `principle-minimize-reader-load`, `principle-migrate-callers-then-delete-legacy-apis`, `principle-sequence-verifiable-units`, `principle-encode-lessons-in-structure`, `principle-subtract-before-you-add`, `principle-prove-it-works`, and `principle-test-behavior-not-implementation`, each at `<pstack>/skills/<name>/SKILL.md`. Their concrete applications are ownership folders, no pass-through layers, same-wave deletion, checks before moves, executable path rules, removal of duplicate homes, real artifact checks, and observable behavior pins.

Run the checker with the following command, replacing `<pstack>` with the resolved installed package root. At authoring time, the second command must leave factory-v1 unchanged.

```sh
node <pstack>/skills/poteto-mode/scripts/check-plan.mjs docs/plans/codebase-layout.md
node <pstack>/skills/poteto-mode/scripts/check-plan.mjs docs/plans/factory-v1.md
```

