import { randomBytes } from "node:crypto";
import type { ExecutionStage as ModelStage } from "../../src/core/stages.ts";
import {
	existsSync,
	lstatSync,
	mkdirSync,
	readdirSync,
	readFileSync,
	realpathSync,
	statSync,
	writeFileSync,
} from "node:fs";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import type { Readable } from "node:stream";
import type { Exec } from "../../src/github/exec.ts";
import type { Digest } from "../../src/core/run.ts";
import {
	type AcceptEffort,
	type ModelId,
	STAGE_CLEANUP_RESERVE_MS,
} from "../../src/config/schema.ts";
import { HERDR_AGENTS, PI_AGENT_DIR } from "./assets/pi.ts";
import { AUDIT_CAP_BYTES, JOURNAL_FILE } from "./audit.ts";
import { fieldOf, objectOf, parseJson } from "../../src/core/json.ts";
import { BUNDLE, bwrapArgv } from "./bwrap.ts";
import { startGatewayProcess } from "./gateway-client.ts";
import type { PinnedVersions } from "./result.ts";
import type { PlatformProfile } from "../../src/trust/platform.ts";
import { parsePiRecord } from "./rpc.ts";
import {
	DEFAULT_SCOPE_LIMITS,
	scopeArgv,
	scopeOwner,
	scopeUnit,
	spawnScoped,
	stopScopeArgv,
} from "./scope.ts";
import { type SeccompArch, seccompProgram } from "./seccomp.ts";
import { childUsageOf } from "./settle.ts";
import {
	boundedText,
	MAX_SESSION_BYTES,
	publishFile,
	replaceUsage,
} from "./receipts.ts";
import { EXIT_WAIT_MS, type StageHost, waitFor } from "./run-stage.ts";

/** Time kept back from `wall_ms` for cleanup. The hard deadline is `wall_ms` minus this. */
export const CLEANUP_RESERVE_MS = STAGE_CLEANUP_RESERVE_MS;

export const STDERR_CAP_BYTES = 64 * 1024;

export const STAGE_SYSTEM_PROMPT =
	"You are one stage of a software factory, running in a sandbox. Follow the user message exactly, and use only the tools it allows.";

export type SandboxHostConfig = {
	readonly platform: PlatformProfile;
	readonly stateDir: string;
	readonly bundleDir: string;
	readonly workspace: string;
	readonly stageDir?: string;
	readonly acceptEffort?: AcceptEffort;
	readonly runId: Digest;
	readonly stage: ModelStage;
	readonly attempt: number;
	readonly tools: readonly string[];
	readonly arch: SeccompArch;
	readonly xdgRuntimeDir: string;
	readonly assetsDigest: string;
	readonly versions: PinnedVersions;
	readonly exec: Exec;
	readonly blockUnixSockets?: boolean;
	readonly now?: () => number;
	readonly launch?: typeof launchSandbox;
	readonly gateway?: typeof startGatewayProcess;
};

export function freshDir(base: string): string {
	for (let n = 1; ; n++) {
		const path = n === 1 ? base : `${base}.${n}`;

		try {
			mkdirSync(path, { mode: 0o700 });

			return path;
		} catch (error) {
			if (
				!(error instanceof Error && "code" in error && error.code === "EEXIST")
			)
				throw error;
		}
	}
}

export function piCommand(
	model: ModelId,
	children = false,
	effort?: AcceptEffort,
): string[] {
	return [
		`${BUNDLE.bin}/pi`,
		...(children ? ["-e", HERDR_AGENTS] : []),
		"--mode",
		"rpc",
		"--no-skills",
		"--system-prompt",
		STAGE_SYSTEM_PROMPT,
		"--session-dir",
		`${PI_AGENT_DIR}/sessions`,
		"--model",
		model,
		...(effort === undefined ? [] : ["--thinking", effort]),
	];
}

/**
 * Copies the bundle's agent template into a fresh private dir Pi can write:
 * `auth.json`, the settings lock and sessions live there. The bundle
 * is installed read-only, so its modes are not kept. Only regular files are
 * copied.
 */
export function agentDirFrom(template: string, dest: string): void {
	mkdirSync(dest, { mode: 0o700 });

	for (const name of readdirSync(template)) {
		if (lstatSync(join(template, name)).isFile()) {
			writeFileSync(join(dest, name), readFileSync(join(template, name)), {
				mode: 0o600,
				flag: "wx",
			});
		}
	}

	mkdirSync(join(dest, "sessions"), { mode: 0o700 });
}

/** Where the workspace's `.git` stands. A symlink or other file is unsafe to bind. */
export function gitState(workspace: string): "dir" | "absent" | "unsafe" {
	try {
		return lstatSync(join(workspace, ".git")).isDirectory() ? "dir" : "unsafe";
	} catch (error) {
		return error instanceof Error && "code" in error && error.code === "ENOENT"
			? "absent"
			: "unsafe";
	}
}

export function launchSandbox(
	config: Pick<
		SandboxHostConfig,
		| "stateDir"
		| "bundleDir"
		| "workspace"
		| "runId"
		| "stage"
		| "attempt"
		| "tools"
		| "arch"
		| "xdgRuntimeDir"
		| "blockUnixSockets"
	> & {
		readonly agentDir: string;
		readonly socketPath: string;
		readonly command: readonly string[];
	},
) {
	const git = gitState(config.workspace);

	if (git === "unsafe") return null;

	if (config.stage === "maintain" && git === "absent")
		mkdirSync(join(config.workspace, ".git"), { mode: 0o700 });

	agentDirFrom(join(config.bundleDir, "pi-agent"), config.agentDir);

	const unit = scopeUnit(
		scopeOwner(config.stateDir),
		config.runId,
		config.stage,
		config.attempt,
		randomBytes(4).toString("hex"),
	);

	const sandboxArgs = bwrapArgv({
		bundleDir: config.bundleDir,
		workspaceDir: config.workspace,
		workspaceHasGit: git === "dir",
		agentDir: config.agentDir,
		socketPath: config.socketPath,
		seccompFd: 10,
		tools: config.tools,
		command: config.command,
	});

	if (config.stage === "maintain") {
		const at = sandboxArgs.findIndex(
			(arg, index) =>
				arg === "--bind" && sandboxArgs[index + 1] === config.workspace,
		);

		if (at < 0 || config.tools.length !== 0) return null;

		sandboxArgs[at] = "--ro-bind";

		const herdr = sandboxArgs.indexOf("--herdr");

		if (herdr >= 0) sandboxArgs.splice(herdr, 2);
	}

	const argv = scopeArgv(unit, DEFAULT_SCOPE_LIMITS, sandboxArgs);

	const child = spawnScoped({
		argv,
		seccomp: seccompProgram(config.arch, {
			blockUnixSockets: config.blockUnixSockets ?? false,
		}),
		seccompFd: 10,
		xdgRuntimeDir: config.xdgRuntimeDir,
	});

	return { unit, child };
}

/**
 * Maps a child's in-sandbox session path to the host, refusing anything
 * outside `<agentDir>/sessions/` after symlinks resolve. The sandbox can
 * write that directory, so its paths are untrusted.
 */
export function hostSessionPath(
	agentDir: string,
	sandboxPath: string,
): string | null {
	const prefix = `${PI_AGENT_DIR}/sessions/`;

	if (
		!sandboxPath.startsWith(prefix) ||
		sandboxPath.split("/").includes("..")
	) {
		return null;
	}

	try {
		const root = realpathSync(join(agentDir, "sessions"));

		const real = realpathSync(
			join(agentDir, sandboxPath.slice(PI_AGENT_DIR.length + 1)),
		);

		return real.startsWith(`${root}/`) && statSync(real).isFile() ? real : null;
	} catch {
		return null;
	}
}

/**
 * Keeps the last `STDERR_CAP_BYTES` a sandbox writes to stderr. The returned
 * function waits up to `waitMs` for the stream to close, writes the kept
 * bytes to `path` with mode 0600, and resolves to the total bytes written,
 * or `null` when the file could not be written. The text is untrusted, so
 * it goes only to that file.
 */
export function captureStderr(
	stream: Readable,
	path: string,
): (waitMs: number) => Promise<number | null> {
	let tail = Buffer.alloc(0);
	let bytes = 0;

	const closed = new Promise<void>((done) => {
		stream.on("close", () => done());
		stream.on("end", () => done());
		stream.on("error", () => done());
	});

	stream.on("data", (chunk: Buffer) => {
		bytes += chunk.length;
		tail = Buffer.concat([tail, chunk]);

		if (tail.length > STDERR_CAP_BYTES) {
			tail = Buffer.from(tail.subarray(tail.length - STDERR_CAP_BYTES));
		}
	});

	return async (waitMs) => {
		await waitFor(closed, waitMs);

		try {
			writeFileSync(path, tail, { mode: 0o600, flag: "wx" });

			return bytes;
		} catch {
			return null;
		}
	};
}

/**
 * The real effects for one stage attempt: a fresh stage directory under
 * the state dir, one gateway process, and one scoped bwrap sandbox per Pi
 * session.
 */
export function sandboxHost(config: SandboxHostConfig): StageHost {
	const units = new Map<number, string>();
	const agentDirs = new Map<number, string>();

	const stderr = new Map<number, (waitMs: number) => Promise<number | null>>();

	let socketPath: string | null = null;

	mkdirSync(join(config.stateDir, "stages", config.runId), {
		recursive: true,
		mode: 0o700,
	});

	const stageDir =
		config.stageDir ??
		freshDir(
			join(
				config.stateDir,
				"stages",
				config.runId,
				`${config.stage}-${config.attempt}`,
			),
		);

	mkdirSync(stageDir, { recursive: true, mode: 0o700 });

	return {
		platform: config.platform,
		cleanupReserveMs: CLEANUP_RESERVE_MS,
		assetsDigest: config.assetsDigest,
		versions: config.versions,
		now: config.now ?? Date.now,
		async startGateway(table) {
			mkdirSync(join(config.stateDir, "gw"), { recursive: true, mode: 0o700 });

			const started = await (config.gateway ?? startGatewayProcess)({
				gatewayDir: join(config.stateDir, "gw", randomBytes(4).toString("hex")),
				auditPath: join(stageDir, "egress.jsonl"),
				table,
				platform: config.platform,
				readyTimeoutMs: 10_000,
			});

			if (!started.ok) return null;

			socketPath = started.handle.socketPath;

			return started.handle;
		},
		async launchPi(model, session) {
			if (socketPath === null) return null;
			const agentDir = join(stageDir, `agent-${session}`);

			const launched = launchSandbox({
				...config,
				agentDir,
				socketPath,
				command: piCommand(
					model,
					config.tools.includes("subagent"),
					config.stage === "accept" ? config.acceptEffort : undefined,
				),
			});

			if (launched === null) return null;
			const { unit, child } = launched;
			agentDirs.set(session, agentDir);
			units.set(session, unit);

			if (child.stderr !== null) {
				stderr.set(
					session,
					captureStderr(
						child.stderr,
						join(stageDir, `pi-stderr-${session}.log`),
					),
				);
			}

			if (child.stdin === null || child.stdout === null) return null;

			const exited = new Promise<number | null>((done) => {
				child.on("exit", (code) => done(code));
				child.on("error", () => done(null));
			});

			return {
				stdin: child.stdin,
				stdout: child.stdout,
				exited,
				kill: () => child.kill("SIGKILL"),
			};
		},
		async stopSandbox(session) {
			const unit = units.get(session);

			if (unit === undefined) return;

			const [command, ...args] = stopScopeArgv(unit);

			await config.exec(command ?? "systemctl", args);
		},
		async readChildUsage(session, sessionFile) {
			const agentDir = agentDirs.get(session);

			const path =
				agentDir === undefined ? null : hostSessionPath(agentDir, sessionFile);

			if (path === null || statSync(path).size > MAX_SESSION_BYTES) return null;

			const text = await readFile(path, "utf8");
			let assistantTurns: number | null = 0;
			let toolResultBytes: number | null = 0;

			for (const line of text.split("\n").filter((line) => line !== "")) {
				const entry = objectOf(parseJson(line));

				if (entry === null) {
					assistantTurns = null;
					toolResultBytes = null;
					continue;
				}

				const message = fieldOf(entry, "message");

				if (message === undefined) continue;

				const record = parsePiRecord(
					JSON.stringify({ type: "message_end", message }),
				);

				if (record.type === "malformed") {
					assistantTurns = null;
					toolResultBytes = null;
				}

				if (record.type === "assistant_end" && assistantTurns !== null)
					assistantTurns++;

				if (record.type === "other" && record.textBytes !== undefined)
					toolResultBytes =
						record.textBytes === null || toolResultBytes === null
							? null
							: toolResultBytes + record.textBytes;
			}

			return {
				...childUsageOf(text),
				efficiency: { assistantTurns, toolResultBytes },
			};
		},
		readUsage() {
			const path = join(stageDir, "usage.json");

			if (!existsSync(path)) return null;

			try {
				return parseJson(readFileSync(path, "utf8"));
			} catch {
				return undefined;
			}
		},
		writeUsage(usage) {
			return replaceUsage(join(stageDir, "usage.json"), usage);
		},
		async writeReceipt(receipt) {
			return publishFile(
				join(stageDir, "receipt.json"),
				`${JSON.stringify(receipt, null, "\t")}\n`,
			);
		},
		async writeOutput(text) {
			return publishFile(join(stageDir, "output.txt"), text);
		},
		readJournal() {
			return boundedText(join(stageDir, JOURNAL_FILE), AUDIT_CAP_BYTES);
		},
		async stderrLog(session) {
			const finish = stderr.get(session);
			const bytes = finish === undefined ? null : await finish(EXIT_WAIT_MS);

			return bytes === null
				? null
				: { session, file: `pi-stderr-${session}.log`, bytes };
		},
	};
}
