# Factory CLI reference

`server/cli.ts` is the factory's command-line entry point. It runs from a checkout of this repository on Node 26.12.1 or later. Node 26 strips TypeScript types by default, so no flag is needed.

```bash
node server/cli.ts <command> --json --repo <owner/name> [options]
node server/cli.ts serve --repo <owner/name> --state-dir <dir> [--issue <number>]...
```

Except for `gates` and `viewer`, every command reads `.github/factory/WORKFLOW.md` from GitHub through `gh`, never from the local checkout. It first resolves the branch to a SHA with `gh api repos/<repo>/git/ref/heads/<branch> --jq .object.sha`, then fetches the file at that SHA with `gh api -H 'Accept: application/vnd.github.raw' repos/<repo>/contents/.github/factory/WORKFLOW.md?ref=<sha>`. Ordinary `gh` calls have a 30-second timeout. Ledger publication uses a separate 20-second job slice, with each call capped at the smaller of 5 seconds and the remaining slice. `gh` inherits the environment, including `GH_HOST`. On the VM, set `GH_HOST=github.int.exe.xyz`.

`admit` makes more `gh` reads, described below. `tick`, `run`, and `serve` run the controller. They can write markers, summaries, labels, Git objects and refs, dispatch CI, open a PR, request review, and close an issue after an observed merge. They never merge or arm auto-merge. Only these controller commands launch models, inside the stage sandbox. `admit` and the controller write private state under `--state-dir`; `gates` writes its own receipt output directory. The viewer is read-only. See [Review and merge a factory PR](human-review.md) for the owner procedure.

Errors and warnings carry only text the factory builds itself. They never quote `gh` output, an exec failure, a YAML error message, a key or value from `WORKFLOW.md` or a command-line argument. A second layer still redacts credentials in stdout, stderr and `/factory status` text. Anything shaped like `scheme://user:secret@` is printed as `scheme://<redacted>@`, and the value of a query parameter named `token`, `access_token`, `auth`, `key`, `password`, `secret`, `sig`, `signature` or `code`, in any case, is printed as `<redacted>`. In JSON output this applies to each string value before it is encoded, so it never spans two lines of one value.

## Local run viewer

```bash
node server/cli.ts viewer --state-dir "$STATE" [--run <64-character-id>] [--port <n>] [--allowed-host <host>] [--base-path </prefix>]
```

`viewer` serves local evidence on `127.0.0.1` with no GitHub or model calls. It needs neither `--repo` nor `--json`. The default port is 8080. All four views have HTML and JSON routes. Missing sources are visible gaps, never a complete run. A missing state directory or occupied port exits 1. Invalid options exit 2. Ctrl+C or SIGTERM stops it with exit 0.

See [Inspect one run's local evidence](viewer.md) for the routes, source limits, session-retention gaps, and owner-authorized Tailscale exposure. `--allowed-host` permits an explicitly authorized Tailscale hostname without changing the loopback bind. `--base-path` prefixes rendered links for a `tailscale serve --set-path` mount. No exposure is enabled by default.

## Commands

| Command | Purpose |
| --- | --- |
| `workflow-check` | Load and validate the workflow. Print the snapshot or the error. |
| `status` | Print the factory status: package, workflow, models, limits and execution state. |
| `admit` | Decide whether one issue's latest `factory:ready` label event is admitted. Print the receipt. |
| `tick` | Run one controller tick and print the claim snapshot. Requires `--once`. |
| `run` | Run one controller tick for one issue, through the same admission as polling, and print the claim snapshot. |
| `serve` | Run the controller: a tick, then one every `polling.interval_ms`, until SIGTERM or SIGINT. |
| `viewer` | Inspect one run's local timeline, usage, children, and gateway decisions. |
| `gates` | Run the trusted candidate gates and write a bound receipt; see its separate flags below. |

## Flags

The flags below describe the workflow and controller commands. `viewer` has its own flags in [Local run viewer](#local-run-viewer).

| Flag | Commands | Required | Default | Meaning |
| --- | --- | --- | --- | --- |
| `--json` | all except `serve` | yes | none | Print JSON on stdout. JSON is the only output format. `serve` takes no `--json` and prints nothing on stdout. |
| `--once` | `tick` | yes | none | Run exactly one tick. |
| `--repo <owner/name>` | all | yes | none | The GitHub repository. The workflow's `repository` field must equal it. |
| `--ref <branch>` | `workflow-check`, `status` | no | `main` | The branch to load. Any branch other than `main` sets `verification: true`. |
| `--reload-ref <branch>` | `workflow-check` | no | none | Load a second branch as a reload on top of `--ref` and report which snapshot stays in force. |
| `--issue <number>` | `admit`, `run`, `tick`, `serve` | `admit` and `run`: exactly one. `tick` and `serve`: no | every candidate | The issue number, from 1 to 9999999999, with no leading zero. `tick` and `serve` take it any number of times and then touch only those issues. |
| `--verification-token-cap <n>` | `tick`, `run`, `serve` | no | none | Verification lanes only. It lowers the run token cap to `min(n, usage.max_tokens_per_run)` and never raises it. It requires `--issue`. See [Verification token cap](#verification-token-cap). |
| `--state-dir <dir>` | `admit`, `tick`, `run`, `serve`; optional for `status` | yes, except for `status` | none | The controller state directory. It must already exist as a directory, not a symlink, owned by the effective user and not writable by group or others. A relative path is resolved against the working directory. |

`--ref` and `--reload-ref` exist so verification lanes can load fixture branches. The controller always loads `main` and takes no such flag.

An `<owner>` or `<name>` contains only letters, digits, `.`, `_` and `-`, and is not `.` or `..`.

A branch name contains only letters, digits, `.`, `_`, `-` and `/`. It does not start with `-` or `/`, end with `/`, or contain `..` or `//`.

## Exit codes

| Code | `workflow-check` | `status` | `admit` |
| --- | --- | --- | --- |
| 0 | The workflow is valid. With `--reload-ref`, both loads are valid. | A report was printed, whatever the workflow state. | Admitted. The receipt was printed and recorded. |
| 1 | A load failed: the branch did not resolve, the file is missing or unreadable, or the file is invalid. The report is still printed. | Not used. | Refused. The receipt was printed. |
| 2 | Usage error. Usage goes to stderr, and stdout is empty. | Usage error. Usage goes to stderr, and stdout is empty. | Usage error. Usage goes to stderr, stdout is empty, and `gh` is not run. |

| Code | `tick` | `run` | `serve` |
| --- | --- | --- | --- |
| 0 | The tick ran. The snapshot was printed. | The issue holds a run after the tick. | Stopped by SIGTERM or SIGINT after finishing its tick. |
| 1 | The controller refused to start. See `controller_refused`: `repo_not_allowed`, `state_unavailable`, `lock_unavailable`, `identity_unavailable` or `identity_mismatch`. | The issue holds no run: it was refused, queued, absent or corrupt, or the controller refused to start. | The controller refused to start. |
| 2 | Usage error, or `controller_running`: another controller holds the lock. | Same as `tick`. | Same as `tick`. |

## Error kinds

| `kind` | Cause |
| --- | --- |
| `source_unavailable` | The branch did not resolve to a SHA: it does not exist, the name is invalid, or `gh` failed. `sha` is `null`. It is also reported when `gh` could not be run at all, at either step. In that case `sha` is set if the branch had already resolved. |
| `missing_workflow_file` | The branch resolved, but fetching `WORKFLOW.md` at that SHA failed. |
| `workflow_parse_error` | The front matter has no closing `---`, its YAML has an error or a warning, such as a duplicate key or an unresolved tag, or it uses an anchor or alias. Line numbers count from the first line of `WORKFLOW.md`. |
| `workflow_front_matter_missing` | The file does not start with a `---` line. Front matter is required. |
| `workflow_front_matter_not_a_map` | The front matter is empty or is not a YAML map. |
| `workflow_validation_error` | A field failed validation. `field` holds its dotted YAML path, such as `stages.build.max_turns`, `guidance` or `polling.(unknown key)`. |

Each error has `kind` and `message`. The other fields depend on the kind:

- `source_unavailable` and `missing_workflow_file` have `cause` and `status`. `cause` is `not_found` for HTTP 404, `auth` for HTTP 401 or 403, `network` when `gh` could not reach GitHub, and `other` for anything else. `status` is the HTTP status when `gh` printed one as `HTTP <code>`, and `null` otherwise. The message is `cannot resolve the branch: <phrase>` or `cannot fetch .github/factory/WORKFLOW.md: <phrase>`, followed by ` (HTTP <code>)` when `status` is set. The phrase depends on `cause`:

  | `cause` | Phrase | `status` |
  | --- | --- | --- |
  | `not_found` | `not found` | `404` |
  | `auth` | `not authorized` | `401` or `403` |
  | `network` | `network error` | `null` |
  | `other` | `gh failed` | any other HTTP status, or `null` |

  Three `source_unavailable` messages have `cause` `other`, `status` `null` and no phrase:

  - `cannot run gh`: `gh` could not be started, for example because it is not on `PATH`. `sha` is set if the branch had already resolved. A `gh` that starts and exits non-zero is an ordinary failure with a phrase, and in the CLI so is one that hits the 30-second timeout, which reports `network error`. Pi's `exec` reports a program that cannot start exactly like one that exits 1 with no output, so `/factory status` shows `cannot resolve the branch: gh failed` when `gh` is missing.
  - `cannot resolve the branch: gh returned no SHA`: `gh` exited 0 but did not print a 40-character SHA.
  - `the ref is not a branch name`: the ref fails the branch-name rule. The CLI checks `--ref` and `--reload-ref` first and reports a usage error instead, so CLI output never shows this message.
- `workflow_parse_error` has `code`, `line` and `column`. For a YAML error, `code` is the `yaml` library's error code, such as `BAD_INDENT` or `DUPLICATE_KEY`, and the message is `YAML <code> at line <line>, column <column>`. The factory adds two codes: `FRONT_MATTER_UNCLOSED` at line 1, column 1, and `ANCHOR_OR_ALIAS` at the first anchor or alias.
- `workflow_validation_error` has `field`. The message is the field followed by the rule it broke, such as `polling.interval_ms must be an integer of at least 10000`. It never repeats the offending value.

Validation stops at the first failing field. `field` is built only from names the factory knows: the top-level keys, the keys of each section, the stage names and the checkpoint names. Any other key, including a rejected shell-command key, is printed as `(unknown key)`, both in `field` and in warnings. For example, `polling: {interval: 1}` gives `field` `polling.(unknown key)` and the message `polling.(unknown key) unknown key`, and an unknown top-level key gives the warning `(unknown key) ignored`.

## Messages

This is every message the factory prints. `<field>` is a dotted path as described above.

`workflow_validation_error` messages are `<field> <rule>`:

| Rule | Where |
| --- | --- |
| `is required` | `repository` is missing. |
| `must equal the repository the caller loaded` | `repository` differs from `--repo`. |
| `must be a map` | A section, a stage or `checkpoints.approve_merge` is not a map. |
| `keys must be plain strings` | A map has a key that is not a plain value. At the top level `field` is `front matter`. |
| `unknown key` | A key inside a known section, a stage or `checkpoints` is not known there. |
| `names shell commands, and the factory runs no commands from WORKFLOW.md` | A shell-command key. `field` ends in `(unknown key)`. |
| `must be a single value` | A setting is a map or a list. |
| `must not be empty` | A setting has no value, or only spaces. |
| `environment references are allowed only in workspace.root` | A value outside `workspace.root` starts with `$`. |
| `must be a positive integer` | A budget, retry or usage setting is not an integer of at least 1. |
| `must be an integer of at least 10000` | `polling.interval_ms`. |
| `must be an integer from 1 to 4` | `agent.max_concurrent`. |
| `must be an integer no larger than 9007199254740991` | An integer is too large. |
| `must be <provider>/<model>` | A model ID has the wrong form. |
| `provider anthropic is allowed only for stages.accept.model and stages.review.seats.code-review.model: on the VM it spends exe.dev credits` | A model ID outside those two fields uses provider `anthropic`. |
| `names an anthropic model outside the limits table (server/sandbox/anthropic-limits.ts)` | `stages.accept.model` or the code-review seat names an Anthropic model the host's limits table does not list. |
| `must be an openai or a listed anthropic model` | `stages.accept.model` or the code-review seat names another provider. |
| `must be an openai model: accept's fallback is same-family` | `stages.accept.fallback_model` is not an `openai/` model. |
| `<stage> runs no model, so it takes no model key` | `model` or `fallback_model` under `stages.admit` or `stages.land`. |
| `must be an openai or xai model` | A `fallback_model` names another provider. The VM permits OpenAI calls only. |
| `must differ from the primary model` | A `fallback_model` repeats the stage's primary model. |
| `must be exactly $VAR_NAME to use the environment` | `workspace.root` starts with `$` but is not a plain variable name. |
| `names an environment variable that is not set` | `workspace.root` names an unset or empty variable. |
| `uses ~ but HOME is not set` | `workspace.root` starts with `~` and `HOME` is unset or empty. |
| `must resolve to an absolute path` | `workspace.root` does not resolve to an absolute path. |
| `never removes the merge checkpoint: v1 stops every run at Human Review` | `checkpoints.approve_merge.mode` is `never`. |
| `is an unknown checkpoint mode: use always` | `checkpoints.approve_merge.mode` is any value other than `always` or `never`. |
| `has a level-2 heading that names no stage: use one of admit, specify, accept, build, validate, review, land` | `guidance`. |
| `duplicate heading "## <stage>"` | `guidance`. |

Other errors:

| `kind` | Message |
| --- | --- |
| `source_unavailable` | `cannot resolve the branch: <phrase>[ (HTTP <code>)]`, `cannot resolve the branch: gh returned no SHA`, `cannot run gh` or `the ref is not a branch name`. |
| `missing_workflow_file` | `cannot fetch .github/factory/WORKFLOW.md: <phrase>[ (HTTP <code>)]`. |
| `workflow_parse_error` | `front matter has no closing ---`, `YAML <code> at line <line>, column <column>`, or `anchors and aliases are not allowed: ` followed by `anchor at line <line>, column <column>` or `alias at line <line>, column <column>` for each one, joined by `; `. |
| `workflow_front_matter_missing` | `WORKFLOW.md must start with --- front matter naming the repository`. |
| `workflow_front_matter_not_a_map` | `front matter must be a YAML map`. |

The only warning is `(unknown key) ignored`.

A usage error prints one of these lines to stderr, followed by the usage text: `unrecognized or incomplete options`, `expected workflow-check, status, admit, tick, run or serve`, `unexpected extra arguments`, `--json is required`, `--json is required, except for serve, which logs lines`, `--once applies only to tick, and tick requires it`, `--repo <owner/name> is required`, `--reload-ref applies only to workflow-check`, `--ref and --reload-ref must be branch names`, `admit always reads main and takes no --ref`, `tick always reads main and takes no --ref` (also for `run` and `serve`), `--issue <number> is required`, `--issue must be a number`, `--state-dir <dir> is required` or `--issue applies only to admit, tick, run and serve`.

`/factory` prints `Usage: /factory status | /factory run <issue>` when its argument is neither `status` nor `run` followed by at most one more word. When it cannot find a repository, the reason is `cannot run git`, `no git remote named origin` or `origin is not a GitHub repository`.

## `workflow-check` output

| Field | Type | Meaning |
| --- | --- | --- |
| `repo` | string | The `--repo` value. |
| `ref` | string | The `--ref` value. |
| `sha` | string or `null` | The commit SHA the branch resolved to. |
| `digest` | string or `null` | The sha256 hex digest of the fetched file bytes. `null` when nothing was fetched. |
| `verification` | boolean | `true` when `ref` is not `main`. |
| `valid` | boolean | `true` when the file loaded and passed validation. |
| `error` | object or `null` | The error, described under error kinds. |
| `warnings` | string array | One entry per ignored unknown top-level key, each `(unknown key) ignored`. |
| `config` | object or `null` | The validated configuration, described under configuration. |
| `guidance` | object or `null` | `general`, the text before the first stage heading, and `stages`, a map from stage name to its section text. |
| `reload` | object or `null` | Always present. `null` without `--reload-ref`. |

When `valid` is `true`, `sha` and `digest` are set, `error` is `null`, and `config` and `guidance` are set. When `valid` is `false`, `error` is set, `warnings` is empty, and `config` and `guidance` are `null`.

The `reload` object has these fields:

| Field | Type | Meaning |
| --- | --- | --- |
| `repo`, `ref`, `sha`, `digest`, `valid`, `error` | as above | The result of loading `--reload-ref`. |
| `verification` | boolean | `true` when the ref of the snapshot in force is not `main`. When no snapshot is in force, it uses the `--reload-ref` value. |
| `outcome` | string | `applied` when the reload is valid, `kept` when it is invalid and the `--ref` snapshot stays, and `unavailable` when neither load is valid. |
| `inForce` | object or `null` | `ref`, `sha` and `digest` of the snapshot in force after the reload. `null` only when `outcome` is `unavailable`. |

## `status` output

| Field | Type | Meaning |
| --- | --- | --- |
| `package` | string | Always `pi-herdr-factorio`. |
| `version` | string | The version in `package.json`. |
| `repo`, `ref`, `verification` | as in `workflow-check` | |
| `workflow` | string | `valid` or `invalid`. |
| `workflowSha` | string or `null` | Same as `sha` in `workflow-check`. |
| `workflowDigest` | string or `null` | Same as `digest` in `workflow-check`. |
| `workflowError` | object or `null` | Same as `error` in `workflow-check`. |
| `warnings` | string array | Same as in `workflow-check`. |
| `executionEnabled` | boolean | Always `false`, because `status` runs no preflight. The controller's own value is in `controller.lastTick.executionEnabled`. |
| `controller` | object | Without `--state-dir`, `state` is `unavailable` and `reason` is `pass --state-dir to read the controller lock`. With it, see below. |
| `ledger` | object | Read-only local outbox state, pending and blocked counts, oldest age and next retry time. See below. |
| `durableUsage` | object | Charged tokens summed once per distinct locally owned run, including ended runs. Never adds ledger rows to the same charges. Unavailable without readable state. |
| `accounting` | object | `state` is `readable`, `incomplete` or `unavailable`; `countersScope` is `process`. `runs` contains each owned run's token floor, uncertain-request count, money availability and durable attempt records. |
| `models` | object or `null` | The model for each of `specify`, `accept`, `build` and `review`. Validate has no model. `review` is the model of the security, simplify and ultrareview seats. |
| `seatModels` | object or `null` | `code-review`, the model the code-review seat runs: `stages.review.seats.code-review.model`, or `review` when that key is absent. It is shown beside `models.review` and never folded into it. |
| `limits` | object or `null` | `pollIntervalMs`, `maxConcurrent`, `retry`, `usage` and `stages`, where `stages` maps each stage to `maxTurns`, `wallMs` and `stallMs`. |
| `checkpoints` | object or `null` | `approveMerge.mode`, which is always `always`. |

When `workflow` is `valid`, `workflowSha` and `workflowDigest` are set, `workflowError` is `null`, and `models`, `seatModels`, `limits` and `checkpoints` are set. When it is `invalid`, `workflowError` is set and `models`, `seatModels`, `limits` and `checkpoints` are `null`.

### Ledger backlog and accounting

`status` reads the local outbox without taking the controller lock, pumping it, or launching models. `ledger.state` is `empty`, `pending`, `blocked`, `unreadable` or `unavailable`. `pending` and `blocked` are `null`, not zero, when the outbox cannot be read. `oldestObservedAt` and `oldestAgeMs` describe the oldest unpublished terminal run; `nextAttemptAt` is the earliest persisted retry time. Absent times are `null`. `lastError` names a persisted transport or integrity failure; `adoption_pending` means bounded lineage adoption is still in progress.

The controller retries ledger jobs after ticks, with persisted exponential backoff starting at 5 seconds and capped at 5 minutes. First adoption saves a lineage cursor and walks at most 16 parent links per slice. Transport timeouts leave publication uncertain: the next attempt reads the remote ledger before appending again. Integrity failures remain visible and do not replenish or block a run's token allowance.

`durableUsage` and per-run `tokens` use `kind: "lower_bound"` when coverage is incomplete and `kind: "uncertain"` when unmatched requests contribute policy charges. `uncertainRequests` counts dispatched requests whose result was not durably recorded, or whose result carried no metered usage against a positive bound. Current policy charges their recorded input-size estimate plus maximum allowed output, never replays them, and lets the run continue within its remaining allowance. The gateway records a conservative one-token-per-input-byte estimate and an enforced output limit before forwarding. Legacy dispatches without those bounds remain explicitly incomplete floors. Uncertain charges are not exact metering. Money remains unavailable because no validated price source is recorded. Existing `controller.lastTick.totals` are process-scoped counters, not lifetime totals. `status.json` is not restart authority.

## `admit`

```bash
node server/cli.ts admit --json --repo <owner/name> --issue <number> --state-dir <dir>
```

`admit` admits an issue when all of these hold:

- `--repo` is on the controller's allowlist. Today the allowlist is `giuseppecrj/pi-herdr-factorio`, in `FACTORY_REPOSITORIES` in `src/admission.ts`.
- Nothing named `<state-dir>/disabled` exists. This is the local kill switch. Create a file there to stop admission. Its content is ignored. Any entry with that name counts, including a directory or a dangling symlink.
- The repository has a label named exactly `factory:enabled`. This is the repository kill switch, described below.
- `.github/factory/WORKFLOW.md` on `main` is valid. `baseSha` is the `main` SHA it was loaded from.
- The issue is open, is not a pull request, and has the `factory:ready` label.
- The latest `factory:ready` entry on the issue timeline is a `labeled` event, not `unlabeled`. This is the admitted event. Latest means the greatest `created_at`, whatever order the timeline returns. When two `factory:ready` entries share that second, admission refuses with `ambiguous_snapshot` and `label_events_same_second`.
- That event's actor has `admin`, `maintain` or `write` permission on the repository. `maintain` counts as write. `triage`, `read` and `none` are refused. The issue author does not matter.
- The title and body at the time of the event are proved, as described under snapshot.
- No admission was recorded before for the same event ID.

It checks the allowlist and the local switch first and stops there, before any `gh` call. When the repository switch is off or unavailable, it still evaluates the issue in the order of the requests below and stops at the first refusal, so the receipt shows the event, actor and snapshot only as far as that evaluation reached. For example, when `WORKFLOW.md` does not load, the issue is never read, and the reasons are the switch reason followed by `workflow_unavailable`, with the event and snapshot fields `null`. It then refuses without recording anything.

### Repository switch

The repository switch is the existence of a repository label named exactly `factory:enabled`. The label does not need to be on any issue. `admit` reads it with `gh api repos/<repo>/labels/factory%3Aenabled` and has three states:

| State | When | Result |
| --- | --- | --- |
| On | The call succeeds and the returned `name` is exactly `factory:enabled`. | Admission continues. |
| Off | The call returns HTTP 404, or the returned `name` differs in case, such as `Factory:Enabled`. GitHub looks labels up case-insensitively, so the name is compared exactly. | Refused with `repo_switch_off`. |
| Unavailable | Any other failure, such as HTTP 401 or 403, or a network error. | Refused with `repo_switch_unavailable`. |

Only the owner creates or deletes the repository's `factory:enabled` label. Its absence holds new claims, model launches, publication, and handoff notifications. Existing PR observation and necessary stop/account/terminal bookkeeping continue. Deleting the repository label also removes it from issues. A local `disabled` entry provides a separate hold under explicit state-write authority; neither hold grants service or deployment authority.

### Requests

Every request is an argument array, never a shell string, and names `repos/<owner>/<name>/...` or GraphQL. One admission makes these `gh` calls, each with the 30-second timeout:

| Step | Request |
| --- | --- |
| Repository switch | `gh api repos/<repo>/labels/factory%3Aenabled` |
| Trusted workflow | the two `workflow-check` requests for `main` |
| Issue | `gh api repos/<repo>/issues/<n>` |
| Timeline | `gh api repos/<repo>/issues/<n>/timeline?per_page=100&page=<p>`, from page 1 until a page has fewer than 100 entries. When pages 1 to 10 are all full, page 11 is read only to confirm the end: empty means the 1000 entries are the whole timeline, and any entry means `pagination_limit`. |
| Permission | `gh api repos/<repo>/collaborators/<login>/permission`, with `[` and `]` in a bot login URL-encoded |
| Snapshot | `gh api graphql -f query=<query> -F owner=<owner> -F name=<name> -F number=<n>` |

So an admission makes 7 requests, plus one per extra timeline page. A refusal can stop earlier. `admit` never passes `--paginate`: `gh` would follow GitHub's `Link` headers to `api.github.com` and leave the integration. See `docs/prototypes/github-polling/README.md`.

### Snapshot

The snapshot is the title and body when the label was applied. Let `L` be the event's `created_at`.

1. The title comes from the GraphQL read, which also returns the issue's title renames, at most 100. The snapshot is ambiguous when a `renamed` timeline event or a rename in that read is at or after `L`, when that read's rename count differs from the number it returned, or when its title differs from the title the issue read returned or from the title after its newest returned rename. So a rename between the reads is refused. The GraphQL body must also equal the body the issue read returned.
2. When the body's `lastEditedAt` is `null` or earlier than `L`, the current title and body are the snapshot, and `snapshotSource` is `unedited`, but only when the edit history agrees with the body. It contradicts the body when a version was saved at or after `L`, when a version is newer than `lastEditedAt`, or when `lastEditedAt` is `null` and the history has any version other than the original. Every version must have been returned. When `lastEditedAt` is `null`, every returned version must equal the body. A never-edited issue has no versions at all, and that is proof enough. When `lastEditedAt` is set, exactly one version must be the latest, it must not be deleted, and it must equal the body. GitHub records the original only on the first edit, so an edited body with no versions is refused.
3. Otherwise the body comes from the GraphQL edit history. It is proved when all of these hold: every version was returned, the history includes the original, the newest version equals the current body and was saved at `lastEditedAt`, no version was saved in the same second as `L`, and exactly one version is the latest saved before `L` and it is not deleted. That version is the snapshot body. `snapshotSource` is `edit_history`.
4. Anything else is `ambiguous_snapshot`.

GitHub sends an empty body as `null`, in REST and in GraphQL, for the current body and for each version's `diff`. `admit` reads every such `null` as the empty string.

`snapshotDigest` is the sha256 hex digest of `JSON.stringify([title, body])` in UTF-8. The current body at poll time is never used as the snapshot unless rule 2 applies.

### State

An admission writes `<state-dir>/admissions/github/<owner>/<name>/<issue>/<event-id>.json` with mode 0600, in directories created with mode 0700. It holds the receipt and the snapshot title and body. The record is first written to a temporary file, `.<event-id>.<random>.tmp`, in the same directory, and then hard-linked to its final name, so a record is never seen half-written. The temporary file is removed whatever the outcome. The link fails when the final name exists, so a second admission of the same event is refused as `duplicate_event`. When a directory cannot be created, including when a file sits where a directory belongs, or the temporary file cannot be written, the refusal is `state_unwritable`. A refusal writes nothing.

### Receipt

| Field | Type | Meaning |
| --- | --- | --- |
| `decision` | string | `admitted` or `refused`. |
| `repo` | string | The `--repo` value. |
| `issue` | number | The `--issue` value. |
| `issueUrl` | string | `https://github.com/<repo>/issues/<issue>`, built by the factory. |
| `reasons` | array | Empty when admitted. Otherwise every refusal reason found, described below. |
| `eventId` | string or `null` | The admitted or examined label event's ID. |
| `eventAt` | string or `null` | That event's `created_at`. |
| `actor` | string or `null` | That event's actor login. A login that does not match GitHub's login grammar is printed as `(withheld)`. |
| `actorPermission` | string or `null` | The `permission` GitHub reports for the actor: `admin`, `maintain`, `write`, `triage`, `read` or `none`. An admitted receipt has only `admin`, `maintain` or `write`. GitHub folds `maintain` into `write` and `triage` into `read` in this field, so in practice it is `admin`, `write`, `read` or `none`. |
| `snapshotDigest` | string or `null` | Described under snapshot. |
| `snapshotSource` | string or `null` | `unedited` or `edit_history`. |
| `baseSha` | string or `null` | The `main` SHA the trusted workflow was loaded from. |
| `workflowDigest` | string or `null` | The sha256 digest of that `WORKFLOW.md`. |

When `decision` is `admitted`, every field is set. When it is `refused`, a field is `null` when admission stopped before reaching it. The receipt never contains an issue title, body, comment, label name or `gh` output. Credentials are redacted from every string as for the other commands.

GitHub's login grammar here is 1 to 39 letters, digits and single hyphens, not starting or ending with a hyphen, optionally followed by `[bot]`.

### Refusal reasons

Each reason has `kind`. Some have more fields.

| `kind` | Cause | Extra fields |
| --- | --- | --- |
| `repo_not_allowed` | `--repo` is not on the allowlist. | |
| `state_unavailable` | `--state-dir` does not exist, is a symlink or not a directory, is not owned by the effective user, is writable by group or others, or the disable entry cannot be checked. | |
| `locally_disabled` | An entry named `<state-dir>/disabled` exists, including a dangling symlink. | |
| `repo_switch_off` | The `factory:enabled` label does not exist (HTTP 404), or its name differs in case. | |
| `repo_switch_unavailable` | Reading the `factory:enabled` label failed for any other reason. | `failure` |
| `workflow_unavailable` | `WORKFLOW.md` on `main` did not load. | `error`, the `workflow-check` error kind |
| `issue_unavailable` | Reading the issue failed. | `failure` |
| `pull_request` | The number is a pull request. | |
| `issue_closed` | The issue is closed. | |
| `not_labeled` | The issue does not have `factory:ready`, or its latest `factory:ready` timeline entry is `unlabeled`. | |
| `no_label_event` | The issue has the label but its timeline has no `factory:ready` event. | |
| `timeline_unavailable` | Reading the timeline failed. | `failure` |
| `actor_withheld` | The event's actor login does not match GitHub's login grammar. Its permission is not looked up. | |
| `permission_unavailable` | Reading the actor's permission failed. A login that is not a user gives HTTP 404. | `failure` |
| `unauthorized` | The actor has `triage`, `read` or `none`. | `permission` |
| `snapshot_unavailable` | The GraphQL edit-history read failed. | `failure` |
| `ambiguous_snapshot` | The admitted label event, or the title and body at its time, cannot be proved. | `detail` |
| `duplicate_event` | This event was already admitted into this state directory. | |
| `state_unwritable` | The admission record could not be written, or a directory on its path could not be created. | |

The repository switch reason comes first. When the issue also fails a check, that reason follows it, so `reasons` has at most two entries.

`failure` has `kind`:

| `failure.kind` | Meaning | Extra fields |
| --- | --- | --- |
| `gh_failed` | `gh` exited non-zero. | `cause` and `status`, as in the `workflow-check` error kinds |
| `cannot_run_gh` | `gh` could not be started. | |
| `malformed_response` | `gh` printed something that is not the expected JSON, such as a proxy error page, a field of the wrong type, or a permission answer for another user. | |
| `pagination_limit` | The timeline has more than 1000 entries: 10 full pages and a non-empty 11th. | |

`detail` is one of these:

| `detail` | Meaning |
| --- | --- |
| `label_events_same_second` | Two `factory:ready` timeline entries, `labeled` or `unlabeled`, share the latest `created_at`, so the admitted event is unknown. `eventId` and the later fields are `null`. |
| `renamed_since_label` | The title changed at or after the label, by the timeline or by the GraphQL read. |
| `rename_history_incomplete` | The number of renames the GraphQL read returned differs from its `totalCount`. At most 100 are read. |
| `title_changed_between_reads` | The GraphQL title differs from the title the issue read returned, or from the `currentTitle` of the newest rename in the same GraphQL read. |
| `body_changed_between_reads` | The GraphQL body differs from the body the issue read returned. |
| `edited_at_label_time` | A body version was saved in the same second as the label. |
| `history_contradicts_last_edit` | `lastEditedAt` is `null` or earlier than the label, but a body version was saved after the label or after `lastEditedAt`, or `lastEditedAt` is `null` and the history has a version other than the original. |
| `history_incomplete` | GitHub returned a different number of versions than its `totalCount`. At most 100 are read. |
| `history_without_original` | The history does not include the original body. |
| `history_disagrees_with_body` | The newest version is not the current body, or was not saved at `lastEditedAt`. For an `unedited` snapshot: `lastEditedAt` is set and the latest version differs from the body or no version was returned, or `lastEditedAt` is `null` and a returned version differs from the body. |
| `no_version_before_label` | No version was saved before the label. |
| `version_withheld` | The version in force at label time is deleted, or two versions share its time. For an `unedited` snapshot this applies to the latest version. |
| `answer_at_label_time` | The controller only, not `admit`: the label event links to a `needs_info` run, and a comment that could be an answer was created in the same second as the label, or the label shares the second of that run's `needs_info` marker. Neither can be ordered against the label. Relabel to admit it. |

## Build patches (F07a)

The builder works on a fresh pinned tarball copy, never the accept workspace or controller checkout. It gets the digest-checked contract, trusted `## build` guidance, named files and the applicable playbook from the bundled pstack dependency. It receives no held-out scenario IDs or code. Build grants coding tools, requires test-first work and forbids GitHub writes. The gateway allows only its pinned model and read-only npm. See `docs/operations/sandbox.md` for the shell boundary and mount layout.

Collection compares both trees in code-unit path order, with renames represented as deletion plus addition. It includes binary files, executable modes and safe symlinks, rejects escaping/cyclic chains and specials, and calls `checkChangedPaths` on every changed side. Base symlinks are omitted from both sides and counted in `checkout_paths_omitted`; this repository currently has none. Real `node_modules` directories and an empty root `.git` mask are not patch inputs. Symlinked caches, links through them and symlinks replacing top-level directories are refused. Empty patches fail. Contract v1 has no validated no-change outcome field, so prose cannot authorize one.

Private files are `<state>/patches/<runId>.json` (the regeneration guard), `<state>/patches/<runId>/collected.json`, `patch.diff` and `tests.json`. Directories are 0700 and files 0600. The collection receipt binds the run, base SHA, contract digest, acceptance digest, raw-byte patch digest, sorted changed paths, policy, model identity and bash command/exit records parsed from writable builder sessions. Those records carry `commandsSource: "builder-reported"` and an omitted count, and never substitute for controller validation. Patch bytes are capped at 64 MiB, serialized collection receipts at 8 MiB and command records at 128 KiB; writer and reader share these limits, and oversized writes are refused before anchoring. The receipt records the resolved base test command, `scriptsChanged`, `testScriptChanged` and `testInputsChanged`. The test receipt binds the four run fields and patch digest and holds the command, measured exit code, wall time and last 16 KiB of private output. These records never enter status JSON, markers or public comments. A failed test record is write-once and cannot be overwritten by a later passing result.

Visible tests run without a model on a new tree made from the pristine base and the exact collected bytes. Lockfile dependencies install with scripts disabled. The default is `npm test`; trusted build guidance may name `Visible test command: \`command\``. The command is resolved from the trusted base `package.json` at `base.sha`, never the patched scripts. The base script table is restored in the test-only manifest as well, so nested `npm run` calls keep using base scripts without rewriting shell literals. Pre/post and install lifecycle scripts remain suppressed. After applying and re-collecting the patch to verify its digest, deleted base test files are restored in the test-only tree, except exact files named in the digest-checked private contract's `replacesTests` list. Modified and added tests remain candidate input, so regressions added to existing files still run. Script and test-input changes are disclosed in the receipt and summary. These are visible tests, not held-out validation or the trusted CI gates added in F07b. A successful builder's final text is never a verdict.

The shared F06a renderer posts one summary keyed `<!-- factory-build run=<runId> p=<patchDigest> -->`, listing changed paths (truncated with an omitted count), visible-test success/failure and the digest prefix, with no code or output. Forbidden work stays private with that owner reference and ends failed; no patch is attached publicly and no PR is created. A restart reuses an anchored patch after recomputing its digest. A lost or changed file ends failed with `patch_missing`, `patch_changed` or `patch_invalid`; it never silently rebuilds. An interrupted collection whose guard exists but whose files are incomplete also fails closed. Missing test results are recomputed from the stored patch in a fresh test sandbox, without a builder. Matching `tests.json` binding values are reused; mismatches fail closed. A failed sandbox preflight waits at recovery rather than ending the run. Infrastructure failures, including timeout (180 seconds), are private `unavailable-*.json` records with `reason: "visible_tests_unavailable"` and a typed detail. They retry under the stage attempt cap, do not write `tests.json` and never post “Visible tests: failed”. Real failing test results remain write-once.

A replayed build attempt always recopies its workspace from pristine. The controller removes the build workspace and writable builder agent directories after settlement, the pristine tree after tests or a failed/forbidden build, and test trees/agents after each test attempt. It retains private patch/test stores, receipts and bounded logs. Recovery re-extracts the pinned base when needed. A 1 GiB / 100,000-entry post-stage size check counts dependency caches, sessions and empty directories and refuses `build_disk_limit`. This is not a filesystem quota and does not prevent a transient overshoot before settlement.

## Publish and validate (F07c)

Successful build enters the candidate protocol at validate, shown as `running`. Deterministic validation holds no model slot. Further scoped ticks publish, find CI, collect the trusted result, and schedule fresh review using normal capacity. The bounded candidate book owns the selected generation, immutable archive, captured execution accounts, published PR, readiness, and pending effect. `advance` and the controller use the same `handoffCandidate` policy.

The controller verifies the private patch, acceptance suite, and visible-test receipt before publication. Git Data writes use the bot's fixed identity and event timestamp. Deterministic commits add the patch, then exact `checks/*` bytes under `test/acceptance/<issue>/`. The private manifest, suite JSON, and canary file are not published; canary text inside checks is public. Generation zero keeps `factory/run/<issue>-<runId12>-r<round>` and its original commit bytes. Later generations append `-g<N>` to that validation branch. A conflicting ref is preserved. Symlinks and the reserved `.factory-feedback.json` path are refused.

A published-PR successor's final suite commit has ordered parents `[new patch commit, previous published head]` before CI and review. The stable PR ref is `factory/pr/<issue>-<runId12>`. It advances only to an already-certified candidate with expected-predecessor checks and `force:false`, followed by ref and PR rereads. This is ancestry protection, not atomic expected-head CAS. Ref/PR head lag and missing ordinary PR `check` keep handoff incomplete.

Main movement selects a new immutable generation after active work stops and known charges settle. It consumes a run-wide refresh, not a repair. At most three refreshes, two shared repairs, and six generations are retained. Reapplication preserves the contract and patch digest but requires new CI and genuinely fresh review. No same-patch review carry or old-seat rebind is supported. Verdicts retain distinct `originalBase` and certified `baseSha`; instructions remain pinned to admitted `workflowSha` and `workflowDigest`. A conflict or exhausted allowance holds the handoff. Once a PR exists, failures leave that PR open and not-ready rather than starting F10 repair or a budget-resetting run.

Dispatch uses main's `ci.yml`, the exact candidate SHA, digests, and nonce `<runId16>-r<round>-d<try>` at generation zero, with `-g<N>` appended for later generations. The claim persists the try before POST. The proxy currently returns 204 without a run ID. The controller finds the run by nonce, main branch, workflow path, event, bot actor and creation time. An unanswered dispatch waits 120 seconds before a second attempt; there are at most two attempts. A CI conclusion never triggers a redispatch. Each read or publication call retries transient failures at most three times with backoff. Claim counters record those attempts but never exhaust future calls. Transient read and receipt-download failures wait until the 20-minute deadline. After the deadline, a run already concluded by that deadline is still collected; otherwise validation ends `ci_timeout`. Switch-off holds new work and publication. Existing-PR observation, stopping, accounting, and terminal bookkeeping remain available.

The controller downloads `gate-receipt` using the repository-scoped artifact API, not `gh run download`, whose absolute API URLs fail on the VM proxy. The gates job log is a fallback. Neither logs nor artifacts are mounted in a repair workspace. Collection requires receipt v2, zero model calls, the exact candidate, nonce, held-out digest and run `head_sha` gate revision equal to the candidate's `baseSha`. Every mandatory and receipt-required check must appear exactly once and pass. Missing receipts, empty check sets, cancelled, skipped, stale and incomplete results never pass.

Every finished hard verdict gets `assessment.json` in its validation directory before any `feedback.json`. It is the canonical record of the run, round, generation, candidate, CI run and verdict digest, plus one closed class: `passed`, or failed as `candidate`, `oracle`, `missing_evidence` or `infrastructure` with a fixed subreason. Its digest is the reference the book carries. The record is written once, read back before use, and reused unchanged on the stored-verdict path and after a restart; an absent record is rebuilt from the stored receipt with the same bytes, and conflicting bytes fail. `feedback.json` is written only for a `candidate` class, as version 2 carrying that reference. A non-heldout candidate check failure, such as lint, classifies `candidate`. A non-candidate class posts one keyed comment, `<!-- factory-diagnosis run=<runId> g=<round>.<generation> a=<recordDigest> -->`, with a fixed class sentence and scenario IDs only. A disagreement adds the sentence for its pair: `CI and the gate-tree replay disagree.` for `ci_replay_disagrees`, `Gate and candidate replays disagree.` for `tree_replays_disagree`, and `The replay's ignored changes differ from CI's in <N> paths.` for `materialize_mismatch`, which gives the count and never the paths. `unsupported_materializer` adds `The gate's materializer differs from the controller's.`

The receipt's `replacementsDigest` must match the contract's before any class, early aborts included. A scanner rejection (`invalid_source_encoding`, `runtime_patching` or `suppression_added`) blames the candidate only when every rejected file the receipt names in `tamperSignals` is one of the candidate patch's changed paths and lies outside `test/acceptance/`. A rejected generated check, an unchanged base file or a receipt that names no file is `missing_evidence` (`incomplete_ci`). The gate records each encoding rejection as a `tamperSignals` entry with rule `invalid_source_encoding` and line 0. A per-test `timeout` in either replay is `infrastructure` (`timeout`) before agreement, oracle or candidate, even beside other failures.

An executed hard `heldout` failure, or a dependency-policy early abort, is diagnosed before it is classified. The validate effect starts one owned job and keeps returning `waiting`; the tick never awaits it. The job writes `diagnosis/<bindingDigest>/intent.json` first, then fetches the gate and candidate tarballs with the same strict extraction as checkout. Each fetch is bounded by the job's deadline, less a cleanup reserve of a tenth of the allowance up to 5 seconds, and by its abort signal, so a release or `stop` never waits on an outstanding fetch; a fetch cut short classifies `infrastructure` (`timeout`). The replay runs only when the gate tree's `server/gates.ts` is byte-identical to the running controller's module, so the materializer is the one CI ran; otherwise the class is `missing_evidence` (`unsupported_materializer`). It overlays the candidate onto the gate tree with the shared materializer and runs the published suite on that gate tree and on the full candidate tree, through bwrap with no network and no credentials, in a `factory-stage-<owner>-<run16>-diagnosis-<round>-<nonce>` user scope that the startup reconcile stops. Its deadline is the lesser of 180 seconds and the validation wall still unspent, setup included; with no wall left it records `infrastructure` (`timeout`) without launching. The classifier gets both replays, the stored qualified base receipt, the replay's `ignoredChanges` for parity with the CI receipt, and the trusted dependency validator's verdict on the candidate manifests. When the generation's base differs from the contract's base, the job first runs the base check on the gate tree for that generation, inside the same deadline, and keeps it as `refreshed-base.json`. A refreshed base that does not qualify never reaches the oracle rule: `base_nondeterministic` classifies `infrastructure` (`base_nondeterministic`), `base_timeout`, `base_runner_error` and `base_interrupted` classify `infrastructure`, and every other refusal classifies `missing_evidence` (`base_missing`). The job keeps `replay.json` and `charge.json` (wall time, zero tokens), deletes its trees, then writes `assessment.json`. The candidate branch is deleted only after the assessment exists. A restart that finds the intent with a `replay.json` and `charge.json` that parse and round-trip byte for byte classifies from them without rerunning or charging again. A restart that finds the intent without that completion evidence stops the scope the intent recorded, records `interrupted.json` once, charging the whole frozen allowance, and classifies `infrastructure` (`interrupted`); it never relaunches. An `infrastructure` class holds durably with no CI redispatch.

Before every `repair_build` launch, restored and retried launches included, the controller re-reads the assessment named by the execution's repair cause. A validation cause needs a matching `candidate` record; a review cause needs a matching `passed` record. A review-driven repair is due only for a blocking review, and its cause also carries the digest of the review receipt's stored bytes; a failed certification of a non-blocking review holds as `evidence_unavailable`. The production executor reads the assessment from the validation directory on disk. Anything else refuses the launch, logs `repair_refused` and ends the run `failed` with `diagnosis_missing_evidence`. A stored book whose repair lacks its cause does not parse.

Generation-zero validation evidence uses `<state>/validation/<runId>/` at round zero and its `r<N>/` directory at later repair rounds. Later generations add `g<N>/` under the round's directory. Review evidence uses `review/<runId>/r<N>/`, with the same optional `g<N>/` suffix. Repaired patches retain `patches/<runId>.r<N>.json` and the same-named directory. There are no latest-evidence aliases.

`generation.json`, `archive.json`, `certification.json`, validation state, hard receipts, verdicts, and trusted report identities preserve each generation's bindings. A verdict binds patch, acceptance, held-out digest, candidate, gate, and CI run; judge-only scenario IDs remain `unjudged` until review. A failure records its reason without inventing CI identity. Private files are mode 0600 under 0700 directories. Review reconstructs certified `baseSha` plus patch in a separate `review-base/<baseSha>/` export, never the public suite branch or original pristine repair base. Pinned instruction failures remain `workflow_checkout`, `workflow_mismatch`, or `workflow_invalid`; stored-output recovery cannot fall back to newer guidance.

Review issuance is round-global across generations. Effective attempts are at most three, respecting stricter configured one/two limits; early retry-5 workflows remain valid. Review shares 30,000 tokens per round, repair build 50,000, and both retain the configured cumulative run cap. Captured execution descriptors bind round, generation, attempt, full input, workflow pin, and CI identities. Progress and late results charge only their own account high-water. Missing/unknown spend cannot grant a fresh allowance.

Cleanup enumerates current, archived, and terminal-pending validation generations without rewriting their immutable evidence. It waits for existing CI or the saved deadline, never redispatches released work, and deletes only the exact owned validation ref after rereading its head. Moved tips are preserved. Each generation has its own `pending-deletion.json` and `cleanup.json`; a stored verdict retains precedence over a legacy failure file.

Clean certification opens or adopts one owned non-draft PR, persists its identity before reviewer/label/comment effects, and completes exact-head handoff. It then projects `waiting` at the merge checkpoint. A merge observation from any PR-backed phase drains captured accounts before recording the actual head, merge SHA, actor, and historical-certification assurance. Closed-unmerged cancels. No controller path merges a PR. See [the owner procedure](human-review.md).

### Deploy marker v3

F09a is a forward-only drained rollout. The parser retains v1/v2 as generation-zero history; terminal F08 runs are never revived. New v3 markers add the compact candidate summary described under [Markers](#markers). They do not contain the private candidate book. Older controllers must not restart over new markers. There is no migration daemon or supported arbitrary backup rollback. Deployment and service actions need their own grants; the [owner procedure](human-review.md#roll-forward-from-a-drained-controller) gives the sequence.

A restart resumes a valid saved candidate intent without granting a new model budget. Missing private evidence blocks candidate work, even when public PR and marker fields exist. Narrow merge observation can remain available, but cannot invent certification, account settlement, or terminal completion. Retain claims and private evidence. Never delete them to force a replay. Cleanup targets exact owned validation refs, never `factory/pr/*`, `factory/ledger`, main, or owner refs.

## Trusted candidate gates (F07b)

```bash
node server/cli.ts gates --repository <git-dir> --gate-sha <40-hex> \
	--candidate-sha <40-hex> --nonce <id> --output <receipt-dir>
```

`gates` uses Docker by default. The Docker runner requires host UID 1001, as on GitHub-hosted runners, because installation directories belong to the invoking user. Operators with another UID must use `--runner local`. That runner uses bubblewrap with a new session, unshared namespaces and the local Node runtime, not Docker. Both runners disable network access during installation and checks. Neither mounts the controller state or inherits credentials. The local runner mounts system programs and the Node installation explicitly.

`gateSha` is the trusted main tip at dispatch. The candidate must descend from that commit. `.github/workflows/ci.yml` accepts `workflow_dispatch` on `main`. Its `gates` job has read-only permissions. A separate `report` job has `actions: read` and `checks: write`, with no candidate checkout or execution, artifact-supplied code, or stored secret. Dispatches on another ref cannot certify a candidate.

The reporter requires the complete receipt, including `install`, `baseline_tests`, `typecheck`, `lint`, `format`, `main_tests`, `candidate_tests`, and `heldout`, plus any additional receipt-required checks. Each result must occur once with exit 0, no signal, and no timeout. It requires nonempty held-out counts, the exact held-out digest, and zero model calls. Missing or invalid hard evidence emits failure, not skipped success.

The `factory-report` artifact records the reporter-owned check ID, run ID, candidate and gate SHAs, nonce, workflow path, main ref, event, actor, triggering actor, held-out digest, and explicit external ID `factory-gates:<runId>:<nonce>`. Default Actions GUIDs are not run IDs. Collection binds this record to the actual completed-success `factory-gates` check from app 15368 and the exact bot-dispatched run. It queries `check-runs?filter=all&per_page=100`, requires `total_count` to equal the complete returned list, and refuses duplicate or ambiguous reports. Same app/name or a GraphQL rollup alone is insufficient.

The ordinary PR `check` remains required at the promoted head. `check.yml`'s compatibility job is named `factory-compatibility` on `factory/pr/*`, `factory/run/*`, and integration-bot PRs. Other PRs get a harmless `factory-gates` compatibility context, not factory certification. A skipped job named `factory-gates` on factory heads would be unsafe. Native main-backed reporter/P4 proof remains pending the owner-merged bootstrap.

The command starts from the gate tree and replaces `src`, `extension`, `server`, `skills`, and `scripts` with candidate files. It also takes the candidate's Markdown files outside `.github/` and `test/acceptance/`, including additions and deletions, so held-out checks read the documentation the candidate wrote. It preserves main's tests and adds candidate-only tests. Main owns the manifest argv, TypeScript configuration, lint plugin and tools. The manifest's `testGlobs` are `test/*.test.ts` and `test/sandbox/*.cases.ts`. They expand only over main's exported tree at `gateSha`, before candidate files are overlaid; each must match at least one file. Top-level tests run directly, and `test/sandbox.test.ts` imports the sandbox cases. Per-file baseline counts therefore include new tests as soon as they land on main, without a manifest edit. Candidate-added tests run separately as `candidate_tests`. Adding a visible test needs no `.github` change in either the trusted gate or the ordinary root `npm run check`. Biome uses main's preserved root `biome.json` through `/w/biome.json` after nested candidate Biome, EditorConfig and ignore files are removed. Resolving that configuration inside `/w` keeps its exact acceptance exclusion relative to the checked tree. Oxlint disables nested configuration, reads an empty ignore file and excludes exactly `test/acceptance/**` through its argv.

Overlaid JavaScript and TypeScript source must be UTF-8 without NUL bytes, U+2028, U+2029, or lone CR line terminators, or the gate fails with `invalid_source_encoding`. The host reads changed lines with `git diff --text` and uses main's `scan-rules.json`. Added `@ts-nocheck`, `@ts-ignore`, `@ts-expect-error`, `oxlint-disable*`, `eslint-disable*`, and `biome-ignore*` patterns, matched case-insensitively, fail with `suppression_added`. Unchanged main directives and dispatched held-out files are exempt from that rule, but held-out files still receive the runtime scan.

The runtime scan is a tripwire, not a complete defense. It matches direct forms in the scanned file, including literal built-in imports, literal `require` and dynamic imports, and aliases from variable initializers. It flags assignments, updates, deletions, and the `Object` and `Reflect` mutators listed in `scan-rules.json` when their target resolves to a built-in member, `Module`, `module`, `require.extensions`, or a listed process member. Those process members are `exit`, `reallyExit`, `exitCode`, `on`, `once`, `addListener`, `prependListener`, and `prependOnceListener`. It also matches `module.register` and `registerHooks` calls and process listeners with literal `exit`, `beforeExit`, or `uncaughtException` event names. Matches fail with `runtime_patching`; `tamperSignals` records each path and line. The scan does not follow helper parameters, variable event names, later assignments, computed strings, or evaluated code. Review candidate C1 used a helper to patch `Readable.prototype.read` without a scan hit. That method is now pinned, so C1 fails, but helper-based changes to unpinned members can still evade the scan.

Tests preload frozen assert and test exports. The preload pins `Readable.prototype.push` and `read`; `Serializer.prototype` and `DefaultSerializer.prototype` methods `writeHeader`, `writeValue`, `writeRawBytes`, and `releaseBuffer`; stdout's `write` and `_write`; and guarded `process.exit` and `process.reallyExit`. A separate main-on-main test run supplies per-file counts. Missing results, failures, skips, todos, empty test files and mismatched counts veto success. Node's per-test timeout is 60 seconds. The baseline process deadline is 180 seconds. The owner raised it from 90 seconds on 2026-11-03, after main's own baseline took 89.9 seconds on the GitHub runner. Candidate checks get the greater of 90 seconds or three times measured baseline test time plus 30 seconds. A missed baseline deadline is incomplete. After a candidate timeout, the gate repeats the corresponding check on main with the same deadline. If main also times out, the result is `incomplete` with `baseline_deadline`. If main finishes successfully, the candidate timeout is a failed check. Deadline controls also appear in `requiredChecks`.

These in-process guards are strong against accidental and lazy cheating, not a model that deliberately subverts Node's test runner. Candidate code runs inside the process that produces reporter events. Held-out tests share this exposure. The owner's v1 review and F08 review are further defenses.

Dependencies come from the candidate's lockfile. The host fetches only integrity-checked registry tarballs and refuses redirects. A separate offline container runs `npm ci --ignore-scripts` from those bytes. Git, file, URL, workspace dependencies, and `.npmrc` edits fail policy checks. Registry `npm:<name>@<range>` aliases are allowed throughout the dependency tree. Each tarball path must match the package's real name and pinned version. An alias must be declared under its alias name by its parent's dependency group in the same lockfile, including hoisted resolutions. Its entry must name the real package and resolve to that package's registry path. A parent with unchanged version, tarball, and integrity cannot change an alias declaration from main's lockfile. A package swap fails with `package_swap`. Install scripts remain unrun and appear in the receipt. Main's gate tool dependencies install separately and cannot be replaced by candidate packages. `newDependency: true` is the `new_dependency` signal for a later publisher. F07b does not apply a label or publish a branch.

For behavior-change tickets, specify may emit `replacesTests: [{path, reason}]`. Each path must name an existing `.test` or `.cases` file under `test/`, outside acceptance. Helpers and fixtures cannot be replacements. The candidate must retain the named file and run at least one passing, non-skipped test. The gate does not judge what a replacement asserts. The receipt records its before and after SHA-256 digests. All unnamed main tests stay mandatory. For a private run, pass `--state-dir`, `--run-id`, and `--contract-digest`. The command reads and verifies that private contract. The workflow instead receives `--replacements '<list JSON>'` and `--replacements-digest <sha256>`. The digest covers compact JSON in list order, with `path` before `reason` in each item. Only a trusted dispatcher may supply this authorization. No contract text is sent to CI. F07c's dispatcher supplies optional `heldout_dir` and `heldout_digest` inputs, or the corresponding `--heldout-dir` and `--heldout-digest` flags. Both must be present together. The directory is `test/acceptance/<ticket>`. The digest is SHA-256 of compact JSON of sorted `[repository-relative path, sha256(exact bytes)]` pairs for its `checks/*` files. The gate verifies the candidate SHA's bytes and runs those files last as `heldout`, with the same preload and runtime scan. Each file must register a test with no skip or todo. Added or modified candidate files under `test/acceptance/` outside the dispatch's digest-matched `checks/*` list fail with `unauthorized_acceptance`. Unchanged files already on main need no dispatch. Static checks exclude exactly `test/acceptance/**`. No held-out log is written or uploaded. Only counts and failing file paths enter the receipt, never assertion text or test titles. A check file that fails to load is listed as a failing file path.

Exit codes are 0 for `passed`, 1 for `failed` or `incomplete`, and 2 for invalid CLI arguments. The host writes receipt version 2 to `receipt.json`, with exact SHAs, nonce, replacement digests, dependency changes, named exit codes, signals, timeout flags, test counts and durations. `requiredChecks` lists every mandatory result. `receiptPasses` rejects any missing or duplicate check, even if all remaining checks are green. Each dispatch uploads one artifact named `gate-receipt`. Fixture matrices alone use per-case suffixes. Non-held-out logs are separate files beside the receipt and never decide success. Policy refusals are `failed`. Docker exits 125 through 127, runner errors, baseline failures and stale bases are `incomplete`. A missing or cancelled run is incomplete even if another check passed. Never use an empty check list as a verdict.

## Controller

```bash
node server/cli.ts tick --once --json --repo <owner/name> --state-dir <dir> [--issue <number>]...
node server/cli.ts run --json --repo <owner/name> --issue <number> --state-dir <dir>
node server/cli.ts serve --repo <owner/name> --state-dir <dir> [--issue <number>]...
```

The three controller commands share one implementation, `Orchestrator` in `src/orchestrator.ts`. `run --issue <n>` is a tick limited to issue `n`, so a manual run passes the same switches and the same admission as polling. With `--issue`, `tick` and `serve` read, claim and write markers only for the named issues. Verification lanes use that to keep clear of the production controller.

### Start

Each command does these steps in order and stops at the first that fails:

1. The repository must be on the allowlist and the state directory must pass the `admit` rule: it exists as a directory, not a symlink, owned by the effective user and not writable by group or others. Otherwise it logs `controller_refused` with `repo_not_allowed` or `state_unavailable` and exits 1.
2. It takes the lock, described below. If another controller holds it, it logs `controller_running` with that controller's pid and exits 2. `tick` and `run` also print `{"error": "controller_running", "pid": <pid>}`. The pid is `null` when the holder's `controller.lock` is missing or unreadable. No `gh` call has run yet. If the lock cannot be taken for another reason, such as a state directory whose real path cannot be resolved, a socket that cannot be bound, or a `controller.lock` that cannot be written, it logs `controller_refused` with `lock_unavailable` and exits 1.
3. It checks that `gh` acts as the integration bot. It reads `gh api graphql -f query='query { viewer { login } }'` and requires exactly `exe-dev-github-integration[bot]`. Without `GH_HOST`, `gh` on the VM has no credentials and the read fails, and on a workstation it answers as the owner. Either way it logs `controller_refused` with `identity_unavailable` or `identity_mismatch`, releases the lock and exits 1. See `docs/prototypes/restart-recovery/README.md`.

`serve` then logs `controller_ready` with its pid, repository and scope. That line means the service is ready.

### Verification token cap

`--verification-token-cap <n>` lets a verification lane test an almost exhausted run budget without spending most of main's 500,000-token cap. It is not for production, and `server/factory.service` never passes it.

- It requires `--issue`. A missing scope, or a value that is not a positive integer, is a usage error. Other commands refuse it.
- After the identity check and before the first tick, the controller pins `<state-dir>/verification.json`, mode 0600. The file holds the repository, the sorted issue scope and `n`. The first run requires a state directory that holds nothing but `controller.lock`. Each later run must name the same repository, scope and cap.
- It logs `controller_refused`, releases the lock and exits 1 with `verification_state_not_new` when the state directory already holds other state, and with `verification_manifest_mismatch` when the scope or cap changed. Without the flag, a state directory that has the manifest is refused with `verification_state`.
- The effective run cap is `min(n, usage.max_tokens_per_run)`. Every limit that reads the run cap uses it, including launch allowances, the retry budget and the candidate's token limit.
- Each terminal row from that directory has `provenance.kind: "verification"`, with the manifest's digest, the trusted cap and the effective cap. Production cohorts exclude these rows.

### The lock

The lock is a Linux abstract Unix socket named `\0pi-herdr-factorio/<sha256 of the state directory's real path>`, bound with `net.createServer().listen({ path, exclusive: true })`. The kernel lets only one process bind a name, so of two controllers started together exactly one runs and the other gets `EADDRINUSE` and exits 2 with `controller_running`. The kernel frees the name when the holder exits for any reason, including `kill -9`, so there is never a stale lock to break. The name comes from the real path, so a state directory reached through a symlinked parent names the same lock, and two state directories never collide. A `--state-dir` that is itself a symlink never reaches the lock: step 1 refuses it with `state_unavailable`. `docs/prototypes/restart-recovery/README.md` records the probe on the VM.

`<state-dir>/controller.lock`, mode 0600, only names the holder for `status`. The controller writes it after binding the socket, with its pid, its start time from field 22 of `/proc/self/stat`, and when it took the lock. It removes the file on exit, only while the file still names it. A file left by a controller that is gone is replaced and logged as `lock_stale_replaced` with the old pid. The file is never the authority: deleting it does not free the lock. `status --json` connects to the socket to see whether a controller holds it, and never binds it.

### One tick

At startup a tick first reconciles owned processes and loads saved claims. F09a then observes existing candidate PRs before early-stage reconciliation or switch decisions. It consumes captured results only after that observation, with stop/account/terminal bookkeeping still allowed while dispatch is held. After the normal reads and discovery below, it observes candidates again with the current dispatch/capacity decision. New candidate publication and model work require that decision to be open.

The following steps describe early-stage scheduling. Reconciliation runs before per-tick reads, and new dispatch requires every per-tick read to succeed. PR-backed candidate terminal precedence is described above and in [the owner guide](human-review.md).

1. Reconcile stages. Every stalled stage is aborted, and every finished or stalled stage becomes a retry or a terminal status in memory, using the last valid workflow's limits. Only then are their markers posted, so a slow marker request never delays an abort. Posting may first read back a marker whose POST did not answer.
2. Candidates: open issues with `factory:ready`, from `gh api repos/<repo>/issues?state=open&labels=factory%3Aready&sort=created&direction=asc&per_page=100&page=<p>`, paged as the timeline is. A failed read adds `candidates_unavailable` and skips dispatch. The list lags a label change by about 6 s: on #147 on 2026-10-29, an added `factory:ready` first showed in it after 5.9 to 6.4 s in 3 trials, while a direct issue read showed the label every time. So a newly added or re-added label is claimed on the first tick after the list shows it. A held issue missing from the list is read directly in step 3 before it is released, so the lag never releases a run wrongly. The list can also still show an issue that was just closed or unlabeled, so a held run never launches on the list alone: see step 6.
3. Reconcile early-stage claims. A claim record rewrite that failed is tried again first. An early-stage claim whose issue is closed, lost `factory:ready`, or has a newer `factory:ready` event is released, and `claim_released` names why: `closed`, `unlabeled` or `new_event`. A newer ready event counts only on positive evidence: the timeline's latest `factory:ready` entry is a `labeled` event with a different id or an `unlabeled` entry, later than the claim's own event, or two entries in the same second. A timeline with no `factory:ready` entry, or whose latest entry is not after the claim's event, is not evidence: the claim stays unconfirmed, keeps its slot, nothing is posted and nothing is cached, so the issue is read again on the next tick. When a claimed issue's `updated_at` changed since the last check, or the last check was too close to it, as described below, its timeline and its markers are read again, both before a release for a newer ready event is posted; a corrupt ledger drops the run from dispatch, logs `claim_dropped` and lists the issue in `corrupt`. A ledger behind the local claim record, described under Markers, changes nothing for the run. A marker whose POST did not answer is read back. A claim is confirmed only when these reads succeed.
4. Per-tick reads, once each: the local switch, the repository switch, and `WORKFLOW.md` on `main` (2 requests). If any fails or is off, dispatch is skipped for this tick and `dispatch.reasons` names why. The last valid workflow's limits stay in force. Until the process has loaded a workflow once, there are no limits: there are no slots, `maxConcurrent` is `0`, and no run of any status is adopted. So no interrupted `running` run is counted as a failed attempt and no retry's due time is computed. Before the first valid workflow load, early-stage claims post only `released` markers for issues that are closed, unlabeled, or have a newer ready event. Other early-stage claims remain in `queued`, with their claim records retaining their slots. After a valid workflow has loaded, stage reconciliation can post result, retry, failure, or budget-exhaustion markers even when this tick skips dispatch. Existing PRs remain observable and can reach `landed` or `cancelled` after captured work is stopped and charged. On any tick that skips dispatch, every claim record not yet adopted, released or dropped is listed in `queued`.
5. Discover. For each candidate the controller has not seen at its current `updated_at`, and for each claim recorded locally before a restart, it reads the issue's markers. A live marker is adopted as the existing run, never admitted again, but only when its event has an admission record under this state directory. That includes a marker taken from a local claim record that is ahead of the ledger. A live marker with no such record belongs to another controller, such as a scoped verification controller with its own `--state-dir`, and `claim_foreign` is logged once per run with `issue`, `runId`, `status` and `seq`. While that marker is the issue's newest, held or not, this controller neither admits nor releases the issue. It adopts nothing for that run, admits no newer ready event and posts no `released` marker. The owning controller handles its own release. This controller's own claims on the issue are still settled. One whose run has a terminal marker is kept as an ended record. Any other keeps no slot, posts nothing, and is read again on each tick until the newest marker is no longer another controller's. An own admission whose first marker never landed and that has no claim record is kept but not yet recovered. It posts nothing and keeps no slot, and the issue is cached as decided while its `updated_at` is unchanged. Once the owner's terminal marker is read, the admission is recovered, as described under Restart, and its first marker is numbered after that terminal marker. An issue with no own claim or admission is cached the same way. The cache holds only while `updated_at` is unchanged, so a terminal marker the owner posts later is read and a newer ready event can then be admitted. When this controller's own run is released because the issue has a newer ready event, the issue is admitted in the same tick. Eligibility is decided first, for every live marker and every recorded claim. A run whose issue is closed or unlabeled, or whose event was replaced, as in step 3, is released before any adoption gate, without a slot and without a loaded workflow. Only a run whose event is still current goes on to the gate below and then to its interruption or retry decision. A `claimed` or `blocked` run whose timeline read fails or shows no evidence goes to the gate and is adopted unconfirmed, so it does not launch; a `running` or `retrying` one is not adopted, waits in `queued` holding its slot, and is read again on the next tick. A corrupt ledger stops dispatch for that issue. When the local claim record is ahead of the ledger, the run is adopted from the record, if its event has an admission record under this state directory. A `claimed` or `blocked` run of a candidate, or of a recorded claim whose issue read shows it open and ready while the candidates list omits it, is adopted only while fewer than `agent.max_concurrent` claims are `claimed`, `running` or `blocked`; otherwise it waits, holding its slot as in step 6, is listed in `queued`, and is read again on each tick until a slot is free. A `running` or `retrying` run is adopted once a workflow has loaded, whatever the count, because neither holds a slot once adopted: an interrupted `running` run becomes a retry or ends, and a retry takes a slot only when it launches. A recorded claim whose issue read shows it closed or unlabeled is released on that read, without taking a slot and without a second issue read. A recorded claim with no marker on an open, ready issue is checked against the issue's timeline. When the timeline shows the claim's event was replaced, as in step 3, the claim is released on that read, with `new_event`, or `unlabeled` when the latest ready entry is a removal. This happens before the newer event is admitted, so the newer event's first marker follows the release, and the old claim keeps no slot. The newer event is then an ordinary candidate. A timeline read that fails, or that shows no evidence, keeps the claim and its slot for the next tick, posts nothing and caches nothing. That includes a claim with no marker, left by a lost first POST or a crash before it: its `released` marker is numbered after the issue's highest `seq`, so it is `seq: 1` when no marker landed, takes its fields from the local admission record, and leaves an ended record, so reopening the issue never runs that event again. When the admission record cannot be read, the claim keeps its slot, nothing is posted, and the issue is read again on the next tick. A claim with no marker, or one whose record is ahead of the ledger, whose event has no admission record under this state directory is neither adopted nor released. It keeps no slot, posts nothing, and its issue is read again on each tick. An issue whose recorded claim was not adopted, held or released is never cached as decided. Then every issue with an ended claim record that this tick neither posted nor read has its markers read, as described under The local record and the ledger.
6. Dispatch, while slots remain. Slots are `agent.max_concurrent` minus the claims that are `claimed`, `running` or `blocked`, minus each issue with an active claim record that is not yet adopted, released or dropped as corrupt. So a claim record whose recovery read fails keeps its slot until a later read adopts it, and a claim record with no marker, left by a lost first POST or a crash before it, keeps its slot when the read finds no marker. Only a claim confirmed in step 3 or 5 launches; one whose read failed waits for a later tick. Before any stage launches, a direct `GET /issues/<n>` made in this tick must show the issue open and labeled `factory:ready`. A fresh admission and the step 3 or 5 read of an issue the list omits already made that read, so it is reused; otherwise the controller makes it just before the launch. That read is the launch-read rule: a held run, such as a claimed run, a replayed `blocked` run or a due retry, never launches on the candidate list alone. When the read shows the issue closed or unlabeled, the run is released with `closed` or `unlabeled`, nothing is launched, and its slot goes to the next candidate in the same tick. When the read fails, the run waits for a later tick. The read is made only on a tick that launches, so an unchanged tick still makes 4 requests. Each candidate with such a record, and each such record whose issue read shows it open and ready while the candidates list omits it, lowest issue number first, is recovered first, through its local admission record, with the slot it already holds, while fewer than `agent.max_concurrent` claims are `claimed`, `running` or `blocked`; otherwise it is listed in `queued`. A recovery that cannot read its records keeps the slot for a later tick. Then a due retry launches, and only once its retry marker is confirmed. A retry takes a slot only when it launches. When its workspace cannot be prepared, it stays `retrying`, is tried again on the next tick, and leaves the slot to the next candidate. Then each new candidate, lowest issue number first, goes through `admitTicket` with the per-tick reads, so it costs only the 4 issue reads. A refusal is listed in `refused` and logged as `admission_refused`, and whether the issue is read again on the next tick follows Refusals and the watermark, below. A claim takes its slot as soon as it is recorded, even while its first marker is unconfirmed, and launches once the marker is confirmed. A candidate without a slot is listed in `queued` and is not admitted.

A switch that is off blocks new claims, model launches, candidate publication, and handoff. Held early-stage runs retain their claims and resume when both switches are on, unless normal issue reconciliation releases them. Existing PRs remain observable and can still become `landed` or `cancelled` after captured work is stopped and charged.

Lowering `agent.max_concurrent` while the controller runs governs new launches and adoptions only, as Symphony's reload applies only to future dispatch. Candidate runs hold a slot only while a captured account is unsettled, including issued work or unknown settlement. Ready waiting and deterministic validation hold none. Other runs hold a slot in `claimed`, `running`, or `blocked` phases, except at `validate`. A healthy slot holder is never aborted or released because of the lower cap, and the excess drains as captured work settles or early-stage runs end. An early-stage run that is already `claimed` holds its slot, so starting its first stage after the cap is lowered adds no slot holder and is allowed. Until the number of slot holders is below the new cap, no new candidate is claimed, no early-stage `claimed` or `blocked` run is adopted into a slot, and no due retry launches. The claim snapshot shows both numbers, `active` and `maxConcurrent`, so the excess is visible while it lasts. A controller started after the change limits early-stage slot adoptions to the new cap.

An issue whose `updated_at` has not changed since the controller last decided it is not read again: no comments, timeline or permission request. `updated_at` has whole seconds, so a change later in the second the controller read the issue would keep the same value. A decision is therefore trusted only when the tick that made it started at least 1 s after its `updated_at` second ended, by the controller's clock. An issue decided sooner is read once more on the next tick. The rule assumes the VM clock is within 1 s of GitHub's, as NTP keeps it. The held run's `eventId` and the decision itself are kept apart from this watermark. Once every decision has settled and every ended claim record is confirmed, an unchanged tick makes 4 requests: the repository switch, the two workflow reads and the candidate list. The cache lives in memory, so the first tick after a restart reads each scoped candidate once.

#### Refusals and the watermark

A refusal of a candidate is cached as a decision only when it rests on evidence that a later read returns again. Every candidate comes from the list of open `factory:ready` issues, so a refusal that finds the label's evidence missing, incomplete or contradicting that list is not cached. That issue is read again on the next tick, with its own reads only, for as long as it stays a candidate and its evidence stays missing or inconsistent. The other issues keep the 4-request poll.

| Refusal | Cached until `updated_at` changes | Why |
| --- | --- | --- |
| `pull_request`, `issue_closed` | yes | The issue read shows it. |
| `unauthorized` | yes | GitHub reported the actor's permission. |
| `actor_withheld` | yes | The label event's actor login is outside GitHub's login grammar. |
| `answers_record_invalid`, `link_record_invalid` | yes | An earlier linked run's clarification record is missing, unreadable or fails integrity checks. An explicit unlinked record ends the history normally; it is not a missing link. No run starts with partial history. The reason remains in the tick snapshot shown by `status --json`; `admission_refused` logs `detail=previous_answers` or `previous_link`, with `retry=false`, once per issue change. Restore the affected linked run's original link/answers records from backup, then change the issue (for example, relabel) to retry; do not fabricate a link for an unlinked run. |
| `ambiguous_snapshot` with `label_events_same_second`, `renamed_since_label`, `edited_at_label_time`, `version_withheld` or `answer_at_label_time` | yes | The timeline or the edit history shows it, and it stays until the issue changes. |
| `not_labeled` | no | The issue read lacks the label the list showed, or the timeline's latest `factory:ready` entry is a removal while the issue has the label. When the label really was removed, the next list omits the issue, so it costs nothing more. |
| `no_label_event` | no | The issue has the label, but the timeline has no `factory:ready` event. |
| `ambiguous_snapshot` with any other detail | no | A read was incomplete, such as `history_incomplete`, or disagreed with another read. |
| `issue_unavailable`, `timeline_unavailable`, `permission_unavailable`, `snapshot_unavailable` | no | A read failed. |
| `repo_not_allowed`, `state_unavailable`, `locally_disabled`, `repo_switch_off`, `repo_switch_unavailable`, `workflow_unavailable`, `state_unwritable` | no | A condition of the controller or the tick, not of the issue. |
| `duplicate_event` | no | The event was already admitted here, so the controller reads that admission record back and continues from it instead of refusing. A record that disagrees is `record_mismatch`, under Markers. |

The log line is `admission_refused` with `issue`, `reasons`, the kinds joined by `+`, and `retry`, which is `true` when the refusal is not cached.

### Runs

A run is one admitted `factory:ready` label event. Its `runId` is the sha256 hex digest of `JSON.stringify(["github", <repo>, <issue>, <eventId>])`. A new label event on the same issue is a new run with a new `runId`.

| Status | Meaning | Holds a slot |
| --- | --- | --- |
| `claimed` | The claim is recorded and the stage has not launched. | yes |
| `running` | A model stage is running, validate is publishing/waiting for CI, or captured work is stopping. | candidate runs hold a slot while any captured account is unsettled; other model stages hold one |
| `blocked` | Sandbox preflight is unavailable, or candidate evidence/readiness has a hold reason. No unsandboxed fallback. | early sandbox holds keep a slot; candidate holds keep one only while an account is unsettled |
| `retrying` | A stage failed or stalled, and a retry is due at `retryAt`. | no |
| `released` | The issue closed, lost `factory:ready`, or got a newer ready event. Terminal. | no |
| `failed` | A stage failed, including a refused or stale CI verdict, or exhausted its attempts. Terminal. | no |
| `budget_exhausted` | The run used `usage.max_tokens_per_run` across all attempts, or a stage hit a turn, token, wall or run-token cap. Terminal. | no |
| `stage_passed` | Historical terminal result from an earlier release's last installed stage. F09a does not revive it. | no |
| `waiting` | Nonterminal merge checkpoint after exact-head CI, review, and handoff. No model tokens or model timer. | no |
| `landed` | Terminal controller-observed external merge, with actual merge SHA and separate assurance. | no |
| `cancelled` | Terminal closed-unmerged PR or positive authorization withdrawal after PR observation. | no |
| `needs_info` | Specify asked the owner questions. The questions comment is on the issue, `factory:needs-info` is on and `factory:ready` is off. No model runs until the owner adds `factory:ready` again, which starts a linked run. Terminal. | no |

A status is never removed, because markers that name it are already on issues. A controller older than this release reads a `needs_info` marker as corrupt, so deploy forward only.

Each model stage runs in the sandbox described in `docs/operations/sandbox.md`. Each stage scope is named `factory-stage-<owner>-<run>-<stage>-<attempt>-<nonce>`, where `<owner>` is the first 8 hex characters of the sha256 of the state directory's real path. On startup, before the first tick adopts a run, the controller stops every leftover `factory-stage-<owner>-*` user scope of its own by name and logs `sandbox_reconciled` with `stopped`, `failed` and `unowned` counts. Scopes of a controller with another state directory, such as a scoped verification controller, are left alone. An old-format scope, `factory-stage-<run>-<stage>-<attempt>-<nonce>` from a build before the owner segment, is stopped only when its description (the command `systemd-run` ran) binds a path under this state directory's `stages/` or `gw/`. Any other old-format scope, or one whose description cannot be read, is logged as `scope_unowned` with its `unit` and left running. Each tick reconciles its running stages first, then runs the sandbox preflight until it passes: a startup scope reconcile that succeeded (a failed one fails the check `reconcile` and is retried by each preflight, so the run stays `blocked` with `sandbox_unavailable` until it succeeds), a known CPU architecture, unprivileged user namespaces, bwrap at least 0.9.0, the asset bundle at `/var/lib/factory-sandbox/current` matching the digest in its name, a user scope that launches, and a gateway that comes up ready. A change in the result is logged as `sandbox_preflight` with `ok`, the `failed` checks joined by `+`, and the first 12 characters of the assets digest. Once the preflight passes, `executionEnabled` is `true` for the rest of the process.

While the preflight fails, a launch returns `sandbox_unavailable`. That result is not a failure and is not retried, and no model runs. The run stays `blocked` at `specify` and keeps its slot, so a third issue waits in `queued` while two are blocked. A `blocked` run launches again on the first tick whose preflight passes.

A launched model stage gets the stage's model, fallback model and budget from the loaded workflow, the attempt, and the run's remaining tokens, which are `usage.max_tokens_per_run` minus what the run has used. A run with no remaining tokens, for example a queued retry after the workflow lowered `usage.max_tokens_per_run`, is not launched: it ends `budget_exhausted` and logs `launch_refused` with `why=run_tokens`. This release installs `specify`, `accept`, `build`, controller-only `validate`, and `review`. Its result ends the stage:

| Result | Run |
| --- | --- |
| `specify` passed with a valid contract | Store the contract and post its summary, then claim `accept` on the same run, attempt 1. No terminal specify marker. |
| `accept` passed with a valid suite | Store the suite and post its redacted summary, then claim `build` with attempt 1. |
| `build` passed with a collected patch | Run visible tests in a fresh sandbox and post one redacted summary. A clean policy check and exit 0 advance to slot-free validate; forbidden work or failed tests end `failed`. |
| validate collected CI | Store the bound verdict, the trusted report and a digest-addressed assessment. A pass makes fresh review due. Only a `candidate` assessment can use the shared repair budget, and only before the first PR. `oracle` and `missing_evidence` end the run `failed` with `diagnosis_oracle` or `diagnosis_missing_evidence`. `infrastructure` holds as `diagnosis_infrastructure` with no CI redispatch. |
| review passed | Store exact execution/generation-bound seats and certification. Clean review prepares handoff, then waits for the owner. Blocking findings can use repair only before the first PR. Missing seats, exhaustion, or refusals never approve. |
| `passed` with valid questions | `needs_info`, terminal, after the questions comment and the label swap. |
| `passed` with missing or invalid output | a retry, or `failed` at the attempt cap, as for `failed`. Logged as `specify_malformed` or `acceptance_malformed` with `reason`. |
| `failed` (an error, malformed output, a crash or an abort) | a retry, or `failed` at the attempt cap, as below. |
| `refused` (a structured content-policy refusal, with no fallback model or a fallback that refused too) | `failed`, terminal, with no scheduler retry. |
| `budget_exhausted` (a turn, token, wall or run-token cap) | `budget_exhausted`, terminal. |

The stage's tokens are added to the run's `usage` whatever the result. A stage that stalls, or whose run is released or dropped while it runs, keeps the tokens it had reported by then. It is aborted, and tokens it reports while it cleans up are added once more, logged as `stage_late_usage`, without changing the outcome already chosen. Whenever a run's usage changes, its marker is posted again with the new `usage`, and the claim record follows it, so a restart starts from the corrected total. Its retry does not launch, and a terminal marker the stall chose is not posted, until the stage has ended or 15 seconds have passed since the abort: the 10 s cleanup reserve, within which the sandbox ends its cleanup, plus a 5 s grace. So both carry those tokens.

Every model-stage attempt writes a mode-0600 receipt beside its gateway's `egress.jsonl`. Specify, accept, and initial build use `<state-dir>/stages/<runId>/<stage>-<attempt>/receipt.json`. Review uses `review-r<round>-<attempt>`, and repair builds use `build-r<round>-<attempt>`. A replay appends `.2` to the execution directory, then `.3`, and so on. The receipt holds only numbers, enums, model IDs and digests: the outcome, the settlement event and whether it was aborted, the requested and observed models, any fallback record, a refusal code, `wallMs`, `turns`, usage for the parent, the children, by model and as metered by the gateway, the per-route egress summary, `assetsDigest`, the pinned Pi package versions, `pricing: "unavailable"`, and one `stderr` entry per Pi session. It never goes into a marker. It is written to a temp file, fsynced and renamed into place, so it is complete or absent, and an existing receipt is never replaced. When it cannot be written the stage ends `failed` as a crash and retries like any other failure. Each sandbox's stderr goes to `pi-stderr-<session>.log` beside the receipt, mode 0600, holding at most the last 64 KiB. The receipt's `stderr` entry gives only that file name and the total bytes the sandbox wrote. The text is untrusted, so the factory never logs it, prints it or copies it into a receipt or marker.

`tick` and `run` drain the model work they launch before exiting. Their snapshot can show a next-stage boundary or nonterminal `waiting`, not necessarily a terminal result. Later scoped ticks continue deterministic publication and observation. These commands mutate state and can launch models; they are not read-only status probes.

A stage that fails, or makes no progress for its stage's `stall_ms`, is aborted. If `attempt` is below `retry.max_attempts`, the next attempt is due after `min(10000 * 2^(attempt - 1), retry.max_backoff_ms)` milliseconds, where `attempt` is the one that failed. When it is due, the controller relaunches it only if the issue is still eligible and a slot is free. A due retry whose attempt is above the `retry.max_attempts` in force, because the workflow was reloaded with a lower value, ends as `failed` without launching, and needs no slot. Stages are reconciled before the issue is read again, as in step 1 of One tick, so a stage that fails or stalls on its last attempt while its issue is already closed ends `failed`, not `released`. These scheduler retries are separate from `MAX_REPAIR_ROUNDS` in `src/stages.ts`, which counts build rounds after a failed validation or review. Within one round, all repair-build attempts share 50,000 tokens, and all review attempts and seats share 30,000. Failed and interrupted attempts, replays and retained seats consume those allowances. The controller reconstructs spend from existing receipts and gateway tallies without charging prior attempts to the run twice. A new round gets a new stage allowance, not a new run allowance. At exhaustion, no new model request launches and `launch_refused` reports `why=round_tokens`.

A terminal run never restarts. While its claim record or the ledger shows it ended, its event is never admitted, recovered from the admission record or adopted again. To run the issue again, remove and re-add `factory:ready`, which makes a new event; its first marker is numbered after the ended run's.

### Specify

Before it launches `specify`, the controller reads the run's inputs. While the sandbox preflight fails it reads none, because the launch will be refused.

- **Checkout.** The executor fetches `gh api repos/<repo>/tarball/<baseSha>`, where `baseSha` is the run's admitted `workflowSha`: `main`'s HEAD when the run was admitted. It extracts the tarball into `<state-dir>/workspaces/<runId>/` and records the file list in `<state-dir>/checkouts/<runId>.json`. Extraction refuses the whole tarball for an absolute path, a `..`, `.` or `.git` component, a non-format control character, a second top directory, a duplicate path, an empty or controlled symlink target, a hardlink, a device or a FIFO, more than 50,000 entries, more than 64 MiB compressed, or more than 256 MiB unpacked. Regular files and directories whose paths contain Unicode format (`Cf`) characters are omitted, not extracted; `checkout_paths_omitted` logs their count with `why=unicode_format`. Other unsafe-path rules still apply to those entries. Spaces and most other Unicode in filenames are accepted. A path holding an invisible filler that is not a format character, such as U+034F, U+115F, U+2800 or U+3164, still refuses the whole tarball as an unsafe path. Citation paths use the narrower ASCII schema. No symlinks are written or listed, including absolute or upward targets outside the tree: specify reads regular files only, so even chains with `.` or `..` cannot escape the checkout. This is not a faithful diff base for later implementation stages. Files are written exclusively. A later attempt reuses the record. A workspace that holds files but no record, as after a crash mid-extraction, is emptied and extracted again. A failed fetch logs `stage_inputs_unavailable` with `why=checkout` and leaves the run `claimed` for a later tick. A refused tarball ends the run `failed` and logs `stage_inputs_refused` with `why=checkout_<reason>`. Compressed-output and decompression caps are `too_large`, not a failed fetch or `not_gzip`. Refusals are cached with the base SHA, so later reads do not refetch the same archive. The record also stores the omitted-path count. Accept refuses a checkout whose count is nonzero or unrecorded, logging `why=checkout_base_tree_unsupported`, because its suite would be qualified against a partial tree; specify still reads it.
- **Guidance.** `.github/factory/WORKFLOW.md` is read from the checkout, not from this tick's workflow, so a later change to `main` does not change a running ticket's guidance. Its sha256 must equal the run's `workflowDigest`. If it does not, the run ends `failed` with `why=workflow_mismatch`.
- **Snapshot.** The title and body come back from the admission record, with their digest checked against the receipt.
- **Answers.** A linked run's answers record must match its link's `answersDigest`.

The prompt holds:

- the guidance;
- the repository map, which is the file list with each directory below the top level that holds more than 12 files shown as one line;
- the README and the files the issue names, numbered;
- the issue and any answers, delimited as untrusted data with fresh random nonce tags per prompt; answers are a JSON array of author/body pairs, not author headers in text;
- the output schema.

Inlined files share a 16 KiB budget. Each is cut at 12 KiB, at a line boundary, with its line range in its header. The executor appends the `audit-ticket`, `grill-me` and `deep-research` skills from the bundle. The draft session gets only `read`, `grep` and `ls`. After a valid contract draft, the controller runs exactly one reviewer session with no tools. Its prompt carries only the draft, ticket snapshot and answers as untrusted data, and asks for JSON containing no finding or 1 to 3 concrete ambiguities that change acceptance tests. A finding starts at most one tool-less revision session, which returns a contract or questions. Questions skip review. All sessions stay inside one specify attempt; their tokens, turns and wall time share the stage and run budgets. A failed, refused, exhausted or malformed review or revision fails the attempt through the normal outcome mapping.

Only a `passed` stage's output is read: its final assistant text, from `output.txt` beside the receipt. It must be one JSON object, optionally in one fenced block, in one of two shapes:

- `{"kind": "contract", ...}` with a `summary`, 1 to 8 `behavior` lines, up to 8 `exclusions`, 1 to 10 `acceptance` criteria, up to 8 `compatibility` and 8 `limits` lines, up to 20 `files` and up to 12 `evidence` entries that cite checkout lines.
- `{"kind": "questions", "questions": [...]}` with 1 to 5 questions. A question may cite up to 3 checkout line ranges. A question that repeats an earlier one, ignoring case and spacing, is dropped.

Every string is one line of at most 300 characters with no control or Unicode format (`Cf`) character, line/paragraph separator, combining grapheme joiner, braille blank or Hangul filler (U+115F/U+3164). Every cited path must be in the checkout. An unknown key, a duplicate key, or a comment render over 8 KiB makes the output invalid.

A contract is stored as `<state-dir>/contracts/<runId>/contract.json`, mode 0600. It holds `version`, `runId`, `issue`, `base` (`repo` and `sha`), `snapshot` (`digest`, `source`, `eventId` and `eventAt`), `link` and the validated fields, with the criteria numbered `A1`, `A2` and so on. `receipt.json` beside it holds `contractDigest`, the sha256 of the contract's bytes, with the base SHA and the snapshot and answers digests. Both files are written once. Then the controller posts one summary comment with the behavior, the exclusions and the criteria, and logs `contract_stored`. The evidence, files and limits stay on the host.

Questions are stored as `<state-dir>/contracts/<runId>/questions.json`. Then the controller posts one questions comment, adds `factory:needs-info` and removes `factory:ready`. Only then does it post the terminal marker. A removal that answers 404 counts as done.

The controller renders both comments from validated fields only:

- URL userinfo/query credentials and bare credential shapes are redacted: GitHub `gh[pousr]_` plus at least 36 base62 characters or `github_pat_` plus at least 20 base62/underscore characters; `sk-` plus at least 20 base62 characters; OpenAI `sk-proj-`, `sk-svcacct-` and `sk-admin-`, and Anthropic `sk-ant-`/`sk-ant-api03-`, plus at least 20 base62/underscore/hyphen characters; other `sk-<word>-` prefixes with a payload containing at least 20 consecutive base62 characters; xAI `xai-` plus at least 20 base62 characters; AWS `AKIA` plus 16 uppercase letters/digits. Credentials after a hyphenated prefix, such as `token-ghp_…` or `key-AKIA…`, are also redacted. Ordinary hyphenated words such as `sk-learn-compatible-wrapper-module-name` are unchanged;
- Markdown and HTML metacharacters are escaped;
- `@` and `#` become full-width `＠` and `＃`, and `GH-<number>` uses a full-width hyphen. Slashes within GitHub issue/pull/discussion URL references become `／`, including scheme-less URLs and the `owner/repo/issues/N` shorthand GitHub recognizes. Other slashes, including file paths and `owner/repo＃N`, remain unchanged. No mentions or GitHub issue references are created;
- invisible formatting characters are stripped by the renderer as well as rejected by validation;
- cited lines become permalinks at the base SHA.

Each comment ends with a hidden key: `<!-- factory-questions run=<runId> q=<digest> -->` or `<!-- factory-contract run=<runId> c=<contractDigest> -->`. Before posting, the controller looks for a controller comment that ends with that key. So a post whose outcome was unknown, or one an interrupted controller made, is never posted twice. A comment that starts with `<!-- factory:` would be read as a marker, so neither comment does. Never edit either comment. Like an edited marker, an edited controller comment makes the issue `edited` and stops dispatch for it. A write that does not land logs `comment_unconfirmed` or `label_unconfirmed`, and is tried again on the next tick, before the terminal marker. Each label write also logs `label_write` with its outcome. Consecutive unconfirmed writes in the questions label swap are capped at `retry.max_attempts`; the count is stored in the claim record's `labelFailures`, keyed by run ID, and survives restarts and separate `tick --once` invocations. A confirmed critical write resets it; a new run on the same issue starts at zero. Reaching the cap ends `failed` without rerunning specify. Before deleting `factory:ready`, the controller verifies that its latest label event is still this run's event. A newer owner event is preserved; tied or missing timeline entries are also preserved and logged with `ready_label_preserved` and `why=tied|none`, allowing reporting to finish. A tied relabel is refused as ambiguous until the issue changes. A confirmed removal recovered after a crash logs `ready_label_already_removed`. Removing stale `factory:needs-info` from a linked claim is cosmetic: it retries once per tick while the run is active, including after adoption, logs every outcome, and never gates specify/reporting or counts toward the failure cap. Recovery does not remove/re-add the run's own needs-info label.

A restart that adopts a `running` specify marker first asks the executor for that attempt's kept output. When a passing execution kept valid output, the stage is finished from it and `stage_recovered` is logged. This holds even when `factory:ready` is already off because this controller removed it. A transient input read failure leaves recovery waiting, without a release marker or another model launch. Recovery checks the issue is still open before resuming effects; a closed issue is released without posting questions or labels. A partially completed specify execution returns `pending`: it resumes the same attempt, reuses every recorded session and launches only the remaining session. A session directory with no receipt fails the attempt instead of repeating a possibly launched reviewer. Usage is counted once.

The attempt directory contains `specify.json`, an aggregate `receipt.json` and the final `output.txt`. Each session has its own `draft/`, `review/` or `revision/` directory, with its receipt, output, agent files, stderr and `egress.jsonl`. The aggregate receipt sums usage, turns and wall time. Model observations, fallback details and egress evidence are in the session receipts. Before the aggregate receipt exists, recovery sums the session receipts or their audit tallies. Recorded outputs never cause another model request.

### Acceptance

Accept runs a fresh Pi session in a fresh sandbox after specify, before any implementation. Its read-only tools are `read`, `grep` and `ls`; its only skill is `acceptance`. The controller reads the immutable contract back from private storage, verifies its exact-byte digest against the receipt, and checks the run, repository, base SHA and snapshot binding. It supplies the general and `## accept` guidance from `WORKFLOW.md` at the base, after checking the workflow digest, then the contract's behavioral fields, a short trusted-base repository map and only the contract's named files (16 KiB total). The prompt asks for one reply when the inlined files suffice and at most two tool calls otherwise. It does not supply the issue, clarification answers, specify session, candidate diff or implementation transcript. The checkout is the trusted tarball at `contract.base.sha`, without Git objects. No oracle directory or other stage's session is mounted.

Output is JSON with `version: 2`, `scenarios` and `files`. Each scenario has an ID `S1`–`S999`, one or more criterion IDs, at most one check path and a nullable one-line judge instruction. Contract version 2 gives every criterion a `kind`, `new_behavior` or `preservation`; specify must state it, and the controller derives each scenario's kind from its criteria. A scenario that mixes kinds is malformed. A check file belongs to exactly one scenario. Every criterion is covered, every `new_behavior` criterion has a checked scenario, and the suite has at least one checked scenario. A scenario without checks requires a judge; every file must be referenced. Files have a relative `path`, type `node:test` and complete `content`. Only `.test.ts`, `.test.js` and `.test.mjs` files are allowed under controller-chosen `checks/`; hidden, absolute, traversal, duplicate, conflicting and backslash paths are rejected. Limits: 30 scenarios/files, 64 KiB per file, 256 KiB canary-free model output. Stored `suite.json` has a separate 262,897-byte cap (`ACCEPTANCE_STORED_MAX_BYTES`), including 30 derived scenario `kind` fields, the controller's canary field and the trailing newline; a model payload at exactly 256 KiB still round-trips after storage. All stored entry sizes are checked before creating the regeneration guard. Empty, duplicate-key, unknown-key, incorrectly typed, uncovered or malformed output fails the stage through normal retries, never passes. No model-produced code is executed during collection.

The suite lives at `<state-dir>/acceptance/<runId>/`, outside every stage mount. Directories are 0700, files 0600. `suite.json` contains the canonical validated output plus the canary, `manifest.json` maps scenarios to criteria and records each stored check's size and SHA-256, `checks/` holds each test's model bytes followed by one `// <canary>` line, and `canary.txt` holds the controller-generated canary `factory-holdout-<64 hex>`. Every stored file that holds test code therefore holds the canary. The receipt, anchor, raw model output and session transcripts do not: a canary-only search cannot detect all oracle copies. `acceptanceDigest` is SHA-256 of UTF-8 `JSON.stringify` of ordered `[relativePath, exactUTF8Content]` pairs: `suite.json`, `manifest.json`, the `checks/` files sorted by path, then `canary.txt`. Paths, scenario IDs, criterion IDs and check references are sorted in UTF-16 code-unit order, not by locale; file contents are not normalized. `receipt.json` records this digest, contract digest, base SHA, requested model/provider, observed model when available, the accept author's `family` evidence, and an `isolation` label equal to `familyLabel(family)`, for example `context-isolated, anthropic author, family checked at certification`. A receipt written before F10c has no `family` and keeps `context-isolated, same family, not cross-family`. The reader accepts only those two forms. See [Model families and R8](#model-families-and-r8-f10c).

A matching private receipt anchor at `<state-dir>/acceptance/<runId>.json` is fsynced before the suite is written. A partial write or lost suite directory therefore cannot authorize a new oracle. Recovery verifies all bytes and the complete manifest; matching suites are reused without another model request. Missing bytes (`ENOENT`) end `failed` with `stage_inputs_refused` reason `acceptance_missing`; content or digest mismatches are `acceptance_changed`. Non-regular files (including symlinks), loose file/directory modes, oversized entries and invalid receipt bindings are `acceptance_invalid`. Directory modes are rechecked on reads. Contract failures similarly distinguish `contract_missing`, `contract_changed`, `contract_invalid` and `contract_binding`. Restore the original private bytes to resolve these failures; a terminal run needs a fresh readiness event to run again, not silent regeneration.

The issue receives one keyed summary (`<!-- factory-acceptance run=<runId> a=<digest> -->`) through the shared F06a renderer and read-before-post deduplication. Only scenario IDs, criterion mappings, digest prefixes and the family disclosure are public: no file path, code, judge text or canary. The disclosure names the author the host recorded and its fresh context. For an Anthropic or unobserved author it leaves the family claim to certification, because no builder has run yet, and it never says `cross-family` or `same family`. An OpenAI author, or a receipt without `family`, keeps the same-family line. Acceptance uses its own workflow turns/wall/stall budget and attempt counter, a 25,000-token attempt ceiling (earlier executions subtracted on replay), and the remaining run-token budget. One-shot commands drain launched work through accept and claim build. A later tick starts build with its own attempt, workflow budget, remaining run tokens and 200,000-token attempt ceiling. Needs-info still stops at specify. The accept attempt's own `output.txt` and session files under `<state-dir>/stages/<runId>/accept-<n>/` also hold the model's suite text; they are private stage records and no later stage mounts them. The initial pre-build probe in `docs/prototypes/acceptance-isolation/` checks directory-aware reachability for all inventoried earlier attempts/replays/fallback sessions, exact-file private fingerprints of raw output and test bodies, private test-path tokens, canaries, mount/root prerequisites, tools/environment and network denials. Reports publish no private fingerprints or hit paths. A failed prerequisite or nonzero child exit cannot pass. Its documented self-test includes clean and leak controls; this is an observed boundary, not proof against arbitrary transformed copies or every kernel/process channel. Post-publication repair isolation remains F07c.

#### Base check

After the suite is stored, accept stays `running` while the controller runs the private checks against the unchanged base. No model runs and no stage is added. The tree is a fresh extraction of the run's pinned tarball under the attempt directory, never a stage workspace, which the accept sandbox can write; a test pins its digest to the CI exporter's for the current repository. A refused extraction, or one that omitted any symlink or Unicode-format path, is refused as `base_tree_unsupported` instead of being qualified. The reporter and freeze preload come from that tarball's own `.github/factory/gates/`, the main-owned copy CI runs at the base SHA, so the binding's gate SHA must equal its base SHA. The receipt records their digest as `source.gatesDigest`, and a tree without them is refused as `base_tree_unsupported`. Dependencies come from `<state-dir>/base-dependencies/<lockDigest>/`, filled once by the gate's prefetch and offline install and published by a `READY` marker, then bound read-only. The run uses bwrap with no network, no Git and no credentials, inside a `factory-stage-<owner>-<run16>-basecheck-<attempt>-<nonce>` user scope that the startup reconcile stops after a restart. The suite runs twice, each time in a fresh copy of the tree, and both executions are kept on the receipt as `execution` and `repeat`. Both runs share one cap: the lesser of 180 seconds and the accept wall still unspent, including setup.

The trusted reporter's private facts decide the result. A `new_behavior` file must fail at least one assertion, with its other tests passing or failing by assertion. A `preservation` file must pass entirely. Refusal reasons are `acceptance_not_reproduced`, `preservation_failed`, `base_load_error`, `base_no_tests`, `base_runner_error`, `base_timeout`, `base_non_assertion_failure`, `base_skip`, `base_todo`, `base_cancelled`, `base_tree_unsupported`, `base_interrupted`, `base_nondeterministic` and `base_evidence_missing`. `base_interrupted` means every accept attempt was interrupted. `base_nondeterministic` means the two runs disagreed on a file's registered count or on its per-test `(name, kind, code)` outcomes, so the suite cannot qualify. There is no oracle veto in this phase; classifying overconstrained oracles belongs to F10b-2. A final refusal ends the run `failed` before build and posts one keyed comment, `<!-- factory-base-refusal run=<runId> r=<receiptDigest> -->`, with a fixed reason and scenario IDs only. A qualified result posts the acceptance summary and claims build. Every build round, repair rounds included, starts only when the stored receipt yields a proof bound to the run, repository, contract, suite, base and gate. The controller rebuilds that binding from the stored contract and suite and reads the newest stored result for it, so the proof survives a restart without the candidate book. A missing or mismatched proof refuses the launch with `stage_inputs_refused` reason `base_evidence_missing`, posts the same keyed `base_evidence_missing` comment once and ends the run `failed`. A repair round that is refused this way finishes its candidate failed and starts no builder.

Receipts live at `<state-dir>/base-check/<runId>/<bindingDigest>/a<attempt>/`: `intent.json` before launch, then `result.json` and `result.digest`, or `interrupted.json` when a restart finds no result. Directories are 0700 and files 0600; the acceptance directory whitelist is unchanged. A restart reuses a stored result without rerunning. An interrupted attempt is charged once, to the accept attempt count and the accept wall, and the next attempt reruns the same stored suite after the usual backoff.

#### Feedback retry

A refusal the author can fix gets one private retry. These reasons allow it: `acceptance_not_reproduced`, `preservation_failed`, `base_load_error`, `base_no_tests`, `base_non_assertion_failure`, `base_skip`, `base_todo`, `base_cancelled` and `base_nondeterministic`. `base_runner_error`, `base_timeout`, `base_tree_unsupported`, `base_interrupted` and `base_evidence_missing` are final at once, as is any refusal of the retried suite.

The retry is the next accept attempt, with the same model and contract and a fresh session. It gets no new allowance. It needs an attempt left under `retry.max_attempts`, run tokens left, accept wall left after the refused suite's base check, and accept tokens left: once the retry is granted, every accept attempt shares the one 25,000-token ceiling, so the retry's ceiling is what earlier attempts left. Without any of them the refusal is final, and the log shows `accept_retry_unavailable` with `why=attempts|stage_tokens|run_tokens|wall`.

Before the relaunch the controller retires the refused suite. It exclusive-writes `<state-dir>/acceptance/<runId>.retired.json`, naming the retired digest, then moves the suite directory and its anchor to `<state-dir>/acceptance/<runId>.retired/suite/` and `guard.json`. They stay as private evidence, outside every stage mount, and are never overwritten. The same digest again finishes or repeats the move; any other digest is refused, so a run retires at most one suite. While the marker names a suite that has not moved yet, reads refuse it as `acceptance_changed`, so no stage or later accept is ever handed the retired suite. The claim's `baseCheck.retry` records the refused binding, its reason and its base wall time. A restart between the refusal and the relaunch finishes the retirement and relaunches once; a restart after the retried suite is stored checks that suite and never retries again. The retried suite's base check has its own receipt directory under its own binding digest, and the refused suite's receipt stays.

The retry prompt carries a nonce-tagged `<base-refusal-<nonce>>` block, marked as untrusted data and read from the refused suite's stored receipt. It holds the reason and its sentence, the refused scenario IDs, and for each failing file its path, failure kind, code and first message, cut to 500 characters per file and 4,096 bytes in all, with no test names. Build, review and public comments never see it. A retried refusal posts nothing; only the final refusal posts the keyed comment above. The refused attempt is recorded `refused` with its retry as the next attempt, and the log shows `accept_retry`.

#### Linked runs

A run links to the run before it when, at admission, the issue's latest terminal marker is another run's `needs_info`, and the new label event came after that marker. If a delayed label swap preserved the owner's newer label before the terminal marker landed, a label after that run's questions comment also links to it. The link is derived from the ledger. It is written to `<state-dir>/links/<runId>.json` as `{version, prevRunId, questionsDigest, answersDigest}` before the claim. An admission without a link writes `{version: 1, prevRunId: null}` there instead, including when an owner's preserved relabel predates the preceding run's questions comment. That explicit unlinked record ends later history walks normally. For older runs without a link file, an existing answers record identifies a missing linked-run record; otherwise the run starts the chain. New markers use v3; older v1/v2 markers remain readable as history. The earlier run's terminal marker never changes.

The answers are the issue body as it was at the new label, which the new snapshot holds, and the comments that meet all of these:

- created after the questions comment, by comment ID, and before the label's second;
- written by an account that is not a bot and not the controller, with `write`, `maintain` or `admin`;
- never edited, or last edited before the label.

Each linked run verifies the earlier link/answers chain and prepends the previous run's accumulated answers, preserving order and authors across clarification rounds. They are written to `<state-dir>/answers/<runId>.json`, mode 0600, with `rounds: [{questions, answers}]` and a `digest` covering the whole accumulated set and its question/answer pairings. Older records without `rounds` are read with their original digest and their rounds reconstructed from the chain. Draft, review and revision prompts carry each round's questions followed by that round's author/body answers, in order. There are at most 20 answers in total, each at most 4,000 characters. Earlier answers take priority at the cap. Permission reads for new answers are cached per author within that admission. A relabel with no qualifying comment still starts a linked run, for an owner who edited the body. Once the linked run is claimed, the controller removes `factory:needs-info`, logs `run_linked` with `prevRunId` and the answer count, and gives the new contract a `link`. A comment, or the `needs_info` marker, in the label's own second refuses the admission as `ambiguous_snapshot` with `answer_at_label_time`. A comment alone starts nothing: only a label event starts a run.

### Model families and R8 (F10c)

R8 asks that the acceptance author and at least one blocking review seat come from a different model family than the builder. The factory decides this from evidence the host recorded, never from a requested model ID, Pi's reported model or a label.

When the host writes a stage or seat receipt, it reads that attempt's request journal, `egress.requests.jsonl`, and stores a `family`.

| `family.kind` | When |
|---|---|
| `anthropic-gateway` | The answering session requested an `anthropic/` model, and every settled `model-anthropic` reply that the provider did not reject was metered with a `message_start.message.model` the gateway observed in the limits table. `model` is that bare ID. |
| `openai-request` | The answering session requested an `openai/` model, every line was on `model-openai`, and at least one result that the provider did not reject was metered. Provider-rejected results are skipped. A result whose `observedModel` is anything but the requested ID, bare or prefixed, makes the family `unknown-model`. `model` is the requested ID. |
| `unavailable` | Anything else. `reason` is `missing` (no journal, an empty journal, or no metered line that the provider did not reject), `unknown-model`, `mixed` (a line on another route) or `unmetered` (an Anthropic reply without usage, or a dispatch without a result). |

When a fallback answered, only its route counts, and the superseded primary's lines are ignored. The builder's family is the family on the latest passed build attempt of the round, and only `openai-request` for the patch's recorded model counts.

Review receipts are version 3. They store `builder`, `accept` (from the acceptance receipt) and each seat's `family`. Each seat `label` is written by `familyLabel` from those families.

| Label | When |
|---|---|
| `context-isolated, different family, cross-family` | The builder is `openai-request` and the seat is `anthropic-gateway`. This is the only pair that counts for R8. |
| `context-isolated, different family, builder not OpenAI, not cross-family` | Both are known and different, but the builder is not OpenAI. |
| `context-isolated, same family, not cross-family` | Both are known and the same. |
| `context-isolated, unknown family, not cross-family` | Either is unknown. |

`r8` is `complete` only when all three hold: the builder is `openai-request` with an `openai/` model, the accept author is `anthropic-gateway` with a table model, and at least one seat other than `simplify` is `anthropic-gateway` with a table model. Every other shape is `incomplete`, including an Anthropic builder, inverted families, and Anthropic evidence only on `simplify`. Certification recomputes `r8` and every label from the stored families and refuses the review with `certification_binding` on any mismatch. It also refuses any builder family other than `unavailable` that is not `openai-request` for the patch's recorded model. Version 2 receipts, written before F10c, certify only as `incomplete`, and only when every seat label equals one of the two historical labels exactly: `context-isolated, same model, same family, not cross-family` or `context-isolated, different model, same family, not cross-family`. They are never migrated. A stored `family` is trusted only because the host writes it from the journal into host-owned state outside every stage mount. `parseFamily` checks its shape, not its truth. On a restart the review runner reuses each finished seat's stored `family`, and certification still applies the strict rule above to it. The PR body states R8 from the recomputed value. Its Not proven section lists `R8 cross-family review remains incomplete.` unless that value is `complete`. Publication refuses a version 3 review whose `accept` evidence differs from the acceptance receipt's own.

A same-family fallback, such as an Anthropic accept that fell back to its `openai/` `fallback_model`, records an `openai-request` author, so the run certifies `r8: "incomplete"`. An OpenAI model that answered a seat that requested Anthropic is never labeled `cross-family`.

### Markers

Each change of a run's status, stage, attempt, usage or publication fields posts one new issue comment through `gh api --method POST repos/<repo>/issues/<n>/comments -f body=<marker>`. A marker is never edited. Its first line is `<!-- factory:run <json> -->`, and its second line says the status in words. The base marker fields are below. V2 adds candidate fields; v3 also adds `handoff`.

| Key | Value |
| --- | --- |
| `v` | `3` for new markers; `1` and `2` remain readable as history |
| `runId` | 64 hex characters |
| `repo`, `issue` | the repository and issue number |
| `eventId`, `eventAt` | the admitted label event |
| `snapshotDigest` | the admission's snapshot digest |
| `workflowSha`, `workflowDigest` | the admission's `baseSha` and `workflowDigest` |
| `stage`, `status`, `attempt` | the run's stage, status and 1-based attempt |
| `seq` | 1 more than the higher of the issue's highest trusted `seq` and the local record's `seq` |
| `branch` | owned validation branch or `null`; v1 requires `null` |
| `candidate`, `round`, `ciRun` | v2/v3; selected candidate SHA or `null`, selected repair round 0 to 2, CI run ID or `null` |
| `pr` | owned PR number or `null` |
| `handoff` | v3 only; `generation`, `intentDigest`, run-wide `refreshes`, per-round `reviewAttempts`, and `promoted` generation digest; `null` before candidate selection |
| `usage` | tokens used by the run, across attempts |
| `cursor` | the issue's `updated_at` the controller had seen, or `null` |

`<` and `>` in the JSON are written as `\u003c` and `\u003e`, and a whole marker comment is at most 4096 UTF-8 bytes. Selected marker round/generation identify published evidence provenance, not necessarily the active repair round. The top-level stage attempt is not the count of issued reviews; `handoff.reviewAttempts` retains that separate floor. It never holds a title, body, comment text, label name, `gh` output or private filesystem path.

A marker counts only when all of these hold. Anything else from another author is ignored.

- It came from `gh api repos/<repo>/issues/<n>/comments`.
- `user.login` is `exe-dev-github-integration[bot]` and `user.type` is `Bot`.
- `performed_via_github_app.slug` is `exe-dev-github-integration` when it is present.
- `issue_url` names the same repository and issue.
- GraphQL `lastEditedAt` for the comment is `null`. One request reads it for every comment by `exe-dev-github-integration[bot]`, marker or not: `gh api graphql -f query=<nodes query> -f ids[]=<node_id>...`, at most 100 IDs per request.
- The JSON parses with exactly its version's keys, `v` is `1`, `2`, or `3`, every value matches its pattern, and `runId` is the digest of its own `repo`, `issue`, and `eventId`.
- When the state directory has an admission record for the event, the marker's `eventAt`, `snapshotDigest`, `workflowSha` and `workflowDigest` match it. This holds for a terminal marker as for a live one: a terminal marker that disagrees is `record_mismatch`, and the controller does not rewrite its claim record from it.

The current marker is the trusted one with the highest `seq`. A bot comment that was edited, or whose GraphQL node does not name the same comment, issue and repository, whatever its text, a bot comment that starts with `<!-- factory:` and fails a rule, two markers with the same `seq`, two markers of one run that disagree on the admission fields, or a marker after its run's terminal one, make the issue corrupt. A corrupt issue is listed in `corrupt` with its `defect`, and nothing is dispatched for it until its `updated_at` changes and a fresh read is clean.

| `defect` | Cause |
| --- | --- |
| `too_large`, `malformed`, `unknown_version`, `unknown_key`, `missing_key`, `bad_value`, `run_id_mismatch` | The marker text fails the format. |
| `not_bot_type`, `wrong_app`, `wrong_issue` | The author type, app or issue does not match. |
| `edited`, `edit_unverified` | `lastEditedAt` is set, or the GraphQL read did not name the same comment, issue and repository. |
| `duplicate_seq`, `conflicting_run`, `after_terminal` | Two trusted markers disagree. |
| `record_mismatch` | The marker or a duplicate admission disagrees with the local admission record. |

A POST that answers HTTP 4xx did not create the comment. Any other failure, such as a timeout, a network error, an HTTP 5xx or an answer that is not JSON, may have created it. The controller then reads the issue's comments back on the next tick before it posts anything else for that issue. The run shows `markerPending: true` until then, and a due retry does not launch.

#### The local record and the ledger

For each issue the controller knows the last marker that landed, from its claim record and, while it runs, from its own POSTs. A run's state is whichever of that local record and the issue's trusted ledger has the higher `seq`:

- Ledger behind the local record. The comments read lags the controller's own POST, or bot comments were deleted. The local record carries the run. Nothing is deferred, dropped, or freed solely because that ledger read is behind. Slot ownership still follows the run/account rules above. The controller logs `ledger_behind` once with `issue`, `ledgerSeq` and `localSeq`, and lists the same in `ledgerBehind` until a later read reaches the local `seq` or the run posts its next marker.
- Ledger ahead of the local record. A claim record rewrite failed. The controller adopts the ledger's marker and rewrites the record.
- No local record: a crash before the first marker or a removed claim record. The controller adopts from the ledger, or from a local admission record whose marker never landed, as described under Restart. Markers carry no controller identity, so the admission record is the proof of ownership; older markers need nothing new. A fresh host or an empty state directory has no admission record for the run, so it treats the run as another controller's. While a live marker from another state directory is the newest, this controller neither admits nor releases the issue. The owning controller handles its own release. For a lost state directory, the supported recovery is restoring that state directory. Never delete bot comments.

A run that ends keeps its claim record, rewritten with the terminal status and `seq`. The controller never removes it, because a read that shows the terminal marker can be followed by a later read, in this process or the next, that does not. A record whose last read was clean but missed a terminal marker, after a rewrite failed or a crash before it, is rewritten from the ledger's terminal marker and kept too. Until a trusted ledger read shows that marker or a later one, the issue's markers are read once per tick: in the same tick when discovery reads the issue after the post, otherwise on the next tick. Once a read has shown it, the record costs no more reads in that process. After a restart every ended record is unconfirmed again, so the first tick reads the markers of each issue that has one. An ended record that cannot be written is tried again on every tick, confirmed or not. When the winning state for an issue's current ready event is terminal, that event is not admitted or adopted again, so a fresh process whose read omits the terminal marker posts nothing and takes no slot. A newer ready event on the issue starts normally, and its first marker is numbered after the ended record's `seq`.

So `<state-dir>/claims/` retains one record per finished run. F09a candidate records also retain the bounded book and captured accounts; they are not only a sequence cache. Pruning it is an operations task left for F09b, which records finished runs. Removing an ended record gives up its sequence protection. A later read that omits its terminal marker is then handled from the ledger alone; it cannot replace F09a's missing private candidate evidence.

Every marker is posted at 1 more than the higher of the two `seq` values, so a ledger that lags or lost comments never makes the controller reuse a `seq` it knows landed. A claim record rewrite never waits for a read: one that fails is tried again on every tick until it succeeds.

Deleted bot comments are tolerated and reported. Only a user with write access to the repository can delete one. The local record carries the run, and its next marker continues from the local `seq`. A deleted marker is not posted again. A release, a stage end or a retry after the deletion is posted as usual. An ended record whose terminal marker is deleted before a read shows it stays, and the issue's markers are read on every tick, until a later marker on the issue lands or an explicitly authorized operator intervention resolves the missing history. An ended record whose terminal marker is deleted after a read showed it stays as well, and its event is not run again, even when the issue reopens and every marker is gone.

Claim deletion is not a recovery procedure. It removes local sequence and accounting protection and cannot reconstruct a candidate book from GitHub. Preserve the original records and obtain explicit operator authority for any destructive intervention. Removing a record while the controller runs also leaves its in-memory state unchanged.

Known limit: both sources behind at once. A `seq` is posted twice, and the issue fails closed as `duplicate_seq` on a later read, in two cases. GitHub comments have no idempotency key, so exactly-once posting is not available.

- A POST with no answer, then a lagging read. A POST that times out after 30 s may still have landed. If the next read does not show it yet, the controller cannot tell it from a POST that never landed, so it posts the same `seq` again. The local record does not cover this, because an unanswered POST is not confirmed. While a read is behind the local record, the read-back waits and the run shows `markerPending: true`.
- A claim record rewrite that failed, then a restart whose first read lags. The new process loads the older `seq`, the read does not show the newer marker, and the run posts the newer `seq` again.

Known gaps after deleted bot comments. Each needs an owner to delete the bot comments.

- Deleted comments, then a lost POST. When the confirmed bot comments were deleted and a later marker POST does not answer, the read stays behind the local `seq`, so the read-back cannot tell whether that POST landed. The run shows `markerPending: true` and posts nothing until the comments return or the owner authorizes an intervention. Claim deletion is not an F09a recovery path.

### Restart

The controller keeps no database. F09a candidate recovery requires its validated private book, captured execution records, and admission pin. It observes an existing PR before eligibility decisions, restores account/attempt floors, and grants no work from a missing book. The following legacy/early-stage record rules do not authorize a candidate replay with zero usage or reconstructed certification.

- `<state-dir>/claims/<runId>.json`, mode 0600, holds `runId`, `issue`, `eventId`, `seq`, `status`, `stage`, `attempt` and `usage`, a copy of the run's last marker known to have landed. Before the first, `seq`, `status`, `stage`, `attempt` and `usage` are `null`. It is written before the first marker, written again after each marker that lands and when a run is adopted. When the run ends it keeps the terminal status and stays, as described under The local record and the ledger. Until a record whose run has not ended is adopted, released or dropped as corrupt, it holds a slot, unless its event has no admission record under this state directory or another controller's live marker is the issue's newest. A rewrite that fails logs `claim_unwritable` and is tried again on every later tick until it succeeds. On start, the controller reads the markers of every issue it names, even one that is no longer a candidate, so a claim on an issue closed while the controller was down is released. A record whose `seq` is ahead of the ledger carries the run, as described under The local record and the ledger. Its admission fields come from the local admission record; a run whose admission record cannot be read is not adopted that tick.
- A record written before records carried `usage` loads with `usage: null`, as unknown, and the run's usage comes from the newest trusted marker of the run the controller can read, or `0` when it can read none.
- A record written before records carried `status`, `stage` and `attempt` loads with them and `usage` `null`, as unknown. When the ledger has the record's `seq`, they come from the ledger. When the ledger is behind it too, they come from the newest trusted marker of the run the controller can read, and from `claimed` at the first stage when it can read none. The run then replays from that older status, stage and attempt, and its next marker is still numbered after the record's `seq`.
- A record with `seq: null` confirms nothing. That includes a record written before records carried a `seq`, which loads as `seq: null`. Adopting the run's current marker rewrites the record. If the issue has no marker of the run, is open and ready, and the run's event is still its latest `factory:ready` event, the controller treats the record as a crash before the first marker and claims the run again under the same `runId`. If the issue is closed or unlabeled, or a newer ready event replaced the run's, the run is released as described in step 5 of One tick. After a replacement, the newer event is admitted as a new run once a slot is free. So for a run whose markers had already landed when such a record was written, markers deleted while the controller is down go unnoticed: the run is claimed and launched again from its first marker.
- A live current marker whose event has an admission record under this state directory is adopted with its `runId`, `seq`, stage and attempt, even when its claim record is gone. One with no admission record is another controller's and is left alone, as in step 5 of One tick, even when a local claim record ahead of the ledger carries it. A `blocked` or `claimed` run launches its stage once more. When that ends in the same status, stage and attempt, nothing is posted. A `running` model-stage run was interrupted, and counts as a failed attempt once its event is confirmed current; one whose issue is closed or unlabeled, or whose event was replaced, is released instead, whatever its attempt. Either way the tokens that attempt is known to have spent are added to the run's usage first. An attempt's spend is the sum over its execution dirs, `<stage>-<attempt>` and each replay `<stage>-<attempt>.<n>`, each counted once: the dir's receipt `usage.total` when the receipt was written, else the sum of the metered tokens in its `egress.jsonl`, else nothing. For any adopted run past its first attempt, the attempt before the marker's is reconciled the same way, so late usage the marker missed is counted. Each attempt is measured from the run's usage before that attempt began, read from the ledger's last marker of that attempt, so tokens the marker already counts are not added twice. The adopted run reads those records again just before its next attempt launches, after the scope reconcile has stopped any leftover sandbox. A `retrying` run is due at the `created_at` of the first `retrying` marker of its attempt plus its backoff. Both use the loaded workflow's `retry` and `usage` limits, so neither is adopted before the process has loaded a workflow.
- An admission recorded locally whose marker never landed is claimed again under the same `runId`. Before any fresh admission, the controller lists the issue's records with `AdmissionStore.listEvents`. When one has no marker and its event is still the latest `factory:ready` event, it is read back with `AdmissionStore.read` and adopted with its original snapshot and workflow binding, and `admission_recovered` is logged. So an issue edited or renamed after its admission is not refused. The timeline is read for this only when such a record exists.
- `<state-dir>/checkouts/`, `contracts/`, `links/` and `answers/` hold the specify records described under Specify. They are controller-private: none is under a workspace or mounted into a sandbox.
- `<state-dir>/workspaces/<runId>/` is created empty with mode 0700 when the run is claimed. If it is missing on restart, the controller logs `workspace_missing`, creates it again, replays the stage and reports `workspace: "missing_replayed"`. When it cannot be created, the controller logs `workspace_unavailable` and keeps the replay for a later tick. It never marks a stage done without evidence.

### Claim snapshot

`tick` and `run` print this JSON, and every tick writes it to `<state-dir>/status.json`. It never contains issue text.

| Field | Type | Meaning |
| --- | --- | --- |
| `repo` | string | The `--repo` value. |
| `at` | string | The tick time, ISO 8601. |
| `executionEnabled` | boolean | `true` once the sandbox preflight has passed in this process, as described under Runs. |
| `dispatch` | object | `enabled`, and `reasons`: any of `state_unavailable`, `locally_disabled`, `repo_switch_off`, `repo_switch_unavailable`, `workflow_unavailable` and `candidates_unavailable`. |
| `workflowSha` | string or `null` | The `main` SHA of the last valid workflow. |
| `maxConcurrent` | number | The slot limit in force, `0` until the process has loaded a workflow. |
| `active` | number | Slot holders. Candidate runs hold one while any captured account is unsettled; other runs use non-validate claimed/running/blocked phases. Waiting holds none. It can exceed a newly lowered `maxConcurrent` while existing holders drain. |
| `runs` | array | One entry per claim: `issue`, `runId`, `eventId`, `stage`, `status`, `attempt`, `seq`, `markerPending`, `workspace` (`present` or `missing_replayed`), `retryAt` and `usage`. |
| `queued` | number array | Candidates that waited for a slot this tick, including a claimed run waiting for a slot before it is adopted or recovered. On a tick that skips dispatch, every claim record not yet adopted, released or dropped. |
| `absent` | number array | Issues named with `--issue` that are not open `factory:ready` issues and hold no claim. |
| `refused` | array | `issue` and the refusal `reasons` kinds from admission this tick. A refusal cached as described in Refusals and the watermark, such as `unauthorized`, is not read again until the issue's `updated_at` changes. Any other refusal is read again, and listed again, on the next tick. |
| `corrupt` | array | `issue` and `defect` for each issue with corrupt markers. |
| `ledgerBehind` | array | `issue`, `ledgerSeq` and `localSeq` for each issue whose last ledger read was behind its local claim record. A diagnostic: the local record carries the run, and dispatch is not blocked. |
| `totals` | object | Counts since the process started: `claims`, `launches`, `retries`, `stalls`, `releases`, `failures`, `markersPosted` and `usage`. |

### `status --json --state-dir`

With `--state-dir`, `controller` has `state`, `pid`, `since` and `lastTick`:

| `state` | Meaning |
| --- | --- |
| `running` | A process has the lock socket bound. `pid` and `since` come from `controller.lock`, and are `null` when it is missing or unreadable. |
| `stopped` | No process has the socket bound, and no `controller.lock` exists. |
| `stale_lock` | No process has the socket bound, and `controller.lock` names a controller that is gone. The next controller replaces the file. |
| `unreadable_lock` | No process has the socket bound and `controller.lock` cannot be parsed, or the state directory or the socket cannot be checked. |

`lastTick` is the content of `<state-dir>/status.json`, or `null`.

The separate top-level `attention` uses `src/attention.ts`, the same local reader as the extension. Without configured state it is `{kind: "unavailable", reason: "state_not_configured"}`. Unsafe or inaccessible private state gives `state_unavailable`. Available output has `at`, `groups`, `specReview: "not_enabled_in_v1"`, and `gaps`. The six group keys are `question_asked`, `question_answered`, `spec_review`, `pr_review`, `blocked`, and `failed`. Entries have `runId`, `issueUrl`, nullable `prUrl`, nullable `ageMs`, and nullable `reason`.

The reader selects the newest claim sequence per issue. A linked early specify run supplies `question_answered`; it does not crawl GitHub for answers. Ready waiting PRs appear once under `pr_review`. Working refreshes and not-ready PRs appear once under `blocked`, not also PR review. Missing books produce evidence gaps; malformed or wrong-owner books never become ready. Unknown legacy ages remain `null`. The root and claims directories must be owned private directories with no group/other access; claim files must be private regular files. Reads are bounded at 10,000 claim entries and 8 MiB per file. The reader launches no model, writes nothing, and cannot reconstruct authoritative remote state.

### Logs

The controller logs one line per event to stderr, as `at=<ISO time> event=<name> key=value ...`. A value outside letters, digits and `:._@/[]+-` is printed as `(withheld)`. Core early-stage events include `controller_ready`, `controller_running`, `controller_refused`, `controller_stopping`, `lock_stale_replaced`, `tick`, `claim_taken`, `claim_adopted`, `claim_released`, `claim_dropped`, `claim_foreign`, `claim_unwritable`, `admission_refused`, `admission_recovered`, `ledger_behind`, `stage_launched`, `launch_refused`, `stage_stalled`, `stage_ended`, `stage_late_usage`, `marker_posted`, `marker_unconfirmed`, `marker_corrupt`, `workspace_missing`, `workspace_unavailable`, `status_unwritable`, `sandbox_reconciled`, `scope_unowned` and `sandbox_preflight`.

### Stop

SIGTERM or SIGINT lets the current tick finish, then `serve` logs `controller_stopping`, removes `controller.lock`, closes the lock socket and exits 0.

### Install the service

Installation requires explicit service/VM authority, a drained rollout, and the [owner bootstrap gates](human-review.md#bootstrap-and-enable-protection-as-the-owner). These examples are not an execution grant.

`server/factory.service` runs `serve` under systemd. `server/provision.sh` does not install it. To install it on `pi-factorio`:

1. Clone the repository to `/home/exedev/pi-herdr-factorio` at the `main` commit to run, and run `npm ci --ignore-scripts` there.
2. Create the state directory: `install -d -m 0700 /home/exedev/factory-state`.
3. Copy the unit: `sudo install -m 0644 server/factory.service /etc/systemd/system/factory.service`, then `sudo systemctl daemon-reload`.
4. Start it: `sudo systemctl enable --now factory.service`.
5. Wait for readiness: `journalctl -u factory.service -f` until it shows `event=controller_ready`.

The unit sets `GH_HOST=github.int.exe.xyz` and `XDG_RUNTIME_DIR=/run/user/1000`, which the stage scopes need, and passes `--state-dir` explicitly. It holds no secret in its environment. Run `bash server/provision.sh` from the checkout first, so the sandbox bundle exists. Without it every run stays `blocked`. `systemctl stop factory.service` sends SIGTERM and waits up to 300 seconds for the tick to finish. The unit restarts on failure after 30 seconds, except after exit 2, when another controller holds the lock. To stop dispatch without stopping the service, create `/home/exedev/factory-state/disabled`.

## `/factory status`

The Pi extension command shows the same workflow state as text. It finds the repository from `git remote get-url origin` in the session's working directory and always loads `main`. It accepts exactly two origin forms:

- `https://github.com/<owner>/<repo>`, with an optional `.git`. The host must be exactly `github.com`, with no port, query or fragment. Credentials in the URL are allowed and ignored.
- `git@github.com:<owner>/<repo>`, with an optional `.git`.

The path is checked as written, before any URL normalization. `<owner>` and `<repo>` each contain only letters, digits, `.`, `_` and `-`, and neither may be `.` or `..`, also after removing `.git`. So a path with `%`, a backslash, an empty segment, a `.` or `..` segment, or more than two segments is not accepted.

Any other origin, including `ssh://` URLs, is not a GitHub repository. When `origin` is missing or is not accepted, or when `gh` fails, it prints `workflow    unavailable:` with the reason. For a remote that is not accepted, the reason is only `origin is not a GitHub repository`, and the URL is never printed. It always prints `controller  unavailable: the controller runs on the VM; read it there with status --json --state-dir` and `execution   disabled`, followed by the stage table. The stage table has one row per stage: where it runs, its model access and its GitHub access. Only `admit`, `validate` and `land` run in the controller, and only the controller uses the GitHub integration. Every model stage runs in the sandbox with GitHub access `none`.

The extension appends this same attention snapshot when `FACTORY_STATE_DIR` names the VM-local private state directory. Without it, attention is explicitly unavailable. The extension's existing controller-unavailable and execution-disabled text remains separate from attention. A workstation does not gain a remote attention service.

## `/factory run <issue>`

The extension runs on the owner's workstation, as the owner, with no state directory. So `/factory run <issue>` is a read-only admission dry run. It finds the repository as `/factory status` does, then runs the same `admitTicket` as `run --issue`, with a store that records nothing. It never posts a marker or claims the issue. It prints:

- `decision`: `would be admitted` or `refused`;
- `reasons`: each refusal kind, with its `failure`, `detail`, `permission` or `error` in parentheses;
- `event`, `snapshot` and `base`, as far as the evaluation reached.

It always ends by saying that only the controller on the VM dispatches, and that the VM's local switch is not visible from the workstation, so the dry run treats it as on. The repository switch, the workflow and every issue check are the real ones. Any other argument, a missing issue number, or more than one prints `Usage: /factory status | /factory run <issue>`.

## Configuration

The front matter of `.github/factory/WORKFLOW.md` is a YAML map. The loader uses YAML's failsafe schema, so every value is read as text and then converted. Integers accept an optional sign and digits only.

Anchors (`&name`) and aliases (`*name`) are not allowed anywhere in the front matter. The loader does not resolve them. Each one fails the load as `workflow_parse_error`, and the message lists every anchor and alias with its line and column. Write each value out in full instead.

| Field | Type | Default | Rule |
| --- | --- | --- | --- |
| `repository` | `owner/name` | none | Required. Must equal `--repo`. |
| `polling.interval_ms` | integer | `30000` | At least `10000`. |
| `agent.max_concurrent` | integer | `2` | From `1` to `4`. |
| `workspace.root` | path | `~/factory-workspaces` | `~` expands from `HOME`. A value of exactly `$VAR_NAME` reads that environment variable. The result must be an absolute path. Output shows the value as written, never the expanded path. The controller in this release keeps workspaces under `<state-dir>/workspaces/` instead. |
| `retry.max_attempts` | integer | `3` | Positive. |
| `retry.max_backoff_ms` | integer | `300000` | Positive. |
| `usage.max_tokens_per_run` | integer | `500000` | Positive. |
| `stages.<stage>.max_turns` | integer | `20` | Positive. |
| `stages.<stage>.wall_ms` | integer | `1800000` | Positive. For `specify`, `accept`, `build` and `review` it must be larger than 10000, the sandbox's cleanup reserve: the stage's hard deadline is `wall_ms` minus that reserve. |
| `stages.<stage>.stall_ms` | integer | `300000` | Positive. |
| `stages.<stage>.model` | `provider/model` | `openai/gpt-6.1-sol` | Only for `specify`, `accept`, `build` and `review`. Legacy `validate.model` is accepted with a warning and ignored. `specify`, `build` and `review` take only `openai/` models, because the sandbox serves them only on the `openai` route. `accept` also takes an `anthropic/` model listed in `server/sandbox/anthropic-limits.ts`, served on the `model-anthropic` route. Anthropic calls spend exe.dev credits. |
| `stages.<stage>.fallback_model` | `openai/model` or legacy `xai/model` | none | Optional for model stages. It must differ from the primary model. A structured content-policy refusal permits one fresh fallback session. In review this applies only to the security seat. `accept`'s fallback must be `openai/`, so an Anthropic accept falls back only to the same family as the builder, and that run certifies `r8: "incomplete"`. An Anthropic accept also switches to it when its route is unavailable. `workflow-check` prints `config.stages.<stage>.fallbackModel`, or `null` when unset. |
| `stages.review.seats.code-review.model` | `openai/model` or a listed `anthropic/model` | `stages.review.model` | The only per-seat key. The code-review seat runs this model with no fallback. The security, simplify and ultrareview seats keep `stages.review.model`, and the security seat alone keeps `fallback_model`. Any other seat, or any other key under the seat, is rejected. `workflow-check` prints `config.stages.review.codeReviewModel`, or `null` when the seat inherits. |
| `checkpoints.approve_merge.mode` | string | `always` | `always` is the only accepted mode. `never` is rejected because v1 stops every run at Human Review. Any other mode is unknown and rejected. |

`<stage>` is one of `admit`, `specify`, `accept`, `build`, `validate`, `review` and `land`.

These rules apply to every key:

- A value that starts with `$` is rejected in every field except `workspace.root`.
- An unknown top-level key is ignored and listed in `warnings`.
- The keys `hooks`, `hook`, `codex`, `command`, `commands`, `script`, `scripts`, `shell`, `bash`, `exec`, `run`, `before_run` and `after_create` are rejected at the top level and inside every known section. The match ignores case and surrounding spaces, so `Hooks` and `"hooks "` are rejected too. The factory runs no commands from `WORKFLOW.md`. These keys are not part of the schema, so `field` shows them as `(unknown key)`.
- An unknown key inside `polling`, `agent`, `workspace`, `retry`, `usage`, `stages`, a stage, `stages.review.seats` or `checkpoints` is rejected.

## Guidance

The Markdown after the front matter is stage guidance. It is trimmed, and its line endings come back as LF: each CRLF, and each lone CR, becomes LF. Apart from that, the text is returned byte for byte. The loader splits it with the `marked` lexer and never renders it, interpolates it or executes it.

A section starts at each top-level level-2 ATX heading, `## <stage>`, as `marked` tokenizes it. A heading inside a list item, a blockquote or a code block is not top level and does not split. A setext heading, a line of text underlined with `---`, does not split either. A section's text is the source of every token up to the next such heading, trimmed. Text before the first heading is general guidance. A heading that names no stage, or a stage named twice, fails validation with `field` set to `guidance`.

## Reload

A load that fails never replaces a valid snapshot. The last valid snapshot stays in force and the error is reported. `workflow-check --reload-ref` shows this. Every snapshot records its branch, SHA and digest and is frozen.
