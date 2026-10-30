# Stage sandbox and egress gateway

Status. Built in F05 and proven live on `pi-factorio` on 2026-10-29. The design was accepted by the owner as walkthrough option C2(c) and settled by the F05 brief. Section 0 lists what the build changed from the design, and section 9 records how each open question was answered. The rest of this document is the design as it stands, with its evidence tags.

## 0. What was built, and where it departs from the design

**Running it.**
- `server/provision.sh` builds the asset bundle from pinned inputs and installs it root-owned and read-only at `/var/lib/factory-sandbox/assets-<sha256>/`, where the sha256 is the manifest digest from `server/sandbox/manifest.ts`. `/var/lib/factory-sandbox/current` names the bundle the controller uses. Run `bash server/provision.sh sandbox` from a checkout to build only the bundle. Rerunning it with the same inputs reproduces the same digest and changes nothing.
- The bundle holds Node 26.12.1 (pinned by tarball sha256), the npm Pi packages from `server/sandbox/assets/package-lock.json` (`npm ci --ignore-scripts`), Herdr 0.9.5 (pinned by sha256), the `pi` wrapper (`bin/pi` runs `sandbox/pi.ts`), `sandbox/stage-init.ts`, synthetic `etc/` files and a `pi-agent/` template. The template's `models.json` points `openai` and `xai` at `http://127.0.0.1:18080/{openai,xai}/v1` with a placeholder key. Its `settings.json` names the default provider and model, and no packages, because the wrapper's `--no-extensions` skips configured packages. The stage Pi loads no extensions. Neither `pi-herdr-agents` nor `pi-herdr-pstack` is needed by specify now; both remain pinned and installed in the bundle. This round leaves the provisioning installs and wrapper's legacy extension allowlist unchanged. From F06a the bundle also holds `skills/<name>/` for each committed skill in `skills/`, so the manifest digest covers the skill text.
- The controller installs `sandboxExecutor` from `server/sandbox.ts`. Each stage scope is `factory-stage-<owner>-<run16>-<stage>-<attempt>-<nonce>`, where `<owner>` is the first 8 hex of the sha256 of the state dir's real path. On startup the controller stops every leftover `factory-stage-<owner>-*` scope of its own by name, before the first tick adopts a run. Another controller's scopes, for example a scoped verification lane with its own state dir, are left alone. An old-format scope (`factory-stage-<run16>-<stage>-<attempt>-<nonce>`, from builds before the owner segment) is stopped only when its description, which `systemd-run` sets to the command it ran, binds a path under this state dir's `stages/` or `gw/`. Any other is logged `scope_unowned` and left running. The preflight (the startup scope reconcile, arch, userns, bwrap, assets digest, a scope launch, a gateway that comes up ready) runs on every tick until it passes. A reconcile that could not list or stop a scope fails the `reconcile` check, and each preflight retries it. No stage of this process can be running before the first pass, so a retry stops only leftovers. Until then every launch is `blocked` with `sandbox_unavailable`, and `executionEnabled` is `false`.
- F05 ran one fixed probe prompt per stage with no tools. From F06a the executor takes the prompt, the tool allowlist and the skill names from the launch, as in "What F06a adds" below. The receipt is `<stateDir>/stages/<runId>/<stage>-<attempt>/receipt.json`, mode 0600, beside `egress.jsonl` and each session's `pi-stderr-<session>.log` (the last 64 KiB of sandbox stderr, untrusted, referenced from the receipt by name and byte count only).

**What F06a adds.**
- **Per-stage prompt, tools and skills.** `StageLaunchInput` carries `prompt`, `tools` and `skills`. The specify draft gets only `read`, `grep` and `ls`; the controller-run reviewer and revision get no tools. It never gets `bash`, `write`, `edit` or `find`, because `find` needs `fd`, which the bundle does not ship. The executor reads each named skill's `SKILL.md` from the bundle on the host, drops its front matter and appends it to the prompt. A missing, oversized or misnamed skill refuses the launch as `sandbox_unavailable` and logs `skills_unavailable`.
- **Stage Pi flags.** `piCommand` adds `--no-skills` and `--system-prompt` with a one-line stage prompt. The second replaces Pi's default system prompt, its coding rules, docs pointers and the `subagent` routing guidelines, which every model request would otherwise resend. The stage argv no longer loads `-e pi-herdr-agents`, so that package's skill listing and delegation instructions do not enter the request. The specify prompt also forbids reading any `SKILL.md`.
- **Final text.** After a session settles, the runner sends Pi's RPC `get_last_assistant_text` and waits up to 5 s, inside the cleanup window, for the answer before it closes stdin, because Pi can exit before it answers a command sent after stdin ends. Only when the stage's outcome is `passed` does it write the text, at most 256 KiB, to `output.txt` beside the receipt with `publishFile`. The receipt's `output` names the file and gives `bytes` and `kept`, never the text. A budget-exhausted session can return complete-looking text, so text from any other outcome is dropped. `StageExecutor.output` returns the newest passing execution's kept text for an attempt, so a restart can finish a stage without running it again.
- **Checkout.** `StageExecutor.checkout` fetches the base commit's tarball with `gh api` on the host, with binary stdout, and extracts it into the workspace with unsafe entries refused (`checkoutWorkspace` in `server/controller.ts`). The workspace has no `.git`, so the sandbox mounts a read-only tmpfs there.
- **Controller review.** `StageExecutor.launch` owns the draft, one tool-less reviewer and at most one tool-less revision session, all inside one specify attempt. Session outputs and receipts are recorded before the next session starts. A restart reuses them; it never repeats a session with recorded output. An interrupted session without a receipt fails the attempt rather than launching a second reviewer. Each session's gateway receives only the remaining stage tokens, run tokens, turns and wall time. The attempt receipt sums their usage. Session subdirectories keep the model, egress and stderr details. Questions skip review.
- **What `read` can reach.** `read` and `grep` see the read-only bundle at `/opt/factory`, the workspace, the stage's writable agent dir `/run/pi-agent`, including its own session files under `/run/pi-agent/sessions`, and `/proc`. They can also read the host's read-only `/usr`, `/etc/ssl`, `/etc/alternatives`, `/etc/nsswitch.conf` and `/etc/ld.so.cache`, the bundle's synthetic `/etc` files, and the sandbox's initially empty `/tmp`; the mount table below is the full boundary, not the prompt's instruction to stay under `/workspace`. `/proc/1/cmdline` holds the full bwrap argv, with host paths such as the bundle dir, the run's host workspace and its stage dir. Neither holds a credential. The owner accepted both for F06a, and issue #425 tracks the `/proc` disclosure.

**What F06b adds.**
- Specify's stored contract now advances the same run to accept, with a reset attempt counter. Accept uses the ordinary single-session runner, so it has its own new agent directory, session, gateway and scope; no specify history is copied. Only `read`, `grep` and `ls` are granted. The controller reads back and digest-checks the contract and uses the trusted base tarball; the prompt contains only contract behavioral fields, the base map and named files, not the issue or a candidate.
- The acceptance skill is bundled by the existing `skills/*/` provisioning loop and inlined host-side. Re-provision after changing it. The short system prompt and existing forced Pi flags remain unchanged.
- Model output is JSON data, not file-system extraction. The controller validates coverage, paths, types, sizes and the complete manifest before writing any suite bytes. No acceptance code executes here. Private suite, manifest, canary and receipt files live under `<state-dir>/acceptance/`, never a workspace or agent dir. Recovery reuses matching exact bytes and fails closed on missing/changed bytes, without regenerating. `docs/operations/factory-cli.md` defines the byte order, schema and typed reasons.
- Public summaries list only scenario IDs and criterion mappings, with `context-isolated, same family, not cross-family`. No independence claim is made. The pre-build canary prototype is `docs/prototypes/acceptance-isolation/`; it does not settle F07c's post-publication repair boundary.

**What F07a adds.**
- A stored accept suite advances the same run to build. The controller extracts a separate pinned base at `<state>/pristine/<runId>` and copies it into a fresh sibling workspace `<runId>-build-<attempt>`. Only that copy is mounted. The pristine tree, acceptance store, previous agent directories and controller checkout stay outside every mount. Base symlinks are omitted, counted and logged together with Unicode-format paths. They are absent from both diff sides, so omission never becomes a spurious deletion. A base containing symlinks is not a faithful full Git checkout; this repository has none.
- The builder gets `read,grep,ls,bash,edit,write`, a digest-checked behavioral contract, trusted base build guidance, named files and the applicable bundled pstack Feature or Bug fix playbook. Tiny tasks never fan out. Contracts naming more than eight files may use Herdr leaf delegation; the root remains responsible and must settle all children. No stage gains a GitHub route. Build has a 50,000-token attempt ceiling in addition to the workflow and cumulative run limits.
- After Pi settlement and sandbox cleanup, the host snapshots both trees without following links. It rejects unsafe paths, specials and escaping or cyclic symlink chains. Only `node_modules` dependency caches and an empty masked root `.git` are excluded. It creates a deterministic binary Git diff, representing renames as deletion plus addition and preserving executable modes and symlinks. The controller checks both sides against forbidden paths before accepting it. `.github/` work stays private and ends failed with an owner reference, never a publication.
- The host applies those exact bytes to a new copy of the pristine tree and launches a separate, model-free test sandbox. Its gateway has only the read-only npm route; there is no model route at all. It installs lockfile dependencies with scripts disabled and runs `npm test`, or a trusted build-guidance line `Visible test command: \`command\``. A nonzero or missing exit code is never a pass. The private receipt records a bounded output tail and session-derived bash commands with exit codes. Candidate visible tests are not main-owned gates or a held-out verdict; F07b adds those gates.
- Patch bytes and their anchor live under `<state>/patches/`, mode 0600 in 0700 directories. Recovery verifies the exact digest and reuses collection; it never starts a new builder for stored work. Missing or changed patch bytes end failed. The real-workspace canary probe is `docs/prototypes/build-isolation/`.

**Departures from this design, each recorded in the F05 trail.**
- **The forwarder is a Node relay in `stage-init.ts`, not `socat`.** It needs no fork per connection, ships with the bundle's Node, and is unit-tested. Wherever this document says `socat`, read the stage-init relay.
- **`stage-init.ts` also starts a headless Herdr server** (`herdr --session factory server`, with a workspace on `/workspace`). It passes `HERDR_ENV`, `HERDR_SOCKET_PATH`, `HERDR_PANE_ID`, `HERDR_TAB_ID` and `HERDR_WORKSPACE_ID` to the stage Pi. The Pi itself is not in a pane. It drives RPC on the sandbox's stdio, and its children open panes beside the root pane. If Herdr does not start, the stage runs without children.
- **No `--disable-userns` and no `--unshare-user`.** The flags are those of brief call 2: `--unshare-all --die-with-parent --new-session --cap-drop ALL --clearenv`, a fresh `--proc` and `--dev`, under `env -i`. The seccomp filter's `clone`/`unshare` rule on `CLONE_NEWUSER|CLONE_NEWNS` covers nested namespaces.
- **The stage Pi keeps a session** under the writable agent dir (`--session-dir /run/pi-agent/sessions`). `pi-herdr-agents` refuses to launch a child from a parent with `--no-session`. It answers "no session file" without an error flag, so the runner counts a launch only when the tool result names a child id.
- **The agent dir is a fresh 0700 copy** of the bundle template, with 0600 files. The bundle is installed read-only, and a mode-preserving copy left Pi unable to create its sessions dir. Only regular files are copied, so it has no `extensions/`. It is writable, and Pi 1.4.0 loads every file in `<agentDir>/extensions/` even for an untrusted project, so the wrapper forces `--no-extensions`. That flag also skips packages named in `settings.json`. An explicit `-e`, which the wrapper allows only for the bundled `pi-herdr-agents` package dir and its `subagent-done.ts`, still loads under that flag. No stage currently passes either extension.
- **Audit lines are written when a request finishes,** not before the response is forwarded, and admission first checks that the log is healthy. Path redaction is the audit module's own sanitiser, not `redactCredentials`, so the gateway imports nothing from `src/`. A request the HTTP parser rejects is answered `403 bad-request` and audited too. The `detailed` level is recorded in the route table but adds no fields yet: certificate SANs, header-name lists and the `x-trace-id` count are not written.
- **The runner's budget is enforced before model work.** A stage with no run tokens left, or a zero stage token cap, ends `budget_exhausted` before any gateway, sandbox or prompt, and a gateway whose ceiling is already spent starts with its gate closed. The deadline is checked before launch and again before the prompt. Every cleanup wait (gate ack, abort settle, drain, Pi exit, scope stop, child-usage reads, gateway shutdown, stderr and receipt preparation) shares one window with one absolute end: the cleanup reserve, cut short by the stage's `wall_ms`. It opens at the first cleanup wait, or at once when the controller aborts the stage, so cleanup ends within the reserve of an abort even with wall time left. Only a refusal fallback, whose session starts after the primary's cleanup and before any abort, opens it again. The controller waits the reserve plus a 5 s grace before it posts a terminal marker for an aborted stage that has not reported. A gateway that does not shut down in it is killed, and the receipt's `egress` is then `null`.
- **The gateway enforces the turn cap.** The runner sets `ceiling.modelRequests` to the stage's `max_turns` (at most 2,000). The gateway counts each model request it forwards and closes its gate, reason `requests`, in the same step as it admits the last allowed one. So the request after it is `403 budget-closed` however soon Pi sends it, even before the runner has read that turn's records. The runner still caps on the next parent `turn_start`, and a session that ends on an error after a `requests` close is `budget_exhausted`/`turns`. Pi starts one model request per turn, retries included, so the two counts agree for the parent. Children's model requests go through the same gateway and count too. The controller subtracts earlier specify sessions' turns before it creates the next session's gateway, so review and revision share the stage's turn allowance.
- **Usage is counted after the outcome is chosen.** An aborted turn or a child result that arrives while a stage cleans up still adds its tokens, once, and the outcome stays as chosen. A session that settles on its own is checked against its token caps after every child-usage read, whatever its stop reason. A child-session read error is an unread child and ends the stage `failed`/`crashed`.
- **A restart counts what an interrupted stage spent.** When the controller adopts a `running` run after a restart, it adds that attempt's receipt `usage.total`, or, with no receipt, the metered tokens summed from its `egress.jsonl`. A line cut short by the crash is skipped, and a request still in flight at the crash has no audit line, so the tally can only undercount that request.
- **A replay counts what its attempt already spent.** An execution can start and spend after its `claimed`, `blocked` or `retrying` marker lands while its `running` marker is rejected, and an orderly `serve` stop then leaves the earlier marker durable. Every launch therefore reads what earlier executions of the same attempt spent, summed over the attempt's execution dirs, and passes the stage only the run tokens left after that. The launch adds that amount to the new execution's usage. A marker counts none of its own attempt until the attempt ends, so a later restart that reconciles the attempt counts each execution once. A release counts the same way. A run adopted after a restart and released before a stage of it starts here posts `released` only after the leftover-scope reconcile has passed. Its usage then holds its attempt's records, earlier executions included, once.
- **The receipt is a success gate.** It is written to a temp file, fsynced and renamed into place. When it cannot be written the stage ends `failed`/`crashed`, so it retries rather than passing without evidence.
- **Routes.** `model-xai` allows `models` and `responses` with the `openai-responses-sse` meter, as Pi 1.4.0 declares `xai/grok-4.6` on the Responses API. The `npm` route takes no query at all. Credentialed routes allow only GET and HEAD (owner decision 3). A stage's primary model must be `openai/*`, because only `model-openai` serves it, and a model stage's `wall_ms` must exceed the 10 s cleanup reserve.
- **A JSON body that names a key twice at any depth is denied** `body-not-allowed`, comparing keys after their escapes decode, so every parser upstream sees the body the check saw. An empty body on a JSON-rule route is denied `body-not-allowed` too, except on `GET` and `HEAD`, so an empty `POST /openai/v1/responses` cannot skip the model and tool constraints.
- **A ceiling or route may not place its secret in a routing or framing header:** `host`, any pseudo-header such as `:authority`, `content-length`, `transfer-encoding`, `connection`, `te`, `trailer` or `keep-alive`, or any header the client filter refuses as retargeting: `upgrade`, `forwarded`, `x-forwarded` and `x-forwarded-*`, `x-original-*`, `x-host`, `x-rewrite-url`, `x-http-method-override` and `proxy-*`. Both checks read that last list from one constant, `ROUTING_HEADER` in `routes.ts`. The gateway exits `bad-credentials`, whether the name is in the ceiling or in the route table.
- **The `pi` wrapper takes an allowlist of flags.** It keeps `--mode`, `--model`, `--thinking`, `--session`, `--session-id`, `--session-dir`, `--name`, `--system-prompt`, `--append-system-prompt`, `--exclude-tools`, `--print`, the `--no-*` switches and `--offline`/`--verbose`, and narrows `--tools`. Any other flag, including `--extension`, `--skill`, `--prompt-template`, `--theme`, `--provider`, `--fork`, `--export` and extension-registered flags, refuses the whole command line, as does an option with no value. Two `-e`/`--extension` values pass, by exact match, both in the read-only bundle: the `pi-herdr-agents` package dir `/opt/factory/pkg/node_modules/pi-herdr-agents`, which the stage Pi loads for its `subagent` tool, and that package's `maestro/adapters/pi/child/subagent-done.ts`, which it passes to every child it starts. Refusing either would stop children launching. The wrapper also drops `NODE_OPTIONS`, `NODE_PATH`, `NODE_REPL_EXTERNAL_MODULE`, `NODE_PRESERVE_SYMLINKS` and `NODE_PRESERVE_SYMLINKS_MAIN` from the Pi child's environment, so a loader variable set in the sandbox does not reach Pi. The wrapper's own Node still reads them, which is the same limit as the next item: a process that can set them can run `node` itself.
- **Address checks use one `BlockList` per family.** Node checks an IPv4 address against IPv6 rules in its `::ffff:` form, so a single list holding `::ffff:0:0/96` refused every IPv4 upstream. Every refused IPv4 range, and each local IPv4 address, is also refused in its IPv6 spellings: IPv4-mapped (`::ffff:a.b.c.d`), IPv4-compatible (`::a.b.c.d`) and 6to4 (`2002:aabb:ccdd::/48`). So `169.254.169.254` is refused as `::ffff:a9fe:a9fe`, `::a9fe:a9fe` and `2002:a9fe:a9fe::/48`, and NAT64 `64:ff9b::/96` is refused whole. Resolved addresses are dialled IPv4 first, because `pi-factorio` has no IPv6 route.

**How to read the tags.**
- **[E `file`]** marks a claim that rests on evidence in that file. Trail paths are relative to `pi-herdr-factorio-trails/F05/`. Repo paths are relative to `pi-herdr-factorio/` at `f88069f`. The `proto-r1/` and `proto-runtime/` files are also in this repository, under `docs/prototypes/vm-sandbox/r1/` and `docs/prototypes/vm-sandbox/runtime/`.
- **[D]** marks a design choice. It is not evidence, and the build may revise it with a reason.
- **[G]** marks a guess, usually a number or an assumption about a tool, that a named experiment or lane must settle.

**Short names.**
- *Sandbox* is the bwrap sandbox one stage runs in.
- *Forwarder* is the in-sandbox relay in `stage-init.ts` that listens on loopback and connects to the gateway socket. The design named `socat`; section 0 records the change.
- *Gateway* is the host-side reverse proxy, one per stage.
- *Runner* is the controller code in `server/sandbox.ts` that owns one stage.
- *Edge* is exe.dev's front end at `169.254.169.254`.

## 1. Threat model

### 1.1 What the gateway defends against

The agent runs model-written code that read untrusted issue text **[E `docs/design.md` "What done means", last paragraph]**. Assume every byte that leaves the sandbox was chosen by an attacker. The gateway, with the sandbox around it, must keep these out of reach.

- **GitHub.** Both the exe.dev GitHub integration (`github.int.exe.xyz`) and the public API (`api.github.com` and every other GitHub host). The integration answers any VM process and speaks as the factory's bot **[E `docs/design.md` "Known risks"]**. One request that reaches it can push, comment or label as the factory. That it answers *unauthenticated* processes is an inference that was not tested with an authenticated call **[E `proto-r1/summary.md` "What was not run"]**.
- **Any other host.** The internet, the tailnet, other exe.dev names, the VM's own services on loopback, and private ranges.
- **Metadata and the edge itself.** `169.254.169.254` in every spelling. Here the metadata address *is* the integration edge **[E `walkthrough/explanation.md` §1]**.
- **Host state.** Host home, controller state, other workspaces, the Docker socket, the SSH agent, the user systemd bus and the credential store. Section 7 covers this. The gateway covers the network half.
- **Secret exfiltration.** v1 has no secret in the sandbox and none in the gateway **[E `docs/design.md` "Sandbox"]**. Future injected secrets must never reach the sandbox, including by reflection in a response. They must never reach a log or any text the factory publishes.
- **Spend.** A runaway agent, Pi auto-retries or Herdr children must not issue model requests after a cap is hit **[E `walkthrough/explanation.md` gotcha 10, C7]**.
- **Model choice.** The agent must not switch to a model the stage did not configure, and in particular must not spend exe.dev Anthropic or xAI credits outside the recorded-refusal fallback **[E `docs/plans/factory-v1.md` lines 20 and 260]**.

### 1.2 What it does not defend against

- **A kernel escape lands on `exedev`.** Without `newuidmap`, the sandbox's host uid is `exedev` **[E `walkthrough/explanation.md` gotcha 4]**. That account is in the `docker` group and has `NOPASSWD: ALL` sudo **[E same]**. So a namespace or kernel escape is effectively root on the VM, and from there it reaches GitHub. "Rootless" here means an unprivileged user namespace, not an unprivileged host identity. Section 7's seccomp list shrinks this surface. It does not remove it.
- **Other host processes.** Any `exedev` process outside the sandbox already has the network and can use the integrations directly **[E `docs/design.md` "Known risks"]**. The gateway does not police the controller, cron jobs, an operator shell or a compromised gateway process.
- **A bug in the gateway itself.** The gateway runs as `exedev` with the host network. An exploitable parser bug in it reaches GitHub. Keeping it small, dependency-free and out of the controller process limits the blast radius **[D]**. It does not remove it. Section 9 lists self-sandboxing the gateway as an open item.
- **Data sent on an allowed route.** The agent may put any workspace bytes into a model prompt. That goes to the model provider, which is an accepted channel. Exfiltration *through* the provider to a third party is defended only by the model route's body constraint on hosted tools (section 3.4). Whether exe.dev forwards hosted tools at all is unknown **[G]**.
- **A shell can start Pi without the wrapper. This is a known limit.** The wrapper is the only `pi` on the PATH, but Pi's `cli.js` (`PI_CLI` in `server/sandbox/assets/pi.ts`) and the bundle's Node are readable in the sandbox. A Pi that has a shell tool can run `node` on `cli.js` with any flags, and it can also edit the `settings.json` in its own writable agent dir. Either way it skips the forced `--no-mcp --no-approve --no-context-files --no-extensions`, the tool allowlist and the flag allowlist. The gateway, the network namespace and seccomp still hold, because they do not depend on Pi's flags. F05 passed `tools: []`, and the wrapper then added `--no-tools`. F06a grants the specify draft only `read`, `grep` and `ls`; review and revision have no tools. F07a grants `bash` to build, so the wrapper is no longer a security boundary for its in-sandbox subprocesses. A builder can bypass Pi flags, but cannot bypass the mount namespace, seccomp, cgroup or host gateway. The gateway pins its model and spend, exposes only model/npm routes, and grants no GitHub authority. No confidentiality or publication claim relies on the shell obeying a Pi tool allowlist.
- **Low-bandwidth covert channels.** npm request paths carry agent-chosen package names to `registry.npmjs.org`. An attacker who cannot read registry logs gains little. Download counters on an attacker's own package are a slow side channel **[G]**. Timing channels are out of scope.
- **Hostile content on allowed routes.** npm package bytes and model output are untrusted input to the agent. `--ignore-scripts` and the sandbox contain them. The gateway does not inspect them, except on credentialed routes for reflected secrets.
- **Resource abuse inside the cgroup.** CPU and memory within `MemoryMax` and `TasksMax`, and bytes within route limits.

### 1.3 Why CONNECT, SNI and IP designs fail on exe.dev

The edge picks the backend from the request authority alone. It reads the absolute-form target's authority if present, else HTTP/2 `:authority`, else `Host`. It ignores SNI and every forwarding header **[E `proto-r1/summary.md` lines 8 and 44, `proto-r1/exp1-table.txt`]**. In 188 probes:

- With SNI `llm` and `Host: github.int.exe.xyz`, the GitHub backend answered on every path, and the reverse also held **[E `proto-r1/summary.md` line 27]**.
- An unknown SNI followed `Host` **[E same, line 28]**.
- HTTP/2 followed `:authority` and ignored a different `host` header **[E same, line 31]**.
- An absolute-form target beat both `Host` and SNI, over h1 and h2 **[E same, line 33]**.
- Both names resolve to `169.254.169.254` and share one wildcard certificate **[E `walkthrough/explanation.md` §1]**.

So each classic design fails.

- **CONNECT allowlist.** The proxy sees `CONNECT llm.int.exe.xyz:443`, opens an opaque tunnel, and the client sends `Host: github.int.exe.xyz` inside TLS. The proxy never sees it. `srt` documents this as domain fronting, and Codex "full" mode has the same shape **[E `research/prior-art.md` §4.1]**.
- **SNI allowlist.** SNI is the one input the edge ignores **[E `proto-r1/summary.md` line 28]**.
- **IP allowlist or nftables.** `llm` and `github` share an address, so any rule admits both or neither **[E `research/prior-art.md` §3.5, `docs/plans/factory-v1.md` R1]**.
- **TLS-terminating MITM** survives only if it rebuilds `Host` from the tunnel target and rejects `:authority` and absolute-form mismatches. It also needs a CA trusted by Pi, Node and npm **[E `research/prior-art.md` §4.1]**. We reject it in favour of the next option.

What passes R1 is a gateway where the client never names an upstream. The sandbox speaks plain HTTP to the gateway, the path prefix picks a fixed route, and the gateway builds the upstream request from scratch with its own `Host` and SNI. In experiment 3 every forged `Host`, forwarding header, absolute URL, `CONNECT` and disallowed method got 403 with no upstream connection, and every forwarded record sent `Host = SNI = llm.int.exe.xyz` or `registry.npmjs.org` **[E `proto-r1/summary.md` "Experiment 3", `proto-r1/exp3-gateway.log`]**. The netns had no route and no DNS across 238 bypass probes **[E `proto-r1/summary.md` line 73]**.

The gateway speaks HTTP/1.1 upstream only **[D]**. No `:authority` ever exists on the upstream leg, so the h2 routing key cannot diverge from `Host`.

## 2. Topology

### 2.1 Shape

- The sandbox has no network beyond its own `lo` **[E `proto-r1/summary.md` "Experiment 2"]**.
- Inside it, a forwarder listens on `127.0.0.1:18080` and connects each TCP connection to `/run/gw.sock` **[E `proto-r1/exp3_inside.sh` line 6]**. Each sandbox has its own netns, so every stage can use the same port **[G]**, which follows from per-sandbox `lo`.
- Pi's `models.json` points `openai` at `http://127.0.0.1:18080/openai/v1` and `xai` at `http://127.0.0.1:18080/xai/v1`. npm uses `registry=http://127.0.0.1:18080/npm/` **[E `walkthrough/explanation.md` §3]**.
- `/run/gw.sock` is the bind mount of one gateway's socket. There is one gateway process per stage attempt **[E `walkthrough/explanation.md` C2]**.
- The gateway runs on the host, outside the sandbox, and outside the controller process. It is a child process of the controller, in `factory.service`'s cgroup **[D]**. Untrusted HTTP parsing never runs in the process that holds the GitHub writer **[E `walkthrough/explanation.md` C13]**.
- The runner talks to its gateway over the child's stdin and stdout as a JSONL control channel. The sandbox cannot reach that channel **[D]**.

```text
 factory.service (system unit, User=exedev, NoNewPrivileges)
 ┌────────────────────────────────────────────────────────────────────┐
 │ controller process                                                 │
 │   Orchestrator ─► SandboxRunner (server/sandbox.ts)                 │
 │        │ stdin/stdout JSONL control            ▲ usage events       │
 │        ▼                                       │                    │
 │   gateway child process (node server/sandbox/gateway-main.ts)      │
 │     listens on <stateDir>/gw/<nonce>/gw.sock (dir 0700, socket 0600)│
 │     route table frozen at start, admission gate, audit writer       │
 │     credentials (future) read from $CREDENTIALS_DIRECTORY           │
 └───────▲───────────────────────────────────────────┬────────────────┘
         │ unix socket, bind-mounted as /run/gw.sock  │ HTTPS, HTTP/1.1
         │                                            │ Host and SNI fixed per route
 user scope factory-stage-<owner>-<run>-…            ▼
 ┌──────────────────────────────────────┐   169.254.169.254 (edge) ─► llm backend
 │ bwrap --unshare-all, netns has lo    │   registry.npmjs.org      ─► npm
 │  relay 127.0.0.1:18080 ─► gw.sock    │   (future) api.linear.app ─► Linear
 │  pi --mode rpc  (baseUrl 127.0.0.1)  │
 │  herdr server, bare Pi children     │
 │  npm --ignore-scripts               │
 └──────────────────────────────────────┘
```

### 2.2 Bridge choice. A socket path, created fresh, with the gateway ready first

Prior art offers two bridges **[E `research/prior-art.md` §4.2 "Unix-socket bridge", recommendation 12]**.

1. **A unix socket path**, bind-mounted into the sandbox. `srt` does this, and so did our prototype.
2. **An inherited fd pair** with no path. Codex does this.

**Decision. Keep the socket path [D].** The reasons follow.

- **The run 2 race was ordering, not paths.** The harness reused `gw/`, so bwrap bind-mounted a stale socket inode before the gateway unlinked and re-bound it. Every request got "connection refused" **[E `proto-r1/exp3-gateway.run2-socket-race.log`, `proto-r1/summary.md` line 138]**. Two changes fixed it, a fresh directory and waiting for the gateway's "listening" line before launch **[E `proto-r1/run_exp3.sh` lines 7 and 18]**. A design that never reuses a directory and never re-binds has no race.
- **The fd pair buys little here.** It hides the socket from other host processes. Those are `exedev` and already have the network (section 1.2). Inside the sandbox, only that stage's processes see the socket, which is intended.
- **The fd pair costs a lot.** One `socketpair` is one byte stream. Pi, npm and Herdr children open many concurrent HTTP connections. So the fd variant needs a multiplexing protocol, or per-connection fd passing over `SCM_RIGHTS`. `socat` can do neither, and Node exposes fd passing only through its IPC channel **[G]**. That is a custom in-sandbox forwarder and a custom frame format, which is new code on the trust boundary.

**The lifecycle that removes the race [D].**
1. The runner creates a fresh `<stateDir>/gw/<nonce>/` with `mkdir` mode 0700, short enough for the 108-byte socket path limit. It fails if the directory exists, and never reuses one.
2. The runner spawns the gateway with `--socket <stateDir>/gw/<nonce>/gw.sock`. The gateway sets umask 077 and binds. It refuses to start if the path exists, and never unlinks.
3. The gateway writes `{"event":"ready","ino":<inode>}` on its control stdout.
4. The runner checks with `lstat` that the path is a socket with that inode. It then makes one probe request itself, `GET /` over the socket, and expects `403 no-route`.
5. Only then does the runner launch bwrap with `--bind <stateDir>/gw/<nonce>/gw.sock /run/gw.sock`. That is the proved form **[E `proto-r1/run_exp3.sh` line 29]**. A read-only bind of the socket would be stricter. Section 9 lists it as an open question.
6. If the gateway exits, the stage fails. Nothing restarts the gateway under a running sandbox.

### 2.3 Lifetimes

- **The gateway dies with the controller [D].** It treats EOF on its control stdin as "close admission and exit". It is in `factory.service`'s cgroup, so `KillMode=mixed` reaps it on stop **[E `server/factory.service`]**. A sandbox that outlives its controller therefore loses all egress. It cannot spend unsupervised. Lane 9 must confirm this.
- **The sandbox lives in a user scope** named `factory-stage-<owner>-<run16>-<stage>-<attempt>-<nonce>` (section 0) **[E `walkthrough/explanation.md` gotcha 6]**. `bwrap --die-with-parent` also kills it when its parent dies. With `systemd-run --scope` the parent is the controller **[G]**, so the sandbox may die with the controller anyway. Section 9 records this against walkthrough gotcha 6.

## 3. Route registry and policy schema

### 3.1 Principles

- **Deny by default everywhere [D].** A request is forwarded only if exactly one route matches its prefix, the route is open, and every rule on that route allows it. A method, path, query key, header or body field that no rule names is denied. This holds inside a credentialed route too. A credentialed route is not a pass-through for paths it does not list **[E `research/prior-art.md` §2.3, Codex `HookedHostNoMatch`, recommendation 3]**.
- **The route table is frozen at gateway start [D].** The runner passes it once on stdin. There is no runtime "add route" command. The only runtime changes are open and close of an existing route and of the whole gate (section 5).
- **Unknown fields are rejected [D],** following Codex `deny_unknown_fields` **[E `research/prior-art.md` §2.4]** and this repo's strict nested keys **[E `src/workflow.ts` lines 299 and 453]**.
- **A version field [D].** Declared routes carry `egress.version: 1`, so an older controller rejects a newer table instead of misreading it **[E `research/prior-art.md` §2.3, Codex `mitm.version`]**.

### 3.2 TypeScript types

These are the contract between the runner and the gateway, in `server/sandbox/routes.ts` **[D]**.

```ts
type RouteId = string & { readonly __brand: "RouteId" };           // ^[a-z][a-z0-9-]{0,31}$
type CredentialId = string & { readonly __brand: "CredentialId" }; // ^[a-z][a-z0-9-]{0,31}$

type Method = "GET" | "HEAD" | "POST" | "PUT" | "PATCH" | "DELETE" | "OPTIONS";
// CONNECT, TRACE and TRACK are not in the type. The gateway refuses them before routing.

type PathRule =
	| { readonly kind: "exact"; readonly path: string }
	| { readonly kind: "prefix"; readonly prefix: string } // matched on a segment boundary
	| { readonly kind: "glob"; readonly pattern: string }; // "*" is one segment, a final "**" is the rest

type QueryRule =
	| { readonly kind: "none" } // any "?" denies
	| {
			readonly kind: "keys";
			readonly allow: readonly string[]; // each at most once
			readonly maxValueBytes: number;
	  };

type JsonScalar = string | number | boolean;

type JsonConstraint =
	| { readonly kind: "one_of"; readonly pointer: string; readonly values: readonly JsonScalar[] }
	| { readonly kind: "absent"; readonly pointer: string }
	| { readonly kind: "at_most"; readonly pointer: string; readonly value: number }
	| {
			readonly kind: "each_one_of"; // every element of the array at pointer
			readonly pointer: string;
			readonly field: string;
			readonly values: readonly JsonScalar[];
	  };

type BodyRule =
	| { readonly kind: "none" } // a request body denies
	| { readonly kind: "opaque"; readonly contentTypes: readonly string[] }
	| {
			readonly kind: "json";
			readonly contentTypes: readonly string[];
			readonly constraints: readonly JsonConstraint[];
	  };

type Upstream = {
	readonly scheme: "https"; // "http" exists only in test-built tables (section 8.3)
	readonly host: string; // name the gateway resolves
	readonly port: number;
	readonly basePath: string; // replaces the route prefix, e.g. "/" for npm
	readonly hostHeader: string; // the only Host sent
	readonly sni: string; // the only servername sent
	readonly address:
		| { readonly kind: "resolve" } // resolve once, check, dial that address
		| { readonly kind: "pinned"; readonly ip: string }; // built-in routes only
};

type Limits = {
	readonly maxRequestBytes: number;
	readonly maxResponseBytes: number;
	readonly headersTimeoutMs: number; // until upstream response headers
	readonly idleTimeoutMs: number; // between body chunks, either direction
	readonly totalTimeoutMs: number;
	readonly perMinute: number; // token bucket on admitted requests
	readonly maxConcurrent: number;
};

type CredentialPlacement =
	| { readonly kind: "header"; readonly name: string; readonly scheme: "Bearer" | "Token" | null }
	| { readonly kind: "basic"; readonly username: string }; // the secret is the password

type CredentialRef = {
	readonly id: CredentialId;
	readonly placement: CredentialPlacement;
};

type Route = {
	readonly id: RouteId;
	readonly prefix: string; // "/openai/v1/", always starts and ends with "/"
	readonly upstream: Upstream;
	readonly methods: readonly Method[];
	readonly paths: readonly PathRule[]; // relative to the prefix
	readonly query: QueryRule;
	readonly body: BodyRule;
	readonly requestHeaders: readonly string[]; // client headers copied, lower case
	readonly responseHeaders: readonly string[]; // upstream headers copied back, lower case
	readonly limits: Limits;
	readonly credential: CredentialRef | null;
	readonly budget: boolean; // true: the admission gate applies (section 5)
	readonly audit: "standard" | "detailed"; // section 6.2
	readonly initially: "open" | "closed";
	readonly meter: "openai-responses-sse" | null; // token usage parser (section 5.3)
};

type RouteTable = {
	readonly version: 1;
	readonly stage: string;
	readonly runId: string;
	readonly attempt: number;
	readonly forwarderHost: string; // "127.0.0.1:18080", the only client Host accepted
	readonly routes: readonly Route[];
	readonly ceiling: { readonly modelTokens: number; readonly modelRequests: number };
};
```

**Rule order inside the gateway [D].** These checks run before any route lookup, then per route, and the first failure denies.
1. Global request checks. Method not `CONNECT`, `TRACE` or `TRACK`. Origin-form target. No ambiguous path. Exactly one `Host` equal to `forwarderHost`. No forwarding-family header. No `Upgrade`. No request carrying the bytes of any loaded secret. The prototype did all of these except the last two **[E `proto-r1/gateway.py` lines 43, 72-91, 150-160]**.
2. Route lookup by longest prefix, which must be unique.
3. Route open, then gate open if `budget`, then rate and concurrency.
4. Method, path, query, body size, then body constraints.
5. Build the upstream request (section 3.5).

**Why glob and not regex [D].** The task allows either. Segment globs cannot backtrack, are easy to review in a diff of `WORKFLOW.md`, and match on segment boundaries the way Codex prefixes do **[E `research/prior-art.md` §5 recommendation 2]**. Regex invites ReDoS and patterns that are wider than they look.

**Path canonical form [E `proto-r1/gateway.py` lines 72-91].** Path rules are matched against the raw path, which must already be canonical. The gateway never decodes and re-matches. It denies dot segments in raw or decoded form, `%25`, `//`, backslashes, control characters, fragments and characters outside the RFC 3986 path set. That is the prototype's rule set, kept as is.

### 3.3 Where the table comes from

**Built-in routes [D].** These are constants in `server/sandbox/routes.ts`, built by the controller. v1 ships exactly these.

| id | prefix | upstream | methods | paths | body | meter | initially |
|---|---|---|---|---|---|---|---|
| `model-openai` | `/openai/v1/` | `https://llm.int.exe.xyz:443`, pinned `169.254.169.254`, base `/openai/v1/` | GET, POST | `models`, `responses` exact | JSON, section 3.4 | `openai-responses-sse` | open |
| `model-xai` | `/xai/v1/` | same host, base `/xai/v1/` | GET, POST | `models` exact, plus the endpoint Pi's xai provider calls **[G]** | JSON, section 3.4 | per the endpoint **[G]** | closed |
| `npm` | `/npm/` | `https://registry.npmjs.org:443`, resolved, base `/` | GET, HEAD | `**` | none | none | open |

- The model upstream is pinned to `169.254.169.254` because the name resolves there **[E `walkthrough/explanation.md` §1]**. A resolved link-local address is otherwise refused (section 3.6), so only a built-in route can carry this pin.
- The model paths are the ones the prototype proved, `models` and `responses` **[E `proto-r1/summary.md` "Completion", `proto-r1/exp3b_inside.sh` line 3]**. The prototype allowed `/openai/v1/*` with GET and POST **[E `proto-r1/gateway.py` lines 61-70]**. This design narrows it to two paths.
- `chat/completions` is not allowed. exe.dev rejected `gpt-6.1-sol` there **[E `proto-r1/summary.md` "Deviation, disclosed"]**.
- `/anthropic/*` has no route **[E `proto-r1/summary.md` exp 3 table]**.
- npm is GET and HEAD only, and `registry.npmjs.org` is the only npm host. All 159 lockfile URLs use it, and GitHub-hosted package hosts would reopen R1 and R4 **[E `walkthrough/explanation.md` C9]**.

**Declared routes, for future integrations [D].** These come from `.github/factory/WORKFLOW.md` front matter, read only from `main` at a resolved SHA. The loader never reads a local checkout **[E `src/workflow.ts` lines 24 and 945-1010, `.github/factory/WORKFLOW.md` lines 2-3]**. Five rules bind them.

1. **A credential must exist host-side.** A declared route must name a `credential` id that exists in the host-side credential registry (section 4.1). An unknown id fails the workflow load, and the last valid snapshot stays in force **[E `src/workflow.ts` `reloadWorkflow` comment, line 1047]**.
2. **The registry entry is a ceiling.** It pins the upstream scheme, host and port, the placement, and the widest methods and path rules the owner allows for that secret. A declared route may only narrow them. So a merged change to `WORKFLOW.md` can re-scope a provisioned integration. It cannot point a secret at a new host, or widen it.
3. **Declared routes must be credentialed.** An uncredentialed declared route is rejected. Uncredentialed egress beyond model and npm is not an integration feature, and it would widen R1's "allow only `llm.int.exe.xyz` and required npm" **[E `docs/plans/factory-v1.md` line 258]**.
4. **Forbidden upstreams.** A declared route may never target `*.exe.xyz`, which covers every integration and the VM itself, any GitHub host (`github.com`, `*.github.com`, `*.githubusercontent.com`, `*.ghe.com`), `registry.npmjs.org`, `localhost`, or an IP literal. These are code constants, not config.
5. **Stages opt in.** Each stage lists the declared route ids it gets, under `stages.<stage>.egress`. A stage that lists none gets only the built-ins.

**A PR can never add a route or a secret.**
- A PR branch's `WORKFLOW.md` has no effect until it merges, because the loader reads `main` only **[E `src/workflow.ts` line 24, `docs/operations/factory-cli.md` line 10]**.
- A factory-produced patch that touches `.github/` is rejected **[E `docs/design.md` "Forbidden paths"]**.
- Secrets and ceilings live on the VM, outside the repo. Adding one needs an owner VM change (section 4.1).
- *After* a human merges a `WORKFLOW.md` change, it can only narrow or select within ceilings the owner already provisioned.

**What F05 builds [D].** F05 builds the route engine with full credential support and tests it with a fixture credential. It does not add the `egress` key to the `WORKFLOW.md` parser. Today an unknown root key is warned about and ignored **[E `src/workflow.ts` line 602]**, which fails safe because it adds no routes. The parser lands with the first real integration, behind its own owner-approved PR. The parser also has no list reader today **[E `src/workflow.ts`, no `isSeq` use]**. That is one more reason to land it only when it is needed.

### 3.4 Model route body constraints

These close spend and exfiltration holes that the path rules cannot see **[D]**.

- `/model` must be `one_of` the stage's configured model id without its provider prefix. On `model-xai` it must be the fallback model.
- `/tools` must be `each_one_of` with field `type` in `["function"]`. That denies hosted tools such as `web_search`, `file_search`, `code_interpreter` and `mcp`. A hosted `mcp` tool names a remote server URL, and the provider would call it. That would be an exfiltration path the gateway cannot otherwise see **[G]** that exe.dev forwards hosted tools.
- `/background` must be `absent`.
- `/max_output_tokens` is `at_most` a per-stage cap, if Pi sets it **[G]**. It bounds the overshoot after a gate closes (section 5.2).
- Request bodies are at most 16 MiB **[G]**. The prototype used 8 MiB **[E `proto-r1/gateway.py` line 48]**. Long build sessions resend the context with `store:false`, so experiment 4 must measure real sizes.

### 3.5 How the upstream request is built

The rule is to build from scratch, never to merge **[E `proto-r1/gateway.py` lines 170-180, `research/prior-art.md` recommendation 4]**.

1. Request line `<METHOD> <basePath + path after prefix>[?query]` in origin form.
2. `Host: <hostHeader>`, exactly once.
3. The client headers listed in `requestHeaders`, after removing every credential-family header (`authorization`, `proxy-authorization`, `cookie`, `x-api-key` and any `*-api-key` or `*-token` spelling). Built-in routes copy `accept` and `content-type`, as the prototype did **[E `proto-r1/gateway.py` line 42]**.
4. Gateway-set headers `User-Agent: factory-gateway/<version>`, `Accept-Encoding: identity`, `Connection: close` and `Content-Length`.
5. If the route has a credential, the credential header goes last (section 4.3).

The upstream connection is `node:https` with `servername: sni`, `setHost: false`, `agent: false`, a pinned `lookup`, `rejectUnauthorized: true` and the system CA store. It never follows a redirect, and `node:https` cannot **[D]**. The prototype had the same property with `http.client` **[E `proto-r1/summary.md` exp 3, the 302 rows]**. The gateway never uses `fetch`, which follows redirects by default and pulls in undici **[D]**.

Only headers in `responseHeaders` come back. `Set-Cookie`, `Set-Cookie2`, `Authorization`, `Proxy-Authenticate`, `Proxy-Authorization`, `WWW-Authenticate` and `Authentication-Info` are never copied on any route **[D]**. Responses stream back chunk by chunk. The prototype buffered them **[E `proto-r1/summary.md` "What was not run"]**. The Responses API requires `stream:true` through exe.dev **[E `proto-r1/exp3b-completion.attempt2-stream-required.log`]**, so streaming is required.

On uncredentialed routes a 3xx is passed back with `Location`, unfollowed. The sandbox cannot follow an absolute `Location`, and a relative one comes back through the gateway **[E `proto-r1/summary.md` exp 3, the `curl -L` rows]**. Credentialed routes refuse 3xx (section 4.4).

### 3.6 Address checks

- `resolve` routes look the name up once. They refuse loopback, link-local, private, CGNAT (`100.64.0.0/10`, which covers the tailnet), ULA, multicast and the host's own addresses. They dial the address that passed, with no second lookup **[E `research/prior-art.md` §1.2 "DNS and IP literals"]**.
- `pinned` exists only on built-in routes.
- Both forms record the peer address in the audit line **[E `proto-r1/gateway.py` line 189]**.

### 3.7 YAML example

The v1 built-ins expressed in the same shape. They live in code, not in `WORKFLOW.md`.

```yaml
# server/sandbox/routes.ts builds these; shown as YAML for review only
version: 1
routes:
  model-openai:
    prefix: /openai/v1/
    upstream: { scheme: https, host: llm.int.exe.xyz, port: 443, base_path: /openai/v1/,
                host_header: llm.int.exe.xyz, sni: llm.int.exe.xyz, address: { pinned: 169.254.169.254 } }
    methods: [GET, POST]
    paths: [{ exact: models }, { exact: responses }]
    query: none
    body:
      json:
        content_types: [application/json]
        constraints:
          - { one_of: /model, values: [gpt-6.1-sol] }        # the stage's configured model
          - { each_one_of: /tools, field: type, values: [function] }
          - { absent: /background }
    request_headers: [accept, content-type]
    response_headers: [content-type, cache-control, x-request-id]
    limits: { max_request_bytes: 16777216, max_response_bytes: 67108864, headers_timeout_ms: 120000,
              idle_timeout_ms: 120000, total_timeout_ms: 900000, per_minute: 60, max_concurrent: 8 }
    credential: null       # the exe.dev edge injects model access
    budget: true
    audit: detailed
    initially: open
    meter: openai-responses-sse
  npm:
    prefix: /npm/
    upstream: { scheme: https, host: registry.npmjs.org, port: 443, base_path: /,
                host_header: registry.npmjs.org, sni: registry.npmjs.org, address: resolve }
    methods: [GET, HEAD]
    paths: [{ glob: "**" }]
    query: { keys: [write], max_value_bytes: 8 }   # the build confirms npm's real query use
    body: none
    request_headers: [accept]
    response_headers: [content-type, cache-control, etag, last-modified, location]
    limits: { max_request_bytes: 0, max_response_bytes: 268435456, headers_timeout_ms: 30000,
              idle_timeout_ms: 60000, total_timeout_ms: 600000, per_minute: 600, max_concurrent: 16 }
    credential: null
    budget: true
    audit: standard
    initially: open
    meter: null
```

All limits are **[G]** starting values. Lanes 2, 3 and 10 and the perf box measure them. `x-request-id` and the npm query key are **[G]** until experiments 4 and 9 show what the clients need.

## 4. Credential injection

v1 injects no secret. The exe.dev edge injects model access, and the prototype reached the model with no client credential **[E `proto-r1/summary.md` exp 3, `docs/design.md` "Sandbox"]**. This section specifies the mechanism so the first integration adds config, not code.

### 4.1 Store

**Decision. systemd `LoadCredential=` on `factory.service` [D].**
- **Values.** Each secret is a file `/etc/factory/credentials/<id>`, owner `root:root`, mode 0400. The unit gets one `LoadCredential=<id>:/etc/factory/credentials/<id>` line per secret. systemd copies each into the service's private, non-swappable credentials directory, readable by the service user, and sets `$CREDENTIALS_DIRECTORY` **[G]** for the exact semantics on the VM's systemd. `factory.service` is a system unit with `User=exedev` **[E `server/factory.service`]**, so this works without making the source readable by `exedev`.
- **Ceilings.** `/etc/factory/egress-credentials.json`, owner root, mode 0644, holds no secret values. It maps each id to its ceiling `{ scheme, host, port, placement, methods, paths }` (section 3.3 rule 2).
- **Why not a plain `exedev`-owned file.** It works, but every `exedev` process could read it at rest. `LoadCredential` keeps the source root-only, and adding or rotating a secret needs an owner VM change plus a service restart. That is the property "a PR can never add a secret" wants.
- **Honest limit.** `exedev` has `NOPASSWD` sudo **[E `walkthrough/explanation.md` gotcha 4]**, so this protects secrets from the sandbox and from casual reads, not from a compromised host account.

### 4.2 Loading

- The runner passes the gateway only the ids its route table references, as `--credential <id>`. It never opens the files itself **[D]**. It cannot be prevented from doing so, because it is the same process tree. This is a convention that review enforces.
- The gateway reads `$CREDENTIALS_DIRECTORY/<id>` once at start into a `Buffer`, checks 1 to 8192 bytes with no CR or LF, and refuses to start on any error. The range follows `srt proxy` **[E `research/prior-art.md` §1.3]**.
- The gateway deletes `CREDENTIALS_DIRECTORY` from its own `process.env` after loading. The sandbox never inherits the controller environment, because bwrap runs with `--clearenv` **[E `proto-r1/run_exp3.sh` line 31]**, and `/run/credentials` is never mounted (section 7.2).
- Env-var secrets, which Codex supports, are not supported. Env leaks to children and core dumps **[D]**.

### 4.3 Binding and placement

- **Bound to a route, never to a request [E `research/prior-art.md` recommendation 2].** The client cannot name, select or see a credential. A request matching route R gets R's secret, and nothing else does.
- **Strip, then set [E `research/prior-art.md` §1.3 `srt proxy`, recommendation 4].** Every client credential-family header is removed first (section 3.5 step 3). Then the gateway sets exactly one header.
  - `header` placement sends `<name>: <scheme> <secret>`, or `<name>: <secret>` when the scheme is null.
  - `basic` placement sends `Authorization: Basic base64(<username>:<secret>)`.
- **One credential per route, one route per credential per stage [D].** This stops laundering secret A through route B **[E `research/prior-art.md` §1.3 `injectHosts`]**.

### 4.4 Refusals

On a credentialed route the gateway refuses these **[E `research/prior-art.md` recommendation 5]**.

- **A plaintext upstream.** The route loader rejects `scheme: http` with a credential. There is no `allowPlaintextInject` opt-out.
- **Redirects.** The gateway never follows a redirect on any route. On a *credentialed* route a 3xx becomes `403 redirect-refused` and `Location` is dropped, because a URL the upstream signed for our credential may be in it. On an *uncredentialed* route the 3xx is passed back with `Location`, unfollowed (section 3.5). This is deliberate. The sandbox has no network, so it cannot follow an absolute `Location` (`github.int.exe.xyz` included). A relative one comes back through the gateway, which checks it like any new request. A `Location` on an uncredentialed route can only carry what the upstream would put in a body on that route. That is no secret of ours, because the route has no credential. The design draft (`trails/F05/design/gateway.md` §4.4) said every 3xx is refused. That contradicted its own §3.5, and the build follows §3.5.
- **`TRACE`, `TRACK` and `CONNECT`.** These are refused globally, before routing, because a `TRACE` echo would return the injected header **[E `research/prior-art.md` §1.2]**.
- **Compressed responses.** The gateway sends `Accept-Encoding: identity`. A response with any `Content-Encoding` header, `identity` included, becomes `403 response-blocked`, and so does a body whose first bytes are a gzip, zlib, framed brotli or zstd magic number, because the reflection scan cannot read it **[D]**. Codex fails closed on compressed bodies for the same reason **[E `research/prior-art.md` §2.3]**.
- **Response types.** Only `application/json` and `text/*` may come back. Any other `Content-Type`, or none, becomes `403 response-blocked` before a byte is read. This refuses raw deflate, unframed brotli and gzip after a prefix served as binary, which no magic check sees.

### 4.5 Response handling

- **Header scrub [E `research/prior-art.md` recommendation 6].** The auth and cookie headers in section 3.5 are never copied, and only `responseHeaders` pass.
- **Reflection check [E `research/prior-art.md` recommendation 6, which marks it as new].** The gateway scans response headers and the streamed body in four views, raw, JSON-unescaped, percent-decoded and with ASCII whitespace removed, for the secret's raw bytes, its hex in both cases, its UTF-16LE and UTF-16BE, its base64 and base64url at every offset, and its percent-encoded forms **[D]**.
  - A match in the headers sends `403 response-blocked`, and nothing upstream reaches the client.
  - For the body, no status line or header is sent until the filter passes its first bytes. Nothing passes until the first four bytes show no compression magic. After that the gateway holds back `6 × len(longest form) − 1` bytes until the next chunk arrives, so a match, even JSON-escaped, is found before any matching byte is written. A body blocked before its first bytes pass, which includes every short body and every one with compression magic, is a clean `403 response-blocked`, audited as `deny`.
  - A match later in a long body destroys the client connection with no further bytes. The status line has already gone, so a 403 is impossible. The audit records `decision: "blocked_mid_stream"`.
  - **This scan is defense in depth and cannot be complete.** An upstream can always re-encode a secret in a way no scan reads. The primary control is that a secret binds only to a trusted upstream, under the owner's ceiling, on a read-only route.
- **Request-side tripwire [D].** A request whose target, headers or body reveals a loaded secret in any of the four views is denied as `secret-in-request`. The sandbox should never hold a secret, so a hit means a leak path exists. The runner fails the stage. The audit line for that deny has the path `[redacted]`.

### 4.6 The confused-deputy rule

Once the gateway holds a secret for route R, any code in the sandbox that reaches R acts with that secret **[E `research/prior-art.md` §4.3]**. The route's allowlist *is* the permission. So the rule has three parts.

- **The allowlist is no wider than the narrowest token that can do the job.** Use the narrowest scoped token the upstream offers. Then make methods, paths, query and body no wider than that token's scope, and narrower where the stage needs less.
- **Where the allowlist cannot express the scope, the token must.** A single GraphQL endpoint is one path for reads and writes. There, only a read-only token makes a read-only route.
- **Sandbox credentials are read-only in practice.** The factory's rule is that only the controller writes to external systems **[E `docs/design.md` "Relation to Symphony"]**. A write-capable sandbox route would let an agent post untrusted text as the factory. Write integrations belong in the controller, as F13's Linear adapter already plans **[E `docs/plans/factory-v1.md` R7]**.

### 4.7 Worked example, a read-only Linear route

The goal is to let `specify` read a linked Linear issue for context. This is hypothetical. Linear's endpoint and header shape are **[G]** from memory and must be checked against Linear's docs at the time. **As built, this example cannot be configured:** credentialed routes allow only GET and HEAD (owner decision 3), and Linear's reads are GraphQL `POST`s. It stays as the design record of why a single-endpoint API needs a read-only token. The first integration must either use a GET API or bring an owner decision that widens the rule.

1. **Owner VM change.** Create a read-only Linear API key, scoped to one team if Linear allows it. Write it to `/etc/factory/credentials/linear-read` (root, 0400). Add the ceiling.
   ```json
   { "linear-read": { "scheme": "https", "host": "api.linear.app", "port": 443,
       "placement": { "kind": "header", "name": "Authorization", "scheme": null },
       "methods": ["POST"], "paths": [{ "exact": "graphql" }] } }
   ```
   Add `LoadCredential=linear-read:/etc/factory/credentials/linear-read` to `factory.service` and restart it.
2. **Owner-merged `WORKFLOW.md` change on `main`.**
   ```yaml
   egress:
     version: 1
     routes:
       linear-read:
         prefix: /linear/
         credential: linear-read
         methods: [POST]
         paths: [{ exact: graphql }]
         body:
           json:
             content_types: [application/json]
             constraints:
               - { absent: /variables/input }   # a narrowing, not the security boundary
         limits: { max_request_bytes: 65536, max_response_bytes: 4194304, per_minute: 30, max_concurrent: 2 }
         audit: detailed
   stages:
     specify:
       egress: [linear-read]
   ```
   The upstream, `Host`, SNI and placement come from the ceiling, never from `WORKFLOW.md`. The read-only key is the real boundary (section 4.6). The body constraint only narrows.
3. **Sandbox side.** The stage's tools call `http://127.0.0.1:18080/linear/graphql` with no auth. The gateway strips any `Authorization` the agent sends and sets the real one.
4. **Tests before enabling.** Lane 5b (section 8.3) with the ceiling and route pointed at a host-side echo fixture. Forged auth is replaced. `GET`, other paths and `?query` are denied. A reflected key is blocked. A 302 is refused.
5. **Plan note.** This widens R1's "allow only `llm.int.exe.xyz` and npm" **[E `docs/plans/factory-v1.md` line 258]**. The first integration PR must amend that line explicitly.

A Slack worked example shows the write problem. `chat.postMessage` is one path, `/api/chat.postMessage`, and a body constraint can pin `/channel`, so the allowlist could be precise. It would still let the agent publish untrusted text as the factory, which breaks the controller-only-writes rule. So Slack writes belong in the controller. A read route such as `conversations.history` with a `channel` query pin fits this design **[D]**.

## 5. Budget and admission gate

### 5.1 Gate states

- Each gateway has one gate with the states `open` and `closed(reason)`. Closing is one-way for the life of the gateway **[D]**.
- Every route with `budget: true` checks the gate at admission. All v1 routes have `budget: true` **[D]**. Once the gate closes, nothing new reaches the model or npm.
- Routes also open and close one at a time. `model-xai` starts closed, and the runner opens it only for the fallback session after a recorded refusal. The runner closes `model-openai` at the same moment **[D]**, because the plan says to use the fallback "only after a recorded refusal" **[E `docs/plans/factory-v1.md` line 20]**.
- A request is *admitted* at the instant the gateway decides to forward it, before it opens the upstream connection. Node runs the admission check and the control-channel `close` handler on one event loop, so there is no interleaving. A request checked after the flip is denied. A request admitted before it is in flight **[D]**.

### 5.2 How the runner closes admission at a cap

The runner counts these **[E `walkthrough/explanation.md` C7]**.
- Turns, from parent `turn_start`.
- Tokens, from gateway usage events (section 5.3) cross-checked with Pi `message_end` usage.
- Wall time, against `wall_ms − cleanupReserve`.
- The run's remaining tokens, passed at launch.

When any cap is reached, or a stall abort or deadline arrives, the runner works in this order.

1. Send `{"cmd":"close","reason":"turns"|"tokens"|"run_tokens"|"wall"|"stall"|"abort"}` on the control channel. The turn cap needs no command in the build: the gateway's request ceiling closes the gate first (section 0). Wait for `{"event":"gate_closed"}`. A missing ack within 1 s kills the gateway, which also closes egress **[D]**.
2. Send Pi `abort` over RPC.
3. Let in-flight requests finish within the cleanup reserve. They are allowed to finish. Nothing new is admitted, including Pi auto-retries, which are new requests, and Herdr children, which use the same forwarder and gateway **[E `walkthrough/explanation.md` §3 step 5, gotcha 10]**. A denied retry gets `403 budget-closed`.
4. When the reserve runs out, send `{"cmd":"drain_abort"}`, which destroys remaining upstream sockets. Then stop the scope.
5. Settle as `budget_exhausted` with the cap that fired.

**Overshoot bound.** In-flight requests may complete. The excess is at most `maxConcurrent` model responses. A `max_output_tokens` ceiling would bound each one (section 3.4). Without it, the bound is whatever the provider allows **[G]**.

**Gateway backstop [D].** The table carries `ceiling.modelTokens = remainingRunTokens` and `ceiling.modelRequests`. If metered usage crosses either, the gateway closes its own gate and reports `gate_closed{reason:"ceiling"}` for tokens or `gate_closed{reason:"requests"}` for requests. The runner treats `ceiling` as a token cap. In the build `ceiling.modelRequests` is the stage's turn cap, so `requests` ends the stage `budget_exhausted`/`turns`. This covers a runner bug or a wedged RPC stream.

**Controller death.** EOF on the control stdin closes the gate and exits the gateway (section 2.3).

### 5.3 Per-route usage reporting

- After each finished request, the gateway emits one control event with numbers and enums only.
  `{"event":"usage","route":"model-openai","status":200,"bytesIn":812,"bytesOut":4410,"inputTokens":11,"outputTokens":5}`
- The `openai-responses-sse` meter reads `usage.input_tokens` and `usage.output_tokens` from the `response.completed`, `response.incomplete` or `response.failed` event. That event carried usage in the one real completion **[E `proto-r1/exp3b-completion.log` line 9, `proto-r1/exp3b_inside.sh`]**. A stream that ends with no usage counts `tokens: null` and is reported as unmetered. The runner then falls back to Pi's numbers and the session files **[D]**.
- At gate close and at exit, the gateway emits `{"event":"summary","routes":[{route, forwarded, deniedByCode:{…}, bytesIn, bytesOut, inputTokens, outputTokens, unmetered, peakConcurrent}]}`. The runner copies this into the stage receipt's `egress` field. Built-in route ids are code constants. Declared routes appear as `declared:<n>` (section 6.3).

## 6. Deny shape and audit

### 6.1 Deny shape

Every request the gateway refuses gets **[E `research/prior-art.md` recommendation 10]** the following.
- Status `403`.
- `X-Proxy-Error: <code>`.
- `Content-Type: text/plain; charset=utf-8`.
- The body `factory-gateway: denied: <code>\n`.
- `Connection: close`, and the gateway closes the connection after writing **[E `research/prior-art.md` §4.2 "Refusal behaviour"]**.

The body never quotes the request, a header name, a path, upstream text or config text. The prototype echoed client header names into its deny reason **[E `proto-r1/gateway.py` line 159]**. This design drops that.

Upstream transport failures are not denies. They return `502 X-Proxy-Error: upstream-error` or `504 X-Proxy-Error: upstream-timeout`, with the same fixed body shape **[D]**.

**Code enum [D].** This is a closed set, and adding a code is a code change.

| Code | When |
|---|---|
| `bad-request` | the HTTP parser rejected the request before it had a method and path: an unknown method token such as `TRACK`, an HTTP/2 preface, `Content-Length` with `Transfer-Encoding`, or a malformed header. One audit line with an empty method and path |
| `method-forbidden` | `CONNECT`, `TRACE`, or another method outside `Method` that the parser accepts |
| `bad-request-target` | absolute form, authority form, asterisk form |
| `ambiguous-path` | any section 3.2 path-canonical failure |
| `bad-host` | `Host` missing, duplicated, or not `forwarderHost` |
| `forbidden-header` | forwarding family (`X-Forwarded-*`, `Forwarded`, `X-Original-*`, `X-Host`, `X-Rewrite-URL`, `X-HTTP-Method-Override`), `Proxy-*`, `Upgrade` |
| `no-route` | no prefix matches |
| `route-closed` | the route is closed, for example `model-xai` before a refusal |
| `budget-closed` | the gate is closed |
| `rate-limited` | over `perMinute` or `maxConcurrent` |
| `method-not-allowed` | the method is not in the route's `methods` |
| `path-not-allowed` | no path rule matches |
| `query-not-allowed` | query present on `none`, an unknown key, a repeated key or an oversized value |
| `body-too-large` | over `maxRequestBytes` |
| `body-not-allowed` | body on `none`, a wrong content type, unparsable JSON, a key named twice in one object, or a failed constraint |
| `upstream-address-refused` | the resolved address is in a refused range |
| `secret-in-request` | the request carries a loaded secret's bytes |
| `redirect-refused` | a 3xx on a credentialed route |
| `response-blocked` | reflection in the headers or body, any `Content-Encoding`, a `Content-Type` other than `application/json` or `text/*`, or a body with compression magic, on a credentialed route |
| `audit-unavailable` | the audit line could not be written, so nothing is forwarded |

Every deny is decided before any upstream connection, except `redirect-refused` and `response-blocked`, which happen after the upstream answered. The prototype's guarantee that "no denied record has an upstream" **[E `proto-r1/summary.md` exp 3 log analysis]** therefore holds for every code except those two.

### 6.2 Audit line

One JSON object per request, one line, written when the request finishes (section 0). A failed write closes the gate, and every later request is denied with `audit-unavailable` **[D]**.

```json
{"v":1,"ts":"2026-10-29T14:56:59.812Z","stage":"build","runId":"<digest>","attempt":1,"req":17,
 "route":"model-openai","method":"POST","path":"/openai/v1/responses",
 "upstream":{"host":"llm.int.exe.xyz","sni":"llm.int.exe.xyz","port":443,"addr":"169.254.169.254","tls":"TLSv1.3"},
 "status":200,"bytesIn":812,"bytesOut":4410,"durationMs":2210,"credential":null,
 "decision":"forward","reason":null,"gate":"open","inputTokens":11,"outputTokens":5}
```

- **Required fields.** Stage, run, attempt, route id, method, redacted path, upstream host and SNI, status, bytes, duration, credential id, decision and reason.
- **Credential.** The credential id, never its value.
- **Values.** `decision` is one of `forward`, `deny`, `error` or `blocked_mid_stream`. `reason` is a code from 6.1 or null.
- **The upstream record.** For forwards, `upstream.host` and `upstream.sni` are the values actually sent. SNI is read back from the TLS socket after the handshake, as the prototype did **[E `proto-r1/gateway.py` line 194]**. For denies, `upstream` is null.
- **Redacted path.** The query is replaced by `?…` when present **[E `research/prior-art.md` §1.4, `srt` redaction]**. Every segment that reveals a loaded secret becomes `~redacted~`. The path is then decoded and its `/` and `\` removed. If that shows a secret, as when a `/` or `%2f` splits one, the gateway logs the route's path template, or `[redacted]` when no route matched. The path is truncated to 128 bytes, and bytes outside `[A-Za-z0-9._~/%-]` become `_`. It is still attacker-chosen text, which is why it stays in this file.
- **Credentialed routes and secret denies.** A `secret-in-request` deny logs the path `[redacted]`. A credentialed route never logs its raw path, only its prefix and the path rule the request matched, such as `/linear/graphql` or `/echo/api/…`.
- **`upstream.sni` and `upstream.tls`** are read back from the TLS socket after the handshake; on plain-http test routes they are `null`.
- **`detailed` level.** Not built: the level is kept in the route table, and these proposed fields are not written: the header names sent upstream, the dropped client header names, the certificate SANs (first 4) and the upstream `x-trace-id` count, the prototype's R1 proof fields **[E `proto-r1/gateway.py` lines 190-206]**.
- **Never logged at any level.** Bodies, query values, header values or secret bytes.
- **Sanitising [D].** Built as the audit module's own path sanitiser (section 0). It drops the query and replaces every byte outside `[A-Za-z0-9._~/%-]`, so userinfo and credential queries cannot survive.

**Where the lines go and how long they stay [D].**
- Location is `<stateDir>/stages/<runId>/<stage>-<attempt>/egress.jsonl`, mode 0600, in a 0700 directory. It sits beside the stage receipt and is never inside the workspace or any sandbox mount.
- Each file is capped at 32 MiB **[G]**. At the cap, the gateway closes its gate with reason `audit_full` and denies with `audit-unavailable`.
- Retention matches the stage receipt. The proposal is 30 days after the run ends **[G]**. Nothing in the controller prunes state today, so section 9 lists the owner of pruning as open.
- Raw lines never leave the VM, the same rule as raw sessions **[E `docs/design.md` "Ledger and evidence"]**. Live-lane artifacts are redacted copies (section 8.3).

### 6.3 Untrusted text never enters factory output

F04 set the rule that errors, warnings and status carry only text the factory builds itself, and never quote `gh` output, YAML errors, a key or value from `WORKFLOW.md`, or an argument **[E `docs/operations/factory-cli.md` line 14]**. Markers follow it too **[E `src/markers.ts` lines 47-49]**. The gateway keeps it in four ways **[D]**.

- **Receipts, markers, `/factory status`, GitHub comments and the ledger** get only numbers, enum codes, built-in route ids, `declared:<n>` for declared routes, and host-side credential ids. Never a path, header, body, upstream text or a `WORKFLOW.md` string.
- **The agent** sees only the fixed deny body and the code. Unlike `srt`, the gateway does not feed a violations block back to the model **[E `research/prior-art.md` §1.4]**.
- **The runner** never copies a field from `egress.jsonl` into output. It reads only the control-channel `usage` and `summary` events, which are typed numbers and enums.
- **Control-channel input** from the gateway is parsed as strict JSON with a fixed schema. Unknown fields fail the stage. A gateway bug therefore cannot smuggle text into a receipt.

## 7. Sandbox hardening that goes with it

### 7.1 bwrap flags

These are the flags `server/sandbox/bwrap.ts` builds: the prototype's **[E `proto-r1/run_exp3.sh` lines 24-31]** plus additions from prior art **[E `research/prior-art.md` §4.2 "bwrap invocation", recommendation 11]**, as changed in section 0.

```text
env -i PATH=/usr/bin:/bin bwrap
  --unshare-all --die-with-parent --new-session   # no --unshare-user, no --disable-userns (section 0)
  --cap-drop ALL --clearenv
  --hostname factory-sandbox
  --ro-bind /usr /usr  (+ /bin /sbin /lib /lib64 symlinks)
  --proc /proc --dev /dev --tmpfs /tmp --tmpfs /run --tmpfs /home
  <binds from 7.2>
  --seccomp 10                                     # fd 10 carries the compiled filter (7.3)
  --chdir /workspace
  --setenv PATH /opt/factory/bin:/opt/factory/node/bin:/usr/bin:/bin --setenv HOME /home/agent
  --setenv PI_CODING_AGENT_DIR /run/pi-agent  (+ XDG_*, PI_OFFLINE, npm_config_* settings)
  -- /opt/factory/node/bin/node /opt/factory/sandbox/stage-init.ts --port 18080 --socket /run/gw.sock --herdr /opt/factory/bin/herdr -- /opt/factory/bin/pi --mode rpc …
```

- Nested user and mount namespaces are refused by the seccomp `clone`/`unshare` rule in 7.3, not by `--disable-userns`.
- bwrap sets `PR_SET_NO_NEW_PRIVS` when loading `--seccomp` **[G]**. It also runs under the unit's `NoNewPrivileges` **[E `walkthrough/explanation.md` gotcha 3]**.

### 7.2 Filesystem binds

The design starts from an empty root and adds. It never starts from `--ro-bind / /` and subtracts **[E `research/prior-art.md` §4.2 "FS rules"]**.

| Bind | Mode | Source |
|---|---|---|
| `/usr`, plus `/bin`, `/sbin`, `/lib`, `/lib64` symlinks | ro | host **[E proto]** |
| `/etc/ssl`, `/etc/alternatives`, `/etc/nsswitch.conf` | ro | host **[E proto]** |
| `/etc/hosts`, `/etc/passwd`, `/etc/group` | ro | synthetic files from the assets bundle **[D]** |
| `/opt/factory` | ro | the assets bundle `assets-<sha256>/` with Node, Pi, Herdr, packages and `pi-agent/` **[E `walkthrough/explanation.md` C8]** |
| `/workspace` | rw | exactly `<stateDir>/workspaces/<runId>` **[E `server/controller.ts` lines 415-423]** |
| `/run/pi-agent` | rw | a fresh 0700 copy of the bundle's `pi-agent/` template at `<stageDir>/agent-<session>`, with `models.json` and `settings.json` re-bound read-only. Child sessions live in its `sessions/`, so the runner can read child usage **[E `walkthrough/explanation.md` C5]** |
| `/run/gw.sock` | rw bind of one socket | `<stateDir>/gw/<nonce>/gw.sock` (section 2.2) |

`/etc/resolv.conf` is not bound. The prototype bound it only to prove DNS fails for lack of a route **[E `proto-r1/summary.md` exp 2]**.

**Denied, meaning absent from the mount tree [E `docs/plans/factory-v1.md` line 261, `walkthrough/explanation.md` §7 item 10].**
- `/home/exedev` in full. That covers `~/.ssh`, `~/.config`, `~/.local/pi`, mise, the controller checkout and `~/factory-state`.
- Every other path under `<stateDir>`, including claims, other workspaces, other stage directories and every `egress.jsonl`.
- `/var/run/docker.sock` and `/run/docker.sock`.
- `/run/user/1000`, which holds the user bus and the systemd user manager. Reaching it could start an unsandboxed unit **[D]**, the same lever as walkthrough gotcha 5.
- `$SSH_AUTH_SOCK` and `~/.ssh/headless-agent.sock`.
- `/run/credentials`, `/etc/factory`, `/etc/systemd`.
- Host `/tmp`, host `/proc` (a fresh `/proc` is mounted), `/sys` and `/var`.
- The held-out acceptance store (F06b).

Inside the writable workspace, `.git/hooks` and `.git/config` are re-bound read-only. The controller treats every workspace file as untrusted, including symlinks **[E `research/prior-art.md` §4.2, `walkthrough/explanation.md` gotcha 17]**.

### 7.3 seccomp

The filter is a deny list over a default allow, returning `EPERM` **[D]**.

| Deny | Source |
|---|---|
| `io_uring_setup`, `io_uring_enter`, `io_uring_register` | both tools **[E `research/prior-art.md` §1.1, §2.1]** |
| `ptrace`, `process_vm_readv`, `process_vm_writev` | Codex **[E same §2.1]** |
| `socket(AF_VSOCK)` | `srt` **[E same §1.1]** |
| `clone`/`clone3`/`unshare` with `CLONE_NEWUSER` or `CLONE_NEWNS` | `srt` **[E same §1.1]**. `clone3` must return `ENOSYS` so libc falls back to `clone`, where flags are inspectable **[G]** |
| `socket(AF_UNIX)` | **not blocked.** Live result below |
| `bpf`, `perf_event_open`, `userfaultfd`, `keyctl`, `add_key`, `request_key`, `kexec_load`, `kexec_file_load`, `mount`, `umount2`, `pivot_root`, `open_tree`, `move_mount`, `fsopen`, `fsmount`, `fsconfig`, `init_module`, `finit_module` | **[D]**. These are kernel surface, and a kernel escape lands on `exedev` (section 1.2) |

**`AF_UNIX`: the live result.** With `socket(AF_UNIX)` blocked, Herdr's server could not start inside the sandbox (`factory stage-init: herdr unavailable`). With it allowed, Herdr started, split a pane and ran a command in it. So the default stays allowed (`blockUnixSockets: false`), as this design proposed. **The design's reasoning, kept for context: `AF_UNIX` was pending experiment 5 [E `research/prior-art.md` recommendation 11].** `srt` blocks `socket(AF_UNIX)` after its relays start. Codex allows only `socketpair`. Herdr's headless server and Pi's child plumbing may need unix sockets **[G]**. This design mounts no host socket except `gw.sock`, and abstract sockets are netns-scoped **[E `proto-r1/summary.md` exp 2, last bullet, an inference there]**. So a block adds little here. The proposal is to leave `AF_UNIX` allowed unless experiment 5 shows Herdr works under the `socketpair`-only form.

**Filter build [D].** `server/sandbox/seccomp.ts` emits classic BPF bytes directly, with no libseccomp dependency. It checks `AUDIT_ARCH` and the x32 bit first and kills on a foreign arch. The runner writes the bytes to a pipe passed as fd 10. The VM's architecture was not recorded in any log **[G]** that it is x86_64. The build must check it.

### 7.4 User scope

```text
systemd-run --user --scope --quiet --unit=factory-stage-<owner>-<run16>-<stage>-<attempt>-<nonce>
  -p MemoryMax=2G -p TasksMax=512 -p CPUQuota=100% -p TimeoutStopSec=5
  -- env -i … bwrap …
```

- **The pattern is proved.** The prototype ran with `MemoryMax=512M` and `TasksMax=64` **[E `proto-r1/run_exp3.sh` lines 36-38]**. The unit needs `XDG_RUNTIME_DIR=/run/user/1000` **[E `walkthrough/explanation.md` gotcha 2]**.
- **The values are guesses [G]** for a 2-vCPU, 8 GB VM running two stages at once **[E `docs/design.md` "VM"]**. Lane 10 measures them. The design's `socat` forwarder would have forked per connection against `TasksMax`. The built relay does not fork.
- **Cleanup.**
  - The runner closes the gate first. Then it closes Pi's stdin, waits, and runs `systemctl --user stop factory-stage-…`, every wait inside one window bounded by the 10 s reserve **[E `docs/plans/factory-v1.md` line 291]**.
  - At startup, before adopting `running` markers, the controller stops every leftover `factory-stage-<owner>-*` scope it owns **[E `walkthrough/explanation.md` gotcha 6]**. Swap is not limited by the scope; `MemorySwapMax` is not set.
  - The gateway is not in the scope. It dies with the controller (section 2.3).

## 8. Implementation plan

### 8.1 Language

**TypeScript on Node 26 [D].** The evidence supports it.
- **It matches the repo.** The repo is TypeScript on Node 26.12.1, run with type stripping and no build step **[E `docs/operations/factory-cli.md` line 3]**. The gateway shares `npm run check`, the lint rules and `redactCredentials`.
- **It adds no runtime.** Python is on the VM only because the prototype used it **[E `proto-r1/gateway.py`]**. A second runtime adds packaging, pinning and a second test toolchain.
- **One event loop helps the gate.** It makes the gate flip atomic with respect to admission (section 5.1) with no locks.
- **The core parser is strict.** `node:http` uses llhttp, which is strict by default and rejects a request with both `Content-Length` and `Transfer-Encoding` **[G]**.

**Node-specific hazards the build must handle [G], each with a unit test.**
- Read `rawHeaders`, not `headers`. Node folds duplicate `Host` into one value.
- Install explicit `connect` and `upgrade` listeners that send `403`, and a `clientError` handler that sends a fixed 400 and closes.
- Set `headersTimeout`, `requestTimeout`, `maxHeaderSize` and `maxHeadersCount`.
- Never set `insecureHTTPParser`.
- Use no `fetch` and no npm dependency in the gateway.
- Chunked request bodies. The prototype denied them **[E `proto-r1/gateway.py` line 167]**. Whether Pi's SDK sends them is unknown. The proposal is to accept chunked bodies, buffer them up to `maxRequestBytes`, and re-frame with `Content-Length`.

### 8.2 Module layout

`server/sandbox/` is in the F05 file list **[E `docs/plans/factory-v1.md` line 252]**.

| File | Role | Pure? |
|---|---|---|
| `server/sandbox.ts` | `sandboxExecutor()`, the runner. It drives the lifecycle in 2.2, the gate in 5.2 and the receipt. | no |
| `server/sandbox/routes.ts` | The 3.2 types, the built-in routes, table validation and the forbidden-upstream list | yes |
| `server/sandbox/policy.ts` | `decide(request, table, gateState) → allow \| deny(code)`, covering target, path, headers, method, query and body | yes |
| `server/sandbox/gateway.ts` | The unix-socket HTTP server, upstream client, streaming, response filter and reflection scanner | no |
| `server/sandbox/gateway-main.ts` | The process entry. It reads the table from stdin, loads credentials and runs the control channel | no |
| `server/sandbox/credentials.ts` | Loading from `$CREDENTIALS_DIRECTORY` and the ceiling check. Encoded forms for the scanner | yes, apart from the read |
| `server/sandbox/audit.ts` | Line building, path redaction and the size cap | yes, apart from the write |
| `server/sandbox/meter.ts` | The `openai-responses-sse` usage parser | yes |
| `server/sandbox/bwrap.ts` | The argv builder from section 7 | yes |
| `server/sandbox/seccomp.ts` | The cBPF emitter | yes |
| `server/sandbox/scope.ts` | `systemd-run` and `systemctl` calls and the leftover-scope reconcile | no |
| `server/sandbox/assets/stage-init.ts` | The in-sandbox init. It starts the loopback relay and a headless Herdr server, then runs Pi. It ships in the assets bundle | no |
| `server/sandbox/assets/pi.ts` | The only `pi` on the sandbox PATH. It forces `--no-mcp --no-approve --no-context-files --no-extensions`, narrows `--tools` to the stage allowlist and refuses any flag outside its own allowlist, for the parent and every child | no |
| `server/sandbox/manifest.ts` | The bundle manifest and its sha256, the assets digest | yes, apart from the read |
| `server/sandbox/preflight.ts` | The runner preflight | no |

### 8.3 Test plan

**Units, in `test/sandbox.test.ts` [E `docs/plans/factory-v1.md` line 252, which names one test file] [D].**
- **`policy`.** Every 6.1 code, from a table-driven list that includes every prototype exp 3 probe **[E `proto-r1/exp3_inside.sh`]**.
- **Path canonicalisation.** Dot segments, `%2e`, `%2E%2E%2F`, `%252e`, `//`, `%5c` and control bytes.
- **Rule semantics.** Segment-boundary prefix and glob matching. Query key rules. Each JSON constraint kind, including a non-array `/tools` and a missing pointer.
- **`routes`.** Unknown fields rejected. Credentialed `http` rejected. A declared route outside its ceiling rejected. Forbidden upstreams rejected, including `*.exe.xyz`, GitHub hosts and IP literals.
- **`gateway`, against a local fixture upstream over a real unix socket.**
  - The upstream request is built from scratch.
  - Client `Authorization` is stripped.
  - The credential header is set.
  - The response header allowlist holds.
  - The reflection scan blocks in headers, in the body, and across a chunk boundary, for raw, base64 and percent-encoded forms.
  - `redirect-refused`, `response-blocked` on a compressed body, and `rate-limited` all fire.
  - The gate flip denies the next request while an in-flight stream completes.
  - `drain_abort` works.
  - Control-stdin EOF exits.
  - `audit-unavailable` fires on a write failure.
- **`meter`.** A real SSE transcript shaped like `exp3b-completion.log`, a stream with no usage event, and a split `data:` line.
- **`bwrap` and `seccomp`.** Golden argv. No denied path appears as a bind source. The BPF program decodes to the intended rules.
- **Runner.** Lifecycle order (mkdir, spawn, ready, probe, launch). A pre-existing `gw/` fails. A gateway exit fails the stage.

Mocked network tests are units, not the isolation proof **[E `docs/plans/factory-v1.md` line 271]**.

**Live lanes, one to one [E `docs/plans/factory-v1.md` lines 276-282].**

| Lane | Artifact | What the gateway design must show |
|---|---|---|
| 2 | `model-egress.log` | Pi in the real stage sandbox gets an answer via `model-openai`. The audit has `upstream.host = sni = llm.int.exe.xyz` and `credential: null`. A grep of the sandbox env and `/opt/factory` finds no provider key. `model-xai` is `route-closed` until a refusal |
| 3 | `npm-egress.log` | `npm install --ignore-scripts --no-audit <pinned pkg>` works. Every audit line is route `npm` with upstream `registry.npmjs.org`. Tarball integrity matches. No other upstream appears |
| 4 | `github-denied.log` | From the stage, `gh`, curl to `github.int.exe.xyz` and `api.github.com` by name and IP, and `/github/...` through the forwarder all fail. Through the gateway they are 403 `no-route`, `bad-host` or `forbidden-header`, with `upstream: null` |
| 5 | `egress-bypass.log` | Re-run the exp 2 and exp 3 suites **[E `proto-r1/exp2_inside.sh`, `proto-r1/exp3_inside.sh`]** inside the production sandbox, with seccomp and `--cap-drop ALL`. Add `TRACE`, `Upgrade: h2c`, the h2 prior-knowledge preface, duplicate `Host`, `CL`+`TE`, and a hosted-tool body (`tools:[{type:"mcp"}]`) with `max_output_tokens:1`, which must be `body-not-allowed` with no upstream. Allowed routes still work |
| 6 | `mount-denied.log` | Every path in the 7.2 denied list is absent, including `/run/user/1000/bus`, `/run/credentials` and other workspaces |
| 8 | `budget-stop.json` | With a tiny cap, the audit shows `gate_closed` and then only `budget-closed` denies. Pi auto-retry and child attempts appear as denies, not forwards. The receipt says `budget_exhausted` and its `egress` summary matches the audit counts |

**Extra harness lane 5b, not one of the plan's ten [D].** A host-side harness runs the production gateway binary against a host-side echo fixture with a dummy credential. This is the only place a `scheme: http` upstream is allowed, in a test-built table. It runs the four checks of prior-art recommendation 13 **[E `research/prior-art.md` recommendation 13]**. They are reflection blocked, a method or path outside the allowlist denied, forged `Authorization` replaced, and a redirect refused. The prototype's `/__fixture/` route is the precedent **[E `proto-r1/gateway.py` lines 24 and 67]**. The production runner has no way to build such a table.

### 8.4 What is copied from prior art, and what is not

Numbers are `research/prior-art.md` §5 recommendations.

| # | Item | Here | Reason |
|---|---|---|---|
| 1 | Path-routed rewrite, no CONNECT or SNI allowlist | copied | R1 evidence (1.3) |
| 2 | Credential bound to a route; Codex segment-boundary prefix | copied, schema widened | adds query, body and header rules and a host-side ceiling |
| 3 | Deny by default inside a credentialed route | copied | 3.1 |
| 4 | Strip then set | copied | 3.5, 4.3 |
| 5 | No plaintext inject, no redirects, no `TRACE`/`TRACK`/`CONNECT` | copied | 4.4 |
| 6 | Response scrub and reflection check | copied, extended | adds encoded forms, streaming hold-back and a request-side tripwire |
| 7 | Secrets by reference in the gateway only | copied in part | file via `LoadCredential` only. **Env-var secrets not copied**, because env leaks to children |
| 8 | One gateway per stage | copied | 2.1 |
| 9 | Durable JSON audit per request | copied | 6.2. `srt`'s 100-line in-memory tail is not copied |
| 10 | 403 with `X-Proxy-Error` and connection close | copied | **The per-route reason string (`srt deniedDomainReasons`) is not copied**, because it would put config text in output (6.3) |
| 11 | `--cap-drop ALL`, fresh `/proc`, NNP, seccomp list | copied | `AF_UNIX` stays allowed: Herdr needs it (7.3). `--disable-userns` not used (section 0) |
| 12 | Inherited-fd bridge | **not copied** | 2.2. The race was ordering, and the fd form needs a custom multiplexer |
| 13 | Four credential tests | copied | lane 5b |
| 14 | No MITM, sentinels, SOCKS5, `x-unix-socket` or iptables | kept out | no CA in clients, nothing in sandbox env, no client-named upstream |
| n/a | `srt` per-session proxy token | **not copied** | the socket is mounted only into its own sandbox, and same-uid host processes already have the network |
| n/a | `srt` violations block fed to the model | **not copied** | untrusted text in model context, and the agent needs only the code |
| n/a | Codex `version` field and `deny_unknown_fields` | copied | 3.1 |
| n/a | Codex exact-value header placeholder | **not copied** | no sentinels exist to replace |
| n/a | `srt` resolve-once and dial the checked address | copied | 3.6 |
| n/a | Codex HTTP/2 to the upstream | **not copied** | HTTP/1.1 only, so `:authority` cannot diverge |

## 9. Open questions, as the build answered them

1. **Pi's real requests.** Pi 1.4.0 sent `POST /openai/v1/responses` with `stream: true`. A child call is the same shape. The gateway accepts chunked bodies and re-frames them. Body sizes late in a long build are still unmeasured: the F05 probes are one or two turns.
2. **The xai provider.** Responses API, the same paths and meter as `model-openai` (section 0). No xAI completion was made in F05.
3. **Hosted tools.** Not tested against the edge. The body constraint denies them before any upstream request: a `tools:[{type:"mcp"}]` body got `403 body-not-allowed` from inside the sandbox.
4. **`AF_UNIX` under Herdr.** Blocking it stops Herdr's server. It stays allowed (7.3).
5. **bwrap details.** `--disable-userns` is not used (section 0). The socket stays a read-write bind. The VM is x86_64, and the seccomp filter fails closed on any other architecture.
6. **Lifetime at controller death.** Proven on the VM: `kill -9` of a scoped `serve` during a stage took the sandbox, its Herdr server and the gateway down with it within 2 s, and the scope went inactive. Startup reconcile then stopped a planted leftover `factory-stage-*` scope by name before the restarted controller adopted the `running` run as interrupted and retried it.
7. **The user manager.** `factory.service` sets `XDG_RUNTIME_DIR=/run/user/1000`. Linger is on for `exedev`. A real system unit was not run, because installing one was out of scope. The proof used a controller started by hand with the same variable.
8. **npm tarball URLs.** npm rewrites them to the registry prefix. `npm install --ignore-scripts is-number@7.0.0` worked inside the sandbox with no query string.
9. **`LoadCredential` on the VM.** Not exercised: F05 ships no secret.
10. **Audit retention.** Still open. Nothing prunes `<stateDir>/stages/`.
11. **Pi on 403.** Settled in proto-runtime exp 7: `out of budget` in the body stops Pi retrying.
12. **Gateway self-sandboxing.** Deferred past v1.
13. **`WORKFLOW.md` `egress` parsing.** Deferred to the first integration, as the brief settles.
