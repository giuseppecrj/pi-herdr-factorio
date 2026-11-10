# Move the factory to an exmach dev VM

Move the Factorio controller from the exe.dev VM `pi-factorio` to one exmach dev VM named `factorio`, per issue #719.
The owner gets the same factory on a platform with no exe.dev credit spend and no credential in the VM.
The rule this program enforces is that no platform value is hard-coded, and a profile that does not forbid its own domain refuses to start.
The cutover is done when a `factory:ready` issue becomes a ready PR with the controller on exmach and markers signed by the new bot.
Implement `MV1`, `MV2`, `MV3`, `MV4`, `MV5`, `MV6`, `MV7` in that order. `MV1` and `MV2` are independent. `MV3` and `MV4` stack on `MV1`.
`MV5` is the cutover and waits for exmach E1 to E4. `MV6` and `MV7` follow the cutover.
Items #717 (F13 Linear) and #718 (bootstrap kit) stay outside this plan. Appendix C says where they go.

## How to read this

One box is one unit of work. Every box names the evidence that checks it. A nested box is a sub-step of the box above it. Check a box only when its evidence exists, such as a file, a log, a test result, or a SHA. The body is a how-to. The appendices explain and record.

The program runs the poteto-mode playbook `playbooks/autopilot-stack.md`. No current grant names merging this program's PRs. The `autonomous-run` grant of 2026-11-10T00:03Z named F09c paperwork, F11, F12 and F13, and the `owner-checkpoint-f12` row ended that run. So every PR here stops at STACK-READY and the owner lands it. Commits, branches, pushes, PR creation, fixture issues, VM changes and the exmach VM itself each need their own grant, recorded in `docs/decisions.tsv` before the action. This document grants nothing.

Use the **Factory CLI control procedure** from `docs/plans/factory-v1.md` as the control skill, through `.pi/skills/verify-factory/`. This backend has no visual surface except `MV6`'s phone push. Live lanes save redacted logs, JSON snapshots and issue or PR URLs in place of screenshots. `MV2` makes the control skill reach the exmach VM. Until exmach E2 exists, every live lane that needs the exmach VM is `BLOCKED`, never passed by a substitute.

Treat every new path, symbol, command and log field below as a proposed contract, not an existing capability. At the planning base `4306505` none of them exist.

Tests alone are not sufficient verification. A PR is verified only when its unit, live, and perf boxes are all checked.

## Program checklist

### Arm the program

- [ ] State the protocol and this plan to the operator, then stop. Start execution only on the operator's explicit go. Record separate grants for commits, pushes, PR creation, fixture issues, changes on `pi-factorio`, changes on the exmach VM, and the cutover.
- [ ] Read these from the installed skill directories at program start. Re-read them at every audit.
  - [ ] Read `/home/g/.pi/agent/npm/node_modules/pi-herdr-pstack/skills/poteto-mode/playbooks/autopilot-stack.md` and `playbooks/autopilot-full.md` beside it.
  - [ ] Read the swarm skill at `/home/g/.pi/agent/npm/node_modules/pi-herdr-pstack/skills/swarm/SKILL.md`.
  - [ ] Read the control skill at `.pi/skills/verify-factory/SKILL.md`.
  - [ ] Read `/home/g/.pi/agent/npm/node_modules/pi-herdr-pstack/skills/poteto-mode/playbooks/opening-a-pr.md` and `playbooks/shipping.md` beside it.
  - [ ] Read the leaf skills named in Appendix D.
- [ ] Run the audit at every child delivery, at every stall or no-progress advisory, and on the operator's request. Nothing schedules it, so never promise a timed cadence and never leave the audit to memory.
- [ ] Use this audit prompt, verbatim. "Re-read the execution playbook. Audit the operation against it and fix drift in this audit. Check every active lane and judge progress by side effects only. Cancel a stuck lane and launch its fresh replacement now. Then post a short status message to the operator in chat only when the audit found a tracked change that no earlier status message reported, such as a PR opened, a code-ready head, a round launched or closed, a verdict, a merge, a stuck agent and the action taken, a blocker added or cleared, or a decision only the operator can make. Name every such change and nothing else. Do not repeat a table, the merged list, or an unchanged blocker. If the audit found none, end the turn with no reply text. Either way, log this audit's row in your decision trail. The row names the items reported, or none."
- [ ] On the operator's hold or stand-down, cancel every running child with `subagent_cancel` at once and launch nothing new.
- [ ] Track the exmach gates in the execution trail at every audit. Read each with `gh issue view <n> --repo giuseppecrj/exmach`.
  - [ ] E1, `actions` opt-in, giuseppecrj/exmach#93, after the deny list in giuseppecrj/exmach#51.
  - [ ] E2, the `factorio` VM recipe, giuseppecrj/exmach#94. It also yields the new bot login, its email id and the VM's ssh route.
  - [ ] E3, the per-VM `llm` budget, giuseppecrj/exmach#95.
  - [ ] E4, GitHub redirect egress, giuseppecrj/exmach#96.
  - [ ] E5, the userns smoke gate, giuseppecrj/exmach#97.

### Launch owner rounds

- [ ] Give each PR one owner role with the lifecycle `autopilot-stack` names. Launch each round as a fresh bare leaf with `fork: false`, the Implementer prompt, an explicit model and thinking level, the PR's **Files** block, its verification, and its commit policy. Write each brief to `../pi-herdr-factorio-trails/<PR>/brief.md`. That directory does not exist on this machine yet. Create it first.
- [ ] Follow this dependency graph.
  - [ ] `MV1` and `MV2` are independent and first. Both branch from `main` with `--no-track`.
  - [ ] `MV3` stacks on `MV1`. `MV4` stacks on `MV1`. They are independent of each other.
  - [ ] `MV5` starts after the owner lands `MV1` to `MV4` and E1 to E4 are closed.
  - [ ] `MV6` and `MV7` branch from `main` after the owner lands `MV5`.
  - [ ] After `MV5`, F12d and F12e resume on the exmach VM under `docs/plans/factory-v1.md`. Carry the replay budget file per the `replay-cap-raise-4m` row.
- [ ] Hold the file boundaries. Each PR touches only its **Files** block. No agent edits `.github/`. The owner makes the two `.github/workflows/` edits in `MV4`.
- [ ] Hold the review gate. `MV6` changes what reaches the owner's phone. It waits for the owner's review in chat with a screenshot and a video before landing.
- [ ] Run the `how` skill walkthrough before `MV1`, because it sets security-relevant constants. Bring the owner only product calls.

### PR mechanics, for every PR

- [ ] Use `gh` for every PR operation. Confirm `gh auth status` once. Never require Graphite. Never set `GH_HOST` locally.
- [ ] Open the PR ready, never draft, per **Opening a PR**, only under the operator's grant that names PR creation. Use `gh pr create --base main` for `MV1` and `MV2`, and `--base` the `MV1` branch for `MV3` and `MV4`.
- [ ] Run `npm run check` before each PR-facing push. Push with hooks on, only under the push grant, with `../pi-herdr-factorio-trails/bin/checked-push.sh` or an explicit `HEAD:refs/heads/<branch>`.
- [ ] Run a manual diff cleanup pass before each commit and `/skill:no-comments` before review. Keep every `SAFETY:` comment that `.oxlintrc.json` requires.
- [ ] Triage every Bugbot and security-reviewer comment per `/home/g/.pi/agent/npm/node_modules/pi-herdr-pstack/skills/poteto-mode/references/bugbot-triage.md`.
- [ ] Rebase onto the parent branch, or `main` for a stack root, before the code-ready report and babysit. Keep that merge base in fix rounds. Rebase again only at merge prep, on a `git merge-tree` conflict with trunk, on a CI failure that comes from a change on trunk, or when a known concurrent change to the same files lands.
- [ ] After any edit to `docs/plans/factory-v1.md`, run `node /home/g/.pi/agent/npm/node_modules/pi-herdr-pstack/skills/poteto-mode/scripts/check-plan.mjs docs/plans/factory-v1.md`. It must print `22 PR sections, 0 problems`. Run the same script on this file after each edit.

### Verdict and merge, for every PR

- [ ] At the code-ready head SHA and at each later push that changes the patch, run the swarm per `/home/g/.pi/agent/npm/node_modules/pi-herdr-pstack/skills/swarm/SKILL.md`. The root launches the lanes per `references/fan-out.md`. One gates lane runs `npm run check`. The ten live lanes from the PR's **Verify, live** block are verifier lanes on `task:qa` with the Verifier prompt. One perf lane runs its **Verify, perf** block. Two or more audit lanes read the diff and the receipts and distrust the PR body, each with the full brief and one main focus. They use the Reviewer prompt on an exact model from a family other than the author's. The root audits the receipts in the merge-ready report before the verdict.
- [ ] Clean only when every lane is `PASS`. Findings go back to the owner in one batched fix round. A defect that a lane filed as a note is a finding. After the first fix round, block only for a bug a user would hit, a failed gate or a wrong shipped doc, and file the rest as one follow-up issue. A lane that needs the exmach VM before E2 exists is `BLOCKED`. A new head gets a fresh swarm and verdict, except for lane results that stay valid under the patch-id rule in `playbooks/shipping.md`.
- [ ] Stop at STACK-READY. Hand each verified PR to the owner with its verdict SHA, base SHA and patch-id. The owner lands the stack bottom-up. After each landing, apply the patch-id rule in `playbooks/shipping.md` to the PRs above it. Nobody pushes after the handoff without the owner's go.

### Boot recipe, for every live lane

Each live lane runs at the PR head through the Factory CLI control procedure.

- [ ] In a disposable verification checkout, run `git fetch origin <head-branch> && git checkout --detach <head SHA>`. Record the trunk and head SHAs.
- [ ] Pick the target VM. Before `MV2` lands, use `.pi/skills/verify-factory/scripts/vm.sh` against `pi-factorio`. After `MV2`, set the target variable `MV2` adds to `pi-factorio` or the exmach `factorio` VM, and record which.
- [ ] Ship the head with `lane-setup.sh` to a per-lane workspace and state directory under `/home/exedev/factory-verification/<pr-id>-w<n>/`. Never share one between lanes. Never start a second controller over production issues.
- [ ] Keep `pi-factorio` production held (`locally_disabled`) for every lane. Lift a hold only on the one controller meant to run, and only under the cutover grant.
- [ ] Deliver input only through `gh issue`, `gh pr`, `vm.sh` and `node --experimental-strip-types server/cli.ts`. Title each fixture issue `[<PR>-w<n>-...]`. Close it after the lane and confirm it is closed. Leave `factory:enabled` alone.
- [ ] Read state with `status --json`, `owner-feed --json`, `gh issue view`, `gh api` timeline reads and scoped `journalctl` reads.
- [ ] Size any lane token cap to stage allowances. One full specify, accept and build run reserves about 540,000 tokens.
- [ ] Save every artifact to `/tmp/swarm-<pr-id>/worker-<n>/<slug>` and return the paths with the report.

## Make the platform a validated profile (MV1)

**Depends on.** None. This implements #711 and adds the Anthropic stage field #715 needs.

**Files.**

- [ ] Create `src/platform.ts` with the `PlatformProfile` type, the `exe-dev` default, the `exmach` profile taking a domain, and `parsePlatformProfile`.
- [ ] Create `test/platform.test.ts`.
- [ ] Edit `server/sandbox/routes.ts`, `src/markers.ts`, `src/publication.ts`, `src/adapters/github.ts`, `src/admission.ts`, `src/workflow.ts`, `server/cli.ts` and `server/controller.ts` to read the profile.
- [ ] Edit the existing tests that pin these constants, including `test/sandbox/routes.cases.ts`, `test/github-adapter.test.ts`, `test/admission.test.ts` and `test/orchestrator.test.ts`.
- [ ] Create `docs/operations/platform.md`. Edit `docs/operations/sandbox.md` only where it names the model host, edge address or forbidden domains.

**Build.**

- [ ] Define `PlatformProfile` with these fields. `modelHost`, `edgeAddress`, `modelBasePaths` per provider, `forbiddenDomains`, `controllerLogin`, `controllerAppSlug`, `botEmail`, `ghHost`, `repositories`, and `anthropicStages`.
- [ ] Parse the profile once at controller and gateway startup in `parsePlatformProfile`. Fail closed with a named error. Trust the parsed value everywhere after that.
- [ ] Refuse any profile whose `forbiddenDomains` lacks its own platform domain or `int.<domain>`.
- [ ] Make the `exe-dev` default byte-equal to today's values, including `anthropicStages` set to accept and code-review only.
- [ ] Ship the `exmach` profile with `llm.int.<domain>`, flat `/v1/responses` and `/v1/messages` paths, edge `10.74.1.1`, `github.int.<domain>`, and `anthropicStages` still set to accept and code-review only. `MV7` lifts it.
- [ ] Replace every hard-coded site. These are `server/sandbox/routes.ts:170`, `:176`, `:250-258` and `:518`, `src/markers.ts:14-15`, `src/publication.ts:35-36`, `src/adapters/github.ts:1179`, `server/cli.ts:1053`, `server/controller.ts:8079`, `src/admission.ts:52-54` and the `ANTHROPIC_RULE` text in `src/workflow.ts`.
- [ ] Select the profile at the host, as the walkthrough settles. The proposed contract is one unit variable, `FACTORY_PLATFORM=exe-dev` or `FACTORY_PLATFORM=exmach:<domain>`, with an unset value meaning `exe-dev`.

**You see.**

- [ ] With no profile set, `status --json` reports `platform.name` as `exe-dev` and every route matches trunk.
- [ ] With `FACTORY_PLATFORM=exmach:example.net` and no forbidden `example.net`, startup exits 2 with `event=platform_invalid reason=own_domain_not_forbidden`.
- [ ] `rg 'exe\.xyz|exe-dev-github-integration|169\.254\.169\.254' src server` finds only `src/platform.ts` and the echo fixture.

**Verify, unit.** Tests alone are not sufficient verification. A PR is verified only when its unit, live, and perf boxes are all checked.

- [ ] `test/platform.test.ts` gains cases for the default equal to trunk values, exmach routing to `llm.int.<domain>` on the flat paths, the forbidden list blocking `<domain>` and `int.<domain>`, an omitted own domain refused, an unknown field refused, and an empty repository list refused. Run `npm run check`.
- [ ] `test/sandbox/routes.cases.ts` gains cases that a sandbox request to `llm.int.exmach.net` and to `x.int.exmach.net` is refused under the exmach profile. Run `npm run check`.

**Verify, live.** Tests alone are not sufficient verification. A PR is verified only when its unit, live, and perf boxes are all checked. Ten lanes on `task:qa` at the PR head, per the boot recipe.

- [ ] Lane 1. Regression lane against trunk. On `pi-factorio`, start the gateway and run one sandbox model request at trunk and head with no profile set. Save `default-parity.json`. Pass when both reach the model through the same host, path and edge address with the same status.
- [ ] Lane 2. On `pi-factorio`, run `status --json` at head with no profile. Save `status-default.json`. Pass when `platform.name` is `exe-dev` and dispatch reasons match trunk.
- [ ] Lane 3. On `pi-factorio`, start the controller at head with `FACTORY_PLATFORM=exmach:example.net` and a profile that omits its own domain. Save `invalid-profile.log`. Pass when it exits 2 with `platform_invalid` and launches no stage.
- [ ] Lane 4. On `pi-factorio`, start at head with a malformed `FACTORY_PLATFORM`. Save `malformed-profile.log`. Pass when it exits 2 and never falls back to `exe-dev`.
- [ ] Lane 5. On the exmach VM, start the gateway at head with `FACTORY_PLATFORM=exmach:exmach.net` and send one OpenAI request from a sandbox. Save `exmach-openai.json`. Pass when the upstream is `llm.int.exmach.net/v1/responses` and the reply is 200.
- [ ] Lane 6. On the exmach VM, send one Anthropic accept-stage request from a sandbox. Save `exmach-anthropic.json`. Pass when the upstream is `llm.int.exmach.net/v1/messages`, the client credential is stripped, and the reply is 200.
- [ ] Lane 7. On the exmach VM, from a sandbox, request `https://github.int.exmach.net/`, `https://reflection.int.exmach.net/` and `https://exmach.net/`. Save `forbidden-exmach.json`. Pass when all three are refused by the gateway with the forbidden-domain reason.
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
- [ ] Lane 6. After E2, run `drive-gh.sh` reads against the exmach VM. Save `gh-reads-factorio.txt`. Pass when `gh repo view` works with `GH_HOST=github.int.exmach.net` on the VM.
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

**Depends on.** MV1. This implements #713. Live lanes need exmach E2 and E5.

**Files.**

- [ ] Edit `server/provision.sh` and `server/factory.service`.
- [ ] Edit `server/cli.ts` only for the `/run/user/1000` preflight check.
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

**Depends on.** MV1. This implements #712 under the owner's drain decision.

**Files.**

- [ ] Create `docs/operations/drain.md`.
- [ ] Edit `server/cli.ts` and `server/controller.ts` for the `status` report of markers by a login other than the profile's.
- [ ] Edit `test/markers.test.ts` and `docs/operations/factory-cli.md`.
- [ ] The owner edits `.github/workflows/check.yml:46` and `.github/workflows/ci.yml:116` to the new bot login, in a commit no agent writes.

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
- [ ] Hand MV4 to the owner as STACK-READY. The owner lands it after MV1, with the owner's `.github/` commit.

## Cut production over to the exmach VM (MV5)

**Depends on.** MV1, MV2, MV3 and MV4 landed, exmach E1 to E4 closed, and the owner's cutover grant.

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

## Reach the owner through Shep, not a browser viewer (MV6)

**Depends on.** MV5. This implements #714 with option B, the owner's 2026-11-10 decision, and #716. The push lanes need exmach E6.

**Files.**

- [ ] Edit `docs/operations/viewer.md` for loopback-only on exmach and the Shep bridge reading OwnerFeed v1.
- [ ] Edit the F09d section of `docs/plans/factory-v1.md` for the push rule.
- [ ] Create `test/fixtures/owner-feed/push-max.json` and a case in `test/feed.test.ts`.

**Build.**

- [ ] Document that the viewer stays on `127.0.0.1` on exmach and the owner reads state through the Shep app.
- [ ] Change the F09d push rule to a title of at most 64 bytes and a body of at most 256 bytes, counted in UTF-8 bytes.
- [ ] Write down that the bridge sends from the feed and the controller never calls `apns.int`.
- [ ] Define the collapse key as one per issue, so a newer state replaces an older push. Debounce so a busy hour stays under 30 sends.

**You see.**

- [ ] The Shep app shows the factory's OwnerFeed counts, and one push of 256 bytes or less arrives for a needs-you state.

**Verify, unit.** Tests alone are not sufficient verification. A PR is verified only when its unit, live, and perf boxes are all checked.

- [ ] A case shows the longest allowed body in `push-max.json` fits 256 bytes after the edge's `<vm>: ` prefix. Run `npm run check` and the plan checker on `factory-v1.md`.

**Verify, live.** Tests alone are not sufficient verification. A PR is verified only when its unit, live, and perf boxes are all checked. Ten lanes on `task:qa` at the PR head, per the boot recipe.

- [ ] Lane 1. Regression lane against trunk. Run `owner-feed --json` on the exmach VM at trunk and head. Save `feed-parity.json`. Pass when the feed is byte-identical.
- [ ] Lane 2. Read the viewer's listen address on exmach. Save `viewer-bind.txt`. Pass when it is `127.0.0.1` only.
- [ ] Lane 3. From another tailnet host, try the viewer port on the VM. Save `viewer-reach.txt`. Pass when it is unreachable.
- [ ] Lane 4. Read the bridge's feed fetch on the VM. Save `bridge-feed.json`. Pass when it reads OwnerFeed v1 locally.
- [ ] Lane 5. Put a fixture issue into a needs-you state. Save `app-counts.png`. Pass when the app's counts match the feed.
- [ ] Lane 6. Trigger one needs-you push. Save `push.png`. Pass when the push arrives with a title of at most 64 bytes and a body of at most 256 bytes.
- [ ] Lane 7. Change the same issue's state. Save `collapse.png`. Pass when the newer push replaces the older one.
- [ ] Lane 8. Replay a burst of 40 state changes on fixture issues. Save `rate.json`. Pass when the bridge sends at most 30 in the hour.
- [ ] Lane 9. Read the controller's egress during lanes 6 to 8. Save `egress.txt`. Pass when the controller made no `apns.int` request.
- [ ] Lane 10. Run the plan checker on `factory-v1.md`. Save `check-plan.txt`. Pass when it prints `22 PR sections, 0 problems`.

**Verify, perf.** Tests alone are not sufficient verification. A PR is verified only when its unit, live, and perf boxes are all checked.

- [ ] Metric. Time from a needs-you state in the feed to the push on the phone. Trunk has no push path, so trunk measures the feed only.
- [ ] Probe. Run three needs-you transitions on head and three feed reads on trunk. Save `perf.json`.
- [ ] Baseline. Record trunk feed generation time first.
- [ ] Rule. Fail if feed generation exceeds trunk by more than 10 percent, or a push takes more than 60 seconds after the state change.

**Review gate.** The operator reviews before merge.

- [ ] Copy lanes 5 and 6 screenshots into `docs/plans/media/MV6/MV6-review-app.png` and `docs/plans/media/MV6/MV6-review-push.png`.
- [ ] Record a 30 to 60 second video of a needs-you push arriving and collapsing. Save it as `docs/plans/media/MV6/MV6-review.mp4`.
- [ ] Post the screenshots and the video to the operator in chat. Stop at STACK-READY.

**Merge.**

- [ ] Root's clean verdict at the exact head SHA.
- [ ] Bugbot triage done.
- [ ] Rebased onto current trunk after the verdict, with the verdict still valid under the patch-id rule in `playbooks/shipping.md`.
- [ ] Hand MV6 to the owner as STACK-READY. The owner lands it.

## Allow Anthropic stages on the exmach profile (MV7)

**Depends on.** MV5. This implements #715 under decision D6.

**Files.**

- [ ] Edit `src/platform.ts` to widen `anthropicStages` in the `exmach` profile.
- [ ] Edit `server/sandbox/anthropic-limits.ts` against exmach's `GET /v1/models`.
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

- **Profile in the trusted `WORKFLOW.md`.** Rejected as the default. The forbidden-domain list guards the host the controller runs on, so it belongs to the host, not to repository content. The walkthrough may reverse this with evidence.
- **Accept a list of historical bot logins.** Rejected by the owner's drain decision. It changes a trust check and leaves a standing risk.
- **Viewer `--bind` for the exmach app proxy (#714 option A).** Rejected by the owner on 2026-11-10 in favour of Shep only. Revisit only if the browser dashboard is missed.
- **Adding these PRs to `docs/plans/factory-v1.md`.** Rejected because its checker must print `22 PR sections`.
- **Folding the verification skill repoint into `MV3`.** Rejected so the lanes can reach the exmach VM before provisioning code lands.

## Appendix C. Risks

- **Forbidden-domain gaps (MV1).** A missed `int.` host lets a sandbox reach the edge. The owner watches the cross-family audit lane and `MV1` lanes 7 and 8.
- **Unknown bot slug (MV1, MV4).** E2 yields it. Until then the `exmach` profile cannot be filled and the `.github/` edits wait.
- **Request budget (MV5, MV7).** 600 requests per hour per VM is inference from the issue. A 429 is a stage failure. E3 sizes it from `MV5` receipts.
- **No interleaved baseline (MV5).** One controller at a time means trunk numbers come from `pi-factorio` receipts.
- **No backups until exmach M5 (MV5).** `backup.md` runs manually to an off-VM target.
- **Residual risk unchanged.** A bwrap escape lands on `exedev` with sudo, and the edge's GitHub integration answers any VM process, per `docs/operations/sandbox.md` section 1.2.
- **Spend.** `MV5` and `MV7` run full tickets at about 540,000 reserved tokens each. Check the program cap with the owner before they launch.
- **Out of scope.** #717 rewrites F13's credential section in `docs/plans/factory-v1.md` in its own docs PR before F13 starts. #718 becomes its own plan after `MV5` and giuseppecrj/exmach#83.
- **Missing trails directory.** `../pi-herdr-factorio-trails/` does not exist on this machine, so its `checked-push.sh` is missing too. Restore or recreate it before the first push.

## Appendix D. Links and reading list

- Issue #719 and its items #711 to #718.
- `docs/operations/sandbox.md`, `docs/operations/backup.md`, `docs/operations/viewer.md` and `docs/operations/factory-cli.md`.
- `MV1` gets the how skill at `/home/g/.pi/agent/npm/node_modules/pi-herdr-pstack/skills/how/SKILL.md` and the interrogate skill at `/home/g/.pi/agent/npm/node_modules/pi-herdr-pstack/skills/interrogate/SKILL.md`.
- The trail follows the show-me-your-work skill at `/home/g/.pi/agent/npm/node_modules/pi-herdr-pstack/skills/show-me-your-work/SKILL.md`.
- Leaf skills are `technical-writing`, `unslop`, `no-comments` and `typescript-best-practices`, under `/home/g/.pi/agent/npm/node_modules/pi-herdr-pstack/skills/`.
