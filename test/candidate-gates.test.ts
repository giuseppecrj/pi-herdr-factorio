import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import {
	existsSync,
	globSync,
	mkdtempSync,
	mkdirSync,
	readFileSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { test } from "node:test";
import {
	checkCandidate,
	materializeCandidate,
	validateDependencies,
	replacementDigest,
	heldoutDigest,
	receiptPasses,
	type GateRunner,
} from "../server/gates.ts";

function repo(t: { after(fn: () => void): void }) {
	const root = mkdtempSync(join(tmpdir(), "factory-gates-"));
	t.after(() => rmSync(root, { recursive: true, force: true }));

	const git = (...args: string[]) =>
		execFileSync("git", ["-C", root, ...args], { encoding: "utf8" }).trim();

	git("init", "-q");
	git("config", "user.name", "Gate test");
	git("config", "user.email", "gate@example.invalid");

	const put = (path: string, text: string) => {
		mkdirSync(dirname(join(root, path)), { recursive: true });
		writeFileSync(join(root, path), text);
	};

	put("package.json", '{"name":"mini","version":"1.0.0","type":"module"}');
	put(
		"package-lock.json",
		'{"name":"mini","version":"1.0.0","lockfileVersion":3,"packages":{"":{"name":"mini","version":"1.0.0"}}}',
	);
	put("src/value.ts", 'export const value = "main";\n');
	put(
		"test/value.test.ts",
		'import assert from "node:assert/strict"; import {test} from "node:test"; import {value} from "../src/value.ts"; test("value",()=>assert.equal(value,"main"));\n',
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
	put(
		".github/factory/gates/freeze.mjs",
		readFileSync(".github/factory/gates/freeze.mjs", "utf8"),
	);
	put(
		".github/factory/gates/reporter.mjs",
		readFileSync(".github/factory/gates/reporter.mjs", "utf8"),
	);
	put(".github/factory/gates/biome.json", "{}");
	put(
		".github/factory/gates/scan-rules.json",
		readFileSync(".github/factory/gates/scan-rules.json", "utf8"),
	);
	put(".oxlintrc.json", "{}");
	git("add", ".");
	git("commit", "-qm", "main");
	const gateSha = git("rev-parse", "HEAD");

	return {
		root,
		git,
		put,
		gateSha,
		commit: () => {
			git("add", "-A");
			git("commit", "-qm", "candidate");

			return git("rev-parse", "HEAD");
		},
	};
}

const miniRunner: GateRunner = {
	kind: "test-process",
	async run(input) {
		const args = input.argv.map((a) =>
			a
				.replaceAll("/g/", `${input.gates}/`)
				.replaceAll("/w/", `${input.tree}/`),
		);

		try {
			return {
				exitCode: 0,
				stdout: execFileSync(args[0] ?? "node", args.slice(1), {
					cwd: input.tree,
					encoding: "utf8",
					env: { PATH: process.env.PATH, HOME: "/tmp" },
					timeout: 10000,
				}),
				stderr: "",
			};
		} catch (e) {
			assert.ok(e instanceof Error);

			return { exitCode: 1, stdout: "", stderr: e.message };
		}
	},
};

test("merged tree routes imports to candidate source and preserves every unnamed main test and config", async (t) => {
	const f = repo(t);
	f.put("src/value.ts", 'export const value = "candidate";\n');
	f.put(".gitattributes", "src/value.ts export-ignore\n");
	f.put("test/value.test.ts", "deleted regression\n");
	f.put("test/new.test.ts", "new\n");
	f.put("src/biome.json", "{}");
	f.put("tsconfig.json", "weak\n");
	const sha = f.commit();
	const dest = join(f.root, "out");

	const result = await materializeCandidate({
		repository: f.root,
		gateSha: f.gateSha,
		candidateSha: sha,
		dest,
		replacements: [],
	});

	assert.match(readFileSync(join(dest, "src/value.ts"), "utf8"), /candidate/);
	assert.match(
		readFileSync(join(dest, "test/value.test.ts"), "utf8"),
		/assert.equal/,
	);
	assert.equal(readFileSync(join(dest, "test/new.test.ts"), "utf8"), "new\n");
	assert.ok(result.ignoredChanges.includes("src/biome.json"));
	assert.equal(existsSync(join(dest, "src/biome.json")), false);
});

test("a candidate defect cannot pass preserved regression tests; receipts bind both SHAs", async (t) => {
	const f = repo(t);
	f.put("src/value.ts", 'export const value = "wrong";\n');
	f.put("test/value.test.ts", "// no test\n");
	const candidateSha = f.commit();

	const receipt = await checkCandidate({
		repository: f.root,
		gateSha: f.gateSha,
		candidateSha,
		nonce: "unit",
		output: join(f.root, "result"),
		runner: miniRunner,
		install: false,
	});

	assert.equal(receipt.gateSha, f.gateSha);
	assert.equal(receipt.candidateSha, candidateSha);
	assert.equal(receipt.status, "failed");
	assert.equal(
		receipt.checks.find((c) => c.name === "main_tests")?.exitCode,
		1,
	);
});

test("contract replacement is exact, digest checked, and new tests still veto", async (t) => {
	const f = repo(t);
	f.put("src/value.ts", 'export const value = "changed";\n');
	f.put(
		"test/value.test.ts",
		'import assert from "node:assert/strict"; import {test} from "node:test"; import {value} from "../src/value.ts"; test("changed",()=>assert.equal(value,"changed"));\n',
	);
	const candidateSha = f.commit();

	const replacements = [
		{ path: "test/value.test.ts", reason: "Intentional behavior change" },
	];

	const receipt = await checkCandidate({
		repository: f.root,
		gateSha: f.gateSha,
		candidateSha,
		nonce: "unit",
		output: join(f.root, "result"),
		runner: miniRunner,
		install: false,
		replacements,
		replacementsDigest: replacementDigest(replacements),
	});

	assert.equal(receipt.status, "passed");
	assert.deepEqual(
		receipt.replacedTests.map(({ path, reason }) => ({ path, reason })),
		replacements,
	);
	f.put(
		"test/new.cases.ts",
		'import {test} from "node:test"; test("new failure",()=>{throw new Error("FAIL");});\n',
	);

	const failing = await checkCandidate({
		repository: f.root,
		gateSha: f.gateSha,
		candidateSha: f.commit(),
		nonce: "unit",
		output: join(f.root, "new-result"),
		runner: miniRunner,
		install: false,
		replacements,
		replacementsDigest: replacementDigest(replacements),
	});

	assert.equal(failing.status, "failed");
	assert.equal(
		failing.checks.find((c) => c.name === "candidate_tests")?.exitCode,
		1,
	);
});

test("dependency validation rejects non-registry locations, missing integrity and unbounded manifests", () => {
	const manifest = {
		name: "mini",
		version: "1",
		dependencies: { pkg: "1.0.0" },
	};

	const lock = {
		lockfileVersion: 3,
		packages: {
			"": manifest,
			"node_modules/pkg": {
				version: "1.0.0",
				resolved: "https://registry.npmjs.org/pkg/-/pkg-1.0.0.tgz",
				integrity: `sha512-${Buffer.alloc(64).toString("base64")}`,
			},
		},
	};

	assert.equal(
		validateDependencies(JSON.stringify(manifest), JSON.stringify(lock)).length,
		1,
	);

	for (const resolved of [
		"git+https://github.com/evil/x",
		"file:../x",
		"https://evil.invalid/x",
		"https://evil.invalid/pkg/-/pkg-1.0.0.tgz",
		"https://registry.npmjs.org@evil.invalid/x",
	]) {
		assert.throws(
			() =>
				validateDependencies(
					JSON.stringify(manifest),
					JSON.stringify({
						...lock,
						packages: {
							...lock.packages,
							"node_modules/pkg": {
								...lock.packages["node_modules/pkg"],
								resolved,
							},
						},
					}),
				),
			/dependency/,
		);
	}
});

for (const cheat of [
	"assert",
	"exit",
	"reallyExit",
	"exitHook",
	"skip",
	"todo",
	"only",
]) {
	test(`rejects test-process cheat ${cheat} without trusting stdout`, async (t) => {
		const f = repo(t);

		const bodies = new Map(
			Object.entries({
				assert:
					'import assert from "node:assert/strict"; assert.equal = () => {};',
				exit: "process.exit(0);",
				reallyExit: "process.reallyExit(0);",
				exitHook:
					'process.on("exit",()=>{process.exitCode=0;}); test("bad",()=>{throw new Error("fail");});',
				skip: 'test.skip("skip",()=>{});',
				todo: 'test.todo("todo");',
				only: 'test.only("only",()=>{});',
			}),
		);

		f.put(
			"test/cheat.test.ts",
			`import {test} from "node:test"; ${bodies.get(cheat)}\n`,
		);

		const receipt = await checkCandidate({
			repository: f.root,
			gateSha: f.gateSha,
			candidateSha: f.commit(),
			nonce: "unit",
			output: join(f.root, "result"),
			runner: miniRunner,
			install: false,
		});

		assert.equal(receipt.status, "failed");

		if (receipt.reason !== "runtime_patching")
			assert.equal(
				receipt.checks.find((c) => c.name === "candidate_tests")?.exitCode,
				1,
			);
	});
}

function gateInput(f: ReturnType<typeof repo>, candidateSha: string) {
	return {
		repository: f.root,
		gateSha: f.gateSha,
		candidateSha,
		nonce: "unit",
		output: join(f.root, "result"),
		runner: miniRunner,
		install: false,
	};
}

test("preload pins the reporting methods without freezing crypto internals", () => {
	const program = `import assert from "node:assert/strict";
import {Readable} from "node:stream";
import {Serializer,DefaultSerializer} from "node:v8";
import {createCipheriv,createHash} from "node:crypto";
for (const [target,keys] of [[Readable.prototype,["push","read"]],[Serializer.prototype,["writeHeader","writeValue","writeRawBytes","releaseBuffer"]],[DefaultSerializer.prototype,["writeHeader","writeValue","writeRawBytes","releaseBuffer"]],[process.stdout,["write","_write"]]]) for (const key of keys) {
const d=Object.getOwnPropertyDescriptor(target,key); assert.equal(d.writable,false); assert.equal(d.configurable,false);
assert.throws(()=>{target[key]=()=>{};});
}
createCipheriv("aes-256-gcm",Buffer.alloc(32),Buffer.alloc(12)).update("works");
const hash=createHash("sha256"); hash.end("works"); assert.equal(hash.read().toString("hex"),"93f6e11d9ce3e407e0eef9c87aacabf3f31235a92403845bb5093b4c6f01f2e5");
const cipher=createCipheriv("aes-256-gcm",Buffer.alloc(32),Buffer.alloc(12)); cipher.end("works"); assert.equal(cipher.read().length,5);`;

	execFileSync(process.execPath, [
		"--import",
		new URL("../.github/factory/gates/freeze.mjs", import.meta.url).pathname,
		"--input-type=module",
		"-e",
		program,
	]);
});

test("main-owned test globs match npm test and include sandbox cases", () => {
	const root = existsSync("/g/tooling/.github/factory/gates/gates.json")
		? "/g/tooling"
		: ".";

	const manifest = JSON.parse(
		readFileSync(join(root, ".github/factory/gates/gates.json"), "utf8"),
	);

	assert.deepEqual(manifest.testGlobs, [
		"test/*.test.ts",
		"test/sandbox/*.cases.ts",
	]);
	const pkg = JSON.parse(readFileSync(join(root, "package.json"), "utf8"));
	assert.equal(
		pkg.scripts.test,
		`node --experimental-strip-types --test --test-concurrency=1 ${manifest.testGlobs[0]}`,
	);

	for (const pattern of manifest.testGlobs)
		assert.ok(globSync(pattern, { cwd: root }).length > 0);
});

test("removes nested ignore files and candidate-deleted source", async (t) => {
	const f = repo(t);
	f.git("rm", "src/value.ts");

	for (const name of [".gitignore", ".eslintignore", ".prettierignore"])
		f.put(`src/${name}`, "bad.ts\n");
	const dest = join(f.root, "out");
	await materializeCandidate({
		...gateInput(f, f.commit()),
		dest,
		replacements: [],
	});

	for (const name of [
		"value.ts",
		".gitignore",
		".eslintignore",
		".prettierignore",
	])
		assert.equal(existsSync(join(dest, "src", name)), false);
});

test("npmrc edits are policy failures", async (t) => {
	const f = repo(t);
	f.put("src/.npmrc", "registry=https://evil.invalid\n");
	const r = await checkCandidate(gateInput(f, f.commit()));
	assert.equal(r.status, "failed");
	assert.equal(r.reason, "npmrc_changed");
});

test("per-file counts reject extra registrations, except named replacements", async (t) => {
	const f = repo(t);
	f.put(
		"src/value.ts",
		'import {test} from "node:test"; test("extra",()=>{}); export const value = "main";\n',
	);
	const r = await checkCandidate(gateInput(f, f.commit()));
	assert.equal(r.status, "failed");
	f.put("src/value.ts", 'export const value = "main";\n');
	f.put(
		"test/value.test.ts",
		'import {test} from "node:test"; test("one",()=>{}); test("two",()=>{});\n',
	);
	const replacements = [{ path: "test/value.test.ts", reason: "change count" }];

	const replaced = await checkCandidate({
		...gateInput(f, f.commit()),
		replacements,
		replacementsDigest: replacementDigest(replacements),
	});

	assert.equal(replaced.status, "passed");
	assert.match(JSON.stringify(replaced.replacedTests), /beforeDigest/);
	assert.match(JSON.stringify(replaced.replacedTests), /afterDigest/);
});

test("a named replacement cannot silently delete a test", async (t) => {
	const f = repo(t);
	f.git("rm", "test/value.test.ts");

	const replacements = [
		{ path: "test/value.test.ts", reason: "change behavior" },
	];

	const r = await checkCandidate({
		...gateInput(f, f.commit()),
		replacements,
		replacementsDigest: replacementDigest(replacements),
	});

	assert.equal(r.status, "failed");
	assert.equal(r.reason, "replacement_deleted");
});

for (const source of [
	'import {Readable as R} from "node:stream"; R.prototype.push = () => true;',
	'import {DefaultSerializer} from "node:v8"; Object.defineProperty(DefaultSerializer.prototype,"writeValue",{value:()=>true});',
	'import * as a from "node:assert"; Reflect.set(a,"equal",()=>{});',
	'import Module from "node:module"; Module._load = () => {};',
	'import {register} from "node:module"; register("x");',
	'require.extensions[".ts"] = () => {};',
	'process.on("uncaughtException",()=>{});',
	'process.once("beforeExit",()=>{});',
	"process.exitCode = 0;",
	'module.register("x");',
	"Object.assign(process,{exitCode:0});",
	'const {Readable}=await import("node:stream"); Readable.prototype.push=()=>true;',
])
	test(`runtime patching rejected: ${source}`, async (t) => {
		const f = repo(t);
		f.put("src/patch.ts", source);
		const r = await checkCandidate(gateInput(f, f.commit()));
		assert.equal(r.status, "failed");
		assert.equal(r.reason, "runtime_patching");
		assert.match(JSON.stringify(r), /src\/patch.ts/);
	});

for (const directive of [
	"@ts-nocheck",
	"@ts-ignore",
	"@ts-expect-error",
	"oxlint-disable",
	"eslint-disable-next-line",
	"biome-ignore format: reason",
])
	test(`added suppression rejected: ${directive}`, async (t) => {
		const f = repo(t);
		f.put("src/new.ts", `// ${directive}\nexport const n = 1;\n`);
		const r = await checkCandidate(gateInput(f, f.commit()));
		assert.equal(r.status, "failed");
		assert.equal(r.reason, "suppression_added");
	});

test("unchanged main suppressions are not new candidate directives", async (t) => {
	const f = repo(t);
	f.put(
		"src/value.ts",
		'// @ts-expect-error existing main directive\nexport const value = "main";\n',
	);
	const gateSha = f.commit();
	f.put(
		"src/value.ts",
		'// @ts-expect-error existing main directive\nexport const value = "main";\nexport const another = true;\n',
	);
	assert.equal(
		(await checkCandidate({ ...gateInput(f, f.commit()), gateSha })).status,
		"passed",
	);
});

for (const [addition, reason] of [
	["// @ts-nocheck\n", "suppression_added"],
	[
		'import {Readable} from "node:stream"; Readable.prototype.push = () => true;\n',
		"runtime_patching",
	],
] as const)
	test(`changed lines in an existing file are scanned: ${reason}`, async (t) => {
		const f = repo(t);
		f.put("src/value.ts", addition + 'export const value = "main";\n');
		const r = await checkCandidate(gateInput(f, f.commit()));
		assert.equal(r.status, "failed");
		assert.equal(r.reason, reason);
		assert.deepEqual(r.tamperSignals, [
			{ path: "src/value.ts", line: 1, rule: reason },
		]);
	});

for (const bytes of [
	Buffer.from("// \0\n"),
	Buffer.from([47, 47, 32, 255, 10]),
])
	test(`source encoding refuses ${bytes.includes(0) ? "NUL" : "non-UTF-8"} bytes`, async (t) => {
		const f = repo(t);
		writeFileSync(
			join(f.root, "src/value.ts"),
			Buffer.concat([
				Buffer.from("// @ts-nocheck\n"),
				bytes,
				Buffer.from('export const value = "main";\n'),
			]),
		);
		const r = await checkCandidate(gateInput(f, f.commit()));
		assert.equal(r.status, "failed");
		assert.equal(r.reason, "invalid_source_encoding");
	});

for (const path of [
	"test/acceptance/stash/lint.ts",
	"test/acceptance/123/manifest.json",
	"test/acceptance/other/checks/suite.test.ts",
])
	test(`candidate acceptance files require dispatch authorization: ${path}`, async (t) => {
		const f = repo(t);
		f.put(path, "export const value = true;\n");
		const r = await checkCandidate(gateInput(f, f.commit()));
		assert.equal(r.status, "failed");
		assert.equal(r.reason, "unauthorized_acceptance");
	});

test("an empty describe cannot replace a contract-named test even when other files run", async (t) => {
	const f = repo(t);
	f.put(
		"test/other.test.ts",
		'import {test} from "node:test"; test("other",()=>{});\n',
	);
	const gateSha = f.commit();
	f.put(
		"test/value.test.ts",
		'import {describe} from "node:test"; describe("empty",()=>{});\n',
	);

	const replacements = [
		{ path: "test/value.test.ts", reason: "change behavior" },
	];

	const r = await checkCandidate({
		...gateInput(f, f.commit()),
		gateSha,
		replacements,
		replacementsDigest: replacementDigest(replacements),
	});

	assert.equal(r.status, "failed");
	assert.equal(r.candidateCounts["test/value.test.ts"], undefined);
	assert.equal(r.candidateCounts["test/other.test.ts"], 1);
	assert.equal(r.checks.find((c) => c.name === "main_tests")?.exitCode, 1);
});

test("dispatched held-out suppressions are exempt but runtime patching is not", async (t) => {
	const f = repo(t);
	const path = "test/acceptance/123/checks/scenario.test.ts";

	for (const patch of [false, true]) {
		const text =
			'import {test} from "node:test";\n// @ts-expect-error controller-authored suite\ntest("held",()=>{});\n' +
			(patch ? 'process.on("exit",()=>{});\n' : "");

		f.put(path, text);

		const input = {
			...gateInput(f, f.commit()),
			heldoutDir: "test/acceptance/123",
			heldoutDigest: heldoutDigest([{ path, bytes: Buffer.from(text) }]),
		};

		const r = await checkCandidate(input);
		assert.equal(r.status, patch ? "failed" : "passed");
		assert.equal(r.reason, patch ? "runtime_patching" : null);
		assert.ok(r.tamperSignals.every((s) => s.rule !== "suppression_added"));

		if (!patch) {
			f.put("test/acceptance/123/helper.ts", "export const n = 1;\n");

			const extra = await checkCandidate({
				...input,
				candidateSha: f.commit(),
			});

			assert.equal(extra.status, "failed");
			assert.equal(extra.reason, "unauthorized_acceptance");
			f.git("rm", "test/acceptance/123/helper.ts");
		}
	}
});

test("lockfile aliases pin their real package, and swaps are refused", () => {
	const manifest = { dependencies: { alias: "npm:real@^1" } };

	const entry = {
		name: "real",
		version: "1.0.0",
		resolved: "https://registry.npmjs.org/real/-/real-1.0.0.tgz",
		integrity: `sha512-${Buffer.alloc(64).toString("base64")}`,
	};

	const lock = {
		lockfileVersion: 3,
		packages: { "": manifest, "node_modules/alias": entry },
	};

	assert.equal(
		validateDependencies(JSON.stringify(manifest), JSON.stringify(lock)).length,
		1,
	);
	assert.throws(
		() =>
			validateDependencies(
				JSON.stringify(manifest),
				JSON.stringify({
					...lock,
					packages: {
						"": manifest,
						"node_modules/alias": {
							...entry,
							resolved: "https://registry.npmjs.org/wrong/-/wrong-1.0.0.tgz",
						},
					},
				}),
			),
		/package_swap/,
	);
});

test("an alias binds its entry name and declaring parent's dependency spec", () => {
	const entry = (name: string) => ({
		version: "1.0.0",
		resolved: `https://registry.npmjs.org/${name}/-/${name}-1.0.0.tgz`,
		integrity: `sha512-${Buffer.alloc(64).toString("base64")}`,
	});

	const parent = { ...entry("parent"), dependencies: { alias: "npm:real@^1" } };
	const alias = { ...entry("real"), name: "real" };
	const manifest = { dependencies: { parent: "1.0.0" } };

	const lock = {
		lockfileVersion: 3,
		packages: {
			"": manifest,
			"node_modules/parent": parent,
			"node_modules/alias": alias,
		},
	};

	type Packages = Record<
		string,
		| (ReturnType<typeof entry> & { name?: string })
		| typeof parent
		| typeof manifest
	>;

	const validate = (packages: Packages, trusted?: string) =>
		validateDependencies(
			JSON.stringify(manifest),
			JSON.stringify({ ...lock, packages }),
			trusted,
		);

	assert.equal(validate(lock.packages).length, 2);
	assert.throws(
		() =>
			validate({
				...lock.packages,
				"node_modules/alias": { ...alias, name: undefined },
			}),
		/package_swap/,
	);
	assert.throws(
		() =>
			validate({ ...lock.packages, "node_modules/parent": entry("parent") }),
		/package_swap/,
	);
	assert.equal(
		validate({
			"": manifest,
			"node_modules/parent": parent,
			"node_modules/parent/node_modules/alias": alias,
		}).length,
		2,
	);

	const trusted = JSON.stringify({
		...lock,
		packages: {
			...lock.packages,
			"node_modules/parent": { ...parent, dependencies: { alias: "1.0.0" } },
			"node_modules/alias": entry("alias"),
		},
	});

	assert.throws(() => validate(lock.packages, trusted), /package_swap/);
});

test("candidate-added tests pass without a manifest edit and join the next main baseline", async (t) => {
	const f = repo(t);

	const manifest = f.git(
		"show",
		`${f.gateSha}:.github/factory/gates/gates.json`,
	);

	f.put(
		"test/new-thing.test.ts",
		'import {test} from "node:test"; test("new",()=>{});',
	);

	const sha = f.commit();
	assert.equal(
		f.git("show", `${sha}:.github/factory/gates/gates.json`),
		manifest,
	);
	const invocations: (readonly string[])[] = [];

	const runner: GateRunner = {
		kind: miniRunner.kind,
		run: (input) => {
			invocations.push(input.argv);

			return miniRunner.run(input);
		},
	};

	const candidate = await checkCandidate({ ...gateInput(f, sha), runner });
	assert.equal(candidate.status, "passed");
	assert.ok(
		invocations.some((argv) => argv.includes("test/new-thing.test.ts")),
	);
	assert.deepEqual(Object.keys(candidate.baselineCounts), [
		"test/value.test.ts",
	]);
	assert.equal(
		candidate.checks.find((c) => c.name === "candidate_tests")?.exitCode,
		0,
	);
	const main = await checkCandidate({ ...gateInput(f, sha), gateSha: sha });
	assert.equal(main.status, "passed");
	assert.equal(main.baselineCounts["test/new-thing.test.ts"], 1);
	assert.equal(main.candidateCounts["test/new-thing.test.ts"], 1);
});

test("new main sandbox cases are discovered through the main aggregator", async (t) => {
	const f = repo(t);
	const path = ".github/factory/gates/gates.json";
	const manifest = JSON.parse(readFileSync(join(f.root, path), "utf8"));
	f.put(
		path,
		JSON.stringify({
			...manifest,
			testGlobs: ["test/*.test.ts", "test/sandbox/*.cases.ts"],
		}),
	);
	f.put(
		"test/sandbox/new.cases.ts",
		'import {test} from "node:test"; test("new main case",()=>{});',
	);
	f.put("test/sandbox.test.ts", 'import "./sandbox/new.cases.ts";');
	const gateSha = f.commit();
	const r = await checkCandidate({ ...gateInput(f, gateSha), gateSha });
	assert.equal(r.status, "passed");
	assert.equal(r.baselineCounts["test/sandbox/new.cases.ts"], 1);
});

for (const [testGlobs, reason] of [
	[[], "invalid_gate_manifest"],
	[["test/value.test.ts"], "invalid_gate_manifest"],
	[["../*.test.ts"], "invalid_gate_manifest"],
	[["test/*.test.ts", "test/*.test.ts"], "invalid_gate_manifest"],
	[["test/sandbox/*.cases.ts"], "missing_tests"],
] as const) {
	test(`invalid or empty main test globs fail closed: ${JSON.stringify(testGlobs)}`, async (t) => {
		const f = repo(t);
		const path = ".github/factory/gates/gates.json";
		const manifest = JSON.parse(readFileSync(join(f.root, path), "utf8"));
		f.put(path, JSON.stringify({ ...manifest, testGlobs }));
		const gateSha = f.commit();
		const r = await checkCandidate({ ...gateInput(f, gateSha), gateSha });
		assert.equal(r.status, "incomplete");
		assert.equal(r.reason, reason);
	});
}

test("Docker and runner infrastructure exits never blame a candidate", async (t) => {
	const f = repo(t);

	for (const code of [125, 126, 127]) {
		let calls = 0;

		const runner: GateRunner = {
			kind: "docker",
			run: async (input) =>
				++calls === 1
					? miniRunner.run(input)
					: { exitCode: code, stdout: "", stderr: "runner failed" },
		};

		const r = await checkCandidate({ ...gateInput(f, f.gateSha), runner });
		assert.equal(r.status, "incomplete");
		assert.equal(r.reason, "runner_error");
	}
});

test("heldout requires exact bytes, real tests, and a result without public logs", async (t) => {
	const f = repo(t);
	const path = "test/acceptance/123/checks/held.test.ts";

	const text =
		'import {test} from "node:test"; test("PRIVATE-TITLE",()=>{});\n';

	f.put(path, text);
	const digest = heldoutDigest([{ path, bytes: Buffer.from(text) }]);

	const input = {
		...gateInput(f, f.commit()),
		heldoutDir: "test/acceptance/123",
		heldoutDigest: digest,
	};

	const pass = await checkCandidate(input);
	assert.equal(pass.version, 2);
	assert.equal(pass.status, "passed");
	assert.ok(pass.requiredChecks.includes("heldout"));
	assert.equal(existsSync(join(input.output, "heldout.log")), false);
	assert.equal(JSON.stringify(pass).includes("PRIVATE-TITLE"), false);
	assert.equal(
		receiptPasses({
			...pass,
			checks: pass.checks.filter((c) => c.name !== "heldout"),
		}),
		false,
	);
	assert.equal(
		(await checkCandidate({ ...input, heldoutDigest: "0".repeat(64) })).reason,
		"heldout_digest_mismatch",
	);

	for (const body of [
		'test("PRIVATE-TITLE",()=>{throw new Error("PRIVATE-ASSERTION");});',
		'test.skip("PRIVATE-TITLE",()=>{});',
		'test.todo("PRIVATE-TITLE");',
		"export const empty = true;",
	]) {
		const bytes = Buffer.from('import {test} from "node:test"; ' + body + "\n");
		f.put(path, bytes.toString());

		const r = await checkCandidate({
			...input,
			candidateSha: f.commit(),
			heldoutDigest: heldoutDigest([{ path, bytes }]),
		});

		assert.equal(r.status, "failed");
		assert.deepEqual(r.heldoutFailures, [path]);
		assert.equal(/PRIVATE-(?:TITLE|ASSERTION)/.test(JSON.stringify(r)), false);
	}
});

test("dependency receipts retain added, removed, changed and newDependency", async (t) => {
	const f = repo(t);

	const entry = (name: string, version: string) => ({
		version,
		resolved: `https://registry.npmjs.org/${name}/-/${name}-${version}.tgz`,
		integrity: `sha512-${Buffer.alloc(64).toString("base64")}`,
	});

	const lock = (packages: Record<string, ReturnType<typeof entry>>) =>
		JSON.stringify({
			lockfileVersion: 3,
			packages: { "": { name: "mini", version: "1.0.0" }, ...packages },
		});

	f.put(
		"package-lock.json",
		lock({
			"node_modules/old": entry("old", "1.0.0"),
			"node_modules/changed": entry("changed", "1.0.0"),
		}),
	);
	const gateSha = f.commit();
	f.put(
		"package-lock.json",
		lock({
			"node_modules/new": entry("new", "1.0.0"),
			"node_modules/changed": entry("changed", "2.0.0"),
		}),
	);
	const r = await checkCandidate({ ...gateInput(f, f.commit()), gateSha });
	assert.equal(r.status, "passed");
	assert.deepEqual(r.dependencies, {
		added: ["node_modules/new"],
		removed: ["node_modules/old"],
		changed: ["node_modules/changed"],
	});
	assert.equal(r.newDependency, true);
});

test("baseline timeout is incomplete; candidate deadlines have measured headroom", async (t) => {
	const f = repo(t);

	const timed: GateRunner = {
		kind: "timeout",
		run: async () => ({
			exitCode: 1,
			stdout: "",
			stderr: "",
			signal: "SIGKILL",
			timedOut: true,
		}),
	};

	const r = await checkCandidate({ ...gateInput(f, f.gateSha), runner: timed });
	assert.equal(r.status, "incomplete");
	assert.equal(r.reason, "baseline_failed");

	const runner: GateRunner = {
		kind: "timing",
		run: async (input) => {
			assert.ok((input.deadlineMs ?? 0) >= 90000);

			return input.tree.endsWith("/baseline")
				? miniRunner.run(input)
				: {
						exitCode: 1,
						stdout: "",
						stderr: "",
						signal: "SIGKILL",
						timedOut: true,
					};
		},
	};

	const failed = await checkCandidate({ ...gateInput(f, f.gateSha), runner });
	assert.equal(failed.status, "failed");
	assert.ok(failed.checks.some((c) => c.timedOut));
	assert.ok(failed.requiredChecks.includes("main_tests_deadline_control"));
	let calls = 0;

	const slowMain: GateRunner = {
		kind: "slow-main",
		run: (input) => (++calls === 1 ? miniRunner.run(input) : timed.run(input)),
	};

	const incomplete = await checkCandidate({
		...gateInput(f, f.gateSha),
		runner: slowMain,
	});

	assert.equal(incomplete.status, "incomplete");
	assert.equal(incomplete.reason, "baseline_deadline");
});

test("bad manifests, stale bases, missing checks and tampered replacement digests fail incomplete", async (t) => {
	const f = repo(t);
	f.put("src/value.ts", "export const value=1;\n");
	const candidateSha = f.commit();

	const input = {
		repository: f.root,
		gateSha: f.gateSha,
		candidateSha,
		nonce: "unit",
		output: join(f.root, "result"),
		runner: miniRunner,
		install: false,
	};

	assert.equal(
		(
			await checkCandidate({
				...input,
				replacements: [{ path: "test/value.test.ts", reason: "change" }],
				replacementsDigest: "0".repeat(64),
			})
		).status,
		"incomplete",
	);
	assert.equal(
		(
			await checkCandidate({
				...input,
				gateSha: candidateSha,
				candidateSha: f.gateSha,
			})
		).reason,
		"stale_base",
	);

	const empty: GateRunner = {
		kind: "empty",
		run: async () => ({ exitCode: 0, stdout: "{}", stderr: "" }),
	};

	assert.equal(
		(await checkCandidate({ ...input, runner: empty })).status,
		"incomplete",
	);
	f.put(
		".github/factory/gates/gates.json",
		JSON.stringify({ version: 1, checks: [], testGlobs: ["test/*.test.ts"] }),
	);
	const bad = f.commit();
	assert.equal(
		(await checkCandidate({ ...input, gateSha: bad, candidateSha: bad }))
			.reason,
		"missing_checks",
	);
});
