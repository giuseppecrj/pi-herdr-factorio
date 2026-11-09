import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import * as replay from "../src/replay.ts";
import {
	mkdir,
	mkdtemp,
	readFile,
	rm,
	unlink,
	writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import { EXIT, runCli } from "../server/cli.ts";
import { acquireLock, procTable } from "../server/controller.ts";
import { parseLedger, type LedgerRow } from "../src/ledger.ts";
import {
	checkReplay,
	loadReplayCorpus,
	replayReport,
	reserveReplay,
	settleReplay,
	readReplayBudget,
	REPLAY_RUN_CAP,
} from "../src/replay.ts";
import { digestOf } from "../src/run.ts";
import {
	isGitSha,
	isRepoSlug,
	parseWorkflow,
	type Exec,
} from "../src/workflow.ts";

const corpusDir = new URL("./fixtures/replay/", import.meta.url).pathname;
const repo = "giuseppecrj/pi-herdr-factorio";

const syntheticWorkflow = `const BRANCH_NAME = /^[A-Za-z0-9._/-]+$/;

export function isBranchName(input: string): boolean {
	return BRANCH_NAME.test(input);
}

export function parseWorkflow(input: string): string {
	return input.trim();
}
`;

function pinnedSha(text: string) {
	if (!isGitSha(text)) throw new Error("sha");

	return text;
}

const sha = pinnedSha("a".repeat(40));
const otherSha = pinnedSha("b".repeat(40));
const digest = digestOf("assets");
const exec: Exec = async () => ({ code: 0, stdout: "", stderr: "" });

const workflow = (text: string) => {
	assert.ok(isRepoSlug(repo));

	return parseWorkflow({ text, repo, env: () => "/tmp" });
};

async function fixtureRow(): Promise<LedgerRow> {
	const lines = parseLedger(
		await readFile(
			new URL("./fixtures/metrics/runs-2026-11-08.jsonl", import.meta.url),
		),
	);

	const line = lines[0];
	assert.ok(line?.kind === "known");

	return line.row;
}

async function side(which: "prev" | "cand" = "prev") {
	const row = await fixtureRow();
	assert.equal(row.provenance.kind, "verification");

	return {
		headSha: sha,
		record: {
			v: 1,
			caseId: "c3",
			corpusDigest: digestOf("frozen corpus"),
			issueDigest: digestOf("frozen issue"),
			side: which,
			issue: which === "prev" ? 900 : 901,
			headSha: sha,
			mainSha: row.provenance.policy.workflowSha,
			terminalMainSha: row.provenance.policy.workflowSha,
			runId: which === "prev" ? row.runId : digestOf("candidate run"),
			stageCaps: {
				accept: 100000,
				build: 400000,
				review: 120000,
				repair: 300000,
			},
		},
		row: {
			...row,
			issue: which === "prev" ? 900 : 901,
			runId: which === "prev" ? row.runId : digestOf("candidate run"),
			originalBase: sha,
			models: {
				kind: "known",
				value: [
					{
						requested: "openai/gpt-6.1-sol",
						observed: { kind: "known", value: "gpt-6.1-sol" },
						providerVersion: {
							kind: "unavailable",
							reason: "provider_not_reported",
						},
						runtime: {
							kind: "known",
							value: {
								pi: "1.4.0",
								agents: "0.9.5",
								pstack: "0.4.0",
								assetsDigest: digest,
							},
						},
						executions: 1,
					},
				],
			},
		} satisfies LedgerRow,
	};
}

async function cli(args: string[], execute: Exec = exec) {
	let stdout = "";
	let stderr = "";

	const code = await runCli(args, {
		exec: execute,
		env: (name) => (name === "HOME" ? tmpdir() : undefined),
		stdout: (s) => {
			stdout += s;
		},
		stderr: (s) => {
			stderr += s;
		},
	});

	return { code, stdout, stderr };
}

describe("replay corpus and read-only check", () => {
	it("pins five sanitized past tickets, four live and one offline, never 625", async () => {
		const corpus = await loadReplayCorpus(corpusDir);
		assert.equal(corpus.cases.length, 5);
		assert.deepEqual(
			corpus.cases.map((c) => c.sourceIssues[0]),
			[658, 650, 597, 605, 645],
		);
		assert.deepEqual(
			corpus.cases.map((c) => c.liveReplayable),
			[true, true, true, true, false],
		);

		for (const c of corpus.cases) {
			const issue = await readFile(
				join(corpusDir, "cases", c.id, "issue.md"),
				"utf8",
			);

			assert.equal(digestOf(issue), c.issueDigest);
			assert.doesNotMatch(issue, /#\d+|@[\w-]+|https?:\/\/github\.com/i);
		}
	});

	it("refuses manifest and issue digest mismatches", async () => {
		const { cp } = await import("node:fs/promises");
		const dir = await mkdtemp(join(tmpdir(), "replay-corpus-"));

		try {
			await cp(corpusDir, dir, { recursive: true });
			await writeFile(join(dir, "cases/c1/issue.md"), "tampered");
			await assert.rejects(loadReplayCorpus(dir), /issue_digest_mismatch/);
			await cp(corpusDir, dir, { recursive: true });
			const text = await readFile(join(dir, "corpus.json"), "utf8");
			await writeFile(
				join(dir, "corpus.json"),
				text.replace("handoff", "needs_info"),
			);
			await assert.rejects(loadReplayCorpus(dir), /corpus_digest_mismatch/);
		} finally {
			await rm(dir, { recursive: true, force: true });
		}
	});

	it("marks changed guarded paths stale and refuses offline live replay", async () => {
		const corpus = await loadReplayCorpus(corpusDir);
		const calls: string[][] = [];

		const result = await checkReplay({
			corpus,
			mainSha: sha,
			previousSha: sha,
			candidateSha: otherSha,
			exec: async (command, args) => {
				calls.push([command, ...args]);

				return {
					code: 0,
					stdout:
						args[0] === "show"
							? `const BRANCH_NAME = /ok/;\nexport function isBranchName(input: string): boolean {\nreturn ${args[1]?.startsWith(sha) ? "false" : "true"};\n}`
							: "",
					stderr: "",
				};
			},
		});

		assert.equal(result.cases[0]?.status, "stale");
		assert.equal(result.cases[1]?.status, "ready");
		assert.equal(result.cases[4]?.status, "offline_only");
		assert.ok(calls.every((c) => c[0] === "git"));
		assert.ok(
			calls.some(
				(c) =>
					c.includes("show") &&
					c.some((arg) => arg.endsWith(":src/workflow.ts")),
			),
		);
	});

	it("fails closed on unavailable git evidence, and reports bundle switches", async () => {
		const corpus = await loadReplayCorpus(corpusDir);

		const result = await checkReplay({
			corpus,
			mainSha: sha,
			previousSha: sha,
			candidateSha: otherSha,
			exec: async (_command, args) => ({
				code: 0,
				stdout: args.includes("skills") ? "skills/build/SKILL.md\n" : "",
				stderr: "",
			}),
		});

		assert.equal(result.bundle, "bundle_switch_required");

		const failed = await checkReplay({
			corpus,
			mainSha: sha,
			previousSha: sha,
			candidateSha: otherSha,
			exec: async () => ({ code: 128, stdout: "", stderr: "missing object" }),
		});

		assert.equal(failed.cases[0]?.status, "unavailable");
	});

	it("CLI checks the local corpus without GitHub or model calls", async () => {
		const calls: string[] = [];

		const result = await cli(
			[
				"replay",
				"check",
				"--json",
				"--corpus",
				corpusDir,
				"--main-sha",
				sha,
				"--previous-sha",
				sha,
				"--candidate-sha",
				otherSha,
			],
			async (cmd, args) => {
				calls.push(cmd);

				return {
					code: 0,
					stdout: args[0] === "show" ? syntheticWorkflow : "",
					stderr: "",
				};
			},
		);

		assert.equal(result.code, EXIT.ok, result.stderr);
		assert.ok(result.stdout.includes('"offline_only"'));
		assert.ok(calls.every((cmd) => cmd === "git"));
	});
});

describe("replay CLI boundaries", () => {
	it("refuses offline and exhausted live requests through the public command", async () => {
		const dir = await mkdtemp(join(tmpdir(), "replay-live-check-"));
		const path = join(dir, "budget.json");
		const text = `---\nrepository: ${repo}\nreplay:\n  max_tokens: 1100000\n---\n`;

		const execute: Exec = async (_cmd, args) => ({
			code: 0,
			stdout: args[1]?.endsWith(":src/workflow.ts")
				? syntheticWorkflow
				: args[0] === "show"
					? text
					: "",
			stderr: "",
		});

		const args = [
			"replay",
			"check",
			"--json",
			"--corpus",
			corpusDir,
			"--main-sha",
			sha,
			"--previous-sha",
			sha,
			"--candidate-sha",
			otherSha,
			"--production-state-dir",
			dir,
			"--budget-file",
			path,
		];

		try {
			const offline = await cli([...args, "--case", "c5"], execute);
			assert.equal(offline.code, EXIT.invalid);
			assert.match(offline.stdout, /offline_only/);
			const ready = await cli([...args, "--case", "c3"], execute);
			assert.equal(ready.code, EXIT.ok, ready.stdout);
			assert.match(ready.stdout, /"allowed": true/);
			await reserveReplay(path, 1100000, "first");
			await reserveReplay(path, 1100000, "second");
			const exhausted = await cli([...args, "--case", "c3"], execute);
			assert.equal(exhausted.code, EXIT.invalid);
			assert.match(exhausted.stdout, /replay_cap/);
		} finally {
			await rm(dir, { recursive: true, force: true });
		}
	});

	it("reports frozen verification rows with no subprocess, and rejects production or corrupt rows", async () => {
		const dir = await mkdtemp(join(tmpdir(), "replay-cli-report-"));
		const path = join(dir, "row.json");
		const row = await fixtureRow();

		const noExec: Exec = async () => {
			throw new Error("no subprocess permitted");
		};

		const args = [
			"replay",
			"report",
			"--json",
			"--case",
			"c3",
			"--corpus",
			corpusDir,
			"--previous-sha",
			sha,
			"--candidate-sha",
			otherSha,
			"--previous-row",
			path,
			"--candidate-row",
			path,
			"--previous-record",
			join(dir, "prev.json"),
			"--candidate-record",
			join(dir, "cand.json"),
		];

		try {
			await writeFile(path, `${JSON.stringify(row)}\n`);
			await writeFile(
				join(dir, "prev.json"),
				JSON.stringify((await side()).record),
			);
			await writeFile(
				join(dir, "cand.json"),
				JSON.stringify((await side("cand")).record),
			);
			const result = await cli(args, noExec);
			assert.equal(result.code, EXIT.ok, result.stdout);
			assert.match(result.stdout, /"matchesExpected": "yes"/);
			assert.match(result.stdout, /"promotes": false/);
			assert.match(result.stdout, /"comparability": "incomparable"/);
			assert.match(result.stdout, /same_run/);
			assert.ok(row.provenance.kind === "verification");
			await writeFile(
				path,
				`${JSON.stringify({
					...row,
					provenance: { kind: "production", policy: row.provenance.policy },
				})}\n`,
			);
			const production = await cli(args, noExec);
			assert.equal(production.code, EXIT.invalid);
			assert.match(production.stdout, /replay_not_verification/);
			await writeFile(path, "{}");
			assert.equal((await cli(args, noExec)).code, EXIT.invalid);
		} finally {
			await rm(dir, { recursive: true, force: true });
		}
	});
});

describe("replay comparison", () => {
	it("refuses non-verification rows", async () => {
		const a = await side();
		assert.ok(a.row.provenance.kind === "verification");

		const production = {
			...a,
			row: {
				...a.row,
				provenance: { kind: "production", policy: a.row.provenance.policy },
			} satisfies LedgerRow,
		};

		assert.throws(
			() =>
				replayReport({
					previous: production,
					candidate: a,
					expected: "needs_info",
				}),
			/not_verification/,
		);
	});

	it("compares identical pins and reports stages, versions, limitations and unavailable spend", async () => {
		const a = await side();

		const result = replayReport({
			previous: a,
			candidate: {
				...(await side("cand")),
				headSha: otherSha,
				record: { ...(await side("cand")).record, headSha: otherSha },
			},
			expected: "needs_info",
		});

		assert.equal(result.comparability, "comparable");
		assert.equal(result.previous.matchesExpected, "yes");
		assert.equal(result.previous.spend.kind, "unavailable");
		assert.equal(result.candidate.headSha, otherSha);
		assert.deepEqual(result.previous.stages, a.row.stages);
		assert.ok(result.limitations.some((s) => s.includes("same-family")));
		assert.equal(result.promotes, false);
	});

	it("makes different bases, policies and unexpected assets incomparable; missing provenance is not equal evidence", async () => {
		const a = await side();

		const changes: LedgerRow[] = [
			{ ...a.row, originalBase: otherSha },
			{ ...a.row, models: { kind: "unavailable", reason: "receipt_missing" } },
		];

		assert.ok(a.row.provenance.kind === "verification");

		for (const policy of [
			{ ...a.row.provenance.policy, workflowDigest: digestOf("other") },
			{
				...a.row.provenance.policy,
				gates: {
					kind: "known",
					value: { sourceSha: sha, digest: digestOf("other gates") },
				},
			},
			{
				...a.row.provenance.policy,
				gates: { kind: "unavailable", reason: "receipt_missing" },
			},
		] satisfies (typeof a.row.provenance.policy)[])
			changes.push({
				...a.row,
				provenance: { ...a.row.provenance, policy },
			});
		assert.ok(a.row.models.kind === "known");
		const model = a.row.models.value[0];
		assert.ok(model?.runtime.kind === "known");
		changes.push({
			...a.row,
			models: {
				kind: "known",
				value: [
					{
						...model,
						runtime: {
							kind: "known",
							value: {
								...model.runtime.value,
								assetsDigest: digestOf("different"),
							},
						},
					},
				],
			},
		});

		for (const row of changes)
			assert.equal(
				replayReport({
					previous: a,
					candidate: { ...a, row },
					expected: "handoff",
				}).comparability,
				"incomparable",
			);
	});

	it("does not mistake a cancelled candidate or a landing for proven handoff", async () => {
		const a = await side();

		const row: LedgerRow = {
			...a.row,
			outcome: {
				kind: "cancelled",
				stage: "land",
				reason: { kind: "known", value: "closed" },
			},
		};

		assert.equal(
			replayReport({
				previous: { ...a, row },
				candidate: { ...a, row },
				expected: "handoff",
			}).previous.matchesExpected,
			"unknown",
		);
	});
});

describe("review regressions: comparison identity and caps", () => {
	it("binds each row to its durable fixture, case, corpus and side; never pairs a run with itself", async () => {
		const previous = await side();
		const candidate = await side("cand");

		for (const changed of [
			{ ...candidate, record: { ...candidate.record, caseId: "c2" } },
			{
				...candidate,
				record: { ...candidate.record, corpusDigest: digestOf("new corpus") },
			},
			{
				...candidate,
				record: { ...candidate.record, issueDigest: digestOf("other issue") },
			},
			{ ...candidate, row: { ...candidate.row, issue: 902 } },
			{ ...candidate, record: { ...candidate.record, side: "prev" } },
			previous,
		]) {
			assert.equal(
				replayReport({ previous, candidate: changed, expected: "needs_info" })
					.comparability,
				"incomparable",
				JSON.stringify(changed.record),
			);
		}

		const result = replayReport({
			previous,
			candidate,
			expected: "needs_info",
		});

		assert.equal(result.previous.corpusDigest, previous.record.corpusDigest);
		assert.equal(result.candidate.corpusDigest, candidate.record.corpusDigest);
	});

	for (const field of ["requested", "observed"] as const)
		it(`rejects different ${field} models from receipts`, async () => {
			const previous = await side();
			const candidate = await side("cand");
			assert.ok(candidate.row.models.kind === "known");
			const model = candidate.row.models.value[0];
			assert.ok(model);
			candidate.row.models = {
				kind: "known",
				value: [
					{
						...model,
						[field]:
							field === "observed"
								? { kind: "known", value: "fallback" }
								: "openai/fallback",
					},
				],
			};
			assert.ok(
				replayReport({
					previous,
					candidate,
					expected: "needs_info",
				}).reasons.includes("model_mismatch"),
			);
		});

	for (const field of ["trustedRunTokenCap", "effectiveRunTokenCap"] as const)
		it(`rejects different ${field}`, async () => {
			const previous = await side();
			const candidate = await side("cand");
			assert.ok(candidate.row.provenance.kind === "verification");
			candidate.row.provenance = {
				...candidate.row.provenance,
				[field]: 539999,
			};
			assert.ok(
				replayReport({
					previous,
					candidate,
					expected: "needs_info",
				}).reasons.includes("run_cap_mismatch"),
			);
		});

	it("rejects different stage caps and any main movement, even identical terminal observations", async () => {
		const previous = await side();
		const candidate = await side("cand");
		assert.ok(
			replayReport({
				previous,
				candidate: {
					...candidate,
					record: {
						...candidate.record,
						stageCaps: { ...candidate.record.stageCaps, build: 200000 },
					},
				},
				expected: "needs_info",
			}).reasons.includes("stage_cap_mismatch"),
		);
		assert.ok(
			replayReport({
				previous,
				candidate: {
					...candidate,
					record: { ...candidate.record, terminalMainSha: otherSha },
				},
				expected: "needs_info",
			}).reasons.includes("main_moved"),
		);
		const row = previous.row;

		const observation: Extract<
			LedgerRow,
			{ v: 4 }
		>["terminalWorkflowObservation"] = {
			kind: "known",
			value: { workflowSha: otherSha, workflowDigest: digestOf("moved") },
		};

		const moved = { ...row, terminalWorkflowObservation: observation };

		assert.ok(
			replayReport({
				previous: { ...previous, row: moved },
				candidate,
				expected: "needs_info",
			}).reasons.includes("main_moved"),
		);
	});

	it("refuses distinct runs on the same fixture issue", async () => {
		const previous = await side();
		const candidate = await side("cand");
		candidate.row.issue = previous.row.issue;
		candidate.record.issue = previous.record.issue;

		const result = replayReport({
			previous,
			candidate,
			expected: "needs_info",
		});

		assert.equal(result.comparability, "incomparable");
		assert.ok(result.reasons.includes("same_fixture_issue"));
	});

	it("c1 stays ready for parser edits but a real isBranchName change is stale", async () => {
		const corpus = await loadReplayCorpus(corpusDir);

		const c1 = corpus.cases[0];
		assert.ok(c1);
		assert.equal(c1.guardPattern, "BRANCH_NAME|isBranchName");

		const dir = await mkdtemp(join(tmpdir(), "replay-symbol-"));

		const git = (...args: string[]) =>
			execFileSync("git", ["-C", dir, ...args], { encoding: "utf8" }).trim();

		try {
			await mkdir(join(dir, "src"));

			const source = syntheticWorkflow;

			await writeFile(join(dir, "src/workflow.ts"), source);
			git("init", "-q");
			git("add", ".");
			git(
				"-c",
				"user.name=Fixture",
				"-c",
				"user.email=fixture@example.invalid",
				"-c",
				"core.hooksPath=/dev/null",
				"commit",
				"-qm",
				"symbol baseline",
			);
			const base = git("rev-parse", "HEAD");

			const parserEdit = source.replace(
				"return input.trim();",
				"return input.trimStart();",
			);

			assert.notEqual(parserEdit, source);
			await writeFile(
				join(dir, "src/workflow.ts"),
				`${parserEdit}\n// unrelated parser edit mentioning BRANCH_NAME and isBranchName\n`,
			);
			git("add", ".");
			git(
				"-c",
				"user.name=Fixture",
				"-c",
				"user.email=fixture@example.invalid",
				"-c",
				"core.hooksPath=/dev/null",
				"commit",
				"-qm",
				"unrelated parser change",
			);

			const execute: Exec = async (_cmd, args) => ({
				code: 0,
				stdout: git(...args),
				stderr: "",
			});

			assert.equal(
				(
					await checkReplay({
						corpus: { ...corpus, cases: [{ ...c1, baseSha: base }] },
						mainSha: git("rev-parse", "HEAD"),
						previousSha: base,
						candidateSha: base,
						exec: execute,
					})
				).cases[0]?.status,
				"ready",
			);

			const branchEdit = source.replace(
				"return BRANCH_NAME.test(input);",
				"if (input.endsWith('.lock')) return false;\n\treturn BRANCH_NAME.test(input);",
			);

			assert.notEqual(branchEdit, source);
			await writeFile(join(dir, "src/workflow.ts"), branchEdit);
			git("add", ".");
			git(
				"-c",
				"user.name=Fixture",
				"-c",
				"user.email=fixture@example.invalid",
				"-c",
				"core.hooksPath=/dev/null",
				"commit",
				"-qm",
				"real symbol change",
			);

			const changed = await checkReplay({
				corpus: { ...corpus, cases: [{ ...c1, baseSha: base }] },
				mainSha: git("rev-parse", "HEAD"),
				previousSha: base,
				candidateSha: base,
				exec: async (_cmd, args) => ({
					code: 0,
					stdout: git(...args),
					stderr: "",
				}),
			});

			assert.equal(changed.cases[0]?.status, "stale");

			for (const [text, status] of [
				[
					source.replace(
						"const BRANCH_NAME = /",
						"const BRANCH_NAME = /(?=.{1,100}$)",
					),
					"stale",
				],
				[
					source.replace(
						"export function isBranchName",
						"export function renamedBranchName",
					),
					"unavailable",
				],
			] as const) {
				await writeFile(join(dir, "src/workflow.ts"), text);
				git("add", ".");
				git(
					"-c",
					"user.name=Fixture",
					"-c",
					"user.email=fixture@example.invalid",
					"-c",
					"core.hooksPath=/dev/null",
					"commit",
					"-qm",
					"guarded declaration change",
				);

				const result = await checkReplay({
					corpus: { ...corpus, cases: [{ ...c1, baseSha: base }] },
					mainSha: git("rev-parse", "HEAD"),
					previousSha: base,
					candidateSha: base,
					exec: execute,
				});

				assert.equal(result.cases[0]?.status, status);
			}
		} finally {
			await rm(dir, { recursive: true, force: true });
		}
	});

	it("bundle inputs include the recipe, not dead paths or the echo fixture", async () => {
		const corpus = await loadReplayCorpus(corpusDir);
		let paths: readonly string[] = [];

		const result = await checkReplay({
			corpus,
			mainSha: sha,
			previousSha: sha,
			candidateSha: otherSha,
			exec: async (_cmd, args) => {
				if (args.includes("skills")) paths = args.slice(args.indexOf("--") + 1);

				return {
					code: 0,
					stdout: args.includes("server/provision.sh")
						? "server/provision.sh\n"
						: "",
					stderr: "",
				};
			},
		});

		assert.deepEqual(paths, [
			"skills",
			"server/sandbox/assets",
			"server/provision.sh",
		]);
		assert.equal(result.bundle, "bundle_switch_required");
	});

	it("voids only proven zero-execution, zero-usage reservations, recording the reason", async () => {
		const dir = await mkdtemp(join(tmpdir(), "replay-void-"));
		const path = join(dir, "budget.json");

		try {
			await reserveReplay(path, 1100000, "empty");
			await replay
				.voidReplay(
					path,
					"empty",
					{ stages: 1, tokens: 0, complete: true },
					"stage_was_started",
				)
				.then(
					() => assert.fail("stage must retain charge"),
					() => {},
				);
			await replay
				.voidReplay(
					path,
					"empty",
					{ stages: 0, tokens: 1, complete: true },
					"usage",
				)
				.then(
					() => assert.fail("usage must retain charge"),
					() => {},
				);
			await replay
				.voidReplay(
					path,
					"empty",
					{ stages: 0, tokens: 0, complete: false },
					"uncertain",
				)
				.then(
					() => assert.fail("uncertainty must retain charge"),
					() => {},
				);
			await replay.voidReplay(
				path,
				"empty",
				{ stages: 0, tokens: 0, complete: true },
				"no_stage_executed",
			);
			const budget = await readReplayBudget(path);
			assert.equal(budget.chargedTokens, 0);
			assert.equal(budget.reservations[0]?.status, "voided");
			assert.equal(budget.reservations[0]?.outcome, "no_stage_executed");
		} finally {
			await rm(dir, { recursive: true, force: true });
		}
	});
});

describe("approved replay cap raises", () => {
	const text = `---\nrepository: ${repo}\nreplay:\n  max_tokens: 1650000\n---\n`;
	const policy = { mainSha: sha, workflowText: text };

	async function fixture() {
		const dir = await mkdtemp(join(tmpdir(), "replay-raise-"));
		const path = join(dir, "budget.json");

		const reservations = [
			{
				key: "settled",
				status: "settled",
				tokens: 43274,
				wallMs: 100,
				startedAt: 1,
				outcome: "needs_info",
				runId: "old",
			},
			{
				key: "retained",
				status: "reserved",
				tokens: 540000,
				wallMs: 0,
				startedAt: Date.now(),
				outcome: null,
				runId: null,
			},
		];

		await writeFile(
			path,
			JSON.stringify({ v: 1, maxTokens: 1100000, reservations }),
		);

		return { dir, path, reservations };
	}

	it("accepts and audits a raise without changing existing charges or reservations", async () => {
		const { dir, path, reservations } = await fixture();

		try {
			const before = Date.now();
			await reserveReplay(path, 1650000, "next", policy);
			const budget = await readReplayBudget(path);
			assert.equal(budget.maxTokens, 1650000);
			assert.deepEqual(budget.reservations.slice(0, 2), reservations);
			assert.equal(budget.chargedTokens, 1123274);
			assert.deepEqual(
				budget.policyChanges?.map(({ at, ...change }) => {
					assert.ok(at >= before && at <= Date.now());

					return change;
				}),
				[
					{
						from: 1100000,
						to: 1650000,
						mainSha: sha,
						workflowDigest: digestOf(text),
					},
				],
			);
			await replay.voidReplay(
				path,
				"next",
				{ complete: true, stages: 0, tokens: 0 },
				"no_work",
			);
			assert.deepEqual(
				(await readReplayBudget(path)).policyChanges,
				budget.policyChanges,
			);
		} finally {
			await rm(dir, { recursive: true, force: true });
		}
	});

	it("refuses lower and malformed caps without writes; equal caps add no audit", async () => {
		const { dir, path } = await fixture();

		try {
			const bytes = await readFile(path, "utf8");

			for (const cap of [1000000, NaN, Infinity, 1650000.5]) {
				await assert.rejects(
					reserveReplay(path, cap, "next", policy),
					/replay_policy_changed/,
				);
				assert.equal(await readFile(path, "utf8"), bytes);
			}

			await replay.voidReplay(
				path,
				"retained",
				{ complete: true, stages: 0, tokens: 0 },
				"no_work",
			);
			await reserveReplay(path, 1100000, "equal");
			assert.deepEqual((await readReplayBudget(path)).policyChanges, []);
		} finally {
			await rm(dir, { recursive: true, force: true });
		}
	});

	it("check previews the real raise without writes and agrees with reserve", async () => {
		const { dir, path } = await fixture();

		const execute: Exec = async (_cmd, args) => ({
			code: 0,
			stdout: args[1]?.endsWith(":src/workflow.ts")
				? syntheticWorkflow
				: args[0] === "show"
					? text
					: "",
			stderr: "",
		});

		const args = [
			"replay",
			"check",
			"--json",
			"--corpus",
			corpusDir,
			"--main-sha",
			sha,
			"--previous-sha",
			sha,
			"--candidate-sha",
			otherSha,
			"--case",
			"c3",
			"--production-state-dir",
			dir,
			"--budget-file",
			path,
		];

		try {
			const bytes = await readFile(path, "utf8");
			const checked = await cli(args, execute);
			assert.equal(checked.code, EXIT.ok, checked.stdout);
			const report = JSON.parse(checked.stdout);
			assert.equal(report.allowed, true);
			assert.equal(report.budget.remainingTokens, 1066726);
			assert.deepEqual(report.budget.pendingPolicyChange, {
				from: 1100000,
				to: 1650000,
				mainSha: sha,
				workflowDigest: digestOf(text),
			});
			assert.equal(await readFile(path, "utf8"), bytes);
			await reserveReplay(path, 1650000, "next", policy);
			const exhausted = await cli(args, execute);
			assert.equal(exhausted.code, EXIT.invalid, exhausted.stdout);
			assert.match(exhausted.stdout, /replay_cap/);
			await assert.rejects(
				reserveReplay(path, 1650000, "another", policy),
				/replay_cap/,
			);

			const lowerExec: Exec = async (_cmd, argv) => {
				const result = await execute(_cmd, argv);

				return {
					...result,
					stdout: result.stdout.replace("1650000", "1100000"),
				};
			};

			const lower = await cli(args, lowerExec);
			assert.match(lower.stdout, /replay_policy_changed/);
			await assert.rejects(
				reserveReplay(path, 1100000, "lower", policy),
				/replay_policy_changed/,
			);
			await writeFile(
				path,
				bytes.replace('"maxTokens":1100000', '"maxTokens":"1100000"'),
			);
			const malformed = await readFile(path, "utf8");
			assert.equal((await cli(args, execute)).code, EXIT.invalid);
			await assert.rejects(
				reserveReplay(path, 1650000, "bad", policy),
				/replay_budget_invalid/,
			);
			assert.equal(await readFile(path, "utf8"), malformed);
		} finally {
			await rm(dir, { recursive: true, force: true });
		}
	});

	it("uses the driver's frozen main for the existing three-argument reserve call", async () => {
		const { dir, path } = await fixture();

		try {
			const git = (args: string[]) =>
				execFileSync("git", args, { cwd: dir, encoding: "utf8" }).trim();

			git(["init", "--quiet"]);
			await mkdir(join(dir, ".github/factory"), { recursive: true });
			await writeFile(join(dir, ".github/factory/WORKFLOW.md"), text);
			git(["add", ".github/factory/WORKFLOW.md"]);
			git([
				"-c",
				"user.name=Replay Test",
				"-c",
				"user.email=replay@example.invalid",
				"-c",
				"commit.gpgsign=false",
				"commit",
				"--quiet",
				"-m",
				"frozen policy",
			]);
			const mainSha = git(["rev-parse", "HEAD"]);
			const script = `import { reserveReplay } from ${JSON.stringify(new URL("../src/replay.ts", import.meta.url).href)}; await reserveReplay(${JSON.stringify(path)}, 1650000, 'next');`;
			execFileSync(
				process.execPath,
				["--experimental-strip-types", "--input-type=module", "-e", script],
				{ cwd: dir, env: { ...process.env, REPLAY_MAIN_SHA: mainSha } },
			);
			assert.deepEqual(
				(await readReplayBudget(path)).policyChanges.map(
					({ at, ...change }) => {
						assert.ok(at > 0);

						return change;
					},
				),
				[
					{
						from: 1100000,
						to: 1650000,
						mainSha,
						workflowDigest: digestOf(text),
					},
				],
			);
		} finally {
			await rm(dir, { recursive: true, force: true });
		}
	});

	it("refuses unproven raises and malformed audit history without writes", async () => {
		const { dir, path } = await fixture();

		try {
			const bytes = await readFile(path, "utf8");
			await assert.rejects(
				reserveReplay(path, 1650000, "next", {
					...policy,
					workflowText: text.replace("1650000", "1100000"),
				}),
				/replay_policy_changed/,
			);
			assert.equal(await readFile(path, "utf8"), bytes);
			await writeFile(
				path,
				JSON.stringify({
					...JSON.parse(bytes),
					policyChanges: [
						{
							from: 1650000,
							to: 1100000,
							at: 1,
							mainSha: sha,
							workflowDigest: digestOf(text),
						},
					],
				}),
			);
			await assert.rejects(readReplayBudget(path), /replay_budget_invalid/);
		} finally {
			await rm(dir, { recursive: true, force: true });
		}
	});
});

describe("capped replay budget", () => {
	it("reserves a full run, charges failures, retains interrupted reservations and refuses insufficient room", async () => {
		const dir = await mkdtemp(join(tmpdir(), "replay-budget-"));
		const path = join(dir, "budget.json");

		try {
			assert.equal(REPLAY_RUN_CAP, 540000);
			await reserveReplay(path, 1100000, "previous");
			await assert.rejects(
				reserveReplay(path, 1100000, "previous"),
				/replay_already_reserved/,
			);
			await reserveReplay(path, 1100000, "candidate");
			await assert.rejects(reserveReplay(path, 1100000, "third"), /replay_cap/);
			const row = await fixtureRow();
			await settleReplay(path, "previous", {
				...row,
				usage: {
					...row.usage,
					tokens: { kind: "exact", unit: "tokens", total: 600000 },
				},
			});
			const budget = await readReplayBudget(path);
			assert.equal(budget.chargedTokens, 1140000);
			assert.equal(budget.reservations[1]?.status, "reserved");
			await assert.rejects(
				reserveReplay(path, 1100000, "fourth"),
				/replay_cap/,
			);
		} finally {
			await rm(dir, { recursive: true, force: true });
		}
	});

	it("never refunds partial or uncertain accounting; persists terminal failures and wall time", async () => {
		const dir = await mkdtemp(join(tmpdir(), "replay-charge-"));
		const path = join(dir, "budget.json");

		try {
			await reserveReplay(path, 1100000, "failed");
			const row = await fixtureRow();

			const failed: LedgerRow = {
				...row,
				outcome: {
					kind: "failed",
					stage: "accept",
					cause: { kind: "unavailable", reason: "not_instrumented" },
				},
				usage: {
					...row.usage,
					tokens: { kind: "exact", unit: "tokens", total: 27000 },
				},
			};

			await settleReplay(path, "failed", failed);
			const settledBytes = await readFile(path, "utf8");
			await settleReplay(path, "failed", failed);
			assert.equal(await readFile(path, "utf8"), settledBytes);
			let b = await readReplayBudget(path);
			assert.equal(b.chargedTokens, 27000);
			assert.equal(b.reservations[0]?.outcome, "failed");
			await reserveReplay(path, 1100000, "interrupted");
			await settleReplay(path, "interrupted", {
				...row,
				runId: digestOf("interrupted run"),
				usage: {
					...row.usage,
					tokens: {
						kind: "lower_bound",
						unit: "tokens",
						total: 100,
						reason: "receipt_missing",
					},
				},
			});
			b = await readReplayBudget(path);
			assert.equal(b.chargedTokens, 567000);
			assert.ok(b.wallMs >= 0);
			await assert.rejects(
				reserveReplay(path, 1099999, "changed-cap"),
				/replay_policy_changed/,
			);
		} finally {
			await rm(dir, { recursive: true, force: true });
		}
	});
});

describe("trusted replay policy and guards", () => {
	it("parses valid, absent-disabled and invalid replay caps", () => {
		for (const cap of ["0", "-1", "1.5", "false", "no", "9007199254740992"]) {
			const r = workflow(
				`---\nrepository: ${repo}\nreplay:\n  max_tokens: ${cap}\n---\n`,
			);

			assert.equal(r.kind, "invalid", cap);
		}

		const valid = workflow(
			`---\nrepository: ${repo}\nreplay:\n  max_tokens: 1100000\n---\n`,
		);

		assert.equal(valid.kind, "valid");

		if (valid.kind === "valid")
			assert.deepEqual(valid.config.replay, { maxTokens: 1100000 });
		assert.equal(
			workflow(`---\nrepository: ${repo}\nreplay: {}\n---\n`).kind,
			"invalid",
		);
		const absent = workflow(`---\nrepository: ${repo}\n---\n`);

		if (absent.kind !== "valid") throw new Error("invalid");
		assert.equal(absent.config.replay, null);
	});

	it("the CLI refuses a bound production lock, including without a holder file", async () => {
		const dir = await mkdtemp(join(tmpdir(), "replay-production-"));

		const lock = await acquireLock({
			stateDir: dir,
			procs: procTable(),
			now: Date.now,
		});

		assert.equal(lock.kind, "acquired");

		if (lock.kind !== "acquired") throw new Error("lock");

		await unlink(join(dir, "controller.lock"));

		try {
			const result = await cli([
				"replay",
				"check",
				"--json",
				"--corpus",
				corpusDir,
				"--main-sha",
				sha,
				"--previous-sha",
				sha,
				"--candidate-sha",
				sha,
				"--production-state-dir",
				dir,
			]);

			assert.equal(result.code, EXIT.invalid);
			assert.match(result.stdout, /production_controller_running/);
		} finally {
			await lock.lock.release();
			await rm(dir, { recursive: true, force: true });
		}
	});

	it("keeps the replay core free of model/executor imports and source guards ahead of launch (driver behavior tested separately)", async () => {
		const source = await readFile(
			new URL("../src/replay.ts", import.meta.url),
			"utf8",
		);

		assert.doesNotMatch(
			source,
			/from ["'][^"']*(?:sandbox\.ts|orchestrator|controller|executor)["']/,
		);

		const driver = await readFile(
			new URL(
				"../.pi/skills/verify-factory/scripts/drive-replay.sh",
				import.meta.url,
			),
			"utf8",
		);

		for (const guard of [
			"FIXTURE_GRANT",
			"production-state-dir",
			"reserveReplay",
		])
			assert.ok(
				driver.indexOf(guard) < driver.indexOf("exec node server/cli.ts serve"),
				guard,
			);
		assert.match(driver, /--issue/);
		assert.match(driver, /--verification-token-cap/);
	});
});
