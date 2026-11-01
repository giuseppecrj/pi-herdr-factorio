---- MODULE Journey ----
EXTENDS Naturals, Sequences, FiniteSets

CONSTANTS MaxGenerations, MaxRepairs, MaxRefreshes, MaxAttempts,
          ReviewQuota, RepairQuota, RunQuota, UsageClass, PriorUsage, Presentation, Profile, LateUnknown
VARIABLES b, env
vars == <<b, env>>

None == "none"
Max(a, c) == IF a > c THEN a ELSE c
Min(a, c) == IF a < c THEN a ELSE c
Indices(s) == 1..Len(s)
RECURSIVE Sum(_)
Sum(s) == IF Len(s) = 0 THEN 0 ELSE s[1] + Sum(Tail(s))
Usage(s) == PriorUsage + Sum([i \in Indices(s.accounts) |-> s.accounts[i].tokens])
Attempts(s, stage, round) == Cardinality({i \in Indices(s.accounts) :
    s.accounts[i].stage = stage /\ s.accounts[i].round = round})
Spent(s, stage, round) == Sum([i \in Indices(s.accounts) |->
    IF s.accounts[i].stage = stage /\ s.accounts[i].round = round
    THEN s.accounts[i].tokens ELSE 0])
Quota(stage) == IF stage = "review" THEN ReviewQuota ELSE RepairQuota
Drained(s) == \A i \in Indices(s.accounts) : s.accounts[i].known /\ s.accounts[i].settled
CanIssue(s, stage, round) == Drained(s) /\ Usage(s) < RunQuota
    /\ Spent(s, stage, round) < Quota(stage)
    /\ Attempts(s, stage, round) < MaxAttempts
Allowance(s, stage, round) == Max(0, Min(RunQuota - Usage(s), Quota(stage) - Spent(s, stage, round)))
Active(s) == IF \E i \in Indices(s.accounts) : ~s.accounts[i].settled
    THEN CHOOSE i \in Indices(s.accounts) : ~s.accounts[i].settled ELSE 0
Current(s) == Len(s.history) + 1
Generations(s) == Append(s.history, s.current)
Certified(s, head) == head \in Indices(Generations(s)) /\ Generations(s)[head].cert
CertificateFields(g, generation, execution, attempt) ==
    [generation |-> generation, execution |-> execution, attempt |-> attempt,
     source |-> g.base, workflow |-> 0, candidate |-> generation, patch |-> g.patch,
     ci |-> generation, gate |-> g.base, acceptance |-> 0, original |-> 0]
IncomingBinding(s, execution, mismatch) ==
    LET exact == CertificateFields(s.current, Current(s), execution, s.accounts[execution].attempt)
    IN IF mismatch = "exact" THEN exact ELSE [exact EXCEPT ![mismatch] = 99]
Gen(round, generation, base, expected) ==
    [round |-> round, generation |-> generation, base |-> base,
     original |-> 0, pin |-> 0, patch |-> round, expected |-> expected,
     cert |-> FALSE, certBinding |-> None, ci |-> FALSE]
InitialBook == [phase |-> "admit", earlyAttempt |-> 1, history |-> <<>>,
    current |-> Gen(0, 0, 0, 0), refreshes |-> 0, accounts |-> <<>>,
    active |-> 0, published |-> 0, promoted |-> 0, ready |-> FALSE,
    pending |-> None, terminal |-> None, mergedHead |-> 0, mergeSha |-> 0, assurance |-> None,
    launchAllowance |-> 0, issuedAtUsage |-> 0, issuedAtSpent |-> 0]
InitialEnv == [enabled |-> TRUE, capacity |-> TRUE, main |-> 0,
    pr |-> "none", ref |-> 0, head |-> 0, ordinary |-> 0, mergeHead |-> 0, mergeSha |-> 0]
Init == b = InitialBook /\ env = InitialEnv

Effect(s, kind) == [s EXCEPT !.pending = kind]
Hold(s) == [s EXCEPT !.phase = "held", !.ready = FALSE, !.pending = None]
Select(s, round, generation, refresh) ==
    [s EXCEPT !.history = Append(@, s.current),
     !.current = Gen(round, generation, env.main, IF s.published = 0 THEN 0 ELSE s.promoted),
     !.refreshes = @ + refresh, !.phase = "validate", !.pending = "validate", !.ready = FALSE]
Issue(s, stage, round) == LET id == Len(s.accounts) + 1 IN
    [s EXCEPT !.accounts = Append(@,
        [stage |-> stage, round |-> round, attempt |-> Attempts(s, stage, round) + 1,
         generation |-> Current(s), base |-> s.current.base, pin |-> 0,
         tokens |-> 0, known |-> TRUE, settled |-> FALSE, live |-> TRUE]),
     !.active = id, !.pending = IF stage = "review" THEN "launch_review" ELSE "repair_build",
     !.launchAllowance = Allowance(s, stage, round), !.issuedAtUsage = Usage(s),
     !.issuedAtSpent = Spent(s, stage, round)]
Account(s, id, tokens, known, settled) == [s EXCEPT
    !.accounts[id].tokens = Max(@, tokens), !.accounts[id].known = known,
    !.accounts[id].settled = settled, !.accounts[id].live = FALSE]
Finish(s, kind, head) == [s EXCEPT !.terminal = kind, !.mergedHead = head,
    !.mergeSha = IF kind = "merged" THEN env.mergeSha ELSE 0,
    !.assurance = IF kind = "merged" THEN IF Certified(s, head) THEN "factory_verified" ELSE "owner_override" ELSE None,
    !.pending = IF Active(s) = 0 THEN "finish_pr" ELSE "stop_execution",
    !.active = Active(s), !.phase = "finishing"]
FailOrRepair(s) == IF s.published # 0 THEN Hold(s)
    ELSE IF s.current.round = MaxRepairs THEN Finish(s, "failed", 0)
    ELSE [s EXCEPT !.phase = "repair_due", !.pending = None]

Early == /\ b.phase \in {"admit", "specify", "accept", "build"}
    /\ env.enabled /\ b.pending = None
    /\ b' = (CASE b.phase = "admit" -> [b EXCEPT !.phase = "specify"]
              [] b.phase = "specify" -> [b EXCEPT !.phase = "accept", !.earlyAttempt = 1]
              [] b.phase = "accept" -> [b EXCEPT !.phase = "build", !.earlyAttempt = 1]
              [] OTHER -> [b EXCEPT !.phase = "validate", !.pending = "validate", !.current.base = env.main])
    /\ UNCHANGED env
EarlyRetry == /\ ~Presentation /\ Profile = "combined" /\ b.phase \in {"specify", "accept", "build"} /\ b.earlyAttempt < 5
    /\ b' = [b EXCEPT !.earlyAttempt = @ + 1] /\ UNCHANGED env
ObserveMerge == /\ env.pr = "merged" /\ b.phase # "terminal" /\ b.terminal # "merged"
    /\ b' = Finish(b, "merged", env.mergeHead) /\ UNCHANGED env
ObserveClose == /\ env.pr = "closed" /\ b.phase # "terminal" /\ b.terminal = None
    /\ b' = Finish(b, "cancelled", 0) /\ UNCHANGED env
Refresh == /\ b.phase \notin {"admit", "specify", "accept", "build", "terminal"}
    /\ b.terminal = None /\ env.pr \notin {"merged", "closed"} /\ env.enabled
    /\ b.phase \notin {"repair_due", "repairing", "repair_built"}
    /\ env.main # b.current.base
    /\ b' = (IF Active(b) # 0 THEN [b EXCEPT !.pending = "stop_execution", !.active = Active(b), !.phase = "stopping"]
       ELSE IF ~CanIssue(b, "review", b.current.round) \/ b.refreshes >= MaxRefreshes
                  \/ Len(b.history) + 1 >= MaxGenerations \/ b.current.generation >= 3
                  \/ (b.published # 0 /\ (env.head # b.promoted \/ env.ref # b.promoted))
            THEN Hold(b) ELSE Select(b, b.current.round, b.current.generation + 1, 1))
    /\ UNCHANGED env
ReviewDue == /\ b.phase = "review_due" /\ b.pending = None /\ b.terminal = None
    /\ env.enabled /\ env.capacity /\ env.main = b.current.base /\ env.pr \notin {"merged", "closed"}
    /\ b' = (IF CanIssue(b, "review", b.current.round) THEN Issue(b, "review", b.current.round) ELSE Hold(b))
    /\ UNCHANGED env
RepairDue == /\ b.phase = "repair_due" /\ b.pending = None /\ env.enabled /\ env.capacity
    /\ b.terminal = None /\ b.published = 0
    /\ b' = (IF CanIssue(b, "build", b.current.round + 1) THEN Issue(b, "build", b.current.round + 1) ELSE Hold(b))
    /\ UNCHANGED env
RepairBuilt == /\ b.phase = "repair_built" /\ env.enabled /\ b.terminal = None
    /\ Len(b.history) + 1 < MaxGenerations
    /\ b' = Select(b, b.current.round + 1, 0, 0) /\ UNCHANGED env
Handoff == /\ b.phase \in {"handoff", "waiting", "held"} /\ b.pending = None /\ b.terminal = None
    /\ b.current.cert /\ env.enabled /\ env.main = b.current.base /\ env.pr \notin {"merged", "closed"}
    /\ b' = (IF b.published = 0 THEN Effect(b, "open_pr")
       ELSE IF env.head # env.ref THEN Hold(b)
       ELSE IF env.head # Current(b)
            THEN IF b.current.expected # 0 /\ env.head = b.current.expected
                 THEN Effect(b, "promote_pr") ELSE Hold(b)
       ELSE IF env.ordinary # Current(b) THEN Effect(Hold(b), "void_readiness")
       ELSE IF b.ready /\ b.promoted = Current(b) THEN [b EXCEPT !.phase = "waiting"]
       ELSE Effect(b, "complete_handoff"))
    /\ UNCHANGED env
Policy == Early \/ EarlyRetry \/ ObserveMerge \/ ObserveClose \/ Refresh \/ ReviewDue \/ RepairDue \/ RepairBuilt \/ Handoff

Validate == /\ b.pending = "validate" /\ b.terminal = None
    /\ \E outcome \in (IF Presentation \/ Profile = "late" THEN {"pass"} ELSE IF Profile = "transport" THEN {"pass", "fail"} ELSE {"pass", "fail", "missing"}) :
       b' = (CASE outcome = "pass" -> [b EXCEPT !.current.ci = TRUE, !.pending = None, !.phase = "review_due"]
             [] outcome = "fail" -> FailOrRepair([b EXCEPT !.pending = None])
             [] OTHER -> Hold(b))
    /\ UNCHANGED env
Launch == /\ b.pending \in {"launch_review", "repair_build"}
    /\ b' = [b EXCEPT !.pending = None, !.phase = IF b.pending = "launch_review" THEN "reviewing" ELSE "repairing",
        !.accounts[b.active].live = TRUE, !.accounts[b.active].settled = FALSE]
    /\ UNCHANGED env
LaunchUnavailable == /\ ~Presentation /\ Profile \in {"combined", "accounting"} /\ b.pending \in {"launch_review", "repair_build"}
    /\ b' = [Account(b, b.active, 0, TRUE, TRUE) EXCEPT !.pending = None,
        !.phase = IF b.pending = "launch_review" THEN "review_due" ELSE "repair_due", !.active = 0]
    /\ UNCHANGED env
ReviewResult(s, id, outcome, known, binding) == LET paid == Account(s, id, UsageClass, known, known) IN
    IF s.phase # "reviewing" \/ id # s.active \/ s.accounts[id].generation # Current(s)
    THEN paid
    ELSE IF ~known THEN Hold(paid)
    ELSE IF outcome = "pass" /\ binding = IncomingBinding(s, id, "exact")
         THEN [paid EXCEPT !.current.cert = TRUE, !.current.certBinding = binding, !.phase = "handoff", !.active = 0]
    ELSE IF outcome \in {"blocking", "pass"} THEN FailOrRepair([paid EXCEPT !.active = 0])
    ELSE IF s.published # 0 THEN Hold([paid EXCEPT !.active = 0])
    ELSE IF CanIssue(paid, "review", s.current.round)
         THEN [paid EXCEPT !.phase = "review_due", !.active = 0] ELSE Finish(paid, "failed", 0)
SettleReview == /\ b.phase = "reviewing" /\ b.pending = None /\ b.terminal = None
    /\ \E outcome \in (IF Presentation \/ Profile \in {"transport", "late"} THEN {"pass"} ELSE IF Profile = "structural" THEN {"pass", "failed"} ELSE {"pass", "blocking", "failed"}),
          known \in (IF Presentation \/ Profile \in {"structural", "late"} THEN {TRUE} ELSE BOOLEAN),
          mismatch \in (IF Profile \in {"accounting", "combined"} THEN
              {"exact", "generation", "execution", "attempt", "source", "workflow", "candidate", "patch", "ci", "gate", "acceptance", "original"}
              ELSE {"exact"}) : b' = ReviewResult(b, b.active, outcome, known, IncomingBinding(b, b.active, mismatch))
    /\ UNCHANGED env
SettleRepair == /\ b.phase = "repairing" /\ b.pending = None /\ b.terminal = None
    /\ \E known \in (IF Profile \in {"structural", "transport"} THEN {TRUE} ELSE BOOLEAN),
          passed \in (IF Profile \in {"structural", "transport"} THEN {TRUE} ELSE BOOLEAN) :
       LET paid == Account(b, b.active, UsageClass, known, known) IN
       b' = (IF ~known THEN Hold(paid) ELSE IF passed
            THEN [paid EXCEPT !.phase = "repair_built", !.active = 0]
            ELSE IF CanIssue(paid, "build", b.current.round + 1)
                 THEN [paid EXCEPT !.phase = "repair_due", !.active = 0] ELSE Finish(paid, "failed", 0))
    /\ UNCHANGED env
LateResult == /\ ~Presentation /\ Profile \in {"combined", "accounting", "late"}
    /\ \E id \in Indices(b.accounts), known \in (IF LateUnknown THEN BOOLEAN ELSE {TRUE}) :
       /\ (id # b.active \/ b.phase \notin {"reviewing", "repairing"})
       /\ b' = Account(b, id, IF known THEN UsageClass ELSE b.accounts[id].tokens, known, known)
    /\ UNCHANGED env
Stop == /\ b.pending = "stop_execution"
    /\ \E known \in (IF Presentation \/ Profile = "structural" THEN {TRUE} ELSE BOOLEAN) :
       LET paid == Account(b, b.active, UsageClass, known, known) IN
       b' = (IF ~known THEN paid ELSE [paid EXCEPT !.active = 0,
            !.pending = IF b.terminal = None THEN None ELSE "finish_pr",
            !.phase = IF b.terminal = None THEN "handoff" ELSE "finishing"])
    /\ UNCHANGED env
Open == /\ b.pending = "open_pr" /\ env.pr = "open"
    /\ b' = [b EXCEPT !.published = 1, !.promoted = Current(b), !.pending = None, !.phase = "handoff"]
    /\ UNCHANGED env
Promote == /\ b.pending = "promote_pr" /\ env.ref = Current(b)
    /\ b' = (IF env.head = Current(b) THEN [b EXCEPT !.pending = None, !.phase = "handoff"] ELSE Hold(b))
    /\ UNCHANGED env
CompleteHandoff == /\ b.pending = "complete_handoff"
    /\ b' = [b EXCEPT !.pending = None, !.phase = "waiting", !.ready = TRUE, !.promoted = Current(b)]
    /\ UNCHANGED env
Void == /\ b.pending = "void_readiness" /\ b' = Hold(b) /\ UNCHANGED env
FinishPr == /\ b.pending = "finish_pr"
    /\ b' = [b EXCEPT !.pending = None, !.phase = "terminal"] /\ UNCHANGED env
Completion == Validate \/ Launch \/ LaunchUnavailable \/ Stop \/ Open \/ Promote \/ CompleteHandoff \/ Void \/ FinishPr
Callback == SettleReview \/ SettleRepair \/ LateResult

RemoteOpen == /\ b.pending = "open_pr" /\ env.enabled /\ env.pr = "none"
    /\ env' = [env EXCEPT !.pr = "open", !.ref = Current(b), !.head = Current(b)] /\ UNCHANGED b
RemotePromote == /\ b.pending = "promote_pr" /\ env.enabled /\ env.pr = "open"
    /\ env.ref = b.current.expected
    /\ env' = [env EXCEPT !.ref = Current(b), !.ordinary = 0] /\ UNCHANGED b
HeadConverges == /\ env.pr = "open" /\ env.head # env.ref
    /\ env' = [env EXCEPT !.head = env.ref] /\ UNCHANGED b
OrdinaryPass == /\ env.pr = "open" /\ env.head = env.ref /\ env.ordinary # env.head
    /\ env' = [env EXCEPT !.ordinary = env.head] /\ UNCHANGED b
MainMoves == /\ ~Presentation /\ Profile \in {"combined", "structural", "transport", "late"}
    /\ b.phase \notin {"admit", "specify", "accept", "build", "terminal"}
    /\ (Profile # "structural" \/ b.phase \in {"validate", "review_due", "waiting", "stopping"})
    /\ env.main <= MaxRefreshes
    /\ env' = [env EXCEPT !.main = @ + 1] /\ UNCHANGED b
Switch == /\ ~Presentation /\ Profile \in {"combined", "transport"} /\ env' = [env EXCEPT !.enabled = ~@] /\ UNCHANGED b
Capacity == /\ ~Presentation /\ Profile = "combined" /\ env' = [env EXCEPT !.capacity = ~@] /\ UNCHANGED b
OwnerHead == /\ ~Presentation /\ Profile \in {"combined", "transport"} /\ env.pr = "open" /\ env.ref # 99
    /\ env' = [env EXCEPT !.ref = 99, !.ordinary = 0] /\ UNCHANGED b
OwnerMerge == /\ env.pr = "open"
    /\ env' = [env EXCEPT !.pr = "merged", !.mergeHead = env.head, !.mergeSha = 100 + env.head] /\ UNCHANGED b
OwnerClose == /\ ~Presentation /\ Profile \in {"combined", "transport"} /\ env.pr = "open"
    /\ env' = [env EXCEPT !.pr = "closed"] /\ UNCHANGED b
Environment == MainMoves \/ Switch \/ Capacity \/ OwnerHead \/ OwnerMerge \/ OwnerClose \/ HeadConverges \/ OrdinaryPass
Remote == RemoteOpen \/ RemotePromote
Idle == /\ (b.phase \in {"waiting", "held", "terminal"} \/ ~env.enabled \/ ~env.capacity)
    /\ UNCHANGED vars
Next == Policy \/ Completion \/ Callback \/ Remote \/ Environment \/ Idle
Spec == Init /\ [][Next]_vars

TypeOK == /\ b.phase \in {"admit", "specify", "accept", "build", "validate", "review_due", "reviewing",
                           "repair_due", "repairing", "repair_built", "handoff", "waiting", "held", "stopping", "finishing", "terminal"}
    /\ b.pending \in {None, "validate", "launch_review", "repair_build", "stop_execution", "open_pr",
                       "promote_pr", "complete_handoff", "void_readiness", "finish_pr"}
    /\ env.pr \in {"none", "open", "closed", "merged"}
    /\ b.active \in 0..Len(b.accounts) /\ b.promoted \in 0..MaxGenerations /\ b.published \in {0, 1}
    /\ env.main \in 0..(MaxRefreshes + 1) /\ env.head \in (0..MaxGenerations) \cup {99}
    /\ env.ref \in (0..MaxGenerations) \cup {99}
    /\ \A i \in Indices(b.accounts) :
           /\ b.accounts[i].stage \in {"review", "build"}
           /\ b.accounts[i].known \in BOOLEAN /\ b.accounts[i].settled \in BOOLEAN /\ b.accounts[i].live \in BOOLEAN
           /\ b.accounts[i].tokens \in 0..UsageClass
BookBounded == Len(b.history) + 1 <= MaxGenerations /\ b.current.round <= MaxRepairs
    /\ b.refreshes <= MaxRefreshes /\ b.current.generation \in 0..3
    /\ \A stage \in {"review", "build"}, round \in 0..MaxRepairs : Attempts(b, stage, round) <= MaxAttempts
ExactBinding == \A i \in Indices(b.accounts) : LET a == b.accounts[i] IN
    a.pin = 0 /\ a.base = Generations(b)[a.generation].base /\ a.attempt <= MaxAttempts
ReviewOnlyValidated == b.phase = "reviewing" => b.current.ci
CertificateSound == \A g \in Indices(Generations(b)) : (Generations(b)[g].cert =>
    (Generations(b)[g].ci /\ \E i \in Indices(b.accounts) :
        b.accounts[i].stage = "review" /\ b.accounts[i].generation = g
        /\ Generations(b)[g].certBinding = CertificateFields(Generations(b)[g], g, i, b.accounts[i].attempt)))
ReadyHasCertificate == b.ready => Certified(b, b.promoted)
MergeAssuranceTruthful == b.terminal = "merged" =>
    /\ b.mergeSha = 100 + b.mergedHead
    /\ (b.assurance = "factory_verified" <=> Certified(b, b.mergedHead))
NoLiveTerminal == b.phase = "terminal" => (\A i \in Indices(b.accounts) : ~b.accounts[i].live)
FinishOnlyAfterSettlement == [][(b.pending = "stop_execution" /\ b'.pending = "finish_pr") => Drained(b')]_vars
NoPostPrRepair == b.published # 0 => b.phase \notin {"repair_due", "repairing", "repair_built"}
OneExecution == Cardinality({i \in Indices(b.accounts) : b.accounts[i].live}) <= 1
WaitingSlotFree == b.phase = "waiting" =>
    (\A i \in Indices(b.accounts) : ~b.accounts[i].live) /\ b.pending = None
AllowanceWithinRemaining == b.launchAllowance > 0 =>
    /\ b.launchAllowance + b.issuedAtUsage <= RunQuota
    /\ b.launchAllowance + b.issuedAtSpent <= Quota(b.accounts[Len(b.accounts)].stage)
NoFreshBudget == Usage(b) >= PriorUsage
CertificationNeedsKnownSettlement == [][(~b.current.cert /\ b'.current.cert /\ Current(b') = Current(b)) =>
    (b'.accounts[b'.current.certBinding.execution].known /\ b'.accounts[b'.current.certBinding.execution].settled)]_vars
HistoryImmutable == [][SubSeq(b'.history, 1, Len(b.history)) = b.history]_vars
UsageMonotonic == [][Usage(b') >= Usage(b)]_vars
IssuedMonotonic == [][Len(b'.accounts) >= Len(b.accounts)]_vars
HandoffDecisionExact == [][(b'.pending = "complete_handoff" /\ b.pending # "complete_handoff") =>
    (b.current.cert /\ env.head = Current(b) /\ env.ref = Current(b) /\ env.ordinary = Current(b))]_vars
PromotionDecisionExact == [][(b'.pending = "promote_pr" /\ b.pending # "promote_pr") =>
    (b.current.cert /\ b.current.expected # 0 /\ env.head = b.current.expected /\ env.ref = b.current.expected)]_vars
====
