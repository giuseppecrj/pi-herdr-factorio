# status --json durableUsage says receipt_missing even when every run total is exact

The `durableUsage` total in `status --json` is always labeled `lower_bound` / `receipt_missing` unless some run is uncertain. That holds even when every run's token total in `accounting.runs[].tokens` is already `exact`. Since issue-644, each run reports `exact` when its receipt coverage is complete, but the aggregate never does.

The aggregate is built in `server/cli.ts`, in the `status` command, next to `readDurableAccounting`. It picks only between `uncertain` and `lower_bound`. It never looks at the per-run `kind`.

What I want:

- **All exact means exact.** When every run's token total is `exact`, `durableUsage` is `exact` with no `reason`, and it keeps the same summed total.
- **Any uncertain run wins.** If any run has an unsettled request, `durableUsage` stays `uncertain` with `request_unsettled`.
- **Otherwise lower bound.** If no run is uncertain but at least one run's total is not `exact`, `durableUsage` stays `lower_bound` with `receipt_missing`.
- **Unavailable stays as it is.** When accounting is unavailable, keep `unavailable` / `legacy_not_recorded`.

Please add `status --json` tests beside the existing status tests for each of these four cases. The numeric total must not change in any of them.
