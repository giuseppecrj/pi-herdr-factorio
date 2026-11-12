import type { CandidateEvent } from "../candidate/handoff.ts";
import {
	ReviewEvidenceUnavailable,
	type ReviewInputRefusal,
} from "../candidate/review.ts";
import type { CandidateExecution } from "../candidate/state.ts";
import type { Digest } from "../core/run.ts";
import type { AttemptEnd } from "../ledger/schema.ts";
import type { ActiveRun } from "./claims.ts";
import type { StageOutput } from "./launch.ts";
import type { OrchestratorInput } from "./orchestrator.ts";

/** A candidate event an execution produced, queued for the next candidate commit. */
export type CandidateResult = {
	readonly runId: Digest;
	readonly event: CandidateEvent;
	readonly disposition?: AttemptEnd["disposition"];
	readonly refusal?: ReviewInputRefusal;
};

export function queueReviewRefusal(
	results: CandidateResult[],
	execution: Extract<CandidateExecution, { stage: "review" }>,
	tokens: number | null,
): void {
	if (tokens !== null)
		results.push({
			runId: execution.runId,
			event: { kind: "execution_progress", execution, tokens },
		});
	results.push({
		runId: execution.runId,
		event: {
			kind: "review_settled",
			execution,
			tokens: null,
			result: { kind: "failed" },
		},
	});
}

export async function recoverCandidate(
	input: Pick<OrchestratorInput, "executor" | "files">,
	results: CandidateResult[],
	recovery: Set<Digest>,
	run: ActiveRun,
): Promise<void> {
	const state = run.handoff;
	const executor = input.executor;

	if (state?.kind !== "selected" || !(await executor.reconciled())) return;

	for (const account of state.accounts) {
		if (account.settlement === "settled") continue;
		const execution = account.execution;

		const tokens = await executor.spent({
			runId: execution.runId,
			stage: execution.stage,
			attempt: execution.attempt,
			round: execution.round,
			execution,
		});

		let output: StageOutput | null;

		try {
			output = await executor.output({
				runId: execution.runId,
				stage: execution.stage,
				attempt: execution.attempt,
				round: execution.round,
				execution,
				workflowSha: execution.workflowSha,
				workflowDigest: execution.workflowDigest,
			});
		} catch (error) {
			if (
				!(error instanceof ReviewEvidenceUnavailable) ||
				execution.stage !== "review"
			)
				throw error;
			queueReviewRefusal(results, execution, tokens);
			continue;
		}

		const ended = await input.files.accounting?.readAttempt(
			run.runId,
			execution.stage,
			execution.round,
			execution.attempt,
		);

		if (ended === undefined && input.files.accounting !== undefined) continue;

		if (
			ended !== null &&
			ended !== undefined &&
			ended.disposition !== "completed"
		)
			output = null;
		let event: CandidateEvent;

		if (
			output instanceof Object &&
			output.kind === "pending" &&
			tokens !== null
		) {
			event = { kind: "resume_execution", execution, tokens };
		} else if (execution.stage === "review") {
			const patch = await executor.candidate?.patch(state, execution.round);
			event = {
				kind: "review_settled",
				execution,
				tokens,
				result:
					output instanceof Object && output.kind === "review" && patch != null
						? { kind: "passed", review: output.receipt, patch }
						: output instanceof Object && output.kind === "refused"
							? { kind: "failed", reason: output.reason }
							: { kind: "failed" },
			};
		} else
			event = {
				kind: "repair_settled",
				execution,
				tokens,
				result:
					output instanceof Object &&
					output.kind === "build" &&
					output.result.kind === "found"
						? { kind: "passed", patch: output.result.receipt }
						: output instanceof Object &&
								output.kind === "build" &&
								output.result.kind === "blocked" &&
								output.result.reason === "repair_no_change"
							? { kind: "no_change" }
							: { kind: "failed" },
			};
		results.push({
			runId: run.runId,
			event,
			refusal:
				output instanceof Object && output.kind === "refused"
					? output
					: undefined,
			disposition:
				ended?.disposition ??
				(event.kind === "resume_execution"
					? undefined
					: event.result.kind === "passed"
						? "completed"
						: "interrupted"),
		});
	}

	recovery.delete(run.runId);
}
