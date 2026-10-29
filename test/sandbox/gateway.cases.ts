import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { lstatSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { request } from "node:http";
import { connect } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, describe, it } from "node:test";
import { AuditLog, type AuditRecord } from "../../server/sandbox/audit.ts";
import {
	type ControlEvent,
	encodeCommand,
	parseEvent,
} from "../../server/sandbox/control.ts";
import {
	bindCredentials,
	type CredentialBinding,
	parseCeilings,
} from "../../server/sandbox/credentials.ts";
import {
	type EchoFixture,
	startEchoFixture,
} from "../../server/sandbox/echo-fixture.ts";
import {
	addressAllowed,
	dialOrder,
	Gateway,
	refusedAddresses,
} from "../../server/sandbox/gateway.ts";
import { DENY_CODES } from "../../server/sandbox/policy.ts";
import {
	type Route,
	type RouteId,
	type RouteTable,
} from "../../server/sandbox/routes.ts";
import {
	credentialedRoute,
	ECHO_SECRET,
	LINEAR_CEILING,
} from "./credentials.cases.ts";
import { modelTable } from "./routes.cases.ts";

const HOST = "127.0.0.1:18080";

// Only root can listen below 1024, so unlike a freed ephemeral port no other
// local process can take this one before the gateway dials it.
const REFUSED_PORT = 1;

type Reply = {
	status: number;
	code: string | null;
	body: string;
	headers: Record<string, string | string[] | undefined>;
	aborted: boolean;
};

function call(
	socketPath: string,
	method: string,
	path: string,
	headers: Record<string, string> = {},
	body: string | null = null,
): Promise<Reply> {
	return new Promise((done) => {
		const chunks: Buffer[] = [];

		const req = request(
			{
				socketPath,
				method,
				path,
				headers: { Host: HOST, ...headers },
				setHost: false,
			},
			(res) => {
				res.on("data", (chunk: Buffer) => chunks.push(chunk));
				res.on("end", () =>
					done({
						status: res.statusCode ?? 0,
						code: String(res.headers["x-proxy-error"] ?? "") || null,
						body: Buffer.concat(chunks).toString(),
						headers: res.headers,
						aborted: false,
					}),
				);
				res.on("error", () =>
					done({
						status: res.statusCode ?? 0,
						code: null,
						body: Buffer.concat(chunks).toString(),
						headers: res.headers,
						aborted: true,
					}),
				);
			},
		);

		req.on("error", () =>
			done({
				status: 0,
				code: null,
				body: Buffer.concat(chunks).toString(),
				headers: {},
				aborted: true,
			}),
		);
		req.end(body ?? undefined);
	});
}

function raw(socketPath: string, text: string): Promise<string> {
	return new Promise((done) => {
		const socket = connect(socketPath);
		const chunks: Buffer[] = [];

		socket.on("connect", () => socket.write(text));
		socket.on("data", (chunk: Buffer) => chunks.push(chunk));
		socket.on("close", () => done(Buffer.concat(chunks).toString()));
		socket.on("error", () => done(Buffer.concat(chunks).toString()));
	});
}

function rawCode(text: string): string | null {
	if (!text.startsWith("HTTP/1.1 403")) return null;

	return /\r\nx-proxy-error: ([a-z-]+)\r\n/i.exec(text)?.[1] ?? null;
}

function asRouteId(text: string): RouteId {
	assert.match(text, /^[a-z][a-z0-9-]{0,31}$/);

	// SAFETY: the assertion above checks the RouteId pattern.
	return text as RouteId;
}

function fixtureModelRoute(port: number, base: Route): Route {
	return {
		...base,
		upstream: {
			scheme: "http",
			host: "llm.test",
			port,
			basePath: base.prefix,
			hostHeader: "llm.test",
			sni: "llm.test",
			address: { kind: "pinned", ip: "127.0.0.1" },
		},
		paths: [
			...base.paths,
			{ kind: "exact", path: "slow" },
			{ kind: "exact", path: "hang" },
		],
		limits: { ...base.limits, headersTimeoutMs: 300 },
	};
}

function testTable(
	port: number,
	options: { ceilingTokens?: number } = {},
): RouteTable {
	const table = modelTable();
	const [openai, xai, npm] = table.routes;

	assert.ok(openai && xai && npm);

	return {
		...table,
		ceiling: {
			modelTokens: options.ceilingTokens ?? 1_000_000,
			modelRequests: 1000,
		},
		routes: [
			fixtureModelRoute(port, openai),
			fixtureModelRoute(port, xai),
			{
				...npm,
				id: asRouteId("plain"),
				prefix: "/plain/",
				upstream: { ...credentialedRoute(port).upstream },
				responseHeaders: ["content-type", "location", "x-echo", "set-cookie"],
				requestHeaders: ["accept", "authorization"],
			},
			{
				...npm,
				id: asRouteId("limited"),
				prefix: "/limited/",
				upstream: { ...credentialedRoute(port).upstream },
				limits: { ...npm.limits, perMinute: 1 },
			},
			{
				...npm,
				id: asRouteId("resolved"),
				prefix: "/resolved/",
				upstream: {
					...credentialedRoute(port).upstream,
					address: { kind: "resolve" },
				},
			},
			credentialedRoute(port),
		],
	};
}

function binding(table: RouteTable): CredentialBinding {
	const ceilings = parseCeilings(
		LINEAR_CEILING.replace("443", String(table.routes[5]?.upstream.port)),
		"test",
	);

	assert.ok(ceilings.ok);

	const bound = bindCredentials(
		table,
		ceilings.ceilings,
		new Map([
			[
				credentialedRoute(0).credential?.id ?? asCredential(),
				Buffer.from(ECHO_SECRET),
			],
		]),
	);

	assert.ok(bound.ok);

	return bound;
}

function asCredential(): never {
	throw new Error("credentialed route lost its credential");
}

type Harness = {
	gateway: Gateway;
	socketPath: string;
	events: ControlEvent[];
	audit: AuditRecord[];
	failAudit: { on: boolean };
};

async function startHarness(
	dir: string,
	port: number,
	options: {
		ceilingTokens?: number;
		lookup?: (host: string) => Promise<string[]>;
	} = {},
): Promise<Harness> {
	const table = testTable(port, options);
	const events: ControlEvent[] = [];
	const audit: AuditRecord[] = [];
	const failAudit = { on: false };

	const socketPath = join(
		dir,
		`gw-${Math.random().toString(16).slice(2)}.sock`,
	);

	const gateway = new Gateway({
		table,
		credentials: binding(table),
		audit: new AuditLog((text) => {
			if (failAudit.on) throw new Error("EIO");

			audit.push(JSON.parse(text));
		}, 1_000_000),
		emit: (event) => events.push(event),
		lookup: options.lookup ?? (async () => ["10.1.2.3"]),
	});

	await gateway.listen(socketPath);

	return { gateway, socketPath, events, audit, failAudit };
}

describe("upstream address checks", () => {
	it("allows public IPv4 and IPv6 and refuses private, mapped and NAT64 forms", () => {
		const refused = refusedAddresses();

		for (const address of ["104.16.2.34", "2606:4700::6810:b22"]) {
			assert.equal(addressAllowed(address, refused), true, address);
		}

		for (const address of [
			"127.0.0.1",
			"10.1.2.3",
			"100.100.1.1",
			"169.254.169.254",
			"::1",
			"::ffff:104.16.2.34",
			"::ffff:169.254.169.254",
			"64:ff9b::a9fe:a9fe",
			"fd00::1",
			"not-an-ip",
		]) {
			assert.equal(addressAllowed(address, refused), false, address);
		}
	});
});

describe("upstream dial order", () => {
	it("tries every IPv4 address before any IPv6 one, keeping resolver order within each", () => {
		assert.deepEqual(
			dialOrder([
				"2606:4700::6810:b22",
				"104.16.1.34",
				"2606:4700::6810:22",
				"104.16.0.34",
			]),
			[
				"104.16.1.34",
				"104.16.0.34",
				"2606:4700::6810:b22",
				"2606:4700::6810:22",
			],
		);
	});
});

describe("echo fixture", () => {
	it("records only what the gateway sent, and answers any other local client 421", async () => {
		const fixture = await startEchoFixture(0);

		try {
			const stray = await new Promise<number>((done, fail) => {
				request({ host: "127.0.0.1", port: fixture.port, path: "/" }, (res) => {
					res.resume();
					done(res.statusCode ?? 0);
				})
					.on("error", fail)
					.end();
			});

			assert.equal(stray, 421);
			assert.deepEqual(fixture.received, []);
			assert.ok(fixture.strays >= 1, "other local clients may add strays");
		} finally {
			await fixture.close();
		}
	});
});

describe("gateway over a real unix socket", () => {
	let dir = "";
	let fixture: EchoFixture;
	let h: Harness;

	before(async () => {
		dir = mkdtempSync(join(tmpdir(), "factory-gw-"));
		fixture = await startEchoFixture(0);
		h = await startHarness(dir, fixture.port);
	});

	after(async () => {
		await h.gateway.close();
		await fixture.close();
		rmSync(dir, { recursive: true, force: true });
	});

	it("listens on a fresh socket and refuses an existing path", async () => {
		assert.equal(lstatSync(h.socketPath).isSocket(), true);
		await assert.rejects(
			new Gateway({
				table: testTable(fixture.port),
				credentials: binding(testTable(fixture.port)),
				audit: new AuditLog(() => {}, 1000),
				emit: () => {},
				lookup: async () => [],
			}).listen(h.socketPath),
		);
	});

	it("forwards a model request with the gateway's own Host and meters usage", async () => {
		const reply = await call(
			h.socketPath,
			"POST",
			"/openai/v1/responses",
			{ "Content-Type": "application/json", "X-Custom": "dropped" },
			JSON.stringify({
				model: "gpt-6.1-sol",
				stream: true,
				tools: [{ type: "function", name: "read" }],
			}),
		);

		assert.equal(reply.status, 200);
		assert.match(reply.body, /response\.completed/);

		const seen = fixture.received.at(-1);

		assert.equal(seen?.path, "/openai/v1/responses");
		assert.deepEqual(seen?.headerNames, [
			"host",
			"content-type",
			"user-agent",
			"accept-encoding",
			"connection",
			"content-length",
		]);
		assert.equal(seen?.host, "llm.test");

		const usage = h.events.filter((event) => event.event === "usage").at(-1);

		assert.deepEqual(usage, {
			event: "usage",
			route: "model-openai",
			decision: "forward",
			reason: null,
			status: 200,
			bytesIn:
				reply.body.length > 0
					? usage?.event === "usage"
						? usage.bytesIn
						: 0
					: 0,
			bytesOut: Buffer.byteLength(reply.body),
			inputTokens: 11,
			outputTokens: 5,
		});

		const line = h.audit.at(-1);

		assert.equal(line?.decision, "forward");
		assert.equal(line?.route, "model-openai");
		assert.deepEqual(line?.upstream, {
			host: "llm.test",
			sni: null,
			port: fixture.port,
			addr: "127.0.0.1",
			tls: null,
		});
		assert.equal(line?.inputTokens, 11);
	});

	it("returns every head-level deny code with a fixed body and no upstream", async () => {
		const before = fixture.received.length;

		const cases: [
			string,
			string,
			Record<string, string>,
			string | null,
			string,
		][] = [
			["TRACE", "/openai/v1/models", {}, null, "method-forbidden"],
			["GET", "/openai/v1/../x", {}, null, "ambiguous-path"],
			[
				"GET",
				"/openai/v1/models",
				{ Host: "github.int.exe.xyz" },
				null,
				"bad-host",
			],
			[
				"GET",
				"/openai/v1/models",
				{ "X-Forwarded-Host": "github.int.exe.xyz" },
				null,
				"forbidden-header",
			],
			["GET", "/github/zen", {}, null, "no-route"],
			["GET", "/xai/v1/models", {}, null, "route-closed"],
			["DELETE", "/openai/v1/models", {}, null, "method-not-allowed"],
			["GET", "/openai/v1/chat/completions", {}, null, "path-not-allowed"],
			["GET", "/openai/v1/models?x=1", {}, null, "query-not-allowed"],
			[
				"POST",
				"/openai/v1/responses",
				{ "Content-Type": "application/json" },
				JSON.stringify({ model: "gpt-6.1-sol", tools: [{ type: "mcp" }] }),
				"body-not-allowed",
			],
			[
				"GET",
				"/echo/api/echo",
				{ Accept: ECHO_SECRET },
				null,
				"secret-in-request",
			],
			[
				"POST",
				"/openai/v1/responses",
				{ "Content-Type": "application/json" },
				JSON.stringify({ model: "gpt-6.1-sol", input: ECHO_SECRET }),
				"secret-in-request",
			],
		];

		for (const [method, path, headers, body, code] of cases) {
			const reply = await call(h.socketPath, method, path, headers, body);

			assert.equal(reply.status, 403, `${method} ${path}`);
			assert.equal(reply.code, code, `${method} ${path}`);
			assert.equal(
				reply.body,
				method === "HEAD" ? "" : `factory-gateway: denied: ${code}\n`,
			);
		}

		assert.equal(fixture.received.length, before);
		assert.equal(
			h.audit
				.filter((line) => line.decision === "deny")
				.every((line) => line.upstream === null),
			true,
		);
	});

	it("refuses CONNECT, absolute-form targets and Upgrade at the socket", async () => {
		assert.equal(
			rawCode(
				await raw(
					h.socketPath,
					`CONNECT github.int.exe.xyz:443 HTTP/1.1\r\nHost: ${HOST}\r\n\r\n`,
				),
			),
			"method-forbidden",
		);
		assert.equal(
			rawCode(
				await raw(
					h.socketPath,
					`GET http://github.int.exe.xyz/zen HTTP/1.1\r\nHost: ${HOST}\r\n\r\n`,
				),
			),
			"bad-request-target",
		);
		assert.equal(
			rawCode(
				await raw(
					h.socketPath,
					`GET /npm/x HTTP/1.1\r\nHost: ${HOST}\r\nConnection: Upgrade\r\nUpgrade: h2c\r\n\r\n`,
				),
			),
			"forbidden-header",
		);
	});

	it("answers a request the HTTP parser rejects with a fixed 403 and one audit line", async () => {
		const before = fixture.received.length;

		const inputs = [
			`TRACK /openai/v1/models HTTP/1.1\r\nHost: ${HOST}\r\n\r\n`,
			"PRI * HTTP/2.0\r\n\r\nSM\r\n\r\n",
			`POST /plain/x HTTP/1.1\r\nHost: ${HOST}\r\nContent-Length: 1\r\nTransfer-Encoding: chunked\r\n\r\n0\r\n\r\n`,
			"GET /npm/x HTTP/1.1\r\nHost \u0000 bad\r\n\r\n",
		];

		for (const text of inputs) {
			const lines = h.audit.length;
			const reply = await raw(h.socketPath, text);

			assert.match(reply, /^HTTP\/1\.1 403 /, text);
			assert.equal(rawCode(reply), "bad-request", text);
			assert.match(
				reply,
				/\r\n\r\nfactory-gateway: denied: bad-request\n$/,
				text,
			);
			assert.equal(h.audit.length, lines + 1, text);
			assert.equal(h.audit.at(-1)?.decision, "deny", text);
			assert.equal(h.audit.at(-1)?.reason, "bad-request", text);
			assert.equal(h.audit.at(-1)?.status, 403, text);
			assert.equal(h.audit.at(-1)?.upstream, null, text);
		}

		assert.equal(fixture.received.length, before);
	});

	it("refuses an oversized body while it streams in", async () => {
		const reply = await call(
			h.socketPath,
			"POST",
			"/openai/v1/responses",
			{ "Content-Type": "application/json", "Transfer-Encoding": "chunked" },
			"x".repeat(17 * 1024 * 1024),
		);

		assert.equal(
			reply.code ?? (reply.aborted ? "body-too-large" : null),
			"body-too-large",
		);
	});

	it("refuses a resolved upstream in a private range", async () => {
		const reply = await call(h.socketPath, "GET", "/resolved/api/echo");

		assert.equal(reply.code, "upstream-address-refused");
	});

	it("rate-limits a route over its per-minute budget", async () => {
		assert.equal(
			(await call(h.socketPath, "GET", "/limited/api/echo")).status,
			200,
		);
		assert.equal(
			(await call(h.socketPath, "GET", "/limited/api/echo")).code,
			"rate-limited",
		);
	});

	it("passes a 3xx back unfollowed on an uncredentialed route", async () => {
		const before = fixture.received.length;
		const reply = await call(h.socketPath, "GET", "/plain/api/redirect");

		assert.equal(reply.status, 302);
		assert.equal(reply.headers.location, "https://github.int.exe.xyz/zen");
		assert.equal(fixture.received.length, before + 1);
	});

	it("reports an unreachable upstream and a slow one with fixed codes", async () => {
		assert.equal(
			(await call(h.socketPath, "GET", "/openai/v1/hang")).code,
			"upstream-timeout",
		);
	});
});

describe("gateway credential engine against the echo fixture", () => {
	let dir = "";
	let fixture: EchoFixture;
	let h: Harness;

	before(async () => {
		dir = mkdtempSync(join(tmpdir(), "factory-gw-cred-"));
		fixture = await startEchoFixture(0);
		h = await startHarness(dir, fixture.port);
	});

	after(async () => {
		await h.gateway.close();
		await fixture.close();
		rmSync(dir, { recursive: true, force: true });
	});

	it("strips forged client credentials and injects the bound secret", async () => {
		const reply = await call(h.socketPath, "GET", "/echo/api/echo", {
			Authorization: "Bearer forged",
			Cookie: "session=forged",
			"X-Api-Key": "forged",
			Accept: "application/json",
		});

		assert.equal(reply.status, 200);

		const seen = fixture.received.at(-1);

		assert.equal(seen?.authorization, `Bearer ${ECHO_SECRET}`);
		assert.equal(seen?.headerNames.includes("cookie"), false);
		assert.equal(seen?.headerNames.includes("x-api-key"), false);
		assert.equal(seen?.host, "echo.test");
		assert.equal(reply.body.includes(ECHO_SECRET), false);
		assert.equal(h.audit.at(-1)?.credential, "echo-read");
	});

	it("scrubs auth and cookie headers from the response", async () => {
		const reply = await call(h.socketPath, "GET", "/echo/api/cookie");

		assert.equal(reply.status, 200);
		assert.equal(reply.headers["set-cookie"], undefined);
		assert.equal(reply.headers["www-authenticate"], undefined);
		assert.equal(reply.headers["x-echo"], "ok");
	});

	it("fails closed when the response carries the secret", async () => {
		const header = await call(h.socketPath, "GET", "/echo/api/reflect-header");

		assert.equal(header.code, "response-blocked");
		assert.equal(JSON.stringify(header).includes(ECHO_SECRET), false);

		for (const path of [
			"/echo/api/reflect-body",
			"/echo/api/reflect-base64",
			"/echo/api/reflect-split",
		]) {
			const body = await call(h.socketPath, "GET", path);

			assert.equal(body.aborted, true, path);
			assert.equal(body.body.includes(ECHO_SECRET), false, path);
			assert.equal(
				body.body.includes(Buffer.from(ECHO_SECRET).toString("base64")),
				false,
				path,
			);
			assert.equal(h.audit.at(-1)?.decision, "blocked_mid_stream", path);
		}
	});

	it("refuses redirects and compressed bodies on a credentialed route", async () => {
		const lines = h.audit.length;
		const redirect = await call(h.socketPath, "GET", "/echo/api/redirect");

		assert.equal(h.audit.length, lines + 1);
		assert.equal(h.audit.at(-1)?.reason, "redirect-refused");

		assert.equal(redirect.code, "redirect-refused");
		assert.equal(redirect.headers.location, undefined);
		assert.equal(
			(await call(h.socketPath, "GET", "/echo/api/gzip")).code,
			"response-blocked",
		);
	});

	it("never writes a loaded secret, or a credentialed route's raw path, into the audit", async () => {
		const percent = [...Buffer.from(ECHO_SECRET)]
			.map((byte) => `%${byte.toString(16).toUpperCase()}`)
			.join("");

		const mixed = `%${ECHO_SECRET.charCodeAt(0).toString(16)}${ECHO_SECRET.slice(1)}`;
		const lines = h.audit.length;

		for (const path of [
			`/echo/api/${ECHO_SECRET}`,
			`/echo/api/${percent}`,
			`/plain/api/${ECHO_SECRET}/x`,
			`/plain/api/x${mixed}`,
		]) {
			const reply = await call(h.socketPath, "GET", path);

			assert.equal(reply.code, "secret-in-request", path);
			assert.equal(h.audit.at(-1)?.path, "[redacted]", path);
		}

		assert.equal(
			rawCode(
				await raw(
					h.socketPath,
					`CONNECT ${ECHO_SECRET}:443 HTTP/1.1\r\nHost: ${HOST}\r\n\r\n`,
				),
			),
			"method-forbidden",
		);

		const ok = await call(h.socketPath, "GET", "/echo/api/echo");

		assert.equal(ok.status, 200);
		assert.equal(h.audit.at(-1)?.route, "echo-read");
		assert.equal(h.audit.at(-1)?.path, "/echo/api/…");

		const written = JSON.stringify(h.audit.slice(lines));

		assert.equal(written.includes(ECHO_SECRET.slice(1)), false);
		assert.equal(written.includes(percent.slice(3)), false);
		assert.equal(
			written.includes(Buffer.from(ECHO_SECRET).toString("base64")),
			false,
		);
		assert.equal(written.includes("/echo/api/echo"), false);
	});

	it("keeps the credential to its own route: the confused-deputy rule", async () => {
		await call(h.socketPath, "GET", "/plain/api/echo", {
			Authorization: "Bearer forged",
		});
		assert.equal(fixture.received.at(-1)?.authorization, null);

		const before = fixture.received.length;

		assert.equal(
			(await call(h.socketPath, "GET", "/echo/admin/users")).code,
			"path-not-allowed",
		);
		assert.equal(
			(await call(h.socketPath, "POST", "/echo/api/echo", {}, "{}")).code,
			"method-not-allowed",
		);
		assert.equal(
			(await call(h.socketPath, "GET", "/echo/api/echo?mutate=1")).code,
			"query-not-allowed",
		);
		assert.equal(fixture.received.length, before);

		const table = testTable(fixture.port);

		const doubled: RouteTable = {
			...table,
			routes: [
				...table.routes,
				{
					...credentialedRoute(fixture.port),
					id: asRouteId("echo-two"),
					prefix: "/echo-two/",
				},
			],
		};

		const ceilings = parseCeilings(
			LINEAR_CEILING.replace("443", String(fixture.port)),
			"test",
		);

		assert.ok(ceilings.ok);
		assert.equal(
			bindCredentials(
				doubled,
				ceilings.ceilings,
				new Map([
					[
						credentialedRoute(0).credential?.id ?? asCredential(),
						Buffer.from(ECHO_SECRET),
					],
				]),
			).ok,
			false,
		);
	});
});

describe("gateway admission gate and control", () => {
	let dir = "";
	let fixture: EchoFixture;

	before(async () => {
		dir = mkdtempSync(join(tmpdir(), "factory-gw-gate-"));
		fixture = await startEchoFixture(0);
	});

	const open: Harness[] = [];

	async function harness(
		port: number,
		options: { ceilingTokens?: number } = {},
	): Promise<Harness> {
		const started = await startHarness(dir, port, options);

		open.push(started);

		return started;
	}

	after(async () => {
		await Promise.all(open.map((started) => started.gateway.close()));
		await fixture.close();
		rmSync(dir, { recursive: true, force: true });
	});

	const model = JSON.stringify({ model: "gpt-6.1-sol", stream: true });
	const json = { "Content-Type": "application/json" };

	it("denies the next request after the gate closes while an in-flight stream completes", async () => {
		const h = await harness(fixture.port);
		const arrived = fixture.arrivals("/openai/v1/slow") + 1;
		const slow = call(h.socketPath, "POST", "/openai/v1/slow", json, model);

		await fixture.waitFor("/openai/v1/slow", arrived);
		h.gateway.closeGate("tokens");

		const next = await call(
			h.socketPath,
			"POST",
			"/openai/v1/responses",
			json,
			model,
		);

		const finished = await slow;

		assert.equal(next.code, "budget-closed");
		assert.equal(
			next.body,
			"factory-gateway: denied: budget-closed: out of budget\n",
		);
		assert.equal(finished.status, 200);
		assert.equal(finished.aborted, false);
		assert.match(finished.body, /response\.completed/);
		assert.deepEqual(
			h.events.filter((event) => event.event === "gate_closed"),
			[{ event: "gate_closed", reason: "tokens" }],
		);
		assert.equal(
			(await call(h.socketPath, "GET", "/plain/api/echo")).code,
			"budget-closed",
		);
	});

	it("closes its own gate at the token ceiling", async () => {
		const h = await harness(fixture.port, { ceilingTokens: 10 });

		assert.equal(
			(await call(h.socketPath, "POST", "/openai/v1/responses", json, model))
				.status,
			200,
		);
		assert.equal(
			(await call(h.socketPath, "POST", "/openai/v1/responses", json, model))
				.code,
			"budget-closed",
		);
		assert.deepEqual(
			h.events.find((event) => event.event === "gate_closed"),
			{ event: "gate_closed", reason: "ceiling" },
		);
	});

	it("opens the fallback route only on command", async () => {
		const h = await harness(fixture.port);
		const xai = JSON.stringify({ model: "grok-4.6" });

		assert.equal(
			(await call(h.socketPath, "POST", "/xai/v1/responses", json, xai)).code,
			"route-closed",
		);
		assert.equal(h.gateway.setRoute(asRouteId("model-xai"), true), true);
		assert.equal(h.gateway.setRoute(asRouteId("model-openai"), false), true);
		assert.equal(
			(await call(h.socketPath, "POST", "/xai/v1/responses", json, xai)).status,
			200,
		);
		assert.equal(
			(await call(h.socketPath, "POST", "/openai/v1/responses", json, model))
				.code,
			"route-closed",
		);
		assert.equal(h.gateway.setRoute(asRouteId("nope"), true), false);
	});

	it("drain_abort destroys in-flight upstream streams", async () => {
		const h = await harness(fixture.port);
		const arrived = fixture.arrivals("/openai/v1/slow") + 1;
		const slow = call(h.socketPath, "POST", "/openai/v1/slow", json, model);

		await fixture.waitFor("/openai/v1/slow", arrived);
		h.gateway.drainAbort();

		const reply = await slow;

		assert.equal(
			reply.aborted ||
				reply.status !== 200 ||
				!reply.body.includes("response.completed"),
			true,
		);
		assert.ok(h.events.some((event) => event.event === "drained"));
	});

	it("closes the gate and denies with audit-unavailable once an audit line cannot be written", async () => {
		const h = await harness(fixture.port);
		const before = fixture.received.length;

		h.failAudit.on = true;
		assert.equal(
			(await call(h.socketPath, "GET", "/plain/api/echo")).status,
			200,
		);
		assert.deepEqual(
			h.events.find((event) => event.event === "gate_closed"),
			{ event: "gate_closed", reason: "audit_failed" },
		);
		assert.equal(
			(await call(h.socketPath, "GET", "/plain/api/echo")).code,
			"audit-unavailable",
		);
		assert.equal(
			(await call(h.socketPath, "GET", "/openai/v1/models")).code,
			"audit-unavailable",
		);
		assert.equal(fixture.received.length, before + 1);
	});

	it("reports an upstream that refuses connections as upstream-error", async () => {
		const h = await harness(REFUSED_PORT);

		assert.equal(
			(await call(h.socketPath, "GET", "/plain/api/echo")).code,
			"upstream-error",
		);
	});

	it("covers every deny code somewhere in this suite", () => {
		const source = readFileSync(new URL(import.meta.url), "utf8");

		for (const code of DENY_CODES) {
			assert.ok(source.includes(`"${code}"`), code);
		}
	});
});

describe("gateway process and control pipe", () => {
	it("starts from a table on stdin, reports ready, and exits when the control pipe closes", async () => {
		const dir = mkdtempSync(join(tmpdir(), "factory-gw-main-"));
		const socketPath = join(dir, "gw.sock");

		try {
			const child = spawn(
				process.execPath,
				[
					new URL("../../server/sandbox/gateway-main.ts", import.meta.url)
						.pathname,
					"--socket",
					socketPath,
					"--audit",
					join(dir, "egress.jsonl"),
				],
				{ stdio: ["pipe", "pipe", "ignore"], env: {} },
			);

			const events: ControlEvent[] = [];
			let pending = "";

			const exited = new Promise<number | null>((done) =>
				child.on("exit", (code) => done(code)),
			);

			const ready = new Promise<void>((done) => {
				child.stdout.on("data", (chunk: Buffer) => {
					pending += chunk.toString();

					let newline = pending.indexOf("\n");

					while (newline !== -1) {
						const event = parseEvent(pending.slice(0, newline));

						assert.ok(event, pending.slice(0, newline));
						events.push(event);

						if (event.event === "ready") done();

						pending = pending.slice(newline + 1);
						newline = pending.indexOf("\n");
					}
				});
			});

			child.stdin.write(`${JSON.stringify(modelTable())}\n`);
			await ready;

			const ready0 = events[0];

			assert.equal(ready0?.event, "ready");
			assert.equal(
				ready0?.event === "ready" ? ready0.ino : -1,
				lstatSync(socketPath).ino,
			);
			assert.equal(lstatSync(socketPath).mode & 0o077, 0);
			assert.equal((await call(socketPath, "GET", "/")).code, "no-route");

			child.stdin.write(encodeCommand({ cmd: "close", reason: "abort" }));
			await new Promise((done) => setTimeout(done, 50));
			assert.deepEqual(events.at(-1), {
				event: "gate_closed",
				reason: "abort",
			});

			child.stdin.end();
			assert.equal(await exited, 0);
			assert.equal(events.at(-1)?.event, "summary");
			assert.equal((await call(socketPath, "GET", "/")).status, 0);

			const audit = readFileSync(join(dir, "egress.jsonl"), "utf8")
				.trim()
				.split("\n");

			assert.equal(audit.length, 1);
			assert.equal(JSON.parse(audit[0] ?? "{}").reason, "no-route");
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});

	it("refuses a table it cannot parse with a fixed fatal code", async () => {
		const dir = mkdtempSync(join(tmpdir(), "factory-gw-main-"));

		try {
			const child = spawn(
				process.execPath,
				[
					new URL("../../server/sandbox/gateway-main.ts", import.meta.url)
						.pathname,
					"--socket",
					join(dir, "gw.sock"),
					"--audit",
					join(dir, "egress.jsonl"),
				],
				{ stdio: ["pipe", "pipe", "ignore"], env: {} },
			);

			let out = "";

			child.stdout.on("data", (chunk: Buffer) => {
				out += chunk.toString();
			});

			const exited = new Promise<number | null>((done) =>
				child.on("exit", (code) => done(code)),
			);

			child.stdin.end('{"version":2}\n');
			assert.equal(await exited, 2);
			assert.deepEqual(parseEvent(out.trim()), {
				event: "fatal",
				code: "bad-table",
			});
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});
});
