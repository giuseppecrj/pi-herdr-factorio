import {
	fileArtifacts,
	readStoredContract,
	regularText,
	exclusive,
	privateDir,
	present,
} from "../src/artifacts.ts";
import {
	readPatch,
	publicationTree,
	readRepairBuildResult,
} from "../src/build.ts";
import {
	canonicalJson,
	classifyFeedback,
	feedbackId,
	readFeedbackBatch,
	type FeedbackBatchRef,
	type RoundReceipt,
	type FeedbackDisposition,
	type BuilderDisposition,
	type FeedbackBatch,
	type FeedbackEvent,
	type FeedbackId,
	type FeedbackObservation,
} from "../src/feedback.ts";
import { CONTROLLER_LOGIN, cadenceMarker } from "../src/markers.ts";
import {
	CadenceRunner,
	CADENCE_SKILLS,
	cadenceCharges,
	cadenceExecutionDir,
	cadenceIssueBody,
	cadencePrompt,
	cadenceScope,
	inCadenceScope,
	cadencePrivateDir,
	readCadenceFile,
	writeCadenceFile,
	type CadenceInput,
	type CadenceProposal,
	type CadenceResult,
} from "../src/cadence.ts";
import {
	promotedHead,
	handoffGeneration,
	sameGeneration,
	type GenerationRef,
	parseCandidateState,
	candidateUsage,
	candidateGenerations,
	completingFeedbackBatch,
	ownerPatchValid,
	migrateCertificationValue,
	migrateEvidenceValue,
	notProven,
	renderLimitation,
	type CandidateState,
	type CandidateEvent,
} from "../src/handoff.ts";
import {
	GitHubTicketAdapter,
	GitHubTicketWriter,
	parseOwnedPullRequest,
	type OwnedPullRequest,
	type GitHubFailure,
	isLogin,
} from "../src/adapters/github.ts";
import { fileAdmissionStore, latestReadyEntry } from "../src/admission.ts";
import {
	READY_LABEL,
	REPO_SWITCH_LABEL,
	hasWriteAccess,
} from "../src/policy.ts";
import {
	GitHubPublicationApi,
	PublicationError,
	publishCandidate,
	deriveOwnerPatch,
	pinOwnerCandidate,
	readOwnerPatch,
	candidateBranch,
} from "../src/publication.ts";
import {
	type Validator,
	type ValidationState,
	CI_DEADLINE_MS,
	DISPATCH_SETTLE_MS,
	publishedSuite,
	dispatchNonce,
	parseCiRun,
	matchesCiRun,
	collectVerdict,
	collectTrustedReport,
	repairFeedback,
	checkFeedback,
	parseCheckFeedback,
	FEEDBACK_CHECKS,
	parseValidationState,
	validationDir,
	assessmentBinding,
	assessmentBytes,
	feedbackBytes,
	readAssessmentBytes,
	type ReadAssessment,
	type ValidationAssessment,
} from "../src/validation.ts";
import {
	arrayOf,
	objectOf,
	fieldOf as jsonField,
	parseJson as parseJsonText,
	textOf,
	textsOf,
	countOf,
} from "./sandbox/json.ts";
import { type Exec } from "../src/gh.ts";
import { digestOf, type Verdict, type Stage } from "../src/run.ts";
import {
	frozenRowOf,
	parseLedger,
	ledgerApiOf,
	ledgerRowOf,
	pumpLedger,
	parseAttemptEnd,
	parseRunStart,
	contextPolicy,
	terminalFailureOf,
	AUTONOMY_DIGEST,
	type TerminalEvidence,
	type LedgerRow,
	ledgerModelOf,
	parseAdoption,
	type RunAccounting,
	type AttemptEnd,
	type LedgerBacklog,
	LedgerRowError,
	parseAnchor,
	parseRetry,
	type LedgerOutbox,
	type OutboxJob,
} from "../src/ledger.ts";
import {
	isGitSha,
	isRepoSlug,
	parseWorkflow,
	STAGE_CLEANUP_RESERVE_MS,
} from "../src/workflow.ts";
import {
	FAMILY_MISSING,
	familyClaimsHold,
	reviewR8,
	findingFingerprints,
} from "../src/review.ts";
import { execFile, spawn } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import {
	readFileSync,
	readdirSync,
	mkdirSync,
	existsSync,
	lstatSync,
} from "node:fs";
import {
	baseTreeDigest,
	materializeFromDirectories,
	replacementDigest,
	replayHeldoutCandidate,
	runHeldoutBase,
	runDraftBase,
	validateDependencies,
	type GateRunner,
} from "./gates.ts";
import {
	assessBase,
	draftCheckFeedback,
	classifyFailure,
	diagnosisNeeds,
	parseBaseReason,
	parseBaseReceipt,
	parseHeldoutReplay,
	parseBaseCheckReference,
	type AcceptanceBinding,
	type BaseCheckInput,
	type BaseCheckProgress,
	type BaseReason,
	type BaseReceipt,
	type DiagnosisNeeds,
	type FailureClass,
	type HeldoutReplay,
} from "../src/diagnosis.ts";
import {
	writeAcceptance,
	acceptanceDigestOf,
	type AcceptanceSuite,
} from "../src/accept.ts";
import type { DraftCheckContext, StageRunInput } from "./sandbox.ts";
import type { Contract, ReplacedTest } from "../src/specify.ts";
import { scopeOwner, scopeUnit, stopScopeArgv } from "./sandbox/scope.ts";
import {
	cp,
	lstat,
	mkdir,
	mkdtemp,
	open,
	readdir,
	readFile,
	realpath,
	rename,
	rm,
	stat,
	unlink,
	writeFile,
} from "node:fs/promises";
import { createConnection, createServer, type Server } from "node:net";
import { dirname, join, resolve } from "node:path";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { gunzipSync } from "node:zlib";
import {
	isRunStatus,
	isStage,
	parseMarker,
	MARKER_PREFIX,
} from "../src/markers.ts";
import { type Digest, isDigest } from "../src/run.ts";
import type {
	Checkout,
	CheckoutResult,
	ClaimRecord,
	LinkRead,
	Log,
	LogFields,
	Orchestrator,
	RunFiles,
	TickReport,
	StageExecutor,
} from "../src/orchestrator.ts";
import {
	type Answer,
	type AnswersRecord,
	type ClarificationRound,
	answersDigestOf,
	hasControl,
	inert,
	renderSummary,
	withoutKey,
	isAnswersDigest,
	isQuestionsDigest,
} from "../src/specify.ts";
import type { JsonValue } from "../src/tickets.ts";
import type { GitSha, RepoSlug } from "../src/workflow.ts";

export const HOLDER_FILE = "controller.lock";
export const STATUS_FILE = "status.json";

export type LockHolder = {
	readonly pid: number;
	readonly startTime: string;
	readonly acquiredAt: string;
};

export type SocketLockState =
	| { readonly kind: "none" }
	| { readonly kind: "socket_bound"; readonly holderFile: LockHolder | null }
	| {
			readonly kind: "holder_file_without_socket";
			readonly holderFile: LockHolder;
	  }
	| { readonly kind: "unreadable" };

export type LockAcquire =
	| {
			readonly kind: "acquired";
			readonly lock: ControllerLock;
			readonly replaced: LockHolder | null;
	  }
	| { readonly kind: "held"; readonly holder: LockHolder | null }
	| { readonly kind: "unavailable" };

export type ProcessTable = {
	readonly self: { readonly pid: number; readonly startTime: string };
};

/** Field 22 of `/proc/<pid>/stat`, counted after the parenthesized command name. */
export function parseStartTime(stat: string): string | null {
	const fields = stat
		.slice(stat.lastIndexOf(")") + 1)
		.trim()
		.split(/\s+/);

	const start = fields[19];

	return start !== undefined && /^\d+$/.test(start) ? start : null;
}

function readStartTime(): string | null {
	try {
		return parseStartTime(readFileSync("/proc/self/stat", "utf8"));
	} catch {
		return null;
	}
}

export function procTable(): ProcessTable {
	return { self: { pid: process.pid, startTime: readStartTime() ?? "" } };
}

/**
 * The Linux abstract Unix socket name for one state directory: a NUL byte,
 * then `pi-herdr-factorio/` and the SHA-256 of the directory's real path. The
 * kernel lets one socket bind a name and frees it when the process dies.
 */
export function lockName(realDir: string): string {
	return `\0pi-herdr-factorio/${createHash("sha256").update(realDir).digest("hex")}`;
}

function errorCode(error: Error): string | null {
	return "code" in error && error.code === String(error.code)
		? error.code
		: null;
}

function parseJson(text: string): JsonValue | undefined {
	try {
		const parsed: JsonValue = JSON.parse(text);

		return parsed;
	} catch {
		return undefined;
	}
}

function fieldOf(value: JsonValue | undefined, key: string) {
	if (
		value === undefined ||
		value === null ||
		Array.isArray(value) ||
		!(value instanceof Object)
	) {
		return undefined;
	}

	return Object.hasOwn(value, key) ? value[key] : undefined;
}

function parseHolder(text: string): LockHolder | null {
	const value = parseJson(text);
	const pid = fieldOf(value, "pid");
	const startTime = fieldOf(value, "startTime");
	const acquiredAt = fieldOf(value, "acquiredAt");

	if (
		pid !== Number(pid) ||
		!Number.isSafeInteger(pid) ||
		Number(pid) < 1 ||
		startTime !== String(startTime) ||
		!/^\d+$/.test(String(startTime)) ||
		acquiredAt !== String(acquiredAt)
	) {
		return null;
	}

	return {
		pid: Number(pid),
		startTime: String(startTime),
		acquiredAt: String(acquiredAt),
	};
}

type HolderFile =
	| { readonly kind: "absent" }
	| { readonly kind: "holder"; readonly holder: LockHolder }
	| { readonly kind: "unreadable" };

async function readHolderFile(path: string): Promise<HolderFile> {
	let text: string;

	try {
		text = await readFile(path, "utf8");
	} catch (error) {
		return (error instanceof Error ? errorCode(error) : null) === "ENOENT"
			? { kind: "absent" }
			: { kind: "unreadable" };
	}

	const holder = parseHolder(text);

	return holder === null ? { kind: "unreadable" } : { kind: "holder", holder };
}

function holderOf(file: HolderFile): LockHolder | null {
	return file.kind === "holder" ? file.holder : null;
}

async function probeName(name: string): Promise<"bound" | "free" | "unknown"> {
	return new Promise((done) => {
		const socket = createConnection({ path: name });

		socket.once("connect", () => {
			socket.destroy();
			done("bound");
		});

		socket.once("error", (error) => {
			const code = errorCode(error);

			done(code === "ECONNREFUSED" || code === "ENOENT" ? "free" : "unknown");
		});
	});
}

/** Reads the lock without taking it. `status --json` uses this. */
export async function readLock(stateDir: string): Promise<SocketLockState> {
	let real: string;

	try {
		real = await realpath(stateDir);
	} catch {
		return { kind: "unreadable" };
	}

	const probe = await probeName(lockName(real));
	const file = await readHolderFile(join(real, HOLDER_FILE));

	if (probe === "unknown") return { kind: "unreadable" };

	if (probe === "bound")
		return { kind: "socket_bound", holderFile: holderOf(file) };

	if (file.kind === "absent") return { kind: "none" };

	return file.kind === "holder"
		? { kind: "holder_file_without_socket", holderFile: file.holder }
		: { kind: "unreadable" };
}

export class ControllerLock {
	readonly path: string;
	readonly holder: LockHolder;
	readonly #server: Server;

	constructor(path: string, holder: LockHolder, server: Server) {
		this.path = path;
		this.holder = holder;
		this.#server = server;
	}

	async release(): Promise<void> {
		const file = await readHolderFile(this.path);

		if (
			file.kind === "holder" &&
			file.holder.pid === this.holder.pid &&
			file.holder.startTime === this.holder.startTime
		) {
			await unlink(this.path).catch(() => undefined);
		}

		await new Promise<void>((done) => {
			this.#server.close(() => done());
		});
	}
}

async function bind(
	server: Server,
	name: string,
): Promise<"bound" | "busy" | "failed"> {
	return new Promise((done) => {
		server.once("error", (error) => {
			done(errorCode(error) === "EADDRINUSE" ? "busy" : "failed");
		});
		server.listen({ path: name, exclusive: true }, () => done("bound"));
	});
}

/**
 * Binds the state directory's abstract socket name. Only one process can, so
 * two controllers started together never both run. A second one gets `held`.
 * The kernel frees the name when the holder dies, even by `kill -9`. Then
 * writes `<stateDir>/controller.lock` naming this process, and reports a lock
 * file a dead controller left behind as `replaced`.
 */
export async function acquireLock(input: {
	stateDir: string;
	procs: ProcessTable;
	now: () => number;
}): Promise<LockAcquire> {
	const { self } = input.procs;

	if (self.startTime === "") return { kind: "unavailable" };

	let real: string;

	try {
		real = await realpath(input.stateDir);
	} catch {
		return { kind: "unavailable" };
	}

	const path = join(real, HOLDER_FILE);
	const server = createServer((socket) => socket.destroy());
	const bound = await bind(server, lockName(real));

	if (bound === "busy") {
		return { kind: "held", holder: holderOf(await readHolderFile(path)) };
	}

	if (bound === "failed") return { kind: "unavailable" };

	server.unref();

	const left = await readHolderFile(path);

	const holder: LockHolder = {
		pid: self.pid,
		startTime: self.startTime,
		acquiredAt: new Date(input.now()).toISOString(),
	};

	if (!(await writeAtomic(path, `${JSON.stringify(holder)}\n`))) {
		await new Promise<void>((done) => {
			server.close(() => done());
		});

		return { kind: "unavailable" };
	}

	return {
		kind: "acquired",
		lock: new ControllerLock(path, holder, server),
		replaced: holderOf(left),
	};
}

function claimSeq(value: JsonValue | undefined): number | null | undefined {
	if (value === undefined || value === null) return null;

	return value === Number(value) && Number.isSafeInteger(value) && value >= 1
		? value
		: undefined;
}

function claimUsage(value: JsonValue | undefined): number | null | undefined {
	if (value === undefined || value === null) return null;

	return value === Number(value) && Number.isSafeInteger(value) && value >= 0
		? value
		: undefined;
}

type ClaimState = Pick<ClaimRecord, "status" | "stage" | "attempt">;

function claimState(value: JsonValue | undefined): ClaimState | undefined {
	const status = fieldOf(value, "status") ?? null;
	const stage = fieldOf(value, "stage") ?? null;
	const attempt = fieldOf(value, "attempt") ?? null;

	if (status === null && stage === null && attempt === null) {
		return { status, stage, attempt };
	}

	const statusText = String(status);
	const stageText = String(stage);

	return status === statusText &&
		isRunStatus(statusText) &&
		stage === stageText &&
		isStage(stageText) &&
		attempt === Number(attempt) &&
		Number.isSafeInteger(attempt) &&
		attempt >= 1
		? { status: statusText, stage: stageText, attempt }
		: undefined;
}

function parseClaim(text: string): ClaimRecord | null {
	const value = parseJson(text);
	const runId = fieldOf(value, "runId");
	const issue = fieldOf(value, "issue");
	const eventId = fieldOf(value, "eventId");
	const seq = claimSeq(fieldOf(value, "seq"));
	const state = claimState(value);
	const usage = claimUsage(fieldOf(value, "usage"));
	const labelFailures = claimUsage(fieldOf(value, "labelFailures"));

	if (
		labelFailures === undefined ||
		seq === undefined ||
		state === undefined ||
		usage === undefined ||
		(seq === null && state.status !== null) ||
		(state.status === null && usage !== null) ||
		runId !== String(runId) ||
		!isDigest(String(runId)) ||
		issue !== Number(issue) ||
		!Number.isSafeInteger(issue) ||
		Number(issue) < 1 ||
		eventId !== String(eventId) ||
		!/^[1-9][0-9]{0,19}$/.test(String(eventId))
	) {
		return null;
	}

	const id = String(runId);

	if (!isDigest(id)) return null;

	const validationValue = fieldOf(value, "validation");

	const validation =
		validationValue === undefined
			? undefined
			: parseValidationState(validationValue);

	if (validation === null) return null;

	const claim: ClaimRecord = {
		runId: id,
		issue: Number(issue),
		eventId: String(eventId),
		seq,
		...state,
		usage,
	};

	const round =
		countOf(fieldOf(objectOf(value), "round")) ?? validation?.round ?? 0;

	if (round > 2 || (validation !== undefined && validation.round !== round))
		return null;
	let labels = labelFailures === null ? claim : { ...claim, labelFailures };
	const rawMarker = fieldOf(value, "marker");

	if (rawMarker !== undefined) {
		const parsed = parseMarker(
			`${MARKER_PREFIX}${JSON.stringify(rawMarker)} -->`,
		);

		if (
			parsed.kind !== "marker" ||
			parsed.marker.runId !== id ||
			parsed.marker.issue !== claim.issue ||
			parsed.marker.eventId !== claim.eventId ||
			parsed.marker.seq !== claim.seq ||
			parsed.marker.usage !== claim.usage ||
			parsed.marker.status !== claim.status
		)
			return null;
		labels = { ...labels, marker: parsed.marker };
	}

	const rawBaseCheck = fieldOf(value, "baseCheck");

	if (rawBaseCheck !== undefined) {
		const baseCheck = parseBaseCheckReference(rawBaseCheck);

		if (
			baseCheck === null ||
			baseCheck.binding.runId !== id ||
			baseCheck.binding.issue !== claim.issue
		)
			return null;
		labels = { ...labels, baseCheck };
	}

	const acceptWallMs = fieldOf(value, "acceptWallMs");

	if (acceptWallMs !== undefined) {
		const wall = countOf(acceptWallMs);

		if (wall === null) return null;
		labels = { ...labels, acceptWallMs: wall };
	}

	const rawHandoff = fieldOf(value, "handoff");

	if (rawHandoff !== undefined) {
		const handoff = parseCandidateState(rawHandoff);

		if (
			handoff === null ||
			handoff.pin.runId !== id ||
			handoff.pin.issue !== claim.issue ||
			(usage !== null && usage !== candidateUsage(handoff))
		)
			return null;
		labels = { ...labels, handoff };
	}

	const enteredAt = fieldOf(value, "enteredAt");

	if (enteredAt !== undefined) {
		const at = claimUsage(enteredAt);

		if (at === undefined || at === null) return null;
		labels = { ...labels, enteredAt: at };
	}

	if (fieldOf(objectOf(value), "round") !== undefined)
		labels = { ...labels, round };

	if (validation === undefined) return labels;

	return {
		...labels,
		validation,
		branch: validation.publication?.branch ?? null,
		candidate: validation.publication?.candidateSha ?? null,
		round: validation.round,
		ciRun: validation.ciRunId,
	};
}

async function writeAtomic(path: string, text: string): Promise<boolean> {
	const temp = `${path}.${randomBytes(8).toString("hex")}.tmp`;

	try {
		const handle = await open(temp, "wx", 0o600);

		try {
			await handle.writeFile(text);
			await handle.sync();
		} finally {
			await handle.close();
		}

		await rename(temp, path);

		return true;
	} catch {
		await unlink(temp).catch(() => undefined);

		return false;
	}
}

/**
 * Fetches a tarball. `null` means the fetch failed. `timeout` means it gave
 * up at `bound.deadline` or at its own time limit, whatever Date.now() says.
 */
export type TarballFetch = (
	repo: RepoSlug,
	sha: GitSha,
	bound?: Readonly<{ signal?: AbortSignal; deadline?: number }>,
) => Promise<
	| Buffer
	| { readonly kind: "refused"; readonly reason: string }
	| typeof TIMED_OUT
	| null
>;

const TIMED_OUT = { kind: "timeout" } as const;

/** A non-finite deadline is no deadline. */
function finiteDeadline(deadline: number | undefined): number | undefined {
	return deadline !== undefined && Number.isFinite(deadline)
		? deadline
		: undefined;
}

/** Node's largest timer delay. A longer one fires after 1 ms. */
const MAX_TIMER_MS = 2 ** 31 - 1;

const TARBALL_MAX_BYTES = 64 * 1024 * 1024;

const TARBALL_TIMEOUT_MS = 120_000;

export const ghTarball: TarballFetch = (repo, sha, bound) =>
	new Promise((done) => {
		const deadline = finiteDeadline(bound?.deadline);

		const timeout = Math.min(
			TARBALL_TIMEOUT_MS,
			deadline === undefined
				? TARBALL_TIMEOUT_MS
				: Math.max(1, deadline - Date.now()),
		);

		execFile(
			"gh",
			["api", `repos/${repo}/tarball/${sha}`],
			{
				encoding: "buffer",
				maxBuffer: TARBALL_MAX_BYTES,
				timeout,
				killSignal: "SIGKILL",
				signal: bound?.signal,
			},
			(error, stdout) =>
				done(
					error === null
						? stdout
						: error.code === "ERR_CHILD_PROCESS_STDIO_MAXBUFFER"
							? { kind: "refused", reason: "too_large" }
							: // Only execFile's own timeout kills gh and reports `killed`.
								error.killed === true
								? TIMED_OUT
								: null,
				),
		);
	});

const UNPACKED_MAX_BYTES = 256 * 1024 * 1024;

const MAX_ENTRIES = 50_000;

const BLOCK = 512;

export type TarEntry =
	| {
			readonly kind: "file";
			readonly path: string;
			readonly mode: number;
			readonly data: Buffer;
	  }
	| { readonly kind: "dir"; readonly path: string };

export type TarRead =
	| {
			readonly kind: "ok";
			readonly entries: readonly TarEntry[];
			readonly omitted: number;
	  }
	| { readonly kind: "refused"; readonly reason: string };

function cString(block: Buffer, start: number, length: number): string {
	const field = block.subarray(start, start + length);
	const end = field.indexOf(0);

	return field.subarray(0, end === -1 ? field.length : end).toString("utf8");
}

function octal(block: Buffer, start: number, length: number): number | null {
	const text = cString(block, start, length).trim();

	return /^[0-7]+$/.test(text) ? Number.parseInt(text, 8) : null;
}

function paxFields(data: Buffer): Map<string, string> | null {
	const fields = new Map<string, string>();
	let at = 0;

	while (at < data.length) {
		const space = data.indexOf(0x20, at);

		const length =
			space === -1
				? Number.NaN
				: Number(data.subarray(at, space).toString("ascii"));

		if (
			!Number.isSafeInteger(length) ||
			length <= 0 ||
			at + length > data.length
		)
			return null;

		const record = data.subarray(space + 1, at + length - 1).toString("utf8");
		const equals = record.indexOf("=");

		if (equals === -1) return null;

		fields.set(record.slice(0, equals), record.slice(equals + 1));
		at += length;
	}

	return fields;
}

type TopDir = { name: string | null };

function hasArchiveControl(path: string): boolean {
	return hasControl(path.replace(/\p{Cf}/gu, ""));
}

function isCheckoutPath(path: string): boolean {
	return !/\p{Cf}/u.test(path) && isArchivePath(path);
}

function isArchivePath(path: string): boolean {
	return (
		path.length <= 4096 &&
		!hasArchiveControl(path) &&
		!path.includes("\\") &&
		path
			.split("/")
			.every(
				(part) =>
					part !== "" && part !== "." && part !== ".." && part !== ".git",
			)
	);
}

function memberPath(raw: string, top: TopDir): string | null {
	const parts = raw.replace(/\/+$/, "").split("/");
	const [first, ...rest] = parts;

	if (
		raw.startsWith("/") ||
		first === undefined ||
		first === "" ||
		hasArchiveControl(raw)
	) {
		return null;
	}

	top.name ??= first;

	if (first !== top.name) return null;

	if (rest.length === 0) return "";

	const path = rest.join("/");

	return isArchivePath(path) ? path : null;
}

/**
 * Reads a gzipped ustar or pax tarball like `gh api .../tarball` returns.
 * Only regular files and directories are extracted; symlinks are omitted.
 * Hardlinks, devices, FIFOs, traversal, a second top directory,
 * duplicate paths and oversize archives refuse the whole tarball.
 */
export function readTarball(gz: Buffer): TarRead {
	if (gz.length > TARBALL_MAX_BYTES)
		return { kind: "refused", reason: "too_large" };

	let tar: Buffer;

	try {
		tar = gunzipSync(gz, { maxOutputLength: UNPACKED_MAX_BYTES });
	} catch (error) {
		return {
			kind: "refused",
			reason:
				error instanceof Error &&
				"code" in error &&
				error.code === "ERR_BUFFER_TOO_LARGE"
					? "too_large"
					: "not_gzip",
		};
	}

	const refuse = (reason: string): TarRead => ({ kind: "refused", reason });
	const entries: TarEntry[] = [];
	const seen = new Set<string>();
	const top: TopDir = { name: null };
	let pax: Map<string, string> | null = null;
	let at = 0;
	let omitted = 0;

	while (at + BLOCK <= tar.length) {
		const header = tar.subarray(at, at + BLOCK);

		if (header.every((byte) => byte === 0))
			return { kind: "ok", entries, omitted };

		const size = octal(header, 124, 12);
		const type = String.fromCharCode(header[156] ?? 0);

		if (size === null) return refuse("bad_header");

		const data = tar.subarray(at + BLOCK, at + BLOCK + size);

		if (data.length !== size) return refuse("truncated");

		at += BLOCK + Math.ceil(size / BLOCK) * BLOCK;

		if (type === "g") continue;

		if (type === "x") {
			pax = paxFields(data);

			if (pax === null) return refuse("bad_pax");

			continue;
		}

		const prefix = cString(header, 345, 155);
		const name = cString(header, 0, 100);

		const raw =
			pax?.get("path") ?? (prefix === "" ? name : `${prefix}/${name}`);

		const target = pax?.get("linkpath") ?? cString(header, 157, 100);

		pax = null;

		const path = memberPath(raw, top);

		if (path === null) return refuse("unsafe_path");

		if (path === "") continue;

		if (seen.has(path)) return refuse("duplicate_path");

		seen.add(path);

		if (seen.size > MAX_ENTRIES) return refuse("too_many_entries");

		if (
			/\p{Cf}/u.test(path) &&
			(type === "0" || type === "\0" || type === "5")
		) {
			omitted++;

			continue;
		}

		if (type === "0" || type === "\0") {
			const mode = octal(header, 100, 8) ?? 0o644;

			entries.push({
				kind: "file",
				path,
				mode: mode & 0o111 ? 0o755 : 0o644,
				data,
			});
		} else if (type === "5") {
			entries.push({ kind: "dir", path });
		} else if (type === "2") {
			if (target === "" || hasArchiveControl(target))
				return refuse("unsafe_symlink");
			omitted++;
		} else {
			return refuse(type === "1" ? "hardlink" : "special_file");
		}
	}

	return refuse("truncated");
}

async function writeEntries(
	dest: string,
	entries: readonly TarEntry[],
): Promise<boolean> {
	try {
		for (const entry of entries) {
			const full = join(dest, entry.path);

			if (entry.kind === "dir") {
				await mkdir(full, { recursive: true, mode: 0o755 });
			} else if (entry.kind === "file") {
				await mkdir(dirname(full), { recursive: true, mode: 0o755 });
				await writeFile(full, entry.data, { flag: "wx", mode: entry.mode });
			}
		}

		return true;
	} catch {
		return false;
	}
}

const CHECKOUT_LIST_MAX_BYTES = 16 * 1024 * 1024;

function parseCheckoutRecord(
	text: string | null,
	sha: GitSha,
): { paths: string[]; omitted: number | null } | null {
	const value = text === null ? undefined : parseJson(text);
	const files = fieldOf(value, "files");
	const omitted = countOf(fieldOf(value, "omitted"));

	if (fieldOf(value, "sha") !== sha || !Array.isArray(files)) return null;

	const paths: string[] = [];

	for (const file of files) {
		const path = String(file);

		if (file !== path || !isCheckoutPath(path)) return null;

		paths.push(path);
	}

	return { paths, omitted };
}

function checkoutOf(workspace: string, files: readonly string[]): Checkout {
	const listed = new Set(files);

	return {
		files,
		async read(path, capBytes) {
			if (!listed.has(path)) return null;

			try {
				const full = join(workspace, path);
				const info = await lstat(full);
				const real = await realpath(full);

				if (
					!info.isFile() ||
					info.size > capBytes ||
					!real.startsWith(`${await realpath(workspace)}/`)
				) {
					return null;
				}

				return await readFile(full, "utf8");
			} catch {
				return null;
			}
		},
	};
}

export { checkoutOf };

function textList(value: JsonValue | undefined): string | null {
	const text = String(value);

	return value === text ? text : null;
}

function parseAnswer(value: JsonValue): Answer | null {
	const commentId = textList(fieldOf(value, "commentId"));
	const author = textList(fieldOf(value, "author"));
	const createdAt = textList(fieldOf(value, "createdAt"));
	const body = textList(fieldOf(value, "body"));

	return commentId === null ||
		author === null ||
		createdAt === null ||
		body === null
		? null
		: { commentId, author, createdAt, body };
}

function parseRounds(
	value: JsonValue | undefined,
): readonly ClarificationRound[] | null | undefined {
	if (value === undefined) return undefined;

	if (!Array.isArray(value)) return null;

	const rounds: ClarificationRound[] = [];

	for (const item of value) {
		const questions = textList(fieldOf(item, "questions"));
		const items = fieldOf(item, "answers");

		if (questions === null || !Array.isArray(items)) return null;

		const answers: Answer[] = [];

		for (const value of items) {
			const answer = parseAnswer(value);

			if (answer === null) return null;

			answers.push(answer);
		}

		rounds.push({ questions, answers });
	}

	return rounds;
}

export function parseAnswers(
	text: string,
	runId: Digest,
): AnswersRecord | null {
	const value = parseJson(text);
	const prevRunId = textList(fieldOf(value, "prevRunId"));
	const questions = textList(fieldOf(value, "questions"));
	const commentId = fieldOf(value, "questionsCommentId");
	const questionsCommentId = commentId === null ? null : textList(commentId);
	const items = fieldOf(value, "answers");
	const digest = textList(fieldOf(value, "digest"));
	const rounds = parseRounds(fieldOf(value, "rounds"));

	if (
		rounds === null ||
		fieldOf(value, "version") !== 1 ||
		fieldOf(value, "runId") !== runId ||
		prevRunId === null ||
		!isDigest(prevRunId) ||
		questions === null ||
		(commentId !== null && questionsCommentId === null) ||
		!Array.isArray(items) ||
		digest === null ||
		!isAnswersDigest(digest)
	) {
		return null;
	}

	const answers: Answer[] = [];

	for (const item of items) {
		const answer = parseAnswer(item);

		if (answer === null) return null;

		answers.push(answer);
	}

	if (answersDigestOf({ prevRunId, questions, answers, rounds }) !== digest)
		return null;

	const record: AnswersRecord = {
		version: 1,
		runId,
		prevRunId,
		questionsCommentId,
		questions,
		answers,
		digest,
	};

	return rounds === undefined ? record : { ...record, rounds };
}

function parseLink(text: string): LinkRead {
	const value = parseJson(text);

	if (
		fieldOf(value, "version") === 1 &&
		fieldOf(value, "prevRunId") === null &&
		fieldOf(value, "questionsDigest") === undefined &&
		fieldOf(value, "answersDigest") === undefined
	) {
		return { kind: "unlinked" };
	}

	const prevRunId = textList(fieldOf(value, "prevRunId"));
	const questions = fieldOf(value, "questionsDigest");
	const questionsDigest = questions === null ? null : textList(questions);
	const answersDigest = textList(fieldOf(value, "answersDigest"));

	if (
		fieldOf(value, "version") !== 1 ||
		prevRunId === null ||
		!isDigest(prevRunId) ||
		(questions !== null &&
			(questionsDigest === null || !isQuestionsDigest(questionsDigest))) ||
		answersDigest === null ||
		!isAnswersDigest(answersDigest)
	) {
		return { kind: "unreadable" };
	}

	return {
		kind: "found",
		link: {
			prevRunId,
			questionsDigest:
				questionsDigest !== null && isQuestionsDigest(questionsDigest)
					? questionsDigest
					: null,
			answersDigest,
		},
	};
}

/**
 * Extracts the repository at `sha` into `workspace` once, refusing unsafe
 * entries, and records the file list in `<stateDir>/checkouts/<runId>.json`.
 * A later call with the record present lists the same checkout. A
 * workspace left half-extracted by a crash, with no record, is emptied and
 * extracted again.
 */
async function boundedFetch(input: {
	readonly repo: RepoSlug;
	readonly sha: GitSha;
	readonly fetch: TarballFetch;
	readonly signal?: AbortSignal;
	readonly deadline?: number;
}): ReturnType<TarballFetch> {
	const { signal } = input;
	const deadline = finiteDeadline(input.deadline);

	if (signal?.aborted) return null;

	if (deadline !== undefined && Date.now() >= deadline) return TIMED_OUT;
	let timer: ReturnType<typeof setTimeout> | undefined;
	let onAbort = () => {};

	const stopped = new Promise<null | typeof TIMED_OUT>((done) => {
		onAbort = () => done(null);
		signal?.addEventListener("abort", onAbort, { once: true });

		// The timer can fire just before Date.now() reaches the deadline, so
		// it reports the timeout outright instead of leaving callers to infer
		// it from the wall clock.
		if (deadline !== undefined)
			timer = setTimeout(
				() => done(TIMED_OUT),
				Math.min(MAX_TIMER_MS, Math.max(0, deadline - Date.now())),
			);
	});

	try {
		return await Promise.race([
			input
				.fetch(input.repo, input.sha, { signal, deadline })
				.catch(() => null),
			stopped,
		]);
	} finally {
		clearTimeout(timer);
		signal?.removeEventListener("abort", onAbort);
	}
}

type CheckoutInput = {
	readonly stateDir: string;
	readonly runId: Digest;
	readonly workspace: string;
	readonly repo: RepoSlug;
	readonly sha: GitSha;
	readonly fetch: TarballFetch;
	readonly log?: Log;
	readonly signal?: AbortSignal;
	readonly deadline?: number;
};

export async function checkoutWorkspace(
	input: CheckoutInput,
): Promise<CheckoutResult> {
	const result = await checkoutTree(input);

	return result.kind === "timeout" ? { kind: "unavailable" } : result;
}

/** `checkoutWorkspace`, reporting a fetch that timed out as `timeout`. */
async function checkoutTree(
	input: CheckoutInput,
): Promise<CheckoutResult | typeof TIMED_OUT> {
	const { runId, workspace, sha } = input;
	const checkouts = join(resolve(input.stateDir), "checkouts");
	const record = join(checkouts, `${runId}.json`);

	const kept = await readFile(record, "utf8").catch(() => null);
	const value = parseJson(kept ?? "");
	const refusal = textList(fieldOf(value, "refused"));

	if (fieldOf(value, "sha") === sha && refusal !== null) {
		return { kind: "refused", reason: refusal };
	}

	const listed = parseCheckoutRecord(kept, sha);

	if (listed !== null)
		return {
			kind: "ready",
			omitted: listed.omitted,
			checkout: checkoutOf(workspace, listed.paths),
		};

	const gz = await boundedFetch(input);

	if (gz === null) return { kind: "unavailable" };

	if (!Buffer.isBuffer(gz) && gz.kind === "timeout") return TIMED_OUT;

	const read = Buffer.isBuffer(gz) ? readTarball(gz) : gz;

	if (read.kind === "refused") {
		await mkdir(checkouts, { recursive: true, mode: 0o700 }).catch(
			() => undefined,
		);
		await writeAtomic(
			record,
			`${JSON.stringify({ sha, refused: read.reason })}\n`,
		);

		return read;
	}

	try {
		const info = await lstat(workspace);

		if (!info.isDirectory()) return { kind: "unavailable" };

		for (const name of await readdir(workspace)) {
			await rm(join(workspace, name), { recursive: true, force: true });
		}

		await mkdir(checkouts, { recursive: true, mode: 0o700 });
	} catch {
		return { kind: "unavailable" };
	}

	if (!(await writeEntries(workspace, read.entries)))
		return { kind: "unavailable" };

	const files = read.entries
		.flatMap((entry) => (entry.kind === "file" ? [entry.path] : []))
		.sort();

	const text = `${JSON.stringify({ sha, files, omitted: read.omitted })}\n`;

	if (
		Buffer.byteLength(text) > CHECKOUT_LIST_MAX_BYTES ||
		!(await writeAtomic(record, text))
	) {
		return { kind: "unavailable" };
	}

	if (read.omitted > 0) {
		input.log?.("checkout_paths_omitted", {
			runId,
			count: read.omitted,
			why: "symlink_or_unicode_format",
		});
	}

	return {
		kind: "ready",
		omitted: read.omitted,
		checkout: checkoutOf(workspace, files),
	};
}

export async function checkoutBuildWorkspace(
	input: Parameters<typeof checkoutWorkspace>[0],
): Promise<CheckoutResult> {
	const base = join(input.stateDir, "pristine", input.runId);
	await mkdir(base, { recursive: true, mode: 0o700 });

	const result = await checkoutWorkspace({
		...input,
		stateDir: join(input.stateDir, "build-base"),
		workspace: base,
	});

	if (result.kind !== "ready") return result;

	try {
		const existing = await lstat(input.workspace).catch(() => null);

		if (existing !== null && !existing.isDirectory())
			return { kind: "refused", reason: "unsafe_workspace" };
		await rm(input.workspace, { recursive: true, force: true });
		await cp(base, input.workspace, {
			recursive: true,
			force: false,
			errorOnExist: true,
		});
	} catch {
		await rm(input.workspace, { recursive: true, force: true }).catch(
			() => undefined,
		);

		return { kind: "unavailable" };
	}

	return {
		...result,
		checkout: checkoutOf(input.workspace, result.checkout.files),
	};
}

async function writeOnce(
	path: string,
	text: string,
	migrate?: (value: JsonValue | undefined) => JsonValue | undefined,
): Promise<boolean> {
	const existing = await readFile(path, "utf8").catch(() => null);

	if (existing !== null)
		return (
			existing === text ||
			(migrate !== undefined &&
				`${JSON.stringify(migrate(parseJson(existing)))}\n` === text)
		);

	try {
		await mkdir(dirname(path), { recursive: true, mode: 0o700 });
	} catch {
		return false;
	}

	return writeAtomic(path, text);
}

export function controllerDraftChecker(config: {
	readonly stateDir: string;
	readonly stageDir: string;
	readonly attempt: number;
	readonly input: NonNullable<
		import("../src/orchestrator.ts").StageLaunchInput["acceptDraft"]
	>;
	readonly fetch?: TarballFetch;
	readonly runner?: GateRunner;
}): NonNullable<StageRunInput["draftCheck"]> {
	let cached: ReturnType<TarballFetch> | null = null;

	const fetch: TarballFetch = (repo, sha, bound) => {
		cached ??= (config.fetch ?? ghTarball)(repo, sha, bound);

		return cached;
	};

	return async (text: string, context: DraftCheckContext) => {
		const parsed = writeAcceptance(text, config.input.contract);

		if (parsed.kind !== "suite") return null;
		const { contract, digest, repo, issue, baseSha } = config.input;

		const dir = join(config.stageDir, `draft-${context.run}`),
			tree = join(dir, "source");

		privateDir(dir);
		const deadline = context.deadline;

		const signal = AbortSignal.any([
			context.signal,
			AbortSignal.timeout(Math.max(1, deadline - Date.now())),
		]);

		const startedAt = Date.now();
		const canary = `factory-holdout-${randomBytes(32).toString("hex")}`;

		try {
			await mkdir(tree, { mode: 0o700 });

			const checked = await checkoutWorkspace({
				stateDir: dir,
				runId: contract.runId,
				workspace: tree,
				repo,
				sha: baseSha,
				fetch,
				signal,
				deadline,
			});

			const { evidence, details } = await runDraftBase({
				tree,
				workDir: dir,
				cacheDir: join(config.stateDir, "base-dependencies"),
				binding: {
					runId: contract.runId,
					repo,
					issue,
					contractDigest: digest,
					acceptanceDigest: acceptanceDigestOf(parsed.suite, canary),
					baseSha,
					gateSha: baseSha,
				},
				contract,
				suite: parsed.suite,
				canary,
				startedAt,
				deadline,
				signal,
				scope: scopeUnit(
					scopeOwner(config.stateDir),
					contract.runId,
					"draftcheck",
					config.attempt,
					randomBytes(4).toString("hex"),
				),
				runner: config.runner,
				refused:
					checked.kind === "unavailable"
						? "tree_unavailable"
						: checked.kind === "refused"
							? "tree_refused"
							: checked.omitted !== 0
								? "tree_partial"
								: undefined,
			});

			const { receipt } = assessBase(evidence);

			const feedback = {
				...draftCheckFeedback(receipt, details, issue),
				run: context.run,
			};

			exclusive(
				join(config.stageDir, `draft-${context.run}.json`),
				JSON.stringify({ receipt, details, feedback }),
			);

			return feedback;
		} finally {
			await rm(dir, { recursive: true, force: true });
		}
	};
}

export function controllerBaseChecker(config: {
	readonly stateDir: string;
	readonly fetch?: TarballFetch;
}) {
	const jobs = new Map<
		string,
		{ runId: Digest; abort: AbortController; done: Promise<void> }
	>();

	const files = fileRunFiles(config.stateDir);

	const fail = (
		input: BaseCheckInput,
		reason: "base_evidence_missing" | "base_runner_error" | "base_timeout",
	): BaseCheckProgress => ({
		kind: "refused",
		failure: {
			binding: input.binding,
			receiptDigest: digestOf(JSON.stringify([input.binding, reason])),
			reason,
			scenarios: [],
		},
	});

	/**
	 * Every attempt's base-check wall on one binding: each stored receipt's run
	 * plus each interruption's charge. `null` when an attempt has neither.
	 */
	const bindingWall = (parent: string): number | null => {
		let charged = 0;

		if (!existsSync(parent)) return 0;

		for (const name of readdirSync(parent)) {
			if (!/^a[1-9][0-9]*$/.test(name)) return null;
			const previous = join(parent, name);

			const completed = present(join(previous, "result.json"))
				? parseBaseReceipt(
						regularText(join(previous, "result.json"), 2 * 1024 * 1024),
					)
				: null;

			const interrupted = present(join(previous, "interrupted.json"))
				? countOf(
						jsonField(
							objectOf(
								parseJson(regularText(join(previous, "interrupted.json"))),
							),
							"wallMs",
						),
					)
				: null;

			if (completed !== null)
				charged += completed.evidence.finishedAt - completed.evidence.startedAt;
			else if (interrupted !== null) charged += interrupted;
			else return null;
		}

		return charged;
	};

	const check = async (input: BaseCheckInput): Promise<BaseCheckProgress> => {
		const bindingDigest = digestOf(JSON.stringify(input.binding));

		const parent = join(
			config.stateDir,
			"base-check",
			input.binding.runId,
			bindingDigest,
		);

		const stored =
			input.readOnly && existsSync(parent)
				? readdirSync(parent)
						.flatMap((name) => {
							const n = /^a([1-9][0-9]*)$/.exec(name)?.[1];

							return n !== undefined &&
								present(join(parent, name, "result.json"))
								? [Number(n)]
								: [];
						})
						.sort((a, b) => b - a)[0]
				: undefined;

		const dir = join(parent, `a${stored ?? input.acceptAttempt}`);
		const resultPath = join(dir, "result.json");

		try {
			if (input.binding.gateSha !== input.binding.baseSha)
				return fail(input, "base_evidence_missing");

			if (input.storedAttempt !== undefined) {
				const receipt = await files.artifacts.receipt(
					input.binding.runId,
					input.binding.acceptanceDigest,
				);

				if (
					receipt === null ||
					receipt.contractDigest !== input.binding.contractDigest ||
					receipt.baseSha !== input.binding.baseSha ||
					(receipt.storedAttempt !== undefined &&
						receipt.storedAttempt !== input.storedAttempt)
				)
					return fail(input, "base_evidence_missing");
			}

			if (present(resultPath)) {
				const text = regularText(resultPath, 2 * 1024 * 1024);
				const receipt = parseBaseReceipt(text);

				if (
					receipt === null ||
					digestOf(text) !== regularText(join(dir, "result.digest")) ||
					JSON.stringify(receipt.evidence.binding) !==
						JSON.stringify(input.binding)
				)
					return fail(input, "base_evidence_missing");
				const { assessment } = assessBase(receipt.evidence);

				if (assessment.kind !== "refused") return assessment;
				let baseWallMs: number | null;

				try {
					baseWallMs = bindingWall(parent);
				} catch {
					baseWallMs = null;
				}

				// The receipt goes only to the accept retry's private feedback; its
				// binding's whole base wall is charged before any retry is granted.
				return baseWallMs === null
					? { ...assessment, receipt }
					: { ...assessment, receipt, baseWallMs };
			}

			if (input.readOnly) return fail(input, "base_evidence_missing");

			if (jobs.has(dir)) return { kind: "checking" };

			if (present(join(dir, "intent.json"))) {
				const intent = objectOf(
					parseJson(regularText(join(dir, "intent.json"))),
				);

				const startedAt = countOf(jsonField(intent, "startedAt")),
					deadline = countOf(jsonField(intent, "deadline"));

				if (
					startedAt === null ||
					deadline === null ||
					deadline < startedAt ||
					jsonField(intent, "bindingDigest") !== bindingDigest
				)
					return fail(input, "base_evidence_missing");
				const interrupted = join(dir, "interrupted.json");
				const record = `${JSON.stringify({ wallMs: deadline - startedAt })}\n`;

				if (!present(interrupted)) exclusive(interrupted, record);
				else if (regularText(interrupted) !== record)
					return fail(input, "base_evidence_missing");

				return { kind: "interrupted", wallMs: deadline - startedAt };
			}

			if (input.allowLaunch === false) return { kind: "checking" };
			const bound = await files.readContract(input.binding.runId);

			if (
				bound.kind !== "found" ||
				bound.digest !== input.binding.contractDigest ||
				bound.contract.base.sha !== input.binding.baseSha ||
				bound.contract.base.repo !== input.binding.repo ||
				bound.contract.issue !== input.binding.issue
			)
				return fail(input, "base_evidence_missing");

			const suite = await files.artifacts.read(
				input.binding.runId,
				bound.contract,
				bound.digest,
			);

			if (
				suite.kind !== "found" ||
				suite.receipt.acceptanceDigest !== input.binding.acceptanceDigest
			)
				return fail(input, "base_evidence_missing");
			const charged = bindingWall(parent);

			if (charged === null) return fail(input, "base_evidence_missing");

			const startedAt = Date.now();

			const allowance = Math.max(
				0,
				Math.min(180_000, input.remainingAcceptMs - charged),
			);

			const deadline = startedAt + allowance;

			const scope = scopeUnit(
				scopeOwner(config.stateDir),
				input.binding.runId,
				"basecheck",
				input.acceptAttempt,
				randomBytes(4).toString("hex"),
			);

			privateDir(parent);
			mkdirSync(dir, { mode: 0o700 });
			exclusive(
				join(dir, "intent.json"),
				`${JSON.stringify({ bindingDigest, binding: input.binding, startedAt, deadline, scope })}\n`,
			);
			const abort = new AbortController();
			const externalAbort = () => abort.abort();
			input.signal.addEventListener("abort", externalAbort, { once: true });

			if (input.signal.aborted) abort.abort();

			const done = (async () => {
				const tree = join(dir, "source");
				await mkdir(tree, { mode: 0o700 });

				const checked =
					Date.now() < deadline && !abort.signal.aborted
						? await checkoutWorkspace({
								stateDir: dir,
								runId: input.binding.runId,
								workspace: tree,
								repo: input.binding.repo,
								sha: input.binding.baseSha,
								fetch: config.fetch ?? ghTarball,
							})
						: ({ kind: "unavailable" } as const);

				const evidence = await runHeldoutBase({
					tree,
					refused:
						checked.kind === "unavailable"
							? "tree_unavailable"
							: checked.kind === "refused"
								? "tree_refused"
								: checked.omitted !== 0
									? "tree_partial"
									: undefined,
					workDir: dir,
					cacheDir: join(config.stateDir, "base-dependencies"),
					binding: input.binding,
					contract: bound.contract,
					suite: suite.suite,
					canary: regularText(
						join(
							config.stateDir,
							"acceptance",
							input.binding.runId,
							"canary.txt",
						),
					).trimEnd(),
					startedAt,
					deadline,
					scope,
					signal: abort.signal,
				});

				const { receipt } = assessBase(evidence);
				const text = JSON.stringify(receipt);
				await rm(join(dir, "tree"), { recursive: true, force: true });
				await rm(tree, { recursive: true, force: true });
				await rm(join(dir, "checkouts"), { recursive: true, force: true });
				exclusive(join(dir, "result.digest"), digestOf(text));

				if (!(await writeAtomic(resultPath, text)))
					throw new Error("base_result_unwritable");
			})().finally(() => {
				input.signal.removeEventListener("abort", externalAbort);
				jobs.delete(dir);
			});

			jobs.set(dir, { runId: input.binding.runId, abort, done });
			void done.catch(() => {});

			return { kind: "checking" };
		} catch {
			return fail(input, "base_evidence_missing");
		}
	};

	return {
		check,
		async stop(runId: Digest) {
			const owned = [...jobs.values()].filter((j) => j.runId === runId);

			for (const job of owned) job.abort.abort();
			await Promise.allSettled(owned.map((j) => j.done));
		},
	};
}

export type DiagnosisFacts = Readonly<{
	base: BaseReceipt | null;
	baseRefusal: BaseReason | null;
	ignoredChanges: readonly string[] | null;
	replay: HeldoutReplay | null;
	dependencies: Readonly<{ reason: string | null }> | null;
}>;

export type DiagnosisRequest = Readonly<{
	runId: Digest;
	dir: string;
	bindingDigest: Digest;
	repo: RepoSlug;
	gateSha: GitSha;
	candidateSha: GitSha;
	round: number;
	allowanceMs: number;
	needs: DiagnosisNeeds;
	heldoutDir: string;
	heldoutDigest: string;
	replacements: readonly ReplacedTest[];
	base:
		| Readonly<{ kind: "stored"; receipt: BaseReceipt | null }>
		| Readonly<{
				kind: "fresh";
				binding: AcceptanceBinding;
				contract: Contract;
				suite: AcceptanceSuite;
				canary: string;
		  }>;
	finish: (facts: DiagnosisFacts) => void;
	interrupted: () => void;
}>;

export function storedBaseReceipt(
	stateDir: string,
	binding: AcceptanceBinding,
): BaseReceipt | null {
	const parent = join(
		stateDir,
		"base-check",
		binding.runId,
		digestOf(JSON.stringify(binding)),
	);

	if (!existsSync(parent)) return null;

	const attempts = readdirSync(parent)
		.flatMap((name) => {
			const n = /^a([1-9][0-9]*)$/.exec(name)?.[1];

			return n === undefined ? [] : [Number(n)];
		})
		.sort((a, b) => b - a);

	for (const n of attempts) {
		const dir = join(parent, `a${n}`);

		if (!present(join(dir, "result.json"))) continue;
		const text = regularText(join(dir, "result.json"), 2 * 1024 * 1024);
		const receipt = parseBaseReceipt(text);

		return receipt !== null &&
			digestOf(text) === regularText(join(dir, "result.digest")) &&
			JSON.stringify(receipt.evidence.binding) === JSON.stringify(binding)
			? receipt
			: null;
	}

	return null;
}

function dependencyFacts(
	gate: string,
	candidate: string,
): DiagnosisFacts["dependencies"] {
	const text = (tree: string, name: string) =>
		readFileSync(join(tree, name), "utf8");

	try {
		validateDependencies(
			text(gate, "package.json"),
			text(gate, "package-lock.json"),
			text(gate, "package-lock.json"),
		);
	} catch {
		return null;
	}

	try {
		validateDependencies(
			text(candidate, "package.json"),
			text(candidate, "package-lock.json"),
			text(gate, "package-lock.json"),
		);

		return { reason: null };
	} catch (error) {
		return { reason: error instanceof Error ? error.message : null };
	}
}

async function stopDiagnosisScope(unit: string): Promise<void> {
	const [command = "systemctl", ...args] = stopScopeArgv(unit);

	await new Promise<void>((done) => {
		execFile(
			command,
			args,
			{
				env: {
					PATH: "/usr/bin:/bin",
					XDG_RUNTIME_DIR: process.env.XDG_RUNTIME_DIR,
				},
				timeout: 5_000,
			},
			() => done(),
		);
	});
}

function completedDiagnosis(root: string): DiagnosisFacts | null {
	try {
		if (
			!present(join(root, "replay.json")) ||
			!present(join(root, "charge.json"))
		)
			return null;
		const charge = objectOf(parseJson(regularText(join(root, "charge.json"))));
		const text = regularText(join(root, "replay.json"), 4 * 1024 * 1024);
		const raw = objectOf(parseJson(text));
		const rawBase = jsonField(raw, "base");
		const rawRefusal = jsonField(raw, "baseRefusal");
		const rawIgnored = jsonField(raw, "ignoredChanges");
		const rawReplay = jsonField(raw, "replay");
		const rawDependencies = jsonField(raw, "dependencies");

		const base =
			rawBase === null ? null : parseBaseReceipt(JSON.stringify(rawBase));

		const ignoredChanges = rawIgnored === null ? null : textsOf(rawIgnored);
		const replay = rawReplay === null ? null : parseHeldoutReplay(rawReplay);

		const dependencies =
			rawDependencies === null
				? null
				: { reason: textOf(jsonField(objectOf(rawDependencies), "reason")) };

		const refusal = parseBaseReason(rawRefusal);

		if (
			countOf(jsonField(charge, "wallMs")) === null ||
			jsonField(charge, "tokens") !== 0 ||
			(rawBase !== null && base === null) ||
			(rawRefusal !== null && refusal === null) ||
			(rawIgnored !== null && ignoredChanges === null) ||
			(rawReplay !== null && replay === null)
		)
			return null;

		const facts: DiagnosisFacts = {
			base,
			baseRefusal: refusal,
			ignoredChanges,
			replay,
			dependencies,
		};

		return `${JSON.stringify(facts)}\n` === text ? facts : null;
	} catch {
		return null;
	}
}

function sameMaterializer(gate: string, source: Uint8Array): boolean {
	const path = join(gate, "server/gates.ts");

	try {
		const stat = lstatSync(path);

		return (
			stat.isFile() &&
			stat.size === source.byteLength &&
			Buffer.from(source).equals(readFileSync(path))
		);
	} catch {
		return false;
	}
}

export function controllerDiagnosis(config: {
	readonly stateDir: string;
	readonly fetch?: TarballFetch;
	readonly runner?: GateRunner;
	readonly materialize?: (input: {
		readonly gateTree: string;
		readonly candidateTree: string;
		readonly dest: string;
		readonly replacements: readonly ReplacedTest[];
		readonly heldoutDir: string;
		readonly heldoutDigest: string;
	}) => { readonly ignoredChanges: readonly string[] };
	readonly materializerSource?: Uint8Array;
	readonly stopScope?: (unit: string) => Promise<void>;
}) {
	const stopScope = config.stopScope ?? stopDiagnosisScope;

	const materializerSource =
		config.materializerSource ??
		readFileSync(new URL("./gates.ts", import.meta.url));

	const jobs = new Map<
		string,
		{ runId: Digest; abort: AbortController; done: Promise<void> }
	>();

	const check = async (
		request: DiagnosisRequest,
	): Promise<"checking" | "settled"> => {
		const root = join(request.dir, "diagnosis", request.bindingDigest);
		const intentPath = join(root, "intent.json");

		if (jobs.has(root)) return "checking";

		if (present(intentPath)) {
			const intent = objectOf(parseJson(regularText(intentPath)));

			const startedAt = countOf(jsonField(intent, "startedAt")),
				deadline = countOf(jsonField(intent, "deadline")),
				unit = textOf(jsonField(intent, "scope"));

			if (
				startedAt === null ||
				deadline === null ||
				deadline < startedAt ||
				unit === null ||
				jsonField(intent, "bindingDigest") !== request.bindingDigest
			)
				throw new Error("diagnosis_intent_invalid");
			const completed = completedDiagnosis(root);

			if (completed !== null) {
				request.finish(completed);

				return "settled";
			}

			await stopScope(unit);
			keepValidationFile(
				join(root, "interrupted.json"),
				`${JSON.stringify({ wallMs: deadline - startedAt, tokens: 0 })}\n`,
			);
			request.interrupted();

			return "settled";
		}

		const startedAt = Date.now();
		const deadline = startedAt + Math.min(180_000, request.allowanceMs);

		const scope = scopeUnit(
			scopeOwner(config.stateDir),
			request.runId,
			"diagnosis",
			request.round,
			randomBytes(4).toString("hex"),
		);

		privateDir(join(request.dir, "diagnosis"));
		privateDir(root);
		exclusive(
			intentPath,
			`${JSON.stringify({ bindingDigest: request.bindingDigest, gateSha: request.gateSha, candidateSha: request.candidateSha, startedAt, deadline, scope })}\n`,
		);
		const abort = new AbortController();
		const late = () => abort.signal.aborted || Date.now() >= deadline;

		const acquireBy =
			deadline - Math.min(5_000, Math.floor((deadline - startedAt) / 10));

		const work = [
			"gate",
			"candidate",
			"materialized",
			"replay",
			"base",
			"gate-meta",
			"candidate-meta",
		];

		const done = (async () => {
			let timedOut = false;

			const acquire = async (sha: GitSha, name: string) => {
				const tree = join(root, name);
				await mkdir(tree, { recursive: true, mode: 0o700 });

				if (late()) return false;

				const checked = await checkoutTree({
					stateDir: join(root, `${name}-meta`),
					runId: request.runId,
					workspace: tree,
					repo: request.repo,
					sha,
					fetch: config.fetch ?? ghTarball,
					signal: abort.signal,
					deadline: acquireBy,
				});

				timedOut ||= checked.kind === "timeout";

				return checked.kind === "ready" && checked.omitted === 0;
			};

			const gate = join(root, "gate"),
				candidate = join(root, "candidate");

			const acquired =
				(await acquire(request.gateSha, "gate")) &&
				(await acquire(request.candidateSha, "candidate"));

			let facts: DiagnosisFacts = {
				base: request.base.kind === "stored" ? request.base.receipt : null,
				baseRefusal: null,
				ignoredChanges: null,
				replay: null,
				dependencies: null,
			};

			if (!acquired || late())
				facts = {
					...facts,
					replay: {
						kind: "unavailable",
						reason:
							timedOut || late() || Date.now() >= acquireBy
								? "timeout"
								: "unsupported_tree",
						wallMs: Date.now() - startedAt,
					},
				};
			else {
				if (request.needs.dependencies)
					facts = { ...facts, dependencies: dependencyFacts(gate, candidate) };

				if (request.needs.replay && request.base.kind === "fresh") {
					const { receipt, assessment } = assessBase(
						await runHeldoutBase({
							tree: gate,
							workDir: join(root, "base"),
							cacheDir: join(config.stateDir, "base-dependencies"),
							binding: request.base.binding,
							contract: request.base.contract,
							suite: request.base.suite,
							canary: request.base.canary,
							startedAt: Date.now(),
							deadline,
							scope,
							signal: abort.signal,
							runner: config.runner,
						}),
					);

					keepValidationFile(
						join(root, "refreshed-base.json"),
						JSON.stringify(receipt),
					);
					facts = {
						...facts,
						base: receipt,
						baseRefusal:
							assessment.kind === "refused" ? assessment.failure.reason : null,
					};
				}

				if (request.needs.replay && !sameMaterializer(gate, materializerSource))
					facts = {
						...facts,
						replay: {
							kind: "unavailable",
							reason: "unsupported_materializer",
							wallMs: Date.now() - startedAt,
						},
					};
				else if (request.needs.replay) {
					const materialized = join(root, "materialized");
					let ignoredChanges: readonly string[] | null = null;

					try {
						ignoredChanges = (config.materialize ?? materializeFromDirectories)(
							{
								gateTree: gate,
								candidateTree: candidate,
								dest: materialized,
								replacements: request.replacements,
								heldoutDir: request.heldoutDir,
								heldoutDigest: request.heldoutDigest,
							},
						).ignoredChanges;
					} catch {
						ignoredChanges = null;
					}

					facts = {
						...facts,
						ignoredChanges,
						replay:
							ignoredChanges === null
								? {
										kind: "unavailable",
										reason: "unsupported_tree",
										wallMs: Date.now() - startedAt,
									}
								: await replayHeldoutCandidate({
										gateTree: materialized,
										fullTree: candidate,
										gates: join(gate, ".github/factory/gates"),
										heldoutDir: request.heldoutDir,
										heldoutDigest: request.heldoutDigest,
										workDir: join(root, "replay"),
										cacheDir: join(config.stateDir, "base-dependencies"),
										deadline,
										scope,
										signal: abort.signal,
										runner: config.runner,
									}),
					};
				}
			}

			for (const name of work)
				await rm(join(root, name), { recursive: true, force: true });
			keepValidationFile(
				join(root, "replay.json"),
				`${JSON.stringify(facts)}\n`,
			);
			keepValidationFile(
				join(root, "charge.json"),
				`${JSON.stringify({ wallMs: Date.now() - startedAt, tokens: 0 })}\n`,
			);
			request.finish(facts);
		})().finally(async () => {
			for (const name of work)
				await rm(join(root, name), { recursive: true, force: true }).catch(
					() => undefined,
				);
			jobs.delete(root);
		});

		jobs.set(root, { runId: request.runId, abort, done });
		void done.catch(() => {});

		return "checking";
	};

	return {
		check,
		async stop(runId: Digest) {
			const owned = [...jobs.values()].filter((j) => j.runId === runId);

			for (const job of owned) job.abort.abort();
			await Promise.allSettled(owned.map((j) => j.done));
		},
	};
}

export function fileRunFiles(
	stateDir: string,
	policySource?: { readonly fetch?: TarballFetch },
): RunFiles {
	const root = resolve(stateDir);
	const claims = join(root, "claims");
	const workspaces = join(root, "workspaces");
	const contracts = join(root, "contracts");
	const links = join(root, "links");
	const answers = join(root, "answers");

	const policyPins = new Map<
		GitSha,
		{ workflowDigest: Digest; gatesDigest: Digest; runTokenCap: number }
	>();

	const workspacePath = (runId: string) => join(workspaces, runId);

	const ensure = async (dir: string) => {
		try {
			await mkdir(dir, { recursive: true, mode: 0o700 });

			return true;
		} catch {
			return false;
		}
	};

	return {
		workspacePath,
		artifacts: fileArtifacts(root),
		ledger: fileLedgerOutbox(root),
		accounting: fileRunAccounting(root),
		terminalEvidence: (runId, floor, candidate) =>
			readTerminalEvidence(root, runId, floor, candidate),
		prepareRun:
			policySource === undefined
				? undefined
				: async (input) => {
						const accounting = fileRunAccounting(root);
						const existing = await accounting.start(input.runId);
						const manifest = await readVerificationContext(root);

						if (
							existing === undefined ||
							manifest.kind === "refused" ||
							(manifest.kind === "pinned" && manifest.repo !== input.repo)
						)
							return false;

						const verification = manifest.kind === "pinned" ? manifest : null;

						if (existing !== null) {
							const pinned = contextPolicy(existing.context);
							const context = existing.context;

							const manifestDigest =
								context.kind === "verification"
									? context.manifestDigest
									: context.kind === "legacy"
										? (context.known.verification?.manifestDigest ?? null)
										: null;

							return (
								pinned?.workflowSha === input.workflowSha &&
								pinned.workflowDigest === input.workflowDigest &&
								pinned.gates.kind === "known" &&
								manifestDigest === (verification?.digest ?? null)
							);
						}

						const begin = (gatesDigest: Digest, runTokenCap: number) => {
							const policy = {
								workflowSha: input.workflowSha,
								workflowDigest: input.workflowDigest,
								gates: {
									kind: "known",
									value: {
										sourceSha: input.workflowSha,
										digest: gatesDigest,
									},
								},
								autonomy: {
									approveMerge: "always",
									land: "propose",
									digest: AUTONOMY_DIGEST,
								},
							} as const;

							const context =
								verification === null
									? ({
											kind: "production",
											policy,
											trustedCap: runTokenCap,
										} as const)
									: ({
											kind: "verification",
											policy,
											trustedCap: runTokenCap,
											manifestDigest: verification.digest,
											effectiveCap: Math.min(
												runTokenCap,
												verification.tokenCap,
											),
										} as const);

							return accounting.begin({
								v: 2,
								runId: input.runId,
								startedAt: input.startedAt,
								context,
							});
						};

						const cached = policyPins.get(input.workflowSha);

						if (cached !== undefined)
							return (
								cached.workflowDigest === input.workflowDigest &&
								(await begin(cached.gatesDigest, cached.runTokenCap))
							);
						let scratch: string | null = null;

						try {
							privateDir(root);
							scratch = await mkdtemp(join(root, "policy-"));
							const workspace = join(scratch, "source");
							await mkdir(workspace, { mode: 0o700 });

							const checked = await checkoutWorkspace({
								stateDir: scratch,
								workspace,
								runId: input.runId,
								repo: input.repo,
								sha: input.workflowSha,
								fetch: policySource.fetch ?? ghTarball,
							});

							if (checked.kind !== "ready" || checked.omitted !== 0)
								return false;

							const workflow = await readFile(
								join(workspace, ".github/factory/WORKFLOW.md"),
							);

							if (digestOf(workflow) !== input.workflowDigest) return false;

							const parsed = parseWorkflow({
								text: workflow.toString("utf8"),
								repo: input.repo,
								env: (name) => process.env[name],
							});

							if (parsed.kind !== "valid") return false;

							const runTokenCap = parsed.config.usage.maxTokensPerRun;

							const gatesDigest = baseTreeDigest(
								join(workspace, ".github/factory/gates"),
							);

							policyPins.set(input.workflowSha, {
								workflowDigest: input.workflowDigest,
								gatesDigest,
								runTokenCap,
							});

							return begin(gatesDigest, runTokenCap);
						} catch {
							return false;
						} finally {
							if (scratch !== null)
								await rm(scratch, { recursive: true, force: true });
						}
					},
		async readContract(runId) {
			return readStoredContract(root, runId);
		},

		async writeContract({ contract, bytes, digest }) {
			const dir = join(contracts, contract.runId);

			const receipt = {
				version: 1,
				runId: contract.runId,
				contractDigest: digest,
				bytes: Buffer.byteLength(bytes, "utf8"),
				baseSha: contract.base.sha,
				snapshotDigest: contract.snapshot.digest,
				answersDigest: contract.link?.answersDigest ?? null,
			};

			return (
				(await ensure(contracts)) &&
				(await writeOnce(join(dir, "contract.json"), bytes)) &&
				(await writeOnce(
					join(dir, "receipt.json"),
					`${JSON.stringify(receipt, null, "\t")}\n`,
				))
			);
		},

		async writeQuestions({ runId, questions, digest }) {
			return (
				(await ensure(contracts)) &&
				(await writeOnce(
					join(contracts, runId, "questions.json"),
					`${JSON.stringify({ version: 1, runId, digest, questions }, null, "\t")}\n`,
				))
			);
		},

		async writeLink(runId, link) {
			return (
				(await ensure(links)) &&
				(await writeAtomic(
					join(links, `${runId}.json`),
					`${JSON.stringify(link === null ? { version: 1, prevRunId: null } : { version: 1, ...link })}\n`,
				))
			);
		},

		async readLink(runId) {
			try {
				return parseLink(await readFile(join(links, `${runId}.json`), "utf8"));
			} catch (error) {
				return (error instanceof Error ? errorCode(error) : null) === "ENOENT"
					? { kind: "none" }
					: { kind: "unreadable" };
			}
		},

		async writeAnswers(record) {
			return (
				(await ensure(answers)) &&
				(await writeAtomic(
					join(answers, `${record.runId}.json`),
					`${JSON.stringify(record, null, "\t")}\n`,
				))
			);
		},

		async readAnswers(runId) {
			const text = await readFile(join(answers, `${runId}.json`), "utf8").catch(
				() => null,
			);

			return text === null ? null : parseAnswers(text, runId);
		},

		async workspaceState(runId) {
			try {
				const info = await lstat(workspacePath(runId));

				return info.isDirectory() ? "present" : "unavailable";
			} catch (error) {
				return (error instanceof Error ? errorCode(error) : null) === "ENOENT"
					? "missing"
					: "unavailable";
			}
		},

		async ensureWorkspace(runId) {
			try {
				await mkdir(workspaces, { recursive: true, mode: 0o700 });
				await mkdir(workspacePath(runId), { mode: 0o700 });

				return "created";
			} catch (error) {
				if ((error instanceof Error ? errorCode(error) : null) !== "EEXIST")
					return "unavailable";
			}

			const info = await lstat(workspacePath(runId)).catch(() => null);

			return info?.isDirectory() === true ? "present" : "unavailable";
		},

		async listClaims() {
			let names: string[];

			try {
				names = await readdir(claims);
			} catch {
				return [];
			}

			const records: ClaimRecord[] = [];

			for (const name of names.filter((entry) => entry.endsWith(".json"))) {
				const text = await readFile(join(claims, name), "utf8").catch(() => "");

				const claim = parseClaim(text);

				if (claim !== null && `${claim.runId}.json` === name) {
					records.push(claim);
				}
			}

			return records;
		},

		async writeClaim(claim) {
			try {
				const book = claim.handoff;

				if (book?.kind === "selected") {
					for (const evidence of candidateGenerations(book)) {
						const dir = validationDir(
							root,
							claim.runId,
							evidence.intent.round,
							evidence.intent.generation,
						);

						privateDir(dir);

						if (
							!(await writeOnce(
								join(dir, "generation.json"),
								`${JSON.stringify(evidence.intent)}\n`,
							))
						)
							return false;

						if (
							book.history.some(
								(entry) => entry.intent.digest === evidence.intent.digest,
							) &&
							!(await writeOnce(
								join(dir, "archive.json"),
								`${JSON.stringify(evidence)}\n`,
								migrateEvidenceValue,
							))
						)
							return false;

						if (
							evidence.certification !== null &&
							!(await writeOnce(
								join(dir, "certification.json"),
								`${JSON.stringify(evidence.certification)}\n`,
								migrateCertificationValue,
							))
						)
							return false;
					}

					for (const account of book.accounts) {
						const e = account.execution;

						const dir = join(
							root,
							"stages",
							claim.runId,
							`${e.stage}-r${e.round}-${e.attempt}`,
						);

						privateDir(dir);

						if (
							!(await writeOnce(
								join(dir, "execution.json"),
								`${JSON.stringify(e)}\n`,
							))
						)
							return false;
					}
				}

				await mkdir(claims, { recursive: true, mode: 0o700 });
			} catch {
				return false;
			}

			return writeAtomic(
				join(claims, `${claim.runId}.json`),
				`${JSON.stringify(claim)}\n`,
			);
		},
	};
}

async function syncDirectory(dir: string): Promise<boolean> {
	try {
		const handle = await open(dir, "r");

		try {
			await handle.sync();
		} finally {
			await handle.close();
		}

		return true;
	} catch {
		return false;
	}
}

async function installOnce(path: string, text: string): Promise<boolean> {
	const existing = await readFile(path, "utf8").catch(() => null);

	if (existing !== null) return existing === text;

	try {
		await mkdir(dirname(path), { recursive: true, mode: 0o700 });
	} catch {
		return false;
	}

	return (
		(await writeAtomic(path, text)) && (await syncDirectory(dirname(path)))
	);
}

export function fileRunAccounting(stateDir: string): RunAccounting {
	const root = join(resolve(stateDir), "accounting");
	const attempts = (runId: Digest) => join(root, runId, "attempts");

	const name = (stage: string, round: number, attempt: number) =>
		`${stage}-r${round}-${attempt}.json`;

	return {
		async start(runId) {
			try {
				const value = parseJsonText(
					await readFile(join(root, runId, "policy.json"), "utf8"),
				);

				const manifest =
					jsonField(objectOf(value), "v") === 1
						? await readVerificationContext(resolve(stateDir))
						: null;

				if (manifest?.kind === "refused") return undefined;

				const parsed = parseRunStart(
					value,
					manifest?.kind === "pinned" ? manifest : null,
				);

				return parsed?.runId === runId ? parsed : undefined;
			} catch (error) {
				return error instanceof Error && errorCode(error) === "ENOENT"
					? null
					: undefined;
			}
		},
		async begin(record) {
			if (parseRunStart(record) === null) return false;

			return installOnce(
				join(root, record.runId, "policy.json"),
				`${JSON.stringify(record)}\n`,
			);
		},
		async readAttempt(runId, stage, round, attempt) {
			try {
				const parsed = parseAttemptEnd(
					parseJsonText(
						await readFile(
							join(attempts(runId), name(stage, round, attempt)),
							"utf8",
						),
					),
				);

				return parsed?.runId === runId &&
					parsed.stage === stage &&
					parsed.round === round &&
					parsed.attempt === attempt
					? parsed
					: undefined;
			} catch (error) {
				return error instanceof Error && errorCode(error) === "ENOENT"
					? null
					: undefined;
			}
		},
		async writeAttempt(record) {
			return installOnce(
				join(
					attempts(record.runId),
					name(record.stage, record.round, record.attempt),
				),
				`${JSON.stringify(record)}\n`,
			);
		},
		async attempts(runId) {
			try {
				const entries = await readdir(attempts(runId)).catch(
					(error: NodeJS.ErrnoException) =>
						error.code === "ENOENT" ? [] : Promise.reject(error),
				);

				const records: AttemptEnd[] = [];

				for (const entry of entries) {
					const record = parseAttemptEnd(
						parseJsonText(await readFile(join(attempts(runId), entry), "utf8")),
					);

					if (
						record === null ||
						record.runId !== runId ||
						entry !== name(record.stage, record.round, record.attempt)
					)
						return null;
					records.push(record);
				}

				return records;
			} catch {
				return null;
			}
		},
	};
}

/** The verification manifest's name in a verification state directory. */
export const VERIFICATION_FILE = "verification.json";

async function readVerificationContext(stateDir: string) {
	const text = await readFile(join(stateDir, VERIFICATION_FILE), "utf8").catch(
		(error: NodeJS.ErrnoException) =>
			error.code === "ENOENT" ? null : undefined,
	);

	if (text === null) return { kind: "production" } as const;

	if (text === undefined) return { kind: "refused" } as const;
	const object = objectOf(parseJsonText(text));
	const repo = textOf(jsonField(object, "repo"));
	const tokenCap = countOf(jsonField(object, "tokenCap"));
	const issues = arrayOf(jsonField(object, "issues"))?.map(countOf);

	if (
		object?.v !== 1 ||
		repo === null ||
		!isRepoSlug(repo) ||
		tokenCap === null ||
		tokenCap === 0 ||
		issues === undefined ||
		issues.length === 0 ||
		issues.some((issue) => issue === null || issue === 0) ||
		text !==
			`${JSON.stringify({ v: 1, repo, issues: [...new Set(issues)].sort((a, b) => (a ?? 0) - (b ?? 0)), tokenCap })}\n`
	)
		return { kind: "refused" } as const;

	return { kind: "pinned", repo, digest: digestOf(text), tokenCap } as const;
}

export type VerificationPin =
	| { readonly kind: "production" }
	| {
			readonly kind: "pinned";
			readonly digest: Digest;
			readonly tokenCap: number;
	  }
	| {
			readonly kind: "refused";
			readonly reason:
				| "verification_state"
				| "verification_state_not_new"
				| "verification_manifest_mismatch"
				| "verification_unwritable";
	  };

/**
 * Binds a verification-only token cap to its state directory. The first
 * run writes `verification.json`, naming the repo, the issue scope and the
 * cap, into a directory that holds nothing but the lock. Every later run
 * must name the same bytes, and a run without the cap refuses a directory
 * that has one, so verification rows never mix with production state.
 */
export async function pinVerification(
	stateDir: string,
	wanted: {
		readonly repo: RepoSlug;
		readonly issues: readonly number[];
		readonly tokenCap: number;
	} | null,
): Promise<VerificationPin> {
	const path = join(stateDir, VERIFICATION_FILE);

	const existing = await readFile(path, "utf8").catch(
		(error: NodeJS.ErrnoException) =>
			error.code === "ENOENT" ? null : undefined,
	);

	if (existing === undefined)
		return { kind: "refused", reason: "verification_state" };

	if (wanted === null)
		return existing === null
			? { kind: "production" }
			: { kind: "refused", reason: "verification_state" };

	const text = `${JSON.stringify({
		v: 1,
		repo: wanted.repo,
		issues: [...new Set(wanted.issues)].sort((a, b) => a - b),
		tokenCap: wanted.tokenCap,
	})}\n`;

	if (existing !== null)
		return existing === text
			? { kind: "pinned", digest: digestOf(text), tokenCap: wanted.tokenCap }
			: { kind: "refused", reason: "verification_manifest_mismatch" };

	const entries = await readdir(stateDir).catch(() => null);

	if (entries === null || entries.some((name) => name !== HOLDER_FILE))
		return { kind: "refused", reason: "verification_state_not_new" };

	return (await installOnce(path, text))
		? { kind: "pinned", digest: digestOf(text), tokenCap: wanted.tokenCap }
		: { kind: "refused", reason: "verification_unwritable" };
}

/**
 * The controller-private ledger outbox under `<state>/ledger`. Each run's
 * terminal snapshot and row are write-once; only its retry record and the
 * shared anchor are replaced.
 */
export function fileLedgerOutbox(stateDir: string): LedgerOutbox {
	const root = join(resolve(stateDir), "ledger");
	const dirOf = (runId: string) => join(root, runId);

	const readText = (path: string) =>
		readFile(path, "utf8").then(
			(text) => text,
			(error: NodeJS.ErrnoException) =>
				error.code === "ENOENT" ? null : Promise.reject(error),
		);

	const invalidJob = async (
		runId: Digest,
		observedAt: string | null,
	): Promise<OutboxJob> => ({
		runId,
		observedAt:
			observedAt ??
			(await stat(dirOf(runId)).then(
				(info) => info.mtime.toISOString(),
				() => new Date(0).toISOString(),
			)),
		row: null,
		retry: { attempts: 1, nextAt: 0, reason: "state_invalid", blocked: true },
		adoption: null,
	});

	/** One job, `null` when it is published or not yet enrolled; a corrupt record blocks only it. */
	const jobOf = async (runId: Digest): Promise<OutboxJob | null> => {
		const dir = dirOf(runId);
		let observedAt: string | null = null;

		try {
			if ((await readText(join(dir, "published.json"))) !== null) return null;
			const terminal = await readText(join(dir, "terminal.json"));

			if (terminal === null) {
				const blocked = await readText(join(dir, "blocked.json"));

				if (blocked === null) return null;

				const at = textOf(
					jsonField(objectOf(parseJsonText(blocked)), "observedAt"),
				);

				if (at === null || !validLedgerInstant(at))
					return invalidJob(runId, null);

				return {
					runId,
					observedAt: at,
					row: null,
					retry: {
						attempts: 1,
						nextAt: 0,
						reason: "row_invalid",
						blocked: true,
					},
					adoption: null,
				};
			}

			observedAt = textOf(
				jsonField(objectOf(parseJsonText(terminal)), "terminalObservedAt"),
			);

			if (observedAt === null) return invalidJob(runId, null);

			const rowBytes = await readFile(join(dir, "row.json")).catch(
				(error: NodeJS.ErrnoException) =>
					error.code === "ENOENT" ? null : Promise.reject(error),
			);

			const row = rowBytes === null ? null : frozenRowOf(rowBytes);

			if (rowBytes !== null && row === null)
				return invalidJob(runId, observedAt);
			const retryText = await readText(join(dir, "retry.json"));

			const retry =
				retryText === null ? null : parseRetry(parseJsonText(retryText));

			if (retryText !== null && retry === null)
				return invalidJob(runId, observedAt);
			const adoptionText = await readText(join(dir, "adoption.json"));

			const adoption =
				adoptionText === null
					? null
					: parseAdoption(parseJsonText(adoptionText));

			if (adoptionText !== null && adoption === null)
				return invalidJob(runId, observedAt);

			return { runId, observedAt, row, retry, adoption };
		} catch {
			return invalidJob(runId, observedAt);
		}
	};

	return {
		async prepare(runId, snapshot) {
			const path = join(dirOf(runId), "terminal.json");
			const existing = await readFile(path, "utf8").catch(() => null);

			if (existing !== null) return parseJsonText(existing) !== undefined;

			return installOnce(path, `${JSON.stringify(snapshot)}\n`);
		},
		async block(runId, observedAt) {
			const path = join(dirOf(runId), "blocked.json");
			const existing = await readFile(path, "utf8").catch(() => null);

			if (existing !== null) return true;

			return installOnce(path, `${JSON.stringify({ v: 1, observedAt })}\n`);
		},
		async freeze(runId, marker) {
			const dir = dirOf(runId);
			const stored = await readFile(join(dir, "row.json")).catch(() => null);

			if (stored !== null)
				return frozenRowOf(stored)?.row.runId === runId ? "frozen" : "invalid";

			const terminal = await readFile(join(dir, "terminal.json"), "utf8").catch(
				() => null,
			);

			if (terminal === null) return "absent";
			const snapshot = objectOf(parseJsonText(terminal));

			if (snapshot === null) return "invalid";
			let bytes: Buffer;

			try {
				const row = ledgerRowOf({
					...snapshot,
					terminalMarker: { seq: marker.seq, digest: marker.digest },
				});

				if (row.row.runId !== runId) return "invalid";
				bytes = row.bytes;
			} catch (error) {
				if (error instanceof LedgerRowError) return "invalid";
				throw error;
			}

			return (await installOnce(join(dir, "row.json"), bytes.toString()))
				? "frozen"
				: "unwritable";
		},
		async scan() {
			try {
				const names = await readdir(root).catch(
					(error: NodeJS.ErrnoException) =>
						error.code === "ENOENT" ? [] : Promise.reject(error),
				);

				const jobs: OutboxJob[] = [];

				for (const runId of names.sort()) {
					if (!isDigest(runId)) continue;
					const job = await jobOf(runId);

					if (job !== null) jobs.push(job);
				}

				return jobs;
			} catch {
				return null;
			}
		},
		async anchor() {
			try {
				const text = await readText(join(root, "anchor.json"));

				if (text !== null) return parseAnchor(parseJsonText(text)) ?? "invalid";

				const names = await readdir(root).catch(
					(error: NodeJS.ErrnoException) =>
						error.code === "ENOENT" ? [] : Promise.reject(error),
				);

				for (const runId of names)
					if (
						isDigest(runId) &&
						(await lstat(join(dirOf(runId), "published.json")).then(
							() => true,
							(error: NodeJS.ErrnoException) =>
								error.code === "ENOENT" ? false : Promise.reject(error),
						))
					)
						return "orphaned";

				return null;
			} catch {
				return "invalid";
			}
		},
		async published(receipt, anchor) {
			const installed = await installOnce(
				join(dirOf(receipt.runId), "published.json"),
				`${JSON.stringify(receipt)}\n`,
			);

			if (!installed) return false;
			await writeAtomic(
				join(root, "anchor.json"),
				`${JSON.stringify(anchor)}\n`,
			);

			return true;
		},
		async adoption(runId, cursor) {
			return writeAtomic(
				join(dirOf(runId), "adoption.json"),
				`${JSON.stringify(cursor)}\n`,
			);
		},
		async retry(runId, retry) {
			try {
				await mkdir(dirOf(runId), { recursive: true, mode: 0o700 });
			} catch {
				return false;
			}

			return writeAtomic(
				join(dirOf(runId), "retry.json"),
				`${JSON.stringify(retry)}\n`,
			);
		},
	};
}

/** Read-only per-run token floors; aggregate execution receipts cover their descendants. */
function validLedgerInstant(value: string): boolean {
	if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{3})?Z$/.test(value))
		return false;
	const time = Date.parse(value);

	return (
		Number.isFinite(time) &&
		new Date(time).toISOString() === value.replace(/(?<!\.[0-9]{3})Z$/, ".000Z")
	);
}

const EXECUTION_NAME =
	/^(specify|accept|build|review)(?:-r[0-9]+)?-[1-9][0-9]*(?:\.[1-9][0-9]*)?$/;

/** Receipt coverage is independent of token splits and wall-time accounting. */
async function tokenCoverage(stateDir: string, runId: Digest) {
	const { readStageReceipt, executionCharge } = await import("./sandbox.ts");
	const root = join(resolve(stateDir), "stages", runId);

	const names = await readdir(root).catch((error: NodeJS.ErrnoException) =>
		error.code === "ENOENT" ? [] : null,
	);

	const attempts = await fileRunAccounting(stateDir).attempts(runId);
	const stages = new Map<string, boolean>();
	const covered = new Set<string>();

	for (const name of names ?? []) {
		const stage = EXECUTION_NAME.exec(name)?.[1];

		if (stage === undefined) continue;
		const receipt = await readStageReceipt(join(root, name, "receipt.json"));
		const charge = await executionCharge(join(root, name)).catch(() => null);

		const valid =
			receipt !== null &&
			charge !== null &&
			jsonField(receipt.record, "runId") === runId &&
			jsonField(receipt.record, "stage") === stage &&
			jsonField(receipt.record, "attempt") ===
				Number(/-([1-9][0-9]*)(?:\.[1-9][0-9]*)?$/.exec(name)?.[1]) &&
			jsonField(receipt.record, "version") === 1;

		stages.set(stage, (stages.get(stage) ?? true) && valid);

		if (valid) covered.add(name);
	}

	for (const attempt of attempts ?? []) {
		const valid =
			covered.has(`${attempt.stage}-r${attempt.round}-${attempt.attempt}`) ||
			(attempt.round === 0 &&
				covered.has(`${attempt.stage}-${attempt.attempt}`));

		stages.set(attempt.stage, (stages.get(attempt.stage) ?? true) && valid);
	}

	return {
		stages,
		readable: names !== null && attempts !== null,
		complete:
			stages.size > 0 &&
			names !== null &&
			attempts !== null &&
			[...stages.values()].every(Boolean),
	};
}

/** Project only validated controller-private records; never scan a workspace. */
export async function readTerminalEvidence(
	stateDir: string,
	runId: Digest,
	floor: number,
	candidate: CandidateState | null,
): Promise<TerminalEvidence> {
	const { executionCharge, executionEfficiency, readStageReceipt } =
		await import("./sandbox.ts");

	const { aggregateEfficiency, unknownEfficiency } = await import(
		"./sandbox/result.ts"
	);

	const root = join(resolve(stateDir), "stages", runId);

	const listed = await readdir(root).catch((error: NodeJS.ErrnoException) =>
		error.code === "ENOENT" ? [] : null,
	);

	const names = (listed ?? [])
		.filter((name) => EXECUTION_NAME.test(name))
		.sort((a, b) => a.localeCompare(b, undefined, { numeric: true }));

	const coverage = await tokenCoverage(stateDir, runId);
	const accounting = fileRunAccounting(stateDir);
	const attempts = await accounting.attempts(runId);
	const start = await accounting.start(runId);
	const known = <T>(value: T) => ({ kind: "known" as const, value });

	const missing = {
		kind: "unavailable" as const,
		reason: "receipt_missing" as const,
	};

	const stages = new Map<
		Stage,
		{
			total: number;
			uncertain: number;
			wall: number;
			wallComplete: boolean;
			efficiency: import("./sandbox/result.ts").EfficiencyFacts[];
		}
	>();

	const models = new Map<
		string,
		NonNullable<ReturnType<typeof ledgerModelOf>>
	>();

	const digests = new Set<Digest>();

	const executions: {
		facts: import("./sandbox/result.ts").EfficiencyFacts;
		started: number | null;
	}[] = [];

	let total = 0,
		uncertain = 0,
		parent = 0,
		children = 0;

	let splitComplete = true;

	const stageOf = (stage: Stage) => {
		let value = stages.get(stage);

		if (value === undefined) {
			value = {
				total: 0,
				uncertain: 0,
				wall: 0,
				wallComplete: true,
				efficiency: [],
			};
			stages.set(stage, value);
		}

		return value;
	};

	for (const name of names) {
		const stageName = EXECUTION_NAME.exec(name)?.[1];

		if (
			stageName !== "specify" &&
			stageName !== "accept" &&
			stageName !== "build" &&
			stageName !== "review"
		)
			continue;
		const dir = join(root, name);
		const charge = await executionCharge(dir).catch(() => null);
		const summary = stageOf(stageName);

		const efficiency = await executionEfficiency(dir).catch(() =>
			unknownEfficiency(),
		);

		const high = objectOf(
			parseJsonText(
				await readFile(join(dir, "usage.json"), "utf8").catch(() => ""),
			),
		);

		summary.efficiency.push(efficiency);
		executions.push({
			facts: efficiency,
			started: countOf(jsonField(high, "startedAt")),
		});
		summary.total += charge?.total ?? 0;
		summary.uncertain += charge?.uncertain ?? 0;
		total += charge?.total ?? 0;
		uncertain += charge?.uncertain ?? 0;
		const receipt = await readStageReceipt(join(dir, "receipt.json"));

		const valid =
			receipt !== null &&
			jsonField(receipt.record, "runId") === runId &&
			jsonField(receipt.record, "stage") === stageName &&
			jsonField(receipt.record, "version") === 1;

		if (valid) {
			summary.wall += receipt.wallMs;
			const usage = objectOf(jsonField(receipt.record, "usage"));
			const p = countOf(jsonField(usage, "parent"));
			const c = countOf(jsonField(usage, "children"));

			if (
				p === null ||
				c === null ||
				p + c > receipt.usage.total ||
				receipt.usage.unreadChildren > 0
			)
				splitComplete = false;
			else {
				parent += p;
				children += c;
			}
		} else {
			splitComplete = false;
			summary.wallComplete = false;
		}

		const sessionNames = [
			"draft",
			"review",
			"revision",
			"code-review",
			"security-review",
			"simplify",
			"ultrareview",
		];

		const sessions = (
			await readdir(dir, { withFileTypes: true }).catch(() => [])
		).filter(
			(entry) => entry.isDirectory() && sessionNames.includes(entry.name),
		);

		const paths = [
			join(dir, "receipt.json"),
			...sessions.map((entry) => join(dir, entry.name, "receipt.json")),
		];

		for (const path of paths) {
			const saved = await readStageReceipt(path);

			if (
				saved === null ||
				jsonField(saved.record, "runId") !== runId ||
				jsonField(saved.record, "stage") !== stageName ||
				jsonField(saved.record, "version") !== 1
			)
				continue;
			const bytes = await readFile(path);
			digests.add(digestOf(bytes));

			if (sessions.length > 0 && path === paths[0]) continue;
			const rawModels = objectOf(jsonField(saved.record, "models"));
			const versions = objectOf(jsonField(saved.record, "versions"));

			const runtime = {
				pi: jsonField(versions, "pi") ?? null,
				agents: jsonField(versions, "piHerdrAgents") ?? null,
				pstack: jsonField(versions, "piHerdrPstack") ?? null,
				assetsDigest: jsonField(saved.record, "assetsDigest") ?? null,
			};

			for (const identity of [
				rawModels,
				objectOf(jsonField(saved.record, "fallback")),
			]) {
				if (identity === null) continue;
				const observed = textOf(jsonField(identity, "observed"));

				const input = {
					requested: jsonField(identity, "requested") ?? null,
					observed:
						observed === null
							? { kind: "unavailable", reason: "provider_not_reported" }
							: known(observed),
					providerVersion: {
						kind: "unavailable",
						reason: "provider_not_reported",
					},
					runtime: known(runtime),
					executions: 1,
				};

				const projected =
					ledgerModelOf(input) ?? ledgerModelOf({ ...input, runtime: missing });

				if (projected !== null) {
					const key = JSON.stringify([
						projected.requested,
						projected.observed,
						projected.runtime,
					]);

					const previous = models.get(key);
					models.set(key, {
						...projected,
						executions: (previous?.executions ?? 0) + 1,
					});
				}
			}
		}
	}

	const uncovered = floor > total;
	total = Math.max(total, floor);

	const summaries: Extract<LedgerRow["stages"], { kind: "known" }>["value"] =
		[];

	for (const attempt of attempts ?? []) stageOf(attempt.stage);

	for (const [stage, data] of stages) {
		const ends = attempts?.filter((attempt) => attempt.stage === stage);

		const counts = {
			passed: 0,
			failed: 0,
			interrupted: 0,
			refused: 0,
			budgetExhausted: 0,
			aborted: 0,
		};

		for (const end of ends ?? []) {
			const key = {
				completed: "passed",
				model_failure: "failed",
				interrupted: "interrupted",
				refused: "refused",
				base_refused: "refused",
				budget_stop: "budgetExhausted",
				aborted: "aborted",
			} as const;

			counts[key[end.disposition]]++;
		}

		summaries.push({
			stage,
			efficiency: aggregateEfficiency(data.efficiency),
			wallMs: data.wallComplete
				? { kind: "exact", unit: "milliseconds", total: data.wall }
				: {
						kind: "lower_bound",
						unit: "milliseconds",
						total: data.wall,
						reason: "receipt_missing",
					},
			attempts: ends == null || start == null ? missing : known(counts),
			tokens:
				data.uncertain > 0
					? {
							kind: "uncertain",
							unit: "tokens",
							total: data.total,
							reason: "request_unsettled",
						}
					: coverage.readable && coverage.stages.get(stage) === true
						? { kind: "exact", unit: "tokens", total: data.total }
						: {
								kind: "lower_bound",
								unit: "tokens",
								total: data.total,
								reason: "receipt_missing",
							},
		});
	}

	const stageOrder: readonly Stage[] = [
		"admit",
		"specify",
		"accept",
		"build",
		"validate",
		"review",
		"land",
	];

	summaries.sort(
		(a, b) => stageOrder.indexOf(a.stage) - stageOrder.indexOf(b.stage),
	);

	const orderedModels = [...models]
		.sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
		.map(([, model]) => model);

	const artifactPrefix = async (): Promise<LedgerRow["artifacts"]> => {
		const contract = await readStoredContract(stateDir, runId);

		if (contract.kind !== "found") return { kind: "admission" };

		const suite = await fileArtifacts(stateDir).read(
			runId,
			contract.contract,
			contract.digest,
		);

		if (suite.kind !== "found")
			return { kind: "contract", contractDigest: contract.digest };

		const patch = readPatch(stateDir, {
			runId,
			baseSha: contract.contract.base.sha,
			contractDigest: contract.digest,
			acceptanceDigest: suite.receipt.acceptanceDigest,
		});

		return patch.kind === "found"
			? {
					kind: "built",
					contractDigest: contract.digest,
					acceptanceDigest: suite.receipt.acceptanceDigest,
					patchDigest: patch.receipt.patchDigest,
				}
			: {
					kind: "acceptance",
					contractDigest: contract.digest,
					acceptanceDigest: suite.receipt.acceptanceDigest,
				};
	};

	const invalid = {
		kind: "unavailable" as const,
		reason: "receipt_invalid" as const,
	};

	const evidence: TerminalEvidence =
		listed === null
			? {
					artifacts: await artifactPrefix(),
					stages: invalid,
					models: invalid,
					usage: {
						tokens: {
							kind: "lower_bound",
							unit: "tokens",
							total,
							reason: "receipt_invalid",
						},
						parentTokens: invalid,
						childTokens: invalid,
						unattributedTokens: invalid,
						money: { kind: "unavailable", reason: "provider_not_reported" },
					},
					redactedReceiptDigests: [],
				}
			: {
					artifacts: await artifactPrefix(),
					stages:
						summaries.length === 0 && start == null
							? missing
							: known(summaries),
					models:
						models.size === 0 && (names.length > 0 || start == null)
							? missing
							: known(orderedModels),
					usage: {
						tokens:
							uncertain > 0
								? {
										kind: "uncertain",
										unit: "tokens",
										total,
										reason: "request_unsettled",
									}
								: coverage.complete && !uncovered
									? { kind: "exact", unit: "tokens", total }
									: {
											kind: "lower_bound",
											unit: "tokens",
											total,
											reason: "receipt_missing",
										},
						parentTokens: splitComplete ? known(parent) : missing,
						childTokens: splitComplete ? known(children) : missing,
						unattributedTokens:
							splitComplete && parent + children <= total
								? known(total - parent - children)
								: missing,
						money: { kind: "unavailable", reason: "provider_not_reported" },
					},
					redactedReceiptDigests: [...digests].sort(),
				};

	const generationGates: Record<string, Digest> = {};

	const admittedPolicy = start == null ? null : contextPolicy(start.context);

	if (admittedPolicy?.gates.kind === "known")
		generationGates[admittedPolicy.gates.value.sourceSha] =
			admittedPolicy.gates.value.digest;

	for (const generation of candidate?.kind === "selected"
		? candidateGenerations(candidate)
		: []) {
		const verdict = generation.verdict;
		const expectedSha = verdict?.gateSha ?? generation.intent.baseSha;

		const dir = validationDir(
			stateDir,
			runId,
			generation.intent.round,
			generation.intent.generation,
		);

		try {
			const pin = objectOf(
				parseJsonText(await readFile(join(dir, "gate-policy.json"), "utf8")),
			);

			const digest = textOf(jsonField(pin, "digest"));

			if (
				jsonField(pin, "v") === 1 &&
				jsonField(pin, "runId") === runId &&
				jsonField(pin, "round") === generation.intent.round &&
				jsonField(pin, "generation") === generation.intent.generation &&
				jsonField(pin, "sourceSha") === expectedSha &&
				digest !== null &&
				isDigest(digest)
			)
				generationGates[expectedSha] = digest;
		} catch {
			/* Older generations have only base qualification evidence. */
		}

		try {
			if (verdict === null) continue;

			const bindingDigest = digestOf(
				JSON.stringify(
					assessmentBinding({
						runId,
						round: generation.intent.round,
						generation: generation.intent.generation,
						verdict,
					}),
				),
			);

			const base = parseBaseReceipt(
				await readFile(
					join(
						validationDir(
							stateDir,
							runId,
							generation.intent.round,
							generation.intent.generation,
						),
						"diagnosis",
						bindingDigest,
						"refreshed-base.json",
					),
					"utf8",
				),
			);

			if (
				base?.evidence.binding.runId === runId &&
				base.evidence.binding.repo === candidate?.pin.repo &&
				base.evidence.binding.issue === candidate?.pin.issue &&
				base.evidence.binding.contractDigest ===
					candidate?.pin.contractDigest &&
				base.evidence.binding.acceptanceDigest ===
					candidate?.pin.acceptanceDigest &&
				base.evidence.binding.baseSha === verdict.gateSha &&
				base.evidence.binding.gateSha === verdict.gateSha &&
				base.evidence.source.kind === "ready"
			)
				generationGates[base.evidence.binding.baseSha] =
					base.evidence.source.gatesDigest;
		} catch {
			/* Missing historical base evidence remains unavailable. */
		}
	}

	const terminal =
		candidate?.kind === "selected" && candidate.work.kind === "terminal"
			? candidate.work.terminal
			: null;

	let mergedAt: string | undefined;

	if (terminal?.kind === "merged") {
		try {
			const metadata = objectOf(
				parseJsonText(
					await readFile(
						join(stateDir, "accounting", runId, "merge.json"),
						"utf8",
					),
				),
			);

			const at = textOf(jsonField(metadata, "mergedAt"));

			if (
				jsonField(metadata, "runId") === runId &&
				jsonField(metadata, "repo") === candidate?.pin.repo &&
				jsonField(metadata, "number") === terminal.number &&
				jsonField(metadata, "headSha") === terminal.head &&
				jsonField(metadata, "mergeSha") === terminal.mergeSha &&
				at !== null &&
				validLedgerInstant(at)
			)
				mergedAt = at;
		} catch {
			/* Public merge time is optional, never inferred from observation time. */
		}
	}

	executions.sort((a, b) => (a.started ?? 0) - (b.started ?? 0));
	const endpoints = aggregateEfficiency(executions.map((e) => e.facts));

	const efficiency = uncovered
		? unknownEfficiency()
		: aggregateEfficiency(
				[...stages.values()].map((data) =>
					aggregateEfficiency(data.efficiency),
				),
			);

	const ordered =
		!uncovered &&
		[...stages.values()].every((data) => data.efficiency.length > 0) &&
		executions.every((e) => e.started !== null);

	const omissions = efficiency.excerptOmissions;
	const caps = efficiency.sourceCapHits;

	return {
		...evidence,
		generationGates,
		mergedAt,
		efficiency: {
			...efficiency,
			firstInputTokens: ordered ? endpoints.firstInputTokens : null,
			lastInputTokens: ordered ? endpoints.lastInputTokens : null,
		},
		contextPressure:
			omissions !== null && caps !== null
				? known({ truncated: omissions > 0, promptCapHit: caps > 0 })
				: { kind: "unavailable", reason: "not_instrumented" },
	};
}

export async function readRunCharges(
	stateDir: string,
	runId: Digest,
	floor: number,
) {
	const { executionCharge } = await import("./sandbox.ts");
	const coverage = await tokenCoverage(stateDir, runId);
	let readable = true;
	let total = 0;
	let uncertainRequests = 0;
	let executions = 0;
	const root = join(resolve(stateDir), "stages", runId);

	const names = await readdir(root).catch((error: NodeJS.ErrnoException) => {
		if (error.code !== "ENOENT") readable = false;

		return [];
	});

	for (const name of names) {
		if (!EXECUTION_NAME.test(name)) continue;
		const charge = await executionCharge(join(root, name)).catch(() => null);

		if (charge === null) {
			readable = false;
			continue;
		}

		executions++;
		total += charge.total;
		uncertainRequests += charge.uncertain;
	}

	return {
		runId,
		executions,
		readable,
		uncertainRequests,
		tokens:
			coverage.complete && readable && uncertainRequests === 0 && floor <= total
				? { kind: "exact" as const, unit: "tokens" as const, total }
				: {
						kind:
							uncertainRequests > 0
								? ("uncertain" as const)
								: ("lower_bound" as const),
						unit: "tokens" as const,
						total: Math.max(floor, total),
						reason:
							uncertainRequests > 0
								? ("request_unsettled" as const)
								: ("receipt_missing" as const),
					},
		money: {
			kind: "unavailable" as const,
			reason: "provider_not_reported" as const,
		},
		attempts: await fileRunAccounting(stateDir).attempts(runId),
		terminal: await readFile(
			join(resolve(stateDir), "ledger", runId, "terminal.json"),
			"utf8",
		).then(
			(text) => terminalFailureOf(parseJsonText(text)),
			() => null,
		),
	};
}

export async function readDurableAccounting(
	stateDir: string | null,
	repo: RepoSlug,
) {
	const runs: Awaited<ReturnType<typeof readRunCharges>>[] = [];

	const available =
		stateDir !== null &&
		(await lstat(stateDir).then(
			(info) => info.isDirectory(),
			() => false,
		));

	let readable = available;

	if (stateDir !== null && available) {
		const root = join(resolve(stateDir), "claims");

		const names = await readdir(root).catch((error: NodeJS.ErrnoException) => {
			if (error.code !== "ENOENT") readable = false;

			return [];
		});

		const seen = new Set<Digest>();

		for (const name of names.sort()) {
			if (!/^[a-f0-9]{64}\.json$/.test(name)) continue;
			const text = await readFile(join(root, name), "utf8").catch(() => null);
			const claim = text === null ? null : parseClaim(text);

			if (claim === null || name !== `${claim.runId}.json`) {
				readable = false;
				continue;
			}

			if (seen.has(claim.runId)) continue;

			const admitted = await fileAdmissionStore(stateDir).read({
				repo,
				issue: claim.issue,
				eventId: claim.eventId,
			});

			if (admitted.kind === "unreadable") {
				readable = false;
				continue;
			}

			if (admitted.kind !== "found") continue;
			seen.add(claim.runId);
			const run = await readRunCharges(stateDir, claim.runId, claim.usage ?? 0);
			readable &&= run.readable;
			runs.push(run);
		}
	}

	let maintenance: ReturnType<typeof cadenceCharges> = [];

	if (available && stateDir !== null) {
		try {
			maintenance = cadenceCharges(stateDir, repo);
		} catch {
			readable = false;
		}
	}

	return {
		state: !available ? "unavailable" : readable ? "readable" : "incomplete",
		countersScope: "process",
		runs,
		maintenance: {
			executions: maintenance.length,
			tokens: {
				kind: maintenance.every((charge) => charge.exact)
					? "exact"
					: "lower_bound",
				unit: "tokens",
				total: maintenance.reduce((sum, charge) => sum + charge.tokens, 0),
			},
			money: { kind: "unavailable", reason: "provider_not_reported" },
			entries: maintenance,
		},
	};
}

async function cadenceSwitches(
	stateDir: string,
	adapter: GitHubTicketAdapter,
): Promise<boolean> {
	if ((await fileAdmissionStore(stateDir).localSwitch()) !== "enabled")
		return false;

	const enabled = await adapter.readRepoSwitch();

	return (
		enabled.kind === "ok" &&
		enabled.value.kind === "present" &&
		enabled.value.name === REPO_SWITCH_LABEL
	);
}

/** Local, already-redacted ledger rows only. No sessions, private suites or inferred zeroes. */
async function cadenceLedger(stateDir: string): Promise<string> {
	const root = join(stateDir, "ledger");
	const names = (await readdir(root).catch(() => [])).filter(isDigest);

	const dated = await Promise.all(
		names.map(async (name) => ({
			name,
			at: await stat(join(root, name, "row.json")).then(
				(info) => info.mtimeMs,
				() => 0,
			),
		})),
	);

	const rows: JsonValue[] = [];
	let bytes = 0;

	for (const { name } of dated.sort((a, b) => b.at - a.at).slice(0, 20)) {
		const path = join(root, name, "row.json");
		const info = await lstat(path).catch(() => null);

		if (
			info === null ||
			!info.isFile() ||
			info.isSymbolicLink() ||
			info.size > 128 * 1024
		)
			continue;

		const text = await readFile(path, "utf8");
		const frozen = frozenRowOf(Buffer.from(text));

		if (frozen === null || bytes + Buffer.byteLength(text) > 16 * 1024)
			continue;

		bytes += Buffer.byteLength(text);
		rows.push(parseJsonText(frozen.bytes.toString("utf8")) ?? null);
	}

	return JSON.stringify({
		source: "local_redacted_ledger",
		coverage:
			"at most 20 retained rows and 16 KiB; missing evidence is unknown",
		rows,
	});
}

export async function publishCadenceProposals(input: {
	stateDir: string;
	exec: Exec;
	execution: CadenceInput;
	result: CadenceResult;
	proposals: readonly CadenceProposal[];
}): Promise<boolean> {
	const { execution, result } = input;

	const adapter = new GitHubTicketAdapter({
		exec: input.exec,
		repo: execution.repo,
	});

	const writer = new GitHubTicketWriter({
		exec: input.exec,
		repo: execution.repo,
	});

	const intents = join(input.stateDir, "cadence", execution.job, "proposals");
	cadencePrivateDir(intents);

	for (const proposal of input.proposals) {
		const key = cadenceMarker(
			execution.repo,
			execution.job,
			proposal.fingerprint,
		);

		const path = join(intents, `${proposal.fingerprint}.json`);
		const saved = readCadenceFile(path);
		let body = cadenceIssueBody(proposal, result);

		let title =
			`Factory ${execution.job}: ${inert(proposal.title).replace(/\p{Cc}/gu, " ")}`.slice(
				0,
				220,
			);

		if (saved === null) {
			for (const evidence of proposal.evidence) {
				const source = join(
					cadenceExecutionDir(
						input.stateDir,
						execution.job,
						execution.windowStart,
					),
					"tree",
					evidence.path,
				);

				const info = await lstat(source).catch(() => null);

				if (
					info === null ||
					!info.isFile() ||
					info.isSymbolicLink() ||
					info.size > 1024 * 1024
				)
					return false;

				if (evidence.end > (await readFile(source, "utf8")).split("\n").length)
					return false;
			}

			writeCadenceFile(path, JSON.stringify({ key, title, body }));
		} else {
			const intent = objectOf(parseJsonText(saved));

			const keptBody = textOf(intent?.body),
				keptTitle = textOf(intent?.title);

			if (
				intent?.key !== key ||
				keptBody === null ||
				keptTitle === null ||
				keptBody.length > 24_000 ||
				keptTitle.length > 220 ||
				!keptBody.endsWith(`\n\n${key}`)
			)
				return false;

			body = keptBody;
			title = keptTitle;
		}

		// Include closed issues and proposals whose labels the owner changed.
		const issues = await adapter.readProposedIssues(true);

		if (issues.kind !== "ok") return false;

		const matches = issues.value.filter((issue) =>
			issue.body.split("\n").includes(key),
		);

		if (matches.length > 1) return false;

		if (matches.length === 1) continue;

		if (!(await cadenceSwitches(input.stateDir, adapter))) return false;

		const created = await writer.createIssue(title, body, ["factory:proposed"]);

		// An unknown create is never retried here. A later tick must list remote issues first.
		if (created.kind !== "posted") return false;
	}

	return true;
}

export function controllerCadence(input: {
	stateDir: string;
	repo: RepoSlug;
	exec: Exec;
	executor: StageExecutor;
	log: Log;
	signal?: AbortSignal;
}): CadenceRunner {
	const adapter = new GitHubTicketAdapter({
		exec: input.exec,
		repo: input.repo,
	});

	const retained = async (execution: CadenceInput): Promise<CadenceResult> => {
		const { readStageReceipt, executionCharge } = await import("./sandbox.ts");

		const runtime = join(
			cadenceExecutionDir(input.stateDir, execution.job, execution.windowStart),
			"runtime",
		);

		const native = await readStageReceipt(join(runtime, "receipt.json"));

		const raw =
			native === null ? null : readCadenceFile(join(runtime, "receipt.json"));

		const charge = await executionCharge(runtime);

		const valid =
			native !== null &&
			native.record !== null &&
			raw !== null &&
			native.record.runId === execution.runId &&
			native.record.stage === "maintain" &&
			native.record.attempt === 1;

		const passed = valid && native.outcome.kind === "passed";
		const output = passed ? readCadenceFile(join(runtime, "output.txt")) : null;

		const usable =
			passed && output !== null && Buffer.byteLength(output) <= 64 * 1024;

		return {
			kind: usable ? "passed" : "failed",
			tokens: valid
				? Math.max(native.usage.total, charge?.total ?? 0)
				: Math.max(execution.settings.maxTokens, charge?.total ?? 0),
			exact: valid && charge !== null && charge.uncertain === 0,
			model: valid
				? (textOf(objectOf(native.record?.models)?.observed) ??
					execution.settings.model)
				: execution.settings.model,
			receiptDigest: digestOf(
				raw ??
					JSON.stringify({
						execution,
						reason: "interrupted",
						tokens: charge?.total ?? null,
					}),
			),
			output: usable ? output : null,
			reason:
				passed && !usable
					? "invalid_output"
					: valid
						? native.outcome.kind
						: "interrupted",
		};
	};

	return new CadenceRunner({
		stateDir: input.stateDir,
		repo: input.repo,
		log: input.log,
		port: {
			retained,
			publish: (execution, result, proposals) =>
				publishCadenceProposals({ ...input, execution, result, proposals }),
			async execute(execution, signal) {
				const started = Date.now();

				const dir = cadenceExecutionDir(
					input.stateDir,
					execution.job,
					execution.windowStart,
				);

				const failed = (reason: string): CadenceResult => ({
					kind: "failed",
					tokens: 0,
					exact: true,
					model: execution.settings.model,
					receiptDigest: digestOf(JSON.stringify({ execution, reason })),
					output: null,
					reason,
				});

				const deadline = AbortSignal.any([
					signal,
					input.signal ?? signal,
					AbortSignal.timeout(
						execution.settings.budget.wallMs - STAGE_CLEANUP_RESERVE_MS,
					),
				]);

				if (
					deadline.aborted ||
					!(await cadenceSwitches(input.stateDir, adapter))
				)
					return failed("disabled");

				if (!(await input.executor.preflight()))
					return failed("sandbox_unavailable");

				const workspace = join(dir, "tree");
				cadencePrivateDir(workspace);

				const checked = await input.executor.checkout({
					runId: execution.runId,
					repo: execution.repo,
					sha: execution.baseSha,
					workspace,
				});

				if (checked.kind !== "ready" || checked.omitted !== 0)
					return failed("checkout_unavailable");

				const files = checked.checkout.files.filter((path) =>
					inCadenceScope(path, cadenceScope(execution.rotation)),
				);

				const ledger =
					execution.job === "hygiene"
						? await cadenceLedger(input.stateDir)
						: "unavailable; not requested by this job";

				const prompt = cadencePrompt(execution, files, ledger);
				writeCadenceFile(join(dir, "prompt.txt"), prompt);

				if (
					deadline.aborted ||
					!(await cadenceSwitches(input.stateDir, adapter))
				)
					return failed("disabled_or_wall");

				const wallMs =
					execution.settings.budget.wallMs - (Date.now() - started);

				if (deadline.aborted || wallMs <= STAGE_CLEANUP_RESERVE_MS)
					return failed("wall");

				const launch = await input.executor.launch({
					runId: execution.runId,
					stage: "maintain",
					attempt: 1,
					maintenance: {
						job: execution.job,
						windowStart: execution.windowStart,
					},
					workspace,
					prompt,
					tools: ["read", "grep", "ls"],
					skills: [CADENCE_SKILLS[execution.job]],
					settings: {
						model: execution.settings.model,
						fallback: null,
						maxTokens: execution.settings.maxTokens,
						budget: { ...execution.settings.budget, wallMs },
					},
					remainingRunTokens: execution.settings.maxTokens,
					signal: deadline,
					progress: () => undefined,
				});

				if (launch.kind !== "started") return failed("sandbox_unavailable");

				await launch.done;

				return retained(execution);
			},
		},
	});
}

export async function readLedgerBacklog(stateDir: string | null, now: number) {
	const available =
		stateDir !== null &&
		(await lstat(stateDir).then(
			(info) => info.isDirectory(),
			() => false,
		));

	const jobs =
		stateDir === null || !available
			? null
			: await fileLedgerOutbox(stateDir).scan();

	const blocked = jobs?.filter((job) => job.retry?.blocked).length ?? null;
	const oldest = jobs?.map((job) => job.observedAt).sort()[0] ?? null;

	const next =
		jobs
			?.flatMap((job) => (job.retry === null ? [] : [job.retry.nextAt]))
			.sort((a, b) => a - b)[0] ?? null;

	return {
		state:
			stateDir === null
				? "unavailable"
				: jobs === null
					? "unreadable"
					: (blocked ?? 0) > 0
						? "blocked"
						: jobs.length > 0
							? "pending"
							: "empty",
		pending: jobs?.length ?? null,
		blocked,
		oldestObservedAt: oldest,
		oldestAgeMs: oldest === null ? null : Math.max(0, now - Date.parse(oldest)),
		nextAttemptAt: next === null ? null : new Date(next).toISOString(),
		lastError: jobs?.find((job) => job.retry !== null)?.retry?.reason ?? null,
	};
}

type DurableTokenUsage = { kind: string; unit: string; total: number };

type DurableUsage = DurableTokenUsage & {
	reason?: string;
	maintenance?: DurableTokenUsage;
};

export function durableUsageOf(
	accounting: Awaited<ReturnType<typeof readDurableAccounting>>,
): JsonValue {
	const uncertain = accounting.runs.some((run) => run.uncertainRequests > 0);

	const exact =
		accounting.state === "readable" &&
		accounting.runs.every((run) => run.tokens.kind === "exact") &&
		accounting.maintenance.tokens.kind === "exact";

	if (accounting.state === "unavailable")
		return { kind: "unavailable", reason: "legacy_not_recorded" };

	const usage: DurableUsage = {
		kind: uncertain ? "uncertain" : exact ? "exact" : "lower_bound",
		unit: "tokens",
		total:
			accounting.runs.reduce((sum, run) => sum + run.tokens.total, 0) +
			accounting.maintenance.tokens.total,
		...(uncertain
			? { reason: "request_unsettled" }
			: exact
				? {}
				: { reason: "receipt_missing" }),
	};

	if (accounting.maintenance.executions > 0)
		usage.maintenance = accounting.maintenance.tokens;

	return usage;
}

export async function startDurableUsage(input: {
	stateDir: string;
	repo: RepoSlug;
	log: Log;
}) {
	let current: JsonValue = {
		kind: "unavailable",
		reason: "legacy_not_recorded",
	};

	let pending: Promise<void> | null = null;

	const refresh = () => {
		pending ??= (async () => {
			try {
				current = durableUsageOf(
					await readDurableAccounting(input.stateDir, input.repo),
				);
			} catch {
				input.log("accounting_unavailable", {});
			}
		})().finally(() => {
			pending = null;
		});

		return pending;
	};

	await refresh();
	const timer = setInterval(() => void refresh(), 300_000);
	timer.unref();

	return {
		current: () => current,
		stop: async () => {
			clearInterval(timer);
			await pending;
		},
	};
}

/** Writes the last tick's report and cached local usage for `status --json`. */
export async function writeStatus(
	stateDir: string,
	report: TickReport,
	durableUsage: JsonValue = {
		kind: "unavailable",
		reason: "legacy_not_recorded",
	},
): Promise<boolean> {
	return writeAtomic(
		join(resolve(stateDir), STATUS_FILE),
		`${JSON.stringify({ ...report, durableUsage }, null, 2)}\n`,
	);
}

export function readStoredVerdict(path: string): Verdict {
	try {
		// SAFETY: controller-private write-once verdict; callers verify artifact bindings before reuse.
		return JSON.parse(regularText(path, 1024 * 1024)) as Verdict;
	} catch {
		throw new Error("stored_verdict_invalid");
	}
}

export async function readStatus(stateDir: string): Promise<JsonValue | null> {
	const text = await readFile(
		join(resolve(stateDir), STATUS_FILE),
		"utf8",
	).catch(() => null);

	return text === null ? null : (parseJson(text) ?? null);
}

const LOG_VALUE = /^[A-Za-z0-9:._@/[\]+-]*$/;

/** One structured log line: `at=<time> event=<name> key=value ...`. */
export function logLine(at: number, event: string, fields: LogFields): string {
	const parts = [`at=${new Date(at).toISOString()}`, `event=${event}`];

	for (const [key, value] of Object.entries(fields)) {
		const text = String(value);

		parts.push(`${key}=${LOG_VALUE.test(text) ? text : "(withheld)"}`);
	}

	return `${parts.join(" ")}\n`;
}

export function lineLog(write: (text: string) => void, now: () => number): Log {
	return (event, fields) => write(logLine(now(), event, fields));
}

/** Resolves after `ms`, or as soon as `signal` aborts. */
export type Sleep = (ms: number, signal: AbortSignal) => Promise<void>;

export function readStoredAssessment(dir: string): ReadAssessment | null {
	const path = join(dir, "assessment.json");

	try {
		return present(path)
			? readAssessmentBytes(regularText(path, 64 * 1024))
			: null;
	} catch {
		return null;
	}
}

function storeAssessment(
	dir: string,
	input: Parameters<typeof assessmentBinding>[0],
	assessment: ValidationAssessment,
): ReadAssessment {
	const text = assessmentBytes(assessmentBinding(input), assessment);
	keepValidationFile(join(dir, "assessment.json"), text);
	const read = readStoredAssessment(dir);

	if (read === null || read.ref.recordDigest !== digestOf(text))
		throw new Error("assessment_unreadable");

	return read;
}

function keepValidationFile(path: string, text: string): void {
	if (present(path)) {
		if (regularText(path, 1024 * 1024) !== text)
			throw new Error("validation_changed");
	} else exclusive(path, text);
}

async function cleanupPublication(
	api: GitHubPublicationApi,
	dir: string,
	publication: { readonly branch: string; readonly candidateSha: GitSha },
): Promise<"done" | "pending" | "branch_moved"> {
	privateDir(dir);

	try {
		await api.remove(publication.branch, publication.candidateSha);
		keepValidationFile(
			join(dir, "cleanup.json"),
			`${JSON.stringify({ branch: publication.branch, candidateSha: publication.candidateSha })}\n`,
		);
		await rm(join(dir, "pending-deletion.json"), { force: true });

		return "done";
	} catch (error) {
		const reason =
			error instanceof Error ? error.message : "cleanup_unavailable";

		await writeAtomic(
			join(dir, "pending-deletion.json"),
			`${JSON.stringify({ ...publication, reason })}\n`,
		);

		return reason === "branch_moved" ? "branch_moved" : "pending";
	}
}

type ValidatorConfig = {
	readonly stateDir: string;
	readonly exec: Exec;
	readonly sleep?: (ms: number) => Promise<void>;
	readonly fetch?: TarballFetch;
	readonly receipt?: GateReceiptSource;
	readonly diagnosis?: ReturnType<typeof controllerDiagnosis>;
};

export function controllerValidator(config: ValidatorConfig): Validator {
	return candidateValidator(config, false);
}

export function ownerValidator(config: ValidatorConfig): Validator {
	return candidateValidator(config, true);
}

// Both paths use the same dispatch, identity, diagnosis, report and cleanup code.
function candidateValidator(
	config: ValidatorConfig,
	owner: boolean,
): Validator {
	return async (input) => {
		const initial: ValidationState = {
			version: input.generation === undefined ? 1 : 2,
			startedAt: input.now,
			deadline: input.now + Math.min(input.wallMs, CI_DEADLINE_MS),
			round: input.round ?? 0,
			originalBase: input.baseSha,
			baseSha: input.generation?.baseSha ?? input.baseSha,
			baseResolved: input.generation !== undefined,
			publication: null,
			dispatchTry: 0,
			dispatchedAt: null,
			ciRunId: null,
			counters: {},
		};

		const generation = input.generation;

		const prepared =
			generation === undefined
				? initial
				: {
						...initial,
						generation: {
							index: generation.generation,
							digest: generation.digest,
							previousHead:
								generation.publication.kind === "successor"
									? generation.publication.expectedHead
									: null,
						},
					};

		const state: ValidationState = input.state ?? prepared;

		const save = () => input.save(state);
		let repository: RepoSlug | null = null;

		let identities: {
			patchDigest: Digest;
			acceptanceDigest: Digest;
			heldoutDigest: Digest;
		} | null = null;

		const failed = async (reason: string) => {
			const publication = state.publication;

			if (publication !== null && repository !== null) {
				const dir = validationDir(
					config.stateDir,
					input.runId,
					state.round,
					state.generation?.index,
				);

				privateDir(dir);
				const path = join(dir, "failure.json");

				if (
					!present(path) &&
					(reason === "ci_timeout" || !present(join(dir, "verdict.json")))
				)
					exclusive(
						path,
						`${JSON.stringify({ ...identities, candidateSha: publication.candidateSha, gateSha: null, ciRunId: state.ciRunId, originalBase: state.originalBase, baseSha: state.baseSha, pass: false, checks: [], reason })}\n`,
					);

				if (reason !== "branch_moved") {
					const cleanup = await cleanupPublication(
						new GitHubPublicationApi(
							config.exec,
							repository,
							{},
							undefined,
							config.sleep,
						),
						dir,
						publication,
					);

					if (cleanup === "branch_moved") reason = "branch_moved";
				}
			}

			return { kind: "failed", state, reason } as const;
		};

		try {
			if (
				state.originalBase !== input.baseSha ||
				state.round !== (input.round ?? 0) ||
				(input.generation !== undefined &&
					(state.generation?.digest !== input.generation.digest ||
						state.baseSha !== input.generation.baseSha ||
						state.generation.index !== input.generation.generation))
			)
				return failed("validation_binding");

			if (!(await save())) return failed("claim_unwritable");
			const contract = await readStoredContract(config.stateDir, input.runId);

			if (
				contract.kind !== "found" ||
				contract.contract.base.sha !== input.baseSha ||
				contract.contract.issue !== input.issue
			)
				return failed("contract_binding");
			const repo = contract.contract.base.repo;
			repository = repo;

			const suite = await fileArtifacts(config.stateDir).read(
				input.runId,
				contract.contract,
				contract.digest,
			);

			if (suite.kind !== "found")
				return failed(
					suite.kind === "blocked" ? suite.reason : "acceptance_missing",
				);

			const patch =
				owner && generation?.origin.kind === "owner"
					? readOwnerPatch(
							config.stateDir,
							input.runId,
							generation.origin.head,
							generation.baseSha,
						)
					: owner
						? null
						: readPatch(config.stateDir, {
								round: state.round,
								runId: input.runId,
								baseSha: input.baseSha,
								contractDigest: contract.digest,
								acceptanceDigest: suite.receipt.acceptanceDigest,
							});

			if (patch === null || patch.kind !== "found")
				return failed(
					patch?.kind === "blocked" ? patch.reason : "patch_missing",
				);

			if (owner) {
				if (
					!("kind" in patch.receipt) ||
					generation === undefined ||
					!ownerPatchValid(
						{
							runId: input.runId,
							contractDigest: contract.digest,
							acceptanceDigest: suite.receipt.acceptanceDigest,
						},
						generation,
						patch.receipt,
					)
				)
					return failed("owner_patch_binding");
			} else if (
				"kind" in patch.receipt ||
				patch.receipt.policy !== "clean" ||
				patch.receipt.visibleTests?.exitCode !== 0
			)
				return failed("patch_failed");

			const canary = regularText(
				join(config.stateDir, "acceptance", input.runId, "canary.txt"),
			).trimEnd();

			const heldout = publishedSuite({
				issue: input.issue,
				suite: suite.suite,
				canary,
				acceptanceDigest: suite.receipt.acceptanceDigest,
			});

			if (
				owner &&
				"heldoutDigest" in patch.receipt &&
				patch.receipt.heldoutDigest !== heldout.digest
			)
				return failed("owner_patch_binding");
			identities = {
				patchDigest: patch.receipt.patchDigest,
				acceptanceDigest: suite.receipt.acceptanceDigest,
				heldoutDigest: heldout.digest,
			};

			const api = new GitHubPublicationApi(
				config.exec,
				repo,
				state.counters,
				save,
				config.sleep,
			);

			const dir = validationDir(
				config.stateDir,
				input.runId,
				state.round,
				state.generation?.index,
			);

			privateDir(dir);
			const verdictPath = join(dir, "verdict.json");
			const failurePath = join(dir, "failure.json");
			const receiptPath = join(dir, "receipt.json");
			const checksPath = join(dir, "checks.json");

			const receiptOf = () =>
				objectOf(
					parseJson(
						present(receiptPath) ? regularText(receiptPath, 1024 * 1024) : "",
					),
				);

			const bindingOf = (verdict: Verdict) => ({
				runId: input.runId,
				round: state.round,
				generation: state.generation?.index ?? 0,
				verdict,
			});

			const classifyWith = (
				raw: ReturnType<typeof receiptOf>,
				facts: DiagnosisFacts | null,
			): FailureClass => {
				const nonces = Array.from({ length: state.dispatchTry }, (_, index) =>
					dispatchNonce(
						input.runId,
						state.round,
						index + 1,
						state.generation?.index,
					),
				);

				return classifyFailure({
					receipt: raw ?? undefined,
					identity: {
						gateSha: state.baseSha,
						candidateSha: state.publication?.candidateSha ?? state.baseSha,
						nonce:
							nonces.find((n) => n === jsonField(raw, "nonce")) ?? "missing",
						heldoutDigest: heldout.digest,
						replacementsDigest: replacementDigest(
							contract.contract.replacesTests ?? [],
						),
					},
					expected: heldout.files.map((f) => f.path).toSorted(),
					scenarios: suite.suite.scenarios.flatMap((s) =>
						s.checks.length === 1
							? [
									{
										scenario: s.id,
										kind: s.kind,
										file: `${heldout.directory}/checks/${s.checks[0]}`,
									},
								]
							: [],
					),
					base: facts?.base ?? null,
					ignoredChanges: facts?.ignoredChanges ?? null,
					replay: facts?.replay ?? null,
					dependencies: facts?.dependencies ?? null,
					candidatePaths: patch.receipt.changedPaths,
					baseRefusal: facts?.baseRefusal ?? null,
				});
			};

			const diagnosed = async (verdict: Verdict): Promise<boolean> => {
				if (verdict.pass || readStoredAssessment(dir) !== null) return true;
				const raw = receiptOf();
				const needs = diagnosisNeeds(raw ?? undefined);
				const binding = bindingOf(verdict);

				const fail = (failure: FailureClass) => {
					storeAssessment(dir, binding, { kind: "failed", failure });
				};

				if (!needs.replay && !needs.dependencies) {
					fail(classifyWith(raw, null));

					return true;
				}

				const bindingDigest = digestOf(
					JSON.stringify(assessmentBinding(binding)),
				);

				const allowanceMs = state.deadline - input.now;

				if (
					allowanceMs <= 0 &&
					!present(join(dir, "diagnosis", bindingDigest, "intent.json"))
				) {
					fail({ kind: "infrastructure", reason: "timeout" });

					return true;
				}

				const publication = state.publication;

				if (config.diagnosis === undefined || publication === null)
					return false;

				const original: AcceptanceBinding = {
					runId: input.runId,
					repo,
					issue: input.issue,
					contractDigest: contract.digest,
					acceptanceDigest: suite.receipt.acceptanceDigest,
					baseSha: state.originalBase,
					gateSha: state.originalBase,
				};

				return (
					(await config.diagnosis.check({
						runId: input.runId,
						dir,
						bindingDigest,
						repo,
						gateSha: state.baseSha,
						candidateSha: publication.candidateSha,
						round: state.round,
						allowanceMs,
						needs,
						heldoutDir: heldout.directory,
						heldoutDigest: heldout.digest,
						replacements: contract.contract.replacesTests ?? [],
						base:
							state.baseSha === state.originalBase
								? {
										kind: "stored",
										receipt: storedBaseReceipt(config.stateDir, original),
									}
								: {
										kind: "fresh",
										binding: {
											...original,
											baseSha: state.baseSha,
											gateSha: state.baseSha,
										},
										contract: contract.contract,
										suite: suite.suite,
										canary,
									},
						finish: (facts) => fail(classifyWith(raw, facts)),
						interrupted: () =>
							fail({ kind: "infrastructure", reason: "interrupted" }),
					})) === "settled"
				);
			};

			const assess = (verdict: Verdict): ReadAssessment => {
				const raw = receiptOf();

				const read =
					readStoredAssessment(dir) ??
					storeAssessment(
						dir,
						bindingOf(verdict),
						verdict.pass
							? { kind: "passed" }
							: { kind: "failed", failure: classifyWith(raw, null) },
					);

				if (
					read.assessment.kind === "failed" &&
					read.assessment.failure.kind === "candidate"
				)
					keepValidationFile(
						join(dir, "feedback.json"),
						feedbackBytes(read.ref, [
							...repairFeedback(
								suite.suite,
								contract.contract,
								textsOf(jsonField(raw, "heldoutFailures")) ?? [],
								heldout.directory,
							),
							...((present(checksPath)
								? parseCheckFeedback(
										parseJson(regularText(checksPath, 64 * 1024)),
										{
											changedPaths: patch.receipt.changedPaths,
											heldoutDir: heldout.directory,
										},
									)
								: null) ?? []),
						]),
					);

				return read;
			};

			if (state.publication !== null) {
				const tip = await api.ref(state.publication.branch);

				if (tip !== null && tip !== state.publication.candidateSha)
					return failed("branch_moved");

				if (
					tip === null &&
					state.rebaseSha === undefined &&
					!present(verdictPath) &&
					!present(failurePath)
				)
					return failed("branch_moved");
			}

			if (present(verdictPath)) {
				const verdict = readStoredVerdict(verdictPath);

				if (
					verdict.patchDigest !== patch.receipt.patchDigest ||
					verdict.acceptanceDigest !== suite.receipt.acceptanceDigest ||
					verdict.heldoutDigest !== heldout.digest ||
					verdict.candidateSha !== state.publication?.candidateSha ||
					verdict.gateSha !== state.baseSha ||
					verdict.baseSha !== state.baseSha ||
					verdict.originalBase !== state.originalBase ||
					verdict.ciRunId !== state.ciRunId
				)
					return failed("verdict_binding");

				if (!(await diagnosed(verdict))) return { kind: "waiting", state };
				const cleanup = await cleanupPublication(api, dir, state.publication);

				if (cleanup === "branch_moved") return failed("branch_moved");

				if (input.generation !== undefined && verdict.pass) {
					if (
						present(failurePath) &&
						jsonField(
							objectOf(parseJson(regularText(failurePath))),
							"reason",
						) === "ci_timeout"
					)
						return failed("ci_timeout");

					const report = await controllerReport(
						config,
						repo,
						input.runId,
						state,
						verdict,
					);

					if (report !== null)
						return {
							kind: "finished",
							state,
							verdict,
							report,
							assessment: assess(verdict),
						};

					return input.now >= state.deadline
						? failed("ci_timeout")
						: { kind: "waiting", state };
				}

				return {
					kind: "finished",
					state,
					verdict,
					assessment: assess(verdict),
				};
			}

			if (present(failurePath))
				return failed(
					textOf(
						jsonField(objectOf(parseJson(regularText(failurePath))), "reason"),
					) ?? "validation_failed",
				);

			if (state.rebaseSha !== undefined) {
				if (state.publication !== null)
					await api.remove(
						state.publication.branch,
						state.publication.candidateSha,
					);
				state.baseSha = state.rebaseSha;
				delete state.rebaseSha;
				state.publication = null;
				state.ciRunId = null;

				if (!(await save())) return failed("claim_unwritable");
			}

			if (state.publication === null && input.now >= state.deadline)
				return failed("ci_timeout");

			if (state.publication === null) {
				if (!state.baseResolved) {
					const main = objectOf(await api.request("GET", "git/ref/heads/main"));

					const sha = textOf(
						jsonField(objectOf(jsonField(main, "object")), "sha"),
					);

					if (sha === null || !isGitSha(sha)) return failed("main_unavailable");
					state.baseSha = sha;
					state.baseResolved = true;

					if (!(await save())) return failed("claim_unwritable");
				}

				if (owner && generation?.publication.kind === "owner") {
					state.publication = await pinOwnerCandidate(
						api,
						candidateBranch(
							input.issue,
							input.runId,
							state.round,
							generation.generation,
						),
						generation.publication.head,
					);
				} else {
					const scratch = await mkdtemp(join(dir, "tree-"));

					try {
						const base = join(scratch, "base");
						await mkdir(base);

						const checked = await checkoutWorkspace({
							stateDir: scratch,
							runId: input.runId,
							workspace: base,
							repo,
							sha: state.baseSha,
							fetch: config.fetch ?? ghTarball,
						});

						if (checked.kind !== "ready") return failed("base_unavailable");
						let gatesDigest: Digest | null = null;

						if (checked.omitted === 0) {
							try {
								gatesDigest = baseTreeDigest(
									join(base, ".github/factory/gates"),
								);
							} catch {
								/* A missing or unsafe historical gate tree is not a digest. */
							}
						}

						if (gatesDigest !== null)
							keepValidationFile(
								join(dir, "gate-policy.json"),
								`${JSON.stringify({
									v: 1,
									runId: input.runId,
									round: state.round,
									generation: state.generation?.index ?? 0,
									sourceSha: state.baseSha,
									digest: gatesDigest,
								})}\n`,
							);

						if (
							checked.checkout.files.some(
								(path) =>
									path === heldout.directory ||
									path.startsWith(`${heldout.directory}/`),
							)
						)
							return failed("stale_base");

						const files = await publicationTree(
							base,
							join(scratch, "patched"),
							patch.patch,
							patch.receipt.changedPaths,
						);

						state.publication = await publishCandidate(api, {
							issue: input.issue,
							runId: input.runId,
							round: state.round,
							generation: state.generation?.index,
							ancestry:
								state.generation?.previousHead == null
									? undefined
									: {
											kind: "successor",
											previousHead: state.generation.previousHead,
										},
							eventAt: input.eventAt,
							baseSha: state.baseSha,
							patchDigest: patch.receipt.patchDigest,
							acceptanceDigest: suite.receipt.acceptanceDigest,
							heldoutDigest: heldout.digest,
							patch: files,
							suite: heldout.files,
						});
					} finally {
						await rm(scratch, { recursive: true, force: true });
					}
				}

				if (!(await save())) return failed("claim_unwritable");
			}

			const publication = state.publication;

			if (publication === null) return failed("publication_missing");

			if ((await api.ref(publication.branch)) !== publication.candidateSha)
				return failed("branch_moved");

			let run =
				state.ciRunId === null
					? null
					: parseCiRun(
							await api.request("GET", `actions/runs/${state.ciRunId}`),
						);

			if ((run === null || state.dispatchTry > 1) && state.dispatchTry > 0) {
				const listed = objectOf(
					await api.request(
						"GET",
						"actions/workflows/ci.yml/runs?event=workflow_dispatch&per_page=100",
					),
				);

				const matches = (
					arrayOf(jsonField(listed, "workflow_runs")) ?? []
				).flatMap((value) => {
					const found = parseCiRun(value);

					return found !== null &&
						Array.from({ length: state.dispatchTry }, (_, index) =>
							dispatchNonce(
								input.runId,
								state.round,
								index + 1,
								state.generation?.index,
							),
						).some((nonce) =>
							matchesCiRun(
								found,
								publication.candidateSha,
								nonce,
								state.startedAt,
							),
						)
						? [found]
						: [];
				});

				if (matches.length > 1) {
					if (matches.some((match) => match.status !== "completed"))
						return input.now >= state.deadline
							? failed("ci_timeout")
							: { kind: "waiting", state };

					return failed("duplicate_dispatch");
				}

				run = matches[0] ?? run;
			}

			if (run === null) {
				if (input.now >= state.deadline) return failed("ci_timeout");

				if (input.dispatchAllowed === false) return failed("ci_missing");

				if (
					state.dispatchedAt !== null &&
					input.now - state.dispatchedAt < DISPATCH_SETTLE_MS
				)
					return { kind: "waiting", state };

				if (state.dispatchTry >= 2) return { kind: "waiting", state };
				const main = objectOf(await api.request("GET", "git/ref/heads/main"));

				const tip = textOf(
					jsonField(objectOf(jsonField(main, "object")), "sha"),
				);

				if (tip === null || !isGitSha(tip)) return failed("main_unavailable");

				if (tip !== state.baseSha) {
					if (input.generation !== undefined) return failed("stale_base");
					state.rebaseSha = tip;

					if (!(await save())) return failed("claim_unwritable");

					return { kind: "waiting", state };
				}

				state.dispatchTry++;
				state.dispatchedAt = input.now;

				if (!(await save())) return failed("claim_unwritable");

				const nonce = dispatchNonce(
					input.runId,
					state.round,
					state.dispatchTry,
					state.generation?.index,
				);

				const replacements = JSON.stringify(
					contract.contract.replacesTests ?? [],
				);

				try {
					const response = objectOf(
						await api.request(
							"POST",
							"actions/workflows/ci.yml/dispatches",
							{
								ref: "main",
								inputs: {
									candidate_sha: publication.candidateSha,
									nonce,
									replacements,
									replacements_digest: digestOf(replacements),
									heldout_dir: heldout.directory,
									heldout_digest: heldout.digest,
								},
							},
							true,
						),
					);

					state.ciRunId = countOf(jsonField(response, "workflow_run_id"));
				} catch (error) {
					if (!(error instanceof PublicationError)) throw error;
				}

				await save();

				return { kind: "waiting", state };
			}

			const nonce =
				Array.from({ length: state.dispatchTry }, (_, index) =>
					dispatchNonce(
						input.runId,
						state.round,
						index + 1,
						state.generation?.index,
					),
				).find(
					(nonce) => run.title === `gates ${publication.candidateSha} ${nonce}`,
				) ?? "missing";

			if (!matchesCiRun(run, publication.candidateSha, nonce, state.startedAt))
				return failed("ci_identity");
			state.ciRunId = run.id;

			if (!(await save())) return failed("claim_unwritable");

			if (run.status !== "completed")
				return input.now >= state.deadline
					? failed("ci_timeout")
					: { kind: "waiting", state };

			if (
				input.now >= state.deadline &&
				(run.completedAt === null ||
					Date.parse(run.completedAt) > state.deadline)
			)
				return failed("ci_timeout");

			if (run.headSha !== state.baseSha) return failed("stale_base");

			const logs = new Map<string, string>();

			const text = await (
				config.receipt ??
				((repo, id, sink) =>
					downloadGateReceipt(config.exec, repo, id, "gate-receipt", sink))
			)(repo, run.id, logs).catch(() => null);

			if (text === null && run.conclusion === "success")
				return input.now >= state.deadline
					? failed("ci_timeout")
					: { kind: "waiting", state };

			const raw = objectOf(parseJson(text ?? ""));

			if (
				jsonField(raw, "reason") === "stale_base" ||
				(text !== null && jsonField(raw, "gateSha") !== state.baseSha)
			)
				return failed("stale_base");

			const verdict = collectVerdict({
				text,
				run,
				nonce,
				patchDigest: patch.receipt.patchDigest,
				acceptanceDigest: suite.receipt.acceptanceDigest,
				heldoutDigest: heldout.digest,
				candidateSha: publication.candidateSha,
				originalBase: state.originalBase,
				baseSha: state.baseSha,
				unjudged: suite.suite.scenarios.flatMap((s) =>
					s.judge === null ? [] : [s.id],
				),
			});

			keepValidationFile(receiptPath, text ?? "null\n");

			// Written once: a later download may differ in which logs it fetched.
			if (!present(checksPath))
				exclusive(
					checksPath,
					`${JSON.stringify(
						checkFeedback({
							logs,
							failed: verdict.checks
								.filter((check) => !check.passed)
								.map((check) => check.name),
							changedPaths: patch.receipt.changedPaths,
							heldoutDir: heldout.directory,
						}),
					)}\n`,
				);
			keepValidationFile(verdictPath, `${JSON.stringify(verdict)}\n`);

			if (!(await diagnosed(verdict))) return { kind: "waiting", state };
			const cleanup = await cleanupPublication(api, dir, publication);

			if (cleanup === "branch_moved") return failed("branch_moved");

			if (input.generation !== undefined && verdict.pass) {
				const report = await controllerReport(
					config,
					repo,
					input.runId,
					state,
					verdict,
				);

				if (report !== null)
					return {
						kind: "finished",
						state,
						verdict,
						report,
						assessment: assess(verdict),
					};

				return input.now >= state.deadline
					? failed("ci_timeout")
					: { kind: "waiting", state };
			}

			return { kind: "finished", state, verdict, assessment: assess(verdict) };
		} catch (error) {
			if (
				error instanceof PublicationError &&
				error.reason === "transport_exhausted"
			)
				return input.now >= state.deadline
					? failed("ci_timeout")
					: { kind: "waiting", state };

			return failed(
				error instanceof Error ? error.message : "validation_unavailable",
			);
		}
	};
}

async function controllerReport(
	config: { readonly stateDir: string; readonly exec: Exec },
	repo: RepoSlug,
	runId: Digest,
	state: ValidationState,
	verdict: Verdict,
) {
	const api = new GitHubPublicationApi(config.exec, repo);

	const run = parseCiRun(
		await api.request("GET", `actions/runs/${verdict.ciRunId}`),
	);

	if (run === null) return null;

	const text = await downloadGateReceipt(
		config.exec,
		repo,
		verdict.ciRunId,
		"factory-report",
	);

	if (text === null) return null;

	const nonce = Array.from({ length: state.dispatchTry }, (_, i) =>
		dispatchNonce(runId, state.round, i + 1, state.generation?.index),
	).find((n) =>
		matchesCiRun(
			run,
			state.publication?.candidateSha ?? state.baseSha,
			n,
			state.startedAt,
		),
	);

	if (nonce === undefined) return null;

	const checks = await api.request(
		"GET",
		`commits/${verdict.candidateSha}/check-runs?filter=all&per_page=100`,
	);

	const report = collectTrustedReport({
		record: parseJson(text),
		checks,
		run,
		nonce,
		verdict,
	});

	if (report !== null) {
		const dir = validationDir(
			config.stateDir,
			runId,
			state.round,
			state.generation?.index,
		);

		keepValidationFile(join(dir, "report-receipt.json"), text);
		keepValidationFile(join(dir, "report.json"), `${JSON.stringify(report)}\n`);
	}

	return report;
}

export async function sweepValidation(config: {
	readonly stateDir: string;
	readonly exec: Exec;
	readonly fetch?: TarballFetch;
	readonly receipt?: GateReceiptSource;
	readonly now?: () => number;
}): Promise<void> {
	const files = fileRunFiles(config.stateDir);

	for (const claim of await files.listClaims()) {
		const book = claim.handoff;

		const terminal =
			claim.status !== null &&
			[
				"released",
				"failed",
				"budget_exhausted",
				"stage_passed",
				"landed",
				"cancelled",
			].includes(claim.status);

		const generations =
			book?.kind === "selected" ? candidateGenerations(book) : [];

		const entries: {
			state: ValidationState | null;
			generation: (typeof generations)[number]["intent"] | undefined;
			retired: boolean;
		}[] = generations.map((evidence) => ({
			state: evidence.validation,
			generation: evidence.intent,
			retired:
				terminal ||
				(book?.kind === "selected" &&
					(book.current.intent.digest !== evidence.intent.digest ||
						book.work.kind === "terminal" ||
						book.work.kind === "held" ||
						(book.work.kind === "effect" &&
							book.work.request.kind === "finish_pr"))),
		}));

		if (book === undefined && terminal && claim.validation !== undefined)
			entries.push({
				state: claim.validation,
				generation: undefined,
				retired: true,
			});

		for (const entry of entries) {
			const original = entry.state;
			const publication = original?.publication;

			if (original == null || publication == null) continue;

			const index =
				entry.generation?.generation ?? original.generation?.index ?? 0;

			if (
				publication.branch !==
				candidateBranch(claim.issue, claim.runId, original.round, index)
			)
				continue;

			const dir = validationDir(
				config.stateDir,
				claim.runId,
				original.round,
				index,
			);

			if (present(join(dir, "cleanup.json"))) continue;
			const contract = await files.readContract(claim.runId);

			if (
				contract.kind !== "found" ||
				(book !== undefined && book.pin.repo !== contract.contract.base.repo)
			)
				continue;

			const api = new GitHubPublicationApi(
				config.exec,
				contract.contract.base.repo,
			);

			const progress = join(dir, "cleanup-validation.json");
			let state = structuredClone(original);

			if (present(progress)) {
				const restored = parseValidationState(parseJson(regularText(progress)));

				if (
					restored === null ||
					restored.startedAt !== original.startedAt ||
					restored.deadline !== original.deadline ||
					restored.round !== original.round ||
					restored.originalBase !== original.originalBase ||
					restored.baseSha !== original.baseSha ||
					JSON.stringify(restored.generation) !==
						JSON.stringify(original.generation) ||
					JSON.stringify(restored.publication) !== JSON.stringify(publication)
				)
					continue;
				state = restored;
			}

			if (
				!present(join(dir, "verdict.json")) &&
				!present(join(dir, "failure.json"))
			) {
				if (!entry.retired) continue;

				const listed = objectOf(
					await api
						.request(
							"GET",
							"actions/workflows/ci.yml/runs?event=workflow_dispatch&per_page=100",
						)
						.catch(() => undefined),
				);

				const runs = (
					arrayOf(jsonField(listed, "workflow_runs")) ?? []
				).flatMap((value) => {
					const run = parseCiRun(value);

					return run !== null &&
						Array.from({ length: state.dispatchTry }, (_, attempt) =>
							dispatchNonce(
								claim.runId,
								state.round,
								attempt + 1,
								state.generation?.index,
							),
						).some((nonce) =>
							matchesCiRun(
								run,
								publication.candidateSha,
								nonce,
								state.startedAt,
							),
						)
						? [run]
						: [];
				});

				const now = config.now?.() ?? Date.now();

				if (
					now < state.deadline &&
					(runs.length === 0 || runs.some((run) => run.status !== "completed"))
				)
					continue;

				if (runs.length === 1) state.ciRunId = runs[0]?.id ?? null;
				await (entry.generation?.origin.kind === "owner"
					? ownerValidator
					: controllerValidator)(config)({
					runId: claim.runId,
					issue: claim.issue,
					eventAt: contract.contract.snapshot.eventAt,
					baseSha: contract.contract.base.sha,
					now,
					wallMs: CI_DEADLINE_MS,
					round: state.round,
					generation: entry.generation,
					state,
					dispatchAllowed: false,
					save: async (validation) =>
						entry.generation === undefined
							? files.writeClaim({ ...claim, validation })
							: writeAtomic(progress, `${JSON.stringify(validation)}\n`),
				});
			}

			if (
				(!present(join(dir, "verdict.json")) &&
					!present(join(dir, "failure.json"))) ||
				(!entry.retired &&
					present(join(dir, "verdict.json")) &&
					!present(join(dir, "assessment.json")) &&
					jsonField(
						objectOf(
							parseJson(regularText(join(dir, "verdict.json"), 1024 * 1024)),
						),
						"pass",
					) !== true)
			)
				continue;
			await cleanupPublication(api, dir, publication);
		}
	}
}

/**
 * Fetches a run's trusted gate receipt. A `logs` sink also receives the
 * visible check logs beside it in the artifact, for repair feedback.
 */
export type GateReceiptSource = (
	repo: RepoSlug,
	id: number,
	logs?: Map<string, string>,
) => Promise<string | null>;

export async function downloadGateReceipt(
	exec: Exec,
	repo: RepoSlug,
	id: number,
	artifactName = "gate-receipt",
	checkLogs?: Map<string, string>,
): Promise<string | null> {
	const dir = mkdtempSync(join(tmpdir(), "factory-ci-"));

	try {
		const api = new GitHubPublicationApi(exec, repo);

		const listed = objectOf(
			await api
				.request("GET", `actions/runs/${id}/artifacts`)
				.catch(() => undefined),
		);

		const artifacts = (arrayOf(jsonField(listed, "artifacts")) ?? []).filter(
			(value) =>
				jsonField(objectOf(value), "name") === artifactName &&
				jsonField(objectOf(value), "expired") === false,
		);

		if (artifacts.length === 1) {
			const artifactId = countOf(jsonField(objectOf(artifacts[0]), "id"));

			if (artifactId !== null) {
				for (let attempt = 0; attempt < 3; attempt++) {
					const zip = await new Promise<Buffer | null>((done) => {
						execFile(
							"gh",
							["api", `repos/${repo}/actions/artifacts/${artifactId}/zip`],
							{
								encoding: "buffer",
								maxBuffer: 8 * 1024 * 1024,
								timeout: 30_000,
							},
							(error, stdout) => done(error === null ? stdout : null),
						);
					});

					if (zip !== null) {
						const path = join(dir, "artifact.zip");
						await writeFile(path, zip, { mode: 0o600 });
						const receipt = await exec("unzip", ["-p", path, "receipt.json"]);

						if (
							receipt.code === 0 &&
							Buffer.byteLength(receipt.stdout) < 1024 * 1024
						) {
							for (const name of checkLogs === undefined
								? []
								: FEEDBACK_CHECKS) {
								const member = await exec("unzip", [
									"-p",
									path,
									`${name}.log`,
								]).catch(() => null);

								if (member?.code === 0)
									checkLogs?.set(name, member.stdout.slice(0, 1024 * 1024));
							}

							return receipt.stdout;
						}
					}

					if (attempt < 2)
						await new Promise((done) => setTimeout(done, 1000 * 2 ** attempt));
				}
			}
		}

		if (artifactName !== "gate-receipt") return null;

		const jobs = objectOf(await api.request("GET", `actions/runs/${id}/jobs`));

		const gates = (arrayOf(jsonField(jobs, "jobs")) ?? []).filter(
			(value) => jsonField(objectOf(value), "name") === "gates",
		);

		if (gates.length !== 1) return null;
		const jobId = countOf(jsonField(objectOf(gates[0]), "id"));

		if (jobId === null) return null;

		const logs = await exec("gh", [
			"api",
			"--allow-escape-sequences",
			`repos/${repo}/actions/jobs/${jobId}/logs`,
		]);

		if (logs.code !== 0) throw new PublicationError("transport_exhausted");

		const lines = logs.stdout
			.split("\n")
			.map((line) => line.replace(/^\S+\s/, ""));

		const start = lines.findIndex((line) => line === "{");
		const end = lines.findIndex((line, index) => index > start && line === "}");

		return logs.code === 0 && start >= 0 && end > start
			? lines.slice(start, end + 1).join("\n")
			: null;
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
}

async function retireUnissuedIntent(path: string, text: string): Promise<void> {
	try {
		if (present(path) && regularText(path) === text) await unlink(path);
	} catch {
		return;
	}
}

export function controllerCandidatePort(config: {
	readonly stateDir: string;
	readonly exec: Exec;
}): NonNullable<StageExecutor["candidate"]> {
	const files = fileRunFiles(config.stateDir);

	const branchOf = (state: CandidateState) =>
		`factory/pr/${state.pin.issue}-${state.pin.runId.slice(0, 12)}`;

	const allowed = async (state: CandidateState) => {
		if ((await fileAdmissionStore(config.stateDir).localSwitch()) !== "enabled")
			return false;

		const enabled = await new GitHubTicketAdapter({
			exec: config.exec,
			repo: state.pin.repo,
		}).readRepoSwitch();

		return (
			enabled.kind === "ok" &&
			enabled.value.kind === "present" &&
			enabled.value.name === REPO_SWITCH_LABEL
		);
	};

	const postNotice = async (
		state: CandidateState,
		number: number,
		key: string,
		body: string,
		update = false,
	): Promise<boolean> => {
		const adapter = new GitHubTicketAdapter({
			exec: config.exec,
			repo: state.pin.repo,
		});

		const comments = await adapter.readComments(number);

		if (comments.kind !== "ok") return false;

		const matching = comments.value.filter(
			(c) =>
				c.author?.login.toLowerCase() === CONTROLLER_LOGIN.toLowerCase() &&
				c.author.type === "Bot" &&
				c.body.split("\n").includes(key),
		);

		if (matching.length > 1) return false;

		if (matching.length === 1) {
			const comment = matching[0]!;

			if (!update || comment.body === body) return true;

			if (!(await allowed(state))) return false;

			return (
				(
					await new GitHubTicketWriter({
						exec: config.exec,
						repo: state.pin.repo,
					}).editComment(comment.id, body)
				).kind === "posted"
			);
		}

		const dir = join(config.stateDir, "handoff", state.pin.runId, "feedback");
		privateDir(dir);
		const intent = join(dir, `notice-${digestOf(key)}.json`);
		const bytes = JSON.stringify({ key });

		if (present(intent)) {
			if (regularText(intent) !== bytes) return false;
		} else exclusive(intent, bytes);

		if (!(await allowed(state))) {
			await retireUnissuedIntent(intent, bytes);

			return false;
		}

		const posted = await new GitHubTicketWriter({
			exec: config.exec,
			repo: state.pin.repo,
		}).postComment(number, body);

		if (posted.kind === "rejected") await retireUnissuedIntent(intent, bytes);

		return posted.kind === "posted";
	};

	const apiOf = (state: CandidateState) =>
		new GitHubPublicationApi(config.exec, state.pin.repo);

	const retainMerge = async (
		state: CandidateState,
		raw: JsonValue | undefined,
		pr: OwnedPullRequest,
	) => {
		const mergedAt = textOf(jsonField(objectOf(raw), "merged_at"));

		if (
			pr.status.kind !== "merged" ||
			mergedAt === null ||
			!validLedgerInstant(mergedAt)
		)
			return;
		await installOnce(
			join(config.stateDir, "accounting", state.pin.runId, "merge.json"),
			`${JSON.stringify({
				v: 1,
				runId: state.pin.runId,
				repo: state.pin.repo,
				number: pr.number,
				headSha: pr.head,
				mergeSha: pr.status.mergeSha,
				mergedAt,
			})}\n`,
		);
	};

	const ownedPr = async (
		state: CandidateState,
	): Promise<OwnedPullRequest | null> => {
		const api = apiOf(state);
		const branch = branchOf(state);

		const number =
			state.kind === "selected" ? state.published?.number : undefined;

		if (number !== undefined) {
			const raw = await api.request("GET", `pulls/${number}`);

			const pr = parseOwnedPullRequest(raw, {
				...state.pin,
				branch,
				knownNumber: number,
			});

			if (pr === null) throw new PublicationError("pr_identity");
			await retainMerge(state, raw, pr);

			return pr;
		}

		const listed = arrayOf(
			await api.request(
				"GET",
				`pulls?state=all&head=${encodeURIComponent(`${state.pin.repo.split("/")[0]}:${branch}`)}&base=main&per_page=100`,
			),
		);

		if (listed === null || listed.length >= 100 || listed.length > 1)
			throw new PublicationError("pr_ambiguous");

		if (listed.length === 0) return null;
		const discovered = countOf(jsonField(objectOf(listed[0]), "number"));

		if (discovered === null) throw new PublicationError("pr_identity");

		const raw = await api.request("GET", `pulls/${discovered}`);

		const pr = parseOwnedPullRequest(raw, { ...state.pin, branch });

		if (pr === null) throw new PublicationError("pr_identity");
		await retainMerge(state, raw, pr);

		return pr;
	};

	const observation = async (
		state: CandidateState,
		now: number,
	): Promise<
		Omit<
			Extract<CandidateEvent, { kind: "observed" }>,
			"executionAllowed" | "capacityAvailable"
		>
	> => {
		if (state.kind === "selected")
			await keepFeedbackRounds(config.stateDir, state);
		const api = apiOf(state);

		let pr: Extract<CandidateEvent, { kind: "observed" }>["pr"] = {
			kind: "none",
		};

		const possible =
			state.kind === "selected" &&
			(state.published !== null ||
				(state.work.kind === "effect" &&
					state.work.request.kind === "open_pr"));

		if (possible) {
			try {
				const found = await ownedPr(state);

				if (found !== null) {
					if (found.status.kind === "merged")
						pr = {
							kind: "merged",
							number: found.number,
							head: found.head,
							mergeSha: found.status.mergeSha,
							actor: found.status.actor,
						};
					else if (found.status.kind === "closed")
						pr = { kind: "closed", number: found.number, head: found.head };
					else {
						const refHead = await api.prRef(branchOf(state));
						pr =
							refHead === null
								? { kind: "unavailable" }
								: {
										kind: "open",
										number: found.number,
										head: found.head,
										refHead,
									};
					}
				} else if (
					present(
						join(config.stateDir, "handoff", state.pin.runId, "create.json"),
					)
				) {
					pr = { kind: "unavailable" };
				}
			} catch {
				pr = { kind: "unavailable" };
			}
		}

		const result: Omit<
			Extract<CandidateEvent, { kind: "observed" }>,
			"executionAllowed" | "capacityAvailable"
		> = {
			kind: "observed",
			now,
			pr,
			main: null,
			eligibility: "unverified",
			feedback: { kind: "none" },
			readiness: { kind: "unavailable" },
		};

		if (pr.kind === "merged" || pr.kind === "closed") return result;

		const adapter = new GitHubTicketAdapter({
			exec: config.exec,
			repo: state.pin.repo,
		});

		const issue = await adapter.readIssue(state.pin.issue);
		let eligibility: "ready" | "withdrawn" | "unverified" = "unverified";

		if (issue.kind === "ok") {
			if (!issue.value.open || !issue.value.labels.includes(READY_LABEL))
				eligibility = "withdrawn";
			else {
				const timeline = await adapter.readTimeline(state.pin.issue);

				if (timeline.kind === "ok") {
					const latest = latestReadyEntry(timeline.value);

					if (latest.kind === "found") {
						const admission = await fileAdmissionStore(config.stateDir).read({
							repo: state.pin.repo,
							issue: state.pin.issue,
							eventId: latest.entry.id,
						});

						eligibility =
							latest.entry.kind === "labeled" &&
							admission.kind === "found" &&
							admission.receipt.baseSha === state.pin.workflowSha
								? "ready"
								: "withdrawn";
					}
				}
			}
		}

		let main: GitSha | null = null;

		try {
			const ref = objectOf(await api.request("GET", "git/ref/heads/main"));
			const head = textOf(jsonField(objectOf(jsonField(ref, "object")), "sha"));

			if (head !== null && isGitSha(head)) main = head;
		} catch {
			main = null;
		}

		let readiness: Extract<CandidateEvent, { kind: "observed" }>["readiness"] =
			{ kind: "unavailable" };

		const candidate =
			state.kind === "selected" ? handoffGeneration(state, pr) : null;

		if (
			state.kind === "selected" &&
			candidate?.certification != null &&
			candidate.validation !== null
		) {
			const certificate = candidate.certification;

			try {
				const report = await controllerReport(
					config,
					state.pin.repo,
					state.pin.runId,
					candidate.validation,
					certificate.verdict,
				);

				const checks = objectOf(
					await api.request(
						"GET",
						`commits/${certificate.verdict.candidateSha}/check-runs?filter=all&per_page=100`,
					),
				);

				const runs = arrayOf(jsonField(checks, "check_runs"));

				const mandatory =
					runs?.filter((r) => jsonField(objectOf(r), "name") === "check") ?? [];

				const check = objectOf(mandatory[0]);

				if (
					report !== null &&
					runs !== null &&
					jsonField(checks, "total_count") === runs.length &&
					(state.published === null ||
						(state.current.intent.publication.kind === "successor" &&
							pr.kind === "open" &&
							pr.head !== report.candidateSha &&
							pr.head === state.current.intent.publication.expectedHead &&
							pr.refHead === state.current.intent.publication.expectedHead) ||
						(mandatory.length === 1 &&
							jsonField(check, "head_sha") === report.candidateSha &&
							jsonField(check, "status") === "completed" &&
							jsonField(check, "conclusion") === "success" &&
							jsonField(objectOf(jsonField(check, "app")), "id") === 15368))
				)
					readiness = { kind: "current", head: report.candidateSha, report };
				else
					readiness = {
						kind: "not_ready",
						reason:
							mandatory.length === 1 &&
							jsonField(check, "head_sha") ===
								certificate.verdict.candidateSha &&
							jsonField(check, "status") === "completed" &&
							jsonField(check, "conclusion") !== "success" &&
							jsonField(objectOf(jsonField(check, "app")), "id") === 15368
								? "checks_failed"
								: "checks_incomplete",
					};
			} catch {
				readiness = { kind: "unavailable" };
			}
		}

		const head = promotedHead(state);

		const feedback =
			state.kind === "selected" &&
			state.published !== null &&
			pr.kind === "open" &&
			head !== null
				? await observeFeedback({
						stateDir: config.stateDir,
						adapter,
						runId: state.pin.runId,
						pr: pr.number,
						head,
						prHead: pr.head,
						refHead: pr.refHead,
						seen: state.feedback?.seen ?? [],
						held: state.feedback?.overflow !== undefined,
					})
				: { kind: "none" as const };

		return { ...result, main, eligibility, readiness, feedback };
	};

	const publicBody = async (
		state: Extract<CandidateState, { kind: "selected" }>,
		ref?: GenerationRef,
	) => {
		const contract = await files.readContract(state.pin.runId);

		const certificate =
			ref === undefined
				? state.current.certification
				: (candidateGenerations(state).find((g) =>
						sameGeneration(g.intent, ref),
					)?.certification ?? null);

		if (contract.kind !== "found" || certificate === null)
			throw new PublicationError("evidence_unavailable");

		const summary = renderSummary({
			runId: state.pin.runId,
			contract: contract.contract,
			digest: contract.digest,
		});

		if (summary === null) throw new PublicationError("summary_too_large");

		const suite = await files.artifacts.read(
			state.pin.runId,
			contract.contract,
			contract.digest,
		);

		// The body states R8 from the stored family evidence, recomputed here,
		// never from the receipt's own `r8` or labels. A version 3 receipt's
		// accept evidence must be the acceptance receipt's own.
		const review = certificate.review;

		if (
			suite.kind !== "found" ||
			suite.receipt.acceptanceDigest !== certificate.verdict.acceptanceDigest ||
			!familyClaimsHold(review) ||
			(review.version === 3 &&
				JSON.stringify(review.accept) !==
					JSON.stringify(suite.receipt.family ?? FAMILY_MISSING))
		)
			throw new PublicationError("evidence_unavailable");

		const limitations = notProven({
			criteria: contract.contract.acceptance,
			scenarios: suite.suite.scenarios,
			r8: reviewR8(review),
			judgments: certificate.review.seats.flatMap((seat) => seat.judgments),
		});

		return [
			`## Factory handoff`,
			withoutKey(summary),
			`Candidate: ${certificate.verdict.candidateSha}\nGate: ${certificate.verdict.gateSha}\nCI: https://github.com/${state.pin.repo}/actions/runs/${certificate.verdict.ciRunId}`,
			`All required hard checks passed. Patch ${certificate.verdict.patchDigest.slice(0, 12)}; acceptance ${certificate.verdict.acceptanceDigest.slice(0, 12)}.`,
			...certificate.review.seats.map(
				(seat) =>
					`- ${inert(seat.seat)}: ${inert(seat.label)}; ${seat.findings.length} findings`,
			),
			...certificate.review.seats.flatMap((seat) =>
				seat.findings
					.slice(0, 5)
					.map((f) => `- ${inert(f.severity)}: ${inert(f.claim)}`),
			),
			"## Not proven",
			limitations.map(renderLimitation).join("\n"),
			"The factory waits for the owner's merge; it cannot merge or arm auto-merge.",
			`<!-- factory:pr ${state.pin.runId} -->`,
		].join("\n\n");
	};

	return {
		async observeMissing(marker) {
			if (marker.pr === null) return { kind: "none" };
			const api = new GitHubPublicationApi(config.exec, marker.repo);
			const branch = `factory/pr/${marker.issue}-${marker.runId.slice(0, 12)}`;

			const pr = parseOwnedPullRequest(
				await api.request("GET", `pulls/${marker.pr}`),
				{
					repo: marker.repo,
					runId: marker.runId,
					branch,
					knownNumber: marker.pr,
				},
			);

			if (pr === null) return { kind: "unavailable" };
			const status = pr.status;

			if (status.kind !== "merged") return { kind: "unavailable" };

			const observed = {
				kind: "merged" as const,
				number: pr.number,
				head: pr.head,
				mergeSha: status.mergeSha,
				actor: status.actor,
			};

			const dir = join(config.stateDir, "handoff", marker.runId);
			privateDir(dir);
			await writeOnce(
				join(dir, "missing-evidence-observation.json"),
				`${JSON.stringify(observed)}\n`,
			);

			return observed;
		},
		observe: observation,
		async sweep(repo, now) {
			if (
				(await fileAdmissionStore(config.stateDir).localSwitch()) !== "enabled"
			)
				return;
			const dir = join(config.stateDir, "feedback-sweep");
			privateDir(dir);
			const cursor = join(dir, "ledger.json");

			const last = present(cursor)
				? countOf(jsonField(objectOf(parseJson(regularText(cursor))), "at"))
				: null;

			if (last !== null && now - last < 3_600_000) return;

			if (!(await writeAtomic(cursor, JSON.stringify({ version: 1, at: now }))))
				return;

			const api = ledgerApiOf(
				new GitHubPublicationApi(
					config.exec,
					repo,
					{},
					async () => true,
					undefined,
					{ now: Date.now, sliceMs: 20_000, callMs: 5_000 },
				),
			);

			const tip = await api.ref();

			if (tip === null) return;
			const commit = await api.commit(tip);
			const file = await api.file(commit.tree);
			const lines = parseLedger(file.bytes);

			if (!lines.every((line) => line.kind === "known")) return;

			const landed = lines.flatMap((line) =>
				line.kind === "known" &&
				line.row.repo === repo &&
				line.row.outcome.kind === "landed" &&
				line.row.pr !== null
					? [{ runId: line.row.runId, pr: line.row.pr.number }]
					: [],
			);

			if (landed.length > 0)
				await sweepMergedFeedback({ ...config, repo, now, landed });
		},
		async patch(state, round) {
			if (
				state.kind === "selected" &&
				state.current.intent.origin.kind === "owner"
			)
				return readOwnerPatch(
					config.stateDir,
					state.pin.runId,
					state.current.intent.origin.head,
					state.current.intent.baseSha,
				);

			const patch = readPatch(config.stateDir, {
				runId: state.pin.runId,
				round,
				baseSha: state.pin.originalBase,
				contractDigest: state.pin.contractDigest,
				acceptanceDigest: state.pin.acceptanceDigest,
			});

			return patch.kind === "found" ? patch : null;
		},
		async execute(state, request) {
			if (state.kind !== "selected") return null;
			await keepFeedbackRounds(config.stateDir, state);
			const api = apiOf(state);

			const writer = new GitHubTicketWriter({
				exec: config.exec,
				repo: state.pin.repo,
			});

			if (request.kind === "finish_pr") {
				const terminal = request.terminal;
				const pr = terminal.kind === "failed" ? null : await ownedPr(state);

				if (terminal.kind === "cancelled" && pr?.status.kind === "merged")
					return null;

				if (terminal.kind === "merged") {
					if (
						pr?.status.kind !== "merged" ||
						pr.status.mergeSha !== terminal.mergeSha
					)
						return null;

					const issue = objectOf(
						await api.request("GET", `issues/${state.pin.issue}`),
					);

					if (jsonField(issue, "state") !== "closed")
						await api.request(
							"PATCH",
							`issues/${state.pin.issue}`,
							{ state: "closed" },
							true,
						);
				} else if (terminal.kind === "cancelled" && pr?.status.kind === "open")
					await api.request(
						"PATCH",
						`pulls/${pr.number}`,
						{ state: "closed" },
						true,
					);

				return { kind: "finish_pr", request };
			}

			if (!(await allowed(state))) return null;

			if (request.kind === "derive_owner_patch") {
				const contract = await files.readContract(state.pin.runId);

				if (
					contract.kind !== "found" ||
					contract.digest !== state.pin.contractDigest
				)
					return {
						kind: "derive_owner_patch",
						request,
						result: { kind: "refused", reason: "unreadable" },
					};

				const suite = await files.artifacts.read(
					state.pin.runId,
					contract.contract,
					contract.digest,
				);

				if (
					suite.kind !== "found" ||
					suite.receipt.acceptanceDigest !== state.pin.acceptanceDigest
				)
					return {
						kind: "derive_owner_patch",
						request,
						result: { kind: "refused", reason: "unreadable" },
					};

				try {
					const heldout = publishedSuite({
						issue: state.pin.issue,
						suite: suite.suite,
						canary: regularText(
							join(
								config.stateDir,
								"acceptance",
								state.pin.runId,
								"canary.txt",
							),
						).trimEnd(),
						acceptanceDigest: state.pin.acceptanceDigest,
					});

					const result = await deriveOwnerPatch(api, {
						stateDir: config.stateDir,
						runId: state.pin.runId,
						head: request.head,
						baseSha: request.baseSha,
						contractDigest: state.pin.contractDigest,
						acceptanceDigest: state.pin.acceptanceDigest,
						heldoutDigest: heldout.digest,
						suite: heldout.files,
						checkout: async (sha, workspace) => {
							const checked = await checkoutWorkspace({
								stateDir: join(workspace, "..", `checkout-${sha}`),
								workspace,
								runId: state.pin.runId,
								repo: state.pin.repo,
								sha,
								fetch: ghTarball,
							});

							return checked.kind === "ready" && checked.omitted === 0;
						},
					});

					return { kind: "derive_owner_patch", request, result };
				} catch {
					return {
						kind: "derive_owner_patch",
						request,
						result: { kind: "refused", reason: "unreadable" },
					};
				}
			}

			if (request.kind === "post_notice") {
				const batch = state.feedback?.batches.findLast((b) =>
					request.notice.kind === "round_summary"
						? b.round !== undefined &&
							b.status.kind === "settled" &&
							b.status.outcome.kind === "stopped" &&
							request.notice.key ===
								`<!-- factory:notice ${state.pin.runId} round_summary ${b.round} -->`
						: request.notice.key ===
							`<!-- factory:notice ${state.pin.runId} ${request.notice.kind} ${b.digest} -->`,
				);

				if (request.number !== state.published?.number) return null;

				const dir = join(
					config.stateDir,
					"handoff",
					state.pin.runId,
					"feedback",
				);

				if (
					request.withdraw !== null &&
					(await writer.removeLabel(request.number, "factory:review")).kind !==
						"posted"
				)
					return null;
				let body: string | null;

				if (request.notice.kind === "round_summary") {
					if (batch === undefined) return null;
					const receipt = feedbackRound(config.stateDir, state, batch);

					if (receipt === null) return null;
					body = await roundSummary(
						config.stateDir,
						state.pin.runId,
						receipt.receipt,
						request.notice.key,
						batch.status.kind === "settled" &&
							batch.status.outcome.kind === "stopped"
							? `held: ${batch.status.outcome.reason}`
							: "held",
						state.current.intent.round === receipt.receipt.round
							? (state.current.verdict?.candidateSha ??
									state.current.validation?.publication?.candidateSha ??
									null)
							: null,
						!receipt.batchAvailable,
					);
				} else if (
					["owner_head", "owner_head_failed", "checks_failed"].includes(
						request.notice.kind,
					)
				) {
					body = [
						"## Factory owner-head review",
						request.notice.kind === "owner_head"
							? "An owner push withdrew readiness. The factory will run trusted gates and review on this exact head, without building or rewriting owner commits."
							: request.detail === "owner_head_behind"
								? "Readiness is withdrawn. Main moved under the owner head. Please update the branch; the factory will not refresh or build on owner commits."
								: `Readiness is withdrawn. Owner-head certification is held: ${request.detail ?? request.notice.kind}${request.refusal === undefined ? "" : ` (${request.refusal})`}. No owner commit was rewritten.${request.refusal === "behind_main" ? " Please update the branch with main before certification can continue." : ""}`,
						`Head: ${request.notice.key.split(" ").at(-2)}`,
						request.notice.key,
					].join("\n\n");
				} else if (request.notice.kind === "feedback_overflow") {
					if (state.feedback?.overflow === undefined) return null;
					body = [
						"## Factory feedback overflow",
						"Feedback intake is held as feedback_overflow. A card metadata or cursor limit was reached. Stored feedback is retained; no repair will start. Owner intervention is needed before intake can continue. Readiness and budgets are unchanged.",
						request.notice.key,
					].join("\n\n");
				} else {
					if (batch === undefined) return null;

					const bytes = regularText(join(dir, `${batch.digest}.json`));

					if (digestOf(bytes) !== batch.digest) return null;
					const stored = objectOf(parseJson(bytes));
					const records = arrayOf(jsonField(stored, "records"));

					if (
						records === null ||
						jsonField(stored, "runId") !== state.pin.runId ||
						jsonField(stored, "head") !== batch.head ||
						jsonField(stored, "pr") !== request.number
					)
						return null;

					const refused = records
						.flatMap((r) => arrayOf(jsonField(objectOf(r), "inline")) ?? [])
						.filter(
							(c) =>
								jsonField(
									objectOf(jsonField(objectOf(c), "intake")),
									"kind",
								) === "refused",
						).length;

					body = [
						request.notice.kind === "repair_started"
							? "## Factory feedback repair started"
							: request.notice.kind === "repair_unavailable"
								? "## Factory feedback repair unavailable"
								: "## Factory feedback intake",
						...(request.notice.kind === "repair_started"
							? [
									"Readiness is withdrawn: factory:review was removed. One repair round will run on this same PR, with fresh validation and review before readiness can return. The shared two-round cap and cumulative budgets are unchanged. Owner commits will never be overwritten.",
								]
							: request.notice.kind === "repair_unavailable"
								? [
										`No repair starts: ${request.detail ?? (batch.status.kind === "settled" && batch.status.outcome.kind === "refused" ? batch.status.outcome.reason : "repair_unavailable")}.  Readiness and budgets are unchanged. Current round ${state.current.intent.round}; the shared cap is two rounds. Budget usage ${candidateUsage(state)} of ${state.pin.maxTokens} tokens; the current assessment and remaining attempt/round allowance must also authorize a repair.`,
									]
								: batch.actionable && batch.status.kind === "queued"
									? [
											"Your change request is queued for the next stage boundary. Dismissing the review or pushing an owner head cancels it. A controller refresh of the unchanged patch carries it forward. Readiness and budgets are unchanged until repair starts.",
										]
									: []),
						...(refused > 0
							? [
									`Refused ${refused} inline comment(s) on held-out acceptance files. Their text is not forwarded.`,
								]
							: []),
						request.notice.key,
					].join("\n\n");
				}

				if (body === null) return null;

				const number =
					request.notice.place === "pr" ? request.number : state.pin.issue;

				if (
					!(await postNotice(
						state,
						number,
						request.notice.key,
						body,
						request.notice.kind === "round_summary",
					))
				)
					return null;

				return { kind: "post_notice", request };
			}

			if (request.kind === "open_pr") {
				let found = await ownedPr(state);

				if (found === null) {
					await api.promotePr(request.branch, null, request.head);
					const dir = join(config.stateDir, "handoff", state.pin.runId);
					privateDir(dir);
					const intent = join(dir, "create.json");

					if (present(intent)) return null;
					const bytes = `${JSON.stringify(request)}\n`;
					exclusive(intent, bytes);

					if (!(await allowed(state))) {
						await retireUnissuedIntent(intent, bytes);

						return null;
					}

					try {
						await api.request(
							"POST",
							"pulls",
							{
								head: request.branch,
								base: "main",
								draft: false,
								title: `factory: issue ${state.pin.issue}`,
								body: await publicBody(state),
							},
							true,
						);
					} catch {
						return null;
					}

					found = await ownedPr(state);
				}

				if (found === null) return null;
				const refHead = await api.prRef(request.branch);

				if (refHead === null) return null;

				return {
					kind: "open_pr",
					request,
					number: found.number,
					head: found.head,
					refHead,
				};
			}

			if (request.kind === "promote_pr") {
				try {
					await api.promotePr(
						branchOf(state),
						request.expectedHead,
						request.head,
					);
				} catch (error) {
					if (
						!(error instanceof PublicationError) ||
						error.reason !== "branch_moved"
					)
						throw error;

					try {
						const pr = await ownedPr(state);
						const refHead = await api.prRef(branchOf(state));

						return pr === null || refHead === null
							? null
							: { kind: "promote_pr", request, head: pr.head, refHead };
					} catch {
						return null;
					}
				}

				const pr = await ownedPr(state);
				const refHead = await api.prRef(branchOf(state));

				return pr === null || refHead === null
					? null
					: { kind: "promote_pr", request, head: pr.head, refHead };
			}

			if (request.kind === "void_readiness") {
				const result = await writer.removeLabel(
					request.number,
					"factory:review",
				);

				return result.kind === "posted"
					? { kind: "void_readiness", request }
					: null;
			}

			const applying = completingFeedbackBatch(state, request.certification);

			const receipt =
				applying === null
					? null
					: feedbackRound(config.stateDir, state, applying, request.head);

			if (applying !== null && receipt === null) return null;

			const pr = await ownedPr(state);

			if (
				pr?.status.kind !== "open" ||
				pr.head !== request.head ||
				(await api.prRef(branchOf(state))) !== request.head
			)
				return null;
			const raw = objectOf(await api.request("GET", `pulls/${pr.number}`));
			const reviewers = arrayOf(jsonField(raw, "requested_reviewers")) ?? [];
			const owner = state.pin.repo.split("/")[0];

			if (owner === undefined) return null;

			if (!reviewers.some((r) => jsonField(objectOf(r), "login") === owner)) {
				if (!(await allowed(state))) return null;
				await api.request(
					"POST",
					`pulls/${pr.number}/requested_reviewers`,
					{ reviewers: [owner] },
					true,
				);
			}

			if (!(await allowed(state))) return null;
			const labeled = await writer.addLabels(pr.number, ["factory:review"]);

			if (labeled.kind !== "posted") return null;
			const key = `<!-- factory:handoff ${state.pin.runId} ${request.head} -->`;

			const adapter = new GitHubTicketAdapter({
				exec: config.exec,
				repo: state.pin.repo,
			});

			const comments = await adapter.readComments(state.pin.issue);

			if (comments.kind !== "ok") return null;

			const matching = comments.value.filter(
				(c) =>
					c.author?.login === "exe-dev-github-integration[bot]" &&
					c.author.type === "Bot" &&
					c.body.split("\n").includes(key),
			);

			if (matching.length > 1) return null;

			if (matching.length === 0) {
				const dir = join(config.stateDir, "handoff", state.pin.runId);
				privateDir(dir);
				const intent = join(dir, `comment-${request.head}.json`);

				if (present(intent)) return null;
				const bytes = JSON.stringify({ key });
				exclusive(intent, bytes);

				if (!(await allowed(state))) {
					await retireUnissuedIntent(intent, bytes);

					return null;
				}

				const comment = await writer.postComment(
					state.pin.issue,
					`${await publicBody(state, request.certification)}\n\nPR: https://github.com/${state.pin.repo}/pull/${pr.number}\n${key}`,
				);

				if (comment.kind !== "posted") return null;
			}

			if (receipt !== null) {
				const summaryKey = `<!-- factory:notice ${state.pin.runId} round_summary ${receipt.receipt.round} -->`;

				const summary = await roundSummary(
					config.stateDir,
					state.pin.runId,
					receipt.receipt,
					summaryKey,
					"ready after fresh validation and review",
					request.head,
					!receipt.batchAvailable,
				);

				if (summary === null) return null;

				if (
					!(await postNotice(state, request.number, summaryKey, summary, true))
				)
					return null;
			}

			return { kind: "complete_handoff", request, now: Date.now() };
		},
	};
}

function roundDisposition(
	outcome: RoundReceipt["outcome"],
	item: Omit<BuilderDisposition, "event"> | undefined,
): FeedbackDisposition {
	if (outcome.kind === "merged")
		return { kind: "merged", mergeSha: outcome.mergeSha };

	if (outcome.kind === "superseded")
		return { kind: "rejected", reason: "superseded" };

	if (outcome.kind === "stopped" || outcome.kind === "build_failed")
		return { kind: "rejected", reason: "repair_stopped" };

	return item?.kind === "adopted"
		? { kind: "adopted", head: outcome.head, source: "builder_reported" }
		: { kind: "rejected", reason: item?.reason ?? "builder_declined" };
}

function feedbackRound(
	stateDir: string,
	state: Extract<CandidateState, { kind: "selected" }>,
	ref: FeedbackBatchRef,
	appliedHead?: import("../src/workflow.ts").GitSha,
	failedAttempt?: number,
): Readonly<{ receipt: RoundReceipt; batchAvailable: boolean }> | null {
	const read = readFeedbackBatch(stateDir, state.pin.runId, ref.digest);

	const stored =
		read !== null &&
		read.batch.pr === state.published?.number &&
		read.batch.head === ref.head
			? read
			: null;

	const round =
		ref.round ??
		(ref.status.kind === "applying" ? ref.status.round : undefined);

	if (round === undefined) return null;

	const outcome =
		failedAttempt !== undefined
			? { kind: "build_failed" as const }
			: appliedHead === undefined
				? ref.status.kind === "settled"
					? ref.status.outcome
					: null
				: { kind: "applied" as const, head: appliedHead };

	if (
		outcome === null ||
		outcome.kind === "no_action" ||
		outcome.kind === "refused"
	)
		return null;

	if (stored === null && outcome.kind === "applied") return null;

	const patch = readPatch(stateDir, {
		runId: state.pin.runId,
		baseSha: state.pin.originalBase,
		contractDigest: state.pin.contractDigest,
		acceptanceDigest: state.pin.acceptanceDigest,
		round,
	});

	const attempt = failedAttempt ?? ref.attempt ?? 1;

	const noChange = readRepairBuildResult(
		stateDir,
		state.pin.runId,
		round,
		attempt,
	);

	const decisions = noChange ?? (patch.kind === "found" ? patch.receipt : null);
	const reported = decisions?.dispositions ?? [];
	const findingReported = decisions?.findingDispositions ?? [];

	const decision = (item: Omit<BuilderDisposition, "event"> | undefined) =>
		roundDisposition(outcome, item);

	const disposition = (event: FeedbackId) =>
		decision(reported.find((d) => d.event === event));

	const builderDecision = (event: FeedbackId, forwarded = true) => {
		const item = forwarded
			? reported.find((d) => d.event === event)
			: undefined;

		if (item === undefined) return {};
		const { event: _event, ...builder } = item;

		return { builder };
	};

	const records =
		stored?.batch.records ??
		ref.reviews.map((event) => ({
			event,
			actor: "",
			intake: { kind: "actionable" } as const,
			inline: [],
		}));

	const items = records.flatMap((r) => [
		...(r.intake.kind === "actionable"
			? [
					{
						event: r.event,
						disposition: disposition(r.event),
						...builderDecision(r.event),
					},
				]
			: []),
		...r.inline.map((c) => ({
			event: c.id,
			...builderDecision(c.id, c.intake.kind !== "refused"),
			disposition:
				c.intake.kind === "refused"
					? ({ kind: "rejected", reason: "heldout_path" } as const)
					: disposition(c.id),
		})),
	]);

	const build = state.accounts.findLast(
		(a) =>
			a.execution.stage === "build" &&
			a.execution.cause.kind === "feedback" &&
			a.execution.cause.batch === ref.digest &&
			(failedAttempt === undefined || a.execution.attempt === failedAttempt),
	)?.execution;

	const prior =
		build?.stage === "build"
			? candidateGenerations(state).find(
					(g) => g.intent.digest === build.feedbackFrom.digest,
				)
			: state.current;

	const reviews = [
		prior?.review ?? prior?.certification?.review,
		...candidateGenerations(state)
			.filter((g) => g.intent.round === round)
			.map((g) => g.review ?? g.certification?.review),
	];

	const findings = [
		...new Map(
			reviews.flatMap(
				(r) =>
					r?.seats.flatMap((seat) =>
						findingFingerprints({ seats: [seat] }).map(
							(fingerprint) =>
								[
									fingerprint,
									{
										fingerprint,
										seat: seat.seat,
										disposition: decision(
											findingReported.find(
												(f) => f.fingerprint === fingerprint,
											),
										),
									},
								] as const,
						),
					) ?? [],
			),
		).values(),
	];

	return {
		receipt: {
			round,
			attempt: failedAttempt ?? build?.attempt ?? ref.attempt ?? 1,
			outcome,
			batch: ref.digest,
			items,
			findings,
		},
		batchAvailable: stored !== null,
	};
}

async function roundSummary(
	stateDir: string,
	runId: Digest,
	receipt: RoundReceipt,
	key: string,
	result: string,
	head: string | null,
	batchUnavailable = false,
): Promise<string | null> {
	try {
		if (!(await keepRoundReceipt(stateDir, runId, receipt))) return null;
		const dir = join(stateDir, "handoff", runId, "feedback");
		const attempts: RoundReceipt[] = [];

		for (let attempt = 1; attempt <= receipt.attempt; attempt++) {
			const path = join(dir, `round-${receipt.round}-a${attempt}.json`);

			if (!present(path)) continue;
			// SAFETY: controller-written immutable attempt artifact, never candidate input.
			attempts.push(JSON.parse(regularText(path)) as RoundReceipt);
		}

		const describe = (d: FeedbackDisposition) =>
			d.kind === "adopted"
				? `adopted (builder-reported), head ${d.head}`
				: d.kind === "merged"
					? `merged at ${d.mergeSha}`
					: `rejected: ${d.reason}`;

		return [
			`## Factory feedback round ${receipt.round}`,
			`Result: ${result}. Head: ${head ?? "no new candidate head"}.`,
			...(batchUnavailable
				? [
						"Original batch text is unavailable. Only review IDs retained in the book can be listed; inline details are not reconstructed.",
					]
				: []),
			"Adoption is builder-reported, not controller proof. Readiness requires fresh validation and review. No owner commits were rewritten.",
			...attempts.flatMap((attempt) => [
				`### Attempt ${attempt.attempt}\n\n${attempt.attempt === receipt.attempt ? result : attempt.outcome.kind === "stopped" ? `held: ${attempt.outcome.reason}` : attempt.outcome.kind}`,
				...attempt.items.map(
					(i) =>
						`- \`${i.event}\`: ${describe(i.disposition)}${i.builder === undefined ? "" : ` — Builder ${i.builder.kind === "rejected" && i.builder.reason === "builder_declined" ? "declined" : i.builder.kind}: ${inert(i.builder.detail ?? i.builder.reason ?? "builder-reported")}`}`,
				),
				...attempt.findings.map(
					(f) =>
						`- Finding \`${f.fingerprint}\` (${f.seat}): ${describe(f.disposition)}`,
				),
			]),
			key,
		].join("\n\n");
	} catch {
		return null;
	}
}

/** Attempt evidence is immutable; the per-round index always names its latest attempt. */
async function keepRoundReceipt(
	stateDir: string,
	runId: Digest,
	receipt: RoundReceipt,
): Promise<boolean> {
	try {
		const dir = join(stateDir, "handoff", runId, "feedback");
		const name = `round-${receipt.round}-a${receipt.attempt}.json`;
		const path = join(dir, name);

		if (!present(path)) exclusive(path, `${JSON.stringify(receipt)}\n`);
		// SAFETY: controller-authored write-once artifact, not model output.
		const stored = JSON.parse(regularText(path)) as RoundReceipt;
		const index = join(dir, `round-${receipt.round}.json`);

		const previous = present(index)
			? countOf(
					fieldOf(objectOf(parseJson(regularText(index))), "latestAttempt"),
				)
			: null;

		if (previous !== null && previous > stored.attempt) return true;
		const bytes = `${JSON.stringify({ round: stored.round, latestAttempt: stored.attempt, outcome: stored.outcome, receipt: name })}\n`;

		if (present(index) && regularText(index) === bytes) return true;

		return await writeAtomic(index, bytes);
	} catch {
		return false;
	}
}

/** Recreate missing receipts and indices from the book, without a model replay. */
async function keepFeedbackRounds(
	stateDir: string,
	state: Extract<CandidateState, { kind: "selected" }>,
): Promise<void> {
	for (const ref of state.feedback?.batches ?? []) {
		for (const attempt of ref.failedAttempts ?? []) {
			const failed = feedbackRound(stateDir, state, ref, undefined, attempt);

			if (failed !== null)
				await keepRoundReceipt(stateDir, state.pin.runId, failed.receipt);
		}

		if (ref.status.kind !== "settled" || ref.round === undefined) continue;
		const receipt = feedbackRound(stateDir, state, ref);

		if (receipt !== null)
			await keepRoundReceipt(stateDir, state.pin.runId, receipt.receipt);
	}
}

export async function storeFeedbackBatch(
	stateDir: string,
	batch: FeedbackBatch,
	full: string | null,
): Promise<
	NonNullable<Extract<FeedbackObservation, { kind: "read" }>["batch"]>
> {
	const dir = join(resolve(stateDir), "handoff", batch.runId, "feedback");
	privateDir(dir);

	const put = async (path: string, bytes: string) => {
		if (present(path)) {
			const stat = lstatSync(path);

			if (!stat.isFile() || (stat.mode & 0o077) !== 0)
				throw new Error("unsafe private file");

			if (
				stat.size === Buffer.byteLength(bytes) &&
				digestOf(regularText(path, stat.size)) === digestOf(bytes)
			)
				return;
		}

		if (!(await writeAtomic(path, bytes))) throw new Error("feedback_write");
	};

	if (batch.full !== null) {
		if (
			full === null ||
			digestOf(full) !== batch.full.digest ||
			Buffer.byteLength(full) !== batch.full.bytes
		)
			throw new Error("feedback_full_binding");
		await put(join(dir, `${batch.full.digest}.full.json`), full);
	}

	const bytes = canonicalJson(batch);
	const digest = digestOf(bytes);
	await put(join(dir, `${digest}.json`), bytes);

	const stored: NonNullable<
		Extract<FeedbackObservation, { kind: "read" }>["batch"]
	> = {
		digest,
		seen: batch.records.map((r) => r.event).sort(),
		reviews: batch.records
			.filter((r) => r.intake.kind === "actionable")
			.map((r) => r.event)
			.sort(),
		actionable: batch.records.some((r) => r.intake.kind === "actionable"),
		refusedInline: batch.records.some((r) =>
			r.inline.some((c) => c.intake.kind === "refused"),
		),
	};

	return batch.overflow === true ? { ...stored, overflow: true } : stored;
}

async function feedbackEvents(
	adapter: GitHubTicketAdapter,
	pr: number,
	seen: readonly FeedbackId[],
): Promise<
	| Readonly<{ kind: "read"; events: readonly FeedbackEvent[] }>
	| Extract<FeedbackObservation, { kind: "unavailable" }>
> {
	const comments = await adapter.readComments(pr);
	const reviews = await adapter.readPullReviews(pr);

	if (comments.kind === "failed")
		return {
			kind: "unavailable",
			reason: "comments",
			failure: comments.failure.kind,
		};

	if (reviews.kind === "failed")
		return {
			kind: "unavailable",
			reason: "reviews",
			failure: reviews.failure.kind,
		};
	const events: FeedbackEvent[] = [];

	for (const c of comments.value) {
		if (c.author === null) continue;
		events.push({
			kind: "conversation",
			id: feedbackId(adapter.repo, "issue-comment", Number(c.id)),
			pr,
			actor: c.author.login,
			at: c.createdAt,
			body: c.body,
		});
	}

	for (const r of reviews.value) {
		if (
			seen.includes(r.id) ||
			r.actor.toLowerCase() === CONTROLLER_LOGIN.toLowerCase()
		) {
			events.push(r);
			continue;
		}

		const inline = await adapter.readReviewComments(
			pr,
			Number(r.id.split(":").at(-1)),
		);

		if (inline.kind === "failed")
			return {
				kind: "unavailable",
				reason: "review_comments",
				failure: inline.failure.kind,
			};
		events.push({ ...r, comments: inline.value });
	}

	return { kind: "read", events };
}

export async function observeFeedback(input: {
	stateDir: string;
	adapter: GitHubTicketAdapter;
	runId: Digest;
	pr: number;
	head: GitSha;
	prHead: string;
	refHead: string;
	seen: readonly FeedbackId[];
	held?: boolean;
}): Promise<FeedbackObservation> {
	if (input.prHead !== input.head || input.refHead !== input.head)
		return { kind: "deferred", reason: "head_mismatch" };

	let reason: "unexpected" | "storage" = "unexpected";

	try {
		if (input.held === true) {
			const reviews = await input.adapter.readPullReviews(input.pr);

			return reviews.kind !== "ok"
				? {
						kind: "unavailable",
						reason: "reviews",
						failure: reviews.failure.kind,
					}
				: {
						kind: "read",
						head: input.head,
						batch: null,
						dismissed: reviews.value
							.filter(
								(r) => r.state === "DISMISSED" && input.seen.includes(r.id),
							)
							.map((r) => r.id),
					};
		}

		const read = await feedbackEvents(input.adapter, input.pr, input.seen);

		if (read.kind === "unavailable") return read;
		let permissionFailure: GitHubFailure["kind"] | null = null;

		const classified = await classifyFeedback({
			...input,
			events: read.events,
			permission: async (actor) => {
				if (!isLogin(actor)) return "read";
				const permission = await input.adapter.readPermission(actor);

				if (permission.kind === "failed")
					permissionFailure = permission.failure.kind;

				return permission.kind === "failed"
					? "failed"
					: hasWriteAccess(permission.value)
						? "write"
						: "read";
			},
		});

		if (classified.kind === "unavailable")
			return {
				kind: "unavailable",
				reason: "permission",
				failure: permissionFailure,
			};

		reason = "storage";

		const batch =
			classified.batch === null
				? null
				: await storeFeedbackBatch(
						input.stateDir,
						classified.batch,
						classified.full,
					);

		return {
			kind: "read",
			head: input.head,
			batch,
			dismissed: classified.dismissed,
		};
	} catch {
		return { kind: "unavailable", reason, failure: null };
	}
}

type MergedFeedbackSweep = Readonly<{
	stateDir: string;
	exec: Exec;
	repo: RepoSlug;
	now: number;
	landed: readonly Readonly<{ runId: Digest; pr: number }>[];
}>;

type SubmittedFeedback = Extract<FeedbackEvent, { kind: "review" }>;

function proposalBody(
	repo: RepoSlug,
	review: SubmittedFeedback,
	key: string,
): string {
	return [
		`Feedback on merged factory PR https://github.com/${repo}/pull/${review.pr}`,
		`Review: ${inert(review.id)}`,
		inert(review.body),
		...review.comments.map((c) =>
			c.path.startsWith("test/acceptance/")
				? `Refused inline comment ${inert(c.id)} on a held-out acceptance file; text is not quoted.`
				: `${inert(c.path)}${c.line === null ? "" : `:${c.line}`}\n${inert(c.body)}`,
		),
		"This proposal needs owner review and is not ready for automatic admission.",
		key,
	].join("\n\n");
}

async function proposeMergedReview(
	input: MergedFeedbackSweep,
	adapter: GitHubTicketAdapter,
	review: SubmittedFeedback,
): Promise<boolean> {
	const key = `<!-- factory:proposal ${input.repo} ${review.id} -->`;

	const path = join(
		input.stateDir,
		"feedback-sweep",
		"proposals",
		`${review.pr}-${review.id.split(":").at(-1)}.json`,
	);

	let body = proposalBody(input.repo, review, key);

	if (present(path)) {
		const intent = objectOf(parseJson(regularText(path)));
		const savedBody = textOf(jsonField(intent, "body"));

		if (
			jsonField(intent, "key") !== key ||
			savedBody === null ||
			!savedBody.endsWith(`\n\n${key}`)
		)
			return false;
		body = savedBody;
	} else exclusive(path, JSON.stringify({ key, body }));
	const proposals = await adapter.readProposedIssues();

	if (proposals.kind !== "ok") return false;

	const matching = proposals.value.filter((p) =>
		p.body.split("\n").includes(key),
	);

	if (matching.length > 0) return matching.length === 1;

	if ((await fileAdmissionStore(input.stateDir).localSwitch()) !== "enabled")
		return false;
	const enabled = await adapter.readRepoSwitch();

	if (enabled.kind !== "ok" || enabled.value.kind !== "present") return false;
	const writer = new GitHubTicketWriter({ exec: input.exec, repo: input.repo });

	const created = await writer.createIssue(
		`Factory follow-up for PR ${review.pr}`,
		body,
		["factory:proposed"],
	);

	return created.kind === "posted";
}

async function sweepMergedPr(
	input: MergedFeedbackSweep,
	adapter: GitHubTicketAdapter,
	number: number,
): Promise<void> {
	const dir = join(input.stateDir, "feedback-sweep");
	privateDir(dir);
	const path = join(dir, `${number}.json`);
	const cursor = present(path) ? objectOf(parseJson(regularText(path))) : null;
	const last = countOf(jsonField(cursor, "at"));

	if (last !== null && input.now - last < 3_600_000) return;
	const seen = new Set(textsOf(jsonField(cursor, "seen")) ?? []);

	const save = () =>
		writeAtomic(
			path,
			JSON.stringify({ version: 1, at: input.now, seen: [...seen].sort() }),
		);

	if (!(await save())) return;
	const api = new GitHubPublicationApi(input.exec, input.repo);
	const pr = objectOf(await api.request("GET", `pulls/${number}`));
	const mergedAt = textOf(jsonField(pr, "merged_at"));

	if (mergedAt === null || !validLedgerInstant(mergedAt)) return;
	const reviews = await adapter.readPullReviews(number);

	if (reviews.kind !== "ok") return;

	for (const review of reviews.value) {
		if (
			seen.has(review.id) ||
			review.actor.toLowerCase() === CONTROLLER_LOGIN.toLowerCase() ||
			Date.parse(review.at) <= Date.parse(mergedAt) ||
			!isLogin(review.actor)
		)
			continue;
		const permission = await adapter.readPermission(review.actor);

		if (permission.kind !== "ok") return;

		if (!hasWriteAccess(permission.value)) continue;

		const comments = await adapter.readReviewComments(
			number,
			Number(review.id.split(":").at(-1)),
		);

		if (comments.kind !== "ok") return;

		if (!review.body.trim() && comments.value.length === 0) continue;

		if (
			!(await proposeMergedReview(input, adapter, {
				...review,
				comments: comments.value,
			}))
		)
			return;
		seen.add(review.id);

		if (!(await save())) return;
	}
}

export async function sweepMergedFeedback(
	input: MergedFeedbackSweep,
): Promise<void> {
	if ((await fileAdmissionStore(input.stateDir).localSwitch()) !== "enabled")
		return;

	const adapter = new GitHubTicketAdapter({
		exec: input.exec,
		repo: input.repo,
	});

	const enabled = await adapter.readRepoSwitch();

	if (enabled.kind !== "ok" || enabled.value.kind !== "present") return;

	for (const number of new Set(input.landed.map((row) => row.pr))) {
		try {
			await sweepMergedPr(input, adapter, number);
		} catch {
			continue;
		}
	}
}

/**
 * One pass of the ledger outbox for this state directory. It reads and
 * advances only `factory/ledger`, and never fails the tick that calls it.
 */
export async function pumpLedgerOutbox(input: {
	readonly stateDir: string;
	readonly exec: Exec;
	readonly repo: RepoSlug;
	readonly now: number;
	readonly log: Log;
	readonly clock?: () => number;
}): Promise<LedgerBacklog | null> {
	const clock = input.clock ?? Date.now;
	const started = clock();

	try {
		const backlog = await pumpLedger(
			fileLedgerOutbox(input.stateDir),
			ledgerApiOf(
				new GitHubPublicationApi(
					input.exec,
					input.repo,
					{},
					async () => true,
					undefined,
					{ now: clock, sliceMs: 20_000, callMs: 5_000 },
				),
			),
			input.now,
			() => input.now + clock() - started,
		);

		if (backlog.published > 0 || backlog.pending > 0 || !backlog.readable)
			input.log("ledger_backlog", {
				readable: backlog.readable,
				published: backlog.published,
				pending: backlog.pending,
				blocked: backlog.blocked,
				oldest: backlog.oldestObservedAt,
				error: backlog.lastError,
			});

		return backlog;
	} catch {
		input.log("ledger_pump_failed", {});

		return null;
	}
}

export async function systemdNotify(
	message: "READY=1" | "WATCHDOG=1",
): Promise<void> {
	if (!process.env.NOTIFY_SOCKET) return;
	await new Promise<void>((done, reject) => {
		const child = spawn("systemd-notify", [message], {
			detached: message === "WATCHDOG=1",
			stdio: "ignore",
			timeout: 1000,
			killSignal: "SIGKILL",
		});

		child.once("error", reject);
		child.once("close", (code) =>
			code === 0 ? done() : reject(new Error("notify_exit")),
		);

		if (message === "WATCHDOG=1") child.unref();
	});
}

export function startMetricSnapshots(input: {
	stateDir: string;
	collect: () => Promise<JsonValue>;
	log: Log;
	intervalMs?: number;
}) {
	let pending: Promise<void> | null = null;

	const refresh = () => {
		if (pending !== null) return;
		pending = (async () => {
			try {
				const snapshot = await input.collect();

				if (
					!(await writeAtomic(
						join(input.stateDir, "metrics.json"),
						`${JSON.stringify(snapshot)}\n`,
					))
				)
					input.log("metrics_unwritable", {});
			} catch (error) {
				const reason =
					error instanceof Error &&
					[
						"metric_deadline",
						"ledger_missing",
						"ledger_ref_unavailable",
						"ledger_commit_unavailable",
						"ledger_file_unavailable",
						"label_missing",
						"label_unreadable",
						"defect_query_failed",
						"defect_query_invalid",
						"defect_query_incomplete",
						"intervention_unreadable",
						"receipt_read_unavailable",
						"metric_compute_unavailable",
					].includes(error.message)
						? error.message
						: "collection_failed";

				input.log("metrics_unavailable", { reason });

				const previous = objectOf(
					parseJson(
						await readFile(join(input.stateDir, "metrics.json"), "utf8").catch(
							() => "null",
						),
					),
				);

				if (previous !== null)
					await writeAtomic(
						join(input.stateDir, "metrics.json"),
						`${JSON.stringify({ ...previous, stale: true, lastAttemptAt: new Date().toISOString() })}\n`,
					);
			}
		})().finally(() => {
			pending = null;
		});
	};

	refresh();
	const timer = setInterval(refresh, input.intervalMs ?? 300_000);
	timer.unref();

	return {
		stop: async () => {
			clearInterval(timer);
			await pending;
		},
	};
}

export async function serveLoop(input: {
	orchestrator: Pick<Orchestrator, "tick" | "pollIntervalMs">;
	stateDir: string;
	sleep: Sleep;
	signal: AbortSignal;
	log: Log;
	pump?: () => Promise<LedgerBacklog | null>;
	durableUsage?: () => JsonValue;
	notify?: (message: "READY=1" | "WATCHDOG=1") => Promise<void>;
}): Promise<void> {
	const { orchestrator, signal, log } = input;
	const notify = input.notify ?? systemdNotify;
	let notifyMissing = false;

	const ping = async (message: "READY=1" | "WATCHDOG=1") => {
		if (notifyMissing) return;

		try {
			await notify(message);
		} catch (error) {
			if (error instanceof Error && "code" in error && error.code === "ENOENT")
				notifyMissing = true;

			log("notify_failed", { message });
		}
	};

	await ping("READY=1");
	let watchdogPending = false;
	let scheduled: NodeJS.Immediate | null = null;

	const watchdog = () => {
		if (notifyMissing || watchdogPending) return;
		watchdogPending = true;
		scheduled = setImmediate(() => {
			scheduled = null;
			void ping("WATCHDOG=1").finally(() => {
				watchdogPending = false;
			});
		});
		scheduled.unref();
	};

	while (!signal.aborted) {
		watchdog();
		const report = await orchestrator.tick();

		const written = await writeStatus(
			input.stateDir,
			report,
			input.durableUsage?.(),
		);

		if (!written) log("status_unwritable", {});

		watchdog();

		await input.pump?.();

		if (signal.aborted) break;

		await input.sleep(orchestrator.pollIntervalMs, signal);
	}

	if (scheduled !== null) clearImmediate(scheduled);
	log("controller_stopping", {});
}
