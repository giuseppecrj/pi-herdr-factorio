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
import { writeAcceptance } from "../src/accept.ts";
import {
	parseSpecifyOutput,
	contractBytes,
	contractDigestOf,
	type Contract,
} from "../src/specify.ts";
import { baseTreeDigest, exportTree, runHeldoutBase } from "../server/gates.ts";
import {
	checkoutWorkspace,
	controllerBaseChecker,
	fileRunFiles,
} from "../server/controller.ts";
import {
	assessBase,
	baseRefusalNotice,
	type BaseReason,
} from "../src/diagnosis.ts";
import { digestOf } from "../src/run.ts";
import { isGitSha, isRepoSlug } from "../src/workflow.ts";

function missing(argv: readonly string[]): string | null {
	const [command = "", ...args] = argv;

	try {
		execFileSync(command, args, { stdio: "ignore", timeout: 10_000 });

		return null;
	} catch {
		return `${argv.join(" ")} failed in this environment`;
	}
}

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
	gates: "trusted" | "absent" | Readonly<{ reporter: string }> = "trusted",
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

		if (gates !== "trusted")
			writeFileSync(
				join(tree, ".github/factory/gates/reporter.mjs"),
				gates.reporter,
			);
	}

	writeFileSync(
		join(tree, "package.json"),
		'{"name":"base","version":"1.0.0","type":"module"}',
	);
	writeFileSync(
		join(tree, "package-lock.json"),
		'{"name":"base","version":"1.0.0","lockfileVersion":3,"packages":{"":{"name":"base","version":"1.0.0"}}}',
	);

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

	return { root, tree, contract, binding, evidence, ...assessBase(evidence) };
}

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
