import { isIP } from "node:net";
import {
	EXE_DEV_PLATFORM,
	type PlatformNetwork,
	platformDefect,
} from "../../src/platform.ts";
import {
	arrayOf,
	boolOf,
	countOf,
	fieldOf,
	hasOnlyKeys,
	type JsonObject,
	type JsonValue,
	numberOf,
	objectOf,
	textOf,
	textsOf,
} from "../../src/core/json.ts";

export type RouteId = string & { readonly __brand: "RouteId" };

export type CredentialId = string & { readonly __brand: "CredentialId" };

export const METHODS = [
	"GET",
	"HEAD",
	"POST",
	"PUT",
	"PATCH",
	"DELETE",
	"OPTIONS",
] as const;

export type Method = (typeof METHODS)[number];

export type PathRule =
	| { readonly kind: "exact"; readonly path: string }
	| { readonly kind: "prefix"; readonly prefix: string }
	| { readonly kind: "glob"; readonly pattern: string };

export type QueryRule =
	| { readonly kind: "none" }
	/** No query, or a query string equal to one of `values`. */
	| { readonly kind: "exact"; readonly values: readonly string[] }
	| {
			readonly kind: "keys";
			readonly allow: readonly string[];
			readonly maxValueBytes: number;
	  };

export type JsonScalar = string | number | boolean;

export type JsonConstraint =
	| {
			readonly kind: "one_of";
			readonly pointer: string;
			readonly values: readonly JsonScalar[];
	  }
	| { readonly kind: "absent"; readonly pointer: string }
	| {
			readonly kind: "at_most";
			readonly pointer: string;
			readonly value: number;
	  }
	| {
			readonly kind: "each_one_of";
			readonly pointer: string;
			readonly field: string;
			readonly values: readonly JsonScalar[];
	  }
	/** Every item is an object holding all of `required` and no key outside `allowed`. */
	| {
			readonly kind: "each_keys";
			readonly pointer: string;
			readonly required: readonly string[];
			readonly allowed: readonly string[];
	  };

export type BodyRule =
	| { readonly kind: "none" }
	| { readonly kind: "opaque"; readonly contentTypes: readonly string[] }
	| {
			readonly kind: "json";
			readonly contentTypes: readonly string[];
			readonly constraints: readonly JsonConstraint[];
	  };

export type UpstreamAddress =
	| { readonly kind: "resolve" }
	| { readonly kind: "pinned"; readonly ip: string };

export type Upstream = {
	readonly scheme: "https" | "http";
	readonly host: string;
	readonly port: number;
	readonly basePath: string;
	readonly hostHeader: string;
	readonly sni: string;
	readonly address: UpstreamAddress;
};

export type Limits = {
	readonly maxRequestBytes: number;
	readonly maxResponseBytes: number;
	readonly headersTimeoutMs: number;
	readonly idleTimeoutMs: number;
	readonly totalTimeoutMs: number;
	readonly perMinute: number;
	readonly maxConcurrent: number;
};

export type CredentialPlacement =
	| {
			readonly kind: "header";
			readonly name: string;
			readonly scheme: "Bearer" | "Token" | null;
	  }
	| { readonly kind: "basic"; readonly username: string };

export type CredentialRef = {
	readonly id: CredentialId;
	readonly placement: CredentialPlacement;
};

export const METERS = [
	"openai-responses-sse",
	"anthropic-messages-sse",
] as const;

export type Meter = (typeof METERS)[number];

export type Route = {
	readonly id: RouteId;
	readonly prefix: string;
	readonly upstream: Upstream;
	readonly methods: readonly Method[];
	readonly paths: readonly PathRule[];
	readonly query: QueryRule;
	readonly body: BodyRule;
	readonly requestHeaders: readonly string[];
	readonly responseHeaders: readonly string[];
	readonly limits: Limits;
	readonly credential: CredentialRef | null;
	readonly budget: boolean;
	readonly audit: "standard" | "detailed";
	readonly initially: "open" | "closed";
	readonly meter: Meter | null;
};

export type RouteTable = {
	readonly version: 1;
	readonly stage: string;
	readonly runId: string;
	readonly attempt: number;
	readonly forwarderHost: string;
	readonly routes: readonly Route[];
	readonly ceiling: {
		readonly modelTokens: number;
		readonly modelRequests: number;
	};
};

/**
 * `production` is the only mode the runner uses. `test` also admits plain
 * http, pinned addresses and uncredentialed routes that are not built in, so
 * a host-side echo fixture can stand in for an upstream.
 */
export type TableMode = "production" | "test";

export const FORWARDER_PORT = 18080;

export const FORWARDER_HOST = `127.0.0.1:${FORWARDER_PORT}`;

/** The exe-dev model host, kept for test imports. Routes read the platform. */
export const MODEL_HOST = EXE_DEV_PLATFORM.modelHost;

export const NPM_HOST = "registry.npmjs.org";

export const BUILTIN_HOSTS = [MODEL_HOST, NPM_HOST] as const;

/** The exe-dev edge, kept for test imports. Routes read the platform. */
export const EDGE_ADDRESS = EXE_DEV_PLATFORM.edgeAddress;

export const MODEL_ROUTE_IDS = [
	"model-openai",
	"model-xai",
	"model-anthropic",
] as const;

/** The provider whose route serves a stage's primary model. */
export type PrimaryProvider = "openai" | "anthropic";

const ROUTE_ID = /^[a-z][a-z0-9-]{0,31}$/;

const HEADER_NAME = /^[a-z0-9-]{1,64}$/;

/** An HTTP/2 pseudo-header name. It parses as a placement only so the credential check refuses it. */
const PSEUDO_HEADER = /^:[a-z]{1,32}$/;

/**
 * Request headers that retarget a request. The client may not send one,
 * and no credential may be placed in one. Both checks use this one list.
 */
export const ROUTING_HEADER =
	/^(x-forwarded(-.*)?|forwarded|x-original-.*|x-host|x-rewrite-url|x-http-method-override|proxy-.*|upgrade)$/;

const HOST_NAME =
	/^(?=.{1,253}$)[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?(\.[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?)*$/;

const PATH_SEGMENT = /^[A-Za-z0-9._~!$&'()+,;=:@%-]+$/;

const MEDIA_TYPE = /^[a-z0-9.+-]+\/[a-z0-9.+-]+$/;

const JSON_POINTER = /^(\/[A-Za-z0-9_.-]+)+$/;

const MIB = 1024 * 1024;

function routeId(text: string): RouteId | null {
	// SAFETY: the pattern is the RouteId contract.
	return ROUTE_ID.test(text) ? (text as RouteId) : null;
}

export function credentialId(text: string): CredentialId | null {
	// SAFETY: credential ids share the route id pattern.
	return ROUTE_ID.test(text) ? (text as CredentialId) : null;
}

function builtinRouteId(text: string): RouteId {
	const id = routeId(text);

	if (id === null) throw new Error("a built-in route id is malformed");

	return id;
}

const MODEL_LIMITS: Limits = {
	maxRequestBytes: 16 * MIB,
	maxResponseBytes: 64 * MIB,
	headersTimeoutMs: 120_000,
	idleTimeoutMs: 120_000,
	totalTimeoutMs: 900_000,
	perMinute: 60,
	maxConcurrent: 8,
};

const NPM_LIMITS: Limits = {
	maxRequestBytes: 0,
	maxResponseBytes: 256 * MIB,
	headersTimeoutMs: 30_000,
	idleTimeoutMs: 60_000,
	totalTimeoutMs: 600_000,
	perMinute: 600,
	maxConcurrent: 16,
};

/** The platform's model integration: its host, Host header and SNI, pinned to its edge. */
function modelUpstream(network: PlatformNetwork, basePath: string): Upstream {
	return {
		scheme: "https",
		host: network.modelHost,
		port: 443,
		basePath,
		hostHeader: network.modelHost,
		sni: network.modelHost,
		address: { kind: "pinned", ip: network.edgeAddress },
	};
}

const NPM_UPSTREAM: Upstream = {
	scheme: "https",
	host: NPM_HOST,
	port: 443,
	basePath: "/",
	hostHeader: NPM_HOST,
	sni: NPM_HOST,
	address: { kind: "resolve" },
};

function modelRoute(input: {
	id: RouteId;
	prefix: string;
	upstream: Upstream;
	model: string;
	fallback?: string;
	initially: "open" | "closed";
}): Route {
	return {
		id: input.id,
		prefix: input.prefix,
		upstream: input.upstream,
		methods: ["GET", "POST"],
		paths: [
			{ kind: "exact", path: "models" },
			{ kind: "exact", path: "responses" },
		],
		query: { kind: "none" },
		body: {
			kind: "json",
			contentTypes: ["application/json"],
			constraints: [
				{
					kind: "one_of",
					pointer: "/model",
					values:
						input.fallback === undefined
							? [input.model]
							: [input.model, input.fallback],
				},
				{
					kind: "each_one_of",
					pointer: "/tools",
					field: "type",
					values: ["function"],
				},
				{ kind: "absent", pointer: "/background" },
			],
		},
		requestHeaders: ["accept", "content-type"],
		responseHeaders: ["content-type", "cache-control", "x-request-id"],
		limits: MODEL_LIMITS,
		credential: null,
		budget: true,
		audit: "detailed",
		initially: input.initially,
		meter: "openai-responses-sse",
	};
}

/**
 * The keys Pi 1.4.0 writes on an Anthropic tool: `pi-ai` `convertTools`,
 * plus `defer_loading` on the `__pi_deferred_placeholder__` client tool it
 * appends to every tool list. A deferred client tool stays a client tool.
 * A server tool carries `type` and no `input_schema`, so it is refused.
 */
const ANTHROPIC_TOOL_KEYS = [
	"name",
	"description",
	"input_schema",
	"eager_input_streaming",
	"strict",
	"cache_control",
	"defer_loading",
] as const;

/**
 * Pi's Anthropic client posts `v1/messages?beta=true` and sends
 * `anthropic-version` itself. The edge returns 400 without that header.
 * `max_tokens` is rewritten by the gateway, never `max_output_tokens`.
 */
function anthropicRoute(network: PlatformNetwork, model: string): Route {
	return {
		id: builtinRouteId("model-anthropic"),
		prefix: "/anthropic/",
		upstream: modelUpstream(network, network.modelBasePaths.anthropic),
		methods: ["GET", "POST"],
		paths: [
			{ kind: "exact", path: "v1/models" },
			{ kind: "exact", path: "v1/messages" },
		],
		query: { kind: "exact", values: ["beta=true"] },
		body: {
			kind: "json",
			contentTypes: ["application/json"],
			constraints: [
				{ kind: "one_of", pointer: "/model", values: [model] },
				{
					kind: "each_keys",
					pointer: "/tools",
					required: ["name", "input_schema"],
					allowed: ANTHROPIC_TOOL_KEYS,
				},
				{ kind: "absent", pointer: "/max_output_tokens" },
				{ kind: "absent", pointer: "/mcp_servers" },
			],
		},
		requestHeaders: [
			"accept",
			"content-type",
			"anthropic-version",
			"anthropic-beta",
		],
		responseHeaders: ["content-type", "cache-control", "x-request-id"],
		limits: MODEL_LIMITS,
		credential: null,
		budget: true,
		audit: "detailed",
		initially: "open",
		meter: "anthropic-messages-sse",
	};
}

const NPM_ROUTE: Route = {
	id: builtinRouteId("npm"),
	prefix: "/npm/",
	upstream: NPM_UPSTREAM,
	methods: ["GET", "HEAD"],
	paths: [{ kind: "glob", pattern: "**" }],
	query: { kind: "none" },
	body: { kind: "none" },
	requestHeaders: ["accept"],
	responseHeaders: [
		"content-type",
		"cache-control",
		"etag",
		"last-modified",
		"location",
	],
	limits: NPM_LIMITS,
	credential: null,
	budget: true,
	audit: "standard",
	initially: "open",
	meter: null,
};

/**
 * The stage's routes on `platform`. `model` is the bare primary id and
 * `fallback` a `<provider>/<model>` id. An OpenAI primary keeps
 * `model-openai` open and puts an `xai/` fallback on a closed `model-xai`,
 * which a platform without an xAI route refuses; it never mounts
 * Anthropic. An Anthropic primary mounts `model-anthropic` open, and only an
 * `openai/` fallback, on a closed `model-openai`. `provider` defaults to
 * `openai`.
 */
export function builtinTable(input: {
	platform: PlatformNetwork;
	stage: string;
	runId: string;
	attempt: number;
	provider?: PrimaryProvider;
	model: string;
	fallback: string | null;
	modelTokens: number;
	modelRequests: number;
}): RouteTable {
	const routes =
		input.provider === "anthropic"
			? anthropicRoutes(input.platform, input.model, input.fallback)
			: openaiRoutes(input.platform, input.model, input.fallback);

	routes.push(NPM_ROUTE);

	return {
		version: 1,
		stage: input.stage,
		runId: input.runId,
		attempt: input.attempt,
		forwarderHost: FORWARDER_HOST,
		routes,
		ceiling: {
			modelTokens: input.modelTokens,
			modelRequests: input.modelRequests,
		},
	};
}

function anthropicRoutes(
	network: PlatformNetwork,
	model: string,
	fallback: string | null,
): Route[] {
	if (fallback === null) return [anthropicRoute(network, model)];

	if (!fallback.startsWith("openai/")) {
		throw new Error("an Anthropic primary takes only an openai/ fallback");
	}

	return [
		anthropicRoute(network, model),
		modelRoute({
			id: builtinRouteId("model-openai"),
			prefix: "/openai/v1/",
			upstream: modelUpstream(network, network.modelBasePaths.openai),
			model: fallback.slice("openai/".length),
			initially: "closed",
		}),
	];
}

function openaiRoutes(
	network: PlatformNetwork,
	model: string,
	fallback: string | null,
): Route[] {
	const sameProvider = fallback?.startsWith("openai/") === true;

	const routes: Route[] = [
		modelRoute({
			id: builtinRouteId("model-openai"),
			prefix: "/openai/v1/",
			upstream: modelUpstream(network, network.modelBasePaths.openai),
			model,
			fallback:
				fallback !== null && sameProvider
					? fallback.slice("openai/".length)
					: undefined,
			initially: "open",
		}),
	];

	if (fallback === null || sameProvider) return routes;

	if (!fallback.startsWith("xai/")) {
		throw new Error("an OpenAI primary takes only an openai/ or xai/ fallback");
	}

	const xai = network.modelBasePaths.xai;

	if (xai === null) throw new Error("the platform has no xai route");

	routes.push(
		modelRoute({
			id: builtinRouteId("model-xai"),
			prefix: "/xai/v1/",
			upstream: modelUpstream(network, xai),
			model: fallback.slice("xai/".length),
			initially: "closed",
		}),
	);

	return routes;
}

function normalHost(host: string): string {
	const lower = host.toLowerCase();

	const bare =
		lower.startsWith("[") && lower.endsWith("]") ? lower.slice(1, -1) : lower;

	return bare.endsWith(".") ? bare.slice(0, -1) : bare;
}

function underDomain(host: string, domain: string): boolean {
	return host === domain || host.endsWith(`.${domain}`);
}

/**
 * Hosts a credentialed or declared route may never target: any name at or
 * under one of the platform's forbidden domains (its own domain, its `int.`
 * domain and every GitHub domain), the npm registry, localhost and any IP
 * literal, including all-digit spellings a resolver would read as an address.
 */
export function isForbiddenUpstreamHost(
	host: string,
	network: PlatformNetwork,
): boolean {
	const name = normalHost(host);

	if (isIP(name) !== 0 || /^[0-9.]+$/.test(name) || /^0x/i.test(name)) {
		return true;
	}

	return (
		name === "localhost" ||
		name === NPM_HOST ||
		underDomain(name, "localhost") ||
		network.forbiddenDomains.some((domain) => underDomain(name, domain))
	);
}

type Parsed<T> = T | null;

function readMethods(value: JsonValue | undefined): Parsed<Method[]> {
	const texts = textsOf(value);

	if (texts === null || texts.length === 0) return null;

	const methods: Method[] = [];

	for (const text of texts) {
		const method = METHODS.find((known) => known === text);

		if (method === undefined || methods.includes(method)) return null;

		methods.push(method);
	}

	return methods;
}

function validRelativePath(path: string): boolean {
	return path.split("/").every((segment) => PATH_SEGMENT.test(segment));
}

function validGlob(pattern: string): boolean {
	const segments = pattern.split("/");

	return segments.every(
		(segment, index) =>
			segment === "*" ||
			(segment === "**" && index === segments.length - 1) ||
			(PATH_SEGMENT.test(segment) && !segment.includes("*")),
	);
}

function readPathRule(value: JsonValue | undefined): Parsed<PathRule> {
	const rule = objectOf(value);
	const kind = textOf(fieldOf(rule, "kind"));

	if (rule === null) return null;

	if (kind === "exact" && hasOnlyKeys(rule, ["kind", "path"])) {
		const path = textOf(fieldOf(rule, "path"));

		return path !== null && validRelativePath(path) ? { kind, path } : null;
	}

	if (kind === "prefix" && hasOnlyKeys(rule, ["kind", "prefix"])) {
		const prefix = textOf(fieldOf(rule, "prefix"));

		return prefix !== null && validRelativePath(prefix)
			? { kind, prefix }
			: null;
	}

	if (kind === "glob" && hasOnlyKeys(rule, ["kind", "pattern"])) {
		const pattern = textOf(fieldOf(rule, "pattern"));

		return pattern !== null && validGlob(pattern) ? { kind, pattern } : null;
	}

	return null;
}

export function readPathRules(
	value: JsonValue | undefined,
): Parsed<PathRule[]> {
	const items = arrayOf(value);

	if (items === null || items.length === 0) return null;

	const rules: PathRule[] = [];

	for (const item of items) {
		const rule = readPathRule(item);

		if (rule === null) return null;

		rules.push(rule);
	}

	return rules;
}

function readQuery(value: JsonValue | undefined): Parsed<QueryRule> {
	const rule = objectOf(value);
	const kind = textOf(fieldOf(rule, "kind"));

	if (rule === null) return null;

	if (kind === "none" && hasOnlyKeys(rule, ["kind"])) return { kind };

	if (kind === "exact" && hasOnlyKeys(rule, ["kind", "values"])) {
		const values = textsOf(fieldOf(rule, "values"));

		return values !== null &&
			values.length > 0 &&
			values.every((text) => /^[A-Za-z0-9_.=&-]{1,128}$/.test(text))
			? { kind, values }
			: null;
	}

	if (
		kind !== "keys" ||
		!hasOnlyKeys(rule, ["kind", "allow", "maxValueBytes"])
	) {
		return null;
	}

	const allow = textsOf(fieldOf(rule, "allow"));
	const maxValueBytes = countOf(fieldOf(rule, "maxValueBytes"));

	if (
		allow === null ||
		maxValueBytes === null ||
		!allow.every((key) => /^[A-Za-z0-9_.-]{1,64}$/.test(key)) ||
		new Set(allow).size !== allow.length
	) {
		return null;
	}

	return { kind, allow, maxValueBytes };
}

function readScalars(value: JsonValue | undefined): Parsed<JsonScalar[]> {
	const items = arrayOf(value);

	if (items === null || items.length === 0) return null;

	const scalars: JsonScalar[] = [];

	for (const item of items) {
		const text = textOf(item);
		const number = numberOf(item);
		const flag = boolOf(item);
		const scalar = text ?? number ?? flag;

		if (scalar === null) return null;

		scalars.push(scalar);
	}

	return scalars;
}

function readConstraint(value: JsonValue | undefined): Parsed<JsonConstraint> {
	const rule = objectOf(value);
	const kind = textOf(fieldOf(rule, "kind"));
	const pointer = textOf(fieldOf(rule, "pointer"));

	if (rule === null || pointer === null || !JSON_POINTER.test(pointer)) {
		return null;
	}

	if (kind === "one_of" && hasOnlyKeys(rule, ["kind", "pointer", "values"])) {
		const values = readScalars(fieldOf(rule, "values"));

		return values === null ? null : { kind, pointer, values };
	}

	if (kind === "absent" && hasOnlyKeys(rule, ["kind", "pointer"])) {
		return { kind, pointer };
	}

	if (kind === "at_most" && hasOnlyKeys(rule, ["kind", "pointer", "value"])) {
		const limit = numberOf(fieldOf(rule, "value"));

		return limit === null ? null : { kind, pointer, value: limit };
	}

	if (
		kind === "each_one_of" &&
		hasOnlyKeys(rule, ["kind", "pointer", "field", "values"])
	) {
		const field = textOf(fieldOf(rule, "field"));
		const values = readScalars(fieldOf(rule, "values"));

		return field === null || values === null
			? null
			: { kind, pointer, field, values };
	}

	if (
		kind === "each_keys" &&
		hasOnlyKeys(rule, ["kind", "pointer", "required", "allowed"])
	) {
		const required = textsOf(fieldOf(rule, "required"));
		const allowed = textsOf(fieldOf(rule, "allowed"));

		return required === null ||
			allowed === null ||
			allowed.length === 0 ||
			!required.every((key) => allowed.includes(key))
			? null
			: { kind, pointer, required, allowed };
	}

	return null;
}

function readMediaTypes(value: JsonValue | undefined): Parsed<string[]> {
	const types = textsOf(value);

	return types !== null &&
		types.length > 0 &&
		types.every((type) => MEDIA_TYPE.test(type))
		? types
		: null;
}

function readBody(value: JsonValue | undefined): Parsed<BodyRule> {
	const rule = objectOf(value);
	const kind = textOf(fieldOf(rule, "kind"));

	if (rule === null) return null;

	if (kind === "none" && hasOnlyKeys(rule, ["kind"])) return { kind };

	if (kind === "opaque" && hasOnlyKeys(rule, ["kind", "contentTypes"])) {
		const contentTypes = readMediaTypes(fieldOf(rule, "contentTypes"));

		return contentTypes === null ? null : { kind, contentTypes };
	}

	if (
		kind !== "json" ||
		!hasOnlyKeys(rule, ["kind", "contentTypes", "constraints"])
	) {
		return null;
	}

	const contentTypes = readMediaTypes(fieldOf(rule, "contentTypes"));
	const items = arrayOf(fieldOf(rule, "constraints"));

	if (contentTypes === null || items === null) return null;

	const constraints: JsonConstraint[] = [];

	for (const item of items) {
		const constraint = readConstraint(item);

		if (constraint === null) return null;

		constraints.push(constraint);
	}

	return { kind, contentTypes, constraints };
}

function validHostName(host: string): boolean {
	return HOST_NAME.test(host);
}

function readAddress(value: JsonValue | undefined): Parsed<UpstreamAddress> {
	const address = objectOf(value);
	const kind = textOf(fieldOf(address, "kind"));

	if (address === null) return null;

	if (kind === "resolve" && hasOnlyKeys(address, ["kind"])) return { kind };

	const ip = textOf(fieldOf(address, "ip"));

	return kind === "pinned" &&
		hasOnlyKeys(address, ["kind", "ip"]) &&
		ip !== null &&
		isIP(ip) !== 0
		? { kind, ip }
		: null;
}

function readUpstream(value: JsonValue | undefined): Parsed<Upstream> {
	const upstream = objectOf(value);

	if (
		upstream === null ||
		!hasOnlyKeys(upstream, [
			"scheme",
			"host",
			"port",
			"basePath",
			"hostHeader",
			"sni",
			"address",
		])
	) {
		return null;
	}

	const scheme = textOf(fieldOf(upstream, "scheme"));
	const host = textOf(fieldOf(upstream, "host"));
	const port = countOf(fieldOf(upstream, "port"));
	const basePath = textOf(fieldOf(upstream, "basePath"));
	const hostHeader = textOf(fieldOf(upstream, "hostHeader"));
	const sni = textOf(fieldOf(upstream, "sni"));
	const address = readAddress(fieldOf(upstream, "address"));

	if (
		(scheme !== "https" && scheme !== "http") ||
		host === null ||
		!validHostName(host) ||
		port === null ||
		port < 1 ||
		port > 65535 ||
		basePath === null ||
		!basePath.startsWith("/") ||
		!basePath.endsWith("/") ||
		(basePath !== "/" && !validRelativePath(basePath.slice(1, -1))) ||
		hostHeader === null ||
		!validHostName(hostHeader) ||
		sni === null ||
		!validHostName(sni) ||
		address === null
	) {
		return null;
	}

	return { scheme, host, port, basePath, hostHeader, sni, address };
}

const LIMIT_KEYS = [
	"maxRequestBytes",
	"maxResponseBytes",
	"headersTimeoutMs",
	"idleTimeoutMs",
	"totalTimeoutMs",
	"perMinute",
	"maxConcurrent",
] as const;

function readLimits(value: JsonValue | undefined): Parsed<Limits> {
	const limits = objectOf(value);

	if (limits === null || !hasOnlyKeys(limits, LIMIT_KEYS)) return null;

	const numbers = LIMIT_KEYS.map((key) => countOf(fieldOf(limits, key)));

	const [
		maxRequestBytes,
		maxResponseBytes,
		headersTimeoutMs,
		idleTimeoutMs,
		totalTimeoutMs,
		perMinute,
		maxConcurrent,
	] = numbers;

	if (
		maxRequestBytes === null ||
		maxRequestBytes === undefined ||
		maxResponseBytes === null ||
		maxResponseBytes === undefined ||
		headersTimeoutMs === null ||
		headersTimeoutMs === undefined ||
		idleTimeoutMs === null ||
		idleTimeoutMs === undefined ||
		totalTimeoutMs === null ||
		totalTimeoutMs === undefined ||
		perMinute === null ||
		perMinute === undefined ||
		maxConcurrent === null ||
		maxConcurrent === undefined ||
		perMinute < 1 ||
		maxConcurrent < 1
	) {
		return null;
	}

	return {
		maxRequestBytes,
		maxResponseBytes,
		headersTimeoutMs,
		idleTimeoutMs,
		totalTimeoutMs,
		perMinute,
		maxConcurrent,
	};
}

export function readPlacement(
	value: JsonValue | undefined,
): Parsed<CredentialPlacement> {
	const placement = objectOf(value);
	const kind = textOf(fieldOf(placement, "kind"));

	if (placement === null) return null;

	if (kind === "header" && hasOnlyKeys(placement, ["kind", "name", "scheme"])) {
		const name = textOf(fieldOf(placement, "name"));
		const raw = fieldOf(placement, "scheme");

		const scheme =
			raw === null
				? null
				: raw === "Bearer" || raw === "Token"
					? raw
					: undefined;

		return name !== null &&
			(HEADER_NAME.test(name.toLowerCase()) || PSEUDO_HEADER.test(name)) &&
			scheme !== undefined
			? { kind, name, scheme }
			: null;
	}

	if (kind === "basic" && hasOnlyKeys(placement, ["kind", "username"])) {
		const username = textOf(fieldOf(placement, "username"));

		return username !== null && /^[A-Za-z0-9._@-]{1,128}$/.test(username)
			? { kind, username }
			: null;
	}

	return null;
}

function readCredential(
	value: JsonValue | undefined,
): Parsed<CredentialRef> | undefined {
	if (value === null) return null;

	const ref = objectOf(value);

	if (ref === null || !hasOnlyKeys(ref, ["id", "placement"])) return undefined;

	const idText = textOf(fieldOf(ref, "id"));
	const id = idText === null ? null : credentialId(idText);
	const placement = readPlacement(fieldOf(ref, "placement"));

	return id === null || placement === null ? undefined : { id, placement };
}

function readHeaderNames(value: JsonValue | undefined): Parsed<string[]> {
	const names = textsOf(value);

	return names !== null && names.every((name) => HEADER_NAME.test(name))
		? names
		: null;
}

const ROUTE_KEYS = [
	"id",
	"prefix",
	"upstream",
	"methods",
	"paths",
	"query",
	"body",
	"requestHeaders",
	"responseHeaders",
	"limits",
	"credential",
	"budget",
	"audit",
	"initially",
	"meter",
] as const;

function readRoute(value: JsonValue | undefined): Parsed<Route> {
	const route = objectOf(value);

	if (route === null || !hasOnlyKeys(route, ROUTE_KEYS)) return null;

	const idText = textOf(fieldOf(route, "id"));
	const id = idText === null ? null : routeId(idText);
	const prefix = textOf(fieldOf(route, "prefix"));
	const upstream = readUpstream(fieldOf(route, "upstream"));
	const methods = readMethods(fieldOf(route, "methods"));
	const paths = readPathRules(fieldOf(route, "paths"));
	const query = readQuery(fieldOf(route, "query"));
	const body = readBody(fieldOf(route, "body"));
	const requestHeaders = readHeaderNames(fieldOf(route, "requestHeaders"));
	const responseHeaders = readHeaderNames(fieldOf(route, "responseHeaders"));
	const limits = readLimits(fieldOf(route, "limits"));
	const credential = readCredential(fieldOf(route, "credential"));
	const budget = boolOf(fieldOf(route, "budget"));
	const audit = textOf(fieldOf(route, "audit"));
	const initially = textOf(fieldOf(route, "initially"));
	const meterValue = fieldOf(route, "meter");

	const meter =
		meterValue === null ? null : METERS.find((known) => known === meterValue);

	if (
		id === null ||
		prefix === null ||
		!/^\/([a-z0-9-]+\/)+$/.test(prefix) ||
		upstream === null ||
		methods === null ||
		paths === null ||
		query === null ||
		body === null ||
		requestHeaders === null ||
		responseHeaders === null ||
		limits === null ||
		credential === undefined ||
		budget === null ||
		(audit !== "standard" && audit !== "detailed") ||
		(initially !== "open" && initially !== "closed") ||
		meter === undefined
	) {
		return null;
	}

	return {
		id,
		prefix,
		upstream,
		methods,
		paths,
		query,
		body,
		requestHeaders,
		responseHeaders,
		limits,
		credential,
		budget,
		audit,
		initially,
		meter,
	};
}

function sameUpstream(left: Upstream, right: Upstream): boolean {
	return JSON.stringify(left) === JSON.stringify(right);
}

function builtinUpstream(
	network: PlatformNetwork,
	id: RouteId,
): Upstream | null {
	const paths = network.modelBasePaths;

	if (id === "model-openai") return modelUpstream(network, paths.openai);

	if (id === "model-xai") {
		return paths.xai === null ? null : modelUpstream(network, paths.xai);
	}

	if (id === "model-anthropic") return modelUpstream(network, paths.anthropic);

	if (id === "npm") return NPM_UPSTREAM;

	return null;
}

/** Why a route is not allowed in production on `network`, or `null` when it is. */
function productionDefect(
	route: Route,
	network: PlatformNetwork,
): string | null {
	if (route.upstream.scheme !== "https") return "plain-http";

	if (route.credential === null) {
		const builtin = builtinUpstream(network, route.id);

		return builtin !== null && sameUpstream(builtin, route.upstream)
			? null
			: "uncredentialed-declared";
	}

	if (route.upstream.address.kind === "pinned") return "pinned-declared";

	return null;
}

function credentialDefect(
	route: Route,
	network: PlatformNetwork,
): string | null {
	if (route.credential === null) return null;

	if (
		isForbiddenUpstreamHost(route.upstream.host, network) ||
		isForbiddenUpstreamHost(route.upstream.hostHeader, network) ||
		isForbiddenUpstreamHost(route.upstream.sni, network)
	) {
		return "forbidden-upstream";
	}

	if (
		route.upstream.hostHeader !== route.upstream.host ||
		route.upstream.sni !== route.upstream.host
	) {
		return "split-authority";
	}

	if (route.methods.some((method) => method !== "GET" && method !== "HEAD")) {
		return "credentialed-write";
	}

	return null;
}

export type TableParse =
	| { readonly ok: true; readonly table: RouteTable }
	| { readonly ok: false };

const TABLE_KEYS = [
	"version",
	"stage",
	"runId",
	"attempt",
	"forwarderHost",
	"routes",
	"ceiling",
] as const;

/**
 * Reads a route table at the gateway's boundary, against the gateway's own
 * platform. A platform that is not its built-in contract, unknown fields,
 * duplicate ids or prefixes, and any route `mode` does not admit reject the
 * whole table.
 */
export function parseRouteTable(
	value: JsonValue | undefined,
	mode: TableMode,
	network: PlatformNetwork,
): TableParse {
	const table = objectOf(value);

	if (
		platformDefect(network) !== null ||
		table === null ||
		!hasOnlyKeys(table, TABLE_KEYS)
	) {
		return { ok: false };
	}

	const stage = textOf(fieldOf(table, "stage"));
	const runId = textOf(fieldOf(table, "runId"));
	const attempt = countOf(fieldOf(table, "attempt"));
	const forwarderHost = textOf(fieldOf(table, "forwarderHost"));
	const items = arrayOf(fieldOf(table, "routes"));
	const ceiling: JsonObject | null = objectOf(fieldOf(table, "ceiling"));
	const modelTokens = countOf(fieldOf(ceiling, "modelTokens"));
	const modelRequests = countOf(fieldOf(ceiling, "modelRequests"));

	if (
		fieldOf(table, "version") !== 1 ||
		stage === null ||
		!/^[a-z]{1,16}$/.test(stage) ||
		runId === null ||
		!/^[0-9a-f]{64}$/.test(runId) ||
		attempt === null ||
		forwarderHost === null ||
		!/^127\.0\.0\.1:[0-9]{1,5}$/.test(forwarderHost) ||
		items === null ||
		ceiling === null ||
		!hasOnlyKeys(ceiling, ["modelTokens", "modelRequests"]) ||
		modelTokens === null ||
		modelRequests === null
	) {
		return { ok: false };
	}

	const routes: Route[] = [];

	for (const item of items) {
		const route = readRoute(item);

		if (
			route === null ||
			routes.some(
				(other) => other.id === route.id || other.prefix === route.prefix,
			) ||
			credentialDefect(route, network) !== null ||
			(mode === "production" && productionDefect(route, network) !== null)
		) {
			return { ok: false };
		}

		routes.push(route);
	}

	const credentialed = routes.flatMap((route) =>
		route.credential === null ? [] : [route.credential.id],
	);

	if (new Set(credentialed).size !== credentialed.length) return { ok: false };

	return {
		ok: true,
		table: {
			version: 1,
			stage,
			runId,
			attempt,
			forwarderHost,
			routes,
			ceiling: { modelTokens, modelRequests },
		},
	};
}
