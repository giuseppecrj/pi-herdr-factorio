import type { Validator, ValidationState } from "./validation.ts";
import { MAX_REPAIR_ROUNDS } from "./stages.ts";
import {
	REVIEW_MAX_TOKENS,
	REPAIR_BUILD_MAX_TOKENS,
	REVIEW_TOOLS,
	type ReviewInput,
	type ReviewReceipt,
} from "./review.ts";
import { verdictPasses, type Verdict } from "./run.ts";

import {
	BUILD_TOOLS,
	BUILD_MAX_TOKENS,
	buildPrompt,
	visibleTestCommand,
	type PatchBinding,
	type PatchRead,
} from "./build.ts";
import {
	ACCEPTANCE_MAX_TOKENS,
	ACCEPTANCE_SKILLS,
	ACCEPTANCE_TOOLS,
	acceptancePrompt,
	writeAcceptance,
	type AcceptanceSuite,
} from "./accept.ts";
import type { ArtifactStore, ContractRead } from "./artifacts.ts";
import {
	type AdmissionStore,
	type Ambiguity,
	admitTicket,
	type AdmittedReceipt,
	FACTORY_REPOSITORIES,
	latestReadyEntry,
	type RefusalReason,
	readTickInputs,
	type SnapshotReader,
	type SnapshotSource,
	type TickReads,
} from "./admission.ts";
import {
	DEFAULT_PAGING,
	type GitHubFailure,
	type GitHubPaging,
	GitHubTicketAdapter,
	GitHubTicketWriter,
	type IssueRecord,
	type IssueComment,
	type CommentEdit,
	type Read,
	type TimelineEntry,
} from "./adapters/github.ts";
import type { Exec } from "./gh.ts";
import {
	CONTROLLER_LOGIN,
	currentMarker,
	formatMarker,
	isControllerComment,
	isTerminal,
	latestFor,
	type TrustedMarker,
	type Marker,
	type MarkerDefect,
	type MarkerLedger,
	markerLedger,
	type RunStatus,
	type TerminalStatus,
} from "./markers.ts";
import { hasWriteAccess, READY_LABEL } from "./policy.ts";
import { type Digest, type NonEmpty, runIdOf, type Stage } from "./run.ts";
import {
	type Answer,
	type AnswersRecord,
	answerBody,
	acceptanceKey,
	renderAcceptanceSummary,
	renderBuildSummary,
	buildKey,
	answersDigestOf,
	type Contract,
	CONTRACT_VERSION,
	contractBytes,
	type ContractDigest,
	contractDigestOf,
	contractKey,
	type InlinedFile,
	type Link,
	INLINE_TOTAL_BYTES,
	inlined,
	MAX_ANSWERS,
	NAMED_FILE_BYTES,
	NAMED_FILE_READ_BYTES,
	NEEDS_INFO_LABEL,
	namedFiles,
	parseSpecifyOutput,
	type Question,
	type QuestionsDigest,
	questionsDigestOf,
	questionsKey,
	questionsKeyOf,
	renderQuestions,
	renderSummary,
	SPECIFY_SKILLS,
	SPECIFY_TOOLS,
	specifyPrompt,
	type SpecifyReviewInput,
	withoutKey,
} from "./specify.ts";
import { isLogin } from "./adapters/github.ts";
import type {
	StageResult,
	StageRunSettings,
} from "../server/sandbox/result.ts";
import {
	DEFAULTS,
	type EnvLookup,
	type GitSha,
	MODEL_STAGES,
	type ModelStage,
	type RepoSlug,
	STAGE_CLEANUP_RESERVE_MS,
	type WorkflowConfig,
	parseWorkflow,
	WORKFLOW_PATH,
} from "./workflow.ts";
import { digestOf } from "./run.ts";

export type { StageResult };

/** Milliseconds since the epoch. Tests pass a fake. */
export type Clock = { now(): number };

/** How a stage launch ended before any model ran. */
export type StageLaunch =
	| {
			readonly kind: "unavailable";
			readonly stage: Stage;
			readonly reason: "sandbox_unavailable";
	  }
	| { readonly kind: "started"; readonly done: Promise<StageResult> };

export type StageLaunchInput = {
	readonly runId: Digest;
	readonly stage: ModelStage;
	readonly attempt: number;
	readonly workspace: string;
	readonly prompt: string;
	readonly specify?: SpecifyReviewInput;
	readonly round?: number;
	readonly review?: ReviewPreparation;
	readonly build?: {
		readonly binding: PatchBinding;
		readonly command: string;
		readonly allowNoChange: boolean;
	};
	readonly tools: readonly string[];
	readonly skills: readonly string[];
	readonly settings: StageRunSettings;
	readonly remainingRunTokens: number;
	readonly signal: AbortSignal;
	/** Called on every sign of life, with the tokens the stage has used so far. */
	readonly progress: (usage: number) => void;
};

export type ReviewPreparation = {
	readonly input: ReviewInput;
	readonly verdict: Verdict;
	readonly builder: string;
	readonly workspace: string;
};

export type StageOutput =
	| { readonly kind: "review"; readonly receipt: ReviewReceipt }
	| { readonly kind: "build"; readonly result: PatchRead }
	| string
	| { readonly kind: "pending" }
	| {
			readonly kind: "output";
			readonly text: string;
			readonly model: string;
			readonly observed: string | null;
	  };

type WorkflowPin = Pick<ActiveRun, "workflowSha" | "workflowDigest">;

export interface StageExecutor {
	prepareReview?(
		input: WorkflowPin & {
			runId: Digest;
			round: number;
			workspace: string;
		},
	): Promise<ReviewPreparation>;
	readonly validate?: Validator;
	cleanupValidation?(): Promise<void>;
	/** Stops whatever a previous controller left running. Called once, before the first tick adopts a run. */
	recover(): Promise<void>;
	/**
	 * Whether nothing a previous controller left can still be running, so
	 * `spent` no longer grows for its attempts. A reconcile that failed is
	 * tried again.
	 */
	reconciled(): Promise<boolean>;
	/** Whether the stage sandbox can run. A `blocked` run replays only after this passes. */
	preflight(): Promise<boolean>;
	/** Result usage is new spend; a resumed attempt's receipt also includes its recorded sessions. */
	launch(input: StageLaunchInput): Promise<StageLaunch>;
	/**
	 * Tokens an attempt an earlier controller ran is known to have used: its
	 * receipt's total, else its session receipts or gateway audit tallies. `null` when none exists.
	 */
	spent(input: {
		readonly runId: Digest;
		readonly stage: ModelStage;
		readonly attempt: number;
		readonly round?: number;
	}): Promise<number | null>;
	/**
	 * The final text of an execution of the attempt that passed and kept it,
	 * so a restart can finish a stage without running it again. Untrusted.
	 * `pending` resumes a recorded session sequence in the same attempt.
	 */
	output(
		input: {
			readonly runId: Digest;
			readonly attempt: number;
			readonly round?: number;
		} & (
			| { readonly stage: Exclude<ModelStage, "review"> }
			| ({ readonly stage: "review" } & WorkflowPin)
		),
	): Promise<StageOutput | null>;
	checkout(input: {
		readonly runId: Digest;
		readonly repo: RepoSlug;
		readonly sha: GitSha;
		readonly workspace: string;
		readonly build?: boolean;
		readonly round?: number;
	}): Promise<CheckoutResult>;
}

type StageEnd = Pick<StageResult, "kind" | "usage"> & {
	readonly output: string | null;
	readonly build?: PatchRead;
	readonly review?: ReviewReceipt;
	readonly model?: string;
	readonly observed?: string | null;
};

function isModelStage(stage: Stage): stage is ModelStage {
	return MODEL_STAGES.some((known) => known === stage);
}

/**
 * A local record that a run holds a claim, so a restart finds it even after
 * the issue leaves the candidates. It mirrors the run's last marker known to
 * have landed: all `null` before the first, `status`, `stage`, `attempt` and
 * `usage` `null` in a record written before they existed, and `usage` alone
 * `null` in a record written before it existed.
 */
export type ClaimRecord = {
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
};

type ConfirmedRecord = ClaimRecord & { readonly seq: number };

type EndedRecord = {
	readonly claim: ConfirmedRecord;
	tick: number;
	confirmed: boolean;
	unwritten: boolean;
};

type WorkspaceState = "present" | "missing" | "unavailable";

export type Checkout = {
	readonly files: readonly string[];
	/** A listed file's text, or `null` when it is over `capBytes` or unreadable. */
	read(path: string, capBytes: number): Promise<string | null>;
};

export type CheckoutResult =
	| { readonly kind: "ready"; readonly checkout: Checkout }
	| { readonly kind: "refused"; readonly reason: string }
	| { readonly kind: "unavailable" };

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
	| { readonly kind: "awaiting_ci" }
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

export type Effects =
	| {
			readonly kind: "build";
			readonly result: Extract<PatchRead, { kind: "found" }>;
	  }
	| { readonly kind: "review"; readonly receipt: ReviewReceipt }
	| {
			readonly kind: "acceptance";
			readonly contract: Contract;
			readonly contractDigest: ContractDigest;
			readonly suite: AcceptanceSuite;
			readonly model: string;
			readonly observed: string | null;
	  }
	| {
			readonly kind: "contract";
			readonly contract: Contract;
			readonly bytes: string;
			readonly digest: ContractDigest;
			readonly body: string;
			stored: boolean;
			posted: boolean;
	  }
	| {
			readonly kind: "questions";
			readonly questions: NonEmpty<Question>;
			readonly digest: QuestionsDigest;
			readonly body: string;
			stored: boolean;
			posted: boolean;
			labeled: boolean;
			unlabeled: boolean;
			labelTick: number;
	  };

type StageInputs = {
	readonly contract?: Extract<ContractRead, { kind: "found" }>;
	readonly files: ReadonlySet<string>;
	readonly source: SnapshotSource;
	readonly link: Link | null;
};

type Prepared = {
	readonly kind: "ready";
	/** `null` for a launch the sandbox will refuse, which reads no input. */
	readonly inputs: StageInputs | null;
	readonly prompt: string;
	readonly workspace?: string;
	readonly build?: StageLaunchInput["build"];
	readonly specify?: SpecifyReviewInput;
	readonly review?: ReviewPreparation;
};

const UNPREPARED: Prepared = { kind: "ready", inputs: null, prompt: "" };

type RunningPhase = Extract<RunPhase, { kind: "running" }>;

/**
 * A stage that was aborted after its outcome was chosen, still cleaning up.
 * Usage it reports later is added to its run once, as `counted` grows.
 */
type Draining = {
	readonly run: ActiveRun;
	readonly phase: RunningPhase;
	readonly since: number;
	counted: number;
};

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

/**
 * An attempt an earlier controller ran, whose records the run's usage may
 * not fully count yet: `base` is the run's usage before that attempt began.
 */
type Unsettled = {
	readonly stage: ModelStage;
	readonly attempt: number;
	readonly base: number;
};

/** One claimed run. The identity fields never change; the rest moves only inside a tick. */
export type ActiveRun = {
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
	validation?: ValidationState;
	round?: number;
};

/**
 * What the controller last decided for an issue at one `updated_at`. The
 * watermark is `updatedAt` with `observedAt`; the verdict, and a held run's
 * `eventId`, are the decision it guards.
 */
export type SeenIssue = {
	readonly updatedAt: string;
	/** The controller clock at the start of the tick whose reads made the verdict. */
	readonly observedAt: number;
	readonly verdict:
		| { readonly kind: "open"; readonly ledger: CleanLedger }
		| { readonly kind: "claimed" }
		| { readonly kind: "decided" }
		| {
				readonly kind: "refused";
				readonly reason: "answers_record_invalid" | "link_record_invalid";
		  }
		| { readonly kind: "corrupt" };
};

type Totals = {
	claims: number;
	launches: number;
	retries: number;
	stalls: number;
	releases: number;
	failures: number;
	markersPosted: number;
	usage: number;
};

/**
 * The single authority. `runs` holds every claim, keyed by issue: its keys are
 * Symphony's `claimed`, the `running` phases are `running`, and the
 * `retry_queued` phases are `retry_attempts`.
 */
export type ControllerState = {
	readonly runs: Map<number, ActiveRun>;
	readonly seen: Map<number, SeenIssue>;
	readonly corrupt: Map<
		number,
		{ readonly defect: MarkerDefect; readonly commentId: string }
	>;
	readonly totals: Totals;
};

type CleanLedger = Extract<MarkerLedger, { kind: "clean" }>;

export type GateReason =
	| "state_unavailable"
	| "locally_disabled"
	| "repo_switch_off"
	| "repo_switch_unavailable"
	| "workflow_unavailable"
	| "candidates_unavailable";

export type RunView = {
	readonly issue: number;
	readonly runId: Digest;
	readonly eventId: string;
	readonly stage: Stage;
	readonly status: RunStatus;
	readonly attempt: number;
	readonly seq: number;
	readonly markerPending: boolean;
	readonly workspace: "present" | "missing_replayed";
	readonly retryAt: string | null;
	readonly usage: number;
};

/** One tick's claim snapshot. Never carries issue text. */
export type TickReport = {
	readonly repo: RepoSlug;
	readonly at: string;
	readonly executionEnabled: boolean;
	readonly dispatch: {
		readonly enabled: boolean;
		readonly reasons: readonly GateReason[];
	};
	readonly workflowSha: GitSha | null;
	readonly maxConcurrent: number;
	/** Runs holding a slot. Above `maxConcurrent` only after the cap was lowered while they ran. */
	readonly active: number;
	readonly runs: readonly RunView[];
	readonly queued: readonly number[];
	/** Scoped issues that are not open `factory:ready` issues and hold no claim. */
	readonly absent: readonly number[];
	readonly refused: readonly {
		readonly issue: number;
		readonly reasons: readonly RefusalReason["kind"][];
	}[];
	readonly corrupt: readonly {
		readonly issue: number;
		readonly defect: MarkerDefect;
	}[];
	readonly ledgerBehind: readonly {
		readonly issue: number;
		readonly ledgerSeq: number;
		readonly localSeq: number;
	}[];
	readonly totals: Readonly<Totals>;
};

export type LogFields = Readonly<
	Record<string, string | number | boolean | null>
>;

export type Log = (event: string, fields: LogFields) => void;

type Limits = {
	readonly maxConcurrent: number;
	readonly maxAttempts: number;
	readonly maxBackoffMs: number;
	readonly maxTokensPerRun: number;
	stallMs(stage: Stage): number;
};

type Eligibility = "confirmed" | "unverified" | "released" | "dropped";

type ReleaseReason = "closed" | "unlabeled" | "new_event";

type Replacement = "current" | "unverified" | "unlabeled" | "new_event";

function replacedBy(
	timeline: readonly TimelineEntry[],
	event: { readonly eventId: string; readonly eventAt: string },
): Replacement {
	const latest = latestReadyEntry(timeline);

	if (latest.kind === "tied") return "new_event";

	if (latest.kind === "none") return "unverified";

	const { entry } = latest;

	if (entry.kind === "labeled" && entry.id === event.eventId) return "current";

	if (entry.at <= event.eventAt) return "unverified";

	return entry.kind === "unlabeled" ? "unlabeled" : "new_event";
}

const SETTLE_MS = 1000;

/**
 * Time past the cleanup reserve that the controller still waits for an
 * aborted stage. The runner ends its cleanup within the reserve of the
 * abort; this covers the receipt write and the tick that reads the result.
 */
const CLEANUP_GRACE_MS = 5_000;

const DRAIN_POLL_MS = 1000;

const END_STATUS: Readonly<
	Record<Exclude<StageResult["kind"], "failed">, TerminalStatus>
> = {
	passed: "stage_passed",
	refused: "failed",
	budget_exhausted: "budget_exhausted",
};

type ReportInput = {
	readonly now: number;
	readonly enabled: boolean;
	readonly reasons: readonly GateReason[];
	readonly limits: Limits | null;
	readonly queued: readonly number[];
	readonly absent: readonly number[];
	readonly refused: TickReport["refused"];
};

/**
 * `updated_at` has whole seconds, so a change later in the second the issue
 * was read keeps the same value. A watermark observed before that second, plus
 * `SETTLE_MS`, has passed is read again on the next tick.
 */
function settled(seen: SeenIssue): boolean {
	return seen.observedAt >= Date.parse(seen.updatedAt) + 1000 + SETTLE_MS;
}

function isClarificationPredecessor(
	prev: TrustedMarker,
	admitted: AdmittedReceipt,
	runId: Digest,
): boolean {
	return (
		prev.marker.status === "needs_info" &&
		prev.marker.runId !== runId &&
		admitted.eventAt > prev.marker.eventAt
	);
}

function isAnswerCandidate(
	comment: IssueComment,
	floor: bigint,
	labelAt: string,
): boolean {
	return (
		BigInt(comment.id) > floor &&
		comment.author !== null &&
		comment.author.type !== "Bot" &&
		!isControllerComment(comment) &&
		comment.createdAt <= labelAt
	);
}

function answerEditPrecedesLabel(edit: CommentEdit, labelAt: string): boolean {
	return edit.lastEditedAt === null || edit.lastEditedAt < labelAt;
}

function isReady(issue: IssueRecord): boolean {
	return issue.open && !issue.pullRequest && issue.labels.includes(READY_LABEL);
}

type Gate =
	| { readonly kind: "open"; readonly reads: TickReads }
	| { readonly kind: "closed"; readonly reasons: readonly GateReason[] };

/** Symphony §8.4: `min(10000 * 2^(retry - 1), maxBackoffMs)`, for the 1-based retry. */
export function backoffMs(retry: number, maxBackoffMs: number): number {
	return Math.min(10_000 * 2 ** (retry - 1), maxBackoffMs);
}

function limitsOf(config: WorkflowConfig): Limits {
	return {
		maxConcurrent: config.agent.maxConcurrent,
		maxAttempts: config.retry.maxAttempts,
		maxBackoffMs: config.retry.maxBackoffMs,
		maxTokensPerRun: config.usage.maxTokensPerRun,
		stallMs: (stage) => config.stages[stage].budget.stallMs,
	};
}

function refusalSettlesUntilEdited(reason: RefusalReason): boolean {
	switch (reason.kind) {
		case "pull_request":
		case "issue_closed":
		case "actor_withheld":
		case "unauthorized":
		case "answers_record_invalid":
		case "link_record_invalid":
			return true;
		case "ambiguous_snapshot":
			return ambiguityRecursOnReread(reason.detail);
		case "not_labeled":
		case "no_label_event":
		case "repo_not_allowed":
		case "state_unavailable":
		case "locally_disabled":
		case "repo_switch_off":
		case "repo_switch_unavailable":
		case "issue_unavailable":
		case "timeline_unavailable":
		case "permission_unavailable":
		case "snapshot_unavailable":
		case "workflow_unavailable":
		case "duplicate_event":
		case "state_unwritable":
			return false;
		default: {
			const _exhaustive: never = reason;

			return _exhaustive;
		}
	}
}

function ambiguityRecursOnReread(detail: Ambiguity): boolean {
	switch (detail) {
		case "label_events_same_second":
		case "renamed_since_label":
		case "edited_at_label_time":
		case "version_withheld":
		case "answer_at_label_time":
			return true;
		case "rename_history_incomplete":
		case "title_changed_between_reads":
		case "body_changed_between_reads":
		case "history_contradicts_last_edit":
		case "history_incomplete":
		case "history_without_original":
		case "history_disagrees_with_body":
		case "no_version_before_label":
			return false;
		default: {
			const _exhaustive: never = detail;

			return _exhaustive;
		}
	}
}

function desiredStatus(phase: RunPhase): RunStatus {
	switch (phase.kind) {
		case "claimed":
			return "claimed";
		case "running":
		case "awaiting_ci":
			return "running";
		case "blocked":
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

type WorkspacePreparation =
	| { readonly kind: "fresh" }
	| { readonly kind: "replayed_missing" }
	| { readonly kind: "unavailable" };

function holdsSlot(run: ActiveRun): boolean {
	return (
		run.stage !== "validate" &&
		(run.phase.kind === "claimed" ||
			run.phase.kind === "running" ||
			run.phase.kind === "blocked")
	);
}

function holdsSlotAs(status: RunStatus): boolean {
	return status === "claimed" || status === "blocked";
}

const FIRST_STAGE: Stage = "specify";

/**
 * Checks that `gh` acts as the integration bot. A missing `GH_HOST` makes it
 * act as the owner or as nobody, and both fail.
 */
export async function checkIdentity(
	adapter: GitHubTicketAdapter,
): Promise<
	| { readonly kind: "ok" }
	| { readonly kind: "mismatch" }
	| { readonly kind: "unavailable"; readonly failure: GitHubFailure }
> {
	const viewer = await adapter.readViewer();

	if (viewer.kind === "failed") {
		return { kind: "unavailable", failure: viewer.failure };
	}

	return viewer.value === CONTROLLER_LOGIN
		? { kind: "ok" }
		: { kind: "mismatch" };
}

export type OrchestratorInput = {
	exec: Exec;
	env: EnvLookup;
	repo: RepoSlug;
	store: AdmissionStore & SnapshotReader;
	files: RunFiles;
	executor: StageExecutor;
	clock: Clock;
	/** Only these issues, or every candidate when `null`. */
	scope: readonly number[] | null;
	log: Log;
	paging?: GitHubPaging;
};

/**
 * One controller authority. Each `tick` reconciles every claim against
 * GitHub before it dispatches anything, and only `tick` changes the state.
 */
export class Orchestrator {
	readonly state: ControllerState = {
		runs: new Map(),
		seen: new Map(),
		corrupt: new Map(),
		totals: {
			claims: 0,
			launches: 0,
			retries: 0,
			stalls: 0,
			releases: 0,
			failures: 0,
			markersPosted: 0,
			usage: 0,
		},
	};

	readonly #input: OrchestratorInput;
	readonly #adapter: GitHubTicketAdapter;
	readonly #writer: GitHubTicketWriter;
	#config: WorkflowConfig | null = null;
	#workflowSha: GitSha | null = null;
	#claimsLoaded = false;
	#ticks = 0;
	#tickAt = 0;
	readonly #recover = new Set<number>();
	readonly #reserved = new Set<number>();
	/** Issues whose claim this tick confirmed eligible. Only these launch. */
	readonly #confirmed = new Set<number>();
	readonly #readOpen = new Set<number>();
	readonly #local = new Map<number, ConfirmedRecord>();
	readonly #ended = new Map<Digest, EndedRecord>();
	readonly #behind = new Map<number, TickReport["ledgerBehind"][number]>();
	readonly #stages = new Set<Promise<void>>();
	readonly #draining = new Set<Draining>();
	#enabled = false;
	#last: ReportInput | null = null;

	constructor(input: OrchestratorInput) {
		this.#input = input;

		this.#adapter = new GitHubTicketAdapter({
			exec: input.exec,
			repo: input.repo,
			paging: input.paging ?? DEFAULT_PAGING,
		});

		this.#writer = new GitHubTicketWriter({
			exec: input.exec,
			repo: input.repo,
		});
	}

	/** The poll interval of the last valid workflow, or the default. */
	get pollIntervalMs(): number {
		return this.#config?.polling.intervalMs ?? DEFAULTS.pollIntervalMs;
	}

	#see(issue: number, updatedAt: string, verdict: SeenIssue["verdict"]): void {
		this.state.seen.set(issue, {
			updatedAt,
			observedAt: this.#tickAt,
			verdict,
		});
	}

	#unchanged(issue: number, updatedAt: string): boolean {
		const seen = this.state.seen.get(issue);

		return (
			seen?.updatedAt === updatedAt &&
			(seen.verdict.kind === "refused" || settled(seen))
		);
	}

	#inScope(issue: number): boolean {
		const { scope } = this.#input;

		return scope === null || scope.includes(issue);
	}

	async tick(): Promise<TickReport> {
		const now = this.#input.clock.now();
		const queued: number[] = [];

		this.#ticks++;
		this.#tickAt = now;
		this.#confirmed.clear();
		this.#readOpen.clear();
		const refused: { issue: number; reasons: RefusalReason["kind"][] }[] = [];

		if (!this.#claimsLoaded) {
			await this.#input.executor.recover();
			await this.#loadClaims();
		}

		this.#countLateUsage();

		const held = this.#limits();

		if (held !== null) await this.#reconcileStages(now, held);

		this.#enabled = await this.#input.executor.preflight();

		const candidates = await this.#candidates();

		await this.#reconcileClaims(candidates);

		const gate = await this.#gate();
		const limits = this.#limits();
		const reasons = gate.kind === "closed" ? [...gate.reasons] : [];

		if (candidates.kind === "failed") reasons.push("candidates_unavailable");

		const direct =
			candidates.kind === "ok"
				? await this.#discover(candidates.value, queued)
				: [];

		await this.#confirmEnds();
		await this.#input.executor
			.cleanupValidation?.()
			.catch(() => this.#input.log("validation_cleanup_unavailable", {}));

		const open =
			gate.kind === "open" && candidates.kind === "ok" && limits !== null;

		if (open) {
			await this.#dispatch({
				now,
				candidates: candidates.value,
				direct,
				reads: gate.reads,
				limits,
				queued,
				refused,
			});
		} else {
			for (const issue of this.#reserved) {
				if (!this.state.runs.has(issue) && !queued.includes(issue)) {
					queued.push(issue);
				}
			}
		}

		this.#input.log("tick", {
			dispatch: open,
			runs: this.state.runs.size,
			queued: queued.length,
		});

		const absent =
			candidates.kind === "ok"
				? (this.#input.scope ?? []).filter(
						(issue) =>
							!this.state.runs.has(issue) &&
							!candidates.value.some((record) => record.number === issue),
					)
				: [];

		this.#last = {
			now,
			enabled: open,
			reasons,
			limits,
			queued,
			absent,
			refused,
		};

		return this.#report(this.#last);
	}

	/**
	 * Waits until no stage is running, ending each as step 1 of a tick would:
	 * a stage that stalls is aborted, and every ended stage posts its marker.
	 * One-shot commands call this so they never exit with a sandbox running.
	 * It returns the last tick's report brought up to date, or `null` when no
	 * stage was running.
	 */
	async drain(wait: (ms: number) => Promise<void>): Promise<TickReport | null> {
		const limits = this.#limits();
		const last = this.#last;

		if (limits === null || last === null) return null;

		const running = () =>
			[...this.state.runs.values()].some((run) => run.phase.kind === "running");

		if (!running()) return null;

		while (running()) {
			this.#countLateUsage();
			await this.#reconcileStages(this.#input.clock.now(), limits);

			for (const run of this.state.runs.values()) {
				if (
					run.stage === "accept" &&
					run.phase.kind === "claimed" &&
					run.inflight === null
				)
					await this.#launch(run);
			}

			if (running()) await wait(DRAIN_POLL_MS);
		}

		await Promise.all(this.#stages);
		this.#countLateUsage();

		for (const run of this.state.runs.values()) {
			if (run.phase.kind === "ending" || run.phase.kind === "reporting") {
				await this.#sync(run);
			}
		}

		return this.#report(last);
	}

	async #loadClaims(): Promise<void> {
		for (const claim of await this.#input.files.listClaims()) {
			if (!this.#inScope(claim.issue)) continue;

			this.#recover.add(claim.issue);

			const seq = claim.seq ?? 0;

			if (seq > (this.#local.get(claim.issue)?.seq ?? 0)) {
				this.#local.set(claim.issue, { ...claim, seq });
			}

			if (claim.status !== null && isTerminal(claim.status)) {
				this.#ended.set(claim.runId, {
					claim: { ...claim, seq },
					tick: 0,
					confirmed: false,
					unwritten: false,
				});
			} else {
				this.#reserved.add(claim.issue);
			}
		}

		this.#claimsLoaded = true;
	}

	async #gate(): Promise<Gate> {
		const reasons: GateReason[] = [];
		const local = await this.#input.store.localSwitch();

		if (local === "unavailable") reasons.push("state_unavailable");

		if (local === "disabled") reasons.push("locally_disabled");

		const reads = await readTickInputs({
			exec: this.#input.exec,
			env: this.#input.env,
			adapter: this.#adapter,
		});

		if (reads.repoSwitch !== null) {
			reasons.push(
				reads.repoSwitch.kind === "repo_switch_off"
					? "repo_switch_off"
					: "repo_switch_unavailable",
			);
		}

		if (reads.workflow.kind === "loaded") {
			this.#config = reads.workflow.snapshot.config;
			this.#workflowSha = reads.workflow.snapshot.sha;
		} else {
			reasons.push("workflow_unavailable");
		}

		const [first, ...rest] = reasons;

		return first === undefined
			? { kind: "open", reads }
			: { kind: "closed", reasons: [first, ...rest] };
	}

	async #candidates(): Promise<Read<IssueRecord[]>> {
		const read = await this.#adapter.readCandidates();

		if (read.kind === "failed") return read;

		return {
			kind: "ok",
			value: read.value.filter((record) => this.#inScope(record.number)),
		};
	}

	async #reconcileStages(now: number, limits: Limits): Promise<void> {
		for (const run of this.#endExpiredStages(now, limits))
			await this.#sync(run);
	}

	#endExpiredStages(now: number, limits: Limits): ActiveRun[] {
		const ended: ActiveRun[] = [];

		for (const run of this.state.runs.values()) {
			const { phase } = run;

			if (phase.kind === "running" && phase.result !== null) {
				this.#finishStage(run, phase.result, limits);
				ended.push(run);
			} else if (
				phase.kind === "running" &&
				now - phase.lastProgressAt > limits.stallMs(run.stage)
			) {
				phase.abort.abort();
				this.state.totals.stalls++;
				this.#input.log("stage_stalled", {
					issue: run.issue,
					runId: run.runId,
					stage: run.stage,
				});
				this.#endStage(run, "stalled", phase.usage, limits);
				this.#detach(run, phase);
				ended.push(run);
			}
		}

		return ended;
	}

	/** Refreshes every claim against GitHub, before the per-tick reads that gate dispatch. */
	async #reconcileClaims(candidates: Read<IssueRecord[]>): Promise<void> {
		for (const run of this.state.runs.values()) {
			if (run.claimUnwritten) await this.#writeClaim(run);

			const eligibility =
				candidates.kind === "ok"
					? await this.#checkEligible(run, candidates.value)
					: "unverified";

			if (eligibility !== "dropped") await this.#sync(run);
		}
	}

	/**
	 * Confirms a claim against GitHub. An issue that changed since the last
	 * confirmation has its ready event and its marker ledger read again. A read
	 * that fails leaves the claim `unverified`, and an unverified claim does not
	 * launch this tick. A corrupt ledger drops the run from dispatch.
	 */
	async #checkEligible(
		run: ActiveRun,
		candidates: readonly IssueRecord[],
	): Promise<Eligibility> {
		if (run.phase.kind === "recovering") {
			const issue = await this.#adapter.readIssue(run.issue);

			if (issue.kind === "failed") return "unverified";

			if (!issue.value.open) {
				this.#release(run, "closed");

				return "released";
			}

			if (run.stage === "build" && !this.#enabled) return "unverified";

			const output =
				run.stage === "build"
					? await this.#input.executor.output({
							runId: run.runId,
							stage: "build",
							attempt: run.attempt,
							round: run.round ?? 0,
						})
					: run.phase.output;

			const recovered = await this.#recoverOutput(run, output);
			const limits = this.#limits();

			if (!recovered && limits !== null)
				this.#endStage(run, "interrupted", 0, limits);

			return "unverified";
		}

		if (run.phase.kind === "ending" || run.phase.kind === "reporting") {
			return "unverified";
		}

		let record = candidates.find((item) => item.number === run.issue);

		if (record === undefined) {
			const read = await this.#adapter.readIssue(run.issue);

			if (read.kind === "failed") return "unverified";

			const issue = read.value;

			if (!isReady(issue)) {
				this.#release(run, issue.open ? "unlabeled" : "closed");

				return "released";
			}

			this.#readOpen.add(run.issue);
			record = issue;
		}

		if (!this.#unchanged(run.issue, record.updatedAt)) {
			const changed = await this.#recheckChanged(run, record.updatedAt);

			if (changed !== "confirmed") return changed;
		}

		this.#confirmed.add(run.issue);

		return "confirmed";
	}

	async #recheckChanged(
		run: ActiveRun,
		updatedAt: string,
	): Promise<Eligibility> {
		const timeline = await this.#adapter.readTimeline(run.issue);

		if (timeline.kind === "failed") return "unverified";

		const ledger = await this.#readLedger(run.issue);

		if (ledger.kind === "failed") return "unverified";

		if (ledger.value.kind === "corrupt") {
			this.#markCorrupt(run.issue, ledger.value, updatedAt);
			this.#drop(run);

			return "dropped";
		}

		this.#localAhead(run.issue, ledger.value);
		this.#confirmEnd(run.issue, ledger.value);

		const replaced = replacedBy(timeline.value, run);

		if (replaced === "unverified") return "unverified";

		if (replaced !== "current") {
			this.#release(run, replaced);

			return "released";
		}

		this.#see(run.issue, updatedAt, { kind: "claimed" });

		return "confirmed";
	}

	/** Stops tracking a run whose ledger turned corrupt. Its claim record stays as evidence. */
	#drop(run: ActiveRun): void {
		this.#abortRunning(run);

		this.state.runs.delete(run.issue);
		this.#input.log("claim_dropped", {
			issue: run.issue,
			runId: run.runId,
			why: "marker_corrupt",
		});
	}

	#release(run: ActiveRun, why: ReleaseReason): void {
		this.#abortRunning(run);

		run.phase = { kind: "ending", status: "released" };
		this.state.totals.releases++;
		this.state.seen.delete(run.issue);
		this.#input.log("claim_released", {
			issue: run.issue,
			runId: run.runId,
			why,
		});
	}

	/** Aborts a running stage the run is leaving, keeping its usage so far and any it reports later. */
	#abortRunning(run: ActiveRun): void {
		const { phase } = run;

		if (phase.kind !== "running") return;

		phase.abort.abort();
		run.usage += phase.usage;
		this.state.totals.usage += phase.usage;
		this.#detach(run, phase);
	}

	#detach(run: ActiveRun, phase: RunningPhase): void {
		this.#draining.add({
			run,
			phase,
			since: this.#input.clock.now(),
			counted: phase.usage,
		});
	}

	/**
	 * Adds usage an aborted stage reported after its outcome was chosen, once.
	 * The outcome stays as chosen. An entry ends when the stage settles.
	 */
	#countLateUsage(): void {
		for (const entry of this.#draining) {
			const { phase } = entry;
			const latest = Math.max(phase.usage, phase.result?.usage ?? 0);
			const late = latest - entry.counted;

			if (late > 0) {
				entry.counted = latest;
				entry.run.usage += late;
				this.state.totals.usage += late;
				this.#input.log("stage_late_usage", {
					issue: entry.run.issue,
					runId: entry.run.runId,
					usage: late,
				});
			}

			if (phase.result !== null) this.#draining.delete(entry);
		}
	}

	/**
	 * True while an aborted stage of this run may still report usage: it has
	 * not settled and its cleanup reserve, plus a grace, has not passed. Its
	 * retry and its terminal marker wait, so both carry that usage.
	 */
	#settling(run: ActiveRun): boolean {
		const now = this.#input.clock.now();

		return [...this.#draining].some(
			(entry) =>
				entry.run === run &&
				entry.phase.result === null &&
				now - entry.since < STAGE_CLEANUP_RESERVE_MS + CLEANUP_GRACE_MS,
		);
	}

	/**
	 * Raises the run's usage to `base` plus what the unsettled attempt's
	 * records hold, when that is more. The records hold the whole attempt, so
	 * a share the run already counts is not counted again.
	 */
	async #reconcileSpent(run: ActiveRun): Promise<void> {
		const unsettled = run.unsettled;

		if (unsettled === null) return;

		const spent = await this.#input.executor
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
		this.state.totals.usage += late;
		this.#input.log("stage_late_usage", {
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
	async #accountAdopted(
		run: ActiveRun,
		marker: Marker,
		ledger: CleanLedger,
		interrupted: boolean,
	): Promise<void> {
		const stage = marker.stage;

		if (!isModelStage(stage) || (run.round ?? 0) !== (marker.round ?? 0))
			return;

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
			await this.#reconcileSpent(run);
		}

		if (interrupted) {
			run.unsettled = { stage, attempt: marker.attempt, base: run.usage };
			await this.#reconcileSpent(run);
		}
	}

	/**
	 * Counts what a released adopted run's attempts spent beyond its usage,
	 * once nothing a previous controller left can still add to it: the
	 * unsettled attempt's records again, and the current attempt's earlier
	 * executions unless that attempt is the unsettled one. False while a
	 * leftover may still be running, so the release waits.
	 */
	async #countReleased(run: ActiveRun): Promise<boolean> {
		if (!(await this.#input.executor.reconciled().catch(() => false))) {
			return false;
		}

		await this.#reconcileSpent(run);

		const stage = run.stage;

		if (isModelStage(stage) && run.unsettled?.attempt !== run.attempt) {
			const prior = await this.#attemptSpent(run, stage);

			if (prior > 0) {
				run.usage += prior;
				this.state.totals.usage += prior;
				this.#input.log("stage_late_usage", {
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
	async #attemptSpent(run: ActiveRun, stage: ModelStage): Promise<number> {
		const spent = await this.#input.executor
			.spent({
				runId: run.runId,
				stage,
				attempt: run.attempt,
				round: run.round ?? 0,
			})
			.catch(() => null);

		return spent ?? 0;
	}

	async #roundSpent(
		run: ActiveRun,
		stage: ModelStage,
		prior: number,
	): Promise<number> {
		let total = prior;

		for (let attempt = 1; attempt < run.attempt; attempt++)
			total +=
				(await this.#input.executor.spent({
					runId: run.runId,
					stage,
					attempt,
					round: run.round ?? 0,
				})) ?? 0;

		return total;
	}

	#finishStage(run: ActiveRun, result: StageEnd, limits: Limits): void {
		if (run.stage === "review" && result.review !== undefined) {
			run.usage += result.usage;
			this.state.totals.usage += result.usage;
			run.phase = {
				kind: "reporting",
				status: "stage_passed",
				effects: { kind: "review", receipt: result.review },
			};

			return;
		}

		if (run.stage === "review" && result.kind === "passed") {
			this.#endStage(run, "stage_failed", result.usage, limits);

			return;
		}

		if (run.stage === "build" && result.build !== undefined) {
			if (
				result.build.kind === "unavailable" ||
				(result.build.kind === "found" &&
					result.build.receipt.policy === "clean" &&
					result.build.receipt.visibleTests?.exitCode == null)
			) {
				this.#input.log("stage_inputs_unavailable", {
					runId: run.runId,
					why:
						result.build.kind === "unavailable"
							? result.build.reason
							: "visible_tests_unavailable",
				});
				this.#endStage(run, "stage_failed", result.usage, limits);

				return;
			}

			run.usage += result.usage;
			this.state.totals.usage += result.usage;

			if (result.build.kind === "found")
				run.phase = {
					kind: "reporting",
					status: "stage_passed",
					effects: { kind: "build", result: result.build },
				};
			else {
				this.#input.log("stage_inputs_refused", {
					runId: run.runId,
					why:
						result.build.kind === "blocked"
							? result.build.reason
							: "patch_missing",
				});
				run.phase = { kind: "ending", status: "failed" };
				this.state.totals.failures++;
			}

			return;
		}

		if (
			result.kind === "failed" ||
			(run.stage === "build" && result.kind === "passed")
		) {
			this.#endStage(run, "stage_failed", result.usage, limits);

			return;
		}

		if (
			result.kind === "passed" &&
			(run.stage === "specify" || run.stage === "accept")
		) {
			const reporting =
				run.stage === "specify"
					? this.#specified(run, result.output)
					: this.#accepted(run, result.output, result.model, result.observed);

			if (reporting === null) {
				this.#endStage(run, "stage_failed", result.usage, limits);

				return;
			}

			run.usage += result.usage;
			this.state.totals.usage += result.usage;
			run.phase = reporting;
			this.#input.log("stage_ended", {
				issue: run.issue,
				runId: run.runId,
				cause: result.kind,
				next: reporting.status,
				attempt: run.attempt,
			});

			return;
		}

		run.usage += result.usage;
		this.state.totals.usage += result.usage;

		const status = END_STATUS[result.kind];

		if (status === "failed") this.state.totals.failures++;

		run.phase = { kind: "ending", status };
		this.#input.log("stage_ended", {
			issue: run.issue,
			runId: run.runId,
			cause: result.kind,
			next: status,
			attempt: run.attempt,
		});
	}

	#endStage(
		run: ActiveRun,
		cause: RetryCause,
		usage: number,
		limits: Limits,
	): void {
		run.usage += usage;
		this.state.totals.usage += usage;

		if (run.usage >= limits.maxTokensPerRun) {
			run.phase = { kind: "ending", status: "budget_exhausted" };
		} else if (run.attempt >= limits.maxAttempts) {
			run.phase = { kind: "ending", status: "failed" };
			this.state.totals.failures++;
		} else {
			run.attempt++;
			this.state.totals.retries++;
			run.phase = {
				kind: "retry_queued",
				dueAt:
					this.#input.clock.now() +
					backoffMs(run.attempt - 1, limits.maxBackoffMs),
			};
		}

		this.#input.log("stage_ended", {
			issue: run.issue,
			runId: run.runId,
			cause,
			next: desiredStatus(run.phase),
			attempt: run.attempt,
		});
	}

	#confirmEnd(issue: number, ledger: CleanLedger): void {
		const ledgerSeq = ledger.markers.at(-1)?.marker.seq ?? 0;

		for (const ended of this.#ended.values()) {
			if (ended.claim.issue !== issue) continue;

			ended.tick = this.#ticks;
			ended.confirmed ||= ledgerSeq >= ended.claim.seq;
		}
	}

	async #confirmEnds(): Promise<void> {
		const issues = new Set<number>();

		for (const ended of this.#ended.values()) {
			if (ended.unwritten) await this.#writeEnded(ended);

			if (!ended.confirmed && ended.tick < this.#ticks) {
				issues.add(ended.claim.issue);
			}
		}

		for (const issue of issues) {
			const ledger = await this.#readLedger(issue);

			if (ledger.kind === "failed") continue;

			if (ledger.value.kind === "corrupt") {
				this.#markCorrupt(issue, ledger.value, null);
				continue;
			}

			this.#localAhead(issue, ledger.value);
			this.#confirmEnd(issue, ledger.value);
		}
	}

	async #keepEnded(claim: ConfirmedRecord, confirmed: boolean): Promise<void> {
		const ended: EndedRecord = {
			claim,
			tick: this.#ticks,
			confirmed,
			unwritten: false,
		};

		this.#ended.set(claim.runId, ended);

		if (claim.seq > (this.#local.get(claim.issue)?.seq ?? 0)) {
			this.#local.set(claim.issue, claim);
		}

		await this.#writeEnded(ended);
	}

	async #writeEnded(ended: EndedRecord): Promise<void> {
		ended.unwritten = !(await this.#input.files.writeClaim(ended.claim));

		if (ended.unwritten) {
			this.#input.log("claim_unwritable", {
				issue: ended.claim.issue,
				runId: ended.claim.runId,
			});
		}
	}

	#endedLocally(issue: number, runId: Digest): boolean {
		const local = this.#local.get(issue);

		return (
			this.#ended.has(runId) ||
			(local?.runId === runId &&
				local.status !== null &&
				isTerminal(local.status))
		);
	}

	async #readLedger(issue: number): Promise<Read<MarkerLedger>> {
		const comments = await this.#adapter.readComments(issue);

		if (comments.kind === "failed") return comments;

		const controller = comments.value.filter(isControllerComment);

		const edits = await this.#adapter.readCommentEdits(
			controller.map((comment) => comment.nodeId),
		);

		if (edits.kind === "failed") return edits;

		return {
			kind: "ok",
			value: markerLedger({
				repo: this.#input.repo,
				issue,
				comments: comments.value,
				edits: edits.value,
			}),
		};
	}

	#markCorrupt(
		issue: number,
		ledger: Extract<MarkerLedger, { kind: "corrupt" }>,
		updatedAt: string | null,
	): void {
		this.state.corrupt.set(issue, {
			defect: ledger.defect,
			commentId: ledger.commentId,
		});

		if (updatedAt !== null) {
			this.#see(issue, updatedAt, { kind: "corrupt" });
		}

		this.#input.log("marker_corrupt", {
			issue,
			defect: ledger.defect,
			commentId: ledger.commentId,
		});
	}

	#localAhead(issue: number, ledger: CleanLedger): ConfirmedRecord | null {
		const local = this.#local.get(issue);
		const ledgerSeq = ledger.markers.at(-1)?.marker.seq ?? 0;

		if (local === undefined || local.seq <= ledgerSeq) {
			this.#behind.delete(issue);

			return null;
		}

		const behind = { issue, ledgerSeq, localSeq: local.seq };
		const known = this.#behind.get(issue);

		if (known?.ledgerSeq !== ledgerSeq || known.localSeq !== local.seq) {
			this.#behind.set(issue, behind);
			this.#input.log("ledger_behind", behind);
		}

		return local;
	}

	#seqFloor(issue: number, ledger: CleanLedger): number {
		return Math.max(
			ledger.markers.at(-1)?.marker.seq ?? 0,
			this.#local.get(issue)?.seq ?? 0,
		);
	}

	async #localMarker(
		local: ConfirmedRecord,
		ledger: CleanLedger,
	): Promise<Marker | null> {
		const stored = await this.#input.store.read({
			repo: this.#input.repo,
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
				repo: this.#input.repo,
				status: local.status ?? read?.status ?? "claimed",
				seq: local.seq,
				cursor: null,
			},
		);
	}

	async #discover(
		candidates: readonly IssueRecord[],
		queued: number[],
	): Promise<IssueRecord[]> {
		const records = new Map(
			candidates.map((record) => [record.number, record]),
		);

		const direct: IssueRecord[] = [];

		for (const issue of this.#recover) {
			if (this.state.runs.has(issue)) {
				this.#resolve(issue);
				continue;
			}

			if (records.has(issue)) continue;

			const read = await this.#adapter.readIssue(issue);

			if (read.kind !== "ok") continue;

			records.set(issue, read.value);

			if (isReady(read.value)) {
				this.#readOpen.add(issue);
				direct.push(read.value);
			}
		}

		for (const record of records.values()) {
			const issue = record.number;

			if (this.state.runs.has(issue)) continue;

			if (this.#unchanged(issue, record.updatedAt)) {
				continue;
			}

			const ledger = await this.#readLedger(issue);

			if (ledger.kind === "failed") continue;

			if (ledger.value.kind === "corrupt") {
				this.#resolve(issue);
				this.#markCorrupt(issue, ledger.value, record.updatedAt);
				continue;
			}

			this.state.corrupt.delete(issue);
			this.#confirmEnd(issue, ledger.value);

			const local = this.#localAhead(issue, ledger.value);

			const current =
				local === null
					? currentMarker(ledger.value)
					: await this.#localMarker(local, ledger.value);

			if (local !== null && current === null) continue;

			const candidate =
				isReady(record) || (record.open && candidates.includes(record));

			if (current !== null && !isTerminal(current.status)) {
				const eligibility = await this.#eligibilityOf(
					current,
					record,
					candidate,
				);

				if (this.#waits(current.status, eligibility)) {
					this.#recover.add(issue);
					this.#reserved.add(issue);
					queued.push(issue);
					continue;
				}

				const adopted = await this.#adoptExistingRun({
					marker: current,
					ledger: ledger.value,
					issue: record,
					eligibility,
				});

				if (adopted === null) {
					if (this.state.corrupt.has(issue)) this.#resolve(issue);
					continue;
				}

				if (this.state.runs.has(issue)) {
					this.#resolve(issue);
					continue;
				}
			}

			const settled = await this.#settleClaims(ledger.value, record, candidate);

			if (settled === "resolved" || settled === "corrupt") {
				this.#resolve(issue);
			} else {
				this.#recover.add(issue);
				this.#reserved.add(issue);
			}

			if (settled === "undecided" || settled === "corrupt") continue;

			if (!candidate) {
				this.#see(issue, record.updatedAt, { kind: "decided" });
				continue;
			}

			this.#see(issue, record.updatedAt, {
				kind: "open",
				ledger: ledger.value,
			});
		}

		return direct;
	}

	#resolve(issue: number): void {
		this.#recover.delete(issue);
		this.#reserved.delete(issue);
	}

	#active(): number {
		return [...this.state.runs.values()].filter(holdsSlot).length;
	}

	#limits(): Limits | null {
		return this.#config === null ? null : limitsOf(this.#config);
	}

	#fits(status: RunStatus): boolean {
		const limits = this.#limits();

		if (limits === null) return false;

		return !holdsSlotAs(status) || this.#active() < limits.maxConcurrent;
	}

	#waits(status: RunStatus, eligibility: Replacement | ReleaseReason): boolean {
		if (eligibility === "current") return !this.#fits(status);

		if (eligibility === "unverified") {
			return !holdsSlotAs(status) || !this.#fits(status);
		}

		return false;
	}

	async #eligibilityOf(
		marker: Marker,
		record: IssueRecord,
		candidate: boolean,
	): Promise<Replacement | ReleaseReason> {
		if (!candidate) return record.open ? "unlabeled" : "closed";

		const timeline = await this.#adapter.readTimeline(marker.issue);

		return timeline.kind === "failed"
			? "unverified"
			: replacedBy(timeline.value, marker);
	}

	async #settleClaims(
		ledger: CleanLedger,
		record: IssueRecord,
		candidate: boolean,
	): Promise<"held" | "resolved" | "undecided" | "corrupt"> {
		let settled: "held" | "resolved" = "resolved";
		let timeline: Read<TimelineEntry[]> | null = null;

		for (const claim of await this.#input.files.listClaims()) {
			if (claim.issue !== record.number || this.#ended.has(claim.runId)) {
				continue;
			}

			const latest = latestFor(ledger, claim.runId)?.marker ?? null;

			if (latest !== null && isTerminal(latest.status)) {
				if (!(await this.#matchesAdmission(latest, record.updatedAt))) {
					return this.state.corrupt.has(record.number)
						? "corrupt"
						: "undecided";
				}

				await this.#keepEnded({ ...claim, ...recordOf(latest) }, true);
				continue;
			}

			let why: ReleaseReason | null = record.open ? "unlabeled" : "closed";

			if (candidate && latest === null) {
				timeline ??= await this.#adapter.readTimeline(record.number);

				if (timeline.kind === "failed") return "undecided";

				const admitted = await this.#admittedFields(claim);

				if (admitted === null) return "undecided";

				const replaced = replacedBy(timeline.value, {
					eventId: claim.eventId,
					eventAt: admitted.eventAt,
				});

				if (replaced === "unverified") return "undecided";

				why = replaced === "current" ? null : replaced;
			} else if (candidate) {
				why = null;
			}

			if (why === null) {
				settled = "held";
			} else if (
				!(await this.#releaseClaim({
					claim,
					marked: latest,
					ledger,
					record,
					why,
				}))
			) {
				return "undecided";
			}
		}

		return settled;
	}

	async #releaseClaim(input: {
		claim: ClaimRecord;
		marked: Marker | null;
		ledger: CleanLedger;
		record: IssueRecord;
		why: ReleaseReason;
	}): Promise<boolean> {
		const { claim, marked, ledger } = input;

		if (this.state.runs.has(claim.issue)) return false;

		const base = marked ?? (await this.#admittedFields(claim));

		if (base === null) return false;

		const run: ActiveRun = {
			runId: claim.runId,
			issue: claim.issue,
			eventId: claim.eventId,
			eventAt: base.eventAt,
			snapshotDigest: base.snapshotDigest,
			workflowSha: base.workflowSha,
			workflowDigest: base.workflowDigest,
			stage: base.stage,
			attempt: base.attempt,
			usage: base.usage,
			seq: this.#seqFloor(claim.issue, ledger),
			marked,
			inflight: null,
			claimUnwritten: false,
			workspaceMissing: false,
			replay: false,
			unsettled: null,
			validation: claim.validation,
			round: claim.round ?? 0,
			adopted: true,
			clearNeedsInfo: false,
			labelFailures: 0,
			labelTick: 0,
			inputs: null,
			phase: { kind: "claimed" },
		};

		this.state.runs.set(run.issue, run);

		if (marked !== null) {
			await this.#accountAdopted(
				run,
				marked,
				ledger,
				marked.status === "running",
			);
		}

		this.#release(run, input.why);
		await this.#sync(run);

		return true;
	}

	async #admittedFields(
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
		const stored = await this.#input.store.read({
			repo: this.#input.repo,
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

	async #matchesAdmission(marker: Marker, updatedAt: string): Promise<boolean> {
		const record = await this.#input.store.read({
			repo: this.#input.repo,
			issue: marker.issue,
			eventId: marker.eventId,
		});

		if (record.kind === "unreadable") return false;

		if (record.kind === "found" && !matchesRecord(marker, record.receipt)) {
			this.#markCorrupt(
				marker.issue,
				{ kind: "corrupt", defect: "record_mismatch", commentId: "" },
				updatedAt,
			);

			return false;
		}

		return true;
	}

	/**
	 * Adopts the live run a marker names. It returns `null` when the run cannot
	 * be adopted. A run that ends in this call, such as one released for a new
	 * ready event, is no longer in `runs`, and its issue can be claimed again in
	 * the same tick.
	 */
	async #adoptExistingRun(input: {
		marker: Marker;
		ledger: CleanLedger;
		issue: IssueRecord;
		eligibility: Replacement | ReleaseReason;
	}): Promise<ActiveRun | null> {
		const { marker, ledger, eligibility } = input;

		if (!(await this.#matchesAdmission(marker, input.issue.updatedAt))) {
			return null;
		}

		const workspace = await this.#input.files.workspaceState(marker.runId);
		const seq = this.#seqFloor(marker.issue, ledger);
		const local = this.#local.get(marker.issue);

		const run: ActiveRun = {
			runId: marker.runId,
			issue: marker.issue,
			eventId: marker.eventId,
			eventAt: marker.eventAt,
			snapshotDigest: marker.snapshotDigest,
			workflowSha: marker.workflowSha,
			workflowDigest: marker.workflowDigest,
			stage: marker.stage,
			attempt: marker.attempt,
			usage: marker.usage,
			seq,
			marked: marker,
			inflight: null,
			claimUnwritten: false,
			workspaceMissing: workspace === "missing",
			replay: true,
			unsettled: null,
			adopted: true,
			clearNeedsInfo:
				input.issue.labels.includes(NEEDS_INFO_LABEL) &&
				(await this.#input.files.readLink(marker.runId)).kind === "found",
			labelFailures:
				local?.runId === marker.runId ? (local.labelFailures ?? 0) : 0,
			labelTick: 0,
			inputs: null,
			validation: local?.runId === marker.runId ? local.validation : undefined,
			round: Math.max(
				marker.round ?? 0,
				local?.runId === marker.runId ? (local.round ?? 0) : 0,
			),
			phase:
				marker.status === "blocked"
					? { kind: "blocked", reason: "sandbox_unavailable" }
					: { kind: "claimed" },
		};

		if ((run.round ?? 0) > (marker.round ?? 0)) {
			run.stage = "build";
			run.attempt = 1;
			run.validation = undefined;
			run.usage = Math.max(run.usage, local?.usage ?? 0);
			run.phase = { kind: "claimed" };
		}

		this.state.runs.set(run.issue, run);
		this.#local.set(run.issue, { ...claimOf(run), seq });
		await this.#writeClaim(run);

		this.#input.log("claim_adopted", {
			issue: run.issue,
			runId: run.runId,
			status: marker.status,
			seq,
			workspace,
		});

		const limits = this.#limits();
		const releasing = eligibility !== "current" && eligibility !== "unverified";

		const output =
			(run.round ?? 0) === (marker.round ?? 0) &&
			marker.status === "running" &&
			isModelStage(run.stage)
				? await this.#input.executor
						.output({
							runId: run.runId,
							stage: run.stage,
							attempt: run.attempt,
							round: run.round ?? 0,
							workflowSha: run.workflowSha,
							workflowDigest: run.workflowDigest,
						})
						.catch(() => null)
				: null;

		await this.#accountAdopted(
			run,
			marker,
			ledger,
			marker.status === "running" &&
				(releasing || limits !== null) &&
				(releasing ||
					run.stage === "build" ||
					!(output instanceof Object && output.kind === "pending")),
		);

		const resumeCi =
			run.stage === "validate" && marker.status === "running" && !releasing;

		if (resumeCi) {
			if (marker.candidate != null && run.validation === undefined) {
				await this.#validate(run);

				return run;
			}

			run.phase = { kind: "awaiting_ci" };
		}

		const recovered =
			resumeCi ||
			(limits !== null &&
				marker.status === "running" &&
				eligibility !== "closed" &&
				eligibility !== "new_event" &&
				(await this.#recoverOutput(run, output)));

		if (recovered) {
			this.#input.log(
				run.phase.kind === "recovering"
					? "stage_recovery_wait"
					: "stage_recovered",
				{
					issue: run.issue,
					runId: run.runId,
					attempt: run.attempt,
					next: desiredStatus(run.phase),
				},
			);
		} else if (eligibility !== "current" && eligibility !== "unverified") {
			this.#release(run, eligibility);
		} else if (
			limits !== null &&
			marker.status === "running" &&
			(run.round ?? 0) === (marker.round ?? 0)
		) {
			this.#endStage(run, "interrupted", 0, limits);
		} else if (limits !== null && marker.status === "retrying") {
			const created = ledger.markers.find(
				({ marker: entry }) =>
					entry.runId === marker.runId &&
					entry.status === "retrying" &&
					entry.attempt === marker.attempt,
			)?.createdAt;

			run.phase = {
				kind: "retry_queued",
				dueAt:
					(created === undefined ? this.#tickAt : Date.parse(created)) +
					backoffMs(Math.max(run.attempt - 1, 1), limits.maxBackoffMs),
			};
		}

		if (eligibility === "current") {
			this.#confirmed.add(run.issue);
			this.#see(run.issue, input.issue.updatedAt, { kind: "claimed" });
		}

		await this.#sync(run);

		return run;
	}

	async #dispatch(input: {
		now: number;
		candidates: readonly IssueRecord[];
		direct: readonly IssueRecord[];
		reads: TickReads;
		limits: Limits;
		queued: number[];
		refused: { issue: number; reasons: RefusalReason["kind"][] }[];
	}): Promise<void> {
		const { now, limits } = input;
		const runs = [...this.state.runs.values()];

		for (const run of runs) {
			if (
				run.phase.kind === "awaiting_ci" &&
				this.#confirmed.has(run.issue) &&
				run.inflight === null
			)
				await this.#validate(run);
		}

		for (const record of [...input.candidates, ...input.direct]) {
			const issue = record.number;
			const seen = this.state.seen.get(issue);

			if (
				!this.#reserved.has(issue) ||
				this.state.runs.has(issue) ||
				seen?.verdict.kind !== "open"
			) {
				continue;
			}

			if (this.#active() >= limits.maxConcurrent) {
				input.queued.push(issue);
				continue;
			}

			await this.#claim(record, seen.verdict.ledger, input);

			if (
				this.state.runs.has(issue) ||
				this.state.seen.get(issue)?.verdict.kind !== "open"
			) {
				this.#resolve(issue);
			}
		}

		for (const run of runs) {
			if (
				run.inflight === null &&
				this.#confirmed.has(run.issue) &&
				(run.phase.kind === "claimed" ||
					(run.phase.kind === "blocked" && (run.replay || this.#enabled)))
			) {
				await this.#launch(run);
			}
		}

		const reserved = [...this.#reserved].filter(
			(issue) => !this.state.runs.has(issue),
		).length;

		let slots = Math.max(limits.maxConcurrent - this.#active() - reserved, 0);

		for (const run of runs) {
			if (
				run.phase.kind !== "retry_queued" ||
				run.phase.dueAt > now ||
				run.inflight !== null ||
				!this.#confirmed.has(run.issue) ||
				this.#settling(run)
			) {
				continue;
			}

			if (run.attempt > limits.maxAttempts) {
				run.phase = { kind: "ending", status: "failed" };
				this.state.totals.failures++;
				await this.#sync(run);
				continue;
			}

			if (slots === 0) continue;

			if (await this.#launch(run)) slots--;
		}

		for (const record of input.candidates) {
			const issue = record.number;
			const seen = this.state.seen.get(issue);

			if (
				this.state.runs.has(issue) ||
				this.#reserved.has(issue) ||
				seen?.verdict.kind !== "open"
			) {
				continue;
			}

			if (slots === 0) {
				input.queued.push(issue);
				continue;
			}

			if (await this.#claim(record, seen.verdict.ledger, input)) slots--;
		}
	}

	async #claim(
		record: IssueRecord,
		ledger: CleanLedger,
		input: {
			reads: TickReads;
			refused: { issue: number; reasons: RefusalReason["kind"][] }[];
		},
	): Promise<boolean> {
		const claimed = await this.#admit({
			record,
			ledger,
			reads: input.reads,
			refused: input.refused,
		});

		if (claimed === null) return false;

		if (claimed.inflight === null) await this.#launch(claimed);

		return claimed.phase.kind !== "ending";
	}

	/**
	 * Finds an admission this controller recorded for the issue's current ready
	 * event but never marked, such as after a crash before the first marker. It
	 * is adopted with its original snapshot and workflow binding, so a later
	 * edit to the issue cannot strand it. The timeline is read only when such a
	 * record exists.
	 */
	async #recordedAdmission(
		record: IssueRecord,
		ledger: CleanLedger,
	): Promise<
		| { readonly kind: "found"; readonly receipt: AdmittedReceipt }
		| { readonly kind: "none" }
		| { readonly kind: "ended" }
		| { readonly kind: "defer" }
	> {
		const repo = this.#input.repo;
		const issue = record.number;
		const events = await this.#input.store.listEvents({ repo, issue });

		if (events === null) return { kind: "defer" };

		const unmarked = events.filter(
			(eventId) =>
				latestFor(ledger, runIdOf({ repo, issue, eventId })) === null,
		);

		if (unmarked.length === 0) return { kind: "none" };

		const timeline = await this.#adapter.readTimeline(issue);

		if (timeline.kind === "failed") return { kind: "defer" };

		const latest = latestReadyEntry(timeline.value);

		if (
			latest.kind !== "found" ||
			latest.entry.kind !== "labeled" ||
			!unmarked.includes(latest.entry.id)
		) {
			return { kind: "none" };
		}

		if (
			this.#endedLocally(
				issue,
				runIdOf({ repo, issue, eventId: latest.entry.id }),
			)
		) {
			return { kind: "ended" };
		}

		const stored = await this.#input.store.read({
			repo,
			issue,
			eventId: latest.entry.id,
		});

		if (stored.kind === "unreadable") return { kind: "defer" };

		if (stored.kind === "absent") return { kind: "none" };

		if (stored.receipt.eventAt !== latest.entry.at) {
			this.#markCorrupt(
				issue,
				{ kind: "corrupt", defect: "record_mismatch", commentId: "" },
				record.updatedAt,
			);

			return { kind: "defer" };
		}

		this.#input.log("admission_recovered", {
			issue,
			eventId: stored.receipt.eventId,
		});

		return { kind: "found", receipt: stored.receipt };
	}

	async #freshAdmission(
		record: IssueRecord,
		reads: TickReads,
		refused: { issue: number; reasons: RefusalReason["kind"][] }[],
	): Promise<AdmittedReceipt | null> {
		const issue = record.number;
		const repo = this.#input.repo;

		const receipt = await admitTicket({
			exec: this.#input.exec,
			env: this.#input.env,
			repo,
			issue,
			allowlist: FACTORY_REPOSITORIES,
			store: this.#input.store,
			paging: this.#input.paging,
			tick: reads,
		});

		if (receipt.decision === "admitted") {
			this.#readOpen.add(issue);

			return receipt;
		}

		const kinds = receipt.reasons.map((reason) => reason.kind);

		if (!kinds.includes("duplicate_event") || receipt.eventId === null) {
			const settled = receipt.reasons.every(refusalSettlesUntilEdited);

			refused.push({ issue, reasons: kinds });
			this.#input.log("admission_refused", {
				issue,
				reasons: kinds.join("+"),
				retry: !settled,
			});

			if (settled) this.#see(issue, record.updatedAt, { kind: "decided" });

			return null;
		}

		const stored = await this.#input.store.read({
			repo,
			issue,
			eventId: receipt.eventId,
		});

		if (stored.kind !== "found") return null;

		if (stored.receipt.snapshotDigest !== receipt.snapshotDigest) {
			this.#markCorrupt(
				issue,
				{ kind: "corrupt", defect: "record_mismatch", commentId: "" },
				record.updatedAt,
			);

			return null;
		}

		this.#readOpen.add(issue);

		return stored.receipt;
	}

	async #admit(input: {
		record: IssueRecord;
		ledger: CleanLedger;
		reads: TickReads;
		refused: { issue: number; reasons: RefusalReason["kind"][] }[];
	}): Promise<ActiveRun | null> {
		const { record, ledger } = input;
		const issue = record.number;
		const repo = this.#input.repo;

		const local = await this.#recordedAdmission(record, ledger);

		if (local.kind === "defer") return null;

		if (local.kind === "ended") {
			this.#see(issue, record.updatedAt, { kind: "decided" });

			return null;
		}

		const admitted =
			local.kind === "found"
				? local.receipt
				: await this.#freshAdmission(record, input.reads, input.refused);

		if (admitted === null) return null;

		const runId = runIdOf({ repo, issue, eventId: admitted.eventId });

		if (latestFor(ledger, runId) !== null || this.#endedLocally(issue, runId)) {
			this.#see(issue, record.updatedAt, { kind: "decided" });

			return null;
		}

		const link = await this.#link({ issue, ledger, admitted, runId });

		if (link.kind === "defer") return null;

		if (link.kind === "invalid") {
			input.refused.push({ issue, reasons: [link.reason] });
			this.#input.log("admission_refused", {
				issue,
				reasons: link.reason,
				detail: link.detail,
				retry: false,
			});
			this.#see(issue, record.updatedAt, {
				kind: "refused",
				reason: link.reason,
			});

			return null;
		}

		if (link.kind === "ambiguous") {
			input.refused.push({ issue, reasons: ["ambiguous_snapshot"] });
			this.#input.log("admission_refused", {
				issue,
				reasons: "ambiguous_snapshot",
				detail: "answer_at_label_time",
				retry: false,
			});
			this.#see(issue, record.updatedAt, { kind: "decided" });

			return null;
		}

		if (
			link.kind === "none" &&
			!(await this.#input.files.writeLink(runId, null))
		) {
			this.#input.log("link_unwritable", { issue, runId });

			return null;
		}

		const run: ActiveRun = {
			runId,
			issue,
			eventId: admitted.eventId,
			eventAt: admitted.eventAt,
			snapshotDigest: admitted.snapshotDigest,
			workflowSha: admitted.baseSha,
			workflowDigest: admitted.workflowDigest,
			stage: FIRST_STAGE,
			attempt: 1,
			usage: 0,
			seq: this.#seqFloor(issue, ledger),
			marked: null,
			inflight: null,
			claimUnwritten: false,
			workspaceMissing: false,
			replay: false,
			unsettled: null,
			adopted: false,
			clearNeedsInfo: link.kind === "linked",
			labelFailures: 0,
			labelTick: 0,
			inputs: null,
			phase: { kind: "claimed" },
		};

		if (!(await this.#input.files.writeClaim(claimOf(run)))) {
			this.#input.log("claim_unwritable", { issue, runId });

			return null;
		}

		this.state.runs.set(issue, run);
		this.state.totals.claims++;
		this.#see(issue, record.updatedAt, { kind: "claimed" });
		this.#input.log("claim_taken", {
			issue,
			runId,
			eventId: run.eventId,
		});
		await this.#sync(run);

		if (link.kind === "linked") {
			this.#input.log("run_linked", {
				issue,
				runId,
				prevRunId: link.link.prevRunId,
				answers: link.answers,
			});
			await this.#clearNeedsInfo(run);
		}

		if ((await this.#input.files.ensureWorkspace(runId)) === "unavailable") {
			this.#input.log("workspace_unavailable", { issue, runId });
		}

		return run;
	}

	async #labelOutcome(
		run: ActiveRun,
		label: string,
		outcome: "posted" | "rejected" | "unknown",
		critical = true,
	): Promise<boolean> {
		const fields = { issue: run.issue, runId: run.runId, label, outcome };

		this.#input.log("label_write", fields);

		if (critical) {
			run.labelFailures = outcome === "posted" ? 0 : run.labelFailures + 1;
			await this.#writeClaim(run);
		}

		if (outcome !== "posted") this.#input.log("label_unconfirmed", fields);

		return outcome === "posted";
	}

	#labelsExhausted(run: ActiveRun): boolean {
		if (
			run.labelFailures < (this.#limits()?.maxAttempts ?? DEFAULTS.maxAttempts)
		)
			return false;

		run.phase = { kind: "ending", status: "failed" };
		this.state.totals.failures++;
		this.#input.log("label_retries_exhausted", {
			issue: run.issue,
			runId: run.runId,
			failures: run.labelFailures,
		});

		return true;
	}

	async #clearNeedsInfo(run: ActiveRun): Promise<boolean> {
		if (!run.clearNeedsInfo) return true;

		if (run.labelTick === this.#ticks) return false;

		run.labelTick = this.#ticks;

		const removed = await this.#writer.removeLabel(run.issue, NEEDS_INFO_LABEL);

		run.clearNeedsInfo = !(await this.#labelOutcome(
			run,
			NEEDS_INFO_LABEL,
			removed.kind,
			false,
		));

		return !run.clearNeedsInfo;
	}

	async #answerHistory(
		runId: Digest,
		ledger: CleanLedger,
	): Promise<readonly AnswersRecord[] | "previous_link" | "previous_answers"> {
		const records: AnswersRecord[] = [];
		const visited = new Set<Digest>();
		let current = runId;

		for (;;) {
			if (visited.has(current)) return "previous_link";

			visited.add(current);

			const first = ledger.markers.find(
				({ marker }) => marker.runId === current,
			);

			const earlier = ledger.markers.findLast(
				({ marker }) =>
					marker.seq < (first?.marker.seq ?? 0) && isTerminal(marker.status),
			);

			const linked = await this.#input.files.readLink(current);

			if (linked.kind === "unreadable") return "previous_link";

			if (linked.kind === "unlinked") return records.reverse();

			if (linked.kind === "none") {
				return (await this.#input.files.readAnswers(current)) === null
					? records.reverse()
					: "previous_link";
			}

			if (
				earlier?.marker.status === "needs_info" &&
				earlier.marker.runId !== linked.link.prevRunId
			)
				return "previous_link";

			const answers = await this.#input.files.readAnswers(current);

			if (
				answers === null ||
				answers.runId !== current ||
				answers.prevRunId !== linked.link.prevRunId ||
				answers.digest !== linked.link.answersDigest ||
				answersDigestOf(answers) !== answers.digest
			)
				return "previous_answers";

			records.push(answers);
			current = linked.link.prevRunId;
		}
	}

	async #link(input: {
		issue: number;
		ledger: CleanLedger;
		admitted: AdmittedReceipt;
		runId: Digest;
	}): Promise<
		| { readonly kind: "none" }
		| { readonly kind: "defer" }
		| { readonly kind: "ambiguous" }
		| {
				readonly kind: "invalid";
				readonly reason: "answers_record_invalid" | "link_record_invalid";
				readonly detail: "previous_answers" | "previous_link";
		  }
		| { readonly kind: "linked"; readonly link: Link; readonly answers: number }
	> {
		const { issue, admitted, runId } = input;

		const prev: TrustedMarker | undefined = input.ledger.markers.findLast(
			({ marker }) => isTerminal(marker.status),
		);

		if (
			prev === undefined ||
			!isClarificationPredecessor(prev, admitted, runId)
		) {
			return { kind: "none" };
		}

		if (admitted.eventAt === prev.createdAt) return { kind: "ambiguous" };

		const comments = await this.#adapter.readComments(issue);

		if (comments.kind === "failed") return { kind: "defer" };

		const prevRunId = prev.marker.runId;

		const asked = comments.value.find(
			(comment) =>
				isControllerComment(comment) &&
				questionsKeyOf(comment.body)?.runId === prevRunId,
		);

		if (
			admitted.eventAt < prev.createdAt &&
			(asked === undefined || admitted.eventAt <= asked.createdAt)
		) {
			return { kind: "none" };
		}

		const floor = BigInt(asked?.id ?? prev.commentId);

		const candidates = comments.value
			.filter((comment) => isAnswerCandidate(comment, floor, admitted.eventAt))
			.sort((a, b) => (BigInt(a.id) < BigInt(b.id) ? -1 : 1));

		if (candidates.some((comment) => comment.createdAt === admitted.eventAt)) {
			return { kind: "ambiguous" };
		}

		const edits = await this.#adapter.readCommentEdits(
			candidates.map((comment) => comment.nodeId),
		);

		if (edits.kind === "failed") return { kind: "defer" };

		const history = await this.#answerHistory(prevRunId, input.ledger);

		if (history === "previous_link" || history === "previous_answers") {
			return {
				kind: "invalid",
				reason:
					history === "previous_link"
						? "link_record_invalid"
						: "answers_record_invalid",
				detail: history,
			};
		}

		const previousAnswers = history.at(-1);
		const answers: Answer[] = [...(previousAnswers?.answers ?? [])];
		const permissions = new Map<string, boolean>();

		for (const comment of candidates) {
			if (answers.length >= MAX_ANSWERS) break;
			const edit = edits.value.get(comment.nodeId);
			const login = comment.author?.login ?? "";

			if (edit === undefined || edit.id !== comment.id) {
				return { kind: "defer" };
			}

			if (!answerEditPrecedesLabel(edit, admitted.eventAt) || !isLogin(login)) {
				continue;
			}

			let authorized = permissions.get(login.toLowerCase());

			if (authorized === undefined) {
				const permission = await this.#adapter.readPermission(login);

				if (permission.kind === "failed") return { kind: "defer" };

				authorized = hasWriteAccess(permission.value);
				permissions.set(login.toLowerCase(), authorized);
			}

			if (!authorized) continue;

			answers.push({
				commentId: comment.id,
				author: login,
				createdAt: comment.createdAt,
				body: answerBody(comment.body),
			});

			if (answers.length === MAX_ANSWERS) break;
		}

		const questions = asked === undefined ? "" : withoutKey(asked.body);

		const rounds = [
			...history.map((record, index) => ({
				questions: record.questions,
				answers: record.answers.slice(history[index - 1]?.answers.length ?? 0),
			})),
			{
				questions,
				answers: answers.slice(previousAnswers?.answers.length ?? 0),
			},
		];

		const digest = answersDigestOf({ prevRunId, questions, answers, rounds });

		const record: AnswersRecord = {
			version: 1,
			runId,
			prevRunId,
			questionsCommentId: asked?.id ?? null,
			questions,
			answers,
			rounds,
			digest,
		};

		const link: Link = {
			prevRunId,
			questionsDigest:
				asked === undefined
					? null
					: (questionsKeyOf(asked.body)?.digest ?? null),
			answersDigest: digest,
		};

		const { files } = this.#input;

		if (
			!(await files.writeAnswers(record)) ||
			!(await files.writeLink(runId, link))
		) {
			this.#input.log("link_unwritable", { issue, runId });

			return { kind: "defer" };
		}

		return { kind: "linked", link, answers: answers.length };
	}

	async #prepareWorkspace(run: ActiveRun): Promise<WorkspacePreparation> {
		const workspace = await this.#input.files.ensureWorkspace(run.runId);

		if (workspace === "unavailable") {
			this.#input.log("workspace_unavailable", {
				issue: run.issue,
				runId: run.runId,
			});

			return { kind: "unavailable" };
		}

		run.replay = false;

		if (workspace === "created") {
			run.workspaceMissing = true;
			this.#input.log("workspace_missing", {
				issue: run.issue,
				runId: run.runId,
				stage: run.stage,
			});

			return { kind: "replayed_missing" };
		}

		return { kind: "fresh" };
	}

	async #stillReady(run: ActiveRun): Promise<boolean> {
		if (this.#readOpen.has(run.issue)) return true;

		const read = await this.#adapter.readIssue(run.issue);

		if (read.kind === "failed") return false;

		if (!isReady(read.value)) {
			this.#release(run, read.value.open ? "unlabeled" : "closed");
			await this.#sync(run);

			return false;
		}

		this.#readOpen.add(run.issue);

		return true;
	}

	async #launch(run: ActiveRun): Promise<boolean> {
		if (run.claimUnwritten) return false;

		if (!(await this.#stillReady(run))) return false;

		if (run.stage === "validate") {
			await this.#validate(run);

			return false;
		}

		const { files, executor, clock } = this.#input;
		const config = this.#config;

		if (config === null) return false;

		await this.#reconcileSpent(run);

		const stage = run.stage;

		const prior = isModelStage(stage)
			? await this.#attemptSpent(run, stage)
			: 0;

		const roundLimit =
			stage === "review"
				? REVIEW_MAX_TOKENS
				: stage === "build" && (run.round ?? 0) > 0
					? REPAIR_BUILD_MAX_TOKENS
					: null;

		const roundSpent =
			roundLimit !== null && isModelStage(stage)
				? await this.#roundSpent(run, stage, prior)
				: prior;

		const runExhausted = run.usage + prior >= config.usage.maxTokensPerRun;

		if (runExhausted || (roundLimit !== null && roundSpent >= roundLimit)) {
			run.usage += prior;
			this.state.totals.usage += prior;
			run.phase = { kind: "ending", status: "budget_exhausted" };
			this.#input.log("launch_refused", {
				issue: run.issue,
				runId: run.runId,
				stage: run.stage,
				why: runExhausted ? "run_tokens" : "round_tokens",
			});
			await this.#sync(run);

			return false;
		}

		if (stage === "build" && this.#enabled) {
			const kept = await executor.output({
				runId: run.runId,
				stage,
				attempt: run.attempt,
				round: run.round ?? 0,
			});

			if (await this.#recoverOutput(run, kept)) {
				run.usage += prior;
				this.state.totals.usage += prior;
				await this.#sync(run);

				return false;
			}
		}

		const preparation = await this.#prepareWorkspace(run);

		if (preparation.kind === "unavailable") return false;

		if (!isModelStage(stage)) {
			run.phase = { kind: "blocked", reason: "sandbox_unavailable" };
			await this.#sync(run);

			return true;
		}

		await this.#clearNeedsInfo(run);

		const prepared = this.#enabled ? await this.#stageInputs(run) : UNPREPARED;

		if (prepared.kind === "wait") return false;

		if (prepared.kind === "fail") {
			run.phase = { kind: "ending", status: "failed" };
			this.state.totals.failures++;
			await this.#sync(run);

			return false;
		}

		run.inputs = prepared.inputs;

		if (stage === "accept" && prepared.inputs?.contract !== undefined) {
			const bound = prepared.inputs.contract;

			const kept = await files.artifacts.read(
				run.runId,
				bound.contract,
				bound.digest,
			);

			if (kept.kind !== "absent") {
				run.usage += prior;
				this.state.totals.usage += prior;

				if (kept.kind === "blocked") {
					this.#input.log("stage_inputs_refused", {
						runId: run.runId,
						why: kept.reason,
					});
					run.phase = { kind: "ending", status: "failed" };
					this.state.totals.failures++;
				} else
					run.phase = {
						kind: "reporting",
						status: "stage_passed",
						effects: {
							kind: "acceptance",
							contract: bound.contract,
							contractDigest: bound.digest,
							suite: kept.suite,
							model: kept.receipt.model,
							observed: kept.receipt.observed,
						},
					};
				await this.#sync(run);

				return false;
			}
		}

		const abort = new AbortController();
		const now = clock.now();

		const phase: Extract<RunPhase, { kind: "running" }> = {
			kind: "running",
			lastProgressAt: now,
			usage: prior,
			abort,
			result: null,
		};

		const launch = await executor.launch({
			runId: run.runId,
			stage,
			attempt: run.attempt,
			round: run.round ?? 0,
			review: prepared.review,
			workspace: prepared.workspace ?? files.workspacePath(run.runId),
			build: prepared.build,
			prompt: prepared.prompt,
			specify: prepared.specify,
			tools:
				prepared.inputs === null
					? []
					: stage === "build"
						? prepared.inputs.contract !== undefined &&
							prepared.inputs.contract.contract.files.length > 8
							? [...BUILD_TOOLS, "subagent"]
							: BUILD_TOOLS
						: stage === "review"
							? REVIEW_TOOLS
							: stage === "accept"
								? ACCEPTANCE_TOOLS
								: SPECIFY_TOOLS,
			skills:
				prepared.inputs === null
					? []
					: stage === "build"
						? ["build"]
						: stage === "review"
							? []
							: stage === "accept"
								? ACCEPTANCE_SKILLS
								: SPECIFY_SKILLS,
			settings: {
				model: config.stages[stage].model,
				fallback: config.stages[stage].fallbackModel,
				budget: config.stages[stage].budget,
				maxTokens:
					stage === "build"
						? Math.max(
								0,
								((run.round ?? 0) > 0
									? REPAIR_BUILD_MAX_TOKENS
									: BUILD_MAX_TOKENS) - roundSpent,
							)
						: stage === "review"
							? Math.max(0, REVIEW_MAX_TOKENS - roundSpent)
							: stage === "accept"
								? Math.max(0, ACCEPTANCE_MAX_TOKENS - prior)
								: null,
			},
			remainingRunTokens: Math.max(
				0,
				config.usage.maxTokensPerRun - run.usage - prior,
			),
			signal: abort.signal,
			progress: (usage) => {
				phase.lastProgressAt = clock.now();
				phase.usage = Math.max(phase.usage, prior + usage);
			},
		});

		this.state.totals.launches++;

		if (launch.kind === "unavailable") {
			run.phase = { kind: "blocked", reason: launch.reason };
		} else {
			run.phase = phase;
			run.unsettled = null;
			run.adopted = false;

			const attempt = run.attempt;

			const settled = launch.done.then(
				async (result) => {
					const output =
						result.kind === "passed"
							? await executor
									.output({
										runId: run.runId,
										stage,
										attempt,
										round: run.round ?? 0,
										workflowSha: run.workflowSha,
										workflowDigest: run.workflowDigest,
									})
									.catch(() => null)
							: null;

					phase.result = {
						kind: result.kind,
						model:
							result.receipt.fallback?.requested ??
							result.receipt.models.requested,
						observed:
							result.receipt.fallback?.observed ??
							result.receipt.models.observed,
						usage: prior + result.usage,
						review:
							output instanceof Object && output.kind === "review"
								? output.receipt
								: undefined,
						build:
							output instanceof Object && output.kind === "build"
								? output.result
								: undefined,
						output:
							output instanceof Object
								? output.kind === "output"
									? output.text
									: null
								: output,
					};
				},
				() => {
					phase.result = { kind: "failed", usage: phase.usage, output: null };
				},
			);

			this.#stages.add(settled);
			settled.then(() => this.#stages.delete(settled));
		}

		this.#input.log("stage_launched", {
			issue: run.issue,
			runId: run.runId,
			stage: run.stage,
			attempt: run.attempt,
			result: launch.kind,
		});
		await this.#sync(run);

		return true;
	}

	async #repairOrFail(run: ActiveRun, why: string): Promise<void> {
		if ((run.round ?? 0) >= MAX_REPAIR_ROUNDS) {
			run.phase = { kind: "ending", status: "failed" };
			this.state.totals.failures++;
			this.#input.log("repair_cap", {
				runId: run.runId,
				round: run.round ?? 0,
				why,
			});

			return;
		}

		run.round = (run.round ?? 0) + 1;
		run.validation = undefined;
		run.stage = "build";
		run.attempt = 1;
		run.inputs = null;
		run.replay = false;
		run.phase = { kind: "claimed" };
		await this.#writeClaim(run);
		this.#input.log("repair_started", {
			runId: run.runId,
			round: run.round,
			why,
		});
	}

	async #validate(run: ActiveRun): Promise<void> {
		if (run.marked?.candidate != null && run.validation === undefined) {
			run.phase = { kind: "ending", status: "failed" };
			this.state.totals.failures++;
			this.#input.log("validation_failed", {
				issue: run.issue,
				runId: run.runId,
				why: "validation_state_missing",
			});
			await this.#sync(run);

			return;
		}

		const validate = this.#input.executor.validate;

		if (validate === undefined) {
			run.phase = { kind: "blocked", reason: "sandbox_unavailable" };
			await this.#sync(run);

			return;
		}

		run.phase = { kind: "awaiting_ci" };

		const result = await validate({
			runId: run.runId,
			issue: run.issue,
			eventAt: run.eventAt,
			baseSha: run.workflowSha,
			round: run.round ?? 0,
			now: this.#input.clock.now(),
			wallMs: this.#config?.stages.validate.budget.wallMs ?? 1_200_000,
			state: run.validation ?? null,
			save: async (state) => {
				run.validation = state;
				await this.#writeClaim(run);

				return !run.claimUnwritten;
			},
		});

		if (result.state !== null) run.validation = result.state;

		if (result.kind === "finished") {
			if (verdictPasses(result.verdict)) {
				run.stage = "review";
				run.attempt = 1;
				run.inputs = null;
				run.phase = { kind: "claimed" };
			} else await this.#repairOrFail(run, "validation_failed");
			this.#input.log("validation_verdict", {
				issue: run.issue,
				runId: run.runId,
				candidate: result.verdict.candidateSha,
				gate: result.verdict.gateSha,
				ciRun: result.verdict.ciRunId,
				pass: result.verdict.pass,
			});
		} else if (result.kind === "failed") {
			run.phase = { kind: "ending", status: "failed" };
			this.state.totals.failures++;
			this.#input.log("validation_failed", {
				issue: run.issue,
				runId: run.runId,
				why: result.reason,
			});
		}

		await this.#sync(run);
	}

	async #sync(run: ActiveRun): Promise<void> {
		if (run.inflight?.tick === this.#ticks) return;

		if (isTerminal(desiredStatus(run.phase)) && this.#settling(run)) return;

		if (
			run.adopted &&
			run.phase.kind === "ending" &&
			run.phase.status === "released" &&
			!(await this.#countReleased(run))
		) {
			return;
		}

		const before = run.seq;

		if ((await this.#recoverUncertainPost(run)) === "stop") return;

		if (
			run.marked !== null &&
			run.phase.kind !== "ending" &&
			run.phase.kind !== "recovering"
		) {
			await this.#clearNeedsInfo(run);
		}

		if (run.phase.kind === "reporting" && !this.#labelsExhausted(run)) {
			const { status, effects } = run.phase;

			if (await this.#applyEffects(run, effects)) {
				if (
					effects.kind === "contract" ||
					effects.kind === "acceptance" ||
					effects.kind === "build"
				) {
					run.stage =
						effects.kind === "contract"
							? "accept"
							: effects.kind === "acceptance"
								? "build"
								: "validate";
					run.attempt = 1;
					run.inputs = null;
					run.replay = false;
					run.phase =
						run.stage === "validate"
							? { kind: "awaiting_ci" }
							: { kind: "claimed" };
				} else run.phase = { kind: "ending", status };
			} else if (
				run.phase.kind === "reporting" &&
				!this.#labelsExhausted(run)
			) {
				return;
			}
		}

		await this.#publishMarker(run);

		if (run.marked !== null && isTerminal(run.marked.status)) {
			this.state.runs.delete(run.issue);
			await this.#keepEnded({ ...claimOf(run), seq: run.seq }, false);
		} else if (run.seq !== before) {
			await this.#writeClaim(run);
		}
	}

	async #stageInputs(
		run: ActiveRun,
	): Promise<Prepared | { readonly kind: "wait" } | { readonly kind: "fail" }> {
		const { files, repo } = this.#input;
		const fields = { issue: run.issue, runId: run.runId };

		const wait = (why: string) => {
			this.#input.log("stage_inputs_unavailable", { ...fields, why });

			return { kind: "wait" } as const;
		};

		const fail = (why: string) => {
			this.#input.log("stage_inputs_refused", { ...fields, why });

			return { kind: "fail" } as const;
		};

		if (run.stage === "review") {
			const prepare = this.#input.executor.prepareReview;

			if (prepare === undefined) return fail("review_unavailable");

			try {
				const review = await prepare({
					runId: run.runId,
					round: run.round ?? 0,
					workspace: `${files.workspacePath(run.runId)}-review-r${run.round ?? 0}`,
					workflowSha: run.workflowSha,
					workflowDigest: run.workflowDigest,
				});

				return {
					kind: "ready",
					workspace: review.workspace,
					review,
					inputs: {
						files: new Set(review.input.files.keys()),
						source: "unedited",
						link: null,
					},
					prompt: "",
				};
			} catch (error) {
				return fail(
					error instanceof Error ? error.message : "review_unavailable",
				);
			}
		}

		if (
			run.stage !== "specify" &&
			run.stage !== "accept" &&
			run.stage !== "build"
		)
			return fail("no_prompt");

		const contract =
			run.stage !== "specify" ? await files.readContract(run.runId) : null;

		if (contract?.kind === "blocked") return fail(contract.reason);

		if (
			contract?.kind === "found" &&
			(contract.contract.base.sha !== run.workflowSha ||
				contract.contract.base.repo !== repo ||
				contract.contract.issue !== run.issue ||
				contract.contract.snapshot.digest !== run.snapshotDigest)
		)
			return fail("contract_binding");

		const workspace =
			run.stage === "build"
				? `${files.workspacePath(run.runId)}-build-r${run.round ?? 0}-${run.attempt}`
				: files.workspacePath(run.runId);

		const checked = await this.#input.executor
			.checkout({
				runId: run.runId,
				repo,
				sha: run.workflowSha,
				workspace,
				build: run.stage === "build",
				round: run.round ?? 0,
			})
			.catch((): CheckoutResult => ({ kind: "unavailable" }));

		if (checked.kind === "unavailable") return wait("checkout");

		if (checked.kind === "refused") return fail(`checkout_${checked.reason}`);

		const { checkout } = checked;

		const workflow = await checkout.read(WORKFLOW_PATH, 256 * 1024);

		if (workflow === null || digestOf(workflow) !== run.workflowDigest) {
			return fail("workflow_mismatch");
		}

		const parsed = parseWorkflow({
			text: workflow,
			repo,
			env: this.#input.env,
		});

		if (parsed.kind === "invalid") return fail("workflow_invalid");

		if (contract?.kind === "found") {
			const shown: InlinedFile[] = [];
			let budget = INLINE_TOTAL_BYTES;

			for (const path of contract.contract.files) {
				const text = await checkout.read(path, NAMED_FILE_READ_BYTES);

				if (text === null || budget < 1024) continue;
				const file = inlined(path, text, Math.min(NAMED_FILE_BYTES, budget));
				budget -= Buffer.byteLength(file.text);
				shown.push(file);
			}

			let build: Prepared["build"];

			if (run.stage === "build") {
				const suite = await files.artifacts.read(
					run.runId,
					contract.contract,
					contract.digest,
				);

				if (suite.kind !== "found")
					return fail(
						suite.kind === "blocked" ? suite.reason : "acceptance_missing",
					);
				build = {
					binding: {
						runId: run.runId,
						round: run.round ?? 0,
						baseSha: contract.contract.base.sha,
						contractDigest: contract.digest,
						acceptanceDigest: suite.receipt.acceptanceDigest,
					},
					command: visibleTestCommand(parsed.guidance),
					allowNoChange: false,
				};
			}

			return {
				kind: "ready",
				workspace,
				build,
				inputs: {
					contract,
					files: new Set(checkout.files),
					source: contract.contract.snapshot.source,
					link: null,
				},
				prompt:
					run.stage === "build"
						? buildPrompt({
								contract: contract.contract,
								guidance: parsed.guidance,
								inlined: shown,
							})
						: acceptancePrompt({
								contract: contract.contract,
								files: checkout.files,
								inlined: shown,
								guidance: parsed.guidance,
							}),
			};
		}

		const stored = await this.#input.store.readSnapshot({
			repo,
			issue: run.issue,
			eventId: run.eventId,
		});

		if (stored.kind !== "found") return wait("snapshot");

		if (stored.receipt.snapshotDigest !== run.snapshotDigest) {
			return fail("snapshot_mismatch");
		}

		const linked = await files.readLink(run.runId);

		if (linked.kind === "unreadable") return wait("link");

		const link = linked.kind === "found" ? linked.link : null;
		const answers = link === null ? null : await files.readAnswers(run.runId);

		if (
			link !== null &&
			(answers === null || answers.digest !== link.answersDigest)
		) {
			return wait("answers");
		}

		const set = new Set(checkout.files);
		const { title, body } = stored.snapshot;
		const readme = checkout.files.find((path) => /^readme\.md$/i.test(path));

		const wanted = [
			...(readme === undefined ? [] : [readme]),
			...namedFiles(
				[title, body, ...(answers?.answers ?? []).map((a) => a.body)].join(
					"\n",
				),
				set,
			),
		];

		const shown: InlinedFile[] = [];
		let budget = INLINE_TOTAL_BYTES;

		for (const path of new Set(wanted)) {
			const text = await checkout.read(path, NAMED_FILE_READ_BYTES);

			if (text === null || budget < 1024) continue;

			const file = inlined(path, text, Math.min(NAMED_FILE_BYTES, budget));

			budget -= Buffer.byteLength(file.text, "utf8");
			shown.push(file);
		}

		return {
			kind: "ready",
			inputs: { files: set, source: stored.receipt.snapshotSource, link },
			specify: { title, body, answers, files: checkout.files },
			prompt: specifyPrompt({
				repo,
				baseSha: run.workflowSha,
				guidance: parsed.guidance,
				files: checkout.files,
				inlined: shown,
				title,
				body,
				answers,
			}),
		};
	}

	#specified(
		run: ActiveRun,
		output: string | null,
	): Extract<RunPhase, { kind: "reporting" }> | null {
		const inputs = run.inputs;
		const fields = { issue: run.issue, runId: run.runId, attempt: run.attempt };

		if (output === null || inputs === null) {
			this.#input.log("specify_malformed", { ...fields, reason: "no_output" });

			return null;
		}

		const parsed = parseSpecifyOutput(output, inputs.files);
		const repo = this.#input.repo;

		if (parsed.kind === "questions") {
			run.clearNeedsInfo = false;
			const digest = questionsDigestOf(parsed.questions);

			const body = renderQuestions({
				repo,
				sha: run.workflowSha,
				runId: run.runId,
				questions: parsed.questions,
				digest,
			});

			if (body !== null) {
				return {
					kind: "reporting",
					status: "needs_info",
					effects: {
						kind: "questions",
						questions: parsed.questions,
						digest,
						body,
						stored: false,
						posted: false,
						labeled: false,
						unlabeled: false,
						labelTick: 0,
					},
				};
			}
		}

		if (parsed.kind === "contract") {
			const contract: Contract = {
				version: CONTRACT_VERSION,
				runId: run.runId,
				issue: run.issue,
				base: { repo, sha: run.workflowSha },
				snapshot: {
					digest: run.snapshotDigest,
					source: inputs.source,
					eventId: run.eventId,
					eventAt: run.eventAt,
				},
				link: inputs.link,
				...parsed.draft,
			};

			const bytes = contractBytes(contract);
			const digest = contractDigestOf(bytes);

			const body = renderSummary({
				runId: run.runId,
				contract: parsed.draft,
				digest,
			});

			if (body !== null) {
				return {
					kind: "reporting",
					status: "stage_passed",
					effects: {
						kind: "contract",
						contract,
						bytes,
						digest,
						body,
						stored: false,
						posted: false,
					},
				};
			}
		}

		this.#input.log("specify_malformed", {
			...fields,
			reason: parsed.kind === "malformed" ? parsed.reason : "too_large_to_post",
		});

		return null;
	}

	#accepted(
		run: ActiveRun,
		output: string | null,
		model?: string,
		observed?: string | null,
	): Extract<RunPhase, { kind: "reporting" }> | null {
		const bound = run.inputs?.contract;

		if (bound === undefined || output === null) return null;
		const parsed = writeAcceptance(output, bound.contract);

		if (parsed.kind === "malformed") {
			this.#input.log("acceptance_malformed", {
				runId: run.runId,
				reason: parsed.reason,
			});

			return null;
		}

		return {
			kind: "reporting",
			status: "stage_passed",
			effects: {
				kind: "acceptance",
				contract: bound.contract,
				contractDigest: bound.digest,
				suite: parsed.suite,
				model: model ?? this.#config?.stages.accept.model ?? "openai/unknown",
				observed: observed ?? null,
			},
		};
	}

	async #recoverOutput(
		run: ActiveRun,
		output: StageOutput | null,
	): Promise<boolean> {
		const stage = run.stage;

		if (stage === "build") {
			if (output instanceof Object && output.kind === "pending") {
				run.phase = { kind: "recovering", output };

				return true;
			}

			if (!(output instanceof Object) || output.kind !== "build") return false;

			if (
				output.result.kind === "unavailable" ||
				(output.result.kind === "found" &&
					output.result.receipt.policy === "clean" &&
					output.result.receipt.visibleTests?.exitCode == null)
			) {
				if (!this.#enabled) {
					run.phase = { kind: "recovering", output };

					return true;
				}

				const limits = this.#limits();

				if (limits === null) return false;
				this.#input.log("stage_inputs_unavailable", {
					runId: run.runId,
					why:
						output.result.kind === "unavailable"
							? output.result.reason
							: "visible_tests_unavailable",
				});
				this.#endStage(run, "stage_failed", 0, limits);

				return true;
			}

			const bound = await this.#input.files.readContract(run.runId);
			const result = output.result;

			if (
				bound.kind === "blocked" ||
				result.kind !== "found" ||
				(result.receipt.round ?? 0) !== (run.round ?? 0) ||
				result.receipt.baseSha !== run.workflowSha ||
				result.receipt.contractDigest !== bound.digest
			) {
				this.#input.log("stage_inputs_refused", {
					runId: run.runId,
					why: result.kind === "blocked" ? result.reason : "patch_binding",
				});
				run.phase = { kind: "ending", status: "failed" };
				this.state.totals.failures++;

				return true;
			}

			run.phase = {
				kind: "reporting",
				status: "stage_passed",
				effects: { kind: "build", result },
			};

			return true;
		}

		if (stage === "review") {
			if (output instanceof Object && output.kind === "pending") {
				run.phase = { kind: "claimed" };

				return true;
			}

			if (output instanceof Object && output.kind === "review") {
				run.phase = {
					kind: "reporting",
					status: "stage_passed",
					effects: output,
				};

				return true;
			}

			return false;
		}

		if (stage !== "specify" && stage !== "accept") return false;

		if (stage === "accept") {
			const bound = await this.#input.files.readContract(run.runId);

			if (bound.kind === "blocked") {
				this.#input.log("stage_inputs_refused", {
					runId: run.runId,
					why: bound.reason,
				});
				run.phase = { kind: "ending", status: "failed" };
				this.state.totals.failures++;

				return true;
			}

			const kept = await this.#input.files.artifacts.read(
				run.runId,
				bound.contract,
				bound.digest,
			);

			if (kept.kind === "blocked") {
				this.#input.log("stage_inputs_refused", {
					runId: run.runId,
					why: kept.reason,
				});
				run.phase = { kind: "ending", status: "failed" };
				this.state.totals.failures++;

				return true;
			}

			if (kept.kind === "found") {
				run.phase = {
					kind: "reporting",
					status: "stage_passed",
					effects: {
						kind: "acceptance",
						contract: bound.contract,
						contractDigest: bound.digest,
						suite: kept.suite,
						model: kept.receipt.model,
						observed: kept.receipt.observed,
					},
				};

				return true;
			}
		}

		if (
			output === null ||
			(output instanceof Object &&
				(output.kind === "build" || output.kind === "review"))
		)
			return false;

		if (output instanceof Object && output.kind === "pending") {
			run.phase = { kind: "claimed" };

			return true;
		}

		const prepared = await this.#stageInputs(run);

		if (prepared.kind === "wait") {
			run.phase = { kind: "recovering", output };

			return true;
		}

		if (prepared.kind === "fail") {
			run.phase = { kind: "ending", status: "failed" };
			this.state.totals.failures++;

			return true;
		}

		if (prepared.inputs === null) return false;

		run.inputs = prepared.inputs;

		const text = output instanceof Object ? output.text : output;

		const reporting =
			stage === "specify"
				? this.#specified(run, text)
				: this.#accepted(
						run,
						text,
						output instanceof Object ? output.model : undefined,
						output instanceof Object ? output.observed : null,
					);

		if (reporting === null) return false;

		run.phase = reporting;

		return true;
	}

	async #hasKeyed(issue: number, key: string): Promise<boolean | null> {
		const comments = await this.#adapter.readComments(issue);

		if (comments.kind === "failed") return null;

		return comments.value.some(
			(comment) =>
				isControllerComment(comment) &&
				comment.body.trimEnd().split("\n").at(-1) === key,
		);
	}

	async #postKeyed(
		run: ActiveRun,
		key: string,
		body: string,
	): Promise<boolean> {
		const found = await this.#hasKeyed(run.issue, key);

		if (found === null) return false;

		if (found) return true;

		const post = await this.#writer.postComment(run.issue, body);

		if (post.kind !== "posted") {
			this.#input.log("comment_unconfirmed", {
				issue: run.issue,
				runId: run.runId,
				outcome: post.kind,
			});
		}

		return post.kind === "posted";
	}

	async #applyEffects(run: ActiveRun, effects: Effects): Promise<boolean> {
		const { files } = this.#input;
		const fields = { issue: run.issue, runId: run.runId };

		if (effects.kind === "build") {
			const receipt = effects.result.receipt;
			const contract = await files.readContract(run.runId);

			const suite =
				contract.kind === "found"
					? await files.artifacts.read(
							run.runId,
							contract.contract,
							contract.digest,
						)
					: null;

			if (
				contract.kind !== "found" ||
				suite?.kind !== "found" ||
				receipt.contractDigest !== contract.digest ||
				receipt.acceptanceDigest !== suite.receipt.acceptanceDigest ||
				receipt.baseSha !== run.workflowSha ||
				(receipt.round ?? 0) !== (run.round ?? 0)
			) {
				this.#input.log("stage_inputs_refused", {
					...fields,
					why: "patch_binding",
				});
				run.phase = { kind: "ending", status: "failed" };
				this.state.totals.failures++;

				return false;
			}

			const body = renderBuildSummary({ runId: run.runId, receipt });

			if (body === null) {
				run.phase = { kind: "ending", status: "failed" };
				this.state.totals.failures++;
				this.#input.log("stage_inputs_refused", {
					...fields,
					why: "summary_too_large",
				});

				return false;
			}

			const posted = await this.#postKeyed(
				run,
				buildKey(run.runId, receipt.patchDigest),
				body,
			);

			if (
				posted &&
				(receipt.policy === "forbidden" || receipt.visibleTests?.exitCode !== 0)
			) {
				run.phase = { kind: "ending", status: "failed" };
				this.state.totals.failures++;

				return false;
			}

			return posted;
		}

		if (effects.kind === "review") {
			const receipt = effects.receipt;

			if (
				receipt.runId !== run.runId ||
				receipt.round !== (run.round ?? 0) ||
				receipt.candidateSha !== run.validation?.publication?.candidateSha ||
				receipt.ciRunId !== run.validation?.ciRunId
			) {
				run.phase = { kind: "ending", status: "failed" };
				this.state.totals.failures++;

				return false;
			}

			if (receipt.blocking) {
				await this.#repairOrFail(run, "blocking_review");

				return false;
			}

			return true;
		}

		if (effects.kind === "acceptance") {
			const stored = await files.artifacts.store(effects);

			if (stored.kind !== "found") {
				this.#input.log("stage_inputs_refused", {
					...fields,
					why: stored.kind === "blocked" ? stored.reason : "acceptance_missing",
				});
				run.phase = { kind: "ending", status: "failed" };
				this.state.totals.failures++;

				return false;
			}

			const digest = stored.receipt.acceptanceDigest;
			this.#input.log("acceptance_stored", { ...fields, digest });

			const body = renderAcceptanceSummary({
				runId: run.runId,
				digest,
				scenarios: stored.suite.scenarios,
			});

			if (body === null) {
				this.#input.log("stage_inputs_refused", {
					...fields,
					why: "summary_too_large",
				});
				run.phase = { kind: "ending", status: "failed" };
				this.state.totals.failures++;

				return false;
			}

			return this.#postKeyed(run, acceptanceKey(run.runId, digest), body);
		}

		if (effects.kind === "contract") {
			effects.stored ||= await files.writeContract(effects);

			if (!effects.stored) {
				this.#input.log("contract_unwritable", fields);

				return false;
			}

			this.#input.log("contract_stored", { ...fields, digest: effects.digest });

			effects.posted ||= await this.#postKeyed(
				run,
				contractKey(run.runId, effects.digest),
				effects.body,
			);

			return effects.posted;
		}

		effects.stored ||= await files.writeQuestions({
			runId: run.runId,
			questions: effects.questions,
			digest: effects.digest,
		});

		if (!effects.stored) {
			this.#input.log("questions_unwritable", fields);

			return false;
		}

		effects.posted ||= await this.#postKeyed(
			run,
			questionsKey(run.runId, effects.digest),
			effects.body,
		);

		if (!effects.posted) return false;

		if (effects.unlabeled) return true;

		if (effects.labelTick === this.#ticks) return false;

		effects.labelTick = this.#ticks;

		if (!effects.labeled) {
			const issue = await this.#adapter.readIssue(run.issue);

			if (issue.kind === "failed") return false;

			effects.labeled = issue.value.labels.includes(NEEDS_INFO_LABEL);
		}

		if (!effects.labeled) {
			const added = await this.#writer.addLabels(run.issue, [NEEDS_INFO_LABEL]);

			effects.labeled = await this.#labelOutcome(
				run,
				NEEDS_INFO_LABEL,
				added.kind,
			);
		}

		if (!effects.labeled) return false;

		const timeline = await this.#adapter.readTimeline(run.issue);

		if (timeline.kind === "failed") return false;

		const latest = latestReadyEntry(timeline.value);

		if (latest.kind !== "found") {
			effects.unlabeled = true;
			this.#input.log("ready_label_preserved", { ...fields, why: latest.kind });

			return true;
		}

		if (latest.entry.kind === "unlabeled" || latest.entry.id !== run.eventId) {
			effects.unlabeled = true;
			this.#input.log(
				latest.entry.kind === "unlabeled"
					? "ready_label_already_removed"
					: "ready_label_preserved",
				{
					...fields,
					eventId: latest.entry.id,
				},
			);
		} else {
			const removed = await this.#writer.removeLabel(run.issue, READY_LABEL);

			effects.unlabeled = await this.#labelOutcome(
				run,
				READY_LABEL,
				removed.kind,
			);
		}

		return effects.unlabeled;
	}

	async #writeClaim(run: ActiveRun): Promise<void> {
		const written = await this.#input.files.writeClaim(claimOf(run));

		run.claimUnwritten = !written;

		if (!written) {
			this.#input.log("claim_unwritable", {
				issue: run.issue,
				runId: run.runId,
			});
		}
	}

	async #recoverUncertainPost(run: ActiveRun): Promise<"proceed" | "stop"> {
		if (run.inflight?.outcome === "unknown") {
			const ledger = await this.#readLedger(run.issue);

			if (ledger.kind === "failed") return "stop";

			if (ledger.value.kind === "corrupt") {
				this.#markCorrupt(run.issue, ledger.value, null);

				return "stop";
			}

			if (this.#localAhead(run.issue, ledger.value) !== null) return "stop";

			const sent = run.inflight.marker;
			const latest = latestFor(ledger.value, run.runId);

			if (latest?.marker.seq === sent.seq) this.#landed(run, sent);
			else run.inflight = null;
		}

		if (run.inflight?.outcome === "rejected") run.inflight = null;

		return "proceed";
	}

	async #publishMarker(run: ActiveRun): Promise<void> {
		const status = desiredStatus(run.phase);
		const marked = run.marked;

		if (
			marked === null ||
			marked.status !== status ||
			marked.stage !== run.stage ||
			marked.attempt !== run.attempt ||
			marked.usage !== run.usage ||
			marked.branch !== (run.validation?.publication?.branch ?? null) ||
			(marked.candidate ?? null) !==
				(run.validation?.publication?.candidateSha ?? null) ||
			(marked.round ?? 0) !== (run.round ?? 0) ||
			(marked.ciRun ?? null) !== (run.validation?.ciRunId ?? null)
		) {
			const marker = markerOf(run, {
				repo: this.#input.repo,
				status,
				seq: run.seq + 1,
				cursor: this.state.seen.get(run.issue)?.updatedAt ?? null,
			});

			const post = await this.#writer.postComment(
				run.issue,
				formatMarker(marker),
			);

			if (post.kind === "posted") {
				this.state.totals.markersPosted++;
				this.#landed(run, marker);
			} else {
				run.inflight = { marker, outcome: post.kind, tick: this.#ticks };
				this.#input.log("marker_unconfirmed", {
					issue: run.issue,
					runId: run.runId,
					seq: marker.seq,
					outcome: post.kind,
				});
			}
		}
	}

	#landed(run: ActiveRun, marker: Marker): void {
		run.marked = marker;
		run.seq = marker.seq;
		run.inflight = null;
		this.#local.set(run.issue, { ...claimOf(run), seq: run.seq });
		this.#behind.delete(run.issue);
		this.#input.log("marker_posted", {
			issue: run.issue,
			runId: run.runId,
			seq: marker.seq,
			status: marker.status,
			stage: marker.stage,
		});
	}

	#report(input: ReportInput): TickReport {
		const runs = [...this.state.runs.values()]
			.sort((left, right) => left.issue - right.issue)
			.map(
				(run): RunView => ({
					issue: run.issue,
					runId: run.runId,
					eventId: run.eventId,
					stage: run.stage,
					status: desiredStatus(run.phase),
					attempt: run.attempt,
					seq: run.seq,
					markerPending: run.inflight !== null,
					workspace: run.workspaceMissing ? "missing_replayed" : "present",
					retryAt:
						run.phase.kind === "retry_queued"
							? new Date(run.phase.dueAt).toISOString()
							: null,
					usage: run.usage,
				}),
			);

		return {
			repo: this.#input.repo,
			at: new Date(input.now).toISOString(),
			executionEnabled: this.#enabled,
			dispatch: { enabled: input.enabled, reasons: input.reasons },
			workflowSha: this.#workflowSha,
			maxConcurrent: input.limits?.maxConcurrent ?? 0,
			active: this.#active(),
			runs,
			queued: input.queued,
			absent: input.absent,
			refused: [
				...input.refused,
				...[...this.state.seen.entries()].flatMap(([issue, seen]) =>
					seen.verdict.kind === "refused" &&
					!input.refused.some((entry) => entry.issue === issue)
						? [{ issue, reasons: [seen.verdict.reason] }]
						: [],
				),
			],
			corrupt: [...this.state.corrupt.entries()]
				.sort(([left], [right]) => left - right)
				.map(([issue, entry]) => ({ issue, defect: entry.defect })),
			ledgerBehind: [...this.#behind.values()].sort(
				(left, right) => left.issue - right.issue,
			),
			totals: { ...this.state.totals },
		};
	}
}

function claimOf(run: ActiveRun): ClaimRecord {
	const claim: ClaimRecord = {
		runId: run.runId,
		issue: run.issue,
		eventId: run.eventId,
		seq: run.marked === null ? null : run.seq,
		status: run.marked?.status ?? null,
		stage: run.marked?.stage ?? null,
		attempt: run.marked?.attempt ?? null,
		usage: run.marked?.usage ?? null,
	};

	const saved =
		(run.round ?? 0) > (run.marked?.round ?? 0)
			? { ...claim, stage: run.stage, attempt: run.attempt, usage: run.usage }
			: claim;

	const labels =
		run.labelFailures === 0
			? saved
			: { ...saved, labelFailures: run.labelFailures };

	if (run.validation === undefined)
		return (run.round ?? 0) > 0 ? { ...labels, round: run.round } : labels;

	return {
		...labels,
		validation: run.validation,
		branch: run.validation.publication?.branch ?? null,
		candidate: run.validation.publication?.candidateSha ?? null,
		round: run.validation.round,
		ciRun: run.validation.ciRunId,
	};
}

function recordOf(marker: Marker): ConfirmedRecord {
	return {
		runId: marker.runId,
		issue: marker.issue,
		eventId: marker.eventId,
		seq: marker.seq,
		status: marker.status,
		stage: marker.stage,
		attempt: marker.attempt,
		usage: marker.usage,
	};
}

function markerOf(
	run: Omit<
		Marker,
		"v" | "repo" | "status" | "seq" | "branch" | "pr" | "cursor"
	> & { readonly validation?: ValidationState; readonly round?: number },

	next: Pick<Marker, "repo" | "status" | "seq" | "cursor">,
): Marker {
	return {
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
		branch: run.validation?.publication?.branch ?? null,
		candidate: run.validation?.publication?.candidateSha ?? null,
		round: run.round ?? 0,
		ciRun: run.validation?.ciRunId ?? null,
		pr: null,
		usage: run.usage,
		cursor: next.cursor,
	};
}

function matchesRecord(marker: Marker, receipt: AdmittedReceipt): boolean {
	return (
		marker.eventAt === receipt.eventAt &&
		marker.snapshotDigest === receipt.snapshotDigest &&
		marker.workflowSha === receipt.baseSha &&
		marker.workflowDigest === receipt.workflowDigest
	);
}
