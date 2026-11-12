import { isDigest, type Digest } from "../core/run.ts";
import { unknownEfficiency, type EfficiencyFacts } from "../core/execution.ts";
import {
	authoredOf,
	candidateGenerations,
	type CandidateState,
} from "../handoff.ts";
import {
	VISIBLE_CHECKS,
	failedVisibleChecks,
	type FailureClass,
	type VisibleCheck,
} from "../candidate/diagnosis.ts";
import type { TerminalStatus } from "../trust/markers.ts";
import type { Stage } from "../core/stages.ts";
import type { GitSha, RepoSlug } from "../workflow.ts";
import { objectOf, type JsonValue } from "../core/json.ts";
import {
	ACCEPT_DISPOSITIONS,
	BUDGET_CAPS,
	LedgerRowError,
	REASON,
	fail,
	failureFact,
	known,
	nullable,
	outcome,
	provenanceOf,
	runContext,
	unavailable,
	type AttemptEnd,
	type FailureClassName,
	type LedgerRow,
	type RunContextV2,
	type RunStart,
	type RunStartRecord,
} from "./schema.ts";

/** The controller's own record of why a run stopped, before its row freezes. */
export type TerminalCause = Readonly<{
	/** The stage that caused the stop, not the run's last projected stage. */
	stage: Stage;
	class: FailureClassName;
	/** A fixed controller code: the cap, diagnosis reason or refusal reason. */
	reason: string;
	/** Visible check names only, never held-out content. */
	failedVisibleChecks?: readonly VisibleCheck[];
	/** The private patch the stop retains, by digest. */
	retainedPatch?: Digest | null;
}>;

const CAUSES = {
	attempts: "attempts_exhausted",
	input: "input_refused",
	base: "base_refused",
	provider: "provider_refused",
	label: "label_write_failed",
	candidate: "candidate_failed",
	missing_evidence: "evidence_missing",
	oracle: "oracle_invalid",
	infrastructure: "infrastructure_failed",
	review: "review_failed",
	handoff: "handoff_stopped",
} as const satisfies Record<Exclude<FailureClassName, "budget">, string>;

export type TerminalFacts = {
	readonly repo: RepoSlug;
	readonly runId: Digest;
	readonly issue: number;
	readonly eventId: string;
	readonly eventAt: string;
	readonly snapshotDigest: Digest;
	readonly workflowSha: GitSha;
	readonly workflowDigest: Digest;
	readonly status: TerminalStatus;
	readonly stage: Stage;
	readonly usage: number;
	readonly observedAt: string;
	readonly candidate: CandidateState | null;
	readonly attemptEnds?: readonly AttemptEnd[] | null;
	/** Why a failed or budget-exhausted run stopped, when the controller recorded it. */
	readonly cause?: TerminalCause | null;
	readonly evidence?: TerminalEvidence;
	readonly start?: RunStart | null;
	readonly context: RunContextV2;
	/** A load observed at collection, never evidence of an earlier execution policy. */
	readonly terminalWorkflowObservation: {
		readonly workflowSha: GitSha;
		readonly workflowDigest: Digest;
	} | null;
	readonly previousRunId?: Digest | null;
};

export type TerminalEvidence = Partial<
	Pick<
		LedgerRow,
		| "stages"
		| "models"
		| "usage"
		| "repairRounds"
		| "redactedReceiptDigests"
		| "artifacts"
	>
> & {
	readonly mergedAt?: string;
	readonly efficiency?: EfficiencyFacts;
	readonly contextPressure?: LedgerRow["contextPressure"];
	readonly generationGates?: Readonly<Record<string, Digest>>;
};

function outcomeOf(facts: TerminalFacts): JsonValue {
	const { stage, candidate } = facts;

	const terminal =
		candidate?.kind === "selected" && candidate.work.kind === "terminal"
			? candidate.work.terminal
			: null;

	switch (facts.status) {
		case "needs_info":
		case "released":
		case "stage_passed":
			return { kind: facts.status, stage };
		case "failed": {
			const cause = causeOf(facts);

			return {
				kind: "failed",
				stage,
				cause:
					cause === null || cause.class === "budget"
						? unavailable("receipt_missing")
						: known(CAUSES[cause.class]),
			};
		}

		case "budget_exhausted": {
			const cause = causeOf(facts);

			return {
				kind: "budget_exhausted",
				stage,
				cap:
					cause === null ? unavailable("receipt_missing") : known(cause.reason),
			};
		}

		case "cancelled":
			return {
				kind: "cancelled",
				stage,
				reason:
					terminal?.kind === "cancelled"
						? known(terminal.reason)
						: unavailable("receipt_missing"),
			};
		case "landed":
			if (terminal?.kind !== "merged") return fail("landing_incomplete");

			return {
				kind: "landed",
				stage: "land",
				headSha: terminal.head,
				mergeSha: terminal.mergeSha,
				mergedAt:
					facts.evidence?.mergedAt === undefined
						? unavailable("public_metadata_unavailable")
						: known(facts.evidence.mergedAt),
				assurance:
					terminal.assurance.kind === "factory_verified"
						? {
								kind: "factory_verified",
								generationDigest: terminal.assurance.certification.digest,
								authored:
									candidate?.kind === "selected"
										? authoredOf(candidate, terminal.assurance.certification)
										: fail("landing_incomplete"),
							}
						: { kind: "owner_override" },
			};
		default: {
			const exhaustive: never = facts.status;

			return exhaustive;
		}
	}
}

/** The recorded cause when it agrees with the terminal status, else `null`. */
function causeOf(facts: TerminalFacts): TerminalCause | null {
	const cause = facts.cause ?? null;
	const budget = facts.status === "budget_exhausted";

	if (
		cause === null ||
		(facts.status !== "failed" && !budget) ||
		(cause.class === "budget") !== budget ||
		!REASON.test(cause.reason) ||
		(budget && !BUDGET_CAPS.some((cap) => cap === cause.reason))
	)
		return null;

	return cause;
}

function failureOf(facts: TerminalFacts): JsonValue {
	if (facts.status !== "failed" && facts.status !== "budget_exhausted")
		return null;
	const cause = causeOf(facts);

	if (cause === null) return unavailable("receipt_missing");

	return known({
		stage: cause.stage,
		class: cause.class,
		reason: cause.reason,
		failedVisibleChecks: VISIBLE_CHECKS.filter((name) =>
			(cause.failedVisibleChecks ?? []).includes(name),
		),
		retainedPatch: cause.retainedPatch ?? null,
	});
}

const ACCEPT_DISPOSITION = {
	completed: "suite_qualified",
	model_failure: "model_failed",
	refused: "model_refused",
	base_refused: "base_refused",
	interrupted: "interrupted",
	budget_stop: "budget_stopped",
	aborted: "aborted",
} as const satisfies Record<
	AttemptEnd["disposition"],
	(typeof ACCEPT_DISPOSITIONS)[number]
>;

/**
 * Each accept attempt's final disposition. A refusal followed by the one
 * feedback retry is `retried`; earlier builds recorded it as `refused`.
 */
function acceptAttemptsOf(facts: TerminalFacts): JsonValue {
	if (facts.attemptEnds == null || facts.start == null)
		return unavailable("receipt_missing");

	return known(
		facts.attemptEnds
			.filter((end) => end.stage === "accept" && end.round === 0)
			.sort((a, b) => a.attempt - b.attempt)
			.map((end) => ({
				attempt: end.attempt,
				disposition:
					(end.disposition === "refused" ||
						end.disposition === "base_refused") &&
					end.next.kind === "retry"
						? "retried"
						: ACCEPT_DISPOSITION[end.disposition],
			})),
	);
}

const DIAGNOSIS_STOPS = {
	diagnosis_missing_evidence: "missing_evidence",
	diagnosis_oracle: "oracle",
	diagnosis_infrastructure: "infrastructure",
	validation_failed: "candidate",
	repair_limit: "candidate",
} as const;

/**
 * Why a candidate handoff stopped, from its durable terminal reason and, for
 * a validation stop, the current generation's stored diagnosis. A dead end
 * keeps the failed visible check names and the retained private patch.
 */
export function candidateCause(
	state: CandidateState,
	diagnosis: FailureClass | null,
): TerminalCause | null {
	if (
		state.kind !== "selected" ||
		state.work.kind !== "terminal" ||
		state.work.terminal.kind !== "failed"
	)
		return null;
	const reason = state.work.terminal.reason;

	if (reason === "review_tokens" || reason === "repair_tokens")
		return {
			stage: reason === "review_tokens" ? "review" : "build",
			class: "budget",
			reason: "round_tokens",
		};

	if (reason === "run_tokens")
		return {
			stage: state.accounts.at(-1)?.execution.stage ?? "validate",
			class: "budget",
			reason: "run_tokens",
		};

	if (reason === "review_attempts" || reason === "review_failed")
		return { stage: "review", class: "review", reason };

	if (!Object.hasOwn(DIAGNOSIS_STOPS, reason))
		return { stage: "land", class: "handoff", reason };
	// SAFETY: `reason` was just checked to be a key of `DIAGNOSIS_STOPS`.
	const kind = DIAGNOSIS_STOPS[reason as keyof typeof DIAGNOSIS_STOPS];
	const matched = diagnosis?.kind === kind ? diagnosis : null;
	const patch = state.current.patch.patchDigest;

	return {
		stage: "validate",
		class: kind,
		reason:
			matched === null
				? reason
				: matched.kind === "oracle"
					? matched.cause
					: matched.reason,
		failedVisibleChecks: failedVisibleChecks(
			state.current.verdict?.checks ?? null,
		),
		retainedPatch: isDigest(patch) ? patch : null,
	};
}

/**
 * The owner-facing stop facts of a stored terminal snapshot, for `status`:
 * the outcome and, from version 2, the cause. Never a held-out detail.
 */
export function terminalFailureOf(value: JsonValue | undefined): JsonValue {
	try {
		const object = objectOf(value) ?? fail("invalid_object");
		const stopped = outcome(object.outcome);

		return {
			outcome: stopped,
			failure:
				object.v === 2 || object.v === 3 || object.v === 4 || object.v === 5
					? nullable(failureFact)(object.failure)
					: stopped.kind === "failed" || stopped.kind === "budget_exhausted"
						? unavailable("legacy_not_recorded")
						: null,
		};
	} catch (error) {
		if (error instanceof LedgerRowError) return null;
		throw error;
	}
}

function artifactsOf(facts: TerminalFacts): JsonValue {
	const state = facts.candidate;

	if (state === null && facts.evidence?.artifacts !== undefined)
		return facts.evidence.artifacts;

	if (state === null)
		return facts.stage === "specify"
			? { kind: "admission" }
			: {
					kind: "pre_build_stop",
					contractDigest: unavailable("not_instrumented"),
					acceptanceDigest: unavailable("not_instrumented"),
				};

	if (state.kind === "unprepared")
		return {
			kind: "built",
			contractDigest: state.pin.contractDigest,
			acceptanceDigest: state.pin.acceptanceDigest,
			patchDigest: state.patch.patchDigest,
		};

	return {
		kind: "candidate",
		contractDigest: state.pin.contractDigest,
		acceptanceDigest: state.pin.acceptanceDigest,
		generations: candidateGenerations(state).map((evidence) => {
			const { intent, verdict, validation } = evidence;
			const publication = validation?.publication ?? null;
			const ci = validation?.ciRunId ?? null;

			const gateSha = verdict?.gateSha ?? intent.baseSha;
			const gatesDigest = facts.evidence?.generationGates?.[gateSha];

			return {
				round: intent.round,
				generation: intent.generation,
				intentDigest: intent.digest,
				baseSha: intent.baseSha,
				patchDigest: intent.patchDigest,
				heldoutDigest:
					verdict === null
						? unavailable("receipt_missing")
						: known(verdict.heldoutDigest),
				candidateSha:
					publication === null
						? unavailable("receipt_missing")
						: known(publication.candidateSha),
				gateSha:
					verdict === null && gatesDigest === undefined
						? unavailable("receipt_missing")
						: known(gateSha),
				gatesDigest:
					gatesDigest === undefined
						? unavailable("receipt_missing")
						: known(gatesDigest),
				ciRunId: ci === null ? unavailable("receipt_missing") : known(ci),
			};
		}),
	};
}

/**
 * Projects what the controller knows at a terminal decision into a row
 * without its marker proof. Facts this build does not yet record are
 * unavailable, never zero.
 */
export function terminalSnapshot(facts: TerminalFacts): JsonValue {
	const context = runContext(facts.context);
	const identity = context.kind === "legacy" ? context.known : context.policy;

	if (
		identity.workflowSha !== facts.workflowSha ||
		identity.workflowDigest !== facts.workflowDigest ||
		(facts.start != null &&
			(facts.start.runId !== facts.runId ||
				JSON.stringify(facts.start.context) !== JSON.stringify(context)))
	)
		fail("policy_binding");
	const base = `https://github.com/${facts.repo}`;
	const state = facts.candidate;
	const published = state?.kind === "selected" ? state.published : null;

	const ciUrls =
		state?.kind === "selected"
			? [
					...new Set(
						candidateGenerations(state).flatMap((evidence) =>
							evidence.validation?.ciRunId == null
								? []
								: [`${base}/actions/runs/${evidence.validation.ciRunId}`],
						),
					),
				].sort()
			: [];

	return {
		v: 5,
		runId: facts.runId,
		repo: facts.repo,
		issue: facts.issue,
		eventId: facts.eventId,
		eventAt: facts.eventAt,
		previousRunId:
			facts.previousRunId === undefined
				? unavailable("receipt_missing")
				: known(facts.previousRunId),
		snapshotDigest: facts.snapshotDigest,
		originalBase: state?.pin.originalBase ?? facts.workflowSha,
		startedAt:
			facts.start == null
				? unavailable("receipt_missing")
				: known(facts.start.startedAt),
		terminalObservedAt: facts.observedAt,
		runContext: context,
		terminalWorkflowObservation:
			facts.terminalWorkflowObservation === null
				? unavailable("receipt_missing")
				: known(facts.terminalWorkflowObservation),
		provenance: provenanceOf(context),
		outcome: outcomeOf(facts),
		pr:
			published === null
				? null
				: { number: published.number, url: `${base}/pull/${published.number}` },
		artifacts: artifactsOf(facts),
		repairRounds:
			facts.evidence?.repairRounds ?? unavailable("not_instrumented"),
		stages:
			facts.evidence?.stages?.kind === "known"
				? known(
						facts.evidence.stages.value.map((s) => ({
							...s,
							efficiency:
								"efficiency" in s ? s.efficiency : unknownEfficiency(),
						})),
					)
				: (facts.evidence?.stages ?? unavailable("receipt_missing")),
		models: facts.evidence?.models ?? unavailable("receipt_missing"),
		usage: facts.evidence?.usage ?? {
			tokens: {
				kind: "lower_bound",
				unit: "tokens",
				total: facts.usage,
				reason: "not_instrumented",
			},
			parentTokens: unavailable("not_instrumented"),
			childTokens: unavailable("not_instrumented"),
			unattributedTokens: unavailable("not_instrumented"),
			money: unavailable("provider_not_reported"),
		},
		interruptedAttempts:
			facts.attemptEnds == null || facts.start == null
				? unavailable("not_instrumented")
				: known(
						facts.attemptEnds.filter(
							(attempt) => attempt.disposition === "interrupted",
						).length,
					),
		contextPressure:
			facts.evidence?.contextPressure ?? unavailable("not_instrumented"),
		efficiency: facts.evidence?.efficiency ?? unknownEfficiency(),
		redactedReceiptDigests: facts.evidence?.redactedReceiptDigests ?? [],
		evidence: { issueUrl: `${base}/issues/${facts.issue}`, ciUrls },
		failure: failureOf(facts),
		acceptAttempts: acceptAttemptsOf(facts),
	};
}

export interface RunAccounting {
	start(runId: Digest): Promise<RunStart | null | undefined>;
	begin(record: RunStartRecord): Promise<boolean>;
	readAttempt(
		runId: Digest,
		stage: Stage,
		round: number,
		attempt: number,
	): Promise<AttemptEnd | null | undefined>;
	writeAttempt(record: AttemptEnd): Promise<boolean>;
	attempts(runId: Digest): Promise<readonly AttemptEnd[] | null>;
}
