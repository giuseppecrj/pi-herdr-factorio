# Factory owner dashboard

Start the viewer from a repository checkout on Node 26.12.1 or later:

```bash
node server/cli.ts viewer --state-dir "$STATE" --port 8080
```

Wait for `viewer_ready bind=127.0.0.1 port=8080`. Fetch the timeline on that machine with `curl`, or open it in a local browser. Stop the process with Ctrl+C or SIGTERM.

The home page groups tickets into **Needs you**, **Failed**, **Working**, and **Done recently**, in that order. Empty groups are absent. Each group is newest first. Done recently is folded and covers seven days, one row per ticket. Older runs remain reachable at `/run/<id>/timeline`; `--run <64-character-id>` opens one directly. The default port is 8080. A missing, non-private state directory or occupied port exits 1. Invalid arguments exit 2. The viewer never creates the state directory.

Desktop rows have fixed columns for title and stage, state and age, neutral token bar, and GitHub link. Select a row with `?run=<id>` to see its sentence, steps and action in the right-hand pane. On phones, rows open the run page directly. Repair rounds appear from round 1 onward, and CI appears only after the run reaches it. Unknown caps and results stay unknown. Published work being updated stays neutral **Working**, even though the attention feed counts it as blocked. A corrupt marker history gets one error Notice with issue links, not an invented working or failed run. Waiting PRs become old after three days, and blocked work after six hours. These trusted workflow thresholds flag age without changing groups or starting work.

The clean-landing panel reads only `metrics.json`. The controller refreshes it at startup and every five minutes outside the tick/watchdog path. It reads the complete ledger branch, one defect-label list and local receipts. Intervention results for merged PRs are cached for the controller process, keyed by repository, PR and merge SHA. Only new merge identities need review and dismissal reads. Until the report is complete, the panel says **Pending**. Remote collection has a 120-second bound. A failed refresh retains the last good report and marks it stale. The recorded-token tile uses the same durable usage total and exact/lower-bound/uncertain rules as `status --json`, saved in that local snapshot. It shows no program cap; that cap lives in the decision log. No page request calls GitHub or a model.

`GET /owner-feed.json` returns **OwnerFeed v1**, the same local projection as `node server/cli.ts owner-feed --json --state-dir "$STATE"`. It has seven attention counts, a separate working-run count and `durableUsage: {kind, total}`. Only status `budget_exhausted` has kind `budget`; a published token-cap hold stays `blocked`, with “On hold: token cap reached”. The golden example for clients is `test/fixtures/owner-feed/feed-v1.json`.

## Hold or resume the factory

The header has one form, **Hold factory** or **Resume factory**. It creates or removes only `$STATE/disabled`, the existing controller switch. It does not cancel work, reset a budget, restart a terminal run, or act as your GitHub identity. Ticket actions go to GitHub for answering, labeling, reviewing, merging and closing. The controller observes the local switch on its next tick.

The POST requires the exact loopback Host or the one authorized Tailscale hostname, a matching Origin, and the hidden per-process token from the current page. Null and foreign Origins are refused. The same-origin referrer policy preserves the Origin on browser form submissions over loopback HTTP, while sending no referrer to GitHub or other sites. A page saved before a viewer restart needs reloading. The form targets the current prefix. Every successful hold request logs its time, socket address and setting, never the token. On the authorized tailnet Host, it also logs `Tailscale-User-Login` as `proxy_reported_login`, a proxy-reported identity rather than a separately authenticated user. No other write route is accepted.

The manifest and bundled PNG icons let a phone install the page as an app. There is no service worker, private-data cache or client script. All responses use `Cache-Control: no-store`.

## Read the four views

Select **Timeline**, **Usage**, **Children**, or **Gateway**. Each view also has a JSON link at `/run/<id>/<view>.json`. JSON responses contain `runId`, `status`, `complete`, `gaps`, and `data`.

The timeline leads with Spec, Tests, Build, CI, Review and PR, each with its saved result, time and tokens when retained. Failure glyphs use the ledger's failure stage, never the final PR projection. Raw session events sit behind a disclosure, and a glossary explains the exact technical terms. The retained event record combines stage receipts, observed settlement, the latest claim, recorded marker comments, parent session events, publication, and CI evidence. Receipts have no start timestamp. Timestamped events use parsed times, with stable source order for ties. Entries without timestamps follow them, showing their source in stage and attempt order. Repair rounds come from the claim's run-level counter, recorded markers, and round-qualified build/review execution directories. Claims retain the counter even before another validation exists. F09a enumerates every retained current and archived round/generation from the candidate book, never a round-zero or latest-evidence alias. `build-r<N>-<attempt>` and `review-r<N>-<attempt>` directories participate in named missing-receipt gaps. The timeline also shows private review seats, answering models, isolation labels, tokens, and blocking status. It binds review attempts to their captured generation and admitted instruction pin. A missing round/generation receipt is a gap, not clean review. Each failed CI verdict also shows a `diagnosis` entry read from its stored assessment: the class and subreason, the fixed disagreement sentence when there is one, scenario IDs for `candidate` and `oracle`, and whether one bounded repair was authorized or none was spent. It never shows private test names, messages or paths. An unreadable assessment is a gap, and a failed verdict with no assessment is a gap.

Read **published PR** and **historical certification** separately from **selected generation** and **execution account**. The published row names the promoted certificate and recorded readiness; working validation, review, or repair can name a different round/generation. A selected round-zero marker can coexist with active round-one repair. Active generation is unknown for a repair execution rather than inferred from the selected marker.

An actual merge row records merged head, merge SHA, and actor, with unknown actor when absent. A matching historical certificate remains visible during refresh or a readiness void. An unmatched head is an owner override. These are recorded observations, not fresh GitHub reads or proof of exact remote event timing.

Usage shows receipt totals per model, then per-session parent and child tokens. F09a also shows `accounted`, the candidate book's usage high-water including pre-candidate spend. That accounting total is separate from `total`, the sum of retained receipts. A mismatch is a gap, not permission to rewrite either total. Specify's combined receipt counts once, not again for each draft, review, or revision receipt. Session totals that differ from receipts produce a gap. Cost is **unavailable** because stage receipts record no monetary prices. A zero token count is not a zero-cost claim. Unknown account spend retains its floor and a gap; absent sessions cannot supply missing per-model or child totals.

Children come from retained Pi session JSONL files. The parent's top-level `custom_message` record with `customType: "subagent_result"` and `details.sessionFile` connects each child to its parent without opening that supplied path. Each child has its own event timeline. Gateway rows show the recorded decision, destination when forwarded, stage, method, path, and reason. A denied request with no upstream says **not forwarded**, rather than inventing a destination.

## Account for missing evidence

The full gap list remains on the run page with plain explanations and exact details. Problems are listed first, then expected gaps under a separate heading. Repeated explanations are grouped, with every source path in Exact detail. Missing marker history, missing stderr logs, and missing sessions or gateway audits on old completed runs are expected gaps, shown neutrally. Missing sessions and audits on failed or budget-stopped runs are problems. Missing or corrupt receipts, claims and verdicts are problems and get an error Notice. A landed run does not open with “Evidence incomplete” merely because old marker history was not retained. The JSON `complete` flag still describes full evidence coverage, not approval to merge.

Before deleting build `agent-*` directories, the runner moves parent and child session JSONL into the execution's private `sessions/` directory. It keeps the newest whole files within 8 MiB and records dropped paths as `session_truncated` in the receipt. These sessions stay on the VM, mode 0600 under 0700 directories. Older runs may lack sessions. The viewer reports missing linked children as `missing_child_session` and truncation as gaps, preserving receipt totals rather than reconstructing individual usage. Private archived state in the original `agent-*/sessions/` layout also remains readable.

The latest claim, candidate book, and recorded markers determine which model stages the run reached. A missing receipt for any reached stage is a `missing_stage_receipt` gap, including when that stage's directory is gone. Admission lookup uses the run's repository identity, not a default repository.

A missing/corrupt/wrong-owner candidate book is an evidence gap, never a reconstructed empty history. With only a v3 marker, the viewer can name its selected public floor and PR, but certification, working generation, and active execution remain unknown. A retained `missing-evidence-observation.json` can show an actual merge without supplying a certificate or proving terminal completion.

The controller retains the latest claim, not a complete local history of GitHub marker comments. If a private evidence export contains `markers/<runId>.jsonl`, the viewer reads each object's `body` with the existing marker parser. Optional `timestamp` fields order those records. Without that export, the viewer names the missing history. It never fetches comments itself. Recorded comments are local evidence, not newly authenticated GitHub observations.

Source files are read-only. Symlinks are refused. Individual reads stop at 8 MiB, stage receipt reads at 1 MiB, stderr at 64 KiB, and total source reads at 48 MiB per request. Directory traversal stops at 10,000 entries. Limits appear as gaps. Claim reads use the same guarded reader; sibling claims are not opened. FIFOs and devices are refused without blocking. Session text, issue content, and stderr are untrusted. HTML renders bidi control characters as visible Unicode escapes. The viewer renders no Markdown or model HTML and runs no scripts.

## Distinguish saved-state checks from live proof

The F09a tests exercise the real CLI processes, registered status handler, and loopback viewer with saved synthetic state and fake external boundaries. Those checks prove local parsing, projection, and HTTP guards, not a native certified factory run, real model-session retention, or main-backed CI. Formal accounting and controller exploration remain incomplete after timeouts. Native Actions/P4, production settings, owner actions, and live/performance proof remain separate gates in [the handoff guide](human-review.md).

## Keep the viewer private

The server binds only to `127.0.0.1`. Reads accept GET only; the hold route accepts POST only with the checks above. It checks Host and same-origin Origin headers, sends no CORS headers, and sets a strict Content-Security-Policy. The CSP permits same-origin forms, manifest and static icons, but no scripts, external assets or framing. There is no merge, approve, label, retry, stage or cap control, model call, GitHub call or ledger writer.

Exposure requires the owner's explicit approval. Do not forward the port merely because the viewer is read-only. It contains private issue and session metadata.

Only after approval, start it with `--allowed-host <machine>.<tailnet>.ts.net`, then publish that loopback port through `tailscale serve`. Verify the HTTPS Tailscale URL before sharing it. The explicit hostname flag permits only that additional Host and its matching HTTPS Origin. It never changes the loopback bind. The factory has no Tailscale dependency, and the viewer does not invoke Tailscale.

To keep the host's root free for other services, serve the viewer under a path. Start it with `--base-path /factory` and publish it with `tailscale serve --bg --https=443 --set-path=/factory/ http://127.0.0.1:<port>`. Tailscale strips the mount path before proxying. Both stripped routes and direct prefixed loopback routes work. Links, redirects, assets and the hold form all carry the prefix. `--base-path` must be one or more lowercase `/segment` parts with no trailing slash.

The hostname is the security boundary, not the mount path. Other apps on the same `tailscale serve` hostname share the Origin and can read the dashboard token and private data. Mount only equally trusted apps there; the hold token does not isolate paths from each other. The CSP adds same-origin forms, icons and the manifest, and the referrer policy is `same-origin` so native hold forms send an Origin over loopback HTTP.

Failed and budget-stopped rows stay visible until a newer admission event supersedes them; they do not age out of their attention groups. Done recently alone has a seven-day window. For older terminal history, use a known run ID; there is no all-history index.

The VM has no tailnet. On a tailnet machine, keep an SSH tunnel to the VM's loopback viewer, then publish that local tunnel port. Under the owner's exposure grant:

```bash
# VM, with the tailnet machine's one authorized hostname
node server/cli.ts viewer --state-dir /home/exedev/factory-state --port 8090 \
  --allowed-host <machine>.<tailnet>.ts.net --base-path /factory

# Tailnet machine; keep this process running
SSH_AUTH_SOCK=$HOME/.ssh/headless-agent.sock ssh -N \
  -L 127.0.0.1:8090:127.0.0.1:8090 exedev@pi-factorio.exe.xyz

tailscale serve --bg --https=443 --set-path=/factory/ http://127.0.0.1:8090
```

Open `https://<machine>.<tailnet>.ts.net/factory/` yourself before sharing it. Only that hostname is allowed; adding a second machine requires changing the viewer's single `--allowed-host`, not a wildcard. To stop exposure without touching other services, remove only this mount with `tailscale serve --https=443 --set-path=/factory/ off`, then stop the SSH tunnel and viewer. Do not use `tailscale serve reset`, public Funnel, VM public ingress or the exe.dev integration to expose private state.
