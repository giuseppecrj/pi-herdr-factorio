import assert from "node:assert/strict";
import {
	mkdtempSync,
	readFileSync,
	rmSync,
	statSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import {
	AuditLog,
	type AuditRecord,
	auditLine,
	JOURNAL_FILE,
	type JournalRecord,
	openAuditFile,
	redactMethod,
	redactPath,
} from "../../host/gateway/audit.ts";
import { journalCharge, requestSettlements } from "../../src/core/journal.ts";
import { SecretScanner, secretForms } from "../../host/gateway/credentials.ts";
import { AnthropicSseMeter, SseMeter } from "../../host/gateway/meter.ts";
import type { RouteId } from "../../host/gateway/routes.ts";

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

// SAFETY: a literal route id that matches the RouteId pattern.
const OPENAI = "model-openai" as RouteId;

const NO_JOURNAL = { write: () => {}, sync: () => {} };

import {
	assertReaderParity,
	SETTLEMENT_FIXTURES,
	journalText,
	requestFixture,
	replyFixture,
} from "./settlement-fixtures.ts";

describe("request settlement projection", () => {
	it("projects all seven variants without rewriting journal bytes", () => {
		const cases = [
			["Admitted", [{ ...requestFixture(1), kind: "admitted" }], true],
			["Dispatched", [requestFixture(1)], false],
			["Uncertain", [requestFixture(1)], true],
			[
				"Unreachable",
				[
					requestFixture(1),
					replyFixture(1, {
						status: 502,
						decision: "error",
						reason: "upstream_unreachable",
						inputTokens: null,
						outputTokens: null,
					}),
				],
				true,
			],
			[
				"ProviderRejected",
				[
					requestFixture(1),
					replyFixture(1, {
						status: 529,
						reason: "provider_rejected",
						inputTokens: 0,
						outputTokens: 0,
					}),
				],
				true,
			],
			["Metered", [requestFixture(1), replyFixture(1)], true],
			[
				"Unmetered",
				[
					requestFixture(1, "model-anthropic", {}),
					replyFixture(1, { inputTokens: null, outputTokens: null }),
				],
				true,
			],
		] as const;

		for (const [kind, records, stopped] of cases) {
			const journal = journalText(records);
			const projected = requestSettlements(journal, { stopped });

			assert.equal(projected.requests.length, 1, kind);
			assert.equal(projected.requests[0]?.kind, kind);
			assert.equal(journal, journalText(records));
		}
	});

	it("keeps the lost result input-plus-output bound and the #613 transport origin", () => {
		const lost = requestSettlements(journalText([requestFixture(1)]))
			.requests[0];

		assert.ok(lost?.kind === "Uncertain");
		assert.deepEqual(lost.bound, { inputTokens: 100, maxOutputTokens: 1000 });
		assert.equal(lost.result, null);

		for (const status of [502, 504]) {
			const provider = replyFixture(1, {
				status,
				decision: "error",
				inputTokens: null,
				outputTokens: null,
			});

			const upstream = requestSettlements(
				journalText([requestFixture(1), provider]),
			).requests[0];

			const transport = requestSettlements(
				journalText([
					requestFixture(1),
					{ ...provider, reason: "upstream_unreachable" },
				]),
			).requests[0];

			assert.equal(upstream?.kind, "Uncertain");
			assert.ok(transport?.kind === "Unreachable");
			assert.equal(transport.origin, "gateway-before-headers");
		}
	});

	for (const [name, journal] of SETTLEMENT_FIXTURES)
		it(`preserves charge and family readers: ${name}`, () =>
			assertReaderParity(journal));
});

function dispatch(req: number): JournalRecord {
	return {
		v: 1,
		kind: "dispatch",
		ts: "2026-11-04T10:00:00.000Z",
		stage: "specify",
		runId: "a".repeat(64),
		attempt: 1,
		req,
		route: OPENAI,
	};
}

function result(
	req: number,
	inputTokens: number | null,
	outputTokens: number | null,
): JournalRecord {
	return {
		v: 1,
		kind: "result",
		ts: "2026-11-04T10:00:01.000Z",
		stage: "specify",
		runId: "a".repeat(64),
		attempt: 1,
		req,
		route: OPENAI,
		status: 200,
		decision: "forward",
		inputTokens,
		outputTokens,
	};
}

describe("gateway request journal", () => {
	it("syncs each dispatch and result before reporting it written", () => {
		const steps: string[] = [];

		const log = new AuditLog(() => steps.push("audit"), 1_000_000, {
			write: (text) => steps.push(`write:${JSON.parse(text).kind}`),
			sync: () => steps.push("sync"),
		});

		assert.equal(log.journal(dispatch(1)), true);
		assert.equal(log.journal(result(1, 11, 5)), true);
		assert.deepEqual(steps, ["write:dispatch", "sync", "write:result", "sync"]);
	});

	it("refuses every later record once a journal write or sync fails", () => {
		for (const broken of ["write", "sync"] as const) {
			const log = new AuditLog(() => {}, 1_000_000, {
				write: () => {
					if (broken === "write") throw new Error("EIO");
				},
				sync: () => {
					if (broken === "sync") throw new Error("EIO");
				},
			});

			assert.equal(log.journal(dispatch(1)), false, broken);
			assert.equal(log.healthy(), false, broken);
			assert.equal(log.append(record()), false, broken);
		}
	});

	it("opens the journal beside the audit, mode 0600, and never reuses one", () => {
		const dir = mkdtempSync(join(tmpdir(), "factory-journal-"));

		try {
			const file = openAuditFile(join(dir, "egress.jsonl"), 1_000_000);

			assert.equal(file.log.journal(dispatch(1)), true);
			file.close();
			assert.equal(statSync(join(dir, JOURNAL_FILE)).mode & 0o777, 0o600);
			assert.equal(
				JSON.parse(readFileSync(join(dir, JOURNAL_FILE), "utf8")).kind,
				"dispatch",
			);

			const other = mkdtempSync(join(dir, "again-"));

			writeFileSync(join(other, JOURNAL_FILE), "");
			assert.throws(() => openAuditFile(join(other, "egress.jsonl"), 1000));
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});

	it("counts settled results once and a dispatch without a result as uncertain", () => {
		const text = [
			dispatch(1),
			result(1, 11, 5),
			dispatch(2),
			result(2, null, null),
			dispatch(3),
			result(3, 20, 4),
			result(3, 20, 4),
			dispatch(4),
		]
			.map((entry) => JSON.stringify(entry))
			.join("\n")
			.concat('\n{"v":1,"kind":"res');

		assert.deepEqual(journalCharge(text), {
			tokens: 40,
			dispatched: 4,
			settled: 3,
			unmetered: 1,
			uncertain: 1,
			uncertainTokens: 0,
		});
		assert.deepEqual(
			journalCharge(
				[
					{ ...dispatch(1), inputTokenEstimate: 500, maxOutputTokens: 1000 },
					result(1, null, null),
					{ ...dispatch(2), inputTokenEstimate: 0, maxOutputTokens: 0 },
					result(2, null, null),
					{ ...dispatch(3), inputTokenEstimate: 9, maxOutputTokens: 1 },
					result(3, 4, 2),
				]
					.map((entry) => JSON.stringify(entry))
					.join("\n"),
			),
			{
				tokens: 6,
				dispatched: 3,
				settled: 3,
				unmetered: 2,
				uncertain: 1,
				uncertainTokens: 1500,
			},
			"an unmetered result keeps its positive dispatch bound uncertain",
		);
		assert.deepEqual(journalCharge(""), {
			tokens: 0,
			dispatched: 0,
			settled: 0,
			unmetered: 0,
			uncertain: 0,
			uncertainTokens: 0,
		});
	});
});

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
		const capped = new AuditLog((text) => lines.push(text), 600, NO_JOURNAL);

		assert.equal(capped.append(record()), true);
		assert.equal(capped.healthy(), true);
		assert.equal(capped.append(record()), false);
		assert.equal(capped.healthy(), false);
		assert.equal(capped.full, true);
		assert.equal(lines.length, 1);

		const broken = new AuditLog(
			() => {
				throw new Error("EIO");
			},
			1_000_000,
			NO_JOURNAL,
		);

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

/** Probe r6's stream, byte for byte, including the edge's trailing space padding. */
const R6_START =
	'event: message_start\ndata: {"type":"message_start","message":{"model":"claude-haiku-5-5","id":"msg_011CgifeeqXmwL6iHuNdTavu","type":"message","role":"assistant","content":[],"container":null,"stop_reason":null,"stop_sequence":null,"stop_details":null,"usage":{"input_tokens":18,"cache_creation_input_tokens":0,"cache_read_input_tokens":0,"cache_creation":{"ephemeral_5m_input_tokens":0,"ephemeral_1h_input_tokens":0},"output_tokens":4,"service_tier":"standard","inference_geo":"us","speed":"standard"},"diagnostics":null}          }\n\n';

const R6_BODY = [
	'event: content_block_start\ndata: {"type":"content_block_start","index":0,"content_block":{"type":"text","text":""}}\n\n',
	'event: ping\ndata: {"type": "ping"}\n\n',
	'event: content_block_delta\ndata: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"ok"}             }\n\n',
	'event: content_block_stop\ndata: {"type":"content_block_stop","index":0      }\n\n',
].join("");

const R6_DELTA =
	'event: message_delta\ndata: {"type":"message_delta","delta":{"stop_reason":"end_turn","stop_sequence":null,"stop_details":null,"container":null},"usage":{"input_tokens":18,"cache_creation_input_tokens":0,"cache_read_input_tokens":0,"output_tokens":4,"output_tokens_details":{"thinking_tokens":0}}      }\n\n';

const R6_STOP =
	'event: message_stop\ndata: {"type":"message_stop"         }\n\n';

const R6 = R6_START + R6_BODY + R6_DELTA + R6_STOP;

function anthropicMeter(
	text: string,
	step = text.length,
): ReturnType<AnthropicSseMeter["result"]> {
	const bytes = Buffer.from(text);
	const meter = new AnthropicSseMeter();

	for (let index = 0; index < bytes.length; index += step) {
		meter.push(bytes.subarray(index, index + step));
	}

	meter.end();

	return meter.result();
}

const R6_METERED = {
	kind: "metered",
	inputTokens: 18,
	outputTokens: 4,
	observedModel: "claude-haiku-5-5",
} as const;

describe("anthropic-messages-sse meter", () => {
	it("reads probe r6's padded stream: input 18, output 4, the bare model", () => {
		assert.deepEqual(anthropicMeter(R6), R6_METERED);
	});

	it("handles CRLF framing and lines split across chunks", () => {
		for (const step of [1, 7, 64]) {
			assert.deepEqual(
				anthropicMeter(R6.replace(/\n/g, "\r\n"), step),
				R6_METERED,
				String(step),
			);
		}
	});

	it("decodes a multibyte character split across chunks inside the usage line", () => {
		const delta = R6_DELTA.replace(
			'"stop_sequence":null',
			'"stop_sequence":"✓é"',
		);

		assert.deepEqual(
			anthropicMeter(R6_START + R6_BODY + delta + R6_STOP, 1),
			R6_METERED,
		);
	});

	it("counts cache creation and cache reads as input, like probe r9 and r10", () => {
		const written = R6_DELTA.replace(
			'"input_tokens":18,"cache_creation_input_tokens":0',
			'"input_tokens":16,"cache_creation_input_tokens":12460',
		);

		const read = R6_DELTA.replace(
			'"input_tokens":18,"cache_creation_input_tokens":0,"cache_read_input_tokens":0',
			'"input_tokens":16,"cache_creation_input_tokens":0,"cache_read_input_tokens":12460',
		);

		for (const delta of [written, read]) {
			assert.deepEqual(anthropicMeter(R6_START + R6_BODY + delta + R6_STOP), {
				...R6_METERED,
				inputTokens: 16 + 12460,
			});
		}
	});

	it("takes output from the last message_delta, and input from message_start when the delta omits it", () => {
		const early = R6_DELTA.replace('"output_tokens":4', '"output_tokens":1');

		const outputOnly =
			'event: message_delta\ndata: {"type":"message_delta","delta":{"stop_reason":"end_turn"},"usage":{"output_tokens":9}}\n\n';

		assert.deepEqual(
			anthropicMeter(R6_START + R6_BODY + early + R6_DELTA + R6_STOP),
			R6_METERED,
		);
		assert.deepEqual(
			anthropicMeter(R6_START + R6_BODY + outputOnly + R6_STOP),
			{ ...R6_METERED, outputTokens: 9 },
		);
	});

	it("meters a non-stream JSON message with usage the same way", () => {
		const r1 =
			'{"model":"claude-haiku-5-5","id":"msg_011CgifdWg7xhLc7kHd8mx2F","type":"message","role":"assistant","content":[{"type":"text","text":"ok"}],"container":null,"stop_reason":"end_turn","stop_sequence":null,"stop_details":null,"usage":{"input_tokens":18,"cache_creation_input_tokens":0,"cache_read_input_tokens":0,"cache_creation":{"ephemeral_5m_input_tokens":0,"ephemeral_1h_input_tokens":0},"output_tokens":4,"output_tokens_details":{"thinking_tokens":0},"service_tier":"standard","inference_geo":"us","speed":"standard"},"diagnostics":null}';

		const r9 = r1.replace(
			'"input_tokens":18,"cache_creation_input_tokens":0',
			'"input_tokens":16,"cache_creation_input_tokens":12460',
		);

		assert.deepEqual(anthropicMeter(r1, 5), R6_METERED);
		assert.deepEqual(anthropicMeter(`\n ${r9}\n`), {
			...R6_METERED,
			inputTokens: 12476,
		});

		for (const broken of [
			r1.replace(/,"usage":\{.*\},"diagnostics"/, ',"diagnostics"'),
			r1.slice(0, -20),
			r1.replace('"type":"message"', '"type":"error"'),
			'{"type":"error","error":{"type":"invalid_request_error","message":"max_tokens: 500000 > 128000"}}',
		]) {
			assert.deepEqual(anthropicMeter(broken), { kind: "unusable" });
		}
	});

	it("is unusable without a message_delta, without message_stop, or with a second message_start", () => {
		for (const [name, text] of [
			["no delta", R6_START + R6_BODY + R6_STOP],
			["no stop", R6_START + R6_BODY + R6_DELTA],
			["no start", R6_BODY + R6_DELTA + R6_STOP],
			["two starts", R6_START + R6_START + R6_BODY + R6_DELTA + R6_STOP],
			["empty", ""],
		] as const) {
			assert.deepEqual(anthropicMeter(text), { kind: "unusable" }, name);
		}
	});

	it("is unusable on missing cache counts, an error event, a broken data line or a model outside the table", () => {
		const noCache = (text: string) =>
			text.replace(/,"cache_read_input_tokens":0/g, "");

		const error =
			'event: error\ndata: {"type":"error","error":{"type":"overloaded_error","message":"Overloaded"}}\n\n';

		for (const [name, text] of [
			[
				"no cache read",
				noCache(R6_START) + R6_BODY + noCache(R6_DELTA) + R6_STOP,
			],
			["error event", R6_START + R6_BODY + error + R6_DELTA + R6_STOP],
			[
				"broken line",
				`${R6_START}data: {"type":"message_delta"\n\n${R6_BODY}${R6_DELTA}${R6_STOP}`,
			],
			[
				"prefixed model",
				R6.replace(
					'"model":"claude-haiku-5-5"',
					'"model":"anthropic/claude-haiku-5-5"',
				),
			],
			[
				"unknown model",
				R6.replace('"model":"claude-haiku-5-5"', '"model":"claude-opus-4-6"'),
			],
			["no model", R6.replace('"model":"claude-haiku-5-5",', "")],
			[
				"string count",
				R6.replace(
					'"output_tokens":4,"output_tokens_details"',
					'"output_tokens":"4","output_tokens_details"',
				),
			],
		] as const) {
			assert.deepEqual(anthropicMeter(text), { kind: "unusable" }, name);
		}
	});
});
