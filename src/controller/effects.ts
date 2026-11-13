import type { PatchRead } from "../candidate/build.ts";
import type { WorkflowConfig } from "../config/schema.ts";
import {
	type AcceptanceSuite,
	writeAcceptance,
} from "../contract/acceptance.ts";
import {
	CONTRACT_VERSION,
	type Contract,
	type ContractDigest,
	type Question,
	type QuestionsDigest,
	contractBytes,
	contractDigestOf,
	questionsDigestOf,
} from "../contract/contract.ts";
import { parseSpecifyOutput } from "../contract/parse.ts";
import {
	renderQuestions,
	renderSummary,
	questionsKey,
} from "../contract/render.ts";
import type { FamilyInput } from "../core/models.ts";
import type { NonEmpty } from "../core/run.ts";
import { GitHubTicketAdapter, GitHubTicketWriter } from "../github/adapter.ts";
import { isControllerComment } from "../trust/markers.ts";
import type { ActiveRun, RunPhase } from "./claims.ts";
import type { OrchestratorInput } from "./orchestrator.ts";

export type Effects =
	| {
			readonly kind: "build";
			readonly result: Extract<PatchRead, { kind: "found" }>;
	  }
	| {
			readonly kind: "acceptance";
			readonly contract: Contract;
			readonly contractDigest: ContractDigest;
			readonly suite: AcceptanceSuite;
			readonly model: string;
			readonly observed: string | null;
			readonly family?: FamilyInput;
	  }
	| {
			readonly kind: "contract";
			readonly contract: Contract;
			readonly bytes: string;
			readonly digest: ContractDigest;
			readonly body: string;
			stored: boolean;
			posted: boolean;
	  }
	| {
			readonly kind: "questions";
			readonly questions: NonEmpty<Question>;
			readonly digest: QuestionsDigest;
			readonly body: string;
			stored: boolean;
			posted: boolean;
			labeled: boolean;
			unlabeled: boolean;
			labelTick: number;
	  };

async function hasKeyed(
	input: Pick<OrchestratorInput, "platform">,
	adapter: GitHubTicketAdapter,
	issue: number,
	key: string,
): Promise<boolean | null> {
	const comments = await adapter.readComments(issue);

	if (comments.kind === "failed") return null;

	return comments.value.some(
		(comment) =>
			isControllerComment(comment, input.platform) &&
			comment.body.trimEnd().split("\n").at(-1) === key,
	);
}

export async function postKeyed(
	input: Pick<OrchestratorInput, "platform" | "log">,
	adapter: GitHubTicketAdapter,
	writer: GitHubTicketWriter,
	run: Pick<ActiveRun, "issue" | "runId">,
	key: string,
	body: string,
): Promise<boolean> {
	const found = await hasKeyed(input, adapter, run.issue, key);

	if (found === null) return false;

	if (found) return true;

	const post = await writer.postComment(run.issue, body);

	if (post.kind !== "posted") {
		input.log("comment_unconfirmed", {
			issue: run.issue,
			runId: run.runId,
			outcome: post.kind,
		});
	}

	return post.kind === "posted";
}

export async function postQuestions(
	input: Pick<OrchestratorInput, "platform" | "log" | "files">,
	adapter: GitHubTicketAdapter,
	writer: GitHubTicketWriter,
	run: Pick<ActiveRun, "issue" | "runId">,
	digest: QuestionsDigest,
	body: string,
): Promise<boolean> {
	const key = questionsKey(run.runId, digest);

	if (!(await postKeyed(input, adapter, writer, run, key, body))) return false;

	const comments = await adapter.readComments(run.issue);

	if (comments.kind === "ok") {
		const candidates = comments.value.filter(
			(comment) =>
				isControllerComment(comment, input.platform) &&
				comment.author?.type === "Bot" &&
				(comment.appSlug === null ||
					comment.appSlug === input.platform.controllerAppSlug) &&
				comment.issueUrl.endsWith(
					`/repos/${adapter.repo}/issues/${run.issue}`,
				) &&
				comment.body.trimEnd().split("\n").at(-1) === key,
		);

		const [comment] = candidates;

		if (candidates.length === 1 && comment !== undefined) {
			const edits = await adapter.readCommentEdits([comment.nodeId]);

			const edit =
				edits.kind === "ok" ? edits.value.get(comment.nodeId) : undefined;

			if (
				edit?.id === comment.id &&
				edit.repo === adapter.repo &&
				edit.issue === run.issue &&
				edit.lastEditedAt === null &&
				(await input.files.writeQuestionsComment({
					runId: run.runId,
					repo: adapter.repo,
					issue: run.issue,
					digest,
					commentId: comment.id,
				}))
			)
				return true;
		}
	}

	input.log("questions_reference_unavailable", {
		issue: run.issue,
		runId: run.runId,
	});

	return true;
}

export function specified(
	input: Pick<OrchestratorInput, "log" | "repo">,
	run: ActiveRun,
	output: string | null,
): Extract<RunPhase, { kind: "reporting" }> | null {
	const inputs = run.inputs;
	const fields = { issue: run.issue, runId: run.runId, attempt: run.attempt };

	if (output === null || inputs === null) {
		input.log("specify_malformed", { ...fields, reason: "no_output" });

		return null;
	}

	const parsed = parseSpecifyOutput(output, inputs.files);
	const repo = input.repo;

	if (parsed.kind === "questions") {
		run.clearNeedsInfo = false;
		const digest = questionsDigestOf(parsed.questions);

		const body = renderQuestions({
			repo,
			sha: run.workflowSha,
			runId: run.runId,
			questions: parsed.questions,
			digest,
		});

		if (body !== null) {
			return {
				kind: "reporting",
				status: "needs_info",
				effects: {
					kind: "questions",
					questions: parsed.questions,
					digest,
					body,
					stored: false,
					posted: false,
					labeled: false,
					unlabeled: false,
					labelTick: 0,
				},
			};
		}
	}

	if (parsed.kind === "contract") {
		const contract: Contract = {
			version: CONTRACT_VERSION,
			runId: run.runId,
			issue: run.issue,
			base: { repo, sha: run.workflowSha },
			snapshot: {
				digest: run.snapshotDigest,
				source: inputs.source,
				eventId: run.eventId,
				eventAt: run.eventAt,
			},
			link: inputs.link,
			...parsed.draft,
		};

		const bytes = contractBytes(contract);
		const digest = contractDigestOf(bytes);

		const body = renderSummary({
			runId: run.runId,
			contract: parsed.draft,
			digest,
		});

		if (body !== null) {
			return {
				kind: "reporting",
				status: "stage_passed",
				effects: {
					kind: "contract",
					contract,
					bytes,
					digest,
					body,
					stored: false,
					posted: false,
				},
			};
		}
	}

	input.log("specify_malformed", {
		...fields,
		reason: parsed.kind === "malformed" ? parsed.reason : "too_large_to_post",
	});

	return null;
}

export function accepted(
	input: Pick<OrchestratorInput, "log">,
	config: WorkflowConfig | null,
	run: ActiveRun,
	output: string | null,
	model?: string,
	observed?: string | null,
	family?: FamilyInput,
): Extract<RunPhase, { kind: "reporting" }> | null {
	const bound = run.inputs?.contract;

	if (bound === undefined || output === null) return null;
	const parsed = writeAcceptance(output, bound.contract);

	if (parsed.kind === "malformed") {
		input.log("acceptance_malformed", {
			runId: run.runId,
			reason: parsed.reason,
		});

		return null;
	}

	return {
		kind: "reporting",
		status: "stage_passed",
		effects: {
			kind: "acceptance",
			contract: bound.contract,
			contractDigest: bound.digest,
			suite: parsed.suite,
			model: model ?? config?.stages.accept.model ?? "openai/unknown",
			observed: observed ?? null,
			family,
		},
	};
}
