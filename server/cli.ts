import { execFile as execFileCallback } from "node:child_process";
import { lstat } from "node:fs/promises";
import { resolve } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { parseArgs } from "node:util";
import manifest from "../package.json" with { type: "json" };
import {
	type AdmissionReceipt,
	admitTicket,
	FACTORY_REPOSITORIES,
	fileAdmissionStore,
} from "../src/admission.ts";
import { GitHubTicketAdapter } from "../src/adapters/github.ts";
import {
	type Clock,
	checkIdentity,
	type Log,
	Orchestrator,
	type StageExecutor,
	type TickReport,
} from "../src/orchestrator.ts";
import type { JsonValue } from "../src/tickets.ts";
import {
	type CheckReport,
	checkReport,
	type EnvLookup,
	type Exec,
	type ExecResult,
	isBranchName,
	isRepoSlug,
	loadWorkflow,
	type RepoSlug,
	redactCredentials,
	type StatusReport,
	statusReport,
	TRUSTED_REF,
} from "../src/workflow.ts";
import {
	acquireLock,
	fileRunFiles,
	type SocketLockState,
	lineLog,
	type ProcessTable,
	procTable,
	readLock,
	readStatus,
	type Sleep,
	serveLoop,
	writeStatus,
} from "./controller.ts";
import { sandboxExecutor } from "./sandbox.ts";
import { runGatesCli } from "./gates.ts";

export const USAGE = `Usage:
  node server/cli.ts gates --repository <dir> --gate-sha <sha> --candidate-sha <sha> --nonce <id> --output <dir> [--runner docker|local]
  node server/cli.ts workflow-check --json --repo <owner/name> [--ref <branch>] [--reload-ref <branch>]
  node server/cli.ts status --json --repo <owner/name> [--ref <branch>] [--state-dir <dir>]
  node server/cli.ts admit --json --repo <owner/name> --issue <number> --state-dir <dir>
  node server/cli.ts tick --once --json --repo <owner/name> --state-dir <dir> [--issue <number>]...
  node server/cli.ts run --json --repo <owner/name> --issue <number> --state-dir <dir>
  node server/cli.ts serve --repo <owner/name> --state-dir <dir> [--issue <number>]...`;

export const EXIT = { ok: 0, invalid: 1, usage: 2 } as const;

/** What the controller commands need besides `exec`. The process entry passes the real ones. */
export type ControllerRuntime = {
	clock: Clock;
	procs: ProcessTable;
	sleep: Sleep;
	signal: AbortSignal;
	executor: (context: ExecutorContext) => StageExecutor;
};

export type ExecutorContext = {
	readonly stateDir: string;
	readonly exec: Exec;
	readonly log: Log;
};

const XDG_RUNTIME_DIR = "/run/user/1000";

export type CliIo = {
	exec: Exec;
	env: EnvLookup;
	stdout: (text: string) => void;
	stderr: (text: string) => void;
	runtime?: ControllerRuntime;
};

export const FETCH_TIMEOUT_MS = 30_000;

const ISSUE_NUMBER = /^[1-9][0-9]{0,9}$/;

const CONTROLLER_COMMANDS = ["tick", "run", "serve"] as const;

type ControllerCommand = (typeof CONTROLLER_COMMANDS)[number];

type Parsed =
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
			repo: RepoSlug;
			stateDir: string;
			scope: readonly number[] | null;
	  }
	| { kind: "usage"; message: string };

type Values = ReturnType<typeof parseCliArgs>["values"];

function isControllerCommand(command: string): command is ControllerCommand {
	return CONTROLLER_COMMANDS.some((known) => known === command);
}

function issuesOf(values: Values): number[] | null {
	const issues = values.issue ?? [];

	return issues.every((issue) => ISSUE_NUMBER.test(issue))
		? issues.map(Number)
		: null;
}

function parseController(
	command: ControllerCommand,
	repo: RepoSlug,
	values: Values,
): Parsed {
	if (values.ref !== undefined || values["reload-ref"] !== undefined) {
		return {
			kind: "usage",
			message: `${command} always reads main and takes no --ref`,
		};
	}

	if ((command === "tick") !== (values.once === true)) {
		return {
			kind: "usage",
			message: "--once applies only to tick, and tick requires it",
		};
	}

	if ((command === "serve") === (values.json === true)) {
		return {
			kind: "usage",
			message: "--json is required, except for serve, which logs lines",
		};
	}

	const issues = issuesOf(values);

	if (issues === null || (command === "run" && issues.length !== 1)) {
		return {
			kind: "usage",
			message:
				command === "run"
					? "--issue <number> is required"
					: "--issue must be a number",
		};
	}

	if (values["state-dir"] === undefined || values["state-dir"] === "") {
		return { kind: "usage", message: "--state-dir <dir> is required" };
	}

	return {
		kind: "controller",
		command,
		repo,
		stateDir: resolve(values["state-dir"]),
		scope: issues.length === 0 ? null : [...new Set(issues)],
	};
}

function parse(argv: readonly string[]): Parsed {
	let parsed: ReturnType<typeof parseCliArgs>;

	try {
		parsed = parseCliArgs(argv);
	} catch {
		return { kind: "usage", message: "unrecognized or incomplete options" };
	}

	const { values, positionals } = parsed;
	const [command, ...extra] = positionals;

	if (
		command !== "workflow-check" &&
		command !== "status" &&
		command !== "admit" &&
		(command === undefined || !isControllerCommand(command))
	) {
		return {
			kind: "usage",
			message: "expected workflow-check, status, admit, tick, run or serve",
		};
	}

	if (extra.length > 0) {
		return { kind: "usage", message: "unexpected extra arguments" };
	}

	if (values.repo === undefined || !isRepoSlug(values.repo)) {
		return values.json !== true && command !== "serve"
			? { kind: "usage", message: "--json is required" }
			: { kind: "usage", message: "--repo <owner/name> is required" };
	}

	if (isControllerCommand(command)) {
		return parseController(command, values.repo, values);
	}

	if (values.json !== true) {
		return { kind: "usage", message: "--json is required" };
	}

	if (values.once !== undefined) {
		return {
			kind: "usage",
			message: "--once applies only to tick, and tick requires it",
		};
	}

	if (command === "admit") {
		if (values.ref !== undefined || values["reload-ref"] !== undefined) {
			return {
				kind: "usage",
				message: "admit always reads main and takes no --ref",
			};
		}

		const issues = issuesOf(values);

		if (issues === null || issues.length !== 1 || issues[0] === undefined) {
			return { kind: "usage", message: "--issue <number> is required" };
		}

		if (values["state-dir"] === undefined || values["state-dir"] === "") {
			return { kind: "usage", message: "--state-dir <dir> is required" };
		}

		return {
			kind: "admit",
			repo: values.repo,
			issue: issues[0],
			stateDir: resolve(values["state-dir"]),
		};
	}

	if (
		values.issue !== undefined ||
		(values["state-dir"] !== undefined && command !== "status")
	) {
		return {
			kind: "usage",
			message: "--issue applies only to admit, tick, run and serve",
		};
	}

	const ref = values.ref ?? TRUSTED_REF;
	const reloadRef = values["reload-ref"] ?? null;

	if (reloadRef !== null && command !== "workflow-check") {
		return {
			kind: "usage",
			message: "--reload-ref applies only to workflow-check",
		};
	}

	for (const branch of [ref, reloadRef]) {
		if (branch !== null && !isBranchName(branch)) {
			return {
				kind: "usage",
				message: "--ref and --reload-ref must be branch names",
			};
		}
	}

	const stateDir = values["state-dir"];

	return {
		kind: "workflow",
		command,
		repo: values.repo,
		ref,
		reloadRef,
		stateDir:
			stateDir === undefined || stateDir === "" ? null : resolve(stateDir),
	};
}

function parseCliArgs(argv: readonly string[]) {
	return parseArgs({
		args: [...argv],
		allowPositionals: true,
		strict: true,
		options: {
			json: { type: "boolean" },
			once: { type: "boolean" },
			repo: { type: "string" },
			ref: { type: "string" },
			"reload-ref": { type: "string" },
			issue: { type: "string", multiple: true },
			"state-dir": { type: "string" },
		},
	});
}

function redactString(_key: string, item: JsonValue): JsonValue {
	const text = String(item);

	return item === text ? redactCredentials(text) : item;
}

type ControllerView =
	| { readonly state: "unavailable"; readonly reason: string }
	| {
			readonly state: "running" | "stopped" | "stale_lock" | "unreadable_lock";
			readonly pid: number | null;
			readonly since: string | null;
			readonly lastTick: JsonValue | null;
	  };

type StatusOutput = Omit<StatusReport, "controller"> & {
	readonly controller: ControllerView;
};

type Printable =
	| StatusOutput
	| CheckReport
	| AdmissionReceipt
	| TickReport
	| { readonly error: "controller_running"; readonly pid: number | null };

function json(report: Printable): string {
	return `${JSON.stringify(report, redactString, 2)}\n`;
}

function controllerView(
	lock: SocketLockState,
	lastTick: JsonValue | null,
): ControllerView {
	const holder =
		lock.kind === "socket_bound" || lock.kind === "holder_file_without_socket"
			? lock.holderFile
			: null;

	const state = {
		none: "stopped",
		socket_bound: "running",
		holder_file_without_socket: "stale_lock",
		unreadable: "unreadable_lock",
	} as const;

	return {
		state: state[lock.kind],
		pid: holder?.pid ?? null,
		since: holder?.acquiredAt ?? null,
		lastTick,
	};
}

async function isPrivateDirectory(path: string): Promise<boolean> {
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

function realRuntime(): ControllerRuntime {
	return {
		clock: { now: () => Date.now() },
		procs: procTable(),
		sleep: async (ms, signal) => {
			await delay(ms, undefined, { signal }).catch(() => undefined);
		},
		signal: new AbortController().signal,
		executor: (context) =>
			sandboxExecutor({ ...context, xdgRuntimeDir: XDG_RUNTIME_DIR }),
	};
}

async function runController(
	parsed: Extract<Parsed, { kind: "controller" }>,
	io: CliIo,
): Promise<number> {
	const runtime = io.runtime ?? realRuntime();
	const { clock } = runtime;
	const log = lineLog(io.stderr, () => clock.now());

	if (!FACTORY_REPOSITORIES.includes(parsed.repo)) {
		log("controller_refused", { reason: "repo_not_allowed" });

		return EXIT.invalid;
	}

	if (!(await isPrivateDirectory(parsed.stateDir))) {
		log("controller_refused", { reason: "state_unavailable" });

		return EXIT.invalid;
	}

	const acquired = await acquireLock({
		stateDir: parsed.stateDir,
		procs: runtime.procs,
		now: () => clock.now(),
	});

	if (acquired.kind === "held") {
		const pid = acquired.holder?.pid ?? null;

		log("controller_running", { pid });

		if (parsed.command !== "serve") {
			io.stdout(json({ error: "controller_running", pid }));
		}

		return EXIT.usage;
	}

	if (acquired.kind === "unavailable") {
		log("controller_refused", { reason: "lock_unavailable" });

		return EXIT.invalid;
	}

	const { lock } = acquired;

	try {
		if (acquired.replaced !== null) {
			log("lock_stale_replaced", {
				pid: acquired.replaced.pid,
				since: acquired.replaced.acquiredAt,
			});
		}

		const identity = await checkIdentity(
			new GitHubTicketAdapter({ exec: io.exec, repo: parsed.repo }),
		);

		if (identity.kind !== "ok") {
			log("controller_refused", {
				reason:
					identity.kind === "mismatch"
						? "identity_mismatch"
						: "identity_unavailable",
			});

			return EXIT.invalid;
		}

		const orchestrator = new Orchestrator({
			exec: io.exec,
			env: io.env,
			repo: parsed.repo,
			store: fileAdmissionStore(parsed.stateDir),
			files: fileRunFiles(parsed.stateDir),
			executor: runtime.executor({
				stateDir: parsed.stateDir,
				exec: io.exec,
				log,
			}),
			clock,
			scope: parsed.scope,
			log,
		});

		if (parsed.command === "serve") {
			log("controller_ready", {
				pid: lock.holder.pid,
				repo: parsed.repo,
				scope: parsed.scope?.join("+") ?? "all",
			});

			await serveLoop({
				orchestrator,
				stateDir: parsed.stateDir,
				sleep: runtime.sleep,
				signal: runtime.signal,
				log,
			});

			return EXIT.ok;
		}

		const ticked = await orchestrator.tick();

		const report =
			(await orchestrator.drain((ms) =>
				runtime.sleep(ms, new AbortController().signal),
			)) ?? ticked;

		if (!(await writeStatus(parsed.stateDir, report))) {
			log("status_unwritable", {});
		}

		io.stdout(json(report));

		if (parsed.command === "tick") return EXIT.ok;

		return report.runs.some((run) => parsed.scope?.includes(run.issue))
			? EXIT.ok
			: EXIT.invalid;
	} finally {
		await lock.release();
	}
}

export async function runCli(
	argv: readonly string[],
	caller: CliIo,
): Promise<number> {
	const io: CliIo = {
		...caller,
		stderr: (text) => caller.stderr(redactCredentials(text)),
	};

	if (argv[0] === "gates") return runGatesCli(argv.slice(1), io);

	const parsed = parse(argv);

	if (parsed.kind === "usage") {
		io.stderr(`${parsed.message}\n${USAGE}\n`);

		return EXIT.usage;
	}

	if (parsed.kind === "controller") return runController(parsed, io);

	if (parsed.kind === "admit") {
		const receipt = await admitTicket({
			exec: io.exec,
			env: io.env,
			repo: parsed.repo,
			issue: parsed.issue,
			allowlist: FACTORY_REPOSITORIES,
			store: fileAdmissionStore(parsed.stateDir),
		});

		io.stdout(json(receipt));

		return receipt.decision === "admitted" ? EXIT.ok : EXIT.invalid;
	}

	const { repo, ref, reloadRef } = parsed;
	const load = await loadWorkflow({ exec: io.exec, repo, ref, env: io.env });

	if (parsed.command === "status") {
		const report = statusReport(load, manifest.version);

		const controller: ControllerView =
			parsed.stateDir === null
				? {
						state: "unavailable",
						reason: "pass --state-dir to read the controller lock",
					}
				: controllerView(
						await readLock(parsed.stateDir),
						await readStatus(parsed.stateDir),
					);

		io.stdout(json({ ...report, controller }));

		return EXIT.ok;
	}

	if (reloadRef === null) {
		io.stdout(json(checkReport(load, null)));

		return load.kind === "loaded" ? EXIT.ok : EXIT.invalid;
	}

	const next = await loadWorkflow({
		exec: io.exec,
		repo,
		ref: reloadRef,
		env: io.env,
	});

	io.stdout(json(checkReport(load, next)));

	return load.kind === "loaded" && next.kind === "loaded"
		? EXIT.ok
		: EXIT.invalid;
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
	return new Promise((done, fail) => {
		const child = execFileCallback(
			command,
			[...args],
			{
				encoding: "utf8",
				timeout: timeoutMs,
				maxBuffer: 4 * 1024 * 1024,
				killSignal: "SIGKILL",
			},
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
					stderr: timedOut ? `${command} timed out` : stderr || error.message,
					code: Number.isSafeInteger(error.code) ? Number(error.code) || 1 : 1,
				});
			},
		);
	});
}

if (import.meta.main) {
	process.env.XDG_RUNTIME_DIR ??= XDG_RUNTIME_DIR;

	const stop = new AbortController();

	for (const name of ["SIGTERM", "SIGINT"] as const) {
		process.on(name, () => stop.abort());
	}

	process.exitCode = await runCli(process.argv.slice(2), {
		exec: (command, args) => execFile(command, args, FETCH_TIMEOUT_MS),
		env: (name) => process.env[name],
		stdout: (text) => process.stdout.write(text),
		stderr: (text) => process.stderr.write(text),
		runtime: { ...realRuntime(), signal: stop.signal },
	});
}
