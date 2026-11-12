import { countOf } from "../../src/core/json.ts";
import { execFile } from "node:child_process";
import {
	cp,
	lstat,
	mkdir,
	readdir,
	readFile,
	realpath,
	rm,
	writeFile,
} from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { gunzipSync } from "node:zlib";
import { type Digest } from "../../src/core/run.ts";
import {
	type Checkout,
	type CheckoutResult,
	type Log,
} from "../../src/orchestrator.ts";
import { hasControl } from "../../src/contract/parse.ts";
import type { GitSha } from "../../src/config/schema.ts";
import type { RepoSlug } from "../../src/trust/platform.ts";
import { parseJson, fieldOf, writeAtomic, textList } from "./state.ts";

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

export function checkoutOf(
	workspace: string,
	files: readonly string[],
): Checkout {
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
export async function checkoutTree(
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
