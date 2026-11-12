import {
	execFile as execFileCallback,
	type ExecFileOptionsWithStringEncoding,
} from "node:child_process";
import { lstat } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { setTimeout as delay } from "node:timers/promises";
import { type AttentionRead } from "../../src/views/attention.ts";
import { type AdmissionReceipt } from "../../src/trust/admission.ts";
import {
	type PlatformFile,
	type PlatformProfile,
	type PlatformSummary,
} from "../../src/trust/platform.ts";
import type { StageExecutor } from "../../src/controller/launch.ts";
import {
	type Clock,
	type Log,
	Orchestrator,
	type TickReport,
} from "../../src/controller/orchestrator.ts";
import type { JsonValue } from "../../src/core/json.ts";
import { type EnvLookup, redactCredentials } from "../../src/config/schema.ts";
import { type CheckReport, type StatusReport } from "../../src/config/views.ts";
import { type RepoSlug } from "../../src/trust/platform.ts";
import type { Exec, ExecResult } from "../../src/github/exec.ts";
import type { TarballFetch } from "../controller/checkout.ts";
import { type ProcessTable, procTable } from "../controller/lock.ts";
import { readLedgerBacklog } from "../controller/outbox.ts";
import { type Sleep } from "../controller/serve-loop.ts";
import { readDurableAccounting } from "../controller/terminal.ts";
import type { CadenceJob } from "../../src/config/schema.ts";
import { sandboxExecutor } from "../sandbox/executor.ts";
import { computeMetrics } from "../../src/views/metrics.ts";

export const USAGE = `Usage:
  node host/cli/index.ts platform --env
  node host/cli/index.ts replay check --json [--corpus <dir>] [--main-sha <sha>] [--previous-sha <sha>] [--candidate-sha <sha>] [--case <id> --production-state-dir <dir> --budget-file <file>]
  node host/cli/index.ts replay report --json --case <id> --previous-row <file> --candidate-row <file> --previous-record <file> --candidate-record <file> --previous-sha <sha> --candidate-sha <sha> [--corpus <dir>] [--previous-assets <digest> --candidate-assets <digest>]
  node host/cli/index.ts metrics --json --repo <owner/name> [--ledger-file <path>] [--state-dir <dir>] [--now <instant>] [--cohort production] [--offline] [--intervention-file <fixture>]
  node host/cli/index.ts score --run <id> --repo <owner/name> --state-dir <dir> [--scorer <id>] [--json]
  node host/cli/index.ts explain --run <id> --repo <owner/name> --state-dir <dir> [--json]
  node host/cli/index.ts cadence --once --job <architecture|security|instructions|hygiene|reflect> --json --repo <owner/name> --state-dir <dir>
  node host/cli/index.ts owner-feed --json --state-dir <dir> [--repo <owner/name>]
  node host/cli/index.ts viewer --state-dir <dir> [--run <id>] [--port <n>] [--allowed-host <authorized.ts.net>] [--base-path </prefix>]
  node host/cli/index.ts gates --repository <dir> --gate-sha <sha> --candidate-sha <sha> --nonce <id> --output <dir> [--runner docker|local]
  node host/cli/index.ts workflow-check --json --repo <owner/name> [--ref <branch>] [--reload-ref <branch>]
  node host/cli/index.ts status --json --repo <owner/name> [--ref <branch>] [--state-dir <dir>]
  node host/cli/index.ts admit --json --repo <owner/name> --issue <number> --state-dir <dir>
  node host/cli/index.ts tick --once --json --repo <owner/name> --state-dir <dir> [--issue <number>]... [--verification-token-cap <n>]
  node host/cli/index.ts run --json --repo <owner/name> --issue <number> --state-dir <dir> [--verification-token-cap <n>]
  node host/cli/index.ts serve --repo <owner/name> --state-dir <dir> [--issue <number>]... [--verification-token-cap <n>]`;

export const EXIT = { ok: 0, invalid: 1, usage: 2 } as const;

/** What the controller commands need besides `exec`. The process entry passes the real ones. */
export type ControllerRuntime = {
	clock: Clock;
	procs: ProcessTable;
	sleep: Sleep;
	signal: AbortSignal;
	policySource?: { readonly fetch?: TarballFetch };
	executor: (context: ExecutorContext) => StageExecutor;
};

export type ExecutorContext = {
	readonly stateDir: string;
	readonly exec: Exec;
	readonly log: Log;
	readonly platform: PlatformProfile;
};

export const XDG_RUNTIME_DIR = "/run/user/1000";

export type CliIo = {
	exec: Exec;
	env: EnvLookup;
	/** Reads the platform selection file. The process entry reads `/etc/factory/platform.json`. */
	readPlatformFile: () => Promise<PlatformFile>;
	stdout: (text: string) => void;
	stderr: (text: string) => void;
	runtime?: ControllerRuntime;
};

export const FETCH_TIMEOUT_MS = 30_000;

export const CONTROLLER_COMMANDS = ["tick", "run", "serve"] as const;

export type ControllerCommand =
	| (typeof CONTROLLER_COMMANDS)[number]
	| "cadence";

export type Parsed =
	| {
			kind: "workflow";
			command: "workflow-check" | "status";
			repo: RepoSlug;
			ref: string;
			reloadRef: string | null;
			stateDir: string | null;
	  }
	| { kind: "admit"; repo: RepoSlug; issue: number; stateDir: string }
	| {
			kind: "controller";
			command: ControllerCommand;
			job?: CadenceJob;
			repo: RepoSlug;
			stateDir: string;
			scope: readonly number[] | null;
			verificationCap: number | null;
	  }
	| { kind: "usage"; message: string };

function redactString(_key: string, item: JsonValue): JsonValue {
	const text = String(item);

	return item === text ? redactCredentials(text) : item;
}

export type ControllerView =
	| { readonly state: "unavailable"; readonly reason: string }
	| {
			readonly state: "running" | "stopped" | "stale_lock" | "unreadable_lock";
			readonly pid: number | null;
			readonly since: string | null;
			readonly lastTick: JsonValue | null;
	  };

type StatusOutput = Omit<StatusReport, "controller"> & {
	readonly platform: PlatformSummary;
	readonly controller: ControllerView;
	readonly attention: AttentionRead;
	readonly ledger: Awaited<ReturnType<typeof readLedgerBacklog>>;
	readonly accounting: Awaited<ReturnType<typeof readDurableAccounting>>;
	readonly durableUsage: JsonValue;
};

type Printable =
	| Awaited<ReturnType<Orchestrator["cadenceOnce"]>>
	| StatusOutput
	| CheckReport
	| ReturnType<typeof computeMetrics>
	| {
			readonly error:
				| "ledger_unavailable"
				| "ledger_too_large"
				| "intervention_fixture_invalid"
				| "now_after_defect_read";
	  }
	| AdmissionReceipt
	| TickReport
	| { readonly error: "controller_running"; readonly pid: number | null };

export function json(report: Printable): string {
	return `${JSON.stringify(report, redactString, 2)}\n`;
}

export async function isPrivateDirectory(path: string): Promise<boolean> {
	try {
		const info = await lstat(path);

		return (
			info.isDirectory() &&
			info.uid === process.geteuid?.() &&
			(info.mode & 0o022) === 0
		);
	} catch {
		return false;
	}
}

export function realRuntime(): ControllerRuntime {
	return {
		clock: { now: () => Date.now() },
		policySource: {},
		procs: procTable(),
		sleep: async (ms, signal) => {
			await delay(ms, undefined, { signal }).catch(() => undefined);
		},
		signal: new AbortController().signal,
		executor: (context) =>
			sandboxExecutor({
				...context,
				xdgRuntimeDir: XDG_RUNTIME_DIR,
				sourceRoot: fileURLToPath(new URL("../..", import.meta.url)),
			}),
	};
}

/**
 * Runs a program asynchronously with an argument array, so `serve` never
 * blocks on a child. A program that cannot start throws. One that times out
 * is killed and reported as a failure whose stderr says it timed out.
 */
export async function execFile(
	command: string,
	args: readonly string[],
	timeoutMs: number,
): Promise<ExecResult> {
	const metricLedger =
		command === "git" &&
		args.length === 2 &&
		args[0] === "show" &&
		args[1] === "refs/remotes/origin/factory/ledger:ledger/runs.jsonl";

	const options: ExecFileOptionsWithStringEncoding = {
		encoding: "utf8",
		timeout: timeoutMs,
		maxBuffer: 4 * 1024 * 1024,
		killSignal: "SIGKILL",
	};

	if (metricLedger) options.maxBuffer = 256 * 1024 * 1024;

	return new Promise((done, fail) => {
		const child = execFileCallback(
			command,
			[...args],
			options,
			(error, stdout, stderr) => {
				if (error === null) {
					done({ stdout, stderr, code: 0 });

					return;
				}

				if (child.pid === undefined) {
					fail(error);

					return;
				}

				const timedOut = error.killed === true && error.code === null;

				done({
					stdout,
					stderr:
						metricLedger && error.code === "ERR_CHILD_PROCESS_STDIO_MAXBUFFER"
							? "metric_ledger_too_large"
							: timedOut
								? `${command} timed out`
								: stderr || error.message,
					code: Number.isSafeInteger(error.code) ? Number(error.code) || 1 : 1,
				});
			},
		);
	});
}
