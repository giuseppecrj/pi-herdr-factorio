import type { PatchRead, PatchReceipt } from "./build.ts";
import { checkChangedPaths } from "./policy.ts";
import type { ReviewBinding, ReviewReceipt, ReviewSeat } from "./review.ts";
import {
	REPAIR_BUILD_MAX_TOKENS,
	REVIEW_MAX_TOKENS,
	blocksReview,
	digestOf,
	type Digest,
	type Verdict,
	verdictPasses,
} from "./run.ts";
import type { TrustedReport, ValidationState } from "./validation.ts";
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
			| { readonly kind: "refresh"; readonly previous: GenerationRef };
		publication:
			| { readonly kind: "initial" }
			| { readonly kind: "successor"; readonly expectedHead: GitSha };
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

export type RepairExecution = Readonly<{
	id: Digest;
	stage: "build";
	runId: Digest;
	round: 1 | 2;
	attempt: number;
	feedbackFrom: GenerationRef;
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

export type GenerationEvidence = Readonly<{
	intent: GenerationIntent;
	patch: PatchReceipt;
	validation: ValidationState | null;
	verdict: Verdict | null;
	report: TrustedReport | null;
	certification: Certification | null;
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
	| "head_lag"
	| "checks_incomplete"
	| "review_failed"
	| "validation_failed"
	| "evidence_unavailable"
	| "repair_limit";

export type PublishedPr = Readonly<{
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

export type CandidateEffect =
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
	| { readonly kind: "finish_pr"; readonly terminal: TerminalObservation };

export type CandidateWork =
	| { readonly kind: "effect"; readonly request: CandidateEffect }
	| { readonly kind: "review_due"; readonly seats: readonly ReviewSeat[] }
	| { readonly kind: "reviewing"; readonly execution: ReviewExecution }
	| {
			readonly kind: "repair_due";
			readonly round: 1 | 2;
			readonly attempt: number;
			readonly feedbackFrom: GenerationRef;
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
				work: CandidateWork;
			}>);

type Selected = Extract<CandidateState, { kind: "selected" }>;

export type CandidateEffectResult =
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
			readonly kind: "finish_pr";
			readonly request: Extract<CandidateEffect, { kind: "finish_pr" }>;
	  };

export type CandidateEvent =
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
						readonly patch: Extract<PatchRead, { kind: "found" }>;
				  }
				| { readonly kind: "failed" };
	  }
	| {
			readonly kind: "repair_settled";
			readonly execution: RepairExecution;
			readonly tokens: number | null;
			readonly result:
				| { readonly kind: "passed"; readonly patch: PatchReceipt }
				| { readonly kind: "failed" };
	  };

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
		} else if (work.kind === "held") status = "blocked";
		else if (work.kind === "terminal") {
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
	patch: PatchReceipt;
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

	if (candidateUsage(state) >= state.pin.maxTokens) return "run_tokens";

	if (nextAttempt(state, stage, round) > state.pin.maxReviewAttempts)
		return "review_attempts";

	const spent = state.accounts
		.filter((a) => a.execution.stage === stage && a.execution.round === round)
		.reduce((sum, a) => sum + tokensOf(a), 0);

	return spent >=
		(stage === "review" ? REVIEW_MAX_TOKENS : REPAIR_BUILD_MAX_TOKENS)
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
	const published =
		state.published === null
			? null
			: {
					...state.published,
					readiness: { kind: "not_ready", since: now, reason } as const,
				};

	return { ...state, published, work: { kind: "held", reason, since: now } };
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
): Selected {
	if (state.history.length + 2 > MAX_GENERATIONS)
		return hold(state, "refresh_limit", 0);

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

function finish(state: Selected, terminal: TerminalObservation): Selected {
	const execution = activeExecution(state);

	return effect(
		state,
		execution === null
			? { kind: "finish_pr", terminal }
			: { kind: "stop_execution", execution, terminal },
	);
}

function failOrRepair(
	state: Selected,
	reason: HandoffReason,
	now: number,
): Selected {
	if (state.published !== null) return hold(state, reason, now);
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
		},
	};
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
	patch: Extract<PatchRead, { kind: "found" }>;
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
		!validPatch(pin, patch.receipt, g.round) ||
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
		r.r8 !== "incomplete" ||
		r.seats.length !== e.seats.length ||
		e.seats.some(
			(seat) => r.seats.filter((s) => s.seat === seat).length !== 1,
		) ||
		r.seats.some(
			(s) =>
				!s.label.startsWith("context-isolated,") ||
				!s.label.endsWith("same family, not cross-family") ||
				!Number.isSafeInteger(s.tokens) ||
				s.tokens < 0,
		) ||
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
			(id) => judgments.filter((j) => j.scenario === id && j.pass).length !== 1,
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

function observed(
	state: Selected,
	event: Extract<CandidateEvent, { kind: "observed" }>,
): Selected {
	if (state.work.kind === "terminal") return state;

	if (event.pr.kind === "merged")
		return finish(state, terminalFor(state, event.pr));

	if (
		state.work.kind === "effect" &&
		(state.work.request.kind === "finish_pr" ||
			(state.work.request.kind === "stop_execution" &&
				state.work.request.terminal !== null))
	)
		return state;

	if (event.pr.kind === "closed")
		return finish(state, {
			kind: "cancelled",
			number: event.pr.number,
			reason: "closed",
		});

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
			: finish(state, {
					kind: "cancelled",
					number: state.published.number,
					reason: "withdrawn",
				});
	}

	if (!event.executionAllowed || event.eligibility === "unverified")
		return state;
	const work = state.work;

	if (work.kind === "repair_due") {
		if (!event.capacityAvailable) return state;
		const reason = preflight(state, "build", work.round);

		if (reason !== null) return hold(state, reason, event.now);

		const body = {
			stage: "build",
			runId: state.pin.runId,
			round: work.round,
			attempt: nextAttempt(state, "build", work.round),
			feedbackFrom: work.feedbackFrom,
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
			publication: { kind: "initial" },
		});

		return selectGeneration(state, intent, work.patch);
	}

	if (event.main !== null && event.main !== state.current.intent.baseSha) {
		const execution = activeExecution(state);

		if (execution !== null)
			return effect(state, {
				kind: "stop_execution",
				execution,
				terminal: null,
			});

		const refreshes = candidateGenerations(state).filter(
			(g) => g.intent.origin.kind === "refresh",
		).length;

		const reason = preflight(state, "review", state.current.intent.round);

		if (reason !== null) return hold(state, reason, event.now);

		if (refreshes >= MAX_REFRESHES || state.current.intent.generation === 3)
			return hold(state, "refresh_limit", event.now);

		const generation =
			state.current.intent.generation === 0
				? 1
				: state.current.intent.generation === 1
					? 2
					: 3;

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
				event.pr.head !== head ||
				event.pr.refHead !== head)
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
					: { kind: "successor", expectedHead: head },
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

	const certificate = state.current.certification;

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

		return state.published === null
			? hold(state, reason, event.now)
			: effect(hold(state, reason, event.now), {
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
		sameGeneration(state.published.promoted, state.current.intent)
		? { ...state, work: { kind: "waiting" } }
		: effect(state, {
				kind: "complete_handoff",
				number: state.published.number,
				certification: refOf(state.current.intent),
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

function complete(state: Selected, c: CandidateEffectResult): Selected {
	if (
		state.work.kind !== "effect" ||
		state.work.request.kind !== c.kind ||
		JSON.stringify(state.work.request) !== JSON.stringify(c.request)
	)
		return state;

	switch (c.kind) {
		case "validate": {
			const current = { ...state.current, validation: c.result.validation };

			if (c.result.kind === "waiting") return { ...state, current };

			if (c.result.kind === "failed")
				return c.result.reason === "validation_failed"
					? failOrRepair({ ...state, current }, "validation_failed", 0)
					: hold({ ...state, current }, c.result.reason, 0);
			const { verdict, report, seats } = c.result;

			if (!verdictPasses(verdict))
				return failOrRepair(
					{ ...state, current: { ...current, verdict } },
					"validation_failed",
					0,
				);

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
				return hold(state, "evidence_unavailable", 0);

			return {
				...state,
				current: { ...current, verdict, report },
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
				: finish(updated, c.request.terminal);
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
				: hold(state, "head_lag", 0);
		case "complete_handoff":
			return state.published === null
				? hold(state, "evidence_unavailable", c.now)
				: {
						...state,
						published: {
							...state.published,
							promoted: c.request.certification,
							readiness: { kind: "ready", since: c.now },
						},
						work: { kind: "waiting" },
					};
		case "void_readiness":
			return {
				...state,
				work: {
					kind: "held",
					reason: c.request.reason,
					since: state.published?.readiness.since ?? 0,
				},
			};
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

				if (accountFor(updated, event.execution)?.spend.kind !== "known") {
					next = hold(updated, "evidence_unavailable", 0);
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
			case "effect_completed":
				next = complete(state, event.completion);
				break;
			case "execution_progress":
				next = updateAccount(state, event.execution, event.tokens, false);
				break;
			case "review_settled": {
				if (accountFor(state, event.execution) === null) break;

				const updated = updateAccount(
					state,
					event.execution,
					event.tokens,
					true,
				);

				next = updated;

				if (
					state.work.kind !== "reviewing" ||
					!executionEqual(state.work.execution, event.execution) ||
					!sameGeneration(state.current.intent, event.execution.generation)
				)
					break;

				if (accountFor(updated, event.execution)?.settlement !== "settled") {
					next = hold(updated, "evidence_unavailable", 0);
					break;
				}

				if (event.result.kind === "failed") {
					const reason = preflight(updated, "review", event.execution.round);
					next =
						state.published !== null
							? hold(updated, "review_failed", 0)
							: reason === null
								? {
										...updated,
										work: { kind: "review_due", seats: event.execution.seats },
									}
								: finish(updated, { kind: "failed", reason });
					break;
				}

				if (state.current.verdict === null || state.current.report === null) {
					next = hold(updated, "evidence_unavailable", 0);
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
					next = failOrRepair(updated, "review_failed", 0);
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
					next = hold(updated, "evidence_unavailable", 0);
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
									work: {
										kind: "repair_due",
										round: event.execution.round,
										attempt: nextAttempt(
											updated,
											"build",
											event.execution.round,
										),
										feedbackFrom: event.execution.feedbackFrom,
									},
								}
							: finish(updated, { kind: "failed", reason });
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
			v.feedbackFrom.round + 1 === v.round
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

function wireReview(
	value: JsonValue | undefined,
): value is ReviewReceipt & JsonValue {
	const v = wireObject(value);

	if (
		!wireReviewBinding(value) ||
		v === null ||
		v.version !== 1 ||
		v.r8 !== "incomplete" ||
		(v.blocking !== true && v.blocking !== false) ||
		!Array.isArray(v.seats) ||
		v.seats.length > 4
	)
		return false;

	return v.seats.every((entry) => {
		const s = wireObject(entry);

		if (
			s === null ||
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
					wireText(j.scenario) &&
					(j.pass === true || j.pass === false) &&
					wireText(j.reason)
				);
			})
		);
	});
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

function wireIntent(
	value: JsonValue | undefined,
	pin: AdmissionPin,
	patch: PatchReceipt,
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
		v.patchDigest !== patch.patchDigest ||
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
				wireRef(origin.previous))
		) ||
		!(
			publication.kind === "initial" ||
			(publication.kind === "successor" && wireSha(publication.expectedHead))
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
			"head_lag",
			"checks_incomplete",
			"review_failed",
			"validation_failed",
			"evidence_unavailable",
			"repair_limit",
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
): value is CandidateEffect & JsonValue {
	const v = wireObject(value);

	if (v === null) return false;

	switch (v.kind) {
		case "validate":
			return wireIntent(v.generation, pin, patch);
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
): value is CandidateWork & JsonValue {
	const v = wireObject(value);

	if (v === null) return false;

	switch (v.kind) {
		case "effect":
			return wireEffect(v.request, pin, patch);
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
				wireRef(v.feedbackFrom)
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
		!wireIntent(v.intent, pin, v.patch) ||
		(v.validation !== null && !wireValidation(v.validation)) ||
		(v.verdict !== null && !wireVerdict(v.verdict)) ||
		(v.report !== null && !wireReport(v.report))
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
		!wireWork(v.work, v.pin, v.current.patch)
	)
		return false;
	const generations = [...v.history, v.current];

	const digests = new Set(
		generations.map((g) => wireObject(wireObject(g)?.intent)?.digest),
	);

	if (digests.size !== generations.length) return false;

	if (v.published === null) return true;
	const published = wireObject(v.published);

	if (published === null || !wireRef(published.promoted)) return false;
	const promoted = published.promoted;

	return (
		wireCount(published.number, 1) &&
		published.branch === `factory/pr/${pin.issue}-${pin.runId.slice(0, 12)}` &&
		wireReadiness(published.readiness) &&
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
	return wireCandidate(value) ? snapshot(value) : null;
}

export type Limitation =
	| { readonly kind: "judge_only"; readonly criteria: readonly string[] }
	| { readonly kind: "same_family" }
	| { readonly kind: "live_proof_not_recorded" };

export function notProven(input: {
	readonly criteria: readonly { readonly id: string }[];
	readonly scenarios: readonly {
		readonly criteria: readonly string[];
		readonly checks: readonly string[];
	}[];
	readonly r8: string;
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
		{ kind: "live_proof_not_recorded" },
	];
}

export function renderLimitation(limitation: Limitation): string {
	switch (limitation.kind) {
		case "judge_only":
			return `- No executable check covers ${limitation.criteria.filter((id) => /^A[1-9][0-9]{0,2}$/.test(id)).join(", ")}; only review judged them.`;
		case "same_family":
			return "- R8 cross-family review remains incomplete.";
		case "live_proof_not_recorded":
			return "- No live proof is recorded; CI and review ran on the candidate only.";
	}
}
