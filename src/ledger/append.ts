import { digestOf, type Digest } from "../core/run.ts";
import { PublicationError } from "../github/publish.ts";
import type { GitSha } from "../config/schema.ts";
import type { JsonValue } from "../core/json.ts";
import {
	LEDGER_FILE,
	type LedgerApi,
	type LedgerCommit,
	type LedgerFile,
} from "./git.ts";
import {
	LedgerRowError,
	count,
	digest,
	indexLedger,
	literal,
	nullable,
	parseLedger,
	record,
	sha,
	type LedgerErrorCode,
	type LedgerIndex,
	type Out,
} from "./schema.ts";

const anchorCodec = record({
	v: literal(1),
	rootSha: sha,
	tipSha: sha,
	blobSha: sha,
	byteLength: count,
	prefixDigest: digest,
});

export type LedgerAnchor = Out<typeof anchorCodec>;

export function parseAnchor(value: JsonValue | undefined): LedgerAnchor | null {
	try {
		return anchorCodec(value);
	} catch (error) {
		if (error instanceof LedgerRowError) return null;
		throw error;
	}
}

export type PendingRow = {
	readonly runId: Digest;
	readonly bytes: Buffer;
	readonly digest: Digest;
	readonly date: string;
};

export type AppendResult =
	| {
			readonly kind: "published";
			readonly tip: GitSha;
			readonly blob: GitSha;
			readonly line: number;
			readonly anchor: LedgerAnchor;
	  }
	| {
			readonly kind: "deferred" | "blocked";
			readonly reason: LedgerErrorCode;
			readonly anchor: LedgerAnchor | null;
	  };

const MAX_WALK = 10_000;

type Seen =
	| {
			readonly kind: "seen";
			readonly head: LedgerCommit;
			readonly file: LedgerFile;
			readonly anchor: LedgerAnchor;
	  }
	| { readonly kind: "blocked"; readonly reason: LedgerErrorCode };

const changed: Seen = { kind: "blocked", reason: "lineage_changed" };

export type AdoptionCursor = {
	readonly base: GitSha | null;
	readonly tip: GitSha;
	readonly cursor: GitSha;
	readonly walked: number;
};

export function parseAdoption(
	value: JsonValue | undefined,
): AdoptionCursor | null {
	try {
		return record({
			base: nullable(sha),
			tip: sha,
			cursor: sha,
			walked: count,
		})(value);
	} catch (error) {
		if (error instanceof LedgerRowError) return null;
		throw error;
	}
}

type Adoption = {
	readonly cursor: AdoptionCursor | null;
	save(cursor: AdoptionCursor): Promise<boolean>;
};

async function verifyTip(
	api: LedgerApi,
	tip: GitSha,
	anchor: LedgerAnchor | null,
	adoption?: Adoption,
): Promise<Seen> {
	const head = await api.commit(tip);

	const saved =
		adoption?.cursor?.tip === tip &&
		adoption.cursor.base === (anchor?.tipSha ?? null)
			? adoption.cursor
			: null;

	let cursor =
		saved === null || saved.cursor === tip
			? head
			: await api.commit(saved.cursor);

	for (let walked = 0; ; walked++) {
		if (walked + (saved?.walked ?? 0) > MAX_WALK) return changed;

		if (adoption !== undefined && walked >= 16)
			return { kind: "blocked", reason: "adoption_pending" };

		if (anchor !== null && cursor.sha === anchor.tipSha) break;
		const [parent, ...others] = cursor.parents;

		if (parent === undefined) {
			if (anchor !== null) return changed;
			const root = await api.file(cursor.tree);

			if (
				root.bytes.length !== 0 ||
				JSON.stringify(root.paths) !== JSON.stringify(["ledger", LEDGER_FILE])
			)
				return changed;
			break;
		}

		if (others.length > 0) return changed;

		if (
			adoption !== undefined &&
			!(await adoption.save({
				base: anchor?.tipSha ?? null,
				tip,
				cursor: parent,
				walked: walked + 1 + (saved?.walked ?? 0),
			}))
		)
			throw new PublicationError("claim_unwritable");
		cursor = await api.commit(parent);
	}

	const file = await api.file(head.tree);

	if (
		anchor !== null &&
		(file.bytes.length < anchor.byteLength ||
			digestOf(file.bytes.subarray(0, anchor.byteLength)) !==
				anchor.prefixDigest)
	)
		return changed;

	return {
		kind: "seen",
		head,
		file,
		anchor: {
			v: 1,
			rootSha: anchor?.rootSha ?? cursor.sha,
			tipSha: tip,
			blobSha: file.blob,
			byteLength: file.bytes.length,
			prefixDigest: digestOf(file.bytes),
		},
	};
}

const INTEGRITY = new Set([
	"object_missing",
	"object_mismatch",
	"blob_mismatch",
	"commit_mismatch",
	"tree_truncated",
	"malformed_tree",
	"malformed_blob",
	"malformed_commit",
	"malformed_ref",
	"malformed_response",
	"ledger_file_missing",
]);

/**
 * Appends one frozen row to `ledger/runs.jsonl` on `factory/ledger`, or
 * proves it is already there. Never forces, deletes or rewrites a byte.
 */
export async function appendRun(
	api: LedgerApi,
	row: PendingRow,
	anchor: LedgerAnchor | null,
	rounds = 3,
	adoption?: Adoption,
	allowRoot = true,
	indexBytes: (bytes: Uint8Array) => LedgerIndex = (bytes) =>
		indexLedger(parseLedger(bytes)),
): Promise<AppendResult> {
	let current = anchor;

	try {
		for (let round = 0; round <= rounds + 1; round++) {
			const tip = await api.ref();

			if (tip === null) {
				if (current !== null || !allowRoot)
					return { kind: "blocked", reason: "ref_missing", anchor: current };
				const root = await api.root(row.date);
				await api.advance(null, root.sha);
				continue;
			}

			const seen = await verifyTip(api, tip, current, adoption);

			if (seen.kind === "blocked")
				return {
					kind: seen.reason === "adoption_pending" ? "deferred" : "blocked",
					reason: seen.reason,
					anchor: current,
				};
			const index = indexBytes(seen.file.bytes);

			if (index.kind === "blocked")
				return { kind: "blocked", reason: index.reason, anchor: current };
			current = seen.anchor;
			const hit = index.rows.get(row.runId);

			if (hit !== undefined)
				return hit.digest === row.digest
					? {
							kind: "published",
							tip,
							blob: seen.file.blob,
							line: hit.line,
							anchor: current,
						}
					: { kind: "blocked", reason: "row_conflict", anchor: current };

			if (round > rounds) break;

			const bytes = Buffer.concat([seen.file.bytes, row.bytes]);
			const nextIndex = indexBytes(bytes);

			if (nextIndex.kind === "blocked")
				return { kind: "blocked", reason: nextIndex.reason, anchor: current };

			const child = await api.child(
				seen.head,
				bytes,
				row.date,
				`factory: ledger row ${row.runId}\n\nFactory-Run: ${row.runId}\nFactory-Row: ${row.digest}\n`,
			);

			await api.advance(tip, child.sha);
		}
	} catch (error) {
		if (!(error instanceof PublicationError)) throw error;

		if (error.reason === "claim_unwritable")
			return { kind: "deferred", reason: "state_unwritable", anchor: current };

		if (INTEGRITY.has(error.reason))
			return { kind: "blocked", reason: "object_mismatch", anchor: current };

		return {
			kind: "deferred",
			reason: "transport_unavailable",
			anchor: current,
		};
	}

	return { kind: "deferred", reason: "ledger_contended", anchor: current };
}
