import { type GitSha, redactCredentials } from "../config/schema.ts";
import type { FamilyInput } from "../core/models.ts";
import { type Digest, isDigest } from "../core/run.ts";
import type { RepoSlug } from "../trust/platform.ts";
import {
	type Cite,
	COMMENT_MAX_BYTES,
	type ContractDigest,
	type ContractDraft,
	isContractDigest,
	isQuestionsDigest,
	type Question,
	type QuestionsDigest,
} from "./contract.ts";

const MARKDOWN_META = /[\\`*_{}[\]()+\-.!|<>~&:=]/g;

const INVISIBLE = /\p{Cf}|\u034f|\u115f|\u2800|\u3164/gu;

const BARE_CREDENTIAL =
	/(?<![A-Za-z0-9])(?:gh[pousr]_[A-Za-z0-9]{36,}|github_pat_[A-Za-z0-9_]{20,}|sk-(?:proj|svcacct|admin|ant(?:-api\d+)?)-[A-Za-z0-9_-]{20,}|sk-(?:[A-Za-z][A-Za-z0-9]*-)*(?=[A-Za-z0-9_-]*[A-Za-z0-9]{20})[A-Za-z0-9_-]{20,}|xai-[A-Za-z0-9]{20,}|AKIA[0-9A-Z]{16})(?![A-Za-z0-9])/g;

export function inert(text: string): string {
	return redactCredentials(text.replace(INVISIBLE, ""))
		.replace(BARE_CREDENTIAL, "[REDACTED]")
		.replace(/\bGH-(?=\d)/gi, (prefix) => `${prefix.slice(0, 2)}－`)
		.replaceAll("#", "＃")
		.replace(
			/\b(?:(?:https?:\/\/)?(?:www\.)?github\.com\/)?[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+\/(?:issues|pull|discussions)\/\d+\b/gi,
			(reference) => reference.replaceAll("/", "／"),
		)
		.replace(MARKDOWN_META, (char) => `\\${char}`)
		.replaceAll("@", "\uff20");
}

function permalink(repo: RepoSlug, sha: GitSha, cite: Cite): string {
	const lines =
		cite.start === cite.end ? `L${cite.start}` : `L${cite.start}-L${cite.end}`;

	return `https://github.com/${repo}/blob/${sha}/${cite.path}#${lines}`;
}

function citeLink(repo: RepoSlug, sha: GitSha, cite: Cite): string {
	const label =
		cite.start === cite.end
			? `${cite.path}:${cite.start}`
			: `${cite.path}:${cite.start}-${cite.end}`;

	return `[${inert(label)}](${permalink(repo, sha, cite)})`;
}

const QUESTIONS_KEY =
	/^<!-- factory-questions run=([0-9a-f]{64}) q=([0-9a-f]{64}) -->$/;

const CONTRACT_KEY =
	/^<!-- factory-contract run=([0-9a-f]{64}) c=([0-9a-f]{64}) -->$/;

const COMMENT_KEY_PREFIX = "<!-- factory-";

export function questionsKey(runId: Digest, digest: QuestionsDigest): string {
	return `${COMMENT_KEY_PREFIX}questions run=${runId} q=${digest} -->`;
}

export function contractKey(runId: Digest, digest: ContractDigest): string {
	return `${COMMENT_KEY_PREFIX}contract run=${runId} c=${digest} -->`;
}

function lastLine(body: string): string {
	return body.trimEnd().split("\n").at(-1) ?? "";
}

export function questionsKeyOf(
	body: string,
): { readonly runId: Digest; readonly digest: QuestionsDigest } | null {
	const match = QUESTIONS_KEY.exec(lastLine(body));
	const runId = match?.[1] ?? "";
	const digest = match?.[2] ?? "";

	return isDigest(runId) && isQuestionsDigest(digest)
		? { runId, digest }
		: null;
}

export function contractKeyOf(
	body: string,
): { readonly runId: Digest; readonly digest: ContractDigest } | null {
	const match = CONTRACT_KEY.exec(lastLine(body));
	const runId = match?.[1] ?? "";
	const digest = match?.[2] ?? "";

	return isDigest(runId) && isContractDigest(digest) ? { runId, digest } : null;
}

export function withoutKey(body: string): string {
	const lines = body.trimEnd().split("\n");

	return QUESTIONS_KEY.test(lines.at(-1) ?? "")
		? lines.slice(0, -1).join("\n").trimEnd()
		: body.trimEnd();
}

export function acceptanceKey(runId: Digest, digest: Digest): string {
	return `${COMMENT_KEY_PREFIX}acceptance run=${runId} a=${digest} -->`;
}

/**
 * The isolation line of the pre-build acceptance comment. Without stored
 * evidence it keeps the legacy wording. With it, it names the author the
 * host recorded and its fresh context; for an Anthropic or unknown author
 * it leaves the family claim to certification, because no builder has run.
 */
function isolationLine(author: FamilyInput | undefined): string {
	if (author === undefined)
		return "Isolation: context-isolated, same family, not cross-family. The design's cross-family requirement remains unmet.";

	switch (author.kind) {
		case "openai-request":
			return `Isolation: context-isolated, same family, not cross-family. Author: ${inert(author.model)}, requested on the OpenAI route. The design's cross-family requirement remains unmet.`;
		case "anthropic-gateway":
			return `Isolation: context-isolated, fresh context. Author: ${inert(author.model)}, an Anthropic model the gateway observed. Independence from the builder's family is decided at certification, after build and review.`;
		case "unavailable":
			return `Isolation: context-isolated, fresh context. Author: not observed (${author.reason}). Its family is unknown, and certification cannot count it as independent of the builder.`;
		default: {
			const exhaustive: never = author;

			return exhaustive;
		}
	}
}

export function renderAcceptanceSummary(input: {
	readonly runId: Digest;
	readonly digest: Digest;
	readonly scenarios: readonly {
		readonly id: string;
		readonly criteria: readonly string[];
	}[];
	/** The accept author's stored family evidence, when the receipt has one. */
	readonly author?: FamilyInput;
}): string | null {
	return bounded(
		[
			`The factory stored held-out acceptance scenarios. Run \`${input.runId.slice(0, 12)}\`, suite \`${input.digest.slice(0, 12)}\`.`,
			"",
			...input.scenarios.map(
				(s) => `- ${inert(s.id)}: ${s.criteria.map(inert).join(", ")}`,
			),
			"",
			isolationLine(input.author),
			"Test code stays private on the factory host. Do not edit this comment.",
			"",
			acceptanceKey(input.runId, input.digest),
			"",
		].join("\n"),
	);
}

export function buildKey(runId: Digest, digest: Digest): string {
	return `${COMMENT_KEY_PREFIX}build run=${runId} p=${digest} -->`;
}

export function renderBuildSummary(input: {
	readonly runId: Digest;
	readonly receipt: {
		readonly patchDigest: Digest;
		readonly changedPaths: readonly string[];
		readonly policy: "clean" | "forbidden";
		readonly visibleTests: { readonly exitCode: number | null } | null;
		readonly scriptsChanged?: boolean;
		readonly testScriptChanged?: boolean;
		readonly testInputsChanged?: boolean;
		readonly testCommand?: string;
	};
}): string | null {
	const { receipt } = input;
	const paths: string[] = [];
	let bytes = 0;

	for (const path of receipt.changedPaths) {
		const line = `- ${inert(path)}`;

		if (bytes + Buffer.byteLength(line) > 4096) break;
		paths.push(line);
		bytes += Buffer.byteLength(line) + 1;
	}

	if (paths.length < receipt.changedPaths.length)
		paths.push(
			`- and ${receipt.changedPaths.length - paths.length} more paths (private receipt has the full list)`,
		);

	return bounded(
		[
			`The factory collected a private patch. Run \`${input.runId.slice(0, 12)}\`, patch \`${receipt.patchDigest.slice(0, 12)}\`.`,
			"",
			...paths,
			"",
			`Visible tests: ${receipt.visibleTests === null ? "not run" : receipt.visibleTests.exitCode === null ? "could not run" : receipt.visibleTests.exitCode === 0 ? "passed" : "failed"}.`,
			`Trusted base command: ${inert((receipt.testCommand ?? "npm test").slice(0, 300))}.`,
			receipt.testScriptChanged
				? "The patch changed its own test script; the trusted base script was used."
				: receipt.scriptsChanged
					? "The patch changed package.json scripts; trusted base scripts were used."
					: "The patch did not change package.json scripts.",
			receipt.testInputsChanged
				? "The patch changed test inputs. Deleted base test files were restored; modified and added tests are candidate input."
				: "Base test inputs were retained.",
			"Builder command receipts are builder-reported, not controller validation.",
			receipt.policy === "forbidden"
				? "Forbidden paths. Patch kept privately for the owner; no publication."
				: "Patch and command output stay private. No CI verdict or publication was produced.",
			"",
			buildKey(input.runId, receipt.patchDigest),
			"",
		].join("\n"),
	);
}

function bounded(body: string): string | null {
	return Buffer.byteLength(body, "utf8") <= COMMENT_MAX_BYTES ? body : null;
}

export function renderQuestions(input: {
	readonly repo: RepoSlug;
	readonly sha: GitSha;
	readonly runId: Digest;
	readonly questions: readonly Question[];
	readonly digest: QuestionsDigest;
}): string | null {
	const items = input.questions.map((question, index) => {
		const cites = question.cites.map((cite) =>
			citeLink(input.repo, input.sha, cite),
		);

		return `${index + 1}. ${inert(question.text)}${cites.length === 0 ? "" : ` (${cites.join(", ")})`}`;
	});

	return bounded(
		[
			`The factory needs answers before it can specify this issue. Run \`${input.runId.slice(0, 12)}\`.`,
			"",
			...items,
			"",
			"Answer in a comment or edit the issue body, then add the `factory:ready` label again. Do not edit this comment: the factory reads it back.",
			"",
			questionsKey(input.runId, input.digest),
			"",
		].join("\n"),
	);
}

export function renderSummary(input: {
	readonly runId: Digest;
	readonly contract: ContractDraft;
	readonly digest: ContractDigest;
}): string | null {
	const { contract } = input;

	const bullets = (items: readonly string[]) =>
		items.length === 0 ? ["- none"] : items.map((item) => `- ${inert(item)}`);

	return bounded(
		[
			`The factory specified this issue. Run \`${input.runId.slice(0, 12)}\`, contract \`${input.digest.slice(0, 12)}\`.`,
			"",
			inert(contract.summary),
			"",
			"Behavior:",
			...bullets(contract.behavior),
			"",
			"Out of scope:",
			...bullets(contract.exclusions),
			"",
			"Acceptance criteria:",
			...contract.acceptance.map(
				(criterion) => `- ${criterion.id}: ${inert(criterion.text)}`,
			),
			"",
			"The full contract stays on the factory host. Do not edit this comment.",
			"",
			contractKey(input.runId, input.digest),
			"",
		].join("\n"),
	);
}
