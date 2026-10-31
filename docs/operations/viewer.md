# Inspect one run's local evidence

Start the viewer from a repository checkout on Node 26.12.1 or later:

```bash
node server/cli.ts viewer --state-dir "$STATE" --run "$RUN_ID" --port 8080
```

Wait for `viewer_ready bind=127.0.0.1 port=8080`. Fetch the timeline on that machine with `curl`, or open it in a local browser. Stop the process with Ctrl+C or SIGTERM.

Omit `--run` to select a run from the index. The ID is the full 64-character run digest. The default port is 8080. A missing state directory or occupied port exits 1. Invalid arguments exit 2. The viewer never creates the state directory.

## Read the four views

Select **Timeline**, **Usage**, **Children**, or **Gateway**. Each view also has a JSON link at `/run/<id>/<view>.json`. JSON responses contain `runId`, `status`, `complete`, `gaps`, and `data`.

The timeline combines stage receipts, observed settlement, the latest claim, recorded marker comments, parent session events, publication, and CI evidence. Receipts have no start timestamp. Entries without timestamps show their source and use stage and attempt order instead. Repair rounds come from recorded markers and validation claims, not guesses from directory names.

Usage shows receipt totals per model, then per-session parent and child tokens. Specify's combined receipt counts once, not again for each draft, review, or revision receipt. Session totals that differ from receipts produce a gap. Cost is **unavailable** because stage receipts record no monetary prices. A zero token count is not a zero-cost claim.

Children come from retained Pi session JSONL files. The parent's `subagent_result.details.sessionFile` connects each child to its parent without opening that supplied path. Each child has its own event timeline. Gateway rows show the recorded decision, destination when forwarded, stage, method, path, and reason. A denied request with no upstream says **not forwarded**, rather than inventing a destination.

## Account for missing evidence

A missing, corrupt, unsafe, or oversized source appears under **evidence gaps**. A run with any gap is never complete, even when the last claim says `stage_passed`. This describes evidence completeness, not approval to merge.

The existing build runner deletes its `agent-*` directories after settlement. A normal finished build therefore lacks its parent and child session timelines. The viewer reports that gap and preserves receipt totals. It does not reconstruct child identities or individual usage from a combined total. To inspect already archived sessions, use a private copy of state that preserves the original `stages/<runId>/.../agent-*/sessions/` layout. Archiving and changes to the runner's retention policy are outside the viewer.

The controller retains the latest claim, not a complete local history of GitHub marker comments. If a private evidence export contains `markers/<runId>.jsonl`, the viewer reads each object's `body` with the existing marker parser. Optional `timestamp` fields order those records. Without that export, the viewer names the missing history. It never fetches comments itself. Recorded comments are local evidence, not newly authenticated GitHub observations.

Source files are read-only. Symlinks are refused. Individual reads stop at 8 MiB, stage receipt reads at 1 MiB, stderr at 64 KiB, and total source reads at 48 MiB per request. Directory traversal stops at 10,000 entries. Limits appear as gaps. Session text, issue content, and stderr are untrusted. The viewer renders no Markdown or model HTML and runs no scripts.

## Keep the viewer private

The server binds only to `127.0.0.1`. It accepts `GET` only. It checks Host and same-origin Origin headers, sends no CORS headers, and sets a strict Content-Security-Policy. It has no action route, model call, GitHub call, or ledger writer.

Exposure requires the owner's explicit approval. Do not forward the port merely because the viewer is read-only. It contains private issue and session metadata.

Only after approval, start it with `--allowed-host <machine>.<tailnet>.ts.net`, then publish that loopback port through `tailscale serve`. Verify the HTTPS Tailscale URL before sharing it. The explicit hostname flag permits only that additional Host and its matching HTTPS Origin. It never changes the loopback bind. The factory has no Tailscale dependency, and the viewer does not invoke Tailscale.
