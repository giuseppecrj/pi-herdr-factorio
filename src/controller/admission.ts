import {
	type Answer,
	type AnswersRecord,
	type Link,
	MAX_ANSWERS,
	answerBody,
	answersDigestOf,
} from "../contract/contract.ts";
import { questionsKeyOf, withoutKey } from "../contract/render.ts";
import { type Digest, runIdOf } from "../core/run.ts";
import {
	type CommentEdit,
	GitHubTicketAdapter,
	type IssueComment,
	type IssueRecord,
	isLogin,
} from "../github/adapter.ts";
import type {
	AdmittedReceipt,
	Ambiguity,
	RefusalReason,
} from "../trust/admission.ts";
import {
	type TrustedMarker,
	isControllerComment,
	isTerminal,
	latestFor,
} from "../trust/markers.ts";
import type { PlatformProfile } from "../trust/platform.ts";
import { READY_LABEL, hasWriteAccess } from "../trust/policy.ts";
import type { CleanLedger } from "./claims.ts";
import type { OrchestratorInput } from "./orchestrator.ts";

/**
 * What the controller last decided for an issue at one `updated_at`. The
 * watermark is `updatedAt` with `observedAt`; the verdict, and a held run's
 * `eventId`, are the decision it guards.
 */
export type SeenIssue = {
	readonly updatedAt: string;
	/** The controller clock at the start of the tick whose reads made the verdict. */
	readonly observedAt: number;
	readonly verdict:
		| { readonly kind: "open"; readonly ledger: CleanLedger }
		| { readonly kind: "claimed" }
		| { readonly kind: "decided" }
		| {
				readonly kind: "refused";
				readonly reason: "answers_record_invalid" | "link_record_invalid";
		  }
		| { readonly kind: "corrupt" };
};

const SETTLE_MS = 1000;

/**
 * `updated_at` has whole seconds, so a change later in the second the issue
 * was read keeps the same value. A watermark observed before that second, plus
 * `SETTLE_MS`, has passed is read again on the next tick.
 */
export function settled(seen: SeenIssue): boolean {
	return seen.observedAt >= Date.parse(seen.updatedAt) + 1000 + SETTLE_MS;
}

function isClarificationPredecessor(
	prev: TrustedMarker,
	admitted: AdmittedReceipt,
	runId: Digest,
): boolean {
	return (
		prev.marker.status === "needs_info" &&
		prev.marker.runId !== runId &&
		admitted.eventAt > prev.marker.eventAt
	);
}

function isAnswerCandidate(
	comment: IssueComment,
	floor: bigint,
	labelAt: string,
	identity: Pick<PlatformProfile, "controllerLogin">,
): boolean {
	return (
		BigInt(comment.id) > floor &&
		comment.author !== null &&
		comment.author.type !== "Bot" &&
		!isControllerComment(comment, identity) &&
		comment.createdAt <= labelAt
	);
}

function answerEditPrecedesLabel(edit: CommentEdit, labelAt: string): boolean {
	return edit.lastEditedAt === null || edit.lastEditedAt < labelAt;
}

export function isReady(issue: IssueRecord): boolean {
	return issue.open && !issue.pullRequest && issue.labels.includes(READY_LABEL);
}

export function refusalSettlesUntilEdited(reason: RefusalReason): boolean {
	switch (reason.kind) {
		case "pull_request":
		case "issue_closed":
		case "actor_withheld":
		case "unauthorized":
		case "answers_record_invalid":
		case "link_record_invalid":
			return true;
		case "ambiguous_snapshot":
			return ambiguityRecursOnReread(reason.detail);
		case "not_labeled":
		case "no_label_event":
		case "repo_not_allowed":
		case "state_unavailable":
		case "locally_disabled":
		case "repo_switch_off":
		case "repo_switch_unavailable":
		case "issue_unavailable":
		case "timeline_unavailable":
		case "permission_unavailable":
		case "snapshot_unavailable":
		case "workflow_unavailable":
		case "duplicate_event":
		case "state_unwritable":
			return false;
		default: {
			const _exhaustive: never = reason;

			return _exhaustive;
		}
	}
}

function ambiguityRecursOnReread(detail: Ambiguity): boolean {
	switch (detail) {
		case "label_events_same_second":
		case "renamed_since_label":
		case "edited_at_label_time":
		case "version_withheld":
		case "answer_at_label_time":
			return true;
		case "rename_history_incomplete":
		case "title_changed_between_reads":
		case "body_changed_between_reads":
		case "history_contradicts_last_edit":
		case "history_incomplete":
		case "history_without_original":
		case "history_disagrees_with_body":
		case "no_version_before_label":
			return false;
		default: {
			const _exhaustive: never = detail;

			return _exhaustive;
		}
	}
}

export async function unmarkedEvents(
	input: Pick<OrchestratorInput, "store" | "repo">,
	issue: number,
	ledger: CleanLedger,
): Promise<string[] | null> {
	const repo = input.repo;
	const events = await input.store.listEvents({ repo, issue });

	return (
		events?.filter(
			(eventId) =>
				latestFor(ledger, runIdOf({ repo, issue, eventId })) === null,
		) ?? null
	);
}

async function answerHistory(
	input: Pick<OrchestratorInput, "files">,
	runId: Digest,
	ledger: CleanLedger,
): Promise<readonly AnswersRecord[] | "previous_link" | "previous_answers"> {
	const records: AnswersRecord[] = [];
	const visited = new Set<Digest>();
	let current = runId;

	for (;;) {
		if (visited.has(current)) return "previous_link";

		visited.add(current);

		const first = ledger.markers.find(({ marker }) => marker.runId === current);

		const earlier = ledger.markers.findLast(
			({ marker }) =>
				marker.seq < (first?.marker.seq ?? 0) && isTerminal(marker.status),
		);

		const linked = await input.files.readLink(current);

		if (linked.kind === "unreadable") return "previous_link";

		if (linked.kind === "unlinked") return records.reverse();

		if (linked.kind === "none") {
			return (await input.files.readAnswers(current)) === null
				? records.reverse()
				: "previous_link";
		}

		if (
			earlier?.marker.status === "needs_info" &&
			earlier.marker.runId !== linked.link.prevRunId
		)
			return "previous_link";

		const answers = await input.files.readAnswers(current);

		if (
			answers === null ||
			answers.runId !== current ||
			answers.prevRunId !== linked.link.prevRunId ||
			answers.digest !== linked.link.answersDigest ||
			answersDigestOf(answers) !== answers.digest
		)
			return "previous_answers";

		records.push(answers);
		current = linked.link.prevRunId;
	}
}

export async function linkRun(
	input: Pick<OrchestratorInput, "platform" | "log" | "files">,
	adapter: GitHubTicketAdapter,
	request: {
		issue: number;
		ledger: CleanLedger;
		admitted: AdmittedReceipt;
		runId: Digest;
	},
): Promise<
	| { readonly kind: "none" }
	| { readonly kind: "defer" }
	| { readonly kind: "ambiguous" }
	| {
			readonly kind: "invalid";
			readonly reason: "answers_record_invalid" | "link_record_invalid";
			readonly detail: "previous_answers" | "previous_link";
	  }
	| { readonly kind: "linked"; readonly link: Link; readonly answers: number }
> {
	const { issue, admitted, runId } = request;

	const prev: TrustedMarker | undefined = request.ledger.markers.findLast(
		({ marker }) => isTerminal(marker.status),
	);

	if (
		prev === undefined ||
		!isClarificationPredecessor(prev, admitted, runId)
	) {
		return { kind: "none" };
	}

	if (admitted.eventAt === prev.createdAt) return { kind: "ambiguous" };

	const comments = await adapter.readComments(issue);

	if (comments.kind === "failed") return { kind: "defer" };

	const prevRunId = prev.marker.runId;

	const asked = comments.value.find(
		(comment) =>
			isControllerComment(comment, input.platform) &&
			questionsKeyOf(comment.body)?.runId === prevRunId,
	);

	if (
		admitted.eventAt < prev.createdAt &&
		(asked === undefined || admitted.eventAt <= asked.createdAt)
	) {
		return { kind: "none" };
	}

	const floor = BigInt(asked?.id ?? prev.commentId);

	const candidates = comments.value
		.filter((comment) =>
			isAnswerCandidate(comment, floor, admitted.eventAt, input.platform),
		)
		.sort((a, b) => (BigInt(a.id) < BigInt(b.id) ? -1 : 1));

	if (candidates.some((comment) => comment.createdAt === admitted.eventAt)) {
		return { kind: "ambiguous" };
	}

	const edits = await adapter.readCommentEdits(
		candidates.map((comment) => comment.nodeId),
	);

	if (edits.kind === "failed") return { kind: "defer" };

	const history = await answerHistory(input, prevRunId, request.ledger);

	if (history === "previous_link" || history === "previous_answers") {
		return {
			kind: "invalid",
			reason:
				history === "previous_link"
					? "link_record_invalid"
					: "answers_record_invalid",
			detail: history,
		};
	}

	const previousAnswers = history.at(-1);
	const answers: Answer[] = [...(previousAnswers?.answers ?? [])];
	const permissions = new Map<string, boolean>();

	for (const comment of candidates) {
		if (answers.length >= MAX_ANSWERS) break;
		const edit = edits.value.get(comment.nodeId);
		const login = comment.author?.login ?? "";

		if (edit === undefined || edit.id !== comment.id) {
			return { kind: "defer" };
		}

		if (!answerEditPrecedesLabel(edit, admitted.eventAt) || !isLogin(login)) {
			continue;
		}

		let authorized = permissions.get(login.toLowerCase());

		if (authorized === undefined) {
			const permission = await adapter.readPermission(login);

			if (permission.kind === "failed") return { kind: "defer" };

			authorized = hasWriteAccess(permission.value);
			permissions.set(login.toLowerCase(), authorized);
		}

		if (!authorized) continue;

		answers.push({
			commentId: comment.id,
			author: login,
			createdAt: comment.createdAt,
			body: answerBody(comment.body),
		});

		if (answers.length === MAX_ANSWERS) break;
	}

	const questions = asked === undefined ? "" : withoutKey(asked.body);

	const rounds = [
		...history.map((record, index) => ({
			questions: record.questions,
			answers: record.answers.slice(history[index - 1]?.answers.length ?? 0),
		})),
		{
			questions,
			answers: answers.slice(previousAnswers?.answers.length ?? 0),
		},
	];

	const digest = answersDigestOf({ prevRunId, questions, answers, rounds });

	const record: AnswersRecord = {
		version: 1,
		runId,
		prevRunId,
		questionsCommentId: asked?.id ?? null,
		questions,
		answers,
		rounds,
		digest,
	};

	const link: Link = {
		prevRunId,
		questionsDigest:
			asked === undefined ? null : (questionsKeyOf(asked.body)?.digest ?? null),
		answersDigest: digest,
	};

	const { files } = input;

	if (
		!(await files.writeAnswers(record)) ||
		!(await files.writeLink(runId, link))
	) {
		input.log("link_unwritable", { issue, runId });

		return { kind: "defer" };
	}

	return { kind: "linked", link, answers: answers.length };
}
