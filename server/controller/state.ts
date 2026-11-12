import {
	regularText,
	exclusive,
	present,
} from "../../src/contract/artifacts.ts";
import {
	type PlatformProfile,
	platformSummary,
} from "../../src/trust/platform.ts";
import { parseCandidateState } from "../../src/candidate/codec.ts";
import { candidateUsage } from "../../src/candidate/handoff.ts";
import {
	parseValidationState,
	assessmentBinding,
	assessmentBytes,
	readAssessmentBytes,
	type ReadAssessment,
	type ValidationAssessment,
} from "../../src/candidate/validation.ts";
import {
	arrayOf,
	objectOf,
	fieldOf as jsonField,
	parseJson as parseJsonText,
	textOf,
	countOf,
	type JsonValue,
} from "../../src/core/json.ts";
import {
	digestOf,
	type Verdict,
	type Digest,
	isDigest,
} from "../../src/core/run.ts";
import { isStage } from "../../src/core/stages.ts";
import {
	parseAttemptEnd,
	parseRunStart,
	type AttemptEnd,
} from "../../src/ledger/schema.ts";
import type { RunAccounting } from "../../src/ledger/terminal.ts";
import { isRepoSlug, type RepoSlug } from "../../src/trust/platform.ts";
import { randomBytes, createHash } from "node:crypto";
import { parseBaseCheckReference } from "../../src/candidate/diagnosis.ts";
import {
	mkdir,
	open,
	readdir,
	readFile,
	realpath,
	rename,
	unlink,
} from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import {
	isRunStatus,
	parseMarker,
	MARKER_PREFIX,
} from "../../src/trust/markers.ts";
import { type ClaimRecord, type TickReport } from "../../src/orchestrator.ts";
import { createConnection } from "node:net";

export async function readStatus(stateDir: string): Promise<JsonValue | null> {
	const text = await readFile(
		join(resolve(stateDir), STATUS_FILE),
		"utf8",
	).catch(() => null);

	return text === null ? null : (parseJsonText(text) ?? null);
}

export function readStoredVerdict(path: string): Verdict {
	try {
		// SAFETY: controller-private write-once verdict; callers verify artifact bindings before reuse.
		return JSON.parse(regularText(path, 1024 * 1024)) as Verdict;
	} catch {
		throw new Error("stored_verdict_invalid");
	}
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

export function holderOf(file: HolderFile): LockHolder | null {
	return file.kind === "holder" ? file.holder : null;
}

export async function readHolderFile(path: string): Promise<HolderFile> {
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

export type HolderFile =
	| { readonly kind: "absent" }
	| { readonly kind: "holder"; readonly holder: LockHolder }
	| { readonly kind: "unreadable" };

function parseHolder(text: string): LockHolder | null {
	const value = objectOf(parseJsonText(text));
	const pid = jsonField(value, "pid");
	const startTime = jsonField(value, "startTime");
	const acquiredAt = jsonField(value, "acquiredAt");

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

export function errorCode(error: Error): string | null {
	return "code" in error && error.code === String(error.code)
		? error.code
		: null;
}

/**
 * The Linux abstract Unix socket name for one state directory: a NUL byte,
 * then `pi-herdr-factorio/` and the SHA-256 of the directory's real path. The
 * kernel lets one socket bind a name and frees it when the process dies.
 */
export function lockName(realDir: string): string {
	return `\0pi-herdr-factorio/${createHash("sha256").update(realDir).digest("hex")}`;
}

export type SocketLockState =
	| { readonly kind: "none" }
	| { readonly kind: "socket_bound"; readonly holderFile: LockHolder | null }
	| {
			readonly kind: "holder_file_without_socket";
			readonly holderFile: LockHolder;
	  }
	| { readonly kind: "unreadable" };

export type LockHolder = {
	readonly pid: number;
	readonly startTime: string;
	readonly acquiredAt: string;
};

export const STATUS_FILE = "status.json";

export const HOLDER_FILE = "controller.lock";

export function parseJson(text: string): JsonValue | undefined {
	try {
		const parsed: JsonValue = JSON.parse(text);

		return parsed;
	} catch {
		return undefined;
	}
}

export function fieldOf(value: JsonValue | undefined, key: string) {
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

export function parseClaim(text: string): ClaimRecord | null {
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

export async function writeAtomic(
	path: string,
	text: string,
): Promise<boolean> {
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

export async function writeOnce(
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

export async function installOnce(
	path: string,
	text: string,
): Promise<boolean> {
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

export async function readVerificationContext(stateDir: string) {
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
 * Writes the last tick's report, the controller's startup platform and
 * cached local usage for `status --json`.
 */
export async function writeStatus(
	stateDir: string,
	report: TickReport,
	platform: PlatformProfile,
	durableUsage: JsonValue = {
		kind: "unavailable",
		reason: "legacy_not_recorded",
	},
): Promise<boolean> {
	return writeAtomic(
		join(resolve(stateDir), STATUS_FILE),
		`${JSON.stringify({ ...report, platform: platformSummary(platform), durableUsage }, null, 2)}\n`,
	);
}

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

export function storeAssessment(
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

export function textList(value: JsonValue | undefined): string | null {
	const text = String(value);

	return value === text ? text : null;
}

export function keepValidationFile(path: string, text: string): void {
	if (present(path)) {
		if (regularText(path, 1024 * 1024) !== text)
			throw new Error("validation_changed");
	} else exclusive(path, text);
}
