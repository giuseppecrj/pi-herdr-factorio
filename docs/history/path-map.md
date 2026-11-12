# Path map

Every file that the layout program in `docs/plans/codebase-layout.md` moves, renames or splits gets one row here, in the PR that moves it. Use this map to read a historical document, decision row or acceptance suite that names an old path.

Each row is bound to the pull request that made the move. Its squash commit on `main` is the revision: the old path is valid at that commit's parent, and the new path is valid at the commit itself. Branch commits are rewritten by rebases and squash merges, so rows never cite them. Write a line citation to an old path as `<sha>:path:line`, so the citation check validates its form instead of looking for the file at HEAD.

| Plan PR | Pull request | Old path | New path | Symbols that moved |
| --- | --- | --- | --- | --- |
| L02 | #748 | `docs/prototypes/acceptance-isolation/probe.ts` | `.pi/skills/verify-factory/probes/acceptance-isolation/probe.ts` | The whole file |
| L02 | #748 | `docs/prototypes/acceptance-isolation/self-test.mjs` | `.pi/skills/verify-factory/probes/acceptance-isolation/self-test.mjs` | The whole file |
| L02 | #748 | `docs/prototypes/build-isolation/probe.ts` | `.pi/skills/verify-factory/probes/build-isolation/probe.ts` | The whole file |
| L02 | #748 | `docs/prototypes/build-isolation/self-test.mjs` | `.pi/skills/verify-factory/probes/build-isolation/self-test.mjs` | The whole file |
| L02 | #748 | `docs/prototypes/heldout-ci/repair-probe.ts` | `.pi/skills/verify-factory/probes/heldout-ci/repair-probe.ts` | The whole file |
| L02 | #748 | `.pi/skills/verify-factory/scripts/drive-replay.sh` | `.pi/skills/verify-factory/scripts/drive-replay.ts` | Not a rename: `drive-replay.sh` stays the driver, and its eleven inline node programs became `drive-replay.ts` subcommands `owned`, `visible-limit`, `production-free`, `settle`, `recovery-command`, `restore-fields`, `fixture-disarmed`, `fixture-ready`, `journal`, `preflight` and `prepare` |
| L03 | #749 | `src/run.ts` | `src/core/run.ts` | The whole file |
| L03 | #749 | `server/sandbox/json.ts` | `src/core/json.ts` | The whole file, plus `JsonValue` from `src/tickets.ts` |
| L03 | #749 | `server/sandbox/anthropic-limits.ts` | `src/core/models.ts` | The whole file, plus `FamilyInput`, `R8`, `CertificationFamilies`, `FAMILY_MISSING`, `familyOf`, `crossFamily`, `certifyR8`, `familyLabel`, `withFamily`, `parseFamily` and `familyFromJournal` from `src/review.ts` |
| L03 | #749 | `server/sandbox/audit.ts` | `src/core/journal.ts` | Split: `RequestBound`, `RequestUsage`, `RequestReply`, `RequestSettlement`, `settlementReply`, `requestSettlements`, `JournalCharge` and `journalCharge` moved; the audit writer stays |
| L03 | #749 | `server/sandbox/result.ts` | `src/core/execution.ts` | Split: `EFFICIENCY_COUNTS`, `EfficiencyFacts`, `GuardStop`, `unknownEfficiency`, `parseEfficiency`, `requestEfficiency`, `aggregateEfficiency`, `ExecutionUsage`, `executionUsageOf`, `StageRunSettings`, `FailedExit`, `BudgetCap`, `RefusalSignal`, `Settlement`, `SessionOutcome` and `StageUsage` moved; `StageReceipt`, `StageResult`, `stageResult` and the receipt records stay |
| L04 | #752 | `src/policy.ts` | `src/trust/protected-paths.ts` | Split: `CONTROL_PLANE_DIR`, `ACCEPTANCE_SUITE_DIR` and `isAtOrUnder` moved; feedback names and directory prefixes now share those definitions. Callers retain their own policy |
| L04 | #752 | `src/core/run.ts`, `src/stages.ts`, `src/workflow.ts` | `src/core/stages.ts` | Split: `Stage`, `SandboxStage`, `STAGE_ORDER`, `MODEL_STAGES`, `ModelStage` and `ExecutionStage` moved; transition policy and access profiles stay in `src/stages.ts` |
| L04 | #752 | `src/markers.ts`, `src/workflow.ts`, `src/orchestrator.ts` | `src/core/stages.ts` | `isStage` and `isModelStage` now use the shared vocabulary. Ledger, attention, controller and viewer stage lists derive from it |
| L05 | #753 | `server/controller.ts` | `server/controller/state.ts` | Split: `HOLDER_FILE`, `STATUS_FILE`, `LockHolder`, `SocketLockState`, `lockName`, `errorCode`, `readHolderFile`, `holderOf`, `readLock`, `readStoredVerdict` and `readStatus` moved; `acquireLock`, `ControllerLock` and `writeStatus` stay and import the lock-file helpers |
| L05 | #753 | `server/sandbox.ts` | `server/sandbox/receipts.ts` | Split: `MAX_RECEIPT_BYTES`, `boundedText` and `readStageReceipt` moved |
| L05 | #753 | `src/feed.ts` | `server/cli/owner-feed.ts` | `readOwnerFeed`, `readOwnerRun` and `readOwnerHeader` moved and now read the controller state and receipts. The projection stays in `src/feed.ts` as `ownerFeed`, `ownerRun` and `ownerHeader`, which take that evidence as arguments |
| L05 | #753 | `src/explain.ts` | `server/cli/measurement.ts` | `measurementInput` moved and binds the receipt reader. The allowlist stays in `src/explain.ts` as `measurementInputOf`, which takes the reader as an argument |
| L05 | #753 | `src/replay.ts` | `server/cli/replay.ts` | `checkReplayBundles` moved |
| L05 | #753 | `server/sandbox/result.ts` | `src/orchestrator.ts` | `StageResult` is now declared in `src/orchestrator.ts` with the receipt fields a launch reports; the host's `StageResult` and `StageReceipt` stay and are assignable to it |

L00 moves no files.
