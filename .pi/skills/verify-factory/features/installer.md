# Verify a held exe.dev installation

## Sub-features

- Preflight `--check` reads prerequisites without installing or restarting anything.
- Fresh installation verifies a full commit, provisions the host, and starts a held controller.
- A matching successful SHA rerun skips provisioning and restart but waits for fresh held status.
- Upgrade fetches and verifies before stopping the drained controller. A failure after stop retains the hold and attempts to stop and disable the service.
- Fresh status and the current invocation's journal prove readiness and the local hold. They do not prove dispatch or stage execution.

## How to get to it (user POV)

Use `host/install/install-exe-dev.sh` and [the installer runbook](../../../../docs/operations/install-exe-dev.md). Read the script at the chosen revision before running it. This recipe uses a disposable exe.dev VM named `layout-install-test`, not a production host.

The layout program requires separate grants for the fixture repository, its two-field configuration derivation, integration, VM lifecycle, install, upgrade, recovery, and cleanup. See [the fixture prerequisites](../../../../docs/plans/later/codebase-layout.md#disposable-fixture-setup-is-a-real-prerequisite). At this base, `--repo` alone cannot make a fixture installation work. The derived revision must allow the fixture repository in the platform defaults and its trusted main workflow. Record product and fixture SHAs and prove all other blobs identical.

`nubl-factory` is held production. Routine access is read-only; upgrades, bridge installation, the hold-lift and fixture runs each need Giuseppe's explicit go. Never run these disposable installation lanes there. `pi-factorio` was retired and deleted on 2026-11-13 (#734), with its state archived.

## Driving it with the named tooling

### Prepare the disposable target

Under the separate setup grant, create the disposable VM and attach only `nublai/pi-herdr-factorio-layout-fixture` to its GitHub integration. Keep the bot identity. Never attach production write access or use `--act-as-user`. The `llm` integration normally attaches automatically. Model inference is not needed for installation proof.

Connect directly to `exedev@layout-install-test.exe.xyz`. Run the remaining commands there as `exedev`, not root. `--vm` changes fix instructions only. It does not select or connect to a VM. Do not use legacy lane helpers as a target selector for this installation.

Set `C` to the approved full lowercase 40-character fixture commit published in the fixture repository. Match the bootstrap URL to that commit's layout. An old-layout commit uses `https://raw.githubusercontent.com/$REPO/$C/server/install-exe-dev.sh`. A new-layout commit uses `https://raw.githubusercontent.com/$REPO/$C/host/install/install-exe-dev.sh`, as below.

```bash
REPO=nublai/pi-herdr-factorio-layout-fixture
VM=layout-install-test
C='<approved-full-fixture-commit>'
URL="https://raw.githubusercontent.com/$REPO/$C/host/install/install-exe-dev.sh"
```

### Check preflight

Record the checkout SHA, hold metadata, state inventory, unit bytes, MainPID, and InvocationID if present. Run:

```bash
curl -fsSL "$URL" | bash -s -- --check --repo "$REPO" --vm "$VM" "$C"
```

Require exit 0 and `preflight=ok` with the explicit repository and VM. Compare the before and after inventory. No checkout, state, configuration, or service change is expected. The probe lists models but never calls one. A named refusal is not installation proof. Missing packages or changed host settings need their own owner grant.

### Install fresh and prove the hold

```bash
curl -fsSL "$URL" | bash -s -- --repo "$REPO" --vm "$VM" "$C"
```

Require exit 0 and `installed=<C> held=yes`. Confirm the checkout's exact SHA, its integration origin, private state at `/home/exedev/factory-state`, and a retained `disabled` entry. Capture the successful `install-exe-dev.commit` receipt privately.

Record the restart boundary and current service InvocationID. Inspect that invocation's journal for `event=controller_ready`. Require `status.json` and CLI `controller.lastTick.at` newer than the boundary, dispatch disabled, and `locally_disabled` among its reasons. The installer checks both fresh status reads before enabling boot. An old status file does not prove this start.

```bash
export PATH="$HOME/.local/bin:$HOME/.local/share/mise/shims:$PATH"
GH_HOST=github.int.exe.xyz node /home/exedev/pi-herdr-factorio/host/cli/index.ts status \
  --json --repo "$REPO" --state-dir /home/exedev/factory-state
invocation=$(systemctl show factory.service -p InvocationID --value)
sudo journalctl -u factory.service "_SYSTEMD_INVOCATION_ID=$invocation" --no-pager -o cat
systemctl show factory.service -p InvocationID -p MainPID -p NRestarts -p UnitFileState
```

Keep other dispatch reasons visible. A successful doctor or preflight is not sandbox, cgroup, bridge, or end-to-end qualification. Confirm no production issue or PR effect occurred.

### Rerun the same SHA

Record PID, InvocationID, hold bytes and metadata, receipt, and unit before rerunning the same command. With a clean matching checkout, matching rendered unit, active service, and successful receipt, require `already_installed=<C>`, unchanged PID and invocation, and fresh held status. It still runs preflight and the verified installer. A rerun creates a hold if none exists, so it is not a read-only command.

### Upgrade and fail safely

Drain the disposable controller under its grant before upgrade. Preserve state and hold evidence. Set `C` to the approved new-layout fixture commit and download that commit's bootstrap with `URL="https://raw.githubusercontent.com/$REPO/$C/host/install/install-exe-dev.sh"`. Rerun with explicit `--repo` and `--vm`. Require the new SHA and receipt, current readiness evidence, and the original hold retained.

For an authorized failure before stop, use a controlled unavailable integration or fetch. Require a named refusal and the old service identity unchanged. If the hold was absent, installation may already have created it before fetching. Preflight alone never creates it.

An old bootstrap given a new-layout SHA creates or retains the hold and fails before stopping the old service. Its failed re-exec leaves the staging clone at `~/.pi-herdr-factorio.install.*`. Under the cleanup grant, identify that invocation's exact directory, confirm its SHA with `git -C <directory> rev-parse HEAD`, then remove only that directory with `rm -rf -- <directory>`. Do not remove the controller checkout, state, or hold. Recover with the new commit's `host/install` bootstrap.

For an authorized provisioning failure after stop, require the hold retained, no new success receipt, and the service stopped and disabled. The installer reports failure to confirm stop or disable explicitly. It does not roll back the checkout, bundle, or shared provisioning changes. Preserve the error and fix its cause, then rerun the pinned command under the recovery grant. Never remove the hold to recover.

## Gotchas

- `--check` needs no commit argument. If supplied, it validates the commit's syntax. The downloaded script must still be pinned. Use one SHA variable for both the URL and the installation argument.
- Preflight requires x86_64 Linux, UID 1000 `exedev`, passwordless sudo, exe.dev integration DNS, bwrap at least 0.9.0, working user namespaces, systemd/logind, and disk/inode headroom. Namespace probes run `true`. Ordinary sudo or network audit logs may change.
- Dirty, symlinked, wrong-origin checkouts and an existing `/etc/factory/platform.json` refuse. Do not erase local work or platform configuration to force a pass.
- The installer never removes `disabled` or changes `factory:enabled`. A hold blocks launches but permits existing-run observation and terminal bookkeeping.
- Keep redacted commands, timestamps, product/fixture SHAs, exact configuration diffs, before/after identities, output, and exit status in the private trail. Close any authorized fixtures and confirm CLOSED. Stop owned test processes and remove disposable infrastructure only under the cleanup grant.
- The runbook's `FACTORY_VM=nubl-factory` doctor example is read-only, not installation authority. Read `../SKILL.md` for production target restrictions.
