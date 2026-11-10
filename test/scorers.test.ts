import assert from "node:assert/strict";
import { readFileSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { it } from "node:test";
import { parseWorkflow, isGitSha } from "../src/workflow.ts";
import { digestOf } from "../src/run.ts";
import {
	sampled,
	scorerDigest,
	scorerAnswer,
	scorerTouched,
	scorerTokenShare,
	FAMILY_NOTE,
	enqueueScore,
	scoreHistory,
} from "../src/scorers.ts";
import {
	latestScores,
	parseScores,
	ledgerApiOf,
	appendRun,
	indexScores,
	scoreEventOf,
	type ScoreEvent,
} from "../src/ledger.ts";
import {
	GitHubPublicationApi,
	readLedgerFile,
	readLedgerCommit,
	LEDGER_FILE,
	SCORE_FILE,
} from "../src/publication.ts";
import { LedgerGit, repo } from "./ledger-git.ts";

const text = readFileSync(
	new URL("../.github/factory/WORKFLOW.md", import.meta.url),
	"utf8",
);

const load = (source = text) =>
	parseWorkflow({ text: source, repo, env: (name) => process.env[name] });

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
		load(text.replace("grader:\n  model: openai/gpt-6.1-sol\n", "")).kind,
		"invalid",
	);
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

it("re-scoring supersedes only the projection, retaining both events; invalid chains refuse", () => {
	const first = event();
	const second = { ...event(2, first.id), label: "mismatched", score: 0 };

	const history = parseScores(
		Buffer.from([first, second].map((e) => `${JSON.stringify(e)}\n`).join("")),
	);

	assert.equal(history.length, 2);
	assert.deepEqual(latestScores(history), [second]);
	assert.throws(
		() => parseScores(Buffer.from(`${JSON.stringify(second)}\n`)),
		/score_supersession/,
	);
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
	const pub = new GitHubPublicationApi(git.exec, repo);
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
