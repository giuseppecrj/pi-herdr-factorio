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
| L06 | #754 | `src/policy.ts` | `src/trust/policy.ts` | The whole file |
| L06 | #754 | `src/platform.ts` | `src/trust/platform.ts` | The whole file |
| L06 | #754 | `src/admission.ts` | `src/trust/admission.ts` | The whole file |
| L06 | #754 | `src/markers.ts` | `src/trust/markers.ts` | The whole file |
| L06 | #754 | `src/adapters/github.ts` | `src/github/adapter.ts` | The whole file |
| L06 | #754 | `src/gh.ts` | `src/github/exec.ts` | The whole file |
| L06 | #754 | `src/tickets.ts` | `src/github/tickets.ts` | The whole file |
| L06 | #754 | `src/accept.ts` | `src/contract/acceptance.ts` | The whole file |
| L06 | #754 | `src/artifacts.ts` | `src/contract/artifacts.ts` | The whole file |
| L06 | #754 | `src/build.ts` | `src/candidate/build.ts` | The whole file |
| L06 | #754 | `src/review.ts` | `src/candidate/review.ts` | The whole file |
| L06 | #754 | `src/validation.ts` | `src/candidate/validation.ts` | The whole file |
| L06 | #754 | `src/feedback.ts` | `src/candidate/feedback.ts` | The whole file |
| L06 | #754 | `src/diagnosis.ts` | `src/candidate/diagnosis.ts` | The whole file |
| L06 | #754 | `src/stages.ts` | `src/candidate/stages.ts` | The whole file |
| L06 | #754 | `src/feed.ts` | `src/views/feed.ts` | The whole file |
| L06 | #754 | `src/attention.ts` | `src/views/attention.ts` | The whole file |
| L06 | #754 | `src/explain.ts` | `src/views/explain.ts` | The whole file |
| L06 | #754 | `src/metrics.ts` | `src/views/metrics.ts` | The whole file |
| L06 | #754 | `src/cadence.ts` | `src/maintenance/cadence.ts` | The whole file |
| L06 | #754 | `src/replay.ts` | `src/maintenance/replay.ts` | The whole file |
| L06 | #754 | `src/scorers.ts` | `src/maintenance/scorers.ts` | The whole file |
| L09 | #755 | `src/ledger.ts` | `src/ledger/schema.ts` | Split: the codecs, `LedgerRowError`, gap codes, run context and run start (`legacyRunContext`, `contextPolicy`, `parseRunStart`, `AUTONOMY_DIGEST`), provenance (`provenanceOf`), failure classes and budget caps, row versions 1 to 5 (`ledgerRow`, `ledgerRowOf`, `frozenRowOf`, `parseLedger`, `indexLedger`, `ledgerEfficiency`, `ledgerModelOf`), score events (`scoreEventOf`, `parseScores`, `indexScores`, `latestScores`) and attempt ends (`parseAttemptEnd`) |
| L09 | #755 | `src/ledger.ts` | `src/ledger/git.ts` | `LedgerApi` and `ledgerApiOf` |
| L09 | #755 | `src/ledger.ts` | `src/ledger/append.ts` | `LedgerAnchor`, `parseAnchor`, `PendingRow`, `AppendResult`, `AdoptionCursor`, `parseAdoption` and `appendRun` |
| L09 | #755 | `src/ledger.ts` | `src/ledger/terminal.ts` | `TerminalCause`, `TerminalFacts`, `TerminalEvidence`, `candidateCause`, `terminalFailureOf`, `terminalSnapshot` and `RunAccounting` |
| L09 | #755 | `src/ledger.ts` | `src/ledger/outbox.ts` | `MarkerProof`, `LedgerRetry`, `OutboxJob`, `PublishedReceipt`, `LedgerOutbox`, `LedgerBacklog`, `pumpLedger` and `parseRetry` |
| L09 | #755 | `src/publication.ts` | `src/github/publish.ts` | The whole file except the ledger Git operations. The private `commit` and `tree` helpers are now exported as `createCommit` and `createTree`, with `shaOf` |
| L09 | #755 | `src/publication.ts` | `src/ledger/git.ts` | `LEDGER_FILE`, `SCORE_FILE`, `LedgerAdvance`, `LedgerCommit`, `LedgerFile`, `createLedgerRoot`, `createLedgerChild`, `readLedgerCommit` and `readLedgerFile`. The methods `GitHubPublicationApi.ledgerRef()` and `.advanceLedger(from, next)` became the functions `ledgerRef(api)` and `advanceLedger(api, from, next)` |

L00 moves no files.
