# Install Factorio on exe.dev

Giuseppe creates `nubl-factory` from `boldsoftware/exeuntu` and installs the Shep bridge first. Run Factorio's installer as `exedev` (uid 1000, home `/home/exedev`, passwordless sudo), not as root. This is the default `exe-dev` platform; the installer refuses an existing `/etc/factory/platform.json` and never writes one.

This installs a **held** controller, not a cutover. Retiring `pi-factorio`, copying production state, enabling dispatch and phone verification are separate owner operations (#734). A hold blocks new dispatch, not observation of existing runs.

## Attach integrations

Run these on your computer, not inside the VM:

```bash
ssh exe.dev integrations add github --name nubl-factory-repo --repository nublai/pi-herdr-factorio --attach vm:nubl-factory
```

Models need no command, because the `llm` integration is attached to every VM (`auto:all`). Check with `ssh exe.dev integrations list`. If the repository integration already exists, attach it instead of adding it again:

```bash
ssh exe.dev integrations attach nubl-factory-repo vm:nubl-factory
```

A newly added or re-attached integration can take a minute or two to reach the VM. Until then reads answer 403, and `--check` refuses `github_integration`, so wait and run it again. Keep the GitHub bot identity. Do not use `--act-as-user`, `--readonly`, `gh auth login` or a token. Git and GitHub reads use `github.int.exe.xyz`; models use `llm.int.exe.xyz`. No credential is installed or printed.

## One command

SSH to `exedev@nubl-factory.exe.xyz`. Set `C` to the full lowercase 40-character SHA published in `nublai/pi-herdr-factorio`:

```bash
C=<sha>; curl -fsSL https://raw.githubusercontent.com/nublai/pi-herdr-factorio/$C/host/install/install-exe-dev.sh | bash -s -- "$C"
```

The selected revision must include the repository rename in the platform allowlist and a valid trusted workflow on `main`. The installer refuses to start a controller whose platform does not allow the requested repository.

For another repository, change the script URL to the repository containing the installer and append `--repo owner/name`. The target defaults to `nublai/pi-herdr-factorio`; the selected revision's platform allowlist and trusted workflow must also allow that target. `--vm name` changes only the VM name in preflight fix instructions (default `nubl-factory`), not the host being installed.

### Disposable layout fixture

This example is separate from the production command above. Use it only under the fixture and disposable-VM grants. The coordinator prepares a fixture commit derived from the exact product SHA, changing only the platform default repository list and the repository field in the fixture's trusted workflow. Record both SHAs and that two-field diff. `--repo` alone cannot make a product revision accept another repository.

The fixture repository `nublai/pi-herdr-factorio-layout-fixture` is private, so `raw.githubusercontent.com` answers 404 for it. Fetch the pinned installer through the disposable VM's own GitHub integration instead, the same `github.int.exe.xyz` API route the installer's preflight uses. Attach an integration scoped to the fixture repository first, as the preflight's `github_integration` refusal describes. The installer never receives a credential.

Before touching the VM, compute the installer's expected hash from the pinned fixture commit in a fixture checkout, and record it with both SHAs:

```bash
C=<full-fixture-sha>
git -C <fixture-checkout> show "$C:host/install/install-exe-dev.sh" | sha256sum
```

SSH to `exedev@<disposable-name>.exe.xyz`. Fetch the installer from the fixture repository at `$C`, check it against that hash, then use the fixture repository for the selected repository too:

```bash
C=<full-fixture-sha>
E=<sha256-from-the-pinned-commit>
F=/tmp/install-exe-dev-$C.sh
curl --noproxy '*' -fsS -H 'Accept: application/vnd.github.raw' "https://github.int.exe.xyz/api/v3/repos/nublai/pi-herdr-factorio-layout-fixture/contents/host/install/install-exe-dev.sh?ref=$C" -o "$F"
echo "$E  $F" | sha256sum -c -
bash "$F" --check --repo nublai/pi-herdr-factorio-layout-fixture --vm <disposable-name> "$C"
bash "$F" --repo nublai/pi-herdr-factorio-layout-fixture --vm <disposable-name> "$C"
```

`GH_HOST=github.int.exe.xyz gh api -H 'Accept: application/vnd.github.raw' "repos/nublai/pi-herdr-factorio-layout-fixture/contents/host/install/install-exe-dev.sh?ref=$C" > "$F"` is equivalent on the VM. Stop if `sha256sum -c` fails. An old-layout fixture revision keeps its installer at `server/install-exe-dev.sh`, so use that path in both the hash and the fetch when installing the old layout on the upgrade VM.

Use a clean new-layout VM for fresh installation and a separate old-layout VM for upgrade. Keep the hold. Do not attach the production repository integration to either VM. Fixture installation is not production deployment proof.

Old pinned download URLs still select their original installer. An old bootstrap given a new-layout SHA creates or retains the hold, then fails when the verified checkout lacks its old installer path, before any service stop. Download the new pinned `host/install/install-exe-dev.sh` bootstrap to upgrade; do not add an old-path shim.

### Check only

```bash
curl -fsSL https://raw.githubusercontent.com/nublai/pi-herdr-factorio/<commit>/host/install/install-exe-dev.sh | bash -s -- --check --vm nubl-factory
```

`--check` needs no commit argument. It only reads local prerequisites and performs a repository GET and an OpenAI models-list GET, never a model inference. Its namespace and bubblewrap smoke tests run `true` with the host filesystem read-only. It never clones, provisions, creates state, enables linger, installs a unit or restarts a service. Exit 0 means preflight passed; exit 1 prints a named refusal and a fix. Remote error bodies are suppressed.

Preflight requires x86_64 Linux, both exe.dev integration names resolving to the link-local edge, the normal VM user, passwordless broad sudo (`sudo -n true`), bubblewrap >= 0.9.0, working unprivileged namespaces and bubblewrap, systemd/logind, attached GitHub and model routes, and at least 4 GiB plus 100,000 free inodes on each filesystem containing the home, `/var/lib` and `/tmp`. Missing commands name their apt package. Preflight changes no configuration; sudo and network probes may generate ordinary system audit logs.

## What installation does

After preflight passes, it refuses a dirty, symlinked or wrong-origin checkout. It creates `/home/exedev/factory-state` owned by `exedev` at 0700 and its `disabled` hold before stopping or enabling any service. An existing state directory must already be private and owned by `exedev`; existing hold bytes and metadata are preserved.

It clones and fetches through the GitHub integration into a temporary directory beside `/home/exedev/pi-herdr-factorio`, checks out the exact SHA and verifies `git rev-parse HEAD` against it, before stopping the controller. A failed download leaves any old controller running and no partial new checkout. It re-executes the installer from that verified checkout, so provisioning uses the pinned installer rather than the downloaded bootstrap. It then stops and disables the service, moves a first checkout into place or updates the existing clean checkout, and runs full `host/install/provision.sh`, refreshing checkout dependencies on upgrades. MV3 installs host tools, Pi configuration, linger, the verified root-owned sandbox bundle and `/etc/factory/factory.env`. The installer renders the selected `--repo` into `host/install/factory.service`, installs it and restarts it. `Type=notify` waits for readiness; the installer checks `controller_ready` in that invocation's journal and requires a `status.json` timestamp later than the restart boundary, followed by a running controller's `status --json` with the same freshness requirement and `locally_disabled` with dispatch disabled. Only after those checks does it enable the service for boot.

It prints those reasons and atomically records the successful commit in `factory-state/install-exe-dev.commit`. A failure leaves the hold in place. After a stop, failure cleanup stops and disables the service so a half-provisioned checkout cannot crash-loop on reboot; it reports any cleanup failure explicitly. Fix the reported error and rerun the pinned command to recover. The installer does not roll back shared provisioning changes or lift the hold. Never treat preflight alone as proof of provisioning, cgroup limits, stage execution or an end-to-end install.

## Verify

On the VM, as `exedev`:

```bash
cd /home/exedev/pi-herdr-factorio
export PATH="$HOME/.local/bin:$HOME/.local/share/mise/shims:$PATH"
GH_HOST=github.int.exe.xyz node host/cli/index.ts status --json --state-dir /home/exedev/factory-state --repo nublai/pi-herdr-factorio
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

Upgrade only on a drained controller, following the [drained rollout procedure](human-review.md#roll-forward-from-a-drained-controller) linked from [Factory CLI](factory-cli.md#install-the-service). Then rerun the one command with `C` set to the new full SHA. The state and hold remain; the checkout, dependencies, bundle and unit are updated and the service restarts. With the same successful SHA, clean checkout, matching unit and an active service, rerunning performs preflight, verified-installer re-execution and status reads, retains the hold and skips provisioning and restart. If Giuseppe had lifted it, rerunning creates the hold again. Both paths wait up to two minutes for fresh held controller status, rather than accepting an old snapshot. Do not use the installer to discard local checkout edits or to switch an existing controller to a different repository.

## Shep bridge

The bridge runs as the **same `exedev` user**, reading the private state directly:

```bash
/home/exedev/.local/share/mise/shims/node /home/exedev/pi-herdr-factorio/host/cli/index.ts owner-feed --json --state-dir /home/exedev/factory-state --repo nublai/pi-herdr-factorio
```

No viewer ingress, extra port, token or privileged helper is needed. Install the bridge before Factorio, and point it at that command after the checkout exists. Shep owns its feed polling and push delivery; see [OwnerFeed contract](owner-feed.md). The installer does not configure or restart the bridge.
