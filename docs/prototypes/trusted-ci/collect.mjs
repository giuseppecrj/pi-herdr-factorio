import assert from "node:assert/strict";
import { readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";

const [trailArg, runId] = process.argv.slice(2);

if (!trailArg || !/^\d+$/.test(runId ?? "")) throw new Error("Use collect.mjs <build-1 directory> <run id>");

const trail = resolve(trailArg);

function json(path) {
	try { return JSON.parse(readFileSync(path,"utf8")); } catch { throw new Error(`Invalid evidence ${path}`); }
}

const fixtures = json(join(trail,"proof2/fixtures.json"));
const run = json(join(trail,"hosted-run2.json"));
const runUrl = `https://github.com/giuseppecrj/pi-herdr-factorio/actions/runs/${runId}`;

assert.equal(run.url,runUrl);

assert.equal(run.status,"completed");

assert.equal(run.headSha,json(join(trail,"proof2/scratch.json")).sha);

const cases = fixtures.map(f => {
	const local = json(join(trail,"proof2/local",f.name,"receipt.json"));
	const folder = join(trail,"hosted-artifacts2",`gate-receipt-${f.name}`);
	const hosted = json(join(folder,"receipt.json"));
	const job = run.jobs.find(j=>j.name===`gates (${f.name})`);
	assert.ok(job);

	for(const r of [local,hosted]) {
		assert.equal(r.gateSha,f.gateSha);
		assert.equal(r.candidateSha,f.candidateSha);
		assert.equal(r.status,f.expected);
		assert.equal(r.replacementsDigest,f.replacementsDigest);
		assert.deepEqual(r.replacedTests,f.replacements);
		assert.equal(r.modelCalls,0);

		if(r.status==="passed") {
			assert.deepEqual(r.checks.map(c=>c.name),["install","baseline_tests","typecheck","lint","format","main_tests","candidate_tests"]);
			assert.ok(r.checks.every(c=>c.exitCode===0));
		}
	}

	assert.equal(local.runner,"local-bwrap");
	assert.equal(hosted.runner,"docker");
	assert.equal(job.conclusion,hosted.status==="passed"?"success":"failure");

	if(f.name==="registry-dependency") {assert.equal(hosted.newDependency,true);assert.ok(hosted.dependencies.added.includes("node_modules/is-number"));}

	const sample = (r) => ({status:r.status,wallMs:r.wallMs,checks:r.checks});

	return {name:f.name,expected:f.expected,candidateSha:f.candidateSha,replacedTests:f.replacements,newDependency:hosted.newDependency,dependencies:hosted.dependencies,local:sample(local),hosted:{...sample(hosted),baselineMs:Number(readFileSync(join(folder,"baseline-ms"),"utf8")),jobUrl:job.url,conclusion:job.conclusion}};
});

assert.equal(cases.length,20);

writeFileSync("docs/prototypes/trusted-ci/proof.json",JSON.stringify({gateSha:fixtures[0].gateSha,runUrl,runHeadSha:run.headSha,conclusion:run.conclusion,fixtures:cases},null,2)+"\n");

const table = ["| Fixture | Local | Hosted | Candidate SHA |", "|---|---|---|---|"];

for(const f of cases) table.push(`| ${f.name} | ${f.local.status} | [${f.hosted.status}](${f.hosted.jobUrl}) | \`${f.candidateSha}\` |`);

writeFileSync(join(trail,"fixture-table.md"),table.join("\n")+"\n");

console.log(`${cases.length}/20 fixture expectations verified, including exact identities, replacement digests, mandatory results, runner identity and hosted conclusions`);
