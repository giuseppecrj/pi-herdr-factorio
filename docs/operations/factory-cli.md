# Factory CLI reference

`server/cli.ts` is the factory's command-line entry point. It runs from a checkout of this repository on Node 26.12.1 or later. Node 26 strips TypeScript types by default, so no flag is needed.

```bash
node server/cli.ts <command> --json --repo <owner/name> [options]
node server/cli.ts serve --repo <owner/name> --state-dir <dir> [--issue <number>]...
```

Every command reads `.github/factory/WORKFLOW.md` from GitHub through `gh`, never from the local checkout. It first resolves the branch to a SHA with `gh api repos/<repo>/git/ref/heads/<branch> --jq .object.sha`, then fetches the file at that SHA with `gh api -H 'Accept: application/vnd.github.raw' repos/<repo>/contents/.github/factory/WORKFLOW.md?ref=<sha>`. Each `gh` call has a 30-second timeout. `gh` inherits the environment, including `GH_HOST`. On the VM, set `GH_HOST=github.int.exe.xyz`.

`admit` makes more `gh` reads, described in its section below. `tick`, `run` and `serve` are the controller, described under "Controller". They are the only commands that write to GitHub, and the only thing they write is run marker comments. No command calls a model. Only `admit` and the controller write local files, and only under `--state-dir`.

Errors and warnings carry only text the factory builds itself. They never quote `gh` output, an exec failure, a YAML error message, a key or value from `WORKFLOW.md` or a command-line argument. A second layer still redacts credentials in stdout, stderr and `/factory status` text. Anything shaped like `scheme://user:secret@` is printed as `scheme://<redacted>@`, and the value of a query parameter named `token`, `access_token`, `auth`, `key`, `password`, `secret`, `sig`, `signature` or `code`, in any case, is printed as `<redacted>`. In JSON output this applies to each string value before it is encoded, so it never spans two lines of one value.

## Commands

| Command | Purpose |
| --- | --- |
| `workflow-check` | Load and validate the workflow. Print the snapshot or the error. |
| `status` | Print the factory status: package, workflow, models, limits and execution state. |
| `admit` | Decide whether one issue's latest `factory:ready` label event is admitted. Print the receipt. |
| `tick` | Run one controller tick and print the claim snapshot. Requires `--once`. |
| `run` | Run one controller tick for one issue, through the same admission as polling, and print the claim snapshot. |
| `serve` | Run the controller: a tick, then one every `polling.interval_ms`, until SIGTERM or SIGINT. |

## Flags

| Flag | Commands | Required | Default | Meaning |
| --- | --- | --- | --- | --- |
| `--json` | all except `serve` | yes | none | Print JSON on stdout. JSON is the only output format. `serve` takes no `--json` and prints nothing on stdout. |
| `--once` | `tick` | yes | none | Run exactly one tick. |
| `--repo <owner/name>` | all | yes | none | The GitHub repository. The workflow's `repository` field must equal it. |
| `--ref <branch>` | `workflow-check`, `status` | no | `main` | The branch to load. Any branch other than `main` sets `verification: true`. |
| `--reload-ref <branch>` | `workflow-check` | no | none | Load a second branch as a reload on top of `--ref` and report which snapshot stays in force. |
| `--issue <number>` | `admit`, `run`, `tick`, `serve` | `admit` and `run`: exactly one. `tick` and `serve`: no | every candidate | The issue number, from 1 to 9999999999, with no leading zero. `tick` and `serve` take it any number of times and then touch only those issues. |
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
| `provider anthropic is not allowed: on the VM it spends exe.dev credits until the owner's proxy exists` | A model ID uses provider `anthropic`. |
| `<stage> runs no model, so it takes no model key` | `stages.admit.model` or `stages.land.model`. |
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
| `executionEnabled` | boolean | Always `false`. No stage runner is installed in this release. |
| `controller` | object | Without `--state-dir`, `state` is `unavailable` and `reason` is `pass --state-dir to read the controller lock`. With it, see below. |
| `models` | object or `null` | The model for each of `specify`, `accept`, `build`, `validate` and `review`. |
| `limits` | object or `null` | `pollIntervalMs`, `maxConcurrent`, `retry`, `usage` and `stages`, where `stages` maps each stage to `maxTurns`, `wallMs` and `stallMs`. |
| `checkpoints` | object or `null` | `approveMerge.mode`, which is always `always`. |

When `workflow` is `valid`, `workflowSha` and `workflowDigest` are set, `workflowError` is `null`, and `models`, `limits` and `checkpoints` are set. When it is `invalid`, `workflowError` is set and `models`, `limits` and `checkpoints` are `null`.

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

To turn the factory off for the repository, delete the `factory:enabled` label on the repository's labels page, `https://github.com/<repo>/labels`. Deleting it also removes it from any issue that carries it. To turn it back on, create a label named exactly `factory:enabled`, for example with `gh label create factory:enabled --repo <repo>`. Changing the label needs triage access or higher.

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

### The lock

The lock is a Linux abstract Unix socket named `\0pi-herdr-factorio/<sha256 of the state directory's real path>`, bound with `net.createServer().listen({ path, exclusive: true })`. The kernel lets only one process bind a name, so of two controllers started together exactly one runs and the other gets `EADDRINUSE` and exits 2 with `controller_running`. The kernel frees the name when the holder exits for any reason, including `kill -9`, so there is never a stale lock to break. The name comes from the real path, so a state directory reached through a symlinked parent names the same lock, and two state directories never collide. A `--state-dir` that is itself a symlink never reaches the lock: step 1 refuses it with `state_unavailable`. `docs/prototypes/restart-recovery/README.md` records the probe on the VM.

`<state-dir>/controller.lock`, mode 0600, only names the holder for `status`. The controller writes it after binding the socket, with its pid, its start time from field 22 of `/proc/self/stat`, and when it took the lock. It removes the file on exit, only while the file still names it. A file left by a controller that is gone is replaced and logged as `lock_stale_replaced` with the old pid. The file is never the authority: deleting it does not free the lock. `status --json` connects to the socket to see whether a controller holds it, and never binds it.

### One tick

A tick runs these steps. Reconciliation always runs, before the per-tick reads, and dispatch runs only when every per-tick read succeeds.

1. Reconcile stages. Every stalled stage is aborted, and every finished or stalled stage becomes a retry or a terminal status in memory, using the last valid workflow's limits. Only then are their markers posted, so a slow marker request never delays an abort. Posting may first read back a marker whose POST did not answer.
2. Candidates: open issues with `factory:ready`, from `gh api repos/<repo>/issues?state=open&labels=factory%3Aready&sort=created&direction=asc&per_page=100&page=<p>`, paged as the timeline is. A failed read adds `candidates_unavailable` and skips dispatch. The list lags a label change by about 6 s: on #147 on 2026-10-29, an added `factory:ready` first showed in it after 5.9 to 6.4 s in 3 trials, while a direct issue read showed the label every time. So a newly added or re-added label is claimed on the first tick after the list shows it. A held issue missing from the list is read directly in step 3 before it is released, so the lag never releases a run wrongly.
3. Reconcile every claim. A claim record rewrite that failed is tried again first. A claim whose issue is closed, lost `factory:ready`, or has a newer `factory:ready` event is released, and `claim_released` names why: `closed`, `unlabeled` or `new_event`. When a claimed issue's `updated_at` changed since the last check, or the last check was too close to it, as described below, its timeline and its markers are read again, both before a release for a newer ready event is posted; a corrupt ledger drops the run from dispatch, logs `claim_dropped` and lists the issue in `corrupt`. A ledger behind the local claim record, described under Markers, changes nothing for the run. A marker whose POST did not answer is read back. A claim is confirmed only when these reads succeed.
4. Per-tick reads, once each: the local switch, the repository switch, and `WORKFLOW.md` on `main` (2 requests). If any fails or is off, dispatch is skipped for this tick and `dispatch.reasons` names why. The last valid workflow's limits stay in force. Until the process has loaded a workflow once, there are no limits: there are no slots, `maxConcurrent` is `0`, and no run of any status is adopted. So no interrupted `running` run is counted as a failed attempt and no retry's due time is computed. The only markers posted are `released` markers for claims whose issue is closed, unlabeled or has a newer ready event. Each claim waits in `queued` with its claim record holding its slot, and releases and reconciliation still run. On any tick that skips dispatch, every claim record not yet adopted, released or dropped is listed in `queued`.
5. Discover. For each candidate the controller has not seen at its current `updated_at`, and for each claim recorded locally before a restart, it reads the issue's markers. A live marker is adopted as the existing run, never admitted again. When that run is released because the issue has a newer ready event, the issue is admitted in the same tick. A corrupt ledger stops dispatch for that issue. When the local claim record is ahead of the ledger, the run is adopted from the record. A `claimed` or `blocked` run of a candidate, or of a recorded claim whose issue read shows it open and ready while the candidates list omits it, is adopted only while fewer than `agent.max_concurrent` claims are `claimed`, `running` or `blocked`; otherwise it waits, holding its slot as in step 6, is listed in `queued`, and is read again on each tick until a slot is free. A `running` or `retrying` run is adopted once a workflow has loaded, whatever the count, because neither holds a slot once adopted: an interrupted `running` run becomes a retry or ends, and a retry takes a slot only when it launches. A recorded claim whose issue read shows it closed or unlabeled is released on that read, without taking a slot and without a second issue read. That includes a claim with no marker, left by a lost first POST or a crash before it: its `released` marker is numbered after the issue's highest `seq`, so it is `seq: 1` when no marker landed, takes its fields from the local admission record, and leaves an ended record, so reopening the issue never runs that event again. When the admission record cannot be read, the claim keeps its slot, nothing is posted, and the issue is read again on the next tick. An issue whose recorded claim was not adopted, held or released is never cached as decided. Then every issue with an ended claim record that this tick neither posted nor read has its markers read, as described under The local record and the ledger.
6. Dispatch, while slots remain. Slots are `agent.max_concurrent` minus the claims that are `claimed`, `running` or `blocked`, minus each issue with an active claim record that is not yet adopted, released or dropped as corrupt. So a claim record whose recovery read fails keeps its slot until a later read adopts it, and a claim record with no marker, left by a lost first POST or a crash before it, keeps its slot when the read finds no marker. Only a claim confirmed in step 3 or 5 launches; one whose read failed waits for a later tick. Each candidate with such a record, and each such record whose issue read shows it open and ready while the candidates list omits it, lowest issue number first, is recovered first, through its local admission record, with the slot it already holds, while fewer than `agent.max_concurrent` claims are `claimed`, `running` or `blocked`; otherwise it is listed in `queued`. A recovery that cannot read its records keeps the slot for a later tick. Then a due retry launches, and only once its retry marker is confirmed. Then each new candidate, lowest issue number first, goes through `admitTicket` with the per-tick reads, so it costs only the 4 issue reads. A claim takes its slot as soon as it is recorded, even while its first marker is unconfirmed, and launches once the marker is confirmed. A candidate without a slot is listed in `queued` and is not admitted.

A switch that is off stops new claims and new launches. It does not end or release runs that already exist.

An issue whose `updated_at` has not changed since the controller last decided it is not read again: no comments, timeline or permission request. `updated_at` has whole seconds, so a change later in the second the controller read the issue would keep the same value. A decision is therefore trusted only when the tick that made it started at least 1 s after its `updated_at` second ended, by the controller's clock. An issue decided sooner is read once more on the next tick. The rule assumes the VM clock is within 1 s of GitHub's, as NTP keeps it. The held run's `eventId` and the decision itself are kept apart from this watermark. Once every decision has settled and every ended claim record is confirmed, an unchanged tick makes 4 requests: the repository switch, the two workflow reads and the candidate list. The cache lives in memory, so the first tick after a restart reads each scoped candidate once.

### Runs

A run is one admitted `factory:ready` label event. Its `runId` is the sha256 hex digest of `JSON.stringify(["github", <repo>, <issue>, <eventId>])`. A new label event on the same issue is a new run with a new `runId`.

| Status | Meaning | Holds a slot |
| --- | --- | --- |
| `claimed` | The claim is recorded and the stage has not launched. | yes |
| `running` | A stage runner is working on the stage. | yes |
| `blocked` | The stage cannot run: no stage runner is installed in this release. | yes |
| `retrying` | A stage failed or stalled, and a retry is due at `retryAt`. | no |
| `released` | The issue closed, lost `factory:ready`, or got a newer ready event. Terminal. | no |
| `failed` | The attempt cap was reached. Terminal. | no |
| `budget_exhausted` | The run used `usage.max_tokens_per_run` across all attempts. Terminal. | no |

Until F05 installs the stage runner, every launch returns `stage_runner_not_installed`. That result is not a failure and is not retried, and no model runs. The run stays `blocked` at `specify` and keeps its slot, so a third issue waits in `queued` while two are blocked. `executionEnabled` stays `false`.

A stage that fails, or makes no progress for its stage's `stall_ms`, is aborted. If `attempt` is below `retry.max_attempts`, the next attempt is due after `min(10000 * 2^(attempt - 1), retry.max_backoff_ms)` milliseconds, where `attempt` is the one that failed. When it is due, the controller relaunches it only if the issue is still eligible and a slot is free. These scheduler retries are separate from `MAX_REPAIR_ROUNDS` in `src/stages.ts`, which counts build rounds after a failed validation or review.

A terminal run never restarts. While its claim record or the ledger shows it ended, its event is never admitted, recovered from the admission record or adopted again. To run the issue again, remove and re-add `factory:ready`, which makes a new event; its first marker is numbered after the ended run's.

### Markers

Each change of a run's status, stage or attempt posts one new issue comment through `gh api --method POST repos/<repo>/issues/<n>/comments -f body=<marker>`. A marker is never edited. Its first line is `<!-- factory:run <json> -->`, and its second line says the status in words. The JSON has exactly these keys:

| Key | Value |
| --- | --- |
| `v` | `1` |
| `runId` | 64 hex characters |
| `repo`, `issue` | the repository and issue number |
| `eventId`, `eventAt` | the admitted label event |
| `snapshotDigest` | the admission's snapshot digest |
| `workflowSha`, `workflowDigest` | the admission's `baseSha` and `workflowDigest` |
| `stage`, `status`, `attempt` | the run's stage, status and 1-based attempt |
| `seq` | 1 more than the higher of the issue's highest trusted `seq` and the local record's `seq` |
| `branch`, `pr` | always `null` in this release |
| `usage` | tokens used by the run, across attempts |
| `cursor` | the issue's `updated_at` the controller had seen, or `null` |

`<` and `>` in the JSON are written as `\u003c` and `\u003e`, and a whole marker comment is at most 4096 bytes. It never holds a title, body, comment text, label name, `gh` output or path.

A marker counts only when all of these hold. Anything else from another author is ignored.

- It came from `gh api repos/<repo>/issues/<n>/comments`.
- `user.login` is `exe-dev-github-integration[bot]` and `user.type` is `Bot`.
- `performed_via_github_app.slug` is `exe-dev-github-integration` when it is present.
- `issue_url` names the same repository and issue.
- GraphQL `lastEditedAt` for the comment is `null`. One request reads it for every comment by `exe-dev-github-integration[bot]`, marker or not: `gh api graphql -f query=<nodes query> -f ids[]=<node_id>...`, at most 100 IDs per request.
- The JSON parses with exactly the keys above, `v` is `1`, every value matches its pattern, and `runId` is the digest of its own `repo`, `issue` and `eventId`.
- When the state directory has an admission record for the event, the marker's `eventAt`, `snapshotDigest`, `workflowSha` and `workflowDigest` match it.

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

- Ledger behind the local record. The comments read lags the controller's own POST, or bot comments were deleted. The local record carries the run. Nothing is deferred, dropped or freed, the run keeps its slot, and the issue is not corrupt and does not block dispatch. The controller logs `ledger_behind` once with `issue`, `ledgerSeq` and `localSeq`, and lists the same in `ledgerBehind` until a later read reaches the local `seq` or the run posts its next marker.
- Ledger ahead of the local record. A claim record rewrite failed. The controller adopts the ledger's marker and rewrites the record.
- No local record: a crash before the first marker, a fresh host, or a removed record. The controller adopts from the ledger, or from a local admission record whose marker never landed, as described under Restart.

A run that ends keeps its claim record, rewritten with the terminal status and `seq`. The controller never removes it, because a read that shows the terminal marker can be followed by a later read, in this process or the next, that does not. A record whose last read was clean but missed a terminal marker, after a rewrite failed or a crash before it, is rewritten from the ledger's terminal marker and kept too. Until a trusted ledger read shows that marker or a later one, the issue's markers are read once per tick: in the same tick when discovery reads the issue after the post, otherwise on the next tick. Once a read has shown it, the record costs no more reads in that process. After a restart every ended record is unconfirmed again, so the first tick reads the markers of each issue that has one. An ended record that cannot be written is tried again on every tick, confirmed or not. When the winning state for an issue's current ready event is terminal, that event is not admitted or adopted again, so a fresh process whose read omits the terminal marker posts nothing and takes no slot. A newer ready event on the issue starts normally, and its first marker is numbered after the ended record's `seq`.

So `<state-dir>/claims/` gains one small file per finished run. Pruning it is an operations task left for F09b, which records finished runs. Until then, removing an ended record by hand, as described below for discarding a run, gives up its protection: a later read that omits its terminal marker is then handled from the ledger alone.

Every marker is posted at 1 more than the higher of the two `seq` values, so a ledger that lags or lost comments never makes the controller reuse a `seq` it knows landed. A claim record rewrite never waits for a read: one that fails is tried again on every tick until it succeeds.

Deleted bot comments are tolerated and reported. Only a user with write access to the repository can delete one. The local record carries the run, and its next marker continues from the local `seq`. A deleted marker is not posted again. A release, a stage end or a retry after the deletion is posted as usual. An ended record whose terminal marker is deleted before a read shows it stays, and the issue's markers are read on every tick, until a later marker on the issue lands or the record is discarded as below. An ended record whose terminal marker is deleted after a read showed it stays as well, and its event is not run again, even when the issue reopens and every marker is gone.

To discard a run deliberately, stop the controller, remove its claim record `<state-dir>/claims/<runId>.json`, the one whose `issue` is the issue's number, and start the controller again. For the service that is `sudo systemctl stop factory.service`, then the record in `/home/exedev/factory-state/claims/`, then `sudo systemctl start factory.service`. The next controller has no local record for the issue and goes by the ledger. Removing the record while the controller runs changes nothing, because the running controller keeps it in memory.

Known limit: both sources behind at once. A `seq` is posted twice, and the issue fails closed as `duplicate_seq` on a later read, in two cases. GitHub comments have no idempotency key, so exactly-once posting is not available.

- A POST with no answer, then a lagging read. A POST that times out after 30 s may still have landed. If the next read does not show it yet, the controller cannot tell it from a POST that never landed, so it posts the same `seq` again. The local record does not cover this, because an unanswered POST is not confirmed. While a read is behind the local record, the read-back waits and the run shows `markerPending: true`.
- A claim record rewrite that failed, then a restart whose first read lags. The new process loads the older `seq`, the read does not show the newer marker, and the run posts the newer `seq` again.

Known gaps after deleted bot comments. Each needs an owner to delete the bot comments.

- Deleted comments, then a lost POST. When the confirmed bot comments were deleted and a later marker POST does not answer, the read stays behind the local `seq`, so the read-back cannot tell whether that POST landed. The run shows `markerPending: true` and posts nothing until the comments return or the owner discards the run as above.

### Restart

The controller keeps no database. A restart rebuilds each claim from the markers, from local claim records and from the workspace.

- `<state-dir>/claims/<runId>.json`, mode 0600, holds `runId`, `issue`, `eventId`, `seq`, `status`, `stage`, `attempt` and `usage`, a copy of the run's last marker known to have landed. Before the first, `seq`, `status`, `stage`, `attempt` and `usage` are `null`. It is written before the first marker, written again after each marker that lands and when a run is adopted. When the run ends it keeps the terminal status and stays, as described under The local record and the ledger. Until a record whose run has not ended is adopted, released or dropped as corrupt, it holds a slot. A rewrite that fails logs `claim_unwritable` and is tried again on every later tick until it succeeds. On start, the controller reads the markers of every issue it names, even one that is no longer a candidate, so a claim on an issue closed while the controller was down is released. A record whose `seq` is ahead of the ledger carries the run, as described under The local record and the ledger. Its admission fields come from the local admission record; a run whose admission record cannot be read is not adopted that tick.
- A record written before records carried `usage` loads with `usage: null`, as unknown, and the run's usage comes from the newest trusted marker of the run the controller can read, or `0` when it can read none.
- A record written before records carried `status`, `stage` and `attempt` loads with them and `usage` `null`, as unknown. When the ledger has the record's `seq`, they come from the ledger. When the ledger is behind it too, they come from the newest trusted marker of the run the controller can read, and from `claimed` at the first stage when it can read none. The run then replays from that older status, stage and attempt, and its next marker is still numbered after the record's `seq`.
- A record with `seq: null` confirms nothing. That includes a record written before records carried a `seq`, which loads as `seq: null`. Adopting the run's current marker rewrites the record. If the issue has no marker of the run and is open and ready, the controller treats the record as a crash before the first marker and claims the run again under the same `runId`. If the issue is closed or unlabeled, the run is released as described in step 5 of One tick. So for a run whose markers had already landed when such a record was written, markers deleted while the controller is down go unnoticed: the run is claimed and launched again from its first marker.
- A live current marker is adopted with its `runId`, `seq`, stage and attempt. A `blocked` or `claimed` run launches its stage once more. When that ends in the same status, stage and attempt, nothing is posted. A `running` run was interrupted, and counts as a failed attempt. A `retrying` run is due at the marker's `created_at` plus its backoff. Both use the loaded workflow's `retry` and `usage` limits, so neither is adopted before the process has loaded a workflow.
- An admission recorded locally whose marker never landed is claimed again under the same `runId`. Before any fresh admission, the controller lists the issue's records with `AdmissionStore.listEvents`. When one has no marker and its event is still the latest `factory:ready` event, it is read back with `AdmissionStore.read` and adopted with its original snapshot and workflow binding, and `admission_recovered` is logged. So an issue edited or renamed after its admission is not refused. The timeline is read for this only when such a record exists.
- `<state-dir>/workspaces/<runId>/` is created empty with mode 0700 when the run is claimed. If it is missing on restart, the controller logs `workspace_missing`, creates it again, replays the stage and reports `workspace: "missing_replayed"`. When it cannot be created, the controller logs `workspace_unavailable` and keeps the replay for a later tick. It never marks a stage done without evidence.

### Claim snapshot

`tick` and `run` print this JSON, and every tick writes it to `<state-dir>/status.json`. It never contains issue text.

| Field | Type | Meaning |
| --- | --- | --- |
| `repo` | string | The `--repo` value. |
| `at` | string | The tick time, ISO 8601. |
| `executionEnabled` | boolean | Always `false` in this release. |
| `dispatch` | object | `enabled`, and `reasons`: any of `state_unavailable`, `locally_disabled`, `repo_switch_off`, `repo_switch_unavailable`, `workflow_unavailable` and `candidates_unavailable`. |
| `workflowSha` | string or `null` | The `main` SHA of the last valid workflow. |
| `maxConcurrent` | number | The slot limit in force, `0` until the process has loaded a workflow. |
| `runs` | array | One entry per claim: `issue`, `runId`, `eventId`, `stage`, `status`, `attempt`, `seq`, `markerPending`, `workspace` (`present` or `missing_replayed`), `retryAt` and `usage`. |
| `queued` | number array | Candidates that waited for a slot this tick, including a claimed run waiting for a slot before it is adopted or recovered. On a tick that skips dispatch, every claim record not yet adopted, released or dropped. |
| `absent` | number array | Issues named with `--issue` that are not open `factory:ready` issues and hold no claim. |
| `refused` | array | `issue` and the refusal `reasons` kinds from admission this tick. A refusal that stays true until the issue changes, such as `unauthorized`, is not re-read until the issue's `updated_at` changes. |
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

### Logs

The controller logs one line per event to stderr, as `at=<ISO time> event=<name> key=value ...`. A value outside letters, digits and `:._@/[]+-` is printed as `(withheld)`. The events are `controller_ready`, `controller_running`, `controller_refused`, `controller_stopping`, `lock_stale_replaced`, `tick`, `claim_taken`, `claim_adopted`, `claim_released`, `claim_dropped`, `claim_unwritable`, `admission_recovered`, `ledger_behind`, `stage_launched`, `stage_stalled`, `stage_ended`, `marker_posted`, `marker_unconfirmed`, `marker_corrupt`, `workspace_missing`, `workspace_unavailable` and `status_unwritable`.

### Stop

SIGTERM or SIGINT lets the current tick finish, then `serve` logs `controller_stopping`, removes `controller.lock`, closes the lock socket and exits 0.

### Install the service

`server/factory.service` runs `serve` under systemd. `server/provision.sh` does not install it. To install it on `pi-factorio`:

1. Clone the repository to `/home/exedev/pi-herdr-factorio` at the `main` commit to run, and run `npm ci --ignore-scripts` there.
2. Create the state directory: `install -d -m 0700 /home/exedev/factory-state`.
3. Copy the unit: `sudo install -m 0644 server/factory.service /etc/systemd/system/factory.service`, then `sudo systemctl daemon-reload`.
4. Start it: `sudo systemctl enable --now factory.service`.
5. Wait for readiness: `journalctl -u factory.service -f` until it shows `event=controller_ready`.

The unit sets `GH_HOST=github.int.exe.xyz` and passes `--state-dir` explicitly. `systemctl stop factory.service` sends SIGTERM and waits up to 300 seconds for the tick to finish. The unit restarts on failure after 30 seconds, except after exit 2, when another controller holds the lock. To stop dispatch without stopping the service, create `/home/exedev/factory-state/disabled`.

## `/factory status`

The Pi extension command shows the same workflow state as text. It finds the repository from `git remote get-url origin` in the session's working directory and always loads `main`. It accepts exactly two origin forms:

- `https://github.com/<owner>/<repo>`, with an optional `.git`. The host must be exactly `github.com`, with no port, query or fragment. Credentials in the URL are allowed and ignored.
- `git@github.com:<owner>/<repo>`, with an optional `.git`.

The path is checked as written, before any URL normalization. `<owner>` and `<repo>` each contain only letters, digits, `.`, `_` and `-`, and neither may be `.` or `..`, also after removing `.git`. So a path with `%`, a backslash, an empty segment, a `.` or `..` segment, or more than two segments is not accepted.

Any other origin, including `ssh://` URLs, is not a GitHub repository. When `origin` is missing or is not accepted, or when `gh` fails, it prints `workflow    unavailable:` with the reason. For a remote that is not accepted, the reason is only `origin is not a GitHub repository`, and the URL is never printed. It always prints `controller  unavailable: the controller runs on the VM; read it there with status --json --state-dir` and `execution   disabled`, followed by the stage table.

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
| `stages.<stage>.wall_ms` | integer | `1800000` | Positive. |
| `stages.<stage>.stall_ms` | integer | `300000` | Positive. |
| `stages.<stage>.model` | `provider/model` | `openai/gpt-6.1-sol` | Only for `specify`, `accept`, `build`, `validate` and `review`. Provider `anthropic` is rejected: on the VM it spends exe.dev credits until the owner's proxy exists. |
| `checkpoints.approve_merge.mode` | string | `always` | `always` is the only accepted mode. `never` is rejected because v1 stops every run at Human Review. Any other mode is unknown and rejected. |

`<stage>` is one of `admit`, `specify`, `accept`, `build`, `validate`, `review` and `land`.

These rules apply to every key:

- A value that starts with `$` is rejected in every field except `workspace.root`.
- An unknown top-level key is ignored and listed in `warnings`.
- The keys `hooks`, `hook`, `codex`, `command`, `commands`, `script`, `scripts`, `shell`, `bash`, `exec`, `run`, `before_run` and `after_create` are rejected at the top level and inside every known section. The match ignores case and surrounding spaces, so `Hooks` and `"hooks "` are rejected too. The factory runs no commands from `WORKFLOW.md`. These keys are not part of the schema, so `field` shows them as `(unknown key)`.
- An unknown key inside `polling`, `agent`, `workspace`, `retry`, `usage`, `stages`, a stage or `checkpoints` is rejected.

## Guidance

The Markdown after the front matter is stage guidance. It is trimmed, and its line endings come back as LF: each CRLF, and each lone CR, becomes LF. Apart from that, the text is returned byte for byte. The loader splits it with the `marked` lexer and never renders it, interpolates it or executes it.

A section starts at each top-level level-2 ATX heading, `## <stage>`, as `marked` tokenizes it. A heading inside a list item, a blockquote or a code block is not top level and does not split. A setext heading, a line of text underlined with `---`, does not split either. A section's text is the source of every token up to the next such heading, trimmed. Text before the first heading is general guidance. A heading that names no stage, or a stage named twice, fails validation with `field` set to `guidance`.

## Reload

A load that fails never replaces a valid snapshot. The last valid snapshot stays in force and the error is reported. `workflow-check --reload-ref` shows this. Every snapshot records its branch, SHA and digest and is frozen.
