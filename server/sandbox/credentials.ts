import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
	countOf,
	fieldOf,
	hasOnlyKeys,
	objectOf,
	parseJson,
	textOf,
	textsOf,
} from "./json.ts";
import {
	type CredentialId,
	type CredentialPlacement,
	credentialId,
	isForbiddenUpstreamHost,
	METHODS,
	type Method,
	type PathRule,
	type Route,
	type RouteId,
	type RouteTable,
	readPathRules,
	readPlacement,
	type TableMode,
} from "./routes.ts";

/** The widest scope the owner allows one secret. A declared route may only narrow it. */
export type Ceiling = {
	readonly scheme: "https" | "http";
	readonly host: string;
	readonly port: number;
	readonly placement: CredentialPlacement;
	readonly methods: readonly Method[];
	readonly paths: readonly PathRule[];
};

export type Ceilings = ReadonlyMap<CredentialId, Ceiling>;

export const CEILINGS_PATH = "/etc/factory/egress-credentials.json";

const MAX_SECRET_BYTES = 8192;

const CEILING_KEYS = [
	"scheme",
	"host",
	"port",
	"placement",
	"methods",
	"paths",
] as const;

export type CeilingParse =
	| { readonly ok: true; readonly ceilings: Ceilings }
	| { readonly ok: false };

/**
 * Reads the root-owned ceiling file. Production ceilings are https only, and
 * no mode admits a ceiling that names a forbidden upstream.
 */
export function parseCeilings(text: string, mode: TableMode): CeilingParse {
	const root = objectOf(parseJson(text));

	if (root === null) return { ok: false };

	const ceilings = new Map<CredentialId, Ceiling>();

	for (const [key, value] of Object.entries(root)) {
		const id = credentialId(key);
		const entry = objectOf(value);

		if (id === null || entry === null || !hasOnlyKeys(entry, CEILING_KEYS)) {
			return { ok: false };
		}

		const scheme = textOf(fieldOf(entry, "scheme"));
		const host = textOf(fieldOf(entry, "host"));
		const port = countOf(fieldOf(entry, "port"));
		const placement = readPlacement(fieldOf(entry, "placement"));
		const methodTexts = textsOf(fieldOf(entry, "methods"));
		const paths = readPathRules(fieldOf(entry, "paths"));

		const methods = (methodTexts ?? []).flatMap((text) => {
			const method = METHODS.find((known) => known === text);

			return method === undefined ? [] : [method];
		});

		if (
			(scheme !== "https" && !(scheme === "http" && mode === "test")) ||
			host === null ||
			isForbiddenUpstreamHost(host) ||
			port === null ||
			port < 1 ||
			port > 65535 ||
			placement === null ||
			methodTexts === null ||
			methods.length === 0 ||
			methods.length !== methodTexts.length ||
			paths === null
		) {
			return { ok: false };
		}

		ceilings.set(id, { scheme, host, port, placement, methods, paths });
	}

	return { ok: true, ceilings };
}

export function loadCeilings(path: string, mode: TableMode): CeilingParse {
	try {
		return parseCeilings(readFileSync(path, "utf8"), mode);
	} catch {
		return { ok: false };
	}
}

export type SecretLoad =
	| { readonly ok: true; readonly secrets: ReadonlyMap<CredentialId, Buffer> }
	| { readonly ok: false };

function validSecret(bytes: Buffer): boolean {
	return (
		bytes.length >= 1 &&
		bytes.length <= MAX_SECRET_BYTES &&
		!bytes.includes(0x0a) &&
		!bytes.includes(0x0d)
	);
}

/**
 * Reads each referenced secret once from systemd's credentials directory.
 * Any missing, empty, oversized or multi-line secret refuses the whole load.
 */
export function loadSecrets(
	directory: string | undefined,
	ids: readonly CredentialId[],
): SecretLoad {
	const secrets = new Map<CredentialId, Buffer>();

	if (ids.length === 0) return { ok: true, secrets };

	if (directory === undefined || directory === "") return { ok: false };

	for (const id of ids) {
		try {
			const bytes = readFileSync(join(directory, id));

			if (!validSecret(bytes)) return { ok: false };

			secrets.set(id, bytes);
		} catch {
			return { ok: false };
		}
	}

	return { ok: true, secrets };
}

type Segments = {
	readonly parts: readonly string[];
	readonly open: boolean;
	readonly minExtra: number;
};

function segmentsOf(rule: PathRule): Segments {
	if (rule.kind === "exact") {
		return { parts: rule.path.split("/"), open: false, minExtra: 0 };
	}

	if (rule.kind === "prefix") {
		return { parts: rule.prefix.split("/"), open: true, minExtra: 0 };
	}

	const parts = rule.pattern.split("/");

	return parts[parts.length - 1] === "**"
		? { parts: parts.slice(0, -1), open: true, minExtra: 1 }
		: { parts, open: false, minExtra: 0 };
}

function segmentCovers(outer: string, inner: string): boolean {
	return outer === "*" ? inner !== "" : outer === inner;
}

/** True when every path `inner` matches is also matched by `outer`. */
export function pathRuleWithin(inner: PathRule, outer: PathRule): boolean {
	const small = segmentsOf(inner);
	const large = segmentsOf(outer);

	if (small.open && !large.open) return false;

	if (!large.open && small.parts.length !== large.parts.length) return false;

	if (small.parts.length < large.parts.length) return false;

	for (const [index, part] of large.parts.entries()) {
		const candidate = small.parts[index];

		if (candidate === undefined || !segmentCovers(part, candidate))
			return false;
	}

	if (!large.open) return true;

	const reachesBare =
		small.parts.length === large.parts.length && small.minExtra === 0;

	return !reachesBare || large.minExtra === 0;
}

export type BoundCredential = {
	readonly id: CredentialId;
	readonly header: readonly [string, string];
	readonly forms: readonly Buffer[];
};

export type CredentialBinding =
	| {
			readonly ok: true;
			readonly bound: ReadonlyMap<RouteId, BoundCredential>;
			readonly forms: readonly Buffer[];
	  }
	| { readonly ok: false };

function samePlacement(left: CredentialPlacement, right: CredentialPlacement) {
	if (left.kind === "basic" || right.kind === "basic") {
		return (
			left.kind === "basic" &&
			right.kind === "basic" &&
			left.username === right.username
		);
	}

	return (
		left.name.toLowerCase() === right.name.toLowerCase() &&
		left.scheme === right.scheme
	);
}

function withinCeiling(route: Route, ceiling: Ceiling): boolean {
	return (
		route.upstream.scheme === ceiling.scheme &&
		route.upstream.host === ceiling.host &&
		route.upstream.port === ceiling.port &&
		route.credential !== null &&
		samePlacement(route.credential.placement, ceiling.placement) &&
		route.methods.every((method) => ceiling.methods.includes(method)) &&
		route.paths.every((rule) =>
			ceiling.paths.some((outer) => pathRuleWithin(rule, outer)),
		)
	);
}

export function credentialHeader(
	placement: CredentialPlacement,
	secret: Buffer,
): readonly [string, string] {
	if (placement.kind === "basic") {
		const pair = Buffer.concat([Buffer.from(`${placement.username}:`), secret]);

		return ["Authorization", `Basic ${pair.toString("base64")}`];
	}

	const value = secret.toString("latin1");

	return [
		placement.name,
		placement.scheme === null ? value : `${placement.scheme} ${value}`,
	];
}

function percentEncoded(secret: Buffer, upper: boolean): Buffer {
	const hex = [...secret]
		.map((byte) => `%${byte.toString(16).padStart(2, "0")}`)
		.join("");

	return Buffer.from(upper ? hex.toUpperCase() : hex);
}

const MIN_STABLE_BASE64 = 8;

/**
 * The part of a secret's base64 that does not depend on the bytes around
 * it, for each of the three offsets the secret can start at inside a larger
 * base64 blob.
 */
function alignedBase64(secret: Buffer, encoding: "base64" | "base64url") {
	return [0, 1, 2].flatMap((shift) => {
		const text = Buffer.concat([Buffer.alloc(shift), secret]).toString(
			encoding,
		);

		const whole = Math.floor((shift + secret.length) / 3) * 4;
		const stable = text.slice(shift === 0 ? 0 : 4, whole);

		return stable.length >= MIN_STABLE_BASE64 ? [Buffer.from(stable)] : [];
	});
}

/** Every encoding of a secret the reflection scan looks for. */
export function secretForms(
	secret: Buffer,
	placement: CredentialPlacement,
): Buffer[] {
	const forms = [
		secret,
		Buffer.from(secret.toString("base64")),
		Buffer.from(secret.toString("base64").replace(/=+$/, "")),
		Buffer.from(secret.toString("base64url")),
		Buffer.from(encodeURIComponent(secret.toString("latin1"))),
		percentEncoded(secret, true),
		percentEncoded(secret, false),
		...alignedBase64(secret, "base64"),
		...alignedBase64(secret, "base64url"),
	];

	if (placement.kind === "basic") {
		forms.push(
			Buffer.from(
				Buffer.concat([Buffer.from(`${placement.username}:`), secret]).toString(
					"base64",
				),
			),
		);
	}

	const unique: Buffer[] = [];

	for (const form of forms) {
		if (form.length > 0 && !unique.some((seen) => seen.equals(form))) {
			unique.push(form);
		}
	}

	return unique;
}

/**
 * Binds each credentialed route to its loaded secret after checking the
 * route against its ceiling. One credential serves one route, and a route
 * whose secret or ceiling is missing refuses the whole table.
 */
export function bindCredentials(
	table: RouteTable,
	ceilings: Ceilings,
	secrets: ReadonlyMap<CredentialId, Buffer>,
): CredentialBinding {
	const bound = new Map<RouteId, BoundCredential>();
	const forms: Buffer[] = [];
	const used = new Set<CredentialId>();

	for (const route of table.routes) {
		if (route.credential === null) continue;

		const { id, placement } = route.credential;
		const ceiling = ceilings.get(id);
		const secret = secrets.get(id);

		if (
			ceiling === undefined ||
			secret === undefined ||
			used.has(id) ||
			!withinCeiling(route, ceiling)
		) {
			return { ok: false };
		}

		used.add(id);

		const routeForms = secretForms(secret, placement);

		bound.set(route.id, {
			id,
			header: credentialHeader(placement, secret),
			forms: routeForms,
		});
		forms.push(...routeForms);
	}

	return { ok: true, bound, forms };
}

const CREDENTIAL_HEADER =
	/^(authorization|proxy-authorization|cookie|cookie2|x-api-key|.*-api-key|.*-token|.*-auth-token)$/;

export function isCredentialHeader(name: string): boolean {
	return CREDENTIAL_HEADER.test(name.toLowerCase());
}

export const NEVER_COPIED_RESPONSE_HEADERS = [
	"set-cookie",
	"set-cookie2",
	"authorization",
	"proxy-authenticate",
	"proxy-authorization",
	"www-authenticate",
	"authentication-info",
] as const;

export const GATEWAY_USER_AGENT = "factory-gateway/1";

/**
 * The upstream request headers, built from scratch: the route's Host, the
 * client headers the route lists minus every credential-family header, the
 * gateway's own headers, and the bound credential last.
 */
export function buildUpstreamHeaders(
	route: Route,
	rawHeaders: readonly string[],
	contentLength: number,
	credential: readonly [string, string] | null,
): [string, string][] {
	const headers: [string, string][] = [["Host", route.upstream.hostHeader]];

	for (let index = 0; index + 1 < rawHeaders.length; index += 2) {
		const name = rawHeaders[index]?.toLowerCase();
		const value = rawHeaders[index + 1];

		if (
			name !== undefined &&
			value !== undefined &&
			route.requestHeaders.includes(name) &&
			!isCredentialHeader(name) &&
			!headers.some(([seen]) => seen === name)
		) {
			headers.push([name, value]);
		}
	}

	headers.push(
		["User-Agent", GATEWAY_USER_AGENT],
		["Accept-Encoding", "identity"],
		["Connection", "close"],
		["Content-Length", String(contentLength)],
	);

	if (credential !== null) headers.push([credential[0], credential[1]]);

	return headers;
}

/** Upstream response headers the route lists, never an auth or cookie header. */
export function responseHeadersFor(
	route: Route,
	rawHeaders: readonly string[],
): [string, string][] {
	const headers: [string, string][] = [];
	const banned: readonly string[] = NEVER_COPIED_RESPONSE_HEADERS;

	for (let index = 0; index + 1 < rawHeaders.length; index += 2) {
		const name = rawHeaders[index]?.toLowerCase();
		const value = rawHeaders[index + 1];

		if (
			name !== undefined &&
			value !== undefined &&
			route.responseHeaders.includes(name) &&
			!banned.includes(name)
		) {
			headers.push([name, value]);
		}
	}

	return headers;
}

const JSON_ESCAPES = new Map<string, number>([
	['"', 0x22],
	["\\", 0x5c],
	["/", 0x2f],
	["b", 0x08],
	["f", 0x0c],
	["n", 0x0a],
	["r", 0x0d],
	["t", 0x09],
]);

function hexAt(bytes: Buffer, at: number, length: number): number | null {
	const text = bytes.toString("latin1", at, at + length);

	return text.length === length && /^[0-9A-Fa-f]+$/.test(text)
		? Number.parseInt(text, 16)
		: null;
}

/** The bytes with JSON string escapes decoded. Anything that is not an escape is kept. */
export function jsonUnescaped(bytes: Buffer): Buffer {
	if (!bytes.includes(0x5c)) return bytes;

	const out: Buffer[] = [];
	let start = 0;
	let at = bytes.indexOf(0x5c);

	while (at !== -1 && at + 1 < bytes.length) {
		const next = String.fromCharCode(bytes[at + 1] ?? 0);
		const simple = JSON_ESCAPES.get(next);
		const unit = next === "u" ? hexAt(bytes, at + 2, 4) : null;

		if (simple !== undefined || unit !== null) {
			out.push(bytes.subarray(start, at));
			out.push(
				simple !== undefined
					? Buffer.from([simple])
					: Buffer.from(String.fromCharCode(unit ?? 0), "utf8"),
			);
			start = at + (simple !== undefined ? 2 : 6);
			at = bytes.indexOf(0x5c, start);
		} else {
			at = bytes.indexOf(0x5c, at + 1);
		}
	}

	out.push(bytes.subarray(start));

	return Buffer.concat(out);
}

/** The bytes with every `%XX` decoded. Anything else is kept. */
export function percentDecoded(bytes: Buffer): Buffer {
	if (!bytes.includes(0x25)) return bytes;

	const out: number[] = [];

	for (let at = 0; at < bytes.length; at += 1) {
		const byte = bytes[at] ?? 0;
		const value = byte === 0x25 ? hexAt(bytes, at + 1, 2) : null;

		if (value === null) {
			out.push(byte);
		} else {
			out.push(value);
			at += 2;
		}
	}

	return Buffer.from(out);
}

/** The views a secret is looked for in: raw, JSON-unescaped and percent-decoded. */
export function decodedViews(bytes: Buffer): Buffer[] {
	return [bytes, jsonUnescaped(bytes), percentDecoded(bytes)];
}

export class SecretScanner {
	readonly #forms: readonly Buffer[];

	constructor(forms: readonly Buffer[]) {
		this.#forms = forms;
	}

	get empty(): boolean {
		return this.#forms.length === 0;
	}

	contains(input: string | Buffer): boolean {
		const bytes = Buffer.isBuffer(input) ? input : Buffer.from(input, "latin1");

		return this.#forms.some((form) => bytes.includes(form));
	}

	/** True when any decoded view of the input holds any form of a secret. */
	reveals(input: string | Buffer): boolean {
		if (this.empty) return false;

		const bytes = Buffer.isBuffer(input) ? input : Buffer.from(input, "latin1");

		return decodedViews(bytes).some((view) => this.contains(view));
	}

	get longest(): number {
		return Math.max(0, ...this.#forms.map((form) => form.length));
	}
}

export type FilterStep =
	| { readonly kind: "pass"; readonly bytes: Buffer }
	| { readonly kind: "blocked" };

const MAGIC_PROBE_BYTES = 4;

/**
 * True when a body starts like gzip, zlib, framed brotli or zstd data, which
 * the reflection scan cannot read whatever `Content-Encoding` says.
 */
function compressedMagic(head: Buffer): boolean {
	const [first = -1, second = -1] = head;

	if (first === 0x1f && second === 0x8b) return true;

	if (
		(first & 0x0f) === 8 &&
		first >> 4 <= 7 &&
		second !== -1 &&
		((first << 8) | second) % 31 === 0
	) {
		return true;
	}

	return [
		[0xce, 0xb2, 0xcf, 0x81],
		[0x28, 0xb5, 0x2f, 0xfd],
	].some(
		(magic) =>
			head.length >= magic.length &&
			magic.every((byte, index) => head[index] === byte),
	);
}

/**
 * Streams a credentialed response body. Nothing passes until the first four
 * bytes show no compression magic. After that it holds back enough bytes
 * that a secret split across chunks, JSON-escaped or percent-encoded, is
 * found in some decoded view before any of its bytes leave.
 */
export class ReflectionFilter {
	readonly #scanner: SecretScanner;
	readonly #hold: number;
	#held: Buffer = Buffer.alloc(0);
	#probed = false;

	constructor(forms: readonly Buffer[]) {
		this.#scanner = new SecretScanner(forms);
		this.#hold = Math.max(MAGIC_PROBE_BYTES - 1, this.#scanner.longest * 6 - 1);
	}

	push(chunk: Buffer): FilterStep {
		const joined = Buffer.concat([this.#held, chunk]);

		if (!this.#probed) {
			if (joined.length < MAGIC_PROBE_BYTES) {
				this.#held = joined;

				return { kind: "pass", bytes: Buffer.alloc(0) };
			}

			if (compressedMagic(joined)) return { kind: "blocked" };

			this.#probed = true;
		}

		if (this.#scanner.reveals(joined)) return { kind: "blocked" };

		const emit = Math.max(0, joined.length - this.#hold);

		this.#held = joined.subarray(emit);

		return { kind: "pass", bytes: joined.subarray(0, emit) };
	}

	end(): FilterStep {
		const rest = this.#held;

		this.#held = Buffer.alloc(0);

		if (
			(!this.#probed && compressedMagic(rest)) ||
			this.#scanner.reveals(rest)
		) {
			return { kind: "blocked" };
		}

		return { kind: "pass", bytes: rest };
	}
}

export function credentialIdsOf(table: RouteTable): CredentialId[] {
	return table.routes.flatMap((route) =>
		route.credential === null ? [] : [route.credential.id],
	);
}
