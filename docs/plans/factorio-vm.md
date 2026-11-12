# Plan the later Factorio move to ms-a2

Plan a later move from `nubl-factory` on exe.dev to a dedicated LXD virtual machine on `ms-a2`, when the owner needs more power.
Factorio's first real host is `nubl-factory`, which the owner installs by hand with the one-command installer on main.
Keep testing on exe.dev and use Shep's Factory tab as the owner's client.
Run the controller, Shep bridge, and restricted pi orchestrator in one guest as one Unix user, `factory`, with stages still isolated by bwrap.
Protect production credentials from host agent sessions before installing any secret.
Carry the complete state and replay budget from `nubl-factory` through a drained, single-controller cutover.
Plan `VM1` through `VM9` below. Reuse main's installer, MV1, MV2, MV3, and MV6, plus the parked MV4a and MV4b patches.
Keep the new controller held until the owner separately approves dispatch.

## How to read this

One box is one unit of work. Every box names the evidence that checks it. A nested box is a sub-step of the box above it. Check a box only when its evidence exists, a file, a log line, a screenshot, a test run, or a SHA. The body is a how-to. The appendices explain and record.

The program runs the poteto-mode playbook `playbooks/autopilot-stack.md`. Every PR, `VM1` through `VM9`, stops at STACK-READY. VM3 through VM5 share the deferred guest qualification described below. The owner lands every PR. This document grants no execution authority. No current grant covers LXD initialization, VM creation, host changes, guest provisioning, credentials, tailnet policy, production stops, or cutover. Obtain separate recorded grants before those actions. The old exmach grant does not authorize this program.

Use `.pi/skills/verify-factory/SKILL.md` as the control skill. Backend lanes save redacted logs and JSON instead of screenshots. `VM9` also requires real phone screenshots and video. Ten lanes mean ten scenarios, not ten simultaneous controllers. Run resource-heavy lanes serially. A blocked prerequisite leaves its boxes unchecked, not passed by a mock or a source review.

Treat new paths, fields, units, and acceptance budgets as proposed contracts. This revision uses main at `e6a3d74`, including the repository move in #742 and the installer and MV3 provisioning in #743. It preserves Amendment 1's shared-user design and the orchestration v1 decision in `nublai/root` at `.pi/plan/research/orchestration.md`. Appendix A separates supplied host observations from unrun prototypes. The leaf author runs no prototypes, launches no children, and changes no host, as required by the design-only brief. Execution must close the named prototype gates before implementing the affected contracts.

Keep #730 design-only. Start this move only when the owner decides that `nubl-factory` lacks the compute, memory, or storage for the workload they want to run. That decision, not an invented utilization threshold, is the trigger for execution. The owner's 2026-11-10 to 2026-11-11 decision puts the manual exe.dev installation first. #712 plans the earlier `pi-factorio` drain. Drain completion is not established here. Retiring `pi-factorio` after `nubl-factory` works belongs to #734, not this plan. #713 and #718 are closed. Do not infer that the new host is installed or qualified from those issue states.

Tests alone are not sufficient verification. A PR is verified only when its unit, live, and perf boxes are all checked.

## Program checklist

### Arm the program

- [ ] State the protocol and this plan to the operator, then stop. Start execution only on the operator's explicit go. Record the go and each action grant in `docs/decisions.tsv`.
- [ ] Read these from the installed skill directories at program start. Re-read them at every audit.
  - [ ] The poteto-mode playbook `<pstack>/skills/poteto-mode/playbooks/autopilot-stack.md`, resolving `<pstack>` from the installed skill inventory, and its referenced `autopilot-full.md`.
  - [ ] The swarm skill, `<pstack>/skills/swarm/SKILL.md`.
  - [ ] The control skill, `.pi/skills/verify-factory/SKILL.md`.
  - [ ] The poteto-mode playbook `<pstack>/skills/poteto-mode/playbooks/opening-a-pr.md` and `shipping.md` beside it.
  - [ ] Each other leaf skill named with its installed path in Appendix D.
- [ ] Run the audit at every child delivery, at every stall or no-progress advisory, and on the operator's request. Nothing schedules it, so never promise a timed cadence and never leave the audit to memory.
- [ ] Use this audit prompt, verbatim. "Re-read the execution playbook. Audit the operation against it and fix drift in this audit. Check every active lane and judge progress by side effects only. Cancel a stuck lane and launch its fresh replacement now. Then post a short status message to the operator in chat only when the audit found a tracked change that no earlier status message reported, such as a PR opened, a code-ready head, a round launched or closed, a verdict, a merge, a stuck agent and the action taken, a blocker added or cleared, or a decision only the operator can make. Name every such change and nothing else. Do not repeat a table, the merged list, or an unchanged blocker. If the audit found none, end the turn with no reply text. Either way, log this audit's row in your decision trail. The row names the items reported, or none."
- [ ] On the operator's hold or stand-down, cancel every running child with `subagent_cancel` at once and launch nothing new.
- [ ] Obtain owner decision D1 before any secret installation. Choose a host-agent account boundary from Appendix B. Recommend a separate unprivileged `agents` user with no sudo, LXD access, owner SSH agent, or readable owner home. The owner performs this host-wide migration outside the VM PRs and supplies its process audit and denial receipts to VM2. Include every Herdr and Shep launcher, not just this session.
- [ ] Obtain owner decision D2 for the proposed 4-vCPU, 12-GiB, 160-GiB Ubuntu 26.04 cloud VM, the dedicated storage pool, bridge, and profile in `VM2`. Record the approved pool backing and subnet before LXD initialization.
- [ ] Obtain owner decision D3 for CLIProxyAPI access and the App broker in `VM3` and `VM4`. Record permitted models, separate controller and orchestrator proxy keys, per-key proxy-side rate and spend caps, GitHub installation scope, and who installs and rotates secrets. Record the orchestrator's model, thinking level, per-turn and daily token limits separately from stage accounting. Keep current stage families and budgets unless the owner changes them. Missing proxy-side cap support blocks production keys, not a promise that local caps protect a stolen key.
- [ ] Obtain owner decision D4 for the guest tailnet tag, ACLs, owner devices, bridge port, admin route, and restricted verification SSH path below. Obtain D5 for the encrypted off-host backup destination, retention, and recovery targets before D6.
- [ ] Obtain owner decision D6 only after VM8's runbook, transfer path, fixture restore, and rollback rehearsal are ready. Propose at most 60 minutes from source stop to a usable held destination or restored source, with a rollback decision at 30 minutes. Record any revised target before the drain. Report subsequent owner-requested dispatch hold time separately. Obtain D7 separately for bounded dispatch qualification and eventual real dispatch. A grant to restore or start held grants neither.
- [ ] Before execution, read the owner's `nubl-factory` installation and #734 handoff receipts. Record its deployed SHA, state and replay-budget paths, integration access, and dispatch state. Use `nublai/pi-herdr-factorio` for all active operations. Require fresh source reads for this later move rather than carrying forward the retired host's status.
- [ ] Before any orchestrated intake, require #738's named, cached `bot_actor` refusal and its live creation-time-label lane on an exe.dev test VM. The lane must prove that Giuseppe's Submit through the prefilled link supplies the human label actor and a valid snapshot. Keep intake blocked if either proof is missing. Do not loosen snapshot checks without the owner.
- [ ] Ask the owner to approve two isolated repositories, proposed as `nublai/factorio-vm-app-test` for nubl-agent CI and `nublai/factorio-vm-exe-test` for exe-dev CI. These names are reservations, not existing resources. Record final names and test VM targets before VM1 runs. Attach the old integration to the App test repository only for VM7's negative actor probe. After the production CI actor switch, the old exe.dev bot cannot drive production's trusted CI.

### Launch owner rounds

- [ ] Give each PR one owner role with the full lifecycle the execution playbook names. Each round is a fresh bare leaf child the root launches. Use the live scoped catalog and task routing with an explicit supported thinking level. Record the selected model, files, verification, and commit policy in `../pi-herdr-factorio-trails/<PR>/brief.md`.
- [ ] Follow this dependency graph. Start dependent work only after its parent merges, or base it on the parent branch when the execution playbook stacks.
  - [ ] `VM1` and `VM2` are independent and first. Both branch from `main` with `--no-track`.
  - [ ] `VM3` follows `VM2` and its measured model endpoint pin. `VM4` follows `VM3`. Choose deferred guest qualification, not an early production install. VM3 and VM4 may reach code-ready with local and exe.dev evidence, but their guest lanes and guest perf stay pending until VM5 installs the runtime from the stack.
  - [ ] `VM5` stacks on `VM1` and `VM4` without requiring those deferred lanes to have passed. The owner installs the pinned stack held in disposable guest state, then completes VM3 and VM4's guest lanes before VM5's full verdict. Only then are those PRs STACK-READY for bottom-up landing. Reuse main's installer and provisioning contracts, adapting only the guest installation and service-user assumptions.
  - [ ] `VM6` follows `VM1`. Reuse parked MV4a. Land its diagnostic code before the production drain.
  - [ ] Prepare `VM7` after `VM5` and `VM6`, reusing parked MV4b. Prepare and review `VM8` stacked on VM7, with D5 settled and fixture transfer, restore, and rollback rehearsals complete before D6. Do not stop production for PR authoring or an off-host restore rehearsal.
  - [ ] Execute the production drain only after VM5 passes and D6 is granted. The owner then lands VM7's CI switch. Its main-backed proof gates VM8's production transfer, not VM8's preparation. Keep both controllers from dispatching throughout.
  - [ ] `VM9` follows `VM8` and the Shep bridge and Factory tab readiness evidence. D7 gates its real fixture dispatch, not earlier planning or held reads.
- [ ] Hold the file boundaries. Each PR touches only its **Files** block. No PR changes exmach or Shep source. Relay those dependencies to their owners. The coordinator alone handles `VM7`'s two workflow edits under a renewed explicit grant.
- [ ] Hold the review gate. `VM9` changes the phone interaction and waits for the operator's screenshots and video review. Other PRs still require the owner's landing decision.
- [ ] Run the how walkthrough for `VM2`, `VM3`, `VM4`, and `VM5`. Use the bounded prototypes in Appendix A to resolve engineering questions before implementation. Stop after one bounded round per question and report any unresolved gate.

### PR mechanics, for every PR

- [ ] Use `gh` for every PR operation. Confirm `gh auth status` once and confirm the repository is `nublai/pi-herdr-factorio`. Never require Graphite. Never set `GH_HOST` on ms-a2 for a guest operation.
- [ ] Open the PR ready, never draft, per **Opening a PR**, only under the operator's grant that names PR creation. Use `gh pr create --base <base-branch>`. A stack child targets its parent branch.
- [ ] Run `npm run check`, including lint and typecheck, before the PR-facing push. Push with hooks on, only under the push grant, using checked-push or explicit `HEAD:refs/heads/<branch>`.
- [ ] Run a manual diff cleanup pass before each commit and `/skill:no-comments` before review. Retain required `SAFETY:` comments. Apply technical-writing and unslop to every runbook.
- [ ] Triage every Bugbot and security-reviewer comment per `<pstack>/skills/poteto-mode/references/bugbot-triage.md`.
- [ ] Rebase onto current trunk, or the recorded stack parent, before the code-ready report and babysit. Keep that merge base in fix rounds. Rebase again only at merge prep, on a `git merge-tree` conflict with trunk, on a CI failure that comes from a change on trunk, or when a known concurrent change to the same files lands.
- [ ] Run the plan checker on this plan after an edit. Leave `docs/plans/factory-v1.md` unchanged by this program unless the owner grants a separate amendment.

### Verdict and merge, for every PR

- [ ] At the code-ready head SHA and at each later push that changes the patch, run the swarm per `<pstack>/skills/swarm/SKILL.md`. The root launches the lanes per `references/fan-out.md`. Run one gates lane, the ten live lanes on `task:qa`, and the perf lane. Two or more audit lanes use the Reviewer prompt and exact authenticated models from a different provider and model family than the author. Focus one on credential and authority boundaries and one on recovery and consumer parity. The root audits the receipts before the verdict. Report an unavailable independent reviewer as blocked.
- [ ] Run `npm run check` and the trusted-reporter command in verify-factory for source PRs. Require `complete=true`, `bad=false`, and an empty failure list. Save exact-head CI and a clean merge-tree result.
- [ ] Clean only when every lane is `PASS`. Findings go back in one batch. A defect that a lane filed as a note is a finding. Apply the repository's convergence rule after the first fix round. A new head gets a fresh verdict, except for lane results retained under the patch-id rule in `playbooks/shipping.md`. Owner-gated live actions stay blocked until authorized.
- [ ] Stop at STACK-READY. Give the owner each verdict SHA, base SHA, patch-id, and pending gate, if any. Hand a blocked PR over as code-ready only, never fully verified. The owner lands verified PRs bottom-up. Re-run mergeability and CI after every rewritten push even when the patch-id is unchanged. Nobody pushes after handoff without the owner's go.

### Boot recipe, for every live lane

Each live lane runs at the PR head, except VM3 and VM4's explicitly deferred guest checks. Qualify those together with VM5 at its integration head, recording all three component SHAs and the installed SHA. Do not call that a live pass on an uninstalled parent-only revision. Drive the CLI through verify-factory. Drive the phone through Shep's supported bridge and native UI, never directly to Factorio.

Every LXD-admin action is owner-run, including inspection, image and storage probes, guest execution, reboots, snapshots, and restores. Guest root actions, commands as `factory`, private-state reads, and service or credential changes are also owner-run. This rule applies to every Build, live, and perf box below. Agents prepare commands and assess redacted owner-captured transcripts. A grant does not give an agent an admin key or LXD membership.

Agents use only `factory-verify@<guest-tailnet-name>` with the dedicated key `/home/agents/.ssh/factorio-ms-a2-verify_ed25519`. This password-locked, public-key-only account has no sudo, supplementary service groups, production credentials, or private-state access. Its root-owned authorized key forces `/usr/local/libexec/factorio-verify-read`, with no PTY, forwarding, user rc, or arbitrary shell. Allow only `versions`, `unit-state`, and `receipt <id>`. `unit-state` returns only the fixed units' `ActiveState`, `SubState`, `UnitFileState`, and `NRestarts` fields. The last command reads owner-reviewed redacted receipts in root-owned `/var/lib/factorio-verification/exports`, never live state. Validate IDs, reject symlinks and traversal, and use fixed paths and argv. Do not expose raw journals, process environments, `status --json`, or `owner-feed` through that key. The owner runs those private reads and exports their redacted results. VM2 installs this path and VM1 teaches its wrappers to refuse unsupported commands before SSH. During VM2 through VM5, fill the guest target only in a disposable verification checkout after the owner supplies the name, host key, and verification-key fingerprint. VM8 records the approved production entry.

- [ ] In an authorized disposable checkout, run `git fetch origin <head-branch> && git checkout --detach <head SHA>`. Record trunk, head, image fingerprint, profile digest, and target. Keep checkouts under `~/.herdr/worktrees/`.
- [ ] Select the existing `FACTORY_VM=nubl-factory` target for source reads or `factorio-ms-a2`, added by `VM1`, for guest qualification. Use an owner-approved isolated exe.dev target for mutating regression tests. Always select the target explicitly, never the legacy default. Leave the parked exmach target unconfigured. Before the guest exists, use source and local checks only and label guest lanes blocked.
- [ ] On an authorized isolated exe.dev target, use `lane-setup.sh` with private per-lane state and `drive-serve.sh` for an issue-scoped controller. In the guest, the owner runs the equivalent setup and waits for `controller_ready`. The restricted verification key cannot launch a lane. Stop production under its service grant before a test controller accesses the same repository, even if production is held. Independent test repositories may run separately.
- [ ] Deliver inputs through the authorized CLI and `gh` path. The owner runs guest systemd commands, `status --json`, `owner-feed --json`, and scoped journal reads. Capture commands, timestamps, exit status, SHA, and redacted output in each owner transcript. Agents use the named read commands above. No secret appears in arguments, screenshots, or exported logs.
- [ ] Use separate fixture issues titled `[<PR>-w<n>-...]`. Reserve every stage's full allowance before a run, about 540,000 tokens for specify, accept, and build alone. Include review, repair, retries, and perf in the authorized total. Never narrow a stage to fit a lane cap. Close each fixture and confirm it is closed under the fixture grant. Leave `factory:enabled` alone.
- [ ] Save backend artifacts to `/tmp/swarm-<pr-id>/worker-<n>/<slug>` and phone screenshots to `/tmp/swarm-<pr-id>/worker-<n>/<slug>.png`. Include commands, timestamps, exit status, expected and actual results, and SHAs. Export only redacted copies.
- [ ] For code changes, measure trunk first and then three interleaved trunk/head pairs on the same target and fixture, with only one writer active. VM2 and VM8 are operational recipes and use the absolute qualification probes in their perf blocks, not code-regression ratios. An unsupported trunk path is not a successful baseline. Measure the shared operation on both sides and the added work separately. The numerical limits below are proposed acceptance budgets, not observations or permission to raise existing limits.

## Extend verification for the guest and isolated exe.dev tests (VM1)

**Depends on.** None. MV2 target selection is already on main. #743 already added `nubl-factory` as `exedev@nubl-factory.exe.xyz` with `GH_HOST=github.int.exe.xyz`. #742 already updated active repository probes and URLs. Do not repeat either change.

**Files.**

- [ ] Edit `.pi/skills/verify-factory/SKILL.md`, `.pi/skills/verify-factory/targets.env`, `.pi/skills/verify-factory/scripts/*.sh`, and `.pi/skills/verify-factory/features/*.md`.
- [ ] Edit `test/integration/replay-driver.test.ts` and create `test/integration/verify-targets.test.ts` for target and path validation.

**Build.**

- [ ] Extend the existing `target.sh` contract with validated non-secret target values for repository, platform, service user, home, and lane root. Preserve `nubl-factory`'s existing SSH destination and GitHub host. Remove the assumption that every target is `exedev` under `/home/exedev`. Leave legacy-target retirement to #734.
- [ ] Add `factorio-ms-a2` as an unconfigured target until VM2 supplies the guest tailnet name and verification key fingerprint. Its SSH user is `factory-verify`, with `/home/agents/.ssh/factorio-ms-a2-verify_ed25519`, `IdentitiesOnly=yes`, and no agent forwarding. Record `factory` separately as the runtime account, `github.com` as the runtime GitHub host, and `ms-a2-vm` as the profile. Support only the boot recipe's read commands on this target. Refuse `lane-setup.sh`, arbitrary `vm.sh` scripts, and remote environment exports there. Never substitute host `ms-a2`, an admin key, or `factory` SSH.
- [ ] Parameterize the remaining fixed repository and lane paths for the guest and isolated test repositories. Retain `nublai/pi-herdr-factorio` as the production repository. Preserve old run identities and archives verbatim. Make doctor distinguish a failed integration read from a failed sandbox preflight.
- [ ] Keep `nubl-factory` on the `exe-dev` profile with `exe-dev-github-integration[bot]`. Main already allows `nublai/pi-herdr-factorio`, so source checks need no repository override. Use an override only for an approved isolated test repository. After `VM7`, run full old-bot CI scenarios there with trusted CI configured for that bot, not against production's nubl-agent reporter.
- [ ] Document a separate exe.dev nubl-app test target. Give it its own test state and repository-scoped test token delivery, not a copy of production credentials or accounting. Use the production guest profile and tailnet model route there only after its prerequisites pass. Testing the nubl app remains on exe.dev. LXD-specific userns, resource, and recovery proof still runs in the real guest.
- [ ] Keep unknown targets, empty values, unsafe paths, and missing credentials fail-closed before SSH or dispatch. Save a matrix naming which target proves exe.dev transport, nubl-app behavior, and LXD deployment.

**You see.**

- [ ] Doctor prints the selected target, repository, profile, and SSH user. On exe.dev, `doctor=ok` requires a real repository read. On the restricted guest target, report `owner-evidence` with the receipt's command, SHA, target, and timestamp, never pretend that a cached receipt is a live repository probe. An unconfigured guest opens no SSH connection.

**Verify, unit.** Tests alone are not sufficient verification. A PR is verified only when its unit, live, and perf boxes are all checked.

- [ ] Cover default parity, malformed names, path traversal, shell metacharacters, empty fields, and the unconfigured guest in the integration tests. Run `npm run check` and `bash -n` on the changed scripts.

**Verify, live.** Tests alone are not sufficient verification. A PR is verified only when its unit, live, and perf boxes are all checked. Ten lanes on `task:qa` at the PR head, per the boot recipe.

- [ ] Lane 1. Regression lane against trunk. Select `FACTORY_VM=nubl-factory` and run doctor at trunk and head. Save `doctor-parity.txt`. Pass when both reach that VM and read `nublai/pi-herdr-factorio` through its attached integration.
- [ ] Lane 2. Run an unknown target. Save `unknown.txt`. Pass when it exits 2 before SSH.
- [ ] Lane 3. Run the unconfigured guest target. Save `unconfigured.txt`. Pass when it refuses rather than selecting the host or exe.dev.
- [ ] Lane 4. Run a target containing shell syntax. Save `unsafe-target.txt`. Pass when validation rejects it without a remote command.
- [ ] Lane 5. Set up an authorized exe.dev lane. Save `lane-root.txt`. Pass when only its declared private root changes.
- [ ] Lane 6. Under the source read grant, record fresh production status on `nubl-factory`. Save `source-status.json`. Pass when its profile is `exe-dev`, its identity is `exe-dev-github-integration[bot]`, and its actual hold or dispatch state is recorded unchanged. Do not assume production is held.
- [ ] Lane 7. Drive `/factory status` against an approved isolated test repository. Save `extension.txt`. Pass when the registered handler resolves that target's repository rather than the production default.
- [ ] Lane 8. Run a failed SSH target. Save `ssh-failed.txt`. Pass when its nonzero status and target name survive the wrapper.
- [ ] Lane 9. Exercise the replay driver with an isolated test budget. Save `replay-target.json`. Pass when it uses the selected repository and root and never reads production's replay file.
- [ ] Lane 10. Run an exe.dev test-repository fixture through its installed stages. Save `test-repo.json`. Pass when its markers and CI actor match the exe-dev bot and no production issue changes.

**Verify, perf.** Tests alone are not sufficient verification. A PR is verified only when its unit, live, and perf boxes are all checked.

- [ ] Metric. Doctor wall time and local target resolution time at trunk and head.
- [ ] Probe. Interleave three doctor runs per revision on exe.dev after the integration works. Save `perf.json` with resolution and SSH timings separately.
- [ ] Baseline. Record trunk's successful doctor median first. A 403 is a blocked baseline.
- [ ] Rule. Fail if head adds more than 1 second to doctor or local resolution exceeds 100 milliseconds. Require zero model calls.

**Review gate.** None. VM1 is not review-gated.

**Merge.**

- [ ] Root's clean verdict at the exact head SHA.
- [ ] Bugbot triage done.
- [ ] Rebased onto current trunk after the verdict, with the verdict still valid under the patch-id rule in `playbooks/shipping.md`.
- [ ] Append VM1 to the verified stack. The owner lands it.

## Prepare a dedicated LXD guest without host-agent authority (VM2)

**Depends on.** None. Owner decisions D1, D2, and D4 gate every host or LXD mutation.

**Files.**

- [ ] Create `docs/operations/ms-a2-vm.md` and `server/vm/ms-a2/cloud-init.yaml` with no credentials.
- [ ] Create `server/vm/ms-a2/lxd-preseed.yaml` and `server/vm/ms-a2/profile.yaml` as reviewed templates, not self-running host installers.
- [ ] Create `server/vm/ms-a2/verify-read.sh` and `test/integration/vm-verify-read.test.ts` for the forced-command reader. The owner installs it root-owned as `/usr/local/libexec/factorio-verify-read`.

**Build.**

- [ ] Record D1's choice before creating the guest. State plainly that `g` has passwordless sudo and belongs to `lxd`. Both give host-root-equivalent control over the VM. `g` can pull guest files, attach disks, or execute as guest root. VM isolation alone cannot hide a secret from agents running as `g`.
- [ ] Consume the owner's separate D1 host-migration receipt. Require the owner to audit `g`'s processes, lingering user units, cron jobs, timers, and self-hosted runners, including launchers that could start another privileged agent. End old agent processes and revoke inherited sessions before secrets enter the guest. Keep human-only recovery access. Prove the new agent account cannot use sudo, the LXD socket, owner SSH sockets, owner configuration, or the guest admin key. A group listing alone does not prove that privileged automation stopped.
- [ ] Owner-run under the LXD-initialization grant. Review the empty server again. Use a dedicated `factorio-pool` with the ZFS driver and a bounded 240-GiB loop-backed file on the existing filesystem as the proposed initial backing. Require host filesystem compatibility, free-space checks, and owner acceptance of loop-backed ZFS's performance and recovery cost before applying it. Prefer a dedicated block device if the owner supplies one. If ZFS is unsuitable, stop for D2's revised choice rather than silently using `dir`.
- [ ] Owner-run. Create a managed NAT bridge `factorio-br0` on a subnet verified not to overlap LAN, VPN, or existing routes. Do not attach a physical NIC or use macvlan. Disable guest IPv6 initially unless D4 includes its firewall policy. Do not expose the LXD API, cluster LXD, or grant agents access to its Unix socket.
- [ ] Owner-run. Create the explicit `factorio-prod` profile with a 4-vCPU limit, 12 GiB of RAM, a 160-GiB root disk on `factorio-pool`, and only the managed bridge NIC. Leave the empty `default` profile alone. Do not mount host homes, shared disks, LXD sockets, or devices into the guest. Set production autostart only after `VM8` removes the old controller's restart path.
- [ ] Owner-run. Launch `factorio-prod` as a VM from the Canonical Ubuntu 26.04 amd64 cloud VM image, never its container image. Record the image remote, fingerprint, checksum, guest kernel, and LXD version. The host has 16 cores, 32 threads, 89 GB RAM, and 1.4 TB free. Two 2-GiB, one-CPU stage scopes leave two vCPUs and about 8 GiB for the controller, gateways, bridge, restricted pi orchestrator, caches, and OS at this proposed size.
- [ ] Use cloud-init only for initial packages, the human admin and locked `factory-verify` accounts, approved public SSH keys, and guest setup. VM5 alone creates `factory` and enables its linger. For VM2's scope prototype, the owner uses a disposable `vm-probe` account with its own user manager, then removes it after the probe. Do not put App keys, proxy keys, APNs keys, or Tailscale enrollment secrets in cloud-init or LXD metadata. Install no host agent configuration in the guest.
- [ ] Owner-run. Enroll guest Tailscale under the approved `tag:factorio-prod`, without subnet routing or advertised routes. Allow owner devices to the bridge port and admin SSH, and the guest to mac-studio TCP 443. Allow the ms-a2 node only the SSH port for restricted verification. Configure sshd so connections from that node can authenticate only as `factory-verify`, never an admin or `factory`. Deny that node the bridge and other management paths. Tailscale ACLs do not distinguish Unix users sharing a node, so the forced key and sshd rules enforce the read restriction. Audit broad existing grants too.
- [ ] Owner-run. Deny new guest inbound connections from the `factorio-br0` subnet, including host-to-guest SSH and bridge ports. Permit only the explicit DHCP, DNS, and established-return traffic required by the network setup. Bind SSH and the exposed authenticated bridge endpoint to the guest tailnet address, not all interfaces. Prove this host-bridge denial separately from Tailscale ACLs.
- [ ] Document permanent guest egress. Permit controller HTTPS to `api.github.com`, `github.com`, and `codeload.github.com` for API, Git, and tarball redirects. Include `results-receiver.actions.githubusercontent.com` and the exact GitHub-returned Actions artifact blob hosts under `blob.core.windows.net`, recorded by VM4's download probe. Review those hostnames before allowing them, and send no GitHub credential to signed blob redirects. Permit gateway HTTPS to mac-studio and `registry.npmjs.org`. Npm is required at runtime, not only at install time, because visible tests run `npm ci` through the stage gateway. Restrict npm egress to that gateway's network policy, with no direct sandbox route.
- [ ] Permit the bridge HTTPS to `api.push.apple.com`, with `api.sandbox.push.apple.com` only for approved tests. Permit Tailscale control, relay and peer connectivity, DNS, and time sync. Temporarily allow Ubuntu mirrors, mise, Node, and pinned release downloads for owner-run provisioning and scheduled updates. Remove those temporary allowances afterward, but keep the runtime npm route. Record the firewall mechanism and endpoint list before applying it. Guest firewall rules do not replace the stage gateway's deny-by-default policy.
- [ ] Owner-run. Enable unattended security package checks and installation only in a recorded maintenance window, with automatic reboot disabled. Schedule kernel reboots after a hold, scope drain, and backup, then prove held readiness before restoring the owner's prior dispatch decision. Keep Node, Pi, bundles, and application revisions pinned. Monitor guest disk, inode, and host pool use. Propose owner alerts at 80 percent used and an owner-applied hold on new work at 90 percent, without deleting accounting. Record D2's approved thresholds, alert destination, and an owner-run alert test.
- [ ] Owner-run. Run the bounded guest prototype before fixing the image and pool choice. Prove bwrap user namespaces and cgroup delegation in the guest, two concurrent limited scopes, shutdown, and a snapshot restore without production secrets. Capture mac-studio's actual tailnet IP and TLS name for `VM3`. The host's userns sysctls and nested-KVM flag are observations, not guest proof.

**You see.**

- [ ] LXD reports one virtual machine named `factorio-prod` with the approved limits. The guest has its own kernel and tailnet identity. A host agent cannot administer it.

**Verify, unit.** Tests alone are not sufficient verification. A PR is verified only when its unit, live, and perf boxes are all checked.

- [ ] Validate cloud-init with `cloud-init schema --config-file server/vm/ms-a2/cloud-init.yaml` in an isolated environment. Test the forced reader's command allowlist, fixed paths, traversal and symlink refusal, and rejection of shell syntax and arbitrary arguments. Review preseed and profile against installed LXD help. Run `npm run check`. Record template checks separately from owner-applied live proof.

**Verify, live.** Tests alone are not sufficient verification. A PR is verified only when its unit, live, and perf boxes are all checked. Ten lanes on `task:qa` at the PR head, per the boot recipe.

- [ ] Lane 1. Regression lane against trunk. Have the owner run the same two-scope bwrap probe on exe.dev and the proposed guest. Save `scope-parity.json`. Pass when both enforce the existing stage limits and head adds the separate VM without claiming identical hardware performance.
- [ ] Lane 2. Owner-run. Inspect the image and instance type. Save `image.txt`. Pass when the recorded fingerprint is the approved Ubuntu 26.04 cloud VM and LXD reports `virtual-machine`.
- [ ] Lane 3. Owner-run. Inspect pool, disk, and free space and test the disk-use alert. Save `storage.txt`. Pass when the approved backing and 160-GiB limit hold, the snapshot has reserved headroom, and the owner receives the threshold alert.
- [ ] Lane 4. Inspect the owner's bridge-route and guest-egress transcript. Probe the guest bridge IP from the host agent account. Save `network.txt`. Pass when the subnet is non-overlapping, approved egress works, and new inbound SSH, bridge, and other service connections over `factorio-br0` fail. A Tailscale denial alone does not pass.
- [ ] Lane 5. Attempt administration from the host agent account using dummy data and review the owner's host-side audit. Save `host-agent-denied.txt`. Pass when sudo, LXD, owner SSH sockets, guest admin SSH, and owner home reads fail, and no agent process, user unit, cron job, timer, or self-hosted runner remains able to execute as privileged `g`.
- [ ] Lane 6. Have the owner test admin and bridge access, then use the `factorio-ms-a2` key and a denied tailnet identity. Save `acl.txt`. Pass when only approved paths work and the verification key accepts only its named reads. Require attempts to read `/run/factory-auth`, `/run/credentials`, `/etc/factory/credentials`, and the private state directory to fail. The owner also tests these filesystem denials as `factory-verify` with dummy canaries. Recheck after VM5 installs real directories. No private byte appears in exports.
- [ ] Lane 7. Owner-run. Run bwrap with the production seccomp filter. Save `userns.txt`. Pass when initial userns setup works inside the guest and further in-sandbox user and mount namespace creation is denied.
- [ ] Lane 8. Owner-run. Reboot the guest with no controller installed, automatic reboot disabled, and the disposable probe user's linger enabled. Save `reboot.txt`. Pass when its network and user manager recover without a human login.
- [ ] Lane 9. Owner-run. Restore a disposable stopped guest snapshot. Save `snapshot.txt`. Pass when file checksums and modes match and no second production identity joins the tailnet.
- [ ] Lane 10. Owner-run. Inspect mounts and metadata. Save `no-shares.txt`. Pass when no host home, management socket, credential, or enrollment secret is present in guest image metadata.

**Verify, perf.** Tests alone are not sufficient verification. A PR is verified only when its unit, live, and perf boxes are all checked.

- [ ] Metric. Qualify scope start and cleanup time, peak guest memory, and warm boot-to-verification-SSH time. This recipe changes deployment, not application code.
- [ ] Probe. Owner-run. Run three two-scope probes and three guest boots at one pinned application SHA and image. Save `perf.json` with redacted transcripts. Record exe.dev reference samples separately.
- [ ] Baseline. Record the first guest sample and its full configuration. Trunk has no LXD recipe, so no trunk/head code-regression ratio applies.
- [ ] Rule. Fail if warm scope startup exceeds 15 seconds, cleanup exceeds 10 seconds, or guest boot-to-verification-SSH exceeds 120 seconds. Require two scopes without OOM and peak guest memory below 10 GiB. A failure reopens sizing before provisioning, not stage allowances.

**Review gate.** None. VM2 is not review-gated.

**Merge.**

- [ ] Root's clean verdict at the exact head SHA, including D1 denial evidence.
- [ ] Bugbot triage done.
- [ ] Rebased onto current trunk after the verdict, with the verdict still valid under the patch-id rule in `playbooks/shipping.md`.
- [ ] Append VM2 to the verified stack. The owner lands it. Do not call the recipe live-verified before the authorized guest probe passes.

## Add the pinned guest platform and model credential (VM3)

**Depends on.** VM2 and D3. MV1's closed platform registry is already on main. Guest lanes 2, 3, 5, 8, and 9, plus guest perf, wait for VM5's owner-run stacked installation. Code-ready is not STACK-READY or full qualification while those checks are pending.

**Files.**

- [ ] Edit `src/trust/platform.ts`, `server/sandbox/routes.ts`, `server/sandbox/credentials.ts`, `server/sandbox/gateway-main.ts`, `server/sandbox/gateway-client.ts`, and `server/sandbox/control.ts`.
- [ ] Edit `server/sandbox.ts`, `server/cli.ts`, and `src/config/{schema,parse,load,views}.ts` only to carry the profile and credential references.
- [ ] Edit `test/platform.test.ts`, `test/workflow.test.ts`, and `test/sandbox/*.cases.ts` for the changed contracts.
- [ ] Edit `docs/operations/platform.md` and `docs/operations/sandbox.md`.
- [ ] Create `server/vm/ms-a2/factory.service` as the guest-only unit template with `LoadCredential=`. VM5 renders the actual UID and installs it. Leave `server/factory.service`, which `install-exe-dev.sh` copies, unchanged.

**Build.**

- [ ] Prototype one real Responses API stream through CLIProxyAPI with a non-production test key. Prove usage events, requested and observed model identity, cancellation, and exact endpoint paths. Bound this to one metered call per permitted provider plus scripted transport tests. If the proxy cannot preserve the required meter, stop rather than substituting an unmetered success.
- [ ] Add built-in selector and descriptor `ms-a2-vm` to `PlatformSelector`, `platformNetwork`, parsing, digest generation, and independent gateway resolution. Use domain `trout-dinosaur.ts.net`, model host and SNI `mac-studio.trout-dinosaur.ts.net`, and OpenAI base `/v1/`. Set `edgeAddress` to the single mac-studio tailnet IPv4 address measured in `VM2`, not ms-a2's `100.113.207.56` and not a guessed value. A changed endpoint requires a reviewed built-in update, not an arbitrary route-table pin.
- [ ] Set the proposed Anthropic base to `/` only if the protocol probe confirms `/v1/messages`. Keep xAI `null`. Keep `anthropicStages` limited to `accept` and `code-review`, and do not change WORKFLOW's active model choices or allowances. If Anthropic compatibility is unproved, mark its qualification blocked and keep production on its currently configured OpenAI stages.
- [ ] Set `ghHost` to `github.com`, repositories to `nublai/pi-herdr-factorio`, login to `nubl-agent[bot]`, App slug to `nubl-agent`, and email to `353429311+nubl-agent[bot]@users.noreply.github.com`. Preserve #742's read-only `historicalRepositories` map for metrics and replay. Keep exe-dev's transport and identity unchanged, with its repository override available for isolated tests. Preserve the explicit `handoff.reviewers` setting, currently `giuseppecrj`, rather than deriving a reviewer from the repository owner.
- [ ] Include `trout-dinosaur.ts.net`, `int.trout-dinosaur.ts.net`, `ts.net`, `exe.xyz`, `int.exe.xyz`, `github.com`, `githubusercontent.com`, and `ghe.com` in the new forbidden-domain contract. Keep localhost, literal IP, private, and CGNAT resolution refusals. Only the exact built-in model route may dial the pinned tailnet IP. No declared credential route may target the tailnet, GitHub, or an exe.dev integration.
- [ ] Add a closed built-in model authentication field to the network contract, with fixed credential references for OpenAI and Anthropic and `none` for edge-injected profiles. Pass no secret through the profile, route descriptor, status, or `/etc/factory/factory.env`. Keep `/etc/factory/platform.json` root-owned and limited to selection and permitted identity and repository data, not arbitrary hosts or pins.
- [ ] Change `productionDefect`, `credentialDefect`, and ceiling validation only for an exact built-in model route and its fixed credential binding. Today's code rejects credentialed POST, pinned credential routes, and credentials under forbidden domains. Preserve all three refusals for declared routes. Match the full expected upstream, credential placement, method, path, body restrictions, and meter independently in the gateway.
- [ ] Have the owner apply and test D3's per-key rate and spend caps on CLIProxyAPI before delivering a production key. Prove that a direct client using a dummy key cannot bypass those caps. If the proxy lacks an enforceable meter or cap, stop for D3 rather than treating Factorio's local counters as protection. Deliver the controller-only CLIProxyAPI key through `LoadCredential=` on the guest unit. Reuse the gateway's credential loader, strip client auth, set the fixed upstream bearer header, and keep reflection filtering and redirect refusal. Preserve the one-credential-id-per-route rule by using separate references when two model routes are mounted. Sandbox models.json retains only placeholder keys. Never copy the host's personal Pi configuration.
- [ ] Require absent or malformed credentials, an unapproved pin, a TLS mismatch, and a profile mismatch to fail before model dispatch. Keep hosted tools, arbitrary URLs, and direct network access denied. Count provider usage and uncertain charges under existing cumulative limits.
- [ ] Document owner-run proxy-key rotation. Hold and settle work, revoke a suspected key at CLIProxyAPI, install its replacement through the private credential path, restart affected units, and prove the old key refuses and the new key retains its caps. Rotate routinely on D3's recorded schedule and immediately after suspected disclosure. Do not reset local usage or replay accounting.

**You see.**

- [ ] `status --json` reports the new profile and no secret. A sandbox model call succeeds through the pinned gateway while direct tailnet and GitHub calls fail.

**Verify, unit.** Tests alone are not sufficient verification. A PR is verified only when its unit, live, and perf boxes are all checked.

- [ ] Test exact built-in credential binding, POST exceptions, forbidden-domain checks, pin tampering, missing credentials, reflection across chunks, redirects, and unchanged exe-dev output. Run `npm run check` and the trusted reporter.

**Verify, live.** Tests alone are not sufficient verification. A PR is verified only when its unit, live, and perf boxes are all checked. Ten lanes on `task:qa` at the PR head, per the boot recipe.

- [ ] Lane 1. Regression lane against trunk. Run one exe-dev sandbox request at trunk and head. Save `exe-dev-parity.json`. Pass when host, path, identity, and metering remain unchanged.
- [ ] Lane 2. Run one approved model request in the LXD guest. Save `model.json`. Pass when TLS uses the fixed name and pin and a metered reply reaches the sandbox.
- [ ] Lane 3. Remove the test credential from the unit's test instance. Save `missing-key.txt`. Pass when startup refuses before an upstream request.
- [ ] Lane 4. Submit a different route-table pin and authority to the real gateway binary. Save `pin-denied.json`. Pass when independent built-in validation rejects both.
- [ ] Lane 5. Send direct GitHub, metadata, host, and tailnet probes from bwrap. Save `direct-denied.json`. Pass when all fail while the allowed model request still works.
- [ ] Lane 6. Probe credentialed declared POST and tailnet routes with the fixture gateway. Save `declared-denied.json`. Pass when the model exception grants neither.
- [ ] Lane 7. Return a reflected dummy key and a redirect from the TLS test upstream. Save `reflection.json`. Pass when no secret bytes or redirect reach the stage or exported logs.
- [ ] Lane 8. Stop the scoped controller during a streamed model response. Save `stream-stop.json`. Pass when its gateway closes, cleanup finishes, and accounting retains spent or uncertain usage.
- [ ] Lane 9. Inspect the sandbox mounts, environment, model config, and session with a dummy key. Save `secret-absence.txt`. Pass when the key and credential directory are absent.
- [ ] Lane 10. Exercise allowed Anthropic positions if approved, plus an xAI selection and an unauthorized Anthropic position. Save `provider-policy.json`. Pass when qualified routes preserve their meter and forbidden selections refuse. Leave Anthropic proof blocked if its endpoint is unavailable.

**Verify, perf.** Tests alone are not sufficient verification. A PR is verified only when its unit, live, and perf boxes are all checked.

- [ ] Metric. Gateway per-request latency and stage-start wall time on both revisions. Measure credential loading and filtering as added work.
- [ ] Probe. Interleave three batches of 50 scripted TLS fixture requests at trunk and head on the guest. Then record one approved real completion separately. Save `perf.json` with bytes, usage, and latency.
- [ ] Baseline. Record trunk's uncredentialed fixture median first. Mark trunk's missing production-key route unsupported.
- [ ] Rule. Fail if shared request latency rises by over 2 milliseconds, credential setup exceeds 250 milliseconds, or warm stage startup exceeds 15 seconds. Require metering for the real completion and existing stage caps. Do not compare a refused trunk model request with a successful head completion.

**Review gate.** None. VM3 is not review-gated.

**Merge.**

- [ ] Root's clean verdict at the exact head SHA, including the narrow exception audit.
- [ ] Bugbot triage done.
- [ ] Rebased onto the parent or current trunk after the verdict, with the verdict still valid under the patch-id rule in `playbooks/shipping.md`.
- [ ] After VM5 supplies the runtime and every deferred VM3 lane passes, append VM3 to the verified stack. Until then report code-ready with pending guest qualification. The owner lands it after VM2.

## Mint repository-scoped nubl-agent installation tokens (VM4)

**Depends on.** VM3 and D3. D1's host-agent isolation must pass before the App private key enters the guest. Guest broker lanes, including lanes 3 and 9, wait for VM5 to create `factory` and install the stack. Local and isolated exe.dev evidence can make VM4 code-ready, not fully verified.

**Files.**

- [ ] Create `server/github-token-broker.ts`, `server/github-app-gh.ts`, and `server/factory-token-broker.service`.
- [ ] Edit `src/github/adapter.ts` and `src/trust/platform.ts` only for a proven installation-auth identity path if GraphQL viewer is unsupported.
- [ ] Create `test/github-token-broker.test.ts` and `test/github-app-gh.test.ts`. Edit `test/github-adapter.test.ts` for identity evidence.
- [ ] Create `docs/operations/github-app.md`. Edit `docs/operations/ms-a2-vm.md` for credential delivery and rotation.

**Build.**

- [ ] Prototype installation-token authentication against `nublai/factorio-vm-app-test` on its approved exe.dev test VM. The owner mints the repository-scoped token on an owner device and transfers only that token through a private channel into a temporary 0600 test credential file. The App private key never goes to exe.dev. Delete the token file and revoke the test token after the probe. Test repository reads, GraphQL viewer, timeline and comment reads, Git Data writes, dispatch, and Actions downloads. Record the returned bot type, login, and `performed_via_github_app.slug`. Do not assume installation auth supports exe.dev's viewer behavior.
- [ ] Owner-run. Generate a dedicated nubl-agent App private key for the guest broker, separately revocable from other deployments. Install it through a human-only path into `/etc/factory/credentials/github-app-key`, root-owned mode 0400. Use App id `5645247` and an owner-confirmed installation id in non-secret root-owned configuration. Do not infer the installation id from the App id. Never stage the key in a host agent-readable file, session, clipboard log, or cloud-init data.
- [ ] Run the minting broker in the root-owned `factory-token-broker.service` with `User=root` and root-owned code and configuration. Load the root-only private key only into that unit with `LoadCredential=`. Keep it out of `factory.service`, the bridge, the orchestrator, and every sandbox. Give `factory` no sudo or permission to edit or control the minting unit.
- [ ] Mint installation tokens valid for at most one hour with a signed App JWT through `api.github.com`. Reject longer expiry. Restrict tokens to approved repository IDs and the required Actions, contents, issues, and pull requests write permissions. These permissions allow branch and commit writes, issue and PR changes, and dispatch of trusted `ci.yml`, not just harmless reads. Review the actual installed permissions and branch rules. The App's all-repository installation is not a reason to mint an all-repository token. Revoking a private key is not proof that previously minted tokens stopped working. Revoke active tokens or suspend the installation for incident containment, with the owner acknowledging the wider effect.
- [ ] Expose a fixed-operation Unix socket in root-owned `/run/factory-auth`, accessible to root and `factory` through a dedicated group. This hands tokens to the controller, but Unix permissions cannot distinguish it from the same-user bridge or orchestrator. Accept no caller-selected installation, repository list, permission set, or upstream URL. Cache tokens in memory until five minutes before the returned expiry and serialize refreshes. Refuse unavailable, expired, or mismatched tokens without using owner credentials.
- [ ] Install a root-owned trusted `gh` wrapper in the controller's PATH. Obtain a token from the broker for each invocation and execute the real, absolute-path `gh` binary with a minimal environment, `GH_HOST=github.com`, and `GH_TOKEN` only for that subprocess. Use an empty private GH config directory. Never write `hosts.yml`, pass a token in argv, or retry a possibly completed mutation automatically after an auth error.
- [ ] Keep the wrapper and broker socket out of all bwrap mounts. Give the bridge and orchestrator no GitHub credential in their launch environment or configuration and no orchestration write tool. State the limit honestly. A compromise of their shared `factory` UID can obtain a controller installation token valid for at most one hour, never the root-only App key. Continued broker access can obtain fresh tokens until access is revoked. This is not OS isolation between the three trusted components.
- [ ] Retain the real `readViewer` check where GitHub supports it. If installation auth lacks viewer, implement a typed App-auth identity proof from the broker's fixed App and installation metadata plus GitHub's returned bot author on the fixture. Keep marker trust bound to `type=Bot` and the exact profile login. Never return the configured login as if GitHub had authenticated it.
- [ ] Document owner-run App-key rotation. Install a new dedicated key, restart the broker, verify a scoped token and identity, then revoke the old key. A restored guest starts without stale cached tokens. A full VM disk snapshot contains the App private key, the Tailscale node key, and any stored model or APNs keys. Restrict snapshot access to human administrators, apply retention, and encrypt every exported snapshot. File-level Factorio archives exclude credential stores and use separate encrypted secret recovery material.

**You see.**

- [ ] Controller-side `gh` reads and a fixture write act as `nubl-agent[bot]`. The owner identity `giuseppecrj` never appears as the controller actor, and a sandbox cannot reach the broker.

**Verify, unit.** Tests alone are not sufficient verification. A PR is verified only when its unit, live, and perf boxes are all checked.

- [ ] Cover JWT lifetime, fixed scope, expiry, token lifetimes over one hour, refresh coalescing, malformed responses, revoked keys, wrapper environment, no automatic write retry, and identity mismatch. Run `npm run check` and the trusted reporter.

**Verify, live.** Tests alone are not sufficient verification. A PR is verified only when its unit, live, and perf boxes are all checked. Ten lanes on `task:qa` at the PR head, per the boot recipe.

- [ ] Lane 1. Regression lane against trunk. Read the same fixture repository using exe.dev on trunk and the scoped App path on head. Save `repository-parity.json`. Pass when data agrees and each actor is recorded without claiming identity parity.
- [ ] Lane 2. Post and read one authorized fixture comment. Save `bot-author.json`. Pass when GitHub returns `type=Bot`, login `nubl-agent[bot]`, and `performed_via_github_app.slug=nubl-agent`. Marker parsing must preserve that slug and reject a different non-null App slug.
- [ ] Lane 3. Probe the key and broker with dummy credentials as `factory` and from a bwrap stage. Save `broker-boundary.txt`. Pass when `factory` can obtain only a scoped token valid for at most one hour, cannot read the App key or change the minting unit, and the sandbox cannot reach either. Record that a same-user bridge or orchestrator compromise has the same token access.
- [ ] Lane 4. Read an owner-approved repository outside the minted scope. Save `scope-denied.json`. Pass when GitHub denies it despite the App's broader installation.
- [ ] Lane 5. Exercise token refresh with a test expiry and concurrent trusted clients. Save `refresh.json`. Pass when one refresh serves them, no expired token is returned, and no token is logged.
- [ ] Lane 6. Restart the broker and test with its key unavailable. Save `broker-restart.txt`. Pass when normal restart recovers and the missing-key case fails closed without owner auth fallback.
- [ ] Lane 7. Dispatch an approved test-repository CI workflow. Save `actions.json`. Pass when dispatch, job and log reads, and artifact retrieval succeed as the App with no credential forwarded to an unrelated redirect host.
- [ ] Lane 8. Publish a fixture Git Data commit and read its author. Save `git-data.json`. Pass when the configured bot email and intended repository match.
- [ ] Lane 9. Inspect process environments and files using dummy credentials. Save `token-boundary.txt`. Pass when token delivery targets only controller-side subprocesses and no token is injected into orchestrator or bridge launches, sessions, argv, or sandbox files. Do not count that delivery check as denial of same-user token access.
- [ ] Lane 10. Supply mismatched App identity or installation metadata to a test broker. Save `identity-refused.json`. Pass when controller startup refuses before claims or model work.

**Verify, perf.** Tests alone are not sufficient verification. A PR is verified only when its unit, live, and perf boxes are all checked.

- [ ] Metric. Repository-read wall time, cached broker overhead, and first-token acquisition time at trunk and head.
- [ ] Probe. Interleave three repository reads per revision in the exe.dev test environment using owner-minted test tokens. After VM5 installs the broker, have the owner measure three cold and warm guest broker calls. Save `perf.json` with redacted metadata. Never move the App key to exe.dev for this timing.
- [ ] Baseline. Record trunk's successful repository read first. Separate integration network time from the added wrapper and broker work.
- [ ] Rule. Fail if cached local broker and wrapper overhead exceeds 100 milliseconds or first-token acquisition exceeds 10 seconds without an upstream outage. Bound a successful repository read at 30 seconds on both paths. Do not claim a speed ratio between different GitHub auth services.

**Review gate.** None. VM4 is not review-gated.

**Merge.**

- [ ] Root's clean verdict at the exact head SHA, with the independent credential audit.
- [ ] Bugbot triage done.
- [ ] Rebased onto the parent or current trunk after the verdict, with the verdict still valid under the patch-id rule in `playbooks/shipping.md`.
- [ ] After VM5 supplies the runtime and all deferred VM4 guest checks pass, append VM4 to the verified stack. The owner lands it after VM3. Report code-ready with pending qualification before then.

## Provision the controller, bridge, and restricted orchestrator as one user (VM5)

**Depends on.** VM1 and VM4. Reuse `server/install-exe-dev.sh` and `server/provision.sh` on main from #743, plus `docs/operations/install-exe-dev.md`. The installer remains exe.dev-only, not a command to run unchanged in the LXD guest. Shep's direct CLI feed reader, factory extension, and fixed launch profile are external prerequisites. #738's bot refusal and creation-time-label proof must pass before any orchestrated intake.

**Files.**

- [ ] Edit `server/provision.sh`, `server/vm/ms-a2/factory.service`, `server/cli.ts`, `server/sandbox.ts`, `server/sandbox/preflight.ts`, and `src/trust/platform.ts` for guest installation and service-user paths. Leave `server/factory.service` and the exe.dev installer's unit contract unchanged.
- [ ] Create `server/shep-factory-bridge.service`, `server/vm/ms-a2/factory-orchestrator.service`, and `server/vm/ms-a2/orchestrator-launch.sh`. Install Shep's pinned factory-chat profile through `server/provision.sh`, without authoring Shep's extension or prompt here.
- [ ] Extend main's `test/provision.test.ts` for shared-user units and fixed-profile installation. Edit preflight cases in `test/sandbox/*.cases.ts`.
- [ ] Edit `.pi/skills/verify-factory/scripts/drive-replay.sh` only to carry the guest profile environment for owner-run execution inside the guest. VM1's restricted SSH target still refuses replay execution.
- [ ] Edit `docs/operations/ms-a2-vm.md`, `docs/operations/platform.md`, `docs/operations/sandbox.md`, `docs/operations/owner-feed.md`, and `docs/operations/factory-cli.md`.

**Build.**

- [ ] Retain main's `platform --env`, validated atomic `/etc/factory/factory.env`, `EnvironmentFile=`, linger setup, and runtime-directory preflight. Adapt the remaining `exedev` and `/run/user/1000` assumptions for the guest. Keep `nublai/pi-herdr-factorio` in the new unit. Do not re-port the merged provisioning patch.
- [ ] Reuse the installer's exact-SHA checkout verification, hold-before-change ordering, failure stop and disable behavior, and fresh held-readiness checks in the guest installation runbook. Keep `server/install-exe-dev.sh` and its exe.dev preflight unchanged. It requires `exedev`, uid 1000, broad sudo, and exe.dev integrations, none of which authorize a guest runtime shortcut.
- [ ] Create the locked guest service account `factory` here, not in VM2 cloud-init. Use it for the controller, Shep bridge, and restricted pi orchestrator, with no sudo, Docker, or LXD groups. Keep VM4's minting unit as root, not another application account. Derive the runtime UID with `id -u factory`. Keep the controller checkout root-owned, runtime dependencies pinned, and state owned by `factory` with 0700 directories and 0600 private files.
- [ ] Separate owner-run privileged installation from runtime. Adapt provisioning so a human admin installs root-owned assets, unit files, credentials, and sysctls without granting permanent sudo to `factory`. Retain an idempotent exe.dev path. Run no real model call from provisioning.
- [ ] Render and install `server/vm/ms-a2/factory.service` as the guest's system `factory.service`, with `User=factory`, profile environment, watchdog, `NoNewPrivileges`, and the trusted gh wrapper. Keep the exe.dev unit byte-identical. Enable linger for `factory` and start its user manager. Set `XDG_RUNTIME_DIR` from the actual UID and prove `systemd-run --user --scope` works from the system unit without a login shell.
- [ ] Keep bwrap `--unshare-all`, seccomp, private netns, and gateway socket transport. Enable initial unprivileged userns inside the guest only if its preflight requires it. Do not copy the host sysctl setting as proof or disable AppArmor globally on ms-a2. A guest-specific AppArmor or userns change needs the guest-change grant and its denial probes. Keep further nested user and mount namespaces inside the stage denied by seccomp.
- [ ] Keep `MemoryMax=2G`, `TasksMax=512`, and `CPUQuota=100%` per stage and `max_concurrent: 2`. Do not place an aggregate service limit that ignores scopes in the user manager or starves them. Prove cleanup covers those separate cgroups.
- [ ] Have the bridge run `node server/cli.ts owner-feed --json --state-dir "$STATE" --repo nublai/pi-herdr-factorio` directly as `factory`. Keep the state private. Add no sudoers rule, feed exporter, export timer, or intermediate feed file. Preserve the complete feed, its gaps, and its timestamp. An unavailable read can exit 0 with `gaps=[state_unavailable]`. Treat it as unavailable, never as an empty queue or a fresh notification seed.
- [ ] Follow `owner-feed.md`'s proposed read rate, at most once every five seconds while the app is open and once every 60 seconds in the background. Keep one read in flight. Agree stale-read handling with Shep before implementation rather than treating a cached feed as fresh.
- [ ] Run the pinned Shep bridge as `User=factory` in `shep-factory-bridge.service`. Deliver its APNs signing material only to that unit through `LoadCredential=`. Do not claim that delivery isolates it from a compromised same-user process. Bind its private backend to loopback and expose only the approved authenticated bridge endpoint through guest Tailscale. Do not expose the viewer or its hold form to the phone.
- [ ] Launch the orchestrator as `factory` from the pinned root-owned wrapper with `PI_CODING_AGENT_DIR=/etc/factory/pi-orchestrator`. Keep that directory, its settings, and its model configuration root-owned and not writable by `factory`. Use a root-owned working directory with project discovery refused. Store sessions separately under `/var/lib/factory-orchestrator/sessions`, private to `factory`.
- [ ] Use this Pi argv in the pinned Herdr pane launcher, with paths and variables resolved by the root-owned profile. `pi --no-builtin-tools --tools "$FACTORY_TOOLS" --no-extensions -e "$FACTORY_EXTENSION" --no-mcp --no-skills --no-context-files --no-prompt-templates --no-themes --no-approve --system-prompt "$FACTORY_PROMPT" --model "$MODEL" --thinking "$THINKING" --session-dir /var/lib/factory-orchestrator/sessions`. Require an exact nonempty list of factory extension tool names, with no wildcard or additive selection. Do not combine `--no-tools` with `--tools`. The explicit allowlist selects extension tools, while `--no-builtin-tools` and `--no-mcp` remove other tool sources. `--no-extensions` disables `builtin:codemode` too, and no explicit extension may re-enable it. Pin the Pi version and verify the resulting registered tools rather than relying on flag order.
- [ ] Require Shep's approved extension to intercept `user_bash` and return a refusal without executing anything. The bridge must not turn phone text into `!`, `!!`, slash commands, file expansion, or process arguments. Test both shell prefixes through the real bridge input path. Missing enforcement blocks the orchestrator, not just its shell tool.
- [ ] Supervise the Herdr pane and its Pi process with `factory-orchestrator.service`, `User=factory`, `Restart=on-failure`, `RestartSec=30`, and at most three starts in five minutes. The root-owned launcher stays in the foreground, owns one pane, waits for Pi to exit, and stops the pane on service stop. Reconcile the old pane before restarting so two orchestrators cannot run. Do not use an unsupervised detached pane. Have the Shep owner supply and pin the supported Herdr launch and wait commands before implementation.
- [ ] Deliver the orchestrator's separate CLIProxyAPI key through its unit's `LoadCredential=`, never argv or a personal Pi directory. The pinned launcher reads that file into the provider environment referenced by the root-owned model configuration, without logging the value. Pin D3's model and thinking level. Require Shep's launch profile to persist per-turn and daily token accounting across session and unit restarts, and stop before another request at the approved cap. Report this usage separately from Factorio stage and replay totals. Enforce rate and spend caps at CLIProxyAPI for this key too. If that accounting contract is absent, leave the orchestrator disabled.
- [ ] Give the orchestrator no GitHub write credential. Its extension builds a prefilled `https://github.com/nublai/pi-herdr-factorio/issues/new?labels=factory:ready&title=…&body=…` link. Giuseppe submits it under his own GitHub login. Install no founder token or bridge-signed approval broker. Require #738's `bot_actor` refusal and creation-time-label lane before enabling this intake. Coordinate #739's `intakeRef`, `repositories`, and per-state-directory multi-repo reads separately. Leave #740's `questionsUrl` for v1.1.
- [ ] State the shared-user residual in the runbook. The tool restriction is the only boundary between the orchestrator and the controller's state, including held-out acceptance tests. Private modes do not separate processes with the same UID. Keep build and repair stages isolated by bwrap, and do not describe the orchestrator as another isolated stage.
- [ ] Obtain Shep's supported direct CLI feed reader, factory extension, fixed launch profile, bridge command, authenticated port, pairing procedure, and direct APNs sender from its owner. Record the pinned revision. If these are absent, stop the affected boxes and relay the missing contract rather than writing Shep code here. The phone talks only to the bridge, and the bridge sends pushes directly to Apple, with no exmach `apns.int` dependency.

**You see.**

- [ ] After reboot, the controller is `controller_ready` but held, its user manager can launch a scope, and the bridge reads the private state directly. The fixed-profile pi session runs as the same user with only factory extension tools and no injected GitHub credential.

**Verify, unit.** Tests alone are not sufficient verification. A PR is verified only when its unit, live, and perf boxes are all checked.

- [ ] Test parity with main's generated environment, UID-derived runtime paths, missing user manager, shared-user units, fixed-profile installation, unavailable feed reads, and mode preservation. Retain `test/install-exe-dev.test.ts` as installer regression coverage. Run `npm run check`, the trusted reporter, `bash -n server/provision.sh`, and `systemd-analyze verify` against installed test units.

**Verify, live.** Tests alone are not sufficient verification. A PR is verified only when its unit, live, and perf boxes are all checked. Ten lanes on `task:qa` at the PR head, per the boot recipe.

- [ ] Lane 1. Regression lane against trunk. Run the pinned installer on disposable exe.dev test VMs with trunk and head. Save `provision-parity.txt`. Pass when routes, identity, generated environment, linger, held readiness, and idempotent reruns retain main's behavior. Guest-only adaptations must not change that path.
- [ ] Lane 2. Owner-run. Install the pinned stack in disposable guest state held, then complete VM3 and VM4's deferred guest checks. Save `provision-guest.txt`. Pass when preflight and `controller_ready` succeed with the hold intact and VM2's verification account still cannot read the now-installed state, broker, or credential directories.
- [ ] Lane 3. Repeat provisioning. Save `idempotence.txt`. Pass when unit, env, bundle digest, modes, and service identity do not drift.
- [ ] Lane 4. Owner-run. Reboot with no service-user login. Save `linger.txt`. Pass when the runtime directory and user bus exist and a limited scope launches from the system unit.
- [ ] Lane 5. Owner-run. After the permanent guest firewall is applied and temporary install allowances are removed, run two scoped sandbox fixtures and a real visible-test `npm ci --ignore-scripts --no-audit --no-fund` with an empty npm cache. Save `scope-limits.json`. Pass when dependencies install through the audited `npm` gateway route to `registry.npmjs.org`, direct sandbox egress still fails, original scope limits hold, and neither workspace exposes the other's files or held-out suite. Complete this before D6.
- [ ] Lane 6. Stop a scoped controller and restart it. Save `scope-cleanup.json`. Pass when its gateways close, owned scopes reconcile, and unrelated scopes remain untouched.
- [ ] Lane 7. Owner-run. Read fixture state through the bridge as `factory` and inspect the orchestrator's actual argv, environment names, registered tools, and root-owned profile. Save `shared-user.txt`. Pass when the feed matches, all three use the same UID, only named factory tools register, and MCP, codemode, discovery, and `!` and `!!` execution are disabled. Kill the test Pi process once and prove its supervisor restores exactly one pane without resetting its budget. Confirm no sudoers rule or feed exporter exists. Record readability of a dummy held-out canary as the shared-user residual, not isolation.
- [ ] Lane 8. Give the bridge unavailable test state and interrupt a CLI feed read. Save `feed-gap.json`. Pass when it shows unavailable, preserves the last available notification state, and sends no false alert or empty queue.
- [ ] Lane 9. Owner-run. Inspect credential delivery and same-user access with dummy secrets and disposable state. Save `credential-delivery.txt`. Pass when only the root minting unit can read the App key, intended units receive their keys, and no GitHub token is injected into bridge or orchestrator launches. Demonstrate that arbitrary code as `factory` can read model and APNs keys, obtain a broker token, remove the dummy hold, and edit dummy accounting and replay budgets. Record those as exposures. Prove proxy-side caps and revocation still stop direct dummy-key use, and the verification SSH account can do none of these things.
- [ ] Lane 10. Reach the bridge through the approved tailnet route and probe the viewer remotely. Save `bridge-reach.txt`. Pass when bridge authentication is required and no viewer, hold endpoint, broker socket, or direct controller endpoint is exposed.

**Verify, perf.** Tests alone are not sufficient verification. A PR is verified only when its unit, live, and perf boxes are all checked.

- [ ] Metric. Held controller start-to-ready, provisioning rerun time, feed computation, direct bridge-read time, and guest memory at trunk and head.
- [ ] Probe. Interleave three runs per revision in disposable guest state with the same runtime user. Measure ten direct bridge CLI reads at five-second intervals separately. Save `perf.json`.
- [ ] Baseline. Record trunk's compatible held-start and feed timings first. Record unsupported user configuration separately rather than timing a failure as ready.
- [ ] Rule. Fail if head adds over 200 milliseconds to comparable startup, ready takes over 60 seconds, or provisioning rerun exceeds 120 seconds. Require feed work under 500 milliseconds excluding CLI startup, a complete bridge CLI read under 2 seconds, and no overlapping feed read or model call from that read.

**Review gate.** None. VM5 is not review-gated.

**Merge.**

- [ ] Root's clean verdict at the exact head SHA, including guest-user and feed access proof.
- [ ] Bugbot triage done.
- [ ] Rebased onto the parent or current trunk after the verdict, with the verdict still valid under the patch-id rule in `playbooks/shipping.md`.
- [ ] Append VM5 to the verified stack. The owner lands it after VM4. Report any remaining Shep prerequisite as blocked, not a passed bridge lane.

## Reuse MV4a for the later nubl-factory drain (VM6)

**Depends on.** VM1 for isolated verification targets. This PR proves the diagnostic and drain procedure on isolated exe.dev fixtures. VM7 executes a fresh production drain on `nubl-factory` after VM5 and D6. The earlier #712 drain is not evidence for this later move.

**Files.**

- [ ] Reuse MV4a's `server/cli.ts`, `src/orchestrator.ts`, `test/dashboard.test.ts`, `test/helpers.ts`, `test/markers.test.ts`, `test/orchestrator.test.ts`, and `test/platform.test.ts` from `origin/mv4-drain-foreign-markers`.
- [ ] Reuse `docs/operations/drain.md`, `docs/operations/factory-cli.md`, and `docs/operations/metrics.md` from that branch. Set the source to `nubl-factory`, the destination to the approved LXD guest, and active commands to `nublai/pi-herdr-factorio`. Preserve main's repository-history changes when porting. Append evidence rows to `docs/decisions.tsv` through `log.sh`.

**Build.**

- [ ] Port MV4a's `foreignMarkers` diagnostic and drain runbook, not an alternative drain implementation. Keep its zero-extra-GitHub-read design, `complete` versus `incomplete` result, and exclusion of closed or unlabeled history.
- [ ] Write the production drain procedure for VM7. Require the landed MV4a-equivalent controller held on `nubl-factory` using the `exe-dev` profile and `exe-dev-github-integration[bot]`. First require a fresh integration read of `nublai/pi-herdr-factorio`. A 403 blocks drain proof even when old status says zero runs.
- [ ] Retain every MV4a drain step in that procedure. Require settled live scopes, ended or released runs under the authorized issue actions, and cleared old `factory:ready` events. Retain markers and accounting. Permit only owner-named issues with zero old markers as new intake.
- [ ] Require a fresh tick with active, runs, queued, unverified, nonterminal accounting, corrupt, and foreign-marker counts all zero, `foreignMarkers.kind=complete`, and `ledger.state=empty`. Save the ready-issue inventory in the same window. Unknown and null are not zero.
- [ ] Inventory `nubl-factory`'s repository slugs, immutable run IDs, admission references, workspace paths, and ledger anchors, including any retained history from #734. Preserve #742's read-only history alias for metrics and replay. Never use the former repository name for admission, claims, marker trust, dispatch, or publication. Do not replace strings in private records or recompute IDs. Prove history reads before transfer. If compatibility requires a state migration, stop for a separately scoped design rather than resetting state.
- [ ] Rehearse the full stopped-state backup per `backup.md` on fixture state, including a separate replay-budget file, and record checksums. Verify `nubl-factory`'s state and replay paths against its installation and #734 receipts. Record `/home/exedev/factory-state` and `/home/exedev/factory-verification/replay-budget.json` if those paths remain in use. Carry the source's current accounting, not an older retirement archive. A hold alone does not stop bookkeeping. Require the source service stopped before the final copy under D6, with `disabled` present.
- [ ] Record the fixture rehearsal evidence separately from a production drain. Require VM7 to append the actual drain row with its grant, source SHA, inventory, counts, archive paths, and replay checksum before the CI switch lands. Do not delete the source VM or its backups.

**You see.**

- [ ] Fresh MV4a status and the fixture issue inventory prove a complete rehearsal drain, not just zero slot usage. Production drain remains a VM7 prerequisite.

**Verify, unit.** Tests alone are not sufficient verification. A PR is verified only when its unit, live, and perf boxes are all checked.

- [ ] Reuse MV4a's tests for foreign-marker incompleteness, zero extra reads, restored terminal claims, and refusal of a different bot. Run `npm run check` and the trusted reporter.

**Verify, live.** Tests alone are not sufficient verification. A PR is verified only when its unit, live, and perf boxes are all checked. Ten lanes on `task:qa` at the PR head, per the boot recipe.

- [ ] Lane 1. Regression lane against trunk. Read the same isolated state at trunk and head. Save `status-parity.json`. Pass when head adds the diagnostic without changing the original fields.
- [ ] Lane 2. Run a diagnostic read with the integration unavailable. Save `unknown.json`. Pass when foreign markers remain incomplete, never zero by default.
- [ ] Lane 3. Read an old-bot active marker under the existing `exmach` test profile in isolated state. Save `foreign-active.json`. Pass when it never authenticates as `nubl-agent[bot]`. This identity test uses no exmach network and needs neither VM3's `ms-a2-vm` profile nor a live exmach VM.
- [ ] Lane 4. Read a closed issue's old terminal marker. Save `old-history.json`. Pass when it stays history and does not reopen or enter the live foreign count.
- [ ] Lane 5. Inspect a restored nonterminal local claim without starting it. Save `restore-blocked.json`. Pass when the cutover precheck blocks it despite a profile identity change.
- [ ] Lane 6. Reconcile a released fixture under the exe-dev identity. Save `release.json`. Pass when its terminal record and usage survive and its ready label is absent.
- [ ] Lane 7. Run the final inventory on the isolated fixture repository. Save `ready-inventory.json`. Pass when only the explicitly retained zero-marker fixture intake remains.
- [ ] Lane 8. Read the fixture controller's fresh final drain tick. Save `drain-zero.json`. Pass when every MV4a zero predicate and `ledger.state=empty` hold.
- [ ] Lane 9. Inspect the stopped fixture controller and scopes before backup. Save `stopped.txt`. Pass when no fixture controller, model process, or owned stage scope remains.
- [ ] Lane 10. Verify fixture state and replay-budget archive checksums and retained history reads. Save `backup-manifest.json`. Pass when all files are accounted for, identities are preserved, and no credential is exported in evidence.

**Verify, perf.** Tests alone are not sufficient verification. A PR is verified only when its unit, live, and perf boxes are all checked.

- [ ] Metric. Status wall time and GitHub request count per tick at trunk and head.
- [ ] Probe. Interleave three read-only status samples and three isolated same-fixture ticks per revision on exe.dev, under the fixture grant. Save `perf.json`.
- [ ] Baseline. Record trunk's median and request count first, after a fresh repository read succeeds.
- [ ] Rule. Fail if head adds any GitHub request for foreign-marker counting or increases median status time by more than 20 percent or 2 seconds absolute. Require zero model calls while held.

**Review gate.** None. VM6 is not review-gated.

**Merge.**

- [ ] Root's clean verdict at the exact head SHA of the MV4a-equivalent code and its fixture rehearsal.
- [ ] Bugbot triage done.
- [ ] Rebased onto current trunk after the verdict, with the verdict still valid under the patch-id rule in `playbooks/shipping.md`.
- [ ] Append VM6 to the verified stack. The owner lands its verified diagnostic code and runbook before VM7 performs the production drain.

## Switch production CI to the App after the drain (VM7)

**Depends on.** VM5 and VM6 for code and test preparation. Before the production drain, require D5, the reviewed stacked VM8 runbook, successful fixture transfer and restore, and an owner-ready rollback PR procedure. Its first production step records the drain and backup under D6. Reuse `origin/mv4b-ci-bot` at `da9543c` unless the owner identifies a newer reviewed tip.

**Files.**

- [ ] Edit `.github/workflows/check.yml`, `.github/workflows/ci.yml`, and `test/validation.test.ts`, reusing MV4b's patch.
- [ ] Edit `docs/operations/drain.md` for the new profile in reporter proof, and append the switch evidence to `docs/decisions.tsv` through `log.sh`.

**Build.**

- [ ] Prepare and review VM7 and stacked VM8 before stopping production. Complete test-repository CI, fixture transfer, restore, off-host recovery, and rollback rehearsal first. Obtain D5 and D6 with the owner available to land the CI switch or its rollback promptly.
- [ ] Owner-run under D6. Execute the landed VM6 drain runbook on `nubl-factory`. Deploy its diagnostic held, prove fresh zero predicates and the ready-issue inventory, and verify retained history. Stop the source and its scopes, disable its restart and boot path, and take the complete state and replay backup. Start the 60-minute proposed cutover timer at source stop. Append the drain row through `log.sh`. Keep the source stopped and held. A failed predicate blocks the CI switch.
- [ ] Do not rerun `server/install-exe-dev.sh` on `nubl-factory` after the drain. Its success path calls `systemctl restart` and `systemctl enable factory.service`, which would restore the old writer. Use only the explicit owner-run rollback below.
- [ ] Under the renewed workflow-edit grant, switch the two expected actors to `nubl-agent[bot]`. Port the reporter test coupling from MV4b, using the new profile rather than an exmach selection. Do not change required checks, exact-head bindings, artifact validation, or the secret-free candidate job.
- [ ] Keep `nubl-factory` stopped and held through the change from `exe-dev-github-integration[bot]` to `nubl-agent[bot]`. Explain that CI changes only when the owner merges workflow files on GitHub, not when a VM checks out a branch. Never enable both old and new actors as a migration shortcut.
- [ ] Prove reporter behavior locally and on the approved test repository before merge. Ask the owner to land this as the explicit main-owned CI bootstrap only if production-main dispatch cannot be proved before landing. Keep that native lane pending and production held until it passes after merge.
- [ ] Record the production reporter's nubl-agent identity proof after the owner's merge. Keep exe.dev's old-bot full-pipeline tests in their dedicated trusted test repository from VM1. Do not weaken production's actor check to preserve a test shortcut.

**You see.**

- [ ] The reporter accepts only a correctly bound nubl-agent dispatch. The old integration bot and a human actor fail its identity check.

**Verify, unit.** Tests alone are not sufficient verification. A PR is verified only when its unit, live, and perf boxes are all checked.

- [ ] Run the reused reporter tests for valid actor, wrong actor, wrong head, wrong run, and malformed receipt with `npm run check` and the trusted reporter. Preserve every prior assertion.

**Verify, live.** Tests alone are not sufficient verification. A PR is verified only when its unit, live, and perf boxes are all checked. Ten lanes on `task:qa` at the PR head, per the boot recipe.

- [ ] Lane 1. Regression lane against trunk. Replay identical reporter inputs at trunk and head in the isolated workflow test environment. Save `actor-matrix.json`. Pass when only the intended bot identity changes and all binding failures remain failures.
- [ ] Lane 2. Dispatch a valid nubl-agent run in `nublai/factorio-vm-app-test`. Save `app-ci.json`. Pass when its main-owned nubl-agent reporter publishes the check at the candidate SHA.
- [ ] Lane 3. Dispatch the same fixture through the old integration attached to `nublai/factorio-vm-app-test` under its separate test grant. Save `old-actor.json`. Pass when that repository's nubl-agent reporter refuses the old actor. Do not change the exe-dev regression repository's accepted actor.
- [ ] Lane 4. Exercise a human-authored trigger in the isolated test workflow. Save `human-actor.json`. Pass when it cannot impersonate the controller.
- [ ] Lane 5. Submit a receipt for a different candidate head through the test workflow. Save `wrong-head.json`. Pass when no success check attaches to the intended head.
- [ ] Lane 6. Read the hosted candidate-job permissions and logs. Save `candidate-permissions.json`. Pass when candidate execution has no checks-write token or App key.
- [ ] Lane 7. Read the source stop and drain evidence immediately before the owner lands VM7. Save `source-still-stopped.txt`. Pass when no old-bot run can dispatch.
- [ ] Lane 8. After the owner's merge, run one production-main native reporter probe under its fixture grant on candidate branch `verify/vm7-reporter-<receipt-id>` and issue `[VM7-w8-reporter]`. Save `main-reporter.json`. Pass when the merged workflow binds the exact candidate SHA, actor, run, and check. Under the cleanup grant, remove fixture labels, close and confirm the issue, and delete only that recorded branch at its expected SHA. Require cleanup before VM8's production transfer. Before merge this lane is pending bootstrap proof.
- [ ] Lane 9. Run the exe-dev fixture in `nublai/factorio-vm-exe-test`. Save `exe-dev-test-ci.json`. Pass when its own exe-dev main-owned reporter works without changing production's identity rule.
- [ ] Lane 10. Read effective production branch rules and all bypass actors without modifying them. Save `rules.json`. Pass when `nubl-agent[bot]` has no direct-push or review bypass on `main` and required exact-head checks and human approval apply to it. Test attempted main push and unapproved merge denial on the isolated App repository with matching rules. Never attempt a production main push as a negative control. An unprovable production rule leaves this lane blocked.

**Verify, perf.** Tests alone are not sufficient verification. A PR is verified only when its unit, live, and perf boxes are all checked.

- [ ] Metric. Reporter execution wall time and dispatch-to-terminal-receipt time at trunk and head.
- [ ] Probe. Interleave three matched test-repository workflow runs per revision. Save `perf.json`, separating queue delay from execution.
- [ ] Baseline. Record trunk's completed trusted-reporter run first using its accepted actor.
- [ ] Rule. Fail if reporter execution rises by more than 10 percent plus 1 second, or dispatch-to-terminal exceeds the existing 20-minute bound. Report a queue outage as blocked, not as a successful sample.

**Review gate.** None. VM7 is not review-gated.

**Merge.**

- [ ] Root's exact-head verdict on all pre-merge checks, with native production-main proof explicitly pending if required.
- [ ] Bugbot triage done.
- [ ] Rebased onto current trunk after the verdict, with the verdict still valid under the patch-id rule in `playbooks/shipping.md`.
- [ ] Hand VM7 to the owner for the approved CI bootstrap landing after the drain, with VM8 already prepared and rehearsed. Complete lane 8 and its cleanup before VM8's production transfer. Do not report a full pass until that receipt exists. At D6's rollback decision time, apply VM8's rollback procedure rather than waiting through another PR cycle.

## Restore nubl-factory state in the guest and prove off-host recovery (VM8)

**Depends on.** Prepare this PR stacked on VM7 and complete D5 plus fixture rehearsal before D6. Production transfer requires VM1 through VM7 landed, VM7's main-backed proof and fixture cleanup complete, and D6 granted. Reuse unchanged rehearsal evidence and run only production-specific checks during the cutover window. Real dispatch remains a separate D7 decision.

**Files.**

- [ ] Edit `docs/operations/ms-a2-vm.md`, `docs/operations/backup.md`, `README.md`, and `AGENTS.md` only for the new production home, retained test target, backup, and cutover procedure.
- [ ] Append `docs/decisions.tsv` rows through `log.sh`. Fill the approved guest entry in `.pi/skills/verify-factory/targets.env` without secrets.

**Build.**

- [ ] Approve a backup policy under D5. Propose seven daily stopped-state LXD snapshots and four weekly snapshots within the pool's measured space budget. Propose daily encrypted off-host Factorio archives with 30 daily and 12 weekly copies, a 24-hour recovery-point target, and a two-hour restore target. Record the chosen destination and encryption-key custody before copying data. These are proposed operational targets, not measured guarantees.
- [ ] Treat LXD snapshots as local rollback aids, never as the only backup. Follow `backup.md` with the controller, viewer, restricted pi orchestrator, and bridge stopped after stage scopes settle. Include full state, all accounting, claims, ledger outbox and anchors, retained sessions, source checkout and Git metadata, external workspace roots, exact bundles, units, and non-secret configuration. Include cadence and measurement state and the replay-budget file outside the state root.
- [ ] Owner-run. Transfer the stopped `nubl-factory` archives over owner-device SSH as `exedev@nubl-factory.exe.xyz`, encrypting the stream to D5's recovery recipient before staging it in the owner device's private directory. Upload only encrypted bytes over the human admin SSH path to the guest staging directory. Do not use `factory-verify`, a host agent home, or an agent-forwarded session. Record paths, byte counts, hashes, and custody without keys. Rehearse this exact route before D6.
- [ ] Copy encrypted archives to D5's off-host destination, not merely another ms-a2 guest or directory. Verify hashes after each transfer. Keep secret recovery material in separately controlled encrypted storage and re-enroll Tailscale as needed. Full LXD snapshots contain the App and Tailscale keys even when file-level Factorio archives exclude them. Never clone a live tailnet identity or start two restored controllers.
- [ ] Owner-run. Confirm `nubl-factory` remains stopped, held, and disabled using VM7's fresh drain receipt. Record that no manual controller or user scope remains before the target starts. Leave its disks and backups intact for recovery, not active fallback. Do not rerun `install-exe-dev.sh` there, because it restarts and enables the service. This step retires no VM.
- [ ] Restore into a private staging directory on the guest, preserving checksums and modes. Map the old service UID explicitly to `factory` without following symlinks. Preserve logical run IDs and repository history. Do not hand-edit claims, accounting, paths embedded in captured execution, or the replay budget to force startup.
- [ ] Compare restored terminal claims, usage floors, caps, ledger backlog, and owner feed with the stopped source. Require both MV4a pre-start lists of nonterminal claims and nonterminal accounting to be empty. Resolve old absolute workspace paths by a documented compatible layout where needed, not by discarding evidence. A needed schema or repository-identity migration is a blocker for a separate scoped change.
- [ ] Carry `nubl-factory`'s replay-budget file from the path verified in VM6 intact to the approved guest replay path and record its checksum and configured location. Keep spent, reserved, uncertain, and `policyChanges` entries. The authorized 4,000,000 cap is applied only through the existing audited reservation path. If future replays run on exe.dev, transfer sole ownership of this file while all replay writers are stopped. Never let two copies independently grant the remaining budget.
- [ ] Start only the new controller, held, with `FACTORY_PLATFORM=ms-a2-vm` and the landed VM7 CI contract. Verify fresh `controller_ready`, `foreignMarkers.kind=complete`, zero live foreign markers, preserved accounting, and no model dispatch. Start the bridge separately for direct feed reads. Keep orchestrated intake disabled until #738's prerequisites pass. Have the owner enable LXD guest autostart only after the old restart path is disabled.
- [ ] Owner-run before D6. Rehearse an off-host fixture archive restore in an isolated guest with network dispatch disabled and no production token. Compare checksums, modes, claims, and feed through the real CLI. After the final transfer, verify the production archive's manifest and hashes against that proven procedure. Keep its full isolated restore outside the cutover downtime window. Never connect a snapshot clone to production GitHub just to test restoration.
- [ ] Record the held cutover time against D6's target. At 30 minutes without a usable held destination, the owner chooses rollback or explicitly records an extension before the 60-minute target expires. Missing evidence is not a reason to enable dispatch.
- [ ] Owner-only rollback before any new production run write. Stop and disable the guest controller, bridge, and orchestrator. Settle scopes and revoke guest token access. Reconcile and retain VM7's native reporter probe and cleanup receipts. Have the owner author and land a human PR reverting VM7's two workflow actor lines and coupled reporter test. Require green CI and confirm main again accepts the exe-dev actor. Check the source's retained state and replay checksums against the stopped archive, and prove no target run or new accounting exists. Only then may the owner enable and start `nubl-factory` held, verify fresh status, and lift its hold under an explicit dispatch decision. Do not rerun the installer.
- [ ] After a new production run, marker, publication, or accounting write on the guest, recover forward from its newest state instead. The narrowly scoped VM7 reporter probe is not such a run, but its known branch, issue, and check effects must be reconciled before rollback. Any unexplained write blocks source restart. Never restore an old snapshot to reset charges.

**You see.**

- [ ] Exactly one production controller runs, in the LXD guest, and it is held. The source cannot restart automatically. An off-host restore reproduces private state and budget without dispatch.

**Verify, unit.** Tests alone are not sufficient verification. A PR is verified only when its unit, live, and perf boxes are all checked.

- [ ] Run `npm run check` on the exact deployed source and validate every command in the runbook against its actual paths. Run the plan checker. Keep a restored archive private and out of repository test fixtures.

**Verify, live.** Tests alone are not sufficient verification. A PR is verified only when its unit, live, and perf boxes are all checked. Ten lanes on `task:qa` at the PR head, per the boot recipe.

- [ ] Lane 1. Regression lane against trunk. Read stopped source state and the restored held state with their recorded revisions. Save `state-parity.json`. Pass when run IDs, terminal states, caps, and usage match, with only intended platform and liveness differences.
- [ ] Lane 2. Inspect the source service and all controller processes. Save `single-controller.txt`. Pass when the source is stopped, held, and disabled for boot and no second writer exists.
- [ ] Lane 3. Compare restore manifests. Save `restore-manifest.json`. Pass when relative paths, file bytes, and private modes match with only the documented UID mapping.
- [ ] Lane 4. Read restored claims and accounting before startup. Save `terminal-only.json`. Pass when both nonterminal lists are empty and no record was removed.
- [ ] Lane 5. Start the new controller held and observe two ticks. Save `held-start.json`. Pass when recovery settles, foreign markers are complete and zero, and no stage or model call starts.
- [ ] Lane 6. Compare replay-budget bytes and the configured active path. Save `replay-transfer.json`. Pass when checksums match and only one authorized replay writer can use the retained accounting.
- [ ] Lane 7. Inspect bot identity, profile digest, bundle manifest, and CI main SHA. Save `runtime-pins.json`. Pass when they match VM3 through VM7 receipts.
- [ ] Lane 8. Owner-run. Take a stopped-state LXD snapshot and inspect its metadata. Save `snapshot-policy.json`. Pass when it is consistent, restricted to human administrators, within retention and space limits, and every exported snapshot is encrypted. Record that it contains App and Tailscale keys without exposing them.
- [ ] Lane 9. Owner-run. Restore an encrypted off-host fixture archive before D6, then the final production archive in an isolated guest after the cutover. Keep dispatch credentials absent. Save `off-host-restore.json`. Pass when both CLI reads reproduce state and feed without an external write. The production restore is outside the downtime target and remains pending until run.
- [ ] Lane 10. Owner-run. Reboot production while held under D6. Save `held-reboot.json`. Pass when only the guest resumes, the hold persists, and accounting and feed remain readable.

**Verify, perf.** Tests alone are not sufficient verification. A PR is verified only when its unit, live, and perf boxes are all checked.

- [ ] Metric. Qualify status and feed wall time, archive bytes, backup time, and restore-to-held-ready time at one pinned runtime SHA. Report cutover downtime separately. This docs PR changes no code to benchmark against trunk.
- [ ] Probe. Owner-run. Take three offline status and feed samples on a fixed copied-state fixture. Time its encrypted transfer and isolated restore before D6. Save `perf.json`, then append final production archive size, transfer time, and cutover timestamps. Never run simultaneous production controllers for a measurement.
- [ ] Baseline. Record source operational samples and the first guest fixture sample as reference, with state size and hardware named. No trunk/head code-regression ratio applies.
- [ ] Rule. Require feed work under 500 milliseconds excluding CLI startup and D5's recovery and freshness targets. Under the proposed policy, fail a restore over two hours or an off-host copy older than 24 hours. Fail a D6 cutover over its approved 60-minute target unless the owner recorded a change in advance. Report waiting for later dispatch approval separately.

**Review gate.** None. VM8 is not review-gated.

**Merge.**

- [ ] Root's clean verdict at the exact head SHA of the runbook and evidence changes.
- [ ] Bugbot triage done.
- [ ] Rebased onto current trunk after the verdict, with the verdict still valid under the patch-id rule in `playbooks/shipping.md`.
- [ ] Append VM8 to the verified stack. The owner lands it. State explicitly that production is migrated but real dispatch is still held.

## Prove the Shep phone path and qualify dispatch (VM9)

**Depends on.** VM8 and Shep's pinned bridge, direct APNs sender, direct CLI feed reader, fixed orchestrator launch profile, factory extension, and Factory tab. #738's `bot_actor` refusal and live creation-time-label proof gate any orchestrated intake. D7 separately authorizes fixture dispatch and model spend.

**Files.**

- [ ] Edit `docs/operations/ms-a2-vm.md` and append `docs/decisions.tsv` rows through `log.sh`.
- [ ] Create redacted review media under `docs/plans/media/VM9/`. Make no Shep or exmach source change here.

**Build.**

- [ ] Pair the owner's phone only with the guest's Shep bridge under the pairing grant. Confirm Factory tab counts match OwnerFeed read directly from the controller's state. Keep GitHub links as the only phone actions. Do not add a direct controller API or remote hold endpoint.
- [ ] Prove first-read seeding, unavailable-feed handling, duplicate-key attention handling, needs-you and failed alerts, UTF-8 byte limits, collapse by repository and issue, and suppression while viewing the run. Follow `owner-feed.md` without fixing its known duplicate-entry defect in this program.
- [ ] Verify that the bridge sends APNs directly to Apple using its own credential, not via exmach or the controller. Record Shep's actual push rate and retry policy rather than importing exmach's old 30-per-hour quota.
- [ ] Before any orchestrated intake, inspect #738's deployed `bot_actor` refusal and live exe.dev creation-time-label receipt. Require the controller's bot under each built-in profile and another bot to be refused without repeated permission reads. Require a human-created fixture from the prefilled link to bind to its creation-time label actor without `ambiguous_snapshot`. Missing proof blocks intake, and a snapshot failure needs the owner's decision rather than a weakened check.
- [ ] Under a bounded D7 grant, have the restricted orchestrator draft one approved fixture link and Giuseppe submit it under his own GitHub login. Run that fresh readiness event to a ready PR with nubl-agent markers and exact-head CI. Reserve the full allowed stages first. Keep the old source stopped. Remove the temporary dispatch permission and restore the hold after the fixture unless the owner explicitly approves ongoing real dispatch.
- [ ] Before enabling ongoing dispatch, hand the owner the fixture, recovery evidence, observed model identities, token totals, and known limitations. Leave F12d, F12e, F13, the exmach move, and broader model-policy changes outside this cutover. Continue their tests on exe.dev under their own grants and the single replay-budget rule.

**You see.**

- [ ] The phone's Factory tab reads the guest bridge, a new owner decision produces one correctly collapsed push, and the authorized fixture reaches a ready PR as nubl-agent. The default final state remains held.

**Verify, unit.** Tests alone are not sufficient verification. A PR is verified only when its unit, live, and perf boxes are all checked.

- [ ] Run `npm run check` at the deployed Factorio SHA and read the Shep owner's exact-revision bridge test receipts. Keep missing Shep evidence blocked. Run the plan checker.

**Verify, live.** Tests alone are not sufficient verification. A PR is verified only when its unit, live, and perf boxes are all checked. Ten lanes on `task:qa` at the PR head, per the boot recipe.

- [ ] Lane 1. Regression lane against trunk. Read the same frozen OwnerFeed state at trunk and head and show it through the pinned bridge. Save `feed-parity.json`. Pass when v1 data agrees apart from read time and the phone's counts match. Record any absent trunk phone integration rather than inventing a screenshot.
- [ ] Lane 2. Open the Factory tab on the owner's phone. Save `factory-tab.png`. Pass when counts and GitHub links match the current feed and the phone contacts only the bridge.
- [ ] Lane 3. Restart the bridge with existing attention entries. Save `seed.png`. Pass when the first available read seeds without an alert.
- [ ] Lane 4. Create a new owner-decision fixture under D7. Save `needs-you.png`. Pass when one alert arrives with title at most 64 UTF-8 bytes and body at most 256 bytes.
- [ ] Lane 5. Create a failed fixture and then a new owner decision for the same issue. Save `collapse.png`. Pass when the failed alert is quieter and the newer alert replaces it under the same collapse key.
- [ ] Lane 6. View a run while changing its attention state. Save `viewing.png`. Pass when no alert is delivered for that viewed run.
- [ ] Lane 7. Use multibyte fixture titles and duplicate entries for one issue. Save `unicode.png`. Pass when trimming preserves characters, the key collapses once, and a needs-you entry is not lost.
- [ ] Lane 8. Interrupt the bridge's direct `owner-feed --json` read and bridge-to-Apple connectivity separately. Save `unavailable.png`. Pass when unavailable feed sends no false alert and APNs recovery follows the recorded bounded Shep policy without a duplicate burst.
- [ ] Lane 9. After #738's two prerequisites pass, run the authorized full fixture from the orchestrator's prefilled link and Giuseppe's Submit to a ready PR. Save `ready-pr.json`. Pass when the creation-time label actor is Giuseppe, the admitted snapshot is valid, and only controller publication uses nubl-agent. Require CI, ledger, markers, and receipts to retain that bot identity, preserve caps, and report real model families honestly.
- [ ] Lane 10. Read guest egress and both hosts' final status. Save `final-held.json`. Pass when only the bridge contacted Apple, the old controller stayed stopped, and the new controller is held unless ongoing dispatch has its own owner approval.

**Verify, perf.** Tests alone are not sufficient verification. A PR is verified only when its unit, live, and perf boxes are all checked.

- [ ] Metric. Feed computation and bridge-read latency on both revisions, plus added feed-to-phone and feed-to-push latency. Record fixture stage wall times and tokens under their existing caps.
- [ ] Probe. Interleave three trunk/head feed reads through the same bridge and three new decision transitions at head. Save `perf.json`. Run the full fixture once under its separate token reservation.
- [ ] Baseline. Record trunk's feed and bridge-read medians first. If trunk has no phone integration, record that absence and measure the new path separately.
- [ ] Rule. Fail if feed work exceeds 500 milliseconds excluding CLI startup, the open phone takes over 15 seconds to show a new available feed, or a push takes over 60 seconds after the feed transition with Apple reachable. Fail any stage-cap breach. Do not claim a speed ratio between missing trunk pushes and delivered head pushes.

**Review gate.** The operator reviews before merge.

- [ ] Copy lane 2 and lane 4 screenshots to `docs/plans/media/VM9/VM9-review-factory.png` and `docs/plans/media/VM9/VM9-review-push.png`.
- [ ] Record a 30 to 60 second video showing a decision, push arrival, collapse, and GitHub tap. Save `docs/plans/media/VM9/VM9-review.mp4` without secrets or private issue text.
- [ ] Post the screenshots and video in chat for the operator. Stop at merge-ready. Obtain the separate real-dispatch decision rather than treating phone approval as that grant.

**Merge.**

- [ ] Root's clean verdict at the exact head SHA and pinned Factorio and Shep revisions.
- [ ] Bugbot triage done.
- [ ] Rebased onto current trunk after the verdict, with the verdict still valid under the patch-id rule in `playbooks/shipping.md`.
- [ ] Append VM9 to the verified stack. The owner lands it. Record whether production remains held or D7 explicitly enabled ongoing dispatch.

## Close the program

- [ ] Every box above is checked with its evidence. Keep blocked qualification or owner actions visible rather than declaring the program complete early.
- [ ] Reply to the operator with the report `autopilot-stack` names. Include each PR verdict, grants used, the guest identity, backup restore result, production hold state, and any remaining external dependency.

## Appendix A. Prototype evidence

No prototype ran during this plan-only task. No VM was created and no host setting changed. The supplied observation record is `/home/g/Projects/pi-herdr-factorio-trails/ms-a2-vm/facts.md`, dated 2026-11-10. Its host facts still apply, including uninitialized LXD 6.10.1 LTS, no instances, and enabled nested KVM. They were not rechecked live. Its production-host and parked-provisioning statements are superseded by the owner's later sequence and main. Amendment 1's one `factory` user for the controller, bridge, and restricted pi orchestrator remains the design.

The revision base is main `e6a3d74`. The intervening #727 changed docs only. #742 moved active operations to `nublai/pi-herdr-factorio`, made `handoff.reviewers` explicit, and added a read-only history alias. `giuseppecrj/pi-herdr-factorio` is retained history only, never an acting repository. #743 landed the one-command installer, MV3 provisioning, and the `nubl-factory` verification target. VM5 reuses those files on main, not the parked provisioning branch. The installer installs a held controller as `exedev` and does not prove cutover, retirement, or dispatch qualification. The owner installs the first real host by hand using `docs/operations/install-exe-dev.md`. #734 owns retirement of `pi-factorio` after #712's drain is verified and that host works. This plan has no receipt that marks #712 complete.

MV1, MV2, and MV6 remain reusable on main. The earlier author read MV4a's drain runbook on `origin/mv4-drain-foreign-markers` and MV4b's `da9543c` file list. VM6 and VM7 reuse those patches for the later drain and identity switch from `nubl-factory`. Review their then-current tips against main before porting. The exmach VM, edge, and APNs dependencies remain parked. The platform runbook still contains legacy repository examples. For active repository defaults and the history alias, use `src/trust/platform.ts` and #742, not those stale examples.

Prototype evidence still required during authorized execution follows. Each prototype gets one bounded round. Record the branch, SHA, commands, redacted logs, and any screenshot in the PR trail. A failed round ends in a blocker or a scoped amendment, not an unbounded investigation.

- VM2 must prove the cloud image exists at the selected fingerprint, ZFS backing is supported on the actual host filesystem, the subnet is unused, and the guest can run initial bwrap userns and limited user scopes. Stop after one disposable guest and one restore. Nested KVM is useful host capacity evidence, but bwrap does not require nested virtualization inside the guest.
- VM2 must observe the model endpoint's tailnet IP and TLS identity. Facts give the URL, not the IP. No guessed address belongs in VM3's built-in profile.
- VM3 must prove CLIProxyAPI's Responses streaming, usage, cancellation, auth header, and any approved Anthropic path. The current route code rejects a credentialed, pinned POST under a forbidden domain. Its narrow built-in exception is new code, not existing configuration support.
- VM4 must prove App installation-token scope, GitHub identity lookup behavior, returned comment author type and App slug, Actions dispatch, and artifact redirects. On exe.dev use only an owner-device-minted fixture token, never the App key. Bound the API prototype to one fixture repository and one harmless write and dispatch each. Local broker tests use dummy keys. Guest broker proof waits for VM5. Missing installed permissions need the owner, not a broader token by default.
- VM5 must prove `LoadCredential=`, a system unit using `factory`'s user manager, reboot without login, and direct same-user bridge reads of `owner-feed --json`. It must inspect the pi session's fixed profile and factory-only tool registration. Dummy state must demonstrate the shared-UID residual without exposing real held-out tests. The host's userns settings do not settle guest AppArmor behavior.
- Before any orchestrated intake, #738 must prove the cached `bot_actor` refusal and the real creation-time-label flow on an exe.dev test VM. The issue is a prerequisite, not a completed receipt or authority to weaken snapshot proof.
- VM8 must prove retained-history compatibility and byte-preserving state and replay-budget transfer from `nubl-factory`. VM9 must prove the real phone and direct APNs path at pinned Shep and Factorio revisions. Neither can be settled by the planning leaf's local reads.

## Appendix B. Alternatives rejected

A dedicated LXD VM is the owner's settled choice for the later ms-a2 host, not a replacement for the first installation on `nubl-factory`. It gives bwrap a guest kernel rather than the ms-a2 host kernel, contains guest userns and AppArmor changes, and supports a separate boot and recovery lifecycle. An LXD container shares the host kernel and often needs nesting allowances for bwrap. It is cheaper to run but does not meet this isolation goal. Neither a VM nor a container protects guest secrets from host root.

The proposed 4 vCPUs and 12 GiB are a starting size, not a benchmark result. Two one-CPU, 2-GiB scopes account for 2 vCPUs and 4 GiB. The remainder covers the controller, gateway processes, user manager, bridge, restricted pi orchestrator, test setup, and OS. A 160-GiB disk gives room for source, pinned bundles, dependencies, and private evidence, which is not automatically pruned. The 240-GiB pool leaves limited snapshot headroom within the observed 1.4 TB free. Monitor disk use and stop new work before exhaustion. Increase storage only under the owner's grant, not by deleting accounting.

ZFS is proposed for VM block storage and space-efficient snapshots. Loop-backed storage avoids assuming an unused physical disk that facts.md does not identify. It adds a filesystem layer and competes with other host writes. A dedicated device is preferable when available. The `dir` driver is simpler but has less efficient VM snapshots and needs a revised measured space budget. LVM thin storage needs an approved device or volume group. Do not repartition a host disk on inference.

A managed NAT bridge avoids exposing the guest on the LAN and does not depend on choosing one of the host's five physical NICs. Macvlan gives a LAN address but complicates host-to-guest communication and broadens exposure. Guest Tailscale gives the VM its own ACL identity without granting a host subnet router authority over its service path. Tailscale alone is not a credential boundary against host root.

D1 has three concrete options.

1. Move all agent sessions to a separate unprivileged host account. Keep `g` as a human admin, with its home private and no SSH agent forwarding or writable automation paths into that account. This is the recommendation because it preserves human recovery access without giving agents LXD or sudo. Every future agent launcher, including Herdr and Shep work, must use the unprivileged account. Shared writable source that a privileged admin executes remains a trust risk, so review privileged scripts before execution.
2. Remove `g` from `lxd` and remove passwordless sudo for agent sessions. Revoke cached sudo authorization and restart existing sessions so old supplementary groups do not survive. Use a separate human admin account. A narrowly allowed command that can execute arbitrary code, manipulate systemd, or access a guest disk would defeat the restriction. Password prompts inside agent sessions are not a safe substitute for separation.
3. Use restricted LXD projects and scoped remote identities for agent-managed test VMs. This can limit those identities to test resources. It does not constrain `g` while `g` keeps the local LXD socket or sudo. Project restrictions alone therefore do not satisfy the credential requirement. They are an optional addition after removing those privileges, not the recommended first fix.

Continuing unsandboxed agents as privileged `g` is incompatible with the requested protection. If the owner keeps that arrangement, do not install production secrets or claim the VM hides them. A different physical host or a changed trust requirement would need a new owner decision.

For models, prefer mac-studio CLIProxyAPI over Tailscale, with separate controller and orchestrator keys and proxy-side per-key rate and spend caps. Direct provider keys are an alternative only under revised D3 approval and equivalent external caps. Factorio's local cumulative accounting cannot constrain a stolen key used outside its gateway. The keys remain readable after a `factory` UID compromise, so cap and rotation proof is required. No personal host key or model-key mount belongs in a stage.

For GitHub, a root-owned guest minting unit keeps its dedicated App private key root-only and hands out repository-limited tokens valid for at most one hour. A same-user compromise can obtain those tokens but cannot read the root-only App key. The tokens allow contents, PR, issue, and Actions writes, including trusted CI dispatch. Branch rules, not token lifetime, must stop direct pushes to main and unapproved merges. Continued broker access obtains fresh tokens until revoked. This App-key protection does not protect the long-lived model or APNs keys described in Appendix C. A human PAT or the host's `gh` login is rejected because it changes controller identity and broadens authority. A broker on another trusted machine could keep the private key off ms-a2 entirely, but adds service availability and authentication dependencies. It still cannot hide usable guest tokens from a privileged host agent. Start with the guest broker after D1 passes.

For OwnerFeed, run the controller, bridge, and restricted pi orchestrator in one VM as `factory`. The bridge reads `owner-feed --json` directly from the private state directory, with no sudoers rule. The coordinator rejected a separate bridge UID and private-feed exporter because one user is simpler and the orchestrator and bridge are trusted components. The tool restriction, not Unix permissions, separates the orchestrator from controller state and held-out acceptance tests. Group-readable state is unnecessary and violates the feed readers. Publishing the viewer is also rejected because it exposes more than the feed, including a hold action the phone contract does not authorize.

For orchestration v1, use Shep's fixed-profile pi session with only factory extension tools. The extension builds a prefilled `issues/new` link carrying `factory:ready`, and Giuseppe submits it under his own login. A founder token on the machine and a bridge-signed approval broker are rejected. They would let a compromised machine approve its own work. The controller's App token remains separate from this intake design, though a shared-user compromise can reach it. #738 supplies the bot refusal and creation-time-label proof. #739 supplies exact intake references and multi-repo feed contracts. #740's questions link belongs to v1.1.

## Appendix C. Risks

- Host privilege isolation is a hard prerequisite in VM2. All supplied host-agent sessions currently run as privileged `g`. Disk encryption, guest permissions, LXD projects, and tailnet ACLs do not change that fact.
- Credentialed model routes in VM3 require a narrow exception to three existing safeguards. The cross-family audit must verify that declared routes retain their old refusals and cannot borrow the built-in exception.
- GitHub App auth in VM4 is not yet proven against Factorio's GraphQL viewer check. The known App identity and Actions write permission are necessary but not proof of every API or artifact download path.
- The production image and sizing in VM2 remain unbenchmarked. A guest kernel failure, ZFS incompatibility, user-manager failure, or capacity failure blocks provisioning. Change the plan before retrying a materially different design.
- The shared `factory` UID is an explicit residual in VM5. Arbitrary code as that user can read held-out tests, both long-lived CLIProxyAPI keys, and the APNs signing key. It can obtain broker tokens, remove the `disabled` hold file, and edit accounting and the replay budget. `LoadCredential=` controls delivery, not same-UID isolation. A stolen proxy key can spend outside local caps, so D3 requires proxy-side rate and spend caps and rotation. An App token can write contents, issues, PRs, and Actions within its repository scope for up to an hour, and broker access can renew it. VM7 must prove that the bot has no main-push or review bypass. VM4 protects only the root-only App key. Build and repair isolation remains a separate bwrap guarantee.
- Guest verification uses `factory-verify` and named reads of owner-reviewed exports, not a `factory` shell. Owner transcripts supply private-state and administrative evidence. VM2 and VM5 must prove that this path cannot read broker, credential, or state directories, and that the bridge subnet cannot bypass the tailnet policy.
- Shep's direct CLI feed reader, factory extension, fixed launch profile, and direct APNs runtime are external dependencies in VM5 and VM9. The plan grants no cross-repository changes. No native-mobile control skill is installed in this checkout. Use the Shep owner's supported native tooling or a recorded manual phone drive with the owner. Keep missing automation and manual evidence explicit.
- The backend evidence adaptation uses logs and JSON instead of screenshots for VM1 through VM8. The installed swarm skill exists. VM9 retains screenshots and video because the owner must see the phone interaction.
- VM6's diagnostic code and fixture rehearsal land before VM7 executes the production drain. VM7's first operational box requires the real source inventory, fresh zero predicates, stopped scopes, and backup checksums. Fixture evidence never substitutes for that box.
- VM3 and VM4 depend on VM5's runtime for guest qualification. Their code may stack while those checks are pending, but neither gets a full verdict before the checks pass. VM7 has a separate main-owned CI bootstrap boundary. Its native reporter lane blocks VM8's production transfer, not pre-drain preparation and rehearsal. D5 and the reviewed rollback procedure must exist before D6. No generic bootstrap exception applies to other missing tests.
- State paths and repository slugs may outlive the host move. VM6 and VM8 inspect them and stop on incompatible recovery. Renaming hashes or dropping claims would erase identity or accounting, so it is not a migration shortcut.
- Full LXD disk snapshots contain the App private key and Tailscale node key. Local access is human-admin-only and exports must be encrypted. They do not survive loss of ms-a2, so VM8 requires an off-host copy and a real restore. Rollback after new production writes is unsafe because GitHub and accounting have moved forward. Do not rerun the exe.dev installer on the drained source, because it restarts and enables the old controller.
- The `nubl-factory` target and active repository defaults are on main, but they do not prove a live installation or integration attachment. VM1 and VM6 require fresh reads from `nubl-factory`. #734's earlier cutover and retirement evidence cannot substitute for this later drain. After VM7, the exe.dev bot needs a separate test repository to exercise full CI without weakening production.
- Orchestrated intake stays blocked until #738's `bot_actor` refusal and creation-time-label lane pass. A prefilled link is not proof that admission accepts its snapshot. #739's `intakeRef`, `repositories`, and multi-repo reads are separate additive work, and #740's `questionsUrl` remains v1.1. This plan does not silently implement those issues or treat them as done.
- Test controllers and production must never reconcile the same repository concurrently, even if one is held. The verify-factory rule still applies across different machines. Shared replay accounting has exactly one writer across production and exe.dev tests.
- No dispatch is authorized by this plan. VM8 is a held migration. VM9's bounded fixture run and ongoing production dispatch are separate D7 approvals. Missing grants are blocked boxes, not permission inferred from the old exmach or factory program.

## Appendix D. Links and reading list

- Read the supplied host facts and Amendment 1 at `ms-a2-vm/facts.md` in the private trails checkout (`../pi-herdr-factorio-trails/`) before VM2. Keep their host observations and shared-user design. Use this plan's later owner sequence and current main instead of the stale production and provisioning statements.
- Read `nublai/root`'s `.pi/plan/research/orchestration.md` for the coordinator's orchestration v1 decision. Track [#738](https://github.com/nublai/pi-herdr-factorio/issues/738) for bot refusal and creation-time labels, [#739](https://github.com/nublai/pi-herdr-factorio/issues/739) for intake references and multi-repo feed reads, and [#740](https://github.com/nublai/pi-herdr-factorio/issues/740) for the v1.1 questions link.
- Read `docs/plans/factory-v1.md`, `docs/decisions.tsv`, and `docs/plans/exmach-move.md` for program limits, authority history, and the reusable MV work. This plan does not resume the parked exmach program.
- Read `docs/operations/install-exe-dev.md`, `docs/operations/platform.md`, `docs/operations/sandbox.md`, `docs/operations/owner-feed.md`, `docs/operations/backup.md`, and `.pi/skills/verify-factory/SKILL.md` before changing their contracts. Check active repository and history behavior against `src/trust/platform.ts`, and reviewer selection against `.github/factory/WORKFLOW.md`.
- Read `git show origin/mv4-drain-foreign-markers:docs/operations/drain.md` for VM6. Read main's `server/install-exe-dev.sh`, `server/provision.sh`, `server/factory.service`, `test/install-exe-dev.test.ts`, and `test/provision.test.ts` for VM5. Read `origin/mv4b-ci-bot`'s workflow and reporter-test patch for VM7.
- VM2, VM3, VM4, and VM5 get the how skill, `<pstack>/skills/how/SKILL.md`. Use `<pstack>/skills/interrogate/SKILL.md` only for the owner choices D1 through D7, not routine implementation details.
- Keep the decision trail under `<pstack>/skills/show-me-your-work/SKILL.md`. Use its `log.sh` for append-only rows during execution. The planning leaf does not append coordinator decisions.
- Read `<pstack>/skills/technical-writing/SKILL.md`, `<pstack>/skills/unslop/SKILL.md`, `<pstack>/skills/no-comments/SKILL.md`, and `<pstack>/skills/typescript-best-practices/SKILL.md` before their respective writing, review, or source work.
- Verify LXD image, storage, project, bridge, and VM options against the installed LXD 6.10.1 help and Canonical's documentation during VM2. Verify GitHub App JWT and installation-token contracts against GitHub's current documentation during VM4. Verify Tailscale grants, tagging, and key handling against the owner's actual tailnet policy before applying D4.
