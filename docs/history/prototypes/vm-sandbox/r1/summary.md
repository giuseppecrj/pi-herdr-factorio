# F05 R1 prototype: experiments 1-3 on `pi-factorio`

Date 2026-10-29, 14:48-14:57 UTC. Scratch dir `/home/exedev/f05-proto/`, since deleted (`vm-cleanup.log`).
Tags: **[V]** = verified in the cited log in this directory. **[I]** = inferred.

## Verdict: R1 **PASS** for experiments 1-3, with the scope limits listed below

- **The edge picks the backend from one input: the request authority.** It reads the Host header, the HTTP/2 `:authority`, or the authority of an absolute-form target. **[V]** It ignores SNI and every forwarding header. **[V]**
- **A rewriting gateway controls all of these.** It always sends origin-form, one Host, its own SNI and no client forwarding headers, so nothing in the sandbox can choose GitHub. **[V]** for the prototype gateway (exp 3). **[I]** that the inputs we did not probe give the edge no other routing key.
- **The netns has no route and no DNS.** Inside `bwrap --unshare-all` none of the 238 bypass probes connected. **[V]**
- **The gateway forwards only to its fixed targets.** Through it, the sandbox reached `llm` (OpenAI and xAI models, plus one real `gpt-6.1-sol` response) and `registry.npmjs.org`. Every forged route, Host, forwarding header, absolute URL, CONNECT and method was refused with 403, and none of those requests produced an upstream connection. **[V]**
- **The R1 stop condition was not triggered:** no input reaches GitHub once a gateway rewrites everything. A CONNECT/SNI-allowlist gateway would fail R1, because Host and `:authority` route the request. This confirms C2(a) is out and C2(c) is viable. **[V]**

## Experiment 1: edge routing (`exp1-edge-routing.log`, condensed in `exp1-table.txt`)

There were 188 probes: 111 raw HTTP/1.1 (Python `ssl`, chosen SNI and raw request line), 36 HTTP/2 (Node 26 `http2`, separate `:authority` and `host`) and 41 curl, across `/openai/v1/models`, `/xai/v1/models` and `/zen`. Every one was an unauthenticated GET, and none carried credentials.

Backend fingerprints [V]:
- **LLM:** `{"object":"list"...}`, 2 × `x-trace-id`. Body sha `76c662dad…` for openai and `c41ee33e…` for xai. `/zen` returns 404 `unsupported endpoint: /zen`, again with 2 × `x-trace-id`.
- **GitHub integration:** 403 `path does not match any configured repository`, 1 × `x-trace-id`. The integration is repo-scoped, so even `/zen` is refused. A distinct body still identifies the backend.
- **Edge without a match:** 404 `404 page not found` (sha `b16e1576…`), 1 × `x-trace-id`.
- **Not attached:** 403 `integration not found or not attached to this VM`.
- **Server header:** never present.

| Input varied | Result | Chooses backend? |
|---|---|---|
| Host swap (SNI L, Host G) / (SNI G, Host L) | GitHub / LLM, every path | **yes, Host** [V] |
| SNI swap, unknown SNI (`unknown.int.exe.xyz`) | follows Host, not SNI | no [V] |
| No SNI, or upper-case SNI | TLS `internal_error` alert, no HTTP | no (rejected) [V] |
| `X-Forwarded-Host`, `Forwarded: host=`, `X-Original-Host`, `X-Host`, `X-Forwarded-Server`, `X-Original-URL`, `X-Rewrite-URL` | ignored, follows Host (h1 and h2) | no [V] |
| HTTP/2 `:authority` ≠ `host` header (Node) | follows `:authority`; `host` ignored | **yes, `:authority`** [V] |
| `curl --http2 -H Host:` | curl turns it into `:authority` → follows it | yes (same as above) [V] |
| Absolute-form target (`--request-target https://G/...` with Host L, and the reverse) | target authority wins over Host and SNI, h1 and h2 | **yes, target authority** [V] |
| `http://G/...` absolute target over TLS to L | GitHub | yes [V] |
| Host with a port (`:443`, `:8443`) | port ignored, host part routes | yes (host part) [V] |
| Host with a trailing dot (`G.`, `L.`) | edge 404, no backend | no [V] |
| Host in a different case (`GITHUB.INT.EXE.XYZ`, `LLM.INT.EXE.XYZ`) | edge 404: matching is case-sensitive, no backend | no [V] |
| Duplicate Host (L+G, G+L) | 400 Bad Request | no [V] |
| Missing Host (HTTP/1.1) / HTTP/1.0 without Host | 400 / edge 404 | no [V] |
| Host `api.github.com` via edge | edge 404 | no [V] |
| Plain HTTP :80 | 301 to `https://<Host>/…` | redirect only [V] |

Conclusion:
- The backend key is the request authority: the absolute-form target's authority, else `:authority`, else Host. **[V]**
- The gateway in exp 3 controls all three. **[V]**
- The remaining client-influenced upstream input is the path suffix after a route prefix. The edge chose the backend by authority in every probe, and the path only selected within a backend. **[V]** for the 3 paths probed.
- **[I]** We did not probe whether some *other* path on `llm` proxies elsewhere, because the scope allowed only the models paths on `llm`. The gateway rejects dot segments, encoded traversal, `//` and backslashes, which narrows that gap.

## Experiment 2: netns bypass suite (`exp2-netns-bypass.log`)

**Control.** The same probes run on the host, outside the sandbox. [V]
- `169.254.169.254:443`, `2852039166:443`, `0xa9fea9fe:443` and `140.82.114.5:443` all CONNECTED.
- `api.github.com/zen` returned 200, `github.int/zen` 403 (backend) and `llm/models` 200.
- `getent api.github.com` resolved.
- The host loopback listener `127.0.0.1:9999` returned 200.

**Sandbox.** The command was `bwrap --unshare-all --die-with-parent --new-session`, with ro `/usr`, `/etc/{resolv.conf,hosts,nsswitch.conf,ssl}`, proc, dev, tmpfs `/tmp` and `--clearenv`.
- `resolv.conf` was bound in on purpose, so DNS failures come from the missing route, not from missing config.
- Interfaces: `lo` plus the DOWN `gre0`, `gretap0` and `erspan0`. There were no v4 or v6 routes. [V]

| Probe group | Result |
|---|---|
| curl HTTPS and HTTP to `169.254.169.254` as dotted, decimal `2852039166`, hex `0xa9fea9fe`, octal `0251.0376.0251.0376`, `169.254.43518`, `[::ffff:169.254.169.254]`, `[::ffff:a9fe:a9fe]` | all `(7) couldn't connect` — PASS [V] |
| `api.github.com` by name / by IP `140.82.114.5` / via `--resolve` | `(6) could not resolve` / `(7)` — PASS [V] |
| `github.int.exe.xyz`, `llm.int.exe.xyz` by name and via `--resolve` to the edge IP | `(6)` / `(7)` — PASS [V] |
| `10.42.0.1` (:80, :443, :53 tcp/udp), `10.42.0.42`, `172.17.0.1`, npm IPv4 and IPv6 | `(7)` / `ENETUNREACH` — PASS [V] |
| Host-loopback listeners `127.0.0.1:9999`, `:32849` | refused, because the netns has its own `lo` — PASS [V] |
| Every URL again with `HTTPS_PROXY`, `ALL_PROXY` (http and socks5h), `http_proxy` pointing at the edge, `10.42.0.1:3128` or host loopback, and with all four set at once | all fail connecting to the proxy — PASS [V] |
| Python raw TCP (inet_aton spellings, `::ffff:`, names), UDP `sendto` to `:53` | `ENETUNREACH` / `EAI_AGAIN` — PASS [V] |
| DNS: `getent`, `getaddrinfo`, `dig` (resolv.conf, `@169.254.169.254`, `@10.42.0.1`, `@8.8.8.8`, `@1.1.1.1`, UDP and TCP) | all fail with "network unreachable" or no answer — PASS [V] |
| ICMP ping | `SOCK_RAW` not permitted — PASS [V] |

Totals: **238 probes; 238 failed as expected; 0 reached anything.** [V]
- Cosmetic gap: `awk` was missing inside the sandbox, because it is an `/etc/alternatives` symlink. That only broke one `/proc/net/dev` listing, and `ip -br addr` covered the same ground. Exp 3 binds `/etc/alternatives`.
- Abstract unix sockets were not probed directly, because the host had none listening. **[I]** They are netns-scoped, so `--unshare-net` isolates them.

## Experiment 3: gateway over a unix socket (`gateway.py`, `fixture.py`, `exp3-gateway.log`, `exp3b-completion.log`)

**Setup.** [V]
- `gateway.py` runs on the host, outside the sandbox, and listens on `/home/exedev/f05-proto/gw/gw.sock` (mode `srwx------`).
- The sandbox runs `bwrap --unshare-all` inside `systemd-run --user --scope -p MemoryMax=512M -p TasksMax=64`.
- Only the socket file is bind-mounted, at `/run/gw.sock`.
- In the sandbox, `socat` forwards `127.0.0.1:18080` to `/run/gw.sock`.

**Gateway policy.** It routes by path prefix only and opens a fresh upstream connection for every request.
- Host and SNI are fixed per route.
- Only `Accept` and `Content-Type` are copied from the client. The gateway sets `User-Agent`, `Accept-Encoding: identity` and `Connection`.
- It answers 403 on any of these:
  - a non-local client Host
  - any `X-Forwarded-*`, `Forwarded`, `X-Original-*`, `X-Host`, `X-Rewrite-URL` or `Proxy-*` header
  - a non-origin-form target
  - CONNECT
  - a dot segment or encoded traversal, `//` or a backslash
  - an unknown route or method
- It has no redirect logic. `http.client` cannot follow redirects.

| Probe (from inside the sandbox) | Expected | Got |
|---|---|---|
| `GET /openai/v1/models` | 200 | 200 — PASS [V] |
| `GET /xai/v1/models` | 200 | 200 — PASS [V] |
| `GET /npm/is-number/7.0.0`, `HEAD /npm/is-number`, a missing package (404 passthrough) | 200/200/404 | PASS [V] |
| `is-number-7.0.0.tgz` through `/npm/`: sha512 against the packument `integrity` | match | match — PASS [V] |
| `/anthropic/v1/models`, `POST /anthropic/v1/messages`, `/zen`, `/`, `/github/zen`, `/openai/v2/models`, `/openai/models` | 403 | 403 "no route" — PASS [V] |
| `/openai/v1/../../zen`, `%2e%2e`, `%2E%2E%2F`, `/npm/../zen`, `%252e`, `//github.int.exe.xyz/zen`, `/openai/v1//github…`, `%5c..%5c` | 403 | 403 — PASS [V] |
| Forged `Host: github.int.exe.xyz` (on `/openai/v1/models` and `/zen`), `Host: llm.int.exe.xyz` | 403 | 403 — PASS [V] |
| `X-Forwarded-Host`, `Forwarded: host=`, `X-Original-URL` naming github | 403 | 403 — PASS [V] |
| Absolute URL `--request-target https://github.int.exe.xyz/...`; proxy-style `GET http://github…`; `CONNECT github.int.exe.xyz:443`; `CONNECT api.github.com:443` | 403 | 403 — PASS [V] |
| `POST /npm/...`, `DELETE /openai/v1/models` | 403 | 403 — PASS [V] |
| Upstream 302 → `https://github.int.exe.xyz/zen` and → `https://api.github.com/zen` (fixture) | passed back, not followed | 302 with Location intact, `followed=0`, one upstream request each — PASS [V] |
| Client `curl -L` follows that 302 | must fail in the sandbox | `(6) could not resolve github.int.exe.xyz` — PASS [V] |
| Client `-L` follows a relative 302 | back through the gateway | 200 — PASS [V] |
| Direct `https://github.int.exe.xyz`, `https://169.254.169.254` | fail | `(6)`/`(7)` — PASS [V] |
| Tiny completion on `gpt-6.1-sol` | 200 | see below — PASS [V] |

Gateway log analysis for the main run: 41 requests, 13 forwarded, 28 denied, 0 errors. [V]
- **Every** forwarded record carries `host_header_sent` and `sni_sent`. The SNI is read from `SSLSocket.server_hostname` after the handshake.
- Upstream pairs actually sent:
  - `Host=llm.int.exe.xyz SNI=llm.int.exe.xyz → 169.254.169.254`
  - `Host=registry.npmjs.org SNI=registry.npmjs.org → 104.16.x.34`
  - the fixture (plain HTTP on 127.0.0.1)
- No upstream Host or SNI named GitHub.
- No denied record has an upstream.
- The gateway made one upstream request per redirect, with no follow-up.

**Completion.**
- The successful call was `POST /openai/v1/responses`, `{"model":"gpt-6.1-sol", "input":[…"Reply with exactly: OK"], "max_output_tokens":16, "stream":true, "store":false}`. It returned 200 over SSE, with `status: completed` and text `"OK"`. Usage: 11 input + 5 output = 16 tokens. [V] (`exp3b-completion.log`)
- Its gateway log line records `host_header_sent=llm.int.exe.xyz`, `sni_sent=llm.int.exe.xyz`, TLS 1.3, peer `169.254.169.254` and the cert SAN `*.int.exe.xyz`. [V]
- **Deviation, disclosed.** Getting to that call took 4 earlier POSTs, each rejected with 400 before any generation. All are kept as logs.
  1. `POST /openai/v1/chat/completions` with model `gpt-6.1-sol`. 400: "not in this exe.dev integration's model list". In `exp3-gateway.run1-harness-bugs.log`. (The run-2 log sent nothing upstream.)
  2. The same call with `openai/gpt-6.1-sol`. Same 400. In the main `exp3-gateway.log`.
  3. Responses API with string `input`. 400: "Input must be a list". In `exp3b-completion.attempt1-input-shape.log`.
  4. Responses API without `stream`. 400: "Stream must be set to true". In `exp3b-completion.attempt2-stream-required.log`.
- Exactly one request generated tokens, and none exceeded 16 output tokens.
- The chat-completions endpoint does not accept this model through exe.dev. The Responses API, which Pi's openai provider uses, does. **[I]** from the 400 text.

**Harness runs that were discarded but kept.**
- `exp3-gateway.run1-harness-bugs.log`: curl reported CONNECT 403 as `000`, and the probes expected 000 where curl reports the last hop's 302.
- `exp3-gateway.run2-socket-race.log`: a stale socket inode was bind-mounted before the gateway re-bound, so every request got "connection refused". Fixed by recreating `gw/` and waiting for the gateway's "listening" line.
- Neither run sent anything to GitHub.

## What was not run, or is weaker than asked

- **A real upstream 3xx.** No allowed real upstream returned a 3xx to a harmless GET. I checked about 40 npm paths. The `llm` scope allowed only the models paths. The redirect test therefore used a host-side fixture behind a prototype-only `/__fixture/` route. [V] for the gateway behaviour. [I] that real upstream redirects behave the same: `http.client` has no follow logic.
- **The GitHub backend body.** The GitHub integration answers every probed path with its repo-scope 403. It never returned real API content, so "reached GitHub" means "reached the GitHub integration backend". It is fingerprinted by body and trace count. [V]
- **Paths on `llm` other than the models paths.** Not probed (scope limit). Whether some `llm` path proxies to GitHub stays [I] "no".
- **Authenticated or mutating calls to GitHub.** Not run, by design. That integrations answer any VM process stays [I] (walkthrough §2).
- **The gateway is a prototype.** It has no budget gate, no streaming passthrough (it buffers the response) and no hardening review. Pi, npm-the-client and Herdr were not run through it; that is experiments 4, 5 and 9.

## Files

- **Experiment 1:** `exp1-edge-routing.log`, `exp1-table.txt`, `exp1_probe.py`, `exp1_h2.mjs`, `exp1_curl.sh`, `exp1_table.py`.
- **Experiment 2:** `exp2-netns-bypass.log`, `exp2_inside.sh`.
- **Experiment 3:**
  - `exp3-gateway.log` (main), `exp3b-completion.log` (completion), plus the 4 discarded or attempt logs.
  - `gateway.py`, `fixture.py`, `exp3_inside.sh`, `exp3b_inside.sh`.
- **Runners:** `run_exp1.sh`, `run_exp2.sh`, `run_exp3.sh`, and `ship.sh` (local; tars the scripts over ssh).
- **Cleanup:** `vm-cleanup.log` records the sha256 of every script as it was on the VM; they match the local files. It also records that the scratch dir was removed and that no `gateway`, `fixture`, `socat`, `bwrap` or `f05*` processes, user units or listeners remain.
