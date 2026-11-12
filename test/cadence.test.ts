import assert from "node:assert/strict";
import {
	copyFileSync,
	cpSync,
	existsSync,
	mkdirSync,
	mkdtempSync,
	readFileSync,
	readdirSync,
	renameSync,
	rmSync,
	statSync,
	lstatSync,
	symlinkSync,
	writeFileSync,
} from "node:fs";
import { createServer } from "node:http";
import { createServer as createUnixServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { gunzipSync } from "node:zlib";
import { setTimeout as delay } from "node:timers/promises";
import { describe, it, type TestContext } from "node:test";
import { execFile, runCli, type ControllerRuntime } from "../server/cli.ts";
import {
	controllerCadence,
	publishCadenceProposals,
	runImprovementTrigger,
} from "../server/controller/cadence.ts";
import { procTable } from "../server/controller/lock.ts";
import { fileRunFiles } from "../server/controller/run-files.ts";
import {
	durableUsageOf,
	readDurableAccounting,
} from "../server/controller/terminal.ts";
import {
	launchSandbox,
	sandboxExecutor,
	sandboxHost,
	withSkills,
} from "../server/sandbox.ts";
import { detectArch } from "../server/sandbox/seccomp.ts";
import { listScopesArgv } from "../server/sandbox/scope.ts";
import { startGatewayProcess } from "../server/sandbox/gateway-client.ts";
import { manifestDigest } from "../server/sandbox/manifest.ts";
import { arrayOf, objectOf, parseJson } from "../src/core/json.ts";
import { fileAdmissionStore, snapshotDigest } from "../src/trust/admission.ts";
import {
	CadenceRunner,
	CADENCE_RETAIN_EXECUTIONS,
	CADENCE_PATH_GROUPS,
	CADENCE_EXCERPT_BYTES,
	CADENCE_FILE_BYTES,
	CADENCE_SKILLS,
	cadenceExcerpt,
	cadenceEligiblePath,
	cadenceCodeStart,
	cadencePrompt,
	cadenceCharges,
	cadenceExecutionDir,
	cadenceIssueBody,
	cadenceSkills,
	reflectionCitation,
	triggerProposal,
	triggerRecord,
	cadenceScope,
	cadenceWindow,
	parseCadenceProposals,
	utcWeekStart,
	writeCadenceFile,
	type CadenceInput,
	type CadenceResult,
	type CadenceTick,
} from "../src/maintenance/cadence.ts";
import { cadenceMarker } from "../src/trust/markers.ts";
import {
	enqueueScore,
	unreviewedFailures,
	reflectScores,
} from "../src/maintenance/scorers.ts";
import { parseLedger, type ScoreEvent } from "../src/ledger/schema.ts";
import { measurementPrimary } from "../src/views/metrics.ts";
import { Orchestrator } from "../src/controller/orchestrator.ts";
import { digestOf } from "../src/core/run.ts";
import { isGitSha, type CadenceJob } from "../src/config/schema.ts";
import { parseWorkflow } from "../src/config/parse.ts";
import { loadWorkflow } from "../src/config/load.ts";
import { isRepoSlug } from "../src/trust/platform.ts";
import type { Exec, ExecResult } from "../src/github/exec.ts";
import { EXE_DEV_PLATFORM } from "../src/trust/platform.ts";
import { controllerEnv, noPlatformFile } from "./helpers.ts";
import { nativeUserScope } from "./native-scope.ts";

function repository() {
	const value = "nublai/pi-herdr-factorio";
	assert.ok(isRepoSlug(value));

	return value;
}

async function admitClaim(stateDir: string, issue: number) {
	const snapshot = { title: "Retained ticket", body: "Local admission" };
	const store = fileAdmissionStore(stateDir);
	assert.equal(
		await store.record(
			{
				repo,
				issue,
				issueUrl: `https://github.com/${repo}/issues/${issue}`,
				decision: "admitted",
				reasons: [],
				eventId: "1",
				eventAt: "2026-11-10T00:00:00Z",
				actor: "giuseppecrj",
				actorPermission: "write",
				snapshotDigest: snapshotDigest(snapshot),
				snapshotSource: "unedited",
				baseSha: sha,
				workflowDigest: digestOf(workflow),
			},
			snapshot,
		),
		"recorded",
	);
	assert.equal((await store.read({ repo, issue, eventId: "1" })).kind, "found");
}

function revision() {
	const value = "a".repeat(40);
	assert.ok(isGitSha(value));

	return value;
}

const repo = repository();
const sha = revision();

const now = Date.parse("2026-11-10T12:00:00Z");
const workflow = `---\nrepository: ${repo}\nworkspace:\n  root: /workspace\ncadence: {}\n---\n`;

const parsed = parseWorkflow({
	platform: EXE_DEV_PLATFORM,
	text: workflow,
	repo,
	env: (name) => process.env[name],
});

assert.equal(parsed.kind, "valid");

if (parsed.kind !== "valid" || parsed.config.cadence == null)
	throw new Error("fixture policy");

const config = parsed.config.cadence;

const tick: CadenceTick = {
	now,
	allowed: true,
	capacity: 2,
	config,
	workflowSha: sha,
	workflowDigest: digestOf(workflow),
};

function directory(t: TestContext): string {
	const dir = mkdtempSync(join(tmpdir(), "c11-"));
	t.after(() => rmSync(dir, { recursive: true, force: true }));

	return dir;
}

function input(
	job: CadenceJob = "architecture",
	windowStart = cadenceWindow(now, config.jobs[job]),
	rotation = 0,
): CadenceInput {
	const identity = `cadence/${job}/${windowStart}`;

	return {
		version: 1,
		repo,
		job,
		identity,
		runId: digestOf(JSON.stringify([repo, identity])),
		windowStart,
		chargedWeek: utcWeekStart(now),
		rotation,
		baseSha: sha,
		workflowSha: sha,
		workflowDigest: digestOf(workflow),
		settings: config.jobs[job],
	};
}

function finding(execution = input(), key = "first") {
	return {
		job: execution.job,
		repo,
		baseSha: sha,
		fingerprint: "new",
		title:
			key === "first"
				? "A duplicated policy decision"
				: `Another decision ${key}`,
		claim:
			"The callers disagree about the same invariant; consolidate that decision and test the interface.",
		evidence: [
			{
				path: `${cadenceScope(execution.rotation)[0]}/example.ts`,
				start: 1,
				end: 2,
			},
		],
		limits: "Only the rotating group was read; runtime behavior is unknown.",
		provenance: "architecture skill at 59db609; Strong",
	};
}

function result(
	execution = input(),
	proposals = [finding(execution)],
): CadenceResult {
	return {
		kind: "passed",
		tokens: 16,
		exact: true,
		model: execution.settings.model,
		receiptDigest: digestOf("native receipt fixture"),
		output: JSON.stringify({ proposals }),
		reason: "passed",
	};
}

function seed(
	stateDir: string,
	execution = input(),
	completed: CadenceResult | null = result(execution),
): string {
	const dir = cadenceExecutionDir(
		stateDir,
		execution.job,
		execution.windowStart,
	);

	mkdirSync(join(dir, "tree", cadenceScope(execution.rotation)[0] ?? "src"), {
		recursive: true,
		mode: 0o700,
	});
	writeCadenceFile(join(dir, "input.json"), JSON.stringify(execution));
	writeCadenceFile(
		join(dir, "excerpt.json"),
		JSON.stringify({
			files: [
				{
					path: finding(execution).evidence[0]!.path,
					ranges: [{ start: 1, end: 2 }],
				},
			],
		}),
	);

	if (completed !== null)
		writeCadenceFile(join(dir, "receipt.json"), JSON.stringify(completed));
	writeFileSync(
		join(dir, "tree", finding(execution).evidence[0]!.path),
		"export const first = 1;\nexport const second = 2;\n",
		{ mode: 0o600 },
	);

	return dir;
}

type RemoteIssue = {
	number: number;
	title: string;
	body: string;
	labels: { name: string }[];
	state: string;
	updated_at: string;
	user: { login: string };
	state_reason?: string;
};

class GitHubFixture {
	issues: RemoteIssue[] = [];
	ready: RemoteIssue[] = [];
	enabled = true;
	labelName = "factory:enabled";
	unknown = false;
	listFails = false;
	creates = 0;
	requests: readonly string[][] = [];
	beforeCreate: (() => void) | null = null;
	workflowSource = workflow;

	readonly exec: Exec = async (command, args) => {
		if (command !== "gh") return execFile(command, args, 30_000);
		this.requests = [...this.requests, [...args]];

		const ok = (value: string): ExecResult => ({
			code: 0,
			stdout: value,
			stderr: "",
		});

		const endpoint = args.find((arg) => arg.startsWith("repos/")) ?? "";

		if (args.includes("graphql"))
			return ok(
				JSON.stringify({
					data: { viewer: { login: "exe-dev-github-integration[bot]" } },
				}),
			);

		if (endpoint.includes("labels/"))
			return this.enabled
				? ok(JSON.stringify({ name: this.labelName }))
				: { code: 1, stdout: "", stderr: "HTTP 404" };

		if (endpoint.includes("git/ref/heads/main")) return ok(sha);

		if (endpoint.includes("contents/.github/factory/WORKFLOW.md"))
			return ok(this.workflowSource);

		if (endpoint.endsWith("/issues") && args.includes("POST")) {
			this.beforeCreate?.();
			this.creates++;

			const issue: RemoteIssue = {
				number: this.creates,
				title: args.find((arg) => arg.startsWith("title="))?.slice(6) ?? "",
				body: args.find((arg) => arg.startsWith("body="))?.slice(5) ?? "",
				labels: args
					.filter((arg) => arg.startsWith("labels[]="))
					.map((arg) => ({ name: arg.slice(9) })),
				state: "open",
				user: { login: "exe-dev-github-integration[bot]" },
				updated_at: "2026-11-10T12:00:00Z",
			};

			this.issues.push(issue);

			return this.unknown
				? { code: 1, stdout: "", stderr: "network timeout" }
				: ok(JSON.stringify({ number: issue.number }));
		}

		if (endpoint.includes("issues?") && endpoint.includes("state=all")) {
			const query = new URL(`https://fixture/${endpoint}`).searchParams;
			const page = Number(query.get("page") ?? 1);
			const size = Number(query.get("per_page") ?? 100);

			const issues = this.issues.filter(
				(issue) =>
					issue.user.login === query.get("creator") &&
					issue.labels.some((label) => label.name === "factory:proposed"),
			);

			return this.listFails
				? { code: 1, stdout: "", stderr: "HTTP 503" }
				: ok(JSON.stringify(issues.slice((page - 1) * size, page * size)));
		}

		if (endpoint.includes("issues?state=open"))
			return ok(JSON.stringify(this.ready));
		throw new Error(`unexpected GitHub fixture request ${args.join(" ")}`);
	};
}

function runner(
	stateDir: string,
	github = new GitHubFixture(),
	log: (event: string) => void = () => undefined,
) {
	const executor = sandboxExecutor({
		platform: EXE_DEV_PLATFORM,
		stateDir,
		exec: github.exec,
		xdgRuntimeDir:
			process.env.XDG_RUNTIME_DIR ?? `/run/user/${process.getuid?.()}`,
		root: join(stateDir, "absent-bundle"),
		log: () => undefined,
	});

	return controllerCadence({
		platform: EXE_DEV_PLATFORM,
		stateDir,
		repo,
		exec: github.exec,
		executor,
		log,
	});
}

async function settle(
	cadence: CadenceRunner,
	only: CadenceJob = "architecture",
	evaluation = tick,
): Promise<void> {
	await cadence.recover();
	cadence.tick(evaluation, only);
	await cadence.wait();
}

const improvementWorkflow = readFileSync(
	new URL("../.github/factory/WORKFLOW.md", import.meta.url),
	"utf8",
);

const improvementPolicy = parseWorkflow({
	platform: EXE_DEV_PLATFORM,
	text: improvementWorkflow,
	repo,
	env: (name) => process.env[name],
});

assert.equal(improvementPolicy.kind, "valid");

if (improvementPolicy.kind !== "valid")
	throw new Error("improvement fixture policy");

const improvementConfig = improvementPolicy.config;

function failingScore(
	seq: number,
	runId = digestOf(`trigger-run-${seq}`),
): ScoreEvent {
	return {
		id: digestOf(`trigger-score-${seq}`),
		scoredRunId: runId,
		scorerId: "outcome-quality",
		scorerDigest: digestOf("scorer"),
		inputDigest: digestOf("input"),
		includeChildren: false,
		label: "mismatched",
		score: 0,
		passingScore: 1,
		reasoning: "ledger.outcome",
		judgeModel: "openai/gpt-6.1-sol",
		judgeFamily: "openai",
		familyNote: "context-isolated, same family, not cross-family",
		usage: { tokens: 1, wallMs: 1, exact: true },
		supersedes: null,
		at: new Date(now - 1000 + seq).toISOString(),
		status: "scored",
		voided: null,
	};
}

function seedReflectionLedger(stateDir: string) {
	const line = parseLedger(
		readFileSync(
			new URL("fixtures/metrics/runs-2026-11-08.jsonl", import.meta.url),
		),
	).find((line) => line.kind === "known");

	assert.ok(line?.kind === "known");
	const dir = join(stateDir, "ledger", line.row.runId);
	mkdirSync(dir, { recursive: true, mode: 0o700 });
	writeFileSync(join(dir, "row.json"), line.bytes, { mode: 0o600 });

	return line.row;
}

function filesOf(root: string, relative = ""): Record<string, string> {
	return Object.fromEntries(
		readdirSync(join(root, relative), { withFileTypes: true }).flatMap(
			(entry) => {
				if (entry.name === ".git" || entry.name === "node_modules") return [];
				const path = join(relative, entry.name);

				return entry.isDirectory()
					? Object.entries(filesOf(root, path))
					: [
							[
								path,
								digestOf(
									Buffer.concat([
										Buffer.from(`${lstatSync(join(root, path)).mode}\0`),
										readFileSync(join(root, path)),
									]),
								),
							],
						];
			},
		),
	);
}

function checkoutHash() {
	return digestOf(
		JSON.stringify(filesOf(new URL("..", import.meta.url).pathname)),
	);
}

function proposalRequestsOnly(github: GitHubFixture) {
	for (const args of github.requests) {
		assert.equal(args[0], "api");

		const methodAt = args.findIndex(
			(arg) => arg === "--method" || arg === "-X",
		);

		const method = methodAt < 0 ? "GET" : args[methodAt + 1];
		const endpoint = args.find((arg) => arg.startsWith("repos/")) ?? "";
		const url = new URL(`https://fixture/${endpoint}`);

		const allowed =
			(method === "GET" &&
				(url.pathname === `/repos/${repo}/labels/factory%3Aenabled` ||
					(url.pathname === `/repos/${repo}/issues` &&
						url.searchParams.get("state") === "all" &&
						url.searchParams.get("labels") === "factory:proposed" &&
						url.searchParams.get("creator") ===
							"exe-dev-github-integration[bot]"))) ||
			(method === "POST" && endpoint === `repos/${repo}/issues`);

		assert.ok(allowed, `unexpected proposal request: ${args.join(" ")}`);

		if (method === "POST")
			assert.deepEqual(
				args.filter((arg) => arg.startsWith("labels[]=")),
				["labels[]=factory:proposed"],
			);
	}
}

describe("improvement proposals", () => {
	it("calibrates reflect with maximum ledger, scores, source and known-proposal context under its 36k default", async (t) => {
		const execution = {
			...input("reflect"),
			existingProposals: Array.from({ length: 100 }, () => ({
				fingerprint: digestOf("known"),
				title: "x".repeat(220),
				state: "open" as const,
				path: "src/example.ts",
			})),
		};

		const source = "export const value = 123456789;\n".repeat(1000);

		const excerpt = {
			...cadenceExcerpt(execution, ["src/example.ts"], () => source),
			reflection: {
				primary: measurementPrimary(directory(t), repo),
				ledger: {
					rows: [
						{
							runId: digestOf("row"),
							padding: "abcdef0123456789".repeat(1000),
						},
					],
				},
				scores: reflectScores(
					Array.from({ length: 100 }, (_, seq) => failingScore(seq)),
				),
			},
		};

		const prompt = await withSkills(
			new URL("..", import.meta.url).pathname,
			cadencePrompt(execution, ["src/example.ts"], "", excerpt),
			cadenceSkills("reflect"),
		);

		assert.ok(prompt);
		const estimate = Math.ceil(Buffer.byteLength(prompt) / 2.8) + 533;
		assert.ok(
			estimate + 10_000 + 4_000 < execution.settings.maxTokens,
			`reflect ${estimate} + 10000 answer + 4000 reasoning`,
		);
		assert.ok(Buffer.byteLength(JSON.stringify(excerpt.files)) <= 8192);
		assert.ok(
			Buffer.byteLength(JSON.stringify(excerpt.reflection.scores.events)) <=
				8192,
		);
		t.diagnostic(
			`reflect calibrated prompt ${estimate}; total ${estimate + 14_000}; headroom ${execution.settings.maxTokens - estimate - 14_000}`,
		);
	});

	it("counts distinct unreviewed failures, preserves age across failing re-scores, and clears only on a later pass", () => {
		const first = failingScore(1);

		const retry = {
			...failingScore(2, first.scoredRunId),
			supersedes: first.id,
		};

		const pass = {
			...failingScore(3, first.scoredRunId),
			score: 1,
			label: "matched",
			supersedes: retry.id,
		};

		const failed = {
			...failingScore(4),
			status: "failed" as const,
			score: null,
			label: null,
		};

		assert.deepEqual(
			unreviewedFailures([first, retry, failed], first.scorerId, new Set()),
			[first],
		);
		assert.deepEqual(
			unreviewedFailures([first, retry, pass], first.scorerId, new Set()),
			[],
		);
		assert.deepEqual(
			unreviewedFailures([first, pass, retry], first.scorerId, new Set()),
			[retry],
		);
		assert.deepEqual(
			unreviewedFailures([first], first.scorerId, new Set([first.scoredRunId])),
			[],
		);
		assert.deepEqual(unreviewedFailures([first], "other", new Set()), []);
	});

	it("fires at K or D exactly, keeps the cohort anchor stable, bounds evidence, and puts the primary metric first", (t) => {
		const stateDir = directory(t);
		const failures = Array.from({ length: 60 }, (_, seq) => failingScore(seq));

		const request = {
			repo,
			scorerId: "outcome-quality",
			failures: failures.slice(0, 24),
			k: 25,
			d: 7,
			now,
			primary: measurementPrimary(stateDir, repo),
		};

		assert.equal(triggerProposal(request), null);

		const count = triggerProposal({
			...request,
			failures: failures.slice(0, 25),
		});

		assert.ok(count);
		assert.equal(
			triggerProposal({ ...request, failures })?.fingerprint,
			count.fingerprint,
		);
		assert.equal(
			triggerProposal({ ...request, failures, now: now - 1 })?.key,
			count.key,
		);

		const age = {
			...request,
			failures: [failingScore(0)],
			now: Date.parse(failingScore(0).at) + 7 * 86_400_000,
		};

		assert.equal(triggerProposal({ ...age, now: age.now - 1 }), null);
		assert.ok(triggerProposal(age));
		assert.match(count.body, /^F12a clean landing share\\: unavailable/);
		assert.match(count.body, /may still be queued for publication/);
		assert.match(count.body, /omitted remainder.*another proposal/);
		assert.equal(
			triggerRecord(triggerProposal({ ...request, failures })!.body, repo)?.runs
				.length,
			50,
		);
		assert.equal(
			triggerRecord(
				count.body.replace("factory:trigger ", "forged:trigger "),
				repo,
			),
			null,
		);
	});

	it("validates ledger fields, event IDs and receipt digests against only the frozen excerpt", () => {
		const runId = digestOf("row");
		const event = failingScore(1);
		const receipt = digestOf("receipt");

		const reflection = {
			ledger: {
				rows: [
					{
						runId,
						outcome: { kind: "failed" },
						redactedReceiptDigests: [receipt],
					},
				],
			},
			scores: reflectScores([event]),
		};

		for (const path of [
			`ledger/${runId}/outcome.kind`,
			`scores/${event.id}`,
			`receipts/${receipt}`,
		])
			assert.equal(
				reflectionCitation({ path, start: 1, end: 1 }, reflection),
				true,
				path,
			);

		for (const path of [
			`ledger/${runId}/outcome.missing`,
			`ledger/${runId}/constructor`,
			`ledger/${digestOf("unseen")}/outcome`,
			`scores/${digestOf("unseen")}`,
			`receipts/${digestOf("unseen")}`,
		])
			assert.equal(
				reflectionCitation({ path, start: 1, end: 1 }, reflection),
				false,
				path,
			);
		assert.equal(
			reflectionCitation(
				{ path: `scores/${event.id}`, start: 1, end: 2 },
				reflection,
			),
			false,
		);
		assert.equal(
			reflectionCitation(
				{ path: `scores/${event.id}`, start: 1, end: 1 },
				undefined,
			),
			false,
		);
	});

	it("requires experiment fields and drops invented citations without writing outside proposal intent state", async (t) => {
		const stateDir = directory(t);
		const execution = input("reflect");
		const dir = seed(stateDir, execution, null);
		const score = failingScore(1);
		const row = seedReflectionLedger(stateDir);

		writeCadenceFile(
			join(dir, "excerpt.json"),
			JSON.stringify({
				files: [],
				reflection: { ledger: { rows: [row] }, scores: reflectScores([score]) },
			}),
		);

		const proposal = {
			...finding(execution),
			baseline: "Current failures are recorded.",
			change: "Test one bounded change.",
			keepOrReject: "Reject primary regression or missing evidence.",
			evidence: [
				{ path: `ledger/${row.runId}/outcome`, start: 1, end: 1 },
				{ path: `scores/${score.id}`, start: 1, end: 1 },
				{ path: `scores/${digestOf("invented")}`, start: 1, end: 1 },
			],
		};

		assert.equal(
			parseCadenceProposals(
				JSON.stringify({ proposals: [finding(execution)] }),
				execution,
			),
			null,
		);

		const proposals = parseCadenceProposals(
			JSON.stringify({ proposals: [proposal] }),
			execution,
		);

		assert.ok(proposals);
		const before = filesOf(stateDir);
		const checkoutBefore = checkoutHash();
		const github = new GitHubFixture();
		assert.equal(
			await publishCadenceProposals({
				platform: EXE_DEV_PLATFORM,
				stateDir,
				exec: github.exec,
				execution,
				result: result(execution),
				proposals,
			}),
			true,
		);
		assert.equal(github.creates, 1);
		assert.ok(
			existsSync(
				join(
					stateDir,
					"cadence/reflect/proposals",
					`filing-${execution.windowStart}.json`,
				),
			),
			"reflect diagnostics are keyed by window",
		);
		assert.doesNotMatch(
			github.issues[0]!.body,
			new RegExp(digestOf("invented")),
		);
		assert.match(
			github.issues[0]!.body,
			/^F12a clean landing share\\: unavailable/,
		);

		assert.deepEqual(
			Object.fromEntries(
				Object.entries(filesOf(stateDir)).filter(
					([path]) => !path.startsWith("cadence/reflect/proposals/"),
				),
			),
			before,
			"reflect changes no file outside proposal intent state, including deletions",
		);
		assert.deepEqual(github.issues[0]!.labels, [{ name: "factory:proposed" }]);
		assert.equal(
			checkoutHash(),
			checkoutBefore,
			"reflect never edits the repository checkout",
		);
		proposalRequestsOnly(github);
	});

	it("makes zero trigger GitHub calls for empty, below-threshold, passing or already-filed scores", async (t) => {
		for (const mode of ["empty", "below", "passed", "reviewed"]) {
			const stateDir = directory(t);
			const github = new GitHubFixture();
			let clock = now;

			const request = {
				platform: EXE_DEV_PLATFORM,
				stateDir,
				repo,
				exec: github.exec,
				config: improvementConfig,
				clock: () => clock,
				log: () => undefined,
			};

			const events = Array.from(
				{ length: mode === "empty" ? 0 : mode === "below" ? 24 : 25 },
				(_, seq) => failingScore(seq),
			);

			for (const event of events) enqueueScore(stateDir, event);

			if (mode === "passed") {
				for (const [seq, event] of events.entries())
					enqueueScore(stateDir, {
						...failingScore(100 + seq, event.scoredRunId),
						at: new Date(now).toISOString(),
						score: 1,
						label: "matched",
						supersedes: event.id,
					});
			}

			if (mode === "reviewed") {
				await runImprovementTrigger(request);
				assert.equal(github.creates, 1);
				github.issues[0]!.state = "closed";
				github.requests = [];
			}

			for (let tick = 0; tick < 11; tick++) {
				clock += 3_600_000;
				await runImprovementTrigger(request);
			}

			assert.deepEqual(github.requests, [], mode);
		}
	});

	it("uses current main trigger policy rather than an older terminal run's frozen config", async (t) => {
		const stateDir = directory(t);
		const github = new GitHubFixture();
		github.workflowSource = improvementWorkflow.replace(
			/trigger:\n  k: 25\n  d: 7\n/,
			"",
		);

		const load = () =>
			loadWorkflow({
				platform: EXE_DEV_PLATFORM,
				exec: github.exec,
				repo,
				ref: "main",
				env: (name) => process.env[name],
			});

		assert.equal((await load()).kind, "loaded");

		try {
			for (let seq = 0; seq < 25; seq++)
				enqueueScore(stateDir, failingScore(seq));
			github.requests = [];
			await runImprovementTrigger({
				platform: EXE_DEV_PLATFORM,
				stateDir,
				repo,
				exec: github.exec,
				config: improvementConfig,
				clock: () => now,
				log: () => undefined,
			});
			assert.deepEqual(
				github.requests,
				[],
				"main disabled the trigger; old run settings cannot re-enable it",
			);
			assert.equal(github.creates, 0);
		} finally {
			github.workflowSource = improvementWorkflow;
			assert.equal((await load()).kind, "loaded");
		}
	});

	it("rate-limits qualifying trigger reads hourly per scorer, including remote refusals", async (t) => {
		const stateDir = directory(t);
		const github = new GitHubFixture();
		github.enabled = false;
		let clock = now;

		const request = {
			platform: EXE_DEV_PLATFORM,
			stateDir,
			repo,
			exec: github.exec,
			config: improvementConfig,
			clock: () => clock,
			log: () => undefined,
		};

		for (let seq = 0; seq < 25; seq++)
			enqueueScore(stateDir, failingScore(seq));
		await runImprovementTrigger(request);
		assert.equal(github.requests.length, 1);
		github.enabled = true;

		for (let tick = 1; tick < 120; tick++) {
			clock = now + tick * 30_000;
			await runImprovementTrigger(request);
		}

		assert.equal(github.requests.length, 1);
		assert.equal(github.creates, 0);
		clock = now + 3_600_000;
		await runImprovementTrigger(request);
		assert.equal(github.creates, 1);

		for (let seq = 25; seq < 50; seq++)
			enqueueScore(stateDir, failingScore(seq));
		const reads = github.requests.length;
		await runImprovementTrigger(request);
		assert.equal(github.requests.length, reads);
		clock += 3_600_000;
		await runImprovementTrigger(request);
		assert.equal(github.creates, 1, "an open issue suppresses a second cohort");
		const reconciled = github.requests.length;
		await runImprovementTrigger(request);
		assert.equal(github.requests.length, reconciled);
		github.issues[0]!.state = "closed";
		clock += 3_600_000;
		await runImprovementTrigger(request);
		assert.equal(
			github.creates,
			2,
			"closing the first issue permits a new unfiled cohort",
		);
		proposalRequestsOnly(github);
	});

	it("files one trigger, reconciles an ambiguous create, respects both switches and suppresses closed cohorts", async (t) => {
		for (const mode of ["normal", "unknown", "local", "remote"]) {
			const stateDir = directory(t);
			const github = new GitHubFixture();
			github.workflowSource = improvementWorkflow;
			github.unknown = mode === "unknown";
			github.enabled = mode !== "remote";

			if (mode === "local") writeFileSync(join(stateDir, "disabled"), "");

			for (let seq = 0; seq < 25; seq++)
				enqueueScore(stateDir, failingScore(seq));

			const before = filesOf(stateDir);
			const checkoutBefore = checkoutHash();
			let clock = now;

			const request = {
				platform: EXE_DEV_PLATFORM,
				stateDir,
				repo,
				exec: github.exec,
				clock: () => clock,
				config: improvementConfig,
				log: () => undefined,
			};

			await runImprovementTrigger(request);
			assert.equal(
				github.creates,
				mode === "local" || mode === "remote" ? 0 : 1,
			);
			assert.deepEqual(
				Object.fromEntries(
					Object.entries(filesOf(stateDir)).filter(
						([path]) => !path.startsWith("cadence/trigger/proposals/"),
					),
				),
				before,
				"the initial trigger preserves all non-proposal files, including the hold",
			);
			github.enabled = true;
			rmSync(join(stateDir, "disabled"), { force: true });
			delete before.disabled;
			clock += 3_600_000;
			await runImprovementTrigger(request);
			assert.equal(github.creates, 1);
			github.issues[0]!.state = "closed";
			await runImprovementTrigger(request);
			assert.equal(github.creates, 1);
			assert.equal(
				triggerRecord(github.issues[0]!.body, repo)?.runs.length,
				25,
			);

			assert.deepEqual(
				Object.fromEntries(
					Object.entries(filesOf(stateDir)).filter(
						([path]) => !path.startsWith("cadence/trigger/proposals/"),
					),
				),
				before,
				"trigger changes no file outside proposal intent state, including deletions",
			);
			assert.equal(
				checkoutHash(),
				checkoutBefore,
				"trigger never edits the repository checkout",
			);
			proposalRequestsOnly(github);
		}
	});
});

describe("cadence weekly policy and structured findings", () => {
	it("uses DST-free UTC and crosses Sunday/Monday without drift", () => {
		const settings = { dayUtc: 0, hourUtc: 3, minuteUtc: 15 };
		assert.equal(
			new Date(
				cadenceWindow(Date.parse("2026-03-29T03:15:00Z"), settings),
			).toISOString(),
			"2026-03-29T03:15:00.000Z",
		);
		assert.equal(
			new Date(
				cadenceWindow(Date.parse("2026-03-29T03:14:59Z"), settings),
			).toISOString(),
			"2026-03-22T03:15:00.000Z",
		);
		assert.equal(
			new Date(
				cadenceWindow(Date.parse("2026-03-30T00:00:00Z"), settings),
			).toISOString(),
			"2026-03-29T03:15:00.000Z",
		);
		assert.equal(
			new Date(utcWeekStart(Date.parse("2026-11-08T23:59:59Z"))).toISOString(),
			"2026-11-02T00:00:00.000Z",
		);
		assert.equal(
			new Date(utcWeekStart(Date.parse("2026-11-09T00:00:00Z"))).toISOString(),
			"2026-11-09T00:00:00.000Z",
		);
	});

	it("accepts no delta and refuses malformed, unbound, unsafe or out-of-scope proposals", () => {
		const execution = input();
		assert.deepEqual(parseCadenceProposals('{"proposals":[]}', execution), []);
		const proposal = finding();
		assert.equal(
			parseCadenceProposals(
				JSON.stringify({ proposals: [proposal] }),
				execution,
			)?.length,
			1,
		);

		for (const bad of [
			{ ...proposal, job: "security" },
			{ ...proposal, baseSha: "b".repeat(40) },
			{ ...proposal, title: "x".repeat(121) },
			{ ...proposal, limits: "" },
			{ ...proposal, evidence: [{ path: "../secret", start: 1, end: 2 }] },
			{
				...proposal,
				evidence: [{ path: "server/example.ts", start: 1, end: 2 }],
			},
			{ ...proposal, evidence: [{ path: "src/example.ts", start: 0, end: 2 }] },
		]) {
			assert.equal(
				parseCadenceProposals(JSON.stringify({ proposals: [bad] }), execution),
				null,
			);
		}

		assert.equal(parseCadenceProposals("not JSON", execution), null);
		assert.equal(
			parseCadenceProposals(
				JSON.stringify({ proposals: [proposal, proposal] }),
				execution,
			)?.length,
			1,
		);
		assert.deepEqual(
			parseCadenceProposals(
				JSON.stringify({ proposals: [{ ...proposal, fingerprint: "../x" }] }),
				execution,
			),
			[],
		);
	});

	it("keeps the candidate security-review contract unchanged and injects repository mode only into cadence", () => {
		assert.equal(
			digestOf(
				readFileSync(
					new URL("../skills/security-review/SKILL.md", import.meta.url),
					"utf8",
				),
			),
			"680790c43e8292798a1762d72c53657c691a1a385091ab89c636c7efdf670e75",
		);
		assert.match(
			cadencePrompt(input("security"), [], "unknown"),
			/override the supplied security skill's new-only\/pre-existing exclusions and candidate-seat envelope/,
		);
		assert.doesNotMatch(
			cadencePrompt(input(), [], "unknown"),
			/candidate-seat envelope/,
		);
	});

	it("mints normalized fingerprints and only accepts supplied reused fingerprints", () => {
		const proposal = finding();

		const parse = (value: typeof proposal, execution = input()) =>
			parseCadenceProposals(JSON.stringify({ proposals: [value] }), execution)!;

		const minted = parse(proposal)[0]!;
		assert.equal(
			minted.fingerprint,
			digestOf(
				JSON.stringify([
					"architecture",
					repo,
					"src/example.ts",
					"a duplicated policy decision",
				]),
			),
		);
		assert.equal(
			parse({ ...proposal, title: "  A DUPLICATED   policy decision  " })[0]
				?.fingerprint,
			minted.fingerprint,
		);
		assert.deepEqual(
			parse({ ...proposal, fingerprint: digestOf("invented by model") }),
			[],
		);

		const known = {
			fingerprint: minted.fingerprint,
			title: proposal.title,
			path: "src/example.ts",
			state: "not_planned" as const,
		};

		const execution = { ...input(), existingProposals: [known] };
		assert.equal(
			parse(
				{
					...proposal,
					fingerprint: minted.fingerprint,
					title: "Paraphrased finding",
				},
				execution,
			)[0]?.fingerprint,
			minted.fingerprint,
		);
		assert.match(cadencePrompt(execution, [], "unknown"), /not_planned/);
		assert.match(
			cadencePrompt(execution, [], "unknown"),
			/Never invent or change a fingerprint/,
		);
		assert.doesNotMatch(
			cadencePrompt(input("security"), [], "unknown"),
			/SHA-256-style/,
		);
	});

	it("escapes all model text, mentions, HTML, issue references and credentials", () => {
		const proposal = {
			...finding(),
			fingerprint: digestOf("escaping"),
			claim:
				"<script>alert(1)</script> @owner #42 giuseppecrj/other/issues/12 https://github.com/owner/repo/pull/4 ghp_".concat(
					"a".repeat(40),
				),
			limits: "<img> @owner",
			provenance: "[click](https://evil.example) @owner",
		};

		const body = cadenceIssueBody(proposal, {
			model: "<model>@owner",
			receiptDigest: digestOf("receipt"),
		});

		assert.doesNotMatch(
			body,
			/(?<!\\)<script>|@owner|#42|ghp_|github\.com\/owner\/repo\/pull\/4/,
		);
		assert.match(body, /＃42/);
		assert.match(body, /\\<script\\>/);
		assert.ok(
			body.endsWith(cadenceMarker(repo, "architecture", proposal.fingerprint)),
		);
		assert.match(body, new RegExp(`/blob/${sha}/src/example.ts#L1-L2`));
		assert.ok(body.length < 24_000);
	});

	it("rotates each fixed group and wraps independently of a weekly watermark", () => {
		assert.deepEqual(
			CADENCE_PATH_GROUPS.map((_, i) => cadenceScope(i)),
			[...CADENCE_PATH_GROUPS],
		);
		assert.deepEqual(cadenceScope(CADENCE_PATH_GROUPS.length), cadenceScope(0));
	});
});

describe("bounded single-pass cadence excerpts", () => {
	it("packs deterministic byte-bounded complete numbered windows and covers every eligible file over a rotation", () => {
		const paths = CADENCE_PATH_GROUPS.flatMap((group) =>
			Array.from({ length: 40 }, (_, i) => `${group[0]}/file-${i}.ts`),
		);

		const read = () => "first\nsecond\n" + "éééééééé\n".repeat(1000);
		const seen = new Set<string>();

		for (let rotation = 0; rotation < 250; rotation++) {
			const execution = { ...input(), rotation };
			const excerpt = cadenceExcerpt(execution, paths, read);
			assert.deepEqual(
				excerpt,
				cadenceExcerpt(execution, [...paths].reverse(), read),
			);
			assert.ok(
				Buffer.byteLength(JSON.stringify(excerpt.files)) <=
					CADENCE_EXCERPT_BYTES,
			);

			for (const file of excerpt.files) {
				seen.add(file.path);
				assert.match(file.lines, /^\d+: /);
				assert.ok(file.lines.endsWith("\n"));
				assert.ok(file.ranges[0]!.start <= file.ranges[0]!.end);
				assert.ok(Buffer.byteLength(file.lines) <= CADENCE_FILE_BYTES);
				assert.equal(file.truncated, true);
			}
		}

		assert.deepEqual([...seen].sort(), [...paths].sort());
	});

	it("selects instructions from the first run, rotates instruction parts and excludes held-out and binary input", () => {
		const files = [
			"AGENTS.md",
			".github/factory/WORKFLOW.md",
			...Array.from({ length: 30 }, (_, i) => `skills/s${i}/SKILL.md`),
			"src/code.ts",
			"test/acceptance/private.ts",
			"skills/README.md",
		];

		const seen = new Set<string>();

		for (let rotation = 0; rotation < 80; rotation++) {
			const excerpt = cadenceExcerpt(
				{ job: "instructions", rotation },
				files,
				() => "rule\n".repeat(2000),
			);

			for (const file of excerpt.files) seen.add(file.path);
		}

		assert.deepEqual([...seen].sort(), files.slice(0, -3).sort());

		const excluded = cadenceExcerpt(
			input(),
			["src/binary", "test/acceptance/private.ts"],
			() => "\0",
		);

		assert.deepEqual(excluded.files, []);
		assert.equal(excluded.omitted, 1);

		const escaped = cadenceExcerpt(input(), ["src/control.ts"], () =>
			"\u0001".repeat(20_000),
		);

		assert.ok(
			Buffer.byteLength(JSON.stringify(escaped.files)) <= CADENCE_EXCERPT_BYTES,
		);
	});

	it("prioritizes changed files across groups, skips imports, excludes generated/bulk files and rotates tails", () => {
		const changedPaths = [
			"server/z.ts",
			"server/viewer/design/tokens.css",
			"server/generated/code.ts",
			"package-lock.json",
		];

		const code =
			"// header\nimport {\n  one,\n} from './one.ts';\nimport 'side-effect';\n\n" +
			"export const code = true;\n".repeat(1500);

		const paths = ["src/a.ts", ...changedPaths];
		const execution = { ...input(), changedPaths };
		const excerpt = cadenceExcerpt(execution, paths, () => code);

		assert.equal(excerpt.files[0]?.path, "server/z.ts");
		assert.match(excerpt.files[0]!.lines, /^7: export const code/);
		assert.deepEqual(excerpt.files[0]?.skipped[0], { start: 1, end: 6 });
		assert.ok(
			excerpt.files.every(
				(file) => file.path === "server/z.ts" || file.path === "src/a.ts",
			),
		);

		const later = cadenceExcerpt(
			{ ...execution, rotation: 5 },
			paths,
			() => code,
		);

		assert.notEqual(
			later.files[0]?.ranges[0]?.start,
			excerpt.files[0]?.ranges[0]?.start,
		);
		assert.ok(
			excerpt.files.some((file) => file.path === "src/a.ts"),
			"changed-first retains steady rotation space",
		);
		assert.equal(
			parseCadenceProposals(
				JSON.stringify({
					proposals: [
						{
							...finding(),
							evidence: [{ path: "server/z.ts", start: 7, end: 9 }],
						},
					],
				}),
				execution,
			)?.length,
			1,
		);
		assert.equal(cadenceEligiblePath("src/code.generated.ts"), false);
		assert.equal(cadenceEligiblePath("server/code.min.js"), false);
		assert.equal(cadenceEligiblePath("test/fixtures/huge.json"), false);
		assert.equal(cadenceEligiblePath("docs/prototypes/big.md"), false);
		assert.equal(cadenceEligiblePath("yarn.lock"), false);
		assert.equal(cadenceEligiblePath("pnpm-lock.yaml"), false);

		const longLine = cadenceExcerpt(
			input(),
			["src/long.ts"],
			() => "a\n" + "x".repeat(20_000) + "\nz\n",
		);

		assert.deepEqual(
			longLine.files.flatMap((file) => file.ranges),
			[
				{ start: 1, end: 1 },
				{ start: 3, end: 3 },
			],
		);
		assert.ok(
			longLine.files.every((file) => /^\d+: [^\n]*\n$/.test(file.lines)),
			"no cut-off line or label",
		);
	});

	it("gives shown-path closed proposals priority within the bounded known-proposal context", () => {
		const existingProposals = Array.from({ length: 100 }, (_, n) => ({
			fingerprint: digestOf(`known-${n}`),
			title: `known-${n}`,
			state: "open" as const,
			path: "src/other.ts",
		}));

		const closed = {
			fingerprint: digestOf("closed-shown"),
			title: "closed shown",
			state: "not_planned" as const,
			path: "src/shown.ts",
		};

		const execution = {
			...input(),
			existingProposals: [...existingProposals, closed],
		};

		const excerpt = cadenceExcerpt(execution, ["src/shown.ts"], () => "code\n");

		const prompt = cadencePrompt(
			execution,
			["src/shown.ts"],
			"unknown",
			excerpt,
		);

		assert.match(prompt, new RegExp(closed.fingerprint));
		assert.ok(
			prompt.indexOf(closed.fingerprint) <
				prompt.indexOf(existingProposals[0]!.fingerprint),
		);
		assert.doesNotMatch(
			prompt,
			new RegExp(existingProposals.at(-1)!.fingerprint),
		);
	});

	it("calibrates every job on a committed snapshot below its 36k default (never needs git refs)", async (t) => {
		const snapshot: { sha: string; files: Record<string, string> } = JSON.parse(
			gunzipSync(
				readFileSync(
					new URL("fixtures/cadence/snapshot.json.gz", import.meta.url),
				),
			).toString(),
		);

		const calibration: {
			samples: {
				promptBytes: number;
				o200kTokens: number;
				firstInputTokens: number;
			}[];
		} = JSON.parse(
			readFileSync(
				new URL("fixtures/cadence/calibration.json", import.meta.url),
				"utf8",
			),
		);

		const bytesPerToken = 2.8;
		const runtimeTokens = 533;

		for (const sample of calibration.samples) {
			assert.equal(sample.firstInputTokens - sample.o200kTokens, runtimeTokens);
			assert.ok(
				Math.ceil(sample.promptBytes / bytesPerToken) + runtimeTokens >=
					sample.firstInputTokens,
			);
		}

		const paths = Object.keys(snapshot.files);
		const read = (path: string) => snapshot.files[path] ?? null;
		const estimates = [];
		const coverage = [];
		const excerpts = new Map<string, ReturnType<typeof cadenceExcerpt>>();

		const ledgerRow = JSON.stringify({
			runId: digestOf("run"),
			workflowDigest: digestOf("workflow"),
			baseSha: sha,
			tokens: 340078,
			result: "failed",
			receiptDigest: digestOf("receipt"),
		});

		const ledger = ledgerRow
			.repeat(Math.ceil((16 * 1024) / ledgerRow.length))
			.slice(0, 16 * 1024);

		for (const job of [
			"architecture",
			"security",
			"instructions",
			"hygiene",
		] as const) {
			let maxExcerpt = 0;
			let maxPrompt = 0;
			const covered = new Map<string, Set<number>>();
			let rotations = job === "instructions" ? 1 : CADENCE_PATH_GROUPS.length;

			for (let rotation = 0; rotation < rotations; rotation++) {
				const execution = {
					...input(job),
					rotation,
					existingProposals: Array.from({ length: 100 }, () => ({
						fingerprint: digestOf("known"),
						title: "x".repeat(220),
						state: "open" as const,
						path: "src/example.ts",
					})),
				};

				const key = `${job === "instructions" ? "instructions" : "code"}:${rotation}`;

				const excerpt =
					excerpts.get(key) ?? cadenceExcerpt(execution, paths, read);

				excerpts.set(key, excerpt);
				rotations = Math.max(
					rotations,
					excerpt.parts *
						(job === "instructions" ? 1 : CADENCE_PATH_GROUPS.length),
				);

				for (const file of excerpt.files) {
					const seen = covered.get(file.path) ?? new Set<number>();

					for (const range of file.ranges)
						for (let n = range.start; n <= range.end; n++) seen.add(n);
					covered.set(file.path, seen);
					assert.ok(
						Buffer.byteLength(JSON.stringify(file)) <= CADENCE_FILE_BYTES,
					);
				}

				const prompt = await withSkills(
					new URL("..", import.meta.url).pathname,
					cadencePrompt(
						execution,
						excerpt.files.map((file) => file.path),
						job === "hygiene"
							? ledger
							: "unavailable; not requested by this job",
						excerpt,
					),
					[CADENCE_SKILLS[job]],
				);

				assert.ok(prompt);
				maxExcerpt = Math.max(
					maxExcerpt,
					Buffer.byteLength(JSON.stringify(excerpt.files)),
				);
				maxPrompt = Math.max(
					maxPrompt,
					Math.ceil(Buffer.byteLength(prompt) / bytesPerToken) + runtimeTokens,
				);
			}

			const answerReserve = 8_800 + 4_000;
			const estimate = maxPrompt + answerReserve;
			assert.ok(
				estimate < config.jobs[job].maxTokens,
				`${job}: ${estimate} including 8.8k maximum answer and 4k reasoning reserve`,
			);
			assert.ok(maxExcerpt <= CADENCE_EXCERPT_BYTES);

			for (const [path, text] of Object.entries(snapshot.files)) {
				if (
					!cadenceEligiblePath(path) ||
					(job === "instructions" &&
						path !== "AGENTS.md" &&
						path !== ".github/factory/WORKFLOW.md" &&
						!/^skills\/[^/]+\/SKILL\.md$/.test(path))
				)
					continue;
				const lines = text.replace(/\n$/, "").split("\n");

				for (let i = cadenceCodeStart(lines); i < lines.length; i++) {
					if (
						Buffer.byteLength(JSON.stringify(`${i + 1}: ${lines[i]}\n`)) - 2 <=
						CADENCE_FILE_BYTES - 1024
					)
						assert.ok(
							covered.get(path)?.has(i + 1),
							`${job}: missing ${path}:${i + 1}`,
						);
				}
			}

			if (job === "architecture") {
				for (const [group, offset] of [
					["src", 0],
					["server", 1],
				] as const) {
					const part = cadenceExcerpt(
						{ ...input(job), rotation: offset },
						paths,
						read,
					);

					const total = paths
						.filter((path) => path.startsWith(`${group}/`))
						.reduce(
							(sum, path) =>
								sum +
								snapshot.files[path]!.replace(/\n$/, "").split("\n").length,
							0,
						);

					const seen = [...covered]
						.filter(([path]) => path.startsWith(`${group}/`))
						.reduce((sum, [, lines]) => sum + lines.size, 0);

					coverage.push({
						group,
						cycleWeeks: part.parts * CADENCE_PATH_GROUPS.length,
						parts: part.parts,
						totalLines: total,
						shownLines: seen,
						share: seen / total,
					});
				}
			}

			estimates.push({
				job,
				snapshot: snapshot.sha,
				excerptBytes: maxExcerpt,
				promptTokens: maxPrompt,
				answerReserve,
				totalEstimate: estimate,
				headroom: config.jobs[job].maxTokens - estimate,
				rotations,
			});
		}

		t.diagnostic(
			JSON.stringify({
				excerptBudget: CADENCE_EXCERPT_BYTES,
				perFileBudget: CADENCE_FILE_BYTES,
				estimate:
					"UTF-8 bytes/2.8 + 533 runtime; 8,800 answer + 4,000 reasoning; maximum over every part; hex/JSON 16 KiB ledger and 4 KiB known proposals",
				jobs: estimates,
				coverage,
			}),
		);
	});
});

describe("cadence durable ownership, accounting and proposal recovery", () => {
	it("compares the last audited pin locally, uses changed-first input and omits a listed missing file without a 40k charge", async (t) => {
		for (const previous of [false, true]) {
			const stateDir = directory(t);
			const github = new GitHubFixture();
			const calls: string[][] = [];

			const priorSha = "b".repeat(40);
			assert.ok(isGitSha(priorSha));

			if (previous) {
				const old = {
					...input("architecture", input().windowStart - 7 * 86_400_000, 4),
					baseSha: priorSha,
					workflowSha: priorSha,
				};

				seed(stateDir, old, result(old, []));
				await settle(runner(stateDir, github));
			}

			const exec: Exec = async (command, args) => {
				if (command !== "git") return github.exec(command, args);
				calls.push([...args]);

				return { code: 0, stdout: "server/changed.ts\0", stderr: "" };
			};

			const executor = sandboxExecutor({
				platform: EXE_DEV_PLATFORM,
				stateDir,
				exec,
				root: join(stateDir, "absent-bundle"),
				xdgRuntimeDir: `/run/user/${process.getuid?.()}`,
				log: () => undefined,
			});

			executor.preflight = async () => true;
			executor.checkout = async ({ workspace }) => {
				mkdirSync(join(workspace, "src"), { recursive: true });
				mkdirSync(join(workspace, "server"), { recursive: true });
				writeFileSync(join(workspace, "src/code.ts"), "code\n");
				writeFileSync(join(workspace, "server/changed.ts"), "changed code\n");

				return {
					kind: "ready",
					omitted: 0,
					checkout: {
						files: ["src/code.ts", "src/missing.ts", "server/changed.ts"],
						read: async () => null,
					},
				};
			};

			executor.launch = async (request) => {
				assert.deepEqual(request.tools, []);

				return {
					kind: "unavailable",
					stage: request.stage,
					reason: "sandbox_unavailable",
				};
			};

			const cadence = controllerCadence({
				platform: EXE_DEV_PLATFORM,
				stateDir,
				repo,
				exec,
				executor,
				log: () => undefined,
			});

			await settle(cadence);
			assert.equal(calls.length, previous ? 1 : 0);

			if (previous) {
				assert.equal(calls[0]?.[0], "-C");
				assert.equal(calls[0]![1]!, new URL("..", import.meta.url).pathname);
				assert.deepEqual(calls[0]?.slice(2), [
					"diff",
					"--name-only",
					"--no-renames",
					"-z",
					priorSha,
					sha,
					"--",
				]);
			}

			const dir = cadenceExecutionDir(
				stateDir,
				"architecture",
				input().windowStart,
			);

			const excerpt = JSON.parse(
				readFileSync(join(dir, "excerpt.json"), "utf8"),
			);

			assert.equal(excerpt.omitted, 1);
			assert.equal(
				excerpt.files[0].path,
				previous ? "server/changed.ts" : "src/code.ts",
			);
			assert.equal(cadenceCharges(stateDir, repo).at(-1)?.tokens, 0);
			assert.equal(cadence.status()[0]?.reason, "sandbox_unavailable");
		}
	});

	it("records no delta and a rotation watermark, then performs no second execution", async (t) => {
		const stateDir = directory(t);
		seed(stateDir, input(), result(input(), []));
		const cadence = runner(stateDir);
		await settle(cadence);
		assert.equal(cadence.status()[0]?.reason, "no_delta");
		assert.equal(cadence.status()[0]?.watermark, input().windowStart);
		assert.equal(cadence.status()[0]?.rotation, 1);
		const restarted = runner(stateDir);
		await settle(restarted);
		assert.equal(restarted.pending, false);
		assert.equal(cadenceCharges(stateDir, repo).length, 1);
		assert.equal(existsSync(join(stateDir, "claims")), false);
		assert.equal(existsSync(join(stateDir, "ledger")), false);
		const accounting = await readDurableAccounting(stateDir, repo);
		assert.equal(accounting.runs.length, 0);
		assert.equal(accounting.maintenance.tokens.total, 16);
		const usage = objectOf(durableUsageOf(accounting));
		assert.equal(usage?.total, 16);
		assert.equal(objectOf(usage?.maintenance)?.total, 16);
		assert.equal(accounting.maintenance.money.kind, "unavailable");
	});

	it("keeps the last audited base through restart and pruning of zero-token windows", async (t) => {
		const stateDir = directory(t);
		const newerSha = "c".repeat(40);
		assert.ok(isGitSha(newerSha));

		for (let week = 0; week < CADENCE_RETAIN_EXECUTIONS + 2; week++) {
			const cadence = new CadenceRunner({
				stateDir,
				repo,
				log: () => undefined,
				port: {
					execute: async (execution) => {
						assert.equal(
							execution.previousBaseSha,
							week === 0 ? undefined : sha,
						);

						return week === 0
							? result(execution, [])
							: {
									...result(execution, []),
									kind: "failed",
									tokens: 0,
									output: null,
									reason: "failed_before_model",
								};
					},
					retained: async () => {
						throw new Error("unexpected retention");
					},
					publish: async () => true,
				},
			});

			await settle(cadence, "architecture", {
				...tick,
				now: now + week * 7 * 86_400_000,
				workflowSha: week === 0 ? sha : newerSha,
			});
		}

		assert.equal(
			existsSync(
				cadenceExecutionDir(stateDir, "architecture", input().windowStart),
			),
			false,
			"original audited tree was pruned",
		);
		assert.equal(
			JSON.parse(
				readFileSync(join(stateDir, "cadence/architecture/state.json"), "utf8"),
			).lastAuditedBaseSha,
			sha,
		);
	});

	it("retains only the last N executions while preserving lifetime and weekly charges", async (t) => {
		const stateDir = directory(t);
		const github = new GitHubFixture();
		const total = CADENCE_RETAIN_EXECUTIONS + 4;

		for (let n = 0; n < total; n++) {
			const execution = {
				...input("architecture", input().windowStart + n * 7 * 86_400_000),
				chargedWeek: utcWeekStart(now + n * 7 * 86_400_000),
			};

			const dir = seed(stateDir, execution, result(execution, []));
			mkdirSync(join(dir, "runtime"), { mode: 0o700 });
			writeFileSync(join(dir, "runtime", "session.jsonl"), "large archive");
			mkdirSync(join(stateDir, "checkouts"), { recursive: true });
			writeFileSync(
				join(stateDir, "checkouts", `${execution.runId}.json`),
				"checkout",
			);
			await settle(runner(stateDir, github), "architecture", {
				...tick,
				now: now + n * 7 * 86_400_000,
			});
		}

		assert.equal(
			readdirSync(join(stateDir, "cadence/architecture/executions")).length,
			CADENCE_RETAIN_EXECUTIONS,
		);
		assert.equal(
			readdirSync(join(stateDir, "checkouts")).length,
			CADENCE_RETAIN_EXECUTIONS,
		);
		const charges = cadenceCharges(stateDir, repo);
		assert.equal(
			charges.reduce((sum, charge) => sum + charge.tokens, 0),
			total * 16,
		);
		assert.equal(
			charges
				.filter(
					(charge) =>
						charge.week === utcWeekStart(now + (total - 1) * 7 * 86_400_000),
				)
				.reduce((sum, charge) => sum + charge.tokens, 0),
			16,
		);
		assert.equal(
			(await readDurableAccounting(stateDir, repo)).maintenance.executions,
			total,
		);
		assert.ok(charges.length <= CADENCE_RETAIN_EXECUTIONS + 2);
	});

	it("reports unsettled maintenance requests separately from missing receipts", async (t) => {
		const stateDir = directory(t);
		seed(stateDir, input(), {
			...result(input(), []),
			exact: false,
			uncertain: true,
		});

		const usage = objectOf(
			durableUsageOf(await readDurableAccounting(stateDir, repo)),
		);

		assert.equal(usage?.kind, "uncertain");
		assert.equal(usage?.reason, "request_unsettled");
		assert.equal(usage?.total, 16);
	});

	it("retains an interrupted execution's full charge and never replays it on restart", async (t) => {
		const stateDir = directory(t);
		seed(stateDir, input(), null);
		const cadence = runner(stateDir);
		await settle(cadence);
		assert.equal(cadence.status()[0]?.reason, "interrupted");
		assert.equal(cadenceCharges(stateDir, repo)[0]?.tokens, 36_000);
		assert.equal(cadenceCharges(stateDir, repo)[0]?.exact, false);
		assert.equal(
			existsSync(
				join(
					cadenceExecutionDir(stateDir, "architecture", input().windowStart),
					"runtime",
				),
			),
			false,
		);
	});

	it("fails closed on corrupt watermark JSON instead of treating it as a fresh job", async (t) => {
		const stateDir = directory(t);
		mkdirSync(join(stateDir, "cadence/architecture"), {
			recursive: true,
			mode: 0o700,
		});
		writeCadenceFile(
			join(stateDir, "cadence/architecture/state.json"),
			"{broken",
		);
		const logs: string[] = [];

		const cadence = runner(stateDir, new GitHubFixture(), (event) =>
			logs.push(event),
		);

		await settle(cadence);
		await settle(cadence);
		assert.deepEqual(logs, ["cadence_blocked"]);
		assert.equal(cadence.ready, false);
		assert.equal(cadenceCharges(stateDir, repo).length, 0);
	});

	it("refuses overlapping retained windows instead of granting another launch", async (t) => {
		const stateDir = directory(t);
		seed(stateDir, input(), null);
		seed(
			stateDir,
			input("architecture", input().windowStart - 7 * 86_400_000),
			null,
		);
		const cadence = runner(stateDir);
		await settle(cadence);
		assert.equal(cadence.ready, false);
		assert.equal(cadence.occupied(), 0);
	});

	it("does not launch with full ticket capacity, disabled dispatch or missing trusted cadence", async (t) => {
		for (const evaluation of [
			{ ...tick, capacity: 0 },
			{ ...tick, allowed: false },
			{ ...tick, config: null },
		]) {
			const stateDir = directory(t);
			const cadence = runner(stateDir);
			await settle(cadence, "architecture", evaluation);
			assert.equal(existsSync(join(stateDir, "cadence")), false);
			assert.equal(cadence.occupied(), 0);
		}
	});

	it("does no work before a fresh job's weekly UTC due time", async (t) => {
		const stateDir = directory(t);
		const cadence = runner(stateDir);
		await settle(cadence, "hygiene");
		assert.equal(existsSync(join(stateDir, "cadence")), false);
		assert.equal(cadence.pending, false);
	});

	it("reserves the job's complete allowance against the weekly token cap", async (t) => {
		const stateDir = directory(t);
		const cadence = runner(stateDir);
		await settle(cadence, "architecture", {
			...tick,
			config: { ...config, weeklyTokenCap: 35_999 },
		});
		assert.equal(cadence.status()[0]?.reason, "budget");
		assert.equal(cadenceCharges(stateDir, repo).length, 0);
		assert.equal(existsSync(join(stateDir, "stages")), false);
	});

	it("charges previous maintenance separately and cannot refill a weekly budget after restart", async (t) => {
		const stateDir = directory(t);
		const security = input("security");
		seed(stateDir, security, { ...result(security, []), tokens: 36_000 });
		await settle(runner(stateDir), "security");
		const cadence = runner(stateDir);
		await settle(cadence, "architecture", {
			...tick,
			config: { ...config, weeklyTokenCap: 71_999 },
		});
		assert.equal(cadence.status()[0]?.reason, "budget");
		assert.equal(cadenceCharges(stateDir, repo).length, 1);
	});

	it("creates only proposed issues and deduplicates closed, relabeled issues across a restart and later window", async (t) => {
		const stateDir = directory(t);
		const github = new GitHubFixture();
		seed(stateDir);
		await settle(runner(stateDir, github));
		assert.equal(github.creates, 1);
		assert.deepEqual(github.issues[0]?.labels, [{ name: "factory:proposed" }]);
		github.issues[0]!.state = "closed";
		github.issues[0]!.labels = [];
		const next = input("architecture", input().windowStart + 7 * 86_400_000);
		seed(stateDir, next, result(next));
		await settle(runner(stateDir, github), "architecture", {
			...tick,
			now: now + 7 * 86_400_000,
		});
		assert.equal(github.creates, 1);
		assert.equal(existsSync(join(stateDir, "claims")), false);
		assert.equal(
			github.requests.some((args) =>
				args.some(
					(arg) => arg.includes("pulls") || arg.includes("factory:ready"),
				),
			),
			false,
		);
	});

	it("never refiles a rejected finding with paraphrased model text or a changed hash in a later rotation", async (t) => {
		const stateDir = directory(t);
		const github = new GitHubFixture();
		seed(stateDir);
		await settle(runner(stateDir, github));
		const first = github.issues[0]!;
		first.state = "closed";
		first.state_reason = "not_planned";
		const fingerprint = first.body.split("\n").at(-1)!.split(" ").at(-2)!;

		const execution = {
			...input("architecture", input().windowStart + 5 * 7 * 86_400_000, 5),
			existingProposals: [
				{
					fingerprint,
					title: first.title,
					path: "src/example.ts",
					state: "not_planned" as const,
				},
			],
		};

		seed(
			stateDir,
			execution,
			result(execution, [
				{
					...finding(execution),
					title: "Same finding paraphrased by the model",
					fingerprint,
				},
				{
					...finding(execution),
					title: "Same finding with an invented hash",
					fingerprint: digestOf("changed hash"),
				},
			]),
		);
		const cadence = runner(stateDir, github);
		await settle(cadence, "architecture", {
			...tick,
			now: now + 5 * 7 * 86_400_000,
		});
		assert.equal(github.creates, 1);
		assert.equal(cadence.pending, false);
		assert.equal(cadence.status()[0]?.rotation, 6);
	});

	it("reconciles an unknown create on the next tick, including after process restart", async (t) => {
		const stateDir = directory(t);
		const github = new GitHubFixture();
		github.unknown = true;
		seed(stateDir);
		const first = runner(stateDir, github);
		await settle(first);
		assert.equal(first.pending, true);
		assert.equal(github.creates, 1);
		const restarted = runner(stateDir, github);
		await settle(restarted, "architecture", { ...tick, now: now + 10_000 });
		assert.equal(restarted.pending, false);
		assert.equal(github.creates, 1);
	});

	it("reads only bot proposals once per filing pass, ignores forged markers and tolerates duplicate bot matches", async (t) => {
		const stateDir = directory(t);
		const github = new GitHubFixture();
		const execution = input();
		const first = finding(execution);

		const parsed = parseCadenceProposals(
			JSON.stringify({ proposals: [first] }),
			execution,
		)![0]!;

		const copied = {
			number: 55,
			title: "forged",
			body: cadenceIssueBody(parsed, result()),
			labels: [{ name: "factory:proposed" }],
			state: "closed",
			user: { login: "someone-else" },
			updated_at: "2026-11-10T12:00:00Z",
		};

		github.issues.push(copied, { ...copied, number: 56 });
		seed(
			stateDir,
			execution,
			result(execution, [first, finding(execution, "second")]),
		);
		await settle(runner(stateDir, github));
		assert.equal(github.creates, 2);

		const reads = github.requests.filter((args) =>
			args.some((arg) => arg.includes("issues?") && arg.includes("state=all")),
		);

		assert.equal(reads.length, 1);
		assert.match(
			reads[0]!.join(" "),
			/creator=exe-dev-github-integration%5Bbot%5D/,
		);
		const nextState = directory(t);
		github.issues.push({ ...github.issues[2]!, number: 60 });
		seed(nextState, execution, result(execution, [first]));
		await settle(runner(nextState, github));
		assert.equal(
			github.creates,
			2,
			"several own matches mean already filed, never a stall",
		);
	});

	it("backs off failed publication reads without burning the slot or repeatedly listing on every tick", async (t) => {
		const stateDir = directory(t);
		const github = new GitHubFixture();
		github.listFails = true;
		seed(stateDir);
		const cadence = runner(stateDir, github);
		await settle(cadence);
		const requests = github.requests.length;
		await settle(cadence, "architecture", { ...tick, now: now + 9_999 });
		assert.equal(github.requests.length, requests);
		assert.equal(cadence.status()[0]?.watermark, null);
		github.listFails = false;
		await settle(cadence, "architecture", { ...tick, now: now + 10_000 });
		assert.equal(github.creates, 1);
		assert.equal(cadence.pending, false);
	});

	it("stops publication after an in-flight list or create instead of continuing the remaining proposals", async (t) => {
		const stateDir = directory(t);
		const github = new GitHubFixture();
		const abort = new AbortController();
		const execution = input();
		seed(stateDir);
		github.beforeCreate = () => abort.abort();

		const proposals = parseCadenceProposals(
			JSON.stringify({ proposals: [finding(), finding(execution, "second")] }),
			execution,
		)!;

		assert.equal(
			await publishCadenceProposals({
				platform: EXE_DEV_PLATFORM,
				stateDir,
				exec: github.exec,
				execution,
				result: result(),
				proposals,
				signal: abort.signal,
			}),
			false,
		);
		assert.equal(github.creates, 1);
	});

	it("never retries an unknown create when the reconciliation read fails", async (t) => {
		const stateDir = directory(t);
		const github = new GitHubFixture();
		github.unknown = true;
		seed(stateDir);
		await settle(runner(stateDir, github));
		github.listFails = true;
		const restarted = runner(stateDir, github);
		await settle(restarted);
		assert.equal(restarted.pending, true);
		assert.equal(github.creates, 1);
	});

	it("checks both exact switches again before filing, and holds retained findings while disabled", async (t) => {
		for (const disabled of ["local", "remote", "case"]) {
			const stateDir = directory(t);
			const github = new GitHubFixture();
			seed(stateDir);

			if (disabled === "local") writeFileSync(join(stateDir, "disabled"), "");

			if (disabled === "remote") github.enabled = false;

			if (disabled === "case") github.labelName = "Factory:Enabled";
			const cadence = runner(stateDir, github);
			await settle(cadence);
			assert.equal(github.creates, 0);
			assert.equal(cadence.pending, true);
			rmSync(join(stateDir, "disabled"), { force: true });
			github.enabled = true;
			github.labelName = "factory:enabled";
			await settle(cadence, "architecture", { ...tick, now: now + 10_000 });
			assert.equal(github.creates, 1);
		}
	});

	it("drops citations to unseen lines and files even when they exist in the pinned tree (B2 reproductions)", async (t) => {
		const stateDir = directory(t);
		const execution = input("architecture", input().windowStart, 1);
		const dir = seed(stateDir, execution);
		mkdirSync(join(dir, "tree/server/sandbox/assets"), { recursive: true });
		writeFileSync(join(dir, "tree/server/cli.ts"), "code\n".repeat(1873));
		writeFileSync(
			join(dir, "tree/server/sandbox/assets/pi.ts"),
			"code\n".repeat(10),
		);
		writeCadenceFile(
			join(dir, "excerpt.json"),
			JSON.stringify({
				files: [{ path: "server/cli.ts", ranges: [{ start: 1, end: 217 }] }],
			}),
		);

		const proposals = [
			{
				...finding(execution),
				evidence: [{ path: "server/cli.ts", start: 717, end: 727 }],
			},
			{
				...finding(execution, "unseen-file"),
				evidence: [{ path: "server/sandbox/assets/pi.ts", start: 1, end: 5 }],
			},
		];

		const github = new GitHubFixture();

		const parsed = parseCadenceProposals(
			JSON.stringify({ proposals }),
			execution,
		)!;

		assert.equal(parsed.length, 2);
		assert.equal(
			await publishCadenceProposals({
				platform: EXE_DEV_PLATFORM,
				stateDir,
				exec: github.exec,
				execution,
				result: result(execution),
				proposals: parsed,
			}),
			true,
		);
		assert.equal(github.creates, 0);
		const filing = JSON.parse(readFileSync(join(dir, "filing.json"), "utf8"));
		assert.equal(filing.invalidEvidence.length, 2);
		assert.equal(filing.dropped.length, 2);
	});

	it("drops bad citations without stalling this job or the next audit", async (t) => {
		const stateDir = directory(t);
		const github = new GitHubFixture();
		const execution = input();
		const valid = finding(execution);

		const bad = {
			...finding(execution, digestOf("bad")),
			evidence: [{ ...valid.evidence[0]!, end: 999 }],
		};

		seed(stateDir, execution, result(execution, [bad, valid]));
		const cadence = runner(stateDir, github);
		await settle(cadence);
		assert.equal(cadence.pending, false);
		assert.equal(github.creates, 1);
		await settle(cadence, "security");
		assert.ok(
			existsSync(
				cadenceExecutionDir(
					stateDir,
					"security",
					input("security").windowStart,
				),
			),
		);
	});

	it("checks switches separately for each finding, and refuses unverified line ranges", async (t) => {
		const stateDir = directory(t);
		const github = new GitHubFixture();
		const execution = input();

		const first = finding(execution),
			second = finding(execution, digestOf("second"));

		seed(stateDir, execution, result(execution, [first, second]));
		github.beforeCreate = () => {
			github.enabled = false;
		};

		const cadence = runner(stateDir, github);
		await settle(cadence);
		assert.equal(github.creates, 1);
		assert.equal(cadence.pending, true);

		const bad = {
			...first,
			fingerprint: digestOf("invalid lines"),
			evidence: [{ ...first.evidence[0]!, end: 999 }],
		};

		github.enabled = true;
		assert.equal(
			await publishCadenceProposals({
				platform: EXE_DEV_PLATFORM,
				stateDir,
				exec: github.exec,
				execution,
				result: result(),
				proposals: [bad],
			}),
			true,
		);
		assert.equal(github.creates, 1);
	});

	it("settles a crash during a retried launch with its conservative reservation", async (t) => {
		const stateDir = directory(t);
		const executes: string[] = [];
		let retainedCalls = 0;

		const port = (generation: number) => ({
			execute: async (execution: CadenceInput): Promise<CadenceResult> => {
				const runtime = join(
					cadenceExecutionDir(stateDir, execution.job, execution.windowStart),
					"runtime",
				);

				executes.push(
					`gen${generation}:${existsSync(runtime) ? "runtime-exists" : "fresh"}`,
				);

				if (executes.length === 1)
					return {
						...result(execution, []),
						kind: "failed",
						launched: false,
						tokens: 0,
						reason: "checkout_unavailable",
					};

				if (existsSync(runtime))
					return {
						...result(execution, []),
						kind: "failed",
						launched: false,
						tokens: 0,
						reason: "sandbox_unavailable",
					};
				mkdirSync(runtime, { mode: 0o700 });

				return new Promise<CadenceResult>(() => undefined);
			},
			retained: async (execution: CadenceInput): Promise<CadenceResult> => {
				retainedCalls++;

				return {
					...result(execution, []),
					kind: "failed",
					tokens: execution.settings.maxTokens,
					exact: false,
					output: null,
					reason: "interrupted",
				};
			},
			publish: async () => true,
		});

		const first = new CadenceRunner({
			stateDir,
			repo,
			log: () => undefined,
			port: port(1),
		});

		await settle(first);
		first.tick({ ...tick, now: now + 10_000 }, "architecture");
		await delay(50);

		const restarted = new CadenceRunner({
			stateDir,
			repo,
			log: () => undefined,
			port: port(2),
		});

		for (let n = 1; n <= 20; n++)
			await settle(restarted, "architecture", {
				...tick,
				now: now + n * 3_600_000,
			});
		assert.equal(restarted.pending, false);
		assert.equal(retainedCalls, 1);
		assert.deepEqual(executes, ["gen1:fresh", "gen1:fresh"]);
		assert.equal(
			cadenceCharges(stateDir, repo)[0]?.tokens,
			input().settings.maxTokens,
		);
		assert.equal(cadenceCharges(stateDir, repo)[0]?.exact, false);
	});

	it("caps refused creates and damaged drafts per window across restarts, then runs the next job", async (t) => {
		for (const failure of ["refused_create", "damaged_draft", "prelaunch"]) {
			const stateDir = directory(t);
			const execution = input();
			const dir = seed(stateDir);
			const github = new GitHubFixture();
			let attempts = 0;
			const launches: CadenceJob[] = [];
			const logs: string[] = [];
			const proposal = parseCadenceProposals(result().output!, execution)![0]!;

			if (failure === "damaged_draft") {
				mkdirSync(join(stateDir, "cadence/architecture/proposals"), {
					mode: 0o700,
				});
				writeCadenceFile(
					join(
						stateDir,
						"cadence/architecture/proposals",
						`${proposal.fingerprint}.json`,
					),
					"{broken",
				);
			}

			if (failure === "prelaunch")
				writeCadenceFile(
					join(dir, "receipt.json"),
					JSON.stringify({
						...result(),
						kind: "failed",
						launched: false,
						tokens: 0,
						reason: "checkout_unavailable",
					}),
				);

			const exec: Exec = async (command, args) => {
				if (args.includes("POST")) {
					attempts++;

					return { code: 1, stdout: "", stderr: "HTTP 403" };
				}

				return github.exec(command, args);
			};

			const makeRunner = () =>
				new CadenceRunner({
					stateDir,
					repo,
					log: (event) => logs.push(event),
					port: {
						execute: async (e) => {
							launches.push(e.job);

							return e.job === "architecture"
								? {
										...result(e, []),
										kind: "failed",
										launched: false,
										tokens: 0,
										reason: "checkout_unavailable",
									}
								: result(e, []);
						},
						retained: async (e) => result(e, []),
						publish: (e, receipt, proposals, signal) =>
							publishCadenceProposals({
								platform: EXE_DEV_PLATFORM,
								stateDir,
								exec,
								execution: e,
								result: receipt,
								proposals,
								signal,
							}),
					},
				});

			let cadence = makeRunner();

			for (let n = 0; n < 5; n++) {
				cadence = makeRunner();
				await settle(cadence, "architecture", {
					...tick,
					now: now + n * 300_000,
				});
				assert.equal(cadence.pending, n < 4);
			}

			assert.equal(cadence.status()[0]?.watermark, execution.windowStart);
			assert.equal(cadence.status()[0]?.rotation, 1);
			assert.ok(logs.includes("cadence_retry_exhausted"));

			const receipt = JSON.parse(
				readFileSync(join(dir, "receipt.json"), "utf8"),
			);

			assert.equal(receipt.kind, "failed");
			assert.match(receipt.reason, /^retry_exhausted:/);
			assert.ok(receipt.reason.length <= 136);
			assert.equal(receipt.tokens, failure === "prelaunch" ? 0 : 16);
			assert.equal(attempts, failure === "refused_create" ? 5 : 0);
			await settle(cadence, "architecture", { ...tick, now: now + 1_500_000 });
			assert.equal(cadence.pending, false);
			assert.equal(attempts, failure === "refused_create" ? 5 : 0);
			await settle(cadence, "security", { ...tick, now: now + 1_500_000 });
			assert.equal(launches.at(-1), "security");
			assert.equal(cadence.pending, false);
		}
	});

	it("settles corrupt receipts on recovery and between ticks without throwing or relaunching", async (t) => {
		for (const corruptAfterRecovery of [false, true]) {
			const stateDir = directory(t);
			const dir = seed(stateDir);
			mkdirSync(join(dir, "runtime"), { mode: 0o700 });
			const logs: { event: string; reason: unknown }[] = [];
			const launches: CadenceJob[] = [];

			const cadence = new CadenceRunner({
				stateDir,
				repo,
				log: (event, fields) => logs.push({ event, reason: fields.reason }),
				port: {
					execute: async (e) => {
						launches.push(e.job);

						return result(e, []);
					},
					retained: async () => {
						throw new Error("must not recover corrupt output");
					},
					publish: async () => {
						throw new Error("must not publish corrupt output");
					},
				},
			});

			if (corruptAfterRecovery) await cadence.recover();
			writeCadenceFile(
				join(dir, "receipt.json"),
				`{broken ${"private ".repeat(1000)}`,
			);
			await cadence.recover();
			assert.equal(cadence.ready, true);
			assert.doesNotThrow(() => cadence.tick(tick, "architecture"));
			await cadence.wait();
			assert.equal(cadence.pending, false);
			assert.deepEqual(launches, []);
			assert.equal(cadence.status()[0]?.reason, "cadence_receipt_invalid");
			assert.deepEqual(
				logs.filter((entry) => entry.event === "cadence_receipt_corrupt"),
				[
					{
						event: "cadence_receipt_corrupt",
						reason: "cadence_receipt_invalid",
					},
				],
			);
			assert.equal(
				cadenceCharges(stateDir, repo)[0]?.tokens,
				input().settings.maxTokens,
			);
			assert.equal(cadenceCharges(stateDir, repo)[0]?.exact, false);
			assert.equal(
				JSON.parse(readFileSync(join(dir, "receipt.json"), "utf8")).kind,
				"failed",
			);
			await settle(cadence, "security");
			assert.deepEqual(launches, ["security"]);
		}
	});

	it("retries zero-work preparation failures with durable bounded backoff, without using the weekly slot", async (t) => {
		const stateDir = directory(t);
		let attempts = 0;

		const cadence = new CadenceRunner({
			stateDir,
			repo,
			log: () => undefined,
			port: {
				retained: async () => {
					throw new Error("unexpected retention");
				},
				execute: async (execution) => {
					attempts++;

					return attempts === 1
						? {
								...result(execution, []),
								kind: "failed",
								launched: false,
								tokens: 0,
								reason: "checkout_unavailable",
							}
						: result(execution, []);
				},
				publish: async () => true,
			},
		});

		await settle(cadence);
		assert.equal(attempts, 1);
		assert.equal(cadence.pending, true);
		assert.equal(cadence.status()[0]?.watermark, null);
		assert.equal(cadence.status()[0]?.rotation, 0);
		await settle(cadence, "architecture", { ...tick, now: now + 9_999 });
		assert.equal(attempts, 1);
		await settle(cadence, "architecture", { ...tick, now: now + 10_000 });
		assert.equal(attempts, 2);
		assert.equal(cadence.pending, false);
		assert.equal(cadence.status()[0]?.rotation, 1);
		assert.equal(cadenceCharges(stateDir, repo)[0]?.tokens, 16);
	});

	it("does not abort spent model work on unavailable reads, but does on a positively off switch", async (t) => {
		for (const disabled of [false, true]) {
			const stateDir = directory(t);
			let signal: AbortSignal | null = null;
			let resolve: (value: CadenceResult) => void = () => undefined;

			const work = new Promise<CadenceResult>((done) => {
				resolve = done;
			});

			const cadence = new CadenceRunner({
				stateDir,
				repo,
				log: () => undefined,
				port: {
					execute: async (_execution, abort) => {
						signal = abort;

						return work;
					},
					retained: async () => result(input(), []),
					publish: async () => true,
				},
			});

			await cadence.recover();
			cadence.tick(tick, "architecture");
			cadence.tick({ ...tick, allowed: false, disabled });
			assert.ok(signal !== null);
			// SAFETY: execute synchronously assigns the signal before returning its retained promise.
			assert.equal((signal as AbortSignal).aborted, disabled);
			resolve(result(input(), []));
			await cadence.wait();
			assert.equal(cadence.status()[0]?.reason, "no_delta");
		}
	});

	it("holds retained proposals when preflight is unavailable", async (t) => {
		const stateDir = directory(t);
		const github = new GitHubFixture();
		seed(stateDir);
		const exec = withoutStageScopes(github.exec);

		const executor = sandboxExecutor({
			platform: EXE_DEV_PLATFORM,
			stateDir,
			exec,
			root: join(stateDir, "absent-bundle"),
			xdgRuntimeDir: `/run/user/${process.getuid?.()}`,
			log: () => undefined,
		});

		const cadence = controllerCadence({
			platform: EXE_DEV_PLATFORM,
			stateDir,
			repo,
			exec,
			executor,
			log: () => undefined,
		});

		// Saved-state publication needs no stage preflight or model work.
		await cadence.recover();

		const controller = new Orchestrator({
			platform: EXE_DEV_PLATFORM,
			exec,
			repo,
			env: (name) => process.env[name],
			store: fileAdmissionStore(stateDir),
			files: fileRunFiles(stateDir),
			executor,
			cadence,
			clock: { now: () => now },
			scope: null,
			log: () => undefined,
		});

		const report = await controller.tick();
		assert.equal(report.runs.length, 0);
		assert.equal(cadence.pending, true);
		assert.equal(github.creates, 0);
		await cadence.wait();
	});
});

it("one-shot CLI reserves only locally owned claims and keeps unreadable admissions conservative", async (t) => {
	for (const ownership of ["absent", "admitted", "unreadable"] as const) {
		const stateDir = directory(t);
		const github = new GitHubFixture();
		const files = fileRunFiles(stateDir);

		for (let issue = 200; issue < 216; issue++) {
			assert.equal(
				await files.writeClaim({
					runId: digestOf(JSON.stringify(["github", repo, issue, "1"])),
					issue,
					eventId: "1",
					seq: 3,
					status: issue < 214 ? "released" : "retrying",
					stage: "specify",
					attempt: 1,
					usage: 0,
				}),
				true,
			);
		}

		for (const issue of [214, 215]) {
			if (ownership === "admitted") await admitClaim(stateDir, issue);

			if (ownership === "unreadable") {
				const dir = join(stateDir, "admissions/github", repo, String(issue));
				mkdirSync(dir, { recursive: true, mode: 0o700 });
				writeFileSync(join(dir, "1.json"), "{invalid");
			}

			assert.equal(
				(await fileAdmissionStore(stateDir).read({ repo, issue, eventId: "1" }))
					.kind,
				ownership === "admitted" ? "found" : ownership,
			);
		}

		assert.equal((await files.listClaims()).length, 16);

		const before = readdirSync(join(stateDir, "claims")).map((name) =>
			readFileSync(join(stateDir, "claims", name), "utf8"),
		);

		let stdout = "";

		const runtime: ControllerRuntime = {
			clock: { now: () => now },
			procs: procTable(),
			signal: new AbortController().signal,
			sleep: async () => undefined,
			executor: (context) => {
				const executor = sandboxExecutor({
					...context,
					root: join(stateDir, "absent-bundle"),
					xdgRuntimeDir:
						process.env.XDG_RUNTIME_DIR ?? `/run/user/${process.getuid?.()}`,
				});

				executor.recover = async () => undefined;
				executor.reconciled = async () => true;
				executor.preflight = async () => false;

				return executor;
			},
		};

		assert.equal(
			await runCli(
				[
					"cadence",
					"--once",
					"--job",
					"architecture",
					"--json",
					"--repo",
					repo,
					"--state-dir",
					stateDir,
				],
				{
					readPlatformFile: noPlatformFile,
					exec: github.exec,
					env: controllerEnv((name) => process.env[name]),
					runtime,
					stdout: (text) => {
						stdout += text;
					},
					stderr: () => undefined,
				},
			),
			1,
			"preflight prevents model work while the CLI reports real reservation capacity",
		);
		assert.equal(
			objectOf(parseJson(stdout))?.capacity,
			ownership === "absent" ? 2 : 0,
			ownership,
		);
		assert.deepEqual(
			readdirSync(join(stateDir, "claims")).map((name) =>
				readFileSync(join(stateDir, "claims", name), "utf8"),
			),
			before,
			"one-shot does not reconcile or dispatch ticket work",
		);
	}
});

it("evaluates healthy, not-due cadence through real Orchestrator.tick under 100 ms", async (t) => {
	const stateDir = directory(t);
	const github = new GitHubFixture();

	for (const job of ["architecture", "security"] as const) {
		seed(stateDir, input(job), result(input(job), []));
		await settle(runner(stateDir, github), job);
	}

	const executor = sandboxExecutor({
		platform: EXE_DEV_PLATFORM,
		stateDir,
		exec: withoutStageScopes(github.exec),
		root: join(stateDir, "absent-bundle"),
		xdgRuntimeDir: `/run/user/${process.getuid?.()}`,
		log: () => undefined,
	});

	executor.preflight = async () => true;

	const cadence = controllerCadence({
		platform: EXE_DEV_PLATFORM,
		stateDir,
		repo,
		exec: github.exec,
		executor,
		log: () => undefined,
	});

	const controller = new Orchestrator({
		platform: EXE_DEV_PLATFORM,
		exec: github.exec,
		repo,
		env: (name) => process.env[name],
		store: fileAdmissionStore(stateDir),
		files: fileRunFiles(stateDir),
		executor,
		cadence,
		clock: { now: () => now },
		scope: null,
		log: () => undefined,
	});

	await controller.tick();
	const started = performance.now();

	for (let n = 0; n < 20; n++) {
		const report = await controller.tick();
		assert.equal(report.dispatch.enabled, true);
		assert.equal(report.active, 0);
	}

	const perTick = (performance.now() - started) / 20;
	assert.ok(perTick < 100, `${perTick} ms per healthy idle orchestrator tick`);
	assert.equal(cadence.pending, false);
	assert.equal(cadenceCharges(stateDir, repo).length, 2);
	t.diagnostic(`healthy idle Orchestrator.tick ${perTick} ms/call; no models`);
});

function withoutStageScopes(exec: Exec): Exec {
	return async (command, args) => {
		if (command !== "systemctl") return exec(command, args);
		assert.deepEqual([command, ...args], listScopesArgv());

		return { code: 0, stdout: "", stderr: "" };
	};
}

async function nativeBundle(
	t: TestContext,
	root: string,
): Promise<string | null> {
	if (!nativeUserScope(t)) return null;

	const sourceRoot = new URL("..", import.meta.url).pathname;
	const bundle = join(root, "staging");

	for (const path of [
		"node/bin",
		"bin",
		"sandbox",
		"etc",
		"pkg",
		"pi-agent",
		"skills",
	])
		mkdirSync(join(bundle, path), { recursive: true, mode: 0o700 });
	copyFileSync(process.execPath, join(bundle, "node/bin/node"));

	const copied = await execFile(
		"cp",
		["-al", join(sourceRoot, "node_modules"), join(bundle, "pkg/node_modules")],
		30_000,
	);

	assert.equal(copied.code, 0);

	for (const name of ["pi.ts", "stage-init.ts"])
		copyFileSync(
			join(sourceRoot, "server/sandbox/assets", name),
			join(bundle, "sandbox", name),
		);
	cpSync(join(sourceRoot, "skills"), join(bundle, "skills"), {
		recursive: true,
	});
	writeFileSync(
		join(bundle, "bin/pi"),
		'#!/bin/sh\nexec /opt/factory/node/bin/node /opt/factory/sandbox/pi.ts "$@"\n',
		{ mode: 0o700 },
	);
	writeFileSync(
		join(bundle, "etc/passwd"),
		"root:x:0:0:root:/root:/bin/sh\nagent:x:1000:1000:agent:/home/agent:/bin/bash\n",
	);
	writeFileSync(join(bundle, "etc/group"), "root:x:0:\nagent:x:1000:\n");
	writeFileSync(join(bundle, "etc/hosts"), "127.0.0.1 localhost\n");
	writeFileSync(join(bundle, "etc/resolv.conf"), "nameserver 127.0.0.1\n");
	writeFileSync(
		join(bundle, "pi-agent/models.json"),
		JSON.stringify({
			providers: {
				openai: {
					baseUrl: "http://127.0.0.1:18080/openai/v1",
					apiKey: "fixture-not-a-key",
				},
			},
		}),
	);
	writeFileSync(
		join(bundle, "pi-agent/settings.json"),
		JSON.stringify({ defaultProvider: "openai", defaultModel: "gpt-6.1-sol" }),
	);
	const digest = await manifestDigest(bundle);
	assert.ok(digest);
	renameSync(bundle, join(root, `assets-${digest}`));
	symlinkSync(`assets-${digest}`, join(root, "current"));

	return digest;
}

it("native cadence --once dedup demo: real Pi/RPC, bwrap, user scope, gateway and receipts; fake only GitHub and model upstream", {
	timeout: 120_000,
}, async (t) => {
	const root = directory(t);
	const assets = await nativeBundle(t, root);

	if (assets === null) return;
	const stateDir = join(root, "s");
	mkdirSync(stateDir, { mode: 0o700 });
	const github = new GitHubFixture();

	const findings = [
		finding(),
		finding(input(), digestOf("second native finding")),
	];

	let answer = JSON.stringify({ proposals: findings });
	let reflectExpected = false;
	let expectedFingerprint: string | null = null;
	let modelRequests = 0;
	let injectedTokens = 16;
	let release: () => void = () => undefined;
	let arrived: () => void = () => undefined;

	let hold = new Promise<void>((done) => {
		release = done;
	});

	const requestArrived = new Promise<void>((done) => {
		arrived = done;
	});

	const server = createServer((req, res) => {
		if (req.headers.host !== "cadence.fixture") {
			res.writeHead(404).end();

			return;
		}

		let body = "";
		req.on("data", (chunk: Buffer) => {
			body += chunk.toString();
		});
		req.on("end", () => {
			void (async () => {
				assert.equal(req.url, "/openai/v1/responses");
				const request = objectOf(parseJson(body));

				const tools =
					arrayOf(request?.tools) ??
					(arrayOf(request?.input) ?? []).flatMap(
						(item) => arrayOf(objectOf(item)?.tools) ?? [],
					);

				assert.deepEqual(
					tools,
					[],
					"single-pass audit has no tool definitions",
				);
				assert.ok(
					body.includes("1: export const first = 1;"),
					"controller delivers numbered source in the sole request",
				);

				if (reflectExpected) {
					assert.ok(body.includes("Reflect on factory evidence"));
					assert.ok(body.includes("Specify an improvement experiment"));
					assert.ok(body.includes("scoredRunId"));
					assert.ok(body.includes("redactedReceiptDigests"));
				}

				if (expectedFingerprint !== null)
					assert.ok(
						body.includes(expectedFingerprint),
						"model receives this job's existing proposal fingerprints before launch",
					);
				modelRequests++;
				arrived();
				await hold;

				const item = {
					type: "message",
					id: "msg_cadence",
					role: "assistant",
					status: "completed",
					content: [{ type: "output_text", text: answer, annotations: [] }],
				};

				const response = {
					id: "resp_cadence",
					object: "response",
					status: "completed",
					model: "gpt-6.1-sol",
					output: [item],
					usage: {
						input_tokens: injectedTokens - 5,
						output_tokens: 5,
						total_tokens: injectedTokens,
						input_tokens_details: { cached_tokens: 0 },
					},
				};

				const events = [
					{
						type: "response.created",
						response: { ...response, status: "in_progress", output: [] },
					},
					{
						type: "response.output_item.added",
						output_index: 0,
						item: { ...item, status: "in_progress", content: [] },
					},
					{
						type: "response.content_part.added",
						output_index: 0,
						content_index: 0,
						part: { type: "output_text", text: "", annotations: [] },
					},
					{
						type: "response.output_text.delta",
						output_index: 0,
						content_index: 0,
						delta: answer,
					},
					{ type: "response.output_item.done", output_index: 0, item },
					{ type: "response.completed", response },
				];

				res.writeHead(200, { "Content-Type": "text/event-stream" });
				res.end(
					events
						.map(
							(event) =>
								`event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`,
						)
						.join(""),
				);
			})().catch((error) => {
				stderr += `model fixture: ${String(error)}\n`;
				res.destroy(error);
			});
		});
	});

	await new Promise<void>((done) => server.listen(0, "127.0.0.1", done));
	t.after(
		() =>
			new Promise<void>((done) => {
				server.close(() => done());
				server.closeAllConnections();
			}),
	);
	const address = server.address();
	assert.ok(address !== null && address instanceof Object);
	const port = address.port;

	mkdirSync(join(root, "fixture/repo/src"), { recursive: true });
	writeFileSync(
		join(root, "fixture/repo/src/example.ts"),
		"export const first = 1;\nexport const second = 2;\n",
	);
	assert.equal(
		(
			await execFile(
				"tar",
				[
					"-czf",
					join(root, "snapshot.tgz"),
					"-C",
					join(root, "fixture"),
					"repo",
				],
				10_000,
			)
		).code,
		0,
	);

	const runtime: ControllerRuntime = {
		clock: { now: () => now },
		procs: procTable(),
		signal: new AbortController().signal,
		sleep: async (ms, signal) => {
			await delay(ms, undefined, { signal }).catch(() => undefined);
		},
		executor: (context) =>
			sandboxExecutor({
				...context,
				root,
				xdgRuntimeDir:
					process.env.XDG_RUNTIME_DIR ?? `/run/user/${process.getuid?.()}`,
				fetchTarball: async () => readFileSync(join(root, "snapshot.tgz")),
				host: (config) =>
					sandboxHost({
						...config,
						gateway: (spec) => {
							assert.deepEqual(
								spec.table.routes.map((route) => route.id),
								["model-openai"],
							);

							return startGatewayProcess({
								...spec,
								testMode: true,
								table: {
									...spec.table,
									routes: spec.table.routes.map((route) => ({
										...route,
										upstream: {
											...route.upstream,
											scheme: "http",
											host: "cadence.fixture",
											port,
											hostHeader: "cadence.fixture",
											sni: "cadence.fixture",
											address: { kind: "pinned", ip: "127.0.0.1" },
										},
									})),
								},
							});
						},
					}),
			}),
	};

	const argv = [
		"cadence",
		"--once",
		"--job",
		"architecture",
		"--json",
		"--repo",
		repo,
		"--state-dir",
		stateDir,
	];

	let stdout = "",
		stderr = "";

	const io = {
		readPlatformFile: noPlatformFile,
		exec: github.exec,
		env: controllerEnv((name: string) => process.env[name]),
		runtime,
		stdout: (text: string) => {
			stdout += text;
		},
		stderr: (text: string) => {
			stderr += text;
		},
	};

	const started = performance.now();
	const first = runCli(argv, io);
	await Promise.race([
		requestArrived,
		first.then((code) => {
			if (modelRequests > 0) return;

			const path = join(
				cadenceExecutionDir(stateDir, "architecture", input().windowStart),
				"runtime",
			);

			const diagnostics = existsSync(path)
				? readdirSync(path)
						.filter(
							(name) =>
								name.endsWith(".log") ||
								name.endsWith(".jsonl") ||
								name === "receipt.json",
						)
						.map((name) => `${name}: ${readFileSync(join(path, name), "utf8")}`)
						.join("\n")
				: "no runtime";

			throw new Error(
				`native exited ${code}: ${stdout}\n${stderr}\n${diagnostics}`,
			);
		}),
		delay(45_000, undefined, { ref: false }).then(() => {
			throw new Error(`native request missing: ${stderr}`);
		}),
	]);
	assert.equal(github.creates, 0);
	const execution = input();
	assert.ok(
		existsSync(
			join(
				cadenceExecutionDir(stateDir, "architecture", execution.windowStart),
				"input.json",
			),
		),
		"ownership durable before model request",
	);
	assert.equal(
		await runCli(argv, {
			...io,
			stdout: () => undefined,
			stderr: () => undefined,
		}),
		2,
		"same lock excludes overlapping one-shots",
	);
	release();
	const code = await first;
	assert.equal(code, 0, `${stdout}\n${stderr}`);
	assert.equal(github.creates, 2, stdout);
	assert.equal(modelRequests, 1);
	assert.equal(await runCli(argv, io), 0, `${stdout}\n${stderr}`);
	assert.equal(github.creates, 2);
	assert.equal(modelRequests, 1, "same job/window never replays model work");

	for (const issue of github.issues)
		assert.deepEqual(issue.labels, [{ name: "factory:proposed" }]);

	const dir = cadenceExecutionDir(
		stateDir,
		"architecture",
		execution.windowStart,
	);

	assert.equal(
		readFileSync(join(dir, "tree/src/example.ts"), "utf8"),
		"export const first = 1;\nexport const second = 2;\n",
	);
	assert.equal(statSync(join(dir, "runtime/receipt.json")).mode & 0o777, 0o600);
	assert.equal(statSync(join(stateDir, "cadence")).mode & 0o777, 0o700);
	assert.equal(existsSync(join(stateDir, "claims")), false);
	assert.equal(existsSync(join(stateDir, "ledger")), false);
	assert.equal(cadenceCharges(stateDir, repo)[0]?.tokens, 16);

	const receipt = objectOf(
		parseJson(readFileSync(join(dir, "runtime/receipt.json"), "utf8")),
	);

	assert.equal(receipt?.stage, "maintain");
	assert.equal(receipt?.runId, execution.runId);
	assert.equal(receipt?.assetsDigest, assets);
	const roots = readdirSync(join(stateDir, "stages"));
	assert.ok(roots.every((name) => name === execution.runId));
	t.diagnostic(
		JSON.stringify({
			demo: "cadence --once --job architecture",
			firstCreated: 2,
			secondCreated: 0,
			modelRequests,
			tokens: 16,
			assets,
			wallMs: performance.now() - started,
			fake: ["GitHub", "model upstream"],
			native: [
				"CLI",
				"controller lock",
				"sandbox executor",
				"Pi RPC",
				"bwrap",
				"systemd scope",
				"gateway",
				"receipt",
				"dedup",
			],
		}),
	);

	const socketPath = join(root, "probe.sock");
	const socket = createUnixServer();
	await new Promise<void>((done) => socket.listen(socketPath, done));
	t.after(() => new Promise<void>((done) => socket.close(() => done())));
	const arch = detectArch(process.arch);
	assert.ok(arch);

	const probe = launchSandbox({
		stateDir,
		bundleDir: join(root, `assets-${assets}`),
		workspace: join(dir, "tree"),
		runId: digestOf("read-only probe"),
		stage: "maintain",
		attempt: 1,
		tools: [],
		arch,
		xdgRuntimeDir:
			process.env.XDG_RUNTIME_DIR ?? `/run/user/${process.getuid?.()}`,
		agentDir: join(root, "probe-agent"),
		socketPath,
		command: ["/bin/bash", "-c", "printf changed > /workspace/src/example.ts"],
	});

	assert.ok(probe);
	let probeError = "";
	probe.child.stderr?.on("data", (chunk: Buffer) => {
		probeError += chunk.toString();
	});
	assert.notEqual(
		await new Promise<number | null>((done) => probe.child.once("exit", done)),
		0,
	);
	assert.match(probeError, /Read-only file system/);
	assert.equal(
		readFileSync(join(dir, "tree/src/example.ts"), "utf8"),
		"export const first = 1;\nexport const second = 2;\n",
	);

	const fullState = join(root, "full");
	mkdirSync(join(fullState, "claims"), { recursive: true, mode: 0o700 });

	for (const issue of [200, 201]) {
		const runId = digestOf(JSON.stringify(["github", repo, issue, "1"]));
		writeCadenceFile(
			join(fullState, "claims", `${runId}.json`),
			JSON.stringify({
				runId,
				issue,
				eventId: "1",
				seq: null,
				status: null,
				stage: null,
				attempt: null,
				usage: null,
			}),
		);
	}

	for (const issue of [200, 201]) await admitClaim(fullState, issue);

	let fullOutput = "";
	assert.equal(
		await runCli([...argv.slice(0, -1), fullState], {
			...io,
			stdout: (text) => {
				fullOutput += text;
			},
		}),
		1,
	);
	assert.equal(
		objectOf(parseJson(fullOutput))?.capacity,
		0,
		"two retained ticket reservations fill both shared slots",
	);
	assert.equal(existsSync(join(fullState, "cadence")), false);
	assert.equal(modelRequests, 1);
	cpSync(join(fullState, "claims"), join(stateDir, "claims"), {
		recursive: true,
	});
	cpSync(join(fullState, "admissions"), join(stateDir, "admissions"), {
		recursive: true,
	});
	assert.equal(
		await runCli(argv, io),
		0,
		"an already completed window succeeds even with ticket capacity full",
	);
	assert.equal(modelRequests, 1);

	const disabledState = join(root, "disabled");
	mkdirSync(disabledState, { mode: 0o700 });
	writeFileSync(join(disabledState, "disabled"), "");
	assert.equal(await runCli([...argv.slice(0, -1), disabledState], io), 1);
	assert.equal(modelRequests, 1, "switch checked before model launch");
	assert.equal(existsSync(join(disabledState, "cadence")), false);

	const scheduledState = join(root, "scheduled");
	mkdirSync(scheduledState, { mode: 0o700 });

	const scheduledExecutor = runtime.executor({
		platform: EXE_DEV_PLATFORM,
		stateDir: scheduledState,
		exec: github.exec,
		log: () => undefined,
	});

	const scheduled = controllerCadence({
		platform: EXE_DEV_PLATFORM,
		stateDir: scheduledState,
		repo,
		exec: github.exec,
		executor: scheduledExecutor,
		log: () => undefined,
	});

	t.after(() => scheduled.stop());
	hold = new Promise<void>((done) => {
		release = done;
	});

	const nextRequest = new Promise<void>((done) => {
		arrived = done;
	});

	const controller = new Orchestrator({
		platform: EXE_DEV_PLATFORM,
		exec: github.exec,
		repo,
		env: (name) => process.env[name],
		store: fileAdmissionStore(scheduledState),
		files: fileRunFiles(scheduledState),
		executor: scheduledExecutor,
		cadence: scheduled,
		clock: runtime.clock,
		scope: null,
		log: () => undefined,
	});

	const watchdog = setTimeout(() => release(), 10_000);
	const tickStart = performance.now();
	const tickReport = await controller.tick();
	clearTimeout(watchdog);
	assert.ok(
		performance.now() - tickStart < 10_000,
		"tick must not await the retained model promise",
	);
	assert.equal(tickReport.runs.length, 0);
	assert.equal(
		tickReport.active,
		1,
		"dispatch capacity counts maintenance without a ticket run",
	);
	assert.equal(scheduled.occupied(), 1);
	await nextRequest;
	assert.equal(modelRequests, 2);
	assert.equal(github.creates, 2, "withheld model response has not published");
	release();
	await scheduled.wait();
	assert.equal(scheduled.occupied(), 0);
	assert.equal(
		github.creates,
		2,
		"same findings deduplicate even with a new local state",
	);
	t.diagnostic(
		"native read-only mount refused bash write; scheduled tick returned while real Pi awaited the withheld model response",
	);

	const fingerprint = github.issues[0]!.body.split("\n")
		.at(-1)!
		.split(" ")
		.at(-2)!;

	github.issues[0]!.state = "closed";
	github.issues[0]!.state_reason = "not_planned";
	expectedFingerprint = fingerprint;
	answer = JSON.stringify({
		proposals: [
			{
				...findings[0],
				title: "Paraphrased finding in a later audit",
				fingerprint,
			},
			{
				...findings[1],
				title: "Changed hash for an old finding",
				fingerprint: digestOf("model invented a different hash"),
			},
		],
	});
	const repeatState = join(root, "repeat");
	mkdirSync(repeatState, { mode: 0o700 });
	assert.equal(
		await runCli([...argv.slice(0, -1), repeatState], io),
		0,
		`${stdout}\n${stderr}`,
	);
	assert.equal(
		github.creates,
		2,
		"paraphrased/rekeyed findings create zero issues, including one closed as not planned",
	);
	assert.equal(modelRequests, 3);

	const mixedState = join(root, "mixed");
	mkdirSync(mixedState, { mode: 0o700 });

	const mixed = {
		...finding(),
		title: "src/maintenance/cadence.ts (policy) \\ @owner #12 GH-34",
		evidence: [
			{ path: "src/example.ts", start: 1, end: 2 },
			{ path: "src/example.ts", start: 1, end: 50 },
			{ path: "src/missing.ts", start: 1, end: 2 },
		],
	};

	answer = JSON.stringify({ proposals: [mixed] });
	assert.equal(
		await runCli([...argv.slice(0, -1), mixedState], io),
		0,
		`${stdout}\n${stderr}`,
	);
	assert.equal(github.creates, 3);
	assert.equal((github.issues[2]!.body.match(/\/blob\//g) ?? []).length, 1);
	assert.doesNotMatch(github.issues[2]!.body, /L50|missing\.ts/);
	assert.doesNotMatch(github.issues[2]!.title, /\\|@owner|#12|GH-34/);
	assert.match(
		github.issues[2]!.title,
		/src\/maintenance\/cadence\.ts \(policy\)/,
	);

	const invalidState = join(root, "invalid");
	mkdirSync(invalidState, { mode: 0o700 });
	answer = JSON.stringify({
		proposals: [
			{
				...mixed,
				title: "All invalid citations",
				evidence: mixed.evidence.slice(1),
			},
		],
	});
	assert.equal(
		await runCli([...argv.slice(0, -1), invalidState], io),
		0,
		`${stdout}\n${stderr}`,
	);
	assert.equal(
		github.creates,
		3,
		"all-invalid finding is dropped and filing completes",
	);

	const filing = objectOf(
		parseJson(
			readFileSync(
				join(
					cadenceExecutionDir(
						invalidState,
						"architecture",
						execution.windowStart,
					),
					"filing.json",
				),
				"utf8",
			),
		),
	);

	assert.equal(arrayOf(filing?.dropped)?.length, 1);
	assert.equal(arrayOf(filing?.invalidEvidence)?.length, 2);
	assert.equal(modelRequests, 5);
	t.diagnostic(
		JSON.stringify({
			extendedNativeDemo: {
				firstCreated: 2,
				paraphrasedRepeatCreated: 0,
				partialEvidenceCreated: 1,
				allInvalidCreated: 0,
				filingComplete: true,
				modelRequests,
			},
			fake: ["GitHub", "model upstream"],
		}),
	);

	const retryState = join(root, "prelaunch");
	mkdirSync(retryState, { mode: 0o700 });
	let retryNow = now;
	let refuseLaunch = true;
	answer = '{"proposals":[]}';

	const retryRuntime: ControllerRuntime = {
		...runtime,
		clock: { now: () => retryNow },
		executor: (context) => {
			const executor = runtime.executor(context);
			const launch = executor.launch.bind(executor);
			executor.launch = async (request) => {
				if (refuseLaunch)
					return {
						kind: "unavailable",
						stage: request.stage,
						reason: "sandbox_unavailable",
					};

				return launch(request);
			};

			return executor;
		},
	};

	const retryIo = { ...io, runtime: retryRuntime };
	const retryArgv = [...argv.slice(0, -1), retryState];
	assert.equal(await runCli(retryArgv, retryIo), 1);
	assert.equal(modelRequests, 5, "failed launch spends no model request");
	refuseLaunch = false;
	retryNow += 10_000;
	assert.equal(await runCli(retryArgv, retryIo), 0, `${stdout}\n${stderr}`);
	assert.equal(modelRequests, 6);
	assert.equal(
		readFileSync(
			join(
				cadenceExecutionDir(retryState, "architecture", execution.windowStart),
				"tree/src/example.ts",
			),
			"utf8",
		),
		"export const first = 1;\nexport const second = 2;\n",
	);
	t.diagnostic(
		"native zero-work launch refusal retried after backoff with its pinned checkout intact; no weekly slot lost",
	);

	injectedTokens = 40_001;

	for (const [name, output, expected] of [
		["capped-empty", '{"proposals":[]}', 0],
		[
			"capped-finding",
			JSON.stringify({
				proposals: [{ ...finding(), title: "Valid capped finding" }],
			}),
			0,
		],
		["capped-invalid", '{"proposals":[', 1],
	] as const) {
		const cappedState = join(root, name);

		mkdirSync(cappedState, { mode: 0o700 });
		answer = output;
		assert.equal(
			await runCli([...argv.slice(0, -1), cappedState], io),
			expected,
			`${stdout}\n${stderr}`,
		);

		const cappedDir = cadenceExecutionDir(
			cappedState,
			"architecture",
			execution.windowStart,
		);

		const native = objectOf(
			parseJson(readFileSync(join(cappedDir, "runtime/receipt.json"), "utf8")),
		);

		assert.deepEqual(native?.outcome, {
			kind: "budget_exhausted",
			cap: "tokens",
		});
		assert.equal(
			readFileSync(join(cappedDir, "runtime/output.txt"), "utf8"),
			output,
		);

		const cadenceReceipt = objectOf(
			parseJson(readFileSync(join(cappedDir, "receipt.json"), "utf8")),
		);

		assert.equal(
			cadenceReceipt?.reason,
			expected === 0 ? "answered_at_cap" : "budget_exhausted",
		);
		assert.equal(cadenceCharges(cappedState, repo)[0]?.tokens, injectedTokens);
		assert.equal(
			await runCli([...argv.slice(0, -1), cappedState], io),
			expected,
		);
	}

	assert.equal(
		github.creates,
		4,
		"valid capped finding is filed; invalid capped JSON is not",
	);
	t.diagnostic(
		"native maintain answers retained at the cap: valid empty/finding settled, malformed JSON failed; cap and full usage retained in native receipt",
	);

	const reflectState = join(root, "reflect");
	mkdirSync(reflectState, { mode: 0o700 });
	const row = seedReflectionLedger(reflectState);
	const score = failingScore(1, row.runId);
	enqueueScore(reflectState, score);
	const reflectInput = input("reflect");
	answer = JSON.stringify({
		proposals: [
			{
				...finding(reflectInput),
				baseline: "A failing run and score are recorded.",
				change: "Propose a bounded experiment against that failure.",
				keepOrReject:
					"Reject primary regression; unknown primary effect is not improvement.",
				evidence: [
					{ path: `ledger/${row.runId}/outcome`, start: 1, end: 1 },
					{ path: `scores/${score.id}`, start: 1, end: 1 },
				],
			},
		],
	});
	injectedTokens = 16;
	expectedFingerprint = null;
	reflectExpected = true;

	const reflectArgv = [
		"cadence",
		"--once",
		"--job",
		"reflect",
		"--repo",
		repo,
		"--state-dir",
		reflectState,
	];

	const beforeReflect = github.creates;
	assert.equal(await runCli(reflectArgv, io), 0, `${stdout}\n${stderr}`);
	assert.equal(github.creates - beforeReflect, 1);
	const reflected = github.issues.at(-1)!;
	assert.ok(reflected.body.includes(`ledger/${row.runId}/outcome`));
	assert.ok(reflected.body.includes(`scores/${score.id}`));
	const reflectRequests = modelRequests;
	assert.equal(await runCli(reflectArgv, io), 0);
	assert.equal(modelRequests, reflectRequests);
	assert.equal(github.creates - beforeReflect, 1);

	// A fresh state forces a second answer rather than the completed-window shortcut.
	const reflectFresh = join(root, "reflect-fresh");
	mkdirSync(reflectFresh, { mode: 0o700 });
	seedReflectionLedger(reflectFresh);
	enqueueScore(reflectFresh, score);
	reflected.state = "closed";
	expectedFingerprint = reflected.body.split("\n").at(-1)!.split(" ").at(-2)!;
	const repeated = objectOf(parseJson(answer));
	const repeatedProposals = arrayOf(repeated?.proposals) ?? [];
	answer = JSON.stringify({
		proposals: repeatedProposals.map((proposal) => ({
			...objectOf(proposal),
			fingerprint: expectedFingerprint,
			title: "Same experiment, fresh answer",
		})),
	});

	const freshArgv = reflectArgv.map((arg) =>
		arg === reflectState ? reflectFresh : arg,
	);

	assert.equal(await runCli(freshArgv, io), 0, `${stdout}\n${stderr}`);
	assert.equal(
		modelRequests,
		reflectRequests + 1,
		"a fresh model answer actually runs",
	);
	assert.equal(
		github.creates - beforeReflect,
		1,
		"fresh reflect answer deduplicates the closed finding",
	);
	expectedFingerprint = null;

	const triggerState = join(root, "trigger");
	mkdirSync(triggerState, { mode: 0o700 });
	github.workflowSource = improvementWorkflow.replace(
		/cadence:\n[\s\S]*?\nstages:/,
		"stages:",
	);

	for (let seq = 0; seq < 25; seq++) {
		const event = failingScore(seq);
		enqueueScore(triggerState, event);
		writeCadenceFile(
			join(triggerState, "measure/score-outbox", event.id, "published.json"),
			JSON.stringify({ tip: sha, line: seq + 1 }),
		);
	}

	writeCadenceFile(
		join(triggerState, "measure/score-outbox/anchor.json"),
		JSON.stringify({
			v: 1,
			rootSha: sha,
			tipSha: sha,
			blobSha: sha,
			byteLength: 0,
			prefixDigest: digestOf(""),
		}),
	);

	const triggerArgv = [
		"tick",
		"--once",
		"--json",
		"--repo",
		repo,
		"--state-dir",
		triggerState,
	];

	const beforeTrigger = github.creates;

	for (let pass = 0; pass < 3; pass++) {
		assert.equal(await runCli(triggerArgv, io), 0, `${stdout}\n${stderr}`);
		assert.equal(github.creates - beforeTrigger, 1);

		if (pass === 1) github.issues.at(-1)!.state = "closed";
	}

	assert.equal(
		modelRequests,
		reflectRequests + 1,
		"deterministic trigger never launches a model",
	);
	assert.equal(
		triggerRecord(github.issues.at(-1)!.body, repo)?.runs.length,
		25,
	);
	assert.ok(github.issues.at(-1)!.body.includes(failingScore(24).id));
	assert.deepEqual(github.issues.at(-1)!.labels, [
		{ name: "factory:proposed" },
	]);
	t.diagnostic(
		JSON.stringify({
			demo: "F12c native reflect and trigger",
			reflectCreated: [1, 0, 0],
			triggerCreated: [1, 0, 0],
			failingRuns: 25,
			fake: ["GitHub", "model upstream"],
			noTriggerModel: true,
		}),
	);
});
