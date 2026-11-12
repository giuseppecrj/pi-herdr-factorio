import assert from "node:assert/strict";
import {
	credentialId,
	type CredentialId,
	type Route,
} from "../../../host/gateway/routes.ts";
import { modelTable } from "./route-fixtures.ts";

export const ECHO_SECRET = "fixture-secret-7Hq2-not-real";

export function id(text: string): CredentialId {
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
