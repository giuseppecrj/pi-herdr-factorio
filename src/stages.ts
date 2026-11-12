import {
	beginCandidate,
	candidateProjection,
	handoffCandidate,
	type AdmissionPin,
	type CandidateEvent,
	type CandidateEffect,
} from "./handoff.ts";
import type { PatchReceipt } from "./build.ts";
import {
	type Digest,
	type NonEmpty,
	type Outcome,
	type RejectReason,
	type Run,
} from "./core/run.ts";

import { STAGE_ORDER, type Stage, type SandboxStage } from "./core/stages.ts";

export { MAX_REPAIR_ROUNDS } from "./handoff.ts";

export type StageProfile = {
	modelAccess: "none" | "judge" | "full";
	runsIn: "controller" | "sandbox";
	githubAccess: string;
};

export const STAGE_PROFILES: Record<SandboxStage, StageProfile> = {
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
	maintain: { modelAccess: "judge", runsIn: "sandbox", githubAccess: "none" },
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

import { matchingBaseProof } from "./diagnosis.ts";

export type RunEvent =
	| { kind: "admitted" }
	| { kind: "specified"; contractDigest: Digest }
	| { kind: "needs_info"; questions: NonEmpty<string> }
	| { kind: "accepted"; proof: import("./diagnosis.ts").BaseProof }
	| {
			kind: "built";
			pin: AdmissionPin;
			patch: PatchReceipt;
			priorTokens: number;
	  }
	| { kind: "candidate"; event: CandidateEvent }
	| { kind: "stage_failed"; evidence: string }
	| { kind: "budget_exhausted" }
	| { kind: "rejected"; reason: Exclude<RejectReason, "disabled"> }
	| { kind: "cancelled" };

export type Transition =
	| { kind: "advanced"; run: Run; effect: CandidateEffect | null }
	| { kind: "invalid"; reason: string };

function advanced(run: Run, effect: CandidateEffect | null = null): Transition {
	return { kind: "advanced", run, effect };
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

export function advance(run: Run, event: RunEvent): Transition {
	if (run.handoff !== undefined) {
		if (event.kind !== "candidate")
			return invalid(
				"candidate lifecycle requires a controller observation or captured execution result",
			);
		const step = handoffCandidate(run.handoff, event.event);

		return advanced(
			{
				...run,
				handoff: step.state,
				progress: candidateProjection(step.state).progress,
			},
			step.effect,
		);
	}

	if (run.progress.kind === "finished")
		return invalid(`run already finished: ${run.progress.outcome.kind}`);

	if (run.progress.kind !== "active")
		return invalid("waiting requires candidate evidence");
	const stage = run.progress.stage;

	const wrongStage = () =>
		invalid(`${event.kind} is not valid during ${stage}`);

	switch (event.kind) {
		case "cancelled":
			return finish(run, { kind: "cancelled" });
		case "rejected":
			return finish(run, { kind: "rejected", reason: event.reason });
		case "stage_failed":
			return finish(run, { kind: "failed", stage, evidence: event.evidence });
		case "budget_exhausted":
			return finish(run, { kind: "budget_exhausted", stage });
		case "admitted":
			return stage === "admit" ? moveTo(run, "specify") : wrongStage();
		case "specified":
			return stage === "specify"
				? moveTo(run, "accept", { contractDigest: event.contractDigest })
				: wrongStage();
		case "needs_info":
			return stage === "specify"
				? finish(run, { kind: "needs_info", questions: event.questions })
				: wrongStage();
		case "accepted": {
			if (stage !== "accept") return wrongStage();
			const binding = event.proof.binding;

			if (
				!matchingBaseProof(event.proof, binding) ||
				binding.runId !== run.id ||
				binding.repo !== run.repo ||
				binding.baseSha !== run.baseSha ||
				binding.contractDigest !== run.contractDigest
			)
				return invalid("acceptance qualification binding mismatch");

			return moveTo(run, "build", {
				acceptanceDigest: binding.acceptanceDigest,
			});
		}

		case "built": {
			if (stage !== "build") return wrongStage();

			if (
				event.pin.runId !== run.id ||
				event.pin.repo !== run.repo ||
				event.pin.originalBase !== run.baseSha ||
				event.pin.contractDigest !== run.contractDigest ||
				event.pin.acceptanceDigest !== run.acceptanceDigest
			)
				return invalid("candidate admission binding mismatch");
			const state = beginCandidate(event.pin, event.patch, event.priorTokens);

			return advanced({
				...run,
				handoff: state,
				progress: candidateProjection(state).progress,
			});
		}

		case "candidate":
			return invalid("candidate event requires a candidate book");
		default: {
			const exhaustive: never = event;

			return invalid(`unsupported execution event: ${String(exhaustive)}`);
		}
	}
}
