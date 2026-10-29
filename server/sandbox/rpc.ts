import type { Readable, Writable } from "node:stream";
import {
	boolOf,
	countOf,
	fieldOf,
	type JsonObject,
	type JsonValue,
	objectOf,
	parseJson,
	textOf,
	arrayOf,
} from "./json.ts";

export type PiUsage = { readonly totalTokens: number };

export type AssistantEnd = {
	readonly stopReason: string;
	readonly rawStopReason: string | null;
	readonly errorMessage: string | null;
	readonly usage: PiUsage | null;
	readonly provider: string | null;
	readonly model: string | null;
};

/** The Pi RPC records the runner acts on. Everything else valid is `other`. */
export type PiRecord =
	| {
			readonly type: "response";
			readonly id: string | null;
			readonly command: string;
			readonly success: boolean;
			readonly disposition: string | null;
	  }
	| { readonly type: "agent_start" }
	| { readonly type: "agent_settled"; readonly aborted: boolean }
	| { readonly type: "turn_start" }
	| { readonly type: "assistant_end"; readonly message: AssistantEnd }
	| { readonly type: "subagent_launch" }
	| { readonly type: "subagent_result"; readonly sessionFile: string | null }
	| { readonly type: "queue"; readonly queued: number }
	| {
			readonly type: "ui_request";
			readonly id: string;
			readonly method: string;
	  }
	| { readonly type: "other" }
	| { readonly type: "malformed" };

export type PiCommand =
	| { readonly id: string; readonly type: "prompt"; readonly message: string }
	| { readonly id: string; readonly type: "abort" }
	| {
			readonly type: "extension_ui_response";
			readonly id: string;
			readonly cancelled: true;
	  };

/** Dialog methods block Pi until answered. The runner cancels every one. */
export const DIALOG_METHODS = ["select", "confirm", "input", "editor"] as const;

const MALFORMED: PiRecord = { type: "malformed" };

function usageOf(value: JsonValue | undefined): PiUsage | null {
	const total = countOf(fieldOf(objectOf(value), "totalTokens"));

	return total === null ? null : { totalTokens: total };
}

function nullableText(value: JsonValue | undefined): string | null | undefined {
	if (value === undefined || value === null) return null;

	return textOf(value) ?? undefined;
}

function messageEnd(message: JsonObject | null): PiRecord {
	if (message === null) return MALFORMED;

	const role = textOf(fieldOf(message, "role"));
	const customType = textOf(fieldOf(message, "customType"));

	if (role === "assistant") {
		const stopReason = textOf(fieldOf(message, "stopReason"));
		const rawStopReason = nullableText(fieldOf(message, "rawStopReason"));
		const errorMessage = nullableText(fieldOf(message, "errorMessage"));
		const provider = nullableText(fieldOf(message, "provider"));
		const model = nullableText(fieldOf(message, "model"));

		if (
			stopReason === null ||
			rawStopReason === undefined ||
			errorMessage === undefined ||
			provider === undefined ||
			model === undefined
		) {
			return MALFORMED;
		}

		return {
			type: "assistant_end",
			message: {
				stopReason,
				rawStopReason,
				errorMessage,
				usage: usageOf(fieldOf(message, "usage")),
				provider,
				model,
			},
		};
	}

	if (customType === "subagent_result") {
		const details = objectOf(fieldOf(message, "details"));

		return {
			type: "subagent_result",
			sessionFile: textOf(fieldOf(details, "sessionFile")),
		};
	}

	return role === null && customType === null ? MALFORMED : { type: "other" };
}

/** Parses one stdout line from Pi. Invalid JSON or a known record with bad fields is `malformed`. */
export function parsePiRecord(line: string): PiRecord {
	const record = objectOf(parseJson(line));
	const type = textOf(fieldOf(record, "type"));

	if (record === null || type === null) return MALFORMED;

	switch (type) {
		case "response": {
			const command = textOf(fieldOf(record, "command"));
			const success = boolOf(fieldOf(record, "success"));
			const id = nullableText(fieldOf(record, "id"));

			if (command === null || success === null || id === undefined)
				return MALFORMED;

			return {
				type,
				id,
				command,
				success,
				disposition: textOf(
					fieldOf(objectOf(fieldOf(record, "data")), "disposition"),
				),
			};
		}

		case "agent_start":
		case "turn_start":
			return { type };
		case "agent_settled": {
			const aborted = boolOf(fieldOf(record, "aborted"));

			return aborted === null ? MALFORMED : { type, aborted };
		}

		case "message_end":
			return messageEnd(objectOf(fieldOf(record, "message")));
		case "tool_execution_end": {
			const details = objectOf(
				fieldOf(objectOf(fieldOf(record, "result")), "details"),
			);

			return textOf(fieldOf(record, "toolName")) === "subagent" &&
				boolOf(fieldOf(record, "isError")) === false &&
				textOf(fieldOf(details, "id")) !== null &&
				fieldOf(details, "error") === undefined
				? { type: "subagent_launch" }
				: { type: "other" };
		}

		case "queue_update": {
			const steering = arrayOf(fieldOf(record, "steering"));
			const followUp = arrayOf(fieldOf(record, "followUp"));

			return steering === null || followUp === null
				? MALFORMED
				: { type: "queue", queued: steering.length + followUp.length };
		}

		case "extension_ui_request": {
			const id = textOf(fieldOf(record, "id"));
			const method = textOf(fieldOf(record, "method"));

			return id === null || method === null
				? MALFORMED
				: { type: "ui_request", id, method };
		}

		default:
			return { type: "other" };
	}
}

/** A running Pi RPC process: JSONL commands in, JSONL records out. */
export interface PiProcess {
	readonly stdin: Writable;
	readonly stdout: Readable;
	readonly exited: Promise<number | null>;
	kill(): void;
}

export function sendCommand(pi: PiProcess, command: PiCommand): void {
	if (pi.stdin.writable) pi.stdin.write(`${JSON.stringify(command)}\n`);
}
