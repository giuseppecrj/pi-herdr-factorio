import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
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
	type PreflightDeps,
	runPreflight,
} from "../../server/sandbox/preflight.ts";
import {
	DEFAULT_SCOPE_LIMITS,
	parseScopeList,
	reconcileScopes,
	scopeArgv,
	scopeUnit,
	stopScopeArgv,
} from "../../server/sandbox/scope.ts";
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
import { modelTable } from "./routes.cases.ts";

const STATE = "/home/exedev/factory-state";
const RUN = "a".repeat(64);

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

describe("user scope", () => {
	it("names each scope uniquely per run, stage, attempt and nonce", () => {
		const unit = scopeUnit(RUN, "specify", 2, "0f1e2d3c");

		assert.equal(unit, `factory-stage-${RUN.slice(0, 16)}-specify-2-0f1e2d3c`);
		assert.throws(() => scopeUnit(RUN, "specify", 2, "../x"));
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

	it("finds leftover stage scopes by name and stops each one", async () => {
		const listing = [
			`factory-stage-${RUN.slice(0, 16)}-build-1-aaaa0000.scope loaded active running factory-stage`,
			"factory-stage-evil;rm.scope loaded active running x",
			"user@1000.service loaded active running",
			"",
		].join("\n");

		assert.deepEqual(parseScopeList(listing), [
			`factory-stage-${RUN.slice(0, 16)}-build-1-aaaa0000`,
		]);

		const calls: string[][] = [];

		const result = await reconcileScopes(
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

		assert.deepEqual(result, {
			stopped: [`factory-stage-${RUN.slice(0, 16)}-build-1-aaaa0000`],
			failed: [],
		});
		assert.deepEqual(calls.at(-1), [
			"systemctl",
			"--user",
			"stop",
			`factory-stage-${RUN.slice(0, 16)}-build-1-aaaa0000.scope`,
		]);
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

	it("forces the hardening flags onto a child launched by name", () => {
		const child = [
			"--session",
			"/run/pi-agent/sessions/x.jsonl",
			"-e",
			"/opt/factory/pkg/node_modules/pi-herdr-agents/subagent-done.ts",
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
		assert.deepEqual(wrapped.argv.slice(0, 3), [...FORCED_PI_FLAGS]);
		assert.deepEqual(wrapped.argv.slice(3), [
			"--tools",
			"read,caller_ping",
			"--session",
			"/run/pi-agent/sessions/x.jsonl",
			"-e",
			"/opt/factory/pkg/node_modules/pi-herdr-agents/subagent-done.ts",
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
		assert.deepEqual(narrowed.argv.slice(3, 5), ["--tools", "read"]);
		assert.deepEqual(joined.argv.slice(3, 5), ["--tools", "bash"]);
		assert.deepEqual(none.argv.slice(3, 4), ["--no-tools"]);
		assert.deepEqual(defaulted.argv.slice(3, 5), [
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
			}),
		);

		assert.deepEqual(result, {
			ok: false,
			failed: ["arch", "userns", "bwrap", "assets", "scope", "gateway"],
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
});
