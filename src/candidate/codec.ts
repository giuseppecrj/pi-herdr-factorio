import type { PatchReceipt } from "./build.ts";
import { wireFeedbackCursor, wireBuilderDecisions } from "./feedback.ts";
import {
	familyClaimsHold,
	isJudgmentOutcome,
	type ReviewBinding,
	type ReviewReceipt,
} from "./review.ts";
import type { TrustedReport, ValidationState } from "./validation.ts";
import {
	MAX_GENERATIONS,
	MAX_REVIEW_ATTEMPTS,
	sameGeneration,
	snapshot,
	validPatch,
	type AdmissionPin,
	type CandidateEffect,
	type CandidateExecution,
	type CandidateState,
	type CandidateWork,
	type GenerationEvidence,
	type GenerationIntent,
	type GenerationRef,
	type HandoffReason,
	type OwnerPatchReceipt,
	type PublishedPr,
	type RepairCause,
	type TerminalObservation,
} from "./state.ts";
import { checkChangedPaths } from "../trust/policy.ts";
import { parseFamily } from "../core/models.ts";
import {
	blocksReview,
	digestOf,
	isDigest,
	type Digest,
	type Verdict,
	verdictPasses,
} from "../core/run.ts";
import { isGitSha, isRepoSlug, type GitSha } from "../workflow.ts";
import type { JsonValue } from "../core/json.ts";

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
			wireCause(v.cause) &&
			(v.cause.kind === "feedback"
				? v.feedbackFrom.round < v.round
				: v.feedbackFrom.round + 1 === v.round)
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
			"workflow_unavailable",
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
