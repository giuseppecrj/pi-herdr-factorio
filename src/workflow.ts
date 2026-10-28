import { isAbsolute, normalize } from "node:path/posix";
import { isMap, isScalar, type ParsedNode, parseDocument } from "yaml";
import { type Digest, digestOf, type Stage } from "./run.ts";
import { STAGE_ORDER } from "./stages.ts";

export const WORKFLOW_PATH = ".github/factory/WORKFLOW.md";
export const TRUSTED_REF = "main";
export const DEFAULT_MODEL = "openai/gpt-6.1-sol";

export type RepoSlug = string & { readonly __brand: "RepoSlug" };

export type GitSha = string & { readonly __brand: "GitSha" };

export type ModelId = string & { readonly __brand: "ModelId" };

export const MODEL_STAGES = [
	"specify",
	"accept",
	"build",
	"validate",
	"review",
] as const satisfies readonly Stage[];

export type ModelStage = (typeof MODEL_STAGES)[number];

export type StageBudget = {
	readonly maxTurns: number;
	readonly wallMs: number;
	readonly stallMs: number;
};

export type StageSettings = {
	readonly [S in Stage]: S extends ModelStage
		? { readonly model: ModelId; readonly budget: StageBudget }
		: { readonly budget: StageBudget };
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
	readonly stages: StageSettings;
	readonly checkpoints: { readonly approveMerge: { readonly mode: "always" } };
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
	| { readonly kind: "source_unavailable"; readonly message: string }
	| { readonly kind: "missing_workflow_file"; readonly message: string }
	| { readonly kind: "workflow_parse_error"; readonly message: string }
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

export type ExecResult = {
	readonly stdout: string;
	readonly stderr: string;
	readonly code: number;
};

/** Runs a program with an argument array. Never a shell string. */
export type Exec = (
	command: string,
	args: readonly string[],
) => Promise<ExecResult>;

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

export const LIMITS = {
	minPollIntervalMs: 10_000,
	maxConcurrent: 4,
} as const;

const REPO_SLUG = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/;
const GIT_SHA = /^[0-9a-f]{40}$/;
const BRANCH_NAME = /^(?!-)(?!.*\.\.)(?!.*\/\/)(?!\/)[A-Za-z0-9._/-]+(?<!\/)$/;
const MODEL_ID = /^([a-z0-9][a-z0-9-]*)\/([A-Za-z0-9][A-Za-z0-9._:-]*)$/;
const ENV_REFERENCE = /^\$([A-Za-z_][A-Za-z0-9_]*)$/;

const GITHUB_REMOTE =
	/^(?:https:\/\/github\.com\/|git@github\.com:|ssh:\/\/git@github\.com\/)([A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+?)(?:\.git)?\/?$/;

const HTTPS_USERINFO = /^(https:\/\/)[^/]*@/;

const URL_USERINFO = /([a-z][a-z0-9+.-]*:\/\/)[^\s/?#]*@/gi;

/** Replaces the userinfo of every `scheme://user:secret@host` in `text`. */
export function redactCredentials(text: string): string {
	return text.replace(URL_USERINFO, "$1<redacted>@");
}

export function isRepoSlug(input: string): input is RepoSlug {
	return REPO_SLUG.test(input);
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

function isStage(input: string): input is Stage {
	return STAGE_ORDER.some((stage) => stage === input);
}

export function githubRepoFromRemote(url: string): RepoSlug | null {
	const bare = url.trim().replace(HTTPS_USERINFO, "$1");
	const slug = GITHUB_REMOTE.exec(bare)?.[1];

	return slug !== undefined && isRepoSlug(slug) ? slug : null;
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
		if (!allowed.includes(name)) fail(`${field}.${name}`, "unknown key");
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

function readInteger(
	node: YamlNode,
	field: string,
	range: { min: number; max?: number },
): number {
	const text = readString(node, field);

	if (!/^[+-]?[0-9]+$/.test(text)) {
		fail(field, `must be an integer, got ${text}`);
	}

	const value = Number(text);

	if (!Number.isSafeInteger(value)) fail(field, `is too large: ${text}`);

	if (value < range.min) {
		fail(
			field,
			range.min === 1
				? `must be a positive integer, got ${value}`
				: `must be at least ${range.min}, got ${value}`,
		);
	}

	if (range.max !== undefined && value > range.max) {
		fail(field, `must be at most ${range.max}, got ${value}`);
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

function readModel(node: YamlNode, field: string): ModelId {
	const text = readString(node, field);

	if (!isModelId(text)) {
		fail(field, `must be <provider>/<model>, got ${text}`);
	}

	if (text.startsWith("anthropic/")) {
		fail(
			field,
			"provider anthropic is not allowed: on the VM it spends exe.dev credits until the owner's proxy exists",
		);
	}

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
			fail(field, `${source} is not set`);
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
		if (name === "model" && !allowed.includes(name)) {
			fail(
				`${field}.model`,
				`${stage} runs no model, so it takes no model key`,
			);
		}

		if (!allowed.includes(name)) fail(`${field}.${name}`, "unknown key");
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
	stage: ModelStage,
): StageSettings[typeof stage] {
	const entries = stageEntries(stages, stage, ["model", ...BUDGET_KEYS]);

	const model = entries.has("model")
		? readModel(entries.get("model") ?? null, `stages.${stage}.model`)
		: defaultModel();

	return Object.freeze({ model, budget: readBudget(entries, stage) });
}

function defaultModel(): ModelId {
	if (!isModelId(DEFAULT_MODEL)) throw new Error("DEFAULT_MODEL is malformed");

	return DEFAULT_MODEL;
}

function readStages(root: Map<string, YamlNode>): StageSettings {
	const stages = optionalEntries(root, "stages", "stages", STAGE_ORDER);

	return Object.freeze({
		admit: readControllerStage(stages, "admit"),
		specify: readModelStage(stages, "specify"),
		accept: readModelStage(stages, "accept"),
		build: readModelStage(stages, "build"),
		validate: readModelStage(stages, "validate"),
		review: readModelStage(stages, "review"),
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
		fail(field, `unknown checkpoint mode ${mode}: use always`);
	}

	return Object.freeze({ approveMerge: Object.freeze({ mode }) });
}

const ROOT_KEYS = [
	"repository",
	"polling",
	"agent",
	"workspace",
	"retry",
	"usage",
	"stages",
	"checkpoints",
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
];

type ConfigRead = { config: WorkflowConfig; warnings: string[] };

function readConfig(
	root: Map<string, YamlNode>,
	repo: RepoSlug,
	env: EnvLookup,
): ConfigRead {
	const warnings: string[] = [];

	for (const key of root.keys()) {
		if (REJECTED_COMMAND_KEYS.includes(key)) {
			fail(
				key,
				"names shell commands, and the factory runs no commands from WORKFLOW.md",
			);
		}

		if (!ROOT_KEYS.includes(key)) warnings.push(`unknown key ${key} ignored`);
	}

	if (!root.has("repository")) fail("repository", "is required");

	const repository = readString(root.get("repository") ?? null, "repository");

	if (repository !== repo) {
		fail("repository", `names ${repository}, but the caller loaded ${repo}`);
	}

	const polling = optionalEntries(root, "polling", "polling", ["interval_ms"]);
	const agent = optionalEntries(root, "agent", "agent", ["max_concurrent"]);
	const workspace = optionalEntries(root, "workspace", "workspace", ["root"]);

	const retry = optionalEntries(root, "retry", "retry", [
		"max_attempts",
		"max_backoff_ms",
	]);

	const usage = optionalEntries(root, "usage", "usage", ["max_tokens_per_run"]);

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
		stages: readStages(root),
		checkpoints: readCheckpoints(root),
	});

	return { config, warnings };
}

function readGuidance(body: string): Guidance {
	const sections = new Map<string, string[]>();
	const general: string[] = [];
	let current = general;
	let fence: string | null = null;

	for (const line of body.split("\n")) {
		const marker = /^(`{3,}|~{3,})/.exec(line)?.[1];

		if (marker !== undefined) {
			if (fence === null) fence = marker[0] ?? null;
			else if (marker.startsWith(fence)) fence = null;
		}

		const heading =
			fence === null ? /^## +(.+?)\s*$/.exec(line)?.[1] : undefined;

		if (heading === undefined) {
			current.push(line);
			continue;
		}

		if (!isStage(heading)) {
			fail(
				"guidance",
				`unknown stage heading "## ${heading}": use one of ${STAGE_ORDER.join(", ")}`,
			);
		}

		if (sections.has(heading)) {
			fail("guidance", `duplicate heading "## ${heading}"`);
		}

		current = [];
		sections.set(heading, current);
	}

	const stages: Partial<Record<Stage, string>> = {};

	for (const stage of STAGE_ORDER) {
		const lines = sections.get(stage);

		if (lines !== undefined) stages[stage] = lines.join("\n").trim();
	}

	return Object.freeze({
		general: general.join("\n").trim(),
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
		frontMatter: lines.slice(1, end).join("\n"),
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

/** Parses WORKFLOW.md text. Pure: the environment comes from `env`. */
export function parseWorkflow(input: {
	text: string;
	repo: RepoSlug;
	env: EnvLookup;
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
			message: "front matter has no closing ---",
		});
	}

	const document = parseDocument(split.frontMatter, { schema: "failsafe" });
	const problem = document.errors[0] ?? document.warnings[0];

	if (problem !== undefined) {
		return invalid({ kind: "workflow_parse_error", message: problem.message });
	}

	if (!isMap(document.contents)) {
		return invalid({
			kind: "workflow_front_matter_not_a_map",
			message: "front matter must be a YAML map",
		});
	}

	try {
		const root = entriesOf(document.contents, "front matter");
		const { config, warnings } = readConfig(root, input.repo, input.env);
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

function redactError(error: WorkflowError): WorkflowError {
	const message = redactCredentials(error.message);

	return error.kind === "workflow_validation_error"
		? { ...error, field: redactCredentials(error.field), message }
		: { ...error, message };
}

function invalid(error: WorkflowError): ParsedWorkflow {
	return { kind: "invalid", error: redactError(error) };
}

function firstLine(text: string): string {
	return text.trim().split("\n")[0] ?? "";
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
			message: `${ref} is not a branch name`,
		});
	}

	const resolved = await exec("gh", [
		"api",
		`repos/${repo}/git/ref/heads/${ref}`,
		"--jq",
		".object.sha",
	]);

	const sha = resolved.stdout.trim();

	if (resolved.code !== 0 || !isGitSha(sha)) {
		return failed(null, null, {
			kind: "source_unavailable",
			message: `cannot resolve ${repo} ${ref}: ${firstLine(resolved.stderr) || "no SHA returned"}`,
		});
	}

	const fetched = await exec("gh", [
		"api",
		"-H",
		"Accept: application/vnd.github.raw",
		`repos/${repo}/contents/${WORKFLOW_PATH}?ref=${sha}`,
	]);

	if (fetched.code !== 0) {
		const reason = /HTTP 404/.test(fetched.stderr)
			? "not found"
			: firstLine(fetched.stderr) || `gh exited ${fetched.code}`;

		return failed(sha, null, {
			kind: "missing_workflow_file",
			message: `${WORKFLOW_PATH} at ${sha}: ${reason}`,
		});
	}

	const digest = digestOf(fetched.stdout);
	const parsed = parseWorkflow({ text: fetched.stdout, repo, env: input.env });

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

	return Object.freeze({ kind: "loaded", snapshot });
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

export type LoadView = {
	readonly repo: RepoSlug;
	readonly ref: string;
	readonly sha: GitSha | null;
	readonly digest: Digest | null;
	readonly verification: boolean;
	readonly valid: boolean;
	readonly error: WorkflowError | null;
	readonly warnings: readonly string[];
};

export type ReloadView = Omit<LoadView, "warnings"> & {
	readonly outcome: Reload["kind"];
	readonly inForce: {
		readonly ref: string;
		readonly sha: GitSha;
		readonly digest: Digest;
	} | null;
};

export type CheckReport = LoadView & {
	readonly config: ConfigView | null;
	readonly guidance: Guidance | null;
	readonly reload: ReloadView | null;
};

export type StatusReport = {
	readonly package: string;
	readonly version: string;
	readonly repo: RepoSlug;
	readonly ref: string;
	readonly verification: boolean;
	readonly workflow: "valid" | "invalid";
	readonly workflowSha: GitSha | null;
	readonly workflowDigest: Digest | null;
	readonly workflowError: WorkflowError | null;
	readonly warnings: readonly string[];
	readonly executionEnabled: false;
	readonly controller: {
		readonly state: "unavailable";
		readonly reason: string;
	};
	readonly models: Readonly<Record<ModelStage, ModelId>> | null;
	readonly limits: {
		readonly pollIntervalMs: number;
		readonly maxConcurrent: number;
		readonly retry: WorkflowConfig["retry"];
		readonly usage: WorkflowConfig["usage"];
		readonly stages: Readonly<Record<Stage, StageBudget>>;
	} | null;
	readonly checkpoints: WorkflowConfig["checkpoints"] | null;
};

export const NO_CONTROLLER = "no controller is installed in this release";

export function loadView(load: WorkflowLoad): LoadView {
	if (load.kind === "failed") {
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

	const { snapshot } = load;

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

export function configView(config: WorkflowConfig): ConfigView {
	return { ...config, workspace: { root: config.workspace.rootAsWritten } };
}

export function modelsOf(config: WorkflowConfig): Record<ModelStage, ModelId> {
	const { stages } = config;

	return {
		specify: stages.specify.model,
		accept: stages.accept.model,
		build: stages.build.model,
		validate: stages.validate.model,
		review: stages.review.model,
	};
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

function reloadView(next: WorkflowLoad, reload: Reload): ReloadView {
	const { warnings: _warnings, ...view } = loadView(next);

	const inForce =
		reload.kind === "unavailable"
			? null
			: {
					ref: reload.snapshot.ref,
					sha: reload.snapshot.sha,
					digest: reload.snapshot.digest,
				};

	return {
		...view,
		verification: (inForce?.ref ?? view.ref) !== TRUSTED_REF,
		outcome: reload.kind,
		inForce,
	};
}

export function checkReport(
	load: WorkflowLoad,
	reload: { next: WorkflowLoad; result: Reload } | null,
): CheckReport {
	const snapshot = load.kind === "loaded" ? load.snapshot : null;

	return {
		...loadView(load),
		config: snapshot === null ? null : configView(snapshot.config),
		guidance: snapshot === null ? null : snapshot.guidance,
		reload: reload === null ? null : reloadView(reload.next, reload.result),
	};
}

export function statusReport(
	load: WorkflowLoad,
	version: string,
): StatusReport {
	const view = loadView(load);
	const config = load.kind === "loaded" ? load.snapshot.config : null;

	return {
		package: "pi-herdr-factorio",
		version,
		repo: view.repo,
		ref: view.ref,
		verification: view.verification,
		workflow: view.valid ? "valid" : "invalid",
		workflowSha: view.sha,
		workflowDigest: view.digest,
		workflowError: view.error,
		warnings: view.warnings,
		executionEnabled: false,
		controller: { state: "unavailable", reason: NO_CONTROLLER },
		models: config === null ? null : modelsOf(config),
		limits:
			config === null
				? null
				: {
						pollIntervalMs: config.polling.intervalMs,
						maxConcurrent: config.agent.maxConcurrent,
						retry: config.retry,
						usage: config.usage,
						stages: budgetsOf(config),
					},
		checkpoints: config === null ? null : config.checkpoints,
	};
}
