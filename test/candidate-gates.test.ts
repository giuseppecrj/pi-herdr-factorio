import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import {
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
			tests: ["test/value.test.ts"],
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
	assert.deepEqual(receipt.replacedTests, replacements);
	f.put(
		"test/new.test.ts",
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
		assert.equal(
			receipt.checks.find((c) => c.name === "candidate_tests")?.exitCode,
			1,
		);
	});
}

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
		JSON.stringify({ version: 1, checks: [], tests: ["test/value.test.ts"] }),
	);
	const bad = f.commit();
	assert.equal(
		(await checkCandidate({ ...input, gateSha: bad, candidateSha: bad }))
			.reason,
		"missing_checks",
	);
});
