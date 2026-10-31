import { checkLandPrecondition } from "./policy.ts";
import {
	type Digest,
	type NonEmpty,
	type Outcome,
	type RejectReason,
	type Run,
	type Stage,
	type Verdict,
	verdictPasses,
} from "./run.ts";

export const MAX_REPAIR_ROUNDS = 2;

export const STAGE_ORDER = [
	"admit",
	"specify",
	"accept",
	"build",
	"validate",
	"review",
	"land",
] as const satisfies readonly Stage[];

/**
 * Where a stage runs and what it can reach. Only the controller uses the
 * GitHub integration; a sandboxed model stage has no GitHub access at all.
 */
export type StageProfile = {
	modelAccess: "none" | "judge" | "full";
	runsIn: "controller" | "sandbox";
	githubAccess: string;
};

export const STAGE_PROFILES: Record<Stage, StageProfile> = {
	admit: {
		modelAccess: "none",
		runsIn: "controller",
		githubAccess: "issues: write",
	},
	specify: { modelAccess: "full", runsIn: "sandbox", githubAccess: "none" },
	accept: { modelAccess: "full", runsIn: "sandbox", githubAccess: "none" },
	build: { modelAccess: "full", runsIn: "sandbox", githubAccess: "none" },
	validate: {
		modelAccess: "none",
		runsIn: "controller",
		githubAccess: "contents: write, actions: write",
	},
	review: { modelAccess: "full", runsIn: "sandbox", githubAccess: "none" },
	land: {
		modelAccess: "none",
		runsIn: "controller",
		githubAccess: "contents: write, pull-requests: write, issues: write",
	},
};

export function nextStage(stage: Stage): Stage | undefined {
	return STAGE_ORDER[STAGE_ORDER.indexOf(stage) + 1];
}

export function formatStageTable(): string {
	const rows = STAGE_ORDER.map((stage) => {
		const profile = STAGE_PROFILES[stage];

		return [stage, profile.runsIn, profile.modelAccess, profile.githubAccess];
	});

	const table = [
		["stage", "runs in", "model access", "github access"],
		...rows,
	];

	const widths = [0, 1, 2, 3].map((column) =>
		Math.max(...table.map((row) => row[column]?.length ?? 0)),
	);

	return table
		.map((row) =>
			row
				.map((cell, column) => cell.padEnd(widths[column] ?? 0))
				.join("  ")
				.trimEnd(),
		)
		.join("\n");
}

export type RunEvent =
	| { kind: "admitted" }
	| { kind: "specified"; contractDigest: Digest }
	| { kind: "needs_info"; questions: NonEmpty<string> }
	| { kind: "accepted"; acceptanceDigest: Digest }
	| { kind: "built"; patchDigest: Digest }
	| {
			kind: "candidate";
			candidateSha: string;
			heldoutDigest: Digest;
			ciRunId: number;
	  }
	| { kind: "validated"; verdict: Verdict }
	| { kind: "reviewed"; blockingFindings: string[] }
	| {
			kind: "landed";
			mergeSha: string;
			currentTip?: string;
			currentGate?: string;
	  }
	| { kind: "stage_failed"; evidence: string }
	| { kind: "budget_exhausted" }
	| { kind: "rejected"; reason: Exclude<RejectReason, "disabled"> }
	| { kind: "kill_switch_off" }
	| { kind: "cancelled" };

export type Transition =
	| { kind: "advanced"; run: Run }
	| { kind: "invalid"; reason: string };

function advanced(run: Run): Transition {
	return { kind: "advanced", run };
}

function invalid(reason: string): Transition {
	return { kind: "invalid", reason };
}

function finish(run: Run, outcome: Outcome): Transition {
	return advanced({ ...run, progress: { kind: "finished", outcome } });
}

function moveTo(run: Run, stage: Stage, patch: Partial<Run> = {}): Transition {
	return advanced({ ...run, ...patch, progress: { kind: "active", stage } });
}

const STALE_ON_REBUILD: Pick<
	Run,
	| "patchDigest"
	| "verdict"
	| "candidateSha"
	| "gateSha"
	| "ciRunId"
	| "heldoutDigest"
> = {
	patchDigest: undefined,
	verdict: undefined,
	candidateSha: undefined,
	gateSha: undefined,
	ciRunId: undefined,
	heldoutDigest: undefined,
};

function repairOrFail(run: Run, stage: Stage, evidence: string): Transition {
	if (run.repairRounds >= MAX_REPAIR_ROUNDS) {
		return finish(run, { kind: "failed", stage, evidence });
	}

	return moveTo(run, "build", {
		repairRounds: run.repairRounds + 1,
		...STALE_ON_REBUILD,
	});
}

function failureEvidence(verdict: Verdict): string {
	const failed = verdict.checks.filter((check) => !check.passed);

	if (failed.length === 0) return "verdict did not pass";

	return `failed checks: ${failed.map((check) => check.name).join(", ")}`;
}

function wrongStage(event: RunEvent, stage: Stage): Transition {
	return invalid(`${event.kind} is not valid during ${stage}`);
}

export function advance(run: Run, event: RunEvent): Transition {
	const { progress } = run;

	if (progress.kind === "finished") {
		return invalid(`run already finished: ${progress.outcome.kind}`);
	}

	const { stage } = progress;

	switch (event.kind) {
		case "kill_switch_off":
			return finish(run, { kind: "rejected", reason: "disabled" });
		case "cancelled":
			return finish(run, { kind: "cancelled" });
		case "rejected":
			return finish(run, { kind: "rejected", reason: event.reason });
		case "stage_failed":
			return finish(run, { kind: "failed", stage, evidence: event.evidence });
		case "budget_exhausted":
			return finish(run, { kind: "budget_exhausted", stage });
		case "admitted":
			return stage === "admit"
				? moveTo(run, "specify")
				: wrongStage(event, stage);
		case "specified":
			return stage === "specify"
				? moveTo(run, "accept", { contractDigest: event.contractDigest })
				: wrongStage(event, stage);
		case "needs_info":
			return stage === "specify"
				? finish(run, { kind: "needs_info", questions: event.questions })
				: wrongStage(event, stage);
		case "accepted":
			return stage === "accept"
				? moveTo(run, "build", { acceptanceDigest: event.acceptanceDigest })
				: wrongStage(event, stage);
		case "built":
			return stage === "build"
				? moveTo(run, "validate", { patchDigest: event.patchDigest })
				: wrongStage(event, stage);
		case "candidate":
			return stage === "validate"
				? moveTo(run, "validate", {
						candidateSha: event.candidateSha,
						heldoutDigest: event.heldoutDigest,
						ciRunId: event.ciRunId,
					})
				: wrongStage(event, stage);
		case "validated": {
			if (stage !== "validate") return wrongStage(event, stage);

			if (event.verdict.patchDigest !== run.patchDigest) {
				return invalid("verdict is bound to a different patch");
			}

			if (
				event.verdict.candidateSha !== run.candidateSha ||
				event.verdict.acceptanceDigest !== run.acceptanceDigest ||
				event.verdict.heldoutDigest !== run.heldoutDigest ||
				event.verdict.ciRunId !== run.ciRunId
			)
				return invalid("verdict is bound to different CI inputs");

			if (!verdictPasses(event.verdict)) {
				return repairOrFail(run, stage, failureEvidence(event.verdict));
			}

			return moveTo(run, "review", {
				verdict: event.verdict,
				gateSha: event.verdict.gateSha,
			});
		}

		case "reviewed": {
			if (stage !== "review") return wrongStage(event, stage);

			if (event.blockingFindings.length > 0) {
				return repairOrFail(
					run,
					stage,
					`blocking findings: ${event.blockingFindings.join("; ")}`,
				);
			}

			return moveTo(run, "land");
		}

		case "landed": {
			if (stage !== "land") return wrongStage(event, stage);

			const check = checkLandPrecondition(run, {
				currentTip: event.currentTip,
				currentGate: event.currentGate,
			});

			if (check.kind === "blocked") {
				return invalid(`land precondition not met: ${check.reason}`);
			}

			return finish(run, { kind: "landed", mergeSha: event.mergeSha });
		}

		default: {
			const _exhaustive: never = event;

			return _exhaustive;
		}
	}
}
