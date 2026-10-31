import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";

// F09a permits refresh, not feedback repair, after publication. Replay the
// actual shared reducer trace; the older Journey.tla remains an F08 model.
const output = execFileSync(
	process.execPath,
	[
		"--experimental-strip-types",
		"--test",
		"--test-name-pattern=merged observation drains active work before terminal bookkeeping",
		fileURLToPath(new URL("../../../test/handoff.test.ts", import.meta.url)),
	],
	{ encoding: "utf8" },
);

process.stdout.write(output);
