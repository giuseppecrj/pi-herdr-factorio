import type {
	AcceptanceQualification,
	BaseRefusal,
} from "../candidate/diagnosis.ts";
import { type ModelStage, type Stage, isModelStage } from "../core/stages.ts";
import type { AttemptEnd, BudgetCapName } from "../ledger/schema.ts";
import type { TerminalCause } from "../ledger/terminal.ts";
import {
	type Marker,
	type TerminalStatus,
	isTerminal,
} from "../trust/markers.ts";
import { acceptanceReceipt } from "./base-check.ts";
import {
	type ActiveRun,
	type CleanLedger,
	type RunningPhase,
	desiredStatus,
} from "./claims.ts";
import type { StageResult } from "./launch.ts";
import type { OrchestratorInput } from "./orchestrator.ts";

/**
 * A stage that was aborted after its outcome was chosen, still cleaning up.
 * Usage it reports later is added to its run once, as `counted` grows.
 */
export type Draining = {
	readonly run: ActiveRun;
	readonly phase: RunningPhase;
	readonly since: number;
	counted: number;
};

/**
 * An attempt an earlier controller ran, whose records the run's usage may
 * not fully count yet: `base` is the run's usage before that attempt began.
 */
export type Unsettled = {
	readonly stage: ModelStage;
	readonly attempt: number;
	readonly base: number;
};

export type Totals = {
	claims: number;
	launches: number;
	retries: number;
	stalls: number;
	releases: number;
	failures: number;
	markersPosted: number;
	usage: number;
};

/** The sandbox's cap names, as the ledger names them. */
export const SANDBOX_CAPS = {
	tokens: "stage_tokens",
	run_tokens: "run_tokens",
	wall: "wall",
	turns: "turns",
} as const satisfies Record<
	Extract<StageResult, { kind: "budget_exhausted" }>["cap"],
	BudgetCapName
>;

/** A spent budget. A cap the sandbox did not report freezes as unavailable. */
export function budgetCause(
	stage: Stage,
	cap: BudgetCapName | null,
): TerminalCause {
	return { stage, class: "budget", reason: cap ?? "unreported" };
}

/** A failed preparation: its base refusal, or the input it refused. */
export function preparedCause(
	stage: Stage,
	prepared: { readonly why: string; readonly refusal?: BaseRefusal },
): TerminalCause {
	return prepared.refusal === undefined
		? inputCause(stage, prepared.why)
		: { stage, class: "base", reason: prepared.refusal.reason };
}

/** A stage input the controller refused, by its logged `why`. */
export function inputCause(stage: Stage, why: string): TerminalCause {
	return { stage, class: "input", reason: why };
}

export const END_STATUS: Readonly<
	Record<Exclude<StageResult["kind"], "failed">, TerminalStatus>
> = {
	passed: "stage_passed",
	refused: "failed",
	budget_exhausted: "budget_exhausted",
};

/**
 * Adds usage an aborted stage reported after its outcome was chosen, once.
 * The outcome stays as chosen. An entry ends when the stage settles.
 */
export function countLateUsage(
	input: Pick<OrchestratorInput, "log">,
	draining: Set<Draining>,
	totals: Totals,
): void {
	for (const entry of draining) {
		const { phase } = entry;
		const latest = Math.max(phase.usage, phase.result?.usage ?? 0);
		const late = latest - entry.counted;

		if (late > 0) {
			entry.counted = latest;
			entry.run.usage += late;
			totals.usage += late;
			input.log("stage_late_usage", {
				issue: entry.run.issue,
				runId: entry.run.runId,
				usage: late,
			});
		}

		if (phase.result !== null) draining.delete(entry);
	}
}

/**
 * Raises the run's usage to `base` plus what the unsettled attempt's
 * records hold, when that is more. The records hold the whole attempt, so
 * a share the run already counts is not counted again.
 */
export async function reconcileSpent(
	input: Pick<OrchestratorInput, "executor" | "log">,
	totals: Totals,
	run: ActiveRun,
): Promise<void> {
	const unsettled = run.unsettled;

	if (unsettled === null) return;

	const spent = await input.executor
		.spent({
			runId: run.runId,
			stage: unsettled.stage,
			attempt: unsettled.attempt,
			round: run.round ?? 0,
		})
		.catch(() => null);

	const late = spent === null ? 0 : unsettled.base + spent - run.usage;

	if (late <= 0) return;

	run.usage += late;
	totals.usage += late;
	input.log("stage_late_usage", {
		issue: run.issue,
		runId: run.runId,
		usage: late,
		attempt: unsettled.attempt,
	});
}

/**
 * Counts what an adopted run's attempts are known to have spent beyond its
 * marker: the attempt before the marker's, whose late usage the marker may
 * lack, and, when `interrupted`, the attempt the marker names as running.
 * Each is measured from the run's usage before that attempt began, read
 * from the ledger, so an amount the marker already counts is not counted
 * twice.
 */
export async function accountAdopted(
	input: Pick<OrchestratorInput, "executor" | "log">,
	totals: Totals,
	run: ActiveRun,
	marker: Marker,
	ledger: CleanLedger,
	interrupted: boolean,
): Promise<void> {
	const stage = marker.stage;

	if (!isModelStage(stage) || (run.round ?? 0) !== (marker.round ?? 0)) return;

	const previous = marker.attempt - 1;

	const base =
		ledger.markers.findLast(
			({ marker: entry }) =>
				entry.runId === run.runId &&
				entry.stage === stage &&
				(entry.round ?? 0) === (run.round ?? 0) &&
				entry.attempt === previous,
		)?.marker.usage ?? null;

	if (base !== null) {
		run.unsettled = { stage, attempt: previous, base };
		await reconcileSpent(input, totals, run);
	}

	if (interrupted) {
		run.unsettled = { stage, attempt: marker.attempt, base: run.usage };
		await reconcileSpent(input, totals, run);
	}
}

/**
 * Counts what a released adopted run's attempts spent beyond its usage,
 * once nothing a previous controller left can still add to it: the
 * unsettled attempt's records again, and the current attempt's earlier
 * executions unless that attempt is the unsettled one. False while a
 * leftover may still be running, so the release waits.
 */
export async function countReleased(
	input: Pick<OrchestratorInput, "executor" | "log">,
	totals: Totals,
	run: ActiveRun,
): Promise<boolean> {
	if (!(await input.executor.reconciled().catch(() => false))) {
		return false;
	}

	await reconcileSpent(input, totals, run);

	const stage = run.stage;

	if (isModelStage(stage) && run.unsettled?.attempt !== run.attempt) {
		const prior = await attemptSpent(input, run, stage);

		if (prior > 0) {
			run.usage += prior;
			totals.usage += prior;
			input.log("stage_late_usage", {
				issue: run.issue,
				runId: run.runId,
				usage: prior,
				attempt: run.attempt,
			});
		}
	}

	run.unsettled = null;
	run.adopted = false;

	return true;
}

/**
 * What earlier executions of the run's current attempt spent, which its
 * usage does not count: a marker counts none of its own attempt until that
 * attempt ends. A replay of a `claimed`, `blocked` or `retrying` attempt
 * whose `running` marker never landed has such executions on disk. The
 * launch adds this to the new execution's usage, so the attempt is counted
 * once when it ends.
 */
export async function attemptSpent(
	input: Pick<OrchestratorInput, "executor">,
	run: ActiveRun,
	stage: ModelStage,
): Promise<number> {
	const spent = await input.executor
		.spent({
			runId: run.runId,
			stage,
			attempt: run.attempt,
			round: run.round ?? 0,
		})
		.catch(() => null);

	return spent ?? 0;
}

export function recordAttempt(
	run: ActiveRun,
	disposition: AttemptEnd["disposition"],
	attempt = run.attempt,
	next?: AttemptEnd["next"],
): void {
	const phase = run.phase;
	const status = desiredStatus(phase);

	run.attemptEnd = {
		v: 1,
		runId: run.runId,
		stage: run.stage,
		round: run.round ?? 0,
		attempt,
		disposition,
		usage: run.usage,
		next:
			next ??
			(phase.kind === "retry_queued"
				? { kind: "retry", attempt: run.attempt, dueAt: phase.dueAt }
				: phase.kind === "base_check"
					? { kind: "base_retry", attempt: run.attempt, dueAt: phase.dueAt }
					: isTerminal(status) && phase.kind !== "reporting"
						? { kind: "end", status }
						: { kind: "continue" }),
	};
}

/**
 * Tokens accept attempts 1 to `through` used, or `null` when any attempt
 * that ran a model has no spend record. Attempts after the bound suite was
 * stored, through `reference.acceptAttempt`, only reran its base check.
 */
export async function acceptSpent(
	input: Pick<OrchestratorInput, "executor" | "files">,
	run: ActiveRun,
	reference: AcceptanceQualification,
	through: number,
): Promise<number | null> {
	const receipt = await acceptanceReceipt(input, reference);

	if (receipt === null) return null;
	const stored = receipt.storedAttempt ?? reference.storedAttempt;
	let total = 0;

	for (let attempt = 1; attempt <= through; attempt++) {
		if (attempt > stored && attempt <= reference.acceptAttempt) continue;

		const spent = await input.executor
			.spent({ runId: run.runId, stage: "accept", attempt, round: 0 })
			.catch(() => null);

		if (spent === null) return null;
		total += spent;
	}

	return total;
}

export async function saveAttempt(
	input: Pick<OrchestratorInput, "files" | "log">,
	run: ActiveRun,
): Promise<boolean> {
	const attemptEnd = run.attemptEnd;

	if (attemptEnd === undefined || input.files.accounting === undefined)
		return true;

	if (!(await input.files.accounting.writeAttempt(attemptEnd))) {
		input.log("attempt_end_unwritable", {
			runId: run.runId,
			stage: attemptEnd.stage,
			attempt: attemptEnd.attempt,
		});

		return false;
	}

	run.attemptEnd = undefined;

	return true;
}
