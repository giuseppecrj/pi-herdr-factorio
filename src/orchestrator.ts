import {
	type AdmissionStore,
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
} from "./adapters/github.ts";
import type { Exec } from "./gh.ts";
import {
	CONTROLLER_LOGIN,
	currentMarker,
	formatMarker,
	isMarkerCandidate,
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
import {
	DEFAULTS,
	type EnvLookup,
	type GitSha,
	type RepoSlug,
	type WorkflowConfig,
} from "./workflow.ts";

/** Milliseconds since the epoch. Tests pass a fake. */
export type Clock = { now(): number };

/** How a stage launch ended before any model ran. */
export type StageLaunch =
	| {
			readonly kind: "unavailable";
			readonly stage: Stage;
			readonly reason: "stage_runner_not_installed";
	  }
	| { readonly kind: "started"; readonly done: Promise<StageResult> };

/** A started stage that ended without passing. `usage` counts toward the run budget. */
export type StageResult = { readonly kind: "failed"; readonly usage: number };

export interface StageExecutor {
	launch(input: {
		runId: Digest;
		stage: Stage;
		workspace: string;
		signal: AbortSignal;
		progress: () => void;
	}): Promise<StageLaunch>;
}

/** The only executor until F05 installs the stage runner. It runs no model. */
export const UNAVAILABLE_EXECUTOR: StageExecutor = {
	async launch({ stage }) {
		return {
			kind: "unavailable",
			stage,
			reason: "stage_runner_not_installed",
		};
	},
};

/** A local record that a run holds a claim, so a restart finds it even after the issue leaves the candidates. */
export type ClaimRecord = {
	readonly runId: Digest;
	readonly issue: number;
	readonly eventId: string;
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
	removeClaim(runId: Digest): Promise<void>;
}

export type RetryCause = "stage_failed" | "stalled" | "interrupted";

export type RunPhase =
	| { readonly kind: "claimed" }
	| {
			readonly kind: "running";
			readonly startedAt: number;
			lastProgressAt: number;
			readonly abort: AbortController;
			result: StageResult | null;
	  }
	| {
			readonly kind: "blocked";
			readonly reason: "stage_runner_not_installed";
	  }
	| {
			readonly kind: "retry_queued";
			readonly dueAt: number;
			readonly cause: RetryCause;
	  }
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
	workspaceMissing: boolean;
	/** Set on a run adopted after a restart: its stage launches once more. */
	replay: boolean;
	phase: RunPhase;
};

/** What the controller last decided for an issue at one `updated_at`. */
export type SeenIssue = {
	readonly updatedAt: string;
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
	readonly executionEnabled: false;
	readonly dispatch: {
		readonly enabled: boolean;
		readonly reasons: readonly GateReason[];
	};
	readonly workflowSha: GitSha | null;
	readonly maxConcurrent: number;
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

type Gate =
	| { readonly kind: "open"; readonly reads: TickReads }
	| { readonly kind: "closed"; readonly reasons: readonly GateReason[] };

/** Symphony §8.4: `min(10000 * 2^(retry - 1), maxBackoffMs)`, for the 1-based retry. */
export function backoffMs(retry: number, maxBackoffMs: number): number {
	return Math.min(10_000 * 2 ** (retry - 1), maxBackoffMs);
}

function limitsOf(config: WorkflowConfig | null): Limits {
	return {
		maxConcurrent: config?.agent.maxConcurrent ?? DEFAULTS.maxConcurrent,
		maxAttempts: config?.retry.maxAttempts ?? DEFAULTS.maxAttempts,
		maxBackoffMs: config?.retry.maxBackoffMs ?? DEFAULTS.maxBackoffMs,
		maxTokensPerRun: config?.usage.maxTokensPerRun ?? DEFAULTS.maxTokensPerRun,
		stallMs: (stage) =>
			config?.stages[stage].budget.stallMs ?? DEFAULTS.stallMs,
	};
}

const SETTLED_REFUSALS: ReadonlySet<RefusalReason["kind"]> = new Set([
	"pull_request",
	"issue_closed",
	"not_labeled",
	"no_label_event",
	"actor_withheld",
	"unauthorized",
	"ambiguous_snapshot",
]);

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

function holdsSlot(run: ActiveRun): boolean {
	return (
		run.phase.kind === "claimed" ||
		run.phase.kind === "running" ||
		run.phase.kind === "blocked"
	);
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
	readonly #recover = new Set<number>();

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

	get adapter(): GitHubTicketAdapter {
		return this.#adapter;
	}

	/** The poll interval of the last valid workflow, or the default. */
	get pollIntervalMs(): number {
		return this.#config?.polling.intervalMs ?? DEFAULTS.pollIntervalMs;
	}

	#inScope(issue: number): boolean {
		const { scope } = this.#input;

		return scope === null || scope.includes(issue);
	}

	async tick(): Promise<TickReport> {
		const now = this.#input.clock.now();
		const queued: number[] = [];

		this.#ticks++;
		const refused: { issue: number; reasons: RefusalReason["kind"][] }[] = [];

		if (!this.#claimsLoaded) await this.#loadClaims();

		const gate = await this.#gate();
		const limits = limitsOf(this.#config);
		const candidates = await this.#candidates();
		const reasons = gate.kind === "closed" ? [...gate.reasons] : [];

		if (candidates.kind === "failed") reasons.push("candidates_unavailable");

		await this.#reconcile(now, candidates, limits);

		if (candidates.kind === "ok") {
			await this.#discover(candidates.value);
		}

		const open = gate.kind === "open" && candidates.kind === "ok";

		if (open) {
			await this.#dispatch({
				now,
				candidates: candidates.value,
				reads: gate.reads,
				limits,
				queued,
				refused,
			});
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

		return this.#report({
			now,
			enabled: open,
			reasons,
			limits,
			queued,
			absent,
			refused,
		});
	}

	async #loadClaims(): Promise<void> {
		for (const claim of await this.#input.files.listClaims()) {
			if (this.#inScope(claim.issue)) this.#recover.add(claim.issue);
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

	async #reconcile(
		now: number,
		candidates: Read<IssueRecord[]>,
		limits: Limits,
	): Promise<void> {
		for (const run of this.state.runs.values()) {
			const { phase } = run;

			if (phase.kind === "running" && phase.result !== null) {
				await this.#failed(run, "stage_failed", phase.result.usage, limits);
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
				await this.#failed(run, "stalled", 0, limits);
			}

			if (candidates.kind === "ok") {
				await this.#checkEligible(run, candidates.value);
			}

			await this.#sync(run);
		}
	}

	async #checkEligible(
		run: ActiveRun,
		candidates: readonly IssueRecord[],
	): Promise<void> {
		if (run.phase.kind === "ending") return;

		const record = candidates.find((item) => item.number === run.issue);

		if (record === undefined) {
			const read = await this.#adapter.readIssue(run.issue);

			if (read.kind === "failed") return;

			const issue = read.value;

			if (
				!issue.open ||
				issue.pullRequest ||
				!issue.labels.includes(READY_LABEL)
			) {
				this.#release(run, issue.open ? "unlabeled" : "closed");
			}

			return;
		}

		if (this.state.seen.get(run.issue)?.updatedAt === record.updatedAt) return;

		const timeline = await this.#adapter.readTimeline(run.issue);

		if (timeline.kind === "failed") return;

		const latest = latestReadyEntry(timeline.value);

		if (
			latest.kind !== "found" ||
			latest.entry.kind !== "labeled" ||
			latest.entry.id !== run.eventId
		) {
			this.#release(run, "new_event");

			return;
		}

		this.state.seen.set(run.issue, {
			updatedAt: record.updatedAt,
			verdict: { kind: "claimed" },
		});
	}

	#release(run: ActiveRun, why: "closed" | "unlabeled" | "new_event"): void {
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

	async #failed(
		run: ActiveRun,
		cause: RetryCause,
		usage: number,
		limits: Limits,
	): Promise<void> {
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
				cause,
			};
		}

		this.#input.log("stage_ended", {
			issue: run.issue,
			runId: run.runId,
			cause,
			next: desiredStatus(run.phase),
			attempt: run.attempt,
		});
		await this.#sync(run);
	}

	async #readLedger(issue: number): Promise<Read<MarkerLedger>> {
		const comments = await this.#adapter.readComments(issue);

		if (comments.kind === "failed") return comments;

		const candidates = comments.value.filter(isMarkerCandidate);

		const edits = await this.#adapter.readCommentEdits(
			candidates.map((comment) => comment.nodeId),
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
			this.state.seen.set(issue, { updatedAt, verdict: { kind: "corrupt" } });
		}

		this.#input.log("marker_corrupt", {
			issue,
			defect: ledger.defect,
			commentId: ledger.commentId,
		});
	}

	async #discover(candidates: readonly IssueRecord[]): Promise<void> {
		const records = new Map(
			candidates.map((record) => [record.number, record]),
		);

		for (const issue of this.#recover) {
			if (records.has(issue) || this.state.runs.has(issue)) {
				this.#recover.delete(issue);
				continue;
			}

			const read = await this.#adapter.readIssue(issue);

			if (read.kind === "ok") records.set(issue, read.value);
		}

		for (const record of records.values()) {
			const issue = record.number;

			if (this.state.runs.has(issue)) continue;

			if (this.state.seen.get(issue)?.updatedAt === record.updatedAt) {
				continue;
			}

			const ledger = await this.#readLedger(issue);

			if (ledger.kind === "failed") continue;

			this.#recover.delete(issue);

			if (ledger.value.kind === "corrupt") {
				this.#markCorrupt(issue, ledger.value, record.updatedAt);
				continue;
			}

			this.state.corrupt.delete(issue);

			const current = currentMarker(ledger.value);

			if (current !== null && !isTerminal(current.status)) {
				await this.#adopt({
					marker: current,
					ledger: ledger.value,
					candidates,
					updatedAt: record.updatedAt,
				});
				continue;
			}

			const candidate = record.open && candidates.includes(record);

			await this.#forgetClaims(ledger.value, issue, candidate);

			if (!candidate) {
				this.state.seen.set(issue, {
					updatedAt: record.updatedAt,
					verdict: { kind: "decided" },
				});
				continue;
			}

			this.state.seen.set(issue, {
				updatedAt: record.updatedAt,
				verdict: { kind: "open", ledger: ledger.value },
			});
		}
	}

	async #forgetClaims(
		ledger: CleanLedger,
		issue: number,
		candidate: boolean,
	): Promise<void> {
		for (const claim of await this.#input.files.listClaims()) {
			if (claim.issue !== issue) continue;

			const latest = latestFor(ledger, claim.runId);

			if (!candidate || (latest !== null && isTerminal(latest.marker.status))) {
				await this.#input.files.removeClaim(claim.runId);
			}
		}
	}

	async #adopt(input: {
		marker: Marker;
		ledger: CleanLedger;
		candidates: readonly IssueRecord[];
		updatedAt: string;
	}): Promise<void> {
		const { marker, ledger, candidates } = input;

		const record = await this.#input.store.read({
			repo: this.#input.repo,
			issue: marker.issue,
			eventId: marker.eventId,
		});

		if (record.kind === "unreadable") return;

		if (record.kind === "found" && !matchesRecord(marker, record.receipt)) {
			this.#markCorrupt(
				marker.issue,
				{ kind: "corrupt", defect: "record_mismatch", commentId: "" },
				input.updatedAt,
			);

			return;
		}

		const workspace = await this.#input.files.workspaceState(marker.runId);
		const seq = ledger.markers.at(-1)?.marker.seq ?? marker.seq;

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
			workspaceMissing: workspace === "missing",
			replay: true,
			phase:
				marker.status === "blocked"
					? { kind: "blocked", reason: "stage_runner_not_installed" }
					: { kind: "claimed" },
		};

		this.state.runs.set(run.issue, run);
		await this.#input.files.writeClaim({
			runId: run.runId,
			issue: run.issue,
			eventId: run.eventId,
		});

		this.#input.log("claim_adopted", {
			issue: run.issue,
			runId: run.runId,
			status: marker.status,
			seq,
			workspace,
		});

		const limits = limitsOf(this.#config);

		if (marker.status === "running") {
			await this.#failed(run, "interrupted", 0, limits);
		} else if (marker.status === "retrying") {
			const created = ledger.markers.at(-1)?.createdAt ?? "";

			run.phase = {
				kind: "retry_queued",
				dueAt:
					Date.parse(created) +
					backoffMs(Math.max(run.attempt - 1, 1), limits.maxBackoffMs),
				cause: "interrupted",
			};
		}

		await this.#checkEligible(run, candidates);
		await this.#sync(run);
	}

	async #dispatch(input: {
		now: number;
		candidates: readonly IssueRecord[];
		reads: TickReads;
		limits: Limits;
		queued: number[];
		refused: { issue: number; reasons: RefusalReason["kind"][] }[];
	}): Promise<void> {
		const { now, limits } = input;
		const runs = [...this.state.runs.values()];

		let slots = Math.max(
			limits.maxConcurrent - runs.filter(holdsSlot).length,
			0,
		);

		for (const run of runs) {
			if (
				run.inflight === null &&
				(run.phase.kind === "claimed" ||
					(run.phase.kind === "blocked" && run.replay))
			) {
				await this.#launch(run);
			}
		}

		for (const run of runs) {
			if (run.phase.kind !== "retry_queued" || run.phase.dueAt > now) continue;

			if (slots === 0) break;

			slots--;
			await this.#launch(run);
		}

		for (const record of input.candidates) {
			const issue = record.number;
			const seen = this.state.seen.get(issue);

			if (this.state.runs.has(issue) || seen?.verdict.kind !== "open") {
				continue;
			}

			if (slots === 0) {
				input.queued.push(issue);
				continue;
			}

			const claimed = await this.#admit({
				record,
				ledger: seen.verdict.ledger,
				reads: input.reads,
				refused: input.refused,
			});

			if (claimed !== null) {
				slots--;
				await this.#launch(claimed);
			}
		}
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

		const receipt = await admitTicket({
			exec: this.#input.exec,
			env: this.#input.env,
			repo,
			issue,
			allowlist: FACTORY_REPOSITORIES,
			store: this.#input.store,
			paging: this.#input.paging,
			tick: input.reads,
		});

		let admitted: AdmittedReceipt;

		if (receipt.decision === "admitted") {
			admitted = receipt;
		} else {
			const kinds = receipt.reasons.map((reason) => reason.kind);

			if (!kinds.includes("duplicate_event") || receipt.eventId === null) {
				input.refused.push({ issue, reasons: kinds });

				if (kinds.every((kind) => SETTLED_REFUSALS.has(kind))) {
					this.state.seen.set(issue, {
						updatedAt: record.updatedAt,
						verdict: { kind: "decided" },
					});
				}

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

			admitted = stored.receipt;
		}

		const runId = runIdOf({ repo, issue, eventId: admitted.eventId });
		const latest = latestFor(ledger, runId);

		if (latest !== null) {
			this.state.seen.set(issue, {
				updatedAt: record.updatedAt,
				verdict: { kind: "decided" },
			});

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
			seq: ledger.markers.at(-1)?.marker.seq ?? 0,
			marked: null,
			inflight: null,
			workspaceMissing: false,
			replay: false,
			phase: { kind: "claimed" },
		};

		if (
			!(await this.#input.files.writeClaim({
				runId,
				issue,
				eventId: run.eventId,
			}))
		) {
			this.#input.log("claim_unwritable", { issue, runId });

			return null;
		}

		this.state.runs.set(issue, run);
		this.state.totals.claims++;
		this.state.seen.set(issue, {
			updatedAt: record.updatedAt,
			verdict: { kind: "claimed" },
		});
		this.#input.log("claim_taken", {
			issue,
			runId,
			eventId: run.eventId,
		});
		await this.#sync(run);

		if ((await this.#input.files.ensureWorkspace(runId)) === "unavailable") {
			this.#input.log("workspace_unavailable", { issue, runId });
		}

		return run.inflight === null ? run : null;
	}

	async #launch(run: ActiveRun): Promise<void> {
		const { files, executor, clock } = this.#input;
		const workspace = await files.ensureWorkspace(run.runId);

		run.replay = false;

		if (workspace === "unavailable") {
			this.#input.log("workspace_unavailable", {
				issue: run.issue,
				runId: run.runId,
			});

			return;
		}

		if (workspace === "created") {
			run.workspaceMissing = true;
			this.#input.log("workspace_missing", {
				issue: run.issue,
				runId: run.runId,
				stage: run.stage,
			});
		}

		const abort = new AbortController();
		const now = clock.now();

		const phase: RunPhase = {
			kind: "running",
			startedAt: now,
			lastProgressAt: now,
			abort,
			result: null,
		};

		const launch = await executor.launch({
			runId: run.runId,
			stage: run.stage,
			workspace: files.workspacePath(run.runId),
			signal: abort.signal,
			progress: () => {
				phase.lastProgressAt = clock.now();
			},
		});

		this.state.totals.launches++;

		if (launch.kind === "unavailable") {
			run.phase = { kind: "blocked", reason: launch.reason };
		} else {
			run.phase = phase;
			launch.done.then(
				(result) => {
					phase.result = result;
				},
				() => {
					phase.result = { kind: "failed", usage: 0 };
				},
			);
		}

		this.#input.log("stage_launched", {
			issue: run.issue,
			runId: run.runId,
			stage: run.stage,
			attempt: run.attempt,
			result: launch.kind,
		});
		await this.#sync(run);
	}

	async #sync(run: ActiveRun): Promise<void> {
		if (run.inflight?.tick === this.#ticks) return;

		if (run.inflight?.outcome === "unknown") {
			const ledger = await this.#readLedger(run.issue);

			if (ledger.kind === "failed") return;

			if (ledger.value.kind === "corrupt") {
				this.#markCorrupt(run.issue, ledger.value, null);

				return;
			}

			const sent = run.inflight.marker;
			const latest = latestFor(ledger.value, run.runId);

			if (latest?.marker.seq === sent.seq) this.#landed(run, sent);
			else run.inflight = null;
		}

		if (run.inflight?.outcome === "rejected") run.inflight = null;

		const status = desiredStatus(run.phase);
		const marked = run.marked;

		if (
			marked === null ||
			marked.status !== status ||
			marked.stage !== run.stage ||
			marked.attempt !== run.attempt
		) {
			const marker: Marker = {
				v: 1,
				runId: run.runId,
				repo: this.#input.repo,
				issue: run.issue,
				eventId: run.eventId,
				eventAt: run.eventAt,
				snapshotDigest: run.snapshotDigest,
				workflowSha: run.workflowSha,
				workflowDigest: run.workflowDigest,
				stage: run.stage,
				status,
				attempt: run.attempt,
				seq: run.seq + 1,
				branch: null,
				pr: null,
				usage: run.usage,
				cursor: this.state.seen.get(run.issue)?.updatedAt ?? null,
			};

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

		if (run.marked !== null && isTerminal(run.marked.status)) {
			this.state.runs.delete(run.issue);
			await this.#input.files.removeClaim(run.runId);
		}
	}

	#landed(run: ActiveRun, marker: Marker): void {
		run.marked = marker;
		run.seq = marker.seq;
		run.inflight = null;
		this.#input.log("marker_posted", {
			issue: run.issue,
			runId: run.runId,
			seq: marker.seq,
			status: marker.status,
			stage: marker.stage,
		});
	}

	#report(input: {
		now: number;
		enabled: boolean;
		reasons: readonly GateReason[];
		limits: Limits;
		queued: readonly number[];
		absent: readonly number[];
		refused: TickReport["refused"];
	}): TickReport {
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
			executionEnabled: false,
			dispatch: { enabled: input.enabled, reasons: input.reasons },
			workflowSha: this.#workflowSha,
			maxConcurrent: input.limits.maxConcurrent,
			runs,
			queued: input.queued,
			absent: input.absent,
			refused: input.refused,
			corrupt: [...this.state.corrupt.entries()]
				.sort(([left], [right]) => left - right)
				.map(([issue, entry]) => ({ issue, defect: entry.defect })),
			totals: { ...this.state.totals },
		};
	}
}

function matchesRecord(marker: Marker, receipt: AdmittedReceipt): boolean {
	return (
		marker.eventAt === receipt.eventAt &&
		marker.snapshotDigest === receipt.snapshotDigest &&
		marker.workflowSha === receipt.baseSha &&
		marker.workflowDigest === receipt.workflowDigest
	);
}
