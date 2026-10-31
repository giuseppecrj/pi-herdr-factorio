# Read-only run viewer (F07d)

Use the doctor, snapshot, and lane setup in `../SKILL.md`. The command is `node server/cli.ts viewer --state-dir "$STATE" [--run "$RUN_ID"] [--port 8080]`.

1. Use a finished fixture's private state. Capture `status --json` before the viewer starts. Record the state inventory with file digests, the issue's comments, and any ledger inventory outside state. These reads are verifier actions, not viewer actions.
2. Start the viewer in the lane and record its PID. Wait for `viewer_ready`. Fetch `/run/<id>/timeline`, `/usage`, `/children`, and `/gateway` with `curl` on the VM's loopback address. Append `.json` to fetch structured evidence. Save `viewer.html`, `timeline.json`, `usage-totals.json`, `children.json`, and `gateway-view.json` under the lane's evidence directory.
3. Compare stage identities, attempts, settlements, publication and CI with the private receipts. Compare usage with the root receipts, counting specify's aggregate once. For retained children, require a parent link and one own timeline each. Costs without prices must say unavailable.
4. The existing build runner deletes its agent trees. A live finished build without archived sessions must show that gap, not empty-success children. A private archive may restore exact original session paths for a separate archived-evidence check. Record that distinction and the capture procedure. Never describe copied or synthetic session records as a fresh stage.
5. Fetch a real fixture snapshot with a literal `<script>` canary. Require escaped HTML, no data script, and the strict CSP header. No browser click is claimed by curl alone.
6. Send POST, PUT, DELETE, HEAD, and OPTIONS. Require 405. Send a foreign Host and Origin. Require 403. Probe the VM's non-loopback address and require failure. Compare all inventories, issue comments, and status again. No source or ledger bytes may change.
7. Check a missing state directory and an occupied port. Each must exit nonzero. In a disposable state copy, remove a session and corrupt a receipt. Require named gaps and `complete=false`.
8. Trace the viewer process only. Require no gh, model, or outbound connection. The only listener must be `127.0.0.1`.
9. Stop the recorded PID. Close every fixture and confirm its state. Delete only the authorized `factory/run/*` refs it created. Preserve private and redacted evidence separately, take the after snapshot, and run lane cleanup.

No Tailscale exposure is authorized by this recipe. The owner's exposure grant must name it separately.
