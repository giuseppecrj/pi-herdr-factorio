import { digestOf, isDigest, runIdOf, type Digest } from "./run.ts";
import {
	GitHubPublicationApi,
	LEDGER_FILE,
	PublicationError,
	createLedgerChild,
	createLedgerRoot,
	readLedgerCommit,
	readLedgerFile,
	type LedgerAdvance,
	type LedgerCommit,
	type LedgerFile,
} from "./publication.ts";
import { candidateGenerations, type CandidateState } from "./handoff.ts";
import type { TerminalStatus } from "./markers.ts";
import type { Stage } from "./run.ts";
import {
	isGitSha,
	isRepoSlug,
	type GitSha,
	type RepoSlug,
} from "./workflow.ts";
import {
	arrayOf,
	countOf,
	fieldOf,
	hasDuplicateKey,
	objectOf,
	parseJson,
	textOf,
	type JsonValue,
} from "../server/sandbox/json.ts";

export class LedgerRowError extends Error {
	readonly code: string;
	constructor(code: string) {
		super(code);
		this.code = code;
	}
}

const fail = (code: string): never => {
	throw new LedgerRowError(code);
};

type Codec<T> = (value: JsonValue | undefined) => T;

type Out<C> = C extends Codec<infer T> ? T : never;

type Fields = Readonly<Record<string, Codec<JsonValue>>>;

type Decoded<F extends Fields> = { readonly [K in keyof F]: Out<F[K]> };

type JsonRecord = { [key: string]: JsonValue };

function record<F extends Fields>(fields: F): Codec<Decoded<F>> {
	const keys = Object.keys(fields);

	return (value) => {
		const input = objectOf(value) ?? fail("invalid_object");
		const present = Object.keys(input);

		if (
			present.length !== keys.length ||
			present.some((key) => !keys.includes(key))
		)
			fail("unexpected_keys");
		const output: JsonRecord = {};

		for (const key of keys) {
			const codec = fields[key];

			if (codec === undefined || !Object.hasOwn(input, key))
				return fail("missing_key");
			output[key] = codec(input[key]);
		}

		// SAFETY: every key of `fields` was decoded by its own codec, in order.
		return output as Decoded<F>;
	};
}

type Variants = Readonly<Record<string, Fields>>;

type Tagged<V extends Variants> = {
	[K in keyof V & string]: { readonly kind: K } & Decoded<V[K]>;
}[keyof V & string];

function tagged<V extends Variants>(variants: V): Codec<Tagged<V>> {
	const codecs = new Map<string, Codec<JsonValue>>();

	for (const [kind, fields] of Object.entries(variants))
		codecs.set(kind, record({ kind: literal(kind), ...fields }));

	return (value) => {
		const kind = textOf(fieldOf(objectOf(value), "kind"));
		const codec = kind === null ? undefined : codecs.get(kind);

		if (codec === undefined) return fail("invalid_kind");

		// SAFETY: the variant codec checked `kind` and every field of that variant.
		return codec(value) as Tagged<V>;
	};
}

function literal<T extends string | number>(expected: T): Codec<T> {
	return (value) => (value === expected ? expected : fail("invalid_literal"));
}

function oneOf<T extends string | number>(...values: readonly T[]): Codec<T> {
	return (value) =>
		values.find((item) => item === value) ?? fail("invalid_enum");
}

function text<T extends string>(
	test: (input: string) => input is T,
	code: string,
): Codec<T> {
	return (value) => {
		const input = textOf(value);

		return input !== null && test(input) ? input : fail(code);
	};
}

function nullable<T extends JsonValue>(codec: Codec<T>): Codec<T | null> {
	return (value) => (value === null ? null : codec(value));
}

function list<T extends JsonValue>(codec: Codec<T>, min = 0): Codec<T[]> {
	return (value) => {
		const items = arrayOf(value) ?? fail("invalid_list");

		if (items.length < min) fail("list_too_short");

		return items.map((item) => codec(item));
	};
}

const count: Codec<number> = (value) => countOf(value) ?? fail("invalid_count");

const positive: Codec<number> = (value) => {
	const number = countOf(value);

	return number !== null && number > 0 ? number : fail("invalid_count");
};

const flag: Codec<boolean> = (value) =>
	value === true || value === false ? value : fail("invalid_bool");

const INSTANT = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{3})?Z$/;

function isInstant(input: string): input is string {
	if (!INSTANT.test(input)) return false;
	const time = Date.parse(input);

	if (!Number.isFinite(time)) return false;
	const iso = new Date(time).toISOString();

	return iso === input || iso === input.replace("Z", ".000Z");
}

const VERSION = /^[0-9A-Za-z][0-9A-Za-z.+_-]{0,63}$/;
const MODEL_ID = /^([a-z0-9][a-z0-9-]*)\/([A-Za-z0-9][A-Za-z0-9._:-]*)$/;
const EVENT_ID = /^[1-9][0-9]{0,19}$/;
const URL_TEXT = /^https:\/\/github\.com\/[A-Za-z0-9_./-]+$/;

const digest = text(isDigest, "invalid_digest");
const sha = text(isGitSha, "invalid_sha");
const instant = text(isInstant, "invalid_instant");
const repoSlug = text(isRepoSlug, "invalid_repo");

const pattern = (expression: RegExp, code: string) =>
	text((input: string): input is string => expression.test(input), code);

const version = pattern(VERSION, "invalid_version");
const modelId = pattern(MODEL_ID, "invalid_model");
const eventId = pattern(EVENT_ID, "invalid_event");
const url = pattern(URL_TEXT, "invalid_url");

export const GAP_CODES = [
	"legacy_not_recorded",
	"receipt_missing",
	"receipt_invalid",
	"request_unsettled",
	"provider_not_reported",
	"public_metadata_unavailable",
	"not_instrumented",
] as const;

export type GapCode = (typeof GAP_CODES)[number];

const gap = oneOf(...GAP_CODES);

function fact<T extends JsonValue>(codec: Codec<T>) {
	return tagged({ known: { value: codec }, unavailable: { reason: gap } });
}

function measured<U extends "tokens" | "milliseconds">(unit: U) {
	return tagged({
		exact: { unit: literal(unit), total: count },
		lower_bound: { unit: literal(unit), total: count, reason: gap },
	});
}

const tokens = measured("tokens");
const milliseconds = measured("milliseconds");

const STAGES = [
	"admit",
	"specify",
	"accept",
	"build",
	"validate",
	"review",
	"land",
] as const;

const stage = oneOf(...STAGES);

const money = tagged({
	known: { currency: literal("USD"), micros: count },
	unavailable: { reason: oneOf("provider_not_reported", "receipt_missing") },
});

const policy = record({
	workflowSha: sha,
	workflowDigest: digest,
	gates: fact(record({ sourceSha: sha, digest })),
	autonomy: record({
		approveMerge: literal("always"),
		land: literal("propose"),
		digest,
	}),
});

const provenance = tagged({
	production: { policy },
	verification: {
		policy,
		verificationDigest: digest,
		trustedRunTokenCap: positive,
		effectiveRunTokenCap: positive,
	},
	legacy_import: {
		workflowSha: sha,
		workflowDigest: digest,
		gates: fact(record({ sourceSha: sha, digest })),
		autonomy: fact(
			record({
				approveMerge: literal("always"),
				land: literal("propose"),
				digest,
			}),
		),
	},
});

const outcome = tagged({
	needs_info: { stage },
	released: { stage },
	cancelled: { stage, reason: fact(oneOf("closed", "withdrawn")) },
	failed: {
		stage,
		cause: fact(
			oneOf(
				"attempts_exhausted",
				"input_refused",
				"base_refused",
				"candidate_failed",
				"evidence_missing",
				"label_write_failed",
				"provider_refused",
			),
		),
	},
	budget_exhausted: {
		stage,
		cap: fact(oneOf("run_tokens", "stage_tokens", "wall", "turns")),
	},
	stage_passed: { stage },
	landed: {
		stage: literal("land"),
		headSha: sha,
		mergeSha: sha,
		mergedAt: fact(instant),
		assurance: tagged({
			factory_verified: { generationDigest: digest },
			owner_override: {},
		}),
	},
});

const generation = record({
	round: oneOf(0, 1, 2),
	generation: oneOf(0, 1, 2, 3),
	intentDigest: digest,
	baseSha: sha,
	patchDigest: digest,
	heldoutDigest: fact(digest),
	candidateSha: fact(sha),
	gateSha: fact(sha),
	gatesDigest: fact(digest),
	ciRunId: fact(positive),
});

const artifacts = tagged({
	admission: {},
	contract: { contractDigest: digest },
	acceptance: { contractDigest: digest, acceptanceDigest: digest },
	built: {
		contractDigest: digest,
		acceptanceDigest: digest,
		patchDigest: digest,
	},
	candidate: {
		contractDigest: digest,
		acceptanceDigest: digest,
		generations: list(generation, 1),
	},
	legacy_incomplete: {
		contractDigest: fact(digest),
		acceptanceDigest: fact(digest),
	},
});

const attempts = record({
	passed: count,
	failed: count,
	interrupted: count,
	refused: count,
	budgetExhausted: count,
	aborted: count,
});

const stageSummary = record({
	stage,
	wallMs: milliseconds,
	attempts: fact(attempts),
	tokens,
});

const modelSummary = record({
	requested: modelId,
	observed: fact(modelId),
	providerVersion: record({
		kind: literal("unavailable"),
		reason: literal("provider_not_reported"),
	}),
	runtime: fact(
		record({
			pi: version,
			agents: version,
			pstack: version,
			assetsDigest: digest,
		}),
	),
	executions: count,
});

const rowFields = {
	v: literal(1),
	runId: digest,
	repo: repoSlug,
	issue: positive,
	eventId,
	eventAt: instant,
	previousRunId: fact(nullable(digest)),
	snapshotDigest: digest,
	originalBase: sha,
	startedAt: fact(instant),
	terminalObservedAt: instant,
	provenance,
	terminalMarker: record({ seq: positive, digest }),
	outcome,
	pr: nullable(record({ number: positive, url })),
	artifacts,
	repairRounds: fact(
		record({ authorized: count, started: count, completed: count }),
	),
	stages: fact(list(stageSummary)),
	models: fact(list(modelSummary)),
	usage: record({
		tokens,
		parentTokens: fact(count),
		childTokens: fact(count),
		unattributedTokens: fact(count),
		money,
	}),
	interruptedAttempts: fact(count),
	contextPressure: fact(record({ truncated: flag, promptCapHit: flag })),
	redactedReceiptDigests: list(digest),
	evidence: record({ issueUrl: url, ciUrls: list(url) }),
	gaps: list(gap),
};

const rowCodec = record(rowFields);

export type LedgerRow = Out<typeof rowCodec>;

export type LedgerRowInput = Omit<LedgerRow, "gaps">;

export type LedgerOutcome = LedgerRow["outcome"];

function gapsOf(value: JsonValue, into: Set<GapCode>): Set<GapCode> {
	const items = arrayOf(value);

	if (items !== null) {
		for (const item of items) gapsOf(item, into);

		return into;
	}

	const object = objectOf(value);

	if (object === null) return into;
	const kind = textOf(fieldOf(object, "kind"));
	const reason = GAP_CODES.find((code) => code === fieldOf(object, "reason"));

	if (
		(kind === "unavailable" || kind === "lower_bound") &&
		reason !== undefined
	)
		into.add(reason);

	for (const [key, item] of Object.entries(object))
		if (key !== "gaps") gapsOf(item, into);

	return into;
}

const sorted = (items: readonly string[]) =>
	items.every((item, at) => at === 0 || (items[at - 1] ?? "") < item);

function invariant(row: LedgerRow): string | null {
	const base = `https://github.com/${row.repo}`;

	if (row.runId !== runIdOf(row)) return "run_id_mismatch";

	if (row.evidence.issueUrl !== `${base}/issues/${row.issue}`)
		return "issue_url_mismatch";

	if (row.pr !== null && row.pr.url !== `${base}/pull/${row.pr.number}`)
		return "pr_url_mismatch";

	if (
		!row.evidence.ciUrls.every((ci) =>
			/^\/actions\/runs\/[1-9][0-9]*$/.test(ci.slice(base.length)),
		) ||
		!row.evidence.ciUrls.every((ci) => ci.startsWith(`${base}/`)) ||
		!sorted(row.evidence.ciUrls)
	)
		return "ci_url_invalid";

	if (row.outcome.kind === "landed") {
		if (row.pr === null || row.artifacts.kind !== "candidate")
			return "landing_incomplete";
		const assurance = row.outcome.assurance;
		const head = row.outcome.headSha;

		if (
			assurance.kind === "factory_verified" &&
			!row.artifacts.generations.some(
				(item) =>
					item.intentDigest === assurance.generationDigest &&
					item.candidateSha.kind === "known" &&
					item.candidateSha.value === head,
			)
		)
			return "landing_unverified";
	}

	if (
		row.provenance.kind === "verification" &&
		row.provenance.effectiveRunTokenCap > row.provenance.trustedRunTokenCap
	)
		return "verification_cap_raised";
	const stages = row.stages.kind === "known" ? row.stages.value : [];
	const order = stages.map((item) => STAGES.indexOf(item.stage));

	if (!order.every((at, index) => index === 0 || (order[index - 1] ?? 0) < at))
		return "stages_unordered";

	const interrupted = stages.map((item) =>
		item.attempts.kind === "known" ? item.attempts.value.interrupted : null,
	);

	if (
		row.interruptedAttempts.kind === "known" &&
		row.stages.kind === "known" &&
		interrupted.every((item) => item !== null) &&
		interrupted.reduce((sum, item) => sum + item, 0) !==
			row.interruptedAttempts.value
	)
		return "interrupted_mismatch";
	const usage = row.usage;

	const parts = [
		usage.parentTokens,
		usage.childTokens,
		usage.unattributedTokens,
	];

	if (
		usage.tokens.kind === "exact" &&
		parts.every((part) => part.kind === "known") &&
		parts.reduce(
			(sum, part) => sum + (part.kind === "known" ? part.value : 0),
			0,
		) !== usage.tokens.total
	)
		return "usage_parts_mismatch";

	if (
		stages.reduce((sum, item) => sum + item.tokens.total, 0) >
		usage.tokens.total
	)
		return "stage_tokens_exceed_run";

	const models = (row.models.kind === "known" ? row.models.value : []).map(
		(item) => JSON.stringify([item.requested, item.observed, item.runtime]),
	);

	if (!sorted(models)) return "models_unsorted";

	if (!sorted(row.redactedReceiptDigests)) return "receipts_unsorted";
	const gaps = [...gapsOf(row, new Set())].sort();

	if (JSON.stringify(gaps) !== JSON.stringify(row.gaps)) return "gaps_mismatch";

	return null;
}

export type FrozenRow = {
	readonly row: LedgerRow;
	readonly bytes: Buffer;
	readonly digest: Digest;
};

function frozen(canonical: LedgerRow): FrozenRow {
	const problem = invariant(canonical);

	if (problem !== null) fail(problem);
	const bytes = Buffer.from(`${JSON.stringify(canonical)}\n`);

	return { row: canonical, bytes, digest: digestOf(bytes) };
}

/** Builds the one canonical row for a terminal run. Gaps are derived, never supplied. */
export function ledgerRow(input: LedgerRowInput): FrozenRow {
	return ledgerRowOf(input);
}

/** Builds a row from untyped stored input, such as a frozen terminal snapshot. */
export function ledgerRowOf(input: JsonValue): FrozenRow {
	const fields = objectOf(input) ?? fail("invalid_object");
	const canonical = rowCodec({ ...fields, gaps: [] });
	const gaps = [...gapsOf(canonical, new Set())].sort();

	return frozen(rowCodec({ ...canonical, gaps }));
}

export type LedgerLine =
	| {
			readonly kind: "known";
			readonly row: LedgerRow;
			readonly bytes: Buffer;
			readonly digest: Digest;
	  }
	| { readonly kind: "unknown_version"; readonly bytes: Buffer }
	| { readonly kind: "corrupt"; readonly bytes: Buffer; readonly code: string };

const utf8 = new TextDecoder("utf-8", { fatal: true });

function lineOf(bytes: Buffer): LedgerLine {
	if (bytes.at(-1) !== 0x0a)
		return { kind: "corrupt", bytes, code: "missing_lf" };
	let body: string;

	try {
		body = utf8.decode(bytes.subarray(0, -1));
	} catch {
		return { kind: "corrupt", bytes, code: "invalid_utf8" };
	}

	const value = parseJson(body);

	if (value === undefined || hasDuplicateKey(body))
		return { kind: "corrupt", bytes, code: "malformed_json" };
	const v = countOf(fieldOf(objectOf(value), "v"));

	if (v === null) return { kind: "corrupt", bytes, code: "missing_version" };

	if (v !== 1) return { kind: "unknown_version", bytes };

	try {
		const row = frozen(rowCodec(value));

		return row.bytes.equals(bytes)
			? { kind: "known", ...row, bytes }
			: { kind: "corrupt", bytes, code: "noncanonical" };
	} catch (error) {
		if (error instanceof LedgerRowError)
			return { kind: "corrupt", bytes, code: error.code };
		throw error;
	}
}

/** Splits ledger bytes into lines, each kept byte-for-byte with its diagnosis. */
export function parseLedger(bytes: Uint8Array): LedgerLine[] {
	const buffer = Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength);
	const lines: LedgerLine[] = [];
	let start = 0;

	while (start < buffer.length) {
		const end = buffer.indexOf(0x0a, start);
		const stop = end === -1 ? buffer.length : end + 1;
		lines.push(lineOf(buffer.subarray(start, stop)));
		start = stop;
	}

	return lines;
}

export type LedgerErrorCode =
	| "state_unwritable"
	| "transport_unavailable"
	| "row_conflict"
	| "ledger_corrupt"
	| "ledger_version_unsupported"
	| "ledger_contended"
	| "lineage_changed"
	| "ref_missing"
	| "object_mismatch";

export type LedgerIndex =
	| {
			readonly kind: "indexed";
			readonly rows: ReadonlyMap<Digest, { digest: Digest; line: number }>;
	  }
	| {
			readonly kind: "blocked";
			readonly reason: LedgerErrorCode;
			readonly line: number;
	  };

/** Indexes parsed rows by run ID. Any unknown, corrupt or repeated row blocks the writer. */
export function indexLedger(lines: readonly LedgerLine[]): LedgerIndex {
	const rows = new Map<Digest, { digest: Digest; line: number }>();

	for (const [at, line] of lines.entries()) {
		const number = at + 1;

		if (line.kind === "unknown_version")
			return {
				kind: "blocked",
				reason: "ledger_version_unsupported",
				line: number,
			};

		if (line.kind === "corrupt")
			return { kind: "blocked", reason: "ledger_corrupt", line: number };

		if (rows.has(line.row.runId))
			return { kind: "blocked", reason: "row_conflict", line: number };
		rows.set(line.row.runId, { digest: line.digest, line: number });
	}

	return { kind: "indexed", rows };
}

export interface LedgerApi {
	ref(): Promise<GitSha | null>;
	commit(sha: GitSha): Promise<LedgerCommit>;
	file(tree: GitSha): Promise<LedgerFile>;
	root(date: string): Promise<LedgerCommit>;
	child(
		parent: LedgerCommit,
		bytes: Uint8Array,
		date: string,
		message: string,
	): Promise<LedgerCommit>;
	advance(from: GitSha | null, next: GitSha): Promise<LedgerAdvance>;
}

export function ledgerApiOf(api: GitHubPublicationApi): LedgerApi {
	return {
		ref: () => api.ledgerRef(),
		commit: (sha) => readLedgerCommit(api, sha),
		file: (tree) => readLedgerFile(api, tree),
		root: (date) => createLedgerRoot(api, date),
		child: (parent, bytes, date, message) =>
			createLedgerChild(api, parent, bytes, date, message),
		advance: (from, next) => api.advanceLedger(from, next),
	};
}

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

async function verifyTip(
	api: LedgerApi,
	tip: GitSha,
	anchor: LedgerAnchor | null,
): Promise<Seen> {
	const head = await api.commit(tip);
	const file = await api.file(head.tree);
	let cursor = head;

	for (let walked = 0; ; walked++) {
		if (walked > MAX_WALK) return changed;

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
		cursor = await api.commit(parent);
	}

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
): Promise<AppendResult> {
	let current = anchor;

	try {
		for (let round = 0; round <= rounds + 1; round++) {
			const tip = await api.ref();

			if (tip === null) {
				if (current !== null)
					return { kind: "blocked", reason: "ref_missing", anchor: current };
				const root = await api.root(row.date);
				await api.advance(null, root.sha);
				continue;
			}

			const seen = await verifyTip(api, tip, current);

			if (seen.kind === "blocked")
				return { kind: "blocked", reason: seen.reason, anchor: current };
			const index = indexLedger(parseLedger(seen.file.bytes));

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

			const child = await api.child(
				seen.head,
				Buffer.concat([seen.file.bytes, row.bytes]),
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

/** Parses a pending row's exact bytes back into its frozen form. */
export function frozenRowOf(bytes: Buffer): FrozenRow | null {
	const [line, ...rest] = parseLedger(bytes);

	return line?.kind === "known" && rest.length === 0 ? line : null;
}

const unavailable = (reason: GapCode) => ({ kind: "unavailable", reason });

const known = (value: JsonValue) => ({ kind: "known", value });

export const AUTONOMY_DIGEST = digestOf(
	JSON.stringify({ approveMerge: "always", land: "propose" }),
);

export type TerminalFacts = {
	readonly repo: RepoSlug;
	readonly runId: Digest;
	readonly issue: number;
	readonly eventId: string;
	readonly eventAt: string;
	readonly snapshotDigest: Digest;
	readonly workflowSha: GitSha;
	readonly workflowDigest: Digest;
	readonly status: TerminalStatus;
	readonly stage: Stage;
	readonly usage: number;
	readonly observedAt: string;
	readonly candidate: CandidateState | null;
};

function outcomeOf(facts: TerminalFacts): JsonValue {
	const { stage, candidate } = facts;

	const terminal =
		candidate?.kind === "selected" && candidate.work.kind === "terminal"
			? candidate.work.terminal
			: null;

	switch (facts.status) {
		case "needs_info":
		case "released":
		case "stage_passed":
			return { kind: facts.status, stage };
		case "failed":
			return {
				kind: "failed",
				stage,
				cause: unavailable("not_instrumented"),
			};
		case "budget_exhausted":
			return {
				kind: "budget_exhausted",
				stage,
				cap: unavailable("not_instrumented"),
			};
		case "cancelled":
			return {
				kind: "cancelled",
				stage,
				reason:
					terminal?.kind === "cancelled"
						? known(terminal.reason)
						: unavailable("receipt_missing"),
			};
		case "landed":
			if (terminal?.kind !== "merged") return fail("landing_incomplete");

			return {
				kind: "landed",
				stage: "land",
				headSha: terminal.head,
				mergeSha: terminal.mergeSha,
				mergedAt: unavailable("public_metadata_unavailable"),
				assurance:
					terminal.assurance.kind === "factory_verified"
						? {
								kind: "factory_verified",
								generationDigest: terminal.assurance.certification.digest,
							}
						: { kind: "owner_override" },
			};
		default: {
			const exhaustive: never = facts.status;

			return exhaustive;
		}
	}
}

function artifactsOf(facts: TerminalFacts): JsonValue {
	const state = facts.candidate;

	if (state === null)
		return facts.stage === "specify"
			? { kind: "admission" }
			: {
					kind: "legacy_incomplete",
					contractDigest: unavailable("not_instrumented"),
					acceptanceDigest: unavailable("not_instrumented"),
				};

	if (state.kind === "unprepared")
		return {
			kind: "built",
			contractDigest: state.pin.contractDigest,
			acceptanceDigest: state.pin.acceptanceDigest,
			patchDigest: state.patch.patchDigest,
		};

	return {
		kind: "candidate",
		contractDigest: state.pin.contractDigest,
		acceptanceDigest: state.pin.acceptanceDigest,
		generations: candidateGenerations(state).map((evidence) => {
			const { intent, verdict, validation } = evidence;
			const publication = validation?.publication ?? null;
			const ci = validation?.ciRunId ?? null;

			return {
				round: intent.round,
				generation: intent.generation,
				intentDigest: intent.digest,
				baseSha: intent.baseSha,
				patchDigest: intent.patchDigest,
				heldoutDigest:
					verdict === null
						? unavailable("receipt_missing")
						: known(verdict.heldoutDigest),
				candidateSha:
					publication === null
						? unavailable("receipt_missing")
						: known(publication.candidateSha),
				gateSha:
					verdict === null
						? unavailable("receipt_missing")
						: known(verdict.gateSha),
				gatesDigest: unavailable("not_instrumented"),
				ciRunId: ci === null ? unavailable("receipt_missing") : known(ci),
			};
		}),
	};
}

/**
 * Projects what the controller knows at a terminal decision into a row
 * without its marker proof. Facts this build does not yet record are
 * unavailable, never zero.
 */
export function terminalSnapshot(facts: TerminalFacts): JsonValue {
	const base = `https://github.com/${facts.repo}`;
	const state = facts.candidate;
	const published = state?.kind === "selected" ? state.published : null;

	const ciUrls =
		state?.kind === "selected"
			? [
					...new Set(
						candidateGenerations(state).flatMap((evidence) =>
							evidence.validation?.ciRunId == null
								? []
								: [`${base}/actions/runs/${evidence.validation.ciRunId}`],
						),
					),
				].sort()
			: [];

	return {
		v: 1,
		runId: facts.runId,
		repo: facts.repo,
		issue: facts.issue,
		eventId: facts.eventId,
		eventAt: facts.eventAt,
		previousRunId: unavailable("not_instrumented"),
		snapshotDigest: facts.snapshotDigest,
		originalBase: state?.pin.originalBase ?? facts.workflowSha,
		startedAt: unavailable("not_instrumented"),
		terminalObservedAt: facts.observedAt,
		provenance: {
			kind: "production",
			policy: {
				workflowSha: facts.workflowSha,
				workflowDigest: facts.workflowDigest,
				gates: unavailable("not_instrumented"),
				autonomy: {
					approveMerge: "always",
					land: "propose",
					digest: AUTONOMY_DIGEST,
				},
			},
		},
		outcome: outcomeOf(facts),
		pr:
			published === null
				? null
				: { number: published.number, url: `${base}/pull/${published.number}` },
		artifacts: artifactsOf(facts),
		repairRounds: unavailable("not_instrumented"),
		stages: unavailable("not_instrumented"),
		models: unavailable("not_instrumented"),
		usage: {
			tokens: {
				kind: "lower_bound",
				unit: "tokens",
				total: facts.usage,
				reason: "not_instrumented",
			},
			parentTokens: unavailable("not_instrumented"),
			childTokens: unavailable("not_instrumented"),
			unattributedTokens: unavailable("not_instrumented"),
			money: unavailable("provider_not_reported"),
		},
		interruptedAttempts: unavailable("not_instrumented"),
		contextPressure: unavailable("not_instrumented"),
		redactedReceiptDigests: [],
		evidence: { issueUrl: `${base}/issues/${facts.issue}`, ciUrls },
	};
}

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
	freeze(
		runId: Digest,
		marker: MarkerProof,
	): Promise<"frozen" | "absent" | "invalid" | "unwritable">;
	/** Unpublished jobs, or `null` when the outbox cannot be read in full. */
	scan(): Promise<readonly OutboxJob[] | null>;
	anchor(): Promise<LedgerAnchor | null>;
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

	let anchor = await outbox.anchor();
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

		const result = await appendRun(
			api,
			{
				runId: job.runId,
				bytes: job.row.bytes,
				digest: job.row.digest,
				date: job.observedAt.replace(/\.\d{3}Z$/, "Z"),
			},
			anchor,
		);

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
			nextAt: now + Math.min(BACKOFF_MAX_MS, BACKOFF_MS * 2 ** (attempts - 1)),
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
