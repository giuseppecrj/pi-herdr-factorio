import { BUILD_MAX_TOKENS, BUILD_TOOLS } from "../candidate/build.ts";
import {
	type AcceptanceQualification,
	type BaseCheckProgress,
	assessVisibleChecks,
	baseRefusalNotice,
	diagnosisNotice,
	failedVisibleChecks,
	matchingBaseProof,
	retryPending,
	retryableBaseReason,
} from "../candidate/diagnosis.ts";
import type { FeedbackObservation } from "../candidate/feedback.ts";
import {
	type CandidateEffectResult,
	type CandidateEvent,
	beginCandidate,
	candidateAllowance,
	candidateProjection,
	candidateUsage,
	handoffCandidate,
	stopRound,
} from "../candidate/handoff.ts";
import {
	REVIEW_TOOLS,
	ReviewEvidenceUnavailable,
	type ReviewInputRefusal,
	reviewSeats,
} from "../candidate/review.ts";
import {
	type CandidateEffect,
	type CandidateExecution,
	type CandidateState,
	MAX_REVIEW_ATTEMPTS,
} from "../candidate/state.ts";
import { sameAssessmentRef } from "../candidate/validation.ts";
import {
	DEFAULTS,
	type EnvLookup,
	type GitSha,
	STAGE_CLEANUP_RESERVE_MS,
	type WorkflowConfig,
} from "../config/schema.ts";
import {
	ACCEPTANCE_MAX_TOKENS,
	ACCEPTANCE_SKILLS,
	ACCEPTANCE_TOOLS,
} from "../contract/acceptance.ts";
import { NEEDS_INFO_LABEL } from "../contract/contract.ts";
import { SPECIFY_SKILLS, SPECIFY_TOOLS } from "../contract/prompt.ts";
import {
	acceptanceKey,
	buildKey,
	contractKey,
	questionsKey,
	renderAcceptanceSummary,
	renderBuildSummary,
} from "../contract/render.ts";
import type { JsonValue } from "../core/json.ts";
import { withFamily } from "../core/models.ts";
import { type Digest, digestOf, isDigest, runIdOf } from "../core/run.ts";
import { type Stage, isModelStage } from "../core/stages.ts";
import {
	DEFAULT_PAGING,
	type GitHubFailure,
	type GitHubPaging,
	GitHubTicketAdapter,
	GitHubTicketWriter,
	type IssueComment,
	type IssueRecord,
	type Read,
	type TimelineEntry,
} from "../github/adapter.ts";
import type { Exec } from "../github/exec.ts";
import { PublicationError } from "../github/publish.ts";
import { LedgerRowError, legacyRunContext } from "../ledger/schema.ts";
import {
	type TerminalCause,
	candidateCause,
	terminalSnapshot,
} from "../ledger/terminal.ts";
import type { CadenceRunner } from "../maintenance/cadence.ts";
import {
	type AdmissionStore,
	type AdmittedReceipt,
	type RefusalReason,
	type SnapshotReader,
	type TickReads,
	admitTicket,
	latestReadyEntry,
	readTickInputs,
} from "../trust/admission.ts";
import {
	type Marker,
	type MarkerDefect,
	type MarkerLedger,
	type RunStatus,
	currentMarker,
	formatMarker,
	isControllerComment,
	isTerminal,
	latestFor,
	markerLedger,
	parseMarker,
} from "../trust/markers.ts";
import type { PlatformProfile, RepoSlug } from "../trust/platform.ts";
import { READY_LABEL } from "../trust/policy.ts";
import {
	type Draining,
	END_STATUS,
	SANDBOX_CAPS,
	type Totals,
	acceptSpent,
	accountAdopted,
	attemptSpent,
	budgetCause,
	countLateUsage,
	countReleased,
	inputCause,
	preparedCause,
	reconcileSpent,
	recordAttempt,
	saveAttempt,
} from "./accounting.ts";
import {
	type SeenIssue,
	isReady,
	linkRun,
	refusalSettlesUntilEdited,
	settled,
	unmarkedEvents,
} from "./admission.ts";
import {
	acceptanceReceipt,
	postRetriedRefusal,
	retireRefused,
} from "./base-check.ts";
import {
	type ActiveRun,
	type ClaimObservation,
	type ClaimRecord,
	type CleanLedger,
	type ConfirmedRecord,
	type EndedRecord,
	FIRST_STAGE,
	type ReleaseReason,
	type RetryCause,
	type RunFiles,
	type RunPhase,
	type RunningPhase,
	type Unverified,
	admittedFields,
	claimOf,
	claimProjection,
	desiredStatus,
	localMarker,
	markerOf,
	matchesRecord,
	recordOf,
	unadmitted,
	writeClaim,
	writeEnded,
} from "./claims.ts";
import { type Effects, accepted, postKeyed, specified } from "./effects.ts";
import {
	type ReviewPreparation,
	type StageEnd,
	type StageExecutor,
	type StageOutput,
	UNPREPARED,
	prepareWorkspace,
	stageInputs,
} from "./launch.ts";
import {
	type CandidateResult,
	queueReviewRefusal,
	recoverCandidate,
} from "./recovery.ts";

/** Milliseconds since the epoch. Tests pass a fake. */
export type Clock = { now(): number };

/**
 * The single authority. `runs` holds every claim, keyed by issue: its keys are
 * Symphony's `claimed`, the `running` phases are `running`, and the
 * `retry_queued` phases are `retry_attempts`.
 */
export type ControllerState = {
	readonly runs: Map<number, ActiveRun>;
	readonly seen: Map<number, SeenIssue>;
	readonly corrupt: Map<
		number,
		{ readonly defect: MarkerDefect; readonly commentId: string }
	>;
	readonly totals: Totals;
};

export type GateReason =
	| "state_unavailable"
	| "locally_disabled"
	| "repo_switch_off"
	| "repo_switch_unavailable"
	| "workflow_unavailable"
	| "candidates_unavailable";

export type RunView = {
	readonly issue: number;
	readonly runId: Digest;
	readonly eventId: string;
	readonly stage: Stage;
	readonly status: RunStatus;
	readonly attempt: number;
	readonly seq: number;
	readonly markerPending: boolean;
	readonly workspace: "present" | "missing_replayed";
	readonly retryAt: string | null;
	readonly usage: number;
	/** Set while the claim stays unconfirmed because a GitHub read fails. */
	readonly unverified: Unverified | null;
};

type FeedbackIntakeProblem = Readonly<{
	issue: number;
	runId: Digest;
	eventId: string;
	pr: number;
	kind: "unavailable" | "deferred";
	reason: NonNullable<
		Extract<FeedbackObservation, { kind: "unavailable" | "deferred" }>["reason"]
	>;
	failure: GitHubFailure["kind"] | null;
	since: number;
}>;

/** One tick's claim snapshot. Never carries issue text. */
export type TickReport = {
	readonly repo: RepoSlug;
	readonly at: string;
	readonly executionEnabled: boolean;
	readonly dispatch: {
		readonly enabled: boolean;
		readonly reasons: readonly GateReason[];
	};
	readonly workflowSha: GitSha | null;
	readonly attentionThresholds?: WorkflowConfig["attention"];
	readonly maxConcurrent: number;
	/** Runs holding a slot. Above `maxConcurrent` only after the cap was lowered while they ran. */
	readonly active: number;
	readonly runs: readonly RunView[];
	readonly feedbackIntake: readonly FeedbackIntakeProblem[];
	/** Includes owned holds discovered before a run can be adopted. */
	readonly unverifiedClaims: readonly (Unverified & {
		readonly issue: number;
		readonly runId: Digest;
		readonly eventId: string;
	})[];
	readonly queued: readonly number[];
	/** Scoped issues that are not open `factory:ready` issues and hold no claim. */
	readonly absent: readonly number[];
	readonly refused: readonly {
		readonly issue: number;
		readonly reasons: readonly RefusalReason["kind"][];
	}[];
	readonly corrupt: readonly {
		readonly issue: number;
		readonly defect: MarkerDefect;
	}[];
	readonly ledgerBehind: readonly {
		readonly issue: number;
		readonly ledgerSeq: number;
		readonly localSeq: number;
	}[];
	readonly totals: Readonly<Totals>;
};

export type LogFields = Readonly<
	Record<string, string | number | boolean | null>
>;

export type Log = (event: string, fields: LogFields) => void;

type Limits = {
	readonly maxConcurrent: number;
	readonly maxAttempts: number;
	readonly maxBackoffMs: number;
	readonly maxTokensPerRun: number;
	stallMs(stage: Stage): number;
};

/**
 * Time past the cleanup reserve that the controller still waits for an
 * aborted stage. The runner ends its cleanup within the reserve of the
 * abort; this covers the receipt write and the tick that reads the result.
 */
const CLEANUP_GRACE_MS = 5_000;

const DRAIN_POLL_MS = 1000;

type ReportInput = {
	readonly now: number;
	readonly enabled: boolean;
	readonly reasons: readonly GateReason[];
	readonly limits: Limits | null;
	readonly queued: readonly number[];
	readonly absent: readonly number[];
	readonly refused: TickReport["refused"];
};

type Gate =
	| { readonly kind: "open"; readonly reads: TickReads }
	| { readonly kind: "closed"; readonly reasons: readonly GateReason[] };

/** Symphony §8.4: `min(10000 * 2^(retry - 1), maxBackoffMs)`, for the 1-based retry. */
export function backoffMs(retry: number, maxBackoffMs: number): number {
	return Math.min(10_000 * 2 ** (retry - 1), maxBackoffMs);
}

function limitsOf(config: WorkflowConfig): Limits {
	return {
		maxConcurrent: config.agent.maxConcurrent,
		maxAttempts: config.retry.maxAttempts,
		maxBackoffMs: config.retry.maxBackoffMs,
		maxTokensPerRun: config.usage.maxTokensPerRun,
		stallMs: (stage) => config.stages[stage].budget.stallMs,
	};
}

function holdsSlot(run: ActiveRun): boolean {
	if (run.handoff !== undefined)
		return run.handoff.accounts.some((a) => a.settlement !== "settled");

	return (
		run.stage !== "validate" &&
		(run.phase.kind === "claimed" ||
			run.phase.kind === "base_check" ||
			run.phase.kind === "running" ||
			run.phase.kind === "blocked")
	);
}

function holdsSlotAs(status: RunStatus): boolean {
	return status === "claimed" || status === "blocked";
}

/**
 * Checks that `gh` acts as the integration bot. A missing `GH_HOST` makes it
 * act as the owner or as nobody, and both fail.
 */
export async function checkIdentity(
	adapter: GitHubTicketAdapter,
	controllerLogin: string,
): Promise<
	| { readonly kind: "ok" }
	| { readonly kind: "mismatch" }
	| { readonly kind: "unavailable"; readonly failure: GitHubFailure }
> {
	const viewer = await adapter.readViewer();

	if (viewer.kind === "failed") {
		return { kind: "unavailable", failure: viewer.failure };
	}

	return viewer.value === controllerLogin
		? { kind: "ok" }
		: { kind: "mismatch" };
}

export type OrchestratorInput = {
	exec: Exec;
	env: EnvLookup;
	platform: PlatformProfile;
	repo: RepoSlug;
	store: AdmissionStore & SnapshotReader;
	files: RunFiles;
	executor: StageExecutor;
	clock: Clock;
	cadence?: CadenceRunner;
	measurement?: {
		terminal(runId: Digest, config: WorkflowConfig): void;
		occupied(): number;
	};
	/** Only these issues, or every candidate when `null`. */
	scope: readonly number[] | null;
	log: Log;
	paging?: GitHubPaging;
	/** A verification-only run cap pinned to its state directory. It only lowers the trusted cap. */
	verification?: { readonly digest: Digest; readonly tokenCap: number } | null;
};

/**
 * One controller authority. Each `tick` reconciles every claim against
 * GitHub before it dispatches anything. Only `tick` (with `cadenceOnce`),
 * `drain` and the callbacks a launch hands the executor change the state;
 * see src/README.md.
 */
export class Orchestrator {
	readonly state: ControllerState = {
		runs: new Map(),
		seen: new Map(),
		corrupt: new Map(),
		totals: {
			claims: 0,
			launches: 0,
			retries: 0,
			stalls: 0,
			releases: 0,
			failures: 0,
			markersPosted: 0,
			usage: 0,
		},
	};

	readonly #input: OrchestratorInput;
	readonly #adapter: GitHubTicketAdapter;
	readonly #writer: GitHubTicketWriter;
	#config: WorkflowConfig | null = null;
	#workflowSha: GitSha | null = null;
	/** The last loaded workflow's digest and its trusted run cap, before any verification cap. */
	#trustedRun: { readonly digest: Digest; readonly tokens: number } | null =
		null;
	#claimsLoaded = false;
	#ticks = 0;
	#tickAt = 0;
	readonly #recover = new Set<number>();
	readonly #reserved = new Set<number>();
	readonly #readOpen = new Set<number>();
	/** Log history only; ownership and dispatch come from #observations. */
	readonly #foreignRuns = new Set<Digest>();
	readonly #feedbackObservations = new Map<
		Digest,
		{
			readonly tick: number;
			readonly problem: FeedbackIntakeProblem;
		}
	>();
	readonly #local = new Map<number, ConfirmedRecord>();
	readonly #ended = new Map<Digest, EndedRecord>();
	readonly #behind = new Map<number, TickReport["ledgerBehind"][number]>();
	readonly #observations = new Map<
		Digest,
		{
			readonly issue: number;
			readonly eventId: string;
			readonly tick: number;
			readonly observation: ClaimObservation;
			/** The preceding tick, before this tick's provisional confirmations. */
			readonly previous: ClaimObservation | undefined;
		}
	>();
	readonly #stages = new Set<Promise<void>>();
	readonly #draining = new Set<Draining>();
	readonly #candidateRecovery = new Set<Digest>();
	readonly #candidateResults: CandidateResult[] = [];
	readonly #candidateExecutions = new Map<
		Digest,
		{ readonly abort: AbortController; settled: boolean }
	>();
	#enabled = false;
	#last: ReportInput | null = null;

	constructor(input: OrchestratorInput) {
		this.#input = input;

		this.#adapter = new GitHubTicketAdapter({
			exec: input.exec,
			repo: input.repo,
			paging: input.paging ?? DEFAULT_PAGING,
		});

		this.#writer = new GitHubTicketWriter({
			exec: input.exec,
			repo: input.repo,
		});
	}

	/** One-shot audit admission shares ticket reservations without launching or claiming ticket work. */
	async cadenceOnce(job: import("../config/schema.ts").CadenceJob) {
		await this.#input.executor.recover();

		const reconciled = await this.#input.executor.reconciled();

		if (reconciled) await this.#input.cadence?.recover();

		await this.#loadClaims(true);
		const gate = await this.#gate();
		const candidates = await this.#candidates();
		const preflight = reconciled && (await this.#input.executor.preflight());

		const queuedTicket =
			candidates.kind !== "ok" ||
			candidates.value.some(
				(record) => isReady(record) && !this.state.runs.has(record.number),
			);

		const capacity = queuedTicket ? 0 : this.#freeSlots();

		const allowed =
			gate.kind === "open" && preflight && candidates.kind === "ok";

		this.#input.cadence?.tick(
			{
				now: this.#input.clock.now(),
				allowed,
				capacity,
				config: this.#config?.cadence ?? null,
				workflowSha: this.#workflowSha,
				workflowDigest: this.#trustedRun?.digest ?? null,
			},
			job,
			true,
		);
		await this.#input.cadence?.wait();

		return {
			allowed,
			capacity,
			configured: this.#config?.cadence != null,
			ready: this.#input.cadence?.ready ?? false,
			pending: this.#input.cadence?.pending ?? false,
			jobs: this.#input.cadence?.status() ?? [],
		};
	}

	/** The poll interval of the last valid workflow, or the default. */
	get pollIntervalMs(): number {
		return this.#config?.polling.intervalMs ?? DEFAULTS.pollIntervalMs;
	}

	#see(issue: number, updatedAt: string, verdict: SeenIssue["verdict"]): void {
		this.state.seen.set(issue, {
			updatedAt,
			observedAt: this.#tickAt,
			verdict,
		});
	}

	#unchanged(issue: number, updatedAt: string): boolean {
		const seen = this.state.seen.get(issue);

		return (
			seen?.updatedAt === updatedAt &&
			(seen.verdict.kind === "refused" || settled(seen))
		);
	}

	#inScope(issue: number): boolean {
		const { scope } = this.#input;

		return scope === null || scope.includes(issue);
	}

	async tick(): Promise<TickReport> {
		const now = this.#input.clock.now();
		const queued: number[] = [];

		this.#ticks++;
		this.#tickAt = now;
		this.#readOpen.clear();

		for (const [runId, held] of this.#observations) {
			if (held.tick < this.#ticks - 1) this.#observations.delete(runId);
		}

		const refused: { issue: number; reasons: RefusalReason["kind"][] }[] = [];

		if (!this.#claimsLoaded) {
			await this.#input.executor.recover();

			if (
				this.#input.cadence !== undefined &&
				(await this.#input.executor.reconciled())
			)
				await this.#input.cadence.recover();

			await this.#loadClaims();
		}

		await this.#observeCandidates(false);
		countLateUsage(this.#input, this.#draining, this.state.totals);

		const held = this.#limits();

		if (held !== null) await this.#reconcileStages(now, held);

		this.#enabled = await this.#input.executor.preflight();

		if (this.#enabled && this.#input.cadence?.ready === false)
			await this.#input.cadence.recover();

		const candidates = await this.#candidates();

		await this.#reconcileClaims(candidates);

		const gate = await this.#gate();
		const limits = this.#limits();
		const reasons = gate.kind === "closed" ? [...gate.reasons] : [];

		if (candidates.kind === "failed") reasons.push("candidates_unavailable");

		const direct =
			candidates.kind === "ok"
				? await this.#discover(candidates.value, queued)
				: [];

		await this.#confirmEnds();
		await this.#input.executor
			.cleanupValidation?.()
			.catch(() => this.#input.log("validation_cleanup_unavailable", {}));

		const open =
			gate.kind === "open" && candidates.kind === "ok" && limits !== null;

		await this.#observeCandidates(open);

		if (open) {
			await this.#dispatch({
				now,
				candidates: candidates.value,
				direct,
				reads: gate.reads,
				limits,
				queued,
				refused,
			});
		} else {
			for (const issue of this.#reserved) {
				if (!this.state.runs.has(issue) && !queued.includes(issue)) {
					queued.push(issue);
				}
			}
		}

		this.#input.cadence?.tick({
			now,
			allowed: open && this.#enabled,
			disabled:
				reasons.includes("locally_disabled") ||
				reasons.includes("repo_switch_off"),
			capacity: this.#freeSlots(),
			config: this.#config?.cadence ?? null,
			workflowSha: this.#workflowSha,
			workflowDigest: this.#trustedRun?.digest ?? null,
		});

		if (open)
			await this.#input.executor.candidate
				?.sweep?.(this.#input.repo, now)
				.catch(() => this.#input.log("feedback_sweep_failed", {}));

		this.#input.log("tick", {
			dispatch: open,
			runs: this.state.runs.size,
			queued: queued.length,
		});

		const absent =
			candidates.kind === "ok"
				? (this.#input.scope ?? []).filter(
						(issue) =>
							!this.state.runs.has(issue) &&
							!candidates.value.some((record) => record.number === issue),
					)
				: [];

		this.#last = {
			now,
			enabled: open,
			reasons,
			limits,
			queued,
			absent,
			refused,
		};

		return this.#report(this.#last);
	}

	/**
	 * Waits until no stage is running, ending each as step 1 of a tick would:
	 * a stage that stalls is aborted, and every ended stage posts its marker.
	 * One-shot commands call this so they never exit with a sandbox running.
	 * It returns the last tick's report brought up to date, or `null` when no
	 * stage was running.
	 */
	async drain(wait: (ms: number) => Promise<void>): Promise<TickReport | null> {
		const limits = this.#limits();
		const last = this.#last;

		if (limits === null || last === null) return null;

		const running = () =>
			[...this.#candidateExecutions.values()].some(
				(execution) => !execution.settled,
			) ||
			[...this.state.runs.values()].some(
				(run) =>
					run.phase.kind === "running" ||
					(run.phase.kind === "base_check" && run.phase.checking),
			);

		if (!running() && this.#candidateResults.length === 0) return null;

		while (running()) {
			await this.#observeCandidates(false);
			countLateUsage(this.#input, this.#draining, this.state.totals);
			await this.#reconcileStages(this.#input.clock.now(), limits);

			for (const run of this.state.runs.values()) {
				if (run.phase.kind === "base_check") {
					await this.#pollBase(run);
					await this.#sync(run);
				}

				if (
					run.stage === "accept" &&
					run.phase.kind === "claimed" &&
					run.inflight === null
				)
					await this.#launch(run);
			}

			if (running()) await wait(DRAIN_POLL_MS);
		}

		await Promise.all(this.#stages);
		await this.#observeCandidates(false);
		countLateUsage(this.#input, this.#draining, this.state.totals);

		for (const run of this.state.runs.values()) {
			if (run.phase.kind === "ending" || run.phase.kind === "reporting") {
				await this.#sync(run);
			}
		}

		return this.#report(last);
	}

	async #loadClaims(localReservationsOnly = false): Promise<void> {
		for (const claim of await this.#input.files.listClaims()) {
			if (!this.#inScope(claim.issue)) continue;

			this.#recover.add(claim.issue);

			const seq = claim.seq ?? 0;

			if (seq > (this.#local.get(claim.issue)?.seq ?? 0)) {
				this.#local.set(claim.issue, { ...claim, seq });
			}

			if (claim.status !== null && isTerminal(claim.status)) {
				this.#ended.set(claim.runId, {
					claim: { ...claim, seq },
					tick: 0,
					confirmed: false,
					unwritten: false,
				});
			} else if (
				!localReservationsOnly ||
				!(await unadmitted(this.#input, claim.issue, claim.eventId))
			) {
				this.#reserved.add(claim.issue);

				if (claim.handoff !== undefined) await this.#restoreCandidate(claim);
			}
		}

		this.#claimsLoaded = true;
	}

	async #restoreCandidate(claim: ClaimRecord): Promise<void> {
		const handoff = claim.handoff;

		if (
			handoff === undefined ||
			handoff.pin.runId !== claim.runId ||
			handoff.pin.issue !== claim.issue ||
			handoff.pin.repo !== this.#input.repo
		)
			return;

		const admitted = await this.#input.store.read({
			repo: this.#input.repo,
			issue: claim.issue,
			eventId: claim.eventId,
		});

		if (
			admitted.kind !== "found" ||
			admitted.receipt.baseSha !== handoff.pin.workflowSha ||
			admitted.receipt.workflowDigest !== handoff.pin.workflowDigest
		)
			return;
		const ledger = await this.#readLedger(claim.issue);

		if (ledger.kind !== "ok") return;

		if (ledger.value.kind === "corrupt") {
			this.#markCorrupt(claim.issue, ledger.value, null);

			return;
		}

		const marked =
			ledger.kind === "ok" && ledger.value.kind === "clean"
				? (latestFor(ledger.value, claim.runId)?.marker ?? null)
				: null;

		if (
			marked !== null &&
			isTerminal(marked.status) &&
			marked.seq >= (claim.seq ?? 0)
		) {
			const durable = await this.#freezeRow(marked);
			await this.#keepEnded(
				{
					...claim,
					seq: marked.seq,
					status: marked.status,
					stage: marked.stage,
					attempt: marked.attempt,
					usage: Math.max(candidateUsage(handoff), marked.usage),
				},
				durable,
			);
			this.#reserved.delete(claim.issue);

			return;
		}

		const run: ActiveRun = {
			runId: claim.runId,
			issue: claim.issue,
			eventId: claim.eventId,
			eventAt: admitted.receipt.eventAt,
			snapshotDigest: admitted.receipt.snapshotDigest,
			workflowSha: admitted.receipt.baseSha,
			workflowDigest: admitted.receipt.workflowDigest,
			stage: candidateProjection(handoff).stage,
			attempt: candidateProjection(handoff).attempt,
			round: candidateProjection(handoff).round,
			usage: candidateUsage(handoff),
			seq: claim.seq ?? 0,
			marked,
			inflight: null,
			claimUnwritten: false,
			workspaceMissing: false,
			replay: false,
			unsettled: null,
			adopted: false,
			clearNeedsInfo: false,
			labelFailures: 0,
			labelTick: 0,
			inputs: null,
			phase: { kind: "candidate", status: candidateProjection(handoff).status },
			handoff,
			enteredAt: claim.enteredAt,
		};

		this.state.runs.set(run.issue, run);
		this.#candidateRecovery.add(run.runId);
		this.#reserved.delete(run.issue);
		this.#recover.delete(run.issue);
	}

	async #gate(): Promise<Gate> {
		const reasons: GateReason[] = [];
		const local = await this.#input.store.localSwitch();

		if (local === "unavailable") reasons.push("state_unavailable");

		if (local === "disabled") reasons.push("locally_disabled");

		const reads = await readTickInputs({
			exec: this.#input.exec,
			env: this.#input.env,
			platform: this.#input.platform,
			adapter: this.#adapter,
		});

		if (reads.repoSwitch !== null) {
			reasons.push(
				reads.repoSwitch.kind === "repo_switch_off"
					? "repo_switch_off"
					: "repo_switch_unavailable",
			);
		}

		if (reads.workflow.kind === "loaded") {
			const { snapshot } = reads.workflow;
			this.#config = this.#capped(snapshot.config);
			this.#workflowSha = snapshot.sha;
			this.#trustedRun = {
				digest: snapshot.digest,
				tokens: snapshot.config.usage.maxTokensPerRun,
			};
		} else {
			reasons.push("workflow_unavailable");
		}

		const [first, ...rest] = reasons;

		return first === undefined
			? { kind: "open", reads }
			: { kind: "closed", reasons: [first, ...rest] };
	}

	async #candidates(): Promise<Read<IssueRecord[]>> {
		const read = await this.#adapter.readCandidates();

		if (read.kind === "failed") return read;

		return {
			kind: "ok",
			value: read.value.filter((record) => this.#inScope(record.number)),
		};
	}

	async #reconcileStages(now: number, limits: Limits): Promise<void> {
		for (const run of this.#endExpiredStages(now, limits))
			await this.#sync(run);
	}

	#endExpiredStages(now: number, limits: Limits): ActiveRun[] {
		const ended: ActiveRun[] = [];

		for (const run of this.state.runs.values()) {
			const { phase } = run;

			if (phase.kind === "running" && phase.result !== null) {
				this.#finishStage(run, phase.result, limits);
				ended.push(run);
			} else if (
				phase.kind === "running" &&
				now - phase.lastProgressAt > limits.stallMs(run.stage)
			) {
				phase.abort.abort();
				this.state.totals.stalls++;
				this.#input.log("stage_stalled", {
					issue: run.issue,
					runId: run.runId,
					stage: run.stage,
				});
				this.#endStage(run, "stalled", phase.usage, limits);
				this.#detach(run, phase);
				ended.push(run);
			}
		}

		return ended;
	}

	/** Refreshes every claim against GitHub, before the per-tick reads that gate dispatch. */
	async #reconcileClaims(candidates: Read<IssueRecord[]>): Promise<void> {
		for (const run of this.state.runs.values()) {
			if (run.handoff !== undefined || run.phase.kind === "evidence_missing")
				continue;

			if (run.claimUnwritten) await writeClaim(this.#input, run);

			const observation = this.#observeClaim(
				run,
				candidates.kind === "ok"
					? await this.#checkEligible(run, candidates.value)
					: { kind: "unclaimed" },
			);

			if (observation.kind !== "corrupt") await this.#sync(run);
		}
	}

	/** The only observation writer: deduplicate reasons and keep a continuous hold's age. */
	#observeClaim(
		claim: {
			readonly issue: number;
			readonly runId: Digest;
			readonly eventId: string;
			readonly status?: RunStatus | null;
			readonly seq?: number | null;
		},
		next: ClaimObservation,
	): ClaimObservation {
		const last = this.#observations.get(claim.runId);

		const prior =
			last?.tick === this.#ticks
				? last.previous
				: last?.tick === this.#ticks - 1
					? last.observation
					: undefined;

		const previous =
			last?.tick === this.#ticks && last.observation.kind === "owned_unverified"
				? last.observation
				: prior;

		if (next.kind === "owned_unverified") {
			if (
				previous?.kind !== "owned_unverified" ||
				previous.read !== next.read ||
				previous.failure !== next.failure
			)
				this.#input.log("claim_unverified", {
					issue: claim.issue,
					runId: claim.runId,
					why: next.read,
					failure: next.failure,
				});

			if (previous?.kind === "owned_unverified")
				next = { ...next, since: previous.since };
		} else if (next.kind === "foreign" && !this.#foreignRuns.has(claim.runId)) {
			this.#foreignRuns.add(claim.runId);
			this.#input.log("claim_foreign", {
				issue: claim.issue,
				runId: claim.runId,
				status: claim.status ?? null,
				seq: claim.seq ?? null,
			});
		}

		this.#observations.set(claim.runId, {
			issue: claim.issue,
			eventId: claim.eventId,
			tick: this.#ticks,
			observation: next,
			previous: prior,
		});

		return next;
	}

	#claimView(run: ActiveRun): ReturnType<typeof claimProjection> {
		const held = this.#observations.get(run.runId);

		return claimProjection(
			held?.tick === this.#ticks ? held.observation : { kind: "unclaimed" },
			this.#ticks,
			run.eventId,
		);
	}

	#unverifiedBy(
		read: Unverified["why"],
		failure: GitHubFailure | null,
	): ClaimObservation {
		return {
			kind: "owned_unverified",
			read,
			failure: failure?.kind ?? null,
			since: this.#tickAt,
		};
	}

	#confirmedBy(event: {
		readonly eventId: string;
		readonly seq: number;
	}): ClaimObservation {
		return {
			kind: "owned_confirmed",
			tick: this.#ticks,
			event: event.eventId,
			ledgerSeq: event.seq,
		};
	}

	#timelineObservation(
		timeline: readonly TimelineEntry[],
		event: {
			readonly eventId: string;
			readonly eventAt: string;
			readonly seq: number;
		},
	): ClaimObservation {
		const latest = latestReadyEntry(timeline);

		if (latest.kind === "tied")
			return { kind: "released", reason: "new_event" };

		if (latest.kind === "none")
			return this.#unverifiedBy("timeline_entry", null);
		const { entry } = latest;

		if (entry.kind === "labeled" && entry.id === event.eventId)
			return this.#confirmedBy(event);

		if (entry.at <= event.eventAt)
			return this.#unverifiedBy("timeline_entry", null);

		return {
			kind: "released",
			reason: entry.kind === "unlabeled" ? "unlabeled" : "new_event",
		};
	}

	/**
	 * Confirms a claim against GitHub. An issue that changed since the last
	 * confirmation has its ready event and its marker ledger read again. A read
	 * that fails leaves the claim `unverified`, and an unverified claim does not
	 * launch this tick. A corrupt ledger drops the run from dispatch.
	 */
	async #checkEligible(
		run: ActiveRun,
		candidates: readonly IssueRecord[],
	): Promise<ClaimObservation> {
		if (run.phase.kind === "recovering") {
			const issue = await this.#adapter.readIssue(run.issue);

			if (issue.kind === "failed")
				return this.#unverifiedBy("issue", issue.failure);

			if (!issue.value.open) {
				this.#release(run, "closed");

				return { kind: "released", reason: "closed" };
			}

			if (run.stage === "build" && !this.#enabled) return { kind: "unclaimed" };

			const output =
				run.stage === "build"
					? await this.#input.executor.output({
							runId: run.runId,
							stage: "build",
							attempt: run.attempt,
							round: run.round ?? 0,
						})
					: run.phase.output;

			const recovered = await this.#recoverOutput(run, output);
			const limits = this.#limits();

			if (!recovered && limits !== null)
				this.#endStage(run, "interrupted", 0, limits);

			return { kind: "unclaimed" };
		}

		if (run.phase.kind === "ending" || run.phase.kind === "reporting") {
			return { kind: "unclaimed" };
		}

		let record = candidates.find((item) => item.number === run.issue);

		if (record === undefined) {
			const read = await this.#adapter.readIssue(run.issue);

			if (read.kind === "failed")
				return this.#unverifiedBy("issue", read.failure);

			const issue = read.value;

			if (!isReady(issue)) {
				this.#release(run, issue.open ? "unlabeled" : "closed");

				return {
					kind: "released",
					reason: issue.open ? "unlabeled" : "closed",
				};
			}

			this.#readOpen.add(run.issue);
			record = issue;
		}

		if (!this.#unchanged(run.issue, record.updatedAt)) {
			return this.#recheckChanged(run, record.updatedAt);
		}

		return this.#confirmedBy(run);
	}

	async #recheckChanged(
		run: ActiveRun,
		updatedAt: string,
	): Promise<ClaimObservation> {
		const timeline = await this.#adapter.readTimeline(run.issue);

		if (timeline.kind === "failed")
			return this.#unverifiedBy("timeline", timeline.failure);

		const ledger = await this.#readLedger(run.issue);

		if (ledger.kind === "failed")
			return this.#unverifiedBy("ledger", ledger.failure);

		if (ledger.value.kind === "corrupt") {
			this.#markCorrupt(run.issue, ledger.value, updatedAt);
			this.#drop(run);

			return { kind: "corrupt", defect: ledger.value.defect };
		}

		this.#localAhead(run.issue, ledger.value);
		await this.#confirmEnd(run.issue, ledger.value);

		const observation = this.#timelineObservation(timeline.value, {
			...run,
			seq: ledger.value.markers.at(-1)?.marker.seq ?? 0,
		});

		if (observation.kind === "released") this.#release(run, observation.reason);

		if (observation.kind === "owned_confirmed")
			this.#see(run.issue, updatedAt, { kind: "claimed" });

		return observation;
	}

	/** Stops tracking a run whose ledger turned corrupt. Its claim record stays as evidence. */
	#drop(run: ActiveRun): void {
		this.#abortRunning(run);

		this.state.runs.delete(run.issue);
		this.#input.log("claim_dropped", {
			issue: run.issue,
			runId: run.runId,
			why: "marker_corrupt",
		});
	}

	#release(run: ActiveRun, why: ReleaseReason): void {
		const running =
			run.phase.kind === "running" || run.phase.kind === "base_check";

		this.#abortRunning(run);

		run.phase = { kind: "ending", status: "released" };

		if (running) recordAttempt(run, "aborted");
		this.state.totals.releases++;
		this.state.seen.delete(run.issue);
		this.#input.log("claim_released", {
			issue: run.issue,
			runId: run.runId,
			why,
		});
	}

	/** Aborts a running stage the run is leaving, keeping its usage so far and any it reports later. */
	#abortRunning(run: ActiveRun): void {
		const { phase } = run;

		if (phase.kind === "base_check") {
			phase.abort.abort();

			return;
		}

		if (phase.kind !== "running") return;

		phase.abort.abort();
		run.usage += phase.usage;
		this.state.totals.usage += phase.usage;
		this.#detach(run, phase);
	}

	#detach(run: ActiveRun, phase: RunningPhase): void {
		this.#draining.add({
			run,
			phase,
			since: this.#input.clock.now(),
			counted: phase.usage,
		});
	}

	/**
	 * True while an aborted stage of this run may still report usage: it has
	 * not settled and its cleanup reserve, plus a grace, has not passed. Its
	 * retry and its terminal marker wait, so both carry that usage.
	 */
	#settling(run: ActiveRun): boolean {
		const now = this.#input.clock.now();

		return [...this.#draining].some(
			(entry) =>
				entry.run === run &&
				entry.phase.result === null &&
				now - entry.since < STAGE_CLEANUP_RESERVE_MS + CLEANUP_GRACE_MS,
		);
	}

	/**
	 * Grants the one feedback retry after an author-fixable base refusal: the
	 * next accept attempt, inside the same accept allowance and run cap. False
	 * keeps today's final refusal.
	 */
	async #retryAccept(
		run: ActiveRun,
		reference: AcceptanceQualification,
		progress: Extract<BaseCheckProgress, { kind: "refused" }>,
	): Promise<boolean> {
		const limits = this.#limits();
		const config = this.#config;
		const reason = progress.failure.reason;

		if (
			reference.kind !== "checking" ||
			!retryableBaseReason(reason) ||
			limits === null ||
			config === null
		)
			return false;

		// Every base-check attempt on the refused suite, interruptions included.
		const baseWallMs =
			progress.receipt === undefined ? null : (progress.baseWallMs ?? null);

		const spent = await acceptSpent(
			this.#input,
			run,
			reference,
			reference.acceptAttempt,
		);

		const why =
			reference.acceptAttempt >= limits.maxAttempts
				? "attempts"
				: spent === null || spent >= ACCEPTANCE_MAX_TOKENS
					? "stage_tokens"
					: run.usage >= limits.maxTokensPerRun
						? "run_tokens"
						: baseWallMs === null
							? "base_receipt"
							: config.stages.accept.budget.wallMs -
										(run.acceptWallMs ?? 0) -
										baseWallMs <=
									0
								? "wall"
								: null;

		if (why !== null) {
			this.#input.log("accept_retry_unavailable", {
				issue: run.issue,
				runId: run.runId,
				why,
			});

			return false;
		}

		// The store's exclusive marker makes this the run's only retirement.
		if (
			baseWallMs === null ||
			!(await retireRefused(this.#input, run, reference))
		)
			return false;

		run.baseCheck = {
			...reference,
			kind: "retry_pending",
			retry: {
				refused: reference.binding,
				reason,
				receiptDigest: progress.failure.receiptDigest,
				scenarios: progress.failure.scenarios,
				baseWallMs,
			},
		};
		run.attempt = reference.acceptAttempt + 1;
		run.inputs = null;
		run.replay = false;
		run.phase = { kind: "claimed" };
		this.state.totals.retries++;
		recordAttempt(run, "base_refused", reference.acceptAttempt, {
			kind: "retry",
			attempt: run.attempt,
			dueAt: this.#input.clock.now(),
		});
		this.#input.log("accept_retry", {
			issue: run.issue,
			runId: run.runId,
			reason,
			attempt: run.attempt,
		});

		if (await saveAttempt(this.#input, run)) await writeClaim(this.#input, run);

		return true;
	}

	#finishStage(run: ActiveRun, result: StageEnd, limits: Limits): void {
		const attempt = run.attempt;

		this.#finishStageResult(run, result, limits);

		if (
			run.attemptEnd === undefined &&
			!(run.stage === "accept" && result.kind === "passed")
		)
			recordAttempt(
				run,
				result.kind === "passed"
					? "completed"
					: result.kind === "refused"
						? "refused"
						: result.kind === "budget_exhausted"
							? "budget_stop"
							: "model_failure",
				attempt,
			);
	}

	/**
	 * Ends a run failed, or budget-exhausted for a `budget` cause, and keeps
	 * the cause for its ledger row. Only a failure counts as one.
	 */
	#stop(run: ActiveRun, cause: TerminalCause): void {
		const status = cause.class === "budget" ? "budget_exhausted" : "failed";

		run.phase = { kind: "ending", status };
		run.cause = cause;

		if (status === "failed") this.state.totals.failures++;
	}

	#finishStageResult(run: ActiveRun, result: StageEnd, limits: Limits): void {
		if (run.stage === "accept")
			run.acceptWallMs = (run.acceptWallMs ?? 0) + (result.wallMs ?? 0);

		if (run.stage === "build" && result.build !== undefined) {
			if (
				result.build.kind === "unavailable" ||
				(result.build.kind === "found" &&
					result.build.receipt.policy === "clean" &&
					result.build.receipt.visibleTests?.exitCode == null)
			) {
				this.#input.log("stage_inputs_unavailable", {
					runId: run.runId,
					why:
						result.build.kind === "unavailable"
							? result.build.reason
							: "visible_tests_unavailable",
				});
				this.#endStage(run, "stage_failed", result.usage, limits);

				return;
			}

			run.usage += result.usage;
			this.state.totals.usage += result.usage;

			if (result.build.kind === "found")
				run.phase = {
					kind: "reporting",
					status: "stage_passed",
					effects: { kind: "build", result: result.build },
				};
			else {
				const why =
					result.build.kind === "blocked"
						? result.build.reason
						: "patch_missing";

				this.#input.log("stage_inputs_refused", { runId: run.runId, why });
				this.#stop(run, inputCause(run.stage, why));
			}

			return;
		}

		if (
			result.kind === "failed" ||
			(run.stage === "build" && result.kind === "passed")
		) {
			this.#endStage(run, "stage_failed", result.usage, limits);

			return;
		}

		if (
			result.kind === "passed" &&
			(run.stage === "specify" || run.stage === "accept")
		) {
			const reporting =
				run.stage === "specify"
					? specified(this.#input, run, result.output)
					: accepted(
							this.#input,
							this.#config,
							run,
							result.output,
							result.model,
							result.observed,
							result.family,
						);

			if (reporting === null) {
				this.#endStage(run, "stage_failed", result.usage, limits);

				return;
			}

			run.usage += result.usage;
			this.state.totals.usage += result.usage;
			run.phase = reporting;
			this.#input.log("stage_ended", {
				issue: run.issue,
				runId: run.runId,
				cause: result.kind,
				next: reporting.status,
				attempt: run.attempt,
			});

			return;
		}

		run.usage += result.usage;
		this.state.totals.usage += result.usage;

		const status = END_STATUS[result.kind];

		if (result.kind === "budget_exhausted")
			this.#stop(
				run,
				budgetCause(
					run.stage,
					result.cap === undefined ? null : SANDBOX_CAPS[result.cap],
				),
			);
		else if (result.kind === "refused")
			this.#stop(run, {
				stage: run.stage,
				class: "provider",
				reason: result.refusal ?? "refused",
			});
		else run.phase = { kind: "ending", status };
		this.#input.log("stage_ended", {
			issue: run.issue,
			runId: run.runId,
			cause: result.kind,
			next: status,
			attempt: run.attempt,
		});
	}

	#endStage(
		run: ActiveRun,
		cause: RetryCause,
		usage: number,
		limits: Limits,
	): void {
		const attempt = run.attempt;

		run.usage += usage;
		this.state.totals.usage += usage;

		if (run.usage >= limits.maxTokensPerRun) {
			this.#stop(run, budgetCause(run.stage, "run_tokens"));
		} else if (run.attempt >= limits.maxAttempts) {
			this.#stop(run, { stage: run.stage, class: "attempts", reason: cause });
		} else {
			run.attempt++;
			this.state.totals.retries++;
			run.phase = {
				kind: "retry_queued",
				dueAt:
					this.#input.clock.now() +
					backoffMs(run.attempt - 1, limits.maxBackoffMs),
			};
		}

		recordAttempt(
			run,
			cause === "interrupted" ? "interrupted" : "model_failure",
			attempt,
		);
		this.#input.log("stage_ended", {
			issue: run.issue,
			runId: run.runId,
			cause,
			next: desiredStatus(run.phase),
			attempt: run.attempt,
		});
	}

	async #confirmEnd(issue: number, ledger: CleanLedger): Promise<void> {
		const ledgerSeq = ledger.markers.at(-1)?.marker.seq ?? 0;

		for (const ended of this.#ended.values()) {
			if (ended.claim.issue !== issue) continue;

			ended.tick = this.#ticks;
			const marker = latestFor(ledger, ended.claim.runId)?.marker;

			const durable =
				marker === undefined ||
				marker.seq !== ended.claim.seq ||
				(await this.#freezeRow(marker));

			ended.confirmed ||= ledgerSeq >= ended.claim.seq && durable;
		}
	}

	async #confirmEnds(): Promise<void> {
		const issues = new Set<number>();

		for (const ended of this.#ended.values()) {
			if (ended.unwritten) await writeEnded(this.#input, ended);

			if (!ended.confirmed && ended.tick < this.#ticks) {
				issues.add(ended.claim.issue);
			}
		}

		for (const issue of issues) {
			const ledger = await this.#readLedger(issue);

			if (ledger.kind === "failed") continue;

			if (ledger.value.kind === "corrupt") {
				this.#markCorrupt(issue, ledger.value, null);
				continue;
			}

			this.#localAhead(issue, ledger.value);
			await this.#confirmEnd(issue, ledger.value);
		}
	}

	#capped(config: WorkflowConfig): WorkflowConfig {
		const verification = this.#input.verification ?? null;

		return verification === null
			? config
			: {
					...config,
					usage: {
						maxTokensPerRun: Math.min(
							verification.tokenCap,
							config.usage.maxTokensPerRun,
						),
					},
				};
	}

	async #previousRunId(runId: Digest): Promise<Digest | null | undefined> {
		const link = await this.#input.files.readLink(runId);

		return link.kind === "found"
			? link.link.prevRunId
			: link.kind === "unlinked"
				? null
				: undefined;
	}

	/** The current generation's stored diagnosis, when it is a bound failure. */
	async #currentDiagnosis(runId: Digest, state: CandidateState) {
		if (state.kind !== "selected") return null;
		const { round, generation } = state.current.intent;

		const read = await this.#input.executor
			.readAssessment({ runId, round, generation })
			.catch(() => null);

		const bound = state.current.assessment;

		return read != null &&
			read.binding.runId === runId &&
			read.binding.round === round &&
			read.binding.generation === generation &&
			(bound === undefined || sameAssessmentRef(read.ref, bound)) &&
			read.assessment.kind === "failed"
			? read.assessment.failure
			: null;
	}

	async #prepareTerminal(run: ActiveRun): Promise<boolean> {
		const ledger = this.#input.files.ledger;
		const status = desiredStatus(run.phase);

		if (ledger === undefined || !isTerminal(status)) return true;
		const fields = { issue: run.issue, runId: run.runId };
		const observedAt = new Date(this.#input.clock.now()).toISOString();
		let snapshot: JsonValue;

		try {
			const start = await this.#input.files.accounting?.start(run.runId);

			if (this.#input.files.accounting !== undefined && start === undefined)
				throw new LedgerRowError("run_context_unreadable");
			snapshot = terminalSnapshot({
				repo: this.#input.repo,
				runId: run.runId,
				issue: run.issue,
				eventId: run.eventId,
				eventAt: run.eventAt,
				snapshotDigest: run.snapshotDigest,
				workflowSha: run.workflowSha,
				workflowDigest: run.workflowDigest,
				status,
				stage: run.stage,
				usage: run.usage,
				observedAt,
				candidate: run.handoff ?? null,
				attemptEnds: await this.#input.files.accounting?.attempts(run.runId),
				cause:
					run.handoff === undefined
						? (run.cause ?? null)
						: run.handoff.kind === "selected" &&
								run.handoff.work.kind === "terminal" &&
								run.handoff.work.terminal.kind === "failed" &&
								(run.handoff.work.terminal.reason ===
									"review_input_too_large" ||
									run.handoff.work.terminal.reason === "summary_too_large")
							? inputCause(
									run.handoff.work.terminal.reason === "review_input_too_large"
										? "review"
										: "land",
									run.handoff.work.terminal.reason,
								)
							: candidateCause(
									run.handoff,
									await this.#currentDiagnosis(run.runId, run.handoff),
								),
				start,
				previousRunId: await this.#previousRunId(run.runId),
				evidence: await this.#input.files.terminalEvidence?.(
					run.runId,
					run.usage,
					run.handoff ?? null,
				),
				context:
					start?.context ??
					legacyRunContext(
						{
							workflowSha: run.workflowSha,
							workflowDigest: run.workflowDigest,
						},
						"receipt_missing",
					),
				terminalWorkflowObservation:
					this.#workflowSha === null || this.#trustedRun === null
						? null
						: {
								workflowSha: this.#workflowSha,
								workflowDigest: this.#trustedRun.digest,
							},
			});
		} catch (error) {
			if (!(error instanceof LedgerRowError)) throw error;
			this.#input.log("ledger_row_invalid", { ...fields, reason: error.code });
			await ledger.block(run.runId, observedAt);

			return false;
		}

		if (await ledger.prepare(run.runId, snapshot)) return true;
		this.#input.log("ledger_terminal_unwritable", fields);

		return false;
	}

	/** False only while a frozen row could not yet be made durable; later ticks retry it. */
	async #freezeRow(marker: Marker): Promise<boolean> {
		const ledger = this.#input.files.ledger;

		if (ledger === undefined || !isTerminal(marker.status)) return true;

		const frozen = await ledger.freeze(marker.runId, {
			seq: marker.seq,
			digest: digestOf(formatMarker(marker)),
		});

		if (frozen === "invalid" || frozen === "unwritable")
			this.#input.log("ledger_row_unfrozen", {
				issue: marker.issue,
				runId: marker.runId,
				reason: frozen,
			});

		if (frozen === "frozen" && this.#config !== null) {
			try {
				this.#input.measurement?.terminal(marker.runId, this.#config);
			} catch {
				this.#input.log("measurement_failed", {
					runId: marker.runId,
					reason: "enrollment_unavailable",
				});
			}
		}

		return frozen !== "unwritable";
	}

	async #keepEnded(claim: ConfirmedRecord, confirmed: boolean): Promise<void> {
		const ended: EndedRecord = {
			claim,
			tick: this.#ticks,
			confirmed,
			unwritten: false,
		};

		this.#ended.set(claim.runId, ended);

		if (claim.seq > (this.#local.get(claim.issue)?.seq ?? 0)) {
			this.#local.set(claim.issue, claim);
		}

		await writeEnded(this.#input, ended);
	}

	#endedLocally(issue: number, runId: Digest): boolean {
		const local = this.#local.get(issue);

		return (
			this.#ended.has(runId) ||
			(local?.runId === runId &&
				local.status !== null &&
				isTerminal(local.status))
		);
	}

	async #readLedger(
		issue: number,
		discovering = false,
	): Promise<Read<MarkerLedger>> {
		const comments = await this.#adapter.readComments(issue);

		if (comments.kind === "failed") {
			if (discovering)
				await this.#observeUnreadLedger(issue, comments.failure, []);

			return comments;
		}

		const controller = comments.value.filter((comment) =>
			isControllerComment(comment, this.#input.platform),
		);

		const edits = await this.#adapter.readCommentEdits(
			controller.map((comment) => comment.nodeId),
		);

		if (edits.kind === "failed") {
			if (discovering)
				await this.#observeUnreadLedger(issue, edits.failure, controller);

			return edits;
		}

		return {
			kind: "ok",
			value: markerLedger({
				repo: this.#input.repo,
				issue,
				comments: comments.value,
				edits: edits.value,
				identity: this.#input.platform,
			}),
		};
	}

	/** Unchecked marker bodies are identity hints for a diagnostic, never permission to adopt. */
	async #observeUnreadLedger(
		issue: number,
		failure: GitHubFailure,
		comments: readonly IssueComment[],
	): Promise<void> {
		const local = this.#local.get(issue);

		if (
			local !== undefined &&
			(local.status === null || !isTerminal(local.status)) &&
			!(await unadmitted(this.#input, issue, local.eventId))
		)
			this.#observeClaim(local, this.#unverifiedBy("ledger", failure));

		if (local === undefined) {
			for (const [runId, known] of this.#observations) {
				if (
					known.issue === issue &&
					!this.#ended.has(runId) &&
					(known.observation.kind === "owned_confirmed" ||
						known.observation.kind === "owned_unverified") &&
					!(await unadmitted(this.#input, issue, known.eventId))
				)
					this.#observeClaim(
						{ issue, runId, eventId: known.eventId },
						this.#unverifiedBy("ledger", failure),
					);
			}
		}

		const newest = comments
			.flatMap((comment) => {
				const parsed = parseMarker(comment.body);

				return parsed.kind === "marker" &&
					parsed.marker.repo === this.#input.repo &&
					parsed.marker.issue === issue
					? [parsed.marker]
					: [];
			})
			.sort((a, b) => b.seq - a.seq)[0];

		if (
			newest === undefined ||
			isTerminal(newest.status) ||
			newest.runId === local?.runId
		)
			return;

		const admission = await this.#input.store.read({
			repo: this.#input.repo,
			issue,
			eventId: newest.eventId,
		});

		if (admission.kind === "found" && matchesRecord(newest, admission.receipt))
			this.#observeClaim(newest, this.#unverifiedBy("ledger", failure));
	}

	#markCorrupt(
		issue: number,
		ledger: Extract<MarkerLedger, { kind: "corrupt" }>,
		updatedAt: string | null,
	): void {
		this.state.corrupt.set(issue, {
			defect: ledger.defect,
			commentId: ledger.commentId,
		});

		if (updatedAt !== null) {
			this.#see(issue, updatedAt, { kind: "corrupt" });
		}

		this.#input.log("marker_corrupt", {
			issue,
			defect: ledger.defect,
			commentId: ledger.commentId,
		});
	}

	#localAhead(issue: number, ledger: CleanLedger): ConfirmedRecord | null {
		const local = this.#local.get(issue);
		const ledgerSeq = ledger.markers.at(-1)?.marker.seq ?? 0;

		if (local === undefined || local.seq <= ledgerSeq) {
			this.#behind.delete(issue);

			return null;
		}

		const behind = { issue, ledgerSeq, localSeq: local.seq };
		const known = this.#behind.get(issue);

		if (known?.ledgerSeq !== ledgerSeq || known.localSeq !== local.seq) {
			this.#behind.set(issue, behind);
			this.#input.log("ledger_behind", behind);
		}

		return local;
	}

	#seqFloor(issue: number, ledger: CleanLedger): number {
		return Math.max(
			ledger.markers.at(-1)?.marker.seq ?? 0,
			this.#local.get(issue)?.seq ?? 0,
		);
	}

	async #discover(
		candidates: readonly IssueRecord[],
		queued: number[],
	): Promise<IssueRecord[]> {
		const records = new Map(
			candidates.map((record) => [record.number, record]),
		);

		const direct: IssueRecord[] = [];

		for (const issue of this.#recover) {
			if (this.state.runs.has(issue)) {
				this.#resolve(issue);
				continue;
			}

			if (records.has(issue)) continue;

			const read = await this.#adapter.readIssue(issue);

			if (read.kind !== "ok") {
				const local = this.#local.get(issue);

				if (local !== undefined)
					this.#observeClaim(local, this.#unverifiedBy("issue", read.failure));
				continue;
			}

			records.set(issue, read.value);

			if (isReady(read.value)) {
				this.#readOpen.add(issue);
				direct.push(read.value);
			}
		}

		for (const record of records.values()) {
			const issue = record.number;

			if (this.state.runs.has(issue)) continue;

			if (this.#unchanged(issue, record.updatedAt)) {
				continue;
			}

			const ledger = await this.#readLedger(issue, true);

			if (ledger.kind === "failed") continue;

			if (ledger.value.kind === "corrupt") {
				const local = this.#local.get(issue);

				if (local !== undefined)
					this.#observeClaim(local, {
						kind: "corrupt",
						defect: ledger.value.defect,
					});
				this.#resolve(issue);
				this.#markCorrupt(issue, ledger.value, record.updatedAt);
				continue;
			}

			this.state.corrupt.delete(issue);
			await this.#confirmEnd(issue, ledger.value);

			const local = this.#localAhead(issue, ledger.value);

			const current =
				local === null
					? currentMarker(ledger.value)
					: await localMarker(this.#input, local, ledger.value);

			if (local !== null && current === null) {
				if (await unadmitted(this.#input, issue, local.eventId))
					this.#resolve(issue);

				continue;
			}

			const candidate =
				isReady(record) || (record.open && candidates.includes(record));

			const ownership =
				current !== null && !isTerminal(current.status)
					? await this.#ownershipOf(current)
					: { kind: "unclaimed" };

			const foreign = ownership.kind === "foreign";

			if (current !== null && !isTerminal(current.status) && !foreign) {
				const eligibility = await this.#eligibilityOf(
					current,
					record,
					candidate,
				);

				if (this.#waits(current.status, eligibility)) {
					this.#recover.add(issue);
					this.#reserved.add(issue);
					queued.push(issue);
					continue;
				}

				const adopted = await this.#adoptExistingRun({
					marker: current,
					ledger: ledger.value,
					issue: record,
					eligibility,
				});

				if (adopted === null) {
					if (this.state.corrupt.has(issue)) this.#resolve(issue);
					continue;
				}

				if (this.state.runs.has(issue)) {
					this.#resolve(issue);
					continue;
				}
			}

			const settled = await this.#settleClaims(
				ledger.value,
				record,
				candidate,
				foreign,
			);

			if (settled === "refused") {
				this.#reserved.delete(issue);
				continue;
			}

			if (
				foreign &&
				settled === "resolved" &&
				(await unmarkedEvents(this.#input, issue, ledger.value))?.length === 0
			) {
				this.#resolve(issue);
				this.#see(issue, record.updatedAt, { kind: "decided" });
				continue;
			}

			if (settled === "resolved" || settled === "corrupt") {
				this.#resolve(issue);
			} else {
				this.#recover.add(issue);
				this.#reserved.add(issue);
			}

			if (settled === "undecided" || settled === "corrupt") continue;

			if (!candidate) {
				this.#see(issue, record.updatedAt, { kind: "decided" });
				continue;
			}

			this.#see(issue, record.updatedAt, {
				kind: "open",
				ledger: ledger.value,
			});
		}

		return direct;
	}

	/**
	 * A live marker whose event has no admission record under this state
	 * directory belongs to another controller. It is left alone: nothing is
	 * adopted for it, no release is posted, and neither a new event nor an own
	 * unmarked admission is claimed while it is the newest marker.
	 */
	async #ownershipOf(marker: Marker): Promise<ClaimObservation> {
		return (await unadmitted(this.#input, marker.issue, marker.eventId))
			? this.#observeClaim(marker, { kind: "foreign", runId: marker.runId })
			: { kind: "unclaimed" };
	}

	#resolve(issue: number): void {
		this.#recover.delete(issue);
		this.#reserved.delete(issue);
	}

	#active(): number {
		return (
			[...this.state.runs.values()].filter(holdsSlot).length +
			(this.#input.cadence?.occupied() ?? 0) +
			(this.#input.measurement?.occupied() ?? 0)
		);
	}

	#freeSlots(): number {
		const reserved = [...this.#reserved].filter(
			(issue) => !this.state.runs.has(issue),
		).length;

		return Math.max(
			(this.#limits()?.maxConcurrent ?? 0) - this.#active() - reserved,
			0,
		);
	}

	#limits(): Limits | null {
		return this.#config === null ? null : limitsOf(this.#config);
	}

	#fits(status: RunStatus): boolean {
		const limits = this.#limits();

		if (limits === null) return false;

		return !holdsSlotAs(status) || this.#active() < limits.maxConcurrent;
	}

	#waits(status: RunStatus, eligibility: ClaimObservation): boolean {
		if (eligibility.kind === "owned_confirmed") return !this.#fits(status);

		if (eligibility.kind === "owned_unverified") {
			return !holdsSlotAs(status) || !this.#fits(status);
		}

		return false;
	}

	async #eligibilityOf(
		marker: Marker,
		record: IssueRecord,
		candidate: boolean,
	): Promise<ClaimObservation> {
		if (!candidate)
			return this.#observeClaim(marker, {
				kind: "released",
				reason: record.open ? "unlabeled" : "closed",
			});

		const timeline = await this.#adapter.readTimeline(marker.issue);

		if (timeline.kind === "failed")
			return this.#observeClaim(
				marker,
				this.#unverifiedBy("timeline", timeline.failure),
			);

		return this.#observeClaim(
			marker,
			this.#timelineObservation(timeline.value, marker),
		);
	}

	async #settleClaims(
		ledger: CleanLedger,
		record: IssueRecord,
		candidate: boolean,
		foreign: boolean,
	): Promise<"held" | "resolved" | "refused" | "undecided" | "corrupt"> {
		let settled: "held" | "resolved" | "refused" = "resolved";
		let timeline: Read<TimelineEntry[]> | null = null;

		for (const claim of await this.#input.files.listClaims()) {
			if (claim.issue !== record.number || this.#ended.has(claim.runId)) {
				continue;
			}

			const latest = latestFor(ledger, claim.runId)?.marker ?? null;

			if (latest !== null && isTerminal(latest.status)) {
				if (!(await this.#matchesAdmission(latest, record.updatedAt, true))) {
					return this.state.corrupt.has(record.number)
						? "corrupt"
						: "undecided";
				}

				await this.#keepEnded(
					{ ...claim, ...recordOf(latest) },
					await this.#freezeRow(latest),
				);
				continue;
			}

			if (
				foreign ||
				(latest === null &&
					(await unadmitted(this.#input, claim.issue, claim.eventId)))
			) {
				if (settled === "resolved") settled = "refused";
				continue;
			}

			let why: ReleaseReason | null = record.open ? "unlabeled" : "closed";

			if (candidate && latest === null) {
				timeline ??= await this.#adapter.readTimeline(record.number);

				if (timeline.kind === "failed") {
					this.#observeClaim(
						claim,
						this.#unverifiedBy("timeline", timeline.failure),
					);

					return "undecided";
				}

				const admitted = await admittedFields(this.#input, claim);

				if (admitted === null) return "undecided";

				const observation = this.#observeClaim(
					claim,
					this.#timelineObservation(timeline.value, {
						eventId: claim.eventId,
						eventAt: admitted.eventAt,
						seq: this.#seqFloor(claim.issue, ledger),
					}),
				);

				if (observation.kind === "owned_unverified") return "undecided";

				why = observation.kind === "released" ? observation.reason : null;
			} else if (candidate) {
				why = null;
			}

			if (why === null) {
				settled = "held";
			} else if (
				!(await this.#releaseClaim({
					claim,
					marked: latest,
					ledger,
					record,
					why,
				}))
			) {
				return "undecided";
			}
		}

		return settled;
	}

	async #releaseClaim(input: {
		claim: ClaimRecord;
		marked: Marker | null;
		ledger: CleanLedger;
		record: IssueRecord;
		why: ReleaseReason;
	}): Promise<boolean> {
		const { claim, marked, ledger } = input;

		if (this.state.runs.has(claim.issue)) return false;

		const base = marked ?? (await admittedFields(this.#input, claim));

		if (base === null) return false;

		const run: ActiveRun = {
			runId: claim.runId,
			issue: claim.issue,
			eventId: claim.eventId,
			eventAt: base.eventAt,
			snapshotDigest: base.snapshotDigest,
			workflowSha: base.workflowSha,
			workflowDigest: base.workflowDigest,
			stage: base.stage,
			attempt: base.attempt,
			usage: base.usage,
			seq: this.#seqFloor(claim.issue, ledger),
			marked,
			inflight: null,
			claimUnwritten: false,
			workspaceMissing: false,
			replay: false,
			unsettled: null,
			round: claim.round ?? 0,
			adopted: true,
			clearNeedsInfo: false,
			labelFailures: 0,
			labelTick: 0,
			inputs: null,
			phase: { kind: "claimed" },
		};

		this.state.runs.set(run.issue, run);

		if (marked !== null) {
			await accountAdopted(
				this.#input,
				this.state.totals,
				run,
				marked,
				ledger,
				marked.status === "running",
			);
		}

		this.#release(run, input.why);
		await this.#sync(run);

		return true;
	}

	async #matchesAdmission(
		marker: Marker,
		updatedAt: string,
		ended = false,
	): Promise<boolean> {
		const record = await this.#input.store.read({
			repo: this.#input.repo,
			issue: marker.issue,
			eventId: marker.eventId,
		});

		if (record.kind === "unreadable") return false;

		if (record.kind === "absent") return ended;

		if (record.kind === "found" && !matchesRecord(marker, record.receipt)) {
			this.#markCorrupt(
				marker.issue,
				{ kind: "corrupt", defect: "record_mismatch", commentId: "" },
				updatedAt,
			);

			return false;
		}

		return true;
	}

	/**
	 * Adopts the live run a marker names. It returns `null` when the run cannot
	 * be adopted. A run that ends in this call, such as one released for a new
	 * ready event, is no longer in `runs`, and its issue can be claimed again in
	 * the same tick.
	 */
	async #adoptExistingRun(input: {
		marker: Marker;
		ledger: CleanLedger;
		issue: IssueRecord;
		eligibility: ClaimObservation;
	}): Promise<ActiveRun | null> {
		const { marker, ledger, eligibility } = input;

		if (!(await this.#matchesAdmission(marker, input.issue.updatedAt))) {
			return null;
		}

		const workspace = await this.#input.files.workspaceState(marker.runId);
		const seq = this.#seqFloor(marker.issue, ledger);
		const local = this.#local.get(marker.issue);

		const run: ActiveRun = {
			runId: marker.runId,
			issue: marker.issue,
			eventId: marker.eventId,
			eventAt: marker.eventAt,
			snapshotDigest: marker.snapshotDigest,
			workflowSha: marker.workflowSha,
			workflowDigest: marker.workflowDigest,
			stage: marker.stage,
			attempt: marker.attempt,
			usage: marker.usage,
			seq,
			marked: marker,
			inflight: null,
			claimUnwritten: false,
			workspaceMissing: workspace === "missing",
			replay: true,
			unsettled: null,
			adopted: true,
			clearNeedsInfo:
				input.issue.labels.includes(NEEDS_INFO_LABEL) &&
				(await this.#input.files.readLink(marker.runId)).kind === "found",
			labelFailures:
				local?.runId === marker.runId ? (local.labelFailures ?? 0) : 0,
			labelTick: 0,
			inputs: null,
			round: Math.max(
				marker.round ?? 0,
				local?.runId === marker.runId ? (local.round ?? 0) : 0,
			),
			phase:
				marker.status === "blocked"
					? { kind: "blocked", reason: "sandbox_unavailable" }
					: { kind: "claimed" },
		};

		if (
			marker.v === 3 ||
			marker.candidate != null ||
			marker.handoff !== undefined ||
			marker.stage === "validate" ||
			marker.stage === "review" ||
			marker.stage === "land" ||
			(run.round ?? 0) > 0
		) {
			if (marker.pr === null)
				this.#stop(run, {
					stage: run.stage,
					class: "missing_evidence",
					reason: "validation_state_missing",
				});
			else run.phase = { kind: "evidence_missing" };
			this.#input.log("validation_failed", {
				issue: run.issue,
				runId: run.runId,
				why: "validation_state_missing",
			});
			this.state.runs.set(run.issue, run);
			await this.#sync(run);

			return run;
		}

		if (local?.runId === run.runId) {
			run.baseCheck = local.baseCheck;
			run.acceptWallMs = local.acceptWallMs;
			const reference = run.baseCheck;

			// A granted retry awaiting its new suite: finish the retirement before
			// anything reads the suite, then relaunch it once. A marker already past
			// the refused attempt adopts that retry attempt as usual.
			if (
				reference?.retry !== undefined &&
				retryPending(reference) &&
				run.stage === "accept"
			) {
				// A claim records only author reasons; never relaunch any other.
				const retired =
					retryableBaseReason(reference.retry.reason) &&
					(await retireRefused(this.#input, run, reference));

				if (!retired || marker.attempt <= reference.acceptAttempt) {
					const unmarked = Math.max(0, (local.usage ?? 0) - run.usage);
					run.usage += unmarked;
					this.state.totals.usage += unmarked;
					run.attempt = reference.acceptAttempt + 1;
					run.adopted = false;
					run.replay = false;
					run.phase = { kind: "claimed" };

					if (!retired)
						this.#stop(run, {
							stage: "accept",
							class: "base",
							reason: reference.retry.reason,
						});

					this.state.runs.set(run.issue, run);

					if (eligibility.kind === "released")
						this.#release(run, eligibility.reason);
					await writeClaim(this.#input, run);
					await this.#sync(run);

					return run;
				}
			} else if (run.baseCheck !== undefined && run.stage === "accept") {
				const unmarked = Math.max(0, (local.usage ?? 0) - run.usage);
				run.usage += unmarked;
				this.state.totals.usage += unmarked;
				run.attempt = run.baseCheck.acceptAttempt;
				const ends = await this.#input.files.accounting?.attempts(run.runId);

				const last = ends
					?.filter((end) => end.stage === "accept")
					.sort((a, b) => b.attempt - a.attempt)[0];

				if (last?.next.kind === "base_retry") {
					run.attempt = last.next.attempt;
					run.baseCheck = { ...run.baseCheck, acceptAttempt: run.attempt };
				}

				run.adopted = false;
				run.replay = false;
				run.phase = {
					kind: "base_check",
					abort: new AbortController(),
					dueAt: last?.next.kind === "base_retry" ? last.next.dueAt : 0,
					checking: true,
				};
				this.state.runs.set(run.issue, run);

				if (eligibility.kind === "released")
					this.#release(run, eligibility.reason);
				await this.#sync(run);

				return run;
			}
		}

		this.state.runs.set(run.issue, run);
		this.#local.set(run.issue, { ...claimOf(run), seq });
		await writeClaim(this.#input, run);

		this.#input.log("claim_adopted", {
			issue: run.issue,
			runId: run.runId,
			status: marker.status,
			seq,
			workspace,
		});

		const limits = this.#limits();
		const releasing = eligibility.kind === "released";

		const ended = await this.#input.files.accounting?.readAttempt(
			run.runId,
			run.stage,
			run.round ?? 0,
			run.attempt,
		);

		if (this.#input.files.accounting !== undefined && ended === undefined) {
			run.phase = { kind: "evidence_missing" };

			return run;
		}

		if (ended != null && !releasing) {
			await accountAdopted(
				this.#input,
				this.state.totals,
				run,
				marker,
				ledger,
				marker.status === "running",
			);
			run.usage = Math.max(run.usage, ended.usage);
			run.attemptEnd = ended;
			const next = ended.next;

			if (next.kind === "retry") {
				run.attempt = next.attempt;
				run.phase = { kind: "retry_queued", dueAt: next.dueAt };
			} else if (next.kind === "end")
				run.phase = { kind: "ending", status: next.status };
			else if (next.kind === "continue") {
				const output = isModelStage(run.stage)
					? await this.#input.executor.output({
							runId: run.runId,
							stage: run.stage,
							attempt: run.attempt,
							round: run.round ?? 0,
							workflowSha: run.workflowSha,
							workflowDigest: run.workflowDigest,
						})
					: null;

				if (!(await this.#recoverOutput(run, output)))
					run.phase = { kind: "evidence_missing" };
			}

			await this.#sync(run);

			return run;
		}

		const output =
			(run.round ?? 0) === (marker.round ?? 0) &&
			marker.status === "running" &&
			isModelStage(run.stage)
				? await this.#input.executor
						.output({
							runId: run.runId,
							stage: run.stage,
							attempt: run.attempt,
							round: run.round ?? 0,
							workflowSha: run.workflowSha,
							workflowDigest: run.workflowDigest,
						})
						.catch(() => null)
				: null;

		await accountAdopted(
			this.#input,
			this.state.totals,
			run,
			marker,
			ledger,
			marker.status === "running" &&
				(releasing || limits !== null) &&
				(releasing ||
					run.stage === "build" ||
					!(output instanceof Object && output.kind === "pending")),
		);

		const recovered =
			limits !== null &&
			marker.status === "running" &&
			!(
				eligibility.kind === "released" &&
				(eligibility.reason === "closed" || eligibility.reason === "new_event")
			) &&
			(await this.#recoverOutput(run, output));

		if (recovered) {
			this.#input.log(
				run.phase.kind === "recovering"
					? "stage_recovery_wait"
					: "stage_recovered",
				{
					issue: run.issue,
					runId: run.runId,
					attempt: run.attempt,
					next: desiredStatus(run.phase),
				},
			);
		} else if (eligibility.kind === "released") {
			this.#release(run, eligibility.reason);
		} else if (
			limits !== null &&
			marker.status === "running" &&
			(run.round ?? 0) === (marker.round ?? 0)
		) {
			this.#endStage(run, "interrupted", 0, limits);
		} else if (limits !== null && marker.status === "retrying") {
			const created = ledger.markers.find(
				({ marker: entry }) =>
					entry.runId === marker.runId &&
					entry.status === "retrying" &&
					entry.attempt === marker.attempt,
			)?.createdAt;

			run.phase = {
				kind: "retry_queued",
				dueAt:
					(created === undefined ? this.#tickAt : Date.parse(created)) +
					backoffMs(Math.max(run.attempt - 1, 1), limits.maxBackoffMs),
			};
		}

		if (eligibility.kind === "owned_confirmed") {
			this.#see(run.issue, input.issue.updatedAt, { kind: "claimed" });
		}

		await this.#sync(run);

		return run;
	}

	async #dispatch(input: {
		now: number;
		candidates: readonly IssueRecord[];
		direct: readonly IssueRecord[];
		reads: TickReads;
		limits: Limits;
		queued: number[];
		refused: { issue: number; reasons: RefusalReason["kind"][] }[];
	}): Promise<void> {
		const { now, limits } = input;
		const runs = [...this.state.runs.values()];

		for (const record of [...input.candidates, ...input.direct]) {
			const issue = record.number;
			const seen = this.state.seen.get(issue);

			if (
				!this.#reserved.has(issue) ||
				this.state.runs.has(issue) ||
				seen?.verdict.kind !== "open"
			) {
				continue;
			}

			if (this.#active() >= limits.maxConcurrent) {
				input.queued.push(issue);
				continue;
			}

			await this.#claim(record, seen.verdict.ledger, input);

			if (
				this.state.runs.has(issue) ||
				this.state.seen.get(issue)?.verdict.kind !== "open"
			) {
				this.#resolve(issue);
			}
		}

		for (const run of runs) {
			if (run.phase.kind === "base_check" && this.#claimView(run).launch) {
				await this.#pollBase(run);
				await this.#sync(run);
				continue;
			}

			if (
				run.inflight === null &&
				this.#claimView(run).launch &&
				(run.phase.kind === "claimed" ||
					(run.phase.kind === "blocked" && (run.replay || this.#enabled)))
			) {
				await this.#launch(run);
			}
		}

		let slots = this.#freeSlots();

		for (const run of runs) {
			if (
				run.phase.kind !== "retry_queued" ||
				run.phase.dueAt > now ||
				run.inflight !== null ||
				!this.#claimView(run).launch ||
				this.#settling(run)
			) {
				continue;
			}

			if (run.attempt > limits.maxAttempts) {
				this.#stop(run, {
					stage: run.stage,
					class: "attempts",
					reason: "retry_limit",
				});
				await this.#sync(run);
				continue;
			}

			if (slots === 0) continue;

			if (await this.#launch(run)) slots--;
		}

		for (const record of input.candidates) {
			const issue = record.number;
			const seen = this.state.seen.get(issue);

			if (
				this.state.runs.has(issue) ||
				this.#reserved.has(issue) ||
				seen?.verdict.kind !== "open"
			) {
				continue;
			}

			if (slots === 0) {
				input.queued.push(issue);
				continue;
			}

			if (await this.#claim(record, seen.verdict.ledger, input)) slots--;
		}
	}

	async #claim(
		record: IssueRecord,
		ledger: CleanLedger,
		input: {
			reads: TickReads;
			refused: { issue: number; reasons: RefusalReason["kind"][] }[];
		},
	): Promise<boolean> {
		const claimed = await this.#admit({
			record,
			ledger,
			reads: input.reads,
			refused: input.refused,
		});

		if (claimed === null) return false;

		if (claimed.inflight === null) await this.#launch(claimed);

		return claimed.phase.kind !== "ending";
	}

	/**
	 * Finds an admission this controller recorded for the issue's current ready
	 * event but never marked, such as after a crash before the first marker. It
	 * is adopted with its original snapshot and workflow binding, so a later
	 * edit to the issue cannot strand it. The timeline is read only when such a
	 * record exists.
	 */
	async #recordedAdmission(
		record: IssueRecord,
		ledger: CleanLedger,
	): Promise<
		| { readonly kind: "found"; readonly receipt: AdmittedReceipt }
		| { readonly kind: "none" }
		| { readonly kind: "ended" }
		| { readonly kind: "defer" }
	> {
		const repo = this.#input.repo;
		const issue = record.number;
		const unmarked = await unmarkedEvents(this.#input, issue, ledger);

		if (unmarked === null) return { kind: "defer" };

		if (unmarked.length === 0) return { kind: "none" };

		const timeline = await this.#adapter.readTimeline(issue);

		if (timeline.kind === "failed") return { kind: "defer" };

		const latest = latestReadyEntry(timeline.value);

		if (
			latest.kind !== "found" ||
			latest.entry.kind !== "labeled" ||
			!unmarked.includes(latest.entry.id)
		) {
			return { kind: "none" };
		}

		if (
			this.#endedLocally(
				issue,
				runIdOf({ repo, issue, eventId: latest.entry.id }),
			)
		) {
			return { kind: "ended" };
		}

		const stored = await this.#input.store.read({
			repo,
			issue,
			eventId: latest.entry.id,
		});

		if (stored.kind === "unreadable") return { kind: "defer" };

		if (stored.kind === "absent") return { kind: "none" };

		if (stored.receipt.eventAt !== latest.entry.at) {
			this.#markCorrupt(
				issue,
				{ kind: "corrupt", defect: "record_mismatch", commentId: "" },
				record.updatedAt,
			);

			return { kind: "defer" };
		}

		this.#input.log("admission_recovered", {
			issue,
			eventId: stored.receipt.eventId,
		});

		return { kind: "found", receipt: stored.receipt };
	}

	async #freshAdmission(
		record: IssueRecord,
		reads: TickReads,
		refused: { issue: number; reasons: RefusalReason["kind"][] }[],
	): Promise<AdmittedReceipt | null> {
		const issue = record.number;
		const repo = this.#input.repo;

		const receipt = await admitTicket({
			exec: this.#input.exec,
			env: this.#input.env,
			platform: this.#input.platform,
			repo,
			issue,
			allowlist: this.#input.platform.repositories,
			store: this.#input.store,
			paging: this.#input.paging,
			tick: reads,
		});

		if (receipt.decision === "admitted") {
			this.#readOpen.add(issue);

			return receipt;
		}

		const kinds = receipt.reasons.map((reason) => reason.kind);

		if (!kinds.includes("duplicate_event") || receipt.eventId === null) {
			const settled = receipt.reasons.every(refusalSettlesUntilEdited);

			refused.push({ issue, reasons: kinds });
			this.#input.log("admission_refused", {
				issue,
				reasons: kinds.join("+"),
				retry: !settled,
			});

			if (settled) this.#see(issue, record.updatedAt, { kind: "decided" });

			return null;
		}

		const stored = await this.#input.store.read({
			repo,
			issue,
			eventId: receipt.eventId,
		});

		if (stored.kind !== "found") return null;

		if (stored.receipt.snapshotDigest !== receipt.snapshotDigest) {
			this.#markCorrupt(
				issue,
				{ kind: "corrupt", defect: "record_mismatch", commentId: "" },
				record.updatedAt,
			);

			return null;
		}

		this.#readOpen.add(issue);

		return stored.receipt;
	}

	async #admit(input: {
		record: IssueRecord;
		ledger: CleanLedger;
		reads: TickReads;
		refused: { issue: number; reasons: RefusalReason["kind"][] }[];
	}): Promise<ActiveRun | null> {
		const { record, ledger } = input;
		const issue = record.number;
		const repo = this.#input.repo;

		const top = currentMarker(ledger);

		if (
			top !== null &&
			!isTerminal(top.status) &&
			(await this.#ownershipOf(top)).kind === "foreign"
		) {
			this.#see(issue, record.updatedAt, { kind: "decided" });

			return null;
		}

		const local = await this.#recordedAdmission(record, ledger);

		if (local.kind === "defer") return null;

		if (local.kind === "ended") {
			this.#see(issue, record.updatedAt, { kind: "decided" });

			return null;
		}

		const admitted =
			local.kind === "found"
				? local.receipt
				: await this.#freshAdmission(record, input.reads, input.refused);

		if (admitted === null) return null;

		const runId = runIdOf({ repo, issue, eventId: admitted.eventId });

		if (latestFor(ledger, runId) !== null || this.#endedLocally(issue, runId)) {
			this.#see(issue, record.updatedAt, { kind: "decided" });

			return null;
		}

		const link = await linkRun(this.#input, this.#adapter, {
			issue,
			ledger,
			admitted,
			runId,
		});

		if (link.kind === "defer") return null;

		if (link.kind === "invalid") {
			input.refused.push({ issue, reasons: [link.reason] });
			this.#input.log("admission_refused", {
				issue,
				reasons: link.reason,
				detail: link.detail,
				retry: false,
			});
			this.#see(issue, record.updatedAt, {
				kind: "refused",
				reason: link.reason,
			});

			return null;
		}

		if (link.kind === "ambiguous") {
			input.refused.push({ issue, reasons: ["ambiguous_snapshot"] });
			this.#input.log("admission_refused", {
				issue,
				reasons: "ambiguous_snapshot",
				detail: "answer_at_label_time",
				retry: false,
			});
			this.#see(issue, record.updatedAt, { kind: "decided" });

			return null;
		}

		if (
			link.kind === "none" &&
			!(await this.#input.files.writeLink(runId, null))
		) {
			this.#input.log("link_unwritable", { issue, runId });

			return null;
		}

		if (
			this.#input.files.prepareRun !== undefined &&
			!(await this.#input.files.prepareRun({
				runId,
				repo,
				workflowSha: admitted.baseSha,
				workflowDigest: admitted.workflowDigest,
				startedAt: new Date(this.#input.clock.now()).toISOString(),
				runTokenCap:
					this.#trustedRun?.digest === admitted.workflowDigest
						? this.#trustedRun.tokens
						: null,
			}))
		) {
			this.#input.log("admission_policy_unavailable", { issue, runId });

			return null;
		}

		const run: ActiveRun = {
			runId,
			issue,
			eventId: admitted.eventId,
			eventAt: admitted.eventAt,
			snapshotDigest: admitted.snapshotDigest,
			workflowSha: admitted.baseSha,
			workflowDigest: admitted.workflowDigest,
			stage: FIRST_STAGE,
			attempt: 1,
			usage: 0,
			seq: this.#seqFloor(issue, ledger),
			marked: null,
			inflight: null,
			claimUnwritten: false,
			workspaceMissing: false,
			replay: false,
			unsettled: null,
			adopted: false,
			clearNeedsInfo: link.kind === "linked",
			labelFailures: 0,
			labelTick: 0,
			inputs: null,
			phase: { kind: "claimed" },
		};

		if (!(await this.#input.files.writeClaim(claimOf(run)))) {
			this.#input.log("claim_unwritable", { issue, runId });

			return null;
		}

		this.state.runs.set(issue, run);
		this.#observeClaim(run, this.#confirmedBy(run));
		this.state.totals.claims++;
		this.#see(issue, record.updatedAt, { kind: "claimed" });
		this.#input.log("claim_taken", {
			issue,
			runId,
			eventId: run.eventId,
		});
		await this.#sync(run);

		if (link.kind === "linked") {
			this.#input.log("run_linked", {
				issue,
				runId,
				prevRunId: link.link.prevRunId,
				answers: link.answers,
			});
			await this.#clearNeedsInfo(run);
		}

		if ((await this.#input.files.ensureWorkspace(runId)) === "unavailable") {
			this.#input.log("workspace_unavailable", { issue, runId });
		}

		return run;
	}

	async #labelOutcome(
		run: ActiveRun,
		label: string,
		outcome: "posted" | "rejected" | "unknown",
		critical = true,
	): Promise<boolean> {
		const fields = { issue: run.issue, runId: run.runId, label, outcome };

		this.#input.log("label_write", fields);

		if (critical) {
			run.labelFailures = outcome === "posted" ? 0 : run.labelFailures + 1;
			await writeClaim(this.#input, run);
		}

		if (outcome !== "posted") this.#input.log("label_unconfirmed", fields);

		return outcome === "posted";
	}

	#labelsExhausted(run: ActiveRun): boolean {
		if (
			run.labelFailures < (this.#limits()?.maxAttempts ?? DEFAULTS.maxAttempts)
		)
			return false;

		this.#stop(run, {
			stage: run.stage,
			class: "label",
			reason: "label_retries_exhausted",
		});
		this.#input.log("label_retries_exhausted", {
			issue: run.issue,
			runId: run.runId,
			failures: run.labelFailures,
		});

		return true;
	}

	async #clearNeedsInfo(run: ActiveRun): Promise<boolean> {
		if (!run.clearNeedsInfo) return true;

		if (run.labelTick === this.#ticks) return false;

		run.labelTick = this.#ticks;

		const removed = await this.#writer.removeLabel(run.issue, NEEDS_INFO_LABEL);

		run.clearNeedsInfo = !(await this.#labelOutcome(
			run,
			NEEDS_INFO_LABEL,
			removed.kind,
			false,
		));

		return !run.clearNeedsInfo;
	}

	async #stillReady(run: ActiveRun): Promise<ClaimObservation> {
		if (this.#readOpen.has(run.issue)) return this.#confirmedBy(run);

		const read = await this.#adapter.readIssue(run.issue);

		if (read.kind === "failed")
			return this.#unverifiedBy("issue", read.failure);

		if (!isReady(read.value)) {
			this.#release(run, read.value.open ? "unlabeled" : "closed");
			await this.#sync(run);

			return {
				kind: "released",
				reason: read.value.open ? "unlabeled" : "closed",
			};
		}

		this.#readOpen.add(run.issue);

		return this.#confirmedBy(run);
	}

	async #launch(run: ActiveRun): Promise<boolean> {
		if (!this.#claimView(run).launch) return false;

		if (
			run.claimUnwritten ||
			run.handoff !== undefined ||
			run.phase.kind === "evidence_missing"
		)
			return false;

		this.#observeClaim(run, await this.#stillReady(run));

		if (!this.#claimView(run).launch) return false;

		if (
			run.stage === "validate" ||
			run.stage === "review" ||
			run.stage === "land" ||
			(run.round ?? 0) > 0
		)
			return false;

		const { files, executor, clock } = this.#input;
		const config = this.#config;

		if (config === null) return false;

		await reconcileSpent(this.#input, this.state.totals, run);

		const stage = run.stage;

		const prior = isModelStage(stage)
			? await attemptSpent(this.#input, run, stage)
			: 0;

		const runExhausted = run.usage + prior >= config.usage.maxTokensPerRun;

		if (runExhausted) {
			run.usage += prior;
			this.state.totals.usage += prior;
			this.#stop(run, budgetCause(run.stage, "run_tokens"));
			this.#input.log("launch_refused", {
				issue: run.issue,
				runId: run.runId,
				stage: run.stage,
				why: "run_tokens",
			});
			await this.#sync(run);

			return false;
		}

		if (stage === "build" && this.#enabled) {
			const kept = await executor.output({
				runId: run.runId,
				stage,
				attempt: run.attempt,
				round: run.round ?? 0,
			});

			if (await this.#recoverOutput(run, kept)) {
				run.usage += prior;
				this.state.totals.usage += prior;
				await this.#sync(run);

				return false;
			}
		}

		const preparation = await prepareWorkspace(this.#input, run);

		if (preparation.kind === "unavailable") return false;

		if (!isModelStage(stage)) {
			run.phase = { kind: "blocked", reason: "sandbox_unavailable" };
			await this.#sync(run);

			return true;
		}

		await this.#clearNeedsInfo(run);

		const prepared = this.#enabled
			? await stageInputs(this.#input, run)
			: UNPREPARED;

		if (prepared.kind === "wait") return false;

		if (prepared.kind === "fail") {
			if (prepared.refusal !== undefined) {
				const notice = baseRefusalNotice(prepared.refusal);

				if (
					!(await postKeyed(
						this.#input,
						this.#adapter,
						this.#writer,
						run,
						notice.key,
						notice.body,
					))
				)
					return false;
			}

			this.#stop(run, preparedCause(run.stage, prepared));
			await this.#sync(run);

			return false;
		}

		run.inputs = prepared.inputs;

		if (stage === "accept" && prepared.inputs?.contract !== undefined) {
			const bound = prepared.inputs.contract;

			const kept = await files.artifacts.read(
				run.runId,
				bound.contract,
				bound.digest,
			);

			if (kept.kind !== "absent") {
				run.usage += prior;
				this.state.totals.usage += prior;

				if (kept.kind === "blocked") {
					this.#input.log("stage_inputs_refused", {
						runId: run.runId,
						why: kept.reason,
					});
					this.#stop(run, inputCause(stage, kept.reason));
				} else
					run.phase = {
						kind: "reporting",
						status: "stage_passed",
						effects: withFamily(
							{
								kind: "acceptance",
								contract: bound.contract,
								contractDigest: bound.digest,
								suite: kept.suite,
								model: kept.receipt.model,
								observed: kept.receipt.observed,
							},
							kept.receipt.family,
						),
					};
				await this.#sync(run);

				return false;
			}
		}

		// Once the feedback retry is granted, accept attempts share one token
		// allowance and one wall, less the refused suite's base checks.
		const reference = stage === "accept" ? run.baseCheck : undefined;
		let budget = config.stages[stage].budget;
		let earlier = 0;

		if (reference?.retry !== undefined) {
			const spent = await acceptSpent(
				this.#input,
				run,
				reference,
				run.attempt - 1,
			);

			const wallMs =
				budget.wallMs - (run.acceptWallMs ?? 0) - reference.retry.baseWallMs;

			if (spent === null || wallMs <= 0) {
				run.usage += prior;
				this.state.totals.usage += prior;
				this.#stop(run, budgetCause(stage, wallMs <= 0 ? "wall" : null));
				this.#input.log("launch_refused", {
					issue: run.issue,
					runId: run.runId,
					stage,
					why: spent === null ? "stage_tokens" : "wall",
				});
				await this.#sync(run);

				return false;
			}

			earlier = spent;
			budget = { ...budget, wallMs };
		}

		const abort = new AbortController();
		const now = clock.now();

		const phase: Extract<RunPhase, { kind: "running" }> = {
			kind: "running",
			lastProgressAt: now,
			usage: prior,
			abort,
			result: null,
		};

		const launch = await executor.launch({
			runId: run.runId,
			stage,
			attempt: run.attempt,
			round: run.round ?? 0,
			workspace: prepared.workspace ?? files.workspacePath(run.runId),
			build: prepared.build,
			prompt: prepared.prompt,
			source: prepared.source,
			specify: prepared.specify,
			acceptDraft:
				stage === "accept" && prepared.inputs?.contract !== undefined
					? {
							contract: prepared.inputs.contract.contract,
							digest: prepared.inputs.contract.digest,
							repo: prepared.inputs.contract.contract.base.repo,
							issue: run.issue,
							baseSha: prepared.inputs.contract.contract.base.sha,
						}
					: undefined,
			tools:
				prepared.inputs === null
					? []
					: stage === "build"
						? prepared.inputs.contract !== undefined &&
							prepared.inputs.contract.contract.files.length > 8
							? [...BUILD_TOOLS, "subagent"]
							: BUILD_TOOLS
						: stage === "accept"
							? ACCEPTANCE_TOOLS
							: SPECIFY_TOOLS,
			skills:
				prepared.inputs === null
					? []
					: stage === "build"
						? ["build"]
						: stage === "accept"
							? ACCEPTANCE_SKILLS
							: SPECIFY_SKILLS,
			acceptEffort:
				stage === "accept" ? config.stages.accept.reasoningEffort : undefined,
			settings: {
				model: config.stages[stage].model,
				fallback: config.stages[stage].fallbackModel,
				budget,
				maxTokens:
					stage === "build"
						? Math.max(0, BUILD_MAX_TOKENS - prior)
						: stage === "accept"
							? Math.max(0, ACCEPTANCE_MAX_TOKENS - earlier - prior)
							: null,
			},
			remainingRunTokens: Math.max(
				0,
				config.usage.maxTokensPerRun - run.usage - prior,
			),
			signal: abort.signal,
			progress: (usage) => {
				phase.lastProgressAt = clock.now();
				phase.usage = Math.max(phase.usage, prior + usage);
			},
		});

		this.state.totals.launches++;

		if (launch.kind === "unavailable") {
			run.phase = { kind: "blocked", reason: launch.reason };
		} else {
			run.phase = phase;
			run.unsettled = null;
			run.adopted = false;

			const attempt = run.attempt;

			const settled = launch.done.then(
				async (result) => {
					const output =
						result.kind === "passed"
							? await executor
									.output({
										runId: run.runId,
										stage,
										attempt,
										round: run.round ?? 0,
									})
									.catch(() => null)
							: null;

					phase.result = withFamily(
						{
							kind: result.kind,
							wallMs: result.receipt.wallMs,
							model:
								result.receipt.fallback?.requested ??
								result.receipt.models.requested,
							observed:
								result.receipt.fallback?.observed ??
								result.receipt.models.observed,
							usage: prior + result.usage,
							cap: result.kind === "budget_exhausted" ? result.cap : undefined,
							refusal: result.receipt.refusal,
							build:
								output instanceof Object && output.kind === "build"
									? output.result
									: undefined,
							output:
								output instanceof Object
									? output.kind === "output"
										? output.text
										: null
									: output,
						},
						output instanceof Object && output.kind === "output"
							? output.family
							: undefined,
					);
				},
				() => {
					phase.result = { kind: "failed", usage: phase.usage, output: null };
				},
			);

			this.#stages.add(settled);
			settled.then(() => this.#stages.delete(settled));
		}

		this.#input.log("stage_launched", {
			issue: run.issue,
			runId: run.runId,
			stage: run.stage,
			attempt: run.attempt,
			result: launch.kind,
		});
		await this.#sync(run);

		return true;
	}

	async #commitCandidate(
		run: ActiveRun,
		state: CandidateState,
	): Promise<boolean> {
		const { stage, status, attempt, round } = candidateProjection(state);

		const enteredAt =
			run.phase.kind === "candidate" && run.phase.status === status
				? run.enteredAt
				: this.#input.clock.now();

		const projected: ActiveRun = {
			...run,
			stage,
			attempt,
			round,
			usage: candidateUsage(state),
			handoff: state,
			enteredAt,
			phase: { kind: "candidate", status },
		};

		if (!(await this.#input.files.writeClaim(claimOf(projected)))) {
			this.#input.log("claim_unwritable", { runId: run.runId });

			return false;
		}

		this.state.totals.usage += Math.max(0, projected.usage - run.usage);
		Object.assign(run, projected);
		run.claimUnwritten = false;

		return true;
	}

	#observeFeedback(
		run: ActiveRun,
		feedback: FeedbackObservation | undefined,
	): void {
		const pr =
			run.handoff?.kind === "selected"
				? run.handoff.published?.number
				: undefined;

		if (
			pr === undefined ||
			(feedback?.kind !== "unavailable" && feedback?.kind !== "deferred")
		) {
			this.#feedbackObservations.delete(run.runId);

			return;
		}

		const last = this.#feedbackObservations.get(run.runId);

		const previous =
			last !== undefined && last.tick >= this.#ticks - 1
				? last.problem
				: undefined;

		const reason =
			feedback.reason ??
			(feedback.kind === "deferred" ? "head_mismatch" : "unexpected");

		const failure =
			feedback.kind === "unavailable" ? (feedback.failure ?? null) : null;

		if (
			previous?.kind !== feedback.kind ||
			previous.reason !== reason ||
			previous.failure !== failure ||
			previous.pr !== pr
		)
			this.#input.log(`feedback_${feedback.kind}`, {
				issue: run.issue,
				runId: run.runId,
				pr,
				reason,
				failure,
			});

		this.#feedbackObservations.set(run.runId, {
			tick: this.#ticks,
			problem: {
				issue: run.issue,
				runId: run.runId,
				eventId: run.eventId,
				pr,
				kind: feedback.kind,
				reason,
				failure,
				since:
					previous?.kind === feedback.kind && previous.pr === pr
						? previous.since
						: this.#input.clock.now(),
			},
		});
	}

	async #observeCandidates(executionAllowed: boolean): Promise<void> {
		const port = this.#input.executor.candidate;

		if (port === undefined) return;

		for (const run of this.state.runs.values()) {
			if (run.phase.kind === "evidence_missing" && run.marked !== null) {
				const observed = await port
					.observeMissing?.(run.marked)
					.catch(() => null);

				if (observed?.kind === "merged")
					this.#input.log("merge_observed_evidence_missing", {
						issue: run.issue,
						runId: run.runId,
						head: observed.head,
						mergeSha: observed.mergeSha,
						actor: observed.actor ?? "unknown",
					});
				continue;
			}

			if (run.handoff === undefined) continue;

			const observation = await port
				.observe(run.handoff, this.#input.clock.now())
				.catch(() => null);

			if (observation === null) continue;
			this.#observeFeedback(
				run,
				observation.pr.kind === "open" ? observation.feedback : undefined,
			);

			let step = handoffCandidate(run.handoff, {
				...observation,
				executionAllowed,
				capacityAvailable:
					this.#enabled &&
					this.#active() < (this.#limits()?.maxConcurrent ?? 0),
			});

			let consumed = false;

			if (!(await this.#commitCandidate(run, step.state))) continue;

			if (this.#candidateRecovery.has(run.runId))
				await recoverCandidate(
					this.#input,
					this.#candidateResults,
					this.#candidateRecovery,
					run,
				);

			for (let index = 0; index < this.#candidateResults.length; ) {
				const queued = this.#candidateResults[index];

				if (queued === undefined || queued.runId !== run.runId) {
					index++;
					continue;
				}

				step = handoffCandidate(step.state, {
					...queued.event,
					now: this.#input.clock.now(),
				});

				if (queued.refusal !== undefined) {
					const failed = await this.#reviewInputFailure(
						run,
						step.state,
						queued.refusal,
					);

					if (failed === null) break;
					step = { state: failed, effect: null };
				}

				const event = queued.event;

				if (
					(event.kind === "review_settled" ||
						event.kind === "repair_settled") &&
					this.#input.files.accounting !== undefined
				) {
					const execution = event.execution;

					const saved = await this.#input.files.accounting.readAttempt(
						run.runId,
						execution.stage,
						execution.round,
						execution.attempt,
					);

					if (saved === undefined) break;

					if (
						saved === null &&
						!(await this.#input.files.accounting.writeAttempt({
							v: 1,
							runId: run.runId,
							stage: execution.stage,
							round: execution.round,
							attempt: execution.attempt,
							disposition:
								queued.disposition ??
								(event.result.kind === "passed"
									? "completed"
									: "model_failure"),
							usage: candidateUsage(step.state),
							next: { kind: "continue" },
						}))
					)
						break;
				}

				if (!(await this.#commitCandidate(run, step.state))) break;

				if (queued.refusal !== undefined) this.state.totals.failures++;
				this.#candidateResults.splice(index, 1);
				consumed = true;
			}

			if (consumed) {
				step = handoffCandidate(step.state, {
					...observation,
					executionAllowed,
					capacityAvailable:
						this.#enabled &&
						this.#active() < (this.#limits()?.maxConcurrent ?? 0),
				});

				if (!(await this.#commitCandidate(run, step.state))) continue;
			}

			const effect = step.effect;

			if (
				effect !== null &&
				(executionAllowed ||
					effect.kind === "stop_execution" ||
					effect.kind === "finish_pr")
			)
				await this.#interpretCandidate(run, effect);

			if (
				run.handoff?.kind === "selected" &&
				run.handoff.work.kind === "terminal"
			) {
				if (
					(await this.#recoverUncertainPost(run)) === "proceed" &&
					(await this.#prepareTerminal(run))
				)
					await this.#publishMarker(run);

				if (run.marked !== null && isTerminal(run.marked.status)) {
					await this.#freezeRow(run.marked);
					this.state.runs.delete(run.issue);
					await this.#keepEnded({ ...claimOf(run), seq: run.seq }, false);
				}
			} else if (
				executionAllowed &&
				(await this.#recoverUncertainPost(run)) === "proceed"
			) {
				await this.#publishMarker(run);
				await writeClaim(this.#input, run);
			}
		}
	}

	async #reviewInputFailure(
		run: ActiveRun,
		state: CandidateState,
		refusal: ReviewInputRefusal,
	): Promise<CandidateState | null> {
		if (state.kind !== "selected") return null;
		const key = `<!-- factory-review-input run=${run.runId} -->`;

		if (
			!(await postKeyed(
				this.#input,
				this.#adapter,
				this.#writer,
				run,
				key,
				`Stopped: ${refusal.reason}. Candidate diff is ${refusal.bytes} bytes; the review limit is ${refusal.limit} bytes. No review model was launched.\n\n${key}`,
			))
		)
			return null;

		return stopRound(state, refusal.reason, this.#input.clock.now());
	}

	async #interpretCandidate(
		run: ActiveRun,
		request: CandidateEffect,
	): Promise<void> {
		const state = run.handoff;
		const executor = this.#input.executor;
		const port = executor.candidate;

		if (state?.kind !== "selected" || port === undefined) return;
		let completion: CandidateEffectResult | null = null;

		if (request.kind === "validate") {
			const validate =
				request.generation.publication.kind === "owner"
					? executor.ownerValidate
					: executor.validate;

			if (validate === undefined) return;

			const result = await validate({
				runId: run.runId,
				issue: run.issue,
				eventAt: run.eventAt,
				baseSha: run.workflowSha,
				round: request.generation.round,
				generation: request.generation,
				now: this.#input.clock.now(),
				wallMs: this.#config?.stages.validate.budget.wallMs ?? 1_200_000,
				state:
					state.current.validation === null
						? null
						: structuredClone(state.current.validation),
				save: async (validation) =>
					this.#commitCandidate(
						run,
						handoffCandidate(run.handoff ?? state, {
							kind: "effect_completed",
							now: this.#input.clock.now(),
							completion: {
								kind: "validate",
								request,
								result: { kind: "waiting", validation },
							},
						}).state,
					),
			});

			if (result.kind === "waiting")
				completion = {
					kind: "validate",
					request,
					result: { kind: "waiting", validation: result.state },
				};
			else if (
				result.kind === "finished" &&
				(!result.verdict.pass || result.report !== undefined)
			) {
				const read = result.assessment;

				if (
					read.assessment.kind === "failed" &&
					read.assessment.failure.kind !== "candidate"
				) {
					// A dead end spends no repair, so the owner sees what else failed.
					const notice = diagnosisNotice(
						read.assessment.failure,
						`<!-- factory-diagnosis run=${run.runId} g=${read.binding.round}.${read.binding.generation} a=${read.ref.recordDigest} -->`,
						{
							failedChecks: failedVisibleChecks(result.verdict.checks),
							patchDigest: isDigest(state.current.patch.patchDigest)
								? state.current.patch.patchDigest
								: null,
						},
					);

					if (
						!(await postKeyed(
							this.#input,
							this.#adapter,
							this.#writer,
							run,
							notice.key,
							notice.body,
						))
					)
						return;
				}

				completion = {
					kind: "validate",
					request,
					result: {
						kind: "finished",
						validation: result.state,
						verdict: result.verdict,
						report: result.report ?? null,
						seats: reviewSeats(
							state.current.ownerPatch?.changedPaths ??
								state.current.patch.changedPaths,
						),
						assessment: result.assessment,
					},
				};
			} else if (result.kind === "failed")
				completion = {
					kind: "validate",
					request,
					result: {
						kind: "failed",
						validation: result.state,
						reason:
							result.reason === "stale_base"
								? "main_moving"
								: "evidence_unavailable",
					},
				};
		} else if (
			request.kind === "launch_review" ||
			request.kind === "repair_build"
		) {
			if (this.#candidateExecutions.has(request.execution.id)) return;
			completion = await this.#launchCandidate(run, request);
		} else if (request.kind === "stop_execution") {
			const active = this.#candidateExecutions.get(request.execution.id);
			active?.abort.abort();

			if (active !== undefined && !active.settled) return;

			if (!(await executor.reconciled())) return;

			const tokens = await executor.spent({
				runId: run.runId,
				stage: request.execution.stage,
				round: request.execution.round,
				attempt: request.execution.attempt,
				execution: request.execution,
			});

			completion = { kind: "stop_execution", request, stopped: true, tokens };
		} else {
			try {
				completion = await port.execute(state, request);
			} catch (error) {
				if (!(error instanceof PublicationError)) throw error;

				if (error.reason === "summary_too_large") {
					const key = `<!-- factory-handoff-input run=${run.runId} -->`;

					if (
						!(await postKeyed(
							this.#input,
							this.#adapter,
							this.#writer,
							run,
							key,
							`Stopped: summary_too_large. The pinned contract summary exceeds the handoff limit.\n\n${key}`,
						))
					)
						return;

					const stopped = stopRound(
						state,
						"summary_too_large",
						this.#input.clock.now(),
					);

					if (
						(await this.#commitCandidate(run, stopped)) &&
						stopped.work.kind === "effect"
					)
						await this.#interpretCandidate(run, stopped.work.request);

					return;
				}

				if (
					error.reason !== "evidence_unavailable" &&
					error.reason !== "pr_identity" &&
					error.reason !== "pr_ambiguous" &&
					error.reason !== "workflow_unavailable"
				)
					throw error;

				this.#input.log("candidate_effect_held", {
					runId: run.runId,
					reason: error.reason,
				});
				await this.#commitCandidate(
					run,
					handoffCandidate(state, {
						kind: "effect_held",
						reason: error.reason,
						now: this.#input.clock.now(),
					}).state,
				);
			}
		}

		if (completion !== null) {
			if (completion.kind === "derive_owner_patch")
				this.#input.log("owner_derive_result", {
					runId: run.runId,
					head: completion.request.head,
					baseSha: completion.request.baseSha,
					result: completion.result.kind,
					reason:
						completion.result.kind === "refused"
							? completion.result.reason
							: null,
				});

			const step = handoffCandidate(run.handoff ?? state, {
				kind: "effect_completed",
				now: this.#input.clock.now(),
				completion,
			});

			if (await this.#commitCandidate(run, step.state)) {
				if (step.effect?.kind === "finish_pr" && request.kind !== "finish_pr")
					await this.#interpretCandidate(run, step.effect);
			}
		}
	}

	async #launchCandidate(
		run: ActiveRun,
		request: Extract<
			CandidateEffect,
			{ kind: "launch_review" | "repair_build" }
		>,
	): Promise<CandidateEffectResult | null> {
		const state = run.handoff;
		const { executor, files, clock } = this.#input;
		const config = this.#config;

		if (state?.kind !== "selected" || config === null) return null;
		const execution = request.execution;

		let prepared: ReviewPreparation | ReviewInputRefusal | null | undefined =
			null;

		try {
			if (execution.stage === "review")
				prepared = await executor.prepareReview?.({
					runId: execution.runId,
					round: execution.round,
					execution,
					workflowSha: execution.workflowSha,
					workflowDigest: execution.workflowDigest,
					workspace: `${files.workspacePath(run.runId)}-review-r${execution.round}-a${execution.attempt}`,
				});
		} catch (error) {
			if (
				!(error instanceof ReviewEvidenceUnavailable) ||
				execution.stage !== "review"
			)
				throw error;

			const tokens = await executor.spent({
				runId: execution.runId,
				stage: "review",
				round: execution.round,
				attempt: execution.attempt,
				execution,
			});

			let held: CandidateState = state;

			if (tokens !== null)
				held = handoffCandidate(held, {
					kind: "execution_progress",
					execution,
					tokens,
				}).state;
			held = handoffCandidate(held, {
				kind: "review_settled",
				now: clock.now(),
				execution,
				tokens: null,
				result: { kind: "failed" },
			}).state;

			if (held.kind === "selected") await this.#commitCandidate(run, held);

			return null;
		}

		if (execution.stage === "review" && prepared == null) return null;

		if (
			prepared != null &&
			"kind" in prepared &&
			request.kind === "launch_review"
		) {
			const tokens = await executor.spent({
				runId: execution.runId,
				stage: execution.stage,
				round: execution.round,
				attempt: execution.attempt,
				execution,
			});

			const settled = handoffCandidate(state, {
				kind: "review_settled",
				now: clock.now(),
				execution: request.execution,
				tokens,
				result: { kind: "failed", reason: prepared.reason },
			}).state;

			const failed = await this.#reviewInputFailure(run, settled, prepared);

			if (failed !== null && (await this.#commitCandidate(run, failed))) {
				this.state.totals.failures++;

				if (failed.kind === "selected" && failed.work.kind === "effect")
					await this.#interpretCandidate(run, failed.work.request);
			}

			return null;
		}

		if (prepared != null && "kind" in prepared) return null;

		if (
			execution.stage === "build" &&
			request.kind === "repair_build" &&
			!(await this.#repairAuthorized(state, execution))
		) {
			const settled = handoffCandidate(state, {
				kind: "effect_completed",
				completion: { kind: "repair_build", request, started: false },
			}).state;

			if (settled.kind !== "selected") return null;

			const stopped = stopRound(
				settled,
				"diagnosis_missing_evidence",
				clock.now(),
			);

			this.#input.log("repair_refused", {
				runId: run.runId,
				why: "assessment_missing",
			});

			if (await this.#commitCandidate(run, stopped)) {
				this.state.totals.failures++;

				if (stopped.work.kind === "effect")
					await this.#interpretCandidate(run, stopped.work.request);
			}

			return null;
		}

		const oldStage = run.stage;
		const oldRound = run.round;
		const oldAttempt = run.attempt;
		run.stage = execution.stage;
		run.round = execution.round;
		run.attempt = execution.attempt;

		const inputs =
			execution.stage === "build" ? await stageInputs(this.#input, run) : null;

		run.stage = oldStage;
		run.round = oldRound;
		run.attempt = oldAttempt;

		if (inputs?.kind === "fail" && request.kind === "repair_build") {
			if (inputs.refusal !== undefined) {
				const notice = baseRefusalNotice(inputs.refusal);

				if (
					!(await postKeyed(
						this.#input,
						this.#adapter,
						this.#writer,
						run,
						notice.key,
						notice.body,
					))
				)
					return null;
			}

			const settled = handoffCandidate(state, {
				kind: "effect_completed",
				completion: { kind: "repair_build", request, started: false },
			}).state;

			if (settled.kind !== "selected") return null;

			const stopped = stopRound(settled, "evidence_unavailable", clock.now());

			if (await this.#commitCandidate(run, stopped)) {
				this.state.totals.failures++;

				if (stopped.work.kind === "effect")
					await this.#interpretCandidate(run, stopped.work.request);
			}

			return null;
		}

		if (inputs !== null && inputs.kind !== "ready") return null;
		const abort = new AbortController();
		const handle = { abort, settled: false };

		const launch = await executor.launch({
			runId: run.runId,
			stage: execution.stage,
			attempt: execution.attempt,
			round: execution.round,
			execution,
			workspace:
				prepared?.workspace ??
				inputs?.workspace ??
				files.workspacePath(run.runId),
			review: prepared ?? undefined,
			build: inputs?.build,
			prompt: inputs?.prompt ?? "",
			tools: execution.stage === "review" ? REVIEW_TOOLS : BUILD_TOOLS,
			skills:
				execution.stage === "review"
					? []
					: execution.cause.kind === "feedback"
						? ["build", "address-pr-comments"]
						: ["build"],
			settings: {
				model: config.stages[execution.stage].model,
				fallback: config.stages[execution.stage].fallbackModel,
				codeReviewModel:
					execution.stage === "review"
						? config.stages.review.codeReviewModel
						: null,
				budget: config.stages[execution.stage].budget,
				maxTokens: candidateAllowance(state, execution),
			},
			remainingRunTokens: Math.max(
				0,
				state.pin.maxTokens - candidateUsage(state),
			),
			signal: abort.signal,
			progress: (tokens) => {
				this.#candidateResults.push({
					runId: execution.runId,
					event: { kind: "execution_progress", execution, tokens },
				});
			},
		});

		if (launch.kind === "unavailable")
			return request.kind === "launch_review"
				? { kind: "launch_review", request, started: false }
				: { kind: "repair_build", request, started: false };
		this.#candidateExecutions.set(execution.id, handle);
		this.state.totals.launches++;

		const settled = launch.done
			.then(async (result) => {
				const tokens = await executor.spent({
					runId: execution.runId,
					stage: execution.stage,
					attempt: execution.attempt,
					round: execution.round,
					execution,
				});

				const output =
					result.kind === "passed"
						? await executor.output({
								runId: execution.runId,
								stage: execution.stage,
								attempt: execution.attempt,
								round: execution.round,
								execution,
								workflowSha: execution.workflowSha,
								workflowDigest: execution.workflowDigest,
							})
						: null;

				let event: CandidateEvent;

				if (execution.stage === "review") {
					const patch = await executor.candidate?.patch(state, execution.round);
					event = {
						kind: "review_settled",
						execution,
						tokens,
						result:
							output instanceof Object &&
							output.kind === "review" &&
							patch != null
								? { kind: "passed", review: output.receipt, patch }
								: output instanceof Object && output.kind === "refused"
									? { kind: "failed", reason: output.reason }
									: { kind: "failed" },
					};
				} else
					event = {
						kind: "repair_settled",
						execution,
						tokens,
						result:
							output instanceof Object &&
							output.kind === "build" &&
							output.result.kind === "found"
								? { kind: "passed", patch: output.result.receipt }
								: output instanceof Object &&
										output.kind === "build" &&
										output.result.kind === "blocked" &&
										output.result.reason === "repair_no_change"
									? { kind: "no_change" }
									: { kind: "failed" },
					};
				this.#candidateResults.push({
					runId: execution.runId,
					event,
					refusal:
						output instanceof Object && output.kind === "refused"
							? output
							: undefined,
					disposition:
						result.kind === "passed"
							? "completed"
							: result.kind === "refused"
								? "refused"
								: result.kind === "budget_exhausted"
									? "budget_stop"
									: abort.signal.aborted
										? "aborted"
										: "model_failure",
				});
			})
			.catch(async (error) => {
				if (
					error instanceof ReviewEvidenceUnavailable &&
					execution.stage === "review"
				) {
					const tokens = await executor.spent({
						runId: execution.runId,
						stage: "review",
						attempt: execution.attempt,
						round: execution.round,
						execution,
					});

					queueReviewRefusal(this.#candidateResults, execution, tokens);

					return;
				}

				this.#candidateResults.push({
					runId: execution.runId,
					event:
						execution.stage === "review"
							? {
									kind: "review_settled",
									execution,
									tokens: null,
									result: { kind: "failed" },
								}
							: {
									kind: "repair_settled",
									execution,
									tokens: null,
									result: { kind: "failed" },
								},
				});
			})
			.finally(() => {
				handle.settled = true;
			});

		this.#stages.add(settled);
		settled.finally(() => this.#stages.delete(settled));
		this.#input.log("candidate_launched", {
			runId: execution.runId,
			execution: execution.id,
			at: clock.now(),
		});

		return request.kind === "launch_review"
			? { kind: "launch_review", request, started: true }
			: { kind: "repair_build", request, started: true };
	}

	async #repairAuthorized(
		state: Extract<CandidateState, { kind: "selected" }>,
		execution: Extract<CandidateExecution, { stage: "build" }>,
	): Promise<boolean> {
		const read = await this.#input.executor
			.readAssessment({
				runId: execution.runId,
				round: execution.feedbackFrom.round,
				generation: execution.feedbackFrom.generation,
			})
			.catch(() => null);

		if (
			read == null ||
			read.binding.runId !== execution.runId ||
			read.binding.round !== execution.feedbackFrom.round ||
			read.binding.generation !== execution.feedbackFrom.generation ||
			!sameAssessmentRef(read.ref, execution.cause.assessment)
		)
			return false;

		if (execution.cause.kind === "feedback") {
			const batch = await this.#input.executor
				.readFeedback?.(execution.runId, execution.cause.batch)
				.catch(() => null);

			const cause = execution.cause;

			const reference = state.feedback?.batches.find(
				(b) => b.digest === cause.batch,
			);

			return (
				batch != null &&
				reference?.status.kind === "applying" &&
				reference.status.round === execution.round &&
				batch.pr === state.published?.number &&
				batch.head === reference.head &&
				batch.runId === execution.runId &&
				batch.records.some((r) => r.intake.kind === "actionable") &&
				(read.assessment.kind === "passed" ||
					read.assessment.failure.kind === "candidate")
			);
		}

		return execution.cause.kind === "review"
			? read.assessment.kind === "passed"
			: read.assessment.kind === "failed" &&
					read.assessment.failure.kind === "candidate";
	}

	async #pollBase(run: ActiveRun): Promise<void> {
		if (
			run.phase.kind !== "base_check" ||
			run.baseCheck === undefined ||
			this.#input.clock.now() < run.phase.dueAt
		)
			return;
		const reference = run.baseCheck;

		if (reference.kind === "retry_pending") return;

		if (
			reference.kind !== "refused" &&
			(await acceptanceReceipt(this.#input, reference)) === null
		) {
			this.#stop(run, inputCause("accept", "acceptance_changed"));

			return;
		}

		const progress: BaseCheckProgress | undefined =
			reference.kind === "refused"
				? { kind: "refused", failure: reference.failure }
				: await this.#input.executor.baseCheck?.({
						binding: reference.binding,
						acceptAttempt: reference.acceptAttempt,
						storedAttempt: reference.storedAttempt,
						remainingAcceptMs: reference.remainingAcceptMs,
						signal: run.phase.abort.signal,
					});

		run.phase.checking = progress?.kind === "checking";

		if (progress?.kind === "checking") return;

		if (progress?.kind === "interrupted") {
			const limits = this.#limits();

			if (limits !== null && reference.acceptAttempt < limits.maxAttempts) {
				run.attempt = reference.acceptAttempt + 1;
				run.baseCheck = { ...reference, acceptAttempt: run.attempt };
				run.phase.dueAt =
					this.#input.clock.now() +
					backoffMs(run.attempt - 1, limits.maxBackoffMs);
				this.state.totals.retries++;
				this.#input.log("stage_ended", {
					issue: run.issue,
					runId: run.runId,
					cause: "interrupted",
					attempt: reference.acceptAttempt,
					next: "base_check",
				});
				recordAttempt(run, "interrupted", reference.acceptAttempt);

				if (!(await saveAttempt(this.#input, run))) return;
				await writeClaim(this.#input, run);

				return;
			}
		}

		if (
			progress?.kind !== "ready" ||
			!matchingBaseProof(progress.proof, reference.binding)
		) {
			const failure =
				progress?.kind === "refused"
					? progress.failure
					: {
							binding: reference.binding,
							receiptDigest: digestOf(JSON.stringify(reference)),
							reason:
								progress?.kind === "interrupted"
									? ("base_interrupted" as const)
									: ("base_evidence_missing" as const),
							scenarios: [],
						};

			// A retried refusal stays private; only the final one is published.
			if (
				progress?.kind === "refused" &&
				(await this.#retryAccept(run, reference, progress))
			)
				return;

			const notice = baseRefusalNotice(failure);

			run.baseCheck = {
				...reference,
				kind: "refused",
				failure,
				noticeKey: notice.key,
			};
			await writeClaim(this.#input, run);

			if (
				run.claimUnwritten ||
				!(await postKeyed(
					this.#input,
					this.#adapter,
					this.#writer,
					run,
					notice.key,
					notice.body,
				))
			)
				return;
			this.#stop(run, {
				stage: "accept",
				class: "base",
				reason: failure.reason,
			});

			// The final refusal is this attempt's disposition, recorded once.
			const recorded = await this.#input.files.accounting?.readAttempt(
				run.runId,
				"accept",
				0,
				reference.acceptAttempt,
			);

			if (recorded === null)
				recordAttempt(run, "base_refused", reference.acceptAttempt);

			return;
		}

		run.baseCheck = { ...reference, kind: "qualified", proof: progress.proof };
		const contract = await this.#input.files.readContract(run.runId);

		const stored =
			contract.kind === "found"
				? await this.#input.files.artifacts.read(
						run.runId,
						contract.contract,
						contract.digest,
					)
				: null;

		if (
			stored?.kind !== "found" ||
			stored.receipt.acceptanceDigest !== reference.binding.acceptanceDigest ||
			contract.kind !== "found" ||
			contract.digest !== reference.binding.contractDigest
		) {
			this.#input.log("stage_inputs_refused", {
				issue: run.issue,
				runId: run.runId,
				why: stored?.kind === "blocked" ? stored.reason : "acceptance_missing",
			});
			this.#stop(
				run,
				inputCause(
					"accept",
					stored?.kind === "blocked" ? stored.reason : "acceptance_missing",
				),
			);

			return;
		}

		const body = renderAcceptanceSummary({
			runId: run.runId,
			digest: reference.binding.acceptanceDigest,
			scenarios: stored.suite.scenarios,
			author: stored.receipt.family,
		});

		if (body === null) {
			this.#input.log("stage_inputs_refused", {
				issue: run.issue,
				runId: run.runId,
				why: "summary_too_large",
			});
			this.#stop(run, inputCause("accept", "summary_too_large"));

			return;
		}

		if (
			!(await postKeyed(
				this.#input,
				this.#adapter,
				this.#writer,
				run,
				acceptanceKey(run.runId, reference.binding.acceptanceDigest),
				body,
			))
		)
			return;
		recordAttempt(run, "completed", reference.acceptAttempt);
		// Qualification has finished; recovery may safely reuse the stored suite.
		run.attemptEnd = { ...run.attemptEnd!, next: { kind: "continue" } };

		if (!(await saveAttempt(this.#input, run))) return;
		run.stage = "build";
		run.attempt = 1;
		run.inputs = null;
		run.replay = false;
		run.phase = { kind: "claimed" };
		await writeClaim(this.#input, run);
	}

	async #sync(run: ActiveRun): Promise<void> {
		if (run.handoff !== undefined) return;

		if (run.phase.kind === "evidence_missing") {
			await this.#publishMarker(run);
			await writeClaim(this.#input, run);

			return;
		}

		if (run.inflight?.tick === this.#ticks) return;

		if (isTerminal(desiredStatus(run.phase)) && this.#settling(run)) return;

		if (
			run.adopted &&
			run.phase.kind === "ending" &&
			run.phase.status === "released" &&
			!(await countReleased(this.#input, this.state.totals, run))
		) {
			return;
		}

		if (run.phase.kind === "ending" && run.baseCheck !== undefined)
			await this.#input.executor.stopBase?.(run.runId);

		if (!(await saveAttempt(this.#input, run))) return;

		const before = run.seq;

		if ((await this.#recoverUncertainPost(run)) === "stop") return;

		if (
			run.marked !== null &&
			run.phase.kind !== "ending" &&
			run.phase.kind !== "recovering"
		) {
			await this.#clearNeedsInfo(run);
		}

		if (run.phase.kind === "reporting" && !this.#labelsExhausted(run)) {
			const { status, effects } = run.phase;

			if (await this.#applyEffects(run, effects)) {
				if (effects.kind === "build" && this.#config !== null) {
					const receipt = effects.result.receipt;

					if (!isDigest(receipt.contractDigest))
						throw new Error("contract_digest");
					run.handoff = beginCandidate(
						{
							runId: run.runId,
							repo: this.#input.repo,
							issue: run.issue,
							originalBase: run.workflowSha,
							workflowSha: run.workflowSha,
							workflowDigest: run.workflowDigest,
							contractDigest: receipt.contractDigest,
							acceptanceDigest: receipt.acceptanceDigest,
							maxTokens: this.#config.usage.maxTokensPerRun,
							maxReviewAttempts: Math.min(
								MAX_REVIEW_ATTEMPTS,
								this.#config.retry.maxAttempts,
							),
						},
						receipt,
						run.usage,
					);
					await this.#commitCandidate(
						run,
						handoffCandidate(run.handoff, {
							kind: "observed",
							now: this.#input.clock.now(),
							main: null,
							pr: { kind: "none" },
							eligibility: "ready",
							executionAllowed: false,
							capacityAvailable: false,
							readiness: { kind: "unavailable" },
						}).state,
					);

					return;
				}

				if (effects.kind === "contract" || effects.kind === "acceptance") {
					run.stage = effects.kind === "contract" ? "accept" : "build";
					run.attempt = 1;
					run.inputs = null;
					run.replay = false;
					run.phase = { kind: "claimed" };
				} else run.phase = { kind: "ending", status };
			} else if (
				run.phase.kind === "reporting" &&
				!this.#labelsExhausted(run)
			) {
				return;
			}
		}

		if (
			!(await postRetriedRefusal(this.#input, this.#adapter, this.#writer, run))
		)
			return;

		// A stop decided while reporting, such as a final base refusal, records
		// its attempt here, before the terminal snapshot reads the attempts.
		if (!(await saveAttempt(this.#input, run))) return;

		if (!(await this.#prepareTerminal(run))) return;

		await this.#publishMarker(run);

		if (run.marked !== null && isTerminal(run.marked.status)) {
			await this.#freezeRow(run.marked);
			this.state.runs.delete(run.issue);
			await this.#keepEnded({ ...claimOf(run), seq: run.seq }, false);
		} else if (run.seq !== before) {
			await writeClaim(this.#input, run);
		}
	}

	async #recoverOutput(
		run: ActiveRun,
		output: StageOutput | null,
	): Promise<boolean> {
		const stage = run.stage;

		if (stage === "build") {
			if (output instanceof Object && output.kind === "pending") {
				run.phase = { kind: "recovering", output };

				return true;
			}

			if (!(output instanceof Object) || output.kind !== "build") return false;

			if (
				output.result.kind === "unavailable" ||
				(output.result.kind === "found" &&
					output.result.receipt.policy === "clean" &&
					output.result.receipt.visibleTests?.exitCode == null)
			) {
				if (!this.#enabled) {
					run.phase = { kind: "recovering", output };

					return true;
				}

				const limits = this.#limits();

				if (limits === null) return false;
				this.#input.log("stage_inputs_unavailable", {
					runId: run.runId,
					why:
						output.result.kind === "unavailable"
							? output.result.reason
							: "visible_tests_unavailable",
				});
				this.#endStage(run, "stage_failed", 0, limits);

				return true;
			}

			const bound = await this.#input.files.readContract(run.runId);
			const result = output.result;

			if (
				bound.kind === "blocked" ||
				result.kind !== "found" ||
				(result.receipt.round ?? 0) !== (run.round ?? 0) ||
				result.receipt.baseSha !== run.workflowSha ||
				result.receipt.contractDigest !== bound.digest
			) {
				this.#input.log("stage_inputs_refused", {
					runId: run.runId,
					why: result.kind === "blocked" ? result.reason : "patch_binding",
				});
				this.#stop(
					run,
					inputCause(
						stage,
						result.kind === "blocked" ? result.reason : "patch_binding",
					),
				);

				return true;
			}

			run.phase = {
				kind: "reporting",
				status: "stage_passed",
				effects: { kind: "build", result },
			};

			return true;
		}

		if (stage !== "specify" && stage !== "accept") return false;

		if (stage === "accept") {
			const bound = await this.#input.files.readContract(run.runId);

			if (bound.kind === "blocked") {
				this.#input.log("stage_inputs_refused", {
					runId: run.runId,
					why: bound.reason,
				});
				this.#stop(run, inputCause(stage, bound.reason));

				return true;
			}

			const kept = await this.#input.files.artifacts.read(
				run.runId,
				bound.contract,
				bound.digest,
			);

			if (kept.kind === "blocked") {
				this.#input.log("stage_inputs_refused", {
					runId: run.runId,
					why: kept.reason,
				});
				this.#stop(run, inputCause(stage, kept.reason));

				return true;
			}

			if (kept.kind === "found") {
				run.phase = {
					kind: "reporting",
					status: "stage_passed",
					effects: withFamily(
						{
							kind: "acceptance",
							contract: bound.contract,
							contractDigest: bound.digest,
							suite: kept.suite,
							model: kept.receipt.model,
							observed: kept.receipt.observed,
						},
						kept.receipt.family,
					),
				};

				return true;
			}
		}

		if (
			output === null ||
			(output instanceof Object &&
				(output.kind === "build" ||
					output.kind === "review" ||
					output.kind === "refused"))
		)
			return false;

		if (output instanceof Object && output.kind === "pending") {
			run.phase = { kind: "claimed" };

			return true;
		}

		const prepared = await stageInputs(this.#input, run);

		if (prepared.kind === "wait") {
			run.phase = { kind: "recovering", output };

			return true;
		}

		if (prepared.kind === "fail") {
			this.#stop(run, preparedCause(stage, prepared));

			return true;
		}

		if (prepared.inputs === null) return false;

		run.inputs = prepared.inputs;

		const text = output instanceof Object ? output.text : output;

		const reporting =
			stage === "specify"
				? specified(this.#input, run, text)
				: accepted(
						this.#input,
						this.#config,
						run,
						text,
						output instanceof Object ? output.model : undefined,
						output instanceof Object ? output.observed : null,
						output instanceof Object ? output.family : undefined,
					);

		if (reporting === null) return false;

		run.phase = reporting;

		return true;
	}

	async #applyEffects(run: ActiveRun, effects: Effects): Promise<boolean> {
		const { files } = this.#input;
		const fields = { issue: run.issue, runId: run.runId };

		if (effects.kind === "build") {
			const receipt = effects.result.receipt;
			const contract = await files.readContract(run.runId);

			const suite =
				contract.kind === "found"
					? await files.artifacts.read(
							run.runId,
							contract.contract,
							contract.digest,
						)
					: null;

			if (
				contract.kind !== "found" ||
				suite?.kind !== "found" ||
				receipt.contractDigest !== contract.digest ||
				receipt.acceptanceDigest !== suite.receipt.acceptanceDigest ||
				receipt.baseSha !== run.workflowSha ||
				(receipt.round ?? 0) !== (run.round ?? 0)
			) {
				this.#input.log("stage_inputs_refused", {
					...fields,
					why: "patch_binding",
				});
				this.#stop(run, inputCause("build", "patch_binding"));

				return false;
			}

			const body = renderBuildSummary({ runId: run.runId, receipt });

			if (body === null) {
				this.#stop(run, inputCause("build", "summary_too_large"));
				this.#input.log("stage_inputs_refused", {
					...fields,
					why: "summary_too_large",
				});

				return false;
			}

			const posted = await postKeyed(
				this.#input,
				this.#adapter,
				this.#writer,
				run,
				buildKey(run.runId, receipt.patchDigest),
				body,
			);

			const assessment = assessVisibleChecks(receipt);

			if (
				posted &&
				(receipt.policy === "forbidden" || assessment.kind !== "passed")
			) {
				const forbidden = receipt.policy === "forbidden";

				this.#stop(run, {
					stage: "build",
					class:
						forbidden || assessment.kind === "candidate_failure"
							? "candidate"
							: "missing_evidence",
					reason: forbidden
						? "patch_forbidden"
						: assessment.kind === "candidate_failure"
							? "visible_tests_failed"
							: assessment.kind === "base_failure"
								? "visible_base_failed"
								: "visible_base_unavailable",
				});

				return false;
			}

			return posted;
		}

		if (effects.kind === "acceptance") {
			const stored = await files.artifacts.store({
				...effects,
				storedAttempt: run.attempt,
			});

			if (stored.kind !== "found") {
				this.#input.log("stage_inputs_refused", {
					...fields,
					why: stored.kind === "blocked" ? stored.reason : "acceptance_missing",
				});
				this.#stop(
					run,
					inputCause(
						"accept",
						stored.kind === "blocked" ? stored.reason : "acceptance_missing",
					),
				);

				return false;
			}

			const digest = stored.receipt.acceptanceDigest;
			this.#input.log("acceptance_stored", { ...fields, digest });
			const prior = run.baseCheck;

			// The retried suite takes the refused one's place; the retry stays recorded.
			if (
				prior === undefined ||
				(retryPending(prior) && prior.binding.acceptanceDigest !== digest)
			) {
				const reference = {
					binding: {
						runId: run.runId,
						repo: this.#input.repo,
						issue: run.issue,
						contractDigest: effects.contractDigest,
						acceptanceDigest: digest,
						baseSha: run.workflowSha,
						gateSha: run.workflowSha,
					},
					acceptAttempt: run.attempt,
					storedAttempt: stored.receipt.storedAttempt ?? run.attempt,
					remainingAcceptMs: Math.max(
						0,
						(this.#config?.stages.accept.budget.wallMs ?? 0) -
							(run.acceptWallMs ?? 0) -
							(prior?.retry?.baseWallMs ?? 0),
					),
				};

				run.baseCheck =
					prior === undefined
						? { ...reference, kind: "checking" }
						: {
								...reference,
								kind: "rechecking_replacement",
								retry: prior.retry!,
							};
			}

			run.phase = {
				kind: "base_check",
				abort: new AbortController(),
				dueAt: 0,
				checking: true,
			};
			await writeClaim(this.#input, run);
			await this.#pollBase(run);

			return false;
		}

		if (effects.kind === "contract") {
			effects.stored ||= await files.writeContract(effects);

			if (!effects.stored) {
				this.#input.log("contract_unwritable", fields);

				return false;
			}

			this.#input.log("contract_stored", { ...fields, digest: effects.digest });

			effects.posted ||= await postKeyed(
				this.#input,
				this.#adapter,
				this.#writer,
				run,
				contractKey(run.runId, effects.digest),
				effects.body,
			);

			return effects.posted;
		}

		effects.stored ||= await files.writeQuestions({
			runId: run.runId,
			questions: effects.questions,
			digest: effects.digest,
		});

		if (!effects.stored) {
			this.#input.log("questions_unwritable", fields);

			return false;
		}

		effects.posted ||= await postKeyed(
			this.#input,
			this.#adapter,
			this.#writer,
			run,
			questionsKey(run.runId, effects.digest),
			effects.body,
		);

		if (!effects.posted) return false;

		if (effects.unlabeled) return true;

		if (effects.labelTick === this.#ticks) return false;

		effects.labelTick = this.#ticks;

		if (!effects.labeled) {
			const issue = await this.#adapter.readIssue(run.issue);

			if (issue.kind === "failed") return false;

			effects.labeled = issue.value.labels.includes(NEEDS_INFO_LABEL);
		}

		if (!effects.labeled) {
			const added = await this.#writer.addLabels(run.issue, [NEEDS_INFO_LABEL]);

			effects.labeled = await this.#labelOutcome(
				run,
				NEEDS_INFO_LABEL,
				added.kind,
			);
		}

		if (!effects.labeled) return false;

		const timeline = await this.#adapter.readTimeline(run.issue);

		if (timeline.kind === "failed") return false;

		const latest = latestReadyEntry(timeline.value);

		if (latest.kind !== "found") {
			effects.unlabeled = true;
			this.#input.log("ready_label_preserved", { ...fields, why: latest.kind });

			return true;
		}

		if (latest.entry.kind === "unlabeled" || latest.entry.id !== run.eventId) {
			effects.unlabeled = true;
			this.#input.log(
				latest.entry.kind === "unlabeled"
					? "ready_label_already_removed"
					: "ready_label_preserved",
				{
					...fields,
					eventId: latest.entry.id,
				},
			);
		} else {
			const removed = await this.#writer.removeLabel(run.issue, READY_LABEL);

			effects.unlabeled = await this.#labelOutcome(
				run,
				READY_LABEL,
				removed.kind,
			);
		}

		return effects.unlabeled;
	}

	async #recoverUncertainPost(run: ActiveRun): Promise<"proceed" | "stop"> {
		if (run.inflight?.outcome === "unknown") {
			const ledger = await this.#readLedger(run.issue);

			if (ledger.kind === "failed") return "stop";

			if (ledger.value.kind === "corrupt") {
				this.#markCorrupt(run.issue, ledger.value, null);

				return "stop";
			}

			if (this.#localAhead(run.issue, ledger.value) !== null) return "stop";

			const sent = run.inflight.marker;
			const latest = latestFor(ledger.value, run.runId);

			if (latest?.marker.seq === sent.seq) this.#landed(run, sent);
			else run.inflight = null;
		}

		if (run.inflight?.outcome === "rejected") run.inflight = null;

		return "proceed";
	}

	async #publishMarker(run: ActiveRun): Promise<void> {
		const status = desiredStatus(run.phase);
		const marked = run.marked;

		const projection =
			run.handoff === undefined ? undefined : candidateProjection(run.handoff);

		const holdReason =
			run.handoff?.kind === "selected" && run.handoff.work.kind === "held"
				? run.handoff.work.reason
				: undefined;

		const next = {
			repo: this.#input.repo,
			status,
			seq: run.seq + 1,
			cursor: this.state.seen.get(run.issue)?.updatedAt ?? null,
		};

		const marker =
			run.handoff === undefined && marked?.v === 3
				? { ...marked, ...next, usage: run.usage }
				: markerOf(run, next);

		let changed =
			marked === null ||
			marked.status !== status ||
			marked.stage !== marker.stage ||
			marked.attempt !== marker.attempt ||
			marked.usage !== marker.usage ||
			marked.branch !== marker.branch ||
			(marked.candidate ?? null) !== (marker.candidate ?? null) ||
			(marked.round ?? 0) !== (marker.round ?? 0) ||
			(marked.ciRun ?? null) !== (marker.ciRun ?? null) ||
			marked.pr !== marker.pr ||
			JSON.stringify(marked.handoff) !== JSON.stringify(marker.handoff);

		if (!changed && projection !== undefined && marked !== null) {
			const ledger = await this.#readLedger(run.issue);

			if (ledger.kind === "failed") return;

			if (ledger.value.kind === "corrupt") {
				this.#markCorrupt(run.issue, ledger.value, null);

				return;
			}

			changed =
				latestFor(ledger.value, run.runId)?.body !==
				formatMarker(
					{ ...marker, seq: marked.seq, cursor: marked.cursor },
					holdReason,
					projection.round,
				);
		}

		if (changed) {
			const post = await this.#writer.postComment(
				run.issue,
				formatMarker(marker, holdReason, projection?.round ?? marker.round),
			);

			if (post.kind === "posted") {
				this.state.totals.markersPosted++;
				this.#landed(run, marker);
			} else {
				run.inflight = { marker, outcome: post.kind, tick: this.#ticks };
				this.#input.log("marker_unconfirmed", {
					issue: run.issue,
					runId: run.runId,
					seq: marker.seq,
					outcome: post.kind,
				});
			}
		}
	}

	#landed(run: ActiveRun, marker: Marker): void {
		run.marked = marker;
		run.seq = marker.seq;
		run.inflight = null;
		this.#local.set(run.issue, { ...claimOf(run), seq: run.seq });
		this.#behind.delete(run.issue);
		this.#input.log("marker_posted", {
			issue: run.issue,
			runId: run.runId,
			seq: marker.seq,
			status: marker.status,
			stage: marker.stage,
		});
	}

	#report(input: ReportInput): TickReport {
		const runs = [...this.state.runs.values()]
			.sort((left, right) => left.issue - right.issue)
			.map(
				(run): RunView => ({
					issue: run.issue,
					runId: run.runId,
					eventId: run.eventId,
					stage: run.stage,
					status: desiredStatus(run.phase),
					attempt: run.attempt,
					seq: run.seq,
					markerPending: run.inflight !== null,
					workspace: run.workspaceMissing ? "missing_replayed" : "present",
					retryAt:
						run.phase.kind === "retry_queued"
							? new Date(run.phase.dueAt).toISOString()
							: null,
					usage: run.usage,
					unverified: this.#claimView(run).unverified,
				}),
			);

		return {
			repo: this.#input.repo,
			at: new Date(input.now).toISOString(),
			executionEnabled: this.#enabled,
			dispatch: { enabled: input.enabled, reasons: input.reasons },
			workflowSha: this.#workflowSha,
			attentionThresholds: this.#config?.attention,
			maxConcurrent: input.limits?.maxConcurrent ?? 0,
			active: this.#active(),
			runs,
			feedbackIntake: [...this.#feedbackObservations.values()]
				.flatMap((entry) =>
					entry.tick === this.#ticks &&
					runs.some((run) => run.runId === entry.problem.runId)
						? [entry.problem]
						: [],
				)
				.sort((a, b) => a.issue - b.issue),
			unverifiedClaims: [...this.#observations.entries()]
				.flatMap(([runId, held]) => {
					const unverified = claimProjection(
						held.observation,
						this.#ticks,
						held.eventId,
					).unverified;

					return held.tick === this.#ticks && unverified !== null
						? [
								{
									issue: held.issue,
									runId,
									eventId: held.eventId,
									...unverified,
								},
							]
						: [];
				})
				.sort((a, b) => a.issue - b.issue),
			queued: input.queued,
			absent: input.absent,
			refused: [
				...input.refused,
				...[...this.state.seen.entries()].flatMap(([issue, seen]) =>
					seen.verdict.kind === "refused" &&
					!input.refused.some((entry) => entry.issue === issue)
						? [{ issue, reasons: [seen.verdict.reason] }]
						: [],
				),
			],
			corrupt: [...this.state.corrupt.entries()]
				.sort(([left], [right]) => left - right)
				.map(([issue, entry]) => ({ issue, defect: entry.defect })),
			ledgerBehind: [...this.#behind.values()].sort(
				(left, right) => left.issue - right.issue,
			),
			totals: { ...this.state.totals },
		};
	}
}
