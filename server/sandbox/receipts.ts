import { statSync } from "node:fs";
import { readFile } from "node:fs/promises";
import type { SessionOutcome } from "../../src/core/execution.ts";
import {
	countOf,
	fieldOf,
	objectOf,
	parseJson,
	textOf,
} from "../../src/core/json.ts";

export const MAX_RECEIPT_BYTES = 1024 * 1024;

export async function boundedText(
	path: string,
	cap: number,
): Promise<string | null> {
	try {
		return statSync(path).size > cap ? null : await readFile(path, "utf8");
	} catch {
		return null;
	}
}

export async function readStageReceipt(path: string) {
	const raw = await boundedText(path, MAX_RECEIPT_BYTES);
	const record = objectOf(parseJson(raw ?? ""));
	const result = objectOf(fieldOf(record, "outcome"));
	const kind = textOf(fieldOf(result, "kind"));
	let outcome: SessionOutcome;

	if (kind === "passed" || kind === "refused") outcome = { kind };
	else if (kind === "failed") {
		const exit = textOf(fieldOf(result, "exit"));

		if (
			exit !== "error" &&
			exit !== "malformed" &&
			exit !== "crashed" &&
			exit !== "aborted"
		)
			return null;

		outcome = { kind, exit };
	} else if (kind === "budget_exhausted") {
		const cap = textOf(fieldOf(result, "cap"));

		if (
			cap !== "tokens" &&
			cap !== "run_tokens" &&
			cap !== "turns" &&
			cap !== "wall"
		)
			return null;

		outcome = { kind, cap };
	} else return null;

	const usage = objectOf(fieldOf(record, "usage"));
	const byModel: Record<string, number> = {};

	for (const [key, value] of Object.entries(
		objectOf(fieldOf(usage, "byModel")) ?? {},
	)) {
		const count = countOf(value);

		if (count === null) return null;

		byModel[key] = count;
	}

	const total = countOf(fieldOf(usage, "total"));
	const turns = countOf(fieldOf(record, "turns"));
	const wallMs = countOf(fieldOf(record, "wallMs"));

	if (total === null || turns === null || wallMs === null) return null;

	return {
		record,
		outcome,
		turns,
		wallMs,
		usage: {
			total,
			byModel,
			parent: countOf(fieldOf(usage, "parent")) ?? 0,
			children: countOf(fieldOf(usage, "children")) ?? 0,
			gateway: countOf(fieldOf(usage, "gateway")),
			unreadChildren: countOf(fieldOf(usage, "unreadChildren")) ?? 0,
		},
	};
}
