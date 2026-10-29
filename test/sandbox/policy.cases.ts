import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
	type AdmissionState,
	checkBody,
	DENY_CODES,
	decideHead,
	denyBody,
	pathMatches,
	type RequestHead,
} from "../../server/sandbox/policy.ts";
import type {
	Route,
	RouteId,
	RouteTable,
} from "../../server/sandbox/routes.ts";
import type { JsonValue } from "../../src/tickets.ts";
import { modelTable } from "./routes.cases.ts";

const HOST = "127.0.0.1:18080";

function head(
	method: string,
	target: string,
	headers: readonly string[] = [],
): RequestHead {
	return { method, target, rawHeaders: ["Host", HOST, ...headers] };
}

function state(
	options: {
		closed?: readonly string[];
		gate?: boolean;
		limited?: readonly string[];
	} = {},
): AdmissionState {
	return {
		routeOpen: (id: RouteId) =>
			id === "model-xai"
				? (options.closed ?? []).length === 0 && false
				: !(options.closed ?? []).includes(id),
		gateOpen: () => options.gate ?? true,
		rateOk: (id: RouteId) => !(options.limited ?? []).includes(id),
	};
}

const NO_SECRET = (_text: string) => false;

function code(
	request: RequestHead,
	table: RouteTable = modelTable(),
	admission: AdmissionState = state(),
	secret: (text: string) => boolean = NO_SECRET,
): string {
	const decision = decideHead(request, table, admission, secret);

	return decision.kind === "deny"
		? decision.code
		: `admit:${decision.route.id}:${decision.upstreamPath}`;
}

function route(id: string): Route {
	const found = modelTable().routes.find((candidate) => candidate.id === id);

	assert.ok(found);

	return found;
}

describe("gateway policy: request head", () => {
	it("admits the prototype's allowed requests with a rebuilt upstream path", () => {
		assert.equal(
			code(head("GET", "/openai/v1/models")),
			"admit:model-openai:/openai/v1/models",
		);
		assert.equal(
			code(
				head("POST", "/openai/v1/responses", [
					"Content-Type",
					"application/json",
					"Content-Length",
					"10",
				]),
			),
			"admit:model-openai:/openai/v1/responses",
		);
		assert.equal(
			code(head("GET", "/npm/is-number/7.0.0")),
			"admit:npm:/is-number/7.0.0",
		);
		assert.equal(code(head("HEAD", "/npm/is-number")), "admit:npm:/is-number");
		assert.equal(
			code(head("GET", "/npm/is-number/-/is-number-7.0.0.tgz")),
			"admit:npm:/is-number/-/is-number-7.0.0.tgz",
		);
		assert.equal(
			code(head("GET", "/npm/@types%2fnode")),
			"admit:npm:/@types%2fnode",
		);
	});

	it("denies every prototype experiment 3 probe with a fixed code", () => {
		const probes: [RequestHead, string][] = [
			[head("GET", "/anthropic/v1/models"), "no-route"],
			[head("POST", "/anthropic/v1/messages"), "no-route"],
			[head("GET", "/zen"), "no-route"],
			[head("GET", "/"), "no-route"],
			[head("GET", "/github/zen"), "no-route"],
			[head("GET", "/openai/v2/models"), "no-route"],
			[head("GET", "/openai/models"), "no-route"],
			[head("GET", "/openai/v1/../../zen"), "ambiguous-path"],
			[head("GET", "/openai/v1/%2e%2e/%2e%2e/zen"), "ambiguous-path"],
			[head("GET", "/openai/v1/%2E%2E%2F%2E%2E%2Fzen"), "ambiguous-path"],
			[head("GET", "/npm/../zen"), "ambiguous-path"],
			[head("GET", "/npm/%252e%252e/zen"), "ambiguous-path"],
			[head("GET", "//github.int.exe.xyz/zen"), "ambiguous-path"],
			[head("GET", "/openai/v1//github.int.exe.xyz/zen"), "ambiguous-path"],
			[head("GET", "/openai/v1/models%5c..%5czen"), "ambiguous-path"],
			[
				{
					method: "GET",
					target: "/openai/v1/models",
					rawHeaders: ["Host", "github.int.exe.xyz"],
				},
				"bad-host",
			],
			[
				{
					method: "GET",
					target: "/zen",
					rawHeaders: ["Host", "github.int.exe.xyz"],
				},
				"bad-host",
			],
			[
				{
					method: "GET",
					target: "/openai/v1/models",
					rawHeaders: ["Host", "llm.int.exe.xyz"],
				},
				"bad-host",
			],
			[
				head("GET", "/openai/v1/models", [
					"X-Forwarded-Host",
					"github.int.exe.xyz",
				]),
				"forbidden-header",
			],
			[
				head("GET", "/openai/v1/models", [
					"Forwarded",
					"host=github.int.exe.xyz",
				]),
				"forbidden-header",
			],
			[
				head("GET", "/openai/v1/models", [
					"X-Original-URL",
					"https://github.int.exe.xyz/zen",
				]),
				"forbidden-header",
			],
			[head("GET", "https://github.int.exe.xyz/zen"), "bad-request-target"],
			[
				head("GET", "https://github.int.exe.xyz/openai/v1/models"),
				"bad-request-target",
			],
			[head("GET", "http://github.int.exe.xyz/zen"), "bad-request-target"],
			[head("CONNECT", "github.int.exe.xyz:443"), "method-forbidden"],
			[head("CONNECT", "api.github.com:443"), "method-forbidden"],
			[head("POST", "/npm/is-number"), "method-not-allowed"],
			[head("DELETE", "/openai/v1/models"), "method-not-allowed"],
		];

		for (const [request, expected] of probes) {
			assert.equal(
				code(request),
				expected,
				`${request.method} ${request.target}`,
			);
		}
	});

	it("denies TRACE, TRACK, unknown methods, asterisk form and fragments", () => {
		assert.equal(code(head("TRACE", "/openai/v1/models")), "method-forbidden");
		assert.equal(code(head("TRACK", "/openai/v1/models")), "method-forbidden");
		assert.equal(code(head("PROPFIND", "/npm/x")), "method-forbidden");
		assert.equal(code(head("OPTIONS", "*")), "bad-request-target");
		assert.equal(code(head("GET", "/npm/x#frag")), "ambiguous-path");
		assert.equal(code(head("GET", "/npm/a%00b")), "ambiguous-path");
		assert.equal(code(head("GET", "/npm/a b")), "ambiguous-path");
		assert.equal(code(head("GET", "/npm/./x")), "ambiguous-path");
		assert.equal(code(head("GET", "/npm/%zz")), "ambiguous-path");
	});

	it("needs exactly one Host equal to the forwarder", () => {
		assert.equal(
			code({ method: "GET", target: "/npm/x", rawHeaders: [] }),
			"bad-host",
		);
		assert.equal(
			code({
				method: "GET",
				target: "/npm/x",
				rawHeaders: ["Host", HOST, "host", HOST],
			}),
			"bad-host",
		);
		assert.equal(
			code({
				method: "GET",
				target: "/npm/x",
				rawHeaders: ["HOST", "127.0.0.1:18081"],
			}),
			"bad-host",
		);
		assert.equal(
			code({
				method: "GET",
				target: "/npm/x",
				rawHeaders: ["host", "LOCALHOST:18080"],
			}),
			"bad-host",
		);
	});

	it("refuses proxy, upgrade and the whole forwarding family", () => {
		for (const name of [
			"X-Forwarded-For",
			"x-forwarded-proto",
			"Forwarded",
			"X-Original-Host",
			"X-Host",
			"X-Rewrite-URL",
			"X-HTTP-Method-Override",
			"Proxy-Authorization",
			"Proxy-Connection",
			"Upgrade",
		]) {
			assert.equal(
				code(head("GET", "/npm/x", [name, "v"])),
				"forbidden-header",
				name,
			);
		}
	});

	it("trips on a loaded secret anywhere in the head", () => {
		const secret = (text: string) => text.includes("s3cret");

		assert.equal(
			code(
				head("GET", "/npm/x", ["Accept", "s3cret"]),
				modelTable(),
				state(),
				secret,
			),
			"secret-in-request",
		);
		assert.equal(
			code(head("GET", "/npm/s3cret"), modelTable(), state(), secret),
			"secret-in-request",
		);
	});

	it("checks route state, the budget gate and the rate limit in that order", () => {
		assert.equal(code(head("GET", "/xai/v1/models")), "route-closed");
		assert.equal(
			code(
				head("GET", "/openai/v1/models"),
				modelTable(),
				state({ closed: ["model-openai"] }),
			),
			"route-closed",
		);
		assert.equal(
			code(
				head("GET", "/openai/v1/models"),
				modelTable(),
				state({ gate: false }),
			),
			"budget-closed",
		);
		assert.equal(
			code(head("GET", "/npm/x"), modelTable(), state({ gate: false })),
			"budget-closed",
		);
		assert.equal(
			code(head("GET", "/npm/x"), modelTable(), state({ limited: ["npm"] })),
			"rate-limited",
		);
	});

	it("allows only listed paths and refuses queries the route does not name", () => {
		assert.equal(
			code(head("GET", "/openai/v1/chat/completions")),
			"path-not-allowed",
		);
		assert.equal(
			code(head("GET", "/openai/v1/models/extra")),
			"path-not-allowed",
		);
		assert.equal(
			code(head("GET", "/openai/v1/models?limit=1")),
			"query-not-allowed",
		);
		assert.equal(code(head("GET", "/npm/x?")), "query-not-allowed");
	});

	it("checks the declared body size and a body on a bodiless route", () => {
		assert.equal(
			code(
				head("POST", "/openai/v1/responses", [
					"Content-Length",
					String(17 * 1024 * 1024),
				]),
			),
			"body-too-large",
		);
		assert.equal(
			code(head("GET", "/npm/x", ["Content-Length", "1"])),
			"body-too-large",
		);
		assert.equal(
			code(head("GET", "/npm/x", ["Transfer-Encoding", "chunked"])),
			"body-not-allowed",
		);
	});
});

describe("gateway policy: path rules", () => {
	it("matches exact, segment-boundary prefix and segment glob rules", () => {
		assert.equal(
			pathMatches({ kind: "exact", path: "graphql" }, "graphql"),
			true,
		);
		assert.equal(
			pathMatches({ kind: "exact", path: "graphql" }, "graphql/x"),
			false,
		);
		assert.equal(
			pathMatches({ kind: "prefix", prefix: "repos" }, "repos/a"),
			true,
		);
		assert.equal(
			pathMatches({ kind: "prefix", prefix: "repos" }, "repos"),
			true,
		);
		assert.equal(
			pathMatches({ kind: "prefix", prefix: "repos" }, "reposx/a"),
			false,
		);
		assert.equal(
			pathMatches({ kind: "glob", pattern: "a/*/c" }, "a/b/c"),
			true,
		);
		assert.equal(
			pathMatches({ kind: "glob", pattern: "a/*/c" }, "a/b/d/c"),
			false,
		);
		assert.equal(pathMatches({ kind: "glob", pattern: "a/*" }, "a/"), false);
		assert.equal(
			pathMatches({ kind: "glob", pattern: "a/**" }, "a/b/c/d"),
			true,
		);
		assert.equal(pathMatches({ kind: "glob", pattern: "**" }, "x"), true);
		assert.equal(pathMatches({ kind: "glob", pattern: "**" }, ""), false);
	});

	it("applies key rules to queries on routes that allow them", () => {
		const base = route("npm");

		const table: RouteTable = {
			...modelTable(),
			routes: [
				{
					...base,
					query: { kind: "keys", allow: ["write"], maxValueBytes: 4 },
				},
			],
		};

		assert.equal(
			code(head("GET", "/npm/x?write=true"), table),
			"admit:npm:/x?write=true",
		);
		assert.equal(
			code(head("GET", "/npm/x?write=true&write=true"), table),
			"query-not-allowed",
		);
		assert.equal(
			code(head("GET", "/npm/x?other=1"), table),
			"query-not-allowed",
		);
		assert.equal(
			code(head("GET", "/npm/x?write=falsey"), table),
			"query-not-allowed",
		);
		assert.equal(code(head("GET", "/npm/x?write"), table), "query-not-allowed");
	});
});

describe("gateway policy: model body", () => {
	const openai = route("model-openai");
	const json = "application/json";

	function body(value: JsonValue): Buffer {
		return Buffer.from(JSON.stringify(value));
	}

	it("admits the stage model with function tools", () => {
		assert.equal(
			checkBody(
				openai,
				json,
				body({
					model: "gpt-6.1-sol",
					stream: true,
					tools: [{ type: "function", name: "read" }],
				}),
				"POST",
			),
			null,
		);
		assert.equal(
			checkBody(
				openai,
				"application/json; charset=utf-8",
				body({ model: "gpt-6.1-sol" }),
				"POST",
			),
			null,
		);
		assert.equal(checkBody(openai, null, Buffer.alloc(0), "GET"), null);
	});

	it("denies an empty body on a JSON route's POST, so its constraints cannot be skipped", () => {
		assert.equal(
			checkBody(openai, null, Buffer.alloc(0), "POST"),
			"body-not-allowed",
		);
		assert.equal(
			checkBody(openai, json, Buffer.alloc(0), "POST"),
			"body-not-allowed",
		);
		assert.equal(checkBody(openai, null, Buffer.alloc(0), "HEAD"), null);
	});

	it("denies another model, hosted tools, background mode and malformed bodies", () => {
		const denied: [string | null, Buffer][] = [
			[json, body({ model: "gpt-6.1-pro" })],
			[json, body({ model: "openai/gpt-6.1-sol" })],
			[json, body({})],
			[
				json,
				body({
					model: "gpt-6.1-sol",
					tools: [{ type: "mcp", server_url: "https://evil.example" }],
				}),
			],
			[json, body({ model: "gpt-6.1-sol", tools: [{ type: "web_search" }] })],
			[
				json,
				body({
					model: "gpt-6.1-sol",
					tools: [{ type: "function" }, { type: "code_interpreter" }],
				}),
			],
			[json, body({ model: "gpt-6.1-sol", tools: { type: "function" } })],
			[json, body({ model: "gpt-6.1-sol", tools: ["function"] })],
			[json, body({ model: "gpt-6.1-sol", background: true })],
			[json, body({ model: "gpt-6.1-sol", background: false })],
			[json, Buffer.from("{not json")],
			[json, body([{ model: "gpt-6.1-sol" }])],
			["text/plain", body({ model: "gpt-6.1-sol" })],
			[null, body({ model: "gpt-6.1-sol" })],
		];

		for (const [type, payload] of denied) {
			assert.equal(
				checkBody(openai, type, payload, "POST"),
				"body-not-allowed",
				payload.toString(),
			);
		}
	});

	it("denies a duplicate key at any depth, so every JSON parser sees what was checked", () => {
		const duplicated = [
			'{"model":"gpt-evil","model":"gpt-6.1-sol","tools":[{"type":"mcp","server_url":"https://evil.example"}],"tools":[{"type":"function"}]}',
			'{"model":"gpt-6.1-sol","tools":[{"type":"mcp","type":"function"}]}',
			'{"model":"gpt-6.1-sol","metadata":{"model":"a","model":"b"}}',
			'{"model":"gpt-evil","\\u006dodel":"gpt-6.1-sol"}',
			'{"model":"gpt-6.1-sol","input":[{"a":1},{"b":[{"c":1,"c":2}]}]}',
		];

		for (const text of duplicated) {
			assert.equal(
				checkBody(openai, json, Buffer.from(text), "POST"),
				"body-not-allowed",
				text,
			);
		}

		for (const text of [
			'{"model":"gpt-6.1-sol","metadata":{"model":"other"},"input":[{"type":"a"},{"type":"b"}]}',
			'{"model":"gpt-6.1-sol","input":"a \\" \\\\ \\"model\\":1, {\\"model\\":2}"}',
			'{"model":"gpt-6.1-sol","tools":[{"type":"function","name":"type"}]}',
		]) {
			assert.equal(
				checkBody(openai, json, Buffer.from(text), "POST"),
				null,
				text,
			);
		}
	});

	it("only lets the fallback route carry the fallback model", () => {
		const xai = route("model-xai");

		assert.equal(
			checkBody(xai, json, body({ model: "grok-4.6" }), "POST"),
			null,
		);
		assert.equal(
			checkBody(xai, json, body({ model: "gpt-6.1-sol" }), "POST"),
			"body-not-allowed",
		);
		assert.equal(
			checkBody(openai, json, body({ model: "grok-4.6" }), "POST"),
			"body-not-allowed",
		);
	});

	it("evaluates at_most and absent pointers", () => {
		const capped: Route = {
			...openai,
			body: {
				kind: "json",
				contentTypes: [json],
				constraints: [
					{ kind: "at_most", pointer: "/max_output_tokens", value: 100 },
				],
			},
		};

		assert.equal(checkBody(capped, json, body({}), "POST"), null);
		assert.equal(
			checkBody(capped, json, body({ max_output_tokens: 100 }), "POST"),
			null,
		);
		assert.equal(
			checkBody(capped, json, body({ max_output_tokens: 101 }), "POST"),
			"body-not-allowed",
		);
		assert.equal(
			checkBody(capped, json, body({ max_output_tokens: "1" }), "POST"),
			"body-not-allowed",
		);
	});

	it("denies any body on a route without a body rule", () => {
		assert.equal(
			checkBody(route("npm"), null, Buffer.from("x"), "GET"),
			"body-not-allowed",
		);
	});
});

describe("gateway deny shape", () => {
	it("has a closed code set and a fixed body that never echoes input", () => {
		assert.equal(DENY_CODES.length, 20);
		assert.equal(denyBody("no-route"), "factory-gateway: denied: no-route\n");
		assert.equal(
			denyBody("budget-closed"),
			"factory-gateway: denied: budget-closed: out of budget\n",
		);

		for (const deny of DENY_CODES) {
			assert.match(
				denyBody(deny),
				/^factory-gateway: denied: [a-z-]+(: out of budget)?\n$/,
			);
		}
	});
});
