import { requestSettlements, settlementReply } from "./journal.ts";
import { fieldOf, objectOf, textOf, type JsonValue } from "./json.ts";

/**
 * The Anthropic models the exe.dev integration listed on 2026-11-04, and the
 * maximum output tokens (`max_tokens`) each accepts. This is the only copy.
 * The gateway clamps `max_tokens` to it, because the edge returns 400 above
 * the maximum rather than clamping, and the journaled bound must be the
 * enforced one. A model with no entry is denied before any upstream call.
 * The sandbox cannot supply a cap, and no live catalog is read.
 */
export const ANTHROPIC_MODEL_IDS = [
	"claude-opus-5-5",
	"claude-opus-5",
	"claude-fable-5-1",
	"claude-fable-5",
	"claude-opus-4-8",
	"claude-opus-4-7",
	"claude-opus-4-5",
	"claude-sonnet-5-5",
	"claude-sonnet-5",
	"claude-sonnet-4-6",
	"claude-sonnet-4-5",
	"claude-haiku-5-5",
	"claude-haiku-4-5",
] as const;

export type AnthropicModelId = (typeof ANTHROPIC_MODEL_IDS)[number];

export const ANTHROPIC_MAX_OUTPUT_TOKENS: Readonly<
	Record<AnthropicModelId, number>
> = Object.freeze({
	"claude-opus-5-5": 128_000,
	"claude-opus-5": 128_000,
	"claude-fable-5-1": 128_000,
	"claude-fable-5": 128_000,
	"claude-opus-4-8": 128_000,
	"claude-opus-4-7": 128_000,
	"claude-opus-4-5": 64_000,
	"claude-sonnet-5-5": 128_000,
	"claude-sonnet-5": 128_000,
	"claude-sonnet-4-6": 128_000,
	// Deprecated 2026-09-30. Listed so a stale id is still clamped.
	"claude-sonnet-4-5": 64_000,
	"claude-haiku-5-5": 128_000,
	"claude-haiku-4-5": 64_000,
});

const PREFIX = "anthropic/";

/** True only for a bare id in the table, the form the edge reports back. */
export function isAnthropicModelId(text: string): text is AnthropicModelId {
	return ANTHROPIC_MODEL_IDS.some((id) => id === text);
}

/** The table id for `anthropic/<id>` or a bare `<id>`, or `null` when the table has no entry. */
export function parseAnthropicModel(text: string): AnthropicModelId | null {
	const bare = text.startsWith(PREFIX) ? text.slice(PREFIX.length) : text;

	return isAnthropicModelId(bare) ? bare : null;
}

/** The model's maximum output tokens, or `null` when the table has no entry. */
export function anthropicMaxOutput(text: string): number | null {
	const id = parseAnthropicModel(text);

	return id === null ? null : ANTHROPIC_MAX_OUTPUT_TOKENS[id];
}

/**
 * What the host saw of one author's model family, computed when it wrote
 * the stage or seat receipt. `anthropic-gateway` comes only from
 * `familyFromJournal`: a metered `model-anthropic` journal line whose
 * gateway-observed model is in the host's limits table. `openai-request`
 * is a host-recorded `openai/` request with at least one metered,
 * non-rejected line, all on `model-openai`. Anything else is `unavailable`,
 * never a family.
 */
export type FamilyInput =
	| { readonly kind: "anthropic-gateway"; readonly model: string }
	| { readonly kind: "openai-request"; readonly model: string }
	| {
			readonly kind: "unavailable";
			readonly reason: "missing" | "unknown-model" | "mixed" | "unmetered";
	  };

export type R8 = "complete" | "incomplete";

export type CertificationFamilies = {
	readonly builder: FamilyInput;
	readonly accept: FamilyInput;
	readonly seats: readonly {
		readonly seat: string;
		readonly evidence: FamilyInput;
	}[];
};

export const FAMILY_MISSING: FamilyInput = {
	kind: "unavailable",
	reason: "missing",
};

const UNAVAILABLE_REASONS = [
	"missing",
	"unknown-model",
	"mixed",
	"unmetered",
] as const;

/** The family, or `null`. A variant whose model breaks its own rule has none. */
export function familyOf(input: FamilyInput): "anthropic" | "openai" | null {
	switch (input.kind) {
		case "anthropic-gateway":
			return isAnthropicModelId(input.model) ? "anthropic" : null;
		case "openai-request":
			return input.model.startsWith("openai/") ? "openai" : null;
		case "unavailable":
			return null;
		default: {
			const exhaustive: never = input;

			return exhaustive;
		}
	}
}

/** True only for two known, different families. */
export function crossFamily(a: FamilyInput, b: FamilyInput): boolean {
	const left = familyOf(a);
	const right = familyOf(b);

	return left !== null && right !== null && left !== right;
}

/**
 * True only for the one direction R8 counts: a verified OpenAI builder and
 * a gateway-observed Anthropic author.
 */
function certifiedPair(builder: FamilyInput, author: FamilyInput): boolean {
	return familyOf(builder) === "openai" && familyOf(author) === "anthropic";
}

/**
 * `complete` only when the builder is a verified OpenAI family and the
 * gateway observed an Anthropic model on the accept author and on at least
 * one blocking seat (any seat but the advisory `simplify`). Every other
 * shape, an Anthropic builder included, is `incomplete`. Labels are never
 * an input.
 */
export function certifyR8(input: CertificationFamilies): R8 {
	const seatCross = input.seats.some(
		(seat) =>
			seat.seat !== "simplify" && certifiedPair(input.builder, seat.evidence),
	);

	return certifiedPair(input.builder, input.accept) && seatCross
		? "complete"
		: "incomplete";
}

/**
 * The only writer of a family label. Against a builder it says cross-family
 * only for an OpenAI builder and an Anthropic author, the pair `certifyR8`
 * counts. Two known, different families in any other direction say so and
 * stay not cross-family. Without a builder, as on an acceptance receipt
 * written before any build, it names the author's family and defers the
 * claim to certification.
 */
export function familyLabel(
	evidence: FamilyInput,
	builder?: FamilyInput,
): string {
	const family = familyOf(evidence);

	if (builder === undefined)
		return `context-isolated, ${family ?? "unknown"} author, family checked at certification`;

	if (certifiedPair(builder, evidence))
		return "context-isolated, different family, cross-family";

	if (crossFamily(builder, evidence))
		return "context-isolated, different family, builder not OpenAI, not cross-family";

	return family !== null && family === familyOf(builder)
		? "context-isolated, same family, not cross-family"
		: "context-isolated, unknown family, not cross-family";
}

/** `value` with `family` added when there is one; otherwise `value` itself, unchanged. */
export function withFamily<T extends object>(
	value: T,
	family: FamilyInput | null | undefined,
): T & { readonly family?: FamilyInput } {
	if (family === null || family === undefined) return value;

	return { ...value, family };
}

/**
 * Rebuilds a stored `FamilyInput`, or `null`. It checks shape only: an
 * `anthropic-gateway` model must be a bare id in the limits table, and an
 * `openai-request` model must start `openai/`. It does not prove the
 * evidence, and a hand-written receipt of that shape parses. What makes a
 * stored family trustworthy is where it lives: the host writes it from the
 * gateway journal with `familyFromJournal` into host-owned state outside
 * every stage mount. Certification then still requires the strict
 * `certifyR8` direction and binds the builder's model to the patch receipt.
 */
export function parseFamily(value: JsonValue | undefined): FamilyInput | null {
	const v = objectOf(value);
	const kind = textOf(fieldOf(v, "kind"));

	if (v === null || Object.keys(v).length !== 2) return null;

	if (kind === "unavailable") {
		const reason = UNAVAILABLE_REASONS.find(
			(known) => known === fieldOf(v, "reason"),
		);

		return reason === undefined ? null : { kind, reason };
	}

	const model = textOf(fieldOf(v, "model"));

	if (model === null) return null;

	if (kind === "anthropic-gateway")
		return isAnthropicModelId(model) ? { kind, model } : null;

	if (kind === "openai-request")
		return model.startsWith("openai/") ? { kind, model } : null;

	return null;
}

/**
 * The family of the session that answered one stage attempt, from that
 * attempt's request journal (`egress.requests.jsonl`) and the host-recorded
 * requested id of that session. Lines on `superseded`, the route of a
 * primary a fallback replaced, are ignored.
 *
 * Provider-rejected results are skipped on both routes. An `anthropic/`
 * request is `anthropic-gateway` only when every settled `model-anthropic`
 * result that was not provider-rejected is metered with a table model, and
 * at least one is. An `openai/` request is `openai-request` only when at
 * least one non-rejected `model-openai` line is metered, and any
 * `observedModel` on one is the requested id, bare or prefixed; another is
 * `unknown-model`. Any other route's line is `mixed`.
 */
export function familyFromJournal(input: {
	readonly journal: string | null;
	readonly requested: string;
	readonly superseded: string | null;
}): FamilyInput {
	if (input.journal === null) return FAMILY_MISSING;

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

	const journal = requestSettlements(input.journal, { route });

	if (journal.routes.some((at) => at !== route && at !== input.superseded))
		return { kind: "unavailable", reason: "mixed" };

	const requests = journal.requests.filter((request) => request.req !== null);
	let model: string | null = null;
	let metered = 0;

	if (
		anthropic &&
		requests.some(
			(request) => request.kind === "Uncertain" && request.result === null,
		)
	)
		return { kind: "unavailable", reason: "unmetered" };

	for (const request of requests) {
		const result = settlementReply(request);

		if (result === null || result.kind === "ProviderRejected") continue;

		const tokens = result.usage.kind === "metered";
		const stated = result.observedModel;

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

	if (metered === 0) return FAMILY_MISSING;

	return anthropic && model !== null
		? { kind: "anthropic-gateway", model }
		: { kind: "openai-request", model: input.requested };
}
