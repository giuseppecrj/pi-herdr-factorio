import assert from "node:assert/strict";
import {
	readFileSync,
	mkdtempSync,
	mkdirSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { it } from "node:test";
import { parseWorkflow, isGitSha } from "../src/workflow.ts";
import { digestOf, runIdOf } from "../src/run.ts";
import {
	sampled,
	scorerDigest,
	scorerAnswer,
	scorerTouched,
	scorerTokenShare,
	FAMILY_NOTE,
	enqueueScore,
	scoreHistory,
	allocateMeasurement,
	automaticScoreEnrolled,
} from "../src/scorers.ts";
import { pumpScoreOutbox, pumpLedgerOutbox } from "../server/controller.ts";
import {
	latestScores,
	parseScores,
	ledgerApiOf,
	appendRun,
	indexScores,
	scoreEventOf,
	type ScoreEvent,
	parseLedger,
	ledgerRowOf,
} from "../src/ledger.ts";
import {
	GitHubPublicationApi,
	readLedgerFile,
	readLedgerCommit,
	LEDGER_FILE,
	SCORE_FILE,
} from "../src/publication.ts";
import { LedgerGit, repo } from "./ledger-git.ts";
import { EXE_DEV_PLATFORM } from "../src/platform.ts";

const text = readFileSync(
	new URL("../.github/factory/WORKFLOW.md", import.meta.url),
	"utf8",
);

const load = (source = text) =>
	parseWorkflow({
		platform: EXE_DEV_PLATFORM,
		text: source,
		repo,
		env: (name) => process.env[name],
	});

const parsed = load();

assert.equal(parsed.kind, "valid");

if (parsed.kind !== "valid") throw new Error("fixture");

const scorer = parsed.config.scorers?.[0];

assert.ok(scorer);

const judge = "openai/gpt-6.1-sol";
const runId = digestOf("scored run");

function event(
	seq = 1,
	supersedes: ScoreEvent["supersedes"] = null,
): ScoreEvent {
	return {
		id: digestOf(`event-${seq}`),
		scoredRunId: runId,
		scorerId: "outcome-quality",
		scorerDigest: scorerDigest(scorer!, judge),
		inputDigest: digestOf("input"),
		includeChildren: true,
		label: "matched",
		score: 1,
		passingScore: 1,
		reasoning: "ledger.outcome records completion",
		judgeModel: judge,
		judgeFamily: "openai",
		familyNote: FAMILY_NOTE,
		usage: { tokens: 10, wallMs: 100, exact: true },
		supersedes,
		at: `2026-11-10T10:00:0${seq}Z`,
		status: "scored",
		voided: null,
	};
}

it("trusted scorers parse declared labels, the 10 percent default, and refuse unknown/unpinned graders", () => {
	assert.equal(scorer.samplingRate, 10);
	assert.equal(load(text.replace("    samplingRate: 10\n", "")).kind, "valid");
	const defaults = load(text.replace("    samplingRate: 10\n", ""));
	assert.ok(
		defaults.kind === "valid" &&
			defaults.config.scorers?.[0]?.samplingRate === 10,
	);

	for (const model of [
		"openai/latest",
		"openai/gpt-6.1-sol-latest",
		"openai/nonexistent",
		"anthropic/claude-opus-4-6",
		"gpt-6.1-sol",
	]) {
		assert.equal(
			load(
				text.replace(
					"grader:\n  model: openai/gpt-6.1-sol",
					`grader:\n  model: ${model}`,
				),
			).kind,
			"invalid",
			model,
		);
		assert.throws(() => scorerDigest(scorer, model), /grader_unpinned/);
	}

	for (const [before, after] of [
		["passingScore: 1", "passingScore: 1.01"],
		["samplingRate: 10", "samplingRate: 101"],
		["matched: 1", "matched: -1"],
		["includeChildren: true", "includeChildren: perhaps"],
		["id: outcome-quality", "id: other"],
	])
		assert.equal(load(text.replace(before!, after!)).kind, "invalid");
	assert.equal(
		load(
			text.replace(
				"grader:\n  model: openai/gpt-6.1-sol\n  maxTokens: 16000\n",
				"",
			),
		).kind,
		"invalid",
	);
});

it("trusted grader.maxTokens defaults to 16000, accepts configured caps, and rejects malformed caps", () => {
	const defaults = load(text.replace("  maxTokens: 16000\n", ""));
	const custom = load(text.replace("  maxTokens: 16000", "  maxTokens: 12000"));
	assert.ok(defaults.kind === "valid");
	assert.equal(defaults.config.grader?.maxTokens, 16000);
	assert.ok(custom.kind === "valid");
	assert.equal(custom.config.grader?.maxTokens, 12000);

	for (const value of ["0", "-1", "1.5", "no", "9007199254740992"]) {
		assert.equal(
			load(text.replace("  maxTokens: 16000", `  maxTokens: ${value}`)).kind,
			"invalid",
		);
	}
});

it("declared labels classify while undeclared labels, duplicate keys and oversized reasoning fail scoring", () => {
	assert.deepEqual(
		scorerAnswer('{"label":"matched","reasoning":"ledger.outcome"}', scorer),
		{ label: "matched", score: 1, reasoning: "ledger.outcome" },
	);
	assert.equal(
		scorerAnswer(
			'{"label":"mismatched","reasoning":"failed hard check"}',
			scorer,
		)?.score,
		0,
	);

	for (const answer of [
		'{"label":"invented","reasoning":"pass"}',
		'{"label":"mismatched","label":"matched","reasoning":"x"}',
		JSON.stringify({ label: "matched", reasoning: "é".repeat(2049) }),
		'{"label":"matched","reasoning":""}',
	])
		assert.equal(scorerAnswer(answer, scorer), null);
});

it("sampling is deterministic, 0 disables, 100 selects all, and 10 percent is a percentage", () => {
	let count = 0;

	for (let i = 0; i < 10_000; i++) {
		const id = digestOf(String(i));
		assert.equal(sampled(id, scorer), sampled(id, { ...scorer }));
		assert.equal(sampled(id, { ...scorer, samplingRate: 0 }), false);
		assert.equal(sampled(id, { ...scorer, samplingRate: 100 }), true);

		if (sampled(id, scorer)) count++;
	}

	assert.ok(count > 850 && count < 1150, String(count));
});

it("fingerprints cover prompt, labels, passing score and pinned grader, not sampling policy", () => {
	const baseline = scorerDigest(scorer, judge);

	for (const changed of [
		{ ...scorer, prompt: "another" },
		{ ...scorer, labels: { ...scorer.labels, matched: 0.9 } },
		{ ...scorer, passingScore: 0.5 },
	])
		assert.notEqual(scorerDigest(changed, judge), baseline);
	assert.notEqual(scorerDigest(scorer, "openai/gpt-6.1-terra"), baseline);
	assert.equal(scorerDigest({ ...scorer, samplingRate: 100 }, judge), baseline);
	assert.equal(
		scorerDigest(
			{
				...scorer,
				labels: Object.fromEntries(Object.entries(scorer.labels).reverse()),
			},
			judge,
		),
		baseline,
	);
	assert.equal(scorerTouched(["src/scorers.ts"]), true);
	assert.equal(scorerTouched([".github/factory/WORKFLOW.md"]), true);
	assert.equal(scorerTouched([".github/factory/scorers/a.md"]), true);
	assert.equal(scorerTouched(["src/tickets.ts"]), false);
});

it("re-scoring retains history and tolerates foreign or forked supersession", () => {
	const first = event();
	const second = { ...event(2, first.id), label: "mismatched", score: 0 };

	const history = parseScores(
		Buffer.from([first, second].map((e) => `${JSON.stringify(e)}\n`).join("")),
	);

	assert.equal(history.length, 2);
	assert.deepEqual(latestScores(history), [second]);
	assert.deepEqual(parseScores(Buffer.from(`${JSON.stringify(second)}\n`)), [
		second,
	]);
	assert.throws(
		() =>
			parseScores(
				Buffer.from(`${JSON.stringify(first)}\n${JSON.stringify(first)}\n`),
			),
		/ledger_corrupt/,
	);
	const root = mkdtempSync(join(tmpdir(), "s12-"));

	try {
		enqueueScore(root, first);
		enqueueScore(root, first);
		enqueueScore(root, second);
		assert.deepEqual(scoreHistory(root), history);
		assert.throws(
			() => enqueueScore(root, { ...first, reasoning: "different" }),
			/score_event_conflict/,
		);
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});

it("the score stream uses publication idempotency, prefix validation and shared-ref fast-forward retry without changing run bytes", async () => {
	const git = new LedgerGit();
	const pub = new GitHubPublicationApi(git.exec, repo, EXE_DEV_PLATFORM);
	const runs = ledgerApiOf(pub);
	const root = await runs.root("2026-11-10T10:00:00Z");
	await runs.advance(null, root.sha);
	const runBytes = Buffer.from("terminal run bytes stay byte-identical\n");

	const child = await runs.child(
		root,
		runBytes,
		"2026-11-10T10:00:00Z",
		"fixture\n",
	);

	await runs.advance(root.sha, child.sha);
	const scores = ledgerApiOf(pub, "scores");
	let moved = false;

	const moving = {
		...scores,
		async advance(from: typeof child.sha | null, next: typeof child.sha) {
			if (!moved && from !== null) {
				moved = true;
				const head = await readLedgerCommit(pub, from);

				const other = await runs.child(
					head,
					runBytes,
					"2026-11-10T10:00:01Z",
					"concurrent run writer\n",
				);

				await runs.advance(from, other.sha);
			}

			return scores.advance(from, next);
		},
	};

	const first = event();
	const bytes = Buffer.from(`${JSON.stringify(first)}\n`);

	const pending = {
		runId: first.id,
		bytes,
		digest: digestOf(bytes),
		date: first.at,
	};

	const appended = await appendRun(
		moving,
		pending,
		null,
		3,
		undefined,
		true,
		indexScores,
	);

	assert.equal(appended.kind, "published");
	assert.equal(moved, true);

	if (appended.kind !== "published") throw new Error("append failed");
	const writes = git.writes.length;

	const again = await appendRun(
		scores,
		pending,
		appended.anchor,
		3,
		undefined,
		true,
		indexScores,
	);

	assert.equal(again.kind, "published");
	assert.equal(
		git.writes.length,
		writes,
		"retry with same event produces no write",
	);
	const tip = git.refs.get("factory/ledger")!;
	assert.ok(isGitSha(tip));
	const head = await readLedgerCommit(pub, tip);
	assert.deepEqual((await readLedgerFile(pub, head.tree)).bytes, runBytes);
	assert.deepEqual(
		parseScores((await readLedgerFile(pub, head.tree, SCORE_FILE)).bytes),
		[first],
	);
	const second = event(2, first.id);
	const nextBytes = Buffer.from(`${JSON.stringify(second)}\n`);

	const next = await appendRun(
		scores,
		{
			runId: second.id,
			bytes: nextBytes,
			digest: digestOf(nextBytes),
			date: second.at,
		},
		appended.anchor,
		3,
		undefined,
		true,
		indexScores,
	);

	assert.equal(next.kind, "published");

	const broken = await scores.child(
		await scores.commit((await scores.ref())!),
		nextBytes,
		"2026-11-10T10:00:03Z",
		"invalid rewrite\n",
	);

	await scores.advance(await scores.ref(), broken.sha);
	assert.equal(
		(
			await appendRun(
				scores,
				pending,
				appended.anchor,
				3,
				undefined,
				true,
				indexScores,
			)
		).kind,
		"blocked",
	);
	assert.equal(LEDGER_FILE, "ledger/runs.jsonl");
});

it("failed or voided score events can never carry a numeric grade or passing label", () => {
	const base = event();

	for (const status of ["failed", "voided"] as const) {
		const invalid = {
			...base,
			status,
			voided: status === "voided" ? "scorer_touched" : null,
		};

		assert.equal(scoreEventOf(invalid), null);
		assert.equal(scoreEventOf({ ...invalid, label: null }), null);
		assert.equal(scoreEventOf({ ...invalid, score: null }), null);
		assert.ok(scoreEventOf({ ...invalid, label: null, score: null }));
	}
});

it("two state directories scoring the same run concurrently cannot collide or brick forked history", async () => {
	const a = mkdtempSync(join(tmpdir(), "s12a-"));
	const b = mkdtempSync(join(tmpdir(), "s12b-"));

	try {
		const left = allocateMeasurement(a, "score", runId);
		const right = allocateMeasurement(b, "score", runId);

		const first = {
			...event(),
			id: left.eventId ?? left.executionId,
			at: "2026-11-10T10:00:02Z",
		};

		const second = {
			...event(),
			id: right.eventId ?? right.executionId,
			at: "2026-11-10T10:00:00Z",
			reasoning: "another judge",
		};

		assert.notEqual(first.id, second.id);

		const git = new LedgerGit();

		const api = ledgerApiOf(
			new GitHubPublicationApi(git.exec, repo, EXE_DEV_PLATFORM),
		);

		await api.advance(null, (await api.root(first.at)).sha);
		enqueueScore(a, first);
		enqueueScore(b, second);
		assert.equal(
			await pumpScoreOutbox({
				platform: EXE_DEV_PLATFORM,
				stateDir: a,
				repo,
				exec: git.exec,
				log: () => {},
			}),
			true,
		);
		assert.equal(
			await pumpScoreOutbox({
				platform: EXE_DEV_PLATFORM,
				stateDir: b,
				repo,
				exec: git.exec,
				log: () => {},
			}),
			true,
		);

		const scores = ledgerApiOf(
			new GitHubPublicationApi(git.exec, repo, EXE_DEV_PLATFORM),
			"scores",
		);

		const remote = parseScores(
			(await scores.file((await scores.commit((await scores.ref())!)).tree))
				.bytes,
		);

		assert.deepEqual(remote, [first, second]);
		enqueueScore(a, second);
		enqueueScore(a, event(3, digestOf("foreign missing predecessor")));
		assert.equal(scoreHistory(a).length, 3);
		assert.equal(
			await pumpScoreOutbox({
				platform: EXE_DEV_PLATFORM,
				stateDir: a,
				repo,
				exec: git.exec,
				log: () => {},
			}),
			true,
		);
		assert.deepEqual(
			scoreHistory(a).slice(0, 2),
			remote,
			"public stream order wins over timestamps and fork links",
		);
	} finally {
		rmSync(a, { recursive: true, force: true });
		rmSync(b, { recursive: true, force: true });
	}
});

it("score reasoning cannot carry terminal controls through the answer or ledger codec", () => {
	const reasoning = "safe\u001b]8;;hostile\u0007 text\u007f\n\tend";

	const answer = scorerAnswer(
		JSON.stringify({ label: "matched", reasoning }),
		scorer,
	);

	assert.ok(answer);
	assert.equal(answer.reasoning, "safe]8;;hostile text\n\tend");
	assert.equal(scoreEventOf({ ...event(), reasoning }), null);
	assert.ok(scoreEventOf({ ...event(), reasoning: answer.reasoning }));
});

it("score publication is serialized and score faults do not masquerade as run-ledger faults", async () => {
	const dir = mkdtempSync(join(tmpdir(), "s12-"));

	try {
		const git = new LedgerGit();

		const api = ledgerApiOf(
			new GitHubPublicationApi(git.exec, repo, EXE_DEV_PLATFORM),
		);

		await api.advance(null, (await api.root(event().at)).sha);
		enqueueScore(dir, event());

		const logs: string[] = [];

		const input = {
			platform: EXE_DEV_PLATFORM,
			stateDir: dir,
			repo,
			exec: git.exec,
			log: (name: string) => {
				logs.push(name);
			},
		};

		assert.deepEqual(
			await Promise.all([pumpScoreOutbox(input), pumpScoreOutbox(input)]),
			[true, true],
		);
		assert.equal(logs.length, 0);
		writeFileSync(join(dir, "measure/score-outbox/anchor.json"), "{}", {
			mode: 0o600,
		});
		assert.equal(await pumpScoreOutbox(input), null);
		assert.deepEqual(logs, ["score_pump_failed"]);
		assert.ok(await pumpLedgerOutbox({ ...input, now: Date.now() }));
		assert.equal(logs.includes("ledger_pump_failed"), false);
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});

it("a run append with its existing anchor still works after score commits", async () => {
	const rows = parseLedger(
		readFileSync(
			new URL("fixtures/metrics/runs-2026-11-08.jsonl", import.meta.url),
		),
	).filter((line) => line.kind === "known");

	const git = new LedgerGit();
	const pub = new GitHubPublicationApi(git.exec, repo, EXE_DEV_PLATFORM);
	const runs = ledgerApiOf(pub);
	const first = rows[0]!;
	const next = rows[1]!;

	const row = (line: typeof first) => ({
		runId: line.row.runId,
		bytes: line.bytes,
		digest: line.digest,
		date: "2026-11-10T10:00:00Z",
	});

	const before = await appendRun(runs, row(first), null);
	assert.ok(before.kind === "published");

	const score = event();
	const bytes = Buffer.from(`${JSON.stringify(score)}\n`);

	assert.equal(
		(
			await appendRun(
				ledgerApiOf(pub, "scores"),
				{ runId: score.id, bytes, digest: digestOf(bytes), date: score.at },
				null,
				3,
				undefined,
				false,
				indexScores,
			)
		).kind,
		"published",
	);
	assert.equal(
		(await appendRun(runs, row(next), before.anchor)).kind,
		"published",
	);

	const tip = await readLedgerCommit(pub, (await runs.ref())!);
	assert.deepEqual(
		(await readLedgerFile(pub, tip.tree)).bytes,
		Buffer.concat([first.bytes, next.bytes]),
	);
	assert.deepEqual(
		parseScores((await readLedgerFile(pub, tip.tree, SCORE_FILE)).bytes),
		[score],
	);
});

it("first score publication reuses proven run ancestry and reads the score tip instead of walking old commits", async () => {
	const dir = mkdtempSync(join(tmpdir(), "s12-"));

	try {
		const git = new LedgerGit();
		const pub = new GitHubPublicationApi(git.exec, repo, EXE_DEV_PLATFORM);
		const runs = ledgerApiOf(pub);

		const fixture = parseLedger(
			readFileSync(
				new URL("fixtures/metrics/runs-2026-11-08.jsonl", import.meta.url),
			),
		).find((line) => line.kind === "known");

		assert.ok(fixture?.kind === "known");
		let anchor = null;

		for (let seq = 0; seq < 45; seq++) {
			const facts = { ...fixture.row, eventId: String(9000 + seq) };
			const row = ledgerRowOf({ ...facts, runId: runIdOf(facts) });

			const result = await appendRun(
				runs,
				{
					runId: row.row.runId,
					bytes: row.bytes,
					digest: row.digest,
					date: event().at,
				},
				anchor,
			);

			assert.ok(result.kind === "published");
			anchor = result.anchor;
		}

		mkdirSync(join(dir, "ledger"), { mode: 0o700 });
		writeFileSync(join(dir, "ledger/anchor.json"), JSON.stringify(anchor), {
			mode: 0o600,
		});

		const before = (
			await runs.file((await runs.commit((await runs.ref())!)).tree)
		).bytes;

		git.requests.length = 0;
		enqueueScore(dir, event());
		assert.equal(
			await pumpScoreOutbox({
				platform: EXE_DEV_PLATFORM,
				stateDir: dir,
				repo,
				exec: git.exec,
				log: () => undefined,
			}),
			true,
		);

		const commits = git.requests.filter((request) =>
			request.startsWith("GET git/commits/"),
		);

		assert.ok(
			commits.length <= 4,
			`${commits.length} commit reads for 45 terminal rows`,
		);
		assert.deepEqual(
			(await runs.file((await runs.commit((await runs.ref())!)).tree)).bytes,
			before,
		);
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});

it("score publication has its own five-second transport slice", async () => {
	const dir = mkdtempSync(join(tmpdir(), "s12-"));

	try {
		const git = new LedgerGit();

		const api = ledgerApiOf(
			new GitHubPublicationApi(git.exec, repo, EXE_DEV_PLATFORM),
		);

		await api.advance(null, (await api.root(event().at)).sha);
		enqueueScore(dir, event());
		let elapsed = 0;
		let calls = 0;

		const result = await pumpScoreOutbox({
			platform: EXE_DEV_PLATFORM,
			stateDir: dir,
			repo,
			log: () => {},
			clock: () => elapsed,
			exec: async (command, args, options) => {
				assert.ok(
					elapsed < 5000,
					"no GitHub request begins outside the score slice",
				);
				assert.ok(
					options?.timeoutMs !== undefined &&
						options.timeoutMs <= 5000 - elapsed,
				);
				calls++;
				elapsed += Math.min(1000, options.timeoutMs);

				return git.exec(command, args, options);
			},
		});

		assert.equal(result, false);
		assert.equal(elapsed, 5000);
		assert.equal(calls, 5);
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});

it("score publication never creates the run-owned ledger root", async () => {
	const dir = mkdtempSync(join(tmpdir(), "s12-"));

	try {
		const git = new LedgerGit();
		enqueueScore(dir, event());
		assert.equal(
			await pumpScoreOutbox({
				platform: EXE_DEV_PLATFORM,
				stateDir: dir,
				repo,
				exec: git.exec,
				log: () => {},
			}),
			false,
		);
		assert.equal(git.writes.length, 0);
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});

it("legacy automatic enrollment does not consume a held or zero-launch score, but retains possible interrupted work", () => {
	const dir = mkdtempSync(join(tmpdir(), "s12-"));

	try {
		mkdirSync(join(dir, "measure/automatic"), { recursive: true, mode: 0o700 });
		const marker = join(dir, "measure/automatic", `${runId}-${scorer.id}.json`);
		writeFileSync(marker, JSON.stringify({ runId, scorerId: scorer.id }), {
			mode: 0o600,
		});
		assert.equal(automaticScoreEnrolled(dir, runId, scorer.id), false);
		const execution = allocateMeasurement(dir, "score", runId);
		writeFileSync(
			join(execution.dir, "owner.json"),
			JSON.stringify({ scorer }),
			{ mode: 0o600 },
		);
		assert.equal(
			automaticScoreEnrolled(dir, runId, scorer.id),
			true,
			"an interrupted attempt is never assumed to be zero-work",
		);
		writeFileSync(
			join(execution.dir, "result.json"),
			JSON.stringify({ launched: false }),
			{ mode: 0o600 },
		);
		assert.equal(automaticScoreEnrolled(dir, runId, scorer.id), false);
		writeFileSync(
			join(execution.dir, "result.json"),
			JSON.stringify({ launched: true }),
			{ mode: 0o600 },
		);
		assert.equal(automaticScoreEnrolled(dir, runId, scorer.id), true);
		assert.equal(automaticScoreEnrolled(dir, runId, "another-scorer"), false);
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});

it("scorer perf counts re-scores without double-counting target tokens and preserves unavailable", () => {
	const first = event();
	const second = event(2, first.id);
	assert.deepEqual(
		scorerTokenShare([first, second], new Map([[runId, 1000]])),
		{ scorerTokens: 20, scoredTokens: 1000, share: 0.02, withinBudget: true },
	);
	assert.equal(scorerTokenShare([first], new Map()).share, null);
	assert.equal(
		scorerTokenShare([first], new Map([[runId, 50]])).withinBudget,
		false,
	);
});
