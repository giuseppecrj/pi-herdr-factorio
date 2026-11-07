import { randomBytes } from "node:crypto";
import {
	readFeedbackBatch,
	renderFeedbackCards,
	builderDispositions,
	builderFindingDispositions,
} from "../src/feedback.ts";
import { draftFeedbackPrompt } from "../src/accept.ts";
import { draftNeedsRevision, type DraftFeedback } from "../src/diagnosis.ts";
import { fileArtifacts, regularText } from "../src/artifacts.ts";
import {
	candidateReviewPrompt,
	feedbackPrompt,
	keepReview,
	parseSeat,
	reviewCandidate,
	reviewFeedback,
	findingFingerprint,
	findingFingerprints,
	FAMILY_MISSING,
	type FamilyInput,
	familyFromJournal,
	familyLabel,
	parseFamily,
	withFamily,
	reviewSeats,
	reviewDir,
	seatPrompt,
	ReviewEvidenceUnavailable,
	type ReviewInput,
	type ReviewInputRefusal,
	type SeatReceipt,
} from "../src/review.ts";
import { readFeedbackBytes, validationDir } from "../src/validation.ts";
import {
	parseReviewReceipt,
	reviewReceiptDigest,
	type ReviewExecution,
} from "../src/handoff.ts";
import { isGitSha, parseWorkflow, WORKFLOW_PATH } from "../src/workflow.ts";
import {
	collectPatch,
	commandReceipts,
	baseTestCommand,
	trustedVisiblePlan,
	visibleEnvironment,
	checkBuildDisk,
	patchBinding,
	patchDir,
	roundKey,
	prepareRepairTree,
	finishPatch,
	patchedTree,
	readPatch,
	storePatch,
	TEST_TAIL_BYTES,
	type PatchRead,
	type VisibleTests,
} from "../src/build.ts";
import {
	closeSync,
	chmodSync,
	existsSync,
	fsyncSync,
	lstatSync,
	mkdirSync,
	openSync,
	readdirSync,
	readFileSync,
	realpathSync,
	renameSync,
	rmSync,
	statSync,
	writeFileSync,
} from "node:fs";
import { readFile, readlink, rm } from "node:fs/promises";
import { dirname, join } from "node:path";
import type { Readable } from "node:stream";
import type { Exec } from "../src/gh.ts";
import type {
	Log,
	StageExecutor,
	StageLaunch,
	StageLaunchInput,
	StageOutput,
	ReviewPreparation,
} from "../src/orchestrator.ts";
import {
	blocksReview,
	digestOf,
	isDigest,
	verdictPasses,
	type Digest,
	type Verdict,
} from "../src/run.ts";
import {
	parseSpecifyOutput,
	parseReviewOutput,
	reviewPrompt,
	revisionPrompt,
} from "../src/specify.ts";
import {
	type AcceptEffort,
	type ModelId,
	type ModelStage,
	STAGE_CLEANUP_RESERVE_MS,
} from "../src/workflow.ts";
import {
	checkoutWorkspace,
	checkoutBuildWorkspace,
	checkoutOf,
	controllerValidator,
	controllerCandidatePort,
	controllerBaseChecker,
	controllerDraftChecker,
	controllerDiagnosis,
	sweepValidation,
	fileRunFiles,
	readStoredAssessment,
	ghTarball,
	type TarballFetch,
} from "./controller.ts";
import { HERDR_AGENTS, PI_AGENT_DIR } from "./sandbox/assets/pi.ts";
import {
	AUDIT_CAP_BYTES,
	JOURNAL_FILE,
	journalCharge,
	requestSettlements,
	settlementReply,
} from "./sandbox/audit.ts";
import {
	countOf,
	arrayOf,
	fieldOf,
	objectOf,
	parseJson,
	textOf,
	type JsonValue,
} from "./sandbox/json.ts";
import {
	bundleMatchesSource,
	manifestDigest,
	PINNED_VERSIONS,
} from "./sandbox/manifest.ts";
import { readUsernsLimit, runPreflight } from "./sandbox/preflight.ts";
import { BUNDLE, bwrapArgv } from "./sandbox/bwrap.ts";
import type {
	CloseReason,
	ControlEvent,
	SummaryEvent,
} from "./sandbox/control.ts";
import {
	type GatewayHandle,
	startGatewayProcess,
} from "./sandbox/gateway-client.ts";
import { LineSplitter } from "./sandbox/lines.ts";
import type {
	BudgetCap,
	FailedExit,
	FallbackRecord,
	OutputRecord,
	PinnedVersions,
	RefusalSignal,
	SessionOutcome,
	Settlement,
	StageReceipt,
	StageResult,
	StageRunSettings,
	StageUsage,
	StderrRecord,
} from "./sandbox/result.ts";
import {
	stageResult,
	unknownEfficiency,
	parseEfficiency,
	requestEfficiency,
	aggregateEfficiency,
	type EfficiencyFacts,
	executionUsageOf,
	type ExecutionUsage,
} from "./sandbox/result.ts";
import {
	builtinTable,
	type RouteId,
	type RouteTable,
} from "./sandbox/routes.ts";
import { type PiProcess, parsePiRecord, sendCommand } from "./sandbox/rpc.ts";
import {
	DEFAULT_SCOPE_LIMITS,
	reconcileScopes,
	scopeArgv,
	scopeOwner,
	scopeUnit,
	spawnScoped,
	stopScopeArgv,
} from "./sandbox/scope.ts";
import { type SeccompArch, seccompProgram } from "./sandbox/seccomp.ts";
import {
	type ChildUsage,
	type AcceptCalls,
	childUsageOf,
	modelKey,
	SessionTracker,
	settledOutcome,
} from "./sandbox/settle.ts";

export type {
	StageReceipt,
	StageResult,
	StageRunSettings,
} from "./sandbox/result.ts";

/** Time kept back from `wall_ms` for cleanup. The hard deadline is `wall_ms` minus this. */
export const CLEANUP_RESERVE_MS = STAGE_CLEANUP_RESERVE_MS;

export const MODEL_REQUEST_CEILING = 2_000;

const ACCEPT_REQUEST_CEILING = 5;
export const DRAFT_MAX_RUNS = 2;
export const DRAFT_RESERVE_TOKENS = 35_000;
export const DRAFT_RESERVE_MS = 180_000;

type AcceptDiagnostic =
	| "accept_tool_limit"
	| "accept_request_limit"
	| "accept_length";

export const STDERR_CAP_BYTES = 64 * 1024;

const PROMPT_ID = "factory-prompt";

export const STAGE_SYSTEM_PROMPT =
	"You are one stage of a software factory, running in a sandbox. Follow the user message exactly, and use only the tools it allows.";

const OUTPUT_ID = "factory-output";

export const OUTPUT_MAX_BYTES = 256 * 1024;

const OUTPUT_WAIT_MS = 5_000;

const ABORT_WAIT_MS = 5_000;

const EXIT_WAIT_MS = 2_000;

export type DraftCheckContext = Readonly<{
	signal: AbortSignal;
	deadline: number;
	run: 1 | 2;
}>;

export type StageRunInput = {
	readonly runId: Digest;
	readonly stage: ModelStage;
	readonly attempt: number;
	readonly prompt: string;
	readonly source?: import("../src/specify.ts").SourceFacts;
	readonly draftCheck?: (
		text: string,
		context: DraftCheckContext,
	) => Promise<DraftFeedback | null>;
	readonly settings: StageRunSettings;
	readonly remainingRunTokens: number;
	readonly signal: AbortSignal;
	readonly progress: (usage: number) => void;
};

/** Every effect `runStage` needs. Tests pass fakes; `sandboxHost` is the real one. */
export interface StageHost {
	readonly cleanupReserveMs: number;
	readonly assetsDigest: string;
	readonly versions: PinnedVersions;
	now(): number;
	startGateway(table: RouteTable): Promise<GatewayHandle | null>;
	launchPi(model: ModelId, session: number): Promise<PiProcess | null>;
	stopSandbox(session: number): Promise<void>;
	readChildUsage(
		session: number,
		sessionFile: string,
	): Promise<
		| (ChildUsage & {
				readonly efficiency?: Pick<
					EfficiencyFacts,
					"assistantTurns" | "toolResultBytes"
				>;
		  })
		| null
	>;
	readUsage?(): JsonValue | undefined;
	writeUsage?(usage: ExecutionUsage): boolean;
	writeReceipt(receipt: StageReceipt): Promise<boolean>;
	writeOutput(text: string): Promise<boolean>;
	stderrLog(session: number): Promise<StderrRecord | null>;
	/**
	 * The attempt's synced request journal, `egress.requests.jsonl`, or
	 * `null` when it is missing or too large. A host without it records no
	 * family and cannot pass an Anthropic stage.
	 */
	readJournal?(): Promise<string | null>;
}

/** The model id as the request body names it, without its provider prefix. */
export function bareModel(model: ModelId): string {
	return model.slice(model.indexOf("/") + 1);
}

class Ledger {
	draftRuns = 0;
	revisionStart: number | null = null;
	readonly draftSkips: ("tokens" | "wall")[] = [];
	parent = 0;
	children = 0;
	gateway = 0;
	unreadChildren = 0;
	turns = 0;
	efficiency = { ...unknownEfficiency() };
	readonly byModel = new Map<string, number>();

	add(byModel: ReadonlyMap<string, number>): void {
		for (const [model, tokens] of byModel) {
			this.byModel.set(model, (this.byModel.get(model) ?? 0) + tokens);
		}
	}

	get total(): number {
		return Math.max(this.parent + this.children, this.gateway);
	}

	usage(gatewayRan: boolean): StageUsage {
		return {
			total: this.total,
			parent: this.parent,
			children: this.children,
			byModel: Object.fromEntries(this.byModel),
			gateway: gatewayRan ? this.gateway : null,
			unreadChildren: this.unreadChildren,
		};
	}
}

type StageRun = {
	readonly input: StageRunInput;
	readonly host: StageHost;
	readonly gateway: GatewayHandle;
	readonly ledger: Ledger;
	readonly deadline: number;
	readonly checkpoint: () => boolean;
	readonly cleanup: CleanupWindow;
	readonly requestBackstop: boolean;
	readonly acceptCalls: AcceptCalls | null;
	gateReason: CloseReason | null;
	alert: FailedExit | null;
	listener: ((event: ControlEvent) => void) | null;
};

type SessionReport = {
	readonly outcome: SessionOutcome;
	readonly refusal: RefusalSignal | null;
	readonly settlement: Settlement;
	readonly observed: string | null;
	readonly text: string | null;
	readonly diagnostic?: AcceptDiagnostic;
};

function capFor(stage: StageRun): BudgetCap | null {
	const { maxTokens } = stage.input.settings;
	const total = stage.ledger.total;

	if (maxTokens !== null && total >= maxTokens) return "tokens";

	if (total >= stage.input.remainingRunTokens) return "run_tokens";

	if (stage.gateReason === "ceiling") {
		return maxTokens !== null && maxTokens <= stage.input.remainingRunTokens
			? "tokens"
			: "run_tokens";
	}

	return null;
}

const CAP_REASON: Record<BudgetCap, CloseReason> = {
	turns: "turns",
	tokens: "tokens",
	run_tokens: "run_tokens",
	wall: "wall",
};

async function closeGate(stage: StageRun, reason: CloseReason): Promise<void> {
	if (stage.gateReason !== null) return;

	stage.gateReason = reason;
	await stage.gateway.closeGate(reason);
}

function waitFor(promise: Promise<unknown>, ms: number): Promise<boolean> {
	return new Promise((done) => {
		const timer = setTimeout(() => done(false), Math.max(0, ms));

		promise.then(
			() => {
				clearTimeout(timer);
				done(true);
			},
			() => {
				clearTimeout(timer);
				done(true);
			},
		);
	});
}

/** A cap the usage went past. A session that settled on its own is checked with this. */
function overCap(stage: StageRun): BudgetCap | null {
	const { maxTokens } = stage.input.settings;
	const total = stage.ledger.total;

	if (maxTokens !== null && total > maxTokens) return "tokens";

	return total > stage.input.remainingRunTokens ? "run_tokens" : null;
}

/**
 * The stage's one cleanup window. It opens at the first cleanup wait, or at
 * the abort if that comes first, and ends one cleanup reserve later, cut
 * short by the stage's wall end. Session cleanup, gateway shutdown and
 * receipt preparation all wait inside it, so cleanup ends within the
 * reserve of an abort. Only a fallback session, which starts after the
 * primary's cleanup and before any abort, opens it again.
 */
class CleanupWindow {
	readonly #host: StageHost;
	readonly #wallEnd: number;
	#until: number | null = null;
	#aborted = false;

	constructor(host: StageHost, wallEnd: number, signal: AbortSignal) {
		this.#host = host;
		this.#wallEnd = wallEnd;

		const onAbort = () => {
			this.#aborted = true;
			this.#open();
		};

		if (signal.aborted) onAbort();
		else signal.addEventListener("abort", onAbort, { once: true });
	}

	#open(): number {
		if (this.#until === null) {
			const ms = Math.max(
				0,
				Math.min(this.#wallEnd - this.#host.now(), this.#host.cleanupReserveMs),
			);

			this.#until = Date.now() + ms;
		}

		return this.#until;
	}

	/** Lets a fallback session's cleanup have its own reserve, unless the stage was aborted. */
	reopen(): void {
		if (!this.#aborted) this.#until = null;
	}

	/** Waits for `promise` until the window ends or `capMs` passes; true when it settled. */
	wait(
		promise: Promise<unknown>,
		capMs = Number.POSITIVE_INFINITY,
	): Promise<boolean> {
		const until = this.#open();

		return waitFor(promise, Math.min(capMs, until - Date.now()));
	}
}

const NOT_STARTED: Settlement = { event: "none", aborted: null };

function plainReport(outcome: SessionOutcome): SessionReport {
	return {
		outcome,
		refusal: null,
		settlement: NOT_STARTED,
		observed: null,
		text: null,
	};
}

const CRASHED: SessionOutcome = { kind: "failed", exit: "crashed" };

/**
 * One Pi session in the sandbox: send the prompt, read records, answer
 * dialogs, count turns and tokens, and end on settlement, a cap, the
 * deadline, an abort, malformed output or a crash. Every ending other than
 * settlement closes the gateway gate before Pi is aborted.
 */
async function runSession(
	stage: StageRun,
	model: ModelId,
	session: number,
): Promise<SessionReport> {
	const { host, input, ledger } = stage;

	if (host.now() >= stage.deadline) {
		return plainReport({ kind: "budget_exhausted", cap: "wall" });
	}

	const pi = await host.launchPi(model, session);

	if (pi === null) {
		await stage.cleanup.wait(host.stopSandbox(session));

		return plainReport(CRASHED);
	}

	let pipeBroken = false;

	// A write to a Pi that closed its command pipe fails asynchronously.
	// Without a listener that error would end the whole controller.
	pi.stdin.on("error", () => {
		pipeBroken = true;
		brokenPipe();
	});

	let brokenPipe = () => {};

	const tracker = new SessionTracker(
		PROMPT_ID,
		input.settings.budget.maxTurns,
		ledger.turns,
		stage.acceptCalls,
	);

	let diagnostic: AcceptDiagnostic | undefined;
	const reads: Promise<void>[] = [];
	let pendingReads = 0;
	let readFailed = false;
	let readsClosed = false;
	let abortSent = false;
	let settledAfterAbort: (() => void) | null = null;
	let textReply: ((text: string | null) => void) | null = null;
	let recheck = () => {};
	let finalText: string | null = null;
	let checkingDraft = false;
	let readingDraft = false;
	const draftAbort = new AbortController();
	let pendingDraft: Promise<DraftFeedback | null> | null = null;

	const readChild = (sessionFile: string | null): Promise<void> => {
		pendingReads += 1;

		const read =
			sessionFile === null
				? Promise.resolve(null)
				: host.readChildUsage(session, sessionFile);

		return read.then(
			(usage) => {
				if (readsClosed) return;

				pendingReads -= 1;

				for (const key of ["assistantTurns", "toolResultBytes"] as const) {
					const value = usage?.efficiency?.[key];

					ledger.efficiency[key] =
						value == null || ledger.efficiency[key] === null
							? null
							: ledger.efficiency[key] + value;
				}

				if (usage === null) {
					ledger.unreadChildren += 1;

					return;
				}

				ledger.children += usage.total;
				ledger.add(usage.byModel);

				if (!stage.checkpoint()) stage.alert = "crashed";
				recheck();
			},
			() => {
				if (readsClosed) return;

				pendingReads -= 1;
				ledger.unreadChildren += 1;
				ledger.efficiency.assistantTurns = null;
				ledger.efficiency.toolResultBytes = null;
				readFailed = true;
			},
		);
	};

	const report = await new Promise<SessionOutcome | "settled">((finish) => {
		let finished = false;

		const end = (outcome: SessionOutcome | "settled") => {
			if (finished) return;

			finished = true;
			clearTimeout(deadline);
			input.signal.removeEventListener("abort", onAbort);
			stage.listener = null;
			draftAbort.abort();
			finish(outcome);
		};

		const capped = (cap: BudgetCap) => end({ kind: "budget_exhausted", cap });

		const checkTokens = () => {
			const cap = capFor(stage);

			if (cap !== null) capped(cap);
		};

		const acceptFailure = (code: AcceptDiagnostic) => {
			checkTokens();

			if (host.now() >= stage.deadline) capped("wall");

			if (finished) return;

			diagnostic = code;
			end({ kind: "failed", exit: "error" });
		};

		recheck = checkTokens;

		const onAbort = () => end({ kind: "failed", exit: "aborted" });

		brokenPipe = () => end(CRASHED);

		const remaining = stage.deadline - host.now();
		const deadline = setTimeout(() => capped("wall"), Math.max(0, remaining));
		const splitter = new LineSplitter(64 * 1024 * 1024);

		if (remaining <= 0) capped("wall");

		if (input.signal.aborted) onAbort();

		input.signal.addEventListener("abort", onAbort);
		stage.listener = (event) => {
			if (stage.alert !== null) end({ kind: "failed", exit: stage.alert });
			else if (
				stage.requestBackstop &&
				stage.gateReason === "requests" &&
				event.event === "usage" &&
				event.decision === "deny" &&
				event.reason === "budget-closed"
			)
				acceptFailure("accept_request_limit");
			else if (event.event === "gate_closed" || event.event === "usage")
				checkTokens();
		};

		const settleDraft = async () => {
			if (readingDraft || checkingDraft || finished) return;
			const last = tracker.lastAssistant;

			if (
				input.stage !== "accept" ||
				input.draftCheck === undefined ||
				ledger.draftRuns >= DRAFT_MAX_RUNS ||
				settledOutcome(last).outcome.kind !== "passed"
			) {
				end("settled");

				return;
			}

			const tokens =
				Math.min(
					input.settings.maxTokens ?? Infinity,
					input.remainingRunTokens,
				) - ledger.total;

			const wall = stage.deadline - host.now();

			if (tokens < DRAFT_RESERVE_TOKENS || wall < DRAFT_RESERVE_MS) {
				ledger.draftSkips.push(
					tokens < DRAFT_RESERVE_TOKENS ? "tokens" : "wall",
				);
				end("settled");

				return;
			}

			readingDraft = true;
			let draft: string | null = null;

			const reply = new Promise<void>((done) => {
				textReply = (value) => {
					draft = value;
					done();
				};
			});

			sendCommand(pi, { id: OUTPUT_ID, type: "get_last_assistant_text" });
			await waitFor(reply, Math.min(OUTPUT_WAIT_MS, wall));
			textReply = null;
			readingDraft = false;

			if (finished) return;

			if (draft === null) {
				end("settled");

				return;
			}

			finalText = draft;
			checkingDraft = true;
			const run = ledger.draftRuns === 0 ? 1 : 2;
			let feedback: DraftFeedback | null;

			try {
				pendingDraft = input.draftCheck(draft, {
					signal: draftAbort.signal,
					deadline: Math.min(
						host.now() + 60000,
						stage.deadline - DRAFT_RESERVE_MS,
					),
					run,
				});
				feedback = await pendingDraft;
			} catch {
				feedback = null;
			}

			checkingDraft = false;

			if (finished) return;

			if (feedback === null) {
				end("settled");

				return;
			}

			ledger.draftRuns++;

			if (!draftNeedsRevision(feedback)) {
				end("settled");

				return;
			}

			if (ledger.revisionStart === null) ledger.revisionStart = ledger.total;
			finalText = null;
			const id = `factory-draft-${run}`;
			tracker.expect(id);
			sendCommand(pi, {
				id,
				type: "prompt",
				message: draftFeedbackPrompt(
					{ ...feedback, run },
					randomBytes(16).toString("hex"),
				),
			});
		};

		pi.stdout.on("data", (chunk: Buffer) => {
			const lines = splitter.push(chunk);

			if (lines === null) {
				end({ kind: "failed", exit: "malformed" });

				return;
			}

			for (const line of lines) {
				const record = parsePiRecord(line);
				const signal = tracker.apply(record);

				ledger.turns = tracker.turns;

				if (record.type === "agent_settled" && abortSent) settledAfterAbort?.();

				if (record.type === "response" && record.id === OUTPUT_ID) {
					textReply?.(record.success ? record.text : null);
				}

				if (record.type === "other" && record.textBytes !== undefined) {
					ledger.efficiency.toolResultBytes =
						record.textBytes === null ||
						ledger.efficiency.toolResultBytes === null
							? null
							: ledger.efficiency.toolResultBytes + record.textBytes;
				}

				if (record.type === "assistant_end") {
					if (ledger.efficiency.assistantTurns !== null)
						ledger.efficiency.assistantTurns++;
					const tokens = record.message.usage?.totalTokens ?? 0;

					ledger.parent += tokens;
					ledger.add(
						new Map([
							[modelKey(record.message.provider, record.message.model), tokens],
						]),
					);
				}

				if (signal.kind === "child") reads.push(readChild(signal.sessionFile));

				if (!stage.checkpoint()) end(CRASHED);
				else input.progress(ledger.total);

				if (finished) continue;

				if (record.type === "assistant_end") {
					checkTokens();

					if (
						input.stage === "accept" &&
						record.message.stopReason === "length"
					)
						acceptFailure("accept_length");
				}

				if (signal.kind === "failed") {
					if (signal.diagnostic !== undefined) acceptFailure(signal.diagnostic);
					else end(signal);
				} else if (signal.kind === "cap") capped(signal.cap);
				else if (signal.kind === "settled") void settleDraft();
				else if (signal.kind === "answer_ui") {
					sendCommand(pi, {
						type: "extension_ui_response",
						id: signal.id,
						cancelled: true,
					});
				}
			}
		});
		pi.stdout.on("error", () => end(CRASHED));
		pi.exited.then(() => end(CRASHED));

		if (pipeBroken) end(CRASHED);

		if (!finished) {
			sendCommand(pi, { id: PROMPT_ID, type: "prompt", message: input.prompt });
		}
	});

	const bounded = (promise: Promise<unknown>, capMs?: number) =>
		stage.cleanup.wait(promise, capMs);

	if (report !== "settled") {
		const reason =
			report.kind === "budget_exhausted" ? CAP_REASON[report.cap] : "abort";

		await bounded(closeGate(stage, reason));

		const settled = new Promise<void>((done) => {
			settledAfterAbort = done;
		});

		abortSent = true;
		sendCommand(pi, { id: "factory-abort", type: "abort" });
		await bounded(settled, ABORT_WAIT_MS);
		await bounded(stage.gateway.drainAbort());
	}

	if (pendingDraft !== null) await bounded(pendingDraft);

	let text: string | null = finalText;

	if (report === "settled" && text === null) {
		// Pi can exit before it answers a command sent after stdin ends, so the
		// reply is awaited first.
		const reply = new Promise<void>((done) => {
			textReply = (value) => {
				text = value;
				done();
			};
		});

		sendCommand(pi, { id: OUTPUT_ID, type: "get_last_assistant_text" });
		await bounded(reply, OUTPUT_WAIT_MS);
		textReply = null;
	}

	pi.stdin.end();

	if (!(await bounded(pi.exited, EXIT_WAIT_MS))) pi.kill();

	await bounded(host.stopSandbox(session));
	await bounded(Promise.all(reads));

	readsClosed = true;

	if (pendingReads > 0) {
		ledger.unreadChildren += pendingReads;
		ledger.efficiency.assistantTurns = null;
		ledger.efficiency.toolResultBytes = null;
		readFailed = true;
	}

	const last = tracker.lastAssistant;
	const observed = last === null ? null : modelKey(last.provider, last.model);

	const settlement: Settlement =
		tracker.aborted === null
			? NOT_STARTED
			: { event: "agent_settled", aborted: tracker.aborted };

	if (report !== "settled") {
		return {
			outcome: report,
			refusal: null,
			settlement,
			observed,
			text: null,
			diagnostic,
		};
	}

	const cap =
		(last?.stopReason === "error" && stage.gateReason !== null
			? capFor(stage)
			: null) ?? overCap(stage);

	if (
		cap !== null ||
		(last?.stopReason === "error" &&
			stage.gateReason === "requests" &&
			!stage.requestBackstop)
	) {
		return {
			outcome: { kind: "budget_exhausted", cap: cap ?? "turns" },
			refusal: null,
			settlement,
			observed,
			text: null,
		};
	}

	if (
		last?.stopReason === "error" &&
		stage.gateReason === "requests" &&
		stage.requestBackstop
	)
		return {
			outcome: { kind: "failed", exit: "error" },
			refusal: null,
			settlement,
			observed,
			text: null,
			diagnostic: "accept_request_limit",
		};

	if (readFailed)
		return {
			outcome: CRASHED,
			refusal: null,
			settlement,
			observed,
			text: null,
		};

	const settled = settledOutcome(last);

	return {
		...settled,
		settlement,
		observed,
		text: settled.outcome.kind === "passed" ? text : null,
	};
}

/** A session whose effects threw ends crashed, after a bounded stop of its sandbox. */
async function guardedSession(
	stage: StageRun,
	model: ModelId,
	session: number,
): Promise<SessionReport> {
	try {
		return await runSession(stage, model, session);
	} catch {
		await stage.cleanup.wait(
			Promise.resolve().then(() => stage.host.stopSandbox(session)),
		);

		return plainReport(CRASHED);
	}
}

/** A fallback runs only after a refused or unavailable primary, so when one ran it answered. */
function finalOutcome(
	primary: SessionReport,
	fallback: FallbackRecord | null,
): SessionOutcome {
	return fallback === null ? primary.outcome : fallback.outcome;
}

const UNUSABLE: SessionOutcome = { kind: "failed", exit: "error" };

/**
 * True when the journal shows a `model-anthropic` reply the host cannot
 * meter: a settled result with null tokens that the provider did not reject
 * at the headers, or, once the gateway has stopped (`settled`), a dispatch
 * with no result. Pi may already have read the streamed bytes, so the
 * attempt fails rather than pass on unmetered Anthropic usage.
 *
 * A result with `reason: "upstream_unreachable"` is not a reply. The gateway
 * marks only its own answer, sent before any upstream response headers
 * arrived, so nothing reached Pi and the route was unavailable. The status
 * code cannot tell this apart from an upstream 502 or 504 whose stream was
 * cut, so an unmarked error, including one from an older journal, stays
 * vetoed.
 */
function anthropicUnmetered(journal: string, settled: boolean): boolean {
	for (const request of requestSettlements(journal, {
		route: "model-anthropic",
		stopped: settled,
	}).requests) {
		if (request.req === null) continue;

		if (request.kind === "Uncertain" && request.result === null) return true;

		for (const result of [settlementReply(request), ...request.laterResults]) {
			if (
				result === null ||
				result.kind === "Unreachable" ||
				result.kind === "ProviderRejected"
			)
				continue;

			if (result.usage.kind !== "metered") return true;
		}
	}

	return false;
}

/**
 * True when the journal holds at least one metered `model-anthropic` result
 * that the provider did not reject: the gateway's proof that an Anthropic
 * model answered.
 */
function anthropicMetered(journal: string): boolean {
	return requestSettlements(journal, {
		route: "model-anthropic",
	}).requests.some((request) =>
		[settlementReply(request), ...request.laterResults].some(
			(result) =>
				result !== null &&
				result.kind !== "ProviderRejected" &&
				result.usage.kind === "metered",
		),
	);
}

/** The route a model id is served on in a stage table. */
function modelRouteOf(model: ModelId): "model-anthropic" | "model-openai" {
	return model.startsWith("anthropic/") ? "model-anthropic" : "model-openai";
}

async function keepOutput(
	host: StageHost,
	text: string,
	cleanup: CleanupWindow,
): Promise<OutputRecord | null> {
	const full = Buffer.from(text, "utf8");
	const kept = full.subarray(0, OUTPUT_MAX_BYTES);
	const write = host.writeOutput(kept.toString("utf8")).catch(() => false);

	if (!(await cleanup.wait(write)) || !(await write)) return null;

	return { file: "output.txt", bytes: full.length, kept: kept.length };
}

function routeId(
	text: "model-openai" | "model-xai" | "model-anthropic",
	table: RouteTable,
): RouteId | null {
	return table.routes.find((route) => route.id === text)?.id ?? null;
}

/**
 * Runs one stage attempt in the sandbox and returns its result with a
 * host-side receipt. In order:
 *
 * 1. An Anthropic reply the gateway could not meter fails the attempt, even
 *    when Pi passed, before any receipt or output is kept, and nothing
 *    substitutes for it.
 * 2. On a structured refusal with a fallback configured, it opens the
 *    fallback route, closes the primary, and runs one fresh session on the
 *    fallback model.
 * 3. On an Anthropic primary that failed with its route unavailable (it
 *    forwarded nothing and was denied at least once) and an `openai/`
 *    fallback configured, it closes `model-anthropic`, opens `model-openai`
 *    and runs the fallback the same way.
 *
 * The receipt's `family` follows the session that answered.
 */
export async function runStage(
	input: StageRunInput,
	host: StageHost,
): Promise<StageResult> {
	const saved = host.readUsage === undefined ? null : host.readUsage();
	const restored = saved === null ? null : executionUsageOf(saved, input);
	const started = restored?.startedAt ?? host.now();
	const ledger = new Ledger();
	const { maxTokens, budget } = input.settings;
	const wallEnd = restored?.deadline ?? started + budget.wallMs;
	ledger.efficiency =
		restored === null
			? {
					...unknownEfficiency(),
					assistantTurns: 0,
					toolResultBytes: 0,
					initialPromptBytes: Buffer.byteLength(input.prompt),
					initialSourceBytes: input.source?.bytes ?? null,
					excerptOmissions: input.source?.omissions ?? null,
					sourceCapHits:
						input.source === undefined ? null : Number(input.source.capHit),
					guardStops: 0,
				}
			: { ...(restored.efficiency ?? unknownEfficiency()) };

	if (restored !== null) {
		ledger.parent = restored.usage.parent;
		ledger.children = restored.usage.children;
		ledger.gateway = Math.max(
			restored.usage.gateway ?? 0,
			restored.usage.total,
		);
		ledger.turns = restored.turns;
		ledger.unreadChildren = restored.usage.unreadChildren;
		ledger.add(new Map(Object.entries(restored.usage.byModel)));
	}

	const checkpoint = () =>
		host.writeUsage?.({
			version: 1,
			runId: input.runId,
			stage: input.stage,
			attempt: input.attempt,
			startedAt: started,
			deadline: wallEnd,
			turns: ledger.turns,
			usage: ledger.usage(true),
			efficiency: ledger.efficiency,
		}) ?? true;

	const tokenCap = Math.min(
		maxTokens ?? Number.MAX_SAFE_INTEGER,
		input.remainingRunTokens,
	);

	const sessions: number[] = [];
	let gatewayRan = false;

	const cleanup = new CleanupWindow(host, wallEnd, input.signal);

	const anthropic = input.settings.model.startsWith("anthropic/");
	let diagnostic: AcceptDiagnostic | undefined;

	const requestBackstop =
		input.stage === "accept" &&
		budget.maxTurns - ledger.turns > ACCEPT_REQUEST_CEILING;

	const primaryRoute = modelRouteOf(input.settings.model);

	const receipt = async (
		primary: SessionReport,
		fallback: FallbackRecord | null,
		egress: StageReceipt["egress"],
		text: string | null = null,
		evidence?: { readonly journal: string | null; readonly vetoed: boolean },
	): Promise<StageResult> => {
		const journal =
			evidence === undefined
				? ((await host.readJournal?.().catch(() => null)) ?? null)
				: evidence.journal;

		const outcome = evidence?.vetoed
			? UNUSABLE
			: finalOutcome(primary, fallback);

		const family: FamilyInput | undefined =
			host.readJournal === undefined
				? undefined
				: familyFromJournal({
						journal,
						requested: fallback?.requested ?? input.settings.model,
						superseded: fallback === null ? null : primaryRoute,
					});

		const output =
			outcome.kind === "passed" && text !== null
				? await keepOutput(host, text, cleanup)
				: null;

		const stderr = await Promise.all(
			sessions.map(async (session) => {
				const log = host.stderrLog(session).catch(() => null);

				return (await cleanup.wait(log)) ? log : null;
			}),
		);

		const record: StageReceipt & { diagnostic?: AcceptDiagnostic } = withFamily(
			{
				version: 1,
				runId: input.runId,
				stage: input.stage,
				attempt: input.attempt,
				outcome,
				settlement: fallback?.settlement ?? primary.settlement,
				models: { requested: input.settings.model, observed: primary.observed },
				fallback,
				refusal: primary.refusal,
				wallMs: Math.max(0, host.now() - started),
				turns: ledger.turns,
				usage: ledger.usage(gatewayRan),
				egress,
				stderr: stderr.filter((entry) => entry !== null),
				output,
				assetsDigest: host.assetsDigest,
				versions: host.versions,
				pricing: "unavailable",
				efficiency: {
					...ledger.efficiency,
					...requestEfficiency(journal),
					guardStops:
						ledger.efficiency.guardStops === null
							? null
							: ledger.efficiency.guardStops + Number(diagnostic !== undefined),
				},
				guardStop: diagnostic ?? null,
			},
			family,
		);

		const complete: StageReceipt & { diagnostic?: AcceptDiagnostic } =
			input.stage === "accept"
				? {
						...record,
						draftRuns: ledger.draftRuns,
						draftRevisionTokens:
							ledger.revisionStart === null
								? 0
								: Math.max(0, ledger.total - ledger.revisionStart),
						draftSkips: ledger.draftSkips,
					}
				: record;

		if (diagnostic !== undefined) complete.diagnostic = diagnostic;

		const written = await host.writeReceipt(complete).catch(() => false);

		return stageResult(written ? complete : { ...complete, outcome: CRASHED });
	};

	if ((saved !== null && restored === null) || !checkpoint())
		return receipt(plainReport(CRASHED), null, null);

	const early: BudgetCap | null =
		maxTokens !== null && ledger.total >= maxTokens
			? "tokens"
			: ledger.total >= input.remainingRunTokens
				? "run_tokens"
				: ledger.turns >= budget.maxTurns
					? "turns"
					: wallEnd - host.now() <= host.cleanupReserveMs
						? "wall"
						: null;

	if (early !== null) {
		return receipt(
			plainReport({ kind: "budget_exhausted", cap: early }),
			null,
			null,
		);
	}

	let table: RouteTable;

	try {
		table = builtinTable({
			stage: input.stage,
			runId: input.runId,
			attempt: input.attempt,
			provider: anthropic ? "anthropic" : "openai",
			model: bareModel(input.settings.model),
			fallback:
				input.settings.fallback === null
					? null
					: input.settings.fallback.startsWith("openai/")
						? input.settings.fallback
						: bareModel(input.settings.fallback),
			modelTokens: tokenCap - ledger.total,
			modelRequests: Math.min(
				input.stage === "accept"
					? ACCEPT_REQUEST_CEILING
					: MODEL_REQUEST_CEILING,
				budget.maxTurns - ledger.turns,
			),
		});
	} catch {
		return receipt(plainReport(CRASHED), null, null);
	}

	const routeCounts = new Map<string, { forwarded: number; denied: number }>();

	const gateway = await host.startGateway(table).catch(() => null);

	if (gateway === null) return receipt(plainReport(CRASHED), null, null);

	gatewayRan = true;

	const stage: StageRun = {
		input,
		host,
		gateway,
		ledger,
		deadline: wallEnd - host.cleanupReserveMs,
		checkpoint,
		cleanup,
		requestBackstop,
		acceptCalls:
			input.stage === "accept" ? { ids: new Set(), args: new Set() } : null,
		gateReason: null,
		alert: null,
		listener: null,
	};

	gateway.subscribe((event) => {
		if (event.event === "usage") {
			ledger.gateway += (event.inputTokens ?? 0) + (event.outputTokens ?? 0);

			if (event.route !== null) {
				const counts = routeCounts.get(event.route) ?? {
					forwarded: 0,
					denied: 0,
				};

				if (event.decision === "forward") counts.forwarded += 1;
				else counts.denied += 1;
				routeCounts.set(event.route, counts);
			}

			if (event.reason === "secret-in-request") stage.alert = "error";
		}

		if (event.event === "gate_closed" && stage.gateReason === null) {
			stage.gateReason = event.reason;
		}

		if (!checkpoint()) {
			stage.alert = "crashed";
			void closeGate(stage, "abort");
		} else input.progress(ledger.total);
		stage.listener?.(event);
	});
	gateway.exited.then(() => {
		if (stage.alert === null) stage.alert = "crashed";

		stage.listener?.({ event: "drained" });
	});

	sessions.push(0);

	const primary = await guardedSession(stage, input.settings.model, 0);
	diagnostic = primary.diagnostic;
	let fallback: FallbackRecord | null = null;
	let text = primary.text;

	const readJournal = async (): Promise<string | null> => {
		if (host.readJournal === undefined) return null;

		const read = host.readJournal().catch(() => null);

		return (await cleanup.wait(read)) ? read : null;
	};

	let vetoed =
		anthropic && anthropicUnmetered((await readJournal()) ?? "", false);

	const counts = routeCounts.get(primaryRoute);

	const unavailable =
		anthropic &&
		primary.outcome.kind === "failed" &&
		(counts?.forwarded ?? 0) === 0 &&
		(counts?.denied ?? 0) > 0;

	if (
		!vetoed &&
		(primary.outcome.kind === "refused" || unavailable) &&
		input.settings.fallback !== null &&
		stage.gateReason === null
	) {
		const openai = routeId("model-openai", table);
		const xai = routeId("model-xai", table);
		const closed = routeId("model-anthropic", table);

		const switched = anthropic
			? openai !== null &&
				closed !== null &&
				(await gateway.setRoute(closed, false).catch(() => false)) &&
				(await gateway.setRoute(openai, true).catch(() => false))
			: input.settings.fallback.startsWith("openai/") ||
				(openai !== null &&
					xai !== null &&
					(await gateway.setRoute(openai, false).catch(() => false)) &&
					(await gateway.setRoute(xai, true).catch(() => false)));

		if (switched) sessions.push(1);

		cleanup.reopen();

		const second = switched
			? await guardedSession(stage, input.settings.fallback, 1)
			: plainReport(CRASHED);

		text = second.text;
		diagnostic = second.diagnostic;
		fallback = {
			requested: input.settings.fallback,
			observed: second.observed,
			outcome: second.outcome,
			settlement: second.settlement,
			refusal: second.refusal,
		};
	}

	const shutdown: Promise<SummaryEvent | null> = gateway
		.shutdown()
		.catch(() => null);

	const closed = await cleanup.wait(shutdown);

	if (!closed) gateway.kill();

	const summary = closed ? await shutdown : null;
	const journal = await readJournal();

	// The final veto, before the receipt or output is kept: an unmetered
	// Anthropic reply, or a passing Anthropic answer whose journal, missing
	// or empty, holds no metered `model-anthropic` result.
	vetoed ||=
		anthropic &&
		(anthropicUnmetered(journal ?? "", true) ||
			(fallback === null &&
				primary.outcome.kind === "passed" &&
				!anthropicMetered(journal ?? "")));

	return receipt(primary, fallback, summary?.routes ?? null, text, {
		journal,
		vetoed,
	});
}

export type SandboxHostConfig = {
	readonly stateDir: string;
	readonly bundleDir: string;
	readonly workspace: string;
	readonly stageDir?: string;
	readonly acceptEffort?: AcceptEffort;
	readonly runId: Digest;
	readonly stage: ModelStage;
	readonly attempt: number;
	readonly tools: readonly string[];
	readonly arch: SeccompArch;
	readonly xdgRuntimeDir: string;
	readonly assetsDigest: string;
	readonly versions: PinnedVersions;
	readonly exec: Exec;
	readonly blockUnixSockets?: boolean;
	readonly now?: () => number;
	readonly launch?: typeof launchSandbox;
};

function freshDir(base: string): string {
	for (let n = 1; ; n++) {
		const path = n === 1 ? base : `${base}.${n}`;

		try {
			mkdirSync(path, { mode: 0o700 });

			return path;
		} catch (error) {
			if (
				!(error instanceof Error && "code" in error && error.code === "EEXIST")
			)
				throw error;
		}
	}
}

export function piCommand(
	model: ModelId,
	children = false,
	effort?: AcceptEffort,
): string[] {
	return [
		`${BUNDLE.bin}/pi`,
		...(children ? ["-e", HERDR_AGENTS] : []),
		"--mode",
		"rpc",
		"--no-skills",
		"--system-prompt",
		STAGE_SYSTEM_PROMPT,
		"--session-dir",
		`${PI_AGENT_DIR}/sessions`,
		"--model",
		model,
		...(effort === undefined ? [] : ["--thinking", effort]),
	];
}

/**
 * Copies the bundle's agent template into a fresh private dir Pi can write:
 * `auth.json`, the settings lock and sessions live there. The bundle
 * is installed read-only, so its modes are not kept. Only regular files are
 * copied.
 */
export function agentDirFrom(template: string, dest: string): void {
	mkdirSync(dest, { mode: 0o700 });

	for (const name of readdirSync(template)) {
		if (lstatSync(join(template, name)).isFile()) {
			writeFileSync(join(dest, name), readFileSync(join(template, name)), {
				mode: 0o600,
				flag: "wx",
			});
		}
	}

	mkdirSync(join(dest, "sessions"), { mode: 0o700 });
}

/** Where the workspace's `.git` stands. A symlink or other file is unsafe to bind. */
export function gitState(workspace: string): "dir" | "absent" | "unsafe" {
	try {
		return lstatSync(join(workspace, ".git")).isDirectory() ? "dir" : "unsafe";
	} catch (error) {
		return error instanceof Error && "code" in error && error.code === "ENOENT"
			? "absent"
			: "unsafe";
	}
}

export function launchSandbox(
	config: Pick<
		SandboxHostConfig,
		| "stateDir"
		| "bundleDir"
		| "workspace"
		| "runId"
		| "stage"
		| "attempt"
		| "tools"
		| "arch"
		| "xdgRuntimeDir"
		| "blockUnixSockets"
	> & {
		readonly agentDir: string;
		readonly socketPath: string;
		readonly command: readonly string[];
	},
) {
	const git = gitState(config.workspace);

	if (git === "unsafe") return null;
	agentDirFrom(join(config.bundleDir, "pi-agent"), config.agentDir);

	const unit = scopeUnit(
		scopeOwner(config.stateDir),
		config.runId,
		config.stage,
		config.attempt,
		randomBytes(4).toString("hex"),
	);

	const argv = scopeArgv(
		unit,
		DEFAULT_SCOPE_LIMITS,
		bwrapArgv({
			bundleDir: config.bundleDir,
			workspaceDir: config.workspace,
			workspaceHasGit: git === "dir",
			agentDir: config.agentDir,
			socketPath: config.socketPath,
			seccompFd: 10,
			tools: config.tools,
			command: config.command,
		}),
	);

	const child = spawnScoped({
		argv,
		seccomp: seccompProgram(config.arch, {
			blockUnixSockets: config.blockUnixSockets ?? false,
		}),
		seccompFd: 10,
		xdgRuntimeDir: config.xdgRuntimeDir,
	});

	return { unit, child };
}

const MAX_SESSION_BYTES = 64 * 1024 * 1024;

/**
 * Maps a child's in-sandbox session path to the host, refusing anything
 * outside `<agentDir>/sessions/` after symlinks resolve. The sandbox can
 * write that directory, so its paths are untrusted.
 */
export function hostSessionPath(
	agentDir: string,
	sandboxPath: string,
): string | null {
	const prefix = `${PI_AGENT_DIR}/sessions/`;

	if (
		!sandboxPath.startsWith(prefix) ||
		sandboxPath.split("/").includes("..")
	) {
		return null;
	}

	try {
		const root = realpathSync(join(agentDir, "sessions"));

		const real = realpathSync(
			join(agentDir, sandboxPath.slice(PI_AGENT_DIR.length + 1)),
		);

		return real.startsWith(`${root}/`) && statSync(real).isFile() ? real : null;
	} catch {
		return null;
	}
}

/**
 * Publishes `text` at `path` whole or not at all: it is written to a fresh
 * 0600 temp file beside it, fsynced, then renamed into place, and the
 * directory is fsynced. An existing `path` is never replaced. Any failure
 * removes the temp file and returns `false`.
 */
export function publishFile(
	path: string,
	text: string,
	write: (fd: number, text: string) => void = (fd, data) =>
		writeFileSync(fd, data),
): boolean {
	if (existsSync(path)) return false;

	const temp = `${path}.tmp-${randomBytes(4).toString("hex")}`;
	let fd: number | null = null;

	try {
		fd = openSync(temp, "wx", 0o600);
		write(fd, text);
		fsyncSync(fd);
		closeSync(fd);
		fd = null;
		renameSync(temp, path);
	} catch {
		try {
			if (fd !== null) closeSync(fd);

			rmSync(temp, { force: true });
		} catch {
			// Best effort: the publish already failed and returns false below.
		}

		return false;
	}

	try {
		const dir = openSync(dirname(path), "r");

		try {
			fsyncSync(dir);
		} finally {
			closeSync(dir);
		}
	} catch {
		// Best effort: the file is renamed into place; a directory fsync is extra durability.
	}

	return true;
}

/**
 * Keeps the last `STDERR_CAP_BYTES` a sandbox writes to stderr. The returned
 * function waits up to `waitMs` for the stream to close, writes the kept
 * bytes to `path` with mode 0600, and resolves to the total bytes written,
 * or `null` when the file could not be written. The text is untrusted, so
 * it goes only to that file.
 */
export function captureStderr(
	stream: Readable,
	path: string,
): (waitMs: number) => Promise<number | null> {
	let tail = Buffer.alloc(0);
	let bytes = 0;

	const closed = new Promise<void>((done) => {
		stream.on("close", () => done());
		stream.on("end", () => done());
		stream.on("error", () => done());
	});

	stream.on("data", (chunk: Buffer) => {
		bytes += chunk.length;
		tail = Buffer.concat([tail, chunk]);

		if (tail.length > STDERR_CAP_BYTES) {
			tail = Buffer.from(tail.subarray(tail.length - STDERR_CAP_BYTES));
		}
	});

	return async (waitMs) => {
		await waitFor(closed, waitMs);

		try {
			writeFileSync(path, tail, { mode: 0o600, flag: "wx" });

			return bytes;
		} catch {
			return null;
		}
	};
}

/**
 * The real effects for one stage attempt: a fresh stage directory under
 * the state dir, one gateway process, and one scoped bwrap sandbox per Pi
 * session.
 */
export function sandboxHost(config: SandboxHostConfig): StageHost {
	const units = new Map<number, string>();
	const agentDirs = new Map<number, string>();

	const stderr = new Map<number, (waitMs: number) => Promise<number | null>>();

	let socketPath: string | null = null;

	mkdirSync(join(config.stateDir, "stages", config.runId), {
		recursive: true,
		mode: 0o700,
	});

	const stageDir =
		config.stageDir ??
		freshDir(
			join(
				config.stateDir,
				"stages",
				config.runId,
				`${config.stage}-${config.attempt}`,
			),
		);

	mkdirSync(stageDir, { recursive: true, mode: 0o700 });

	return {
		cleanupReserveMs: CLEANUP_RESERVE_MS,
		assetsDigest: config.assetsDigest,
		versions: config.versions,
		now: config.now ?? Date.now,
		async startGateway(table) {
			mkdirSync(join(config.stateDir, "gw"), { recursive: true, mode: 0o700 });

			const started = await startGatewayProcess({
				gatewayDir: join(config.stateDir, "gw", randomBytes(4).toString("hex")),
				auditPath: join(stageDir, "egress.jsonl"),
				table,
				readyTimeoutMs: 10_000,
			});

			if (!started.ok) return null;

			socketPath = started.handle.socketPath;

			return started.handle;
		},
		async launchPi(model, session) {
			if (socketPath === null) return null;
			const agentDir = join(stageDir, `agent-${session}`);

			const launched = launchSandbox({
				...config,
				agentDir,
				socketPath,
				command: piCommand(
					model,
					config.tools.includes("subagent"),
					config.stage === "accept" ? config.acceptEffort : undefined,
				),
			});

			if (launched === null) return null;
			const { unit, child } = launched;
			agentDirs.set(session, agentDir);
			units.set(session, unit);

			if (child.stderr !== null) {
				stderr.set(
					session,
					captureStderr(
						child.stderr,
						join(stageDir, `pi-stderr-${session}.log`),
					),
				);
			}

			if (child.stdin === null || child.stdout === null) return null;

			const exited = new Promise<number | null>((done) => {
				child.on("exit", (code) => done(code));
				child.on("error", () => done(null));
			});

			return {
				stdin: child.stdin,
				stdout: child.stdout,
				exited,
				kill: () => child.kill("SIGKILL"),
			};
		},
		async stopSandbox(session) {
			const unit = units.get(session);

			if (unit === undefined) return;

			const [command, ...args] = stopScopeArgv(unit);

			await config.exec(command ?? "systemctl", args);
		},
		async readChildUsage(session, sessionFile) {
			const agentDir = agentDirs.get(session);

			const path =
				agentDir === undefined ? null : hostSessionPath(agentDir, sessionFile);

			if (path === null || statSync(path).size > MAX_SESSION_BYTES) return null;

			const text = await readFile(path, "utf8");
			let assistantTurns: number | null = 0;
			let toolResultBytes: number | null = 0;

			for (const line of text.split("\n").filter((line) => line !== "")) {
				const entry = objectOf(parseJson(line));

				if (entry === null) {
					assistantTurns = null;
					toolResultBytes = null;
					continue;
				}

				const message = fieldOf(entry, "message");

				if (message === undefined) continue;

				const record = parsePiRecord(
					JSON.stringify({ type: "message_end", message }),
				);

				if (record.type === "malformed") {
					assistantTurns = null;
					toolResultBytes = null;
				}

				if (record.type === "assistant_end" && assistantTurns !== null)
					assistantTurns++;

				if (record.type === "other" && record.textBytes !== undefined)
					toolResultBytes =
						record.textBytes === null || toolResultBytes === null
							? null
							: toolResultBytes + record.textBytes;
			}

			return {
				...childUsageOf(text),
				efficiency: { assistantTurns, toolResultBytes },
			};
		},
		readUsage() {
			const path = join(stageDir, "usage.json");

			if (!existsSync(path)) return null;

			try {
				return parseJson(readFileSync(path, "utf8"));
			} catch {
				return undefined;
			}
		},
		writeUsage(usage) {
			return replaceUsage(join(stageDir, "usage.json"), usage);
		},
		async writeReceipt(receipt) {
			return publishFile(
				join(stageDir, "receipt.json"),
				`${JSON.stringify(receipt, null, "\t")}\n`,
			);
		},
		async writeOutput(text) {
			return publishFile(join(stageDir, "output.txt"), text);
		},
		readJournal() {
			return boundedText(join(stageDir, JOURNAL_FILE), AUDIT_CAP_BYTES);
		},
		async stderrLog(session) {
			const finish = stderr.get(session);
			const bytes = finish === undefined ? null : await finish(EXIT_WAIT_MS);

			return bytes === null
				? null
				: { session, file: `pi-stderr-${session}.log`, bytes };
		},
	};
}

function replaceUsage(path: string, usage: ExecutionUsage): boolean {
	const temp = `${path}.next`;

	try {
		mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
		rmSync(temp, { force: true });

		if (!publishFile(temp, `${JSON.stringify(usage)}\n`)) return false;
		renameSync(temp, path);
		const dir = openSync(dirname(path), "r");

		try {
			fsyncSync(dir);
		} finally {
			closeSync(dir);
		}

		return true;
	} catch {
		return false;
	}
}

const MAX_RECEIPT_BYTES = 1024 * 1024;

async function boundedText(path: string, cap: number): Promise<string | null> {
	try {
		return statSync(path).size > cap ? null : await readFile(path, "utf8");
	} catch {
		return null;
	}
}

/**
 * Tokens one stage attempt is known to have used: the sum over each of its
 * execution dirs, `<stage>-<attempt>` and any replay `<stage>-<attempt>.<n>`,
 * each counted once. `null` when no dir left a receipt or an audit.
 */
async function attemptSpent(
	stateDir: string,
	runId: Digest,
	stage: ModelStage,
	attempt: number,
	round = 0,
): Promise<number | null> {
	const base = stageName(stage, attempt, round);
	const root = join(stateDir, "stages", runId);
	let names: string[];

	try {
		names = readdirSync(root);
	} catch {
		return null;
	}

	let total: number | null = null;

	for (const name of names) {
		const replay =
			name.startsWith(`${base}.`) && /^\d+$/.test(name.slice(base.length + 1));

		if (name !== base && !replay) continue;

		const spent = await executionSpent(join(root, name));

		if (spent !== null) total = (total ?? 0) + spent;
	}

	return total;
}

async function executionSpent(dir: string): Promise<number | null> {
	return (await executionCharge(dir))?.total ?? null;
}

export type ExecutionCharge = {
	readonly total: number;
	readonly uncertain: number;
};

export function uncertainCharge(
	floor: number,
	requests: number,
	metered = 0,
	upperBound = 0,
): ExecutionCharge {
	return { total: Math.max(floor, metered + upperBound), uncertain: requests };
}

function summed(charges: (ExecutionCharge | null)[]): ExecutionCharge | null {
	return charges.some((charge) => charge !== null)
		? {
				total: charges.reduce((sum, charge) => sum + (charge?.total ?? 0), 0),
				uncertain: charges.reduce(
					(sum, charge) => sum + (charge?.uncertain ?? 0),
					0,
				),
			}
		: null;
}

/**
 * What one execution dir is known to have charged, from host-side files
 * only. A finished receipt's `usage.total` covers everything under it, so
 * its leaves are not added again. Without one, an aggregate specify or
 * review dir sums its session dirs, and a leaf takes the larger of its
 * synced request journal and the gateway's `egress.jsonl` tally, never
 * their sum. A dispatched request with no result is `uncertain`: its
 * recorded input-plus-output bound is charged by `uncertainCharge` and the
 * request is never sent again. Legacy dispatches without bounds remain floors. A line cut short by a crash is skipped. `null` when the dir
 * has no receipt, journal or audit.
 */
export async function executionCharge(
	dir: string,
): Promise<ExecutionCharge | null> {
	const receipt = await boundedText(
		join(dir, "receipt.json"),
		MAX_RECEIPT_BYTES,
	);

	const total =
		receipt === null
			? null
			: countOf(
					fieldOf(
						objectOf(fieldOf(objectOf(parseJson(receipt)), "usage")),
						"total",
					),
				);

	const covered = (charge: ExecutionCharge | null): ExecutionCharge | null =>
		total === null
			? charge
			: {
					total: Math.max(total, charge?.total ?? 0),
					uncertain: charge?.uncertain ?? 0,
				};

	if (existsSync(join(dir, "specify.json"))) {
		return covered(
			summed(
				await Promise.all(
					SPECIFY_SESSIONS.map((name) => executionCharge(join(dir, name))),
				),
			),
		);
	}

	if (
		[
			"review.json",
			"code-review",
			"security-review",
			"simplify",
			"ultrareview",
		].some((name) => existsSync(join(dir, name)))
	) {
		const names = readdirSync(dir).filter((name) =>
			["code-review", "security-review", "simplify", "ultrareview"].includes(
				name,
			),
		);

		return covered(
			summed(
				await Promise.all(
					names.map((name) => executionCharge(join(dir, name))),
				),
			),
		);
	}

	const high = objectOf(
		parseJson(
			(await boundedText(join(dir, "usage.json"), MAX_RECEIPT_BYTES)) ?? "",
		),
	);

	const highTotal = countOf(fieldOf(objectOf(fieldOf(high, "usage")), "total"));
	const journal = await boundedText(join(dir, JOURNAL_FILE), AUDIT_CAP_BYTES);
	const charged = journal === null ? null : journalCharge(journal);
	const audit = await boundedText(join(dir, "egress.jsonl"), AUDIT_CAP_BYTES);

	if (audit === null && charged === null && highTotal === null)
		return covered(null);

	let sum = 0;

	for (const line of (audit ?? "").split("\n")) {
		const record = objectOf(parseJson(line));

		if (record === null) continue;

		sum += countOf(fieldOf(record, "inputTokens")) ?? 0;
		sum += countOf(fieldOf(record, "outputTokens")) ?? 0;
	}

	return {
		...uncertainCharge(
			Math.max(sum, charged?.tokens ?? 0, highTotal ?? 0, total ?? 0),
			charged?.uncertain ?? 0,
			Math.max(sum, charged?.tokens ?? 0),
			charged?.uncertainTokens ?? 0,
		),
	};
}

/** Numeric diagnostics follow the same aggregate/leaf boundary as charges. */
export async function executionEfficiency(
	dir: string,
): Promise<EfficiencyFacts> {
	const receipt = objectOf(
		parseJson(
			(await boundedText(join(dir, "receipt.json"), MAX_RECEIPT_BYTES)) ?? "",
		),
	);

	const saved = parseEfficiency(fieldOf(receipt, "efficiency"));

	if (saved !== null) return saved;

	const leaves = [
		...SPECIFY_SESSIONS,
		"code-review",
		"security-review",
		"simplify",
		"ultrareview",
	];

	const names = leaves.filter((name) => existsSync(join(dir, name)));

	if (names.length > 0)
		return aggregateEfficiency(
			await Promise.all(
				names.map((name) => executionEfficiency(join(dir, name))),
			),
		);

	const high = objectOf(
		parseJson(
			(await boundedText(join(dir, "usage.json"), MAX_RECEIPT_BYTES)) ?? "",
		),
	);

	const progress =
		parseEfficiency(fieldOf(high, "efficiency")) ?? unknownEfficiency();

	const journal = await boundedText(join(dir, JOURNAL_FILE), AUDIT_CAP_BYTES);

	return { ...progress, ...requestEfficiency(journal) };
}

/** Where `server/provision.sh` installs content-addressed asset bundles. */
export const SANDBOX_ROOT = "/var/lib/factory-sandbox";

const BUNDLE_NAME = /^assets-([0-9a-f]{64})$/;

export type Bundle = { readonly dir: string; readonly digest: string };

/**
 * The bundle `<root>/current` links to. Its name carries the manifest digest
 * it was installed under, which the preflight recomputes.
 */
export async function locateBundle(root: string): Promise<Bundle | null> {
	try {
		const target = await readlink(join(root, "current"));
		const digest = BUNDLE_NAME.exec(target)?.[1];

		return digest === undefined ? null : { dir: join(root, target), digest };
	} catch {
		return null;
	}
}

const SPECIFY_SESSIONS = ["draft", "review", "revision"] as const;

type KeptSession = {
	readonly outcome: SessionOutcome;
	readonly usage: StageUsage;
	readonly turns: number;
	readonly wallMs: number;
	readonly text: string | null;
	readonly efficiency?: EfficiencyFacts;
};

export async function readStageReceipt(path: string) {
	const raw = await boundedText(path, MAX_RECEIPT_BYTES);
	const record = objectOf(parseJson(raw ?? ""));
	const result = objectOf(fieldOf(record, "outcome"));
	const kind = textOf(fieldOf(result, "kind"));
	let outcome: SessionOutcome;

	if (kind === "passed" || kind === "refused") outcome = { kind };
	else if (kind === "failed") {
		const exit = textOf(fieldOf(result, "exit"));

		if (
			exit !== "error" &&
			exit !== "malformed" &&
			exit !== "crashed" &&
			exit !== "aborted"
		)
			return null;

		outcome = { kind, exit };
	} else if (kind === "budget_exhausted") {
		const cap = textOf(fieldOf(result, "cap"));

		if (
			cap !== "tokens" &&
			cap !== "run_tokens" &&
			cap !== "turns" &&
			cap !== "wall"
		)
			return null;

		outcome = { kind, cap };
	} else return null;

	const usage = objectOf(fieldOf(record, "usage"));
	const byModel: Record<string, number> = {};

	for (const [key, value] of Object.entries(
		objectOf(fieldOf(usage, "byModel")) ?? {},
	)) {
		const count = countOf(value);

		if (count === null) return null;

		byModel[key] = count;
	}

	const total = countOf(fieldOf(usage, "total"));
	const turns = countOf(fieldOf(record, "turns"));
	const wallMs = countOf(fieldOf(record, "wallMs"));

	if (total === null || turns === null || wallMs === null) return null;

	return {
		record,
		outcome,
		turns,
		wallMs,
		usage: {
			total,
			byModel,
			parent: countOf(fieldOf(usage, "parent")) ?? 0,
			children: countOf(fieldOf(usage, "children")) ?? 0,
			gateway: countOf(fieldOf(usage, "gateway")),
			unreadChildren: countOf(fieldOf(usage, "unreadChildren")) ?? 0,
		},
	};
}

async function keptSession(dir: string): Promise<KeptSession | null> {
	const parsed = await readStageReceipt(join(dir, "receipt.json"));

	if (parsed === null) return null;

	const file = textOf(
		fieldOf(objectOf(fieldOf(parsed.record, "output")), "file"),
	);

	return {
		outcome: parsed.outcome,
		usage: parsed.usage,
		turns: parsed.turns,
		wallMs: parsed.wallMs,
		efficiency:
			parseEfficiency(fieldOf(parsed.record, "efficiency")) ?? undefined,
		text:
			parsed.outcome.kind === "passed" && file === "output.txt"
				? await boundedText(join(dir, file), OUTPUT_MAX_BYTES)
				: null,
	};
}

async function executionWindow(
	dir: string,
	input: StageLaunchInput,
): Promise<ExecutionUsage> {
	const path = join(dir, "usage.json");
	const text = await boundedText(path, MAX_RECEIPT_BYTES);
	const now = Date.now();

	const record =
		text === null
			? {
					version: 1 as const,
					runId: input.runId,
					stage: input.stage,
					attempt: input.attempt,
					startedAt: now,
					deadline: now + input.settings.budget.wallMs,
					turns: 0,
					usage: {
						total: 0,
						parent: 0,
						children: 0,
						gateway: null,
						unreadChildren: 0,
						byModel: {},
					},
				}
			: executionUsageOf(parseJson(text), input);

	if (
		record === null ||
		(text === null && existsSync(path)) ||
		!replaceUsage(path, record)
	)
		throw new Error("execution_usage_unavailable");

	return record;
}

export async function runSpecify(
	input: StageLaunchInput,
	dir: string,
	createHost: (dir: string, tools: readonly string[]) => StageHost,
): Promise<StageResult> {
	const review = input.specify;

	if (review === undefined) throw new Error("specify inputs missing");

	mkdirSync(dir, { recursive: true, mode: 0o700 });

	if (
		!existsSync(join(dir, "specify.json")) &&
		!publishFile(join(dir, "specify.json"), '{"version":1}\n')
	)
		throw new Error("specify checkpoint unavailable");

	const window = await executionWindow(dir, input);
	const previous = (await executionSpent(dir)) ?? 0;
	const records: KeptSession[] = [];
	let metadata: Pick<StageReceipt, "assetsDigest" | "versions"> | null = null;

	const usage = (): StageUsage => {
		const ledger = new Ledger();
		let gatewayRan = false;

		for (const record of records) {
			ledger.parent += record.usage.parent;
			ledger.children += record.usage.children;
			ledger.gateway += record.usage.gateway ?? 0;
			ledger.unreadChildren += record.usage.unreadChildren;
			ledger.add(new Map(Object.entries(record.usage.byModel)));
			gatewayRan ||= record.usage.gateway !== null;
		}

		return {
			...ledger.usage(gatewayRan),
			total: records.reduce((sum, record) => sum + record.usage.total, 0),
		};
	};

	const turns = () => records.reduce((sum, record) => sum + record.turns, 0);
	const wallMs = () => records.reduce((sum, record) => sum + record.wallMs, 0);

	const session = async (
		name: (typeof SPECIFY_SESSIONS)[number],
		prompt: string,
		tools: readonly string[],
	): Promise<KeptSession> => {
		const sessionDir = join(dir, name);
		const kept = await keptSession(sessionDir);

		if (kept !== null) {
			records.push(kept);

			return kept;
		}

		const used = usage().total;

		const maxTokens =
			input.settings.maxTokens === null
				? null
				: Math.max(0, input.settings.maxTokens - used);

		const remainingRunTokens = Math.max(
			0,
			input.remainingRunTokens - (used - previous),
		);

		const remainingTurns = Math.max(
			0,
			input.settings.budget.maxTurns - turns(),
		);

		const remainingWall = Math.max(
			0,
			Math.min(
				window.deadline - Date.now(),
				input.settings.budget.wallMs - wallMs(),
			),
		);

		const cap: BudgetCap | null =
			maxTokens !== null && maxTokens <= 0
				? "tokens"
				: remainingRunTokens <= 0
					? "run_tokens"
					: remainingTurns <= 0
						? "turns"
						: remainingWall <= 0
							? "wall"
							: null;

		if (cap !== null || existsSync(sessionDir)) {
			const partial = (await executionSpent(sessionDir)) ?? 0;

			const record: KeptSession = {
				outcome: cap === null ? CRASHED : { kind: "budget_exhausted", cap },
				usage: {
					total: partial,
					parent: 0,
					children: 0,
					gateway: partial,
					unreadChildren: 0,
					byModel: {},
				},
				turns: 0,
				wallMs: 0,
				text: null,
			};

			records.push(record);

			return record;
		}

		const host = createHost(sessionDir, tools);
		metadata = host;

		const result = await runStage(
			{
				...input,
				prompt,
				source:
					name === "draft"
						? input.source
						: { bytes: 0, omissions: 0, capHit: false },
				settings: {
					...input.settings,
					fallback: name === "draft" ? input.settings.fallback : null,
					maxTokens,
					budget: {
						...input.settings.budget,
						maxTurns: remainingTurns,
						wallMs: remainingWall,
					},
				},
				remainingRunTokens,
				progress: (value) =>
					input.progress(Math.max(0, used - previous) + value),
			},
			host,
		);

		const record: KeptSession = {
			...result.receipt,
			text:
				result.kind === "passed"
					? await boundedText(join(sessionDir, "output.txt"), OUTPUT_MAX_BYTES)
					: null,
		};

		records.push(record);

		return record;
	};

	const finish = async (
		outcome: SessionOutcome,
		text: string | null,
	): Promise<StageResult> => {
		const last = records.at(-1);

		const raw = objectOf(
			parseJson(
				(await boundedText(
					join(dir, "draft", "receipt.json"),
					MAX_RECEIPT_BYTES,
				)) ?? "",
			),
		);

		const assetsDigest =
			metadata?.assetsDigest ?? textOf(fieldOf(raw, "assetsDigest")) ?? "";

		const versions = objectOf(fieldOf(raw, "versions"));
		const kept = outcome.kind === "passed" && text !== null;
		const bytes = text === null ? 0 : Buffer.byteLength(text);

		const outputWritten =
			!kept ||
			existsSync(join(dir, "output.txt")) ||
			publishFile(join(dir, "output.txt"), text ?? "");

		const receipt: StageReceipt = {
			version: 1,
			runId: input.runId,
			stage: input.stage,
			attempt: input.attempt,
			outcome: outputWritten ? outcome : CRASHED,
			settlement: {
				event: last === undefined ? "none" : "agent_settled",
				aborted: null,
			},
			models: { requested: input.settings.model, observed: null },
			fallback: null,
			refusal: null,
			usage: usage(),
			efficiency: aggregateEfficiency(
				records.map((r) => r.efficiency ?? unknownEfficiency()),
			),
			turns: turns(),
			wallMs: wallMs(),
			egress: null,
			stderr: [],
			output:
				kept && outputWritten
					? { file: "output.txt", bytes, kept: bytes }
					: null,
			assetsDigest,
			versions: metadata?.versions ?? {
				pi: textOf(fieldOf(versions, "pi")) ?? PINNED_VERSIONS.pi,
				piHerdrAgents:
					textOf(fieldOf(versions, "piHerdrAgents")) ??
					PINNED_VERSIONS.piHerdrAgents,
				piHerdrPstack:
					textOf(fieldOf(versions, "piHerdrPstack")) ??
					PINNED_VERSIONS.piHerdrPstack,
			},
			pricing: "unavailable",
		};

		const checkpoint = replaceUsage(join(dir, "usage.json"), {
			...window,
			turns: receipt.turns,
			usage: receipt.usage,
		});

		const written =
			checkpoint &&
			(existsSync(join(dir, "receipt.json")) ||
				publishFile(
					join(dir, "receipt.json"),
					JSON.stringify(receipt, null, "\t"),
				));

		return {
			...stageResult(written ? receipt : { ...receipt, outcome: CRASHED }),
			usage: Math.max(0, receipt.usage.total - previous),
		};
	};

	const draft = await session("draft", input.prompt, input.tools);

	if (draft.outcome.kind !== "passed") return finish(draft.outcome, null);

	const parsed = parseSpecifyOutput(draft.text ?? "", new Set(review.files));

	if (parsed.kind === "malformed")
		return finish({ kind: "failed", exit: "malformed" }, null);

	if (parsed.kind === "questions")
		return finish({ kind: "passed" }, draft.text);

	const critique = await session(
		"review",
		reviewPrompt(review, draft.text ?? ""),
		[],
	);

	if (critique.outcome.kind !== "passed") return finish(critique.outcome, null);

	const ambiguities = parseReviewOutput(critique.text ?? "");

	if (ambiguities === null)
		return finish({ kind: "failed", exit: "malformed" }, null);

	if (ambiguities.length === 0) return finish({ kind: "passed" }, draft.text);

	const revision = await session(
		"revision",
		revisionPrompt(review, draft.text ?? "", ambiguities),
		[],
	);

	if (revision.outcome.kind !== "passed") return finish(revision.outcome, null);

	if (
		parseSpecifyOutput(revision.text ?? "", new Set(review.files)).kind ===
		"malformed"
	)
		return finish({ kind: "failed", exit: "malformed" }, null);

	return finish({ kind: "passed" }, revision.text);
}

const SKILL_NAME = /^[a-z0-9][a-z0-9-]{0,63}$/;

const SKILL_MAX_BYTES = 32 * 1024;

function skillBody(text: string): string {
	const match = /^---\n[\s\S]*?\n---\n/.exec(text);

	return (match === null ? text : text.slice(match[0].length)).trim();
}

export async function withSkills(
	bundleDir: string,
	prompt: string,
	skills: readonly string[],
): Promise<string | null> {
	if (skills.length === 0) return prompt;

	const parts: string[] = [];

	for (const name of skills) {
		if (!SKILL_NAME.test(name)) return null;

		const text = await boundedText(
			join(bundleDir, "skills", name, "SKILL.md"),
			SKILL_MAX_BYTES,
		);

		if (text === null) return null;

		parts.push(`### Skill: ${name}\n\n${skillBody(text)}`);

		if (name === "build") {
			const playbook = (prompt + "\n").startsWith("build-playbook=bug-fix\n")
				? "bug-fix"
				: "feature";

			const source = await boundedText(
				join(
					bundleDir,
					"pkg/node_modules/pi-herdr-pstack/skills/poteto-mode/playbooks",
					`${playbook}.md`,
				),
				SKILL_MAX_BYTES,
			);

			if (source === null) return null;

			const excerpt = source
				.split("\n")
				.filter((line) =>
					playbook === "bug-fix"
						? /^(Be scientific\.|1\. |4\. )/.test(line)
						: line.startsWith("5. "),
				)
				.join("\n\n");

			if (!excerpt) return null;
			parts.push(`### Pstack ${playbook} playbook excerpt\n\n${excerpt}`);
		}
	}

	return `${prompt}\n\n## Skills\n\n${parts.join("\n\n")}\n`;
}

async function attemptOutput(
	stateDir: string,
	runId: Digest,
	stage: ModelStage,
	attempt: number,
	round = 0,
): Promise<StageOutput | null> {
	const base = stageName(stage, attempt, round);
	const root = join(stateDir, "stages", runId);
	let names: string[];

	try {
		names = readdirSync(root);
	} catch {
		return null;
	}

	const replays = names
		.flatMap((name) => {
			if (name === base) return [{ name, n: 1 }];

			const suffix = name.slice(base.length + 1);

			return name.startsWith(`${base}.`) && /^\d+$/.test(suffix)
				? [{ name, n: Number(suffix) }]
				: [];
		})
		.sort((left, right) => right.n - left.n);

	for (const { name } of replays) {
		const dir = join(root, name);

		const receipt = objectOf(
			parseJson(
				(await boundedText(join(dir, "receipt.json"), MAX_RECEIPT_BYTES)) ?? "",
			),
		);

		const outcome = textOf(
			fieldOf(objectOf(fieldOf(receipt, "outcome")), "kind"),
		);

		const file = textOf(fieldOf(objectOf(fieldOf(receipt, "output")), "file"));

		if (
			outcome === null &&
			(existsSync(join(dir, "specify.json")) ||
				existsSync(join(dir, "review.json")))
		)
			return { kind: "pending" };

		if (outcome !== "passed" || file !== "output.txt") continue;

		const text = await boundedText(join(dir, file), OUTPUT_MAX_BYTES);

		if (text !== null) {
			if (stage !== "accept") return text;
			const models = objectOf(fieldOf(receipt, "models"));
			const fallback = objectOf(fieldOf(receipt, "fallback"));

			const model =
				textOf(fieldOf(fallback, "requested")) ??
				textOf(fieldOf(models, "requested"));

			const family = parseFamily(fieldOf(receipt, "family"));

			return model === null
				? null
				: withFamily(
						{
							kind: "output" as const,
							text,
							model,
							observed:
								textOf(fieldOf(fallback, "observed")) ??
								textOf(fieldOf(models, "observed")),
						},
						family,
					);
		}
	}

	return null;
}

/**
 * The builder's family for a round: the family stored on the latest passed
 * build attempt of that round whose answering request is the patch's
 * recorded model. Only `openai-request` for that exact model counts;
 * anything else is unavailable, so `r8` stays incomplete.
 */
async function builderFamily(
	stateDir: string,
	runId: Digest,
	round: number,
	model: string,
): Promise<FamilyInput> {
	const root = join(stateDir, "stages", runId);
	const prefix = round > 0 ? `build-r${round}-` : "build-";
	const name = /^(\d+)(?:\.(\d+))?$/;
	let names: string[];

	try {
		names = readdirSync(root);
	} catch {
		return FAMILY_MISSING;
	}

	const attempts = names
		.flatMap((entry) => {
			const match = entry.startsWith(prefix)
				? name.exec(entry.slice(prefix.length))
				: null;

			return match === null
				? []
				: [{ entry, attempt: Number(match[1]), n: Number(match[2] ?? 1) }];
		})
		.sort((a, b) => b.attempt - a.attempt || b.n - a.n);

	for (const { entry } of attempts) {
		const receipt = objectOf(
			parseJson(
				(await boundedText(
					join(root, entry, "receipt.json"),
					MAX_RECEIPT_BYTES,
				)) ?? "",
			),
		);

		if (
			textOf(fieldOf(objectOf(fieldOf(receipt, "outcome")), "kind")) !==
			"passed"
		)
			continue;

		const requested =
			textOf(fieldOf(objectOf(fieldOf(receipt, "fallback")), "requested")) ??
			textOf(fieldOf(objectOf(fieldOf(receipt, "models")), "requested"));

		const family = parseFamily(fieldOf(receipt, "family"));

		return requested === model &&
			family?.kind === "openai-request" &&
			family.model === model
			? family
			: FAMILY_MISSING;
	}

	return FAMILY_MISSING;
}

function stageName(stage: ModelStage, attempt: number, round = 0): string {
	return round > 0 || stage === "review"
		? `${stage}-r${round}-${attempt}`
		: `${stage}-${attempt}`;
}

function readRunPatch(stateDir: string, runId: Digest, round = 0): PatchRead {
	try {
		const record = objectOf(
			parseJson(
				readFileSync(
					join(stateDir, "patches", `${roundKey(runId, round)}.json`),
					"utf8",
				),
			),
		);

		const baseSha = textOf(fieldOf(record, "baseSha"));
		const contractDigest = textOf(fieldOf(record, "contractDigest"));
		const acceptanceDigest = textOf(fieldOf(record, "acceptanceDigest"));

		if (
			baseSha === null ||
			contractDigest === null ||
			acceptanceDigest === null ||
			!isDigest(acceptanceDigest)
		)
			return { kind: "blocked", reason: "patch_invalid" };

		return readPatch(stateDir, {
			round,
			runId,
			baseSha,
			contractDigest,
			acceptanceDigest,
		});
	} catch (error) {
		return error instanceof Error && "code" in error && error.code === "ENOENT"
			? existsSync(patchDir(stateDir, runId, round))
				? { kind: "blocked", reason: "patch_missing" }
				: { kind: "absent" }
			: { kind: "blocked", reason: "patch_invalid" };
	}
}

function buildCommands(
	stateDir: string,
	runId: Digest,
	attempt: number,
	round = 0,
) {
	const root = join(stateDir, "stages", runId);
	const commands: ReturnType<typeof commandReceipts> = [];

	const walk = (dir: string) => {
		for (const name of readdirSync(dir).sort()) {
			const path = join(dir, name);
			const stat = lstatSync(path);

			if (stat.isDirectory()) walk(path);
			else if (
				stat.isFile() &&
				name.endsWith(".jsonl") &&
				stat.size <= MAX_SESSION_BYTES &&
				path.includes("/sessions/")
			)
				commands.push(...commandReceipts(readFileSync(path, "utf8")));
		}
	};

	for (const name of readdirSync(root).sort())
		if (
			name === stageName("build", attempt, round) ||
			name.startsWith(`${stageName("build", attempt, round)}.`)
		)
			walk(join(root, name));

	return commands;
}

export async function runVisibleTests(
	config: SandboxHostConfig,
	base: string,
	patch: string | Uint8Array,
	command: string,
	replacesTests: readonly { readonly path: string }[] = [],
): Promise<VisibleTests> {
	const start = Date.now();
	const dir = join(config.stateDir, "visible-tests", config.runId);
	mkdirSync(dir, { recursive: true, mode: 0o700 });
	const execution = freshDir(join(dir, "execution"));
	const workspace = join(execution, "tree");
	let gateway: GatewayHandle | null = null;
	let unit: string | null = null;
	let timer: ReturnType<typeof setTimeout> | null = null;
	let tail = Buffer.alloc(0);
	let timedOut = false;
	let environment: VisibleTests["environment"];

	try {
		await patchedTree(base, workspace, patch);
		command = trustedVisiblePlan(
			base,
			workspace,
			command,
			replacesTests,
		).command;
		environment = visibleEnvironment(
			workspace,
			digestOf(
				JSON.stringify({
					bundle: config.assetsDigest,
					arch: config.arch,
					versions: config.versions,
					runner: "visible-bwrap-v1",
				}),
			),
		);

		const table = builtinTable({
			stage: "build",
			runId: config.runId,
			attempt: config.attempt,
			model: "disabled",
			fallback: null,
			modelTokens: 0,
			modelRequests: 0,
		});

		mkdirSync(join(config.stateDir, "gw"), { recursive: true, mode: 0o700 });

		const started = await startGatewayProcess({
			gatewayDir: join(config.stateDir, "gw", randomBytes(4).toString("hex")),
			auditPath: join(execution, "egress.jsonl"),
			table: {
				...table,
				routes: table.routes
					.filter((route) => route.id === "npm")
					.map((route) => ({ ...route, budget: false })),
			},
			readyTimeoutMs: 10_000,
		});

		if (!started.ok) throw new Error("gateway_unavailable");
		gateway = started.handle;

		const launched = (config.launch ?? launchSandbox)({
			...config,
			workspace,
			tools: [],
			agentDir: join(execution, "agent"),
			socketPath: gateway.socketPath,
			command: [
				"/bin/bash",
				"-c",
				`set -o pipefail; export PATH="/workspace/node_modules/.bin:$PATH"; export npm_config_ignore_scripts=true; if [ -f package-lock.json ]; then npm ci --ignore-scripts --no-audit --no-fund || exit 125; fi; /bin/bash -o pipefail -c '${command.replaceAll("'", "'\\''")}'; code=$?; printf '%s\\n' "$code" > /run/pi-agent/visible-exit; exit "$code"`,
			],
		});

		if (launched === null) throw new Error("sandbox_unavailable");
		unit = launched.unit;

		const keep = (chunk: Buffer) => {
			tail = Buffer.concat([tail, chunk]).subarray(-TEST_TAIL_BYTES);
		};

		launched.child.stdout?.on("data", keep);
		launched.child.stderr?.on("data", keep);
		launched.child.stdin?.end();
		timer = setTimeout(() => {
			timedOut = true;

			if (unit !== null) {
				const [cmd, ...args] = stopScopeArgv(unit);
				void config.exec(cmd ?? "systemctl", args);
			}

			launched.child.kill("SIGKILL");
		}, 180_000);

		const exitCode = await new Promise<number | null>((done) => {
			launched.child.once("close", done);
			launched.child.once("error", () => done(null));
		});

		if (timedOut) throw new Error("timeout");

		const resultPath = join(execution, "agent", "visible-exit");

		if (
			exitCode === null ||
			!lstatSync(resultPath).isFile() ||
			(await boundedText(resultPath, 4))?.trim() !== String(exitCode)
		)
			throw new Error("sandbox_unavailable");

		if (checkBuildDisk([workspace, join(execution, "agent")]) !== null)
			throw new Error("build_disk_limit");

		return {
			command,
			environment,
			exitCode,
			tail: tail.toString(),
			wallMs: Date.now() - start,
		};
	} catch (error) {
		const detail =
			error instanceof Error &&
			[
				"gateway_unavailable",
				"malformed_patch",
				"timeout",
				"build_disk_limit",
			].includes(error.message)
				? error.message
				: "sandbox_unavailable";

		return {
			command,
			environment,
			exitCode: null,
			reason: "visible_tests_unavailable",
			// SAFETY: only the fixed infrastructure reason allowlist above reaches this field.
			detail: detail as NonNullable<VisibleTests["detail"]>,
			tail: "Visible tests could not run",
			wallMs: Date.now() - start,
		};
	} finally {
		if (timer !== null) clearTimeout(timer);

		if (unit !== null) {
			const [cmd, ...args] = stopScopeArgv(unit);
			await config.exec(cmd ?? "systemctl", args);
		}

		await gateway?.shutdown();
		rmSync(workspace, { recursive: true, force: true });
		rmSync(join(execution, "agent"), { recursive: true, force: true });

		if (gateway !== null)
			rmSync(dirname(gateway.socketPath), { recursive: true, force: true });
	}
}

function cleanupBuildAgents(
	stateDir: string,
	runId: Digest,
	attempt: number,
	round = 0,
): void {
	const root = join(stateDir, "stages", runId);

	if (!existsSync(root)) return;

	for (const name of readdirSync(root)) {
		if (
			name !== stageName("build", attempt, round) &&
			!new RegExp(`^${stageName("build", attempt, round)}\\.[0-9]+$`).test(name)
		)
			continue;

		const stage = join(root, name);

		const agents = readdirSync(stage).filter((agent) =>
			/^agent-[0-9]+$/.test(agent),
		);

		const sessions: {
			source: string;
			dest: string;
			size: number;
			mtime: number;
		}[] = [];

		const walk = (source: string, dest: string) => {
			const info = lstatSync(source);

			if (info.isSymbolicLink()) return;

			if (info.isDirectory()) {
				for (const entry of readdirSync(source))
					walk(join(source, entry), join(dest, entry));
			} else if (info.isFile() && source.endsWith(".jsonl"))
				sessions.push({ source, dest, size: info.size, mtime: info.mtimeMs });
		};

		for (const agent of agents) {
			const source = join(stage, agent, "sessions");

			if (!lstatSync(join(stage, agent)).isSymbolicLink() && existsSync(source))
				walk(source, join(stage, "sessions", agent));
		}

		sessions.sort(
			(a, b) => b.mtime - a.mtime || a.source.localeCompare(b.source),
		);
		let bytes = 0;
		const dropped: string[] = [];
		chmodSync(stage, 0o700);

		for (const session of sessions) {
			if (bytes + session.size > 8 * 1024 * 1024) {
				dropped.push(session.source.slice(stage.length + 1));
				continue;
			}

			mkdirSync(dirname(session.dest), { recursive: true, mode: 0o700 });
			renameSync(session.source, session.dest);
			chmodSync(session.dest, 0o600);
			bytes += session.size;
		}

		if (dropped.length > 0) {
			const path = join(stage, "receipt.json");
			const receipt = objectOf(parseJson(readFileSync(path, "utf8")));

			const updated = `${path}.sessions-${randomBytes(4).toString("hex")}`;

			if (
				receipt !== null &&
				publishFile(
					updated,
					JSON.stringify(
						{ ...receipt, session_truncated: dropped },
						null,
						"\t",
					),
				)
			)
				renameSync(updated, path);
		}

		for (const agent of agents)
			rmSync(join(stage, agent), { recursive: true, force: true });
	}
}

function cleanupBuildBase(stateDir: string, runId: Digest): void {
	rmSync(join(stateDir, "build-base", "checkouts", `${runId}.json`), {
		force: true,
	});
	rmSync(join(stateDir, "pristine", runId), { recursive: true, force: true });
}

function capturedReviewText(path: string, cap?: number): string {
	try {
		return regularText(path, cap);
	} catch {
		throw new ReviewEvidenceUnavailable("review_execution_binding");
	}
}

function reviewInputRecord(input: ReviewInput) {
	return {
		binding: input.binding,
		seats: input.seats,
		files: [...input.files],
		scenarios: input.scenarios,
		prompt: input.prompt,
	};
}

function readCapturedReview(
	dir: string,
	execution: ReviewExecution,
	expected: Omit<ReviewInput, "prompt">,
): ReviewInput {
	const record = objectOf(
		parseJson(capturedReviewText(join(dir, "review.json"), Infinity)),
	);

	const input = objectOf(fieldOf(record, "input"));
	const files = arrayOf(fieldOf(input, "files"));
	const prompt = textOf(fieldOf(input, "prompt"));
	const reviewedFiles = new Map<string, number>();

	if (
		capturedReviewText(join(dir, "execution.json")) !==
			`${JSON.stringify(execution)}\n` ||
		record === null ||
		Object.keys(record).sort().join() !==
			"execution,input,inputDigest,version" ||
		fieldOf(record, "version") !== 3 ||
		JSON.stringify(fieldOf(record, "execution")) !==
			JSON.stringify(execution) ||
		input === null ||
		Object.keys(input).sort().join() !==
			"binding,files,prompt,scenarios,seats" ||
		JSON.stringify(fieldOf(input, "binding")) !==
			JSON.stringify(expected.binding) ||
		JSON.stringify(fieldOf(input, "seats")) !==
			JSON.stringify(expected.seats) ||
		JSON.stringify(fieldOf(input, "scenarios")) !==
			JSON.stringify(expected.scenarios) ||
		files === null ||
		files.length !== expected.files.size ||
		prompt === null ||
		prompt.length === 0
	)
		throw new ReviewEvidenceUnavailable("review_execution_binding");

	for (const entry of files) {
		const tuple = arrayOf(entry);
		const path = textOf(tuple?.[0]);
		const lines = countOf(tuple?.[1]);

		if (
			tuple?.length !== 2 ||
			path === null ||
			lines === null ||
			reviewedFiles.has(path) ||
			expected.files.get(path) !== lines
		)
			throw new ReviewEvidenceUnavailable("review_execution_binding");
		reviewedFiles.set(path, lines);
	}

	const restored = { ...expected, files: reviewedFiles, prompt };

	if (
		fieldOf(record, "inputDigest") !==
			digestOf(JSON.stringify(reviewInputRecord(restored))) ||
		JSON.stringify(execution.binding) !== JSON.stringify(restored.binding) ||
		JSON.stringify(execution.seats) !== JSON.stringify(restored.seats)
	)
		throw new ReviewEvidenceUnavailable("review_execution_binding");

	return restored;
}

function reviewVerdict(path: string): Verdict {
	const record = objectOf(parseJson(capturedReviewText(path, 1024 * 1024)));
	const checks = arrayOf(fieldOf(record, "checks"));
	const required = arrayOf(fieldOf(record, "requiredChecks"));
	const unjudged = arrayOf(fieldOf(record, "unjudged"));
	const patchDigest = textOf(fieldOf(record, "patchDigest"));
	const acceptanceDigest = textOf(fieldOf(record, "acceptanceDigest"));
	const heldoutDigest = textOf(fieldOf(record, "heldoutDigest"));

	if (
		record === null ||
		checks === null ||
		required === null ||
		unjudged === null ||
		patchDigest === null ||
		!isDigest(patchDigest) ||
		acceptanceDigest === null ||
		!isDigest(acceptanceDigest) ||
		heldoutDigest === null ||
		!isDigest(heldoutDigest) ||
		[...required, ...unjudged].some((value) => textOf(value) === null)
	)
		throw new ReviewEvidenceUnavailable("stored_verdict_invalid");

	return {
		...record,
		patchDigest,
		acceptanceDigest,
		heldoutDigest,
		candidateSha: textOf(record.candidateSha) ?? "",
		gateSha: textOf(record.gateSha) ?? "",
		ciRunId: countOf(record.ciRunId) ?? 0,
		originalBase: textOf(record.originalBase) ?? "",
		baseSha: textOf(record.baseSha) ?? "",
		pass: record.pass === true,
		checks: checks.map((check) => {
			const item = objectOf(check);
			const name = textOf(fieldOf(item, "name"));
			const passed = fieldOf(item, "passed");

			if (name === null || (passed !== true && passed !== false))
				throw new ReviewEvidenceUnavailable("stored_verdict_invalid");

			return { ...item, name, passed };
		}),
		requiredChecks: required.map((value) => textOf(value) ?? ""),
		unjudged: unjudged.map((value) => textOf(value) ?? ""),
	};
}

async function prepareCandidateReview(
	config: SandboxExecutorConfig,
	input: Parameters<NonNullable<StageExecutor["prepareReview"]>>[0],
): Promise<ReviewPreparation | ReviewInputRefusal> {
	try {
		return await candidateReviewInputs(config, input);
	} catch (error) {
		if (
			error instanceof Error &&
			"code" in error &&
			["ENOSPC", "EROFS", "EIO", "EMFILE", "ENFILE"].includes(
				String(error.code),
			)
		)
			throw new ReviewEvidenceUnavailable("review_inputs_unavailable");
		throw error;
	}
}

async function candidateReviewInputs(
	config: SandboxExecutorConfig,
	input: Parameters<NonNullable<StageExecutor["prepareReview"]>>[0],
): Promise<ReviewPreparation | ReviewInputRefusal> {
	const { runId, round, workspace, workflowSha, workflowDigest, execution } =
		input;

	if (
		execution === undefined ||
		execution.runId !== runId ||
		execution.round !== round ||
		execution.generation.round !== round ||
		execution.workflowSha !== workflowSha ||
		execution.workflowDigest !== workflowDigest
	)
		throw new ReviewEvidenceUnavailable("review_binding");

	const { id, ...descriptor } = execution;

	if (id !== digestOf(JSON.stringify(descriptor)))
		throw new ReviewEvidenceUnavailable("review_execution_binding");

	const files = fileRunFiles(config.stateDir);
	const bound = await files.readContract(runId);

	if (bound.kind !== "found")
		throw new ReviewEvidenceUnavailable("contract_missing");

	const suite = await fileArtifacts(config.stateDir).read(
		runId,
		bound.contract,
		bound.digest,
	);

	const patch = readRunPatch(config.stateDir, runId, round);

	if (suite.kind !== "found" || patch.kind !== "found")
		throw new ReviewEvidenceUnavailable("review_inputs_missing");

	const dir = validationDir(
		config.stateDir,
		runId,
		round,
		execution?.generation.generation,
	);

	const verdict = reviewVerdict(join(dir, "verdict.json"));

	if (
		!verdictPasses(verdict) ||
		!isGitSha(verdict.baseSha) ||
		verdict.originalBase !== bound.contract.base.sha ||
		verdict.patchDigest !== patch.receipt.patchDigest ||
		patch.receipt.contractDigest !== bound.digest ||
		patch.receipt.acceptanceDigest !== suite.receipt.acceptanceDigest ||
		verdict.acceptanceDigest !== suite.receipt.acceptanceDigest ||
		(execution !== undefined &&
			(execution.runId !== runId ||
				execution.round !== round ||
				execution.workflowSha !== workflowSha ||
				execution.workflowDigest !== workflowDigest ||
				execution.binding.candidateSha !== verdict.candidateSha ||
				execution.binding.baseSha !== verdict.baseSha ||
				execution.binding.ciRunId !== verdict.ciRunId ||
				execution.binding.patchDigest !== verdict.patchDigest))
	)
		throw new ReviewEvidenceUnavailable("review_binding");

	const gate = objectOf(
		parseJson(capturedReviewText(join(dir, "receipt.json"))),
	);

	if (
		countOf(fieldOf(gate, "modelCalls")) !== 0 ||
		fieldOf(gate, "candidateSha") !== verdict.candidateSha
	)
		throw new ReviewEvidenceUnavailable("review_gate_binding");

	if (workflowSha !== bound.contract.base.sha)
		throw new ReviewEvidenceUnavailable("workflow_mismatch");

	const workflowWorkspace = files.workspacePath(runId);
	mkdirSync(workflowWorkspace, { recursive: true, mode: 0o700 });

	const pinned = await checkoutWorkspace({
		stateDir: config.stateDir,
		workspace: workflowWorkspace,
		runId,
		repo: bound.contract.base.repo,
		sha: workflowSha,
		fetch: config.fetchTarball ?? ghTarball,
	});

	if (pinned.kind !== "ready")
		throw new ReviewEvidenceUnavailable("workflow_checkout");

	const text = await pinned.checkout.read(WORKFLOW_PATH, 256 * 1024);

	if (text === null || digestOf(text) !== workflowDigest)
		throw new ReviewEvidenceUnavailable("workflow_mismatch");

	const workflow = parseWorkflow({
		text,
		repo: bound.contract.base.repo,
		env: (name) => process.env[name],
	});

	if (workflow.kind !== "valid")
		throw new ReviewEvidenceUnavailable("workflow_invalid");

	const reviewBase = join(config.stateDir, "review-base", verdict.baseSha);
	const base = join(reviewBase, "trees", runId);
	mkdirSync(base, { recursive: true, mode: 0o700 });

	const checked = await checkoutWorkspace({
		stateDir: reviewBase,
		workspace: base,
		runId,
		repo: bound.contract.base.repo,
		sha: verdict.baseSha,
		fetch: config.fetchTarball ?? ghTarball,
	});

	if (checked.kind !== "ready")
		throw new ReviewEvidenceUnavailable("review_checkout");

	rmSync(workspace, { recursive: true, force: true });

	try {
		await prepareRepairTree(
			base,
			workspace,
			patch.patch,
			patch.receipt.changedPaths,
			"{}",
		);
	} catch (error) {
		if (
			error instanceof Error &&
			[
				"stale_base",
				"patch_invalid",
				"forbidden_paths",
				"unsafe_symlink",
				"unsafe_tree",
				"unsafe_path",
				"special_file",
				"too_large",
			].includes(error.message)
		)
			throw new ReviewEvidenceUnavailable(error.message);
		throw error;
	}

	rmSync(join(workspace, ".factory-feedback.json"));
	rmSync(join(workspace, ".factory-feedback-full.json"), { force: true });
	const reviewedFiles = new Map<string, number>();

	const walk = (root: string, prefix = "") => {
		for (const entry of readdirSync(root, { withFileTypes: true })) {
			const path = prefix + entry.name;

			if (
				path === ".github" ||
				path === "test/acceptance" ||
				entry.name === "node_modules" ||
				entry.name === ".git"
			)
				continue;

			if (entry.isDirectory()) walk(join(root, entry.name), `${path}/`);
			else if (entry.isFile())
				reviewedFiles.set(
					path,
					readFileSync(join(root, entry.name), "utf8").split("\n").length,
				);
		}
	};

	walk(workspace);

	const risks = {
		newDependency: fieldOf(gate, "newDependency") === true,
		scriptsChanged: fieldOf(gate, "scriptsChanged") === true,
		dependencies: objectOf(fieldOf(gate, "dependencies")) ?? {},
		installScripts: arrayOf(fieldOf(gate, "installScripts")) ?? [],
	};

	const expected = {
		binding: {
			runId,
			round,
			candidateSha: verdict.candidateSha,
			patchDigest: patch.receipt.patchDigest,
			contractDigest: bound.digest,
			acceptanceDigest: suite.receipt.acceptanceDigest,
			ciRunId: verdict.ciRunId,
			originalBase: bound.contract.base.sha,
			baseSha: verdict.baseSha,
			execution: {
				generation: execution.generation.generation,
				intentDigest: execution.generation.digest,
				attempt: execution.attempt,
				workflowSha,
				workflowDigest,
			},
		},
		files: reviewedFiles,
		scenarios: verdict.unjudged,
		seats: reviewSeats(patch.receipt.changedPaths, risks),
	};

	const stageDir = join(
		config.stateDir,
		"stages",
		runId,
		stageName("review", execution.attempt, round),
	);

	if (
		capturedReviewText(join(stageDir, "execution.json")) !==
			`${JSON.stringify(execution)}\n` ||
		JSON.stringify(expected.binding) !== JSON.stringify(execution.binding) ||
		JSON.stringify(expected.seats) !== JSON.stringify(execution.seats)
	)
		throw new ReviewEvidenceUnavailable("review_execution_binding");

	const path = join(stageDir, "review.json");

	if (!existsSync(path)) {
		if (readdirSync(stageDir).some((name) => name !== "execution.json"))
			throw new ReviewEvidenceUnavailable("review_execution_binding");

		let owner = "";
		let repairDiff: string | null = null;
		let previousFindings: ReturnType<typeof reviewFeedback> = [];

		if (round > 0) {
			const book = (await files.listClaims()).find(
				(claim) => claim.runId === runId,
			)?.handoff;

			if (book?.kind !== "selected")
				throw new ReviewEvidenceUnavailable("repair_book_missing");

			const build = book.accounts.find(
				(a) => a.execution.stage === "build" && a.execution.round === round,
			)?.execution;

			if (build?.stage === "build" && build.cause.kind === "feedback") {
				const batch = readFeedbackBatch(
					config.stateDir,
					runId,
					build.cause.batch,
				);

				if (batch === null)
					throw new ReviewEvidenceUnavailable("feedback_batch_missing");

				owner = renderFeedbackCards(batch.batch.cards);
			}

			const from = build?.stage === "build" ? build.feedbackFrom : null;

			const prior = [...book.history, book.current].find(
				(g) => g.intent.digest === from?.digest,
			);

			if (
				prior?.review !== undefined ||
				(prior?.certification !== null && prior?.certification !== undefined)
			)
				previousFindings = reviewFeedback(
					prior.review ?? prior.certification!.review,
				);

			const previous = readRunPatch(config.stateDir, runId, round - 1);

			if (previous.kind !== "found")
				throw new ReviewEvidenceUnavailable("repair_patch_missing");

			const before = `${workspace}-before`;
			rmSync(before, { recursive: true, force: true });

			try {
				await prepareRepairTree(
					base,
					before,
					previous.patch,
					previous.receipt.changedPaths,
					"{}",
				);
				rmSync(join(before, ".factory-feedback.json"));

				const delta = await collectPatch({
					base: before,
					workspace,
					allowNoChange: true,
					repairTree: true,
				});

				if (delta.kind !== "collected")
					throw new ReviewEvidenceUnavailable("repair_diff_missing");

				repairDiff = Buffer.from(delta.patch).toString("utf8");
			} finally {
				rmSync(before, { recursive: true, force: true });
			}
		}

		const prompt = candidateReviewPrompt({
			owner,
			repairDiff,
			previousFindings,
			contract: bound.contract,
			diff: patch.patch,
			paths: patch.receipt.changedPaths,
			judges: suite.suite.scenarios.filter((s) =>
				verdict.unjudged.includes(s.id),
			),
			guidance: workflow.guidance.stages.review ?? "",
			verdict,
		});

		if (prompt.kind === "refused") return prompt;

		const captured = reviewInputRecord({ ...expected, prompt: prompt.prompt });

		if (
			!publishFile(
				path,
				JSON.stringify({
					version: 3,
					execution,
					input: captured,
					inputDigest: digestOf(JSON.stringify(captured)),
				}),
			)
		)
			throw new ReviewEvidenceUnavailable("review_manifest_unwritable");
	}

	return {
		workspace,
		verdict,
		builder: patch.receipt.model,
		families: {
			builder: await builderFamily(
				config.stateDir,
				runId,
				round,
				patch.receipt.model,
			),
			accept: suite.receipt.family ?? FAMILY_MISSING,
		},
		input: readCapturedReview(stageDir, execution, expected),
	};
}

export async function runReview(
	input: StageLaunchInput,
	dir: string,
	createHost: (dir: string, tools: readonly string[]) => StageHost,
	decorate: (prompt: string, seat: string) => Promise<string | null> = async (
		prompt,
	) => prompt,
): Promise<StageResult> {
	const prepared = input.review;

	if (prepared === undefined) throw new Error("review_missing");
	mkdirSync(dir, { recursive: true, mode: 0o700 });

	const execution = input.execution;

	if (
		execution?.stage !== "review" ||
		execution.runId !== input.runId ||
		execution.attempt !== input.attempt ||
		execution.round !== input.round
	)
		throw new ReviewEvidenceUnavailable("review_execution_binding");

	const captured = readCapturedReview(dir, execution, prepared.input);

	if (
		JSON.stringify(reviewInputRecord(captured)) !==
		JSON.stringify(reviewInputRecord(prepared.input))
	)
		throw new ReviewEvidenceUnavailable("review_execution_binding");
	const window = await executionWindow(dir, input);
	const previous = (await executionSpent(dir)) ?? 0;
	const receipts: SeatReceipt[] = [];
	const records: Awaited<ReturnType<typeof readStageReceipt>>[] = [];

	let total = 0,
		turns = 0,
		wallMs = 0;

	const byModel: Record<string, number> = {};

	let parent = 0,
		children = 0;

	let lastHost: StageHost | null = null;

	const finish = async (outcome: SessionOutcome): Promise<StageResult> => {
		const text = JSON.stringify(receipts);

		const kept =
			outcome.kind === "passed" &&
			(existsSync(join(dir, "output.txt")) ||
				publishFile(join(dir, "output.txt"), text));

		const first = records.find((r) => r !== null);

		const receipt: StageReceipt = {
			version: 1,
			runId: input.runId,
			stage: "review",
			attempt: input.attempt,
			outcome: outcome.kind === "passed" && !kept ? CRASHED : outcome,
			settlement: { event: "agent_settled", aborted: null },
			models: { requested: input.settings.model, observed: null },
			fallback: null,
			refusal: null,
			usage: {
				total,
				parent,
				children,
				byModel,
				gateway: total,
				unreadChildren: 0,
			},
			turns,
			wallMs,
			efficiency: aggregateEfficiency(
				records.map(
					(r) =>
						parseEfficiency(fieldOf(r?.record ?? null, "efficiency")) ??
						unknownEfficiency(),
				),
			),
			egress: null,
			stderr: [],
			output: kept
				? {
						file: "output.txt",
						bytes: Buffer.byteLength(text),
						kept: Buffer.byteLength(text),
					}
				: null,
			assetsDigest:
				lastHost?.assetsDigest ??
				textOf(fieldOf(first?.record ?? null, "assetsDigest")) ??
				"",
			versions: lastHost?.versions ?? PINNED_VERSIONS,
			pricing: "unavailable",
		};

		const written =
			replaceUsage(join(dir, "usage.json"), {
				...window,
				turns,
				usage: receipt.usage,
			}) && publishFile(join(dir, "receipt.json"), JSON.stringify(receipt));

		return {
			...stageResult(written ? receipt : { ...receipt, outcome: CRASHED }),
			usage: Math.max(0, total - previous),
		};
	};

	for (const seat of prepared.input.seats) {
		const sessionDir = join(dir, seat);
		let record = await readStageReceipt(join(sessionDir, "receipt.json"));

		if (record === null) {
			if (existsSync(sessionDir)) {
				records.push(null);
				total += (await executionSpent(sessionDir)) ?? 0;

				return finish(CRASHED);
			}

			const host = createHost(sessionDir, input.tools);
			lastHost = host;

			const prompt = await decorate(seatPrompt(prepared.input, seat), seat);

			if (prompt === null) return finish(CRASHED);

			const maxTokens =
				input.settings.maxTokens === null
					? null
					: Math.max(0, input.settings.maxTokens + previous - total);

			const result = await runStage(
				{
					...input,
					prompt,
					source: { bytes: 0, omissions: 0, capHit: false },
					settings: {
						...input.settings,
						model:
							seat === "code-review"
								? (input.settings.codeReviewModel ?? input.settings.model)
								: input.settings.model,
						fallback:
							seat === "security-review" ? input.settings.fallback : null,
						maxTokens,
						budget: {
							...input.settings.budget,
							maxTurns: Math.max(0, input.settings.budget.maxTurns - turns),
							wallMs: Math.max(
								0,
								Math.min(
									window.deadline - Date.now(),
									input.settings.budget.wallMs - wallMs,
								),
							),
						},
					},
					remainingRunTokens: Math.max(
						0,
						input.remainingRunTokens - (total - previous),
					),
					progress: (value) =>
						input.progress(Math.max(0, total - previous) + value),
				},
				host,
			);

			record = await readStageReceipt(join(sessionDir, "receipt.json"));

			if (record === null) {
				total += result.usage;

				return finish(CRASHED);
			}
		}

		records.push(record);
		total += record.usage.total;
		parent += record.usage.parent;
		children += record.usage.children;
		turns += record.turns;
		wallMs += record.wallMs;

		for (const [model, tokens] of Object.entries(record.usage.byModel))
			byModel[model] = (byModel[model] ?? 0) + tokens;

		if (record.outcome.kind !== "passed") return finish(record.outcome);

		const parsed = parseSeat(
			(await boundedText(join(sessionDir, "output.txt"), OUTPUT_MAX_BYTES)) ??
				"",
			seat,
			prepared.input.files,
			prepared.input.scenarios,
		);

		if (parsed === null) return finish({ kind: "failed", exit: "malformed" });
		const models = objectOf(fieldOf(record.record, "models"));
		const fallback = objectOf(fieldOf(record.record, "fallback"));

		const requested =
			textOf(fieldOf(fallback, "requested")) ??
			textOf(fieldOf(models, "requested")) ??
			input.settings.model;

		const family =
			parseFamily(fieldOf(record.record, "family")) ?? FAMILY_MISSING;

		receipts.push({
			...parsed,
			family,
			requested,
			observed:
				textOf(fieldOf(fallback, "observed")) ??
				textOf(fieldOf(models, "observed")),
			label: familyLabel(family, prepared.families?.builder ?? FAMILY_MISSING),
			primary: textOf(fieldOf(models, "requested")) ?? input.settings.model,
			refusal: textOf(fieldOf(record.record, "refusal")),
			fallbackRecord: fallback,
			fallback: fallback !== null,
			tokens: record.usage.total,
		});
	}

	return finish({ kind: "passed" });
}

export type SandboxExecutorConfig = {
	readonly stateDir: string;
	readonly exec: Exec;
	readonly log: Log;
	readonly xdgRuntimeDir: string;
	readonly root?: string;
	/** The checkout whose inputs the installed bundle must match. Absent skips the check. */
	readonly sourceRoot?: string;
	readonly arch?: string;
	readonly usernsLimit?: () => Promise<string>;
	readonly fetchTarball?: TarballFetch;
	readonly visibleTests?: typeof runVisibleTests;
	readonly host?: typeof sandboxHost;
};

const PREFLIGHT_RUN =
	"0000000000000000000000000000000000000000000000000000000000000000";

/**
 * The stage executor the controller installs. It stops leftover stage
 * scopes at startup, runs the preflight until it passes, and launches each
 * stage in a fresh sandbox, or specify's bounded session sequence. Until the preflight has
 * passed, every launch is `sandbox_unavailable` and no model runs. A
 * reconcile that failed fails the preflight, which retries it: no stage of
 * this process can be running yet, so a retry stops only leftovers.
 */
export function sandboxExecutor(config: SandboxExecutorConfig): StageExecutor {
	const root = config.root ?? SANDBOX_ROOT;

	const baseChecker = controllerBaseChecker({
		stateDir: config.stateDir,
		fetch: config.fetchTarball,
	});

	const diagnosis = controllerDiagnosis({
		stateDir: config.stateDir,
		fetch: config.fetchTarball,
	});

	let ready: { readonly bundle: Bundle; readonly arch: SeccompArch } | null =
		null;

	let reported: string | null = null;
	let reconciled = false;

	const reconcile = async (always: boolean): Promise<boolean> => {
		const result = await reconcileScopes(config.stateDir, config.exec);

		reconciled = result.failed.length === 0;

		if (!always && !reconciled) return false;

		for (const unit of result.unowned) config.log("scope_unowned", { unit });

		config.log("sandbox_reconciled", {
			stopped: result.stopped.length,
			failed: result.failed.length,
			unowned: result.unowned.length,
		});

		return reconciled;
	};

	const gatewayReady = async (): Promise<boolean> => {
		const nonce = randomBytes(4).toString("hex");
		const dir = join(config.stateDir, "gw");
		const audit = join(dir, `preflight-${nonce}.jsonl`);

		mkdirSync(dir, { recursive: true, mode: 0o700 });

		const started = await startGatewayProcess({
			gatewayDir: join(dir, `p-${nonce}`),
			auditPath: audit,
			table: builtinTable({
				stage: "specify",
				runId: PREFLIGHT_RUN,
				attempt: 1,
				model: "preflight",
				fallback: null,
				modelTokens: 0,
				modelRequests: 0,
			}),
			readyTimeoutMs: 10_000,
		});

		if (started.ok) await started.handle.shutdown();

		await rm(join(dir, `p-${nonce}`), { recursive: true, force: true });
		await rm(audit, { force: true });

		return started.ok;
	};

	return {
		baseCheck: baseChecker.check,
		async stopBase(runId) {
			await baseChecker.stop(runId);
			await diagnosis.stop(runId);
		},
		candidate: controllerCandidatePort({
			stateDir: config.stateDir,
			exec: config.exec,
		}),
		validate: controllerValidator({
			stateDir: config.stateDir,
			exec: config.exec,
			fetch: config.fetchTarball,
			diagnosis,
		}),
		async readFeedback(runId, digest) {
			return readFeedbackBatch(config.stateDir, runId, digest)?.batch ?? null;
		},

		async readAssessment({ runId, round, generation }) {
			return readStoredAssessment(
				validationDir(config.stateDir, runId, round, generation),
			);
		},
		cleanupValidation: () =>
			sweepValidation({
				stateDir: config.stateDir,
				exec: config.exec,
				fetch: config.fetchTarball,
			}),
		async recover() {
			await reconcile(true);
		},

		async reconciled() {
			return reconciled || reconcile(false);
		},

		async spent({ runId, stage, attempt, round, execution }) {
			if (execution !== undefined) {
				try {
					const intent = regularText(
						join(
							config.stateDir,
							"stages",
							runId,
							stageName(stage, attempt, round),
							"execution.json",
						),
					);

					if (intent !== `${JSON.stringify(execution)}\n`) return null;
				} catch {
					return null;
				}
			}

			return attemptSpent(config.stateDir, runId, stage, attempt, round);
		},

		prepareReview: (input) => prepareCandidateReview(config, input),

		async output(input) {
			const { runId, stage, attempt, round = 0 } = input;

			if (stage === "build") {
				const outcomePath = join(
					config.stateDir,
					"stages",
					runId,
					`${stageName(stage, attempt, round)}-result.json`,
				);

				if (existsSync(outcomePath)) {
					const reason = textOf(
						fieldOf(objectOf(parseJson(regularText(outcomePath))), "reason"),
					);

					return {
						kind: "build",
						result: {
							kind: "blocked",
							reason:
								reason === "repair_no_change" || reason === "patch_missing"
									? reason
									: "patch_invalid",
						},
					};
				}

				let kept = readRunPatch(config.stateDir, runId, round);

				if (round > 0 && kept.kind === "found") {
					const previous = readRunPatch(config.stateDir, runId, round - 1);

					if (
						previous.kind !== "found" ||
						kept.receipt.patchDigest === previous.receipt.patchDigest
					)
						return {
							kind: "build",
							result: {
								kind: "blocked",
								reason:
									previous.kind === "found"
										? "repair_no_change"
										: "patch_missing",
							},
						};
				}

				if (
					kept.kind === "found" &&
					(kept.receipt.visibleTests !== null ||
						kept.receipt.policy === "forbidden")
				)
					cleanupBuildBase(config.stateDir, runId);

				if (
					kept.kind === "found" &&
					kept.receipt.policy === "clean" &&
					kept.receipt.visibleTests === null
				) {
					if (ready === null) return { kind: "pending" };
					const base = join(config.stateDir, "pristine", runId);

					if (
						!existsSync(base) ||
						!existsSync(
							join(config.stateDir, "build-base", "checkouts", `${runId}.json`),
						)
					) {
						const bound = await fileRunFiles(config.stateDir).readContract(
							runId,
						);

						if (bound.kind !== "found")
							return {
								kind: "build",
								result: { kind: "blocked", reason: "patch_invalid" },
							};
						mkdirSync(base, { recursive: true, mode: 0o700 });

						const checked = await checkoutWorkspace({
							stateDir: join(config.stateDir, "build-base"),
							workspace: base,
							runId,
							repo: bound.contract.base.repo,
							sha: bound.contract.base.sha,
							fetch: config.fetchTarball ?? ghTarball,
						});

						if (checked.kind !== "ready") {
							cleanupBuildBase(config.stateDir, runId);
							const candidate = kept.receipt.candidateTests;

							if (candidate !== undefined)
								return {
									kind: "build",
									result: finishPatch(
										config.stateDir,
										patchBinding(kept.receipt),
										{
											...candidate,
											base: {
												command: candidate.command,
												exitCode: null,
												reason: "visible_tests_unavailable",
												tail: "Visible base could not be prepared",
												wallMs: 0,
											},
										},
									),
								};

							return {
								kind: "build",
								result: {
									kind: "unavailable",
									reason: "visible_tests_unavailable",
								},
							};
						}
					}

					const contract = await fileRunFiles(config.stateDir).readContract(
						runId,
					);

					const testConfig: SandboxHostConfig = {
						stateDir: config.stateDir,
						bundleDir: ready.bundle.dir,
						workspace: "",
						runId,
						stage: "build",
						attempt,
						tools: [],
						arch: ready.arch,
						xdgRuntimeDir: config.xdgRuntimeDir,
						assetsDigest: ready.bundle.digest,
						versions: PINNED_VERSIONS,
						exec: config.exec,
					};

					const runTests = config.visibleTests ?? runVisibleTests;
					const binding = patchBinding(kept.receipt);

					let tests: VisibleTests =
						kept.receipt.candidateTests ??
						(await runTests(
							testConfig,
							base,
							kept.patch,
							kept.receipt.testCommand,
							contract.kind === "found" &&
								contract.digest === kept.receipt.contractDigest
								? (contract.contract.replacesTests ?? [])
								: [],
						));

					if (tests.exitCode !== null && tests.exitCode !== 0) {
						const checkpoint = finishPatch(
							config.stateDir,
							binding,
							tests,
							"candidate",
						);

						if (checkpoint.kind !== "found")
							return { kind: "build", result: checkpoint };
						tests = {
							...tests,
							base: await runTests(
								testConfig,
								base,
								"",
								kept.receipt.testCommand,
							),
						};
					}

					kept = finishPatch(
						config.stateDir,
						patchBinding(kept.receipt),
						tests,
					);

					if (kept.kind === "unavailable")
						config.log("visible_tests_unavailable", {
							runId,
							why: tests.detail ?? "sandbox_unavailable",
						});
					cleanupBuildBase(config.stateDir, runId);
				}

				return kept.kind === "absent" ? null : { kind: "build", result: kept };
			}

			if (stage === "review") {
				const execution = input.execution;

				if (execution !== undefined && execution.stage !== "review")
					return null;

				const prepared = await prepareCandidateReview(config, {
					runId,
					round,
					execution,
					workflowSha: input.workflowSha,
					workflowDigest: input.workflowDigest,
					workspace: join(
						config.stateDir,
						"review-tree",
						`${roundKey(runId, round)}-a${attempt}`,
					),
				});

				if ("kind" in prepared) return prepared;

				const output = await attemptOutput(
					config.stateDir,
					runId,
					stage,
					attempt,
					round,
				);

				if (
					output === null ||
					(output instanceof Object && output.kind === "pending")
				)
					return output;

				try {
					const text =
						output instanceof Object
							? output.kind === "output"
								? output.text
								: ""
							: output;

					// SAFETY: output is the host-authored aggregate; reviewCandidate revalidates each seat's schema and exact binding.
					const seats = JSON.parse(text) as SeatReceipt[];

					const receipt = reviewCandidate(
						prepared.input,
						prepared.verdict,
						seats,
						prepared.families ?? {
							builder: FAMILY_MISSING,
							accept: FAMILY_MISSING,
						},
					);

					keepReview(config.stateDir, receipt);

					return { kind: "review", receipt };
				} catch {
					return null;
				}
			}

			return attemptOutput(config.stateDir, runId, stage, attempt, round);
		},

		async checkout({
			runId,
			repo,
			sha,
			workspace,
			build,
			round = 0,
			feedbackFrom,
			cause,
		}) {
			const checked = await (build
				? checkoutBuildWorkspace
				: checkoutWorkspace)({
				stateDir: config.stateDir,
				runId,
				workspace,
				repo,
				sha,
				fetch: config.fetchTarball ?? ghTarball,
				log: config.log,
			});

			if (build && round > 0 && checked.kind === "ready") {
				try {
					const previous = readRunPatch(config.stateDir, runId, round - 1);

					if (previous.kind !== "found")
						return { kind: "refused", reason: "repair_patch_missing" };

					const dir = validationDir(
						config.stateDir,
						runId,
						feedbackFrom?.round ?? round - 1,
						feedbackFrom?.generation,
					);

					const assessed = readStoredAssessment(dir);
					const feedbackPath = join(dir, "feedback.json");

					if (
						assessed === null ||
						cause === undefined ||
						assessed.binding.runId !== runId ||
						assessed.binding.round !== (feedbackFrom?.round ?? round - 1) ||
						assessed.binding.generation !== (feedbackFrom?.generation ?? 0) ||
						assessed.ref.bindingDigest !== cause.assessment.bindingDigest ||
						assessed.ref.recordDigest !== cause.assessment.recordDigest
					)
						throw new Error("assessment_missing");
					let validation: ReturnType<typeof readFeedbackBytes> = null;

					if (assessed.assessment.kind === "passed") {
						if (
							existsSync(feedbackPath) ||
							(cause.kind !== "review" && cause.kind !== "feedback")
						)
							throw new Error("feedback_unexpected");
						validation = [];
					} else if (
						assessed.assessment.failure.kind === "candidate" &&
						(cause.kind === "validation" || cause.kind === "feedback")
					)
						validation = readFeedbackBytes(
							regularText(feedbackPath),
							assessed.ref,
						);

					if (validation === null) throw new Error("feedback_provenance");

					const reviewPath = join(
						reviewDir(
							config.stateDir,
							runId,
							feedbackFrom?.round ?? round - 1,
							feedbackFrom?.generation,
						),
						"receipt.json",
					);

					const stored = existsSync(reviewPath)
						? parseReviewReceipt(parseJson(regularText(reviewPath)))
						: undefined;

					if (stored === null) throw new Error("review_receipt_invalid");

					if (
						(cause.kind === "review" ||
							(cause.kind === "feedback" && cause.review !== null)) &&
						(stored === undefined ||
							reviewReceiptDigest(stored) !== cause.review ||
							stored.runId !== runId ||
							stored.round !== (feedbackFrom?.round ?? round - 1) ||
							(stored.execution?.generation ?? 0) !==
								(feedbackFrom?.generation ?? 0) ||
							!stored.blocking ||
							!blocksReview(stored.seats))
					)
						throw new Error("review_receipt_mismatch");

					const review = stored === undefined ? [] : reviewFeedback(stored);

					if (cause.kind === "review" && review.length === 0)
						throw new Error("review_feedback_empty");

					const owner =
						cause.kind === "feedback"
							? readFeedbackBatch(config.stateDir, runId, cause.batch)
							: null;

					if (
						cause.kind === "feedback" &&
						(owner === null ||
							!owner.batch.records.some((r) => r.intake.kind === "actionable"))
					)
						throw new Error("feedback_batch_missing");

					const content = { version: 1, round, validation, review };

					const feedback = JSON.stringify(
						owner === null
							? content
							: {
									...content,
									version: 2,
									review: review.map((f) => ({
										...f,
										fingerprint: findingFingerprint(
											f.seat,
											f.category,
											"path" in f ? f.path : f.scenario,
											f.claim,
										),
									})),
									owner: owner.batch.cards,
									truncated: owner.batch.cards.some((c) => c.truncated),
									full: owner.batch.full,
								},
					);

					rmSync(workspace, { recursive: true, force: true });
					await prepareRepairTree(
						join(config.stateDir, "pristine", runId),
						workspace,
						previous.patch,
						previous.receipt.changedPaths,
						feedback,
					);

					if (owner?.full != null)
						writeFileSync(
							join(workspace, ".factory-feedback-full.json"),
							owner.full,
							{ flag: "wx", mode: 0o600 },
						);

					const paths = [
						...new Set([
							...checked.checkout.files,
							...previous.receipt.changedPaths,
						]),
					].filter((path) => {
						try {
							return lstatSync(join(workspace, path)).isFile();
						} catch {
							return false;
						}
					});

					return { ...checked, checkout: checkoutOf(workspace, paths) };
				} catch {
					return { kind: "refused", reason: "repair_inputs_invalid" };
				}
			}

			return checked;
		},

		async preflight() {
			if (ready !== null) return true;

			const bundle = await locateBundle(root);

			const result = await runPreflight({
				reconciled: async () => reconciled || reconcile(false),
				arch: config.arch ?? process.arch,
				usernsLimit: config.usernsLimit ?? readUsernsLimit,
				exec: config.exec,
				assetsDigest: async () =>
					bundle === null ? null : manifestDigest(bundle.dir),
				expectedDigest: bundle?.digest ?? "",
				bundleCurrent:
					config.sourceRoot === undefined || bundle === null
						? undefined
						: () => bundleMatchesSource(config.sourceRoot ?? "", bundle.dir),
				gatewayReady,
			});

			const summary = result.ok ? "ok" : result.failed.join("+");

			if (summary !== reported) {
				reported = summary;
				config.log("sandbox_preflight", {
					ok: result.ok,
					failed: result.ok ? "none" : summary,
					assets: bundle?.digest.slice(0, 12) ?? "none",
				});
			}

			if (result.ok && bundle !== null) ready = { bundle, arch: result.arch };

			return ready !== null;
		},

		async launch(input: StageLaunchInput): Promise<StageLaunch> {
			if (ready === null) {
				return {
					kind: "unavailable",
					stage: input.stage,
					reason: "sandbox_unavailable",
				};
			}

			const { bundle, arch } = ready;

			const repair =
				input.stage === "build" && (input.round ?? 0) > 0
					? feedbackPrompt(
							regularText(join(input.workspace, ".factory-feedback.json")),
						)
					: "";

			const prompt = await withSkills(
				bundle.dir,
				`${input.prompt}\n${repair}`,
				input.skills,
			);

			if (prompt === null) {
				config.log("skills_unavailable", {
					runId: input.runId,
					stage: input.stage,
				});

				return {
					kind: "unavailable",
					stage: input.stage,
					reason: "sandbox_unavailable",
				};
			}

			const hostConfig: SandboxHostConfig = {
				stateDir: config.stateDir,
				bundleDir: bundle.dir,
				workspace: input.workspace,
				runId: input.runId,
				stage: input.stage,
				attempt: input.attempt,
				tools: input.tools,
				acceptEffort: input.acceptEffort,
				arch,
				xdgRuntimeDir: config.xdgRuntimeDir,
				assetsDigest: bundle.digest,
				versions: PINNED_VERSIONS,
				exec: config.exec,
			};

			if (input.stage === "specify" && input.specify !== undefined) {
				const stages = join(config.stateDir, "stages", input.runId);
				const base = `${input.stage}-${input.attempt}`;

				mkdirSync(stages, { recursive: true, mode: 0o700 });

				const saved = readdirSync(stages)
					.filter(
						(name) =>
							(name === base ||
								(name.startsWith(`${base}.`) &&
									/^\d+$/.test(name.slice(base.length + 1)))) &&
							existsSync(join(stages, name, "specify.json")),
					)
					.sort(
						(a, b) =>
							Number(b.slice(base.length + 1) || "1") -
							Number(a.slice(base.length + 1) || "1"),
					)[0];

				const dir =
					saved === undefined
						? freshDir(join(stages, base))
						: join(stages, saved);

				return {
					kind: "started",
					done: runSpecify({ ...input, prompt }, dir, (stageDir, tools) =>
						sandboxHost({ ...hostConfig, stageDir, tools }),
					),
				};
			}

			if (input.stage === "review" && input.review !== undefined) {
				const stages = join(config.stateDir, "stages", input.runId);

				const dir = join(
					stages,
					stageName(input.stage, input.attempt, input.round),
				);

				return {
					kind: "started",
					done: runReview(
						input,
						dir,
						(stageDir, tools) =>
							(config.host ?? sandboxHost)({ ...hostConfig, stageDir, tools }),
						(prompt, seat) => withSkills(bundle.dir, prompt, [seat]),
					),
				};
			}

			const stageDir = freshDir(
				join(
					config.stateDir,
					"stages",
					input.runId,
					stageName(input.stage, input.attempt, input.round),
				),
			);

			const draftCheck =
				input.stage === "accept" && input.acceptDraft !== undefined
					? controllerDraftChecker({
							stateDir: config.stateDir,
							stageDir,
							attempt: input.attempt,
							input: input.acceptDraft,
							fetch: config.fetchTarball,
						})
					: undefined;

			const done = runStage(
				{
					runId: input.runId,
					stage: input.stage,
					attempt: input.attempt,
					prompt,
					source: input.source,
					draftCheck,
					settings: input.settings,
					remainingRunTokens: input.remainingRunTokens,
					signal: input.signal,
					progress: input.progress,
				},
				(config.host ?? sandboxHost)({
					...hostConfig,
					stageDir,
				}),
			);

			return {
				kind: "started",
				done: done
					.then(async (result) => {
						if (
							input.stage !== "build" ||
							input.build === undefined ||
							result.kind !== "passed"
						)
							return result;
						const binding = input.build.binding;
						const base = join(config.stateDir, "pristine", input.runId);

						if (
							checkBuildDisk([
								input.workspace,
								join(config.stateDir, "stages", input.runId),
							]) !== null
						) {
							config.log("stage_inputs_refused", {
								runId: input.runId,
								why: "build_disk_limit",
							});
							publishFile(
								join(
									config.stateDir,
									"stages",
									input.runId,
									`build-${input.attempt}-failure.json`,
								),
								JSON.stringify({ reason: "build_disk_limit" }),
							);

							return stageResult({
								...result.receipt,
								outcome: { kind: "failed", exit: "crashed" },
							});
						}

						let kept = readPatch(config.stateDir, binding);

						if (kept.kind === "absent") {
							const collectionStart = Date.now();

							const cause =
								input.execution?.stage === "build"
									? input.execution.cause
									: null;

							const owner =
								cause?.kind === "feedback"
									? readFeedbackBatch(config.stateDir, input.runId, cause.batch)
									: null;

							const text = await attemptOutput(
								config.stateDir,
								input.runId,
								"build",
								input.attempt,
								input.round,
							);

							const dispositions =
								owner === null
									? undefined
									: builderDispositions(
											text === null || text instanceof Object ? "" : text,
											owner.batch.cards,
										);

							let findingDispositions:
								| ReturnType<typeof builderFindingDispositions>
								| undefined;

							if (owner !== null && input.execution?.stage === "build") {
								const from = input.execution.feedbackFrom;

								const path = join(
									reviewDir(
										config.stateDir,
										input.runId,
										from.round,
										from.generation,
									),
									"receipt.json",
								);

								const review = existsSync(path)
									? parseReviewReceipt(parseJson(regularText(path)))
									: null;

								findingDispositions = builderFindingDispositions(
									text === null || text instanceof Object ? "" : text,
									findingFingerprints(review ?? { seats: [] }),
								);
							}

							if ((input.round ?? 0) > 0) {
								rmSync(join(input.workspace, ".factory-feedback.json"), {
									force: true,
								});
								rmSync(join(input.workspace, ".factory-feedback-full.json"), {
									force: true,
								});
							}

							const patch = await collectPatch({
								base,
								workspace: input.workspace,
								allowNoChange: input.build.allowNoChange,
								repairTree: (input.round ?? 0) > 0,
							});

							if (patch.kind === "error") {
								config.log("patch_refused", {
									runId: input.runId,
									why: patch.reason,
								});

								return stageResult({
									...result.receipt,
									outcome: { kind: "failed", exit: "crashed" },
								});
							}

							config.log("patch_collected", {
								runId: input.runId,
								digest: patch.patchDigest,
								ms: Date.now() - collectionStart,
								paths: patch.changedPaths.length,
							});

							const commands = buildCommands(
								config.stateDir,
								input.runId,
								input.attempt,
								input.round,
							);

							if ((input.round ?? 0) > 0) {
								const previous = readRunPatch(
									config.stateDir,
									input.runId,
									input.round! - 1,
								);

								const reason =
									previous.kind !== "found"
										? "patch_missing"
										: previous.receipt.patchDigest === patch.patchDigest
											? "repair_no_change"
											: null;

								if (reason !== null) {
									const saved = publishFile(
										join(
											config.stateDir,
											"stages",
											input.runId,
											`${stageName("build", input.attempt, input.round)}-result.json`,
										),
										JSON.stringify({ reason }),
									);

									return saved
										? result
										: stageResult({
												...result.receipt,
												outcome: { kind: "failed", exit: "crashed" },
											});
								}
							}

							kept = storePatch(config.stateDir, binding, patch, {
								model:
									result.receipt.fallback?.requested ??
									result.receipt.models.requested,
								observed:
									result.receipt.fallback?.observed ??
									result.receipt.models.observed,
								commands,
								dispositions,
								findingDispositions,
								testCommand: baseTestCommand(base, input.build.command),
							});

							if (kept.kind === "blocked")
								config.log("patch_refused", {
									runId: input.runId,
									why: kept.reason,
								});
						}

						return result;
					})
					.finally(() => {
						if (input.stage !== "build") return;
						rmSync(input.workspace, { recursive: true, force: true });
						cleanupBuildAgents(
							config.stateDir,
							input.runId,
							input.attempt,
							input.round,
						);

						const kept = readRunPatch(
							config.stateDir,
							input.runId,
							input.round,
						);

						if (kept.kind !== "found" || kept.receipt.policy === "forbidden")
							cleanupBuildBase(config.stateDir, input.runId);
					}),
			};
		},
	};
}
