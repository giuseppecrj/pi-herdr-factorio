import { digestOf, isDigest, runIdOf, type Digest } from "./run.ts";
import {
	EFFICIENCY_COUNTS,
	unknownEfficiency,
	type EfficiencyFacts,
} from "../server/sandbox/result.ts";
import {
	GitHubPublicationApi,
	LEDGER_FILE,
	PublicationError,
	createLedgerChild,
	createLedgerRoot,
	readLedgerCommit,
	readLedgerFile,
	type LedgerAdvance,
	type LedgerCommit,
	type LedgerFile,
} from "./publication.ts";
import {
	authoredOf,
	candidateGenerations,
	type CandidateState,
} from "./handoff.ts";
import {
	VISIBLE_CHECKS,
	failedVisibleChecks,
	type FailureClass,
	type VisibleCheck,
} from "./diagnosis.ts";
import type { TerminalStatus } from "./markers.ts";
import type { Stage } from "./run.ts";
import {
	isGitSha,
	isRepoSlug,
	type GitSha,
	type RepoSlug,
} from "./workflow.ts";
import {
	arrayOf,
	countOf,
	fieldOf,
	hasDuplicateKey,
	objectOf,
	parseJson,
	textOf,
	type JsonValue,
} from "../server/sandbox/json.ts";

export class LedgerRowError extends Error {
	readonly code: string;
	constructor(code: string) {
		super(code);
		this.code = code;
	}
}

const fail = (code: string): never => {
	throw new LedgerRowError(code);
};

type Codec<T> = (value: JsonValue | undefined) => T;

type Out<C> = C extends Codec<infer T> ? T : never;

type Fields = Readonly<Record<string, Codec<JsonValue>>>;

type Decoded<F extends Fields> = { readonly [K in keyof F]: Out<F[K]> };

type JsonRecord = { [key: string]: JsonValue };

function record<F extends Fields>(fields: F): Codec<Decoded<F>> {
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

function literal<T extends string | number>(expected: T): Codec<T> {
	return (value) => (value === expected ? expected : fail("invalid_literal"));
}

function oneOf<T extends string | number>(...values: readonly T[]): Codec<T> {
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

function nullable<T extends JsonValue>(codec: Codec<T>): Codec<T | null> {
	return (value) => (value === null ? null : codec(value));
}

function list<T extends JsonValue>(codec: Codec<T>, min = 0): Codec<T[]> {
	return (value) => {
		const items = arrayOf(value) ?? fail("invalid_list");

		if (items.length < min) fail("list_too_short");

		return items.map((item) => codec(item));
	};
}

const count: Codec<number> = (value) => countOf(value) ?? fail("invalid_count");

const positive: Codec<number> = (value) => {
	const number = countOf(value);

	return number !== null && number > 0 ? number : fail("invalid_count");
};

const flag: Codec<boolean> = (value) =>
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

const digest = text(isDigest, "invalid_digest");
const sha = text(isGitSha, "invalid_sha");
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

const STAGES = [
	"admit",
	"specify",
	"accept",
	"build",
	"validate",
	"review",
	"land",
] as const;

const stage = oneOf(...STAGES);

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

const runContext: Codec<RunContextV2> = (value) => {
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
 * diagnosis classes carry the `src/diagnosis.ts` reason; `base` carries the
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

const CAUSES = {
	attempts: "attempts_exhausted",
	input: "input_refused",
	base: "base_refused",
	provider: "provider_refused",
	label: "label_write_failed",
	candidate: "candidate_failed",
	missing_evidence: "evidence_missing",
	oracle: "oracle_invalid",
	infrastructure: "infrastructure_failed",
	review: "review_failed",
	handoff: "handoff_stopped",
} as const satisfies Record<Exclude<FailureClassName, "budget">, string>;

export const BUDGET_CAPS = [
	"run_tokens",
	"stage_tokens",
	"round_tokens",
	"wall",
	"turns",
] as const;

export type BudgetCapName = (typeof BUDGET_CAPS)[number];

const REASON = /^[a-z][a-z0-9_]{0,63}$/;

/** The controller's own record of why a run stopped, before its row freezes. */
export type TerminalCause = Readonly<{
	/** The stage that caused the stop, not the run's last projected stage. */
	stage: Stage;
	class: FailureClassName;
	/** A fixed controller code: the cap, diagnosis reason or refusal reason. */
	reason: string;
	/** Visible check names only, never held-out content. */
	failedVisibleChecks?: readonly VisibleCheck[];
	/** The private patch the stop retains, by digest. */
	retainedPatch?: Digest | null;
}>;

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

const outcome = tagged(outcomeFields);

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

const failureFact = fact(
	record({
		stage,
		class: oneOf(...FAILURE_CLASSES),
		reason: pattern(REASON, "invalid_reason"),
		failedVisibleChecks: list(oneOf(...VISIBLE_CHECKS)),
		retainedPatch: nullable(digest),
	}),
);

const ACCEPT_DISPOSITIONS = [
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
	const order = stages.map((item) => STAGES.indexOf(item.stage));

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

export interface LedgerApi {
	startJob?(): void;
	ref(): Promise<GitSha | null>;
	commit(sha: GitSha): Promise<LedgerCommit>;
	file(tree: GitSha): Promise<LedgerFile>;
	root(date: string): Promise<LedgerCommit>;
	child(
		parent: LedgerCommit,
		bytes: Uint8Array,
		date: string,
		message: string,
	): Promise<LedgerCommit>;
	advance(from: GitSha | null, next: GitSha): Promise<LedgerAdvance>;
}

export function ledgerApiOf(api: GitHubPublicationApi): LedgerApi {
	return {
		startJob: () => api.startJob(),
		ref: () => api.ledgerRef(),
		commit: (sha) => readLedgerCommit(api, sha),
		file: (tree) => readLedgerFile(api, tree),
		root: (date) => createLedgerRoot(api, date),
		child: (parent, bytes, date, message) =>
			createLedgerChild(api, parent, bytes, date, message),
		advance: (from, next) => api.advanceLedger(from, next),
	};
}

const anchorCodec = record({
	v: literal(1),
	rootSha: sha,
	tipSha: sha,
	blobSha: sha,
	byteLength: count,
	prefixDigest: digest,
});

export type LedgerAnchor = Out<typeof anchorCodec>;

export function parseAnchor(value: JsonValue | undefined): LedgerAnchor | null {
	try {
		return anchorCodec(value);
	} catch (error) {
		if (error instanceof LedgerRowError) return null;
		throw error;
	}
}

export type PendingRow = {
	readonly runId: Digest;
	readonly bytes: Buffer;
	readonly digest: Digest;
	readonly date: string;
};

export type AppendResult =
	| {
			readonly kind: "published";
			readonly tip: GitSha;
			readonly blob: GitSha;
			readonly line: number;
			readonly anchor: LedgerAnchor;
	  }
	| {
			readonly kind: "deferred" | "blocked";
			readonly reason: LedgerErrorCode;
			readonly anchor: LedgerAnchor | null;
	  };

const MAX_WALK = 10_000;

type Seen =
	| {
			readonly kind: "seen";
			readonly head: LedgerCommit;
			readonly file: LedgerFile;
			readonly anchor: LedgerAnchor;
	  }
	| { readonly kind: "blocked"; readonly reason: LedgerErrorCode };

const changed: Seen = { kind: "blocked", reason: "lineage_changed" };

export type AdoptionCursor = {
	readonly base: GitSha | null;
	readonly tip: GitSha;
	readonly cursor: GitSha;
	readonly walked: number;
};

export function parseAdoption(
	value: JsonValue | undefined,
): AdoptionCursor | null {
	try {
		return record({
			base: nullable(sha),
			tip: sha,
			cursor: sha,
			walked: count,
		})(value);
	} catch (error) {
		if (error instanceof LedgerRowError) return null;
		throw error;
	}
}

type Adoption = {
	readonly cursor: AdoptionCursor | null;
	save(cursor: AdoptionCursor): Promise<boolean>;
};

async function verifyTip(
	api: LedgerApi,
	tip: GitSha,
	anchor: LedgerAnchor | null,
	adoption?: Adoption,
): Promise<Seen> {
	const head = await api.commit(tip);

	const saved =
		adoption?.cursor?.tip === tip &&
		adoption.cursor.base === (anchor?.tipSha ?? null)
			? adoption.cursor
			: null;

	let cursor =
		saved === null || saved.cursor === tip
			? head
			: await api.commit(saved.cursor);

	for (let walked = 0; ; walked++) {
		if (walked + (saved?.walked ?? 0) > MAX_WALK) return changed;

		if (adoption !== undefined && walked >= 16)
			return { kind: "blocked", reason: "adoption_pending" };

		if (anchor !== null && cursor.sha === anchor.tipSha) break;
		const [parent, ...others] = cursor.parents;

		if (parent === undefined) {
			if (anchor !== null) return changed;
			const root = await api.file(cursor.tree);

			if (
				root.bytes.length !== 0 ||
				JSON.stringify(root.paths) !== JSON.stringify(["ledger", LEDGER_FILE])
			)
				return changed;
			break;
		}

		if (others.length > 0) return changed;

		if (
			adoption !== undefined &&
			!(await adoption.save({
				base: anchor?.tipSha ?? null,
				tip,
				cursor: parent,
				walked: walked + 1 + (saved?.walked ?? 0),
			}))
		)
			throw new PublicationError("claim_unwritable");
		cursor = await api.commit(parent);
	}

	const file = await api.file(head.tree);

	if (
		anchor !== null &&
		(file.bytes.length < anchor.byteLength ||
			digestOf(file.bytes.subarray(0, anchor.byteLength)) !==
				anchor.prefixDigest)
	)
		return changed;

	return {
		kind: "seen",
		head,
		file,
		anchor: {
			v: 1,
			rootSha: anchor?.rootSha ?? cursor.sha,
			tipSha: tip,
			blobSha: file.blob,
			byteLength: file.bytes.length,
			prefixDigest: digestOf(file.bytes),
		},
	};
}

const INTEGRITY = new Set([
	"object_missing",
	"object_mismatch",
	"blob_mismatch",
	"commit_mismatch",
	"tree_truncated",
	"malformed_tree",
	"malformed_blob",
	"malformed_commit",
	"malformed_ref",
	"malformed_response",
	"ledger_file_missing",
]);

/**
 * Appends one frozen row to `ledger/runs.jsonl` on `factory/ledger`, or
 * proves it is already there. Never forces, deletes or rewrites a byte.
 */
export async function appendRun(
	api: LedgerApi,
	row: PendingRow,
	anchor: LedgerAnchor | null,
	rounds = 3,
	adoption?: Adoption,
	allowRoot = true,
): Promise<AppendResult> {
	let current = anchor;

	try {
		for (let round = 0; round <= rounds + 1; round++) {
			const tip = await api.ref();

			if (tip === null) {
				if (current !== null || !allowRoot)
					return { kind: "blocked", reason: "ref_missing", anchor: current };
				const root = await api.root(row.date);
				await api.advance(null, root.sha);
				continue;
			}

			const seen = await verifyTip(api, tip, current, adoption);

			if (seen.kind === "blocked")
				return {
					kind: seen.reason === "adoption_pending" ? "deferred" : "blocked",
					reason: seen.reason,
					anchor: current,
				};
			const index = indexLedger(parseLedger(seen.file.bytes));

			if (index.kind === "blocked")
				return { kind: "blocked", reason: index.reason, anchor: current };
			current = seen.anchor;
			const hit = index.rows.get(row.runId);

			if (hit !== undefined)
				return hit.digest === row.digest
					? {
							kind: "published",
							tip,
							blob: seen.file.blob,
							line: hit.line,
							anchor: current,
						}
					: { kind: "blocked", reason: "row_conflict", anchor: current };

			if (round > rounds) break;

			const child = await api.child(
				seen.head,
				Buffer.concat([seen.file.bytes, row.bytes]),
				row.date,
				`factory: ledger row ${row.runId}\n\nFactory-Run: ${row.runId}\nFactory-Row: ${row.digest}\n`,
			);

			await api.advance(tip, child.sha);
		}
	} catch (error) {
		if (!(error instanceof PublicationError)) throw error;

		if (error.reason === "claim_unwritable")
			return { kind: "deferred", reason: "state_unwritable", anchor: current };

		if (INTEGRITY.has(error.reason))
			return { kind: "blocked", reason: "object_mismatch", anchor: current };

		return {
			kind: "deferred",
			reason: "transport_unavailable",
			anchor: current,
		};
	}

	return { kind: "deferred", reason: "ledger_contended", anchor: current };
}

/** Parses a pending row's exact bytes back into its frozen form. */
export function frozenRowOf(bytes: Buffer): FrozenRow | null {
	const [line, ...rest] = parseLedger(bytes);

	return line?.kind === "known" && rest.length === 0 ? line : null;
}

const unavailable = (reason: GapCode) => ({ kind: "unavailable", reason });

const known = (value: JsonValue) => ({ kind: "known", value });

export const AUTONOMY_DIGEST = digestOf(
	JSON.stringify({ approveMerge: "always", land: "propose" }),
);

export type TerminalFacts = {
	readonly repo: RepoSlug;
	readonly runId: Digest;
	readonly issue: number;
	readonly eventId: string;
	readonly eventAt: string;
	readonly snapshotDigest: Digest;
	readonly workflowSha: GitSha;
	readonly workflowDigest: Digest;
	readonly status: TerminalStatus;
	readonly stage: Stage;
	readonly usage: number;
	readonly observedAt: string;
	readonly candidate: CandidateState | null;
	readonly attemptEnds?: readonly AttemptEnd[] | null;
	/** Why a failed or budget-exhausted run stopped, when the controller recorded it. */
	readonly cause?: TerminalCause | null;
	readonly evidence?: TerminalEvidence;
	readonly start?: RunStart | null;
	readonly context: RunContextV2;
	/** A load observed at collection, never evidence of an earlier execution policy. */
	readonly terminalWorkflowObservation: {
		readonly workflowSha: GitSha;
		readonly workflowDigest: Digest;
	} | null;
	readonly previousRunId?: Digest | null;
};

export type TerminalEvidence = Partial<
	Pick<
		LedgerRow,
		| "stages"
		| "models"
		| "usage"
		| "repairRounds"
		| "redactedReceiptDigests"
		| "artifacts"
	>
> & {
	readonly mergedAt?: string;
	readonly efficiency?: EfficiencyFacts;
	readonly contextPressure?: LedgerRow["contextPressure"];
	readonly generationGates?: Readonly<Record<string, Digest>>;
};

function outcomeOf(facts: TerminalFacts): JsonValue {
	const { stage, candidate } = facts;

	const terminal =
		candidate?.kind === "selected" && candidate.work.kind === "terminal"
			? candidate.work.terminal
			: null;

	switch (facts.status) {
		case "needs_info":
		case "released":
		case "stage_passed":
			return { kind: facts.status, stage };
		case "failed": {
			const cause = causeOf(facts);

			return {
				kind: "failed",
				stage,
				cause:
					cause === null || cause.class === "budget"
						? unavailable("receipt_missing")
						: known(CAUSES[cause.class]),
			};
		}

		case "budget_exhausted": {
			const cause = causeOf(facts);

			return {
				kind: "budget_exhausted",
				stage,
				cap:
					cause === null ? unavailable("receipt_missing") : known(cause.reason),
			};
		}

		case "cancelled":
			return {
				kind: "cancelled",
				stage,
				reason:
					terminal?.kind === "cancelled"
						? known(terminal.reason)
						: unavailable("receipt_missing"),
			};
		case "landed":
			if (terminal?.kind !== "merged") return fail("landing_incomplete");

			return {
				kind: "landed",
				stage: "land",
				headSha: terminal.head,
				mergeSha: terminal.mergeSha,
				mergedAt:
					facts.evidence?.mergedAt === undefined
						? unavailable("public_metadata_unavailable")
						: known(facts.evidence.mergedAt),
				assurance:
					terminal.assurance.kind === "factory_verified"
						? {
								kind: "factory_verified",
								generationDigest: terminal.assurance.certification.digest,
								authored:
									candidate?.kind === "selected"
										? authoredOf(candidate, terminal.assurance.certification)
										: fail("landing_incomplete"),
							}
						: { kind: "owner_override" },
			};
		default: {
			const exhaustive: never = facts.status;

			return exhaustive;
		}
	}
}

/** The recorded cause when it agrees with the terminal status, else `null`. */
function causeOf(facts: TerminalFacts): TerminalCause | null {
	const cause = facts.cause ?? null;
	const budget = facts.status === "budget_exhausted";

	if (
		cause === null ||
		(facts.status !== "failed" && !budget) ||
		(cause.class === "budget") !== budget ||
		!REASON.test(cause.reason) ||
		(budget && !BUDGET_CAPS.some((cap) => cap === cause.reason))
	)
		return null;

	return cause;
}

function failureOf(facts: TerminalFacts): JsonValue {
	if (facts.status !== "failed" && facts.status !== "budget_exhausted")
		return null;
	const cause = causeOf(facts);

	if (cause === null) return unavailable("receipt_missing");

	return known({
		stage: cause.stage,
		class: cause.class,
		reason: cause.reason,
		failedVisibleChecks: VISIBLE_CHECKS.filter((name) =>
			(cause.failedVisibleChecks ?? []).includes(name),
		),
		retainedPatch: cause.retainedPatch ?? null,
	});
}

const ACCEPT_DISPOSITION = {
	completed: "suite_qualified",
	model_failure: "model_failed",
	refused: "model_refused",
	base_refused: "base_refused",
	interrupted: "interrupted",
	budget_stop: "budget_stopped",
	aborted: "aborted",
} as const satisfies Record<
	AttemptEnd["disposition"],
	(typeof ACCEPT_DISPOSITIONS)[number]
>;

/**
 * Each accept attempt's final disposition. A refusal followed by the one
 * feedback retry is `retried`; earlier builds recorded it as `refused`.
 */
function acceptAttemptsOf(facts: TerminalFacts): JsonValue {
	if (facts.attemptEnds == null || facts.start == null)
		return unavailable("receipt_missing");

	return known(
		facts.attemptEnds
			.filter((end) => end.stage === "accept" && end.round === 0)
			.sort((a, b) => a.attempt - b.attempt)
			.map((end) => ({
				attempt: end.attempt,
				disposition:
					(end.disposition === "refused" ||
						end.disposition === "base_refused") &&
					end.next.kind === "retry"
						? "retried"
						: ACCEPT_DISPOSITION[end.disposition],
			})),
	);
}

const DIAGNOSIS_STOPS = {
	diagnosis_missing_evidence: "missing_evidence",
	diagnosis_oracle: "oracle",
	diagnosis_infrastructure: "infrastructure",
	validation_failed: "candidate",
	repair_limit: "candidate",
} as const;

/**
 * Why a candidate handoff stopped, from its durable terminal reason and, for
 * a validation stop, the current generation's stored diagnosis. A dead end
 * keeps the failed visible check names and the retained private patch.
 */
export function candidateCause(
	state: CandidateState,
	diagnosis: FailureClass | null,
): TerminalCause | null {
	if (
		state.kind !== "selected" ||
		state.work.kind !== "terminal" ||
		state.work.terminal.kind !== "failed"
	)
		return null;
	const reason = state.work.terminal.reason;

	if (reason === "review_tokens" || reason === "repair_tokens")
		return {
			stage: reason === "review_tokens" ? "review" : "build",
			class: "budget",
			reason: "round_tokens",
		};

	if (reason === "run_tokens")
		return {
			stage: state.accounts.at(-1)?.execution.stage ?? "validate",
			class: "budget",
			reason: "run_tokens",
		};

	if (reason === "review_attempts" || reason === "review_failed")
		return { stage: "review", class: "review", reason };

	if (!Object.hasOwn(DIAGNOSIS_STOPS, reason))
		return { stage: "land", class: "handoff", reason };
	// SAFETY: `reason` was just checked to be a key of `DIAGNOSIS_STOPS`.
	const kind = DIAGNOSIS_STOPS[reason as keyof typeof DIAGNOSIS_STOPS];
	const matched = diagnosis?.kind === kind ? diagnosis : null;
	const patch = state.current.patch.patchDigest;

	return {
		stage: "validate",
		class: kind,
		reason:
			matched === null
				? reason
				: matched.kind === "oracle"
					? matched.cause
					: matched.reason,
		failedVisibleChecks: failedVisibleChecks(
			state.current.verdict?.checks ?? null,
		),
		retainedPatch: isDigest(patch) ? patch : null,
	};
}

/**
 * The owner-facing stop facts of a stored terminal snapshot, for `status`:
 * the outcome and, from version 2, the cause. Never a held-out detail.
 */
export function terminalFailureOf(value: JsonValue | undefined): JsonValue {
	try {
		const object = objectOf(value) ?? fail("invalid_object");
		const stopped = outcome(object.outcome);

		return {
			outcome: stopped,
			failure:
				object.v === 2 || object.v === 3 || object.v === 4 || object.v === 5
					? nullable(failureFact)(object.failure)
					: stopped.kind === "failed" || stopped.kind === "budget_exhausted"
						? unavailable("legacy_not_recorded")
						: null,
		};
	} catch (error) {
		if (error instanceof LedgerRowError) return null;
		throw error;
	}
}

function artifactsOf(facts: TerminalFacts): JsonValue {
	const state = facts.candidate;

	if (state === null && facts.evidence?.artifacts !== undefined)
		return facts.evidence.artifacts;

	if (state === null)
		return facts.stage === "specify"
			? { kind: "admission" }
			: {
					kind: "pre_build_stop",
					contractDigest: unavailable("not_instrumented"),
					acceptanceDigest: unavailable("not_instrumented"),
				};

	if (state.kind === "unprepared")
		return {
			kind: "built",
			contractDigest: state.pin.contractDigest,
			acceptanceDigest: state.pin.acceptanceDigest,
			patchDigest: state.patch.patchDigest,
		};

	return {
		kind: "candidate",
		contractDigest: state.pin.contractDigest,
		acceptanceDigest: state.pin.acceptanceDigest,
		generations: candidateGenerations(state).map((evidence) => {
			const { intent, verdict, validation } = evidence;
			const publication = validation?.publication ?? null;
			const ci = validation?.ciRunId ?? null;

			const gateSha = verdict?.gateSha ?? intent.baseSha;
			const gatesDigest = facts.evidence?.generationGates?.[gateSha];

			return {
				round: intent.round,
				generation: intent.generation,
				intentDigest: intent.digest,
				baseSha: intent.baseSha,
				patchDigest: intent.patchDigest,
				heldoutDigest:
					verdict === null
						? unavailable("receipt_missing")
						: known(verdict.heldoutDigest),
				candidateSha:
					publication === null
						? unavailable("receipt_missing")
						: known(publication.candidateSha),
				gateSha:
					verdict === null && gatesDigest === undefined
						? unavailable("receipt_missing")
						: known(gateSha),
				gatesDigest:
					gatesDigest === undefined
						? unavailable("receipt_missing")
						: known(gatesDigest),
				ciRunId: ci === null ? unavailable("receipt_missing") : known(ci),
			};
		}),
	};
}

/**
 * Projects what the controller knows at a terminal decision into a row
 * without its marker proof. Facts this build does not yet record are
 * unavailable, never zero.
 */
function provenanceOf(context: RunContextV2): JsonValue {
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

export function terminalSnapshot(facts: TerminalFacts): JsonValue {
	const context = runContext(facts.context);
	const identity = context.kind === "legacy" ? context.known : context.policy;

	if (
		identity.workflowSha !== facts.workflowSha ||
		identity.workflowDigest !== facts.workflowDigest ||
		(facts.start != null &&
			(facts.start.runId !== facts.runId ||
				JSON.stringify(facts.start.context) !== JSON.stringify(context)))
	)
		fail("policy_binding");
	const base = `https://github.com/${facts.repo}`;
	const state = facts.candidate;
	const published = state?.kind === "selected" ? state.published : null;

	const ciUrls =
		state?.kind === "selected"
			? [
					...new Set(
						candidateGenerations(state).flatMap((evidence) =>
							evidence.validation?.ciRunId == null
								? []
								: [`${base}/actions/runs/${evidence.validation.ciRunId}`],
						),
					),
				].sort()
			: [];

	return {
		v: 5,
		runId: facts.runId,
		repo: facts.repo,
		issue: facts.issue,
		eventId: facts.eventId,
		eventAt: facts.eventAt,
		previousRunId:
			facts.previousRunId === undefined
				? unavailable("receipt_missing")
				: known(facts.previousRunId),
		snapshotDigest: facts.snapshotDigest,
		originalBase: state?.pin.originalBase ?? facts.workflowSha,
		startedAt:
			facts.start == null
				? unavailable("receipt_missing")
				: known(facts.start.startedAt),
		terminalObservedAt: facts.observedAt,
		runContext: context,
		terminalWorkflowObservation:
			facts.terminalWorkflowObservation === null
				? unavailable("receipt_missing")
				: known(facts.terminalWorkflowObservation),
		provenance: provenanceOf(context),
		outcome: outcomeOf(facts),
		pr:
			published === null
				? null
				: { number: published.number, url: `${base}/pull/${published.number}` },
		artifacts: artifactsOf(facts),
		repairRounds:
			facts.evidence?.repairRounds ?? unavailable("not_instrumented"),
		stages:
			facts.evidence?.stages?.kind === "known"
				? known(
						facts.evidence.stages.value.map((s) => ({
							...s,
							efficiency:
								"efficiency" in s ? s.efficiency : unknownEfficiency(),
						})),
					)
				: (facts.evidence?.stages ?? unavailable("receipt_missing")),
		models: facts.evidence?.models ?? unavailable("receipt_missing"),
		usage: facts.evidence?.usage ?? {
			tokens: {
				kind: "lower_bound",
				unit: "tokens",
				total: facts.usage,
				reason: "not_instrumented",
			},
			parentTokens: unavailable("not_instrumented"),
			childTokens: unavailable("not_instrumented"),
			unattributedTokens: unavailable("not_instrumented"),
			money: unavailable("provider_not_reported"),
		},
		interruptedAttempts:
			facts.attemptEnds == null || facts.start == null
				? unavailable("not_instrumented")
				: known(
						facts.attemptEnds.filter(
							(attempt) => attempt.disposition === "interrupted",
						).length,
					),
		contextPressure:
			facts.evidence?.contextPressure ?? unavailable("not_instrumented"),
		efficiency: facts.evidence?.efficiency ?? unknownEfficiency(),
		redactedReceiptDigests: facts.evidence?.redactedReceiptDigests ?? [],
		evidence: { issueUrl: `${base}/issues/${facts.issue}`, ciUrls },
		failure: failureOf(facts),
		acceptAttempts: acceptAttemptsOf(facts),
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

export interface RunAccounting {
	start(runId: Digest): Promise<RunStart | null | undefined>;
	begin(record: RunStartRecord): Promise<boolean>;
	readAttempt(
		runId: Digest,
		stage: Stage,
		round: number,
		attempt: number,
	): Promise<AttemptEnd | null | undefined>;
	writeAttempt(record: AttemptEnd): Promise<boolean>;
	attempts(runId: Digest): Promise<readonly AttemptEnd[] | null>;
}

export type MarkerProof = { readonly seq: number; readonly digest: Digest };

export type LedgerRetry = {
	readonly attempts: number;
	readonly nextAt: number;
	readonly reason: LedgerErrorCode;
	readonly blocked: boolean;
};

export type OutboxJob = {
	readonly runId: Digest;
	readonly observedAt: string;
	readonly row: FrozenRow | null;
	readonly retry: LedgerRetry | null;
	readonly adoption?: AdoptionCursor | null;
};

export type PublishedReceipt = {
	readonly v: 1;
	readonly runId: Digest;
	readonly rowDigest: Digest;
	readonly observedTip: GitSha;
	readonly blobSha: GitSha;
	readonly lineNumber: number;
};

/** The controller-private record of terminal runs and their ledger rows. */
export interface LedgerOutbox {
	/** Keeps the first snapshot for a run; a later one never replaces it. */
	prepare(runId: Digest, snapshot: JsonValue): Promise<boolean>;
	/** Records, once, that a run's terminal snapshot cannot be encoded, so it shows as blocked. */
	block(runId: Digest, observedAt: string): Promise<boolean>;
	freeze(
		runId: Digest,
		marker: MarkerProof,
	): Promise<"frozen" | "absent" | "invalid" | "unwritable">;
	/** Unpublished jobs, or `null` when the outbox cannot be listed; a corrupt job blocks alone. */
	scan(): Promise<readonly OutboxJob[] | null>;
	/**
	 * The verified anchor; `null` only when neither an anchor nor a receipt
	 * exists, `orphaned` when receipts exist without one, `invalid` when it
	 * cannot be read or parsed.
	 */
	anchor(): Promise<LedgerAnchor | null | "orphaned" | "invalid">;
	adoption(runId: Digest, cursor: AdoptionCursor): Promise<boolean>;
	published(receipt: PublishedReceipt, anchor: LedgerAnchor): Promise<boolean>;
	retry(runId: Digest, retry: LedgerRetry): Promise<boolean>;
}

export type LedgerBacklog = {
	readonly readable: boolean;
	readonly pending: number;
	readonly blocked: number;
	readonly published: number;
	readonly oldestObservedAt: string | null;
	readonly lastError: LedgerErrorCode | null;
};

const BACKOFF_MS = 5_000;
const BACKOFF_MAX_MS = 300_000;

/** One bounded pass over the outbox. It calls no model and launches no stage. */
export async function pumpLedger(
	outbox: LedgerOutbox,
	api: LedgerApi,
	now: number,
	clock: () => number = () => now,
): Promise<LedgerBacklog> {
	const jobs = await outbox.scan();

	if (jobs === null)
		return {
			readable: false,
			pending: 0,
			blocked: 0,
			published: 0,
			oldestObservedAt: null,
			lastError: "state_unwritable",
		};

	const ordered = [...jobs].sort((a, b) =>
		a.observedAt === b.observedAt
			? a.runId.localeCompare(b.runId)
			: a.observedAt.localeCompare(b.observedAt),
	);

	const stored = await outbox.anchor();
	let anchor = stored === "orphaned" || stored === "invalid" ? null : stored;
	let published = 0;
	let blocked = 0;
	let lastError: LedgerErrorCode | null = null;
	const waiting: string[] = [];

	for (const job of ordered) {
		if (job.row === null || (job.retry !== null && job.retry.nextAt > now)) {
			if (job.retry?.blocked === true) blocked += 1;
			lastError = job.retry?.reason ?? lastError;
			waiting.push(job.observedAt);
			continue;
		}

		let result: AppendResult;

		if (stored === "invalid")
			result = { kind: "blocked", reason: "state_invalid", anchor: null };
		else {
			api.startJob?.();
			result = await appendRun(
				api,
				{
					runId: job.runId,
					bytes: job.row.bytes,
					digest: job.row.digest,
					date: job.observedAt.replace(/\.\d{3}Z$/, "Z"),
				},
				anchor,
				3,
				{
					cursor: job.adoption ?? null,
					save: (cursor) => outbox.adoption(job.runId, cursor),
				},
				stored === null,
			);
		}

		if (result.kind === "published") {
			const receipt: PublishedReceipt = {
				v: 1,
				runId: job.runId,
				rowDigest: job.row.digest,
				observedTip: result.tip,
				blobSha: result.blob,
				lineNumber: result.line,
			};

			if (await outbox.published(receipt, result.anchor)) {
				anchor = result.anchor;
				published += 1;
				continue;
			}

			lastError = "state_unwritable";
		} else lastError = result.reason;
		const attempts = (job.retry?.attempts ?? 0) + 1;

		await outbox.retry(job.runId, {
			attempts,
			nextAt:
				clock() + Math.min(BACKOFF_MAX_MS, BACKOFF_MS * 2 ** (attempts - 1)),
			reason: lastError,
			blocked: result.kind === "blocked",
		});

		if (result.kind === "blocked") blocked += 1;
		waiting.push(job.observedAt);
	}

	return {
		readable: true,
		pending: waiting.length,
		blocked,
		published,
		oldestObservedAt: waiting.sort()[0] ?? null,
		lastError,
	};
}

const retryCodec = record({
	attempts: positive,
	nextAt: count,
	reason: oneOf(
		"state_unwritable",
		"transport_unavailable",
		"row_conflict",
		"ledger_corrupt",
		"ledger_version_unsupported",
		"ledger_contended",
		"lineage_changed",
		"ref_missing",
		"object_mismatch",
		"adoption_pending",
		"state_invalid",
		"row_invalid",
	),
	blocked: flag,
});

export function parseRetry(value: JsonValue | undefined): LedgerRetry | null {
	try {
		return retryCodec(value);
	} catch (error) {
		if (error instanceof LedgerRowError) return null;
		throw error;
	}
}
