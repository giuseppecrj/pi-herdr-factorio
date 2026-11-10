import assert from "node:assert/strict";
import {
	feedbackId,
	MAX_FEEDBACK_SEEN,
	MAX_FEEDBACK_BATCHES,
	type FeedbackObservation,
	type FeedbackBatchStatus,
} from "../src/feedback.ts";
import { test } from "node:test";
import {
	beginCandidate,
	authoredOf,
	type OwnerPatchReceipt,
	stopRound,
	candidateUsage,
	handoffCandidate as reduceCandidate,
	candidateProjection,
	generationIntent,
	type AdmissionPin,
	type CandidateEvent,
	type CandidateState,
	type CandidateEffect,
	type ReviewExecution,
	candidateAllowance,
	certifyGeneration,
	notProven,
	parseCandidateState,
	reviewReceiptDigest,
	parseReviewReceipt,
	renderLimitation,
	migrateCertificationValue,
} from "../src/handoff.ts";
import {
	digestOf,
	REPAIR_BUILD_MAX_TOKENS,
	REVIEW_MAX_TOKENS,
	REQUIRED_CI_CHECKS,
	type Verdict,
	type Run,
} from "../src/run.ts";
import { advance } from "../src/stages.ts";
import {
	TRUSTED_RUN_CAP,
	FakeGitHub,
	fakeIssue,
	BOT_LOGIN,
} from "./fake-ticket-adapter.ts";
import { classifyFeedback } from "../src/feedback.ts";
import { storeFeedbackBatch } from "../server/controller.ts";
import {
	type FamilyInput,
	familyLabel,
	type ReviewReceipt,
	reviewR8,
} from "../src/review.ts";
import {
	dispatchNonce,
	type TrustedReport,
	type ValidationState,
} from "../src/validation.ts";
import { candidateBranch } from "../src/publication.ts";
import type { JsonValue } from "../src/tickets.ts";
import { isGitSha, isRepoSlug } from "../src/workflow.ts";
import { storePatch, type PatchReceipt } from "../src/build.ts";
import { controllerCandidatePort } from "../server/controller.ts";
import { fileAdmissionStore } from "../src/admission.ts";
import { CONTROLLER_LOGIN } from "../src/markers.ts";
import { verdictAssessment, withLocalArtifactDownload } from "./helpers.ts";
import {
	readFileSync,
	rmSync,
	statSync,
	mkdirSync,
	writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { fieldOf, objectOf, parseJson } from "../server/sandbox/json.ts";
import { EXE_DEV_PLATFORM } from "../src/platform.ts";

const sha = "a".repeat(40);
const repo = "nublai/pi-herdr-factorio";

if (!isGitSha(sha) || !isRepoSlug(repo)) throw new Error("fixture");

const pin: AdmissionPin = {
	runId: digestOf("run"),
	repo,
	issue: 42,
	originalBase: sha,
	workflowSha: sha,
	workflowDigest: digestOf("workflow"),
	contractDigest: digestOf("contract"),
	acceptanceDigest: digestOf("suite"),
	maxTokens: TRUSTED_RUN_CAP,
	maxReviewAttempts: 3,
};

const patch: PatchReceipt = {
	version: 1,
	runId: pin.runId,
	round: 0,
	baseSha: sha,
	contractDigest: pin.contractDigest,
	acceptanceDigest: pin.acceptanceDigest,
	patchDigest: digestOf("patch"),
	changedPaths: ["src/example.ts"],
	policy: "clean",
	testCommand: "npm test",
	model: "openai/gpt-6.1-sol",
	observed: null,
	commands: [],
	commandsSource: "builder-reported",
	commandsOmitted: 0,
	scriptsChanged: false,
	testScriptChanged: false,
	testInputsChanged: false,
	visibleTests: { command: "npm test", exitCode: 0, tail: "", wallMs: 1 },
};

function handoffCandidate(state: CandidateState, event: CandidateEvent) {
	const direct = reduceCandidate(state, event);

	const run: Run = {
		id: state.pin.runId,
		ticket: {
			provider: "github",
			key: `${state.pin.repo}#${state.pin.issue}`,
			url: `https://github.com/${state.pin.repo}/issues/${state.pin.issue}`,
		},
		repo: state.pin.repo,
		baseSha: state.pin.originalBase,
		handoff: state,
		progress: candidateProjection(state).progress,
	};

	const publicStep = advance(run, { kind: "candidate", event });
	assert.equal(publicStep.kind, "advanced");
	assert.deepEqual(publicStep.run.handoff, direct.state);
	assert.deepEqual(
		publicStep.run.progress,
		candidateProjection(direct.state).progress,
	);
	assert.deepEqual(publicStep.effect, direct.effect);

	return direct;
}

function observed(main = sha): Extract<CandidateEvent, { kind: "observed" }> {
	if (!isGitSha(main)) throw new Error("fixture");

	return {
		kind: "observed",
		now: 100,
		main,
		pr: { kind: "none" },
		executionAllowed: true,
		capacityAvailable: true,
		eligibility: "ready",
		readiness: { kind: "unavailable" },
	};
}

function select(): CandidateState {
	return handoffCandidate(beginCandidate(pin, patch, 1234), observed()).state;
}

test("initial generation captures main before publication and retains pre-candidate usage", () => {
	const state = select();
	assert.equal(state.kind, "selected");
	assert.equal(state.current.intent.baseSha, sha);
	assert.equal(state.current.intent.generation, 0);
	assert.equal(candidateUsage(state), 1234);
	assert.equal(state.work.kind, "effect");

	if (state.work.kind === "effect")
		assert.equal(state.work.request.kind, "validate");
});

test("missing main cannot invent an initial certified base", () => {
	const state = beginCandidate(pin, patch, 1234);
	assert.deepEqual(
		handoffCandidate(state, { ...observed(), main: null }).state,
		state,
	);
});

test("withdrawal before candidate selection finishes without publishing", () => {
	const state = beginCandidate(pin, patch, 1234);

	const step = handoffCandidate(state, {
		...observed(),
		main: null,
		executionAllowed: false,
		eligibility: "withdrawn",
	});

	assert.equal(step.effect?.kind, "finish_pr");

	if (step.effect?.kind === "finish_pr")
		assert.equal(step.effect.terminal.kind, "released");
});

test("switch-off holds without issuing publication effects", () => {
	const state = beginCandidate(pin, patch, 1234);

	const result = handoffCandidate(state, {
		...observed(),
		executionAllowed: false,
	});

	assert.deepEqual(result.state, state);
	assert.equal(result.effect, null);
});

test("generation intent and nested patch evidence are immutable owned snapshots", () => {
	const mutable = {
		...patch,
		changedPaths: [...patch.changedPaths],
		commands: [...patch.commands],
	};

	const state = beginCandidate(pin, mutable, 0);
	mutable.changedPaths.push("src/other.ts");
	assert.deepEqual(state.patch.changedPaths, ["src/example.ts"]);
	assert.ok(Object.isFrozen(state.patch.changedPaths));

	const intent = generationIntent({
		pin,
		patch,
		round: 0,
		generation: 0,
		baseSha: sha,
		origin: { kind: "initial" },
		publication: { kind: "initial" },
	});

	assert.equal(
		intent.digest,
		digestOf(JSON.stringify({ ...intent, digest: undefined })),
	);
});

function selected(
	state: CandidateState,
): Extract<CandidateState, { kind: "selected" }> {
	assert.equal(state.kind, "selected");

	return state;
}

function pending<K extends CandidateEffect["kind"]>(
	state: CandidateState,
	kind: K,
): Extract<CandidateEffect, { kind: K }> {
	const current = selected(state);
	assert.equal(current.work.kind, "effect");
	assert.equal(current.work.request.kind, kind);

	// SAFETY: the request discriminant is asserted above and Extract selects exactly that variant.
	return current.work.request as Extract<CandidateEffect, { kind: K }>;
}

function validated(
	state: CandidateState,
	passes = true,
	failure?: import("../src/diagnosis.ts").FailureClass,
	tamper?: (
		read: import("../src/validation.ts").ReadAssessment,
	) => import("../src/validation.ts").ReadAssessment,
	now?: number,
) {
	const request = pending(state, "validate");
	const g = request.generation;

	const head =
		g.origin.kind === "owner"
			? g.origin.head
			: digestOf(JSON.stringify(g)).slice(0, 40);

	assert.ok(isGitSha(head));

	const validation: ValidationState = {
		version: 2,
		generation: {
			index: g.generation,
			digest: g.digest,
			previousHead:
				g.publication.kind === "successor" ? g.publication.expectedHead : null,
		},
		startedAt: 1,
		deadline: 200,
		round: g.round,
		originalBase: g.originalBase,
		baseSha: g.baseSha,
		baseResolved: true,
		publication: {
			branch: candidateBranch(pin.issue, pin.runId, g.round, g.generation),
			patchSha: head,
			candidateSha: head,
		},
		dispatchTry: 1,
		dispatchedAt: 2,
		ciRunId: 123,
		counters: {},
	};

	const verdict: Verdict = {
		patchDigest: g.patchDigest,
		acceptanceDigest: pin.acceptanceDigest,
		heldoutDigest: digestOf("heldout"),
		candidateSha: head,
		gateSha: g.baseSha,
		ciRunId: 123,
		originalBase: g.originalBase,
		baseSha: g.baseSha,
		pass: passes,
		checks: REQUIRED_CI_CHECKS.map((name) => ({
			name,
			passed: passes || name !== "heldout",
		})),
		requiredChecks: [...REQUIRED_CI_CHECKS],
		unjudged: [],
	};

	const report: TrustedReport = {
		candidateSha: head,
		gateSha: g.baseSha,
		ciRunId: 123,
		reportId: 456,
		nonce: dispatchNonce(pin.runId, g.round, 1, g.generation),
		heldoutDigest: verdict.heldoutDigest,
		externalId: `factory-gates:123:${dispatchNonce(pin.runId, g.round, 1, g.generation)}`,
	};

	return selected(
		handoffCandidate(state, {
			kind: "effect_completed",
			now,
			completion: {
				kind: "validate",
				request,
				result: {
					kind: "finished",
					validation,
					verdict,
					report,
					seats: ["code-review", "security-review", "simplify"],
					assessment: (tamper ?? ((read) => read))(
						verdictAssessment(
							pin.runId,
							g.round,
							g.generation,
							verdict,
							failure,
						),
					),
				},
			},
		}).state,
	);
}

function reviewing(state: CandidateState) {
	const current = selected(state);
	let observation = observed(current.current.intent.baseSha);

	if (current.published !== null) {
		const head = current.history.find(
			(g) => g.intent.digest === current.published?.promoted.digest,
		)?.report?.candidateSha;

		assert.ok(head);
		observation = {
			...observation,
			pr: {
				kind: "open",
				number: current.published.number,
				head,
				refHead: head,
			},
		};
	}

	const issued = handoffCandidate(current, observation).state;

	const request = pending(issued, "launch_review");

	return {
		execution: request.execution,
		state: selected(
			handoffCandidate(issued, {
				kind: "effect_completed",
				completion: { kind: "launch_review", request, started: true },
			}).state,
		),
	};
}

function receipt(e: ReviewExecution): ReviewReceipt {
	return {
		...e.binding,
		version: 2,
		r8: "incomplete",
		blocking: false,
		seats: e.seats.map((seat) => ({
			seat,
			findings: [],
			judgments: [],
			requested: "openai/gpt-6.1-sol",
			observed: null,
			label: "context-isolated, same model, same family, not cross-family",
			fallback: false,
			tokens: 10,
		})),
	};
}

function blockingReceipt(e: ReviewExecution): ReviewReceipt {
	const r = receipt(e);

	return {
		...r,
		blocking: true,
		seats: r.seats.map((seat, i) =>
			i === 0
				? {
						...seat,
						judgments: [
							{ scenario: "S1", outcome: "fail", reason: "missing guard" },
						],
					}
				: seat,
		),
	};
}

function certified(state: CandidateState, tokens = 100) {
	const review = reviewing(validated(state));

	return selected(
		handoffCandidate(review.state, {
			kind: "review_settled",
			execution: review.execution,
			tokens,
			result: {
				kind: "passed",
				review: receipt(review.execution),
				patch: { kind: "found", receipt: patch, patch: "patch" },
			},
		}).state,
	);
}

function readyObservation(
	state: CandidateState,
): Extract<CandidateEvent, { kind: "observed" }> {
	const current = selected(state);
	const report = current.current.report;
	assert.ok(report);

	return {
		...observed(current.current.intent.baseSha),
		pr:
			current.published === null
				? { kind: "none" }
				: {
						kind: "open",
						number: current.published.number,
						head: report.candidateSha,
						refHead: report.candidateSha,
					},
		readiness: { kind: "current", head: report.candidateSha, report },
	};
}

function published(state = certified(select())) {
	const request = pending(
		handoffCandidate(state, readyObservation(state)).state,
		"open_pr",
	);

	return selected(
		handoffCandidate(
			state.work.kind === "effect"
				? state
				: handoffCandidate(state, readyObservation(state)).state,
			{
				kind: "effect_completed",
				completion: {
					kind: "open_pr",
					request,
					number: 5,
					head: request.head,
					refHead: request.head,
				},
			},
		).state,
	);
}

function ownerObservation(state = waiting(), head = "b".repeat(40)) {
	assert.ok(isGitSha(head));

	return {
		...readyObservation(state),
		now: 200,
		pr: { kind: "open", number: 5, head, refHead: head },
	} as const;
}

function ownerSelected() {
	const start = waiting();
	const noticeState = handoffCandidate(start, ownerObservation(start)).state;
	const notice = pending(noticeState, "post_notice");
	assert.equal(notice.notice.kind, "owner_head");
	assert.equal(notice.withdraw, "owner_head");
	assert.ok(notice.notice.key.includes("b".repeat(40)));

	const due = handoffCandidate(noticeState, {
		kind: "effect_completed",
		now: 200,
		completion: { kind: "post_notice", request: notice },
	}).state;

	const deriving = handoffCandidate(due, ownerObservation(start)).state;
	const request = pending(deriving, "derive_owner_patch");

	const receipt: OwnerPatchReceipt = {
		version: 1,
		kind: "owner",
		runId: pin.runId,
		head: request.head,
		baseSha: request.baseSha,
		contractDigest: pin.contractDigest,
		acceptanceDigest: pin.acceptanceDigest,
		heldoutDigest: digestOf("heldout"),
		patchDigest: digestOf("owner patch"),
		changedPaths: ["src/example.ts"],
		policy: "clean",
	};

	const state = selected(
		handoffCandidate(deriving, {
			kind: "effect_completed",
			completion: {
				kind: "derive_owner_patch",
				request,
				result: { kind: "found", patch: receipt },
			},
		}).state,
	);

	return { state, receipt, deriving, request, start, due, notice };
}

test("F10-3 drift withdraws once per head before spend, stable holds, and reset resumes", () => {
	const f = ownerSelected();
	assert.equal(f.state.current.intent.origin.kind, "owner");
	assert.equal(f.state.current.intent.publication.kind, "owner");
	assert.equal(f.state.current.intent.generation, 1);
	assert.deepEqual(f.state.current.ownerPatch, f.receipt);
	assert.equal(candidateUsage(f.state), candidateUsage(f.start));
	assert.ok(parseCandidateState(JSON.parse(JSON.stringify(f.state))));
	const missing = JSON.parse(JSON.stringify(f.state));
	delete missing.current.ownerPatch;
	assert.equal(parseCandidateState(missing), null);

	for (const reason of [
		"heldout_changed",
		"forbidden_path",
		"behind_main",
		"too_large",
	] as const) {
		const stopped = handoffCandidate(f.deriving, {
			kind: "effect_completed",
			now: 300,
			completion: {
				kind: "derive_owner_patch",
				request: f.request,
				result: { kind: "refused", reason },
			},
		}).state;

		const notice = pending(stopped, "post_notice");
		assert.equal(notice.notice.kind, "owner_head_failed");

		const held = selected(
			handoffCandidate(stopped, {
				kind: "effect_completed",
				now: 300,
				completion: { kind: "post_notice", request: notice },
			}).state,
		);

		assert.deepEqual(held.work, {
			kind: "held",
			reason: "owner_head_refused",
			since: 300,
		});
		assert.deepEqual(
			selected(
				handoffCandidate(held, { ...ownerObservation(f.start), now: 400 })
					.state,
			).work,
			held.work,
		);
		assert.equal(
			pending(
				handoffCandidate(held, ownerObservation(f.start, "d".repeat(40))).state,
				"post_notice",
			).notice.kind,
			"owner_head",
		);
		assert.equal(
			pending(
				handoffCandidate(held, readyObservation(f.start)).state,
				"complete_handoff",
			).head,
			f.start.current.report!.candidateSha,
		);
	}

	const legacy = JSON.parse(JSON.stringify(f.start));
	delete legacy.published.ownerHead;
	assert.ok(parseCandidateState(legacy));
});

test("a refused owner head whose base lags main keeps its notice (lane 8)", () => {
	const start = waiting();
	const moved = "d".repeat(40);
	assert.ok(isGitSha(moved));
	assert.notEqual(moved, start.current.intent.baseSha);
	const obs = { ...ownerObservation(start), main: moved };
	const noticeState = handoffCandidate(start, obs).state;
	const notice = pending(noticeState, "post_notice");

	const due = handoffCandidate(noticeState, {
		kind: "effect_completed",
		now: 200,
		completion: { kind: "post_notice", request: notice },
	}).state;

	const deriving = handoffCandidate(due, obs).state;
	const request = pending(deriving, "derive_owner_patch");
	assert.equal(request.baseSha, moved);

	const stopped = handoffCandidate(deriving, {
		kind: "effect_completed",
		now: 300,
		completion: {
			kind: "derive_owner_patch",
			request,
			result: { kind: "refused", reason: "behind_main" },
		},
	}).state;

	assert.equal(pending(stopped, "post_notice").detail, "owner_head_refused");

	const next = handoffCandidate(stopped, { ...obs, now: 400 }).state;
	const refusal = pending(next, "post_notice");
	assert.equal(refusal.detail, "owner_head_refused");
	assert.equal(refusal.refusal, "behind_main");

	const held = selected(
		handoffCandidate(next, {
			kind: "effect_completed",
			now: 500,
			completion: { kind: "post_notice", request: refusal },
		}).state,
	);

	assert.deepEqual(held.work, {
		kind: "held",
		reason: "owner_head_refused",
		since: 300,
	});
	assert.partialDeepStrictEqual(held.published?.readiness, {
		kind: "not_ready",
		reason: "owner_head_refused",
	});
	assert.deepEqual(
		selected(handoffCandidate(held, { ...obs, now: 600 }).state).work,
		held.work,
	);
});

for (const [kind, make] of [
	[
		"owner_head",
		() => {
			const state = waiting();

			return handoffCandidate(state, ownerObservation(state)).state;
		},
	],
	["owner_head_failed", () => validated(ownerSelected().state, false)],
	[
		"checks_failed",
		() => {
			const state = waiting();

			return handoffCandidate(state, {
				...readyObservation(state),
				readiness: { kind: "not_ready", reason: "checks_failed" },
			}).state;
		},
	],
	[
		"feedback_intake",
		() => {
			const state = waiting();

			return handoffCandidate(state, withFeedback(state)).state;
		},
	],
	[
		"feedback_overflow",
		() => {
			const state = waiting();
			const feedback = feedbackObservation(state);
			assert.ok(feedback.kind === "read" && feedback.batch);

			return handoffCandidate(state, {
				...readyObservation(state),
				feedback: { ...feedback, batch: { ...feedback.batch, overflow: true } },
			}).state;
		},
	],
	[
		"repair_started",
		() => {
			const state = queuedFeedback();

			return handoffCandidate(state, readyObservation(state)).state;
		},
	],
	[
		"repair_unavailable",
		() => {
			const initial = queuedFeedback();

			const { assessment: _assessment, ...current } = initial.current;
			const state = { ...initial, current };

			return handoffCandidate(state, readyObservation(state)).state;
		},
	],
	[
		"round_summary",
		() => {
			const build = rebuildingFeedback();

			return handoffCandidate(build.state, {
				kind: "repair_settled",
				execution: build.execution,
				tokens: 10,
				result: { kind: "no_change" },
				now: 300,
			}).state;
		},
	],
] as const)
	test(`main movement preserves pending ${kind} until completion`, () => {
		const state = selected(make());
		const request = pending(state, "post_notice");
		assert.equal(request.notice.kind, kind);
		const main = "d".repeat(40);
		assert.ok(isGitSha(main));
		assert.notEqual(main, state.current.intent.baseSha);

		const obs = {
			...(kind === "owner_head" || kind === "owner_head_failed"
				? ownerObservation(waiting())
				: readyObservation(waiting())),
			main,
			now: 400,
		};

		const restored = parseCandidateState(JSON.parse(JSON.stringify(state)));
		assert.ok(restored);
		const next = handoffCandidate(restored, obs);
		assert.deepEqual(next.effect, request);
		assert.deepEqual(next.state, state);
		assert.deepEqual(handoffCandidate(next.state, obs), next);

		const done = selected(
			handoffCandidate(next.state, {
				kind: "effect_completed",
				now: 500,
				completion: { kind: "post_notice", request },
			}).state,
		);

		assert.notEqual(done.work.kind, "effect");
		assert.deepEqual(done.accounts, state.accounts);

		if (request.then.kind === "held")
			assert.partialDeepStrictEqual(done.work, {
				kind: "held",
				reason: request.then.reason,
			});
		else if (request.then.kind === "resume")
			assert.deepEqual(done.work, request.then.work);
		else assert.equal(done.work.kind, request.then.kind);

		if (kind === "feedback_intake")
			assert.equal(done.feedback?.batches[0]?.notice, "posted");

		if (kind === "feedback_overflow")
			assert.equal(done.feedback?.overflow?.notice, "posted");
	});

test("main movement preserves pending readiness withdrawal until completion", () => {
	const initial = waiting();

	const state = handoffCandidate(initial, {
		...readyObservation(initial),
		readiness: { kind: "not_ready", reason: "checks_incomplete" },
	}).state;

	const request = pending(state, "void_readiness");
	const main = "d".repeat(40);
	assert.ok(isGitSha(main));
	const next = handoffCandidate(state, { ...readyObservation(initial), main });
	assert.deepEqual(next.effect, request);

	const done = selected(
		handoffCandidate(next.state, {
			kind: "effect_completed",
			completion: { kind: "void_readiness", request },
		}).state,
	);

	assert.partialDeepStrictEqual(done.work, {
		kind: "held",
		reason: "checks_incomplete",
	});
});

test("F10-3 owner certification, readiness and truthful merge authorship", () => {
	const f = ownerSelected();
	const validatedOwner = validated(f.state);

	const issued = handoffCandidate(
		validatedOwner,
		ownerObservation(f.start),
	).state;

	const launch = pending(issued, "launch_review");

	const running = handoffCandidate(issued, {
		kind: "effect_completed",
		completion: { kind: "launch_review", request: launch, started: true },
	}).state;

	const baseReview = receipt(launch.execution);

	const review: ReviewReceipt = {
		...baseReview,
		version: 3,
		builder: { kind: "unavailable", reason: "missing" },
		accept: { kind: "unavailable", reason: "missing" },
		seats: baseReview.seats.map((s) => ({
			...s,
			family: { kind: "unavailable", reason: "missing" },
			label: "context-isolated, unknown family, not cross-family",
		})),
	};

	const ownerPatch = {
		kind: "found" as const,
		receipt: f.receipt,
		patch: "owner patch",
	};

	const args = {
		pin,
		generation: f.state.current.intent,
		execution: launch.execution,
		patch: ownerPatch,
		verdict: validatedOwner.current.verdict!,
		review,
		report: validatedOwner.current.report!,
	};

	assert.doesNotThrow(() => certifyGeneration(args));
	assert.throws(
		() =>
			certifyGeneration({
				...args,
				review: {
					...review,
					builder: { kind: "openai-request", model: "openai/gpt-6.1-sol" },
				},
			}),
		/certification_binding/,
	);

	for (const receipt of [
		{ ...f.receipt, patchDigest: digestOf("wrong") },
		{ ...f.receipt, head: sha },
		{ ...f.receipt, heldoutDigest: digestOf("wrong suite") },
		{ ...f.receipt, changedPaths: ["test/acceptance/x.ts"] },
	])
		assert.throws(
			() => certifyGeneration({ ...args, patch: { ...ownerPatch, receipt } }),
			/certification_binding/,
		);

	const done = selected(
		handoffCandidate(running, {
			kind: "review_settled",
			execution: launch.execution,
			tokens: 20,
			result: { kind: "passed", review, patch: ownerPatch },
		}).state,
	);

	const completing = handoffCandidate(done, readyObservation(done)).state;
	const complete = pending(completing, "complete_handoff");

	const resetBeforeCompletion = handoffCandidate(
		completing,
		readyObservation(f.start),
	).state;

	assert.equal(
		pending(resetBeforeCompletion, "complete_handoff").head,
		f.start.current.report!.candidateSha,
	);

	const ready = selected(
		handoffCandidate(completing, {
			kind: "effect_completed",
			completion: { kind: "complete_handoff", request: complete, now: 400 },
		}).state,
	);

	assert.equal(ready.published?.readiness.kind, "ready");
	assert.equal(authoredOf(ready, ready.current.intent), "owner");
	assert.ok(parseCandidateState(JSON.parse(JSON.stringify(ready))));

	const intake = selected(
		handoffCandidate(ready, {
			...readyObservation(ready),
			feedback: feedbackObservation(ready),
		}).state,
	);

	const intakeNotice = pending(intake, "post_notice");
	assert.equal(intakeNotice.notice.kind, "feedback_intake");

	const boundary = handoffCandidate(intake, {
		kind: "effect_completed",
		completion: { kind: "post_notice", request: intakeNotice },
	}).state;

	const feedback = selected(
		handoffCandidate(boundary, readyObservation(ready)).state,
	);

	assert.equal(
		pending(feedback, "post_notice").notice.kind,
		"repair_unavailable",
	);
	assert.deepEqual(feedback.feedback?.batches[0]?.status, {
		kind: "settled",
		outcome: { kind: "refused", reason: "owner_authored_head" },
	});
	assert.equal(candidateUsage(feedback), candidateUsage(ready));

	const failedMerge = pending(
		handoffCandidate(f.state, {
			...ownerObservation(f.start),
			pr: {
				kind: "merged",
				number: 5,
				head: f.receipt.head,
				mergeSha: sha,
				actor: "owner",
			},
		}).state,
		"finish_pr",
	);

	assert.ok(
		failedMerge.terminal.kind === "merged" &&
			failedMerge.terminal.assurance.kind === "owner_override",
	);

	const merge = pending(
		handoffCandidate(ready, {
			...ownerObservation(f.start),
			pr: {
				kind: "merged",
				number: 5,
				head: f.receipt.head,
				mergeSha: sha,
				actor: "owner",
			},
		}).state,
		"finish_pr",
	);

	assert.ok(
		merge.terminal.kind === "merged" &&
			merge.terminal.assurance.kind === "factory_verified",
	);
	assert.equal(
		authoredOf(ready, merge.terminal.assurance.certification),
		"owner",
	);

	const main = "d".repeat(40);
	assert.ok(isGitSha(main));

	for (const current of [f.state, validatedOwner, running, ready]) {
		const behind: CandidateState = handoffCandidate(current, {
			...ownerObservation(f.start),
			main,
		}).state;

		const request: CandidateEffect = pending(
			behind,
			current === running ? "stop_execution" : "post_notice",
		);

		assert.ok(
			request.kind !== "post_notice" ||
				(request.then.kind === "held" &&
					request.then.reason === "owner_head_behind"),
		);
	}
});

test("F10-3 reset after owner validation failure restores the historical certificate without losing history or charges", () => {
	const f = ownerSelected();
	const failing = validated(f.state, false);
	const notice = pending(failing, "post_notice");

	const held = selected(
		handoffCandidate(failing, {
			kind: "effect_completed",
			completion: { kind: "post_notice", request: notice },
		}).state,
	);

	const resetting = handoffCandidate(held, readyObservation(f.start)).state;
	const complete = pending(resetting, "complete_handoff");
	assert.equal(complete.certification.digest, f.start.current.intent.digest);

	const ready = selected(
		handoffCandidate(resetting, {
			kind: "effect_completed",
			completion: { kind: "complete_handoff", request: complete, now: 500 },
		}).state,
	);

	assert.equal(ready.published?.readiness.kind, "ready");
	assert.deepEqual(ready.current, f.start.current);
	assert.deepEqual(ready.history, [held.current]);
	assert.equal(candidateUsage(ready), candidateUsage(held));
	assert.equal(handoffCandidate(ready, readyObservation(f.start)).effect, null);

	const repush = handoffCandidate(ready, ownerObservation(f.start)).state;
	const renotice = pending(repush, "post_notice");

	const redue = handoffCandidate(repush, {
		kind: "effect_completed",
		completion: { kind: "post_notice", request: renotice },
	}).state;

	const rederive = handoffCandidate(redue, ownerObservation(f.start)).state;
	const request = pending(rederive, "derive_owner_patch");

	const selectedAgain = handoffCandidate(rederive, {
		kind: "effect_completed",
		completion: {
			kind: "derive_owner_patch",
			request,
			result: { kind: "found", patch: f.receipt },
		},
	}).state;

	assert.equal(selected(selectedAgain).current.intent.generation, 2);
	assert.ok(parseCandidateState(JSON.parse(JSON.stringify(selectedAgain))));
	assert.equal(
		pending(
			handoffCandidate(ready, ownerObservation(f.start)).state,
			"post_notice",
		).notice.kind,
		"owner_head",
	);
	assert.ok(parseCandidateState(JSON.parse(JSON.stringify(ready))));

	const failedCheck: Extract<CandidateEvent, { kind: "observed" }> = {
		...readyObservation(f.start),
		now: 600,
		readiness: { kind: "not_ready", reason: "checks_failed" },
	};

	const withdrawing = handoffCandidate(ready, failedCheck).state;
	const checkNotice = pending(withdrawing, "post_notice");

	const checkHeld = selected(
		handoffCandidate(withdrawing, {
			kind: "effect_completed",
			now: 700,
			completion: { kind: "post_notice", request: checkNotice },
		}).state,
	);

	const repeated = handoffCandidate(checkHeld, { ...failedCheck, now: 900 });
	assert.equal(repeated.effect, null);
	assert.deepEqual(selected(repeated.state).work, {
		kind: "held",
		reason: "checks_failed",
		since: 600,
	});
});

test("F10-3 resetting a running owner review stops and charges it before restoring the historical head", () => {
	const f = ownerSelected();
	const due = validated(f.state);
	const issued = handoffCandidate(due, ownerObservation(f.start)).state;
	const launch = pending(issued, "launch_review");

	const running = handoffCandidate(issued, {
		kind: "effect_completed",
		completion: { kind: "launch_review", request: launch, started: true },
	}).state;

	const stopping = handoffCandidate(running, readyObservation(f.start)).state;
	const stop = pending(stopping, "stop_execution");

	const charged = handoffCandidate(stopping, {
		kind: "effect_completed",
		completion: {
			kind: "stop_execution",
			request: stop,
			tokens: 13,
			stopped: true,
		},
	}).state;

	const resetting = handoffCandidate(charged, readyObservation(f.start)).state;
	assert.equal(
		pending(resetting, "complete_handoff").head,
		f.start.current.report!.candidateSha,
	);
	assert.equal(candidateUsage(resetting), candidateUsage(f.start) + 13);
	const main = "d".repeat(40);
	assert.ok(isGitSha(main));

	const refresh = pending(
		handoffCandidate(resetting, { ...readyObservation(f.start), main }).state,
		"validate",
	);

	assert.equal(refresh.generation.origin.kind, "refresh");
	assert.equal(refresh.generation.generation, 2);
});

test("F10-3 failing gates and failed or blocking review hold with one head notice", () => {
	const f = ownerSelected();
	assert.equal(
		pending(validated(f.state, false), "post_notice").notice.kind,
		"owner_head_failed",
	);
	const v = validated(f.state);
	const issued = handoffCandidate(v, ownerObservation(f.start)).state;
	const request = pending(issued, "launch_review");

	for (const result of [
		{ kind: "failed" } as const,
		{
			kind: "passed",
			review: blockingReceipt(request.execution),
			patch: { kind: "found", receipt: f.receipt, patch: "owner patch" },
		} as const,
	]) {
		const stopped = handoffCandidate(issued, {
			kind: "review_settled",
			execution: request.execution,
			tokens: 20,
			result,
		}).state;

		assert.equal(pending(stopped, "post_notice").then.kind, "held");
	}

	const check = handoffCandidate(f.start, {
		...readyObservation(f.start),
		readiness: { kind: "not_ready", reason: "checks_failed" },
	}).state;

	const notice = pending(check, "post_notice");
	assert.equal(notice.notice.kind, "checks_failed");

	const held = handoffCandidate(check, {
		kind: "effect_completed",
		completion: { kind: "post_notice", request: notice },
	}).state;

	assert.equal(
		handoffCandidate(held, {
			...readyObservation(f.start),
			readiness: { kind: "not_ready", reason: "checks_failed" },
		}).effect,
		null,
	);
});

test("F10-3 reset feedback repairs the restored factory generation (review R1)", () => {
	const f = ownerSelected();
	const failed = validated(f.state, false);
	const notice = pending(failed, "post_notice");

	const held = handoffCandidate(failed, {
		kind: "effect_completed",
		completion: { kind: "post_notice", request: notice },
	}).state;

	const resetting = handoffCandidate(held, readyObservation(f.start)).state;
	const complete = pending(resetting, "complete_handoff");

	const ready = handoffCandidate(resetting, {
		kind: "effect_completed",
		completion: { kind: "complete_handoff", request: complete, now: 500 },
	}).state;

	const intake = handoffCandidate(ready, {
		...readyObservation(f.start),
		feedback: feedbackObservation(ready),
	}).state;

	const intakeNotice = pending(intake, "post_notice");

	const boundary = handoffCandidate(intake, {
		kind: "effect_completed",
		completion: { kind: "post_notice", request: intakeNotice },
	}).state;

	const repair = handoffCandidate(boundary, readyObservation(f.start)).state;
	const started = pending(repair, "post_notice");
	assert.equal(started.notice.kind, "repair_started");
	assert.ok(started.then.kind === "repair_due");
	assert.equal(started.then.feedbackFrom.digest, f.start.current.intent.digest);
	assert.deepEqual(started.then.cause, {
		kind: "feedback",
		batch: selected(repair).feedback!.batches[0]!.digest,
		assessment: f.start.current.assessment,
		review: null,
	});

	const due = handoffCandidate(repair, {
		kind: "effect_completed",
		completion: { kind: "post_notice", request: started },
	}).state;

	const build = pending(
		handoffCandidate(due, readyObservation(f.start)).state,
		"repair_build",
	);

	assert.equal(
		build.execution.feedbackFrom.digest,
		f.start.current.intent.digest,
	);
	assert.equal(candidateUsage(due), candidateUsage(held));
	assert.ok(parseCandidateState(JSON.parse(JSON.stringify(due))));
});

test("F10-3 reset before derivation skips the abandoned head without CI or failure (review R2)", () => {
	const f = ownerSelected();
	const reset = handoffCandidate(f.due, readyObservation(f.start));

	assert.equal(reset.effect?.kind, "complete_handoff");
	assert.equal(
		selected(reset.state).current.intent.digest,
		f.start.current.intent.digest,
	);
	assert.equal(candidateUsage(reset.state), candidateUsage(f.start));

	const other = handoffCandidate(
		f.due,
		ownerObservation(f.start, "d".repeat(40)),
	);

	assert.equal(pending(other.state, "post_notice").notice.kind, "owner_head");
});

test("F10-3 notices distinguish refusal, failed gates and behind for the same head (review R3)", async () => {
	const f = ownerSelected();

	const refused = handoffCandidate(f.deriving, {
		kind: "effect_completed",
		completion: {
			kind: "derive_owner_patch",
			request: f.request,
			result: { kind: "refused", reason: "forbidden_path" },
		},
	}).state;

	const behindMain = handoffCandidate(f.deriving, {
		kind: "effect_completed",
		completion: {
			kind: "derive_owner_patch",
			request: f.request,
			result: { kind: "refused", reason: "behind_main" },
		},
	}).state;

	const failed = validated(f.state, false);
	const moved = "d".repeat(40);
	assert.ok(isGitSha(moved));

	const actualBehind = handoffCandidate(f.state, {
		...ownerObservation(f.start),
		main: moved,
	}).state;

	const notices = [refused, failed, actualBehind, behindMain].map((s) =>
		pending(s, "post_notice"),
	);

	assert.equal(new Set(notices.map((n) => n.notice.key)).size, 4);

	for (const s of [refused, failed, actualBehind, behindMain]) {
		assert.ok(parseCandidateState(JSON.parse(JSON.stringify(s))));
		const legacy = JSON.parse(JSON.stringify(s));
		legacy.work.request.notice.key = `<!-- factory:notice ${pin.runId} owner_head_failed ${f.receipt.head} -->`;
		assert.ok(parseCandidateState(legacy));
	}

	await withLocalArtifactDownload(async (root) => {
		const github = new FakeGitHub();
		const issue = github.add(fakeIssue(pin.issue));
		github.add(fakeIssue(5));

		for (const state of [refused, failed, actualBehind, behindMain]) {
			const request = pending(state, "post_notice");

			for (let replay = 0; replay < 2; replay++) {
				const completion = await controllerCandidatePort({
					platform: EXE_DEV_PLATFORM,
					stateDir: root,
					exec: github.exec,
				}).execute(state, request);

				assert.equal(completion?.kind, "post_notice");
			}
		}

		assert.equal(issue.comments.length, 4);
		assert.match(
			issue.comments[0]!.body,
			/owner_head_refused \(forbidden_path\)/,
		);
		assert.match(issue.comments[1]!.body, /owner_head_failed/);
		assert.match(issue.comments[2]!.body, /Main moved/);
		assert.match(issue.comments[3]!.body, /owner_head_refused \(behind_main\)/);
		assert.match(issue.comments[3]!.body, /Please update the branch with main/);

		for (const comment of issue.comments)
			assert.ok(comment.body.includes(`Head: ${f.receipt.head}`));
	});
});

test("F10-3 unreadable derivation retries on later ticks, survives restart and stops visibly (review R4)", () => {
	const f = ownerSelected();
	let state: CandidateState = f.deriving;

	for (let attempt = 1; attempt <= 3; attempt++) {
		const request = pending(state, "derive_owner_patch");

		state = handoffCandidate(state, {
			kind: "effect_completed",
			completion: {
				kind: "derive_owner_patch",
				request,
				result: { kind: "refused", reason: "unreadable" },
			},
		}).state;

		if (attempt < 3) {
			assert.equal(selected(state).work.kind, "owner_due");

			const restored = parseCandidateState(JSON.parse(JSON.stringify(state)));
			assert.ok(restored);

			state = handoffCandidate(restored, ownerObservation(f.start)).state;
		} else
			assert.equal(pending(state, "post_notice").detail, "owner_head_refused");
	}

	const request = pending(state, "post_notice");

	const held = handoffCandidate(state, {
		kind: "effect_completed",
		completion: { kind: "post_notice", request },
	}).state;

	assert.equal(handoffCandidate(held, ownerObservation(f.start)).effect, null);

	const retry = handoffCandidate(f.deriving, {
		kind: "effect_completed",
		completion: {
			kind: "derive_owner_patch",
			request: f.request,
			result: { kind: "refused", reason: "unreadable" },
		},
	}).state;

	const deriving = handoffCandidate(retry, ownerObservation(f.start)).state;
	const next = pending(deriving, "derive_owner_patch");

	assert.equal(
		pending(
			handoffCandidate(deriving, {
				kind: "effect_completed",
				completion: {
					kind: "derive_owner_patch",
					request: next,
					result: { kind: "found", patch: f.receipt },
				},
			}).state,
			"validate",
		).generation.origin.kind,
		"owner",
	);
});

for (const reason of ["closed", "withdrawn"] as const)
	test(`F10-3 latent owner applying batch still finishes on ${reason} (review R5)`, () => {
		const f = ownerSelected();
		const feedback = queuedFeedback().feedback;

		const state = {
			...f.state,
			work: { kind: "waiting" as const },
			feedback: {
				...feedback,
				batches: feedback.batches.map((b) => ({
					...b,
					status: { kind: "applying" as const, round: 1 as const },
				})),
			},
		};

		const result = handoffCandidate(state, {
			...ownerObservation(f.start),
			...(reason === "closed"
				? { pr: { kind: "closed" as const, number: 5, head: f.receipt.head } }
				: { eligibility: "withdrawn" as const }),
		});

		const summary = pending(result.state, "post_notice");
		assert.equal(summary.notice.kind, "round_summary");
		assert.equal(summary.then.kind, "finish");

		const finishing = handoffCandidate(result.state, {
			kind: "effect_completed",
			completion: { kind: "post_notice", request: summary },
		}).state;

		const finish = pending(finishing, "finish_pr");
		assert.deepEqual(finish.terminal, { kind: "cancelled", number: 5, reason });
	});

test("F10-3 uncertain owner review settlement posts a head-bound hold notice (review R7)", () => {
	const f = ownerSelected();

	const issued = handoffCandidate(
		validated(f.state),
		ownerObservation(f.start),
	).state;

	const launch = pending(issued, "launch_review");

	const result = handoffCandidate(issued, {
		kind: "review_settled",
		execution: launch.execution,
		tokens: null,
		result: { kind: "failed" },
	});

	assert.equal(
		pending(result.state, "post_notice").detail,
		"owner_head_failed",
	);
	assert.equal(selected(result.state).accounts.at(-1)?.settlement, "uncertain");
});

test("F10-3 owner push during rebuilding stops and charges before recertification, never builds again (review R8)", () => {
	const f = rebuildingFeedback();
	const drift = ownerObservation(f.state);
	const stopping = handoffCandidate(f.state, drift).state;
	const stop = pending(stopping, "stop_execution");
	assert.equal(stop.execution.id, f.execution.id);

	const charged = handoffCandidate(stopping, {
		kind: "effect_completed",
		completion: {
			kind: "stop_execution",
			request: stop,
			tokens: 17,
			stopped: true,
		},
	}).state;

	const noticeState = handoffCandidate(charged, drift).state;
	const notice = pending(noticeState, "post_notice");

	assert.equal(notice.notice.kind, "owner_head");

	const due = handoffCandidate(noticeState, {
		kind: "effect_completed",
		completion: { kind: "post_notice", request: notice },
	}).state;

	assert.equal(
		pending(handoffCandidate(due, drift).state, "derive_owner_patch").head,
		drift.pr.head,
	);
	assert.equal(candidateUsage(due), candidateUsage(f.state) + 17);
	assert.equal(selected(due).feedback?.batches[0]?.status.kind, "settled");
});

test("F10-3 drift during effects waits, generation three refuses before derivation", () => {
	const f = ownerSelected();
	assert.deepEqual(
		handoffCandidate(f.state, ownerObservation(f.start, "d".repeat(40))).state,
		f.state,
	);

	const capped = {
		...f.start,
		current: {
			...f.start.current,
			intent: { ...f.start.current.intent, generation: 3 as const },
		},
	};

	const n = handoffCandidate(capped, ownerObservation(f.start)).state;
	const notice = pending(n, "post_notice");

	const due = handoffCandidate(n, {
		kind: "effect_completed",
		completion: { kind: "post_notice", request: notice },
	}).state;

	const held = selected(handoffCandidate(due, ownerObservation(f.start)).state);
	assert.equal(held.work.kind, "held");
	assert.ok(held.work.kind === "held" && held.work.reason === "refresh_limit");
});

function waiting() {
	const state = published();
	const completing = handoffCandidate(state, readyObservation(state)).state;
	const request = pending(completing, "complete_handoff");

	return selected(
		handoffCandidate(completing, {
			kind: "effect_completed",
			completion: { kind: "complete_handoff", request, now: 100 },
		}).state,
	);
}

for (const reason of ["pr_identity", "pr_ambiguous"] as const)
	for (const hasPr of [false, true])
		test(`owner hold ${reason} persists without retry or refresh (published=${hasPr})`, () => {
			const state = hasPr ? published() : certified(select());
			const issued = handoffCandidate(state, readyObservation(state)).state;

			const held = selected(
				handoffCandidate(issued, {
					kind: "effect_held",
					reason,
					now: 200,
				}).state,
			);

			assert.deepEqual(held.work, { kind: "held", reason, since: 200 });

			if (hasPr)
				assert.deepEqual(held.published?.readiness, {
					kind: "not_ready",
					reason,
					since: 200,
				});

			const restored = parseCandidateState(JSON.parse(JSON.stringify(held)));
			assert.deepEqual(restored, held);
			assert.ok(restored);

			for (const main of [sha, "b".repeat(40)]) {
				const step = handoffCandidate(restored, {
					...readyObservation(restored),
					main: observed(main).main,
					now: 1000,
				});

				assert.deepEqual(step.state, held);
				assert.equal(step.effect, null);
			}

			const withdrawn = handoffCandidate(restored, {
				...readyObservation(restored),
				eligibility: "withdrawn",
			});

			assert.equal(withdrawn.effect?.kind, "finish_pr");

			if (hasPr) {
				const current = selected(restored);
				const head = current.current.report!.candidateSha;

				for (const pr of [
					{ kind: "closed", number: 5, head },
					{ kind: "merged", number: 5, head, mergeSha: sha, actor: null },
				] as const) {
					const step = handoffCandidate(restored, {
						...readyObservation(restored),
						pr,
					});

					assert.equal(step.effect?.kind, "finish_pr");
				}
			}
		});

for (const reason of ["review_input_too_large", "summary_too_large"] as const)
	test(`terminal input reason ${reason} round-trips`, () => {
		const state = certified(select());

		const terminal: CandidateState = {
			...state,
			work: { kind: "terminal", terminal: { kind: "failed", reason } },
		};

		assert.deepEqual(
			parseCandidateState(JSON.parse(JSON.stringify(terminal))),
			terminal,
		);
	});

test("actual observer promotes a certified successor before PR checks and waits for exact-head readiness", async () => {
	await withLocalArtifactDownload(async (root) => {
		const previous = waiting();
		const predecessor = previous.current.report?.candidateSha;
		assert.ok(predecessor);

		const state = certified(
			handoffCandidate(previous, {
				...readyObservation(previous),
				main: observed("b".repeat(40)).main,
			}).state,
		);

		const certificate = state.current.certification;
		assert.ok(certificate);
		const report = certificate.report;
		const head = report.candidateSha;
		const branch = previous.published?.branch;
		assert.ok(branch);
		let prHead = predecessor;
		let refHead = predecessor;
		let reportAvailable = true;
		let reportValid = true;
		const feedbackReads: string[] = [];
		const patches: JsonValue[] = [];

		const factoryCheck = {
			id: report.reportId,
			name: "factory-gates",
			head_sha: head,
			app: { id: 15368 },
			external_id: report.externalId,
			status: "completed",
			conclusion: "success",
		};

		const ordinaryCheck = {
			id: 789,
			name: "check",
			head_sha: head,
			app: { id: 15368 },
			status: "completed",
			conclusion: "success",
		};

		let checks: JsonValue[] = [factoryCheck];
		let missingChecks = 0;

		const record = {
			version: 1,
			status: "passed",
			checkId: report.reportId,
			candidateSha: head,
			gateSha: report.gateSha,
			runId: report.ciRunId,
			nonce: report.nonce,
			workflow: ".github/workflows/ci.yml",
			event: "workflow_dispatch",
			ref: "refs/heads/main",
			actor: CONTROLLER_LOGIN,
			triggeringActor: CONTROLLER_LOGIN,
			externalId: report.externalId,
			heldoutDigest: report.heldoutDigest,
		};

		await fileAdmissionStore(root).record(
			{
				repo: pin.repo,
				issue: pin.issue,
				issueUrl: `https://github.com/${pin.repo}/issues/${pin.issue}`,
				decision: "admitted",
				reasons: [],
				eventId: "700",
				eventAt: "2026-10-30T00:00:00Z",
				actor: "giuseppecrj",
				actorPermission: "admin",
				snapshotDigest: digestOf("snapshot"),
				snapshotSource: "unedited",
				baseSha: pin.workflowSha,
				workflowDigest: pin.workflowDigest,
			},
			{ title: "issue", body: "body" },
		);

		const port = controllerCandidatePort({
			platform: EXE_DEV_PLATFORM,
			stateDir: root,
			exec: async (command, args) => {
				const ok = (value: JsonValue) => ({
					code: 0,
					stdout: JSON.stringify(value),
					stderr: "",
				});

				if (command === "unzip")
					return ok(reportValid ? record : { ...record, checkId: 999 });

				const path = args
					.find((a) => a.startsWith(`repos/${pin.repo}/`))
					?.slice(`repos/${pin.repo}/`.length);

				const method = args[args.indexOf("--method") + 1];

				if (path === "pulls/5")
					return ok({
						number: 5,
						head: { sha: prHead, ref: branch, repo: { full_name: pin.repo } },
						base: { ref: "main", repo: { full_name: pin.repo } },
						user: { login: CONTROLLER_LOGIN, type: "Bot" },
						body: `<!-- factory:pr ${pin.runId} -->`,
						state: "open",
						merged: false,
						draft: false,
					});

				if (path?.startsWith("issues/5/comments")) {
					feedbackReads.push(path);

					return ok([]);
				}

				if (path?.startsWith("pulls/5/reviews/8/comments")) {
					feedbackReads.push(path);

					return ok([]);
				}

				if (path?.startsWith("pulls/5/reviews")) {
					feedbackReads.push(path);

					return ok(
						prHead === head
							? [
									{
										id: 8,
										state: "CHANGES_REQUESTED",
										commit_id: head,
										body: "Fix on the new head",
										submitted_at: "2026-11-07T00:00:00Z",
										user: { login: "writer" },
									},
								]
							: [],
					);
				}

				if (path === "collaborators/writer/permission")
					return ok({ permission: "write", user: { login: "writer" } });

				if (path === `git/ref/heads/${branch}`)
					return ok({ object: { sha: refHead } });

				if (path === `git/refs/heads/${branch}` && method === "PATCH") {
					const input = args[args.indexOf("--input") + 1];
					assert.ok(input);
					const body = parseJson(readFileSync(input, "utf8"));
					assert.equal(fieldOf(objectOf(body), "force"), false);
					assert.equal(fieldOf(objectOf(body), "sha"), head);
					patches.push(body ?? null);
					refHead = head;

					return ok(null);
				}

				if (path === "labels/factory%3Aenabled")
					return ok({ name: "factory:enabled" });

				if (path === `issues/${pin.issue}`)
					return ok({
						number: pin.issue,
						updated_at: "2026-10-30T00:00:00Z",
						title: "issue",
						body: "body",
						state: "open",
						labels: [{ name: "factory:ready" }],
						user: { login: "giuseppecrj" },
					});

				if (path?.startsWith(`issues/${pin.issue}/timeline`))
					return ok([
						{
							id: 700,
							event: "labeled",
							created_at: "2026-10-30T00:00:00Z",
							actor: { login: "giuseppecrj" },
							label: { name: "factory:ready" },
						},
					]);

				if (path === "git/ref/heads/main")
					return ok({ object: { sha: report.gateSha } });

				if (path === `actions/runs/${report.ciRunId}`)
					return ok({
						id: report.ciRunId,
						head_sha: report.gateSha,
						head_branch: "main",
						updated_at: "2026-10-31T00:01:00Z",
						display_title: `gates ${head} ${report.nonce}`,
						status: "completed",
						conclusion: "success",
						event: "workflow_dispatch",
						path: ".github/workflows/ci.yml",
						actor: { login: CONTROLLER_LOGIN },
						triggering_actor: { login: CONTROLLER_LOGIN },
						created_at: "2026-10-31T00:00:00Z",
					});

				if (path === `actions/runs/${report.ciRunId}/artifacts`)
					return ok({
						artifacts: reportAvailable
							? [{ id: 999, name: "factory-report", expired: false }]
							: [],
					});

				if (path === `commits/${head}/check-runs?filter=all&per_page=100`)
					return ok({
						total_count: checks.length + missingChecks,
						check_runs: checks,
					});
				throw new Error(`unexpected ${command} ${method} ${path}`);
			},
		});

		const observe = async (book = state) => ({
			...(await port.observe(book, 1000)),
			executionAllowed: true,
			capacityAvailable: true,
		});

		for (const rejected of ["missing", "mismatch"]) {
			reportAvailable = rejected !== "missing";
			reportValid = rejected !== "mismatch";
			assert.notEqual(
				handoffCandidate(state, await observe()).effect?.kind,
				"promote_pr",
			);
		}

		reportAvailable = true;
		reportValid = true;
		const firstObservation = await observe();
		assert.equal(firstObservation.pr.kind, "open");
		assert.equal(firstObservation.eligibility, "ready");
		assert.equal(
			firstObservation.readiness.kind,
			"current",
			JSON.stringify(firstObservation),
		);
		const first = handoffCandidate(state, firstObservation);
		assert.equal(first.effect?.kind, "promote_pr");
		assert.equal(pending(first.state, "promote_pr").expectedHead, predecessor);
		assert.equal(pending(first.state, "promote_pr").head, head);

		const foreign = observed("e".repeat(40)).main;
		assert.ok(foreign);
		prHead = foreign;
		refHead = foreign;
		assert.notEqual(
			handoffCandidate(state, await observe()).effect?.kind,
			"promote_pr",
		);

		const conflict = await port.execute(
			first.state,
			pending(first.state, "promote_pr"),
		);

		assert.ok(conflict?.kind === "promote_pr");
		assert.equal(conflict.head, foreign);
		assert.equal(conflict.refHead, foreign);
		assert.equal(patches.length, 0);

		const conflicted = selected(
			handoffCandidate(first.state, {
				kind: "effect_completed",
				completion: conflict,
			}).state,
		);

		assert.equal(conflicted.work.kind, "held");
		assert.notEqual(
			handoffCandidate(conflicted, await observe(conflicted)).effect?.kind,
			"promote_pr",
		);
		prHead = predecessor;
		refHead = predecessor;

		const result = await port.execute(
			first.state,
			pending(first.state, "promote_pr"),
		);

		assert.ok(result?.kind === "promote_pr");
		assert.equal(patches.length, 1);
		assert.equal(result.head, predecessor);
		assert.equal(result.refHead, head);

		const lagged = handoffCandidate(first.state, {
			kind: "effect_completed",
			completion: result,
		}).state;

		assert.notEqual(
			handoffCandidate(lagged, await observe(selected(lagged))).effect?.kind,
			"complete_handoff",
		);

		const lostResponse = handoffCandidate(
			first.state,
			await observe(selected(first.state)),
		);

		assert.equal(lostResponse.effect?.kind, "promote_pr");
		await port.execute(
			lostResponse.state,
			pending(lostResponse.state, "promote_pr"),
		);
		assert.equal(patches.length, 1);
		prHead = head;
		refHead = head;
		feedbackReads.length = 0;
		const promotionWindow = await observe();

		assert.deepEqual(promotionWindow.feedback, {
			kind: "deferred",
			reason: "head_mismatch",
		});
		assert.deepEqual(feedbackReads, []);
		assert.equal(
			selected(handoffCandidate(state, promotionWindow).state).feedback,
			null,
		);

		const badOrdinary = [
			[],
			[{ ...ordinaryCheck, status: "in_progress", conclusion: null }],
			[{ ...ordinaryCheck, conclusion: "failure" }],
			[{ ...ordinaryCheck, conclusion: "skipped" }],
			[{ ...ordinaryCheck, app: { id: 7 } }],
			[{ ...ordinaryCheck, head_sha: predecessor }],
			[ordinaryCheck, { ...ordinaryCheck, id: 790 }],
		];

		for (const rows of badOrdinary) {
			checks = [factoryCheck, ...rows];
			assert.notEqual(
				handoffCandidate(state, await observe()).effect?.kind,
				"complete_handoff",
			);
		}

		checks = [factoryCheck, ordinaryCheck];
		missingChecks = 1;
		assert.notEqual(
			handoffCandidate(state, await observe()).effect?.kind,
			"complete_handoff",
		);
		missingChecks = 0;
		const completing = handoffCandidate(state, await observe());
		assert.equal(completing.effect?.kind, "complete_handoff");

		const ready = handoffCandidate(completing.state, {
			kind: "effect_completed",
			completion: {
				kind: "complete_handoff",
				request: pending(completing.state, "complete_handoff"),
				now: 1000,
			},
		}).state;

		assert.equal(selected(ready).work.kind, "waiting");
		assert.equal(selected(ready).published?.readiness.kind, "ready");
		assert.equal(candidateUsage(ready), candidateUsage(state));
		const intake = await observe(selected(ready));

		assert.ok(
			intake.feedback?.kind === "read" && intake.feedback.batch?.actionable,
		);
		assert.ok(feedbackReads.length > 0);
		const ingested = selected(handoffCandidate(ready, intake).state);

		assert.deepEqual(ingested.feedback?.batches[0]?.status, {
			kind: "applying",
			round: 1,
		});
		assert.equal(
			pending(ingested, "post_notice").notice.kind,
			"repair_started",
		);
	});
});

test("only a candidate assessment repairs; other classes stop or hold durably, and the book codec round-trips them", () => {
	const roundTrip = (state: CandidateState) =>
		assert.deepEqual(
			parseCandidateState(JSON.parse(JSON.stringify(state))),
			state,
		);

	const candidate = validated(select(), false);
	assert.equal(candidate.work.kind, "repair_due");
	assert.ok(candidate.work.kind === "repair_due");
	assert.equal(candidate.work.cause.kind, "validation");
	assert.deepEqual(
		candidate.work.cause.assessment,
		candidate.current.assessment,
	);
	roundTrip(candidate);

	const issued = selected(handoffCandidate(candidate, observed()).state);
	assert.ok(issued.work.kind === "effect");
	assert.ok(issued.work.request.kind === "repair_build");
	assert.deepEqual(issued.work.request.execution.cause, candidate.work.cause);
	roundTrip(issued);

	for (const [failure, reason] of [
		[
			{ kind: "oracle", cause: "unexpected_base", scenarios: ["S1"] },
			"diagnosis_oracle",
		],
		[
			{ kind: "missing_evidence", reason: "tree_replays_disagree" },
			"diagnosis_missing_evidence",
		],
	] as const) {
		const stopped = validated(select(), false, failure);
		assert.deepEqual(stopped.work, {
			kind: "effect",
			request: { kind: "finish_pr", terminal: { kind: "failed", reason } },
		});
		roundTrip(stopped);
	}

	const held = validated(select(), false, {
		kind: "infrastructure",
		reason: "timeout",
	});

	assert.deepEqual(held.work, {
		kind: "held",
		reason: "diagnosis_infrastructure",
		since: 0,
	});
	roundTrip(held);

	for (let tick = 0; tick < 3; tick++) {
		const step = handoffCandidate(held, observed());
		assert.equal(step.effect, null);
		assert.deepEqual(step.state, held);
	}
});

test("an assessment bound to another verdict or contradicting it never repairs", () => {
	for (const tamper of [
		(read: import("../src/validation.ts").ReadAssessment) => ({
			...read,
			binding: { ...read.binding, generation: 1 },
		}),
		(read: import("../src/validation.ts").ReadAssessment) => ({
			...read,
			binding: { ...read.binding, verdictDigest: digestOf("other") },
		}),
		(read: import("../src/validation.ts").ReadAssessment) => ({
			...read,
			assessment: { kind: "passed" as const },
		}),
	]) {
		const state = validated(select(), false, undefined, tamper);
		assert.deepEqual(state.work, {
			kind: "effect",
			request: {
				kind: "finish_pr",
				terminal: { kind: "failed", reason: "diagnosis_missing_evidence" },
			},
		});
	}

	const failedPass = validated(select(), true, undefined, (read) => ({
		...read,
		assessment: {
			kind: "failed",
			failure: { kind: "candidate", reason: "candidate_check", scenarios: [] },
		},
	}));

	assert.notEqual(failedPass.work.kind, "review_due");
	assert.notEqual(failedPass.work.kind, "repair_due");
});

test("a review-driven repair binds its blocking review receipt, and a non-blocking failed certification never repairs (L4)", () => {
	const active = reviewing(validated(select()));

	const settle = (review: ReviewReceipt) =>
		selected(
			handoffCandidate(active.state, {
				kind: "review_settled",
				execution: active.execution,
				tokens: 7,
				result: {
					kind: "passed",
					review,
					patch: { kind: "found", receipt: patch, patch: "patch" },
				},
			}).state,
		);

	const blocking = blockingReceipt(active.execution);
	const due = settle(blocking);
	assert.ok(due.work.kind === "repair_due");
	assert.deepEqual(due.work.cause, {
		kind: "review",
		assessment: due.current.assessment,
		review: reviewReceiptDigest(blocking),
	});
	assert.equal(
		reviewReceiptDigest(blocking),
		digestOf(JSON.stringify(blocking)),
	);
	assert.deepEqual(parseCandidateState(JSON.parse(JSON.stringify(due))), due);

	const wire = JSON.parse(JSON.stringify(due));
	delete wire.work.cause.review;
	assert.equal(parseCandidateState(wire), null);

	const validation = JSON.parse(JSON.stringify(validated(select(), false)));
	validation.work.cause.review = digestOf("review");
	assert.equal(parseCandidateState(validation), null);

	for (const review of [
		{ ...receipt(active.execution), blocking: true },
		{ ...blocking, blocking: false },
		{ ...receipt(active.execution), ciRunId: 999 },
	]) {
		const held = settle(review);
		assert.equal(held.work.kind, "held", JSON.stringify(review));
	}
});

test("a persisted repair without its assessment cause does not parse", () => {
	const issued = selected(
		handoffCandidate(validated(select(), false), observed()).state,
	);

	const wire = JSON.parse(JSON.stringify(issued));
	delete wire.work.request.execution.cause;
	assert.equal(parseCandidateState(wire), null);

	const due = JSON.parse(JSON.stringify(validated(select(), false)));
	delete due.work.cause;
	assert.equal(parseCandidateState(due), null);
});

test("one ready PR waits without issuing more effects, attempts or tokens", () => {
	const state = waiting();
	assert.equal(state.work.kind, "waiting");
	assert.equal(state.accounts.length, 1);

	for (let tick = 0; tick < 2; tick++) {
		const step = handoffCandidate(state, readyObservation(state));
		assert.equal(step.effect, null);
		assert.deepEqual(step.state, state);
		assert.equal(candidateUsage(step.state), 1334);
	}
});

test("refresh archives immutable evidence, does not consume repair, and issues round-global attempts", () => {
	const state = waiting();
	const old = JSON.stringify(state.current);
	const event = { ...readyObservation(state), main: "b".repeat(40) };
	assert.ok(isGitSha(event.main));

	const refreshed = selected(
		handoffCandidate(state, { ...event, main: event.main }).state,
	);

	assert.equal(refreshed.current.intent.round, 0);
	assert.equal(refreshed.current.intent.generation, 1);
	assert.equal(JSON.stringify(refreshed.history[0]), old);
	assert.equal(refreshed.current.intent.publication.kind, "successor");
	const next = reviewing(validated(refreshed));
	assert.equal(next.execution.attempt, 2);
	assert.equal(
		candidateAllowance(next.state, next.execution),
		REVIEW_MAX_TOKENS - 100,
	);
	assert.equal(next.execution.workflowSha, pin.workflowSha);
	assert.equal(next.execution.binding.baseSha, event.main);
});

test("base movement stops active review and charges known settlement before selecting g1", () => {
	const review = reviewing(validated(select()));
	const event = observed("b".repeat(40));
	const stopping = handoffCandidate(review.state, event).state;
	const request = pending(stopping, "stop_execution");
	assert.equal(selected(stopping).current.intent.generation, 0);

	const refused = handoffCandidate(stopping, {
		kind: "effect_completed",
		completion: {
			kind: "stop_execution",
			request,
			stopped: false,
			tokens: null,
		},
	});

	assert.deepEqual(refused.state, stopping);

	const settled = handoffCandidate(stopping, {
		kind: "effect_completed",
		completion: {
			kind: "stop_execution",
			request,
			stopped: true,
			tokens: 20_000,
		},
	}).state;

	assert.equal(candidateUsage(settled), 21_234);
	const refreshed = selected(handoffCandidate(settled, event).state);
	assert.equal(refreshed.current.intent.generation, 1);
	const next = reviewing(validated(refreshed));
	assert.equal(next.execution.attempt, 2);
	assert.equal(
		candidateAllowance(next.state, next.execution),
		REVIEW_MAX_TOKENS - 20_000,
	);

	const late = handoffCandidate(next.state, {
		kind: "review_settled",
		execution: review.execution,
		tokens: 20_000,
		result: {
			kind: "passed",
			review: receipt(review.execution),
			patch: { kind: "found", receipt: patch, patch: "patch" },
		},
	});

	assert.equal(candidateUsage(late.state), 21_234);
	assert.equal(selected(late.state).work.kind, "reviewing");
	assert.equal(selected(late.state).current.certification, null);
});

test("matching historical certificate survives an in-progress refresh and a readiness void", () => {
	const state = waiting();
	const report = state.current.report;
	assert.ok(report);

	const refresh = selected(
		handoffCandidate(state, {
			...readyObservation(state),
			main: observed("b".repeat(40)).main,
		}).state,
	);

	const merged = handoffCandidate(refresh, {
		...observed(),
		executionAllowed: false,
		eligibility: "withdrawn",
		pr: {
			kind: "merged",
			number: 5,
			head: report.candidateSha,
			mergeSha: sha,
			actor: null,
		},
	});

	const request = pending(merged.state, "finish_pr");
	assert.equal(request.terminal.kind, "merged");

	if (request.terminal.kind === "merged") {
		assert.equal(request.terminal.assurance.kind, "factory_verified");
		assert.equal(request.terminal.actor, null);
		assert.equal(request.terminal.mergeSha, sha);
		assert.equal(request.terminal.readiness?.kind, "not_ready");
	}
});

test("merged observation drains active work before terminal bookkeeping and cannot be replaced by failure", () => {
	const state = waiting();

	const refresh = handoffCandidate(state, {
		...readyObservation(state),
		main: observed("b".repeat(40)).main,
	}).state;

	const review = reviewing(validated(refresh));
	const oldHead = state.current.report?.candidateSha;
	assert.ok(oldHead);

	const stopped = handoffCandidate(review.state, {
		...observed(),
		pr: {
			kind: "merged",
			number: 5,
			head: oldHead,
			mergeSha: sha,
			actor: "owner",
		},
	}).state;

	const request = pending(stopped, "stop_execution");
	assert.equal(request.terminal?.kind, "merged");

	const failed = handoffCandidate(stopped, {
		kind: "review_settled",
		execution: review.execution,
		tokens: 500,
		result: { kind: "failed" },
	}).state;

	assert.equal(pending(failed, "stop_execution").terminal?.kind, "merged");

	const finishing = handoffCandidate(failed, {
		kind: "effect_completed",
		completion: { kind: "stop_execution", request, stopped: true, tokens: 500 },
	}).state;

	assert.equal(pending(finishing, "finish_pr").terminal.kind, "merged");
	assert.equal(candidateUsage(finishing), 1834);
});

test("unknown spend holds and cannot grant a new generation or allowance", () => {
	const review = reviewing(validated(select()));

	const unknown = selected(
		handoffCandidate(review.state, {
			kind: "review_settled",
			execution: review.execution,
			tokens: null,
			result: { kind: "failed" },
		}).state,
	);

	assert.equal(unknown.work.kind, "held");
	assert.equal(candidateAllowance(unknown, review.execution), 0);
	const next = handoffCandidate(unknown, observed("b".repeat(40)));
	assert.equal(selected(next.state).current.intent.generation, 0);
});

test("private candidate codec round-trips selected, running, waiting and archived generations", () => {
	const states = [select(), reviewing(validated(select())).state, waiting()];
	const ready = waiting();
	states.push(
		selected(
			handoffCandidate(ready, {
				...readyObservation(ready),
				main: observed("b".repeat(40)).main,
			}).state,
		),
	);

	for (const state of states) {
		const wire: JsonValue = JSON.parse(JSON.stringify(state));
		const restored = parseCandidateState(wire);
		assert.deepEqual(restored, state);
		assert.ok(Object.isFrozen(restored));
	}
});

test("private candidate codec refuses wrong pins, generation digests and duplicate execution accounts", () => {
	const state = waiting();

	for (const changed of [
		{ ...state, pin: { ...state.pin, workflowSha: "b".repeat(40) } },
		{
			...state,
			current: {
				...state.current,
				intent: { ...state.current.intent, digest: digestOf("wrong") },
			},
		},
		{ ...state, accounts: [...state.accounts, ...state.accounts] },
	]) {
		const wire: JsonValue = JSON.parse(JSON.stringify(changed));
		assert.equal(parseCandidateState(wire), null);
	}
});

test("canonical repair accounts share the two-round cap across validation and review", () => {
	let state = validated(select(), false);

	for (const round of [1, 2] as const) {
		assert.equal(state.work.kind, "repair_due");
		const issued = handoffCandidate(state, observed()).state;
		const request = pending(issued, "repair_build");
		assert.equal(request.execution.round, round);
		assert.equal(
			candidateAllowance(selected(issued), request.execution),
			REPAIR_BUILD_MAX_TOKENS,
		);

		const running = handoffCandidate(issued, {
			kind: "effect_completed",
			completion: { kind: "repair_build", request, started: true },
		}).state;

		const bytes = `patch-r${round}`;
		const nextPatch = { ...patch, round, patchDigest: digestOf(bytes) };

		const built = handoffCandidate(running, {
			kind: "repair_settled",
			execution: request.execution,
			tokens: 123,
			result: { kind: "passed", patch: nextPatch },
		}).state;

		state = selected(handoffCandidate(built, observed()).state);
		assert.equal(state.current.intent.round, round);
		assert.equal(state.history.length, round);
		assert.equal(
			candidateUsage(state),
			1234 + round * 123 + (round === 2 ? 7 : 0),
		);

		if (round === 1) {
			const active = reviewing(validated(state));
			state = selected(
				handoffCandidate(active.state, {
					kind: "review_settled",
					execution: active.execution,
					tokens: 7,
					result: {
						kind: "passed",
						review: blockingReceipt(active.execution),
						patch: { kind: "found", receipt: nextPatch, patch: bytes },
					},
				}).state,
			);
		} else state = validated(state, false);
	}

	const finish = pending(state, "finish_pr");
	assert.deepEqual(finish.terminal, { kind: "failed", reason: "repair_limit" });
	assert.equal(state.current.intent.round, 2);
	assert.equal(state.accounts.length, 3);
});

test("closed-unmerged and positive withdrawal cancel even while switched off", () => {
	for (const closed of [false, true]) {
		const state = waiting();

		const step = handoffCandidate(state, {
			...readyObservation(state),
			executionAllowed: false,
			eligibility: "withdrawn",
			pr: closed
				? { kind: "closed", number: 5, head: sha }
				: readyObservation(state).pr,
		});

		const request = pending(step.state, "finish_pr");
		assert.deepEqual(request.terminal, {
			kind: "cancelled",
			number: 5,
			reason: closed ? "closed" : "withdrawn",
		});

		const done = handoffCandidate(step.state, {
			kind: "effect_completed",
			completion: { kind: "finish_pr", request },
		});

		assert.deepEqual(candidateProjection(done.state).progress, {
			kind: "finished",
			outcome: { kind: "cancelled" },
		});
		assert.equal(candidateUsage(done.state), candidateUsage(state));
	}
});

test("formal trace reaches all six generations and refuses a fourth refresh without issuing work", () => {
	let state = validated(select(), false);
	let latestPatch = patch;
	let bytes = "patch";

	for (const round of [1, 2] as const) {
		const issued = handoffCandidate(state, observed()).state;
		const request = pending(issued, "repair_build");
		assert.equal(request.execution.round, round);

		const running = handoffCandidate(issued, {
			kind: "effect_completed",
			completion: { kind: "repair_build", request, started: true },
		}).state;

		bytes = `formal-repair-${round}`;
		latestPatch = { ...patch, round, patchDigest: digestOf(bytes) };

		const built = handoffCandidate(running, {
			kind: "repair_settled",
			execution: request.execution,
			tokens: 101,
			result: { kind: "passed", patch: latestPatch },
		}).state;

		state = selected(handoffCandidate(built, observed()).state);

		if (round === 1) state = validated(state, false);
	}

	for (const base of ["b", "c", "d"]) {
		const archive = JSON.stringify([...state.history, state.current]);
		state = selected(handoffCandidate(state, observed(base.repeat(40))).state);
		assert.equal(JSON.stringify(state.history), archive);
	}

	assert.deepEqual(
		[...state.history, state.current].map(({ intent }) => [
			intent.round,
			intent.generation,
		]),
		[
			[0, 0],
			[1, 0],
			[2, 0],
			[2, 1],
			[2, 2],
			[2, 3],
		],
	);
	assert.equal(state.accounts.length, 2);
	assert.equal(candidateUsage(state), 1436);
	const review = reviewing(validated(state));
	assert.equal(review.execution.attempt, 1);
	state = selected(
		handoffCandidate(review.state, {
			kind: "review_settled",
			execution: review.execution,
			tokens: 103,
			result: {
				kind: "passed",
				review: receipt(review.execution),
				patch: { kind: "found", receipt: latestPatch, patch: bytes },
			},
		}).state,
	);
	assert.ok(state.current.certification);

	const refused = selected(
		handoffCandidate(state, observed("e".repeat(40))).state,
	);

	assert.equal(refused.history.length, 5);
	assert.deepEqual(refused.work, {
		kind: "held",
		reason: "refresh_limit",
		since: 100,
	});
	assert.equal(refused.accounts.length, 3);
	assert.equal(candidateUsage(refused), 1539);
	assert.deepEqual(
		parseCandidateState(JSON.parse(JSON.stringify(refused))),
		refused,
	);
});

test("formal trace refuses a fourth round-global review after failures and refreshes", () => {
	let state = validated(select());
	const attempts: number[] = [];

	for (const [index, base] of ["a", "b", "c"].entries()) {
		if (index > 0)
			state = validated(
				handoffCandidate(state, observed(base.repeat(40))).state,
			);
		const review = reviewing(state);
		attempts.push(review.execution.attempt);
		state = selected(
			handoffCandidate(review.state, {
				kind: "review_settled",
				execution: review.execution,
				tokens: 1000,
				result: { kind: "failed" },
			}).state,
		);
	}

	assert.deepEqual(attempts, [1, 2, 3]);
	assert.equal(state.accounts.length, 3);
	assert.equal(pending(state, "finish_pr").terminal.kind, "failed");
	const refused = handoffCandidate(state, observed("d".repeat(40)));
	assert.notEqual(refused.effect?.kind, "launch_review");
	assert.equal(refused.state.accounts.length, 3);
	assert.equal(candidateUsage(refused.state), 4234);
});

test("formal accounting retains duplicate lower unknown and late high-water usage on its captured account", () => {
	const first = reviewing(validated(select()));

	let state = handoffCandidate(first.state, {
		kind: "execution_progress",
		execution: first.execution,
		tokens: 200,
	}).state;

	const stopping = handoffCandidate(state, observed("b".repeat(40))).state;
	const request = pending(stopping, "stop_execution");
	state = handoffCandidate(stopping, {
		kind: "effect_completed",
		completion: { kind: "stop_execution", request, stopped: true, tokens: 250 },
	}).state;
	const refreshed = handoffCandidate(state, observed("b".repeat(40))).state;
	const next = reviewing(validated(refreshed));
	state = next.state;

	for (const tokens of [250, 249, 0, 250]) {
		state = handoffCandidate(state, {
			kind: "review_settled",
			execution: first.execution,
			tokens,
			result: { kind: "failed" },
		}).state;
		assert.equal(candidateUsage(state), 1484);
		assert.equal(selected(state).work.kind, "reviewing");
		assert.equal(selected(state).current.certification, null);
	}

	state = handoffCandidate(state, {
		kind: "review_settled",
		execution: first.execution,
		tokens: null,
		result: { kind: "failed" },
	}).state;
	assert.equal(candidateUsage(state), 1484);
	assert.equal(state.accounts[0]?.spend.kind, "unknown");
	state = handoffCandidate(state, {
		kind: "review_settled",
		execution: first.execution,
		tokens: 300,
		result: { kind: "failed" },
	}).state;
	assert.equal(candidateUsage(state), 1534);
	assert.equal(state.accounts[0]?.spend.kind, "known");
	assert.equal(state.accounts[1]?.execution.id, next.execution.id);
	assert.equal(
		candidateAllowance(selected(state), next.execution),
		REVIEW_MAX_TOKENS - 300,
	);
});

for (const spent of [
	REVIEW_MAX_TOKENS - 1,
	REVIEW_MAX_TOKENS,
	REVIEW_MAX_TOKENS + 1,
])
	test(`formal review accounting records cap boundary ${spent} and refuses excess work`, () => {
		const review = reviewing(validated(select()));

		const state = selected(
			handoffCandidate(review.state, {
				kind: "review_settled",
				execution: review.execution,
				tokens: spent,
				result: { kind: "failed" },
			}).state,
		);

		assert.equal(candidateUsage(state), 1234 + spent);
		const next = handoffCandidate(state, observed());

		if (spent < REVIEW_MAX_TOKENS) {
			const request = pending(next.state, "launch_review");
			assert.equal(
				candidateAllowance(selected(next.state), request.execution),
				1,
			);
		} else assert.notEqual(next.effect?.kind, "launch_review");
	});

for (const prior of [TRUSTED_RUN_CAP - 1, TRUSTED_RUN_CAP, TRUSTED_RUN_CAP + 1])
	test(`formal run preflight preserves past-stage cap boundary ${prior}`, () => {
		const state = validated(
			handoffCandidate(beginCandidate(pin, patch, prior), observed()).state,
		);

		const next = handoffCandidate(state, observed());
		assert.equal(candidateUsage(next.state), prior);

		if (prior < TRUSTED_RUN_CAP) {
			const request = pending(next.state, "launch_review");
			assert.equal(
				candidateAllowance(selected(next.state), request.execution),
				1,
			);
		} else {
			assert.equal(next.effect, null);
			assert.deepEqual(selected(next.state).work, {
				kind: "held",
				reason: "run_tokens",
				since: 100,
			});
		}
	});

for (const spent of [
	REPAIR_BUILD_MAX_TOKENS - 60_000,
	REPAIR_BUILD_MAX_TOKENS - 59_999,
	REPAIR_BUILD_MAX_TOKENS - 1,
	REPAIR_BUILD_MAX_TOKENS,
	REPAIR_BUILD_MAX_TOKENS + 1,
])
	test(`formal repair accounting records cap boundary ${spent} without censoring receipts`, () => {
		const due = validated(select(), false);
		const issued = handoffCandidate(due, observed()).state;
		const request = pending(issued, "repair_build");

		const running = handoffCandidate(issued, {
			kind: "effect_completed",
			completion: { kind: "repair_build", request, started: true },
		}).state;

		const paid = handoffCandidate(running, {
			kind: "repair_settled",
			execution: request.execution,
			tokens: spent,
			result: { kind: "failed" },
		}).state;

		assert.equal(candidateUsage(paid), 1234 + spent);
		const next = handoffCandidate(paid, observed());

		if (REPAIR_BUILD_MAX_TOKENS - spent >= 60_000) {
			const retry = pending(next.state, "repair_build");
			assert.equal(retry.execution.attempt, 2);
			assert.equal(
				candidateAllowance(selected(next.state), retry.execution),
				REPAIR_BUILD_MAX_TOKENS - spent,
			);
		} else assert.notEqual(next.effect?.kind, "repair_build");
	});

test("formal owner merge of an unmatched head records override rather than current readiness", () => {
	const previous = waiting();

	const merged = handoffCandidate(previous, {
		...observed(),
		executionAllowed: false,
		pr: {
			kind: "merged",
			number: 5,
			head: observed("f".repeat(40)).main ?? sha,
			mergeSha: sha,
			actor: null,
		},
	}).state;

	const request = pending(merged, "finish_pr");
	assert.equal(request.terminal.kind, "merged");

	if (request.terminal.kind === "merged") {
		assert.equal(request.terminal.assurance.kind, "owner_override");
		assert.equal(request.terminal.readiness?.kind, "ready");
		assert.equal(request.terminal.actor, null);
	}
});

test("formal merge holds unknown terminal drain and finalizes only after a known stop receipt", () => {
	const previous = waiting();

	const refreshed = handoffCandidate(previous, {
		...readyObservation(previous),
		main: observed("b".repeat(40)).main,
	}).state;

	const review = reviewing(validated(refreshed));
	const head = previous.current.report?.candidateSha;
	assert.ok(head);

	const merged = handoffCandidate(review.state, {
		...observed(),
		executionAllowed: false,
		eligibility: "withdrawn",
		pr: { kind: "merged", number: 5, head, mergeSha: sha, actor: null },
	}).state;

	const stop = pending(merged, "stop_execution");

	const unknown = handoffCandidate(merged, {
		kind: "effect_completed",
		completion: {
			kind: "stop_execution",
			request: stop,
			stopped: true,
			tokens: null,
		},
	}).state;

	assert.equal(pending(unknown, "stop_execution").terminal?.kind, "merged");
	assert.notEqual(candidateProjection(unknown).status, "landed");
	assert.equal(candidateAllowance(selected(unknown), review.execution), 0);

	const finishing = handoffCandidate(unknown, {
		kind: "effect_completed",
		completion: {
			kind: "stop_execution",
			request: stop,
			stopped: true,
			tokens: 901,
		},
	}).state;

	assert.equal(candidateUsage(finishing), 2235);
	const finish = pending(finishing, "finish_pr");

	const done = handoffCandidate(finishing, {
		kind: "effect_completed",
		completion: { kind: "finish_pr", request: finish },
	}).state;

	assert.equal(candidateProjection(done).status, "landed");
	assert.equal(finish.terminal.kind, "merged");

	if (finish.terminal.kind === "merged")
		assert.equal(finish.terminal.assurance.kind, "factory_verified");
});

test("formal certification failure after publication holds the same PR without feedback repair", () => {
	const previous = waiting();

	const refreshed = handoffCandidate(previous, {
		...readyObservation(previous),
		main: observed("b".repeat(40)).main,
	}).state;

	const failed = validated(refreshed, false);
	assert.equal(failed.published?.number, 5);
	assert.equal(failed.work.kind, "held");
	assert.equal(failed.published?.readiness.kind, "not_ready");
	assert.equal(failed.current.intent.round, 0);
	assert.equal(
		failed.accounts.filter((a) => a.execution.stage === "build").length,
		0,
	);
});

function lateUnknownReviews() {
	const previous = waiting();
	const old = previous.accounts[0]?.execution;
	assert.ok(old?.stage === "review");

	const refreshed = handoffCandidate(previous, {
		...readyObservation(previous),
		main: observed("b".repeat(40)).main,
	}).state;

	const current = reviewing(validated(refreshed));

	const state = handoffCandidate(current.state, {
		kind: "review_settled",
		execution: old,
		tokens: null,
		result: { kind: "failed" },
	}).state;

	const head = previous.current.report?.candidateSha;
	assert.ok(head);

	return { state, old, current: current.execution, head };
}

function codecCandidate(state: CandidateState) {
	assert.deepEqual(
		parseCandidateState(JSON.parse(JSON.stringify(state))),
		state,
	);

	return state;
}

for (const uncertain of [false, true])
	test(`formal terminal drain settles the older account before the newer ${uncertain ? "uncertain" : "running"} review`, () => {
		const fixture = lateUnknownReviews();

		const input = uncertain
			? handoffCandidate(fixture.state, {
					kind: "review_settled",
					execution: fixture.current,
					tokens: null,
					result: { kind: "failed" },
				}).state
			: fixture.state;

		let state = codecCandidate(
			handoffCandidate(input, {
				...observed(),
				executionAllowed: false,
				eligibility: "withdrawn",
				pr: {
					kind: "merged",
					number: 5,
					head: fixture.head,
					mergeSha: sha,
					actor: null,
				},
			}).state,
		);

		const first = pending(state, "stop_execution");
		assert.deepEqual(first.execution, fixture.old);
		const terminal = first.terminal;
		assert.ok(terminal?.kind === "merged");
		assert.equal(terminal.assurance.kind, "factory_verified");
		assert.equal(terminal.actor, null);
		assert.equal(terminal.mergeSha, sha);
		assert.equal(terminal.readiness?.kind, "not_ready");
		const history = JSON.stringify(selected(state).history);
		const identities = state.accounts.map((a) => a.execution);
		const prior = candidateUsage(state);

		const settleFirst = {
			kind: "effect_completed",
			completion: {
				kind: "stop_execution",
				request: first,
				stopped: true,
				tokens: 150,
			},
		} satisfies CandidateEvent;

		state = codecCandidate(handoffCandidate(state, settleFirst).state);
		const second = pending(state, "stop_execution");
		assert.deepEqual(second.execution, fixture.current);
		assert.deepEqual(second.terminal, terminal);
		assert.notEqual(candidateProjection(state).status, "landed");
		assert.equal(
			state.accounts[1]?.settlement,
			uncertain ? "uncertain" : "running",
		);
		assert.equal(candidateUsage(state), prior + 50);
		assert.deepEqual(handoffCandidate(state, settleFirst).state, state);
		assert.deepEqual(
			handoffCandidate(state, {
				kind: "effect_completed",
				completion: {
					kind: "stop_execution",
					request: second,
					stopped: false,
					tokens: 999,
				},
			}).state,
			state,
		);
		state = codecCandidate(
			handoffCandidate(state, {
				kind: "effect_completed",
				completion: {
					kind: "stop_execution",
					request: second,
					stopped: true,
					tokens: null,
				},
			}).state,
		);
		assert.deepEqual(pending(state, "stop_execution"), second);
		assert.notEqual(candidateProjection(state).status, "landed");
		state = codecCandidate(
			handoffCandidate(state, {
				kind: "effect_completed",
				completion: {
					kind: "stop_execution",
					request: second,
					stopped: true,
					tokens: 7,
				},
			}).state,
		);
		const finish = pending(state, "finish_pr");
		assert.deepEqual(finish.terminal, terminal);
		assert.ok(
			state.accounts.every(
				(a) => a.settlement === "settled" && a.spend.kind === "known",
			),
		);
		assert.equal(candidateUsage(state), prior + 57);
		assert.equal(JSON.stringify(selected(state).history), history);
		assert.deepEqual(
			state.accounts.map((a) => a.execution),
			identities,
		);
		state = codecCandidate(
			handoffCandidate(state, {
				kind: "effect_completed",
				completion: { kind: "finish_pr", request: finish },
			}).state,
		);
		assert.equal(candidateProjection(state).status, "landed");
		assert.deepEqual(selected(state).work, { kind: "terminal", terminal });
		assert.deepEqual(handoffCandidate(state, settleFirst).state, state);
	});

for (const outcome of [
	"override",
	"closed",
	"withdrawn",
	"released",
	"failed",
] as const)
	test(`formal terminal drain preserves ${outcome} intent across multiple captured accounts`, () => {
		let state: CandidateState;

		if (outcome === "released" || outcome === "failed") {
			const executions: ReviewExecution[] = [];
			state = validated(select());

			for (
				let attempt = 1;
				attempt <= (outcome === "failed" ? 3 : 2);
				attempt++
			) {
				const next = reviewing(state);
				executions.push(next.execution);
				state = next.state;

				if (attempt < (outcome === "failed" ? 3 : 2))
					state = handoffCandidate(state, {
						kind: "review_settled",
						execution: next.execution,
						tokens: 10,
						result: { kind: "failed" },
					}).state;
			}

			for (const execution of executions.slice(0, -1))
				state = handoffCandidate(state, {
					kind: "review_settled",
					execution,
					tokens: null,
					result: { kind: "failed" },
				}).state;

			if (outcome === "released")
				state = handoffCandidate(state, {
					...observed(),
					eligibility: "withdrawn",
				}).state;
			else {
				const current = executions.at(-1);
				assert.ok(current);
				state = handoffCandidate(state, {
					kind: "review_settled",
					execution: current,
					tokens: 10,
					result: { kind: "failed" },
				}).state;
			}
		} else {
			const fixture = lateUnknownReviews();
			state = handoffCandidate(fixture.state, {
				...observed(),
				eligibility: outcome === "withdrawn" ? "withdrawn" : "ready",
				pr:
					outcome === "override"
						? {
								kind: "merged",
								number: 5,
								head: observed("f".repeat(40)).main ?? sha,
								mergeSha: sha,
								actor: "owner",
							}
						: outcome === "closed"
							? { kind: "closed", number: 5, head: fixture.head }
							: {
									kind: "open",
									number: 5,
									head: fixture.head,
									refHead: fixture.head,
								},
			}).state;
		}

		codecCandidate(state);
		const terminal = pending(state, "stop_execution").terminal;
		assert.ok(terminal);
		assert.equal(
			terminal.kind,
			outcome === "override"
				? "merged"
				: outcome === "released"
					? "released"
					: outcome === "failed"
						? "failed"
						: "cancelled",
		);

		if (terminal.kind === "merged")
			assert.equal(terminal.assurance.kind, "owner_override");
		const unsettled = state.accounts.filter((a) => a.settlement !== "settled");
		assert.equal(unsettled.length, 2);

		for (const account of unsettled) {
			const stop = pending(state, "stop_execution");
			assert.deepEqual(stop.execution, account.execution);
			assert.deepEqual(stop.terminal, terminal);
			state = codecCandidate(
				handoffCandidate(state, {
					kind: "effect_completed",
					completion: {
						kind: "stop_execution",
						request: stop,
						stopped: true,
						tokens:
							(account.spend.kind === "known"
								? account.spend.tokens
								: account.spend.floor) + 1,
					},
				}).state,
			);
		}

		const finish = pending(state, "finish_pr");
		assert.deepEqual(finish.terminal, terminal);
		assert.ok(state.accounts.every((a) => a.settlement === "settled"));

		const done = codecCandidate(
			handoffCandidate(state, {
				kind: "effect_completed",
				completion: { kind: "finish_pr", request: finish },
			}).state,
		);

		assert.deepEqual(selected(done).work, { kind: "terminal", terminal });
	});

test("certification rejects missing workflow/execution evidence and mismatched source", () => {
	const state = certified(select());
	const c = state.current.certification;
	assert.ok(c);

	const input = {
		pin,
		generation: state.current.intent,
		execution: c.execution,
		patch: { kind: "found", receipt: patch, patch: "patch" } as const,
		verdict: c.verdict,
		review: c.review,
		report: c.report,
	};

	assert.doesNotThrow(() => certifyGeneration(input));
	const execution = c.review.execution;
	assert.ok(execution);

	for (const [field, changed] of [
		["intentDigest", { intentDigest: digestOf("other intent") }],
		["attempt", { attempt: execution.attempt + 1 }],
		["workflowSha", { workflowSha: "e".repeat(40) }],
	] as const)
		assert.throws(
			() =>
				certifyGeneration({
					...input,
					review: { ...c.review, execution: { ...execution, ...changed } },
				}),
			{ message: "certification_binding" },
			`untrusted receipt execution.${field} must match the unchanged captured execution`,
		);

	for (const changed of [
		{ patchDigest: digestOf("different patch") },
		{ candidateSha: "e".repeat(40) },
		{ acceptanceDigest: digestOf("different suite") },
		{ heldoutDigest: digestOf("different heldout") },
		{ ciRunId: c.verdict.ciRunId + 1 },
		{ gateSha: "e".repeat(40) },
		{ requiredChecks: [] },
		{ pass: false },
		{ checks: c.verdict.checks.map((check) => ({ ...check, passed: false })) },
		{ unjudged: ["J1"] },
	])
		assert.throws(
			() =>
				certifyGeneration({ ...input, verdict: { ...c.verdict, ...changed } }),
			/certification/,
		);

	for (const review of [
		{ ...c.review, seats: [] },
		{ ...c.review, blocking: true },
		{ ...c.review, candidateSha: "e".repeat(40) },
		{ ...c.review, patchDigest: digestOf("other") },
	])
		assert.throws(
			() => certifyGeneration({ ...input, review }),
			/certification/,
		);

	assert.throws(
		() =>
			certifyGeneration({
				...input,
				patch: { ...input.patch, patch: "other bytes" },
			}),
		/binding/,
	);
	assert.throws(
		() =>
			certifyGeneration({
				...input,
				review: { ...c.review, execution: undefined },
			}),
		/binding/,
	);
	assert.throws(
		() =>
			certifyGeneration({
				...input,
				pin: { ...pin, workflowDigest: digestOf("other") },
			}),
		/binding/,
	);
	assert.throws(
		() =>
			certifyGeneration({
				...input,
				verdict: { ...c.verdict, baseSha: "f".repeat(40) },
			}),
		/binding/,
	);
});

test("certification accepts only pass judgments, and stored reviews keep the closed outcome set", () => {
	const state = certified(select());
	const c = state.current.certification;
	assert.ok(c);

	const judged = (
		outcome: string,
		extra: { readonly pass?: boolean } = {},
	) => ({
		...c.review,
		seats: c.review.seats.map((seat) =>
			seat.seat === "code-review"
				? {
						...seat,
						judgments: [{ scenario: "J1", outcome, reason: "why", ...extra }],
					}
				: seat,
		),
	});

	const input = {
		pin,
		generation: state.current.intent,
		execution: c.execution,
		patch: { kind: "found", receipt: patch, patch: "patch" } as const,
		verdict: { ...c.verdict, unjudged: ["J1"] },
		review: c.review,
		report: c.report,
	};

	const passed = certifyGeneration({
		...input,
		// SAFETY: "pass" is a member of the closed outcome set.
		review: judged("pass") as ReviewReceipt,
	});

	assert.equal(passed.review.seats[0]?.judgments[0]?.outcome, "pass");

	for (const outcome of ["fail", "unverifiable", "inconclusive", "timeout"])
		assert.throws(
			() =>
				certifyGeneration({
					...input,
					// SAFETY: each value is a non-pass member of the closed outcome set.
					review: judged(outcome) as ReviewReceipt,
				}),
			/certification/,
			outcome,
		);

	const book = JSON.parse(
		JSON.stringify({
			...state,
			current: {
				...state.current,
				verdict: input.verdict,
				certification: { ...passed, verdict: input.verdict },
			},
		}),
	);

	assert.notEqual(parseCandidateState(book), null);

	const stored = (review: JsonValue) =>
		parseCandidateState({
			...book,
			current: {
				...book.current,
				certification: { ...book.current.certification, review },
			},
		});

	const v1 = (review: ReturnType<typeof judged>, version = 1) => ({
		...review,
		version,
		seats: review.seats.map((seat) => ({
			...seat,
			judgments: seat.judgments.map(({ scenario, outcome, reason }) => ({
				scenario,
				pass: outcome === "pass",
				reason,
			})),
		})),
	});

	const migrated = stored(JSON.parse(JSON.stringify(v1(judged("pass")))));
	assert.notEqual(migrated, null);
	assert.deepEqual(
		migrated,
		stored(JSON.parse(JSON.stringify(judged("pass")))),
	);
	assert.equal(
		migrated?.kind === "selected" &&
			migrated.current.certification?.review.version,
		2,
	);

	for (const outcome of ["pass", "fail"])
		assert.deepEqual(
			parseReviewReceipt(JSON.parse(JSON.stringify(v1(judged(outcome))))),
			judged(outcome),
			outcome,
		);

	for (const outcome of ["unverifiable", "timeout"])
		assert.deepEqual(
			parseReviewReceipt(JSON.parse(JSON.stringify(judged(outcome)))),
			judged(outcome),
		);

	const mixed = [
		{ ...judged("pass"), version: 1 },
		v1(judged("pass"), 2),
		v1(judged("pass"), 3),
		{ ...judged("pass", { pass: true }), version: 1 },
		judged("pass", { pass: true }),
		judged("skipped"),
		{
			...v1(judged("pass")),
			seats: [
				...v1(judged("pass")).seats,
				{
					...v1(judged("pass")).seats[0],
					judgments: [{ scenario: "J2", outcome: "pass", reason: "why" }],
				},
			],
		},
		{
			...v1(judged("pass")),
			seats: v1(judged("pass")).seats.map((seat) => ({
				...seat,
				judgments: seat.judgments.map((j) => ({ ...j, pass: "yes" })),
			})),
		},
	];

	for (const review of mixed) {
		assert.equal(
			stored(JSON.parse(JSON.stringify(review))),
			null,
			JSON.stringify(review),
		);
		assert.equal(
			parseReviewReceipt(JSON.parse(JSON.stringify(review))),
			null,
			JSON.stringify(review),
		);
	}

	assert.equal(
		stored(JSON.parse(JSON.stringify(judged("unverifiable")))),
		null,
	);
	assert.equal(stored(JSON.parse(JSON.stringify(v1(judged("fail"))))), null);
});

test("Not proven lists every non-pass review outcome by scenario and outcome only, never as passed", () => {
	const outcomes = ["fail", "unverifiable", "inconclusive", "timeout"] as const;

	const limitations = notProven({
		criteria: [{ id: "A1" }],
		scenarios: [{ criteria: ["A1"], checks: ["a.test.ts"] }],
		r8: "complete",
		judgments: [
			{ scenario: "S1", outcome: "pass", reason: "private pass reason" },
			...outcomes.map((outcome, i) => ({
				scenario: `S${i + 2}`,
				outcome,
				reason: `private ${outcome} reason test/acceptance/secret.test.ts`,
			})),
		],
	});

	assert.deepEqual(limitations, [
		...outcomes.map((outcome, i) => ({
			kind: "judgment",
			scenario: `S${i + 2}`,
			outcome,
		})),
		{ kind: "live_proof_not_recorded" },
	]);

	const rendered = limitations.map(renderLimitation);
	assert.deepEqual(rendered.slice(0, 4), [
		"- Review judged S2 as fail; it is not proven.",
		"- Review judged S3 as unverifiable; it is not proven.",
		"- Review judged S4 as inconclusive; it is not proven.",
		"- Review judged S5 as timeout; it is not proven.",
	]);

	for (const line of rendered) {
		assert.doesNotMatch(line, /\bS1\b|pass|private|secret|acceptance/);
	}

	assert.equal(
		renderLimitation({
			kind: "judgment",
			scenario: "S1 ![x](y) @owner",
			outcome: "unverifiable",
		}),
		"- Review judged a scenario as unverifiable; it is not proven.",
	);
	assert.deepEqual(
		notProven({
			criteria: [{ id: "A1" }],
			scenarios: [{ criteria: ["A1"], checks: ["a.test.ts"] }],
			r8: "complete",
			judgments: [{ scenario: "S1", outcome: "pass", reason: "ok" }],
		}),
		[{ kind: "live_proof_not_recorded" }],
	);
});

test("handoff Not proven section derives judge-only criteria, same-family review and pending live proof from receipts", () => {
	const limitations = notProven({
		criteria: [{ id: "A1" }, { id: "A2" }, { id: "A3" }],
		scenarios: [
			{ criteria: ["A1"], checks: ["a.test.ts"] },
			{ criteria: ["A1", "A2"], checks: [] },
			{ criteria: ["A3"], checks: [] },
		],
		r8: "incomplete",
		judgments: [],
	});

	assert.deepEqual(limitations, [
		{ kind: "judge_only", criteria: ["A2", "A3"] },
		{ kind: "same_family" },
		{ kind: "live_proof_not_recorded" },
	]);
	assert.deepEqual(limitations.map(renderLimitation), [
		"- No executable check covers A2, A3; only review judged them.",
		"- R8 cross-family review remains incomplete.",
		"- No live proof is recorded; CI and review ran on the candidate only.",
	]);
	assert.deepEqual(
		notProven({
			criteria: [{ id: "A1" }],
			scenarios: [{ criteria: ["A1"], checks: ["a.test.ts"] }],
			r8: "complete",
			judgments: [],
		}),
		[{ kind: "live_proof_not_recorded" }],
	);
});

const OPENAI_BUILDER: FamilyInput = {
	kind: "openai-request",
	model: "openai/gpt-6.1-sol",
};

const CLAUDE: FamilyInput = {
	kind: "anthropic-gateway",
	model: "claude-sonnet-5-5",
};

/** A version 3 receipt with consistent labels and `r8` for the given families. */
function familyReceipt(
	review: ReviewReceipt,
	families: {
		readonly builder: FamilyInput;
		readonly accept: FamilyInput;
		readonly codeReview: FamilyInput;
	},
): ReviewReceipt {
	const seats = review.seats.map((seat) => {
		const family =
			seat.seat === "code-review" ? families.codeReview : OPENAI_BUILDER;

		return { ...seat, family, label: familyLabel(family, families.builder) };
	});

	const v3 = {
		...review,
		version: 3,
		r8: "incomplete",
		builder: families.builder,
		accept: families.accept,
		seats,
	} as const;

	return { ...v3, r8: reviewR8(v3) };
}

test("certification recomputes r8 and every label from stored family evidence, never from a label", () => {
	const state = certified(select());
	const c = state.current.certification;
	assert.ok(c);

	const input = {
		pin,
		generation: state.current.intent,
		execution: c.execution,
		patch: { kind: "found", receipt: patch, patch: "patch" } as const,
		verdict: c.verdict,
		review: c.review,
		report: c.report,
	};

	const complete = familyReceipt(c.review, {
		builder: OPENAI_BUILDER,
		accept: CLAUDE,
		codeReview: CLAUDE,
	});

	assert.equal(complete.r8, "complete");
	assert.equal(
		certifyGeneration({ ...input, review: complete }).review.r8,
		"complete",
	);
	assert.deepEqual(
		parseReviewReceipt(JSON.parse(JSON.stringify(complete))),
		complete,
	);

	const fallback = familyReceipt(c.review, {
		builder: OPENAI_BUILDER,
		accept: OPENAI_BUILDER,
		codeReview: CLAUDE,
	});

	assert.equal(fallback.r8, "incomplete");
	assert.doesNotThrow(() => certifyGeneration({ ...input, review: fallback }));

	if (complete.version !== 3 || fallback.version !== 3)
		throw new Error("version 3 expected");

	const unknownSeat = familyReceipt(c.review, {
		builder: OPENAI_BUILDER,
		accept: CLAUDE,
		codeReview: { kind: "unavailable", reason: "unknown-model" },
	});

	const inverted = familyReceipt(c.review, {
		builder: CLAUDE,
		accept: OPENAI_BUILDER,
		codeReview: OPENAI_BUILDER,
	});

	assert.equal(inverted.r8, "incomplete", "inverted families");

	if (inverted.version !== 3) throw new Error("version 3 expected");

	const forged: [string, ReviewReceipt][] = [
		["an Anthropic builder", inverted],
		["an Anthropic builder claiming complete", { ...inverted, r8: "complete" }],
		[
			"a version 2 label that also claims cross-family",
			{
				...c.review,
				seats: c.review.seats.map((seat) => ({
					...seat,
					label:
						"context-isolated, different family, cross-family; same family, not cross-family",
				})),
			},
		],
		["r8 complete on a same-family accept", { ...fallback, r8: "complete" }],
		["r8 incomplete on complete evidence", { ...complete, r8: "incomplete" }],
		[
			"a cross-family label on unavailable evidence",
			{
				...unknownSeat,
				seats: unknownSeat.seats.map((seat) => ({
					...seat,
					label: "context-isolated, different family, cross-family",
				})),
			},
		],
		[
			"a same-family label on cross-family evidence",
			{
				...complete,
				seats: complete.seats.map((seat) => ({
					...seat,
					label: "context-isolated, same family, not cross-family",
				})),
			},
		],
		[
			"a builder that is not the patch's model",
			familyReceipt(c.review, {
				builder: { kind: "openai-request", model: "openai/gpt-6.1-terra" },
				accept: CLAUDE,
				codeReview: CLAUDE,
			}),
		],
		[
			"a seat with no family",
			{
				...complete,
				seats: complete.seats.map(({ family: _family, ...seat }) => seat),
			},
		],
	];

	for (const [name, review] of forged) {
		assert.throws(
			() => certifyGeneration({ ...input, review }),
			{ message: "certification_binding" },
			name,
		);
		// The patch binding lives outside the receipt, so only certification
		// can see a builder that is not the patch's model.
		assert.deepEqual(
			parseReviewReceipt(JSON.parse(JSON.stringify(review))),
			name === "a builder that is not the patch's model" ||
				name === "an Anthropic builder" ||
				name === "a version 2 label that also claims cross-family"
				? review
				: null,
			name,
		);
	}

	for (const minted of [
		{
			...complete,
			accept: { kind: "anthropic-gateway", model: "claude-next" },
		},
		{ ...complete, builder: { kind: "openai-request", model: "anthropic/x" } },
		{
			...complete,
			seats: complete.seats.map((seat) => ({
				...seat,
				family: {
					kind: "anthropic-gateway",
					model: "anthropic/claude-sonnet-5-5",
				},
			})),
		},
	])
		assert.equal(parseReviewReceipt(JSON.parse(JSON.stringify(minted))), null);

	assert.equal(
		parseReviewReceipt(
			JSON.parse(JSON.stringify({ ...c.review, r8: "complete" })),
		),
		null,
		"a version 2 receipt claiming complete",
	);

	const legacy = parseReviewReceipt(JSON.parse(JSON.stringify(c.review)));

	assert.equal(legacy?.version, 2);
	assert.equal(legacy?.r8, "incomplete");
	assert.equal(
		certifyGeneration({ ...input, review: c.review }).review.r8,
		"incomplete",
	);
});

test("Not proven omits same-family review only for recomputed complete evidence", () => {
	const state = certified(select());
	const c = state.current.certification;
	assert.ok(c);

	const base = {
		criteria: [{ id: "A1" }],
		scenarios: [{ criteria: ["A1"], checks: ["a.test.ts"] }],
		judgments: [],
	};

	const complete = familyReceipt(c.review, {
		builder: OPENAI_BUILDER,
		accept: CLAUDE,
		codeReview: CLAUDE,
	});

	const fallback = familyReceipt(c.review, {
		builder: OPENAI_BUILDER,
		accept: OPENAI_BUILDER,
		codeReview: CLAUDE,
	});

	assert.deepEqual(
		notProven({ ...base, r8: reviewR8(complete) }).map((l) => l.kind),
		["live_proof_not_recorded"],
	);
	assert.deepEqual(
		notProven({ ...base, r8: reviewR8(fallback) }).map((l) => l.kind),
		["same_family", "live_proof_not_recorded"],
	);
	assert.deepEqual(
		notProven({ ...base, r8: reviewR8(c.review) }).map((l) => l.kind),
		["same_family", "live_proof_not_recorded"],
	);
});

test("a version 1 review that fails migration keeps its bytes, not an explicit null", () => {
	const broken = { version: 1, seats: "not seats" };

	const migrated = objectOf(
		migrateCertificationValue({ review: broken, other: 1 }) ?? null,
	);

	assert.deepEqual(fieldOf(migrated, "review"), broken);
	assert.deepEqual(migrateCertificationValue({ review: null }), {
		review: null,
	});
});

function formalWitnessHeld() {
	const initial = published();

	const obs = {
		...readyObservation(initial),
		readiness: { kind: "unavailable" as const },
	};

	const state = handoffCandidate(initial, obs).state;
	const request = pending(state, "void_readiness");

	const held = selected(
		handoffCandidate(state, {
			kind: "effect_completed",
			completion: { kind: "void_readiness", request },
		}).state,
	);

	assert.equal(held.work.kind, "held");
	assert.ok(held.current.certification);

	return held;
}

test("formal F10 published repair witness withdraws readiness before issuing shared-budget work", () => {
	const initial = queuedFeedback(formalWitnessHeld());
	const started = startFeedback(initial);
	assert.equal(started.work.kind, "repair_due");
	assert.equal(started.published?.number, initial.published!.number);
	assert.deepEqual(started.history, initial.history);
	assert.deepEqual(started.accounts, initial.accounts);

	const issued = handoffCandidate(started, readyObservation(started)).state;
	const request = pending(issued, "repair_build");
	assert.equal(request.execution.round, 1);
	assert.equal(request.execution.attempt, 1);
	assert.equal(request.execution.cause.kind, "feedback");
	assert.equal(
		candidateAllowance(selected(issued), request.execution),
		REPAIR_BUILD_MAX_TOKENS,
	);

	const repairing = selected(
		handoffCandidate(issued, {
			kind: "effect_completed",
			completion: { kind: "repair_build", request, started: true },
		}).state,
	);

	assert.equal(repairing.work.kind, "rebuilding");
	assert.equal(repairing.published?.readiness.kind, "not_ready");
	assert.equal(candidateUsage(repairing), candidateUsage(initial));
	assert.ok(parseCandidateState(JSON.parse(JSON.stringify(repairing))));
});

test("formal F10 shortest merge-mid-repair witness merges before the build is issued", () => {
	const initial = queuedFeedback(formalWitnessHeld());
	const due = startFeedback(initial);
	const head = initial.current.report!.candidateSha;

	const merged = handoffCandidate(due, {
		...observed(),
		pr: { kind: "merged", number: 5, head, mergeSha: sha, actor: "owner" },
	}).state;

	const finish = pending(merged, "finish_pr");
	assert.partialDeepStrictEqual(finish.terminal, {
		kind: "merged",
		head,
		mergeSha: sha,
		assurance: { kind: "factory_verified" },
		readiness: { kind: "not_ready", reason: "feedback_repair" },
	});
	assert.deepEqual(selected(merged).accounts, initial.accounts);
	assert.equal(candidateUsage(merged), candidateUsage(initial));
});

test("formal F10 merge-mid-repair witness drains work and retains historical certification", () => {
	const initial = queuedFeedback();
	const repair = rebuildingFeedback(initial);
	const head = initial.current.report!.candidateSha;

	const merged = handoffCandidate(repair.state, {
		...observed(),
		pr: { kind: "merged", number: 5, head, mergeSha: sha, actor: "owner" },
	}).state;

	const stop = pending(merged, "stop_execution");
	assert.equal(stop.execution.id, repair.execution.id);
	assert.partialDeepStrictEqual(stop.terminal, {
		kind: "merged",
		head,
		mergeSha: sha,
		assurance: { kind: "factory_verified" },
		readiness: { kind: "not_ready", reason: "feedback_repair" },
	});

	const settled = handoffCandidate(merged, {
		kind: "effect_completed",
		completion: {
			kind: "stop_execution",
			request: stop,
			tokens: 17,
			stopped: true,
		},
	}).state;

	const finish = pending(settled, "finish_pr");
	assert.deepEqual(finish.terminal, stop.terminal);
	assert.equal(candidateUsage(settled), candidateUsage(initial) + 17);
	assert.ok(
		selected(settled).accounts.every((a) => a.settlement === "settled"),
	);

	const terminal = handoffCandidate(settled, {
		kind: "effect_completed",
		completion: { kind: "finish_pr", request: finish },
	}).state;

	assert.equal(selected(terminal).work.kind, "terminal");
	assert.deepEqual(
		selected(terminal).current.certification,
		initial.current.certification,
	);
});

function formalOwnerReady(restoreReadiness = true) {
	const initial = published();
	const head = "e".repeat(40);
	assert.ok(isGitSha(head));

	const observation = {
		...observed(),
		pr: { kind: "open" as const, number: 5, head, refHead: head },
	};

	let state = handoffCandidate(initial, observation).state;
	const notice = pending(state, "post_notice");
	assert.equal(notice.notice.kind, "owner_head");
	state = handoffCandidate(state, {
		kind: "effect_completed",
		completion: { kind: "post_notice", request: notice },
	}).state;
	assert.partialDeepStrictEqual(selected(state).work, {
		kind: "owner_due",
		head,
	});
	state = handoffCandidate(state, observation).state;
	const work = selected(state).work;
	assert.ok(work.kind === "effect");
	assert.partialDeepStrictEqual(work.request, {
		kind: "derive_owner_patch",
		head,
		baseSha: sha,
	});
	const bytes = "owner patch";

	const ownerPatch = {
		version: 1,
		kind: "owner",
		runId: pin.runId,
		head,
		baseSha: sha,
		contractDigest: pin.contractDigest,
		acceptanceDigest: pin.acceptanceDigest,
		heldoutDigest: initial.current.verdict!.heldoutDigest,
		patchDigest: digestOf(bytes),
		changedPaths: ["src/example.ts"],
		policy: "clean",
	};

	state = handoffCandidate(
		state,
		JSON.parse(
			JSON.stringify({
				kind: "effect_completed",
				completion: {
					kind: "derive_owner_patch",
					request: work.request,
					result: { kind: "found", patch: ownerPatch },
				},
			}),
		),
	).state;
	assert.partialDeepStrictEqual(pending(state, "validate").generation, {
		round: 0,
		generation: 1,
		origin: { kind: "owner", head },
		publication: { kind: "owner", head },
	});
	state = validated(state);
	const issued = handoffCandidate(state, observation).state;
	const launch = pending(issued, "launch_review");
	state = handoffCandidate(issued, {
		kind: "effect_completed",
		completion: { kind: "launch_review", request: launch, started: true },
	}).state;
	const missing = { kind: "unavailable", reason: "missing" } as const;
	const r = receipt(launch.execution);
	assert.ok(r.version === 2);
	state = handoffCandidate(
		state,
		JSON.parse(
			JSON.stringify({
				kind: "review_settled",
				execution: launch.execution,
				tokens: 10,
				result: {
					kind: "passed",
					patch: { kind: "found", receipt: ownerPatch, patch: bytes },
					review: {
						...r,
						version: 3,
						builder: missing,
						accept: missing,
						seats: r.seats.map((s) => ({
							...s,
							family: missing,
							label: familyLabel(missing, missing),
						})),
					},
				},
			}),
		),
	).state;
	assert.ok(selected(state).current.certification);
	assert.equal(selected(state).current.report?.candidateSha, head);
	assert.equal(
		selected(state).accounts.filter((a) => a.execution.stage === "build")
			.length,
		0,
	);

	if (!restoreReadiness) return { state, head };

	state = handoffCandidate(state, {
		...readyObservation(state),
		pr: observation.pr,
	}).state;
	const complete = pending(state, "complete_handoff");
	state = handoffCandidate(state, {
		kind: "effect_completed",
		completion: { kind: "complete_handoff", request: complete, now: 200 },
	}).state;
	assert.equal(selected(state).published?.readiness.kind, "ready");
	assert.partialDeepStrictEqual(selected(state).current.intent.origin, {
		kind: "owner",
		head,
	});

	return { state, head };
}

test("formal F10 owner-ready witness recertifies the exact head without a build or promotion", () => {
	formalOwnerReady();
});

test("formal F10 owner-authored merge witness points to the owner certification", () => {
	const { state, head } = formalOwnerReady(false);

	const merged = handoffCandidate(state, {
		...observed(),
		pr: { kind: "merged", number: 5, head, mergeSha: sha, actor: "owner" },
	}).state;

	const terminal = pending(merged, "finish_pr").terminal;
	assert.partialDeepStrictEqual(terminal, {
		kind: "merged",
		head,
		assurance: { kind: "factory_verified" },
		readiness: { kind: "not_ready" },
	});
	assert.ok(
		terminal.kind === "merged" &&
			terminal.assurance.kind === "factory_verified",
	);
	assert.equal(
		terminal.assurance.certification.digest,
		selected(state).current.intent.digest,
	);
});

// F10-2 contract tests. Drive the public advance surface through handoffCandidate.
function queuedFeedback(initial = waiting()) {
	const obs = feedbackObservation(initial);
	assert.ok(obs.kind === "read" && obs.batch);

	return {
		...initial,
		feedback: {
			pr: initial.published!.number,
			seen: [...obs.batch.seen],
			batches: [
				{
					digest: obs.batch.digest,
					head: obs.head,
					actionable: true,
					reviews: obs.batch.reviews,
					notice: "posted" as const,
					status: { kind: "queued" as const },
				},
			],
		},
	};
}

function startFeedback(state: ReturnType<typeof selected> = queuedFeedback()) {
	const step = handoffCandidate(state, readyObservation(state));
	const request = pending(step.state, "post_notice");
	assert.equal(request.notice.kind, "repair_started");
	assert.equal(request.withdraw, "feedback_repair");
	assert.equal(request.notice.place, "issue");

	const started = selected(
		handoffCandidate(step.state, {
			kind: "effect_completed",
			completion: { kind: "post_notice", request },
		}).state,
	);

	assert.equal(started.work.kind, "repair_due");
	assert.deepEqual(started.published?.readiness, {
		kind: "not_ready",
		reason: "feedback_repair",
		since: 100,
	});
	assert.equal(candidateUsage(started), candidateUsage(state));

	return started;
}

function rebuildingFeedback(
	state: ReturnType<typeof selected> = queuedFeedback(),
) {
	const started = startFeedback(state);
	const issued = handoffCandidate(started, readyObservation(started)).state;
	const request = pending(issued, "repair_build");
	assert.equal(request.execution.cause.kind, "feedback");

	return {
		execution: request.execution,
		state: selected(
			handoffCandidate(issued, {
				kind: "effect_completed",
				completion: { kind: "repair_build", request, started: true },
			}).state,
		),
	};
}

for (const remaining of [34_361, 59_999, 60_000])
	for (const budget of ["round", "run"] as const)
		test(`feedback launch floor: ${budget} remainder ${remaining}`, () => {
			let state = queuedFeedback();

			if (budget === "run")
				state = {
					...state,
					priorTokens:
						state.pin.maxTokens -
						remaining -
						(candidateUsage(state) - state.priorTokens),
				};
			else {
				const built = rebuildingFeedback(state);
				state = {
					...state,
					accounts: [
						...state.accounts,
						{
							execution: built.execution,
							settlement: "settled",
							spend: {
								kind: "known",
								tokens: REPAIR_BUILD_MAX_TOKENS - remaining,
							},
						},
					],
				};
			}

			const next = handoffCandidate(state, readyObservation(state)).state;
			const notice = pending(next, "post_notice");

			if (remaining < 60_000) {
				assert.equal(notice.notice.kind, "round_summary");
				assert.equal(
					notice.withdraw,
					budget === "run" ? "run_tokens" : "repair_tokens",
				);
				assert.partialDeepStrictEqual(notice.then, {
					kind: "held",
					reason: budget === "run" ? "run_tokens" : "repair_tokens",
				});
			} else assert.equal(notice.notice.kind, "repair_started");
		});

test("feedback launch floor does not override the shared repair cap", () => {
	const initial = queuedFeedback();

	const state = {
		...initial,
		pin: { ...initial.pin, maxTokens: candidateUsage(initial) },
		current: {
			...initial.current,
			intent: { ...initial.current.intent, round: 2 as const },
		},
		published: {
			...initial.published!,
			promoted: { ...initial.published!.promoted, round: 2 as const },
		},
	};

	const notice = pending(
		handoffCandidate(state, readyObservation(state)).state,
		"post_notice",
	);

	assert.equal(notice.notice.kind, "repair_unavailable");
	assert.partialDeepStrictEqual(notice.then, { kind: "resume" });
});

test("a held feedback repair projects its real stage, round and attempt", () => {
	const build = rebuildingFeedback();

	const state = {
		...build.state,
		work: { kind: "held", reason: "repair_tokens", since: 100 } as const,
	};

	const projection = candidateProjection(state);
	assert.equal(projection.status, "blocked");
	assert.equal(projection.stage, "build");
	assert.equal(projection.round, 1);
	assert.equal(projection.attempt, build.execution.attempt);
});

function feedbackReview(
	initial: ReturnType<typeof selected> = queuedFeedback(),
) {
	const build = rebuildingFeedback(initial);
	const changed = { ...patch, round: 1, patchDigest: digestOf("round-ending") };

	const built = handoffCandidate(build.state, {
		kind: "repair_settled",
		execution: build.execution,
		tokens: 10,
		result: { kind: "passed", patch: changed },
	}).state;

	const validating = handoffCandidate(built, readyObservation(built)).state;

	return { ...reviewing(validated(validating)), changed, validating };
}

function roundObservation(
	state: CandidateState,
): Extract<CandidateEvent, { kind: "observed" }> {
	const book = selected(state);

	const promoted = [...book.history, book.current].find(
		(g) => g.intent.digest === book.published?.promoted.digest,
	);

	const head = promoted?.report?.candidateSha;
	assert.ok(head);
	const report = book.current.report;

	return {
		...observed(book.current.intent.baseSha),
		pr: { kind: "open", number: 5, head, refHead: head },
		readiness:
			report === null
				? { kind: "unavailable" }
				: { kind: "current", head: report.candidateSha, report },
	};
}

const roundEndings = [
	"repair_notice",
	"review_launch",
	"build_launch",
	"review_spend",
	"build_spend",
	"missing_verdict",
	"missing_report",
	"review_failed",
	"no_change",
	"invalid_patch",
	"validation_failed",
	"validation_evidence",
	"review_preflight",
	"build_preflight",
	"refresh_preflight",
	"refresh_limit",
	"generation_limit",
	"repair_round",
	"certification",
	"review_execution",
	"resume_spend",
	"closed",
	"withdrawn",
	"oracle",
	"infrastructure",
	"missing_evidence",
	"assessment_binding",
	"review_blocked",
	"repeated_finding",
] as const;

for (const ending of roundEndings)
	test(`F10-2 every round ending settles and has one durable summary: ${ending}`, async () => {
		const build = rebuildingFeedback();
		let review = feedbackReview();

		if (ending === "repeated_finding") {
			const initial = queuedFeedback();

			const previous = initial.accounts.find(
				(a) => a.execution.stage === "review",
			)!.execution;

			assert.ok(previous.stage === "review");
			review = feedbackReview({
				...initial,
				current: { ...initial.current, review: blockingReceipt(previous) },
			});
		}

		let state = build.state;

		let event: CandidateEvent = {
			kind: "repair_settled",
			execution: build.execution,
			tokens: 10,
			result: { kind: "no_change" },
		};

		const fault = {
			kind: "effect_held",
			reason: "evidence_unavailable",
			now: 4321,
		} as const;

		if (ending === "closed" || ending === "withdrawn") {
			event = {
				...roundObservation(state),
				...(ending === "closed"
					? {
							pr: {
								kind: "closed" as const,
								number: 5,
								head: build.state.current.report!.candidateSha,
							},
						}
					: { eligibility: "withdrawn" as const }),
			};
		} else if (ending === "repair_notice") {
			state = selected(
				handoffCandidate(queuedFeedback(), readyObservation(queuedFeedback()))
					.state,
			);
			event = fault;
		} else if (ending === "build_launch") {
			state = selected(
				handoffCandidate(startFeedback(), readyObservation(startFeedback()))
					.state,
			);
			event = fault;
		} else if (ending === "review_launch") {
			state = {
				...review.state,
				work: {
					kind: "effect",
					request: { kind: "launch_review", execution: review.execution },
				},
			};
			event = {
				kind: "review_settled",
				execution: review.execution,
				tokens: null,
				result: { kind: "failed" },
			};
		} else if (
			[
				"review_spend",
				"missing_verdict",
				"missing_report",
				"review_failed",
				"certification",
				"review_blocked",
				"repeated_finding",
			].includes(ending)
		) {
			state = review.state;

			if (ending === "missing_verdict")
				state = { ...state, current: { ...state.current, verdict: null } };

			if (ending === "missing_report")
				state = { ...state, current: { ...state.current, report: null } };

			const receiptValue =
				ending === "review_blocked" || ending === "repeated_finding"
					? blockingReceipt(review.execution)
					: receipt(review.execution);

			event = {
				kind: "review_settled",
				execution: review.execution,
				tokens: ending === "review_spend" ? null : 10,
				result:
					ending === "review_failed"
						? { kind: "failed" }
						: {
								kind: "passed",
								review:
									ending === "certification"
										? { ...receiptValue, patchDigest: digestOf("wrong") }
										: receiptValue,
								patch: {
									kind: "found",
									receipt: review.changed,
									patch: "round-ending",
								},
							},
			};
		} else if (ending === "build_spend") event = { ...event, tokens: null };
		else if (ending === "invalid_patch") {
			state = { ...state, pin: { ...state.pin, maxReviewAttempts: 1 } };
			event = {
				...event,
				result: {
					kind: "passed",
					patch: { ...patch, contractDigest: "wrong" },
				},
			};
		} else if (
			[
				"validation_failed",
				"validation_evidence",
				"oracle",
				"infrastructure",
				"missing_evidence",
				"assessment_binding",
			].includes(ending)
		) {
			state = selected(review.validating);
			const request = pending(state, "validate");

			if (ending !== "validation_evidence") {
				const failure: import("../src/diagnosis.ts").FailureClass | undefined =
					ending === "oracle"
						? { kind: "oracle", cause: "unexpected_base", scenarios: ["S1"] }
						: ending === "infrastructure"
							? { kind: "infrastructure", reason: "runner_error" }
							: ending === "missing_evidence"
								? { kind: "missing_evidence", reason: "incomplete_ci" }
								: undefined;

				const validation = validated(
					state,
					ending === "assessment_binding",
					failure,
					ending === "assessment_binding"
						? (read) => ({
								...read,
								binding: { ...read.binding, runId: digestOf("other-run") },
							})
						: undefined,
					4321,
				);

				// The assessment callback itself ends the failed validation round.
				state = selected(validation);
				event = { ...roundObservation(state), now: 4321 };
			} else
				event = {
					kind: "effect_completed",
					completion: {
						kind: "validate",
						request,
						result: {
							kind: "failed",
							validation: null,
							reason: "evidence_unavailable",
						},
					},
				};
		} else if (ending === "resume_spend") {
			state = {
				...state,
				accounts: state.accounts.map((a) =>
					a.execution.id === build.execution.id
						? { ...a, spend: { kind: "unknown", floor: 10 } }
						: a,
				),
			};
			event = {
				kind: "resume_execution",
				execution: build.execution,
				tokens: 1,
			};
		} else if (
			["build_preflight", "repair_round", "generation_limit"].includes(ending)
		) {
			state =
				ending === "build_preflight"
					? startFeedback()
					: {
							...state,
							accounts: state.accounts.map((a) => ({
								...a,
								settlement: "settled" as const,
							})),
							work: {
								kind: "repair_built",
								patch:
									ending === "repair_round" ? patch : { ...patch, round: 1 },
								feedbackFrom: build.execution.feedbackFrom,
							},
						};

			if (ending === "build_preflight")
				state = {
					...state,
					pin: { ...state.pin, maxTokens: candidateUsage(state) },
				};

			if (ending === "generation_limit")
				state = {
					...state,
					history: Array.from({ length: 5 }, (_, index) => {
						const priorPatch = {
							...patch,
							patchDigest: digestOf(`history-${index}`),
						};

						return {
							...state.current,
							patch: priorPatch,
							validation: null,
							verdict: null,
							report: null,
							certification: null,
							intent: generationIntent({
								pin,
								patch: priorPatch,
								round: 0,
								generation: 0,
								baseSha: sha,
								origin: { kind: "initial" },
								publication: { kind: "initial" },
							}),
						};
					}),
				};
			event = roundObservation(state);
		} else if (
			[
				"review_preflight",
				"refresh_preflight",
				"refresh_limit",
				"review_execution",
			].includes(ending)
		) {
			state = {
				...review.state,
				accounts: review.state.accounts.map((a) => ({
					...a,
					settlement: "settled" as const,
				})),
				work: { kind: "review_due", seats: review.execution.seats },
			};

			if (ending.endsWith("preflight"))
				state = {
					...state,
					pin: { ...state.pin, maxTokens: candidateUsage(state) },
				};

			if (ending === "review_execution")
				state = { ...state, current: { ...state.current, verdict: null } };

			if (ending === "refresh_limit")
				state = {
					...state,
					current: {
						...state.current,
						validation: null,
						verdict: null,
						report: null,
						certification: null,
						intent: generationIntent({
							pin,
							patch: state.current.patch,
							round: 1,
							generation: 3,
							baseSha: sha,
							origin: { kind: "refresh", previous: state.current.intent },
							publication: state.current.intent.publication,
						}),
					},
				};
			event = roundObservation(state);

			if (ending.startsWith("refresh")) {
				const main = "b".repeat(40);
				assert.ok(isGitSha(main));
				event = { ...event, main };
			}
		}

		const timed = { ...event, now: 4321 };
		let stopped = handoffCandidate(state, timed);

		if (ending === "closed" || ending === "withdrawn") {
			const request = pending(stopped.state, "stop_execution");

			const completion = {
				kind: "effect_completed",
				now: 4321,
				completion: {
					kind: "stop_execution",
					request,
					stopped: true,
					tokens: 10,
				},
			} as const;

			stopped = handoffCandidate(stopped.state, completion);
		}

		const summary = pending(stopped.state, "post_notice");
		assert.equal(summary.notice.kind, "round_summary");
		assert.equal(summary.at, 4321);
		assert.equal(
			selected(stopped.state).feedback?.batches.some(
				(b) => b.status.kind === "applying",
			),
			false,
		);

		assert.deepEqual(
			stopRound(selected(stopped.state), "review_input_too_large", 5000),
			stopped.state,
			"a second stop must retain the first reason and pending summary",
		);

		const persisted = parseCandidateState(
			JSON.parse(JSON.stringify(stopped.state)),
		);

		assert.ok(persisted);

		const movedMain = "f".repeat(40);
		assert.ok(isGitSha(movedMain));

		const retry = handoffCandidate(persisted, {
			...roundObservation(persisted),
			main: movedMain,
			now: 9999,
		});

		assert.deepEqual(
			retry.effect,
			summary,
			"restart must resume the same summary intent",
		);

		await withLocalArtifactDownload(async (root) => {
			const github = new FakeGitHub();
			github.add(fakeIssue(pin.issue));
			const pr = github.add(fakeIssue(5, { pullRequest: true }));

			const exec: import("../src/gh.ts").Exec = async (command, args) =>
				args.includes("DELETE") &&
				args.some((arg) => arg.endsWith("/labels/factory%3Areview"))
					? { code: 0, stderr: "", stdout: "" }
					: github.exec(command, args);

			for (let attempt = 0; attempt < 2; attempt++) {
				const port = controllerCandidatePort({
					platform: EXE_DEV_PLATFORM,
					stateDir: root,
					exec,
				});

				assert.ok(await port.execute(retry.state, summary));
			}

			assert.equal(
				pr.comments.filter((c) =>
					c.body.split("\n").includes(summary.notice.key),
				).length,
				1,
			);
		});

		const completed = handoffCandidate(retry.state, {
			kind: "effect_completed",
			completion: { kind: "post_notice", request: summary },
		});

		if (ending === "closed" || ending === "withdrawn") {
			const request = pending(completed.state, "finish_pr");
			assert.deepEqual(request.terminal, {
				kind: "cancelled",
				number: 5,
				reason: ending,
			});

			return;
		}

		assert.equal(selected(completed.state).work.kind, "held");
		assert.deepEqual(
			stopRound(selected(completed.state), "review_input_too_large", 9999),
			completed.state,
			"a completed round must keep its first stop reason without another summary",
		);
		assert.equal(
			handoffCandidate(completed.state, roundObservation(completed.state))
				.effect,
			null,
			"exactly one summary intent per ending",
		);
	});

for (const wait of ["checks", "head_lag", "promotion_lag"] as const)
	test(`F10-2 transient ${wait} does not end a repair before forge convergence`, () => {
		const review = feedbackReview();

		let state = handoffCandidate(review.state, {
			kind: "review_settled",
			execution: review.execution,
			tokens: 10,
			result: {
				kind: "passed",
				review: receipt(review.execution),
				patch: {
					kind: "found",
					receipt: review.changed,
					patch: "round-ending",
				},
			},
		}).state;

		const book = selected(state);
		const head = book.current.report!.candidateSha;
		const old = book.history[0]!.report!.candidateSha;

		if (wait === "promotion_lag") {
			state = handoffCandidate(state, roundObservation(state)).state;
			const request = pending(state, "promote_pr");
			state = handoffCandidate(state, {
				kind: "effect_completed",
				completion: { kind: "promote_pr", request, head: old, refHead: old },
			}).state;
		} else
			state = handoffCandidate(state, {
				...roundObservation(state),
				pr: {
					kind: "open",
					number: 5,
					head: wait === "head_lag" ? old : head,
					refHead: head,
				},
				readiness:
					wait === "checks"
						? { kind: "not_ready", reason: "checks_incomplete" }
						: readyObservation(state).readiness,
			}).state;
		assert.deepEqual(selected(state).feedback?.batches[0]?.status, {
			kind: "applying",
			round: 1,
		});

		if (wait === "checks") {
			const request = pending(state, "void_readiness");
			state = handoffCandidate(state, {
				kind: "effect_completed",
				completion: { kind: "void_readiness", request },
			}).state;
		}

		const restored = parseCandidateState(JSON.parse(JSON.stringify(state)));
		assert.ok(restored);
		state = handoffCandidate(restored, readyObservation(restored)).state;
		const request = pending(state, "complete_handoff");

		const completed = handoffCandidate(state, {
			kind: "effect_completed",
			completion: { kind: "complete_handoff", request, now: 5000 },
		});

		assert.equal(selected(completed.state).published?.readiness.kind, "ready");
		assert.deepEqual(selected(completed.state).feedback?.batches[0]?.status, {
			kind: "settled",
			outcome: { kind: "applied", head },
		});
	});

test("F10-2 complete_handoff settles only its repair batch, not another applying batch", () => {
	const review = feedbackReview();

	let state = handoffCandidate(review.state, {
		kind: "review_settled",
		execution: review.execution,
		tokens: 10,
		result: {
			kind: "passed",
			review: receipt(review.execution),
			patch: { kind: "found", receipt: review.changed, patch: "round-ending" },
		},
	}).state;

	state = handoffCandidate(state, readyObservation(state)).state;
	const request = pending(state, "complete_handoff");
	const book = selected(state);
	assert.ok(book.feedback);

	const unrelated = {
		...book.feedback.batches[0]!,
		digest: digestOf("unrepaired older batch"),
		round: 2 as const,
		status: { kind: "applying", round: 2 } as const,
	};

	const poisoned = {
		...book,
		feedback: {
			...book.feedback,
			batches: [unrelated, ...book.feedback.batches],
		},
	};

	const completed = selected(
		handoffCandidate(poisoned, {
			kind: "effect_completed",
			completion: { kind: "complete_handoff", request, now: 4321 },
		}).state,
	);

	assert.deepEqual(completed.feedback?.batches[0], unrelated);
	assert.deepEqual(completed.feedback?.batches[1]?.status, {
		kind: "settled",
		outcome: { kind: "applied", head: request.head },
	});
});

test("F10-2 another queued request cannot start while an old batch is applying", () => {
	const started = startFeedback();
	assert.ok(started.feedback);
	const obs = feedbackObservation(started, 88);
	assert.ok(obs.kind === "read" && obs.batch);

	const book = {
		...started,
		work: { kind: "held", reason: "evidence_unavailable", since: 100 } as const,
	};

	const result = handoffCandidate(book, {
		...readyObservation(book),
		feedback: { ...obs, batch: { ...obs.batch, refusedInline: false } },
	});

	assert.equal(
		selected(result.state).feedback?.batches.filter(
			(b) => b.status.kind === "applying",
		).length,
		1,
	);
	assert.notEqual(
		result.effect?.kind === "post_notice" ? result.effect.notice.kind : null,
		"repair_started",
	);
});

test("F10-2 a failed summary effect retains its intent for retry", () => {
	const build = rebuildingFeedback();

	const stopped = handoffCandidate(build.state, {
		kind: "repair_settled",
		execution: build.execution,
		tokens: 10,
		result: { kind: "no_change" },
	}).state;

	const failed = handoffCandidate(stopped, {
		kind: "effect_held",
		reason: "evidence_unavailable",
		now: 4321,
	});

	assert.deepEqual(failed.state, stopped);
	assert.deepEqual(failed.effect, pending(stopped, "post_notice"));
});

test("F10-2 stopped-round recovery can charge but cannot relaunch over its summary or hold", () => {
	const build = rebuildingFeedback();

	let state = handoffCandidate(build.state, {
		kind: "repair_settled",
		execution: build.execution,
		tokens: null,
		result: { kind: "failed" },
	}).state;

	const request = pending(state, "post_notice");

	const recovering = handoffCandidate(state, {
		kind: "resume_execution",
		execution: build.execution,
		tokens: 10,
	});

	assert.deepEqual(recovering.effect, request);
	state = handoffCandidate(recovering.state, {
		kind: "effect_completed",
		completion: { kind: "post_notice", request },
	}).state;

	const held = handoffCandidate(state, {
		kind: "resume_execution",
		execution: build.execution,
		tokens: 10,
	});

	assert.equal(held.effect, null);
	assert.equal(selected(held.state).work.kind, "held");
});

test("F10-2 summary hold records observation time and keeps it across restart", () => {
	const build = rebuildingFeedback();

	const event = {
		kind: "repair_settled",
		execution: build.execution,
		tokens: 10,
		result: { kind: "no_change" },
		now: 4321,
	} as const;

	const stopped = handoffCandidate(build.state, event);
	const request = pending(stopped.state, "post_notice");
	assert.equal(request.at, 4321);
	const parsed = parseCandidateState(JSON.parse(JSON.stringify(stopped.state)));
	assert.ok(parsed);

	const held = handoffCandidate(parsed, {
		kind: "effect_completed",
		completion: { kind: "post_notice", request },
	}).state;

	assert.partialDeepStrictEqual(selected(held), {
		work: { kind: "held", since: 4321 },
		published: { readiness: { kind: "not_ready", since: 4321 } },
	});

	const later = handoffCandidate(held, {
		...readyObservation(held),
		now: 9999,
	}).state;

	assert.deepEqual(
		selected(later).published?.readiness,
		selected(held).published?.readiness,
	);
	assert.deepEqual(selected(later).work, selected(held).work);
});

test("F10-2 C2 merge before repair-start completion records durable withdrawal intent", () => {
	const initial = queuedFeedback();

	const started = handoffCandidate(initial, {
		...readyObservation(initial),
		now: 4321,
	}).state;

	const request = pending(started, "post_notice");
	assert.equal(request.notice.kind, "repair_started");
	// Label DELETE has landed, but the completion claim has not. Restart from intent.
	const restored = parseCandidateState(JSON.parse(JSON.stringify(started)));
	assert.ok(restored);

	const merged = handoffCandidate(restored, {
		...observed(),
		pr: {
			kind: "merged",
			number: 5,
			head: initial.current.report!.candidateSha,
			mergeSha: sha,
			actor: "owner",
		},
	});

	const terminal = pending(merged.state, "finish_pr").terminal;
	assert.partialDeepStrictEqual(terminal, {
		kind: "merged",
		assurance: { kind: "factory_verified" },
		readiness: { kind: "not_ready", reason: "feedback_repair", since: 4321 },
	});
});

test("F10-2 F10-1 queued book picks up exactly one repair with no new intake notice", () => {
	const legacy = queuedFeedback();
	const parsed = parseCandidateState(JSON.parse(JSON.stringify(legacy)));
	assert.deepEqual(parsed, legacy);
	const step = handoffCandidate(parsed!, readyObservation(legacy));
	const request = pending(step.state, "post_notice");
	assert.equal(request.notice.kind, "repair_started");
	const twice = handoffCandidate(step.state, readyObservation(legacy));
	assert.deepEqual(twice.state, step.state);
	assert.deepEqual(pending(twice.state, "post_notice"), request);
	assert.ok(parseCandidateState(JSON.parse(JSON.stringify(step.state))));
	startFeedback(legacy);
});

for (const fault of ["cap", "budget", "assessment"] as const)
	test(`F10-2 ${fault} refuses with notice and no budget reset`, () => {
		const initial = queuedFeedback();

		const state =
			fault === "cap"
				? {
						...initial,
						current: {
							...initial.current,
							intent: { ...initial.current.intent, round: 2 as const },
						},
						published: {
							...initial.published!,
							promoted: { ...initial.published!.promoted, round: 2 as const },
						},
					}
				: fault === "budget"
					? {
							...initial,
							pin: { ...initial.pin, maxTokens: candidateUsage(initial) },
						}
					: {
							...initial,
							current: { ...initial.current, assessment: undefined },
						};

		const step = handoffCandidate(state, readyObservation(state));
		const notice = pending(step.state, "post_notice");

		if (fault === "budget") {
			assert.equal(notice.notice.kind, "round_summary");
			assert.equal(notice.withdraw, "run_tokens");
			assert.partialDeepStrictEqual(notice.then, {
				kind: "held",
				reason: "run_tokens",
			});
			assert.deepEqual(selected(step.state).accounts, state.accounts);
			assert.partialDeepStrictEqual(
				selected(step.state).feedback?.batches[0]?.status,
				{ kind: "settled", outcome: { kind: "stopped", reason: "run_tokens" } },
			);

			return;
		}

		assert.equal(notice.notice.kind, "repair_unavailable");
		assert.equal(notice.withdraw, null);
		assert.deepEqual(selected(step.state).accounts, state.accounts);
		assert.deepEqual(
			selected(step.state).published?.readiness,
			state.published?.readiness,
		);
		assert.partialDeepStrictEqual(
			selected(step.state).feedback?.batches[0]?.status,
			{
				kind: "settled",
				outcome: {
					kind: "refused",
					reason: fault === "cap" ? "cap_reached" : "repair_unavailable",
				},
			},
		);
	});

test("F10-2 dismissal and owner push supersede queued feedback without spending", () => {
	for (const owner of [false, true]) {
		const state = queuedFeedback();
		const obs = feedbackObservation(state);
		assert.ok(obs.kind === "read");
		const moved = "f".repeat(40);
		assert.ok(isGitSha(moved));

		const result = selected(
			handoffCandidate(state, {
				...readyObservation(state),
				...(owner
					? {
							pr: {
								kind: "open" as const,
								number: 5,
								head: moved,
								refHead: moved,
							},
							feedback: { kind: "deferred" as const },
						}
					: {
							feedback: { ...obs, batch: null, dismissed: state.feedback.seen },
						}),
			}).state,
		);

		assert.partialDeepStrictEqual(result.feedback?.batches[0]?.status, {
			kind: "settled",
			outcome: { kind: "superseded", by: owner ? "owner_head" : "dismissed" },
		});
		assert.deepEqual(result.accounts, state.accounts);
	}
});

test("F10-2 controller refresh carries F10-1 queued feedback to one repair", () => {
	const initial = queuedFeedback();
	const moved = "b".repeat(40);
	assert.ok(isGitSha(moved));

	const refreshing = handoffCandidate(
		{ ...initial, work: { kind: "handoff" } },
		{ ...readyObservation(initial), main: moved },
	).state;

	const reviewed = certified(refreshing);
	const old = initial.current.report!.candidateSha;

	const promoting = handoffCandidate(reviewed, {
		...readyObservation(reviewed),
		pr: { kind: "open", number: 5, head: old, refHead: old },
	}).state;

	const promote = pending(promoting, "promote_pr");

	const promoted = handoffCandidate(promoting, {
		kind: "effect_completed",
		completion: {
			kind: "promote_pr",
			request: promote,
			head: promote.head,
			refHead: promote.head,
		},
	}).state;

	const completing = handoffCandidate(
		promoted,
		readyObservation(promoted),
	).state;

	const complete = pending(completing, "complete_handoff");

	const ready = selected(
		handoffCandidate(completing, {
			kind: "effect_completed",
			completion: { kind: "complete_handoff", request: complete, now: 100 },
		}).state,
	);

	assert.deepEqual(ready.feedback?.batches[0]?.status, { kind: "queued" });
	const next = handoffCandidate(ready, readyObservation(ready));
	assert.equal(
		pending(next.state, "post_notice").notice.kind,
		"repair_started",
	);
	assert.equal(selected(next.state).feedback?.batches.length, 1);
});

for (const digestBackstop of [false, true])
	for (const published of [false, true])
		test(`F10-2 no progress stops immediately, published=${published}, digest=${digestBackstop}`, () => {
			const rebuilding = rebuildingFeedback();

			const state = {
				...rebuilding.state,
				published: published ? rebuilding.state.published : null,
			};

			const result = handoffCandidate(state, {
				kind: "repair_settled",
				execution: rebuilding.execution,
				tokens: 50,
				result: digestBackstop
					? { kind: "passed", patch: { ...patch, round: 1 } }
					: { kind: "no_change" },
			});

			const effect = result.effect;

			if (published) {
				assert.ok(effect?.kind === "post_notice");
				assert.equal(effect.notice.kind, "round_summary");
				assert.equal(effect.notice.place, "pr");
				assert.deepEqual(effect.then, {
					kind: "held",
					reason: "repair_no_progress",
				});
			} else {
				assert.ok(effect?.kind === "finish_pr");
				assert.deepEqual(effect.terminal, {
					kind: "failed",
					reason: "repair_no_progress",
				});
			}

			assert.equal(candidateUsage(result.state), candidateUsage(state) + 50);
			assert.ok(parseCandidateState(JSON.parse(JSON.stringify(result.state))));
		});

test("F10-2 failed patches keep attempt cap but a published run never fails", () => {
	const rebuilding = rebuildingFeedback();

	const state = {
		...rebuilding.state,
		pin: { ...rebuilding.state.pin, maxReviewAttempts: 1 },
	};

	const step = handoffCandidate(state, {
		kind: "repair_settled",
		execution: rebuilding.execution,
		tokens: 1,
		result: { kind: "failed" },
	});

	const summary = pending(step.state, "post_notice");
	assert.deepEqual(summary.then, { kind: "held", reason: "review_attempts" });
	assert.equal(summary.notice.kind, "round_summary");
});

test("F10-2 three no-progress attempts reuse one round, then refuse without corrupting the book", () => {
	let state: ReturnType<typeof selected> = queuedFeedback();

	for (let attempt = 1; attempt <= 3; attempt++) {
		const building = rebuildingFeedback(state);
		assert.equal(building.execution.round, 1);
		assert.equal(building.execution.attempt, attempt);

		const stopped = handoffCandidate(building.state, {
			kind: "repair_settled",
			execution: building.execution,
			tokens: 10,
			result: { kind: "no_change" },
		}).state;

		const request = pending(stopped, "post_notice");
		state = selected(
			handoffCandidate(stopped, {
				kind: "effect_completed",
				completion: { kind: "post_notice", request },
			}).state,
		);
		assert.equal(state.current.intent.round, 0);
		assert.equal(
			state.accounts.filter((a) => a.execution.stage === "build").length,
			attempt,
		);
		assert.ok(parseCandidateState(JSON.parse(JSON.stringify(state))));
		const incoming = feedbackObservation(state, attempt + 10);
		assert.ok(incoming.kind === "read" && incoming.batch);
		state = {
			...state,
			feedback: {
				...state.feedback!,
				seen: [...state.feedback!.seen, ...incoming.batch.seen].sort(),
				batches: [
					...state.feedback!.batches,
					{
						digest: incoming.batch.digest,
						head: incoming.head,
						actionable: true,
						reviews: incoming.batch.reviews,
						notice: "none",
						status: { kind: "queued" },
					},
				],
			},
		};
	}

	const refusal = handoffCandidate(state, readyObservation(state));
	assert.equal(
		pending(refusal.state, "post_notice").notice.kind,
		"repair_unavailable",
	);
	assert.equal(pending(refusal.state, "post_notice").detail, "review_attempts");
	assert.deepEqual(selected(refusal.state).accounts, state.accounts);
	assert.equal(candidateUsage(refusal.state), candidateUsage(state));
	assert.ok(
		parseCandidateState(JSON.parse(JSON.stringify(refusal.state))),
		"a refused fourth attempt must still be a readable durable book",
	);
});

test("F10-3 a stop before any build retries the same feedback round after restart", () => {
	const started = startFeedback();
	assert.equal(started.work.kind, "repair_due");
	assert.equal(
		started.accounts.some((a) => a.execution.stage === "build"),
		false,
	);
	const stopped = stopRound(started, "evidence_unavailable", 200);
	const request = pending(stopped, "post_notice");

	const held = selected(
		handoffCandidate(stopped, {
			kind: "effect_completed",
			completion: { kind: "post_notice", request },
		}).state,
	);

	assert.deepEqual(held.work, {
		kind: "held",
		reason: "evidence_unavailable",
		since: 200,
	});
	assert.partialDeepStrictEqual(held.feedback?.batches.at(-1)?.status, {
		kind: "settled",
		outcome: { kind: "stopped", reason: "evidence_unavailable" },
	});
	const restored = parseCandidateState(JSON.parse(JSON.stringify(held)));
	assert.ok(restored);

	const observed = selected(
		handoffCandidate(restored, {
			...readyObservation(selected(restored)),
			feedback: feedbackObservation(restored, 2),
		}).state,
	);

	const intake = pending(observed, "post_notice");
	assert.equal(intake.notice.kind, "feedback_intake");

	const acknowledged = selected(
		handoffCandidate(observed, {
			kind: "effect_completed",
			completion: { kind: "post_notice", request: intake },
		}).state,
	);

	const resumed = startFeedback(acknowledged);
	assert.partialDeepStrictEqual(resumed.work, {
		kind: "repair_due",
		round: 1,
		attempt: 1,
	});
	assert.deepEqual(resumed.accounts, held.accounts);
	assert.equal(candidateUsage(resumed), candidateUsage(held));
	assert.ok(parseCandidateState(JSON.parse(JSON.stringify(resumed))));
});

test("F10-2 published repair is a successor and fresh proof applies the batch", () => {
	const rebuilding = rebuildingFeedback();
	const changed = { ...patch, round: 1, patchDigest: digestOf("repaired") };

	const built = handoffCandidate(rebuilding.state, {
		kind: "repair_settled",
		execution: rebuilding.execution,
		tokens: 10,
		result: { kind: "passed", patch: changed },
	}).state;

	const validating = selected(
		handoffCandidate(built, readyObservation(built)).state,
	);

	assert.deepEqual(validating.current.intent.publication, {
		kind: "successor",
		expectedHead: rebuilding.state.current.report!.candidateSha,
	});
	const review = reviewing(validated(validating));

	const certified = handoffCandidate(review.state, {
		kind: "review_settled",
		execution: review.execution,
		tokens: 10,
		result: {
			kind: "passed",
			review: receipt(review.execution),
			patch: { kind: "found", receipt: changed, patch: "repaired" },
		},
	}).state;

	const old = rebuilding.state.current.report!.candidateSha;

	const promoting = handoffCandidate(certified, {
		...readyObservation(certified),
		pr: { kind: "open", number: 5, head: old, refHead: old },
	}).state;

	const promote = pending(promoting, "promote_pr");

	const promoted = handoffCandidate(promoting, {
		kind: "effect_completed",
		completion: {
			kind: "promote_pr",
			request: promote,
			head: promote.head,
			refHead: promote.head,
		},
	}).state;

	const completeState = handoffCandidate(
		promoted,
		readyObservation(promoted),
	).state;

	const complete = pending(completeState, "complete_handoff");

	const ready = selected(
		handoffCandidate(completeState, {
			kind: "effect_completed",
			completion: { kind: "complete_handoff", request: complete, now: 200 },
		}).state,
	);

	assert.deepEqual(ready.feedback?.batches[0]?.status, {
		kind: "settled",
		outcome: { kind: "applied", head: promote.head },
	});
	assert.equal(ready.published?.readiness.kind, "ready");
	assert.ok(parseCandidateState(JSON.parse(JSON.stringify(ready))));
});

for (const phase of [
	"repair_due",
	"rebuilding",
	"repair_built",
	"validate",
	"reviewing",
	"promote_pr",
] as const)
	test(`F10-2 merge during ${phase} retains old certification and marks batch merged`, () => {
		const rebuilding = rebuildingFeedback();
		let state = rebuilding.state;

		if (phase === "repair_due") state = startFeedback();
		else if (phase !== "rebuilding") {
			const changed = {
				...patch,
				round: 1,
				patchDigest: digestOf("repair-merge"),
			};

			state = selected(
				handoffCandidate(state, {
					kind: "repair_settled",
					execution: rebuilding.execution,
					tokens: 10,
					result: { kind: "passed", patch: changed },
				}).state,
			);

			if (phase !== "repair_built")
				state = selected(
					handoffCandidate(state, readyObservation(state)).state,
				);

			if (phase === "reviewing" || phase === "promote_pr") {
				const review = reviewing(validated(state));
				state = review.state;

				if (phase === "promote_pr") {
					state = selected(
						handoffCandidate(state, {
							kind: "review_settled",
							execution: review.execution,
							tokens: 10,
							result: {
								kind: "passed",
								review: receipt(review.execution),
								patch: {
									kind: "found",
									receipt: changed,
									patch: "repair-merge",
								},
							},
						}).state,
					);
					const old = rebuilding.state.current.report!.candidateSha;
					state = selected(
						handoffCandidate(state, {
							...readyObservation(state),
							pr: { kind: "open", number: 5, head: old, refHead: old },
						}).state,
					);
				}
			}
		}

		const head = rebuilding.state.current.report!.candidateSha;

		const merged = handoffCandidate(state, {
			...observed(),
			pr: { kind: "merged", number: 5, head, mergeSha: sha, actor: "owner" },
		});

		assert.ok(
			merged.effect?.kind === "finish_pr" ||
				merged.effect?.kind === "stop_execution",
		);
		assert.partialDeepStrictEqual(merged.effect.terminal, {
			kind: "merged",
			assurance: { kind: "factory_verified" },
			readiness: { kind: "not_ready", reason: "feedback_repair" },
		});
		assert.deepEqual(selected(merged.state).feedback?.batches[0]?.status, {
			kind: "settled",
			outcome: { kind: "merged", mergeSha: sha },
		});
	});

test("F10-2 promotion window permits a main refresh at the new certified head", () => {
	const initial = waiting();

	const b = "b".repeat(40),
		c = "c".repeat(40);

	assert.ok(isGitSha(b) && isGitSha(c));

	const fresh = certified(
		handoffCandidate(initial, { ...readyObservation(initial), main: b }).state,
	);

	const old = initial.current.report!.candidateSha;

	const promoting = handoffCandidate(fresh, {
		...readyObservation(fresh),
		pr: { kind: "open", number: 5, head: old, refHead: old },
	}).state;

	const promote = pending(promoting, "promote_pr");

	const promoted = handoffCandidate(promoting, {
		kind: "effect_completed",
		completion: {
			kind: "promote_pr",
			request: promote,
			head: promote.head,
			refHead: promote.head,
		},
	}).state;

	const next = handoffCandidate(promoted, {
		...readyObservation(promoted),
		main: c,
	});

	const validate = pending(next.state, "validate");
	assert.deepEqual(validate.generation.publication, {
		kind: "successor",
		expectedHead: promote.head,
	});

	const replay = handoffCandidate(next.state, {
		...readyObservation(promoted),
		main: c,
	});

	assert.deepEqual(
		pending(replay.state, "validate"),
		validate,
		"the archived promoted successor is still factory-owned while the next refresh validates",
	);
});

test("F10-2 close during repair cancels, and owner drift stops before another build", () => {
	for (const close of [false, true]) {
		const rebuilding = rebuildingFeedback();
		const drift = "e".repeat(40);
		assert.ok(isGitSha(drift));

		const step = handoffCandidate(rebuilding.state, {
			...readyObservation(rebuilding.state),
			pr: close
				? { kind: "closed", number: 5, head: drift }
				: { kind: "open", number: 5, head: drift, refHead: drift },
		});

		assert.ok(step.effect?.kind === "stop_execution");
		assert.equal(step.effect.execution.id, rebuilding.execution.id);
		assert.deepEqual(
			step.effect.terminal,
			close ? { kind: "cancelled", number: 5, reason: "closed" } : null,
		);

		if (!close)
			assert.partialDeepStrictEqual(
				selected(step.state).feedback?.batches[0]?.status,
				{ kind: "settled", outcome: { kind: "superseded", by: "owner_head" } },
			);
	}
});

for (const repeat of [false, true])
	for (const published of [false, true])
		test(`F10-2 repaired blocking review ${repeat ? "repeats a fingerprint" : "holds for owner feedback"}, published=${published}`, () => {
			const queued = queuedFeedback();

			const oldExecution = queued.accounts.find(
				(a) => a.execution.stage === "review",
			)!.execution;

			assert.ok(oldExecution.stage === "review");
			const oldReview = blockingReceipt(oldExecution);

			const rebuilding = rebuildingFeedback({
				...queued,
				current: { ...queued.current, review: oldReview },
			});

			const changed = {
				...patch,
				round: 1,
				patchDigest: digestOf("blocked-repair"),
			};

			const built = handoffCandidate(rebuilding.state, {
				kind: "repair_settled",
				execution: rebuilding.execution,
				tokens: 10,
				result: { kind: "passed", patch: changed },
			}).state;

			const validating = handoffCandidate(built, readyObservation(built)).state;
			const reviewingState = reviewing(validated(validating));
			const blocking = blockingReceipt(reviewingState.execution);

			const review = repeat
				? blocking
				: {
						...blocking,
						seats: blocking.seats.map((s) => ({
							...s,
							judgments: s.judgments.map((j) => ({
								...j,
								reason: "different defect",
							})),
						})),
					};

			const state = {
				...reviewingState.state,
				published: published ? reviewingState.state.published : null,
			};

			const result = handoffCandidate(state, {
				kind: "review_settled",
				execution: reviewingState.execution,
				tokens: 30,
				result: {
					kind: "passed",
					review,
					patch: { kind: "found", receipt: changed, patch: "blocked-repair" },
				},
			});

			if (repeat) {
				if (published)
					assert.deepEqual(pending(result.state, "post_notice").then, {
						kind: "held",
						reason: "repair_repeated_finding",
					});
				else
					assert.deepEqual(pending(result.state, "finish_pr").terminal, {
						kind: "failed",
						reason: "repair_repeated_finding",
					});
			} else if (published) {
				const summary = pending(result.state, "post_notice");
				assert.deepEqual(summary.then, {
					kind: "held",
					reason: "review_failed",
				});

				const held = selected(
					handoffCandidate(result.state, {
						kind: "effect_completed",
						completion: { kind: "post_notice", request: summary },
					}).state,
				);

				const obs = feedbackObservation(held, 2);
				assert.ok(obs.kind === "read" && obs.batch);
				assert.equal(
					handoffCandidate(held, {
						...readyObservation(held),
						pr: { kind: "open", number: 5, head: obs.head, refHead: obs.head },
					}).effect,
					null,
				);

				const next = handoffCandidate(held, {
					...readyObservation(held),
					pr: { kind: "open", number: 5, head: obs.head, refHead: obs.head },
					feedback: { ...obs, batch: { ...obs.batch, refusedInline: false } },
				});

				const started = pending(next.state, "post_notice");
				assert.equal(started.notice.kind, "repair_started");
				assert.partialDeepStrictEqual(started.then, {
					kind: "repair_due",
					round: 2,
				});
			} else assert.equal(selected(result.state).work.kind, "repair_due");
			assert.ok(parseCandidateState(JSON.parse(JSON.stringify(result.state))));
		});

for (const outcome of [
	"held",
	"complete_handoff",
	"missing_batch",
	"retry",
	"crash_edit",
	"deleted_summary",
	"foreign_key",
	"build_retry",
	"other_applying",
	"start_merge_window",
] as const)
	test(`F10-2 actual ${outcome} summary reconciles a lost POST and recovers its receipt without a rebuild`, async () => {
		const retry = [
			"retry",
			"crash_edit",
			"deleted_summary",
			"foreign_key",
		].includes(outcome);

		const secondAttempt = retry || outcome === "build_retry";

		const success =
			outcome === "complete_handoff" ||
			outcome === "other_applying" ||
			secondAttempt;

		await withLocalArtifactDownload(async (root) => {
			const github = new FakeGitHub();
			const issue = github.add(fakeIssue(pin.issue));

			const pr = github.add(
				fakeIssue(5, { pullRequest: true, labels: ["factory:review"] }),
			);

			const initial = queuedFeedback();
			const head = initial.current.report!.candidateSha;

			const classified = await classifyFeedback({
				controllerLogin: EXE_DEV_PLATFORM.controllerLogin,
				runId: pin.runId,
				pr: 5,
				head,
				seen: [],
				permission: async () => "write",
				events: [
					{
						kind: "review",
						id: feedbackId(repo, "review", 1),
						pr: 5,
						actor: "writer",
						at: "2026-11-07T00:00:00Z",
						state: "CHANGES_REQUESTED",
						commit: head,
						body: "@owner other/repo#1 https://github.com/other/repo/issues/2 fix",
						comments: [
							{
								id: feedbackId(repo, "review-comment", 2),
								path: "test/acceptance/private.ts",
								line: 1,
								commit: head,
								inReplyTo: null,
								body: "PRIVATE-HELDOUT",
							},
						],
					},
				],
			});

			assert.ok(classified.kind === "read" && classified.batch);

			const saved = await storeFeedbackBatch(
				root,
				classified.batch,
				classified.full,
			);

			const queued = {
				...initial,
				feedback: {
					pr: 5,
					seen: saved.seen,
					batches: [
						{
							digest: saved.digest,
							head,
							actionable: true,
							reviews: saved.reviews,
							notice: "posted" as const,
							status: { kind: "queued" as const },
						},
					],
				},
			};

			let state = selected(
				handoffCandidate(queued, readyObservation(queued)).state,
			);

			const started = pending(state, "post_notice");
			let currentHead = head;
			let edits = 0;
			let crashEdit = false;

			const firstReceiptPath = join(
				root,
				"handoff",
				pin.runId,
				"feedback",
				"round-1-a1.json",
			);

			let firstReceipt = "";

			const exec: import("../src/gh.ts").Exec = async (command, args) => {
				if (
					args.includes("PATCH") &&
					args.some((arg) => /issues\/comments\/\d+$/.test(arg))
				) {
					assert.equal(readFileSync(firstReceiptPath, "utf8"), firstReceipt);
					const path = args.find((arg) => /issues\/comments\/\d+$/.test(arg))!;

					const comment = pr.comments.find(
						(c) => c.id === Number(path.split("/").at(-1)),
					);

					assert.ok(comment);
					assert.equal(comment.login, BOT_LOGIN);

					const latest = JSON.parse(
						readFileSync(
							join(root, "handoff", pin.runId, "feedback", "round-1-a2.json"),
							"utf8",
						),
					);

					assert.equal(latest.attempt, 2);
					assert.equal(latest.outcome.kind, "applied");
					assert.equal(statSync(firstReceiptPath).mode & 0o777, 0o600);

					if (crashEdit && outcome !== "retry") {
						crashEdit = false;
						throw new Error("crash after receipt, before summary edit");
					}

					edits++;
					comment.body = args.find((arg) => arg.startsWith("body="))!.slice(5);

					if (crashEdit) {
						crashEdit = false;

						return { code: 1, stderr: "lost PATCH response", stdout: "" };
					}

					return {
						code: 0,
						stderr: "",
						stdout: JSON.stringify({ id: comment.id }),
					};
				}

				if (args.some((arg) => arg.includes("git/ref/heads/factory/pr/")))
					return {
						code: 0,
						stderr: "",
						stdout: JSON.stringify({ object: { sha: currentHead } }),
					};

				if (
					args.includes("DELETE") &&
					args.some((arg) => arg.endsWith("issues/5/labels/factory%3Areview"))
				) {
					pr.labels = pr.labels.filter((l) => l !== "factory:review");

					return { code: 0, stderr: "", stdout: "" };
				}

				if (
					args.includes("POST") &&
					args.some((arg) => arg.endsWith("issues/5/labels"))
				) {
					if (!pr.labels.includes("factory:review"))
						pr.labels.push("factory:review");

					return { code: 0, stderr: "", stdout: JSON.stringify(pr.labels) };
				}

				return github.exec(command, args);
			};

			const port = controllerCandidatePort({
				platform: EXE_DEV_PLATFORM,
				stateDir: root,
				exec,
			});

			const completion = await port.execute(state, started);
			assert.ok(completion?.kind === "post_notice");
			assert.ok(!pr.labels.includes("factory:review"));
			assert.equal(issue.comments.length, 1);

			if (outcome === "start_merge_window") {
				const restored = parseCandidateState(JSON.parse(JSON.stringify(state)));
				assert.ok(restored);

				const merged = handoffCandidate(restored, {
					...observed(),
					pr: {
						kind: "merged",
						number: 5,
						head,
						mergeSha: sha,
						actor: "owner",
					},
				});

				assert.partialDeepStrictEqual(
					pending(merged.state, "finish_pr").terminal,
					{
						kind: "merged",
						assurance: { kind: "factory_verified" },
						readiness: {
							kind: "not_ready",
							reason: "feedback_repair",
							since: started.at,
						},
					},
				);

				return;
			}

			state = selected(
				handoffCandidate(state, { kind: "effect_completed", completion }).state,
			);
			const issued = handoffCandidate(state, readyObservation(state)).state;
			let build = pending(issued, "repair_build");
			state = selected(
				handoffCandidate(issued, {
					kind: "effect_completed",
					completion: { kind: "repair_build", request: build, started: true },
				}).state,
			);

			let request: Extract<
				CandidateEffect,
				{ kind: "complete_handoff" | "post_notice" }
			>;

			if (outcome === "build_retry") {
				state = selected(
					handoffCandidate(state, {
						kind: "repair_settled",
						execution: build.execution,
						tokens: 10,
						result: { kind: "failed" },
					}).state,
				);
				assert.equal(state.work.kind, "repair_due");
				await port.observe(state, 100);
				firstReceipt = readFileSync(firstReceiptPath, "utf8");
				assert.equal(JSON.parse(firstReceipt).outcome.kind, "build_failed");
				const again = handoffCandidate(state, readyObservation(state)).state;
				build = pending(again, "repair_build");
				assert.equal(build.execution.attempt, 2);
				state = selected(
					handoffCandidate(again, {
						kind: "effect_completed",
						completion: { kind: "repair_build", request: build, started: true },
					}).state,
				);
			}

			if (retry) {
				state = selected(
					handoffCandidate(state, {
						kind: "repair_settled",
						execution: build.execution,
						tokens: 10,
						result: { kind: "no_change" },
					}).state,
				);
				const stopped = pending(state, "post_notice");
				const heldCompletion = await port.execute(state, stopped);
				assert.ok(heldCompletion);
				state = selected(
					handoffCandidate(state, {
						kind: "effect_completed",
						completion: heldCompletion,
					}).state,
				);
				assert.equal(state.current.intent.round, 0);
				assert.equal(pr.comments.length, 1);
				firstReceipt = readFileSync(firstReceiptPath, "utf8");
				assert.match(
					pr.comments[0]!.body,
					/Attempt 1[\s\S]*repair_no_progress/,
				);

				if (outcome === "deleted_summary") pr.comments.splice(0);

				if (outcome === "foreign_key")
					github.comment(pr, `forged\n${stopped.notice.key}`, {
						login: "writer",
						type: "User",
					});
				const feedback = feedbackObservation(state, 3);
				assert.ok(feedback.kind === "read" && feedback.batch);

				const next = await classifyFeedback({
					controllerLogin: EXE_DEV_PLATFORM.controllerLogin,
					runId: pin.runId,
					pr: 5,
					head,
					seen: state.feedback!.seen,
					permission: async () => "write",
					events: [
						{
							kind: "review",
							id: feedbackId(repo, "review", 3),
							pr: 5,
							actor: "writer",
							at: "2026-11-07T01:00:00Z",
							state: "CHANGES_REQUESTED",
							commit: head,
							body: "try again",
							comments: [],
						},
					],
				});

				assert.ok(next.kind === "read" && next.batch);
				const stored = await storeFeedbackBatch(root, next.batch, next.full);
				state = selected(
					handoffCandidate(state, {
						...readyObservation(state),
						feedback: { kind: "read", head, dismissed: [], batch: stored },
					}).state,
				);
				const start = pending(state, "post_notice");
				assert.partialDeepStrictEqual(start.then, {
					kind: "repair_due",
					round: 1,
					attempt: 2,
				});
				const startedAgain = await port.execute(state, start);
				assert.ok(startedAgain);
				state = selected(
					handoffCandidate(state, {
						kind: "effect_completed",
						completion: startedAgain,
					}).state,
				);

				const issuedAgain = handoffCandidate(
					state,
					readyObservation(state),
				).state;

				build = pending(issuedAgain, "repair_build");
				state = selected(
					handoffCandidate(issuedAgain, {
						kind: "effect_completed",
						completion: { kind: "repair_build", request: build, started: true },
					}).state,
				);
			}

			if (success) {
				const bytes = "actual-repair";
				const changed = { ...patch, round: 1, patchDigest: digestOf(bytes) };

				const built = handoffCandidate(state, {
					kind: "repair_settled",
					execution: build.execution,
					tokens: 10,
					result: { kind: "passed", patch: changed },
				}).state;

				const validating = handoffCandidate(
					built,
					readyObservation(built),
				).state;

				const review = reviewing(validated(validating));
				state = selected(
					handoffCandidate(review.state, {
						kind: "review_settled",
						execution: review.execution,
						tokens: 10,
						result: {
							kind: "passed",
							review: receipt(review.execution),
							patch: { kind: "found", receipt: changed, patch: bytes },
						},
					}).state,
				);
				state = selected(
					handoffCandidate(state, readyObservation(state)).state,
				);
				request = pending(state, "complete_handoff");
				storePatch(
					root,
					{
						runId: pin.runId,
						baseSha: pin.originalBase,
						contractDigest: pin.contractDigest,
						acceptanceDigest: pin.acceptanceDigest,
						round: 1,
					},
					{
						kind: "collected",
						patch: bytes,
						patchDigest: changed.patchDigest,
						changedPaths: changed.changedPaths,
						policy: "clean",
					},
					{
						model: changed.model,
						observed: null,
						commands: [],
						dispositions: [
							{
								event: feedbackId(repo, "review", retry ? 3 : 1),
								kind: "adopted",
							},
						],
					},
				);
				github.comment(
					issue,
					`already handed off\n<!-- factory:handoff ${pin.runId} ${request.head} -->`,
				);
				github.pulls.set(5, {
					number: 5,
					state: "open",
					merged: false,
					draft: false,
					head: {
						sha: request.head,
						ref: state.published!.branch,
						repo: { full_name: repo },
					},
					base: { ref: "main", repo: { full_name: repo } },
					user: { login: BOT_LOGIN, type: "Bot" },
					body: `<!-- factory:pr ${pin.runId} -->`,
					requested_reviewers: [{ login: "giuseppecrj" }],
				});
			} else {
				state = selected(
					handoffCandidate(state, {
						kind: "repair_settled",
						execution: build.execution,
						tokens: 10,
						result: { kind: "no_change" },
					}).state,
				);
				request = pending(state, "post_notice");

				if (outcome === "held") {
					const resultPath = join(root, "stages", pin.runId);
					mkdirSync(resultPath, { recursive: true });
					writeFileSync(
						join(resultPath, "build-r1-1-result.json"),
						JSON.stringify({
							reason: "repair_no_change",
							dispositions: [
								{
									event: feedbackId(repo, "review", 1),
									kind: "declined",
									reason: "builder_declined",
									detail:
										"Contradicts the contract @owner other/repo#1 https://github.com/other/repo/issues/2 next line",
								},
							],
						}),
						{ mode: 0o600 },
					);
				}
			}

			if (outcome === "other_applying") {
				assert.ok(state.feedback);
				state = {
					...state,
					feedback: {
						...state.feedback,
						batches: [
							{
								...state.feedback.batches[0]!,
								digest: digestOf("unrepaired-other-batch"),
								status: { kind: "applying", round: 1 },
							},
							...state.feedback.batches,
						],
					},
				};
			}

			currentHead = request.kind === "complete_handoff" ? request.head : head;

			if (outcome === "missing_batch")
				rmSync(
					join(root, "handoff", pin.runId, "feedback", `${saved.digest}.json`),
				);

			if (outcome === "crash_edit") crashEdit = true;
			else if (retry && outcome !== "deleted_summary") crashEdit = true;
			else github.posts.push("landed_unanswered");
			assert.equal(
				await controllerCandidatePort({
					platform: EXE_DEV_PLATFORM,
					stateDir: root,
					exec,
				}).execute(state, request),
				null,
			);

			const recovered = await controllerCandidatePort({
				platform: EXE_DEV_PLATFORM,
				stateDir: root,
				exec,
			}).execute(state, request);

			assert.ok(recovered);

			const done = selected(
				handoffCandidate(state, {
					kind: "effect_completed",
					completion: recovered,
				}).state,
			);

			assert.equal(pr.comments.length, outcome === "foreign_key" ? 2 : 1);
			const summary = pr.comments.find((c) => c.login === BOT_LOGIN)!;
			assert.match(
				summary.body,
				success ? /adopted \(builder-reported\)/ : /repair_no_progress/,
			);

			if (retry) {
				assert.match(
					summary.body,
					/Attempt 1[\s\S]*repair_no_progress[\s\S]*Attempt 2[\s\S]*ready after fresh validation and review/,
				);
				assert.equal(readFileSync(firstReceiptPath, "utf8"), firstReceipt);
				assert.equal(edits, outcome === "deleted_summary" ? 0 : 1);
				assert.ok(await port.execute(state, request));
				assert.equal(
					edits,
					outcome === "deleted_summary" ? 0 : 1,
					"unchanged bodies are not PATCHed again",
				);

				if (outcome === "foreign_key")
					assert.match(
						pr.comments.find((c) => c.login === "writer")!.body,
						/^forged/,
					);
			}

			if (outcome === "build_retry") {
				assert.match(
					summary.body,
					/Attempt 1[\s\S]*build_failed[\s\S]*Attempt 2[\s\S]*ready after fresh validation and review/,
				);
				assert.equal(readFileSync(firstReceiptPath, "utf8"), firstReceipt);
			}

			assert.doesNotMatch(
				pr.comments[0]!.body,
				/PRIVATE-HELDOUT|private\.ts|@owner|other\/repo#1|https:\/\/github\.com\/other\/repo/,
			);

			if (outcome === "held") {
				assert.match(
					summary.body,
					/Builder declined: Contradicts the contract/,
				);
				const receipt = JSON.parse(readFileSync(firstReceiptPath, "utf8"));
				assert.equal(receipt.items[0].builder.kind, "declined");
				assert.equal(receipt.items[0].builder.reason, "builder_declined");
			}

			assert.equal(done.work.kind, success ? "waiting" : "held");

			if (outcome === "other_applying") {
				assert.deepEqual(done.feedback?.batches[0]?.status, {
					kind: "applying",
					round: 1,
				});
				assert.partialDeepStrictEqual(done.feedback?.batches[1]?.status, {
					kind: "settled",
					outcome: { kind: "applied" },
				});
			}

			await controllerCandidatePort({
				platform: EXE_DEV_PLATFORM,
				stateDir: root,
				exec,
			}).observe(done, 300);
			const path = join(root, "handoff", pin.runId, "feedback", "round-1.json");
			const bytes = readFileSync(path, "utf8");
			assert.equal(statSync(path).mode & 0o777, 0o600);
			rmSync(path);
			await controllerCandidatePort({
				platform: EXE_DEV_PLATFORM,
				stateDir: root,
				exec,
			}).observe(done, 400);
			assert.equal(readFileSync(path, "utf8"), bytes);
			const index = JSON.parse(bytes);
			assert.equal(index.latestAttempt, secondAttempt ? 2 : 1);
			assert.equal(index.receipt, `round-1-a${secondAttempt ? 2 : 1}.json`);
			assert.equal(index.outcome.kind, success ? "applied" : "stopped");
			assert.equal(pr.comments.length, outcome === "foreign_key" ? 2 : 1);
		});
	});

test("F10-2 legacy-codec replay of lane-a1 book on 984adef carries the queued batch through refresh exactly once", () => {
	// lane-a1-book.txt preserves cursor metadata, not the private full certification.
	// Reconstruct its surrounding book from the F10-1 codec shape and recorded head.
	const fixture = queuedFeedback();
	const original = fixture.current.report!.candidateSha;
	const head = "984adefdf6fd67575dd2b9b28567b40d32b4915d";
	const raw = JSON.parse(JSON.stringify(fixture).replaceAll(original, head));
	delete raw.current.assessmentKind;
	delete raw.current.review;
	raw.feedback.seen = [
		feedbackId(repo, "review", 5812783128),
		feedbackId(repo, "review", 5813332100),
	];
	raw.feedback.batches = [
		{
			digest: digestOf("F10-1 prior non-action batch"),
			head: "58f7d95d553f5885f37ac7bea77458b294f5c0ef",
			actionable: false,
			reviews: [],
			notice: "posted",
			status: { kind: "settled", outcome: { kind: "no_action" } },
		},
		{
			digest: digestOf("F10-1 queued batch"),
			head,
			actionable: true,
			reviews: [feedbackId(repo, "review", 5813332100)],
			notice: "posted",
			status: { kind: "queued" },
		},
	];
	const legacy = parseCandidateState(raw);
	assert.ok(legacy?.kind === "selected");
	const main = "b".repeat(40);
	assert.ok(isGitSha(main));

	const refreshed = certified(
		handoffCandidate(
			{ ...legacy, work: { kind: "handoff" } },
			{ ...readyObservation(legacy), main },
		).state,
	);

	const completing = handoffCandidate(
		refreshed,
		readyObservation(refreshed),
	).state;

	const complete = pending(completing, "complete_handoff");

	const ready = handoffCandidate(completing, {
		kind: "effect_completed",
		completion: { kind: "complete_handoff", request: complete, now: 200 },
	}).state;

	assert.ok(parseCandidateState(JSON.parse(JSON.stringify(ready))));
	const step = handoffCandidate(ready, readyObservation(ready));
	const request = pending(step.state, "post_notice");
	assert.equal(request.notice.kind, "repair_started");
	assert.equal(
		selected(step.state).feedback?.batches.filter(
			(b) => b.status.kind === "applying",
		).length,
		1,
	);
	const twice = handoffCandidate(step.state, readyObservation(ready));
	assert.deepEqual(twice.state, step.state);
	assert.deepEqual(selected(twice.state).feedback?.seen, raw.feedback.seen);
});

test("F10-2 a published hold keeps both work and readiness age across repeated observations", () => {
	const initial = waiting();
	const drift = "e".repeat(40);
	assert.ok(isGitSha(drift));

	const obs = {
		...readyObservation(initial),
		pr: { kind: "open" as const, number: 5, head: drift, refHead: drift },
	};

	const first = handoffCandidate(initial, obs);
	const again = handoffCandidate(first.state, { ...obs, now: 999 });
	assert.equal(selected(again.state).published?.readiness.since, 100);
	const request = pending(again.state, "post_notice");

	const held = selected(
		handoffCandidate(again.state, {
			kind: "effect_completed",
			completion: { kind: "post_notice", request },
		}).state,
	);

	assert.deepEqual(held.work, {
		kind: "owner_due",
		head: drift,
		since: 100,
	});
});

function feedbackObservation(
	state: CandidateState,
	n = 1,
): FeedbackObservation {
	const book = selected(state);

	const head = [...book.history, book.current].find(
		(g) => g.intent.digest === book.published?.promoted.digest,
	)?.report?.candidateSha;

	assert.ok(head);

	return {
		kind: "read",
		head,
		batch: {
			digest: digestOf(`batch-${n}`),
			seen: [feedbackId(pin.repo, "review", n)],
			reviews: [feedbackId(pin.repo, "review", n)],
			actionable: true,
			refusedInline: true,
		},
		dismissed: [],
	};
}

function withFeedback(
	state: CandidateState,
	n = 1,
): Extract<CandidateEvent, { kind: "observed" }> {
	return {
		...readyObservation(state),
		feedback: feedbackObservation(state, n),
	};
}

for (const kind of [
	"waiting",
	"held",
	"rebuilding",
	"reviewing",
	"validate",
	"handoff",
	"repair_due",
	"review_due",
	"repair_built",
] as const)
	test(`feedback double-apply and fall-through preserve one cursor while ${kind}`, () => {
		const initial = waiting();
		const g = initial.current.intent;
		const ref = { round: g.round, generation: g.generation, digest: g.digest };

		const repair = {
			stage: "build",
			id: digestOf("repair"),
			runId: pin.runId,
			round: 1,
			attempt: 1,
			feedbackFrom: ref,
			cause: { kind: "validation", assessment: initial.current.assessment! },
			workflowSha: pin.workflowSha,
			workflowDigest: pin.workflowDigest,
		} as const;

		const review = reviewing(validated(select())).execution;

		const work: Extract<CandidateState, { kind: "selected" }>["work"] =
			kind === "held"
				? ({ kind: "held", reason: "validation_failed", since: 17 } as const)
				: kind === "rebuilding"
					? ({ kind, execution: repair } as const)
					: kind === "reviewing"
						? ({ kind, execution: review } as const)
						: kind === "validate"
							? ({
									kind: "effect",
									request: { kind: "validate", generation: g },
								} as const)
							: kind === "repair_due"
								? ({
										kind,
										round: 1,
										attempt: 1,
										feedbackFrom: ref,
										cause: repair.cause,
									} as const)
								: kind === "repair_built"
									? ({
											kind,
											patch: { ...patch, round: 1 },
											feedbackFrom: ref,
										} as const)
									: kind === "review_due"
										? ({
												kind,
												seats: ["code-review", "security-review", "simplify"],
											} as const)
										: ({ kind } as const);

		const state = { ...initial, work };
		const obs = { ...withFeedback(state), capacityAvailable: false };
		const first = handoffCandidate(state, obs);
		const second = handoffCandidate(first.state, obs);
		assert.ok(
			first.state.kind === "selected" && second.state.kind === "selected",
		);
		assert.deepEqual(second.state.feedback, first.state.feedback);
		assert.equal(second.state.feedback?.batches.length, 1);
		assert.deepEqual(second.state.feedback?.seen, [
			feedbackId(repo, "review", 1),
		]);
		assert.ok(
			new Set(
				[first.effect, second.effect].flatMap((e) =>
					e?.kind === "post_notice" ? [e.notice.key] : [],
				),
			).size <= 1,
		);

		if (["rebuilding", "reviewing", "validate"].includes(kind))
			assert.deepEqual(first.state.work, work);
		assert.deepEqual(first.state.accounts, state.accounts);
		assert.deepEqual(
			first.state.published?.readiness,
			state.published?.readiness,
		);
		assert.deepEqual(first.state.feedback?.batches[0]?.status, {
			kind: "queued",
		});
	});

for (const fault of ["landed_unanswered", "rejected", "lost"] as const)
	test(`C2 actual intake notice reconciles ${fault} without duplicating the comment or settling the batch`, async () => {
		await withLocalArtifactDownload(async (root) => {
			const github = new FakeGitHub();
			const issue = github.add(fakeIssue(pin.issue));
			const initial = waiting();
			const head = initial.current.report!.candidateSha;

			const classified = await classifyFeedback({
				controllerLogin: EXE_DEV_PLATFORM.controllerLogin,
				runId: pin.runId,
				pr: 5,
				head,
				seen: [],
				permission: async () => "write",
				events: [
					{
						kind: "review",
						id: feedbackId(pin.repo, "review", 9),
						pr: 5,
						actor: "writer",
						at: "2026-11-07T00:00:00Z",
						state: "CHANGES_REQUESTED",
						commit: head,
						body: "fix",
						comments: [
							{
								id: feedbackId(pin.repo, "review-comment", 10),
								path: "test/acceptance/a",
								line: 1,
								commit: head,
								inReplyTo: null,
								body: "PRIVATE-REFUSED-TEXT",
							},
						],
					},
				],
			});

			assert.ok(classified.kind === "read" && classified.batch);

			const batch = await storeFeedbackBatch(
				root,
				classified.batch,
				classified.full,
			);

			const step = handoffCandidate(initial, {
				...readyObservation(initial),
				feedback: { kind: "read", head, batch, dismissed: [] },
			});

			const request = pending(step.state, "post_notice");

			github.posts.push(fault);
			assert.equal(
				await controllerCandidatePort({
					platform: EXE_DEV_PLATFORM,
					stateDir: root,
					exec: github.exec,
				}).execute(step.state, request),
				null,
			);

			const completion = await controllerCandidatePort({
				platform: EXE_DEV_PLATFORM,
				stateDir: root,
				exec: github.exec,
			}).execute(step.state, request);

			assert.ok(completion?.kind === "post_notice");
			assert.equal(
				issue.comments.filter((c) => c.login === BOT_LOGIN).length,
				1,
			);
			assert.match(
				issue.comments[0]?.body ?? "",
				/queued for the next stage boundary/,
			);
			assert.match(issue.comments[0]?.body ?? "", /Refused 1 inline comment/);
			assert.doesNotMatch(
				issue.comments[0]?.body ?? "",
				/PRIVATE-REFUSED-TEXT/,
			);

			const done = selected(
				handoffCandidate(step.state, { kind: "effect_completed", completion })
					.state,
			);

			assert.deepEqual(done.feedback?.batches[0]?.status, { kind: "queued" });
			assert.equal(done.feedback?.batches[0]?.notice, "posted");
			assert.deepEqual(done.accounts, initial.accounts);
			assert.deepEqual(done.published?.readiness, initial.published?.readiness);
		});
	});

test("48-comment card overflow advances the stored cursor and posts one visible hold notice", async () => {
	await withLocalArtifactDownload(async (root) => {
		const github = new FakeGitHub();
		const issue = github.add(fakeIssue(pin.issue));
		const initial = waiting();
		const head = initial.current.report!.candidateSha;

		const classified = await classifyFeedback({
			controllerLogin: EXE_DEV_PLATFORM.controllerLogin,
			runId: pin.runId,
			pr: 5,
			head,
			seen: [],
			permission: async () => "write",
			events: [
				{
					kind: "review",
					id: feedbackId(repo, "review", 9),
					pr: 5,
					actor: "writer",
					at: "2026-11-07T00:00:00Z",
					state: "CHANGES_REQUESTED",
					commit: head,
					body: "",
					comments: Array.from({ length: 48 }, (_, n) => ({
						id: feedbackId(repo, "review-comment", 100000 + n),
						path: "src/a.ts",
						line: 1,
						commit: head,
						inReplyTo: null,
						body: "PRIVATE-OVERFLOW-TEXT",
					})),
				},
			],
		});

		assert.ok(
			classified.kind === "read" && classified.batch && classified.full,
		);

		const batch = await storeFeedbackBatch(
			root,
			classified.batch,
			classified.full,
		);

		const step = handoffCandidate(initial, {
			...readyObservation(initial),
			feedback: { kind: "read", head, batch, dismissed: [] },
		});

		const request = pending(step.state, "post_notice");

		assert.equal(request.notice.kind, "feedback_overflow");
		assert.deepEqual(selected(step.state).feedback?.seen, [
			feedbackId(repo, "review", 9),
		]);
		assert.equal(
			selected(step.state).feedback?.batches[0]?.digest,
			batch.digest,
		);
		assert.ok(parseCandidateState(JSON.parse(JSON.stringify(step.state))));
		github.posts.push("lost");
		assert.equal(
			await controllerCandidatePort({
				platform: EXE_DEV_PLATFORM,
				stateDir: root,
				exec: github.exec,
			}).execute(step.state, request),
			null,
		);

		const completion = await controllerCandidatePort({
			platform: EXE_DEV_PLATFORM,
			stateDir: root,
			exec: github.exec,
		}).execute(step.state, request);

		assert.ok(completion?.kind === "post_notice");

		const done = selected(
			handoffCandidate(step.state, { kind: "effect_completed", completion })
				.state,
		);

		assert.deepEqual(done.work, {
			kind: "held",
			reason: "feedback_overflow",
			since: 100,
		});
		assert.deepEqual(done.published, initial.published);
		assert.equal(done.feedback?.overflow?.notice, "posted");
		assert.equal(done.feedback?.batches[0]?.notice, "none");
		assert.equal(issue.comments.length, 1);
		assert.match(issue.comments[0]!.body, /feedback_overflow/);
		assert.doesNotMatch(issue.comments[0]!.body, /PRIVATE-OVERFLOW-TEXT/);

		const dismissed = handoffCandidate(done, {
			...readyObservation(done),
			now: 900,
			feedback: {
				kind: "read",
				head,
				batch: null,
				dismissed: [feedbackId(repo, "review", 9)],
			},
		});

		assert.equal(dismissed.effect, null);
		assert.deepEqual(selected(dismissed.state).work, done.work);
		assert.deepEqual(selected(dismissed.state).feedback?.batches[0]?.status, {
			kind: "settled",
			outcome: { kind: "superseded", by: "dismissed" },
		});

		const replay = await controllerCandidatePort({
			platform: EXE_DEV_PLATFORM,
			stateDir: root,
			exec: github.exec,
		}).execute(step.state, request);

		assert.deepEqual(replay, completion);
		assert.equal(issue.comments.length, 1);
	});
});

test("feedback partial overlap is an all-or-nothing no-op", () => {
	const first = selected(
		handoffCandidate(waiting(), withFeedback(waiting())).state,
	);

	const obs = feedbackObservation(first, 2);
	assert.ok(obs.kind === "read" && obs.batch);

	const overlap = {
		...obs,
		batch: {
			...obs.batch,
			seen: [feedbackId(repo, "review", 1), feedbackId(repo, "review", 2)],
		},
	};

	const result = selected(
		handoffCandidate(first, { ...readyObservation(first), feedback: overlap })
			.state,
	);

	assert.deepEqual(result.feedback, first.feedback);
});

for (const gate of [
	"unpublished",
	"disabled",
	"unverified",
	"pr_identity",
	"pr_ambiguous",
	"merge",
	"close",
	"withdraw",
] as const)
	test(`feedback does not bypass ${gate}`, () => {
		const initial = waiting();

		const state =
			gate === "unpublished"
				? { ...initial, published: null }
				: gate === "pr_identity" || gate === "pr_ambiguous"
					? {
							...initial,
							work: { kind: "held", reason: gate, since: 5 } as const,
						}
					: initial;

		const head = initial.current.report!.candidateSha;

		const obs = {
			...withFeedback(initial),
			executionAllowed: gate !== "disabled",
			eligibility:
				gate === "unverified"
					? "unverified"
					: gate === "withdraw"
						? "withdrawn"
						: "ready",
		} satisfies Extract<CandidateEvent, { kind: "observed" }>;

		if (gate === "merge")
			obs.pr = { kind: "merged", number: 5, head, mergeSha: sha, actor: null };

		if (gate === "close") obs.pr = { kind: "closed", number: 5, head };

		assert.equal(selected(handoffCandidate(state, obs).state).feedback, null);
	});

test("C2/C11 intake notice completes once, retains queued work and restores held since", () => {
	const state = {
		...waiting(),
		work: { kind: "held", reason: "validation_failed", since: 17 } as const,
	};

	const first = handoffCandidate(state, withFeedback(state));
	const request = pending(first.state, "post_notice");
	assert.equal(request.notice.kind, "feedback_intake");
	assert.equal(request.withdraw, null);

	const completed = selected(
		handoffCandidate(first.state, {
			kind: "effect_completed",
			completion: { kind: "post_notice", request },
		}).state,
	);

	assert.deepEqual(completed.work, state.work);
	assert.deepEqual(completed.feedback?.batches[0]?.status, { kind: "queued" });
	assert.equal(completed.feedback?.batches[0]?.notice, "posted");
	const restored = parseCandidateState(JSON.parse(JSON.stringify(completed)));
	assert.ok(restored);

	const next = pending(
		handoffCandidate(restored, withFeedback(restored)).state,
		"post_notice",
	);

	assert.equal(next.notice.kind, "repair_started");
	assert.equal(next.withdraw, "feedback_repair");
});

test("dismissal supersedes a queued batch without re-ingesting the review", () => {
	const initial = waiting();

	const first = selected(
		handoffCandidate(initial, withFeedback(initial)).state,
	);

	const obs = feedbackObservation(first);
	assert.ok(obs.kind === "read");

	const second = selected(
		handoffCandidate(first, {
			...readyObservation(first),
			feedback: {
				...obs,
				batch: null,
				dismissed: [feedbackId(repo, "review", 1)],
			},
		}).state,
	);

	assert.deepEqual(second.feedback?.batches[0]?.status, {
		kind: "settled",
		outcome: { kind: "superseded", by: "dismissed" },
	});
});

for (const limit of ["seen", "batches"] as const)
	test(`feedback ${limit} overflow holds without consuming ids`, () => {
		const initial = waiting();

		const feedback = {
			pr: 5,
			seen:
				limit === "seen"
					? Array.from({ length: MAX_FEEDBACK_SEEN }, (_, n) =>
							feedbackId(repo, "review", 100 + n),
						)
					: [],
			batches:
				limit === "batches"
					? Array.from({ length: MAX_FEEDBACK_BATCHES }, (_, n) => ({
							digest: digestOf(`old-${n}`),
							head: initial.current.report!.candidateSha,
							actionable: false,
							reviews: [],
							notice: "none" as const,
							status: {
								kind: "settled",
								outcome: { kind: "no_action" },
							} as const,
						}))
					: [],
		};

		const state = { ...initial, feedback };
		const step = handoffCandidate(state, withFeedback(state));
		assert.ok(step.state.kind === "selected");
		assert.deepEqual(step.state.feedback?.seen, feedback.seen);
		assert.deepEqual(step.state.feedback?.batches, feedback.batches);
		const request = pending(step.state, "post_notice");
		assert.equal(request.notice.kind, "feedback_overflow");

		const done = selected(
			handoffCandidate(step.state, {
				kind: "effect_completed",
				completion: { kind: "post_notice", request },
			}).state,
		);

		assert.deepEqual(done.work, {
			kind: "held",
			reason: "feedback_overflow",
			since: 100,
		});
		assert.deepEqual(done.published, initial.published);

		const restored = parseCandidateState(JSON.parse(JSON.stringify(done)));
		assert.ok(restored);

		const repeat = handoffCandidate(restored, {
			...withFeedback(restored),
			now: 999,
		});

		assert.equal(repeat.effect, null);
		assert.deepEqual(selected(repeat.state).work, done.work);
	});

test("dismissal is retained when the same observation reaches either cursor cap", () => {
	for (const limit of ["seen", "batches"] as const) {
		const initial = waiting();

		const queued = selected(
			handoffCandidate(initial, withFeedback(initial)).state,
		);

		assert.ok(queued.feedback);

		const state = {
			...queued,
			work: initial.work,
			feedback: {
				...queued.feedback,
				seen:
					limit === "seen"
						? [
								feedbackId(repo, "review", 1),
								...Array.from({ length: MAX_FEEDBACK_SEEN - 1 }, (_, n) =>
									feedbackId(repo, "review", 100 + n),
								),
							].sort()
						: queued.feedback.seen,
				batches:
					limit === "batches"
						? Array.from({ length: MAX_FEEDBACK_BATCHES }, (_, n) => ({
								...queued.feedback!.batches[0]!,
								digest: digestOf(`cap-${n}`),
								notice: "posted" as const,
							}))
						: queued.feedback.batches,
			},
		};

		const feedback = feedbackObservation(state, 2);

		assert.ok(feedback.kind === "read");

		const result = selected(
			handoffCandidate(state, {
				...readyObservation(state),
				feedback: { ...feedback, dismissed: [feedbackId(repo, "review", 1)] },
			}).state,
		);

		assert.ok(
			result.feedback?.batches.every(
				(b) =>
					b.status.kind === "settled" &&
					b.status.outcome.kind === "superseded" &&
					b.status.outcome.by === "dismissed",
			),
		);
	}
});

for (const kind of ["reviewing", "rebuilding", "validate"] as const)
	test(`cursor overflow waits for the ${kind} stage boundary without dropping settlement`, () => {
		const initial = waiting();
		const active = reviewing(validated(select()));
		const ref = initial.current.intent;

		const repair = {
			stage: "build",
			id: digestOf("cap-repair"),
			runId: pin.runId,
			round: 1,
			attempt: 1,
			feedbackFrom: {
				round: ref.round,
				generation: ref.generation,
				digest: ref.digest,
			},
			cause: { kind: "validation", assessment: initial.current.assessment! },
			workflowSha: pin.workflowSha,
			workflowDigest: pin.workflowDigest,
		} as const;

		const work =
			kind === "reviewing"
				? active.state.work
				: kind === "rebuilding"
					? ({ kind, execution: repair } as const)
					: ({
							kind: "effect",
							request: { kind: "validate", generation: ref },
						} as const);

		const state = {
			...initial,
			work,
			accounts:
				kind === "reviewing"
					? active.state.accounts
					: kind === "rebuilding"
						? [
								...initial.accounts,
								{
									execution: repair,
									spend: { kind: "known", tokens: 0 } as const,
									settlement: "running" as const,
								},
							]
						: initial.accounts,
			feedback: {
				pr: 5,
				seen: Array.from({ length: MAX_FEEDBACK_SEEN }, (_, n) =>
					feedbackId(repo, "review", 100 + n),
				).sort(),
				batches: [],
			},
		};

		const obs = withFeedback(state);
		const step = handoffCandidate(state, obs);
		assert.deepEqual(selected(step.state).work, work);
		assert.deepEqual(selected(step.state).published, state.published);
		assert.deepEqual(selected(step.state).accounts, state.accounts);
		assert.ok(parseCandidateState(JSON.parse(JSON.stringify(step.state))));

		const settlement: CandidateEvent =
			kind === "reviewing"
				? {
						kind: "review_settled",
						execution: active.execution,
						tokens: 30,
						result: {
							kind: "passed",
							patch: { kind: "found", receipt: patch, patch: "patch" },
							review: receipt(active.execution),
						},
					}
				: kind === "rebuilding"
					? {
							kind: "repair_settled",
							execution: repair,
							tokens: 10,
							result: {
								kind: "passed",
								patch: {
									...patch,
									round: 1,
									patchDigest: digestOf("cap-repaired"),
								},
							},
						}
					: {
							kind: "effect_completed",
							completion: {
								kind: "validate",
								request: { kind: "validate", generation: ref },
								result: {
									kind: "failed",
									validation: null,
									reason: "evidence_unavailable",
								},
							},
						};

		const expected = selected(handoffCandidate(state, settlement).state);
		const actual = selected(handoffCandidate(step.state, settlement).state);

		assert.deepEqual(actual.current, expected.current);
		assert.deepEqual(actual.accounts, expected.accounts);
		assert.deepEqual(actual.work, expected.work);
		assert.equal(
			actual.work.kind,
			kind === "reviewing"
				? "handoff"
				: kind === "rebuilding"
					? "repair_built"
					: "held",
		);
	});

test("feedback full status/outcome codec and pre-F10 books round-trip", () => {
	const first = selected(
		handoffCandidate(waiting(), withFeedback(waiting())).state,
	);

	const statuses: FeedbackBatchStatus[] = [
		{ kind: "queued" },
		{ kind: "applying", round: 1 },
		{ kind: "applying", round: 2 },
		...(
			[
				{ kind: "no_action" },
				{ kind: "applied", head: sha },
				{ kind: "stopped", reason: "validation_failed" },
				{ kind: "superseded", by: "promotion" },
				{ kind: "superseded", by: "owner_head" },
				{ kind: "superseded", by: "dismissed" },
				{ kind: "merged", mergeSha: sha },
				{ kind: "refused", reason: "cap_reached" },
				{ kind: "refused", reason: "repair_unavailable" },
				{ kind: "refused", reason: "owner_authored_head" },
			] as const
		).map((outcome) => ({ kind: "settled" as const, outcome })),
	];

	for (const status of statuses) {
		assert.ok(first.feedback);

		const book = {
			...first,
			feedback: {
				...first.feedback,
				batches: first.feedback.batches.map((b) => ({ ...b, status })),
			},
		};

		assert.deepEqual(
			parseCandidateState(JSON.parse(JSON.stringify(book))),
			book,
		);
	}

	for (const status of [
		{ kind: "future" },
		{ kind: "applying", round: 3 },
		{ kind: "settled", outcome: { kind: "refused", reason: "future" } },
	]) {
		const book = JSON.parse(JSON.stringify(first));
		book.feedback.batches[0].status = status;
		assert.equal(parseCandidateState(book), null);
	}

	const legacy = JSON.parse(JSON.stringify(waiting()));
	delete legacy.feedback;
	assert.deepEqual(parseCandidateState(legacy), {
		...waiting(),
		feedback: null,
	});
});
