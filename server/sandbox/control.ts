import type { AuditDecision } from "./audit.ts";
import {
	arrayOf,
	countOf,
	fieldOf,
	hasOnlyKeys,
	type JsonObject,
	type JsonValue,
	objectOf,
	parseJson,
	textOf,
} from "./json.ts";
import { DENY_CODES, type ProxyCode } from "./policy.ts";
import type { RouteId } from "./routes.ts";

/**
 * Why the admission gate closed. The runner sends the first six; the
 * gateway adds the rest. `ceiling` is the token ceiling and `requests` the
 * model-request ceiling, which the runner sets to the stage's turn cap.
 */
export const CLOSE_REASONS = [
	"turns",
	"tokens",
	"run_tokens",
	"wall",
	"stall",
	"abort",
	"ceiling",
	"requests",
	"audit_full",
	"audit_failed",
	"control_closed",
] as const;

export type CloseReason = (typeof CLOSE_REASONS)[number];

export const FATAL_CODES = [
	"bad-arguments",
	"bad-table",
	"bad-credentials",
	"socket-exists",
	"audit-unavailable",
	"listen-failed",
] as const;

export type FatalCode = (typeof FATAL_CODES)[number];

export type ControlCommand =
	| { readonly cmd: "close"; readonly reason: CloseReason }
	| { readonly cmd: "open_route"; readonly route: RouteId }
	| { readonly cmd: "close_route"; readonly route: RouteId }
	| { readonly cmd: "drain_abort" }
	| { readonly cmd: "summary" };

export type RouteSummary = {
	readonly route: RouteId;
	readonly forwarded: number;
	readonly denied: number;
	readonly bytesIn: number;
	readonly bytesOut: number;
	readonly inputTokens: number;
	readonly outputTokens: number;
	readonly unmetered: number;
	readonly peakConcurrent: number;
};

export type UsageEvent = {
	readonly event: "usage";
	readonly route: RouteId | null;
	readonly decision: AuditDecision;
	readonly reason: ProxyCode | null;
	readonly status: number;
	readonly bytesIn: number;
	readonly bytesOut: number;
	readonly inputTokens: number | null;
	readonly outputTokens: number | null;
};

export type SummaryEvent = {
	readonly event: "summary";
	readonly gate: "open" | "closed";
	readonly modelTokens: number;
	readonly modelRequests: number;
	readonly routes: readonly RouteSummary[];
};

/** Everything the gateway tells the runner: numbers, enums and built-in or table route ids. */
export type ControlEvent =
	| { readonly event: "ready"; readonly ino: number }
	| { readonly event: "fatal"; readonly code: FatalCode }
	| { readonly event: "gate_closed"; readonly reason: CloseReason }
	| {
			readonly event: "route";
			readonly route: RouteId;
			readonly state: "open" | "closed" | "unknown";
	  }
	| UsageEvent
	| { readonly event: "drained" }
	| SummaryEvent;

const ROUTE_ID = /^[a-z][a-z0-9-]{0,31}$/;

const DECISIONS = ["forward", "deny", "error", "blocked_mid_stream"] as const;

const PROXY_CODES: readonly string[] = [
	...DENY_CODES,
	"upstream-error",
	"upstream-timeout",
];

function routeIdOf(value: JsonValue | undefined): RouteId | null {
	const text = textOf(value);

	// SAFETY: the pattern is the RouteId contract.
	return text !== null && ROUTE_ID.test(text) ? (text as RouteId) : null;
}

function enumOf<T extends string>(
	value: JsonValue | undefined,
	members: readonly T[],
): T | null {
	return members.find((member) => member === value) ?? null;
}

function proxyCodeOf(value: JsonValue | undefined): ProxyCode | null {
	const text = textOf(value);

	// SAFETY: PROXY_CODES is exactly the ProxyCode union.
	return text !== null && PROXY_CODES.includes(text)
		? (text as ProxyCode)
		: null;
}

function nullableCount(
	value: JsonValue | undefined,
): number | null | undefined {
	if (value === null) return null;

	return countOf(value) ?? undefined;
}

export function encodeCommand(command: ControlCommand): string {
	return `${JSON.stringify(command)}\n`;
}

export function encodeEvent(event: ControlEvent): string {
	return `${JSON.stringify(event)}\n`;
}

/** Parses one control command. Unknown commands or fields are `null`. */
export function parseCommand(line: string): ControlCommand | null {
	const record = objectOf(parseJson(line));
	const cmd = textOf(fieldOf(record, "cmd"));

	if (record === null) return null;

	if (cmd === "close" && hasOnlyKeys(record, ["cmd", "reason"])) {
		const reason = enumOf(fieldOf(record, "reason"), CLOSE_REASONS);

		return reason === null ? null : { cmd, reason };
	}

	if (
		(cmd === "open_route" || cmd === "close_route") &&
		hasOnlyKeys(record, ["cmd", "route"])
	) {
		const route = routeIdOf(fieldOf(record, "route"));

		return route === null ? null : { cmd, route };
	}

	if (
		(cmd === "drain_abort" || cmd === "summary") &&
		hasOnlyKeys(record, ["cmd"])
	) {
		return { cmd };
	}

	return null;
}

const SUMMARY_ROUTE_KEYS = [
	"route",
	"forwarded",
	"denied",
	"bytesIn",
	"bytesOut",
	"inputTokens",
	"outputTokens",
	"unmetered",
	"peakConcurrent",
] as const;

function parseRouteSummary(value: JsonValue | undefined): RouteSummary | null {
	const record = objectOf(value);

	if (record === null || !hasOnlyKeys(record, SUMMARY_ROUTE_KEYS)) return null;

	const route = routeIdOf(fieldOf(record, "route"));

	const counts = SUMMARY_ROUTE_KEYS.slice(1).map((key) =>
		countOf(fieldOf(record, key)),
	);

	const [
		forwarded,
		denied,
		bytesIn,
		bytesOut,
		inputTokens,
		outputTokens,
		unmetered,
		peakConcurrent,
	] = counts;

	if (
		route === null ||
		forwarded == null ||
		denied == null ||
		bytesIn == null ||
		bytesOut == null ||
		inputTokens == null ||
		outputTokens == null ||
		unmetered == null ||
		peakConcurrent == null
	) {
		return null;
	}

	return {
		route,
		forwarded,
		denied,
		bytesIn,
		bytesOut,
		inputTokens,
		outputTokens,
		unmetered,
		peakConcurrent,
	};
}

function parseSummary(record: JsonObject): SummaryEvent | null {
	if (
		!hasOnlyKeys(record, [
			"event",
			"gate",
			"modelTokens",
			"modelRequests",
			"routes",
		])
	) {
		return null;
	}

	const gate = enumOf(fieldOf(record, "gate"), ["open", "closed"] as const);
	const modelTokens = countOf(fieldOf(record, "modelTokens"));
	const modelRequests = countOf(fieldOf(record, "modelRequests"));
	const items = arrayOf(fieldOf(record, "routes"));

	if (
		gate === null ||
		modelTokens === null ||
		modelRequests === null ||
		items === null
	) {
		return null;
	}

	const routes: RouteSummary[] = [];

	for (const item of items) {
		const summary = parseRouteSummary(item);

		if (summary === null) return null;

		routes.push(summary);
	}

	return { event: "summary", gate, modelTokens, modelRequests, routes };
}

const USAGE_KEYS = [
	"event",
	"route",
	"decision",
	"reason",
	"status",
	"bytesIn",
	"bytesOut",
	"inputTokens",
	"outputTokens",
] as const;

function parseUsage(record: JsonObject): UsageEvent | null {
	if (!hasOnlyKeys(record, USAGE_KEYS)) return null;

	const rawRoute = fieldOf(record, "route");
	const route = rawRoute === null ? null : routeIdOf(rawRoute);
	const decision = enumOf(fieldOf(record, "decision"), DECISIONS);
	const rawReason = fieldOf(record, "reason");
	const reason = rawReason === null ? null : proxyCodeOf(rawReason);
	const status = countOf(fieldOf(record, "status"));
	const bytesIn = countOf(fieldOf(record, "bytesIn"));
	const bytesOut = countOf(fieldOf(record, "bytesOut"));
	const inputTokens = nullableCount(fieldOf(record, "inputTokens"));
	const outputTokens = nullableCount(fieldOf(record, "outputTokens"));

	if (
		(rawRoute !== null && route === null) ||
		decision === null ||
		(rawReason !== null && reason === null) ||
		status === null ||
		bytesIn === null ||
		bytesOut === null ||
		inputTokens === undefined ||
		outputTokens === undefined
	) {
		return null;
	}

	return {
		event: "usage",
		route,
		decision,
		reason,
		status,
		bytesIn,
		bytesOut,
		inputTokens,
		outputTokens,
	};
}

/**
 * Parses one gateway event with a fixed schema. Unknown events or fields
 * are `null`, and the runner fails the stage on `null`, so a gateway bug
 * cannot carry text into a receipt.
 */
export function parseEvent(line: string): ControlEvent | null {
	const record = objectOf(parseJson(line));
	const event = textOf(fieldOf(record, "event"));

	if (record === null) return null;

	if (event === "ready" && hasOnlyKeys(record, ["event", "ino"])) {
		const ino = countOf(fieldOf(record, "ino"));

		return ino === null ? null : { event, ino };
	}

	if (event === "fatal" && hasOnlyKeys(record, ["event", "code"])) {
		const code = enumOf(fieldOf(record, "code"), FATAL_CODES);

		return code === null ? null : { event, code };
	}

	if (event === "gate_closed" && hasOnlyKeys(record, ["event", "reason"])) {
		const reason = enumOf(fieldOf(record, "reason"), CLOSE_REASONS);

		return reason === null ? null : { event, reason };
	}

	if (event === "route" && hasOnlyKeys(record, ["event", "route", "state"])) {
		const route = routeIdOf(fieldOf(record, "route"));

		const state = enumOf(fieldOf(record, "state"), [
			"open",
			"closed",
			"unknown",
		] as const);

		return route === null || state === null ? null : { event, route, state };
	}

	if (event === "drained" && hasOnlyKeys(record, ["event"])) return { event };

	if (event === "usage") return parseUsage(record);

	if (event === "summary") return parseSummary(record);

	return null;
}
