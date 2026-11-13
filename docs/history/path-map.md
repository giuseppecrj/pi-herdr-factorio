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
| L07 | #757 | `src/handoff.ts` | `src/candidate/state.ts` | Split: `MAX_REFRESHES`, `MAX_GENERATIONS`, `MAX_REPAIR_ROUNDS`, `MAX_REVIEW_ATTEMPTS`, the stored book's types from `RepairRound` to `CandidateState` (except `PrObservation`), `reviewReceiptDigest`, `freeze`, `snapshot`, `refOf`, `sameGeneration`, `generationIntent`, `ownerPatchValid` and `validPatch` moved |
| L07 | #757 | `src/handoff.ts` | `src/candidate/codec.ts` | Split: every `wire*` decoder, `migrateReview`, `parseReviewReceipt`, `migrateCertificationValue`, `migrateEvidenceValue`, `parseOwnerPatchReceipt` and `parseCandidateState` moved |
| L07 | #757 | `src/handoff.ts` | `src/candidate/handoff.ts` | Split: the policy moved. `PrObservation`, `CandidateEffectResult`, `CandidateEvent`, `CandidateStep`, `CandidateProjection`, `candidateProjection`, `beginCandidate`, `handoffCandidate` and its helpers, the accounting and certification functions, `Limitation`, `notProven` and `renderLimitation` |
| L08 | #756 | `src/workflow.ts` | `src/config/schema.ts` | Configuration types, defaults, identity guards, credential redaction and load result types |
| L08 | #756 | `src/workflow.ts` | `src/config/parse.ts` | `parseWorkflow`, YAML validation and Markdown guidance parsing |
| L08 | #756 | `src/workflow.ts` | `src/config/load.ts` | `loadWorkflow`, `loadPinnedWorkflow`, `reloadWorkflow`, `trustedWorkflowConfig` and the main-only cache |
| L08 | #756 | `src/workflow.ts` | `src/config/views.ts` | `loadView`, `configView`, `modelsOf`, `seatModelsOf`, `checkReport`, `statusReport` and their view types |
| L08 | #756 | `src/specify.ts` | `src/contract/contract.ts` | Contract, question, answer and source-input types, limits, digest guards, canonical bytes and digests, `answerBody` |
| L08 | #756 | `src/specify.ts` | `src/contract/parse.ts` | `parseSpecifyOutput`, `parseReviewOutput`, `hasControl`, `lineOf`, `isRepoPath` and private JSON validation |
| L08 | #756 | `src/specify.ts` | `src/contract/render.ts` | Inert comment text, keys and key readers, question, contract, acceptance and build summaries |
| L08 | #756 | `src/specify.ts` | `src/contract/prompt.ts` | Specify tools and skills, source selection, excerpts, source facts, tree and named files, nonce framing and specify, review and revision prompts |
| L08 | #756 | `src/candidate/diagnosis.ts` | `src/contract/acceptance.ts` | `AcceptanceBinding` and `parseAcceptanceBinding`; base and candidate policy stay in diagnosis |
| L11 | #758 | `server/controller.ts` | `server/controller/lock.ts` | `LockAcquire`, `ProcessTable`, `parseStartTime`, `procTable`, `ControllerLock` and `acquireLock` |
| L11 | #758 | `server/controller.ts` | `server/controller/checkout.ts` | `TarballFetch`, `ghTarball`, `TarEntry`, `TarRead`, `readTarball`, `checkoutOf`, `checkoutWorkspace`, `checkoutTree` and `checkoutBuildWorkspace` |
| L11 | #758 | `server/controller.ts` | `server/controller/checkers.ts` | `controllerDraftChecker`, `controllerBaseChecker`, `DiagnosisFacts`, `DiagnosisRequest`, `storedBaseReceipt` and `controllerDiagnosis` |
| L11 | #758 | `server/controller.ts` | `server/controller/run-files.ts` | `parseAnswers`, `fileRunFiles` and their answer/link parsers |
| L11 | #758 | `server/controller.ts` | `server/controller/state.ts` | Private file writes, claim parsing, `fileRunAccounting`, `VERIFICATION_FILE`, `VerificationPin`, `pinVerification`, `writeStatus` and stored assessment helpers. Combined with L05's existing read-only state reader |
| L11 | #758 | `server/controller.ts` | `server/controller/outbox.ts` | `fileLedgerOutbox`, `readLedgerBacklog`, `pumpLedgerOutbox` and ledger timestamp validation |
| L11 | #758 | `server/controller.ts` | `server/controller/terminal.ts` | `readTerminalEvidence`, `readRunCharges`, `readDurableAccounting`, `durableUsageOf` and `startDurableUsage` |
| L11 | #758 | `server/controller.ts` | `server/controller/measurement.ts` | `SCORE_PUBLISH_SLICE_MS`, `pumpScoreOutbox`, `controllerMeasure`, `controllerMeasurements`, `measurementCharges` and their score publication helpers |
| L11 | #758 | `server/controller.ts` | `server/controller/cadence.ts` | `runImprovementTrigger`, `publishCadenceProposals`, `controllerCadence` and their switch/proposal helpers |
| L11 | #758 | `server/controller.ts` | `server/controller/validation-sweep.ts` | `controllerValidator`, `ownerValidator`, `controllerReport`, `sweepValidation`, `GateReceiptSource`, `downloadGateReceipt` and publication cleanup |
| L11 | #758 | `server/controller.ts` | `server/controller/candidate-port.ts` | `WORKFLOW_READ_LIMIT`, `controllerCandidatePort`, `storeFeedbackBatch`, `observeFeedback`, `sweepMergedFeedback` and their feedback persistence/notice helpers |
| L11 | #758 | `server/controller.ts` | `server/controller/serve-loop.ts` | `logLine`, `lineLog`, `Sleep`, `systemdNotify`, `startMetricSnapshots` and `serveLoop` |
| L10 | #759 | `src/orchestrator.ts` | `src/controller/orchestrator.ts` | Split: `Orchestrator` and its tick, slots, adoption, admission, launch, stage ends, effects, base check, recovery and terminal enrollment methods, `OrchestratorInput`, `checkIdentity`, `backoffMs`, `limitsOf`, `holdsSlot`, `holdsSlotAs`, `Clock`, `Log`, `LogFields`, `Limits`, `ControllerState`, `GateReason`, `RunView`, `TickReport` and the report helpers stay |
| L10 | #759 | `src/orchestrator.ts` | `src/controller/claims.ts` | Split: `ClaimRecord`, `ConfirmedRecord`, `EndedRecord`, `RunFiles`, `LinkRead`, `ActiveRun`, `RunPhase`, `RetryCause`, `RunningPhase`, `InflightMarker`, `CleanLedger`, `Unverified`, `ClaimObservation`, `ReleaseReason`, `claimProjection`, `desiredStatus`, `FIRST_STAGE`, `claimOf`, `recordOf`, `markerOf`, `matchesRecord`. The methods `#writeClaim`, `#writeEnded`, `#localMarker`, `#admittedFields` and `#unadmitted` became functions of the same names taking the controller input first |
| L10 | #759 | `src/orchestrator.ts` | `src/controller/admission.ts` | Split: `SeenIssue`, `SETTLE_MS`, `settled`, `isReady`, `refusalSettlesUntilEdited`, `ambiguityRecursOnReread` and the clarification predicates. The methods `#unmarkedEvents`, `#answerHistory` and `#link` became `unmarkedEvents`, `answerHistory` and `linkRun` |
| L10 | #759 | `src/orchestrator.ts` | `src/controller/launch.ts` | Split: `StageExecutor`, `StageResult`, `StageLaunch`, `StageLaunchInput`, `StageOutput`, `StageEnd`, `ReviewPreparation`, `Checkout`, `CheckoutResult`, `StageInputs`, `Prepared`, `UNPREPARED`, `WorkspacePreparation`. The methods `#prepareWorkspace` and `#stageInputs` became functions |
| L10 | #759 | `src/orchestrator.ts` | `src/controller/effects.ts` | Split: `Effects`. The methods `#hasKeyed`, `#postKeyed`, `#specified` and `#accepted` became functions |
| L10 | #759 | `src/orchestrator.ts` | `src/controller/accounting.ts` | Split: `Totals`, `Draining`, `Unsettled`, `SANDBOX_CAPS`, `END_STATUS`, `budgetCause`, `preparedCause`, `inputCause`. The methods `#countLateUsage`, `#reconcileSpent`, `#accountAdopted`, `#countReleased`, `#attemptSpent`, `#recordAttempt`, `#acceptSpent` and `#saveAttempt` became functions |
| L10 | #759 | `src/orchestrator.ts` | `src/controller/base-check.ts` | Split: the methods `#acceptanceReceipt`, `#retireRefused`, `#retrySuite`, `#retryFeedback` and `#postRetriedRefusal` became functions |
| L10 | #759 | `src/orchestrator.ts` | `src/controller/recovery.ts` | Split: the methods `#queueReviewRefusal` and `#recoverCandidate` became functions; `CandidateResult` names the queued result type `#candidateResults` had inline |
| L12 | #760 | `server/sandbox.ts` | `server/sandbox/run-stage.ts` | `runStage`, `runSession`, `guardedSession`, `StageRunInput`, `StageHost`, `DraftCheckContext`, `bareModel`, `Ledger`, `CleanupWindow`, the gate, cap and wait helpers, the Anthropic metering vetoes, the model request, accept and draft limits and the final receipt assembly |
| L12 | #760 | `server/sandbox.ts` | `server/sandbox/launch.ts` | `SandboxHostConfig`, `sandboxHost`, `launchSandbox`, `piCommand`, `STAGE_SYSTEM_PROMPT`, `agentDirFrom`, `gitState`, `hostSessionPath`, `captureStderr`, `STDERR_CAP_BYTES`, `CLEANUP_RESERVE_MS` and `freshDir` |
| L12 | #760 | `server/sandbox.ts` | `server/sandbox/executor.ts` | `SandboxExecutorConfig`, `sandboxExecutor`, `PREFLIGHT_RUN`, `SANDBOX_ROOT`, `Bundle`, `locateBundle`, `withSkills` and its skill helpers, `cleanupBuildAgents` and `cleanupBuildBase` |
| L12 | #760 | `server/sandbox.ts` | `server/sandbox/receipts.ts` | `OUTPUT_MAX_BYTES`, `MAX_SESSION_BYTES`, `publishFile`, `replaceUsage`, `executionWindow`, `ExecutionCharge`, `uncertainCharge`, `executionCharge`, `executionEfficiency`, `executionSpent`, `attemptSpent`, `SPECIFY_SESSIONS`, `stageName`, `attemptOutput`, `builderFamily`, `readRunPatch` and `buildCommands`. Combined with L05's existing bounded receipt reader |
| L12 | #760 | `server/sandbox.ts` | `server/sandbox/visible-tests.ts` | `VISIBLE_LIMIT_MS`, `visibleBudget` and `runVisibleTests` |
| L12 | #760 | `server/sandbox.ts` | `server/sandbox/review.ts` | `runReview`, `prepareCandidateReview`, `candidateReviewInputs`, `readCapturedReview`, `reviewInputRecord`, `reviewVerdict` and `capturedReviewText` |
| L12 | #760 | `server/sandbox.ts` | `server/sandbox/specify.ts` | `runSpecify`, `KeptSession` and `keptSession` |
| L13 | #761 | `server/README.md` | `host/README.md` | The whole file |
| L13 | #761 | `server/cli.ts` | `host/cli/cadence.ts` | `runCadenceCli` |
| L13 | #761 | `server/cli.ts` | `host/cli/index.ts` | `ISSUE_NUMBER`, `Values`, `isControllerCommand`, `issuesOf`, `parseController`, `parse`, `parseCliArgs`, `controllerView`, `runCli` |
| L13 | #761 | `server/cli.ts` | `host/cli/measurement.ts` | `runMeasurementCli` |
| L13 | #761 | `server/cli.ts` | `host/cli/metrics.ts` | `defectIssueOf`, `validMetricInstant`, `readMetricDefects`, `MetricReview`, `INTERVENTION_UNREADABLE`, `readMetricPages`, `readMetricReviews`, `readMetricInterventions`, `readInterventionFixture`, `collectOwnerMetrics`, `runMetricsCli` |
| L13 | #761 | `server/cli.ts` | `host/cli/owner-feed.ts` | `runOwnerFeedCli` |
| L13 | #761 | `server/cli.ts` | `host/cli/platform.ts` | `USAGE`, `EXIT`, `ControllerRuntime`, `ExecutorContext`, `XDG_RUNTIME_DIR`, `CliIo`, `FETCH_TIMEOUT_MS`, `CONTROLLER_COMMANDS`, `ControllerCommand`, `Parsed`, `redactString`, `ControllerView`, `StatusOutput`, `Printable`, `json`, `isPrivateDirectory`, `realRuntime`, `execFile` |
| L13 | #761 | `server/cli.ts` | `host/cli/replay.ts` | `runReplayCli` |
| L13 | #761 | `server/cli.ts` | `host/cli/serve.ts` | `runController` |
| L13 | #761 | `server/cli/measurement.ts` | `host/cli/measurement.ts` | The whole file |
| L13 | #761 | `server/cli/owner-feed.ts` | `host/cli/owner-feed.ts` | The whole file |
| L13 | #761 | `server/cli/replay.ts` | `host/cli/replay.ts` | The whole file |
| L13 | #761 | `server/controller/README.md` | `host/controller/README.md` | The whole file |
| L13 | #761 | `server/controller/cadence.ts` | `host/controller/cadence.ts` | The whole file |
| L13 | #761 | `server/controller/candidate-port.ts` | `host/controller/candidate-port.ts` | The whole file |
| L13 | #761 | `server/controller/checkers.ts` | `host/controller/checkers.ts` | The whole file |
| L13 | #761 | `server/controller/checkout.ts` | `host/controller/checkout.ts` | The whole file |
| L13 | #761 | `server/controller/lock.ts` | `host/controller/lock.ts` | The whole file |
| L13 | #761 | `server/controller/measurement.ts` | `host/controller/measurement.ts` | The whole file |
| L13 | #761 | `server/controller/outbox.ts` | `host/controller/outbox.ts` | The whole file |
| L13 | #761 | `server/controller/run-files.ts` | `host/controller/run-files.ts` | The whole file |
| L13 | #761 | `server/controller/serve-loop.ts` | `host/controller/serve-loop.ts` | The whole file |
| L13 | #761 | `server/controller/state.ts` | `host/controller/state.ts` | The whole file |
| L13 | #761 | `server/controller/terminal.ts` | `host/controller/terminal.ts` | The whole file |
| L13 | #761 | `server/controller/validation-sweep.ts` | `host/controller/validation-sweep.ts` | The whole file |
| L13 | #761 | `server/factory.service` | `host/install/factory.service` | The whole file |
| L13 | #761 | `server/gates.ts` | `host/gates/base.ts` | `countsOf`, `privateExecution`, `parseDraftDetails`, `publicFailurePaths`, `heldoutProjection`, `baseTreeDigest`, `BaseRunInput`, `runHeldoutBase`, `runDraftBase`, `runBase`, `scanSuite`, `replayHeldoutCandidate` |
| L13 | #761 | `server/gates.ts` | `host/gates/gates.ts` | `GATE_TEST_CONCURRENCY`, `GateCheck`, `GateReceipt`, `CandidateInput`, `sameCounts`, `receiptPasses`, `scanCandidate`, `checkCandidate`, `runGatesCli` |
| L13 | #761 | `server/gates.ts` | `host/gates/manifest.ts` | `CHECK_NAMES`, `Dependency`, `GateManifest`, `specs`, `validateDependencies`, `readDependencies`, `manifestOf` |
| L13 | #761 | `server/gates.ts` | `host/gates/materialize.ts` | `SOURCE`, `SHA`, `isDocumentation`, `CONFIG`, `git`, `safePath`, `entries`, `exportTree`, `replacementDigest`, `replacementsOf`, `Inventory`, `checkReplacements`, `overlay`, `materializeCandidate`, `inventory`, `materializeFromDirectories`, `heldoutDigest`, `heldoutOf` |
| L13 | #761 | `server/gates.ts` | `host/gates/runner.ts` | `GATE_IMAGE`, `CLEAN_ENV`, `Result`, `RunInput`, `GateRunner`, `command`, `dockerRunner`, `localRunner`, `prefetch`, `install`, `testArgv`, `dependencyJobs`, `dependencyCache` |
| L13 | #761 | `server/gates/draft-reporter.mjs` | `host/gates/draft-reporter.mjs` | The whole file |
| L13 | #761 | `server/install-exe-dev.sh` | `host/install/install-exe-dev.sh` | The whole file |
| L13 | #761 | `server/provision.sh` | `host/install/provision.sh` | The whole file |
| L13 | #761 | `server/sandbox/assets/package-lock.json` | `host/bundle/assets/package-lock.json` | The whole file |
| L13 | #761 | `server/sandbox/assets/package.json` | `host/bundle/assets/package.json` | The whole file |
| L13 | #761 | `server/sandbox/assets/pi.ts` | `host/bundle/assets/pi.ts` | The whole file |
| L13 | #761 | `server/sandbox/assets/stage-init.ts` | `host/bundle/assets/stage-init.ts` | The whole file |
| L13 | #761 | `server/sandbox/audit.ts` | `host/gateway/audit.ts` | The whole file |
| L13 | #761 | `server/sandbox/bwrap.ts` | `host/isolation/bwrap.ts` | The whole file |
| L13 | #761 | `server/sandbox/control.ts` | `host/gateway/control.ts` | The whole file |
| L13 | #761 | `server/sandbox/credentials.ts` | `host/gateway/credentials.ts` | The whole file |
| L13 | #761 | `server/sandbox/echo-fixture.ts` | `host/gateway/echo-fixture.ts` | The whole file |
| L13 | #761 | `server/sandbox/executor.ts` | `host/sandbox/executor.ts` | The whole file |
| L13 | #761 | `server/sandbox/gateway-client.ts` | `host/gateway/client.ts` | The whole file |
| L13 | #761 | `server/sandbox/gateway-main.ts` | `host/gateway/main.ts` | The whole file |
| L13 | #761 | `server/sandbox/gateway.ts` | `host/gateway/gateway.ts` | The whole file |
| L13 | #761 | `server/sandbox/launch.ts` | `host/sandbox/launch.ts` | The whole file |
| L13 | #761 | `server/sandbox/lines.ts` | `host/sandbox/lines.ts` | The whole file |
| L13 | #761 | `server/sandbox/manifest.ts` | `host/bundle/manifest.ts` | The whole file |
| L13 | #761 | `server/sandbox/meter.ts` | `host/gateway/meter.ts` | The whole file |
| L13 | #761 | `server/sandbox/policy.ts` | `host/gateway/policy.ts` | The whole file |
| L13 | #761 | `server/sandbox/preflight.ts` | `host/isolation/preflight.ts` | The whole file |
| L13 | #761 | `server/sandbox/receipts.ts` | `host/sandbox/receipts.ts` | The whole file |
| L13 | #761 | `server/sandbox/result.ts` | `host/sandbox/result.ts` | The whole file |
| L13 | #761 | `server/sandbox/review.ts` | `host/sandbox/review.ts` | The whole file |
| L13 | #761 | `server/sandbox/routes.ts` | `host/gateway/routes.ts` | The whole file |
| L13 | #761 | `server/sandbox/rpc.ts` | `host/sandbox/rpc.ts` | The whole file |
| L13 | #761 | `server/sandbox/run-stage.ts` | `host/sandbox/run-stage.ts` | The whole file |
| L13 | #761 | `server/sandbox/scope.ts` | `host/isolation/scope.ts` | The whole file |
| L13 | #761 | `server/sandbox/seccomp.ts` | `host/isolation/seccomp.ts` | The whole file |
| L13 | #761 | `server/sandbox/settle.ts` | `host/sandbox/settle.ts` | The whole file |
| L13 | #761 | `server/sandbox/specify.ts` | `host/sandbox/specify.ts` | The whole file |
| L13 | #761 | `server/sandbox/visible-tests.ts` | `host/sandbox/visible-tests.ts` | The whole file |
| L13 | #761 | `server/viewer.ts` | `host/viewer/server.ts` | The whole file |
| L13 | #761 | `server/viewer/claim.ts` | `host/viewer/claim.ts` | The whole file |
| L13 | #761 | `server/viewer/dashboard.ts` | `host/viewer/dashboard.ts` | The whole file |
| L13 | #761 | `server/viewer/design/SOURCE` | `host/viewer/design/SOURCE` | The whole file |
| L13 | #761 | `server/viewer/design/icons/NOTICE` | `host/viewer/design/icons/NOTICE` | The whole file |
| L13 | #761 | `server/viewer/design/icons/icons.ts` | `host/viewer/design/icons/icons.ts` | The whole file |
| L13 | #761 | `server/viewer/design/tokens.css` | `host/viewer/design/tokens.css` | The whole file |
| L13 | #761 | `server/viewer/design/tokens.json` | `host/viewer/design/tokens.json` | The whole file |
| L13 | #761 | `server/viewer/evidence.ts` | `host/viewer/evidence.ts` | The whole file |
| L13 | #761 | `server/viewer/icon-192.png` | `host/viewer/icon-192.png` | The whole file |
| L13 | #761 | `server/viewer/icon-512.png` | `host/viewer/icon-512.png` | The whole file |
| L13 | #761 | `server/viewer/manifest.webmanifest` | `host/viewer/manifest.webmanifest` | The whole file |
| L13 | #761 | `server/viewer/render.ts` | `host/viewer/render.ts` | The whole file |
| L13 | #761 | `server/viewer/style.css` | `host/viewer/style.css` | The whole file |
| L14 | #762 | `test/admission.test.ts` | `test/src/trust/admission.test.ts` | The whole file, with relative imports and readers relocated |
| L14 | #762 | `test/authorization-parity.test.ts` | `test/src/trust/authorization-parity.test.ts` | The whole file, with relative imports and readers relocated |
| L14 | #762 | `test/markers.test.ts` | `test/src/trust/markers.test.ts` | The whole file, with relative imports and readers relocated |
| L14 | #762 | `test/platform.test.ts` | `test/src/trust/platform.test.ts` | The whole file, with relative imports and readers relocated |
| L14 | #762 | `test/policy.test.ts` | `test/src/trust/policy.test.ts` | The whole file, with relative imports and readers relocated |
| L14 | #762 | `test/accept.test.ts` | `test/src/contract/accept.test.ts` | The whole file, with relative imports and readers relocated |
| L14 | #762 | `test/artifacts.test.ts` | `test/src/contract/artifacts.test.ts` | The whole file, with relative imports and readers relocated |
| L14 | #762 | `test/specify.test.ts` | `test/src/contract/specify.test.ts` | The whole file, with relative imports and readers relocated |
| L14 | #762 | `test/config-contract-parity.test.ts` | `test/src/contract/config-contract-parity.test.ts` | The whole file, with relative imports and readers relocated |
| L14 | #762 | `test/host-harness-parity.test.ts` | `test/src/contract/host-harness-parity.test.ts` | The whole file, with its prompt import relocated |
| L14 | #762 | `test/base-check.test.ts` | `test/src/candidate/base-check.test.ts` | The whole file, with relative imports and readers relocated |
| L14 | #762 | `test/build.test.ts` | `test/src/candidate/build.test.ts` | The whole file, with relative imports and readers relocated |
| L14 | #762 | `test/diagnosis.test.ts` | `test/src/candidate/diagnosis.test.ts` | The whole file, with relative imports and readers relocated |
| L14 | #762 | `test/draft-feedback.test.ts` | `test/src/candidate/draft-feedback.test.ts` | The whole file, with relative imports and readers relocated |
| L14 | #762 | `test/feedback.test.ts` | `test/src/candidate/feedback.test.ts` | The whole file, with relative imports and readers relocated |
| L14 | #762 | `test/handoff.test.ts` | `test/src/candidate/handoff.test.ts` | The whole file, with relative imports and readers relocated |
| L14 | #762 | `test/review.test.ts` | `test/src/candidate/review.test.ts` | The whole file, with relative imports and readers relocated |
| L14 | #762 | `test/stages.test.ts` | `test/src/candidate/stages.test.ts` | The whole file, with relative imports and readers relocated |
| L14 | #762 | `test/validation.test.ts` | `test/src/candidate/validation.test.ts` | The whole file, with relative imports and readers relocated |
| L14 | #762 | `test/core.test.ts` | `test/src/core/core.test.ts` | The whole file, with relative imports and readers relocated |
| L14 | #762 | `test/github-adapter.test.ts` | `test/src/github/github-adapter.test.ts` | The whole file, with relative imports and readers relocated |
| L14 | #762 | `test/publication.test.ts` | `test/src/github/publication.test.ts` | The whole file, with relative imports and readers relocated |
| L14 | #762 | `test/workflow.test.ts` | `test/src/config/workflow.test.ts` | The whole file, with relative imports and readers relocated |
| L14 | #762 | `test/ledger.test.ts` | `test/src/ledger/ledger.test.ts` | The whole file, with relative imports and readers relocated |
| L14 | #762 | `test/ledger-pins.test.ts` | `test/src/ledger/ledger-pins.test.ts` | The whole file, with relative imports and readers relocated |
| L14 | #762 | `test/cadence.test.ts` | `test/src/maintenance/cadence.test.ts` | The whole file, with relative imports and readers relocated |
| L14 | #762 | `test/replay.test.ts` | `test/src/maintenance/replay.test.ts` | The whole file, with relative imports and readers relocated |
| L14 | #762 | `test/scorers.test.ts` | `test/src/maintenance/scorers.test.ts` | The whole file, with relative imports and readers relocated |
| L14 | #762 | `test/attention.test.ts` | `test/src/views/attention.test.ts` | The whole file, with relative imports and readers relocated |
| L14 | #762 | `test/explain.test.ts` | `test/src/views/explain.test.ts` | The whole file, with relative imports and readers relocated |
| L14 | #762 | `test/feed.test.ts` | `test/src/views/feed.test.ts` | The whole file, with relative imports and readers relocated |
| L14 | #762 | `test/metrics.test.ts` | `test/src/views/metrics.test.ts` | The whole file, with relative imports and readers relocated |
| L14 | #762 | `test/extension.test.ts` | `test/src/views/extension.test.ts` | The whole file, with relative imports and readers relocated |
| L14 | #762 | `test/candidate-gates.test.ts` | `test/host/gates/candidate-gates.test.ts` | The whole file, with relative imports and readers relocated |
| L14 | #762 | `test/layout.test.ts` | `test/host/gates/layout.test.ts` | The whole file, with relative imports and readers relocated |
| L14 | #762 | `test/decisions-format.test.ts` | `test/host/gates/decisions-format.test.ts` | The whole file, with relative imports and readers relocated |
| L14 | #762 | `test/package-load.test.ts` | `test/host/gates/package-load.test.ts` | The whole file, with relative imports and readers relocated |
| L14 | #762 | `test/host-controller.test.ts` | `test/host/controller/host-controller.test.ts` | The whole file, with relative imports and readers relocated |
| L14 | #762 | `test/layout-host-contract.test.ts` | `test/host/controller/layout-host-contract.test.ts` | The whole file, with relative imports and readers relocated |
| L14 | #762 | `test/dashboard.test.ts` | `test/host/viewer/dashboard.test.ts` | The whole file, with relative imports and readers relocated |
| L14 | #762 | `test/design-tokens.test.ts` | `test/host/viewer/design-tokens.test.ts` | The whole file, with relative imports and readers relocated |
| L14 | #762 | `test/viewer-style.test.ts` | `test/host/viewer/viewer-style.test.ts` | The whole file, with relative imports and readers relocated |
| L14 | #762 | `test/viewer.test.ts` | `test/host/viewer/viewer.test.ts` | The whole file, with relative imports and readers relocated |
| L14 | #762 | `test/install-exe-dev.test.ts` | `test/host/install/install-exe-dev.test.ts` | The whole file, with relative imports and readers relocated |
| L14 | #762 | `test/provision.test.ts` | `test/host/install/provision.test.ts` | The whole file, with relative imports and readers relocated |
| L14 | #762 | `test/accept-selfcheck.test.ts` | `test/host/sandbox/accept-selfcheck.test.ts` | The whole file, with relative imports and readers relocated |
| L14 | #762 | `test/pipeline.test.ts` | `test/src/controller/pipeline.test.ts` | The whole file, with relative imports and readers relocated |
| L14 | #762 | `test/status-driver.test.ts` | `test/host/cli/status-driver.test.ts` | The whole file, with relative imports and readers relocated |
| L14 | #762 | `test/sandbox/assets.cases.ts` | `test/host/sandbox/assets.test.ts` | The whole file, with relative imports and readers relocated |
| L14 | #762 | `test/sandbox/audit.cases.ts` | `test/host/gateway/audit.test.ts` | The whole file, with relative imports and readers relocated |
| L14 | #762 | `test/sandbox/credentials.cases.ts` | `test/host/gateway/credentials.test.ts` | The whole file, with relative imports and readers relocated |
| L14 | #762 | `test/sandbox/fake-pi.ts` | `test/host/sandbox/fake-pi.ts` | The whole file, with relative imports and readers relocated |
| L14 | #762 | `test/sandbox/gateway.cases.ts` | `test/host/gateway/gateway.test.ts` | The whole file, with relative imports and readers relocated |
| L14 | #762 | `test/sandbox/http-fixtures.ts` | `test/host/gateway/http-fixtures.ts` | The whole file, with relative imports and readers relocated |
| L14 | #762 | `test/sandbox/launcher.cases.ts` | `test/host/sandbox/launcher.test.ts` | The whole file, with relative imports and readers relocated |
| L14 | #762 | `test/sandbox/policy.cases.ts` | `test/host/gateway/policy.test.ts` | The whole file, with relative imports and readers relocated |
| L14 | #762 | `test/sandbox/receipt-exit.ts` | `test/host/sandbox/receipt-exit.ts` | The whole file, with relative imports and readers relocated |
| L14 | #762 | `test/sandbox/routes.cases.ts` | `test/host/gateway/routes.test.ts` | The whole file, with relative imports and readers relocated |
| L14 | #762 | `test/sandbox/runner.cases.ts` | `test/host/sandbox/runner.test.ts` | The whole file, with relative imports and readers relocated |
| L14 | #762 | `test/sandbox/settlement-fixtures.ts` | `test/host/gateway/settlement-fixtures.ts` | The whole file, with relative imports and readers relocated |
| L14 | #762 | `test/native-scope.ts` | `test/host/sandbox/native-scope.ts` | The whole file, with relative imports and readers relocated |
| L14 | #762 | `test/orchestrator.test.ts` | `test/src/controller/orchestrator-dispatch.test.ts` | Existing describe groups: `backoffMs`; `Orchestrator claims and dispatch`; `Orchestrator switches and per-tick reads`; `Orchestrator markers`; `Orchestrator restart recovery`; `Orchestrator retries and stalls` |
| L14 | #762 | `test/orchestrator.test.ts` | `test/src/controller/orchestrator-base.test.ts` | Existing describe groups: `Orchestrator base qualification`; `Orchestrator stage results` |
| L14 | #762 | `test/orchestrator.test.ts` | `test/src/controller/orchestrator-host.test.ts` | Existing describe groups: `checkIdentity`; `parseStartTime`; `server/cli.ts controller commands`; `Orchestrator runs of another state directory` |
| L14 | #762 | `test/orchestrator.test.ts` | `test/src/controller/orchestrator-accounting.test.ts` | Existing describe groups: `admission accounting policy`; `durable attempt ends`; `fileRunFiles` |
| L14 | #762 | `test/orchestrator.test.ts` | `test/src/controller/orchestrator-claims.test.ts` | Existing describe groups: `Orchestrator restart reads`; `Orchestrator new ready events`; `Orchestrator slot accounting`; `Orchestrator eligibility before launch`; `Orchestrator bot comment edits`; `Orchestrator live marker validation`; `Orchestrator local admission recovery`; `Orchestrator reconcile order`; `Orchestrator ledger behind the local claim record`; `Orchestrator claim record` |
| L14 | #762 | `test/orchestrator.test.ts` | `test/src/controller/orchestrator-recovery.test.ts` | Existing describe groups: `Orchestrator terminal claim records`; `Orchestrator persisted claim slots`; `Orchestrator claims recorded before their first marker`; `Orchestrator before the first workflow load`; `Orchestrator retry workspace preparation`; `Orchestrator claims before their first marker whose event was replaced`; `Orchestrator cap reduction in a running process`; `Orchestrator workspace replay`; `Orchestrator loaded terminal records`; `Orchestrator claim record usage`; `Orchestrator release reasons`; `Orchestrator retry marker confirmation`; `Orchestrator same-second cache`; `Orchestrator stall aborts` |
| L14 | #762 | `test/orchestrator.test.ts` | `test/src/controller/orchestrator-usage.test.ts` | Existing describe groups: `Orchestrator run allowance at launch`; `Orchestrator usage reported after a stall`; `Orchestrator logger receiver`; `Orchestrator late usage across a restart`; `Orchestrator tick order`; `Orchestrator timeline with no ready event`; `Orchestrator eligibility before adoption`; `Orchestrator attempt limit at retry launch`; `Orchestrator cap and claimed runs` |
| L14 | #762 | `test/orchestrator.test.ts` | `test/src/controller/orchestrator-evidence.test.ts` | Existing describe groups: `Orchestrator refusals on unproved evidence`; `Orchestrator launch after a direct issue read`; `Orchestrator terminal marker trust`; `Orchestrator terminal memory across events`; `Orchestrator refusal classification`; `acquireLock` |
| L14 | #762 | `test/orchestrator.test.ts` | `test/src/controller/orchestrator-build.test.ts` | Existing describe groups: `private build stage` |
| L14 | #762 | `test/orchestrator.test.ts` | `test/src/controller/orchestrator-validation.test.ts` | Existing describe groups: `controller-only validate` |
| L14 | #762 | `test/orchestrator.test.ts` | `test/src/controller/orchestrator-acceptance.test.ts` | Existing describe groups: `held-out acceptance stage`; `held-out acceptance stage: needs_info` |
| L14 | #762 | `test/orchestrator.test.ts` | `test/src/controller/orchestrator-specify.test.ts` | Existing describe groups: `specify: contract`; `specify: no contract without a passing, valid output`; `specify: questions`; `specify: linked runs and answers` |
| L14 | #762 | `test/orchestrator.test.ts` | `test/src/controller/orchestrator-ledger.test.ts` | Existing describe groups: `ledger outbox enrollment`; `terminal rows keep the real cause` |
| L14 | #762 | `test/orchestrator.test.ts` | `test/src/controller/orchestrator-characterization.test.ts` | Existing describe groups: `L10 scheduling characterization`; `L10 fresh-process recovery characterization` |
| L14 | #762 | `test/orchestrator.test.ts` | `test/src/controller/orchestrator-fixtures.ts` | Shared fixtures, helpers, types and temporary-state cleanup; no test registrations |
| L14 | #762 | `test/sandbox.test.ts` | `test/host/{sandbox,gateway}/*.test.ts` | Aggregator deleted; its eight suites are directly discovered, not re-exported |
| L14 | #762 | `test/sandbox/routes.cases.ts` | `test/host/gateway/route-fixtures.ts` | `modelTable` and `anthropicTable`; shared fixtures register no tests |
| L14 | #762 | `test/sandbox/credentials.cases.ts` | `test/host/gateway/credential-fixtures.ts` | `ECHO_SECRET`, `LINEAR_CEILING`, `credentialedRoute`, `id` and `routeIdOf`; shared fixtures register no tests |

L00 moves no files.
