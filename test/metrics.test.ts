import assert from "node:assert/strict";
import {
	mkdirSync,
	mkdtempSync,
	readFileSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { performance } from "node:perf_hooks";
import { describe, it } from "node:test";
import { EXIT, runCli } from "../server/cli.ts";
import {
	ledgerRow,
	parseLedger,
	type LedgerRow,
	type LedgerRowV1,
} from "../src/ledger.ts";
import {
	computeMetrics,
	excludedRunReason,
	EXCLUDED_RUNS,
	type DefectIssue,
	type DefectRead,
} from "../src/metrics.ts";
import { digestOf, runIdOf } from "../src/run.ts";
import { isRepoSlug, type Exec } from "../src/workflow.ts";

const repo = "giuseppecrj/pi-herdr-factorio";

const fixture = readFileSync(
	new URL("./fixtures/metrics/runs-2026-11-08.jsonl", import.meta.url),
);

const rows = parseLedger(fixture).map((line) => {
	assert.equal(line.kind, "known");

	if (line.kind !== "known") throw new Error("invalid fixture");

	return line.row;
});

const original = rows[12];

assert.ok(original?.v === 1);

const base: LedgerRowV1 = original;
const mergedAt = "2026-11-01T00:00:00Z";
const matureAt = "2026-11-08T00:00:00Z";
const none: DefectRead = { kind: "known", issues: [] };

function synthetic(issue = 100, eventId = "100"): LedgerRowV1 {
	assert.equal(base.artifacts.kind, "candidate");

	if (base.artifacts.kind !== "candidate" || base.outcome.kind !== "landed")
		throw new Error("bad base");

	// SAFETY: ledgerRow preserves the explicitly supplied v1 codec.
	return ledgerRow({
		...base,
		issue,
		eventId,
		runId: runIdOf({ repo, issue, eventId }),
		eventAt: mergedAt,
		startedAt: { kind: "known", value: mergedAt },
		terminalObservedAt: mergedAt,
		previousRunId: { kind: "known", value: null },
		outcome: { ...base.outcome, mergedAt: { kind: "known", value: mergedAt } },
		artifacts: {
			...base.artifacts,
			generations: base.artifacts.generations.map((g) => ({ ...g, round: 0 })),
		},
		stages: { kind: "unavailable", reason: "not_instrumented" },
		models: { kind: "unavailable", reason: "not_instrumented" },
		usage: {
			...base.usage,
			tokens: { kind: "exact", unit: "tokens", total: 100 },
			parentTokens: { kind: "known", value: 100 },
			childTokens: { kind: "known", value: 0 },
			unattributedTokens: { kind: "known", value: 0 },
		},
		redactedReceiptDigests: [],
		evidence: {
			issueUrl: `https://github.com/${repo}/issues/${issue}`,
			ciUrls: [],
		},
	}).row as LedgerRowV1;
}

const bytesOf = (input: readonly LedgerRow[]) =>
	Buffer.concat(input.map((row) => ledgerRow(row).bytes));

const report = (
	input: readonly LedgerRow[],
	defects: DefectRead = none,
	now = matureAt,
) => computeMetrics({ ledger: bytesOf(input), repo, now, defects });

const ticketOf = (value: ReturnType<typeof computeMetrics>, issue = 100) => {
	const ticket = value.tickets.find((item) => item.issue === issue);
	assert.ok(ticket);

	return ticket;
};

const defect = (
	body: string,
	createdAt = "2026-11-02T00:00:00Z",
): DefectIssue => ({
	number: 999,
	title: "Follow-up",
	body,
	createdAt,
	labels: ["factory:defect"],
});

async function cli(args: string[], exec?: Exec) {
	let stdout = "",
		stderr = "";

	const calls: string[][] = [];

	const code = await runCli(args, {
		exec: async (command, argv, options) => {
			calls.push([command, ...argv]);

			if (exec) return exec(command, argv, options);
			throw new Error("unexpected execution");
		},
		env: () => undefined,
		stdout: (text) => {
			stdout += text;
		},
		stderr: (text) => {
			stderr += text;
		},
	});

	return { code, stdout, stderr, calls };
}

async function withLedger(run: (path: string, dir: string) => Promise<void>) {
	const dir = mkdtempSync(join(tmpdir(), "metrics-"));
	const path = join(dir, "ledger.jsonl");
	writeFileSync(path, bytesOf([synthetic()]));

	try {
		await run(path, dir);
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
}

const cliArgs = (path: string) => [
	"metrics",
	"--json",
	"--repo",
	repo,
	"--ledger",
	path,
	"--now",
	matureAt,
];

describe("factory metrics", () => {
	it("pins all 26 canonical public rows and excludes verification plus all three fixture IDs", () => {
		assert.equal(rows.length, 26);
		assert.equal(EXCLUDED_RUNS.length, 3);

		const value = computeMetrics({
			ledger: fixture,
			repo,
			now: "2026-11-08T06:00:00Z",
			defects: none,
		});

		assert.equal(value.primary.denominator, 2);
		assert.equal(value.runs, 12);
		assert.equal(value.excluded.length, 14);
		assert.equal(value.status, "pending");

		for (const exclusion of EXCLUDED_RUNS.slice(1)) {
			const issue = exclusion.runId.startsWith("bd3") ? 650 : 658;
			const row = { ...synthetic(issue), runId: digestOf("placeholder") };
			assert.equal(
				excludedRunReason({ ...row, runId: exclusion.runId }),
				exclusion.reason,
			);
		}
	});

	it("excludes a legacy verification manifest but keeps unmarked legacy imports flagged", () => {
		const legacy = rows[21];
		assert.ok(legacy?.v === 4 && legacy.runContext.kind === "legacy");
		assert.equal(excludedRunReason(legacy), null);
		assert.equal(
			excludedRunReason({
				...legacy,
				runContext: {
					...legacy.runContext,
					known: {
						...legacy.runContext.known,
						verification: {
							manifestDigest: digestOf("verification"),
							effectiveCap: 800_000,
						},
					},
				},
			}),
			"verification_manifest",
		);
	});

	it("groups all nine attempts of 625 once and charges repaired and owner-feedback landings", () => {
		const value = computeMetrics({
			ledger: fixture,
			repo,
			now: "2026-11-20T00:00:00Z",
			defects: none,
		});

		assert.equal(ticketOf(value, 625).attempts.length, 9);
		assert.equal(ticketOf(value, 625).tokens, 3_488_382);
		assert.equal(ticketOf(value, 645).tokens, 664_554);
		assert.equal(value.tokens.total, 4_152_936);
		assert.equal(value.tokens.coverage, "lower_bound");
		assert.equal(value.tokens.uncertainRuns.length, 1);
		assert.equal(value.primary.numerator, 0);
		assert.equal(value.primary.landedTickets, 2);
		assert.equal(value.tokensPerCleanLanding, null);
		assert.equal(value.tokensPerCleanLandingReason, "no_clean_landings");
		assert.ok(
			value.tickets.every((ticket) => ticket.status === "landed_not_clean"),
		);
		assert.ok(
			value.tickets.every((ticket) => ticket.landings[0]?.certifiedRound === 1),
		);
		const legacy = rows[21];
		assert.ok(legacy);
		assert.ok(value.legacyRuns.includes(legacy.runId));
	});

	it("counts a previousRunId clarification chain once, but keeps all tokens", () => {
		const first = synthetic();
		const next = synthetic(100, "101");

		const value = report([
			{ ...first, outcome: { kind: "needs_info", stage: "specify" } },
			{ ...next, previousRunId: { kind: "known", value: first.runId } },
		]);

		assert.equal(value.primary.denominator, 1);
		assert.equal(value.primary.numerator, 1);
		assert.equal(value.tokensPerCleanLanding, 200);
		assert.equal(ticketOf(value).attempts[1]?.previousRunId, first.runId);
	});

	it("keeps repository identity in the ticket key and filters the requested repository", () => {
		const row = synthetic();
		const otherRepo = "someone/else";
		assert.ok(isRepoSlug(otherRepo));

		const other = {
			...row,
			repo: otherRepo,
			runId: runIdOf({
				repo: otherRepo,
				issue: row.issue,
				eventId: row.eventId,
			}),
			pr: { number: 622, url: `https://github.com/${otherRepo}/pull/622` },
			evidence: {
				issueUrl: `https://github.com/${otherRepo}/issues/${row.issue}`,
				ciUrls: [],
			},
		};

		const value = report([row, other]);
		assert.equal(value.primary.denominator, 1);
		assert.equal(value.tokens.total, 100);
	});

	it("derives round from the certified generation, not repairRounds or refresh count", () => {
		const row = synthetic();
		assert.ok(row.artifacts.kind === "candidate");
		const generation = row.artifacts.generations[0];
		assert.ok(generation);

		const value = report([
			{
				...row,
				repairRounds: { kind: "unavailable", reason: "not_instrumented" },
				artifacts: {
					...row.artifacts,
					generations: [
						{ ...generation, round: 1, intentDigest: digestOf("other") },
						{ ...generation, generation: 3 },
					],
				},
			},
		]);

		assert.equal(value.primary.numerator, 1);
		assert.equal(ticketOf(value).landings[0]?.certifiedRound, 0);
	});

	it("does not count owner overrides as clean", () => {
		const row = synthetic();
		assert.ok(row.outcome.kind === "landed");

		const value = report([
			{
				...row,
				outcome: { ...row.outcome, assurance: { kind: "owner_override" } },
			},
		]);

		assert.equal(value.primary.numerator, 0);
		assert.equal(ticketOf(value).status, "landed_not_clean");
	});

	it("does not count a v5 owner-authored round-zero head as clean", () => {
		const row = rows[25];
		assert.ok(
			row?.v === 4 &&
				row.outcome.kind === "landed" &&
				row.outcome.assurance.kind === "factory_verified" &&
				row.artifacts.kind === "candidate",
		);

		const owner = ledgerRow({
			...row,
			v: 5,
			artifacts: {
				...row.artifacts,
				generations: row.artifacts.generations.map((g) => ({ ...g, round: 0 })),
			},
			outcome: {
				...row.outcome,
				assurance: { ...row.outcome.assurance, authored: "owner" },
			},
		}).row;

		assert.equal(
			report([owner], none, "2026-11-20T00:00:00Z").primary.numerator,
			0,
		);
	});

	it("counts a ticket clean when any mature landing is clean, charging every landing", () => {
		const first = synthetic();
		assert.ok(first.outcome.kind === "landed");

		const value = report([
			{
				...first,
				outcome: { ...first.outcome, assurance: { kind: "owner_override" } },
			},
			synthetic(100, "101"),
		]);

		assert.equal(value.primary.numerator, 1);
		assert.equal(value.primary.denominator, 1);
		assert.equal(value.tokensPerCleanLanding, 200);
	});

	it("reports ambiguous certified generations as unknown", () => {
		const row = synthetic();
		assert.ok(row.artifacts.kind === "candidate");
		const generation = row.artifacts.generations[0];
		assert.ok(generation);

		const value = report([
			{
				...row,
				artifacts: {
					...row.artifacts,
					generations: [generation, { ...generation, round: 1 }],
				},
			},
		]);

		assert.equal(ticketOf(value).status, "unknown");
		assert.equal(value.primary.numerator, 0);
		assert.ok(
			value.unknowns.some(
				(entry) => entry.reason === "certified_generation_unavailable",
			),
		);
	});

	it("counts every terminal outcome in the token denominator", () => {
		const outcomes: LedgerRowV1["outcome"][] = [
			{
				kind: "failed",
				stage: "build",
				cause: { kind: "unavailable", reason: "not_instrumented" },
			},
			{
				kind: "budget_exhausted",
				stage: "build",
				cap: { kind: "known", value: "stage_tokens" },
			},
			{
				kind: "cancelled",
				stage: "build",
				reason: { kind: "known", value: "closed" },
			},
			{ kind: "released", stage: "build" },
			{ kind: "needs_info", stage: "specify" },
		];

		const value = report(
			outcomes.map((outcome, at) => ({
				...synthetic(100, String(at + 100)),
				outcome,
			})),
		);

		assert.equal(value.tokens.total, 500);
		assert.equal(value.primary.denominator, 1);
		assert.equal(value.primary.numerator, 0);
		assert.equal(ticketOf(value).status, "not_landed");
	});

	it("uses an inclusive seven-day maturity boundary, never an immature clean claim", () => {
		const row = synthetic();
		const before = report([row], none, "2026-11-07T23:59:59.999Z");
		assert.equal(before.status, "pending");
		assert.equal(before.primary.numerator, 0);
		assert.equal(before.primary.share, null);
		assert.equal(ticketOf(before).status, "pending");
		const boundary = report([row]);
		assert.equal(boundary.status, "complete");
		assert.equal(boundary.primary.numerator, 1);
		assert.equal(boundary.primary.share, 1);
	});

	it("reports the cohort pending if any ticket is immature", () => {
		const row = synthetic(101);

		const value = report([
			synthetic(),
			{
				...row,
				terminalObservedAt: "2026-11-07T00:00:00Z",
				outcome: { kind: "needs_info", stage: "specify" },
			},
		]);

		assert.equal(value.status, "pending");
		assert.equal(value.primary.matureTickets, 1);
		assert.equal(value.primary.pendingTickets, 1);
		assert.equal(value.primary.share, null);
	});

	it("uses the last terminal observation to mature not-landed tickets", () => {
		const row = synthetic();

		const value = report(
			[{ ...row, outcome: { kind: "needs_info", stage: "specify" } }],
			none,
			"2026-11-07T23:59:59Z",
		);

		assert.equal(ticketOf(value).status, "pending");
	});

	it("missing merge time is unknown and never clean", () => {
		const row = synthetic();
		assert.ok(row.outcome.kind === "landed");

		const value = report([
			{
				...row,
				outcome: {
					...row.outcome,
					mergedAt: {
						kind: "unavailable",
						reason: "public_metadata_unavailable",
					},
				},
			},
		]);

		assert.equal(ticketOf(value).status, "unknown");
		assert.equal(value.primary.numerator, 0);
		assert.ok(
			value.unknowns.some((entry) => entry.reason === "merged_at_unavailable"),
		);
	});

	for (const reference of [
		"#100",
		"#622",
		`${repo}#100`,
		`${repo}#622`,
		`https://github.com/${repo}/pull/622`,
		`https://github.com/${repo}/issues/100`,
	]) {
		it(`recognizes a labeled defect reference ${reference}`, () => {
			const value = report([synthetic()], {
				kind: "known",
				issues: [defect(`Regression in ${reference}.`)],
			});

			assert.equal(value.primary.numerator, 0);
			assert.deepEqual(ticketOf(value).landings[0]?.defect, {
				kind: "linked",
				issues: [999],
			});
		});
	}

	it("requires the label, same repository reference, other issue, strict start and inclusive end", () => {
		for (const issue of [
			{ ...defect("#100"), labels: ["bug"] },
			defect("#1000 #6220"),
			defect("someone/else#100 https://github.com/someone/else/pull/622"),
			{ ...defect("#100"), number: 100 },
			defect("#100", mergedAt),
			defect("#100", "2026-11-08T00:00:00.001Z"),
		])
			assert.equal(
				report([synthetic()], { kind: "known", issues: [issue] }).primary
					.numerator,
				1,
			);
		assert.equal(
			report([synthetic()], {
				kind: "known",
				issues: [defect("#100", matureAt)],
			}).primary.numerator,
			0,
		);
	});

	for (const reason of ["offline", "defect_query_failed"]) {
		it(`reports unknown, never clean, for ${reason}`, () => {
			const value = report([synthetic()], { kind: "unknown", reason });
			assert.equal(ticketOf(value).status, "unknown");
			assert.equal(value.primary.numerator, 0);
			assert.equal(value.primary.unknownTickets, 1);
			assert.ok(value.unknowns.some((entry) => entry.reason === reason));
		});
	}

	it("lists corrupt and unsupported rows separately without inventing history", () => {
		const value = computeMetrics({
			ledger: Buffer.concat([
				bytesOf([synthetic()]),
				Buffer.from('not json\n{"v":99}\n'),
			]),
			repo,
			now: matureAt,
			defects: none,
		});

		assert.equal(value.status, "unknown");
		assert.equal(
			value.unknowns.filter((entry) => entry.kind === "ledger").length,
			2,
		);
		assert.equal(value.primary.denominator, 1);
		assert.equal(value.primary.share, null);
	});

	it("deduplicates a repeated run without charging it twice and reports the ledger anomaly", () => {
		const row = synthetic();
		const value = report([row, row]);
		assert.equal(value.tokens.total, 100);
		assert.ok(value.unknowns.some((entry) => entry.reason === "duplicate_run"));
	});

	it("lists uncertain charged tokens without calling them exact", () => {
		const row = synthetic();

		const value = report([
			{
				...row,
				usage: {
					...row.usage,
					tokens: {
						kind: "uncertain",
						unit: "tokens",
						total: 100,
						reason: "request_unsettled",
					},
				},
			},
		]);

		assert.equal(value.tokens.total, 100);
		assert.equal(value.tokens.coverage, "uncertain");
		assert.deepEqual(value.tokens.uncertainRuns, [row.runId]);
	});

	it("reports insufficient data for an empty cohort", () => {
		const value = report([]);
		assert.equal(value.status, "insufficient_data");
		assert.equal(value.primary.share, null);
		assert.equal(
			value.deferred.contextPressure.promptCapHit.insufficientData,
			true,
		);
		assert.equal(
			value.deferred.contextPressure.promptCapHit.belowThreshold,
			null,
		);
	});

	it("reports cap-hit shares as the decision signal and truncation as information", () => {
		const value = computeMetrics({
			ledger: fixture,
			repo,
			now: "2026-11-08T06:00:00Z",
			defects: none,
		});

		const pressure = value.deferred.contextPressure;
		assert.equal(pressure.promptCapHit.count, 4);
		assert.equal(pressure.promptCapHit.denominator, 4);
		assert.equal(pressure.promptCapHit.threshold, 0.1);
		assert.equal(pressure.promptCapHit.belowThreshold, false);
		assert.equal(pressure.promptCapHit.matureCount, 0);
		assert.equal(
			pressure.stages.find((item) => item.stage === "specify")?.promptCapHit
				.count,
			7,
		);
		assert.equal(
			pressure.stages.find((item) => item.stage === "accept")?.promptCapHit
				.count,
			1,
		);
		assert.equal(
			pressure.stages.find((item) => item.stage === "accept")?.truncated.count,
			7,
		);
		assert.equal(value.deferred.intakeDemand.reason, "no_intake_signal");
		assert.equal(value.deferred.restartEnded.runs.length, 1);
		assert.equal(value.deferred.restartEnded.runs[0]?.failureClass, "input");
	});

	it("reports below-threshold and exactly-at-threshold signals without taking action", () => {
		const input = Array.from({ length: 10 }, (_, at) => ({
			...synthetic(at + 100),
			contextPressure: {
				kind: "known" as const,
				value: { promptCapHit: at === 0, truncated: true },
			},
		}));

		const at = report(input).deferred.contextPressure;
		assert.equal(at.promptCapHit.share, 0.1);
		assert.equal(at.promptCapHit.belowThreshold, false);
		input.push({
			...synthetic(110),
			contextPressure: {
				kind: "known",
				value: { promptCapHit: false, truncated: true },
			},
		});
		assert.equal(
			report(input).deferred.contextPressure.promptCapHit.belowThreshold,
			true,
		);
	});

	it("computes and parses 1,000 rows in under two seconds with no executor or sandbox import", (context) => {
		const ledger = bytesOf(
			Array.from({ length: 1000 }, (_, at) => synthetic(at + 1000)),
		);

		const start = performance.now();

		const value = computeMetrics({
			ledger,
			repo,
			now: matureAt,
			defects: none,
		});

		const elapsed = performance.now() - start;
		context.diagnostic(`1000 rows: ${elapsed.toFixed(2)} ms`);
		assert.equal(value.primary.denominator, 1000);
		assert.equal(value.primary.numerator, 1000);
		assert.ok(elapsed < 2000, `${elapsed} ms exceeds 2 s`);
		assert.doesNotMatch(
			readFileSync(new URL("../src/metrics.ts", import.meta.url), "utf8"),
			/from\s+["'][^"']*(?:executor|sandbox)/,
		);
	});
});

describe("metrics CLI", () => {
	it("serves JSON offline without exec, runtime, workflow or model calls", async () => {
		await withLedger(async (path) => {
			const value = await cli([...cliArgs(path), "--offline"]);
			assert.equal(value.code, EXIT.ok, value.stderr);
			assert.deepEqual(value.calls, []);
			const output = JSON.parse(value.stdout);
			assert.equal(output.schemaVersion, 1);
			assert.equal(output.primary.denominator, 1);
			assert.equal(output.primary.numerator, 0);
			assert.equal(output.status, "unknown");
		});
	});

	it("uses one read-only labeled issue query and validates the JSON", async () => {
		await withLedger(async (path) => {
			for (const stdout of ["[]", "{}", "[{}]", "not json"]) {
				const value = await cli(cliArgs(path), async () => ({
					code: 0,
					stdout,
					stderr: "",
				}));

				assert.equal(value.code, EXIT.ok);
				assert.equal(value.calls.length, 1);
				assert.deepEqual(value.calls[0]?.slice(0, 3), ["gh", "issue", "list"]);
				assert.ok(value.calls[0]?.includes("factory:defect"));
				assert.equal(
					JSON.parse(value.stdout).primary.numerator,
					stdout === "[]" ? 1 : 0,
				);
			}
		});
	});

	it("fails closed on query errors, thrown transport errors and a saturated query limit", async () => {
		await withLedger(async (path) => {
			for (const exec of [
				async () => ({ code: 1, stdout: "[]", stderr: "private error" }),
				async () => {
					throw new Error("private error");
				},
				async (_command: string, args: readonly string[]) => ({
					code: 0,
					stdout: JSON.stringify(
						Array.from(
							{ length: Number(args[args.indexOf("--limit") + 1]) },
							() => ({
								...defect("#100"),
								labels: [{ name: "factory:defect" }],
							}),
						),
					),
					stderr: "",
				}),
			]) {
				const value = await cli(cliArgs(path), exec);
				assert.equal(value.code, EXIT.ok);
				assert.equal(JSON.parse(value.stdout).primary.numerator, 0);
				assert.equal(JSON.parse(value.stdout).status, "unknown");
				assert.doesNotMatch(value.stdout, /private error/);
			}
		});
	});

	it("reads the locally fetched ledger ref when no file is given", async () => {
		const value = await cli(
			["metrics", "--json", "--repo", repo, "--offline", "--now", matureAt],
			async (command, args) => {
				assert.equal(command, "git");
				assert.deepEqual(args, [
					"show",
					"refs/remotes/origin/factory/ledger:ledger/runs.jsonl",
				]);

				return {
					code: 0,
					stdout: bytesOf([synthetic()]).toString(),
					stderr: "",
				};
			},
		);

		assert.equal(value.code, EXIT.ok);
	});

	it("checks digest-matched receipts and marks a missing or changed receipt unknown", async () => {
		await withLedger(async (path, dir) => {
			const receipt = Buffer.from(
				'{"version":1,"runId":"public","stage":"build"}\n',
			);

			const row = {
				...synthetic(),
				redactedReceiptDigests: [digestOf(receipt)],
			};

			writeFileSync(path, bytesOf([row]));
			const args = [...cliArgs(path), "--state-dir", dir];
			const exec: Exec = async () => ({ code: 0, stdout: "[]", stderr: "" });
			assert.equal(
				JSON.parse((await cli(args, exec)).stdout).tickets[0].status,
				"unknown",
			);
			const stage = join(dir, "stages", row.runId, "build-1", "draft");
			mkdirSync(stage, { recursive: true });
			writeFileSync(join(stage, "receipt.json"), receipt);
			assert.equal(
				JSON.parse((await cli(args, exec)).stdout).primary.numerator,
				1,
			);
			writeFileSync(join(stage, "receipt.json"), "changed");
			const missing = JSON.parse((await cli(args, exec)).stdout);
			assert.equal(missing.primary.numerator, 0);
			assert.equal(missing.tickets[0].status, "unknown");
			assert.ok(
				missing.unknowns.some(
					(entry: { reason: string }) =>
						entry.reason === "receipt_missing_or_changed",
				),
			);
		});
	});

	it("keeps an immature cohort pending even when a receipt is unknown", async () => {
		await withLedger(async (path, dir) => {
			writeFileSync(
				path,
				bytesOf([
					{ ...synthetic(), redactedReceiptDigests: [digestOf("missing")] },
				]),
			);

			const value = await cli([
				...cliArgs(path),
				"--now",
				"2026-11-07T00:00:00Z",
				"--offline",
				"--state-dir",
				dir,
			]);

			assert.equal(value.code, EXIT.ok);
			const output = JSON.parse(value.stdout);
			assert.equal(output.status, "pending");
			assert.equal(output.tickets[0].status, "unknown");
			assert.equal(output.primary.numerator, 0);
		});
	});

	it("queries defects through the CLI without exporting issue text", async () => {
		await withLedger(async (path) => {
			const value = await cli(cliArgs(path), async () => ({
				code: 0,
				stdout: JSON.stringify([
					{
						...defect("private words #100"),
						labels: [{ name: "factory:defect" }],
					},
				]),
				stderr: "",
			}));

			assert.equal(value.code, EXIT.ok);
			assert.equal(
				JSON.parse(value.stdout).tickets[0].status,
				"landed_not_clean",
			);
			assert.doesNotMatch(value.stdout, /private words/);
		});
	});

	it("rejects wrong options and does not fetch or execute on usage errors", async () => {
		for (const args of [
			["metrics", "--repo", repo],
			["metrics", "--json"],
			["metrics", "--json", "--repo", repo, "--now", "invalid"],
			["metrics", "--json", "--repo", repo, "--cohort", "verification"],
			["metrics", "--json", "--repo", repo, "--issue", "100"],
		]) {
			const value = await cli(args);
			assert.equal(value.code, EXIT.usage);
			assert.deepEqual(value.calls, []);
		}
	});

	it("reports unreadable ledger as an error, not an empty success", async () => {
		const value = await cli([
			...cliArgs("/missing/metrics-ledger"),
			"--offline",
		]);

		assert.equal(value.code, EXIT.invalid);
		assert.equal(JSON.parse(value.stdout).error, "ledger_unavailable");
	});
});
