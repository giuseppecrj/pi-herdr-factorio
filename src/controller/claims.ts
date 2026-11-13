import type { AcceptanceQualification } from "../candidate/diagnosis.ts";
import { candidateProjection } from "../candidate/handoff.ts";
import type { CandidateState } from "../candidate/state.ts";
import type { ValidationState } from "../candidate/validation.ts";
import type { GitSha } from "../config/schema.ts";
import type { ArtifactStore, ContractRead } from "../contract/artifacts.ts";
import type {
	AnswersRecord,
	Contract,
	ContractDigest,
	Link,
	Question,
	QuestionsDigest,
} from "../contract/contract.ts";
import type { Digest } from "../core/run.ts";
import type { Stage } from "../core/stages.ts";
import type { GitHubFailure } from "../github/adapter.ts";
import type { LedgerOutbox } from "../ledger/outbox.ts";
import type { AttemptEnd } from "../ledger/schema.ts";
import type { RunAccounting, TerminalCause } from "../ledger/terminal.ts";
import type { AdmittedReceipt } from "../trust/admission.ts";
import {
	type Marker,
	type MarkerDefect,
	type MarkerLedger,
	type RunStatus,
	type TerminalStatus,
	latestFor,
} from "../trust/markers.ts";
import type { RepoSlug } from "../trust/platform.ts";
import type { Unsettled } from "./accounting.ts";
import type { Effects } from "./effects.ts";
import type { StageEnd, StageInputs, StageOutput } from "./launch.ts";
import type { OrchestratorInput } from "./orchestrator.ts";

/**
 * A local record that a run holds a claim, so a restart finds it even after
 * the issue leaves the candidates. It mirrors the run's last marker known to
 * have landed: all `null` before the first, `status`, `stage`, `attempt` and
 * `usage` `null` in a record written before they existed, and `usage` alone
 * `null` in a record written before it existed.
 */
export type ClaimRecord = {
	readonly baseCheck?: AcceptanceQualification;
	readonly acceptWallMs?: number;
	readonly runId: Digest;
	readonly issue: number;
	readonly eventId: string;
	readonly seq: number | null;
	readonly status: RunStatus | null;
	readonly stage: Stage | null;
	readonly attempt: number | null;
	readonly usage: number | null;
	readonly labelFailures?: number;
	readonly validation?: ValidationState;
	readonly branch?: string | null;
	readonly candidate?: GitSha | null;
	readonly round?: number;
	readonly ciRun?: number | null;
	readonly handoff?: CandidateState;
	readonly enteredAt?: number;
	readonly marker?: Marker;
};

export type ConfirmedRecord = ClaimRecord & { readonly seq: number };

export type EndedRecord = {
	readonly claim: ConfirmedRecord;
	tick: number;
	confirmed: boolean;
	unwritten: boolean;
};

type WorkspaceState = "present" | "missing" | "unavailable";

export type LinkRead =
	| { readonly kind: "unlinked" }
	| { readonly kind: "none" }
	| { readonly kind: "found"; readonly link: Link }
	| { readonly kind: "unreadable" };

export interface RunFiles {
	readonly artifacts: ArtifactStore;
	readContract(runId: Digest): Promise<ContractRead>;
	workspacePath(runId: Digest): string;
	workspaceState(runId: Digest): Promise<WorkspaceState>;
	/** Creates the workspace empty, mode 0700, when it is missing. */
	ensureWorkspace(
		runId: Digest,
	): Promise<"present" | "created" | "unavailable">;
	listClaims(): Promise<ClaimRecord[]>;
	writeClaim(claim: ClaimRecord): Promise<boolean>;
	/** The private ledger outbox. A terminal snapshot is kept before its marker is posted. */
	readonly ledger?: LedgerOutbox;
	accounting?: RunAccounting;
	/** Native admission policy must be durable before the first claim or dispatch. */
	prepareRun?(input: {
		runId: Digest;
		repo: RepoSlug;
		workflowSha: GitSha;
		workflowDigest: Digest;
		startedAt: string;
		/** The admitted workflow's trusted `maxTokensPerRun`, or `null` when this process has not loaded those bytes. */
		runTokenCap: number | null;
	}): Promise<boolean>;
	terminalEvidence?(
		runId: Digest,
		floor: number,
		candidate: CandidateState | null,
	): Promise<import("../ledger/terminal.ts").TerminalEvidence>;
	/** Writes the contract and its receipt once. The same bytes again succeed. */
	writeContract(input: {
		readonly contract: Contract;
		readonly bytes: string;
		readonly digest: ContractDigest;
	}): Promise<boolean>;
	writeQuestions(input: {
		readonly runId: Digest;
		readonly questions: readonly Question[];
		readonly digest: QuestionsDigest;
	}): Promise<boolean>;
	/** The link and answers are written before the claim, so they may be replaced until then. */
	writeLink(runId: Digest, link: Link | null): Promise<boolean>;
	readLink(runId: Digest): Promise<LinkRead>;
	writeAnswers(record: AnswersRecord): Promise<boolean>;
	/** The answers record, or `null` when it is missing or its digest does not match. */
	readAnswers(runId: Digest): Promise<AnswersRecord | null>;
}

export type RetryCause = "stage_failed" | "stalled" | "interrupted";

export type RunPhase =
	| {
			readonly kind: "base_check";
			readonly abort: AbortController;
			dueAt: number;
			checking: boolean;
	  }
	| { readonly kind: "candidate"; readonly status: RunStatus }
	| { readonly kind: "evidence_missing" }
	| { readonly kind: "claimed" }
	| {
			readonly kind: "running";
			lastProgressAt: number;
			usage: number;
			readonly abort: AbortController;
			result: StageEnd | null;
	  }
	| {
			readonly kind: "blocked";
			readonly reason: "sandbox_unavailable";
	  }
	| { readonly kind: "retry_queued"; readonly dueAt: number }
	| {
			readonly kind: "recovering";
			readonly output: StageOutput;
	  }
	| {
			readonly kind: "reporting";
			readonly status: "stage_passed" | "needs_info";
			readonly effects: Effects;
	  }
	| { readonly kind: "ending"; readonly status: TerminalStatus };

export type RunningPhase = Extract<RunPhase, { kind: "running" }>;

/**
 * A marker whose POST did not return a comment. `unknown` may have landed,
 * so it is read back before anything else is posted for the issue.
 */
type InflightMarker = {
	readonly marker: Marker;
	readonly outcome: "unknown" | "rejected";
	/** The tick that posted it. A read-back waits for a later tick. */
	readonly tick: number;
};

/** One claimed run. The identity fields never change; the rest moves only inside a tick. */
export type ActiveRun = {
	attemptEnd?: AttemptEnd;
	baseCheck?: AcceptanceQualification;
	acceptWallMs?: number;
	/** Why the run is ending failed or budget-exhausted, kept for its ledger row. */
	cause?: TerminalCause;
	readonly runId: Digest;
	readonly issue: number;
	readonly eventId: string;
	readonly eventAt: string;
	readonly snapshotDigest: Digest;
	readonly workflowSha: GitSha;
	readonly workflowDigest: Digest;
	stage: Stage;
	attempt: number;
	usage: number;
	/** The highest marker `seq` on the issue that this controller knows landed. */
	seq: number;
	marked: Marker | null;
	inflight: InflightMarker | null;
	claimUnwritten: boolean;
	workspaceMissing: boolean;
	/** Set on a run adopted after a restart: its stage launches once more. */
	replay: boolean;
	/** Set on an adopted run until its next attempt starts, so that launch counts the latest records. */
	unsettled: Unsettled | null;
	/**
	 * Set on an adopted run until a stage of it starts here. Earlier
	 * executions of its attempt may hold spend its usage lacks, so its
	 * release counts them first.
	 */
	adopted: boolean;
	clearNeedsInfo: boolean;
	labelFailures: number;
	labelTick: number;
	inputs: StageInputs | null;
	phase: RunPhase;
	round?: number;
	handoff?: CandidateState;
	enteredAt?: number;
};

export type CleanLedger = Extract<MarkerLedger, { kind: "clean" }>;

/**
 * Why a claim could not be confirmed this tick, so it does not launch. `why`
 * names the read: the issue, its timeline, its marker ledger, or a timeline
 * with no entry for the run's ready event. `failure` is the read's failure
 * kind, `null` for a timeline with no entry.
 */
export type Unverified = {
	readonly why: "issue" | "timeline" | "ledger" | "timeline_entry";
	readonly failure: GitHubFailure["kind"] | null;
	/** First failed observation in this uninterrupted hold, on the controller clock. */
	readonly since: number;
};

/** Ephemeral evidence about a claim, never restored as launch permission. */
export type ClaimObservation =
	| {
			readonly kind: "owned_confirmed";
			readonly tick: number;
			readonly event: string;
			readonly ledgerSeq: number;
	  }
	| {
			readonly kind: "owned_unverified";
			readonly read: Unverified["why"];
			readonly failure: Unverified["failure"];
			readonly since: number;
	  }
	| { readonly kind: "foreign"; readonly runId: Digest }
	| { readonly kind: "corrupt"; readonly defect: MarkerDefect }
	| { readonly kind: "released"; readonly reason: ReleaseReason }
	| { readonly kind: "unclaimed" };

export type ReleaseReason = "closed" | "unlabeled" | "new_event" | "bot_actor";

export function claimProjection(
	observation: ClaimObservation,
	tick: number,
	event: string,
) {
	return {
		launch:
			observation.kind === "owned_confirmed" &&
			observation.tick === tick &&
			observation.event === event,
		unverified:
			observation.kind === "owned_unverified"
				? {
						why: observation.read,
						failure: observation.failure,
						since: observation.since,
					}
				: null,
	};
}

export function desiredStatus(phase: RunPhase): RunStatus {
	switch (phase.kind) {
		case "candidate":
			return phase.status;
		case "claimed":
			return "claimed";
		case "running":
		case "base_check":
			return "running";
		case "blocked":
		case "evidence_missing":
			return "blocked";
		case "retry_queued":
			return "retrying";
		case "recovering":
			return "running";
		case "reporting":
		case "ending":
			return phase.status;
		default: {
			const _exhaustive: never = phase;

			return _exhaustive;
		}
	}
}

export const FIRST_STAGE: Stage = "specify";

export function claimOf(run: ActiveRun): ClaimRecord {
	if (run.handoff !== undefined)
		return {
			runId: run.runId,
			issue: run.issue,
			eventId: run.eventId,
			seq: run.seq === 0 ? null : run.seq,
			status: run.seq === 0 ? null : desiredStatus(run.phase),
			stage: run.seq === 0 ? null : run.stage,
			attempt: run.seq === 0 ? null : run.attempt,
			usage: run.seq === 0 ? null : run.usage,
			round: run.round ?? 0,
			handoff: run.handoff,
			enteredAt: run.enteredAt,
		};

	const claim: ClaimRecord = {
		runId: run.runId,
		issue: run.issue,
		eventId: run.eventId,
		seq: run.marked === null ? null : run.seq,
		status: run.marked?.status ?? null,
		stage: run.marked?.stage ?? null,
		attempt: run.marked?.attempt ?? null,
		usage:
			run.baseCheck === undefined ? (run.marked?.usage ?? null) : run.usage,
	};

	const base =
		run.baseCheck === undefined
			? claim
			: {
					...claim,
					baseCheck: run.baseCheck,
					acceptWallMs: run.acceptWallMs ?? 0,
				};

	const retained = run.marked?.v === 3 ? { ...base, marker: run.marked } : base;

	return run.labelFailures === 0
		? retained
		: { ...retained, labelFailures: run.labelFailures };
}

export function recordOf(marker: Marker): ConfirmedRecord {
	const record = {
		runId: marker.runId,
		issue: marker.issue,
		eventId: marker.eventId,
		seq: marker.seq,
		status: marker.status,
		stage: marker.stage,
		attempt: marker.attempt,
		usage: marker.usage,
	};

	return marker.v === 3 ? { ...record, marker } : record;
}

export function markerOf(
	run: Omit<
		Marker,
		"v" | "repo" | "status" | "seq" | "branch" | "pr" | "cursor" | "handoff"
	> & {
		readonly round?: number;
		readonly handoff?: CandidateState;
	},

	next: Pick<Marker, "repo" | "status" | "seq" | "cursor">,
): Marker {
	const marker: Marker = {
		v: 2,
		runId: run.runId,
		repo: next.repo,
		issue: run.issue,
		eventId: run.eventId,
		eventAt: run.eventAt,
		snapshotDigest: run.snapshotDigest,
		workflowSha: run.workflowSha,
		workflowDigest: run.workflowDigest,
		stage: run.stage,
		status: next.status,
		attempt: run.attempt,
		seq: next.seq,
		branch: null,
		candidate: null,
		round: run.round ?? 0,
		ciRun: null,
		pr: null,
		usage: run.usage,
		cursor: next.cursor,
	};

	const state = run.handoff;

	if (state?.kind !== "selected") return marker;

	const projection = candidateProjection(state);

	return {
		...marker,
		v: 3,
		stage: projection.stage,
		attempt: projection.attempt,
		branch: state.current.validation?.publication?.branch ?? null,
		candidate: state.current.validation?.publication?.candidateSha ?? null,
		round: state.current.intent.round,
		ciRun: state.current.validation?.ciRunId ?? null,
		pr: state.published?.number ?? null,
		handoff: {
			generation: state.current.intent.generation,
			intentDigest: state.current.intent.digest,
			refreshes: [...state.history, state.current].filter(
				(g) => g.intent.origin.kind === "refresh",
			).length,
			reviewAttempts: [0, 1, 2].map((round) =>
				Math.max(
					0,
					...state.accounts
						.filter(
							(a) =>
								a.execution.stage === "review" && a.execution.round === round,
						)
						.map((a) => a.execution.attempt),
				),
			),
			promoted: state.published?.promoted.digest ?? null,
		},
	};
}

export function matchesRecord(
	marker: Marker,
	receipt: AdmittedReceipt,
): boolean {
	return (
		marker.eventAt === receipt.eventAt &&
		marker.snapshotDigest === receipt.snapshotDigest &&
		marker.workflowSha === receipt.baseSha &&
		marker.workflowDigest === receipt.workflowDigest
	);
}

export async function writeClaim(
	input: Pick<OrchestratorInput, "files" | "log">,
	run: ActiveRun,
): Promise<void> {
	const written = await input.files.writeClaim(claimOf(run));

	run.claimUnwritten = !written;

	if (!written) {
		input.log("claim_unwritable", {
			issue: run.issue,
			runId: run.runId,
		});
	}
}

export async function writeEnded(
	input: Pick<OrchestratorInput, "files" | "log">,
	ended: EndedRecord,
): Promise<void> {
	ended.unwritten = !(await input.files.writeClaim(ended.claim));

	if (ended.unwritten) {
		input.log("claim_unwritable", {
			issue: ended.claim.issue,
			runId: ended.claim.runId,
		});
	}
}

export async function localMarker(
	input: Pick<OrchestratorInput, "store" | "repo">,
	local: ConfirmedRecord,
	ledger: CleanLedger,
): Promise<Marker | null> {
	if (local.marker !== undefined) return local.marker;

	const stored = await input.store.read({
		repo: input.repo,
		issue: local.issue,
		eventId: local.eventId,
	});

	if (stored.kind !== "found") return null;

	const { receipt } = stored;
	const read = latestFor(ledger, local.runId)?.marker;

	return markerOf(
		{
			...local,
			eventAt: receipt.eventAt,
			snapshotDigest: receipt.snapshotDigest,
			workflowSha: receipt.baseSha,
			workflowDigest: receipt.workflowDigest,
			stage: local.stage ?? read?.stage ?? FIRST_STAGE,
			attempt: local.attempt ?? read?.attempt ?? 1,
			usage: local.usage ?? read?.usage ?? 0,
		},
		{
			repo: input.repo,
			status: local.status ?? read?.status ?? "claimed",
			seq: local.seq,
			cursor: null,
		},
	);
}

export async function admittedFields(
	input: Pick<OrchestratorInput, "store" | "repo">,
	claim: ClaimRecord,
): Promise<Pick<
	Marker,
	| "eventAt"
	| "snapshotDigest"
	| "workflowSha"
	| "workflowDigest"
	| "stage"
	| "attempt"
	| "usage"
> | null> {
	const stored = await input.store.read({
		repo: input.repo,
		issue: claim.issue,
		eventId: claim.eventId,
	});

	if (stored.kind !== "found") return null;

	return {
		eventAt: stored.receipt.eventAt,
		snapshotDigest: stored.receipt.snapshotDigest,
		workflowSha: stored.receipt.baseSha,
		workflowDigest: stored.receipt.workflowDigest,
		stage: claim.stage ?? FIRST_STAGE,
		attempt: claim.attempt ?? 1,
		usage: claim.usage ?? 0,
	};
}

export async function unadmitted(
	input: Pick<OrchestratorInput, "store" | "repo">,
	issue: number,
	eventId: string,
): Promise<boolean> {
	const stored = await input.store.read({
		repo: input.repo,
		issue,
		eventId,
	});

	return stored.kind === "absent";
}
