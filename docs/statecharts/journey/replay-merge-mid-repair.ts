import assert from "node:assert/strict";
import { advance, type RunEvent } from "../../../src/stages.ts";
import { digestOf, REQUIRED_CI_CHECKS, startRun } from "../../../src/run.ts";

let run = startRun({
	id: "replay",
	ticket: {
		provider: "github",
		key: "owner/repo#1",
		url: "https://github.com/owner/repo/issues/1",
	},
	repo: "owner/repo",
	baseSha: "a".repeat(40),
});

const step = (event: RunEvent) => {
	const result = advance(run, event);
	console.log(
		event.kind,
		result.kind === "advanced"
			? JSON.stringify(result.run.progress)
			: `invalid: ${result.reason}`,
	);
	if (result.kind === "advanced") run = result.run;
	return result;
};

const patchDigest = digestOf("patch");
const acceptanceDigest = digestOf("acceptance");
const heldoutDigest = digestOf("heldout");
const candidateSha = "c".repeat(40);
step({ kind: "admitted" });
step({ kind: "specified", contractDigest: digestOf("contract") });
step({ kind: "accepted", acceptanceDigest });
step({ kind: "built", patchDigest });
step({ kind: "candidate", candidateSha, heldoutDigest, ciRunId: 1 });
step({
	kind: "validated",
	verdict: {
		patchDigest,
		acceptanceDigest,
		heldoutDigest,
		candidateSha,
		gateSha: "a".repeat(40),
		ciRunId: 1,
		originalBase: "a".repeat(40),
		baseSha: "a".repeat(40),
		pass: true,
		requiredChecks: [...REQUIRED_CI_CHECKS],
		checks: REQUIRED_CI_CHECKS.map((name) => ({ name, passed: true })),
		unjudged: [],
	},
});
step({ kind: "reviewed", blockingFindings: [] });
assert.deepEqual(run.progress, { kind: "active", stage: "land" });
console.log("Owner feedback uses a blocking review as an F10 stand-in.");
run = { ...run, progress: { kind: "active", stage: "review" } };
step({ kind: "reviewed", blockingFindings: ["owner comment"] });
console.log("The owner merges on GitHub while the repair builds.");
const result = step({ kind: "landed", mergeSha: "b".repeat(40) });
assert.equal(result.kind, "invalid");
assert.deepEqual(run.progress, { kind: "active", stage: "build" });
console.log("MergeEndsRun still breaks; F10 owns the fix.");
