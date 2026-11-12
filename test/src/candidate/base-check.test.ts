import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import {
	cpSync,
	existsSync,
	mkdirSync,
	mkdtempSync,
	readdirSync,
	readFileSync,
	rmSync,
	statSync,
	symlinkSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { test } from "node:test";
import {
	controllerBaseChecker,
	controllerDraftChecker,
} from "../../../host/controller/checkers.ts";
import { checkoutWorkspace } from "../../../host/controller/checkout.ts";
import { fileRunFiles } from "../../../host/controller/run-files.ts";
import {
	baseTreeDigest,
	runDraftBase,
	runHeldoutBase,
} from "../../../host/gates/base.ts";
import { exportTree } from "../../../host/gates/materialize.ts";
import {
	assessBase,
	baseRefusalNotice,
	baseRetryFeedback,
	draftCheckFeedback,
	parseBaseReceipt,
	retryableBaseReason,
	type BaseReason,
} from "../../../src/candidate/diagnosis.ts";
import { isGitSha } from "../../../src/config/schema.ts";
import { writeAcceptance } from "../../../src/contract/acceptance.ts";
import {
	contractBytes,
	contractDigestOf,
	type Contract,
} from "../../../src/contract/contract.ts";
import { parseSpecifyOutput } from "../../../src/contract/parse.ts";
import { digestOf } from "../../../src/core/run.ts";
import { isRepoSlug } from "../../../src/trust/platform.ts";

function missing(argv: readonly string[]): string | null {
	const [command = "", ...args] = argv;

	try {
		execFileSync(command, args, {
			stdio: ["ignore", "ignore", "pipe"],
			timeout: 10_000,
		});

		return null;
	} catch (error) {
		const stderr =
			error instanceof Error && "stderr" in error
				? String(error.stderr).trim()
				: "";

		return `${argv.join(" ")} failed in this environment${stderr ? `: ${stderr.slice(0, 300)}` : ""}`;
	}
}

const strict = process.env.FACTORY_REQUIRE_SANDBOX_TESTS === "1";

const bwrap = missing([
	"bwrap",
	"--unshare-all",
	"--die-with-parent",
	"--ro-bind",
	"/",
	"/",
	"true",
]);

const scope =
	bwrap ?? missing(["systemd-run", "--user", "--scope", "--quiet", "true"]);

const checkout = missing(["git", "rev-parse", "--verify", "HEAD"]);

function where(
	absent: string | null,
	name: string,
	fn: (t: import("node:test").TestContext) => Promise<void>,
) {
	if (absent === null) test(name, fn);
	else if (strict)
		test(name, () =>
			assert.fail(`FACTORY_REQUIRE_SANDBOX_TESTS=1 but ${absent}`),
		);
	else test(name, (t) => t.diagnostic(`not run: ${absent}`));
}

const criteria = [
	{ id: "A1", kind: "new_behavior" as const, text: "Return two" },
	{ id: "A2", kind: "preservation" as const, text: "Keep errors" },
] as const;

const suite = {
	version: 2,
	scenarios: [
		{ id: "S1", criteria: ["A1"], checks: ["one.test.mjs"], judge: null },
		{ id: "S2", criteria: ["A2"], checks: ["two.test.mjs"], judge: null },
	],
	files: ["one", "two"].map((n) => ({
		path: `${n}.test.mjs`,
		type: "node:test",
		content: "import {test} from 'node:test'; test('value',()=>{});",
	})),
};

test("v2 criteria are strict objects and suite kinds are derived with exclusive file ownership", () => {
	const draft = {
		kind: "contract",
		summary: "Two",
		behavior: ["Return two"],
		exclusions: [],
		acceptance: criteria.map(({ kind, text }) => ({ kind, text })),
		compatibility: [],
		limits: [],
		files: [],
		evidence: [],
	};

	assert.equal(
		parseSpecifyOutput(JSON.stringify(draft), new Set()).kind,
		"contract",
	);

	for (const acceptance of [
		["Return two"],
		[{ text: "Return two" }],
		[{ kind: "unknown", text: "Return two" }],
	])
		assert.equal(
			parseSpecifyOutput(JSON.stringify({ ...draft, acceptance }), new Set())
				.kind,
			"malformed",
		);

	const parsed = writeAcceptance(JSON.stringify(suite), {
		acceptance: [...criteria],
	});

	assert.equal(parsed.kind, "suite");

	if (parsed.kind !== "suite") return;
	assert.deepEqual(
		parsed.suite.scenarios.map((s) => s.kind),
		["new_behavior", "preservation"],
	);

	for (const scenarios of [
		[{ ...suite.scenarios[0], criteria: ["A1", "A2"] }],
		suite.scenarios.map((s) => ({ ...s, checks: ["one.test.mjs"] })),
		[
			{ ...suite.scenarios[0], checks: [], judge: "Review" },
			suite.scenarios[1],
		],
		[
			{ ...suite.scenarios[0], checks: ["one.test.mjs", "two.test.mjs"] },
			suite.scenarios[1],
		],
	])
		assert.equal(
			writeAcceptance(JSON.stringify({ ...suite, scenarios }), {
				acceptance: [...criteria],
			}).kind,
			"malformed",
		);
});

test("real trusted reporter distinguishes assertion cause, load and in-body errors without losing passing siblings", (t) => {
	const root = mkdtempSync(join(tmpdir(), "base-reporter-"));
	t.after(() => rmSync(root, { recursive: true, force: true }));
	mkdirSync(join(root, "tree"));
	const file = join(root, "tree", "shape.test.mjs");

	const run = (source: string) => {
		writeFileSync(file, source);

		try {
			return execFileSync(
				process.execPath,
				[
					"--test",
					"--test-reporter",
					resolve(".github/factory/gates/reporter.mjs"),
					file,
				],
				{
					encoding: "utf8",
					stdio: ["ignore", "pipe", "pipe"],
					env: { PATH: process.env.PATH, HOME: "/tmp" },
				},
			);
		} catch (e) {
			assert.ok(e instanceof Error && "stdout" in e);

			return String(e.stdout);
		}
	};

	const facts = JSON.parse(
		run(
			"import {test} from 'node:test'; import assert from 'node:assert/strict'; test('sibling',()=>{}); test('PRIVATE-TITLE',()=>assert.equal(1,2,'PRIVATE-ASSERTION'));",
		),
	);

	assert.equal(facts.complete, true);
	assert.equal(facts.failures[0].code, "ERR_ASSERTION");
	assert.equal(facts.failures[0].kind, "assertion");
	assert.match(facts.failures[0].message, /PRIVATE-ASSERTION/);
	assert.equal(facts.counts["shape.test.mjs"], 2);

	const runtime = JSON.parse(
		run(
			"import {test} from 'node:test'; test('runtime',()=>{throw new TypeError('broken')});",
		),
	);

	assert.equal(runtime.failures[0].kind, "runtime_error");
	const load = JSON.parse(run("throw new Error('load');"));
	assert.equal(load.failures[0].kind, "load_error");
	assert.ok(readFileSync(file, "utf8").includes("load"));
});

const prefix =
	"import {test} from 'node:test'; import assert from 'node:assert/strict'; ";

const cases: readonly (readonly [
	string,
	string,
	BaseReason | "ready",
	"new_behavior" | "preservation",
])[] = [
	[
		"assertion red with passing sibling",
		"test('sibling',()=>{}); test('red',()=>assert.equal(1,2));",
		"ready",
		"new_behavior",
	],
	[
		"preserved",
		"test('green',()=>assert.equal(1,1));",
		"ready",
		"preservation",
	],
	[
		"not reproduced",
		"test('green',()=>assert.equal(1,1));",
		"acceptance_not_reproduced",
		"new_behavior",
	],
	[
		"preservation red",
		"test('red',()=>assert.equal(1,2));",
		"preservation_failed",
		"preservation",
	],
	[
		"in-body error",
		"test('red',()=>{throw new TypeError('PRIVATE-RUNTIME')});",
		"base_non_assertion_failure",
		"new_behavior",
	],
	[
		"load error",
		"throw new Error('PRIVATE-LOAD');",
		"base_load_error",
		"new_behavior",
	],
	["zero tests", "", "base_no_tests", "new_behavior"],
	["skip", "test.skip('skip',()=>{});", "base_skip", "new_behavior"],
	["todo", "test.todo('todo',()=>{});", "base_todo", "new_behavior"],
	[
		"nested assertion",
		"test('parent',async t=>{await t.test('red',()=>assert.equal(1,2));});",
		"ready",
		"new_behavior",
	],
	[
		"mixed load and red",
		"test('red',()=>assert.equal(1,2)); throw new Error('load');",
		"base_load_error",
		"new_behavior",
	],
];

export async function baseFixture(
	t: { after(fn: () => void): void },
	source: string,
	kind: "new_behavior" | "preservation" = "new_behavior",
	timeout = 10_000,
	gates:
		| "trusted"
		| "absent"
		| Readonly<{ reporter?: string; scanRules?: string | null }> = "trusted",
	dependency: "none" | "yaml" = "none",
) {
	const root = mkdtempSync(join(tmpdir(), "factory-base-"));
	t.after(() => rmSync(root, { recursive: true, force: true }));
	const tree = join(root, "base");
	mkdirSync(tree);

	if (gates !== "absent") {
		cpSync(
			resolve(".github/factory/gates"),
			join(tree, ".github/factory/gates"),
			{
				recursive: true,
			},
		);

		if (gates !== "trusted" && gates.reporter !== undefined)
			writeFileSync(
				join(tree, ".github/factory/gates/reporter.mjs"),
				gates.reporter,
			);
		const rules = join(tree, ".github/factory/gates/scan-rules.json");

		const scanRules = gates === "trusted" ? undefined : gates.scanRules;

		if (scanRules === null) rmSync(rules);
		else if (scanRules !== undefined) writeFileSync(rules, scanRules);
	}

	const deps = dependency === "yaml" ? { yaml: "^2.9.0" } : undefined;

	writeFileSync(
		join(tree, "package.json"),
		JSON.stringify({
			name: "base",
			version: "1.0.0",
			type: "module",
			dependencies: deps,
		}),
	);

	const rootPackage = { name: "base", version: "1.0.0", dependencies: deps };

	const yamlPackage = {
		version: "2.9.0",
		resolved: "https://registry.npmjs.org/yaml/-/yaml-2.9.0.tgz",
		integrity:
			"sha512-2AvhNX3mb8zd6Zy7INTtSpl1F15HW6Wnqj0srWlkKLcpYl/gMIMJiyuGq2KeI2YFxUPjdlB+3Lc10seMLtL4cA==",
	};

	const packages =
		dependency === "yaml"
			? { "": rootPackage, "node_modules/yaml": yamlPackage }
			: { "": rootPackage };

	const lock = JSON.stringify({
		name: "base",
		version: "1.0.0",
		lockfileVersion: 3,
		packages,
	});

	writeFileSync(join(tree, "package-lock.json"), lock);

	if (dependency === "yaml") {
		const cached = join(root, "dependencies", digestOf(lock));
		mkdirSync(join(cached, "tree/node_modules"), { recursive: true });
		cpSync(
			resolve("node_modules/yaml"),
			join(cached, "tree/node_modules/yaml"),
			{ recursive: true },
		);
		writeFileSync(join(cached, "READY"), digestOf(lock));
	}

	const repo = "owner/repo",
		sha = "a".repeat(40);

	assert.ok(isRepoSlug(repo) && isGitSha(sha));

	const contract: Contract = {
		version: 2,
		runId: digestOf("base fixture"),
		issue: 1,
		base: { repo, sha },
		snapshot: {
			digest: digestOf("snapshot"),
			source: "unedited",
			eventId: "1",
			eventAt: "2026-11-02T00:00:00Z",
		},
		link: null,
		summary: "Base fixture",
		behavior: ["Return two"],
		exclusions: [],
		acceptance: [{ id: "A1", kind, text: "Return two" }],
		compatibility: [],
		limits: [],
		files: [],
		evidence: [],
	};

	const parsed = writeAcceptance(
		JSON.stringify({
			version: 2,
			scenarios: [
				{ id: "S1", criteria: ["A1"], checks: ["shape.test.mjs"], judge: null },
			],
			files: [
				{
					path: "shape.test.mjs",
					type: "node:test",
					content: source || "// no tests\n",
				},
			],
		}),
		contract,
	);

	assert.ok(parsed.kind === "suite");

	const binding = {
		runId: contract.runId,
		repo,
		issue: 1,
		contractDigest: contractDigestOf(contractBytes(contract)),
		acceptanceDigest: digestOf("suite"),
		baseSha: sha,
		gateSha: sha,
	};

	const startedAt = Date.now();

	const evidence = await runHeldoutBase({
		tree,
		workDir: join(root, "execution"),
		cacheDir: join(root, "dependencies"),
		binding,
		contract,
		suite: parsed.suite,
		canary: `factory-holdout-${"0".repeat(64)}`,
		startedAt,
		deadline: startedAt + timeout,
	});

	return {
		root,
		tree,
		contract,
		binding,
		evidence,
		suite: parsed.suite,
		...assessBase(evidence),
	};
}

where(
	bwrap,
	"P7 draft and official base veto a wrapped runtime cause, not expected red",
	async (t) => {
		const f = await baseFixture(
			t,
			`${prefix}test('wrapped',()=>assert.fail('noise'.repeat(150)+'\\nReferenceError: readDurableAccounting is not defined'));`,
		);

		assert.equal(f.receipt.results[0]?.result, "base_non_assertion_failure");

		const draft = await runDraftBase({
			tree: f.tree,
			workDir: join(f.root, "draft-1"),
			cacheDir: join(f.root, "dependencies"),
			binding: f.binding,
			contract: f.contract,
			suite: f.suite,
			canary: `factory-holdout-${"1".repeat(64)}`,
			startedAt: Date.now(),
			deadline: Date.now() + 10000,
		});

		assert.deepEqual(
			assessBase(draft.evidence).receipt.results,
			f.receipt.results,
		);
		assert.match(
			JSON.stringify(draft.details),
			/ReferenceError.*readDurableAccounting/,
		);
		assert.equal(existsSync(join(f.root, "acceptance")), false);
		assert.equal(existsSync(join(f.root, "base-check")), false);
	},
);

for (const [name, source, want, kind] of cases)
	where(bwrap, `isolated base: ${name}`, async (t) => {
		const f = await baseFixture(t, prefix + source, kind);
		assert.equal(
			f.assessment.kind,
			want === "ready" ? "ready" : "refused",
			JSON.stringify(f.evidence),
		);

		if (f.assessment.kind === "refused") {
			assert.equal(
				f.assessment.failure.reason,
				want,
				JSON.stringify(f.evidence),
			);
			const notice = baseRefusalNotice(f.assessment.failure);
			assert.doesNotMatch(notice.body, /PRIVATE-|shape\.test|ERR_ASSERTION/);
		}

		assert.ok(f.evidence.finishedAt >= f.evidence.startedAt);
		assert.equal(f.evidence.runtime.runner, "local-bwrap");
	});

const HOOKED = `${prefix}import { registerHooks } from 'node:module';
registerHooks({ resolve: (s, c, next) => next(s, c) });
test('red', () => assert.equal(1, 2));`;

where(
	bwrap,
	"suite scan: a suite with registerHooks is refused before it runs, with file, line and rule feedback",
	async (t) => {
		const f = await baseFixture(t, HOOKED);

		assert.equal(f.assessment.kind, "refused", JSON.stringify(f.evidence));

		if (f.assessment.kind !== "refused") return;
		assert.equal(f.assessment.failure.reason, "suite_tamper_signal");
		assert.equal(retryableBaseReason(f.assessment.failure.reason), true);
		assert.deepEqual(f.evidence.tamper, [
			{
				file: "test/acceptance/1/checks/shape.test.mjs",
				line: 2,
				rule: "runtime_patching",
			},
		]);
		// The suite never ran: no execution and no dependency install.
		assert.equal(f.evidence.execution.kind, "unavailable");
		assert.equal(f.evidence.execution.wallMs, 0);
		assert.equal(existsSync(join(f.root, "execution", "tree")), false);
		assert.equal(f.evidence.source.kind, "ready");

		const stored = parseBaseReceipt(JSON.stringify(f.receipt));
		assert.deepEqual(stored, f.receipt);
		const feedback = baseRetryFeedback(stored, f.assessment.failure);
		assert.deepEqual(feedback.signals, f.evidence.tamper);
		assert.doesNotMatch(
			baseRefusalNotice(f.assessment.failure).body,
			/shape\.test|runtime_patching/,
		);
	},
);

where(
	bwrap,
	"suite scan: a clean suite still qualifies and a held-out suppression comment passes, as in the gate",
	async (t) => {
		const f = await baseFixture(
			t,
			`${prefix}// eslint-disable-next-line\ntest('red', () => assert.equal(1, 2));`,
		);

		assert.equal(f.assessment.kind, "ready", JSON.stringify(f.evidence));
		assert.equal("tamper" in f.evidence, false);
	},
);

where(
	bwrap,
	"suite scan: the rules come from the base tree's trusted gates, never another copy",
	async (t) => {
		const trusted = JSON.parse(
			readFileSync(".github/factory/gates/scan-rules.json", "utf8"),
		);

		// A base tree whose own rules omit registerHooks lets the same suite run.
		const relaxed = await baseFixture(t, HOOKED, "new_behavior", 10_000, {
			scanRules: JSON.stringify({
				...trusted,
				loaderCalls: trusted.loaderCalls.filter(
					(c: string) => !c.endsWith("registerHooks"),
				),
			}),
		});

		assert.equal("tamper" in relaxed.evidence, false);
		assert.equal(relaxed.evidence.execution.kind, "observed");

		// The rules are part of the recorded protocol.
		const strictBase = await baseFixture(
			t,
			`${prefix}test('red',()=>assert.equal(1,2));`,
		);

		assert.notEqual(
			relaxed.evidence.runtime.protocolDigest,
			strictBase.evidence.runtime.protocolDigest,
		);

		// A base tree without them is unsupported, never scanned by another copy.
		const absent = await baseFixture(t, HOOKED, "new_behavior", 10_000, {
			scanRules: null,
		});

		assert.equal(absent.assessment.kind, "refused");
		assert.equal(
			absent.assessment.kind === "refused" && absent.assessment.failure.reason,
			"base_tree_unsupported",
		);
		assert.equal(absent.evidence.execution.kind, "unavailable");
	},
);

where(
	bwrap,
	"isolated base: a lockfile dependency is importable from the read-only base tree",
	async (t) => {
		const f = await baseFixture(
			t,
			`${prefix}import YAML from 'yaml'; test('S1 parses', () => assert.equal(YAML.parse('a: 1').a, 2));`,
			"new_behavior",
			10_000,
			"trusted",
			"yaml",
		);

		assert.equal(f.assessment.kind, "ready", JSON.stringify(f.evidence));
	},
);

where(
	bwrap,
	"isolated base: no git, no host state or network, and timeout is never red",
	async (t) => {
		const f = await baseFixture(
			t,
			prefix +
				"import {existsSync} from 'node:fs'; test('boundary',()=>{assert.equal(existsSync('.git'),false);assert.equal(existsSync('/home/g'),false);assert.equal(existsSync('/run/user'),false); assert.equal(1,2);});",
		);

		assert.equal(f.assessment.kind, "ready", JSON.stringify(f.evidence));

		const hang = await baseFixture(
			t,
			prefix + "test('hang',async()=>{await new Promise(()=>{});});",
			"new_behavior",
			500,
		);

		assert.equal(hang.assessment.kind, "refused");

		if (hang.assessment.kind === "refused")
			assert.ok(
				["base_timeout", "base_cancelled"].includes(
					hang.assessment.failure.reason,
				),
				JSON.stringify(hang.evidence),
			);
	},
);

where(
	bwrap,
	"isolated base: runs the checks twice in fresh trees and refuses a nondeterministic suite",
	async (t) => {
		const stable = await baseFixture(
			t,
			`${prefix}test('S1 red', () => assert.equal(1, 2));`,
		);

		assert.equal(stable.assessment.kind, "ready");
		assert.equal(stable.evidence.repeat.kind, "observed");
		assert.deepEqual(
			stable.evidence.repeat.kind === "observed" &&
				stable.evidence.repeat.files.map((f) => f.failures.length),
			[1],
		);
		assert.ok(parseBaseReceipt(JSON.stringify(stable.receipt)) !== null);

		const names = Array.from({ length: 40 }, (_, i) => `t${i}`);

		const random = await baseFixture(
			t,
			`${prefix}for (const name of ${JSON.stringify(names)}) test(name, () => assert.ok(Math.random() < 0.5));`,
		);

		assert.equal(random.assessment.kind, "refused");

		if (random.assessment.kind === "refused") {
			assert.equal(random.assessment.failure.reason, "base_nondeterministic");
			assert.equal(
				baseRefusalNotice(random.assessment.failure).body.split("\n")[0],
				"Acceptance refused before build: base_nondeterministic. Two base runs of the checks gave different results. Scenarios: S1.",
			);
		}

		assert.ok(parseBaseReceipt(JSON.stringify(random.receipt)) !== null);

		const fresh = await baseFixture(
			t,
			`${prefix}import {existsSync, writeFileSync} from 'node:fs'; test('S1 first run only', () => { const seen = existsSync('/tmp/seen') || existsSync('seen'); try { writeFileSync('seen', '1'); } catch {} assert.equal(seen, true); });`,
		);

		assert.equal(
			fresh.assessment.kind,
			"ready",
			JSON.stringify(fresh.evidence),
		);
	},
);

function git(cwd: string, ...args: string[]): string {
	return execFileSync("git", ["-C", cwd, ...args], {
		encoding: "utf8",
		env: {
			PATH: process.env.PATH,
			HOME: cwd,
			GIT_AUTHOR_NAME: "t",
			GIT_AUTHOR_EMAIL: "t@example.com",
			GIT_COMMITTER_NAME: "t",
			GIT_COMMITTER_EMAIL: "t@example.com",
		},
	});
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

where(
	checkout,
	"tarball checkout and CI's exportTree produce the same base tree digest at the real repository head",
	async (t) => {
		const root = mkdtempSync(join(tmpdir(), "factory-parity-"));
		t.after(() => rmSync(root, { recursive: true, force: true }));
		const sha = git(".", "rev-parse", "HEAD").trim();
		assert.ok(isGitSha(sha));
		const repo = "owner/repo";
		assert.ok(isRepoSlug(repo));
		const exported = join(root, "exported");
		await exportTree(".", sha, exported);
		const workspace = join(root, "workspace");
		mkdirSync(workspace);

		const checkout = await checkoutWorkspace({
			stateDir: join(root, "state"),
			runId: digestOf("parity"),
			workspace,
			repo,
			sha,
			fetch: async () => tarballOf(".", sha),
		});

		assert.equal(checkout.kind, "ready");
		assert.equal(baseTreeDigest(workspace), baseTreeDigest(exported));
	},
);

async function controllerWorld(
	t: { after(fn: () => void): void },
	extra: (source: string) => void = () => {},
) {
	const root = mkdtempSync(join(tmpdir(), "factory-base-controller-"));
	t.after(() => rmSync(root, { recursive: true, force: true }));
	const source = join(root, "source");
	mkdirSync(join(source, "src"), { recursive: true });
	writeFileSync(
		join(source, "package.json"),
		'{"name":"base","version":"1.0.0","type":"module"}',
	);
	writeFileSync(
		join(source, "package-lock.json"),
		'{"name":"base","version":"1.0.0","lockfileVersion":3,"packages":{"":{"name":"base","version":"1.0.0"}}}',
	);
	writeFileSync(join(source, "src/value.mjs"), "export const value = 1;\n");
	cpSync(
		resolve(".github/factory/gates"),
		join(source, ".github/factory/gates"),
		{ recursive: true },
	);
	extra(source);
	git(root, "init", "-q", source);
	git(source, "add", ".");
	git(source, "commit", "-qm", "base");
	const sha = git(source, "rev-parse", "HEAD").trim();
	const repo = "owner/repo";
	assert.ok(isGitSha(sha) && isRepoSlug(repo));
	const state = join(root, "state");
	mkdirSync(state, { mode: 0o700 });

	const contract: Contract = {
		version: 2,
		runId: digestOf("controller base"),
		issue: 7,
		base: { repo, sha },
		snapshot: {
			digest: digestOf("snapshot"),
			source: "unedited",
			eventId: "1",
			eventAt: "2026-11-02T00:00:00Z",
		},
		link: null,
		summary: "Value two",
		behavior: ["Export two"],
		exclusions: [],
		acceptance: [
			{ id: "A1", kind: "new_behavior", text: "Value is two" },
			{ id: "A2", kind: "preservation", text: "Module still loads" },
		],
		compatibility: [],
		limits: [],
		files: ["src/value.mjs"],
		evidence: [],
	};

	const bytes = contractBytes(contract),
		contractDigest = contractDigestOf(bytes);

	const files = fileRunFiles(state);
	assert.equal(
		await files.writeContract({ contract, bytes, digest: contractDigest }),
		true,
	);
	const imports = `${prefix}import {value} from '../../../../src/value.mjs'; `;

	const parsed = writeAcceptance(
		JSON.stringify({
			version: 2,
			scenarios: [
				{ id: "S1", criteria: ["A1"], checks: ["two.test.mjs"], judge: null },
				{ id: "S2", criteria: ["A2"], checks: ["loads.test.mjs"], judge: null },
			],
			files: [
				{
					path: "two.test.mjs",
					type: "node:test",
					content: `${imports}test('two',()=>assert.equal(value,2,'PRIVATE-MESSAGE'));`,
				},
				{
					path: "loads.test.mjs",
					type: "node:test",
					content: `${imports}test('loads',()=>assert.equal(typeof value,'number'));`,
				},
			],
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

	const binding = {
		runId: contract.runId,
		repo,
		issue: 7,
		contractDigest,
		acceptanceDigest: stored.receipt.acceptanceDigest,
		baseSha: sha,
		gateSha: sha,
	};

	const counter = { fetches: 0 };

	const fetch = async () => {
		counter.fetches++;

		return tarballOf(source, sha);
	};

	const reference = { binding, remainingAcceptMs: 900_000 };
	const signal = new AbortController().signal;

	return {
		root,
		source,
		sha,
		state,
		contract,
		binding,
		reference,
		signal,
		counter,
		fetch,
	};
}

test("controller draft checks are private, reuse a fresh tarball and never use the stored canary or official receipt store", async (t) => {
	const w = await controllerWorld(t);
	const stageDir = join(w.state, "stages", w.contract.runId, "accept-2");
	const canaries: string[] = [];

	const storedCanary = readFileSync(
		join(w.state, "acceptance", w.contract.runId, "canary.txt"),
		"utf8",
	).trim();

	const text = JSON.stringify({
		version: 2,
		scenarios: [
			{ id: "S1", criteria: ["A1"], checks: ["one.test.mjs"], judge: null },
			{ id: "S2", criteria: ["A2"], checks: ["two.test.mjs"], judge: null },
		],
		files: [
			{
				path: "one.test.mjs",
				type: "node:test",
				content: `${prefix}test('red',()=>assert.equal(1,2));`,
			},
			{
				path: "two.test.mjs",
				type: "node:test",
				content: `${prefix}test('kept',()=>{});`,
			},
		],
	});

	const check = controllerDraftChecker({
		stateDir: w.state,
		stageDir,
		attempt: 2,
		input: {
			contract: w.contract,
			digest: w.binding.contractDigest,
			repo: w.binding.repo,
			issue: w.binding.issue,
			baseSha: w.sha,
		},
		fetch: w.fetch,
		runner: {
			kind: "draft-inspect",
			async run(input) {
				assert.ok(input.argv.includes("/d/draft-reporter.mjs"));
				assert.match(input.scope ?? "", /-draftcheck-2-/);
				assert.ok(input.detailReporter?.endsWith("host/gates/"));

				const file = "test/acceptance/7/checks/one.test.mjs",
					other = "test/acceptance/7/checks/two.test.mjs";

				const source = readFileSync(join(input.tree, file), "utf8");
				const canary = /factory-holdout-[a-f0-9]{64}/.exec(source)?.[0];
				assert.ok(canary);
				canaries.push(canary);

				const failure = {
					file,
					name: "red",
					message: `assertion ${canary}`,
					code: "ERR_ASSERTION",
					kind: "assertion",
				};

				return {
					exitCode: 1,
					stdout: JSON.stringify({
						complete: true,
						bad: true,
						invalid: false,
						truncated: false,
						counts: { [file]: 1, [other]: 1 },
						failures: [failure],
					}),
					stderr: JSON.stringify({
						complete: true,
						invalid: false,
						truncated: false,
						failures: [{ ...failure, causes: [], at: [] }],
					}),
				};
			},
		},
	});

	assert.equal(
		await check("malformed", {
			signal: w.signal,
			deadline: Date.now() + 60000,
			run: 1,
		}),
		null,
	);
	assert.equal(w.counter.fetches, 0);

	for (const run of [1, 2] as const) {
		const feedback = await check(text, {
			signal: w.signal,
			deadline: Date.now() + 60000,
			run,
		});

		assert.equal(feedback?.verdict, "would_qualify");
		assert.doesNotMatch(JSON.stringify(feedback), /factory-holdout-/);
		assert.equal(
			statSync(join(stageDir, `draft-${run}.json`)).mode & 0o777,
			0o600,
		);
		assert.equal(existsSync(join(stageDir, `draft-${run}`)), false);
	}

	assert.equal(w.counter.fetches, 1);
	assert.equal(canaries.length, 4);
	assert.equal(canaries.includes(storedCanary), false);
	assert.notEqual(canaries[0], canaries[2]);
	assert.equal(existsSync(join(w.state, "base-check")), false);
	assert.equal(
		readFileSync(
			join(w.state, "acceptance", w.contract.runId, "canary.txt"),
			"utf8",
		).trim(),
		storedCanary,
	);
});

where(
	bwrap,
	"official base refuses missing or malformed detail evidence rather than qualifying a truncated stdout assertion",
	async (t) => {
		const f = await baseFixture(
			t,
			`${prefix}test('red',()=>assert.equal(1,2));`,
		);

		const file = "test/acceptance/1/checks/shape.test.mjs";

		const failure = {
			file,
			name: "red",
			message: "red",
			code: "ERR_ASSERTION",
			kind: "assertion",
		};

		for (const stderr of [
			"",
			"{}",
			JSON.stringify({
				complete: true,
				invalid: false,
				truncated: true,
				failures: [],
			}),
			JSON.stringify({
				complete: true,
				invalid: false,
				truncated: false,
				failures: [],
			}),
		]) {
			const evidence = await runHeldoutBase({
				tree: f.tree,
				workDir: join(f.root, "invalid"),
				cacheDir: join(f.root, "dependencies"),
				binding: f.binding,
				contract: f.contract,
				suite: f.suite,
				canary: `factory-holdout-${"1".repeat(64)}`,
				startedAt: Date.now(),
				deadline: Date.now() + 10000,
				runner: {
					kind: "missing-detail",
					async run() {
						return {
							exitCode: 1,
							stdout: JSON.stringify({
								complete: true,
								bad: true,
								invalid: false,
								truncated: false,
								counts: { [file]: 1 },
								failures: [failure],
							}),
							stderr,
						};
					},
				},
			});

			assert.equal(
				assessBase(evidence).receipt.results[0]?.result,
				"base_evidence_missing",
			);
		}
	},
);

test("detail correlation follows trusted failures by identity, not scenario enumeration order", async (t) => {
	const w = await controllerWorld(t);

	const files = fileRunFiles(w.state),
		stored = await files.artifacts.read(
			w.contract.runId,
			w.contract,
			w.binding.contractDigest,
		);

	assert.ok(stored.kind === "found");

	const failures = ["loads.test.mjs", "two.test.mjs"].map((name) => ({
		file: `test/acceptance/7/checks/${name}`,
		name: "failure",
		message: "red",
		kind: "assertion",
		code: "ERR_ASSERTION",
	}));

	const tree = join(w.root, "order-source");
	await exportTree(w.source, w.sha, tree);

	const evidence = await runHeldoutBase({
		tree,
		workDir: join(w.root, "order"),
		cacheDir: join(w.root, "deps"),
		binding: w.binding,
		contract: w.contract,
		suite: stored.suite,
		canary: `factory-holdout-${"3".repeat(64)}`,
		startedAt: Date.now(),
		deadline: Date.now() + 10000,
		runner: {
			kind: "ordered-events",
			async run() {
				return {
					exitCode: 1,
					stdout: JSON.stringify({
						complete: true,
						bad: true,
						invalid: false,
						truncated: false,
						counts: Object.fromEntries(failures.map((f) => [f.file, 1])),
						failures,
					}),
					stderr: JSON.stringify({
						complete: true,
						invalid: false,
						truncated: false,
						failures: failures.map((f) => ({ ...f, causes: [], at: [] })),
					}),
				};
			},
		},
	});

	assert.deepEqual(
		assessBase(evidence).receipt.results.map((r) => r.result),
		["expected_red", "preservation_failed"],
	);
});

where(
	bwrap,
	"P6 native literal and procs replay feedback keeps both root causes",
	async (t) => {
		for (const [source, kind, reason, pattern] of [
			[
				"test('literal',()=>assert.equal('readable','available'));",
				"preservation",
				"preservation_failed",
				/readable.*available/s,
			],
			[
				"test('procs',()=>{const input={};const {self}=input.procs;assert.ok(self);});",
				"new_behavior",
				"base_non_assertion_failure",
				/input.procs/,
			],
		] as const) {
			const f = await baseFixture(t, prefix + source, kind);

			const draft = await runDraftBase({
				tree: f.tree,
				workDir: join(f.root, "draft"),
				cacheDir: join(f.root, "dependencies"),
				binding: f.binding,
				contract: f.contract,
				suite: f.suite,
				canary: `factory-holdout-${"2".repeat(64)}`,
				startedAt: Date.now(),
				deadline: Date.now() + 10000,
			});

			const feedback = draftCheckFeedback(
				assessBase(draft.evidence).receipt,
				draft.details,
				1,
			);

			assert.equal(feedback.reason, reason);
			assert.match(feedback.files[0]?.failures[0]?.message ?? "", pattern);
		}
	},
);

async function settled(
	checker: ReturnType<typeof controllerBaseChecker>,
	input: Parameters<ReturnType<typeof controllerBaseChecker>["check"]>[0],
) {
	let progress = await checker.check(input);

	for (let i = 0; i < 200 && progress.kind === "checking"; i++) {
		await new Promise((r) => setTimeout(r, 50));
		progress = await checker.check(input);
	}

	return progress;
}

where(
	scope,
	"controller base check runs in a scope, keeps 0600 receipts, survives restart and charges an interruption once",
	async (t) => {
		const { state, contract, binding, reference, signal, counter, fetch } =
			await controllerWorld(t);

		const checker = controllerBaseChecker({ stateDir: state, fetch });
		assert.deepEqual(
			await checker.check({ ...reference, acceptAttempt: 1, signal }),
			{
				kind: "checking",
			},
		);

		let progress = await checker.check({
			...reference,
			acceptAttempt: 1,
			signal,
		});

		for (let i = 0; i < 200 && progress.kind === "checking"; i++) {
			await new Promise((r) => setTimeout(r, 50));
			progress = await checker.check({
				...reference,
				acceptAttempt: 1,
				signal,
			});
		}

		assert.equal(progress.kind, "ready", JSON.stringify(progress));
		assert.equal(counter.fetches, 1);

		const dir = join(
			state,
			"base-check",
			contract.runId,
			digestOf(JSON.stringify(binding)),
			"a1",
		);

		assert.deepEqual(readdirSync(dir).sort(), [
			"intent.json",
			"result.digest",
			"result.json",
		]);

		for (const name of readdirSync(dir))
			assert.equal(statSync(join(dir, name)).mode & 0o777, 0o600);
		assert.equal(statSync(dir).mode & 0o777, 0o700);
		const receipt = JSON.parse(readFileSync(join(dir, "result.json"), "utf8"));
		assert.deepEqual(
			receipt.results.map((r: { result: string }) => r.result),
			["expected_red", "preserved"],
		);
		assert.equal(receipt.evidence.source.kind, "ready");
		assert.match(
			JSON.stringify(readFileSync(join(dir, "intent.json"), "utf8")),
			/factory-stage-[0-9a-f]{8}-[0-9a-f]{16}-basecheck-1-/,
		);

		const restarted = controllerBaseChecker({ stateDir: state, fetch });

		const again = await restarted.check({
			...reference,
			acceptAttempt: 1,
			signal,
			readOnly: true,
		});

		assert.equal(again.kind, "ready");
		assert.equal(counter.fetches, 1);
		assert.equal(
			(
				await restarted.check({
					...reference,
					acceptAttempt: 9,
					signal,
					readOnly: true,
				})
			).kind,
			"ready",
		);
		assert.equal(existsSync(join(dirname(dir), "a9")), false);

		const a2 = join(dirname(dir), "a2");
		mkdirSync(a2, { mode: 0o700 });
		writeFileSync(
			join(a2, "intent.json"),
			`${JSON.stringify({ bindingDigest: digestOf(JSON.stringify(binding)), binding, startedAt: 1000, deadline: 4000 })}\n`,
			{ mode: 0o600 },
		);

		const interrupted = await restarted.check({
			...reference,
			acceptAttempt: 2,
			signal,
		});

		assert.deepEqual(interrupted, { kind: "interrupted", wallMs: 3000 });
		assert.deepEqual(
			await controllerBaseChecker({ stateDir: state, fetch }).check({
				...reference,
				acceptAttempt: 2,
				signal,
			}),
			interrupted,
		);

		const third = controllerBaseChecker({ stateDir: state, fetch });
		assert.equal(
			(await third.check({ ...reference, acceptAttempt: 3, signal })).kind,
			"checking",
		);
		await third.stop(contract.runId);

		const intent = JSON.parse(
			readFileSync(join(dirname(dir), "a3", "intent.json"), "utf8"),
		);

		const charged =
			receipt.evidence.finishedAt - receipt.evidence.startedAt + 3000;

		assert.equal(
			intent.deadline - intent.startedAt,
			Math.min(180_000, 900_000 - charged),
		);
	},
);

test("a stored refusal carries its receipt and every attempt's base wall on that binding", async () => {
	const state = mkdtempSync(join(tmpdir(), "factory-base-wall-"));

	try {
		const sha = "a".repeat(40);
		const repo = "o/r";

		if (!isGitSha(sha) || !isRepoSlug(repo)) throw new Error("fixture");

		const binding = {
			runId: digestOf("wall-run"),
			repo,
			issue: 7,
			contractDigest: contractDigestOf("wall-contract"),
			acceptanceDigest: digestOf("suite"),
			baseSha: sha,
			gateSha: sha,
		};

		const execution = {
			kind: "observed" as const,
			exitCode: 1,
			wallMs: 5,
			files: [
				{
					file: "two.test.mjs",
					registered: 1,
					failures: [
						{
							file: "two.test.mjs",
							name: "two",
							message: "Expected 1 to equal 2",
							code: "ERR_ASSERTION",
							kind: "assertion" as const,
						},
					],
				},
			],
		};

		const { receipt } = assessBase({
			binding,
			runtime: {
				runner: "local-bwrap",
				node: "v",
				platform: "p",
				bwrap: "b",
				protocolDigest: digestOf("p"),
			},
			startedAt: 10_000,
			finishedAt: 30_000,
			source: {
				kind: "ready",
				treeDigest: digestOf("t"),
				lockDigest: digestOf("l"),
				gatesDigest: digestOf("g"),
			},
			execution,
			repeat: execution,
			scenarios: [
				{
					scenario: "S2",
					kind: "preservation",
					mode: "checked",
					file: "two.test.mjs",
					oracleKey: {
						contractScopeDigest: digestOf("s"),
						criteriaDigest: digestOf("c"),
						sourceDigest: digestOf("f"),
					},
				},
			],
		});

		const parent = join(
			state,
			"base-check",
			binding.runId,
			digestOf(JSON.stringify(binding)),
		);

		const write = (name: string, text: string) => {
			mkdirSync(dirname(join(parent, name)), {
				recursive: true,
				mode: 0o700,
			});
			writeFileSync(join(parent, name), text, { mode: 0o600 });
		};

		// The first attempt was interrupted at its full cap; the second refused.
		write("a1/interrupted.json", `${JSON.stringify({ wallMs: 180_000 })}\n`);
		const text = JSON.stringify(receipt);
		write("a2/result.json", text);
		write("a2/result.digest", digestOf(text));
		const checker = controllerBaseChecker({ stateDir: state });
		const signal = new AbortController().signal;

		for (const readOnly of [false, true]) {
			const progress = await checker.check({
				binding,
				acceptAttempt: 2,
				remainingAcceptMs: 900_000,
				signal,
				readOnly,
			});

			assert.equal(progress.kind, "refused", JSON.stringify(progress));

			if (progress.kind !== "refused") return;
			assert.equal(progress.failure.reason, "preservation_failed");
			assert.deepEqual(progress.receipt, receipt);
			assert.equal(progress.baseWallMs, 20_000 + 180_000);
		}

		// An attempt with neither a result nor an interruption leaves the
		// binding's wall unknown, so the refusal carries none.
		mkdirSync(join(parent, "a3"), { mode: 0o700 });

		const unknown = await checker.check({
			binding,
			acceptAttempt: 2,
			remainingAcceptMs: 900_000,
			signal,
		});

		assert.equal(unknown.kind, "refused");
		assert.equal(unknown.kind === "refused" && unknown.baseWallMs, undefined);
	} finally {
		rmSync(state, { recursive: true, force: true });
	}
});

where(
	scope,
	"a real ustar with a symlink is reported partial and never qualifies",
	async (t) => {
		const w = await controllerWorld(t, (source) => {
			writeFileSync(join(source, "kept.txt"), "kept\n");
			symlinkSync("kept.txt", join(source, "dropped-link"));
		});

		const workspace = join(w.root, "workspace");
		mkdirSync(workspace);

		const checkout = await checkoutWorkspace({
			stateDir: join(w.root, "specify-state"),
			runId: w.contract.runId,
			workspace,
			repo: w.binding.repo,
			sha: w.sha,
			fetch: w.fetch,
		});

		assert.equal(checkout.kind, "ready");
		assert.equal(checkout.kind === "ready" && checkout.omitted, 1);

		const progress = await settled(
			controllerBaseChecker({ stateDir: w.state, fetch: w.fetch }),
			{ ...w.reference, acceptAttempt: 1, signal: w.signal },
		);

		assert.equal(progress.kind, "refused", JSON.stringify(progress));
		assert.equal(
			progress.kind === "refused" && progress.failure.reason,
			"base_tree_unsupported",
		);
	},
);

where(
	scope,
	"the base check never reuses a model-writable workspace as its tree",
	async (t) => {
		const w = await controllerWorld(t);
		const files = fileRunFiles(w.state);
		const workspace = files.workspacePath(w.contract.runId);
		mkdirSync(workspace, { recursive: true });

		const listed = await checkoutWorkspace({
			stateDir: w.state,
			runId: w.contract.runId,
			workspace,
			repo: w.binding.repo,
			sha: w.sha,
			fetch: w.fetch,
		});

		assert.equal(listed.kind, "ready");
		writeFileSync(
			join(workspace, "src/value.mjs"),
			"export const value = 2;\n",
		);

		const progress = await settled(
			controllerBaseChecker({ stateDir: w.state, fetch: w.fetch }),
			{ ...w.reference, acceptAttempt: 1, signal: w.signal },
		);

		assert.equal(progress.kind, "ready", JSON.stringify(progress));
	},
);

where(
	bwrap,
	"the base check runs the base tree's gates, records their digest and refuses without them",
	async (t) => {
		const trusted = await baseFixture(
			t,
			`${prefix}test('red',()=>assert.equal(1,2));`,
		);

		assert.equal(
			trusted.assessment.kind,
			"ready",
			JSON.stringify(trusted.evidence),
		);
		assert.ok(trusted.evidence.source.kind === "ready");
		assert.equal(
			trusted.evidence.source.kind === "ready" &&
				trusted.evidence.source.gatesDigest,
			baseTreeDigest(join(trusted.tree, ".github/factory/gates")),
		);

		const forged = await baseFixture(
			t,
			`${prefix}test('red',()=>assert.equal(1,2));`,
			"new_behavior",
			10_000,
			{
				reporter:
					'export default async function* r(e){for await (const _ of e);yield \'{"complete":true,"bad":false,"counts":{},"failures":[]}\\n\';}\n',
			},
		);

		assert.equal(
			forged.assessment.kind,
			"refused",
			JSON.stringify(forged.evidence),
		);
		assert.notEqual(
			forged.evidence.runtime.protocolDigest,
			trusted.evidence.runtime.protocolDigest,
		);

		const absent = await baseFixture(
			t,
			`${prefix}test('red',()=>assert.equal(1,2));`,
			"new_behavior",
			10_000,
			"absent",
		);

		assert.equal(absent.assessment.kind, "refused");
		assert.equal(
			absent.assessment.kind === "refused" && absent.assessment.failure.reason,
			"base_tree_unsupported",
		);
	},
);

where(
	scope,
	"a base check whose gate SHA is not its base SHA is refused before running",
	async (t) => {
		const w = await controllerWorld(t);
		const gateSha = "f".repeat(40);
		assert.ok(isGitSha(gateSha));
		const binding = { ...w.binding, gateSha };

		const progress = await settled(
			controllerBaseChecker({ stateDir: w.state, fetch: w.fetch }),
			{ ...w.reference, binding, acceptAttempt: 1, signal: w.signal },
		);

		assert.equal(progress.kind, "refused");
		assert.equal(w.counter.fetches, 0);
	},
);

type CorpusManifest = Readonly<{
	issue: number;
	baseSha: string;
	baseFiles: readonly Readonly<{ path: string; blob: string }>[];
	criteria: readonly Readonly<{
		id: string;
		kind: "new_behavior" | "preservation";
		text: string;
	}>[];
	scenarios: readonly Readonly<{
		id: string;
		criteria: readonly string[];
		file: string;
		path: string;
	}>[];
	expected: Readonly<{ reason: BaseReason; scenarios?: readonly string[] }>;
}>;

async function replay(
	t: { after(fn: () => void): void },
	fixture: string,
	replace: Readonly<Record<string, string>> = {},
) {
	const corpus = resolve("test/fixtures/oracle-corpus", fixture);

	const manifest: CorpusManifest = JSON.parse(
		readFileSync(join(corpus, "manifest.json"), "utf8"),
	);

	const root = mkdtempSync(join(tmpdir(), `factory-replay-${fixture}-`));
	t.after(() => rmSync(root, { recursive: true, force: true }));
	const tree = join(root, "base");

	for (const file of manifest.baseFiles) {
		const bytes = readFileSync(join(corpus, "base", file.path));

		const blob = execFileSync("git", ["hash-object", "--stdin"], {
			input: bytes,
			encoding: "utf8",
		}).trim();

		assert.equal(blob, file.blob, `${file.path} is the recorded base blob`);
		mkdirSync(dirname(join(tree, file.path)), { recursive: true });
		writeFileSync(join(tree, file.path), bytes);
	}

	cpSync(
		resolve(".github/factory/gates"),
		join(tree, ".github/factory/gates"),
		{ recursive: true },
	);
	writeFileSync(
		join(tree, "package.json"),
		'{"name":"base","version":"1.0.0","type":"module"}',
	);
	writeFileSync(
		join(tree, "package-lock.json"),
		'{"name":"base","version":"1.0.0","lockfileVersion":3,"packages":{"":{"name":"base","version":"1.0.0"}}}',
	);

	const repo = "owner/repo",
		sha = manifest.baseSha;

	assert.ok(isRepoSlug(repo) && isGitSha(sha));
	const [first, ...rest] = manifest.criteria;
	assert.ok(first !== undefined);

	const contract: Contract = {
		version: 2,
		runId: digestOf(`replay ${fixture}`),
		issue: manifest.issue,
		base: { repo, sha },
		snapshot: {
			digest: digestOf("snapshot"),
			source: "unedited",
			eventId: "1",
			eventAt: "2026-11-02T00:00:00Z",
		},
		link: null,
		summary: `Replay of fixture ${fixture}`,
		behavior: ["Recorded fixture behavior"],
		exclusions: [],
		acceptance: [{ ...first }, ...rest.map((c) => ({ ...c }))],
		compatibility: [],
		limits: [],
		files: [],
		evidence: [],
	};

	const parsed = writeAcceptance(
		JSON.stringify({
			version: 2,
			scenarios: manifest.scenarios.map((s) => ({
				id: s.id,
				criteria: s.criteria,
				checks: [s.path],
				judge: null,
			})),
			files: manifest.scenarios.map((s) => ({
				path: s.path,
				type: "node:test",
				content: replace[s.id] ?? readFileSync(join(corpus, s.file), "utf8"),
			})),
		}),
		contract,
	);

	assert.ok(parsed.kind === "suite", JSON.stringify(parsed));

	const startedAt = Date.now();

	const evidence = await runHeldoutBase({
		tree,
		workDir: join(root, "execution"),
		cacheDir: join(root, "dependencies"),
		binding: {
			runId: contract.runId,
			repo,
			issue: manifest.issue,
			contractDigest: contractDigestOf(contractBytes(contract)),
			acceptanceDigest: digestOf(`suite ${fixture}`),
			baseSha: sha,
			gateSha: sha,
		},
		contract,
		suite: parsed.suite,
		canary: `factory-holdout-${"0".repeat(64)}`,
		startedAt,
		deadline: startedAt + 60_000,
	});

	return { manifest, evidence, ...assessBase(evidence) };
}

for (const fixture of ["558", "561", "568"])
	where(
		bwrap,
		`replays fixture ${fixture}'s recorded suite on its real base content`,
		async (t) => {
			const r = await replay(t, fixture);

			const results = Object.fromEntries(
				r.receipt.results.map((x) => [x.scenario, x.result]),
			);

			assert.equal(r.assessment.kind, "refused", JSON.stringify(results));

			if (r.assessment.kind !== "refused") return;
			assert.equal(
				r.assessment.failure.reason,
				r.manifest.expected.reason,
				JSON.stringify(results),
			);

			for (const id of r.manifest.expected.scenarios ?? [])
				assert.equal(results[id], r.manifest.expected.reason);
			assert.doesNotMatch(
				baseRefusalNotice(r.assessment.failure).body,
				/Human review|viewer|git|assert|\.mjs/i,
			);
			// The first suite's refusal is the author's to fix, so it earns the
			// one feedback retry; the feedback stays bounded and names no test.
			assert.equal(retryableBaseReason(r.assessment.failure.reason), true);
			const feedback = baseRetryFeedback(r.receipt, r.assessment.failure);
			assert.ok(Buffer.byteLength(JSON.stringify(feedback)) <= 4096);
			assert.ok(feedback.files.length > 0);

			// A load error names its file, which the feedback may carry.
			for (const failure of r.evidence.execution.kind === "observed"
				? r.evidence.execution.files.flatMap((f) => f.failures)
				: [])
				if (failure.name !== failure.file)
					assert.ok(!JSON.stringify(feedback).includes(failure.name));
			t.diagnostic(`${fixture}: ${JSON.stringify(results)}`);
		},
	);

where(
	bwrap,
	"a minimal correct version-2 suite qualifies on fixture 568's real base",
	async (t) => {
		const r = await replay(t, "568", {
			S4: `import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const document = readFileSync('docs/operations/viewer.md', 'utf8');

test('existing startup guidance remains available', () => {
  assert.match(document, /node server\\/cli\\.ts viewer --state-dir "\\$STATE" --run "\\$RUN_ID" --port 8080/);
  assert.match(document, /viewer_ready bind=127\\.0\\.0\\.1 port=8080/);
  assert.match(document, /Invalid arguments exit 2/);
});
`,
		});

		assert.equal(r.assessment.kind, "ready", JSON.stringify(r.receipt.results));
		assert.deepEqual(
			r.receipt.results.map((x) => x.result),
			["expected_red", "expected_red", "expected_red", "preserved"],
		);
	},
);
