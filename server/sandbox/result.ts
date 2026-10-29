import type { Digest, Stage } from "../../src/run.ts";
import type { ModelId, StageBudget } from "../../src/workflow.ts";
import type { RouteSummary } from "./control.ts";

/** Per-stage launch settings. Round 2 moves `StageLaunch` input onto this. */
export type StageRunSettings = {
	readonly model: ModelId;
	readonly fallback: ModelId | null;
	readonly budget: StageBudget;
	readonly maxTokens: number | null;
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
	readonly assetsDigest: string;
	readonly versions: PinnedVersions;
	readonly pricing: "unavailable";
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
