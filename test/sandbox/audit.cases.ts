import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
	AuditLog,
	type AuditRecord,
	auditLine,
	redactMethod,
	redactPath,
} from "../../server/sandbox/audit.ts";
import {
	SecretScanner,
	secretForms,
} from "../../server/sandbox/credentials.ts";
import { SseMeter } from "../../server/sandbox/meter.ts";

function record(overrides: Partial<AuditRecord> = {}): AuditRecord {
	return {
		v: 1,
		ts: "2026-10-29T14:56:59.812Z",
		stage: "build",
		runId: "a".repeat(64),
		attempt: 1,
		req: 17,
		route: null,
		method: "POST",
		path: "/openai/v1/responses",
		upstream: null,
		status: 403,
		bytesIn: 0,
		bytesOut: 0,
		durationMs: 1,
		credential: null,
		decision: "deny",
		reason: "no-route",
		gate: "open",
		inputTokens: null,
		outputTokens: null,
		...overrides,
	};
}

describe("gateway audit", () => {
	it("redacts the query, truncates and replaces unsafe bytes in the path", () => {
		assert.equal(redactPath("/npm/x?token=abc"), "/npm/x?…");
		assert.equal(redactPath("/npm/<script>\"'"), "/npm/_script___");
		assert.equal(redactPath(`/npm/${"a".repeat(300)}`).length, 128);
		assert.equal(redactPath("/npm/%2e%2e/x"), "/npm/%2e%2e/x");
		assert.equal(
			redactPath("https://user:secret@github.int.exe.xyz/zen"),
			"https_//user_secret_github.int.exe.xyz/zen",
		);
		assert.equal(redactMethod("GET"), "GET");
		assert.equal(redactMethod("G\u00e9T<x>"), "G_T___");
	});

	it("redacts a secret split by a slash, an encoded slash or written as hex", () => {
		const secret = "fixture-secret-7Hq2-not-real";

		const scanner = new SecretScanner(
			secretForms(Buffer.from(secret), {
				kind: "header",
				name: "Authorization",
				scheme: "Bearer",
			}),
		);

		const reveals = (text: string) => scanner.reveals(text);

		for (const path of [
			"/plain/api/fixture-secret-7/Hq2-not-real",
			"/plain/api/fixture-secret-7%2fHq2-not-real",
			"/plain/api/fixture-secret-7%2FHq2-not-real",
			`/plain/api/${Buffer.from(secret).toString("hex").slice(0, 20)}/${Buffer.from(secret).toString("hex").slice(20)}`,
		]) {
			assert.equal(redactPath(path, reveals), "[redacted]", path);
		}

		for (const segment of [secret, Buffer.from(secret).toString("hex")]) {
			assert.equal(
				redactPath(`/plain/api/${segment}`, reveals),
				"/plain/api/~redacted~",
			);
		}

		assert.equal(redactPath("/plain/api/x", reveals), "/plain/api/x");
	});

	it("writes one JSON line per request with fixed fields and no secrets", () => {
		const line = auditLine(record());

		assert.equal(line.endsWith("\n"), true);
		assert.equal(line.split("\n").length, 2);
		assert.deepEqual(Object.keys(JSON.parse(line)), [
			"v",
			"ts",
			"stage",
			"runId",
			"attempt",
			"req",
			"route",
			"method",
			"path",
			"upstream",
			"status",
			"bytesIn",
			"bytesOut",
			"durationMs",
			"credential",
			"decision",
			"reason",
			"gate",
			"inputTokens",
			"outputTokens",
		]);
	});

	it("reports unavailable once a write fails or the cap is reached", () => {
		const lines: string[] = [];
		const capped = new AuditLog((text) => lines.push(text), 600);

		assert.equal(capped.append(record()), true);
		assert.equal(capped.healthy(), true);
		assert.equal(capped.append(record()), false);
		assert.equal(capped.healthy(), false);
		assert.equal(capped.full, true);
		assert.equal(lines.length, 1);

		const broken = new AuditLog(() => {
			throw new Error("EIO");
		}, 1_000_000);

		assert.equal(broken.append(record()), false);
		assert.equal(broken.healthy(), false);
		assert.equal(broken.full, false);
	});
});

const COMPLETED = [
	'event: response.created\ndata: {"type":"response.created","response":{"id":"resp_1","status":"in_progress"}}\n\n',
	'event: response.output_text.delta\ndata: {"type":"response.output_text.delta","delta":"OK"}\n\n',
	'event: response.completed\ndata: {"type":"response.completed","response":{"id":"resp_1","status":"completed","usage":{"input_tokens":11,"input_tokens_details":{"cached_tokens":0},"output_tokens":5,"output_tokens_details":{"reasoning_tokens":0},"total_tokens":16}}}\n\n',
].join("");

describe("openai-responses-sse meter", () => {
	it("reads usage from the terminal completed event", () => {
		const meter = new SseMeter();

		meter.push(Buffer.from(COMPLETED));
		assert.deepEqual(meter.usage(), { inputTokens: 11, outputTokens: 5 });
	});

	it("handles a data line split across chunks and CRLF framing", () => {
		const meter = new SseMeter();
		const text = COMPLETED.replace(/\n/g, "\r\n");

		for (let index = 0; index < text.length; index += 7) {
			meter.push(Buffer.from(text.slice(index, index + 7)));
		}

		assert.deepEqual(meter.usage(), { inputTokens: 11, outputTokens: 5 });
	});

	it("also reads incomplete and failed terminal events", () => {
		for (const type of ["response.incomplete", "response.failed"]) {
			const meter = new SseMeter();

			meter.push(
				Buffer.from(
					`data: {"type":"${type}","response":{"usage":{"input_tokens":3,"output_tokens":0}}}\n\n`,
				),
			);
			assert.deepEqual(
				meter.usage(),
				{ inputTokens: 3, outputTokens: 0 },
				type,
			);
		}
	});

	it("reports a stream with no usage event as unmetered", () => {
		const meter = new SseMeter();

		meter.push(
			Buffer.from('data: {"type":"response.created"}\n\ndata: [DONE]\n\n'),
		);
		assert.equal(meter.usage(), null);
	});
});
