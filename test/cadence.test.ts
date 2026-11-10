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
	symlinkSync,
	writeFileSync,
} from "node:fs";
import { createServer } from "node:http";
import { createServer as createUnixServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { describe, it, type TestContext } from "node:test";
import { execFile, runCli, type ControllerRuntime } from "../server/cli.ts";
import {
	controllerCadence,
	durableUsageOf,
	fileRunFiles,
	procTable,
	publishCadenceProposals,
	readDurableAccounting,
} from "../server/controller.ts";
import {
	launchSandbox,
	sandboxExecutor,
	sandboxHost,
} from "../server/sandbox.ts";
import { detectArch } from "../server/sandbox/seccomp.ts";
import { startGatewayProcess } from "../server/sandbox/gateway-client.ts";
import { manifestDigest } from "../server/sandbox/manifest.ts";
import { arrayOf, objectOf, parseJson } from "../server/sandbox/json.ts";
import { fileAdmissionStore } from "../src/admission.ts";
import {
	CadenceRunner,
	CADENCE_PATH_GROUPS,
	cadenceCharges,
	cadenceExecutionDir,
	cadenceIssueBody,
	cadenceScope,
	cadenceWindow,
	parseCadenceProposals,
	utcWeekStart,
	writeCadenceFile,
	type CadenceInput,
	type CadenceResult,
	type CadenceTick,
} from "../src/cadence.ts";
import { cadenceMarker } from "../src/markers.ts";
import { Orchestrator } from "../src/orchestrator.ts";
import { digestOf } from "../src/run.ts";
import {
	isGitSha,
	isRepoSlug,
	parseWorkflow,
	type CadenceJob,
	type Exec,
	type ExecResult,
} from "../src/workflow.ts";

function repository() {
	const value = "giuseppecrj/pi-herdr-factorio";
	assert.ok(isRepoSlug(value));

	return value;
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

function finding(
	execution = input(),
	fingerprint = digestOf("architecture finding"),
) {
	return {
		job: execution.job,
		repo,
		baseSha: sha,
		fingerprint,
		title: "A duplicated policy decision",
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
			return ok(workflow);

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
				updated_at: "2026-11-10T12:00:00Z",
			};

			this.issues.push(issue);

			return this.unknown
				? { code: 1, stdout: "", stderr: "network timeout" }
				: ok(JSON.stringify({ number: issue.number }));
		}

		if (endpoint.includes("issues?state=all"))
			return this.listFails
				? { code: 1, stdout: "", stderr: "HTTP 503" }
				: ok(JSON.stringify(this.issues));

		if (endpoint.includes("issues?state=open"))
			return ok(JSON.stringify(this.ready));
		throw new Error(`unexpected GitHub fixture request ${args.join(" ")}`);
	};
}

function runner(stateDir: string, github = new GitHubFixture()) {
	const executor = sandboxExecutor({
		stateDir,
		exec: github.exec,
		xdgRuntimeDir:
			process.env.XDG_RUNTIME_DIR ?? `/run/user/${process.getuid?.()}`,
		root: join(stateDir, "absent-bundle"),
		log: () => undefined,
	});

	return controllerCadence({
		stateDir,
		repo,
		exec: github.exec,
		executor,
		log: () => undefined,
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
			{ ...proposal, fingerprint: "../x" },
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
			),
			null,
		);
	});

	it("escapes all model text, mentions, HTML, issue references and credentials", () => {
		const proposal = {
			...finding(),
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

describe("cadence durable ownership, accounting and proposal recovery", () => {
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

	it("retains an interrupted execution's full charge and never replays it on restart", async (t) => {
		const stateDir = directory(t);
		seed(stateDir, input(), null);
		const cadence = runner(stateDir);
		await settle(cadence);
		assert.equal(cadence.status()[0]?.reason, "interrupted");
		assert.equal(cadenceCharges(stateDir, repo)[0]?.tokens, 40_000);
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
		const cadence = runner(stateDir);
		await settle(cadence);
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
			config: { ...config, weeklyTokenCap: 39_999 },
		});
		assert.equal(cadence.status()[0]?.reason, "budget");
		assert.equal(cadenceCharges(stateDir, repo).length, 0);
		assert.equal(existsSync(join(stateDir, "stages")), false);
	});

	it("charges previous maintenance separately and cannot refill a weekly budget after restart", async (t) => {
		const stateDir = directory(t);
		const security = input("security");
		seed(stateDir, security, { ...result(security, []), tokens: 40_000 });
		await settle(runner(stateDir), "security");
		const cadence = runner(stateDir);
		await settle(cadence, "architecture", {
			...tick,
			config: { ...config, weeklyTokenCap: 79_999 },
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
		await settle(restarted);
		assert.equal(restarted.pending, false);
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
			await settle(cadence);
			assert.equal(github.creates, 1);
		}
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
				stateDir,
				exec: github.exec,
				execution,
				result: result(),
				proposals: [bad],
			}),
			false,
		);
		assert.equal(github.creates, 1);
	});

	it("holds retained proposals when preflight is unavailable and evaluates idle schedules under 100 ms", async (t) => {
		const stateDir = directory(t);
		const github = new GitHubFixture();
		seed(stateDir);
		const exec = github.exec;

		const executor = sandboxExecutor({
			stateDir,
			exec,
			root: join(stateDir, "absent-bundle"),
			xdgRuntimeDir: `/run/user/${process.getuid?.()}`,
			log: () => undefined,
		});

		const cadence = controllerCadence({
			stateDir,
			repo,
			exec,
			executor,
			log: () => undefined,
		});

		// Saved-state publication needs no stage preflight or model work.
		await cadence.recover();

		const controller = new Orchestrator({
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
		const started = performance.now();

		for (let n = 0; n < 1000; n++)
			cadence.tick({ ...tick, allowed: false }, "architecture");
		const elapsed = performance.now() - started;
		assert.ok(
			elapsed / 1000 < 100,
			`${elapsed / 1000} ms per idle due evaluation`,
		);
		t.diagnostic(
			`idle cadence evaluation ${elapsed / 1000} ms/call; no models`,
		);
	});
});

async function nativeBundle(
	t: TestContext,
	root: string,
): Promise<string | null> {
	const probe = await execFile(
		"systemd-run",
		["--user", "--scope", "--quiet", "true"],
		10_000,
	);

	if (probe.code !== 0) {
		assert.notEqual(
			process.env.FACTORY_REQUIRE_SANDBOX_TESTS,
			"1",
			"real user scopes required for cadence demo",
		);
		t.skip(
			"native cadence requires the user systemd bus; mandatory under FACTORY_REQUIRE_SANDBOX_TESTS=1",
		);

		return null;
	}

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

	const answer = JSON.stringify({ proposals: findings });
	let modelRequests = 0;
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

				assert.deepEqual(tools.map((tool) => objectOf(tool)?.name).sort(), [
					"grep",
					"ls",
					"read",
				]);
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
						input_tokens: 11,
						output_tokens: 5,
						total_tokens: 16,
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
		exec: github.exec,
		env: (name: string) => process.env[name],
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
		tools: ["read", "grep", "ls"],
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

	const disabledState = join(root, "disabled");
	mkdirSync(disabledState, { mode: 0o700 });
	writeFileSync(join(disabledState, "disabled"), "");
	assert.equal(await runCli([...argv.slice(0, -1), disabledState], io), 1);
	assert.equal(modelRequests, 1, "switch checked before model launch");
	assert.equal(existsSync(join(disabledState, "cadence")), false);

	const scheduledState = join(root, "scheduled");
	mkdirSync(scheduledState, { mode: 0o700 });

	const scheduledExecutor = runtime.executor({
		stateDir: scheduledState,
		exec: github.exec,
		log: () => undefined,
	});

	const scheduled = controllerCadence({
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
});
