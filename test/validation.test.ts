import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { verdictPasses, digestOf, REQUIRED_CI_CHECKS } from "../src/run.ts";
import {
	collectVerdict,
	collectTrustedReport,
	publishedSuite,
	matchesCiRun,
	parseCiRun,
	repairFeedback,
	type CiRun,
} from "../src/validation.ts";
import { acceptanceDigestOf, type AcceptanceSuite } from "../src/accept.ts";
import { CONTROLLER_LOGIN } from "../src/markers.ts";
import { isGitSha } from "../src/workflow.ts";
import { passingVerdict, patch } from "./helpers.ts";

const candidateSha = "c".repeat(40);
const gateSha = "a".repeat(40);

if (!isGitSha(candidateSha) || !isGitSha(gateSha)) throw new Error("fixture");

const run: CiRun = {
	id: 1,
	headSha: gateSha,
	headBranch: "main",
	completedAt: "2026-10-31T00:01:00Z",
	title: `gates ${candidateSha} nonce`,
	event: "workflow_dispatch",
	path: ".github/workflows/ci.yml",
	actor: CONTROLLER_LOGIN,
	triggeringActor: CONTROLLER_LOGIN,
	status: "completed",
	conclusion: "success",
	createdAt: "2026-10-31T00:00:00Z",
};

const receipt = {
	version: 2,
	gateSha,
	candidateSha,
	nonce: "nonce",
	modelCalls: 0,
	status: "passed",
	heldoutDigest: digestOf("checks"),
	requiredChecks: [...REQUIRED_CI_CHECKS],
	checks: REQUIRED_CI_CHECKS.map((name) => ({ name, exitCode: 0 })),
};

const binding = {
	run,
	nonce: "nonce",
	patchDigest: patch("a"),
	acceptanceDigest: digestOf("suite"),
	heldoutDigest: receipt.heldoutDigest,
	candidateSha,
	originalBase: gateSha,
	baseSha: gateSha,
	unjudged: ["S2"],
};

describe("reporter-owned candidate checks (unit transport)", () => {
	const verdict = collectVerdict({ ...binding, text: JSON.stringify(receipt) });
	const externalId = `factory-gates:${run.id}:nonce`;

	const record = {
		version: 1,
		status: "passed",
		checkId: 456,
		candidateSha,
		gateSha,
		runId: run.id,
		nonce: "nonce",
		workflow: ".github/workflows/ci.yml",
		event: "workflow_dispatch",
		ref: "refs/heads/main",
		actor: CONTROLLER_LOGIN,
		triggeringActor: CONTROLLER_LOGIN,
		externalId,
		heldoutDigest: receipt.heldoutDigest,
	};

	const check = {
		id: 456,
		name: "factory-gates",
		head_sha: candidateSha,
		app: { id: 15368 },
		external_id: externalId,
		status: "completed",
		conclusion: "success",
	};

	const input = {
		record,
		checks: { total_count: 1, check_runs: [check] },
		run,
		nonce: "nonce",
		verdict,
	};

	it("binds the reporter's own check ID and explicit external ID independently of nonce", () => {
		const report = collectTrustedReport(input);
		assert.ok(report);
		assert.equal(report.reportId, check.id);
		assert.notEqual(report.externalId, report.nonce);
	});

	for (const field of [
		"status",
		"candidateSha",
		"gateSha",
		"runId",
		"nonce",
		"workflow",
		"event",
		"ref",
		"actor",
		"triggeringActor",
		"externalId",
		"heldoutDigest",
		"checkId",
	])
		it(`refuses changed reporter identity ${field}`, () => {
			assert.equal(
				collectTrustedReport({
					...input,
					record: { ...record, [field]: "wrong" },
				}),
				null,
			);
		});

	for (const conclusion of ["skipped", "cancelled", "failure", null])
		it(`refuses check ${conclusion}`, () => {
			assert.equal(
				collectTrustedReport({
					...input,
					checks: { total_count: 1, check_runs: [{ ...check, conclusion }] },
				}),
				null,
			);
		});
	it("rejects default Actions GUIDs, wrong app, incomplete results and duplicate same-named checks", () => {
		for (const changed of [
			{ ...check, id: 457 },
			{ ...check, app: { id: 7 } },
			{ ...check, external_id: "actions-guid" },
			{ ...check, head_sha: gateSha },
		])
			assert.equal(
				collectTrustedReport({
					...input,
					checks: { total_count: 1, check_runs: [changed] },
				}),
				null,
			);
		assert.equal(
			collectTrustedReport({
				...input,
				checks: { total_count: 2, check_runs: [check] },
			}),
			null,
		);
		assert.equal(
			collectTrustedReport({
				...input,
				checks: { total_count: 2, check_runs: [check, { ...check, id: 457 }] },
			}),
			null,
		);
		assert.equal(
			collectTrustedReport({ ...input, verdict: { ...verdict, pass: false } }),
			null,
		);
	});
});

const suite: AcceptanceSuite = {
	version: 1,
	scenarios: [
		{ id: "S1", criteria: ["A1"], checks: ["a.test.ts"], judge: null },
		{ id: "S2", criteria: ["A2"], checks: [], judge: "Readability" },
	],
	files: [
		{
			path: "a.test.ts",
			type: "node:test",
			content: "test('secret title',()=>{assert.ok(true)})",
		},
	],
};

const canary = `factory-holdout-${"0".repeat(64)}`;

describe("bound validation verdicts", () => {
	it("does not accept an empty check set", () => {
		assert.equal(
			verdictPasses({ ...passingVerdict(patch("a")), checks: [] }),
			false,
		);
	});
	it("does not accept missing required checks", () => {
		assert.equal(
			verdictPasses({
				...passingVerdict(patch("a")),
				checks: [{ name: "typecheck", passed: true }],
			}),
			false,
		);
	});
	it("binds every identity and leaves judge criteria unjudged", () => {
		const verdict = collectVerdict({
			...binding,
			text: JSON.stringify(receipt),
		});

		assert.equal(verdictPasses(verdict), true);
		assert.equal(verdict.candidateSha, candidateSha);
		assert.equal(verdict.gateSha, gateSha);
		assert.deepEqual(verdict.unjudged, ["S2"]);
	});

	for (const altered of [
		{
			requiredChecks: receipt.requiredChecks.filter(
				(name) => name !== "heldout",
			),
			checks: receipt.checks.filter((check) => check.name !== "heldout"),
		},
		{ checks: [...receipt.checks, { name: "extra", exitCode: 0 }] },
		{ checks: [] },
		{ requiredChecks: [] },
		{ checks: receipt.checks.slice(1) },
		{ checks: [...receipt.checks, receipt.checks[0]] },
		{ gateSha: "b".repeat(40) },
		{ candidateSha: "b".repeat(40) },
		{ heldoutDigest: digestOf("changed") },
		{ nonce: "other" },
		{ version: 1 },
		{ status: "incomplete" },
		{ status: "failed" },
		{ modelCalls: 1 },
		{
			checks: receipt.checks.map((check) =>
				check.name === "heldout" ? { ...check, exitCode: 1 } : check,
			),
		},
	])
		it(`fails closed on ${JSON.stringify(altered)}`, () => {
			assert.equal(
				collectVerdict({
					...binding,
					text: JSON.stringify({ ...receipt, ...altered }),
				}).pass,
				false,
			);
		});

	for (const conclusion of [
		"cancelled",
		"skipped",
		"timed_out",
		"failure",
		null,
	])
		it(`does not pass conclusion ${conclusion}`, () => {
			assert.equal(
				collectVerdict({
					...binding,
					run: { ...run, conclusion },
					text: JSON.stringify(receipt),
				}).pass,
				false,
			);
		});
	it("requires a completed run even with a success conclusion", () => {
		assert.equal(
			collectVerdict({
				...binding,
				run: { ...run, status: "in_progress" },
				text: JSON.stringify(receipt),
			}).pass,
			false,
		);
	});
	it("refuses a gate revision different from the candidate base", () => {
		assert.equal(
			collectVerdict({
				...binding,
				baseSha: candidateSha,
				text: JSON.stringify(receipt),
			}).pass,
			false,
		);
	});
	it("refuses a missing or malformed receipt", () => {
		for (const text of [
			null,
			"{}",
			"{",
			JSON.stringify({ checks: [], requiredChecks: [] }),
		])
			assert.equal(collectVerdict({ ...binding, text }).pass, false);
	});
	it("authenticates the run event, path, actors, nonce and creation time", () => {
		assert.equal(
			matchesCiRun(
				run,
				binding.candidateSha,
				"nonce",
				Date.parse(run.createdAt),
			),
			true,
		);

		for (const altered of [
			{ headBranch: "other" },
			{ event: "push" },
			{ path: ".github/workflows/check.yml" },
			{ actor: "human" },
			{ triggeringActor: "human" },
			{ title: "wrong nonce" },
			{ createdAt: "2000-01-01T00:00:00Z" },
		])
			assert.equal(
				matchesCiRun(
					{ ...run, ...altered },
					binding.candidateSha,
					"nonce",
					Date.parse(run.createdAt),
				),
				false,
			);
		assert.equal(parseCiRun({ id: 1, head_sha: "bad" }), null);
	});
});

it("collection itself refuses a receipt from the wrong run actor or workflow", () => {
	for (const change of [
		{ actor: "human" },
		{ headBranch: "other" },
		{ event: "push" },
		{ path: ".github/workflows/check.yml" },
	])
		assert.equal(
			collectVerdict({
				...binding,
				run: { ...run, ...change },
				text: JSON.stringify(receipt),
			}).pass,
			false,
		);
});

describe("published held-out bytes and repair feedback", () => {
	it("publishes checks only and binds exact private bytes", () => {
		const result = publishedSuite({
			issue: 42,
			suite,
			canary,
			acceptanceDigest: acceptanceDigestOf(suite, canary),
		});

		assert.deepEqual(
			result.files.map((f) => f.path),
			["test/acceptance/42/checks/a.test.ts"],
		);
		assert.match(
			Buffer.from(result.files[0]?.bytes ?? []).toString(),
			/factory-holdout-/,
		);
		assert.throws(
			() =>
				publishedSuite({
					issue: 42,
					suite,
					canary,
					acceptanceDigest: digestOf("wrong"),
				}),
			/acceptance_changed/,
		);
	});
	it("does not pass a judge-only suite without executable files", () => {
		const empty: AcceptanceSuite = { ...suite, files: [] };
		assert.throws(
			() =>
				publishedSuite({
					issue: 42,
					suite: empty,
					canary,
					acceptanceDigest: acceptanceDigestOf(empty, canary),
				}),
			/empty_checks/,
		);
	});
	it("maps only failed files to criterion IDs and texts, never test titles or source", () => {
		const feedback = repairFeedback(
			suite,
			{
				acceptance: [
					{ id: "A1", text: "The approved behavior" },
					{ id: "A2", text: "Readable" },
				],
			},
			["test/acceptance/42/checks/a.test.ts", "outside.test.ts"],
			"test/acceptance/42",
		);

		assert.deepEqual(feedback, [
			{
				scenario: "S1",
				criteria: [{ id: "A1", text: "The approved behavior" }],
			},
		]);
		assert.doesNotMatch(
			JSON.stringify(feedback),
			/secret|assert|test\.ts|Readability/,
		);
	});
});
