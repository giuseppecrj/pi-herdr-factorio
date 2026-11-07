import { closeSync, fsyncSync, openSync, writeSync } from "node:fs";
import {
	countOf,
	fieldOf,
	objectOf,
	parseJson,
	textOf,
	type JsonValue,
} from "./json.ts";
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

export type RequestBound = {
	readonly inputTokens: number;
	readonly maxOutputTokens: number;
};

export type RequestUsage =
	| {
			readonly kind: "metered";
			readonly inputTokens: number;
			readonly outputTokens: number;
	  }
	| {
			readonly kind: "partial";
			readonly inputTokens: number;
			readonly outputTokens: null;
	  }
	| {
			readonly kind: "partial";
			readonly inputTokens: null;
			readonly outputTokens: number;
	  }
	| {
			readonly kind: "missing";
			readonly inputTokens: null;
			readonly outputTokens: null;
	  };

type ReplyFacts = {
	readonly status: number | null;
	readonly observedModel: JsonValue | undefined;
};

/** Normalized result facts, including legacy partial measurements. */
export type RequestReply = ReplyFacts &
	(
		| {
				readonly kind: "Unreachable";
				readonly origin: "gateway-before-headers";
				readonly usage: RequestUsage;
		  }
		| {
				readonly kind: "ProviderRejected";
				readonly completed: true;
				readonly usage: RequestUsage;
		  }
		| {
				readonly kind: "Metered";
				readonly usage: Extract<RequestUsage, { readonly kind: "metered" }>;
		  }
		| {
				readonly kind: "Unmetered";
				readonly reason: "missing-usage" | "partial-usage";
				readonly usage: Exclude<RequestUsage, { readonly kind: "metered" }>;
		  }
	);

type RequestFacts = {
	readonly req: number | null;
	readonly route: string | null;
	/** Retained only for the usability veto, which historically examines every result. */
	readonly laterResults: readonly RequestReply[];
};

/** One request's observation, independent of charging or family assurance policy. */
export type RequestSettlement = RequestFacts &
	(
		| { readonly kind: "Admitted"; readonly bound: null }
		| { readonly kind: "Dispatched"; readonly bound: RequestBound }
		| (RequestReply & { readonly bound: RequestBound | null })
		| {
				readonly kind: "Uncertain";
				readonly bound: RequestBound;
				readonly result: (RequestReply & { readonly kind: "Unmetered" }) | null;
		  }
	);

/** The first result, also when an unmetered reply retains an uncertain bound. */
export function settlementReply(
	request: RequestSettlement,
): RequestReply | null {
	switch (request.kind) {
		case "Admitted":
		case "Dispatched":
			return null;
		case "Uncertain":
			return request.result;
		default:
			return request;
	}
}

function requestUsage(
	inputTokens: number | null,
	outputTokens: number | null,
): RequestUsage {
	if (inputTokens !== null)
		return outputTokens !== null
			? { kind: "metered", inputTokens, outputTokens }
			: { kind: "partial", inputTokens, outputTokens };

	return outputTokens !== null
		? { kind: "partial", inputTokens, outputTokens }
		: { kind: "missing", inputTokens, outputTokens };
}

/**
 * Replays v1 bytes without changing their acceptance rules. Request numbers are
 * local to one gateway journal. Optional route scoping retains the family
 * reader's per-route identity while charging uses the whole journal.
 * First dispatch/result wins for charging and family; all later results remain
 * available to the conservative usability veto. Results stay in arrival order.
 * `Admitted` has only an identity observation, not proof of durable dispatch.
 */
export function requestSettlements(
	text: string,
	options: { readonly route?: string; readonly stopped?: boolean } = {},
) {
	type Replay = {
		req: number | null;
		route: string | null;
		bound: RequestBound | null;
		results: RequestReply[];
		order: number;
	};

	const requests = new Map<number | symbol, Replay>();
	const routes = new Set<string>();
	let order = 0;

	for (const line of text.split("\n")) {
		const record = objectOf(parseJson(line));
		const req = countOf(fieldOf(record, "req"));
		const route = textOf(fieldOf(record, "route"));
		const kind = fieldOf(record, "kind");

		if (record === null) continue;

		if (req !== null && route !== null) routes.add(route);

		if (options.route !== undefined && route !== options.route) continue;

		// A legacy result without a request number can prove metered presence,
		// but cannot contribute a charge, a veto or family evidence.
		if (req === null && kind !== "result") continue;

		const key = req ?? Symbol();

		const replay = requests.get(key) ?? {
			req,
			route,
			bound: null,
			results: [],
			order: Number.MAX_SAFE_INTEGER,
		};

		requests.set(key, replay);

		if (kind === "dispatch" && replay.bound === null) {
			replay.bound = {
				inputTokens: countOf(fieldOf(record, "inputTokenEstimate")) ?? 0,
				maxOutputTokens: countOf(fieldOf(record, "maxOutputTokens")) ?? 0,
			};
		}

		if (kind !== "result") continue;

		const usage = requestUsage(
			countOf(fieldOf(record, "inputTokens")),
			countOf(fieldOf(record, "outputTokens")),
		);

		const facts: ReplyFacts = {
			status: countOf(fieldOf(record, "status")),
			observedModel: fieldOf(record, "observedModel"),
		};

		const reason = fieldOf(record, "reason");

		const reply: RequestReply =
			reason === "upstream_unreachable"
				? {
						...facts,
						kind: "Unreachable",
						origin: "gateway-before-headers",
						usage,
					}
				: reason === "provider_rejected"
					? { ...facts, kind: "ProviderRejected", completed: true, usage }
					: usage.kind === "metered"
						? { ...facts, kind: "Metered", usage }
						: {
								...facts,
								kind: "Unmetered",
								usage,
								reason:
									usage.kind === "missing" ? "missing-usage" : "partial-usage",
							};

		if (replay.results.length === 0) replay.order = order++;

		replay.results.push(reply);
	}

	return {
		routes: [...routes],
		requests: [...requests.values()]
			.sort((a, b) => a.order - b.order)
			.map((replay): RequestSettlement => {
				const [result, ...laterResults] = replay.results;
				const { req, route, bound } = replay;
				const facts = { req, route, bound, laterResults };

				if (result !== undefined) {
					if (
						result.kind === "Unmetered" &&
						result.usage.kind === "missing" &&
						bound !== null &&
						bound.inputTokens + bound.maxOutputTokens > 0
					)
						return { ...facts, kind: "Uncertain", bound, result };

					return { ...facts, ...result };
				}

				if (bound === null) return { ...facts, kind: "Admitted", bound };

				return options.stopped === false
					? { ...facts, kind: "Dispatched", bound }
					: { ...facts, kind: "Uncertain", bound, result: null };
			}),
	};
}

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

export type JournalCharge = {
	readonly tokens: number;
	readonly dispatched: number;
	readonly settled: number;
	readonly unmetered: number;
	readonly uncertain: number;
	readonly uncertainTokens: number;
};

/**
 * What a journal proves: metered tokens of each settled request, once per
 * request number. A provider-rejected result that completed is charged its reported usage, or a known zero. A dispatch with
 * no result, or with an unmetered result and a positive recorded bound, is an
 * uncertain charge, so the tokens retain the recorded input-plus-output bound
 * separately. Legacy dispatches without a bound remain a floor. A line cut
 * short by a crash is skipped.
 */
export function journalCharge(text: string): JournalCharge {
	const charge = {
		tokens: 0,
		dispatched: 0,
		settled: 0,
		unmetered: 0,
		uncertain: 0,
		uncertainTokens: 0,
	};

	for (const request of requestSettlements(text).requests) {
		if (request.req === null) continue;

		const result = settlementReply(request);
		const bound = request.bound;

		const upper =
			bound === null ? 0 : bound.inputTokens + bound.maxOutputTokens;

		if (bound !== null) charge.dispatched += 1;

		if (result !== null) {
			charge.settled += 1;
			charge.tokens +=
				(result.usage.inputTokens ?? 0) + (result.usage.outputTokens ?? 0);

			if (result.usage.kind === "missing") charge.unmetered += 1;
		}

		if (
			bound !== null &&
			(result === null || (result.usage.kind === "missing" && upper > 0))
		) {
			charge.uncertain += 1;
			charge.uncertainTokens += upper;
		}
	}

	return charge;
}

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
