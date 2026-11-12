import assert from "node:assert/strict";
import { run } from "node:test";
import { tap } from "node:test/reporters";
import { fileURLToPath } from "node:url";

const selection = [
	{
		path: "test/src/candidate/handoff.test.ts",
		patterns: [
			/\bformal\b/,
			/merged observation drains/,
			/matching historical certificate/,
			/base movement stops active review/,
			/actual observer promotes/,
		],
	},
	{
		path: "test/src/controller/orchestrator-validation.test.ts",
		patterns: [/\bformal\b/],
	},
	{
		path: "test/src/github/publication.test.ts",
		patterns: [/\bformal\b/],
	},
].map(({ path, patterns }) => ({
	file: fileURLToPath(new URL(`../../../${path}`, import.meta.url)),
	patterns,
}));

const names = new Map<string, string[]>(
	selection.map(({ file }) => [file, []]),
);

const result = { stdout: "", status: 1 };

const tests = run({
	files: selection.map(({ file }) => file),
	concurrency: 1,
	execArgv: ["--experimental-strip-types"],
	testNamePatterns: selection.flatMap(({ patterns }) => patterns),
});

tests.on("test:complete", (test) => {
	if (test.details.type === "test" && test.file && test.name !== test.file)
		names.get(test.file)?.push(test.name);
});

tests.on("test:summary", (summary) => {
	if (summary.file === undefined) result.status = summary.success ? 0 : 1;
});

for await (const chunk of tap(tests)) {
	result.stdout += chunk;
	process.stdout.write(chunk);
}

assert.equal(result.status, 0, "runtime correspondence tests failed");

for (const { file, patterns } of selection) {
	const selected = names.get(file) ?? [];

	assert.ok(selected.length > 0, `no correspondence tests selected in ${file}`);

	for (const pattern of patterns)
		assert.ok(
			selected.some((name) => pattern.test(name)),
			`correspondence pattern ${pattern} matched no tests in ${file}`,
		);
}

const count = /^# tests (\d+)$/m.exec(result.stdout)?.[1];
const passed = /^# pass (\d+)$/m.exec(result.stdout)?.[1];

assert.equal(
	Number(count),
	[...names.values()].reduce((total, selected) => total + selected.length, 0),
	"correspondence count must include only registered tests, not file wrappers",
);

assert.ok(
	count !== undefined &&
		Number(count) >= 40 &&
		passed !== undefined &&
		Number(passed) === Number(count),
	"expected at least 40 passing correspondence tests, including all five F10 replays",
);

for (const witness of [
	"published repair witness",
	"shortest merge-mid-repair witness",
	"merge-mid-repair witness drains work",
	"owner-ready witness",
	"owner-authored merge witness",
]) {
	const line = result.stdout
		.split("\n")
		.find(
			(line) =>
				line.startsWith("ok ") && line.includes(` - formal F10 ${witness}`),
		);

	assert.ok(
		line !== undefined && !line.includes("# SKIP"),
		`missing passing F10 replay: ${witness}`,
	);
}

assert.match(result.stdout, /^# fail 0$/m);

assert.match(result.stdout, /^# skipped 0$/m);

assert.match(result.stdout, /formal trace reaches all six generations/);

assert.match(
	result.stdout,
	/formal restart reuses the saved captured review intent/,
);

assert.match(
	result.stdout,
	/formal promotion refuses an unexpected predecessor/,
);
