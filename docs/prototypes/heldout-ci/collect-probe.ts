import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import {
	downloadGateReceipt,
	fileRunFiles,
} from "../../../server/controller.ts";
import { readPatch } from "../../../src/build.ts";
import { type Exec } from "../../../src/gh.ts";
import { isDigest, verdictPasses } from "../../../src/run.ts";
import {
	collectVerdict,
	dispatchNonce,
	matchesCiRun,
	parseCiRun,
	publishedSuite,
} from "../../../src/validation.ts";
import { parseJson } from "../../../server/sandbox/json.ts";

const [stateArg, runId] = process.argv.slice(2);
assert.ok(
	stateArg && runId && isDigest(runId),
	"usage: collect-probe.ts <state-dir> <run-id>",
);
const stateDir = resolve(stateArg);
const files = fileRunFiles(stateDir);
const claim = (await files.listClaims()).find((claim) => claim.runId === runId);
const state = claim?.validation;
assert.ok(state?.publication && state.ciRunId);
const contract = await files.readContract(runId);
assert.equal(contract.kind, "found");
if (contract.kind !== "found") throw new Error("contract unavailable");
const suite = await files.artifacts.read(
	runId,
	contract.contract,
	contract.digest,
);
assert.equal(suite.kind, "found");
if (suite.kind !== "found") throw new Error("acceptance unavailable");
const patch = readPatch(stateDir, {
	runId,
	baseSha: contract.contract.base.sha,
	contractDigest: contract.digest,
	acceptanceDigest: suite.receipt.acceptanceDigest,
});
assert.equal(patch.kind, "found");
if (patch.kind !== "found") throw new Error("patch unavailable");
const exec: Exec = (command, args) =>
	new Promise((done) =>
		execFile(
			command,
			[...args],
			{ encoding: "utf8", timeout: 30_000, maxBuffer: 16 * 1024 * 1024 },
			(error, stdout, stderr) =>
				done({ code: error === null ? 0 : 1, stdout, stderr }),
		),
	);
const repo = contract.contract.base.repo;
const raw = await exec("gh", [
	"api",
	`repos/${repo}/actions/runs/${state.ciRunId}`,
]);
assert.equal(raw.code, 0);
const run = parseCiRun(parseJson(raw.stdout));
assert.ok(run);
const nonce = dispatchNonce(runId, state.round, state.dispatchTry);
assert.equal(
	matchesCiRun(run, state.publication.candidateSha, nonce, state.startedAt),
	true,
);
const text = await downloadGateReceipt(exec, repo, run.id);
assert.ok(text);
const heldout = publishedSuite({
	issue: contract.contract.issue,
	suite: suite.suite,
	canary: readFileSync(
		join(stateDir, "acceptance", runId, "canary.txt"),
		"utf8",
	).trimEnd(),
	acceptanceDigest: suite.receipt.acceptanceDigest,
});
const verdict = collectVerdict({
	text,
	run,
	nonce,
	patchDigest: patch.receipt.patchDigest,
	acceptanceDigest: suite.receipt.acceptanceDigest,
	heldoutDigest: heldout.digest,
	candidateSha: state.publication.candidateSha,
	originalBase: state.originalBase,
	baseSha: state.baseSha,
	unjudged: suite.suite.scenarios.flatMap((scenario) =>
		scenario.judge === null ? [] : [scenario.id],
	),
});
assert.equal(verdictPasses(verdict), true);
console.log(
	JSON.stringify({ result: "PASS", modelRequests: 0, verdict }, null, 2),
);
