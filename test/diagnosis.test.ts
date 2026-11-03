import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import {
	mkdirSync,
	mkdtempSync,
	readFileSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { test } from "node:test";
import { acceptanceEntries, writeAcceptance } from "../src/accept.ts";
import {
	assessBase,
	classifyFailure,
	diagnosisNeeds,
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

	for (const reason of [
		"npmrc_changed",
		"replacement_deleted",
		"unauthorized_acceptance",
		"invalid_source_encoding",
	])
		assert.equal(abort(reason).kind, "candidate", reason);
	assert.equal(abort("runtime_patching").kind, "missing_evidence");
	assert.equal(
		abort("runtime_patching", { tamperSignals: [{ rule: "runtime_patching" }] })
			.kind,
		"candidate",
	);
	assert.equal(
		abort("suppression_added", {
			tamperSignals: [{ rule: "suppression_added" }],
		}).kind,
		"candidate",
	);
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
		{ kind: "missing_evidence", reason: "materialize_mismatch" },
	);
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
