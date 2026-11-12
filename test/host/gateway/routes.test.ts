import { modelTable, anthropicTable } from "./route-fixtures.ts";
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
	ANTHROPIC_MAX_OUTPUT_TOKENS,
	anthropicMaxOutput,
	isAnthropicModelId,
	parseAnthropicModel,
} from "../../../src/core/models.ts";
import {
	BUILTIN_HOSTS,
	isForbiddenUpstreamHost,
	parseRouteTable,
	type RouteTable,
} from "../../../host/gateway/routes.ts";
import type { JsonValue } from "../../../src/core/json.ts";
import { EXE_DEV_PLATFORM } from "../../../src/trust/platform.ts";

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
		const parsed = parseRouteTable(
			roundTrip(modelTable()),
			"production",
			EXE_DEV_PLATFORM,
		);

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
			assert.equal(parseRouteTable(value, "test", EXE_DEV_PLATFORM).ok, false);
		}
	});

	it("rejects duplicate route ids and prefixes", () => {
		const value = edited((table) => {
			const routes = table.routes;

			assert.ok(Array.isArray(routes));
			routes.push(routes[2] ?? null);
		});

		assert.equal(parseRouteTable(value, "test", EXE_DEV_PLATFORM).ok, false);
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
			assert.equal(
				parseRouteTable(value, "production", EXE_DEV_PLATFORM).ok,
				false,
			);
			assert.equal(parseRouteTable(value, "test", EXE_DEV_PLATFORM).ok, true);
		}
	});

	it("freezes the 13 listed Anthropic models and their output maximums", () => {
		assert.deepEqual(Object.entries(ANTHROPIC_MAX_OUTPUT_TOKENS), [
			["claude-opus-5-5", 128_000],
			["claude-opus-5", 128_000],
			["claude-fable-5-1", 128_000],
			["claude-fable-5", 128_000],
			["claude-opus-4-8", 128_000],
			["claude-opus-4-7", 128_000],
			["claude-opus-4-5", 64_000],
			["claude-sonnet-5-5", 128_000],
			["claude-sonnet-5", 128_000],
			["claude-sonnet-4-6", 128_000],
			["claude-sonnet-4-5", 64_000],
			["claude-haiku-5-5", 128_000],
			["claude-haiku-4-5", 64_000],
		]);
		assert.equal(Object.isFrozen(ANTHROPIC_MAX_OUTPUT_TOKENS), true);
		assert.equal(
			parseAnthropicModel("anthropic/claude-sonnet-5-5"),
			"claude-sonnet-5-5",
		);
		assert.equal(parseAnthropicModel("claude-haiku-4-5"), "claude-haiku-4-5");
		assert.equal(anthropicMaxOutput("anthropic/claude-opus-4-5"), 64_000);
		assert.equal(anthropicMaxOutput("claude-haiku-5-5"), 128_000);
		assert.equal(isAnthropicModelId("claude-haiku-5-5"), true);
		assert.equal(isAnthropicModelId("anthropic/claude-haiku-5-5"), false);

		for (const unknown of [
			"claude-opus-4-6",
			"anthropic/",
			"openai/claude-haiku-5-5",
			"anthropic/anthropic/claude-haiku-5-5",
			"constructor",
			"toString",
			"",
		]) {
			assert.equal(parseAnthropicModel(unknown), null, unknown);
			assert.equal(anthropicMaxOutput(unknown), null, unknown);
		}
	});

	it("mounts model-anthropic alone, open, for an Anthropic primary", () => {
		const table = anthropicTable();
		const [anthropic] = table.routes;

		assert.deepEqual(
			table.routes.map((route) => [route.id, route.prefix, route.initially]),
			[
				["model-anthropic", "/anthropic/", "open"],
				["npm", "/npm/", "open"],
			],
		);
		assert.deepEqual(anthropic?.upstream, {
			scheme: "https",
			host: "llm.int.exe.xyz",
			port: 443,
			basePath: "/anthropic/",
			hostHeader: "llm.int.exe.xyz",
			sni: "llm.int.exe.xyz",
			address: { kind: "pinned", ip: "169.254.169.254" },
		});
		assert.deepEqual(anthropic?.methods, ["GET", "POST"]);
		assert.deepEqual(anthropic?.paths, [
			{ kind: "exact", path: "v1/models" },
			{ kind: "exact", path: "v1/messages" },
		]);
		assert.deepEqual(anthropic?.query, {
			kind: "exact",
			values: ["beta=true"],
		});
		assert.deepEqual(anthropic?.requestHeaders, [
			"accept",
			"content-type",
			"anthropic-version",
			"anthropic-beta",
		]);
		assert.deepEqual(anthropic?.body, {
			kind: "json",
			contentTypes: ["application/json"],
			constraints: [
				{ kind: "one_of", pointer: "/model", values: ["claude-sonnet-5-5"] },
				{
					kind: "each_keys",
					pointer: "/tools",
					required: ["name", "input_schema"],
					allowed: [
						"name",
						"description",
						"input_schema",
						"eager_input_streaming",
						"strict",
						"cache_control",
						"defer_loading",
					],
				},
				{ kind: "absent", pointer: "/max_output_tokens" },
				{ kind: "absent", pointer: "/mcp_servers" },
			],
		});
		assert.equal(anthropic?.credential, null);
		assert.equal(anthropic?.budget, true);
		assert.equal(anthropic?.meter, "anthropic-messages-sse");
	});

	it("mounts a closed model-openai for an Anthropic primary's OpenAI fallback, and refuses any other fallback", () => {
		const table = anthropicTable({ fallback: "openai/gpt-6.1-sol" });

		assert.deepEqual(
			table.routes.map((route) => [route.id, route.initially]),
			[
				["model-anthropic", "open"],
				["model-openai", "closed"],
				["npm", "open"],
			],
		);
		assert.deepEqual(
			table.routes[1]?.body.kind === "json"
				? table.routes[1].body.constraints[0]
				: null,
			{ kind: "one_of", pointer: "/model", values: ["gpt-6.1-sol"] },
		);

		for (const fallback of ["grok-4.6", "claude-haiku-5-5"]) {
			assert.throws(() => anthropicTable({ fallback }), fallback);
		}
	});

	it("never mounts Anthropic for an OpenAI primary, even through the non-OpenAI fallback branch", () => {
		for (const fallback of [
			"grok-4.6",
			"claude-sonnet-5-5",
			"anthropic/claude-sonnet-5-5",
		]) {
			assert.throws(() => modelTable(fallback), /openai\/ or xai\//, fallback);
		}

		for (const fallback of [null, "openai/gpt-6.1-terra", "xai/grok-4.6"]) {
			const routes = modelTable(fallback).routes;

			assert.equal(routes[0]?.id, "model-openai", String(fallback));
			assert.equal(
				routes.some(
					(route) =>
						route.id === "model-anthropic" ||
						route.prefix === "/anthropic/" ||
						route.meter === "anthropic-messages-sse",
				),
				false,
				String(fallback),
			);
		}
	});

	it("round-trips the Anthropic table through the production parser and rejects malformed new rules", () => {
		for (const table of [
			anthropicTable(),
			anthropicTable({ fallback: "openai/gpt-6.1-sol" }),
		]) {
			assert.deepEqual(
				parseRouteTable(roundTrip(table), "production", EXE_DEV_PLATFORM),
				{
					ok: true,
					table,
				},
			);
		}

		const broken = (edit: (route: { [key: string]: JsonValue }) => void) => {
			const value = roundTrip(anthropicTable());

			assert.ok(
				value !== null && !Array.isArray(value) && value instanceof Object,
			);
			edit(firstRoute(value));

			return value;
		};

		for (const value of [
			broken((route) => {
				route.query = { kind: "exact", values: [] };
			}),
			broken((route) => {
				route.query = { kind: "exact", values: ["beta=true#x"] };
			}),
			broken((route) => {
				route.query = { kind: "exact", values: ["beta=true"], extra: 1 };
			}),
			broken((route) => {
				route.body = {
					kind: "json",
					contentTypes: ["application/json"],
					constraints: [
						{
							kind: "each_keys",
							pointer: "/tools",
							required: ["type"],
							allowed: ["name"],
						},
					],
				};
			}),
			broken((route) => {
				route.meter = "anthropic-sse";
			}),
			broken((route) => {
				const upstream = route.upstream;

				assert.ok(
					upstream !== null &&
						!Array.isArray(upstream) &&
						upstream instanceof Object,
				);
				upstream.basePath = "/openai/v1/";
			}),
		]) {
			assert.equal(
				parseRouteTable(value, "production", EXE_DEV_PLATFORM).ok,
				false,
			);
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
			assert.equal(isForbiddenUpstreamHost(host, EXE_DEV_PLATFORM), true, host);
		}

		for (const host of ["api.linear.app", "echo.test", "notgithub.community"]) {
			assert.equal(
				isForbiddenUpstreamHost(host, EXE_DEV_PLATFORM),
				false,
				host,
			);
		}
	});
});
