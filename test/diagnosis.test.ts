import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import {
	existsSync,
	mkdirSync,
	mkdtempSync,
	readdirSync,
	readFileSync,
	rmSync,
	statSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { test } from "node:test";
import { acceptanceEntries, writeAcceptance } from "../src/accept.ts";
import {
	assessBase,
	BASE_RETRY,
	baseRetryFeedback,
	classifyFailure,
	diagnosisNeeds,
	diagnosisNotice,
	parseBaseReason,
	parseFailureClass,
	parseBaseCheckReference,
	retryableBaseReason,
	retryPending,
	type BaseReason,
	type BaseReceipt,
	type ClassifyInput,
	type FailureClass,
	type HeldoutReplay,
	type TreeReplay,
} from "../src/diagnosis.ts";
import { digestOf } from "../src/run.ts";
import {
	contractBytes,
	contractDigestOf,
	type Contract,
} from "../src/specify.ts";
import { isGitSha, isRepoSlug, type GitSha } from "../src/workflow.ts";
import { isContractDigest } from "../src/specify.ts";
import {
	arrayOf,
	fieldOf,
	objectOf,
	parseJson,
	type JsonObject,
	type JsonValue,
} from "../server/sandbox/json.ts";
import {
	checkCandidate,
	exportTree,
	heldoutDigest,
	localRunner,
	materializeFromDirectories,
	replacementDigest,
	replayHeldoutCandidate,
	runHeldoutBase,
} from "../server/gates.ts";
import { legacyMaterialize } from "./fixtures/oracle-corpus/patches/legacy-materializer.ts";
import {
	controllerBaseChecker,
	controllerDiagnosis,
	controllerValidator,
	fileRunFiles,
	type DiagnosisFacts,
	type TarballFetch,
} from "../server/controller.ts";
import {
	dispatchNonce,
	parseValidationState,
	publishedSuite,
	readFeedbackBytes,
	validationDir,
	type ValidationState,
} from "../src/validation.ts";
import {
	collectPatch,
	finishPatch,
	readPatch,
	storePatch,
} from "../src/build.ts";
import { generationIntent } from "../src/handoff.ts";
import { candidateBranch } from "../src/publication.ts";
import { CONTROLLER_LOGIN } from "../src/markers.ts";
import type { Exec } from "../src/gh.ts";

function missingTool(argv: readonly string[]): string | null {
	const [command = "", ...args] = argv;

	try {
		execFileSync(command, args, { stdio: "ignore", timeout: 10_000 });

		return null;
	} catch {
		return `${argv.join(" ")} failed in this environment`;
	}
}

const strict = process.env.FACTORY_REQUIRE_SANDBOX_TESTS === "1";

const bwrap = missingTool([
	"bwrap",
	"--unshare-all",
	"--die-with-parent",
	"--ro-bind",
	"/",
	"/",
	"true",
]);

function where(
	name: string,
	fn: (t: import("node:test").TestContext) => Promise<void>,
) {
	if (bwrap === null) test(name, fn);
	else if (strict)
		test(name, () =>
			assert.fail(`FACTORY_REQUIRE_SANDBOX_TESTS=1 but ${bwrap}`),
		);
	else test(name, (t) => t.diagnostic(`not run: ${bwrap}`));
}

const CORPUS = resolve("test/fixtures/oracle-corpus/patches");
const ADJUDICATOR = "coordinator (owner approves at PR review)";

type Entry = {
	id: string;
	patch: "good" | "bad";
	issue: number;
	same?: string;
	criteria?: {
		id: string;
		kind: "new_behavior" | "preservation";
		text: string;
	}[];
	scenarios?: { id: string; criteria: string[]; path: string; file: string }[];
	base?: Record<string, string>;
	candidate?: Record<string, string>;
	ci?: {
		kind: "recorded" | "checkCandidate";
		heldoutFailures?: string[];
		ignoredChanges?: string[];
	};
	materializer?: "legacy-pre-577" | "current";
	expected: FailureClass;
	adjudicator: string;
};

// SAFETY: the manifest is a reviewed repository fixture whose shape the corpus test asserts field by field.
const manifest = JSON.parse(
	readFileSync(join(CORPUS, "manifest.json"), "utf8"),
) as { entries: Entry[] };

const canary = `factory-holdout-${"1".repeat(64)}`;

const SOURCE_FILES = {
	"src/value.ts":
		"export function value() { return 1; }\nexport const name = 'factory';\n",
	"test/smoke.test.ts":
		"import {test} from 'node:test'; test('smoke', () => {});\n",
};

type Synthetic = Readonly<{ candidate: ReadonlyMap<string, string> }>;

const SYNTHETIC = new Map<string, Synthetic>([
	[
		"synthetic-wrong-value",
		{
			candidate: new Map([
				[
					"src/value.ts",
					"export function value() { return 3; }\nexport const name = 'factory';\n",
				],
			]),
		},
	],
	[
		"synthetic-missing-export",
		{
			candidate: new Map([
				[
					"src/value.ts",
					"export function amount() { return 2; }\nexport const name = 'factory';\n",
				],
			]),
		},
	],
	[
		"synthetic-npmrc",
		{
			candidate: new Map([[".npmrc", "registry=https://example.invalid/\n"]]),
		},
	],
]);

const syntheticCriteria = [
	{ id: "A1", kind: "new_behavior" as const, text: "value() returns two" },
	{
		id: "A2",
		kind: "preservation" as const,
		text: "the name export is unchanged",
	},
];

const syntheticScenarios = [
	{
		id: "S1",
		criteria: ["A1"],
		path: "value.test.mjs",
		text: "import test from 'node:test';\nimport assert from 'node:assert/strict';\nimport { value } from '../../../../src/value.ts';\ntest('value returns two', () => assert.equal(value(), 2));\n",
	},
	{
		id: "S2",
		criteria: ["A2"],
		path: "name.test.mjs",
		text: "import test from 'node:test';\nimport assert from 'node:assert/strict';\nimport { name } from '../../../../src/value.ts';\ntest('name is unchanged', () => assert.equal(name, 'factory'));\n",
	},
];

function resolveEntry(entry: Entry): Entry {
	if (entry.same === undefined) return entry;
	const base = manifest.entries.find((e) => e.id === entry.same);
	assert.ok(base !== undefined);

	return { ...base, ...entry, same: undefined };
}

function repository(
	t: { after(fn: () => void): void },
	files: Record<string, string>,
) {
	const root = mkdtempSync(join(tmpdir(), "factory-diagnosis-"));
	t.after(() => rmSync(root, { recursive: true, force: true }));
	const repo = join(root, "repo");
	mkdirSync(repo);

	const git = (...args: string[]) =>
		execFileSync("git", ["-C", repo, ...args], { encoding: "utf8" }).trim();

	const put = (path: string, text: string) => {
		mkdirSync(dirname(join(repo, path)), { recursive: true });
		writeFileSync(join(repo, path), text);
	};

	git("init", "-q");
	git("config", "user.name", "Diagnosis test");
	git("config", "user.email", "diagnosis@example.invalid");
	put("package.json", '{"name":"mini","version":"1.0.0","type":"module"}');
	put(
		"package-lock.json",
		'{"name":"mini","version":"1.0.0","lockfileVersion":3,"packages":{"":{"name":"mini","version":"1.0.0"}}}',
	);
	put(
		".github/factory/gates/gates.json",
		JSON.stringify({
			version: 1,
			checks: [
				{ name: "typecheck", argv: ["node", "-e", "0"] },
				{ name: "lint", argv: ["node", "-e", "0"] },
				{ name: "format", argv: ["node", "-e", "0"] },
			],
			testGlobs: ["test/*.test.ts"],
		}),
	);

	for (const name of ["freeze.mjs", "reporter.mjs", "scan-rules.json"])
		put(
			`.github/factory/gates/${name}`,
			execFileSync("git", ["show", `HEAD:.github/factory/gates/${name}`], {
				encoding: "utf8",
			}),
		);
	put(".github/factory/gates/biome.json", "{}");
	put(".oxlintrc.json", "{}");

	for (const [path, text] of Object.entries({ ...SOURCE_FILES, ...files }))
		put(path, text);
	git("add", "-A");
	git("commit", "-qm", "main");
	const gateSha = git("rev-parse", "HEAD");
	assert.ok(isGitSha(gateSha));

	return {
		root,
		repo,
		put,
		gateSha,
		commit(): GitSha {
			git("add", "-A");
			git("commit", "-qm", "candidate");
			const sha = git("rev-parse", "HEAD");
			assert.ok(isGitSha(sha));

			return sha;
		},
	};
}

function read(path: string): string {
	return readFileSync(join(CORPUS, path), "utf8");
}

async function drive(t: { after(fn: () => void): void }, raw: Entry) {
	const entry = resolveEntry(raw);
	const synthetic = SYNTHETIC.get(entry.id);
	const criteria = entry.criteria ?? syntheticCriteria;

	const scenarios =
		entry.scenarios?.map((s) => ({
			...s,
			text: read(s.file).replace(/\/\/ factory-holdout-[0-9a-f]{64}\n$/, ""),
		})) ?? syntheticScenarios;

	const baseFiles = Object.fromEntries(
		Object.entries(entry.base ?? {}).map(([path, file]) => [path, read(file)]),
	);

	const f = repository(t, baseFiles);
	const gateSha = f.gateSha;
	assert.ok(isGitSha(gateSha));
	const repo = "owner/repo";
	assert.ok(isRepoSlug(repo));

	const [first, ...rest] = criteria;
	assert.ok(first !== undefined);

	const contract: Contract = {
		version: 2,
		runId: digestOf(`diagnosis ${entry.id}`),
		issue: entry.issue,
		base: { repo, sha: gateSha },
		snapshot: {
			digest: digestOf("snapshot"),
			source: "unedited",
			eventId: "1",
			eventAt: "2026-11-03T00:00:00Z",
		},
		link: null,
		summary: `Corpus ${entry.id}`,
		behavior: ["Corpus behavior"],
		exclusions: [],
		acceptance: [first, ...rest],
		compatibility: [],
		limits: [],
		files: [],
		evidence: [],
	};

	const parsed = writeAcceptance(
		JSON.stringify({
			version: 2,
			scenarios: scenarios.map((s) => ({
				id: s.id,
				criteria: s.criteria,
				checks: [s.path],
				judge: null,
			})),
			files: scenarios.map((s) => ({
				path: s.path,
				type: "node:test",
				content: s.text,
			})),
		}),
		contract,
	);

	assert.ok(parsed.kind === "suite", JSON.stringify(parsed));
	const suite = parsed.suite;
	const heldoutDir = `test/acceptance/${entry.issue}`;

	const published = acceptanceEntries(suite, canary)
		.filter(([p]) => p.startsWith("checks/"))
		.map(([p, text]) => ({
			path: `${heldoutDir}/${p}`,
			bytes: Buffer.from(text),
		}));

	for (const file of published) f.put(file.path, file.bytes.toString());

	for (const [path, file] of Object.entries(entry.candidate ?? {}))
		f.put(path, read(file));

	for (const [path, text] of synthetic?.candidate ?? new Map<string, string>())
		f.put(path, text);
	const candidateSha = f.commit();
	const digest = heldoutDigest(published);
	const nonce = `corpus-${entry.issue}`;
	const output = join(f.root, "ci");

	const ci = await checkCandidate({
		repository: f.repo,
		gateSha: f.gateSha,
		candidateSha,
		nonce,
		output,
		runner: localRunner,
		install: false,
		heldoutDir,
		heldoutDigest: digest,
	});

	const gateExport = join(f.root, "gate-export"),
		fullExport = join(f.root, "full-export");

	await exportTree(f.repo, f.gateSha, gateExport);
	await exportTree(f.repo, candidateSha, fullExport);
	const expected = published.map((p) => p.path).toSorted();

	const checked = suite.scenarios.map((s) => ({
		scenario: s.id,
		kind: s.kind,
		file: `${heldoutDir}/checks/${s.checks[0]}`,
	}));

	const startedAt = Date.now();

	const base = assessBase(
		await runHeldoutBase({
			tree: gateExport,
			workDir: join(f.root, "base"),
			cacheDir: join(f.root, "dependencies"),
			binding: {
				runId: contract.runId,
				repo,
				issue: entry.issue,
				contractDigest: contractDigestOf(contractBytes(contract)),
				acceptanceDigest: digestOf(`suite ${entry.id}`),
				baseSha: gateSha,
				gateSha,
			},
			contract,
			suite,
			canary,
			startedAt,
			deadline: startedAt + 60_000,
		}),
	).receipt;

	let receipt: JsonValue = parseJson(JSON.stringify(ci)) ?? null;
	const needs = diagnosisNeeds(receipt);
	let replay: HeldoutReplay | null = null;
	let ignoredChanges: readonly string[] | null = null;

	const materialize =
		entry.materializer === "legacy-pre-577"
			? legacyMaterialize
			: materializeFromDirectories;

	if (needs.replay || entry.ci?.kind === "recorded") {
		const dest = join(f.root, "gate-tree");

		ignoredChanges = materialize({
			gateTree: gateExport,
			candidateTree: fullExport,
			dest,
			replacements: [],
			heldoutDir,
			heldoutDigest: digest,
		}).ignoredChanges;

		replay = await replayHeldoutCandidate({
			gateTree: dest,
			fullTree: fullExport,
			gates: join(gateExport, ".github/factory/gates"),
			heldoutDir,
			heldoutDigest: digest,
			workDir: join(f.root, "replay"),
			cacheDir: join(f.root, "dependencies"),
			deadline: Date.now() + 120_000,
		});
	}

	if (entry.ci?.kind === "recorded") {
		assert.equal(ci.status, "passed", "the current gate passes this candidate");
		assert.ok(replay?.kind === "observed");

		const historical = legacyMaterialize({
			gateTree: gateExport,
			candidateTree: fullExport,
			dest: join(f.root, "historical-gate"),
			replacements: [],
			heldoutDir,
			heldoutDigest: digest,
		});

		const historicalReplay = await replayHeldoutCandidate({
			gateTree: join(f.root, "historical-gate"),
			fullTree: fullExport,
			gates: join(gateExport, ".github/factory/gates"),
			heldoutDir,
			heldoutDigest: digest,
			workDir: join(f.root, "historical-replay"),
			cacheDir: join(f.root, "dependencies"),
			deadline: Date.now() + 120_000,
		});

		assert.ok(historicalReplay.kind === "observed");
		assert.deepEqual(historical.ignoredChanges, entry.ci.ignoredChanges);
		receipt = {
			...objectOf(receipt),
			status: "failed",
			checks: ci.checks.map((c) =>
				c.name === "heldout" ? { ...c, exitCode: 1 } : { ...c },
			),
			heldoutFailures: (entry.ci.heldoutFailures ?? []).map(
				(p) => `${heldoutDir}/checks/${p}`,
			),
			heldoutCounts: { ...historicalReplay.gate.projection.counts },
			ignoredChanges: [...(entry.ci.ignoredChanges ?? [])],
		};
	}

	const input: ClassifyInput = {
		receipt,
		identity: {
			gateSha,
			candidateSha,
			nonce,
			heldoutDigest: digest,
			replacementsDigest: replacementDigest([]),
		},
		expected,
		scenarios: checked,
		base,
		ignoredChanges,
		replay,
		dependencies: null,
		baseRefusal: null,
		candidatePaths: [
			...Object.keys(entry.candidate ?? {}),
			...(synthetic?.candidate.keys() ?? []),
		],
	};

	return {
		entry,
		ci,
		receipt,
		replay,
		base,
		input,
		failure: classifyFailure(input),
	};
}

test("the patch corpus has three good and three or more bad entries, each adjudicated", () => {
	const good = manifest.entries.filter((e) => e.patch === "good");
	const bad = manifest.entries.filter((e) => e.patch === "bad");
	assert.ok(good.length >= 3 && bad.length >= 3);

	for (const entry of manifest.entries) {
		assert.equal(entry.adjudicator, ADJUDICATOR, entry.id);
		assert.ok(
			["candidate", "oracle", "missing_evidence", "infrastructure"].includes(
				entry.expected.kind,
			),
		);
	}

	assert.ok(good.every((e) => e.expected.kind !== "candidate"));
	assert.ok(bad.every((e) => e.expected.kind === "candidate"));
});

for (const entry of manifest.entries)
	where(
		`corpus ${entry.id}: ${entry.patch} patch classifies as ${entry.expected.kind}`,
		async (t) => {
			const r = await drive(t, entry);
			t.diagnostic(
				`${entry.id}: expected ${JSON.stringify(entry.expected)} observed ${JSON.stringify(r.failure)}`,
			);
			assert.deepEqual(
				r.failure,
				entry.expected,
				JSON.stringify({ replay: r.replay, base: r.base.results }),
			);
		},
	);

where(
	"the #576 shape: the gate tree fails, the full tree passes and nothing is blamed on the candidate",
	async (t) => {
		const entry = manifest.entries.find(
			(e) => e.id === "576-docs-pre-577-gate",
		);

		assert.ok(entry !== undefined);
		const r = await drive(t, entry);
		assert.ok(r.replay?.kind === "observed");
		assert.equal(r.replay.gate.projection.passed, false);
		assert.equal(r.replay.full.projection.passed, true);
		assert.deepEqual(
			r.base.results.map((x) => x.result),
			["expected_red", "preserved"],
		);
		assert.deepEqual(r.failure, {
			kind: "missing_evidence",
			reason: "tree_replays_disagree",
		});
	},
);

where(
	"a candidate load error after a qualified base is a candidate failure",
	async (t) => {
		const entry = manifest.entries.find(
			(e) => e.id === "synthetic-missing-export",
		);

		assert.ok(entry !== undefined);
		const r = await drive(t, entry);
		assert.ok(r.replay?.kind === "observed");
		assert.ok(r.replay.gate.execution.kind === "observed");

		const file = r.replay.gate.execution.files.find((x) =>
			x.file.endsWith("value.test.mjs"),
		);

		assert.equal(file?.registered, 0);
		assert.ok(file?.failures.every((x) => x.kind === "load_error"));
		assert.deepEqual(
			r.base.results.map((x) => x.result),
			["expected_red", "preserved"],
		);
		assert.equal(r.failure.kind, "candidate");
	},
);

function observedReplay(
	files: string[],
	failing: string,
	kind: "assertion" | "load_error" = "assertion",
): HeldoutReplay {
	const tree = {
		execution: {
			kind: "observed" as const,
			exitCode: 1,
			wallMs: 1,
			files: files.map((file) => ({
				file,
				registered: file === failing && kind === "load_error" ? 0 : 1,
				failures:
					file === failing
						? [
								{
									file,
									name: "check",
									message: "m",
									code: kind === "assertion" ? "ERR_ASSERTION" : null,
									kind,
								},
							]
						: [],
			})),
		},
		projection: {
			counts: Object.fromEntries(
				files.map((f) => [f, f === failing && kind === "load_error" ? 0 : 1]),
			),
			failed: [failing],
			passed: false,
		},
	};

	return { kind: "observed", files, gate: tree, full: tree, wallMs: 2 };
}

function gitSha(text: string): GitSha {
	assert.ok(isGitSha(text));

	return text;
}

const sha = gitSha("b".repeat(40));
const cand = gitSha("c".repeat(40));
const repoSlug = slug("owner/repo");

function slug(text: string) {
	assert.ok(isRepoSlug(text));

	return text;
}

function contractDigestFor(text: string) {
	const digest = digestOf(text);
	assert.ok(isContractDigest(digest));

	return digest;
}

const first = "test/acceptance/9/checks/a.test.mjs";
const second = "test/acceptance/9/checks/b.test.mjs";
const E = [first, second];
const contractDigest = contractDigestFor("c");

function unitInput(
	overrides: Partial<ClassifyInput> & {
		receiptPatch?: JsonObject;
	} = {},
): ClassifyInput {
	const receipt = {
		version: 2,
		requiredChecks: [
			"baseline_tests",
			"typecheck",
			"lint",
			"format",
			"main_tests",
			"candidate_tests",
			"heldout",
		],
		tamperSignals: [],
		heldoutDigest: "d".repeat(64),
		heldoutCounts: { [first]: 1, [second]: 1 },
		heldoutFailures: [first],
		gateSha: sha,
		candidateSha: cand,
		nonce: "n",
		runner: "local-bwrap",
		status: "failed",
		reason: null,
		checks: [
			"baseline_tests",
			"typecheck",
			"lint",
			"format",
			"main_tests",
			"candidate_tests",
			"heldout",
		].map((name) => ({
			name,
			exitCode: name === "heldout" ? 1 : 0,
			durationMs: 1,
		})),
		ignoredChanges: [],
		replacementsDigest: replacementDigest([]),
		modelCalls: 0,
		...overrides.receiptPatch,
	};

	const base: BaseReceipt = {
		evidence: {
			binding: {
				runId: digestOf("r"),
				repo: repoSlug,
				issue: 9,
				contractDigest,
				acceptanceDigest: digestOf("a"),
				baseSha: sha,
				gateSha: sha,
			},
			runtime: {
				runner: "local-bwrap",
				node: "v",
				platform: "p",
				bwrap: "b",
				protocolDigest: digestOf("p"),
			},
			startedAt: 1,
			finishedAt: 2,
			source: {
				kind: "ready",
				treeDigest: digestOf("t"),
				lockDigest: digestOf("l"),
				gatesDigest: digestOf("g"),
			},
			execution: { kind: "observed", exitCode: 1, wallMs: 1, files: [] },
			repeat: { kind: "observed", exitCode: 1, wallMs: 1, files: [] },
			scenarios: [],
		},
		results: [
			{ scenario: "S1", kind: "new_behavior", result: "expected_red" },
			{ scenario: "S2", kind: "preservation", result: "preserved" },
		],
	};

	return {
		receipt,
		identity: {
			gateSha: sha,
			candidateSha: cand,
			nonce: "n",
			heldoutDigest: "d".repeat(64),
			replacementsDigest: replacementDigest([]),
		},
		expected: E,
		scenarios: [
			{ scenario: "S1", kind: "new_behavior", file: first },
			{ scenario: "S2", kind: "preservation", file: second },
		],
		base,
		ignoredChanges: [],
		replay: observedReplay(E, first),
		dependencies: null,
		candidatePaths: ["src/value.ts"],
		baseRefusal: null,
		...overrides,
	};
}

test("classifier: agreeing replays after a qualified base blame the candidate", () => {
	assert.deepEqual(classifyFailure(unitInput()), {
		kind: "candidate",
		reason: "candidate_heldout",
		scenarios: ["S1"],
	});
});

test("classifier: an unsafe_tree early abort is missing evidence, never candidate", () => {
	const failure = classifyFailure(
		unitInput({
			receiptPatch: { reason: "unsafe_tree", checks: [], heldoutFailures: [] },
			replay: null,
		}),
	);

	assert.deepEqual(failure, {
		kind: "missing_evidence",
		reason: "incomplete_ci",
	});

	for (const reason of [
		"heldout_digest_mismatch",
		"install_failed",
		"stale_base",
		"invalid_replacements",
		"mystery",
	])
		assert.equal(
			classifyFailure(
				unitInput({ receiptPatch: { reason, checks: [] }, replay: null }),
			).kind,
			"missing_evidence",
			reason,
		);
});

test("classifier: the closed early-abort table", () => {
	const abort = (
		reason: string,
		extra: JsonObject = {},
		dependencies: ClassifyInput["dependencies"] = null,
	) =>
		classifyFailure(
			unitInput({
				receiptPatch: { reason, checks: [], ...extra },
				replay: null,
				dependencies,
			}),
		);

	const signal = (rule: string, path = "src/value.ts") => ({
		tamperSignals: [{ path, line: 1, rule }],
	});

	for (const reason of [
		"npmrc_changed",
		"replacement_deleted",
		"unauthorized_acceptance",
	])
		assert.equal(abort(reason).kind, "candidate", reason);
	assert.equal(abort("runtime_patching").kind, "missing_evidence");
	assert.equal(abort("invalid_source_encoding").kind, "missing_evidence");

	for (const reason of [
		"runtime_patching",
		"suppression_added",
		"invalid_source_encoding",
	])
		assert.equal(abort(reason, signal(reason)).kind, "candidate", reason);
	assert.equal(abort("package_swap").kind, "missing_evidence");
	assert.equal(
		abort("package_swap", {}, { reason: "package_swap" }).kind,
		"candidate",
	);
	assert.equal(
		abort("package_swap", {}, { reason: null }).kind,
		"missing_evidence",
	);

	for (const reason of [
		"runner_error",
		"baseline_failed",
		"baseline_deadline",
		"dependency_fetch_failed",
		"dependency_integrity",
	])
		assert.equal(
			abort(reason, { status: "incomplete" }).kind,
			"infrastructure",
			reason,
		);
});

test("classifier: an early abort without its replacements binding is identity mismatch, never candidate (S1)", () => {
	for (const replacementsDigest of ["f".repeat(64), undefined])
		for (const reason of [
			"npmrc_changed",
			"unauthorized_acceptance",
			"replacement_deleted",
			"runner_error",
		])
			assert.deepEqual(
				classifyFailure(
					unitInput({
						receiptPatch: {
							reason,
							checks: [],
							replacementsDigest: replacementsDigest ?? null,
						},
						replay: null,
					}),
				),
				{ kind: "missing_evidence", reason: "identity_mismatch" },
				`${reason} ${replacementsDigest ?? "missing"}`,
			);
});

test("classifier: a scanner rejection blames the candidate only for its own changes outside the held-out suite (L3)", () => {
	const abort = (
		reason: string,
		signals: readonly { path: string; rule: string }[],
		candidatePaths: readonly string[] | null = ["src/value.ts"],
	) =>
		classifyFailure(
			unitInput({
				receiptPatch: {
					reason,
					checks: [],
					tamperSignals: signals.map((s) => ({ ...s, line: 1 })),
				},
				replay: null,
				candidatePaths,
			}),
		);

	for (const reason of [
		"invalid_source_encoding",
		"runtime_patching",
		"suppression_added",
	]) {
		assert.deepEqual(
			abort(reason, [{ path: "src/value.ts", rule: reason }]),
			{ kind: "candidate", reason: "candidate_check", scenarios: [] },
			reason,
		);
		assert.deepEqual(
			abort(reason, [{ path: first, rule: reason }]),
			{ kind: "missing_evidence", reason: "incomplete_ci" },
			`${reason} held-out`,
		);
		assert.deepEqual(
			abort(
				reason,
				[{ path: "test/acceptance/9/helper.ts", rule: reason }],
				["src/value.ts", "test/acceptance/9/helper.ts"],
			),
			{ kind: "missing_evidence", reason: "incomplete_ci" },
			`${reason} acceptance directory`,
		);
		assert.deepEqual(
			abort(reason, [{ path: "src/other.ts", rule: reason }]),
			{ kind: "missing_evidence", reason: "incomplete_ci" },
			`${reason} unchanged by the candidate`,
		);
		assert.deepEqual(
			abort(
				reason,
				[
					{ path: "src/value.ts", rule: reason },
					{ path: first, rule: reason },
				],
				["src/value.ts"],
			),
			{ kind: "missing_evidence", reason: "incomplete_ci" },
			`${reason} mixed`,
		);
		assert.deepEqual(
			abort(reason, [{ path: "src/value.ts", rule: reason }], null),
			{ kind: "missing_evidence", reason: "incomplete_ci" },
			`${reason} no candidate paths`,
		);
	}
});

test("classifier: a per-test timeout in a replay is infrastructure before agreement, oracle or candidate, even when mixed (L2)", () => {
	const timed = (tree: TreeReplay, file: string): TreeReplay => {
		assert.ok(tree.execution.kind === "observed");

		return {
			...tree,
			execution: {
				...tree.execution,
				files: tree.execution.files.map((f) =>
					f.file === file
						? {
								...f,
								failures: [
									{
										file,
										name: "check",
										message: "test timed out after 20ms",
										code: null,
										kind: "timeout" as const,
									},
								],
							}
						: f,
				),
			},
		};
	};

	const r = observedReplay(E, first);
	assert.ok(r.kind === "observed");

	for (const replay of [
		{ ...r, gate: timed(r.gate, first), full: timed(r.full, first) },
		{ ...r, full: timed(r.full, first) },
		{ ...r, gate: timed(r.gate, second), full: timed(r.full, second) },
	])
		for (const base of [unitInput().base, null])
			assert.deepEqual(classifyFailure(unitInput({ replay, base })), {
				kind: "infrastructure",
				reason: "timeout",
			});

	const mixed = observedReplay(E, first);
	assert.ok(mixed.kind === "observed");
	const timedSecond = timed(mixed.gate, second);
	assert.ok(timedSecond.execution.kind === "observed");
	assert.ok(mixed.gate.execution.kind === "observed");
	const assertion = mixed.gate.execution.files.find((f) => f.file === first);
	assert.ok(assertion !== undefined);

	const withAssertion: TreeReplay = {
		execution: {
			...timedSecond.execution,
			files: timedSecond.execution.files.map((f) =>
				f.file === first ? assertion : f,
			),
		},
		projection: {
			counts: mixed.gate.projection.counts,
			failed: E,
			passed: false,
		},
	};

	assert.deepEqual(
		classifyFailure(
			unitInput({
				receiptPatch: { heldoutFailures: E },
				replay: { ...mixed, gate: withAssertion, full: withAssertion },
			}),
		),
		{ kind: "infrastructure", reason: "timeout" },
	);
});

test("classifier: a refused refreshed base is infrastructure or missing evidence, never oracle (S3)", () => {
	const wrong = unitInput().base;
	assert.ok(wrong !== null);

	const oracleBase: BaseReceipt = {
		...wrong,
		results: [
			{
				scenario: "S1",
				kind: "new_behavior",
				result: "acceptance_not_reproduced",
			},
			{ scenario: "S2", kind: "preservation", result: "preserved" },
		],
	};

	assert.equal(classifyFailure(unitInput({ base: oracleBase })).kind, "oracle");

	for (const [refusal, expected] of [
		[
			"base_nondeterministic",
			{ kind: "infrastructure", reason: "base_nondeterministic" },
		],
		["base_timeout", { kind: "infrastructure", reason: "timeout" }],
		["base_runner_error", { kind: "infrastructure", reason: "runner_error" }],
		["base_interrupted", { kind: "infrastructure", reason: "interrupted" }],
		[
			"acceptance_not_reproduced",
			{ kind: "missing_evidence", reason: "base_missing" },
		],
		["base_load_error", { kind: "missing_evidence", reason: "base_missing" }],
		[
			"base_tree_unsupported",
			{ kind: "missing_evidence", reason: "base_missing" },
		],
	] as const)
		assert.deepEqual(
			classifyFailure(unitInput({ base: oracleBase, baseRefusal: refusal })),
			expected,
			refusal,
		);

	assert.deepEqual(
		parseFailureClass(
			parseJson(
				JSON.stringify({
					kind: "infrastructure",
					reason: "base_nondeterministic",
				}),
			),
		),
		{ kind: "infrastructure", reason: "base_nondeterministic" },
	);
});

test("classifier: identity, completeness and timeouts fail closed before blame", () => {
	assert.deepEqual(
		classifyFailure(unitInput({ receiptPatch: { nonce: "other" } })),
		{ kind: "missing_evidence", reason: "identity_mismatch" },
	);
	assert.deepEqual(
		classifyFailure(unitInput({ receiptPatch: { modelCalls: 1 } })).kind,
		"missing_evidence",
	);
	assert.deepEqual(
		classifyFailure(unitInput({ receipt: undefined })).kind,
		"missing_evidence",
	);
	const base = unitInput();
	const checks = arrayOf(fieldOf(objectOf(base.receipt), "checks")) ?? [];
	assert.deepEqual(
		classifyFailure(unitInput({ receiptPatch: { checks: checks.slice(1) } })),
		{ kind: "missing_evidence", reason: "incomplete_ci" },
	);
	assert.deepEqual(
		classifyFailure(
			unitInput({
				receiptPatch: {
					checks: checks.map((c) => ({ ...objectOf(c), timedOut: true })),
				},
			}),
		),
		{ kind: "infrastructure", reason: "timeout" },
	);
	assert.deepEqual(classifyFailure(unitInput({ replay: null })), {
		kind: "missing_evidence",
		reason: "unsupported_tree",
	});
	assert.deepEqual(
		classifyFailure(
			unitInput({
				replay: { kind: "unavailable", reason: "timeout", wallMs: 1 },
			}),
		),
		{ kind: "infrastructure", reason: "timeout" },
	);
	assert.deepEqual(classifyFailure(unitInput({ base: null })), {
		kind: "missing_evidence",
		reason: "base_missing",
	});
});

test("classifier: disagreements are missing evidence and message bytes are ignored", () => {
	const r = observedReplay(E, first);
	assert.ok(r.kind === "observed");

	const pass = {
		...r.full,
		projection: { counts: r.full.projection.counts, failed: [], passed: true },
	};

	assert.deepEqual(
		classifyFailure(unitInput({ replay: { ...r, full: pass } })),
		{ kind: "missing_evidence", reason: "tree_replays_disagree" },
	);
	assert.deepEqual(
		classifyFailure(unitInput({ replay: { ...r, gate: pass, full: pass } })),
		{ kind: "missing_evidence", reason: "ci_replay_disagrees" },
	);
	assert.deepEqual(
		classifyFailure(unitInput({ receiptPatch: { heldoutFailures: E } })),
		{ kind: "missing_evidence", reason: "ci_replay_disagrees" },
	);
	assert.deepEqual(
		classifyFailure(
			unitInput({ receiptPatch: { heldoutFailures: ["elsewhere"] } }),
		),
		{ kind: "missing_evidence", reason: "invalid_report" },
	);
	assert.deepEqual(
		classifyFailure(unitInput({ ignoredChanges: ["docs/x.md"] })),
		{ kind: "missing_evidence", reason: "materialize_mismatch", differing: 1 },
	);
	assert.deepEqual(
		classifyFailure(
			unitInput({
				ignoredChanges: ["docs/x.md", "docs/y.md", "z.json"],
				receiptPatch: { ignoredChanges: ["z.json", "w.json"] },
			}),
		),
		{ kind: "missing_evidence", reason: "materialize_mismatch", differing: 3 },
	);
	assert.deepEqual(
		classifyFailure(unitInput({ receiptPatch: { ignoredChanges: null } })),
		{ kind: "missing_evidence", reason: "invalid_report" },
	);
	assert.deepEqual(classifyFailure(unitInput({ ignoredChanges: null })), {
		kind: "missing_evidence",
		reason: "unsupported_tree",
	});
	const load = observedReplay(E, first, "load_error");
	assert.ok(load.kind === "observed");
	assert.deepEqual(
		classifyFailure(unitInput({ replay: { ...r, full: load.full } })).kind,
		"missing_evidence",
	);
	assert.ok(r.gate.execution.kind === "observed");

	const reworded = {
		...r.full,
		execution: {
			...r.gate.execution,
			files: r.gate.execution.files.map((f) => ({
				...f,
				failures: f.failures.map((x) => ({
					...x,
					message: "/other/path differs",
				})),
			})),
		},
	};

	assert.equal(
		classifyFailure(unitInput({ replay: { ...r, full: reworded } })).kind,
		"candidate",
	);
});

test("classifier: agreement negatives from the sketch all veto repair", () => {
	const r = observedReplay(E, first);
	assert.ok(r.kind === "observed" && r.gate.execution.kind === "observed");
	const gateExec = r.gate.execution;

	const kind = (
		input: Partial<ClassifyInput> & { receiptPatch?: JsonObject },
	) => classifyFailure(unitInput(input));

	for (const heldoutFailures of [
		[first, first],
		[],
		[first, "test/acceptance/8/checks/a.test.mjs"],
	])
		assert.deepEqual(kind({ receiptPatch: { heldoutFailures } }), {
			kind: "missing_evidence",
			reason: "invalid_report",
		});

	const counts: JsonObject[] = [
		{ [first]: 1 },
		{ [first]: 1, [second]: 1, extra: 1 },
		{ [first]: -1, [second]: 1 },
		{ [first]: 1.5, [second]: 1 },
	];

	for (const heldoutCounts of counts)
		assert.deepEqual(kind({ receiptPatch: { heldoutCounts } }), {
			kind: "missing_evidence",
			reason: "invalid_report",
		});

	assert.deepEqual(
		kind({ receiptPatch: { heldoutCounts: { [first]: 2, [second]: 1 } } }),
		{ kind: "missing_evidence", reason: "ci_replay_disagrees" },
	);

	const extra = {
		...r.full,
		projection: { ...r.full.projection, failed: [first, second] },
	};

	assert.deepEqual(kind({ replay: { ...r, full: extra } }), {
		kind: "missing_evidence",
		reason: "tree_replays_disagree",
	});

	const counted = {
		...r.full,
		projection: {
			...r.full.projection,
			counts: { [first]: 1, [second]: 2 },
		},
	};

	assert.deepEqual(kind({ replay: { ...r, full: counted } }), {
		kind: "missing_evidence",
		reason: "tree_replays_disagree",
	});

	const changes: Partial<{
		name: string;
		kind: "runtime_error";
		code: string;
	}>[] = [{ name: "other" }, { kind: "runtime_error" }, { code: "ERR_OTHER" }];

	for (const change of changes) {
		const changed: TreeReplay = {
			...r.full,
			execution: {
				...gateExec,
				files: gateExec.files.map((f) => ({
					...f,
					failures: f.failures.map((x) => ({ ...x, ...change })),
				})),
			},
		};

		assert.deepEqual(
			kind({ replay: { ...r, full: changed } }),
			{ kind: "missing_evidence", reason: "tree_replays_disagree" },
			JSON.stringify(change),
		);
	}

	const malformed = {
		...r.full,
		execution: {
			kind: "unavailable" as const,
			reason: "invalid_report" as const,
			wallMs: 1,
		},
	};

	assert.deepEqual(kind({ replay: { ...r, full: malformed } }), {
		kind: "missing_evidence",
		reason: "invalid_report",
	});

	const reordered = {
		...r,
		files: [...E].reverse(),
		full: {
			...r.full,
			execution: { ...gateExec, files: [...gateExec.files].reverse() },
		},
	};

	assert.equal(kind({ replay: reordered }).kind, "candidate");

	const load = observedReplay(E, first, "load_error");
	assert.deepEqual(
		kind({
			receiptPatch: { heldoutCounts: { [first]: 0, [second]: 1 } },
			replay: load,
		}),
		{ kind: "candidate", reason: "candidate_heldout", scenarios: ["S1"] },
	);
	assert.deepEqual(kind({ replay: load }), {
		kind: "missing_evidence",
		reason: "ci_replay_disagrees",
	});
});

test("classifier: a wrong base result vetoes repair as oracle, even beside a candidate check failure", () => {
	const base = unitInput().base;
	assert.ok(base !== null);

	const wrong = {
		...base,
		results: [
			{
				scenario: "S1",
				kind: "new_behavior",
				result: "acceptance_not_reproduced",
			},
			{ scenario: "S2", kind: "preservation", result: "preserved" },
		],
	} satisfies BaseReceipt;

	assert.deepEqual(classifyFailure(unitInput({ base: wrong })), {
		kind: "oracle",
		cause: "unexpected_base",
		scenarios: ["S1"],
	});

	const checks = [
		"baseline_tests",
		"typecheck",
		"lint",
		"format",
		"main_tests",
		"candidate_tests",
		"heldout",
	].map((name) => ({
		name,
		exitCode: name === "heldout" || name === "lint" ? 1 : 0,
	}));

	assert.equal(
		classifyFailure(unitInput({ base: wrong, receiptPatch: { checks } })).kind,
		"oracle",
	);

	const timeout = {
		...base,
		results: [{ scenario: "S1", kind: "new_behavior", result: "base_timeout" }],
	} satisfies BaseReceipt;

	assert.deepEqual(classifyFailure(unitInput({ base: timeout })), {
		kind: "infrastructure",
		reason: "timeout",
	});
});

test("classifier: a non-heldout candidate check failure alone is candidate and needs no replay", () => {
	const checks = [
		"baseline_tests",
		"typecheck",
		"lint",
		"format",
		"main_tests",
		"candidate_tests",
		"heldout",
	].map((name) => ({
		name,
		exitCode: name === "lint" ? 1 : 0,
	}));

	const input = unitInput({
		receiptPatch: { checks, heldoutFailures: [] },
		replay: null,
	});

	assert.deepEqual(diagnosisNeeds(input.receipt), {
		replay: false,
		dependencies: false,
	});
	assert.deepEqual(classifyFailure(input), {
		kind: "candidate",
		reason: "candidate_check",
		scenarios: [],
	});
});

test("legacy materializer fixture stays out of production imports", () => {
	for (const file of [
		"src/diagnosis.ts",
		"server/gates.ts",
		"server/controller.ts",
	])
		assert.doesNotMatch(
			readFileSync(file, "utf8"),
			/oracle-corpus|legacy-materializer/,
		);
});

const systemd =
	bwrap ?? missingTool(["systemd-run", "--user", "--scope", "--quiet", "true"]);

function scoped(
	name: string,
	fn: (t: import("node:test").TestContext) => Promise<void>,
) {
	if (systemd === null) test(name, fn);
	else if (strict)
		test(name, () =>
			assert.fail(`FACTORY_REQUIRE_SANDBOX_TESTS=1 but ${systemd}`),
		);
	else test(name, (t) => t.diagnostic(`not run: ${systemd}`));
}

function tarballOf(repository: string, sha: string): Buffer {
	return execFileSync(
		"git",
		[
			"-C",
			repository,
			"archive",
			"--format=tar.gz",
			`--prefix=repo-${sha.slice(0, 7)}/`,
			sha,
		],
		{ maxBuffer: 128 * 1024 * 1024 },
	);
}

const GATE_SOURCE = "export const materializer = 1;\n";

const SLOW_VALUE =
	"const end = Date.now() + 1500; while (Date.now() < end) {}\nexport function value() { return 3; }\nexport const name = 'factory';\n";

async function jobWorld(
	t: { after(fn: () => void): void },
	id: string,
	options: { slow?: boolean; drift?: string | null } = {},
) {
	const raw = manifest.entries.find((e) => e.id === id);
	assert.ok(raw !== undefined);
	const entry = resolveEntry(raw);
	const synthetic = SYNTHETIC.get(entry.id);

	const ids = new Map(
		(entry.criteria ?? syntheticCriteria).map((c, i) => [c.id, `A${i + 1}`]),
	);

	const criteria = (entry.criteria ?? syntheticCriteria).map((c) => ({
		...c,
		id: ids.get(c.id) ?? c.id,
	}));

	const scenarios = (
		entry.scenarios?.map((s) => ({
			...s,
			text: read(s.file).replace(/\/\/ factory-holdout-[0-9a-f]{64}\n$/, ""),
		})) ?? syntheticScenarios
	).map((s) => ({ ...s, criteria: s.criteria.map((c) => ids.get(c) ?? c) }));

	const f = repository(t, {
		"server/gates.ts": GATE_SOURCE,
		...Object.fromEntries(
			Object.entries(entry.base ?? {}).map(([path, file]) => [
				path,
				read(file),
			]),
		),
	});

	const gateSha = f.gateSha;
	const repo = "owner/repo";
	assert.ok(isGitSha(gateSha) && isRepoSlug(repo));
	const state = join(f.root, "state");
	mkdirSync(state, { mode: 0o700 });
	const [first, ...rest] = criteria;
	assert.ok(first !== undefined);

	const contract: Contract = {
		version: 2,
		runId: digestOf(`job ${entry.id}`),
		issue: entry.issue,
		base: { repo, sha: gateSha },
		snapshot: {
			digest: digestOf("snapshot"),
			source: "unedited",
			eventId: "1",
			eventAt: "2026-11-03T00:00:00Z",
		},
		link: null,
		summary: `Job ${entry.id}`,
		behavior: ["Job behavior"],
		exclusions: [],
		acceptance: [first, ...rest],
		compatibility: [],
		limits: [],
		files: [],
		evidence: [],
	};

	const bytes = contractBytes(contract);
	const contractDigest = contractDigestOf(bytes);
	const files = fileRunFiles(state);
	assert.ok(
		await files.writeContract({ contract, bytes, digest: contractDigest }),
	);

	const parsed = writeAcceptance(
		JSON.stringify({
			version: 2,
			scenarios: scenarios.map((s) => ({
				id: s.id,
				criteria: s.criteria,
				checks: [s.path],
				judge: null,
			})),
			files: scenarios.map((s) => ({
				path: s.path,
				type: "node:test",
				content: s.text,
			})),
		}),
		contract,
	);

	assert.ok(parsed.kind === "suite");

	const stored = await files.artifacts.store({
		contract,
		contractDigest,
		suite: parsed.suite,
		model: "openai/gpt-6.1-sol",
		observed: null,
	});

	assert.ok(stored.kind === "found");
	const runId = contract.runId;
	const acceptanceDigest = stored.receipt.acceptanceDigest;

	const canaryText = readFileSync(
		join(state, "acceptance", runId, "canary.txt"),
		"utf8",
	).trimEnd();

	const heldout = publishedSuite({
		issue: entry.issue,
		suite: stored.suite,
		canary: canaryText,
		acceptanceDigest,
	});

	let ciGate = gateSha;

	if (options.drift !== undefined) {
		f.put("docs/drift.md", "main moved on\n");

		if (options.drift !== null) f.put("src/value.ts", options.drift);
		ciGate = f.commit();
	}

	for (const file of heldout.files)
		f.put(file.path, Buffer.from(file.bytes ?? new Uint8Array()).toString());

	for (const [path, file] of Object.entries(entry.candidate ?? {}))
		f.put(path, read(file));

	for (const [path, text] of synthetic?.candidate ?? new Map<string, string>())
		f.put(path, text);

	if (options.slow) f.put("src/value.ts", SLOW_VALUE);
	const candidateSha = f.commit();
	const fetches: string[] = [];
	let hold: Promise<void> | null = null;

	const fetch: TarballFetch = async (_repo, sha) => {
		fetches.push(sha);

		if (hold !== null) await hold;

		return tarballOf(f.repo, sha);
	};

	const binding = {
		runId,
		repo,
		issue: entry.issue,
		contractDigest,
		acceptanceDigest,
		baseSha: gateSha,
		gateSha,
	};

	const checker = controllerBaseChecker({ stateDir: state, fetch });
	const signal = new AbortController().signal;

	const reference = {
		binding,
		acceptAttempt: 1,
		remainingAcceptMs: 900_000,
		signal,
	};

	let base = await checker.check(reference);

	for (let i = 0; i < 400 && base.kind === "checking"; i++) {
		await new Promise((r) => setTimeout(r, 50));
		base = await checker.check(reference);
	}

	assert.notEqual(base.kind, "checking");
	fetches.length = 0;

	const before = join(f.root, "patch-base"),
		after = join(f.root, "patch-after");

	for (const dir of [before, after])
		mkdirSync(join(dir, "src"), { recursive: true });
	writeFileSync(join(before, "src/value.ts"), SOURCE_FILES["src/value.ts"]);
	writeFileSync(join(after, "src/value.ts"), "export const changed = true;\n");
	const collected = await collectPatch({ base: before, workspace: after });
	assert.ok(collected.kind === "collected");

	const patchBinding = {
		runId,
		baseSha: gateSha,
		contractDigest,
		acceptanceDigest,
	};

	storePatch(state, patchBinding, collected, {
		model: "openai/gpt-6.1-sol",
		observed: null,
		commands: [],
	});
	finishPatch(state, patchBinding, {
		command: "npm test",
		exitCode: 0,
		tail: "",
		wallMs: 1,
	});
	const patch = readPatch(state, patchBinding);
	assert.ok(patch.kind === "found");

	const generation = generationIntent({
		pin: {
			runId,
			repo,
			issue: entry.issue,
			originalBase: gateSha,
			workflowSha: gateSha,
			workflowDigest: digestOf("workflow"),
			contractDigest,
			acceptanceDigest,
			maxTokens: 500_000,
			maxReviewAttempts: 3,
		},
		patch: patch.receipt,
		round: 0,
		generation: 0,
		baseSha: ciGate,
		origin: { kind: "initial" },
		publication: { kind: "initial" },
	});

	const nonce = dispatchNonce(runId, 0, 1);
	const heldoutDir = heldout.directory;

	const ci = await checkCandidate({
		repository: f.repo,
		gateSha: ciGate,
		candidateSha,
		nonce,
		output: join(f.root, "ci"),
		runner: localRunner,
		install: false,
		heldoutDir,
		heldoutDigest: heldout.digest,
	});

	let receipt: JsonObject = objectOf(parseJson(JSON.stringify(ci))) ?? {};

	if (entry.ci?.kind === "recorded") {
		const gateExport = join(f.root, "gate-export"),
			fullExport = join(f.root, "full-export");

		await exportTree(f.repo, gateSha, gateExport);
		await exportTree(f.repo, candidateSha, fullExport);

		legacyMaterialize({
			gateTree: gateExport,
			candidateTree: fullExport,
			dest: join(f.root, "historical-gate"),
			replacements: [],
			heldoutDir,
			heldoutDigest: heldout.digest,
		});

		const historical = await replayHeldoutCandidate({
			gateTree: join(f.root, "historical-gate"),
			fullTree: fullExport,
			gates: join(gateExport, ".github/factory/gates"),
			heldoutDir,
			heldoutDigest: heldout.digest,
			workDir: join(f.root, "historical-replay"),
			cacheDir: join(f.root, "dependencies"),
			deadline: Date.now() + 120_000,
		});

		assert.ok(historical.kind === "observed");
		receipt = {
			...receipt,
			status: "failed",
			checks: ci.checks.map((c) =>
				c.name === "heldout" ? { ...c, exitCode: 1 } : { ...c },
			),
			heldoutFailures: (entry.ci.heldoutFailures ?? []).map(
				(p) => `${heldoutDir}/checks/${p}`,
			),
			heldoutCounts: { ...historical.gate.projection.counts },
			ignoredChanges: [...(entry.ci.ignoredChanges ?? [])],
		};
	}

	assert.equal(receipt.status, "failed", JSON.stringify(receipt));
	const start = Date.parse("2026-11-03T00:00:00Z");
	const branch = candidateBranch(entry.issue, runId, 0);
	let ref: string | null = candidateSha;
	const writes: string[] = [];

	let validation: ValidationState = {
		version: 2,
		generation: { index: 0, digest: generation.digest, previousHead: null },
		startedAt: start,
		deadline: start + 1_200_000,
		round: 0,
		originalBase: gateSha,
		baseSha: ciGate,
		baseResolved: true,
		publication: { branch, patchSha: ciGate, candidateSha },
		dispatchTry: 1,
		dispatchedAt: start,
		ciRunId: 77,
		counters: {},
	};

	const exec: Exec = async (_command, args) => {
		const ok = (value: JsonValue) => ({
			code: 0,
			stdout: JSON.stringify(value),
			stderr: "",
		});

		const path = args
			.find((arg) => arg.startsWith(`repos/${repo}/`))
			?.slice(`repos/${repo}/`.length);

		if (args.includes("DELETE")) {
			writes.push("DELETE");
			ref = null;

			return ok(null);
		}

		if (args.includes("POST") || args.includes("PATCH")) {
			writes.push(`write ${path}`);

			throw new Error("unexpected GitHub write");
		}

		if (path?.startsWith("git/ref/heads/factory/run/"))
			return ref === null
				? { code: 1, stdout: "", stderr: "HTTP 404" }
				: ok({ object: { sha: ref } });

		if (path === "actions/runs/77")
			return ok({
				id: 77,
				head_sha: ciGate,
				head_branch: "main",
				updated_at: "2026-11-03T00:01:00Z",
				display_title: `gates ${candidateSha} ${nonce}`,
				status: "completed",
				conclusion: "failure",
				event: "workflow_dispatch",
				path: ".github/workflows/ci.yml",
				actor: { login: CONTROLLER_LOGIN },
				triggering_actor: { login: CONTROLLER_LOGIN },
				created_at: "2026-11-03T00:00:00Z",
			});

		throw new Error(`unexpected ${path}`);
	};

	const stopped: string[] = [];

	const owner = (
		materialize = entry.materializer === "legacy-pre-577",
		source: Uint8Array | null = Buffer.from(GATE_SOURCE),
	) =>
		controllerDiagnosis({
			stateDir: state,
			fetch,
			materialize: materialize ? legacyMaterialize : undefined,
			materializerSource: source ?? undefined,
			stopScope: async (unit) => {
				stopped.push(unit);
			},
		});

	const step = async (
		diagnosis: ReturnType<typeof controllerDiagnosis>,
		now = start + 60_000,
	) => {
		const restored = parseValidationState(
			JSON.parse(JSON.stringify(validation)),
		);

		assert.ok(restored);

		return controllerValidator({
			stateDir: state,
			exec,
			fetch,
			receipt: async () => `${JSON.stringify(receipt)}\n`,
			diagnosis,
		})({
			runId,
			issue: entry.issue,
			baseSha: gateSha,
			eventAt: "2026-11-03T00:00:00Z",
			now,
			wallMs: 1_200_000,
			generation,
			state: restored,
			save: async (next) => {
				validation = structuredClone(next);

				return true;
			},
		});
	};

	const settle = async (
		diagnosis: ReturnType<typeof controllerDiagnosis>,
		now?: number,
	) => {
		let result = await step(diagnosis, now);

		for (let i = 0; i < 600 && result.kind === "waiting"; i++) {
			await new Promise((r) => setTimeout(r, 50));
			result = await step(diagnosis, now);
		}

		return result;
	};

	return {
		state,
		dir: validationDir(state, runId, 0, 0),
		deadline: start + 1_200_000,
		fetches,
		writes,
		stopped,
		owner,
		step,
		settle,
		hold(gate: Promise<void> | null) {
			hold = gate;
		},
	};
}

function finishedAssessment(
	result: Awaited<ReturnType<ReturnType<typeof controllerValidator>>>,
) {
	assert.equal(result.kind, "finished", JSON.stringify(result));
	assert.ok(result.kind === "finished");

	return result.assessment;
}

function diagnosisFiles(dir: string): string[] {
	const root = join(dir, "diagnosis");

	return readdirSync(root).flatMap((digest) =>
		readdirSync(join(root, digest)).map((name) => `${digest}/${name}`),
	);
}

scoped(
	"#576 end to end through the controller job: both trees replay, the class is tree_replays_disagree and no repair is authorized",
	async (t) => {
		const w = await jobWorld(t, "576-docs-pre-577-gate");
		const owner = w.owner();
		const first = await w.step(owner);
		assert.equal(first.kind, "waiting", JSON.stringify(first));
		assert.deepEqual(w.writes, []);
		const read = finishedAssessment(await w.settle(owner));

		assert.deepEqual(read.assessment, {
			kind: "failed",
			failure: { kind: "missing_evidence", reason: "tree_replays_disagree" },
		});
		assert.equal(existsSync(join(w.dir, "feedback.json")), false);
		assert.deepEqual(w.writes, ["DELETE"]);
		assert.equal(w.fetches.length, 2);

		const kept = diagnosisFiles(w.dir)
			.map((p) => p.split("/")[1])
			.toSorted();

		assert.deepEqual(kept, ["charge.json", "intent.json", "replay.json"]);

		const [digest] = readdirSync(join(w.dir, "diagnosis"));
		assert.ok(digest !== undefined);

		const intent = JSON.parse(
			readFileSync(join(w.dir, "diagnosis", digest, "intent.json"), "utf8"),
		);

		assert.match(intent.scope, /-diagnosis-0-[0-9a-f]{8}$/);
		assert.ok(intent.deadline - intent.startedAt <= 180_000);

		for (const name of kept)
			assert.equal(
				statSync(join(w.dir, "diagnosis", digest, name)).mode & 0o777,
				0o600,
			);

		const charge = JSON.parse(
			readFileSync(join(w.dir, "diagnosis", digest, "charge.json"), "utf8"),
		);

		assert.equal(charge.tokens, 0);
		assert.ok(charge.wallMs >= 0);

		const again = finishedAssessment(await w.step(w.owner()));
		assert.deepEqual(again, read);
		assert.equal(w.fetches.length, 2);
		assert.deepEqual(w.writes, ["DELETE"]);
	},
);

scoped(
	"a genuinely bad candidate through the controller job is candidate, with feedback for exactly one repair",
	async (t) => {
		const w = await jobWorld(t, "synthetic-wrong-value");
		const read = finishedAssessment(await w.settle(w.owner()));

		assert.deepEqual(read.assessment, {
			kind: "failed",
			failure: {
				kind: "candidate",
				reason: "candidate_heldout",
				scenarios: ["S1"],
			},
		});

		const feedback = readFeedbackBytes(
			readFileSync(join(w.dir, "feedback.json"), "utf8"),
			read.ref,
		);

		assert.deepEqual(
			feedback?.map((s) => s.scenario),
			["S1"],
		);
		assert.deepEqual(w.writes, ["DELETE"]);
	},
);

for (const source of ["differs", "default"] as const)
	scoped(
		`a gate whose materializer source ${source === "differs" ? "differs from" : "is not"} this controller's is unsupported_materializer with no repair (S2)`,
		async (t) => {
			const w = await jobWorld(t, "synthetic-wrong-value");

			const read = finishedAssessment(
				await w.settle(
					w.owner(
						false,
						source === "differs"
							? Buffer.from("export const materializer = 2;\n")
							: null,
					),
				),
			);

			assert.deepEqual(read.assessment, {
				kind: "failed",
				failure: {
					kind: "missing_evidence",
					reason: "unsupported_materializer",
				},
			});
			assert.equal(existsSync(join(w.dir, "feedback.json")), false);
			assert.deepEqual(w.writes, ["DELETE"]);
		},
	);

scoped(
	"base drift: fresh base evidence for the drifted gate qualifies, and a genuinely bad candidate is candidate",
	async (t) => {
		const w = await jobWorld(t, "synthetic-wrong-value", { drift: null });
		const read = finishedAssessment(await w.settle(w.owner()));

		assert.deepEqual(read.assessment, {
			kind: "failed",
			failure: {
				kind: "candidate",
				reason: "candidate_heldout",
				scenarios: ["S1"],
			},
		});
		assert.ok(existsSync(join(w.dir, "feedback.json")));
		assert.equal(w.fetches.length, 2);
	},
);

scoped(
	"a refreshed base that does not qualify after drift is never an oracle stop (S3)",
	async (t) => {
		const w = await jobWorld(t, "synthetic-wrong-value", {
			drift:
				"export function value() { return 2; }\nexport const name = 'factory';\n",
		});

		const read = finishedAssessment(await w.settle(w.owner()));

		assert.deepEqual(read.assessment, {
			kind: "failed",
			failure: { kind: "missing_evidence", reason: "base_missing" },
		});
		assert.equal(existsSync(join(w.dir, "feedback.json")), false);
	},
);

scoped(
	"a diagnosis that runs out of time is infrastructure and holds with no redispatch",
	async (t) => {
		const w = await jobWorld(t, "synthetic-wrong-value", { slow: true });
		const owner = w.owner();
		const read = finishedAssessment(await w.settle(owner, w.deadline - 1_000));

		assert.deepEqual(read.assessment, {
			kind: "failed",
			failure: { kind: "infrastructure", reason: "timeout" },
		});
		assert.equal(existsSync(join(w.dir, "feedback.json")), false);

		for (let i = 0; i < 3; i++)
			assert.deepEqual(
				finishedAssessment(await w.step(owner, w.deadline - 500)),
				read,
			);
		assert.deepEqual(w.writes, ["DELETE"]);
		assert.equal(w.fetches.length, 2);

		const exhausted = await jobWorld(t, "synthetic-wrong-value");

		const none = finishedAssessment(
			await exhausted.step(exhausted.owner(), exhausted.deadline),
		);

		assert.deepEqual(none.assessment, {
			kind: "failed",
			failure: { kind: "infrastructure", reason: "timeout" },
		});
		assert.equal(exhausted.fetches.length, 0);
	},
);

scoped(
	"a restart after a completed replay classifies from its stored evidence without rerunning (L6)",
	async (t) => {
		const w = await jobWorld(t, "synthetic-wrong-value");
		const actual = w.owner();
		let completed: DiagnosisFacts | null = null;

		const crashed = {
			...actual,
			check: (request: Parameters<typeof actual.check>[0]) =>
				actual.check({
					...request,
					finish: (facts) => {
						completed = facts;
					},
				}),
		};

		assert.equal((await w.step(crashed)).kind, "waiting");

		for (let n = 0; n < 400 && completed === null; n++)
			await new Promise((r) => setTimeout(r, 10));
		assert.ok(completed !== null);
		assert.equal(w.fetches.length, 2);
		const read = finishedAssessment(await w.step(w.owner()));

		assert.deepEqual(read.assessment, {
			kind: "failed",
			failure: {
				kind: "candidate",
				reason: "candidate_heldout",
				scenarios: ["S1"],
			},
		});
		assert.equal(w.fetches.length, 2);
		assert.deepEqual(w.stopped, []);
		assert.deepEqual(
			diagnosisFiles(w.dir)
				.map((p) => p.split("/")[1])
				.toSorted(),
			["charge.json", "intent.json", "replay.json"],
		);
		assert.ok(existsSync(join(w.dir, "feedback.json")));
	},
);

scoped(
	"a restart whose stored replay is torn is interrupted, not classified (L6)",
	async (t) => {
		const w = await jobWorld(t, "synthetic-wrong-value");
		const actual = w.owner();
		let completed: DiagnosisFacts | null = null;

		const crashed = {
			...actual,
			check: (request: Parameters<typeof actual.check>[0]) =>
				actual.check({
					...request,
					finish: (facts) => {
						completed = facts;
					},
				}),
		};

		assert.equal((await w.step(crashed)).kind, "waiting");

		for (let n = 0; n < 400 && completed === null; n++)
			await new Promise((r) => setTimeout(r, 10));
		assert.ok(completed !== null);
		const [digest] = readdirSync(join(w.dir, "diagnosis"));
		assert.ok(digest !== undefined);
		const path = join(w.dir, "diagnosis", digest, "replay.json");
		const text = readFileSync(path, "utf8");
		writeFileSync(path, text.slice(0, Math.floor(text.length / 2)));
		const read = finishedAssessment(await w.step(w.owner()));

		assert.deepEqual(read.assessment, {
			kind: "failed",
			failure: { kind: "infrastructure", reason: "interrupted" },
		});
		assert.equal(w.stopped.length, 1);
		assert.equal(existsSync(join(w.dir, "feedback.json")), false);
	},
);

scoped(
	"tree acquisition honours the diagnosis deadline and stop, even when a fetch never returns (L5)",
	async (t) => {
		const w = await jobWorld(t, "synthetic-wrong-value");
		w.hold(new Promise(() => {}));
		const owner = w.owner();
		const began = Date.now();
		let result = await w.step(owner, w.deadline - 400);

		while (result.kind === "waiting" && Date.now() - began < 3_000) {
			await new Promise((r) => setTimeout(r, 25));
			result = await w.step(owner, w.deadline - 400);
		}

		assert.deepEqual(finishedAssessment(result).assessment, {
			kind: "failed",
			failure: { kind: "infrastructure", reason: "timeout" },
		});
		assert.ok(Date.now() - began < 2_000, `${Date.now() - began} ms`);

		const other = await jobWorld(t, "synthetic-wrong-value");
		other.hold(new Promise(() => {}));
		const stopping = other.owner();
		assert.equal((await other.step(stopping)).kind, "waiting");

		for (let i = 0; i < 100 && other.fetches.length === 0; i++)
			await new Promise((r) => setTimeout(r, 10));
		const asked = Date.now();

		const stopped = await Promise.race([
			stopping.stop(digestOf("job synthetic-wrong-value")).then(() => true),
			new Promise<false>((r) => setTimeout(() => r(false), 2_000)),
		]);

		assert.equal(stopped, true);
		assert.ok(Date.now() - asked < 1_000, `${Date.now() - asked} ms`);
	},
);

scoped(
	"an interrupted diagnosis is charged once, holds as infrastructure and never relaunches",
	async (t) => {
		const w = await jobWorld(t, "synthetic-wrong-value");
		let release = () => {};

		w.hold(new Promise((r) => (release = r)));
		const crashed = w.owner();
		assert.equal((await w.step(crashed)).kind, "waiting");

		for (let i = 0; i < 100 && w.fetches.length === 0; i++)
			await new Promise((r) => setTimeout(r, 20));
		assert.equal(w.fetches.length, 1);
		w.hold(null);

		const restarted = w.owner();
		const read = finishedAssessment(await w.step(restarted));

		assert.deepEqual(read.assessment, {
			kind: "failed",
			failure: { kind: "infrastructure", reason: "interrupted" },
		});

		const [digest] = readdirSync(join(w.dir, "diagnosis"));
		assert.ok(digest !== undefined);
		const charged = join(w.dir, "diagnosis", digest, "interrupted.json");
		const charge = readFileSync(charged, "utf8");

		const intent = JSON.parse(
			readFileSync(join(w.dir, "diagnosis", digest, "intent.json"), "utf8"),
		);

		assert.deepEqual(JSON.parse(charge), {
			wallMs: intent.deadline - intent.startedAt,
			tokens: 0,
		});
		assert.deepEqual(w.stopped, [intent.scope]);

		for (const owner of [restarted, w.owner()])
			assert.deepEqual(finishedAssessment(await w.step(owner)), read);
		assert.equal(readFileSync(charged, "utf8"), charge);
		assert.equal(w.fetches.length, 1);

		release();
		await crashed.stop(digestOf("job synthetic-wrong-value"));
		assert.deepEqual(finishedAssessment(await w.step(w.owner())), read);
		assert.equal(readFileSync(charged, "utf8"), charge);
		assert.equal(existsSync(join(w.dir, "feedback.json")), false);
	},
);

test("notices and the failure codec name which pair disagreed, with a path count and never the paths", () => {
	const key = "<!-- factory-diagnosis run=x -->";

	const sentence = (failure: FailureClass) =>
		diagnosisNotice(failure, key).body.split("\n")[0];

	const stopped =
		"Stopped: CI diagnosis could not establish reliable evidence.";

	assert.equal(
		sentence({ kind: "missing_evidence", reason: "ci_replay_disagrees" }),
		`${stopped} CI and the gate-tree replay disagree.`,
	);
	assert.equal(
		sentence({ kind: "missing_evidence", reason: "tree_replays_disagree" }),
		`${stopped} Gate and candidate replays disagree.`,
	);
	assert.equal(
		sentence({
			kind: "missing_evidence",
			reason: "materialize_mismatch",
			differing: 1,
		}),
		`${stopped} The replay's ignored changes differ from CI's in 1 path.`,
	);
	assert.equal(
		sentence({
			kind: "missing_evidence",
			reason: "materialize_mismatch",
			differing: 4,
		}),
		`${stopped} The replay's ignored changes differ from CI's in 4 paths.`,
	);
	assert.equal(
		sentence({ kind: "missing_evidence", reason: "unsupported_materializer" }),
		`${stopped} The gate's materializer differs from the controller's.`,
	);
	assert.deepEqual(
		parseFailureClass(
			parseJson(
				JSON.stringify({
					kind: "missing_evidence",
					reason: "unsupported_materializer",
				}),
			),
		),
		{ kind: "missing_evidence", reason: "unsupported_materializer" },
	);
	assert.equal(
		sentence({ kind: "missing_evidence", reason: "base_missing" }),
		stopped,
	);

	const counted: FailureClass = {
		kind: "missing_evidence",
		reason: "materialize_mismatch",
		differing: 2,
	};

	assert.deepEqual(
		parseFailureClass(parseJson(JSON.stringify(counted))),
		counted,
	);

	for (const bad of [
		{ kind: "missing_evidence", reason: "materialize_mismatch" },
		{ kind: "missing_evidence", reason: "materialize_mismatch", differing: 0 },
		{ kind: "missing_evidence", reason: "materialize_mismatch", differing: -1 },
		{ kind: "missing_evidence", reason: "base_missing", differing: 1 },
		{
			kind: "missing_evidence",
			reason: "materialize_mismatch",
			differing: 1,
			paths: ["docs/x.md"],
		},
	])
		assert.equal(parseFailureClass(parseJson(JSON.stringify(bad))), null);
});

const AUTHOR_FIXABLE: readonly BaseReason[] = [
	"acceptance_not_reproduced",
	"preservation_failed",
	"base_load_error",
	"base_no_tests",
	"base_non_assertion_failure",
	"base_skip",
	"base_todo",
	"base_cancelled",
	"base_nondeterministic",
];

const NOT_AUTHOR: readonly BaseReason[] = [
	"base_runner_error",
	"base_timeout",
	"base_tree_unsupported",
	"base_interrupted",
	"base_evidence_missing",
];

test("accept retry: one exhaustive table classifies every base reason", () => {
	assert.deepEqual(
		Object.keys(BASE_RETRY).toSorted(),
		[...AUTHOR_FIXABLE, ...NOT_AUTHOR].toSorted(),
	);

	for (const reason of AUTHOR_FIXABLE) {
		assert.equal(parseBaseReason(reason), reason);
		assert.equal(BASE_RETRY[reason], "author", reason);
		assert.equal(retryableBaseReason(reason), true, reason);
	}

	for (const reason of NOT_AUTHOR) {
		assert.equal(parseBaseReason(reason), reason);
		assert.equal(retryableBaseReason(reason), false, reason);
	}
});

function refusedEvidence(
	files: number,
	message: string,
): ReturnType<typeof assessBase> {
	const sha = "a".repeat(40);
	const repo = "o/r";

	if (!isGitSha(sha) || !isRepoSlug(repo)) throw new Error("fixture");

	return assessBase({
		binding: {
			runId: digestOf("r"),
			repo,
			issue: 9,
			contractDigest,
			acceptanceDigest: digestOf("a"),
			baseSha: sha,
			gateSha: sha,
		},
		runtime: {
			runner: "local-bwrap",
			node: "v",
			platform: "p",
			bwrap: "b",
			protocolDigest: digestOf("p"),
		},
		startedAt: 1,
		finishedAt: 2,
		source: {
			kind: "ready",
			treeDigest: digestOf("t"),
			lockDigest: digestOf("l"),
			gatesDigest: digestOf("g"),
		},
		...(() => {
			const execution = {
				kind: "observed" as const,
				exitCode: 1,
				wallMs: 1,
				files: Array.from({ length: files }, (_, i) => ({
					file: `checks/s${i + 1}.test.mjs`,
					registered: 1,
					failures: [
						{
							file: `checks/s${i + 1}.test.mjs`,
							name: `PRIVATE-NAME-${i + 1}`,
							message,
							code: "ERR_ASSERTION",
							kind: "assertion" as const,
						},
					],
				})),
			};

			return { execution, repeat: execution };
		})(),
		scenarios: Array.from({ length: files }, (_, i) => ({
			scenario: `S${i + 1}`,
			kind: "preservation" as const,
			mode: "checked" as const,
			file: `checks/s${i + 1}.test.mjs`,
			oracleKey: {
				contractScopeDigest: digestOf("s"),
				criteriaDigest: digestOf("c"),
				sourceDigest: digestOf(`f${i}`),
			},
		})),
	});
}

test("accept retry: feedback carries the refusal facts, bounded per file and in total", () => {
	const one = refusedEvidence(1, "Expected values to be strictly equal");
	assert.equal(one.assessment.kind, "refused");

	if (one.assessment.kind !== "refused") return;
	const feedback = baseRetryFeedback(one.receipt, one.assessment.failure);

	assert.deepEqual(feedback, {
		reason: "preservation_failed",
		sentence: "A preservation check fails on the unchanged base.",
		scenarios: ["S1"],
		files: [
			{
				scenario: "S1",
				file: "checks/s1.test.mjs",
				kind: "assertion",
				code: "ERR_ASSERTION",
				message: "Expected values to be strictly equal",
			},
		],
		omitted: 0,
	});
	assert.doesNotMatch(JSON.stringify(feedback), /PRIVATE-NAME/);

	const many = refusedEvidence(30, "x".repeat(2_000));
	assert.equal(many.assessment.kind, "refused");

	if (many.assessment.kind !== "refused") return;
	const bounded = baseRetryFeedback(many.receipt, many.assessment.failure);

	assert.ok(Buffer.byteLength(JSON.stringify(bounded)) <= 4096);
	assert.ok(bounded.files.length > 0);
	assert.ok(bounded.files.every((f) => f.message.length <= 500));
	assert.equal(bounded.files.length + bounded.omitted, 30);
	assert.ok(bounded.omitted > 0);
	assert.equal(bounded.scenarios.length, 30);
});

test("accept retry: the claim's retry record round-trips and binds to the same run and contract", () => {
	const sha = "a".repeat(40);
	const repo = "o/r";

	if (!isGitSha(sha) || !isRepoSlug(repo)) throw new Error("fixture");

	const refused = {
		runId: digestOf("r"),
		repo,
		issue: 9,
		contractDigest,
		acceptanceDigest: digestOf("first suite"),
		baseSha: sha,
		gateSha: sha,
	};

	const retry = { refused, reason: "preservation_failed", baseWallMs: 4000 };

	const pending = {
		binding: refused,
		acceptAttempt: 1,
		remainingAcceptMs: 9,
		retry,
	};

	const parsed = parseBaseCheckReference(JSON.parse(JSON.stringify(pending)));
	assert.deepEqual(parsed, pending);
	assert.equal(parsed !== null && retryPending(parsed), true);

	const rebound = {
		...pending,
		binding: { ...refused, acceptanceDigest: digestOf("second suite") },
	};

	const stored = parseBaseCheckReference(JSON.parse(JSON.stringify(rebound)));
	assert.deepEqual(stored, rebound);
	assert.equal(stored !== null && retryPending(stored), false);

	for (const bad of [
		{ ...retry, reason: "base_unknown" },
		{ ...retry, baseWallMs: -1 },
		{ ...retry, refused: { ...refused, issue: 10 } },
		{
			...retry,
			refused: { ...refused, contractDigest: contractDigestFor("x") },
		},
	])
		assert.equal(
			parseBaseCheckReference(
				JSON.parse(JSON.stringify({ ...pending, retry: bad })),
			),
			null,
		);
});
