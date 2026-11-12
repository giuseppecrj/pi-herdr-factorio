import type { Digest } from "../core/run.ts";
import type { ModelStage, Stage } from "../core/stages.ts";
import type { GhCause } from "../github/exec.ts";
import { type RepoSlug, isRepoSlug } from "../trust/platform.ts";

export type ScorerConfig = {
	readonly id: string;
	readonly prompt: string;
	readonly labels: Readonly<Record<string, number>>;
	readonly passingScore: number;
	readonly samplingRate: number;
	readonly includeChildren: boolean;
};

// Exact, authorized OpenAI IDs, not aliases such as latest or arbitrary gateway models.
export const GRADER_MODELS = [
	"openai/gpt-6.1-sol",
	"openai/gpt-6.1-terra",
] as const;

export function isPinnedGrader(model: string): model is ModelId {
	return GRADER_MODELS.some((known) => known === model);
}

export const CADENCE_JOBS = [
	"architecture",
	"security",
	"instructions",
	"hygiene",
	"reflect",
] as const;

export type CadenceJob = (typeof CADENCE_JOBS)[number];

export type CadenceJobSettings = {
	readonly dayUtc: number;
	readonly hourUtc: number;
	readonly minuteUtc: number;
	readonly model: ModelId;
	readonly maxTokens: number;
	readonly budget: StageBudget;
};

export type CadenceConfig = {
	readonly weeklyTokenCap: number;
	readonly jobs: Readonly<Record<CadenceJob, CadenceJobSettings>>;
};

export const WORKFLOW_PATH = ".github/factory/WORKFLOW.md";

export const TRUSTED_REF = "main";

export const DEFAULT_MODEL = "openai/gpt-6.1-sol";

export type GitSha = string & { readonly __brand: "GitSha" };

export type ModelId = string & { readonly __brand: "ModelId" };

export type StageBudget = {
	readonly maxTurns: number;
	readonly wallMs: number;
	readonly stallMs: number;
};

export type ModelStageSettings = {
	readonly model: ModelId;
	readonly fallbackModel: ModelId | null;
	readonly budget: StageBudget;
};

/**
 * Review's settings. `model` serves the security, simplify and ultrareview
 * seats; `fallbackModel` is the security seat's refusal retry only.
 * `codeReviewModel` is `stages.review.seats.code-review.model`, and `null`
 * means code-review inherits `model`.
 */
export type ReviewStageSettings = ModelStageSettings & {
	readonly codeReviewModel: ModelId | null;
};

export const ACCEPT_EFFORTS = ["low", "medium", "high"] as const;

export type AcceptEffort = (typeof ACCEPT_EFFORTS)[number];

export type AcceptStageSettings = ModelStageSettings & {
	readonly reasoningEffort: AcceptEffort;
};

export type StageSettings = {
	readonly [S in Stage]: S extends "review"
		? ReviewStageSettings
		: S extends "accept"
			? AcceptStageSettings
			: S extends ModelStage
				? ModelStageSettings
				: { readonly budget: StageBudget };
};

/**
 * The GitHub users handoff asks to review a ready PR. It is written in
 * WORKFLOW.md and never derived from the repository owner. A workflow
 * without `handoff` parses to `null`, and handoff then requests nobody.
 */
export type HandoffSettings = {
	readonly reviewers: readonly [string, ...string[]];
};

export type WorkflowConfig = {
	readonly repository: RepoSlug;
	readonly polling: { readonly intervalMs: number };
	readonly agent: { readonly maxConcurrent: number };
	readonly workspace: {
		readonly expandedRoot: string;
		readonly rootAsWritten: string;
	};
	readonly retry: {
		readonly maxAttempts: number;
		readonly maxBackoffMs: number;
	};
	readonly usage: { readonly maxTokensPerRun: number };
	readonly attention?: {
		readonly waitingMs: number;
		readonly blockedMs: number;
	};
	readonly replay?: { readonly maxTokens: number } | null;
	readonly cadence?: CadenceConfig | null;
	readonly trigger?: { readonly k: number; readonly d: number } | null;
	readonly scorers?: readonly ScorerConfig[];
	readonly grader?: {
		readonly model: ModelId;
		readonly maxTokens: number;
	} | null;
	readonly stages: StageSettings;
	readonly checkpoints: { readonly approveMerge: { readonly mode: "always" } };
	readonly handoff?: HandoffSettings | null;
};

export type Guidance = {
	readonly general: string;
	readonly stages: Readonly<Partial<Record<Stage, string>>>;
};

export type WorkflowSnapshot = {
	readonly repo: RepoSlug;
	readonly ref: string;
	readonly sha: GitSha;
	readonly digest: Digest;
	readonly config: WorkflowConfig;
	readonly guidance: Guidance;
	readonly warnings: readonly string[];
};

export type WorkflowError =
	| {
			readonly kind: "source_unavailable";
			readonly cause: GhCause;
			readonly status: number | null;
			readonly message: string;
	  }
	| {
			readonly kind: "missing_workflow_file";
			readonly cause: GhCause;
			readonly status: number | null;
			readonly message: string;
	  }
	| {
			readonly kind: "workflow_parse_error";
			readonly code: string;
			readonly line: number;
			readonly column: number;
			readonly message: string;
	  }
	| { readonly kind: "workflow_front_matter_missing"; readonly message: string }
	| {
			readonly kind: "workflow_front_matter_not_a_map";
			readonly message: string;
	  }
	| {
			readonly kind: "workflow_validation_error";
			readonly field: string;
			readonly message: string;
	  };

export type WorkflowLoad =
	| { readonly kind: "loaded"; readonly snapshot: WorkflowSnapshot }
	| {
			readonly kind: "failed";
			readonly repo: RepoSlug;
			readonly ref: string;
			readonly sha: GitSha | null;
			readonly digest: Digest | null;
			readonly error: WorkflowError;
	  };

export type Reload =
	| { readonly kind: "applied"; readonly snapshot: WorkflowSnapshot }
	| {
			readonly kind: "kept";
			readonly snapshot: WorkflowSnapshot;
			readonly error: WorkflowError;
	  }
	| { readonly kind: "unavailable"; readonly error: WorkflowError };

export type EnvLookup = (name: string) => string | undefined;

export const DEFAULTS = {
	pollIntervalMs: 30_000,
	maxConcurrent: 2,
	workspaceRoot: "~/factory-workspaces",
	maxTurns: 20,
	wallMs: 1_800_000,
	stallMs: 300_000,
	maxAttempts: 3,
	maxBackoffMs: 300_000,
	maxTokensPerRun: 500_000,
} as const;

/**
 * Time a sandboxed stage keeps back from `wall_ms` for cleanup. Its hard
 * deadline is `wall_ms` minus this, so a model stage's `wall_ms` must be
 * larger.
 */
export const STAGE_CLEANUP_RESERVE_MS = 10_000;

export const LIMITS = {
	minPollIntervalMs: 10_000,
	maxConcurrent: 4,
} as const;

const GIT_SHA = /^[0-9a-f]{40}$/;

const BRANCH_NAME = /^(?!-)(?!.*\.\.)(?!.*\/\/)(?!\/)[A-Za-z0-9._/-]+(?<!\/)$/;

const MODEL_ID = /^([a-z0-9][a-z0-9-]*)\/([A-Za-z0-9][A-Za-z0-9._:-]*)$/;

export const ENV_REFERENCE = /^\$([A-Za-z_][A-Za-z0-9_]*)$/;

const SCP_REMOTE = /^git@github\.com:([A-Za-z0-9_.-]+)\/([A-Za-z0-9_.-]+)$/;

const HTTPS_REMOTE =
	/^https:\/\/(?:[^\s/?#\\@]*@)?github\.com\/([A-Za-z0-9_.-]+)\/([A-Za-z0-9_.-]+)$/;

export const UNKNOWN_KEY = "(unknown key)";

const URL_USERINFO = /([a-z][a-z0-9+.-]*:\/\/)[^\s/?#]*@/gi;

const CREDENTIAL_QUERY =
	/([?&](?:access_token|token|auth|key|password|secret|signature|sig|code)=)[^&#\s]*/gi;

/**
 * Replaces the userinfo of every `scheme://user:secret@host` in `text` and
 * the value of every credential-named query parameter.
 */
export function redactCredentials(text: string): string {
	return text
		.replace(URL_USERINFO, "$1<redacted>@")
		.replace(CREDENTIAL_QUERY, "$1<redacted>");
}

export function isGitSha(input: string): input is GitSha {
	return GIT_SHA.test(input);
}

export function isBranchName(input: string): boolean {
	return BRANCH_NAME.test(input);
}

export function isModelId(input: string): input is ModelId {
	return MODEL_ID.test(input);
}

function repoSlugOf(owner: string, name: string): RepoSlug | null {
	const repo = name.endsWith(".git") ? name.slice(0, -4) : name;

	if ([owner, repo].some((segment) => segment === "." || segment === "..")) {
		return null;
	}

	const slug = `${owner}/${repo}`;

	return isRepoSlug(slug) ? slug : null;
}

/**
 * Accepts `https://github.com/<owner>/<repo>[.git]`, with optional userinfo,
 * and `git@github.com:<owner>/<repo>[.git]`. Everything else is null.
 */
export function githubRepoFromRemote(remote: string): RepoSlug | null {
	const text = remote.trim();
	const scp = SCP_REMOTE.exec(text);

	if (scp !== null) return repoSlugOf(scp[1] ?? "", scp[2] ?? "");

	const https = HTTPS_REMOTE.exec(text);

	if (https === null) return null;

	let url: URL;

	try {
		url = new URL(text);
	} catch {
		return null;
	}

	if (
		url.protocol !== "https:" ||
		url.hostname !== "github.com" ||
		url.port !== "" ||
		url.search !== "" ||
		url.hash !== ""
	) {
		return null;
	}

	return repoSlugOf(https[1] ?? "", https[2] ?? "");
}

export type ParsedWorkflow =
	| {
			readonly kind: "valid";
			readonly config: WorkflowConfig;
			readonly guidance: Guidance;
			readonly warnings: readonly string[];
	  }
	| { readonly kind: "invalid"; readonly error: WorkflowError };

export function redactError(error: WorkflowError): WorkflowError {
	const message = redactCredentials(error.message);

	return error.kind === "workflow_validation_error"
		? { ...error, field: redactCredentials(error.field), message }
		: { ...error, message };
}

/**
 * A run's pinned WORKFLOW.md. `unavailable` is a failed read that a later read
 * may clear. `integrity` is permanent: the pinned bytes differ from the
 * recorded digest, or they no longer parse. Neither carries file text.
 */
export type PinnedWorkflowLoad =
	| { readonly kind: "loaded"; readonly config: WorkflowConfig }
	| {
			readonly kind: "unavailable";
			readonly reason: "read_rejected" | "read_failed";
			readonly cause: GhCause;
			readonly status: number | null;
	  }
	| {
			readonly kind: "integrity";
			readonly reason: "digest_mismatch" | "workflow_invalid";
			readonly error: WorkflowError["kind"] | null;
	  };
