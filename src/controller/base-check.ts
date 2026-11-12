import {
	type AcceptanceQualification,
	type RetryFeedback,
	baseRefusalNotice,
	baseRetryFeedback,
	retriedRefusal,
	retryPending,
} from "../candidate/diagnosis.ts";
import type { ContractRead } from "../contract/artifacts.ts";
import { GitHubTicketAdapter, GitHubTicketWriter } from "../github/adapter.ts";
import type { ActiveRun } from "./claims.ts";
import { postKeyed } from "./effects.ts";
import type { OrchestratorInput } from "./orchestrator.ts";

/** New receipts bind the claim's stored attempt; legacy receipts predate that field. */
export async function acceptanceReceipt(
	input: Pick<OrchestratorInput, "files">,
	reference: AcceptanceQualification,
) {
	const receipt = await input.files.artifacts.receipt(
		reference.binding.runId,
		reference.binding.acceptanceDigest,
	);

	return receipt !== null &&
		receipt.contractDigest === reference.binding.contractDigest &&
		receipt.baseSha === reference.binding.baseSha &&
		(receipt.storedAttempt === undefined ||
			receipt.storedAttempt === reference.storedAttempt)
		? receipt
		: null;
}

/** Retires the refused first suite again; the store makes this idempotent. */
export async function retireRefused(
	input: Pick<OrchestratorInput, "files" | "log">,
	run: ActiveRun,
	reference: AcceptanceQualification,
): Promise<boolean> {
	const refused = reference.retry?.refused ?? reference.binding;
	const read = () => input.files.readContract(run.runId);
	let contract = await read();

	// One transient read failure must not strand a granted retry.
	if (contract.kind !== "found") contract = await read();

	const retired =
		contract.kind === "found" && contract.digest === refused.contractDigest
			? await input.files.artifacts.retire(
					run.runId,
					contract.contract,
					contract.digest,
					refused.acceptanceDigest,
				)
			: "refused";

	if (retired !== "retired")
		input.log("accept_retry_unavailable", {
			issue: run.issue,
			runId: run.runId,
			why: `retire_${retired}`,
		});

	return retired === "retired";
}

export async function retrySuite(
	input: Pick<OrchestratorInput, "files">,
	run: ActiveRun,
	contract: Extract<ContractRead, { kind: "found" }>,
) {
	const reference = run.baseCheck;

	if (reference === undefined || !retryPending(reference)) return undefined;

	const stored = await input.files.artifacts
		.readRetired(
			run.runId,
			contract.contract,
			contract.digest,
			reference.retry.refused.acceptanceDigest,
		)
		.catch(() => null);

	return stored?.kind === "found" ? stored.suite : null;
}

/** The pending retry's private feedback, from the refused suite's stored receipt. */
export async function retryFeedback(
	input: Pick<OrchestratorInput, "executor">,
	run: ActiveRun,
): Promise<RetryFeedback | undefined> {
	const reference = run.baseCheck;

	if (reference?.retry === undefined || !retryPending(reference))
		return undefined;
	const { refused, reason } = reference.retry;

	const stored = await input.executor
		.baseCheck?.({
			binding: refused,
			acceptAttempt: reference.acceptAttempt,
			storedAttempt: reference.storedAttempt,
			remainingAcceptMs: 0,
			signal: new AbortController().signal,
			readOnly: true,
		})
		.catch(() => undefined);

	return stored?.kind === "refused" &&
		stored.receipt !== undefined &&
		stored.failure.reason === reason
		? baseRetryFeedback(stored.receipt, stored.failure)
		: baseRetryFeedback(null, { reason, scenarios: [] });
}

/**
 * A granted retry withheld the first refusal's notice. A run that ends
 * before its retried suite qualifies or posts its own refusal posts that
 * first notice, keyed, so exactly once. False until it is posted.
 */
export async function postRetriedRefusal(
	input: Pick<OrchestratorInput, "platform" | "log">,
	adapter: GitHubTicketAdapter,
	writer: GitHubTicketWriter,
	run: ActiveRun,
): Promise<boolean> {
	const reference = run.baseCheck;

	if (
		run.phase.kind !== "ending" ||
		run.stage !== "accept" ||
		reference === undefined
	)
		return true;

	const failure =
		reference.kind === "refused"
			? reference.failure
			: reference.retry === undefined
				? null
				: retriedRefusal(reference.retry);

	if (failure === null) return true;
	const notice = baseRefusalNotice(failure);

	if (!(await postKeyed(input, adapter, writer, run, notice.key, notice.body)))
		return false;

	run.baseCheck = {
		...reference,
		kind: "refused",
		failure,
		noticeKey: notice.key,
	};

	return true;
}
