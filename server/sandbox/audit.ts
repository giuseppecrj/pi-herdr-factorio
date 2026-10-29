import { closeSync, openSync, writeSync } from "node:fs";
import type { ProxyCode } from "./policy.ts";
import type { CredentialId, RouteId } from "./routes.ts";

export type AuditDecision = "forward" | "deny" | "error" | "blocked_mid_stream";

export type AuditUpstream = {
	readonly host: string;
	readonly sni: string | null;
	readonly port: number;
	readonly addr: string | null;
	readonly tls: string | null;
};

/** One request. Only numbers, enums, fixed ids and sanitised path text. */
export type AuditRecord = {
	readonly v: 1;
	readonly ts: string;
	readonly stage: string;
	readonly runId: string;
	readonly attempt: number;
	readonly req: number;
	readonly route: RouteId | null;
	readonly method: string;
	readonly path: string;
	readonly upstream: AuditUpstream | null;
	readonly status: number;
	readonly bytesIn: number;
	readonly bytesOut: number;
	readonly durationMs: number;
	readonly credential: CredentialId | null;
	readonly decision: AuditDecision;
	readonly reason: ProxyCode | null;
	readonly gate: "open" | "closed";
	readonly inputTokens: number | null;
	readonly outputTokens: number | null;
};

export const AUDIT_CAP_BYTES = 32 * 1024 * 1024;

const PATH_MAX = 128;

/**
 * The path as logged: the query becomes `?…`, the path is cut to 128 bytes,
 * and every byte outside `[A-Za-z0-9._~/%-]` becomes `_`.
 */
export function redactPath(target: string): string {
	const question = target.indexOf("?");
	const path = question === -1 ? target : target.slice(0, question);
	const safe = path.replace(/[^A-Za-z0-9._~/%-]/g, "_").slice(0, PATH_MAX);

	return question === -1 ? safe : `${safe}?…`;
}

export function redactMethod(method: string): string {
	return method.replace(/[^A-Z]/g, "_").slice(0, 16);
}

export function auditLine(record: AuditRecord): string {
	return `${JSON.stringify(record)}\n`;
}

/**
 * A size-capped append-only audit file. A failed write or a full file makes
 * the log unhealthy, and the gateway forwards nothing while it is unhealthy.
 */
export class AuditLog {
	readonly #write: (text: string) => void;
	readonly #cap: number;
	#bytes = 0;
	#failed = false;
	#full = false;

	constructor(write: (text: string) => void, capBytes: number) {
		this.#write = write;
		this.#cap = capBytes;
	}

	get full(): boolean {
		return this.#full;
	}

	healthy(): boolean {
		return !this.#failed && !this.#full;
	}

	append(record: AuditRecord): boolean {
		if (!this.healthy()) return false;

		const line = auditLine(record);
		const size = Buffer.byteLength(line);

		if (this.#bytes + size > this.#cap) {
			this.#full = true;

			return false;
		}

		try {
			this.#write(line);
			this.#bytes += size;

			return true;
		} catch {
			this.#failed = true;

			return false;
		}
	}
}

export type AuditFile = { readonly log: AuditLog; close(): void };

/** Opens a new audit file, mode 0600. An existing file is an error, never reused. */
export function openAuditFile(path: string, capBytes: number): AuditFile {
	const fd = openSync(path, "wx", 0o600);

	return {
		log: new AuditLog((text) => {
			writeSync(fd, text);
		}, capBytes),
		close: () => closeSync(fd),
	};
}
