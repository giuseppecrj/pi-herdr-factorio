import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { stageResult, type StageReceipt } from "../host/sandbox/result.ts";
import type { ModelId } from "../src/config/schema.ts";
import {
	aggregateEfficiency,
	executionUsageOf,
	parseEfficiency,
	requestEfficiency,
	unknownEfficiency,
	type SessionOutcome,
} from "../src/core/execution.ts";
import {
	journalCharge,
	requestSettlements,
	settlementReply,
} from "../src/core/journal.ts";
import type { JsonValue } from "../src/core/json.ts";
import {
	arrayOf,
	boolOf,
	countOf,
	fieldOf,
	hasDuplicateKey,
	hasOnlyKeys,
	numberOf,
	objectOf,
	parseJson,
	textOf,
	textsOf,
} from "../src/core/json.ts";
import {
	ANTHROPIC_MAX_OUTPUT_TOKENS,
	ANTHROPIC_MODEL_IDS,
	anthropicMaxOutput,
	certifyR8,
	crossFamily,
	familyFromJournal,
	familyLabel,
	familyOf,
	isAnthropicModelId,
	parseAnthropicModel,
	parseFamily,
	withFamily,
	type FamilyInput,
} from "../src/core/models.ts";
import {
	REPAIR_BUILD_MAX_TOKENS,
	REQUIRED_CI_CHECKS,
	REVIEW_MAX_TOKENS,
	blocksReview,
	digestOf,
	isDigest,
	outcomeOf,
	runIdOf,
	startRun,
	verdictPasses,
	type Digest,
	type Run,
	type Verdict,
} from "../src/core/run.ts";
import type { SandboxStage } from "../src/core/stages.ts";

/** The JSON text of `value` parsed back, with `undefined` kept as a visible marker. */
function observed<T>(value: T): JsonValue | undefined {
	return parseJson(
		JSON.stringify(value, (_, item: JsonValue | undefined) =>
			item === undefined ? "<undefined>" : item,
		),
	);
}

function lines(...records: readonly object[]): string {
	return records.map((record) => `${JSON.stringify(record)}\n`).join("");
}

const DIGEST = digestOf("core pins");
const SHA = "a".repeat(40);

const JSON_TEXTS = [
	'{"a":1}',
	'[1,"x",null,true]',
	"",
	"{",
	"nul",
	"1 2",
	" 3 ",
	'"\\u0041"',
	'{"a":1,"a":2}',
	'{"__proto__":{"x":1}}',
];

const DUPLICATE_TEXTS = [
	'{"a":1,"a":2}',
	'{"a":1,"\\u0061":2}',
	'{"a":{"a":1}}',
	'[{"a":1},{"a":1}]',
	'{"a":[1,{"b":2}],"b":3}',
	'{"a\\"b":1,"a\\"b":2}',
	'{"x":"a,b","a":1,"b":2}',
	'{"a":{"b":1},"a":2}',
	'{"a":{"b":1,"b":2}}',
];

const VALUES: readonly (JsonValue | undefined)[] = [
	undefined,
	null,
	true,
	false,
	0,
	1,
	-1,
	1.5,
	2 ** 53,
	"",
	"x",
	"3",
	[],
	["a", "b"],
	["a", 1],
	{},
	{ a: 1 },
];

describe("core pins: JSON", () => {
	it("pins parse results and duplicate-key rejection", () => {
		const actual = observed({
			parsed: JSON_TEXTS.map((text) => parseJson(text)),
			duplicates: DUPLICATE_TEXTS.map((text) => hasDuplicateKey(text)),
		});

		assert.deepEqual(actual, PINS.json);
	});

	it("pins every reader's acceptance and rejection", () => {
		const actual = observed({
			readers: VALUES.map((value) => ({
				object: objectOf(value),
				array: arrayOf(value),
				text: textOf(value),
				number: numberOf(value),
				count: countOf(value),
				bool: boolOf(value),
				texts: textsOf(value),
			})),
			fields: [
				fieldOf({ a: 1 }, "a"),
				fieldOf({ a: 1 }, "b"),
				fieldOf({}, "toString"),
				fieldOf(objectOf(parseJson('{"__proto__":1}')), "__proto__"),
				fieldOf(null, "a"),
			],
			keys: [
				hasOnlyKeys({ a: 1, b: 2 }, ["a", "b", "c"]),
				hasOnlyKeys({ a: 1, d: 2 }, ["a", "b"]),
				hasOnlyKeys({}, []),
			],
		});

		assert.deepEqual(actual, PINS.readers);
	});
});

const ANTHROPIC = "anthropic/claude-sonnet-5-5";
const OPENAI = "openai/gpt-5.5";

function dispatch(req: number, route: string) {
	return {
		v: 1,
		ts: "2026-11-12T00:00:00.000Z",
		stage: "accept",
		runId: DIGEST,
		attempt: 1,
		req,
		route,
		kind: "dispatch",
		inputTokenEstimate: 10,
		maxOutputTokens: 20,
	};
}

function result(
	req: number,
	route: string,
	extra: { readonly [key: string]: JsonValue } = {},
) {
	return {
		v: 1,
		ts: "2026-11-12T00:00:01.000Z",
		stage: "accept",
		runId: DIGEST,
		attempt: 1,
		req,
		route,
		kind: "result",
		status: 200,
		decision: "forward",
		inputTokens: 3,
		outputTokens: 4,
		...extra,
	};
}

type FamilyCase = {
	readonly name: string;
	readonly journal: string | null;
	readonly requested: string;
	readonly superseded: string | null;
};

const FAMILY_JOURNALS: readonly FamilyCase[] = [
	{
		name: "anthropic metered",
		journal: lines(
			dispatch(1, "model-anthropic"),
			result(1, "model-anthropic", { observedModel: "claude-sonnet-5-5" }),
		),
		requested: ANTHROPIC,
		superseded: null,
	},
	{
		name: "anthropic uncertain",
		journal: lines(dispatch(1, "model-anthropic")),
		requested: ANTHROPIC,
		superseded: null,
	},
	{
		name: "anthropic unmetered",
		journal: lines(
			dispatch(1, "model-anthropic"),
			result(1, "model-anthropic", { inputTokens: null, outputTokens: 4 }),
		),
		requested: ANTHROPIC,
		superseded: null,
	},
	{
		name: "anthropic unknown observed",
		journal: lines(
			dispatch(1, "model-anthropic"),
			result(1, "model-anthropic", { observedModel: "claude-unknown-9" }),
		),
		requested: ANTHROPIC,
		superseded: null,
	},
	{
		name: "anthropic outside table",
		journal: lines(dispatch(1, "model-anthropic")),
		requested: "anthropic/claude-unknown-9",
		superseded: null,
	},
	{
		name: "openai metered",
		journal: lines(dispatch(1, "model-openai"), result(1, "model-openai")),
		requested: OPENAI,
		superseded: null,
	},
	{
		name: "openai other observed",
		journal: lines(
			dispatch(1, "model-openai"),
			result(1, "model-openai", { observedModel: "gpt-4" }),
		),
		requested: OPENAI,
		superseded: null,
	},
	{
		name: "openai bare observed",
		journal: lines(
			dispatch(1, "model-openai"),
			result(1, "model-openai", { observedModel: "gpt-5.5" }),
		),
		requested: OPENAI,
		superseded: null,
	},
	{
		name: "mixed routes",
		journal: lines(
			dispatch(1, "model-openai"),
			result(1, "model-openai"),
			dispatch(2, "model-anthropic"),
		),
		requested: OPENAI,
		superseded: null,
	},
	{
		name: "superseded route ignored",
		journal: lines(
			dispatch(1, "model-openai"),
			dispatch(2, "model-anthropic"),
			result(2, "model-anthropic", { observedModel: "claude-sonnet-5-5" }),
		),
		requested: ANTHROPIC,
		superseded: "model-openai",
	},
	{
		name: "provider rejected only",
		journal: lines(
			dispatch(1, "model-anthropic"),
			result(1, "model-anthropic", {
				status: 429,
				reason: "provider_rejected",
				observedModel: "claude-sonnet-5-5",
			}),
		),
		requested: ANTHROPIC,
		superseded: null,
	},
	{
		name: `no journal for ${ANTHROPIC}`,
		journal: null,
		requested: ANTHROPIC,
		superseded: null,
	},
	{
		name: `no journal for ${"google/gemini"}`,
		journal: null,
		requested: "google/gemini",
		superseded: null,
	},
];

const FAMILIES: readonly (FamilyInput | null)[] = [
	parseFamily({ kind: "anthropic-gateway", model: "claude-opus-5" }),
	parseFamily({ kind: "openai-request", model: OPENAI }),
	parseFamily({ kind: "unavailable", reason: "mixed" }),
	parseFamily({ kind: "anthropic-gateway", model: "anthropic/claude-opus-5" }),
	parseFamily({ kind: "openai-request", model: "gpt-5.5" }),
	parseFamily({ kind: "unavailable", reason: "other" }),
	parseFamily({ kind: "unavailable", reason: "missing", extra: 1 }),
	parseFamily("anthropic-gateway"),
];

describe("core pins: observed model families", () => {
	it("pins the limits table and model id parsing", () => {
		const ids = [
			"anthropic/claude-opus-5",
			"claude-opus-5",
			"claude-opus-4-5",
			"anthropic/claude-unknown-9",
			"openai/gpt-5.5",
			"Anthropic/claude-opus-5",
			"anthropic/anthropic/claude-opus-5",
			"",
		];

		const actual = observed({
			ids: ANTHROPIC_MODEL_IDS,
			limits: ANTHROPIC_MAX_OUTPUT_TOKENS,
			parsed: ids.map((id) => [
				isAnthropicModelId(id),
				parseAnthropicModel(id),
				anthropicMaxOutput(id),
			]),
		});

		assert.deepEqual(actual, PINS.models);
	});

	it("pins journal families, stored families and certification", () => {
		const known = FAMILIES.filter((family) => family !== null);

		const actual = observed({
			journals: FAMILY_JOURNALS.map(({ name, ...input }) => [
				name,
				familyFromJournal(input),
			]),
			stored: FAMILIES,
			families: known.map((family) => familyOf(family)),
			cross: known.map((a) => known.map((b) => crossFamily(a, b))),
			labels: known.map((a) => [
				familyLabel(a),
				...known.map((b) => familyLabel(a, b)),
			]),
			certified: known.map((builder) =>
				known.map((author) =>
					certifyR8({
						builder,
						accept: author,
						seats: [
							{ seat: "simplify", evidence: author },
							{ seat: "code-review", evidence: author },
						],
					}),
				),
			),
			simplifyOnly: certifyR8({
				builder: known[1] ?? FAMILY_UNREACHABLE,
				accept: known[0] ?? FAMILY_UNREACHABLE,
				seats: [{ seat: "simplify", evidence: known[0] ?? FAMILY_UNREACHABLE }],
			}),
			withFamily: [
				withFamily({ a: 1 }, known[0]),
				withFamily({ a: 1 }, null),
				withFamily({ a: 1 }, undefined),
			],
		});

		assert.deepEqual(actual, PINS.families);
	});
});

const FAMILY_UNREACHABLE: FamilyInput = {
	kind: "unavailable",
	reason: "missing",
};

const SETTLEMENT_JOURNAL = [
	lines(
		dispatch(1, "model-anthropic"),
		result(1, "model-anthropic", { observedModel: "claude-sonnet-5-5" }),
		dispatch(2, "model-anthropic"),
		dispatch(3, "model-anthropic"),
		result(3, "model-anthropic", { inputTokens: null, outputTokens: null }),
		result(4, "model-anthropic", {
			status: 400,
			reason: "provider_rejected",
			inputTokens: null,
			outputTokens: null,
		}),
		result(5, "model-openai", {
			status: 502,
			decision: "error",
			reason: "upstream_unreachable",
			inputTokens: null,
			outputTokens: null,
		}),
		{
			route: "model-anthropic",
			kind: "result",
			status: 200,
			inputTokens: 8,
			outputTokens: 9,
		},
		dispatch(6, "model-openai"),
		result(6, "model-openai", { inputTokens: 7, outputTokens: null }),
		result(1, "model-anthropic", { inputTokens: 99, outputTokens: 99 }),
		{ kind: "dispatch" },
	),
	'{"req":7,"route":"model-openai","kind":"disp',
].join("");

describe("core pins: settlement and result interpretation", () => {
	it("pins request settlements, replies and journal charges", () => {
		const settled = requestSettlements(SETTLEMENT_JOURNAL);

		const actual = observed({
			settled,
			replies: settled.requests.map((request) => settlementReply(request)),
			anthropic: requestSettlements(SETTLEMENT_JOURNAL, {
				route: "model-anthropic",
			}),
			running: requestSettlements(SETTLEMENT_JOURNAL, { stopped: false }),
			charge: journalCharge(SETTLEMENT_JOURNAL),
			empty: [requestSettlements(""), journalCharge("")],
		});

		assert.deepEqual(actual, PINS.settlements);
	});

	it("pins the stage result for each session outcome", () => {
		const outcomes: SessionOutcome[] = [
			{ kind: "passed" },
			{ kind: "failed", exit: "crashed" },
			{ kind: "refused" },
			{ kind: "budget_exhausted", cap: "run_tokens" },
		];

		const actual = observed(
			outcomes.map((outcome) => {
				const { receipt, ...rest } = stageResult({ ...RECEIPT, outcome });

				return { ...rest, outcome: receipt.outcome };
			}),
		);

		assert.deepEqual(actual, PINS.results);
	});
});

// SAFETY: "openai/gpt-5.5" matches the workflow's ModelId pattern.
const MODEL = "openai/gpt-5.5" as ModelId;

const RECEIPT: StageReceipt = {
	version: 1,
	runId: DIGEST,
	stage: "build",
	attempt: 2,
	outcome: { kind: "passed" },
	settlement: { event: "agent_settled", aborted: false },
	models: { requested: MODEL, observed: null },
	fallback: null,
	refusal: null,
	wallMs: 10,
	turns: 3,
	usage: {
		total: 42,
		parent: 40,
		children: 2,
		byModel: {},
		gateway: null,
		unreadChildren: 0,
	},
	egress: null,
	stderr: [],
	output: null,
	assetsDigest: DIGEST,
	versions: { pi: "1", piHerdrAgents: "2", piHerdrPstack: "3" },
	pricing: "unavailable",
};

describe("core pins: unknown usage", () => {
	it("pins unavailable efficiency facts", () => {
		const facts = { ...unknownEfficiency(), turns: 1, modelRequests: 2 };
		const counted = { ...unknownEfficiency(), assistantTurns: 4 };

		const actual = observed({
			unknown: unknownEfficiency(),
			parsed: [
				parseEfficiency(unknownEfficiency()),
				parseEfficiency({ ...unknownEfficiency(), inputTokens: 5 }),
				parseEfficiency({ ...unknownEfficiency(), inputTokens: -1 }),
				parseEfficiency({ ...unknownEfficiency(), inputTokens: 1.5 }),
				parseEfficiency({ ...unknownEfficiency(), extra: 1 }),
				parseEfficiency(facts),
				parseEfficiency(undefined),
			],
			journals: [
				null,
				"",
				lines(dispatch(1, "model-openai")).trimEnd(),
				lines(dispatch(1, "model-openai"), result(1, "model-openai")),
				lines(
					dispatch(1, "model-openai"),
					result(1, "model-openai"),
					dispatch(2, "model-openai"),
				),
				lines(result(1, "model-openai")),
				lines(
					dispatch(1, "model-openai"),
					result(1, "model-openai"),
					result(1, "model-openai", { outputTokens: 5 }),
				),
				lines(dispatch(1, "model-openai"), { req: 1, kind: "other" }),
				lines({ kind: "dispatch" }),
			].map((journal) => requestEfficiency(journal)),
			aggregate: [
				aggregateEfficiency([]),
				aggregateEfficiency([unknownEfficiency(), counted]),
				aggregateEfficiency([
					{
						...counted,
						firstInputTokens: 1,
						lastInputTokens: 2,
						maxInputTokens: 3,
					},
					{
						...counted,
						firstInputTokens: 4,
						lastInputTokens: 5,
						maxInputTokens: 6,
					},
				]),
			],
		});

		assert.deepEqual(actual, PINS.efficiency);
	});

	it("pins execution usage binding and rejection", () => {
		const stage: SandboxStage = "build";
		const binding = { runId: DIGEST, stage, attempt: 2 };

		const usage = {
			version: 1,
			runId: DIGEST,
			stage: "build",
			attempt: 2,
			startedAt: 1,
			deadline: 2,
			turns: 3,
			usage: {
				total: 10,
				parent: 6,
				children: 4,
				gateway: null,
				unreadChildren: 0,
				byModel: { "openai/gpt-5.5": 10 },
			},
		};

		const actual = observed(
			[
				usage,
				{ ...usage, efficiency: unknownEfficiency() },
				{ ...usage, efficiency: { inputTokens: 1 } },
				{ ...usage, attempt: 3 },
				{ ...usage, deadline: 0 },
				{ ...usage, usage: { ...usage.usage, total: 9 } },
				{ ...usage, usage: { ...usage.usage, gateway: 11 } },
				{ ...usage, usage: { ...usage.usage, byModel: { a: -1 } } },
				{ ...usage, version: 2 },
			].map((value) => executionUsageOf(value, binding)),
		);

		assert.deepEqual(actual, PINS.usage);
	});
});

const VERDICT: Verdict = {
	patchDigest: DIGEST,
	acceptanceDigest: DIGEST,
	heldoutDigest: DIGEST,
	candidateSha: SHA,
	gateSha: SHA,
	ciRunId: 1,
	originalBase: SHA,
	baseSha: SHA,
	pass: true,
	checks: REQUIRED_CI_CHECKS.map((name) => ({ name, passed: true })),
	requiredChecks: [...REQUIRED_CI_CHECKS],
	unjudged: [],
};

describe("core pins: run serialization", () => {
	it("pins run identity, digests and the serialized run", () => {
		const run: Run = startRun({
			id: runIdOf({ repo: "o/r", issue: 7, eventId: "e1" }),
			ticket: { provider: "github", key: "o/r#7", url: "https://x/7" },
			repo: "o/r",
			baseSha: SHA,
		});

		const finished: Run = {
			...run,
			progress: {
				kind: "finished",
				outcome: { kind: "needs_info", questions: ["why?"] },
			},
		};

		const digest: Digest = digestOf(new Uint8Array([1, 2, 3]));

		const actual = observed({
			caps: [REVIEW_MAX_TOKENS, REPAIR_BUILD_MAX_TOKENS],
			checks: REQUIRED_CI_CHECKS,
			digests: [
				digestOf(""),
				digest,
				isDigest(digest),
				isDigest("A".repeat(64)),
			],
			run: JSON.stringify(run),
			finished: JSON.stringify(finished),
			outcomes: [outcomeOf(run), outcomeOf(finished)],
		});

		assert.deepEqual(actual, PINS.run);
	});

	it("pins verdict acceptance and review blocking", () => {
		const verdicts: Verdict[] = [
			VERDICT,
			{ ...VERDICT, pass: false },
			{ ...VERDICT, ciRunId: 0 },
			{ ...VERDICT, candidateSha: "A".repeat(40) },
			{ ...VERDICT, requiredChecks: [...REQUIRED_CI_CHECKS, "extra"] },
			{
				...VERDICT,
				requiredChecks: [...REQUIRED_CI_CHECKS, "extra"],
				checks: [...VERDICT.checks, { name: "extra", passed: true }],
			},
			{
				...VERDICT,
				checks: VERDICT.checks.map((check, at) =>
					at === 1 ? { ...check, name: "baseline_tests" } : check,
				),
			},
		];

		const finding = {
			id: "f",
			path: "src/a.ts",
			startLine: 1,
			endLine: 1,
			claim: "c",
			evidence: "e",
		};

		const actual = observed({
			verdicts: verdicts.map((verdict) => verdictPasses(verdict)),
			blocks: [
				blocksReview([]),
				blocksReview([{ seat: "code-review", findings: [], judgments: [] }]),
				blocksReview([
					{
						seat: "code-review",
						findings: [],
						judgments: [{ scenario: "s", outcome: "fail", reason: "r" }],
					},
				]),
				blocksReview([
					{
						seat: "simplify",
						findings: [
							{ ...finding, severity: "blocking", category: "simplify" },
						],
						judgments: [],
					},
				]),
				blocksReview([
					{
						seat: "code-review",
						findings: [{ ...finding, severity: "blocking", category: "bug" }],
						judgments: [],
					},
				]),
				blocksReview([
					{
						seat: "code-review",
						findings: [{ ...finding, severity: "advisory", category: "bug" }],
						judgments: [],
					},
				]),
			],
		});

		assert.deepEqual(actual, PINS.verdicts);
	});
});

const PINS = {
	json: {
		parsed: [
			{ a: 1 },
			[1, "x", null, true],
			"<undefined>",
			"<undefined>",
			"<undefined>",
			"<undefined>",
			3,
			"A",
			{ a: 2 },
			{ ["__proto__"]: { x: 1 } },
		],
		duplicates: [true, true, false, false, false, true, false, true, true],
	},
	readers: {
		readers: [
			{
				object: null,
				array: null,
				text: null,
				number: null,
				count: null,
				bool: null,
				texts: null,
			},
			{
				object: null,
				array: null,
				text: null,
				number: null,
				count: null,
				bool: null,
				texts: null,
			},
			{
				object: null,
				array: null,
				text: null,
				number: null,
				count: null,
				bool: true,
				texts: null,
			},
			{
				object: null,
				array: null,
				text: null,
				number: null,
				count: null,
				bool: false,
				texts: null,
			},
			{
				object: null,
				array: null,
				text: null,
				number: 0,
				count: 0,
				bool: null,
				texts: null,
			},
			{
				object: null,
				array: null,
				text: null,
				number: 1,
				count: 1,
				bool: null,
				texts: null,
			},
			{
				object: null,
				array: null,
				text: null,
				number: -1,
				count: null,
				bool: null,
				texts: null,
			},
			{
				object: null,
				array: null,
				text: null,
				number: 1.5,
				count: null,
				bool: null,
				texts: null,
			},
			{
				object: null,
				array: null,
				text: null,
				number: 9007199254740992,
				count: null,
				bool: null,
				texts: null,
			},
			{
				object: null,
				array: null,
				text: "",
				number: null,
				count: null,
				bool: null,
				texts: null,
			},
			{
				object: null,
				array: null,
				text: "x",
				number: null,
				count: null,
				bool: null,
				texts: null,
			},
			{
				object: null,
				array: null,
				text: "3",
				number: null,
				count: null,
				bool: null,
				texts: null,
			},
			{
				object: null,
				array: [],
				text: null,
				number: null,
				count: null,
				bool: null,
				texts: [],
			},
			{
				object: null,
				array: ["a", "b"],
				text: null,
				number: null,
				count: null,
				bool: null,
				texts: ["a", "b"],
			},
			{
				object: null,
				array: ["a", 1],
				text: null,
				number: null,
				count: null,
				bool: null,
				texts: null,
			},
			{
				object: {},
				array: null,
				text: null,
				number: null,
				count: null,
				bool: null,
				texts: null,
			},
			{
				object: { a: 1 },
				array: null,
				text: null,
				number: null,
				count: null,
				bool: null,
				texts: null,
			},
		],
		fields: [1, "<undefined>", "<undefined>", 1, "<undefined>"],
		keys: [true, false, true],
	},
	models: {
		ids: [
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
		],
		limits: {
			"claude-opus-5-5": 128000,
			"claude-opus-5": 128000,
			"claude-fable-5-1": 128000,
			"claude-fable-5": 128000,
			"claude-opus-4-8": 128000,
			"claude-opus-4-7": 128000,
			"claude-opus-4-5": 64000,
			"claude-sonnet-5-5": 128000,
			"claude-sonnet-5": 128000,
			"claude-sonnet-4-6": 128000,
			"claude-sonnet-4-5": 64000,
			"claude-haiku-5-5": 128000,
			"claude-haiku-4-5": 64000,
		},
		parsed: [
			[false, "claude-opus-5", 128000],
			[true, "claude-opus-5", 128000],
			[true, "claude-opus-4-5", 64000],
			[false, null, null],
			[false, null, null],
			[false, null, null],
			[false, null, null],
			[false, null, null],
		],
	},
	families: {
		journals: [
			[
				"anthropic metered",
				{ kind: "anthropic-gateway", model: "claude-sonnet-5-5" },
			],
			["anthropic uncertain", { kind: "unavailable", reason: "unmetered" }],
			["anthropic unmetered", { kind: "unavailable", reason: "unmetered" }],
			[
				"anthropic unknown observed",
				{ kind: "unavailable", reason: "unknown-model" },
			],
			[
				"anthropic outside table",
				{ kind: "unavailable", reason: "unknown-model" },
			],
			["openai metered", { kind: "openai-request", model: "openai/gpt-5.5" }],
			[
				"openai other observed",
				{ kind: "unavailable", reason: "unknown-model" },
			],
			[
				"openai bare observed",
				{ kind: "openai-request", model: "openai/gpt-5.5" },
			],
			["mixed routes", { kind: "unavailable", reason: "mixed" }],
			[
				"superseded route ignored",
				{ kind: "anthropic-gateway", model: "claude-sonnet-5-5" },
			],
			["provider rejected only", { kind: "unavailable", reason: "missing" }],
			[
				"no journal for anthropic/claude-sonnet-5-5",
				{ kind: "unavailable", reason: "missing" },
			],
			[
				"no journal for google/gemini",
				{ kind: "unavailable", reason: "missing" },
			],
		],
		stored: [
			{ kind: "anthropic-gateway", model: "claude-opus-5" },
			{ kind: "openai-request", model: "openai/gpt-5.5" },
			{ kind: "unavailable", reason: "mixed" },
			null,
			null,
			null,
			null,
			null,
		],
		families: ["anthropic", "openai", null],
		cross: [
			[false, true, false],
			[true, false, false],
			[false, false, false],
		],
		labels: [
			[
				"context-isolated, anthropic author, family checked at certification",
				"context-isolated, same family, not cross-family",
				"context-isolated, different family, cross-family",
				"context-isolated, unknown family, not cross-family",
			],
			[
				"context-isolated, openai author, family checked at certification",
				"context-isolated, different family, builder not OpenAI, not cross-family",
				"context-isolated, same family, not cross-family",
				"context-isolated, unknown family, not cross-family",
			],
			[
				"context-isolated, unknown author, family checked at certification",
				"context-isolated, unknown family, not cross-family",
				"context-isolated, unknown family, not cross-family",
				"context-isolated, unknown family, not cross-family",
			],
		],
		certified: [
			["incomplete", "incomplete", "incomplete"],
			["complete", "incomplete", "incomplete"],
			["incomplete", "incomplete", "incomplete"],
		],
		simplifyOnly: "incomplete",
		withFamily: [
			{ a: 1, family: { kind: "anthropic-gateway", model: "claude-opus-5" } },
			{ a: 1 },
			{ a: 1 },
		],
	},
	settlements: {
		settled: {
			routes: ["model-anthropic", "model-openai"],
			requests: [
				{
					req: 1,
					route: "model-anthropic",
					bound: { inputTokens: 10, maxOutputTokens: 20 },
					laterResults: [
						{
							status: 200,
							observedModel: "<undefined>",
							kind: "Metered",
							usage: { kind: "metered", inputTokens: 99, outputTokens: 99 },
						},
					],
					status: 200,
					observedModel: "claude-sonnet-5-5",
					kind: "Metered",
					usage: { kind: "metered", inputTokens: 3, outputTokens: 4 },
				},
				{
					req: 3,
					route: "model-anthropic",
					bound: { inputTokens: 10, maxOutputTokens: 20 },
					laterResults: [],
					kind: "Uncertain",
					result: {
						status: 200,
						observedModel: "<undefined>",
						kind: "Unmetered",
						usage: { kind: "missing", inputTokens: null, outputTokens: null },
						reason: "missing-usage",
					},
				},
				{
					req: 4,
					route: "model-anthropic",
					bound: null,
					laterResults: [],
					status: 400,
					observedModel: "<undefined>",
					kind: "ProviderRejected",
					completed: true,
					usage: { kind: "missing", inputTokens: null, outputTokens: null },
				},
				{
					req: 5,
					route: "model-openai",
					bound: null,
					laterResults: [],
					status: 502,
					observedModel: "<undefined>",
					kind: "Unreachable",
					origin: "gateway-before-headers",
					usage: { kind: "missing", inputTokens: null, outputTokens: null },
				},
				{
					req: null,
					route: "model-anthropic",
					bound: null,
					laterResults: [],
					status: 200,
					observedModel: "<undefined>",
					kind: "Metered",
					usage: { kind: "metered", inputTokens: 8, outputTokens: 9 },
				},
				{
					req: 6,
					route: "model-openai",
					bound: { inputTokens: 10, maxOutputTokens: 20 },
					laterResults: [],
					status: 200,
					observedModel: "<undefined>",
					kind: "Unmetered",
					usage: { kind: "partial", inputTokens: 7, outputTokens: null },
					reason: "partial-usage",
				},
				{
					req: 2,
					route: "model-anthropic",
					bound: { inputTokens: 10, maxOutputTokens: 20 },
					laterResults: [],
					kind: "Uncertain",
					result: null,
				},
			],
		},
		replies: [
			{
				req: 1,
				route: "model-anthropic",
				bound: { inputTokens: 10, maxOutputTokens: 20 },
				laterResults: [
					{
						status: 200,
						observedModel: "<undefined>",
						kind: "Metered",
						usage: { kind: "metered", inputTokens: 99, outputTokens: 99 },
					},
				],
				status: 200,
				observedModel: "claude-sonnet-5-5",
				kind: "Metered",
				usage: { kind: "metered", inputTokens: 3, outputTokens: 4 },
			},
			{
				status: 200,
				observedModel: "<undefined>",
				kind: "Unmetered",
				usage: { kind: "missing", inputTokens: null, outputTokens: null },
				reason: "missing-usage",
			},
			{
				req: 4,
				route: "model-anthropic",
				bound: null,
				laterResults: [],
				status: 400,
				observedModel: "<undefined>",
				kind: "ProviderRejected",
				completed: true,
				usage: { kind: "missing", inputTokens: null, outputTokens: null },
			},
			{
				req: 5,
				route: "model-openai",
				bound: null,
				laterResults: [],
				status: 502,
				observedModel: "<undefined>",
				kind: "Unreachable",
				origin: "gateway-before-headers",
				usage: { kind: "missing", inputTokens: null, outputTokens: null },
			},
			{
				req: null,
				route: "model-anthropic",
				bound: null,
				laterResults: [],
				status: 200,
				observedModel: "<undefined>",
				kind: "Metered",
				usage: { kind: "metered", inputTokens: 8, outputTokens: 9 },
			},
			{
				req: 6,
				route: "model-openai",
				bound: { inputTokens: 10, maxOutputTokens: 20 },
				laterResults: [],
				status: 200,
				observedModel: "<undefined>",
				kind: "Unmetered",
				usage: { kind: "partial", inputTokens: 7, outputTokens: null },
				reason: "partial-usage",
			},
			null,
		],
		anthropic: {
			routes: ["model-anthropic", "model-openai"],
			requests: [
				{
					req: 1,
					route: "model-anthropic",
					bound: { inputTokens: 10, maxOutputTokens: 20 },
					laterResults: [
						{
							status: 200,
							observedModel: "<undefined>",
							kind: "Metered",
							usage: { kind: "metered", inputTokens: 99, outputTokens: 99 },
						},
					],
					status: 200,
					observedModel: "claude-sonnet-5-5",
					kind: "Metered",
					usage: { kind: "metered", inputTokens: 3, outputTokens: 4 },
				},
				{
					req: 3,
					route: "model-anthropic",
					bound: { inputTokens: 10, maxOutputTokens: 20 },
					laterResults: [],
					kind: "Uncertain",
					result: {
						status: 200,
						observedModel: "<undefined>",
						kind: "Unmetered",
						usage: { kind: "missing", inputTokens: null, outputTokens: null },
						reason: "missing-usage",
					},
				},
				{
					req: 4,
					route: "model-anthropic",
					bound: null,
					laterResults: [],
					status: 400,
					observedModel: "<undefined>",
					kind: "ProviderRejected",
					completed: true,
					usage: { kind: "missing", inputTokens: null, outputTokens: null },
				},
				{
					req: null,
					route: "model-anthropic",
					bound: null,
					laterResults: [],
					status: 200,
					observedModel: "<undefined>",
					kind: "Metered",
					usage: { kind: "metered", inputTokens: 8, outputTokens: 9 },
				},
				{
					req: 2,
					route: "model-anthropic",
					bound: { inputTokens: 10, maxOutputTokens: 20 },
					laterResults: [],
					kind: "Uncertain",
					result: null,
				},
			],
		},
		running: {
			routes: ["model-anthropic", "model-openai"],
			requests: [
				{
					req: 1,
					route: "model-anthropic",
					bound: { inputTokens: 10, maxOutputTokens: 20 },
					laterResults: [
						{
							status: 200,
							observedModel: "<undefined>",
							kind: "Metered",
							usage: { kind: "metered", inputTokens: 99, outputTokens: 99 },
						},
					],
					status: 200,
					observedModel: "claude-sonnet-5-5",
					kind: "Metered",
					usage: { kind: "metered", inputTokens: 3, outputTokens: 4 },
				},
				{
					req: 3,
					route: "model-anthropic",
					bound: { inputTokens: 10, maxOutputTokens: 20 },
					laterResults: [],
					kind: "Uncertain",
					result: {
						status: 200,
						observedModel: "<undefined>",
						kind: "Unmetered",
						usage: { kind: "missing", inputTokens: null, outputTokens: null },
						reason: "missing-usage",
					},
				},
				{
					req: 4,
					route: "model-anthropic",
					bound: null,
					laterResults: [],
					status: 400,
					observedModel: "<undefined>",
					kind: "ProviderRejected",
					completed: true,
					usage: { kind: "missing", inputTokens: null, outputTokens: null },
				},
				{
					req: 5,
					route: "model-openai",
					bound: null,
					laterResults: [],
					status: 502,
					observedModel: "<undefined>",
					kind: "Unreachable",
					origin: "gateway-before-headers",
					usage: { kind: "missing", inputTokens: null, outputTokens: null },
				},
				{
					req: null,
					route: "model-anthropic",
					bound: null,
					laterResults: [],
					status: 200,
					observedModel: "<undefined>",
					kind: "Metered",
					usage: { kind: "metered", inputTokens: 8, outputTokens: 9 },
				},
				{
					req: 6,
					route: "model-openai",
					bound: { inputTokens: 10, maxOutputTokens: 20 },
					laterResults: [],
					status: 200,
					observedModel: "<undefined>",
					kind: "Unmetered",
					usage: { kind: "partial", inputTokens: 7, outputTokens: null },
					reason: "partial-usage",
				},
				{
					req: 2,
					route: "model-anthropic",
					bound: { inputTokens: 10, maxOutputTokens: 20 },
					laterResults: [],
					kind: "Dispatched",
				},
			],
		},
		charge: {
			tokens: 14,
			dispatched: 4,
			settled: 5,
			unmetered: 3,
			uncertain: 2,
			uncertainTokens: 60,
		},
		empty: [
			{ routes: [], requests: [] },
			{
				tokens: 0,
				dispatched: 0,
				settled: 0,
				unmetered: 0,
				uncertain: 0,
				uncertainTokens: 0,
			},
		],
	},
	results: [
		{ kind: "passed", usage: 42, outcome: { kind: "passed" } },
		{
			kind: "failed",
			exit: "crashed",
			usage: 42,
			outcome: { kind: "failed", exit: "crashed" },
		},
		{ kind: "refused", usage: 42, outcome: { kind: "refused" } },
		{
			kind: "budget_exhausted",
			cap: "run_tokens",
			usage: 42,
			outcome: { kind: "budget_exhausted", cap: "run_tokens" },
		},
	],
	efficiency: {
		unknown: {
			assistantTurns: null,
			modelRequests: null,
			inputTokens: null,
			outputTokens: null,
			firstInputTokens: null,
			lastInputTokens: null,
			maxInputTokens: null,
			toolResultBytes: null,
			initialPromptBytes: null,
			initialSourceBytes: null,
			excerptOmissions: null,
			sourceCapHits: null,
			guardStops: null,
		},
		parsed: [
			{
				assistantTurns: null,
				modelRequests: null,
				inputTokens: null,
				outputTokens: null,
				firstInputTokens: null,
				lastInputTokens: null,
				maxInputTokens: null,
				toolResultBytes: null,
				initialPromptBytes: null,
				initialSourceBytes: null,
				excerptOmissions: null,
				sourceCapHits: null,
				guardStops: null,
			},
			{
				assistantTurns: null,
				modelRequests: null,
				inputTokens: 5,
				outputTokens: null,
				firstInputTokens: null,
				lastInputTokens: null,
				maxInputTokens: null,
				toolResultBytes: null,
				initialPromptBytes: null,
				initialSourceBytes: null,
				excerptOmissions: null,
				sourceCapHits: null,
				guardStops: null,
			},
			null,
			null,
			null,
			null,
			null,
		],
		journals: [
			{
				modelRequests: null,
				inputTokens: null,
				outputTokens: null,
				firstInputTokens: null,
				lastInputTokens: null,
				maxInputTokens: null,
			},
			{
				modelRequests: null,
				inputTokens: null,
				outputTokens: null,
				firstInputTokens: null,
				lastInputTokens: null,
				maxInputTokens: null,
			},
			{
				modelRequests: null,
				inputTokens: null,
				outputTokens: null,
				firstInputTokens: null,
				lastInputTokens: null,
				maxInputTokens: null,
			},
			{
				modelRequests: 1,
				inputTokens: 3,
				outputTokens: 4,
				firstInputTokens: 3,
				lastInputTokens: 3,
				maxInputTokens: 3,
			},
			{
				modelRequests: 2,
				inputTokens: null,
				outputTokens: null,
				firstInputTokens: 3,
				lastInputTokens: null,
				maxInputTokens: null,
			},
			{
				modelRequests: null,
				inputTokens: null,
				outputTokens: null,
				firstInputTokens: null,
				lastInputTokens: null,
				maxInputTokens: null,
			},
			{
				modelRequests: null,
				inputTokens: null,
				outputTokens: null,
				firstInputTokens: null,
				lastInputTokens: null,
				maxInputTokens: null,
			},
			{
				modelRequests: null,
				inputTokens: null,
				outputTokens: null,
				firstInputTokens: null,
				lastInputTokens: null,
				maxInputTokens: null,
			},
			{
				modelRequests: null,
				inputTokens: null,
				outputTokens: null,
				firstInputTokens: null,
				lastInputTokens: null,
				maxInputTokens: null,
			},
		],
		aggregate: [
			{
				assistantTurns: null,
				modelRequests: null,
				inputTokens: null,
				outputTokens: null,
				firstInputTokens: null,
				lastInputTokens: null,
				maxInputTokens: null,
				toolResultBytes: null,
				initialPromptBytes: null,
				initialSourceBytes: null,
				excerptOmissions: null,
				sourceCapHits: null,
				guardStops: null,
			},
			{
				assistantTurns: null,
				modelRequests: null,
				inputTokens: null,
				outputTokens: null,
				firstInputTokens: null,
				lastInputTokens: null,
				maxInputTokens: null,
				toolResultBytes: null,
				initialPromptBytes: null,
				initialSourceBytes: null,
				excerptOmissions: null,
				sourceCapHits: null,
				guardStops: null,
			},
			{
				assistantTurns: 8,
				modelRequests: null,
				inputTokens: null,
				outputTokens: null,
				firstInputTokens: 1,
				lastInputTokens: 5,
				maxInputTokens: 6,
				toolResultBytes: null,
				initialPromptBytes: null,
				initialSourceBytes: null,
				excerptOmissions: null,
				sourceCapHits: null,
				guardStops: null,
			},
		],
	},
	usage: [
		{
			version: 1,
			runId: "f21c0d488635c8290e6ad6cc2fbeb0eb58b0bd343b514a778709e5e4857b4648",
			stage: "build",
			attempt: 2,
			startedAt: 1,
			deadline: 2,
			turns: 3,
			usage: {
				total: 10,
				parent: 6,
				children: 4,
				gateway: null,
				unreadChildren: 0,
				byModel: { "openai/gpt-5.5": 10 },
			},
			efficiency: "<undefined>",
		},
		{
			version: 1,
			runId: "f21c0d488635c8290e6ad6cc2fbeb0eb58b0bd343b514a778709e5e4857b4648",
			stage: "build",
			attempt: 2,
			startedAt: 1,
			deadline: 2,
			turns: 3,
			usage: {
				total: 10,
				parent: 6,
				children: 4,
				gateway: null,
				unreadChildren: 0,
				byModel: { "openai/gpt-5.5": 10 },
			},
			efficiency: {
				assistantTurns: null,
				modelRequests: null,
				inputTokens: null,
				outputTokens: null,
				firstInputTokens: null,
				lastInputTokens: null,
				maxInputTokens: null,
				toolResultBytes: null,
				initialPromptBytes: null,
				initialSourceBytes: null,
				excerptOmissions: null,
				sourceCapHits: null,
				guardStops: null,
			},
		},
		{
			version: 1,
			runId: "f21c0d488635c8290e6ad6cc2fbeb0eb58b0bd343b514a778709e5e4857b4648",
			stage: "build",
			attempt: 2,
			startedAt: 1,
			deadline: 2,
			turns: 3,
			usage: {
				total: 10,
				parent: 6,
				children: 4,
				gateway: null,
				unreadChildren: 0,
				byModel: { "openai/gpt-5.5": 10 },
			},
			efficiency: "<undefined>",
		},
		null,
		null,
		null,
		null,
		null,
		null,
	],
	run: {
		caps: [120000, 300000],
		checks: [
			"baseline_tests",
			"typecheck",
			"lint",
			"format",
			"main_tests",
			"candidate_tests",
			"heldout",
		],
		digests: [
			"e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855",
			"039058c6f2c0cb492c533b0a4d14ef77cc0f78abccced5287d84a1a2011cfb81",
			true,
			false,
		],
		run: '{"id":"2f2405b6c276ca2d6bf0836c8e72e89bad493a031a5b34c45c09f3a485c1edb6","ticket":{"provider":"github","key":"o/r#7","url":"https://x/7"},"repo":"o/r","baseSha":"aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa","progress":{"kind":"active","stage":"admit"}}',
		finished:
			'{"id":"2f2405b6c276ca2d6bf0836c8e72e89bad493a031a5b34c45c09f3a485c1edb6","ticket":{"provider":"github","key":"o/r#7","url":"https://x/7"},"repo":"o/r","baseSha":"aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa","progress":{"kind":"finished","outcome":{"kind":"needs_info","questions":["why?"]}}}',
		outcomes: ["<undefined>", { kind: "needs_info", questions: ["why?"] }],
	},
	verdicts: {
		verdicts: [true, false, false, false, false, true, false],
		blocks: [false, false, true, false, true, false],
	},
};
