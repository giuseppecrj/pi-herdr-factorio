import assert from "node:assert/strict";
import { test } from "node:test";
import { EXIT, runCli } from "../../../../server/cli.ts";
import type { Exec } from "../../../../src/workflow.ts";

const invalid = [
	"release.lock",
	"a/b.lock",
	"a.lock/b",
	"a.",
	".hidden",
	"a/.b",
	"a/.hidden/b",
];

for (const flag of ["--ref", "--reload-ref"]) {
	for (const branch of invalid) {
		test(`workflow-check rejects ${flag} ${branch} before source resolution`, async () => {
			const calls: string[][] = [];
			const exec: Exec = async (command, args) => {
				calls.push([command, ...args]);
				return { stdout: "", stderr: "source resolution must not run", code: 1 };
			};
			let stdout = "";
			let stderr = "";
			const argv = ["workflow-check", "--json", "--repo", "owner/project"];
			if (flag === "--reload-ref") argv.push("--ref", "main");
			argv.push(flag, branch);
			const code = await runCli(argv, {
				exec,
				env: () => undefined,
				stdout: (text) => { stdout += text; },
				stderr: (text) => { stderr += text; },
			});
			assert.equal(code, EXIT.usage);
			assert.equal(stdout, "");
			assert.ok(stderr.includes("--ref and --reload-ref must be branch names"), stderr);
			assert.match(stderr, /Usage:/);
			assert.deepEqual(calls, [], "invalid branch must not reach an external source resolver");
		});
	}
}
// factory-holdout-070645b03bd7e85d4ec33fb2e6e65cc796ca2705826665b950d0297680044c3a
