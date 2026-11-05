import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { spawnSync } from "node:child_process";
import {
	mkdtempSync,
	mkdirSync,
	readFileSync,
	writeFileSync,
	rmSync,
	existsSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { JsonValue } from "../src/tickets.ts";
import { verdictPasses, digestOf, REQUIRED_CI_CHECKS } from "../src/run.ts";
import {
	collectVerdict,
	collectTrustedReport,
	publishedSuite,
	matchesCiRun,
	parseCiRun,
	repairFeedback,
	checkFeedback,
	feedbackBytes,
	readFeedbackBytes,
	type CiRun,
	type ValidationState,
	parseValidationState,
	validationDir,
	dispatchNonce,
} from "../src/validation.ts";
import { acceptanceDigestOf, type AcceptanceSuite } from "../src/accept.ts";
import { CONTROLLER_LOGIN } from "../src/markers.ts";
import { isGitSha, isRepoSlug } from "../src/workflow.ts";
import {
	passingVerdict,
	patch,
	withLocalArtifactDownload,
	candidateLifecycleFixture,
} from "./helpers.ts";
import {
	controllerValidator,
	fileRunFiles,
	sweepValidation,
} from "../server/controller.ts";
import { fileArtifacts } from "../src/artifacts.ts";
import {
	contractBytes,
	contractDigestOf,
	type Contract,
} from "../src/specify.ts";
import {
	collectPatch,
	storePatch,
	finishPatch,
	readPatch,
} from "../src/build.ts";
import {
	generationIntent,
	handoffCandidate,
	candidateGenerations,
	candidateUsage,
} from "../src/handoff.ts";
import { candidateBranch } from "../src/publication.ts";
import type { Exec } from "../src/gh.ts";

const candidateSha = "c".repeat(40);
const gateSha = "a".repeat(40);

if (!isGitSha(candidateSha) || !isGitSha(gateSha)) throw new Error("fixture");

const run: CiRun = {
	id: 1,
	headSha: gateSha,
	headBranch: "main",
	completedAt: "2026-10-31T00:01:00Z",
	title: `gates ${candidateSha} nonce`,
	event: "workflow_dispatch",
	path: ".github/workflows/ci.yml",
	actor: CONTROLLER_LOGIN,
	triggeringActor: CONTROLLER_LOGIN,
	status: "completed",
	conclusion: "success",
	createdAt: "2026-10-31T00:00:00Z",
};

const receipt = {
	version: 2,
	gateSha,
	candidateSha,
	nonce: "nonce",
	modelCalls: 0,
	status: "passed",
	heldoutDigest: digestOf("checks"),
	requiredChecks: [...REQUIRED_CI_CHECKS],
	checks: REQUIRED_CI_CHECKS.map((name) => ({ name, exitCode: 0 })),
};

const binding = {
	run,
	nonce: "nonce",
	patchDigest: patch("a"),
	acceptanceDigest: digestOf("suite"),
	heldoutDigest: receipt.heldoutDigest,
	candidateSha,
	originalBase: gateSha,
	baseSha: gateSha,
	unjudged: ["S2"],
};

describe("reporter-owned candidate checks (unit transport)", () => {
	const verdict = collectVerdict({ ...binding, text: JSON.stringify(receipt) });
	const externalId = `factory-gates:${run.id}:nonce`;

	const record = {
		version: 1,
		status: "passed",
		checkId: 456,
		candidateSha,
		gateSha,
		runId: run.id,
		nonce: "nonce",
		workflow: ".github/workflows/ci.yml",
		event: "workflow_dispatch",
		ref: "refs/heads/main",
		actor: CONTROLLER_LOGIN,
		triggeringActor: CONTROLLER_LOGIN,
		externalId,
		heldoutDigest: receipt.heldoutDigest,
	};

	const check = {
		id: 456,
		name: "factory-gates",
		head_sha: candidateSha,
		app: { id: 15368 },
		external_id: externalId,
		status: "completed",
		conclusion: "success",
	};

	const input = {
		record,
		checks: { total_count: 1, check_runs: [check] },
		run,
		nonce: "nonce",
		verdict,
	};

	it("binds the reporter's own check ID and explicit external ID independently of nonce", () => {
		const report = collectTrustedReport(input);
		assert.ok(report);
		assert.equal(report.reportId, check.id);
		assert.notEqual(report.externalId, report.nonce);
	});

	for (const field of [
		"status",
		"candidateSha",
		"gateSha",
		"runId",
		"nonce",
		"workflow",
		"event",
		"ref",
		"actor",
		"triggeringActor",
		"externalId",
		"heldoutDigest",
		"checkId",
	])
		it(`refuses changed reporter identity ${field}`, () => {
			assert.equal(
				collectTrustedReport({
					...input,
					record: { ...record, [field]: "wrong" },
				}),
				null,
			);
		});

	for (const conclusion of ["skipped", "cancelled", "failure", null])
		it(`refuses check ${conclusion}`, () => {
			assert.equal(
				collectTrustedReport({
					...input,
					checks: { total_count: 1, check_runs: [{ ...check, conclusion }] },
				}),
				null,
			);
		});
	it("rejects default Actions GUIDs, wrong app, incomplete results and duplicate same-named checks", () => {
		for (const changed of [
			{ ...check, id: 457 },
			{ ...check, app: { id: 7 } },
			{ ...check, external_id: "actions-guid" },
			{ ...check, head_sha: gateSha },
		])
			assert.equal(
				collectTrustedReport({
					...input,
					checks: { total_count: 1, check_runs: [changed] },
				}),
				null,
			);
		assert.equal(
			collectTrustedReport({
				...input,
				checks: { total_count: 2, check_runs: [check] },
			}),
			null,
		);
		assert.equal(
			collectTrustedReport({
				...input,
				checks: { total_count: 2, check_runs: [check, { ...check, id: 457 }] },
			}),
			null,
		);
		assert.equal(
			collectTrustedReport({ ...input, verdict: { ...verdict, pass: false } }),
			null,
		);
	});
});

describe("exact workflow reporter with CLI install receipt", () => {
	const nonce = `${"c".repeat(16)}-r0-d1`;

	const cliReceipt = {
		...receipt,
		nonce,
		requiredChecks: ["install", ...REQUIRED_CI_CHECKS],
		checks: [{ name: "install", exitCode: 0 }, ...receipt.checks],
		heldoutCounts: { "test/acceptance/42/checks/a.test.ts": 3 },
	};

	const ciRun = { ...run, title: `gates ${candidateSha} ${nonce}` };

	const script = /node --input-type=module <<'NODE'\n([\s\S]*?)\n\s*NODE/
		.exec(
			readFileSync(
				new URL("../.github/workflows/ci.yml", import.meta.url),
				"utf8",
			),
		)?.[1]
		?.split("\n")
		.map((line) => line.replace(/^ {10}/, ""))
		.join("\n");

	assert.ok(script);

	function emit(text: string | null, env: Record<string, string> = {}) {
		const root = mkdtempSync(join(tmpdir(), "factory-report-test-"));

		try {
			const input = join(root, "input.json");
			const posts = join(root, "posts.json");
			writeFileSync(posts, "[]");

			if (text !== null) writeFileSync(input, text);

			const stub = `
import {writeFileSync as writePosts} from 'node:fs';
globalThis.fetch = async (url, init) => {
 const body = JSON.parse(init.body);
 writePosts(${JSON.stringify(posts)}, JSON.stringify([body]));
 return new Response(JSON.stringify({id:456, app:{id:15368}, ...body}), {status:201});
};\n`;

			const child = spawnSync(process.execPath, ["--input-type=module"], {
				input: stub + script,
				encoding: "utf8",
				env: {
					PATH: process.env.PATH,
					GH_TOKEN: "dummy-local-test-token",
					CANDIDATE_SHA: candidateSha,
					GATE_SHA: gateSha,
					NONCE: nonce,
					HELDOUT_DIR: "test/acceptance/42",
					HELDOUT_DIGEST: receipt.heldoutDigest,
					GATE_RESULT: "success",
					GITHUB_REF: "refs/heads/main",
					GITHUB_EVENT_NAME: "workflow_dispatch",
					GITHUB_ACTOR: CONTROLLER_LOGIN,
					TRIGGERING_ACTOR: CONTROLLER_LOGIN,
					GITHUB_REPOSITORY: "owner/repo",
					GITHUB_RUN_ID: String(run.id),
					GITHUB_RUN_ATTEMPT: "1",
					REPORT_INPUT: input,
					REPORT_OUTPUT: join(root, "out"),
					...env,
				},
			});

			const posted: { conclusion: string }[] = JSON.parse(
				readFileSync(posts, "utf8"),
			);

			let record: JsonValue | undefined;

			if (child.status === 0)
				record = JSON.parse(
					readFileSync(join(root, "out/receipt.json"), "utf8"),
				);

			return { code: child.status, posted, record, stderr: child.stderr };
		} finally {
			rmSync(root, { recursive: true, force: true });
		}
	}

	function collect(
		result: ReturnType<typeof emit>,
		text = JSON.stringify(cliReceipt),
	) {
		const verdict = collectVerdict({ ...binding, run: ciRun, nonce, text });

		return collectTrustedReport({
			record: result.record,
			checks: {
				total_count: 1,
				check_runs: [
					{
						id: 456,
						name: "factory-gates",
						head_sha: candidateSha,
						app: { id: 15368 },
						external_id: `factory-gates:${run.id}:${nonce}`,
						status: "completed",
						conclusion: result.posted[0]?.conclusion ?? null,
					},
				],
			},
			run: ciRun,
			nonce,
			verdict,
		});
	}

	it("accepts the actual eight-check CLI shape through the trusted collector", () => {
		const result = emit(JSON.stringify(cliReceipt));
		assert.equal(result.code, 0, result.stderr);
		assert.equal(result.posted[0]?.conclusion, "success");
		assert.ok(collect(result));
	});

	for (const [name, changed] of [
		[
			"seven-row legacy fixture",
			{
				requiredChecks: [...REQUIRED_CI_CHECKS],
				checks: receipt.checks,
			},
		],
		["missing install row", { checks: receipt.checks }],
		[
			"duplicate install declaration",
			{ requiredChecks: [...cliReceipt.requiredChecks, "install"] },
		],
		[
			"duplicate install row",
			{ checks: [...cliReceipt.checks, { name: "install", exitCode: 0 }] },
		],
		[
			"undeclared row",
			{ checks: [...cliReceipt.checks, { name: "extra", exitCode: 0 }] },
		],
		[
			"failed additional required row",
			{
				requiredChecks: [...cliReceipt.requiredChecks, "extra"],
				checks: [...cliReceipt.checks, { name: "extra", exitCode: 1 }],
			},
		],
		["missing heldout evidence", { heldoutCounts: undefined }],
		["empty heldout evidence", { heldoutCounts: {} }],
		[
			"zero heldout evidence",
			{ heldoutCounts: { "test/acceptance/42/checks/a.test.ts": 0 } },
		],
		[
			"failed install",
			{
				checks: cliReceipt.checks.map((c) => ({
					...c,
					exitCode: c.name === "install" ? 1 : 0,
				})),
			},
		],
		[
			"timed-out install",
			{
				checks: cliReceipt.checks.map((c) => ({
					...c,
					timedOut: c.name === "install",
				})),
			},
		],
		[
			"signalled install",
			{
				checks: cliReceipt.checks.map((c) => ({
					...c,
					signal: c.name === "install" ? "SIGTERM" : null,
				})),
			},
		],
		["candidate mismatch", { candidateSha: gateSha }],
		["gate mismatch", { gateSha: candidateSha }],
		["nonce mismatch", { nonce: "wrong" }],
		["oracle mismatch", { heldoutDigest: digestOf("other") }],
		["failed receipt", { status: "failed" }],
		["model calls", { modelCalls: 1 }],
	] as const)
		it(`fails closed for ${name}`, () => {
			const result = emit(JSON.stringify({ ...cliReceipt, ...changed }));
			assert.equal(result.code, 0, result.stderr);
			assert.equal(result.posted[0]?.conclusion, "failure");
			assert.equal(collect(result), null);
		});

	for (const text of [null, "{", "{}"])
		it(`fails closed for missing or malformed artifact ${text}`, () => {
			const result = emit(text);
			assert.equal(result.posted[0]?.conclusion, "failure");
			assert.equal(collect(result), null);
		});

	for (const result of ["failure", "skipped", "cancelled"])
		it(`fails closed for ${result} gates job`, () => {
			const output = emit(JSON.stringify(cliReceipt), { GATE_RESULT: result });
			assert.equal(output.posted[0]?.conclusion, "failure");
			assert.equal(collect(output), null);
		});

	const invalidEnvironments: Record<string, string>[] = [
		{ GITHUB_ACTOR: "owner" },
		{ TRIGGERING_ACTOR: "owner" },
		{ GITHUB_REF: "refs/heads/other" },
		{ GITHUB_EVENT_NAME: "pull_request" },
		{ GITHUB_RUN_ATTEMPT: "2" },
		{ CANDIDATE_SHA: "bad" },
		{ GATE_SHA: "bad" },
		{ NONCE: "bad" },
	];

	for (const env of invalidEnvironments)
		it(`does not post for wrong execution identity ${JSON.stringify(env)}`, () => {
			const result = emit(JSON.stringify(cliReceipt), env);
			assert.notEqual(result.code, 0);
			assert.deepEqual(result.posted, []);
			assert.equal(result.record, undefined);
		});
});

async function reportDeadlineFixture(root: string) {
	assert.ok(isGitSha(gateSha) && isGitSha(candidateSha));
	const repo = "giuseppecrj/pi-herdr-factorio";
	assert.ok(isRepoSlug(repo));
	const runId = digestOf("report-deadline");
	const start = Date.parse(run.createdAt);

	const contract: Contract = {
		version: 2,
		runId,
		issue: 42,
		base: { repo, sha: gateSha },
		snapshot: {
			digest: digestOf("snapshot"),
			source: "unedited",
			eventId: "1",
			eventAt: run.createdAt,
		},
		link: null,
		summary: "Change a",
		behavior: ["Return 2"],
		acceptance: [{ id: "A1", kind: "new_behavior", text: "Return 2" }],
		exclusions: [],
		compatibility: [],
		limits: [],
		files: ["src/a.ts"],
		evidence: [],
	};

	const bytes = contractBytes(contract);
	const contractDigest = contractDigestOf(bytes);
	assert.equal(
		await fileRunFiles(root).writeContract({
			contract,
			bytes,
			digest: contractDigest,
		}),
		true,
	);

	const stored = await fileArtifacts(root).store({
		contract,
		contractDigest,
		suite: {
			version: 2,
			scenarios: [
				{
					id: "S1",
					kind: "new_behavior",
					criteria: ["A1"],
					checks: ["a.test.ts"],
					judge: null,
				},
			],
			files: [
				{
					path: "a.test.ts",
					type: "node:test",
					content: "import {test} from 'node:test'; test('a',()=>{});",
				},
			],
		},
		model: "openai/gpt-6.1-sol",
		observed: null,
	});

	assert.equal(stored.kind, "found");
	const base = join(root, "base");
	const workspace = join(root, "builder");

	for (const dir of [base, workspace])
		mkdirSync(join(dir, "src"), { recursive: true });
	writeFileSync(join(base, "src/a.ts"), "export const a = 1;\n");
	writeFileSync(join(workspace, "src/a.ts"), "export const a = 2;\n");
	const collected = await collectPatch({ base, workspace });
	assert.equal(collected.kind, "collected");

	const patchBinding = {
		runId,
		baseSha: gateSha,
		contractDigest,
		acceptanceDigest: stored.receipt.acceptanceDigest,
	};

	storePatch(root, patchBinding, collected, {
		model: "openai/gpt-6.1-sol",
		observed: null,
		commands: [],
	});
	finishPatch(root, patchBinding, {
		command: "npm test",
		exitCode: 0,
		tail: "",
		wallMs: 1,
	});
	const patch = readPatch(root, patchBinding);
	assert.equal(patch.kind, "found");

	const generation = generationIntent({
		pin: {
			runId,
			repo,
			issue: 42,
			originalBase: gateSha,
			workflowSha: gateSha,
			workflowDigest: digestOf("workflow"),
			contractDigest,
			acceptanceDigest: stored.receipt.acceptanceDigest,
			maxTokens: 500_000,
			maxReviewAttempts: 3,
		},
		patch: patch.receipt,
		round: 0,
		generation: 0,
		baseSha: gateSha,
		origin: { kind: "initial" },
		publication: { kind: "initial" },
	});

	const heldout = publishedSuite({
		issue: 42,
		suite: stored.suite,
		canary: readFileSync(
			join(root, "acceptance", runId, "canary.txt"),
			"utf8",
		).trimEnd(),
		acceptanceDigest: stored.receipt.acceptanceDigest,
	});

	const nonce = dispatchNonce(runId, 0, 1);

	const hardReceipt = {
		...receipt,
		nonce,
		heldoutDigest: heldout.digest,
		requiredChecks: ["install", ...REQUIRED_CI_CHECKS],
		checks: [{ name: "install", exitCode: 0 }, ...receipt.checks],
	};

	let state: ValidationState = {
		version: 2,
		generation: { index: 0, digest: generation.digest, previousHead: null },
		startedAt: start,
		deadline: start + 1_200_000,
		round: 0,
		originalBase: gateSha,
		baseSha: gateSha,
		baseResolved: true,
		publication: {
			branch: candidateBranch(42, runId, 0),
			patchSha: gateSha,
			candidateSha,
		},
		dispatchTry: 1,
		dispatchedAt: start,
		ciRunId: run.id,
		counters: {},
	};

	let ref: string | null = candidateSha;
	let report: "missing" | "rejected" | "valid" = "missing";
	const writes: string[] = [];

	const record = {
		version: 1,
		status: "passed",
		checkId: 456,
		candidateSha,
		gateSha,
		runId: run.id,
		nonce,
		workflow: ".github/workflows/ci.yml",
		event: "workflow_dispatch",
		ref: "refs/heads/main",
		actor: CONTROLLER_LOGIN,
		triggeringActor: CONTROLLER_LOGIN,
		externalId: `factory-gates:${run.id}:${nonce}`,
		heldoutDigest: heldout.digest,
	};

	const exec: Exec = async (command, args) => {
		const ok = (value: JsonValue) => ({
			code: 0,
			stdout: JSON.stringify(value),
			stderr: "",
		});

		if (command === "unzip")
			return ok(report === "rejected" ? { ...record, checkId: 999 } : record);

		const path = args
			.find((arg) => arg.startsWith(`repos/${repo}/`))
			?.slice(`repos/${repo}/`.length);

		if (args.includes("DELETE")) {
			writes.push("DELETE");
			ref = null;

			return ok(null);
		}

		assert.ok(!args.includes("POST") && !args.includes("PATCH"));

		if (path?.startsWith("git/ref/heads/factory/run/"))
			return ref === null
				? { code: 1, stdout: "", stderr: "HTTP 404" }
				: ok({ object: { sha: ref } });

		if (path === `actions/runs/${run.id}`)
			return ok({
				id: run.id,
				head_sha: gateSha,
				head_branch: "main",
				updated_at: run.completedAt,
				display_title: `gates ${candidateSha} ${nonce}`,
				status: "completed",
				conclusion: "success",
				event: "workflow_dispatch",
				path: ".github/workflows/ci.yml",
				actor: { login: CONTROLLER_LOGIN },
				triggering_actor: { login: CONTROLLER_LOGIN },
				created_at: run.createdAt,
			});

		if (path === `actions/runs/${run.id}/artifacts`)
			return ok({
				artifacts:
					report === "missing"
						? []
						: [{ id: 999, name: "factory-report", expired: false }],
			});

		if (path === `commits/${candidateSha}/check-runs?filter=all&per_page=100`)
			return ok({
				total_count: 1,
				check_runs: [
					{
						id: 456,
						name: "factory-gates",
						head_sha: candidateSha,
						app: { id: 15368 },
						external_id: record.externalId,
						status: "completed",
						conclusion: "success",
					},
				],
			});
		throw new Error(`unexpected ${command} ${path}`);
	};

	const step = async (now: number) => {
		const restored = parseValidationState(JSON.parse(JSON.stringify(state)));
		assert.ok(restored);

		return controllerValidator({
			stateDir: root,
			exec,
			receipt: async () => JSON.stringify(hardReceipt),
		})({
			runId,
			issue: 42,
			baseSha: gateSha,
			eventAt: run.createdAt,
			now,
			wallMs: 1_200_000,
			generation,
			state: restored,
			save: async (next) => {
				state = structuredClone(next);

				return true;
			},
		});
	};

	return {
		step,
		start,
		deadline: state.deadline,
		writes,
		dir: validationDir(root, runId),
		setReport: (next: typeof report) => {
			report = next;
		},
		moveBranch: () => {
			ref = gateSha;
		},
		ref: () => ref,
	};
}

describe("report evidence uses the fixed CI deadline", () => {
	for (const cached of [false, true])
		for (const report of ["missing", "rejected"] as const)
			for (const offset of [-1, 0, 1])
				it(`${cached ? "stored verdict restart" : "first completion"}, ${report}, deadline offset ${offset}`, async () => {
					await withLocalArtifactDownload(async (root) => {
						const f = await reportDeadlineFixture(root);
						f.setReport(report);

						if (cached)
							assert.equal((await f.step(f.start + 60_000)).kind, "waiting");
						const result = await f.step(f.deadline + offset);
						assert.equal(result.state?.deadline, f.deadline);
						assert.equal(result.kind, offset < 0 ? "waiting" : "failed");

						if (result.kind === "failed")
							assert.equal(result.reason, "ci_timeout");
						assert.equal(f.ref(), null);
						assert.deepEqual(f.writes, ["DELETE"]);
					});
				});

	it("persists timeout separately without rewriting the positive hard verdict or reviving on reload", async () => {
		await withLocalArtifactDownload(async (root) => {
			const f = await reportDeadlineFixture(root);
			assert.equal((await f.step(f.start + 60_000)).kind, "waiting");
			const verdictPath = join(f.dir, "verdict.json");
			const hardVerdict = readFileSync(verdictPath, "utf8");

			for (const report of ["missing", "valid", "missing"] as const) {
				f.setReport(report);
				const result = await f.step(f.deadline + 1);
				assert.equal(result.kind, "failed");

				if (result.kind === "failed") assert.equal(result.reason, "ci_timeout");
				assert.equal(readFileSync(verdictPath, "utf8"), hardVerdict);
			}

			assert.equal(
				JSON.parse(readFileSync(join(f.dir, "failure.json"), "utf8")).reason,
				"ci_timeout",
			);
			assert.deepEqual(f.writes, ["DELETE"]);
		});
	});

	for (const offset of [-1, 1])
		it(`recovers complete valid reporter evidence at deadline offset ${offset}`, async () => {
			await withLocalArtifactDownload(async (root) => {
				const f = await reportDeadlineFixture(root);
				assert.equal((await f.step(f.start + 60_000)).kind, "waiting");
				const hardVerdict = readFileSync(join(f.dir, "verdict.json"), "utf8");
				f.setReport("valid");
				const result = await f.step(f.deadline + offset);
				assert.equal(result.kind, "finished");

				if (result.kind === "finished")
					assert.ok(result.verdict.pass && result.report);
				assert.equal(
					readFileSync(join(f.dir, "verdict.json"), "utf8"),
					hardVerdict,
				);
				assert.equal(existsSync(join(f.dir, "failure.json")), false);
			});
		});

	it("preserves stored verdict binding and branch drift refusals", async () => {
		for (const drift of [false, true])
			await withLocalArtifactDownload(async (root) => {
				const f = await reportDeadlineFixture(root);
				await f.step(f.start + 60_000);

				if (drift) f.moveBranch();
				else {
					const path = join(f.dir, "verdict.json");
					const verdict = JSON.parse(readFileSync(path, "utf8"));
					writeFileSync(
						path,
						JSON.stringify({ ...verdict, candidateSha: gateSha }),
					);
				}

				const result = await f.step(f.deadline - 1);
				assert.equal(result.kind, "failed");

				if (result.kind === "failed")
					assert.equal(
						result.reason,
						drift ? "branch_moved" : "verdict_binding",
					);
				assert.deepEqual(f.writes, ["DELETE"]);
			});
	});
});

const suite: AcceptanceSuite = {
	version: 2,
	scenarios: [
		{
			id: "S1",
			kind: "new_behavior",
			criteria: ["A1"],
			checks: ["a.test.ts"],
			judge: null,
		},
		{
			id: "S2",
			kind: "preservation",
			criteria: ["A2"],
			checks: [],
			judge: "Readability",
		},
	],
	files: [
		{
			path: "a.test.ts",
			type: "node:test",
			content: "test('secret title',()=>{assert.ok(true)})",
		},
	],
};

const canary = `factory-holdout-${"0".repeat(64)}`;

describe("bound validation verdicts", () => {
	it("does not accept an empty check set", () => {
		assert.equal(
			verdictPasses({ ...passingVerdict(patch("a")), checks: [] }),
			false,
		);
	});
	it("does not accept missing required checks", () => {
		assert.equal(
			verdictPasses({
				...passingVerdict(patch("a")),
				checks: [{ name: "typecheck", passed: true }],
			}),
			false,
		);
	});
	it("binds every identity and leaves judge criteria unjudged", () => {
		const verdict = collectVerdict({
			...binding,
			text: JSON.stringify(receipt),
		});

		assert.equal(verdictPasses(verdict), true);
		assert.equal(verdict.candidateSha, candidateSha);
		assert.equal(verdict.gateSha, gateSha);
		assert.deepEqual(verdict.unjudged, ["S2"]);
	});

	for (const altered of [
		{
			requiredChecks: receipt.requiredChecks.filter(
				(name) => name !== "heldout",
			),
			checks: receipt.checks.filter((check) => check.name !== "heldout"),
		},
		{ checks: [...receipt.checks, { name: "extra", exitCode: 0 }] },
		{ checks: [] },
		{ requiredChecks: [] },
		{ checks: receipt.checks.slice(1) },
		{ checks: [...receipt.checks, receipt.checks[0]] },
		{ gateSha: "b".repeat(40) },
		{ candidateSha: "b".repeat(40) },
		{ heldoutDigest: digestOf("changed") },
		{ nonce: "other" },
		{ version: 1 },
		{ status: "incomplete" },
		{ status: "failed" },
		{ modelCalls: 1 },
		{
			checks: receipt.checks.map((check) =>
				check.name === "heldout" ? { ...check, exitCode: 1 } : check,
			),
		},
	])
		it(`fails closed on ${JSON.stringify(altered)}`, () => {
			assert.equal(
				collectVerdict({
					...binding,
					text: JSON.stringify({ ...receipt, ...altered }),
				}).pass,
				false,
			);
		});

	for (const conclusion of [
		"cancelled",
		"skipped",
		"timed_out",
		"failure",
		null,
	])
		it(`does not pass conclusion ${conclusion}`, () => {
			assert.equal(
				collectVerdict({
					...binding,
					run: { ...run, conclusion },
					text: JSON.stringify(receipt),
				}).pass,
				false,
			);
		});
	it("requires a completed run even with a success conclusion", () => {
		assert.equal(
			collectVerdict({
				...binding,
				run: { ...run, status: "in_progress" },
				text: JSON.stringify(receipt),
			}).pass,
			false,
		);
	});
	it("refuses a gate revision different from the candidate base", () => {
		assert.equal(
			collectVerdict({
				...binding,
				baseSha: candidateSha,
				text: JSON.stringify(receipt),
			}).pass,
			false,
		);
	});
	it("refuses a missing or malformed receipt", () => {
		for (const text of [
			null,
			"{}",
			"{",
			JSON.stringify({ checks: [], requiredChecks: [] }),
		])
			assert.equal(collectVerdict({ ...binding, text }).pass, false);
	});
	it("authenticates the run event, path, actors, nonce and creation time", () => {
		assert.equal(
			matchesCiRun(
				run,
				binding.candidateSha,
				"nonce",
				Date.parse(run.createdAt),
			),
			true,
		);

		for (const altered of [
			{ headBranch: "other" },
			{ event: "push" },
			{ path: ".github/workflows/check.yml" },
			{ actor: "human" },
			{ triggeringActor: "human" },
			{ title: "wrong nonce" },
			{ createdAt: "2000-01-01T00:00:00Z" },
		])
			assert.equal(
				matchesCiRun(
					{ ...run, ...altered },
					binding.candidateSha,
					"nonce",
					Date.parse(run.createdAt),
				),
				false,
			);
		assert.equal(parseCiRun({ id: 1, head_sha: "bad" }), null);
	});
});

describe("generation-aware validation cleanup", () => {
	for (const mode of ["active", "terminal", "finish_pending"])
		it(`sweeps bounded archives and pending current state without mutating the book (${mode})`, async () => {
			const root = mkdtempSync(join(tmpdir(), "factory-cleanup-generations-"));

			try {
				const fixture = candidateLifecycleFixture();
				const terminal = mode !== "active";

				const publishedHead =
					fixture.history[0]?.certification?.verdict.candidateSha;

				assert.ok(publishedHead && isGitSha(publishedHead));

				const pending = handoffCandidate(fixture, {
					kind: "observed",
					now: 201,
					main: null,
					pr: {
						kind: "merged",
						number: 5,
						head: publishedHead,
						mergeSha: fixture.pin.originalBase,
						actor: null,
					},
					executionAllowed: false,
					capacityAvailable: false,
					eligibility: "withdrawn",
					readiness: { kind: "unavailable" },
				}).state;

				assert.equal(pending.kind, "selected");

				const book =
					mode === "finish_pending"
						? pending
						: terminal
							? {
									...fixture,
									work: {
										kind: "terminal" as const,
										terminal: {
											kind: "failed" as const,
											reason: "validation_failed" as const,
										},
									},
								}
							: fixture;

				const pin = book.pin;
				const files = fileRunFiles(root);

				const contract: Contract = {
					version: 2,
					runId: pin.runId,
					issue: pin.issue,
					base: { repo: pin.repo, sha: pin.originalBase },
					snapshot: {
						digest: digestOf("snapshot"),
						source: "unedited",
						eventId: "1",
						eventAt: run.createdAt,
					},
					link: null,
					summary: "fixture",
					behavior: ["fixture"],
					acceptance: [{ id: "A1", kind: "new_behavior", text: "fixture" }],
					exclusions: [],
					compatibility: [],
					limits: [],
					files: ["src/example.ts"],
					evidence: [],
				};

				const bytes = contractBytes(contract);
				assert.equal(
					await files.writeContract({
						contract,
						bytes,
						digest: contractDigestOf(bytes),
					}),
					true,
				);
				assert.equal(
					await files.writeClaim({
						runId: pin.runId,
						issue: pin.issue,
						eventId: "1",
						seq: 1,
						status: mode === "terminal" ? "failed" : "running",
						stage: "validate",
						attempt: 1,
						usage: candidateUsage(book),
						handoff: book,
					}),
					true,
				);

				const claimPath = join(root, "claims", `${pin.runId}.json`);
				const originalClaim = readFileSync(claimPath, "utf8");

				const refs = new Map<string, string>([
					["main", pin.originalBase],
					["owner/work", pin.originalBase],
					[book.published?.branch ?? "factory/pr/unused", pin.originalBase],
				]);

				const deletes: string[] = [];
				let refuse = true;

				for (const g of candidateGenerations(book)) {
					const publication = g.validation?.publication;
					assert.ok(publication);
					refs.set(publication.branch, publication.candidateSha);

					if (g.verdict !== null)
						writeFileSync(
							join(
								validationDir(
									root,
									pin.runId,
									g.intent.round,
									g.intent.generation,
								),
								"verdict.json",
							),
							JSON.stringify(g.verdict),
							{ mode: 0o600 },
						);
				}

				const exec: Exec = async (_command, args) => {
					const method = args[args.indexOf("--method") + 1];

					const path =
						args
							.find((arg) => arg.startsWith(`repos/${pin.repo}/`))
							?.slice(`repos/${pin.repo}/`.length) ?? "";

					const ok = (value: JsonValue) => ({
						code: 0,
						stdout: JSON.stringify(value),
						stderr: "",
					});

					if (
						path ===
						"actions/workflows/ci.yml/runs?event=workflow_dispatch&per_page=100"
					)
						return ok({ workflow_runs: [] });

					const branch = path.replace(/^git\/refs?\/heads\//, "");

					if (method === "GET" && path.startsWith("git/ref/heads/")) {
						const sha = refs.get(branch);

						return sha === undefined
							? { code: 1, stdout: "", stderr: "HTTP 404" }
							: ok({ object: { sha } });
					}

					assert.equal(method, "DELETE");
					assert.ok(path.startsWith("git/refs/heads/factory/run/"));

					if (refuse) {
						refuse = false;

						return { code: 1, stdout: "", stderr: "HTTP 403" };
					}

					deletes.push(branch);
					refs.delete(branch);

					return ok({});
				};

				const config = { stateDir: root, exec, now: () => 201 };
				await sweepValidation(config);
				const first = book.history[0]?.validation?.publication;
				assert.ok(first);
				assert.ok(
					existsSync(
						join(validationDir(root, pin.runId), "pending-deletion.json"),
					),
				);
				refs.set(first.branch, "e".repeat(40));
				await sweepValidation(config);
				assert.equal(refs.get(first.branch), "e".repeat(40));
				refs.set(first.branch, first.candidateSha);
				await sweepValidation(config);
				const count = deletes.length;
				await sweepValidation(config);
				assert.equal(deletes.length, count);
				assert.equal(count, terminal ? 3 : 2);
				assert.equal(
					refs.has(book.current.validation?.publication?.branch ?? ""),
					!terminal,
				);
				assert.equal(refs.get("main"), pin.originalBase);
				assert.equal(refs.get("owner/work"), pin.originalBase);
				assert.equal(refs.has(book.published?.branch ?? ""), true);
				assert.equal(readFileSync(claimPath, "utf8"), originalClaim);

				if (terminal)
					assert.ok(
						existsSync(
							join(
								validationDir(root, pin.runId, 0, 2),
								"cleanup-validation.json",
							),
						),
					);
			} finally {
				rmSync(root, { recursive: true, force: true });
			}
		});
});

it("collection itself refuses a receipt from the wrong run actor or workflow", () => {
	for (const change of [
		{ actor: "human" },
		{ headBranch: "other" },
		{ event: "push" },
		{ path: ".github/workflows/check.yml" },
	])
		assert.equal(
			collectVerdict({
				...binding,
				run: { ...run, ...change },
				text: JSON.stringify(receipt),
			}).pass,
			false,
		);
});

describe("published held-out bytes and repair feedback", () => {
	it("publishes checks only and binds exact private bytes", () => {
		const result = publishedSuite({
			issue: 42,
			suite,
			canary,
			acceptanceDigest: acceptanceDigestOf(suite, canary),
		});

		assert.deepEqual(
			result.files.map((f) => f.path),
			["test/acceptance/42/checks/a.test.ts"],
		);
		assert.match(
			Buffer.from(result.files[0]?.bytes ?? []).toString(),
			/factory-holdout-/,
		);
		assert.throws(
			() =>
				publishedSuite({
					issue: 42,
					suite,
					canary,
					acceptanceDigest: digestOf("wrong"),
				}),
			/acceptance_changed/,
		);
	});
	it("does not pass a judge-only suite without executable files", () => {
		const empty: AcceptanceSuite = { ...suite, files: [] };
		assert.throws(
			() =>
				publishedSuite({
					issue: 42,
					suite: empty,
					canary,
					acceptanceDigest: acceptanceDigestOf(empty, canary),
				}),
			/empty_checks/,
		);
	});
	it("maps only failed files to criterion IDs and texts, never test titles or source", () => {
		const feedback = repairFeedback(
			suite,
			{
				acceptance: [
					{ id: "A1", kind: "new_behavior", text: "The approved behavior" },
					{ id: "A2", kind: "preservation", text: "Readable" },
				],
			},
			["test/acceptance/42/checks/a.test.ts", "outside.test.ts"],
			"test/acceptance/42",
		);

		assert.deepEqual(feedback, [
			{
				scenario: "S1",
				criteria: [{ id: "A1", text: "The approved behavior" }],
			},
		]);
		assert.doesNotMatch(
			JSON.stringify(feedback),
			/secret|assert|test\.ts|Readability/,
		);
	});

	it("excerpts failed lint, typecheck, format and candidate-test lines for the candidate's own files only, within the bound", () => {
		const lint = [
			"\u001b[31m  × anti-slop(require-readable-spacing): Expected blank line before this statement.\u001b[0m",
			"    ╭─[test/provenance.test.ts:26:2]",
			" 26 │   return root;",
			"    ╰────",
			"  × eslint(no-unused-vars): Variable 'secret' is declared but never used.",
			"    ╭─[src/untouched.ts:3:7]",
			"  × eslint(no-debugger): `debugger` statement is not allowed",
			"    ╭─[test/acceptance/42/checks/a.test.ts:1:1]",
			"Found 0 warnings and 3 errors.",
		].join("\n");

		const tests = `${JSON.stringify({
			complete: true,
			bad: true,
			counts: {},
			failures: [
				{
					file: "test/provenance.test.ts",
					name: "keeps the provenance file",
					kind: "runtime_error",
					code: "EROFS",
					message:
						"EROFS: read-only file system, mkdtemp '/w/.provenance-test-XXXXXX'",
				},
				{
					file: "test/acceptance/42/checks/a.test.ts",
					name: "hidden scenario name",
					kind: "assertion",
					code: "ERR_ASSERTION",
					message: "hidden scenario message about scripts/provenance.sh",
				},
			],
		})}\nstderr noise naming test/provenance.test.ts\n`;

		const changedPaths = [
			"scripts/provenance.sh",
			"test/provenance.test.ts",
			"test/acceptance/42/checks/a.test.ts",
		];

		const feedback = checkFeedback({
			logs: new Map([
				["lint", lint],
				["candidate_tests", tests],
				["typecheck", "scripts/provenance.sh(1,1): error TS1: unused\n"],
				["format", "test/provenance.test.ts format ━━━━━━━━━━\n"],
			]),
			failed: ["lint", "candidate_tests", "format"],
			changedPaths,
			heldoutDir: "test/acceptance/42",
		});

		assert.deepEqual(feedback, [
			{
				check: "lint",
				lines: [
					"test/provenance.test.ts:26:2 anti-slop(require-readable-spacing): Expected blank line before this statement.",
				],
			},
			{ check: "format", lines: ["test/provenance.test.ts format"] },
			{
				check: "candidate_tests",
				lines: [
					"test/provenance.test.ts: keeps the provenance file: runtime_error EROFS: EROFS: read-only file system, mkdtemp '/w/.provenance-test-XXXXXX'",
				],
			},
		]);
		assert.doesNotMatch(
			JSON.stringify(feedback),
			/acceptance|hidden|secret|untouched|TS1/,
		);

		const many = Array.from(
			{ length: 400 },
			(_, i) =>
				`test/provenance.test.ts(${i},1): error TS2: ${"x".repeat(500)}`,
		).join("\n");

		const bounded = checkFeedback({
			logs: new Map(
				["typecheck", "lint", "format", "candidate_tests"].map((name) => [
					name,
					name === "candidate_tests" ? tests : many,
				]),
			),
			failed: ["typecheck", "lint", "format", "candidate_tests"],
			changedPaths,
			heldoutDir: "test/acceptance/42",
		});

		assert.ok(Buffer.byteLength(JSON.stringify(bounded)) <= 4096);
		assert.ok(bounded.length >= 2);

		for (const entry of bounded) {
			assert.ok(entry.lines.length <= 5);
			assert.ok(entry.lines.every((line) => line.length <= 300));
		}

		const ref = { bindingDigest: digestOf("b"), recordDigest: digestOf("r") };
		const scenarios = [{ scenario: "S1", criteria: [{ id: "A1", text: "x" }] }];

		assert.deepEqual(
			readFeedbackBytes(feedbackBytes(ref, [...scenarios, ...feedback]), ref),
			[...scenarios, ...feedback],
		);
		assert.equal(
			feedbackBytes(ref, scenarios),
			`${JSON.stringify({ version: 2, assessment: ref, scenarios })}\n`,
		);
	});
});
