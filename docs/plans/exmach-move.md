# Move the factory to an exmach dev VM

Move the Factorio controller from the exe.dev VM `pi-factorio` to one exmach dev VM named `factorio`, per issue #719.
The owner gets the same factory on a platform with no exe.dev credit spend and no credential in the VM.
The rule this program enforces is that no platform value is hard-coded, and a profile that does not forbid its own domain refuses to start.
The cutover is done when a `factory:ready` issue becomes a ready PR with the controller on exmach and markers signed by the new bot.
Implement `MV1` to `MV8`. `MV1`, `MV2` and `MV6` are independent and start now. `MV3` and `MV4` stack on `MV1`.
`MV5` is the cutover and waits for exmach E1 to E4, which now come after exmach's M5, #51 and its self-host install milestone (giuseppecrj/exmach#100). `MV7` follows the cutover. `MV8` proves the phone path after `MV5` and `MV6`.
Items #717 (F13 Linear) and #718 (bootstrap kit) stay outside this plan. Appendix C says where they go.

## How to read this

**Parked, 2026-11-10.** The owner set a three-phase roadmap. Phase 1 is Shep as the daily client, phase 2 the software factory run from Shep, and phase 3 is exmach. The move to exmach is parked. Factorio's first real host is a new exe.dev VM, `nubl-factory`, which the owner installs by hand with the one-command installer from #743 (`docs/operations/install-exe-dev.md`). `pi-factorio` is drained (#712) and retired once `nubl-factory` works (#734). A dedicated VM on ms-a2 comes later and is only planned (#730, `docs/plans/factorio-vm.md`). `MV1` (#724), `MV2` (#721) and `MV6` (#722) are on `main` and stay useful, because the platform profile and the verification targets are host-neutral. `MV3` landed through #743 as the installer's provisioning. `MV4`, `MV5` and `MV8` are parked as written, and `MV7` waits with them. `MV4`'s drain and foreign-marker work stays on branches `mv4-drain-foreign-markers` and `mv4b-ci-bot`. It is needed only for a move that changes the controller's GitHub identity, such as the later ms-a2 VM. The move to `nubl-factory` keeps the exe.dev identity.

One box is one unit of work. Every box names the evidence that checks it. A nested box is a sub-step of the box above it. Check a box only when its evidence exists, such as a file, a log, a test result, or a SHA. The body is a how-to. The appendices explain and record.

The program runs the poteto-mode playbook `playbooks/autopilot-stack.md`. No current grant names merging this program's PRs. The `autonomous-run` grant of 2026-11-10T00:03Z named F09c paperwork, F11, F12 and F13, and the `owner-checkpoint-f12` row ended that run. So every PR here stops at STACK-READY and the owner lands it. Commits, branches, pushes, PR creation, fixture issues, VM changes and the exmach VM itself each need their own grant, recorded in `docs/decisions.tsv` before the action. This document grants nothing.

Use the **Factory CLI control procedure** from `docs/plans/factory-v1.md` as the control skill, through `.pi/skills/verify-factory/`. This backend has no visual surface except `MV8`'s Factory tab and pushes in Shep. Live lanes save redacted logs, JSON snapshots and issue or PR URLs in place of screenshots. `MV2` makes the control skill reach the exmach VM. Until exmach E2 exists, every live lane that needs the exmach VM is `BLOCKED`, never passed by a substitute.

The Kyoko root session coordinates integration between Factorio, exmach and Shep (decision C1 in nublai/root `.pi/plan/integration.md`). This program works only in this repository. It files no issues and posts no comments in giuseppecrj/exmach or giuseppecrj/shep. Each reply to the owner that needs something from those projects ends with a **For other projects** heading, and the Kyoko session relays it.

Treat every new path, symbol, command and log field below as a proposed contract, not an existing capability. At the planning base `4306505` none of them exist.

Tests alone are not sufficient verification. A PR is verified only when its unit, live, and perf boxes are all checked.

## Program checklist

### Arm the program

- [ ] State the protocol and this plan to the operator, then stop. Start execution only on the operator's explicit go. Record separate grants for commits, pushes, PR creation, fixture issues, changes on `pi-factorio`, changes on the exmach VM, and the cutover.
- [ ] Read these from the installed skill directories at program start. Re-read them at every audit.
  - [ ] Read `<pstack>/skills/poteto-mode/playbooks/autopilot-stack.md`, resolving `<pstack>` from the installed skill inventory, and `playbooks/autopilot-full.md` beside it.
  - [ ] Read the swarm skill at `<pstack>/skills/swarm/SKILL.md`.
  - [ ] Read the control skill at `.pi/skills/verify-factory/SKILL.md`.
  - [ ] Read `<pstack>/skills/poteto-mode/playbooks/opening-a-pr.md` and `playbooks/shipping.md` beside it.
  - [ ] Read the leaf skills named in Appendix D.
- [ ] Run the audit at every child delivery, at every stall or no-progress advisory, and on the operator's request. Nothing schedules it, so never promise a timed cadence and never leave the audit to memory.
- [ ] Use this audit prompt, verbatim. "Re-read the execution playbook. Audit the operation against it and fix drift in this audit. Check every active lane and judge progress by side effects only. Cancel a stuck lane and launch its fresh replacement now. Then post a short status message to the operator in chat only when the audit found a tracked change that no earlier status message reported, such as a PR opened, a code-ready head, a round launched or closed, a verdict, a merge, a stuck agent and the action taken, a blocker added or cleared, or a decision only the operator can make. Name every such change and nothing else. Do not repeat a table, the merged list, or an unchanged blocker. If the audit found none, end the turn with no reply text. Either way, log this audit's row in your decision trail. The row names the items reported, or none."
- [ ] On the operator's hold or stand-down, cancel every running child with `subagent_cancel` at once and launch nothing new.
- [ ] Track the gates in other projects at every audit with read-only `gh issue view <n> --repo <repo>`. exmach's order is M5 backups (giuseppecrj/exmach#29), then giuseppecrj/exmach#51, then the self-host install milestone (giuseppecrj/exmach#100, install, teardown and reinstall on rented bare metal), then E1 to E4 (the owner's 2026-11-10 update to decision C2).
  - [ ] The self-host install milestone, giuseppecrj/exmach#100. `MV5` waits for it as well as E1 to E4.
  - [ ] M5, the off-host backup target and restore drill, giuseppecrj/exmach#29.
  - [ ] E1, `actions` opt-in, giuseppecrj/exmach#93, after the deny list in giuseppecrj/exmach#51.
  - [ ] E2, the `factorio` VM recipe, giuseppecrj/exmach#94. It also yields the new bot login, its email id and the VM's ssh route.
  - [ ] E3, the per-VM `llm` budget, giuseppecrj/exmach#95.
  - [ ] E4, GitHub redirect egress, giuseppecrj/exmach#96.
  - [ ] E5, the userns smoke gate, giuseppecrj/exmach#97.
  - [ ] For `MV8` only, the `apns` attach as `vm:factorio` in E2 (giuseppecrj/exmach#94), push v2 giuseppecrj/exmach#88, the bridge push sender giuseppecrj/shep#107, the bridge in the dev image giuseppecrj/exmach#90 or a manual install, and the Factory tab giuseppecrj/shep#140. The attach alone delivers no push, because today's `apns` contract takes only a title and body. exmach does #88 after Shep's runtimes seam, so `MV8` comes late.

### Launch owner rounds

- [ ] Give each PR one owner role with the lifecycle `autopilot-stack` names. Launch each round as a fresh bare leaf with `fork: false`, the Implementer prompt, an explicit model and thinking level, the PR's **Files** block, its verification, and its commit policy. Write each brief to `../pi-herdr-factorio-trails/<PR>/brief.md`. On this machine `../pi-herdr-factorio-trails` is a symlink to `/home/g/Projects/pi-herdr-factorio-trails`.
- [ ] Follow this dependency graph.
  - [ ] `MV1`, `MV2` and `MV6` are independent and first. Each branches from `main` with `--no-track`.
  - [ ] `MV3` stacks on `MV1`. `MV4` stacks on `MV1`. They are independent of each other.
  - [ ] `MV5` starts after the owner lands `MV1` to `MV4` and giuseppecrj/exmach#100 and E1 to E4 are closed.
  - [ ] `MV7` branches from `main` after the owner lands `MV5`.
  - [ ] `MV8` starts after the owner lands `MV5` and `MV6` and the other-project gates for `MV8` close.
  - [ ] After `MV5`, F12d and F12e resume on the exmach VM under `docs/plans/factory-v1.md`. Carry the replay budget file per the `replay-cap-raise-4m` row. `MV5` now waits for exmach's self-host install milestone (giuseppecrj/exmach#100) too, so `MV1` to `MV4` and `MV6` land well before the cutover. `MV4` still lands only after the drain, because it switches CI's expected actor.
- [ ] Hold the file boundaries. Each PR touches only its **Files** block. No agent edits `.github/`. The owner authorized the coordinator to make the two `.github/workflows/` edits in `MV4`.
- [ ] Hold the review gate. `MV8` proves what reaches the owner's phone. It waits for the owner's review in chat with a screenshot and a video before landing.
- [ ] Run the `how` skill walkthrough before `MV1`, because it sets security-relevant constants. Bring the owner only product calls.

### PR mechanics, for every PR

- [ ] Use `gh` for every PR operation. Confirm `gh auth status` once. Never require Graphite. Never set `GH_HOST` locally.
- [ ] Open the PR ready, never draft, per **Opening a PR**, only under the operator's grant that names PR creation. Use `gh pr create --base main` for `MV1` and `MV2`, and `--base` the `MV1` branch for `MV3` and `MV4`.
- [ ] Run `npm run check` before each PR-facing push. Push with hooks on, only under the push grant, with `../pi-herdr-factorio-trails/bin/checked-push.sh` or an explicit `HEAD:refs/heads/<branch>`.
- [ ] Run a manual diff cleanup pass before each commit and `/skill:no-comments` before review. Keep every `SAFETY:` comment that `.oxlintrc.json` requires.
- [ ] Triage every Bugbot and security-reviewer comment per `<pstack>/skills/poteto-mode/references/bugbot-triage.md`.
- [ ] Rebase onto the parent branch, or `main` for a stack root, before the code-ready report and babysit. Keep that merge base in fix rounds. Rebase again only at merge prep, on a `git merge-tree` conflict with trunk, on a CI failure that comes from a change on trunk, or when a known concurrent change to the same files lands.
- [ ] After any edit to `docs/plans/factory-v1.md`, run `node <pstack>/skills/poteto-mode/scripts/check-plan.mjs docs/plans/factory-v1.md`. It must print `22 PR sections, 0 problems`. Run the same script on this file after each edit.

### Verdict and merge, for every PR

- [ ] At the code-ready head SHA and at each later push that changes the patch, run the swarm per `<pstack>/skills/swarm/SKILL.md`. The root launches the lanes per `references/fan-out.md`. One gates lane runs `npm run check`. The ten live lanes from the PR's **Verify, live** block are verifier lanes on `task:qa` with the Verifier prompt. One perf lane runs its **Verify, perf** block. Two or more audit lanes read the diff and the receipts and distrust the PR body, each with the full brief and one main focus. They use the Reviewer prompt on an exact model from a family other than the author's. The root audits the receipts in the merge-ready report before the verdict.
- [ ] Clean only when every lane is `PASS`. Findings go back to the owner in one batched fix round. A defect that a lane filed as a note is a finding. After the first fix round, block only for a bug a user would hit, a failed gate or a wrong shipped doc, and file the rest as one follow-up issue. A lane that needs the exmach VM before E2 exists is `BLOCKED`. A new head gets a fresh swarm and verdict, except for lane results that stay valid under the patch-id rule in `playbooks/shipping.md`.
- [ ] Stop at STACK-READY. Hand each verified PR to the owner with its verdict SHA, base SHA and patch-id. The owner lands the stack bottom-up. After each landing, apply the patch-id rule in `playbooks/shipping.md` to the PRs above it. Nobody pushes after the handoff without the owner's go.

### Boot recipe, for every live lane

Each live lane runs at the PR head through the Factory CLI control procedure.

- [ ] In a disposable verification checkout, run `git fetch origin <head-branch> && git checkout --detach <head SHA>`. Record the trunk and head SHAs.
- [ ] Pick the target VM. Before `MV2` lands, use `.pi/skills/verify-factory/scripts/vm.sh` against `pi-factorio`. After `MV2`, set the target variable `MV2` adds to `pi-factorio` or the exmach `factorio` VM, and record which.
- [ ] Ship the head with `lane-setup.sh` to a per-lane workspace and state directory under `/home/exedev/factory-verification/<pr-id>-w<n>/`. Never share one between lanes. Never start a second controller over production issues.
- [ ] Keep `pi-factorio` production held (`locally_disabled`) for every lane. Lift a hold only on the one controller meant to run, and only under the cutover grant.
- [ ] Deliver input only through `gh issue`, `gh pr`, `vm.sh` and `node --experimental-strip-types host/cli/index.ts`. Title each fixture issue `[<PR>-w<n>-...]`. Close it after the lane and confirm it is closed. Leave `factory:enabled` alone.
- [ ] Read state with `status --json`, `owner-feed --json`, `gh issue view`, `gh api` timeline reads and scoped `journalctl` reads.
- [ ] Size any lane token cap to stage allowances. One full specify, accept and build run reserves about 540,000 tokens.
- [ ] Save every artifact to `/tmp/swarm-<pr-id>/worker-<n>/<slug>` and return the paths with the report.

## Make the platform a validated profile (MV1)

**Depends on.** None. This implements #711 and adds the Anthropic stage field #715 needs.

**Files.**

- [ ] Create `src/trust/platform.ts` with the `PlatformProfile` type, the `exe-dev` default, the `exmach` profile taking a domain, and `parsePlatformProfile`.
- [ ] Create `test/platform.test.ts`.
- [ ] Edit `src/trust/markers.ts`, `src/github/publish.ts`, `src/github/adapter.ts`, `src/trust/admission.ts`, `src/config/{schema,parse,load,views}.ts`, `src/orchestrator.ts`, `src/candidate/validation.ts`, `src/candidate/feedback.ts`, `src/maintenance/replay.ts`, `host/cli/index.ts`, `server/controller.ts`, `server/sandbox.ts`, `host/gateway/routes.ts`, `host/gateway/main.ts`, `host/gateway/client.ts`, `host/gateway/credentials.ts`, `host/gateway/control.ts` and `extension/index.ts`, only to carry the profile. The walkthrough found that the first file list missed the gateway, recovery and extension paths.
- [ ] Edit the existing tests these changes require, without weakening an assertion. Under the default profile, existing expectations keep passing.
- [ ] Create `docs/operations/platform.md`. Edit `docs/operations/sandbox.md` and `docs/operations/factory-cli.md` only where they name the model host, edge address, forbidden domains, the status field or the startup failure.

**Build.**

- [ ] Define `PlatformProfile` with these fields. `modelHost`, `edgeAddress`, `modelBasePaths` per provider, `forbiddenDomains`, `controllerLogin`, `controllerAppSlug`, `botEmail`, `ghHost`, `repositories`, and `anthropicStages`.
- [ ] Parse the profile once at controller and gateway startup in `parsePlatformProfile`. Fail closed with a named error. Trust the parsed value everywhere after that.
- [ ] Refuse any profile whose `forbiddenDomains` lacks its own platform domain or `int.<domain>`.
- [ ] Make the `exe-dev` default byte-equal to today's values, including `anthropicStages` set to accept and code-review only.
- [ ] Ship the `exmach` profile with `llm.int.<domain>`, edge `10.74.1.1`, GitHub host `factorio.int.<domain>` (the `factorio` integration that alone will carry `actions`, provisional until E1 and E2 land), and `anthropicStages` still set to accept and code-review only. `MV7` lifts it. Its base paths are OpenAI `/v1/` and Anthropic `/`, because Pi's Anthropic SDK appends `/v1/messages`. Its xAI path is `null`, and an xAI fallback is refused in workflow validation and in route construction.
- [ ] Give the gateway a separate `--platform` descriptor. It rebuilds its expected upstreams from the built-in profile, so `productionDefect` still refuses a route table that differs. The table never authorizes itself.
- [ ] Add a `platform` object with a stable digest to `status --json`, and record the controller's startup profile in its status snapshot.
- [ ] Replace every hard-coded site. These are `host/gateway/routes.ts:170`, `:176`, `:250-258` and `:518`, `src/trust/markers.ts:14-15`, `src/github/publish.ts:44-45`, `src/github/adapter.ts:1179`, `host/cli/metrics.ts:285`, `host/controller/candidate-port.ts:1259`, `src/trust/admission.ts:52-54` and the `anthropicRule` text in `src/config/parse.ts`.
- [ ] Select the profile from `FACTORY_PLATFORM` and an optional root-owned `/etc/factory/platform.json`. The file holds only the selector, controller login, app slug, bot email and an optional repository list. With neither source, select `exe-dev`. Both sources must agree. The `exmach` profile carries the identity exmach published in giuseppecrj/exmach#94, which is login `nubl-agent[bot]`, app slug `nubl-agent` and email `353429311+nubl-agent[bot]@users.noreply.github.com`. The file may override all three together, and may set `ghHost` to one label under `int.<domain>`. Any malformed source fails closed and never falls back to `exe-dev`. The walkthrough is in `../pi-herdr-factorio-trails/MV1/walkthrough/explain.md`.

**You see.**

- [ ] With no profile set, `status --json` reports `platform.name` as `exe-dev` and every route matches trunk.
- [ ] With `FACTORY_PLATFORM=exmach:` and no domain, startup exits 2 with `event=platform_invalid` and a named reason. A built-in selector always generates its own forbidden domains, so `own_domain_not_forbidden` is proven by a unit test on a malformed resolved profile, not live.
- [ ] `rg 'exe\.xyz|exe-dev-github-integration|169\.254\.169\.254|nublai/pi-herdr-factorio' src server extension` finds only `src/trust/platform.ts`, the echo fixture, the generic refused ranges in `host/gateway/gateway.ts`, and the MV3 and MV7 files `host/install/provision.sh`, `host/install/factory.service` and `host/sandbox/anthropic-limits.ts`.

**Verify, unit.** Tests alone are not sufficient verification. A PR is verified only when its unit, live, and perf boxes are all checked.

- [ ] `test/platform.test.ts` gains cases for the default equal to trunk values, exmach routing to `llm.int.<domain>` on the flat paths, the forbidden list blocking `<domain>` and `int.<domain>`, an omitted own domain refused, an unknown field refused, and an empty repository list refused. Run `npm run check`.
- [ ] `test/sandbox/routes.cases.ts` gains cases that a sandbox request to `llm.int.exmach.net` and to `x.int.exmach.net` is refused under the exmach profile. Run `npm run check`.

**Verify, live.** Tests alone are not sufficient verification. A PR is verified only when its unit, live, and perf boxes are all checked. Ten lanes on `task:qa` at the PR head, per the boot recipe.

- [ ] Lane 1. Regression lane against trunk. On `pi-factorio`, start the gateway and run one sandbox model request at trunk and head with no profile set. Save `default-parity.json`. Pass when both reach the model through the same host, path and edge address with the same status.
- [ ] Lane 2. On `pi-factorio`, run `status --json` at head with no profile. Save `status-default.json`. Pass when `platform.name` is `exe-dev` and dispatch reasons match trunk.
- [ ] Lane 3. On `pi-factorio`, start the controller at head with `FACTORY_PLATFORM=exmach:` and no domain. Save `invalid-profile.log`. Pass when it exits 2 with `platform_invalid` and a named reason, takes no lock and launches no stage.
- [ ] Lane 4. On `pi-factorio`, start at head with a malformed `FACTORY_PLATFORM`. Save `malformed-profile.log`. Pass when it exits 2 and never falls back to `exe-dev`.
- [ ] Lane 5. On the exmach VM, start the gateway at head with `FACTORY_PLATFORM=exmach:exmach.net` and send one OpenAI request from a sandbox. Save `exmach-openai.json`. Pass when the upstream is `llm.int.exmach.net/v1/responses` and the reply is 200.
- [ ] Lane 6. On the exmach VM, send one Anthropic accept-stage request from a sandbox. Save `exmach-anthropic.json`. Pass when the upstream is `llm.int.exmach.net/v1/messages`, the client credential is stripped, and the reply is 200.
- [ ] Lane 7. On the exmach VM, from a sandbox, request `https://factorio.int.exmach.net/`, `https://github.int.exmach.net/`, `https://reflection.int.exmach.net/` and `https://exmach.net/`. Save `forbidden-exmach.json`. Pass when the gateway refuses all three and forwards none. The refusal reason may be `no-route`, `bad-host` or a forbidden-domain reason, because the request parser can refuse before the forbidden check runs.
- [ ] Lane 8. On the exmach VM, from a sandbox, connect directly to `10.74.1.1`. Save `edge-direct.json`. Pass when the sandbox cannot reach the edge except through the gateway's pinned model route.
- [ ] Lane 9. On `pi-factorio`, run `tick --once` at head on a lane state with one valid run marker by `exe-dev-github-integration[bot]`. Save `marker-default.json`. Pass when the marker authenticates under the default profile.
- [ ] Lane 10. On `pi-factorio`, run `status --json` at head once with `FACTORY_PLATFORM` unset and once with `FACTORY_PLATFORM=exe-dev`. Save `explicit-default.json`. Pass when both outputs are identical.

**Verify, perf.** Tests alone are not sufficient verification. A PR is verified only when its unit, live, and perf boxes are all checked.

- [ ] Metric. Gateway per-request added latency and controller startup time to `controller_ready`, at trunk and head, both on `pi-factorio` with the default profile.
- [ ] Probe. Interleave three trunk and three head runs of 50 sandbox requests to the echo fixture route and three cold starts each. Save `perf.json`.
- [ ] Baseline. Record the trunk median request latency and startup time first.
- [ ] Rule. Fail if the head median request latency exceeds trunk by more than 2 milliseconds or startup exceeds trunk by more than 200 milliseconds.

**Review gate.** None. MV1 is not review-gated.

**Merge.**

- [ ] Root's clean verdict at the exact head SHA, with one audit lane focused on the forbidden-domain logic from a family other than the author's.
- [ ] Bugbot triage done.
- [ ] Rebased onto current trunk after the verdict, with the verdict still valid under the patch-id rule in `playbooks/shipping.md`.
- [ ] Hand MV1 to the owner as STACK-READY. The owner lands it.

## Point the verification skill at either VM (MV2)

**Depends on.** None. No issue covers it yet. The live lanes on the exmach VM need it.

**Files.**

- [ ] Edit `.pi/skills/verify-factory/SKILL.md`, `.pi/skills/verify-factory/scripts/*.sh` and `.pi/skills/verify-factory/features/*.md`.
- [ ] Create `.pi/skills/verify-factory/targets.env` with one block per VM.

**Build.**

- [ ] Replace the hard-coded `exedev@pi-factorio.exe.xyz` in `vm.sh` and the `GH_HOST=github.int.exe.xyz` exports in the ten drive scripts with values loaded from `targets.env` by a `FACTORY_VM` name, defaulting to `pi-factorio`.
- [ ] Add the `factorio` block with the ssh route and `GH_HOST` that exmach E2 documents. Leave its fields empty with a refusal until E2 closes.
- [ ] Make `doctor.sh` print the selected target and refuse an empty one.

**You see.**

- [ ] `FACTORY_VM=factorio doctor.sh` prints the target, then either passes or exits 2 with `target factorio not configured`.

**Verify, unit.** Tests alone are not sufficient verification. A PR is verified only when its unit, live, and perf boxes are all checked.

- [ ] Run `bash -n` on every script and `shellcheck` where installed. Run `npm run check`.

**Verify, live.** Tests alone are not sufficient verification. A PR is verified only when its unit, live, and perf boxes are all checked. Ten lanes on `task:qa` at the PR head, per the boot recipe.

- [ ] Lane 1. Regression lane against trunk. Run `doctor.sh` at trunk and at head with `FACTORY_VM` unset. Save `doctor-parity.txt`. Pass when both reach `pi-factorio` and report the same checks.
- [ ] Lane 2. Run `drive-status.sh` at head against `pi-factorio`. Save `status-pi-factorio.json`. Pass when it shows the held production state, `locally_disabled`.
- [ ] Lane 3. Run `FACTORY_VM=factorio doctor.sh` before E2. Save `doctor-unconfigured.txt`. Pass when it exits 2 and opens no ssh connection.
- [ ] Lane 4. Run `FACTORY_VM=nope doctor.sh`. Save `doctor-unknown.txt`. Pass when it exits 2 naming the unknown target.
- [ ] Lane 5. After E2, run `FACTORY_VM=factorio doctor.sh`. Save `doctor-factorio.txt`. Pass when ssh, tools and a repository read succeed.
- [ ] Lane 6. After E2, run `drive-gh.sh` reads against the exmach VM. Save `gh-reads-factorio.txt`. Pass when `gh repo view` works with `GH_HOST=factorio.int.exmach.net` on the VM.
- [ ] Lane 7. Run `lane-setup.sh` against each target. Save `lane-setup.txt`. Pass when each lane directory is created on the selected VM only.
- [ ] Lane 8. Grep the skill for `pi-factorio.exe.xyz` and `github.int.exe.xyz`. Save `grep.txt`. Pass when only `targets.env` names them.
- [ ] Lane 9. Run `drive-tick.sh` against `pi-factorio` on a lane state. Save `tick-pi-factorio.json`. Pass when the tick output matches trunk's shape.
- [ ] Lane 10. Run any drive script with a target whose ssh fails. Save `ssh-fail.txt`. Pass when it exits nonzero and names the target.

**Verify, perf.** Tests alone are not sufficient verification. A PR is verified only when its unit, live, and perf boxes are all checked.

- [ ] Metric. `doctor.sh` wall time against `pi-factorio` at trunk and head.
- [ ] Probe. Interleave three trunk and three head runs. Save `perf.json`.
- [ ] Baseline. Record the trunk median first.
- [ ] Rule. Fail if the head median exceeds trunk by more than 1 second.

**Review gate.** None. MV2 is not review-gated.

**Merge.**

- [ ] Root's clean verdict at the exact head SHA.
- [ ] Bugbot triage done.
- [ ] Rebased onto current trunk after the verdict, with the verdict still valid under the patch-id rule in `playbooks/shipping.md`.
- [ ] Hand MV2 to the owner as STACK-READY. The owner lands it.

## Provision an exmach dev VM from the profile (MV3)

**Depends on.** Its provisioning code landed through #743 (`dc81a25`) as part of the exe.dev installer, and #713 is closed. The exmach-specific live lanes below stay parked with the exmach move. MV1. This implemented #713. Live lanes need exmach E2 and E5.

**Files.**

- [ ] Edit `host/install/provision.sh` and `host/install/factory.service`.
- [ ] Edit `host/cli/index.ts` only for the `/run/user/1000` preflight check.
- [ ] Edit `docs/operations/sandbox.md` for linger, cgroup delegation and the egress requirement.
- [ ] Edit the existing provisioning tests under `test/sandbox/`.

**Build.**

- [ ] Run `loginctl enable-linger exedev` in `provision.sh`, guarded so a re-run changes nothing.
- [ ] Take the LLM URL in `provision.sh` from the profile, not `LLM=https://llm.int.exe.xyz`.
- [ ] Write `GH_HOST` and the placeholder `GH_ENTERPRISE_TOKEN` from the profile into the unit's `Environment=`. Write `FACTORY_PLATFORM` there too.
- [ ] Make the preflight refuse to start when `/run/user/1000` is absent, with a named reason.
- [ ] State in `sandbox.md` that provisioning needs egress `all`.

**You see.**

- [ ] On the exmach VM, `provision.sh` ends with the sandbox preflight passing userns, bwrap, assets digest, a scope launch and gateway ready.
- [ ] A second `provision.sh` run reports no changes.

**Verify, unit.** Tests alone are not sufficient verification. A PR is verified only when its unit, live, and perf boxes are all checked.

- [ ] Cases cover the unit rendered for each profile and the preflight refusing without `/run/user/1000`. Run `npm run check`.

**Verify, live.** Tests alone are not sufficient verification. A PR is verified only when its unit, live, and perf boxes are all checked. Ten lanes on `task:qa` at the PR head, per the boot recipe.

- [ ] Lane 1. Regression lane against trunk. Record `systemctl cat factory` and `systemctl show factory -p Environment` on held `pi-factorio`, run head's `provision.sh` there under the VM grant, and record them again. Save `provision-default.diff`. Pass when the only additions are the `FACTORY_PLATFORM` and `GH_ENTERPRISE_TOKEN` lines and linger, and the controller returns to `controller_ready` still held.
- [ ] Lane 2. On a fresh exmach VM, run trunk's `provision.sh`. Save `provision-trunk-exmach.log`. Pass when the trunk failure is recorded, whether linger, LLM URL or `gh` auth.
- [ ] Lane 3. On a fresh exmach VM, run head's `provision.sh`. Save `provision-head-exmach.log`. Pass when it completes and the preflight passes.
- [ ] Lane 4. Re-run head's `provision.sh`. Save `provision-rerun.log`. Pass when nothing changes.
- [ ] Lane 5. From inside the unit, run `gh api /rate_limit`. Save `gh-in-unit.json`. Pass when it returns 200 with no token file on disk.
- [ ] Lane 6. Launch one stage scope and read its cgroup limits. Save `cgroup-limits.txt`. Pass when `MemoryMax=2G`, `TasksMax=512` and `CPUQuota=100%` apply on the user scope.
- [ ] Lane 7. Disable linger and start the unit. Save `no-linger.log`. Pass when preflight refuses with the `/run/user/1000` reason.
- [ ] Lane 8. Read `cat /proc/sys/kernel/apparmor_restrict_unprivileged_userns` and run the userns preflight. Save `userns.txt`. Pass when the value is 0 and preflight passes.
- [ ] Lane 9. From the unit, fetch one tarball and one job log through `gh api`. Save `redirects.json`. Pass when both follow the 302 and return content.
- [ ] Lane 10. Restart the unit. Save `restart.log`. Pass when it reaches `controller_ready` with `NRestarts` at 0 and dispatch held.

**Verify, perf.** Tests alone are not sufficient verification. A PR is verified only when its unit, live, and perf boxes are all checked.

- [ ] Metric. `provision.sh` wall time for a re-run, and unit start to `controller_ready`. Trunk does not provision on exmach, so trunk is measured on `pi-factorio` and head on both.
- [ ] Probe. Interleave three trunk and three head re-runs on `pi-factorio`, then three head re-runs and restarts on the exmach VM. Save `perf.json`.
- [ ] Baseline. Record the trunk re-run and start time on `pi-factorio` first.
- [ ] Rule. Fail if head on `pi-factorio` exceeds trunk by more than 10 percent. On exmach, fail if a re-run exceeds 120 seconds or start to `controller_ready` exceeds 60 seconds.

**Review gate.** None. MV3 is not review-gated.

**Merge.**

- [ ] Root's clean verdict at the exact head SHA.
- [ ] Bugbot triage done.
- [ ] Rebased onto the MV1 branch, or trunk once MV1 lands, after the verdict, with the verdict still valid under the patch-id rule in `playbooks/shipping.md`.
- [ ] Hand MV3 to the owner as STACK-READY. The owner lands it after MV1.

## Drain pi-factorio and report foreign markers (MV4)

**Depends on.** Parked on 2026-11-10. The drain of `pi-factorio` before it is retired is #712. The identity switch is needed only for a later move that changes the controller's GitHub identity, such as the ms-a2 VM. MV1. This implements #712 under the owner's drain decision.

**Files.**

- [ ] Create `docs/operations/drain.md`.
- [ ] Edit `host/cli/index.ts` and `server/controller.ts` for the `status` report of markers by a login other than the profile's.
- [ ] Edit `test/markers.test.ts` and `docs/operations/factory-cli.md`.
- [ ] Edit `.github/workflows/check.yml:46` and `.github/workflows/ci.yml:116` to `nubl-agent[bot]`. The owner authorized the coordinator to make these edits on 2026-11-10. They stack on `MV1`, because `test/validation.test.ts` runs `ci.yml`'s reporter with the controller's login, so its reporter cases must use the exmach profile once `ci.yml` names the new bot. On `main` alone the edit fails those tests.

**Build.**

- [ ] Write the drain procedure. Hold the factory, list open claims, wait for or release each, confirm zero active runs and claims, and record a decision row.
- [ ] Add `foreignMarkers` to `status --json`, counting markers on open issues authored by a login other than `controllerLogin`.
- [ ] Keep the trust check unchanged. A marker by another login never authenticates for an active run. Terminal markers by the old bot on closed issues stay readable history and never reopen a run.

**You see.**

- [ ] `status --json` on `pi-factorio` shows `foreignMarkers: 0` under the default profile.
- [ ] Under the exmach profile, a fixture issue with an old-bot run marker shows `foreignMarkers: 1` and no run starts.

**Verify, unit.** Tests alone are not sufficient verification. A PR is verified only when its unit, live, and perf boxes are all checked.

- [ ] Cases cover a non-current login refused for an active run, a closed issue's old terminal marker never reopening a run, and the `foreignMarkers` count. Run `npm run check`.

**Verify, live.** Tests alone are not sufficient verification. A PR is verified only when its unit, live, and perf boxes are all checked. Ten lanes on `task:qa` at the PR head, per the boot recipe.

- [ ] Lane 1. Regression lane against trunk. Run `status --json` on a copy of production state at trunk and head. Save `status-parity.json`. Pass when all fields match and head adds `foreignMarkers`.
- [ ] Lane 2. Follow `drain.md` on `pi-factorio` in read-only mode. Save `drain-dry.txt`. Pass when it lists runs and claims and changes nothing.
- [ ] Lane 3. On a lane state under the exmach profile, read a fixture issue holding an old-bot active run marker. Save `foreign-active.json`. Pass when no run starts and `foreignMarkers` is 1.
- [ ] Lane 4. On a lane state under the exmach profile, read a closed fixture issue with an old-bot terminal marker. Save `foreign-terminal.json`. Pass when no run reopens.
- [ ] Lane 5. Under the default profile, read the same issues. Save `default-markers.json`. Pass when the old bot's markers still authenticate.
- [ ] Lane 6. Post a run marker from the coordinator's own login on a fixture issue. Save `forged.json`. Pass when it is refused under both profiles.
- [ ] Lane 7. Restart the lane controller after lane 3. Save `restart-foreign.json`. Pass when the count and the refusal persist.
- [ ] Lane 8. Run `owner-feed --json` with a foreign marker present. Save `feed-foreign.json`. Pass when the feed does not show it as an active run.
- [ ] Lane 9. Read `check.yml` and `ci.yml` after the owner's edit. Save `workflows.txt`. Pass when both name the new bot and CI on a test PR still runs.
- [ ] Lane 10. Hold `pi-factorio` per `drain.md` and read status. Save `drain-final.json`. Pass when runs and claims are 0 and `locally_disabled` is set.

**Verify, perf.** Tests alone are not sufficient verification. A PR is verified only when its unit, live, and perf boxes are all checked.

- [ ] Metric. `status --json` wall time on a copy of production state at trunk and head.
- [ ] Probe. Interleave three trunk and three head runs. Save `perf.json`.
- [ ] Baseline. Record the trunk median first.
- [ ] Rule. Fail if the head median exceeds trunk by more than 20 percent or 2 seconds absolute. Fail if the count makes more than one extra GitHub read per open issue.

**Review gate.** None. MV4 is not review-gated.

**Merge.**

- [ ] Root's clean verdict at the exact head SHA.
- [ ] Bugbot triage done.
- [ ] Rebased onto the MV1 branch, or trunk once MV1 lands, after the verdict, with the verdict still valid under the patch-id rule in `playbooks/shipping.md`.
- [ ] Hand MV4 to the owner as STACK-READY. The owner lands it after MV1, after the drain and before the first exmach run.

## Cut production over to the exmach VM (MV5)

**Depends on.** Parked on 2026-11-10 (the exmach cutover is parked with the exmach move). MV1, MV2, MV3 and MV4 landed, giuseppecrj/exmach#100 and exmach E1 to E4 closed, and the owner's cutover grant.

**Files.**

- [ ] Create `docs/operations/exmach.md` with the cutover runbook and its evidence.
- [ ] Edit `docs/operations/backup.md` for the off-VM backup that exmach lacks until its M5.
- [ ] Edit `docs/decisions.tsv` with rows only, appended by `log.sh`.
- [ ] Edit `README.md` and `AGENTS.md` only where they name `pi-factorio` as the current home.

**Build.**

- [ ] Confirm `pi-factorio` drained per `drain.md`, with 0 runs and 0 claims. Record a row.
- [ ] Copy state and `/home/exedev/factory-verification/replay-budget.json` per `backup.md`. Do not hand-edit the budget file.
- [ ] Provision `factorio` with `FACTORY_PLATFORM=exmach:exmach.net`. Run the preflight.
- [ ] Lift the hold on the exmach controller only. Leave `pi-factorio` held or stopped. Never run two controllers.
- [ ] Run the cutover ticket, a `[MV5-cutover]` issue labeled `factory:ready`.
- [ ] Run `backup.md` once to an off-VM target and record it.

**You see.**

- [ ] The cutover issue reaches a ready PR labeled `factory:review`, with specify, accept, build, validate, review and handoff complete.
- [ ] Every marker on it is authored by the exmach bot and authenticates.

**Verify, unit.** Tests alone are not sufficient verification. A PR is verified only when its unit, live, and perf boxes are all checked.

- [ ] Run `npm run check` on the landed `main` the VM runs. Record the SHA.

**Verify, live.** Tests alone are not sufficient verification. A PR is verified only when its unit, live, and perf boxes are all checked. Ten lanes on `task:qa` at the PR head, per the boot recipe.

- [ ] Lane 1. Regression lane against trunk. Compare the cutover run with the last comparable completed run on `pi-factorio`. Save `run-compare.json`. Pass when the same stages complete in the same order with the same terminal markers.
- [ ] Lane 2. Read the cutover issue's markers. Save `markers.json`. Pass when each is authored by the new bot and none is rejected as forged.
- [ ] Lane 3. Read the CI dispatch and artifact reads from the run's receipts. Save `ci-actions.json`. Pass when the dispatch returned 204 and runs, jobs, logs and artifacts were read.
- [ ] Lane 4. Read the run's ledger commit. Save `ledger.json`. Pass when it lands on `factory/ledger` with the new bot's email.
- [ ] Lane 5. Read `status --json` on `pi-factorio`. Save `old-vm.json`. Pass when it is held or stopped and dispatched nothing after cutover.
- [ ] Lane 6. Read the run's model receipts. Save `budget.json`. Pass when no stage hit `budget_exceeded` or a 429.
- [ ] Lane 7. Let one cadence job run on the exmach controller. Save `cadence.json`. Pass when it settles without `budget_exceeded`.
- [ ] Lane 8. Restart the exmach unit mid-run on a second fixture issue. Save `restart-recovery.json`. Pass when the run resumes from its markers with no duplicate stage.
- [ ] Lane 9. Read the replay budget file on the exmach VM after one reservation. Save `replay-budget.json`. Pass when the 4,000,000 cap shows as an audited `policyChanges` entry.
- [ ] Lane 10. Restore the off-VM backup into a lane directory. Save `restore.txt`. Pass when `status --json` on the restored state matches production.

**Verify, perf.** Tests alone are not sufficient verification. A PR is verified only when its unit, live, and perf boxes are all checked.

- [ ] Metric. Wall time per stage and tokens per run for one full ticket. Trunk is the last comparable completed run on `pi-factorio`, from its receipts. Two controllers never run at once, so the probe cannot interleave.
- [ ] Probe. Run the cutover ticket and one more fixture ticket of similar size on exmach. Save `perf.json`.
- [ ] Baseline. Record the `pi-factorio` per-stage wall times and tokens first, from receipts.
- [ ] Rule. Fail if any stage on exmach takes more than 1.5 times its `pi-factorio` wall time or exceeds its stage allowance. Report token differences without a pass rule, since models and prompts are unchanged.

**Review gate.** None. MV5 is not review-gated.

**Merge.**

- [ ] Root's clean verdict at the exact head SHA of the docs PR that records the cutover.
- [ ] Bugbot triage done.
- [ ] Rebased onto current trunk after the verdict, with the verdict still valid under the patch-id rule in `playbooks/shipping.md`.
- [ ] Hand MV5 to the owner as STACK-READY. The owner lands it.

## Publish the OwnerFeed contract for Shep's Factory tab (MV6)

**Depends on.** None. This implements #714 option B and #716 under decision R25 (nublai/root `.pi/plan/integration.md`). Factorio's owner UI is a Factory tab in Shep, the Shep bridge on the Factorio VM reads OwnerFeed v1 locally and sends every push, and the controller never calls `apns.int`. The phone proof is `MV8`.

**Files.**

- [ ] Create `docs/operations/owner-feed.md`, the OwnerFeed v1 contract for the Shep bridge.
- [ ] Edit `docs/operations/viewer.md` for loopback only on exmach, with the bridge reading the feed.
- [ ] Edit the F09d section of `docs/plans/factory-v1.md` to record the decision and narrow the unit.
- [ ] Create one redacted capture per attention kind under `test/fixtures/owner-feed/` and cases in `test/feed.test.ts`.

**Build.**

- [ ] Answer the five questions Shep posted on #719 in `owner-feed.md`, each with file and line evidence from `src/views/feed.ts`. These are the version rule for added fields, the read source and allowed read rate, the stable run key for collapse and tap, which owner actions exist beyond GitHub links, and which fields can carry model or issue text.
- [ ] State the sender rule. The bridge builds pushes from feed changes, trims the title to 64 bytes and the body to 256 bytes on a character boundary, and collapses one push per run key. The controller sends nothing.
- [ ] Narrow F09d to inputs for Shep's Factory tab, which are screens, the feed contract and the fixtures. Retire its separate app, Apple setup and bundle id.
- [ ] Capture `owner-feed --json` for every attention kind the feed defines, redacted.

**You see.**

- [ ] `owner-feed.md` answers all five questions with evidence, ready for the Kyoko session to relay.

**Verify, unit.** Tests alone are not sufficient verification. A PR is verified only when its unit, live, and perf boxes are all checked.

- [ ] `test/feed.test.ts` parses every capture, and a case fails when a v1 field is removed or `version` changes. Run `npm run check` and the plan checker on `factory-v1.md`.

**Verify, live.** Tests alone are not sufficient verification. A PR is verified only when its unit, live, and perf boxes are all checked. Ten lanes on `task:qa` at the PR head, per the boot recipe.

- [ ] Lane 1. Regression lane against trunk. Run `owner-feed --json` on a copy of production state at trunk and head. Save `feed-parity.json`. Pass when the output is byte-identical.
- [ ] Lane 2. Drive a lane state through each attention kind. Save `kinds.json`. Pass when every kind has a capture and each capture matches its fixture's shape.
- [ ] Lane 3. Run ten consecutive CLI reads on production-size state. Save `read-rate.json`. Pass when the measured cost supports the read rate `owner-feed.md` allows.
- [ ] Lane 4. Start a lane viewer on loopback and read `/owner-feed.json`. Save `route-parity.json`. Pass when it equals the CLI output.
- [ ] Lane 5. Read the lane viewer's listen address. Save `viewer-bind.txt`. Pass when it is `127.0.0.1` only.
- [ ] Lane 6. Compare the untrusted-text list in `owner-feed.md` with each capture. Save `untrusted-fields.json`. Pass when every field carrying issue or model text is listed and no listed field is controller-generated only.
- [ ] Lane 7. Retry a fixture run so it gets a new run id. Save `run-key.json`. Pass when the documented stable key is unchanged across run ids.
- [ ] Lane 8. Hold the lane controller and read the feed. Save `hold.json`. Pass when the feed shows the hold and `owner-feed.md` documents no phone action beyond GitHub links.
- [ ] Lane 9. Run the plan checker on `factory-v1.md`. Save `check-plan.txt`. Pass when it prints `22 PR sections, 0 problems`.
- [ ] Lane 10. Search F09d for the old rules. Save `f09d-grep.txt`. Pass when no live rule names a dedicated app, an Apple setup or a 100-word push.

**Verify, perf.** Tests alone are not sufficient verification. A PR is verified only when its unit, live, and perf boxes are all checked.

- [ ] Metric. `owner-feed --json` wall time on production-size state at trunk and head.
- [ ] Probe. Interleave three trunk and three head runs. Save `perf.json`.
- [ ] Baseline. Record the trunk median first.
- [ ] Rule. Fail if the head median exceeds trunk by more than 10 percent.

**Review gate.** None. MV6 is not review-gated.

**Merge.**

- [ ] Root's clean verdict at the exact head SHA.
- [ ] Bugbot triage done.
- [ ] Rebased onto current trunk after the verdict, with the verdict still valid under the patch-id rule in `playbooks/shipping.md`.
- [ ] Hand MV6 to the owner as STACK-READY. The owner lands it.

## Allow Anthropic stages on the exmach profile (MV7)

**Depends on.** MV5. This implements #715 under decision D6.

**Files.**

- [ ] Edit `src/trust/platform.ts` to widen `anthropicStages` in the `exmach` profile.
- [ ] Edit `host/sandbox/anthropic-limits.ts` against exmach's `GET /v1/models`.
- [ ] Edit `test/platform.test.ts`, the workflow tests and `docs/operations/platform.md`.
- [ ] Edit `docs/decisions.tsv` with one row by `log.sh`.

**Build.**

- [ ] Lift the Anthropic stage restriction in the `exmach` profile only. Keep the `exe-dev` default unchanged.
- [ ] Check every model in `anthropic-limits.ts` against `GET /v1/models` on `llm.int.exmach.net`. Remove or add entries to match.
- [ ] Record the D6 decision and the profile defaults in a row.

**You see.**

- [ ] On exmach, a lane `WORKFLOW.md` with an Anthropic build model loads. On `exe-dev`, the same file fails with the `ANTHROPIC_RULE` text.

**Verify, unit.** Tests alone are not sufficient verification. A PR is verified only when its unit, live, and perf boxes are all checked.

- [ ] Cases cover an Anthropic build stage accepted on exmach and refused on `exe-dev`, and every limits entry present in a recorded `/v1/models` fixture. Run `npm run check`.

**Verify, live.** Tests alone are not sufficient verification. A PR is verified only when its unit, live, and perf boxes are all checked. Ten lanes on `task:qa` at the PR head, per the boot recipe.

- [ ] Lane 1. Regression lane against trunk. Run `workflow-check` with an Anthropic build model at trunk and head on exmach. Save `workflow-check.txt`. Pass when trunk refuses and head accepts.
- [ ] Lane 2. Run the same check under the `exe-dev` profile at head. Save `exe-dev-refuse.txt`. Pass when it refuses.
- [ ] Lane 3. Read `GET /v1/models` from the VM. Save `models.json`. Pass when every `anthropic-limits.ts` entry is served.
- [ ] Lane 4. Run one full fixture ticket with an Anthropic build stage. Save `anthropic-run.json`. Pass when it reaches a ready PR.
- [ ] Lane 5. Read that run's receipts. Save `anthropic-receipts.json`. Pass when Anthropic usage counts against the stage and run caps.
- [ ] Lane 6. Read the gateway log for that run. Save `gateway.log`. Pass when Anthropic requests used `/v1/messages` with the client credential stripped.
- [ ] Lane 7. Count model requests per hour during lane 4 and a cadence job. Save `request-rate.json`. Pass when the count stays under the E3 budget with no 429.
- [ ] Lane 8. Run a review stage with seats on two families. Save `review-seats.json`. Pass when each seat records its answering model and family.
- [ ] Lane 9. Request a model absent from `/v1/models`. Save `unknown-model.txt`. Pass when the stage fails with a named reason, not a hang.
- [ ] Lane 10. Read `docs/decisions.tsv`. Save `decision-row.txt`. Pass when the D6 row names both profile defaults.

**Verify, perf.** Tests alone are not sufficient verification. A PR is verified only when its unit, live, and perf boxes are all checked.

- [ ] Metric. Build stage wall time and tokens with an OpenAI model at trunk and an Anthropic model at head, on the same fixture.
- [ ] Probe. Interleave two trunk and two head runs on exmach. Save `perf.json`.
- [ ] Baseline. Record the trunk OpenAI build first.
- [ ] Rule. Fail if any head run exceeds the build stage allowance or 1.5 times the trunk wall time.

**Review gate.** None. MV7 is not review-gated.

**Merge.**

- [ ] Root's clean verdict at the exact head SHA.
- [ ] Bugbot triage done.
- [ ] Rebased onto current trunk after the verdict, with the verdict still valid under the patch-id rule in `playbooks/shipping.md`.
- [ ] Hand MV7 to the owner as STACK-READY. The owner lands it.

## Prove the Factory tab and pushes end to end (MV8)

**Depends on.** Parked on 2026-11-10 (the phone path no longer waits on exmach, because the Shep bridge on ms-a2 pushes straight to Apple). MV5 and MV6 landed, plus work in other projects that the Kyoko session tracks. These are the `apns` integration attached as `vm:factorio` in E2 (giuseppecrj/exmach#94), giuseppecrj/exmach#88 (edge push v2 with routing fields and a collapse key), giuseppecrj/shep#107 (the bridge's edge sender), the Shep bridge on the `factorio` VM (giuseppecrj/exmach#90 or a manual install), and giuseppecrj/shep#140 (the Factory tab). The attach alone delivers no push, so `MV8` waits for #88 and shep#107, not just E2. The edge allows 30 pushes per hour per VM with a burst of 5.

**Files.**

- [ ] Edit `docs/operations/exmach.md` with the end-to-end evidence.
- [ ] Edit `docs/decisions.tsv` with rows only, appended by `log.sh`.

**Build.**

- [ ] Confirm the Shep bridge on the `factorio` VM reads OwnerFeed v1 locally, by the source `owner-feed.md` names.
- [ ] Drive real needs-you states on `[MV8-...]` fixture issues and record what reaches the phone.

**You see.**

- [ ] The Factory tab shows the factory's OwnerFeed counts, and one push of 256 bytes or less arrives for a new owner decision.

**Verify, unit.** Tests alone are not sufficient verification. A PR is verified only when its unit, live, and perf boxes are all checked.

- [ ] Run `npm run check` on the landed `main` the VM runs. Record the SHA.

**Verify, live.** Tests alone are not sufficient verification. A PR is verified only when its unit, live, and perf boxes are all checked. Ten lanes on `task:qa` at the PR head, per the boot recipe.

- [ ] Lane 1. Regression lane against trunk. Run `owner-feed --json` on the exmach VM at trunk and head. Save `feed-parity.json`. Pass when the feed is byte-identical.
- [ ] Lane 2. Read the bridge's feed reads on the VM. Save `bridge-feed.json`. Pass when it reads OwnerFeed v1 locally at the documented rate.
- [ ] Lane 3. Put a fixture issue into a needs-you state. Save `app-counts.png`. Pass when the Factory tab's counts match the feed.
- [ ] Lane 4. Restart the bridge with existing needs-you states. Save `seed.png`. Pass when the first read sends no push.
- [ ] Lane 5. Create one new owner decision. Save `push.png`. Pass when one push arrives with a title of at most 64 bytes and a body of at most 256 bytes.
- [ ] Lane 6. Change the same issue's state. Save `collapse.png`. Pass when the newer push replaces the older one.
- [ ] Lane 7. Open the run in the app, then change its state. Save `viewing.png`. Pass when no push arrives for the run being viewed.
- [ ] Lane 8. Use a fixture title of 200 multibyte characters. Save `trim.png`. Pass when the push is trimmed on a character boundary within the byte limits.
- [ ] Lane 9. Replay a burst of 40 state changes on fixture issues. Save `rate.json`. Pass when at most 30 pushes are sent in the hour.
- [ ] Lane 10. Read the controller's egress during lanes 5 to 9. Save `egress.txt`. Pass when the controller made no `apns.int` request.

**Verify, perf.** Tests alone are not sufficient verification. A PR is verified only when its unit, live, and perf boxes are all checked.

- [ ] Metric. Time from a new owner decision in the feed to the push on the phone. Trunk has no push path, so trunk measures feed generation only.
- [ ] Probe. Run three new owner decisions on head and three feed reads on trunk. Save `perf.json`.
- [ ] Baseline. Record trunk feed generation time first.
- [ ] Rule. Fail if feed generation exceeds trunk by more than 10 percent, or a push takes more than 60 seconds after the state change.

**Review gate.** The operator reviews before merge.

- [ ] Copy lanes 3 and 5 screenshots into `docs/plans/media/MV8/MV8-review-app.png` and `docs/plans/media/MV8/MV8-review-push.png`.
- [ ] Record a 30 to 60 second video of a push arriving and collapsing. Save it as `docs/plans/media/MV8/MV8-review.mp4`.
- [ ] Post the screenshots and the video to the operator in chat. Stop at STACK-READY.

**Merge.**

- [ ] Root's clean verdict at the exact head SHA of the docs PR that records the evidence.
- [ ] Bugbot triage done.
- [ ] Rebased onto current trunk after the verdict, with the verdict still valid under the patch-id rule in `playbooks/shipping.md`.
- [ ] Hand MV8 to the owner as STACK-READY. The owner lands it.

## Close the program

- [ ] Every box above is checked with its evidence.
- [ ] Close #711 to #716 and #719 with links to the landed PRs, only under a grant that names issue changes.
- [ ] Reply to the operator with the report `autopilot-stack` names.

## Appendix A. Prototype evidence

No prototype ran. No exmach VM exists until E2, so platform behavior cannot be observed yet.

These questions stay unproven.

- Whether `--unshare-all` plus seccomp passes on exmach's kernel. `MV3` lane 8 answers it.
- Whether cgroup limits apply to user scopes on Ubuntu 26.04. `MV3` lane 6 answers it.
- Whether `gh` in the unit needs `GH_ENTERPRISE_TOKEN`. The issue marks it inference. `MV3` lane 5 answers it.
- Whether the edge relays the 302 redirects. `MV3` lane 9 and exmach E4 answer it.
- Where the profile is selected. The `how` walkthrough before `MV1` settles it.

## Appendix B. Alternatives rejected

- **A third, plain SSH host profile.** Deferred by the owner on 2026-11-10. nubl's goal is a self-hosted platform for isolated agent environments, with exmach as the product. Factorio should later run on an exmach VM, an exe.dev VM or a plain cloud droplet without depending on one host. The `MV1` profile keeps that open, because every host value is profile data and `parsePlatformProfile` selects from a closed set of built-in profiles that a later one can join. No such profile is built in this program.
- **Profile in the trusted `WORKFLOW.md`.** Rejected as the default. The forbidden-domain list guards the host the controller runs on, so it belongs to the host, not to repository content. The walkthrough may reverse this with evidence.
- **Accept a list of historical bot logins.** Rejected by the owner's drain decision. It changes a trust check and leaves a standing risk.
- **Viewer `--bind` for the exmach app proxy (#714 option A).** Rejected by the owner on 2026-11-10 in favour of Shep only. Revisit only if the browser dashboard is missed.
- **Adding these PRs to `docs/plans/factory-v1.md`.** Rejected because its checker must print `22 PR sections`.
- **A dedicated Factorio app (F09d's old lean).** Rejected by the owner under R25. The owner UI is a Factory tab in Shep.
- **The controller pushing through `apns.int`.** Rejected under R25. The Shep bridge sends from the feed, so the controller gains no new egress.
- **Folding the verification skill repoint into `MV3`.** Rejected so the lanes can reach the exmach VM before provisioning code lands.

## Appendix C. Risks

- **Forbidden-domain gaps (MV1).** A missed `int.` host lets a sandbox reach the edge. The owner watches the cross-family audit lane and `MV1` lanes 7 and 8.
- **Bot identity (MV1, MV4).** exmach published `nubl-agent[bot]` in giuseppecrj/exmach#94 on 2026-11-10. The owner's two `.github/` edits switch CI's expected controller actor. They land after `pi-factorio` is drained in `MV4` and before the first exmach run in `MV5`, because a dispatch by the old bot would then fail `ci.yml`'s actor check.
- **Request budget (MV5, MV7).** 600 requests per hour per VM is inference from the issue. A 429 is a stage failure. E3 sizes it from `MV5` receipts.
- **No interleaved baseline (MV5).** One controller at a time means trunk numbers come from `pi-factorio` receipts.
- **Cutover timing (MV5).** exmach now finishes M5, #51 and the self-host install milestone (giuseppecrj/exmach#100) before E1 to E4, so `MV5` waits longer than first planned. `pi-factorio` stays held (`locally_disabled`) until then unless the owner decides otherwise, and F12d and F12e wait for the move.
- **Backups (MV5).** exmach finishes M5 (giuseppecrj/exmach#29) before E1 to E4, so an off-host target should exist at cutover. Until it is proven, `backup.md` runs manually to an off-VM target.
- **Residual risk unchanged.** A bwrap escape lands on `exedev` with sudo, and the edge's GitHub integration answers any VM process, per `docs/operations/sandbox.md` section 1.2.
- **Spend.** `MV5` and `MV7` run full tickets at about 540,000 reserved tokens each. Check the program cap with the owner before they launch.
- **Out of scope.** #717 rewrites F13's credential section in `docs/plans/factory-v1.md` in its own docs PR before F13 starts. #718 becomes its own plan after `MV5` and giuseppecrj/exmach#83.
- **Shep's open questions (MV6).** Shep asked five feed questions on #719. Shep's Factory tab waits on `MV6`'s answers in `owner-feed.md`.
- **Phone path in other projects (MV8).** `MV8` depends on the `apns` attach in E2, exmach#88, shep#107, a bridge on the VM and shep#140. exmach schedules #88 after Shep's runtimes seam, so `MV8` lands well after the cutover. The Kyoko session tracks them.
- **Provisional GitHub host (MV1, MV2).** `factorio.int.exmach.net` is confirmed only until E1 and E2 land. A change needs only a `ghHost` override in `/etc/factory/platform.json` and the `factorio` line in `targets.env`.

## Appendix D. Links and reading list

- Issue #719 and its items #711 to #718, with Shep's R25 comments on #719, #714 and #716.
- The integration record, nublai/root `.pi/plan/integration.md`.
- `docs/operations/sandbox.md`, `docs/operations/backup.md`, `docs/operations/viewer.md` and `docs/operations/factory-cli.md`.
- `MV1` gets the how skill at `<pstack>/skills/how/SKILL.md` and the interrogate skill at `<pstack>/skills/interrogate/SKILL.md`.
- The trail follows the show-me-your-work skill at `<pstack>/skills/show-me-your-work/SKILL.md`.
- Leaf skills are `technical-writing`, `unslop`, `no-comments` and `typescript-best-practices`, under `<pstack>/skills/`.
