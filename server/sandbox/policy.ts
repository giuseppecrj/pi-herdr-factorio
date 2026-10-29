import {
	arrayOf,
	fieldOf,
	hasDuplicateKey,
	type JsonValue,
	numberOf,
	objectOf,
	parseJson,
} from "./json.ts";
import {
	type BodyRule,
	type JsonConstraint,
	type JsonScalar,
	METHODS,
	type PathRule,
	type QueryRule,
	type Route,
	type RouteId,
	type RouteTable,
} from "./routes.ts";

/** The closed set of reasons the gateway refuses a request. Adding one is a code change. */
export const DENY_CODES = [
	"bad-request",
	"method-forbidden",
	"bad-request-target",
	"ambiguous-path",
	"bad-host",
	"forbidden-header",
	"no-route",
	"route-closed",
	"budget-closed",
	"rate-limited",
	"method-not-allowed",
	"path-not-allowed",
	"query-not-allowed",
	"body-too-large",
	"body-not-allowed",
	"upstream-address-refused",
	"secret-in-request",
	"redirect-refused",
	"response-blocked",
	"audit-unavailable",
] as const;

export type DenyCode = (typeof DENY_CODES)[number];

export type ProxyCode = DenyCode | "upstream-error" | "upstream-timeout";

/**
 * The fixed body for a refusal. It names only the code. The budget code also
 * says `out of budget`, which Pi treats as a non-retryable provider error.
 */
export function denyBody(code: ProxyCode): string {
	return code === "budget-closed"
		? "factory-gateway: denied: budget-closed: out of budget\n"
		: `factory-gateway: denied: ${code}\n`;
}

export type RequestHead = {
	readonly method: string;
	readonly target: string;
	readonly rawHeaders: readonly string[];
};

export interface AdmissionState {
	routeOpen(id: RouteId): boolean;
	gateOpen(): boolean;
	rateOk(id: RouteId): boolean;
}

export type HeadDecision =
	| {
			readonly kind: "deny";
			readonly code: DenyCode;
			readonly route: Route | null;
	  }
	| {
			readonly kind: "admit";
			readonly route: Route;
			readonly upstreamPath: string;
			readonly contentType: string | null;
	  };

const FORBIDDEN_HEADER =
	/^(x-forwarded-.*|forwarded|x-original-.*|x-host|x-rewrite-url|x-http-method-override|proxy-.*|upgrade)$/;

const PATH_CHARS = /^\/[A-Za-z0-9._~!$&'()*+,;=:@%/-]*$/;

const QUERY_CHARS = /^[A-Za-z0-9._~!$&'()*+,;=:@%/?-]*$/;

function headerValues(rawHeaders: readonly string[], name: string): string[] {
	const values: string[] = [];

	for (let index = 0; index + 1 < rawHeaders.length; index += 2) {
		const key = rawHeaders[index];
		const value = rawHeaders[index + 1];

		if (
			key !== undefined &&
			value !== undefined &&
			key.toLowerCase() === name
		) {
			values.push(value);
		}
	}

	return values;
}

function headerNames(rawHeaders: readonly string[]): string[] {
	return rawHeaders.flatMap((entry, index) =>
		index % 2 === 0 ? [entry.toLowerCase()] : [],
	);
}

function decoded(text: string): string | null {
	try {
		return decodeURIComponent(text);
	} catch {
		return null;
	}
}

/** True when a raw path is not in canonical form. The gateway never decodes and re-matches. */
export function ambiguousPath(path: string): boolean {
	if (!PATH_CHARS.test(path) || path.startsWith("//")) return true;

	if (path.toLowerCase().includes("%25")) return true;

	const plain = decoded(path);

	if (plain === null) return true;

	if (
		plain.includes("\\") ||
		plain.includes("//") ||
		[...plain].some(
			(char) => char.charCodeAt(0) < 0x21 || char.charCodeAt(0) === 0x7f,
		)
	) {
		return true;
	}

	return [path, plain].some((form) =>
		form.split("/").some((segment) => segment === "." || segment === ".."),
	);
}

export function pathMatches(rule: PathRule, relative: string): boolean {
	if (rule.kind === "exact") return relative === rule.path;

	if (rule.kind === "prefix") {
		return relative === rule.prefix || relative.startsWith(`${rule.prefix}/`);
	}

	const pattern = rule.pattern.split("/");
	const segments = relative.split("/");

	for (const [index, part] of pattern.entries()) {
		if (part === "**") {
			return segments.length > index && segments.slice(index).join("/") !== "";
		}

		const segment = segments[index];

		if (segment === undefined || segment === "") return false;

		if (part !== "*" && part !== segment) return false;
	}

	return segments.length === pattern.length;
}

function queryAllowed(rule: QueryRule, query: string | null): boolean {
	if (query === null) return true;

	if (rule.kind === "none" || !QUERY_CHARS.test(query)) return false;

	const seen = new Set<string>();

	for (const pair of query.split("&")) {
		const separator = pair.indexOf("=");

		if (separator < 1) return false;

		const key = pair.slice(0, separator);
		const value = decoded(pair.slice(separator + 1));

		if (
			!rule.allow.includes(key) ||
			seen.has(key) ||
			value === null ||
			Buffer.byteLength(value) > rule.maxValueBytes
		) {
			return false;
		}

		seen.add(key);
	}

	return true;
}

function routeFor(table: RouteTable, path: string): Route | null {
	let best: Route | null = null;

	for (const route of table.routes) {
		if (
			path.startsWith(route.prefix) &&
			(best === null || route.prefix.length > best.prefix.length)
		) {
			best = route;
		}
	}

	return best;
}

function deny(code: DenyCode, route: Route | null = null): HeadDecision {
	return { kind: "deny", code, route };
}

/**
 * Every check that needs only the request line and headers, in the order
 * the design fixes: global checks, route lookup, route and gate state, then
 * the route's own rules. The first failure decides.
 */
export function decideHead(
	head: RequestHead,
	table: RouteTable,
	state: AdmissionState,
	containsSecret: (text: string) => boolean,
): HeadDecision {
	const method = METHODS.find((known) => known === head.method);

	if (method === undefined) return deny("method-forbidden");

	if (!head.target.startsWith("/")) return deny("bad-request-target");

	const hash = head.target.indexOf("#");
	const question = head.target.indexOf("?");
	const path = question === -1 ? head.target : head.target.slice(0, question);
	const query = question === -1 ? null : head.target.slice(question + 1);

	if (hash !== -1 || ambiguousPath(path)) return deny("ambiguous-path");

	const hosts = headerValues(head.rawHeaders, "host");

	if (hosts.length !== 1 || hosts[0] !== table.forwarderHost) {
		return deny("bad-host");
	}

	if (
		headerNames(head.rawHeaders).some((name) => FORBIDDEN_HEADER.test(name))
	) {
		return deny("forbidden-header");
	}

	if (
		containsSecret(head.target) ||
		head.rawHeaders.some((entry) => containsSecret(entry))
	) {
		return deny("secret-in-request");
	}

	const route = routeFor(table, path);

	if (route === null) return deny("no-route");

	if (!state.routeOpen(route.id)) return deny("route-closed", route);

	if (route.budget && !state.gateOpen()) return deny("budget-closed", route);

	if (!state.rateOk(route.id)) return deny("rate-limited", route);

	if (!route.methods.includes(method)) return deny("method-not-allowed", route);

	const relative = path.slice(route.prefix.length);

	if (!route.paths.some((rule) => pathMatches(rule, relative))) {
		return deny("path-not-allowed", route);
	}

	if (!queryAllowed(route.query, query))
		return deny("query-not-allowed", route);

	const lengths = headerValues(head.rawHeaders, "content-length");
	const declared = lengths.length === 1 ? Number(lengths[0]) : 0;

	if (lengths.length > 1 || !Number.isSafeInteger(declared) || declared < 0) {
		return deny("body-not-allowed", route);
	}

	if (declared > route.limits.maxRequestBytes)
		return deny("body-too-large", route);

	const chunked = headerValues(head.rawHeaders, "transfer-encoding").length > 0;

	if (chunked && route.body.kind === "none")
		return deny("body-not-allowed", route);

	const contentTypes = headerValues(head.rawHeaders, "content-type");

	return {
		kind: "admit",
		route,
		upstreamPath: `${route.upstream.basePath}${relative}${query === null ? "" : `?${query}`}`,
		contentType: contentTypes.length === 1 ? (contentTypes[0] ?? null) : null,
	};
}

function mediaType(contentType: string | null): string | null {
	if (contentType === null) return null;

	return contentType.split(";")[0]?.trim().toLowerCase() ?? null;
}

function resolvePointer(
	root: JsonValue,
	pointer: string,
): JsonValue | undefined {
	let current: JsonValue | undefined = root;

	for (const token of pointer.slice(1).split("/")) {
		const items = arrayOf(current);

		current =
			items === null
				? fieldOf(objectOf(current), token)
				: /^(0|[1-9][0-9]*)$/.test(token)
					? items[Number(token)]
					: undefined;

		if (current === undefined) return undefined;
	}

	return current;
}

function scalarIn(
	value: JsonValue | undefined,
	values: readonly JsonScalar[],
): boolean {
	return values.some((allowed) => allowed === value);
}

function constraintHolds(root: JsonValue, constraint: JsonConstraint): boolean {
	const value = resolvePointer(root, constraint.pointer);

	if (constraint.kind === "absent") return value === undefined;

	if (constraint.kind === "one_of") return scalarIn(value, constraint.values);

	if (constraint.kind === "at_most") {
		if (value === undefined) return true;

		const number = numberOf(value);

		return number !== null && number <= constraint.value;
	}

	if (value === undefined) return true;

	const items = arrayOf(value);

	return (
		items !== null &&
		items.every((item) =>
			scalarIn(fieldOf(objectOf(item), constraint.field), constraint.values),
		)
	);
}

function bodyHolds(
	rule: BodyRule,
	contentType: string | null,
	body: Buffer,
): boolean {
	if (body.length === 0) return true;

	if (rule.kind === "none") return false;

	const type = mediaType(contentType);

	if (type === null || !rule.contentTypes.includes(type)) return false;

	if (rule.kind === "opaque") return true;

	const text = body.toString("utf8");
	const parsed = parseJson(text);

	if (parsed === undefined || objectOf(parsed) === null) return false;

	if (hasDuplicateKey(text)) return false;

	return rule.constraints.every((constraint) =>
		constraintHolds(parsed, constraint),
	);
}

/** The body checks that run once the whole request body is buffered. */
export function checkBody(
	route: Route,
	contentType: string | null,
	body: Buffer,
): DenyCode | null {
	if (route.body.kind === "none" && body.length > 0) return "body-not-allowed";

	if (body.length > route.limits.maxRequestBytes) return "body-too-large";

	return bodyHolds(route.body, contentType, body) ? null : "body-not-allowed";
}
