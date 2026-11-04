import assert from "node:assert/strict";
import {
	mkdtempSync,
	mkdirSync,
	writeFileSync,
	readFileSync,
	chmodSync,
	symlinkSync,
	rmSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";
import { readAttention, ATTENTION_KINDS } from "../src/attention.ts";
import { digestOf, runIdOf } from "../src/run.ts";
import { isRepoSlug } from "../src/workflow.ts";
import { runCli } from "../server/cli.ts";
import { registerFactory } from "../extension/index.ts";
import type { JsonValue } from "../src/tickets.ts";
import {
	beginCandidate,
	handoffCandidate,
	type CandidateState,
	type CandidateEvent,
} from "../src/handoff.ts";
import { dispatchNonce } from "../src/validation.ts";
import { candidateBranch } from "../src/publication.ts";
import { REQUIRED_CI_CHECKS } from "../src/run.ts";
import { isGitSha } from "../src/workflow.ts";
import type { PatchReceipt } from "../src/build.ts";
import { execFileSync } from "node:child_process";
import { candidateLifecycleFixture, verdictAssessment } from "./helpers.ts";
import { TRUSTED_WORKFLOW } from "./fake-ticket-adapter.ts";
import { fileRunFiles } from "../server/controller.ts";
import type { AnswersDigest } from "../src/specify.ts";

type ClaimExtra = {
	readonly stage?: string;
	readonly enteredAt?: number;
	readonly handoff?: JsonValue;
};

const slug = "giuseppecrj/pi-herdr-factorio";

if (!isRepoSlug(slug)) throw new Error("fixture");

const repo = slug;
const roots: string[] = [];

function fixture() {
	const root = mkdtempSync(join(tmpdir(), "factory-attention-"));
	roots.push(root);
	mkdirSync(join(root, "claims"), { mode: 0o700 });
	mkdirSync(join(root, "links"), { mode: 0o700 });

	return root;
}

function claim(
	root: string,
	issue: number,
	status: string,
	extra: ClaimExtra = {},
) {
	const runId = runIdOf({ repo, issue, eventId: "1" });
	writeFileSync(
		join(root, "claims", `${runId}.json`),
		JSON.stringify({
			runId,
			issue,
			eventId: "1",
			seq: 1,
			status,
			stage: "specify",
			...extra,
		}),
		{ mode: 0o600 },
	);

	return runId;
}

function prBook(issue: number, number: number, ready: boolean): JsonValue {
	const base = "a".repeat(40);
	const head = "c".repeat(40);
	assert.ok(isGitSha(base) && isGitSha(head));

	const pin = {
		runId: runIdOf({ repo, issue, eventId: "1" }),
		repo,
		issue,
		originalBase: base,
		workflowSha: base,
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

	const observation: Extract<CandidateEvent, { kind: "observed" }> = {
		kind: "observed",
		now: 200,
		main: base,
		pr: { kind: "none" },
		executionAllowed: true,
		capacityAvailable: true,
		eligibility: "ready",
		readiness: { kind: "unavailable" },
	};

	let state: CandidateState = handoffCandidate(
		beginCandidate(pin, patch, 29),
		observation,
	).state;

	assert.ok(
		state.kind === "selected" &&
			state.work.kind === "effect" &&
			state.work.request.kind === "validate",
	);

	const validation = {
		version: 1,
		startedAt: 1,
		deadline: 1_200_001,
		round: 0,
		originalBase: base,
		baseSha: base,
		baseResolved: true,
		publication: {
			branch: candidateBranch(issue, pin.runId, 0),
			patchSha: head,
			candidateSha: head,
		},
		dispatchTry: 1,
		dispatchedAt: 2,
		ciRunId: 123,
		counters: {},
	} as const;

	const verdict = {
		patchDigest: patch.patchDigest,
		acceptanceDigest: pin.acceptanceDigest,
		heldoutDigest: digestOf("heldout"),
		candidateSha: head,
		gateSha: base,
		ciRunId: 123,
		originalBase: base,
		baseSha: base,
		pass: true,
		checks: REQUIRED_CI_CHECKS.map((name) => ({ name, passed: true })),
		requiredChecks: [...REQUIRED_CI_CHECKS],
		unjudged: [],
	};

	const report = {
		candidateSha: head,
		gateSha: base,
		ciRunId: 123,
		reportId: 456,
		nonce: dispatchNonce(pin.runId, 0, 1),
		heldoutDigest: verdict.heldoutDigest,
		externalId: `factory-gates:123:${dispatchNonce(pin.runId, 0, 1)}`,
	};

	state = handoffCandidate(state, {
		kind: "effect_completed",
		completion: {
			kind: "validate",
			request: state.work.request,
			result: {
				kind: "finished",
				validation,
				verdict,
				report,
				seats: ["code-review", "security-review", "simplify"],
				assessment: verdictAssessment(pin.runId, 0, 0, verdict),
			},
		},
	}).state;
	state = handoffCandidate(state, observation).state;
	assert.ok(
		state.kind === "selected" &&
			state.work.kind === "effect" &&
			state.work.request.kind === "launch_review",
	);
	const request = state.work.request;
	state = handoffCandidate(state, {
		kind: "effect_completed",
		completion: { kind: "launch_review", request, started: true },
	}).state;
	state = handoffCandidate(state, {
		kind: "review_settled",
		execution: request.execution,
		tokens: 30,
		result: {
			kind: "passed",
			patch: { kind: "found", receipt: patch, patch: "patch" },
			review: {
				...request.execution.binding,
				version: 2,
				r8: "incomplete",
				blocking: false,
				seats: request.execution.seats.map((seat) => ({
					seat,
					findings: [],
					judgments: [],
					requested: "openai/gpt-6.1-sol",
					observed: null,
					label: "context-isolated, same model, same family, not cross-family",
					fallback: false,
					tokens: 10,
				})),
			},
		},
	}).state;

	const current: Extract<CandidateEvent, { kind: "observed" }> = {
		...observation,
		readiness: { kind: "current", head, report },
	};

	state = handoffCandidate(state, current).state;
	assert.ok(
		state.kind === "selected" &&
			state.work.kind === "effect" &&
			state.work.request.kind === "open_pr",
	);
	state = handoffCandidate(state, {
		kind: "effect_completed",
		completion: {
			kind: "open_pr",
			request: state.work.request,
			number,
			head,
			refHead: head,
		},
	}).state;

	const open = {
		...current,
		pr: { kind: "open", number, head, refHead: head },
	} as const;

	state = handoffCandidate(state, open).state;
	assert.ok(
		state.kind === "selected" &&
			state.work.kind === "effect" &&
			state.work.request.kind === "complete_handoff",
	);
	state = handoffCandidate(state, {
		kind: "effect_completed",
		completion: {
			kind: "complete_handoff",
			request: state.work.request,
			now: 200,
		},
	}).state;

	if (!ready)
		state = handoffCandidate(state, {
			...open,
			readiness: { kind: "unavailable" },
		}).state;

	return JSON.parse(JSON.stringify(state));
}

after(() => {
	for (const root of roots) rmSync(root, { recursive: true, force: true });
});

test("six groups distinguish unknown legacy ages and never duplicate a not-ready PR", async () => {
	const root = fixture();
	claim(root, 1, "needs_info");
	const answered = claim(root, 2, "running", { enteredAt: 100 });
	writeFileSync(
		join(root, "links", `${answered}.json`),
		JSON.stringify({
			prevRunId: digestOf("previous"),
			answersDigest: digestOf("answers"),
		}),
		{ mode: 0o600 },
	);
	claim(root, 3, "waiting", {
		stage: "land",
		handoff: prBook(3, 5, true),
	});
	claim(root, 4, "blocked");
	claim(root, 5, "failed");
	claim(root, 6, "waiting", {
		stage: "land",
		handoff: prBook(6, 6, false),
	});
	const read = await readAttention({ stateDir: root, repo, now: 1000 });
	assert.equal(read.kind, "available");
	assert.deepEqual(Object.keys(read.groups), ATTENTION_KINDS);
	assert.deepEqual(read.gaps, []);
	assert.equal(read.specReview, "not_enabled_in_v1");
	assert.equal(read.groups.question_asked.length, 1);
	assert.equal(read.groups.question_asked[0]?.ageMs, null);
	assert.equal(read.groups.question_answered[0]?.ageMs, 900);
	assert.equal(read.groups.pr_review.length, 1);
	assert.equal(read.groups.blocked.length, 2);
	assert.equal(read.groups.failed.length, 1);
	assert.equal(read.groups.spec_review.length, 0);
});

test("legacy attention ignores private ledger accounting and request journals without rewriting claims", async () => {
	const root = fixture();
	const id = claim(root, 1, "needs_info");
	claim(root, 2, "failed");
	const input = { stateDir: root, repo, now: 1000 };
	const before = await readAttention(input);
	const path = join(root, "claims", `${id}.json`);
	const bytes = readFileSync(path, "utf8");
	mkdirSync(join(root, "accounting", id, "attempts"), { recursive: true });
	writeFileSync(join(root, "accounting", id, "policy.json"), "{}");
	mkdirSync(join(root, "ledger", id), { recursive: true });
	writeFileSync(join(root, "ledger", id, "terminal.json"), "{}");
	const stage = join(root, "stages", id, "specify-1");
	mkdirSync(stage, { recursive: true });
	writeFileSync(
		join(stage, "egress.requests.jsonl"),
		'{"kind":"dispatch","req":1}\n{"kind":"result"',
	);
	assert.deepEqual(await readAttention(input), before);
	assert.equal(before.kind, "available");
	assert.equal(before.groups.question_asked[0]?.ageMs, null);
	assert.equal(before.groups.failed.length, 1);
	assert.equal(readFileSync(path, "utf8"), bytes);
});

test("link records: the controller's unlinked record is no gap, a real link is answered, a corrupt one is a gap", async () => {
	const root = fixture();
	const files = fileRunFiles(root);
	const unlinked = claim(root, 1, "running", { stage: "admit" });
	assert.equal(await files.writeLink(unlinked, null), true);
	const linkedClaim = claim(root, 2, "running", { enteredAt: 100 });
	assert.equal(
		await files.writeLink(linkedClaim, {
			prevRunId: digestOf("previous"),
			questionsDigest: null,
			// SAFETY: AnswersDigest is a brand over the 64-hex Digest that digestOf returns.
			answersDigest: digestOf("answers") as AnswersDigest,
		}),
		true,
	);
	const corrupt = claim(root, 3, "running");
	writeFileSync(
		join(root, "links", `${corrupt}.json`),
		JSON.stringify({ version: 1, prevRunId: "nope" }),
		{ mode: 0o600 },
	);
	const read = await readAttention({ stateDir: root, repo, now: 1000 });
	assert.equal(read.kind, "available");
	assert.deepEqual(read.gaps, [`invalid_link:${corrupt.slice(0, 12)}`]);
	assert.equal(read.groups.question_answered.length, 1);
	assert.equal(read.groups.question_answered[0]?.runId, linkedClaim);
});

test("an incomplete or wrong-owner candidate book is a gap, never PR-ready", async () => {
	const root = fixture();
	claim(root, 3, "waiting", {
		stage: "land",
		handoff: {
			kind: "selected",
			published: { number: 5, readiness: { kind: "ready", since: 200 } },
			work: { kind: "waiting" },
		},
	});
	claim(root, 4, "waiting", { stage: "land", handoff: prBook(5, 6, true) });
	const read = await readAttention({ stateDir: root, repo, now: 1000 });
	assert.equal(read.kind, "available");
	assert.equal(read.groups.pr_review.length, 0);
	assert.equal(read.gaps.length, 2);
});

test("cold missing books and working refreshes are blocked once, never PR-ready", async () => {
	const root = fixture();
	claim(root, 1, "running", {
		stage: "validate",
		handoff: JSON.parse(JSON.stringify(candidateLifecycleFixture())),
	});
	claim(root, 2, "waiting", { stage: "land" });
	const read = await readAttention({ stateDir: root, repo, now: 1000 });
	assert.equal(read.kind, "available");
	assert.equal(read.groups.pr_review.length, 0);
	assert.equal(read.groups.blocked.length, 2);
	assert.equal(read.gaps.length, 1);
	assert.equal(
		read.groups.blocked.find((e) => e.issueUrl.endsWith("/2"))?.ageMs,
		null,
	);
	assert.equal(
		read.groups.blocked.find((e) => e.issueUrl.endsWith("/2"))?.reason,
		"candidate_book_unavailable",
	);
});

test("standalone CLI process reports saved working and cold evidence without external transport", () => {
	const root = fixture();
	claim(root, 1, "running", {
		stage: "validate",
		handoff: JSON.parse(JSON.stringify(candidateLifecycleFixture())),
	});
	claim(root, 2, "waiting", { stage: "land" });
	const bin = join(root, "bin");
	mkdirSync(bin, { mode: 0o700 });
	const requests = join(root, "requests.jsonl");
	writeFileSync(
		join(bin, "gh"),
		`#!${process.execPath}\nconst fs = require("node:fs");\nconst args = process.argv.slice(2);\nfs.appendFileSync(${JSON.stringify(requests)}, JSON.stringify(args) + "\\n");\nif (args[0] !== "api" || args.includes("--method")) process.exit(7);\nif (args.includes("--jq")) process.stdout.write(${JSON.stringify("a".repeat(40))});\nelse if (args.some(a => a.includes("/contents/.github/factory/WORKFLOW.md?ref="))) process.stdout.write(${JSON.stringify(TRUSTED_WORKFLOW)});\nelse process.exit(8);\n`,
		{ mode: 0o700 },
	);

	const before = readFileSync(
		join(root, "claims", `${runIdOf({ repo, issue: 1, eventId: "1" })}.json`),
		"utf8",
	);

	const output = execFileSync(
		process.execPath,
		[
			"--experimental-strip-types",
			"server/cli.ts",
			"status",
			"--json",
			"--repo",
			repo,
			"--state-dir",
			root,
		],
		{
			cwd: process.cwd(),
			encoding: "utf8",
			env: { PATH: `${bin}:/usr/bin:/bin`, HOME: root },
			timeout: 10_000,
		},
	);

	const parsed = JSON.parse(output);
	assert.equal(parsed.attention.kind, "available");
	assert.equal(parsed.attention.groups.blocked.length, 2);
	assert.equal(parsed.attention.groups.pr_review.length, 0);
	assert.equal(parsed.attention.gaps.length, 1);
	assert.equal(readFileSync(requests, "utf8").trim().split("\n").length, 2);
	assert.equal(
		readFileSync(
			join(root, "claims", `${runIdOf({ repo, issue: 1, eventId: "1" })}.json`),
			"utf8",
		),
		before,
	);
});

test("newest issue sequence removes superseded questions and terminal entries", async () => {
	const root = fixture();
	claim(root, 1, "needs_info");
	const runId = runIdOf({ repo, issue: 1, eventId: "2" });
	writeFileSync(
		join(root, "claims", `${runId}.json`),
		JSON.stringify({
			runId,
			issue: 1,
			eventId: "2",
			seq: 2,
			status: "released",
			stage: "specify",
		}),
		{ mode: 0o600 },
	);
	const read = await readAttention({ stateDir: root, repo, now: 1000 });
	assert.equal(read.kind, "available");
	assert.equal(read.groups.question_asked.length, 0);
});

test("missing, writable and symlinked private state never become empty success", async () => {
	assert.deepEqual(await readAttention({ stateDir: null, repo, now: 1000 }), {
		kind: "unavailable",
		reason: "state_not_configured",
	});
	const root = fixture();
	chmodSync(root, 0o755);
	assert.equal(
		(await readAttention({ stateDir: root, repo, now: 1000 })).kind,
		"unavailable",
	);
	chmodSync(root, 0o700);
	const alias = `${root}-link`;
	roots.push(alias);
	symlinkSync(root, alias);
	assert.equal(
		(await readAttention({ stateDir: alias, repo, now: 1000 })).kind,
		"unavailable",
	);
});

test("corrupt or public claim files are visible evidence gaps", async () => {
	const root = fixture();
	const runId = claim(root, 1, "failed");
	chmodSync(join(root, "claims", `${runId}.json`), 0o644);
	writeFileSync(join(root, "claims", `${digestOf("corrupt")}.json`), "{", {
		mode: 0o600,
	});
	const read = await readAttention({ stateDir: root, repo, now: 1000 });
	assert.equal(read.kind, "available");
	assert.equal(read.gaps.length, 2);
	assert.equal(read.groups.failed.length, 0);
});

test("real CLI status and registered extension compose the same local attention reader without models or writes", async () => {
	const root = fixture();
	claim(root, 1, "needs_info");
	claim(root, 2, "waiting", { stage: "land" });
	const requests: string[] = [];

	const exec = async (command: string, args: readonly string[]) => {
		requests.push(`${command} ${args.join(" ")}`);
		assert.ok(command === "git" || command === "gh");
		assert.ok(!args.includes("--method"));

		return {
			code: 0,
			stderr: "",
			stdout:
				command === "git"
					? `https://github.com/${repo}.git`
					: args.includes("--jq")
						? "a".repeat(40)
						: `---\nrepository: ${repo}\n---\n`,
		};
	};

	let output = "";

	const code = await runCli(
		["status", "--json", "--repo", repo, "--state-dir", root],
		{
			exec,
			env: () => undefined,
			stdout: (text) => {
				output += text;
			},
			stderr: (text) => {
				throw new Error(text);
			},
		},
	);

	assert.equal(code, 0);
	assert.partialDeepStrictEqual(JSON.parse(output), {
		attention: { kind: "available", specReview: "not_enabled_in_v1" },
	});
	assert.match(output, /question_asked/);
	const previous = process.env.FACTORY_STATE_DIR;
	process.env.FACTORY_STATE_DIR = root;
	const handlers: (() => Promise<void>)[] = [];
	let sent = "";

	try {
		registerFactory({
			registerCommand: (_name, options) => {
				// SAFETY: the registered handler only uses cwd from the extension context.
				const context = { cwd: root } as Parameters<typeof options.handler>[1];
				handlers.push(() => options.handler("status", context));
			},
			sendMessage: (message) => {
				sent = String(message.content);
			},
			exec: async (command, args) => ({
				...(await exec(command, args)),
				killed: false,
			}),
		});
		const handler = handlers[0];
		assert.ok(handler);
		await handler();
	} finally {
		if (previous === undefined) delete process.env.FACTORY_STATE_DIR;
		else process.env.FACTORY_STATE_DIR = previous;
	}

	assert.match(sent, /question_asked: 1/);
	assert.match(sent, /spec_review: not enabled in v1/);
	assert.match(sent, /blocked: 1/);
	assert.match(sent, /pr_review: 0/);
	assert.match(sent, /candidate_book_unavailable/);
	assert.ok(requests.length > 0);
});
