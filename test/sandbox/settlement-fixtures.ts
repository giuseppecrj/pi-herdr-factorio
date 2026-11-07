import assert from "node:assert/strict";
import { journalCharge } from "../../server/sandbox/audit.ts";
import { familyFromJournal, type FamilyInput } from "../../src/review.ts";
import {
	isAnthropicModelId,
	parseAnthropicModel,
} from "../../server/sandbox/anthropic-limits.ts";
import {
	countOf,
	fieldOf,
	objectOf,
	parseJson,
	textOf,
	type JsonValue,
} from "../../server/sandbox/json.ts";

// Frozen f9965fc readers are the parity oracle, not the new projection.
export function legacyCharge(text: string) {
	const dispatched = new Map<number, number>();
	const settled = new Map<number, number | null>();

	for (const line of text.split("\n")) {
		const record = objectOf(parseJson(line));
		const req = countOf(fieldOf(record, "req"));
		const kind = fieldOf(record, "kind");

		if (record === null || req === null) continue;

		if (kind === "dispatch" && !dispatched.has(req))
			dispatched.set(
				req,
				(countOf(fieldOf(record, "inputTokenEstimate")) ?? 0) +
					(countOf(fieldOf(record, "maxOutputTokens")) ?? 0),
			);
		else if (kind === "result" && !settled.has(req)) {
			const input = countOf(fieldOf(record, "inputTokens"));
			const output = countOf(fieldOf(record, "outputTokens"));

			settled.set(
				req,
				input === null && output === null ? null : (input ?? 0) + (output ?? 0),
			);
		}
	}

	const metered = [...settled.values()];

	const unsettled = [...dispatched].filter(
		([req, bound]) =>
			!settled.has(req) || (settled.get(req) === null && bound > 0),
	);

	return {
		tokens: metered.reduce<number>((sum, value) => sum + (value ?? 0), 0),
		dispatched: dispatched.size,
		settled: settled.size,
		unmetered: metered.filter((value) => value === null).length,
		uncertain: unsettled.length,
		uncertainTokens: unsettled.reduce((sum, [, bound]) => sum + bound, 0),
	};
}

export function legacyUsability(journal: string, stopped: boolean) {
	const dispatched = new Set<number>();
	const results = new Set<number>();
	let veto = false;
	let metered = false;

	for (const line of journal.split("\n")) {
		const record = objectOf(parseJson(line));
		const req = countOf(fieldOf(record, "req"));

		// The old metered-presence reader did not require a request number.
		if (
			record !== null &&
			fieldOf(record, "route") === "model-anthropic" &&
			fieldOf(record, "kind") === "result" &&
			fieldOf(record, "reason") !== "provider_rejected" &&
			countOf(fieldOf(record, "inputTokens")) !== null &&
			countOf(fieldOf(record, "outputTokens")) !== null
		)
			metered = true;

		if (
			record === null ||
			req === null ||
			fieldOf(record, "route") !== "model-anthropic"
		)
			continue;

		if (fieldOf(record, "kind") === "dispatch") dispatched.add(req);

		if (fieldOf(record, "kind") !== "result") continue;

		results.add(req);

		if (fieldOf(record, "reason") === "upstream_unreachable") continue;

		if (
			fieldOf(record, "reason") !== "provider_rejected" &&
			(countOf(fieldOf(record, "inputTokens")) === null ||
				countOf(fieldOf(record, "outputTokens")) === null)
		)
			veto = true;
	}

	return {
		veto: veto || (stopped && [...dispatched].some((req) => !results.has(req))),
		metered,
	};
}

export function journalText(records: readonly JsonValue[]): string {
	return records.map((record) => JSON.stringify(record)).join("\n");
}

export function requestFixture(
	req: number,
	route = "model-anthropic",
	bound: JsonValue = { inputTokenEstimate: 100, maxOutputTokens: 1000 },
) {
	return {
		v: 1,
		ts: "2026-11-04T00:00:00.000Z",
		stage: "accept",
		runId: "a".repeat(64),
		attempt: 1,
		req,
		route,
		kind: "dispatch",
		...objectOf(bound),
	};
}

export function replyFixture(
	req: number,
	overrides: Record<string, JsonValue> = {},
) {
	return {
		...requestFixture(req),
		kind: "result",
		status: 200,
		decision: "forward",
		inputTokens: 11,
		outputTokens: 5,
		observedModel: "claude-sonnet-5-5",
		...overrides,
	};
}

export const SETTLEMENT_FIXTURES = [
	["empty", ""],
	["admitted only", journalText([{ ...requestFixture(1), kind: "admitted" }])],
	["crash after dispatch sync", journalText([requestFixture(1)])],
	["legacy dispatch", journalText([requestFixture(1, "model-anthropic", {})])],
	["metered", journalText([requestFixture(1), replyFixture(1)])],
	["result only", journalText([replyFixture(1)])],
	[
		"unmetered bounded",
		journalText([
			requestFixture(1),
			replyFixture(1, { inputTokens: null, outputTokens: null }),
		]),
	],
	[
		"unmetered legacy",
		journalText([
			requestFixture(1, "model-anthropic", {}),
			replyFixture(1, { inputTokens: null, outputTokens: null }),
		]),
	],
	[
		"partial usage",
		journalText([requestFixture(1), replyFixture(1, { outputTokens: null })]),
	],
	[
		"completed provider rejection",
		journalText([
			requestFixture(1),
			replyFixture(1, {
				status: 529,
				reason: "provider_rejected",
				inputTokens: 0,
				outputTokens: 0,
			}),
		]),
	],
	[
		"rejected with reported usage",
		journalText([
			requestFixture(1),
			replyFixture(1, { status: 400, reason: "provider_rejected" }),
		]),
	],
	[
		"legacy rejection with no usage",
		journalText([
			requestFixture(1),
			replyFixture(1, {
				status: 400,
				reason: "provider_rejected",
				inputTokens: null,
				outputTokens: null,
			}),
		]),
	],
	...[502, 504].flatMap((status) => [
		[
			`transport ${status}`,
			journalText([
				requestFixture(1),
				replyFixture(1, {
					status,
					decision: "error",
					reason: "upstream_unreachable",
					inputTokens: null,
					outputTokens: null,
				}),
			]),
		],
		[
			`cut provider ${status}`,
			journalText([
				requestFixture(1),
				replyFixture(1, {
					status,
					decision: "error",
					inputTokens: null,
					outputTokens: null,
				}),
			]),
		],
	]),
	[
		"cut 2xx",
		journalText([
			requestFixture(1),
			replyFixture(1, {
				decision: "blocked_mid_stream",
				inputTokens: null,
				outputTokens: null,
			}),
		]),
	],
	[
		"mixed providers",
		journalText([
			requestFixture(1),
			replyFixture(1),
			requestFixture(2, "model-openai"),
			replyFixture(2, { route: "model-openai", observedModel: "gpt-6.1-sol" }),
		]),
	],
	[
		"duplicate",
		journalText([
			requestFixture(1),
			requestFixture(1),
			replyFixture(1),
			replyFixture(1),
		]),
	],
	[
		"contradictory duplicate",
		journalText([
			requestFixture(1),
			replyFixture(1),
			replyFixture(1, { inputTokens: null, outputTokens: null }),
		]),
	],
	[
		"duplicate result before dispatch",
		journalText([
			replyFixture(1),
			requestFixture(1),
			replyFixture(1, { inputTokens: 1, outputTokens: 1 }),
		]),
	],
	[
		"result order differs from dispatch order",
		journalText([
			requestFixture(1),
			requestFixture(2),
			replyFixture(2),
			replyFixture(1, { observedModel: "claude-haiku-5-5" }),
		]),
	],
	[
		"reused number on another route",
		journalText([
			requestFixture(1, "model-openai"),
			replyFixture(1, { route: "model-openai", observedModel: "gpt-6.1-sol" }),
			requestFixture(1),
			replyFixture(1),
		]),
	],
	[
		"malformed and truncated",
		`not json\n${journalText([requestFixture(1), replyFixture(1)])}\n{"kind":"result"`,
	],
	[
		"invalid counts",
		journalText([
			requestFixture(1),
			replyFixture(1, { inputTokens: -1, outputTokens: "5" }),
		]),
	],
	[
		"invalid model evidence",
		journalText([replyFixture(1, { observedModel: null })]),
	],
] as const;

export function legacyFamily(input: {
	readonly journal: string | null;
	readonly requested: string;
	readonly superseded: string | null;
}): FamilyInput {
	const missing: FamilyInput = { kind: "unavailable", reason: "missing" };

	if (input.journal === null) return missing;
	const anthropic = input.requested.startsWith("anthropic/");
	const route = anthropic
		? "model-anthropic"
		: input.requested.startsWith("openai/")
			? "model-openai"
			: null;

	if (
		route === null ||
		(anthropic && parseAnthropicModel(input.requested) === null)
	)
		return { kind: "unavailable", reason: "unknown-model" };
	const dispatched = new Set<number>();
	const settled = new Map<number, Record<string, JsonValue>>();
	let mixed = false;

	for (const line of input.journal.split("\n")) {
		const record = objectOf(parseJson(line));
		const req = countOf(fieldOf(record, "req"));
		const at = textOf(fieldOf(record, "route"));
		const kind = fieldOf(record, "kind");

		if (record === null || req === null || at === null) continue;

		if (at !== route) {
			if (at !== input.superseded) mixed = true;
			continue;
		}

		if (kind === "dispatch") dispatched.add(req);
		else if (kind === "result" && !settled.has(req)) settled.set(req, record);
	}

	if (mixed) return { kind: "unavailable", reason: "mixed" };
	let model: string | null = null;
	let metered = 0;

	if (anthropic && [...dispatched].some((req) => !settled.has(req)))
		return { kind: "unavailable", reason: "unmetered" };

	for (const record of settled.values()) {
		if (fieldOf(record, "reason") === "provider_rejected") continue;
		const tokens =
			countOf(fieldOf(record, "inputTokens")) !== null &&
			countOf(fieldOf(record, "outputTokens")) !== null;
		const stated = fieldOf(record, "observedModel");

		if (!anthropic) {
			if (
				stated !== undefined &&
				stated !== input.requested &&
				stated !== input.requested.slice("openai/".length)
			)
				return { kind: "unavailable", reason: "unknown-model" };

			if (tokens) metered += 1;
			continue;
		}

		if (!tokens) return { kind: "unavailable", reason: "unmetered" };
		const observed = textOf(stated);

		if (observed === null || !isAnthropicModelId(observed))
			return { kind: "unavailable", reason: "unknown-model" };
		model = observed;
		metered += 1;
	}

	if (metered === 0) return missing;

	return anthropic && model !== null
		? { kind: "anthropic-gateway", model }
		: { kind: "openai-request", model: input.requested };
}

export function assertReaderParity(journal: string): void {
	assert.deepEqual(journalCharge(journal), legacyCharge(journal));

	for (const requested of ["anthropic/claude-sonnet-5-5", "openai/gpt-6.1-sol"])
		for (const superseded of [null, "model-anthropic", "model-openai"]) {
			const input = { journal, requested, superseded };
			assert.deepEqual(familyFromJournal(input), legacyFamily(input));
		}
}
