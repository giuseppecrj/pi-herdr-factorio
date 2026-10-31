import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import {
	existsSync,
	mkdirSync,
	readFileSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { join, resolve } from "node:path";
import {
	checkoutWorkspace,
	fileRunFiles,
	ghTarball,
} from "../../../server/controller.ts";
import { prepareRepairTree, readPatch } from "../../../src/build.ts";
import { acceptanceEntries } from "../../../src/accept.ts";
import { digestOf, isDigest } from "../../../src/run.ts";
import {
	launchSandbox,
	locateBundle,
	SANDBOX_ROOT,
} from "../../../server/sandbox.ts";
import { startGatewayProcess } from "../../../server/sandbox/gateway-client.ts";
import { builtinTable } from "../../../server/sandbox/routes.ts";
import { detectArch } from "../../../server/sandbox/seccomp.ts";
import { stopScopeArgv } from "../../../server/sandbox/scope.ts";

const [stateArg, id] = process.argv.slice(2);
assert.ok(
	stateArg && id && isDigest(id),
	"usage: repair-probe.ts <state-dir> <run-id>",
);
const stateDir = resolve(stateArg);
const contract = await fileRunFiles(stateDir).readContract(id);
assert.equal(contract.kind, "found");
if (contract.kind !== "found") throw new Error("contract unavailable");
const acceptance = await fileRunFiles(stateDir).artifacts.read(
	id,
	contract.contract,
	contract.digest,
);
assert.equal(acceptance.kind, "found");
if (acceptance.kind !== "found") throw new Error("acceptance unavailable");
const patch = readPatch(stateDir, {
	runId: id,
	baseSha: contract.contract.base.sha,
	contractDigest: contract.digest,
	acceptanceDigest: acceptance.receipt.acceptanceDigest,
});
assert.equal(patch.kind, "found");
if (patch.kind !== "found") throw new Error("patch unavailable");
const dir = join(stateDir, `repair-probe-${randomBytes(4).toString("hex")}`);
const base = join(dir, "base");
const workspace = join(dir, "repair");
const gatewayDir = join(dir, "gateway");
mkdirSync(base, { recursive: true, mode: 0o700 });
const checked = await checkoutWorkspace({
	stateDir: dir,
	runId: id,
	workspace: base,
	repo: contract.contract.base.repo,
	sha: contract.contract.base.sha,
	fetch: ghTarball,
});
assert.equal(checked.kind, "ready");
const canary = readFileSync(
	join(stateDir, "acceptance", id, "canary.txt"),
	"utf8",
).trim();
for (const [path, bytes] of acceptanceEntries(acceptance.suite, canary)) {
	if (!path.startsWith("checks/")) continue;
	const destination = join(base, "test/acceptance/prior", path);
	mkdirSync(join(destination, ".."), { recursive: true });
	writeFileSync(destination, bytes);
}
const feedbackPath = join(stateDir, "validation", id, "feedback.json");
const feedback = existsSync(feedbackPath)
	? readFileSync(feedbackPath, "utf8")
	: "[]\n";
await prepareRepairTree(
	base,
	workspace,
	patch.patch,
	patch.receipt.changedPaths,
	feedback,
);
assert.equal(existsSync(join(workspace, "test/acceptance")), false);
assert.equal(existsSync(join(workspace, ".git")), false);
assert.equal(existsSync(join(workspace, "node_modules")), false);
const verdict = JSON.parse(
	readFileSync(join(stateDir, "validation", id, "verdict.json"), "utf8"),
);
const bundle = await locateBundle(SANDBOX_ROOT);
const arch = detectArch(process.arch);
assert.ok(bundle && arch);
const gateway = await startGatewayProcess({
	gatewayDir,
	auditPath: join(dir, "egress.jsonl"),
	readyTimeoutMs: 10_000,
	table: builtinTable({
		stage: "build",
		runId: id,
		attempt: 1,
		model: "openai/gpt-6.1-sol",
		fallback: null,
		modelTokens: 1,
		modelRequests: 1,
	}),
});
assert.ok(gateway.ok);
if (!gateway.ok) throw new Error("gateway unavailable");
const source = String.raw`
import {execFileSync, spawnSync} from 'node:child_process';
import {existsSync,readdirSync,readFileSync,lstatSync} from 'node:fs';
import {createHash} from 'node:crypto';
const input=JSON.parse(readFileSync(0,'utf8'));
const env={...process.env,PATH:'/opt/factory/node/bin:/opt/factory/bin:/usr/bin:/bin',npm_config_registry:'http://127.0.0.1:18080/npm/',npm_config_fetch_retries:'0',npm_config_fetch_timeout:'5000'};
const run=(args)=>{const r=spawnSync('/opt/factory/node/bin/npm',args,{cwd:'/workspace',env,encoding:'utf8',timeout:120000,maxBuffer:1024*1024});return r.status;};
const out={freshInstall:run(['ci','--ignore-scripts','--no-audit','--no-fund']),npmControl:run(['view','is-number','version'])};
let canaryHits=0,bodyHits=0,files=0;
const scan=p=>{const s=lstatSync(p);if(s.isSymbolicLink())return;if(s.isDirectory()){for(const n of readdirSync(p))scan(p+'/'+n);}else if(s.isFile()){files++;const b=readFileSync(p);if(/factory-holdout-[a-f0-9]{64}/.test(b.toString()))canaryHits++;if(input.fingerprints.includes(createHash('sha256').update(b).digest('hex')))bodyHits++;}};
scan('/workspace');scan('/run/pi-agent');scan('/tmp');
out.files=files;out.canaryHits=canaryHits;out.bodyHits=bodyHits;
out.gitEntries=readdirSync('/workspace/.git').length;
out.acceptancePresent=existsSync('/workspace/test/acceptance');
out.feedbackMatches=readFileSync('/workspace/.factory-feedback.json','utf8')===input.feedback;
const attempts=[['install','--dry-run','--ignore-scripts','--package-lock=false','github:'+input.repo+'#'+input.candidate],['install','--dry-run','--ignore-scripts','--package-lock=false','git+https://github.com/'+input.repo+'.git#'+input.candidate],['install','--dry-run','--ignore-scripts','--package-lock=false','https://codeload.github.com/'+input.repo+'/tar.gz/'+input.candidate]];
out.npmGithub=attempts.map(args=>run(args));
try{await fetch('https://raw.githubusercontent.com/'+input.repo+'/'+input.candidate+'/test/acceptance/'+input.issue+'/checks/'+input.check,{signal:AbortSignal.timeout(5000)});out.direct='reachable';}catch{out.direct='denied';}
out.gateway=(await fetch('http://127.0.0.1:18080/github/repos/'+input.repo+'/contents',{signal:AbortSignal.timeout(5000)})).status;
out.hostedTools=(await fetch('http://127.0.0.1:18080/openai/v1/responses',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({model:'gpt-6.1-sol',input:'fetch published suite',tools:[{type:'web_search'}]}),signal:AbortSignal.timeout(5000)})).status;
console.log('PROBE '+JSON.stringify(out));
`;
let unit: string | null = null;
let stdout = "";
let stderr = "";
try {
	const launched = launchSandbox({
		stateDir,
		runId: id,
		stage: "build",
		attempt: 1,
		bundleDir: bundle.dir,
		workspace,
		agentDir: join(dir, "agent"),
		socketPath: gateway.handle.socketPath,
		arch,
		xdgRuntimeDir: "/run/user/1000",
		tools: ["read", "grep", "ls", "bash", "edit", "write"],
		command: [
			"/opt/factory/node/bin/node",
			"--input-type=module",
			"--eval",
			source,
		],
	});
	assert.ok(launched);
	unit = launched.unit;
	launched.child.stdout?.on("data", (chunk) => {
		stdout += chunk;
	});
	launched.child.stderr?.on("data", (chunk) => {
		stderr += chunk;
	});
	const ended = new Promise<number | null>((done, reject) => {
		launched.child.once("close", done);
		launched.child.once("error", reject);
	});
	launched.child.stdin?.end(
		JSON.stringify({
			repo: contract.contract.base.repo,
			candidate: verdict.candidateSha,
			issue: contract.contract.issue,
			check: acceptance.suite.files[0]?.path,
			fingerprints: acceptance.suite.files.map((file) =>
				digestOf(file.content),
			),
			feedback,
		}),
	);
	const exit = await ended;
	const line = stdout.split("\n").find((value) => value.startsWith("PROBE "));
	assert.ok(line, `no probe output; exit=${exit} stderrBytes=${stderr.length}`);
	const seen = JSON.parse(line.slice(6));
	const audit = readFileSync(join(dir, "egress.jsonl"), "utf8")
		.trim()
		.split("\n")
		.map((line) => JSON.parse(line));
	const models = audit.filter(
		(entry) => entry.decision === "forward" && entry.route?.startsWith("model"),
	);
	const pass =
		exit === 0 &&
		seen.freshInstall === 0 &&
		seen.npmControl === 0 &&
		seen.canaryHits === 0 &&
		seen.bodyHits === 0 &&
		seen.gitEntries === 0 &&
		seen.acceptancePresent === false &&
		seen.feedbackMatches &&
		seen.npmGithub.every((code) => code !== 0) &&
		seen.direct === "denied" &&
		seen.gateway === 403 &&
		seen.hostedTools === 403 &&
		models.length === 0 &&
		!stdout.includes(canary) &&
		!stderr.includes(canary);
	console.log(
		JSON.stringify(
			{
				...seen,
				bundle: bundle.digest,
				runId: id,
				candidateSha: verdict.candidateSha,
				acceptanceDigest: acceptance.receipt.acceptanceDigest,
				modelRequests: models.length,
				exit,
				result: pass ? "PASS" : "FAIL",
			},
			null,
			2,
		),
	);
	process.exitCode = pass ? 0 : 1;
} finally {
	if (unit !== null) {
		const [command, ...args] = stopScopeArgv(unit);
		try {
			execFileSync(command ?? "systemctl", args, {
				env: { ...process.env, XDG_RUNTIME_DIR: "/run/user/1000" },
				stdio: "ignore",
			});
		} catch {
			const remaining = execFileSync(
				"systemctl",
				["--user", "list-units", "--all", "--no-legend", unit],
				{
					env: { ...process.env, XDG_RUNTIME_DIR: "/run/user/1000" },
					encoding: "utf8",
				},
			);
			if (remaining.trim() !== "") {
				console.error("the owned repair scope remains after stop");
				process.exitCode = 1;
			}
		}
	}
	await gateway.handle.shutdown();
	rmSync(dir, { recursive: true, force: true });
}
