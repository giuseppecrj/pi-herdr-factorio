# Weekly maintenance proposals

The factory runs four small, read-only audits when ticket work leaves capacity. It files findings as `factory:proposed` issues for the owner to read. It never edits code, opens a PR, applies a correction or labels a proposal ready. The owner decides whether a proposal becomes a ticket.

## Jobs and limits

Trusted `.github/factory/WORKFLOW.md` on `main` carries `cadence.weeklyTokenCap` and four fixed jobs under `cadence.jobs`. A missing cadence section disables new audits. Unknown jobs and fields are rejected. Jobs accept `dayUtc` (Sunday 0 through Saturday 6), `hourUtc`, `minuteUtc`, `model`, `maxTokens`, `maxTurns` and `wallMs`. There is no cron expression, local timezone, executable command or arbitrary skill selection.

| Job | Default due time | Skill |
| --- | --- | --- |
| `architecture` | Monday 03:00 UTC | `improve-codebase-architecture`, including domain modeling |
| `security` | Tuesday 03:00 UTC | `security-review` in repository-scope mode, including existing defects |
| `instructions` | Wednesday 03:00 UTC | `audit-instructions` |
| `hygiene` | Thursday 03:00 UTC | `agent-loop-hygiene` with a bounded redacted ledger excerpt |

Each job defaults to 40,000 tokens, 12 turns and 10 minutes, including preparation. The parser permits lower limits, not increases above those bounds. The sandbox keeps its existing 10-second cleanup reserve. Models are OpenAI only; maintenance grants no Anthropic or xAI spend. No refusal fallback runs. The weekly allowance defaults to 200,000 tokens, reset by the Monday 00:00 UTC accounting window. Dollar pricing and a dollar cap are unavailable, not zero.

Before launch the controller reserves the entire job allowance against that week's maintenance charges. A reservation that would exceed the weekly allowance records `budget` and launches nothing. A retained execution without a valid receipt keeps its complete reservation as an inexact charge. A settled receipt replaces that reservation with its charged tokens; ticket budgets are not borrowed or replenished.

A new installation waits until a job's due time in the current UTC week. Existing watermarks allow an overdue window to be caught up once, not an unbounded replay of missed weeks. No-delta, failed and completed proposal runs advance the watermark; a failed audit is not retried with a fresh allowance in the same window. Pending proposal publication must be reconciled before another audit starts. The explicit one-shot command may select the latest weekly window before a fresh job's first scheduled due time, but never repeats a completed window.

## Read-only scope

`maintain` is a closed sandbox stage, separate from ticket `Stage`. Its identity is `cadence/<job>/<windowStart>`; its execution digest binds repository and identity. It invents no issue, ready event, admission, ticket claim or terminal ticket-ledger row.

The controller extracts a pinned `main` snapshot. Pi receives only read, grep and ls, with no extension or child delegation. The entire repository workspace is mounted read-only. An empty `.git` mountpoint is prepared before launch and masked read-only. The agent/session directory remains writable so Pi can record its own session. The gateway exposes the pinned model route only, without npm or GitHub. All model work, turns, wall time, request ceilings, token metering, cleanup and native receipts use the normal sandbox transport.

Each execution audits one rotating path group:

1. `src`
2. `server`
3. `test`
4. `skills`, `.github`, `AGENTS.md`, `DESIGN.md`
5. `docs`, `extension`, `scripts` and the named root project/configuration files

The rotation advances with the due watermark. Prompts bound the file map to 250 entries and recommend at most eight read-only tool calls; the hard limits are the gateway's request/turn, token and wall ceilings, not a claim that the tool-call recommendation is enforced. Findings must cite actual line ranges inside the selected group. Other groups are explicitly uncovered. The hygiene excerpt contains at most 20 locally retained redacted ledger rows and 16 KiB, never private sessions or held-out artifacts. A missing row or field is unknown, not success or zero cost.

## Scheduling and switches

The controller evaluates cadence after ticket reservations, retries and new-ticket dispatch. At most one maintenance execution reserves a slot. Recovery, ordinary dispatch and candidate launches share the same occupied-slot calculation. An audit never evicts a ticket. A ticket arriving during an audit can wait for its bounded settlement; audits are not preemptive.

The tick starts the audit promise and returns; it never waits for the model, checkout or proposal publication. Later ticks observe the retained work. No second daemon, cron job or watchdog extension is installed. Scoped ticket controllers using `--issue` do not schedule unrelated maintenance; use a separate fixture state and the explicit cadence command for an audit.

A launch requires both factory switches, a valid trusted workflow, spare capacity and sandbox preflight. Both switches are checked again immediately before transport launch and separately before each proposed issue is created. Any local `disabled` entry holds publication. A repository label must be named exactly `factory:enabled`. While disabled, a subsequent tick aborts running maintenance and retains unfinished publication. The controller never creates or deletes that repository switch. Normal service shutdown also aborts and waits for the bounded audit cleanup.

## State and deduplication

Private state lives below `<state-dir>/cadence/<job>/`, with 0700 directories and 0600 controller records:

- `state.json` holds the due watermark, rotation and pending window.
- `executions/<windowStart>/input.json` records ownership, repository/base SHA, trusted workflow SHA/digest, model, allowance, rotation and accounting week before launch.
- `prompt.txt` keeps the exact private prompt and bounded ledger inputs.
- `tree/` is the pinned audit checkout; the model cannot modify it.
- `runtime/` contains native receipt, usage checkpoint, output, gateway audit and sessions, using stage `maintain` and the execution digest rather than a ticket ID.
- `receipt.json` records the audit result, charged tokens, exactness, answering model and native receipt digest. An empty proposal list records `no_delta`.
- `proposals/<fingerprint>.json` keeps each immutable issue title/body intent.

On restart the normal executor stops this controller's leftover scopes before cadence reads retained receipts. Cadence never blindly replays an owned model execution. A completed passing output is reused; missing completion becomes `interrupted` with its conservative reservation. Corrupt or overlapping state blocks cadence rather than granting another execution.

The controller validates at most ten proposals per run. Each has `job`, `repo`, `baseSha`, `fingerprint`, `title`, `claim`, `evidence[]` with path/start/end, `limits` and `provenance`. A fingerprint is a stable lowercase 64-hex finding identifier independent of the week and base SHA. Model-provided text is bounded, redacted and escaped. The issue explains the finding, impact, source links at the pinned SHA and what the audit could not check. Its footer names job, skill, model, base SHA and receipt digest.

Deduplication uses the exact marker line:

```text
<!-- factory:cadence <repo> <job> <fingerprint> -->
```

It is not a `factory:run` marker and proves no ticket outcome. Before any create, the controller persists the intent, lists issues including closed and relabeled issues, matches the marker and rechecks both switches. An ambiguous create ends this publication slice; the next tick must list and reconcile remote issues before any retry. An unavailable or incomplete list never authorizes a create. More than one matching issue blocks publication. Existing issues are not rewritten or relabeled.

Maintenance accounting stays under `cadence/`. `status --json` includes a separate `accounting.maintenance` line, and `durableUsage.total` includes those charges once, with a maintenance subtotal when present. There are no extra ticket claims or ledger run rows, so maintenance does not enter the F12a ticket-outcome metric. The current owner feed has no maintenance run cards; its durable token total includes maintenance honestly.

## One-shot command

```bash
node server/cli.ts cadence --once --job architecture --json \
  --repo giuseppecrj/pi-herdr-factorio --state-dir "$STATE"
```

Jobs are `architecture`, `security`, `instructions` and `hygiene`. `--once`, `--job`, `--repo` and `--state-dir` are required. JSON is always returned; `--json` is accepted for consistency. The command rejects extra flags and positional arguments, uses the controller's private-directory validation, bot identity check and single-authority lock, and reads the trusted workflow from `main`. It waits for bounded settlement using the same executor. It does not dispatch or claim ticket work. Pending ready tickets and retained ticket reservations have priority.

Exit 0 means the selected window completed as `proposed` or `no_delta`, including an already completed window. Exit 1 means a switch, capacity, policy, budget, preflight, recovery, audit failure or pending-publication gate prevented that result. Exit 2 means invalid arguments or an already running controller. Run it only on an authorized isolated state directory when the normal controller owns production. No status subcommand is provided.

## Local verification

```bash
TMPDIR="$HOME/.cache/f11t" FACTORY_REQUIRE_SANDBOX_TESTS=1 \
  node --test test/cadence.test.ts
```

The native one-shot demo uses the real CLI, lock, sandbox executor, Pi RPC, bubblewrap, user systemd scopes, gateway and receipts. Only GitHub and the model upstream are fixtures. It files two proposals on the first command and none on the second, verifies an unchanged checkout, proves the read-only mount refuses a shell write, and withholds a model response to prove the scheduled tick does not wait. Fixture state and its temporary asset bundle are isolated and removed by the test. A working user bus is mandatory with `FACTORY_REQUIRE_SANDBOX_TESTS=1`; otherwise that native case explicitly skips when the bus is unavailable.

Saved-state tests separately exercise watermarks, no delta, restart overlap, unknown-create reconciliation, switches, budgets, scope rotation and escaping. They are not live VM/model evidence. The plan's ten live lanes and interleaved VM perf remain separate coordinator verification. Changed skills require sandbox bundle provisioning before a production audit can pass the stale-bundle check.
