# Factory statecharts

Two checked charts of how a ticket moves through the factory. Each one comes from a TLA+ model that TLC checked, and the chart is drawn from the states TLC reached.

- `journey/` is the full v1 flow, from the label to the merge. It follows `advance()` in `src/stages.ts`, and adds the PR feedback loop that the design and plan step F10 describe. Most of this flow is not built yet.
- `controller/` is what `src/orchestrator.ts` and the sandbox executor do with one run today: claim, launch, retry, release, and recovery after a restart.

## A ticket's journey (v1 design)

Teal is built, yellow is partly built, and purple is still only in the plan. The red state breaks a rule, and the red border marks the path to it.

```mermaid
stateDiagram-v2
  state "Legend" as legend {
    lg0: built
    lg1: partly
    lg2: planned
    lg3: end
    lg4: Breaks MergeEndsRun
    lg5: Breaks MergeEndsRun in some cases
    lg6: Path to the MergeEndsRun bug
  }
  class lg0 teal
  class lg1 yellow
  class lg2 purple
  class lg3 tan
  class lg4 breaks
  class lg5 mayBreak
  class lg6 bugPath
  s0: Checking the labeler
  s1: Rejected
  state "Run in progress" as s2 {
    s3: Writing the contract
    s4: Writing hidden acceptance tests
    s5: Building the patch
    s6: CI runs main's gates and the hidden tests
    s7: Reviewing the patch
    s8: PR waits for your review
    s9: Still working on a PR you already merged
  }
  s10: Stopped
  s11: Failed
  s12: Waiting for your answer
  s13: Merged, issue closed
  [*] --> s0
  s0 --> s1: the labeler lacks write access
  s0 --> s3: admitted, issue text frozen
  s3 --> s4: contract written
  s3 --> s12: ticket too vague, questions posted
  s4 --> s5: hidden tests kept on the VM
  s5 --> s6: patch ready
  s6 --> s5: a check fails [under 2 repair rounds used]
  s6 --> s7: every check passes on that exact patch
  s7 --> s5: blocking findings [under 2 repair rounds used]
  s7 --> s8: no blocking findings, PR marked ready
  s8 --> s10: you close the PR without merging
  s8 --> s5: you comment on the PR [under 2 repair rounds used]
  s8 --> s13: you merge the PR
  s5 --> s9: you merge the PR
  s6 --> s11: a check fails [2 repair rounds used]
  s7 --> s11: blocking findings [2 repair rounds used]
  s8 --> s11: you comment on the PR [2 repair rounds used]
  s9 --> s11: a check fails [2 repair rounds used] or blocking findings [2 repair rounds used]
  s2 --> s1: policy refuses, or the patch touches a forbidden path
  s2 --> s10: token budget spent or label removed or issue closed
  s2 --> s11: a stage keeps failing
  classDef breaks fill:#ffecee,stroke:#e72e3b,stroke-width:2.5px,color:#cd2834
  classDef mayBreak fill:#fff3e6,stroke:#e8730c,stroke-width:2.5px,color:#b85a06
  class s0 teal
  class s0 bugPath
  class s1 tan
  class s1 mayBreak
  class s3 yellow
  class s3 bugPath
  class s4 purple
  class s4 bugPath
  class s5 purple
  class s5 bugPath
  class s6 purple
  class s6 bugPath
  class s7 purple
  class s7 bugPath
  class s8 purple
  class s8 bugPath
  class s9 purple
  class s9 breaks
  class s9 bugPath
  class s10 tan
  class s10 mayBreak
  class s11 tan
  class s11 mayBreak
  class s12 purple
  class s13 purple
  classDef blue fill:#c3e0ff
  classDef teal fill:#bfe3df
  classDef orange fill:#ffd8b0
  classDef tan fill:#eadfcb
  classDef yellow fill:#fff0a8
  classDef purple fill:#e2d4f5
  classDef bugPath stroke:#e72e3b,stroke-width:2px
```

Rules checked (`journey/Journey.cfg`):

| Rule | Meaning | Result |
| --- | --- | --- |
| `LandOnlyVerified` | Nothing is recorded as landed unless every check passed on that exact patch. | holds |
| `RepairCap` | A ticket gets at most two repair rounds, reviewer and owner rounds together. | holds |
| `ReviewOnlyVerified` | Review and human review only see a patch whose checks passed. | holds |
| `MergeEndsRun` | Once you merge the PR, the run ends as landed. | **breaks** |

`MergeEndsRun` breaks on this path: the PR waits for your review, you comment, the run goes back to build, and you merge the PR on GitHub while the repair is building. `advance()` accepts `landed` only during `land`, so it returns `invalid`, and the run keeps building on a PR that is already merged. `journey/replay-merge-mid-repair.ts` replays this against the real `advance()`. It uses a blocking review in place of the owner comment, because F10 is not built and both take the same repair path. The F10 plan now turns the PR into a draft during a repair, so GitHub refuses the merge. It keeps the published head and its verdict apart from the repair in progress, so a merge that lands anyway ends the run as landed and records whether that head was verified.

The chart hides some arrows to stay readable. "You merge the PR" is drawn only from "PR waits for your review" and "Building the patch". "You close the PR without merging" is drawn only from "PR waits for your review". The model allows both from every stage after the PR opens.

## What the controller does with one run today

Blue is waiting for admission, teal holds a claim, orange is a controller restart and recovery, and tan has ended.

```mermaid
stateDiagram-v2
  state "Legend" as legend {
    lg0: waiting
    lg1: held
    lg2: restart
    lg3: ended
  }
  class lg0 blue
  class lg1 teal
  class lg2 orange
  class lg3 tan
  s0: Seen with the ready label
  s1: Label removed, nothing running
  state "Holding a claim" as s2 {
    s3: Claimed, marker posted on the issue
    s4: Stage running in the sandbox
    s5: Sandbox down, slot kept
    s6: Waiting to retry
  }
  s7: Controller restarting
  s8: Stopping the aborted stage
  s9: Released
  s10: Token budget spent
  s11: Failed
  s12: Stage passed, run stops here for now
  s13: Run reserved, waiting to be adopted
  [*] --> s0
  s0 --> s1: label removed or issue closed
  s0 --> s3: admitted
  s3 --> s4: the sandbox launches the stage
  s3 --> s9: label removed or issue closed
  s3 --> s5: the sandbox check fails
  s7 --> s13: the controller reserves the run from its claim file
  s4 --> s8: stage stalls [no attempts or tokens left] or label removed or issue closed
  s4 --> s10: stage fails [token cap reached]
  s4 --> s11: stage refuses or stage fails [no attempts left]
  s4 --> s12: stage passes
  s4 --> s6: stage fails or stalls [attempts and tokens left]
  s8 --> s7: the controller restarts
  s13 --> s3: the controller adopts the run from its marker
  s6 --> s4: backoff ends
  s8 --> s10: the aborted sandbox stops
  s5 --> s9: label removed or issue closed
  s13 --> s9: the controller finds the label gone
  s6 --> s9: label removed or issue closed
  s5 --> s4: the sandbox launches the stage
  s13 --> s6: the controller adopts the run from its marker
  s6 --> s5: the sandbox check fails
  s6 --> s8: label removed or issue closed
  s13 --> s5: the controller adopts the run from its marker
  s8 --> s9: the aborted sandbox stops
  s8 --> s11: the aborted sandbox stops
  s13 --> s11: the controller ends the interrupted attempt [no attempts left]
  s2 --> s7: the controller restarts
  class s0 blue
  class s1 blue
  class s3 teal
  class s4 teal
  class s5 teal
  class s6 teal
  class s7 orange
  class s8 teal
  class s9 tan
  class s10 tan
  class s11 tan
  class s12 tan
  class s13 orange
  classDef blue fill:#c3e0ff
  classDef teal fill:#bfe3df
  classDef orange fill:#ffd8b0
  classDef tan fill:#eadfcb
  classDef yellow fill:#fff0a8
  classDef purple fill:#e2d4f5
  classDef bugPath stroke:#e72e3b,stroke-width:2px
```

Rules checked (`controller/Controller.cfg`, which also allows a re-label):

| Rule | Meaning | Result |
| --- | --- | --- |
| `OneSandboxPerIssue` | Two sandboxes never run a stage for one issue at the same time, even across a restart. | holds |
| `EndedStaysEnded` | A run that ended never launches a stage again. | holds |
| `AttemptCap` | A run never gets more attempts at a stage than the workflow allows. | holds |
| `OneLiveRun` | GitHub never shows two live runs for one issue. | holds |
| `NotLost` | After the first tick, a live run on GitHub is held in memory or reserved for adoption. | holds |
| `Adopted` | A reserved run is always adopted or ended later. A restart never loses it. | holds, if the reads adoption needs succeed eventually |

The chart is drawn from `controller/Chart.cfg`, which leaves out the re-label so that the graph stays under the 500-state chart budget. `Controller.cfg` checks the same rules with the re-label, over 3,084 states.

After a restart, the first tick reserves the run from its claim file, and usually adopts it from its marker in the same tick. Adoption waits for a later tick when the issue's marker comments cannot be read, or when the workflow is not loaded. It also waits when the timeline read fails for a run whose marker says running or retrying, and when no slot is free for a claimed or blocked run. Until then the run is reserved but not in memory, which `test/orchestrator.test.ts` also expects. A claimed or blocked run whose timeline read fails is adopted, but it does not relaunch until the read succeeds. The model splits reserve and adopt into two steps, so other events can happen between them, and assumes the reads succeed eventually.

The chart hides the restart from states with no run, the startup reconcile retry, and the adoption steps that only end a run whose budget is spent. A restart mid-stage counts the interrupted attempt as a failed one.

## What the models leave out

- One issue only, so the concurrency cap and slot sharing are not checked.
- Admission refusals, the kill switch, and the sandbox preflight internals. Admission is covered by `test/admission.test.ts`.
- Marker posts that fail or return no comment. The model posts every marker at once.
- Reads that fail. A read that delays adoption or a relaunch is a wait, and the model assumes it succeeds eventually.
- Timing. A stalled stage stops before the cleanup grace runs out, which is what the sandbox runner promises.
- The post-v1 approval checkpoints, and the held-out suite's visibility to the builder.

## Regenerate

The tool is the pstack statechart skill. It needs Java 11 or later, `tla2tools.jar`, and Bun or Deno, because Node will not strip types under `node_modules`.

```sh
export TLA2TOOLS=/path/to/tla2tools.jar JAVA=/path/to/java
SC=~/.pi/agent/npm/node_modules/pi-herdr-pstack/skills/statechart/scripts/statechart.ts
cd docs/statecharts/journey && bun "$SC" Journey.tla --config Journey.cfg --view view.ts --out /tmp/journey-out
cd ../controller && bun "$SC" Controller.tla --config Chart.cfg --view view.ts --out /tmp/controller-out
bun "$SC" Controller.tla --config Controller.cfg --view view.ts --out /tmp/controller-full
```
