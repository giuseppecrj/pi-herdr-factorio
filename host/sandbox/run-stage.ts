import { randomBytes } from "node:crypto";
import {
	type DraftFeedback,
	draftNeedsRevision,
} from "../../src/candidate/diagnosis.ts";
import type { ModelId } from "../../src/config/schema.ts";
import { draftFeedbackPrompt } from "../../src/contract/acceptance.ts";
import {
	type BudgetCap,
	type EfficiencyFacts,
	type ExecutionUsage,
	type FailedExit,
	type RefusalSignal,
	type SessionOutcome,
	type Settlement,
	type StageRunSettings,
	type StageUsage,
	executionUsageOf,
	requestEfficiency,
	unknownEfficiency,
} from "../../src/core/execution.ts";
import { requestSettlements, settlementReply } from "../../src/core/journal.ts";
import type { JsonValue } from "../../src/core/json.ts";
import {
	type FamilyInput,
	familyFromJournal,
	withFamily,
} from "../../src/core/models.ts";
import { type Digest, digestOf } from "../../src/core/run.ts";
import type { ExecutionStage as ModelStage } from "../../src/core/stages.ts";
import type { PlatformNetwork } from "../../src/trust/platform.ts";
import type { GatewayHandle } from "../gateway/client.ts";
import type {
	CloseReason,
	ControlEvent,
	SummaryEvent,
} from "../gateway/control.ts";
import {
	type RouteId,
	type RouteTable,
	builtinTable,
} from "../gateway/routes.ts";
import { LineSplitter } from "./lines.ts";
import { OUTPUT_MAX_BYTES } from "./receipts.ts";
import {
	type ChildRunSummary,
	type FallbackRecord,
	type OutputRecord,
	type PinnedVersions,
	type StageReceipt,
	type StageResult,
	type StderrRecord,
	stageResult,
} from "./result.ts";
import { type PiProcess, parsePiRecord, sendCommand } from "./rpc.ts";
import {
	type AcceptCalls,
	type ChildUsage,
	modelKey,
	SessionTracker,
	settledOutcome,
} from "./settle.ts";

export const MODEL_REQUEST_CEILING = 2_000;

const ACCEPT_REQUEST_CEILING = 5;

export const DRAFT_MAX_RUNS = 2;

export const DRAFT_RESERVE_TOKENS = 35_000;

export const DRAFT_RESERVE_MS = 180_000;

type AcceptDiagnostic =
	| "accept_tool_limit"
	| "accept_request_limit"
	| "accept_length";

const PROMPT_ID = "factory-prompt";

const OUTPUT_ID = "factory-output";

const OUTPUT_WAIT_MS = 5_000;

const ABORT_WAIT_MS = 5_000;

export const EXIT_WAIT_MS = 2_000;

export type DraftCheckContext = Readonly<{
	signal: AbortSignal;
	deadline: number;
	run: 1 | 2;
}>;

export type StageRunInput = {
	readonly runId: Digest;
	readonly measurementIdentity?: string;
	readonly stage: ModelStage;
	readonly attempt: number;
	readonly prompt: string;
	readonly source?: import("../../src/contract/contract.ts").SourceFacts;
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
	/** The platform whose built-in routes the stage's table holds. */
	readonly platform: PlatformNetwork;
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

export class Ledger {
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
	readonly childSummaries: ChildRunSummary[] = [];

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

export function waitFor(
	promise: Promise<unknown>,
	ms: number,
): Promise<boolean> {
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

export const CRASHED: SessionOutcome = { kind: "failed", exit: "crashed" };

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
				ledger.childSummaries.push({
					id: digestOf(
						JSON.stringify([
							input.runId,
							input.stage,
							input.attempt,
							session,
							sessionFile,
						]),
					),
					tokens: usage.total,
					byModel: Object.fromEntries(usage.byModel),
				});
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

	const retainCappedMaintain =
		input.stage === "maintain" &&
		report !== "settled" &&
		report.kind === "budget_exhausted" &&
		tracker.lastAssistant?.stopReason === "stop";

	if ((report === "settled" || retainCappedMaintain) && text === null) {
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
			text: retainCappedMaintain ? text : null,
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
			text:
				input.stage === "maintain" && last?.stopReason === "stop" ? text : null,
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
			(outcome.kind === "passed" ||
				(input.stage === "maintain" && outcome.kind === "budget_exhausted")) &&
			text !== null
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
				childSummaries: ledger.childSummaries,
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

		const owned =
			input.measurementIdentity === undefined
				? complete
				: { ...complete, measurementIdentity: input.measurementIdentity };

		const written = await host.writeReceipt(owned).catch(() => false);

		return stageResult(written ? owned : { ...owned, outcome: CRASHED });
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
			platform: host.platform,
			stage: input.stage,
			runId: input.runId,
			attempt: input.attempt,
			provider: anthropic ? "anthropic" : "openai",
			model: bareModel(input.settings.model),
			fallback: input.settings.fallback,
			modelTokens: tokenCap - ledger.total,
			modelRequests: Math.min(
				input.stage === "maintain"
					? 1
					: input.stage === "accept"
						? ACCEPT_REQUEST_CEILING
						: MODEL_REQUEST_CEILING,
				budget.maxTurns - ledger.turns,
			),
		});
	} catch {
		return receipt(plainReport(CRASHED), null, null);
	}

	if (input.stage === "maintain")
		table = {
			...table,
			routes: table.routes.filter((route) => route.id === "model-openai"),
		};

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
