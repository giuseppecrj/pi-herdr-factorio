import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
	BUILTIN_HOSTS,
	builtinTable,
	isForbiddenUpstreamHost,
	parseRouteTable,
	type RouteTable,
} from "../../server/sandbox/routes.ts";
import type { JsonValue } from "../../src/tickets.ts";

export function modelTable(fallback: string | null = "grok-4.6"): RouteTable {
	return builtinTable({
		stage: "specify",
		runId: "a".repeat(64),
		attempt: 1,
		model: "gpt-6.1-sol",
		fallback,
		modelTokens: 50_000,
		modelRequests: 200,
	});
}

function roundTrip(table: RouteTable): JsonValue {
	const value: JsonValue = JSON.parse(JSON.stringify(table));

	return value;
}

function edited(edit: (table: { [key: string]: JsonValue }) => void) {
	const value = roundTrip(modelTable());

	assert.ok(value !== null && !Array.isArray(value) && value instanceof Object);
	edit(value);

	return value;
}

function firstRoute(table: { [key: string]: JsonValue }) {
	const routes = table.routes;

	assert.ok(Array.isArray(routes));

	const route = routes[0];

	assert.ok(route !== null && !Array.isArray(route) && route instanceof Object);

	return route;
}

describe("sandbox route registry", () => {
	it("builds the three v1 routes with fixed upstreams", () => {
		const table = modelTable();

		assert.deepEqual(
			table.routes.map((route) => [
				route.id,
				route.prefix,
				route.upstream.host,
				route.upstream.hostHeader,
				route.upstream.sni,
				route.methods.join(","),
				route.initially,
			]),
			[
				[
					"model-openai",
					"/openai/v1/",
					"llm.int.exe.xyz",
					"llm.int.exe.xyz",
					"llm.int.exe.xyz",
					"GET,POST",
					"open",
				],
				[
					"model-xai",
					"/xai/v1/",
					"llm.int.exe.xyz",
					"llm.int.exe.xyz",
					"llm.int.exe.xyz",
					"GET,POST",
					"closed",
				],
				[
					"npm",
					"/npm/",
					"registry.npmjs.org",
					"registry.npmjs.org",
					"registry.npmjs.org",
					"GET,HEAD",
					"open",
				],
			],
		);
		assert.equal(table.forwarderHost, "127.0.0.1:18080");
		assert.deepEqual(BUILTIN_HOSTS, ["llm.int.exe.xyz", "registry.npmjs.org"]);
	});

	it("pins the model body to the stage model, function tools and no background", () => {
		const [openai, xai] = modelTable().routes;

		assert.deepEqual(openai?.body, {
			kind: "json",
			contentTypes: ["application/json"],
			constraints: [
				{ kind: "one_of", pointer: "/model", values: ["gpt-6.1-sol"] },
				{
					kind: "each_one_of",
					pointer: "/tools",
					field: "type",
					values: ["function"],
				},
				{ kind: "absent", pointer: "/background" },
			],
		});
		assert.deepEqual(
			xai?.body.kind === "json" ? xai.body.constraints[0] : null,
			{ kind: "one_of", pointer: "/model", values: ["grok-4.6"] },
		);
		assert.deepEqual(openai?.paths, [
			{ kind: "exact", path: "models" },
			{ kind: "exact", path: "responses" },
		]);
		assert.equal(openai?.credential, null);
		assert.equal(openai?.budget, true);
		assert.equal(openai?.meter, "openai-responses-sse");
	});

	it("omits the xai route when the stage has no fallback", () => {
		assert.deepEqual(
			modelTable(null).routes.map((route) => route.id),
			["model-openai", "npm"],
		);
	});

	it("round-trips the built-in table through the boundary parser", () => {
		const parsed = parseRouteTable(roundTrip(modelTable()), "production");

		assert.deepEqual(parsed, { ok: true, table: modelTable() });
	});

	it("rejects unknown fields, a newer version and malformed prefixes", () => {
		const cases = [
			edited((table) => {
				table.extra = 1;
			}),
			edited((table) => {
				table.version = 2;
			}),
			edited((table) => {
				firstRoute(table).surprise = true;
			}),
			edited((table) => {
				firstRoute(table).prefix = "/openai/v1";
			}),
			edited((table) => {
				firstRoute(table).methods = ["GET", "TRACE"];
			}),
			edited((table) => {
				firstRoute(table).id = "Model_OpenAI";
			}),
		];

		for (const value of cases) {
			assert.equal(parseRouteTable(value, "test").ok, false);
		}
	});

	it("rejects duplicate route ids and prefixes", () => {
		const value = edited((table) => {
			const routes = table.routes;

			assert.ok(Array.isArray(routes));
			routes.push(routes[2] ?? null);
		});

		assert.equal(parseRouteTable(value, "test").ok, false);
	});

	it("keeps plain http, test pins and non-built-in uncredentialed routes out of production", () => {
		const plain = edited((table) => {
			const upstream = firstRoute(table).upstream;

			assert.ok(
				upstream !== null &&
					!Array.isArray(upstream) &&
					upstream instanceof Object,
			);
			upstream.scheme = "http";
		});

		const pinned = edited((table) => {
			const upstream = firstRoute(table).upstream;

			assert.ok(
				upstream !== null &&
					!Array.isArray(upstream) &&
					upstream instanceof Object,
			);
			upstream.address = { kind: "pinned", ip: "127.0.0.1" };
		});

		const declared = edited((table) => {
			firstRoute(table).id = "declared-1";
		});

		for (const value of [plain, pinned, declared]) {
			assert.equal(parseRouteTable(value, "production").ok, false);
			assert.equal(parseRouteTable(value, "test").ok, true);
		}
	});

	it("forbids exe.dev, GitHub, npm, localhost and IP literal upstreams", () => {
		for (const host of [
			"github.int.exe.xyz",
			"llm.int.exe.xyz",
			"pi-factorio.exe.xyz",
			"exe.xyz",
			"EXE.XYZ.",
			"github.com",
			"api.github.com",
			"raw.githubusercontent.com",
			"acme.ghe.com",
			"registry.npmjs.org",
			"localhost",
			"127.0.0.1",
			"169.254.169.254",
			"::1",
			"[::1]",
			"2852039166",
		]) {
			assert.equal(isForbiddenUpstreamHost(host), true, host);
		}

		for (const host of ["api.linear.app", "echo.test", "notgithub.community"]) {
			assert.equal(isForbiddenUpstreamHost(host), false, host);
		}
	});
});
