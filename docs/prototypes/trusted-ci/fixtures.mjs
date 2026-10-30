import { execFileSync, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { parse, stringify } from "yaml";

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
	const replaced = [{ path: "test/specify.test.ts", reason: "Do not count a trailing empty line in inlined file totals" }];
	const behavior = original("src/specify.ts").replace('return { path, text: kept.join("\\n"), totalLines: all.length };', 'return {\n\t\tpath,\n\t\ttext: kept.join("\\n"),\n\t\ttotalLines: text.endsWith("\\n") ? all.length - 1 : all.length,\n\t};');
	const changedTest = original("test/specify.test.ts").replace("1-121 of 201", "1-121 of 200");

	const cases = [
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
		{ name: "npmrc", expected: "incomplete", files: { ".npmrc": "registry=https://evil.invalid\n" } },
		{ name: "git-dependency", expected: "incomplete", files: { "package.json": JSON.stringify({ ...manifest, dependencies: { ...manifest.dependencies, "f07b-git": "git+https://github.com/example/repo.git" } }, null, 2) + "\n" } },
		{ name: "named-replacement", expected: "passed", replacements: replaced, files: { "src/specify.ts": behavior, "test/specify.test.ts": changedTest } },
		{ name: "unnamed-replacement", expected: "failed", files: { "src/specify.ts": behavior, "test/specify.test.ts": changedTest } },
		{ name: "new-test-fails", expected: "failed", files: { "test/gate-new.test.ts": `${testHead}\ntest("failing new test", () => assert.fail("new failure"));\n` } },
	];

	const temp = mkdtempSync(join(tmpdir(), "gate-dep-fixture-"));

	try {
		writeFileSync(join(temp,"package.json"), original("package.json"));
		writeFileSync(join(temp,"package-lock.json"), original("package-lock.json"));
		execFileSync("npm", ["install","--package-lock-only","--ignore-scripts","--no-audit","--no-fund","--save-exact","is-number@7.0.0"], {cwd:temp,stdio:"pipe"});
		cases.push({name:"registry-dependency",expected:"passed",files:{"package.json":readFileSync(join(temp,"package.json"),"utf8"),"package-lock.json":readFileSync(join(temp,"package-lock.json"),"utf8")}});
	} finally { rmSync(temp,{recursive:true,force:true}); }

	for (const fixture of cases) {
		const temp = mkdtempSync(join(tmpdir(), "gate-patch-"));

		try {
			mkdirSync(join(temp,"a"));mkdirSync(join(temp,"b"));

			for (const [path,content] of Object.entries(fixture.files)) {
				let before;

				try { before = original(path); } catch { before = null; }

				for (const [side,text] of [["a",before],["b",content]]) if (text !== null) {mkdirSync(dirname(join(temp,side,path)),{recursive:true});writeFileSync(join(temp,side,path),text);}
			}

			const result=spawnSync("git",["diff","--no-index","--src-prefix=a/","--dst-prefix=b/","--","a","b"],{cwd:temp,encoding:"utf8"});

			if (result.status!==1) throw new Error("empty patch");
			const patch=result.stdout.replaceAll("a/a/","a/").replaceAll("b/b/","b/").replaceAll("a/b/","a/").replaceAll("b/a/","b/");
			writeFileSync(join(fixtures,`${fixture.name}.patch`),patch);
		} finally {rmSync(temp,{recursive:true,force:true});}
	}

	writeFileSync(join(fixtures,"cases.json"),JSON.stringify(cases.map(({name,expected,replacements=[]})=>({name,expected,replacements})),null,2)+"\n");
} else if (mode === "prepare") {
	const cases=json(readFileSync(join(fixtures,"cases.json"),"utf8"));
	const output=[];

	for(const fixture of cases) {
		const index=join(trail,`index-${fixture.name}`);
		const env={...process.env,GIT_INDEX_FILE:index};

		try {
			git(["read-tree",gateSha],{env});
			git(["apply","--cached","--whitespace=nowarn",join(fixtures,`${fixture.name}.patch`)],{env});
			const tree=git(["write-tree"],{env});
			const sha=git(["commit-tree",tree,"-p",gateSha,"-m",`F07b fixture ${fixture.name}`]);
			const branch=`fixture/f07b-${fixture.name}-${gateSha.slice(0,7)}`;

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
		const result=spawnSync(process.execPath,["--experimental-strip-types","server/cli.ts","gates","--repository",repository,"--gate-sha",fixture.gateSha,"--candidate-sha",fixture.candidateSha,"--nonce",`local-${fixture.name}`,"--output",output,"--runner","local","--replacements",JSON.stringify(fixture.replacements),"--replacements-digest",fixture.replacementsDigest],{cwd:repository,encoding:"utf8",timeout:1200000,maxBuffer:16*1024*1024});
		writeFileSync(join(output,"cli.log"),result.stdout+result.stderr);
		const receipt=json(readFileSync(join(output,"receipt.json"),"utf8"));
		const pass=receipt.status===fixture.expected && (fixture.name!=="registry-dependency" || receipt.newDependency===true);
		console.log(fixture.name, receipt.status, pass?"PASS":"FAIL",receipt.wallMs);
		summary.push({name:fixture.name,expected:fixture.expected,status:receipt.status,pass,wallMs:receipt.wallMs});
	}

	writeFileSync(join(trail,"local-summary.json"),JSON.stringify(summary,null,2)+"\n");

	if(summary.some(s=>!s.pass)) process.exitCode=1;
} else if (mode === "scratch") {
	const cases=json(readFileSync(join(trail,"fixtures.json"),"utf8"));
	const branch=`proto/f07b-fixtures-${gateSha.slice(0,7)}`;
	const workflow=parse(readFileSync(".github/workflows/ci.yml","utf8"));
	workflow.name="F07b fixture proof";
	workflow["run-name"]=`F07b fixtures ${gateSha}`;
	workflow.on={push:{branches:[branch]}};
	const job=workflow.jobs.gates;
	job.name="gates (${{ matrix.case }})";
	job.strategy={"fail-fast":false,"max-parallel":8,matrix:{include:cases.map(f=>({case:f.name,candidate_sha:f.candidateSha,gate_sha:gateSha,nonce:`hosted-${f.name}`,replacements:JSON.stringify(f.replacements),replacements_digest:f.replacementsDigest}))}};
	const convert=value=>Array.isArray(value)?value.map(convert):value instanceof Object?Object.fromEntries(Object.entries(value).map(([key,v])=>[key,convert(v)])):String(value).replaceAll("inputs.","matrix.").replaceAll("github.sha","matrix.gate_sha");
	job.steps=job.steps.map(convert);
	job.steps.at(-1).with.name="gate-receipt-${{ matrix.case }}";
	job.steps.splice(3,0,{name:"Measure trunk check",run:"start=$(date +%s%3N)\nnpm run check > \"$RUNNER_TEMP/trunk-check.log\" 2>&1\nend=$(date +%s%3N)\nprintf '%s\\n' \"$((end-start))\" > \"$RUNNER_TEMP/baseline-ms\""});
	const step=job.steps.find(s=>s.name==="Run trusted gates");
	step.run+='\ncp "$RUNNER_TEMP/baseline-ms" "$RUNNER_TEMP/gate-results/baseline-ms"\n';
	const index=join(trail,"scratch-index");
	const env={...process.env,GIT_INDEX_FILE:index};

	try {
		git(["read-tree",gateSha],{env});
		const blob=git(["hash-object","-w","--stdin"],{input:stringify(workflow)});
		git(["update-index","--add","--cacheinfo",`100644,${blob},.github/workflows/ci.yml`],{env});
		const tree=git(["write-tree"],{env});
		const sha=git(["commit-tree",tree,"-p",gateSha,"-m","F07b temporary push-triggered fixture proof"]);
		git(["push","origin",`${sha}:refs/heads/${branch}`]);
		writeFileSync(join(trail,"scratch.json"),JSON.stringify({branch,sha,gateSha},null,2)+"\n");
	} finally {rmSync(index,{force:true});}
} else if(mode==="cleanup") {
	const cases=json(readFileSync(join(trail,"fixtures.json"),"utf8"));
	const scratch=json(readFileSync(join(trail,"scratch.json"),"utf8"));

	for(const branch of [...cases.map(f=>f.branch),scratch.branch]) {
		if(!/^(?:fixture|proto)\/f07b-/.test(branch)) throw new Error("unsafe cleanup");
		git(["push","origin",`:refs/heads/${branch}`]);
	}
} else throw new Error("Expected generate, prepare, local, scratch or cleanup");
