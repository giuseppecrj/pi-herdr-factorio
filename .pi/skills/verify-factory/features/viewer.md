# Run viewer and owner dashboard

## Sub-features

- The dashboard groups private run evidence and links ticket actions to GitHub.
- Timeline, usage, children, and gateway views expose missing evidence without inventing completion.
- Read routes make no GitHub or model requests. The separate guarded hold POST changes only the local `disabled` entry.

## How to get to it (user POV)

Run `node server/cli.ts viewer --state-dir "$STATE" [--run "$RUN_ID"] [--port 8080]` against authorized private state. It binds loopback. Follow `docs/operations/viewer.md` for the separate owner-approved Tailscale route. Read the target restrictions in `../SKILL.md` first.

## Driving it with the named tooling

Use the doctor, snapshot, and lane setup only where the task authorizes them.

1. Use a finished fixture's private state. Capture `status --json` before the viewer starts. Record the state inventory with file digests, the issue's comments, and any ledger inventory outside state. These reads are verifier actions, not viewer actions.
2. Start the viewer in the lane and record its PID. Wait for `viewer_ready`. Fetch `/run/<id>/timeline`, `/usage`, `/children`, and `/gateway` with `curl` on the VM's loopback address. Append `.json` to fetch structured evidence. Save `viewer.html`, `timeline.json`, `usage-totals.json`, `children.json`, and `gateway-view.json` under the lane's evidence directory.
3. Compare original instruction pin, round/generation/intent, captured execution and issued attempt, publication head, CI run/gate/report ID, and historical certification with the private book and receipts. Require all bounded current/archived generations, not a latest alias. Keep published historical certification and recorded readiness separate from selected working generation and active repair/review. Compare receipt `total` with sessions and candidate `accounted` high-water separately, counting specify's aggregate once. Mismatches and unknown account spend remain gaps. For retained children, require one parent link and own timeline each. Costs without prices must say unavailable.
4. Run one fresh fixture with two real Herdr children and no capture hook. After cleanup, require the agent trees to be gone and the parent and child JSONL files to remain under the stage's private `sessions/`, mode 0600 under 0700 directories. Require per-model parent and child usage to reconcile with receipts. Retention keeps newest whole sessions within 8 MiB per execution; dropped paths appear as `session_truncated` receipt gaps. Older archived runs may use their original session paths. Keep archived-state proof separate from fresh retention proof, and never describe copied or synthetic sessions as fresh.
5. Fetch a real fixture snapshot with a literal `<script>` canary. Require escaped HTML, no data script, and the strict CSP header. No browser click is claimed by curl alone.
6. Send POST, PUT, DELETE, HEAD, and OPTIONS to read routes. Require 405. Send a foreign Host and Origin. Require 403. Probe the VM's non-loopback address and require failure. Compare all inventories, issue comments, and status again. No source or ledger bytes may change. `/hold` is the exception, not a read route. Under a separate local-switch grant, verify its matching Origin and per-process token checks. Only the `disabled` entry may change.
7. Check a missing state directory and an occupied port. Each must exit nonzero. In a disposable state copy, remove a session and corrupt a receipt. Require named gaps and `complete=false`. Test missing/corrupt/wrong-owner candidate books separately. A v3 public floor cannot reconstruct certification, active round/generation, or terminal accounting. If a narrow merge observation was retained, show actual head/merge SHA/actor or unknown without inventing assurance. Matching historical certification must remain visible during refresh; an unmatched merged head is an owner override.
8. Trace the viewer process only. Require no gh, model, or outbound connection. The only listener must be `127.0.0.1`.
9. Stop the recorded PID. Close every owned fixture and confirm its state. Remove only exact authorized validation refs after checking their current heads; preserve moved refs and other lanes' work. Never remove a stable PR ref or private book/claim to reset the run. Preserve private and redacted evidence separately, verify archive hashes, take the after snapshot, and run lane cleanup.

## Gotchas

Record commands, timestamps, exact tested head/tree, original evidence provenance, expected/actual results, and exits. Viewer reads must make zero model/GitHub calls and no writes. The guarded hold POST is the sole state-changing route. Local F09a tests use real loopback routes and saved synthetic state with fake external boundaries. Label them accordingly; they do not prove fresh native sessions, owner actions, or main-backed CI. This targeted source-backed recipe update ran no VM lane or performance trial. See [handoff](handoff.md) for those pending prerequisites.

No Tailscale exposure is authorized by this recipe. The owner's exposure grant must name it separately.
