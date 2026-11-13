import {
	credentialedRoute,
	ECHO_SECRET,
	LINEAR_CEILING,
	id,
} from "./credential-fixtures.ts";
import assert from "node:assert/strict";
import {
	chmodSync,
	mkdtempSync,
	rmSync,
	symlinkSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import {
	brotliCompressSync,
	deflateRawSync,
	deflateSync,
	gzipSync,
} from "node:zlib";
import {
	bindCredentials,
	buildUpstreamHeaders,
	type Ceilings,
	CREDENTIALED_RESPONSE_MAX_BYTES,
	isCredentialHeader,
	loadCeilings,
	loadSecrets,
	parseCeilings,
	pathRuleWithin,
	ReflectionFilter,
	responseHeadersFor,
	SecretScanner,
	secretForms,
} from "../../../host/gateway/credentials.ts";
import { type Route, type RouteTable } from "../../../host/gateway/routes.ts";
import { modelTable } from "./route-fixtures.ts";
import { EXE_DEV_PLATFORM } from "../../../src/trust/platform.ts";

function tableWith(routes: readonly Route[]): RouteTable {
	return { ...modelTable(), routes };
}

function ceilings(text: string = LINEAR_CEILING): Ceilings {
	const parsed = parseCeilings(text, "test", EXE_DEV_PLATFORM);

	assert.ok(parsed.ok);

	return parsed.ceilings;
}

describe("credential ceilings", () => {
	it("parses the owner's ceiling file strictly", () => {
		const parsed = ceilings();

		assert.deepEqual([...parsed.keys()], ["echo-read"]);
		assert.equal(parseCeilings("{}", "production", EXE_DEV_PLATFORM).ok, true);
		assert.equal(
			parseCeilings("not json", "production", EXE_DEV_PLATFORM).ok,
			false,
		);
		assert.equal(
			parseCeilings(LINEAR_CEILING, "production", EXE_DEV_PLATFORM).ok,
			false,
		);
		assert.equal(
			parseCeilings(
				LINEAR_CEILING.replace('"methods"', '"extra":1,"methods"'),
				"test",
				EXE_DEV_PLATFORM,
			).ok,
			false,
		);
	});

	it("loads the ceiling file only when it is a regular, trusted, non-writable file", () => {
		const dir = mkdtempSync(join(tmpdir(), "factory-ceilings-"));

		try {
			const path = join(dir, "egress-credentials.json");
			const link = join(dir, "link.json");

			writeFileSync(path, LINEAR_CEILING, { mode: 0o644 });
			symlinkSync(path, link);
			assert.equal(loadCeilings(path, "test", EXE_DEV_PLATFORM).ok, true);
			assert.equal(loadCeilings(link, "test", EXE_DEV_PLATFORM).ok, false);
			assert.equal(loadCeilings(dir, "test", EXE_DEV_PLATFORM).ok, false);

			for (const mode of [0o664, 0o646]) {
				chmodSync(path, mode);
				assert.equal(
					loadCeilings(path, "test", EXE_DEV_PLATFORM).ok,
					false,
					mode.toString(8),
				);
			}

			const empty = join(dir, "empty.json");

			writeFileSync(empty, "{}", { mode: 0o644 });
			assert.equal(
				loadCeilings(empty, "production", EXE_DEV_PLATFORM).ok,
				process.geteuid?.() === 0,
				"production trusts only a root-owned ceiling file",
			);
			assert.equal(loadCeilings(empty, "test", EXE_DEV_PLATFORM).ok, true);
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});

	it("refuses a ceiling that places its secret in a routing or framing header", () => {
		const authorization =
			'{"kind":"header","name":"Authorization","scheme":"Bearer"}';

		assert.ok(LINEAR_CEILING.includes(authorization));

		for (const name of [
			"host",
			"Host",
			":authority",
			"content-length",
			"transfer-encoding",
			"connection",
			"upgrade",
			"te",
			"trailer",
			"forwarded",
			"x-forwarded-for",
			"X-Forwarded-Host",
			"proxy-authorization",
			"proxy-connection",
			"keep-alive",
		]) {
			const text = LINEAR_CEILING.replace(
				authorization,
				JSON.stringify({ kind: "header", name, scheme: null }),
			);

			assert.equal(
				parseCeilings(text, "test", EXE_DEV_PLATFORM).ok,
				false,
				name,
			);
		}

		assert.equal(
			parseCeilings(
				LINEAR_CEILING.replace(
					authorization,
					'{"kind":"header","name":"X-Api-Key","scheme":null}',
				),
				"test",
				EXE_DEV_PLATFORM,
			).ok,
			true,
		);
	});

	it("refuses every header the client filter treats as retargeting, from one shared list", () => {
		const authorization =
			'{"kind":"header","name":"Authorization","scheme":"Bearer"}';

		for (const name of [
			"x-host",
			"x-original-url",
			"x-rewrite-url",
			"x-http-method-override",
			"x-forwarded",
		]) {
			const text = LINEAR_CEILING.replace(
				authorization,
				JSON.stringify({ kind: "header", name, scheme: null }),
			);

			assert.equal(
				parseCeilings(text, "test", EXE_DEV_PLATFORM).ok,
				false,
				name,
			);
		}
	});

	it("refuses a ceiling that places its secret in a method override or a header the gateway sets", () => {
		const authorization =
			'{"kind":"header","name":"Authorization","scheme":"Bearer"}';

		for (const name of [
			"x-method-override",
			"X-HTTP-Method",
			"accept-encoding",
			"User-Agent",
		]) {
			const text = LINEAR_CEILING.replace(
				authorization,
				JSON.stringify({ kind: "header", name, scheme: null }),
			);

			assert.equal(
				parseCeilings(text, "test", EXE_DEV_PLATFORM).ok,
				false,
				name,
			);
		}
	});

	it("refuses to bind a route that places its secret in a routing header", () => {
		const placement = { kind: "header", name: "Host", scheme: null } as const;
		const route = credentialedRoute(443);

		const parsed = parseCeilings(
			LINEAR_CEILING.replace(
				'{"kind":"header","name":"Authorization","scheme":"Bearer"}',
				'{"kind":"header","name":"X-Api-Key","scheme":null}',
			),
			"test",
			EXE_DEV_PLATFORM,
		);

		assert.ok(parsed.ok);

		const ceiling = parsed.ceilings.get(id("echo-read"));

		assert.ok(ceiling);

		const bound = bindCredentials(
			tableWith([
				{
					...route,
					credential: { id: id("echo-read"), placement },
				},
			]),
			new Map([[id("echo-read"), { ...ceiling, placement }]]),
			new Map([[id("echo-read"), Buffer.from(ECHO_SECRET)]]),
		);

		assert.equal(bound.ok, false);
	});

	it("refuses ceilings that point at exe.dev, GitHub, npm or an IP literal", () => {
		for (const host of [
			"github.int.exe.xyz",
			"api.github.com",
			"registry.npmjs.org",
			"10.0.0.1",
		]) {
			assert.equal(
				parseCeilings(
					LINEAR_CEILING.replace("echo.test", host),
					"test",
					EXE_DEV_PLATFORM,
				).ok,
				false,
				host,
			);
		}
	});

	it("only lets a route narrow its ceiling", () => {
		const secrets = new Map([[id("echo-read"), Buffer.from(ECHO_SECRET)]]);

		const bind = (route: Route) =>
			bindCredentials(tableWith([route]), ceilings(), secrets).ok;

		assert.equal(bind(credentialedRoute(443)), true);
		assert.equal(
			bind(
				credentialedRoute(443, {
					paths: [{ kind: "exact", path: "api/issues" }],
				}),
			),
			true,
		);
		assert.equal(bind(credentialedRoute(443, { methods: ["GET"] })), true);
		assert.equal(
			bind(
				credentialedRoute(443, { paths: [{ kind: "glob", pattern: "**" }] }),
			),
			false,
		);
		assert.equal(
			bind(
				credentialedRoute(443, { paths: [{ kind: "prefix", prefix: "apix" }] }),
			),
			false,
		);
		assert.equal(bind(credentialedRoute(8443)), false);
		assert.equal(
			bind(
				credentialedRoute(443, {
					credential: {
						id: id("echo-read"),
						placement: { kind: "header", name: "X-Api-Key", scheme: null },
					},
				}),
			),
			false,
		);
		assert.equal(
			bind(
				credentialedRoute(443, {
					credential: {
						id: id("unknown"),
						placement: {
							kind: "header",
							name: "Authorization",
							scheme: "Bearer",
						},
					},
				}),
			),
			false,
		);
		assert.equal(
			bindCredentials(
				tableWith([credentialedRoute(443)]),
				ceilings(),
				new Map(),
			).ok,
			false,
		);
	});

	it("decides path-rule narrowing on segment boundaries", () => {
		assert.equal(
			pathRuleWithin(
				{ kind: "exact", path: "a/b" },
				{ kind: "prefix", prefix: "a" },
			),
			true,
		);
		assert.equal(
			pathRuleWithin(
				{ kind: "prefix", prefix: "a/b" },
				{ kind: "prefix", prefix: "a" },
			),
			true,
		);
		assert.equal(
			pathRuleWithin(
				{ kind: "prefix", prefix: "a" },
				{ kind: "exact", path: "a" },
			),
			false,
		);
		assert.equal(
			pathRuleWithin(
				{ kind: "glob", pattern: "a/*" },
				{ kind: "glob", pattern: "a/**" },
			),
			true,
		);
		assert.equal(
			pathRuleWithin(
				{ kind: "glob", pattern: "*/b" },
				{ kind: "glob", pattern: "a/*" },
			),
			false,
		);
		assert.equal(
			pathRuleWithin(
				{ kind: "prefix", prefix: "a" },
				{ kind: "glob", pattern: "a/**" },
			),
			false,
		);
		assert.equal(
			pathRuleWithin(
				{ kind: "prefix", prefix: "a/b" },
				{ kind: "glob", pattern: "a/**" },
			),
			true,
		);
		assert.equal(
			pathRuleWithin(
				{ kind: "glob", pattern: "a/**" },
				{ kind: "prefix", prefix: "a" },
			),
			true,
		);
		assert.equal(
			pathRuleWithin(
				{ kind: "exact", path: "b" },
				{ kind: "glob", pattern: "*" },
			),
			true,
		);
	});
});

describe("credential secrets", () => {
	it("loads each referenced secret from the credentials directory and nothing else", () => {
		const dir = mkdtempSync(join(tmpdir(), "factory-creds-"));

		try {
			writeFileSync(join(dir, "echo-read"), ECHO_SECRET);
			writeFileSync(join(dir, "newline"), `${ECHO_SECRET}\n`);
			writeFileSync(join(dir, "empty"), "");

			const loaded = loadSecrets(dir, [id("echo-read")]);

			assert.ok(loaded.ok);
			assert.equal(
				loaded.secrets.get(id("echo-read"))?.toString(),
				ECHO_SECRET,
			);
			assert.equal(loadSecrets(dir, [id("newline")]).ok, false);
			assert.equal(loadSecrets(dir, [id("empty")]).ok, false);
			assert.equal(loadSecrets(dir, [id("missing")]).ok, false);
			assert.equal(loadSecrets(undefined, [id("echo-read")]).ok, false);
			assert.equal(loadSecrets(undefined, []).ok, true);
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});

	it("refuses a secret shorter than 16 bytes", () => {
		const dir = mkdtempSync(join(tmpdir(), "factory-creds-"));

		try {
			for (const [name, length] of [
				["one", 1],
				["fifteen", 15],
				["sixteen", 16],
			] as const) {
				writeFileSync(join(dir, name), "k".repeat(length));
				assert.equal(loadSecrets(dir, [id(name)]).ok, length >= 16, name);
			}
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});
});

describe("credential header strip and inject", () => {
	it("recognises the credential header family", () => {
		for (const name of [
			"Authorization",
			"proxy-authorization",
			"Cookie",
			"X-Api-Key",
			"openai-api-key",
			"x-auth-token",
			"GitHub-Token",
		]) {
			assert.equal(isCredentialHeader(name), true, name);
		}

		assert.equal(isCredentialHeader("accept"), false);
	});

	it("builds the upstream head from scratch: Host, allowlisted headers, credential last", () => {
		const route = credentialedRoute(443);

		const headers = buildUpstreamHeaders(
			route,
			[
				"Host",
				"127.0.0.1:18080",
				"Accept",
				"text/plain",
				"Authorization",
				"Bearer forged",
				"Cookie",
				"a=b",
				"X-Api-Key",
				"forged",
				"X-Custom",
				"dropped",
			],
			12,
			["Authorization", `Bearer ${ECHO_SECRET}`],
		);

		assert.deepEqual(headers, [
			["Host", "echo.test"],
			["accept", "text/plain"],
			["User-Agent", "factory-gateway/1"],
			["Accept-Encoding", "identity"],
			["Connection", "close"],
			["Content-Length", "12"],
			["Authorization", `Bearer ${ECHO_SECRET}`],
		]);
	});

	it("never copies the client Host upstream, even when a route lists host", () => {
		const headers = buildUpstreamHeaders(
			credentialedRoute(443, { requestHeaders: ["accept", "host", "HOST"] }),
			["Host", "127.0.0.1:18080", "host", "evil.test", "Accept", "text/plain"],
			0,
			null,
		);

		assert.deepEqual(
			headers.filter(([name]) => name.toLowerCase() === "host"),
			[["Host", "echo.test"]],
		);
		assert.deepEqual(headers[1], ["accept", "text/plain"]);
	});

	it("never copies auth or cookie headers back, even when a route lists them", () => {
		const copied = responseHeadersFor(credentialedRoute(443), [
			"Content-Type",
			"application/json",
			"Set-Cookie",
			"session=1",
			"WWW-Authenticate",
			"Bearer",
			"X-Echo",
			"ok",
			"X-Unlisted",
			"no",
		]);

		assert.deepEqual(copied, [
			["content-type", "application/json"],
			["x-echo", "ok"],
		]);
	});
});

describe("reflection scanning", () => {
	const placement = {
		kind: "header",
		name: "Authorization",
		scheme: "Bearer",
	} as const;

	const forms = secretForms(Buffer.from(ECHO_SECRET), placement);

	it("covers the raw, base64 and percent-encoded forms", () => {
		const scanner = new SecretScanner(forms);

		assert.equal(scanner.contains(`x ${ECHO_SECRET} y`), true);
		assert.equal(
			scanner.contains(Buffer.from(ECHO_SECRET).toString("base64")),
			true,
		);
		assert.equal(
			scanner.contains(Buffer.from(ECHO_SECRET).toString("base64url")),
			true,
		);
		assert.equal(
			scanner.contains(
				[...Buffer.from(ECHO_SECRET)]
					.map((byte) => `%${byte.toString(16).toUpperCase()}`)
					.join(""),
			),
			true,
		);
		assert.equal(scanner.contains("nothing here"), false);
		assert.equal(new SecretScanner([]).contains(ECHO_SECRET), false);
	});

	it("covers the encoded Basic pair", () => {
		const basic = secretForms(Buffer.from(ECHO_SECRET), {
			kind: "basic",
			username: "bot",
		});

		assert.equal(
			new SecretScanner(basic).contains(
				Buffer.from(`bot:${ECHO_SECRET}`).toString("base64"),
			),
			true,
		);
	});

	it("holds back enough bytes to catch a secret split across chunks", () => {
		const filter = new ReflectionFilter(forms);
		const text = `prefix-${ECHO_SECRET}-suffix`;
		const cut = text.indexOf(ECHO_SECRET) + 5;
		const first = filter.push(Buffer.from(text.slice(0, cut)));

		assert.equal(first.kind, "pass");
		assert.equal(
			first.kind === "pass" && first.bytes.includes(ECHO_SECRET.slice(0, 5)),
			false,
		);
		assert.equal(filter.push(Buffer.from(text.slice(cut))).kind, "blocked");
	});

	it("finds the secret JSON-escaped, percent-encoded in part or base64 at any offset, across chunks", () => {
		const escaped = [...ECHO_SECRET]
			.map((char) => `\\u${char.charCodeAt(0).toString(16).padStart(4, "0")}`)
			.join("");

		const bodies = [
			`{"echo":"${escaped}"}`,
			`{"echo":"${ECHO_SECRET.slice(0, 4)}\\u00${ECHO_SECRET.charCodeAt(4).toString(16)}${ECHO_SECRET.slice(5)}"}`,
			`q=%${ECHO_SECRET.charCodeAt(0).toString(16)}${ECHO_SECRET.slice(1)}`,
			Buffer.from(`x${ECHO_SECRET}tail`).toString("base64"),
			Buffer.from(`xy${ECHO_SECRET}tail`).toString("base64url"),
			`prefix ${Buffer.from(`${ECHO_SECRET}tail`).toString("base64")}`,
		];

		for (const text of bodies) {
			for (const cut of [1, Math.floor(text.length / 2), text.length - 1]) {
				const filter = new ReflectionFilter(forms);
				const first = filter.push(Buffer.from(text.slice(0, cut)));

				const second =
					first.kind === "blocked"
						? first
						: filter.push(Buffer.from(text.slice(cut)));

				const last = second.kind === "blocked" ? second : filter.end();

				assert.equal(last.kind, "blocked", `${text} @${cut}`);
			}
		}
	});

	it("refuses a body that starts with a gzip, zlib, brotli or zstd magic number", () => {
		for (const head of [
			gzipSync(Buffer.from("hello")),
			deflateSync(Buffer.from("hello")),
			Buffer.from([0xce, 0xb2, 0xcf, 0x81, 0x00]),
			Buffer.from([0x28, 0xb5, 0x2f, 0xfd, 0x00]),
		]) {
			const filter = new ReflectionFilter(forms);
			const first = filter.push(head.subarray(0, 1));

			assert.equal(first.kind === "pass" && first.bytes.length, 0);
			assert.equal(filter.push(head.subarray(1)).kind, "blocked");
		}

		const short = new ReflectionFilter(forms);

		short.push(Buffer.from([0x1f, 0x8b]));
		assert.equal(short.end().kind, "blocked");
	});

	it("refuses raw deflate, unframed brotli and gzip after a text prefix, at any chunking", () => {
		const leak = Buffer.from(`leak ${ECHO_SECRET}`);

		const bodies: [string, Buffer][] = [
			["raw deflate", deflateRawSync(leak)],
			[
				"unframed brotli",
				brotliCompressSync(
					Buffer.from(`${"A".repeat(64)}${ECHO_SECRET}${"B".repeat(64)}`),
				),
			],
			[
				"gzip after a prefix",
				Buffer.concat([Buffer.from('{"data":"'), gzipSync(leak)]),
			],
		];

		for (const [name, body] of bodies) {
			for (const size of [1, 3, body.length]) {
				const filter = new ReflectionFilter(forms);
				const passed: Buffer[] = [];
				let blocked = false;

				for (let at = 0; at < body.length && !blocked; at += size) {
					const step = filter.push(body.subarray(at, at + size));

					if (step.kind === "pass") passed.push(step.bytes);
					else blocked = true;
				}

				assert.equal(
					blocked || filter.end().kind === "blocked",
					true,
					`${name} in ${size}-byte chunks`,
				);
				assert.equal(
					passed.every((bytes) => bytes.every((byte) => byte >= 0x20)),
					true,
					`${name}: no binary byte passes`,
				);
			}
		}
	});

	it("finds the secret as mixed-case hex and as base64 split by '*' or form feeds, across 3-byte chunks", () => {
		const leak = Buffer.from(`leak ${ECHO_SECRET}`);
		const base64 = leak.toString("base64");
		let letters = 0;

		const mixedHex = [...leak.toString("hex")]
			.map((char) => {
				if (!/[a-f]/.test(char)) return char;

				letters += 1;

				return letters % 2 === 0 ? char.toUpperCase() : char;
			})
			.join("");

		const bodies: [string, string][] = [
			["mixed-case hex", mixedHex],
			["base64 split by *", [...base64].join("*")],
			[
				"base64 split by form feeds",
				(base64.match(/.{1,4}/g) ?? []).join("\f"),
			],
		];

		for (const [name, body] of bodies) {
			assert.notEqual(body, body.toLowerCase(), name);

			const bytes = Buffer.from(body);
			const filter = new ReflectionFilter(forms);
			let blocked = false;

			for (let at = 0; at < bytes.length && !blocked; at += 3) {
				blocked = filter.push(bytes.subarray(at, at + 3)).kind === "blocked";
			}

			assert.equal(blocked || filter.end().kind === "blocked", true, name);
			assert.equal(new SecretScanner(forms).reveals(body), true, name);
		}
	});

	it("passes text whose first two bytes happen to form a zlib header", () => {
		for (const text of ["x^2 + 1", "x^", "80 items", "HKEY", "(4) items"]) {
			const [first = 0, second = 0] = Buffer.from(text);

			assert.equal(((first << 8) | second) % 31, 0, text);

			const filter = new ReflectionFilter(forms);
			const step = filter.push(Buffer.from(text));
			const rest = filter.end();

			assert.ok(step.kind === "pass" && rest.kind === "pass", text);
			assert.equal(
				Buffer.concat([step.bytes, rest.bytes]).toString(),
				text,
				text,
			);
		}
	});

	it("passes UTF-8 text with tabs, line breaks and form feeds unchanged", () => {
		const body = Buffer.from('{"note":"caf\u00e9 \u2713"}\n\tline\r\n\fpage');
		const filter = new ReflectionFilter(forms);
		const first = filter.push(body.subarray(0, 13));
		const second = filter.push(body.subarray(13));
		const rest = filter.end();

		assert.ok(
			first.kind === "pass" && second.kind === "pass" && rest.kind === "pass",
		);
		assert.deepEqual(
			Buffer.concat([first.bytes, second.bytes, rest.bytes]),
			body,
		);
	});

	it("finds the secret as hex, UTF-16 and whitespace-wrapped base64, across 3-byte chunks", () => {
		const leak = `leak ${ECHO_SECRET}`;
		const utf16be = Buffer.from(leak, "utf16le").swap16();

		const bodies: [string, Buffer][] = [
			["hex", Buffer.from(Buffer.from(leak).toString("hex"))],
			["HEX", Buffer.from(Buffer.from(leak).toString("hex").toUpperCase())],
			["utf16le", Buffer.from(leak, "utf16le")],
			["utf16be", utf16be],
			[
				"wrapped base64",
				Buffer.from(
					(
						Buffer.from(leak)
							.toString("base64")
							.match(/.{1,4}/g) ?? []
					).join("\n"),
				),
			],
		];

		for (const [name, body] of bodies) {
			const filter = new ReflectionFilter(forms);
			let blocked = false;

			for (let at = 0; at < body.length && !blocked; at += 3) {
				blocked = filter.push(body.subarray(at, at + 3)).kind === "blocked";
			}

			assert.equal(blocked || filter.end().kind === "blocked", true, name);
		}
	});

	it("passes clean bytes through unchanged", () => {
		const filter = new ReflectionFilter(forms);
		const parts = ["hello ", "world, ", "nothing secret ", "in this body"];
		const out: Buffer[] = [];

		for (const part of parts) {
			const result = filter.push(Buffer.from(part));

			assert.equal(result.kind, "pass");

			if (result.kind === "pass") out.push(result.bytes);
		}

		const rest = filter.end();

		assert.equal(rest.kind, "pass");

		if (rest.kind === "pass") out.push(rest.bytes);

		assert.equal(Buffer.concat(out).toString(), parts.join(""));
	});

	const filtered = (body: Buffer, size: number) => {
		const filter = new ReflectionFilter(forms);
		const passed: Buffer[] = [];

		for (let at = 0; at < body.length; at += size) {
			const step = filter.push(body.subarray(at, at + size));

			if (step.kind === "blocked") {
				return { blocked: true, out: Buffer.concat(passed) };
			}

			passed.push(step.bytes);
		}

		const rest = filter.end();

		if (rest.kind === "blocked") {
			return { blocked: true, out: Buffer.concat(passed) };
		}

		return { blocked: false, out: Buffer.concat([...passed, rest.bytes]) };
	};

	it("finds the secret as mixed-case hex with spaces between the pairs", () => {
		const hex = Buffer.from(`leak ${ECHO_SECRET}`).toString("hex");

		let letters = 0;

		const spaced = [...hex]
			.map((char) => {
				if (!/[a-f]/.test(char)) return char;

				letters += 1;

				return letters % 2 === 0 ? char.toUpperCase() : char;
			})
			.join("")
			.replace(/(.{2})/g, "$1 ")
			.trim();

		assert.notEqual(spaced, spaced.toLowerCase());

		for (const size of [1, 3, spaced.length]) {
			const result = filtered(Buffer.from(spaced), size);

			assert.equal(result.blocked, true, `${size}-byte chunks`);
			assert.equal(result.out.length, 0, `${size}-byte chunks`);
		}
	});

	it("finds base64 split by non-alphabet runs longer than the hold, at any chunking", () => {
		const base64 = Buffer.from(`leak ${ECHO_SECRET}`).toString("base64");
		const hold = Math.max(...forms.map((form) => form.length)) * 6 - 1;

		for (const gap of ["!", "\n"]) {
			const body = Buffer.from([...base64].join(gap.repeat(hold + 8)));

			for (const size of [1, 64, body.length]) {
				const result = filtered(body, size);

				assert.equal(
					result.blocked,
					true,
					`${JSON.stringify(gap)} gaps in ${size}-byte chunks`,
				);
				assert.equal(
					result.out.length,
					0,
					`${JSON.stringify(gap)} gaps in ${size}-byte chunks: no byte passes`,
				);
			}
		}
	});

	it("passes no byte of a clean body until it ends, then all of it", () => {
		const body = Buffer.from(`{"items":"${"clean text ".repeat(400)}"}`);
		const filter = new ReflectionFilter(forms);
		let passed = 0;

		for (let at = 0; at < body.length; at += 64) {
			const step = filter.push(body.subarray(at, at + 64));

			assert.equal(step.kind, "pass", `@${at}`);
			passed += step.kind === "pass" ? step.bytes.length : 0;
		}

		assert.equal(passed, 0);

		const rest = filter.end();

		assert.equal(rest.kind, "pass");
		assert.equal(rest.kind === "pass" && rest.bytes.equals(body), true);
	});

	it("blocks a body over the cap with no byte passed, and passes one at the cap byte for byte", () => {
		const over = Buffer.alloc(CREDENTIALED_RESPONSE_MAX_BYTES + 1, "a");

		for (const size of [64 * 1024, over.length]) {
			const result = filtered(over, size);

			assert.equal(result.blocked, true, `${size}-byte chunks`);
			assert.equal(result.out.length, 0, `${size}-byte chunks`);
		}

		const at = over.subarray(0, CREDENTIALED_RESPONSE_MAX_BYTES);
		const clean = filtered(at, 64 * 1024);

		assert.equal(clean.blocked, false);
		assert.equal(clean.out.length, at.length);
		assert.equal(clean.out.equals(at), true);
	});

	it("refuses a C1 control character, whole or split across chunks", () => {
		for (const text of ['{"note":"caf\u0085 next"}', "plain text \u009f end"]) {
			const body = Buffer.from(text);

			for (const size of [1, 3, body.length]) {
				const result = filtered(body, size);

				assert.equal(result.blocked, true, `${text} in ${size}-byte chunks`);
				assert.equal(result.out.includes(Buffer.from([0xc2])), false, text);
			}
		}
	});

	it("passes non-ASCII text and emoji unchanged at any chunking", () => {
		const body = Buffer.from(
			'{"title":"caf\u00e9 \u{1f600} \u65e5\u672c\u8a9e \u00a0\u00ff\u0100","ok":true}\n',
		);

		for (const size of [1, 2, 3, body.length]) {
			const result = filtered(body, size);

			assert.equal(result.blocked, false, `${size}-byte chunks`);
			assert.deepEqual(result.out, body, `${size}-byte chunks`);
		}

		const large = Buffer.from(
			`{"items":[${Array.from({ length: 4000 }, (_, index) => `{"i":${index},"t":"caf\u00e9 \u{1f600}"}`).join(",")}]}`,
		);

		const result = filtered(large, 1024);

		assert.equal(result.blocked, false);
		assert.equal(result.out.equals(large), true);
	});
});
