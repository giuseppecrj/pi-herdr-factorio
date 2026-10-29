import { createHash, randomBytes } from "node:crypto";
import { readFileSync } from "node:fs";
import {
	lstat,
	mkdir,
	open,
	readdir,
	readFile,
	realpath,
	rename,
	unlink,
} from "node:fs/promises";
import { createConnection, createServer, type Server } from "node:net";
import { join, resolve } from "node:path";
import { isRunStatus, isStage } from "../src/markers.ts";
import { isDigest } from "../src/run.ts";
import type {
	ClaimRecord,
	Log,
	LogFields,
	Orchestrator,
	RunFiles,
	TickReport,
} from "../src/orchestrator.ts";
import type { JsonValue } from "../src/tickets.ts";

export const HOLDER_FILE = "controller.lock";
export const STATUS_FILE = "status.json";

export type LockHolder = {
	readonly pid: number;
	readonly startTime: string;
	readonly acquiredAt: string;
};

export type SocketLockState =
	| { readonly kind: "none" }
	| { readonly kind: "socket_bound"; readonly holderFile: LockHolder | null }
	| {
			readonly kind: "holder_file_without_socket";
			readonly holderFile: LockHolder;
	  }
	| { readonly kind: "unreadable" };

export type LockAcquire =
	| {
			readonly kind: "acquired";
			readonly lock: ControllerLock;
			readonly replaced: LockHolder | null;
	  }
	| { readonly kind: "held"; readonly holder: LockHolder | null }
	| { readonly kind: "unavailable" };

export type ProcessTable = {
	readonly self: { readonly pid: number; readonly startTime: string };
};

/** Field 22 of `/proc/<pid>/stat`, counted after the parenthesized command name. */
export function parseStartTime(stat: string): string | null {
	const fields = stat
		.slice(stat.lastIndexOf(")") + 1)
		.trim()
		.split(/\s+/);

	const start = fields[19];

	return start !== undefined && /^\d+$/.test(start) ? start : null;
}

function readStartTime(): string | null {
	try {
		return parseStartTime(readFileSync("/proc/self/stat", "utf8"));
	} catch {
		return null;
	}
}

export function procTable(): ProcessTable {
	return { self: { pid: process.pid, startTime: readStartTime() ?? "" } };
}

/**
 * The Linux abstract Unix socket name for one state directory: a NUL byte,
 * then `pi-herdr-factorio/` and the SHA-256 of the directory's real path. The
 * kernel lets one socket bind a name and frees it when the process dies.
 */
export function lockName(realDir: string): string {
	return `\0pi-herdr-factorio/${createHash("sha256").update(realDir).digest("hex")}`;
}

function errorCode(error: Error): string | null {
	return "code" in error && error.code === String(error.code)
		? error.code
		: null;
}

function parseJson(text: string): JsonValue | undefined {
	try {
		const parsed: JsonValue = JSON.parse(text);

		return parsed;
	} catch {
		return undefined;
	}
}

function fieldOf(value: JsonValue | undefined, key: string) {
	if (
		value === undefined ||
		value === null ||
		Array.isArray(value) ||
		!(value instanceof Object)
	) {
		return undefined;
	}

	return Object.hasOwn(value, key) ? value[key] : undefined;
}

function parseHolder(text: string): LockHolder | null {
	const value = parseJson(text);
	const pid = fieldOf(value, "pid");
	const startTime = fieldOf(value, "startTime");
	const acquiredAt = fieldOf(value, "acquiredAt");

	if (
		pid !== Number(pid) ||
		!Number.isSafeInteger(pid) ||
		Number(pid) < 1 ||
		startTime !== String(startTime) ||
		!/^\d+$/.test(String(startTime)) ||
		acquiredAt !== String(acquiredAt)
	) {
		return null;
	}

	return {
		pid: Number(pid),
		startTime: String(startTime),
		acquiredAt: String(acquiredAt),
	};
}

type HolderFile =
	| { readonly kind: "absent" }
	| { readonly kind: "holder"; readonly holder: LockHolder }
	| { readonly kind: "unreadable" };

async function readHolderFile(path: string): Promise<HolderFile> {
	let text: string;

	try {
		text = await readFile(path, "utf8");
	} catch (error) {
		return (error instanceof Error ? errorCode(error) : null) === "ENOENT"
			? { kind: "absent" }
			: { kind: "unreadable" };
	}

	const holder = parseHolder(text);

	return holder === null ? { kind: "unreadable" } : { kind: "holder", holder };
}

function holderOf(file: HolderFile): LockHolder | null {
	return file.kind === "holder" ? file.holder : null;
}

async function probeName(name: string): Promise<"bound" | "free" | "unknown"> {
	return new Promise((done) => {
		const socket = createConnection({ path: name });

		socket.once("connect", () => {
			socket.destroy();
			done("bound");
		});

		socket.once("error", (error) => {
			const code = errorCode(error);

			done(code === "ECONNREFUSED" || code === "ENOENT" ? "free" : "unknown");
		});
	});
}

/** Reads the lock without taking it. `status --json` uses this. */
export async function readLock(stateDir: string): Promise<SocketLockState> {
	let real: string;

	try {
		real = await realpath(stateDir);
	} catch {
		return { kind: "unreadable" };
	}

	const probe = await probeName(lockName(real));
	const file = await readHolderFile(join(real, HOLDER_FILE));

	if (probe === "unknown") return { kind: "unreadable" };

	if (probe === "bound")
		return { kind: "socket_bound", holderFile: holderOf(file) };

	if (file.kind === "absent") return { kind: "none" };

	return file.kind === "holder"
		? { kind: "holder_file_without_socket", holderFile: file.holder }
		: { kind: "unreadable" };
}

export class ControllerLock {
	readonly path: string;
	readonly holder: LockHolder;
	readonly #server: Server;

	constructor(path: string, holder: LockHolder, server: Server) {
		this.path = path;
		this.holder = holder;
		this.#server = server;
	}

	async release(): Promise<void> {
		const file = await readHolderFile(this.path);

		if (
			file.kind === "holder" &&
			file.holder.pid === this.holder.pid &&
			file.holder.startTime === this.holder.startTime
		) {
			await unlink(this.path).catch(() => undefined);
		}

		await new Promise<void>((done) => {
			this.#server.close(() => done());
		});
	}
}

async function bind(
	server: Server,
	name: string,
): Promise<"bound" | "busy" | "failed"> {
	return new Promise((done) => {
		server.once("error", (error) => {
			done(errorCode(error) === "EADDRINUSE" ? "busy" : "failed");
		});
		server.listen({ path: name, exclusive: true }, () => done("bound"));
	});
}

/**
 * Binds the state directory's abstract socket name. Only one process can, so
 * two controllers started together never both run. A second one gets `held`.
 * The kernel frees the name when the holder dies, even by `kill -9`. Then
 * writes `<stateDir>/controller.lock` naming this process, and reports a lock
 * file a dead controller left behind as `replaced`.
 */
export async function acquireLock(input: {
	stateDir: string;
	procs: ProcessTable;
	now: () => number;
}): Promise<LockAcquire> {
	const { self } = input.procs;

	if (self.startTime === "") return { kind: "unavailable" };

	let real: string;

	try {
		real = await realpath(input.stateDir);
	} catch {
		return { kind: "unavailable" };
	}

	const path = join(real, HOLDER_FILE);
	const server = createServer((socket) => socket.destroy());
	const bound = await bind(server, lockName(real));

	if (bound === "busy") {
		return { kind: "held", holder: holderOf(await readHolderFile(path)) };
	}

	if (bound === "failed") return { kind: "unavailable" };

	server.unref();

	const left = await readHolderFile(path);

	const holder: LockHolder = {
		pid: self.pid,
		startTime: self.startTime,
		acquiredAt: new Date(input.now()).toISOString(),
	};

	if (!(await writeAtomic(path, `${JSON.stringify(holder)}\n`))) {
		await new Promise<void>((done) => {
			server.close(() => done());
		});

		return { kind: "unavailable" };
	}

	return {
		kind: "acquired",
		lock: new ControllerLock(path, holder, server),
		replaced: holderOf(left),
	};
}

function claimSeq(value: JsonValue | undefined): number | null | undefined {
	if (value === undefined || value === null) return null;

	return value === Number(value) && Number.isSafeInteger(value) && value >= 1
		? value
		: undefined;
}

function claimUsage(value: JsonValue | undefined): number | null | undefined {
	if (value === undefined || value === null) return null;

	return value === Number(value) && Number.isSafeInteger(value) && value >= 0
		? value
		: undefined;
}

type ClaimState = Pick<ClaimRecord, "status" | "stage" | "attempt">;

function claimState(value: JsonValue | undefined): ClaimState | undefined {
	const status = fieldOf(value, "status") ?? null;
	const stage = fieldOf(value, "stage") ?? null;
	const attempt = fieldOf(value, "attempt") ?? null;

	if (status === null && stage === null && attempt === null) {
		return { status, stage, attempt };
	}

	const statusText = String(status);
	const stageText = String(stage);

	return status === statusText &&
		isRunStatus(statusText) &&
		stage === stageText &&
		isStage(stageText) &&
		attempt === Number(attempt) &&
		Number.isSafeInteger(attempt) &&
		attempt >= 1
		? { status: statusText, stage: stageText, attempt }
		: undefined;
}

function parseClaim(text: string): ClaimRecord | null {
	const value = parseJson(text);
	const runId = fieldOf(value, "runId");
	const issue = fieldOf(value, "issue");
	const eventId = fieldOf(value, "eventId");
	const seq = claimSeq(fieldOf(value, "seq"));
	const state = claimState(value);
	const usage = claimUsage(fieldOf(value, "usage"));

	if (
		seq === undefined ||
		state === undefined ||
		usage === undefined ||
		(seq === null && state.status !== null) ||
		(state.status === null && usage !== null) ||
		runId !== String(runId) ||
		!isDigest(String(runId)) ||
		issue !== Number(issue) ||
		!Number.isSafeInteger(issue) ||
		Number(issue) < 1 ||
		eventId !== String(eventId) ||
		!/^[1-9][0-9]{0,19}$/.test(String(eventId))
	) {
		return null;
	}

	const id = String(runId);

	return isDigest(id)
		? {
				runId: id,
				issue: Number(issue),
				eventId: String(eventId),
				seq,
				...state,
				usage,
			}
		: null;
}

async function writeAtomic(path: string, text: string): Promise<boolean> {
	const temp = `${path}.${randomBytes(8).toString("hex")}.tmp`;

	try {
		const handle = await open(temp, "wx", 0o600);

		try {
			await handle.writeFile(text);
			await handle.sync();
		} finally {
			await handle.close();
		}

		await rename(temp, path);

		return true;
	} catch {
		await unlink(temp).catch(() => undefined);

		return false;
	}
}

/**
 * Claim records in `<stateDir>/claims/<runId>.json` and private workspaces in
 * `<stateDir>/workspaces/<runId>/`, both under directories of mode 0700.
 */
export function fileRunFiles(stateDir: string): RunFiles {
	const root = resolve(stateDir);
	const claims = join(root, "claims");
	const workspaces = join(root, "workspaces");

	const workspacePath = (runId: string) => join(workspaces, runId);

	return {
		workspacePath,

		async workspaceState(runId) {
			try {
				const info = await lstat(workspacePath(runId));

				return info.isDirectory() ? "present" : "unavailable";
			} catch (error) {
				return (error instanceof Error ? errorCode(error) : null) === "ENOENT"
					? "missing"
					: "unavailable";
			}
		},

		async ensureWorkspace(runId) {
			try {
				await mkdir(workspaces, { recursive: true, mode: 0o700 });
				await mkdir(workspacePath(runId), { mode: 0o700 });

				return "created";
			} catch (error) {
				if ((error instanceof Error ? errorCode(error) : null) !== "EEXIST")
					return "unavailable";
			}

			const info = await lstat(workspacePath(runId)).catch(() => null);

			return info?.isDirectory() === true ? "present" : "unavailable";
		},

		async listClaims() {
			let names: string[];

			try {
				names = await readdir(claims);
			} catch {
				return [];
			}

			const records: ClaimRecord[] = [];

			for (const name of names.filter((entry) => entry.endsWith(".json"))) {
				const text = await readFile(join(claims, name), "utf8").catch(() => "");

				const claim = parseClaim(text);

				if (claim !== null && `${claim.runId}.json` === name) {
					records.push(claim);
				}
			}

			return records;
		},

		async writeClaim(claim) {
			try {
				await mkdir(claims, { recursive: true, mode: 0o700 });
			} catch {
				return false;
			}

			return writeAtomic(
				join(claims, `${claim.runId}.json`),
				`${JSON.stringify(claim)}\n`,
			);
		},
	};
}

/** Writes the last tick's report for `status --json`. */
export async function writeStatus(
	stateDir: string,
	report: TickReport,
): Promise<boolean> {
	return writeAtomic(
		join(resolve(stateDir), STATUS_FILE),
		`${JSON.stringify(report, null, 2)}\n`,
	);
}

export async function readStatus(stateDir: string): Promise<JsonValue | null> {
	const text = await readFile(
		join(resolve(stateDir), STATUS_FILE),
		"utf8",
	).catch(() => null);

	return text === null ? null : (parseJson(text) ?? null);
}

const LOG_VALUE = /^[A-Za-z0-9:._@/[\]+-]*$/;

/** One structured log line: `at=<time> event=<name> key=value ...`. */
export function logLine(at: number, event: string, fields: LogFields): string {
	const parts = [`at=${new Date(at).toISOString()}`, `event=${event}`];

	for (const [key, value] of Object.entries(fields)) {
		const text = String(value);

		parts.push(`${key}=${LOG_VALUE.test(text) ? text : "(withheld)"}`);
	}

	return `${parts.join(" ")}\n`;
}

export function lineLog(write: (text: string) => void, now: () => number): Log {
	return (event, fields) => write(logLine(now(), event, fields));
}

/** Resolves after `ms`, or as soon as `signal` aborts. */
export type Sleep = (ms: number, signal: AbortSignal) => Promise<void>;

/**
 * Runs ticks until `signal` aborts. A stop request lets the current tick
 * finish, so the caller releases the lock only between ticks.
 */
export async function serveLoop(input: {
	orchestrator: Orchestrator;
	stateDir: string;
	sleep: Sleep;
	signal: AbortSignal;
	log: Log;
}): Promise<void> {
	const { orchestrator, signal, log } = input;

	while (!signal.aborted) {
		const report = await orchestrator.tick();

		if (!(await writeStatus(input.stateDir, report))) {
			log("status_unwritable", {});
		}

		if (signal.aborted) break;

		await input.sleep(orchestrator.pollIntervalMs, signal);
	}

	log("controller_stopping", {});
}
