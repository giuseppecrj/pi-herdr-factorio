import assert from "node:assert/strict";
import { test } from "node:test";
import {
	beginCandidate,
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
	REQUIRED_CI_CHECKS,
	type Verdict,
	type Run,
} from "../src/run.ts";
import { advance } from "../src/stages.ts";
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
import type { PatchReceipt } from "../src/build.ts";
import { controllerCandidatePort } from "../server/controller.ts";
import { fileAdmissionStore } from "../src/admission.ts";
import { CONTROLLER_LOGIN } from "../src/markers.ts";
import { verdictAssessment, withLocalArtifactDownload } from "./helpers.ts";
import { readFileSync } from "node:fs";
import { fieldOf, objectOf, parseJson } from "../server/sandbox/json.ts";

const sha = "a".repeat(40);
const repo = "giuseppecrj/pi-herdr-factorio";

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
	maxTokens: 500_000,
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
) {
	const request = pending(state, "validate");
	const g = request.generation;
	const head = digestOf(JSON.stringify(g)).slice(0, 40);
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
	assert.equal(candidateAllowance(next.state, next.execution), 29_900);
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
	assert.equal(candidateAllowance(next.state, next.execution), 10_000);

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
	assert.equal(candidateAllowance(selected(state), next.execution), 29_700);
});

for (const spent of [29_999, 30_000, 30_001])
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

		if (spent < 30_000) {
			const request = pending(next.state, "launch_review");
			assert.equal(
				candidateAllowance(selected(next.state), request.execution),
				1,
			);
		} else assert.notEqual(next.effect?.kind, "launch_review");
	});

for (const prior of [499_999, 500_000, 500_001])
	test(`formal run preflight preserves past-stage cap boundary ${prior}`, () => {
		const state = validated(
			handoffCandidate(beginCandidate(pin, patch, prior), observed()).state,
		);

		const next = handoffCandidate(state, observed());
		assert.equal(candidateUsage(next.state), prior);

		if (prior < 500_000) {
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

		if (spent < REPAIR_BUILD_MAX_TOKENS) {
			const retry = pending(next.state, "repair_build");
			assert.equal(retry.execution.attempt, 2);
			assert.equal(
				candidateAllowance(selected(next.state), retry.execution),
				1,
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
