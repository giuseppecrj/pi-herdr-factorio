import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import type { Server } from "node:http";
import type { TestContext, SuiteContext } from "node:test";
import {
	startEchoFixture as startEcho,
	type AnthropicReplay,
	type EchoFixture,
} from "../../../host/gateway/echo-fixture.ts";

export async function startEchoFixture(
	context: TestContext | SuiteContext,
	port: number,
	options: {
		readonly anthropic?: AnthropicReplay;
		readonly host?: string;
	} = {},
) {
	const fixture = await startEcho(port, {
		...options,
		host: options.host ?? `${randomUUID()}.fixture`,
	});

	if ("after" in context) context.after(() => fixture.close());

	return fixture;
}

export function assertNoStrays(
	fixture: EchoFixture,
	expectedBodies: readonly string[],
): void {
	assert.equal(fixture.strays, 0);

	const digests = new Set(
		expectedBodies.map((body) =>
			createHash("sha256").update(body).digest("hex"),
		),
	);

	assert.deepEqual(
		fixture.foreign.filter(
			(seen) =>
				!seen.host?.endsWith(".fixture") && digests.has(seen.bodyDigest),
		),
		[],
		"this test's request bypassed the gateway",
	);
}

export function closeHttpServer(server: Server): Promise<void> {
	return new Promise((done) => {
		server.close(() => done());
		server.closeAllConnections();
	});
}
