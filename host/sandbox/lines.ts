/**
 * Splits a byte stream into JSONL records on LF only, never on U+2028 or
 * U+2029 the way `readline` does. A trailing CR is stripped and empty lines
 * are skipped. A line longer than the cap makes `push` return `null`,
 * whether or not its LF arrived in the same chunk.
 */
export class LineSplitter {
	readonly #maxBytes: number;
	#pending: Buffer = Buffer.alloc(0);

	constructor(maxBytes: number) {
		this.#maxBytes = maxBytes;
	}

	push(chunk: Buffer): string[] | null {
		const joined = Buffer.concat([this.#pending, chunk]);
		const lines: string[] = [];
		let start = 0;
		let newline = joined.indexOf(0x0a, start);

		while (newline !== -1) {
			const end =
				newline > start && joined[newline - 1] === 0x0d ? newline - 1 : newline;

			if (end - start > this.#maxBytes) return null;

			if (end > start) lines.push(joined.subarray(start, end).toString("utf8"));

			start = newline + 1;
			newline = joined.indexOf(0x0a, start);
		}

		this.#pending = joined.subarray(start);

		return this.#pending.length > this.#maxBytes ? null : lines;
	}

	/** Bytes left without a closing LF. */
	get rest(): number {
		return this.#pending.length;
	}
}
