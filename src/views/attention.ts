import { lstat, readFile, readdir } from "node:fs/promises";
import { join, resolve } from "node:path";
import { isDigest, type Digest, runIdOf } from "../core/run.ts";
import { isRepoSlug, type RepoSlug } from "../trust/platform.ts";
import type { JsonValue } from "../core/json.ts";
import { parseCandidateState } from "../candidate/codec.ts";
import { candidateProjection } from "../candidate/handoff.ts";
import { parseMarker, MARKER_PREFIX } from "../trust/markers.ts";
import { FEEDBACK_UNAVAILABLE_REASONS } from "../candidate/feedback.ts";
import { fileAdmissionStore } from "../trust/admission.ts";
import { isStage } from "../core/stages.ts";

export const ATTENTION_THRESHOLDS = {
	waitingMs: 3 * 24 * 60 * 60 * 1000,
	blockedMs: 6 * 60 * 60 * 1000,
} as const;

export type AttentionThresholds = { waitingMs: number; blockedMs: number };

export function plainTitle(title: string): string {
	return [...title]
		.map((char) => {
			const code = char.codePointAt(0) ?? 0;

			return code < 32 ||
				(code >= 127 && code <= 159) ||
				/[\u061c\u200e\u200f\u202a-\u202e\u2066-\u2069]/.test(char)
				? " "
				: char;
		})
		.slice(0, 120)
		.join("");
}

export const ATTENTION_KINDS = [
	"question_asked",
	"question_answered",
	"spec_review",
	"pr_review",
	"blocked",
	"budget",
	"failed",
] as const;

export type AttentionKind = (typeof ATTENTION_KINDS)[number];

export type AttentionEntry = Readonly<{
	runId: Digest;
	issueUrl: string;
	prUrl: string | null;
	ageMs: number | null;
	reason: string | null;
	title: string;
	status: string;
	stale: boolean;
}>;

export type AttentionRun = AttentionEntry &
	Readonly<{
		issue: number;
		eventId: string;
		stage: string;
		since: number | null;
		terminal: boolean;
		kind: AttentionKind | null;
	}>;

export type AttentionRead =
	| {
			readonly kind: "unavailable";
			readonly reason: "state_not_configured" | "state_unavailable";
	  }
	| {
			readonly kind: "available";
			readonly at: number;
			readonly groups: Readonly<
				Record<AttentionKind, readonly AttentionEntry[]>
			>;
			readonly runs: readonly AttentionRun[];
			readonly specReview: "not_enabled_in_v1";
			readonly gaps: readonly string[];
	  };

type AttentionClaim = Readonly<{
	runId: Digest;
	issue: number;
	eventId: string;
	repo: RepoSlug;
	seq: number;
	status: string;
	stage: string;
	enteredAt: number | null;
	pr: number | null;
	readiness: "ready" | "not_ready" | null;
	reason: string | null;
	terminal: boolean;
	evidenceMissing: boolean;
}>;

function objectOf(
	value: JsonValue | undefined,
): Record<string, JsonValue> | null {
	return value !== null &&
		value !== undefined &&
		!Array.isArray(value) &&
		value instanceof Object
		? value
		: null;
}

function stringOf(value: JsonValue | undefined): string | null {
	return value === String(value) ? String(value) : null;
}

function countOf(value: JsonValue | undefined): number | null {
	return value === Number(value) &&
		Number.isSafeInteger(value) &&
		Number(value) >= 0
		? Number(value)
		: null;
}

function parseJson(text: string): JsonValue | undefined {
	try {
		const value: JsonValue = JSON.parse(text);

		return value;
	} catch {
		return undefined;
	}
}

async function privatePath(path: string, directory: boolean): Promise<boolean> {
	try {
		const stat = await lstat(path);

		return (
			(directory ? stat.isDirectory() : stat.isFile()) &&
			stat.uid === process.geteuid?.() &&
			(stat.mode & 0o077) === 0
		);
	} catch {
		return false;
	}
}

async function privateJson(path: string): Promise<JsonValue | undefined> {
	if (!(await privatePath(path, false))) return undefined;
	const stat = await lstat(path);

	if (stat.size > 8 * 1024 * 1024) return undefined;

	return parseJson(await readFile(path, "utf8"));
}

function parseClaim(
	value: JsonValue | undefined,
	repo: RepoSlug,
): AttentionClaim | null {
	const claim = objectOf(value);
	const runId = stringOf(claim?.runId);
	const eventId = stringOf(claim?.eventId);
	const issue = countOf(claim?.issue);
	const seq = countOf(claim?.seq);
	const status = stringOf(claim?.status);
	const stage = stringOf(claim?.stage);

	if (
		runId === null ||
		!isDigest(runId) ||
		issue === null ||
		issue < 1 ||
		eventId === null ||
		!/^[1-9][0-9]{0,19}$/.test(eventId) ||
		runId !== runIdOf({ repo, issue, eventId }) ||
		seq === null ||
		seq < 1 ||
		status === null ||
		stage === null ||
		![
			"claimed",
			"running",
			"blocked",
			"retrying",
			"released",
			"failed",
			"budget_exhausted",
			"stage_passed",
			"needs_info",
			"waiting",
			"landed",
			"cancelled",
		].includes(status) ||
		!isStage(stage)
	)
		return null;
	const rawBook = claim?.handoff;
	const book = parseCandidateState(rawBook);

	if (
		rawBook !== undefined &&
		(book === null ||
			book.pin.runId !== runId ||
			book.pin.issue !== issue ||
			book.pin.repo !== repo)
	)
		return null;
	const rawMarker = claim?.marker;

	const parsedMarker =
		rawMarker === undefined
			? null
			: parseMarker(`${MARKER_PREFIX}${JSON.stringify(rawMarker)} -->`);

	if (
		parsedMarker !== null &&
		(parsedMarker.kind !== "marker" ||
			parsedMarker.marker.runId !== runId ||
			parsedMarker.marker.repo !== repo ||
			parsedMarker.marker.issue !== issue ||
			parsedMarker.marker.eventId !== eventId ||
			parsedMarker.marker.status !== status ||
			parsedMarker.marker.seq !== seq)
	)
		return null;
	const marker = parsedMarker?.kind === "marker" ? parsedMarker.marker : null;

	const evidenceMissing =
		book === null &&
		(marker?.v === 3 ||
			status === "waiting" ||
			["validate", "review", "land"].includes(stage));

	const projection = book === null ? null : candidateProjection(book);
	const published = book?.kind === "selected" ? book.published : null;
	const work = book?.kind === "selected" ? book.work : null;

	const overflow =
		book?.kind === "selected" ? book.feedback?.overflow : undefined;

	const readiness = published?.readiness;
	const pr = published?.number ?? marker?.pr ?? null;

	const ready = readiness?.kind;

	const enteredAt =
		evidenceMissing &&
		!["released", "stage_passed", "landed", "cancelled"].includes(
			projection?.status ?? status,
		)
			? null
			: overflow !== undefined
				? overflow.since
				: work?.kind === "held" &&
						(work.reason === "pr_identity" ||
							work.reason === "pr_ambiguous" ||
							work.reason === "workflow_unavailable" ||
							work.reason === "feedback_overflow")
					? work.since
					: (countOf(claim?.enteredAt) ?? readiness?.since ?? null);

	const reason = evidenceMissing
		? "candidate_book_unavailable"
		: overflow !== undefined
			? "feedback_overflow"
			: readiness?.kind === "not_ready"
				? readiness.reason
				: work?.kind === "held"
					? work.reason
					: published !== null && work?.kind !== "waiting"
						? "working_generation"
						: null;

	return {
		runId,
		issue,
		eventId,
		repo,
		seq,
		status: projection?.status ?? status,
		stage: projection?.stage ?? stage,
		enteredAt,
		pr,
		readiness: ready === "ready" || ready === "not_ready" ? ready : null,
		reason,
		terminal: ["released", "stage_passed", "landed", "cancelled"].includes(
			projection?.status ?? status,
		),
		evidenceMissing,
	};
}

function groupOf(
	claim: AttentionClaim,
	answered: boolean,
): AttentionKind | null {
	if (claim.terminal) return null;

	if (claim.status === "budget_exhausted") return "budget";

	if (
		claim.pr !== null &&
		(claim.readiness === "not_ready" ||
			claim.reason === "feedback_overflow" ||
			claim.status !== "waiting" ||
			claim.evidenceMissing)
	)
		return "blocked";

	if (claim.evidenceMissing && claim.status !== "failed") return "blocked";

	if (claim.status === "waiting" && claim.pr !== null) return "pr_review";

	if (claim.status === "blocked") return "blocked";

	if (claim.status === "failed") return "failed";

	if (claim.status === "needs_info") return "question_asked";

	if (answered && (claim.stage === "admit" || claim.stage === "specify"))
		return "question_answered";

	return null;
}

type ClaimHold = Readonly<{
	runId: Digest;
	issue: number;
	since: number;
	reason: string;
}>;

function unverifiedHolds(
	snapshot: JsonValue | undefined,
	repo: RepoSlug,
): Map<Digest, ClaimHold> {
	const status = objectOf(snapshot);
	const holds = new Map<Digest, ClaimHold>();

	if (status?.repo !== repo || !Array.isArray(status.unverifiedClaims))
		return holds;

	for (const value of status.unverifiedClaims) {
		const held = objectOf(value);
		const runId = stringOf(held?.runId);
		const issue = countOf(held?.issue);
		const eventId = stringOf(held?.eventId);
		const since = countOf(held?.since);
		const why = stringOf(held?.why);
		const failure = stringOf(held?.failure);

		if (
			runId === null ||
			!isDigest(runId) ||
			issue === null ||
			issue < 1 ||
			eventId === null ||
			!/^[1-9][0-9]{0,19}$/.test(eventId) ||
			runIdOf({ repo, issue, eventId }) !== runId ||
			since === null ||
			why === null ||
			!["issue", "timeline", "ledger", "timeline_entry"].includes(why) ||
			!(
				held?.failure === null ||
				(failure !== null &&
					[
						"gh_failed",
						"cannot_run_gh",
						"malformed_response",
						"pagination_limit",
					].includes(failure))
			)
		)
			continue;

		holds.set(runId, {
			runId,
			issue,
			since,
			reason: `claim_unverified:${why}${failure === null ? "" : `:${failure}`}`,
		});
	}

	return holds;
}

function feedbackHolds(
	snapshot: JsonValue | undefined,
	repo: RepoSlug,
): Map<Digest, ClaimHold & { readonly pr: number }> {
	const status = objectOf(snapshot);
	const holds = new Map<Digest, ClaimHold & { readonly pr: number }>();

	if (status?.repo !== repo || !Array.isArray(status.feedbackIntake))
		return holds;

	for (const value of status.feedbackIntake) {
		const entry = objectOf(value);
		const runId = stringOf(entry?.runId);
		const issue = countOf(entry?.issue);
		const eventId = stringOf(entry?.eventId);
		const pr = countOf(entry?.pr);
		const since = countOf(entry?.since);
		const reason = stringOf(entry?.reason);
		const failure = stringOf(entry?.failure);

		if (
			entry?.kind !== "unavailable" ||
			runId === null ||
			!isDigest(runId) ||
			issue === null ||
			issue < 1 ||
			eventId === null ||
			!/^[1-9][0-9]{0,19}$/.test(eventId) ||
			runIdOf({ repo, issue, eventId }) !== runId ||
			pr === null ||
			pr < 1 ||
			since === null ||
			reason === null ||
			!FEEDBACK_UNAVAILABLE_REASONS.some((r) => r === reason) ||
			!(
				entry.failure === null ||
				(failure !== null &&
					[
						"gh_failed",
						"cannot_run_gh",
						"malformed_response",
						"pagination_limit",
					].includes(failure))
			)
		)
			continue;
		holds.set(runId, {
			runId,
			issue,
			pr,
			since,
			reason: `feedback_unavailable:${reason}${failure === null ? "" : `:${failure}`}`,
		});
	}

	return holds;
}

export async function readAttention(input: {
	stateDir: string | null;
	repo: RepoSlug | null;
	now: number;
	thresholds?: AttentionThresholds;
	terminalSince?: number;
	runId?: Digest;
}): Promise<AttentionRead> {
	if (input.stateDir === null)
		return { kind: "unavailable", reason: "state_not_configured" };
	const root = resolve(input.stateDir);

	if (
		input.repo === null ||
		!isRepoSlug(input.repo) ||
		!(await privatePath(root, true)) ||
		!(await privatePath(join(root, "claims"), true))
	)
		return { kind: "unavailable", reason: "state_unavailable" };

	const groups: Record<AttentionKind, AttentionEntry[]> = {
		question_asked: [],
		question_answered: [],
		spec_review: [],
		pr_review: [],
		blocked: [],
		budget: [],
		failed: [],
	};

	const gaps: string[] = [];
	const runs: AttentionRun[] = [];
	const thresholds = input.thresholds ?? ATTENTION_THRESHOLDS;
	const admissions = fileAdmissionStore(root);

	try {
		const names =
			input.runId === undefined
				? await readdir(join(root, "claims"))
				: [`${input.runId}.json`];

		if (names.length > 10_000)
			return { kind: "unavailable", reason: "state_unavailable" };
		const newest = new Map<number, AttentionClaim>();

		const snapshot = await privateJson(join(root, "status.json"));
		const holds = unverifiedHolds(snapshot, input.repo);
		const intakeHolds = feedbackHolds(snapshot, input.repo);

		for (const name of names.sort()) {
			if (!/^[a-f0-9]{64}\.json$/.test(name)) {
				gaps.push("unrecognized_claim");
				continue;
			}

			const claim = parseClaim(
				await privateJson(join(root, "claims", name)),
				input.repo,
			);

			if (claim === null || name !== `${claim.runId}.json`) {
				gaps.push(`invalid_claim:${name.slice(0, 12)}`);
				continue;
			}

			if (claim.terminal) holds.delete(claim.runId);
			const previous = newest.get(claim.issue);

			if (
				previous === undefined ||
				BigInt(claim.eventId) > BigInt(previous.eventId) ||
				(claim.eventId === previous.eventId && claim.seq > previous.seq)
			)
				newest.set(claim.issue, claim);
			else if (claim.eventId === previous.eventId && claim.seq === previous.seq)
				gaps.push(`ambiguous_issue:${claim.issue}`);
		}

		for (const claim of newest.values()) {
			if (claim.terminal && input.terminalSince !== undefined) {
				const row = objectOf(
					await privateJson(join(root, "ledger", claim.runId, "row.json")),
				);

				const terminal =
					row ??
					objectOf(
						await privateJson(
							join(root, "ledger", claim.runId, "terminal.json"),
						),
					);

				const observed = Date.parse(
					stringOf(terminal?.terminalObservedAt) ?? "",
				);

				const since = Number.isFinite(observed) ? observed : claim.enteredAt;

				if (since === null || since < input.terminalSince) continue;
			}

			if (claim.evidenceMissing)
				gaps.push(`candidate_book_unavailable:${claim.runId.slice(0, 12)}`);
			let answered = false;

			if (claim.stage === "admit" || claim.stage === "specify") {
				const linkPath = join(root, "links", `${claim.runId}.json`);

				try {
					await lstat(linkPath);
					const link = objectOf(await privateJson(linkPath));
					const prev = stringOf(link?.prevRunId);
					const answers = stringOf(link?.answersDigest);

					const unlinked =
						link?.version === 1 &&
						link.prevRunId === null &&
						link.questionsDigest === undefined &&
						link.answersDigest === undefined;

					if (!unlinked) {
						answered =
							prev !== null &&
							isDigest(prev) &&
							answers !== null &&
							isDigest(answers);

						if (!answered)
							gaps.push(`invalid_link:${claim.runId.slice(0, 12)}`);
					}
				} catch {
					answered = false;
				}
			}

			const intake = intakeHolds.get(claim.runId);

			const hold = claim.terminal
				? undefined
				: (holds.get(claim.runId) ??
					(intake?.pr === claim.pr && claim.reason !== "feedback_overflow"
						? intake
						: undefined));

			holds.delete(claim.runId);
			const kind = hold === undefined ? groupOf(claim, answered) : "blocked";

			const issueUrl = `https://github.com/${claim.repo}/issues/${claim.issue}`;
			const since = hold?.since ?? claim.enteredAt;

			const snapshot = await admissions.readSnapshot({
				repo: input.repo,
				issue: claim.issue,
				eventId: claim.eventId,
			});

			const ageMs =
				since === null || since > input.now ? null : input.now - since;

			const entry: AttentionRun = {
				issue: claim.issue,
				eventId: claim.eventId,
				stage: claim.stage,
				since,
				terminal: claim.terminal,
				kind,
				title:
					snapshot.kind === "found"
						? plainTitle(snapshot.snapshot.title)
						: "Title unavailable",
				status: claim.status,
				stale:
					ageMs !== null &&
					((kind === "pr_review" && ageMs >= thresholds.waitingMs) ||
						(kind === "blocked" && ageMs >= thresholds.blockedMs)),
				runId: claim.runId,
				issueUrl,
				prUrl:
					claim.pr === null
						? null
						: `https://github.com/${claim.repo}/pull/${claim.pr}`,
				ageMs,
				reason: hold?.reason ?? claim.reason,
			};

			runs.push(entry);

			if (kind !== null) {
				const { runId, issueUrl, prUrl, ageMs, reason, title, status, stale } =
					entry;

				groups[kind].push({
					runId,
					issueUrl,
					prUrl,
					ageMs,
					reason,
					title,
					status,
					stale,
				});
			}
		}

		for (const hold of holds.values()) {
			groups.blocked.push({
				runId: hold.runId,
				issueUrl: `https://github.com/${input.repo}/issues/${hold.issue}`,
				prUrl: null,
				ageMs: hold.since > input.now ? null : input.now - hold.since,
				reason: hold.reason,
				title: "Title unavailable",
				status: "blocked",
				stale: input.now - hold.since >= thresholds.blockedMs,
			});
		}

		return {
			kind: "available",
			at: input.now,
			groups,
			runs,
			specReview: "not_enabled_in_v1",
			gaps,
		};
	} catch {
		return { kind: "unavailable", reason: "state_unavailable" };
	}
}

export function formatAttention(attention: AttentionRead): string {
	if (attention.kind === "unavailable")
		return `attention   unavailable: ${attention.reason}`;

	return [
		"attention   local snapshot",
		...ATTENTION_KINDS.map(
			(kind) =>
				`  ${kind}: ${kind === "spec_review" ? "not enabled in v1" : attention.groups[kind].length}`,
		),
		...ATTENTION_KINDS.flatMap((kind) =>
			attention.groups[kind].map(
				(entry) =>
					`    ${kind} ${entry.prUrl ?? entry.issueUrl} age ${entry.ageMs === null ? "unknown" : `${Math.floor(entry.ageMs / 1000)}s`}${entry.stale ? " stale" : ""} ${entry.status}${entry.reason === null ? "" : ` (${entry.reason})`}`,
			),
		),
		...(attention.gaps.length === 0
			? []
			: [`  evidence gaps: ${attention.gaps.length}`]),
	].join("\n");
}
