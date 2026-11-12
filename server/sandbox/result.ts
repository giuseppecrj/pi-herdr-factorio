import type { ModelId } from "../../src/config/schema.ts";
import type {
	BudgetCap,
	EfficiencyFacts,
	FailedExit,
	GuardStop,
	RefusalSignal,
	SessionOutcome,
	Settlement,
	StageUsage,
} from "../../src/core/execution.ts";
import type { FamilyInput } from "../../src/core/models.ts";
import type { Digest } from "../../src/core/run.ts";
import type { SandboxStage as Stage } from "../../src/core/stages.ts";
import type { RouteSummary } from "./control.ts";

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

export type ChildRunSummary = {
	readonly id: Digest;
	readonly tokens: number;
	readonly byModel: Readonly<Record<string, number>>;
};

/**
 * The host-side record of one stage attempt, written under the run's stage
 * directory and never into a marker. It holds only numbers, enums, model
 * ids, digests and the factory-built names of files beside it: no model
 * text, provider error text, stderr text or other paths.
 */
export type StageReceipt = {
	readonly version: 1;
	readonly measurementIdentity?: string;
	readonly childSummaries?: readonly ChildRunSummary[];
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
