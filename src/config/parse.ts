import { Lexer, getDefaults } from "marked";
import { isAbsolute, normalize } from "node:path/posix";
import {
	type ParsedNode,
	type YAMLError,
	CST,
	LineCounter,
	Parser,
	isMap,
	isScalar,
	isSeq,
	parseDocument,
} from "yaml";
import { parseAnthropicModel } from "../core/models.ts";
import {
	type ModelStage,
	type Stage,
	STAGE_ORDER,
	isStage,
} from "../core/stages.ts";
import type {
	ModelPosition,
	PlatformProfile,
	RepoSlug,
} from "../trust/platform.ts";
import {
	type AcceptStageSettings,
	type CadenceConfig,
	type CadenceJob,
	type CadenceJobSettings,
	type EnvLookup,
	type Guidance,
	type HandoffSettings,
	type ModelId,
	type ModelStageSettings,
	type ParsedWorkflow,
	type ReviewStageSettings,
	type ScorerConfig,
	type StageBudget,
	type StageSettings,
	type WorkflowConfig,
	type WorkflowError,
	CADENCE_JOBS,
	DEFAULTS,
	DEFAULT_MODEL,
	ENV_REFERENCE,
	LIMITS,
	STAGE_CLEANUP_RESERVE_MS,
	UNKNOWN_KEY,
	isModelId,
	isPinnedGrader,
	redactCredentials,
	redactError,
} from "./schema.ts";

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

function invalid(error: WorkflowError): ParsedWorkflow {
	return { kind: "invalid", error: redactError(error) };
}
