import { createHash } from "node:crypto";
import {
	createServer,
	type IncomingMessage,
	type ServerResponse,
} from "node:http";
import { brotliCompressSync, deflateRawSync, gzipSync } from "node:zlib";
import type { JsonObject } from "../../src/core/json.ts";
import {
	CREDENTIALED_RESPONSE_MAX_BYTES,
	GATEWAY_USER_AGENT,
} from "./credentials.ts";

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
	readonly host: string;
	readonly foreign: {
		method: string;
		path: string;
		host: string | null;
		source: string | null;
		bodyDigest: string;
	}[];
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

/**
 * Which Anthropic Messages stream `/anthropic/v1/messages` replays. `usage`
 * is a complete stream with a final `message_delta` usage block. `no-usage`
 * drops that block, so the gateway's Anthropic meter must call it
 * unusable. `refusal` ends with `stop_reason: "refusal"` and full usage.
 * Lane 3 and lane 7 replay these with zero real tokens.
 */
export const ANTHROPIC_REPLAYS = ["usage", "no-usage", "refusal"] as const;

export type AnthropicReplay = (typeof ANTHROPIC_REPLAYS)[number];

export const ANTHROPIC_REPLAY_MODEL = "claude-sonnet-5-5";

function anthropicStream(mode: AnthropicReplay): string {
	const event = (name: string, data: JsonObject) =>
		`event: ${name}\ndata: ${JSON.stringify(data)}\n\n`;

	const usage = {
		input_tokens: 18,
		cache_creation_input_tokens: 0,
		cache_read_input_tokens: 0,
		output_tokens: 4,
	};

	const ending: JsonObject = {
		type: "message_delta",
		delta: { stop_reason: mode === "refusal" ? "refusal" : "end_turn" },
	};

	// `no-usage` is the missing usage block the Anthropic meter must refuse.
	const delta: JsonObject = mode === "no-usage" ? ending : { ...ending, usage };

	return [
		event("message_start", {
			type: "message_start",
			message: {
				id: "msg_fixture",
				type: "message",
				role: "assistant",
				model: ANTHROPIC_REPLAY_MODEL,
				content: [],
				stop_reason: null,
				usage: { ...usage, output_tokens: 1 },
			},
		}),
		event("content_block_start", {
			type: "content_block_start",
			index: 0,
			content_block: { type: "text", text: "" },
		}),
		event("ping", { type: "ping" }),
		event("content_block_delta", {
			type: "content_block_delta",
			index: 0,
			delta: { type: "text_delta", text: "OK" },
		}),
		event("content_block_stop", { type: "content_block_stop", index: 0 }),
		event("message_delta", delta),
		event("message_stop", { type: "message_stop" }),
	].join("");
}

/** Clean UTF-8 text of exactly `size` bytes, with non-ASCII characters and emoji. */
export function cleanBody(size: number): Buffer {
	const line = Buffer.from('{"t":"caf\u00e9 \u{1f600} \u65e5\u672c"}\n');
	const body = Buffer.alloc(size, " ");

	for (let at = 0; at + line.length <= size; at += line.length) {
		line.copy(body, at);
	}

	return body;
}

/**
 * The base64 of `leak <secret>` with a run of `!` between every character.
 * The longest form of a secret is its percent encoding, three bytes per
 * secret byte, so each run is longer than the `6 × len(longest form) − 1`
 * bytes a streaming hold window would keep.
 */
export function gappedBase64(secret: string): Buffer {
	const gap = "!".repeat(Buffer.byteLength(secret) * 18 + 8);

	return Buffer.from(
		[...Buffer.from(`leak ${secret}`).toString("base64")].join(gap),
	);
}

/** Writes `body` in `size`-byte chunks, one per turn of the event loop. */
function trickle(res: ServerResponse, body: Buffer, size: number): void {
	const next = (at: number) => {
		if (res.destroyed) return;

		if (at >= body.length) {
			res.end();

			return;
		}

		res.write(body.subarray(at, at + size));
		setImmediate(() => next(at + size));
	};

	next(0);
}

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

function respond(
	req: IncomingMessage,
	res: ServerResponse,
	path: string,
	anthropic: AnthropicReplay,
	held: (() => void)[],
) {
	const secret = secretOf(req);

	switch (path) {
		case "/api/reflect-base64-gaps-1":
		case "/api/reflect-base64-gaps-64":
		case "/api/reflect-base64-gaps-whole": {
			const body = gappedBase64(secret);
			const chunking = path.slice("/api/reflect-base64-gaps-".length);

			res.writeHead(200, { "Content-Type": "text/plain" });
			trickle(res, body, chunking === "whole" ? body.length : Number(chunking));

			return;
		}

		case "/api/cap-clean":
			res.writeHead(200, { "Content-Type": "text/plain; charset=utf-8" });
			trickle(res, cleanBody(CREDENTIALED_RESPONSE_MAX_BYTES), 64 * 1024);

			return;
		case "/api/over-cap-clean":
			res.writeHead(200, { "Content-Type": "text/plain; charset=utf-8" });
			trickle(res, cleanBody(CREDENTIALED_RESPONSE_MAX_BYTES + 1), 64 * 1024);

			return;
		case "/api/held":
			res.writeHead(200, { "Content-Type": "text/plain" });
			res.write(cleanBody(4096));
			held.push(() => res.end("released\n"));

			return;
		case "/api/release":
			for (const release of held.splice(0)) release();

			res.writeHead(200, { "Content-Type": "text/plain" });
			res.end("ok");

			return;
		case "/anthropic/v1/models":
			res.writeHead(200, { "Content-Type": "application/json" });
			res.end('{"data":[],"has_more":false}');

			return;
		case "/anthropic/v1/messages":
			res.writeHead(200, { "Content-Type": "text/event-stream" });
			res.end(anthropicStream(anthropic));

			return;
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
		case "/api/reflect-json-escape":
			res.writeHead(200, { "Content-Type": "application/json" });
			res.end(
				`{"echo":"${[...secret].map((char) => `\\u${char.charCodeAt(0).toString(16).padStart(4, "0")}`).join("")}"}`,
			);

			return;
		case "/api/reflect-percent-mixed":
			res.writeHead(200, { "Content-Type": "text/plain" });
			res.end(
				`q=%${secret.charCodeAt(0).toString(16)}${encodeURIComponent(secret.slice(1))}`,
			);

			return;
		case "/api/reflect-base64-shifted":
			res.writeHead(200, { "Content-Type": "text/plain" });
			res.end(Buffer.from(`x${secret} and more`).toString("base64"));

			return;
		case "/api/reflect-gzip-bare":
			res.writeHead(200, { "Content-Type": "application/octet-stream" });
			res.end(gzipSync(Buffer.from(`leak ${secret}`)));

			return;
		case "/api/reflect-gzip-text":
			res.writeHead(200, { "Content-Type": "text/plain" });
			res.end(gzipSync(Buffer.from(`leak ${secret}`)));

			return;
		case "/api/reflect-deflate-raw":
			res.writeHead(200, { "Content-Type": "application/octet-stream" });
			res.end(deflateRawSync(Buffer.from(`leak ${secret}`)));

			return;
		case "/api/reflect-brotli":
			res.writeHead(200, { "Content-Type": "application/octet-stream" });
			res.end(
				brotliCompressSync(
					Buffer.from(`${"A".repeat(64)}${secret}${"B".repeat(64)}`),
				),
			);

			return;
		case "/api/reflect-gzip-prefixed":
			res.writeHead(200, { "Content-Type": "image/png" });
			res.end(
				Buffer.concat([Buffer.from("xxxx"), gzipSync(Buffer.from(secret))]),
			);

			return;
		case "/api/reflect-hex-mixed": {
			let letters = 0;

			res.writeHead(200, { "Content-Type": "text/plain" });
			res.end(
				Buffer.from(secret)
					.toString("hex")
					.replace(/[a-f]/g, (letter) => {
						letters += 1;

						return letters % 2 === 0 ? letter.toUpperCase() : letter;
					}),
			);

			return;
		}

		case "/api/reflect-base64-star":
			res.writeHead(200, { "Content-Type": "text/plain" });
			res.end([...Buffer.from(`leak ${secret}`).toString("base64")].join("*"));

			return;
		case "/api/reflect-base64-form-feed":
			res.writeHead(200, { "Content-Type": "text/plain" });
			res.end(
				(
					Buffer.from(`leak ${secret}`)
						.toString("base64")
						.match(/.{1,4}/g) ?? []
				).join("\f"),
			);

			return;
		case "/api/reflect-deflate-raw-text":
			res.writeHead(200, { "Content-Type": "text/plain" });
			res.end(deflateRawSync(Buffer.from(`leak ${secret}`)));

			return;
		case "/api/reflect-brotli-json":
			res.writeHead(200, { "Content-Type": "application/json" });
			res.end(
				brotliCompressSync(
					Buffer.from(`${"A".repeat(64)}${secret}${"B".repeat(64)}`),
				),
			);

			return;
		case "/api/reflect-gzip-prefixed-text":
			res.writeHead(200, { "Content-Type": "text/plain" });
			res.end(
				Buffer.concat([Buffer.from("xxxx"), gzipSync(Buffer.from(secret))]),
			);

			return;
		case "/api/untyped":
			res.writeHead(200);
			res.end("ok");

			return;
		case "/api/identity":
			res.writeHead(200, {
				"Content-Type": "text/plain",
				"Content-Encoding": "identity",
			});
			res.end("ok");

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
 * requests carrying the gateway's own User-Agent. Tests supply a unique
 * Host token as well: requests without it get 421 and are recorded in
 * `foreign`, never attributed to this test's strict `strays` count.
 */
export async function startEchoFixture(
	port: number,
	options: {
		readonly anthropic?: AnthropicReplay;
		readonly host?: string;
	} = {},
): Promise<EchoFixture> {
	const anthropic = options.anthropic ?? "usage";
	const received: Received[] = [];
	const foreign: EchoFixture["foreign"] = [];
	const waiters: { path: string; count: number; done: () => void }[] = [];
	const held: (() => void)[] = [];

	const arrivals = (path: string) =>
		received.filter((seen) => seen.path === path).length;

	let strays = 0;

	const server = createServer((req, res) => {
		const path = (req.url ?? "/").split("?")[0] ?? "/";

		if (options.host !== undefined && headerOf(req, "host") !== options.host) {
			const hash = createHash("sha256");
			const source = req.socket.remoteAddress ?? null;

			req.on("data", (chunk: Buffer) => hash.update(chunk));
			req.on("end", () => {
				foreign.push({
					method: req.method ?? "",
					path: req.url ?? "/",
					host: headerOf(req, "host"),
					source,
					bodyDigest: hash.digest("hex"),
				});
				res.writeHead(421, { "Content-Type": "text/plain" });
				res.end("not this fixture");
			});

			return;
		}

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
		req.on("end", () => respond(req, res, path, anthropic, held));
	});

	await new Promise<void>((done) => server.listen(port, "127.0.0.1", done));

	const address = server.address();

	const bound =
		address !== null && address instanceof Object ? address.port : 0;

	return {
		port: bound,
		host: options.host ?? "llm.test",
		foreign,
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
	const mode = ANTHROPIC_REPLAYS.find((known) => known === process.argv[3]);

	const fixture = await startEchoFixture(Number(process.argv[2] ?? "0"), {
		anthropic: mode ?? "usage",
	});

	process.stdout.write(`${JSON.stringify({ port: fixture.port })}\n`);
}
