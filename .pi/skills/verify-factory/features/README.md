# Factory verification map

`.pi/skills/verify-factory/features/` is the maintained source for verifying pi-herdr-factorio. Read this index, then use the matching feature file in that directory as the recipe.

## Baseline preconditions

Read [the skill's target restrictions](../SKILL.md#target) first. `pi-factorio` was retired and deleted on 2026-11-13 (#734), with its state archived. `nubl-factory` is held production and permits routine read-only checks only. Upgrades, bridge installation, the hold-lift and fixture runs each need Giuseppe's explicit go. The legacy lane commands below require separate authorized target and fixture grants and must not run against production. Installer lanes use the explicit disposable target in `installer.md`.

- Run `.pi/skills/verify-factory/scripts/vm.sh .pi/skills/verify-factory/scripts/doctor.sh` and require `doctor=ok`.
- Commit the change under test, then run `.pi/skills/verify-factory/scripts/lane-setup.sh <pr-id> <worker-n>`.
- Work only in `/home/exedev/factory-verification/<pr-id>-w<n>/`.
- Take a VM snapshot before the first lane and after the last one, and diff the two. See "Snapshot" in `SKILL.md`.
- Never drive a process this run did not start. Never run two controllers over the same issues. Always scope `tick`, `run` and `serve` with `--issue` to the lane's fixtures.

## Driving conventions

- `S` is `.pi/skills/verify-factory/scripts`. Run commands from the repository root.
- Send scripts with `$S/vm.sh`. Do not inline multi-line scripts in ssh. Inspect `vm.sh`, `target.sh`, and the target record before SSH. Set `FACTORY_VM` explicitly. An unset or retired target refuses before SSH. See "Target" in `../SKILL.md`.
- Only in the trusted VM environment, use the target's `GH_HOST` from `../targets.env` and repository-scoped `gh` reads. Never set that host locally. Do not call `gh api user`.
- Do not remove evidence during cleanup.

## Proof and skip reporting

- Evidence goes to `/tmp/swarm-<pr-id>/worker-<n>/` on the VM.
- Record the command, timestamps, head SHA, expected result, actual result and exit status.
- Report an unreachable path with the attempted command and the unmet precondition. Distinguish source-checked/unrun recipes, local saved-state/fake-transport checks, historical scratch evidence, and native VM/Actions/owner-action proof. A targeted recipe update is not the full maintain-verification-skill source wave or live sweep.
- A stub feature is not verified. Report it as not implemented.
- Older recipes retain revision-specific observations. `status-json.md` and `handoff.md` still describe six attention groups and older caps. Current attention has seven groups, including `budget`. Current review, repair-build, and run token caps are 120,000, 300,000, and 800,000. Follow the active plan and source, not those old figures or pre-merge bootstrap wording. Historical observations are not fresh qualification.

## Features

- **VM doctor** (`.pi/skills/verify-factory/features/vm-doctor.md`): VM reachability, tool versions, scoped repository read.
- **Repository reads** (`.pi/skills/verify-factory/features/gh-reads.md`): `gh` repo view, label list, issue list.
- **Factory status command** (`.pi/skills/verify-factory/features/factory-status.md`): `/factory status`.
- **workflow-check** (`.pi/skills/verify-factory/features/workflow-check.md`): load and validate the trusted `WORKFLOW.md` from a branch.
- **status --json** (`.pi/skills/verify-factory/features/status-json.md`): trusted settings, saved controller state, and shared VM-local attention with explicit unavailable/gaps.
- **admit** (`.pi/skills/verify-factory/features/admit.md`): admission receipts for `factory:ready` label events, both kill switches, snapshot binding and deduplication.
- **tick --once and run --issue** (`.pi/skills/verify-factory/features/tick-once.md`): one controller tick, claims, markers, capacity, restart recovery, forged and corrupt markers, missing workspaces and the switches.
- **Sandboxed stage** (`.pi/skills/verify-factory/features/sandbox-stage.md`): the sandbox preflight, a sandboxed `specify` stage, `blocked` for `sandbox_unavailable`, the host-side receipt, the bundle digest, the egress log and the stderr file.
- **Specify** (`.pi/skills/verify-factory/features/specify.md`): a contract and its summary for a clear issue, questions with the label swap and `needs_info` for a vague one, and a linked run after an answer and a fresh label.
- **Acceptance** (`.pi/skills/verify-factory/features/acceptance.md`): a fresh contract-only session, private digest-bound suite, redacted mappings and a pre-build canary denial.
- **Build** (`.pi/skills/verify-factory/features/build.md`): scoped ticks through base qualification, then build, following the recorded phase. `src/candidate/stages.ts` moves to build only on an `accepted` event with a base proof. Verify a fresh builder workspace, exact private patch, base-owned visible command, typed retries, recovery, cleanup and the builder canary probe.
- **Validation** (`.pi/skills/verify-factory/features/validation.md`): deterministic patch and held-out commits, bot dispatch, identity-bound receipts, slot-free restart recovery and the real sanitized repair probe.
- **Review** (`.pi/skills/verify-factory/features/review.md`): fresh seats, exact bindings, shared repair cap, sanitized rebuilds and round-aware viewer evidence.
- **Human handoff** (`.pi/skills/verify-factory/features/handoff.md`): exact-head reporter trust, stable PR refresh, token-free waiting, merge-first drain, conditional owner protection, rollout, and native proof gates.
- **Viewer** (`.pi/skills/verify-factory/features/viewer.md`): read-only HTTP evidence, published versus working generations, receipt/session/accounting gaps, and privacy guards.
- **serve** (`.pi/skills/verify-factory/features/serve.md`): the controller daemon, `controller_ready`, the single-controller lock, reconcile before dispatch and SIGTERM stop.
- **Replay** (`.pi/skills/verify-factory/features/replay.md`): pinned previous/candidate comparisons, shared reservations, supervised restoration, and report comparability.
- **Installer** (`.pi/skills/verify-factory/features/installer.md`): disposable-target preflight, fresh held installation, same-SHA rerun, upgrade, and failure recovery.
