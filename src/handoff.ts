import type { PatchRead, PatchReceipt } from "./build.ts";
import {
	MAX_FEEDBACK_SEEN,
	MAX_FEEDBACK_BATCHES,
	wireFeedbackCursor,
	wireBuilderDecisions,
	type FeedbackCursor,
	type FeedbackObservation,
	type FeedbackBatchRef,
} from "./feedback.ts";
import { checkChangedPaths } from "./policy.ts";
import {
	familyClaimsHold,
	findingFingerprints,
	isJudgmentOutcome,
	type Judgment,
	type JudgmentOutcome,
	parseFamily,
	type ReviewBinding,
	type ReviewReceipt,
	type ReviewInputRefusal,
	type ReviewSeat,
} from "./review.ts";
import {
	REPAIR_BUILD_MAX_TOKENS,
	REVIEW_MAX_TOKENS,
	blocksReview,
	digestOf,
	type Digest,
	type Verdict,
	verdictPasses,
} from "./run.ts";
import type {
	AssessmentRef,
	ReadAssessment,
	TrustedReport,
	ValidationState,
} from "./validation.ts";
import {
	isGitSha,
	isRepoSlug,
	type GitSha,
	type RepoSlug,
} from "./workflow.ts";
import { isDigest } from "./run.ts";
import type { JsonValue } from "./tickets.ts";

export const MAX_REFRESHES = 3;
export const MAX_GENERATIONS = 6;
export const MAX_REPAIR_ROUNDS = 2;
export const MAX_REVIEW_ATTEMPTS = 3;

export type RepairRound = 0 | 1 | 2;

export type GenerationNumber = 0 | 1 | 2 | 3;

export type AdmissionPin = Readonly<{
	runId: Digest;
	repo: RepoSlug;
	issue: number;
	originalBase: GitSha;
	workflowSha: GitSha;
	workflowDigest: Digest;
	contractDigest: Digest;
	acceptanceDigest: Digest;
	maxTokens: number;
	maxReviewAttempts: number;
}>;

export type GenerationRef = Readonly<{
	round: RepairRound;
	generation: GenerationNumber;
	digest: Digest;
}>;

export type GenerationIntent = GenerationRef &
	Readonly<{
		runId: Digest;
		originalBase: GitSha;
		baseSha: GitSha;
		patchDigest: Digest;
		acceptanceDigest: Digest;
		origin:
			| { readonly kind: "initial" }
			| { readonly kind: "repair"; readonly feedbackFrom: GenerationRef }
			| { readonly kind: "refresh"; readonly previous: GenerationRef }
			| {
					readonly kind: "owner";
					readonly head: GitSha;
					readonly previous: GenerationRef;
			  };
		publication:
			| { readonly kind: "initial" }
			| { readonly kind: "successor"; readonly expectedHead: GitSha }
			| { readonly kind: "owner"; readonly head: GitSha };
	}>;

export type ReviewExecution = Readonly<{
	id: Digest;
	stage: "review";
	runId: Digest;
	round: RepairRound;
	attempt: number;
	generation: GenerationRef;
	workflowSha: GitSha;
	workflowDigest: Digest;
	binding: ReviewBinding;
	seats: readonly ReviewSeat[];
}>;

export type RepairCause =
	| Readonly<{ kind: "validation"; assessment: AssessmentRef }>
	| Readonly<{ kind: "review"; assessment: AssessmentRef; review: Digest }>
	| Readonly<{
			kind: "feedback";
			batch: Digest;
			assessment: AssessmentRef;
			review: Digest | null;
	  }>;

/** The digest a review-driven repair binds: the receipt's stored JSON bytes. */
export function reviewReceiptDigest(receipt: ReviewReceipt): Digest {
	return digestOf(JSON.stringify(receipt));
}

export type RepairExecution = Readonly<{
	id: Digest;
	stage: "build";
	runId: Digest;
	round: 1 | 2;
	attempt: number;
	feedbackFrom: GenerationRef;
	cause: RepairCause;
	workflowSha: GitSha;
	workflowDigest: Digest;
}>;

export type CandidateExecution = ReviewExecution | RepairExecution;

export type AttemptAccount = Readonly<{
	execution: CandidateExecution;
	spend:
		| { readonly kind: "known"; readonly tokens: number }
		| { readonly kind: "unknown"; readonly floor: number };
	settlement: "issued" | "running" | "settled" | "uncertain";
}>;

export type Certification = Readonly<{
	generation: GenerationRef;
	workflowSha: GitSha;
	workflowDigest: Digest;
	execution: ReviewExecution;
	verdict: Verdict;
	review: ReviewReceipt;
	report: TrustedReport;
}>;

export type OwnerHeadRefusal =
	| "heldout_changed"
	| "forbidden_path"
	| "behind_main"
	| "too_large"
	| "unreadable";

export type OwnerPatchReceipt = Readonly<{
	version: 1;
	kind: "owner";
	runId: Digest;
	head: GitSha;
	baseSha: GitSha;
	contractDigest: Digest;
	acceptanceDigest: Digest;
	heldoutDigest: Digest;
	patchDigest: Digest;
	changedPaths: readonly string[];
	policy: "clean";
}>;

export type OwnerPatchRead = Readonly<{
	kind: "found";
	receipt: OwnerPatchReceipt;
	patch: string;
}>;

export type GenerationEvidence = Readonly<{
	intent: GenerationIntent;
	patch: PatchReceipt;
	ownerPatch?: OwnerPatchReceipt | null;
	validation: ValidationState | null;
	verdict: Verdict | null;
	report: TrustedReport | null;
	certification: Certification | null;
	assessment?: AssessmentRef;
	assessmentKind?: "passed" | "candidate" | "unusable";
	/** The completed review, including blocking reviews that cannot certify. */
	review?: ReviewReceipt;
}>;

export type HandoffReason =
	| "disabled"
	| "main_moving"
	| "refresh_limit"
	| "review_attempts"
	| "review_tokens"
	| "repair_tokens"
	| "run_tokens"
	| "head_drift"
	| "owner_head"
	| "owner_head_refused"
	| "owner_head_failed"
	| "owner_head_behind"
	| "checks_failed"
	| "head_lag"
	| "checks_incomplete"
	| "review_failed"
	| "review_input_too_large"
	| "summary_too_large"
	| "pr_identity"
	| "pr_ambiguous"
	| "validation_failed"
	| "evidence_unavailable"
	| "repair_limit"
	| "diagnosis_oracle"
	| "diagnosis_missing_evidence"
	| "diagnosis_infrastructure"
	| "feedback_overflow"
	| "feedback_repair"
	| "repair_no_progress"
	| "repair_repeated_finding"
	| "closed"
	| "withdrawn";

export type PublishedPr = Readonly<{
	ownerHead?: GitSha | null;
	number: number;
	branch: string;
	promoted: GenerationRef;
	readiness:
		| { readonly kind: "ready"; readonly since: number }
		| {
				readonly kind: "not_ready";
				readonly since: number;
				readonly reason: HandoffReason;
		  };
}>;

export type PrObservation =
	| { readonly kind: "none" }
	| { readonly kind: "unavailable" }
	| {
			readonly kind: "open";
			readonly number: number;
			readonly head: GitSha;
			readonly refHead: GitSha;
	  }
	| { readonly kind: "closed"; readonly number: number; readonly head: GitSha }
	| {
			readonly kind: "merged";
			readonly number: number;
			readonly head: GitSha;
			readonly mergeSha: GitSha;
			readonly actor: string | null;
	  };

export type TerminalObservation =
	| { readonly kind: "released" }
	| {
			readonly kind: "merged";
			readonly number: number;
			readonly head: GitSha;
			readonly mergeSha: GitSha;
			readonly actor: string | null;
			readonly assurance:
				| {
						readonly kind: "factory_verified";
						readonly certification: GenerationRef;
				  }
				| { readonly kind: "owner_override" };
			readonly readiness: PublishedPr["readiness"] | null;
	  }
	| {
			readonly kind: "cancelled";
			readonly number: number;
			readonly reason: "closed" | "withdrawn";
	  }
	| { readonly kind: "failed"; readonly reason: HandoffReason };

export type HandoffNotice = Readonly<{
	kind:
		| "feedback_intake"
		| "feedback_overflow"
		| "repair_started"
		| "repair_unavailable"
		| "round_summary"
		| "owner_head"
		| "owner_head_failed"
		| "checks_failed";
	place: "issue" | "pr";
	key: `<!-- factory:notice ${string} -->`;
}>;

export type NoticeNext =
	| Readonly<{ kind: "owner_due"; head: GitSha; since: number }>
	| Readonly<{
			kind: "resume";
			work: Extract<CandidateWork, { kind: "waiting" | "held" }>;
	  }>
	| Extract<CandidateWork, { kind: "repair_due" }>
	| Readonly<{ kind: "held"; reason: HandoffReason }>
	| Readonly<{
			kind: "finish";
			terminal: Extract<TerminalObservation, { kind: "cancelled" }>;
	  }>;

export type CandidateEffect =
	| {
			readonly kind: "derive_owner_patch";
			readonly head: GitSha;
			readonly baseSha: GitSha;
			readonly attempt?: 1 | 2 | 3;
	  }
	| { readonly kind: "validate"; readonly generation: GenerationIntent }
	| { readonly kind: "launch_review"; readonly execution: ReviewExecution }
	| { readonly kind: "repair_build"; readonly execution: RepairExecution }
	| {
			readonly kind: "stop_execution";
			readonly execution: CandidateExecution;
			readonly terminal: TerminalObservation | null;
	  }
	| {
			readonly kind: "open_pr";
			readonly certification: GenerationRef;
			readonly head: GitSha;
			readonly branch: string;
	  }
	| {
			readonly kind: "promote_pr";
			readonly number: number;
			readonly expectedHead: GitSha;
			readonly certification: GenerationRef;
			readonly head: GitSha;
	  }
	| {
			readonly kind: "complete_handoff";
			readonly number: number;
			readonly certification: GenerationRef;
			readonly head: GitSha;
	  }
	| {
			readonly kind: "void_readiness";
			readonly number: number;
			readonly reason: HandoffReason;
	  }
	| {
			readonly kind: "post_notice";
			readonly number: number;
			readonly notice: HandoffNotice;
			readonly at?: number;
			readonly detail?: HandoffReason | null;
			readonly refusal?: OwnerHeadRefusal;
			readonly withdraw: HandoffReason | null;
			readonly then: NoticeNext;
	  }
	| { readonly kind: "finish_pr"; readonly terminal: TerminalObservation };

export type CandidateWork =
	| {
			readonly kind: "owner_due";
			readonly head: GitSha;
			readonly since: number;
			readonly attempt?: 1 | 2 | 3;
	  }
	| { readonly kind: "effect"; readonly request: CandidateEffect }
	| { readonly kind: "review_due"; readonly seats: readonly ReviewSeat[] }
	| { readonly kind: "reviewing"; readonly execution: ReviewExecution }
	| {
			readonly kind: "repair_due";
			readonly round: 1 | 2;
			readonly attempt: number;
			readonly feedbackFrom: GenerationRef;
			readonly cause: RepairCause;
	  }
	| { readonly kind: "rebuilding"; readonly execution: RepairExecution }
	| {
			readonly kind: "repair_built";
			readonly patch: PatchReceipt;
			readonly feedbackFrom: GenerationRef;
	  }
	| { readonly kind: "handoff" }
	| { readonly kind: "waiting" }
	| {
			readonly kind: "held";
			readonly reason: HandoffReason;
			readonly since: number;
	  }
	| { readonly kind: "terminal"; readonly terminal: TerminalObservation };

type CandidateCommon = Readonly<{
	pin: AdmissionPin;
	priorTokens: number;
	accounts: readonly AttemptAccount[];
}>;

export type CandidateState =
	| (CandidateCommon & Readonly<{ kind: "unprepared"; patch: PatchReceipt }>)
	| (CandidateCommon &
			Readonly<{
				kind: "selected";
				history: readonly GenerationEvidence[];
				current: GenerationEvidence;
				published: PublishedPr | null;
				feedback: FeedbackCursor | null;
				work: CandidateWork;
			}>);

type Selected = Extract<CandidateState, { kind: "selected" }>;

export type CandidateEffectResult =
	| {
			readonly kind: "derive_owner_patch";
			readonly request: Extract<
				CandidateEffect,
				{ kind: "derive_owner_patch" }
			>;
			readonly result:
				| { readonly kind: "found"; readonly patch: OwnerPatchReceipt }
				| { readonly kind: "refused"; readonly reason: OwnerHeadRefusal };
	  }
	| {
			readonly kind: "validate";
			readonly request: Extract<CandidateEffect, { kind: "validate" }>;
			readonly result:
				| { readonly kind: "waiting"; readonly validation: ValidationState }
				| {
						readonly kind: "finished";
						readonly validation: ValidationState;
						readonly verdict: Verdict;
						readonly report: TrustedReport | null;
						readonly seats: readonly ReviewSeat[];
						readonly assessment: ReadAssessment;
				  }
				| {
						readonly kind: "failed";
						readonly validation: ValidationState | null;
						readonly reason: HandoffReason;
				  };
	  }
	| {
			readonly kind: "launch_review";
			readonly request: Extract<CandidateEffect, { kind: "launch_review" }>;
			readonly started: boolean;
	  }
	| {
			readonly kind: "repair_build";
			readonly request: Extract<CandidateEffect, { kind: "repair_build" }>;
			readonly started: boolean;
	  }
	| {
			readonly kind: "stop_execution";
			readonly request: Extract<CandidateEffect, { kind: "stop_execution" }>;
			readonly tokens: number | null;
			readonly stopped: boolean;
	  }
	| {
			readonly kind: "open_pr";
			readonly request: Extract<CandidateEffect, { kind: "open_pr" }>;
			readonly number: number;
			readonly head: GitSha;
			readonly refHead: GitSha;
	  }
	| {
			readonly kind: "promote_pr";
			readonly request: Extract<CandidateEffect, { kind: "promote_pr" }>;
			readonly head: GitSha;
			readonly refHead: GitSha;
	  }
	| {
			readonly kind: "complete_handoff";
			readonly request: Extract<CandidateEffect, { kind: "complete_handoff" }>;
			readonly now: number;
	  }
	| {
			readonly kind: "void_readiness";
			readonly request: Extract<CandidateEffect, { kind: "void_readiness" }>;
	  }
	| {
			readonly kind: "post_notice";
			readonly request: Extract<CandidateEffect, { kind: "post_notice" }>;
	  }
	| {
			readonly kind: "finish_pr";
			readonly request: Extract<CandidateEffect, { kind: "finish_pr" }>;
	  };

type CandidateEventData =
	| {
			readonly kind: "resume_execution";
			readonly execution: CandidateExecution;
			readonly tokens: number;
	  }
	| {
			readonly kind: "observed";
			readonly now: number;
			readonly pr: PrObservation;
			readonly main: GitSha | null;
			readonly executionAllowed: boolean;
			readonly eligibility: "ready" | "withdrawn" | "unverified";
			readonly feedback?: FeedbackObservation;
			readonly capacityAvailable: boolean;
			readonly readiness:
				| {
						readonly kind: "current";
						readonly head: GitSha;
						readonly report: TrustedReport;
				  }
				| { readonly kind: "not_ready"; readonly reason: HandoffReason }
				| { readonly kind: "unavailable" };
	  }
	| {
			readonly kind: "effect_held";
			readonly reason: "evidence_unavailable" | "pr_identity" | "pr_ambiguous";
			readonly now: number;
	  }
	| {
			readonly kind: "effect_completed";
			readonly completion: CandidateEffectResult;
	  }
	| {
			readonly kind: "execution_progress";
			readonly execution: CandidateExecution;
			readonly tokens: number;
	  }
	| {
			readonly kind: "review_settled";
			readonly execution: ReviewExecution;
			readonly tokens: number | null;
			readonly result:
				| {
						readonly kind: "passed";
						readonly review: ReviewReceipt;
						readonly patch:
							| Extract<PatchRead, { kind: "found" }>
							| OwnerPatchRead;
				  }
				| {
						readonly kind: "failed";
						readonly reason?: ReviewInputRefusal["reason"];
				  };
	  }
	| {
			readonly kind: "repair_settled";
			readonly execution: RepairExecution;
			readonly tokens: number | null;
			readonly result:
				| { readonly kind: "passed"; readonly patch: PatchReceipt }
				| { readonly kind: "no_change" }
				| { readonly kind: "failed" };
	  };

export type CandidateEvent = CandidateEventData & Readonly<{ now?: number }>;

export type CandidateStep = Readonly<{
	state: CandidateState;
	effect: CandidateEffect | null;
}>;

export type CandidateProjection = Readonly<{
	stage: import("./run.ts").Stage;
	status: import("./markers.ts").RunStatus;
	attempt: number;
	round: number;
	progress: import("./run.ts").Progress;
}>;

export function candidateProjection(
	state: CandidateState,
): CandidateProjection {
	let stage: import("./run.ts").Stage = "validate";
	let status: import("./markers.ts").RunStatus = "running";
	let round = 0;
	let attempt = 1;
	let progress: import("./run.ts").Progress | null = null;

	if (state.kind === "selected") {
		round = state.current.intent.round;
		const work = state.work;

		if (work.kind === "repair_due") round = work.round;
		else if (work.kind === "rebuilding") round = work.execution.round;
		else if (work.kind === "repair_built") round = work.patch.round ?? round;
		else if (work.kind === "effect" && work.request.kind === "repair_build")
			round = work.request.execution.round;

		if (work.kind === "review_due" || work.kind === "reviewing")
			stage = "review";
		else if (work.kind === "rebuilding" || work.kind === "repair_due")
			stage = "build";
		else if (work.kind !== "effect" && work.kind !== "repair_built")
			stage = "land";

		if (work.kind === "effect") {
			if (work.request.kind === "launch_review") stage = "review";
			else if (work.request.kind === "repair_build") stage = "build";
			else if (work.request.kind !== "validate") stage = "land";
		}

		if (work.kind === "waiting") {
			status = "waiting";
			progress = { kind: "waiting", checkpoint: "merge" };
		} else if (work.kind === "held") {
			status = "blocked";
			const latest = state.accounts.at(-1)?.execution;

			round = Math.max(round, ...state.accounts.map((a) => a.execution.round));

			if (
				work.reason.startsWith("repair_") ||
				work.reason === "feedback_repair"
			)
				stage = "build";
			else if (work.reason.startsWith("review_")) stage = "review";
			else if (
				work.reason === "validation_failed" ||
				work.reason.startsWith("diagnosis_")
			)
				stage = "validate";
			else if (
				latest !== undefined &&
				["run_tokens", "disabled", "evidence_unavailable"].includes(work.reason)
			)
				stage = latest.stage;
		} else if (work.kind === "terminal") {
			const terminal = work.terminal;

			if (terminal.kind === "merged") {
				status = "landed";
				progress = {
					kind: "finished",
					outcome: { kind: "landed", mergeSha: terminal.mergeSha },
				};
			} else if (terminal.kind === "failed") {
				status = ["review_tokens", "repair_tokens", "run_tokens"].includes(
					terminal.reason,
				)
					? "budget_exhausted"
					: "failed";
				progress = {
					kind: "finished",
					outcome:
						status === "budget_exhausted"
							? { kind: "budget_exhausted", stage }
							: { kind: "failed", stage, evidence: terminal.reason },
				};
			} else {
				status = terminal.kind === "released" ? "released" : "cancelled";
				progress = { kind: "finished", outcome: { kind: "cancelled" } };
			}
		}

		attempt = Math.max(
			1,
			...state.accounts
				.filter(
					(a) => a.execution.stage === stage && a.execution.round === round,
				)
				.map((a) => a.execution.attempt),
		);

		if (work.kind === "repair_due") attempt = work.attempt;
		else if (work.kind === "review_due")
			attempt =
				1 +
				Math.max(
					0,
					...state.accounts
						.filter(
							(a) =>
								a.execution.stage === "review" && a.execution.round === round,
						)
						.map((a) => a.execution.attempt),
				);
	}

	return {
		stage,
		status,
		round,
		attempt,
		progress: progress ?? { kind: "active", stage },
	};
}

function freeze<T>(value: T): T {
	if (value instanceof Object && !Object.isFrozen(value)) {
		for (const nested of Object.values(value)) freeze(nested);
		Object.freeze(value);
	}

	return value;
}

function snapshot<T>(value: T): T {
	return freeze(structuredClone(value));
}

function refOf(intent: GenerationIntent): GenerationRef {
	return {
		round: intent.round,
		generation: intent.generation,
		digest: intent.digest,
	};
}

export function sameGeneration(
	left: GenerationRef,
	right: GenerationRef,
): boolean {
	return (
		left.round === right.round &&
		left.generation === right.generation &&
		left.digest === right.digest
	);
}

export function generationIntent(input: {
	pin: AdmissionPin;
	patch: Pick<PatchReceipt, "patchDigest">;
	round: RepairRound;
	generation: GenerationNumber;
	baseSha: GitSha;
	origin: GenerationIntent["origin"];
	publication: GenerationIntent["publication"];
}): GenerationIntent {
	const body = {
		round: input.round,
		generation: input.generation,
		runId: input.pin.runId,
		originalBase: input.pin.originalBase,
		baseSha: input.baseSha,
		patchDigest: input.patch.patchDigest,
		acceptanceDigest: input.pin.acceptanceDigest,
		origin: input.origin,
		publication: input.publication,
	};

	return snapshot({ ...body, digest: digestOf(JSON.stringify(body)) });
}

export function ownerPatchValid(
	pin: Pick<AdmissionPin, "runId" | "contractDigest" | "acceptanceDigest">,
	g: GenerationIntent,
	patch: OwnerPatchReceipt,
): boolean {
	return (
		g.origin.kind === "owner" &&
		g.publication.kind === "owner" &&
		patch.runId === pin.runId &&
		patch.head === g.origin.head &&
		patch.head === g.publication.head &&
		patch.baseSha === g.baseSha &&
		patch.patchDigest === g.patchDigest &&
		patch.contractDigest === pin.contractDigest &&
		patch.acceptanceDigest === pin.acceptanceDigest &&
		patch.policy === "clean" &&
		checkChangedPaths({ changedPaths: [...patch.changedPaths] }).kind ===
			"clean"
	);
}

export function authoredOf(
	state: Selected,
	ref: GenerationRef,
): "factory" | "owner" {
	const g = candidateGenerations(state).find((g) =>
		sameGeneration(g.intent, ref),
	);

	if (g === undefined) throw new Error("certification_missing");

	return g.intent.origin.kind === "owner" ? "owner" : "factory";
}

function validPatch(
	pin: AdmissionPin,
	patch: PatchReceipt,
	round: number,
): boolean {
	return (
		patch.runId === pin.runId &&
		(patch.round ?? 0) === round &&
		patch.baseSha === pin.originalBase &&
		patch.contractDigest === pin.contractDigest &&
		patch.acceptanceDigest === pin.acceptanceDigest &&
		patch.policy === "clean" &&
		patch.visibleTests?.exitCode === 0 &&
		checkChangedPaths({ changedPaths: [...patch.changedPaths] }).kind ===
			"clean"
	);
}

export function beginCandidate(
	pin: AdmissionPin,
	patch: PatchReceipt,
	priorTokens: number,
): Extract<CandidateState, { kind: "unprepared" }> {
	if (
		!validPatch(pin, patch, 0) ||
		!Number.isSafeInteger(priorTokens) ||
		priorTokens < 0 ||
		!Number.isSafeInteger(pin.maxTokens) ||
		pin.maxTokens < 1 ||
		!Number.isSafeInteger(pin.maxReviewAttempts) ||
		pin.maxReviewAttempts < 1 ||
		pin.maxReviewAttempts > MAX_REVIEW_ATTEMPTS
	)
		throw new Error("candidate_binding");

	return snapshot({
		kind: "unprepared",
		pin,
		patch,
		priorTokens,
		accounts: [],
	});
}

function tokensOf(account: AttemptAccount): number {
	return account.spend.kind === "known"
		? account.spend.tokens
		: account.spend.floor;
}

export function candidateUsage(state: CandidateState): number {
	return (
		state.priorTokens +
		state.accounts.reduce((sum, account) => sum + tokensOf(account), 0)
	);
}

export function candidateGenerations(
	state: Selected,
): readonly GenerationEvidence[] {
	return [...state.history, state.current];
}

function latestGeneration(state: Selected): GenerationNumber {
	return candidateGenerations(state)
		.filter((g) => g.intent.round === state.current.intent.round)
		.reduce<GenerationNumber>(
			(latest, g) =>
				g.intent.generation > latest ? g.intent.generation : latest,
			0,
		);
}

function executionEqual(a: CandidateExecution, b: CandidateExecution): boolean {
	return a.id === b.id && JSON.stringify(a) === JSON.stringify(b);
}

function accountFor(
	state: Selected,
	execution: CandidateExecution,
): AttemptAccount | null {
	return (
		state.accounts.find((a) => executionEqual(a.execution, execution)) ?? null
	);
}

function nextAttempt(
	state: Selected,
	stage: "review" | "build",
	round: number,
): number {
	return (
		1 +
		Math.max(
			0,
			...state.accounts
				.filter(
					(a) => a.execution.stage === stage && a.execution.round === round,
				)
				.map((a) => a.execution.attempt),
		)
	);
}

// Attempt 2 of F10-2 used 55,620 tokens even without edits. Keep a small margin.
const REPAIR_LAUNCH_MIN_TOKENS = 60_000;

function preflight(
	state: Selected,
	stage: "review" | "build",
	round: number,
): HandoffReason | null {
	if (
		state.accounts.some(
			(a) => a.spend.kind === "unknown" || a.settlement !== "settled",
		)
	)
		return "evidence_unavailable";

	const minimum = stage === "build" ? REPAIR_LAUNCH_MIN_TOKENS : 1;

	if (state.pin.maxTokens - candidateUsage(state) < minimum)
		return "run_tokens";

	if (nextAttempt(state, stage, round) > state.pin.maxReviewAttempts)
		return "review_attempts";

	const spent = state.accounts
		.filter((a) => a.execution.stage === stage && a.execution.round === round)
		.reduce((sum, a) => sum + tokensOf(a), 0);

	return (stage === "review" ? REVIEW_MAX_TOKENS : REPAIR_BUILD_MAX_TOKENS) -
		spent <
		minimum
		? stage === "review"
			? "review_tokens"
			: "repair_tokens"
		: null;
}

export function candidateAllowance(
	state: Selected,
	execution: CandidateExecution,
): number {
	const account = accountFor(state, execution);

	if (account === null || account.spend.kind === "unknown") return 0;

	const limit =
		execution.stage === "review" ? REVIEW_MAX_TOKENS : REPAIR_BUILD_MAX_TOKENS;

	const spent = state.accounts
		.filter(
			(a) =>
				a.execution.stage === execution.stage &&
				a.execution.round === execution.round,
		)
		.reduce((sum, a) => sum + tokensOf(a), 0);

	return Math.max(
		0,
		Math.min(state.pin.maxTokens - candidateUsage(state), limit - spent),
	);
}

function activeExecution(state: Selected): CandidateExecution | null {
	return (
		state.accounts.find((a) => a.settlement !== "settled")?.execution ?? null
	);
}

function effect(state: Selected, request: CandidateEffect): Selected {
	return { ...state, work: { kind: "effect", request } };
}

function hold(state: Selected, reason: HandoffReason, now: number): Selected {
	const awaitingForge =
		reason === "checks_incomplete" ||
		reason === "head_lag" ||
		reason === "head_drift";

	return !awaitingForge &&
		state.published !== null &&
		state.feedback?.batches.some((b) => b.status.kind === "applying")
		? stopRound(state, reason, now)
		: held(state, reason, now);
}

function held(state: Selected, reason: HandoffReason, now: number): Selected {
	const since =
		state.work.kind === "held" && state.work.reason === reason
			? state.work.since
			: state.published?.readiness.kind === "not_ready" &&
					state.published.readiness.reason === reason
				? state.published.readiness.since
				: now;

	const published =
		state.published === null
			? null
			: {
					...state.published,
					readiness:
						state.published.readiness.kind === "not_ready" &&
						state.published.readiness.reason === reason
							? state.published.readiness
							: ({ kind: "not_ready", since, reason } as const),
				};

	return { ...state, published, work: { kind: "held", reason, since } };
}

function freshEvidence(
	intent: GenerationIntent,
	patch: PatchReceipt,
): GenerationEvidence {
	return {
		intent,
		patch,
		validation: null,
		verdict: null,
		report: null,
		certification: null,
	};
}

function selectGeneration(
	state: Selected,
	intent: GenerationIntent,
	patch: PatchReceipt,
	now: number,
): Selected {
	if (state.history.length + 2 > MAX_GENERATIONS)
		return hold(state, "refresh_limit", now);

	return effect(
		{
			...state,
			history: [...state.history, state.current],
			current: freshEvidence(intent, patch),
		},
		{ kind: "validate", generation: intent },
	);
}

function terminalFor(
	state: Selected,
	pr: Extract<PrObservation, { kind: "merged" }>,
): TerminalObservation {
	const found = candidateGenerations(state).find(
		(g) => g.certification?.verdict.candidateSha === pr.head,
	);

	return {
		kind: "merged",
		number: pr.number,
		head: pr.head,
		mergeSha: pr.mergeSha,
		actor: pr.actor,
		assurance:
			found === undefined
				? { kind: "owner_override" }
				: { kind: "factory_verified", certification: refOf(found.intent) },
		readiness: state.published?.readiness ?? null,
	};
}

function finish(
	state: Selected,
	terminal: TerminalObservation,
	now = 0,
): Selected {
	const execution = activeExecution(state);

	if (
		execution === null &&
		terminal.kind === "cancelled" &&
		state.feedback?.batches.some((b) => b.status.kind === "applying")
	)
		return stopRound(state, terminal.reason, now, terminal);

	return effect(
		state,
		execution === null
			? { kind: "finish_pr", terminal }
			: { kind: "stop_execution", execution, terminal },
	);
}

/** End a round without abandoning observation of an already-published PR. */
export function stopRound(
	state: Selected,
	reason: HandoffReason,
	now: number,
	terminal: Extract<TerminalObservation, { kind: "cancelled" }> | null = null,
): Selected {
	if (state.published === null)
		return finish(state, { kind: "failed", reason });

	if (state.current.intent.origin.kind === "owner" && terminal === null) {
		const why =
			reason === "main_moving" || reason === "owner_head_behind"
				? "owner_head_behind"
				: "owner_head_failed";

		return headNotice(
			state,
			"owner_head_failed",
			why,
			state.current.intent.origin.head,
			now,
			{ kind: "held", reason: why },
		);
	}

	const applying = state.feedback?.batches.find(
		(b) => b.status.kind === "applying",
	);

	if (applying === undefined || applying.status.kind !== "applying") {
		if (terminal !== null) return finish(state, terminal, now);

		if (
			(state.work.kind === "effect" &&
				state.work.request.kind === "post_notice" &&
				state.work.request.notice.kind === "round_summary") ||
			(state.work.kind === "held" &&
				state.feedback?.batches.some(
					(b) =>
						b.status.kind === "settled" &&
						b.status.outcome.kind === "stopped" &&
						state.work.kind === "held" &&
						b.status.outcome.reason === state.work.reason,
				))
		)
			return state;

		return hold(state, reason, now);
	}

	const round = applying.status.round;

	const stopped = {
		...state,
		feedback:
			state.feedback === null
				? null
				: {
						...state.feedback,
						batches: state.feedback.batches.map((b) =>
							b.digest === applying.digest
								? {
										...b,
										status: {
											kind: "settled",
											outcome: { kind: "stopped", reason },
										} as const,
									}
								: b,
						),
					},
	};

	const stoppedHold = held(stopped, reason, now);

	return effect(stoppedHold, {
		kind: "post_notice",
		number: state.published.number,
		at: stoppedHold.work.kind === "held" ? stoppedHold.work.since : now,
		notice: {
			kind: "round_summary",
			place: "pr",
			key: `<!-- factory:notice ${state.pin.runId} round_summary ${round} -->`,
		},
		withdraw: reason,
		// Persisted transition data, not a Promise callback.
		// oxlint-disable-next-line unicorn/no-thenable
		then:
			terminal === null
				? { kind: "held", reason }
				: { kind: "finish", terminal },
	});
}

function failOrRepair(
	state: Selected,
	cause: RepairCause,
	now: number,
): Selected {
	if (state.published !== null)
		return stopRound(
			state,
			cause.kind === "validation" ? "validation_failed" : "review_failed",
			now,
		);
	const round = state.current.intent.round;

	if (round === MAX_REPAIR_ROUNDS)
		return finish(state, { kind: "failed", reason: "repair_limit" });

	return {
		...state,
		work: {
			kind: "repair_due",
			round: round === 0 ? 1 : 2,
			attempt: 1,
			feedbackFrom: refOf(state.current.intent),
			cause,
		},
	};
}

function stopDiagnosed(
	state: Selected,
	reason: HandoffReason,
	now: number,
): Selected {
	return state.published === null
		? reason === "diagnosis_infrastructure"
			? hold(state, reason, now)
			: finish(state, { kind: "failed", reason })
		: stopRound(state, reason, now);
}

function assessedValidation(
	state: Selected,
	current: GenerationEvidence,
	verdict: Verdict,
	read: ReadAssessment,
	now: number,
): Selected {
	const intent = current.intent;
	const b = read.binding;

	const assessed = {
		...state,
		current: {
			...current,
			verdict,
			assessment: read.ref,
			assessmentKind:
				read.assessment.kind === "passed"
					? ("passed" as const)
					: read.assessment.failure.kind === "candidate"
						? ("candidate" as const)
						: ("unusable" as const),
		},
	};

	if (
		b.runId !== state.pin.runId ||
		b.round !== intent.round ||
		b.generation !== intent.generation ||
		b.candidateSha !== verdict.candidateSha ||
		b.ciRunId !== verdict.ciRunId ||
		b.verdictDigest !== digestOf(JSON.stringify(verdict)) ||
		(read.assessment.kind === "passed") !== verdictPasses(verdict)
	)
		return stopDiagnosed(assessed, "diagnosis_missing_evidence", now);

	if (read.assessment.kind === "passed") return assessed;

	switch (read.assessment.failure.kind) {
		case "candidate":
			return failOrRepair(
				assessed,
				{ kind: "validation", assessment: read.ref },
				now,
			);
		case "oracle":
			return stopDiagnosed(assessed, "diagnosis_oracle", now);
		case "missing_evidence":
			return stopDiagnosed(assessed, "diagnosis_missing_evidence", now);
		case "infrastructure":
			return stopDiagnosed(assessed, "diagnosis_infrastructure", now);
		default: {
			const exhaustive: never = read.assessment.failure;

			return exhaustive;
		}
	}
}

function issueExecution(
	state: Selected,
	execution: CandidateExecution,
): Selected {
	return effect(
		{
			...state,
			accounts: [
				...state.accounts,
				{
					execution,
					spend: { kind: "known", tokens: 0 },
					settlement: "issued",
				},
			],
		},
		execution.stage === "review"
			? { kind: "launch_review", execution }
			: { kind: "repair_build", execution },
	);
}

function reviewExecution(
	state: Selected,
	seats: readonly ReviewSeat[],
): ReviewExecution | null {
	const { intent, verdict } = state.current;

	if (verdict === null) return null;
	const attempt = nextAttempt(state, "review", intent.round);

	const binding: ReviewBinding = {
		runId: state.pin.runId,
		round: intent.round,
		candidateSha: verdict.candidateSha,
		patchDigest: intent.patchDigest,
		contractDigest: state.pin.contractDigest,
		acceptanceDigest: intent.acceptanceDigest,
		ciRunId: verdict.ciRunId,
		originalBase: intent.originalBase,
		baseSha: intent.baseSha,
		execution: {
			generation: intent.generation,
			intentDigest: intent.digest,
			attempt,
			workflowSha: state.pin.workflowSha,
			workflowDigest: state.pin.workflowDigest,
		},
	};

	const body = {
		stage: "review",
		runId: state.pin.runId,
		round: intent.round,
		attempt,
		generation: refOf(intent),
		workflowSha: state.pin.workflowSha,
		workflowDigest: state.pin.workflowDigest,
		binding,
		seats,
	} as const;

	return { ...body, id: digestOf(JSON.stringify(body)) };
}

export function certifyGeneration(input: {
	pin: AdmissionPin;
	generation: GenerationIntent;
	execution: ReviewExecution;
	patch: Extract<PatchRead, { kind: "found" }> | OwnerPatchRead;
	verdict: Verdict;
	review: ReviewReceipt;
	report: TrustedReport;
}): Certification {
	const {
		pin,
		generation: g,
		execution: e,
		patch,
		verdict: v,
		review: r,
		report,
	} = input;

	if (
		(g.origin.kind === "owner"
			? !("kind" in patch.receipt) ||
				patch.receipt.kind !== "owner" ||
				!ownerPatchValid(pin, g, patch.receipt) ||
				patch.receipt.head !== v.candidateSha ||
				patch.receipt.heldoutDigest !== v.heldoutDigest
			: "kind" in patch.receipt || !validPatch(pin, patch.receipt, g.round)) ||
		digestOf(patch.patch) !== g.patchDigest ||
		patch.receipt.patchDigest !== g.patchDigest ||
		!sameGeneration(g, e.generation) ||
		e.runId !== pin.runId ||
		e.workflowSha !== pin.workflowSha ||
		e.workflowDigest !== pin.workflowDigest ||
		!verdictPasses(v) ||
		v.patchDigest !== g.patchDigest ||
		v.acceptanceDigest !== g.acceptanceDigest ||
		v.baseSha !== g.baseSha ||
		v.originalBase !== g.originalBase ||
		v.gateSha !== g.baseSha ||
		r.runId !== pin.runId ||
		r.round !== g.round ||
		r.candidateSha !== v.candidateSha ||
		r.baseSha !== g.baseSha ||
		r.originalBase !== g.originalBase ||
		r.ciRunId !== v.ciRunId ||
		r.patchDigest !== g.patchDigest ||
		r.acceptanceDigest !== g.acceptanceDigest ||
		r.contractDigest !== pin.contractDigest ||
		JSON.stringify(r.execution) !== JSON.stringify(e.binding.execution) ||
		r.execution === undefined ||
		JSON.stringify(e.binding) !==
			JSON.stringify({
				runId: r.runId,
				round: r.round,
				candidateSha: r.candidateSha,
				patchDigest: r.patchDigest,
				contractDigest: r.contractDigest,
				acceptanceDigest: r.acceptanceDigest,
				ciRunId: r.ciRunId,
				originalBase: r.originalBase,
				baseSha: r.baseSha,
				execution: r.execution,
			}) ||
		r.blocking ||
		blocksReview(r.seats) ||
		!familyClaimsHold(r) ||
		// Any builder family present must be the patch's own OpenAI request.
		(g.origin.kind === "owner"
			? r.version !== 3 || r.builder.kind !== "unavailable"
			: r.version === 3 &&
				r.builder.kind !== "unavailable" &&
				(r.builder.kind !== "openai-request" ||
					!("model" in patch.receipt) ||
					r.builder.model !== patch.receipt.model)) ||
		r.seats.length !== e.seats.length ||
		e.seats.some(
			(seat) => r.seats.filter((s) => s.seat === seat).length !== 1,
		) ||
		r.seats.some((s) => !Number.isSafeInteger(s.tokens) || s.tokens < 0) ||
		report.candidateSha !== v.candidateSha ||
		report.gateSha !== v.gateSha ||
		report.ciRunId !== v.ciRunId ||
		report.heldoutDigest !== v.heldoutDigest
	)
		throw new Error("certification_binding");
	const judgments = r.seats.flatMap((s) => s.judgments);

	if (
		judgments.length !== v.unjudged.length ||
		v.unjudged.some(
			(id) =>
				judgments.filter((j) => j.scenario === id && j.outcome === "pass")
					.length !== 1,
		)
	)
		throw new Error("certification_judgments");

	return snapshot({
		generation: refOf(g),
		workflowSha: pin.workflowSha,
		workflowDigest: pin.workflowDigest,
		execution: e,
		verdict: v,
		review: r,
		report,
	});
}

export function handoffGeneration(
	state: Selected,
	pr: PrObservation,
): GenerationEvidence {
	if (
		state.current.intent.origin.kind === "owner" &&
		pr.kind === "open" &&
		pr.refHead === promotedHead(state)
	) {
		return (
			candidateGenerations(state).find(
				(g) =>
					state.published !== null &&
					sameGeneration(g.intent, state.published.promoted),
			) ?? state.current
		);
	}

	return state.current;
}

export function promotedHead(state: CandidateState): GitSha | null {
	return state.kind !== "selected" || state.published === null
		? null
		: (candidateGenerations(state).find((g) =>
				sameGeneration(g.intent, state.published!.promoted),
			)?.certification?.report.candidateSha ?? null);
}

/** The completed generation owns only the feedback cause that built its repair lineage. */
export function completingFeedbackBatch(
	state: Selected,
	ref: GenerationRef,
): FeedbackBatchRef | null {
	const generations = candidateGenerations(state);
	let generation = generations.find((g) => sameGeneration(g.intent, ref));

	while (generation?.intent.origin.kind === "refresh") {
		const previous = generation.intent.origin.previous;
		generation = generations.find((g) => sameGeneration(g.intent, previous));
	}

	if (generation?.intent.origin.kind !== "repair") return null;
	const origin = generation.intent.origin;
	const round = generation.intent.round;

	const build = state.accounts.findLast(
		(a) =>
			a.execution.stage === "build" &&
			a.execution.round === round &&
			sameGeneration(a.execution.feedbackFrom, origin.feedbackFrom),
	);

	const execution = build?.execution;

	return execution?.stage === "build" && execution.cause.kind === "feedback"
		? (state.feedback?.batches.find(
				(b) =>
					execution.cause.kind === "feedback" &&
					b.digest === execution.cause.batch &&
					b.status.kind === "applying" &&
					b.status.round === round,
			) ?? null)
		: null;
}

export function allowedHeads(state: Selected): readonly GitSha[] {
	const head = promotedHead(state);
	const heads: GitSha[] = head === null ? [] : [head];

	// A main move can archive a promoted successor before complete_handoff.
	for (const generation of candidateGenerations(state)) {
		const publication = generation.intent.publication;
		const certified = generation.certification?.report.candidateSha;

		if (
			publication.kind === "successor" &&
			heads.includes(publication.expectedHead) &&
			certified !== undefined &&
			!heads.includes(certified)
		)
			heads.push(certified);
	}

	if (
		state.current.intent.publication.kind === "owner" &&
		state.published?.ownerHead === state.current.intent.publication.head
	)
		heads.push(state.current.intent.publication.head);

	return heads;
}

function carriesBatch(state: Selected, batch: FeedbackBatchRef): boolean {
	const generations = candidateGenerations(state);

	const original =
		batch.binding?.promoted ??
		generations.find((g) => g.certification?.report.candidateSha === batch.head)
			?.intent;

	const patch =
		batch.binding?.patchDigest ??
		generations.find(
			(g) => original !== undefined && sameGeneration(g.intent, original),
		)?.intent.patchDigest;

	let generation = generations.find(
		(g) =>
			state.published !== null &&
			sameGeneration(g.intent, state.published.promoted),
	);

	while (generation !== undefined && original !== undefined) {
		if (generation.intent.patchDigest !== patch) return false;

		if (sameGeneration(generation.intent, original)) return true;
		const origin = generation.intent.origin;

		if (origin.kind !== "refresh") return false;
		generation = generations.find((g) =>
			sameGeneration(g.intent, origin.previous),
		);
	}

	return false;
}

function startQueuedFeedback(
	state: Selected,
	batch: FeedbackBatchRef,
	now: number,
): Selected {
	if (
		state.published === null ||
		(state.work.kind !== "waiting" && state.work.kind !== "held") ||
		state.feedback?.batches.some((b) => b.status.kind === "applying")
	)
		return state;
	const current = state.current;
	const round: 1 | 2 = current.intent.round === 0 ? 1 : 2;
	const assessment = current.assessment;
	const budgetReason = preflight(state, "build", round);

	const promoted = candidateGenerations(state).find((g) =>
		sameGeneration(g.intent, state.published!.promoted),
	);

	const reason =
		promoted?.intent.origin.kind === "owner" ||
		current.intent.origin.kind === "owner"
			? "owner_authored_head"
			: current.intent.round === MAX_REPAIR_ROUNDS
				? "cap_reached"
				: assessment === undefined ||
						current.assessmentKind === "unusable" ||
						(current.assessmentKind === undefined &&
							current.verdict?.pass !== true &&
							!(
								state.work.kind === "held" &&
								state.work.reason === "validation_failed"
							))
					? "repair_unavailable"
					: budgetReason !== null &&
							budgetReason !== "repair_tokens" &&
							budgetReason !== "run_tokens"
						? "repair_unavailable"
						: null;

	const budgetStop =
		reason === null &&
		(budgetReason === "repair_tokens" || budgetReason === "run_tokens");

	const updated = {
		...state,
		feedback:
			state.feedback === null
				? null
				: {
						...state.feedback,
						batches: state.feedback.batches.map((b) => {
							if (b.digest !== batch.digest) return b;

							if (reason !== null)
								return {
									...b,
									round,
									status: {
										kind: "settled",
										outcome: { kind: "refused", reason },
									} as const,
								};

							return {
								...b,
								round,
								attempt: nextAttempt(state, "build", round),
								status: { kind: "applying", round } as const,
							};
						}),
					},
	};

	if (budgetStop) return stopRound(updated, budgetReason, now);

	const review = current.review ?? current.certification?.review;

	const withdrawing =
		reason === null ? held(updated, "feedback_repair", now) : updated;

	return effect(withdrawing, {
		kind: "post_notice",
		number: state.published.number,
		notice: {
			kind: reason === null ? "repair_started" : "repair_unavailable",
			place: "issue",
			key: `<!-- factory:notice ${state.pin.runId} ${reason === null ? "repair_started" : "repair_unavailable"} ${batch.digest} -->`,
		},
		at: now,
		detail: budgetReason,
		withdraw: reason === null ? "feedback_repair" : null,
		// Persisted transition data, not a Promise callback.
		// oxlint-disable-next-line unicorn/no-thenable
		then:
			reason !== null || assessment === undefined
				? { kind: "resume", work: state.work }
				: {
						kind: "repair_due",
						round,
						attempt: nextAttempt(state, "build", round),
						feedbackFrom: refOf(current.intent),
						cause: {
							kind: "feedback",
							batch: batch.digest,
							assessment,
							review:
								review?.blocking === true ? reviewReceiptDigest(review) : null,
						},
					},
	});
}

function ingest(
	state: Selected,
	feedback: FeedbackObservation,
	now: number,
): Selected {
	if (
		state.published === null ||
		feedback.kind !== "read" ||
		feedback.head !== promotedHead(state)
	)
		return state;

	const cursor = state.feedback ?? {
		pr: state.published.number,
		seen: [],
		batches: [],
	};

	const dismissed = new Set(feedback.dismissed);

	const batches = cursor.batches.map((b) =>
		b.status.kind === "queued" &&
		b.reviews.length > 0 &&
		b.reviews.every((id) => dismissed.has(id))
			? {
					...b,
					status: {
						kind: "settled",
						outcome: { kind: "superseded", by: "dismissed" },
					} as const,
				}
			: b,
	);

	const updated = { ...state, feedback: { ...cursor, batches } };
	const batch = feedback.batch;

	if (batch === null) return state.feedback === null ? state : updated;

	if (cursor.overflow !== undefined) return updated;

	const seen = new Set(cursor.seen);
	const fresh = batch.seen.filter((id) => !seen.has(id));

	if (
		fresh.length === 0 ||
		fresh.length !== batch.seen.length ||
		batches.some((b) => b.digest === batch.digest)
	)
		return updated;

	if (
		seen.size + fresh.length > MAX_FEEDBACK_SEEN ||
		batches.length >= MAX_FEEDBACK_BATCHES
	)
		return {
			...updated,
			feedback: {
				...updated.feedback,
				overflow: { since: now, notice: "due" },
			},
		};

	let next: FeedbackCursor = {
		pr: cursor.pr,
		seen: [...seen, ...fresh].sort(),
		batches: [
			...batches,
			{
				digest: batch.digest,
				head: feedback.head,
				binding: {
					patchDigest: candidateGenerations(state).find((g) =>
						sameGeneration(g.intent, state.published!.promoted),
					)!.intent.patchDigest,
					promoted: state.published.promoted,
				},
				actionable: batch.actionable,
				reviews: batch.reviews,
				notice:
					batch.overflow === true
						? "none"
						: batch.refusedInline
							? "due"
							: "none",
				status: batch.actionable
					? { kind: "queued" }
					: { kind: "settled", outcome: { kind: "no_action" } },
			},
		],
	};

	if (batch.overflow === true)
		next = { ...next, overflow: { since: now, notice: "due" } };

	return { ...updated, feedback: next };
}

function headNotice(
	state: Selected,
	kind: "owner_head" | "owner_head_failed" | "checks_failed",
	reason: HandoffReason,
	head: GitSha,
	now: number,
	next: NoticeNext,
	refusal?: OwnerHeadRefusal,
): Selected {
	if (state.published === null) return held(state, reason, now);

	if (
		next.kind === "held" &&
		state.work.kind === "held" &&
		state.work.reason === reason
	)
		return state;

	const detail =
		refusal === undefined ? { detail: reason } : { detail: reason, refusal };

	return effect(held(state, reason, now), {
		kind: "post_notice",
		number: state.published.number,
		notice: {
			kind,
			place: "issue",
			key: `<!-- factory:notice ${state.pin.runId} ${kind} ${reason}${refusal === undefined ? "" : ` ${refusal}`} ${head} -->`,
		},
		at: now,
		...detail,
		withdraw: reason,
		// Persisted transition data, not a Promise callback.
		// oxlint-disable-next-line unicorn/no-thenable
		then: next,
	});
}

function observed(
	state: Selected,
	event: Extract<CandidateEvent, { kind: "observed" }>,
): Selected {
	if (state.work.kind === "terminal") return state;

	if (event.pr.kind === "merged") {
		const mergeSha = event.pr.mergeSha;

		const merged = {
			...state,
			feedback:
				state.feedback === null
					? null
					: {
							...state.feedback,
							batches: state.feedback.batches.map((b) =>
								b.status.kind === "applying" || b.status.kind === "queued"
									? {
											...b,
											status: {
												kind: "settled",
												outcome: { kind: "merged", mergeSha },
											} as const,
										}
									: b,
							),
						},
		};

		return finish(merged, terminalFor(state, event.pr));
	}

	if (
		state.work.kind === "effect" &&
		(state.work.request.kind === "finish_pr" ||
			(state.work.request.kind === "stop_execution" &&
				state.work.request.terminal !== null) ||
			(state.work.request.kind === "post_notice" &&
				state.work.request.notice.kind === "round_summary" &&
				state.work.request.then.kind === "finish"))
	)
		return state;

	if (event.pr.kind === "closed")
		return finish(
			state,
			{
				kind: "cancelled",
				number: event.pr.number,
				reason: "closed",
			},
			event.now,
		);

	const possiblePr =
		state.published !== null ||
		(state.work.kind === "effect" && state.work.request.kind === "open_pr");

	if (
		possiblePr &&
		(event.pr.kind === "unavailable" ||
			(event.pr.kind === "none" && state.published !== null))
	)
		return state;

	if (event.eligibility === "withdrawn") {
		return state.published === null
			? finish(state, { kind: "released" })
			: finish(
					state,
					{
						kind: "cancelled",
						number: state.published.number,
						reason: "withdrawn",
					},
					event.now,
				);
	}

	if (!event.executionAllowed || event.eligibility === "unverified")
		return state;

	if (
		state.work.kind === "held" &&
		(state.work.reason === "pr_identity" ||
			state.work.reason === "pr_ambiguous" ||
			state.work.reason === "summary_too_large")
	)
		return state;

	if (
		state.work.kind === "effect" &&
		state.work.request.kind === "complete_handoff" &&
		event.pr.kind === "open" &&
		event.pr.refHead !== state.work.request.head
	)
		state = held(state, "head_drift", event.now);

	if (
		handoffGeneration(state, event.pr).intent.digest !==
			state.current.intent.digest &&
		state.work.kind !== "effect"
	) {
		const execution = activeExecution(state);

		if (execution !== null)
			return effect(state, {
				kind: "stop_execution",
				execution,
				terminal: null,
			});
		const restored = handoffGeneration(state, event.pr);

		state = {
			...state,
			current: restored,
			history: state.history.map((g) =>
				g.intent.digest === restored.intent.digest ? state.current : g,
			),
			published:
				state.published === null
					? null
					: { ...state.published, ownerHead: null },
			work:
				state.work.kind === "waiting" ||
				(state.work.kind === "held" &&
					["checks_failed", "checks_incomplete", "head_lag"].includes(
						state.work.reason,
					))
					? state.work
					: { kind: "handoff" },
		};
	}

	if (
		state.published !== null &&
		event.pr.kind === "open" &&
		!allowedHeads(state).includes(event.pr.refHead) &&
		event.pr.refHead !== state.published.ownerHead &&
		state.work.kind !== "effect"
	) {
		state = {
			...state,
			feedback:
				state.feedback === null
					? null
					: {
							...state.feedback,
							batches: state.feedback.batches.map((b) =>
								b.status.kind === "queued" || b.status.kind === "applying"
									? {
											...b,
											status: {
												kind: "settled",
												outcome: { kind: "superseded", by: "owner_head" },
											} as const,
										}
									: b,
							),
						},
		};
		const execution = activeExecution(state);

		if (execution !== null)
			return effect(state, {
				kind: "stop_execution",
				execution,
				terminal: null,
			});

		return headNotice(
			state,
			"owner_head",
			"owner_head",
			event.pr.refHead,
			event.now,
			{ kind: "owner_due", head: event.pr.refHead, since: event.now },
		);
	}

	state = ingest(state, event.feedback ?? { kind: "none" }, event.now);

	if (state.feedback !== null)
		state = {
			...state,
			feedback: {
				...state.feedback,
				batches: state.feedback.batches.map((b) =>
					b.status.kind === "queued" && !carriesBatch(state, b)
						? {
								...b,
								status: {
									kind: "settled",
									outcome: { kind: "superseded", by: "promotion" },
								} as const,
							}
						: b,
				),
			},
		};
	const work = state.work;

	if (
		work.kind === "effect" &&
		work.request.kind === "post_notice" &&
		work.request.notice.kind === "round_summary"
	)
		return state;

	if (
		state.published !== null &&
		(work.kind === "waiting" || work.kind === "held")
	) {
		const overflow = state.feedback?.overflow;

		if (overflow !== undefined) {
			const held = {
				kind: "held",
				reason: "feedback_overflow",
				since: overflow.since,
			} as const;

			if (overflow.notice === "posted") return { ...state, work: held };

			return effect(state, {
				kind: "post_notice",
				number: state.published.number,
				notice: {
					kind: "feedback_overflow",
					place: "issue",
					key: `<!-- factory:notice ${state.pin.runId} feedback_overflow -->`,
				},
				withdraw: null,
				// Persisted transition data, not a Promise callback.
				// oxlint-disable-next-line unicorn/no-thenable
				then: { kind: "resume", work: held },
			});
		}

		const due = state.feedback?.batches.find((b) => b.notice === "due");

		if (due !== undefined)
			return effect(state, {
				kind: "post_notice",
				number: state.published.number,
				notice: {
					kind: "feedback_intake",
					place: "issue",
					key: `<!-- factory:notice ${state.pin.runId} feedback_intake ${due.digest} -->`,
				},
				withdraw: null,
				// This is persisted transition data, never a Promise callback.
				// oxlint-disable-next-line unicorn/no-thenable
				then: { kind: "resume", work },
			});

		const queued = state.feedback?.batches.find(
			(b) => b.status.kind === "queued",
		);

		if (
			queued !== undefined &&
			event.pr.kind === "open" &&
			event.pr.head === promotedHead(state) &&
			event.pr.refHead === event.pr.head
		)
			return startQueuedFeedback(state, queued, event.now);
	}

	if (work.kind === "owner_due") {
		if (event.pr.kind === "open" && event.pr.refHead !== work.head)
			return observed(
				{
					...state,
					published:
						state.published === null
							? null
							: { ...state.published, ownerHead: null },
					work: { kind: "handoff" },
				},
				event,
			);

		if (
			latestGeneration(state) === 3 ||
			state.history.length + 2 > MAX_GENERATIONS
		)
			return held(state, "refresh_limit", event.now);

		if (event.main === null) return state;

		return effect(state, {
			kind: "derive_owner_patch",
			head: work.head,
			baseSha: event.main,
			attempt: work.attempt ?? 1,
		});
	}

	if (
		work.kind === "held" &&
		[
			"owner_head_refused",
			"owner_head_failed",
			"owner_head_behind",
			"refresh_limit",
		].includes(work.reason) &&
		event.pr.kind === "open" &&
		event.pr.refHead === state.published?.ownerHead
	)
		return state;

	// A stopped feedback round needs a new owner request, not the old certificate.
	if (
		work.kind === "held" &&
		state.feedback?.batches.some(
			(b) => b.status.kind === "settled" && b.status.outcome.kind === "stopped",
		)
	)
		return state;

	if (work.kind === "repair_due") {
		if (!event.capacityAvailable) return state;
		const reason = preflight(state, "build", work.round);

		if (reason !== null) return stopRound(state, reason, event.now);

		const body = {
			stage: "build",
			runId: state.pin.runId,
			round: work.round,
			attempt: nextAttempt(state, "build", work.round),
			feedbackFrom: work.feedbackFrom,
			cause: work.cause,
			workflowSha: state.pin.workflowSha,
			workflowDigest: state.pin.workflowDigest,
		} as const;

		return issueExecution(state, {
			...body,
			id: digestOf(JSON.stringify(body)),
		});
	}

	if (work.kind === "rebuilding") return state;

	if (work.kind === "repair_built") {
		if (event.main === null) return state;
		const round = work.patch.round;

		if (round !== 1 && round !== 2)
			return hold(state, "evidence_unavailable", event.now);

		const intent = generationIntent({
			pin: state.pin,
			patch: work.patch,
			round,
			generation: 0,
			baseSha: event.main,
			origin: { kind: "repair", feedbackFrom: work.feedbackFrom },
			publication:
				state.published === null
					? { kind: "initial" }
					: { kind: "successor", expectedHead: promotedHead(state)! },
		});

		return selectGeneration(state, intent, work.patch, event.now);
	}

	if (
		work.kind === "effect" &&
		(work.request.kind === "derive_owner_patch" ||
			(work.request.kind === "post_notice" &&
				work.request.notice.kind === "owner_head"))
	)
		return state;

	if (
		event.main !== null &&
		event.main !== handoffGeneration(state, event.pr).intent.baseSha
	) {
		const execution = activeExecution(state);

		if (execution !== null)
			return effect(state, {
				kind: "stop_execution",
				execution,
				terminal: null,
			});

		const active = handoffGeneration(state, event.pr);

		if (
			active.intent.origin.kind === "owner" ||
			(state.published !== null &&
				authoredOf(state, state.published.promoted) === "owner")
		) {
			const head =
				active.intent.origin.kind === "owner"
					? active.intent.origin.head
					: promotedHead(state)!;

			return headNotice(
				state,
				"owner_head_failed",
				"owner_head_behind",
				head,
				event.now,
				{ kind: "held", reason: "owner_head_behind" },
			);
		}

		const refreshes = candidateGenerations(state).filter(
			(g) => g.intent.origin.kind === "refresh",
		).length;

		const reason = preflight(state, "review", state.current.intent.round);

		if (reason !== null) return hold(state, reason, event.now);

		if (refreshes >= MAX_REFRESHES || latestGeneration(state) === 3)
			return hold(state, "refresh_limit", event.now);

		const generation =
			latestGeneration(state) === 0 ? 1 : latestGeneration(state) === 1 ? 2 : 3;

		const head =
			state.published === null
				? null
				: (candidateGenerations(state).find((g) =>
						sameGeneration(g.intent, state.published?.promoted ?? g.intent),
					)?.certification?.report.candidateSha ?? null);

		if (
			state.published !== null &&
			(event.pr.kind !== "open" ||
				head === null ||
				event.pr.head !== event.pr.refHead ||
				!allowedHeads(state).includes(event.pr.refHead))
		)
			return hold(state, "head_drift", event.now);

		const intent = generationIntent({
			pin: state.pin,
			patch: state.current.patch,
			round: state.current.intent.round,
			generation,
			baseSha: event.main,
			origin: { kind: "refresh", previous: refOf(state.current.intent) },
			publication:
				head === null
					? { kind: "initial" }
					: {
							kind: "successor",
							expectedHead: event.pr.kind === "open" ? event.pr.refHead : head,
						},
		});

		return selectGeneration(
			state.published === null
				? state
				: {
						...state,
						published: {
							...state.published,
							readiness: {
								kind: "not_ready",
								reason: "main_moving",
								since: event.now,
							},
						},
					},
			intent,
			state.current.patch,
			event.now,
		);
	}

	if (work.kind === "effect" || work.kind === "reviewing") return state;

	if (work.kind === "review_due") {
		if (!event.capacityAvailable) return state;
		const reason = preflight(state, "review", state.current.intent.round);

		if (reason !== null) return hold(state, reason, event.now);
		const execution = reviewExecution(state, work.seats);

		return execution === null
			? hold(state, "evidence_unavailable", event.now)
			: issueExecution(state, execution);
	}

	const handoff = handoffGeneration(state, event.pr);
	const certificate = handoff.certification;

	if (certificate === null || event.main === null) return state;
	const head = certificate.report.candidateSha;

	if (
		event.readiness.kind !== "current" ||
		event.readiness.head !== head ||
		JSON.stringify(event.readiness.report) !==
			JSON.stringify(certificate.report)
	) {
		const reason =
			event.readiness.kind === "not_ready"
				? event.readiness.reason
				: "checks_incomplete";

		if (reason === "checks_failed")
			return headNotice(state, "checks_failed", reason, head, event.now, {
				kind: "held",
				reason,
			});
		const stopped = hold(state, reason, event.now);

		return state.published === null || stopped.work.kind === "effect"
			? stopped
			: effect(stopped, {
					kind: "void_readiness",
					number: state.published.number,
					reason,
				});
	}

	if (state.published === null)
		return effect(state, {
			kind: "open_pr",
			certification: refOf(state.current.intent),
			head,
			branch: `factory/pr/${state.pin.issue}-${state.pin.runId.slice(0, 12)}`,
		});

	if (event.pr.kind !== "open") return state;

	if (event.pr.head !== event.pr.refHead)
		return hold(state, "head_lag", event.now);

	if (event.pr.head !== head) {
		const publication = state.current.intent.publication;

		return publication.kind !== "successor" ||
			event.pr.head !== publication.expectedHead
			? hold(state, "head_drift", event.now)
			: effect(state, {
					kind: "promote_pr",
					number: state.published.number,
					expectedHead: publication.expectedHead,
					certification: refOf(state.current.intent),
					head,
				});
	}

	return state.published.readiness.kind === "ready" &&
		sameGeneration(state.published.promoted, handoff.intent)
		? { ...state, work: { kind: "waiting" } }
		: effect(state, {
				kind: "complete_handoff",
				number: state.published.number,
				certification: refOf(handoff.intent),
				head,
			});
}

function updateAccount(
	state: Selected,
	execution: CandidateExecution,
	tokens: number | null,
	settled: boolean,
): Selected {
	return {
		...state,
		accounts: state.accounts.map((a) => {
			if (!executionEqual(a.execution, execution)) return a;
			const floor = tokensOf(a);

			if (
				tokens !== null &&
				tokens < floor &&
				(!settled || a.settlement === "settled")
			)
				return a;

			const valid =
				tokens !== null && Number.isSafeInteger(tokens) && tokens >= floor;

			return {
				...a,
				spend: valid ? { kind: "known", tokens } : { kind: "unknown", floor },
				settlement:
					settled && valid ? "settled" : settled ? "uncertain" : a.settlement,
			};
		}),
	};
}

function complete(
	state: Selected,
	c: CandidateEffectResult,
	now: number,
): Selected {
	if (
		state.work.kind !== "effect" ||
		state.work.request.kind !== c.kind ||
		JSON.stringify(state.work.request) !== JSON.stringify(c.request)
	)
		return state;

	switch (c.kind) {
		case "derive_owner_patch": {
			if (c.result.kind === "refused") {
				const attempt = c.request.attempt ?? 1;

				if (c.result.reason === "unreadable" && attempt < 3)
					return {
						...state,
						work: {
							kind: "owner_due",
							head: c.request.head,
							since: now,
							attempt: attempt === 1 ? 2 : 3,
						},
					};

				return headNotice(
					state,
					"owner_head_failed",
					"owner_head_refused",
					c.request.head,
					now,
					{ kind: "held", reason: "owner_head_refused" },
					c.result.reason,
				);
			}

			const generation = latestGeneration(state);

			if (generation === 3 || state.history.length + 2 > MAX_GENERATIONS)
				return held(state, "refresh_limit", now);

			const intent = generationIntent({
				pin: state.pin,
				patch: c.result.patch,
				round: state.current.intent.round,
				generation: generation === 0 ? 1 : generation === 1 ? 2 : 3,
				baseSha: c.request.baseSha,
				origin: {
					kind: "owner",
					head: c.request.head,
					previous: refOf(state.current.intent),
				},
				publication: { kind: "owner", head: c.request.head },
			});

			if (!ownerPatchValid(state.pin, intent, c.result.patch))
				return headNotice(
					state,
					"owner_head_failed",
					"owner_head_refused",
					c.request.head,
					now,
					{ kind: "held", reason: "owner_head_refused" },
				);

			const selected = selectGeneration(
				state,
				intent,
				state.current.patch,
				now,
			);

			return {
				...selected,
				current: { ...selected.current, ownerPatch: c.result.patch },
			};
		}

		case "validate": {
			const current = { ...state.current, validation: c.result.validation };

			if (c.result.kind === "waiting") return { ...state, current };

			if (c.result.kind === "failed")
				return stopRound({ ...state, current }, c.result.reason, now);
			const { verdict, report, seats } = c.result;

			const assessed = assessedValidation(
				state,
				current,
				verdict,
				c.result.assessment,
				now,
			);

			if (
				assessed.current.assessment === undefined ||
				assessed.work !== state.work ||
				!verdictPasses(verdict)
			)
				return assessed;

			if (
				report === null ||
				verdict.baseSha !== current.intent.baseSha ||
				verdict.originalBase !== current.intent.originalBase ||
				verdict.patchDigest !== current.intent.patchDigest ||
				verdict.acceptanceDigest !== current.intent.acceptanceDigest ||
				report.candidateSha !== verdict.candidateSha ||
				report.gateSha !== verdict.gateSha ||
				report.ciRunId !== verdict.ciRunId
			)
				return stopRound(state, "evidence_unavailable", now);

			return {
				...state,
				current: { ...assessed.current, verdict, report },
				work: { kind: "review_due", seats },
			};
		}

		case "launch_review":
		case "repair_build": {
			const execution = c.request.execution;

			const updated = {
				...state,
				accounts: state.accounts.map((a) =>
					executionEqual(a.execution, execution)
						? {
								...a,
								settlement: c.started
									? ("running" as const)
									: ("settled" as const),
							}
						: a,
				),
			};

			if (!c.started)
				return {
					...updated,
					work:
						execution.stage === "review"
							? { kind: "review_due", seats: execution.seats }
							: {
									kind: "repair_due",
									round: execution.round,
									attempt: execution.attempt + 1,
									feedbackFrom: execution.feedbackFrom,
									cause: execution.cause,
								},
				};

			return {
				...updated,
				work:
					execution.stage === "review"
						? { kind: "reviewing", execution }
						: { kind: "rebuilding", execution },
			};
		}

		case "stop_execution": {
			if (!c.stopped) return state;
			const updated = updateAccount(state, c.request.execution, c.tokens, true);

			if (accountFor(updated, c.request.execution)?.settlement !== "settled")
				return updated;

			return c.request.terminal === null
				? { ...updated, work: { kind: "handoff" } }
				: finish(updated, c.request.terminal, now);
		}

		case "open_pr": {
			const published: PublishedPr = {
				number: c.number,
				branch: c.request.branch,
				promoted: c.request.certification,
				readiness: {
					kind: "not_ready",
					since: 0,
					reason: c.head === c.refHead ? "checks_incomplete" : "head_lag",
				},
			};

			return { ...state, published, work: { kind: "handoff" } };
		}

		case "promote_pr":
			return c.head === c.request.head && c.refHead === c.request.head
				? { ...state, work: { kind: "handoff" } }
				: hold(state, "head_lag", now);
		case "complete_handoff": {
			const applying = completingFeedbackBatch(state, c.request.certification);

			const feedback =
				state.feedback === null
					? null
					: {
							...state.feedback,
							batches: state.feedback.batches.map((b) =>
								b.digest === applying?.digest
									? {
											...b,
											status: {
												kind: "settled",
												outcome: { kind: "applied", head: c.request.head },
											} as const,
										}
									: b,
							),
						};

			return state.published === null
				? hold(state, "evidence_unavailable", c.now)
				: {
						...state,
						feedback,
						published: {
							...state.published,
							promoted: c.request.certification,
							readiness: { kind: "ready", since: c.now },
						},
						work: { kind: "waiting" },
					};
		}

		case "void_readiness":
			return {
				...state,
				work: {
					kind: "held",
					reason: c.request.reason,
					since: state.published?.readiness.since ?? 0,
				},
			};
		case "post_notice": {
			let feedback = state.feedback;

			if (feedback !== null) {
				if (
					c.request.notice.kind === "feedback_overflow" &&
					feedback.overflow !== undefined
				)
					feedback = {
						...feedback,
						overflow: { ...feedback.overflow, notice: "posted" },
					};
				else
					feedback = {
						...feedback,
						batches: feedback.batches.map((b) =>
							c.request.notice.key ===
							`<!-- factory:notice ${state.pin.runId} feedback_intake ${b.digest} -->`
								? { ...b, notice: "posted" }
								: b,
						),
					};
			}

			const next = c.request.then;

			const updated = {
				...state,
				feedback,
				published:
					c.request.withdraw === null || state.published === null
						? state.published
						: {
								...state.published,
								readiness: {
									kind: "not_ready",
									reason: c.request.withdraw,
									since: c.request.at ?? now,
								} as const,
							},
			};

			if (next.kind === "owner_due" && updated.published !== null)
				updated.published = { ...updated.published, ownerHead: next.head };

			if (next.kind === "finish") return finish(updated, next.terminal, now);

			return next.kind === "held"
				? hold(updated, next.reason, c.request.at ?? now)
				: { ...updated, work: next.kind === "resume" ? next.work : next };
		}

		case "finish_pr":
			return {
				...state,
				work: { kind: "terminal", terminal: c.request.terminal },
			};
		default: {
			const exhaustive: never = c;

			return exhaustive;
		}
	}
}

export function handoffCandidate(
	state: CandidateState,
	event: CandidateEvent,
): CandidateStep {
	let next: CandidateState = state;

	const now =
		event.now ??
		(event.kind === "effect_completed" &&
		event.completion.kind === "complete_handoff"
			? event.completion.now
			: 0);

	if (state.kind === "unprepared") {
		if (
			event.kind === "observed" &&
			(event.pr.kind === "merged" ||
				event.pr.kind === "closed" ||
				event.eligibility === "withdrawn" ||
				(event.executionAllowed &&
					event.eligibility === "ready" &&
					event.main !== null))
		) {
			const intent = generationIntent({
				pin: state.pin,
				patch: state.patch,
				round: 0,
				generation: 0,
				baseSha: event.main ?? state.pin.originalBase,
				origin: { kind: "initial" },
				publication: { kind: "initial" },
			});

			const initial: Selected = {
				...state,
				kind: "selected",
				history: [],
				current: freshEvidence(intent, state.patch),
				published: null,
				feedback: null,
				work: { kind: "handoff" },
			};

			next =
				event.pr.kind === "merged" ||
				event.pr.kind === "closed" ||
				event.eligibility === "withdrawn"
					? observed(initial, event)
					: effect(initial, { kind: "validate", generation: intent });
		}
	} else
		switch (event.kind) {
			case "resume_execution": {
				const account = accountFor(state, event.execution);

				if (
					account === null ||
					account.settlement === "settled" ||
					state.work.kind === "terminal" ||
					(state.work.kind === "effect" &&
						(state.work.request.kind === "stop_execution" ||
							state.work.request.kind === "finish_pr"))
				)
					break;

				const updated = updateAccount(
					state,
					event.execution,
					event.tokens,
					false,
				);

				if (
					(state.work.kind === "effect" &&
						state.work.request.kind === "post_notice" &&
						state.work.request.notice.kind === "round_summary") ||
					(state.work.kind === "held" &&
						state.feedback?.batches.some(
							(b) =>
								b.status.kind === "settled" &&
								b.status.outcome.kind === "stopped",
						))
				) {
					next = updated;
					break;
				}

				if (accountFor(updated, event.execution)?.spend.kind !== "known") {
					next = hold(updated, "evidence_unavailable", now);
					break;
				}

				next = effect(
					{
						...updated,
						accounts: updated.accounts.map((a) =>
							a.execution.id === event.execution.id
								? { ...a, settlement: "issued" }
								: a,
						),
					},
					event.execution.stage === "review"
						? { kind: "launch_review", execution: event.execution }
						: { kind: "repair_build", execution: event.execution },
				);
				break;
			}

			case "observed":
				next = observed(state, event);
				break;
			case "effect_held":
				if (
					state.work.kind === "effect" &&
					!(
						state.work.request.kind === "post_notice" &&
						state.work.request.notice.kind === "round_summary"
					)
				)
					next = hold(state, event.reason, event.now);
				break;
			case "effect_completed":
				next = complete(state, event.completion, now);
				break;
			case "execution_progress":
				next = updateAccount(state, event.execution, event.tokens, false);
				break;
			case "review_settled": {
				if (accountFor(state, event.execution) === null) break;

				let updated = updateAccount(state, event.execution, event.tokens, true);

				next = updated;

				if (
					!(
						(state.work.kind === "reviewing" &&
							executionEqual(state.work.execution, event.execution)) ||
						(state.work.kind === "effect" &&
							state.work.request.kind === "launch_review" &&
							executionEqual(state.work.request.execution, event.execution))
					) ||
					!sameGeneration(state.current.intent, event.execution.generation)
				)
					break;

				if (
					event.result.kind === "failed" &&
					event.result.reason !== undefined
				) {
					next = stopRound(updated, event.result.reason, now);
					break;
				}

				if (accountFor(updated, event.execution)?.settlement !== "settled") {
					next =
						state.current.intent.origin.kind === "owner"
							? stopRound(updated, "evidence_unavailable", now)
							: hold(updated, "evidence_unavailable", now);
					break;
				}

				if (event.result.kind === "failed") {
					const reason = preflight(updated, "review", event.execution.round);
					next =
						state.published !== null
							? stopRound(updated, "review_failed", now)
							: reason === null
								? {
										...updated,
										work: { kind: "review_due", seats: event.execution.seats },
									}
								: finish(updated, { kind: "failed", reason });
					break;
				}

				if (state.current.verdict === null || state.current.report === null) {
					next = hold(updated, "evidence_unavailable", now);
					break;
				}

				updated = {
					...updated,
					current: { ...updated.current, review: event.result.review },
				};
				const fingerprints = findingFingerprints(event.result.review);

				if (
					state.current.intent.round > 0 &&
					event.result.review.blocking &&
					state.history.some(
						(g) =>
							g.intent.round < state.current.intent.round &&
							findingFingerprints(
								g.review ?? g.certification?.review ?? { seats: [] },
							).some((f) => fingerprints.includes(f)),
					)
				) {
					next = stopRound(updated, "repair_repeated_finding", now);
					break;
				}

				try {
					const certification = certifyGeneration({
						pin: state.pin,
						generation: state.current.intent,
						execution: event.execution,
						patch: event.result.patch,
						verdict: state.current.verdict,
						review: event.result.review,
						report: state.current.report,
					});

					next = {
						...updated,
						current: { ...updated.current, certification },
						work: { kind: "handoff" },
					};
				} catch {
					const passed = updated.current.assessment;
					const review = event.result.review;

					next =
						passed === undefined ||
						!review.blocking ||
						!blocksReview(review.seats)
							? state.published === null
								? hold(updated, "evidence_unavailable", now)
								: stopRound(updated, "evidence_unavailable", now)
							: failOrRepair(
									updated,
									{
										kind: "review",
										assessment: passed,
										review: reviewReceiptDigest(review),
									},
									now,
								);
				}

				break;
			}

			case "repair_settled": {
				if (accountFor(state, event.execution) === null) break;

				const updated = updateAccount(
					state,
					event.execution,
					event.tokens,
					true,
				);

				next = updated;

				if (
					state.work.kind !== "rebuilding" ||
					!executionEqual(state.work.execution, event.execution)
				)
					break;

				if (accountFor(updated, event.execution)?.settlement !== "settled") {
					next = hold(updated, "evidence_unavailable", now);
					break;
				}

				if (
					event.result.kind === "no_change" ||
					(event.result.kind === "passed" &&
						validPatch(state.pin, event.result.patch, event.execution.round) &&
						event.result.patch.patchDigest === state.current.patch.patchDigest)
				) {
					next = stopRound(updated, "repair_no_progress", now);
					break;
				}

				if (
					event.result.kind === "passed" &&
					validPatch(state.pin, event.result.patch, event.execution.round) &&
					event.result.patch.patchDigest !== state.current.patch.patchDigest
				)
					next = {
						...updated,
						work: {
							kind: "repair_built",
							patch: event.result.patch,
							feedbackFrom: event.execution.feedbackFrom,
						},
					};
				else {
					const reason = preflight(updated, "build", event.execution.round);
					next =
						reason === null
							? {
									...updated,
									feedback:
										updated.feedback === null
											? null
											: {
													...updated.feedback,
													batches: updated.feedback.batches.map((batch) =>
														event.execution.cause.kind === "feedback" &&
														batch.digest === event.execution.cause.batch
															? {
																	...batch,
																	failedAttempts: [
																		...(batch.failedAttempts ?? []),
																		event.execution.attempt,
																	],
																}
															: batch,
													),
												},
									work: {
										kind: "repair_due",
										round: event.execution.round,
										attempt: nextAttempt(
											updated,
											"build",
											event.execution.round,
										),
										feedbackFrom: event.execution.feedbackFrom,
										cause: event.execution.cause,
									},
								}
							: stopRound(updated, reason, now);
				}

				break;
			}

			default: {
				const exhaustive: never = event;

				return exhaustive;
			}
		}

	const owned = snapshot(next);

	const pending =
		owned.kind === "selected" && owned.work.kind === "effect"
			? owned.work.request
			: null;

	const needsPr =
		owned.kind === "selected" &&
		(owned.published !== null || pending?.kind === "open_pr");

	const allowed =
		event.kind !== "observed" ||
		pending?.kind === "stop_execution" ||
		pending?.kind === "finish_pr" ||
		(event.executionAllowed &&
			event.eligibility === "ready" &&
			(!needsPr ||
				(event.pr.kind !== "none" && event.pr.kind !== "unavailable") ||
				(pending?.kind === "open_pr" && event.pr.kind === "none")));

	return { state: owned, effect: allowed ? pending : null };
}

function wireObject(
	value: JsonValue | undefined,
): Record<string, JsonValue> | null {
	return value !== null &&
		value !== undefined &&
		value instanceof Object &&
		!Array.isArray(value)
		? value
		: null;
}

function wireCount(value: JsonValue | undefined, min = 0): value is number {
	return (
		value === Number(value) &&
		Number.isSafeInteger(value) &&
		Number(value) >= min
	);
}

function wireText(value: JsonValue | undefined): value is string {
	return value === String(value);
}

function wireDigest(value: JsonValue | undefined): value is Digest {
	return wireText(value) && isDigest(value);
}

function wireSha(value: JsonValue | undefined): value is GitSha {
	return wireText(value) && isGitSha(value);
}

function wireStrings(value: JsonValue | undefined): value is string[] {
	return Array.isArray(value) && value.every(wireText);
}

function wireRef(
	value: JsonValue | undefined,
): value is GenerationRef & JsonValue {
	const v = wireObject(value);

	return (
		v !== null &&
		(v.round === 0 || v.round === 1 || v.round === 2) &&
		(v.generation === 0 ||
			v.generation === 1 ||
			v.generation === 2 ||
			v.generation === 3) &&
		wireDigest(v.digest)
	);
}

function wireCause(
	value: JsonValue | undefined,
): value is RepairCause & JsonValue {
	const v = wireObject(value);
	const a = wireObject(v?.assessment);

	return (
		v !== null &&
		(v.kind === "validation"
			? v.review === undefined
			: v.kind === "review"
				? wireDigest(v.review)
				: v.kind === "feedback" &&
					wireDigest(v.batch) &&
					(v.review === null || wireDigest(v.review))) &&
		a !== null &&
		wireDigest(a.bindingDigest) &&
		wireDigest(a.recordDigest)
	);
}

function wirePin(
	value: JsonValue | undefined,
): value is AdmissionPin & JsonValue {
	const v = wireObject(value);

	return (
		v !== null &&
		wireDigest(v.runId) &&
		wireText(v.repo) &&
		isRepoSlug(v.repo) &&
		wireCount(v.issue, 1) &&
		wireSha(v.originalBase) &&
		wireSha(v.workflowSha) &&
		v.originalBase === v.workflowSha &&
		wireDigest(v.workflowDigest) &&
		wireDigest(v.contractDigest) &&
		wireDigest(v.acceptanceDigest) &&
		wireCount(v.maxTokens, 1) &&
		wireCount(v.maxReviewAttempts, 1) &&
		v.maxReviewAttempts <= MAX_REVIEW_ATTEMPTS
	);
}

function wirePatch(
	value: JsonValue | undefined,
): value is PatchReceipt & JsonValue {
	const v = wireObject(value);
	const tests = wireObject(v?.visibleTests);

	return (
		v !== null &&
		v.version === 1 &&
		wireDigest(v.runId) &&
		(v.round === undefined || (wireCount(v.round) && v.round <= 2)) &&
		wireSha(v.baseSha) &&
		wireDigest(v.contractDigest) &&
		wireDigest(v.acceptanceDigest) &&
		wireDigest(v.patchDigest) &&
		wireStrings(v.changedPaths) &&
		(v.dispositions === undefined ||
			wireBuilderDecisions(v.dispositions, "event")) &&
		(v.findingDispositions === undefined ||
			wireBuilderDecisions(v.findingDispositions, "fingerprint")) &&
		(v.policy === "clean" || v.policy === "forbidden") &&
		wireText(v.testCommand) &&
		wireText(v.model) &&
		(v.observed === null || wireText(v.observed)) &&
		Array.isArray(v.commands) &&
		v.commands.every((entry) => {
			const command = wireObject(entry);

			return (
				command !== null &&
				wireText(command.command) &&
				(command.exitCode === null || wireCount(command.exitCode))
			);
		}) &&
		v.commandsSource === "builder-reported" &&
		wireCount(v.commandsOmitted) &&
		(v.scriptsChanged === true || v.scriptsChanged === false) &&
		(v.testScriptChanged === true || v.testScriptChanged === false) &&
		(v.testInputsChanged === true || v.testInputsChanged === false) &&
		(v.visibleTests === null ||
			(tests !== null &&
				wireText(tests.command) &&
				(tests.exitCode === null || wireCount(tests.exitCode)) &&
				wireText(tests.tail) &&
				wireCount(tests.wallMs)))
	);
}

function wireReviewExecutionBinding(value: JsonValue | undefined): boolean {
	const v = wireObject(value);

	return (
		v !== null &&
		wireCount(v.generation) &&
		v.generation <= 3 &&
		wireDigest(v.intentDigest) &&
		wireCount(v.attempt, 1) &&
		wireSha(v.workflowSha) &&
		wireDigest(v.workflowDigest)
	);
}

function wireReviewBinding(
	value: JsonValue | undefined,
): value is ReviewBinding & JsonValue {
	const v = wireObject(value);

	return (
		v !== null &&
		wireDigest(v.runId) &&
		wireCount(v.round) &&
		v.round <= 2 &&
		wireSha(v.candidateSha) &&
		wireDigest(v.patchDigest) &&
		wireDigest(v.contractDigest) &&
		wireDigest(v.acceptanceDigest) &&
		wireCount(v.ciRunId, 1) &&
		wireSha(v.originalBase) &&
		wireSha(v.baseSha) &&
		wireReviewExecutionBinding(v.execution)
	);
}

function wireExecution(
	value: JsonValue | undefined,
): value is CandidateExecution & JsonValue {
	const v = wireObject(value);

	if (
		v === null ||
		!wireDigest(v.id) ||
		!wireDigest(v.runId) ||
		!wireCount(v.round) ||
		v.round > 2 ||
		!wireCount(v.attempt, 1) ||
		v.attempt > MAX_REVIEW_ATTEMPTS ||
		!wireSha(v.workflowSha) ||
		!wireDigest(v.workflowDigest)
	)
		return false;

	if (v.stage === "build")
		return (
			(v.round === 1 || v.round === 2) &&
			wireRef(v.feedbackFrom) &&
			v.feedbackFrom.round + 1 === v.round &&
			wireCause(v.cause)
		);
	const seats = v.seats;

	return (
		v.stage === "review" &&
		wireRef(v.generation) &&
		wireReviewBinding(v.binding) &&
		v.generation.round === v.round &&
		v.binding.runId === v.runId &&
		v.binding.round === v.round &&
		Array.isArray(seats) &&
		seats.length >= 3 &&
		seats.length <= 4 &&
		["code-review", "security-review", "simplify"].every(
			(seat) => seats.filter((s) => s === seat).length === 1,
		) &&
		seats.every((seat) =>
			["code-review", "security-review", "simplify", "ultrareview"].includes(
				String(seat),
			),
		)
	);
}

function wireVerdict(
	value: JsonValue | undefined,
): value is Verdict & JsonValue {
	const v = wireObject(value);

	return (
		v !== null &&
		wireDigest(v.patchDigest) &&
		wireDigest(v.acceptanceDigest) &&
		wireDigest(v.heldoutDigest) &&
		wireSha(v.candidateSha) &&
		wireSha(v.gateSha) &&
		wireSha(v.originalBase) &&
		wireSha(v.baseSha) &&
		wireCount(v.ciRunId, 1) &&
		(v.pass === true || v.pass === false) &&
		wireStrings(v.requiredChecks) &&
		wireStrings(v.unjudged) &&
		Array.isArray(v.checks) &&
		v.checks.every((entry) => {
			const c = wireObject(entry);

			return (
				c !== null &&
				wireText(c.name) &&
				(c.passed === true || c.passed === false) &&
				(c.detail === undefined || wireText(c.detail))
			);
		})
	);
}

function wireReport(
	value: JsonValue | undefined,
): value is TrustedReport & JsonValue {
	const v = wireObject(value);

	return (
		v !== null &&
		wireSha(v.candidateSha) &&
		wireSha(v.gateSha) &&
		wireCount(v.ciRunId, 1) &&
		wireCount(v.reportId, 1) &&
		wireText(v.nonce) &&
		/^[a-f0-9]{16}-r[0-2]-d[12](?:-g[1-3])?$/.test(v.nonce) &&
		wireDigest(v.heldoutDigest) &&
		v.externalId === `factory-gates:${v.ciRunId}:${v.nonce}`
	);
}

/**
 * A stored review receipt. Version 2 has no family evidence and only
 * `r8: "incomplete"`. Version 3 rebuilds the builder's, the accept author's
 * and each seat's `FamilyInput` with `parseFamily`, and its `r8` and labels
 * must equal what that evidence gives; a forged label or `r8` fails.
 */
function wireReview(
	value: JsonValue | undefined,
): value is ReviewReceipt & JsonValue {
	// A version 2 receipt's labels are checked only when it is certified.
	return (
		wireReviewFields(value) && (value.version === 2 || familyClaimsHold(value))
	);
}

function wireReviewFields(
	value: JsonValue | undefined,
): value is ReviewReceipt & JsonValue {
	const v = wireObject(value);

	if (
		!wireReviewBinding(value) ||
		v === null ||
		(v.version === 2
			? v.r8 !== "incomplete" ||
				v.builder !== undefined ||
				v.accept !== undefined
			: v.version !== 3 ||
				(v.r8 !== "complete" && v.r8 !== "incomplete") ||
				parseFamily(v.builder) === null ||
				parseFamily(v.accept) === null) ||
		(v.blocking !== true && v.blocking !== false) ||
		!Array.isArray(v.seats) ||
		v.seats.length > 4
	)
		return false;

	const seatsHold = v.seats.every((entry) => {
		const s = wireObject(entry);

		if (
			s === null ||
			(v.version === 3
				? parseFamily(s.family) === null
				: s.family !== undefined) ||
			!wireText(s.seat) ||
			!wireText(s.requested) ||
			(s.observed !== null && !wireText(s.observed)) ||
			!wireText(s.label) ||
			(s.fallback !== true && s.fallback !== false) ||
			!wireCount(s.tokens) ||
			!Array.isArray(s.findings) ||
			!Array.isArray(s.judgments)
		)
			return false;

		return (
			s.findings.every((item) => {
				const f = wireObject(item);

				return (
					f !== null &&
					wireText(f.id) &&
					(f.severity === "blocking" || f.severity === "advisory") &&
					["bug", "security", "contract", "simplify"].includes(
						String(f.category),
					) &&
					wireText(f.path) &&
					wireCount(f.startLine, 1) &&
					wireCount(f.endLine, 1) &&
					f.endLine >= f.startLine &&
					wireText(f.claim) &&
					wireText(f.evidence)
				);
			}) &&
			s.judgments.every((item) => {
				const j = wireObject(item);

				return (
					j !== null &&
					Object.keys(j).length === 3 &&
					wireText(j.scenario) &&
					isJudgmentOutcome(j.outcome) &&
					wireText(j.reason)
				);
			})
		);
	});

	return seatsHold;
}

function migrateReview(value: JsonValue | undefined): JsonValue | undefined {
	const v = wireObject(value);

	if (v?.version !== 1) return value;

	if (!Array.isArray(v.seats)) return null;
	const seats: JsonValue[] = [];

	for (const entry of v.seats) {
		const s = wireObject(entry);

		if (s === null || !Array.isArray(s.judgments)) return null;
		const judgments: JsonValue[] = [];

		for (const item of s.judgments) {
			const j = wireObject(item);

			if (
				j === null ||
				Object.keys(j).sort().join() !== "pass,reason,scenario" ||
				(j.pass !== true && j.pass !== false)
			)
				return null;
			judgments.push({
				scenario: j.scenario ?? null,
				outcome: j.pass ? "pass" : "fail",
				reason: j.reason ?? null,
			});
		}

		seats.push({ ...s, judgments });
	}

	return { ...v, version: 2, seats };
}

export function parseReviewReceipt(
	value: JsonValue | undefined,
): ReviewReceipt | null {
	const migrated = migrateReview(value);

	return wireReview(migrated) ? snapshot(migrated) : null;
}

export function migrateCertificationValue(
	value: JsonValue | undefined,
): JsonValue | undefined {
	const c = wireObject(value);

	if (c === null) return value;

	// A version 1 review that fails migration keeps its original bytes, so it
	// never compares equal to an explicit null review.
	const review = migrateReview(c.review);

	return {
		...c,
		review: review === null ? (c.review ?? null) : (review ?? null),
	};
}

export function migrateEvidenceValue(
	value: JsonValue | undefined,
): JsonValue | undefined {
	const e = wireObject(value);

	return e === null || wireObject(e.certification) === null
		? value
		: {
				...e,
				certification: migrateCertificationValue(e.certification) ?? null,
			};
}

function wireValidation(
	value: JsonValue | undefined,
): value is ValidationState & JsonValue {
	const v = wireObject(value);
	const p = wireObject(v?.publication);
	const counters = wireObject(v?.counters);
	const generation = wireObject(v?.generation);

	return (
		v !== null &&
		(v.version === 1 ||
			(v.version === 2 &&
				generation !== null &&
				wireCount(generation.index) &&
				generation.index <= 3 &&
				wireDigest(generation.digest) &&
				(generation.previousHead === null ||
					wireSha(generation.previousHead)))) &&
		wireCount(v.startedAt) &&
		wireCount(v.deadline) &&
		v.deadline > v.startedAt &&
		wireCount(v.round) &&
		v.round <= 2 &&
		wireSha(v.originalBase) &&
		wireSha(v.baseSha) &&
		(v.rebaseSha === undefined || wireSha(v.rebaseSha)) &&
		(v.baseResolved === true || v.baseResolved === false) &&
		wireCount(v.dispatchTry) &&
		v.dispatchTry <= 2 &&
		(v.dispatchedAt === null || wireCount(v.dispatchedAt)) &&
		(v.ciRunId === null || wireCount(v.ciRunId, 1)) &&
		(v.publication === null ||
			(p !== null &&
				wireText(p.branch) &&
				/^factory\/run\/[1-9][0-9]*-[a-f0-9]{12}-r[0-2](?:-g[1-3])?$/.test(
					p.branch,
				) &&
				wireSha(p.patchSha) &&
				wireSha(p.candidateSha))) &&
		counters !== null &&
		Object.entries(counters).every(
			([key, count]) => isDigest(key) && wireCount(count) && count <= 3,
		)
	);
}

export function parseOwnerPatchReceipt(
	value: JsonValue | undefined,
): OwnerPatchReceipt | null {
	const v = wireObject(value);

	if (
		v === null ||
		v.version !== 1 ||
		v.kind !== "owner" ||
		!wireDigest(v.runId) ||
		!wireSha(v.head) ||
		!wireSha(v.baseSha) ||
		!wireDigest(v.contractDigest) ||
		!wireDigest(v.acceptanceDigest) ||
		!wireDigest(v.heldoutDigest) ||
		!wireDigest(v.patchDigest) ||
		!wireStrings(v.changedPaths) ||
		v.policy !== "clean" ||
		checkChangedPaths({ changedPaths: v.changedPaths }).kind !== "clean"
	)
		return null;

	return {
		version: 1,
		kind: "owner",
		runId: v.runId,
		head: v.head,
		baseSha: v.baseSha,
		contractDigest: v.contractDigest,
		acceptanceDigest: v.acceptanceDigest,
		heldoutDigest: v.heldoutDigest,
		patchDigest: v.patchDigest,
		changedPaths: v.changedPaths,
		policy: "clean",
	};
}

function wireIntent(
	value: JsonValue | undefined,
	pin: AdmissionPin,
	patch: PatchReceipt,
	ownerPatch?: OwnerPatchReceipt | null,
): value is GenerationIntent & JsonValue {
	const v = wireObject(value);
	const origin = wireObject(v?.origin);
	const publication = wireObject(v?.publication);

	if (
		!wireRef(value) ||
		v === null ||
		v.runId !== pin.runId ||
		v.originalBase !== pin.originalBase ||
		!wireSha(v.baseSha) ||
		v.patchDigest !==
			(origin?.kind === "owner"
				? ownerPatch?.patchDigest
				: patch.patchDigest) ||
		v.acceptanceDigest !== pin.acceptanceDigest ||
		origin === null ||
		publication === null ||
		!(
			(origin.kind === "initial" &&
				value.round === 0 &&
				value.generation === 0) ||
			(origin.kind === "repair" &&
				value.generation === 0 &&
				wireRef(origin.feedbackFrom)) ||
			(origin.kind === "refresh" &&
				value.generation > 0 &&
				wireRef(origin.previous)) ||
			(origin.kind === "owner" &&
				value.generation > 0 &&
				wireSha(origin.head) &&
				wireRef(origin.previous) &&
				publication.kind === "owner" &&
				publication.head === origin.head &&
				ownerPatch != null &&
				ownerPatch.head === origin.head &&
				ownerPatch.baseSha === v.baseSha &&
				ownerPatch.runId === pin.runId &&
				ownerPatch.contractDigest === pin.contractDigest &&
				ownerPatch.acceptanceDigest === pin.acceptanceDigest)
		) ||
		!(
			publication.kind === "initial" ||
			(publication.kind === "successor" && wireSha(publication.expectedHead)) ||
			(publication.kind === "owner" &&
				origin.kind === "owner" &&
				wireSha(publication.head))
		)
	)
		return false;

	const body = {
		round: value.round,
		generation: value.generation,
		runId: v.runId,
		originalBase: v.originalBase,
		baseSha: v.baseSha,
		patchDigest: v.patchDigest,
		acceptanceDigest: v.acceptanceDigest,
		origin: v.origin,
		publication: v.publication,
	};

	return digestOf(JSON.stringify(body)) === value.digest;
}

function wireReadiness(
	value: JsonValue | undefined,
): value is PublishedPr["readiness"] & JsonValue {
	const v = wireObject(value);

	return (
		v !== null &&
		wireCount(v.since) &&
		(v.kind === "ready" || (v.kind === "not_ready" && wireReason(v.reason)))
	);
}

function wireReason(value: JsonValue | undefined): value is HandoffReason {
	return (
		wireText(value) &&
		[
			"disabled",
			"main_moving",
			"refresh_limit",
			"review_attempts",
			"review_tokens",
			"repair_tokens",
			"run_tokens",
			"head_drift",
			"owner_head",
			"owner_head_refused",
			"owner_head_failed",
			"owner_head_behind",
			"checks_failed",
			"head_lag",
			"checks_incomplete",
			"review_failed",
			"review_input_too_large",
			"summary_too_large",
			"pr_identity",
			"pr_ambiguous",
			"validation_failed",
			"evidence_unavailable",
			"repair_limit",
			"diagnosis_oracle",
			"diagnosis_missing_evidence",
			"diagnosis_infrastructure",
			"feedback_overflow",
			"feedback_repair",
			"repair_no_progress",
			"repair_repeated_finding",
			"closed",
			"withdrawn",
		].includes(value)
	);
}

function wireTerminal(
	value: JsonValue | undefined,
): value is TerminalObservation & JsonValue {
	const v = wireObject(value);

	if (v === null) return false;

	if (v.kind === "released") return true;

	if (v.kind === "failed") return wireReason(v.reason);

	if (!wireCount(v.number, 1)) return false;

	if (v.kind === "cancelled")
		return v.reason === "closed" || v.reason === "withdrawn";
	const assurance = wireObject(v.assurance);

	return (
		v.kind === "merged" &&
		wireSha(v.head) &&
		wireSha(v.mergeSha) &&
		(v.actor === null || wireText(v.actor)) &&
		assurance !== null &&
		(assurance.kind === "owner_override" ||
			(assurance.kind === "factory_verified" &&
				wireRef(assurance.certification))) &&
		(v.readiness === null || wireReadiness(v.readiness))
	);
}

function wireEffect(
	value: JsonValue | undefined,
	pin: AdmissionPin,
	patch: PatchReceipt,
	ownerPatch?: OwnerPatchReceipt | null,
): value is CandidateEffect & JsonValue {
	const v = wireObject(value);

	if (v === null) return false;

	switch (v.kind) {
		case "derive_owner_patch":
			return (
				wireSha(v.head) &&
				wireSha(v.baseSha) &&
				(v.attempt === undefined || (wireCount(v.attempt, 1) && v.attempt <= 3))
			);
		case "validate":
			return wireIntent(v.generation, pin, patch, ownerPatch);
		case "launch_review":
			return wireExecution(v.execution) && v.execution.stage === "review";
		case "repair_build":
			return wireExecution(v.execution) && v.execution.stage === "build";
		case "stop_execution":
			return (
				wireExecution(v.execution) &&
				(v.terminal === null || wireTerminal(v.terminal))
			);
		case "open_pr":
			return (
				wireRef(v.certification) &&
				wireSha(v.head) &&
				v.branch === `factory/pr/${pin.issue}-${pin.runId.slice(0, 12)}`
			);
		case "promote_pr":
			return (
				wireCount(v.number, 1) &&
				wireSha(v.expectedHead) &&
				wireRef(v.certification) &&
				wireSha(v.head)
			);
		case "complete_handoff":
			return (
				wireCount(v.number, 1) && wireRef(v.certification) && wireSha(v.head)
			);
		case "void_readiness":
			return wireCount(v.number, 1) && wireReason(v.reason);
		case "post_notice": {
			const notice = wireObject(v.notice);
			const then = wireObject(v.then);
			const work = wireObject(then?.work);

			return (
				wireCount(v.number, 1) &&
				(v.withdraw === null || wireReason(v.withdraw)) &&
				(v.at === undefined || wireCount(v.at)) &&
				(v.detail === undefined || v.detail === null || wireReason(v.detail)) &&
				(v.refusal === undefined ||
					[
						"heldout_changed",
						"forbidden_path",
						"behind_main",
						"too_large",
						"unreadable",
					].includes(String(v.refusal))) &&
				(notice?.kind === "feedback_intake" ||
					notice?.kind === "feedback_overflow" ||
					notice?.kind === "repair_started" ||
					notice?.kind === "repair_unavailable" ||
					notice?.kind === "round_summary" ||
					notice?.kind === "owner_head" ||
					notice?.kind === "owner_head_failed" ||
					notice?.kind === "checks_failed") &&
				notice.place === (notice.kind === "round_summary" ? "pr" : "issue") &&
				wireText(notice.key) &&
				new RegExp(
					notice.kind === "feedback_overflow"
						? `^<!-- factory:notice ${pin.runId} feedback_overflow -->$`
						: notice.kind === "round_summary"
							? `^<!-- factory:notice ${pin.runId} round_summary [12] -->$`
							: ["owner_head", "owner_head_failed", "checks_failed"].includes(
										String(notice.kind),
									) && wireReason(v.detail)
								? `^<!-- factory:notice ${pin.runId} ${notice.kind} (?:${v.detail}${v.refusal === undefined ? "" : ` ${v.refusal}`} )?[0-9a-f]{40} -->$`
								: `^<!-- factory:notice ${pin.runId} ${notice.kind} [0-9a-f]{${["owner_head", "owner_head_failed", "checks_failed"].includes(String(notice.kind)) ? 40 : 64}} -->$`,
				).test(notice.key) &&
				((then?.kind === "resume" &&
					work !== null &&
					(work.kind === "waiting" ||
						(work.kind === "held" &&
							wireReason(work.reason) &&
							wireCount(work.since)))) ||
					(then?.kind === "held" && wireReason(then.reason)) ||
					(then?.kind === "finish" &&
						wireTerminal(then.terminal) &&
						then.terminal.kind === "cancelled") ||
					(then?.kind === "owner_due" &&
						wireSha(then.head) &&
						wireCount(then.since)) ||
					(then?.kind === "repair_due" &&
						wireWork(then, pin, patch, ownerPatch)))
			);
		}

		case "finish_pr":
			return wireTerminal(v.terminal);
		default:
			return false;
	}
}

function wireWork(
	value: JsonValue | undefined,
	pin: AdmissionPin,
	patch: PatchReceipt,
	ownerPatch?: OwnerPatchReceipt | null,
): value is CandidateWork & JsonValue {
	const v = wireObject(value);

	if (v === null) return false;

	switch (v.kind) {
		case "owner_due":
			return (
				wireSha(v.head) &&
				wireCount(v.since) &&
				(v.attempt === undefined || (wireCount(v.attempt, 1) && v.attempt <= 3))
			);
		case "effect":
			return wireEffect(v.request, pin, patch, ownerPatch);
		case "review_due":
			return (
				wireStrings(v.seats) &&
				v.seats.length >= 3 &&
				v.seats.length <= 4 &&
				v.seats.every((s) =>
					[
						"code-review",
						"security-review",
						"simplify",
						"ultrareview",
					].includes(s),
				)
			);
		case "reviewing":
			return wireExecution(v.execution) && v.execution.stage === "review";
		case "rebuilding":
			return wireExecution(v.execution) && v.execution.stage === "build";
		case "repair_due":
			return (
				(v.round === 1 || v.round === 2) &&
				wireCount(v.attempt, 1) &&
				wireRef(v.feedbackFrom) &&
				wireCause(v.cause)
			);
		case "repair_built":
			return wirePatch(v.patch) && wireRef(v.feedbackFrom);
		case "handoff":
		case "waiting":
			return true;
		case "held":
			return wireReason(v.reason) && wireCount(v.since);
		case "terminal":
			return wireTerminal(v.terminal);
		default:
			return false;
	}
}

function wireEvidence(
	value: JsonValue | undefined,
	pin: AdmissionPin,
): value is GenerationEvidence & JsonValue {
	const v = wireObject(value);

	if (
		v === null ||
		!wirePatch(v.patch) ||
		!validPatch(pin, v.patch, v.patch.round ?? 0) ||
		!wireIntent(v.intent, pin, v.patch, parseOwnerPatchReceipt(v.ownerPatch)) ||
		(wireObject(v.intent)?.origin !== undefined &&
			wireObject(wireObject(v.intent)?.origin)?.kind !== "owner" &&
			v.ownerPatch != null) ||
		(v.review !== undefined && !wireReview(v.review)) ||
		(v.assessmentKind !== undefined &&
			!["passed", "candidate", "unusable"].includes(
				String(v.assessmentKind),
			)) ||
		(v.validation !== null && !wireValidation(v.validation)) ||
		(v.verdict !== null && !wireVerdict(v.verdict)) ||
		(v.report !== null && !wireReport(v.report)) ||
		(v.assessment !== undefined &&
			!(
				wireObject(v.assessment) !== null &&
				wireDigest(wireObject(v.assessment)?.bindingDigest) &&
				wireDigest(wireObject(v.assessment)?.recordDigest)
			))
	)
		return false;

	if (v.certification === null) return true;
	const c = wireObject(v.certification);

	return (
		c !== null &&
		wireRef(c.generation) &&
		sameGeneration(c.generation, v.intent) &&
		c.workflowSha === pin.workflowSha &&
		c.workflowDigest === pin.workflowDigest &&
		wireExecution(c.execution) &&
		c.execution.stage === "review" &&
		wireVerdict(c.verdict) &&
		verdictPasses(c.verdict) &&
		wireReview(c.review) &&
		!c.review.blocking &&
		!blocksReview(c.review.seats) &&
		wireReport(c.report) &&
		JSON.stringify(c.verdict) === JSON.stringify(v.verdict) &&
		JSON.stringify(c.report) === JSON.stringify(v.report) &&
		c.review.candidateSha === c.verdict.candidateSha &&
		c.report.candidateSha === c.verdict.candidateSha &&
		JSON.stringify(c.review.execution) ===
			JSON.stringify(c.execution.binding.execution)
	);
}

function wireCandidate(
	value: JsonValue | undefined,
): value is CandidateState & JsonValue {
	const v = wireObject(value);

	if (
		v === null ||
		!wirePin(v.pin) ||
		!wireCount(v.priorTokens) ||
		!Array.isArray(v.accounts) ||
		v.accounts.length > 15
	)
		return false;
	const pin = v.pin;
	const ids = new Set<string>();

	for (const entry of v.accounts) {
		const a = wireObject(entry);
		const spend = wireObject(a?.spend);

		if (
			a === null ||
			!wireExecution(a.execution) ||
			a.execution.runId !== v.pin.runId ||
			a.execution.workflowSha !== v.pin.workflowSha ||
			a.execution.workflowDigest !== v.pin.workflowDigest ||
			ids.has(a.execution.id) ||
			spend === null ||
			!(
				(spend.kind === "known" && wireCount(spend.tokens)) ||
				(spend.kind === "unknown" && wireCount(spend.floor))
			) ||
			!["issued", "running", "settled", "uncertain"].includes(
				String(a.settlement),
			)
		)
			return false;
		ids.add(a.execution.id);
	}

	if (v.kind === "unprepared")
		return (
			v.accounts.length === 0 &&
			wirePatch(v.patch) &&
			validPatch(v.pin, v.patch, 0)
		);

	if (
		v.kind !== "selected" ||
		!Array.isArray(v.history) ||
		v.history.length >= MAX_GENERATIONS ||
		!v.history.every((g) => wireEvidence(g, pin)) ||
		!wireEvidence(v.current, v.pin) ||
		!wireWork(v.work, v.pin, v.current.patch, v.current.ownerPatch) ||
		(v.feedback !== null &&
			!wireFeedbackCursor(v.feedback, v.pin.repo, wireReason))
	)
		return false;
	const generations = [...v.history, v.current];

	const digests = new Set(
		generations.map((g) => wireObject(wireObject(g)?.intent)?.digest),
	);

	if (digests.size !== generations.length) return false;

	if (v.published === null) return true;
	const published = wireObject(v.published);

	if (
		published === null ||
		!wireRef(published.promoted) ||
		(v.feedback !== null && v.feedback.pr !== published.number)
	)
		return false;
	const promoted = published.promoted;

	return (
		wireCount(published.number, 1) &&
		published.branch === `factory/pr/${pin.issue}-${pin.runId.slice(0, 12)}` &&
		wireReadiness(published.readiness) &&
		(published.ownerHead == null || wireSha(published.ownerHead)) &&
		generations.some((g) => {
			const evidence = wireObject(g);

			return (
				evidence?.certification !== null &&
				wireRef(evidence?.intent) &&
				sameGeneration(evidence.intent, promoted)
			);
		})
	);
}

export function parseCandidateState(
	value: JsonValue | undefined,
): CandidateState | null {
	const v = wireObject(value);

	const migrated =
		v?.kind === "selected" && Array.isArray(v.history)
			? {
					...v,
					feedback: v.feedback ?? null,
					history: v.history.map((g) => migrateEvidenceValue(g) ?? null),
					current: migrateEvidenceValue(v.current) ?? null,
				}
			: value;

	return wireCandidate(migrated) ? snapshot(migrated) : null;
}

export type Limitation =
	| { readonly kind: "judge_only"; readonly criteria: readonly string[] }
	| { readonly kind: "same_family" }
	| {
			readonly kind: "judgment";
			readonly scenario: string;
			readonly outcome: Exclude<JudgmentOutcome, "pass">;
	  }
	| { readonly kind: "live_proof_not_recorded" };

export function notProven(input: {
	readonly criteria: readonly { readonly id: string }[];
	readonly scenarios: readonly {
		readonly criteria: readonly string[];
		readonly checks: readonly string[];
	}[];
	readonly r8: string;
	readonly judgments: readonly Judgment[];
}): readonly Limitation[] {
	const checked = new Set(
		input.scenarios.flatMap((s) => (s.checks.length > 0 ? s.criteria : [])),
	);

	const judgeOnly = input.criteria
		.map((c) => c.id)
		.filter((id) => !checked.has(id));

	return [
		...(judgeOnly.length > 0
			? [{ kind: "judge_only" as const, criteria: judgeOnly }]
			: []),
		...(input.r8 === "complete" ? [] : [{ kind: "same_family" as const }]),
		...input.judgments.flatMap(({ scenario, outcome }) =>
			outcome === "pass"
				? []
				: [{ kind: "judgment" as const, scenario, outcome }],
		),
		{ kind: "live_proof_not_recorded" },
	];
}

export function renderLimitation(limitation: Limitation): string {
	switch (limitation.kind) {
		case "judge_only":
			return `- No executable check covers ${limitation.criteria.filter((id) => /^A[1-9][0-9]{0,2}$/.test(id)).join(", ")}; only review judged them.`;
		case "same_family":
			return "- R8 cross-family review remains incomplete.";
		case "judgment":
			return `- Review judged ${/^S[1-9][0-9]{0,2}$/.test(limitation.scenario) ? limitation.scenario : "a scenario"} as ${limitation.outcome}; it is not proven.`;
		case "live_proof_not_recorded":
			return "- No live proof is recorded; CI and review ran on the candidate only.";
	}
}
