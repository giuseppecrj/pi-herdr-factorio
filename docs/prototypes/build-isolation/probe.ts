import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import {
	existsSync,
	lstatSync,
	mkdirSync,
	readFileSync,
	readdirSync,
	rmSync,
} from "node:fs";
import { join, resolve } from "node:path";
import {
	fileRunFiles,
	checkoutBuildWorkspace,
	ghTarball,
} from "../../../server/controller.ts";
import { patchedTree, readPatch } from "../../../src/build.ts";
import {
	gitState,
	launchSandbox,
	locateBundle,
	SANDBOX_ROOT,
} from "../../../server/sandbox.ts";
import { startGatewayProcess } from "../../../server/sandbox/gateway-client.ts";
import { builtinTable } from "../../../server/sandbox/routes.ts";
import { stopScopeArgv } from "../../../server/sandbox/scope.ts";
import { detectArch } from "../../../server/sandbox/seccomp.ts";
import { isDigest } from "../../../src/run.ts";

const [stateArg, runId, attempt = "1"] = process.argv.slice(2);

assert.ok(
	stateArg && runId && isDigest(runId),
	"usage: probe.ts <lane-state-dir> <run-id>",
);

const stateDir = resolve(stateArg);

assert.match(attempt, /^[1-9][0-9]*$/);

const files = fileRunFiles(stateDir);
const workspace = `${files.workspacePath(runId)}-build-${attempt}`;
const bound = await files.readContract(runId);

if (bound.kind !== "found") throw new Error(`contract ${bound.reason}`);

const suite = await files.artifacts.read(runId, bound.contract, bound.digest);

if (suite.kind !== "found") throw new Error(`suite ${suite.kind}`);

const reconstructed = !existsSync(workspace);

if (reconstructed) {
	const checked = await checkoutBuildWorkspace({
		stateDir,
		runId,
		workspace,
		repo: bound.contract.base.repo,
		sha: bound.contract.base.sha,
		fetch: ghTarball,
	});
	assert.equal(checked.kind, "ready", "cannot reconstruct base");
	const kept = readPatch(stateDir, {
		runId,
		baseSha: bound.contract.base.sha,
		contractDigest: bound.digest,
		acceptanceDigest: suite.receipt.acceptanceDigest,
	});
	assert.equal(kept.kind, "found", "cannot reconstruct stored patch");

	if (kept.kind !== "found") throw new Error("patch unavailable");
	rmSync(workspace, { recursive: true, force: true });
	await patchedTree(join(stateDir, "pristine", runId), workspace, kept.patch);
}

assert.ok(lstatSync(workspace).isDirectory(), "build workspace missing");

const canary = readFileSync(
	join(stateDir, "acceptance", runId, "canary.txt"),
	"utf8",
).trim();
const bundle = await locateBundle(SANDBOX_ROOT);
const arch = detectArch(process.arch);

assert.ok(bundle && arch);

const tools = ["read", "grep", "ls", "bash", "write", "edit"];
const hash = (text: string) => createHash("sha256").update(text).digest("hex");
const privatePaths = [
	`acceptance/${runId}`,
	`acceptance/${runId}.json`,
	`contracts/${runId}`,
];
const privateTexts = suite.suite.files.flatMap((file) => [
	file.content,
	file.path,
]);
const fingerprints = new Set(
	suite.suite.files.flatMap((file) => [
		hash(file.content),
		hash(`${file.content}\n`),
	]),
);
let rawOutputs = 0;

const inventory = (relative: string, accept: boolean) => {
	privatePaths.push(relative);
	const path = join(stateDir, relative);
	const stat = lstatSync(path);

	if (stat.isDirectory()) {
		for (const name of readdirSync(path))
			inventory(`${relative}/${name}`, accept);
	} else if (stat.isFile()) {
		if (accept && relative.endsWith("/output.txt")) {
			const raw = readFileSync(path, "utf8");
			assert.ok(raw.length > 0, "empty private output");
			fingerprints.add(hash(raw));
			privateTexts.push(raw);
			rawOutputs++;
		}
	} else throw new Error("non-regular private stage record");
};

for (const name of readdirSync(join(stateDir, "stages", runId))) {
	if (/^(?:accept|specify)-[0-9]+(?:\.[0-9]+)?$/.test(name))
		inventory(`stages/${runId}/${name}`, name.startsWith("accept-"));
}

assert.ok(rawOutputs > 0, "no private accept output to fingerprint");

const input = {
	runId,
	gitLayout: gitState(workspace) === "dir" ? "trusted-bind" : "tmpfs",
	privatePaths,
	fingerprints: {
		files: [...fingerprints],
		paths: suite.suite.files.map((file) => hash(file.path)),
	},
};

const stageDir = join(
	stateDir,
	"stages",
	runId,
	`build-probe-${randomBytes(4).toString("hex")}`,
);
const gatewayDir = join(stateDir, "gw", randomBytes(4).toString("hex"));

mkdirSync(stageDir, { recursive: true, mode: 0o700 });

mkdirSync(join(stateDir, "gw"), { recursive: true, mode: 0o700 });

const gateway = await startGatewayProcess({
	gatewayDir,
	auditPath: join(stageDir, "egress.jsonl"),
	readyTimeoutMs: 10_000,
	table: builtinTable({
		stage: "build",
		runId,
		attempt: Number(attempt),
		model: "openai/gpt-6.1-sol",
		fallback: null,
		modelTokens: 0,
		modelRequests: 0,
	}),
});

if (!gateway.ok) throw new Error(`gateway ${gateway.reason}`);

const source = String.raw`
import { existsSync, readFileSync, readdirSync, lstatSync, statSync } from 'node:fs';
import { createHash } from 'node:crypto';
import http from 'node:http';
const input = JSON.parse(readFileSync(0, 'utf8'));
const out = {};
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
const readText = path => { try { return readFileSync(path, 'utf8'); } catch { return ''; } };
const directory = path => { try { return lstatSync(path).isDirectory(); } catch { return false; } };
const entries = path => { try { return readdirSync(path); } catch { return null; } };
const cmd = readText('/proc/1/cmdline').split('\0');
const hostWorkspace = cmd.find(p => /\/workspaces\/[a-f0-9]{64}-build-[1-9][0-9]*$/.test(p)) ?? null;
out.hostWorkspaceVisibleInCmdline = hostWorkspace !== null;
const [state, id] = hostWorkspace === null ? [null, null] : hostWorkspace.split('/workspaces/');
out.discovery = state !== null && id?.split('-build-')[0] === input.runId;
const mountsText = readText('/proc/self/mountinfo');
const mounts = mountsText.split('\n').map(l => l.split(' ')).filter(f => f.length > 8).map(f => ({ at: f[4], type: f[f.indexOf('-') + 1], options: f[5].split(',') }));
out.acceptanceMounted = mountsText.includes('/acceptance') || (out.discovery && input.privatePaths.filter(p => p.startsWith('stages/')).some(p => mountsText.includes('/'+p)));
let privateReads = 0;
const privateVisited = new Set();
const reach = path => {
 try {
  const stat = statSync(path);
  const key = stat.dev+':'+stat.ino;
  if (privateVisited.has(key)) return;
  if (stat.isDirectory()) { const names = readdirSync(path); privateVisited.add(key); privateReads++; for (const name of names) reach(path+'/'+name); }
  else if (stat.isFile()) { readFileSync(path); privateVisited.add(key); privateReads++; }
 } catch {}
};
if (out.discovery) for (const path of input.privatePaths) reach(state+'/'+path);
out.privatePathsReadable = privateReads;
out.privatePathsTried = input.privatePaths.length;
const roots = ['/workspace', '/run', '/home', '/tmp', '/opt/factory', '/etc'];
out.requiredRoots = [...roots, '/workspace/.git', '/run/pi-agent/sessions'].every(p => directory(p) && entries(p) !== null);
out.gitEntries = entries('/workspace/.git')?.length ?? null;
out.ownSessions = entries('/run/pi-agent/sessions')?.length ?? null;
const gitMount = mounts.find(m => m.at === '/workspace/.git');
out.gitTmpfs = gitMount?.type === 'tmpfs';
out.gitRootIsolated = gitMount?.options.includes('ro') === true && (input.gitLayout === 'tmpfs' ? out.gitTmpfs : gitMount.type === mounts.find(m => m.at === '/workspace')?.type);
out.freshTmpfs = ['/home', '/tmp', '/run'].every(at => mounts.some(m => m.at === at && m.type === 'tmpfs'));
out.cachePaths = ['/home/agent/.cache', '/home/agent/.npm', '/home/agent/.pi', '/run/credentials', '/run/user', '/root'].filter(p => existsSync(p));
out.envLeaks = ['SSH_AUTH_SOCK', 'GH_TOKEN', 'GITHUB_TOKEN', 'OPENAI_API_KEY', 'NODE_OPTIONS', 'XDG_RUNTIME_DIR_HOST'].filter(k => process.env[k] !== undefined);
out.tools = process.env.FACTORY_PI_TOOLS;
const pattern = /factory-holdout-[0-9a-f]{64}/;
const fileHashes = new Set(input.fingerprints.files);
const pathHashes = new Set(input.fingerprints.paths);
let scanned = 0; let canaryHits = 0; let fingerprintHits = 0; let pathHits = 0; let scanErrors = 0; let scanDenied = 0; let danglingLinks = 0;
const visited = new Set();
const scan = path => {
 try {
  const stat = statSync(path);
  const key = stat.dev+':'+stat.ino;
  if (visited.has(key)) return;
  visited.add(key);
  if (stat.isDirectory()) { for (const name of readdirSync(path)) scan(path+'/'+name); }
  else if (stat.isFile()) {
   const bytes = readFileSync(path); scanned++;
   const text = bytes.toString('utf8');
   if (pattern.test(text)) canaryHits++;
   if (fileHashes.has(hash(bytes))) fingerprintHits++;
   for (const token of text.match(/[A-Za-z0-9_./-]+\.test\.(?:ts|js|mjs)/g) ?? []) {
    const parts = token.split('/');
    if (parts.some((_, i) => pathHashes.has(hash(parts.slice(i).join('/'))))) pathHits++;
   }
  }
 } catch (error) {
  if (error.code === 'EACCES' || error.code === 'EPERM') scanDenied++;
  else if (error.code === 'ENOENT') {
   try { if (lstatSync(path).isSymbolicLink()) danglingLinks++; else scanErrors++; } catch { scanErrors++; }
  } else scanErrors++;
 }
};
for (const root of roots) scan(root);
out.filesScanned = scanned; out.canaryHits = canaryHits; out.fingerprintHits = fingerprintHits; out.pathHits = pathHits; out.scanErrors = scanErrors; out.scanDenied = scanDenied; out.danglingLinks = danglingLinks;
out.complete = out.discovery && out.requiredRoots && out.gitRootIsolated && scanErrors === 0 && scanned > 0;
out.githubGateway = await new Promise(done => { const req = http.get('http://127.0.0.1:18080/github/repos/giuseppecrj/pi-herdr-factorio', r => { r.resume(); r.on('end', () => done(r.statusCode)); }); req.on('error', () => done(null)); req.setTimeout?.(3000, () => { req.destroy(); done(null); }); });
out.githubDirect = await fetch('https://api.github.com', { signal: AbortSignal.timeout(1500) }).then(() => 'reachable', () => 'denied');
console.log('PROBE ' + JSON.stringify(out));
`;

const runtime =
	process.env.XDG_RUNTIME_DIR ?? `/run/user/${process.getuid?.()}`;
let unit: string | null = null;
let stdout = "";
let stderr = "";

try {
	const launched = launchSandbox({
		stateDir,
		runId,
		stage: "build",
		attempt: Number(attempt),
		bundleDir: bundle.dir,
		workspace,
		agentDir: join(stageDir, "agent-0"),
		socketPath: gateway.handle.socketPath,
		arch,
		xdgRuntimeDir: runtime,
		tools,
		command: [
			"/opt/factory/node/bin/node",
			"--input-type=module",
			"--eval",
			source,
		],
	});

	assert.ok(launched, "unsafe workspace");
	unit = launched.unit;
	const child = launched.child;
	child.stdout?.on("data", (chunk) => {
		stdout += chunk;
	});
	child.stderr?.on("data", (chunk) => {
		stderr += chunk;
	});

	const ended = new Promise<number | null>((done, reject) => {
		child.on("close", done);
		child.on("error", reject);
	});

	child.stdin?.on("error", () => {});
	child.stdin?.end(JSON.stringify(input));
	const code = await ended;
	const line = stdout.split("\n").find((l) => l.startsWith("PROBE "));

	if (!line)
		throw new Error(
			`inconclusive: no probe output, exit ${code}, stderr ${stderr.length} bytes`,
		);
	const seen = JSON.parse(line.slice(6));
	const privateOutputLeak = privateTexts.some(
		(text) => stdout.includes(text) || stderr.includes(text),
	);

	const pass =
		code === 0 &&
		seen.complete === true &&
		seen.privatePathsReadable === 0 &&
		seen.acceptanceMounted === false &&
		seen.gitEntries === 0 &&
		seen.ownSessions === 0 &&
		seen.cachePaths.length === 0 &&
		seen.freshTmpfs === true &&
		seen.envLeaks.length === 0 &&
		seen.tools === tools.join(",") &&
		seen.canaryHits === 0 &&
		seen.fingerprintHits === 0 &&
		seen.pathHits === 0 &&
		seen.githubGateway === 403 &&
		seen.githubDirect === "denied" &&
		!privateOutputLeak &&
		!stdout.includes(canary) &&
		!stderr.includes(canary);

	console.log(
		JSON.stringify(
			{
				...seen,
				bundle: bundle.digest,
				runId,
				acceptanceDigest: suite.receipt.acceptanceDigest,
				modelRequests: 0,
				exit: code,
				result: pass
					? "PASS"
					: seen.complete && code === 0
						? "FAIL"
						: "INCONCLUSIVE",
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
				env: { ...process.env, XDG_RUNTIME_DIR: runtime },
				stdio: "ignore",
			});
		} catch {
			console.error("scope stop returned nonzero; verify no scope remains");
		}
	}

	await gateway.handle.shutdown();
	rmSync(stageDir, { recursive: true, force: true });
	rmSync(gatewayDir, { recursive: true, force: true });

	if (reconstructed) {
		rmSync(workspace, { recursive: true, force: true });
		rmSync(join(stateDir, "pristine", runId), { recursive: true, force: true });
		rmSync(join(stateDir, "build-base", "checkouts", `${runId}.json`), {
			force: true,
		});
	}
}
