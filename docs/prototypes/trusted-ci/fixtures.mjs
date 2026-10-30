import { execFileSync, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { parse, stringify } from "yaml";
import { receiptPasses } from "../../../server/gates.ts";

const repository = process.cwd();
const [mode, gateSha, trailArg, ...flags] = process.argv.slice(2);
const trail = resolve(trailArg ?? "/tmp/f07b-fixtures");
const fixtures = join(repository, "test/fixtures/gate-cheating");
const git = (args, options = {}) => execFileSync("git", args, { cwd: repository, encoding: "utf8", ...options }).trim();
const digest = value => createHash("sha256").update(JSON.stringify(value)).digest("hex");

function json(text) {
	try { return JSON.parse(text); } catch { throw new Error("Malformed fixture JSON"); }
}

mkdirSync(trail, { recursive: true });

if (!/^[a-f0-9]{40}$/.test(gateSha ?? "")) throw new Error("Expected gate SHA");

if (mode === "generate") {
	mkdirSync(fixtures, { recursive: true });
	const original = path => git(["show", `${gateSha}:${path}`]) + "\n";
	const bad = original("src/markers.ts").replace('status === "needs_info"', 'status === "running"');
	const manifest = json(original("package.json"));
	const noop = { ...manifest, scripts: Object.fromEntries(Object.keys(manifest.scripts).map(key => [key, "true"])) };
	const testHead = 'import assert from "node:assert/strict";\nimport { test } from "node:test";\n';
	const goodSource = '\nexport const GATE_SENTINEL = "candidate-source";\n';
	const goodTest = `${testHead}import { GATE_SENTINEL } from "../src/markers.ts";\nimport { writeFileSync, readFileSync } from "node:fs";\n\ntest("candidate imports and isolated mounts", () => {\n\tassert.equal(GATE_SENTINEL, "candidate-source");\n\tassert.ok(process.getuid?.() !== 0);\n\tassert.equal(process.env.GITHUB_TOKEN, undefined);\n\tassert.equal(process.env.GITHUB_ACTIONS, undefined);\n\tassert.equal(process.env.NODE_OPTIONS, undefined);\n\tassert.throws(() => writeFileSync("/g/freeze.mjs", "forged pass"));\n\tassert.throws(() => writeFileSync("/w/src/markers.ts", "forged pass"));\n\tassert.throws(() => readFileSync("/w/.git/config"));\n\tassert.throws(() => readFileSync("/var/run/docker.sock"));\n});\n`;
	const replaced = ["test/specify.test.ts", "test/orchestrator.test.ts"].map(path => ({ path, reason: "Do not count a trailing empty line in inlined file totals" }));
	const behavior = original("src/specify.ts").replace('return { path, text: kept.join("\\n"), totalLines: all.length };', 'return {\n\t\tpath,\n\t\ttext: kept.join("\\n"),\n\t\ttotalLines: text.endsWith("\\n") ? all.length - 1 : all.length,\n\t};');
	const changedTest = original("test/specify.test.ts").replace("1-121 of 201", "1-121 of 200");
	const changedOrchestrator = original("test/orchestrator.test.ts").replace("of 101\\)", "of 100\\)");

	const cases = [
		{ name: "new-thing", expected: "passed", files: { "test/new-thing.test.ts": `${testHead}\ntest("new visible test", () => {\n\tassert.equal(1 + 1, 2);\n});\n` } },
		{ name: "known-good", expected: "passed", files: { "src/markers.ts": original("src/markers.ts") + goodSource, "test/gate-new.test.ts": goodTest } },
		{ name: "wrong-behavior", expected: "failed", files: { "src/markers.ts": bad } },
		{ name: "noop-scripts", expected: "failed", files: { "src/markers.ts": bad, "package.json": JSON.stringify(noop, null, 2) + "\n" } },
		{ name: "deleted-regression", expected: "failed", files: { "src/markers.ts": bad, "test/markers.test.ts": null } },
		{ name: "weakened-typecheck", expected: "failed", files: { "src/markers.ts": original("src/markers.ts") + '\nexport const GATE_BAD: string = 1;\n', "tsconfig.json": '{"compilerOptions":{"noCheck":true},"include":[]}\n' } },
		{ name: "weakened-lint", expected: "failed", files: { "src/gate-lint.ts": 'export const gateBad = (value: string | null) => value as string;\n', "src/.oxlintrc.json": '{"rules":{"anti-slop/require-safety-comment-for-type-assertion":"off"}}\n' } },
		{ name: "weakened-format", expected: "failed", files: { "src/gate-format.ts": 'export function gateValue() {\n  return 1;\n}\n', "src/biome.json": '{"root":false,"formatter":{"indentStyle":"space"}}\n', "src/.editorconfig": '[*]\nindent_style=space\n' } },
		{ name: "assert-monkeypatch", expected: "failed", files: { "src/markers.ts": 'import "./gate-cheat.ts";\n' + bad, "src/gate-cheat.ts": 'import assert from "node:assert/strict";\nassert.equal = () => {};\n' } },
		{ name: "exit-import", expected: "failed", files: { "src/markers.ts": 'process.exit(0);\n' + bad } },
		{ name: "really-exit", expected: "failed", files: { "src/markers.ts": 'process.reallyExit(0);\n' + bad } },
		{ name: "exit-hook", expected: "failed", files: { "src/markers.ts": 'process.on("exit", () => {\n\tprocess.exitCode = 0;\n});\n' + bad } },
		{ name: "skip", expected: "failed", files: { "test/gate-new.test.ts": `${testHead}\ntest.skip("skip", () => {});\n` } },
		{ name: "todo", expected: "failed", files: { "test/gate-new.test.ts": `${testHead}\ntest.todo("todo");\n` } },
		{ name: "only", expected: "failed", files: { "test/gate-new.test.ts": `${testHead}\ntest.only("only", () => {});\n` } },
		{ name: "npmrc", expected: "failed", files: { ".npmrc": "registry=https://evil.invalid\n" } },
		{ name: "git-dependency", expected: "failed", files: { "package.json": JSON.stringify({ ...manifest, dependencies: { ...manifest.dependencies, "f07b-git": "git+https://github.com/example/repo.git" } }, null, 2) + "\n" } },
		{ name: "named-replacement", expected: "passed", replacements: replaced, files: { "src/specify.ts": behavior, "test/specify.test.ts": changedTest, "test/orchestrator.test.ts": changedOrchestrator } },
		{ name: "unnamed-replacement", expected: "failed", files: { "src/specify.ts": behavior, "test/specify.test.ts": changedTest, "test/orchestrator.test.ts": changedOrchestrator } },
		{ name: "new-test-fails", expected: "failed", files: { "test/gate-new.cases.ts": `${testHead}\ntest("failing new test", () => assert.fail("new failure"));\n` } },
	];

	cases.push(
		{name:"lint-ignore",expected:"failed",files:{"src/gate-lint.ts":'export const gateBad = (value: string | null) => value as string;\n',"src/.gitignore":"gate-lint.ts\n"}},
		{name:"stream-forgery",expected:"failed",seed:true},
		{name:"serializer-forgery",expected:"failed",seed:true},
		{name:"forgery-control",expected:"failed",files:{"src/markers.ts":bad}},
		{name:"suppression-types",expected:"failed",files:{"src/gate-types.ts":"// @ts-nocheck\nexport const bad: string = 1;\n"}},
		{name:"suppression-lint",expected:"failed",files:{"src/gate-lint.ts":"/* oxlint-disable */\nexport const gateBad = (value: string | null) => value as string;\n"}},
		{name:"suppression-format",expected:"failed",files:{"src/gate-format.ts":"// biome-ignore-all format: fixture\nexport function gateValue() {\n  return 1;\n}\n"}},
		{name:"deleted-replacement",expected:"failed",replacements:[{path:"test/specify.test.ts",reason:"behavior change"}],files:{"test/specify.test.ts":null}},
	);
	const heldoutPath="test/acceptance/123/checks/scenario.test.ts";

	for (const [name,body] of [["heldout-pass",'assert.equal(1, 1);'],["heldout-fail",'assert.equal(1, 2, "PRIVATE-ASSERTION");'],["heldout-digest",'assert.equal(1, 1);'],["heldout-missing-result",'assert.equal(1, 1);']]) {
		const text=`import assert from 'node:assert/strict';\nimport {test} from 'node:test';\nconst n: number = 'not a number';\ntest('PRIVATE-TITLE', () => {\n  ${body}\n});\n`;
		const heldout_digest=name==="heldout-digest" ? "0".repeat(64) : digest([[heldoutPath,createHash("sha256").update(text).digest("hex")]]);
		cases.push({name,expected:name==="heldout-fail" || name==="heldout-digest" ? "failed":"passed",heldout_dir:"test/acceptance/123",heldout_digest,files:{[heldoutPath]:text}});
	}

	const swapped=json(original("package-lock.json"));
	swapped.packages["node_modules/@types/retry"].resolved="https://registry.npmjs.org/is-odd/-/is-odd-3.0.1.tgz";
	cases.push({name:"package-swap",expected:"failed",files:{"package-lock.json":JSON.stringify(swapped,null,2)+"\n"}});

	const temp = mkdtempSync(join(tmpdir(), "gate-dep-fixture-"));

	try {
		writeFileSync(join(temp,"package.json"), original("package.json"));
		writeFileSync(join(temp,"package-lock.json"), original("package-lock.json"));
		execFileSync("npm", ["install","--package-lock-only","--ignore-scripts","--no-audit","--no-fund","--save-exact","is-number@7.0.0"], {cwd:temp,stdio:"pipe"});
		cases.push({name:"registry-dependency",expected:"passed",files:{"package.json":readFileSync(join(temp,"package.json"),"utf8"),"package-lock.json":readFileSync(join(temp,"package-lock.json"),"utf8")}});
		writeFileSync(join(temp,"package.json"),original("package.json"));
		writeFileSync(join(temp,"package-lock.json"),original("package-lock.json"));
		execFileSync("npm", ["install","--package-lock-only","--ignore-scripts","--no-audit","--no-fund","--save-exact","glob@10.4.5"], {cwd:temp,stdio:"pipe"});
		cases.push({name:"glob-dependency",expected:"passed",files:{"package.json":readFileSync(join(temp,"package.json"),"utf8"),"package-lock.json":readFileSync(join(temp,"package-lock.json"),"utf8")}});
	} finally { rmSync(temp,{recursive:true,force:true}); }

	for (const fixture of cases) {
		if(fixture.seed) continue;
		const temp = mkdtempSync(join(tmpdir(), "gate-patch-"));

		try {
			mkdirSync(join(temp,"a"));mkdirSync(join(temp,"b"));

			for (const [path,content] of Object.entries(fixture.files)) {
				let before;

				try { before = original(path); } catch { before = null; }

				for (const [side,text] of [["a",before],["b",content]]) if (text !== null) {mkdirSync(dirname(join(temp,side,path)),{recursive:true});writeFileSync(join(temp,side,path),text);}
			}

			const result=spawnSync("git",["diff","--no-index","--unified=0","--src-prefix=a/","--dst-prefix=b/","--","a","b"],{cwd:temp,encoding:"utf8"});

			if (result.status!==1) throw new Error("empty patch");
			const patch=result.stdout.replaceAll("a/a/","a/").replaceAll("b/b/","b/").replaceAll("a/b/","a/").replaceAll("b/a/","b/");
			writeFileSync(join(fixtures,`${fixture.name}.patch`),patch);
		} finally {rmSync(temp,{recursive:true,force:true});}
	}

	writeFileSync(join(fixtures,"cases.json"),JSON.stringify(cases.map(({name,expected,replacements=[],heldout_dir="",heldout_digest=""})=>({name,expected,replacements,heldout_dir,heldout_digest})),null,"\t")+"\n");
} else if (mode === "prepare") {
	const cases=json(readFileSync(join(fixtures,"cases.json"),"utf8"));
	const output=[];

	for(const fixture of cases) {
		const index=join(trail,`index-${fixture.name}`);
		const env={...process.env,GIT_INDEX_FILE:index};

		try {
			git(["read-tree",gateSha],{env});
			git(["apply","--cached","--unidiff-zero",join(fixtures,`${fixture.name}.patch`)],{env});
			const tree=git(["write-tree"],{env});
			const sha=git(["commit-tree",tree,"-p",gateSha,"-m",`F07b fixture ${fixture.name}`]);
			const branch=`fixture/f07b-fix1-${fixture.name}-${gateSha.slice(0,7)}`;

			if(flags.includes("--publish")) git(["push","origin",`${sha}:refs/heads/${branch}`]);
			output.push({...fixture,gateSha,candidateSha:sha,branch,replacementsDigest:digest(fixture.replacements)});
		} finally {rmSync(index,{force:true});}
	}

	writeFileSync(join(trail,"fixtures.json"),JSON.stringify(output,null,2)+"\n");
} else if (mode === "local") {
	const cases=json(readFileSync(join(trail,"fixtures.json"),"utf8"));
	const summary=[];

	for(const fixture of cases) {
		const output=join(trail,"local",fixture.name);mkdirSync(output,{recursive:true});
		const result=spawnSync(process.execPath,["--experimental-strip-types","server/cli.ts","gates","--repository",repository,"--gate-sha",fixture.gateSha,"--candidate-sha",fixture.candidateSha,"--nonce",`local-${fixture.name}`,"--output",output,"--runner","local","--replacements",JSON.stringify(fixture.replacements),"--replacements-digest",fixture.replacementsDigest,"--heldout-dir",fixture.heldout_dir ?? "","--heldout-digest",fixture.heldout_digest ?? ""],{cwd:repository,encoding:"utf8",timeout:1200000,maxBuffer:16*1024*1024});
		writeFileSync(join(output,"cli.log"),result.stdout+result.stderr);
		const receipt=json(readFileSync(join(output,"receipt.json"),"utf8"));

		if(fixture.name==="heldout-missing-result") {
			const partial={...receipt,checks:receipt.checks.filter(c=>c.name!=="heldout")};

			if(receiptPasses(partial)) throw new Error("Missing heldout accepted");
			writeFileSync(join(output,"missing-result.json"),JSON.stringify(partial,null,2)+"\n");
		}

		const pass=receipt.status===fixture.expected && (!['registry-dependency','glob-dependency'].includes(fixture.name) || receipt.newDependency===true);
		console.log(fixture.name, receipt.status, pass?"PASS":"FAIL",receipt.wallMs);
		summary.push({name:fixture.name,expected:fixture.expected,status:receipt.status,pass,wallMs:receipt.wallMs});
	}

	writeFileSync(join(trail,"local-summary.json"),JSON.stringify(summary,null,2)+"\n");

	if(summary.some(s=>!s.pass)) process.exitCode=1;
} else if (mode === "scratch") {
	const allCases=json(readFileSync(join(trail,"fixtures.json"),"utf8"));
	const perf=flags.includes("--perf");
	const selected=flags.find(flag=>flag.startsWith("--case="))?.slice(7).split(",");
	let cases=allCases;
	let kind="fixtures";

	if (perf) {
		cases=allCases.filter(f=>f.name==="known-good");
		kind="perf";
	} else if (selected) {
		cases=allCases.filter(f=>selected.includes(f.name));
		kind="delta";
	}

	const fix2=flags.includes("--fix2");

	if(fix2 && (cases.length!==1 || cases[0].name!=="new-thing")) throw new Error("Fix 2 scratch expects only new-thing");
	const branch=`proto/f07b-${fix2?"fix2":"fix1"}-${kind}-${gateSha.slice(0,7)}`;
	const workflow=parse(readFileSync(".github/workflows/ci.yml","utf8"));
	workflow.name="F07b fixture proof";
	workflow["run-name"]=`F07b fixtures ${gateSha}`;
	workflow.on={push:{branches:[branch]}};
	const job=workflow.jobs.gates;
	job.if="${{ github.ref == 'refs/heads/"+branch+"' }}";
	job.name="gates (${{ matrix.case }})";
	job.strategy={"fail-fast":false,"max-parallel":8,matrix:{include:cases.map(f=>({case:f.name,expected:f.expected,candidate_sha:f.candidateSha,gate_sha:gateSha,nonce:`hosted-${f.name}`,replacements:JSON.stringify(f.replacements),replacements_digest:f.replacementsDigest,heldout_dir:f.heldout_dir ?? "",heldout_digest:f.heldout_digest ?? ""}))}};
	const convert=value=>Array.isArray(value)?value.map(convert):value instanceof Object?Object.fromEntries(Object.entries(value).map(([key,v])=>[key,convert(v)])):String(value).replaceAll("inputs.","matrix.").replaceAll("github.sha","matrix.gate_sha");
	job.steps=job.steps.map(convert);
	job.steps.at(-1).with.name="gate-receipt-${{ matrix.case }}";

	if (flags.includes("--expect")) {
		const step=job.steps.find(s=>s.name==="Run trusted gates");
		step.env.EXPECTED="${{ matrix.expected }}";
		step.run='set +e\n'+step.run+'\ncode=$?\nRESULT_EXIT="$code" node --input-type=module <<\'NODE\'\nimport assert from "node:assert/strict";\nimport {readFileSync} from "node:fs";\nconst r=JSON.parse(readFileSync(process.env.RUNNER_TEMP+"/gate-results/receipt.json","utf8"));\nassert.equal(r.status,process.env.EXPECTED);\nassert.equal(r.gateSha,process.env.GATE_SHA);\nassert.equal(r.candidateSha,process.env.CANDIDATE_SHA);\nassert.equal(r.modelCalls,0);\nassert.equal(process.env.RESULT_EXIT,r.status==="passed"?"0":"1");\nassert.equal(r.version,2);\nif(r.status==="passed") {\nassert.deepEqual(r.checks.map(c=>c.name),r.requiredChecks);\nassert.ok(r.checks.every(c=>c.exitCode===0));\n}\nconsole.log(JSON.stringify({asserted:true,status:r.status,gateSha:r.gateSha,candidateSha:r.candidateSha,checks:r.checks}));\nNODE\n';
	}

	if (perf) {
		const step=job.steps.find(s=>s.name==="Run trusted gates");
		const gates=step.run.replaceAll('$RUNNER_TEMP/gate-results', '$RUNNER_TEMP/gate-results/perf-$n').replace('--nonce "$NONCE"', '--nonce "$NONCE-$n"');
		step.run='baseline="$RUNNER_TEMP/benchmark-candidate"\nmkdir -p "$baseline"\ngit archive "$CANDIDATE_SHA" | tar -xf - -C "$baseline"\ncp -a node_modules "$baseline/node_modules"\nfor n in 1 2 3; do\nstart=$(date +%s%3N)\ndocker run --rm --network none --read-only --tmpfs /tmp:exec,size=1g --user 1001 --cap-drop ALL --security-opt no-new-privileges --mount "type=bind,src=$baseline,dst=/w,readonly" --workdir /w node@sha256:6d2c7d5d074bf72f81ddc252b4fbb5d625bc028eeda49cb4b8c2ff8eda1ee617 env -i PATH=/usr/local/bin:/usr/bin:/bin HOME=/tmp TMPDIR=/tmp CI=true LANG=C.UTF-8 npm run check > "$RUNNER_TEMP/trunk-check-$n.log" 2>&1\nend=$(date +%s%3N)\n'+gates+'\nprintf \'%s\\n\' "$((end-start))" > "$RUNNER_TEMP/gate-results/perf-$n/baseline-ms"\ndone\n';
		job.steps.splice(-1,0,{name:"Save benchmark command logs",if:"${{ always() && !cancelled() }}",run:'mkdir -p "$RUNNER_TEMP/gate-results"\ncp "$RUNNER_TEMP"/trunk-check-*.log "$RUNNER_TEMP/gate-results/"'});
	} else {
		job.steps.splice(3,0,{name:"Measure trunk check",run:"start=$(date +%s%3N)\nnpm run check > \"$RUNNER_TEMP/trunk-check.log\" 2>&1\nend=$(date +%s%3N)\nprintf '%s\\n' \"$((end-start))\" > \"$RUNNER_TEMP/baseline-ms\""});
		job.steps.splice(-1,0,{name:"Reject a missing mandatory heldout result",if:"${{ always() && matrix.case == 'heldout-missing-result' }}",run:`node --experimental-strip-types --input-type=module <<'NODE'
import assert from "node:assert/strict";
import {readFileSync,writeFileSync} from "node:fs";
import {receiptPasses} from "./server/gates.ts";
const path=process.env.RUNNER_TEMP+"/gate-results/";
const full=JSON.parse(readFileSync(path+"receipt.json","utf8"));
assert.equal(full.status,"passed");
assert.ok(full.requiredChecks.includes("heldout"));
const partial={...full,checks:full.checks.filter(c=>c.name!=="heldout")};
assert.equal(receiptPasses(partial),false);
writeFileSync(path+"missing-result.json",JSON.stringify(partial,null,2)+"\\n");
console.log("A receipt claiming passed but missing heldout is refused");
NODE`});
		job.steps.splice(-1,0,{name:"Save baseline timing",if:"${{ always() && !cancelled() }}",run:'test ! -d "$RUNNER_TEMP/gate-results" || cp "$RUNNER_TEMP/baseline-ms" "$RUNNER_TEMP/gate-results/baseline-ms"'});
	}

	if (fix2) {
		job.steps.splice(-1,0,{
			name:"Check candidate without a manifest edit",
			env:{CANDIDATE_SHA:"${{ matrix.candidate_sha }}",GATE_SHA:"${{ matrix.gate_sha }}"},
			run:`test "$(git diff --name-only "$GATE_SHA" "$CANDIDATE_SHA")" = test/new-thing.test.ts
git diff --exit-code "$GATE_SHA" "$CANDIDATE_SHA" -- .github/factory/gates/gates.json
candidate="$RUNNER_TEMP/root-candidate"
mkdir -p "$candidate"
git archive "$CANDIDATE_SHA" | tar -xf - -C "$candidate"
cp -a node_modules "$candidate/node_modules"
docker run --rm --network none --read-only --tmpfs /tmp:exec,size=1g --user 1001 --cap-drop ALL --security-opt no-new-privileges --mount "type=bind,src=$candidate,dst=/w,readonly" --workdir /w node@sha256:6d2c7d5d074bf72f81ddc252b4fbb5d625bc028eeda49cb4b8c2ff8eda1ee617 env -i PATH=/usr/local/bin:/usr/bin:/bin HOME=/tmp TMPDIR=/tmp CI=true LANG=C.UTF-8 npm run check > "$RUNNER_TEMP/gate-results/candidate-check.log" 2>&1
grep -E '^ℹ (tests|pass|fail|skipped|todo) ' "$RUNNER_TEMP/gate-results/candidate-check.log"`
		});
	}

	const index=join(trail,"scratch-index");
	const env={...process.env,GIT_INDEX_FILE:index};

	try {
		git(["read-tree",gateSha],{env});
		const blob=git(["hash-object","-w","--stdin"],{input:stringify(workflow)});
		git(["update-index","--add","--cacheinfo",`100644,${blob},.github/workflows/ci.yml`],{env});
		const tree=git(["write-tree"],{env});
		const sha=git(["commit-tree",tree,"-p",fix2?cases[0].candidateSha:gateSha,"-m","F07b temporary push-triggered fixture proof"]);
		git(["push","origin",`${sha}:refs/heads/${branch}`]);
		writeFileSync(join(trail,"scratch.json"),JSON.stringify({branch,sha,gateSha},null,2)+"\n");
	} finally {rmSync(index,{force:true});}
} else if(mode==="cleanup") {
	const cases=json(readFileSync(join(trail,"fixtures.json"),"utf8"));
	const scratch=json(readFileSync(join(trail,"scratch.json"),"utf8"));

	for(const branch of [...cases.map(f=>f.branch),scratch.branch]) {
		if(!/^(?:fixture|proto)\/f07b-fix1-/.test(branch)) throw new Error("unsafe cleanup");
		git(["push","origin",`:refs/heads/${branch}`]);
	}
} else throw new Error("Expected generate, prepare, local, scratch or cleanup");
