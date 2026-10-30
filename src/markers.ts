import type { CommentEdit, IssueComment } from "./adapters/github.ts";
import { type Digest, isDigest, runIdOf, type Stage } from "./run.ts";
import { STAGE_ORDER } from "./stages.ts";
import type { JsonValue } from "./tickets.ts";
import {
	type GitSha,
	isGitSha,
	isRepoSlug,
	type RepoSlug,
} from "./workflow.ts";

export const CONTROLLER_LOGIN = "exe-dev-github-integration[bot]";
export const CONTROLLER_APP_SLUG = "exe-dev-github-integration";

export const MARKER_PREFIX = "<!-- factory:run ";
const MARKER_SUFFIX = " -->";
const MARKER_LEAD = "<!-- factory:";

/** The cap on a whole marker comment body, in UTF-8 bytes. */
export const MARKER_MAX_BYTES = 4096;

export const RUN_STATUSES = [
	"claimed",
	"running",
	"blocked",
	"retrying",
	"released",
	"failed",
	"budget_exhausted",
	"stage_passed",
	"needs_info",
] as const;

export type RunStatus = (typeof RUN_STATUSES)[number];

export type TerminalStatus = Extract<
	RunStatus,
	"released" | "failed" | "budget_exhausted" | "stage_passed" | "needs_info"
>;

export function isTerminal(status: RunStatus): status is TerminalStatus {
	return (
		status === "released" ||
		status === "failed" ||
		status === "budget_exhausted" ||
		status === "stage_passed" ||
		status === "needs_info"
	);
}

/**
 * One controller-written state record. Every value is built by the factory:
 * no title, body, comment text, label name, `gh` output or path.
 */
export type Marker = {
	readonly v: 1;
	readonly runId: Digest;
	readonly repo: RepoSlug;
	readonly issue: number;
	readonly eventId: string;
	readonly eventAt: string;
	readonly snapshotDigest: Digest;
	readonly workflowSha: GitSha;
	readonly workflowDigest: Digest;
	readonly stage: Stage;
	readonly status: RunStatus;
	readonly attempt: number;
	readonly seq: number;
	readonly branch: null;
	readonly pr: null;
	readonly usage: number;
	readonly cursor: string | null;
};

const MARKER_KEYS = [
	"v",
	"runId",
	"repo",
	"issue",
	"eventId",
	"eventAt",
	"snapshotDigest",
	"workflowSha",
	"workflowDigest",
	"stage",
	"status",
	"attempt",
	"seq",
	"branch",
	"pr",
	"usage",
	"cursor",
] as const satisfies readonly (keyof Marker)[];

export type MarkerDefect =
	| "too_large"
	| "malformed"
	| "unknown_version"
	| "unknown_key"
	| "missing_key"
	| "bad_value"
	| "run_id_mismatch"
	| "not_bot_type"
	| "wrong_app"
	| "wrong_issue"
	| "edited"
	| "edit_unverified"
	| "duplicate_seq"
	| "conflicting_run"
	| "after_terminal"
	| "record_mismatch";

export type MarkerParse =
	| { readonly kind: "none" }
	| { readonly kind: "marker"; readonly marker: Marker }
	| { readonly kind: "corrupt"; readonly defect: MarkerDefect };

const EVENT_ID = /^[1-9][0-9]{0,19}$/;
const TIMESTAMP = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/;
const CURSOR = /^[A-Za-z0-9:._-]{1,64}$/;

export function isStage(value: string): value is Stage {
	return STAGE_ORDER.some((stage) => stage === value);
}

export function isRunStatus(value: string): value is RunStatus {
	return RUN_STATUSES.some((status) => status === value);
}

function textOf(value: JsonValue | undefined): string | null {
	if (value === undefined) return null;

	const text = String(value);

	return value === text ? text : null;
}

function countOf(value: JsonValue | undefined, min: number): number | null {
	if (value === undefined) return null;

	const count = Number(value);

	return value === count && Number.isSafeInteger(count) && count >= min
		? count
		: null;
}

/** JSON for a marker, with `<` and `>` escaped so the comment never closes early. */
function markerJson(marker: Marker): string {
	const ordered: Record<(typeof MARKER_KEYS)[number], JsonValue> = {
		v: marker.v,
		runId: marker.runId,
		repo: marker.repo,
		issue: marker.issue,
		eventId: marker.eventId,
		eventAt: marker.eventAt,
		snapshotDigest: marker.snapshotDigest,
		workflowSha: marker.workflowSha,
		workflowDigest: marker.workflowDigest,
		stage: marker.stage,
		status: marker.status,
		attempt: marker.attempt,
		seq: marker.seq,
		branch: marker.branch,
		pr: marker.pr,
		usage: marker.usage,
		cursor: marker.cursor,
	};

	return JSON.stringify(ordered)
		.replaceAll("<", "\\u003c")
		.replaceAll(">", "\\u003e");
}

const STATUS_TEXT: Readonly<Record<RunStatus, string>> = {
	claimed: "claimed",
	running: "running",
	blocked: "blocked: the stage sandbox is unavailable",
	retrying: "waiting to retry",
	released: "released: the issue is no longer eligible",
	failed: "failed: retries are exhausted",
	budget_exhausted: "stopped: the run budget is spent",
	stage_passed: "stopped: stage passed; the next stage is not installed",
	needs_info:
		"stopped: questions are on the issue; answer them and add factory:ready again",
};

/** The full comment body: the marker line, then one line a person can read. */
export function formatMarker(marker: Marker): string {
	const body = `${MARKER_PREFIX}${markerJson(marker)}${MARKER_SUFFIX}\nFactory run \`${marker.runId.slice(0, 12)}\` is ${STATUS_TEXT[marker.status]}. Stage ${marker.stage}, attempt ${marker.attempt}.\n`;

	if (Buffer.byteLength(body, "utf8") > MARKER_MAX_BYTES) {
		throw new Error("a marker exceeds the size cap");
	}

	return body;
}

function parseJsonText(text: string): JsonValue | undefined {
	try {
		const parsed: JsonValue = JSON.parse(text);

		return parsed;
	} catch {
		return undefined;
	}
}

function markerFields(
	value: JsonValue | undefined,
): Map<string, JsonValue> | MarkerDefect {
	if (
		value === undefined ||
		value === null ||
		Array.isArray(value) ||
		!(value instanceof Object)
	) {
		return "malformed";
	}

	const fields = new Map(Object.entries(value));

	if (!fields.has("v")) return "missing_key";

	if (fields.get("v") !== 1) return "unknown_version";

	for (const key of fields.keys()) {
		if (!MARKER_KEYS.some((known) => known === key)) return "unknown_key";
	}

	for (const key of MARKER_KEYS) {
		if (!fields.has(key)) return "missing_key";
	}

	return fields;
}

function readMarker(fields: Map<string, JsonValue>): Marker | null {
	const runId = textOf(fields.get("runId"));
	const repo = textOf(fields.get("repo"));
	const issue = countOf(fields.get("issue"), 1);
	const eventId = textOf(fields.get("eventId"));
	const eventAt = textOf(fields.get("eventAt"));
	const snapshot = textOf(fields.get("snapshotDigest"));
	const workflowSha = textOf(fields.get("workflowSha"));
	const workflowDigest = textOf(fields.get("workflowDigest"));
	const stage = textOf(fields.get("stage"));
	const status = textOf(fields.get("status"));
	const attempt = countOf(fields.get("attempt"), 1);
	const seq = countOf(fields.get("seq"), 1);
	const usage = countOf(fields.get("usage"), 0);
	const cursor = fields.get("cursor");
	const cursorText = cursor === null ? null : textOf(cursor);

	if (
		runId === null ||
		!isDigest(runId) ||
		repo === null ||
		!isRepoSlug(repo) ||
		issue === null ||
		eventId === null ||
		!EVENT_ID.test(eventId) ||
		eventAt === null ||
		!TIMESTAMP.test(eventAt) ||
		snapshot === null ||
		!isDigest(snapshot) ||
		workflowSha === null ||
		!isGitSha(workflowSha) ||
		workflowDigest === null ||
		!isDigest(workflowDigest) ||
		stage === null ||
		!isStage(stage) ||
		status === null ||
		!isRunStatus(status) ||
		attempt === null ||
		seq === null ||
		usage === null ||
		fields.get("branch") !== null ||
		fields.get("pr") !== null ||
		(cursor !== null && (cursorText === null || !CURSOR.test(cursorText)))
	) {
		return null;
	}

	return {
		v: 1,
		runId,
		repo,
		issue,
		eventId,
		eventAt,
		snapshotDigest: snapshot,
		workflowSha,
		workflowDigest,
		stage,
		status,
		attempt,
		seq,
		branch: null,
		pr: null,
		usage,
		cursor: cursorText,
	};
}

/**
 * Parses a comment body by exact prefix. A body that does not start with
 * `<!-- factory:` is not a marker. One that does and fails any rule is corrupt.
 */
export function parseMarker(body: string): MarkerParse {
	if (!body.startsWith(MARKER_LEAD)) return { kind: "none" };

	const corrupt = (defect: MarkerDefect): MarkerParse => ({
		kind: "corrupt",
		defect,
	});

	if (Buffer.byteLength(body, "utf8") > MARKER_MAX_BYTES) {
		return corrupt("too_large");
	}

	const end = body.indexOf(MARKER_SUFFIX);

	if (!body.startsWith(MARKER_PREFIX) || end < 0) return corrupt("malformed");

	const rest = body.slice(end + MARKER_SUFFIX.length);

	if (rest !== "" && !rest.startsWith("\n")) return corrupt("malformed");

	const fields = markerFields(
		parseJsonText(body.slice(MARKER_PREFIX.length, end)),
	);

	if (!(fields instanceof Map)) return corrupt(fields);

	const marker = readMarker(fields);

	if (marker === null) return corrupt("bad_value");

	const expected = runIdOf({
		repo: marker.repo,
		issue: marker.issue,
		eventId: marker.eventId,
	});

	return marker.runId === expected
		? { kind: "marker", marker }
		: corrupt("run_id_mismatch");
}

/**
 * A REST comment written as the controller. The trust rule checks the edit
 * record of every one, so stripping the marker prefix from one is detected.
 */
export function isControllerComment(comment: IssueComment): boolean {
	return comment.author?.login === CONTROLLER_LOGIN;
}

export type TrustedMarker = {
	readonly marker: Marker;
	readonly commentId: string;
	readonly createdAt: string;
};

/**
 * Every marker on one issue. `clean` holds the trusted markers by `seq`, the
 * highest last. `corrupt` stops dispatch for the issue.
 */
export type MarkerLedger =
	| {
			readonly kind: "clean";
			readonly markers: readonly TrustedMarker[];
			readonly ignored: number;
	  }
	| {
			readonly kind: "corrupt";
			readonly defect: MarkerDefect;
			readonly commentId: string;
	  };

function trustOne(input: {
	comment: IssueComment;
	edit: CommentEdit | undefined;
	repo: RepoSlug;
	issue: number;
}):
	| { readonly kind: "trusted"; readonly entry: TrustedMarker }
	| { readonly kind: "corrupt"; readonly defect: MarkerDefect } {
	const found = trustCheck(input);

	return "marker" in found
		? { kind: "trusted", entry: found }
		: { kind: "corrupt", defect: found.defect };
}

function trustCheck(input: {
	comment: IssueComment;
	edit: CommentEdit | undefined;
	repo: RepoSlug;
	issue: number;
}): TrustedMarker | { readonly defect: MarkerDefect } {
	const { comment, edit, repo, issue } = input;

	const defect = (kind: MarkerDefect) => ({ defect: kind });

	if (comment.author?.type !== "Bot") return defect("not_bot_type");

	if (comment.appSlug !== null && comment.appSlug !== CONTROLLER_APP_SLUG) {
		return defect("wrong_app");
	}

	if (!comment.issueUrl.endsWith(`/repos/${repo}/issues/${issue}`)) {
		return defect("wrong_issue");
	}

	const edited = editDefect(comment, edit, repo, issue);

	if (edited !== null) return defect(edited);

	const parsed = parseMarker(comment.body);

	if (parsed.kind === "none") return defect("malformed");

	if (parsed.kind === "corrupt") return defect(parsed.defect);

	const { marker } = parsed;

	if (marker.repo !== repo || marker.issue !== issue) {
		return defect("wrong_issue");
	}

	return { marker, commentId: comment.id, createdAt: comment.createdAt };
}

function editDefect(
	comment: IssueComment,
	edit: CommentEdit | undefined,
	repo: RepoSlug,
	issue: number,
): "edit_unverified" | "edited" | null {
	if (
		edit === undefined ||
		edit.id !== comment.id ||
		edit.issue !== issue ||
		edit.repo !== repo
	) {
		return "edit_unverified";
	}

	return edit.lastEditedAt === null ? null : "edited";
}

function sameRun(left: Marker, right: Marker): boolean {
	return (
		left.eventAt === right.eventAt &&
		left.snapshotDigest === right.snapshotDigest &&
		left.workflowSha === right.workflowSha &&
		left.workflowDigest === right.workflowDigest
	);
}

function conflictOf(markers: readonly TrustedMarker[]): MarkerLedger | null {
	const runs = new Map<string, TrustedMarker>();
	const seqs = new Set<number>();
	const ended = new Set<string>();

	for (const entry of markers) {
		const { marker } = entry;

		const corrupt = (defect: MarkerDefect): MarkerLedger => ({
			kind: "corrupt",
			defect,
			commentId: entry.commentId,
		});

		if (seqs.has(marker.seq)) return corrupt("duplicate_seq");
		seqs.add(marker.seq);

		const first = runs.get(marker.runId);

		if (first !== undefined && !sameRun(first.marker, marker)) {
			return corrupt("conflicting_run");
		}

		if (ended.has(marker.runId)) return corrupt("after_terminal");

		if (isTerminal(marker.status)) ended.add(marker.runId);
		runs.set(marker.runId, first ?? entry);
	}

	return null;
}

/**
 * Applies the trust rule to every comment on `issue`. Comments from any other
 * author are ignored. A controller comment that was edited or whose edit read
 * does not match it, a controller comment shaped like a marker that fails any
 * rule, or two trusted markers that disagree, make the issue corrupt.
 */
export function markerLedger(input: {
	repo: RepoSlug;
	issue: number;
	comments: readonly IssueComment[];
	edits: ReadonlyMap<string, CommentEdit>;
}): MarkerLedger {
	const trusted: TrustedMarker[] = [];
	let ignored = 0;

	for (const comment of input.comments) {
		const claimsMarker = comment.body.startsWith(MARKER_LEAD);

		if (!isControllerComment(comment)) {
			if (claimsMarker) ignored++;
			continue;
		}

		const edit = input.edits.get(comment.nodeId);

		if (!claimsMarker) {
			const edited = editDefect(comment, edit, input.repo, input.issue);

			if (edited !== null) {
				return { kind: "corrupt", defect: edited, commentId: comment.id };
			}

			continue;
		}

		const result = trustOne({
			comment,
			edit,
			repo: input.repo,
			issue: input.issue,
		});

		if (result.kind === "corrupt") {
			return { kind: "corrupt", defect: result.defect, commentId: comment.id };
		}

		trusted.push(result.entry);
	}

	trusted.sort((left, right) => left.marker.seq - right.marker.seq);

	return conflictOf(trusted) ?? { kind: "clean", markers: trusted, ignored };
}

/** The current marker: the trusted one with the highest `seq`. */
export function currentMarker(
	ledger: Extract<MarkerLedger, { kind: "clean" }>,
): Marker | null {
	return ledger.markers.at(-1)?.marker ?? null;
}

/** The newest trusted marker for `runId`, if any. */
export function latestFor(
	ledger: Extract<MarkerLedger, { kind: "clean" }>,
	runId: string,
): TrustedMarker | null {
	return (
		ledger.markers.findLast((entry) => entry.marker.runId === runId) ?? null
	);
}
