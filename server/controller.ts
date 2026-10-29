import { randomBytes } from "node:crypto";
import { readFileSync } from "node:fs";
import {
	lstat,
	mkdir,
	open,
	readdir,
	readFile,
	rename,
	unlink,
} from "node:fs/promises";
import { join, resolve } from "node:path";
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

export const LOCK_FILE = "controller.lock";
export const STATUS_FILE = "status.json";

/** Who holds the controller lock: a pid and that process's start time, so a reused pid is not mistaken for the holder. */
export type LockHolder = {
	readonly pid: number;
	readonly startTime: string;
	readonly acquiredAt: string;
};

export type LockState =
	| { readonly kind: "none" }
	| { readonly kind: "live"; readonly holder: LockHolder }
	| { readonly kind: "stale"; readonly holder: LockHolder }
	| { readonly kind: "unreadable" };

export type LockAcquire =
	| {
			readonly kind: "acquired";
			readonly lock: ControllerLock;
			readonly replaced: LockHolder | null;
	  }
	| { readonly kind: "held"; readonly holder: LockHolder }
	| { readonly kind: "unavailable" };

/** Reads process start times. The real one reads `/proc/<pid>/stat`. */
export type ProcessTable = {
	readonly self: { readonly pid: number; readonly startTime: string };
	startTimeOf(pid: number): string | null;
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

function readStartTime(pid: number | "self"): string | null {
	try {
		return parseStartTime(readFileSync(`/proc/${pid}/stat`, "utf8"));
	} catch {
		return null;
	}
}

export function procTable(): ProcessTable {
	return {
		self: { pid: process.pid, startTime: readStartTime("self") ?? "" },
		startTimeOf: (pid) => readStartTime(pid),
	};
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

/** Reads the lock without taking it. `status --json` uses this. */
export async function readLock(
	stateDir: string,
	procs: ProcessTable,
): Promise<LockState> {
	let text: string;

	try {
		text = await readFile(join(resolve(stateDir), LOCK_FILE), "utf8");
	} catch (error) {
		return (error instanceof Error ? errorCode(error) : null) === "ENOENT"
			? { kind: "none" }
			: { kind: "unreadable" };
	}

	const holder = parseHolder(text);

	if (holder === null) return { kind: "unreadable" };

	return procs.startTimeOf(holder.pid) === holder.startTime
		? { kind: "live", holder }
		: { kind: "stale", holder };
}

/** The held lock. `release` removes the file only while it still names this process. */
export class ControllerLock {
	readonly path: string;
	readonly holder: LockHolder;

	constructor(path: string, holder: LockHolder) {
		this.path = path;
		this.holder = holder;
	}

	async release(): Promise<void> {
		const text = await readFile(this.path, "utf8").catch(() => "");
		const holder = parseHolder(text);

		if (
			holder?.pid === this.holder.pid &&
			holder.startTime === this.holder.startTime
		) {
			await unlink(this.path).catch(() => undefined);
		}
	}
}

async function createLock(
	path: string,
	holder: LockHolder,
): Promise<"created" | "exists" | "failed"> {
	try {
		const handle = await open(path, "wx", 0o600);

		try {
			await handle.writeFile(`${JSON.stringify(holder)}\n`);
			await handle.sync();
		} finally {
			await handle.close();
		}

		return "created";
	} catch (error) {
		return (error instanceof Error ? errorCode(error) : null) === "EEXIST"
			? "exists"
			: "failed";
	}
}

/**
 * Takes `<stateDir>/controller.lock` with `O_EXCL`. A lock whose pid is gone,
 * or now names a process with another start time, is stale: it is reported
 * and replaced. A live lock is never broken.
 */
export async function acquireLock(input: {
	stateDir: string;
	procs: ProcessTable;
	now: () => number;
}): Promise<LockAcquire> {
	const path = join(resolve(input.stateDir), LOCK_FILE);
	const { self } = input.procs;

	if (self.startTime === "") return { kind: "unavailable" };

	const holder: LockHolder = {
		pid: self.pid,
		startTime: self.startTime,
		acquiredAt: new Date(input.now()).toISOString(),
	};

	const first = await createLock(path, holder);

	if (first === "created") {
		return {
			kind: "acquired",
			lock: new ControllerLock(path, holder),
			replaced: null,
		};
	}

	if (first === "failed") return { kind: "unavailable" };

	const existing = await readLock(input.stateDir, input.procs);

	if (existing.kind === "live")
		return { kind: "held", holder: existing.holder };

	if (existing.kind !== "stale") return { kind: "unavailable" };

	await unlink(path).catch(() => undefined);

	const second = await createLock(path, holder);

	if (second === "created") {
		return {
			kind: "acquired",
			lock: new ControllerLock(path, holder),
			replaced: existing.holder,
		};
	}

	const winner = await readLock(input.stateDir, input.procs);

	return winner.kind === "live"
		? { kind: "held", holder: winner.holder }
		: { kind: "unavailable" };
}

function parseClaim(text: string): ClaimRecord | null {
	const value = parseJson(text);
	const runId = fieldOf(value, "runId");
	const issue = fieldOf(value, "issue");
	const eventId = fieldOf(value, "eventId");

	if (
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
		? { runId: id, issue: Number(issue), eventId: String(eventId) }
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

		async removeClaim(runId) {
			await unlink(join(claims, `${runId}.json`)).catch(() => undefined);
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
