import { fieldOf, objectOf, parseJson, textOf } from "./json.ts";
import type { BudgetCap, RefusalSignal, SessionOutcome } from "./result.ts";
import { type AssistantEnd, DIALOG_METHODS, type PiRecord } from "./rpc.ts";

const MODEL_ID = /^[a-z0-9][a-z0-9-]*\/[A-Za-z0-9][A-Za-z0-9._:-]*$/;

/** `provider/model` when it is a well-formed model id, else `unknown`. */
export function modelKey(
	provider: string | null,
	model: string | null,
): string {
	const key = `${provider ?? ""}/${model ?? ""}`;

	return MODEL_ID.test(key) ? key : "unknown";
}

const POLICY_CODES = ["content_policy_violation", "content_filter"];

/**
 * Classifies a refusal from structured fields only, using the shapes Pi
 * 1.4.0 produced in proto-runtime experiment 8. A refusal content part that
 * arrives as plain text with `stopReason: "stop"` is not a refusal here.
 */
export function classifyRefusal(message: AssistantEnd): RefusalSignal | null {
	if (message.stopReason !== "error") return null;

	if (message.rawStopReason === "incomplete.content_filter") {
		return "incomplete_content_filter";
	}

	if (message.rawStopReason === "refusal") return "refusal";

	const error = message.errorMessage ?? "";

	if (
		message.rawStopReason === "failed" &&
		error.startsWith("content_filter:")
	) {
		return "failed_content_filter";
	}

	const api = /^OpenAI API error \(400\): (\{.*\})$/s.exec(error);
	const body = api === null ? null : objectOf(parseJson(api[1] ?? ""));
	const code = textOf(fieldOf(body, "code"));

	return code !== null && POLICY_CODES.includes(code) ? "content_policy" : null;
}

export type ChildUsage = {
	readonly total: number;
	readonly byModel: ReadonlyMap<string, number>;
};

/** Sums assistant usage in a child's session file. Unparseable lines are skipped. */
export function childUsageOf(text: string): ChildUsage {
	const byModel = new Map<string, number>();
	let total = 0;

	for (const line of text.split("\n")) {
		const entry = objectOf(parseJson(line));
		const message = objectOf(fieldOf(entry, "message"));

		if (
			textOf(fieldOf(entry, "type")) !== "message" ||
			textOf(fieldOf(message, "role")) !== "assistant"
		) {
			continue;
		}

		const tokens = Number(
			fieldOf(objectOf(fieldOf(message, "usage")), "totalTokens"),
		);

		if (!Number.isSafeInteger(tokens) || tokens < 0) continue;

		const key = modelKey(
			textOf(fieldOf(message, "provider")),
			textOf(fieldOf(message, "model")),
		);

		total += tokens;
		byModel.set(key, (byModel.get(key) ?? 0) + tokens);
	}

	return { total, byModel };
}

export type TrackerSignal =
	| { readonly kind: "none" }
	| { readonly kind: "answer_ui"; readonly id: string }
	| { readonly kind: "settled" }
	| { readonly kind: "arm_turn_cap" }
	| { readonly kind: "cap"; readonly cap: BudgetCap }
	| { readonly kind: "child"; readonly sessionFile: string | null }
	| { readonly kind: "failed"; readonly exit: "error" | "malformed" };

/**
 * One Pi session's view of the RPC stream. The stage is settled when every
 * launched child has reported, an `agent_settled` came after the last
 * child result, and nothing is queued. `agent_settled` alone is never the
 * outcome; the last assistant `message_end` is.
 */
export class SessionTracker {
	readonly #promptId: string;
	readonly #maxTurns: number;
	turns: number;
	launches = 0;
	results = 0;
	queued = 0;
	started = false;
	settledAfterLast = false;
	aborted: boolean | null = null;
	lastAssistant: AssistantEnd | null = null;
	parentTokens = 0;
	readonly byModel = new Map<string, number>();

	constructor(promptId: string, maxTurns: number, turnsSoFar: number) {
		this.#promptId = promptId;
		this.#maxTurns = maxTurns;
		this.turns = turnsSoFar;
	}

	apply(record: PiRecord): TrackerSignal {
		switch (record.type) {
			case "malformed":
				return { kind: "failed", exit: "malformed" };
			case "response":
				return this.#response(record);
			case "agent_start":
				this.settledAfterLast = false;

				return { kind: "none" };
			case "turn_start":
				this.turns += 1;

				return this.turns > this.#maxTurns
					? { kind: "cap", cap: "turns" }
					: { kind: "none" };
			case "assistant_end": {
				const tokens = record.message.usage?.totalTokens ?? 0;
				const key = modelKey(record.message.provider, record.message.model);

				this.lastAssistant = record.message;
				this.parentTokens += tokens;
				this.byModel.set(key, (this.byModel.get(key) ?? 0) + tokens);

				return this.turns >= this.#maxTurns
					? { kind: "arm_turn_cap" }
					: { kind: "none" };
			}

			case "subagent_launch":
				this.launches += 1;

				return { kind: "none" };
			case "subagent_result":
				this.results += 1;
				this.settledAfterLast = false;

				return { kind: "child", sessionFile: record.sessionFile };
			case "queue":
				this.queued = record.queued;

				return { kind: "none" };
			case "ui_request":
				return DIALOG_METHODS.some((method) => method === record.method)
					? { kind: "answer_ui", id: record.id }
					: { kind: "none" };
			case "agent_settled":
				this.settledAfterLast = true;
				this.aborted = record.aborted;

				return this.settled() ? { kind: "settled" } : { kind: "none" };
			case "other":
				return { kind: "none" };
		}
	}

	settled(): boolean {
		return (
			this.started &&
			this.launches === this.results &&
			this.settledAfterLast &&
			this.queued === 0
		);
	}

	#response(record: Extract<PiRecord, { type: "response" }>): TrackerSignal {
		if (record.command === "parse")
			return { kind: "failed", exit: "malformed" };

		if (record.id !== this.#promptId) return { kind: "none" };

		if (!record.success || record.disposition === "handled") {
			return { kind: "failed", exit: "error" };
		}

		this.started = true;

		return this.settled() ? { kind: "settled" } : { kind: "none" };
	}
}

export type SettledOutcome = {
	readonly outcome: SessionOutcome;
	readonly refusal: RefusalSignal | null;
};

/** The outcome of a session that settled on its own. */
export function settledOutcome(last: AssistantEnd | null): SettledOutcome {
	if (last === null)
		return { outcome: { kind: "failed", exit: "error" }, refusal: null };

	if (last.stopReason === "stop" || last.stopReason === "length") {
		return { outcome: { kind: "passed" }, refusal: null };
	}

	if (last.stopReason === "aborted") {
		return { outcome: { kind: "failed", exit: "aborted" }, refusal: null };
	}

	const refusal = classifyRefusal(last);

	return refusal === null
		? { outcome: { kind: "failed", exit: "error" }, refusal: null }
		: { outcome: { kind: "refused" }, refusal };
}
