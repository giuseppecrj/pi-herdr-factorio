import type { GitSha, Guidance } from "../config/schema.ts";
import type { JsonValue } from "../core/json.ts";
import { type Digest, digestOf, isDigest, type NonEmpty } from "../core/run.ts";
import type { SnapshotSource } from "../trust/admission.ts";
import type { RepoSlug } from "../trust/platform.ts";

export const NEEDS_INFO_LABEL = "factory:needs-info";

export const CONTRACT_VERSION = 2;

export const COMMENT_MAX_BYTES = 8 * 1024;

export const LINE_MAX = 300;

export type ContractDigest = Digest & { readonly __of: "contract" };

export type QuestionsDigest = Digest & { readonly __of: "questions" };

export type AnswersDigest = Digest & { readonly __of: "answers" };

export function isContractDigest(input: string): input is ContractDigest {
	return isDigest(input);
}

export function isQuestionsDigest(input: string): input is QuestionsDigest {
	return isDigest(input);
}

export function isAnswersDigest(input: string): input is AnswersDigest {
	return isDigest(input);
}

function branded<T extends Digest>(
	text: string,
	guard: (input: string) => input is T,
): T {
	const digest = digestOf(text);

	if (!guard(digest)) throw new Error("sha256 produced a malformed digest");

	return digest;
}

export type Cite = {
	readonly path: string;
	readonly start: number;
	readonly end: number;
};

export type Question = {
	readonly text: string;
	readonly cites: readonly Cite[];
};

export type Evidence = Cite & { readonly fact: string };

export type CriterionKind = "new_behavior" | "preservation";

export type Criterion = {
	readonly id: string;
	readonly kind: CriterionKind;
	readonly text: string;
};

export type ReplacedTest = { readonly path: string; readonly reason: string };

export type ContractDraft = {
	readonly summary: string;
	readonly behavior: NonEmpty<string>;
	readonly exclusions: readonly string[];
	readonly acceptance: NonEmpty<Criterion>;
	readonly compatibility: readonly string[];
	readonly limits: readonly string[];
	readonly files: readonly string[];
	readonly evidence: readonly Evidence[];
	readonly replacesTests?: readonly ReplacedTest[];
};

export type Link = {
	readonly prevRunId: Digest;
	readonly questionsDigest: QuestionsDigest | null;
	readonly answersDigest: AnswersDigest;
};

export type Contract = ContractDraft & {
	readonly version: typeof CONTRACT_VERSION;
	readonly runId: Digest;
	readonly issue: number;
	readonly base: { readonly repo: RepoSlug; readonly sha: GitSha };
	readonly snapshot: {
		readonly digest: Digest;
		readonly source: SnapshotSource;
		readonly eventId: string;
		readonly eventAt: string;
	};
	readonly link: Link | null;
};

export type MalformedReason =
	| "empty"
	| "too_large"
	| "not_json"
	| "duplicate_key"
	| "bad_kind"
	| "unknown_key"
	| "bad_field"
	| "unknown_path"
	| "too_large_to_post";

export type SpecifyOutput =
	| { readonly kind: "contract"; readonly draft: ContractDraft }
	| { readonly kind: "questions"; readonly questions: NonEmpty<Question> }
	| { readonly kind: "malformed"; readonly reason: MalformedReason };

export type Answer = {
	readonly commentId: string;
	readonly author: string;
	readonly createdAt: string;
	readonly body: string;
};

export type ClarificationRound = {
	readonly questions: string;
	readonly answers: readonly Answer[];
};

export type AnswersRecord = {
	readonly version: 1;
	readonly runId: Digest;
	readonly prevRunId: Digest;
	readonly questionsCommentId: string | null;
	readonly questions: string;
	readonly answers: readonly Answer[];
	readonly rounds?: readonly ClarificationRound[];
	readonly digest: AnswersDigest;
};

export const OUTPUT_MAX_BYTES = 256 * 1024;

export const MAX_BEHAVIOR = 8;

export const MAX_LIST = 8;

export const MAX_CRITERIA = 10;

export const MAX_FILES = 20;

export const MAX_EVIDENCE = 12;

export const MAX_QUESTIONS = 5;

export const MAX_CITES = 3;

export const MAX_CITE_SPAN = 400;

const ANSWER_MAX_CHARS = 4000;

export const MAX_ANSWERS = 20;

export type JsonObject = { readonly [key: string]: JsonValue };

export function contractBytes(contract: Contract): string {
	const ordered: Contract = {
		version: contract.version,
		runId: contract.runId,
		issue: contract.issue,
		base: { repo: contract.base.repo, sha: contract.base.sha },
		snapshot: {
			digest: contract.snapshot.digest,
			source: contract.snapshot.source,
			eventId: contract.snapshot.eventId,
			eventAt: contract.snapshot.eventAt,
		},
		link: contract.link,
		summary: contract.summary,
		behavior: contract.behavior,
		exclusions: contract.exclusions,
		acceptance: contract.acceptance,
		compatibility: contract.compatibility,
		limits: contract.limits,
		files: contract.files,
		evidence: contract.evidence,
		replacesTests: contract.replacesTests,
	};

	return `${JSON.stringify(ordered, null, "\t")}\n`;
}

export function contractDigestOf(bytes: string): ContractDigest {
	return branded(bytes, isContractDigest);
}

export function questionsDigestOf(
	questions: readonly Question[],
): QuestionsDigest {
	return branded(
		JSON.stringify(
			questions.map((question) => [
				question.text,
				question.cites.map((cite) => [cite.path, cite.start, cite.end]),
			]),
		),
		isQuestionsDigest,
	);
}

export function answersDigestOf(input: {
	readonly prevRunId: Digest;
	readonly questions: string;
	readonly answers: readonly Answer[];
	readonly rounds?: readonly ClarificationRound[];
}): AnswersDigest {
	return branded(
		JSON.stringify([
			input.prevRunId,
			input.questions,
			input.answers.map((answer) => [
				answer.commentId,
				answer.author,
				answer.createdAt,
				answer.body,
			]),
			...(input.rounds === undefined
				? []
				: [
						input.rounds.map((round) => [
							round.questions,
							round.answers.map((answer) => [
								answer.commentId,
								answer.author,
								answer.createdAt,
								answer.body,
							]),
						]),
					]),
		]),
		isAnswersDigest,
	);
}

export function answerBody(text: string): string {
	const chars = [...text];

	return chars.length <= ANSWER_MAX_CHARS
		? text
		: `${chars.slice(0, ANSWER_MAX_CHARS).join("")} [cut]`;
}

export type InlinedFile = {
	readonly path: string;
	readonly text: string;
	readonly totalLines: number;
	readonly unavailable?: {
		readonly reason: "missing" | "unreadable";
		readonly checkout: string;
	};
	readonly excerpt?: {
		readonly start: number;
		readonly end: number;
		readonly checkout: string;
		readonly contentDigest: Digest;
		readonly selection:
			| "evidence"
			| "test_harness"
			| "fallback_missing"
			| "fallback_stale"
			| "omitted_ceiling";
		readonly repair: boolean;
		readonly omitted: boolean;
		readonly capHit: boolean;
		readonly skipped?: number;
	};
};

export type SourceFacts = {
	readonly bytes: number;
	readonly omissions: number;
	readonly capHit: boolean;
};

export type PromptInput = {
	readonly repo: RepoSlug;
	readonly baseSha: GitSha;
	readonly guidance: Guidance;
	readonly files: readonly string[];
	readonly inlined: readonly InlinedFile[];
	readonly title: string;
	readonly body: string;
	readonly answers: AnswersRecord | null;
};

export type SpecifyReviewInput = Pick<
	PromptInput,
	"title" | "body" | "answers" | "files"
>;
