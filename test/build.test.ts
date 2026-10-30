import assert from "node:assert/strict";
import { test } from "node:test";
import {
	mkdtempSync,
	mkdirSync,
	writeFileSync,
	symlinkSync,
	chmodSync,
	rmSync,
	readFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	collectPatch,
	readPatch,
	storePatch,
	finishPatch,
	commandReceipts,
	patchedTree,
	trustedVisiblePlan,
	checkBuildDisk,
	PATCH_MAX_BYTES,
	PATCH_RECEIPT_MAX_BYTES,
	COMMAND_MAX_BYTES,
} from "../src/build.ts";
import { digestOf } from "../src/run.ts";
import { execFileSync } from "node:child_process";
import { renderBuildSummary } from "../src/specify.ts";

function fixture(t: { after(fn: () => void): void }) {
	const root = mkdtempSync(join(tmpdir(), "factory-build-"));
	t.after(() => rmSync(root, { recursive: true, force: true }));

	for (const name of ["base", "work", "store"])
		mkdirSync(join(root, name), { mode: 0o700 });

	return {
		root,
		base: join(root, "base"),
		workspace: join(root, "work"),
		stateDir: join(root, "store"),
	};
}

test("collects deterministic exact bytes, deletions, binary files and executable modes", async (t) => {
	const f = fixture(t);

	for (const dir of [f.base, f.workspace])
		writeFileSync(join(dir, "same"), "one\n");
	writeFileSync(join(f.base, "removed"), "old\n");
	writeFileSync(join(f.workspace, "added"), Buffer.from([0, 1, 2]));
	chmodSync(join(f.workspace, "same"), 0o755);
	const first = await collectPatch(f);
	const second = await collectPatch(f);
	assert.equal(first.kind, "collected");
	assert.deepEqual(second, first);

	if (first.kind !== "collected") return;
	assert.deepEqual(first.changedPaths, ["added", "removed", "same"]);
	assert.equal(first.patchDigest, digestOf(first.patch));
	assert.match(first.patch.toString(), /GIT binary patch/);
	assert.match(first.patch.toString(), /old mode 100644\nnew mode 100755/);
});

test("rejects empty patches and records both sides of forbidden renames", async (t) => {
	const f = fixture(t);
	assert.deepEqual(await collectPatch(f), {
		kind: "error",
		reason: "empty_patch",
	});
	writeFileSync(join(f.base, "original"), "code\n");
	mkdirSync(join(f.workspace, "test/acceptance"), { recursive: true });
	writeFileSync(join(f.workspace, "test/acceptance/moved"), "code\n");
	const result = await collectPatch(f);
	assert.equal(result.kind, "collected");

	if (result.kind !== "collected") return;
	assert.equal(result.policy, "forbidden");
	assert.deepEqual(result.changedPaths, ["original", "test/acceptance/moved"]);
	assert.ok(result.patch.length > 0);
});

test("rejects escaping symlinks including physical dot-component chains", async (t) => {
	const f = fixture(t);
	symlinkSync(".", join(f.workspace, "d"));
	symlinkSync("d/..", join(f.workspace, "e"));
	symlinkSync("e/..", join(f.workspace, "f"));
	assert.deepEqual(await collectPatch(f), {
		kind: "error",
		reason: "unsafe_symlink",
	});
});

test("collects safe symlinks without following them", async (t) => {
	const f = fixture(t);
	writeFileSync(join(f.workspace, "target"), "hello\n");
	symlinkSync("target", join(f.workspace, "link"));
	const result = await collectPatch(f);
	assert.equal(result.kind, "collected");

	if (result.kind !== "collected") return;
	assert.deepEqual(result.changedPaths, ["link", "target"]);
	assert.match(result.patch.toString(), /120000/);
});

test("private collection survives restart, retains test failures, never regenerates damaged bytes", async (t) => {
	const f = fixture(t);
	writeFileSync(join(f.workspace, "test.js"), "bad\n");
	const patch = await collectPatch(f);
	assert.equal(patch.kind, "collected");

	if (patch.kind !== "collected") return;

	const binding = {
		runId: digestOf("run"),
		baseSha: "a".repeat(40),
		contractDigest: digestOf("contract"),
		acceptanceDigest: digestOf("suite"),
	};

	const stored = storePatch(f.stateDir, binding, patch, {
		model: "openai/gpt-6.1-sol",
		observed: null,
		commands: [],
	});

	assert.equal(stored.kind, "found");

	const failed = finishPatch(f.stateDir, binding, {
		command: "npm test",
		exitCode: 1,
		tail: "FAILED",
		wallMs: 1,
	});

	assert.equal(failed.kind, "found");

	if (failed.kind !== "found") return;
	assert.equal(failed.receipt.visibleTests?.exitCode, 1);
	finishPatch(f.stateDir, binding, {
		command: "npm test",
		exitCode: 0,
		tail: "ok",
		wallMs: 1,
	});
	assert.deepEqual(readPatch(f.stateDir, binding), failed);
	const path = join(f.stateDir, "patches", binding.runId, "patch.diff");
	assert.deepEqual(readFileSync(path), Buffer.from(patch.patch));
	writeFileSync(path, "changed");
	assert.deepEqual(readPatch(f.stateDir, binding), {
		kind: "blocked",
		reason: "patch_changed",
	});
	rmSync(path);
	assert.deepEqual(readPatch(f.stateDir, binding), {
		kind: "blocked",
		reason: "patch_missing",
	});
	assert.equal(
		storePatch(f.stateDir, binding, patch, {
			model: "x",
			observed: null,
			commands: [],
		}).kind,
		"blocked",
	);
});

test("applies the exact collected bytes to a fresh base, not builder caches", async (t) => {
	const f = fixture(t);
	writeFileSync(join(f.base, "value"), "old\n");
	writeFileSync(join(f.workspace, "value"), "new\n");
	mkdirSync(join(f.workspace, "node_modules"));
	writeFileSync(join(f.workspace, "node_modules", "ignored"), "cache");
	const patch = await collectPatch(f);
	assert.equal(patch.kind, "collected");

	if (patch.kind !== "collected") return;
	assert.deepEqual(patch.changedPaths, ["value"]);
	const dest = join(f.root, "test-copy");
	await patchedTree(f.base, dest, patch.patch);
	assert.equal(readFileSync(join(dest, "value"), "utf8"), "new\n");
	assert.deepEqual(await collectPatch({ base: dest, workspace: f.workspace }), {
		kind: "error",
		reason: "empty_patch",
	});
	assert.deepEqual(
		await collectPatch({ ...f, workspace: f.base, allowNoChange: true }),
		{
			kind: "collected",
			patch: "",
			patchDigest: digestOf(""),
			changedPaths: [],
			policy: "clean",
		},
	);
});

test("patch application is exact inside a Git checkout", async (t) => {
	const f = fixture(t);
	execFileSync("git", ["init", "--quiet", f.root]);
	writeFileSync(join(f.base, "value"), "base\n");
	writeFileSync(join(f.workspace, "value"), "patched\n");
	writeFileSync(join(f.workspace, "new"), "new\n");
	const patch = await collectPatch(f);
	assert.equal(patch.kind, "collected");

	if (patch.kind !== "collected") return;
	const dest = join(f.stateDir, "visible", "tree");
	await patchedTree(f.base, dest, patch.patch);
	assert.equal(readFileSync(join(dest, "value"), "utf8"), "patched\n");
	assert.equal(readFileSync(join(dest, "new"), "utf8"), "new\n");
});

test("non-UTF-8 text survives collection, private storage and application byte for byte", async (t) => {
	const f = fixture(t);
	const bytes = Buffer.from([99, 97, 102, 233, 10]);
	writeFileSync(join(f.workspace, "latin1.txt"), bytes);
	const patch = await collectPatch(f);
	assert.equal(patch.kind, "collected");

	if (patch.kind !== "collected") return;

	const binding = {
		runId: digestOf("latin"),
		baseSha: "a".repeat(40),
		contractDigest: digestOf("c"),
		acceptanceDigest: digestOf("a"),
	};

	const stored = storePatch(f.stateDir, binding, patch, {
		model: "openai/gpt-6.1-sol",
		observed: null,
		commands: [],
	});

	assert.equal(stored.kind, "found");

	if (stored.kind !== "found") return;
	assert.equal(
		digestOf(
			readFileSync(join(f.stateDir, "patches", binding.runId, "patch.diff")),
		),
		patch.patchDigest,
	);
	const dest = join(f.root, "latin-copy");
	await patchedTree(f.base, dest, stored.patch);
	assert.deepEqual(readFileSync(join(dest, "latin1.txt")), bytes);
});

test("restart binding compares only the four binding values, not receipt array identities", async (t) => {
	const f = fixture(t);
	writeFileSync(join(f.workspace, "a"), "new\n");
	const patch = await collectPatch(f);
	assert.equal(patch.kind, "collected");

	if (patch.kind !== "collected") return;

	const binding = {
		runId: digestOf("binding"),
		baseSha: "a".repeat(40),
		contractDigest: digestOf("c"),
		acceptanceDigest: digestOf("a"),
	};

	const stored = storePatch(f.stateDir, binding, patch, {
		model: "m",
		observed: null,
		commands: [{ command: "red", exitCode: 1 }],
	});

	assert.equal(stored.kind, "found");

	if (stored.kind !== "found") return;

	const recovered = finishPatch(f.stateDir, structuredClone(stored.receipt), {
		command: "npm test",
		exitCode: 0,
		tail: "ok",
		wallMs: 1,
	});

	assert.equal(recovered.kind, "found");

	if (recovered.kind === "found")
		assert.equal(recovered.receipt.visibleTests?.exitCode, 0);
});

for (const target of ["/proc/1/root", "loop", "node_modules/etc/passwd"])
	test(`rejects unsafe link ${target}`, async (t) => {
		const f = fixture(t);

		if (target.startsWith("node_modules"))
			symlinkSync("/", join(f.workspace, "node_modules"));
		symlinkSync(target, join(f.workspace, "loop"));
		assert.deepEqual(await collectPatch(f), {
			kind: "error",
			reason: "unsafe_symlink",
		});
	});

test("refuses a symlink replacing the top-level test directory", async (t) => {
	const f = fixture(t);
	mkdirSync(join(f.base, "test"));
	writeFileSync(join(f.base, "test", "old.test.ts"), "old\n");
	mkdirSync(join(f.workspace, "src"));
	symlinkSync("src", join(f.workspace, "test"));
	assert.deepEqual(await collectPatch(f), {
		kind: "error",
		reason: "unsafe_symlink",
	});
});

test("base scripts and base test inputs defeat candidate script rewrites and deletions", async (t) => {
	const f = fixture(t);
	writeFileSync(
		join(f.base, "package.json"),
		JSON.stringify({
			scripts: { test: "node --test test/*.test.js", pretest: "exit 99" },
		}),
	);
	mkdirSync(join(f.base, "test"));
	writeFileSync(
		join(f.base, "test/fail.test.js"),
		"throw new Error('trusted failure');\n",
	);
	writeFileSync(
		join(f.workspace, "package.json"),
		JSON.stringify({ scripts: { test: "exit 0" } }),
	);
	const plan = trustedVisiblePlan(f.base, f.workspace, "npm test");
	assert.equal(plan.command, "node --test test/*.test.js");
	assert.equal(plan.scriptsChanged, true);
	assert.equal(plan.testInputsChanged, true);
	assert.equal(
		readFileSync(join(f.workspace, "test/fail.test.js"), "utf8"),
		"throw new Error('trusted failure');\n",
	);
});

test("does not restore an authorized replacement, but restores every other deleted test", (t) => {
	const f = fixture(t);
	mkdirSync(join(f.base, "test"));
	writeFileSync(
		join(f.base, "package.json"),
		JSON.stringify({ scripts: { test: "node --test" } }),
	);
	writeFileSync(join(f.base, "test/replaced.test.js"), "old behavior\n");
	writeFileSync(join(f.base, "test/retained.test.js"), "regression\n");
	trustedVisiblePlan(f.base, f.workspace, "npm test", [
		{ path: "test/replaced.test.js" },
	]);
	assert.throws(() => readFileSync(join(f.workspace, "test/replaced.test.js")));
	assert.equal(
		readFileSync(join(f.workspace, "test/retained.test.js"), "utf8"),
		"regression\n",
	);
});

test("retains candidate regressions added to existing visible test files", (t) => {
	const f = fixture(t);
	mkdirSync(join(f.base, "test"));
	mkdirSync(join(f.workspace, "test"));
	writeFileSync(
		join(f.base, "package.json"),
		JSON.stringify({ scripts: { test: "node --test test/*.test.js" } }),
	);
	writeFileSync(
		join(f.workspace, "package.json"),
		JSON.stringify({ scripts: { test: "node --test test/*.test.js" } }),
	);
	writeFileSync(join(f.base, "test/existing.test.js"), "base test\n");
	writeFileSync(
		join(f.workspace, "test/existing.test.js"),
		"base test\nnew regression\n",
	);
	const plan = trustedVisiblePlan(f.base, f.workspace, "npm test");
	assert.equal(plan.testInputsChanged, true);
	assert.equal(
		readFileSync(join(f.workspace, "test/existing.test.js"), "utf8"),
		"base test\nnew regression\n",
	);
});

test("preserves literal base script bytes and freezes nested npm script lookups", (t) => {
	const f = fixture(t);

	const scripts = {
		test: "node -e 'console.log(\"npm test\")' && npm run focused",
		focused: "exit 1",
	};

	writeFileSync(join(f.base, "package.json"), JSON.stringify({ scripts }));
	writeFileSync(
		join(f.workspace, "package.json"),
		JSON.stringify({ scripts: { test: "exit 0", focused: "exit 0" } }),
	);
	const plan = trustedVisiblePlan(f.base, f.workspace, "npm test");
	assert.equal(plan.command, scripts.test);
	assert.deepEqual(
		JSON.parse(readFileSync(join(f.workspace, "package.json"), "utf8")).scripts,
		scripts,
	);
});

test("disk size checks count excluded caches and empty directories", (t) => {
	const f = fixture(t);
	mkdirSync(join(f.workspace, "node_modules"));
	assert.equal(checkBuildDisk([f.workspace], 65536), null);
	writeFileSync(join(f.workspace, "node_modules/cache"), Buffer.alloc(65537));
	assert.equal(checkBuildDisk([f.workspace], 65536), "build_disk_limit");
	rmSync(join(f.workspace, "node_modules"), { recursive: true });
	mkdirSync(join(f.workspace, "empty"));
	assert.equal(
		checkBuildDisk([f.workspace], 1024 * 1024, 1),
		"build_disk_limit",
	);
});

test("patch and receipt caps store and read exact limits and reject before anchoring", (t) => {
	const f = fixture(t);

	const binding = {
		runId: digestOf("caps"),
		baseSha: "a".repeat(40),
		contractDigest: digestOf("c"),
		acceptanceDigest: digestOf("a"),
	};

	const patch = "x".repeat(PATCH_MAX_BYTES);
	const session = { model: "m", observed: null, commands: [] };

	const input = {
		kind: "collected" as const,
		patch,
		patchDigest: digestOf(patch),
		changedPaths: ["a"],
		policy: "clean" as const,
	};

	let stored = storePatch(f.stateDir, binding, input, session);
	assert.equal(stored.kind, "found");
	const dir = join(f.stateDir, "patches", binding.runId);
	const size = readFileSync(join(dir, "collected.json")).length;
	rmSync(join(f.stateDir, "patches"), { recursive: true });
	stored = storePatch(f.stateDir, binding, input, {
		...session,
		model: "m".repeat(PATCH_RECEIPT_MAX_BYTES - size + 1),
	});
	assert.equal(stored.kind, "found");
	assert.equal(
		readFileSync(join(dir, "collected.json")).length,
		PATCH_RECEIPT_MAX_BYTES,
	);
	rmSync(join(f.stateDir, "patches"), { recursive: true });
	assert.equal(
		storePatch(f.stateDir, binding, input, {
			...session,
			model: "m".repeat(PATCH_RECEIPT_MAX_BYTES),
		}).kind,
		"blocked",
	);
	assert.equal(readPatch(f.stateDir, binding).kind, "absent");
	assert.equal(
		storePatch(
			f.stateDir,
			binding,
			{ ...input, patch: patch + "x", patchDigest: digestOf(patch + "x") },
			session,
		).kind,
		"blocked",
	);
	assert.equal(readPatch(f.stateDir, binding).kind, "absent");
});

test("wide build summaries truncate paths with a count and disclose script rewrites and builder reports", () => {
	const receipt = {
		patchDigest: digestOf("p"),
		changedPaths: Array.from(
			{ length: 500 },
			(_, i) => `src/${i}-${"a".repeat(100)}.ts`,
		),
		policy: "clean" as const,
		scriptsChanged: true,
		testScriptChanged: true,
		visibleTests: { exitCode: null },
	};

	const body = renderBuildSummary({ runId: digestOf("r"), receipt });
	assert.ok(body);
	assert.ok(Buffer.byteLength(body) <= 8192);
	assert.match(body, /and \d+ more paths/);
	assert.match(body, /could not run/);
	assert.match(body, /changed.*test script/i);
	assert.match(body, /builder-reported/i);
	assert.doesNotMatch(body, /Visible tests: (passed|failed)/);
});

test("bounds command receipts before anchoring and labels their source", async (t) => {
	const f = fixture(t);
	writeFileSync(join(f.workspace, "a"), "patch\n");
	const patch = await collectPatch(f);
	assert.equal(patch.kind, "collected");

	if (patch.kind !== "collected") return;

	const binding = {
		runId: digestOf("commands"),
		baseSha: "a".repeat(40),
		contractDigest: digestOf("c"),
		acceptanceDigest: digestOf("a"),
	};

	const stored = storePatch(f.stateDir, binding, patch, {
		model: "m",
		observed: null,
		commands: Array.from({ length: 20 }, () => ({
			command: "x".repeat(60000),
			exitCode: 0,
		})),
	});

	assert.equal(stored.kind, "found");

	if (stored.kind !== "found") return;
	assert.equal(stored.receipt.commandsSource, "builder-reported");
	assert.equal(stored.receipt.commandsOmitted, 18);
	assert.ok(
		Buffer.byteLength(JSON.stringify(stored.receipt.commands)) <=
			COMMAND_MAX_BYTES,
	);
	assert.deepEqual(readPatch(f.stateDir, binding), stored);
});

test("bounds a finite symlink chain to forty hops", async (t) => {
	const f = fixture(t);

	for (let i = 0; i < 42; i++)
		symlinkSync(
			i === 41 ? "target" : `link${i + 1}`,
			join(f.workspace, `link${i}`),
		);
	writeFileSync(join(f.workspace, "target"), "safe\n");
	assert.deepEqual(await collectPatch(f), {
		kind: "error",
		reason: "unsafe_symlink",
	});
});

test("command receipts use tool calls and results rather than final prose", () => {
	const session = readFileSync(
		new URL("./fixtures/build/commands.jsonl", import.meta.url),
		"utf8",
	);

	assert.deepEqual(commandReceipts(session), [
		{ command: "npm test", exitCode: 1 },
	]);
});
