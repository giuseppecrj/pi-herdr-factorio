# Headless Herdr on a GitHub-hosted Ubuntu runner

**Verdict: VERIFIED — 2026-10-28.**

`pi-herdr-agents`' real `subagent` tool can launch a Pi child in a headless
Herdr pane on a GitHub-hosted Ubuntu runner, and deliver its result to the
still-running parent. Unit 1 of `docs/design.md` does not need a sequential
fallback solely because CI has no attached terminal client.

## Evidence

- [Passing CI run 40768344796](https://github.com/giuseppecrj/pi-herdr-factorio/actions/runs/40768344796)
- [Probe job and logs](https://github.com/giuseppecrj/pi-herdr-factorio/actions/runs/40768344796/job/123098473635)
- Tested commit: `a8f1285bb4e358bcfe6d56b4e7234b14fdaa2299`.
- Runner: GitHub-hosted `ubuntu-latest`, observed Ubuntu **24.04.5**, x86_64;
  Node **22.23.4**. This is not a claim about every future `ubuntu-latest` image.
- Versions: Herdr **0.9.5** (release binary, SHA-256 checked), npm Pi **1.4.0**,
  `pi-herdr-agents` **3.3.1**, CLIProxyAPI provider **1.4.24**.
- Parent and child: `cliproxyapi/claude-haiku-5-5`, requested thinking `low`.
- CI attempts: **1 of the authorized maximum 6**, successful on the first run.

The public job log contains:

```text
versions: pi=1.4.0 herdr=0.9.5 pi-herdr-agents=3.3.1 provider=1.4.24
headless server ready; setup_seconds=10
VERIFIED: parent received subagent_result containing herdr-child-ok
checks: one bare child; requested model; exit=0; child session token; parent acknowledgement
probe total_seconds=22
```

This is stronger than grepping terminal output for a token mentioned in the
prompt. The driver checks the parent's RPC event stream for exactly one
`subagent` call with the prescribed arguments, then a host-generated
`subagent_result` with the child's name, successful exit code, and token.
It reads the completed child's session **once**, verifies its final assistant
text is exactly `herdr-child-ok`, verifies the model identity and absence of
child tool calls, and requires a subsequent parent assistant response of
`herdr-parent-received`. A parent merely echoing the expected token fails.
Raw RPC records and sessions are deliberately not uploaded.

## Driver and isolation

Run `scripts/herdr-probe.sh` with Herdr 0.9.5, Node/npm, Python 3, and the two
`CLIPROXYAPI_*` credentials already available. The script installs the pinned
npm packages; it needs network access to npm and the model proxy.

1. Create a private `mktemp` directory and re-exec with `env -i`, preserving
   only PATH and the required proxy credentials, with disposable HOME, XDG
   directories, and `PI_CODING_AGENT_DIR`. No caller `HERDR_SOCKET_PATH`, pane
   IDs, or `PI_SUBAGENT_*` identity can leak into the experiment.
2. Start `herdr --session factory-probe server` without a TUI client. Its
   config, named-session socket, state, and workspace all live in that directory.
3. Create a workspace/pane and run a Python RPC client there. It starts the
   parent `pi --mode rpc`, with only the `subagent` tool enabled and no project
   context or MCP. Herdr injects the parent's actual pane/socket identity.
4. Prompt the parent to start one standalone bare child (`fork: false`, no
   role or worktree); the child only has `read` available and is instructed to
   call no tools. The parent remains alive for asynchronous result delivery.
5. Consume RPC events with a 180-second deadline, validate the evidence, then
   stop only the isolated named server and delete its private directory.

The outer CI command has a five-minute timeout; the job has a ten-minute
limit. The workflow uses the smoke workflow's pinned Node, Tailscale, and
checkout actions, joins with `secrets.TS_AUTHKEY`, reuses the masked proxy-path
check, and grants only `contents: read`. No session artifacts are uploaded.
`PROBE_KEEP=1` retains private diagnostics for local debugging only; it is not
set in CI. This is configuration/session isolation, not an OS security sandbox.

## What broke locally, and the fix

The first isolated local attempt used the machine's standalone Pi 1.4.0 binary.
Herdr started successfully, but the provider failed before the parent could
launch a child:

```text
Codex protocol stream is unavailable for provider: cliproxyapi
(api: cliproxyapi-codex-responses)
```

Its private stderr identified the cause: `Cannot resolve
openai-codex-responses.js`. With HOME replaced, the provider could not find
the physical `pi-ai` source it patches. This was a Pi distribution/source
lookup problem, not a headless Herdr limitation. Installing the **npm** Pi
1.4.0 distribution in the disposable environment fixed it, matching the
working smoke workflow's distribution. No provider or host code was patched.
Docker was unavailable locally; the real hosted Ubuntu run supplied the
platform-fidelity check. The final local revision also passed (4 seconds
setup, 13 seconds total). The user's running Herdr session was not targeted.

## Setup cost and limits

Observed CI timings, not performance guarantees:

| Measurement | Seconds |
| --- | ---: |
| Herdr download, checksum, chmod | <1 (`herdr_install_seconds=0`, integer resolution) |
| Isolated npm Pi/provider/host install + server/workspace readiness | 10 |
| Probe including model calls, result delivery, and cleanup | 22 |
| Job start through headless readiness, including tailnet/path setup | approximately 20 |
| Entire job, including action cleanup | 34 |

`bash -n`, active shell/YAML diagnostics, and `git diff --check` also passed.
The Tailscale action emitted an authkey deprecation warning, but joining and
model access succeeded; changing authentication is outside this prototype.

**Recommendation:** use a persistent parent (RPC or interactive Pi) inside
headless Herdr for CI orchestration. Do not replace that parent with a one-shot
`pi -p` invocation and assume it remains available for asynchronous delivery.
This proves the transport primitive needed by pstack fan-out, **not** full
`interrogate`, `architect`, or `swarm` executions, concurrent multi-child
capacity, worktree children, or independent model-family review. Those remain
integration checks for later units, not blockers discovered by this probe.
