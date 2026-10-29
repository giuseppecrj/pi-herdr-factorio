import assert from "node:assert/strict";
import { type ChildProcess, spawn, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
	existsSync,
	mkdirSync,
	mkdtempSync,
	readFileSync,
	realpathSync,
	renameSync,
	rmSync,
	symlinkSync,
	writeFileSync,
} from "node:fs";
import { createServer as createHttpServer, request } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import {
	FORCED_PI_FLAGS,
	PI_AGENT_DIR,
	wrapPiArgv,
} from "../../server/sandbox/assets/pi.ts";
import {
	herdrEnvOf,
	parseStageInitArgs,
	startForwarder,
} from "../../server/sandbox/assets/stage-init.ts";
import {
	BUNDLE,
	bwrapArgv,
	SANDBOX,
	type SandboxLayout,
} from "../../server/sandbox/bwrap.ts";
import { startGatewayProcess } from "../../server/sandbox/gateway-client.ts";
import {
	arrayOf,
	fieldOf,
	objectOf,
	parseJson,
	textOf,
} from "../../server/sandbox/json.ts";
import { manifestDigest } from "../../server/sandbox/manifest.ts";
import {
	type PreflightDeps,
	runPreflight,
} from "../../server/sandbox/preflight.ts";
import {
	DEFAULT_SCOPE_LIMITS,
	namesStateDir,
	parseScopeList,
	reconcileScopes,
	scopeArgv,
	scopeOwner,
	scopeUnit,
	stopScopeArgv,
} from "../../server/sandbox/scope.ts";
import {
	piCommand,
	sandboxExecutor,
	sandboxHost,
} from "../../server/sandbox.ts";
import type { StageReceipt } from "../../server/sandbox/result.ts";
import {
	AUDIT_ARCH,
	decodeProgram,
	detectArch,
	type Instruction,
	type SeccompArch,
	seccompProgram,
	SYSCALLS,
} from "../../server/sandbox/seccomp.ts";
import type { ExecResult } from "../../src/gh.ts";
import type { LogFields } from "../../src/orchestrator.ts";
import type { Digest } from "../../src/run.ts";
import type { ModelId } from "../../src/workflow.ts";
import { modelTable } from "./routes.cases.ts";

const STATE = "/home/exedev/factory-state";
const RUN = "a".repeat(64);

function runDigest(text: string): Digest {
	assert.match(text, /^[0-9a-f]{64}$/);

	// SAFETY: the assertion above checks the Digest pattern.
	return text as Digest;
}

function modelId(text: string): ModelId {
	assert.match(text, /^[a-z0-9-]+\/[A-Za-z0-9._:-]+$/);

	// SAFETY: the assertion above checks the ModelId pattern.
	return text as ModelId;
}

function layout(overrides: Partial<SandboxLayout> = {}): SandboxLayout {
	return {
		bundleDir: `/var/lib/factory-sandbox/assets-${"b".repeat(64)}`,
		workspaceDir: `${STATE}/workspaces/${RUN}`,
		workspaceHasGit: true,
		agentDir: `${STATE}/stages/${RUN}/specify-1/agent`,
		socketPath: `${STATE}/gw/0123abcd/gw.sock`,
		seccompFd: 10,
		tools: ["read", "subagent"],
		command: ["/opt/factory/bin/pi", "--mode", "rpc"],
		...overrides,
	};
}

type Bind = { flag: string; source: string; dest: string };

function binds(argv: readonly string[]): Bind[] {
	const found: Bind[] = [];

	for (const [index, flag] of argv.entries()) {
		if (
			[
				"--bind",
				"--ro-bind",
				"--ro-bind-try",
				"--bind-try",
				"--dev-bind",
			].includes(flag)
		) {
			found.push({
				flag,
				source: argv[index + 1] ?? "",
				dest: argv[index + 2] ?? "",
			});
		}
	}

	return found;
}

describe("bwrap argv", () => {
	const argv = bwrapArgv(layout());

	it("starts bwrap under env -i with only PATH", () => {
		assert.deepEqual(argv.slice(0, 4), [
			"env",
			"-i",
			"PATH=/usr/bin:/bin",
			"bwrap",
		]);
	});

	it("uses the settled isolation flags and a fresh proc and dev", () => {
		for (const flag of [
			"--unshare-all",
			"--die-with-parent",
			"--new-session",
			"--clearenv",
		]) {
			assert.ok(argv.includes(flag), flag);
		}

		assert.deepEqual(
			argv.slice(argv.indexOf("--cap-drop"), argv.indexOf("--cap-drop") + 2),
			["--cap-drop", "ALL"],
		);
		assert.deepEqual(
			argv.slice(argv.indexOf("--proc"), argv.indexOf("--proc") + 2),
			["--proc", "/proc"],
		);
		assert.deepEqual(
			argv.slice(argv.indexOf("--dev"), argv.indexOf("--dev") + 2),
			["--dev", "/dev"],
		);
		assert.deepEqual(
			argv.slice(argv.indexOf("--seccomp"), argv.indexOf("--seccomp") + 2),
			["--seccomp", "10"],
		);
		assert.equal(argv.includes("--share-net"), false);
	});

	it("mounts the workspace and agent dir writable, the bundle read-only, and git config read-only", () => {
		const mounts = binds(argv);

		assert.deepEqual(
			mounts.filter((bind) => bind.flag === "--bind"),
			[
				{
					flag: "--bind",
					source: `${STATE}/workspaces/${RUN}`,
					dest: SANDBOX.workspace,
				},
				{
					flag: "--bind",
					source: `${STATE}/stages/${RUN}/specify-1/agent`,
					dest: SANDBOX.agentDir,
				},
				{
					flag: "--bind",
					source: `${STATE}/gw/0123abcd/gw.sock`,
					dest: SANDBOX.socket,
				},
			],
		);
		assert.ok(
			mounts.some(
				(bind) => bind.flag === "--ro-bind" && bind.dest === BUNDLE.root,
			),
		);
		assert.ok(
			mounts.some(
				(bind) =>
					bind.flag === "--ro-bind" &&
					bind.source === `${STATE}/workspaces/${RUN}/.git` &&
					bind.dest === `${SANDBOX.workspace}/.git`,
			),
		);
		assert.ok(
			mounts.some(
				(bind) =>
					bind.flag === "--ro-bind" &&
					bind.dest === `${SANDBOX.agentDir}/models.json`,
			),
		);
		assert.ok(
			mounts.some(
				(bind) =>
					bind.flag === "--ro-bind" &&
					bind.dest === `${SANDBOX.agentDir}/settings.json`,
			),
		);
		assert.ok(
			argv.indexOf(`${SANDBOX.workspace}/.git`) >
				argv.indexOf(SANDBOX.workspace),
		);
	});

	it("covers a missing .git with a read-only empty mount so the agent cannot plant one", () => {
		const fresh = bwrapArgv(layout({ workspaceHasGit: false }));
		const index = fresh.indexOf("--tmpfs", fresh.indexOf(SANDBOX.workspace));

		assert.deepEqual(fresh.slice(index, index + 4), [
			"--tmpfs",
			`${SANDBOX.workspace}/.git`,
			"--remount-ro",
			`${SANDBOX.workspace}/.git`,
		]);
	});

	it("never mounts host home, Pi or gh config, controller state, Docker, SSH, the user bus or host proc", () => {
		const forbidden = [
			"/",
			"/home",
			"/home/exedev",
			"/home/exedev/.pi",
			"/home/exedev/.pi/agent",
			"/home/exedev/.config",
			"/home/exedev/.config/gh",
			"/home/exedev/.ssh",
			"/home/exedev/.local",
			STATE,
			`${STATE}/workspaces`,
			`${STATE}/workspaces/${"c".repeat(64)}`,
			`${STATE}/stages`,
			`${STATE}/stages/${RUN}`,
			"/var/run/docker.sock",
			"/run/docker.sock",
			"/run",
			"/run/user",
			"/run/user/1000",
			"/run/user/1000/bus",
			"/run/credentials",
			"/etc/factory",
			"/etc/systemd",
			"/proc",
			"/sys",
			"/var",
			"/tmp",
		];

		const sources = binds(argv).map((bind) => bind.source);

		for (const path of forbidden) {
			assert.equal(sources.includes(path), false, path);
		}

		for (const source of sources) {
			assert.equal(
				source.includes("SSH_AUTH_SOCK") ||
					(source.includes(".sock") && !source.endsWith("/gw.sock")),
				false,
				source,
			);
			assert.equal(
				source.startsWith(`${STATE}/`) &&
					!source.startsWith(`${STATE}/workspaces/${RUN}`) &&
					!source.startsWith(`${STATE}/stages/${RUN}/specify-1/agent`) &&
					source !== `${STATE}/gw/0123abcd/gw.sock`,
				false,
				source,
			);
		}

		assert.equal(
			argv.some(
				(entry) =>
					entry.includes("SSH_AUTH_SOCK") || entry.includes("DBUS_SESSION"),
			),
			false,
		);
	});

	it("sets an explicit minimal environment inside the sandbox", () => {
		const env = new Map<string, string>();

		for (const [index, flag] of argv.entries()) {
			if (flag === "--setenv")
				env.set(argv[index + 1] ?? "", argv[index + 2] ?? "");
		}

		assert.equal(env.get("PI_CODING_AGENT_DIR"), PI_AGENT_DIR);
		assert.equal(
			env.get("PATH"),
			`${BUNDLE.bin}:${BUNDLE.nodeBin}:/usr/bin:/bin`,
		);
		assert.equal(env.get("FACTORY_PI_TOOLS"), "read,subagent");
		assert.equal(env.get("PI_OFFLINE"), "1");
		assert.equal(env.get("HOME"), SANDBOX.home);
		assert.equal(
			env.has("XDG_RUNTIME_DIR") &&
				env.get("XDG_RUNTIME_DIR")?.startsWith("/run/user"),
			false,
		);
	});

	it("runs stage-init with the forwarder before the command", () => {
		const tail = argv.slice(argv.indexOf("--"));

		assert.deepEqual(tail, [
			"--",
			BUNDLE.node,
			BUNDLE.stageInit,
			"--port",
			"18080",
			"--socket",
			SANDBOX.socket,
			"--herdr",
			BUNDLE.herdr,
			"--",
			"/opt/factory/bin/pi",
			"--mode",
			"rpc",
		]);
	});
});

const OWNER = "c0ffee42";

describe("user scope", () => {
	it("names each scope uniquely per controller, run, stage, attempt and nonce", () => {
		const unit = scopeUnit(OWNER, RUN, "specify", 2, "0f1e2d3c");

		assert.equal(
			unit,
			`factory-stage-${OWNER}-${RUN.slice(0, 16)}-specify-2-0f1e2d3c`,
		);
		assert.throws(() => scopeUnit(OWNER, RUN, "specify", 2, "../x"));
		assert.throws(() => scopeUnit("nothex!!", RUN, "specify", 2, "0f1e2d3c"));
	});

	it("derives the controller's scope owner from the state dir's real path", () => {
		const dir = mkdtempSync(join(tmpdir(), "factory-owner-"));

		try {
			mkdirSync(join(dir, "state"));
			symlinkSync(join(dir, "state"), join(dir, "link"));

			const owner = scopeOwner(join(dir, "state"));

			assert.match(owner, /^[0-9a-f]{8}$/);
			assert.equal(scopeOwner(join(dir, "link")), owner);
			assert.equal(
				owner,
				createHash("sha256")
					.update(realpathSync(join(dir, "state")))
					.digest("hex")
					.slice(0, 8),
			);
			assert.notEqual(scopeOwner(join(dir, "other")), owner);
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});

	it("wraps the sandbox with memory, task and CPU limits", () => {
		assert.deepEqual(
			scopeArgv("factory-stage-x", DEFAULT_SCOPE_LIMITS, ["env", "-i"]),
			[
				"systemd-run",
				"--user",
				"--scope",
				"--quiet",
				"--unit=factory-stage-x",
				"-p",
				"MemoryMax=2G",
				"-p",
				"TasksMax=512",
				"-p",
				"CPUQuota=100%",
				"-p",
				"TimeoutStopSec=5",
				"--",
				"env",
				"-i",
			],
		);
		assert.deepEqual(stopScopeArgv("factory-stage-x"), [
			"systemctl",
			"--user",
			"stop",
			"factory-stage-x.scope",
		]);
	});

	it("finds this controller's leftover stage scopes by name and stops only those", async () => {
		const stateDir = "/nonexistent/factory-state";
		const owner = scopeOwner(stateDir);
		const own = `factory-stage-${owner}-${RUN.slice(0, 16)}-build-1-aaaa0000`;
		const legacy = `factory-stage-${RUN.slice(0, 16)}-build-1-cccc0000`;

		const listing = [
			`${own}.scope loaded active running factory-stage`,
			`factory-stage-0badf00d-${RUN.slice(0, 16)}-build-1-bbbb0000.scope loaded active running x`,
			`${legacy}.scope loaded active running x`,
			"factory-stage-evil;rm.scope loaded active running x",
			"user@1000.service loaded active running",
			"",
		].join("\n");

		assert.deepEqual(parseScopeList(listing, owner), [own]);

		const calls: string[][] = [];

		const result = await reconcileScopes(
			stateDir,
			async (command, args): Promise<ExecResult> => {
				calls.push([command, ...args]);

				return {
					stdout:
						command === "systemctl" && args.includes("list-units")
							? listing
							: "",
					stderr: "",
					code: 0,
				};
			},
		);

		assert.deepEqual(result, { stopped: [own], failed: [], unowned: [legacy] });
		assert.deepEqual(calls, [
			[
				"systemctl",
				"--user",
				"list-units",
				"--all",
				"--plain",
				"--no-legend",
				"--type=scope",
				"factory-stage-*",
			],
			[
				"systemctl",
				"--user",
				"show",
				"-p",
				"Description",
				"--value",
				`${legacy}.scope`,
			],
			["systemctl", "--user", "stop", `${own}.scope`],
		]);
	});

	it("matches a state dir in a scope's command line only at an argument start", () => {
		const dir = "/var/lib/factory";

		for (const text of [
			`bwrap --bind ${dir}/stages/r/build-1/agent-0 /run/pi-agent`,
			`bwrap --bind "${dir}/gw/0a0b/gw.sock" /run/gw.sock`,
			`x --bind=${dir}/stages/r`,
		]) {
			assert.equal(namesStateDir(text, dir), true, text);
		}

		for (const text of [
			`bwrap --bind ${dir}-lane/stages/r /run/pi-agent`,
			`bwrap --bind /x${dir}/stages/r /run/pi-agent`,
			`bwrap --bind ${dir}/other/r /run/pi-agent`,
			`bwrap --bind ${dir}/stages /run/pi-agent`,
			"",
		]) {
			assert.equal(namesStateDir(text, dir), false, text);
		}
	});

	it("leaves another controller's live stage scope alone at startup", async () => {
		const dir = mkdtempSync(join(tmpdir(), "factory-recover-"));
		const calls: string[][] = [];

		try {
			const executor = sandboxExecutor({
				stateDir: join(dir, "different-state"),
				xdgRuntimeDir: "/run/user/1000",
				log: () => {},
				exec: async (command, args): Promise<ExecResult> => {
					calls.push([command, ...args]);

					return {
						stdout: args.includes("list-units")
							? "factory-stage-bbbbbbbbbbbbbbbb-specify-1-12345678.scope loaded active running\n"
							: "",
						stderr: "",
						code: 0,
					};
				},
			});

			await executor.recover();

			assert.equal(
				calls.some((call) => call.includes("stop")),
				false,
				JSON.stringify(calls),
			);
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});

	it("stops an old-format scope whose command line names this state dir, and logs the rest as unowned", async () => {
		const dir = mkdtempSync(join(tmpdir(), "factory-legacy-"));
		const stateDir = join(dir, "state");
		const stopped: string[] = [];
		const logs: [string, LogFields][] = [];

		mkdirSync(stateDir);

		const legacy = (nonce: string) =>
			`factory-stage-${RUN.slice(0, 16)}-build-1-${nonce}`;

		const own = `factory-stage-${scopeOwner(stateDir)}-${RUN.slice(0, 16)}-build-1-aaaa0000`;

		const descriptions = new Map([
			[
				legacy("11111111"),
				`[systemd-run] /usr/bin/env -i PATH=/usr/bin:/bin bwrap --bind ${stateDir}/stages/${RUN}/build-1/agent-0 /run/pi-agent --bind ${stateDir}/gw/0a0b0c0d/gw.sock /run/factory-gw.sock`,
			],
			[
				legacy("22222222"),
				`[systemd-run] /usr/bin/env -i bwrap --bind ${stateDir}-lane/stages/${RUN}/build-1/agent-0 /run/pi-agent`,
			],
		]);

		try {
			const executor = sandboxExecutor({
				stateDir,
				xdgRuntimeDir: "/run/user/1000",
				log: (event, fields) => logs.push([event, fields]),
				exec: async (_command, args): Promise<ExecResult> => {
					const unit = (args.at(-1) ?? "").replace(/\.scope$/, "");

					if (args.includes("list-units")) {
						return {
							stdout: [
								own,
								legacy("11111111"),
								legacy("22222222"),
								legacy("33333333"),
							]
								.map((name) => `${name}.scope loaded active running x`)
								.join("\n"),
							stderr: "",
							code: 0,
						};
					}

					if (args.includes("show")) {
						const text = descriptions.get(unit);

						return text === undefined
							? { stdout: "", stderr: "no", code: 1 }
							: { stdout: `${text}\n`, stderr: "", code: 0 };
					}

					if (args.includes("stop")) stopped.push(unit);

					return { stdout: "", stderr: "", code: 0 };
				},
			});

			await executor.recover();

			assert.deepEqual(stopped.sort(), [own, legacy("11111111")].sort());
			assert.deepEqual(
				logs.filter(([event]) => event === "scope_unowned"),
				[
					["scope_unowned", { unit: legacy("22222222") }],
					["scope_unowned", { unit: legacy("33333333") }],
				],
			);
			assert.deepEqual(
				logs.find(([event]) => event === "sandbox_reconciled"),
				["sandbox_reconciled", { stopped: 2, failed: 0, unowned: 2 }],
			);
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});
});

function run(program: readonly Instruction[], data: Buffer): number {
	let acc = 0;
	let pc = 0;

	while (pc < program.length) {
		const ins = program[pc];

		assert.ok(ins);

		if (ins.code === 0x20) {
			acc = data.readUInt32LE(ins.k);
			pc += 1;
		} else if (ins.code === 0x15 || ins.code === 0x35 || ins.code === 0x45) {
			const taken =
				ins.code === 0x15
					? acc === ins.k
					: ins.code === 0x35
						? acc >= ins.k
						: (acc & ins.k) !== 0;

			pc += 1 + (taken ? ins.jt : ins.jf);
		} else if (ins.code === 0x06) {
			return ins.k;
		} else {
			assert.fail(`unexpected opcode ${ins.code}`);
		}
	}

	return assert.fail("program fell off the end");
}

function syscall(
	arch: SeccompArch,
	nr: number,
	arg0 = 0,
	auditArch: number = AUDIT_ARCH[arch],
): Buffer {
	const data = Buffer.alloc(64);

	data.writeUInt32LE(nr >>> 0, 0);
	data.writeUInt32LE(auditArch >>> 0, 4);
	data.writeUInt32LE(arg0 >>> 0, 16);

	return data;
}

describe("seccomp filter", () => {
	const ALLOW = 0x7fff0000;
	const EPERM = 0x00050001;
	const ENOSYS = 0x00050026;
	const KILL = 0x80000000;

	it("detects the architecture and fails closed on an unknown one", () => {
		assert.equal(detectArch("x64"), "x86_64");
		assert.equal(detectArch("arm64"), "aarch64");
		assert.equal(detectArch("riscv64"), null);
		assert.equal(detectArch("ia32"), null);
	});

	for (const arch of ["x86_64", "aarch64"] as const) {
		it(`blocks the settled syscalls on ${arch}`, () => {
			const program = decodeProgram(
				seccompProgram(arch, { blockUnixSockets: false }),
			);

			const nr = SYSCALLS[arch];

			for (const name of [
				"io_uring_setup",
				"io_uring_enter",
				"io_uring_register",
				"ptrace",
				"process_vm_readv",
				"process_vm_writev",
				"bpf",
				"mount",
				"kexec_load",
				"userfaultfd",
			] as const) {
				assert.equal(run(program, syscall(arch, nr[name])), EPERM, name);
			}

			assert.equal(
				run(program, syscall(arch, nr.socket, 40)),
				EPERM,
				"AF_VSOCK",
			);
			assert.equal(run(program, syscall(arch, nr.socket, 2)), ALLOW, "AF_INET");
			assert.equal(
				run(program, syscall(arch, nr.socket, 1)),
				ALLOW,
				"AF_UNIX stays allowed by default",
			);
			assert.equal(
				run(program, syscall(arch, nr.unshare, 0x10000000)),
				EPERM,
				"unshare CLONE_NEWUSER",
			);
			assert.equal(
				run(program, syscall(arch, nr.unshare, 0x00020000)),
				EPERM,
				"unshare CLONE_NEWNS",
			);
			assert.equal(
				run(program, syscall(arch, nr.unshare, 0x00000400)),
				ALLOW,
				"unshare CLONE_FILES",
			);
			assert.equal(
				run(program, syscall(arch, nr.clone, 0x10000000 | 0x11)),
				EPERM,
				"clone CLONE_NEWUSER",
			);
			assert.equal(
				run(program, syscall(arch, nr.clone, 0x01200011)),
				ALLOW,
				"fork-style clone",
			);
			assert.equal(run(program, syscall(arch, nr.clone3)), ENOSYS, "clone3");
			assert.equal(run(program, syscall(arch, 0)), ALLOW, "syscall 0");
			assert.equal(
				run(program, syscall(arch, nr.socket, 2, 0x40000003)),
				KILL,
				"foreign audit arch",
			);
		});
	}

	it("kills x32 syscalls on x86_64", () => {
		const program = decodeProgram(
			seccompProgram("x86_64", { blockUnixSockets: false }),
		);

		assert.equal(run(program, syscall("x86_64", 0x40000000 + 41)), KILL);
	});

	it("blocks AF_UNIX only when asked", () => {
		const program = decodeProgram(
			seccompProgram("x86_64", { blockUnixSockets: true }),
		);

		assert.equal(
			run(program, syscall("x86_64", SYSCALLS.x86_64.socket, 1)),
			EPERM,
		);
	});

	it("emits eight-byte sock_filter records", () => {
		const bytes = seccompProgram("aarch64", { blockUnixSockets: false });

		assert.equal(bytes.length % 8, 0);
		assert.equal(decodeProgram(bytes).length, bytes.length / 8);
	});
});

describe("pi wrapper", () => {
	const allowed = ["read", "bash", "subagent", "caller_ping"];
	const F = FORCED_PI_FLAGS.length;

	it("forces --no-extensions, so Pi loads nothing from the writable agent dir's extensions/", () => {
		assert.deepEqual(
			[...FORCED_PI_FLAGS],
			["--no-mcp", "--no-approve", "--no-context-files", "--no-extensions"],
		);

		const wrapped = wrapPiArgv(["--mode", "rpc"], allowed);

		assert.ok(wrapped.ok);
		assert.ok(wrapped.argv.includes("--no-extensions"));
	});

	it("with the forced flags, a real Pi 1.4.0 skips <agentDir>/extensions/ and still loads an explicit -e", {
		timeout: 60_000,
	}, async () => {
		const dir = mkdtempSync(join(tmpdir(), "factory-pi-ext-"));

		const cli = new URL(
			"../../node_modules/@earendil-works/pi-coding-agent/dist/bundle/cli.js",
			import.meta.url,
		).pathname;

		const marker = (name: string) =>
			`import { writeFileSync } from "node:fs";\nexport default function () { writeFileSync(${JSON.stringify(join(dir, name))}, "1"); }\n`;

		try {
			mkdirSync(join(dir, "agent", "extensions"), { recursive: true });
			mkdirSync(join(dir, "work"));
			writeFileSync(join(dir, "agent", "settings.json"), "{}\n");
			writeFileSync(
				join(dir, "agent", "extensions", "planted.js"),
				marker("planted"),
			);
			writeFileSync(join(dir, "explicit.js"), marker("explicit"));

			const wrapped = wrapPiArgv(["--mode", "rpc", "--offline"], []);

			assert.ok(wrapped.ok);

			const child = spawn(
				process.execPath,
				[cli, ...wrapped.argv, "-e", join(dir, "explicit.js")],
				{
					cwd: join(dir, "work"),
					stdio: ["pipe", "ignore", "ignore"],
					env: {
						PATH: process.env.PATH ?? "/usr/bin:/bin",
						HOME: dir,
						PI_CODING_AGENT_DIR: join(dir, "agent"),
						PI_OFFLINE: "1",
					},
				},
			);

			const exited = new Promise<number | null>((done) =>
				child.on("exit", (code) => done(code)),
			);

			child.stdin.end();
			await exited;

			assert.equal(existsSync(join(dir, "explicit")), true, "explicit -e");
			assert.equal(existsSync(join(dir, "planted")), false, "agent dir");
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});

	it("with the forced flags, a real Pi 1.4.0 started as the stage Pi declares the subagent tool", {
		timeout: 60_000,
	}, async () => {
		const dir = mkdtempSync(join(tmpdir(), "factory-pi-parent-"));
		const agent = join(dir, "pi-agent");
		const modules = new URL("../../node_modules", import.meta.url).pathname;
		const cli = `${modules}/@earendil-works/pi-coding-agent/dist/bundle/cli.js`;
		const bodies: string[] = [];
		let child: ChildProcess | undefined;

		const server = createHttpServer((req, res) => {
			let body = "";

			req.on("data", (chunk: Buffer) => {
				body += chunk.toString();
			});
			req.on("end", () => {
				bodies.push(body);
				res.writeHead(500).end("{}");
			});
		});

		try {
			await new Promise<void>((done) => server.listen(0, "127.0.0.1", done));

			const address = server.address();

			const port =
				address !== null && address instanceof Object ? address.port : 0;

			const script = readFileSync(
				new URL("../../server/provision.sh", import.meta.url),
				"utf8",
			).split("\n");

			const first = script.indexOf('cat >"$b/pi-agent/models.json" <<JSON');

			const settings = script.indexOf(
				'cat >"$b/pi-agent/settings.json" <<JSON',
			);

			const last = script.indexOf("JSON", settings);

			assert.ok(first !== -1 && settings > first && last > settings);
			mkdirSync(join(agent, "sessions"), { recursive: true });
			mkdirSync(join(dir, "work"));

			const templated = spawnSync(
				"bash",
				[
					"-c",
					`set -eu\nb=$1\n${script.slice(first, last + 1).join("\n")}`,
					"provision",
					dir,
				],
				{
					env: {
						PATH: "/usr/bin:/bin",
						DEFAULT_PROVIDER: "openai",
						DEFAULT_MODEL: "gpt-6.1-sol",
						FORWARDER: `http://127.0.0.1:${port}`,
					},
				},
			);

			assert.equal(templated.status, 0, templated.stderr.toString());

			const wrapped = wrapPiArgv(
				piCommand(modelId("openai/gpt-6.1-sol")).slice(1),
				["read", "subagent"],
			);

			assert.ok(wrapped.ok);

			const local = wrapped.argv.map((arg) =>
				arg
					.replace(PI_AGENT_DIR, agent)
					.replace("/opt/factory/pkg/node_modules", modules),
			);

			const pi = spawn(process.execPath, [cli, ...local], {
				cwd: join(dir, "work"),
				stdio: ["pipe", "ignore", "ignore"],
				env: {
					PATH: process.env.PATH ?? "/usr/bin:/bin",
					HOME: dir,
					PI_CODING_AGENT_DIR: agent,
					PI_OFFLINE: "1",
				},
			});

			child = pi;

			const exited = new Promise<void>((done) => pi.on("exit", () => done()));

			pi.stdin.write(
				`${JSON.stringify({ id: "p", type: "prompt", message: "hi" })}\n`,
			);

			while (bodies.length === 0 && pi.exitCode === null) {
				await new Promise((done) => setTimeout(done, 50));
			}

			pi.kill();
			await exited;

			const body = objectOf(parseJson(bodies[0] ?? "{}"));

			const holders = [
				body,
				...(arrayOf(fieldOf(body, "input")) ?? []).map(objectOf),
			];

			const declared = holders
				.flatMap((holder) => arrayOf(fieldOf(holder, "tools")) ?? [])
				.map((tool) => textOf(fieldOf(objectOf(tool), "name")))
				.sort();

			assert.deepEqual(declared, ["read", "subagent"]);
		} finally {
			child?.kill();
			server.close();
			rmSync(dir, { recursive: true, force: true });
		}
	});

	it("forces the hardening flags onto a child launched by name", () => {
		const child = [
			"--session",
			"/run/pi-agent/sessions/x.jsonl",
			"-e",
			"/opt/factory/pkg/node_modules/pi-herdr-agents/maestro/adapters/pi/child/subagent-done.ts",
			"--model",
			"openai/gpt-6.1-sol",
			"--thinking",
			"low",
			"--tools",
			"read,caller_ping",
			"@/run/pi-agent/context.md",
		];

		const wrapped = wrapPiArgv(child, allowed);

		assert.ok(wrapped.ok);
		assert.deepEqual(wrapped.argv.slice(0, F), [...FORCED_PI_FLAGS]);
		assert.deepEqual(wrapped.argv.slice(F), [
			"--tools",
			"read,caller_ping",
			"--session",
			"/run/pi-agent/sessions/x.jsonl",
			"-e",
			"/opt/factory/pkg/node_modules/pi-herdr-agents/maestro/adapters/pi/child/subagent-done.ts",
			"--model",
			"openai/gpt-6.1-sol",
			"--thinking",
			"low",
			"@/run/pi-agent/context.md",
		]);
	});

	it("narrows requested tools to the allowlist and defaults to it", () => {
		const narrowed = wrapPiArgv(["-t", "read,write,mcp__x__*"], allowed);
		const joined = wrapPiArgv(["--tools=bash,+edit"], allowed);
		const none = wrapPiArgv(["--tools", "write"], allowed);
		const defaulted = wrapPiArgv(["--mode", "rpc"], allowed);

		assert.ok(narrowed.ok && joined.ok && none.ok && defaulted.ok);
		assert.deepEqual(narrowed.argv.slice(F, F + 2), ["--tools", "read"]);
		assert.deepEqual(joined.argv.slice(F, F + 2), ["--tools", "bash"]);
		assert.deepEqual(none.argv.slice(F, F + 1), ["--no-tools"]);
		assert.deepEqual(defaulted.argv.slice(F, F + 2), [
			"--tools",
			"read,bash,subagent,caller_ping",
		]);
	});

	it("refuses flags and subcommands that undo the hardening", () => {
		for (const args of [
			["--approve"],
			["-a"],
			["--api-key", "k"],
			["install", "npm:x"],
			["mcp", "list"],
			["config"],
			["update"],
		]) {
			assert.equal(wrapPiArgv(args, allowed).ok, false, args.join(" "));
		}

		const messages = wrapPiArgv(
			["--mode", "rpc", "--", "install", "--approve"],
			allowed,
		);

		assert.ok(messages.ok);
		assert.deepEqual(messages.argv.slice(-3), ["--", "install", "--approve"]);
	});

	it("refuses every flag outside its allowlist, including those that load code or tools", () => {
		for (const args of [
			["--extension", "/workspace/evil.js"],
			["-e", "/workspace/evil.js"],
			["--extension=/workspace/evil.js"],
			["-e", "builtin:mcp"],
			["-e", "/opt/factory/pkg/node_modules/pi-herdr-agents/"],
			["-e", "/opt/factory/pkg/node_modules/pi-herdr-pstack"],
			[
				"-e",
				"/opt/factory/pkg/node_modules/pi-herdr-agents/pi-extension/subagents/index.ts",
			],
			[
				"-e",
				"/opt/factory/pkg/node_modules/pi-herdr-agents/maestro/adapters/pi/child/../../../../../../../workspace/evil.ts",
			],
			["--mode", "rpc", "-e", "/workspace/evil.js"],
			["--mcp-server", "https://evil.example"],
			["--skill", "/workspace/skill"],
			["--prompt-template", "/workspace/t.md"],
			["--theme", "/workspace/theme"],
			["--plan"],
			["--no-builtin-tools"],
			["--fork", "x"],
			["--export", "/workspace/out.html"],
			["--provider", "anthropic"],
			["--approve=1"],
			["--model"],
			["-x"],
		]) {
			assert.equal(wrapPiArgv(args, allowed).ok, false, args.join(" "));
		}
	});

	it("keeps the flags the stage Pi and pi-herdr-agents children use", () => {
		const stage = wrapPiArgv(
			[
				"--mode",
				"rpc",
				"--session-dir",
				"/run/pi-agent/sessions",
				"--model",
				"openai/gpt-6.1-sol",
				"-e",
				"/opt/factory/pkg/node_modules/pi-herdr-agents",
			],
			allowed,
		);

		const prompted = wrapPiArgv(
			[
				"--session",
				"/run/pi-agent/sessions/x.jsonl",
				"--extension=/opt/factory/pkg/node_modules/pi-herdr-agents/maestro/adapters/pi/child/subagent-done.ts",
				"--append-system-prompt",
				"/run/pi-agent/sessions/artifacts/a/context/c-sysprompt.md",
				"--no-session",
				"hello",
			],
			allowed,
		);

		assert.ok(stage.ok && prompted.ok);
		assert.deepEqual(stage.argv.slice(F + 2), [
			"--mode",
			"rpc",
			"--session-dir",
			"/run/pi-agent/sessions",
			"--model",
			"openai/gpt-6.1-sol",
			"-e",
			"/opt/factory/pkg/node_modules/pi-herdr-agents",
		]);
		assert.deepEqual(prompted.argv.slice(F + 2), [
			"--session",
			"/run/pi-agent/sessions/x.jsonl",
			"--extension",
			"/opt/factory/pkg/node_modules/pi-herdr-agents/maestro/adapters/pi/child/subagent-done.ts",
			"--append-system-prompt",
			"/run/pi-agent/sessions/artifacts/a/context/c-sysprompt.md",
			"--no-session",
			"hello",
		]);
	});
});

describe("in-sandbox Herdr", () => {
	it("reads the root pane ids from workspace create output and refuses odd ones", () => {
		const out = JSON.stringify({
			result: {
				root_pane: { pane_id: "w1:p1", tab_id: "w1:t1", workspace_id: "w1" },
			},
		});

		assert.deepEqual(herdrEnvOf(out, "/h/herdr.sock"), {
			HERDR_ENV: "1",
			HERDR_SOCKET_PATH: "/h/herdr.sock",
			HERDR_PANE_ID: "w1:p1",
			HERDR_TAB_ID: "w1:t1",
			HERDR_WORKSPACE_ID: "w1",
		});
		assert.equal(herdrEnvOf("not json", "/h"), null);
		assert.equal(
			herdrEnvOf(
				JSON.stringify({
					result: {
						root_pane: { pane_id: "$(x)", tab_id: "t", workspace_id: "w" },
					},
				}),
				"/h",
			),
			null,
		);
	});
});

describe("in-sandbox forwarder", () => {
	it("parses its argv strictly", () => {
		assert.deepEqual(
			parseStageInitArgs([
				"--port",
				"18080",
				"--socket",
				"/run/gw.sock",
				"--",
				"pi",
				"--mode",
				"rpc",
			]),
			{
				port: 18080,
				socket: "/run/gw.sock",
				herdr: null,
				command: ["pi", "--mode", "rpc"],
			},
		);
		assert.deepEqual(
			parseStageInitArgs([
				"--port",
				"18080",
				"--socket",
				"/run/gw.sock",
				"--herdr",
				"/opt/factory/bin/herdr",
				"--",
				"pi",
			]),
			{
				port: 18080,
				socket: "/run/gw.sock",
				herdr: "/opt/factory/bin/herdr",
				command: ["pi"],
			},
		);
		assert.equal(
			parseStageInitArgs([
				"--port",
				"18080",
				"--socket",
				"/run/gw.sock",
				"--herdr",
				"herdr",
				"--",
				"pi",
			]),
			null,
		);
		assert.equal(
			parseStageInitArgs([
				"--port",
				"x",
				"--socket",
				"/run/gw.sock",
				"--",
				"pi",
			]),
			null,
		);
		assert.equal(
			parseStageInitArgs(["--port", "18080", "--socket", "/run/gw.sock"]),
			null,
		);
	});

	it("serves loopback TCP and relays each connection to the gateway socket", async () => {
		const dir = mkdtempSync(join(tmpdir(), "factory-fwd-"));
		const socketPath = join(dir, "gw.sock");

		const upstream = createHttpServer((req, res) =>
			res.end(`via-socket ${req.url}`),
		);

		await new Promise<void>((done) => upstream.listen(socketPath, done));

		const forwarder = await startForwarder(0, socketPath);
		const address = forwarder.address();

		const port =
			address !== null && address instanceof Object ? address.port : 0;

		try {
			const body = await new Promise<string>((done, fail) => {
				request({ host: "127.0.0.1", port, path: "/npm/x" }, (res) => {
					let text = "";

					res.on("data", (chunk: Buffer) => {
						text += chunk.toString();
					});
					res.on("end", () => done(text));
				})
					.on("error", fail)
					.end();
			});

			assert.equal(body, "via-socket /npm/x");
			assert.equal(
				address !== null && address instanceof Object ? address.address : "",
				"127.0.0.1",
			);
		} finally {
			forwarder.close();
			upstream.close();
			rmSync(dir, { recursive: true, force: true });
		}
	});
});

describe("gateway lifecycle from the runner", () => {
	it("creates a fresh 0700 dir, waits for ready, checks the inode and probes no-route", async () => {
		const dir = mkdtempSync(join(tmpdir(), "factory-gwc-"));

		try {
			const started = await startGatewayProcess({
				gatewayDir: join(dir, "gw"),
				auditPath: join(dir, "egress.jsonl"),
				table: modelTable(),
				readyTimeoutMs: 10_000,
			});

			assert.ok(started.ok, started.ok ? "" : started.reason);

			const gate = await started.handle.closeGate("abort");

			assert.equal(gate, true);

			const summary = await started.handle.shutdown();

			assert.equal(summary?.gate, "closed");
			assert.equal(await started.handle.exited, 0);

			const again = await startGatewayProcess({
				gatewayDir: join(dir, "gw"),
				auditPath: join(dir, "egress2.jsonl"),
				table: modelTable(),
				readyTimeoutMs: 10_000,
			});

			assert.deepEqual(again, { ok: false, reason: "dir-exists" });
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});

	it("refuses a socket path the kernel cannot bind", async () => {
		const dir = mkdtempSync(join(tmpdir(), "factory-gwc-"));
		const deep = join(dir, "x".repeat(120));

		try {
			mkdirSync(deep);
			assert.deepEqual(
				await startGatewayProcess({
					gatewayDir: join(deep, "gw"),
					auditPath: join(dir, "e.jsonl"),
					table: modelTable(),
					readyTimeoutMs: 5_000,
				}),
				{ ok: false, reason: "socket-path-too-long" },
			);
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});
});

describe("preflight", () => {
	const DIGEST = "d".repeat(64);

	function deps(overrides: Partial<PreflightDeps> = {}): PreflightDeps {
		return {
			reconciled: async () => true,
			arch: "x64",
			usernsLimit: async () => "15000",
			exec: async (command, args): Promise<ExecResult> => {
				if (command === "bwrap" && args[0] === "--version")
					return { stdout: "bubblewrap 0.9.0\n", stderr: "", code: 0 };

				return { stdout: "", stderr: "", code: 0 };
			},
			assetsDigest: async () => DIGEST,
			expectedDigest: DIGEST,
			gatewayReady: async () => true,
			...overrides,
		};
	}

	it("passes when every check passes", async () => {
		assert.deepEqual(await runPreflight(deps()), {
			ok: true,
			arch: "x86_64",
			bwrap: "0.9.0",
		});
	});

	it("names each failing check and never throws", async () => {
		const result = await runPreflight(
			deps({
				arch: "riscv64",
				usernsLimit: async () => "0",
				exec: async (command, args) =>
					command === "bwrap" && args[0] === "--version"
						? { stdout: "bubblewrap 0.8.0\n", stderr: "", code: 0 }
						: {
								stdout: "",
								stderr: "Failed to connect to bus: No medium found",
								code: 1,
							},
				assetsDigest: async () => null,
				gatewayReady: async () => {
					throw new Error("boom");
				},
				reconciled: async () => false,
			}),
		);

		assert.deepEqual(result, {
			ok: false,
			failed: [
				"reconcile",
				"arch",
				"userns",
				"bwrap",
				"assets",
				"scope",
				"gateway",
			],
		});
	});

	it("accepts a newer bwrap and rejects garbage version output", async () => {
		const version = (stdout: string) =>
			runPreflight(
				deps({
					exec: async (command, args) =>
						command === "bwrap" && args[0] === "--version"
							? { stdout, stderr: "", code: 0 }
							: { stdout: "", stderr: "", code: 0 },
				}),
			);

		assert.equal((await version("bubblewrap 0.11.1\n")).ok, true);
		assert.deepEqual(await version("bwrap?\n"), {
			ok: false,
			failed: ["bwrap"],
		});
	});

	it("reads what an earlier attempt spent from its receipt, else the gateway's audit tally", async () => {
		const dir = mkdtempSync(join(tmpdir(), "factory-spent-"));
		const runs = join(dir, "stages", RUN);

		try {
			const executor = sandboxExecutor({
				stateDir: dir,
				xdgRuntimeDir: "/run/user/1000",
				log: () => {},
				exec: async () => ({ stdout: "", stderr: "", code: 0 }),
			});

			const spent = (stage: "specify" | "build", attempt: number) =>
				executor.spent({ runId: runDigest(RUN), stage, attempt });

			mkdirSync(join(runs, "specify-1"), { recursive: true });
			writeFileSync(
				join(runs, "specify-1", "receipt.json"),
				JSON.stringify({ usage: { total: 900, gateway: 850 } }),
			);
			writeFileSync(
				join(runs, "specify-1", "egress.jsonl"),
				'{"inputTokens":5,"outputTokens":5}\n',
			);

			mkdirSync(join(runs, "specify-2"), { recursive: true });
			writeFileSync(
				join(runs, "specify-2", "egress.jsonl"),
				[
					'{"route":"model-openai","inputTokens":300,"outputTokens":20}',
					'{"route":"npm","inputTokens":null,"outputTokens":null}',
					'{"route":"model-openai","inputTokens":100,"outputTokens":7}',
					'{"route":"model-openai","inputTok',
				].join("\n"),
			);

			mkdirSync(join(runs, "specify-3"), { recursive: true });

			assert.equal(await spent("specify", 1), 900);
			assert.equal(await spent("specify", 2), 427);
			assert.equal(await spent("specify", 3), null);
			assert.equal(await spent("build", 1), null);
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});

	it("counts every execution dir of an attempt, a replay's included, once each", async () => {
		const dir = mkdtempSync(join(tmpdir(), "factory-spent-replay-"));

		try {
			const receipt = (total: number): StageReceipt => ({
				version: 1,
				runId: runDigest(RUN),
				stage: "specify",
				attempt: 1,
				outcome: { kind: "failed", exit: "aborted" },
				settlement: { event: "none", aborted: null },
				models: { requested: modelId("openai/gpt-6.1-sol"), observed: null },
				fallback: null,
				refusal: null,
				wallMs: 1,
				turns: 1,
				usage: {
					total,
					parent: total,
					children: 0,
					byModel: {},
					gateway: total,
					unreadChildren: 0,
				},
				egress: null,
				stderr: [],
				assetsDigest: "e".repeat(64),
				versions: {
					pi: "1.4.0",
					piHerdrAgents: "3.3.1",
					piHerdrPstack: "0.5.0",
				},
				pricing: "unavailable",
			});

			const host = () =>
				sandboxHost({
					stateDir: dir,
					bundleDir: join(dir, "bundle"),
					workspace: dir,
					runId: runDigest(RUN),
					stage: "specify",
					attempt: 1,
					tools: [],
					arch: "x86_64",
					xdgRuntimeDir: "/run/user/1000",
					assetsDigest: "e".repeat(64),
					versions: {
						pi: "1.4.0",
						piHerdrAgents: "3.3.1",
						piHerdrPstack: "0.5.0",
					},
					exec: async () => ({ stdout: "", stderr: "", code: 0 }),
				});

			assert.equal(await host().writeReceipt(receipt(50)), true);
			assert.equal(await host().writeReceipt(receipt(700)), true);

			const third = join(dir, "stages", RUN, "specify-1.3");

			host();
			writeFileSync(
				join(third, "egress.jsonl"),
				'{"inputTokens":20,"outputTokens":5}\n',
			);
			mkdirSync(join(dir, "stages", RUN, "specify-10"));
			writeFileSync(
				join(dir, "stages", RUN, "specify-10", "egress.jsonl"),
				'{"inputTokens":9000,"outputTokens":0}\n',
			);

			const executor = sandboxExecutor({
				stateDir: dir,
				xdgRuntimeDir: "/run/user/1000",
				log: () => {},
				exec: async () => ({ stdout: "", stderr: "", code: 0 }),
			});

			assert.equal(
				await executor.spent({
					runId: runDigest(RUN),
					stage: "specify",
					attempt: 1,
				}),
				775,
			);
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});

	it("stays unavailable while the startup scope reconcile has not succeeded", async () => {
		const dir = mkdtempSync(join(tmpdir(), "factory-pf-reconcile-"));
		const stateDir = join(dir, "state");
		const root = join(dir, "root");
		const logs: [string, LogFields][] = [];
		let listing = 1;

		try {
			mkdirSync(stateDir);
			mkdirSync(join(root, "staging"), { recursive: true });
			writeFileSync(join(root, "staging", "marker"), "bundle\n");

			const digest = await manifestDigest(join(root, "staging"));

			assert.ok(digest);
			renameSync(join(root, "staging"), join(root, `assets-${digest}`));
			symlinkSync(`assets-${digest}`, join(root, "current"));

			const executor = sandboxExecutor({
				stateDir,
				root,
				arch: "x64",
				usernsLimit: async () => "15000",
				xdgRuntimeDir: "/run/user/1000",
				log: (event, fields) => logs.push([event, fields]),
				exec: async (command, args): Promise<ExecResult> => {
					if (args.includes("list-units"))
						return { stdout: "", stderr: "bus", code: listing };

					if (command === "bwrap")
						return { stdout: "bubblewrap 0.9.0\n", stderr: "", code: 0 };

					return { stdout: "", stderr: "", code: 0 };
				},
			});

			await executor.recover();

			assert.equal(await executor.preflight(), false);
			assert.deepEqual(
				logs.find(([event]) => event === "sandbox_preflight")?.[1].failed,
				"reconcile",
			);

			const launch = await executor.launch({
				runId: runDigest(RUN),
				stage: "specify",
				attempt: 1,
				workspace: dir,
				settings: {
					model: modelId("openai/gpt-6.1-sol"),
					fallback: null,
					budget: { maxTurns: 1, wallMs: 60_000, stallMs: 60_000 },
					maxTokens: null,
				},
				remainingRunTokens: 1,
				signal: new AbortController().signal,
				progress: () => {},
			});

			assert.equal(launch.kind, "unavailable");

			listing = 0;
			assert.equal(await executor.preflight(), true);
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});
});
