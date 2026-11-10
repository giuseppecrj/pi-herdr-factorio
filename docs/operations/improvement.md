# Measure runs without changing their outcome

F12a's clean-landing share is the primary metric. Scorer labels and explain findings are secondary measurements, never gates. Both commands print the primary metric first, from the local `metrics.json` snapshot. A pending, stale or unavailable snapshot stays so; these commands do not refresh GitHub cohorts or claim an improvement.

F12b supplies scoring and explain. Proposals and the K/D trigger belong to F12c, replay policy to F12d, and benchmarks to F12e. Nothing here edits prompts, changes gates, files an issue or opens a PR.

## Trusted scorers

Only `.github/factory/WORKFLOW.md` from trusted main configures a judge. The shipped scorer is `outcome-quality`.

```yaml
grader:
  model: openai/gpt-6.1-sol
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

Each scorer has 2–20 declared labels mapped to numbers from 0 to 1, including a passing and a failing label. `passingScore` is required. `samplingRate` is a percentage from 0 to 100, default 10; zero disables automatic scoring. `includeChildren` is required. A judge returns one declared label and at most 4096 UTF-8 bytes of reasoning. An undeclared label, malformed output, wrong answering model, refusal or exhausted budget is failed scoring, not a pass.

The grader must be one exact authorized ID from `GRADER_MODELS` in `src/workflow.ts`. Unknown models, floating `latest` names and non-OpenAI graders are refused before execution. This profile has no fallback. Every event records `judgeFamily: "openai"` and `familyNote: "context-isolated, same family, not cross-family"`; it does not claim independent cross-family review.

The scorer digest covers the prompt, sorted label map, passing threshold and grader. Candidate edits to a scorer source void scoring before any judge request, with `status: "voided"` and `voided: "scorer_touched"`. The source boundary includes `src/scorers.ts`, `src/workflow.ts`, `.github/factory/scorers/` and the trusted WORKFLOW file containing the declarations and grader. Any WORKFLOW edit is conservatively inside that boundary. Pre-build stops have no candidate edits; built runs require retained, anchored patch-path metadata. Missing patch evidence refuses scoring rather than assuming no scorer changed. Replay-corpus voiding belongs to F12d.

## Score and re-score

```sh
node server/cli.ts score --run "$RUN_ID" --repo giuseppecrj/pi-herdr-factorio --state-dir "$STATE"
node server/cli.ts score --run "$RUN_ID" --repo giuseppecrj/pi-herdr-factorio --state-dir "$STATE" --json
```

Add `--scorer <id>` to select another declared scorer. A second command is a new measurement. It appends an event superseding the previous result; `latestScores` projects the latest, while `parseScores` and `scoreHistory` retain history. The event's frozen `passingScore` decides whether its numeric score passes. A passing measurement cannot revive a failed run or veto a successful one.

At terminal-row freeze, the controller selects automatic scores deterministically from the run ID and scorer ID. Work runs serially outside the tick's model await path and checks both factory switches before automatic execution. A durable `measure/automatic/` marker enrolls a run/scorer once across restarts. Failed or interrupted enrollment is not an automatic model retry; use the on-demand command to re-score. Measurement enrollment errors are logged and cannot block terminal progress.

Both commands acquire the state directory's controller lock. Use an isolated retained-state copy, or stop the service only under an operator grant. A running controller is an explicit refusal, not permission to start a competing writer. Exit 0 means a declared score was published, including a below-threshold score. Exit 1 means failed/voided scoring, pending publication, unavailable evidence or execution refusal. Exit 2 means invalid CLI usage. A pending event remains in the outbox; subsequent controller pumps retry publication without another model request.

Scores append to [`ledger/scores.jsonl`](ledger.md#score-stream), not to terminal run rows. The model has no GitHub route. Only the controller publishes score events; it makes no issue, PR or comment write.

## Explain a run

```sh
node server/cli.ts explain --run "$RUN_ID" --repo giuseppecrj/pi-herdr-factorio --state-dir "$STATE"
node server/cli.ts explain --run "$RUN_ID" --repo giuseppecrj/pi-herdr-factorio --state-dir "$STATE" --json
```

Explain accepts only the local frozen ledger row and digest-bound redacted stage receipts. It never reads output, stderr, raw sessions or private transcripts. Every finding must cite an existing top-level ledger field, such as `ledger.failure`, or a supplied receipt path. Text is printed as advice, never parsed as a command. No timer invokes explain, and it makes no GitHub write. It still reads trusted main configuration for the pinned grader.

Explain returns at most ten plain-text findings, each at most 2000 UTF-8 bytes. Empty, uncited or invalid findings fail. Its limits are 30,000 tokens and five minutes. Scoring uses at most 10,000 tokens and five minutes. Both reuse F11's F05 read-only, tool-free `maintain` transport: one OpenAI model request through the real gateway, no tools, no skills, no npm route and no fallback. Over-budget output is not accepted as a measurement success.

Input is bounded to 48 KiB. With `includeChildren`, scoring adds redacted child identities and usage from native receipts, never their session text. Older receipts expose only aggregate child usage, explicitly marked `aggregate_only`. Missing child outcomes remain unavailable, not inferred from token totals.

## Accounting and evidence

Execution identities are `measure/score/<runId>/<seq>` and `measure/explain/<runId>/<seq>`. Their hashes bind the native sandbox receipts; there is no invented ticket or cadence window. Inputs, prompt, ownership, runtime receipts and results live under `stateDir/measure/`, in private files and directories. Back up this directory with the run state.

`readDurableAccounting` exposes a separate `measurement` total. `durableUsageOf` includes it in the factory token total, alongside tickets and maintenance. It is never a ticket claim, terminal run row or part of F12a's metric. Incomplete executions retain their allowance conservatively; gateway uncertainty is not erased. Monetary cost stays unavailable.

`scorerTokenShare(events, runTokens)` in `src/scorers.ts` is the perf helper. It counts every scoring attempt, including re-scores and failures, against each target run's tokens once. Supply exact target totals; missing or zero denominators produce unavailable ratios. The plan requires a share of at most 10%. A small fake-upstream demo is not real-model calibration of that budget.

## Local verification

```sh
TMPDIR="$HOME/.cache/t12" FACTORY_REQUIRE_SANDBOX_TESTS=1 npm run check
TMPDIR="$HOME/.cache/t12" FACTORY_REQUIRE_SANDBOX_TESTS=1 \
  node --experimental-strip-types --test test/scorers.test.ts test/explain.test.ts
```

Create the short TMPDIR first. `test/explain.test.ts` drives the real CLI through score, re-score and explain using real Pi RPC, bwrap, user scopes, gateway enforcement and native receipts, with only GitHub and the model upstream faked. It also checks caps, primary-first output, child summaries, the hard-check veto, scorer-touch voiding, separate accounting and once-only automatic enrollment. This is native local transport proof over fixture state, not a real VM lane or provider performance result. VM lanes 1, 2, 6 and 7 and real scorer-share/explain perf remain required before a full F12b verdict.
