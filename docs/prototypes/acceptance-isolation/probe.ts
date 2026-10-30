import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { mkdirSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { fileRunFiles } from "../../../server/controller.ts";
import { agentDirFrom, gitState, locateBundle, SANDBOX_ROOT } from "../../../server/sandbox.ts";
import { bwrapArgv } from "../../../server/sandbox/bwrap.ts";
import { startGatewayProcess } from "../../../server/sandbox/gateway-client.ts";
import { builtinTable } from "../../../server/sandbox/routes.ts";
import { DEFAULT_SCOPE_LIMITS, scopeArgv, scopeOwner, scopeUnit, spawnScoped, stopScopeArgv } from "../../../server/sandbox/scope.ts";
import { detectArch, seccompProgram } from "../../../server/sandbox/seccomp.ts";
import { isDigest } from "../../../src/run.ts";

// Launches one build-profile sandbox the way sandboxHost launches a stage
// (scope, seccomp, gateway, fresh agent dir, the run's workspace, the build
// tool list), but runs a fixed Node script instead of Pi, so it spends no
// model tokens. The script hunts for the stored suite and its canary.

const [stateDir, runId] = process.argv.slice(2);

assert.ok(stateDir && runId && isDigest(runId), "usage: probe.ts <lane-state-dir> <run-id>");

const files = fileRunFiles(stateDir);
const bound = await files.readContract(runId);

if (bound.kind !== "found") throw new Error(`contract ${bound.reason}`);

const suite = await files.artifacts.read(runId, bound.contract, bound.digest);

if (suite.kind !== "found") throw new Error(`suite ${suite.kind}`);

const canary = readFileSync(join(stateDir, "acceptance", runId, "canary.txt"), "utf8").trim();
const bundle = await locateBundle(SANDBOX_ROOT);
const arch = detectArch(process.arch);

assert.ok(bundle && arch);

const workspace = files.workspacePath(runId);
const git = gitState(workspace);

assert.notEqual(git, "unsafe");

const stageDir = join(stateDir, "stages", runId, "build-probe");
const gatewayDir = join(stateDir, "gw", randomBytes(4).toString("hex"));

mkdirSync(stageDir, { recursive: true, mode: 0o700 });

mkdirSync(join(stateDir, "gw"), { recursive: true, mode: 0o700 });

const agentDir = join(stageDir, "agent-0");

agentDirFrom(join(bundle.dir, "pi-agent"), agentDir);

const gateway = await startGatewayProcess({
	gatewayDir,
	auditPath: join(stageDir, "egress.jsonl"),
	readyTimeoutMs: 10_000,
	table: builtinTable({ stage: "build", runId, attempt: 1, model: "openai/gpt-6.1-sol", fallback: null, modelTokens: 0, modelRequests: 0 }),
});

if (!gateway.ok) throw new Error(`gateway ${gateway.reason}`);

const tools = ["read", "grep", "ls", "bash", "write", "edit"];

const source = String.raw`
import { existsSync, readFileSync, readdirSync, lstatSync } from 'node:fs';
import http from 'node:http';
const out = {};
const readable = path => { try { readFileSync(path); return true; } catch { return false; } };
const cmd = readFileSync('/proc/1/cmdline', 'utf8').split('\0');
const hostWorkspace = cmd.find(p => /\/workspaces\/[a-f0-9]{64}$/.test(p)) ?? null;
out.hostWorkspaceVisibleInCmdline = hostWorkspace !== null;
const [state, id] = hostWorkspace === null ? ['/nonexistent', 'x'] : hostWorkspace.split('/workspaces/');
const hostPaths = [state+'/acceptance/'+id+'/canary.txt', state+'/acceptance/'+id+'/suite.json', state+'/acceptance/'+id+'.json', state+'/stages/'+id+'/accept-1/output.txt', state+'/stages/'+id+'/accept-1/agent-0/sessions', state+'/stages/'+id+'/specify-1/draft/output.txt', state+'/contracts/'+id+'/contract.json', '/workspace/../acceptance/'+id+'/canary.txt'];
out.privatePathsReadable = hostPaths.filter(readable).length;
out.acceptanceMounted = readFileSync('/proc/self/mountinfo', 'utf8').split('\n').some(l => l.includes('/acceptance') || l.includes('/stages/'+id+'/accept') || l.includes('/stages/'+id+'/specify'));
out.gitEntries = existsSync('/workspace/.git') ? readdirSync('/workspace/.git').length : 0;
out.ownSessions = readdirSync('/run/pi-agent/sessions').length;
const mounts = readFileSync('/proc/self/mountinfo', 'utf8').split('\n').map(l => l.split(' ')).filter(f => f.length > 8).map(f => ({ at: f[4], type: f[f.indexOf('-') + 1] }));
out.freshTmpfs = ['/home', '/tmp', '/run'].every(at => mounts.some(m => m.at === at && m.type === 'tmpfs'));
const walk = (path, acc) => { let names; try { names = readdirSync(path); } catch { return acc; } for (const name of names) { const file = path + '/' + name; acc.push(file); try { if (lstatSync(file).isDirectory()) walk(file, acc); } catch {} } return acc; };
out.homeEntries = walk('/home/agent', []);
out.cachePaths = ['/home/agent/.cache', '/home/agent/.npm', '/home/agent/.pi', '/run/credentials', '/run/user', '/root'].filter(p => existsSync(p));
out.envLeaks = ['SSH_AUTH_SOCK', 'GH_TOKEN', 'GITHUB_TOKEN', 'OPENAI_API_KEY', 'NODE_OPTIONS', 'XDG_RUNTIME_DIR_HOST'].filter(k => process.env[k] !== undefined);
out.tools = process.env.FACTORY_PI_TOOLS;
const pattern = /factory-holdout-[0-9a-f]{64}/;
let scanned = 0; let hits = [];
const scan = path => { let names; try { names = readdirSync(path); } catch { return; } for (const name of names) { const file = path === '/' ? '/'+name : path+'/'+name; let stat; try { stat = lstatSync(file); } catch { continue; } if (stat.isDirectory()) scan(file); else if (stat.isFile() && stat.size < 4*1024*1024) { scanned++; try { if (pattern.test(readFileSync(file, 'latin1'))) hits.push(file); } catch {} } } };
for (const root of ['/workspace', '/run', '/home', '/tmp', '/opt/factory', '/etc']) scan(root);
out.filesScanned = scanned; out.canaryHits = hits;
out.githubGateway = await new Promise(done => { const req = http.get('http://127.0.0.1:18080/github/repos/giuseppecrj/pi-herdr-factorio', r => { r.resume(); r.on('end', () => done(r.statusCode)); }); req.on('error', e => done('error:'+e.code)); });
out.githubDirect = await fetch('https://api.github.com', { signal: AbortSignal.timeout(1500) }).then(() => 'reachable', e => 'denied');
console.log('PROBE ' + JSON.stringify(out));
`;

const unit = scopeUnit(scopeOwner(stateDir), runId, "build", 1, randomBytes(4).toString("hex"));
const runtime = process.env.XDG_RUNTIME_DIR ?? `/run/user/${process.getuid?.()}`;
const argv = scopeArgv(unit, DEFAULT_SCOPE_LIMITS, bwrapArgv({ bundleDir: bundle.dir, workspaceDir: workspace, workspaceHasGit: git === "dir", agentDir, socketPath: gateway.handle.socketPath, seccompFd: 10, tools, command: ["/opt/factory/node/bin/node", "--input-type=module", "--eval", source] }));
let stdout = "";
let stderr = "";

try {
	const child = spawnScoped({ argv, seccomp: seccompProgram(arch, { blockUnixSockets: false }), seccompFd: 10, xdgRuntimeDir: runtime });

	child.stdout?.on("data", (chunk) => {
		stdout += chunk;
	});
	child.stderr?.on("data", (chunk) => {
		stderr += chunk;
	});
	child.stdin?.end();

	const code = await new Promise<number | null>((done, reject) => {
		child.on("exit", done);
		child.on("error", reject);
	});

	const line = stdout.split("\n").find((l) => l.startsWith("PROBE "));

	assert.ok(line, `no probe output, exit ${code}, stderr ${stderr.length} bytes`);

	const seen = JSON.parse(line.slice(6));

	const pass =
		seen.privatePathsReadable === 0 &&
		seen.acceptanceMounted === false &&
		seen.gitEntries === 0 &&
		seen.ownSessions === 0 &&
		seen.cachePaths.length === 0 &&
		seen.freshTmpfs === true &&
		seen.envLeaks.length === 0 &&
		seen.tools === tools.join(",") &&
		seen.canaryHits.length === 0 &&
		seen.githubGateway === 403 &&
		seen.githubDirect === "denied" &&
		!stdout.includes(canary) &&
		!stderr.includes(canary);

	console.log(JSON.stringify({ ...seen, bundle: bundle.digest, runId, acceptanceDigest: suite.receipt.acceptanceDigest, modelRequests: 0, exit: code, result: pass ? "PASS" : "FAIL" }, null, 2));
	process.exitCode = pass ? 0 : 1;
} finally {
	const [command, ...args] = stopScopeArgv(unit);

	try {
		execFileSync(command ?? "systemctl", args, { env: { ...process.env, XDG_RUNTIME_DIR: runtime }, stdio: "ignore" });
	} catch (error) {
		console.error(`scope stop: ${error instanceof Error ? error.message : String(error)}`);
	}

	await gateway.handle.shutdown();
	rmSync(stageDir, { recursive: true, force: true });
	rmSync(gatewayDir, { recursive: true, force: true });
}
