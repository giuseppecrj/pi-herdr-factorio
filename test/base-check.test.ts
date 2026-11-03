import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import {
	mkdirSync,
	mkdtempSync,
	readFileSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { test } from "node:test";
import { writeAcceptance } from "../src/accept.ts";
import { parseSpecifyOutput } from "../src/specify.ts";

const criteria = [
	{ id: "A1", kind: "new_behavior" as const, text: "Return two" },
	{ id: "A2", kind: "preservation" as const, text: "Keep errors" },
] as const;

const suite = {
	version: 2,
	scenarios: [
		{ id: "S1", criteria: ["A1"], checks: ["one.test.mjs"], judge: null },
		{ id: "S2", criteria: ["A2"], checks: ["two.test.mjs"], judge: null },
	],
	files: ["one", "two"].map((n) => ({
		path: `${n}.test.mjs`,
		type: "node:test",
		content: "import {test} from 'node:test'; test('value',()=>{});",
	})),
};

test("v2 criteria are strict objects and suite kinds are derived with exclusive file ownership", () => {
	const draft = {
		kind: "contract",
		summary: "Two",
		behavior: ["Return two"],
		exclusions: [],
		acceptance: criteria.map(({ kind, text }) => ({ kind, text })),
		compatibility: [],
		limits: [],
		files: [],
		evidence: [],
	};

	assert.equal(
		parseSpecifyOutput(JSON.stringify(draft), new Set()).kind,
		"contract",
	);

	for (const acceptance of [
		["Return two"],
		[{ text: "Return two" }],
		[{ kind: "unknown", text: "Return two" }],
	])
		assert.equal(
			parseSpecifyOutput(JSON.stringify({ ...draft, acceptance }), new Set())
				.kind,
			"malformed",
		);

	const parsed = writeAcceptance(JSON.stringify(suite), {
		acceptance: [...criteria],
	});

	assert.equal(parsed.kind, "suite");

	if (parsed.kind !== "suite") return;
	assert.deepEqual(
		parsed.suite.scenarios.map((s) => s.kind),
		["new_behavior", "preservation"],
	);

	for (const scenarios of [
		[{ ...suite.scenarios[0], criteria: ["A1", "A2"] }],
		suite.scenarios.map((s) => ({ ...s, checks: ["one.test.mjs"] })),
		[
			{ ...suite.scenarios[0], checks: [], judge: "Review" },
			suite.scenarios[1],
		],
		[
			{ ...suite.scenarios[0], checks: ["one.test.mjs", "two.test.mjs"] },
			suite.scenarios[1],
		],
	])
		assert.equal(
			writeAcceptance(JSON.stringify({ ...suite, scenarios }), {
				acceptance: [...criteria],
			}).kind,
			"malformed",
		);
});

test("real trusted reporter distinguishes assertion cause, load and in-body errors without losing passing siblings", (t) => {
	const root = mkdtempSync(join(tmpdir(), "base-reporter-"));
	t.after(() => rmSync(root, { recursive: true, force: true }));
	mkdirSync(join(root, "tree"));
	const file = join(root, "tree", "shape.test.mjs");

	const run = (source: string) => {
		writeFileSync(file, source);

		try {
			return execFileSync(
				process.execPath,
				[
					"--test",
					"--test-reporter",
					resolve(".github/factory/gates/reporter.mjs"),
					file,
				],
				{
					encoding: "utf8",
					stdio: ["ignore", "pipe", "pipe"],
					env: { PATH: process.env.PATH, HOME: "/tmp" },
				},
			);
		} catch (e) {
			assert.ok(e instanceof Error && "stdout" in e);

			return String(e.stdout);
		}
	};

	const facts = JSON.parse(
		run(
			"import {test} from 'node:test'; import assert from 'node:assert/strict'; test('sibling',()=>{}); test('PRIVATE-TITLE',()=>assert.equal(1,2,'PRIVATE-ASSERTION'));",
		),
	);

	assert.equal(facts.complete, true);
	assert.equal(facts.failures[0].code, "ERR_ASSERTION");
	assert.equal(facts.failures[0].kind, "assertion");
	assert.match(facts.failures[0].message, /PRIVATE-ASSERTION/);
	assert.equal(facts.counts["shape.test.mjs"], 2);

	const runtime = JSON.parse(
		run(
			"import {test} from 'node:test'; test('runtime',()=>{throw new TypeError('broken')});",
		),
	);

	assert.equal(runtime.failures[0].kind, "runtime_error");
	const load = JSON.parse(run("throw new Error('load');"));
	assert.equal(load.failures[0].kind, "load_error");
	assert.ok(readFileSync(file, "utf8").includes("load"));
});
