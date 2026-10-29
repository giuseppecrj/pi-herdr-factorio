# Sandboxed Pi stages on `pi-factorio`: prototype receipts

These are the two prototypes that settled F05's design before the build: risk R1 (egress) and the stage runtime. Each subdirectory holds the scripts that ran on the VM and the logs they wrote, copied from the F05 decision trail. The built system is described in `docs/operations/sandbox.md`.

Both ran on 2026-10-29 in scratch dirs under `/home/exedev`, which were deleted afterwards (`*/vm-cleanup.log`). bwrap was 0.9.0, Node 26.12.1, Pi 1.4.0 and Herdr 0.9.5.

## `r1/`: egress (risk R1)

| Experiment | Result | Log |
| --- | --- | --- |
| 1. How the exe.dev edge routes | It picks the backend from the absolute-form authority, else h2 `:authority`, else `Host`. It ignores SNI and forwarding headers. So CONNECT, SNI and IP allowlists cannot separate `llm.int.exe.xyz` from `github.int.exe.xyz`. | `exp1-edge-routing.log`, `exp1-table.txt` |
| 2. Network bypass from a bwrap netns | No route and no DNS across 238 probes. | `exp2-netns-bypass.log` |
| 3. A rewrite-everything gateway | Every forged `Host`, forwarding header, absolute URL, `CONNECT` and disallowed method got 403 with no upstream. Every forward sent `Host = SNI` of the route. | `exp3-gateway.log` |
| 3b. One real completion through it | `gpt-6.1-sol` answered on `/openai/v1/responses` with `stream: true`. | `exp3b-completion.log` |

`summary.md` has the full write-up. The `attempt`, `run1` and `run2` logs are discarded attempts, kept with the reason each failed. `run2-socket-race` is the stale-socket race the built gateway avoids by never reusing its directory.

## `runtime/`: the stage runtime (experiments 4 to 10)

| Experiment | Result | Log |
| --- | --- | --- |
| 4. Pi RPC in the sandbox | npm and standalone Pi both work over a `http://` forwarder. The agent dir must be writable. | `exp4-pi-rpc.log` |
| 5. Real Herdr fan-out | A parent and one bare child run inside the sandbox. The parent settles once before the child result and once after it. Child usage is only in the child's session file. | `exp5-herdr-fanout.log` |
| 6. Limits and cleanup | OOM stays in its scope, a named stop takes 24 ms, and `--die-with-parent` decides whether a sandbox survives its launcher. | `exp6-limits-cleanup.log` |
| 7. Budget gate | Closing admission stops every further request, including Pi's retries. A body with `out of budget` stops Pi retrying. | `exp7-budget-gate.log` |
| 8. Refusal surface | Structured refusal shapes against a fake upstream. A Responses `refusal` text part is not detectable. | `exp8-refusal-surface.log` |
| 9. npm through the gateway | `npm install --ignore-scripts` works, and tarballs follow the registry prefix. | `exp9-npm-gateway.log` |
| 10. Mount denial | 36 of 36 checks pass once bwrap starts under `env -i`. | `exp10-mount-denial.log` |

`summary.md` has the full write-up, and `raw/` has the RPC events and gateway logs. The raw sandbox workspaces (`raw/ws-exp5`, `ws-exp6`, `ws-exp9`) stay in the trail and are not copied here. They hold session files with model text.

Tokens spent across both prototypes: 12,234 `openai/gpt-6.1-sol` tokens in the runtime prototype and one tiny completion in R1. No xAI calls were made, and no request reached GitHub.
