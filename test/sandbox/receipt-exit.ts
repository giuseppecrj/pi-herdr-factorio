import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough } from "node:stream";
import { runStage, type StageHost } from "../../server/sandbox.ts";
import { startGatewayProcess } from "../../server/sandbox/gateway-client.ts";
import type { JsonValue } from "../../server/sandbox/json.ts";
import type { PiProcess } from "../../server/sandbox/rpc.ts";
import type { Digest } from "../../src/run.ts";
import type { ModelId } from "../../src/workflow.ts";

/**
 * Runs one passing stage through `runStage` with a real gateway process
 * and a scripted Pi, prints `receipt` when the receipt is published and
 * then returns, so the parent can time the process exit.
 */

function scriptedPi(): PiProcess {
	const stdin = new PassThrough();
	const stdout = new PassThrough();
	let exit: (code: number | null) => void = () => {};

	const exited = new Promise<number | null>((done) => {
		exit = done;
	});

	const emit = (record: JsonValue) =>
		stdout.write(`${JSON.stringify(record)}\n`);

	stdin.on("data", (chunk: Buffer) => {
		for (const line of chunk.toString().split("\n")) {
			if (line === "") continue;

			const command = JSON.parse(line);

			if (command.type !== "prompt") continue;

			emit({
				id: command.id,
				type: "response",
				command: "prompt",
				success: true,
				data: { disposition: "started" },
			});
			emit({ type: "agent_start" });
			emit({ type: "turn_start" });
			emit({
				type: "message_end",
				message: {
					role: "assistant",
					provider: "openai",
					model: "gpt-6.1-sol",
					stopReason: "stop",
					rawStopReason: "completed",
					usage: { input: 0, output: 0, totalTokens: 10 },
				},
			});
			emit({ type: "turn_end" });
			emit({ type: "agent_end" });
			emit({ type: "agent_settled", aborted: false });
		}
	});
	stdin.on("end", () => {
		stdout.end();
		exit(0);
	});

	return { stdin, stdout, exited, kill: () => exit(null) };
}

const dir = mkdtempSync(join(tmpdir(), "factory-receipt-exit-"));

const host: StageHost = {
	cleanupReserveMs: 10_000,
	assetsDigest: "e".repeat(64),
	versions: { pi: "1.4.0", piHerdrAgents: "3.3.1", piHerdrPstack: "0.5.0" },
	now: Date.now,
	async startGateway(table) {
		const started = await startGatewayProcess({
			gatewayDir: join(dir, "gw"),
			auditPath: join(dir, "egress.jsonl"),
			table,
			readyTimeoutMs: 10_000,
		});

		return started.ok ? started.handle : null;
	},
	async launchPi() {
		return scriptedPi();
	},
	async stopSandbox() {},
	async readChildUsage() {
		return null;
	},
	async writeReceipt() {
		process.stdout.write("receipt\n");

		return true;
	},
	async stderrLog() {
		return null;
	},
};

try {
	const result = await runStage(
		{
			// SAFETY: 64 lowercase hex digits, the Digest pattern.
			runId: "a".repeat(64) as Digest,
			stage: "specify",
			attempt: 1,
			prompt: "Reply with exactly: OK",
			settings: {
				// SAFETY: a provider/model pair, the ModelId pattern.
				model: "openai/gpt-6.1-sol" as ModelId,
				fallback: null,
				budget: { maxTurns: 10, wallMs: 60_000, stallMs: 300_000 },
				maxTokens: null,
			},
			remainingRunTokens: 1_000_000,
			signal: new AbortController().signal,
			progress: () => {},
		},
		host,
	);

	process.stdout.write(`result ${result.kind}\n`);
} finally {
	rmSync(dir, { recursive: true, force: true });
}
