# Factory CLI reference

`server/cli.ts` is the factory's command-line entry point. It runs from a checkout of this repository on Node 26.12.1 or later. Node 26 strips TypeScript types by default, so no flag is needed.

```bash
node server/cli.ts <command> --json --repo <owner/name> [options]
```

Every command reads `.github/factory/WORKFLOW.md` from GitHub through `gh`, never from the local checkout. It first resolves the branch to a SHA with `gh api repos/<repo>/git/ref/heads/<branch> --jq .object.sha`, then fetches the file at that SHA with `gh api -H 'Accept: application/vnd.github.raw' repos/<repo>/contents/.github/factory/WORKFLOW.md?ref=<sha>`. Each `gh` call has a 30-second timeout. `gh` inherits the environment, including `GH_HOST`. On the VM, set `GH_HOST=github.int.exe.xyz`.

No command starts a controller, calls a model or writes to GitHub.

Output never contains URL credentials. Anything shaped like `scheme://user:secret@` in stdout, stderr or `/factory status` text, including `gh` errors and text quoted from `WORKFLOW.md`, is printed as `scheme://<redacted>@`.

## Commands

| Command | Purpose |
| --- | --- |
| `workflow-check` | Load and validate the workflow. Print the snapshot or the error. |
| `status` | Print the factory status: package, workflow, models, limits and execution state. |

## Flags

| Flag | Commands | Required | Default | Meaning |
| --- | --- | --- | --- | --- |
| `--json` | both | yes | none | Print JSON on stdout. JSON is the only output format. |
| `--repo <owner/name>` | both | yes | none | The GitHub repository. The workflow's `repository` field must equal it. |
| `--ref <branch>` | both | no | `main` | The branch to load. Any branch other than `main` sets `verification: true`. |
| `--reload-ref <branch>` | `workflow-check` | no | none | Load a second branch as a reload on top of `--ref` and report which snapshot stays in force. |

`--ref` and `--reload-ref` exist so verification lanes can load fixture branches. The controller that arrives in F04c always loads `main` and has no such flag.

A branch name contains only letters, digits, `.`, `_`, `-` and `/`. It does not start with `-` or `/`, end with `/`, or contain `..` or `//`.

## Exit codes

| Code | `workflow-check` | `status` |
| --- | --- | --- |
| 0 | The workflow is valid. With `--reload-ref`, both loads are valid. | A report was printed, whatever the workflow state. |
| 1 | A load failed: the branch did not resolve, the file is missing or unreadable, or the file is invalid. The report is still printed. | Not used. |
| 2 | Usage error. Usage goes to stderr, and stdout is empty. | Usage error. Usage goes to stderr, and stdout is empty. |

## Error kinds

| `kind` | Cause |
| --- | --- |
| `source_unavailable` | The branch did not resolve to a SHA: it does not exist, the name is invalid, or `gh` failed. `sha` is `null`. |
| `missing_workflow_file` | The branch resolved, but fetching `WORKFLOW.md` at that SHA failed. The message says `not found` for HTTP 404 and gives `gh`'s first stderr line otherwise. |
| `workflow_parse_error` | The front matter has no closing `---`, its YAML has an error or a warning, such as a duplicate key or an unresolved tag, or it uses an anchor or alias. Line numbers count from the first line of `WORKFLOW.md`. |
| `workflow_front_matter_missing` | The file does not start with a `---` line. Front matter is required. |
| `workflow_front_matter_not_a_map` | The front matter is empty or is not a YAML map. |
| `workflow_validation_error` | A field failed validation. `field` holds its dotted YAML path, such as `stages.build.max_turns`, `guidance` or `hooks`. |

Each error has `kind` and `message`. Only `workflow_validation_error` has `field`. Validation stops at the first failing field.

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
| `warnings` | string array | One entry per ignored unknown top-level key. |
| `config` | object or `null` | The validated configuration, described under configuration. |
| `guidance` | object or `null` | `general`, the text before the first stage heading, and `stages`, a map from stage name to its section text. |
| `reload` | object or `null` | Present only with `--reload-ref`. |

The `reload` object has these fields:

| Field | Type | Meaning |
| --- | --- | --- |
| `repo`, `ref`, `sha`, `digest`, `valid`, `error` | as above | The result of loading `--reload-ref`. |
| `verification` | boolean | `true` when the ref of the snapshot in force is not `main`. When no snapshot is in force, it uses the `--reload-ref` value. |
| `outcome` | string | `applied` when the reload is valid, `kept` when it is invalid and the `--ref` snapshot stays, and `unavailable` when neither load is valid. |
| `inForce` | object or `null` | `ref`, `sha` and `digest` of the snapshot in force after the reload. |

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

`models`, `limits` and `checkpoints` are `null` when the workflow is invalid.

## `/factory status`

The Pi extension command shows the same workflow state as text. It finds the repository from `git remote get-url origin` in the session's working directory and always loads `main`. An `https` origin with credentials in it still resolves to its repository. When `origin` is missing or is not a `github.com` remote, or when `gh` fails, it prints `workflow    unavailable:` with the reason. For a remote that is not on GitHub, the reason is only `origin is not a GitHub repository`, and the URL is never printed. It always prints `controller  unavailable` and `execution   disabled`, followed by the stage table.

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
- The top-level keys `hooks`, `codex`, `command`, `commands`, `script`, `scripts`, `shell` and `exec` are rejected. The factory runs no commands from `WORKFLOW.md`.
- An unknown key inside `polling`, `agent`, `workspace`, `retry`, `usage`, `stages`, a stage or `checkpoints` is rejected.

## Guidance

The Markdown after the front matter is stage guidance. It is trimmed. A `## <stage>` heading outside a fenced code block starts that stage's section, and text before the first heading is general guidance. A heading that names no stage, or a stage named twice, fails validation with `field` set to `guidance`. The loader never renders, interpolates or executes guidance.

Fenced code blocks follow CommonMark. A fence opens with three or more backticks or tildes, indented by up to three spaces. A backtick fence's info string cannot contain a backtick. The fence closes only on a line of the same character, at least as long as the opening, indented by up to three spaces, with nothing after it but spaces or tabs. A fence that never closes runs to the end of the file.

## Reload

A load that fails never replaces a valid snapshot. The last valid snapshot stays in force and the error is reported. `workflow-check --reload-ref` shows this. Every snapshot records its branch, SHA and digest and is frozen.
