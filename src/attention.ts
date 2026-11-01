import { lstat, readFile, readdir } from "node:fs/promises";
import { join, resolve } from "node:path";
import { isDigest, type Digest, runIdOf } from "./run.ts";
import { isRepoSlug, type RepoSlug } from "./workflow.ts";
import type { JsonValue } from "./tickets.ts";
import { parseCandidateState, candidateProjection } from "./handoff.ts";
import { parseMarker, MARKER_PREFIX } from "./markers.ts";

export const ATTENTION_KINDS = [
	"question_asked",
	"question_answered",
	"spec_review",
	"pr_review",
	"blocked",
	"failed",
] as const;

export type AttentionKind = (typeof ATTENTION_KINDS)[number];

export type AttentionEntry = Readonly<{
	runId: Digest;
	issueUrl: string;
	prUrl: string | null;
	ageMs: number | null;
	reason: string | null;
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
			readonly specReview: "not_enabled_in_v1";
			readonly gaps: readonly string[];
	  };

type AttentionClaim = Readonly<{
	runId: Digest;
	issue: number;
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
		![
			"admit",
			"specify",
			"accept",
			"build",
			"validate",
			"review",
			"land",
		].includes(stage)
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
	const readiness = published?.readiness;
	const pr = published?.number ?? marker?.pr ?? null;
	const ready = readiness?.kind;

	const enteredAt = evidenceMissing
		? null
		: (countOf(claim?.enteredAt) ?? readiness?.since ?? null);

	const reason = evidenceMissing
		? "candidate_book_unavailable"
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

	if (
		claim.pr !== null &&
		(claim.readiness === "not_ready" ||
			claim.status !== "waiting" ||
			claim.evidenceMissing)
	)
		return "blocked";

	if (claim.evidenceMissing && claim.status !== "failed") return "blocked";

	if (claim.status === "waiting" && claim.pr !== null) return "pr_review";

	if (claim.status === "blocked" || claim.status === "budget_exhausted")
		return "blocked";

	if (claim.status === "failed") return "failed";

	if (claim.status === "needs_info") return "question_asked";

	if (answered && (claim.stage === "admit" || claim.stage === "specify"))
		return "question_answered";

	return null;
}

export async function readAttention(input: {
	stateDir: string | null;
	repo: RepoSlug | null;
	now: number;
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
		failed: [],
	};

	const gaps: string[] = [];

	try {
		const names = await readdir(join(root, "claims"));

		if (names.length > 10_000)
			return { kind: "unavailable", reason: "state_unavailable" };
		const newest = new Map<number, AttentionClaim>();

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

			const previous = newest.get(claim.issue);

			if (previous === undefined || claim.seq > previous.seq)
				newest.set(claim.issue, claim);
			else if (claim.seq === previous.seq)
				gaps.push(`ambiguous_issue:${claim.issue}`);
		}

		for (const claim of newest.values()) {
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
					answered =
						prev !== null &&
						isDigest(prev) &&
						answers !== null &&
						isDigest(answers);

					if (!answered) gaps.push(`invalid_link:${claim.runId.slice(0, 12)}`);
				} catch {
					/* A run without a clarification link is ordinary intake. */
				}
			}

			const kind = groupOf(claim, answered);

			if (kind === null) continue;
			const issueUrl = `https://github.com/${claim.repo}/issues/${claim.issue}`;
			groups[kind].push({
				runId: claim.runId,
				issueUrl,
				prUrl:
					claim.pr === null
						? null
						: `https://github.com/${claim.repo}/pull/${claim.pr}`,
				ageMs:
					claim.enteredAt === null || claim.enteredAt > input.now
						? null
						: input.now - claim.enteredAt,
				reason: claim.reason,
			});
		}

		return {
			kind: "available",
			at: input.now,
			groups,
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
					`    ${kind} ${entry.prUrl ?? entry.issueUrl} age ${entry.ageMs === null ? "unknown" : `${Math.floor(entry.ageMs / 1000)}s`}${entry.reason === null ? "" : ` (${entry.reason})`}`,
			),
		),
		...(attention.gaps.length === 0
			? []
			: [`  evidence gaps: ${attention.gaps.length}`]),
	].join("\n");
}
