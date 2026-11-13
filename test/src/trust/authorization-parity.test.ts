import assert from "node:assert/strict";
import {
	mkdirSync,
	mkdtempSync,
	readFileSync,
	rmSync,
	symlinkSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { test } from "node:test";
import {
	collectPatch,
	prepareRepairTree,
	publicationTree,
} from "../../../src/candidate/build.ts";
import {
	classifyFeedback,
	feedbackId,
	type FeedbackEvent,
} from "../../../src/candidate/feedback.ts";
import { parseSeat, reviewSeats } from "../../../src/candidate/review.ts";
import {
	formatStageTable,
	nextStage,
	STAGE_PROFILES,
} from "../../../src/candidate/stages.ts";
import { parseCheckFeedback } from "../../../src/candidate/validation.ts";
import { isGitSha } from "../../../src/config/schema.ts";
import { parseSpecifyOutput } from "../../../src/contract/parse.ts";
import { acceptanceSourcePath } from "../../../src/contract/prompt.ts";
import { digestOf } from "../../../src/core/run.ts";
import {
	EXECUTION_STAGES,
	isStage,
	MODEL_STAGES,
	SANDBOX_STAGES,
	STAGE_ORDER,
	type ExecutionStage,
	type ModelStage,
	type SandboxStage,
	type Stage,
} from "../../../src/core/stages.ts";
import { cadenceEligiblePath } from "../../../src/maintenance/cadence.ts";
import { isRepoSlug } from "../../../src/trust/platform.ts";
import { checkChangedPaths } from "../../../src/trust/policy.ts";

type Same<A, B> = [A] extends [B] ? ([B] extends [A] ? true : false) : false;

const stageTypes = {
	run: true,
	model: true,
	sandbox: true,
	execution: true,
} satisfies {
	run: Same<
		Stage,
		"admit" | "specify" | "accept" | "build" | "validate" | "review" | "land"
	>;
	model: Same<ModelStage, "specify" | "accept" | "build" | "review">;
	sandbox: Same<
		SandboxStage,
		| "admit"
		| "specify"
		| "accept"
		| "build"
		| "validate"
		| "review"
		| "land"
		| "maintain"
	>;
	execution: Same<
		ExecutionStage,
		"specify" | "accept" | "build" | "review" | "maintain"
	>;
};

const paths = [
	"src/a.ts",
	".github/CODEOWNERS",
	".GitHub/actions/a.yml",
	"test/acceptance/x.test.ts",
	"TEST/ACCEPTANCE/x.test.ts",
	"test/acceptance",
	"test/acceptance-other/x.test.ts",
	"docs/.github/x.ts",
	".factory-feedback.json",
	".factory-feedback-full.json",
	".factory-feedback-full.json/x",
	"test\\acceptance\\x.test.ts",
	"./test/acceptance/x.test.ts",
	"test/../src/a.ts",
	"test/acceptance/../a.test.ts",
];

const forbidden = [
	false,
	true,
	true,
	true,
	true,
	true,
	false,
	false,
	true,
	true,
	true,
	true,
	true,
	true,
	true,
];

const hiddenInline = [
	false,
	false,
	false,
	true,
	true,
	true,
	false,
	false,
	false,
	false,
	false,
	true,
	true,
	false,
	false,
];

const hiddenFact = [
	false,
	false,
	false,
	true,
	true,
	true,
	false,
	false,
	false,
	false,
	false,
	false,
	false,
	false,
	true,
];

const cadence = [
	true,
	true,
	true,
	false,
	false,
	true,
	true,
	true,
	true,
	true,
	true,
	false,
	false,
	false,
	false,
];

const acceptance = [
	true,
	false,
	false,
	false,
	false,
	false,
	true,
	false,
	false,
	false,
	false,
	false,
	false,
	false,
	false,
];

const repo = "nublai/pi-herdr-factorio";
const head = "a".repeat(40);

assert.ok(isRepoSlug(repo) && isGitSha(head));

function scratch(t: { after(fn: () => void): void }) {
	const root = mkdtempSync(join(tmpdir(), "authorization-parity-"));
	t.after(() => rmSync(root, { recursive: true, force: true }));

	const base = join(root, "base"),
		workspace = join(root, "workspace");

	mkdirSync(base);
	mkdirSync(workspace);

	return { root, base, workspace };
}

function put(root: string, path: string, text = "value\n") {
	mkdirSync(dirname(join(root, path)), { recursive: true });
	writeFileSync(join(root, path), text);
}

test("L04 pins each path caller without equating their authority", async () => {
	const comments = paths.map((path, i) => ({
		id: feedbackId(repo, "review-comment", i + 1),
		path,
		line: 1,
		commit: head,
		inReplyTo: null,
		body: `private-or-public-${i}`,
	}));

	const event: FeedbackEvent = {
		kind: "review",
		id: feedbackId(repo, "review", 1),
		pr: 1,
		actor: "writer",
		at: "2026-11-12T00:00:00Z",
		state: "CHANGES_REQUESTED",
		commit: head,
		body: "",
		comments,
	};

	const classified = await classifyFeedback({
		runId: digestOf("L04"),
		pr: 1,
		head,
		events: [event],
		seen: [],
		controllerLogin: "bot",
		permission: async () => "write",
	});

	assert.ok(classified.kind === "read" && classified.batch);
	const cards = classified.batch.cards;

	for (const [i, path] of paths.entries()) {
		assert.equal(
			checkChangedPaths({ changedPaths: [path] }).kind === "forbidden",
			forbidden[i],
			`build ${path}`,
		);
		assert.equal(
			cards.some((card) => card.path === path),
			!hiddenInline[i],
			`inline ${path}`,
		);

		const fact = parseCheckFeedback([{ check: "lint", file: path }], {
			changedPaths: [path],
			heldoutDir: "private/checks",
		});

		assert.equal(fact === null, hiddenFact[i], `fact ${path}`);

		const seat = parseSeat(
			JSON.stringify({
				seat: "code-review",
				findings: [
					{
						id: "F1",
						severity: "blocking",
						category: "bug",
						path,
						startLine: 1,
						endLine: 1,
						claim: "Concrete failure",
						evidence: "Observed failure",
					},
				],
				judgments: [],
			}),
			"code-review",
			new Map([[path, 1]]),
			[],
		);

		assert.equal(seat === null, forbidden[i], `review ${path}`);
		assert.equal(cadenceEligiblePath(path), cadence[i], `cadence ${path}`);
		assert.equal(
			acceptanceSourcePath(path),
			acceptance[i],
			`acceptance ${path}`,
		);
	}

	assert.equal(classified.full, null);
	assert.equal(
		checkChangedPaths({
			changedPaths: ["test/acceptance/x.ts"],
			acceptanceDir: "oracle",
		}).kind,
		"clean",
	);
	assert.equal(
		checkChangedPaths({
			changedPaths: ["ORACLE/x.ts"],
			acceptanceDir: "oracle",
		}).kind,
		"forbidden",
	);
	assert.equal(
		parseCheckFeedback([{ check: "lint", file: "private/checks/x.ts" }], {
			changedPaths: ["private/checks/x.ts"],
			heldoutDir: "private/checks",
		}),
		null,
	);
});

test("L04 excludes held-out inline text from truncated full feedback too", async () => {
	const result = await classifyFeedback({
		runId: digestOf("L04 full"),
		pr: 1,
		head,
		seen: [],
		controllerLogin: "bot",
		permission: async () => "write",
		events: [
			{
				kind: "review",
				id: feedbackId(repo, "review", 2),
				pr: 1,
				actor: "writer",
				at: "2026-11-12T00:00:00Z",
				state: "CHANGES_REQUESTED",
				commit: head,
				body: "visible ".repeat(2000),
				comments: [
					{
						id: feedbackId(repo, "review-comment", 2),
						path: "TEST\\acceptance\\secret.test.ts",
						line: 1,
						commit: head,
						inReplyTo: null,
						body: "HELDOUT_CANARY",
					},
				],
			},
		],
	});

	assert.ok(result.kind === "read" && result.batch && result.full);
	assert.ok(result.batch.cards.some((card) => card.truncated));
	assert.doesNotMatch(JSON.stringify(result), /HELDOUT_CANARY/);
});

test("L04 pins build collection and publication for protected rename endpoints", async (t) => {
	for (const path of [
		".github/a.ts",
		"test/acceptance/a.ts",
		".factory-feedback.json",
		".factory-feedback-full.json",
	]) {
		for (const direction of ["into", "out of"]) {
			const f = scratch(t);
			put(f.base, direction === "into" ? "src/a.ts" : path);
			put(f.workspace, direction === "into" ? path : "src/a.ts");
			const patch = await collectPatch(f);
			assert.ok(patch.kind === "collected");
			assert.equal(patch.policy, "forbidden", `${direction} ${path}`);
			assert.deepEqual(patch.changedPaths, [path, "src/a.ts"].sort());
			await assert.rejects(
				publicationTree(
					f.base,
					join(f.root, "publish"),
					patch.patch,
					patch.changedPaths,
				),
				/forbidden_paths/,
			);
		}
	}
});

test("L04 pins symlink and repair-tree boundaries", async (t) => {
	for (const path of [
		".github",
		"test/acceptance",
		".factory-feedback-full.json",
		"src/link.ts",
	]) {
		const f = scratch(t);
		put(f.base, "src/a.ts");
		put(f.workspace, "src/a.ts");
		mkdirSync(dirname(join(f.workspace, path)), { recursive: true });
		symlinkSync(
			path === "src/link.ts" ? "a.ts" : "src",
			join(f.workspace, path),
		);
		const result = await collectPatch(f);

		if (path === ".github")
			assert.deepEqual(result, { kind: "error", reason: "unsafe_symlink" });
		else {
			assert.ok(result.kind === "collected");
			assert.equal(
				result.policy,
				path === "src/link.ts" ? "clean" : "forbidden",
			);

			if (result.policy === "forbidden")
				await assert.rejects(
					publicationTree(
						f.base,
						join(f.root, "publish"),
						result.patch,
						result.changedPaths,
					),
					/forbidden_paths/,
				);
		}
	}

	const f = scratch(t);
	put(f.base, "TEST/Acceptance/hidden.ts", "CANARY");
	put(f.base, "src/a.ts");
	await prepareRepairTree(f.base, f.workspace, "", [], "{}");
	assert.throws(
		() => readFileSync(join(f.workspace, "TEST/Acceptance/hidden.ts")),
		/ENOENT/,
	);
	assert.equal(readFileSync(join(f.workspace, "src/a.ts"), "utf8"), "value\n");
});

test("L04 pins acceptance replacement decisions separately from source selection", () => {
	for (const [path, allowed] of [
		["test/a.test.ts", true],
		["test/acceptance/a.test.ts", false],
		["test/Acceptance/a.test.ts", true],
		["test/acceptance-other/a.test.ts", true],
	] as const) {
		const parsed = parseSpecifyOutput(
			JSON.stringify({
				kind: "contract",
				summary: "Preserve behavior",
				behavior: ["Keep behavior"],
				exclusions: ["No new authority"],
				acceptance: [{ kind: "preservation", text: "Same behavior" }],
				compatibility: ["Keep API"],
				limits: ["No new dependencies"],
				files: [path],
				evidence: [],
				replacesTests: [{ path, reason: "Replace the test" }],
			}),
			new Set([path]),
		);

		assert.equal(parsed.kind === "contract", allowed, path);
	}
});

test("L04 pins stage order, model and sandbox subsets and every next-stage result", () => {
	assert.deepEqual(stageTypes, {
		run: true,
		model: true,
		sandbox: true,
		execution: true,
	});
	assert.deepEqual(STAGE_ORDER, [
		"admit",
		"specify",
		"accept",
		"build",
		"validate",
		"review",
		"land",
	]);
	assert.deepEqual(MODEL_STAGES, ["specify", "accept", "build", "review"]);
	assert.deepEqual(Object.keys(STAGE_PROFILES), [
		"admit",
		"specify",
		"accept",
		"build",
		"validate",
		"review",
		"maintain",
		"land",
	]);
	assert.deepEqual(STAGE_ORDER.map(nextStage), [
		"specify",
		"accept",
		"build",
		"validate",
		"review",
		"land",
		undefined,
	]);

	for (const stage of [
		"admit",
		"specify",
		"accept",
		"build",
		"validate",
		"review",
		"land",
		"maintain",
		"repair",
		"score",
		"BUILD",
		"",
	])
		assert.equal(
			isStage(stage),
			!["maintain", "repair", "score", "BUILD", ""].includes(stage),
			stage,
		);
	assert.deepEqual(
		STAGE_ORDER.filter((stage) => STAGE_PROFILES[stage].runsIn === "sandbox"),
		["specify", "accept", "build", "review"],
	);
	assert.equal(formatStageTable().split("\n").length, 8);
});

test("L04 gives both extracted homes their inherited review seats and exact subsets", () => {
	for (const path of ["src/trust/protected-paths.ts", "src/core/stages.ts"]) {
		assert.deepEqual(
			reviewSeats([path]),
			["code-review", "security-review", "simplify", "ultrareview"],
			path,
		);
	}

	assert.deepEqual(SANDBOX_STAGES, [
		"admit",
		"specify",
		"accept",
		"build",
		"validate",
		"review",
		"land",
		"maintain",
	]);
	assert.deepEqual(EXECUTION_STAGES, [
		"specify",
		"accept",
		"build",
		"review",
		"maintain",
	]);
});

test("L04 pins existing review routing before classifying the extractions", () => {
	assert.deepEqual(reviewSeats(["src/trust/policy.ts"]), [
		"code-review",
		"security-review",
		"simplify",
		"ultrareview",
	]);
	assert.deepEqual(reviewSeats(["src/core/run.ts"]), [
		"code-review",
		"security-review",
		"simplify",
		"ultrareview",
	]);
	assert.deepEqual(reviewSeats([".github/CODEOWNERS"]), [
		"code-review",
		"security-review",
		"simplify",
	]);
	assert.deepEqual(reviewSeats(["test/acceptance/a.ts"]), [
		"code-review",
		"security-review",
		"simplify",
	]);
});
