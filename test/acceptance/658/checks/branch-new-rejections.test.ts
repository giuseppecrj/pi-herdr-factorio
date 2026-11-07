import assert from "node:assert/strict";
import { test } from "node:test";
import { isBranchName } from "../../../../src/workflow.ts";

const invalid = [
	"release.lock",
	"a/b.lock",
	"a.lock/b",
	"a.",
	".hidden",
	"a/.b",
	"a/.hidden/b",
	"a/b/c.lock/d",
	"a/b/c.",
	"a/b/.hidden/c",
	".hidden/a/b",
	"release.lock/feature/x",
];

for (const branch of invalid) {
	test(`rejects dot or lock branch form ${JSON.stringify(branch)}`, () => {
		assert.equal(isBranchName(branch), false, branch);
	});
}
// factory-holdout-070645b03bd7e85d4ec33fb2e6e65cc796ca2705826665b950d0297680044c3a
