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
import { readAttention, ATTENTION_KINDS } from "../src/views/attention.ts";
import { readOwnerFeed } from "../server/cli/owner-feed.ts";
import { digestOf, runIdOf } from "../src/core/run.ts";
import { parseWorkflow } from "../src/config/parse.ts";
import { isRepoSlug } from "../src/trust/platform.ts";
import { runCli } from "../server/cli.ts";
import { registerFactory } from "../extension/index.ts";
import type { JsonValue } from "../src/core/json.ts";
import {
	beginCandidate,
	handoffCandidate,
	type CandidateEvent,
} from "../src/candidate/handoff.ts";
import { parseCandidateState } from "../src/candidate/codec.ts";
import type { CandidateState } from "../src/candidate/state.ts";
import { dispatchNonce } from "../src/candidate/validation.ts";
import { candidateBranch } from "../src/github/publish.ts";
import { REQUIRED_CI_CHECKS } from "../src/core/run.ts";
import { isGitSha } from "../src/config/schema.ts";
import type { PatchReceipt } from "../src/candidate/build.ts";
import { execFileSync } from "node:child_process";
import {
	candidateLifecycleFixture,
	verdictAssessment,
	withUmask,
} from "./helpers.ts";
import { TRUSTED_RUN_CAP, TRUSTED_WORKFLOW } from "./fake-ticket-adapter.ts";
import { fileRunFiles } from "../server/controller/run-files.ts";
import type { AnswersDigest } from "../src/contract/contract.ts";
import { EXE_DEV_PLATFORM } from "../src/trust/platform.ts";
import { noPlatformFile } from "./helpers.ts";

test("trusted attention thresholds default, validate positive integers, and reject unknown fields", () => {
	const parse = (section: string) =>
		parseWorkflow({
			platform: EXE_DEV_PLATFORM,
			text: `---\nrepository: giuseppecrj/pi-herdr-factorio\n${section}\n---\n`,
			repo,
			env: (name) => (name === "HOME" ? "/tmp/factory" : undefined),
		});

	const defaults = parse("");
	assert.equal(defaults.kind, "valid");
	assert.deepEqual(defaults.config.attention, {
		waitingMs: 259_200_000,
		blockedMs: 21_600_000,
	});
	const custom = parse("attention: { waiting_ms: 3000, blocked_ms: 2000 }");
	assert.equal(custom.kind, "valid");
	assert.deepEqual(custom.config.attention, {
		waitingMs: 3000,
		blockedMs: 2000,
	});

	for (const section of [
		"attention: { waiting_ms: 0 }",
		"attention: { blocked_ms: -1 }",
		"attention: { waiting_ms: 1.2 }",
		"attention: { surprise: 1 }",
	])
		assert.equal(parse(section).kind, "invalid");
});

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
		maxTokens: TRUSTED_RUN_CAP,
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

test("feedback overflow attention uses the durable hold age during notice and after posting", async () => {
	const root = fixture();
	const initial = parseCandidateState(prBook(42, 5, true));

	assert.ok(initial?.kind === "selected");
	writeFileSync(
		join(root, "status.json"),
		JSON.stringify({
			repo,
			feedbackIntake: [
				{
					runId: initial.pin.runId,
					issue: 42,
					eventId: "1",
					pr: 5,
					kind: "unavailable",
					reason: "reviews",
					failure: "gh_failed",
					since: 50,
				},
			],
		}),
		{ mode: 0o600 },
	);

	for (const notice of ["due", "posted"] as const) {
		const work =
			notice === "posted"
				? ({ kind: "held", reason: "feedback_overflow", since: 100 } as const)
				: ({
						kind: "effect",
						request: {
							kind: "post_notice",
							number: 5,
							notice: {
								kind: "feedback_overflow",
								place: "issue",
								key: `<!-- factory:notice ${initial.pin.runId} feedback_overflow -->`,
							},
							withdraw: null,
							// Persisted transition data, not a Promise callback.
							// oxlint-disable-next-line unicorn/no-thenable
							then: {
								kind: "resume",
								work: { kind: "held", reason: "feedback_overflow", since: 100 },
							},
						},
					} as const);

		const handoff: JsonValue = JSON.parse(
			JSON.stringify({
				...initial,
				work,
				feedback: {
					pr: 5,
					seen: [],
					batches: [],
					overflow: { since: 100, notice },
				},
			}),
		);

		claim(root, 42, "blocked", { stage: "land", enteredAt: 900, handoff });
		const attention = await readAttention({ stateDir: root, repo, now: 1000 });

		assert.ok(attention.kind === "available");
		assert.equal(attention.groups.blocked.length, 1);
		assert.equal(attention.groups.blocked[0]?.reason, "feedback_overflow");
		assert.equal(attention.groups.blocked[0]?.ageMs, 900);
		assert.deepEqual(attention.gaps, []);
	}
});

test("unavailable feedback stays blocked with its failure and age; deferred and recovered intake do not", async () => {
	const root = fixture();

	const runId = claim(root, 42, "waiting", {
		stage: "land",
		enteredAt: 900,
		handoff: prBook(42, 5, true),
	});

	const snapshot = {
		repo,
		feedbackIntake: [
			{
				runId,
				issue: 42,
				eventId: "1",
				pr: 5,
				kind: "unavailable",
				reason: "review_comments",
				failure: "malformed_response",
				since: 100,
			},
		],
	};

	const save = () =>
		writeFileSync(join(root, "status.json"), JSON.stringify(snapshot), {
			mode: 0o600,
		});

	save();

	for (const now of [1000, 61_000]) {
		const read = await readAttention({ stateDir: root, repo, now });
		assert.ok(read.kind === "available");
		assert.deepEqual(read.groups.pr_review, []);
		assert.deepEqual(read.groups.blocked, [
			{
				runId,
				issueUrl: `https://github.com/${repo}/issues/42`,
				prUrl: `https://github.com/${repo}/pull/5`,
				ageMs: now - 100,
				reason: "feedback_unavailable:review_comments:malformed_response",
				title: "Title unavailable",
				status: "waiting",
				stale: false,
			},
		]);
		assert.deepEqual(read.gaps, []);
	}

	for (const kind of ["deferred", "recovered"]) {
		snapshot.feedbackIntake[0]!.kind = kind;
		save();
		const read = await readAttention({ stateDir: root, repo, now: 61_000 });
		assert.ok(read.kind === "available");
		assert.deepEqual(read.groups.blocked, []);
		assert.equal(read.groups.pr_review.length, 1);
	}
});

test("seven groups distinguish unknown legacy ages and never duplicate a not-ready PR", async () => {
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

for (const reason of [
	"pr_identity",
	"pr_ambiguous",
	"workflow_unavailable",
] as const)
	for (const published of [false, true])
		test(`attention shows ${reason} with hold age (published=${published})`, async () => {
			const root = fixture();
			const book = parseCandidateState(prBook(14, 99, true));
			assert.ok(book?.kind === "selected");
			claim(root, 14, "blocked", {
				enteredAt: 10,
				stage: "land",
				handoff: JSON.parse(
					JSON.stringify({
						...book,
						published: published
							? {
									...book.published,
									readiness: { kind: "not_ready", reason, since: 200 },
								}
							: null,
						work: { kind: "held", reason, since: 200 },
					}),
				),
			});
			const read = await readAttention({ stateDir: root, repo, now: 1000 });
			assert.equal(read.kind, "available");
			assert.deepEqual(read.gaps, []);
			assert.equal(read.groups.blocked.length, 1);
			assert.deepEqual(read.groups.blocked[0], {
				runId: book.pin.runId,
				issueUrl: `https://github.com/${repo}/issues/14`,
				prUrl: published ? `https://github.com/${repo}/pull/99` : null,
				reason,
				ageMs: 800,
				title: "Title unavailable",
				status: "blocked",
				stale: false,
			});
		});

test("status --json and the owner feed show a workflow_unavailable hold as blocked", async () => {
	const root = fixture();
	const book = parseCandidateState(prBook(14, 99, true));
	assert.ok(book?.kind === "selected");
	const since = Date.now() - 60_000;
	const reason = "workflow_unavailable";
	claim(root, 14, "blocked", {
		enteredAt: 10,
		stage: "land",
		handoff: JSON.parse(
			JSON.stringify({
				...book,
				published: {
					...book.published,
					readiness: { kind: "not_ready", reason, since },
				},
				work: { kind: "held", reason, since },
			}),
		),
	});
	let output = "";

	const code = await runCli(
		["status", "--json", "--repo", repo, "--state-dir", root],
		{
			readPlatformFile: noPlatformFile,
			exec: async (command, args) => ({
				code: 0,
				stderr: "",
				stdout:
					command === "git"
						? `https://github.com/${repo}.git`
						: args.includes("--jq")
							? "a".repeat(40)
							: `---\nrepository: ${repo}\n---\n`,
			}),
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
		attention: {
			groups: {
				blocked: [
					{
						runId: book.pin.runId,
						prUrl: `https://github.com/${repo}/pull/99`,
						reason,
						status: "blocked",
					},
				],
			},
		},
	});

	const feed = await readOwnerFeed({ stateDir: root, repo });
	assert.equal(feed.counts.blocked, 1);
	assert.partialDeepStrictEqual(
		feed.entries.filter((entry) => entry.runId === book.pin.runId),
		[{ issue: 14, kind: "blocked", group: "needs_you", reason }],
	);
});

test("an unverified claim appears once in blocked with the observation's age, and clears on recovery", async () => {
	const root = fixture();
	const runId = claim(root, 14, "claimed", { enteredAt: 10 });

	const status = {
		repo,
		unverifiedClaims: [
			{
				issue: 14,
				runId,
				eventId: "1",
				why: "ledger",
				failure: "gh_failed",
				since: 200,
			},
		],
	};

	const path = join(root, "status.json");
	writeFileSync(path, JSON.stringify(status), { mode: 0o600 });
	const read = await readAttention({ stateDir: root, repo, now: 1000 });
	assert.equal(read.kind, "available");
	assert.deepEqual(read.groups.blocked, [
		{
			runId,
			issueUrl: `https://github.com/${repo}/issues/14`,
			prUrl: null,
			ageMs: 800,
			reason: "claim_unverified:ledger:gh_failed",
			title: "Title unavailable",
			status: "claimed",
			stale: false,
		},
	]);
	assert.equal(Object.values(read.groups).flat().length, 1);
	writeFileSync(
		path,
		JSON.stringify({
			...status,
			unverifiedClaims: [],
		}),
	);
	const healed = await readAttention({ stateDir: root, repo, now: 2000 });
	assert.equal(healed.kind, "available");
	assert.equal(healed.groups.blocked.length, 0);
});

test("attention includes an unverified discovery before any claim file or active run exists", async () => {
	const root = fixture();
	const runId = runIdOf({ repo, issue: 14, eventId: "1" });
	writeFileSync(
		join(root, "status.json"),
		JSON.stringify({
			repo,
			runs: [],
			unverifiedClaims: [
				{
					issue: 14,
					runId,
					eventId: "1",
					why: "ledger",
					failure: "gh_failed",
					since: 200,
				},
			],
		}),
		{ mode: 0o600 },
	);
	const read = await readAttention({ stateDir: root, repo, now: 1000 });
	assert.equal(read.kind, "available");
	assert.deepEqual(read.groups.blocked, [
		{
			runId,
			issueUrl: `https://github.com/${repo}/issues/14`,
			prUrl: null,
			ageMs: 800,
			reason: "claim_unverified:ledger:gh_failed",
			title: "Title unavailable",
			status: "blocked",
			stale: false,
		},
	]);
});

for (const predecessorStatus of ["released", "needs_info", "claimed"])
	test(`an unverified discovery is visible beside a ${predecessorStatus} predecessor for the same issue`, async () => {
		const root = fixture();
		claim(root, 14, predecessorStatus);
		claim(root, 15, "failed");
		const before = await readAttention({ stateDir: root, repo, now: 1000 });
		assert.equal(before.kind, "available");
		const runId = runIdOf({ repo, issue: 14, eventId: "2" });
		writeFileSync(
			join(root, "status.json"),
			JSON.stringify({
				repo,
				runs: [],
				unverifiedClaims: [
					{
						issue: 14,
						runId,
						eventId: "2",
						why: "ledger",
						failure: "gh_failed",
						since: 200,
					},
				],
			}),
			{ mode: 0o600 },
		);
		const read = await readAttention({ stateDir: root, repo, now: 1000 });
		assert.equal(read.kind, "available");
		assert.deepEqual(read.groups, {
			...before.groups,
			blocked: [
				{
					runId,
					issueUrl: `https://github.com/${repo}/issues/14`,
					prUrl: null,
					ageMs: 800,
					reason: "claim_unverified:ledger:gh_failed",
					title: "Title unavailable",
					status: "blocked",
					stale: false,
				},
			],
		});
		assert.deepEqual(read.gaps, before.gaps);
	});

for (const mask of [0o022, 0o077])
	for (const mismatch of [
		"repo",
		"runId",
		"issue",
		"eventId",
		"since",
		"permissions",
		"terminal",
	])
		test(`attention ignores an unverified status with mismatched ${mismatch} (umask ${mask.toString(8)})`, () =>
			withUmask(mask, async () => {
				const root = fixture();

				const runId = claim(
					root,
					14,
					mismatch === "terminal" ? "released" : "claimed",
				);

				const path = join(root, "status.json");
				writeFileSync(
					path,
					JSON.stringify({
						repo: mismatch === "repo" ? "other/repo" : repo,
						unverifiedClaims: [
							{
								runId: mismatch === "runId" ? digestOf("other") : runId,
								issue: mismatch === "issue" ? 15 : 14,
								eventId: mismatch === "eventId" ? "2" : "1",
								why: "ledger",
								failure: "gh_failed",
								since: mismatch === "since" ? -1 : 200,
							},
						],
					}),
					{ mode: 0o600 },
				);

				if (mismatch === "permissions") chmodSync(path, 0o644);
				const read = await readAttention({ stateDir: root, repo, now: 1000 });
				assert.equal(read.kind, "available");
				assert.equal(read.groups.blocked.length, 0);
			}));

test("a terminal run's stale hold stays hidden when another run has the newest claim", async () => {
	const root = fixture();
	const released = claim(root, 14, "released");
	const newest = runIdOf({ repo, issue: 14, eventId: "2" });
	writeFileSync(
		join(root, "claims", `${newest}.json`),
		JSON.stringify({
			runId: newest,
			issue: 14,
			eventId: "2",
			seq: 2,
			status: "needs_info",
			stage: "specify",
		}),
		{ mode: 0o600 },
	);
	const before = await readAttention({ stateDir: root, repo, now: 1000 });
	assert.equal(before.kind, "available");
	assert.equal(before.groups.question_asked[0]?.runId, newest);
	writeFileSync(
		join(root, "status.json"),
		JSON.stringify({
			repo,
			unverifiedClaims: [
				{
					issue: 14,
					runId: released,
					eventId: "1",
					why: "ledger",
					failure: "gh_failed",
					since: 200,
				},
			],
		}),
		{ mode: 0o600 },
	);
	assert.deepEqual(
		await readAttention({ stateDir: root, repo, now: 1000 }),
		before,
	);
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
	const held = claim(root, 3, "claimed");
	writeFileSync(
		join(root, "status.json"),
		JSON.stringify({
			repo,
			unverifiedClaims: [
				{
					issue: 3,
					runId: held,
					eventId: "1",
					why: "ledger",
					failure: "gh_failed",
					since: Date.now() - 60_000,
				},
			],
		}),
		{ mode: 0o600 },
	);
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
			readPlatformFile: noPlatformFile,
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
	assert.partialDeepStrictEqual(JSON.parse(output), {
		attention: {
			groups: {
				blocked: [
					{ reason: "candidate_book_unavailable" },
					{ runId: held, reason: "claim_unverified:ledger:gh_failed" },
				],
			},
		},
	});
	const previous = process.env.FACTORY_STATE_DIR;
	process.env.FACTORY_STATE_DIR = root;
	const handlers: (() => Promise<void>)[] = [];
	let sent = "";

	try {
		registerFactory(
			{
				registerCommand: (_name, options) => {
					// SAFETY: the registered handler only uses cwd from the extension context.
					const context = { cwd: root } as Parameters<
						typeof options.handler
					>[1];

					handlers.push(() => options.handler("status", context));
				},
				sendMessage: (message) => {
					sent = String(message.content);
				},
				exec: async (command, args) => ({
					...(await exec(command, args)),
					killed: false,
				}),
			},
			Promise.resolve({ ok: true as const, profile: EXE_DEV_PLATFORM }),
		);
		const handler = handlers[0];
		assert.ok(handler);
		await handler();
	} finally {
		if (previous === undefined) delete process.env.FACTORY_STATE_DIR;
		else process.env.FACTORY_STATE_DIR = previous;
	}

	assert.match(sent, /question_asked: 1/);
	assert.match(sent, /spec_review: not enabled in v1/);
	assert.match(sent, /blocked: 2/);
	assert.match(
		sent,
		/age \d+s(?: stale)? claimed \(claim_unverified:ledger:gh_failed\)/,
	);
	assert.match(sent, /pr_review: 0/);
	assert.match(sent, /candidate_book_unavailable/);
	assert.ok(requests.length > 0);
});
