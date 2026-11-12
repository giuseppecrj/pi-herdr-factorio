import { closeSync, fsyncSync, openSync, writeSync } from "node:fs";
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
	/** The bare model id the Anthropic meter observed. Absent otherwise. */
	readonly observedModel?: string;
};

type JournalIdentity = {
	readonly v: 1;
	readonly ts: string;
	readonly stage: string;
	readonly runId: string;
	readonly attempt: number;
	readonly req: number;
	readonly route: RouteId;
};

/**
 * One model request in the synced journal: a `dispatch` before anything goes
 * upstream, and a `result` once it ends. Only ids, counters and metering. A
 * provider's non-2xx status at the headers, on a response that completed, is `provider_rejected`, metered at its reported usage or zero.
 * An `error` the gateway answered itself, before any upstream response
 * headers arrived (connection or DNS failure, or a timeout before headers),
 * is `upstream_unreachable`. It never appears once a response has started,
 * and it does not change the charge. Older journals lack it.
 */
export type JournalRecord =
	| (JournalIdentity & {
			readonly kind: "dispatch";
			readonly inputTokenEstimate?: number;
			readonly maxOutputTokens?: number;
	  })
	| (JournalIdentity & {
			readonly kind: "result";
			readonly status: number;
			readonly decision: AuditDecision;
			readonly reason?: "provider_rejected" | "upstream_unreachable";
			readonly inputTokens: number | null;
			readonly outputTokens: number | null;
			/**
			 * `message_start.message.model` as the edge reported it, present only
			 * when the Anthropic meter metered the reply. `journalCharge` never reads it.
			 */
			readonly observedModel?: string;
	  });

export type JournalSink = {
	readonly write: (text: string) => void;
	readonly sync: () => void;
};

/** The journal beside an audit file: `egress.jsonl` keeps `egress.requests.jsonl`. */
function journalPath(auditPath: string): string {
	return `${auditPath.replace(/\.jsonl$/, "")}.requests.jsonl`;
}

/** The journal's name beside an execution's `egress.jsonl`. */
export const JOURNAL_FILE = "egress.requests.jsonl";

export const AUDIT_CAP_BYTES = 32 * 1024 * 1024;

const PATH_MAX = 128;

/** The whole logged path when a request carried a secret or its path cannot be kept. */
export const REDACTED_PATH = "[redacted]";

/** One logged path segment that held a loaded secret. */
export const REDACTED_SEGMENT = "~redacted~";

/** The path with `%XX` escapes decoded and every `/` and `\` removed. */
function joinedPath(path: string): string {
	return path
		.replace(/%([0-9A-Fa-f]{2})/g, (_, hex: string) =>
			String.fromCharCode(Number.parseInt(hex, 16)),
		)
		.replace(/[/\\]/g, "");
}

/**
 * The path as logged: the query becomes `?…`, every segment `isSecret`
 * flags becomes `~redacted~`, the path is cut to 128 bytes, and every byte
 * outside `[A-Za-z0-9._~/%-]` becomes `_`. When a secret shows only once
 * the path is decoded and its separators removed, as when a `/` or `%2f`
 * splits it, the whole path becomes `[redacted]`; the gateway logs the
 * route's template instead.
 */
export function redactPath(
	target: string,
	isSecret: (text: string) => boolean = () => false,
): string {
	const question = target.indexOf("?");
	const path = question === -1 ? target : target.slice(0, question);

	const kept = path
		.split("/")
		.map((segment) => (isSecret(segment) ? REDACTED_SEGMENT : segment))
		.join("/");

	if (isSecret(kept) || isSecret(joinedPath(kept))) return REDACTED_PATH;

	const safe = kept.replace(/[^A-Za-z0-9._~/%-]/g, "_").slice(0, PATH_MAX);

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
	readonly #journal: JournalSink;
	#bytes = 0;
	#journalBytes = 0;
	#failed = false;
	#full = false;

	constructor(
		write: (text: string) => void,
		capBytes: number,
		journal: JournalSink,
	) {
		this.#write = write;
		this.#cap = capBytes;
		this.#journal = journal;
	}

	/** Appends one journal record and syncs it to disk; false leaves the log unhealthy. */
	journal(record: JournalRecord): boolean {
		if (!this.healthy()) return false;

		const line = `${JSON.stringify(record)}\n`;
		const size = Buffer.byteLength(line);

		if (this.#journalBytes + size > this.#cap) {
			this.#full = true;

			return false;
		}

		try {
			this.#journal.write(line);
			this.#journal.sync();
			this.#journalBytes += size;

			return true;
		} catch {
			this.#failed = true;

			return false;
		}
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

/**
 * Opens a new audit file and its request journal beside it, both mode 0600.
 * An existing file is an error, never reused.
 */
export function openAuditFile(path: string, capBytes: number): AuditFile {
	const fd = openSync(path, "wx", 0o600);
	let journal: number;

	try {
		journal = openSync(journalPath(path), "wx", 0o600);
	} catch (error) {
		closeSync(fd);
		throw error;
	}

	return {
		log: new AuditLog(
			(text) => {
				writeSync(fd, text);
			},
			capBytes,
			{
				write: (text) => {
					writeSync(journal, text);
				},
				sync: () => fsyncSync(journal),
			},
		),
		close: () => {
			closeSync(fd);
			closeSync(journal);
		},
	};
}
