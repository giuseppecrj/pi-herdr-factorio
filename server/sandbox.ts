import { randomBytes } from "node:crypto";
import {
	collectPatch,
	commandReceipts,
	baseTestCommand,
	trustedVisiblePlan,
	checkBuildDisk,
	patchBinding,
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
} from "../src/orchestrator.ts";
import { isDigest, type Digest } from "../src/run.ts";
import {
	parseSpecifyOutput,
	parseReviewOutput,
	reviewPrompt,
	revisionPrompt,
} from "../src/specify.ts";
import {
	type ModelId,
	type ModelStage,
	STAGE_CLEANUP_RESERVE_MS,
} from "../src/workflow.ts";
import {
	checkoutWorkspace,
	checkoutBuildWorkspace,
	fileRunFiles,
	ghTarball,
	type TarballFetch,
} from "./controller.ts";
import { HERDR_AGENTS, PI_AGENT_DIR } from "./sandbox/assets/pi.ts";
import { AUDIT_CAP_BYTES } from "./sandbox/audit.ts";
import {
	countOf,
	fieldOf,
	objectOf,
	parseJson,
	textOf,
} from "./sandbox/json.ts";
import { manifestDigest, PINNED_VERSIONS } from "./sandbox/manifest.ts";
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
import { stageResult } from "./sandbox/result.ts";
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

export const STDERR_CAP_BYTES = 64 * 1024;

const PROMPT_ID = "factory-prompt";

export const STAGE_SYSTEM_PROMPT =
	"You are one stage of a software factory, running in a sandbox. Follow the user message exactly, and use only the tools it allows.";

const OUTPUT_ID = "factory-output";

export const OUTPUT_MAX_BYTES = 256 * 1024;

const OUTPUT_WAIT_MS = 5_000;

const ABORT_WAIT_MS = 5_000;

const EXIT_WAIT_MS = 2_000;

export type StageRunInput = {
	readonly runId: Digest;
	readonly stage: ModelStage;
	readonly attempt: number;
	readonly prompt: string;
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
	): Promise<ChildUsage | null>;
	writeReceipt(receipt: StageReceipt): Promise<boolean>;
	writeOutput(text: string): Promise<boolean>;
	stderrLog(session: number): Promise<StderrRecord | null>;
}

/** The model id as the request body names it, without its provider prefix. */
export function bareModel(model: ModelId): string {
	return model.slice(model.indexOf("/") + 1);
}

class Ledger {
	parent = 0;
	children = 0;
	gateway = 0;
	unreadChildren = 0;
	turns = 0;
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
	readonly cleanup: CleanupWindow;
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
	);

	const reads: Promise<void>[] = [];
	let pendingReads = 0;
	let readFailed = false;
	let readsClosed = false;
	let abortSent = false;
	let settledAfterAbort: (() => void) | null = null;
	let textReply: ((text: string | null) => void) | null = null;
	let recheck = () => {};

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

				if (usage === null) {
					ledger.unreadChildren += 1;

					return;
				}

				ledger.children += usage.total;
				ledger.add(usage.byModel);
				recheck();
			},
			() => {
				if (readsClosed) return;

				pendingReads -= 1;
				ledger.unreadChildren += 1;
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
			finish(outcome);
		};

		const capped = (cap: BudgetCap) => end({ kind: "budget_exhausted", cap });

		const checkTokens = () => {
			const cap = capFor(stage);

			if (cap !== null) capped(cap);
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
			else if (event.event === "gate_closed" || event.event === "usage")
				checkTokens();
		};

		pi.stdout.on("data", (chunk: Buffer) => {
			const lines = splitter.push(chunk);

			if (lines === null) {
				end({ kind: "failed", exit: "malformed" });

				return;
			}

			for (const line of lines) {
				input.progress(ledger.total);

				const record = parsePiRecord(line);
				const signal = tracker.apply(record);

				ledger.turns = tracker.turns;

				if (record.type === "agent_settled" && abortSent) settledAfterAbort?.();

				if (record.type === "response" && record.id === OUTPUT_ID) {
					textReply?.(record.success ? record.text : null);
				}

				if (record.type === "assistant_end") {
					const tokens = record.message.usage?.totalTokens ?? 0;

					ledger.parent += tokens;
					ledger.add(
						new Map([
							[modelKey(record.message.provider, record.message.model), tokens],
						]),
					);
				}

				if (signal.kind === "child") reads.push(readChild(signal.sessionFile));

				if (finished) continue;

				if (record.type === "assistant_end") checkTokens();

				if (signal.kind === "failed") end(signal);
				else if (signal.kind === "cap") capped(signal.cap);
				else if (signal.kind === "settled") end("settled");
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

	let text: string | null = null;

	if (report === "settled") {
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
		readFailed = true;
	}

	const last = tracker.lastAssistant;
	const observed = last === null ? null : modelKey(last.provider, last.model);

	const settlement: Settlement =
		tracker.aborted === null
			? NOT_STARTED
			: { event: "agent_settled", aborted: tracker.aborted };

	if (report !== "settled") {
		return { outcome: report, refusal: null, settlement, observed, text: null };
	}

	const cap =
		(last?.stopReason === "error" && stage.gateReason !== null
			? capFor(stage)
			: null) ?? overCap(stage);

	if (
		cap !== null ||
		(last?.stopReason === "error" && stage.gateReason === "requests")
	) {
		return {
			outcome: { kind: "budget_exhausted", cap: cap ?? "turns" },
			refusal: null,
			settlement,
			observed,
			text: null,
		};
	}

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

function finalOutcome(
	primary: SessionReport,
	fallback: FallbackRecord | null,
): SessionOutcome {
	if (primary.outcome.kind !== "refused" || fallback === null)
		return primary.outcome;

	return fallback.outcome;
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
	text: "model-openai" | "model-xai",
	table: RouteTable,
): RouteId | null {
	return table.routes.find((route) => route.id === text)?.id ?? null;
}

/**
 * Runs one stage attempt in the sandbox and returns its result with a
 * host-side receipt. On a structured refusal it opens the fallback route,
 * closes the primary, and runs one fresh session on the fallback model.
 */
export async function runStage(
	input: StageRunInput,
	host: StageHost,
): Promise<StageResult> {
	const started = host.now();
	const ledger = new Ledger();
	const { maxTokens, budget } = input.settings;

	const tokenCap = Math.min(
		maxTokens ?? Number.MAX_SAFE_INTEGER,
		input.remainingRunTokens,
	);

	const sessions: number[] = [];
	let gatewayRan = false;

	const cleanup = new CleanupWindow(
		host,
		started + budget.wallMs,
		input.signal,
	);

	const receipt = async (
		primary: SessionReport,
		fallback: FallbackRecord | null,
		egress: StageReceipt["egress"],
		text: string | null = null,
	): Promise<StageResult> => {
		const outcome = finalOutcome(primary, fallback);

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

		const record: StageReceipt = {
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
		};

		const written = await host.writeReceipt(record).catch(() => false);

		return stageResult(written ? record : { ...record, outcome: CRASHED });
	};

	const early: BudgetCap | null =
		maxTokens !== null && maxTokens <= 0
			? "tokens"
			: input.remainingRunTokens <= 0
				? "run_tokens"
				: budget.wallMs <= host.cleanupReserveMs
					? "wall"
					: null;

	if (early !== null) {
		return receipt(
			plainReport({ kind: "budget_exhausted", cap: early }),
			null,
			null,
		);
	}

	const table = builtinTable({
		stage: input.stage,
		runId: input.runId,
		attempt: input.attempt,
		model: bareModel(input.settings.model),
		fallback:
			input.settings.fallback === null
				? null
				: bareModel(input.settings.fallback),
		modelTokens: tokenCap,
		modelRequests: Math.min(MODEL_REQUEST_CEILING, budget.maxTurns),
	});

	const gateway = await host.startGateway(table).catch(() => null);

	if (gateway === null) return receipt(plainReport(CRASHED), null, null);

	gatewayRan = true;

	const stage: StageRun = {
		input,
		host,
		gateway,
		ledger,
		deadline: started + budget.wallMs - host.cleanupReserveMs,
		cleanup,
		gateReason: null,
		alert: null,
		listener: null,
	};

	gateway.subscribe((event) => {
		if (event.event === "usage") {
			ledger.gateway += (event.inputTokens ?? 0) + (event.outputTokens ?? 0);

			if (event.reason === "secret-in-request") stage.alert = "error";
		}

		if (event.event === "gate_closed" && stage.gateReason === null) {
			stage.gateReason = event.reason;
		}

		input.progress(ledger.total);
		stage.listener?.(event);
	});
	gateway.exited.then(() => {
		if (stage.alert === null) stage.alert = "crashed";

		stage.listener?.({ event: "drained" });
	});

	sessions.push(0);

	const primary = await guardedSession(stage, input.settings.model, 0);
	let fallback: FallbackRecord | null = null;
	let text = primary.text;

	if (
		primary.outcome.kind === "refused" &&
		input.settings.fallback !== null &&
		stage.gateReason === null
	) {
		const openai = routeId("model-openai", table);
		const xai = routeId("model-xai", table);

		const switched =
			openai !== null &&
			xai !== null &&
			(await gateway.setRoute(openai, false).catch(() => false)) &&
			(await gateway.setRoute(xai, true).catch(() => false));

		if (switched) sessions.push(1);

		cleanup.reopen();

		const second = switched
			? await guardedSession(stage, input.settings.fallback, 1)
			: plainReport(CRASHED);

		text = second.text;
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

	return receipt(primary, fallback, summary?.routes ?? null, text);
}

export type SandboxHostConfig = {
	readonly stateDir: string;
	readonly bundleDir: string;
	readonly workspace: string;
	readonly stageDir?: string;
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

export function piCommand(model: ModelId, children = false): string[] {
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
				command: piCommand(model, config.tools.includes("subagent")),
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

			return childUsageOf(await readFile(path, "utf8"));
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
		async stderrLog(session) {
			const finish = stderr.get(session);
			const bytes = finish === undefined ? null : await finish(EXIT_WAIT_MS);

			return bytes === null
				? null
				: { session, file: `pi-stderr-${session}.log`, bytes };
		},
	};
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
): Promise<number | null> {
	const base = `${stage}-${attempt}`;
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

/**
 * Tokens one execution dir is known to have used, from host-side files
 * only: the receipt's `usage.total`, else the sum of the gateway's metered
 * tokens in `egress.jsonl`. A line cut short by a crash is skipped. `null`
 * when the dir has neither file.
 */
async function executionSpent(dir: string): Promise<number | null> {
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

	if (total !== null) return total;

	if (existsSync(join(dir, "specify.json"))) {
		const totals = await Promise.all(
			SPECIFY_SESSIONS.map((name) => executionSpent(join(dir, name))),
		);

		return totals.some((value) => value !== null)
			? totals.reduce<number>((sum, value) => sum + (value ?? 0), 0)
			: null;
	}

	const audit = await boundedText(join(dir, "egress.jsonl"), AUDIT_CAP_BYTES);

	if (audit === null) return null;

	let sum = 0;

	for (const line of audit.split("\n")) {
		const record = objectOf(parseJson(line));

		if (record === null) continue;

		sum += countOf(fieldOf(record, "inputTokens")) ?? 0;
		sum += countOf(fieldOf(record, "outputTokens")) ?? 0;
	}

	return sum;
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
};

async function keptSession(dir: string): Promise<KeptSession | null> {
	const raw = await boundedText(join(dir, "receipt.json"), MAX_RECEIPT_BYTES);
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

	const file = textOf(fieldOf(objectOf(fieldOf(record, "output")), "file"));

	return {
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
		text:
			outcome.kind === "passed" && file === "output.txt"
				? await boundedText(join(dir, file), OUTPUT_MAX_BYTES)
				: null,
	};
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

		const remainingWall = Math.max(0, input.settings.budget.wallMs - wallMs());

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

		const written =
			existsSync(join(dir, "receipt.json")) ||
			publishFile(
				join(dir, "receipt.json"),
				JSON.stringify(receipt, null, "\t"),
			);

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
): Promise<StageOutput | null> {
	const base = `${stage}-${attempt}`;
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

		if (outcome === null && existsSync(join(dir, "specify.json")))
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

			return model === null
				? null
				: {
						kind: "output",
						text,
						model,
						observed:
							textOf(fieldOf(fallback, "observed")) ??
							textOf(fieldOf(models, "observed")),
					};
		}
	}

	return null;
}

function readRunPatch(stateDir: string, runId: Digest): PatchRead {
	try {
		const record = objectOf(
			parseJson(
				readFileSync(join(stateDir, "patches", `${runId}.json`), "utf8"),
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
			runId,
			baseSha,
			contractDigest,
			acceptanceDigest,
		});
	} catch (error) {
		return error instanceof Error && "code" in error && error.code === "ENOENT"
			? existsSync(join(stateDir, "patches", runId))
				? { kind: "blocked", reason: "patch_missing" }
				: { kind: "absent" }
			: { kind: "blocked", reason: "patch_invalid" };
	}
}

function buildCommands(stateDir: string, runId: Digest, attempt: number) {
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
		if (name === `build-${attempt}` || name.startsWith(`build-${attempt}.`))
			walk(join(root, name));

	return commands;
}

export async function runVisibleTests(
	config: SandboxHostConfig,
	base: string,
	patch: string | Uint8Array,
	command: string,
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

	try {
		await patchedTree(base, workspace, patch);
		command = trustedVisiblePlan(base, workspace, command).command;

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
): void {
	const root = join(stateDir, "stages", runId);

	if (!existsSync(root)) return;

	for (const name of readdirSync(root)) {
		if (
			name !== `build-${attempt}` &&
			!new RegExp(`^build-${attempt}\\.[0-9]+$`).test(name)
		)
			continue;

		for (const agent of readdirSync(join(root, name)))
			if (/^agent-[0-9]+$/.test(agent))
				rmSync(join(root, name, agent), { recursive: true, force: true });
	}
}

function cleanupBuildBase(stateDir: string, runId: Digest): void {
	rmSync(join(stateDir, "pristine", runId), { recursive: true, force: true });
	rmSync(join(stateDir, "build-base", "checkouts", `${runId}.json`), {
		force: true,
	});
}

export type SandboxExecutorConfig = {
	readonly stateDir: string;
	readonly exec: Exec;
	readonly log: Log;
	readonly xdgRuntimeDir: string;
	readonly root?: string;
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
		async recover() {
			await reconcile(true);
		},

		async reconciled() {
			return reconciled || reconcile(false);
		},

		async spent({ runId, stage, attempt }) {
			return attemptSpent(config.stateDir, runId, stage, attempt);
		},

		async output({ runId, stage, attempt }) {
			if (stage === "build") {
				let kept = readRunPatch(config.stateDir, runId);

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

					if (!existsSync(base)) {
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

							return {
								kind: "build",
								result: {
									kind: "unavailable",
									reason: "visible_tests_unavailable",
								},
							};
						}
					}

					const tests = await (config.visibleTests ?? runVisibleTests)(
						{
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
						},
						join(config.stateDir, "pristine", runId),
						kept.patch,
						kept.receipt.testCommand,
					);

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

			return attemptOutput(config.stateDir, runId, stage, attempt);
		},

		async checkout({ runId, repo, sha, workspace, build }) {
			return (build ? checkoutBuildWorkspace : checkoutWorkspace)({
				stateDir: config.stateDir,
				runId,
				workspace,
				repo,
				sha,
				fetch: config.fetchTarball ?? ghTarball,
				log: config.log,
			});
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

			const prompt = await withSkills(bundle.dir, input.prompt, input.skills);

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

			const done = runStage(
				{
					runId: input.runId,
					stage: input.stage,
					attempt: input.attempt,
					prompt,
					settings: input.settings,
					remainingRunTokens: input.remainingRunTokens,
					signal: input.signal,
					progress: input.progress,
				},
				(config.host ?? sandboxHost)(hostConfig),
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

							const patch = await collectPatch({
								base,
								workspace: input.workspace,
								allowNoChange: input.build.allowNoChange,
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
							);

							kept = storePatch(config.stateDir, binding, patch, {
								model:
									result.receipt.fallback?.requested ??
									result.receipt.models.requested,
								observed:
									result.receipt.fallback?.observed ??
									result.receipt.models.observed,
								commands,
								testCommand: baseTestCommand(base, input.build.command),
							});
						}

						return result;
					})
					.finally(() => {
						if (input.stage !== "build") return;
						rmSync(input.workspace, { recursive: true, force: true });
						cleanupBuildAgents(config.stateDir, input.runId, input.attempt);
						const kept = readRunPatch(config.stateDir, input.runId);

						if (kept.kind !== "found" || kept.receipt.policy === "forbidden")
							cleanupBuildBase(config.stateDir, input.runId);
					}),
			};
		},
	};
}
