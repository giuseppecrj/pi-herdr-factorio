import {
	type AdmissionStore,
	type Ambiguity,
	admitTicket,
	type AdmittedReceipt,
	FACTORY_REPOSITORIES,
	latestReadyEntry,
	type RefusalReason,
	readTickInputs,
	type TickReads,
} from "./admission.ts";
import {
	DEFAULT_PAGING,
	type GitHubFailure,
	type GitHubPaging,
	GitHubTicketAdapter,
	GitHubTicketWriter,
	type IssueRecord,
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
	type Marker,
	type MarkerDefect,
	type MarkerLedger,
	markerLedger,
	type RunStatus,
	type TerminalStatus,
} from "./markers.ts";
import { READY_LABEL } from "./policy.ts";
import { type Digest, runIdOf, type Stage } from "./run.ts";
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
	type WorkflowConfig,
} from "./workflow.ts";

export type { StageResult, StageRunSettings };

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
	readonly settings: StageRunSettings;
	readonly remainingRunTokens: number;
	readonly signal: AbortSignal;
	/** Called on every sign of life, with the tokens the stage has used so far. */
	readonly progress: (usage: number) => void;
};

export interface StageExecutor {
	/** Stops whatever a previous controller left running. Called once, before the first tick adopts a run. */
	recover(): Promise<void>;
	/** Whether the stage sandbox can run. A `blocked` run replays only after this passes. */
	preflight(): Promise<boolean>;
	launch(input: StageLaunchInput): Promise<StageLaunch>;
}

/** An executor with no sandbox. Every launch is `sandbox_unavailable`, and no model runs. */
export const UNAVAILABLE_EXECUTOR: StageExecutor = {
	async recover() {},
	async preflight() {
		return false;
	},
	async launch({ stage }) {
		return { kind: "unavailable", stage, reason: "sandbox_unavailable" };
	},
};

type StageEnd = Pick<StageResult, "kind" | "usage">;

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
};

type ConfirmedRecord = ClaimRecord & { readonly seq: number };

type EndedRecord = {
	readonly claim: ConfirmedRecord;
	tick: number;
	confirmed: boolean;
	unwritten: boolean;
};

export type WorkspaceState = "present" | "missing" | "unavailable";

/** Run files under the state directory: claim records and private workspaces. */
export interface RunFiles {
	workspacePath(runId: Digest): string;
	workspaceState(runId: Digest): Promise<WorkspaceState>;
	/** Creates the workspace empty, mode 0700, when it is missing. */
	ensureWorkspace(
		runId: Digest,
	): Promise<"present" | "created" | "unavailable">;
	listClaims(): Promise<ClaimRecord[]>;
	writeClaim(claim: ClaimRecord): Promise<boolean>;
}

export type RetryCause = "stage_failed" | "stalled" | "interrupted";

export type RunPhase =
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
	| { readonly kind: "ending"; readonly status: TerminalStatus };

/**
 * A marker whose POST did not return a comment. `unknown` may have landed,
 * so it is read back before anything else is posted for the issue.
 */
export type InflightMarker = {
	readonly marker: Marker;
	readonly outcome: "unknown" | "rejected";
	/** The tick that posted it. A read-back waits for a later tick. */
	readonly tick: number;
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
	phase: RunPhase;
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
		| { readonly kind: "corrupt" };
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
			return "running";
		case "blocked":
			return "blocked";
		case "retry_queued":
			return "retrying";
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
		run.phase.kind === "claimed" ||
		run.phase.kind === "running" ||
		run.phase.kind === "blocked"
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
	store: AdmissionStore;
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

		return seen?.updatedAt === updatedAt && settled(seen);
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

		this.#enabled = await this.#input.executor.preflight();

		const held = this.#limits();

		if (held !== null) await this.#reconcileStages(now, held);

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
			await this.#reconcileStages(this.#input.clock.now(), limits);

			if (running()) await wait(DRAIN_POLL_MS);
		}

		await Promise.all(this.#stages);

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
		if (run.phase.kind === "ending") return "unverified";

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
		if (run.phase.kind === "running") run.phase.abort.abort();

		this.state.runs.delete(run.issue);
		this.#input.log("claim_dropped", {
			issue: run.issue,
			runId: run.runId,
			why: "marker_corrupt",
		});
	}

	#release(run: ActiveRun, why: ReleaseReason): void {
		if (run.phase.kind === "running") run.phase.abort.abort();

		run.phase = { kind: "ending", status: "released" };
		this.state.totals.releases++;
		this.state.seen.delete(run.issue);
		this.#input.log("claim_released", {
			issue: run.issue,
			runId: run.runId,
			why,
		});
	}

	/**
	 * Ends a stage that returned. A pass stops the run, since later stages are
	 * not installed. A refusal ends it `failed` with no scheduler retry, and a
	 * cap ends it `budget_exhausted`. Only a failure goes through the retries.
	 */
	#finishStage(run: ActiveRun, result: StageEnd, limits: Limits): void {
		if (result.kind === "failed") {
			this.#endStage(run, "stage_failed", result.usage, limits);

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

				await this.#keepEnded(recordOf(latest), true);
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
			phase: { kind: "claimed" },
		};

		this.state.runs.set(run.issue, run);
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
			phase:
				marker.status === "blocked"
					? { kind: "blocked", reason: "sandbox_unavailable" }
					: { kind: "claimed" },
		};

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

		if (eligibility !== "current" && eligibility !== "unverified") {
			this.#release(run, eligibility);
		} else if (limits !== null && marker.status === "running") {
			this.#endStage(run, "interrupted", 0, limits);
		} else if (limits !== null && marker.status === "retrying") {
			const created = ledger.markers.find(
				(entry) => entry.marker.seq === marker.seq,
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
				!this.#confirmed.has(run.issue)
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

		if ((await this.#input.files.ensureWorkspace(runId)) === "unavailable") {
			this.#input.log("workspace_unavailable", { issue, runId });
		}

		return run;
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
		if (!(await this.#stillReady(run))) return false;

		const { files, executor, clock } = this.#input;
		const config = this.#config;

		if (config === null) return false;

		const preparation = await this.#prepareWorkspace(run);

		if (preparation.kind === "unavailable") return false;

		const stage = run.stage;

		if (!isModelStage(stage)) {
			run.phase = { kind: "blocked", reason: "sandbox_unavailable" };
			await this.#sync(run);

			return true;
		}

		const abort = new AbortController();
		const now = clock.now();

		const phase: Extract<RunPhase, { kind: "running" }> = {
			kind: "running",
			lastProgressAt: now,
			usage: 0,
			abort,
			result: null,
		};

		const launch = await executor.launch({
			runId: run.runId,
			stage,
			attempt: run.attempt,
			workspace: files.workspacePath(run.runId),
			settings: {
				model: config.stages[stage].model,
				fallback: null,
				budget: config.stages[stage].budget,
				maxTokens: null,
			},
			remainingRunTokens: Math.max(0, config.usage.maxTokensPerRun - run.usage),
			signal: abort.signal,
			progress: (usage) => {
				phase.lastProgressAt = clock.now();
				phase.usage = Math.max(phase.usage, usage);
			},
		});

		this.state.totals.launches++;

		if (launch.kind === "unavailable") {
			run.phase = { kind: "blocked", reason: launch.reason };
		} else {
			run.phase = phase;

			const settled = launch.done.then(
				(result) => {
					phase.result = { kind: result.kind, usage: result.usage };
				},
				() => {
					phase.result = { kind: "failed", usage: phase.usage };
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

	async #sync(run: ActiveRun): Promise<void> {
		if (run.inflight?.tick === this.#ticks) return;

		const before = run.seq;

		if ((await this.#recoverUncertainPost(run)) === "stop") return;

		await this.#publishMarker(run);

		if (run.marked !== null && isTerminal(run.marked.status)) {
			this.state.runs.delete(run.issue);
			await this.#keepEnded({ ...claimOf(run), seq: run.seq }, false);
		} else if (run.seq !== before) {
			await this.#writeClaim(run);
		}
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
			marked.attempt !== run.attempt
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
			refused: input.refused,
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
	return {
		runId: run.runId,
		issue: run.issue,
		eventId: run.eventId,
		seq: run.marked === null ? null : run.seq,
		status: run.marked?.status ?? null,
		stage: run.marked?.stage ?? null,
		attempt: run.marked?.attempt ?? null,
		usage: run.marked?.usage ?? null,
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
	>,
	next: Pick<Marker, "repo" | "status" | "seq" | "cursor">,
): Marker {
	return {
		v: 1,
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
