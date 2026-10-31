import assert from "node:assert/strict";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";

const [trailArg, runId] = process.argv.slice(2);

if (!trailArg || !/^\d+$/.test(runId ?? "")) throw new Error("Use collect.mjs <proof directory> <run id>");

const trail = resolve(trailArg);
const json = path => { try { return JSON.parse(readFileSync(path,"utf8")); } catch { throw new Error(`Invalid evidence ${path}`); } };
const fixtures = json(join(trail,"fixtures.json"));
const run = json(join(trail,"hosted-run.json"));

assert.equal(run.url,`https://github.com/giuseppecrj/pi-herdr-factorio/actions/runs/${runId}`);

assert.equal(run.status,"completed");

assert.equal(run.headSha,json(join(trail,"scratch.json")).sha);

const cases = fixtures.map(f => {
 const local = json(join(trail,"local",f.name,"receipt.json"));
 const folder = join(trail,"hosted-artifacts",`gate-receipt-${f.name}`);
 const hosted = json(join(folder,"receipt.json"));
 const job = run.jobs.find(j=>j.name===`gates (${f.name})`);
 assert.ok(job,f.name);

 for (const r of [local,hosted]) {
  assert.equal(r.version,2,f.name);
  assert.equal(r.gateSha,f.gateSha);
  assert.equal(r.candidateSha,f.candidateSha);
  assert.equal(r.status,f.expected,f.name);
  assert.equal(r.replacementsDigest,f.replacementsDigest);

  if(r.replacedTests.length || f.expected==="passed") assert.deepEqual(r.replacedTests.map(({path,reason})=>({path,reason})),f.replacements);

  for (const replaced of r.replacedTests) {assert.match(replaced.beforeDigest,/^[a-f0-9]{64}$/);assert.match(replaced.afterDigest,/^[a-f0-9]{64}$/);}

  assert.equal(r.modelCalls,0);
  const required=["install","baseline_tests","typecheck","lint","format","main_tests","candidate_tests",...(f.heldout_dir?["heldout"]:[])];

  for(const name of required) assert.ok(r.requiredChecks.includes(name));

  if(r.status==="passed") {
   assert.deepEqual(r.checks.map(c=>c.name),required);
   assert.ok(r.checks.every(c=>c.exitCode===0));
  }

  if(["registry-dependency","glob-dependency"].includes(f.name)) assert.equal(r.newDependency,true);

  if(["stream-forgery","serializer-forgery"].includes(f.name)) {assert.equal(r.reason,"runtime_patching");assert.ok(r.tamperSignals.some(s=>s.path==="src/gate-stream.ts" && s.line>0));}

  if(f.name.startsWith("suppression-")) assert.equal(r.reason,"suppression_added");

  if(f.name==="package-swap") assert.equal(r.reason,"package_swap");

  if(f.heldout_dir) {
   assert.equal(r.heldoutDigest,f.heldout_digest);
   assert.equal(/PRIVATE-(?:TITLE|ASSERTION)/.test(JSON.stringify(r)),false);
  }
 }

 assert.equal(local.runner,"local-bwrap");
 assert.equal(hosted.runner,"docker");
 assert.equal(job.conclusion,hosted.status==="passed"?"success":"failure");

 if(f.heldout_dir) assert.equal(existsSync(join(folder,"heldout.log")),false);

 if(f.name==="heldout-fail") assert.deepEqual(hosted.heldoutFailures,["test/acceptance/123/checks/scenario.test.ts"]);

 if(f.name==="heldout-missing-result") {
  const partial=json(join(folder,"missing-result.json"));
  assert.equal(partial.status,"passed");
  assert.ok(partial.requiredChecks.includes("heldout"));
  assert.equal(partial.checks.some(c=>c.name==="heldout"),false);
  assert.ok(job.steps.some(s=>s.name==="Reject a missing mandatory heldout result" && s.conclusion==="success"));
 }

 return {name:f.name,expected:f.expected,candidateSha:f.candidateSha,newDependency:hosted.newDependency,replacedTests:hosted.replacedTests,local:{status:local.status,reason:local.reason,wallMs:local.wallMs},hosted:{status:hosted.status,reason:hosted.reason,wallMs:hosted.wallMs,checks:hosted.checks,jobUrl:job.url}};
});

const proof={gateSha:fixtures[0].gateSha,runUrl:run.url,runHeadSha:run.headSha,fixtures:cases};

writeFileSync("docs/prototypes/trusted-ci/fix1-proof.json",JSON.stringify(proof,null,2)+"\n");

writeFileSync(join(trail,"fixture-table.md"),["| Fixture | Local | Hosted |","|---|---|---|",...cases.map(f=>`| ${f.name} | ${f.local.status} | [${f.hosted.status}](${f.hosted.jobUrl}) |`)].join("\n")+"\n");

console.log(`${cases.length}/${fixtures.length} fixture expectations verified with exact SHAs, receipt v2, required checks, typed reasons and heldout redaction`);
