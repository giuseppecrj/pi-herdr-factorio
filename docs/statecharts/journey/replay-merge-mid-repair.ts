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
		"--test-name-pattern=formal|merged observation drains|matching historical certificate|base movement stops active review|actual observer promotes",
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

assert.ok(
	count !== undefined && Number(count) >= 22,
	"no complete runtime trace selection",
);

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
