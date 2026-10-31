---- MODULE Journey ----
\* A ticket's run through the v1 stages, as src/stages.ts `advance` decides,
\* plus the PR review loop the design and plan (F09a, F10) add on top.
EXTENDS Naturals

CONSTANTS MaxRepairs

VARIABLES phase, repairs, builds, patch, verdictFor, verdictPass, prOpen, merged

vars == <<phase, repairs, builds, patch, verdictFor, verdictPass, prOpen, merged>>

Active == {"admit", "specify", "accept", "build", "publishing", "awaiting_ci", "verdict", "review", "land"}
Finished == {"landed", "needs_info", "rejected", "failed", "budget", "cancelled"}

Init ==
    /\ phase = "admit"
    /\ repairs = 0
    /\ builds = 0
    /\ patch = 0
    /\ verdictFor = 0
    /\ verdictPass = FALSE
    /\ prOpen = FALSE
    /\ merged = FALSE

\* repairOrFail + STALE_ON_REBUILD in src/stages.ts
RepairOrFail ==
    IF repairs >= MaxRepairs
    THEN /\ phase' = "failed"
         /\ UNCHANGED <<repairs, builds, patch, verdictFor, verdictPass, prOpen, merged>>
    ELSE /\ phase' = "build"
         /\ repairs' = repairs + 1
         /\ patch' = 0
         /\ verdictFor' = 0
         /\ verdictPass' = FALSE
         /\ UNCHANGED <<builds, prOpen, merged>>

\* checkLandPrecondition in src/policy.ts
LandOK == patch # 0 /\ verdictFor = patch /\ verdictPass

Admitted ==
    /\ phase = "admit" /\ phase' = "specify"
    /\ UNCHANGED <<repairs, builds, patch, verdictFor, verdictPass, prOpen, merged>>

Specified ==
    /\ phase = "specify" /\ phase' = "accept"
    /\ UNCHANGED <<repairs, builds, patch, verdictFor, verdictPass, prOpen, merged>>

TooVague ==
    /\ phase = "specify" /\ phase' = "needs_info"
    /\ UNCHANGED <<repairs, builds, patch, verdictFor, verdictPass, prOpen, merged>>

Accepted ==
    /\ phase = "accept" /\ phase' = "build"
    /\ UNCHANGED <<repairs, builds, patch, verdictFor, verdictPass, prOpen, merged>>

Built ==
    /\ phase = "build" /\ phase' = "publishing"
    /\ builds' = builds + 1
    /\ patch' = builds + 1
    /\ UNCHANGED <<repairs, verdictFor, verdictPass, prOpen, merged>>

Published ==
    /\ phase = "publishing" /\ phase' = "awaiting_ci"
    /\ UNCHANGED <<repairs, builds, patch, verdictFor, verdictPass, prOpen, merged>>

ChecksPass ==
    /\ phase = "awaiting_ci" /\ phase' = "verdict"
    /\ verdictFor' = patch /\ verdictPass' = TRUE
    /\ UNCHANGED <<repairs, builds, patch, prOpen, merged>>

VerdictStored ==
    /\ phase = "verdict" /\ LandOK /\ phase' = "review"
    /\ UNCHANGED <<repairs, builds, patch, verdictFor, verdictPass, prOpen, merged>>

ChecksFail == phase = "awaiting_ci" /\ RepairOrFail

ReviewClean ==
    /\ phase = "review" /\ phase' = "land"
    /\ prOpen' = TRUE
    /\ UNCHANGED <<repairs, builds, patch, verdictFor, verdictPass, merged>>

ReviewBlocks == phase = "review" /\ RepairOrFail

\* Planned in F10: owner feedback starts a repair round under the shared cap.
YouComment == phase = "land" /\ ~merged /\ RepairOrFail

\* The owner merges on GitHub. advance() accepts `landed` only during land;
\* in any other stage it returns `invalid` and the run does not change.
YouMerge ==
    /\ prOpen /\ ~merged /\ phase \in Active
    /\ merged' = TRUE
    /\ phase' = IF phase = "land" /\ LandOK THEN "landed" ELSE phase
    /\ UNCHANGED <<repairs, builds, patch, verdictFor, verdictPass, prOpen>>

YouClosePR ==
    /\ prOpen /\ ~merged /\ phase \in Active
    /\ phase' = "cancelled" /\ prOpen' = FALSE
    /\ UNCHANGED <<repairs, builds, patch, verdictFor, verdictPass, merged>>

InRun == Active \ {"admit"}

Unchanged6 == UNCHANGED <<repairs, builds, patch, verdictFor, verdictPass, prOpen, merged>>

AdmitRefuses == phase = "admit" /\ phase' = "rejected" /\ Unchanged6
StageFails == phase \in InRun /\ phase' = "failed" /\ Unchanged6
BudgetSpent == phase \in InRun /\ phase' = "budget" /\ Unchanged6
PolicyStops == phase \in InRun /\ phase' = "rejected" /\ Unchanged6
LabelRemoved == phase \in InRun /\ phase' = "cancelled" /\ Unchanged6

Done == phase \in Finished /\ UNCHANGED vars

Next ==
    \/ Admitted \/ AdmitRefuses \/ Specified \/ TooVague \/ Accepted \/ Built
    \/ Published \/ ChecksPass \/ ChecksFail \/ VerdictStored \/ ReviewClean \/ ReviewBlocks
    \/ YouComment \/ YouMerge \/ YouClosePR
    \/ StageFails \/ BudgetSpent \/ PolicyStops \/ LabelRemoved
    \/ Done

Spec == Init /\ [][Next]_vars

\* Nothing is recorded as landed unless every check passed on that exact patch.
LandOnlyVerified == phase = "landed" => LandOK
\* A ticket never gets more than two repair rounds, reviewer and owner rounds included.
RepairCap == repairs <= MaxRepairs
\* Review and human review only ever see a patch whose checks passed.
ReviewOnlyVerified == phase \in {"review", "land"} => LandOK
\* Once you merge the PR, the run ends as landed.
MergeEndsRun == merged => phase = "landed"
====
