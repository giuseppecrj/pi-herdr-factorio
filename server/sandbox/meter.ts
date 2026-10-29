import { countOf, fieldOf, objectOf, parseJson, textOf } from "./json.ts";

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
