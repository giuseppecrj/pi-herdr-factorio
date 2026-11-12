# Weekly maintenance proposals

The factory runs five small, read-only audits when ticket work leaves capacity. It files findings as `factory:proposed` issues for the owner to read. It never edits code, opens a PR, applies a correction or labels a proposal ready. The owner decides whether a proposal becomes a ticket.

## Jobs and limits

Trusted `.github/factory/WORKFLOW.md` on `main` carries `cadence.weeklyTokenCap` and five fixed jobs under `cadence.jobs`. A missing cadence section disables new audits. Unknown jobs and fields are rejected. Jobs accept `dayUtc` (Sunday 0 through Saturday 6), `hourUtc`, `minuteUtc`, `model`, `maxTokens`, `maxTurns` and `wallMs`. There is no cron expression, local timezone, executable command or arbitrary skill selection.

| Job | Default due time | Skill |
| --- | --- | --- |
| `architecture` | Monday 03:00 UTC | `improve-codebase-architecture`, including domain modeling |
| `security` | Tuesday 03:00 UTC | `security-review` in repository-scope mode, including existing defects |
| `instructions` | Wednesday 03:00 UTC | `audit-instructions` |
| `hygiene` | Thursday 03:00 UTC | `agent-loop-hygiene` with a bounded redacted ledger excerpt |
| `reflect` | Friday 03:00 UTC | `reflect-ledger` and `agent-loop-spec` over redacted ledger rows and scores |

Each job defaults to 36,000 tokens, 2 turns and 10 minutes, including preparation. The parser permits up to the existing 12-turn configuration bound, but maintenance always has a single model-request ceiling and no tools. There is no retry headroom within an audit. A transient upstream failure or Pi retry can end that week's job. A second full prompt could exceed 40,000 tokens. The failed window advances normally; no hidden retry spends another allowance. The parser's 40,000-token maximum and wall bound are unchanged. The sandbox keeps its existing 10-second cleanup reserve. Models are OpenAI only; maintenance grants no Anthropic or xAI spend. No refusal fallback runs. The weekly allowance defaults to 200,000 tokens, reset by the Monday 00:00 UTC accounting window. Dollar pricing and a dollar cap are unavailable, not zero.

The five scheduled allowances total 5 × 36,000 = 180,000 tokens, leaving 20,000 of catch-up headroom under the unchanged 200,000 weekly cap. Reflect uses the same reservation and accounting rules as the other jobs.

Before launch the controller reserves the entire job allowance against that week's maintenance charges. A reservation that would exceed the weekly allowance records `budget` and launches nothing. A retained execution without a valid receipt keeps its complete reservation as an inexact charge. A settled receipt replaces that reservation with its charged tokens; ticket budgets are not borrowed or replenished.

A new installation waits until a job's due time in the current UTC week. Existing watermarks allow an overdue window to be caught up once, not an unbounded replay of missed weeks. No-delta, spent failures and completed proposal runs advance the watermark; model work is never replayed with a fresh allowance in the same window. A confirmed failure before launch leaves the watermark and rotation unchanged and retries on later ticks. Preparation and publication failures use durable exponential backoff, from 10 seconds up to 5 minutes. Pending proposal publication must be reconciled before another audit starts. The explicit one-shot command may select the latest weekly window before a fresh job's first scheduled due time, but never repeats a completed window.

## Read-only scope

`maintain` is a closed sandbox stage, separate from ticket `Stage`. Its identity is `cadence/<job>/<windowStart>`; its execution digest binds repository and identity. It invents no issue, ready event, admission, ticket claim or terminal ticket-ledger row.

The controller extracts a pinned `main` snapshot. The controller builds a bounded, line-numbered excerpt before launch. Pi receives no tools, extensions or child delegation and answers in one pass. The entire repository workspace is mounted read-only. An empty `.git` mountpoint is prepared before launch and masked read-only. The agent/session directory remains writable so Pi can record its own session. The gateway exposes the pinned model route only, without npm or GitHub. All model work, turns, wall time, request ceilings, token metering, cleanup and native receipts use the normal sandbox transport.

Architecture and security audit changed files first, then one rotating path group. Hygiene and reflect receive the bounded redacted ledger plus the same source selection, so their proposals can still cite real repository lines:

1. `src`
2. `server`
3. `test`
4. `skills`, `.github`, `AGENTS.md`, `DESIGN.md`
5. `docs`, `extension`, `scripts`, `research`, `tools`, tracked `.pi` files and the named root project/configuration files

Instruction audits select `AGENTS.md`, `.github/factory/WORKFLOW.md` and `skills/*/SKILL.md` from their first run, independently of the code path groups.

Each complete, numbered window is capped at 8 KiB. The serialized source excerpt is capped at 32 KiB, including paths, line labels, visible ranges and skipped ranges. Reflect reduces that source cap to 8 KiB to leave room for its ledger and score inputs. Leading comments and import blocks are skipped without renumbering the remaining lines. Lines too large to fit a window are skipped whole, never cut in the middle of a label or source line. Lockfiles, generated filenames, `host/viewer/design/tokens.*`, `LICENSE`, fixtures, research and prototype archives are excluded. Binary files, unsafe paths, held-out acceptance and files over the citation validator's 1 MiB bound are omitted.

Before assembly, the controller reads this job's last audited base SHA from its watermark state. That SHA survives receipt pruning and zero-token failures. Older state falls back to the last retained, charged execution. It runs `git diff --name-only --no-renames -z <previous-base> <current-base> --` in the controller's own pinned source checkout. This compares immutable local Git objects, never the working-tree diff, audit export or a GitHub compare endpoint. Missing local history records `changes_unavailable` before launch rather than inventing an empty change set. A first run without a previous audit uses rotation alone.

Changed files, including those outside the rotating group, get the first half of the excerpt. Their windows advance each weekly execution. The remaining space goes to sorted windows packed into rotating parts, including file tails. Each return to a group selects its next part; instruction parts rotate every run. On a stable snapshot with no changed-first selection, every eligible non-import line that fits a window is eventually shown. Repository growth or a changed-first slice changes the packing, so the frozen cycle is not a promise about a moving repository. Unshown changed files, skipped ranges and omitted callers remain unknown.

Existing-proposal context is capped at 4 KiB, with omissions reported. Proposals whose primary path is shown come first, and closed proposals precede open ones within that priority. This ordering applies before both the 100-entry ownership limit and the prompt byte limit. Remote and local publication deduplication is unchanged. Findings must cite ranges fully contained in the delivered excerpt, not just valid lines somewhere in the pinned file. Other files and parts are explicitly uncovered. The hygiene excerpt contains at most 20 locally retained redacted ledger rows and 16 KiB, never private sessions or held-out artifacts. A missing row or field is unknown, not success or zero cost.

## Reflect evidence

Reflect reads at most 20 retained redacted ledger rows within 16 KiB, plus at most 8 KiB of latest local score events. The score projection contains IDs, run and scorer IDs, timestamps, status, label, score, passing threshold and input digest. It contains no judge reasoning, transcripts or held-out tests. Missing rows, events and receipts remain unknown. `excerpt.json` freezes both projections and the supplied primary-metric status before launch.

Reflect returns at most three proposals. Each adds `baseline`, `change` and `keepOrReject`, each 1–1200 characters, to the normal proposal fields. The issue begins with F12a's primary metric from the local snapshot, including pending, stale or unavailable status. Scores and token savings cannot substitute for primary improvement. The owner alone decides whether to authorize an experiment.

Evidence can cite visible repository lines or these virtual paths with `start: 1, end: 1`:

- `ledger/<runId>/<field.path>` must identify a row and field present in the frozen excerpt.
- `scores/<eventId>` must identify an event present in the frozen score projection.
- `receipts/<digest>` must occur in a supplied row's `redactedReceiptDigests`. This proves only that the redacted row names the digest, not that reflect read a private receipt.

The publisher removes invented citations and drops findings with no remaining evidence. Fingerprints remain controller-generated. Existing and closed findings use F11's normal deduplication. Neither skill has tools or permission to edit prompts, skills or gates, or to open a PR.

## Scheduling and switches

The controller evaluates cadence after ticket reservations, retries and new-ticket dispatch. At most one maintenance execution reserves a slot. Recovery, ordinary dispatch and candidate launches share the same occupied-slot calculation. An audit never evicts a ticket. A ticket arriving during an audit can wait for its bounded settlement; audits are not preemptive.

The tick starts the audit promise and returns; it never waits for the model, checkout or proposal publication. Later ticks observe the retained work. No second daemon, cron job or watchdog extension is installed. Scoped ticket controllers using `--issue` do not schedule unrelated maintenance; use a separate fixture state and the explicit cadence command for an audit.

A launch requires both factory switches, a valid trusted workflow, spare capacity and sandbox preflight. Both switches are checked again immediately before transport launch and separately before each proposed issue is created. Any local `disabled` entry holds publication. A repository label must be named exactly `factory:enabled`. A positively observed off switch aborts running maintenance on the next tick and retains unfinished publication. Unavailable GitHub or workflow reads hold launches and filing, but never abort running model work. A held gate does not consume a retry; an attempted preparation or filing failure does. The controller never creates or deletes that repository switch. Normal service shutdown also aborts and waits for bounded audit cleanup. Publication stops after any in-flight remote call; it does not continue through the remaining findings. An ordinary one-shot `tick` stops background maintenance instead of waiting for a whole audit; only the cadence command deliberately waits for it.

## State and deduplication

Private state lives below `<state-dir>/cadence/<job>/`, with 0700 directories and 0600 controller records:

- `state.json` holds the due watermark, rotation, pending window and last audited base SHA.
- `executions/<windowStart>/input.json` records ownership, repository/base SHA, trusted workflow SHA/digest, model, allowance, rotation and accounting week before launch. Before the model starts it also records the previous audited base SHA, locally changed paths and up to 100 existing proposals for the changed paths and rotating group. Each proposal has its fingerprint, title, primary path and open/completed/not-planned state.
- `prompt.txt` keeps the exact private prompt and bounded ledger inputs.
- `excerpt.json` records exactly which file ranges were delivered and which ranges were skipped. Publication requires every citation to fit a delivered range and the pinned file's actual line count. A missing excerpt supplies no citation authority.
- `tree/` is the pinned audit checkout; the model cannot modify it.
- `runtime/` contains native receipt, usage checkpoint, output, gateway audit and sessions, using stage `maintain` and the execution digest rather than a ticket ID.
- `receipt.json` records the audit result, charged tokens, exactness, answering model and native receipt digest. An empty proposal list records `no_delta`.
- `proposals/<fingerprint>.json` keeps each immutable issue title/body intent and whether filing was confirmed.
- `filing.json` records invalid citations and dropped findings. Reflect keeps a per-window `proposals/filing-<windowStart>.json`; the other jobs keep it in the execution directory. Invalid citations are removed; a finding with no valid evidence is dropped without stalling the job.
- `history.json` aggregates charges from pruned executions, preserving lifetime totals and the latest archived week's charge. Only the last five executions per job retain trees, stage output and session archives. Older execution directories and their checkout records are removed after settlement. Proposal intents stay for deduplication; status and launch accounting read bounded execution history.

On restart the normal executor stops this controller's leftover scopes before cadence reads retained receipts. Cadence never blindly replays an owned model execution. A completed passing output is reused; missing completion becomes `interrupted` with its conservative reservation. For maintenance only, a complete assistant answer is also retained when a cap fires. The controller settles it only if the proposals envelope validates, including an empty list. Its cadence receipt records `answered_at_cap`; the native receipt separately preserves `budget_exhausted`, the cap and full charged usage. Truncated, refused or errored assistant messages never qualify. Ticket-stage output behavior is unchanged. Before retrying a confirmed zero-work failure, cadence removes the old receipt and syncs its directory, so a crash during that retry cannot hide spent model work. A corrupt receipt logs `cadence_receipt_corrupt`, becomes a failed receipt with the full conservative reservation, and ends that job's window without relaunching. Corrupt ownership or overlapping state still blocks cadence rather than granting another execution.

Preparation and filing failures back off from 10 seconds, doubling up to 300 seconds. After five failed attempts in one job window, cadence records a `failed` receipt with a bounded `retry_exhausted` reason, logs `cadence_retry_exhausted`, advances the watermark and rotation, and lets the next job proceed. The count survives restarts. Existing token charges and proposal intents are preserved; a later weekly window remains eligible.

The controller validates at most ten proposals per run. Each has `job`, `repo`, `baseSha`, `fingerprint`, `title`, `claim`, `evidence[]` with path/start/end, `limits` and `provenance`. The model must reuse a supplied fingerprint for a repeated finding, including a closed one, or return `new`. An invented fingerprint is discarded. For `new`, the controller computes SHA-256 over job, repository, normalized primary evidence path and normalized title, independent of week and base SHA. Closed means the owner decided; the prompt forbids re-proposing it under another title. Model-provided text is bounded, redacted and escaped. The issue explains the finding, impact, source links at the pinned SHA and what the audit could not check. Its footer names job, skill, model, base SHA and receipt digest.

Deduplication uses the exact marker line:

```text
<!-- factory:cadence <repo> <job> <fingerprint> -->
```

It is not a `factory:run` marker and proves no ticket outcome. Before any create, the controller persists the intent, reads one paginated repository REST list per filing pass filtered by `factory:proposed`, the trusted controller-bot creator and `state=all`, matches the marker and rechecks both switches. This list has no 1,000-item cap. Confirmed local intents also prevent refiling when the owner removes the proposal label. An ambiguous create ends this publication slice; the next tick must list and reconcile remote issues before any retry. An unavailable or incomplete list never authorizes a create. Any matching bot-authored issue means already filed, even when several match. Issues authored by others cannot suppress a finding. Existing issues are not rewritten or relabeled.

Maintenance accounting stays under `cadence/`. `status --json` includes a separate `accounting.maintenance` line, and `durableUsage.total` includes those charges once, with a maintenance subtotal when present. There are no extra ticket claims or ledger run rows, so maintenance does not enter the F12a ticket-outcome metric. The current owner feed has no maintenance run cards; its durable token total includes maintenance honestly.

## One-shot command

```bash
node host/cli/index.ts cadence --once --job architecture --json \
  --repo nublai/pi-herdr-factorio --state-dir "$STATE"
```

Jobs are `architecture`, `security`, `instructions`, `hygiene` and `reflect`. `--once`, `--job`, `--repo` and `--state-dir` are required. JSON is always returned; `--json` is accepted for consistency. The command rejects extra flags and positional arguments, uses the controller's private-directory validation, bot identity check and single-authority lock, and reads the trusted workflow from `main`. It waits for bounded settlement using the same executor. It does not dispatch or claim ticket work. Pending ready tickets and retained ticket reservations have priority.

Exit 0 means the selected window completed as `proposed` or `no_delta`, including an already completed window. Exit 1 means a switch, capacity, policy, budget, preflight, recovery, audit failure or pending-publication gate prevented that result. Exit 2 means invalid arguments or an already running controller. Run it only on an authorized isolated state directory when the normal controller owns production. No status subcommand is provided.

## Local verification

```bash
TMPDIR="$HOME/.cache/f11t" FACTORY_REQUIRE_SANDBOX_TESTS=1 \
  node --test test/cadence.test.ts
```

The native one-shot demo uses the real CLI, lock, sandbox executor, Pi RPC, bubblewrap, user systemd scopes, gateway and receipts. Only GitHub and the model upstream are fixtures. It files two proposals, then zero for paraphrased/rekeyed findings in a fresh audit, including a rejected issue. It files a partially invalid finding with only its valid evidence and drops an all-invalid finding while completing filing. It also verifies an unchanged checkout, no tool definitions in the actual provider request, numbered source delivery, a read-only mount that refuses a shell write, and a withheld response that proves the scheduled tick does not wait. Injected over-cap usage proves valid empty/finding answers settle, malformed JSON fails, and full usage plus the native cap event survive restart. The F12c extension of that demo runs `cadence --once --job reflect`, files one proposal citing both a ledger field and a score event, then files zero on repeat. A fresh isolated state forces another model answer, which also files zero after the original issue closes. A real `tick --once --json` over 25 locally seeded failures files one trigger issue, zero on repeat and zero after the fixture issue is closed, without another model request. Fixture state and its temporary asset bundle are isolated and removed by the test. A working user bus is mandatory with `FACTORY_REQUIRE_SANDBOX_TESTS=1`; otherwise that native case explicitly skips when the bus is unavailable.

Excerpt tests enforce deterministic byte bounds, complete numbered lines, changed-first selection, import skipping, instruction selection, exclusions and line coverage through file tails. The estimate test reads `test/fixtures/cadence/snapshot.json.gz`, a committed text snapshot at `6c00eabd780f9cda62b9f08ac3e311463f484237`, with the exclusions above. It uses the current cadence prompt and skill bytes. It never resolves `origin/main` or skips when Git is absent, so archive-only tests and shallow CI run the same estimate.

### Token calibration

`test/fixtures/cadence/calibration.json` records the measured F11 lane prompts, including their appended skill section. Architecture was 7,988 UTF-8 bytes / 1,683 o200k tokens; hygiene was 23,585 / 7,326; instructions was 5,448 / 1,203. In each native receipt, first input tokens equal the tokenizer count plus 533. The measured ratios range from 3.22 to 4.75 bytes/token. The estimate uses **UTF-8 bytes / 2.8, rounded up, plus 533 runtime tokens**. The smaller divisor estimates about 15% more tokens than the densest measured lane. It also keeps the old tool-bearing runtime overhead despite maintenance having no tools. The review's full-code prompts also showed why chars/4 is too optimistic.

The test measures every rotating part with the maximum 4 KiB known-proposal context and a hex/JSON-shaped 16 KiB hygiene ledger. It reserves 8,800 tokens for the reviewer's 8,790-token maximum valid answer, plus 4,000 for reasoning, and requires the total to fit the 36,000-token default. Hygiene is the tightest estimate, leaving about 1,063 tokens. These are calibrated estimates, not new provider measurements or an absolute upper bound on provider reasoning. Native receipts still record full usage if a cap is exceeded.

Reflect's separate maximum-context test uses 8 KiB source, 16 KiB ledger, 8 KiB scores and the maximum known-proposal context. It applies the same bytes/2.8 plus 533 calibration, reserves 10,000 answer tokens and 4,000 reasoning tokens, and requires total usage below 36,000. This is an estimate, not a real-provider performance result.

### Frozen-snapshot results

Run the estimate and coverage check with:

```bash
node --test --test-name-pattern='calibrates every job' test/cadence.test.ts
```

The 32 KiB excerpt yields these worst-part estimates. Totals include the 8,800-token answer and 4,000-token reasoning reserve, or 10,000 answer plus 4,000 reasoning for reflect.

| Job | Calibrated prompt | Total tokens | Headroom to 36,000 |
| --- | ---: | ---: | ---: |
| Architecture | 16,482 | 29,282 | 6,718 |
| Security | 15,164 | 27,964 | 8,036 |
| Instructions | 15,597 | 28,397 | 7,603 |
| Hygiene | 22,137 | 34,937 | 1,063 |
| Reflect (8 KiB source plus scores) | 15,832 | 29,832 | 6,168 |

Without intervening changes, `src/` needs 41 group visits, or 205 weekly executions, to show 33,195 of its 33,971 lines, **97.72%**. The then `server/` tree needs 35 visits, or 175 weekly executions, to show 28,654 of 29,688 lines, **96.52%**. The unshown lines are leading headers and imports. These counts exclude the low-value files above. Every remaining line that fits a window is covered. The full five-group cycle takes at most 565 executions; instructions take two.

Those frozen cycles are long. Changed-first selection is what gives fresh code priority each week; the rotation fills the rest of the budget and eventually covers unchanged tails. No complete-repository weekly coverage is claimed.

### Follow-up, not implemented

N1 from the budget review is a speculative millisecond race between the gateway's final SSE bytes and Pi parsing them before abort. No settlement code is changed for it. Consider a bounded maintain-only drain without abort only with owner approval and evidence of a lost completed answer.

Saved-state tests separately exercise watermarks, no delta, restart overlap, unknown-create reconciliation, switches, budgets, scope rotation and escaping. They are not live VM/model evidence. The plan's ten live lanes and interleaved VM perf remain separate coordinator verification. Changed skills require sandbox bundle provisioning before a production audit can pass the stale-bundle check.
