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
