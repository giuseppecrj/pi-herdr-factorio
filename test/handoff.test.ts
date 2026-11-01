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
	parseCandidateState,
} from "../src/handoff.ts";
import {
	digestOf,
	REQUIRED_CI_CHECKS,
	type Verdict,
	type Run,
} from "../src/run.ts";
import { advance } from "../src/stages.ts";
import type { ReviewReceipt } from "../src/review.ts";
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
import { withLocalArtifactDownload } from "./helpers.ts";
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

function validated(state: CandidateState, passes = true) {
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
		version: 1,
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
			50_000,
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
						review: { ...receipt(active.execution), blocking: true },
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
