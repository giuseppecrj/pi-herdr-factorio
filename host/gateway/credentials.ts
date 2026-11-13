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
} from "../../src/core/json.ts";
import {
	type PlatformNetwork,
	platformDefect,
	readTrustedFile,
	rootOrSelf,
} from "../../src/trust/platform.ts";
import {
	type CredentialId,
	type CredentialPlacement,
	METHODS,
	type Method,
	type PathRule,
	ROUTING_HEADER,
	type Route,
	type RouteId,
	type RouteTable,
	type TableMode,
	credentialId,
	isForbiddenUpstreamHost,
	readPathRules,
	readPlacement,
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

const MIN_SECRET_BYTES = 16;

const MAX_SECRET_BYTES = 8192;

const MAX_CEILINGS_BYTES = 64 * 1024;

const CEILING_KEYS = [
	"scheme",
	"host",
	"port",
	"placement",
	"methods",
	"paths",
] as const;

const FRAMING_HEADER =
	/^(host|:.*|content-length|transfer-encoding|connection|te|trailer|keep-alive|user-agent|accept-encoding)$/;

/**
 * True when a placement would put the secret in a header that routes or
 * frames the request: a framing header, a header the gateway sets itself,
 * any pseudo-header, or a header the client filter refuses as retargeting.
 * Node keeps the last of two `Host` values, so a credential named `host`
 * would replace the route's own.
 */
function reservedPlacement(placement: CredentialPlacement): boolean {
	if (placement.kind !== "header") return false;

	const name = placement.name.toLowerCase();

	return FRAMING_HEADER.test(name) || ROUTING_HEADER.test(name);
}

export type CeilingParse =
	| { readonly ok: true; readonly ceilings: Ceilings }
	| { readonly ok: false };

/**
 * Reads the root-owned ceiling file against the gateway's platform.
 * Production ceilings are https only, no mode admits a ceiling that names a
 * forbidden upstream, and a platform that is not its built-in contract
 * admits none.
 */
export function parseCeilings(
	text: string,
	mode: TableMode,
	network: PlatformNetwork,
): CeilingParse {
	const root = objectOf(parseJson(text));

	if (root === null || platformDefect(network) !== null) return { ok: false };

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
			isForbiddenUpstreamHost(host, network) ||
			port === null ||
			port < 1 ||
			port > 65535 ||
			placement === null ||
			reservedPlacement(placement) ||
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

/**
 * Reads the ceiling file through `readTrustedFile`. Production trusts only a
 * root-owned file, because the controller names the path; test mode also
 * trusts the gateway's own user.
 */
export function loadCeilings(
	path: string,
	mode: TableMode,
	network: PlatformNetwork,
): CeilingParse {
	const file = readTrustedFile(
		path,
		MAX_CEILINGS_BYTES,
		mode === "production" ? [0] : rootOrSelf(),
	);

	return file.kind === "present"
		? parseCeilings(file.text, mode, network)
		: { ok: false };
}

export type SecretLoad =
	| { readonly ok: true; readonly secrets: ReadonlyMap<CredentialId, Buffer> }
	| { readonly ok: false };

function validSecret(bytes: Buffer): boolean {
	return (
		bytes.length >= MIN_SECRET_BYTES &&
		bytes.length <= MAX_SECRET_BYTES &&
		!bytes.includes(0x0a) &&
		!bytes.includes(0x0d)
	);
}

/**
 * Reads each referenced secret once from systemd's credentials directory.
 * Any missing, short, oversized or multi-line secret refuses the whole load.
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
	const utf16 = Buffer.from(secret.toString("latin1"), "utf16le");

	const forms = [
		secret,
		Buffer.from(secret.toString("hex")),
		Buffer.from(secret.toString("hex").toUpperCase()),
		utf16,
		Buffer.from(utf16).swap16(),
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
			reservedPlacement(placement) ||
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
 * client headers the route lists minus every credential-family, framing or
 * Host header, the gateway's own headers, and the bound credential last.
 * The client's Host never goes upstream, whatever the route lists.
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
			!FRAMING_HEADER.test(name) &&
			!headers.some(([seen]) => seen.toLowerCase() === name)
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

/** The bytes with ASCII whitespace removed, so wrapped base64 reads whole. */
function withoutWhitespace(bytes: Buffer): Buffer {
	return Buffer.from(
		bytes.filter((byte) => ![0x09, 0x0a, 0x0d, 0x20].includes(byte)),
	);
}

/** The bytes with ASCII capitals lowered, so mixed-case hex reads as the lower-case form. */
function lowerCased(bytes: Buffer): Buffer {
	return Buffer.from(
		bytes.map((byte) => (byte >= 0x41 && byte <= 0x5a ? byte + 0x20 : byte)),
	);
}

function base64Byte(byte: number): boolean {
	return (
		(byte >= 0x30 && byte <= 0x39) ||
		(byte >= 0x41 && byte <= 0x5a) ||
		(byte >= 0x61 && byte <= 0x7a) ||
		[0x2b, 0x2d, 0x2f, 0x3d, 0x5f].includes(byte)
	);
}

/** The bytes outside the base64 and base64url alphabets removed, as Node's decoder skips them. */
function base64Only(bytes: Buffer): Buffer {
	return Buffer.from(bytes.filter(base64Byte));
}

/**
 * The views a secret is looked for in: raw, JSON-unescaped,
 * percent-decoded, whitespace-stripped, lower-cased, both whitespace-stripped
 * and lower-cased, and base64-alphabet only. Hex and UTF-16 are forms of the
 * secret, so the raw view finds them.
 */
export function decodedViews(bytes: Buffer): Buffer[] {
	const stripped = withoutWhitespace(bytes);

	return [
		bytes,
		jsonUnescaped(bytes),
		percentDecoded(bytes),
		stripped,
		lowerCased(bytes),
		lowerCased(stripped),
		base64Only(bytes),
	];
}

/**
 * True for the only response types a credentialed route may return:
 * `application/json` and `text/*`. A missing type is refused.
 */
export function credentialedTypeAllowed(
	contentType: string | undefined,
): boolean {
	const type = (contentType ?? "").split(";")[0]?.trim().toLowerCase() ?? "";

	return type === "application/json" || /^text\/[a-z0-9.+-]+$/.test(type);
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
 * True when a body starts like gzip, framed brotli or zstd data, which the
 * reflection scan cannot read whatever `Content-Encoding` says. A zlib
 * header can also be plain text such as `x^`, so the text check refuses
 * zlib data instead.
 */
function compressedMagic(head: Buffer): boolean {
	const [first = -1, second = -1] = head;

	if (first === 0x1f && second === 0x8b) return true;

	return [
		[0xce, 0xb2, 0xcf, 0x81],
		[0x28, 0xb5, 0x2f, 0xfd],
	].some(
		(magic) =>
			head.length >= magic.length &&
			magic.every((byte, index) => head[index] === byte),
	);
}

function binaryByte(byte: number): boolean {
	return (
		(byte < 0x20 &&
			byte !== 0x09 &&
			byte !== 0x0a &&
			byte !== 0x0c &&
			byte !== 0x0d) ||
		byte === 0x7f
	);
}

/** A Unicode control character outside ASCII, U+0080 to U+009F. */
const C1_CONTROL = /[\u0080-\u009f]/;

/**
 * Streams a credentialed response body. Every byte must be UTF-8 text with
 * no control character, ASCII or C1, but tab, line feed, form feed and
 * carriage return, because compressed data, framed or not and at any
 * offset, is not text. Nothing passes until the first four bytes show no
 * compression magic. After that it holds back enough bytes that a secret
 * split across chunks, JSON-escaped, percent-encoded, hex in any case,
 * UTF-16, or base64 split by bytes outside its alphabet, is found before
 * any of its bytes leave. It also keeps the body's last base64-alphabet
 * bytes across chunks, so base64 split by longer runs outside its alphabet
 * still blocks the body before its last byte leaves.
 *
 * This scan is defense in depth and cannot be complete: an upstream can
 * always re-encode a secret as text no scan reads. The primary control is
 * that a secret binds only to a trusted upstream under the owner's ceiling,
 * on a read-only route.
 */
export class ReflectionFilter {
	readonly #scanner: SecretScanner;
	readonly #hold: number;
	readonly #utf8 = new TextDecoder("utf-8", { fatal: true });
	#held: Buffer = Buffer.alloc(0);
	#alphabet: Buffer = Buffer.alloc(0);
	#probed = false;

	constructor(forms: readonly Buffer[]) {
		this.#scanner = new SecretScanner(forms);
		this.#hold = Math.max(MAGIC_PROBE_BYTES - 1, this.#scanner.longest * 6 - 1);
	}

	#text(chunk: Buffer, final: boolean): boolean {
		if (chunk.some(binaryByte)) return false;

		try {
			return !C1_CONTROL.test(this.#utf8.decode(chunk, { stream: !final }));
		} catch {
			return false;
		}
	}

	/** True when the body's base64-alphabet bytes so far, `unread` included, hold a secret. */
	#alphabetReveals(unread: Buffer): boolean {
		const alphabet = Buffer.concat([this.#alphabet, base64Only(unread)]);

		this.#alphabet = alphabet.subarray(
			Math.max(0, alphabet.length - this.#scanner.longest),
		);

		return this.#scanner.contains(alphabet);
	}

	push(chunk: Buffer): FilterStep {
		const joined = Buffer.concat([this.#held, chunk]);
		let unread = chunk;

		if (!this.#probed) {
			if (joined.length < MAGIC_PROBE_BYTES) {
				this.#held = joined;

				return { kind: "pass", bytes: Buffer.alloc(0) };
			}

			if (compressedMagic(joined)) return { kind: "blocked" };

			this.#probed = true;
			unread = joined;
		}

		if (
			!this.#text(unread, false) ||
			this.#scanner.reveals(joined) ||
			this.#alphabetReveals(unread)
		) {
			return { kind: "blocked" };
		}

		const emit = Math.max(0, joined.length - this.#hold);

		this.#held = joined.subarray(emit);

		return { kind: "pass", bytes: joined.subarray(0, emit) };
	}

	end(): FilterStep {
		const rest = this.#held;

		this.#held = Buffer.alloc(0);

		if (
			(!this.#probed && compressedMagic(rest)) ||
			!this.#text(this.#probed ? Buffer.alloc(0) : rest, true) ||
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
