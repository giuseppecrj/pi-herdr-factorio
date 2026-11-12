import { digestOf, isDigest, runIdOf, type Digest } from "../core/run.ts";
import {
	EFFICIENCY_COUNTS,
	unknownEfficiency,
	type EfficiencyFacts,
} from "../core/execution.ts";
import { VISIBLE_CHECKS } from "../candidate/diagnosis.ts";
import { STAGE_ORDER } from "../core/stages.ts";
import { isGitSha, type GitSha } from "../config/schema.ts";
import { isRepoSlug } from "../trust/platform.ts";
import {
	arrayOf,
	countOf,
	fieldOf,
	hasDuplicateKey,
	objectOf,
	parseJson,
	textOf,
	type JsonValue,
} from "../core/json.ts";

export class LedgerRowError extends Error {
	readonly code: string;
	constructor(code: string) {
		super(code);
		this.code = code;
	}
}

export const fail = (code: string): never => {
	throw new LedgerRowError(code);
};

type Codec<T> = (value: JsonValue | undefined) => T;

export type Out<C> = C extends Codec<infer T> ? T : never;

type Fields = Readonly<Record<string, Codec<JsonValue>>>;

type Decoded<F extends Fields> = { readonly [K in keyof F]: Out<F[K]> };

type JsonRecord = { [key: string]: JsonValue };

export function record<F extends Fields>(fields: F): Codec<Decoded<F>> {
	const keys = Object.keys(fields);

	return (value) => {
		const input = objectOf(value) ?? fail("invalid_object");
		const present = Object.keys(input);

		if (
			present.length !== keys.length ||
			present.some((key) => !keys.includes(key))
		)
			fail("unexpected_keys");
		const output: JsonRecord = {};

		for (const key of keys) {
			const codec = fields[key];

			if (codec === undefined || !Object.hasOwn(input, key))
				return fail("missing_key");
			output[key] = codec(input[key]);
		}

		// SAFETY: every key of `fields` was decoded by its own codec, in order.
		return output as Decoded<F>;
	};
}

type Variants = Readonly<Record<string, Fields>>;

type Tagged<V extends Variants> = {
	[K in keyof V & string]: { readonly kind: K } & Decoded<V[K]>;
}[keyof V & string];

function tagged<V extends Variants>(variants: V): Codec<Tagged<V>> {
	const codecs = new Map<string, Codec<JsonValue>>();

	for (const [kind, fields] of Object.entries(variants))
		codecs.set(kind, record({ kind: literal(kind), ...fields }));

	return (value) => {
		const kind = textOf(fieldOf(objectOf(value), "kind"));
		const codec = kind === null ? undefined : codecs.get(kind);

		if (codec === undefined) return fail("invalid_kind");

		// SAFETY: the variant codec checked `kind` and every field of that variant.
		return codec(value) as Tagged<V>;
	};
}

export function literal<T extends string | number>(expected: T): Codec<T> {
	return (value) => (value === expected ? expected : fail("invalid_literal"));
}

export function oneOf<T extends string | number>(
	...values: readonly T[]
): Codec<T> {
	return (value) =>
		values.find((item) => item === value) ?? fail("invalid_enum");
}

function text<T extends string>(
	test: (input: string) => input is T,
	code: string,
): Codec<T> {
	return (value) => {
		const input = textOf(value);

		return input !== null && test(input) ? input : fail(code);
	};
}

export function nullable<T extends JsonValue>(
	codec: Codec<T>,
): Codec<T | null> {
	return (value) => (value === null ? null : codec(value));
}

function list<T extends JsonValue>(codec: Codec<T>, min = 0): Codec<T[]> {
	return (value) => {
		const items = arrayOf(value) ?? fail("invalid_list");

		if (items.length < min) fail("list_too_short");

		return items.map((item) => codec(item));
	};
}

export const count: Codec<number> = (value) =>
	countOf(value) ?? fail("invalid_count");

export const positive: Codec<number> = (value) => {
	const number = countOf(value);

	return number !== null && number > 0 ? number : fail("invalid_count");
};

export const flag: Codec<boolean> = (value) =>
	value === true || value === false ? value : fail("invalid_bool");

const INSTANT = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{3})?Z$/;

function isInstant(input: string): input is string {
	if (!INSTANT.test(input)) return false;
	const time = Date.parse(input);

	if (!Number.isFinite(time)) return false;
	const iso = new Date(time).toISOString();

	return iso === input || iso === input.replace("Z", ".000Z");
}

const VERSION = /^[0-9A-Za-z][0-9A-Za-z.+_-]{0,63}$/;
const MODEL_ID = /^([a-z0-9][a-z0-9-]*)\/([A-Za-z0-9][A-Za-z0-9._:-]*)$/;
const EVENT_ID = /^[1-9][0-9]{0,19}$/;
const URL_TEXT = /^https:\/\/github\.com\/[A-Za-z0-9_./-]+$/;

export const digest = text(isDigest, "invalid_digest");
export const sha = text(isGitSha, "invalid_sha");
const instant = text(isInstant, "invalid_instant");
const repoSlug = text(isRepoSlug, "invalid_repo");

const pattern = (expression: RegExp, code: string) =>
	text((input: string): input is string => expression.test(input), code);

const version = pattern(VERSION, "invalid_version");
const modelId = pattern(MODEL_ID, "invalid_model");
const eventId = pattern(EVENT_ID, "invalid_event");
const url = pattern(URL_TEXT, "invalid_url");

export const GAP_CODES = [
	"legacy_not_recorded",
	"receipt_missing",
	"receipt_invalid",
	"request_unsettled",
	"provider_not_reported",
	"public_metadata_unavailable",
	"not_instrumented",
] as const;

export type GapCode = (typeof GAP_CODES)[number];

const gap = oneOf(...GAP_CODES);

function fact<T extends JsonValue>(codec: Codec<T>) {
	return tagged({ known: { value: codec }, unavailable: { reason: gap } });
}

function measured<U extends "tokens" | "milliseconds">(unit: U) {
	return tagged({
		exact: { unit: literal(unit), total: count },
		lower_bound: { unit: literal(unit), total: count, reason: gap },
		uncertain: {
			unit: literal(unit),
			total: count,
			reason: literal("request_unsettled"),
		},
	});
}

const tokens = measured("tokens");
const milliseconds = measured("milliseconds");

const stage = oneOf(...STAGE_ORDER);

const money = tagged({
	known: { currency: literal("USD"), micros: count },
	unavailable: { reason: oneOf("provider_not_reported", "receipt_missing") },
});

const policy = record({
	workflowSha: sha,
	workflowDigest: digest,
	gates: fact(record({ sourceSha: sha, digest })),
	autonomy: record({
		approveMerge: literal("always"),
		land: literal("propose"),
		digest,
	}),
});

const unavailableCap = record({ kind: literal("unavailable"), reason: gap });

/** A run token cap, or why it was not recorded. Older rows hold only numbers. */
export type RunCap = number | Out<typeof unavailableCap>;

export function isKnownCap(cap: RunCap): cap is number {
	return !(cap instanceof Object);
}

const runCap: Codec<RunCap> = (value) =>
	objectOf(value) === null ? positive(value) : unavailableCap(value);

export type RunPolicy = Out<typeof policy>;

export type VerificationContextPin = {
	readonly digest: Digest;
	readonly tokenCap: number;
};

const contextCodec = tagged({
	production: { policy, trustedCap: positive },
	verification: {
		policy,
		trustedCap: positive,
		manifestDigest: digest,
		effectiveCap: positive,
	},
	legacy: {
		known: record({
			workflowSha: sha,
			workflowDigest: digest,
			policy: nullable(policy),
			trustedCap: runCap,
			verification: nullable(
				record({ manifestDigest: digest, effectiveCap: runCap }),
			),
		}),
		gaps: list(gap, 1),
	},
});

/** Admission identity, not the policy used by any later attempt. */
export type RunContextV2 = Out<typeof contextCodec>;

export function contextPolicy(context: RunContextV2): RunPolicy | null {
	return context.kind === "legacy" ? context.known.policy : context.policy;
}

/** Compatibility facts only. Neither a workflow load nor a candidate cap fills gaps. */
export function legacyRunContext(
	input: {
		readonly workflowSha: GitSha;
		readonly workflowDigest: Digest;
		readonly policy?: RunPolicy;
		readonly trustedCap?: number;
		readonly verification?: VerificationContextPin | null;
	},
	reason: GapCode,
): Extract<RunContextV2, { kind: "legacy" }> {
	const missing = { kind: "unavailable", reason } as const;

	return {
		kind: "legacy",
		known: {
			workflowSha: input.workflowSha,
			workflowDigest: input.workflowDigest,
			policy: input.policy ?? null,
			trustedCap: input.trustedCap ?? missing,
			verification:
				input.verification == null
					? null
					: {
							manifestDigest: input.verification.digest,
							effectiveCap:
								input.trustedCap === undefined
									? missing
									: Math.min(input.trustedCap, input.verification.tokenCap),
						},
		},
		gaps: [reason],
	};
}

export const runContext: Codec<RunContextV2> = (value) => {
	const context = contextCodec(value);
	const pinned = contextPolicy(context);

	if (
		pinned !== null &&
		((pinned.gates.kind === "known" &&
			pinned.gates.value.sourceSha !== pinned.workflowSha) ||
			pinned.autonomy.digest !== AUTONOMY_DIGEST)
	)
		fail("policy_binding");

	if (
		context.kind === "verification" &&
		context.effectiveCap > context.trustedCap
	)
		fail("verification_cap_raised");

	if (
		context.kind === "legacy" &&
		pinned !== null &&
		(pinned.workflowSha !== context.known.workflowSha ||
			pinned.workflowDigest !== context.known.workflowDigest)
	)
		fail("policy_binding");

	return context;
};

const legacyStartFields = {
	v: literal(1),
	runId: digest,
	startedAt: instant,
	policy,
};

const legacyStartCodec = record(legacyStartFields);

const cappedLegacyStartCodec = record({
	...legacyStartFields,
	runTokenCap: positive,
});

const runStartCodec = record({
	v: literal(2),
	runId: digest,
	startedAt: instant,
	context: runContext,
});

export type RunStart = Out<typeof runStartCodec>;

export type RunStartRecord =
	| RunStart
	| (Out<typeof legacyStartCodec> & {
			readonly runTokenCap?: number;
	  });

/** Old pins are decoded as Legacy; their on-disk bytes are never upgraded. */
export function parseRunStart(
	value: JsonValue | undefined,
	verification?: VerificationContextPin | null,
): RunStart | null {
	try {
		if (fieldOf(objectOf(value), "v") === 2) return runStartCodec(value);

		const start: Exclude<RunStartRecord, RunStart> = Object.hasOwn(
			objectOf(value) ?? {},
			"runTokenCap",
		)
			? cappedLegacyStartCodec(value)
			: legacyStartCodec(value);

		const context = legacyRunContext(
			{
				...start.policy,
				policy: start.policy,
				trustedCap: start.runTokenCap,
				verification,
			},
			"legacy_not_recorded",
		);

		return runStartCodec({
			v: 2,
			runId: start.runId,
			startedAt: start.startedAt,
			context,
		});
	} catch (error) {
		if (error instanceof LedgerRowError) return null;
		throw error;
	}
}

const provenance = tagged({
	production: { policy },
	verification: {
		policy,
		verificationDigest: digest,
		trustedRunTokenCap: runCap,
		effectiveRunTokenCap: runCap,
	},
	legacy_import: {
		workflowSha: sha,
		workflowDigest: digest,
		gates: fact(record({ sourceSha: sha, digest })),
		autonomy: fact(
			record({
				approveMerge: literal("always"),
				land: literal("propose"),
				digest,
			}),
		),
	},
});

/**
 * Why a run stopped, by class. `budget` reasons are the exhausted cap; the
 * diagnosis classes carry the `src/candidate/diagnosis.ts` reason; `base` carries the
 * base refusal reason. Version 1 rows never hold the four later causes.
 */
export const FAILURE_CLASSES = [
	"budget",
	"attempts",
	"input",
	"base",
	"provider",
	"label",
	"candidate",
	"oracle",
	"infrastructure",
	"missing_evidence",
	"review",
	"handoff",
] as const;

export type FailureClassName = (typeof FAILURE_CLASSES)[number];

export const BUDGET_CAPS = [
	"run_tokens",
	"stage_tokens",
	"round_tokens",
	"wall",
	"turns",
] as const;

export type BudgetCapName = (typeof BUDGET_CAPS)[number];

export const REASON = /^[a-z][a-z0-9_]{0,63}$/;

const outcomeFields = {
	needs_info: { stage },
	released: { stage },
	cancelled: { stage, reason: fact(oneOf("closed", "withdrawn")) },
	failed: {
		stage,
		cause: fact(
			oneOf(
				"attempts_exhausted",
				"input_refused",
				"base_refused",
				"candidate_failed",
				"evidence_missing",
				"label_write_failed",
				"provider_refused",
				"oracle_invalid",
				"infrastructure_failed",
				"review_failed",
				"handoff_stopped",
			),
		),
	},
	budget_exhausted: {
		stage,
		cap: fact(oneOf(...BUDGET_CAPS)),
	},
	stage_passed: { stage },
	landed: {
		stage: literal("land"),
		headSha: sha,
		mergeSha: sha,
		mergedAt: fact(instant),
		assurance: tagged({
			factory_verified: { generationDigest: digest },
			owner_override: {},
		}),
	},
};

export const outcome = tagged(outcomeFields);

const generation = record({
	round: oneOf(0, 1, 2),
	generation: oneOf(0, 1, 2, 3),
	intentDigest: digest,
	baseSha: sha,
	patchDigest: digest,
	heldoutDigest: fact(digest),
	candidateSha: fact(sha),
	gateSha: fact(sha),
	gatesDigest: fact(digest),
	ciRunId: fact(positive),
});

const artifacts = tagged({
	admission: {},
	contract: { contractDigest: digest },
	acceptance: { contractDigest: digest, acceptanceDigest: digest },
	built: {
		contractDigest: digest,
		acceptanceDigest: digest,
		patchDigest: digest,
	},
	candidate: {
		contractDigest: digest,
		acceptanceDigest: digest,
		generations: list(generation, 1),
	},
	pre_build_stop: {
		contractDigest: fact(digest),
		acceptanceDigest: fact(digest),
	},
});

const attempts = record({
	passed: count,
	failed: count,
	interrupted: count,
	refused: count,
	budgetExhausted: count,
	aborted: count,
});

const stageSummaryFields = {
	stage,
	wallMs: milliseconds,
	attempts: fact(attempts),
	tokens,
};

const stageSummary = record(stageSummaryFields);

const efficiencyCodec: Codec<EfficiencyFacts> = (value) => {
	const input = objectOf(value) ?? fail("invalid_object");

	if (Object.keys(input).length !== EFFICIENCY_COUNTS.length)
		fail("unexpected_keys");
	const facts = { ...unknownEfficiency() };

	for (const key of EFFICIENCY_COUNTS) facts[key] = nullable(count)(input[key]);

	return facts;
};

const modelSummary = record({
	requested: modelId,
	observed: fact(
		pattern(
			/^([a-z0-9][a-z0-9-]*\/)?[A-Za-z0-9][A-Za-z0-9._:-]*$/,
			"invalid_observed_model",
		),
	),
	providerVersion: record({
		kind: literal("unavailable"),
		reason: literal("provider_not_reported"),
	}),
	runtime: fact(
		record({
			pi: version,
			agents: version,
			pstack: version,
			assetsDigest: digest,
		}),
	),
	executions: count,
});

export function ledgerModelOf(
	value: JsonValue | undefined,
): Out<typeof modelSummary> | null {
	try {
		return modelSummary(value);
	} catch (error) {
		if (error instanceof LedgerRowError) return null;
		throw error;
	}
}

const sharedFields = {
	runId: digest,
	repo: repoSlug,
	issue: positive,
	eventId,
	eventAt: instant,
	previousRunId: fact(nullable(digest)),
	snapshotDigest: digest,
	originalBase: sha,
	startedAt: fact(instant),
	terminalObservedAt: instant,
	provenance,
	terminalMarker: record({ seq: positive, digest }),
	outcome,
	pr: nullable(record({ number: positive, url })),
	artifacts,
	repairRounds: fact(
		record({ authorized: count, started: count, completed: count }),
	),
	stages: fact(list(stageSummary)),
	models: fact(list(modelSummary)),
	usage: record({
		tokens,
		parentTokens: fact(count),
		childTokens: fact(count),
		unattributedTokens: fact(count),
		money,
	}),
	interruptedAttempts: fact(count),
	contextPressure: fact(record({ truncated: flag, promptCapHit: flag })),
	redactedReceiptDigests: list(digest),
	evidence: record({ issueUrl: url, ciUrls: list(url) }),
};

const rowCodec = record({ v: literal(1), ...sharedFields, gaps: list(gap) });

export const failureFact = fact(
	record({
		stage,
		class: oneOf(...FAILURE_CLASSES),
		reason: pattern(REASON, "invalid_reason"),
		failedVisibleChecks: list(oneOf(...VISIBLE_CHECKS)),
		retainedPatch: nullable(digest),
	}),
);

export const ACCEPT_DISPOSITIONS = [
	"model_failed",
	"model_refused",
	"budget_stopped",
	"interrupted",
	"aborted",
	"base_refused",
	"retried",
	"suite_qualified",
] as const;

/**
 * Version 2 adds the stop's cause (`null` unless the run failed or spent a
 * budget) and each accept attempt's final disposition. Version 1 rows parse
 * and freeze exactly as they were written.
 */
const rowV2Codec = record({
	v: literal(2),
	...sharedFields,
	failure: nullable(failureFact),
	acceptAttempts: fact(
		list(
			record({ attempt: positive, disposition: oneOf(...ACCEPT_DISPOSITIONS) }),
		),
	),
	gaps: list(gap),
});

const rowV3Codec = record({
	v: literal(3),
	...sharedFields,
	stages: fact(
		list(record({ ...stageSummaryFields, efficiency: efficiencyCodec })),
	),
	failure: nullable(failureFact),
	acceptAttempts: fact(
		list(
			record({ attempt: positive, disposition: oneOf(...ACCEPT_DISPOSITIONS) }),
		),
	),
	efficiency: efficiencyCodec,
	gaps: list(gap),
});

const rowV4Fields = {
	v: literal(4),
	...sharedFields,
	runContext,
	terminalWorkflowObservation: fact(
		record({ workflowSha: sha, workflowDigest: digest }),
	),
	stages: fact(
		list(record({ ...stageSummaryFields, efficiency: efficiencyCodec })),
	),
	failure: nullable(failureFact),
	acceptAttempts: fact(
		list(
			record({ attempt: positive, disposition: oneOf(...ACCEPT_DISPOSITIONS) }),
		),
	),
	efficiency: efficiencyCodec,
	gaps: list(gap),
};

const rowV4Codec = record(rowV4Fields);

const rowV5Codec = record({
	...rowV4Fields,
	v: literal(5),
	outcome: tagged({
		...outcomeFields,
		landed: {
			...outcomeFields.landed,
			assurance: tagged({
				factory_verified: {
					generationDigest: digest,
					authored: oneOf("factory", "owner"),
				},
				owner_override: {},
			}),
		},
	}),
});

export type LedgerRowV1 = Out<typeof rowCodec>;

export type LedgerRowV2 = Out<typeof rowV2Codec>;

export type LedgerRowV3 = Out<typeof rowV3Codec>;

export type LedgerRowV4 = Out<typeof rowV4Codec>;

export type LedgerRowV5 = Out<typeof rowV5Codec>;

export type LedgerRow =
	| LedgerRowV1
	| LedgerRowV2
	| LedgerRowV3
	| LedgerRowV4
	| LedgerRowV5;

/** Old immutable rows expose unknown facts without adding fields to their bytes. */
export function ledgerEfficiency(row: LedgerRow): EfficiencyFacts {
	return row.v === 1 || row.v === 2 ? unknownEfficiency() : row.efficiency;
}

export type LedgerRowInput =
	| Omit<LedgerRowV1, "gaps">
	| Omit<LedgerRowV2, "gaps">
	| Omit<LedgerRowV3, "gaps">
	| Omit<LedgerRowV4, "gaps">
	| Omit<LedgerRowV5, "gaps">;

const codecOf = (value: JsonValue): Codec<LedgerRow> =>
	fieldOf(objectOf(value), "v") === 5
		? rowV5Codec
		: fieldOf(objectOf(value), "v") === 4
			? rowV4Codec
			: fieldOf(objectOf(value), "v") === 3
				? rowV3Codec
				: fieldOf(objectOf(value), "v") === 2
					? rowV2Codec
					: rowCodec;

export type LedgerOutcome = LedgerRow["outcome"];

function gapsOf(value: JsonValue, into: Set<GapCode>): Set<GapCode> {
	const items = arrayOf(value);

	if (items !== null) {
		for (const item of items) gapsOf(item, into);

		return into;
	}

	const object = objectOf(value);

	if (object === null) return into;
	const kind = textOf(fieldOf(object, "kind"));
	const reason = GAP_CODES.find((code) => code === fieldOf(object, "reason"));

	if (
		(kind === "unavailable" ||
			kind === "lower_bound" ||
			kind === "uncertain") &&
		reason !== undefined
	)
		into.add(reason);

	if (kind === "legacy")
		for (const code of GAP_CODES)
			if (arrayOf(object.gaps)?.includes(code)) into.add(code);

	for (const [key, item] of Object.entries(object))
		if (key !== "gaps") gapsOf(item, into);

	return into;
}

const sorted = (items: readonly string[]) =>
	items.every((item, at) => at === 0 || (items[at - 1] ?? "") < item);

function invariant(row: LedgerRow): string | null {
	const base = `https://github.com/${row.repo}`;

	if (row.runId !== runIdOf(row)) return "run_id_mismatch";

	if (row.evidence.issueUrl !== `${base}/issues/${row.issue}`)
		return "issue_url_mismatch";

	if (row.pr !== null && row.pr.url !== `${base}/pull/${row.pr.number}`)
		return "pr_url_mismatch";

	if (
		!row.evidence.ciUrls.every((ci) =>
			/^\/actions\/runs\/[1-9][0-9]*$/.test(ci.slice(base.length)),
		) ||
		!row.evidence.ciUrls.every((ci) => ci.startsWith(`${base}/`)) ||
		!sorted(row.evidence.ciUrls)
	)
		return "ci_url_invalid";

	if (row.outcome.kind === "landed") {
		if (row.pr === null || row.artifacts.kind !== "candidate")
			return "landing_incomplete";
		const assurance = row.outcome.assurance;
		const head = row.outcome.headSha;

		if (
			assurance.kind === "factory_verified" &&
			!row.artifacts.generations.some(
				(item) =>
					item.intentDigest === assurance.generationDigest &&
					item.candidateSha.kind === "known" &&
					item.candidateSha.value === head,
			)
		)
			return "landing_unverified";
	}

	if (
		(row.v === 4 || row.v === 5) &&
		JSON.stringify(row.provenance) !==
			JSON.stringify(provenance(provenanceOf(row.runContext)))
	)
		return "context_provenance_mismatch";

	if (row.provenance.kind === "verification") {
		const { trustedRunTokenCap: trusted, effectiveRunTokenCap: effective } =
			row.provenance;

		if (isKnownCap(trusted) && isKnownCap(effective) && effective > trusted)
			return "verification_cap_raised";
	}

	const stages = row.stages.kind === "known" ? row.stages.value : [];
	const order = stages.map((item) => STAGE_ORDER.indexOf(item.stage));

	if (!order.every((at, index) => index === 0 || (order[index - 1] ?? 0) < at))
		return "stages_unordered";

	const interrupted = stages.map((item) =>
		item.attempts.kind === "known" ? item.attempts.value.interrupted : null,
	);

	if (
		row.interruptedAttempts.kind === "known" &&
		row.stages.kind === "known" &&
		interrupted.every((item) => item !== null) &&
		interrupted.reduce((sum, item) => sum + item, 0) !==
			row.interruptedAttempts.value
	)
		return "interrupted_mismatch";
	const usage = row.usage;

	const parts = [
		usage.parentTokens,
		usage.childTokens,
		usage.unattributedTokens,
	];

	if (
		usage.tokens.kind === "exact" &&
		parts.every((part) => part.kind === "known") &&
		parts.reduce(
			(sum, part) => sum + (part.kind === "known" ? part.value : 0),
			0,
		) !== usage.tokens.total
	)
		return "usage_parts_mismatch";

	if (
		stages.reduce((sum, item) => sum + item.tokens.total, 0) >
		usage.tokens.total
	)
		return "stage_tokens_exceed_run";

	const models = (row.models.kind === "known" ? row.models.value : []).map(
		(item) => JSON.stringify([item.requested, item.observed, item.runtime]),
	);

	if (!sorted(models)) return "models_unsorted";

	if (!sorted(row.redactedReceiptDigests)) return "receipts_unsorted";

	if (row.v !== 1) {
		const stopped =
			row.outcome.kind === "failed" || row.outcome.kind === "budget_exhausted";

		if (stopped !== (row.failure !== null)) return "failure_mismatch";

		if (row.failure?.kind === "known") {
			const cause = row.failure.value;
			const budget = row.outcome.kind === "budget_exhausted";

			const order = cause.failedVisibleChecks.map((n) =>
				VISIBLE_CHECKS.indexOf(n),
			);

			if (
				(cause.class === "budget") !== budget ||
				(budget && !BUDGET_CAPS.some((cap) => cap === cause.reason)) ||
				!order.every((at, index) => index === 0 || (order[index - 1] ?? 0) < at)
			)
				return "failure_mismatch";
		}

		const accepts =
			row.acceptAttempts.kind === "known" ? row.acceptAttempts.value : [];

		if (
			!accepts.every(
				(item, at) =>
					at === 0 || (accepts[at - 1]?.attempt ?? 0) < item.attempt,
			)
		)
			return "accept_attempts_unordered";
	}

	const gaps = [...gapsOf(row, new Set())].sort();

	if (JSON.stringify(gaps) !== JSON.stringify(row.gaps)) return "gaps_mismatch";

	return null;
}

export type FrozenRow = {
	readonly row: LedgerRow;
	readonly bytes: Buffer;
	readonly digest: Digest;
};

function frozen(canonical: LedgerRow): FrozenRow {
	const problem = invariant(canonical);

	if (problem !== null) fail(problem);
	const bytes = Buffer.from(`${JSON.stringify(canonical)}\n`);

	return { row: canonical, bytes, digest: digestOf(bytes) };
}

/** Builds the one canonical row for a terminal run. Gaps are derived, never supplied. */
export function ledgerRow(input: LedgerRowInput): FrozenRow {
	return ledgerRowOf(input);
}

/** Builds a row from untyped stored input, such as a frozen terminal snapshot. */
export function ledgerRowOf(input: JsonValue): FrozenRow {
	const fields = objectOf(input) ?? fail("invalid_object");
	const codec = codecOf(input);
	const canonical = codec({ ...fields, gaps: [] });
	const gaps = [...gapsOf(canonical, new Set())].sort();

	return frozen(codec({ ...canonical, gaps }));
}

export type LedgerLine =
	| {
			readonly kind: "known";
			readonly row: LedgerRow;
			readonly bytes: Buffer;
			readonly digest: Digest;
	  }
	| { readonly kind: "unknown_version"; readonly bytes: Buffer }
	| { readonly kind: "corrupt"; readonly bytes: Buffer; readonly code: string };

const utf8 = new TextDecoder("utf-8", { fatal: true });

function lineOf(bytes: Buffer): LedgerLine {
	if (bytes.at(-1) !== 0x0a)
		return { kind: "corrupt", bytes, code: "missing_lf" };
	let body: string;

	try {
		body = utf8.decode(bytes.subarray(0, -1));
	} catch {
		return { kind: "corrupt", bytes, code: "invalid_utf8" };
	}

	const value = parseJson(body);

	if (value === undefined || hasDuplicateKey(body))
		return { kind: "corrupt", bytes, code: "malformed_json" };
	const v = countOf(fieldOf(objectOf(value), "v"));

	if (v === null) return { kind: "corrupt", bytes, code: "missing_version" };

	if (v !== 1 && v !== 2 && v !== 3 && v !== 4 && v !== 5)
		return { kind: "unknown_version", bytes };

	try {
		const row = frozen(codecOf(value)(value));

		return row.bytes.equals(bytes)
			? { kind: "known", ...row, bytes }
			: { kind: "corrupt", bytes, code: "noncanonical" };
	} catch (error) {
		if (error instanceof LedgerRowError)
			return { kind: "corrupt", bytes, code: error.code };
		throw error;
	}
}

/** Splits ledger bytes into lines, each kept byte-for-byte with its diagnosis. */
export function parseLedger(bytes: Uint8Array): LedgerLine[] {
	const buffer = Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength);
	const lines: LedgerLine[] = [];
	let start = 0;

	while (start < buffer.length) {
		const end = buffer.indexOf(0x0a, start);
		const stop = end === -1 ? buffer.length : end + 1;
		lines.push(lineOf(buffer.subarray(start, stop)));
		start = stop;
	}

	return lines;
}

export type LedgerErrorCode =
	| "state_unwritable"
	| "transport_unavailable"
	| "row_conflict"
	| "ledger_corrupt"
	| "ledger_version_unsupported"
	| "ledger_contended"
	| "lineage_changed"
	| "ref_missing"
	| "object_mismatch"
	| "adoption_pending"
	| "state_invalid"
	| "row_invalid";

export type LedgerIndex =
	| {
			readonly kind: "indexed";
			readonly rows: ReadonlyMap<Digest, { digest: Digest; line: number }>;
	  }
	| {
			readonly kind: "blocked";
			readonly reason: LedgerErrorCode;
			readonly line: number;
	  };

/** Indexes parsed rows by run ID. Any unknown, corrupt or repeated row blocks the writer. */
export function indexLedger(lines: readonly LedgerLine[]): LedgerIndex {
	const rows = new Map<Digest, { digest: Digest; line: number }>();

	for (const [at, line] of lines.entries()) {
		const number = at + 1;

		if (line.kind === "unknown_version")
			return {
				kind: "blocked",
				reason: "ledger_version_unsupported",
				line: number,
			};

		if (line.kind === "corrupt")
			return { kind: "blocked", reason: "ledger_corrupt", line: number };

		if (rows.has(line.row.runId))
			return { kind: "blocked", reason: "row_conflict", line: number };
		rows.set(line.row.runId, { digest: line.digest, line: number });
	}

	return { kind: "indexed", rows };
}

const scoreNumber: Codec<number> = (value) => {
	const number = Number(value);

	return value === number &&
		Number.isFinite(number) &&
		number >= 0 &&
		number <= 1
		? number
		: fail("invalid_score");
};

const scoreText =
	(max: number): Codec<string> =>
	(value) => {
		const text = textOf(value);

		return text !== null &&
			Buffer.byteLength(text) <= max &&
			![...text].some(
				(c) =>
					(c.charCodeAt(0) < 32 && c !== "\n" && c !== "\t") ||
					(c.charCodeAt(0) >= 127 && c.charCodeAt(0) <= 159),
			)
			? text
			: fail("invalid_score_text");
	};

const scoreCodec = record({
	id: digest,
	scoredRunId: digest,
	scorerId: pattern(/^[a-z][a-z0-9-]{0,63}$/, "invalid_scorer"),
	scorerDigest: digest,
	inputDigest: digest,
	includeChildren: flag,
	label: nullable(scoreText(64)),
	score: nullable(scoreNumber),
	passingScore: scoreNumber,
	reasoning: scoreText(4096),
	judgeModel: pattern(MODEL_ID, "invalid_model"),
	judgeFamily: literal("openai"),
	familyNote: literal("context-isolated, same family, not cross-family"),
	usage: record({ tokens: count, wallMs: count, exact: flag }),
	supersedes: nullable(digest),
	at: instant,
	status: oneOf("scored", "failed", "voided"),
	voided: nullable(literal("scorer_touched")),
});

export type ScoreEvent = Out<typeof scoreCodec>;

export function scoreEventOf(value: JsonValue | undefined): ScoreEvent | null {
	try {
		const event = scoreCodec(value);

		if (
			(event.status === "scored"
				? event.score === null || event.label === null
				: event.score !== null || event.label !== null) ||
			(event.status === "voided") !== (event.voided !== null)
		)
			return null;

		return event;
	} catch (error) {
		if (error instanceof LedgerRowError) return null;
		throw error;
	}
}

export function parseScores(bytes: Uint8Array): readonly ScoreEvent[] {
	const text = Buffer.from(bytes).toString("utf8");

	if (text !== "" && !text.endsWith("\n"))
		throw new LedgerRowError("ledger_corrupt");
	const events: ScoreEvent[] = [];
	const ids = new Set<string>();

	for (const line of text === "" ? [] : text.slice(0, -1).split("\n")) {
		const event = hasDuplicateKey(line) ? null : scoreEventOf(parseJson(line));

		if (event === null || ids.has(event.id))
			throw new LedgerRowError("ledger_corrupt");
		ids.add(event.id);
		events.push(event);
	}

	return events;
}

export function indexScores(bytes: Uint8Array): LedgerIndex {
	try {
		const events = parseScores(bytes);
		const lines = Buffer.from(bytes).toString("utf8").split("\n");

		return {
			kind: "indexed",
			rows: new Map(
				events.map((event, at) => [
					event.id,
					{ digest: digestOf(`${lines[at]}\n`), line: at + 1 },
				]),
			),
		};
	} catch (error) {
		if (error instanceof LedgerRowError)
			return { kind: "blocked", reason: "ledger_corrupt", line: 0 };
		throw error;
	}
}

export function latestScores(
	events: readonly ScoreEvent[],
): readonly ScoreEvent[] {
	const latest = new Map<string, ScoreEvent>();

	for (const event of events)
		latest.set(JSON.stringify([event.scoredRunId, event.scorerId]), event);

	return [...latest.values()];
}

/** Parses a pending row's exact bytes back into its frozen form. */
export function frozenRowOf(bytes: Buffer): FrozenRow | null {
	const [line, ...rest] = parseLedger(bytes);

	return line?.kind === "known" && rest.length === 0 ? line : null;
}

export const unavailable = (reason: GapCode) => ({
	kind: "unavailable",
	reason,
});

export const known = (value: JsonValue) => ({ kind: "known", value });

export const AUTONOMY_DIGEST = digestOf(
	JSON.stringify({ approveMerge: "always", land: "propose" }),
);

export function provenanceOf(context: RunContextV2): JsonValue {
	if (context.kind === "production")
		return { kind: "production", policy: context.policy };

	if (context.kind === "verification")
		return {
			kind: "verification",
			policy: context.policy,
			verificationDigest: context.manifestDigest,
			trustedRunTokenCap: context.trustedCap,
			effectiveRunTokenCap: context.effectiveCap,
		};

	const { known: old } = context;

	if (old.verification !== null && old.policy !== null)
		return {
			kind: "verification",
			policy: old.policy,
			verificationDigest: old.verification.manifestDigest,
			trustedRunTokenCap: old.trustedCap,
			effectiveRunTokenCap: old.verification.effectiveCap,
		};

	return {
		kind: "legacy_import",
		workflowSha: old.workflowSha,
		workflowDigest: old.workflowDigest,
		gates: old.policy?.gates ?? unavailable("receipt_missing"),
		autonomy:
			old.policy == null
				? unavailable("receipt_missing")
				: known(old.policy.autonomy),
	};
}

const attemptEndCodec = record({
	v: literal(1),
	runId: digest,
	stage,
	round: count,
	attempt: positive,
	disposition: oneOf(
		"completed",
		"model_failure",
		"interrupted",
		"refused",
		"budget_stop",
		"aborted",
		"base_refused",
	),
	usage: count,
	next: tagged({
		retry: { attempt: positive, dueAt: count },
		base_retry: { attempt: positive, dueAt: count },
		continue: {},
		end: {
			status: oneOf(
				"released",
				"failed",
				"budget_exhausted",
				"needs_info",
				"stage_passed",
				"landed",
				"cancelled",
			),
		},
	}),
});

export type AttemptEnd = Out<typeof attemptEndCodec>;

export function parseAttemptEnd(
	value: JsonValue | undefined,
): AttemptEnd | null {
	try {
		return attemptEndCodec(value);
	} catch (error) {
		if (error instanceof LedgerRowError) return null;
		throw error;
	}
}
