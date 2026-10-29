import {
	createServer,
	type IncomingMessage,
	type ServerResponse,
} from "node:http";
import { gzipSync } from "node:zlib";
import { GATEWAY_USER_AGENT } from "./credentials.ts";

/** What the fixture saw: names and the injected credential, never a body. */
export type Received = {
	readonly method: string;
	readonly path: string;
	readonly host: string | null;
	readonly authorization: string | null;
	readonly headerNames: readonly string[];
};

export type EchoFixture = {
	readonly port: number;
	readonly received: Received[];
	readonly strays: number;
	waitFor(path: string, count: number): Promise<void>;
	arrivals(path: string): number;
	close(): Promise<void>;
};

const SSE_USAGE = [
	'event: response.created\ndata: {"type":"response.created","response":{"id":"resp_fixture","status":"in_progress"}}\n\n',
	'event: response.output_text.delta\ndata: {"type":"response.output_text.delta","delta":"OK"}\n\n',
	'event: response.completed\ndata: {"type":"response.completed","response":{"id":"resp_fixture","status":"completed","usage":{"input_tokens":11,"output_tokens":5,"total_tokens":16}}}\n\n',
];

function headerOf(req: IncomingMessage, name: string): string | null {
	const values: string[] = [];

	for (let index = 0; index + 1 < req.rawHeaders.length; index += 2) {
		const key = req.rawHeaders[index];
		const value = req.rawHeaders[index + 1];

		if (key?.toLowerCase() === name && value !== undefined) values.push(value);
	}

	return values.length === 1 ? (values[0] ?? null) : null;
}

function secretOf(req: IncomingMessage): string {
	return (headerOf(req, "authorization") ?? "").replace(/^Bearer /, "");
}

function respond(req: IncomingMessage, res: ServerResponse, path: string) {
	const secret = secretOf(req);

	switch (path) {
		case "/api/echo":
			res.writeHead(200, { "Content-Type": "application/json" });
			res.end(
				JSON.stringify({
					path,
					headers: req.rawHeaders.filter((_, index) => index % 2 === 0),
				}),
			);

			return;
		case "/api/cookie":
			res.writeHead(200, {
				"Content-Type": "text/plain",
				"Set-Cookie": "session=fixture",
				"WWW-Authenticate": "Bearer",
				"X-Echo": "ok",
			});
			res.end("ok");

			return;
		case "/api/reflect-header":
			res.writeHead(200, { "Content-Type": "text/plain", "X-Echo": secret });
			res.end("ok");

			return;
		case "/api/reflect-body":
			res.writeHead(200, { "Content-Type": "text/plain" });
			res.end(`you sent ${secret}`);

			return;
		case "/api/reflect-base64":
			res.writeHead(200, { "Content-Type": "text/plain" });
			res.end(`b64 ${Buffer.from(secret).toString("base64")}`);

			return;
		case "/api/reflect-split": {
			const half = Math.floor(secret.length / 2);

			res.writeHead(200, { "Content-Type": "text/plain" });
			res.write(`part one ${secret.slice(0, half)}`);
			setTimeout(() => res.end(`${secret.slice(half)} part two`), 20);

			return;
		}

		case "/api/redirect":
			res.writeHead(302, { Location: "https://github.int.exe.xyz/zen" });
			res.end();

			return;
		case "/api/gzip":
			res.writeHead(200, {
				"Content-Type": "text/plain",
				"Content-Encoding": "gzip",
			});
			res.end(gzipSync(Buffer.from("compressed")));

			return;
		case "/openai/v1/models":
		case "/xai/v1/models":
			res.writeHead(200, { "Content-Type": "application/json" });
			res.end('{"object":"list","data":[]}');

			return;
		case "/openai/v1/responses":
		case "/xai/v1/responses":
			res.writeHead(200, { "Content-Type": "text/event-stream" });
			res.end(SSE_USAGE.join(""));

			return;
		case "/openai/v1/slow":
			res.writeHead(200, { "Content-Type": "text/event-stream" });
			res.write(SSE_USAGE[0]);
			setTimeout(() => res.end(SSE_USAGE.slice(1).join("")), 300);

			return;
		case "/openai/v1/hang":
			return;
		default:
			res.writeHead(404, { "Content-Type": "text/plain" });
			res.end("not found");
	}
}

/**
 * A host-side stand-in upstream for credential tests and live lane 5b. It
 * records what arrived and can reflect the injected credential back, so the
 * gateway's scrubbing and fail-closed paths have something to catch.
 *
 * Its loopback port is open to every local process, so it records only
 * requests carrying the gateway's own User-Agent. Any other client gets a
 * 421 and is only counted in `strays`.
 */
export async function startEchoFixture(port: number): Promise<EchoFixture> {
	const received: Received[] = [];
	const waiters: { path: string; count: number; done: () => void }[] = [];

	const arrivals = (path: string) =>
		received.filter((seen) => seen.path === path).length;

	let strays = 0;

	const server = createServer((req, res) => {
		const path = (req.url ?? "/").split("?")[0] ?? "/";

		if (headerOf(req, "user-agent") !== GATEWAY_USER_AGENT) {
			strays += 1;
			req.resume();
			res.writeHead(421, { "Content-Type": "text/plain" });
			res.end("not the gateway");

			return;
		}

		received.push({
			method: req.method ?? "",
			path,
			host: headerOf(req, "host"),
			authorization: headerOf(req, "authorization"),
			headerNames: req.rawHeaders.flatMap((entry, index) =>
				index % 2 === 0 ? [entry.toLowerCase()] : [],
			),
		});

		for (const waiter of waiters.splice(0)) {
			if (arrivals(waiter.path) >= waiter.count) waiter.done();
			else waiters.push(waiter);
		}

		req.resume();
		req.on("end", () => respond(req, res, path));
	});

	await new Promise<void>((done) => server.listen(port, "127.0.0.1", done));

	const address = server.address();

	const bound =
		address !== null && address instanceof Object ? address.port : 0;

	return {
		port: bound,
		received,
		get strays() {
			return strays;
		},
		arrivals,
		waitFor: (path, count) =>
			arrivals(path) >= count
				? Promise.resolve()
				: new Promise((done) => waiters.push({ path, count, done })),
		close: () =>
			new Promise((done) => {
				server.closeAllConnections();
				server.close(() => done());
			}),
	};
}

if (import.meta.main) {
	const fixture = await startEchoFixture(Number(process.argv[2] ?? "0"));

	process.stdout.write(`${JSON.stringify({ port: fixture.port })}\n`);
}
