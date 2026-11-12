import { createHash } from "node:crypto";
import { readFile, realpath } from "node:fs/promises";
import { createConnection } from "node:net";
import { join, resolve } from "node:path";
import { regularText } from "../../src/contract/artifacts.ts";
import {
	fieldOf,
	objectOf,
	parseJson,
	type JsonValue,
} from "../../src/core/json.ts";
import type { Verdict } from "../../src/core/run.ts";

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

/**
 * The Linux abstract Unix socket name for one state directory: a NUL byte,
 * then `pi-herdr-factorio/` and the SHA-256 of the directory's real path. The
 * kernel lets one socket bind a name and frees it when the process dies.
 */
export function lockName(realDir: string): string {
	return `\0pi-herdr-factorio/${createHash("sha256").update(realDir).digest("hex")}`;
}

export function errorCode(error: Error): string | null {
	return "code" in error && error.code === String(error.code)
		? error.code
		: null;
}

function parseHolder(text: string): LockHolder | null {
	const value = objectOf(parseJson(text));
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

export type HolderFile =
	| { readonly kind: "absent" }
	| { readonly kind: "holder"; readonly holder: LockHolder }
	| { readonly kind: "unreadable" };

export async function readHolderFile(path: string): Promise<HolderFile> {
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

export function holderOf(file: HolderFile): LockHolder | null {
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

export function readStoredVerdict(path: string): Verdict {
	try {
		// SAFETY: controller-private write-once verdict; callers verify artifact bindings before reuse.
		return JSON.parse(regularText(path, 1024 * 1024)) as Verdict;
	} catch {
		throw new Error("stored_verdict_invalid");
	}
}

export async function readStatus(stateDir: string): Promise<JsonValue | null> {
	const text = await readFile(
		join(resolve(stateDir), STATUS_FILE),
		"utf8",
	).catch(() => null);

	return text === null ? null : (parseJson(text) ?? null);
}
