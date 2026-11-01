---- MODULE Controller ----
EXTENDS Naturals, Sequences, FiniteSets
CONSTANTS MaxGenerations, MaxRepairs, MaxRefreshes, MaxAttempts,
          ReviewQuota, RepairQuota, RunQuota, UsageClass, PriorUsage, Presentation, Profile, LateUnknown,
          MaxRestarts, CleanupPartition
VARIABLES b, env, saved, mode, process, orphan, queued, restarts, privateOK,
          readHead, refs, moved, deleted, deadline, mergeSeenMissing, focus
controlVars == <<b, env, saved, mode, process, orphan, queued, restarts, privateOK,
          readHead, refs, moved, deleted, deadline, mergeSeenMissing>>
vars == <<b, env, saved, mode, process, orphan, queued, restarts, privateOK,
          readHead, refs, moved, deleted, deadline, mergeSeenMissing, focus>>
J == INSTANCE Journey
Aux == <<saved, mode, process, orphan, queued, restarts, privateOK,
         readHead, refs, moved, deleted, deadline, mergeSeenMissing, focus>>
Stable == UNCHANGED focus
Init == /\ J!Init /\ saved = b /\ mode = "ready" /\ process = 0 /\ orphan = FALSE
    /\ queued = 0 /\ restarts = 0 /\ privateOK = TRUE /\ readHead = 0
    /\ refs = {} /\ moved = {} /\ deleted = {}
    /\ deadline = [g \in 1..MaxGenerations |-> 0] /\ mergeSeenMissing = FALSE
    /\ focus \in (IF ~CleanupPartition THEN {0} ELSE IF Presentation THEN {1} ELSE 1..MaxGenerations)

Decide == /\ Stable /\ mode = "ready" /\ privateOK /\ J!Policy
    /\ mode' = "save" /\ UNCHANGED <<saved, process, orphan, queued, restarts, privateOK,
        readHead, refs, moved, deleted, deadline, mergeSeenMissing>>
ObserveTerminal == /\ Stable /\ mode \in {"effect", "response", "promote_write"} /\ privateOK
    /\ (J!ObserveMerge \/ J!ObserveClose) /\ mode' = "save"
    /\ UNCHANGED <<saved, process, orphan, queued, restarts, privateOK,
        readHead, refs, moved, deleted, deadline, mergeSeenMissing>>
Persist == /\ Stable /\ mode = "save" /\ saved' = b
    /\ mode' = (IF b.pending = J!None THEN "ready" ELSE "effect")
    /\ UNCHANGED <<b, env, process, orphan, queued, restarts, privateOK,
        readHead, refs, moved, deleted, deadline, mergeSeenMissing>>

PublishValidation == /\ Stable /\ mode = "effect" /\ b = saved /\ b.pending = "validate"
    /\ (focus = 0 \/ focus = J!Current(b))
    /\ J!Current(b) \notin refs /\ J!Current(b) \notin deleted
    /\ refs' = refs \cup {J!Current(b)}
    /\ deadline' = [deadline EXCEPT ![J!Current(b)] = 1]
    /\ UNCHANGED <<b, env, saved, mode, process, orphan, queued, restarts, privateOK,
        readHead, moved, deleted, mergeSeenMissing>>
Validate == /\ Stable /\ mode = "effect" /\ b.pending = "validate"
    /\ ((focus # 0 /\ focus # J!Current(b)) \/ J!Current(b) \in refs)
    /\ J!Validate /\ mode' = "save"
    /\ UNCHANGED <<saved, process, orphan, queued, restarts, privateOK,
        readHead, refs, moved, deleted, deadline, mergeSeenMissing>>
LaunchProcess == /\ Stable /\ mode = "effect" /\ b = saved
    /\ b.pending \in {"launch_review", "repair_build"} /\ process = 0 /\ ~orphan
    /\ env.enabled /\ process' = b.active /\ mode' = "response"
    /\ UNCHANGED <<b, env, saved, orphan, queued, restarts, privateOK,
        readHead, refs, moved, deleted, deadline, mergeSeenMissing>>
LaunchResponse == /\ Stable /\ mode = "response" /\ J!Launch /\ mode' = "save"
    /\ UNCHANGED <<saved, process, orphan, queued, restarts, privateOK,
        readHead, refs, moved, deleted, deadline, mergeSeenMissing>>
ProcessSettles == /\ Stable /\ process # 0 /\ ~orphan /\ mode # "down" /\ queued = 0
    /\ queued' = process /\ process' = 0
    /\ UNCHANGED <<b, env, saved, mode, orphan, restarts, privateOK,
        readHead, refs, moved, deleted, deadline, mergeSeenMissing>>
Consume == /\ Stable /\ mode = "ready" /\ queued # 0 /\ privateOK
    /\ (env.pr # "merged" \/ b.terminal = "merged")
    /\ (IF queued = b.active /\ b.phase \in {"reviewing", "repairing"}
       THEN J!Callback
       ELSE /\ b' = J!Account(b, queued, UsageClass, b.accounts[queued].known, b.accounts[queued].settled)
            /\ UNCHANGED env)
    /\ queued' = 0 /\ mode' = "save"
    /\ UNCHANGED <<saved, process, orphan, restarts, privateOK,
        readHead, refs, moved, deleted, deadline, mergeSeenMissing>>
StopProcess == /\ Stable /\ mode = "effect" /\ b.pending = "stop_execution"
    /\ process # 0 /\ process' = 0 /\ orphan' = FALSE
    /\ UNCHANGED <<b, env, saved, mode, queued, restarts, privateOK,
        readHead, refs, moved, deleted, deadline, mergeSeenMissing>>
StopResponse == /\ Stable /\ mode = "effect" /\ b.pending = "stop_execution" /\ process = 0 /\ ~orphan
    /\ J!Stop /\ mode' = "save"
    /\ UNCHANGED <<saved, process, orphan, queued, restarts, privateOK,
        readHead, refs, moved, deleted, deadline, mergeSeenMissing>>

OpenRemote == /\ Stable /\ mode = "effect" /\ b = saved /\ J!RemoteOpen /\ UNCHANGED Aux
ReadPredecessor == /\ Stable /\ mode = "effect" /\ b = saved /\ b.pending = "promote_pr"
    /\ env.ref = b.current.expected /\ readHead' = env.ref
    /\ mode' = "promote_write"
    /\ UNCHANGED <<b, env, saved, process, orphan, queued, restarts, privateOK,
        refs, moved, deleted, deadline, mergeSeenMissing>>
WriteNonForce == /\ Stable /\ mode = "promote_write" /\ env.enabled /\ readHead = b.current.expected
    /\ env.ref \in {0, b.current.expected, J!Current(b)}
    /\ env' = [env EXCEPT !.ref = J!Current(b), !.ordinary = 0]
    /\ mode' = "effect" /\ UNCHANGED <<b, saved, process, orphan, queued, restarts, privateOK,
        readHead, refs, moved, deleted, deadline, mergeSeenMissing>>
RefuseNonAncestor == /\ Stable /\ mode = "promote_write" /\ env.ref = 99
    /\ b' = J!Hold(b) /\ mode' = "save" /\ UNCHANGED <<env, saved, process, orphan, queued, restarts, privateOK,
        readHead, refs, moved, deleted, deadline, mergeSeenMissing>>
OtherResponse == /\ Stable /\ mode = "effect" /\ b.pending \in {"open_pr", "promote_pr", "complete_handoff", "void_readiness", "finish_pr"}
    /\ J!Completion /\ mode' = "save"
    /\ UNCHANGED <<saved, process, orphan, queued, restarts, privateOK,
        readHead, refs, moved, deleted, deadline, mergeSeenMissing>>

Crash == /\ Stable /\ ~Presentation /\ restarts < MaxRestarts /\ mode # "down" /\ mode # "missing"
    /\ b' = saved /\ mode' = "down" /\ restarts' = restarts + 1
    /\ orphan' = (process # 0) /\ queued' = 0
    /\ UNCHANGED <<env, saved, process, privateOK, readHead, refs, moved, deleted, deadline, mergeSeenMissing>>
LosePrivate == /\ Stable /\ ~Presentation /\ mode = "down" /\ privateOK
    /\ privateOK' = FALSE /\ UNCHANGED <<b, env, saved, mode, process, orphan, queued,
        restarts, readHead, refs, moved, deleted, deadline, mergeSeenMissing>>
RecoverStop == /\ Stable /\ mode = "down" /\ orphan /\ process' = 0 /\ orphan' = FALSE
    /\ UNCHANGED <<b, env, saved, mode, queued, restarts, privateOK,
        readHead, refs, moved, deleted, deadline, mergeSeenMissing>>
Recover == /\ Stable /\ mode = "down" /\ ~orphan /\ process = 0
    /\ mode' = (IF privateOK THEN "save" ELSE "missing")
    /\ b' = (IF privateOK /\ J!Active(saved) # 0 /\ saved.terminal = J!None
       THEN [saved EXCEPT !.pending = IF saved.accounts[J!Active(saved)].stage = "review" THEN "launch_review" ELSE "repair_build"]
       ELSE saved)
    /\ UNCHANGED <<env, saved, process, orphan, queued, restarts, privateOK,
        readHead, refs, moved, deleted, deadline, mergeSeenMissing>>
ObserveMissing == /\ Stable /\ mode = "missing" /\ env.pr = "merged" /\ ~mergeSeenMissing
    /\ mergeSeenMissing' = TRUE /\ UNCHANGED <<b, env, saved, mode, process, orphan, queued, restarts, privateOK,
        readHead, refs, moved, deleted, deadline>>

Expire == /\ Stable /\ \E g \in refs : deadline[g] = 1 /\ deadline' = [deadline EXCEPT ![g] = 2]
    /\ UNCHANGED <<b, env, saved, mode, process, orphan, queued, restarts, privateOK,
        readHead, refs, moved, deleted, mergeSeenMissing>>
MoveValidationRef == /\ Stable /\ ~Presentation /\ \E g \in refs : moved' = moved \cup {g}
    /\ UNCHANGED <<b, env, saved, mode, process, orphan, queued, restarts, privateOK,
        readHead, refs, deleted, deadline, mergeSeenMissing>>
Cleanup ==
    /\ Stable
    /\ \E g \in refs \ moved :
           /\ (g <= Len(saved.history) \/ saved.phase \in {"held", "terminal"} \/ saved.pending = "finish_pr")
           /\ (deadline[g] = 2 \/ (g <= Len(J!Generations(saved)) /\ J!Generations(saved)[g].ci))
           /\ refs' = refs \ {g} /\ deleted' = deleted \cup {g}
    /\ UNCHANGED <<b, env, saved, mode, process, orphan, queued, restarts, privateOK,
        readHead, moved, deadline, mergeSeenMissing>>
Environment == Stable /\ J!Environment /\ UNCHANGED Aux
Idle == /\ (mode = "missing" \/ b.phase \in {"waiting", "held", "terminal"} \/ ~env.enabled \/ ~env.capacity)
    /\ UNCHANGED vars
Next == Decide \/ ObserveTerminal \/ Persist \/ PublishValidation \/ Validate \/ LaunchProcess \/ LaunchResponse
    \/ ProcessSettles \/ Consume \/ StopProcess \/ StopResponse \/ OpenRemote \/ ReadPredecessor
    \/ WriteNonForce \/ RefuseNonAncestor \/ OtherResponse \/ Crash \/ LosePrivate \/ RecoverStop
    \/ Recover \/ ObserveMissing \/ Expire \/ MoveValidationRef \/ Cleanup \/ Environment \/ Idle
Spec == Init /\ [][Next]_vars /\ WF_controlVars(Persist) /\ WF_controlVars(OtherResponse)
    /\ WF_controlVars(RecoverStop) /\ WF_controlVars(Recover) /\ WF_controlVars(Decide) /\ WF_controlVars(ObserveTerminal)

TypeOK == J!TypeOK /\ mode \in {"ready", "save", "effect", "response", "promote_write", "down", "missing"}
    /\ focus \in 0..MaxGenerations /\ (CleanupPartition => Cardinality(refs) <= 1)
BookBounded == J!BookBounded
ReadyHasCertificate == J!ReadyHasCertificate
AllowanceWithinRemaining == J!AllowanceWithinRemaining
ExactBinding == J!ExactBinding
CertificateSound == J!CertificateSound
MergeAssuranceTruthful == J!MergeAssuranceTruthful
NoPostPrRepair == J!NoPostPrRepair
WaitingSlotFree == J!WaitingSlotFree
EffectHasDurableIntent == mode \in {"effect", "response", "promote_write"} => b = saved
OneExecution == J!OneExecution
OneSandbox == orphan => process # 0
ProcessHasAccount == process # 0 => process \in J!Indices(saved.accounts)
NoTerminalProcess == b.phase = "terminal" => process = 0 /\ J!Drained(b)
MissingGrantsNoWork == ~privateOK => mode \in {"down", "missing"}
CleanupOwnedOnly == deleted \cap moved = {}
DeadlineNeverReset == [][\A g \in 1..MaxGenerations : deadline'[g] >= deadline[g]]_vars
SavedUsageMonotonic == [][J!Usage(saved') >= J!Usage(saved)]_vars
SavedAttemptsMonotonic == [][Len(saved'.accounts) >= Len(saved.accounts)]_vars
SavedHistoryImmutable == [][SubSeq(saved'.history, 1, Len(saved.history)) = saved.history]_vars
ObservedMergeSettles == (b.terminal = "merged" /\ J!Drained(b) /\ process = 0 /\ mode # "down")
    ~> (b.phase = "terminal" \/ mode = "missing")
====
