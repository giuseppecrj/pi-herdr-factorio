import {
	countOf,
	fieldOf,
	type JsonObject,
	objectOf,
	parseJson,
	textOf,
} from "../../src/core/json.ts";
import { isAnthropicModelId } from "../../src/core/models.ts";

export type MeteredUsage = {
	readonly inputTokens: number;
	readonly outputTokens: number;
};

const TERMINAL_EVENTS = [
	"response.completed",
	"response.incomplete",
	"response.failed",
] as const;

const MAX_LINE_BYTES = 16 * 1024 * 1024;

/**
 * Reads token usage from an OpenAI Responses SSE stream as it passes through.
 * Only the terminal event's `usage` counts. A stream without one is unmetered.
 */
export class SseMeter {
	#pending = "";
	#overflow = false;
	#usage: MeteredUsage | null = null;
	readonly #decoder = new TextDecoder("utf-8");

	push(chunk: Buffer): void {
		this.#consume(this.#decoder.decode(chunk, { stream: true }));
	}

	end(): void {
		this.#consume(`${this.#decoder.decode()}\n`);
	}

	usage(): MeteredUsage | null {
		return this.#usage;
	}

	#consume(text: string): void {
		let rest = this.#pending + text;
		let newline = rest.indexOf("\n");

		while (newline !== -1) {
			const line = rest.slice(0, newline).replace(/\r$/, "");

			if (!this.#overflow) this.#line(line);

			this.#overflow = false;
			rest = rest.slice(newline + 1);
			newline = rest.indexOf("\n");
		}

		if (rest.length > MAX_LINE_BYTES) {
			this.#overflow = true;
			rest = "";
		}

		this.#pending = rest;
	}

	#line(line: string): void {
		if (!line.startsWith("data:")) return;

		const event = objectOf(parseJson(line.slice(5).trim()));
		const type = textOf(fieldOf(event, "type"));

		if (!TERMINAL_EVENTS.some((terminal) => terminal === type)) return;

		const usage = objectOf(
			fieldOf(objectOf(fieldOf(event, "response")), "usage"),
		);

		const inputTokens = countOf(fieldOf(usage, "input_tokens"));
		const outputTokens = countOf(fieldOf(usage, "output_tokens"));

		if (inputTokens !== null && outputTokens !== null) {
			this.#usage = { inputTokens, outputTokens };
		}
	}
}

export type AnthropicMeterResult =
	| {
			readonly kind: "metered";
			readonly inputTokens: number;
			readonly outputTokens: number;
			readonly observedModel: string;
	  }
	| { readonly kind: "unusable" };

const UNUSABLE: AnthropicMeterResult = { kind: "unusable" };

const INPUT_FIELDS = [
	"input_tokens",
	"cache_creation_input_tokens",
	"cache_read_input_tokens",
] as const;

/**
 * Usage from one model reply. Input is fresh input plus cache writes plus
 * cache reads, each taken from `last` or else `first`, and all three must be
 * numbers. Output comes from `last` only. The model must be a bare table id.
 */
function meteredUsage(
	model: string | null,
	first: JsonObject | null,
	last: JsonObject | null,
): AnthropicMeterResult {
	const outputTokens = countOf(fieldOf(last, "output_tokens"));

	if (model === null || !isAnthropicModelId(model) || outputTokens === null)
		return UNUSABLE;

	let inputTokens = 0;

	for (const name of INPUT_FIELDS) {
		const count = countOf(fieldOf(last, name)) ?? countOf(fieldOf(first, name));

		if (count === null) return UNUSABLE;

		inputTokens += count;
	}

	return { kind: "metered", inputTokens, outputTokens, observedModel: model };
}

/**
 * Reads token usage and the answering model from an Anthropic Messages
 * response as it passes through: an SSE stream, or a single JSON message.
 *
 * A stream is metered only with exactly one `message_start`, a last
 * `message_delta` with usage, and a `message_stop`. The model is
 * `message_start.message.model`, as the edge reports it. Anything else,
 * including an `error` event or a data line that does not parse, is
 * `unusable`, never a success with zero tokens.
 */
export class AnthropicSseMeter {
	#mode: "unknown" | "sse" | "json" = "unknown";
	#pending = "";
	#broken = false;
	#starts = 0;
	#stopped = false;
	#model: string | null = null;
	#startUsage: JsonObject | null = null;
	#lastUsage: JsonObject | null = null;
	readonly #decoder = new TextDecoder("utf-8");

	push(chunk: Buffer): void {
		this.#consume(this.#decoder.decode(chunk, { stream: true }));
	}

	end(): void {
		this.#consume(this.#decoder.decode());

		if (this.#mode === "json") this.#message(this.#pending);
		else this.#consume("\n");

		this.#pending = "";
	}

	result(): AnthropicMeterResult {
		if (this.#broken || this.#starts !== 1 || !this.#stopped) return UNUSABLE;

		return meteredUsage(this.#model, this.#startUsage, this.#lastUsage);
	}

	#consume(text: string): void {
		if (this.#broken) return;

		if (this.#mode === "unknown") {
			const first = (this.#pending + text).trimStart()[0];

			if (first === undefined) {
				this.#pending += text;

				return;
			}

			this.#mode = first === "{" ? "json" : "sse";
		}

		if (this.#mode === "json") {
			this.#pending += text;

			if (this.#pending.length > MAX_LINE_BYTES) this.#fail();

			return;
		}

		let rest = this.#pending + text;
		let newline = rest.indexOf("\n");

		while (newline !== -1 && !this.#broken) {
			this.#line(rest.slice(0, newline).trim());
			rest = rest.slice(newline + 1);
			newline = rest.indexOf("\n");
		}

		if (rest.length > MAX_LINE_BYTES) this.#fail();
		else this.#pending = rest;
	}

	#fail(): void {
		this.#broken = true;
		this.#pending = "";
	}

	#line(line: string): void {
		if (!line.startsWith("data:")) return;

		const event = objectOf(parseJson(line.slice(5).trim()));
		const type = textOf(fieldOf(event, "type"));

		if (event === null || type === null || type === "error") {
			this.#fail();

			return;
		}

		if (type === "message_start") {
			const message = objectOf(fieldOf(event, "message"));

			this.#starts += 1;
			this.#model = textOf(fieldOf(message, "model"));
			this.#startUsage = objectOf(fieldOf(message, "usage"));
		} else if (type === "message_delta") {
			const usage = objectOf(fieldOf(event, "usage"));

			if (usage === null) this.#fail();
			else this.#lastUsage = usage;
		} else if (type === "message_stop") {
			this.#stopped = true;
		}
	}

	/** A non-stream reply: one JSON `message` object with its usage. */
	#message(text: string): void {
		const message = objectOf(parseJson(text.trim()));

		if (this.#broken || textOf(fieldOf(message, "type")) !== "message") {
			this.#fail();

			return;
		}

		this.#starts = 1;
		this.#stopped = true;
		this.#model = textOf(fieldOf(message, "model"));
		this.#lastUsage = objectOf(fieldOf(message, "usage"));
	}
}
