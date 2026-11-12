import type { PatchReceipt } from "./build.ts";
import type { FeedbackCursor } from "./feedback.ts";
import type { ReviewBinding, ReviewReceipt, ReviewSeat } from "./review.ts";
import type {
	AssessmentRef,
	TrustedReport,
	ValidationState,
} from "./validation.ts";
import { checkChangedPaths } from "../trust/policy.ts";
import { digestOf, type Digest, type Verdict } from "../core/run.ts";
import type { GitSha, RepoSlug } from "../workflow.ts";

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
	| "workflow_unavailable"
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

function freeze<T>(value: T): T {
	if (value instanceof Object && !Object.isFrozen(value)) {
		for (const nested of Object.values(value)) freeze(nested);
		Object.freeze(value);
	}

	return value;
}

export function snapshot<T>(value: T): T {
	return freeze(structuredClone(value));
}

export function refOf(intent: GenerationIntent): GenerationRef {
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

export function validPatch(
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
