# Read status and local attention

`status --json` reads trusted workflow settings through `gh`, then the optional local controller snapshot and attention claims. It never advances the controller, writes a marker, or calls a model. Use this recipe with an authorized lane or existing read-only VM state.

## Sub-features

- `status-settings` reports the trusted workflow pin, models, and limits. Invalid workflow output has null models/limits/checkpoints and a `workflowError`.
- `status-disabled` keeps top-level execution disabled while exposing the optional saved controller snapshot.
- `status-attention` reports six local groups or an explicit unavailable result.
- `status-usage` exits 2 for missing required options, unknown flags, bad branch names, or `--reload-ref`.

## How to get to it (user POV)

Use the command below with an existing private state directory on the VM. `--ref <branch>` is available for workflow verification, not remote attention reconstruction.

## Driving it with CLI

### Read the configured state

After doctor and lane setup, run on the VM from its lane checkout:

```bash
node host/cli/index.ts status --json --repo nublai/pi-herdr-factorio --state-dir "$STATE"
```

Record the tested head/tree, state origin, workflow SHA/digest, command, timestamps, output, and exit. `STATE` must name the captured private state, not another lane's directory. Expect exit 0 even if the workflow is invalid. Read `workflow` and `workflowError`, not exit status alone. `models` names specify, accept, build, and review. Top-level `executionEnabled` stays false because this command runs no preflight. The daemon's saved value is `controller.lastTick.executionEnabled`.

Omit `--state-dir` and require `controller.state: "unavailable"` plus `attention.kind: "unavailable"`, `reason: "state_not_configured"`. An unsafe/inaccessible attention root or claims directory gives `state_unavailable`, never an empty clean snapshot. The reader requires owned private directories and regular private claim files. Do not chmod or repair production state to make a test pass.

### Check the six attention groups

Use authorized fixtures or clearly labeled disposable saved state for:

- `question_asked` from `needs_info`;
- `question_answered` from a linked early specify run after a fresh readiness event;
- `spec_review`, empty with `specReview: "not_enabled_in_v1"`;
- `pr_review` for a ready merge wait;
- `blocked` for unavailable sandbox, exhaustion, working/not-ready PR, or missing candidate book;
- `failed` for failed runs without a higher-priority PR hold.

Require `runId`, `issueUrl`, nullable `prUrl`, nullable `ageMs`, and nullable `reason` in entries. The newest claim sequence per issue supersedes older questions and terminal entries. Unknown legacy/future timestamps stay `ageMs: null`. Not-ready/working PRs appear once under blocked, not also PR review. Missing books produce gaps; malformed/wrong-owner private evidence cannot become ready. Attention does not crawl GitHub or reconstruct missing accounts.

Compare stdout with [the registered extension](factory-status.md) on the same VM state. Record zero model requests and unchanged state bytes. Save the output as `attention.json` privately, with a redacted result for sharing.

## Gotchas

`test/src/views/attention.test.ts` exercises real standalone CLI processes and the registered handler with saved synthetic state and fake external transport. That is local parsing/projection proof, not native factory handoff or live VM proof. The [handoff recipe](handoff.md) supplies native prerequisites. This targeted recipe update did not run those lanes.

Status needs no process cleanup. Preserve evidence, close only fixtures created under the lane grant, and let the fixture/controller owner clean its state. No service, owner action, or repository setting change is implied.
