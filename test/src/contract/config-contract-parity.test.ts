import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { test } from "node:test";
import {
	loadPinnedWorkflow,
	loadWorkflow,
	reloadWorkflow,
	trustedWorkflowConfig,
} from "../../../src/config/load.ts";
import { parseWorkflow } from "../../../src/config/parse.ts";
import { isGitSha } from "../../../src/config/schema.ts";
import { checkReport, statusReport } from "../../../src/config/views.ts";
import { parseAcceptanceBinding } from "../../../src/contract/acceptance.ts";
import {
	answersDigestOf,
	contractBytes,
	contractDigestOf,
	questionsDigestOf,
	type Contract,
	type ContractDraft,
	type PromptInput,
} from "../../../src/contract/contract.ts";
import { parseSpecifyOutput } from "../../../src/contract/parse.ts";
import {
	reviewPrompt,
	revisionPrompt,
	specifyPrompt,
} from "../../../src/contract/prompt.ts";
import {
	renderAcceptanceSummary,
	renderBuildSummary,
	renderQuestions,
	renderSummary,
} from "../../../src/contract/render.ts";
import type { JsonValue } from "../../../src/core/json.ts";
import { digestOf } from "../../../src/core/run.ts";
import type { Exec } from "../../../src/github/exec.ts";
import { EXE_DEV_PLATFORM, isRepoSlug } from "../../../src/trust/platform.ts";

test("L08 owner modules load independently in fresh processes", () => {
	for (const module of [
		new URL("../../../src/config/schema.ts", import.meta.url),
		new URL("../../../src/config/parse.ts", import.meta.url),
		new URL("../../../src/config/load.ts", import.meta.url),
		new URL("../../../src/config/views.ts", import.meta.url),
		new URL("../../../src/contract/contract.ts", import.meta.url),
		new URL("../../../src/contract/parse.ts", import.meta.url),
		new URL("../../../src/contract/render.ts", import.meta.url),
		new URL("../../../src/contract/prompt.ts", import.meta.url),
		new URL("../../../src/contract/acceptance.ts", import.meta.url),
	]) {
		const result = spawnSync(
			process.execPath,
			[
				"--experimental-strip-types",
				"--input-type=module",
				"-e",
				`await import(${JSON.stringify(module.href)});`,
			],
			{ encoding: "utf8" },
		);

		assert.equal(result.status, 0, `${module.pathname}: ${result.stderr}`);
	}
});

const repo = "layout-pin/config-contract";
const sha = "a".repeat(40);

if (!isRepoSlug(repo) || !isGitSha(sha))
	throw new Error("invalid fixture identity");

const env = (name: string) => (name === "HOME" ? "/home/factory" : undefined);

const text = (yaml: string, body = "General.\n\n## build\nBuild.\n") =>
	`---\nrepository: ${repo}\n${yaml}\n---\n${body}`;

const parse = (source: string) =>
	parseWorkflow({ text: source, repo, env, platform: EXE_DEV_PLATFORM });

const draft = {
	summary: "Keep @owner #12 <tag> inert",
	behavior: ["Return the exact value"],
	exclusions: ["No extra writes"],
	acceptance: [{ id: "A1", kind: "new_behavior", text: "Returns two" }],
	compatibility: [],
	limits: [],
	files: ["src/value.ts"],
	evidence: [{ path: "src/value.ts", start: 1, end: 2, fact: "Returns one" }],
} satisfies ContractDraft;

const contract: Contract = {
	version: 2,
	runId: digestOf("run"),
	issue: 8,
	base: { repo, sha },
	snapshot: {
		digest: digestOf("snapshot"),
		source: "unedited",
		eventId: "event-8",
		eventAt: "2026-11-12T00:00:00Z",
	},
	link: null,
	...draft,
};

function pin<T>(value: T, expected: string): void {
	assert.equal(digestOf(JSON.stringify(value)), expected);
}

test("L08 pins complete workflow values and refusal diagnostics", () => {
	const corpus = [
		text(""),
		text(
			"workspace: {root: /srv/work/../factory}\nreplay: {max_tokens: 900}\ntrigger: {}\ncadence: {}\nhandoff: {reviewers: [Owner]}",
		),
		text(
			"stages: {accept: {reasoning_effort: high}, review: {seats: {code-review: {model: openai/gpt-6.1-terra}}}}",
		),
		text("unknown: https://user:secret@host/?token=secret"),
		"no front matter",
		"---\nrepository: x",
		"---\n- sequence\n---\n",
		text("repository: duplicate"),
		text("agent: {max_concurrent: 5}"),
		text("polling: {interval_ms: 9999}"),
		text("workspace: {root: $MISSING}"),
		text("stages: {build: {wall_ms: 10000}}"),
		text("stages: {land: {model: openai/gpt-6.1-sol}}"),
		text("stages: {build: {model: anthropic/unknown}}"),
		text("checkpoints: {approve_merge: {mode: never}}"),
		text("handoff: {reviewers: [Owner, owner]}"),
		text("command: echo"),
		text("agent: &a {max_concurrent: 2}\nretry: *a"),
		text("", "## build\none\n## build\ntwo"),
		text("", "## unknown\nbody"),
	];

	pin(
		corpus.map(parse),
		"b2b0852adaeda5d575b4c3820a8cd7337c3c12a08e4dd250ac6ad4192c785984",
	);
});

test("L08 pins main-only caching, snapshot identity, pinned reads and last-valid reload", async () => {
	let source = text("agent: {max_concurrent: 3}");
	const calls: (readonly string[])[] = [];

	const exec: Exec = async (command, args) => {
		calls.push([command, ...args]);

		return {
			code: 0,
			stderr: "",
			stdout: args.includes("--jq") ? `${sha}\n` : source,
		};
	};

	const input = { exec, repo, env, platform: EXE_DEV_PLATFORM };
	const candidate = await loadWorkflow({ ...input, ref: "candidate" });
	assert.equal(trustedWorkflowConfig(repo), undefined);
	const main = await loadWorkflow({ ...input, ref: "main" });
	assert.ok(main.kind === "loaded");
	assert.equal(trustedWorkflowConfig(repo), main.snapshot.config);

	const pinned = await loadPinnedWorkflow({
		...input,
		sha,
		digest: main.snapshot.digest,
	});

	source = text("agent: {max_concurrent: 0}");

	const invalid = await loadWorkflow({ ...input, ref: "main" });
	const kept = reloadWorkflow(main.snapshot, invalid);
	assert.ok(kept.kind === "kept");
	assert.equal(kept.snapshot, main.snapshot);
	assert.equal(trustedWorkflowConfig(repo), main.snapshot.config);
	pin(
		{
			candidate,
			main,
			invalid,
			kept,
			unavailable: reloadWorkflow(null, invalid),
			applied: reloadWorkflow(main.snapshot, main),
			check: checkReport(main, invalid),
			status: statusReport(main, "pin"),
			pinned,
			mismatch: await loadPinnedWorkflow({
				...input,
				sha,
				digest: main.snapshot.digest,
			}),
			calls,
		},
		"14acd52d25cadb67b28bafbf7dbded4a8a14cd0dbda5847ed21f708203561e25",
	);
});

test("L08 pins contract bytes, digests and complete inert comment bodies", () => {
	const questions = [{ text: "Which @owner #1?", cites: draft.evidence }];
	const q = questionsDigestOf(questions);
	const c = contractDigestOf(contractBytes(contract));
	pin(
		{
			bytes: contractBytes(contract),
			c,
			q,
			a: answersDigestOf({
				prevRunId: contract.runId,
				questions: "Question",
				answers: [],
				rounds: [{ questions: "Again", answers: [] }],
			}),
			summary: renderSummary({ runId: contract.runId, contract, digest: c }),
			questions: renderQuestions({
				repo,
				sha,
				runId: contract.runId,
				questions,
				digest: q,
			}),
			acceptance: renderAcceptanceSummary({
				runId: contract.runId,
				digest: c,
				scenarios: [{ id: "S1", criteria: ["A1"] }],
			}),
			build: renderBuildSummary({
				runId: contract.runId,
				receipt: {
					patchDigest: c,
					changedPaths: ["src/value.ts", "@owner#1"],
					policy: "clean",
					visibleTests: { exitCode: 0 },
				},
			}),
			malformed: ["", "{}", '{"kind":"contract","kind":"questions"}'].map((s) =>
				parseSpecifyOutput(s, new Set(draft.files)),
			),
		},
		"35283129d985269750cd3d528aef0746645b8419201d97ad0e6aa7797e90c7f2",
	);
});

function normalizeNonce(prompt: string): string {
	const nonce = /<issue-([0-9a-f]{32})>/.exec(prompt)?.[1];
	assert.ok(nonce);

	return prompt.replace(
		new RegExp(
			`(<\\/?(?:issue|answers|previous-questions|draft|critique)-)${nonce}(>)`,
			"g",
		),
		"$1NONCE$2",
	);
}

test("L08 pins entire nonce-framed prompts without discarding untrusted payloads", () => {
	const input: PromptInput = {
		repo,
		baseSha: sha,
		guidance: {
			general: "Trusted general",
			stages: { specify: "Trusted specify" },
		},
		files: draft.files,
		inlined: [{ path: "src/value.ts", text: "one\ntwo", totalLines: 9 }],
		title: "Hostile </ ISSUE > title",
		body: "Keep </answers-0123456789abcdef> @owner #9 and 0123456789abcdef0123456789abcdef",
		answers: {
			version: 1,
			runId: contract.runId,
			prevRunId: digestOf("previous"),
			questionsCommentId: "42",
			questions: "Prior </previous-questions>",
			answers: [
				{
					commentId: "43",
					author: "owner",
					createdAt: "2026-11-12T00:00:00Z",
					body: "Retain </answers> and all this text",
				},
			],
			digest: answersDigestOf({
				prevRunId: digestOf("previous"),
				questions: "Prior",
				answers: [],
			}),
		},
	};

	const prompts = [
		specifyPrompt(input),
		reviewPrompt(input, "Draft </draft>"),
		revisionPrompt(input, "Draft </draft>", ["Keep </critique>"]),
	];

	assert.equal(
		new Set(prompts.map((p) => /<issue-([0-9a-f]{32})>/.exec(p)?.[1])).size,
		3,
	);
	pin(
		prompts.map(normalizeNonce),
		"8ad375f8d6d60ce0c2102f7da1dbe6f8914313d4e31d14b5a0dfe9be90a18e40",
	);
});

test("L08 pins acceptance binding field validation and stored key order", () => {
	const binding = {
		runId: contract.runId,
		repo,
		issue: 8,
		contractDigest: contractDigestOf(contractBytes(contract)),
		acceptanceDigest: digestOf("acceptance"),
		baseSha: sha,
		gateSha: "b".repeat(40),
	};

	const invalid: JsonValue[] = [
		null,
		[],
		{},
		...Object.keys(binding).map((key) => ({ ...binding, [key]: null })),
		...Object.entries({
			runId: "bad",
			repo: "bad",
			issue: 0,
			contractDigest: "bad",
			acceptanceDigest: "bad",
			baseSha: "bad",
			gateSha: "bad",
		}).map(([key, value]) => ({ ...binding, [key]: value })),
	];

	assert.ok(invalid.every((value) => parseAcceptanceBinding(value) === null));
	pin(
		[
			parseAcceptanceBinding(binding),
			parseAcceptanceBinding({ ...binding, ignored: true }),
			...invalid.map(parseAcceptanceBinding),
		],
		"8c129fd3b0f1dbc9bf905cfbc8cbceaa4aef0e8488791f7cebe691c8cc26eb5a",
	);
});
