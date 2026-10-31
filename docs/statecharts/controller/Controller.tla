---- MODULE Controller ----
\* One issue as src/orchestrator.ts and server/sandbox.ts handle it today:
\* claim, launch in the sandbox, retry with a cap, release, restart recovery.
EXTENDS Naturals

CONSTANTS MaxAttempts, AllowRelabel, MaxRestarts

VARIABLES
    ticket,      \* "ready" or "gone" (label removed or issue closed)
    event,       \* the current ready label event, 1 or 2 after a re-label
    run,         \* the event of the run in controller memory, 0 for none
    ph,          \* "none" "claimed" "running" "blocked" "retry" "ending"
    endAs,       \* terminal status a run in "ending" will post
    attempt,     \* the run's attempt; the marker carries it across restarts
    tokens,      \* TRUE while the run's token budget has room; the marker carries usage
    marker,      \* event -> last status posted on the issue, "none" before the first
    cur,         \* this controller's sandbox for the issue: "none" "running" "stopping"
    orphan,      \* a sandbox left by an earlier controller process is still running
    loaded,      \* FALSE after a restart until the first tick has recovered claims
    reconciled,  \* the executor has stopped every leftover sandbox
    sandboxOk,   \* the rest of the sandbox preflight passes
    pending,     \* event of a live run reserved after a restart but not yet adopted, 0 for none
    restarts,
    launchedEnded, \* a stage launched for a run whose marker was already terminal
    branches,     \* events with published refs, abstracted across rounds
    stage,        \* build or review; persisted across restart
    round         \* shared validation/review repair counter

vars == <<ticket, event, run, ph, endAs, attempt, tokens, marker, cur, orphan,
          loaded, reconciled, sandboxOk, pending, restarts, launchedEnded, branches, stage, round>>

Events == {1, 2}
Terminal == {"released", "failed", "budget_exhausted", "stage_passed"}
CI == {"publishing", "awaiting_ci", "ci_unavailable", "verdict_pass", "verdict_fail", "ci_timeout"}
Live == {"claimed", "running", "blocked", "retrying"} \cup CI

StatusOf(p) ==
    CASE p = "claimed" -> "claimed"
      [] p = "running" -> "running"
      [] p = "blocked" -> "blocked"
      [] p = "retry"   -> "retrying"
      [] p \in CI -> p

Init ==
    /\ ticket = "ready" /\ event = 1
    /\ run = 0 /\ ph = "none" /\ endAs = "none"
    /\ attempt = 0 /\ tokens = TRUE
    /\ marker = [e \in Events |-> "none"]
    /\ cur = "none" /\ orphan = FALSE
    /\ loaded = TRUE /\ reconciled = TRUE /\ sandboxOk = TRUE
    /\ pending = 0 /\ restarts = 0 /\ launchedEnded = FALSE /\ branches = {}
    /\ stage = "build" /\ round = 0

\* Moves the run to a live phase and posts its marker.
Go(p) == ph' = p /\ marker' = [marker EXCEPT ![run] = StatusOf(p)]

\* Ends the run. A terminal marker waits while an aborted sandbox is stopping
\* (#settling); otherwise #sync posts it and forgets the run.
Finish(st, c) ==
    /\ cur' = c
    /\ IF c = "stopping"
       THEN ph' = "ending" /\ endAs' = st /\ UNCHANGED <<run, marker>>
       ELSE /\ ph' = "none" /\ endAs' = "none" /\ run' = 0
            /\ marker' = [marker EXCEPT ![run] = st]

\* #endStage: budget first, then the attempt cap, else a retry.
EndStage(c) ==
    \E left \in BOOLEAN :
        /\ tokens' = (tokens /\ left)
        /\ IF ~tokens'
           THEN Finish("budget_exhausted", c) /\ UNCHANGED attempt
           ELSE IF attempt >= MaxAttempts
                THEN Finish("failed", c) /\ UNCHANGED attempt
                ELSE /\ attempt' = attempt + 1 /\ cur' = c
                     /\ Go("retry") /\ UNCHANGED <<run, endAs>>

Environment == <<ticket, event, orphan, loaded, reconciled, sandboxOk, pending, restarts>>
Fixed == <<Environment, branches, stage, round>>

\* Dispatch claims only after the tick's ledger read, which adopts or
\* releases a reserved run first.
Admit ==
    /\ loaded /\ pending = 0 /\ ticket = "ready" /\ run = 0 /\ ph = "none"
    /\ marker[event] = "none"
    /\ run' = event /\ attempt' = 1 /\ tokens' = TRUE
    /\ ph' = "claimed" /\ marker' = [marker EXCEPT ![event] = "claimed"]
    /\ stage' = "build" /\ round' = 0
    /\ UNCHANGED <<endAs, cur, launchedEnded, Environment, branches>>

Ready == loaded /\ ticket = "ready" /\ run = event

Launch ==
    /\ Ready /\ ph \in {"claimed", "retry", "blocked"} /\ cur = "none"
    /\ ph = "blocked" => (sandboxOk /\ reconciled)
    /\ launchedEnded' = (launchedEnded \/ marker[run] \in Terminal)
    /\ IF ~tokens
       THEN Finish("budget_exhausted", "none") /\ UNCHANGED <<attempt, tokens>>
       ELSE IF sandboxOk /\ reconciled
            THEN /\ cur' = "running" /\ Go("running")
                 /\ UNCHANGED <<run, endAs, attempt, tokens>>
            ELSE /\ ph # "blocked" /\ Go("blocked")
                 /\ UNCHANGED <<run, endAs, attempt, tokens, cur>>
    /\ UNCHANGED Fixed

Running == ph = "running" /\ cur = "running"

StagePasses ==
    /\ Running /\ stage = "build" /\ cur' = "none" /\ Go("publishing")
    /\ UNCHANGED <<run, endAs, attempt, tokens, launchedEnded>> /\ UNCHANGED Fixed

Published ==
    /\ UNCHANGED <<stage, round>>
    /\ ph = "publishing" /\ Go("awaiting_ci")
    /\ branches' = branches \cup {run}
    /\ UNCHANGED <<run, endAs, attempt, tokens, cur, launchedEnded>> /\ UNCHANGED Environment

CollectCI ==
    /\ ph = "awaiting_ci"
    /\ \E result \in {"verdict_pass", "verdict_fail"} : Go(result)
    /\ UNCHANGED <<run, endAs, attempt, tokens, cur, launchedEnded>> /\ UNCHANGED Fixed

CIUnavailable ==
    /\ ph = "awaiting_ci" /\ Go("ci_unavailable")
    /\ UNCHANGED <<run, endAs, attempt, tokens, cur, launchedEnded>> /\ UNCHANGED Fixed

RetryCI ==
    /\ ph = "ci_unavailable" /\ Go("awaiting_ci")
    /\ UNCHANGED <<run, endAs, attempt, tokens, cur, launchedEnded>> /\ UNCHANGED Fixed

CIDeadline ==
    /\ ph \in {"awaiting_ci", "ci_unavailable"} /\ Go("ci_timeout")
    /\ UNCHANGED <<run, endAs, attempt, tokens, cur, launchedEnded>> /\ UNCHANGED Fixed

Cleanup ==
    /\ UNCHANGED <<stage, round>>
    /\ \E e \in Events :
        /\ e \in branches /\ marker[e] \in Terminal
        /\ branches' = branches \ {e}
    /\ UNCHANGED <<ticket, event, run, ph, endAs, attempt, tokens, marker, cur,
                   orphan, loaded, reconciled, sandboxOk, pending, restarts, launchedEnded>>

RepairOrFail ==
    IF round < 2
    THEN /\ round' = round + 1 /\ stage' = "build" /\ attempt' = 1
         /\ Go("claimed") /\ UNCHANGED <<run, endAs, cur>>
    ELSE /\ Finish("failed", "none") /\ UNCHANGED <<attempt, stage, round>>

StoreVerdict ==
    /\ ph \in {"verdict_pass", "verdict_fail", "ci_timeout"}
    /\ CASE ph = "verdict_pass" ->
                /\ stage' = "review" /\ attempt' = 1 /\ Go("claimed")
                /\ UNCHANGED <<run, endAs, cur, round>>
         [] ph = "verdict_fail" -> RepairOrFail
         [] OTHER -> /\ Finish("failed", "none") /\ UNCHANGED <<attempt, stage, round>>
    /\ UNCHANGED <<tokens, launchedEnded, Environment, branches>>

ReviewPasses ==
    /\ Running /\ stage = "review" /\ Finish("stage_passed", "none")
    /\ UNCHANGED <<attempt, tokens, launchedEnded>> /\ UNCHANGED Fixed

ReviewBlocks ==
    /\ Running /\ stage = "review"
    /\ IF round < 2
       THEN /\ round' = round + 1 /\ stage' = "build" /\ attempt' = 1
            /\ cur' = "none" /\ Go("claimed") /\ UNCHANGED <<run, endAs>>
       ELSE /\ Finish("failed", "none") /\ UNCHANGED <<attempt, stage, round>>
    /\ UNCHANGED <<tokens, launchedEnded, Environment, branches>>

StageRefuses ==
    /\ Running /\ Finish("failed", "none")
    /\ UNCHANGED <<attempt, tokens, launchedEnded>> /\ UNCHANGED Fixed

StageFails ==
    /\ Running /\ EndStage("none")
    /\ UNCHANGED launchedEnded /\ UNCHANGED Fixed

StageStalls ==
    /\ Running /\ EndStage("stopping")
    /\ UNCHANGED launchedEnded /\ UNCHANGED Fixed

Release ==
    /\ loaded /\ run # 0 /\ ph \in ({"claimed", "running", "blocked", "retry"} \cup CI)
    /\ (ticket = "gone" \/ event # run)
    /\ Finish("released", IF cur = "running" THEN "stopping" ELSE cur)
    /\ UNCHANGED <<attempt, tokens, launchedEnded>> /\ UNCHANGED Fixed

PostEnd ==
    /\ ph = "ending" /\ cur # "stopping"
    /\ marker' = [marker EXCEPT ![run] = endAs]
    /\ run' = 0 /\ ph' = "none" /\ endAs' = "none"
    /\ UNCHANGED <<attempt, tokens, cur, launchedEnded>> /\ UNCHANGED Fixed

SandboxStops ==
    /\ UNCHANGED <<stage, round>>
    /\ cur = "stopping" /\ cur' = "none"
    /\ UNCHANGED <<ticket, event, run, ph, endAs, attempt, tokens, marker,
                   orphan, loaded, reconciled, sandboxOk, pending, restarts, launchedEnded, branches>>

Restart ==
    /\ UNCHANGED <<stage, round>>
    /\ restarts < MaxRestarts /\ restarts' = restarts + 1
    /\ run' = 0 /\ ph' = "none" /\ endAs' = "none"
    /\ orphan' = (orphan \/ cur # "none") /\ cur' = "none"
    /\ loaded' = FALSE /\ reconciled' = FALSE
    /\ UNCHANGED <<ticket, event, attempt, tokens, marker, sandboxOk, pending, launchedEnded, branches>>

LiveEvent == {e \in Events : marker[e] \in Live}

\* First tick after a restart: executor.recover() stops leftovers, and
\* #loadClaims reserves the run its claim file names. Adoption waits for
\* a later step whose ledger, timeline and workflow reads succeed.
Recover ==
    /\ UNCHANGED <<stage, round>>
    /\ ~loaded /\ loaded' = TRUE
    /\ \E ok \in BOOLEAN :
        /\ reconciled' = ok /\ orphan' = (orphan /\ ~ok)
    /\ pending' = IF LiveEvent = {} THEN 0 ELSE CHOOSE x \in LiveEvent : TRUE
    /\ UNCHANGED <<ticket, event, run, ph, endAs, attempt, tokens, marker, cur,
                   sandboxOk, restarts, launchedEnded, branches>>

\* #discover, #settleClaims and #adoptExistingRun rebuild the run from its marker.
Adopt ==
    /\ UNCHANGED <<stage, round>>
    /\ loaded /\ pending # 0 /\ pending' = 0
    /\ LET e == pending
            m == marker[pending]
       IN IF ticket = "gone" \/ e # event
          THEN /\ marker' = [marker EXCEPT ![e] = "released"]
               /\ UNCHANGED <<run, ph, endAs, attempt, tokens>>
          ELSE IF m = "running"
               THEN \* the interrupted attempt ends as a failed one
                    IF ~tokens
                    THEN /\ marker' = [marker EXCEPT ![e] = "budget_exhausted"]
                         /\ UNCHANGED <<run, ph, endAs, attempt, tokens>>
                    ELSE IF attempt >= MaxAttempts
                    THEN /\ marker' = [marker EXCEPT ![e] = "failed"]
                         /\ UNCHANGED <<run, ph, endAs, attempt, tokens>>
                    ELSE /\ run' = e /\ attempt' = attempt + 1 /\ ph' = "retry"
                         /\ marker' = [marker EXCEPT ![e] = "retrying"]
                         /\ UNCHANGED <<endAs, tokens>>
               ELSE /\ run' = e /\ marker' = marker /\ UNCHANGED <<endAs, attempt, tokens>>
                    /\ ph' = CASE m = "claimed" -> "claimed"
                               [] m = "blocked" -> "blocked"
                               [] m = "retrying" -> "retry"
                               [] m \in CI -> m
    /\ UNCHANGED <<ticket, event, cur, orphan, loaded, reconciled, sandboxOk, restarts, launchedEnded, branches>>

\* The preflight retries the reconcile until every leftover is stopped.
Reconcile ==
    /\ UNCHANGED <<stage, round>>
    /\ loaded /\ ~reconciled /\ reconciled' = TRUE /\ orphan' = FALSE
    /\ UNCHANGED <<ticket, event, run, ph, endAs, attempt, tokens, marker, cur,
                   loaded, sandboxOk, pending, restarts, launchedEnded, branches>>

YouRemoveLabel ==
    /\ UNCHANGED <<stage, round>>
    /\ ticket = "ready" /\ ticket' = "gone"
    /\ UNCHANGED <<event, run, ph, endAs, attempt, tokens, marker, cur, orphan,
                   loaded, reconciled, sandboxOk, pending, restarts, launchedEnded, branches>>

YouRelabel ==
    /\ UNCHANGED <<stage, round>>
    /\ AllowRelabel /\ event = 1 /\ event' = 2 /\ ticket' = "ready"
    /\ UNCHANGED <<run, ph, endAs, attempt, tokens, marker, cur, orphan,
                   loaded, reconciled, sandboxOk, pending, restarts, launchedEnded, branches>>

SandboxBreaks ==
    /\ UNCHANGED <<stage, round>>
    /\ sandboxOk /\ sandboxOk' = FALSE
    /\ UNCHANGED <<ticket, event, run, ph, endAs, attempt, tokens, marker, cur,
                   orphan, loaded, reconciled, pending, restarts, launchedEnded, branches>>

SandboxHeals ==
    /\ UNCHANGED <<stage, round>>
    /\ ~sandboxOk /\ sandboxOk' = TRUE
    /\ UNCHANGED <<ticket, event, run, ph, endAs, attempt, tokens, marker, cur,
                   orphan, loaded, reconciled, pending, restarts, launchedEnded, branches>>

Idle ==
    /\ loaded /\ run = 0 /\ cur = "none" /\ pending = 0
    /\ (ticket = "gone" \/ marker[event] \in Terminal)
    /\ UNCHANGED vars

Next ==
    \/ Admit \/ Launch \/ StagePasses \/ Published \/ CollectCI \/ StoreVerdict
    \/ CIUnavailable \/ RetryCI \/ CIDeadline \/ Cleanup \/ ReviewPasses \/ ReviewBlocks
    \/ StageRefuses \/ StageFails \/ StageStalls
    \/ Release \/ PostEnd \/ SandboxStops \/ Restart \/ Recover \/ Adopt \/ Reconcile
    \/ YouRemoveLabel \/ YouRelabel \/ SandboxBreaks \/ SandboxHeals \/ Idle

\* Adoption's reads succeed eventually.
Spec == Init /\ [][Next]_vars /\ WF_vars(Adopt) /\ WF_vars(Recover)
        /\ WF_vars(Published) /\ WF_vars(CIDeadline) /\ WF_vars(StoreVerdict)
        /\ WF_vars(Release) /\ WF_vars(Cleanup) /\ WF_vars(ReviewPasses)
        /\ WF_vars(StagePasses) /\ WF_vars(SandboxHeals) /\ WF_vars(Reconcile)
        /\ SF_vars(Launch) /\ WF_vars(SandboxStops) /\ WF_vars(PostEnd)

CIEnds == \A e \in Events : marker[e] \in CI ~> (marker[e] \in Terminal /\ e \notin branches)

\* Never two sandboxes running a stage for one issue.
OneSandboxPerIssue == ~(orphan /\ cur # "none") /\ (ph \in CI => cur = "none")
\* A run that ended never launches a stage again.
EndedStaysEnded == ~launchedEnded
\* A run never gets more than MaxAttempts attempts at a stage.
AttemptCap == attempt <= MaxAttempts /\ round <= 2
\* At most one live run per issue on GitHub.
OneLiveRun == \A a, b \in Events : (marker[a] \in Live /\ marker[b] \in Live) => a = b
\* After the first tick, a live run on GitHub is held in memory or reserved for adoption.
NotLost == loaded => \A e \in Events : marker[e] \in Live => (run = e \/ pending = e)
\* A reserved run is adopted or ended: a restart never loses it.
Adopted == pending # 0 ~> pending = 0
====
