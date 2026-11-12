import { readFileSync } from "node:fs";
import { realpath, unlink } from "node:fs/promises";
import { createServer, type Server } from "node:net";
import { join } from "node:path";
import {
	errorCode,
	HOLDER_FILE,
	holderOf,
	type LockHolder,
	lockName,
	readHolderFile,
	writeAtomic,
} from "./state.ts";

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
