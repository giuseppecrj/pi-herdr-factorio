import assert from "node:assert/strict";
import { test } from "node:test";
import { execFileSync } from "node:child_process";
import {
	mkdtempSync,
	mkdirSync,
	writeFileSync,
	rmSync,
	readFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import {
	assessBase,
	draftCheckFeedback,
	draftNeedsRevision,
	parseBaseReceipt,
	BASE_PROTOCOL_VERSION,
	type BaseEvidence,
	type TestFailure,
} from "../src/diagnosis.ts";
import { parseDraftDetails } from "../server/gates.ts";
import { controllerBaseChecker } from "../server/controller.ts";
import { digestOf } from "../src/run.ts";
import { contractDigestOf } from "../src/specify.ts";
import { isGitSha, isRepoSlug } from "../src/workflow.ts";

function evidence(
	kind: TestFailure["kind"],
	message: string,
	preservation = false,
): BaseEvidence {
	const sha = "a".repeat(40),
		repo = "owner/repo";
	assert.ok(isGitSha(sha) && isRepoSlug(repo));
	const file = "test/acceptance/7/checks/exact.test.mjs";
	const execution = {
		kind: "observed" as const,
		exitCode: 1,
		wallMs: 1,
		files: [
			{
				file,
				registered: 1,
				failures: [
					{
						file,
						name: "own test",
						kind,
						code: kind === "assertion" ? "ERR_ASSERTION" : null,
						message,
					},
				],
			},
		],
	};

	return {
		binding: {
			runId: digestOf("draft"),
			repo,
			issue: 7,
			contractDigest: contractDigestOf("contract"),
			acceptanceDigest: digestOf("suite"),
			baseSha: sha,
			gateSha: sha,
		},
		runtime: {
			runner: "old",
			node: "v",
			platform: "p",
			bwrap: "b",
			protocolDigest: digestOf("heldout-base-v2-3"),
		},
		startedAt: 1,
		finishedAt: 2,
		source: {
			kind: "ready",
			treeDigest: digestOf("tree"),
			lockDigest: digestOf("lock"),
			gatesDigest: digestOf("gate"),
		},
		execution,
		repeat: execution,
		scenarios: [
			{
				scenario: "S1",
				kind: preservation ? "preservation" : "new_behavior",
				mode: "checked",
				file,
				oracleKey: {
					contractScopeDigest: digestOf("c"),
					criteriaDigest: digestOf("r"),
					sourceDigest: digestOf("s"),
				},
			},
		],
	};
}

test("P6 literal and missing procs failures reach draft feedback; P7 silent pass needs revision", () => {
	for (const [kind, message, preservation, reason] of [
		[
			"assertion",
			"Expected values to be strictly equal: + 'readable' - 'available'",
			true,
			"preservation_failed",
		],
		[
			"runtime_error",
			"Cannot destructure property 'self' of 'input.procs' as it is undefined.",
			false,
			"base_non_assertion_failure",
		],
	] as const) {
		const feedback = draftCheckFeedback(
			assessBase(evidence(kind, message, preservation)).receipt,
			[],
			7,
		);
		assert.equal(feedback.reason, reason);
		assert.equal(feedback.verdict, "would_refuse");
		assert.match(
			feedback.files[0]?.failures[0]?.message ?? "",
			preservation ? /readable.*available/ : /input.procs/,
		);
		assert.equal(draftNeedsRevision(feedback), true);
	}

	const e = evidence("assertion", "red");
	assert.equal(
		draftCheckFeedback(assessBase(e).receipt, [], 7).files[0]?.suspect,
		false,
	);
	assert.ok(e.execution.kind === "observed");
	const passed = {
		...e.execution,
		exitCode: 0,
		files: e.execution.files.map((f) => ({ ...f, failures: [] })),
	};
	const silent = draftCheckFeedback(
		assessBase({ ...e, execution: passed, repeat: passed }).receipt,
		[],
		7,
	);
	assert.equal(silent.reason, "acceptance_not_reproduced");
	assert.equal(silent.files[0]?.registered, 1);
	assert.deepEqual(silent.files[0]?.failures, []);
	assert.equal(draftNeedsRevision(silent), true);
});

test("draft feedback keeps all files, bounds and sanitizes private text and frames", () => {
	const e = evidence("assertion", "red");
	assert.ok(e.execution.kind === "observed");
	const file = e.execution.files[0]!.file;
	const details = Array.from({ length: 4 }, () => ({
		file,
		name: "own test",
		kind: "assertion" as const,
		message: "<" + "x".repeat(500),
		causes: [
			"ReferenceError: missing /home/private/file",
			"ReferenceError: missing /home/private/file",
			"TypeError: " + "z".repeat(500),
			"Error: fourth",
		],
		at: [
			"/w/test/acceptance/7/checks/exact.test.mjs:68:9",
			"/tmp/private.mjs:1:1",
			"/w/src/private.ts:1:1",
			"node:internal:1:1",
		],
	}));
	const feedback = draftCheckFeedback(assessBase(e).receipt, details, 7);
	const failure = feedback.files[0]?.failures[0];
	assert.ok(failure);
	assert.ok(failure.message.length <= 300);
	assert.ok(
		failure.causes.length <= 3 && failure.causes.every((c) => c.length <= 200),
	);
	assert.deepEqual(failure.at, ["exact.test.mjs:68:9"]);
	assert.equal(feedback.files[0]?.suspect, true);
	assert.equal(draftNeedsRevision(feedback), true);
	assert.doesNotMatch(JSON.stringify(feedback), /\/home\/|\/tmp\/|\/w\//);
	const many = {
		...e,
		scenarios: Array.from({ length: 30 }, (_, i) => ({
			...e.scenarios[0]!,
			scenario: `S${i + 1}`,
		})),
	};
	const bounded = draftCheckFeedback(assessBase(many).receipt, details, 7);
	assert.ok(
		Buffer.byteLength(JSON.stringify(bounded).replaceAll("<", "\\u003c")) <=
			6144,
	);
	assert.ok(bounded.omitted > 0);
});

test("detail parser fails closed on missing, oversized, malformed, duplicate and unknown-kind reports", () => {
	const file = "test/acceptance/7/checks/exact.test.mjs";
	const good = {
		complete: true,
		invalid: false,
		truncated: false,
		failures: [
			{
				file,
				name: "own test",
				kind: "assertion",
				code: "ERR_ASSERTION",
				message: "red",
				causes: [],
				at: [],
			},
		],
	};
	assert.ok(parseDraftDetails(JSON.stringify(good), [file]) !== null);

	for (const text of [
		"",
		"{}",
		JSON.stringify(good) + "\n" + JSON.stringify(good),
		"x".repeat(1024 * 1024 + 1),
		JSON.stringify({ ...good, truncated: true }),
		JSON.stringify({
			...good,
			failures: [{ ...good.failures[0], kind: "unknown" }],
		}),
		JSON.stringify({
			...good,
			failures: [{ ...good.failures[0], file: "/home/private" }],
		}),
	])
		assert.equal(parseDraftDetails(text, [file]), null);
});

test("P7 minimal wrapped ReferenceError beyond the trusted head reaches detail feedback", (t) => {
	const root = mkdtempSync(join(tmpdir(), "draft-reporter-"));
	t.after(() => rmSync(root, { recursive: true, force: true }));
	const tree = join(root, "tree");
	mkdirSync(tree);
	const file = join(tree, "exact.test.mjs");
	writeFileSync(
		file,
		`import {test} from 'node:test'; import assert from 'node:assert/strict'; test('own test',()=>assert.fail('noise'.repeat(150)+'\\nReferenceError: readDurableAccounting is not defined\\n    at /w/test/acceptance/7/checks/exact.test.mjs:68:9'));`,
	);
	let stdout = "",
		stderr = "";

	try {
		stdout = execFileSync(
			process.execPath,
			[
				"--test",
				"--test-reporter",
				resolve(".github/factory/gates/reporter.mjs"),
				"--test-reporter-destination",
				"stdout",
				"--test-reporter",
				resolve("server/gates/draft-reporter.mjs"),
				"--test-reporter-destination",
				"stderr",
				file,
			],
			{ encoding: "utf8", env: { PATH: process.env.PATH } },
		);
	} catch (e) {
		assert.ok(e instanceof Error && "stdout" in e && "stderr" in e);
		stdout = String(e.stdout);
		stderr = String(e.stderr);
	}

	const trusted = JSON.parse(stdout);
	assert.equal(trusted.failures[0].kind, "assertion");
	assert.doesNotMatch(trusted.failures[0].message, /ReferenceError/);
	const detail = JSON.parse(stderr);
	assert.match(
		detail.failures[0].causes.join("\n"),
		/ReferenceError: readDurableAccounting is not defined/,
	);
	const e = evidence("assertion", trusted.failures[0].message);
	const feedback = draftCheckFeedback(
		assessBase(e).receipt,
		detail.failures.map((f: object) => ({
			...f,
			file: "test/acceptance/7/checks/exact.test.mjs",
		})),
		7,
	);
	assert.match(
		JSON.stringify(feedback),
		/ReferenceError.*readDurableAccounting/,
	);
});

test("old protocol qualified receipt stays readable and controller never reruns it", async (t) => {
	const root = mkdtempSync(join(tmpdir(), "legacy-base-"));
	t.after(() => rmSync(root, { recursive: true, force: true }));
	const e = evidence("assertion", "legacy red");
	const receipt = assessBase(e).receipt,
		text = JSON.stringify(receipt);
	assert.deepEqual(parseBaseReceipt(text), receipt);
	assert.notEqual(BASE_PROTOCOL_VERSION, "heldout-base-v2-3");
	const dir = join(
		root,
		"base-check",
		e.binding.runId,
		digestOf(JSON.stringify(e.binding)),
		"a1",
	);
	mkdirSync(dir, { recursive: true });
	writeFileSync(join(dir, "result.json"), text);
	writeFileSync(join(dir, "result.digest"), digestOf(text));
	let fetches = 0;
	const checker = controllerBaseChecker({
		stateDir: root,
		fetch: async () => {
			fetches++;

			return null;
		},
	});
	const result = await checker.check({
		binding: e.binding,
		acceptAttempt: 1,
		remainingAcceptMs: 900000,
		signal: new AbortController().signal,
	});
	assert.equal(result.kind, "ready");
	assert.equal(fetches, 0);
	assert.equal(readFileSync(join(dir, "result.json"), "utf8"), text);
});
