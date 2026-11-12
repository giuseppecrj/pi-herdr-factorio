# Back up and restore the factory

A backup preserves private run evidence, not permission to replay work. Restore with the controller stopped and the local hold set. Never run two controllers against copies of the same production runs. Service changes, VM provisioning and off-VM copies need the owner's authorization; this runbook grants none.

## What to keep

Copy the **entire state directory**, normally `/home/exedev/factory-state`, rather than selecting recent runs. It contains:

| Path under state | Why it matters |
| --- | --- |
| `admissions/github/`, `links/`, `answers/`, `contracts/`, `acceptance/` | Original issue snapshots, linked attempts, answers, contracts and private acceptance suites with their receipts. |
| `claims/` | Run identities, sequence numbers, usage floors and candidate books, including current and archived checks, reviews, working attempts and holds. |
| `accounting/` | Immutable run-start policy and historical caps, request journals, charges, interrupted attempts and merge accounting. Missing accounting must never grant a new allowance. |
| `stages/` | Redacted execution receipts, retained parent and child sessions, stderr metadata and gateway audits. These remain private even after a PR lands. |
| `patches/`, `validation/`, `review/`, `handoff/`, `feedback-sweep/` | Candidate patches, exact-head CI/verdict/report bindings, review receipts, PR publication receipts, owner feedback batches, notice keys and sweep cursors. |
| `ledger/` | Frozen terminal snapshots and rows, outbox jobs, publication receipts, retries, adoption cursor and ledger anchor. Keep it even if `factory/ledger` already contains a row. |
| `workspaces/`, `pristine/`, `build-base/`, `review-base/`, `base-dependencies/`, `visible-tests/` | Private checkouts, stage inputs and test evidence. Preserve them together with their claims; do not reconstruct completion from a public PR. |
| `status.json`, `metrics.json`, `disabled`, `verification.json` when present | Last tick, cached outcome report, local hold and any immutable verification scope/cap. Never restore verification state as production. |

Also keep the controller source checkout and its `.git` metadata, recording its exact commit and dirty state. This preserves any locally fetched `factory/ledger` ref or separate operator-maintained ledger checkout. The controller's authoritative ledger is the remote `factory/ledger` branch; its private recovery data is `state/ledger/`, not a second mutable ledger database. Preserve a separate ledger checkout too if the operator has one; record its location and SHA. A metrics snapshot alone is not a ledger backup.

Record the configured workspace root if it lives outside the state directory and copy it with the same stopped-state procedure. Record `/var/lib/factory-sandbox/current` and the full target `assets-<digest>` directory, plus the source revision used by `host/install/provision.sh`. Rebuilding at a later revision does not reproduce an old bundle. Preserve any older installed bundles still named by retained runs. Save the service unit, its overrides and non-secret environment configuration. Private Pi configuration belongs in the encrypted backup, never a public repository. Do not copy agent sockets, `/run` sockets, credentials from memory, or tokens into an evidence report.

`controller.lock` is only a PID/start-time description. The abstract Unix socket is the authority and cannot be backed up. Gateway sockets are also transient. The next controller replaces a stale lock description and reconciles owned processes before dispatch.

## Take a consistent backup

1. Under the service-change grant, set the local hold through the dashboard or the documented `disabled` file. Wait until live stage processes have settled and their receipts and charges are durable. A hold is not a cancellation, and stopping the system service does not prove user-manager stage scopes are gone. Inspect the controller status and `systemctl --user list-units 'factory-*'`; resolve any live execution before copying. Do not kill or delete arbitrary scopes.
2. Stop the controller and viewer. Confirm no manual `serve`, `tick` or `run` command owns the state directory. Keep production stopped until the copy is complete. Do not back up a changing workspace.
3. As `exedev`, create a private destination on a filesystem with enough free space. Record the source revision, bundle digests, service configuration, hold setting and backup time there. For example, on the VM:

   ```bash
   umask 077
   STATE=/home/exedev/factory-state
   BACKUP=/home/exedev/factory-backups/$(date -u +%Y%m%dT%H%M%SZ)
   mkdir -p "$BACKUP"
   git -C /home/exedev/pi-herdr-factorio rev-parse HEAD > "$BACKUP/source-sha"
   git -C /home/exedev/pi-herdr-factorio status --short > "$BACKUP/source-status"
   readlink -f /var/lib/factory-sandbox/current > "$BACKUP/sandbox-bundle"
   tar --acls --xattrs --numeric-owner --one-file-system \
     -cpf "$BACKUP/state.tar" -C "$(dirname "$STATE")" "$(basename "$STATE")"
   sha256sum "$BACKUP/state.tar" > "$BACKUP/state.tar.sha256"
   node /home/exedev/pi-herdr-factorio/host/cli/index.ts status --json \
     --repo nublai/pi-herdr-factorio --state-dir "$STATE" > "$BACKUP/status.json"
   ```

   Tar may report that a socket was ignored; no running stage may remain. Investigate any other warning. The sample archive covers state only; archive the source checkout, external workspaces and pinned sandbox bundles separately. Keep owner/mode metadata. Do not flatten 0700 directories and 0600 files into public permissions.
4. Copy the backup into approved encrypted storage off the VM, under a separate copy grant. Verify the checksum after transfer and test extraction into a private scratch directory. Never publish an archive, full session, acceptance suite or raw issue snapshot as a PR artifact.
5. Restart the source service only after the copy and checks finish. Restore the owner's previous hold setting only if authorized. Preserve the backup even when production is healthy.

## Restore onto a provisioned VM

1. Ensure the old controller cannot run. Provision a replacement from the recorded source revision with `host/install/provision.sh`, under the VM-change grant. Restore the exact retained sandbox bundles or verify rebuilt manifest digests match; select the recorded bundle only under authorization. Set up the repository-scoped exe.dev integration as documented, not by copying a GitHub token.
2. Verify the archive checksum, then extract into a new private scratch parent, **not over a running state directory**. Use `tar --acls --xattrs --numeric-owner -xpf state.tar -C "$RESTORE_PARENT"`. Restore the source checkout, external workspaces, service configuration and bundle pins too. Use the same service UID where possible. If the UID changed, explicitly restore ownership to the service user while retaining the original file modes. Do not follow symlinks or make private evidence world-readable to get past a failed check.
3. Confirm every regular file and its relative path, mode and checksum matches the backup. Keep `disabled` present. Do not delete claims, receipts, candidate books, verification pins, ledger jobs or accounting records to make startup succeed. Do not restore an older controller over newer marker/book formats.
4. Before starting, read `status --json` against the restored directory and compare with the stopped source's saved status using the same checkout and trusted workflow. PID/start time may differ; claim identity, stage, usage, caps, attention, durable accounting and ledger backlog must not. Missing GitHub access is a blocked comparison, not a match. Also inspect `owner-feed --json`, which needs no remote access. A stale or missing `metrics.json` only leaves the dashboard metric Pending; it does not erase ledger facts.
5. Start one controller while still held. Recovery must reconcile retained accounts, owned scopes and GitHub marker/branch/PR state before another model request. Confirm one claim per run, no duplicate publication or notice, preserved totals, and explicit holds for missing evidence. The last-tick time and metric snapshot will then advance normally.
6. Only after the owner accepts recovery, lift the hold. Re-enable the private viewer separately; exposure is not restored automatically. Follow [the viewer guide](viewer.md) for its one-host Tailscale mount. Keep the old backup and stopped source until recovery is accepted.

A scratch restore is the rehearsal for live lane 9. It must not start a production controller or mutate production GitHub state merely to compare saved status.
