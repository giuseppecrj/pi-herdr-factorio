import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const files = ["handoff", "orchestrator", "publication"].map((name) =>
	fileURLToPath(new URL(`../../../test/${name}.test.ts`, import.meta.url)),
);

const result = spawnSync(
	process.execPath,
	[
		"--experimental-strip-types",
		"--test",
		"--test-concurrency=1",
		"--test-reporter=tap",
		"--test-name-pattern=\\bformal\\b|merged observation drains|matching historical certificate|base movement stops active review|actual observer promotes",
		...files,
	],
	{ encoding: "utf8" },
);

process.stdout.write(result.stdout);

process.stderr.write(result.stderr);

assert.equal(
	result.status,
	0,
	result.error?.message ?? "runtime correspondence tests failed",
);

const count = /^# tests (\d+)$/m.exec(result.stdout)?.[1];
const passed = /^# pass (\d+)$/m.exec(result.stdout)?.[1];

assert.ok(
	count !== undefined &&
		Number(count) >= 40 &&
		passed !== undefined &&
		Number(passed) >= 38,
	"expected the 35 existing correspondence tests plus three passing F10 replays and two F10-3 design cases",
);

for (const witness of [
	"published repair witness",
	"shortest merge-mid-repair witness",
	"merge-mid-repair witness drains work",
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

assert.match(result.stdout, /formal trace reaches all six generations/);

assert.match(
	result.stdout,
	/formal restart reuses the saved captured review intent/,
);

assert.match(
	result.stdout,
	/formal promotion refuses an unexpected predecessor/,
);
