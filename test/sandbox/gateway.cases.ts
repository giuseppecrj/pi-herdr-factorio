import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
	assertNoStrays,
	closeHttpServer,
	startEchoFixture,
} from "./http-fixtures.ts";
import {
	lstatSync,
	mkdirSync,
	mkdtempSync,
	readFileSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { createServer, request } from "node:http";
import { connect } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, describe, it } from "node:test";
import {
	AuditLog,
	type AuditRecord,
	JOURNAL_FILE,
	type JournalRecord,
	journalCharge,
} from "../../server/sandbox/audit.ts";
import { startGatewayProcess } from "../../server/sandbox/gateway-client.ts";
import { executionCharge } from "../../server/sandbox.ts";
import {
	type ControlEvent,
	encodeCommand,
	parseEvent,
} from "../../server/sandbox/control.ts";
import {
	bindCredentials,
	GATEWAY_USER_AGENT,
	type CredentialBinding,
	parseCeilings,
} from "../../server/sandbox/credentials.ts";
import {
	ANTHROPIC_REPLAYS,
	type EchoFixture,
} from "../../server/sandbox/echo-fixture.ts";
import { familyFromJournal } from "../../src/review.ts";
import {
	addressAllowed,
	dialOrder,
	Gateway,
	refusedAddresses,
} from "../../server/sandbox/gateway.ts";
import { DENY_CODES, denyBody } from "../../server/sandbox/policy.ts";
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
import type { JsonValue } from "../../src/tickets.ts";
import { anthropicTable, modelTable } from "./routes.cases.ts";

import { assertReaderParity } from "./settlement-fixtures.ts";
import { EXE_DEV_PLATFORM } from "../../src/platform.ts";

const journals: JournalRecord[][] = [];

after(() => {
	for (const records of journals)
		for (let end = 0; end <= records.length; end += 1)
			assertReaderParity(
				records
					.slice(0, end)
					.map((record) => JSON.stringify(record))
					.join("\n"),
			);
});

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

function fixtureModelRoute(
	port: number,
	base: Route,
	host = "llm.test",
): Route {
	return {
		...base,
		upstream: {
			scheme: "http",
			host: "llm.test",
			port,
			basePath: base.prefix,
			hostHeader: host,
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
	options: { ceilingTokens?: number; host?: string } = {},
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
		routes: (
			[
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
				{
					...fixtureModelRoute(port, openai),
					id: asRouteId("opaque-model"),
					prefix: "/opaque/",
					body: { kind: "opaque", contentTypes: ["text/plain"] },
				},
			] satisfies Route[]
		).map((route) => ({
			...route,
			upstream: {
				...route.upstream,
				hostHeader: options.host ?? route.upstream.hostHeader,
			},
		})),
	};
}

function binding(table: RouteTable): CredentialBinding {
	const ceilings = parseCeilings(
		LINEAR_CEILING.replace("443", String(table.routes[5]?.upstream.port)),
		"test",
		EXE_DEV_PLATFORM,
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
	journal: JournalRecord[];
	failJournal: { on: boolean; upstreamAt: number[] };
};

async function startHarness(
	dir: string,
	port: number,
	options: {
		ceilingTokens?: number;
		host?: string;
		lookup?: (host: string) => Promise<string[]>;
		arrivals?: () => number;
	} = {},
): Promise<Harness> {
	const table = testTable(port, options);
	const events: ControlEvent[] = [];
	const audit: AuditRecord[] = [];
	const failAudit = { on: false };
	const journal: JournalRecord[] = [];

	journals.push(journal);

	const upstreamAt: number[] = [];
	const failJournal = { on: false, upstreamAt };

	const socketPath = join(
		dir,
		`gw-${Math.random().toString(16).slice(2)}.sock`,
	);

	const gateway = new Gateway({
		table,
		credentials: binding(table),
		audit: new AuditLog(
			(text) => {
				if (failAudit.on) throw new Error("EIO");

				audit.push(JSON.parse(text));
			},
			1_000_000,
			{
				write: (text) => {
					if (failJournal.on) throw new Error("EIO");

					journal.push(JSON.parse(text));
					failJournal.upstreamAt.push(options.arrivals?.() ?? -1);
				},
				sync: () => {},
			},
		),
		emit: (event) => events.push(event),
		lookup: options.lookup ?? (async () => ["10.1.2.3"]),
	});

	await gateway.listen(socketPath);

	return {
		gateway,
		socketPath,
		events,
		audit,
		failAudit,
		journal,
		failJournal,
	};
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

	it("refuses the metadata address and every refused IPv4 range in their 6to4, IPv4-compatible and IPv4-mapped spellings", () => {
		const refused = refusedAddresses();

		for (const address of [
			"2002:a9fe:a9fe::",
			"2002:a9fe:a9fe::1",
			"2002:a9fe:1::",
			"::a9fe:a9fe",
			"::169.254.169.254",
			"::ffff:a9fe:a9fe",
			"2002:a01:203::",
			"::a01:203",
			"2002:7f00:1::",
			"::7f00:1",
			"2002:c0a8:101::",
			"::c0a8:101",
			"2002:6440:101::",
			"::6440:101",
			"::ffff:6440:101",
			"2002:ac10:1::",
			"::ac10:1",
			"2002:c612:1::",
			"2002:e000:1::",
			"::e000:1",
			"2002:f000:1::",
			"2002:c000:1::",
			"2002::1",
			"::2",
		]) {
			assert.equal(addressAllowed(address, refused), false, address);
		}

		for (const address of ["2002:6810:222::1", "2606:4700::6810:b22"]) {
			assert.equal(addressAllowed(address, refused), true, address);
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
	for (const mode of ["Pi Host", "HTTP/1.0 without Host"] as const) {
		it(`rejects this sandbox's gateway bypass with ${mode}`, async (t) => {
			const fixture = await startEchoFixture(t, 0);
			const body = JSON.stringify({ input: `own request ${fixture.host}` });
			const path = "/openai/v1/responses";

			const headers =
				mode === "Pi Host"
					? "HTTP/1.1\r\nHost: 127.0.0.1:18080\r\nUser-Agent: pi-direct\r\n"
					: "HTTP/1.0\r\n";

			const send = (body: string) =>
				new Promise<string>((done, fail) => {
					const chunks: Buffer[] = [];

					const socket = connect(fixture.port, "127.0.0.1", () => {
						socket.end(
							`POST ${path} ${headers}Content-Type: application/json\r\nContent-Length: ${Buffer.byteLength(body)}\r\nConnection: close\r\n\r\n${body}`,
						);
					});

					socket.on("data", (chunk: Buffer) => chunks.push(chunk));
					socket.on("error", fail);
					socket.on("close", () => done(Buffer.concat(chunks).toString()));
				});

			assert.match(await send("another test's body"), /^HTTP\/1\.1 421/);
			assertNoStrays(fixture, [body]);
			assert.match(await send(body), /^HTTP\/1\.1 421/);
			assert.equal(fixture.foreign.length, 2);
			assert.deepEqual(fixture.foreign[1], {
				method: "POST",
				path,
				host: mode === "Pi Host" ? "127.0.0.1:18080" : null,
				source: "127.0.0.1",
				bodyDigest: createHash("sha256").update(body).digest("hex"),
			});
			assert.throws(
				() => assertNoStrays(fixture, [body]),
				{ code: "ERR_ASSERTION" },
				"the replay's strict check must catch its own untagged body",
			);
		});
	}

	it("isolates stray counts by per-test Host token and records foreign request sources", async (t) => {
		const fixture = await startEchoFixture(t, 0);
		const host = fixture.host;

		const send = (
			method: string,
			path: string,
			token: string,
			agent = "not-the-gateway",
			body = "",
		) =>
			new Promise<number>((done, fail) => {
				request(
					{
						host: "127.0.0.1",
						port: fixture.port,
						method,
						path,
						headers: { Host: token, "User-Agent": agent },
					},
					(res) => {
						res.resume();
						res.on("end", () => done(res.statusCode ?? 0));
					},
				)
					.on("error", fail)
					.end(body);
			});

		assert.equal(
			await send("GET", "/unrelated", "foreign.fixture", GATEWAY_USER_AGENT),
			421,
		);
		assert.equal(fixture.strays, 0);
		assert.deepEqual(fixture.received, []);
		assert.deepEqual(fixture.foreign, [
			{
				method: "GET",
				path: "/unrelated",
				host: "foreign.fixture",
				source: "127.0.0.1",
				bodyDigest: createHash("sha256").update("").digest("hex"),
			},
		]);

		const body = JSON.stringify({ input: `own request ${host}` });

		assert.equal(
			await send(
				"POST",
				"/openai/v1/responses",
				"other-test.fixture",
				GATEWAY_USER_AGENT,
				body,
			),
			421,
		);
		assertNoStrays(fixture, [body]);
		assert.equal(await send("POST", "/openai/v1/responses", host), 421);
		assert.equal(
			fixture.strays,
			1,
			"this test's bypass must still count strictly",
		);
		assert.equal(
			await send("GET", "/openai/v1/models", host, GATEWAY_USER_AGENT),
			200,
		);
		assert.equal(fixture.received.length, 1);
		assert.equal(fixture.strays, 1);
	});

	it("exits promptly after a forced failure with an active HTTP request", () => {
		const helper = new URL("./http-fixtures.ts", import.meta.url).href;

		const child = spawnSync(
			process.execPath,
			[
				"--experimental-strip-types",
				"--input-type=module",
				"--eval",
				`
			import assert from 'node:assert/strict';
			import { it } from 'node:test';
			import { createServer, request } from 'node:http';
			import { closeHttpServer, startEchoFixture } from ${JSON.stringify(helper)};
			it('forced fixture failure', async (t) => {
				await startEchoFixture(t, 0);
				const server = createServer(() => {});
				t.after(() => closeHttpServer(server));
				await new Promise(done => server.listen(0, '127.0.0.1', done));
				const arrived = new Promise(done => server.once('request', done));
				request({ host: '127.0.0.1', port: server.address().port }).on('error', () => {}).end();
				await arrived;
				assert.fail('forced fixture failure');
			});
		`,
			],
			{
				encoding: "utf8",
				timeout: 5000,
				env: { PATH: process.env.PATH, TMPDIR: tmpdir() },
			},
		);

		assert.equal(child.error, undefined, String(child.error));
		assert.equal(child.signal, null);
		assert.equal(child.status, 1);
		assert.match(child.stdout, /forced fixture failure/);
	});

	it("records only what the gateway sent, and answers any other local client 421", async (t) => {
		const fixture = await startEchoFixture(t, 0);

		try {
			const stray = await new Promise<number>((done, fail) => {
				request(
					{
						host: "127.0.0.1",
						port: fixture.port,
						path: "/",
						headers: { Host: fixture.host },
					},
					(res) => {
						res.resume();
						done(res.statusCode ?? 0);
					},
				)
					.on("error", fail)
					.end();
			});

			assert.equal(stray, 421);
			assert.deepEqual(fixture.received, []);
			assert.equal(fixture.strays, 1);
		} finally {
			await fixture.close();
		}
	});
});

describe("gateway over a real unix socket", () => {
	let dir = "";
	let fixture: EchoFixture;
	let h: Harness;

	before(async (t) => {
		dir = mkdtempSync(join(tmpdir(), "factory-gw-"));
		fixture = await startEchoFixture(t, 0);
		h = await startHarness(dir, fixture.port, { host: fixture.host });
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
				table: testTable(fixture.port, { host: fixture.host }),
				credentials: binding(testTable(fixture.port, { host: fixture.host })),
				audit: new AuditLog(() => {}, 1000, {
					write: () => {},
					sync: () => {},
				}),
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
		assert.equal(seen?.host, fixture.host);

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
			host: fixture.host,
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
				"POST",
				"/openai/v1/responses",
				{ "Content-Type": "application/json" },
				'{"model":"gpt-evil","model":"gpt-6.1-sol","tools":[{"type":"mcp","server_url":"https://evil.example"}],"tools":[{"type":"function"}]}',
				"body-not-allowed",
			],
			[
				"POST",
				"/openai/v1/responses",
				{ "Content-Type": "application/json" },
				null,
				"body-not-allowed",
			],
			[
				"POST",
				"/openai/v1/responses",
				{ "Content-Length": "0" },
				null,
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

	before(async (t) => {
		dir = mkdtempSync(join(tmpdir(), "factory-gw-cred-"));
		fixture = await startEchoFixture(t, 0);
		h = await startHarness(dir, fixture.port, { host: fixture.host });
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
		assert.equal(seen?.host, fixture.host);
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

			assert.equal(body.status, 403, path);
			assert.equal(body.code, "response-blocked", path);
			assert.equal(body.body.includes(ECHO_SECRET), false, path);
			assert.equal(
				body.body.includes(Buffer.from(ECHO_SECRET).toString("base64")),
				false,
				path,
			);
			assert.equal(h.audit.at(-1)?.decision, "deny", path);
			assert.equal(h.audit.at(-1)?.reason, "response-blocked", path);
		}
	});

	it("answers a clean 403 for compressed bytes under a text type, before any header is sent", async () => {
		const reply = await call(
			h.socketPath,
			"GET",
			"/echo/api/reflect-gzip-text",
		);

		assert.equal(reply.status, 403);
		assert.equal(reply.code, "response-blocked");
		assert.equal(reply.aborted, false);
		assert.equal(h.audit.at(-1)?.status, 403);
		assert.equal(h.audit.at(-1)?.reason, "response-blocked");
	});

	it("refuses every credentialed response type but application/json and text/*", async () => {
		for (const path of [
			"/echo/api/reflect-deflate-raw",
			"/echo/api/reflect-brotli",
			"/echo/api/reflect-gzip-prefixed",
			"/echo/api/reflect-gzip-bare",
			"/echo/api/untyped",
		]) {
			const reply = await call(h.socketPath, "GET", path);

			assert.equal(reply.status, 403, path);
			assert.equal(reply.code, "response-blocked", path);
			assert.equal(h.audit.at(-1)?.reason, "response-blocked", path);
		}

		assert.equal(
			(await call(h.socketPath, "GET", "/echo/api/echo")).status,
			200,
		);
		assert.equal(
			(await call(h.socketPath, "GET", "/echo/api/cookie")).status,
			200,
		);
		assert.equal(
			(await call(h.socketPath, "GET", "/plain/api/reflect-deflate-raw"))
				.status,
			200,
		);
	});

	it("logs a template, not the path, when a secret is split by a slash or an encoded slash", async () => {
		const lines = h.audit.length;

		for (const path of [
			`/plain/api/${ECHO_SECRET.slice(0, 16)}/${ECHO_SECRET.slice(16)}`,
			`/plain/api/${ECHO_SECRET.slice(0, 16)}%2f${ECHO_SECRET.slice(16)}`,
		]) {
			await call(h.socketPath, "GET", path);

			const logged = h.audit.at(-1)?.path ?? "";

			assert.equal(logged.startsWith("/plain/"), true, logged);
			assert.equal(logged.includes(ECHO_SECRET.slice(16)), false, logged);
			assert.equal(logged.includes(ECHO_SECRET.slice(0, 16)), false, logged);
		}

		assert.equal(h.audit.length, lines + 2);
	});

	it("fails closed on an encoded reflection the sandbox could still decode", async () => {
		for (const path of [
			"/echo/api/reflect-json-escape",
			"/echo/api/reflect-percent-mixed",
			"/echo/api/reflect-base64-shifted",
			"/echo/api/reflect-gzip-bare",
		]) {
			const reply = await call(h.socketPath, "GET", path);

			assert.equal(reply.status, 403, path);
			assert.equal(reply.code, "response-blocked", path);
			assert.equal(reply.body, denyBody("response-blocked"), path);
			assert.equal(h.audit.at(-1)?.reason, "response-blocked", path);
		}

		assert.equal(
			(await call(h.socketPath, "GET", "/echo/api/identity")).code,
			"response-blocked",
		);
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

		const table = testTable(fixture.port, { host: fixture.host });

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
			EXE_DEV_PLATFORM,
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

	before(async (t) => {
		dir = mkdtempSync(join(tmpdir(), "factory-gw-gate-"));
		fixture = await startEchoFixture(t, 0);
	});

	const open: Harness[] = [];

	async function harness(
		port: number,
		options: { ceilingTokens?: number; arrivals?: () => number } = {},
	): Promise<Harness> {
		const started = await startHarness(dir, port, {
			...options,
			host: fixture.host,
		});

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

	it("starts with admission closed when its token ceiling is already spent", async () => {
		const h = await harness(fixture.port, { ceilingTokens: 0 });
		const before = fixture.arrivals("/openai/v1/responses");

		const reply = await call(
			h.socketPath,
			"POST",
			"/openai/v1/responses",
			json,
			model,
		);

		assert.equal(reply.code, "budget-closed");
		assert.equal(fixture.arrivals("/openai/v1/responses"), before);
		assert.equal(h.gateway.summary().gate, "closed");
		assert.equal(h.gateway.summary().modelRequests, 0);
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

	it("forwards a non-object metered body unchanged and bounds it by its bytes plus the ceiling", async () => {
		const bodies: string[] = [];

		const upstream = createServer((req, res) => {
			const chunks: Buffer[] = [];

			req.on("data", (chunk: Buffer) => chunks.push(chunk));
			req.on("end", () => {
				bodies.push(Buffer.concat(chunks).toString("utf8"));
				res.writeHead(200, { "Content-Type": "text/event-stream" });
				res.end(
					'event: response.completed\ndata: {"type":"response.completed","response":{"usage":{"input_tokens":3,"output_tokens":1}}}\n\n',
				);
			});
		});

		await new Promise<void>((done) => upstream.listen(0, "127.0.0.1", done));

		try {
			const address = upstream.address();

			const port =
				address !== null && address instanceof Object ? address.port : 0;

			const h = await harness(port, { ceilingTokens: 4000 });
			const text = { "Content-Type": "text/plain" };

			for (const sent of ["not json at all", "[1,2,3]", '"a string"'])
				assert.equal(
					(await call(h.socketPath, "POST", "/opaque/responses", text, sent))
						.status,
					200,
				);

			assert.deepEqual(bodies, ["not json at all", "[1,2,3]", '"a string"']);
			assert.deepEqual(
				h.journal.flatMap((entry) =>
					entry.kind === "dispatch"
						? [[entry.inputTokenEstimate, entry.maxOutputTokens]]
						: [],
				),
				[
					[15, 4000],
					[7, 4000],
					[10, 4000],
				],
			);
		} finally {
			await closeHttpServer(upstream);
		}
	});

	it("settles a provider's non-2xx response at zero and keeps a 2xx without usage uncertain", async () => {
		const modes = ["429", "500", "bare", "cut", "500usage", "500cut"];
		let mode = "";

		const upstream = createServer((req, res) => {
			req.resume();
			req.on("end", () => {
				if (mode === "429" || mode === "500") {
					res.writeHead(Number(mode), { "Content-Type": "application/json" });
					res.end('{"error":{"message":"rejected"}}');

					return;
				}

				if (mode === "500cut") {
					res.writeHead(500, { "Content-Type": "text/event-stream" });
					res.write(
						'event: response.completed\ndata: {"type":"response.completed","response":{"usage":{"input_tokens":11,"output_tokens":5}}}\n\n',
						() => res.socket?.destroy(),
					);

					return;
				}

				if (mode === "500usage") {
					res.writeHead(500, { "Content-Type": "text/event-stream" });
					res.end(
						'event: response.completed\ndata: {"type":"response.completed","response":{"usage":{"input_tokens":11,"output_tokens":5}}}\n\n',
					);

					return;
				}

				res.writeHead(200, { "Content-Type": "text/event-stream" });

				if (mode === "bare") {
					res.end(
						'event: response.created\ndata: {"type":"response.created"}\n\n',
					);

					return;
				}

				res.write(
					'event: response.output_text.delta\ndata: {"type":"response.output_text.delta","delta":"he"}\n\n',
					() => res.socket?.destroy(),
				);
			});
		});

		await new Promise<void>((done) => upstream.listen(0, "127.0.0.1", done));

		try {
			const address = upstream.address();

			const port =
				address !== null && address instanceof Object ? address.port : 0;

			const h = await harness(port);

			for (const next of modes) {
				mode = next;
				await call(h.socketPath, "POST", "/openai/v1/responses", json, model);
			}

			const bounds = h.journal.flatMap((entry) =>
				entry.kind === "dispatch"
					? [(entry.inputTokenEstimate ?? 0) + (entry.maxOutputTokens ?? 0)]
					: [],
			);

			assert.equal(bounds.length, 6);
			assert.deepEqual(
				h.journal.flatMap((entry) =>
					entry.kind === "result"
						? [
								[
									entry.status,
									entry.decision,
									entry.reason ?? null,
									entry.inputTokens,
									entry.outputTokens,
								],
							]
						: [],
				),
				[
					[429, "forward", "provider_rejected", 0, 0],
					[500, "forward", "provider_rejected", 0, 0],
					[200, "forward", null, null, null],
					[200, "error", null, null, null],
					[500, "forward", "provider_rejected", 11, 5],
					[500, "error", null, null, null],
				],
			);

			assert.deepEqual(
				journalCharge(
					h.journal
						.slice(10)
						.map((e) => JSON.stringify(e))
						.join("\n"),
				),
				{
					tokens: 0,
					dispatched: 1,
					settled: 1,
					unmetered: 1,
					uncertain: 1,
					uncertainTokens: bounds[5] ?? 0,
				},
			);

			const lines = h.journal.slice(0, 8).map((entry) => JSON.stringify(entry));

			assert.deepEqual(
				journalCharge(
					h.journal
						.slice(8, 10)
						.map((e) => JSON.stringify(e))
						.join("\n"),
				),
				{
					tokens: 16,
					dispatched: 1,
					settled: 1,
					unmetered: 0,
					uncertain: 0,
					uncertainTokens: 0,
				},
			);

			assert.deepEqual(journalCharge(lines.slice(0, 4).join("\n")), {
				tokens: 0,
				dispatched: 2,
				settled: 2,
				unmetered: 0,
				uncertain: 0,
				uncertainTokens: 0,
			});
			assert.deepEqual(journalCharge(lines.join("\n")), {
				tokens: 0,
				dispatched: 4,
				settled: 4,
				unmetered: 2,
				uncertain: 2,
				uncertainTokens: (bounds[2] ?? 0) + (bounds[3] ?? 0),
			});
		} finally {
			await closeHttpServer(upstream);
		}
	});

	it("keeps a model request that never reached the provider's headers uncertain", async () => {
		const h = await harness(REFUSED_PORT);

		assert.equal(
			(await call(h.socketPath, "POST", "/openai/v1/responses", json, model))
				.code,
			"upstream-error",
		);

		const [sent, settled] = h.journal;

		assert.ok(sent?.kind === "dispatch" && settled?.kind === "result");
		assert.deepEqual(
			[settled.status, settled.reason ?? null, settled.inputTokens],
			[502, "upstream_unreachable", null],
		);
		assert.deepEqual(
			journalCharge(h.journal.map((entry) => JSON.stringify(entry)).join("\n")),
			{
				tokens: 0,
				dispatched: 1,
				settled: 1,
				unmetered: 1,
				uncertain: 1,
				uncertainTokens:
					(sent.inputTokenEstimate ?? 0) + (sent.maxOutputTokens ?? 0),
			},
		);
	});

	it("does not add an output-limit body to a bodyless model metadata read", async () => {
		const h = await harness(fixture.port);
		assert.equal(
			(await call(h.socketPath, "GET", "/openai/v1/models")).status,
			200,
		);
		const sent = h.journal[0];
		assert.ok(sent?.kind === "dispatch");
		assert.equal(sent.inputTokenEstimate, 0);
		assert.equal(sent.maxOutputTokens, 0);
	});

	it("journals a synced dispatch before a model request goes upstream, and its result after", async () => {
		const h = await harness(fixture.port, {
			arrivals: () => fixture.received.length,
		});

		const before = fixture.received.length;

		assert.equal(
			(await call(h.socketPath, "POST", "/openai/v1/responses", json, model))
				.status,
			200,
		);
		assert.equal(
			(await call(h.socketPath, "GET", "/plain/api/echo")).status,
			200,
		);

		const req = h.audit.find(
			(entry) => entry.path === "/openai/v1/responses",
		)?.req;

		assert.deepEqual(
			h.journal.map((entry) => [entry.kind, entry.req, entry.route]),
			[
				["dispatch", req, "model-openai"],
				["result", req, "model-openai"],
			],
		);
		assert.deepEqual(h.failJournal.upstreamAt, [before, before + 1]);

		const settled = h.journal[1];

		assert.equal(settled?.kind, "result");
		assert.deepEqual(
			settled?.kind === "result"
				? [settled.inputTokens, settled.outputTokens, settled.decision]
				: null,
			[11, 5, "forward"],
		);
	});

	it("forwards nothing upstream when the dispatch cannot be synced", async () => {
		const h = await harness(fixture.port);
		const before = fixture.arrivals("/openai/v1/responses");

		h.failJournal.on = true;

		const reply = await call(
			h.socketPath,
			"POST",
			"/openai/v1/responses",
			json,
			model,
		);

		assert.equal(reply.code, "audit-unavailable");
		assert.equal(fixture.arrivals("/openai/v1/responses"), before);
		assert.equal(h.gateway.summary().modelRequests, 0);
		assert.deepEqual(
			h.events.find((event) => event.event === "gate_closed"),
			{ event: "gate_closed", reason: "audit_failed" },
		);
		assert.equal(
			(await call(h.socketPath, "GET", "/plain/api/echo")).code,
			"audit-unavailable",
		);
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

const ANTHROPIC_START =
	'event: message_start\ndata: {"type":"message_start","message":{"model":"claude-haiku-5-5","id":"msg_1","type":"message","role":"assistant","content":[],"usage":{"input_tokens":16,"cache_creation_input_tokens":12460,"cache_read_input_tokens":0,"output_tokens":1}}}   \n\n';

const ANTHROPIC_TEXT =
	'event: content_block_delta\ndata: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"ok"}}\n\n';

const ANTHROPIC_DELTA =
	'event: message_delta\ndata: {"type":"message_delta","delta":{"stop_reason":"end_turn"},"usage":{"input_tokens":16,"cache_creation_input_tokens":12460,"cache_read_input_tokens":0,"output_tokens":4}}   \n\n';

const ANTHROPIC_STOP = 'event: message_stop\ndata: {"type":"message_stop"}\n\n';

type Sent = {
	method: string;
	url: string;
	headers: Record<string, string | string[] | undefined>;
	body: string;
};

describe("gateway anthropic route", () => {
	let dir = "";
	let port = 0;
	let mode = "full";
	const sent: Sent[] = [];

	const upstream = createServer((req, res) => {
		const chunks: Buffer[] = [];

		req.on("data", (chunk: Buffer) => chunks.push(chunk));
		req.on("end", () => {
			sent.push({
				method: req.method ?? "",
				url: req.url ?? "",
				headers: req.headers,
				body: Buffer.concat(chunks).toString("utf8"),
			});

			if (req.url?.startsWith("/openai/")) {
				res.writeHead(200, { "Content-Type": "text/event-stream" });
				res.end(
					'event: response.created\ndata: {"type":"response.created"}\n\n',
				);

				return;
			}

			if (req.url === "/anthropic/v1/models") {
				res.writeHead(200, { "Content-Type": "application/json" });
				res.end('{"data":[],"has_more":false}');

				return;
			}

			if (mode === "hang") return;

			if (mode === "502cut" || mode === "504cut") {
				res.writeHead(Number(mode.slice(0, 3)), {
					"Content-Type": "text/event-stream",
				});
				res.write(ANTHROPIC_START, () => res.socket?.destroy());

				return;
			}

			res.writeHead(200, { "Content-Type": "text/event-stream" });

			if (mode === "cut") {
				res.write(ANTHROPIC_START, () => res.socket?.destroy());

				return;
			}

			res.end(
				mode === "nodelta"
					? ANTHROPIC_START + ANTHROPIC_TEXT + ANTHROPIC_STOP
					: mode === "twostarts"
						? ANTHROPIC_START +
							ANTHROPIC_START +
							ANTHROPIC_TEXT +
							ANTHROPIC_DELTA +
							ANTHROPIC_STOP
						: ANTHROPIC_START +
							ANTHROPIC_TEXT +
							ANTHROPIC_DELTA +
							ANTHROPIC_STOP,
			);
		});
	});

	const open: Gateway[] = [];

	before(async () => {
		dir = mkdtempSync(join(tmpdir(), "factory-gw-anthropic-"));
		await new Promise<void>((done) => upstream.listen(0, "127.0.0.1", done));

		const address = upstream.address();

		port = address !== null && address instanceof Object ? address.port : 0;
	});

	after(async () => {
		await Promise.all(open.map((gateway) => gateway.close()));
		await closeHttpServer(upstream);
		rmSync(dir, { recursive: true, force: true });
	});

	async function anthropicHarness(
		options: {
			model?: string;
			ceilingTokens?: number;
			fallback?: string;
			port?: number;
		} = {},
	) {
		const base = anthropicTable({
			model: options.model ?? "claude-haiku-5-5",
			fallback: options.fallback ?? null,
			modelTokens: options.ceilingTokens ?? 500_000,
		});

		const table: RouteTable = {
			...base,
			routes: base.routes.map((route) =>
				route.meter === null
					? route
					: fixtureModelRoute(options.port ?? port, route),
			),
		};

		const audit: AuditRecord[] = [];
		const journal: JournalRecord[] = [];

		journals.push(journal);
		const events: ControlEvent[] = [];

		const socketPath = join(
			dir,
			`gw-${Math.random().toString(16).slice(2)}.sock`,
		);

		const gateway = new Gateway({
			table,
			credentials: { ok: true, bound: new Map(), forms: [] },
			audit: new AuditLog((text) => audit.push(JSON.parse(text)), 1_000_000, {
				write: (text) => journal.push(JSON.parse(text)),
				sync: () => {},
			}),
			emit: (event) => events.push(event),
			lookup: async () => ["10.1.2.3"],
		});

		await gateway.listen(socketPath);
		open.push(gateway);

		return { gateway, socketPath, audit, journal, events };
	}

	const piHeaders = {
		"Content-Type": "application/json",
		Accept: "application/json",
		"anthropic-version": "2023-06-01",
		"anthropic-beta": "fine-grained-tool-streaming-2025-05-14",
		"anthropic-dangerous-direct-browser-access": "true",
		"x-api-key": "sandbox-placeholder-not-a-key",
		"X-Stainless-Retry-Count": "0",
	};

	const piTool = {
		name: "read",
		description: "Read a file",
		eager_input_streaming: true,
		input_schema: { type: "object", properties: {}, required: [] },
		cache_control: { type: "ephemeral" },
	};

	const messages = (extra: Record<string, JsonValue> = {}) =>
		JSON.stringify({
			model: "claude-haiku-5-5",
			messages: [{ role: "user", content: "Reply ok" }],
			max_tokens: 500_000,
			stream: true,
			tools: [piTool],
			...extra,
		});

	it("forwards Pi's request with its version and beta headers, strips the key, clamps max_tokens to the model maximum and meters cache as input", async () => {
		mode = "full";

		const h = await anthropicHarness();
		const before = sent.length;

		const reply = await call(
			h.socketPath,
			"POST",
			"/anthropic/v1/messages?beta=true",
			piHeaders,
			messages(),
		);

		assert.equal(reply.status, 200);
		assert.match(reply.body, /message_stop/);
		assert.equal(sent.length, before + 1);

		const seen = sent.at(-1);

		assert.equal(seen?.url, "/anthropic/v1/messages?beta=true");
		assert.equal(seen?.headers["anthropic-version"], "2023-06-01");
		assert.equal(
			seen?.headers["anthropic-beta"],
			"fine-grained-tool-streaming-2025-05-14",
		);
		assert.equal(seen?.headers["x-api-key"], undefined);
		assert.equal(
			seen?.headers["anthropic-dangerous-direct-browser-access"],
			undefined,
		);
		assert.equal(seen?.headers["x-stainless-retry-count"], undefined);

		const body = JSON.parse(seen?.body ?? "{}");

		assert.equal(body.max_tokens, 128_000);
		assert.equal("max_output_tokens" in body, false);
		assert.deepEqual(body.tools, [piTool]);

		const [dispatch, result] = h.journal;

		assert.ok(dispatch?.kind === "dispatch" && result?.kind === "result");
		assert.equal(dispatch.route, "model-anthropic");
		assert.equal(dispatch.maxOutputTokens, 128_000);
		assert.deepEqual(
			[result.status, result.decision, result.inputTokens, result.outputTokens],
			[200, "forward", 16 + 12460, 4],
		);
		assert.equal(result.observedModel, "claude-haiku-5-5");
		assert.equal(h.audit.at(-1)?.observedModel, "claude-haiku-5-5");
		assert.equal(h.audit.at(-1)?.path, "/anthropic/v1/messages?…");
		assert.deepEqual(
			journalCharge(h.journal.map((entry) => JSON.stringify(entry)).join("\n")),
			{
				tokens: 12480,
				dispatched: 1,
				settled: 1,
				unmetered: 0,
				uncertain: 0,
				uncertainTokens: 0,
			},
		);

		const summary = h.gateway.summary();

		assert.equal(summary.modelTokens, 12480);
		assert.equal(summary.modelRequests, 1);
		assert.deepEqual(
			summary.routes.find((route) => route.route === "model-anthropic"),
			{
				route: "model-anthropic",
				forwarded: 1,
				denied: 0,
				bytesIn: summary.routes[0]?.bytesIn,
				bytesOut: Buffer.byteLength(reply.body),
				inputTokens: 12476,
				outputTokens: 4,
				unmetered: 0,
				peakConcurrent: 1,
			},
		);
	});

	it("bounds max_tokens by the client, the stage ceiling and the model maximum, and charges a lost result at that bound", async () => {
		mode = "full";

		const h = await anthropicHarness({ ceilingTokens: 25_000 });
		const before = sent.length;

		const extras: Record<string, JsonValue>[] = [{}, { max_tokens: 900 }];

		for (const extra of extras) {
			assert.equal(
				(
					await call(
						h.socketPath,
						"POST",
						"/anthropic/v1/messages",
						piHeaders,
						messages(extra),
					)
				).status,
				200,
			);
		}

		const noClient = JSON.parse(
			JSON.stringify({ model: "claude-haiku-5-5", messages: [], stream: true }),
		);

		assert.equal(
			(
				await call(
					h.socketPath,
					"POST",
					"/anthropic/v1/messages",
					piHeaders,
					JSON.stringify(noClient),
				)
			).status,
			200,
		);
		assert.deepEqual(
			sent.slice(before).map((seen) => JSON.parse(seen.body).max_tokens),
			[25_000, 900, 25_000],
		);

		const wide = await anthropicHarness({
			model: "claude-haiku-4-5",
			ceilingTokens: 500_000,
		});

		mode = "cut";

		const cut = await call(
			wide.socketPath,
			"POST",
			"/anthropic/v1/messages",
			piHeaders,
			messages({ model: "claude-haiku-4-5" }),
		);

		mode = "full";
		assert.equal(cut.aborted || !cut.body.includes("message_stop"), true);
		assert.equal(JSON.parse(sent.at(-1)?.body ?? "{}").max_tokens, 64_000);

		const [dispatch, result] = wide.journal;

		assert.ok(dispatch?.kind === "dispatch" && result?.kind === "result");
		assert.equal(dispatch.maxOutputTokens, 64_000);
		assert.deepEqual([result.inputTokens, result.outputTokens], [null, null]);
		assert.equal(result.observedModel, undefined);

		for (const lines of [[dispatch], [dispatch, result]]) {
			assert.deepEqual(
				journalCharge(lines.map((entry) => JSON.stringify(entry)).join("\n")),
				{
					tokens: 0,
					dispatched: 1,
					settled: lines.length - 1,
					unmetered: lines.length - 1,
					uncertain: 1,
					uncertainTokens: (dispatch.inputTokenEstimate ?? 0) + 64_000,
				},
			);
		}
	});

	it("denies a model with no output maximum with model-maximum-unknown before any upstream call", async () => {
		const h = await anthropicHarness({ model: "claude-opus-4-6" });
		const before = sent.length;

		const reply = await call(
			h.socketPath,
			"POST",
			"/anthropic/v1/messages",
			piHeaders,
			messages({ model: "claude-opus-4-6" }),
		);

		assert.equal(reply.code, "model-maximum-unknown");
		assert.equal(reply.status, 403);
		assert.equal(reply.body, denyBody("model-maximum-unknown"));
		assert.equal(sent.length, before);
		assert.deepEqual(h.journal, []);
		assert.equal(h.gateway.summary().modelRequests, 0);
		assert.equal(h.audit.at(-1)?.reason, "model-maximum-unknown");
	});

	it("denies a non-JSON body, an OpenAI output field, a hosted tool, remote MCP servers and any other query", async () => {
		const h = await anthropicHarness();
		const before = sent.length;

		const cases: [string, Record<string, string>, string, string][] = [
			[
				"/anthropic/v1/messages",
				{ ...piHeaders, "Content-Type": "text/plain" },
				"not json",
				"body-not-allowed",
			],
			["/anthropic/v1/messages", piHeaders, "[1,2]", "body-not-allowed"],
			[
				"/anthropic/v1/messages",
				piHeaders,
				messages({ max_output_tokens: 10 }),
				"body-not-allowed",
			],
			[
				"/anthropic/v1/messages",
				piHeaders,
				messages({
					tools: [{ type: "web_search_20250305", name: "web_search" }],
				}),
				"body-not-allowed",
			],
			[
				"/anthropic/v1/messages",
				piHeaders,
				messages({ tools: [{ ...piTool, type: "custom" }] }),
				"body-not-allowed",
			],
			[
				"/anthropic/v1/messages",
				piHeaders,
				messages({ mcp_servers: [{ type: "url", url: "https://x.test" }] }),
				"body-not-allowed",
			],
			[
				"/anthropic/v1/messages",
				piHeaders,
				messages({ model: "claude-sonnet-5-5" }),
				"body-not-allowed",
			],
			[
				"/anthropic/v1/messages?beta=false",
				piHeaders,
				messages(),
				"query-not-allowed",
			],
			[
				"/anthropic/v1/messages?other=1",
				piHeaders,
				messages(),
				"query-not-allowed",
			],
			[
				"/anthropic/v1/messages?beta=true&beta=true",
				piHeaders,
				messages(),
				"query-not-allowed",
			],
			["/anthropic/v1/complete", piHeaders, messages(), "path-not-allowed"],
			[
				"/anthropic/v1/messages/count_tokens?beta=true",
				piHeaders,
				messages(),
				"path-not-allowed",
			],
			["/xai/v1/responses", piHeaders, messages(), "no-route"],
			["/openai/v1/responses", piHeaders, messages(), "no-route"],
		];

		for (const [path, headers, body, code] of cases) {
			assert.equal(
				(await call(h.socketPath, "POST", path, headers, body)).code,
				code,
				`${path} ${body.slice(0, 40)}`,
			);
		}

		assert.equal(sent.length, before);
		assert.deepEqual(h.journal, []);
	});

	it("forwards Pi 1.4.0's real accept request, and each protection still denies its hostile variant", async () => {
		mode = "full";

		const real = JSON.parse(
			readFileSync(
				new URL(
					"./fixtures/pi-1.4.0-anthropic-accept-request.json",
					import.meta.url,
				),
				"utf8",
			),
		);

		const h = await anthropicHarness({
			model: "claude-sonnet-5-5",
			ceilingTokens: 25_000,
		});

		const before = sent.length;
		const headers: Record<string, string> = real.headers;
		const body = real.body;

		const reply = await call(
			h.socketPath,
			real.method,
			real.path,
			headers,
			JSON.stringify(body),
		);

		assert.equal(reply.code, null);
		assert.equal(reply.status, 200);
		assert.equal(sent.length, before + 1);

		const seen = sent.at(-1);
		const forwarded = JSON.parse(seen?.body ?? "{}");

		assert.equal(seen?.url, "/anthropic/v1/messages?beta=true");
		assert.equal(seen?.headers["anthropic-version"], "2023-06-01");
		assert.equal(seen?.headers["anthropic-beta"], headers["anthropic-beta"]);
		assert.equal(seen?.headers["x-api-key"], undefined);
		assert.deepEqual(forwarded, { ...body, max_tokens: 25_000 });
		assert.equal(h.journal[0]?.kind, "dispatch");
		assert.equal(
			h.journal[0]?.kind === "dispatch" && h.journal[0].maxOutputTokens,
			25_000,
		);

		const hostile: [string, string, JsonValue][] = [
			[
				"a server tool",
				real.path,
				{
					...body,
					tools: [
						...body.tools,
						{ type: "web_search_20250305", name: "web_search" },
					],
				},
			],
			[
				"a tool key outside the allowlist",
				real.path,
				{
					...body,
					tools: body.tools.map((tool: Record<string, JsonValue>) => ({
						...tool,
						type: "custom",
					})),
				},
			],
			[
				"remote MCP servers",
				real.path,
				{ ...body, mcp_servers: [{ type: "url", url: "https://x.test" }] },
			],
			[
				"a model outside the table",
				real.path,
				{ ...body, model: "claude-opus-4-5" },
			],
			["another query", "/anthropic/v1/messages?beta=false", body],
		];

		for (const [name, path, variant] of hostile) {
			assert.equal(
				(
					await call(
						h.socketPath,
						real.method,
						path,
						headers,
						JSON.stringify(variant),
					)
				).code,
				path === real.path ? "body-not-allowed" : "query-not-allowed",
				name,
			);
		}

		assert.equal(sent.length, before + 1);
	});

	it("forwards the models list unjournaled, so it can neither fail a stage nor count as a model request", async () => {
		const h = await anthropicHarness();

		const reply = await call(h.socketPath, "GET", "/anthropic/v1/models", {
			"anthropic-version": "2023-06-01",
		});

		assert.equal(reply.status, 200);
		assert.deepEqual(h.journal, []);
		assert.equal(h.gateway.summary().modelRequests, 0);
		assert.equal(h.gateway.summary().routes[0]?.unmetered, 0);
		assert.equal(h.gateway.summary().routes[0]?.forwarded, 1);
	});

	it("marks only the gateway's own answer before any upstream response upstream_unreachable, never an upstream 502 or 504 cut mid-stream", async () => {
		const down = await anthropicHarness({ port: REFUSED_PORT });

		const refused = await call(
			down.socketPath,
			"POST",
			"/anthropic/v1/messages?beta=true",
			piHeaders,
			messages(),
		);

		assert.deepEqual([refused.status, refused.code], [502, "upstream-error"]);

		const h = await anthropicHarness();
		const replies: (string | number | null)[][] = [];

		for (const next of ["hang", "502cut", "504cut"]) {
			mode = next;

			const reply = await call(
				h.socketPath,
				"POST",
				"/anthropic/v1/messages?beta=true",
				piHeaders,
				messages(),
			);

			replies.push([next, reply.status, reply.code]);
		}

		mode = "full";

		assert.deepEqual(replies, [
			["hang", 504, "upstream-timeout"],
			["502cut", 502, null],
			["504cut", 504, null],
		]);

		const results = [...down.journal, ...h.journal].flatMap((entry) =>
			entry.kind === "result"
				? [
						[
							entry.status,
							entry.decision,
							entry.reason ?? null,
							entry.inputTokens,
							entry.outputTokens,
						],
					]
				: [],
		);

		assert.deepEqual(results, [
			[502, "error", "upstream_unreachable", null, null],
			[504, "error", "upstream_unreachable", null, null],
			[502, "error", null, null, null],
			[504, "error", null, null, null],
		]);

		// Charging ignores the marker: every one of these stays uncertain.
		assert.deepEqual(
			[down, h].map(
				(each) =>
					journalCharge(
						each.journal.map((entry) => JSON.stringify(entry)).join("\n"),
					).uncertain,
			),
			[1, 3],
		);
	});

	it("marks an Anthropic stream without usage or with two message_starts unusable, while OpenAI keeps its unmetered rule and output field", async () => {
		const h = await anthropicHarness({ fallback: "openai/gpt-6.1-sol" });

		for (const next of ["nodelta", "twostarts"]) {
			mode = next;

			const reply = await call(
				h.socketPath,
				"POST",
				"/anthropic/v1/messages?beta=true",
				piHeaders,
				messages(),
			);

			assert.equal(reply.status, 200, next);
		}

		mode = "full";

		const results = h.journal.flatMap((entry) =>
			entry.kind === "result" ? [entry] : [],
		);

		assert.deepEqual(
			results.map((entry) => [
				entry.route,
				entry.status,
				entry.decision,
				entry.inputTokens,
				entry.outputTokens,
				entry.observedModel ?? null,
			]),
			[
				["model-anthropic", 200, "forward", null, null, null],
				["model-anthropic", 200, "forward", null, null, null],
			],
		);
		assert.equal(h.gateway.summary().routes[0]?.unmetered, 2);
		assert.equal(h.gateway.summary().modelTokens, 0);
		assert.equal(
			journalCharge(h.journal.map((entry) => JSON.stringify(entry)).join("\n"))
				.uncertain,
			2,
		);

		const openai = JSON.stringify({ model: "gpt-6.1-sol", stream: true });

		assert.equal(
			(
				await call(
					h.socketPath,
					"POST",
					"/openai/v1/responses",
					{ "Content-Type": "application/json" },
					openai,
				)
			).code,
			"route-closed",
		);
		assert.equal(h.gateway.setRoute(asRouteId("model-anthropic"), false), true);
		assert.equal(h.gateway.setRoute(asRouteId("model-openai"), true), true);
		assert.equal(
			(
				await call(
					h.socketPath,
					"POST",
					"/openai/v1/responses",
					{ "Content-Type": "application/json" },
					openai,
				)
			).status,
			200,
		);

		const body = JSON.parse(sent.at(-1)?.body ?? "{}");

		assert.equal(body.max_output_tokens, 500_000);
		assert.equal("max_tokens" in body, false);

		const last = h.journal.at(-1);

		assert.ok(last?.kind === "result");
		assert.deepEqual(
			[last.route, last.inputTokens, last.observedModel],
			["model-openai", null, undefined],
		);
		assert.equal(
			h.gateway.summary().routes.find((route) => route.route === "model-openai")
				?.unmetered,
			1,
		);
		assert.equal("observedModel" in (h.audit.at(-1) ?? {}), false);
	});
});

describe("gateway process request journal", () => {
	it("charges an input-plus-output upper bound without replay when the gateway dies mid-request", async (t) => {
		const dir = mkdtempSync(join(tmpdir(), "factory-gw-journal-"));
		const fixture = await startEchoFixture(t, 0);

		try {
			const table = testTable(fixture.port, { host: fixture.host });
			const stage = join(dir, "stages", "specify-1");

			mkdirSync(stage, { recursive: true });

			const started = await startGatewayProcess({
				platform: EXE_DEV_PLATFORM,
				gatewayDir: join(dir, "gw"),
				auditPath: join(stage, "egress.jsonl"),
				table: { ...table, routes: table.routes.slice(0, 2) },
				readyTimeoutMs: 10_000,
				testMode: true,
			});

			assert.ok(started.ok, started.ok ? "" : started.reason);

			const json = { "Content-Type": "application/json" };

			const model = JSON.stringify({
				model: "gpt-6.1-sol",
				stream: true,
				max_output_tokens: 1000,
			});

			const socket = started.handle.socketPath;

			assert.equal(
				(await call(socket, "POST", "/openai/v1/responses", json, model))
					.status,
				200,
			);

			const arrived = fixture.arrivals("/openai/v1/hang") + 1;
			const hung = call(socket, "POST", "/openai/v1/hang", json, model);

			await fixture.waitFor("/openai/v1/hang", arrived);
			started.handle.kill();
			await started.handle.exited;
			await hung;

			assert.deepEqual(
				journalCharge(readFileSync(join(stage, JOURNAL_FILE), "utf8")),
				{
					tokens: 16,
					dispatched: 2,
					settled: 1,
					unmetered: 0,
					uncertain: 1,
					uncertainTokens: Buffer.byteLength(model) + 1000,
				},
			);
			assert.deepEqual(await executionCharge(stage), {
				total: 16 + Buffer.byteLength(model) + 1000,
				uncertain: 1,
			});
			assert.equal(fixture.arrivals("/openai/v1/hang"), arrived);
		} finally {
			await fixture.close();
			rmSync(dir, { recursive: true, force: true });
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
					"--platform",
					"exe-dev",
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
					"--platform",
					"exe-dev",
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

	for (const name of ["host", ":authority"]) {
		it(`exits bad-credentials when a table and ceiling place their secret in ${name}`, async () => {
			await placedIn(name);
		});
	}

	async function placedIn(name: string): Promise<void> {
		const dir = mkdtempSync(join(tmpdir(), "factory-gw-main-"));

		try {
			const placement = { kind: "header", name, scheme: null } as const;
			const route = credentialedRoute(18_081);

			const table: RouteTable = {
				...modelTable(),
				routes: [
					{
						...route,
						credential: {
							id: route.credential?.id ?? asCredential(),
							placement,
						},
					},
				],
			};

			mkdirSync(join(dir, "creds"));
			writeFileSync(join(dir, "creds", "echo-read"), "github.int.exe.xyz");
			writeFileSync(
				join(dir, "ceilings.json"),
				LINEAR_CEILING.replace("443", "18081").replace(
					'{"kind":"header","name":"Authorization","scheme":"Bearer"}',
					JSON.stringify(placement),
				),
			);

			const child = spawn(
				process.execPath,
				[
					new URL("../../server/sandbox/gateway-main.ts", import.meta.url)
						.pathname,
					"--test-mode",
					"--socket",
					join(dir, "gw.sock"),
					"--audit",
					join(dir, "egress.jsonl"),
					"--ceilings",
					join(dir, "ceilings.json"),
					"--platform",
					"exe-dev",
				],
				{
					stdio: ["pipe", "pipe", "ignore"],
					env: { CREDENTIALS_DIRECTORY: join(dir, "creds") },
				},
			);

			let out = "";

			child.stdout.on("data", (chunk: Buffer) => {
				out += chunk.toString();
			});

			const exited = new Promise<number | null>((done) =>
				child.on("exit", (code) => done(code)),
			);

			child.stdin.end(`${JSON.stringify(table)}\n`);
			assert.equal(await exited, 2);
			assert.deepEqual(parseEvent(out.trim().split("\n")[0] ?? ""), {
				event: "fatal",
				code: "bad-credentials",
			});
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	}
});

describe("echo fixture Anthropic replay through the gateway (lane 3, zero tokens)", () => {
	let dir = "";

	before(() => {
		dir = mkdtempSync(join(tmpdir(), "factory-gw-echo-anthropic-"));
	});

	after(() => rmSync(dir, { recursive: true, force: true }));

	async function replay(
		t: Parameters<typeof startEchoFixture>[0],
		mode: (typeof ANTHROPIC_REPLAYS)[number],
	) {
		const fixture = await startEchoFixture(t, 0, { anthropic: mode });

		const base = anthropicTable({
			model: "claude-sonnet-5-5",
			fallback: null,
			modelTokens: 25_000,
		});

		const table: RouteTable = {
			...base,
			routes: base.routes.map((route) =>
				route.meter === null
					? route
					: fixtureModelRoute(fixture.port, route, fixture.host),
			),
		};

		const journal: string[] = [];

		const gateway = new Gateway({
			table,
			credentials: { ok: true, bound: new Map(), forms: [] },
			audit: new AuditLog(() => {}, 1_000_000, {
				write: (text) => journal.push(text.trimEnd()),
				sync: () => {},
			}),
			emit: () => {},
			lookup: async () => ["10.1.2.3"],
		});

		const socketPath = join(dir, `gw-${mode}.sock`);

		await gateway.listen(socketPath);

		try {
			const reply = await call(
				socketPath,
				"POST",
				"/anthropic/v1/messages?beta=true",
				{
					"Content-Type": "application/json",
					"anthropic-version": "2023-06-01",
				},
				JSON.stringify({
					model: "claude-sonnet-5-5",
					messages: [{ role: "user", content: "Reply ok" }],
					max_tokens: 1_000,
					stream: true,
				}),
			);

			for (let end = 0; end <= journal.length; end += 1)
				assertReaderParity(journal.slice(0, end).join("\n"));

			return {
				reply,
				journal: journal.join("\n"),
				summary: gateway.summary(),
				arrivals: fixture.arrivals("/anthropic/v1/messages"),
			};
		} finally {
			await gateway.close();
			await fixture.close();
		}
	}

	it("meters a full replay and records the observed model as Anthropic family", async (t) => {
		const run = await replay(t, "usage");

		assert.equal(run.reply.status, 200);
		assert.equal(run.arrivals, 1);
		assert.equal(run.summary.routes[0]?.unmetered, 0);
		assert.equal(run.summary.modelTokens, 22);
		assert.deepEqual(
			familyFromJournal({
				journal: run.journal,
				requested: "anthropic/claude-sonnet-5-5",
				superseded: null,
			}),
			{ kind: "anthropic-gateway", model: "claude-sonnet-5-5" },
		);
	});

	it("counts a replay with no usage block unmetered, charges it uncertain and gives no family", async (t) => {
		const run = await replay(t, "no-usage");

		assert.equal(run.reply.status, 200);
		assert.match(run.reply.body, /message_stop/);
		assert.equal(run.summary.routes[0]?.unmetered, 1);
		assert.equal(run.summary.modelTokens, 0);
		assert.equal(journalCharge(run.journal).uncertain, 1);
		assert.deepEqual(
			familyFromJournal({
				journal: run.journal,
				requested: "anthropic/claude-sonnet-5-5",
				superseded: null,
			}),
			{ kind: "unavailable", reason: "unmetered" },
		);
	});

	it("meters a refusal replay with its full usage, so the refusal rule and not the veto applies", async (t) => {
		const run = await replay(t, "refusal");

		assert.match(run.reply.body, /"stop_reason":"refusal"/);
		assert.equal(run.summary.routes[0]?.unmetered, 0);
		assert.equal(run.summary.modelTokens, 22);
	});
});
