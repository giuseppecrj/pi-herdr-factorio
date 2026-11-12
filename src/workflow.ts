import { isAbsolute, normalize } from "node:path/posix";
import { getDefaults, Lexer } from "marked";
import {
	CST,
	isMap,
	isScalar,
	isSeq,
	LineCounter,
	type ParsedNode,
	Parser,
	parseDocument,
	type YAMLError,
} from "yaml";
import {
	type Exec,
	type ExecResult,
	type GhCause,
	type GhFailure,
	ghFailure,
} from "./github/exec.ts";
import { parseAnthropicModel } from "./core/models.ts";
import {
	isRepoSlug,
	type ModelPosition,
	type PlatformProfile,
	type RepoSlug,
} from "./trust/platform.ts";
import { type Digest, digestOf } from "./core/run.ts";
import {
	STAGE_ORDER,
	isStage,
	type ModelStage,
	type Stage,
} from "./core/stages.ts";

export { isRepoSlug, type RepoSlug };

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

export type { Exec, ExecResult, GhCause } from "./github/exec.ts";

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
const ENV_REFERENCE = /^\$([A-Za-z_][A-Za-z0-9_]*)$/;

const SCP_REMOTE = /^git@github\.com:([A-Za-z0-9_.-]+)\/([A-Za-z0-9_.-]+)$/;

const HTTPS_REMOTE =
	/^https:\/\/(?:[^\s/?#\\@]*@)?github\.com\/([A-Za-z0-9_.-]+)\/([A-Za-z0-9_.-]+)$/;

const UNKNOWN_KEY = "(unknown key)";

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

function isModelId(input: string): input is ModelId {
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

class InvalidWorkflow extends Error {
	readonly field: string;

	constructor(field: string, message: string) {
		super(message);
		this.field = field;
	}
}

function fail(field: string, message: string): never {
	throw new InvalidWorkflow(field, message);
}

type YamlNode = ParsedNode | null;

function entriesOf(node: YamlNode, field: string): Map<string, YamlNode> {
	if (!isMap(node)) fail(field, "must be a map");

	const entries = new Map<string, YamlNode>();

	for (const pair of node.items) {
		if (!isScalar(pair.key)) fail(field, "keys must be plain strings");

		entries.set(String(pair.key.value), pair.value);
	}

	return entries;
}

function optionalEntries(
	parent: Map<string, YamlNode>,
	key: string,
	field: string,
	allowed: readonly string[],
): Map<string, YamlNode> {
	if (!parent.has(key)) return new Map();

	const entries = entriesOf(parent.get(key) ?? null, field);

	for (const name of entries.keys()) {
		rejectCommandKey(name, `${field}.${UNKNOWN_KEY}`);

		if (!allowed.includes(name)) fail(`${field}.${UNKNOWN_KEY}`, "unknown key");
	}

	return entries;
}

function scalarText(node: YamlNode, field: string): string {
	if (!isScalar(node)) fail(field, "must be a single value");

	// The failsafe schema resolves every scalar to a string.
	return String(node.value);
}

function readString(node: YamlNode, field: string): string {
	const text = scalarText(node, field);

	if (text.startsWith("$")) {
		fail(field, "environment references are allowed only in workspace.root");
	}

	if (text.trim() === "") fail(field, "must not be empty");

	return text;
}

type IntegerRange = { min: number; max?: number };

function integerRule(range: IntegerRange): string {
	if (range.max !== undefined) {
		return `must be an integer from ${range.min} to ${range.max}`;
	}

	return range.min === 1
		? "must be a positive integer"
		: `must be an integer of at least ${range.min}`;
}

function readInteger(
	node: YamlNode,
	field: string,
	range: IntegerRange,
): number {
	const text = readString(node, field);

	if (!/^[+-]?[0-9]+$/.test(text)) fail(field, integerRule(range));

	const value = Number(text);

	if (!Number.isSafeInteger(value)) {
		fail(field, `must be an integer no larger than ${Number.MAX_SAFE_INTEGER}`);
	}

	if (value < range.min || (range.max !== undefined && value > range.max)) {
		fail(field, integerRule(range));
	}

	return value;
}

function integerOr(
	entries: Map<string, YamlNode>,
	key: string,
	field: string,
	range: { min: number; max?: number; fallback: number },
): number {
	return entries.has(key)
		? readInteger(entries.get(key) ?? null, field, range)
		: range.fallback;
}

/** What the workflow parser reads from the platform: Anthropic positions and whether xAI has a route. */
type ModelPlatform = Pick<
	PlatformProfile,
	"name" | "anthropicStages" | "modelBasePaths"
>;

const POSITION_FIELDS: Readonly<Record<ModelPosition, string>> = {
	specify: "stages.specify.model",
	accept: "stages.accept.model",
	build: "stages.build.model",
	validate: "stages.validate.model",
	review: "stages.review.model",
	"code-review": "stages.review.seats.code-review.model",
	cadence: "cadence.jobs.<job>.model",
};

function anthropicRule(platform: ModelPlatform): string {
	const list = new Intl.ListFormat("en", { type: "conjunction" }).format(
		platform.anthropicStages.map((position) => POSITION_FIELDS[position]),
	);

	switch (platform.name) {
		case "exe-dev":
			return `provider anthropic is allowed only for ${list}: on the VM it spends exe.dev credits`;
		case "exmach":
			return `provider anthropic is allowed only for ${list} on the exmach platform`;
		default: {
			const _exhaustive: never = platform.name;

			return _exhaustive;
		}
	}
}

/** A `<provider>/<model>` id. Callers decide which providers a field allows. */
function readModelText(node: YamlNode, field: string): ModelId {
	const text = readString(node, field);

	if (!isModelId(text)) fail(field, "must be <provider>/<model>");

	return text;
}

/** A model id whose provider is not anthropic. */
function readModel(
	node: YamlNode,
	field: string,
	platform: ModelPlatform,
): ModelId {
	const text = readModelText(node, field);

	if (text.startsWith("anthropic/")) fail(field, anthropicRule(platform));

	return text;
}

/**
 * A primary model at `position`: an `openai/` model, or, where the platform
 * allows Anthropic at that position, an `anthropic/` model in the host's
 * limits table.
 */
function readPrimaryModel(
	node: YamlNode,
	field: string,
	position: ModelPosition,
	platform: ModelPlatform,
): ModelId {
	const text = readModelText(node, field);
	const anthropic = platform.anthropicStages.includes(position);

	if (text.startsWith("anthropic/")) {
		if (!anthropic) fail(field, anthropicRule(platform));

		if (parseAnthropicModel(text) === null)
			fail(
				field,
				"names an anthropic model outside the limits table (src/core/models.ts)",
			);

		return text;
	}

	if (!text.startsWith("openai/"))
		fail(
			field,
			anthropic
				? "must be an openai or a listed anthropic model"
				: "must be an openai model: the sandbox serves a stage's model only on its openai route",
		);

	return text;
}

function readWorkspaceRoot(
	entries: Map<string, YamlNode>,
	env: EnvLookup,
): WorkflowConfig["workspace"] {
	const field = "workspace.root";

	const source = entries.has("root")
		? scalarText(entries.get("root") ?? null, field)
		: DEFAULTS.workspaceRoot;

	let path = source;

	if (source.startsWith("$")) {
		const name = ENV_REFERENCE.exec(source)?.[1];

		if (name === undefined) {
			fail(field, "must be exactly $VAR_NAME to use the environment");
		}

		const value = env(name);

		if (value === undefined || value === "") {
			fail(field, "names an environment variable that is not set");
		}

		path = value;
	}

	if (path === "~" || path.startsWith("~/")) {
		const home = env("HOME");

		if (home === undefined || home === "") {
			fail(field, "uses ~ but HOME is not set");
		}

		path = `${home}${path.slice(1)}`;
	}

	if (!isAbsolute(path)) fail(field, "must resolve to an absolute path");

	return Object.freeze({
		expandedRoot: normalize(path),
		rootAsWritten: source,
	});
}

const BUDGET_KEYS = ["max_turns", "wall_ms", "stall_ms"];

const MODEL_KEYS = ["model", "fallback_model"];

const SEAT_KEYS = ["code-review"];

function stageEntries(
	stages: Map<string, YamlNode>,
	stage: Stage,
	allowed: readonly string[],
): Map<string, YamlNode> {
	const field = `stages.${stage}`;

	const entries = stages.has(stage)
		? entriesOf(stages.get(stage) ?? null, field)
		: new Map<string, YamlNode>();

	for (const name of entries.keys()) {
		rejectCommandKey(name, `${field}.${UNKNOWN_KEY}`);

		if (MODEL_KEYS.includes(name) && !allowed.includes(name)) {
			fail(
				`${field}.${name}`,
				`${stage} runs no model, so it takes no model key`,
			);
		}

		if (!allowed.includes(name)) fail(`${field}.${UNKNOWN_KEY}`, "unknown key");
	}

	return entries;
}

function readBudget(entries: Map<string, YamlNode>, stage: Stage): StageBudget {
	const field = `stages.${stage}`;

	return Object.freeze({
		maxTurns: integerOr(entries, "max_turns", `${field}.max_turns`, {
			min: 1,
			fallback: DEFAULTS.maxTurns,
		}),
		wallMs: integerOr(entries, "wall_ms", `${field}.wall_ms`, {
			min: 1,
			fallback: DEFAULTS.wallMs,
		}),
		stallMs: integerOr(entries, "stall_ms", `${field}.stall_ms`, {
			min: 1,
			fallback: DEFAULTS.stallMs,
		}),
	});
}

function readControllerStage(
	stages: Map<string, YamlNode>,
	stage: Exclude<Stage, ModelStage>,
): StageSettings[typeof stage] {
	const entries = stageEntries(stages, stage, BUDGET_KEYS);

	return Object.freeze({ budget: readBudget(entries, stage) });
}

function readModelStage(
	stages: Map<string, YamlNode>,
	stage: Exclude<ModelStage, "review">,
	platform: ModelPlatform,
): ModelStageSettings {
	return readStageModels(
		stageEntries(stages, stage, [...MODEL_KEYS, ...BUDGET_KEYS]),
		stage,
		platform,
	);
}

function readAcceptStage(
	stages: Map<string, YamlNode>,
	platform: ModelPlatform,
): AcceptStageSettings {
	const entries = stageEntries(stages, "accept", [
		...MODEL_KEYS,
		...BUDGET_KEYS,
		"reasoning_effort",
	]);

	const field = "stages.accept.reasoning_effort";

	const effort = entries.has("reasoning_effort")
		? readString(entries.get("reasoning_effort") ?? null, field)
		: "medium";

	if (effort !== "low" && effort !== "medium" && effort !== "high")
		fail(field, "must be low, medium or high");

	return Object.freeze({
		...readStageModels(entries, "accept", platform),
		reasoningEffort: effort,
	});
}

/**
 * Review, plus its one per-seat key, `seats.code-review.model`. Any other
 * seat or seat field fails the load. Absent, code-review inherits `model`.
 */
function readReviewStage(
	stages: Map<string, YamlNode>,
	platform: ModelPlatform,
): ReviewStageSettings {
	const entries = stageEntries(stages, "review", [
		...MODEL_KEYS,
		...BUDGET_KEYS,
		"seats",
	]);

	const seats = optionalEntries(
		entries,
		"seats",
		"stages.review.seats",
		SEAT_KEYS,
	);

	const codeReview = optionalEntries(
		seats,
		"code-review",
		"stages.review.seats.code-review",
		["model"],
	);

	const codeReviewModel = codeReview.has("model")
		? readPrimaryModel(
				codeReview.get("model") ?? null,
				"stages.review.seats.code-review.model",
				"code-review",
				platform,
			)
		: null;

	return Object.freeze({
		...readStageModels(entries, "review", platform),
		codeReviewModel,
	});
}

function readStageModels(
	entries: Map<string, YamlNode>,
	stage: ModelStage,
	platform: ModelPlatform,
): ModelStageSettings {
	const field = `stages.${stage}`;
	const modelNode = entries.get("model") ?? null;

	const model = !entries.has("model")
		? defaultModel()
		: readPrimaryModel(modelNode, `${field}.model`, stage, platform);

	const fallbackNode = entries.get("fallback_model") ?? null;

	const fallbackModel = !entries.has("fallback_model")
		? null
		: stage === "accept"
			? readAcceptFallback(fallbackNode, `${field}.fallback_model`)
			: readFallbackModel(fallbackNode, `${field}.fallback_model`, platform);

	if (fallbackModel === model)
		fail(
			`stages.${stage}.fallback_model`,
			"must differ from the primary model",
		);

	const budget = readBudget(entries, stage);

	if (budget.wallMs <= STAGE_CLEANUP_RESERVE_MS) {
		fail(
			`stages.${stage}.wall_ms`,
			`must be larger than the ${STAGE_CLEANUP_RESERVE_MS} ms cleanup reserve: the sandbox stops a stage at wall_ms minus the reserve`,
		);
	}

	return Object.freeze({ model, fallbackModel, budget });
}

/** Accept's same-family retry: only `openai/`, so an Anthropic fallback cannot pass as cross-family. */
function readAcceptFallback(node: YamlNode, field: string): ModelId {
	const model = readModelText(node, field);

	if (!model.startsWith("openai/"))
		fail(field, "must be an openai model: accept's fallback is same-family");

	return model;
}

/** An `openai/` fallback, or an `xai/` one where the platform has an xAI route. */
function readFallbackModel(
	node: YamlNode,
	field: string,
	platform: ModelPlatform,
): ModelId {
	const model = readModel(node, field, platform);
	const xai = platform.modelBasePaths.xai !== null;

	if (model.startsWith("openai/") || (xai && model.startsWith("xai/"))) {
		return model;
	}

	fail(
		field,
		xai
			? "must be an openai or xai model"
			: `must be an openai model: the ${platform.name} platform has no xai route`,
	);
}

function defaultModel(): ModelId {
	if (!isModelId(DEFAULT_MODEL)) throw new Error("DEFAULT_MODEL is malformed");

	return DEFAULT_MODEL;
}

function readValidateStage(
	stages: Map<string, YamlNode>,
	warnings: string[],
	platform: ModelPlatform,
): StageSettings["validate"] {
	const entries = stageEntries(stages, "validate", [...BUDGET_KEYS, "model"]);

	if (entries.has("model")) {
		readPrimaryModel(
			entries.get("model") ?? null,
			"stages.validate.model",
			"validate",
			platform,
		);
		warnings.push(
			"stages.validate.model is ignored; validate runs in the controller",
		);
	}

	const budget = readBudget(entries, "validate");

	return Object.freeze({
		budget: Object.freeze({
			...budget,
			wallMs: entries.has("wall_ms") ? budget.wallMs : 1_200_000,
		}),
	});
}

function readStages(
	root: Map<string, YamlNode>,
	warnings: string[],
	platform: ModelPlatform,
): StageSettings {
	const stages = optionalEntries(root, "stages", "stages", STAGE_ORDER);

	return Object.freeze({
		admit: readControllerStage(stages, "admit"),
		specify: readModelStage(stages, "specify", platform),
		accept: readAcceptStage(stages, platform),
		build: readModelStage(stages, "build", platform),
		validate: readValidateStage(stages, warnings, platform),
		review: readReviewStage(stages, platform),
		land: readControllerStage(stages, "land"),
	});
}

function readCheckpoints(
	root: Map<string, YamlNode>,
): WorkflowConfig["checkpoints"] {
	const checkpoints = optionalEntries(root, "checkpoints", "checkpoints", [
		"approve_merge",
	]);

	const merge = optionalEntries(
		checkpoints,
		"approve_merge",
		"checkpoints.approve_merge",
		["mode"],
	);

	const field = "checkpoints.approve_merge.mode";

	const mode = merge.has("mode")
		? readString(merge.get("mode") ?? null, field)
		: "always";

	if (mode === "never") {
		fail(
			field,
			"never removes the merge checkpoint: v1 stops every run at Human Review",
		);
	}

	if (mode !== "always") {
		fail(field, "is an unknown checkpoint mode: use always");
	}

	return Object.freeze({ approveMerge: Object.freeze({ mode }) });
}

/** A GitHub user login: letters, digits and single inner hyphens, at most 39. Never a bot or a team. */
const USER_LOGIN = /^[A-Za-z0-9](?:[A-Za-z0-9]|-(?=[A-Za-z0-9])){0,38}$/;

function readHandoff(root: Map<string, YamlNode>): HandoffSettings | null {
	if (!root.has("handoff")) return null;

	const handoff = optionalEntries(root, "handoff", "handoff", ["reviewers"]);
	const field = "handoff.reviewers";

	if (!handoff.has("reviewers")) {
		fail(field, "is required when handoff is configured");
	}

	const node = handoff.get("reviewers") ?? null;

	if (!isSeq(node)) fail(field, "must be a list of GitHub user logins");

	const reviewers: string[] = [];

	for (const item of node.items) {
		const login = scalarText(item, field);

		if (!USER_LOGIN.test(login)) fail(field, "must hold GitHub user logins");

		if (reviewers.some((seen) => seen.toLowerCase() === login.toLowerCase())) {
			fail(field, "must not repeat a login");
		}

		reviewers.push(login);
	}

	const [first, ...rest] = reviewers;

	if (first === undefined) fail(field, "must name at least one reviewer");

	const list: readonly [string, ...string[]] = [first, ...rest];

	return Object.freeze({ reviewers: Object.freeze(list) });
}

function readCadence(
	root: Map<string, YamlNode>,
	platform: ModelPlatform,
): CadenceConfig | null {
	if (!root.has("cadence")) return null;

	const cadence = optionalEntries(root, "cadence", "cadence", [
		"weeklyTokenCap",
		"jobs",
	]);

	const jobs = optionalEntries(cadence, "jobs", "cadence.jobs", CADENCE_JOBS);

	const readJob = (job: CadenceJob, day: number): CadenceJobSettings => {
		const field = `cadence.jobs.${job}`;

		const entries = optionalEntries(jobs, job, field, [
			"dayUtc",
			"hourUtc",
			"minuteUtc",
			"model",
			"maxTokens",
			"maxTurns",
			"wallMs",
		]);

		return Object.freeze({
			dayUtc: integerOr(entries, "dayUtc", `${field}.dayUtc`, {
				min: 0,
				max: 6,
				fallback: day,
			}),
			hourUtc: integerOr(entries, "hourUtc", `${field}.hourUtc`, {
				min: 0,
				max: 23,
				fallback: 3,
			}),
			minuteUtc: integerOr(entries, "minuteUtc", `${field}.minuteUtc`, {
				min: 0,
				max: 59,
				fallback: 0,
			}),
			model: entries.has("model")
				? readPrimaryModel(
						entries.get("model") ?? null,
						`${field}.model`,
						"cadence",
						platform,
					)
				: defaultModel(),
			maxTokens: integerOr(entries, "maxTokens", `${field}.maxTokens`, {
				min: 1,
				max: 40_000,
				fallback: 36_000,
			}),
			budget: Object.freeze({
				maxTurns: integerOr(entries, "maxTurns", `${field}.maxTurns`, {
					min: 1,
					max: 12,
					fallback: 2,
				}),
				wallMs: integerOr(entries, "wallMs", `${field}.wallMs`, {
					min: STAGE_CLEANUP_RESERVE_MS + 1,
					max: 600_000,
					fallback: 600_000,
				}),
				stallMs: 120_000,
			}),
		});
	};

	return Object.freeze({
		weeklyTokenCap: integerOr(
			cadence,
			"weeklyTokenCap",
			"cadence.weeklyTokenCap",
			{ min: 1, fallback: 200_000 },
		),
		jobs: Object.freeze({
			architecture: readJob("architecture", 1),
			security: readJob("security", 2),
			instructions: readJob("instructions", 3),
			hygiene: readJob("hygiene", 4),
			reflect: readJob("reflect", 5),
		}),
	});
}

function readTrigger(root: Map<string, YamlNode>) {
	if (!root.has("trigger")) return null;
	const entries = optionalEntries(root, "trigger", "trigger", ["k", "d"]);

	return Object.freeze({
		k: integerOr(entries, "k", "trigger.k", { min: 1, max: 50, fallback: 25 }),
		d: integerOr(entries, "d", "trigger.d", { min: 1, fallback: 7 }),
	});
}

function readScorers(root: Map<string, YamlNode>) {
	if (!root.has("scorers") && !root.has("grader"))
		return { scorers: Object.freeze([]), grader: null };

	const grader = optionalEntries(root, "grader", "grader", [
		"model",
		"maxTokens",
	]);

	const maxTokens = integerOr(grader, "maxTokens", "grader.maxTokens", {
		min: 1,
		fallback: 16_000,
	});

	const model = readString(grader.get("model") ?? null, "grader.model");

	if (!isPinnedGrader(model))
		fail("grader.model", "requires a known exact pinned OpenAI grader");

	const entries = root.has("scorers")
		? entriesOf(root.get("scorers") ?? null, "scorers")
		: new Map<string, YamlNode>();

	const number = (node: YamlNode, field: string, max = 1) => {
		const text = readString(node, field);
		const value = Number(text);

		if (
			!/^\d+(?:\.\d+)?$/.test(text) ||
			!Number.isFinite(value) ||
			value < 0 ||
			value > max
		)
			fail(field, `must be a number from 0 to ${max}`);

		return value;
	};

	const scorers: ScorerConfig[] = [];

	for (const [key, node] of entries) {
		if (!/^[a-z][a-z0-9-]{0,63}$/.test(key))
			fail("scorers", "invalid scorer id");
		const field = `scorers.${key}`;

		const config = optionalEntries(new Map([[key, node]]), key, field, [
			"id",
			"prompt",
			"labels",
			"passingScore",
			"samplingRate",
			"includeChildren",
		]);

		const id = readString(config.get("id") ?? null, `${field}.id`);

		if (id !== key) fail(`${field}.id`, "must match its map key");
		const prompt = readString(config.get("prompt") ?? null, `${field}.prompt`);

		if (Buffer.byteLength(prompt) > 8192)
			fail(`${field}.prompt`, "exceeds 8 KiB");
		const labels: Record<string, number> = {};

		for (const [label, score] of entriesOf(
			config.get("labels") ?? null,
			`${field}.labels`,
		)) {
			if (!/^[a-z][a-z0-9_-]{0,63}$/.test(label))
				fail(`${field}.labels`, "invalid label");

			labels[label] = number(score, `${field}.labels.${label}`);
		}

		const passingScore = number(
			config.get("passingScore") ?? null,
			`${field}.passingScore`,
		);

		if (
			Object.keys(labels).length < 2 ||
			Object.keys(labels).length > 20 ||
			!Object.values(labels).some((v) => v >= passingScore) ||
			!Object.values(labels).some((v) => v < passingScore)
		)
			fail(
				`${field}.labels`,
				"requires 2 to 20 labels, including passing and failing scores",
			);

		const children = readString(
			config.get("includeChildren") ?? null,
			`${field}.includeChildren`,
		);

		if (children !== "true" && children !== "false")
			fail(`${field}.includeChildren`, "must be true or false");

		scorers.push(
			Object.freeze({
				id,
				prompt,
				labels: Object.freeze(labels),
				passingScore,
				samplingRate: config.has("samplingRate")
					? number(
							config.get("samplingRate") ?? null,
							`${field}.samplingRate`,
							100,
						)
					: 10,
				includeChildren: children === "true",
			}),
		);
	}

	return {
		scorers: Object.freeze(scorers),
		grader: Object.freeze({ model, maxTokens }),
	};
}

const ROOT_KEYS = [
	"repository",
	"polling",
	"agent",
	"workspace",
	"retry",
	"usage",
	"attention",
	"replay",
	"cadence",
	"trigger",
	"scorers",
	"grader",
	"stages",
	"checkpoints",
	"handoff",
];

const REJECTED_COMMAND_KEYS = [
	"hooks",
	"codex",
	"command",
	"commands",
	"script",
	"scripts",
	"shell",
	"exec",
	"run",
	"bash",
	"before_run",
	"after_create",
	"hook",
];

function rejectCommandKey(name: string, field: string): void {
	if (REJECTED_COMMAND_KEYS.includes(name.trim().toLowerCase())) {
		fail(
			field,
			"names shell commands, and the factory runs no commands from WORKFLOW.md",
		);
	}
}

type ConfigRead = { config: WorkflowConfig; warnings: string[] };

function readConfig(
	root: Map<string, YamlNode>,
	repo: RepoSlug,
	env: EnvLookup,
	platform: ModelPlatform,
): ConfigRead {
	const warnings: string[] = [];

	for (const key of root.keys()) {
		rejectCommandKey(key, UNKNOWN_KEY);

		if (!ROOT_KEYS.includes(key)) warnings.push(`${UNKNOWN_KEY} ignored`);
	}

	if (!root.has("repository")) fail("repository", "is required");

	const repository = readString(root.get("repository") ?? null, "repository");

	if (repository !== repo) {
		fail("repository", "must equal the repository the caller loaded");
	}

	const polling = optionalEntries(root, "polling", "polling", ["interval_ms"]);
	const agent = optionalEntries(root, "agent", "agent", ["max_concurrent"]);
	const workspace = optionalEntries(root, "workspace", "workspace", ["root"]);

	const retry = optionalEntries(root, "retry", "retry", [
		"max_attempts",
		"max_backoff_ms",
	]);

	const usage = optionalEntries(root, "usage", "usage", ["max_tokens_per_run"]);
	const replay = optionalEntries(root, "replay", "replay", ["max_tokens"]);

	const attention = optionalEntries(root, "attention", "attention", [
		"waiting_ms",
		"blocked_ms",
	]);

	if (root.has("replay") && !replay.has("max_tokens")) {
		fail("replay.max_tokens", "is required when replay is configured");
	}

	const config: WorkflowConfig = Object.freeze({
		repository: repo,
		polling: Object.freeze({
			intervalMs: integerOr(polling, "interval_ms", "polling.interval_ms", {
				min: LIMITS.minPollIntervalMs,
				fallback: DEFAULTS.pollIntervalMs,
			}),
		}),
		agent: Object.freeze({
			maxConcurrent: integerOr(
				agent,
				"max_concurrent",
				"agent.max_concurrent",
				{
					min: 1,
					max: LIMITS.maxConcurrent,
					fallback: DEFAULTS.maxConcurrent,
				},
			),
		}),
		workspace: readWorkspaceRoot(workspace, env),
		retry: Object.freeze({
			maxAttempts: integerOr(retry, "max_attempts", "retry.max_attempts", {
				min: 1,
				fallback: DEFAULTS.maxAttempts,
			}),
			maxBackoffMs: integerOr(retry, "max_backoff_ms", "retry.max_backoff_ms", {
				min: 1,
				fallback: DEFAULTS.maxBackoffMs,
			}),
		}),
		usage: Object.freeze({
			maxTokensPerRun: integerOr(
				usage,
				"max_tokens_per_run",
				"usage.max_tokens_per_run",
				{ min: 1, fallback: DEFAULTS.maxTokensPerRun },
			),
		}),
		attention: Object.freeze({
			waitingMs: integerOr(attention, "waiting_ms", "attention.waiting_ms", {
				min: 1,
				fallback: 259_200_000,
			}),
			blockedMs: integerOr(attention, "blocked_ms", "attention.blocked_ms", {
				min: 1,
				fallback: 21_600_000,
			}),
		}),
		replay: root.has("replay")
			? Object.freeze({
					maxTokens: integerOr(replay, "max_tokens", "replay.max_tokens", {
						min: 1,
						fallback: 0,
					}),
				})
			: null,
		cadence: readCadence(root, platform),
		trigger: readTrigger(root),
		...readScorers(root),
		stages: readStages(root, warnings, platform),
		checkpoints: readCheckpoints(root),
		handoff: readHandoff(root),
	});

	return { config, warnings };
}

const ATX_HEADING = /^ {0,3}#/;

function readGuidance(body: string): Guidance {
	const sections = new Map<Stage, string[]>();
	const general: string[] = [];
	let current = general;

	for (const token of Lexer.lex(body, getDefaults())) {
		const splits =
			token.type === "heading" &&
			token.depth === 2 &&
			ATX_HEADING.test(token.raw);

		if (!splits) {
			current.push(token.raw);
			continue;
		}

		const name = token.text.trim();

		if (!isStage(name)) {
			fail(
				"guidance",
				`has a level-2 heading that names no stage: use one of ${STAGE_ORDER.join(", ")}`,
			);
		}

		if (sections.has(name)) fail("guidance", `duplicate heading "## ${name}"`);

		current = [];
		sections.set(name, current);
	}

	const stages: Partial<Record<Stage, string>> = {};

	for (const stage of STAGE_ORDER) {
		const raws = sections.get(stage);

		if (raws !== undefined) stages[stage] = raws.join("").trim();
	}

	return Object.freeze({
		general: general.join("").trim(),
		stages: Object.freeze(stages),
	});
}

type FrontMatter =
	| { kind: "split"; frontMatter: string; body: string }
	| { kind: "missing" }
	| { kind: "unclosed" };

function splitFrontMatter(text: string): FrontMatter {
	const lines = text.replace(/^\uFEFF/, "").split(/\r?\n/);

	if (lines[0]?.trimEnd() !== "---") return { kind: "missing" };

	const end = lines.findIndex(
		(line, index) => index > 0 && line.trimEnd() === "---",
	);

	if (end === -1) return { kind: "unclosed" };

	return {
		kind: "split",
		frontMatter: lines.slice(0, end).with(0, "").join("\n"),
		body: lines
			.slice(end + 1)
			.join("\n")
			.trim(),
	};
}

export type ParsedWorkflow =
	| {
			readonly kind: "valid";
			readonly config: WorkflowConfig;
			readonly guidance: Guidance;
			readonly warnings: readonly string[];
	  }
	| { readonly kind: "invalid"; readonly error: WorkflowError };

/** Parses WORKFLOW.md text. Pure: the environment comes from `env`, model permissions from `platform`. */
export function parseWorkflow(input: {
	text: string;
	repo: RepoSlug;
	env: EnvLookup;
	platform: PlatformProfile;
}): ParsedWorkflow {
	const split = splitFrontMatter(input.text);

	if (split.kind === "missing") {
		return invalid({
			kind: "workflow_front_matter_missing",
			message:
				"WORKFLOW.md must start with --- front matter naming the repository",
		});
	}

	if (split.kind === "unclosed") {
		return invalid({
			kind: "workflow_parse_error",
			code: "FRONT_MATTER_UNCLOSED",
			line: 1,
			column: 1,
			message: "front matter has no closing ---",
		});
	}

	const lineCounter = new LineCounter();

	const document = parseDocument(split.frontMatter, {
		schema: "failsafe",
		lineCounter,
	});

	const problem = document.errors[0] ?? document.warnings[0];

	if (problem !== undefined) return invalid(yamlError(problem, lineCounter));

	const references = anchorsAndAliases(split.frontMatter, lineCounter);

	const first = references[0];

	if (first !== undefined) {
		return invalid({
			kind: "workflow_parse_error",
			code: "ANCHOR_OR_ALIAS",
			line: first.line,
			column: first.column,
			message: `anchors and aliases are not allowed: ${references
				.map(
					(found) =>
						`${found.what} at line ${found.line}, column ${found.column}`,
				)
				.join("; ")}`,
		});
	}

	if (!isMap(document.contents)) {
		return invalid({
			kind: "workflow_front_matter_not_a_map",
			message: "front matter must be a YAML map",
		});
	}

	try {
		const root = entriesOf(document.contents, "front matter");

		const { config, warnings } = readConfig(
			root,
			input.repo,
			input.env,
			input.platform,
		);

		const guidance = readGuidance(split.body);

		return Object.freeze({
			kind: "valid",
			config,
			guidance,
			warnings: Object.freeze(warnings.map(redactCredentials)),
		});
	} catch (error) {
		if (!(error instanceof InvalidWorkflow)) throw error;

		return invalid({
			kind: "workflow_validation_error",
			field: error.field,
			message: `${error.field} ${error.message}`,
		});
	}
}

function yamlError(
	problem: YAMLError,
	lineCounter: LineCounter,
): WorkflowError {
	const { line, col } =
		problem.linePos?.[0] ?? lineCounter.linePos(problem.pos[0]);

	return {
		kind: "workflow_parse_error",
		code: problem.code,
		line,
		column: col,
		message: `YAML ${problem.code} at line ${line}, column ${col}`,
	};
}

type Reference = {
	readonly what: "anchor" | "alias";
	readonly line: number;
	readonly column: number;
};

function anchorsAndAliases(
	source: string,
	lineCounter: LineCounter,
): Reference[] {
	const offsets: { what: Reference["what"]; offset: number }[] = [];

	const anchors = (tokens: readonly CST.Token[] | undefined): void => {
		for (const token of tokens ?? []) {
			if (token.type === "anchor") {
				offsets.push({ what: "anchor", offset: token.offset });
			}
		}
	};

	const node = (token: CST.Token | null | undefined): void => {
		if (token?.type === "alias") {
			offsets.push({ what: "alias", offset: token.offset });
		}

		if (token !== null && token !== undefined && "props" in token) {
			anchors(token.props);
		}
	};

	for (const token of new Parser().parse(source)) {
		if (token.type !== "document") continue;

		CST.visit(token, (item) => {
			anchors(item.start);
			anchors(item.sep);
			node(item.key);
			node(item.value);
		});
	}

	return offsets
		.toSorted((left, right) => left.offset - right.offset)
		.map(({ what, offset }) => {
			const { line, col } = lineCounter.linePos(offset);

			return { what, line, column: col };
		});
}

function redactError(error: WorkflowError): WorkflowError {
	const message = redactCredentials(error.message);

	return error.kind === "workflow_validation_error"
		? { ...error, field: redactCredentials(error.field), message }
		: { ...error, message };
}

function invalid(error: WorkflowError): ParsedWorkflow {
	return { kind: "invalid", error: redactError(error) };
}

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

export type ConfigView = Omit<WorkflowConfig, "workspace"> & {
	readonly workspace: { readonly root: string };
};

type LoadedFields = {
	readonly sha: GitSha;
	readonly digest: Digest;
	readonly valid: true;
	readonly error: null;
};

type FailedFields = {
	readonly sha: GitSha | null;
	readonly digest: Digest | null;
	readonly valid: false;
	readonly error: WorkflowError;
};

type ViewOf<Fields> = {
	readonly repo: RepoSlug;
	readonly ref: string;
	readonly verification: boolean;
	readonly warnings: readonly string[];
} & Fields;

export type LoadView = ViewOf<LoadedFields> | ViewOf<FailedFields>;

type InForce = {
	readonly ref: string;
	readonly sha: GitSha;
	readonly digest: Digest;
};

export type ReloadView =
	| (Omit<ViewOf<LoadedFields>, "warnings"> & {
			readonly outcome: "applied";
			readonly inForce: InForce;
	  })
	| (Omit<ViewOf<FailedFields>, "warnings"> & {
			readonly outcome: "kept";
			readonly inForce: InForce;
	  })
	| (Omit<ViewOf<FailedFields>, "warnings"> & {
			readonly outcome: "unavailable";
			readonly inForce: null;
	  });

export type CheckReport =
	| (ViewOf<LoadedFields> & {
			readonly config: ConfigView;
			readonly guidance: Guidance;
			readonly reload: ReloadView | null;
	  })
	| (ViewOf<FailedFields> & {
			readonly config: null;
			readonly guidance: null;
			readonly reload: ReloadView | null;
	  });

type StatusLimits = {
	readonly pollIntervalMs: number;
	readonly maxConcurrent: number;
	readonly retry: WorkflowConfig["retry"];
	readonly usage: WorkflowConfig["usage"];
	readonly stages: Readonly<Record<Stage, StageBudget>>;
};

type StatusOf<Fields> = {
	readonly package: string;
	readonly version: string;
	readonly repo: RepoSlug;
	readonly ref: string;
	readonly verification: boolean;
} & Fields & {
		readonly warnings: readonly string[];
		readonly executionEnabled: false;
		readonly controller: {
			readonly state: "unavailable";
			readonly reason: string;
		};
	};

export type StatusReport =
	| StatusOf<{
			readonly workflow: "valid";
			readonly workflowSha: GitSha;
			readonly workflowDigest: Digest;
			readonly workflowError: null;
			readonly models: Readonly<Record<ModelStage, ModelId>>;
			readonly seatModels: SeatModels;
			readonly limits: StatusLimits;
			readonly checkpoints: WorkflowConfig["checkpoints"];
	  }>
	| StatusOf<{
			readonly workflow: "invalid";
			readonly workflowSha: GitSha | null;
			readonly workflowDigest: Digest | null;
			readonly workflowError: WorkflowError;
			readonly models: null;
			readonly seatModels: null;
			readonly limits: null;
			readonly checkpoints: null;
	  }>;

export const NO_CONTROLLER = "no controller is installed in this release";

type FailedLoad = Extract<WorkflowLoad, { kind: "failed" }>;

function loadedView(snapshot: WorkflowSnapshot): ViewOf<LoadedFields> {
	return {
		repo: snapshot.repo,
		ref: snapshot.ref,
		sha: snapshot.sha,
		digest: snapshot.digest,
		verification: snapshot.ref !== TRUSTED_REF,
		valid: true,
		error: null,
		warnings: snapshot.warnings,
	};
}

function failedView(load: FailedLoad): ViewOf<FailedFields> {
	return {
		repo: load.repo,
		ref: load.ref,
		sha: load.sha,
		digest: load.digest,
		verification: load.ref !== TRUSTED_REF,
		valid: false,
		error: load.error,
		warnings: [],
	};
}

export function loadView(load: WorkflowLoad): LoadView {
	return load.kind === "loaded" ? loadedView(load.snapshot) : failedView(load);
}

export function configView(config: WorkflowConfig): ConfigView {
	return { ...config, workspace: { root: config.workspace.rootAsWritten } };
}

export function modelsOf(config: WorkflowConfig): Record<ModelStage, ModelId> {
	const { stages } = config;

	return {
		specify: stages.specify.model,
		accept: stages.accept.model,
		build: stages.build.model,
		review: stages.review.model,
	};
}

/** The model each review seat with its own key runs. Shown beside `models.review`, never folded into it. */
export type SeatModels = { readonly "code-review": ModelId };

export function seatModelsOf(config: WorkflowConfig): SeatModels {
	const { review } = config.stages;

	return { "code-review": review.codeReviewModel ?? review.model };
}

function budgetsOf(config: WorkflowConfig): Record<Stage, StageBudget> {
	const { stages } = config;

	return {
		admit: stages.admit.budget,
		specify: stages.specify.budget,
		accept: stages.accept.budget,
		build: stages.build.budget,
		validate: stages.validate.budget,
		review: stages.review.budget,
		land: stages.land.budget,
	};
}

function inForceOf(snapshot: WorkflowSnapshot): InForce {
	return { ref: snapshot.ref, sha: snapshot.sha, digest: snapshot.digest };
}

function reloadView(current: WorkflowLoad, next: WorkflowLoad): ReloadView {
	const reload = reloadWorkflow(
		current.kind === "loaded" ? current.snapshot : null,
		next,
	);

	if (next.kind === "loaded") {
		const { warnings: _warnings, ...view } = loadedView(next.snapshot);

		return { ...view, outcome: "applied", inForce: inForceOf(next.snapshot) };
	}

	const { warnings: _warnings, ...view } = failedView(next);

	if (reload.kind === "unavailable") {
		return { ...view, outcome: "unavailable", inForce: null };
	}

	const inForce = inForceOf(reload.snapshot);

	return {
		...view,
		verification: inForce.ref !== TRUSTED_REF,
		outcome: "kept",
		inForce,
	};
}

export function checkReport(
	load: WorkflowLoad,
	reloadNext: WorkflowLoad | null,
): CheckReport {
	const reloaded = reloadNext === null ? null : reloadView(load, reloadNext);

	if (load.kind === "failed") {
		return {
			...failedView(load),
			config: null,
			guidance: null,
			reload: reloaded,
		};
	}

	const { snapshot } = load;

	return {
		...loadedView(snapshot),
		config: configView(snapshot.config),
		guidance: snapshot.guidance,
		reload: reloaded,
	};
}

export function statusReport(
	load: WorkflowLoad,
	version: string,
): StatusReport {
	const identity = {
		package: "pi-herdr-factorio",
		version,
		repo: load.kind === "loaded" ? load.snapshot.repo : load.repo,
		ref: load.kind === "loaded" ? load.snapshot.ref : load.ref,
	};

	const runtime = {
		executionEnabled: false,
		controller: { state: "unavailable", reason: NO_CONTROLLER },
	} as const;

	if (load.kind === "failed") {
		return {
			...identity,
			verification: load.ref !== TRUSTED_REF,
			workflow: "invalid",
			workflowSha: load.sha,
			workflowDigest: load.digest,
			workflowError: load.error,
			warnings: [],
			...runtime,
			models: null,
			seatModels: null,
			limits: null,
			checkpoints: null,
		};
	}

	const { snapshot } = load;
	const { config } = snapshot;

	return {
		...identity,
		verification: snapshot.ref !== TRUSTED_REF,
		workflow: "valid",
		workflowSha: snapshot.sha,
		workflowDigest: snapshot.digest,
		workflowError: null,
		warnings: snapshot.warnings,
		...runtime,
		models: modelsOf(config),
		seatModels: seatModelsOf(config),
		limits: {
			pollIntervalMs: config.polling.intervalMs,
			maxConcurrent: config.agent.maxConcurrent,
			retry: config.retry,
			usage: config.usage,
			stages: budgetsOf(config),
		},
		checkpoints: config.checkpoints,
	};
}
