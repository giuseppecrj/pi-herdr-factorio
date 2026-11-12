# Measure runs without changing their outcome

F12a's clean-landing share is the primary metric. Scorer labels and explain findings are secondary measurements, never gates. Both commands print the primary metric first, from the local `metrics.json` snapshot. A pending, stale or unavailable snapshot stays so; these commands do not refresh GitHub cohorts or claim an improvement.

F12b supplies scoring and explain. F12c adds weekly reflect proposals and the deterministic K/D trigger. Replay policy belongs to F12d and benchmarks to F12e. Only the proposal paths file issues, labeled `factory:proposed`. Nothing here edits prompts, skills or gates, labels proposals ready, or opens a PR.

## Trusted scorers

Only `.github/factory/WORKFLOW.md` from trusted main configures a judge. The shipped scorer is `outcome-quality`.

```yaml
grader:
  model: openai/gpt-6.1-sol
  maxTokens: 16000
scorers:
  outcome-quality:
    id: outcome-quality
    prompt: Judge whether the recorded final outcome matched its contract.
    labels:
      matched: 1
      mismatched: 0
      unknown: 0
    passingScore: 1
    samplingRate: 10
    includeChildren: true
```

Each scorer has 2–20 declared labels mapped to numbers from 0 to 1, including a passing and a failing label. `passingScore` is required. `samplingRate` is a percentage from 0 to 100, default 10; zero disables automatic scoring. `includeChildren` is required. A judge returns one declared label and at most 4096 UTF-8 bytes of reasoning. Control characters are filtered before reasoning is stored or printed; new ledger events reject unsafe text. An undeclared label, malformed output, wrong answering model, refusal or exhausted budget is failed scoring, not a pass. `unknown: 0` is a below-threshold score, including when evidence is unavailable. The trigger counts it as a failing score, not proof of a product defect.

The grader must be one exact authorized ID from `GRADER_MODELS` in `src/config/schema.ts`. Unknown models, floating `latest` names and non-OpenAI graders are refused before execution. `grader.maxTokens` is a positive integer, default 16,000. Invalid scorer or grader configuration fails the trusted workflow load and stops ticket processing, not just scoring. This profile has no fallback. Every event records `judgeFamily: "openai"` and `familyNote: "context-isolated, same family, not cross-family"`; it does not claim independent cross-family review.

The scorer digest covers the prompt, sorted label map, passing threshold and grader. Candidate edits to a scorer source void scoring before any judge request, with `status: "voided"` and `voided: "scorer_touched"`. The source boundary includes `src/maintenance/scorers.ts`, `src/config/{schema,parse,load,views}.ts`, `.github/factory/scorers/` and the trusted WORKFLOW file containing the declarations and grader. Any WORKFLOW edit is conservatively inside that boundary. F12d will narrow WORKFLOW voiding to the parsed `scorers` and `grader` sections and decide whether `src/config/{schema,parse,load,views}.ts` remains in scope. Pre-build stops have no candidate edits; built runs require retained, anchored patch-path metadata. Missing patch evidence refuses scoring rather than assuming no scorer changed. Replay-corpus voiding belongs to F12d.

## Score and re-score

```sh
node host/cli/index.ts score --run "$RUN_ID" --repo nublai/pi-herdr-factorio --state-dir "$STATE"
node host/cli/index.ts score --run "$RUN_ID" --repo nublai/pi-herdr-factorio --state-dir "$STATE" --json
```

Add `--scorer <id>` to select another declared scorer. A second command is a new measurement. It appends an event superseding the previous result; `latestScores` projects the latest, while `parseScores` and `scoreHistory` retain history. The event's frozen `passingScore` decides whether its numeric score passes. A passing measurement cannot revive a failed run or veto a successful one.

At terminal-row freeze, the controller selects automatic scores deterministically from the run ID and scorer ID. Work runs serially outside the tick's model await path and checks both factory switches before automatic execution. A durable `measure/automatic/` marker enrolls a run/scorer after its score execution starts or records its permanent failure. Only holds, switch refusals and preflight refusals remain eligible; the service retries them on later ticks after the gate opens. A permanent pre-launch error (such as a missing ledger row or oversized input) is recorded once as failed scoring with a bounded reason and zero model tokens, never retried automatically. A non-started launch after successful preflight also settles once. `score --run` remains available on demand. Restart adoption offers the frozen terminal rows again. Old pre-launch markers with no measurement execution, or only a confirmed zero-launch result, no longer consume sampling. Possible interrupted work stays enrolled conservatively. Failed or interrupted launched scores are not automatic model retries; use the on-demand command to re-score. Enrollment errors are logged and cannot block terminal progress.

Before lifting the deployment hold, expect a one-time catch-up of old pre-launch markers with no execution. Deterministic sampling still applies (10% by default), so at most the sampled retained run/scorer pairs are queued, serially, each within `grader.maxTokens`. This is not a new all-run scoring sweep; no extra deployment retry loop is added. A running judge occupies one concurrency slot, so it can temporarily reduce ticket capacity.

Both commands acquire the state directory's controller lock. Use the original retained state directory and stop its service only under an operator grant. Do not score from a copied state directory or run a second writer against the same ledger. A running controller is an explicit refusal, not permission to start a competing writer. Exit 0 means this command computed and persisted a declared score, including a below-threshold score. Publication does not decide that exit status. JSON reports `persisted: true`, `published` and `publication`, either `published` or `queued_for_controller`. Plain text says whether publication completed or is queued for the controller pump. Other queued scores are reported separately. Exit 1 means failed or voided scoring, unavailable evidence or execution refusal. Exit 2 means invalid CLI usage. A queued event remains in the private outbox; later controller pumps retry publication without another model request. The five-second publication slice is unchanged. On first publication, the scorer reuses verified ancestry from the run-ledger checkpoint on the shared ref and reads the score stream at that checkpoint, never the run stream's prefix. Without a trusted checkpoint, bounded ancestry adoption still runs.

Scores append to [`ledger/scores.jsonl`](ledger.md#score-stream), not to terminal run rows. The model has no GitHub route. Only the controller publishes score events. Its pump also evaluates the separate improvement trigger below, which can create proposed issues but no PR or comment.

## Improvement proposals

Every proposal starts with F12a's primary-metric status from the local `metrics.json` snapshot. It then gives the baseline, proposed change, cited evidence, keep-or-reject rule and what it could not check. Pending, stale or unavailable primary evidence is not improvement. Neither a proposal nor a score authorizes work.

### Weekly reflect

`reflect` is Friday's weekly cadence job. It uses `reflect-ledger` and `agent-loop-spec` in one no-tools sandbox request. Its inputs are bounded redacted ledger rows, the latest local score projection and pinned source lines, never private transcripts. Ledger fields, score-event IDs, receipt digests and repository ranges must exist in its frozen excerpt. The controller removes unsupported citations and deduplicates proposed issues, including closed findings.

```sh
node host/cli/index.ts cadence --once --job reflect --json \
  --repo nublai/pi-herdr-factorio --state-dir "$STATE"
```

Reflect shares the existing 200,000-token weekly cadence cap. Five jobs at 36,000 tokens each total 180,000, leaving 20,000 of catch-up headroom without raising the cap. See [cadence](cadence.md) for bounds, citations, accounting and restart behavior.

### Deterministic K/D trigger

Trusted main enables the trigger with:

```yaml
trigger:
  k: 25
  d: 7
```

A missing `trigger` section disables it. An empty section defaults to K=25 and D=7. K is an integer from 1 to 50; D is a positive safe integer in days. Unknown fields and invalid values fail workflow validation.

Each score pump first evaluates distinct unfiled failing runs per configured scorer from local score history and the last valid trusted main configuration already loaded by admission. It does not fetch workflow settings for the trigger. A scored event fails below its own frozen `passingScore`. A later passing re-score clears that run's failure; failed judging does not. Repeated failing re-scores preserve the first outstanding failure's age. A run cited by a closed trigger issue for that scorer is reviewed and excluded. An `unknown` label below the threshold counts as a failing score, not proof of a product defect.

When count ≥ K or oldest age ≥ D days, the trigger files one `factory:proposed` issue. Only a locally qualifying unfiled cohort can cause GitHub reads. The trigger checks both switches and reconciles one all-state paginated list of the controller's proposed issues at most once an hour per qualifying scorer, including after a failed read. Ticks with no failing scores, only later-passed runs, a below-threshold cohort or only already-filed runs make zero trigger GitHub calls. This is a per-reconciliation rate limit, not a one-request limit; switch reads and pagination may require several requests, never one per failing run. An open trigger issue suppresses another issue for that scorer. A closed issue records the owner's decision about the cited cohort. The cohort fingerprint binds repository, scorer and the first outstanding event's timestamp and ID, so adding failures does not change it. Each issue cites at most 50 run IDs and score-event IDs, and states how many failures were omitted. It warns that score events may still be queued locally rather than published. After closure, an omitted remainder can form another proposal if it reaches K or D.

The trigger calls no model and reserves no sandbox slot. It shares F11's intent-before-create publisher and unknown-create reconciliation. Its only local writes are proposal intents and per-scorer reconciliation records under `cadence/trigger/proposals/`. `read-<scorer>.json` retains the last remote-attempt time and already-filed run IDs so idle ticks and restarts need no repeated GitHub read for them. A repeat, an ambiguous successful create or a closed cohort cannot create a duplicate. No path edits skills, prompts or gates, opens a PR, or makes an issue ready. Closing a proposal does not approve or execute the proposed change.

## Explain a run

```sh
node host/cli/index.ts explain --run "$RUN_ID" --repo nublai/pi-herdr-factorio --state-dir "$STATE"
node host/cli/index.ts explain --run "$RUN_ID" --repo nublai/pi-herdr-factorio --state-dir "$STATE" --json
```

Explain accepts only the local frozen ledger row and digest-bound redacted stage receipts. It never reads output, stderr, raw sessions or private transcripts. Every finding must cite an existing ledger field, such as `ledger.failure`, or a supplied receipt path. Unambiguous nested paths such as `ledger.outcome.kind` flatten to their top-level field. A single JSON code fence is accepted, invalid findings or citations are dropped, and the report fails only when no valid finding remains. Text is printed as advice, never parsed as a command. No timer invokes explain, and it makes no GitHub write. It still reads trusted main configuration for the pinned grader.

Explain returns at most ten plain-text findings, each at most 2000 UTF-8 bytes. Text is stripped of terminal controls and findings remain bounded. Explain's limits are 30,000 tokens and five minutes. Scoring uses trusted `grader.maxTokens` (default 16,000) and five minutes. These per-execution allowances do not replace the governing perf rule that scoring at the configured sampling rate uses at most 10% of the scored runs' tokens. Both reuse F11's F05 read-only, tool-free `maintain` transport: one OpenAI model request through the real gateway, no tools, no skills, no npm route and no fallback. Over-budget output is not accepted as a measurement success.

Input is bounded to 48 KiB. Scoring also reads the admitted issue snapshot and accepted contract criteria, bound to the frozen row's digests. The title (2 KiB), body (8 KiB) and criteria (8 KiB) are fenced as untrusted text, with truncation or unavailable evidence explicit. It never reads held-out tests. Explain remains ledger-and-receipts only. With `includeChildren`, scoring adds redacted child identities and usage from native receipts, never their session text. Older receipts expose only aggregate child usage, explicitly marked `aggregate_only`. Missing child outcomes remain unavailable, not inferred from token totals.

## Accounting and evidence

Execution identities are `measure/score/<runId>/<seq>` and `measure/explain/<runId>/<seq>`. Their hashes bind the native sandbox receipts; there is no invented ticket or cadence window. Score event IDs additionally include a random nonce retained privately in `measure/score-nonce`, so independent state directories cannot collide. Forked or foreign supersession links are informational; the public projection follows stream order. Inputs, prompt, ownership, runtime receipts and results live under `stateDir/measure/`, in private files and directories. Back up this directory with the run state.

`readDurableAccounting` exposes a separate `measurement` total. `durableUsageOf` includes it in the factory token total, alongside tickets and maintenance. It is never a ticket claim, terminal run row or part of F12a's metric. Incomplete executions retain their allowance conservatively; an allocated execution missing `owner.json` is charged at least 30,000 tokens with incomplete coverage. Gateway uncertainty is not erased. Monetary cost stays unavailable.

`scorerTokenShare(events, runTokens)` in `src/maintenance/scorers.ts` is the perf helper. It counts every scoring attempt, including re-scores and failures, against each target run's tokens once. Supply exact target totals; missing or zero denominators produce unavailable ratios. The plan requires a share of at most 10%. A small fake-upstream demo is not real-model calibration of that budget.

## Local verification

```sh
TMPDIR="$HOME/.cache/t12" FACTORY_REQUIRE_SANDBOX_TESTS=1 npm run check
TMPDIR="$HOME/.cache/t12" FACTORY_REQUIRE_SANDBOX_TESTS=1 \
  node --experimental-strip-types --test test/scorers.test.ts test/explain.test.ts
```

Create the short TMPDIR first. `test/explain.test.ts` drives the real CLI through score, re-score and explain using real Pi RPC, bwrap, user scopes, gateway enforcement and native receipts, with only GitHub and the model upstream faked. It also checks caps, primary-first output, child summaries, the hard-check veto, scorer-touch voiding, separate accounting and once-only automatic enrollment. The native score demo forces publication failure, verifies exit 0 with an honestly queued, persisted score, and then publishes it through the controller pump without another model request. It also verifies automatic scoring resumes after a hold. The five-minute refusal test advances the parent clock at the real model-transport response; it does not wait five minutes. This is native local transport proof over fixture state, not a real VM lane or provider performance result. VM lanes 1, 2, 6 and 7 and real scorer-share/explain perf remain separate F12b evidence. F12c's `test/cadence.test.ts` native demo files reflect proposals in a 1/0/0 sequence (completed-window repeat, then a fresh model answer in new isolated state after closure), and trigger proposals in a 1/0/0 sequence including closure, using fixture GitHub and model upstreams. Unit tests cover exact K/D boundaries, switches, closed cohorts, hourly rate limiting, zero trigger reads when idle, ambiguous creates and excerpt-only citations. Proposal-only tests allow only issue-list, issue-create and label-read requests and hash the repository checkout before and after, as well as checking private-state writes. These local checks do not close the real GitHub/VM lanes 4 and 9.
