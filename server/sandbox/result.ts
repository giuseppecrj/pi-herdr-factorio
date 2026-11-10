import type { Digest, SandboxStage as Stage } from "../../src/run.ts";
import type { FamilyInput } from "../../src/review.ts";
import type { ModelId, StageBudget } from "../../src/workflow.ts";
import type { RouteSummary } from "./control.ts";
import {
	countOf,
	fieldOf,
	objectOf,
	parseJson,
	type JsonValue,
} from "./json.ts";

export const EFFICIENCY_COUNTS = [
	"assistantTurns",
	"modelRequests",
	"inputTokens",
	"outputTokens",
	"firstInputTokens",
	"lastInputTokens",
	"maxInputTokens",
	"toolResultBytes",
	"initialPromptBytes",
	"initialSourceBytes",
	"excerptOmissions",
	"sourceCapHits",
	"guardStops",
] as const;

export type EfficiencyFacts = {
	readonly [K in (typeof EFFICIENCY_COUNTS)[number]]: number | null;
};

export type GuardStop =
	| "accept_tool_limit"
	| "accept_request_limit"
	| "accept_length";

export function unknownEfficiency(): EfficiencyFacts {
	// SAFETY: every declared numeric field is initialized to unavailable.
	return Object.fromEntries(
		EFFICIENCY_COUNTS.map((key) => [key, null]),
	) as EfficiencyFacts;
}

export function parseEfficiency(
	value: JsonValue | undefined,
): EfficiencyFacts | null {
	const record = objectOf(value);

	if (
		record === null ||
		Object.keys(record).length !== EFFICIENCY_COUNTS.length
	)
		return null;
	const facts = { ...unknownEfficiency() };

	for (const key of EFFICIENCY_COUNTS) {
		const raw = record[key];
		const number = raw === null ? null : countOf(raw);

		if (raw !== null && number === null) return null;
		facts[key] = number;
	}

	return facts;
}

/** Request journal metering is diagnostic, never a replacement for charged tokens. */
export function requestEfficiency(
	journal: string | null,
): Pick<
	EfficiencyFacts,
	| "modelRequests"
	| "inputTokens"
	| "outputTokens"
	| "firstInputTokens"
	| "lastInputTokens"
	| "maxInputTokens"
> {
	const unknown = {
		modelRequests: null,
		inputTokens: null,
		outputTokens: null,
		firstInputTokens: null,
		lastInputTokens: null,
		maxInputTokens: null,
	};

	if (journal === null || journal === "" || !journal.endsWith("\n"))
		return unknown;
	const requests = new Set<number>();

	const results = new Map<
		number,
		{ input: number | null; output: number | null }
	>();

	for (const line of journal.split("\n").filter((line) => line !== "")) {
		const record = objectOf(parseJson(line));
		const req = countOf(fieldOf(record, "req"));

		if (record === null || req === null) return unknown;

		if (record.kind === "dispatch") requests.add(req);
		else if (record.kind === "result") {
			const value = {
				input: countOf(record.inputTokens),
				output: countOf(record.outputTokens),
			};

			const previous = results.get(req);

			if (
				previous !== undefined &&
				JSON.stringify(previous) !== JSON.stringify(value)
			)
				return unknown;
			results.set(req, value);
		} else return unknown;
	}

	if (
		requests.size === 0 ||
		[...results.keys()].some((req) => !requests.has(req))
	)
		return unknown;
	const inputs = [...requests].map((req) => results.get(req)?.input ?? null);
	const outputs = [...requests].map((req) => results.get(req)?.output ?? null);

	const sum = (items: (number | null)[]) =>
		items.every((n) => n !== null) ? items.reduce((a, b) => a + b, 0) : null;

	return {
		modelRequests: requests.size,
		inputTokens: sum(inputs),
		outputTokens: sum(outputs),
		firstInputTokens: inputs[0] ?? null,
		lastInputTokens: inputs.at(-1) ?? null,
		maxInputTokens: inputs.every((n) => n !== null)
			? Math.max(...inputs)
			: null,
	};
}

/** Inputs are non-overlapping executions in execution order, never aggregates plus their leaves. */
export function aggregateEfficiency(
	records: readonly EfficiencyFacts[],
): EfficiencyFacts {
	if (records.length === 0) return unknownEfficiency();
	const facts = { ...unknownEfficiency() };

	for (const key of EFFICIENCY_COUNTS) {
		const values = records.map((r) => r[key]);

		facts[key] = values.every((n) => n !== null)
			? values.reduce((a, b) => a + b, 0)
			: null;
	}

	facts.firstInputTokens = records[0]?.firstInputTokens ?? null;
	facts.lastInputTokens = records.at(-1)?.lastInputTokens ?? null;
	facts.maxInputTokens = records.every((r) => r.maxInputTokens !== null)
		? Math.max(...records.map((r) => r.maxInputTokens ?? 0))
		: null;

	return facts;
}

export type ExecutionUsage = {
	readonly version: 1;
	readonly runId: Digest;
	readonly stage: Stage;
	readonly attempt: number;
	readonly startedAt: number;
	readonly deadline: number;
	readonly turns: number;
	readonly usage: StageUsage;
	readonly efficiency?: EfficiencyFacts;
};

export function executionUsageOf(
	value: JsonValue | undefined,
	binding: {
		readonly runId: Digest;
		readonly stage: Stage;
		readonly attempt: number;
	},
): ExecutionUsage | null {
	const record = objectOf(value);
	const usage = objectOf(fieldOf(record, "usage"));

	const numbers = ["startedAt", "deadline", "turns"].map((key) =>
		countOf(fieldOf(record, key)),
	);

	const [startedAt, deadline, turns] = numbers;
	const total = countOf(fieldOf(usage, "total"));
	const parent = countOf(fieldOf(usage, "parent"));
	const children = countOf(fieldOf(usage, "children"));
	const unreadChildren = countOf(fieldOf(usage, "unreadChildren"));

	const gateway =
		fieldOf(usage, "gateway") === null
			? null
			: countOf(fieldOf(usage, "gateway"));

	const models = objectOf(fieldOf(usage, "byModel"));

	if (
		fieldOf(record, "version") !== 1 ||
		fieldOf(record, "runId") !== binding.runId ||
		fieldOf(record, "stage") !== binding.stage ||
		fieldOf(record, "attempt") !== binding.attempt ||
		startedAt == null ||
		deadline == null ||
		turns == null ||
		deadline < startedAt ||
		total === null ||
		parent === null ||
		children === null ||
		unreadChildren === null ||
		models === null ||
		total < Math.max(parent + children, gateway ?? 0)
	)
		return null;
	const byModel: Record<string, number> = {};

	for (const [key, value] of Object.entries(models)) {
		const tokens = countOf(value);

		if (tokens === null) return null;
		byModel[key] = tokens;
	}

	return {
		version: 1,
		...binding,
		startedAt,
		deadline,
		turns,
		usage: { total, parent, children, gateway, unreadChildren, byModel },
		efficiency: parseEfficiency(fieldOf(record, "efficiency")) ?? undefined,
	};
}

/** Per-stage launch settings. Round 2 moves `StageLaunch` input onto this. */
export type StageRunSettings = {
	readonly model: ModelId;
	readonly fallback: ModelId | null;
	readonly budget: StageBudget;
	readonly maxTokens: number | null;
	/**
	 * `stages.review.seats.code-review.model`. Only the review launch sets
	 * it, and only the code-review seat runs it; absent or `null`, that seat
	 * runs `model`.
	 */
	readonly codeReviewModel?: ModelId | null;
};

export type FailedExit = "error" | "malformed" | "crashed" | "aborted";

export type BudgetCap = "turns" | "tokens" | "wall" | "run_tokens";

/** Structured refusal signals only. A Responses `refusal` text part is not one. */
export type RefusalSignal =
	| "incomplete_content_filter"
	| "failed_content_filter"
	| "content_policy"
	| "refusal";

export type Settlement = {
	readonly event: "agent_settled" | "none";
	readonly aborted: boolean | null;
};

export type SessionOutcome =
	| { readonly kind: "passed" }
	| { readonly kind: "failed"; readonly exit: FailedExit }
	| { readonly kind: "refused" }
	| { readonly kind: "budget_exhausted"; readonly cap: BudgetCap };

export type FallbackRecord = {
	readonly requested: ModelId;
	readonly observed: string | null;
	readonly outcome: SessionOutcome;
	readonly settlement: Settlement;
	readonly refusal: RefusalSignal | null;
};

export type PinnedVersions = {
	readonly pi: string;
	readonly piHerdrAgents: string;
	readonly piHerdrPstack: string;
};

export type StageUsage = {
	readonly total: number;
	readonly parent: number;
	readonly children: number;
	readonly byModel: Readonly<Record<string, number>>;
	readonly gateway: number | null;
	readonly unreadChildren: number;
};

/**
 * Where one Pi session's sandbox stderr was kept: a file the factory named,
 * beside the receipt, and the bytes the sandbox wrote in all. The file holds
 * at most the last 64 KiB. Its text is untrusted and is never copied here.
 */
export type StderrRecord = {
	readonly session: number;
	readonly file: string;
	readonly bytes: number;
};

/**
 * Where a passing session's final assistant text was kept: `output.txt`
 * beside the receipt, mode 0600. `bytes` is the text's full UTF-8 size and
 * `kept` what the file holds, at most `OUTPUT_MAX_BYTES`. The text is
 * untrusted and is never copied into the receipt.
 */
export type OutputRecord = {
	readonly file: "output.txt";
	readonly bytes: number;
	readonly kept: number;
};

/**
 * The host-side record of one stage attempt, written under the run's stage
 * directory and never into a marker. It holds only numbers, enums, model
 * ids, digests and the factory-built names of files beside it: no model
 * text, provider error text, stderr text or other paths.
 */
export type StageReceipt = {
	readonly version: 1;
	readonly runId: Digest;
	readonly stage: Stage;
	readonly attempt: number;
	readonly outcome: SessionOutcome;
	readonly settlement: Settlement;
	readonly models: {
		readonly requested: ModelId;
		readonly observed: string | null;
	};
	readonly fallback: FallbackRecord | null;
	readonly refusal: RefusalSignal | null;
	readonly wallMs: number;
	readonly turns: number;
	readonly usage: StageUsage;
	readonly egress: readonly RouteSummary[] | null;
	readonly stderr: readonly StderrRecord[];
	readonly output: OutputRecord | null;
	readonly assetsDigest: string;
	readonly versions: PinnedVersions;
	readonly pricing: "unavailable";
	/** Absent on legacy receipts; null fields mean unavailable, never zero. */
	readonly efficiency?: EfficiencyFacts;
	readonly guardStop?: GuardStop | null;
	readonly draftRuns?: number;
	readonly draftRevisionTokens?: number;
	readonly draftSkips?: readonly ("tokens" | "wall")[];
	/**
	 * The answering session's family, from this attempt's request journal when
	 * the host wrote the receipt. Absent on receipts written before F10c and
	 * by hosts that keep no journal.
	 */
	readonly family?: FamilyInput;
};

export type StageResult =
	| {
			readonly kind: "passed";
			readonly usage: number;
			readonly receipt: StageReceipt;
	  }
	| {
			readonly kind: "failed";
			readonly exit: FailedExit;
			readonly usage: number;
			readonly receipt: StageReceipt;
	  }
	| {
			readonly kind: "refused";
			readonly usage: number;
			readonly receipt: StageReceipt;
	  }
	| {
			readonly kind: "budget_exhausted";
			readonly cap: BudgetCap;
			readonly usage: number;
			readonly receipt: StageReceipt;
	  };

export function stageResult(receipt: StageReceipt): StageResult {
	const usage = receipt.usage.total;
	const outcome = receipt.outcome;

	if (outcome.kind === "failed") {
		return { kind: "failed", exit: outcome.exit, usage, receipt };
	}

	if (outcome.kind === "budget_exhausted") {
		return { kind: "budget_exhausted", cap: outcome.cap, usage, receipt };
	}

	return { kind: outcome.kind, usage, receipt };
}
