import { closeSync, readFileSync } from "node:fs";
import { LineSplitter } from "../../server/sandbox/lines.ts";
import {
	fieldOf,
	type JsonValue,
	objectOf,
	parseJson,
	textOf,
} from "../../server/sandbox/json.ts";

/**
 * A stand-in Pi RPC process for runner tests. `replay <fixture>` answers the
 * prompt by replaying recorded Pi stdout records; `crash` exits mid-run;
 * `garbage` prints a line that is not JSON; `close-stdin` closes its
 * command pipe and stays alive half a second, so a write to it fails.
 */
const [scenario, fixture] = process.argv.slice(2);

if (scenario === "close-stdin") {
	closeSync(0);
	process.send?.("ready");
	setTimeout(() => process.exit(0), 500);
}

function emitLine(line: string): void {
	process.stdout.write(`${line}\n`);
}

function emit(record: JsonValue): void {
	emitLine(JSON.stringify(record));
}

function replay(promptId: string): void {
	const lines = readFileSync(fixture ?? "", "utf8")
		.split("\n")
		.filter((line) => line !== "");

	for (const line of lines) {
		const record = objectOf(parseJson(line));

		if (record !== null && textOf(fieldOf(record, "type")) === "response") {
			emit({ ...record, id: promptId });
		} else {
			emitLine(line);
		}
	}
}

const splitter = new LineSplitter(1024 * 1024);

function onCommands(chunk: Buffer): void {
	for (const line of splitter.push(chunk) ?? []) {
		const command = objectOf(parseJson(line));
		const type = textOf(fieldOf(command, "type"));
		const id = textOf(fieldOf(command, "id")) ?? "";

		if (type === "prompt" && scenario === "replay") replay(id);

		if (type === "prompt" && scenario === "crash") {
			emit({
				id,
				type: "response",
				command: "prompt",
				success: true,
				data: { disposition: "started" },
			});
			emit({ type: "agent_start" });
			process.exit(3);
		}

		if (type === "prompt" && scenario === "garbage") {
			emit({
				id,
				type: "response",
				command: "prompt",
				success: true,
				data: { disposition: "started" },
			});
			emitLine("✓ 8ms this is not a protocol record");
		}

		if (type === "abort") emit({ type: "agent_settled", aborted: true });
	}
}

if (scenario !== "close-stdin") {
	process.stdin.on("data", onCommands);
	process.stdin.on("end", () => process.exit(0));
}
