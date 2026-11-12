import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
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
	type LedgerRowV4,
} from "../src/ledger.ts";
import {
	computeMetrics,
	excludedRunReason,
	EXCLUDED_RUNS,
	type DefectIssue,
	type DefectRead,
} from "../src/views/metrics.ts";
import { digestOf, runIdOf } from "../src/core/run.ts";
import { isRepoSlug, type Exec } from "../src/workflow.ts";
import { noPlatformFile } from "./helpers.ts";
import { EXE_DEV_PLATFORM } from "../src/trust/platform.ts";

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
		readPlatformFile: noPlatformFile,
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
	it("pins all 26 canonical public rows and excludes verification plus all eight fixture IDs", () => {
		assert.equal(rows.length, 26);
		assert.equal(EXCLUDED_RUNS.length, 8);

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

		for (const exclusion of EXCLUDED_RUNS.slice(1, 3)) {
			const issue = exclusion.runId.startsWith("bd3") ? 650 : 658;
			const row = { ...synthetic(issue), runId: digestOf("placeholder") };
			assert.equal(
				excludedRunReason({ ...row, runId: exclusion.runId }),
				exclusion.reason,
			);
		}
	});

	it("excludes all five F09c live-lane production rows from every cohort and token denominator", () => {
		const ids = [
			"eb9f779fac14baf331d29350a37eb42b9d10530323de70a687230da49ab6c7d9",
			"d22f122bd8d318610b24a808e38fbd290b82b67d04ef5f01bea5158117be0c31",
			"4086ee6e567860b7cdad114fe033cc12fc234c3387081cdeb304d55434dbbfa3",
			"141e0640c8d6f4fdc564354342b898bb4d55f1ca04b19824fec18932ec4cda4d",
			"3920f5ed4fab622b1edc5f114a728763343e1da8402a18052e58047a5ece4423",
		];

		const input = [
			synthetic(689, "35615364244"),
			synthetic(688, "35615271933"),
			synthetic(690, "35616783706"),
			synthetic(689, "35622018082"),
			synthetic(692, "35622451614"),
		];

		assert.deepEqual(
			input.map((row) => row.runId),
			ids,
		);

		for (const row of input)
			assert.equal(excludedRunReason(row), "F09c live-lane fixture");
		const clean = synthetic();
		const value = report([clean, ...input]);
		assert.equal(value.runs, 1);
		assert.equal(value.primary.denominator, 1);
		assert.equal(value.tokens.total, 100);
		assert.equal(value.excluded.length, 5);
		assert.deepEqual(
			value.tickets.map((ticket) => ticket.issue),
			[100],
		);
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
		assert.equal(value.primary.numerator, 0);
		assert.equal(value.tokens.total, 200);
		assert.equal(ticketOf(value).status, "unknown");
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

		assert.equal(value.primary.numerator, 0);
		assert.equal(ticketOf(value).landings[0]?.certifiedRound, 0);
		assert.ok(
			ticketOf(value).landings[0]?.reasons.includes("intervention_unreadable"),
		);
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

	it("charges every landing without presuming an unrecorded intervention was absent", () => {
		const first = synthetic();
		assert.ok(first.outcome.kind === "landed");

		const value = report([
			{
				...first,
				outcome: { ...first.outcome, assurance: { kind: "owner_override" } },
			},
			synthetic(100, "101"),
		]);

		assert.equal(value.primary.numerator, 0);
		assert.equal(value.primary.denominator, 1);
		assert.equal(value.tokens.total, 200);
		assert.equal(value.tokensPerCleanLanding, null);
		assert.equal(ticketOf(value).status, "unknown");
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
		assert.equal(boundary.status, "unknown");
		assert.equal(boundary.primary.matureTickets, 1);
		assert.equal(ticketOf(boundary).landings[0]?.defect.kind, "none");
		assert.equal(boundary.primary.share, null);
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
				ticketOf(report([synthetic()], { kind: "known", issues: [issue] }))
					.landings[0]?.defect.kind,
				"none",
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
		assert.equal(value.primary.numerator, 0);
		assert.equal(value.primary.unknownTickets, 1000);
		assert.ok(elapsed < 2000, `${elapsed} ms exceeds 2 s`);
		assert.doesNotMatch(
			readFileSync(new URL("../src/views/metrics.ts", import.meta.url), "utf8"),
			/from\s+["'][^"']*(?:executor|sandbox)/,
		);
	});
});

describe("review regressions", () => {
	it("withholds headline cost for pending and unknown cohorts (review probe)", () => {
		const recent = synthetic(101);
		assert.ok(recent.outcome.kind === "landed");

		const pending = report([
			synthetic(),
			{
				...recent,
				outcome: {
					...recent.outcome,
					mergedAt: { kind: "known", value: "2026-11-07T00:00:00Z" },
				},
			},
		]);

		assert.equal(pending.status, "pending");
		assert.equal(pending.tokensPerCleanLanding, null);
		assert.equal(pending.tokensPerCleanLandingReason, "cohort_pending");
		const unknown = report([synthetic()]);
		assert.equal(unknown.tokensPerCleanLanding, null);
		assert.equal(unknown.tokensPerCleanLandingReason, "cohort_unknown");
	});

	it("never infers absence of owner intervention from v1–v5 round-zero certifications", () => {
		const v4 = rows[25];
		assert.ok(
			v4?.v === 4 &&
				v4.artifacts.kind === "candidate" &&
				v4.outcome.kind === "landed" &&
				v4.outcome.assurance.kind === "factory_verified",
		);

		const roundZero: LedgerRowV4 = {
			...v4,
			artifacts: {
				...v4.artifacts,
				generations: v4.artifacts.generations.map((g) => ({ ...g, round: 0 })),
			},
		};

		const v5 = ledgerRow({
			...roundZero,
			v: 5,
			outcome: {
				...v4.outcome,
				assurance: { ...v4.outcome.assurance, authored: "factory" },
			},
		}).row;

		const v2 = ledgerRow({
			...synthetic(),
			v: 2,
			failure: null,
			acceptAttempts: { kind: "unavailable", reason: "not_instrumented" },
		}).row;

		assert.ok(v2.v === 2);

		const v3 = ledgerRow({
			...v2,
			v: 3,
			stages: { kind: "unavailable", reason: "not_instrumented" },
			efficiency: v4.efficiency,
		}).row;

		for (const row of [synthetic(), v2, v3, roundZero, v5]) {
			const value = report([row], none, "2026-12-01T00:00:00Z");
			assert.equal(value.tickets[0]?.status, "unknown");
			assert.ok(
				value.unknowns.some(
					(entry) => entry.reason === "intervention_unreadable",
				),
			);
			assert.equal(value.primary.numerator, 0);

			const measured = computeMetrics({
				ledger: bytesOf([row]),
				repo,
				now: "2026-12-01T00:00:00Z",
				defects: none,
				interventions: new Map([
					[
						row.runId,
						{ kind: "known", value: false, source: "github_reviews" },
					],
				]),
			});

			assert.equal(measured.primary.numerator, 1);
			assert.equal(measured.tickets[0]?.status, "clean");
		}
	});

	for (const reference of [
		`github.com/${repo}/pull/622`,
		`www.github.com/${repo}/pull/622`,
		`http://github.com/${repo}/pull/622`,
		`https://www.github.com/${repo}/pull/622`,
		"GH-622",
		"PR#622",
		"#622",
	])
		it(`indexes the review's defect form ${reference}`, () => {
			const value = report([synthetic()], {
				kind: "known",
				issues: [defect(reference)],
			});

			assert.deepEqual(ticketOf(value).landings[0]?.defect, {
				kind: "linked",
				issues: [999],
			});
		});

	it("surfaces every labeled defect matching no included ticket without exporting text", () => {
		const value = report([synthetic()], {
			kind: "known",
			issues: [
				defect("private typo #99999"),
				{ ...defect("#100"), number: 998, labels: ["bug"] },
			],
		});

		const output = JSON.parse(JSON.stringify(value));
		assert.deepEqual(output.unmatchedDefects, [999]);
		assert.doesNotMatch(JSON.stringify(value), /private typo/);
	});

	it("reports casing and cross-repository exclusions separately (review probe)", () => {
		const value = computeMetrics({
			ledger: fixture,
			repo: "GiuseppeCRJ/pi-herdr-factorio",
			now: matureAt,
			defects: none,
		});

		const output = JSON.parse(JSON.stringify(value));
		assert.equal(output.excludedRowCounts.repoCasingMismatch, 26);
		assert.equal(output.excludedRowCounts.otherRepo, 0);

		const other = JSON.parse(
			JSON.stringify(
				computeMetrics({
					ledger: fixture,
					repo: "someone/else",
					now: matureAt,
					defects: none,
				}),
			),
		);

		assert.equal(other.excludedRowCounts.otherRepo, 26);
	});

	it("flags zero listed receipt digests instead of passing vacuously", () => {
		const row = synthetic();

		const value = computeMetrics({
			ledger: bytesOf([row]),
			repo,
			now: matureAt,
			defects: none,
			receiptDigests: new Map([[row.runId, new Set()]]),
		});

		assert.ok(
			value.unknowns.some(
				(entry) => entry.reason === "receipt_missing_or_changed",
			),
		);
		assert.equal(ticketOf(value).status, "unknown");
	});

	it("labels threshold flags includes immature runs without changing known-fact denominators", () => {
		const value = computeMetrics({
			ledger: fixture,
			repo,
			now: matureAt,
			defects: none,
		});

		const output = JSON.parse(JSON.stringify(value));
		assert.equal(
			output.deferred.contextPressure.promptCapHit.flagBasis,
			"includes immature runs",
		);
		assert.equal(
			output.deferred.restartEnded.flagBasis,
			"includes immature runs",
		);
		assert.equal(output.deferred.restartEnded.denominator, 12);
		assert.equal(output.deferred.restartEnded.threshold, 0.1);
	});

	it("indexes 1,000 landings and 1,000 in-window defects under two seconds (review bench)", (context) => {
		const ledger = bytesOf(
			Array.from({ length: 1000 }, (_, at) => synthetic(at + 1000)),
		);

		const issues = Array.from({ length: 1000 }, (_, at) => ({
			...defect(
				`${"x ".repeat(2000)} https://github.com/${repo}/issues/${at + 1000}`,
			),
			number: 90000 + at,
		}));

		const start = performance.now();

		const value = computeMetrics({
			ledger,
			repo,
			now: matureAt,
			defects: { kind: "known", issues },
		});

		const elapsed = performance.now() - start;
		context.diagnostic(
			`1000 landings + 1000 defects: ${elapsed.toFixed(2)} ms`,
		);
		assert.ok(elapsed < 2000, `${elapsed} ms exceeds 2 s`);
		assert.ok(
			value.tickets.every(
				(ticket) => ticket.landings[0]?.defect.kind === "linked",
			),
		);
	});
});

describe("dismissed review intervention", () => {
	const dismissed = (state = "changes_requested", review_id = 1) => ({
		event: "review_dismissed",
		actor: { login: "exe-dev-github-integration[bot]", type: "Bot" },
		dismissed_review: { review_id, state },
	});

	const reviews = [
		{
			id: 1,
			state: "DISMISSED",
			submitted_at: "2026-10-31T23:00:00Z",
			user: { login: "giuseppecrj", type: "User" },
		},
	];

	it("reproduces dismissed-pre-merge through the real command without counting it clean", async () => {
		await withLedger(async (path, dir) => {
			const bin = join(dir, "bin");
			mkdirSync(bin);
			const calls = join(dir, "calls.jsonl");
			writeFileSync(
				join(bin, "gh"),
				`#!/usr/bin/env node
const fs = require("node:fs");
const args = process.argv.slice(2);
fs.appendFileSync(${JSON.stringify(calls)}, JSON.stringify(args) + "\\n");
let result;
if (args[0] === "api" && args[1].includes("/labels/")) result = {name:"factory:defect"};
else if (args[0] === "api" && args[1].includes("/issues?labels=")) result = [];
else if (args[0] === "api" && /\\/reviews\\?per_page=100&page=1$/.test(args[1])) result = ${JSON.stringify(reviews)};
else if (args[0] === "api" && /\\/timeline\\?per_page=100&page=1$/.test(args[1])) result = ${JSON.stringify([dismissed()])};
else process.exit(3);
process.stdout.write(JSON.stringify(result));
`,
				{ mode: 0o755 },
			);

			const result = spawnSync(
				process.execPath,
				[
					new URL("../server/cli.ts", import.meta.url).pathname,
					...cliArgs(path),
				],
				{
					encoding: "utf8",
					env: { ...process.env, PATH: `${bin}:${process.env.PATH}` },
				},
			);

			assert.equal(result.status, 0, result.stderr);
			const output = JSON.parse(result.stdout);
			assert.equal(
				output.tickets[0].landings[0].intervention.value,
				true,
				`dismissed-pre-merge: ${output.tickets[0].status}, numerator=${output.primary.numerator}`,
			);
			assert.equal(output.tickets[0].status, "landed_not_clean");
			assert.equal(output.primary.numerator, 0);
			assert.equal(readFileSync(calls, "utf8").trim().split("\n").length, 4);
		});
	});

	for (const [name, state, submittedAt, user, expected] of [
		[
			"lowercase change request",
			"changes_requested",
			"2026-10-31T23:00:00Z",
			{ login: "owner", type: "User" },
			true,
		],
		[
			"uppercase change request",
			"CHANGES_REQUESTED",
			"2026-10-31T23:00:00Z",
			{ login: "owner", type: "User" },
			true,
		],
		[
			"dismissed approval",
			"approved",
			"2026-10-31T23:00:00Z",
			{ login: "owner", type: "User" },
			false,
		],
		[
			"dismissed comment",
			"commented",
			"2026-10-31T23:00:00Z",
			{ login: "owner", type: "User" },
			false,
		],
		[
			"request at merge",
			"changes_requested",
			mergedAt,
			{ login: "owner", type: "User" },
			false,
		],
		[
			"request after merge",
			"changes_requested",
			"2026-11-01T00:00:01Z",
			{ login: "owner", type: "User" },
			false,
		],
		[
			"bot request",
			"changes_requested",
			"2026-10-31T23:00:00Z",
			{ login: "github-actions[bot]", type: "Bot" },
			false,
		],
	] as const) {
		it(`measures ${name} from the original review, not the dismissal actor`, async () => {
			await withLedger(async (path) => {
				const value = await cli(cliArgs(path), async (_command, args) => ({
					code: 0,
					stderr: "",
					stdout: JSON.stringify(
						args[1]?.includes("/labels/")
							? { name: "factory:defect" }
							: args[1]?.includes("/reviews?")
								? [{ ...reviews[0], submitted_at: submittedAt, user }]
								: args[1]?.includes("/timeline?")
									? [dismissed(state)]
									: [],
					),
				}));

				const output = JSON.parse(value.stdout);
				assert.equal(
					output.tickets[0].landings[0].intervention.value,
					expected,
				);
				assert.equal(output.primary.numerator, expected ? 0 : 1);
			});
		});
	}

	for (const scenario of [
		"page-two",
		"exact-page",
		"failed",
		"partial",
		"saturated",
		"malformed",
		"unmatched-review",
	] as const) {
		it(`bounds and validates timeline reads: ${scenario}`, async () => {
			await withLedger(async (path) => {
				let pages = 0;

				const value = await cli(
					cliArgs(path),
					async (_command, args, options) => {
						let stdout = "[]";

						if (args[1]?.includes("/labels/"))
							stdout = '{"name":"factory:defect"}';

						if (args[1]?.includes("/reviews?"))
							stdout = JSON.stringify(reviews);

						if (args[1]?.includes("/timeline?")) {
							pages++;
							assert.deepEqual(args, [
								"api",
								`repos/${repo}/issues/622/timeline?per_page=100&page=${pages}`,
							]);
							assert.ok(
								options && options.timeoutMs > 0 && options.timeoutMs <= 30_000,
							);

							if (
								scenario === "failed" ||
								(scenario === "partial" && pages === 2)
							)
								return { code: 1, stdout: "[]", stderr: "private failure" };

							if (scenario === "malformed")
								stdout = JSON.stringify([
									{ event: "review_dismissed", dismissed_review: {} },
								]);
							else if (scenario === "unmatched-review")
								stdout = JSON.stringify([dismissed("changes_requested", 99)]);
							else if (scenario === "saturated" || pages === 1)
								stdout = JSON.stringify(
									Array.from({ length: 100 }, (_, at) =>
										scenario === "partial" && at === 0
											? dismissed()
											: { event: "labeled" },
									),
								);
							else
								stdout = JSON.stringify(
									scenario === "page-two" ? [dismissed()] : [],
								);
						}

						return { code: 0, stdout, stderr: "" };
					},
				);

				const output = JSON.parse(value.stdout);

				if (scenario === "page-two" || scenario === "exact-page") {
					assert.equal(
						output.tickets[0].landings[0].intervention.value,
						scenario === "page-two",
					);
					assert.equal(pages, 2);
				} else {
					assert.deepEqual(output.tickets[0].landings[0].intervention, {
						kind: "unknown",
						reason: "intervention_unreadable",
					});
					assert.equal(output.tickets[0].status, "unknown");
					assert.equal(output.primary.numerator, 0);
					assert.ok(pages > 0 && pages <= 10);
				}
			});
		});
	}

	for (const expireDuringDefects of [false, true]) {
		it(`limits all GitHub reads to 120 seconds, including defects=${expireDuringDefects}`, async (context) => {
			await withLedger(async (path) => {
				writeFileSync(
					path,
					bytesOf(
						Array.from({ length: 6 }, (_, at) => ({
							...synthetic(100 + at),
							pr: {
								number: 1000 + at,
								url: `https://github.com/${repo}/pull/${1000 + at}`,
							},
						})),
					),
				);

				let now = Date.parse(matureAt),
					calls = 0;

				context.mock.method(Date, "now", () => now);

				const value = await cli(
					cliArgs(path),
					async (_command, args, options) => {
						calls++;
						assert.ok(
							options && options.timeoutMs > 0 && options.timeoutMs <= 30_000,
						);

						if (expireDuringDefects) now += 60_000;
						else if (
							args[1]?.includes("/reviews?") ||
							args[1]?.includes("/timeline?")
						)
							now += 20_000;

						return {
							code: 0,
							stdout: args[1]?.includes("/labels/")
								? '{"name":"factory:defect"}'
								: "[]",
							stderr: "",
						};
					},
				);

				const output = JSON.parse(value.stdout);
				assert.ok(
					calls <= (expireDuringDefects ? 2 : 8),
					`${calls} GitHub reads exceed the report deadline`,
				);
				assert.equal(
					output.tickets.at(-1).landings[0].intervention.reason,
					"intervention_unreadable",
				);
				assert.equal(output.tickets.at(-1).status, "unknown");

				if (!expireDuringDefects)
					assert.equal(output.tickets[0].status, "clean");
				context.mock.restoreAll();
			});
		});
	}
});

describe("measured owner intervention", () => {
	const review = (
		state = "APPROVED",
		submitted_at = "2026-10-31T23:00:00Z",
		login = "a-non-writer",
	) => ({ state, submitted_at, user: { login }, body: "private review text" });

	const execWithReviews =
		(
			read: (args: readonly string[]) => {
				code: number;
				stdout: string;
				stderr: string;
			},
		): Exec =>
		async (command, args, options) => {
			assert.equal(command, "gh");
			assert.ok(
				options && options.timeoutMs > 0 && options.timeoutMs <= 30_000,
			);

			if (args[1]?.includes("/issues?labels="))
				return { code: 0, stdout: "[]", stderr: "" };

			if (args[1]?.includes("/labels/"))
				return { code: 0, stdout: '{"name":"factory:defect"}', stderr: "" };
			assert.match(
				args[1] ?? "",
				/^repos\/giuseppecrj\/pi-herdr-factorio\/(?:pulls\/\d+\/reviews|issues\/\d+\/timeline)\?per_page=100&page=\d+$/,
			);
			assert.deepEqual(args.slice(0, 1), ["api"]);
			assert.equal(args.length, 2);

			return args[1]?.includes("/timeline?")
				? { code: 0, stdout: "[]", stderr: "" }
				: read(args);
		};

	for (const [name, reviews, intervention] of [
		["zero reviews", [], false],
		["one approval", [review()], false],
		[
			"a non-writer change request before merge",
			[review("CHANGES_REQUESTED")],
			true,
		],
		[
			"a change request after merge",
			[review("CHANGES_REQUESTED", "2026-11-01T00:00:01Z")],
			false,
		],
		[
			"a change request at merge",
			[review("CHANGES_REQUESTED", mergedAt)],
			false,
		],
		[
			"the factory bot's change request",
			[
				review(
					"CHANGES_REQUESTED",
					"2026-10-31T23:00:00Z",
					"exe-dev-github-integration[bot]",
				),
			],
			false,
		],
		["a pending review", [{ ...review("PENDING"), submitted_at: null }], false],
	] as const) {
		it(`measures ${name} through the online CLI`, async () => {
			await withLedger(async (path) => {
				const value = await cli(
					cliArgs(path),
					execWithReviews(() => ({
						code: 0,
						stdout: JSON.stringify(reviews),
						stderr: "",
					})),
				);

				assert.equal(value.code, EXIT.ok, value.stderr);
				const output = JSON.parse(value.stdout);
				assert.deepEqual(output.tickets[0].landings[0].intervention, {
					kind: "known",
					value: intervention,
					source: "github_reviews",
				});
				assert.equal(
					output.tickets[0].status,
					intervention ? "landed_not_clean" : "clean",
				);
				assert.equal(output.primary.numerator, intervention ? 0 : 1);
				assert.equal(output.tokensPerCleanLanding, intervention ? null : 100);
				assert.equal(
					value.calls.filter((call) => call[2]?.includes("/reviews?")).length,
					1,
				);
				assert.doesNotMatch(value.stdout, /private review text|a-non-writer/);
			});
		});
	}

	it("reads subsequent pages before declaring no intervention and finds requests on page two", async () => {
		await withLedger(async (path) => {
			for (const second of [[], [review("CHANGES_REQUESTED")]]) {
				const value = await cli(
					cliArgs(path),
					execWithReviews((args) => ({
						code: 0,
						stdout: JSON.stringify(
							args[1]?.endsWith("page=1")
								? Array.from({ length: 100 }, () => review())
								: second,
						),
						stderr: "",
					})),
				);

				const output = JSON.parse(value.stdout);
				assert.equal(
					output.tickets[0].landings[0].intervention.value,
					second.length > 0,
				);
				assert.equal(output.primary.numerator, second.length > 0 ? 0 : 1);
				assert.equal(
					value.calls.filter((call) => call[2]?.includes("/reviews?")).length,
					2,
				);
			}
		});
	});

	it("never marks a failed, malformed, incomplete or saturated review read clean", async () => {
		await withLedger(async (path) => {
			for (const read of [
				() => ({ code: 1, stdout: "[]", stderr: "private failure" }),
				() => {
					throw new Error("private failure");
				},
				() => ({ code: 0, stdout: "[", stderr: "" }),
				() => ({ code: 0, stdout: "{}", stderr: "" }),
				() => ({
					code: 0,
					stdout: '[{"state":"CHANGES_REQUESTED"}]',
					stderr: "",
				}),
				() => ({
					code: 0,
					stdout: JSON.stringify([
						{ ...review("CHANGES_REQUESTED"), submitted_at: null },
					]),
					stderr: "",
				}),
				() => ({
					code: 0,
					stdout: JSON.stringify(Array.from({ length: 100 }, () => review())),
					stderr: "",
				}),
				(args: readonly string[]) => ({
					code: args[1]?.endsWith("page=1") ? 0 : 1,
					stdout: JSON.stringify(
						Array.from({ length: 100 }, () => review("CHANGES_REQUESTED")),
					),
					stderr: "private failure",
				}),
			]) {
				const value = await cli(cliArgs(path), execWithReviews(read));
				const output = JSON.parse(value.stdout);
				assert.equal(value.code, EXIT.ok);
				assert.deepEqual(output.tickets[0].landings[0].intervention, {
					kind: "unknown",
					reason: "intervention_unreadable",
				});
				assert.equal(output.tickets[0].status, "unknown");
				assert.equal(output.primary.numerator, 0);
				assert.ok(
					output.unknowns.some(
						(entry: { reason: string }) =>
							entry.reason === "intervention_unreadable",
					),
				);
				assert.ok(value.calls.length <= 12);
				assert.doesNotMatch(value.stdout, /private failure/);
			}
		});
	});

	it("keeps ledger-proven owner authorship and overrides as intervention despite a false fixture", () => {
		const v4 = rows[25];
		assert.ok(
			v4?.v === 4 &&
				v4.outcome.kind === "landed" &&
				v4.outcome.assurance.kind === "factory_verified",
		);

		const owner = ledgerRow({
			...v4,
			v: 5,
			outcome: {
				...v4.outcome,
				assurance: { ...v4.outcome.assurance, authored: "owner" },
			},
		}).row;

		const overridden = synthetic();
		assert.ok(overridden.outcome.kind === "landed");

		for (const row of [
			owner,
			{
				...overridden,
				outcome: {
					...overridden.outcome,
					assurance: { kind: "owner_override" as const },
				},
			},
		]) {
			const output = computeMetrics({
				ledger: bytesOf([row]),
				repo,
				now: "2026-12-01T00:00:00Z",
				defects: none,
				interventions: new Map([
					[row.runId, { kind: "known", value: false, source: "fixture" }],
				]),
			});

			assert.deepEqual(output.tickets[0]?.landings[0]?.intervention, {
				kind: "known",
				value: true,
				source: "ledger",
			});
			assert.equal(output.tickets[0]?.status, "landed_not_clean");
			assert.equal(output.primary.numerator, 0);
		}
	});

	it("withholds clean status when the merge time is unavailable", async () => {
		await withLedger(async (path) => {
			const row = synthetic();
			assert.ok(row.outcome.kind === "landed");

			for (const landing of [
				{
					...row,
					outcome: {
						...row.outcome,
						mergedAt: {
							kind: "unavailable" as const,
							reason: "public_metadata_unavailable" as const,
						},
					},
				},
			]) {
				writeFileSync(path, bytesOf([landing]));

				const value = await cli(
					cliArgs(path),
					execWithReviews(() => {
						throw new Error("must not read");
					}),
				);

				const output = JSON.parse(value.stdout);
				assert.deepEqual(output.tickets[0].landings[0].intervention, {
					kind: "unknown",
					reason: "intervention_unreadable",
				});
				assert.equal(output.primary.numerator, 0);
				assert.equal(value.calls.length, 2);
			}
		});
	});

	it("keeps intervention unknown offline, including file ledgers without a fixture override", async () => {
		await withLedger(async (path) => {
			const value = await cli([...cliArgs(path), "--offline"]);
			assert.deepEqual(value.calls, []);
			assert.deepEqual(
				JSON.parse(value.stdout).tickets[0].landings[0].intervention,
				{ kind: "unknown", reason: "intervention_unreadable" },
			);
		});
	});

	it("labels offline fixture overrides and refuses to use them with the real ledger or online", async () => {
		await withLedger(async (path, dir) => {
			const overrides = join(dir, "interventions.json");
			const args = [...cliArgs(path), "--intervention-file", overrides];

			for (const intervention of [false, true]) {
				writeFileSync(
					overrides,
					JSON.stringify({
						version: 1,
						landings: [{ runId: synthetic().runId, intervention }],
					}),
				);
				const value = await cli([...args, "--offline"]);
				assert.equal(value.code, EXIT.ok, value.stderr);
				const output = JSON.parse(value.stdout);
				assert.deepEqual(output.tickets[0].landings[0].intervention, {
					kind: "known",
					value: intervention,
					source: "fixture",
				});
				assert.equal(
					output.primary.numerator,
					0,
					"offline defects remain unknown",
				);
				assert.deepEqual(value.calls, []);
			}

			assert.equal((await cli(args)).code, EXIT.usage);

			const noFile = await cli([
				"metrics",
				"--json",
				"--repo",
				repo,
				"--offline",
				"--intervention-file",
				overrides,
			]);

			assert.equal(noFile.code, EXIT.usage);
			assert.deepEqual(noFile.calls, []);

			for (const content of [
				"not json",
				'{"version":2,"landings":[]}',
				'{"version":1,"landings":[{"runId":"bad","intervention":false}]}',
				JSON.stringify({
					version: 1,
					landings: [{ runId: synthetic().runId, intervention: "false" }],
				}),
			]) {
				writeFileSync(overrides, content);
				const value = await cli([...args, "--offline"]);
				assert.equal(value.code, EXIT.invalid);
				assert.equal(
					JSON.parse(value.stdout).error,
					"intervention_fixture_invalid",
				);
			}
		});
	});

	it("reads repaired landings independently of defect-query failure (real PR regressions)", async () => {
		await withLedger(async (path) => {
			writeFileSync(path, fixture);

			const value = await cli(
				["metrics", "--json", "--repo", repo, "--ledger-file", path],
				async (_command, args) => {
					if (args[1]?.includes("/labels/"))
						return { code: 1, stdout: "", stderr: "missing label" };

					if (args[1]?.includes("/timeline?"))
						return { code: 0, stdout: "[]", stderr: "" };
					assert.match(args[1] ?? "", /\/pulls\/(644|654)\/reviews\?/);

					return {
						code: 0,
						stdout: JSON.stringify([
							args[1]?.includes("/654/")
								? review("CHANGES_REQUESTED")
								: review(),
						]),
						stderr: "",
					};
				},
			);

			const output = JSON.parse(value.stdout);
			assert.equal(value.code, EXIT.ok);
			assert.equal(output.tickets[0].landings[0].intervention.value, false);
			assert.equal(output.tickets[1].landings[0].intervention.value, true);
			assert.ok(output.tickets[0].landings[0].reasons.includes("repair_round"));
			assert.ok(
				output.tickets[1].landings[0].reasons.includes("owner_intervention"),
			);
			assert.equal(value.calls.length, 5);
		});
	});

	it("deduplicates PR reads and skips excluded and non-landed runs", async () => {
		await withLedger(async (path) => {
			writeFileSync(
				path,
				bytesOf([
					synthetic(),
					synthetic(100, "101"),
					{
						...synthetic(101),
						outcome: { kind: "needs_info", stage: "specify" },
					},
					base,
				]),
			);

			const value = await cli(
				cliArgs(path),
				execWithReviews(() => ({ code: 0, stdout: "[]", stderr: "" })),
			);

			assert.equal(
				value.calls.filter((call) => call[2]?.includes("/reviews?")).length,
				1,
			);
			assert.equal(JSON.parse(value.stdout).primary.numerator, 1);
		});
	});

	it("reads and computes 1,000 distinct landed PRs with fake reads under two seconds", async (context) => {
		await withLedger(async (path) => {
			writeFileSync(
				path,
				bytesOf(
					Array.from({ length: 1000 }, (_, at) => ({
						...synthetic(at + 1000),
						pr: {
							number: at + 2000,
							url: `https://github.com/${repo}/pull/${at + 2000}`,
						},
					})),
				),
			);
			const start = performance.now();

			const value = await cli(
				cliArgs(path),
				execWithReviews(() => ({ code: 0, stdout: "[]", stderr: "" })),
			);

			const elapsed = performance.now() - start;
			context.diagnostic(
				`1000 landings with fake review reads: ${elapsed.toFixed(2)} ms`,
			);
			assert.equal(value.code, EXIT.ok, value.stderr);
			const output = JSON.parse(value.stdout);
			assert.equal(output.primary.numerator, 1000);
			assert.equal(output.primary.denominator, 1000);
			assert.equal(output.tokensPerCleanLanding, 100);
			assert.equal(value.calls.length, 2002);
			assert.ok(elapsed < 2000, `${elapsed} ms exceeds 2 s`);
		});
	});
});

describe("metrics CLI", () => {
	it("reads a real local ledger over 4 MiB without the old exec buffer failure", () => {
		const dir = mkdtempSync(join(tmpdir(), "metrics-git-"));

		try {
			mkdirSync(join(dir, "ledger"));
			writeFileSync(
				join(dir, "ledger/runs.jsonl"),
				bytesOf(Array.from({ length: 2500 }, (_, at) => synthetic(at + 1000))),
			);

			assert.ok(
				readFileSync(join(dir, "ledger/runs.jsonl")).length > 4 * 1024 * 1024,
			);

			for (const args of [
				["init", "-q"],
				["add", "ledger/runs.jsonl"],
				[
					"-c",
					"user.name=Test",
					"-c",
					"user.email=test@example.invalid",
					"-c",
					"commit.gpgsign=false",
					"commit",
					"-qm",
					"fixture",
				],
				["update-ref", "refs/remotes/origin/factory/ledger", "HEAD"],
			])
				assert.equal(spawnSync("git", args, { cwd: dir }).status, 0);

			const result = spawnSync(
				process.execPath,
				[
					new URL("../server/cli.ts", import.meta.url).pathname,
					"metrics",
					"--json",
					"--repo",
					repo,
					"--offline",
				],
				{ cwd: dir, encoding: "utf8", maxBuffer: 32 * 1024 * 1024 },
			);

			assert.equal(result.status, 0, result.stdout + result.stderr);
			assert.equal(JSON.parse(result.stdout).runs, 2500);
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});

	it("refuses future online --now while allowing offline historical calculations", async () => {
		await withLedger(async (path) => {
			const args = [...cliArgs(path), "--now", "2999-01-01T00:00:00Z"];

			const value = await cli(args, async (_command, argv) => ({
				code: 0,
				stdout: argv[0] === "api" ? '{"name":"factory:defect"}' : "[]",
				stderr: "",
			}));

			assert.equal(value.code, EXIT.invalid);
			assert.equal(JSON.parse(value.stdout).error, "now_after_defect_read");
			assert.equal((await cli([...args, "--offline"])).code, EXIT.ok);
		});
	});

	it("requires read-only confirmation of the exact defect label, even on an immature cohort", async () => {
		await withLedger(async (path) => {
			for (const result of [
				{ code: 0, stdout: "[]", stderr: "" },
				{ code: 0, stdout: '{"name":"factory:defects"}', stderr: "" },
				{ code: 1, stdout: "", stderr: "private" },
			]) {
				const value = await cli(cliArgs(path), async () => result);
				assert.deepEqual(JSON.parse(value.stdout).defectRead, {
					kind: "unknown",
					reason: result.code === 0 ? "label_missing" : "label_unreadable",
				});
				assert.deepEqual(value.calls, [
					["gh", "api", `repos/${repo}/labels/factory%3Adefect`],
					["gh", "api", `repos/${repo}/pulls/622/reviews?per_page=100&page=1`],
					...(result.stdout === "[]"
						? [
								[
									"gh",
									"api",
									`repos/${repo}/issues/622/timeline?per_page=100&page=1`,
								],
							]
						: []),
				]);
			}

			const thrown = await cli(cliArgs(path), async () => {
				throw new Error("private");
			});

			assert.deepEqual(JSON.parse(thrown.stdout).defectRead, {
				kind: "unknown",
				reason: "label_unreadable",
			});
		});
	});

	it("labels constructed ledger input as source file, with no mutation", async () => {
		await withLedger(async (path) => {
			const before = readFileSync(path);

			const value = await cli([
				...cliArgs(path).map((arg) =>
					arg === "--ledger" ? "--ledger-file" : arg,
				),
				"--offline",
			]);

			assert.equal(value.code, EXIT.ok);
			assert.equal(JSON.parse(value.stdout).source, "file");
			assert.deepEqual(readFileSync(path), before);
			assert.deepEqual(value.calls, []);
		});
	});
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

	it("confirms the defect label before a read-only issue query and validates the JSON", async () => {
		await withLedger(async (path) => {
			for (const stdout of ["[]", "{}", "[{}]", "not json"]) {
				const value = await cli(cliArgs(path), async (_command, args) => ({
					code: 0,
					stdout: args[1]?.includes("/labels/")
						? '{"name":"factory:defect"}'
						: stdout,
					stderr: "",
				}));

				assert.equal(value.code, EXIT.ok);
				assert.equal(value.calls.length, stdout === "[]" ? 4 : 3);
				assert.deepEqual(value.calls[2], [
					"gh",
					"api",
					`repos/${repo}/pulls/622/reviews?per_page=100&page=1`,
				]);
				assert.deepEqual(value.calls[0], [
					"gh",
					"api",
					`repos/${repo}/labels/factory%3Adefect`,
				]);
				assert.deepEqual(value.calls[1], [
					"gh",
					"api",
					`repos/${repo}/issues?labels=factory%3Adefect&state=all&sort=created&direction=asc&per_page=100&page=1`,
				]);
				assert.equal(
					JSON.parse(value.stdout).defectRead.kind,
					stdout === "[]" ? "known" : "unknown",
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
				async (_command: string, _args: readonly string[]) => ({
					code: 0,
					stdout: JSON.stringify(
						Array.from({ length: 100 }, () => ({
							...defect("#100"),
							created_at: defect("#100").createdAt,
							labels: [{ name: "factory:defect" }],
						})),
					),
					stderr: "",
				}),
			]) {
				const value = await cli(cliArgs(path), async (command, args) =>
					args[1]?.includes("/labels/")
						? { code: 0, stdout: '{"name":"factory:defect"}', stderr: "" }
						: exec(command, args),
				);

				assert.equal(value.code, EXIT.ok);
				assert.equal(JSON.parse(value.stdout).primary.numerator, 0);
				assert.equal(JSON.parse(value.stdout).status, "unknown");
				assert.equal(JSON.parse(value.stdout).defectRead.kind, "unknown");
				assert.notEqual(
					JSON.parse(value.stdout).defectRead.reason,
					"label_missing",
				);
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

			const exec: Exec = async (_command, args) => ({
				code: 0,
				stdout: args[1]?.includes("/labels/")
					? '{"name":"factory:defect"}'
					: "[]",
				stderr: "",
			});

			assert.equal(
				JSON.parse((await cli(args, exec)).stdout).tickets[0].status,
				"unknown",
			);
			const stage = join(dir, "stages", row.runId, "build-1", "draft");
			mkdirSync(stage, { recursive: true });
			writeFileSync(join(stage, "receipt.json"), receipt);
			assert.ok(
				!JSON.parse((await cli(args, exec)).stdout).unknowns.some(
					(entry: { reason: string }) =>
						entry.reason === "receipt_missing_or_changed",
				),
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
			const value = await cli(cliArgs(path), async (_command, args) => ({
				code: 0,
				stdout: args[1]?.includes("/labels/")
					? '{"name":"factory:defect"}'
					: args[1]?.includes("/issues?labels=")
						? JSON.stringify([
								{
									...defect("private words #100"),
									created_at: defect("private words #100").createdAt,
									labels: [{ name: "factory:defect" }],
								},
							])
						: "[]",
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
			[
				"metrics",
				"--json",
				"--repo",
				repo,
				"--ledger",
				"one",
				"--ledger-file",
				"two",
			],
			["metrics", "--json", "--repo", repo, "--ledger-file", ""],
		]) {
			const value = await cli(args);
			assert.equal(value.code, EXIT.usage);
			assert.deepEqual(value.calls, []);
		}
	});

	it("reports an explicit large-ledger limit error instead of using a partial read", async () => {
		const value = await cli(
			["metrics", "--json", "--repo", repo, "--offline"],
			async () => ({
				code: 1,
				stdout: bytesOf([synthetic()]).toString(),
				stderr: "metric_ledger_too_large",
			}),
		);

		assert.equal(value.code, EXIT.invalid);
		assert.deepEqual(JSON.parse(value.stdout), { error: "ledger_too_large" });
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

describe("read-only repository history", () => {
	const moved = "nublai/pi-herdr-factorio";
	const history = EXE_DEV_PLATFORM.historicalRepositories;

	const summary = (value: ReturnType<typeof computeMetrics>) => ({
		runs: value.runs,
		tokens: value.tokens,
		tickets: value.tickets.map(({ repo: _repo, ...ticket }) => ticket),
		excluded: value.excluded,
		unknowns: value.unknowns,
	});

	it("counts the frozen pre-move production rows under the new name only through the alias", () => {
		const old = computeMetrics({
			ledger: fixture,
			repo,
			now: matureAt,
			defects: none,
		});

		const aliased = computeMetrics({
			ledger: fixture,
			repo: moved,
			now: matureAt,
			defects: none,
			history,
		});

		const exact = computeMetrics({
			ledger: fixture,
			repo: moved,
			now: matureAt,
			defects: none,
		});

		assert.equal(old.runs, 12);
		assert.equal(old.tokens.total, 4_152_936);
		assert.equal(old.tokens.coverage, "lower_bound");
		assert.deepEqual(summary(aliased), summary(old));
		assert.equal(aliased.repo, moved);
		assert.deepEqual(aliased.historicalRepositories, [repo]);
		assert.deepEqual(aliased.excludedRowCounts, {
			otherRepo: 0,
			repoCasingMismatch: 0,
		});
		assert.equal(exact.runs, 0);
		assert.deepEqual(exact.historicalRepositories, []);
		assert.equal(exact.excludedRowCounts.otherRepo, 26);
	});

	it("matches a qualified defect reference written with the former name", () => {
		// Issue 625 is a landed production ticket in the preserved ledger.
		const landed = { issue: 625 };
		const reference = defect(`${repo}#${landed.issue}`);

		const aliased = computeMetrics({
			ledger: fixture,
			repo: moved,
			now: matureAt,
			defects: { kind: "known", issues: [reference] },
			history,
		});

		assert.deepEqual(aliased.unmatchedDefects, []);

		const exact = computeMetrics({
			ledger: fixture,
			repo: moved,
			now: matureAt,
			defects: { kind: "known", issues: [reference] },
		});

		assert.deepEqual(exact.unmatchedDefects, [999]);

		const stranger = computeMetrics({
			ledger: fixture,
			repo: moved,
			now: matureAt,
			defects: {
				kind: "known",
				issues: [defect(`acme/widgets#${landed.issue}`)],
			},
			history,
		});

		assert.deepEqual(stranger.unmatchedDefects, [999]);
	});

	it("real metrics CLI counts the preserved ledger under nublai and reads reviews at the new name", async () => {
		await withLedger(async (path) => {
			writeFileSync(path, fixture);

			const offline = await cli([
				"metrics",
				"--json",
				"--repo",
				moved,
				"--ledger-file",
				path,
				"--offline",
				"--now",
				matureAt,
			]);

			assert.equal(offline.code, EXIT.ok, offline.stderr);
			const output = JSON.parse(offline.stdout);
			assert.equal(output.runs, 12);
			assert.equal(output.tokens.total, 4_152_936);
			assert.deepEqual(output.historicalRepositories, [repo]);
			assert.equal(output.excludedRowCounts.otherRepo, 0);

			const online = await cli(
				["metrics", "--json", "--repo", moved, "--ledger-file", path],
				async (_command, args) => {
					assert.ok(
						(args[1] ?? "").startsWith(`repos/${moved}/`),
						args.join(" "),
					);

					if (args[1]?.includes("/labels/"))
						return { code: 1, stdout: "", stderr: "missing label" };

					if (args[1]?.includes("/timeline?"))
						return { code: 0, stdout: "[]", stderr: "" };

					return {
						code: 0,
						stdout: JSON.stringify([
							{
								state: "APPROVED",
								submitted_at: "2026-10-31T23:00:00Z",
								user: { login: "a-non-writer" },
								body: "review",
							},
						]),
						stderr: "",
					};
				},
			);

			assert.equal(online.code, EXIT.ok, online.stderr);
			const read = JSON.parse(online.stdout);
			assert.equal(read.runs, 12);
			assert.ok(
				read.tickets.some(
					(ticket: { landings: { intervention: { kind: string } }[] }) =>
						ticket.landings.some((l) => l.intervention.kind === "known"),
				),
			);
		});
	});
});
