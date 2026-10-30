---- MODULE Controller ----
\* One issue as src/orchestrator.ts and server/sandbox.ts handle it today:
\* claim, launch in the sandbox, retry with a cap, release, restart recovery.
EXTENDS Naturals

CONSTANTS MaxAttempts, AllowRelabel

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
    restarts,
    launchedEnded \* a stage launched for a run whose marker was already terminal

vars == <<ticket, event, run, ph, endAs, attempt, tokens, marker, cur, orphan,
          loaded, reconciled, sandboxOk, restarts, launchedEnded>>

Events == {1, 2}
Terminal == {"released", "failed", "budget_exhausted", "stage_passed"}
Live == {"claimed", "running", "blocked", "retrying"}

StatusOf(p) ==
    CASE p = "claimed" -> "claimed"
      [] p = "running" -> "running"
      [] p = "blocked" -> "blocked"
      [] p = "retry"   -> "retrying"

Init ==
    /\ ticket = "ready" /\ event = 1
    /\ run = 0 /\ ph = "none" /\ endAs = "none"
    /\ attempt = 0 /\ tokens = TRUE
    /\ marker = [e \in Events |-> "none"]
    /\ cur = "none" /\ orphan = FALSE
    /\ loaded = TRUE /\ reconciled = TRUE /\ sandboxOk = TRUE
    /\ restarts = 0 /\ launchedEnded = FALSE

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

Fixed == <<ticket, event, orphan, loaded, reconciled, sandboxOk, restarts>>

Admit ==
    /\ loaded /\ ticket = "ready" /\ run = 0 /\ ph = "none"
    /\ marker[event] = "none"
    /\ run' = event /\ attempt' = 1 /\ tokens' = TRUE
    /\ ph' = "claimed" /\ marker' = [marker EXCEPT ![event] = "claimed"]
    /\ UNCHANGED <<endAs, cur, launchedEnded>> /\ UNCHANGED Fixed

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
    /\ Running /\ Finish("stage_passed", "none")
    /\ UNCHANGED <<attempt, tokens, launchedEnded>> /\ UNCHANGED Fixed

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
    /\ loaded /\ run # 0 /\ ph \in {"claimed", "running", "blocked", "retry"}
    /\ (ticket = "gone" \/ event # run)
    /\ Finish("released", IF cur = "running" THEN "stopping" ELSE cur)
    /\ UNCHANGED <<attempt, tokens, launchedEnded>> /\ UNCHANGED Fixed

PostEnd ==
    /\ ph = "ending" /\ cur # "stopping"
    /\ marker' = [marker EXCEPT ![run] = endAs]
    /\ run' = 0 /\ ph' = "none" /\ endAs' = "none"
    /\ UNCHANGED <<attempt, tokens, cur, launchedEnded>> /\ UNCHANGED Fixed

SandboxStops ==
    /\ cur = "stopping" /\ cur' = "none"
    /\ UNCHANGED <<ticket, event, run, ph, endAs, attempt, tokens, marker,
                   orphan, loaded, reconciled, sandboxOk, restarts, launchedEnded>>

Restart ==
    /\ restarts < 1 /\ restarts' = restarts + 1
    /\ run' = 0 /\ ph' = "none" /\ endAs' = "none"
    /\ orphan' = (orphan \/ cur # "none") /\ cur' = "none"
    /\ loaded' = FALSE /\ reconciled' = FALSE
    /\ UNCHANGED <<ticket, event, attempt, tokens, marker, sandboxOk, launchedEnded>>

LiveEvent == {e \in Events : marker[e] \in Live}

\* First tick after a restart: executor.recover() stops leftovers, then
\* #loadClaims and #adoptExistingRun rebuild the run from its marker.
Recover ==
    /\ ~loaded /\ loaded' = TRUE
    /\ \E ok \in BOOLEAN :
        /\ reconciled' = ok /\ orphan' = (orphan /\ ~ok)
    /\ IF LiveEvent = {}
       THEN UNCHANGED <<run, ph, endAs, attempt, tokens, marker>>
       ELSE LET e == CHOOSE x \in LiveEvent : TRUE
                m == marker[e]
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
    /\ UNCHANGED <<ticket, event, cur, sandboxOk, restarts, launchedEnded>>

\* The preflight retries the reconcile until every leftover is stopped.
Reconcile ==
    /\ loaded /\ ~reconciled /\ reconciled' = TRUE /\ orphan' = FALSE
    /\ UNCHANGED <<ticket, event, run, ph, endAs, attempt, tokens, marker, cur,
                   loaded, sandboxOk, restarts, launchedEnded>>

YouRemoveLabel ==
    /\ ticket = "ready" /\ ticket' = "gone"
    /\ UNCHANGED <<event, run, ph, endAs, attempt, tokens, marker, cur, orphan,
                   loaded, reconciled, sandboxOk, restarts, launchedEnded>>

YouRelabel ==
    /\ AllowRelabel /\ event = 1 /\ event' = 2 /\ ticket' = "ready"
    /\ UNCHANGED <<run, ph, endAs, attempt, tokens, marker, cur, orphan,
                   loaded, reconciled, sandboxOk, restarts, launchedEnded>>

SandboxBreaks ==
    /\ sandboxOk /\ sandboxOk' = FALSE
    /\ UNCHANGED <<ticket, event, run, ph, endAs, attempt, tokens, marker, cur,
                   orphan, loaded, reconciled, restarts, launchedEnded>>

SandboxHeals ==
    /\ ~sandboxOk /\ sandboxOk' = TRUE
    /\ UNCHANGED <<ticket, event, run, ph, endAs, attempt, tokens, marker, cur,
                   orphan, loaded, reconciled, restarts, launchedEnded>>

Idle ==
    /\ loaded /\ run = 0 /\ cur = "none"
    /\ (ticket = "gone" \/ marker[event] \in Terminal)
    /\ UNCHANGED vars

Next ==
    \/ Admit \/ Launch \/ StagePasses \/ StageRefuses \/ StageFails \/ StageStalls
    \/ Release \/ PostEnd \/ SandboxStops \/ Restart \/ Recover \/ Reconcile
    \/ YouRemoveLabel \/ YouRelabel \/ SandboxBreaks \/ SandboxHeals \/ Idle

Spec == Init /\ [][Next]_vars

\* Never two sandboxes running a stage for one issue.
OneSandboxPerIssue == ~(orphan /\ cur # "none")
\* A run that ended never launches a stage again.
EndedStaysEnded == ~launchedEnded
\* A run never gets more than MaxAttempts attempts at a stage.
AttemptCap == attempt <= MaxAttempts
\* At most one live run per issue on GitHub.
OneLiveRun == \A a, b \in Events : (marker[a] \in Live /\ marker[b] \in Live) => a = b
\* After the controller is up, a live run on GitHub is held in memory: a restart never loses it.
NotLost == loaded => \A e \in Events : marker[e] \in Live => run = e
====
