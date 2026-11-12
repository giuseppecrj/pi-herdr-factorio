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
	symlinkSync,
	writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createServer } from "node:http";
import { it, type TestContext } from "node:test";
import {
	measurementInput,
	explainPrompt,
	explainFindings,
	EXPLAIN_MAX_TOKENS,
	EXPLAIN_WALL_MS,
} from "../src/explain.ts";
import {
	measurementPrimary,
	primaryMetricText,
	computeMetrics,
} from "../src/metrics.ts";
import {
	parseLedger,
	ledgerRowOf,
	latestScores,
	ledgerApiOf,
	parseScores,
	scoreEventOf,
} from "../src/ledger.ts";
import {
	allocateMeasurement,
	scoreHistory,
	sampled,
	enqueueScore,
	scorerPrompt,
} from "../src/scorers.ts";
import { fileAdmissionStore, snapshotDigest } from "../src/admission.ts";
import {
	contractBytes,
	contractDigestOf,
	type Contract,
} from "../src/specify.ts";
import { digestOf } from "../src/run.ts";
import { runCli, execFile, type ControllerRuntime } from "../server/cli.ts";
import {
	controllerMeasurements,
	controllerMeasure,
	pumpScoreOutbox,
	durableUsageOf,
	procTable,
	readDurableAccounting,
	measurementCharges,
	fileRunFiles,
} from "../server/controller.ts";
import { sandboxExecutor, sandboxHost } from "../server/sandbox.ts";
import { manifestDigest } from "../server/sandbox/manifest.ts";
import { startGatewayProcess } from "../server/sandbox/gateway-client.ts";
import { objectOf, parseJson, arrayOf } from "../server/sandbox/json.ts";
import { parseWorkflow } from "../src/workflow.ts";
import { GitHubPublicationApi, SCORE_FILE } from "../src/publication.ts";
import { LedgerGit, repo } from "./ledger-git.ts";
import { EXE_DEV_PLATFORM } from "../src/platform.ts";
import { trustedWorkflowFor } from "./fake-ticket-adapter.ts";
import { nativeUserScope } from "./native-scope.ts";

// The frozen ledger rows were recorded under the fixture repository's name.
const workflow = trustedWorkflowFor(repo);

const ledgerFixture = readFileSync(
	new URL("fixtures/metrics/runs-2026-11-08.jsonl", import.meta.url),
);

const known = parseLedger(ledgerFixture).filter(
	(line) => line.kind === "known",
);

const finished = known[0]!;

const failed = known.find(
	(line) =>
		line.row.outcome.kind === "failed" && line.row.artifacts.kind === "built",
)!;

assert.ok(failed);

function directory(t: TestContext) {
	const path = mkdtempSync(join(tmpdir(), "m12-"));
	t.after(() => rmSync(path, { recursive: true, force: true }));

	return path;
}

function seed(
	stateDir: string,
	source = finished,
	paths: readonly string[] = ["src/tickets.ts"],
) {
	const runId = source.row.runId;
	const root = join(stateDir, "ledger", runId);
	mkdirSync(root, { recursive: true, mode: 0o700 });

	const receipt = {
		version: 1,
		runId,
		childSummaries: [
			{
				id: digestOf("child"),
				tokens: 200,
				byModel: { "openai/gpt-6.1-sol": 200 },
			},
		],
		stage: "build",
		attempt: 1,
		outcome: { kind: "failed", exit: "error" },
		wallMs: 10,
		turns: 1,
		models: { requested: "openai/gpt-6.1-sol", observed: "gpt-6.1-sol" },
		usage: {
			total: 1000,
			parent: 800,
			children: 200,
			gateway: 1000,
			unreadChildren: 0,
			byModel: { "openai/gpt-6.1-sol": 1000 },
		},
	};

	const raw = `${JSON.stringify(receipt)}\n`;

	const row = ledgerRowOf({
		...source.row,
		redactedReceiptDigests: [digestOf(raw)],
	});

	writeFileSync(join(root, "row.json"), row.bytes, { mode: 0o600 });
	const stage = join(stateDir, "stages", runId, "build-1");
	mkdirSync(stage, { recursive: true, mode: 0o700 });
	writeFileSync(join(stage, "receipt.json"), raw, { mode: 0o600 });
	writeFileSync(join(stage, "output.txt"), "RAW_OUTPUT_SENTINEL");
	writeFileSync(join(stage, "pi-stderr-1.log"), "STDERR_SENTINEL");
	mkdirSync(join(stage, "agent-1/sessions"), { recursive: true });
	writeFileSync(
		join(stage, "agent-1/sessions/private.jsonl"),
		"PRIVATE_TRANSCRIPT_SENTINEL",
	);

	if (source.row.artifacts.kind === "built") {
		const dir = join(stateDir, "patches", runId);
		mkdirSync(dir, { recursive: true, mode: 0o700 });
		const patch = `${JSON.stringify({ version: 1, runId, patchDigest: source.row.artifacts.patchDigest, changedPaths: paths })}\n`;
		writeFileSync(join(dir, "collected.json"), patch, { mode: 0o600 });
		writeFileSync(join(stateDir, "patches", `${runId}.json`), patch, {
			mode: 0o600,
		});
	}

	return row;
}

async function seedContract(
	stateDir: string,
	body = "ADMITTED_BODY: return a safe result.",
) {
	const frozen = seed(stateDir, failed);
	const snapshot = { title: "ADMITTED_TITLE", body };

	const contract: Contract = {
		version: 2,
		runId: frozen.row.runId,
		issue: frozen.row.issue,
		base: { repo, sha: frozen.row.originalBase },
		snapshot: {
			digest: snapshotDigest(snapshot),
			source: "unedited",
			eventId: frozen.row.eventId,
			eventAt: "2026-11-10T10:00:00Z",
		},
		link: null,
		summary: "Deliver a safe result",
		behavior: ["Return a safe result"],
		acceptance: [
			{
				id: "A1",
				kind: "new_behavior",
				text: "ACCEPTED_CRITERION: safe output",
			},
		],
		exclusions: [],
		compatibility: [],
		limits: [],
		files: [],
		evidence: [],
	};

	const bytes = contractBytes(contract);
	const digest = contractDigestOf(bytes);
	assert.equal(
		await fileRunFiles(stateDir).writeContract({ contract, bytes, digest }),
		true,
	);
	await fileAdmissionStore(stateDir).record(
		{
			decision: "admitted",
			repo,
			issue: contract.issue,
			issueUrl: `https://github.com/${repo}/issues/${contract.issue}`,
			reasons: [],
			eventId: contract.snapshot.eventId,
			eventAt: contract.snapshot.eventAt,
			actor: "owner",
			actorPermission: "write",
			snapshotDigest: contract.snapshot.digest,
			snapshotSource: "unedited",
			baseSha: contract.base.sha,
			workflowDigest: digestOf(workflow),
		},
		snapshot,
	);
	assert.ok(frozen.row.artifacts.kind === "built");

	const row = ledgerRowOf({
		...frozen.row,
		snapshotDigest: contract.snapshot.digest,
		artifacts: { ...frozen.row.artifacts, contractDigest: digest },
	});

	writeFileSync(
		join(stateDir, "ledger", row.row.runId, "row.json"),
		row.bytes,
		{ mode: 0o600 },
	);
	const heldout = join(stateDir, "acceptance", row.row.runId);
	mkdirSync(heldout, { recursive: true, mode: 0o700 });
	writeFileSync(join(heldout, "suite.json"), "HELDOUT_SUITE_SENTINEL", {
		mode: 0o600,
	});

	return row;
}

it("score input contains only bounded, digest-bound admitted contract excerpts and accepted criteria, never held-out tests", async (t) => {
	const state = directory(t);

	const row = await seedContract(
		state,
		`ADMITTED_BODY\n\`\`\`\n${"é".repeat(10000)}`,
	);

	const input = await measurementInput(state, row.row.runId, true, true);
	assert.match(input.bytes, /ADMITTED_TITLE/);
	assert.match(input.bytes, /ADMITTED_BODY/);
	assert.match(input.bytes, /ACCEPTED_CRITERION/);
	assert.equal(input.input.contract?.issue.body?.truncated, true);
	assert.match(input.input.contract?.issue.body?.text ?? "", /^```untrusted\n/);
	assert.doesNotMatch(
		input.bytes,
		/HELDOUT_SUITE_SENTINEL|PRIVATE_TRANSCRIPT_SENTINEL|RAW_OUTPUT_SENTINEL|STDERR_SENTINEL/,
	);

	const parsed = parseWorkflow({
		platform: EXE_DEV_PLATFORM,
		text: workflow,
		repo,
		env: (name) => process.env[name],
	});

	assert.ok(parsed.kind === "valid");
	assert.match(
		scorerPrompt(parsed.config.scorers![0]!, input),
		/ACCEPTED_CRITERION/,
	);
	assert.equal(
		(await measurementInput(state, row.row.runId)).input.contract,
		null,
	);
	writeFileSync(
		join(state, "contracts", row.row.runId, "contract.json"),
		"{}",
		{ mode: 0o600 },
	);
	assert.equal(
		(await measurementInput(state, row.row.runId, false, true)).input.contract
			?.acceptedCriteria.unavailable,
		"accepted_criteria_unavailable",
	);
});

it("explain accepts fenced JSON, flattens valid nested citations and keeps good findings beside invalid ones", async (t) => {
	const state = directory(t);
	const row = seed(state);
	const input = await measurementInput(state, row.row.runId);
	assert.deepEqual(
		explainFindings(
			"```json\n" +
				JSON.stringify({
					findings: [
						{ text: "invalid", citations: ["ledger.missing"] },
						{
							text: "known outcome\u001b\u007f",
							citations: [
								"ledger.outcome.kind",
								"ledger.outcome",
								"ledger.outcome.missing",
								"ledger.constructor",
							],
						},
						{ text: "too big".repeat(1000), citations: ["ledger.outcome"] },
					],
				}) +
				"\n```",
			input,
		),
		[{ text: "known outcome", citations: ["ledger.outcome"] }],
	);
	assert.equal(
		explainFindings(
			'{"findings":[{"text":"bad","citations":["ledger.missing.x"]}]}',
			input,
		),
		null,
	);
});

it("an allocated measurement with no owner retains a conservative 30000-token charge", async (t) => {
	const state = directory(t);
	allocateMeasurement(state, "explain", finished.row.runId);
	const charge = await measurementCharges(state, repo);
	assert.equal(charge.tokens.total, 30000);
	assert.equal(charge.tokens.kind, "lower_bound");
	assert.equal(charge.executions, 1);
});

it("explain evidence is ledger plus bound redacted receipts, never raw sessions/output/stderr; child inclusion is explicit", async (t) => {
	const stateDir = directory(t);
	const row = seed(stateDir);
	const input = await measurementInput(stateDir, row.row.runId);
	assert.equal(input.input.children, null);
	assert.equal(input.input.receipts.length, 1);
	assert.doesNotMatch(
		input.bytes,
		/PRIVATE_TRANSCRIPT_SENTINEL|RAW_OUTPUT_SENTINEL|STDERR_SENTINEL/,
	);
	assert.equal(input.digest, digestOf(input.bytes));
	const children = await measurementInput(stateDir, row.row.runId, true);
	assert.equal(children.input.children?.[0]?.tokens, 200);
	assert.equal(children.input.children?.[0]?.id, digestOf("child"));
	assert.equal(children.input.children?.[0]?.coverage, "child_run");
	assert.notEqual(children.digest, input.digest);
	assert.match(explainPrompt(input), /untrusted data/);
	assert.deepEqual(
		explainFindings(
			'{"findings":[{"text":"The run ended for missing info.","citations":["ledger.outcome"]}]}',
			input,
		),
		[
			{
				text: "The run ended for missing info.",
				citations: ["ledger.outcome"],
			},
		],
	);
	assert.equal(
		explainFindings(
			'{"findings":[{"text":"guess","citations":["ledger.nonexistent"]}]}',
			input,
		),
		null,
	);
	assert.equal(
		explainFindings(
			'{"findings":[{"text":"guess","citations":["/private/transcript.jsonl"]}]}',
			input,
		),
		null,
	);
	assert.equal(explainFindings('{"findings":[]}', input), null);
	writeFileSync(
		join(stateDir, "stages", row.row.runId, "build-1/receipt.json"),
		"{}",
	);
	assert.equal(
		(await measurementInput(stateDir, row.row.runId)).input.receipts.length,
		0,
	);
});

it("measurement reports lead with the local primary metric and keep pending/unavailable honest", (t) => {
	const dir = directory(t);
	assert.equal(measurementPrimary(dir, repo).status, "unavailable");
	writeFileSync(
		join(dir, "metrics.json"),
		JSON.stringify({
			version: 1,
			stale: false,
			computedAt: "2026-11-10T10:00:00Z",
			report: {
				repo,
				status: "pending",
				primary: { numerator: 0, denominator: 1, share: null },
			},
		}),
		{ mode: 0o600 },
	);
	const primary = measurementPrimary(dir, repo);
	assert.equal(primary.status, "pending");
	assert.match(
		primaryMetricText(primary),
		/^F12a clean landing share: pending/,
	);
	assert.equal(measurementPrimary(dir, "other/repo").status, "unavailable");
});

it("execution identities are distinct measurements rather than cadence windows or ticket claims", (t) => {
	const dir = directory(t);
	const first = allocateMeasurement(dir, "score", finished.row.runId);
	const second = allocateMeasurement(dir, "score", finished.row.runId);
	const explain = allocateMeasurement(dir, "explain", finished.row.runId);
	assert.match(first.identity, /^measure\/score\/[a-f0-9]{64}\/1$/);
	assert.match(second.identity, /\/2$/);
	assert.match(explain.identity, /^measure\/explain\//);
	assert.notEqual(first.executionId, second.executionId);
	assert.notEqual(first.executionId, explain.executionId);
	assert.equal(existsSync(join(dir, "claims")), false);
});

async function nativeBundle(t: TestContext, root: string) {
	if (!nativeUserScope(t)) return null;

	const source = new URL("..", import.meta.url).pathname;
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
	assert.equal(
		(
			await execFile(
				"cp",
				["-al", join(source, "node_modules"), join(bundle, "pkg/node_modules")],
				30_000,
			)
		).code,
		0,
	);

	for (const name of ["pi.ts", "stage-init.ts"])
		copyFileSync(
			join(source, "server/sandbox/assets", name),
			join(bundle, "sandbox", name),
		);
	cpSync(join(source, "skills"), join(bundle, "skills"), { recursive: true });
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

it("permanent pre-launch scoring failure is recorded once across eleven pumps and restart", async (t) => {
	const parsed = parseWorkflow({
		platform: EXE_DEV_PLATFORM,
		text: workflow,
		repo,
		env: (name) => process.env[name],
	});

	assert.equal(parsed.kind, "valid");

	if (parsed.kind !== "valid") throw new Error("fixture policy");

	const config = {
		...parsed.config,
		scorers: parsed.config.scorers?.map((s) => ({ ...s, samplingRate: 100 })),
	};

	const stateDir = directory(t);
	const runId = finished.row.runId;

	let reads = 0,
		preflights = 0,
		failures = 0;

	const exec: LedgerGit["exec"] = async () => {
		reads++;

		return {
			code: 0,
			stdout: JSON.stringify({ name: "factory:enabled" }),
			stderr: "",
		};
	};

	const context = {
		platform: EXE_DEV_PLATFORM,
		stateDir,
		repo,
		exec,
		log: (event: string) => {
			if (event === "measurement_failed") failures++;
		},
		executor: {
			...sandboxExecutor({
				platform: EXE_DEV_PLATFORM,
				stateDir,
				exec,
				log: () => undefined,
				xdgRuntimeDir:
					process.env.XDG_RUNTIME_DIR ?? `/run/user/${process.getuid?.()}`,
			}),
			preflight: async () => {
				preflights++;

				return true;
			},
		},
	};

	const measurements = controllerMeasurements(context);
	measurements.terminal(runId, config);
	await measurements.stop();

	for (let pump = 0; pump < 10; pump++) {
		measurements.retry();
		await measurements.stop();
	}

	const restarted = controllerMeasurements(context);
	restarted.terminal(runId, config);
	await restarted.stop();
	assert.equal(failures, 1);
	assert.equal(reads, 1);
	assert.equal(preflights, 1);
	const events = scoreHistory(stateDir);
	assert.equal(events.length, 1);
	assert.equal(events[0]?.status, "failed");
	assert.match(events[0]?.reasoning ?? "", /ledger_row_unavailable/);
	assert.deepEqual(events[0]?.usage, { tokens: 0, wallMs: 0, exact: true });
	seed(stateDir);

	const manual = await controllerMeasure({
		...context,
		exec: new LedgerGit().exec,
		executor: { ...context.executor, preflight: async () => false },
		kind: "score",
		runId,
		config,
	});

	assert.equal(manual.kind, "score");
	assert.equal(
		scoreHistory(stateDir).length,
		2,
		"on-demand scoring bypasses automatic enrollment",
	);
});

it("a non-started launch after preflight settles once rather than producing a failed score each pump", async (t) => {
	const parsed = parseWorkflow({
		platform: EXE_DEV_PLATFORM,
		text: workflow,
		repo,
		env: (name) => process.env[name],
	});

	assert.equal(parsed.kind, "valid");

	if (parsed.kind !== "valid") throw new Error("fixture policy");

	const config = {
		...parsed.config,
		scorers: parsed.config.scorers?.map((scorer) => ({
			...scorer,
			samplingRate: 100,
		})),
	};

	const stateDir = directory(t);
	const row = seed(stateDir);
	const github = new LedgerGit();
	let launches = 0;

	const exec: LedgerGit["exec"] = async (command, args) =>
		args.some((arg) => arg.includes("labels/factory"))
			? {
					code: 0,
					stdout: JSON.stringify({ name: "factory:enabled" }),
					stderr: "",
				}
			: github.exec(command, args);

	const context = {
		platform: EXE_DEV_PLATFORM,
		stateDir,
		repo,
		exec,
		log: () => undefined,
		executor: {
			...sandboxExecutor({
				platform: EXE_DEV_PLATFORM,
				stateDir,
				exec,
				log: () => undefined,
				xdgRuntimeDir:
					process.env.XDG_RUNTIME_DIR ?? `/run/user/${process.getuid?.()}`,
			}),
			preflight: async () => true,
			launch: async () => {
				launches++;

				return {
					kind: "unavailable" as const,
					stage: "maintain" as const,
					reason: "sandbox_unavailable" as const,
				};
			},
		},
	};

	const automatic = controllerMeasurements(context);
	automatic.terminal(row.row.runId, config);
	await automatic.stop();

	for (let pump = 0; pump < 10; pump++) {
		automatic.retry();
		await automatic.stop();
	}

	const restarted = controllerMeasurements(context);
	restarted.terminal(row.row.runId, config);
	await restarted.stop();
	assert.equal(launches, 1);
	assert.equal(scoreHistory(stateDir).length, 1);
	assert.equal(scoreHistory(stateDir)[0]?.status, "failed");
});

it("held or sandbox-blocked automatic scores remain unenrolled", async (t) => {
	const config = parseWorkflow({
		platform: EXE_DEV_PLATFORM,
		text: workflow,
		repo,
		env: (name) => process.env[name],
	});

	assert.ok(config.kind === "valid");

	const policy = {
		...config.config,
		scorers: config.config.scorers?.map((s) => ({ ...s, samplingRate: 100 })),
	};

	for (const held of [true, false]) {
		const stateDir = directory(t);
		const row = seed(stateDir);

		if (held) writeFileSync(join(stateDir, "disabled"), "");

		const exec: LedgerGit["exec"] = async () => ({
			code: 0,
			stdout: JSON.stringify({ name: "factory:enabled" }),
			stderr: "",
		});

		const measurements = controllerMeasurements({
			platform: EXE_DEV_PLATFORM,
			stateDir,
			repo,
			exec,
			log: () => undefined,
			executor: {
				...sandboxExecutor({
					platform: EXE_DEV_PLATFORM,
					stateDir,
					exec,
					log: () => undefined,
					xdgRuntimeDir:
						process.env.XDG_RUNTIME_DIR ?? `/run/user/${process.getuid?.()}`,
				}),
				preflight: async () => false,
			},
		});

		measurements.terminal(row.row.runId, policy);
		await measurements.stop();
		assert.equal(
			existsSync(
				join(
					stateDir,
					"measure/automatic",
					`${row.row.runId}-outcome-quality.json`,
				),
			),
			false,
			held ? "held" : "sandbox-blocked",
		);
	}
});

it("native local score, re-score, explain demo uses real sandbox/Pi/gateway receipts; only GitHub and model upstream are fake", {
	timeout: 180_000,
}, async (t) => {
	const root = directory(t);
	const assets = await nativeBundle(t, root);

	if (assets === null) return;
	const stateDir = join(root, "s");
	mkdirSync(stateDir, { mode: 0o700 });
	const firstRow = seed(stateDir);
	const failedRow = await seedContract(stateDir);

	const originals = [firstRow, failedRow].map((row) =>
		readFileSync(join(stateDir, "ledger", row.row.runId, "row.json")),
	);

	const primaryBaseline = computeMetrics({
		repo,
		ledger: Buffer.concat(originals),
		now: "2026-11-10T10:00:00Z",
		defects: { kind: "known", issues: [] },
	});

	writeFileSync(
		join(stateDir, "metrics.json"),
		JSON.stringify({
			version: 1,
			stale: false,
			computedAt: "2026-11-10T10:00:00Z",
			report: {
				repo,
				status: "pending",
				primary: { numerator: 0, denominator: 1, share: null },
			},
		}),
		{ mode: 0o600 },
	);

	let answer =
		'{"label":"matched","reasoning":"ledger.outcome records the final disposition."}';

	let tokens = 20;
	let failPublicationAfterAnswer = false;
	let exceedWall = false;
	let wallOffset = 0;
	const realNow = Date.now;
	t.mock.method(Date, "now", () => realNow() + wallOffset);
	const requests: string[] = [];
	let stderr = "";

	const upstream = createServer((req, res) => {
		if (req.method === "GET" && req.url === "/") {
			res.writeHead(200);
			res.end("ready");

			return;
		}

		let body = "";
		req.on("data", (chunk: Buffer) => {
			body += chunk.toString();
		});
		req.on("end", () => {
			assert.equal(req.url, "/openai/v1/responses");
			const value = objectOf(parseJson(body));
			assert.deepEqual(arrayOf(value?.tools) ?? [], []);
			assert.doesNotMatch(
				body,
				/PRIVATE_TRANSCRIPT_SENTINEL|RAW_OUTPUT_SENTINEL|STDERR_SENTINEL|HELDOUT_SUITE_SENTINEL/,
			);
			assert.match(body, /ledger/);
			requests.push(body);

			if (failPublicationAfterAnswer) publicationUnavailable = true;

			if (exceedWall) wallOffset += EXPLAIN_WALL_MS + 1;

			const item = {
				type: "message",
				id: "msg_measure",
				role: "assistant",
				status: "completed",
				content: [{ type: "output_text", text: answer, annotations: [] }],
			};

			const response = {
				id: "resp_measure",
				object: "response",
				status: "completed",
				model: "gpt-6.1-sol",
				output: [item],
				usage: {
					input_tokens: tokens - 5,
					output_tokens: 5,
					total_tokens: tokens,
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
		});
	});

	await new Promise<void>((done) => upstream.listen(0, "127.0.0.1", done));
	t.after(
		() =>
			new Promise<void>((done) => {
				upstream.close(() => done());
				upstream.closeAllConnections();
			}),
	);
	const address = upstream.address();
	assert.ok(address !== null && address instanceof Object);
	const git = new LedgerGit();

	const runApi = ledgerApiOf(
		new GitHubPublicationApi(git.exec, repo, EXE_DEV_PLATFORM),
	);

	await runApi.advance(null, (await runApi.root("2026-11-10T10:00:00Z")).sha);
	let repoEnabled = true;
	let publicationUnavailable = true;

	const exec: typeof git.exec = async (command, args, options) => {
		if (command !== "gh")
			return execFile(command, args, options?.timeoutMs ?? 30_000);

		if (args.includes("graphql"))
			return {
				code: 0,
				stdout: JSON.stringify({
					data: { viewer: { login: "exe-dev-github-integration[bot]" } },
				}),
				stderr: "",
			};

		if (args.some((arg) => arg === `repos/${repo}/git/ref/heads/main`))
			return { code: 0, stdout: "a".repeat(40), stderr: "" };

		if (
			args.some((arg) => arg.includes("contents/.github/factory/WORKFLOW.md"))
		)
			return { code: 0, stdout: workflow, stderr: "" };

		if (args.some((arg) => arg.endsWith("/labels/factory%3Aenabled")))
			return repoEnabled
				? {
						code: 0,
						stdout: JSON.stringify({ name: "factory:enabled" }),
						stderr: "",
					}
				: { code: 1, stdout: "", stderr: "HTTP 404" };

		if (
			publicationUnavailable &&
			requests.length > 0 &&
			args.some((arg) => arg === `repos/${repo}/git/ref/heads/factory/ledger`)
		)
			return { code: 1, stdout: "", stderr: "connection reset" };

		return git.exec(command, args, options);
	};

	const runtime: ControllerRuntime = {
		clock: { now: () => Date.now() },
		procs: procTable(),
		signal: new AbortController().signal,
		sleep: async () => undefined,
		executor: (context) =>
			sandboxExecutor({
				...context,
				root,
				xdgRuntimeDir:
					process.env.XDG_RUNTIME_DIR ?? `/run/user/${process.getuid?.()}`,
				host: (config) =>
					sandboxHost({
						...config,
						gateway: (spec) => {
							assert.deepEqual(
								spec.table.routes.map((route) => route.id),
								["model-openai"],
							);
							assert.equal(spec.table.ceiling.modelRequests, 1);

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
											host: "measure.fixture",
											port: address.port,
											hostHeader: "measure.fixture",
											sni: "measure.fixture",
											address: { kind: "pinned", ip: "127.0.0.1" },
										},
									})),
								},
							});
						},
					}),
			}),
	};

	let stdout = "";

	const io = {
		// Measure the frozen rows in their own repository, as before the move.
		readPlatformFile: async () => ({
			kind: "present" as const,
			text: JSON.stringify({
				version: 1,
				repositories: [repo],
				historicalRepositories: {},
			}),
		}),
		exec,
		env: (name: string) => process.env[name],
		runtime,
		stdout: (s: string) => {
			stdout += s;
		},
		stderr: (s: string) => {
			stderr += s;
		},
	};

	const invoke = async (
		kind: "score" | "explain",
		runId = firstRow.row.runId,
		json = true,
	) => {
		stdout = "";

		const args = [
			kind,
			"--run",
			runId,
			"--repo",
			repo,
			"--state-dir",
			stateDir,
		];

		if (json) args.push("--json");
		const code = await runCli(args, io);

		const diagnostics = (
			existsSync(join(stateDir, "measure", kind, runId))
				? readdirSync(join(stateDir, "measure", kind, runId))
				: []
		)
			.map((seq) => {
				const dir = join(stateDir, "measure", kind, runId, seq, "runtime");

				return existsSync(dir)
					? readdirSync(dir)
							.filter(
								(name) => name.endsWith(".log") || name === "receipt.json",
							)
							.map((name) => readFileSync(join(dir, name), "utf8"))
							.join("\n")
					: "no runtime";
			})
			.join("\n");

		assert.equal(code, 0, `${stdout}\n${stderr}\n${diagnostics}`);

		return json ? objectOf(parseJson(stdout))! : null;
	};

	const first = await invoke("score");
	assert.equal(Object.keys(first!)[0], "primary");
	assert.equal(objectOf(first?.primary)?.status, "pending");
	assert.equal(first?.passing, true);
	assert.equal(first?.published, false);
	assert.equal(first?.persisted, true);
	assert.equal(first?.publication, "queued_for_controller");
	publicationUnavailable = false;

	const own = scoreEventOf(first?.event);
	assert.ok(own);
	assert.equal(
		own.id,
		digestOf(
			`${readFileSync(join(stateDir, "measure/score-nonce"), "utf8")}/${String(first?.identity)}`,
		),
	);
	assert.notEqual(own.id, digestOf(String(first?.identity)));
	assert.equal(
		await pumpScoreOutbox({
			platform: EXE_DEV_PLATFORM,
			stateDir,
			repo,
			exec,
			log: () => undefined,
			clock: () => Date.now() + 60_000,
		}),
		true,
		"the controller publishes the persisted score after backoff without a second model request",
	);

	const queued = {
		...own,
		id: digestOf("unrelated queued score"),
		scoredRunId: digestOf("other run"),
		supersedes: null,
	};

	enqueueScore(stateDir, queued);
	writeFileSync(
		join(stateDir, "measure/score-outbox", queued.id, "retry.json"),
		JSON.stringify({
			attempts: 1,
			nextAt: Date.now() + 60000,
			reason: "transport_unavailable",
			blocked: false,
		}),
		{ mode: 0o600 },
	);
	answer =
		'{"label":"mismatched","reasoning":"ledger.outcome needs_info is not delivery."}';
	const second = await invoke("score");
	assert.equal(second?.passing, false);
	assert.equal(objectOf(second?.event)?.supersedes, objectOf(first?.event)?.id);
	assert.equal(second?.published, true);
	assert.equal(second?.persisted, true);
	assert.equal(second?.publication, "published");
	assert.equal(second?.queuedScores, 1);
	assert.equal(
		scoreHistory(stateDir).filter((e) => e.scoredRunId === firstRow.row.runId)
			.length,
		2,
	);
	assert.equal(
		latestScores(scoreHistory(stateDir)).filter(
			(e) => e.scoredRunId === firstRow.row.runId,
		).length,
		1,
	);
	const beforeExplainWrites = git.writes.length;
	answer = JSON.stringify({
		findings: [
			{
				text: "A hard check failed; $(touch /workspace/SHOULD_NOT_EXIST) is quoted data, not an action.",
				citations: [
					"ledger.outcome",
					"ledger.failure",
					`stages/${failed.row.runId}/build-1/receipt.json`,
				],
			},
		],
	});
	const explained = await invoke("explain", failed.row.runId, false);
	assert.equal(explained, null);
	assert.match(stdout, /^F12a clean landing share: pending/);
	assert.match(stdout, /A hard check failed/);

	const explainedResult = objectOf(
		parseJson(
			readFileSync(
				join(stateDir, "measure/explain", failed.row.runId, "1/result.json"),
				"utf8",
			),
		),
	);

	assert.equal(arrayOf(explainedResult?.findings)?.length, 1);
	assert.equal(
		git.writes.length,
		beforeExplainWrites,
		"explain makes no GitHub write",
	);
	assert.equal(EXPLAIN_MAX_TOKENS, 30_000);
	assert.equal(EXPLAIN_WALL_MS, 300_000);

	const explainRuntime = join(
		stateDir,
		"measure/explain",
		failed.row.runId,
		"1/runtime",
	);

	const receipt = objectOf(
		parseJson(readFileSync(join(explainRuntime, "receipt.json"), "utf8")),
	);

	assert.match(String(receipt?.measurementIdentity), /^measure\/explain\//);
	assert.equal(receipt?.assetsDigest, assets);
	assert.equal(objectOf(receipt?.usage)?.total, 20);
	assert.equal(
		existsSync(join(explainRuntime, "../workspace/SHOULD_NOT_EXIST")),
		false,
	);
	answer =
		'{"label":"matched","reasoning":"This passing measurement cannot override ledger.outcome or the failed visible check."}';
	failPublicationAfterAnswer = true;
	await invoke("score", failed.row.runId, false);
	assert.match(stdout, /^F12a clean landing share: pending/);
	assert.match(stdout, /passing measurement/);
	assert.match(stdout, /Computed and persisted locally/);
	assert.match(stdout, /Publication queued for the controller pump/);
	assert.doesNotMatch(stdout, /Published;/);
	failPublicationAfterAnswer = false;
	publicationUnavailable = false;
	assert.equal(
		await pumpScoreOutbox({
			platform: EXE_DEV_PLATFORM,
			stateDir,
			repo,
			exec,
			log: () => undefined,
			clock: () => Date.now() + 60_000,
		}),
		true,
	);
	assert.match(stdout, /Other scores queued: 1/);
	assert.match(requests[3]!, /ADMITTED_TITLE/);
	assert.match(requests[3]!, /ADMITTED_BODY/);
	assert.match(requests[3]!, /ACCEPTED_CRITERION/);

	const owner = objectOf(
		parseJson(
			readFileSync(
				join(stateDir, "measure/score", firstRow.row.runId, "1/owner.json"),
				"utf8",
			),
		),
	);

	assert.equal(owner?.maxTokens, 16000);
	assert.ok(
		failedRow.row.v !== 1 &&
			failedRow.row.failure?.kind === "known" &&
			failedRow.row.failure.value.reason === "visible_tests_failed",
	);
	assert.deepEqual(
		readFileSync(join(stateDir, "ledger", failed.row.runId, "row.json")),
		originals[1],
	);
	assert.equal(failedRow.row.outcome.kind, "failed");
	assert.equal(existsSync(join(stateDir, "claims")), false);
	const accounting = await readDurableAccounting(stateDir, repo);
	assert.equal(accounting.runs.length, 0);
	assert.equal(accounting.measurement.tokens.total, 80);
	assert.equal(objectOf(durableUsageOf(accounting))?.total, 80);
	assert.equal(
		objectOf(objectOf(durableUsageOf(accounting))?.measurement)?.total,
		80,
	);

	const api = ledgerApiOf(
		new GitHubPublicationApi(git.exec, repo, EXE_DEV_PLATFORM),
		"scores",
	);

	const tip = await api.ref();
	assert.ok(tip);

	const published = parseScores(
		(await api.file((await api.commit(tip)).tree)).bytes,
	);

	assert.equal(published.length, 4);
	assert.equal(
		published.filter((event) => event.id === queued.id).length,
		1,
		"the later pump also publishes the unrelated queued event once",
	);
	assert.ok(
		published.every(
			(e) => e.familyNote === "context-isolated, same family, not cross-family",
		),
	);
	assert.deepEqual(
		readFileSync(join(stateDir, "ledger", firstRow.row.runId, "row.json")),
		originals[0],
	);

	const afterLedger = Buffer.concat(
		[firstRow, failedRow].map((row) =>
			readFileSync(join(stateDir, "ledger", row.row.runId, "row.json")),
		),
	);

	assert.deepEqual(
		computeMetrics({
			repo,
			ledger: afterLedger,
			now: "2026-11-10T10:00:00Z",
			defects: { kind: "known", issues: [] },
		}),
		primaryBaseline,
	);
	assert.equal(
		requests.length,
		4,
		"exactly one gateway request for each measurement",
	);
	assert.ok(requests[0]?.includes("childCoverage"));

	// Native cap refusal: an over-budget answer is never an explain success.
	tokens = 30_001;
	answer = JSON.stringify({
		findings: [{ text: "cap", citations: ["ledger.outcome"] }],
	});
	stdout = "";
	assert.equal(
		await runCli(
			[
				"explain",
				"--run",
				failed.row.runId,
				"--repo",
				repo,
				"--state-dir",
				stateDir,
				"--json",
			],
			io,
		),
		1,
	);
	assert.equal(objectOf(parseJson(stdout))?.findings, null);
	assert.equal(Object.keys(objectOf(parseJson(stdout))!)[0], "primary");
	assert.ok(
		(await readDurableAccounting(stateDir, repo)).measurement.tokens.total >=
			30_081,
	);
	tokens = 20;

	// Native wall refusal: the model settles after the five-minute allowance.
	exceedWall = true;
	stdout = "";
	assert.equal(
		await runCli(
			[
				"explain",
				"--run",
				failed.row.runId,
				"--repo",
				repo,
				"--state-dir",
				stateDir,
				"--json",
			],
			io,
		),
		1,
	);
	assert.equal(objectOf(parseJson(stdout))?.findings, null);
	assert.equal(
		objectOf(parseJson(stdout))?.reason,
		"measurement_wall_exhausted",
	);
	exceedWall = false;
	wallOffset = 0;

	// A scorer source edit is voided before the gateway receives any work.
	seed(stateDir, failed, ["src/scorers.ts"]);
	const beforeVoided = requests.length;
	stdout = "";
	assert.equal(
		await runCli(
			[
				"score",
				"--run",
				failed.row.runId,
				"--repo",
				repo,
				"--state-dir",
				stateDir,
				"--json",
			],
			io,
		),
		1,
	);
	assert.equal(
		objectOf(objectOf(parseJson(stdout))?.event)?.voided,
		"scorer_touched",
	);
	assert.equal(requests.length, beforeVoided);

	// Automatic scoring is deterministic and non-awaited, with durable once-only enrollment.
	const parsed = parseWorkflow({
		platform: EXE_DEV_PLATFORM,
		text: workflow,
		repo,
		env: (name) => process.env[name],
	});

	assert.ok(parsed.kind === "valid");
	assert.ok(parsed.config.grader);

	const config = {
		...parsed.config,
		grader: { ...parsed.config.grader, maxTokens: 12000 },
		scorers: parsed.config.scorers?.map((s) => ({ ...s, samplingRate: 100 })),
	};

	assert.ok(sampled(firstRow.row.runId, config.scorers![0]!));
	answer = '{"label":"matched","reasoning":"ledger.outcome"}';

	const executor = runtime.executor({
		platform: EXE_DEV_PLATFORM,
		stateDir,
		exec,
		log: () => undefined,
	});

	const automatic = controllerMeasurements({
		platform: EXE_DEV_PLATFORM,
		stateDir,
		repo,
		exec,
		executor,
		log: () => undefined,
	});

	const beforeAutomatic = requests.length;
	automatic.terminal(firstRow.row.runId, config);
	assert.equal(
		requests.length,
		beforeAutomatic,
		"terminal hook does not await the model",
	);
	await automatic.stop();
	assert.equal(requests.length, beforeAutomatic + 1);

	const scoreRoot = join(stateDir, "measure/score", firstRow.row.runId);
	const automaticSeq = Math.max(...readdirSync(scoreRoot).map(Number));

	const automaticOwner = objectOf(
		parseJson(
			readFileSync(join(scoreRoot, String(automaticSeq), "owner.json"), "utf8"),
		),
	);

	assert.equal(automaticOwner?.maxTokens, 12000);

	const restarted = controllerMeasurements({
		platform: EXE_DEV_PLATFORM,
		stateDir,
		repo,
		exec,
		executor,
		log: () => undefined,
	});

	restarted.terminal(firstRow.row.runId, config);
	await restarted.stop();
	assert.equal(
		requests.length,
		beforeAutomatic + 1,
		"restart does not sample a terminal run twice",
	);
	repoEnabled = false;
	const disabledRow = seed(stateDir, known[1]!);
	restarted.terminal(disabledRow.row.runId, config);
	await restarted.stop();
	assert.equal(
		requests.length,
		beforeAutomatic + 1,
		"automatic scoring respects the repository switch",
	);

	const heldMarker = join(
		stateDir,
		"measure/automatic",
		`${disabledRow.row.runId}-outcome-quality.json`,
	);

	assert.equal(existsSync(heldMarker), false, "a hold must not enroll the run");
	repoEnabled = true;
	restarted.retry();
	await restarted.stop();
	assert.equal(
		requests.length,
		beforeAutomatic + 2,
		"lifting a hold scores the deferred run without another terminal callback",
	);
	assert.equal(existsSync(heldMarker), true);
	restarted.retry();
	await restarted.stop();
	assert.equal(
		requests.length,
		beforeAutomatic + 2,
		"a launched score enrolls only once",
	);

	let sandboxReady = false;
	const blockedRow = seed(stateDir, known[2]!);

	const blocked = controllerMeasurements({
		platform: EXE_DEV_PLATFORM,
		stateDir,
		repo,
		exec,
		log: () => undefined,
		executor: { ...executor, preflight: async () => sandboxReady },
	});

	const beforeBlocked = requests.length;
	blocked.terminal(blockedRow.row.runId, config);
	await blocked.stop();
	assert.equal(requests.length, beforeBlocked);
	assert.equal(
		existsSync(
			join(
				stateDir,
				"measure/automatic",
				`${blockedRow.row.runId}-outcome-quality.json`,
			),
		),
		false,
	);
	sandboxReady = true;
	blocked.retry();
	await blocked.stop();
	assert.equal(
		requests.length,
		beforeBlocked + 1,
		"a blocked score launches after sandbox recovery",
	);

	const voidedAutomatic = controllerMeasurements({
		platform: EXE_DEV_PLATFORM,
		stateDir,
		repo,
		exec,
		executor,
		log: () => undefined,
	});

	const beforeVoidedAutomatic = requests.length;
	voidedAutomatic.terminal(failed.row.runId, config);
	await voidedAutomatic.stop();
	const afterVoidedAutomatic = scoreHistory(stateDir).length;
	voidedAutomatic.retry();
	await voidedAutomatic.stop();
	assert.equal(
		scoreHistory(stateDir).length,
		afterVoidedAutomatic,
		"a scorer-touch refusal is not a blocked launch to retry each tick",
	);
	assert.equal(requests.length, beforeVoidedAutomatic);

	t.diagnostic(
		JSON.stringify({
			demo: "score -> re-score -> explain",
			fake: ["GitHub", "model upstream"],
			native: [
				"CLI",
				"controller",
				"Pi RPC",
				"bwrap",
				"user scopes",
				"egress gateway",
				"receipts",
			],
			primary: "pending",
			firstTokens: 80,
			scoreHistory: published.length,
			scoreFile: SCORE_FILE,
			hardCheckVeto: true,
			voidedBeforeRequest: true,
			explainCapRefused: true,
			explainWallRefused: true,
			wallClockProbe:
				"parent Date.now advanced by 300001 ms at the model response; no five-minute wait",
			configuredScoreCap: 12000,
			ownScorePublishedWithQueue: true,
			computedPersistedQueuedExit: 0,
			heldAndBlockedResume: true,
			contractIncluded: true,
			automaticOnce: true,
		}),
	);
});
