import type { Digest } from "../core/run.ts";
import type { GitSha } from "../workflow.ts";
import type { JsonValue } from "../core/json.ts";
import type { LedgerApi } from "./git.ts";
import {
	appendRun,
	type AdoptionCursor,
	type AppendResult,
	type LedgerAnchor,
} from "./append.ts";
import {
	LedgerRowError,
	count,
	flag,
	oneOf,
	positive,
	record,
	type FrozenRow,
	type LedgerErrorCode,
} from "./schema.ts";

export type MarkerProof = { readonly seq: number; readonly digest: Digest };

export type LedgerRetry = {
	readonly attempts: number;
	readonly nextAt: number;
	readonly reason: LedgerErrorCode;
	readonly blocked: boolean;
};

export type OutboxJob = {
	readonly runId: Digest;
	readonly observedAt: string;
	readonly row: FrozenRow | null;
	readonly retry: LedgerRetry | null;
	readonly adoption?: AdoptionCursor | null;
};

export type PublishedReceipt = {
	readonly v: 1;
	readonly runId: Digest;
	readonly rowDigest: Digest;
	readonly observedTip: GitSha;
	readonly blobSha: GitSha;
	readonly lineNumber: number;
};

/** The controller-private record of terminal runs and their ledger rows. */
export interface LedgerOutbox {
	/** Keeps the first snapshot for a run; a later one never replaces it. */
	prepare(runId: Digest, snapshot: JsonValue): Promise<boolean>;
	/** Records, once, that a run's terminal snapshot cannot be encoded, so it shows as blocked. */
	block(runId: Digest, observedAt: string): Promise<boolean>;
	freeze(
		runId: Digest,
		marker: MarkerProof,
	): Promise<"frozen" | "absent" | "invalid" | "unwritable">;
	/** Unpublished jobs, or `null` when the outbox cannot be listed; a corrupt job blocks alone. */
	scan(): Promise<readonly OutboxJob[] | null>;
	/**
	 * The verified anchor; `null` only when neither an anchor nor a receipt
	 * exists, `orphaned` when receipts exist without one, `invalid` when it
	 * cannot be read or parsed.
	 */
	anchor(): Promise<LedgerAnchor | null | "orphaned" | "invalid">;
	adoption(runId: Digest, cursor: AdoptionCursor): Promise<boolean>;
	published(receipt: PublishedReceipt, anchor: LedgerAnchor): Promise<boolean>;
	retry(runId: Digest, retry: LedgerRetry): Promise<boolean>;
}

export type LedgerBacklog = {
	readonly readable: boolean;
	readonly pending: number;
	readonly blocked: number;
	readonly published: number;
	readonly oldestObservedAt: string | null;
	readonly lastError: LedgerErrorCode | null;
};

const BACKOFF_MS = 5_000;
const BACKOFF_MAX_MS = 300_000;

/** One bounded pass over the outbox. It calls no model and launches no stage. */
export async function pumpLedger(
	outbox: LedgerOutbox,
	api: LedgerApi,
	now: number,
	clock: () => number = () => now,
): Promise<LedgerBacklog> {
	const jobs = await outbox.scan();

	if (jobs === null)
		return {
			readable: false,
			pending: 0,
			blocked: 0,
			published: 0,
			oldestObservedAt: null,
			lastError: "state_unwritable",
		};

	const ordered = [...jobs].sort((a, b) =>
		a.observedAt === b.observedAt
			? a.runId.localeCompare(b.runId)
			: a.observedAt.localeCompare(b.observedAt),
	);

	const stored = await outbox.anchor();
	let anchor = stored === "orphaned" || stored === "invalid" ? null : stored;
	let published = 0;
	let blocked = 0;
	let lastError: LedgerErrorCode | null = null;
	const waiting: string[] = [];

	for (const job of ordered) {
		if (job.row === null || (job.retry !== null && job.retry.nextAt > now)) {
			if (job.retry?.blocked === true) blocked += 1;
			lastError = job.retry?.reason ?? lastError;
			waiting.push(job.observedAt);
			continue;
		}

		let result: AppendResult;

		if (stored === "invalid")
			result = { kind: "blocked", reason: "state_invalid", anchor: null };
		else {
			api.startJob?.();
			result = await appendRun(
				api,
				{
					runId: job.runId,
					bytes: job.row.bytes,
					digest: job.row.digest,
					date: job.observedAt.replace(/\.\d{3}Z$/, "Z"),
				},
				anchor,
				3,
				{
					cursor: job.adoption ?? null,
					save: (cursor) => outbox.adoption(job.runId, cursor),
				},
				stored === null,
			);
		}

		if (result.kind === "published") {
			const receipt: PublishedReceipt = {
				v: 1,
				runId: job.runId,
				rowDigest: job.row.digest,
				observedTip: result.tip,
				blobSha: result.blob,
				lineNumber: result.line,
			};

			if (await outbox.published(receipt, result.anchor)) {
				anchor = result.anchor;
				published += 1;
				continue;
			}

			lastError = "state_unwritable";
		} else lastError = result.reason;
		const attempts = (job.retry?.attempts ?? 0) + 1;

		await outbox.retry(job.runId, {
			attempts,
			nextAt:
				clock() + Math.min(BACKOFF_MAX_MS, BACKOFF_MS * 2 ** (attempts - 1)),
			reason: lastError,
			blocked: result.kind === "blocked",
		});

		if (result.kind === "blocked") blocked += 1;
		waiting.push(job.observedAt);
	}

	return {
		readable: true,
		pending: waiting.length,
		blocked,
		published,
		oldestObservedAt: waiting.sort()[0] ?? null,
		lastError,
	};
}

const retryCodec = record({
	attempts: positive,
	nextAt: count,
	reason: oneOf(
		"state_unwritable",
		"transport_unavailable",
		"row_conflict",
		"ledger_corrupt",
		"ledger_version_unsupported",
		"ledger_contended",
		"lineage_changed",
		"ref_missing",
		"object_mismatch",
		"adoption_pending",
		"state_invalid",
		"row_invalid",
	),
	blocked: flag,
});

export function parseRetry(value: JsonValue | undefined): LedgerRetry | null {
	try {
		return retryCodec(value);
	} catch (error) {
		if (error instanceof LedgerRowError) return null;
		throw error;
	}
}
