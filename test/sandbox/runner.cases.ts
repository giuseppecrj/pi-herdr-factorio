import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import {
	chmodSync,
	mkdirSync,
	mkdtempSync,
	readdirSync,
	statSync,
	readFileSync,
	rmSync,
	symlinkSync,
	writeFileSync,
	writeSync,
} from "node:fs";
import { request } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough } from "node:stream";
import { after, before, describe, it } from "node:test";
import {
	agentDirFrom,
	bareModel,
	captureStderr,
	hostSessionPath,
	piCommand,
	publishFile,
	runStage,
	sandboxHost,
	type StageHost,
	type StageRunInput,
	STDERR_CAP_BYTES,
} from "../../server/sandbox.ts";
import { AuditLog } from "../../server/sandbox/audit.ts";
import type {
	CloseReason,
	ControlEvent,
	SummaryEvent,
} from "../../server/sandbox/control.ts";
import { bindCredentials } from "../../server/sandbox/credentials.ts";
import {
	type EchoFixture,
	startEchoFixture,
} from "../../server/sandbox/echo-fixture.ts";
import { Gateway } from "../../server/sandbox/gateway.ts";
import {
	type GatewayHandle,
	startGatewayProcess,
} from "../../server/sandbox/gateway-client.ts";
import {
	fieldOf,
	type JsonObject,
	type JsonValue,
	objectOf,
	parseJson,
	textOf,
} from "../../server/sandbox/json.ts";
import { LineSplitter } from "../../server/sandbox/lines.ts";
import { SseMeter } from "../../server/sandbox/meter.ts";
import type { StageReceipt } from "../../server/sandbox/result.ts";
import type { RouteId, RouteTable } from "../../server/sandbox/routes.ts";
import {
	type AssistantEnd,
	type PiProcess,
	parsePiRecord,
} from "../../server/sandbox/rpc.ts";
import {
	childUsageOf,
	classifyRefusal,
	SessionTracker,
} from "../../server/sandbox/settle.ts";
import type { Digest } from "../../src/run.ts";
import { isRepoSlug, type ModelId, parseWorkflow } from "../../src/workflow.ts";

const FIXTURES = new URL("./fixtures/", import.meta.url).pathname;
const RUN = "a".repeat(64);

function fixture(name: string): JsonObject[] {
	return readFileSync(join(FIXTURES, name), "utf8")
		.split("\n")
		.filter((line) => line !== "")
		.flatMap((line) => {
			const record = objectOf(parseJson(line));

			return record === null ? [] : [record];
		});
}

function model(text: string): ModelId {
	assert.match(text, /^[a-z0-9-]+\/[A-Za-z0-9._:-]+$/);

	// SAFETY: the assertion above checks the ModelId pattern.
	return text as ModelId;
}

function digest(text: string): Digest {
	assert.match(text, /^[0-9a-f]{64}$/);

	// SAFETY: the assertion above checks the Digest pattern.
	return text as Digest;
}

class FakePi implements PiProcess {
	readonly stdin = new PassThrough();
	readonly stdout = new PassThrough();
	readonly exited: Promise<number | null>;
	readonly received: JsonObject[] = [];
	#exit: (code: number | null) => void = () => {};
	#done = false;

	constructor(
		timeline: string[],
		onCommand: (command: JsonObject, pi: FakePi) => void,
	) {
		this.exited = new Promise((done) => {
			this.#exit = done;
		});

		const splitter = new LineSplitter(1024 * 1024);

		this.stdin.on("data", (chunk: Buffer) => {
			for (const line of splitter.push(chunk) ?? []) {
				const command = objectOf(parseJson(line));

				assert.ok(command);
				this.received.push(command);
				timeline.push(`pi:${textOf(fieldOf(command, "type"))}`);
				onCommand(command, this);
			}
		});
		this.stdin.on("end", () => this.exit(0));
	}

	emit(...records: JsonValue[]): void {
		for (const record of records) {
			if (!this.#done) this.stdout.write(`${JSON.stringify(record)}\n`);
		}
	}

	raw(text: string): void {
		this.stdout.write(text);
	}

	exit(code: number | null): void {
		if (this.#done) return;

		this.#done = true;
		this.stdout.end();
		this.#exit(code);
	}

	kill(): void {
		this.exit(null);
	}
}

function started(id: string): JsonObject {
	return {
		id,
		type: "response",
		command: "prompt",
		success: true,
		data: { disposition: "started" },
	};
}

function assistant(
	fields: Partial<Record<keyof AssistantEnd, JsonValue>> & {
		tokens?: number;
	} = {},
): JsonObject {
	const { tokens, ...rest } = fields;

	return {
		type: "message_end",
		message: {
			role: "assistant",
			provider: "openai",
			model: "gpt-6.1-sol",
			stopReason: "stop",
			rawStopReason: "completed",
			usage: { input: 0, output: 0, totalTokens: tokens ?? 10 },
			...rest,
		},
	};
}

function replayer(records: readonly JsonObject[]) {
	return (command: JsonObject, pi: FakePi) => {
		const type = textOf(fieldOf(command, "type"));
		const id = textOf(fieldOf(command, "id")) ?? "";

		if (type === "prompt") {
			for (const record of records) {
				pi.emit(
					textOf(fieldOf(record, "type")) === "response"
						? { ...record, id }
						: record,
				);
			}
		}

		if (type === "abort") pi.emit({ type: "agent_settled", aborted: true });
	};
}

class FakeGateway implements GatewayHandle {
	readonly socketPath = "/nonexistent/gw.sock";
	readonly exited: Promise<number | null> = new Promise(() => {});
	readonly #listeners: ((event: ControlEvent) => void)[] = [];
	readonly #timeline: string[];

	constructor(timeline: string[]) {
		this.#timeline = timeline;
	}

	subscribe(listener: (event: ControlEvent) => void): void {
		this.#listeners.push(listener);
	}

	send(event: ControlEvent): void {
		for (const listener of this.#listeners) listener(event);
	}

	async closeGate(reason: CloseReason): Promise<boolean> {
		this.#timeline.push(`gate:${reason}`);
		this.send({ event: "gate_closed", reason });

		return true;
	}

	async setRoute(route: RouteId, open: boolean): Promise<boolean> {
		this.#timeline.push(`route:${route}:${open ? "open" : "closed"}`);

		return true;
	}

	async drainAbort(): Promise<boolean> {
		this.#timeline.push("drain");

		return true;
	}

	async shutdown(): Promise<SummaryEvent | null> {
		this.#timeline.push("shutdown");

		return {
			event: "summary",
			gate: "closed",
			modelTokens: 0,
			modelRequests: 0,
			routes: [],
		};
	}

	kill(): void {}
}

type Harness = {
	host: StageHost;
	timeline: string[];
	receipts: StageReceipt[];
	launches: string[];
	stops: number[];
	pis: FakePi[];
	tables: RouteTable[];
};

function harness(
	scripts: ((command: JsonObject, pi: FakePi) => void)[],
	options: {
		gateway?: (
			table: RouteTable,
			timeline: string[],
		) => GatewayHandle | null | Promise<GatewayHandle>;
		childUsage?: (file: string) => ReturnType<StageHost["readChildUsage"]>;
		writeReceipt?: (receipt: StageReceipt) => Promise<boolean>;
		now?: () => number;
		cleanupReserveMs?: number;
		stopSandbox?: (session: number) => Promise<void>;
	} = {},
): Harness {
	const timeline: string[] = [];
	const receipts: StageReceipt[] = [];
	const launches: string[] = [];
	const stops: number[] = [];
	const pis: FakePi[] = [];
	const tables: RouteTable[] = [];

	const host: StageHost = {
		cleanupReserveMs: options.cleanupReserveMs ?? 50,
		assetsDigest: "e".repeat(64),
		versions: { pi: "1.4.0", piHerdrAgents: "3.3.1", piHerdrPstack: "0.5.0" },
		now: options.now ?? Date.now,
		async startGateway(table) {
			tables.push(table);

			return options.gateway === undefined
				? new FakeGateway(timeline)
				: options.gateway(table, timeline);
		},
		async launchPi(requested, session) {
			const script = scripts[session];

			launches.push(requested);

			if (script === undefined) return null;

			const pi = new FakePi(timeline, script);

			pis.push(pi);

			return pi;
		},
		async stopSandbox(session) {
			stops.push(session);
			timeline.push(`stop:${session}`);
			await options.stopSandbox?.(session);
		},
		async readChildUsage(_session, file) {
			return options.childUsage === undefined ? null : options.childUsage(file);
		},
		async writeReceipt(receipt) {
			if (options.writeReceipt !== undefined) {
				return options.writeReceipt(receipt);
			}

			receipts.push(receipt);

			return true;
		},
		async stderrLog(session) {
			return launches.length > session
				? { session, file: `pi-stderr-${session}.log`, bytes: 7 }
				: null;
		},
	};

	return { host, timeline, receipts, launches, stops, pis, tables };
}

function input(
	overrides: Partial<StageRunInput> = {},
	settings: Partial<StageRunInput["settings"]> = {},
): StageRunInput {
	return {
		runId: digest(RUN),
		stage: "specify",
		attempt: 1,
		prompt: "Reply with exactly: OK",
		settings: {
			model: model("openai/gpt-6.1-sol"),
			fallback: null,
			budget: { maxTurns: 10, wallMs: 60_000, stallMs: 300_000 },
			maxTokens: null,
			...settings,
		},
		remainingRunTokens: 1_000_000,
		signal: new AbortController().signal,
		progress: () => {},
		...overrides,
	};
}

describe("Pi RPC framing and records", () => {
	it("splits on LF only, keeps U+2028 inside a record and strips a trailing CR", () => {
		const splitter = new LineSplitter(1024);

		const text =
			'{"type":"other","text":"a\u2028b\u2029c"}\r\n{"type":"turn_start"}\n{"type":';

		assert.deepEqual(splitter.push(Buffer.from(text)), [
			'{"type":"other","text":"a\u2028b\u2029c"}',
			'{"type":"turn_start"}',
		]);
		assert.deepEqual(splitter.push(Buffer.from('"agent_start"}\n')), [
			'{"type":"agent_start"}',
		]);
		assert.equal(new LineSplitter(4).push(Buffer.from("123456")), null);
	});

	it("refuses an over-long line whatever the chunk boundaries", () => {
		assert.equal(new LineSplitter(4).push(Buffer.from("123456789\n")), null);
		assert.equal(
			new LineSplitter(4).push(Buffer.from("ok\n123456789\n")),
			null,
		);

		const split = new LineSplitter(4);

		assert.deepEqual(split.push(Buffer.from("123")), []);
		assert.equal(split.push(Buffer.from("456\n")), null);
		assert.deepEqual(new LineSplitter(4).push(Buffer.from("1234\r\n")), [
			"1234",
		]);
	});

	it("parses the records the runner acts on and flags malformed ones", () => {
		assert.deepEqual(
			parsePiRecord('{"type":"agent_settled","aborted":false}'),
			{ type: "agent_settled", aborted: false },
		);
		assert.deepEqual(parsePiRecord('{"type":"agent_settled"}'), {
			type: "malformed",
		});
		assert.deepEqual(parsePiRecord("✓ 8ms"), { type: "malformed" });
		assert.deepEqual(parsePiRecord("[1]"), { type: "malformed" });
		assert.deepEqual(parsePiRecord('{"type":"message_end"}'), {
			type: "malformed",
		});
		assert.deepEqual(
			parsePiRecord('{"type":"queue_update","steering":["x"],"followUp":[]}'),
			{ type: "queue", queued: 1 },
		);
		assert.deepEqual(
			parsePiRecord(
				'{"type":"tool_execution_end","toolName":"subagent","isError":false,"result":{"details":{"id":"db66","name":"c"}}}',
			),
			{ type: "subagent_launch" },
		);
		assert.deepEqual(
			parsePiRecord(
				'{"type":"tool_execution_end","toolName":"subagent","isError":false,"result":{"details":{"error":"no session file"}}}',
			),
			{ type: "other" },
		);
		assert.deepEqual(
			parsePiRecord(
				'{"type":"tool_execution_end","toolName":"subagent","isError":false,"result":{"content":[]}}',
			),
			{ type: "other" },
		);
		assert.deepEqual(parsePiRecord('{"type":"something_new","x":1}'), {
			type: "other",
		});
		assert.deepEqual(
			parsePiRecord(
				'{"type":"response","command":"parse","success":false,"error":"x"}',
			),
			{
				type: "response",
				id: null,
				command: "parse",
				success: false,
				disposition: null,
			},
		);
	});
});

describe("settlement predicate", () => {
	it("waits past the first agent_settled until the child result and a later settle (exp5)", () => {
		const tracker = new SessionTracker("p1", 10, 0);
		const states: string[] = [];

		for (const record of fixture("exp5-parent.jsonl")) {
			const signal = tracker.apply(parsePiRecord(JSON.stringify(record)));
			const type = textOf(fieldOf(record, "type"));

			const custom = textOf(
				fieldOf(objectOf(fieldOf(record, "message")), "customType"),
			);

			if (
				type === "agent_settled" ||
				(type === "message_end" && custom === "subagent_result")
			)
				states.push(`${custom ?? type}:${signal.kind}`);
		}

		assert.deepEqual(states, [
			"agent_settled:none",
			"subagent_result:child",
			"agent_settled:settled",
		]);
		assert.equal(tracker.launches, 1);
		assert.equal(tracker.results, 1);
	});

	it("does not settle while a steer or follow-up is queued", () => {
		const tracker = new SessionTracker("p", 10, 0);

		tracker.apply({
			type: "response",
			id: "p",
			command: "prompt",
			success: true,
			disposition: "started",
		});
		tracker.apply({ type: "queue", queued: 1 });
		assert.deepEqual(tracker.apply({ type: "agent_settled", aborted: false }), {
			kind: "none",
		});
		tracker.apply({ type: "queue", queued: 0 });
		assert.equal(tracker.settled(), true);
	});

	it("reads child usage from a session file", () => {
		const usage = childUsageOf(
			readFileSync(join(FIXTURES, "exp5-child-session.jsonl"), "utf8"),
		);

		assert.equal(usage.total, 1052);
		assert.deepEqual([...usage.byModel], [["openai/gpt-6.1-sol", 1052]]);
	});
});

describe("refusal classification on proto-runtime exp 8 fields", () => {
	function last(name: string): AssistantEnd {
		const ends = fixture(name).flatMap((record) => {
			const parsed = parsePiRecord(JSON.stringify(record));

			return parsed.type === "assistant_end" ? [parsed.message] : [];
		});

		const message = ends.at(-1);

		assert.ok(message);

		return message;
	}

	it("classifies the three structured refusal shapes", () => {
		assert.equal(
			classifyRefusal(last("exp8-incomplete_content_filter.jsonl")),
			"incomplete_content_filter",
		);
		assert.equal(
			classifyRefusal(last("exp8-failed_content_filter.jsonl")),
			"failed_content_filter",
		);
		assert.equal(
			classifyRefusal(last("exp8-http400_content_policy.jsonl")),
			"content_policy",
		);
		assert.equal(
			classifyRefusal({
				stopReason: "error",
				rawStopReason: "refusal",
				errorMessage: null,
				usage: null,
				provider: null,
				model: null,
			}),
			"refusal",
		);
	});

	it("does not treat a refusal text part, a server error or the budget gate as a refusal", () => {
		const part = last("exp8-refusal_part.jsonl");

		assert.equal(part.stopReason, "stop");
		assert.equal(classifyRefusal(part), null);
		assert.equal(classifyRefusal(last("exp8-http500.jsonl")), null);
		assert.equal(
			classifyRefusal({
				stopReason: "error",
				rawStopReason: null,
				errorMessage:
					"OpenAI API error (403): factory-gateway: denied: budget-closed: out of budget",
				usage: null,
				provider: null,
				model: null,
			}),
			null,
		);
		assert.equal(
			classifyRefusal({
				stopReason: "error",
				rawStopReason: null,
				errorMessage:
					'OpenAI API error (400): {"code":"content_policy_violation"} trailing',
				usage: null,
				provider: null,
				model: null,
			}),
			null,
		);
	});
});

describe("runStage", () => {
	it("passes a simple stage and records a receipt from message_end usage", async () => {
		const h = harness([
			replayer([
				started("x"),
				{ type: "agent_start" },
				{ type: "turn_start" },
				assistant({ tokens: 415 }),
				{ type: "turn_end" },
				{ type: "agent_end" },
				{ type: "agent_settled", aborted: false },
			]),
		]);

		let beats = 0;

		const result = await runStage(
			input({ progress: () => (beats += 1) }),
			h.host,
		);

		assert.equal(result.kind, "passed");
		assert.equal(result.usage, 415);
		assert.deepEqual(result.receipt.settlement, {
			event: "agent_settled",
			aborted: false,
		});
		assert.deepEqual(result.receipt.models, {
			requested: "openai/gpt-6.1-sol",
			observed: "openai/gpt-6.1-sol",
		});
		assert.equal(result.receipt.pricing, "unavailable");
		assert.equal(result.receipt.assetsDigest, "e".repeat(64));
		assert.equal(result.receipt.turns, 1);
		assert.deepEqual(h.receipts, [result.receipt]);
		assert.equal(beats >= 7, true);
		assert.deepEqual(
			h.tables[0]?.routes.map((route) => route.id),
			["model-openai", "npm"],
		);
		assert.equal(h.tables[0]?.ceiling.modelTokens, 1_000_000);
		assert.deepEqual(h.stops, [0]);
		assert.equal(bareModel(model("xai/grok-4.6")), "grok-4.6");
	});

	it("keeps the parent alive until the child settles and adds child usage (exp5)", async () => {
		const child = childUsageOf(
			readFileSync(join(FIXTURES, "exp5-child-session.jsonl"), "utf8"),
		);

		const files: string[] = [];

		const h = harness([replayer(fixture("exp5-parent.jsonl"))], {
			childUsage: async (file) => {
				files.push(file);

				return child;
			},
		});

		const result = await runStage(input(), h.host);

		assert.equal(result.kind, "passed");
		assert.equal(result.usage, 8632);
		assert.equal(result.receipt.usage.parent, 7580);
		assert.equal(result.receipt.usage.children, 1052);
		assert.deepEqual(result.receipt.usage.byModel, {
			"openai/gpt-6.1-sol": 8632,
		});
		assert.equal(files.length, 1);
		assert.match(files[0] ?? "", /\/sessions\/.*\.jsonl$/);
	});

	it("answers every dialog extension request with a cancel and ignores fire-and-forget ones", async () => {
		const h = harness([
			(command, pi) => {
				const type = textOf(fieldOf(command, "type"));
				const id = textOf(fieldOf(command, "id")) ?? "";

				if (type === "prompt") {
					pi.emit(
						started(id),
						{ type: "agent_start" },
						{
							type: "extension_ui_request",
							id: "w1",
							method: "setWidget",
							widgetKey: "x",
						},
						{
							type: "extension_ui_request",
							id: "d1",
							method: "confirm",
							title: "Allow?",
						},
					);
				}

				if (type === "extension_ui_response")
					pi.emit({ type: "turn_start" }, assistant(), {
						type: "agent_settled",
						aborted: false,
					});
			},
		]);

		const result = await runStage(input(), h.host);

		assert.equal(result.kind, "passed");
		assert.deepEqual(
			h.pis[0]?.received.filter(
				(command) => fieldOf(command, "type") === "extension_ui_response",
			),
			[{ type: "extension_ui_response", id: "d1", cancelled: true }],
		);
	});

	it("fails malformed output, closing the gate before Pi is aborted", async () => {
		const h = harness([
			(command, pi) => {
				const type = textOf(fieldOf(command, "type"));

				if (type === "prompt") {
					pi.emit(
						started(textOf(fieldOf(command, "id")) ?? ""),
						{ type: "agent_start" },
						{ type: "turn_start" },
						assistant({ stopReason: "toolUse", tokens: 70 }),
					);
					pi.raw("not json at all\n");
				}

				if (type === "abort") pi.emit({ type: "agent_settled", aborted: true });
			},
		]);

		const result = await runStage(input(), h.host);

		assert.equal(result.kind, "failed");
		assert.equal(result.kind === "failed" && result.exit, "malformed");
		assert.equal(result.usage, 70);
		assert.deepEqual(h.timeline.slice(1, 4), [
			"gate:abort",
			"pi:abort",
			"drain",
		]);
		assert.deepEqual(result.receipt.settlement, {
			event: "agent_settled",
			aborted: true,
		});
	});

	it("fails a Pi process that exits before settling as crashed", async () => {
		const h = harness([
			(command, pi) => {
				if (textOf(fieldOf(command, "type")) === "prompt") {
					pi.emit(started(textOf(fieldOf(command, "id")) ?? ""), {
						type: "agent_start",
					});
					setTimeout(() => pi.exit(3), 5);
				}
			},
		]);

		const result = await runStage(input(), h.host);

		assert.equal(result.kind === "failed" && result.exit, "crashed");
		assert.deepEqual(result.receipt.settlement, {
			event: "none",
			aborted: null,
		});
	});

	it("fails a rejected or handled prompt as an error", async () => {
		const responses: JsonObject[] = [
			{ type: "response", command: "prompt", success: false, error: "busy" },
			{
				type: "response",
				command: "prompt",
				success: true,
				data: { disposition: "handled" },
			},
		];

		for (const response of responses) {
			const h = harness([replayer([response])]);
			const result = await runStage(input(), h.host);

			assert.equal(result.kind === "failed" && result.exit, "error");
		}
	});

	it("aborts on the orchestrator's signal and keeps the usage counted so far", async () => {
		const abort = new AbortController();

		const h = harness([
			(command, pi) => {
				const type = textOf(fieldOf(command, "type"));

				if (type === "prompt") {
					pi.emit(
						started(textOf(fieldOf(command, "id")) ?? ""),
						{ type: "agent_start" },
						{ type: "turn_start" },
						assistant({ stopReason: "toolUse", tokens: 900 }),
					);
					setTimeout(() => abort.abort(), 10);
				}

				if (type === "abort") pi.emit({ type: "agent_settled", aborted: true });
			},
		]);

		const result = await runStage(input({ signal: abort.signal }), h.host);

		assert.equal(result.kind === "failed" && result.exit, "aborted");
		assert.equal(result.usage, 900);
		assert.deepEqual(h.timeline.slice(1, 3), ["gate:abort", "pi:abort"]);
	});

	it("stops at the hard deadline, wall_ms minus the cleanup reserve", async () => {
		const h = harness([
			(command, pi) => {
				if (textOf(fieldOf(command, "type")) === "prompt")
					pi.emit(started(textOf(fieldOf(command, "id")) ?? ""), {
						type: "agent_start",
					});
			},
		]);

		const begin = Date.now();

		const result = await runStage(
			input({}, { budget: { maxTurns: 10, wallMs: 150, stallMs: 300_000 } }),
			h.host,
		);

		assert.equal(result.kind === "budget_exhausted" && result.cap, "wall");
		assert.equal(Date.now() - begin < 50 + 5_000 + 2_000 + 500, true);
		assert.deepEqual(h.timeline.slice(1, 3), ["gate:wall", "pi:abort"]);
	});

	it("fails the stage when the gateway sees a secret in a request", async () => {
		let gateway: FakeGateway | null = null;

		const h = harness(
			[
				(command, pi) => {
					if (textOf(fieldOf(command, "type")) === "prompt") {
						pi.emit(started(textOf(fieldOf(command, "id")) ?? ""), {
							type: "agent_start",
						});
						gateway?.send({
							event: "usage",
							route: null,
							decision: "deny",
							reason: "secret-in-request",
							status: 403,
							bytesIn: 0,
							bytesOut: 0,
							inputTokens: null,
							outputTokens: null,
						});
					}

					if (textOf(fieldOf(command, "type")) === "abort")
						pi.emit({ type: "agent_settled", aborted: true });
				},
			],
			{
				gateway: (_table, timeline) => {
					gateway = new FakeGateway(timeline);

					return gateway;
				},
			},
		);

		const result = await runStage(input(), h.host);

		assert.equal(result.kind === "failed" && result.exit, "error");
	});

	it("fails as crashed when the gateway cannot start", async () => {
		const h = harness([], { gateway: () => null });
		const result = await runStage(input(), h.host);

		assert.equal(result.kind === "failed" && result.exit, "crashed");
		assert.deepEqual(h.launches, []);
		assert.equal(h.receipts.length, 1);
		assert.deepEqual(result.receipt.stderr, []);
	});
});

function settledChild(tokens: number) {
	return replayer([
		started("x"),
		{ type: "agent_start" },
		{ type: "turn_start" },
		{
			type: "tool_execution_end",
			toolName: "subagent",
			isError: false,
			result: { details: { id: "child-1" } },
		},
		assistant({ tokens }),
		{
			type: "message_end",
			message: {
				role: "custom",
				customType: "subagent_result",
				details: {
					status: "completed",
					sessionFile: "/run/pi-agent/sessions/--w--/child.jsonl",
				},
			},
		},
		{ type: "agent_settled", aborted: false },
	]);
}

describe("runStage budget before model work", () => {
	it("refuses with no model work when the run allowance is already spent", async () => {
		for (const remainingRunTokens of [0, -5]) {
			const h = harness([replayer([started("x")])]);
			const result = await runStage(input({ remainingRunTokens }), h.host);

			assert.equal(
				result.kind === "budget_exhausted" && result.cap,
				"run_tokens",
			);
			assert.equal(result.usage, 0);
			assert.deepEqual(h.tables, []);
			assert.deepEqual(h.launches, []);
			assert.deepEqual(h.receipts, [result.receipt]);
		}
	});

	it("refuses with no model work when the stage token cap is already zero", async () => {
		const h = harness([replayer([started("x")])]);
		const result = await runStage(input({}, { maxTokens: 0 }), h.host);

		assert.equal(result.kind === "budget_exhausted" && result.cap, "tokens");
		assert.deepEqual(h.launches, []);
	});
});

describe("runStage accounting after the outcome is chosen", () => {
	it("keeps counting usage Pi reports while an abort drains, without changing the outcome", async () => {
		const abort = new AbortController();

		const h = harness([
			(command, pi) => {
				const type = textOf(fieldOf(command, "type"));

				if (type === "prompt") {
					pi.emit(
						started(textOf(fieldOf(command, "id")) ?? ""),
						{ type: "agent_start" },
						{ type: "turn_start" },
						assistant({ stopReason: "toolUse", tokens: 70 }),
					);
					setTimeout(() => abort.abort(), 10);
				}

				if (type === "abort") {
					pi.emit(assistant({ stopReason: "aborted", tokens: 40 }), {
						type: "agent_settled",
						aborted: true,
					});
				}
			},
		]);

		const result = await runStage(input({ signal: abort.signal }), h.host);

		assert.equal(result.kind === "failed" && result.exit, "aborted");
		assert.equal(result.usage, 110);
		assert.equal(result.receipt.usage.parent, 110);
	});

	it("waits for child usage before the outcome and checks the cap on a normal stop", async () => {
		const h = harness([settledChild(10)], {
			childUsage: () =>
				new Promise((done) =>
					setTimeout(
						() =>
							done({
								total: 120,
								byModel: new Map([["openai/gpt-6.1-sol", 120]]),
							}),
						20,
					),
				),
		});

		const result = await runStage(input({ remainingRunTokens: 100 }), h.host);

		assert.equal(
			result.kind === "budget_exhausted" && result.cap,
			"run_tokens",
		);
		assert.equal(result.usage, 130);
		assert.equal(result.receipt.usage.children, 120);
	});

	it("turns a child-session read error into unread-child evidence and a typed failure, and still cleans up", async () => {
		const h = harness([settledChild(10)], {
			childUsage: async () => {
				throw new Error("EIO: fixture read error");
			},
		});

		const result = await runStage(input(), h.host);

		assert.equal(result.kind === "failed" && result.exit, "crashed");
		assert.equal(result.receipt.usage.unreadChildren, 1);
		assert.equal(h.timeline.includes("shutdown"), true);
		assert.deepEqual(h.receipts, [result.receipt]);
	});
});

describe("runStage settlement on a queue update", () => {
	it("finishes when clearing the queue is what satisfies settlement", async () => {
		const h = harness([
			replayer([
				started("x"),
				{ type: "agent_start" },
				{ type: "turn_start" },
				assistant({ tokens: 12 }),
				{ type: "queue_update", steering: ["later"], followUp: [] },
				{ type: "agent_settled", aborted: false },
				{ type: "queue_update", steering: [], followUp: [] },
			]),
		]);

		const result = await runStage(input(), h.host);

		assert.equal(result.kind, "passed");
		assert.equal(result.usage, 12);
	});
});

describe("runStage receipt persistence", () => {
	it("fails the stage as crashed when the receipt cannot be written", async () => {
		const h = harness(
			[
				replayer([
					started("x"),
					{ type: "agent_start" },
					{ type: "turn_start" },
					assistant({ tokens: 5 }),
					{ type: "agent_settled", aborted: false },
				]),
			],
			{ writeReceipt: async () => false },
		);

		const result = await runStage(input(), h.host);

		assert.equal(result.kind === "failed" && result.exit, "crashed");
		assert.equal(result.usage, 5);
		assert.deepEqual(result.receipt.outcome, {
			kind: "failed",
			exit: "crashed",
		});
	});

	function realHost(stateDir: string) {
		return sandboxHost({
			stateDir,
			bundleDir: join(stateDir, "bundle"),
			workspace: join(stateDir, "ws"),
			runId: digest(RUN),
			stage: "specify",
			attempt: 1,
			tools: [],
			arch: "x86_64",
			xdgRuntimeDir: "/run/user/1000",
			assetsDigest: "e".repeat(64),
			versions: { pi: "1.4.0", piHerdrAgents: "3.3.1", piHerdrPstack: "0.5.0" },
			exec: async () => ({ stdout: "", stderr: "", code: 0 }),
		});
	}

	it("publishes the real receipt whole, mode 0600, with no temp file left", async () => {
		const dir = mkdtempSync(join(tmpdir(), "factory-receipt-"));

		try {
			const h = harness([
				replayer([
					started("x"),
					{ type: "agent_start" },
					{ type: "turn_start" },
					assistant({ tokens: 5 }),
					{ type: "agent_settled", aborted: false },
				]),
			]);

			const result = await runStage(input(), h.host);
			const host = realHost(dir);

			assert.equal(await host.writeReceipt(result.receipt), true);

			const stage = join(dir, "stages", RUN, "specify-1");
			const path = join(stage, "receipt.json");

			assert.deepEqual(JSON.parse(readFileSync(path, "utf8")), result.receipt);
			assert.equal(statSync(path).mode & 0o777, 0o600);
			assert.deepEqual(readdirSync(stage), ["receipt.json"]);
			assert.equal(await host.writeReceipt(result.receipt), false);
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});

	it("never leaves a partial receipt in place when a write fails part way", () => {
		const dir = mkdtempSync(join(tmpdir(), "factory-receipt-"));
		const path = join(dir, "receipt.json");

		try {
			const text = `${JSON.stringify({ a: "x".repeat(4096) })}\n`;

			assert.equal(
				publishFile(path, text, (fd, data) => {
					writeSync(fd, data.slice(0, 100));
					throw new Error("ENOSPC: fixture");
				}),
				false,
			);
			assert.deepEqual(readdirSync(dir), []);

			writeFileSync(path, '{"version":1,"outc');
			assert.equal(publishFile(path, text), false);
			assert.equal(readFileSync(path, "utf8"), '{"version":1,"outc');
			assert.deepEqual(readdirSync(dir), ["receipt.json"]);

			rmSync(path);
			assert.equal(publishFile(path, text), true);
			assert.equal(readFileSync(path, "utf8"), text);
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});
});

describe("runStage deadline and cleanup budget", () => {
	function clocked(at: { t: number }, startAt: number, settle = true) {
		return harness(
			[
				(command, pi) => {
					if (textOf(fieldOf(command, "type")) === "prompt") {
						pi.emit(
							started(textOf(fieldOf(command, "id")) ?? ""),
							{ type: "agent_start" },
							{ type: "turn_start" },
							assistant({ tokens: 3 }),
						);

						if (settle) pi.emit({ type: "agent_settled", aborted: false });
					}

					if (textOf(fieldOf(command, "type")) === "abort")
						pi.emit({ type: "agent_settled", aborted: true });
				},
			],
			{
				now: () => at.t,
				cleanupReserveMs: 100,
				gateway: (_table, timeline) => {
					at.t = startAt;

					return new FakeGateway(timeline);
				},
			},
		);
	}

	const budget = { maxTurns: 10, wallMs: 1000, stallMs: 300_000 };

	it("sends the prompt one millisecond before wall_ms minus the reserve", async () => {
		const h = clocked({ t: 0 }, 899);
		const result = await runStage(input({}, { budget }), h.host);

		assert.equal(result.kind, "passed");
		assert.deepEqual(
			h.pis[0]?.received.map((command) => fieldOf(command, "type")),
			["prompt"],
		);
	});

	it("never prompts once startup has used wall_ms minus the reserve", async () => {
		for (const startAt of [900, 5000]) {
			const h = clocked({ t: 0 }, startAt);
			const result = await runStage(input({}, { budget }), h.host);

			assert.equal(result.kind === "budget_exhausted" && result.cap, "wall");
			assert.equal(result.usage, 0);
			assert.equal(
				h.pis.some((pi) =>
					pi.received.some((command) => fieldOf(command, "type") === "prompt"),
				),
				false,
				String(startAt),
			);
			assert.equal(h.timeline.includes("shutdown"), true);
		}
	});

	it("bounds every cleanup wait by the reserve", {
		timeout: 10_000,
	}, async () => {
		const stuck = new Promise<void>(() => {});

		class StuckGateway extends FakeGateway {
			override async closeGate(reason: CloseReason): Promise<boolean> {
				await super.closeGate(reason);
				await stuck;

				return true;
			}

			override async drainAbort(): Promise<boolean> {
				await stuck;

				return true;
			}

			override async shutdown(): Promise<SummaryEvent | null> {
				await stuck;

				return null;
			}
		}

		const h = harness(
			[
				(command, pi) => {
					if (textOf(fieldOf(command, "type")) === "prompt")
						pi.emit(started(textOf(fieldOf(command, "id")) ?? ""), {
							type: "agent_start",
						});
				},
			],
			{
				cleanupReserveMs: 200,
				gateway: (_table, timeline) => new StuckGateway(timeline),
				stopSandbox: () => stuck,
			},
		);

		const begin = Date.now();

		const result = await runStage(
			input({}, { budget: { maxTurns: 10, wallMs: 300, stallMs: 300_000 } }),
			h.host,
		);

		const elapsed = Date.now() - begin;

		assert.equal(result.kind === "budget_exhausted" && result.cap, "wall");
		assert.equal(elapsed >= 100, true, String(elapsed));
		assert.equal(elapsed < 300 + 250, true, String(elapsed));
		assert.equal(h.receipts.length, 1);
	});

	it("carries one cleanup end from an early abort through session cleanup, gateway shutdown and the receipt", {
		timeout: 10_000,
	}, async () => {
		const reserve = 100;
		const abort = new AbortController();

		class SlowGateway extends FakeGateway {
			override async shutdown(): Promise<SummaryEvent | null> {
				await new Promise((done) => setTimeout(done, 90));
				this.send({
					event: "usage",
					route: null,
					decision: "forward",
					reason: null,
					status: 200,
					bytesIn: 0,
					bytesOut: 0,
					inputTokens: 100,
					outputTokens: 0,
				});

				return super.shutdown();
			}
		}

		const h = harness(
			[
				(command, pi) => {
					const type = textOf(fieldOf(command, "type"));

					if (type === "prompt") {
						pi.emit(started(textOf(fieldOf(command, "id")) ?? ""), {
							type: "agent_start",
						});
						setImmediate(() => abort.abort());
					}

					if (type === "abort") {
						pi.emit({ type: "agent_settled", aborted: true });
						pi.exit(0);
					}
				},
			],
			{
				cleanupReserveMs: reserve,
				gateway: (_table, timeline) => new SlowGateway(timeline),
				stopSandbox: () => new Promise(() => {}),
			},
		);

		const stderrLog = h.host.stderrLog;
		let abortedAt = 0;

		abort.signal.addEventListener("abort", () => {
			abortedAt = Date.now();
		});

		const result = await runStage(input({ signal: abort.signal }), {
			...h.host,
			async stderrLog(session) {
				await new Promise((done) => setTimeout(done, 90));

				return stderrLog(session);
			},
		});

		const elapsed = Date.now() - abortedAt;

		assert.equal(result.kind === "failed" && result.exit, "aborted");
		assert.ok(abortedAt > 0);
		assert.equal(elapsed < reserve + 40, true, String(elapsed));
		assert.equal(h.receipts.length, 1);
	});
});

describe("sandbox stderr", () => {
	it("keeps the last 64 KiB in a private host-side file and returns the total byte count", async () => {
		const dir = mkdtempSync(join(tmpdir(), "factory-stderr-"));
		const file = join(dir, "pi-stderr-0.log");

		try {
			const stream = new PassThrough();
			const finish = captureStderr(stream, file);

			stream.write("HEAD-MARKER\n");
			stream.write(Buffer.alloc(100 * 1024, 0x78));
			stream.end("TAIL-MARKER\n");

			assert.equal(await finish(1_000), 12 + 100 * 1024 + 12);

			const kept = readFileSync(file);

			assert.equal(STDERR_CAP_BYTES, 64 * 1024);
			assert.equal(kept.length, STDERR_CAP_BYTES);
			assert.equal(
				kept.toString().endsWith("x".repeat(100) + "TAIL-MARKER\n"),
				true,
			);
			assert.equal(kept.includes("HEAD-MARKER"), false);
			assert.equal(statSync(file).mode & 0o777, 0o600);
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});

	it("writes what arrived by the wait limit when the stream stays open", async () => {
		const dir = mkdtempSync(join(tmpdir(), "factory-stderr-"));
		const file = join(dir, "pi-stderr-1.log");

		try {
			const stream = new PassThrough();
			const finish = captureStderr(stream, file);

			stream.write("bwrap: setting up uid map: Permission denied\n");

			assert.equal(await finish(20), 45);
			assert.equal(
				readFileSync(file, "utf8"),
				"bwrap: setting up uid map: Permission denied\n",
			);
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});

	it("points the receipt at each session's stderr file by name and byte count only", async () => {
		const refusal = fixture("exp8-incomplete_content_filter.jsonl");

		const pass = [
			started("x"),
			{ type: "agent_start" },
			{ type: "turn_start" },
			assistant({ provider: "xai", model: "grok-4.6", tokens: 30 }),
			{ type: "agent_settled", aborted: false },
		];

		const h = harness([replayer(refusal), replayer(pass)]);

		const result = await runStage(
			input({}, { fallback: model("xai/grok-4.6") }),
			h.host,
		);

		assert.deepEqual(result.receipt.stderr, [
			{ session: 0, file: "pi-stderr-0.log", bytes: 7 },
			{ session: 1, file: "pi-stderr-1.log", bytes: 7 },
		]);
		assert.doesNotMatch(JSON.stringify(result.receipt), /stderr text/);
	});
});

describe("runStage refusal fallback", () => {
	const refusal = fixture("exp8-incomplete_content_filter.jsonl");

	const pass = [
		started("x"),
		{ type: "agent_start" },
		{ type: "turn_start" },
		assistant({ provider: "xai", model: "grok-4.6", tokens: 30 }),
		{ type: "agent_settled", aborted: false },
	];

	it("opens the xai route, closes the primary and runs one fresh session on the fallback", async () => {
		const h = harness([replayer(refusal), replayer(pass)]);

		const result = await runStage(
			input({}, { fallback: model("xai/grok-4.6") }),
			h.host,
		);

		assert.equal(result.kind, "passed");
		assert.deepEqual(h.launches, ["openai/gpt-6.1-sol", "xai/grok-4.6"]);
		assert.deepEqual(
			h.timeline.filter((entry) => entry.startsWith("route:")),
			["route:model-openai:closed", "route:model-xai:open"],
		);
		assert.equal(result.receipt.refusal, "incomplete_content_filter");
		assert.deepEqual(result.receipt.models, {
			requested: "openai/gpt-6.1-sol",
			observed: "openai/gpt-6.1-sol",
		});
		assert.deepEqual(result.receipt.fallback, {
			requested: "xai/grok-4.6",
			observed: "xai/grok-4.6",
			outcome: { kind: "passed" },
			settlement: { event: "agent_settled", aborted: false },
			refusal: null,
		});
		assert.equal(result.receipt.usage.byModel["xai/grok-4.6"], 30);
		assert.deepEqual(
			h.tables[0]?.routes.map((route) => [route.id, route.initially]),
			[
				["model-openai", "open"],
				["model-xai", "closed"],
				["npm", "open"],
			],
		);
	});

	it("ends refused when the fallback also refuses or none is set", async () => {
		const twice = harness([
			replayer(refusal),
			replayer(fixture("exp8-failed_content_filter.jsonl")),
		]);

		const both = await runStage(
			input({}, { fallback: model("xai/grok-4.6") }),
			twice.host,
		);

		assert.equal(both.kind, "refused");
		assert.equal(both.receipt.fallback?.refusal, "failed_content_filter");

		const single = harness([replayer(refusal)]);
		const alone = await runStage(input(), single.host);

		assert.equal(alone.kind, "refused");
		assert.equal(alone.receipt.fallback, null);
		assert.deepEqual(single.launches, ["openai/gpt-6.1-sol"]);
	});

	it("runs the fallback_model the workflow configures for the stage", async () => {
		const repo = "giuseppecrj/pi-herdr-factorio";

		assert.ok(isRepoSlug(repo));

		const parsed = parseWorkflow({
			text: `---\nrepository: ${repo}\nstages:\n  specify:\n    fallback_model: xai/grok-4.7-test\n---\n`,
			repo,
			env: (name) => (name === "HOME" ? "/home/factory" : undefined),
		});

		assert.equal(parsed.kind, "valid");

		if (parsed.kind !== "valid") return;

		const { specify } = parsed.config.stages;
		const h = harness([replayer(refusal), replayer(pass)]);

		const result = await runStage(
			input(
				{},
				{
					model: specify.model,
					fallback: specify.fallbackModel,
					budget: specify.budget,
				},
			),
			h.host,
		);

		assert.deepEqual(h.launches, ["openai/gpt-6.1-sol", "xai/grok-4.7-test"]);
		assert.equal(result.receipt.fallback?.requested, "xai/grok-4.7-test");

		const xai = h.tables[0]?.routes.find((route) => route.id === "model-xai");

		assert.deepEqual(
			xai?.body.kind === "json" ? xai.body.constraints[0] : null,
			{ kind: "one_of", pointer: "/model", values: ["grok-4.7-test"] },
		);
	});

	it("does not fall back on a refusal text part, which passes and fails later output checks", async () => {
		const h = harness([replayer(fixture("exp8-refusal_part.jsonl"))]);

		const result = await runStage(
			input({}, { fallback: model("xai/grok-4.6") }),
			h.host,
		);

		assert.equal(result.kind, "passed");
		assert.equal(h.launches.length, 1);
	});
});

function inProcessGateway(fixturePort: number, events: ControlEvent[]) {
	return async (
		table: RouteTable,
		timeline: string[],
	): Promise<GatewayHandle> => {
		const listeners: ((event: ControlEvent) => void)[] = [];

		const routed: RouteTable = {
			...table,
			routes: table.routes.map((route) =>
				route.meter === null
					? route
					: {
							...route,
							upstream: {
								scheme: "http",
								host: "llm.test",
								port: fixturePort,
								basePath: route.prefix,
								hostHeader: "llm.test",
								sni: "llm.test",
								address: { kind: "pinned", ip: "127.0.0.1" },
							},
						},
			),
		};

		const credentials = bindCredentials(routed, new Map(), new Map());

		const gateway = new Gateway({
			table: routed,
			credentials,
			audit: new AuditLog(() => {}, 1_000_000),
			emit: (event) => {
				events.push(event);

				for (const listener of listeners) listener(event);
			},
		});

		const socketPath = join(
			mkdtempSync(join(tmpdir(), "factory-run-gw-")),
			"gw.sock",
		);

		await gateway.listen(socketPath);

		return {
			socketPath,
			exited: new Promise(() => {}),
			subscribe: (listener) => listeners.push(listener),
			async closeGate(reason) {
				timeline.push(`gate:${reason}`);
				gateway.closeGate(reason);

				return true;
			},
			async setRoute(route, open) {
				return gateway.setRoute(route, open);
			},
			async drainAbort() {
				gateway.drainAbort();

				return true;
			},
			async shutdown() {
				const summary = gateway.summary();

				await gateway.close();

				return summary;
			},
			kill: () => {},
		};
	};
}

function post(
	socketPath: string,
): Promise<{ status: number; usage: number | null }> {
	return new Promise((done) => {
		const meter = new SseMeter();

		const req = request(
			{
				socketPath,
				method: "POST",
				path: "/openai/v1/responses",
				headers: {
					Host: "127.0.0.1:18080",
					"Content-Type": "application/json",
				},
				setHost: false,
			},
			(res) => {
				res.on("data", (chunk: Buffer) => meter.push(chunk));
				res.on("end", () => {
					const usage = meter.usage();

					done({
						status: res.statusCode ?? 0,
						usage:
							usage === null ? null : usage.inputTokens + usage.outputTokens,
					});
				});
			},
		);

		req.on("error", () => done({ status: 0, usage: null }));
		req.end(JSON.stringify({ model: "gpt-6.1-sol", stream: true }));
	});
}

function agentThroughGateway(socketPath: () => string) {
	return (command: JsonObject, pi: FakePi) => {
		const type = textOf(fieldOf(command, "type"));

		if (type === "abort") {
			pi.emit({ type: "agent_settled", aborted: true });

			return;
		}

		if (type !== "prompt") return;

		pi.emit(started(textOf(fieldOf(command, "id")) ?? ""), {
			type: "agent_start",
		});

		const turn = async (): Promise<void> => {
			pi.emit({ type: "turn_start" });

			const reply = await post(socketPath());

			if (reply.status !== 200) {
				pi.emit(
					assistant({
						stopReason: "error",
						rawStopReason: null,
						errorMessage:
							"OpenAI API error (403): factory-gateway: denied: budget-closed: out of budget",
						tokens: 0,
					}),
					{ type: "turn_end" },
					{ type: "agent_end" },
					{ type: "agent_settled", aborted: false },
				);

				return;
			}

			pi.emit(assistant({ stopReason: "toolUse", tokens: reply.usage ?? 0 }), {
				type: "turn_end",
			});
			await new Promise((done) => setTimeout(done, 30));
			await turn();
		};

		void turn();
	};
}

describe("budget stops before the next request, through the gate", () => {
	let upstream: EchoFixture;

	before(async () => {
		upstream = await startEchoFixture(0);
	});

	after(async () => {
		await upstream.close();
	});

	async function capped(
		overrides: Partial<StageRunInput>,
		settings: Partial<StageRunInput["settings"]>,
	) {
		const events: ControlEvent[] = [];
		const factory = inProcessGateway(upstream.port, events);
		let handle: GatewayHandle | null = null;

		const h = harness([agentThroughGateway(() => handle?.socketPath ?? "")], {
			gateway: async (table, timeline) => {
				handle = await factory(table, timeline);

				return handle;
			},
		});

		const before = upstream.arrivals("/openai/v1/responses");
		const result = await runStage(input(overrides, settings), h.host);

		return {
			result,
			forwarded: upstream.arrivals("/openai/v1/responses") - before,
			events,
			h,
		};
	}

	it("closes the gate after the last allowed turn, so turn three never reaches the model", async () => {
		const { result, forwarded, events } = await capped(
			{},
			{ budget: { maxTurns: 2, wallMs: 60_000, stallMs: 300_000 } },
		);

		assert.equal(result.kind === "budget_exhausted" && result.cap, "turns");
		assert.equal(forwarded, 2);
		assert.equal(result.receipt.turns, 3);
		assert.equal(result.usage, 32);
		assert.deepEqual(
			events.find((event) => event.event === "gate_closed"),
			{ event: "gate_closed", reason: "requests" },
		);
		assert.equal(
			result.receipt.egress?.find((route) => route.route === "model-openai")
				?.forwarded,
			2,
		);
	});

	it("stops at the stage token cap via the gateway ceiling", async () => {
		const { result, forwarded, h } = await capped({}, { maxTokens: 20 });

		assert.equal(result.kind === "budget_exhausted" && result.cap, "tokens");
		assert.equal(forwarded, 2);
		assert.equal(h.tables[0]?.ceiling.modelTokens, 20);
		assert.equal(result.receipt.usage.gateway, 32);
	});

	it("stops at the run's remaining tokens", async () => {
		const { result, forwarded } = await capped({ remainingRunTokens: 20 }, {});

		assert.equal(
			result.kind === "budget_exhausted" && result.cap,
			"run_tokens",
		);
		assert.equal(forwarded, 2);
	});
});

/**
 * A Pi whose stdout lags its requests: it fires the next model request the
 * moment the last one ends, before the runner has read that turn's records.
 */
function eagerAgent(socketPath: () => string, statuses: number[]) {
	return (command: JsonObject, pi: FakePi) => {
		const type = textOf(fieldOf(command, "type"));

		if (type === "abort") {
			pi.emit({ type: "agent_settled", aborted: true });

			return;
		}

		if (type !== "prompt") return;

		pi.emit(started(textOf(fieldOf(command, "id")) ?? ""), {
			type: "agent_start",
		});
		pi.emit({ type: "turn_start" });

		void (async () => {
			const first = await post(socketPath());
			const second = await post(socketPath());

			statuses.push(first.status, second.status);
			pi.emit(
				assistant({ stopReason: "toolUse", tokens: first.usage ?? 0 }),
				{ type: "turn_end" },
				{ type: "turn_start" },
				second.status === 200
					? assistant({ tokens: second.usage ?? 0 })
					: assistant({
							stopReason: "error",
							rawStopReason: null,
							errorMessage:
								"OpenAI API error (403): factory-gateway: denied: budget-closed: out of budget",
							tokens: 0,
						}),
				{ type: "turn_end" },
				{ type: "agent_end" },
				{ type: "agent_settled", aborted: false },
			);
		})();
	};
}

describe("the turn cap holds in a real gateway process", () => {
	let upstream: EchoFixture;

	before(async () => {
		upstream = await startEchoFixture(0);
	});

	after(async () => {
		await upstream.close();
	});

	it("denies the request after the last allowed turn even before the runner reads that turn", async () => {
		const dir = mkdtempSync(join(tmpdir(), "factory-turncap-"));
		const statuses: number[] = [];
		const events: ControlEvent[] = [];
		let handle: GatewayHandle | null = null;

		try {
			const h = harness(
				[eagerAgent(() => handle?.socketPath ?? "", statuses)],
				{
					gateway: async (table) => {
						const started = await startGatewayProcess({
							gatewayDir: join(dir, "gw"),
							auditPath: join(dir, "egress.jsonl"),
							table: {
								...table,
								routes: table.routes.map((route) =>
									route.meter === null
										? route
										: {
												...route,
												upstream: {
													scheme: "http",
													host: "llm.test",
													port: upstream.port,
													basePath: route.prefix,
													hostHeader: "llm.test",
													sni: "llm.test",
													address: { kind: "pinned", ip: "127.0.0.1" },
												},
											},
								),
							},
							readyTimeoutMs: 10_000,
							testMode: true,
						});

						assert.ok(started.ok, started.ok ? "" : started.reason);
						handle = started.handle;
						handle.subscribe((event) => events.push(event));

						return handle;
					},
				},
			);

			const before = upstream.arrivals("/openai/v1/responses");

			const result = await runStage(
				input(
					{},
					{ budget: { maxTurns: 1, wallMs: 60_000, stallMs: 300_000 } },
				),
				h.host,
			);

			assert.deepEqual(statuses, [200, 403]);
			assert.equal(upstream.arrivals("/openai/v1/responses") - before, 1);
			assert.equal(h.tables[0]?.ceiling.modelRequests, 1);
			assert.equal(result.kind === "budget_exhausted" && result.cap, "turns");
			assert.deepEqual(
				events.find((event) => event.event === "gate_closed"),
				{ event: "gate_closed", reason: "requests" },
			);

			const denied = readFileSync(join(dir, "egress.jsonl"), "utf8")
				.trim()
				.split("\n")
				.map((line) => JSON.parse(line))
				.filter((line) => line.route === "model-openai");

			assert.deepEqual(
				denied.map((line) => [line.decision, line.reason]),
				[
					["forward", null],
					["deny", "budget-closed"],
				],
			);
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});
});

describe("runStage with a fake Pi process", () => {
	const script = new URL("./fake-pi.ts", import.meta.url).pathname;

	function processHost(args: readonly string[]): StageHost {
		const h = harness([]);

		return {
			...h.host,
			async launchPi() {
				const child = spawn(process.execPath, [script, ...args], {
					stdio: ["pipe", "pipe", "ignore"],
				});

				return {
					stdin: child.stdin,
					stdout: child.stdout,
					exited: new Promise((done) => child.on("exit", (code) => done(code))),
					kill: () => child.kill("SIGKILL"),
				};
			},
		};
	}

	it("settles a real child process replaying exp5", async () => {
		const result = await runStage(
			input(),
			processHost(["replay", join(FIXTURES, "exp5-parent.jsonl")]),
		);

		assert.equal(result.kind, "passed");
		assert.equal(result.receipt.usage.parent, 7580);
		assert.equal(result.receipt.usage.unreadChildren, 1);
	});

	it("fails a process that prints non-protocol output as malformed", async () => {
		const result = await runStage(input(), processHost(["garbage"]));

		assert.equal(result.kind === "failed" && result.exit, "malformed");
	});

	it("fails a process that dies mid-run as crashed", async () => {
		const result = await runStage(input(), processHost(["crash"]));

		assert.equal(result.kind === "failed" && result.exit, "crashed");
	});

	it("ends crashed, with cleanup and a receipt, when Pi closes its command pipe", async () => {
		const stops: number[] = [];
		const receipts: StageReceipt[] = [];
		const host = processHost([]);

		const result = await runStage(input(), {
			...host,
			async launchPi() {
				const child = spawn(process.execPath, [script, "close-stdin"], {
					stdio: ["pipe", "pipe", "ignore", "ipc"],
				});

				await new Promise((done) => child.once("message", done));

				const { stdin, stdout } = child;

				assert.ok(stdin && stdout);

				return {
					stdin,
					stdout,
					exited: new Promise((done) => child.on("exit", (code) => done(code))),
					kill: () => child.kill("SIGKILL"),
				};
			},
			async stopSandbox(session) {
				stops.push(session);
			},
			async writeReceipt(receipt) {
				receipts.push(receipt);

				return true;
			},
		});

		assert.equal(result.kind === "failed" && result.exit, "crashed");
		assert.deepEqual(stops, [0]);
		assert.equal(receipts.length, 1);
		assert.deepEqual(receipts[0]?.outcome, { kind: "failed", exit: "crashed" });
	});
});

describe("stage Pi command", () => {
	it("keeps a session under the writable agent dir and loads pi-herdr-agents by -e, so subagents can launch", () => {
		assert.deepEqual(piCommand(model("openai/gpt-6.1-sol")), [
			"/opt/factory/bin/pi",
			"--mode",
			"rpc",
			"--session-dir",
			"/run/pi-agent/sessions",
			"--model",
			"openai/gpt-6.1-sol",
			"-e",
			"/opt/factory/pkg/node_modules/pi-herdr-agents",
		]);
	});
});

describe("per-stage agent dir", () => {
	it("copies a read-only bundle template into a private writable dir with a sessions dir", () => {
		const dir = mkdtempSync(join(tmpdir(), "factory-agent-template-"));
		const template = join(dir, "pi-agent");
		const dest = join(dir, "agent-0");

		try {
			mkdirSync(template);
			writeFileSync(join(template, "models.json"), "{}\n");
			chmodSync(join(template, "models.json"), 0o444);
			chmodSync(template, 0o555);

			agentDirFrom(template, dest);

			assert.equal(statSync(dest).mode & 0o777, 0o700);
			assert.equal(statSync(join(dest, "sessions")).mode & 0o777, 0o700);
			assert.equal(statSync(join(dest, "models.json")).mode & 0o777, 0o600);
			assert.equal(readFileSync(join(dest, "models.json"), "utf8"), "{}\n");
			writeFileSync(join(dest, "auth.json"), "{}");
		} finally {
			chmodSync(template, 0o755);
			rmSync(dir, { recursive: true, force: true });
		}
	});
});

describe("per-stage agent dir extensions", () => {
	it("creates no extensions/ dir, even when the template holds one", () => {
		const dir = mkdtempSync(join(tmpdir(), "factory-agent-ext-"));

		try {
			mkdirSync(join(dir, "pi-agent", "extensions"), { recursive: true });
			writeFileSync(join(dir, "pi-agent", "extensions", "x.js"), "");
			writeFileSync(join(dir, "pi-agent", "models.json"), "{}\n");

			agentDirFrom(join(dir, "pi-agent"), join(dir, "agent-0"));

			assert.deepEqual(readdirSync(join(dir, "agent-0")).sort(), [
				"models.json",
				"sessions",
			]);
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});
});

describe("child session paths", () => {
	it("maps only regular files under the stage agent sessions dir", () => {
		const dir = mkdtempSync(join(tmpdir(), "factory-agent-"));

		try {
			mkdirSync(join(dir, "sessions", "--w--"), { recursive: true });
			writeFileSync(join(dir, "sessions", "--w--", "a.jsonl"), "{}\n");
			writeFileSync(join(dir, "auth.json"), "{}");
			symlinkSync("/etc/hostname", join(dir, "sessions", "escape.jsonl"));

			assert.equal(
				hostSessionPath(dir, "/run/pi-agent/sessions/--w--/a.jsonl"),
				join(dir, "sessions", "--w--", "a.jsonl"),
			);
			assert.equal(
				hostSessionPath(dir, "/run/pi-agent/sessions/escape.jsonl"),
				null,
			);
			assert.equal(hostSessionPath(dir, "/run/pi-agent/auth.json"), null);
			assert.equal(
				hostSessionPath(dir, "/run/pi-agent/sessions/../auth.json"),
				null,
			);
			assert.equal(
				hostSessionPath(dir, "/home/exedev/.pi/agent/sessions/x.jsonl"),
				null,
			);
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});
});
