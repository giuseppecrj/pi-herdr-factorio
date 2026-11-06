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
	verdictPasses,
} from "../src/run.ts";
import { advance, type RunEvent } from "../src/stages.ts";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, cpSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { fileRunFiles } from "../server/controller.ts";
import { sandboxExecutor } from "../server/sandbox.ts";
import { collectPatch, storePatch, finishPatch } from "../src/build.ts";
import {
	contractBytes,
	contractDigestOf,
	isContractDigest,
	type Contract,
} from "../src/specify.ts";
import { writeAcceptance } from "../src/accept.ts";
import {
	assessBase,
	classifyFailure,
	type AcceptanceBinding,
	type BaseProof,
	type BaseReceipt,
	type FailureClass,
	type HeldoutReplay,
} from "../src/diagnosis.ts";
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
	type ReviewExecution,
} from "../src/handoff.ts";
import { candidateBranch } from "../src/publication.ts";
import {
	assessmentBinding,
	assessmentBytes,
	dispatchNonce,
	readAssessmentBytes,
	type ReadAssessment,
	type ValidationAssessment,
	type ValidationState,
} from "../src/validation.ts";
import type { PatchReceipt } from "../src/build.ts";
import { isGitSha, isRepoSlug } from "../src/workflow.ts";
import {
	fakeIssue,
	MAIN_SHA,
	TRUSTED_RUN_CAP,
	TRUSTED_WORKFLOW,
} from "./fake-ticket-adapter.ts";

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
	maxTokens: TRUSTED_RUN_CAP,
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
						assessment: verdictAssessment(
							pin.runId,
							g.round,
							g.generation,
							verdict,
						),
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
						version: 2,
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

export async function preparedReviewFixture(
	attempt: 1 | 2 = 1,
	large = false,
	controller = false,
) {
	const root = mkdtempSync(join(tmpdir(), "factory-prepared-review-"));

	const state = join(root, "state"),
		base = join(root, "base"),
		work = join(root, "work");

	const workflow = controller
		? TRUSTED_WORKFLOW
		: `---\nrepository: ${repo}\n---\n## review\nReview the candidate. Café.\n`;

	const baseSha = controller ? MAIN_SHA : admissionPin.originalBase;
	assert.ok(isGitSha(baseSha));
	mkdirSync(join(base, ".github/factory"), { recursive: true });
	mkdirSync(join(base, "src"));
	writeFileSync(join(base, ".github/factory/WORKFLOW.md"), workflow);
	writeFileSync(join(base, "src/a.ts"), "export const value = 0;");

	if (large)
		for (let i = 0; i < 4000; i++)
			writeFileSync(
				join(base, "src", `${"x".repeat(80)}-${i}.ts`),
				"export {};\n",
			);
	cpSync(base, work, { recursive: true });
	writeFileSync(join(work, "src/a.ts"), "export const value = 1;");

	const runId = controller
		? runIdOf({ repo: admissionPin.repo, issue: 1, eventId: "1" })
		: digestOf("prepared review fixture");

	const issue = fakeIssue(1);

	const contract: Contract = {
		version: 2,
		runId,
		issue: 1,
		base: { repo: admissionPin.repo, sha: baseSha },
		snapshot: {
			digest: controller
				? digestOf(JSON.stringify([issue.title, issue.body]))
				: digestOf("snapshot"),
			source: "unedited",
			eventId: "1",
			eventAt: "2026-10-31T00:00:00Z",
		},
		link: null,
		summary: "Export one",
		behavior: ["Export one"],
		exclusions: [],
		acceptance: [{ id: "A1", kind: "new_behavior", text: "Value is one" }],
		compatibility: [],
		limits: [],
		files: ["src/a.ts"],
		evidence: [],
	};

	const bytes = contractBytes(contract),
		digest = contractDigestOf(bytes);

	const files = fileRunFiles(state);
	assert.equal(await files.writeContract({ contract, bytes, digest }), true);

	const accepted = writeAcceptance(
		JSON.stringify({
			version: 2,
			scenarios: [
				{ id: "S1", criteria: ["A1"], checks: [], judge: "Value is one" },
				{ id: "S2", criteria: ["A1"], checks: ["value.test.ts"], judge: null },
			],
			files: [
				{
					path: "value.test.ts",
					type: "node:test",
					content: "import {test} from 'node:test'; test('value',()=>{});",
				},
			],
		}),
		contract,
	);

	assert.ok(accepted.kind === "suite");

	const suite = await files.artifacts.store({
		contract,
		contractDigest: digest,
		suite: accepted.suite,
		model: "openai/gpt-6.1-sol",
		observed: null,
	});

	assert.ok(suite.kind === "found");
	const patch = await collectPatch({ base, workspace: work });
	assert.ok(patch.kind === "collected");

	const binding = {
		runId,
		baseSha: contract.base.sha,
		contractDigest: digest,
		acceptanceDigest: suite.receipt.acceptanceDigest,
	};

	storePatch(state, binding, patch, {
		model: "openai/gpt-6.1-sol",
		observed: null,
		commands: [],
	});

	const kept = finishPatch(state, binding, {
		command: "test",
		exitCode: 0,
		tail: "",
		wallMs: 0,
	});

	assert.ok(kept.kind === "found");

	const verdict = {
		...passingVerdict(patch.patchDigest),
		originalBase: baseSha,
		baseSha,
		gateSha: baseSha,
		acceptanceDigest: suite.receipt.acceptanceDigest,
		unjudged: ["S1"],
	};

	let { book, execution } = issuedReviewFixture(
		{
			...admissionPin,
			runId,
			issue: 1,
			originalBase: baseSha,
			workflowSha: baseSha,
			workflowDigest: digestOf(workflow),
			contractDigest: digest,
			acceptanceDigest: suite.receipt.acceptanceDigest,
		},
		kept.receipt,
		verdict,
	);

	if (attempt === 2) {
		let next = handoffCandidate(book, {
			kind: "effect_completed",
			completion: {
				kind: "launch_review",
				request: { kind: "launch_review", execution },
				started: true,
			},
		}).state;

		next = handoffCandidate(next, {
			kind: "review_settled",
			execution,
			tokens: 20,
			result: { kind: "failed" },
		}).state;
		next = handoffCandidate(next, {
			kind: "observed",
			now: 100,
			main: admissionPin.originalBase,
			pr: { kind: "none" },
			executionAllowed: true,
			capacityAvailable: true,
			eligibility: "ready",
			readiness: { kind: "unavailable" },
		}).state;
		assert.ok(
			next.kind === "selected" &&
				next.work.kind === "effect" &&
				next.work.request.kind === "launch_review",
		);
		book = next;
		execution = next.work.request.execution;
	}

	assert.equal(
		await files.writeClaim({
			runId,
			issue: 1,
			eventId: "1",
			seq: 1,
			status: "running",
			stage: "review",
			attempt,
			round: 0,
			usage: attempt === 1 ? 20 : 40,
			handoff: book,
		}),
		true,
	);
	const validation = join(state, "validation", runId);
	writeFileSync(join(validation, "verdict.json"), JSON.stringify(verdict), {
		mode: 0o600,
	});
	writeFileSync(
		join(validation, "receipt.json"),
		JSON.stringify({ modelCalls: 0, candidateSha: verdict.candidateSha }),
		{ mode: 0o600 },
	);

	const archive = execFileSync(
		"tar",
		["-czf", "-", "--transform=s,^,repo/,", ".github", "src"],
		{ cwd: base },
	);

	const cleanupRequests: { command: string; args: readonly string[] }[] = [];

	const config = {
		stateDir: state,
		exec: async (command: string, args: readonly string[]) => {
			cleanupRequests.push({ command, args });
			assert.equal(command, "gh");
			assert.deepEqual(args, [
				"api",
				"--method",
				"GET",
				`repos/${repo}/git/ref/heads/${candidateBranch(1, runId, 0, 0)}`,
			]);

			return { code: 1, stdout: "", stderr: "HTTP 404: Not Found" };
		},
		log: () => {},
		xdgRuntimeDir: join(root, "xdg"),
		fetchTarball: async (requestedRepo: string, ref: string) => {
			assert.equal(requestedRepo, repo);
			assert.equal(ref, baseSha);

			return archive;
		},
	};

	const executor = sandboxExecutor(config);

	const args = {
		runId,
		round: 0,
		execution,
		workflowSha: execution.workflowSha,
		workflowDigest: execution.workflowDigest,
		workspace: join(root, "review"),
	};

	const prepared = await executor.prepareReview!(args);

	return {
		root,
		state,
		files,
		book,
		execution,
		prepared,
		executor,
		contract,
		kept,
		config,
		cleanupRequests,
		args,
		dir: join(state, "stages", runId, `review-r0-${attempt}`),
		close: () => rmSync(root, { recursive: true, force: true }),
	};
}

export function issuedReviewFixture(
	pin: AdmissionPin,
	patch: PatchReceipt,
	verdict: Verdict,
	seats: ReviewExecution["seats"] = [
		"code-review",
		"security-review",
		"simplify",
	],
) {
	assert.ok(isGitSha(verdict.baseSha));

	const observation: Extract<CandidateEvent, { kind: "observed" }> = {
		kind: "observed",
		now: 100,
		main: verdict.baseSha,
		pr: { kind: "none" },
		executionAllowed: true,
		capacityAvailable: true,
		eligibility: "ready",
		readiness: { kind: "unavailable" },
	};

	let state = handoffCandidate(
		beginCandidate(pin, patch, 20),
		observation,
	).state;

	assert.ok(
		state.kind === "selected" &&
			state.work.kind === "effect" &&
			state.work.request.kind === "validate",
	);
	const request = state.work.request;
	const g = request.generation;
	const nonce = dispatchNonce(pin.runId, g.round, 1, g.generation);

	const report = {
		candidateSha: verdict.candidateSha,
		gateSha: verdict.gateSha,
		ciRunId: verdict.ciRunId,
		reportId: 456,
		nonce,
		heldoutDigest: verdict.heldoutDigest,
		externalId: `factory-gates:${verdict.ciRunId}:${nonce}`,
	};

	assert.ok(
		isGitSha(report.candidateSha) &&
			isGitSha(report.gateSha) &&
			isGitSha(verdict.baseSha),
	);
	state = handoffCandidate(state, {
		kind: "effect_completed",
		completion: {
			kind: "validate",
			request,
			result: {
				kind: "finished",
				verdict,
				report: {
					...report,
					candidateSha: report.candidateSha,
					gateSha: report.gateSha,
				},
				seats,
				assessment: verdictAssessment(
					pin.runId,
					g.round,
					g.generation,
					verdict,
				),
				validation: {
					version: 2,
					generation: { index: 0, digest: g.digest, previousHead: null },
					startedAt: 1,
					deadline: 200,
					round: 0,
					originalBase: pin.originalBase,
					baseSha: verdict.baseSha,
					baseResolved: true,
					publication: {
						branch: candidateBranch(pin.issue, pin.runId, 0, 0),
						patchSha: report.candidateSha,
						candidateSha: report.candidateSha,
					},
					dispatchTry: 1,
					dispatchedAt: 2,
					ciRunId: verdict.ciRunId,
					counters: {},
				},
			},
		},
	}).state;
	state = handoffCandidate(state, observation).state;
	assert.ok(
		state.kind === "selected" &&
			state.work.kind === "effect" &&
			state.work.request.kind === "launch_review",
	);
	assert.ok(parseCandidateState(JSON.parse(JSON.stringify(state))));

	return { book: state, execution: state.work.request.execution };
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

export function qualifiedProof(binding: AcceptanceBinding): BaseProof {
	const execution = {
		kind: "observed",
		exitCode: 1,
		wallMs: 1,
		files: [
			{
				file: "a.test.ts",
				registered: 1,
				failures: [
					{
						file: "a.test.ts",
						name: "red",
						message: "assertion",
						kind: "assertion",
						code: "ERR_ASSERTION",
					},
				],
			},
		],
	} as const;

	const { assessment } = assessBase({
		binding,
		runtime: {
			runner: "unit-policy",
			node: process.version,
			platform: process.platform,
			bwrap: "unit",
			protocolDigest: digestOf("protocol"),
		},
		startedAt: 0,
		finishedAt: 1,
		source: {
			kind: "ready",
			treeDigest: digestOf("tree"),
			lockDigest: digestOf("lock"),
			gatesDigest: digestOf("gates"),
		},
		execution,
		repeat: execution,
		scenarios: [
			{
				scenario: "S1",
				kind: "new_behavior",
				mode: "checked",
				file: "a.test.ts",
				oracleKey: {
					contractScopeDigest: digestOf("scope"),
					criteriaDigest: digestOf("criteria"),
					sourceDigest: digestOf("source"),
				},
			},
		],
	});

	assert.ok(assessment.kind === "ready");

	return assessment.proof;
}

export function acceptedEvent(): Extract<RunEvent, { kind: "accepted" }> {
	const c = contractDigest;
	assert.ok(isContractDigest(c));

	return {
		kind: "accepted",
		proof: qualifiedProof({
			runId: admissionPin.runId,
			repo: admissionPin.repo,
			issue: admissionPin.issue,
			contractDigest: c,
			acceptanceDigest,
			baseSha: admissionPin.originalBase,
			gateSha: admissionPin.originalBase,
		}),
	};
}

export function reachBuild(): Run {
	return apply(
		newRun(),
		{ kind: "admitted" },
		{ kind: "specified", contractDigest },
		acceptedEvent(),
	);
}

export function stageOf(run: Run): string {
	return run.progress.kind === "active"
		? run.progress.stage
		: run.progress.kind;
}

export function storedAssessment(input: {
	runId: Digest;
	round: number;
	generation: number;
	verdict: Verdict;
	assessment: ValidationAssessment;
}) {
	const text = assessmentBytes(assessmentBinding(input), input.assessment);
	const read = readAssessmentBytes(text);
	assert.ok(read !== null);

	return { text, read: read satisfies ReadAssessment };
}

const heldoutFiles = [
	"test/acceptance/9/checks/a.test.mjs",
	"test/acceptance/9/checks/b.test.mjs",
] as const;

function replayTree(
	failing: boolean,
	kind: "assertion" | "load_error",
): HeldoutReplay & { kind: "observed" } extends { gate: infer T } ? T : never {
	const [first] = heldoutFiles;
	const zero = failing && kind === "load_error";

	return {
		execution: {
			kind: "observed",
			exitCode: failing ? 1 : 0,
			wallMs: 1,
			files: heldoutFiles.map((file) => ({
				file,
				registered: file === first && zero ? 0 : 1,
				failures:
					failing && file === first
						? [
								{
									file,
									name: "check",
									message: "m",
									code: kind === "assertion" ? "ERR_ASSERTION" : null,
									kind,
								},
							]
						: [],
			})),
		},
		projection: {
			counts: Object.fromEntries(
				heldoutFiles.map((f) => [f, f === first && zero ? 0 : 1]),
			),
			failed: failing ? [first] : [],
			passed: !failing,
		},
	};
}

export function classifiedCase(
	scenario: "tree_disagreement" | "candidate_load_error",
): FailureClass {
	const [first, second] = heldoutFiles;
	const gate = base;
	const candidate = "c".repeat(40);
	const kind = scenario === "candidate_load_error" ? "load_error" : "assertion";
	const baseContract = contractDigestOf("contract");
	assert.ok(isGitSha(gate) && isGitSha(candidate) && isRepoSlug(repo));
	const checks = [...REQUIRED_CI_CHECKS];

	const baseReceipt: BaseReceipt = {
		evidence: {
			binding: {
				runId: digestOf("r"),
				repo,
				issue: 9,
				contractDigest: baseContract,
				acceptanceDigest,
				baseSha: gate,
				gateSha: gate,
			},
			runtime: {
				runner: "local-bwrap",
				node: "v",
				platform: "p",
				bwrap: "b",
				protocolDigest: digestOf("p"),
			},
			startedAt: 1,
			finishedAt: 2,
			source: {
				kind: "ready",
				treeDigest: digestOf("t"),
				lockDigest: digestOf("l"),
				gatesDigest: digestOf("g"),
			},
			execution: { kind: "observed", exitCode: 1, wallMs: 1, files: [] },
			repeat: { kind: "observed", exitCode: 1, wallMs: 1, files: [] },
			scenarios: [],
		},
		results: [
			{ scenario: "S1", kind: "new_behavior", result: "expected_red" },
			{ scenario: "S2", kind: "preservation", result: "preserved" },
		],
	};

	return classifyFailure({
		receipt: {
			version: 2,
			requiredChecks: checks,
			tamperSignals: [],
			heldoutDigest: "d".repeat(64),
			heldoutCounts: { [first]: kind === "load_error" ? 0 : 1, [second]: 1 },
			heldoutFailures: [first],
			gateSha: gate,
			candidateSha: candidate,
			nonce: "n",
			runner: "local-bwrap",
			status: "failed",
			reason: null,
			checks: checks.map((name) => ({
				name,
				exitCode: name === "heldout" ? 1 : 0,
				durationMs: 1,
			})),
			ignoredChanges: [],
			replacementsDigest: "e".repeat(64),
			modelCalls: 0,
		},
		identity: {
			gateSha: gate,
			candidateSha: candidate,
			nonce: "n",
			heldoutDigest: "d".repeat(64),
			replacementsDigest: "e".repeat(64),
		},
		expected: [...heldoutFiles],
		scenarios: [
			{ scenario: "S1", kind: "new_behavior", file: first },
			{ scenario: "S2", kind: "preservation", file: second },
		],
		base: baseReceipt,
		ignoredChanges: [],
		replay: {
			kind: "observed",
			files: [...heldoutFiles],
			gate: replayTree(true, kind),
			full: replayTree(scenario === "candidate_load_error", kind),
			wallMs: 2,
		},
		dependencies: null,
		candidatePaths: [],
		baseRefusal: null,
	});
}

export function verdictAssessment(
	runId: Digest,
	round: number,
	generation: number,
	verdict: Verdict,
	failure: FailureClass = {
		kind: "candidate",
		reason: "candidate_heldout",
		scenarios: ["S1"],
	},
): ReadAssessment {
	return storedAssessment({
		runId,
		round,
		generation,
		verdict,
		assessment: verdictPasses(verdict)
			? { kind: "passed" }
			: { kind: "failed", failure },
	}).read;
}
