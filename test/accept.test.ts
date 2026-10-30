import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { acceptancePrompt, writeAcceptance } from "../src/accept.ts";
import { digestOf } from "../src/run.ts";
import { renderAcceptanceSummary, acceptanceKey } from "../src/specify.ts";
import type { Contract } from "../src/specify.ts";
import { isGitSha, isRepoSlug } from "../src/workflow.ts";

const repo = "giuseppecrj/pi-herdr-factorio";
const sha = "a".repeat(40);

if (!isRepoSlug(repo) || !isGitSha(sha)) throw new Error("fixture");

const contract: Contract = {
	version: 1,
	runId: digestOf("run"),
	issue: 1,
	base: { repo, sha },
	snapshot: {
		digest: digestOf("snapshot"),
		source: "unedited",
		eventId: "1",
		eventAt: "2026-10-30T00:00:00Z",
	},
	link: null,
	summary: "Version",
	behavior: ["Print version"],
	acceptance: [
		{ id: "A1", text: "Print version" },
		{ id: "A2", text: "Reject invalid input" },
	],
	exclusions: [],
	compatibility: [],
	limits: [],
	files: ["src/version.ts"],
	evidence: [],
};

const suite = {
	version: 1,
	scenarios: [
		{ id: "S1", criteria: ["A1"], checks: ["version.test.ts"], judge: null },
		{ id: "S2", criteria: ["A2"], checks: ["version.test.ts"], judge: null },
	],
	files: [
		{
			path: "version.test.ts",
			type: "node:test",
			content:
				"import { test } from 'node:test';\ntest('version', () => {});\n",
		},
	],
};

describe("held-out acceptance output", () => {
	it("publishes only validated IDs and mappings through the shared renderer", () => {
		const digest = digestOf("suite");

		const body = renderAcceptanceSummary({
			runId: contract.runId,
			digest,
			scenarios: suite.scenarios,
		});

		assert.ok(body?.includes("S1: A1"));
		assert.ok(
			body?.includes("context-isolated, same family, not cross-family"),
		);
		assert.ok(body?.trimEnd().endsWith(acceptanceKey(contract.runId, digest)));

		for (const privateText of [
			suite.files[0]?.content ?? "bad",
			"version.test.ts",
			"/state/",
			"canary",
		])
			assert.ok(!body?.includes(privateText));
	});
	it("validates every criterion and the complete file manifest", () => {
		const parsed = writeAcceptance(JSON.stringify(suite), contract);
		assert.equal(parsed.kind, "suite");
	});
	it("rejects empty, malformed, duplicate-key and unbound output", () => {
		for (const text of [
			"",
			"{}",
			"not json",
			'{"version":1,"version":1}',
			JSON.stringify({ ...suite, scenarios: [] }),
			JSON.stringify({ ...suite, scenarios: [suite.scenarios[0]] }),
			JSON.stringify({ ...suite, files: [] }),
			JSON.stringify({ ...suite, extra: "ignored?" }),
		]) {
			assert.equal(writeAcceptance(text, contract).kind, "malformed", text);
		}
	});
	it("rejects paths, types, sizes, duplicate identities and orphan files", () => {
		for (const path of [
			"../escape.test.ts",
			"/tmp/test.ts",
			"a/../../b.test.ts",
			".git/a.test.ts",
			"a\\b.test.ts",
			"a//b.test.ts",
			"canary.txt",
			"a.test.ts/child.test.ts",
		]) {
			assert.equal(
				writeAcceptance(
					JSON.stringify({ ...suite, files: [{ ...suite.files[0], path }] }),
					contract,
				).kind,
				"malformed",
				path,
			);
		}

		for (const change of [
			{ files: [{ ...suite.files[0], type: "symlink" }] },
			{ files: [{ ...suite.files[0], content: " " }] },
			{ files: [{ ...suite.files[0], content: "a".repeat(65537) }] },
			{ files: [...suite.files, suite.files[0]] },
			{ scenarios: [suite.scenarios[0], suite.scenarios[0]] },
			{
				scenarios: [
					{ ...suite.scenarios[0], criteria: ["A100"] },
					suite.scenarios[1],
				],
			},
			{
				scenarios: [
					{ ...suite.scenarios[0], checks: [], judge: null },
					suite.scenarios[1],
				],
			},
		])
			assert.equal(
				writeAcceptance(JSON.stringify({ ...suite, ...change }), contract).kind,
				"malformed",
			);
	});
	it("allows an explicit judge for non-executable criteria, never an uncovered criterion", () => {
		assert.equal(
			writeAcceptance(
				JSON.stringify({
					...suite,
					scenarios: [
						suite.scenarios[0],
						{
							id: "S2",
							criteria: ["A2"],
							checks: [],
							judge: "Review the error wording",
						},
					],
				}),
				contract,
			).kind,
			"suite",
		);
	});
	it("gets only contract, trusted base map and named files, without issue or earlier sessions", () => {
		const prompt = acceptancePrompt({
			contract,
			files: ["src/version.ts"],
			inlined: [
				{
					path: "src/version.ts",
					text: "export const version = 1;",
					totalLines: 1,
				},
			],
			guidance: {
				general: "GENERAL-GUIDANCE",
				stages: { accept: "ACCEPT-GUIDANCE", specify: "SPECIFY-GUIDANCE" },
			},
		});

		assert.ok(prompt.includes("GENERAL-GUIDANCE"));
		assert.ok(prompt.includes("ACCEPT-GUIDANCE"));
		assert.ok(!prompt.includes("SPECIFY-GUIDANCE"));
		assert.ok(prompt.includes("Repository map:\nsrc/version.ts"));

		assert.ok(prompt.includes('"id":"A1"'));
		assert.ok(prompt.includes(sha));
		assert.ok(prompt.includes("export const version"));
		assert.ok(!prompt.includes("eventAt"));
		assert.ok(!prompt.includes("snapshot"));
		assert.ok(!prompt.includes("runId"));
		assert.ok(!prompt.includes("/state/acceptance/"));
	});
});
