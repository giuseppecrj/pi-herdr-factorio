import { createHash } from "node:crypto";

export type NonEmpty<T> = [T, ...T[]];

export type TicketRef = {
	provider: "github" | "linear";
	key: string;
	url: string;
};

export type Stage =
	| "admit"
	| "specify"
	| "accept"
	| "build"
	| "validate"
	| "review"
	| "land";

export type Digest = string & { readonly __brand: "Digest" };

const SHA256_HEX = /^[0-9a-f]{64}$/;

export function isDigest(input: string): input is Digest {
	return SHA256_HEX.test(input);
}

export function digestOf(content: string | Uint8Array): Digest {
	const hex = createHash("sha256").update(content).digest("hex");

	if (!isDigest(hex)) throw new Error(`sha256 produced a malformed digest`);

	return hex;
}

/**
 * One run per admitted label event. Every crash path, marker and state
 * directory computes the same ID from the same event.
 */
export function runIdOf(input: {
	repo: string;
	issue: number;
	eventId: string;
}): Digest {
	return digestOf(
		JSON.stringify(["github", input.repo, input.issue, input.eventId]),
	);
}

export type Outcome =
	| { kind: "landed"; mergeSha: string }
	| { kind: "needs_info"; questions: NonEmpty<string> }
	| {
			kind: "rejected";
			reason: "policy" | "unauthorized" | "disabled" | "forbidden_paths";
	  }
	| { kind: "failed"; stage: Stage; evidence: string }
	| { kind: "budget_exhausted"; stage: Stage }
	| { kind: "cancelled" };

export type RejectReason = Extract<Outcome, { kind: "rejected" }>["reason"];

export type CheckResult = {
	name: string;
	passed: boolean;
	detail?: string;
};

export type Verdict = {
	patchDigest: Digest;
	pass: boolean;
	checks: CheckResult[];
};

export function verdictPasses(verdict: Verdict): boolean {
	return verdict.pass && verdict.checks.every((check) => check.passed);
}

export type Progress =
	| { kind: "active"; stage: Stage }
	| { kind: "finished"; outcome: Outcome };

export interface Run {
	id: string;
	ticket: TicketRef;
	repo: string;
	baseSha: string;
	contractDigest?: Digest;
	acceptanceDigest?: Digest;
	patchDigest?: Digest;
	verdict?: Verdict;
	repairRounds: number;
	progress: Progress;
}

export function startRun(input: {
	id: string;
	ticket: TicketRef;
	repo: string;
	baseSha: string;
}): Run {
	return {
		id: input.id,
		ticket: input.ticket,
		repo: input.repo,
		baseSha: input.baseSha,
		repairRounds: 0,
		progress: { kind: "active", stage: "admit" },
	};
}

export function outcomeOf(run: Run): Outcome | undefined {
	return run.progress.kind === "finished" ? run.progress.outcome : undefined;
}
