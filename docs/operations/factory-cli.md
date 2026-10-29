# Factory CLI reference

`server/cli.ts` is the factory's command-line entry point. It runs from a checkout of this repository on Node 26.12.1 or later. Node 26 strips TypeScript types by default, so no flag is needed.

```bash
node server/cli.ts <command> --json --repo <owner/name> [options]
```

Every command reads `.github/factory/WORKFLOW.md` from GitHub through `gh`, never from the local checkout. It first resolves the branch to a SHA with `gh api repos/<repo>/git/ref/heads/<branch> --jq .object.sha`, then fetches the file at that SHA with `gh api -H 'Accept: application/vnd.github.raw' repos/<repo>/contents/.github/factory/WORKFLOW.md?ref=<sha>`. Each `gh` call has a 30-second timeout. `gh` inherits the environment, including `GH_HOST`. On the VM, set `GH_HOST=github.int.exe.xyz`.

`admit` makes more `gh` reads, described in its section below. No command starts a controller, calls a model or writes to GitHub. Only `admit` writes local files, and only under `--state-dir`.

Errors and warnings carry only text the factory builds itself. They never quote `gh` output, an exec failure, a YAML error message, a key or value from `WORKFLOW.md` or a command-line argument. A second layer still redacts credentials in stdout, stderr and `/factory status` text. Anything shaped like `scheme://user:secret@` is printed as `scheme://<redacted>@`, and the value of a query parameter named `token`, `access_token`, `auth`, `key`, `password`, `secret`, `sig`, `signature` or `code`, in any case, is printed as `<redacted>`. In JSON output this applies to each string value before it is encoded, so it never spans two lines of one value.

## Commands

| Command | Purpose |
| --- | --- |
| `workflow-check` | Load and validate the workflow. Print the snapshot or the error. |
| `status` | Print the factory status: package, workflow, models, limits and execution state. |
| `admit` | Decide whether one issue's latest `factory:ready` label event is admitted. Print the receipt. |

## Flags

| Flag | Commands | Required | Default | Meaning |
| --- | --- | --- | --- | --- |
| `--json` | all | yes | none | Print JSON on stdout. JSON is the only output format. |
| `--repo <owner/name>` | all | yes | none | The GitHub repository. The workflow's `repository` field must equal it. |
| `--ref <branch>` | `workflow-check`, `status` | no | `main` | The branch to load. Any branch other than `main` sets `verification: true`. |
| `--reload-ref <branch>` | `workflow-check` | no | none | Load a second branch as a reload on top of `--ref` and report which snapshot stays in force. |
| `--issue <number>` | `admit` | yes | none | The issue number, from 1 to 9999999999, with no leading zero. |
| `--state-dir <dir>` | `admit` | yes | none | The controller state directory. It must already exist. A relative path is resolved against the working directory. |

`--ref` and `--reload-ref` exist so verification lanes can load fixture branches. The controller that arrives in F04c always loads `main` and has no such flag.

An `<owner>` or `<name>` contains only letters, digits, `.`, `_` and `-`, and is not `.` or `..`.

A branch name contains only letters, digits, `.`, `_`, `-` and `/`. It does not start with `-` or `/`, end with `/`, or contain `..` or `//`.

## Exit codes

| Code | `workflow-check` | `status` | `admit` |
| --- | --- | --- | --- |
| 0 | The workflow is valid. With `--reload-ref`, both loads are valid. | A report was printed, whatever the workflow state. | Admitted. The receipt was printed and recorded. |
| 1 | A load failed: the branch did not resolve, the file is missing or unreadable, or the file is invalid. The report is still printed. | Not used. | Refused. The receipt was printed. |
| 2 | Usage error. Usage goes to stderr, and stdout is empty. | Usage error. Usage goes to stderr, and stdout is empty. | Usage error. Usage goes to stderr, stdout is empty, and `gh` is not run. |

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

The only warning is `(unknown key) ignored`. The controller `reason` is always `no controller is installed in this release`.

A usage error prints one of these lines to stderr, followed by the usage text: `unrecognized or incomplete options`, `expected workflow-check, status or admit`, `unexpected extra arguments`, `--json is required`, `--repo <owner/name> is required`, `--reload-ref applies only to workflow-check`, `--ref and --reload-ref must be branch names`, `admit always reads main and takes no --ref`, `--issue <number> is required`, `--state-dir <dir> is required` or `--issue and --state-dir apply only to admit`.

`/factory status` prints `Usage: /factory status` when the first word of its argument is not `status`. When it cannot find a repository, the reason is `cannot run git`, `no git remote named origin` or `origin is not a GitHub repository`.

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
| `executionEnabled` | boolean | Always `false`. This release has no controller. |
| `controller` | object | `state` is always `unavailable`. `reason` says why. |
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
- `<state-dir>/disabled` does not exist. This is the local kill switch. Create the file to stop admission. Its content is ignored.
- The repository has a label named exactly `factory:enabled`. This is the repository kill switch, described below.
- `.github/factory/WORKFLOW.md` on `main` is valid. `baseSha` is the `main` SHA it was loaded from.
- The issue is open, is not a pull request, and has the `factory:ready` label.
- The latest `factory:ready` entry on the issue timeline is a `labeled` event, not `unlabeled`. This is the admitted event.
- That event's actor has `admin` or `write` permission on the repository. The issue author does not matter.
- The title and body at the time of the event are proved, as described under snapshot.
- No admission was recorded before for the same event ID.

It checks the allowlist and the local switch first and stops there, before any `gh` call. When the repository switch is off or unavailable, it still reads the issue, so the receipt shows the event, actor and snapshot it would have bound. It then refuses without recording anything.

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
| Timeline | `gh api repos/<repo>/issues/<n>/timeline?per_page=100&page=<p>`, from page 1 until a page has fewer than 100 entries, at most 10 pages |
| Permission | `gh api repos/<repo>/collaborators/<login>/permission`, with `[` and `]` in a bot login URL-encoded |
| Snapshot | `gh api graphql -f query=<query> -F owner=<owner> -F name=<name> -F number=<n>` |

So an admission makes 7 requests, plus one per extra timeline page. A refusal can stop earlier. `admit` never passes `--paginate`: `gh` would follow GitHub's `Link` headers to `api.github.com` and leave the integration. See `docs/prototypes/github-polling/README.md`.

### Snapshot

The snapshot is the title and body when the label was applied. Let `L` be the event's `created_at`.

1. The title comes from the GraphQL read, which also returns the issue's title renames, at most 100. The snapshot is ambiguous when a `renamed` timeline event or a rename in that read is at or after `L`, when that read reports more renames than it returned, or when its title differs from the title the issue read returned. So a rename between the reads is refused.
2. When the body's `lastEditedAt` is `null` or earlier than `L`, the current title and body are the snapshot, and `snapshotSource` is `unedited`, unless the edit history contradicts it. It does when a version was saved at or after `L`, when a version is newer than `lastEditedAt`, or when `lastEditedAt` is `null` and the history has any version other than the original.
3. Otherwise the body comes from the GraphQL edit history. It is proved when all of these hold: every version was returned, the history includes the original, the newest version equals the current body and was saved at `lastEditedAt`, no version was saved in the same second as `L`, and exactly one version is the latest saved before `L` and it is not deleted. That version is the snapshot body. `snapshotSource` is `edit_history`.
4. Anything else is `ambiguous_snapshot`.

`snapshotDigest` is the sha256 hex digest of `JSON.stringify([title, body])` in UTF-8. The current body at poll time is never used as the snapshot unless rule 2 applies.

### State

An admission writes `<state-dir>/admissions/github/<owner>/<name>/<issue>/<event-id>.json` with mode 0600, in directories created with mode 0700. It holds the receipt and the snapshot title and body. The file is created exclusively, so a second admission of the same event finds it and is refused as `duplicate_event`. A refusal writes nothing.

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
| `actorPermission` | string or `null` | `admin`, `write`, `read` or `none`, as GitHub reports it for the actor. |
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
| `state_unavailable` | `--state-dir` does not exist, is not a directory, or the disable file cannot be checked. | |
| `locally_disabled` | `<state-dir>/disabled` exists. | |
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
| `unauthorized` | The actor has `read` or `none`. | `permission` |
| `snapshot_unavailable` | The GraphQL edit-history read failed. | `failure` |
| `ambiguous_snapshot` | The label-time title and body cannot be proved. | `detail` |
| `duplicate_event` | This event was already admitted into this state directory. | |
| `state_unwritable` | The admission record could not be written. | |

The repository switch reason comes first. When the issue also fails a check, that reason follows it, so `reasons` has at most two entries.

`failure` has `kind`:

| `failure.kind` | Meaning | Extra fields |
| --- | --- | --- |
| `gh_failed` | `gh` exited non-zero. | `cause` and `status`, as in the `workflow-check` error kinds |
| `cannot_run_gh` | `gh` could not be started. | |
| `malformed_response` | `gh` printed something that is not the expected JSON, such as a proxy error page, a field of the wrong type, or a permission answer for another user. | |
| `pagination_limit` | The timeline has more than 10 full pages. | |

`detail` is one of these:

| `detail` | Meaning |
| --- | --- |
| `renamed_since_label` | The title changed at or after the label, by the timeline or by the GraphQL read. |
| `rename_history_incomplete` | The GraphQL read returned fewer renames than its `totalCount`. At most 100 are read. |
| `title_changed_between_reads` | The GraphQL title differs from the title the issue read returned. |
| `edited_at_label_time` | A body version was saved in the same second as the label. |
| `history_contradicts_last_edit` | `lastEditedAt` is `null` or earlier than the label, but a body version was saved after the label or after `lastEditedAt`, or `lastEditedAt` is `null` and the history has a version other than the original. |
| `history_incomplete` | GitHub returned fewer versions than its `totalCount`. At most 100 are read. |
| `history_without_original` | The history does not include the original body. |
| `history_disagrees_with_body` | The newest version is not the current body, or was not saved at `lastEditedAt`. |
| `no_version_before_label` | No version was saved before the label. |
| `version_withheld` | The version in force at label time is deleted or has no text, or two versions share its time. |

## `/factory status`

The Pi extension command shows the same workflow state as text. It finds the repository from `git remote get-url origin` in the session's working directory and always loads `main`. It accepts exactly two origin forms:

- `https://github.com/<owner>/<repo>`, with an optional `.git`. The host must be exactly `github.com`, with no port, query or fragment. Credentials in the URL are allowed and ignored.
- `git@github.com:<owner>/<repo>`, with an optional `.git`.

The path is checked as written, before any URL normalization. `<owner>` and `<repo>` each contain only letters, digits, `.`, `_` and `-`, and neither may be `.` or `..`, also after removing `.git`. So a path with `%`, a backslash, an empty segment, a `.` or `..` segment, or more than two segments is not accepted.

Any other origin, including `ssh://` URLs, is not a GitHub repository. When `origin` is missing or is not accepted, or when `gh` fails, it prints `workflow    unavailable:` with the reason. For a remote that is not accepted, the reason is only `origin is not a GitHub repository`, and the URL is never printed. It always prints `controller  unavailable` and `execution   disabled`, followed by the stage table.

## Configuration

The front matter of `.github/factory/WORKFLOW.md` is a YAML map. The loader uses YAML's failsafe schema, so every value is read as text and then converted. Integers accept an optional sign and digits only.

Anchors (`&name`) and aliases (`*name`) are not allowed anywhere in the front matter. The loader does not resolve them. Each one fails the load as `workflow_parse_error`, and the message lists every anchor and alias with its line and column. Write each value out in full instead.

| Field | Type | Default | Rule |
| --- | --- | --- | --- |
| `repository` | `owner/name` | none | Required. Must equal `--repo`. |
| `polling.interval_ms` | integer | `30000` | At least `10000`. |
| `agent.max_concurrent` | integer | `2` | From `1` to `4`. |
| `workspace.root` | path | `~/factory-workspaces` | `~` expands from `HOME`. A value of exactly `$VAR_NAME` reads that environment variable. The result must be an absolute path. Output shows the value as written, never the expanded path. |
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
