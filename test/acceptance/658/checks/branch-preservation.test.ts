import assert from "node:assert/strict";
import { test } from "node:test";
import { EXIT, runCli } from "../../../../server/cli.ts";
import { type Exec, isBranchName } from "../../../../src/workflow.ts";

const accepted = [
	"main", "feature/x-1", "v1.2.3", "release/v1.2.3", "feature/a.b",
	"a.b/c.d", "under_score/UPPER-123", "a.locked", "a.lock-more/b",
	"a.lock.txt/b", "a.LOCK", "a./b", "a/-b", "lock", "0",
];

for (const branch of accepted) {
	test(`preserves accepted branch ${branch}`, () => {
		const result = isBranchName(branch);
		assert.equal(typeof result, "boolean", "the validator remains synchronous");
		assert.equal(result, true, branch);
	});
}

const rejected = [
	"", "-main", "--main", "/main", "main/", "a//b", "a///b",
	"a..b", "a/../b", "a b", "a\tb", "a\nb", "a:b", "a@b",
	"a~b", "a^b", "a?b", "a*b", "a[b", "a]b", "a\\b",
	"a{b", "a}b", "a+b", "a=b", "a#b", "a%b", "café",
];

for (const branch of rejected) {
	test(`preserves rejection of ${JSON.stringify(branch)}`, () => {
		assert.equal(isBranchName(branch), false, branch);
	});
}

for (const branch of ["main", "release.lock"]) {
	test(`status retains its reload-ref restriction for ${branch}`, async () => {
		const calls: string[][] = [];
		const exec: Exec = async (command, args) => {
			calls.push([command, ...args]);
			return { stdout: "", stderr: "unexpected source resolution", code: 1 };
		};
		let stdout = "";
		let stderr = "";
		const code = await runCli([
			"status", "--json", "--repo", "owner/project", "--reload-ref", branch,
		], {
			exec,
			env: () => undefined,
			stdout: (text) => { stdout += text; },
			stderr: (text) => { stderr += text; },
		});
		assert.equal(code, EXIT.usage);
		assert.equal(stdout, "");
		assert.ok(stderr.includes("--reload-ref applies only to workflow-check"), stderr);
		assert.match(stderr, /Usage:/);
		assert.deepEqual(calls, []);
	});
}
// factory-holdout-070645b03bd7e85d4ec33fb2e6e65cc796ca2705826665b950d0297680044c3a
