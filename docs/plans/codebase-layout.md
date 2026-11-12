# Make the codebase describe its ownership plan

Reorganize `nublai/pi-herdr-factorio` around factory rules in `src/` and host execution in `host/`.
Deliver the owner's option C, including the navigation, checks, and initialization work from A and B.
Preserve behavior, serialized bytes, authorization, exact-head checks, cumulative budgets, and command names.
Use L00 to L15, with the dependency graph and parallel groups below.
The planning base is `5bd77d572cb2bccc9c1e636c0bbe56f086658a56`. This document grants no execution authority.
`nubl-factory` stays empty until the program lands. Its later fresh held install is an owner action.

## How to read this

One box is one unit of work. Every box names the evidence that checks it. A nested box is a sub-step of the box above it. Check a box only when its evidence exists, a file, a log line, a test run, or a SHA. The body is a how-to. The appendices explain and record.

The program runs the poteto-mode playbook `playbooks/autopilot-stack.md`. The owner lands every PR, L00 to L15. Stop each PR at STACK-READY. There is no standing merge grant. Factory dispatch stays paused throughout the program and remains paused afterwards until the owner completes the separate checklist in Close the program.

Use `<pstack>` for the installed `pi-herdr-pstack` package root. Resolve it through the installed skill inventory and record its version in the private trail. Use `.pi/skills/verify-factory/SKILL.md` as the control skill. Proposed checks, paths, and fixture repositories below are deliverables, not existing capabilities or completed evidence.

Tests alone are not sufficient verification. A PR is verified only when its unit, live, and perf boxes are all checked.

Appendix C records the template adaptations. Ten lane boxes remain per PR, but a box may cite exact-head CI or an explicit N/A supported by unchanged blob identities. N/A never replaces a required behavior check. Production installation and dispatch are not PR acceptance conditions.

## Program checklist

### Arm the program

- [ ] State the protocol and this plan to the operator, then stop. Start execution only on the operator's explicit go. Record separate grants for commits, managed worktrees, pushes, ready PRs, trusted edits, VM reads, disposable environments, fixture writes, model spend, and cleanup. No earlier grant is inferred.
- [ ] Confirm the sole coordinator. Obtain read-only `pi-factorio` version, status, hold, and in-flight-work evidence through verify-factory. Verify whether the hold prevents cadence launches and issue creation as well as ticket dispatch. Record the observed revision rather than assuming the audit's `349934b` is still installed. A hold does not stop observation or in-flight work. Preserve unfinished-run evidence and require the owner to resolve any overlap before moving source.
- [ ] Record the owner's confirmation that `nubl-factory` is empty and stays empty through L15. Do not install or probe an absent controller there. Reserve the only further retiring-host read for L15. No program lane upgrades, uploads to, provisions, or starts a controller on `pi-factorio`.
- [ ] Read these from the installed skill directories at program start. Re-read them at every audit.
  - [ ] Read `<pstack>/skills/poteto-mode/playbooks/autopilot-stack.md` and its referenced `autopilot-full.md`. The stack playbook's no-merge rule governs.
  - [ ] Read the swarm skill at `<pstack>/skills/swarm/SKILL.md`.
  - [ ] Read `.pi/skills/verify-factory/SKILL.md` and its feature index.
  - [ ] Read `<pstack>/skills/poteto-mode/playbooks/opening-a-pr.md`, `playbooks/shipping.md`, and `playbooks/refactoring.md`.
  - [ ] Read the leaf skills in Appendix D before using them.
- [ ] Run report-only `/setup-pstack`. Resolve every child's exact authenticated model and supported thinking level from the live task routing. Shared preference changes require the supported approval flow.
- [ ] Obtain the owner's maintenance-transition approval. Human-authored move PRs use ordinary exact-head `check` and compatibility CI. Old-main tests can import deleted paths, so retain that incompatibility receipt separately. Run head-owned gates before landing, then new-main gates after landing before dependent moves. Do not weaken trusted tests or add shims to hide this transition.
- [ ] Obtain the fixture setup grant described in Appendix C before L13. Name `nublai/pi-herdr-factorio-layout-fixture` as the disposable repository, never silently fall back to production. Approve the configuration-only fixture derivation, repository integration, and VM lifecycle separately. The installer cannot use that repository with `--repo` alone at the planning base.
- [ ] Run the audit at every child delivery, at every stall or no-progress advisory, and on the operator's request. Nothing schedules it, so never promise a timed cadence and never leave the audit to memory.
- [ ] Use this audit prompt, verbatim. "Re-read the execution playbook. Audit the operation against it and fix drift in this audit. Check every active lane and judge progress by side effects only. Cancel a stuck lane and launch its fresh replacement now. Then post a short status message to the operator in chat only when the audit found a tracked change that no earlier status message reported, such as a PR opened, a code-ready head, a round launched or closed, a verdict, a merge, a stuck agent and the action taken, a blocker added or cleared, or a decision only the operator can make. Name every such change and nothing else. Do not repeat a table, the merged list, or an unchanged blocker. If the audit found none, end the turn with no reply text. Either way, log this audit's row in your decision trail. The row names the items reported, or none."
- [ ] On the operator's hold or stand-down, cancel every running child with `subagent_cancel` at once and launch nothing new. Preserve retained work and report authorized cleanup still pending.

### Launch owner rounds

- [ ] Give each PR one owner role with the full lifecycle the execution playbook names. Each round is a fresh bare leaf, with `fork: false`, bounded files, an explicit model and thinking level, and a commit policy. The root owns integration and acceptance.
- [ ] Follow this dependency graph. Branch after the parent merges, or stack on its committed tip. Never set an upstream to `origin/main`.
  - [ ] Start L00 from main.
  - [ ] Start L01 and L02 after L00. P1 permits the prose-only L01 beside the code chain L02 through L10. Its only ordering bound is that it lands before L13. L01 changes instructions and feature prose, not the scripts, probes, or runtime modules. Integrate reference-only doc updates after each landing rather than let parallel writers edit the same files.
  - [ ] Follow L02, L03, L04, L05, L06 in order. L03 is the pure core extraction. L04 separately owns protected paths and stage vocabulary.
  - [ ] Start L07, L08, and L09 after L06. P2 permits their disjoint implementation files to build in separate worktrees. They respectively own candidate state, configuration/contracts, and ledger/publication. The root serializes shared caller-import changes, path-map additions, and baseline edits, then reruns affected checks on the combined tree. Do not treat a clean file merge as integration proof.
  - [ ] Start L10 after L07, L08, and L09. Follow L11, L12, and L13 in order. L13 also requires L01 and the fixture grant.
  - [ ] Start L14 after L13 lands and its owner-triggered real CI run and main-backed gate pass. Start L15 after L14 and all pending native and main-backed proofs.
  - [ ] P3 is read-only verification and independent audits for every PR. Serialize native and perf work that competes for resources. Ten lane boxes do not require ten controllers or ten processes.
- [ ] Hold each Files boundary. Before a move, generate an exact list of imports, path literals, maintained probes, and current citations for its brief. Shared allowances permit only reference changes, not unrelated implementation edits.
- [ ] Apply the shared migration allowance in L02 to L15. It covers direct references in `src/**`, `server/**` before L13, `host/**` from L13, `extension/index.ts`, non-held-out `test/**`, maintained `.pi/skills/**`, `scripts/**`, current docs, READMEs, `AGENTS.md`, and `DESIGN.md`. It also covers runtime references in `docs/statecharts/**`, renamed to `docs/models/**` in L15. Keep `scripts/layout-baseline.json` and `docs/history/path-map.md` current in every move PR. No `.github/**` or `test/acceptance/**` edit follows from this allowance. Each trusted exception is named separately.
- [ ] Update maintained gate-cheating patch targets and context only when paths move. Prove each patch applies and still plants the same defect before judging its rejection. Leave historical experiment payloads unchanged.
- [ ] Keep current citations correct in every PR. Append revision-bound old/new paths and symbol ownership to the path map created in L00. Preserve all old decision rows. Revision-pinned historical citations are checked in history-enabled lanes, never by fetching history from `npm run check`.
- [ ] Hold the review gate. None of L00 to L15 changes an interaction, so none is interaction review-gated. Independent technical review and owner landing remain mandatory.
- [ ] Before a split, run `how` and, for function-boundary changes, `architect`. Reuse the settled option C design. Stop an extraction if it needs the mutable parent object, or more than four mutable fields owned outside the extracted responsibility. Count distinct fields in the proposed boundary report. Leave that responsibility in the composition module and ship fewer files. Allow one field-map review and one proposed boundary, not repeated redesign rounds. Record the omitted files and reason for the owner.

### PR mechanics, for every PR

- [ ] Use `gh` for every PR operation. Confirm identity and repository once. Never require Graphite or set `GH_HOST` locally.
- [ ] Open ready PRs only under a PR grant, per Opening a PR. Use `gh pr create --base <base-branch>`. A stack child targets its parent.
- [ ] Run `npm run check` before each PR-facing push. Push with hooks on and an explicit refspec or the checked-push helper, only under a push grant.
- [ ] Run manual diff cleanup and `/skill:no-comments` before review. Keep required `SAFETY:` comments. Apply technical-writing and unslop to prose.
- [ ] Triage Bugbot and security-reviewer comments per `<pstack>/skills/poteto-mode/references/bugbot-triage.md`. Unavailable integrations are not clean reviews.
- [ ] Rebase onto current trunk before code-ready while retaining a stack parent. Keep that merge base in fix rounds. Rebase again only for merge prep, a conflict, a trunk-caused CI failure, or an overlapping landing. Only the root rewrites topology.
- [ ] Use two commits in each move-and-split PR. Commit one adds characterization against the original home. Commit two moves directly into the proposed folder and splits, migrates callers, and deletes the old home. Do not land an intermediate moved giant in an earlier PR. For host controller and sandbox, split under `server/` first and move their whole subsystem in L13. CLI dispatch stays at `server/cli.ts` until L13 changes its entry exactly once.
- [ ] Retain the full suite and layout checks for pure moves. Report registered test identities, per-file counts, passes, failures, skips, and todos through an explicit move map. Added pins increase the expected count. No test disappears, runs twice, or loses an assertion.

### Verdict and merge, for every PR

- [ ] At the code-ready head SHA and at each later push that changes the patch, run the swarm per `<pstack>/skills/swarm/SKILL.md`. The root launches lanes per `references/fan-out.md`. Use a gates lane, the ten `task:qa` lane boxes, and perf. Two or more audit lanes cover trust and behavior parity. Reviewers use exact authenticated models from a different provider and family than the author. The root audits the receipts before the verdict. Report an unavailable independent review.
- [ ] Require PASS for applicable lanes and an evidenced N/A for exempt lanes. A defect filed as a note is a finding. Batch findings into one fix round. After that round, block only for a user-hit bug, a failed gate, or a wrong shipped doc. File other findings in one authorized follow-up. A minor fix gets one affected verifier. Wording alone gets none. Carry evidence only under the shipping patch-id rule.
- [ ] Keep the pre-merge maintenance verdict distinct from the post-merge main-backed verdict. Missing native evidence is BLOCKED. L13's real CI dispatch runs after owner landing under the explicit bootstrap exception, and blocks L14, not its own prerequisite merge. L15's pre-merge fresh-install proof uses its exact head-derived fixture tree. Its post-merge final-main repeat closes the program, not its own STACK-READY gate.
- [ ] Stop at STACK-READY with the exact head, parent, patch-id, evidence, and pending bootstrap items. The owner lands with `gh pr merge --squash --match-head-commit <sha>` after a verdict comment, green exact-head `check`, and a clean `git merge-tree`. No agent merges or arms auto-merge. Cleanup needs its own grant.

### Boot recipe, for every live lane

- [ ] Record parent and head SHAs. Use isolated local state under `$HOME/.herdr/tmp/` and managed worktrees under `$HOME/.herdr/worktrees/`. Fetch historical objects only in explicitly history-enabled lanes. A depth-1 checkout must run every in-repo guard without network access or skips.
- [ ] Until L13, invoke `node --experimental-strip-types server/cli.ts`. From L13 invoke `node --experimental-strip-types host/cli/index.ts`. Preserve verbs, flags, output, and exit codes. Byte-compare saved-state outputs with a fixed clock where supported, and account separately for unavoidable process fields.
- [ ] For offline readiness/perf, put the existing fixture `gh` executable first on PATH. Supply successful `checkIdentity`, trusted workflow, and `pinVerification` responses, not a blanket denied transport. Deny unexpected requests and model egress. Wait for the real `event=controller_ready` on an isolated held controller. Record this as offline equivalence, not VM proof.
- [ ] Use `.github/workflows/check.yml` at the exact PR head as required native sandbox evidence. It sets `FACTORY_REQUIRE_SANDBOX_TESTS=1` and provisions bwrap and the user bus. Save the run/job identity, commands, and no-skip counts. Do not rerun the identical suite as a second lane. Changed native scenarios may run locally on a capable authorized machine. Missing capacity or a skipped required test remains BLOCKED.
- [ ] Before candidate-gate lanes, verify Docker and the pinned image from `GATE_IMAGE` and `.github/workflows/ci.yml` are available. At the planning base the image is `node@sha256:6d2c7d5d074bf72f81ddc252b4fbb5d625bc028eeda49cb4b8c2ff8eda1ee617`. Tool installs and image pulls need their normal grants. Run parent-owned gates against head to record the transition, then head-owned gates against a same-layout candidate. Repeat new-main gates after landing. Run the trusted reporter at concurrency 2 under umasks 022 and 077 without double-registering cases.
- [ ] Use only the named disposable fixture repository for VM installation lanes, with explicit `--repo nublai/pi-herdr-factorio-layout-fixture` and `--vm <disposable-name>`. Follow Appendix C's reviewed fixture derivation. Keep the hold present. No integration on that VM may write to the production repository. Do not use the installer's production defaults.
- [ ] Read `pi-factorio` only at Arm and L15. Use `FACTORY_VM=pi-factorio` explicitly. Those receipts prove the retiring host was not changed, not head qualification. An already retired host is recorded as unavailable with the owner's retirement evidence, not replaced by a production test target.
- [ ] Save commands, timestamps, exact revisions, configuration-only fixture diffs, expected/actual results, exits, and redacted logs under `$HOME/.herdr/tmp/swarm-<pr-id>/worker-<n>/`, or `/tmp/swarm-<pr-id>/worker-<n>/` on the disposable VM. Copy durable receipts to the private trail before authorized cleanup.
- [ ] For changed runtime, measure `npm run check` and process start to `controller_ready` separately on an idle identical machine. Measure trunk first, then interleave three trunk/head pairs with zero model requests. Fail if check median rises by both 20 percent and 10 seconds, or startup by both 20 percent and 250 ms. Existing deadlines still apply. The owner accepts these proposed comparison thresholds at Arm. Prose-only L01 records runtime blob identities and marks startup/native reruns N/A.

## Install navigation and HEAD-only guards (L00)

**Depends on.** None. Protect every later move.

**Files.**

- [ ] Create `src/README.md`, `server/README.md`, `test/README.md`, `docs/README.md`, `scripts/README.md`, `.pi/README.md`, `.pi/skills/README.md`, `extension/README.md`, `tools/README.md`, and `research/README.md`. Update root README and skills README. Add historical index banners without rewriting evidence.
- [ ] Create `scripts/check-layout.mjs`, `scripts/layout-baseline.json`, `test/layout.test.ts`, and `docs/history/path-map.md`. Create `scripts/check-decisions.mjs`, `scripts/decisions-checkpoint.json`, and `test/decisions-format.test.ts`. Wire both guards in `package.json` here, once. Fix current broken citations in operations and active plans. Do not change `docs/decisions.tsv`.
- [ ] Have the owner add `.github/README.md` under a specific grant. Make no other trusted edit here.

**Build.**

- [ ] Resolve static import/export, type-import, and literal dynamic-import paths for maintained TypeScript, including `.github/**/*.ts`. Fail dangling imports. Start the reverse-edge allowlist at the measured 23 `src` to `server` file pairs in 16 files. Reject any unlisted pair, including future host edges. Owner review permits only shrinking the list. Record status-driver.ts's existing root-copy execution as one exact temporary path-resolution exception, with its staging caller, until L02 removes it. Do not let that exception permit another dangling import.
- [ ] Classify every file under `src/**` and `server/**`, later `host/**`, in the baseline. Record its owner, required review seats, and source lineage for an extraction. Explicitly classify non-code assets too. Fail on an unclassified file, a missing classified file, or actual `reviewSeats` below the recorded requirement. Each extracted file inherits the union of its sources' seats. A new file without lineage needs an explicit reviewed classification. Never infer safety from omission in a move map.
- [ ] Inventory all path readers, not just imports. Cover all four `replayStageCaps` declarations; replay's `BUNDLE_PATHS`, `ls-tree` pathspecs, asset map, and recipe diff; `VISIBLE_LIMIT_MS` in drive-replay and its integration test; formal test selection; CLI/controller roots; SOURCE; materializer bytes; gateway child; draft reporter; provisioner depth; installer continuation; service entry; and acceptance import depth. Assert each HEAD pathspec exists with its expected kind, and every constant reader finds one declaration. Historical-layout variants are data fixtures checked in separate lanes.
- [ ] Inventory literal path tokens in installer, provisioner, service, and `.pi` shell scripts with the owning reader and expected target. Detect removed tokens, added unclassified tokens, and missing targets. Before L02 extracts heredocs, include their source imports and argv predicates in that inventory. Do not claim shell typechecking.
- [ ] Reject executable tests outside runner discovery. Require every retained `.cases.ts` to be imported exactly once. Explicitly exclude `test/acceptance/**` and non-executable fixture payloads from the import/discovery guard. Name the five historical suites under `621/checks/{exact-fit,oversized,prompt-exact}.test.ts` and `645/checks/{exact-empty,unavailable}.test.ts` in test README. They retain their original-revision imports and are not current-main visible tests.
- [ ] Require READMEs for maintained first-party top-level folders, including `.pi` and `.github`. Check current unpinned citations at HEAD for existing paths and in-range lines. Validate revision-pinned citation syntax locally and verify their contents only in history-enabled lanes. Create the revision-bound path map now and append every move, including maintained probes in L02.
- [ ] Check the six-column decisions header, row arity, and timestamps. Commit a checkpoint with historical row count, exact prefix byte length, and SHA-256. Check that prefix against HEAD bytes without needing its parent. Later authorized appends leave the checkpoint fixed or advance it only after a history-enabled lane proves the previous prefix unchanged. State coordinator-only `log.sh` use as procedure, not something a format check can prove.

**You see.**

- [ ] A depth-1 clone passes without fetching history. A dangling trusted import, unclassified extracted file, missed replay asset, or edited historical byte fails.

**Verify, unit.** Tests alone are not sufficient verification. A PR is verified only when its unit, live, and perf boxes are all checked.

- [ ] Add one negative control per reader category and a real shallow-clone guard test. Include `.github/factory/gates/scan.ts` still importing a removed JSON file. Run full check and both plan checkers.

**Verify, live.** Tests alone are not sufficient verification. A PR is verified only when its unit, live, and perf boxes are all checked. Ten lanes on `task:qa` at the PR head, per the boot recipe.

- [ ] Lane 1. Regression lane against trunk. Run full check on both revisions. Save `check-pair.log`. Pass when both pass and added guard tests are accounted for.
- [ ] Lane 2. Compare test identities and discovery. Save `counts.json`. Pass when all original cases run once.
- [ ] Lane 3. Remove the JSON import target in a scratch tree and add a reverse edge. Save `imports.json`. Pass when the trusted importer and new edge both fail the guard.
- [ ] Lane 4. Add an unclassified src file and omit an extraction's inherited seat. Save `seats.json`. Pass when both fail before review routing can weaken.
- [ ] Lane 5. Mutate every inventoried constant/path reader, including replay assets and recipe. Save `readers.json`. Pass when each mutation fails for its intended reason.
- [ ] Lane 6. Plant an unrun test and duplicate a cases import. Save `discovery.json`. Pass when both fail.
- [ ] Lane 7. Check README and current citation coverage with missing/out-of-range controls. Save `navigation.json`. Pass when real paths pass and controls fail.
- [ ] Lane 8. Check decisions with a valid append, truncated row, and changed prefix byte. Save `decisions.json`. Pass when only the valid append passes.
- [ ] Lane 9. Run both guards in a local depth-1 clone with network denied. Save `shallow.log`. Pass when no parent object or fetch is required.
- [ ] Lane 10. Inspect exact-head check.yml native evidence. Save `native-ci.json`. Pass when required sandbox tests ran without skips. No retiring-host read belongs here.

**Verify, perf.** Tests alone are not sufficient verification. A PR is verified only when its unit, live, and perf boxes are all checked.

- [ ] Metric. Measure full-check duration and isolate the added guards' wall time.
- [ ] Probe. Interleave three parent/head checks per the boot recipe. Save `perf.json`.
- [ ] Baseline. Record trunk first. Startup is N/A with runtime blob identities unchanged.
- [ ] Rule. Apply the check-duration rule. Fail any guard network access or model call.

**Review gate.** None. L00 is not review-gated.

**Merge.**

- [ ] Record the exact-head verdict, Bugbot triage, and evidence. Apply `playbooks/shipping.md`'s patch-id rule and confirm green CI and clean merge-tree. Hand L00 to the owner at STACK-READY.

## Initialize agent instructions and verification prose (L01)

**Depends on.** L00. P1 allows this prose-only PR beside L02 through L10.

**Files.**

- [ ] Edit `AGENTS.md`, existing plans for portable installed-skill references, `.pi/skills/verify-factory/SKILL.md`, its feature index, and `features/{factory-status,acceptance,specify,build,replay,review,validation,viewer}.md`. Add `features/installer.md` and `.pi/skills/verify-factory-state/SKILL.md` with small command/coverage references. Do not edit scripts or runtime code.

**Build.**

- [ ] Shorten AGENTS to purpose, routing, authority, placement, and per-path checks. Name autopilot-stack for this program without replacing the historical factory program. Remove workstation paths from tracked plans and the replay recipe's `/home/g/.cache` command. Preserve historical facts and grants.
- [ ] Index replay and normalize the eight feature files to the four headings Sub-features, How to get to it (user POV), Driving it with the named tooling, and Gotchas. Use a disposable VM as the installer example. Cover fresh install, preflight, same-SHA rerun, upgrade, failed upgrade, and fresh hold proof. Describe `nubl-factory` reads only after the owner's post-program fresh install.
- [ ] Wrap existing bounded formal checks, not a new proof effort. Record model/config hashes, runtime correspondence revision, F1 structural, F2 feedback, four F3 witnesses, F4 replay, and incomplete accounting/controller/composed-fault properties. Existing F2 completion is historical evidence, not a new claim. Missing tools need authorization. Keep the documented bounds and expected witness exit 12.

**You see.**

- [ ] A cold agent finds the current program and the right verification procedure without interpreting obsolete handoff text as authority.

**Verify, unit.** Tests alone are not sufficient verification. A PR is verified only when its unit, live, and perf boxes are all checked.

- [ ] Check feature-index equality, four-heading order, links, all plan checkers, and full check. Run one existing F1 check and F3 witness to validate the new formal procedure if its approved tool is available. Missing tool evidence remains blocked.

**Verify, live.** Tests alone are not sufficient verification. A PR is verified only when its unit, live, and perf boxes are all checked. Ten lanes on `task:qa` at the PR head, per the boot recipe.

- [ ] Lane 1. Regression lane against trunk. Run full check and compare all plan checker counts. Save `checks.log`. Pass when both pass and factory-v1 retains 22 sections.
- [ ] Lane 2. Compare runtime, test, script, and native-workflow blobs. Save `blobs.json`. Pass when only authorized prose differs.
- [ ] Lane 3. Compare feature index and files. Save `index.json`. Pass when every recipe appears once.
- [ ] Lane 4. Check the eight repaired recipes and installer headings. Save `headings.json`. Pass when all follow the four-section contract.
- [ ] Lane 5. Resolve skill references and replay example paths. Save `links.json`. Pass when no active command needs a workstation path.
- [ ] Lane 6. Inspect installer procedure against the real script. Save `installer.md`. Pass when explicit target, hold, and separate grants are preserved and nubl-factory stays empty during the program.
- [ ] Lane 7. Run F1 and one F3 witness under their existing bounds. Save `formal.log`. Pass when F1 completes and the intended witness fails with its trace and expected exit, not a safety counterexample.
- [ ] Lane 8. Run F4 and compare the coverage reference to current models. Save `correspondence.log`. Pass when all selected cases pass and limits remain explicit.
- [ ] Lane 9. Runtime/status/native reruns are N/A. Save `runtime-na.json` citing lane 2's blob identities. Pass when no executable change needs fresh runtime evidence.
- [ ] Lane 10. Review AGENTS authority and placement examples. Save `routing.md`. Pass when they route to real owners without granting dispatch, merges, or deployment. No VM read is required.

**Verify, perf.** Tests alone are not sufficient verification. A PR is verified only when its unit, live, and perf boxes are all checked.

- [ ] Metric. Record check duration. Runtime startup is N/A for unchanged executable blobs.
- [ ] Probe. Reuse valid unchanged-runtime evidence and time the docs checks. Save `perf.json` with blob identities.
- [ ] Baseline. Cite the unchanged runtime baseline rather than launch another controller.
- [ ] Rule. Fail an executable diff or model call. Do not invent a startup speedup for prose.

**Review gate.** None. L01 is not review-gated.

**Merge.**

- [ ] Record the independent prose verdict and Bugbot triage. Apply the shipping patch-id rule, confirm green CI and clean merge-tree, and hand L01 to the owner at STACK-READY.

## Move maintained probes into checked code (L02)

**Depends on.** L00 only. It does not wait for L01's prose.

**Files.**

- [ ] Edit `package.json`, `tsconfig.json`, `.oxlintrc.json`, `biome.json`, `server/gates.ts`, relevant tests, and `.pi/skills/verify-factory/scripts/**`. Move maintained programs and transitive helpers from `docs/prototypes/**` to `.pi/skills/verify-factory/probes/**`. Use L00's caller inventory and path map.
- [ ] Include `docs/statecharts/**/*.ts` in maintained checks. Have the owner update `.github/factory/gates/gates.json` lint/format roots for maintained skills and formal TypeScript, preserving held-out exclusions.

**Build.**

- [ ] Pin registered extension output, replay stop deadlines, PID ownership, and replay preparation before changing drivers. Fix status-driver's import where it lives and remove drive-status's root-copy convention. Move executable TypeScript heredocs, including drive-replay's imports and argv checks, into checked `.ts` files beside the driver. Shell scripts only invoke those files with arguments.
- [ ] Move maintained acceptance-isolation, build-isolation, held-out-repair, and trusted-ci probes early, before L03 removes imports. Classify every probe by its real caller and bring maintained code up to the existing lint standard. Keep required SAFETY comments. Do not add a blanket probe exclusion. Historical payload bytes stay in docs.
- [ ] Typecheck, lint, and format `.pi/skills/**/*.ts` and all three existing formal TypeScript files. Include only maintained `.pi/skills` and formal executable inputs in candidate materialization. Exclude private sessions, loops, and daily logs. Do not classify maintained probe Markdown as skipped documentation where a command consumes it.
- [ ] Keep L00 as the sole wiring point for the layout/decision guards. Update integration source readers for the extracted replay driver and inventory its VISIBLE_LIMIT_MS lookup without the permissive fallback hiding a missing declaration. Guard the formal replay's test-selection paths before L14 moves tests.

**You see.**

- [ ] A stale maintained import fails check before a source move lands. The driver runs from its checked-in location.

**Verify, unit.** Tests alone are not sufficient verification. A PR is verified only when its unit, live, and perf boxes are all checked.

- [ ] Run parent/head driver pins, probe self-tests, full check, and candidate materialization controls. Plant a type and lint error in both maintained scopes. Keep every original assertion and registered case.

**Verify, live.** Tests alone are not sufficient verification. A PR is verified only when its unit, live, and perf boxes are all checked. Ten lanes on `task:qa` at the PR head, per the boot recipe.

- [ ] Lane 1. Regression lane against trunk. Run full check and driver pins. Save `checks.log`. Pass when outputs and counts match plus added pins.
- [ ] Lane 2. Compare maintained probe inventories through the move map. Save `probes.json`. Pass when each caller and helper resolves.
- [ ] Lane 3. Run status without a root copy. Save `status.log`. Pass when the registered handler matches its pin.
- [ ] Lane 4. Exercise replay ownership and two-deadline stop calculation. Save `replay.log`. Pass when behavior matches and a missing declaration refuses.
- [ ] Lane 5. Plant type errors in `.pi` and formal TypeScript. Save `type-negative.log`. Pass when ordinary and trusted checks reject both.
- [ ] Lane 6. Plant lint violations in both scopes. Save `lint-negative.log`. Pass when both check paths reject them without exclusions.
- [ ] Lane 7. Inspect the candidate export. Save `materialized.json`. Pass when maintained files exist and private state and acceptance do not enter visible inputs.
- [ ] Lane 8. Run formal runtime selection and probe entry checks. Save `entries.log`. Pass when every selected test and checked probe resolves.
- [ ] Lane 9. Run the real head-owned candidate gate and record old-main transition separately. Save `gate.json`. Pass when required checks execute.
- [ ] Lane 10. Cite exact-head native CI and shallow guard evidence. Save `ci.json`. Pass when no required native case skips and guards need no history.

**Verify, perf.** Tests alone are not sufficient verification. A PR is verified only when its unit, live, and perf boxes are all checked.

- [ ] Metric. Measure full check and driver wall time. Record unchanged product-runtime blobs.
- [ ] Probe. Interleave three parent/head checks and driver runs. Save `perf.json`.
- [ ] Baseline. Record trunk first. Reuse startup evidence only for identical runtime blobs.
- [ ] Rule. Apply the check-duration rule and existing driver deadlines. Fail any unexpected model call.

**Review gate.** None. L02 is not review-gated.

**Merge.**

- [ ] Record exact-head review and Bugbot triage, apply the shipping patch-id rule, and confirm CI/merge-tree. Hand L02 to the owner. Complete the new-main gate before L03.

## Extract portable core contracts (L03)

**Depends on.** L02. This is the pure extraction formerly combined with authorization changes.

**Files.**

- [ ] Create `src/core/{run,json,models,execution,journal}.ts`. Extract from `src/run.ts`, JSON types in tickets, model helpers in review/artifacts, and `server/sandbox/{json,anthropic-limits,result,audit}.ts`. Keep host writers in place. Delete old run, JSON, and model-limit homes after caller migration. Use the shared allowance and existing core/accounting tests.
- [ ] Have the owner change `.github/factory/gates/scan.ts:4` to import `../../../src/core/json.ts` in this PR. This is the explicit trusted exception, not part of the general caller allowance.

**Build.**

- [ ] Pin JSON rejection, observed model families, result/settlement interpretation, unknown usage, and run serialization in commit one. Extract in commit two without consolidating protected-path rules or stage vocabularies. Retain existing unions and runtime order.
- [ ] Break artifacts/review model-family coupling. Move pure journal interpretation, never the gateway audit writer. Avoid widening types to remove upward references. Reduce the exact reverse-edge baseline and classify every extracted file with inherited seats, including core/json's sandbox origin.
- [ ] Update replay's old/new declaration mapping as data. Historical reads refuse missing or ambiguous declarations and never execute code from a requested revision. HEAD guards use only the current tree.

**You see.**

- [ ] Core imports no host implementation, the trusted scanner loads, and no refusal, byte format, or budget changes.

**Verify, unit.** Tests alone are not sufficient verification. A PR is verified only when its unit, live, and perf boxes are all checked.

- [ ] Run pins before and after extraction, full check, the actual scanner/gate entry, review inheritance, and test parity. Check the baseline SHA's caps in a history-enabled lane, not an aggregate guard.

**Verify, live.** Tests alone are not sufficient verification. A PR is verified only when its unit, live, and perf boxes are all checked. Ten lanes on `task:qa` at the PR head, per the boot recipe.

- [ ] Lane 1. Regression lane against trunk. Run full check and core pins. Save `checks.log`. Pass when all original behavior matches.
- [ ] Lane 2. Compare test identities and the move map. Save `counts.json`. Pass when no original test is lost or doubled.
- [ ] Lane 3. Compare JSON and model-family results. Save `core.json`. Pass when all acceptance/refusal cases match.
- [ ] Lane 4. Compare settlement and unknown-usage interpretation. Save `usage.json`. Pass when charges and unknowns match.
- [ ] Lane 5. Load the trusted scanner and invoke gates through the actual CLI. Save `scanner.log`. Pass when no old JSON import remains.
- [ ] Lane 6. Read caps at 5bd77d5 and head with history available. Save `caps.json`. Pass when all four limits match.
- [ ] Lane 7. Test core/json and every extracted file's required seats. Save `seats.json`. Pass when no source loses its inherited review.
- [ ] Lane 8. Count reverse edges and inspect removed homes. Save `edges.json`. Pass when the list shrinks without shims.
- [ ] Lane 9. Run head-owned gates with old-main transition labeled separately. Save `gate.json`. Pass when required checks complete.
- [ ] Lane 10. Cite exact-head native CI and HEAD-only guard results. Save `ci.json`. Pass when both qualify this head.

**Verify, perf.** Tests alone are not sufficient verification. A PR is verified only when its unit, live, and perf boxes are all checked.

- [ ] Metric. Measure startup to controller_ready and full check.
- [ ] Probe. Interleave three parent/head pairs per the boot recipe. Save `perf.json`.
- [ ] Baseline. Record trunk first with the same fixture gh transport.
- [ ] Rule. Apply both boot-recipe regression thresholds and require zero model calls.

**Review gate.** None. L03 is not review-gated.

**Merge.**

- [ ] Record the exact-head verdict and trusted edit grant. Complete Bugbot triage and shipping checks. Hand L03 to the owner and finish the new-main gate before L04.

## Consolidate protected paths and stage vocabulary (L04)

**Depends on.** L03. This PR has its own pins and interrogation.

**Files.**

- [ ] Create `src/trust/protected-paths.ts` and `src/core/stages.ts`. Edit the existing path-policy consumers in src and server, the run/workflow/stages unions, and their tests. Use the shared reference allowance. Do not edit trusted configuration or acceptance files.

**Build.**

- [ ] First pin each current protected-path caller's outcomes for builds, publication, feedback, acceptance, review, and cadence. Include renames, symlinks, and feedback files. Share the `.github` and `test/acceptance` definitions without merging distinct policy decisions.
- [ ] Pin stage order and the run, model, sandbox, and execution subsets. Derive their existing constrained unions from one vocabulary. Keep transition policy outside core and preserve every allowed and refused state.
- [ ] Run an independent interrogation of authorization parity. A newly allowed path or stage is a behavior change, not a refactor. Stop and separate it rather than update the pin.

**You see.**

- [ ] Callers share names and path definitions without sharing authority they did not have before.

**Verify, unit.** Tests alone are not sufficient verification. A PR is verified only when its unit, live, and perf boxes are all checked.

- [ ] Run the full caller-by-caller truth table, subset/type checks, full suite, and test-count parity. Test every new file's review classification.

**Verify, live.** Tests alone are not sufficient verification. A PR is verified only when its unit, live, and perf boxes are all checked. Ten lanes on `task:qa` at the PR head, per the boot recipe.

- [ ] Lane 1. Regression lane against trunk. Run the pinned authorization table on both revisions. Save `policy.json`. Pass when every result matches.
- [ ] Lane 2. Run full check and compare test identities. Save `checks.log`. Pass when every old assertion remains.
- [ ] Lane 3. Try workflow and acceptance edits through build validation. Save `build-paths.json`. Pass when both refuse.
- [ ] Lane 4. Try protected renames and symlinks through publication. Save `publication-paths.json`. Pass when both path sides remain checked.
- [ ] Lane 5. Exercise held-out inline feedback and full-text feedback files. Save `feedback.json`. Pass when no private text reaches a builder.
- [ ] Lane 6. Compare review and cadence path decisions independently. Save `other-policy.json`. Pass when distinct actions remain distinct.
- [ ] Lane 7. Compare all stage subsets and transition order. Save `stages.json`. Pass when no stage becomes newly legal.
- [ ] Lane 8. Remove protected-paths classification in a scratch copy. Save `classification.json`. Pass when the guard refuses the omission.
- [ ] Lane 9. Run head-owned gates. Save `gate.json`. Pass when required checks and the same refusals complete.
- [ ] Lane 10. Cite native CI and the separate authorization audit. Save `audit.json`. Pass when both cover this head with no unresolved policy change.

**Verify, perf.** Tests alone are not sufficient verification. A PR is verified only when its unit, live, and perf boxes are all checked.

- [ ] Metric. Measure controller startup and full check.
- [ ] Probe. Interleave three parent/head pairs. Save `perf.json`.
- [ ] Baseline. Record trunk first under the boot recipe.
- [ ] Rule. Apply both comparison thresholds and unchanged project deadlines. Require zero model calls.

**Review gate.** None. L04 is not review-gated.

**Merge.**

- [ ] Record the exact-head authorization verdict and Bugbot triage. Apply shipping checks, hand L04 to the owner, and complete the new-main gate before L05.

## Separate host collection and close the package (L05)

**Depends on.** L04.

**Files.**

- [ ] Edit `src/{feed,explain,replay}.ts`, host callers under server, and viewer evidence. Create `server/controller/state.ts`, `server/sandbox/receipts.ts`, and collectors under `server/cli/{owner-feed,measurement,replay}.ts`. Edit package files and add `test/package-load.test.ts`. Use the shared allowance.

**Build.**

- [ ] Pin saved-state status/feed bytes, explanation inputs, bundle refusals, and missing/corrupt/wrong-mode behavior first. Keep differing private readers' semantics rather than standardizing them by appearance.
- [ ] Give domain projections explicit data. Host collectors read controller state, receipts, and installed bundles. Keep one reader per responsibility. Reach zero src-to-server and src-to-host edges, including type imports. Remove the temporary reverse-edge allowance.
- [ ] Reproduce the packed-extension missing-file problem at the baseline in isolation. Make package files explicitly include package.json, extension, src, skills, README, and LICENSE. Load the unpacked extension outside the checkout with only declared dependencies and an isolated Pi adapter. Do not ship the controller to mask a reverse dependency. Publish nothing.

**You see.**

- [ ] Domain code imports no host code and the advertised extension loads from its tarball.

**Verify, unit.** Tests alone are not sufficient verification. A PR is verified only when its unit, live, and perf boxes are all checked.

- [ ] Run saved-state and bundle pins, isolated package load, full check, layout guards, and fresh-process read parity.

**Verify, live.** Tests alone are not sufficient verification. A PR is verified only when its unit, live, and perf boxes are all checked. Ten lanes on `task:qa` at the PR head, per the boot recipe.

- [ ] Lane 1. Regression lane against trunk. Compare full check and saved-state reads. Save `checks.log`. Pass when behavior matches apart from the repaired package load.
- [ ] Lane 2. Compare test identities. Save `counts.json`. Pass when old cases run once and the new package case is recorded.
- [ ] Lane 3. Byte-compare owner-feed and status. Save `reads.json`. Pass when state hashes and output agree.
- [ ] Lane 4. Read missing, corrupt, and wrong-mode receipts. Save `errors.json`. Pass when unavailable evidence matches.
- [ ] Lane 5. Test matching and corrupt replay bundles. Save `bundles.json`. Pass when the same refusals occur.
- [ ] Lane 6. Resolve every src import. Save `zero-edges.json`. Pass when both reverse-edge sets are empty.
- [ ] Lane 7. Pack and load outside the checkout on both revisions. Save `package.log`. Pass when baseline failure is reproduced and head registers the real extension.
- [ ] Lane 8. Compare redacted explain inputs. Save `explain.json`. Pass when only the same permitted facts appear.
- [ ] Lane 9. Run head-owned gates. Save `gate.json`. Pass when required checks complete with no private-state materialization.
- [ ] Lane 10. Cite exact-head native CI and package closure inventory. Save `ci.json`. Pass when native tests run and every packaged relative import resolves.

**Verify, perf.** Tests alone are not sufficient verification. A PR is verified only when its unit, live, and perf boxes are all checked.

- [ ] Metric. Measure startup, full check, and package load separately.
- [ ] Probe. Interleave three parent/head startup/check pairs. Save `perf.json`; label the baseline package refusal as unsupported, not fast loading.
- [ ] Baseline. Record trunk first.
- [ ] Rule. Apply startup/check thresholds and require zero model calls. Package loading must succeed without checkout files.

**Review gate.** None. L05 is not review-gated.

**Merge.**

- [ ] Record exact-head review, Bugbot triage, shipping evidence, and green CI. Hand L05 to the owner and finish the new-main gate before L06.

## Move the remaining intact source modules (L06)

**Depends on.** L05. One pure-move PR replaces four separate move groups.

**Files.**

- [ ] Move policy, platform, admission, and markers to `src/trust/`. Move adapters/github, gh, and tickets to `src/github/{adapter,exec,tickets}.ts`. Move accept/artifacts to `src/contract/{acceptance,artifacts}.ts`.
- [ ] Move build, review, validation, feedback, diagnosis, and transition stages to `src/candidate/`. Move feed, attention, explain, and metrics to `src/views/`. Move cadence, replay, and scorers to `src/maintenance/`. Delete empty adapters and old homes. Use the shared allowance.
- [ ] Leave `src/{handoff,workflow,specify,ledger,publication,orchestrator}.ts` where they are. Their later PRs move and split them together, not twice.

**Build.**

- [ ] Keep call structure and behavior unchanged. Update import callers, review routing, cap readers, cadence groups, prompts, fixtures, and current citations in one wave. Append the revision-bound path map. Keep acceptance import depth unchanged.
- [ ] Keep direct owner imports, never index barrels. Preserve marker trust, historical aliases, feedback authority, repair limits, measurement-only behavior, and no self-promotion.

**You see.**

- [ ] Intact modules occupy their domain folders while giant-file callers await one final relocation.

**Verify, unit.** Tests alone are not sufficient verification. A PR is verified only when its unit, live, and perf boxes are all checked.

- [ ] Run the full suite, layout checks, packed load, formal runtime replay, and test-count parity. Compare current and historical caps in a history-enabled lane.

**Verify, live.** Tests alone are not sufficient verification. A PR is verified only when its unit, live, and perf boxes are all checked. Ten lanes on `task:qa` at the PR head, per the boot recipe.

- [ ] Lane 1. Regression lane against trunk. Run full check. Save `checks.log`. Pass when both revisions pass with the same original cases.
- [ ] Lane 2. Compare test identities and every moved path. Save `moves.json`. Pass when all callers resolve without a shim.
- [ ] Lane 3. Run admission, marker, and feedback authority cases. Save `trust.json`. Pass when old refusals and authenticated outcomes match.
- [ ] Lane 4. Store/read acceptance artifacts and execute a generated import at the real four-parent depth. Save `acceptance.log`. Pass when digests/modes match and a three-parent control fails.
- [ ] Lane 5. Compare candidate/stage outcomes. Save `candidate.json`. Pass when exact-head binding, limits, and owner edits remain intact.
- [ ] Lane 6. Compare feed, metrics, cadence, and replay results. Save `consumers.json`. Pass when bytes, denominators, and exclusions match.
- [ ] Lane 7. Read historical/current caps and test every moved file's seats. Save `risk-caps.json`. Pass when neither caps nor required seats disappear.
- [ ] Lane 8. Run formal runtime replay and packed load. Save `entries.log`. Pass when both use the new direct imports.
- [ ] Lane 9. Run head-owned gates and verify cheating fixtures actually apply. Save `gate.json`. Pass when unchanged defects still fail.
- [ ] Lane 10. Cite exact-head native CI and path-map completeness. Save `ci.json`. Pass when no moved file or required native case is omitted.

**Verify, perf.** Tests alone are not sufficient verification. A PR is verified only when its unit, live, and perf boxes are all checked.

- [ ] Metric. Measure startup and full check.
- [ ] Probe. Interleave three parent/head pairs. Save `perf.json`.
- [ ] Baseline. Record trunk first with identical fixture responses.
- [ ] Rule. Apply both boot-recipe thresholds and require zero model calls.

**Review gate.** None. L06 is not review-gated.

**Merge.**

- [ ] Record exact-head review, Bugbot triage, and shipping evidence. Hand L06 to the owner and finish main-backed checks before P2.

## Move and split candidate state and codec (L07)

**Depends on.** L06. P2 with L08 and L09, subject to root-owned integration of shared references.

**Files.**

- [ ] Move/split `src/handoff.ts` directly into `src/candidate/{state,codec,handoff}.ts`. Edit its tests and runtime correspondence references through the shared allowance. Delete the root module. Keep test files discoverable until L14.

**Build.**

- [ ] In commit one, pin valid and invalid stored books through parse, serialize, transition, serialize, and fresh-process reload. Include unknown usage, captured attempts, pending effects, owner recertification, and historical references.
- [ ] In commit two, put state representation in state.ts, wire decoding in codec.ts, and policy in handoff.ts. Preserve every byte and refusal. No schema migration or forwarding exports belong here. Apply the measurable split stop rule and record any smaller result.

**You see.**

- [ ] Policy no longer hides wire decoding, and persisted books resume identically.

**Verify, unit.** Tests alone are not sufficient verification. A PR is verified only when its unit, live, and perf boxes are all checked.

- [ ] Run the pre-move pins, full suite, formal runtime replay, layout checks, and test parity. Recheck affected callers after P2 integration.

**Verify, live.** Tests alone are not sufficient verification. A PR is verified only when its unit, live, and perf boxes are all checked. Ten lanes on `task:qa` at the PR head, per the boot recipe.

- [ ] Lane 1. Regression lane against trunk. Run full check and book pins. Save `checks.log`. Pass when every original behavior matches.
- [ ] Lane 2. Compare test identities. Save `counts.json`. Pass when any test split loses or duplicates nothing.
- [ ] Lane 3. Parse/reserialize every supported book version. Save `books.json`. Pass when bytes and rejection classes match.
- [ ] Lane 4. Restart from a pending effect. Save `restart.json`. Pass when a fresh process emits the same next effect once.
- [ ] Lane 5. Deliver stale and captured callbacks. Save `identity.json`. Pass when old evidence cannot certify a new generation.
- [ ] Lane 6. Exercise owner drift and recertification. Save `owner.json`. Pass when owner bytes and cumulative charges survive.
- [ ] Lane 7. Run formal runtime correspondence. Save `formal.log`. Pass when selected cases pass without a new model claim.
- [ ] Lane 8. Inspect the field boundary and file classification. Save `boundary.json`. Pass when the stop threshold is respected and all new files inherit seats.
- [ ] Lane 9. Run head-owned gates. Save `gate.json`. Pass when required checks complete.
- [ ] Lane 10. Cite native CI and root-owned P2 integration evidence. Save `integration.json`. Pass when all changed callers are checked at the accepted head.

**Verify, perf.** Tests alone are not sufficient verification. A PR is verified only when its unit, live, and perf boxes are all checked.

- [ ] Metric. Measure startup and full check.
- [ ] Probe. Interleave three parent/head pairs. Save `perf.json`.
- [ ] Baseline. Record trunk first.
- [ ] Rule. Apply both boot-recipe thresholds and require zero model calls.

**Review gate.** None. L07 is not review-gated.

**Merge.**

- [ ] Record exact-head review and Bugbot triage. Integrate P2 references, apply shipping checks, and hand L07 to the owner. Finish the new-main gate before L10.

## Move and split configuration and contract knowledge (L08)

**Depends on.** L06. P2 with L07 and L09.

**Files.**

- [ ] Move/split `src/workflow.ts` directly into `src/config/{schema,parse,load,views}.ts` and `src/specify.ts` into `src/contract/{contract,parse,render,prompt}.ts`. Move acceptance binding from candidate diagnosis into contract acceptance. Delete root modules and migrate direct callers through the shared allowance.

**Build.**

- [ ] Pin valid/invalid YAML, loaded snapshot identity, last-valid reload, contract digests, rendered comments, prompt framing, and acceptance bindings in commit one. Account for nonce-bound payloads without removing untrusted content from comparison.
- [ ] Move and split in commit two. Keep GitHub mechanics in config/load through the existing exec contract. Keep prompts beside their domain. Add no universal parser or prompt service. Preserve the main-only trust boundary and core stage subsets.
- [ ] Leave the three published `test/acceptance/621` suites unchanged as historical artifacts. Test README and the explicit guard exclusion explain their original-revision imports. New acceptance suites use current paths and the unchanged four-parent root depth.

**You see.**

- [ ] Parsing, loading, representation, and prompts have distinct owners without temporary workflow/specify homes.

**Verify, unit.** Tests alone are not sufficient verification. A PR is verified only when its unit, live, and perf boxes are all checked.

- [ ] Run characterization before and after, full suite, package load, layout checks, and P2 integration checks.

**Verify, live.** Tests alone are not sufficient verification. A PR is verified only when its unit, live, and perf boxes are all checked. Ten lanes on `task:qa` at the PR head, per the boot recipe.

- [ ] Lane 1. Regression lane against trunk. Run full check and parsing pins. Save `checks.log`. Pass when errors and successful values match.
- [ ] Lane 2. Compare test identities. Save `counts.json`. Pass when every original case runs once.
- [ ] Lane 3. Parse the full valid/invalid workflow corpus. Save `parse.json`. Pass when all refusal classes match.
- [ ] Lane 4. Reload invalid settings after a valid snapshot. Save `reload.json`. Pass when the previous digest stays valid with an explicit error.
- [ ] Lane 5. Render fixed contracts and comments. Save `render.json`. Pass when stable bytes and inert text handling match.
- [ ] Lane 6. Inspect nonce framing and complete prompt payloads. Save `prompts.json`. Pass when no payload is dropped to make comparisons pass.
- [ ] Lane 7. Exercise every acceptance/base identity mismatch. Save `binding.json`. Pass when each still refuses.
- [ ] Lane 8. Load the packed extension and new generated acceptance imports. Save `entries.log`. Pass when both resolve while historical suites remain unchanged.
- [ ] Lane 9. Run head-owned gates. Save `gate.json`. Pass when required checks complete.
- [ ] Lane 10. Cite native CI and P2 integration evidence. Save `integration.json`. Pass when the final callers and classifications are checked.

**Verify, perf.** Tests alone are not sufficient verification. A PR is verified only when its unit, live, and perf boxes are all checked.

- [ ] Metric. Measure startup and full check.
- [ ] Probe. Interleave three parent/head pairs. Save `perf.json`.
- [ ] Baseline. Record trunk first.
- [ ] Rule. Apply both boot-recipe thresholds and unchanged deadlines. Require zero model calls.

**Review gate.** None. L08 is not review-gated.

**Merge.**

- [ ] Record exact-head review and Bugbot triage, integrate P2 references, and apply shipping checks. Hand L08 to the owner and finish the new-main gate before L10.

## Move and split ledger storage and publication (L09)

**Depends on.** L06. P2 with L07 and L08.

**Files.**

- [ ] Move/split `src/ledger.ts` directly into `src/ledger/{schema,append,terminal,outbox}.ts`. Move `src/publication.ts` to `src/github/publish.ts`, extracting its ledger Git operations into `src/ledger/git.ts` in the same PR. Delete root homes. Update ledger/publication tests and shared references.

**Build.**

- [ ] Pin v1 through v5 row bytes, append/adopt/conflict outcomes, terminal evidence, and outbox restart recovery in commit one. Use real temporary Git state.
- [ ] Move and split in commit two. Keep candidate publication in github/publish and ledger storage in ledger/git. Preserve one serial writer, no force-push, monotonic usage, and unknown evidence.
- [ ] Read artifacts after a fresh-process restart. Reusing a prepared object is not restart proof. Apply the split stop rule rather than add a mutable-parent facade.

**You see.**

- [ ] Ledger schema and storage have named owners without changing a historical row or publication request.

**Verify, unit.** Tests alone are not sufficient verification. A PR is verified only when its unit, live, and perf boxes are all checked.

- [ ] Run temporary-Git characterization, full check, interruption/restart parity, count mapping, and affected P2 integration checks.

**Verify, live.** Tests alone are not sufficient verification. A PR is verified only when its unit, live, and perf boxes are all checked. Ten lanes on `task:qa` at the PR head, per the boot recipe.

- [ ] Lane 1. Regression lane against trunk. Run full check and ledger pins. Save `checks.log`. Pass when all behavior matches.
- [ ] Lane 2. Compare test identities. Save `counts.json`. Pass when every original case runs once.
- [ ] Lane 3. Read/reserialize all supported row versions. Save `rows.json`. Pass when old bytes match.
- [ ] Lane 4. Append the same run twice to a temporary Git ledger. Save `append.log`. Pass when only one row remains.
- [ ] Lane 5. Interrupt after a Git write and reload from disk. Save `restart.log`. Pass when the outbox reconciles without another append.
- [ ] Lane 6. Advance the remote tip between read and append. Save `conflict.log`. Pass when the same bounded outcome occurs without force-push.
- [ ] Lane 7. Compare merged, failed, and unknown-cost terminal evidence. Save `terminal.json`. Pass when outcomes and charges agree.
- [ ] Lane 8. Run candidate publication separately. Save `publication.log`. Pass when candidate commits and requests are unchanged.
- [ ] Lane 9. Run head-owned gates. Save `gate.json`. Pass when required checks complete.
- [ ] Lane 10. Cite native CI and P2 integration evidence. Save `integration.json`. Pass when accepted callers and source identities are checked.

**Verify, perf.** Tests alone are not sufficient verification. A PR is verified only when its unit, live, and perf boxes are all checked.

- [ ] Metric. Measure startup and full check.
- [ ] Probe. Interleave three parent/head pairs. Save `perf.json`.
- [ ] Baseline. Record trunk first.
- [ ] Rule. Apply both boot-recipe thresholds and require zero model calls.

**Review gate.** None. L09 is not review-gated.

**Merge.**

- [ ] Record exact-head review, Bugbot triage, and integrated shipping evidence. Hand L09 to the owner and finish the new-main gate before L10.

## Move and split scheduling by owned state (L10)

**Depends on.** L07, L08, and L09, integrated and checked.

**Files.**

- [ ] Move/split `src/orchestrator.ts` directly into `src/controller/orchestrator.ts` plus claims, accounting, admission, launch, effects, recovery, and base-check modules that meet the split rule. Edit orchestrator tests and helpers. Delete the root module and migrate callers.

**Build.**

- [ ] Map private-field ownership and count boundary fields. Pin ordered events, persisted claims, requests, slots, and cumulative accounting over tick, completion, and restart in commit one.
- [ ] Move/split in commit two. Keep tick ordering and slot arbitration in orchestrator. Give extracted responsibilities narrow data inputs and explicit effects. If the boundary needs the parent or more than four foreign mutable fields, leave it in orchestrator and ship fewer files. Record the exact omitted responsibilities.
- [ ] Split the 19,049-line baseline test only by existing behavior groups, preserving names/assertions and a registration map. Keep its runnable location until L14. Fake only external infrastructure, not preparation or persistence.

**You see.**

- [ ] Readers find cohesive scheduling responsibilities without a second authority or a broad mutable facade.

**Verify, unit.** Tests alone are not sufficient verification. A PR is verified only when its unit, live, and perf boxes are all checked.

- [ ] Run pre-split event and fresh-process recovery pins, full suite, layout checks, and complete test parity. Cite native CI for unchanged sandbox cases.

**Verify, live.** Tests alone are not sufficient verification. A PR is verified only when its unit, live, and perf boxes are all checked. Ten lanes on `task:qa` at the PR head, per the boot recipe.

- [ ] Lane 1. Regression lane against trunk. Run full check and event pins. Save `checks.log`. Pass when ordered behavior matches.
- [ ] Lane 2. Compare all orchestrator registrations. Save `counts.json`. Pass when no case is dropped or duplicated.
- [ ] Lane 3. Compare tick traces with identical external responses. Save `tick.json`. Pass when requests and persisted bytes agree.
- [ ] Lane 4. Drive three issues with two slots. Save `slots.json`. Pass when capacity and single-writer behavior match.
- [ ] Lane 5. Restart at claim, launch, and completion boundaries. Save `recovery.json`. Pass when captured identity and usage floors survive disk reload.
- [ ] Lane 6. Deliver late, duplicate, and unknown-cost results. Save `accounting.json`. Pass when charges and refusals match.
- [ ] Lane 7. Drive acceptance refusal and bounded retry. Save `base-check.json`. Pass when no extra attempt or uncharged work appears.
- [ ] Lane 8. Audit the measured field map and any fewer-files outcome. Save `boundary.md`. Pass when every extraction meets the threshold without weakening a pin.
- [ ] Lane 9. Run head-owned gates. Save `gate.json`. Pass when required checks complete.
- [ ] Lane 10. Cite exact-head native CI and formal runtime replay. Save `ci.json`. Pass when no selected behavior or native case is skipped.

**Verify, perf.** Tests alone are not sufficient verification. A PR is verified only when its unit, live, and perf boxes are all checked.

- [ ] Metric. Measure startup and full check.
- [ ] Probe. Interleave three parent/head pairs. Save `perf.json`.
- [ ] Baseline. Record trunk first.
- [ ] Rule. Apply both boot-recipe thresholds and existing deadlines. Require zero model calls.

**Review gate.** None. L10 is not review-gated.

**Merge.**

- [ ] Record exact-head review and any reduced split, complete Bugbot triage and shipping checks, and hand L10 to the owner. Finish the new-main gate before L11.

## Split the host controller before deployment paths move (L11)

**Depends on.** L10.

**Files.**

- [ ] Split `server/controller.ts` into `server/controller/{serve-loop,lock,checkout,checkers,run-files,outbox,terminal,measurement,cadence,validation-sweep,candidate-port,state}.ts` where the stop rule permits. Merge L05's state reader. Delete controller.ts and migrate callers. Keep the real CLI at `server/cli.ts`.

**Build.**

- [ ] Pin real preparation, files, subprocess settlement, publication requests, and fresh-process recovery in commit one. Keep existing private-file modes and corruption semantics.
- [ ] Extract in commit two with serve-loop as host composition, not another scheduler. Keep one outbox and validation sweep. Measure each proposed boundary against the four-field/parent-object stop condition and ship fewer files if it fails.
- [ ] Test repository-root depth from the extracted code. Preserve diagnosis materializer byte identity, captured execution, cleanup ownership, deadlines, and charges. Update maintained replay imports now, not at the later host rename.

**You see.**

- [ ] Host I/O has separate owners while readiness, service entry, and recovery remain unchanged.

**Verify, unit.** Tests alone are not sufficient verification. A PR is verified only when its unit, live, and perf boxes are all checked.

- [ ] Run host pins, real local preparation/restart tests, full check, saved-state parity, and affected native scenarios.

**Verify, live.** Tests alone are not sufficient verification. A PR is verified only when its unit, live, and perf boxes are all checked. Ten lanes on `task:qa` at the PR head, per the boot recipe.

- [ ] Lane 1. Regression lane against trunk. Run full check and host pins. Save `checks.log`. Pass when all original outcomes match.
- [ ] Lane 2. Compare test identities and source lineage. Save `counts.json`. Pass when every case and extracted file is accounted for.
- [ ] Lane 3. Prepare/persist a candidate through real local checkout code. Save `prepare.json`. Pass when tree and receipt identities agree.
- [ ] Lane 4. Restart with pending outbox/terminal files. Save `restart.json`. Pass when effects reconcile once and charges survive.
- [ ] Lane 5. Resolve cadence's repository root from the new module. Save `root.json`. Pass when Git uses the repository, not server/.
- [ ] Lane 6. Compare materializer identity with a changed-source control. Save `materializer.json`. Pass when altered bytes refuse.
- [ ] Lane 7. Sweep expired validation with owned and foreign refs. Save `sweep.json`. Pass when only owned refs are removed and deadlines persist.
- [ ] Lane 8. Start the held controller with fixture gh and inspect field boundaries. Save `ready-boundary.json`. Pass when real readiness arrives and all splits meet the stop rule.
- [ ] Lane 9. Run head-owned gates. Save `gate.json`. Pass when required checks complete.
- [ ] Lane 10. Cite native CI and execute the checked replay driver's affected entry. Save `ci-driver.json`. Pass when both resolve the new controller homes.

**Verify, perf.** Tests alone are not sufficient verification. A PR is verified only when its unit, live, and perf boxes are all checked.

- [ ] Metric. Measure startup and full check.
- [ ] Probe. Interleave three parent/head pairs. Save `perf.json`.
- [ ] Baseline. Record trunk first with working fixture identity and workflow responses.
- [ ] Rule. Apply both thresholds. A refusal before readiness is not a timing sample. Require zero model calls.

**Review gate.** None. L11 is not review-gated.

**Merge.**

- [ ] Record exact-head review, boundary outcomes, and Bugbot triage. Apply shipping checks, hand L11 to the owner, and finish the new-main gate before L12.

## Split stage execution and receipt handling (L12)

**Depends on.** L11.

**Files.**

- [ ] Split `server/sandbox.ts` into `server/sandbox/{run-stage,launch,executor,receipts,visible-tests,review,specify}.ts` where cohesive. Merge the L05 receipt reader. Delete sandbox.ts and migrate callers, including the checked replay driver and integration constant reader. Keep gateway/isolation paths until L13.

**Build.**

- [ ] Pin settlement order, captured model identity, receipts, refusal/fallback, limits, and cleanup in commit one. Keep pure shared facts in core.
- [ ] Split in commit two without a forwarding index. Preserve process lifetimes and one owner per execution. Apply the measurable stop rule. Update every VISIBLE_LIMIT_MS reader and the path map in this PR.
- [ ] Split the 9,394-line runner cases by behavior if useful, preserving every assertion and the single aggregator until L14.

**You see.**

- [ ] Execution assembly is separate from stage driving, and settlement still waits for all owned work.

**Verify, unit.** Tests alone are not sufficient verification. A PR is verified only when its unit, live, and perf boxes are all checked.

- [ ] Run stage pins, full check, affected native scripted-model scenarios, replay-driver integration, and runner registration parity. Use exact-head CI for the remaining native suite.

**Verify, live.** Tests alone are not sufficient verification. A PR is verified only when its unit, live, and perf boxes are all checked. Ten lanes on `task:qa` at the PR head, per the boot recipe.

- [ ] Lane 1. Regression lane against trunk. Run full check and stage pins. Save `checks.log`. Pass when original outcomes match.
- [ ] Lane 2. Compare every runner-case registration. Save `cases.json`. Pass when all cases run exactly once.
- [ ] Lane 3. Run a scripted-model stage through the real gateway. Save `stage.json`. Pass when settlement and receipt fields agree.
- [ ] Lane 4. Settle a parent while an owned child runs. Save `child.json`. Pass when completion waits for the child.
- [ ] Lane 5. Exercise refusal, fallback, and budget stops. Save `limits.json`. Pass when exits and cumulative charges match.
- [ ] Lane 6. Cancel/restart an owned stage. Save `cleanup.json`. Pass when owned work stops before replacement.
- [ ] Lane 7. Run visible/review checks with held-out canaries. Save `holdout.json`. Pass when no private bytes reach builder or repair inputs.
- [ ] Lane 8. Run both visible-deadline readers with a missing-declaration control. Save `deadline.json`. Pass when the actual limit resolves and absence refuses, without fallback masking.
- [ ] Lane 9. Run head-owned gates. Save `gate.json`. Pass when required checks complete.
- [ ] Lane 10. Cite native CI and inspect new module classifications/boundaries. Save `ci-boundary.json`. Pass when no native case skips and every split meets the rule.

**Verify, perf.** Tests alone are not sufficient verification. A PR is verified only when its unit, live, and perf boxes are all checked.

- [ ] Metric. Measure startup and full check.
- [ ] Probe. Interleave three parent/head pairs. Save `perf.json`.
- [ ] Baseline. Record trunk first.
- [ ] Rule. Apply both boot-recipe thresholds and existing stage deadlines. Require zero provider model calls for scripted probes.

**Review gate.** None. L12 is not review-gated.

**Merge.**

- [ ] Record exact-head review and Bugbot triage, apply shipping checks, and hand L12 to the owner. Finish the new-main gate before L13.

## Rename host paths and prove both install modes (L13)

**Depends on.** L12, L01, and the owner-approved disposable fixture setup.

**Files.**

- [ ] Rename server to host using Appendix B. Move/split the real `server/cli.ts` directly into `host/cli/{index,serve,owner-feed,metrics,replay,cadence,measurement,platform}.ts`, merging L05 collectors. Move/split gates into `host/gates/{gates,materialize,manifest,runner,base}.ts` beside draft-reporter.mjs. Delete old entries, never forward them.
- [ ] Move isolation, gateway, viewer entry, bundle, and install files to their final host folders. Edit package/check roots, design-token generator paths, DESIGN references, installer/provision tests, replay source mappings, and current install/bridge docs. Preserve generated token bytes.
- [ ] Have the owner replace server roots with host in `.github/factory/gates/gates.json` and change `.github/workflows/ci.yml:67` to `host/cli/index.ts gates` in this PR. Keep test globs, held-out validation, actors, and check binding unchanged. The scanner already imports core/json from L03.

**Build.**

- [ ] Commit one pins CLI help/flags/exits, status/feed bytes, gate receipts, and materialization. Commit two performs the direct CLI/gate move-and-split and the subsystem rename. This is the only CLI entry-path change. Preserve all command names.
- [ ] Update SOURCE, replay BUNDLE_PATHS and every `ls-tree`/asset/recipe path, cadence exclusions, review coverage, gateway child URL, reporter URL, shell token inventory, and roots. Define materializer identity over every executable module in its implementation, not a thin wrapper. Mutate each member to prove coverage.
- [ ] Resolve provision.sh two parents up. Keep checkout identity and WorkingDirectory unchanged. Update every installer unit/status/re-exec/continuation path together. Old raw URLs remain valid at old pinned commits. New pins use `host/install/install-exe-dev.sh`. Document a fixture runbook example that uses the fixture repository for both the pinned raw download URL and `--repo`, with an explicit disposable `--vm`; keep the production example separate. An old bootstrap given a new-layout SHA must place/retain the hold and fail before any service stop.
- [ ] Keep bundle-relative names and bytes. Read historical layouts as data. Compare each revision's actual recipe, not an absent old path. Permit only the exact reviewed old/new relocation recipe hash pair as equivalent when digests match. All other recipe changes still refuse, including old-to-old and new-to-new changes.
- [ ] On a clean disposable VM, follow the updated install runbook literally with the documented fixture overrides and new pinned bootstrap. Prove a fresh held install at this head-derived fixture revision. On a second clean VM, install the 5bd77d5-derived fixture revision, then upgrade with the new bootstrap. Do not call the old install a new-layout fresh-install test. Prove same-SHA no-restart, failed/interrupted-upgrade recovery, new readiness, hold/state retention, sandbox preflight, and native stage execution.
- [ ] After owner landing, have the owner trigger the real `ci.yml` on product main with a same-layout fixture candidate and valid nonce. Under a separate fixture grant, prepare that candidate in the product repository with one owner-authored current-layout suite under `test/acceptance/<fixture-issue>/checks/`, using an unlabelled fixture issue. Supply its exact candidate SHA, heldout_dir, computed heldout_digest, and the canonical empty replacements list/digest. Do not use the VM's configuration-derived fixture commit as this candidate. Require the gates job and exact-SHA receipt to pass. Expect report to fail its bot-actor assertion for the human dispatch, with no factory certification posted. Save both job conclusions and close the fixture under its grant. This explicit bootstrap check blocks L14. Do not weaken the reporter to make the workflow green.

**You see.**

- [ ] The disposable environments prove both a fresh new-layout install and a pre-to-post-rename upgrade. The production host remains empty.

**Verify, unit.** Tests alone are not sufficient verification. A PR is verified only when its unit, live, and perf boxes are all checked.

- [ ] Run full check, package load, real gate CLI, shell syntax, service rendering, review/cap/bundle/root checks, materializer mutations, and count parity. Verify all five published acceptance suites remain unchanged and explicitly outside current import checks.

**Verify, live.** Tests alone are not sufficient verification. A PR is verified only when its unit, live, and perf boxes are all checked. Ten lanes on `task:qa` at the PR head, per the boot recipe.

- [ ] Lane 1. Regression lane against trunk. Run full check and CLI/gate pins. Save `checks.log`. Pass when command behavior and all original cases match.
- [ ] Lane 2. Compare registrations, package closure, and service commands. Save `entries.json`. Pass when no server shim or second CLI transition exists.
- [ ] Lane 3. Check old/new equal-content bundles, then alter post-rename stage-init.ts with a self-consistent installed manifest. Save `assets.json`. Pass when relocation passes but stale source/bundle bytes refuse.
- [ ] Lane 4. Test the exact relocation recipe pair plus unauthorized old-to-old and new-to-new recipe changes with equal digests. Save `recipes.json`. Pass when only the reviewed pair is exempt and both negative controls refuse.
- [ ] Lane 5. Exercise actual roots, gateway/reporter launch, materializer mutations, and shell path inventory. Save `paths.json`. Pass when real readers resolve and every changed materializer member refuses identity matching.
- [ ] Lane 6. Run every CLI contract, review classification, and historical/current cap read. Save `contracts.json`. Pass when verbs, seats, and all four limits are unchanged.
- [ ] Lane 7. Follow the updated runbook on a clean new-layout disposable VM. Save `fresh-install.log`. Pass when --check is read-only and the fresh install proves new readiness, sandbox availability, and dispatch disabled.
- [ ] Lane 8. On the separate old-layout VM, try old-bootstrap/new-SHA, then perform the new-bootstrap upgrade, rerun, and failure recovery. Save `upgrade.log`. Pass when the negative case holds before failing without stopping the old service, the upgrade preserves state, rerun avoids restart, and failed upgrades remain stopped/disabled/held.
- [ ] Lane 9. Run a native scripted stage on the disposable installed tree. Run real head-owned gates from a separate, unmodified product-head checkout on that VM against a same-layout local candidate. Save `native-gate.json`. Pass when both complete with their distinct product/fixture identities disclosed. Do not require production-identity tests to pass against changed fixture defaults.
- [ ] Lane 10. After landing, collect the owner-triggered real ci.yml run. Save `actions.json`. Pass when gates/receipt succeed at exact main/candidate SHAs and report fails only the expected actor assertion without posting certification. Before landing, mark this bootstrap-pending, never passed.

**Verify, perf.** Tests alone are not sufficient verification. A PR is verified only when its unit, live, and perf boxes are all checked.

- [ ] Metric. Measure startup to controller_ready and full check. Record install duration separately.
- [ ] Probe. Interleave three parent/head pairs on the same disposable machine and dependencies. Save `perf.json` with fixture derivation identities.
- [ ] Baseline. Record trunk first. No production host is a perf target.
- [ ] Rule. Apply both comparison thresholds and unchanged deadlines. Require zero provider model calls for scripted tests.

**Review gate.** None. L13 is not review-gated.

**Merge.**

- [ ] Record exact-head review, owner edits, both install receipts, Bugbot triage, and shipping evidence. Hand L13 to the owner with lane 10 explicitly bootstrap-pending. Complete lane 10 and new-main gates before L14.

## Mirror tests without losing discovery (L14)

**Depends on.** L13, including its main-backed gate and real Actions bootstrap result.

**Files.**

- [ ] Move non-held-out tests into `test/src/<group>/*.test.ts` and `test/host/<group>/*.test.ts`. Keep integration, fixtures, and acceptance roots unchanged. Move sandbox support under test/host/sandbox. Edit package runners, host/gates/manifest.ts, coverage tests, layout inventory, formal replay selection, and maintained driver commands.
- [ ] Have the owner replace `.github/factory/gates/gates.json` testGlobs in this same PR. Keep held-out exclusions and check identities unchanged.

**Build.**

- [ ] Convert the eight baseline sandbox cases, plus any split descendants, into directly discovered tests and delete the aggregator. Keep helpers as non-tests. Use visible globs `test/src/**/*.test.ts` and `test/host/**/*.test.ts` with separate `test/integration/*.test.ts`. Validate exactly those three forms in the trusted manifest.
- [ ] Preserve complete test identities through the map, including both giant suites and all added pins. Keep concurrency and integration separation. Prove a newly added nested candidate test runs through candidate_tests, not only npm.
- [ ] Update formal replay's hardcoded handoff/orchestrator/publication selection to the mapped test owners. Retain its required witnesses and zero-skip assertions. Update generated visible-test examples without touching published acceptance suites.

**You see.**

- [ ] Tests mirror their owners and every visible, trusted, candidate-added, and integration case runs once.

**Verify, unit.** Tests alone are not sufficient verification. A PR is verified only when its unit, live, and perf boxes are all checked.

- [ ] Run full check, trusted reporter at both umasks, nested candidate negative control, held-out isolation, and formal selection parity. Use exact-head native CI for the suite.

**Verify, live.** Tests alone are not sufficient verification. A PR is verified only when its unit, live, and perf boxes are all checked. Ten lanes on `task:qa` at the PR head, per the boot recipe.

- [ ] Lane 1. Regression lane against trunk. Run full check. Save `checks.log`. Pass when all original behavior remains green.
- [ ] Lane 2. Compare complete registrations through the map. Save `test-parity.json`. Pass when counts, assertions, skips, and todos are preserved.
- [ ] Lane 3. Run the real trusted manifest against mirrored tests. Save `manifest.json`. Pass when it discovers every intended baseline file.
- [ ] Lane 4. Add a deliberately failing nested candidate test. Save `candidate.log`. Pass when candidate_tests executes and fails it.
- [ ] Lane 5. Plant a misplaced test and duplicate cases import. Save `negative.json`. Pass when guards reject both.
- [ ] Lane 6. Run visible and integration commands separately. Save `separation.json`. Pass when heavy replay cases appear only in integration.
- [ ] Lane 7. Run the trusted reporter at umasks 022 and 077. Save `reporter.json`. Pass when counts agree without duplicate registration.
- [ ] Lane 8. Run formal correspondence and held-out isolation. Save `formal-heldout.json`. Pass when required witnesses still run and acceptance remains separately controlled.
- [ ] Lane 9. Run head-owned gates. Save `gate.json`. Pass when all required checks execute under the new owner-edited globs.
- [ ] Lane 10. Cite native CI and inspect historical acceptance exclusions. Save `ci.json`. Pass when native cases do not skip and the five old-import suites remain unchanged.

**Verify, perf.** Tests alone are not sufficient verification. A PR is verified only when its unit, live, and perf boxes are all checked.

- [ ] Metric. Measure full check and controller startup.
- [ ] Probe. Interleave three parent/head checks and reuse startup only if runtime blobs are identical. Save `perf.json`.
- [ ] Baseline. Record trunk first and identify unchanged-runtime evidence.
- [ ] Rule. Apply check-duration threshold and existing deadlines. Any lost test blocks regardless of timing.

**Review gate.** None. L14 is not review-gated.

**Merge.**

- [ ] Record exact-head review, trusted-glob grant, Bugbot triage, and shipping evidence. Hand L14 to the owner and finish new-main gates before L15.

## Move docs and qualify the final tree (L15)

**Depends on.** L14 and all pending main-backed/native evidence. This is the final PR, not a production deployment.

**Files.**

- [ ] Move docs/design.md to docs/architecture.md, factory-v1 to docs/plans/active, exmach-move and factorio-vm to docs/plans/later, statecharts to docs/models, and historical handoff/prototypes to docs/history. Maintained probes already moved in L02. Keep the path map at `docs/history/path-map.md` and append final moves.
- [ ] Move this plan to `docs/plans/later/codebase-layout.md` with completed PR evidence and a separate unchecked post-program owner checklist. Update indexes, current links, formal TypeScript paths, and source correspondence through the shared allowance. Edit `package.json`, `tsconfig.json`, `.oxlintrc.json`, `biome.json`, and host gate materialization only for the moved maintained inputs. Leave decisions unchanged except separately authorized coordinator appends.
- [ ] Keep docs/operations and `.github/factory/WORKFLOW.md:4` unchanged in location. Have the owner replace the `docs/statecharts` lint/format roots introduced in L02 with `docs/models` in `.github/factory/gates/gates.json` in this PR. Update materialization and typecheck paths with that edit. Any other trusted reference change needs its own grant before landing.

**Build.**

- [ ] Update current instructions and in-range citations. Check cited symbols against their claims. Leave historical payloads and decision rows byte-identical behind banners and the accumulated revision-bound path map.
- [ ] Move formal models with model/config bytes unchanged. Update checked runtime references and test selection, preserving proof limits. Recheck maintained probe callers, not archived programs.
- [ ] Qualify the assembled tree before STACK-READY on a clean disposable VM with a fresh held install at the L15 head-derived fixture revision. Follow the final runbook literally. Save installed revision, configuration-only diff, readiness, bundle, sandbox, gate, package, and CLI evidence. Production installation, bridge setup, #712/#734, #735, and a real provider fixture are not conditions of this PR.
- [ ] After owner landing, repeat the fresh held install on a clean disposable VM derived from final main and run new-main gates. Bind that receipt to the exact main SHA and fixture configuration diff. This step is a closure step, not a merge condition of L15. Record it as a row in `docs/decisions.tsv` through `log.sh`, citing the immutable pre-merge receipt and the post-merge receipt, and ship that row with the next docs change. No self-dependent closure PR follows.

**You see.**

- [ ] The final tree is qualified and documented. The owner can land the last PR while nubl-factory is still empty and dispatch is still held.

**Verify, unit.** Tests alone are not sufficient verification. A PR is verified only when its unit, live, and perf boxes are all checked.

- [ ] Run all plan checkers at their new paths, with factory-v1 still 22/0. Run full check, package load, layout/citation guards, probe self-tests, formal replay, and final test inventory against the original baseline plus added pins.

**Verify, live.** Tests alone are not sufficient verification. A PR is verified only when its unit, live, and perf boxes are all checked. Ten lanes on `task:qa` at the PR head, per the boot recipe.

- [ ] Lane 1. Regression lane against trunk. Run full check and all plan checkers. Save `checks.log`. Pass when both revisions pass and factory-v1 retains 22 sections.
- [ ] Lane 2. Compare final test identities, package imports, and zero reverse edges. Save `final-layout.json`. Pass when every original case and new file is accounted for.
- [ ] Lane 3. Check current citations and history-enabled pinned links. Save `citations.json`. Pass when paths/lines and sampled meanings agree without rewriting history.
- [ ] Lane 4. Compare decision prefix, archived payloads, and model/config hashes. Save `history.json`. Pass when all preserved bytes match through the move map.
- [ ] Lane 5. Run maintained probes, cheating fixture application, formal replay, and historical/current cap/bundle checks. Save `maintenance.json`. Pass when no active command depends on archived code and all intended controls execute.
- [ ] Lane 6. Perform the clean fresh held install at the final PR's head-derived fixture revision. Save `final-fresh-install.log`. Pass when final runbook paths, readiness, bundle, sandbox, and held status are proven with the derivation disclosed.
- [ ] Lane 7. Compare saved-state status/feed and exercise the documented bridge command locally. Save `cli-feed.json`. Pass when command/schema are unchanged. This is not proof of a deployed Shep bridge.
- [ ] Lane 8. Run real head-owned gates against a representative same-layout fixture candidate. Save `final-gate.json`. Pass when exact identities and required checks pass. Repeat on final main after landing as the explicit closure step.
- [ ] Lane 9. Cite exact-head native CI and its no-skip counts. Save `native-ci.json`. Pass when the actual check.yml job qualifies this tree, not a proxy test.
- [ ] Lane 10. Read pi-factorio read-only and obtain the owner's empty-nubl-factory confirmation. Save `hosts.json`. Pass when no layout deployment occurred on either host. If pi-factorio was retired separately, record that evidence instead of inventing a status read.

**Verify, perf.** Tests alone are not sufficient verification. A PR is verified only when its unit, live, and perf boxes are all checked.

- [ ] Metric. Measure final check and installed controller startup. Compare with the applicable parent and pre-program baselines separately.
- [ ] Probe. Interleave three parent/head pairs on the disposable host. Save `perf.json` with both source and fixture SHAs.
- [ ] Baseline. Record the parent first. Keep fixture configuration equal on both sides.
- [ ] Rule. Apply both boot-recipe thresholds and unchanged deadlines. Never count the absence of production dispatch as a measured successful run.

**Review gate.** None. L15 is not review-gated.

**Merge.**

- [ ] Record the pre-merge exact-head verdict, independent review, Bugbot triage, and shipping evidence. Hand L15 to the owner at STACK-READY without production prerequisites. After landing, complete the final-main fresh install and main-backed gate in Close the program.

## Close the program

- [ ] Check completed PR boxes against their artifacts. After L15 lands, repeat the clean disposable fresh held install at final main as specified above and finish new-main gates. Keep any missing evidence unchecked. This post-merge qualification is not a new PR and cannot require its own prior landing.
- [ ] Confirm the target folders, zero reverse edges, complete review classifications, test inventory, and path map. Record any fewer-files split outcomes with their measured boundaries. Preserve historical decisions byte for byte.
- [ ] Confirm every external action has a grant and result. Archive disposable evidence before authorized VM/integration/repository cleanup. Leave nubl-factory empty at program closure.
- [ ] Deliver the autopilot-stack report with PR URLs, verified heads, owner merge SHAs, evidence, adaptations, and remaining work. Distinguish the completed layout program from pending production operation.

### Post-program owner checklist, not a PR

- [ ] After the whole program lands and final-main qualification passes, the owner performs a fresh held install on empty `nubl-factory` at the first production commit that follows the program. Use the new pinned install path and runbook. If that commit changes code beyond the qualified tree, verify its affected behavior before dispatch. Record installed SHA, fresh readiness, bundle digest, sandbox availability, and locally_disabled status.
- [ ] The Shep owner installs or updates the independently reviewed bridge, points it at the new owner-feed command, and confirms feed polling. This repository's agents do not deploy or restart Shep.
- [ ] Complete the `pi-factorio` drain under #712 and the production switch/retirement under #734 with their own grants. Preserve unfinished-run evidence. Do not upgrade pi-factorio or assume a hold alone drains it.
- [ ] Obtain the owner's explicit real-dispatch decision under #735 after the fresh install, bridge, drain, and switch are proven. Only the owner removes the local hold or changes factory:enabled. Program completion grants neither action.
- [ ] Under a separate fixture/spend grant, run the first real fixture through actual provider stages, exact-head CI, and expected handoff. Keep full existing allowances, close the fixture, and preserve receipts. This proves production operation after closure, not a retrospective prerequisite for L15.

## Appendix A. Prototype evidence

### Existing authoring probes remain unchanged

The original four probes ran in `$HOME/.herdr/tmp/layout-proto/repo`, detached at `5bd77d572cb2bccc9c1e636c0bbe56f086658a56`, with Node v26.13.0 and existing linked dependencies. No prototype branch or commit was created. The trial rename tree was `e4cee7e28a588bb64ebec10864f2419bf93c915d`, a tree object, not a commit. This fix round reads their existing receipts and does not claim new VM, model, install, or runtime proof.

```sh
node --experimental-strip-types "$HOME/.herdr/tmp/layout-proto/probe.mjs" > "$HOME/.herdr/tmp/layout-proto/probe.log" 2>&1
node "$HOME/.herdr/tmp/layout-proto/edges.mjs" > "$HOME/.herdr/tmp/layout-proto/edges.log"
```

Both original commands exited 0. Preserve the instruments and raw receipts in the private trail before scratch cleanup. They are not maintained verification tools.

### Asset source moves preserve relative bundle identity

The probe copied four asset files and top-level shipped skill files into the existing bundle-relative paths with mode 0644. It used the real manifestDigest before and after relocating asset sources to host/bundle/assets.

```text
bundle_before=72246ff72955a5eedac3aef19ea07e0b99fa804279ba1c2f3d3546bc868f8499
source_match_before=true
bundle_after=72246ff72955a5eedac3aef19ea07e0b99fa804279ba1c2f3d3546bc868f8499
source_match_stale_mapping=false
source_match_updated_mapping=true
```

This proves only source-location independence for those copied bytes. Complete provisioning and installed bundles remain L13/L15 evidence. Equal digests do not bypass the recipe check. L13 must record the actual reviewed relocation hash pair and reject other recipe changes.

### Trusted discovery needs an atomic manifest change

The scratch probe exposed the real private manifest reader without changing its body. It added nested and colocated failing tests, then tried a new baseline glob.

```text
gate_default_tests=40 unchanged=true
gate_tests=40 nested_discovered=false colocated_discovered=false
gate_new_glob=invalid_gate_manifest
```

This is discovery evidence, not a gate run. Candidate-added tests have a separate overlay path. L14 proves that path with a real failing nested candidate test and changes trusted baseline globs atomically.

### Trial renames lose seats and cap declarations

The probe called reviewSeats and replayStageCaps, moved policy and run in its scratch index, and read the actual Git tree.

```text
review_old=["code-review","security-review","simplify","ultrareview"]
review_trial_rename=["code-review","security-review","simplify"]
caps_base={"accept":100000,"build":400000,"review":120000,"repair":300000}
trial_tree=e4cee7e28a588bb64ebec10864f2419bf93c915d
caps_trial=replay_stage_caps_unavailable
```

L00's complete file classification and HEAD reader guards precede those moves. Separate history-enabled lanes retain old-layout data support without old import shims.

### Import counts justify extraction before moves

The original TypeScript AST scan counted distinct ordered file pairs in 29 src files. It included static imports/exports, type imports, and literal dynamic imports, excluding packages.

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

The graph is cyclic, not a topological ordering. There are 23 reverse file-pair edges in 16 files, including 14 JSON importers. L03 moves shared facts, L04 isolates policy/vocabulary consolidation, and L05 removes host collection from domain code. L06 can then move intact groups together. P2 splits disjoint implementation files but requires serial integration of their shared callers.

### Fix-round source checks and remaining proof

The fix round verified findings against the local origin/main object at 5bd77d5. Only this plan differs from that object in the worktree. `scan.ts:4` imports the deleted JSON home, check.yml has default depth-1 checkout, replay has additional hardcoded asset/recipe readers, and the five published acceptance suites import old source entries. SOURCE is at `server/gates.ts:61`, not line 57. The fixture-repository limitation is verified in platform defaults, workflow repository matching, and installer preflight.

No full product suite, new prototype, native sandbox, formal run, controller timing, VM installation, or GitHub operation ran in this fix round. Boundary field counts, exact relocation hashes, fixture-repository setup, and final installed behavior remain execution evidence. The two plan checkers are authoring verification only.

## Appendix B. Alternatives rejected

### Keep the approved folder set and permit smaller splits

The owner chose C over the synthesis's B recommendation. Preserve this folder set. Extra filenames below fill source-verified omissions, not new architecture layers. The split stop rule permits fewer implementation files, with responsibilities retained in their composition module and a recorded reason. Empty placeholder files are not required.

```text
src/
  README.md
  core/          run.ts json.ts models.ts stages.ts execution.ts journal.ts
  trust/         policy.ts platform.ts admission.ts markers.ts protected-paths.ts
  config/        schema.ts parse.ts load.ts views.ts
  github/        adapter.ts exec.ts tickets.ts publish.ts
  contract/      contract.ts parse.ts render.ts prompt.ts acceptance.ts artifacts.ts
  candidate/     state.ts codec.ts handoff.ts build.ts review.ts validation.ts feedback.ts diagnosis.ts stages.ts
  ledger/        schema.ts append.ts terminal.ts outbox.ts git.ts
  controller/    orchestrator.ts claims.ts accounting.ts admission.ts launch.ts effects.ts recovery.ts base-check.ts
  views/         feed.ts attention.ts explain.ts metrics.ts
  maintenance/   cadence.ts replay.ts scorers.ts
host/
  README.md
  cli/           index.ts serve.ts owner-feed.ts metrics.ts replay.ts cadence.ts measurement.ts platform.ts
  controller/    serve-loop.ts lock.ts checkout.ts checkers.ts run-files.ts outbox.ts terminal.ts
                 measurement.ts cadence.ts validation-sweep.ts candidate-port.ts state.ts
  sandbox/       run-stage.ts launch.ts executor.ts receipts.ts visible-tests.ts review.ts specify.ts rpc.ts lines.ts settle.ts
  isolation/     bwrap.ts seccomp.ts preflight.ts scope.ts
  gateway/       gateway.ts main.ts client.ts routes.ts policy.ts control.ts audit.ts credentials.ts meter.ts
  gates/         gates.ts materialize.ts manifest.ts runner.ts base.ts draft-reporter.mjs
  viewer/        server.ts evidence.ts dashboard.ts render.ts claim.ts style.css design/
  bundle/        assets/ manifest.ts
  install/       provision.sh install-exe-dev.sh factory.service
test/
  README.md
  src/<group>/*.test.ts
  host/<group>/*.test.ts
  integration/ fixtures/ acceptance/
docs/
  README.md architecture.md decisions.tsv
  plans/active/factory-v1.md
  plans/later/   exmach-move.md factorio-vm.md codebase-layout.md
  operations/ models/
  history/       handoff.md prototypes/ path-map.md
extension/ skills/ .pi/skills/ .github/ scripts/ tools/ research/
```

Core execution/journal contain portable facts, not host writers. Candidate stages retain transition policy separate from the core vocabulary. Contract artifacts retain private storage semantics. Host gates identity covers its executable materializer modules. Existing transport helpers stay beside their owner. Maintained probes live under `.pi/skills/verify-factory/probes/`; historical payloads stay in docs/history.

Test README records exceptions. Extension tests go under test/src/views, cross-domain pipeline tests under test/src/controller, gate/discovery under test/host/gates, installer under test/host/install, and package tests under test/src/core. Published acceptance is unchanged historical output, never builder-owned visible input.

### Rejected sequencing and verification choices

- Moving giants before splitting them would rewrite their callers twice. L07 to L10 instead pin first and move/split directly in one PR with two commits. Temporary config/workflow, contract/specify, and ledger/ledger homes are removed from the plan.
- Splitting the CLI into server/cli/index before the host rename would change a public entry and owner CI twice. L13 moves/splits it directly to host/cli/index. Until then server/cli.ts remains the real dispatch table.
- Combining core extraction with protected-path authorization and stage consolidation makes parity failures harder to locate. L03 and L04 are separate, with separate pins and interrogation.
- Four pure-move PRs and three separate prose initialization PRs add repeated coordination. L06 combines intact moves; L01 combines disjoint prose work. L00 owns decision-check code, so L01 is genuinely prose-only.
- The review suggested about 13 to 14 PRs. This plan uses 16 rather than combine the 9,280-line host controller and 5,162-line sandbox splits with the deploy rename. Those two lifecycle changes retain separate pins and verdicts. CLI/gates splitting joins the rename, and docs relocation joins final qualification. This reduces 22 PRs without making one host PR own every lifecycle and deployment change.
- P2 is not unrestricted parallel writing. Candidate/config/ledger implementation is disjoint, but imports, inventories, and some tests overlap. The root serializes shared edits and checks the integrated result.
- A vague redesign loop would not bound the splits. More than four foreign mutable fields, or any need for the mutable parent, stops that extraction. Ship fewer files rather than add a general service interface.
- History-dependent aggregate guards would fail on check.yml's depth-1 checkout. Use HEAD checks and a committed decisions checkpoint. Do not add an owner fetch-depth edit solely to support a guard that can run without history.
- A late path map or unchecked probes would hide broken consumers until the end. L00 creates the map, L02 moves/checks maintained probes and heredocs, and every move appends its mapping.
- Inheritance based only on an author's move list misses omitted new files. Classify every src/host file, reject omissions, and check actual reviewSeats against inherited requirements. Do not silently widen all folders' review policy instead.
- Checking only BUNDLE_PATHS misses replay's ls-tree, asset-map, and recipe-diff paths. Inventory all readers and reject new-layout stale assets and same-layout recipe changes.
- Repeating a pi-factorio read in every PR proves nothing new. Read it at Arm and L15 only. Cite native check.yml evidence rather than duplicate its suite. Prose-only runtime lanes are N/A with blob identities.
- A direct `--repo` override on an arbitrary fixture repository is not supported by the baseline platform/workflow. Use the explicitly approved configuration-only fixture derivation below. Do not broaden production defaults or pretend the fixture SHA is the product SHA.
- Replacing SOURCE's line 61 with the review's proposed line 57 would introduce a wrong citation. `git grep -n 'const SOURCE' origin/main -- server/gates.ts` reports 61 at 5bd77d5. Keep the verified anchor and use symbol-based inventory after moves.
- Compatibility barrels, symlink aliases, and shipping the entire host to fix extension packaging leave duplicate owners or the reverse dependency intact. Migrate callers and delete; test the tarball.
- Rewriting decision rows, published acceptance suites, or old experiment payloads falsifies history. Banners, exclusions, original-revision links, and the path map explain their status instead.
- Production installation cannot gate the PR that closes the program. L15 qualifies disposable installs; the owner checklist follows closure. There is no nubl-factory upgrade in this program, because that host stays empty until the fresh install.
- A new proof framework, universal parser, broad mutable facade, model-policy change, or budget increase is outside this structural program. Preserve existing contracts and named limitations.

## Appendix C. Risks

### Owner-only actions and their gates

| Action | PR or phase | Required authority and result |
| --- | --- | --- |
| Start, confirm sole coordinator, pause, and approve maintenance transition | Arm | Explicit owner go and scoped grants. Confirm nubl-factory stays empty and resolve in-flight overlap. |
| Change shared model routing | Arm, if needed | Report-only setup first; approved supported change flow only. |
| Add `.github/README.md` | L00 | Owner edit or coordinator grant naming this file. |
| Extend trusted lint/format roots and maintained inputs | L02 | Owner gates.json edit with exact acceptance exclusions retained. |
| Change scanner's JSON import | L03 | Owner edit of `.github/factory/gates/scan.ts:4` in the JSON extraction PR. |
| Replace trusted server roots and CLI entry | L13 | Owner gates.json and ci.yml edits land with the final host paths. |
| Prepare fixture repository/configuration and disposable VMs/integration | Before L13; repeat L15 | Separate owner approval of the two-file fixture derivation, creation, pushes, trusted fixture config, install/upgrade/recovery, spend, and cleanup. No production attachment. |
| Trigger real ci.yml on main | After L13 landing | Owner fixture issue, suite-bearing candidate branch, held-out digest, workflow_dispatch, and cleanup grants in the product repository. Gates must pass; human-actor report refusal is expected. L14 waits. |
| Replace trusted test globs | L14 | Owner gates.json edit lands with runners, manifest parser, coverage tests, and moves. |
| Rename trusted formal TypeScript roots | L15 | Owner gates.json edit replaces L02's docs/statecharts roots with docs/models atomically. WORKFLOW.md:4 stays unchanged because operations stays. |
| Land PRs and remove branches/worktrees | L00 to L15 | Owner lands verified heads. Cleanup is separately authorized. |
| Install missing formal/native tools or pull required images | Relevant lane | Explicit installation/network authority; otherwise evidence stays blocked. |
| Push, open/retarget/comment on PRs, or create/change/close fixtures | Execution | Each class needs its grant. Planning and local commits grant none. |
| Perform final-main disposable fresh install | After L15 landing | Owner-granted disposable action closes qualification before production begins. |
| Fresh held install on empty nubl-factory | Post-program | Owner at the first production commit after the program, with affected checks for any intervening code change. |
| Install/update the Shep bridge and confirm polling | Post-program | Shep owner only; independent bridge review remains required. |
| Drain and switch/retire pi-factorio | Post-program #712 and #734 | Separate issue grants. Preserve evidence; do not upgrade it. |
| Decide real dispatch and lift hold | Post-program #735 | Owner only after fresh install, bridge, drain, and switch evidence. Leave factory:enabled alone otherwise. |
| First real fixture and any provider spend | Post-program | Separate owner fixture/spend grant, unchanged full allowances, cleanup confirmed. |
| Accept comparison thresholds or raise any existing budget | Arm or before a probe | Owner decision before measurement, never after failure to make a result green. |

A trusted edit grant never transfers to a runtime factory builder. Factory patches still cannot edit `.github` or acceptance. No unfinished old-layout run is resumed by deleting its evidence.

### Disposable fixture setup is a real prerequisite

The named repository is `nublai/pi-herdr-factorio-layout-fixture`. Its existence, access, and preparation are not claimed. At 5bd77d5, platform defaults allow only `nublai/pi-herdr-factorio`, workflow parsing requires its repository to equal the selected repository, and the installer rejects an existing platform.json in preflight. Therefore `--repo` alone is insufficient.

Under a specific owner grant, prepare disposable fixture commits derived from the exact pre-rename and tested post-rename product SHAs. Change only the default repository list in the current platform module and the repository field in fixture-owned `.github/factory/WORKFLOW.md`. Leave historical aliases unchanged, with the fixture repository absent from those aliases. Publish the derived commit and its fixture main under the fixture grant. The fixture main supplies the matching trusted workflow. No fixture change lands in the product repository.

Record both SHAs, the exact two-field diff, and a blob comparison proving all other files identical. Run focused platform/workflow checks for the fixture identity and the real installer runbook with explicit `--repo`/`--vm` overrides. The old-side and new-side derivations use the same configuration changes. Rehearsal runs no product full-suite claim against the altered repository constants, since tests may pin the production identity. Product checks and native CI remain bound to the unchanged product head.

This qualifies installation and upgrade at the new layout with a disclosed fixture configuration, not an exact-production deployment. Owner approval of that evidence adaptation is an Arm gate. If the owner rejects it or fixture integration access is unavailable, report L13/L15 install proof blocked. Do not change production defaults, bypass installer checks, attach production write access, or stop pi-factorio to hide the problem. The later owner fresh install is the first production-host proof.

### Code-verified readers that must survive moves

All anchors in this table refer to 5bd77d5. L00's inventory uses symbols and literal tokens after relocation.

| Reader | Contract and owning PR |
| --- | --- |
| `.github/factory/gates/scan.ts:4` | Imports server/sandbox/json. L03's owner edit is atomic with its deletion. L00 checks trusted TypeScript importers. |
| `.github/workflows/check.yml` checkout | No fetch-depth setting, so depth 1. Every aggregate guard uses HEAD, not absent parent objects. |
| `server/gates.ts:61` SOURCE and isDocumentation | L02 materializes maintained scripts/formal inputs; L13 replaces server with host. No missing root may be classified as documentation. |
| gates overlay near 384 to 474 | Main tests survive source overlay. Old-main imports can be incompatible during moves; retain the maintenance-transition receipt. |
| gates manifest near 756 and candidate-gates test near 509/530 | Three accepted glob forms and cases filtering. L14 changes all sides atomically. |
| `.github/factory/gates/gates.json` | L02 check roots, L13 host root, L14 test globs, L15 formal roots. Preserve test/acceptance ignore throughout. |
| `.github/workflows/ci.yml:67` and `:133` | L13 changes the CLI once; held-out regex and exact-head report binding remain. Real main dispatch follows landing. |
| `.github/factory/WORKFLOW.md:4` | Operations reference stays valid. No gratuitous product trusted edit. Fixture repository field edits are separately owner-gated. |
| gates scanner import near 20 | L13 adjusts relative depth and tests the real import. |
| `src/review.ts:347` | Runtime regex controls ultrareview. L00 classifies every source file; each move inherits and tests required seats. |
| `src/replay.ts:35`, `:923-926`, `:977`, `:1010-1013`, `:1040` | Bundle roots, four constants, ls-tree pathspec, asset keys, and recipe diff are separate readers. L03/L06/L13 update them and preserve historical data lookup. |
| drive-replay.sh near 52/66/109/285 | CLI argv ownership, VISIBLE_LIMIT_MS, and heredoc imports. L02 moves code into checked files; L11/L12/L13 update actual readers. |
| integration/replay-driver.test.ts near 105-111 | Reads the same deadline with a fallback regex. L02 pins the reader and missing-declaration refusal; L12 moves it with visible-tests. |
| statecharts/journey/replay-merge-mid-repair.ts:6 | Hardcoded test locations. L02 checks it, L14 updates mirrored paths, L15 moves it to models. |
| CLI near 516 and controller near 5405 | Depth-based repository roots. L11 and L13 execute them at their final depths. |
| controller near 2115/2149 | Diagnosis materializer source identity. L13 covers the whole extracted implementation and mutates every member. |
| gateway-client near 21 and gates near 1596 | URL-relative gateway child and reporter. L13 loads both actual entries. |
| `src/accept.ts:504` | Four-parent acceptance import hint. Acceptance directory stays put. Test generated imports at that depth. |
| factory.service and installer near 64/69/130/143/163/165/200 | Service entry, verified re-exec, status, provisioning, and continuation. L13 moves them once and tests old-bootstrap/new-SHA safe failure. |
| provisioner near 18/149-160 and manifest near 84-87 | Root depth and source/installed asset maps. L13 retains bundle-relative identity and proves full installation. |
| install runbook near 28/38 | Raw URL pinned by commit. Old pins work unchanged; new pins use host/install. L13 and L15 each prove a fresh install. |
| published acceptance 621 and 645 | Five original-revision imports become stale intentionally. Keep files unchanged, list them in test README, and explicitly exclude acceptance from current import checks. |

### Template and review adaptations

Every row describes planned work, not a completed verification claim.

| Finding or adaptation | Resolution |
| --- | --- |
| B1 | L03 names the owner's scan.ts:4 edit; L00 scans `.github` TypeScript and tests a missing JSON target. |
| B2 | L13 has separate clean fresh-new-layout and old-to-new upgrade VMs; L15 repeats fresh install at its head and after landing at final main, with fixture derivation disclosed. |
| B3 | nubl-factory stays empty throughout. Only the post-program owner checklist installs it fresh and references #712, #734, and #735. |
| B4 | L15 is closable before production. Install, bridge, drain/switch, dispatch, and first provider fixture are outside PR acceptance. |
| S1 | All guards use HEAD. Decisions use a committed prefix checkpoint. History comparisons are lanes; no fetch-depth edit is needed. |
| S2 | L00 inventories every reader and shell token. L02 extracts heredocs, checks formal TypeScript, and moves maintained probes before source changes. L15 atomically repoints the owner-controlled formal check roots. |
| S3 | L00 covers replay pathspecs/assets/recipe. L13 adds changed stage-init and both same-layout recipe negative controls. |
| S4 | Every src/server/host file is classified; new or omitted files fail, and extraction inherits required seats. |
| S5 | L03 pure core and L04 protected paths/stage vocabulary have separate pins and review. |
| S6 | Parent-object dependence or more than four foreign mutable fields stops extraction. Retain the responsibility and ship fewer files. |
| S7 | CLI entry changes once, server/cli.ts directly to host/cli/index.ts in L13. |
| S8 | Owner triggers real ci.yml on main after L13. Gates pass; report's human-actor refusal remains expected and explicit. |
| S9 | Named fixture repository and owner-approved two-field derived configuration prevent simultaneous production observation. Unsupported plain --repo use is not claimed. |
| S10 | L00 creates the path map; every move appends it. L15 does not recreate history late. |
| S11 | 22 PRs become 16 with merged prose, pure moves, CLI/rename, and docs/closure. P1/P2 expose bounded parallel work. Native CI is reused; pi-factorio reads occur only at Arm/final. Appendix B explains retaining separate host lifecycle splits. |
| N1, SOURCE anchor | Source inspection refutes line 57. Keep verified line 61 and a symbol-based guard. |
| N2, duplicate wiring | L00 alone wires both guards. L02 extends maintained coverage only. |
| N3, log.sh provenance | Format checks validate bytes/structure, not which tool wrote them. Coordinator-only log.sh remains a procedure. |
| N4, replay absolute path | L01 explicitly fixes replay.md's workstation command as well as paths in plans. |
| N5, probe lint | L02 brings maintained probes up to existing lint rules without blanket exclusions. |
| N6, lane mechanics | Boot names Docker/image and fixture gh readiness prerequisites. L13 tests old-bootstrap/new-SHA hold-before-stop failure. |
| N7, published acceptance | Name the five files in test README; leave them unchanged and exclude acceptance explicitly from current import checks. |
| Existing exploration | Reuse six explorers, synthesis, and original four probes. This leaf fix round launches no children and claims no new runtime proof. |
| Installed paths | Resolve `<pstack>` at execution, not a machine-specific tracked path. |
| Ten-lane template | Keep ten boxes, with logs/JSON instead of screenshots and explicit evidenced N/A for prose-only runtime work. No PR changes an interaction. |
| Native evidence | Cite check.yml's exact-head required sandbox run. Changed native scenarios get affected checks, not ritual duplication. Offline saved-state checks remain offline evidence. |
| Main-only bootstrap | New-main gates follow each landing. L13's real workflow dispatch and L15's final-main repeat are named post-merge gates, never false pre-merge passes. |
| Final closure | L15 combines docs relocation with disposable final-tree qualification. Production owner actions remain an unchecked checklist after closure. |
| Formal scope | Wrap existing bounded checks and witnesses, preserve incomplete properties, and obtain tool-install authority separately. No new exhaustive proof gate. |
| Performance | Proposed comparison limits require owner acceptance before probing. Preserve all existing stage/run allowances and distinguish provider spend from scripted zero-token work. |
| Checker output | Success is exit 0 with `16 PR sections, 0 problems` for this plan and `22 PR sections, 0 problems` for factory-v1. Counts are stdout by design. |

### Risks that remain bounded

Shared mutable-state boundaries still need measured field maps. The stop rule limits that investigation and permits smaller splits. A passing typecheck is not equivalence proof.

The audit counted 224 doc lines citing src TypeScript and 275 mentioning server. Existence/range guards do not prove citation meaning. Current docs receive reference updates per move and a meaning review in L15. Historical records keep their original revision context.

Fixture derivation is an explicit evidence limitation and approval gate, not a hidden product change. Record source and fixture identities everywhere. No disposable proof claims that nubl-factory is installed.

The pre-existing accept-selfcheck flake and Node provisioning pin discrepancy are tracked in #744. Reproduce failures on both revisions and report them. Do not remove tests or raise budgets to claim a clean refactor.

## Appendix D. Links and reading list

Read AGENTS, factory-v1, exmach-move, and decisions.tsv at the planning base. After L15 use their moved paths. Read operations factory-cli, sandbox, install-exe-dev, owner-feed, human-review, and ledger before changing their commands. Read DESIGN.md before viewer-path work. Never hand-edit generated tokens.

The private `layout-audit/` trail contains context.md, explore-1 through explore-6, synthesis.md, plan-brief.md including Amendment 1, and plan-review-1.md. The owner's C choice overrides the B recommendation. Amendment 1 overrides every earlier installation/upgrade assumption about nubl-factory. Source checks override incorrect line anchors.

Keep briefs, move maps, configuration-only fixture patches, commands, raw results, and verdicts under the coordinator-resolved private `pi-herdr-factorio-trails/layout/<PR>/` directory. Follow `<pstack>/skills/show-me-your-work/SKILL.md` and append decisions with its log.sh. Never publish raw private acceptance/session data.

- `<pstack>/skills/poteto-mode/playbooks/multi-phase-plan.md` supplies the checklist skeleton. Refactoring supplies pins, same-wave migration/deletion, and equivalence. Autopilot-stack governs execution and owner landing.
- `<pstack>/skills/how/SKILL.md` applies to L03-L05 and L07-L13. Architect applies before function boundaries change. Interrogate applies independently to L04, and to persistence, gates, installation, and discovery changes in L07/L09-L14.
- `<pstack>/skills/technical-writing/SKILL.md`, `unslop/SKILL.md`, and `no-comments/SKILL.md` govern prose and cleanup, retaining required safety comments.
- Create-verification-skill and maintain-verification-skill govern L01/L02. Create-formal-verification-skill governs only the bounded wrapper in L01.
- The principles are model-the-domain, minimize-reader-load, migrate-callers-then-delete-legacy-apis, sequence-verifiable-units, encode-lessons-in-structure, subtract-before-you-add, prove-it-works, and test-behavior-not-implementation under `<pstack>/skills/principle-<name>/SKILL.md`. Apply them through named owners, no pass-through layers, atomic caller migration, guards before moves, fewer-file stop outcomes, and observable behavior pins.

At authoring time run these commands. Do not edit factory-v1 in this fix round.

```sh
node <pstack>/skills/poteto-mode/scripts/check-plan.mjs docs/plans/codebase-layout.md
node <pstack>/skills/poteto-mode/scripts/check-plan.mjs docs/plans/factory-v1.md
```
