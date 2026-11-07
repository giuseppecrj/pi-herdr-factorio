import type { HandoffReason } from "./handoff.ts";
import type { GitHubFailure } from "./adapters/github.ts";
import type { JsonValue } from "./tickets.ts";
import { CONTROLLER_LOGIN } from "./markers.ts";
import { posix } from "node:path";
import { digestOf, isDigest, type Digest } from "./run.ts";
import { isGitSha, type GitSha, type RepoSlug } from "./workflow.ts";

export type FeedbackId =
	| `github:${RepoSlug}:issue-comment:${number}`
	| `github:${RepoSlug}:review:${number}`
	| `github:${RepoSlug}:review-comment:${number}`;

export function feedbackId<
	S extends "issue-comment" | "review" | "review-comment",
>(repo: RepoSlug, source: S, id: number): `github:${RepoSlug}:${S}:${number}` {
	if (!Number.isSafeInteger(id) || id < 1) throw new Error("feedback_id");

	return `github:${repo}:${source}:${id}`;
}

export type InlineComment = Readonly<{
	id: Extract<FeedbackId, `${string}:review-comment:${number}`>;
	path: string;
	line: number | null;
	commit: GitSha;
	inReplyTo: FeedbackId | null;
	body: string;
}>;

export type FeedbackEvent = Readonly<{
	id: FeedbackId;
	pr: number;
	actor: string;
	at: string;
}> &
	(
		| Readonly<{
				kind: "review";
				state: "CHANGES_REQUESTED" | "APPROVED" | "COMMENTED" | "DISMISSED";
				commit: GitSha;
				body: string;
				comments: readonly InlineComment[];
		  }>
		| Readonly<{ kind: "conversation"; body: string }>
	);

export type FeedbackIntake =
	| Readonly<{ kind: "actionable" }>
	| Readonly<{ kind: "ignored"; reason: "not_change_request" }>
	| Readonly<{
			kind: "refused";
			reason: "unauthorized" | "stale_head" | "empty";
	  }>;

export type InlineIntake =
	| Readonly<{ kind: "forwarded" }>
	| Readonly<{ kind: "refused"; reason: "heldout_path" }>;

export type IntakeRecord = Readonly<{
	event: FeedbackId;
	actor: string;
	intake: FeedbackIntake;
	inline: readonly Readonly<{ id: FeedbackId; intake: InlineIntake }>[];
}>;

export type FeedbackCard = Readonly<{
	event: FeedbackId;
	head: GitSha;
	path: string | null;
	line: number | null;
	excerpt: string;
	truncated: boolean;
}>;

export type FeedbackBatch = Readonly<{
	version: 1;
	runId: Digest;
	pr: number;
	head: GitSha;
	records: readonly IntakeRecord[];
	cards: readonly FeedbackCard[];
	/** Metadata alone exceeded the card bound; full text is retained for the hold. */
	overflow?: true;
	full: Readonly<{ digest: Digest; bytes: number }> | null;
}>;

export const FEEDBACK_CARD_BYTES = 8 * 1024;
export const MAX_FEEDBACK_SEEN = 500;
export const MAX_FEEDBACK_BATCHES = 16;

export type BatchOutcome =
	| Readonly<{ kind: "no_action" }>
	| Readonly<{ kind: "applied"; head: GitSha }>
	| Readonly<{ kind: "stopped"; reason: HandoffReason }>
	| Readonly<{
			kind: "superseded";
			by: "promotion" | "owner_head" | "dismissed";
	  }>
	| Readonly<{ kind: "merged"; mergeSha: GitSha }>
	| Readonly<{
			kind: "refused";
			reason: "cap_reached" | "repair_unavailable" | "owner_authored_head";
	  }>;

export type FeedbackBatchStatus =
	| Readonly<{ kind: "queued" }>
	| Readonly<{ kind: "applying"; round: 1 | 2 }>
	| Readonly<{ kind: "settled"; outcome: BatchOutcome }>;

export type BatchNotice = "none" | "due" | "posted";

export type FeedbackBatchRef = Readonly<{
	digest: Digest;
	head: GitSha;
	actionable: boolean;
	reviews: readonly FeedbackId[];
	notice: BatchNotice;
	status: FeedbackBatchStatus;
}>;

export type FeedbackCursor = Readonly<{
	pr: number;
	seen: readonly FeedbackId[];
	batches: readonly FeedbackBatchRef[];
	/** Intake stops here; apply this hold only after the current stage settles. */
	overflow?: Readonly<{ since: number; notice: "due" | "posted" }>;
}>;

export const FEEDBACK_UNAVAILABLE_REASONS = [
	"comments",
	"reviews",
	"review_comments",
	"permission",
	"storage",
	"unexpected",
] as const;

export type FeedbackObservation =
	| Readonly<{ kind: "none" }>
	| Readonly<{ kind: "deferred"; reason?: "head_mismatch" }>
	| Readonly<{
			kind: "unavailable";
			reason?: (typeof FEEDBACK_UNAVAILABLE_REASONS)[number];
			failure?: GitHubFailure["kind"] | null;
	  }>
	| Readonly<{
			kind: "read";
			head: GitSha;
			batch: Readonly<{
				digest: Digest;
				seen: readonly FeedbackId[];
				reviews: readonly FeedbackId[];
				actionable: boolean;
				refusedInline: boolean;
				overflow?: true;
			}> | null;
			dismissed: readonly FeedbackId[];
	  }>;

export type FeedbackDisposition =
	| Readonly<{ kind: "adopted"; head: GitSha; source: "builder_reported" }>
	| Readonly<{
			kind: "rejected";
			reason:
				| "out_of_scope"
				| "forbidden_path"
				| "builder_declined"
				| "heldout_path"
				| "repair_stopped"
				| "superseded"
				| "cap_reached";
	  }>
	| Readonly<{ kind: "merged"; mergeSha: GitSha }>;

export type FindingDisposition = Readonly<{
	fingerprint: Digest;
	seat: string;
	disposition: FeedbackDisposition;
}>;

export type RoundReceipt = Readonly<{
	round: 1 | 2;
	batch: Digest;
	items: readonly Readonly<{
		event: FeedbackId;
		disposition: FeedbackDisposition;
	}>[];
	findings: readonly FindingDisposition[];
}>;

export function canonicalJson(
	value: FeedbackBatch | readonly FeedbackCard[],
): string {
	return JSON.stringify(value, (_key, item: JsonValue) => {
		if (item instanceof Object && !Array.isArray(item))
			return Object.fromEntries(
				Object.entries(item).sort(([a], [b]) => a.localeCompare(b, "en")),
			);

		return item;
	});
}

function heldoutPath(path: string): boolean {
	const normalized = posix.normalize(path.replaceAll("\\", "/")).toLowerCase();

	return (
		normalized === "test/acceptance" ||
		normalized.startsWith("test/acceptance/")
	);
}

export type ClassifiedFeedback =
	| Readonly<{ kind: "unavailable" }>
	| Readonly<{
			kind: "read";
			batch: FeedbackBatch | null;
			full: string | null;
			dismissed: readonly FeedbackId[];
	  }>;

export async function classifyFeedback(input: {
	runId: Digest;
	pr: number;
	head: GitSha;
	events: readonly FeedbackEvent[];
	seen: readonly FeedbackId[];
	permission(actor: string): Promise<"write" | "read" | "failed">;
}): Promise<ClassifiedFeedback> {
	const seen = new Set(input.seen);

	const events = input.events
		.filter((e) => e.actor.toLowerCase() !== CONTROLLER_LOGIN.toLowerCase())
		.sort((a, b) => a.id.localeCompare(b.id, "en"));

	const dismissed = events.flatMap((e) =>
		e.kind === "review" && e.state === "DISMISSED" && seen.has(e.id)
			? [e.id]
			: [],
	);

	const records: IntakeRecord[] = [];
	const originals: FeedbackCard[] = [];
	const permissions = new Map<string, "write" | "read" | "failed">();

	for (const event of events) {
		if (seen.has(event.id) || records.some((r) => r.event === event.id))
			continue;
		const actor = event.actor.toLowerCase();
		let permission = permissions.get(actor);

		if (permission === undefined) {
			try {
				permission = await input.permission(event.actor);
			} catch {
				return { kind: "unavailable" };
			}

			permissions.set(actor, permission);
		}

		if (permission === "failed") return { kind: "unavailable" };

		const inline: IntakeRecord["inline"] =
			event.kind === "review" && event.state === "CHANGES_REQUESTED"
				? [...event.comments]
						.sort((a, b) => a.id.localeCompare(b.id, "en"))
						.map((c) => ({
							id: c.id,
							intake: heldoutPath(c.path)
								? { kind: "refused", reason: "heldout_path" }
								: { kind: "forwarded" },
						}))
				: [];

		let intake: FeedbackIntake;

		if (permission !== "write")
			intake = { kind: "refused", reason: "unauthorized" };
		else if (event.kind !== "review" || event.state !== "CHANGES_REQUESTED")
			intake = { kind: "ignored", reason: "not_change_request" };
		else if (event.commit !== input.head)
			intake = { kind: "refused", reason: "stale_head" };
		else if (
			!event.body.trim() &&
			!event.comments.some((c) => !heldoutPath(c.path) && c.body.trim())
		)
			intake = { kind: "refused", reason: "empty" };
		else intake = { kind: "actionable" };
		records.push({ event: event.id, actor: event.actor, intake, inline });

		if (intake.kind !== "actionable" || event.kind !== "review") continue;

		if (event.body.trim())
			originals.push({
				event: event.id,
				head: input.head,
				path: null,
				line: null,
				excerpt: event.body,
				truncated: false,
			});

		for (const c of [...event.comments].sort((a, b) =>
			a.id.localeCompare(b.id, "en"),
		)) {
			if (!heldoutPath(c.path) && c.body.trim())
				originals.push({
					event: c.id,
					head: input.head,
					path: c.path,
					line: c.line,
					excerpt: c.body,
					truncated: false,
				});
		}
	}

	if (records.length === 0)
		return { kind: "read", batch: null, full: null, dismissed };

	// Account for the JSON envelope and escaped text as well as UTF-8 bytes.
	const cards = originals.map((c) => ({
		...c,
		excerpt: "",
		truncated: c.excerpt.length > 0,
	}));

	const overflow =
		Buffer.byteLength(JSON.stringify(cards)) > FEEDBACK_CARD_BYTES;

	if (overflow) cards.length = 0;

	for (const [index, original] of originals.entries()) {
		const card = cards[index];

		if (card === undefined) continue;
		const chars = [...original.excerpt];

		let low = 0,
			high = chars.length;

		while (low < high) {
			const mid = Math.ceil((low + high) / 2);
			card.excerpt = chars.slice(0, mid).join("");
			card.truncated = mid < chars.length;

			if (Buffer.byteLength(JSON.stringify(cards)) <= FEEDBACK_CARD_BYTES)
				low = mid;
			else high = mid - 1;
		}

		card.excerpt = chars.slice(0, low).join("");
		card.truncated = low < chars.length;
	}

	const full =
		overflow || cards.some((c) => c.truncated)
			? canonicalJson(originals)
			: null;

	const batch: FeedbackBatch = {
		version: 1,
		runId: input.runId,
		pr: input.pr,
		head: input.head,
		records,
		cards,
		full:
			full === null
				? null
				: { digest: digestOf(full), bytes: Buffer.byteLength(full) },
	};

	return {
		kind: "read",
		batch: overflow ? { ...batch, overflow: true } : batch,
		full,
		dismissed,
	};
}

function record(
	value: JsonValue | undefined,
): Record<string, JsonValue> | null {
	return value instanceof Object && !Array.isArray(value)
		? Object.fromEntries(Object.entries(value))
		: null;
}

function keys(
	value: Record<string, JsonValue>,
	allowed: readonly string[],
): boolean {
	return (
		Object.keys(value).length === allowed.length &&
		allowed.every((k) => Object.hasOwn(value, k))
	);
}

function count(value: JsonValue | undefined): value is number {
	return (
		value === Number(value) && Number.isSafeInteger(value) && Number(value) >= 0
	);
}

function text(value: JsonValue | undefined): value is string {
	return value === String(value);
}

export function isFeedbackId(
	value: JsonValue | undefined,
	repo?: RepoSlug,
): value is FeedbackId {
	if (!text(value)) return false;

	const match =
		/^github:([A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+):(issue-comment|review|review-comment):([1-9][0-9]*)$/.exec(
			value,
		);

	return (
		match !== null &&
		(repo === undefined || match[1] === repo) &&
		Number.isSafeInteger(Number(match[3]))
	);
}

export function wireFeedbackCursor(
	value: JsonValue | undefined,
	repo: RepoSlug,
	reason: (value: JsonValue | undefined) => boolean,
): value is FeedbackCursor & JsonValue {
	const v = record(value);

	if (
		v === null ||
		!keys(
			v,
			v.overflow === undefined
				? ["pr", "seen", "batches"]
				: ["pr", "seen", "batches", "overflow"],
		) ||
		!count(v.pr) ||
		v.pr < 1 ||
		!Array.isArray(v.seen) ||
		v.seen.length > MAX_FEEDBACK_SEEN ||
		!v.seen.every((id) => isFeedbackId(id, repo)) ||
		new Set(v.seen).size !== v.seen.length ||
		JSON.stringify(v.seen) !== JSON.stringify([...v.seen].sort()) ||
		!Array.isArray(v.batches) ||
		v.batches.length > MAX_FEEDBACK_BATCHES
	)
		return false;

	if (v.overflow !== undefined) {
		const overflow = record(v.overflow);

		if (
			overflow === null ||
			!keys(overflow, ["since", "notice"]) ||
			!count(overflow.since) ||
			!["due", "posted"].includes(String(overflow.notice))
		)
			return false;
	}

	const digests = new Set<string>();

	for (const entry of v.batches) {
		const b = record(entry);

		if (
			b === null ||
			!keys(b, [
				"digest",
				"head",
				"actionable",
				"reviews",
				"notice",
				"status",
			]) ||
			!text(b.digest) ||
			!isDigest(b.digest) ||
			digests.has(b.digest) ||
			!text(b.head) ||
			!isGitSha(b.head) ||
			(b.actionable !== true && b.actionable !== false) ||
			!Array.isArray(b.reviews) ||
			!b.reviews.every(
				(id) =>
					isFeedbackId(id, repo) &&
					id.includes(":review:") &&
					v.seen instanceof Array &&
					v.seen.includes(id),
			) ||
			!["none", "due", "posted"].includes(String(b.notice))
		)
			return false;
		digests.add(b.digest);
		const s = record(b.status);

		if (s === null) return false;

		if (s.kind === "queued" && keys(s, ["kind"])) continue;

		if (
			s.kind === "applying" &&
			keys(s, ["kind", "round"]) &&
			(s.round === 1 || s.round === 2)
		)
			continue;

		if (s.kind !== "settled" || !keys(s, ["kind", "outcome"])) return false;
		const o = record(s.outcome);

		if (o === null) return false;

		if (o.kind === "no_action" && keys(o, ["kind"])) continue;

		if (
			o.kind === "applied" &&
			keys(o, ["kind", "head"]) &&
			text(o.head) &&
			isGitSha(o.head)
		)
			continue;

		if (
			o.kind === "merged" &&
			keys(o, ["kind", "mergeSha"]) &&
			text(o.mergeSha) &&
			isGitSha(o.mergeSha)
		)
			continue;

		if (o.kind === "stopped" && keys(o, ["kind", "reason"]) && reason(o.reason))
			continue;

		if (
			o.kind === "superseded" &&
			keys(o, ["kind", "by"]) &&
			["promotion", "owner_head", "dismissed"].includes(String(o.by))
		)
			continue;

		if (
			o.kind === "refused" &&
			keys(o, ["kind", "reason"]) &&
			["cap_reached", "repair_unavailable", "owner_authored_head"].includes(
				String(o.reason),
			)
		)
			continue;

		return false;
	}

	return true;
}
