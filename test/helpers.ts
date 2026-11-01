import assert from "node:assert/strict";
import {
	type Digest,
	digestOf,
	runIdOf,
	type Run,
	startRun,
	type TicketRef,
	type Verdict,
	REQUIRED_CI_CHECKS,
} from "../src/run.ts";
import { advance, type RunEvent } from "../src/stages.ts";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
	beginCandidate,
	candidateGenerations,
	handoffCandidate,
	parseCandidateState,
	type AdmissionPin,
	type CandidateEvent,
	type CandidateState,
} from "../src/handoff.ts";
import { candidateBranch } from "../src/publication.ts";
import { dispatchNonce, type ValidationState } from "../src/validation.ts";
import type { PatchReceipt } from "../src/build.ts";
import { isGitSha, isRepoSlug } from "../src/workflow.ts";

export async function withLocalArtifactDownload<T>(
	run: (root: string) => Promise<T>,
): Promise<T> {
	const root = mkdtempSync(join(tmpdir(), "factory-artifact-test-"));
	const bin = join(root, "bin");
	mkdirSync(bin);
	writeFileSync(join(bin, "gh"), "#!/bin/sh\nprintf 'local-test-artifact'\n", {
		mode: 0o755,
	});
	const previous = process.env.PATH;
	process.env.PATH = `${bin}:${previous ?? ""}`;

	try {
		return await run(root);
	} finally {
		if (previous === undefined) delete process.env.PATH;
		else process.env.PATH = previous;
		rmSync(root, { recursive: true, force: true });
	}
}

export const ticket: TicketRef = {
	provider: "github",
	key: "giuseppecrj/pi-herdr-factorio#42",
	url: "https://github.com/giuseppecrj/pi-herdr-factorio/issues/42",
};

export const contractDigest = digestOf("contract");
export const acceptanceDigest = digestOf("acceptance");
const repo = "giuseppecrj/pi-herdr-factorio";
const base = "a".repeat(40);

if (!isRepoSlug(repo) || !isGitSha(base)) throw new Error("fixture");

export const admissionPin: AdmissionPin = {
	runId: digestOf("run"),
	repo,
	issue: 42,
	originalBase: base,
	workflowSha: base,
	workflowDigest: digestOf("workflow"),
	contractDigest,
	acceptanceDigest,
	maxTokens: 500_000,
	maxReviewAttempts: 3,
};

export function candidateLifecycleFixture() {
	const pin = {
		...admissionPin,
		issue: 1,
		runId: runIdOf({ repo, issue: 1, eventId: "1" }),
	};

	const patch: PatchReceipt = {
		version: 1,
		runId: pin.runId,
		round: 0,
		baseSha: base,
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

	const select = (state: CandidateState) => {
		assert.equal(state.kind, "selected");

		return state;
	};

	const observation = (
		state: CandidateState,
		main = base,
	): Extract<CandidateEvent, { kind: "observed" }> => {
		assert.ok(isGitSha(main));
		const published = state.kind === "selected" ? state.published : null;

		const previous =
			state.kind === "selected"
				? candidateGenerations(state).find(
						(g) => g.intent.digest === published?.promoted.digest,
					)?.report
				: null;

		const report = state.kind === "selected" ? state.current.report : null;

		return {
			kind: "observed",
			now: 100,
			main,
			pr:
				published !== null && previous != null
					? {
							kind: "open",
							number: published.number,
							head: previous.candidateSha,
							refHead: previous.candidateSha,
						}
					: { kind: "none" },
			executionAllowed: true,
			capacityAvailable: true,
			eligibility: "ready",
			readiness:
				report != null
					? { kind: "current", head: report.candidateSha, report }
					: { kind: "unavailable" },
		};
	};

	let state = select(
		handoffCandidate(
			beginCandidate(pin, patch, 20),
			observation(beginCandidate(pin, patch, 20)),
		).state,
	);

	for (let generation = 0; generation < 2; generation++) {
		const request = state.work.kind === "effect" ? state.work.request : null;
		assert.ok(request?.kind === "validate");
		const g = request.generation;
		const head = digestOf(g.digest).slice(0, 40);
		assert.ok(isGitSha(head));

		const validation: ValidationState = {
			version: 2,
			generation: {
				index: g.generation,
				digest: g.digest,
				previousHead:
					g.publication.kind === "successor"
						? g.publication.expectedHead
						: null,
			},
			startedAt: 1,
			deadline: 200,
			round: g.round,
			originalBase: pin.originalBase,
			baseSha: g.baseSha,
			baseResolved: true,
			publication: {
				branch: candidateBranch(1, pin.runId, g.round, g.generation),
				patchSha: head,
				candidateSha: head,
			},
			dispatchTry: 1,
			dispatchedAt: 2,
			ciRunId: 123 + generation,
			counters: {},
		};

		const verdict = {
			...passingVerdict(patch.patchDigest),
			candidateSha: head,
			baseSha: g.baseSha,
			gateSha: g.baseSha,
			ciRunId: 123 + generation,
		};

		const nonce = dispatchNonce(pin.runId, g.round, 1, g.generation);

		const report = {
			candidateSha: head,
			gateSha: g.baseSha,
			ciRunId: verdict.ciRunId,
			reportId: 456 + generation,
			nonce,
			heldoutDigest: verdict.heldoutDigest,
			externalId: `factory-gates:${verdict.ciRunId}:${nonce}`,
		};

		state = select(
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

		state = select(
			handoffCandidate(state, observation(state, g.baseSha)).state,
		);

		const review = state.work.kind === "effect" ? state.work.request : null;
		assert.ok(review?.kind === "launch_review");
		state = select(
			handoffCandidate(state, {
				kind: "effect_completed",
				completion: { kind: "launch_review", request: review, started: true },
			}).state,
		);

		state = select(
			handoffCandidate(state, {
				kind: "review_settled",
				execution: review.execution,
				tokens: 10,
				result: {
					kind: "passed",
					patch: { kind: "found", receipt: patch, patch: "patch" },
					review: {
						...review.execution.binding,
						version: 1,
						r8: "incomplete",
						blocking: false,
						seats: review.execution.seats.map((seat) => ({
							seat,
							findings: [],
							judgments: [],
							requested: "openai/gpt-6.1-sol",
							observed: null,
							label:
								"context-isolated, same model, same family, not cross-family",
							fallback: false,
							tokens: 1,
						})),
					},
				},
			}).state,
		);

		if (generation === 0) {
			state = select(handoffCandidate(state, observation(state)).state);
			const open = state.work.kind === "effect" ? state.work.request : null;
			assert.ok(open?.kind === "open_pr");
			state = select(
				handoffCandidate(state, {
					kind: "effect_completed",
					completion: {
						kind: "open_pr",
						request: open,
						number: 5,
						head: open.head,
						refHead: open.head,
					},
				}).state,
			);
			state = select(handoffCandidate(state, observation(state)).state);
			const ready = state.work.kind === "effect" ? state.work.request : null;
			assert.ok(ready?.kind === "complete_handoff");
			state = select(
				handoffCandidate(state, {
					kind: "effect_completed",
					completion: { kind: "complete_handoff", request: ready, now: 100 },
				}).state,
			);
		}

		state = select(
			handoffCandidate(
				state,
				observation(state, generation === 0 ? "b".repeat(40) : "d".repeat(40)),
			).state,
		);
	}

	const request = state.work.kind === "effect" ? state.work.request : null;
	assert.ok(request?.kind === "validate");
	const g = request.generation;

	const current: ValidationState = {
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
		originalBase: pin.originalBase,
		baseSha: g.baseSha,
		baseResolved: true,
		publication: {
			branch: candidateBranch(1, pin.runId, g.round, g.generation),
			patchSha: pin.originalBase,
			candidateSha: pin.originalBase,
		},
		dispatchTry: 1,
		dispatchedAt: 2,
		ciRunId: 125,
		counters: {},
	};

	state = select(
		handoffCandidate(state, {
			kind: "effect_completed",
			completion: {
				kind: "validate",
				request,
				result: { kind: "waiting", validation: current },
			},
		}).state,
	);
	assert.ok(parseCandidateState(JSON.parse(JSON.stringify(state))));

	return state;
}

export function patch(name: string): Digest {
	return digestOf(`patch:${name}`);
}

export function newRun(): Run {
	return startRun({ id: admissionPin.runId, ticket, repo, baseSha: base });
}

export const ciCandidate = {
	candidateSha: "c".repeat(40),
	heldoutDigest: digestOf("heldout"),
	ciRunId: 123,
};

export function passingVerdict(patchDigest: Digest): Verdict {
	return {
		patchDigest,
		acceptanceDigest,
		...ciCandidate,
		gateSha: base,
		originalBase: base,
		baseSha: base,
		unjudged: [],
		pass: true,
		requiredChecks: [...REQUIRED_CI_CHECKS],
		checks: REQUIRED_CI_CHECKS.map((name) => ({ name, passed: true })),
	};
}

export function failingVerdict(patchDigest: Digest): Verdict {
	const verdict = passingVerdict(patchDigest);

	return {
		...verdict,
		pass: false,
		checks: verdict.checks.map((check) =>
			check.name === "heldout"
				? { ...check, passed: false, detail: "1 failing" }
				: check,
		),
	};
}

export function patchReceipt(name = "first"): PatchReceipt {
	return {
		version: 1,
		runId: admissionPin.runId,
		round: 0,
		baseSha: base,
		contractDigest,
		acceptanceDigest,
		patchDigest: patch(name),
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
}

export function builtEvent(
	name = "first",
): Extract<RunEvent, { kind: "built" }> {
	return {
		kind: "built",
		pin: admissionPin,
		patch: patchReceipt(name),
		priorTokens: 1234,
	};
}

export function apply(run: Run, ...events: RunEvent[]): Run {
	let current = run;

	for (const event of events) {
		const result = advance(current, event);
		assert.equal(
			result.kind,
			"advanced",
			`${event.kind} rejected: ${result.kind === "invalid" ? result.reason : ""}`,
		);
		current = result.run;
	}

	return current;
}

export function reachBuild(): Run {
	return apply(
		newRun(),
		{ kind: "admitted" },
		{ kind: "specified", contractDigest },
		{ kind: "accepted", acceptanceDigest },
	);
}

export function stageOf(run: Run): string {
	return run.progress.kind === "active"
		? run.progress.stage
		: run.progress.kind;
}
