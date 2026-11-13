# F05 runtime prototype: experiments 4–10 on `pi-factorio`

Date 2026-10-29, 15:14–15:37 UTC. Scratch dir `/home/exedev/f05-proto2/`, deleted afterwards (`vm-cleanup.log`).
Tags: **[V]** = verified in the cited log or `raw/` file. **[I]** = inferred.

The setup reuses the R1 gateway, extended in `gateway.py` with a budget gate, usage logging, a fake-upstream route and a safety auto-gate. It also reuses the R1 bwrap and `socat` forwarder layout. Every sandbox ran as `systemd-run --user --scope -p MemoryMax=512M -p TasksMax=… -- env -i bwrap --unshare-all --die-with-parent …` with:
- ro `/usr`, Node, npm Pi, Herdr and the standalone Pi bound under `/opt`
- a synthetic `/etc/{passwd,group,hosts,resolv.conf}`
- a tmpfs `HOME`
- the workspace at `/work`
- only `/run/gw.sock` as egress

## Verdicts

| # | Experiment | Verdict |
|---|---|---|
| 4 | Pi RPC inside the sandbox (npm and standalone) | **PASS** |
| 5 | Real Herdr fan-out inside the sandbox (lane 7) | **PASS** |
| 6 | Limits and cleanup (lanes 9, 10) | **PASS**, NNP part partial (see 6d) |
| 7 | Budget gate (lane 8) | **PASS** |
| 8 | Refusal surface | **PASS** for the fake-upstream shapes. No live refusal occurred, so live shape is INCONCLUSIVE |
| 9 | npm through the gateway (lane 3) | **PASS** |
| 10 | Mount denial (lane 6) | **PASS**, after one fix: start bwrap under `env -i` |

**Tokens spent: 12,234 real `openai/gpt-6.1-sol` tokens in 12 upstream calls, against a 20,000 cap.** There were no xAI calls of any kind and no GitHub requests. Breakdown, all from gateway-logged upstream `usage.total_tokens` **[V]**:

| Run | Calls | Tokens |
|---|---|---|
| exp4 npm + standalone | 2 | 803 (415 + 388) |
| exp8 attempt 2 (harness bug, see below) | 5 | 2,099 |
| exp7 A | 1 | 700 |
| exp5 parent ×3 + child ×1 | 4 | 8,632 |

Every other run made 0 real calls.

---

## Exp 4: Pi RPC in the sandbox (`exp4-pi-rpc.log`, `raw/exp4-*`)

Flags: `pi --mode rpc --no-session --no-mcp --no-approve --no-context-files --no-skills --tools subagent --model openai/gpt-6.1-sol --thinking low`.

The clean `PI_CODING_AGENT_DIR` contains only `models.json`, set to `{"providers":{"openai":{"baseUrl":"http://127.0.0.1:18080/openai/v1","apiKey":"sandbox-placeholder-not-a-key"}}}`, plus `settings.json`. Env sets `PI_OFFLINE=1`, `PI_SKIP_VERSION_CHECK=1` and `PI_TELEMETRY=0`.

- **The `http://` baseUrl works.** The gateway logged `POST /openai/v1/responses`, forwarded with `Host=SNI=llm.int.exe.xyz`, status 200 and reply `"OK"`. **[V]**
- **A read-only agent dir breaks prompting** (attempt 1, `exp4-pi-rpc.attempt1-ro-agent-dir.log`). **[V]**
  - `get_state` works.
  - `prompt` is rejected with `success:false` and `"Credential store read failed for openai: EROFS: read-only file system, open '/opt/agent/auth.json'"`.
  - stderr warns: `Invalid settings file … EROFS … mkdir settings.json.lock`.
  - With a writable copy, Pi wrote `auth.json` and `models-store.json` (2 bytes each).
  - **Brief:** the asset bundle can be ro, but the stage needs a per-stage writable copy of the agent dir, or at least of its writable files. Herdr children also write sessions under `<agentDir>/sessions/` (exp 5).
- **Event order for one prompt** (npm and standalone are identical) **[V]**:
  `response:get_state` → `response:prompt{disposition:"started"}` → `agent_start` → `turn_start` → `message_start/end(system)` → `message_start/end(user)` → `message_start(assistant)` → `message_update×3` → `message_end(assistant)` → `turn_end` → `agent_end` → `agent_settled`.
- **The `agent_settled` payload** is exactly `{"type":"agent_settled","aborted":false}` **[V]**. It carries no stop reason, so the runner must read the last assistant `message_end`.
- **The assistant `message_end.message`** **[V]**:
  - keys: `api, content, durationMs, model, provider, providerThinkingLevel, rawStopReason, responseId, role, stopReason, thinkingLevel, timestamp, usage`, plus `errorMessage` on error
  - success values: `stopReason:"stop"`, `rawStopReason:"completed"`
- **Usage fields:** `{input, output, cacheRead, cacheWrite, reasoning, totalTokens, cost:{input,output,cacheRead,cacheWrite,total}}`. npm: 410 in + 5 out = 415. **[V]**
- **`get_session_stats` fields:** `sessionId, userMessages, assistantMessages, toolCalls, toolResults, totalMessages, tokens{input,output,cacheRead,cacheWrite,total}, cost, contextUsage{tokens,contextWindow,percent}`. `sessionFile` is absent under `--no-session`. **[V]**
- **`--tools subagent` without the extension installed:** no error and no warning. The model got no tools (`<tools> (none)` in the system prompt). **[V]**
- **The request always carried `reasoning:{effort:"medium",summary:"auto"}`**, even though `--thinking low` and `providerThinkingLevel:"low"` were set. **[V]** from the gateway log. Why is **[I]**; possibly the effort is sent mid-conversation (`supportsMidConvoEffort`). Worth checking before relying on thinking level for cost.
- **The standalone binary `~/.local/pi/pi` with a clean HOME works** for the built-in `openai` provider. Reply `"OK"`, 388 tokens, the same event order and fields. **[V]** The Herdr-prototype failure was specific to the custom `cliproxyapi` provider **[I]**, which matches that doc's own diagnosis.

**Timings [V]:**

| Measurement | npm | standalone |
|---|---|---|
| spawn → `get_state` response (systemd-run + bwrap + forwarder + Pi start) | 0.52 s | 0.45 s |
| prompt → final `message_end` | 2.2 s | 3.4 s |
| stdin close → exit | 31 ms | 16 ms |
| scope after exit | `inactive` | `inactive` |

## Exp 5: real Herdr fan-out in the sandbox (`exp5-herdr-fanout.log`, `raw/ws-exp5/`, `raw/exp5-gw.jsonl`)

Headless `herdr --session f05 server` ran inside bwrap. `--dev` gives a fresh devpts, and panes got PTYs. **[V]** Pi used `pi-herdr-agents@3.3.1` with an RPC parent in a pane and one bare `subagent` child (`fork:false`, `tools:read`).

- **Startup [V]:**
  - Herdr server ready in 0.32 s; workspace in 0.38 s.
  - Parent Pi with the extension: 1.36 s to `response:prompt`.
  - Whole stage, including the model calls: 11.3 s.
  - `herdr server stop`: 0.26 s, leaving no Pi or Herdr processes.
- **Parent event order** (t = seconds since parent start) **[V]**:
  ```
  1.36 response:prompt, agent_start, turn_start, system, user
  3.96 message_end(assistant)         ← tool call
  3.96 tool_execution_start(subagent) 4.10 tool_execution_end(subagent)  ← returns at once ("launched … running in the background")
  4.11 toolResult, turn_end, turn_start
  7.07 message_end(assistant), turn_end, agent_end
  7.07 agent_settled {aborted:false}                ← FIRST settle, child still running
  7.91 extension_ui_request {method:"setWidget", widgetKey:"subagent-status"}  (fire-and-forget)
  8.00 agent_start, turn_start, message_start/end(customType:"subagent_result")
 10.39 message_end(assistant "herdr-parent-received"), turn_end, agent_end
 10.39 agent_settled {aborted:false}                ← settle after the result
  ```
- **Order confirmed:** the parent's first `agent_settled` (7.07) precedes `subagent_result` (8.00). The result starts a new run (`agent_start`) that ends in a second `agent_settled`. **[V]**
- **Settle predicate for the brief:** `launched == results` (count `tool_execution_end` with `toolName:"subagent"`, not error, against `message_end` with `message.customType=="subagent_result"`), **and** an `agent_settled` after the last `subagent_result`, **and** no queued prompt. **[V]** for one child. Behaviour with several children is **[I]**.
- **The child's traffic went through the gateway.** There were 4 upstream calls. 3 carried the parent marker; the 4th was the child's (1,052 tokens), sent at t=4.78 to `Host=SNI=llm.int.exe.xyz`. **[V]** No request bypassed the gateway, since the sandbox has no other route (exp 10 / R1).
- **Child usage from `details.sessionFile`:**
  - One assistant message on `openai/gpt-6.1-sol`: input 1032, output 20, reasoning 10, totalTokens 1052. Final text `herdr-child-ok`. **[V]**
  - `subagent_result.details` keys are `elapsed, exitCode, fallbackAttempts, fallbackFailures, name, resultContent, runtimePlan, sessionFile, task`. There is **no usage field.** **[V]**
  - The parent's `get_session_stats` total is 7,580, which **excludes the child**. The gateway total is 8,632 = 7,580 + 1,052. **[V]**
  - So the runner must add child session-file usage, or use the gateway's per-stage tally.
- **Parent silent period:**
  - The longest gap between parent records while the child existed was 2.96 s, but that was the parent waiting on its own second model call. The child ran concurrently.
  - After the parent settled, it stayed silent for 0.93 s until the result. The only record in that window was one `setWidget` at +0.84 s.
  - The child ran about 3.9 s, from launch at 4.10 to result at 8.00. **[V]**
  - **[I]** For a long child, the parent is silent for roughly the child's duration. Whether `setWidget` repeats as a heartbeat is not shown, so gotcha 9 (stall vs long child) stands.
- **How the child is launched** (`raw/ws-exp5/parent-sessions/artifacts/*/subagent-scripts/*.sh`) **[V]**:
  ```
  pi --session <agentDir>/sessions/... -e <ext>/subagent-done.ts --model openai/gpt-6.1-sol --thinking low --tools read,caller_ping @<context.md>
  ```
  - `pi` comes from PATH.
  - It carries **none** of the parent's `--no-context-files/--no-skills/--no-mcp/--no-approve` flags.
  - It inherits `PI_CODING_AGENT_DIR` from the pane env.
  - **Brief:** children load whatever context files, skills and MCP config the agent dir and workspace contain, so the asset agent dir and workspace must be clean. Pin a single `pi` on PATH.
- **Herdr runs an update check.** The server spawned `curl … https://herdr.dev/latest.json` (exp6 process list). In the sandbox it has no route and fails harmlessly. **[V]** Running Herdr on the host would leak that request. **[I]**

## Exp 6: limits and cleanup (`exp6-limits-cleanup.log`, `raw/ws-exp6/`)

The launcher context was cgroup `0::/init.scope`, with 0 logind sessions and no `XDG_SESSION_ID` or `DBUS_SESSION_BUS_ADDRESS`. The user manager was running, with `cpu memory pids` delegated. **[V]**

- **6a: two concurrent scopes** with `MemoryMax=512M` and `TasksMax=64`. **[V]**
  - **A** allocated in 64 MiB steps and was OOM-killed at about 512 MiB (`allocated 448 MiB` was its last line).
    - Kernel: `Memory cgroup out of memory … oom_memcg=…/f05-proto-exp6-a.scope`.
    - systemd: `Failed with result 'oom-kill'`.
    - systemd then stopped the rest of the scope (default OOM policy), so the launcher saw exit 143.
  - **B** was active throughout, with `memory.events oom 0 oom_kill 0`. In attempt 1 its process printed `B-ALIVE-AFTER-A`.
  - **TasksMax:** B's fork loop hit the cap (`pids.events max 2`, `pids.peak=64`, bash `fork: retry: Resource temporarily unavailable`), and B's own bash then gave up (exit 254).
  - **Brief:** read the scope `Result` (`oom-kill`) to classify the failure.
- **6b: named stop.** The scope `f05-proto-exp6-stop` held 12 processes, including:
  - bwrap ×2, `herdr server`, `pi` in a pane (`sleep | pi --mode rpc`)
  - a pane child that ignores SIGTERM (`trap "" TERM; sleep 1000`)
  - Herdr's update-check `curl`
  - `systemctl --user stop` returned in **24 ms**. All 12 PIDs were gone, the scope was `inactive` and the cgroup dir was removed. **[V]**
  - **[I]** The TERM-ignoring child died at once because killing bwrap (pid 1 of the sandbox pid namespace) SIGKILLs the whole namespace, so `TimeoutStopSec` was never reached.
- **6c: survival of the launcher's death.** The launcher (stand-in for the controller) was SIGKILLed. **[V]**
  - **Without** `--die-with-parent`: the scope stays `active running` and is found by name via `systemctl --user list-units 'f05-proto-exp6-surv-*'`. Stopping it by name took 23 ms.
  - **With** `--die-with-parent`: the sandbox dies with the launcher and the scope goes `inactive` by itself.
  - **Brief:** choose deliberately.
    - `--die-with-parent` makes a controller crash clean up automatically, but kills stages on a controller restart.
    - Without it, stages survive, and the startup reconcile must find `factory-stage-*` scopes by name and stop them.
  - Attempt 1's 6c is void: its argument filtering left an empty argv entry, so bwrap failed to start.
- **6d: a `factory.service`-like launcher**, run as `env -i PATH=… XDG_RUNTIME_DIR=/run/user/1000 setpriv --no-new-privs --` from init.scope with no login session. **[V]**
  - The launcher showed `NoNewPrivs=1`.
  - `systemd-run --user --scope` worked. The scope applied `memory.max=536870912` and `pids.max=64`, and the process inside it kept `NoNewPrivs=1`.
  - The same launcher **without** `XDG_RUNTIME_DIR` fails: `Failed to connect to bus: No medium found` (exit 1).
  - The NNP launcher can `systemctl --user stop` a scope by name (exit 0).
  - **Not tested:** a real system unit, because installing a unit is forbidden. **[I]** It behaves the same: the user bus authenticates by uid, and this launcher already had no session or DBUS variables. So `factory.service` needs `Environment=XDG_RUNTIME_DIR=/run/user/1000`, and `DBUS_SESSION_BUS_ADDRESS` is not needed. **[V]** for the mimic.

**Cleanup times [V]:**

| Action | Time |
|---|---|
| named scope stop (Pi + Herdr + children) | 24 ms |
| orphan scope stop by name | 19–23 ms |
| Pi exit after stdin close | 16–32 ms |
| Herdr server stop | 0.26 s |

## Exp 7: budget gate (`exp7-budget-gate.log`, `raw/exp7-*`)

The gateway gate is a control file. While it exists, every `/openai|/xai` request is answered by the gateway (status and body from the file) with **no upstream connection**, logged as `decision:"gated"`.

**A: tiny cap (any usage), closed mid-stage, retryable 429 body. [V]**

| t (s) | Event |
|---|---|
| 3.458 | first assistant `message_end` (`toolUse`, 700 tokens) |
| 3.459 | runner closes the gate |
| | Pi runs the `read` tool and makes its next request: **gated** 10 ms after the close |
| | `stopReason:"error"`, `errorMessage:"OpenAI API error (429): {\"message\":\"f05 budget gate closed: admission denied\",…}"` |
| 3.473 | `auto_retry_start{attempt:1,maxAttempts:3,delayMs:2000}` |
| +2.0 | retry → **gated** |
| 5.490 | `auto_retry_start{attempt:2}`; runner sends `abort` at the same moment |
| | `auto_retry_end{success:false,finalError:"Retry cancelled"}` |
| 5.492 | `agent_settled{aborted:true}` |

- Gateway: 1 forwarded and 2 gated. **0 forwarded requests after the first gated record.** **[V]**
- Pi's HTTP client did no hidden SDK retries: one gated request per Pi attempt, spaced by Pi's 2 s backoff. **[V]**
- **Settle within the reserve:** abort → `agent_settled` took **2 ms**, stdin close → exit 32 ms, and the scope was `inactive`. That is far inside a 10 s reserve. **[V]**

**B: gate closed before the stage, body containing `out of budget`. [V]**
- `errorMessage:"OpenAI API error (429): {…\"f05 budget gate closed: out of budget\"…}"`
- **no auto-retry**; `agent_settled{aborted:false}` 46 ms after the prompt
- 1 gated request, 0 upstream

**Brief:**
- Pi's non-retryable pattern includes `out of budget` and `quota exceeded` (from the binary's `NON_RETRYABLE_PROVIDER_LIMIT_ERROR_PATTERN`; **[V]** behaviourally here). Put that phrase in the gate body so Pi stops by itself.
- The gate itself, not the body, is what guarantees "no further request".
- `agent_settled.aborted` is `true` only for a runner abort.

## Exp 8: refusal surface (`exp8-refusal-surface.log`, `raw/exp8-*`)

No natural refusal occurred, and none was provoked. A host-side fake Responses upstream (`fakeup.py`) sat behind the gateway's `--fake-openai-port` route, with one fresh npm Pi per scenario. **[V]** for every row:

| Upstream shape | `stopReason` | `rawStopReason` | `errorMessage` | auto-retry? |
|---|---|---|---|---|
| SSE `response.incomplete`, `incomplete_details.reason:"content_filter"` | `error` | `incomplete.content_filter` | `Response incomplete: content_filter` | no (1 request) |
| SSE `response.failed`, `error:{code:"content_filter",message:…}` | `error` | `failed` | `content_filter: The response was filtered due to …` | no (1) |
| SSE completed message with a Responses **`refusal` content part** | **`stop`** | **`completed`** | none | no (1) |
| HTTP 400 `{"error":{code:"content_policy_violation",message:"…safety system."}}` | `error` | absent | `OpenAI API error (400): {"message":"Your request was rejected as a result of our safety system.","type":"invalid_request_error","param":null,"code":"content_policy_violation"}` | no (1) |
| HTTP 500 server_error (control) | `error` | absent | `OpenAI API error (500): {…}` | **yes**: 3 retries at 2/4/8 s, 4 requests, settled at 14.6 s |

- **A Responses `refusal` part is invisible to structured classification.** Pi folds the refusal text into an ordinary text block (`"I can't help with that."`) with `stopReason:"stop"`. **[V]** C6 option (a) cannot detect it; such a stage would "pass" with refusal text.
- **The refusal-shaped errors were not retried**, because their messages do not match Pi's retry pattern. **[V]**
- **[I]** That pattern also matches any bare `429|500|502|503|504|520|524` token and words like `timeout`, `internal error` and `server error`. A provider refusal message containing those would be retried up to 3 times.
- **Classifier inputs for the brief:**
  - `rawStopReason == "incomplete.content_filter"`, or
  - `rawStopReason == "failed"` with `errorMessage` starting `content_filter:`, or
  - `errorMessage` starting `OpenAI API error (400):` whose JSON has `code` `content_policy_violation` or `content_filter`
  - plus a decision on refusal parts, which need Pi changes or text heuristics.
- **[I]** These shapes are the documented OpenAI ones. What exe.dev's `llm` edge actually returns for a refusal stays unknown.
- **Disclosed harness bug (attempt 2, `exp8-refusal-surface.attempt2-fake-route-bug-REAL-TOKENS.log`):**
  - The fake route was checked after the real `/openai/v1/` route, so 5 "hi" prompts went to the **real** model: 2,099 tokens, normal replies.
  - Fixed by checking fake mode first and disabling real model routes in that mode.
  - Attempt 1 (ro agent dir) sent nothing.

## Exp 9: npm through the gateway (`exp9-npm-gateway.log`, `raw/exp9-gw.jsonl`, `raw/ws-exp9/`)

Ran `npm 11.20.0 install --ignore-scripts --no-audit --no-fund is-number@7.0.0` in the sandbox with `.npmrc registry=http://127.0.0.1:18080/npm/`. rc=0 in 0.5 s, and `require("is-number")(5)` returned true. **[V]**

- **npm requests (`--loglevel http`), all through the prefix:**
  - `GET /npm/is-number`
  - `GET /npm/npm` (update-notifier)
  - `GET /npm/is-number/-/is-number-7.0.0.tgz`
- **Gateway:** 3 requests, all forwarded to `Host=SNI=registry.npmjs.org`. No other upstream, and no denials. **[V]**
- **The tarball rewrite is confirmed.** npm's `replace-registry-host` defaults to `npmjs`. The lockfile keeps the canonical `resolved: https://registry.npmjs.org/is-number/-/is-number-7.0.0.tgz` with its sha512 integrity, but the fetch went to `http://127.0.0.1:18080/npm/is-number/-/is-number-7.0.0.tgz`. **[V]**
- **No other host was contacted.** npm's logs name one non-prefix URL, `https://github.com/npm/cli/releases/tag/v12.2.1`, but only inside the printed "new major version" notice. It was not fetched, and the sandbox has no route anyway. **[V]**
- **Recommendation:** set `update-notifier=false` in the sandbox `.npmrc`.

## Exp 10: mount denial (`exp10-mount-denial.log`, `exp10_inside.sh`)

36/36 checks pass **[V]**:
- **Absent:** `/home`, `/home/exedev`, `~/.pi`, `~/.pi/agent/models.json`, `~/.config/gh`, `~/.ssh`, the mise dir, the scratch dir, `~/factory-state`, `~/factory-workspaces`, other experiment workspaces, the agent dir, `/var/run/docker.sock`, `/run/docker.sock`, `/run/user/1000` and its `bus`, `/run/systemd`, `/root`, `/etc/shadow`, `/etc/sudoers`, `/var/lib` and `/var/log`.
- **Sockets and env:** the only unix socket is `/run/gw.sock`. `SSH_AUTH_SOCK` is unset (it is also unset on the VM's ssh exec).
- **Processes:** the sandbox sees 5 PIDs. `/proc/1` is bwrap, and no host process is visible.
- **Name resolution:** `/etc/hosts` holds only `localhost`, and `/etc/resolv.conf` has no nameserver. `getent ahosts` and Python `getaddrinfo` resolve none of `api.github.com`, `github.com`, `github.int.exe.xyz`, `llm.int.exe.xyz`, `registry.npmjs.org`, `pi-factorio`, `pi-factorio.exe.xyz` or `metadata.google.internal`.

**Finding (attempt 1, `exp10-mount-denial.attempt1-bwrap-environ.log`): `/proc/1/environ` leaks the launcher's environment.** **[V]** bwrap is pid 1 in the sandbox, and its `/proc/1/environ` is **readable from inside**. `--clearenv` cleans only the child, so the sandbox could read the *launcher's* environment. Attempt 1 matched a launcher variable in it.
- **Fix:** start bwrap under `env -i PATH=/usr/bin:/bin`. `/proc/1/environ` then holds only `PATH`. **[V]**
- **[I]** This is critical for the controller: anything in `factory.service`'s environment, such as tokens or socket paths, would be readable by the model.

## Facts the F05 brief must encode

1. **Event order and settlement:**
   - `prompt` response → `agent_start` … `agent_end` → `agent_settled{aborted}`.
   - `agent_settled` has no outcome. Read the last assistant `message_end` (`stopReason`, `rawStopReason`, `errorMessage`, `usage`).
   - Auto-retry runs between `agent_end` and `agent_settled` (`auto_retry_start`/`auto_retry_end`, each attempt a new `agent_start`). **[V]**
2. **Settle predicate with children:** subagent launches == `subagent_result` messages, an `agent_settled` after the last result, and no queued prompt. The parent's first `agent_settled` comes *before* the child result. **[V]**
3. **Usage:**
   - Parent: `message_end.usage.totalTokens` and `get_session_stats.tokens.total`.
   - Children: read `details.sessionFile`. Child usage is **not** in the parent stats or in `subagent_result.details`.
   - The gateway's per-stage tally equals parent + child. **[V]**
4. **Budget gate:**
   - Gateway admission control. Closing it stopped every further upstream request, including Pi's auto-retries.
   - Abort → settle takes ms.
   - A gate body containing `out of budget` makes Pi skip its retries. **[V]**
5. **Refusal fields:** see the exp 8 table. **[V]** against fake upstream shapes; the live exe.dev shape is **[I]**. A Responses `refusal` part arrives as `stopReason:"stop"` text and is undetectable structurally. **[V]**
6. **Scopes under NNP:**
   - `setpriv --no-new-privs` with only `XDG_RUNTIME_DIR` set and no login session can create, limit and stop `--user --scope` units. Without `XDG_RUNTIME_DIR` it fails. **[V]**
   - A real system unit is **[I]**.
   - OOM is contained to its scope, and systemd stops that scope with `Result=oom-kill`.
   - A named stop kills Pi, Herdr and all pane children in about 25 ms.
   - Scopes survive launcher death unless bwrap uses `--die-with-parent`. **[V]**
7. **npm:** registry `http://127.0.0.1:P/npm/` plus the default `replace-registry-host=npmjs` sends tarballs through the prefix, while the lockfile keeps canonical URLs and integrity. **[V]**
8. **Pi distribution:**
   - Both npm Pi 1.4.0 and the standalone ELF work in the sandbox with a clean HOME and the built-in `openai` provider over `http://`. **[V]**
   - Recommendation: **npm Pi 1.4.0 from a lockfile in the asset bundle.** It is readable JS that can be hashed per file, it is what `pi-herdr-agents` children find on PATH, and it avoids the custom-provider failure the Herdr prototype hit. **[I]**
   - Either way, exactly one `pi` must be on PATH, because children run `pi` by name. **[V]**
9. **Writable state:**
   - The agent dir must be writable: `auth.json`, `models-store.json`, `settings.json.lock` and child `sessions/`. **[V]**
   - Plan a per-stage copy (1.4 MB with `pi-herdr-agents`), or an overlay on the ro bundle. **[I]**
10. **Sandbox hygiene:**
    - Start bwrap under `env -i`. **[V]**
    - Give the sandbox its own `/etc/hosts` and `resolv.conf`. **[V]**
    - Children ignore the parent's `--no-context-files/--no-skills/--no-mcp`. **[V]**
    - Herdr runs an update-check `curl` (sandbox-contained). **[V]**
    - The `setWidget` extension UI request needs no reply. **[V]**

## Files

- **Logs:**
  - `setup.log`
  - `exp4-pi-rpc.log`, `exp5-herdr-fanout.log`, `exp6-limits-cleanup.log`, `exp7-budget-gate.log`, `exp8-refusal-surface.log`, `exp9-npm-gateway.log`, `exp10-mount-denial.log`
  - discarded attempts, kept: `exp4-…attempt1-ro-agent-dir`, `exp6-…attempt1-harness-hang`, `exp8-…attempt1-ro-agent-dir`, `exp8-…attempt2-fake-route-bug-REAL-TOKENS`, `exp10-…attempt1-bwrap-environ`
  - `vm-cleanup.log`
- **Raw evidence (`raw/`):**
  - RPC event logs and driver stderr
  - per-experiment gateway JSONL
  - exp5 parent and child sessions and the child launch script
  - exp6 outputs
  - exp9 npm output and lockfile
- **Scripts:**
  - `common.sh`, `setup.sh`, `ship.sh`, `vm_cleanup.sh`
  - `gateway.py`, `gwsummary.py`, `rpcdrive.py` (host-side RPC runner), `fakeup.py`, `sbx-entry.sh`
  - `run_exp{4..10}.sh`, `exp5_inside.sh`, `exp5_parent.py`, `exp9_inside.sh`, `exp10_inside.sh`
  - `vm-cleanup.log` records the sha256 of each script on the VM, and every hash matches the local file. Earlier attempts ran earlier revisions; the attempt logs describe what changed.

## Not done, or weaker than asked

- **A live refusal** was not observed or provoked. Exp 8 rests on fake upstream shapes plus the Pi source.
- **A real `factory.service` system unit** was not run (forbidden). The NNP part of exp 6 used a mimic.
- **More than one child**, a child running longer than `stall_ms`, and a repeating child heartbeat were not tested.
- **The `systemd-run --user` *service* variant** that might shed NNP (gotcha 5) was not tested: only scopes were allowed.
- **The host-side setup** (`npm install`, `pi install`) contacted the registry directly, as the task allowed. It was not logged at the network level, so "no GitHub contact during setup" is **[I]**: `pi-herdr-agents` has no dependencies, and all 121 Pi packages come from the registry.
