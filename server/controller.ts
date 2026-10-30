import { execFile } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import { readFileSync } from "node:fs";
import {
	lstat,
	mkdir,
	open,
	readdir,
	readFile,
	realpath,
	rename,
	rm,
	unlink,
	writeFile,
} from "node:fs/promises";
import { createConnection, createServer, type Server } from "node:net";
import { dirname, join, resolve } from "node:path";
import { gunzipSync } from "node:zlib";
import { isRunStatus, isStage } from "../src/markers.ts";
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
} from "../src/orchestrator.ts";
import {
	type Answer,
	type AnswersRecord,
	type ClarificationRound,
	answersDigestOf,
	hasControl,
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

	const claim: ClaimRecord = {
		runId: id,
		issue: Number(issue),
		eventId: String(eventId),
		seq,
		...state,
		usage,
	};

	return labelFailures === null ? claim : { ...claim, labelFailures };
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

export type TarballFetch = (
	repo: RepoSlug,
	sha: GitSha,
) => Promise<
	Buffer | { readonly kind: "refused"; readonly reason: string } | null
>;

const TARBALL_MAX_BYTES = 64 * 1024 * 1024;

const TARBALL_TIMEOUT_MS = 120_000;

export const ghTarball: TarballFetch = (repo, sha) =>
	new Promise((done) => {
		execFile(
			"gh",
			["api", `repos/${repo}/tarball/${sha}`],
			{
				encoding: "buffer",
				maxBuffer: TARBALL_MAX_BYTES,
				timeout: TARBALL_TIMEOUT_MS,
				killSignal: "SIGKILL",
			},
			(error, stdout) =>
				done(
					error === null
						? stdout
						: error.code === "ERR_CHILD_PROCESS_STDIO_MAXBUFFER"
							? { kind: "refused", reason: "too_large" }
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
	| { readonly kind: "ok"; readonly entries: readonly TarEntry[] }
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

function isCheckoutPath(path: string): boolean {
	return (
		path.length <= 4096 &&
		!hasControl(path) &&
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
		hasControl(raw)
	) {
		return null;
	}

	top.name ??= first;

	if (first !== top.name) return null;

	if (rest.length === 0) return "";

	const path = rest.join("/");

	return isCheckoutPath(path) ? path : null;
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

	while (at + BLOCK <= tar.length) {
		const header = tar.subarray(at, at + BLOCK);

		if (header.every((byte) => byte === 0)) return { kind: "ok", entries };

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
			if (target === "" || hasControl(target)) return refuse("unsafe_symlink");
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
): string[] | null {
	const value = text === null ? undefined : parseJson(text);
	const files = fieldOf(value, "files");

	if (fieldOf(value, "sha") !== sha || !Array.isArray(files)) return null;

	const paths: string[] = [];

	for (const file of files) {
		const path = String(file);

		if (file !== path || !isCheckoutPath(path)) return null;

		paths.push(path);
	}

	return paths;
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
export async function checkoutWorkspace(input: {
	readonly stateDir: string;
	readonly runId: Digest;
	readonly workspace: string;
	readonly repo: RepoSlug;
	readonly sha: GitSha;
	readonly fetch: TarballFetch;
}): Promise<CheckoutResult> {
	const { runId, workspace, repo, sha } = input;
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
		return { kind: "ready", checkout: checkoutOf(workspace, listed) };

	const gz = await input.fetch(repo, sha).catch(() => null);

	if (gz === null) return { kind: "unavailable" };

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

	const text = `${JSON.stringify({ sha, files })}\n`;

	if (
		Buffer.byteLength(text) > CHECKOUT_LIST_MAX_BYTES ||
		!(await writeAtomic(record, text))
	) {
		return { kind: "unavailable" };
	}

	return { kind: "ready", checkout: checkoutOf(workspace, files) };
}

async function writeOnce(path: string, text: string): Promise<boolean> {
	const existing = await readFile(path, "utf8").catch(() => null);

	if (existing !== null) return existing === text;

	try {
		await mkdir(dirname(path), { recursive: true, mode: 0o700 });
	} catch {
		return false;
	}

	return writeAtomic(path, text);
}

export function fileRunFiles(stateDir: string): RunFiles {
	const root = resolve(stateDir);
	const claims = join(root, "claims");
	const workspaces = join(root, "workspaces");
	const contracts = join(root, "contracts");
	const links = join(root, "links");
	const answers = join(root, "answers");

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
					`${JSON.stringify({ version: 1, ...link })}\n`,
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

/** Writes the last tick's report for `status --json`. */
export async function writeStatus(
	stateDir: string,
	report: TickReport,
): Promise<boolean> {
	return writeAtomic(
		join(resolve(stateDir), STATUS_FILE),
		`${JSON.stringify(report, null, 2)}\n`,
	);
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

/**
 * Runs ticks until `signal` aborts. A stop request lets the current tick
 * finish, so the caller releases the lock only between ticks.
 */
export async function serveLoop(input: {
	orchestrator: Orchestrator;
	stateDir: string;
	sleep: Sleep;
	signal: AbortSignal;
	log: Log;
}): Promise<void> {
	const { orchestrator, signal, log } = input;

	while (!signal.aborted) {
		const report = await orchestrator.tick();

		if (!(await writeStatus(input.stateDir, report))) {
			log("status_unwritable", {});
		}

		if (signal.aborted) break;

		await input.sleep(orchestrator.pollIntervalMs, signal);
	}

	log("controller_stopping", {});
}
