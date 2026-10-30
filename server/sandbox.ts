import { randomBytes } from "node:crypto";
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
} from "../src/orchestrator.ts";
import type { Digest } from "../src/run.ts";
import {
	type ModelId,
	type ModelStage,
	STAGE_CLEANUP_RESERVE_MS,
} from "../src/workflow.ts";
import {
	checkoutWorkspace,
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

const OUTPUT_ID = "factory-output";

/** The cap on a stage's kept final text. */
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
	/** Writes the passing session's final text beside the receipt, once. */
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
	/** The last assistant text, asked for after a settlement and before stdin closes. */
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

/** Keeps at most `OUTPUT_MAX_BYTES` of the final text beside the receipt. */
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

/**
 * The stage's Pi. Its session lives in the writable agent dir:
 * `pi-herdr-agents` refuses to launch a child from a parent with no
 * session file, which `--no-session` caused on `pi-factorio`. The wrapper
 * forces `--no-extensions`, which skips configured packages, so
 * `pi-herdr-agents` and its `subagent` tool load by `-e`. Skills arrive
 * inlined in the prompt, so `--no-skills` stops discovery from the
 * writable agent dir.
 */
export function piCommand(model: ModelId): string[] {
	return [
		`${BUNDLE.bin}/pi`,
		"--mode",
		"rpc",
		"--no-skills",
		"--session-dir",
		`${PI_AGENT_DIR}/sessions`,
		"--model",
		model,
		"-e",
		HERDR_AGENTS,
	];
}

/**
 * Copies the bundle's agent template into a fresh private dir Pi can write:
 * `auth.json`, the settings lock and child sessions live there. The bundle
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

	const stageDir = freshDir(
		join(
			config.stateDir,
			"stages",
			config.runId,
			`${config.stage}-${config.attempt}`,
		),
	);

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
			const git = gitState(config.workspace);

			if (git === "unsafe" || socketPath === null) return null;

			const agentDir = join(stageDir, `agent-${session}`);

			agentDirFrom(join(config.bundleDir, "pi-agent"), agentDir);
			agentDirs.set(session, agentDir);

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
					agentDir,
					socketPath,
					seccompFd: 10,
					tools: config.tools,
					command: piCommand(model),
				}),
			);

			units.set(session, unit);

			const child = spawnScoped({
				argv,
				seccomp: seccompProgram(config.arch, {
					blockUnixSockets: config.blockUnixSockets ?? false,
				}),
				seccompFd: 10,
				xdgRuntimeDir: config.xdgRuntimeDir,
			});

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

/** The fixed prompt F05 ran for a stage. Tests still use it as a tiny prompt. */
export function probePrompt(stage: ModelStage): string {
	return `This is the factory's ${stage} stage probe. Do not call any tool. Reply with exactly: factory-${stage}-probe-ok`;
}

const SKILL_NAME = /^[a-z0-9][a-z0-9-]{0,63}$/;

const SKILL_MAX_BYTES = 32 * 1024;

/** A `SKILL.md` without its front matter. */
function skillBody(text: string): string {
	const match = /^---\n[\s\S]*?\n---\n/.exec(text);

	return (match === null ? text : text.slice(match[0].length)).trim();
}

/**
 * The stage prompt with each named skill appended, read host-side from the
 * bundle's `skills/<name>/SKILL.md`. The bundle is hashed into
 * `assetsDigest`, so the receipt proves which skill text ran. `null` when a
 * skill is missing, oversized or misnamed.
 */
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
	}

	return `${prompt}\n\n## Skills\n\n${parts.join("\n\n")}\n`;
}

/**
 * The final text of the newest execution of one attempt that passed and
 * kept its output: `<stage>-<attempt>` or a replay `<stage>-<attempt>.<n>`.
 * `null` when none did.
 */
async function attemptOutput(
	stateDir: string,
	runId: Digest,
	stage: ModelStage,
	attempt: number,
): Promise<string | null> {
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

		if (outcome !== "passed" || file !== "output.txt") continue;

		const text = await boundedText(join(dir, file), OUTPUT_MAX_BYTES);

		if (text !== null) return text;
	}

	return null;
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
};

const PREFLIGHT_RUN =
	"0000000000000000000000000000000000000000000000000000000000000000";

/**
 * The stage executor the controller installs. It stops leftover stage
 * scopes at startup, runs the preflight until it passes, and launches each
 * stage as one `runStage` in a fresh sandbox. Until the preflight has
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
			return attemptOutput(config.stateDir, runId, stage, attempt);
		},

		async checkout({ runId, repo, sha, workspace }) {
			return checkoutWorkspace({
				stateDir: config.stateDir,
				runId,
				workspace,
				repo,
				sha,
				fetch: config.fetchTarball ?? ghTarball,
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

			const host = sandboxHost({
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
			});

			return {
				kind: "started",
				done: runStage(
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
					host,
				),
			};
		},
	};
}
