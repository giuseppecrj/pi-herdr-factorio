import { type Digest, digestOf } from "../core/run.ts";
import {
	type Exec,
	type ExecResult,
	type GhCause,
	type GhFailure,
	ghFailure,
} from "../github/exec.ts";
import type { PlatformProfile, RepoSlug } from "../trust/platform.ts";
import { parseWorkflow } from "./parse.ts";
import {
	type EnvLookup,
	type GitSha,
	isBranchName,
	isGitSha,
	type PinnedWorkflowLoad,
	redactError,
	type Reload,
	TRUSTED_REF,
	WORKFLOW_PATH,
	type WorkflowConfig,
	type WorkflowError,
	type WorkflowLoad,
	type WorkflowSnapshot,
} from "./schema.ts";

const CAUSE_TEXT: Readonly<Record<GhCause, string>> = {
	not_found: "not found",
	auth: "not authorized",
	network: "network error",
	other: "gh failed",
};

function ghMessage(prefix: string, failure: GhFailure): string {
	const status = failure.status === null ? "" : ` (HTTP ${failure.status})`;

	return `${prefix}: ${CAUSE_TEXT[failure.cause]}${status}`;
}

const GH_REJECTED = {
	kind: "source_unavailable",
	cause: "other",
	status: null,
	message: "cannot run gh",
} as const satisfies WorkflowError;

type GhResult = ExecResult | { readonly rejected: true };

async function runGh(exec: Exec, args: readonly string[]): Promise<GhResult> {
	try {
		return await exec("gh", args);
	} catch {
		return { rejected: true };
	}
}

const trustedConfigs = new Map<RepoSlug, WorkflowConfig>();

/** Reuse the main configuration already loaded by admission; never fetch for an idle trigger. */
export function trustedWorkflowConfig(
	repo: RepoSlug,
): WorkflowConfig | undefined {
	return trustedConfigs.get(repo);
}

/**
 * Loads WORKFLOW.md from `ref` of `repo` on GitHub: resolve the branch to a
 * SHA, then fetch the file at that SHA. It never reads a local checkout.
 */
export async function loadWorkflow(input: {
	exec: Exec;
	repo: RepoSlug;
	ref: string;
	env: EnvLookup;
	platform: PlatformProfile;
}): Promise<WorkflowLoad> {
	const { exec, repo, ref } = input;

	const failed = (
		sha: GitSha | null,
		digest: Digest | null,
		error: WorkflowError,
	): WorkflowLoad =>
		Object.freeze({
			kind: "failed",
			repo,
			ref,
			sha,
			digest,
			error: redactError(error),
		});

	if (!isBranchName(ref)) {
		return failed(null, null, {
			kind: "source_unavailable",
			cause: "other",
			status: null,
			message: "the ref is not a branch name",
		});
	}

	const resolved = await runGh(exec, [
		"api",
		`repos/${repo}/git/ref/heads/${ref}`,
		"--jq",
		".object.sha",
	]);

	if ("rejected" in resolved) return failed(null, null, GH_REJECTED);

	if (resolved.code !== 0) {
		const failure = ghFailure(resolved);

		return failed(null, null, {
			kind: "source_unavailable",
			...failure,
			message: ghMessage("cannot resolve the branch", failure),
		});
	}

	const sha = resolved.stdout.trim();

	if (!isGitSha(sha)) {
		return failed(null, null, {
			kind: "source_unavailable",
			cause: "other",
			status: null,
			message: "cannot resolve the branch: gh returned no SHA",
		});
	}

	const fetched = await runGh(exec, [
		"api",
		"-H",
		"Accept: application/vnd.github.raw",
		`repos/${repo}/contents/${WORKFLOW_PATH}?ref=${sha}`,
	]);

	if ("rejected" in fetched) return failed(sha, null, GH_REJECTED);

	if (fetched.code !== 0) {
		const failure = ghFailure(fetched);

		return failed(sha, null, {
			kind: "missing_workflow_file",
			...failure,
			message: ghMessage(`cannot fetch ${WORKFLOW_PATH}`, failure),
		});
	}

	const digest = digestOf(fetched.stdout);

	const parsed = parseWorkflow({
		text: fetched.stdout,
		repo,
		env: input.env,
		platform: input.platform,
	});

	if (parsed.kind === "invalid") return failed(sha, digest, parsed.error);

	const snapshot: WorkflowSnapshot = Object.freeze({
		repo,
		ref,
		sha,
		digest,
		config: parsed.config,
		guidance: parsed.guidance,
		warnings: parsed.warnings,
	});

	if (ref === TRUSTED_REF) trustedConfigs.set(repo, snapshot.config);

	return Object.freeze({ kind: "loaded", snapshot });
}

/**
 * WORKFLOW.md at a run's pinned commit, parsed only when its bytes match the
 * digest the run recorded. Anything else is a typed failure, so a caller
 * fails closed and never mistakes it for a workflow without a setting.
 */
export async function loadPinnedWorkflow(input: {
	exec: Exec;
	repo: RepoSlug;
	sha: GitSha;
	digest: Digest;
	env: EnvLookup;
	platform: PlatformProfile;
}): Promise<PinnedWorkflowLoad> {
	const fetched = await runGh(input.exec, [
		"api",
		"-H",
		"Accept: application/vnd.github.raw",
		`repos/${input.repo}/contents/${WORKFLOW_PATH}?ref=${input.sha}`,
	]);

	if ("rejected" in fetched)
		return {
			kind: "unavailable",
			reason: "read_rejected",
			cause: "other",
			status: null,
		};

	if (fetched.code !== 0)
		return {
			kind: "unavailable",
			reason: "read_failed",
			...ghFailure(fetched),
		};

	if (digestOf(fetched.stdout) !== input.digest)
		return { kind: "integrity", reason: "digest_mismatch", error: null };

	const parsed = parseWorkflow({
		text: fetched.stdout,
		repo: input.repo,
		env: input.env,
		platform: input.platform,
	});

	return parsed.kind === "valid"
		? { kind: "loaded", config: parsed.config }
		: {
				kind: "integrity",
				reason: "workflow_invalid",
				error: parsed.error.kind,
			};
}

/** An invalid reload keeps the last valid snapshot in force. */
export function reloadWorkflow(
	current: WorkflowSnapshot | null,
	next: WorkflowLoad,
): Reload {
	if (next.kind === "loaded") {
		return { kind: "applied", snapshot: next.snapshot };
	}

	if (current === null) return { kind: "unavailable", error: next.error };

	return { kind: "kept", snapshot: current, error: next.error };
}
