import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import {
	bindCredentials,
	buildUpstreamHeaders,
	type Ceilings,
	isCredentialHeader,
	loadSecrets,
	parseCeilings,
	pathRuleWithin,
	ReflectionFilter,
	responseHeadersFor,
	SecretScanner,
	secretForms,
} from "../../server/sandbox/credentials.ts";
import {
	type CredentialId,
	credentialId,
	type Route,
	type RouteTable,
} from "../../server/sandbox/routes.ts";
import { modelTable } from "./routes.cases.ts";

export const ECHO_SECRET = "fixture-secret-7Hq2-not-real";

function id(text: string): CredentialId {
	const parsed = credentialId(text);

	assert.ok(parsed);

	return parsed;
}

export const LINEAR_CEILING = JSON.stringify({
	"echo-read": {
		scheme: "http",
		host: "echo.test",
		port: 443,
		placement: { kind: "header", name: "Authorization", scheme: "Bearer" },
		methods: ["GET", "HEAD"],
		paths: [{ kind: "prefix", prefix: "api" }],
	},
});

export function credentialedRoute(
	port: number,
	overrides: Partial<Route> = {},
): Route {
	const npm = modelTable().routes.find((route) => route.id === "npm");

	assert.ok(npm);

	return {
		...npm,
		id: routeIdOf("echo-read"),
		prefix: "/echo/",
		upstream: {
			scheme: "http",
			host: "echo.test",
			port,
			basePath: "/",
			hostHeader: "echo.test",
			sni: "echo.test",
			address: { kind: "pinned", ip: "127.0.0.1" },
		},
		methods: ["GET", "HEAD"],
		paths: [{ kind: "prefix", prefix: "api" }],
		requestHeaders: ["accept", "authorization", "cookie", "x-api-key"],
		responseHeaders: [
			"content-type",
			"location",
			"set-cookie",
			"www-authenticate",
			"x-echo",
		],
		credential: {
			id: id("echo-read"),
			placement: { kind: "header", name: "Authorization", scheme: "Bearer" },
		},
		budget: false,
		audit: "detailed",
		...overrides,
	};
}

function routeIdOf(text: string): Route["id"] {
	assert.match(text, /^[a-z][a-z0-9-]{0,31}$/);

	// SAFETY: the assertion above checks the RouteId pattern.
	return text as Route["id"];
}

function tableWith(routes: readonly Route[]): RouteTable {
	return { ...modelTable(), routes };
}

function ceilings(text: string = LINEAR_CEILING): Ceilings {
	const parsed = parseCeilings(text, "test");

	assert.ok(parsed.ok);

	return parsed.ceilings;
}

describe("credential ceilings", () => {
	it("parses the owner's ceiling file strictly", () => {
		const parsed = ceilings();

		assert.deepEqual([...parsed.keys()], ["echo-read"]);
		assert.equal(parseCeilings("{}", "production").ok, true);
		assert.equal(parseCeilings("not json", "production").ok, false);
		assert.equal(parseCeilings(LINEAR_CEILING, "production").ok, false);
		assert.equal(
			parseCeilings(
				LINEAR_CEILING.replace('"methods"', '"extra":1,"methods"'),
				"test",
			).ok,
			false,
		);
	});

	it("refuses ceilings that point at exe.dev, GitHub, npm or an IP literal", () => {
		for (const host of [
			"github.int.exe.xyz",
			"api.github.com",
			"registry.npmjs.org",
			"10.0.0.1",
		]) {
			assert.equal(
				parseCeilings(LINEAR_CEILING.replace("echo.test", host), "test").ok,
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

	it("passes clean bytes through unchanged", () => {
		const filter = new ReflectionFilter(forms);
		const parts = ["hello ", "world, ", "nothing secret ", "in this body"];
		const out: Buffer[] = [];

		for (const part of parts) {
			const result = filter.push(Buffer.from(part));

			assert.equal(result.kind, "pass");

			if (result.kind === "pass") out.push(result.bytes);
		}

		out.push(filter.end());
		assert.equal(Buffer.concat(out).toString(), parts.join(""));
	});
});
