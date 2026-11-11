# Install Factorio on exe.dev

Giuseppe creates `nubl-factory` from `boldsoftware/exeuntu` and installs the Shep bridge first. Run Factorio's installer as `exedev` (uid 1000, home `/home/exedev`, passwordless sudo), not as root. This is the default `exe-dev` platform; the installer refuses an existing `/etc/factory/platform.json` and never writes one.

This installs a **held** controller, not a cutover. Retiring `pi-factorio`, copying production state, enabling dispatch and phone verification are separate owner operations (#734). A hold blocks new dispatch, not observation of existing runs.

## Attach integrations

Run these on your computer, not inside the VM:

```bash
ssh exe.dev integrations add github --name nubl-factory-repo --repository nublai/pi-herdr-factorio --attach vm:nubl-factory
ssh exe.dev integrations attach llm vm:nubl-factory
```

The second command attaches the existing `llm` integration; it is unnecessary while its existing `auto:all` attachment applies. If the repository integration already exists, attach it instead of adding it again:

```bash
ssh exe.dev integrations attach nubl-factory-repo vm:nubl-factory
```

Keep the GitHub bot identity. Do not use `--act-as-user`, `--readonly`, `gh auth login` or a token. Git and GitHub reads use `github.int.exe.xyz`; models use `llm.int.exe.xyz`. No credential is installed or printed.

## One command

SSH to `exedev@nubl-factory.exe.xyz`. Replace **both** `<commit>` placeholders below with the same full lowercase 40-character SHA, published in `nublai/pi-herdr-factorio`:

```bash
curl -fsSL https://raw.githubusercontent.com/nublai/pi-herdr-factorio/<commit>/server/install-exe-dev.sh | bash -s -- <commit>
```

The selected revision must include the repository rename in the platform allowlist and a valid trusted workflow on `main`. The installer refuses to start a controller whose platform does not allow the requested repository. This installer is built on PR #728's provisioning; its local build alone does not include the separate repository-wide rename.

For another repository, change the script URL to the repository containing the installer and append `--repo owner/name`. The target defaults to `nublai/pi-herdr-factorio`; the selected revision's platform allowlist and trusted workflow must also allow that target. `--vm name` changes only the VM name in preflight fix instructions (default `nubl-factory`), not the host being installed.

### Check only

```bash
curl -fsSL https://raw.githubusercontent.com/nublai/pi-herdr-factorio/<commit>/server/install-exe-dev.sh | bash -s -- --check --vm nubl-factory
```

`--check` needs no commit argument. It only reads local prerequisites and performs a repository GET and an OpenAI models-list GET, never a model inference. Its namespace and bubblewrap smoke tests run `true` with the host filesystem read-only. It never clones, provisions, creates state, enables linger, installs a unit or restarts a service. Exit 0 means preflight passed; exit 1 prints a named refusal and a fix. Remote error bodies are suppressed.

Preflight requires x86_64 Linux, both exe.dev integration names resolving to the link-local edge, the normal VM user, sudo permission to enable linger, bubblewrap >= 0.9.0, working unprivileged namespaces and bubblewrap, systemd/logind, attached GitHub and model routes, and at least 4 GiB plus 100,000 free inodes on each filesystem containing the home, `/var/lib` and `/tmp`. Missing commands name their apt package. Preflight changes no configuration; sudo and network probes may generate ordinary system audit logs.

## What installation does

After preflight passes, it refuses a dirty, symlinked or wrong-origin checkout. It creates `/home/exedev/factory-state` owned by `exedev` at 0700 and its `disabled` hold before stopping or enabling any service. An existing state directory must already be private and owned by `exedev`; existing hold bytes and metadata are preserved.

It clones through the GitHub integration to `/home/exedev/pi-herdr-factorio`, fetches the exact SHA and verifies `git rev-parse HEAD` against it. It runs full `server/provision.sh`, refreshing checkout dependencies on upgrades. MV3 installs host tools, Pi configuration, linger, the verified root-owned sandbox bundle and `/etc/factory/factory.env`. The installer renders the selected `--repo` into `server/factory.service`, installs it, enables and restarts it. `Type=notify` waits for readiness; the installer checks `controller_ready` in that invocation's journal and then requires a running controller's `status --json` dispatch reasons to include `locally_disabled` with dispatch disabled.

It prints those reasons and records the successful commit in `factory-state/install-exe-dev.commit`. A failure leaves the hold in place. Never treat preflight alone as proof of provisioning, cgroup limits, stage execution or an end-to-end install.

## Verify

On the VM, as `exedev`:

```bash
cd /home/exedev/pi-herdr-factorio
export PATH="$HOME/.local/bin:$HOME/.local/share/mise/shims:$PATH"
GH_HOST=github.int.exe.xyz node server/cli.ts status --json --state-dir /home/exedev/factory-state --repo nublai/pi-herdr-factorio
sudo journalctl -u factory.service -n 100 --no-pager
```

Require `controller.state` to be `running`, `controller.lastTick.dispatch.enabled` to be `false`, and `controller.lastTick.dispatch.reasons` to contain `locally_disabled`. The journal must show `event=controller_ready`. Other reasons, such as a missing repository switch or sandbox preflight, remain visible and need their own checks before release.

From a local checkout with the verification skill:

```bash
S=.pi/skills/verify-factory/scripts
FACTORY_VM=nubl-factory "$S/vm.sh" "$S/doctor.sh"
```

This selects `exedev@nubl-factory.exe.xyz` and `github.int.exe.xyz`. The doctor reports tool versions and a repository read; it does not lift the hold. The separate repository rename must update the doctor's legacy repository probe too.

## Hold and upgrade

Only Giuseppe decides when to remove `/home/exedev/factory-state/disabled`, after the old controller is drained/stopped and cutover verification is complete. This installer never removes it and never creates or deletes `factory:enabled`.

To upgrade, rerun the one command with the new full SHA in both positions. The state and hold remain; the checkout, dependencies, bundle and unit are updated and the service restarts. With the same successful SHA, clean checkout, matching unit and an active service, rerunning performs only preflight and status reads, retains the hold and skips provisioning and restart. If Giuseppe had lifted it, rerunning creates the hold again. Do not use the installer to discard local checkout edits or to switch an existing controller to a different repository.

## Shep bridge

The bridge runs as the **same `exedev` user**, reading the private state directly:

```bash
/home/exedev/.local/share/mise/shims/node /home/exedev/pi-herdr-factorio/server/cli.ts owner-feed --json --state-dir /home/exedev/factory-state --repo nublai/pi-herdr-factorio
```

No viewer ingress, extra port, token or privileged helper is needed. Install the bridge before Factorio, and point it at that command after the checkout exists. Shep owns its feed polling and push delivery; see [OwnerFeed contract](owner-feed.md). The installer does not configure or restart the bridge.
