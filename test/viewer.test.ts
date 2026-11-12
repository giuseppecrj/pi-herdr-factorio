import assert from "node:assert/strict";
import {
	mkdtemp,
	mkdir,
	rm,
	writeFile,
	cp,
	readdir,
	readFile,
	symlink,
} from "node:fs/promises";
import { request } from "node:http";
import { execFileSync } from "node:child_process";
import fs from "node:fs/promises";
import fsSync from "node:fs";
import { Evidence, markerHistoryGap } from "../server/viewer/evidence.ts";
import {
	arrayOf,
	fieldOf,
	objectOf,
	parseJson,
	textOf,
} from "../src/core/json.ts";
import { escapeHtml, renderRun, expectedGap } from "../server/viewer/render.ts";
import { icons } from "../server/viewer/design/icons/icons.ts";
import { runCli } from "../server/cli.ts";
import { runSpecify } from "../server/sandbox.ts";
import { readStageReceipt } from "../server/sandbox/receipts.ts";
import { fileRunFiles } from "../server/controller.ts";
import { readStoredVerdict } from "../server/controller/state.ts";
import {
	candidateLifecycleFixture,
	storedAssessment,
	verdictAssessment,
} from "./helpers.ts";
import {
	beginCandidate,
	candidateGenerations,
	candidateUsage,
	candidateProjection,
	handoffCandidate,
} from "../src/handoff.ts";
import { keepReview } from "../src/candidate/review.ts";
import { validationDir } from "../src/candidate/validation.ts";
import { viewerClaim } from "../server/viewer/claim.ts";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { readViewerRun, startViewer } from "../server/viewer.ts";
import { runIdOf, digestOf } from "../src/core/run.ts";
import {
	formatMarker,
	parseMarker,
	type Marker,
} from "../src/trust/markers.ts";
import { isRepoSlug, isGitSha, parseWorkflow } from "../src/workflow.ts";
import fixture from "./fixtures/viewer/sessions.json" with { type: "json" };
import { EXE_DEV_PLATFORM } from "../src/trust/platform.ts";
import { noPlatformFile } from "./helpers.ts";

const runId = runIdOf({
	repo: "giuseppecrj/pi-herdr-factorio",
	issue: 1,
	eventId: "1",
});

test("repair claims preserve their counter without validation and display only the current round verdict", async () => {
	const f = await fixtureState();

	try {
		const claim = JSON.parse(
			await readFile(join(f.root, "claims", `${runId}.json`), "utf8"),
		);

		assert.equal(
			viewerClaim(JSON.stringify({ ...claim, round: 1 }), runId)?.round,
			1,
		);

		const validation = {
			version: 1,
			startedAt: 1,
			deadline: 2,
			round: 1,
			originalBase: "a".repeat(40),
			baseSha: "a".repeat(40),
			baseResolved: true,
			publication: null,
			dispatchTry: 1,
			dispatchedAt: 1,
			ciRunId: 1,
			counters: {},
		};

		await writeFile(
			join(f.root, "claims", `${runId}.json`),
			JSON.stringify({ ...claim, stage: "review", round: 1, validation }),
		);
		const dir = join(f.root, "validation", runId);
		await mkdir(join(dir, "r1"), { recursive: true });
		await writeFile(
			join(dir, "verdict.json"),
			JSON.stringify({ pass: false, checks: [] }),
			{ mode: 0o600 },
		);
		await writeFile(
			join(dir, "r1", "verdict.json"),
			JSON.stringify({ pass: true, checks: [] }),
			{ mode: 0o600 },
		);
		await mkdir(join(f.root, "stages", runId, "review-r1-1"));
		const viewed = await readViewerRun(f.root, runId);
		assert.deepEqual(
			viewed.timeline
				.filter((entry) => entry.event === "CI verdict")
				.map((entry) => [entry.round, entry.detail]),
			[[1, "passed"]],
		);
		assert.ok(
			viewed.gaps.some((entry) =>
				entry.source.includes("review-r1-1/receipt.json"),
			),
		);
		assert.ok(
			!viewed.gaps.some(
				(entry) =>
					entry.source.includes("review/") &&
					entry.source.includes("r0/receipt.json"),
			),
			"failed CI never reached review in round zero",
		);
		assert.ok(
			viewed.gaps.some(
				(entry) =>
					entry.source.includes("review/") &&
					entry.source.includes("r1/receipt.json"),
			),
		);
	} finally {
		await rm(f.root, { recursive: true, force: true });
	}
});

test("missing-book round reviews render only through the strict-or-migrate review parser", async () => {
	const f = await fixtureState();

	try {
		const claim = JSON.parse(
			await readFile(join(f.root, "claims", `${runId}.json`), "utf8"),
		);

		await writeFile(
			join(f.root, "claims", `${runId}.json`),
			JSON.stringify({ ...claim, stage: "review", round: 1 }),
		);
		await mkdir(join(f.root, "stages", runId, "review-r1-1"));
		const path = join(f.root, "review", runId, "r1", "receipt.json");
		await mkdir(join(path, ".."), { recursive: true });

		type StoredJudgment = {
			readonly scenario: string;
			readonly reason: string;
			readonly pass?: boolean;
			readonly outcome?: string;
		};

		const receipt = (
			version: number,
			judgments: readonly StoredJudgment[],
		) => ({
			runId,
			round: 1,
			candidateSha: "c".repeat(40),
			patchDigest: digestOf("patch"),
			contractDigest: digestOf("contract"),
			acceptanceDigest: digestOf("acceptance"),
			ciRunId: 1,
			originalBase: "a".repeat(40),
			baseSha: "a".repeat(40),
			execution: {
				generation: 0,
				intentDigest: digestOf("intent"),
				attempt: 1,
				workflowSha: "b".repeat(40),
				workflowDigest: digestOf("workflow"),
			},
			version,
			r8: "incomplete",
			seats: [
				{
					seat: "code-review",
					findings: [],
					judgments,
					requested: "openai/gpt-6.1-sol",
					observed: null,
					label: "context-isolated",
					fallback: false,
					tokens: 1,
				},
			],
			blocking: false,
		});

		const view = async (
			value: ReturnType<typeof receipt> | { readonly seats: unknown },
		) => {
			await writeFile(path, JSON.stringify(value), { mode: 0o600 });
			const viewed = await readViewerRun(f.root, runId);

			return {
				details: viewed.timeline
					.filter(
						(entry) =>
							entry.source.endsWith(join("r1", "receipt.json")) &&
							entry.event === "code-review",
					)
					.map((entry) => entry.detail.split("; ").at(-1)),
				gap: viewed.gaps.some(
					(entry) =>
						entry.source.endsWith(join("r1", "receipt.json")) &&
						entry.reason === "missing_or_corrupt_round_review",
				),
			};
		};

		const judgment = (
			extra: Omit<StoredJudgment, "scenario" | "reason">,
		): StoredJudgment => ({
			scenario: "S1",
			...extra,
			reason: "why",
		});

		for (const [value, detail] of [
			[receipt(1, [judgment({ pass: true })]), "clean"],
			[receipt(1, [judgment({ pass: false })]), "blocking"],
			[receipt(2, [judgment({ outcome: "pass" })]), "clean"],
			[receipt(2, [judgment({ outcome: "unverifiable" })]), "blocking"],
		] as const)
			assert.deepEqual(
				await view(value),
				{ details: [detail], gap: false },
				JSON.stringify(value),
			);

		for (const value of [
			receipt(1, [judgment({ outcome: "pass" })]),
			receipt(2, [judgment({ pass: true })]),
			receipt(3, [judgment({ outcome: "pass" })]),
			receipt(2, [judgment({ outcome: "skipped" })]),
			receipt(1, [judgment({ pass: true, outcome: "pass" })]),
			{ ...receipt(2, []), seats: [{ seat: "code-review" }] },
		])
			assert.deepEqual(
				await view(value),
				{ details: [], gap: true },
				JSON.stringify(value),
			);
	} finally {
		await rm(f.root, { recursive: true, force: true });
	}
});

test("round-qualified sessions keep their stage and round in usage and timelines", async () => {
	const f = await fixtureState();

	try {
		await fs.rename(f.stage, join(f.root, "stages", runId, "build-r1-1"));
		const viewed = await readViewerRun(f.root, runId);

		assert.ok(viewed.usage.sessions.length > 0);
		assert.ok(
			viewed.usage.sessions.every((session) => session.stage === "build"),
		);
		assert.ok(
			viewed.usage.sessions
				.flatMap((session) => session.timeline)
				.every((entry) => entry.round === 1),
		);
	} finally {
		await rm(f.root, { recursive: true, force: true });
	}
});

async function fixtureState(repo = "giuseppecrj/pi-herdr-factorio") {
	const runId = runIdOf({ repo, issue: 1, eventId: "1" });
	const root = await mkdtemp(join(tmpdir(), "factory-viewer-"));
	const stage = join(root, "stages", runId, "build-1");
	const sessions = join(stage, "agent-0", "sessions");
	await mkdir(sessions, { recursive: true });
	await mkdir(join(root, "claims"), { mode: 0o700 });
	await writeFile(
		join(root, "claims", `${runId}.json`),
		JSON.stringify({
			runId,
			issue: 1,
			eventId: "1",
			status: "stage_passed",
			stage: "build",
			seq: 2,
			attempt: 1,
			usage: 20,
		}),
		{ mode: 0o600 },
	);
	await writeFile(
		join(root, "status.json"),
		JSON.stringify({ runs: [{ runId }] }),
	);

	const admission = join(root, `admissions/github/${repo}/1`);

	await mkdir(admission, { recursive: true });
	await writeFile(
		join(admission, "1.json"),
		JSON.stringify({
			snapshot: {
				title: "<script>alert('canary')</script>",
				body: "<img src=x onerror=alert(1)> & text",
			},
		}),
	);

	const receipt = {
		version: 1,
		runId,
		stage: "build",
		attempt: 1,
		outcome: { kind: "passed" },
		settlement: { event: "agent_settled", aborted: false },
		models: { requested: "openai/gpt-6.1-sol", observed: "gpt-6.1-sol" },
		turns: 1,
		wallMs: 100,
		usage: {
			total: 20,
			parent: 10,
			children: 10,
			byModel: { "openai/gpt-6.1-sol": 13, "openai/gpt-6.1-terra": 7 },
			gateway: 20,
			unreadChildren: 0,
		},
		stderr: [{ session: 0, file: "pi-stderr-0.log", bytes: 0 }],
		pricing: "unavailable",
	};

	await writeFile(join(stage, "receipt.json"), JSON.stringify(receipt));
	await writeFile(join(stage, "pi-stderr-0.log"), "");
	await writeFile(
		join(sessions, "parent.jsonl"),
		fixture.parent.map((record) => JSON.stringify(record)).join("\n"),
	);

	for (const [index, records] of fixture.children.entries())
		await writeFile(
			join(sessions, `child-${index === 0 ? "one" : "two"}.jsonl`),
			records.map((record) => JSON.stringify(record)).join("\n"),
		);
	await writeFile(
		join(stage, "egress.jsonl"),
		JSON.stringify({
			v: 1,
			runId,
			stage: "build",
			attempt: 1,
			ts: "2026-10-31T00:00:01Z",
			decision: "deny",
			upstream: null,
			path: "/github/repos/example",
			method: "GET",
			reason: "no-route",
		}),
	);
	await mkdir(join(root, "markers"));

	for (const name of ["specify", "accept"]) {
		const earlier = join(root, "stages", runId, `${name}-1`);
		await mkdir(earlier);
		await writeFile(
			join(earlier, "receipt.json"),
			JSON.stringify({
				...receipt,
				stage: name,
				usage: {
					total: 0,
					parent: 0,
					children: 0,
					byModel: {},
					gateway: 0,
					unreadChildren: 0,
				},
				stderr: [],
			}),
		);
	}

	const sha = "a".repeat(40);
	assert.ok(isRepoSlug(repo));
	assert.ok(isGitSha(sha));

	const body = formatMarker({
		v: 1,
		runId,
		repo,
		issue: 1,
		eventId: "1",
		eventAt: "2026-10-31T00:00:00Z",
		snapshotDigest: digestOf("snapshot"),
		workflowSha: sha,
		workflowDigest: digestOf("workflow"),
		stage: "build",
		status: "stage_passed",
		attempt: 1,
		seq: 2,
		branch: null,
		pr: null,
		usage: 20,
		cursor: null,
	});

	await writeFile(
		join(root, "markers", `${runId}.jsonl`),
		JSON.stringify({ timestamp: "2026-10-31T00:00:06Z", body }),
	);

	return { root, stage, sessions, runId };
}

async function lifecycleState() {
	const f = await fixtureState();
	const book = candidateLifecycleFixture();
	const projection = candidateProjection(book);
	assert.equal(
		await fileRunFiles(f.root).writeClaim({
			runId,
			issue: 1,
			eventId: "1",
			seq: 10,
			status: projection.status,
			stage: projection.stage,
			attempt: projection.attempt,
			round: projection.round,
			usage: candidateUsage(book),
			handoff: book,
		}),
		true,
	);

	for (const evidence of candidateGenerations(book)) {
		if (evidence.verdict !== null)
			await writeFile(
				join(
					validationDir(
						f.root,
						runId,
						evidence.intent.round,
						evidence.intent.generation,
					),
					"verdict.json",
				),
				JSON.stringify(evidence.verdict),
				{ mode: 0o600 },
			);

		if (evidence.certification !== null)
			keepReview(f.root, evidence.certification.review);
	}

	return { ...f, book };
}

test("legacy claim and receipt views stay read-only and tolerate the private request journal", async () => {
	const f = await fixtureState();

	try {
		const stage = join(f.root, "stages", runId, "build-1");
		const before = await readViewerRun(f.root, runId);

		const claimBytes = await readFile(
			join(f.root, "claims", `${runId}.json`),
			"utf8",
		);

		assert.equal(viewerClaim(claimBytes, runId)?.usage, 20);
		assert.equal(
			(await readStageReceipt(join(stage, "receipt.json")))?.usage.total,
			20,
		);
		await writeFile(
			join(stage, "egress.requests.jsonl"),
			[
				JSON.stringify({
					v: 1,
					runId,
					stage: "build",
					attempt: 1,
					kind: "dispatch",
					req: 1,
					inputTokenEstimate: 30,
					maxOutputTokens: 100,
				}),
				JSON.stringify({
					v: 1,
					runId,
					stage: "build",
					attempt: 1,
					kind: "result",
					req: 1,
					inputTokens: 10,
					outputTokens: 10,
				}),
				JSON.stringify({
					v: 1,
					runId,
					stage: "build",
					attempt: 1,
					kind: "dispatch",
					req: 2,
					inputTokenEstimate: 30,
					maxOutputTokens: 100,
					privateSentinel: "DO_NOT_RENDER_JOURNAL",
				}),
				'{"kind":"result"',
			].join("\n"),
		);
		await mkdir(join(f.root, "accounting", runId), { recursive: true });
		await writeFile(join(f.root, "accounting", runId, "policy.json"), "{}");
		const inventoryBefore = await inventory(f.root);
		const after = await readViewerRun(f.root, runId);
		assert.deepEqual(after, before);
		assert.equal(
			JSON.stringify(after).includes("DO_NOT_RENDER_JOURNAL"),
			false,
		);
		assert.deepEqual(await inventory(f.root), inventoryBefore);
		assert.equal(
			await readFile(join(f.root, "claims", `${runId}.json`), "utf8"),
			claimBytes,
		);
	} finally {
		await rm(f.root, { recursive: true, force: true });
	}
});

test("real viewer routes separate published historical certification from working refresh generations", async () => {
	const f = await lifecycleState();
	const viewer = await startViewer({ stateDir: f.root, runId, port: 0 });
	const before = await inventory(f.root);

	try {
		const response = await fetch(
			`http://127.0.0.1:${viewer.port}/run/${runId}/timeline.json`,
		);

		assert.equal(response.status, 200);
		const page = objectOf(parseJson(await response.text()));
		const data = (arrayOf(fieldOf(page, "data")) ?? []).map(objectOf);
		assert.deepEqual(
			data
				.filter((e) => fieldOf(e, "event") === "historical certification")
				.map((e) => fieldOf(e, "generation")),
			[0, 1],
		);
		assert.equal(
			fieldOf(
				data.find((e) => fieldOf(e, "event") === "selected generation") ?? null,
				"generation",
			),
			2,
		);
		assert.match(
			textOf(
				fieldOf(
					data.find((e) => fieldOf(e, "event") === "published PR") ?? null,
					"detail",
				),
			) ?? "",
			/historical certification [a-f0-9]{40}; recorded readiness not_ready/,
		);
		assert.ok(
			!(arrayOf(fieldOf(page, "gaps")) ?? []).some((g) => {
				const source = textOf(fieldOf(objectOf(g), "source")) ?? "";

				return source.includes("review/") && source.includes("g2");
			}),
		);

		const html = await (
			await fetch(`http://127.0.0.1:${viewer.port}/run/${runId}/timeline`)
		).text();

		assert.match(
			html,
			/A passed check on an earlier change does not prove the current change/,
		);
		assert.match(html, /Execution \/ evidence round/);
		assert.ok(!html.includes("<script>"));
		assert.ok(html.includes("&lt;script&gt;"));

		const usage = objectOf(
			parseJson(
				await (
					await fetch(`http://127.0.0.1:${viewer.port}/run/${runId}/usage.json`)
				).text(),
			),
		);

		assert.equal(
			fieldOf(objectOf(fieldOf(usage, "data")), "accounted"),
			candidateUsage(f.book),
		);
		assert.equal(fieldOf(objectOf(fieldOf(usage, "data")), "total"), 20);
		assert.deepEqual(await inventory(f.root), before);
	} finally {
		await viewer.close();
		await rm(f.root, { recursive: true, force: true });
	}
});

test("viewer attributes round-global review attempts and usage to their immutable generations", async () => {
	const f = await lifecycleState();

	try {
		const template = JSON.parse(
			await readFile(join(f.stage, "receipt.json"), "utf8"),
		);

		for (const account of f.book.accounts) {
			const e = account.execution;

			const dir = join(
				f.root,
				"stages",
				runId,
				`${e.stage}-r${e.round}-${e.attempt}`,
			);

			const sessions = join(dir, "agent-0", "sessions");
			await mkdir(sessions, { recursive: true });
			await writeFile(
				join(dir, "receipt.json"),
				JSON.stringify({
					...template,
					stage: e.stage,
					attempt: e.attempt,
					stderr: [],
					usage: {
						total: 10,
						parent: 10,
						children: 0,
						byModel: { "openai/gpt-6.1-sol": 10 },
						gateway: 10,
						unreadChildren: 0,
					},
				}),
				{ mode: 0o600 },
			);
			await writeFile(
				join(sessions, "review.jsonl"),
				[
					{ type: "session", id: e.id, timestamp: "2026-10-31T00:00:10Z" },
					{
						type: "message",
						timestamp: "2026-10-31T00:00:11Z",
						message: {
							role: "assistant",
							provider: "openai",
							model: "gpt-6.1-sol",
							stopReason: "stop",
							usage: { totalTokens: 10 },
						},
					},
				]
					.map((r) => JSON.stringify(r))
					.join("\n"),
				{ mode: 0o600 },
			);
			await writeFile(
				join(dir, "egress.jsonl"),
				JSON.stringify({
					v: 1,
					runId,
					stage: e.stage,
					attempt: e.attempt,
					ts: "2026-10-31T00:00:10Z",
					decision: "deny",
					upstream: null,
					path: "/github",
					method: "GET",
					reason: "no-route",
				}),
				{ mode: 0o600 },
			);
		}

		const viewed = await readViewerRun(f.root, runId);
		assert.equal(viewed.usage.total, candidateUsage(f.book));
		assert.deepEqual(
			viewed.usage.sessions
				.filter((s) => s.stage === "review")
				.map((s) => [s.round, s.attempt, s.generation, s.tokens]),
			[
				[0, 1, 0, 10],
				[0, 2, 1, 10],
			],
		);
		assert.deepEqual(
			viewed.gateway
				.filter((g) => g.stage === "review")
				.map((g) => [g.round, g.attempt, g.generation]),
			[
				[0, 1, 0],
				[0, 2, 1],
			],
		);
		assert.equal(
			viewed.gaps.some((g) => /accounting|reconcile/.test(g.reason)),
			false,
		);
	} finally {
		await rm(f.root, { recursive: true, force: true });
	}
});

test("viewer shows selected generation round zero separately from active repair round one", async () => {
	const f = await lifecycleState();

	try {
		const prior = f.book.history[0];
		assert.ok(prior?.validation && prior.verdict);

		const initial = handoffCandidate(
			beginCandidate(f.book.pin, prior.patch, f.book.priorTokens),
			{
				kind: "observed",
				now: 1,
				main: prior.intent.baseSha,
				pr: { kind: "none" },
				executionAllowed: true,
				capacityAvailable: true,
				eligibility: "ready",
				readiness: { kind: "unavailable" },
			},
		);

		assert.ok(initial.effect?.kind === "validate");

		const failed = {
			...prior.verdict,
			pass: false,
			checks: prior.verdict.checks.map((c) => ({ ...c, passed: false })),
		};

		const repaired = handoffCandidate(initial.state, {
			kind: "effect_completed",
			completion: {
				kind: "validate",
				request: initial.effect,
				result: {
					kind: "finished",
					validation: prior.validation,
					verdict: failed,
					report: null,
					seats: ["code-review", "security-review", "simplify"],
					assessment: verdictAssessment(
						f.book.pin.runId,
						initial.effect.generation.round,
						initial.effect.generation.generation,
						failed,
					),
				},
			},
		}).state;

		const projection = candidateProjection(repaired);
		assert.equal(projection.round, 1);
		assert.equal(
			await fileRunFiles(f.root).writeClaim({
				runId,
				issue: 1,
				eventId: "1",
				seq: 12,
				stage: projection.stage,
				status: projection.status,
				attempt: projection.attempt,
				round: projection.round,
				usage: candidateUsage(repaired),
				handoff: repaired,
			}),
			true,
		);
		const viewed = await readViewerRun(f.root, runId);
		assert.equal(
			viewed.timeline.find((e) => e.event === "local claim")?.round,
			1,
		);
		assert.equal(
			viewed.timeline.find((e) => e.event === "selected generation")?.round,
			0,
		);
		assert.equal(
			viewed.timeline.find((e) => e.event === "selected generation")
				?.generation,
			0,
		);
		assert.equal(
			viewed.timeline.some((e) => e.event === "historical certification"),
			false,
		);
	} finally {
		await rm(f.root, { recursive: true, force: true });
	}
});

test("viewer timeline shows each assessment's class and subreason, never private details, and a gap when it is unreadable", async () => {
	const f = await lifecycleState();

	try {
		const evidence = candidateGenerations(f.book)[0];
		assert.ok(evidence?.verdict);
		const g = evidence.intent;
		const dir = validationDir(f.root, runId, g.round, g.generation);
		const failed = { ...evidence.verdict, pass: false };

		const cases: [
			import("../src/candidate/diagnosis.ts").FailureClass,
			RegExp,
		][] = [
			[
				{ kind: "missing_evidence", reason: "tree_replays_disagree" },
				/^missing_evidence: tree_replays_disagree\. Gate and candidate replays disagree\. No repair spent\.$/,
			],
			[
				{ kind: "missing_evidence", reason: "ci_replay_disagrees" },
				/^missing_evidence: ci_replay_disagrees\. CI and the gate-tree replay disagree\. No repair spent\.$/,
			],
			[
				{
					kind: "missing_evidence",
					reason: "materialize_mismatch",
					differing: 2,
				},
				/^missing_evidence: materialize_mismatch\. The replay's ignored changes differ from CI's in 2 paths\. No repair spent\.$/,
			],
			[
				{ kind: "infrastructure", reason: "timeout" },
				/^infrastructure: timeout\. Held\. No repair spent\.$/,
			],
			[
				{ kind: "oracle", cause: "unexpected_base", scenarios: ["S1"] },
				/^oracle: unexpected_base\. Scenarios S1\. No repair spent\.$/,
			],
			[
				{
					kind: "candidate",
					reason: "candidate_heldout",
					scenarios: ["S1"],
				},
				/^candidate: candidate_heldout\. Scenarios S1\. One bounded repair authorized\.$/,
			],
		];

		for (const [failure, detail] of cases) {
			await writeFile(
				join(dir, "assessment.json"),
				verdictAssessmentText(g.round, g.generation, failed, failure),
				{ mode: 0o600 },
			);

			const viewed = await readViewerRun(f.root, runId);
			const shown = viewed.timeline.filter((e) => e.event === "diagnosis");
			assert.equal(shown.length, 1);
			assert.match(shown[0]?.detail ?? "", detail);
			assert.equal(shown[0]?.round, g.round);
			assert.equal(shown[0]?.generation, g.generation);
			assert.ok(!viewed.gaps.some((x) => x.source.endsWith("assessment.json")));
		}

		await writeFile(join(dir, "assessment.json"), '{"kind":"failed"}\n', {
			mode: 0o600,
		});
		let viewed = await readViewerRun(f.root, runId);
		assert.equal(
			viewed.timeline.some((e) => e.event === "diagnosis"),
			false,
		);
		assert.ok(viewed.gaps.some((x) => x.source.endsWith("assessment.json")));

		await rm(join(dir, "assessment.json"));
		viewed = await readViewerRun(f.root, runId);
		assert.equal(
			viewed.timeline.some((e) => e.event === "diagnosis"),
			false,
		);
		assert.ok(!viewed.gaps.some((x) => x.source.endsWith("assessment.json")));
	} finally {
		await rm(f.root, { recursive: true, force: true });
	}
});

function verdictAssessmentText(
	round: number,
	generation: number,
	verdict: import("../src/core/run.ts").Verdict,
	failure: import("../src/candidate/diagnosis.ts").FailureClass,
): string {
	return storedAssessment({
		runId,
		round,
		generation,
		verdict,
		assessment: { kind: "failed", failure },
	}).text;
}

for (const matched of [true, false])
	test(`viewer records actual merged head independently of current refresh readiness (matched=${matched})`, async () => {
		const f = await lifecycleState();

		try {
			const head = matched
				? f.book.history[0]?.certification?.verdict.candidateSha
				: "f".repeat(40);

			assert.ok(head && isGitSha(head));
			const mergeSha = "e".repeat(40);
			assert.ok(isGitSha(mergeSha));

			const step = handoffCandidate(f.book, {
				kind: "observed",
				now: 300,
				main: null,
				pr: { kind: "merged", number: 5, head, mergeSha, actor: null },
				executionAllowed: false,
				capacityAvailable: false,
				eligibility: "withdrawn",
				readiness: { kind: "unavailable" },
			});

			assert.ok(step.effect?.kind === "finish_pr");

			const ended = handoffCandidate(step.state, {
				kind: "effect_completed",
				completion: { kind: "finish_pr", request: step.effect },
			}).state;

			assert.equal(
				await fileRunFiles(f.root).writeClaim({
					runId,
					issue: 1,
					eventId: "1",
					seq: 11,
					stage: "land",
					status: "landed",
					attempt: 1,
					usage: candidateUsage(ended),
					handoff: ended,
				}),
				true,
			);

			const viewed = await readViewerRun(f.root, runId);
			const merged = viewed.timeline.find((e) => e.event === "actual merge");
			assert.match(
				merged?.detail ?? "",
				matched
					? /matching historical factory certification/
					: /owner override/,
			);
			assert.match(merged?.detail ?? "", /actor unknown/);
			assert.match(merged?.detail ?? "", /recorded readiness not_ready/);
		} finally {
			await rm(f.root, { recursive: true, force: true });
		}
	});

for (const damage of ["missing", "corrupt", "wrong_owner", "public_file"])
	test(`viewer refuses unavailable candidate private evidence (${damage})`, async () => {
		const f = await lifecycleState();

		try {
			const path = join(f.root, "claims", `${runId}.json`);
			const claim = JSON.parse(await readFile(path, "utf8"));

			if (damage === "public_file") await fs.chmod(path, 0o644);
			else {
				if (damage === "missing") {
					delete claim.handoff;
					claim.status = "waiting";
				}

				if (damage === "corrupt") claim.handoff = { kind: "broken" };

				if (damage === "wrong_owner")
					claim.handoff.pin.repo = "other/repository";
				await writeFile(path, JSON.stringify(claim));
			}

			const viewed = await readViewerRun(f.root, runId);
			assert.equal(viewed.complete, false);
			assert.ok(viewed.gaps.some((g) => g.source.startsWith("claims/")));
			assert.equal(
				viewed.timeline.some((e) => e.event === "historical certification"),
				false,
			);
		} finally {
			await rm(f.root, { recursive: true, force: true });
		}
	});

test("missing-book viewer retains an actual merge observation without inventing certification or active round", async () => {
	const f = await lifecycleState();

	try {
		const pin = f.book.pin;
		const g = f.book.current;
		assert.ok(g.validation?.publication);

		const marker: Marker = {
			v: 3,
			runId,
			repo: pin.repo,
			issue: 1,
			eventId: "1",
			eventAt: "2026-10-31T00:00:00Z",
			snapshotDigest: digestOf("snapshot"),
			workflowSha: pin.workflowSha,
			workflowDigest: pin.workflowDigest,
			stage: "validate",
			status: "blocked",
			attempt: 1,
			seq: 11,
			branch: g.validation.publication.branch,
			candidate: g.validation.publication.candidateSha,
			round: g.intent.round,
			ciRun: g.validation.ciRunId,
			pr: 5,
			handoff: {
				generation: g.intent.generation,
				intentDigest: g.intent.digest,
				refreshes: 2,
				reviewAttempts: [2, 0, 0],
				promoted: f.book.published?.promoted.digest ?? null,
			},
			usage: candidateUsage(f.book),
			cursor: null,
		};

		assert.equal(parseMarker(formatMarker(marker)).kind, "marker");
		assert.equal(
			await fileRunFiles(f.root).writeClaim({
				runId,
				issue: 1,
				eventId: "1",
				seq: 11,
				status: "blocked",
				stage: "validate",
				attempt: 1,
				usage: marker.usage,
				marker,
			}),
			true,
		);
		const dir = join(f.root, "handoff", runId);
		await mkdir(dir, { recursive: true, mode: 0o700 });
		const path = join(dir, "missing-evidence-observation.json");
		await writeFile(
			path,
			JSON.stringify({
				kind: "merged",
				number: 5,
				head: "c".repeat(40),
				mergeSha: "e".repeat(40),
				actor: null,
			}),
			{ mode: 0o600 },
		);
		const viewed = await readViewerRun(f.root, runId);
		assert.equal(viewed.complete, false);
		assert.equal(
			viewed.timeline.find((e) => e.event === "local claim")?.round,
			null,
		);
		assert.equal(
			viewed.timeline.some((e) => e.event === "historical certification"),
			false,
		);
		assert.match(
			viewed.timeline.find(
				(e) => e.event === "actual merge (evidence unavailable)",
			)?.detail ?? "",
			/actor unknown; certification unavailable; accounting unresolved/,
		);
		await writeFile(
			path,
			JSON.stringify({
				kind: "merged",
				number: 5,
				head: "c".repeat(40),
				mergeSha: null,
				actor: null,
			}),
		);
		const invalid = await readViewerRun(f.root, runId);
		assert.ok(
			invalid.gaps.some(
				(g) => g.reason === "invalid missing-evidence merge observation",
			),
		);
		assert.equal(
			invalid.timeline.some(
				(e) => e.event === "actual merge (evidence unavailable)",
			),
			false,
		);
	} finally {
		await rm(f.root, { recursive: true, force: true });
	}
});

async function inventory(root: string): Promise<string[]> {
	const entries: string[] = [];

	for (const entry of await readdir(root, { withFileTypes: true })) {
		const path = join(root, entry.name);

		if (entry.isDirectory()) entries.push(...(await inventory(path)));
		else entries.push(`${path}:${digestOf(await readFile(path))}`);
	}

	return entries.sort();
}

test("receipt and verdict reader extractions preserve their existing parse contracts", async () => {
	const { root, stage } = await fixtureState();

	try {
		const parsed = await readStageReceipt(join(stage, "receipt.json"));
		assert.equal(parsed?.usage.total, 20);
		assert.deepEqual(parsed?.outcome, { kind: "passed" });
		assert.equal(await readStageReceipt(join(stage, "absent")), null);
		const verdict = { pass: false, checks: [] };
		await writeFile(join(root, "verdict.json"), JSON.stringify(verdict), {
			mode: 0o600,
		});
		assert.deepEqual(readStoredVerdict(join(root, "verdict.json")), verdict);
		await fs.chmod(join(root, "verdict.json"), 0o644);
		assert.throws(() => readStoredVerdict(join(root, "verdict.json")));
		await fs.chmod(join(root, "verdict.json"), 0o600);
		await writeFile(join(root, "verdict.json"), "{");
		assert.throws(() => readStoredVerdict(join(root, "verdict.json")));
	} finally {
		await rm(root, { recursive: true, force: true });
	}
});

test("missing marker history alone renders a neutral info Notice", async () => {
	const { root } = await fixtureState();

	try {
		await rm(join(root, "markers", `${runId}.jsonl`));
		const run = await readViewerRun(root, runId);
		assert.deepEqual(run.gaps, [
			{ source: `markers/${runId}.jsonl`, reason: markerHistoryGap },
		]);
		assert.equal(run.complete, false);

		const html = renderRun(run, "timeline", "/factory");
		assert.match(html, /class="gaps notice"/);
		assert.ok(html.includes(icons["info-circle"]));
		assert.ok(!html.includes(icons["alert-triangle"]));
		assert.doesNotMatch(html, /notice-error/);
	} finally {
		await rm(root, { recursive: true, force: true });
	}
});

test("restyled runs keep state words and evidence, with error glyphs only for failures and problem gaps", async () => {
	const { root } = await fixtureState();

	try {
		const run = await readViewerRun(root, runId);

		const expected = {
			source: `markers/${runId}.jsonl`,
			reason: markerHistoryGap,
		};

		const neutral = renderRun(
			{ ...run, gaps: [expected] },
			"timeline",
			"/factory",
		);

		assert.match(neutral, /class="local">Local evidence<\/span>/);
		assert.match(neutral, /class="eyebrow">Run · run <code>/);
		assert.doesNotMatch(neutral, /Run \/|stage_passed<\/span>/);
		assert.match(neutral, /class="gaps notice"/);
		assert.ok(neutral.includes(icons["info-circle"]));
		assert.ok(!neutral.includes(icons["alert-triangle"]));
		assert.ok(neutral.includes(escapeHtml(expected.reason)));
		assert.match(neutral, /<th scope="col">Stage<\/th>/);
		assert.match(neutral, /<td data-label="Stage">build<\/td>/);

		const failed = renderRun(
			{ ...run, status: "failed" },
			"timeline",
			"/factory",
		);

		assert.match(failed, /class="eyebrow">Run · run <code>/);
		assert.doesNotMatch(failed, /Run \/|class="status status-error"/);
		assert.ok(!failed.includes('class="gaps'));

		const problem = renderRun(
			{
				...run,
				gaps: [
					expected,
					{ source: "receipt.json", reason: "missing_stage_receipt" },
					{ source: "second-receipt.json", reason: "missing_stage_receipt" },
				],
			},
			"timeline",
			"/factory",
		);

		assert.match(problem, /class="gaps notice notice-error"/);
		assert.ok(problem.includes(icons["alert-triangle"]));
		assert.ok(problem.includes("missing_stage_receipt"));
		assert.match(problem, /Problems <span class="count">2<\/span>/);
		assert.match(problem, /Expected <span class="count">1<\/span>/);
		assert.ok(problem.indexOf("Problems") < problem.indexOf("Expected"));
		assert.match(problem, /\(2 records\)/);
		assert.ok(problem.includes("second-receipt.json"));

		for (const status of [
			"landed",
			"running",
			"blocked",
			"budget_exhausted",
			"unavailable",
		])
			assert.ok(
				!renderRun({ ...run, status }, "timeline", "").includes(
					icons["alert-triangle"],
				),
			);
	} finally {
		await rm(root, { recursive: true, force: true });
	}
});

test("vendored glyphs are decorative, inherit colour and use em sizes", () => {
	assert.deepEqual(
		Object.keys(icons).sort(),
		[
			"alert-circle",
			"alert-triangle",
			"message-question",
			"help-circle",
			"circle-check",
			"circle",
			"info-circle",
			"external-link",
		].sort(),
	);

	for (const svg of Object.values(icons)) {
		assert.match(svg, /aria-hidden="true"/);
		assert.match(svg, /stroke="currentColor"/);
		assert.match(svg, /width="1em" height="1em"/);
		assert.doesNotMatch(svg, /<script|href=|style=/);
	}
});

test("viewer aggregates parent and two child models without double counting", async () => {
	const { root, stage } = await fixtureState();

	try {
		const run = await readViewerRun(root, runId);
		assert.equal(run.complete, true, JSON.stringify(run.gaps));
		assert.equal(run.usage.total, 20);
		assert.deepEqual(run.usage.models, [
			{
				model: "openai/gpt-6.1-sol",
				parent: 10,
				children: 3,
				total: 13,
				cost: "unavailable",
			},
			{
				model: "openai/gpt-6.1-terra",
				parent: 0,
				children: 7,
				total: 7,
				cost: "unavailable",
			},
		]);
		assert.equal(run.children.length, 2);
		assert.ok(
			run.children.every(
				(child) => child.parent === "parent" && child.timeline.length === 2,
			),
		);
		assert.equal(run.gateway[0]?.decision, "deny");
		assert.match(run.gateway[0]?.path ?? "", /github/);
		await mkdir(join(stage, "draft"));
		await cp(join(stage, "receipt.json"), join(stage, "draft", "receipt.json"));
		assert.equal((await readViewerRun(root, runId)).usage.total, 20);
	} finally {
		await rm(root, { recursive: true, force: true });
	}
});

test("an execution missing its receipt is a gap even when other stages have receipts", async () => {
	const { root, stage } = await fixtureState();

	try {
		const other = join(root, "stages", runId, "accept-1");
		await mkdir(other, { recursive: true });
		await cp(join(stage, "receipt.json"), join(other, "receipt.json"));
		await rm(join(stage, "receipt.json"));
		const run = await readViewerRun(root, runId);
		assert.ok(
			run.gaps.some((gap) => gap.source.endsWith("build-1/receipt.json")),
		);
	} finally {
		await rm(root, { recursive: true, force: true });
	}
});

test("corrupt receipts, sessions and unsafe sources stay visible gaps", async () => {
	const { root, stage, sessions } = await fixtureState();

	try {
		await rm(join(sessions, "child-one.jsonl"));
		await writeFile(join(sessions, "broken.jsonl"), "{bad\n");
		await writeFile(join(stage, "receipt.json"), "{broken");
		await symlink("/etc/passwd", join(stage, "leak.jsonl"));
		const run = await readViewerRun(root, runId);
		assert.equal(run.complete, false);
		assert.ok(
			run.gaps.some((gap) => gap.reason.includes("missing_child_session")),
		);
		assert.ok(run.gaps.some((gap) => gap.reason.includes("corrupt JSONL")));
		assert.ok(run.gaps.some((gap) => gap.reason.includes("stage receipt")));
		assert.ok(run.gaps.some((gap) => gap.reason.includes("symlink")));
	} finally {
		await rm(root, { recursive: true, force: true });
	}
});

test("HTML is escaped, four JSON views exist and requests do not mutate evidence", async () => {
	const { root } = await fixtureState();
	const before = await inventory(root);
	const viewer = await startViewer({ stateDir: root, runId, port: 0 });

	try {
		const url = `http://127.0.0.1:${viewer.port}/run/${runId}`;
		const html = await (await fetch(`${url}/timeline`)).text();
		assert.match(
			html,
			/&lt;script&gt;alert\(&#39;canary&#39;\)&lt;\/script&gt;/,
		);
		assert.ok(!html.includes("<script>"));
		assert.match(html, /&lt;img/);

		for (const view of ["timeline", "usage", "children", "gateway"]) {
			const response = await fetch(`${url}/${view}.json`);
			assert.equal(response.status, 200);
			assert.match(
				response.headers.get("content-type") ?? "",
				/application\/json/,
			);
		}

		for (const method of ["POST", "PUT", "DELETE"])
			assert.equal((await fetch(`${url}/timeline`, { method })).status, 405);
		assert.equal((await fetch(`${url}/../../etc/passwd`)).status, 404);
		assert.deepEqual(await inventory(root), before);
	} finally {
		await viewer.close();
		await rm(root, { recursive: true, force: true });
	}
});

test("viewer CLI errors never call gh or a model", async () => {
	const stderr: string[] = [];

	for (const argv of [
		["viewer"],
		["viewer", "--state-dir", "/absent"],
		["viewer", "--state-dir", "/tmp", "--port", "0"],
		["viewer", "--state-dir", "/tmp", "--run", "../../etc/passwd"],
	]) {
		const code = await runCli(argv, {
			readPlatformFile: noPlatformFile,
			exec: async () => {
				throw new Error("unexpected command");
			},
			env: () => undefined,
			stdout: () => {},
			stderr: (text) => stderr.push(text),
		});

		assert.ok(code > 0);
	}

	assert.equal(stderr.length, 4);
});

test("viewer reports gaps instead of inventing a complete run", async () => {
	const root = await mkdtemp(join(tmpdir(), "factory-viewer-"));

	try {
		await mkdir(join(root, "stages", runId), { recursive: true });
		const run = await readViewerRun(root, runId);
		assert.equal(run.complete, false);
		assert.ok(run.gaps.some((gap) => gap.source === "status.json"));
		assert.ok(run.gaps.some((gap) => gap.source.includes("claims")));
	} finally {
		await rm(root, { recursive: true, force: true });
	}
});

test("viewer is loopback-only, rejects foreign authorities and has no writes", async () => {
	const root = await mkdtemp(join(tmpdir(), "factory-viewer-"));
	const viewer = await startViewer({ stateDir: root, port: 0 });

	try {
		const url = `http://127.0.0.1:${viewer.port}`;
		assert.equal((await fetch(url)).status, 200);
		assert.equal(
			await new Promise<number>((done, reject) => {
				const req = request(
					url,
					{ headers: { Host: "evil.example" } },
					(response) => {
						response.resume();
						done(response.statusCode ?? 0);
					},
				);

				req.on("error", reject);
				req.end();
			}),
			403,
		);
		assert.equal(
			(await fetch(url, { headers: { Origin: "https://evil.example" } }))
				.status,
			403,
		);

		for (const method of ["POST", "PUT", "DELETE", "HEAD", "OPTIONS"]) {
			assert.equal((await fetch(url, { method })).status, 405);
		}

		const response = await fetch(url);
		assert.match(
			response.headers.get("content-security-policy") ?? "",
			/default-src 'none'/,
		);
		assert.equal(response.headers.get("access-control-allow-origin"), null);
	} finally {
		await viewer.close();
		await rm(root, { recursive: true, force: true });
	}
});

test("missing earlier stage receipts are gaps even when the entire directory is gone", async () => {
	const { root } = await fixtureState();

	try {
		await rm(join(root, "stages", runId, "specify-1"), { recursive: true });
		const run = await readViewerRun(root, runId);
		assert.equal(run.complete, false);
		assert.ok(
			run.gaps.some((g) => g.source.endsWith("specify-1/receipt.json")),
		);
	} finally {
		await rm(root, { recursive: true, force: true });
	}
});

test("timeline uses parsed mixed-precision timestamps and stable source order on ties", async () => {
	const { root, sessions } = await fixtureState();

	try {
		const path = join(sessions, "parent.jsonl");
		const text = await readFile(path, "utf8");
		await writeFile(
			path,
			text
				.replaceAll("2026-10-31T00:00:00Z", "2026-10-31T06:31:54.863Z")
				.replaceAll("2026-10-31T00:00:01Z", "2026-10-31T06:31:54.863Z"),
		);
		const marker = join(root, "markers", `${runId}.jsonl`);
		await writeFile(
			marker,
			(await readFile(marker, "utf8")).replace(
				"2026-10-31T00:00:06Z",
				"2026-10-31T06:31:54Z",
			),
		);
		const run = await readViewerRun(root, runId);
		const timed = run.timeline.filter((e) => e.at !== null);
		assert.deepEqual(
			timed.map((e) => Date.parse(e.at ?? "")),
			timed.map((e) => Date.parse(e.at ?? "")).sort((a, b) => a - b),
		);
		assert.deepEqual(
			timed
				.filter((e) => e.at === "2026-10-31T06:31:54.863Z")
				.map((e) => e.event),
			["session", "assistant"],
		);
	} finally {
		await rm(root, { recursive: true, force: true });
	}
});

test("admission repository comes from the run identity, not the default repository", async () => {
	const { root, runId: id } = await fixtureState("different/project");

	try {
		const run = await readViewerRun(root, id);
		assert.equal(run.complete, true, JSON.stringify(run.gaps));
		assert.ok(run.issue !== null);
	} finally {
		await rm(root, { recursive: true, force: true });
	}
});

test("claims are guarded regular bounded reads and sibling FIFOs cannot hang a view", async () => {
	const { root } = await fixtureState();
	const outside = await mkdtemp(join(tmpdir(), "viewer-outside-"));

	try {
		const sibling = join(root, "claims", `${"d".repeat(64)}.json`);
		execFileSync("mkfifo", [sibling]);
		const script = `import { readViewerRun } from ${JSON.stringify(new URL("../server/viewer.ts", import.meta.url).href)}; await readViewerRun(${JSON.stringify(root)}, ${JSON.stringify(runId)});`;
		execFileSync(process.execPath, ["--input-type=module", "-e", script], {
			timeout: 5000,
		});
		const path = join(root, "claims", `${runId}.json`);
		await rm(path);
		await writeFile(join(outside, "claim"), "{}");
		await symlink(join(outside, "claim"), path);
		assert.ok(
			(await readViewerRun(root, runId)).gaps.some(
				(g) => g.source === `claims/${runId}.json`,
			),
		);
		await rm(path);
		execFileSync("mkfifo", [path]);
		execFileSync(process.execPath, ["--input-type=module", "-e", script], {
			timeout: 5000,
		});
		await rm(path);
		await writeFile(path, " ".repeat(8 * 1024 * 1024 + 1));
		assert.ok(
			(await readViewerRun(root, runId)).gaps.some(
				(g) =>
					g.source === `claims/${runId}.json` && g.reason.includes("limit"),
			),
		);
	} finally {
		await rm(root, { recursive: true, force: true });
		await rm(outside, { recursive: true, force: true });
	}
});

test("invalid allowed-host is a usage error, exit 2", async () => {
	for (const host of ["evil.com", "Box.Tail.ts.net", "box.tail.ts.net:443"]) {
		assert.equal(
			await runCli(["viewer", "--state-dir", "/tmp", "--allowed-host", host], {
				readPlatformFile: noPlatformFile,
				exec: async () => {
					throw new Error("unexpected command");
				},
				env: () => undefined,
				stdout: () => {},
				stderr: () => {},
			}),
			2,
		);
	}
});

test("invalid base-path is a usage error, exit 2", async () => {
	for (const base of [
		"factory",
		"/",
		"/factory/",
		"//evil.example",
		"/a/../b",
		"/Factory",
	]) {
		assert.equal(
			await runCli(["viewer", "--state-dir", "/tmp", "--base-path", base], {
				readPlatformFile: noPlatformFile,
				exec: async () => {
					throw new Error("unexpected command");
				},
				env: () => undefined,
				stdout: () => {},
				stderr: () => {},
			}),
			2,
		);
	}
});

test("a base path prefixes every rendered link and redirect, with direct and proxy-stripped routes", async () => {
	const { root } = await fixtureState();

	const viewer = await startViewer({
		stateDir: root,
		port: 0,
		basePath: "/factory",
	});

	const pinned = await startViewer({
		stateDir: root,
		port: 0,
		runId,
		basePath: "/factory",
	});

	const plain = await startViewer({ stateDir: root, port: 0 });

	const links = (html: string) =>
		[...html.matchAll(/(?:href|src)="([^"]*)"/g)].map((m) => m[1] ?? "");

	try {
		const url = `http://127.0.0.1:${viewer.port}`;
		const index = await (await fetch(`${url}/`)).text();
		const run = await (await fetch(`${url}/run/${runId}/usage`)).text();
		assert.ok(links(index).includes("/factory/manifest.webmanifest"));
		assert.ok(links(run).includes(`/factory/run/${runId}/usage.json`));

		for (const href of [...links(index), ...links(run)])
			assert.match(href, /^\/factory\//, href);
		assert.equal((await fetch(`${url}/style.css`)).status, 200);
		assert.equal((await fetch(`${url}/factory/`)).status, 200);

		const redirect = await fetch(`http://127.0.0.1:${pinned.port}/`, {
			redirect: "manual",
		});

		assert.equal(redirect.status, 302);
		assert.equal(
			redirect.headers.get("location"),
			`/factory/run/${runId}/timeline`,
		);

		const unprefixed = await (
			await fetch(`http://127.0.0.1:${plain.port}/`)
		).text();

		assert.ok(links(unprefixed).includes("/style.css"));
		assert.ok(links(unprefixed).includes("/manifest.webmanifest"));
	} finally {
		await viewer.close();
		await pinned.close();
		await plain.close();
		await rm(root, { recursive: true, force: true });
	}
});

test("escaping quotes and every bidi control leaves visible escapes", () => {
	assert.equal(escapeHtml('"'), "&quot;");

	for (const n of [
		0x061c, 0x200e, 0x200f, 0x202a, 0x202b, 0x202c, 0x202d, 0x202e, 0x2066,
		0x2067, 0x2068, 0x2069,
	])
		assert.equal(
			escapeHtml(String.fromCodePoint(n)),
			`\\u${n.toString(16).padStart(4, "0")}`,
		);
});

test("run pin, unknown runs, listener and security headers are enforced", async () => {
	const { root } = await fixtureState();
	const other = "e".repeat(64);
	await mkdir(join(root, "stages", other));
	const viewer = await startViewer({ stateDir: root, port: 0, runId });
	const unpinned = await startViewer({ stateDir: root, port: 0 });

	try {
		assert.equal(viewer.address, "127.0.0.1");
		assert.equal(
			(await fetch(`http://127.0.0.1:${viewer.port}/run/${other}/timeline`))
				.status,
			404,
		);
		assert.equal(
			(
				await fetch(
					`http://127.0.0.1:${unpinned.port}/run/${"f".repeat(64)}/timeline`,
				)
			).status,
			404,
		);

		for (const path of [
			"/",
			`/run/${runId}/timeline`,
			`/run/${runId}/usage.json`,
			"/absent",
		]) {
			const response = await fetch(`http://127.0.0.1:${viewer.port}${path}`);
			assert.match(
				response.headers.get("content-security-policy") ?? "",
				/frame-ancestors 'none'/,
			);
			assert.equal(response.headers.get("x-content-type-options"), "nosniff");
			assert.equal(response.headers.get("cache-control"), "no-store");
		}
	} finally {
		await viewer.close();
		await unpinned.close();
		await rm(root, { recursive: true, force: true });
	}
});

test("guarded reader refuses symlinked run directories and nofollow closes a final-path swap", async () => {
	const { root } = await fixtureState();
	const dir = join(root, "stages", runId);
	await fs.rename(dir, `${dir}-outside`);
	await symlink(`${dir}-outside`, dir);

	try {
		assert.ok(
			(await readViewerRun(root, runId)).gaps.some(
				(g) => g.source === `stages/${runId}`,
			),
		);
		assert.ok(
			!(await readViewerRun(root, runId)).timeline.some(
				(e) => e.event === "stage receipt",
			),
		);
		const claimPath = join(root, "claims", `${runId}.json`);
		await fs.rename(claimPath, `${claimPath}.saved`);
		await symlink(`${claimPath}.saved`, claimPath);
		const reader = new Evidence(root);
		reader.safe = async () => true;
		assert.equal(await reader.text(claimPath), null);
		assert.ok(reader.gaps.some((g) => g.source === `claims/${runId}.json`));
	} finally {
		await rm(root, { recursive: true, force: true });
	}
});

test("file, aggregate byte and directory entry caps yield gaps", async () => {
	const { root, sessions, stage } = await fixtureState();

	try {
		const large = join(sessions, "large.jsonl");
		await writeFile(large, " ".repeat(8 * 1024 * 1024 + 1));
		assert.ok(
			(await readViewerRun(root, runId)).gaps.some(
				(g) => g.source.endsWith("large.jsonl") && g.reason.includes("limit"),
			),
		);
		await rm(large);

		for (let i = 0; i < 7; i++)
			await writeFile(
				join(sessions, `large-${i}.jsonl`),
				" ".repeat(8 * 1024 * 1024),
			);
		assert.ok(
			(await readViewerRun(root, runId)).gaps.some(
				(g) => g.source.includes("large-") && g.reason.includes("limit"),
			),
		);

		for (let i = 0; i < 7; i++) await rm(join(sessions, `large-${i}.jsonl`));
		const many = join(stage, "many");
		await mkdir(many);

		for (let i = 0; i < 10001; i++)
			fsSync.writeFileSync(join(many, String(i)), "");
		assert.ok(
			(await readViewerRun(root, runId)).gaps.some(
				(g) => g.reason === "entry limit",
			),
		);
	} finally {
		await rm(root, { recursive: true, force: true });
	}
});

for (const scenario of [
	"session",
	"reconcile",
	"receipt total reconcile",
	"gateway",
	"markers",
	"settlement",
	"receipt binding",
	"audit binding",
	"truncated",
])
	test(`named evidence gap: ${scenario}`, async () => {
		const { root, sessions, stage } = await fixtureState();

		try {
			let reason = "";

			if (scenario === "session") {
				await rm(sessions, { recursive: true });
				reason = "Pi session JSONL";
			}

			if (scenario === "reconcile") {
				await writeFile(
					join(sessions, "parent.jsonl"),
					(await readFile(join(sessions, "parent.jsonl"), "utf8")).replace(
						'"totalTokens":10',
						'"totalTokens":11',
					),
				);
				reason = "reconcile";
			}

			if (scenario === "receipt total reconcile") {
				const path = join(stage, "receipt.json");
				const receipt = JSON.parse(await readFile(path, "utf8"));
				receipt.usage.total++;
				await writeFile(path, JSON.stringify(receipt));
				reason = "reconcile";
			}

			if (scenario === "gateway") {
				await rm(join(stage, "egress.jsonl"));
				reason = "gateway audit missing";
			}

			if (scenario === "markers") {
				await rm(join(root, "markers", `${runId}.jsonl`));
				reason = "marker comment history";
			}

			if (["settlement", "receipt binding", "truncated"].includes(scenario)) {
				const path = join(stage, "receipt.json");
				const receipt = JSON.parse(await readFile(path, "utf8"));

				if (scenario === "settlement") {
					receipt.settlement.event = null;
					reason = "settlement not observed";
				}

				if (scenario === "receipt binding") {
					receipt.runId = "a".repeat(64);
					reason = "mismatched stage receipt";
				}

				if (scenario === "truncated") {
					receipt.session_truncated = ["old.jsonl"];
					reason = "session_truncated";
				}

				await writeFile(path, JSON.stringify(receipt));
			}

			if (scenario === "audit binding") {
				const path = join(stage, "egress.jsonl");
				await writeFile(
					path,
					(await readFile(path, "utf8")).replace(runId, "b".repeat(64)),
				);
				reason = "mismatched audit";
			}

			const run = await readViewerRun(root, runId);
			assert.equal(run.complete, false);
			assert.ok(
				run.gaps.some((g) => g.reason.includes(reason)),
				JSON.stringify(run.gaps),
			);
		} finally {
			await rm(root, { recursive: true, force: true });
		}
	});

test("receipt recovery only reads the designated output file", async () => {
	const { root, stage } = await fixtureState();

	try {
		const receipt = JSON.parse(
			await readFile(join(stage, "receipt.json"), "utf8"),
		);

		receipt.output = { file: "other.txt", kept: true, bytes: 6 };
		receipt.stage = "specify";
		const target = join(root, "stages", runId, "specify-1", "draft");
		await mkdir(target);
		await writeFile(join(target, "receipt.json"), JSON.stringify(receipt));
		await writeFile(
			join(target, "other.txt"),
			JSON.stringify({
				kind: "questions",
				questions: [{ text: "Which format?", cites: [] }],
			}),
		);
		const repo = "giuseppecrj/pi-herdr-factorio";
		assert.ok(isRepoSlug(repo));

		const parsed = parseWorkflow({
			platform: EXE_DEV_PLATFORM,
			text: `---\nrepository: ${repo}\n---\n`,
			repo,
			env: (name) => (name === "HOME" ? "/home/factory" : undefined),
		});

		assert.equal(parsed.kind, "valid");

		if (parsed.kind !== "valid") return;
		const settings = parsed.config.stages.specify;

		const result = await runSpecify(
			{
				runId,
				stage: "specify",
				attempt: 1,
				workspace: root,
				prompt: "unused",
				tools: [],
				skills: [],
				settings: {
					model: settings.model,
					fallback: null,
					maxTokens: 40000,
					budget: { maxTurns: 10, wallMs: 60000, stallMs: 60000 },
				},
				remainingRunTokens: 40000,
				signal: new AbortController().signal,
				progress: () => {},
				specify: { title: "Title", body: "Body", answers: null, files: [] },
			},
			join(target, ".."),
			() => {
				throw new Error("unexpected model");
			},
		);

		assert.equal(result.kind, "failed");
	} finally {
		await rm(root, { recursive: true, force: true });
	}
});

test("denied gateway requests never invent an upstream", async () => {
	const { root } = await fixtureState();

	try {
		assert.equal(
			(await readViewerRun(root, runId)).gateway[0]?.destination,
			"not forwarded (no upstream)",
		);
	} finally {
		await rm(root, { recursive: true, force: true });
	}
});

test("expected missing logs stay neutral, but corrupt receipts, claims and verdicts are problems", () => {
	for (const gap of [
		{ source: "markers/run.jsonl", reason: markerHistoryGap },
		{
			source: "stages/run/pi-stderr-0.log",
			reason: "missing, unsafe, unreadable or over size limit",
		},
		{ source: "stages/run", reason: "Pi session JSONL files missing" },
		{ source: "stages/run", reason: "gateway audit missing" },
	])
		assert.equal(expectedGap(gap, "landed"), true);

	for (const gap of [
		{ source: "receipt.json", reason: "corrupt or mismatched stage receipt" },
		{ source: "claims/run.json", reason: "corrupt or wrong-owner claim/book" },
		{ source: "validation/verdict.json", reason: "corrupt stored verdict" },
	])
		assert.equal(expectedGap(gap, "landed"), false);

	for (const status of ["running", "failed", "budget_exhausted"])
		for (const reason of [
			"gateway audit missing",
			"Pi session JSONL files missing",
		])
			assert.equal(
				expectedGap({ source: "stages/run", reason }, status),
				false,
			);
});

test("viewer refuses missing state and occupied port", async () => {
	await assert.rejects(
		startViewer({ stateDir: "/tmp", bind: "0.0.0.0", port: 0 }),
		/loopback bind required/,
	);
	await assert.rejects(
		startViewer({ stateDir: "/not/a/factory/state", port: 0 }),
	);
	const root = await mkdtemp(join(tmpdir(), "factory-viewer-"));
	const viewer = await startViewer({ stateDir: root, port: 0 });

	try {
		assert.equal(viewer.address, "127.0.0.1");
		await assert.rejects(startViewer({ stateDir: root, port: viewer.port }));
	} finally {
		await viewer.close();
		await rm(root, { recursive: true, force: true });
	}
});
