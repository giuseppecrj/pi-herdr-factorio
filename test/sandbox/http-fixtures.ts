import { randomUUID } from "node:crypto";
import type { Server } from "node:http";
import type { TestContext, SuiteContext } from "node:test";
import {
	startEchoFixture as startEcho,
	type AnthropicReplay,
} from "../../server/sandbox/echo-fixture.ts";

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

export function closeHttpServer(server: Server): Promise<void> {
	return new Promise((done) => {
		server.close(() => done());
		server.closeAllConnections();
	});
}
