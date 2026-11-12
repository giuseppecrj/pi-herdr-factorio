import { readFile, rename, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { digestOf } from "../core/run.ts";
import { parseLedger, type LedgerRow } from "../ledger/schema.ts";
import {
	currentRepository,
	type HistoricalRepositories,
	type PlatformProfile,
	soleRepository,
} from "../trust/platform.ts";
import { isGitSha } from "../config/schema.ts";
import { parseWorkflow } from "../config/parse.ts";
import type { Exec } from "../github/exec.ts";
import { execFileSync } from "node:child_process";
import {
	arrayOf,
	boolOf,
	countOf,
	fieldOf,
	objectOf,
	parseJson,
	textOf,
	textsOf,
} from "../core/json.ts";

export const REPLAY_RUN_CAP = 540_000;
export const REPLAY_CORPUS = "test/fixtures/replay";
const DIGEST = /^[a-f0-9]{64}$/;

const BUNDLE_PATHS = [
	"skills",
	"host/bundle/assets",
	"host/install/provision.sh",
	"server/sandbox/assets",
	"server/provision.sh",
];

export type ReplayCase = {
	readonly id: string;
	readonly sourceIssues: readonly number[];
	readonly kind: string;
	readonly liveReplayable: boolean;
	readonly baseSha: string;
	readonly paths: readonly string[];
	readonly guardPattern: string | null;
	readonly title: string;
	readonly issueDigest: string;
	readonly expected: "handoff" | "needs_info";
	readonly expectedRound: number | null;
	readonly historicalFacts: string;
};

export type ReplayCorpus = {
	readonly v: 1;
	readonly digest: string;
	readonly cases: readonly ReplayCase[];
};

function refuse(code: string): never {
	throw new Error(code);
}

function required(text: string | null): string {
	return text ?? refuse("replay_invalid_input");
}

function natural(value: number | null): number {
	return value ?? refuse("replay_invalid_input");
}

function safePath(path: string): boolean {
	return (
		path.length > 0 &&
		!path.startsWith("/") &&
		!path.includes("\\") &&
		path.split("/").every((p) => p !== "" && p !== "." && p !== "..")
	);
}

export async function loadReplayCorpus(dir: string): Promise<ReplayCorpus> {
	const raw = objectOf(
		parseJson(await readFile(join(dir, "corpus.json"), "utf8")),
	);

	const cases = arrayOf(fieldOf(raw, "cases"));
	const digest = textOf(fieldOf(raw, "digest"));

	if (
		fieldOf(raw, "v") !== 1 ||
		cases === null ||
		cases.length === 0 ||
		digest === null ||
		!DIGEST.test(digest)
	)
		refuse("corpus_invalid");

	if (digestOf(JSON.stringify({ v: 1, cases })) !== digest)
		refuse("corpus_digest_mismatch");
	const result: ReplayCase[] = [];

	for (const value of cases) {
		const c = objectOf(value);
		const id = required(textOf(fieldOf(c, "id")));
		const baseSha = required(textOf(fieldOf(c, "baseSha")));
		const paths = textsOf(fieldOf(c, "paths"));

		const sourceIssues =
			arrayOf(fieldOf(c, "sourceIssues"))?.map((n) => natural(countOf(n))) ??
			[];

		const liveReplayable = boolOf(fieldOf(c, "liveReplayable"));
		const expected = textOf(fieldOf(c, "expected"));

		const expectedRound =
			fieldOf(c, "expectedRound") === null
				? null
				: countOf(fieldOf(c, "expectedRound"));

		const issueDigest = required(textOf(fieldOf(c, "issueDigest")));
		const title = required(textOf(fieldOf(c, "title")));
		const guardPattern = textOf(fieldOf(c, "guardPattern"));

		if (
			!/^c[1-9][0-9]*$/.test(id) ||
			result.some((r) => r.id === id) ||
			!isGitSha(baseSha) ||
			paths === null ||
			paths.length === 0 ||
			!paths.every(safePath) ||
			sourceIssues.length === 0 ||
			sourceIssues.some((n) => n === 0) ||
			liveReplayable === null ||
			(expected !== "handoff" && expected !== "needs_info") ||
			!DIGEST.test(issueDigest)
		)
			refuse("corpus_invalid");
		const text = await readFile(join(dir, "cases", id, "issue.md"), "utf8");

		if (digestOf(text) !== issueDigest) refuse("issue_digest_mismatch");

		if (title !== `[F12a-replay-${id}] ${text.split("\n")[0]?.slice(2)}`)
			refuse("issue_title_mismatch");

		if (/#\d+|@[\w-]+|https?:\/\/github\.com/i.test(text))
			refuse("issue_not_sanitized");
		result.push({
			id,
			baseSha,
			paths,
			guardPattern,
			title,
			sourceIssues,
			liveReplayable,
			expected,
			expectedRound,
			issueDigest,
			kind: required(textOf(fieldOf(c, "kind"))),
			historicalFacts: required(textOf(fieldOf(c, "historicalFacts"))),
		});
	}

	return { v: 1, digest, cases: result };
}

// Frozen replay paths use aliases as a fallback for missing guarded sources and as
// additional pathspecs for unguarded diffs. A guard split across files fails closed.
const REPLAY_SOURCE_ALIASES: ReadonlyMap<string, string> = new Map([
	["src/workflow.ts", "src/config/schema.ts"],
	["src/specify.ts", "src/contract/contract.ts"],
	["server/viewer.ts", "host/viewer/server.ts"],
	["server/cli.ts", "host/cli/index.ts"],
]);

// Symbol guards compare whole top-level declarations, not just changed lines.
// Unsupported layouts fail closed rather than silently dropping part of a symbol.
function guardedSource(source: string, pattern: string): string | null {
	const declarations: string[] = [];

	for (const name of pattern.split("|")) {
		if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(name)) return null;

		const matches = [
			...source.matchAll(
				new RegExp(
					`^(?:export )?(?:function ${name}\\b[^\\n]*\\{[\\s\\S]*?^}|const ${name} = [^\\n]+;)$`,
					"gm",
				),
			),
		];

		if (matches.length !== 1 || matches[0] === undefined) return null;
		declarations.push(matches[0][0]);
	}

	return JSON.stringify(declarations);
}

export async function checkReplay(input: {
	readonly corpus: ReplayCorpus;
	readonly mainSha: string;
	readonly previousSha: string;
	readonly candidateSha: string;
	readonly exec: Exec;
}) {
	if (![input.mainSha, input.previousSha, input.candidateSha].every(isGitSha))
		refuse("replay_sha_required");

	const diff = async (a: string, b: string, paths: readonly string[]) => {
		try {
			return await input.exec("git", [
				"--literal-pathspecs",
				"diff",
				"--name-only",
				a,
				b,
				"--",
				...paths,
			]);
		} catch {
			return { code: 1, stdout: "", stderr: "" };
		}
	};

	const symbolDiff = async (c: ReplayCase) => {
		try {
			const regions = await Promise.all(
				[c.baseSha, input.mainSha].map(async (sha) => {
					const parts = await Promise.all(
						c.paths.map(async (path) => {
							let result = await input.exec("git", ["show", `${sha}:${path}`]);

							const alias = REPLAY_SOURCE_ALIASES.get(path);

							if (result.code !== 0 && alias !== undefined) {
								result = await input.exec("git", ["show", `${sha}:${alias}`]);
							}

							if (result.code !== 0 || c.guardPattern === null) return null;

							return guardedSource(result.stdout, c.guardPattern);
						}),
					);

					return parts.some((p) => p === null) ? null : JSON.stringify(parts);
				}),
			);

			return {
				code: regions.some((r) => r === null) ? 1 : 0,
				stdout: regions[0] === regions[1] ? "" : "symbols_changed",
			};
		} catch {
			return { code: 1, stdout: "" };
		}
	};

	const cases = await Promise.all(
		input.corpus.cases.map(async (c) => {
			const change = !c.liveReplayable
				? null
				: c.guardPattern === null
					? await diff(
							c.baseSha,
							input.mainSha,
							c.paths.flatMap((path) => {
								const alias = REPLAY_SOURCE_ALIASES.get(path);

								return alias === undefined ? [path] : [path, alias];
							}),
						)
					: await symbolDiff(c);

			const status =
				change === null
					? "offline_only"
					: change.code !== 0
						? "unavailable"
						: change.stdout.trim() === ""
							? "ready"
							: "stale";

			return { ...c, status };
		}),
	);

	const bundleDiff = await diff(
		input.previousSha,
		input.candidateSha,
		BUNDLE_PATHS,
	);

	return {
		v: 1,
		corpusDigest: input.corpus.digest,
		mainSha: input.mainSha,
		previousSha: input.previousSha,
		candidateSha: input.candidateSha,
		cases,
		bundle:
			bundleDiff.code !== 0
				? "unavailable"
				: bundleDiff.stdout.trim() === ""
					? "same_inputs"
					: "bundle_switch_required",
		promotes: false,
		limitations: [
			"Both factories use frozen main policy and gates; candidate WORKFLOW changes are not exercised.",
			"This check is local evidence, not a fixture grant or proof production is stopped.",
		],
	};
}

export function replayRow(bytes: Uint8Array): LedgerRow {
	const lines = parseLedger(bytes);
	const line = lines[0];

	if (lines.length !== 1 || line?.kind !== "known")
		refuse("replay_row_invalid");

	if (line.row.provenance.kind !== "verification")
		refuse("replay_not_verification");

	return line.row;
}

export type ReplayRecord = {
	readonly v: number;
	readonly caseId: string;
	readonly corpusDigest: string;
	readonly issueDigest: string;
	readonly side: string;
	readonly issue: number;
	readonly headSha: string;
	readonly mainSha: string;
	readonly terminalMainSha: string | null;
	readonly runId: string | null;
	readonly stageCaps: Readonly<Record<string, number>>;
};

export function readReplayRecord(text: string): ReplayRecord {
	const raw = objectOf(parseJson(text));
	const caps = objectOf(fieldOf(raw, "stageCaps"));
	const stageCaps: Record<string, number> = {};

	for (const key of ["accept", "build", "review", "repair"]) {
		const value = countOf(fieldOf(caps, key));

		if (value === null || value === 0) refuse("replay_record_invalid");
		stageCaps[key] = value;
	}

	const result = {
		v: natural(countOf(fieldOf(raw, "v"))),
		caseId: required(textOf(fieldOf(raw, "caseId"))),
		corpusDigest: required(textOf(fieldOf(raw, "corpusDigest"))),
		issueDigest: required(textOf(fieldOf(raw, "issueDigest"))),
		side: required(textOf(fieldOf(raw, "side"))),
		issue: natural(countOf(fieldOf(raw, "issue"))),
		headSha: required(textOf(fieldOf(raw, "headSha"))),
		mainSha: required(textOf(fieldOf(raw, "mainSha"))),
		terminalMainSha: textOf(fieldOf(raw, "terminalMainSha")),
		runId: textOf(fieldOf(raw, "runId")),
		stageCaps,
	};

	if (
		result.v !== 1 ||
		!/^c[1-9][0-9]*$/.test(result.caseId) ||
		![result.corpusDigest, result.issueDigest].every((d) => DIGEST.test(d)) ||
		![result.headSha, result.mainSha].every(isGitSha) ||
		(result.terminalMainSha !== null && !isGitSha(result.terminalMainSha)) ||
		(result.runId !== null && !DIGEST.test(result.runId)) ||
		!["prev", "cand"].includes(result.side) ||
		result.issue === 0
	)
		refuse("replay_record_invalid");

	return result;
}

export type ReplaySide = {
	readonly headSha: string;
	readonly row: LedgerRow;
	readonly record: ReplayRecord;
};

function modelsOf(row: LedgerRow): string[] | null {
	if (row.models.kind !== "known" || row.models.value.length === 0) return null;

	if (row.models.value.some((m) => m.observed.kind !== "known")) return null;

	return [
		...new Set(
			row.models.value.map((m) => JSON.stringify([m.requested, m.observed])),
		),
	].sort();
}

function mainMoved(side: ReplaySide): boolean {
	const { row, record } = side;

	if (row.provenance.kind !== "verification") return true;

	if (
		record.mainSha !== row.provenance.policy.workflowSha ||
		record.terminalMainSha !== record.mainSha
	)
		return true;

	// Older factories have no terminal observation; the trusted driver's two remote pins still apply.
	if (!("terminalWorkflowObservation" in row)) return false;

	if (row.terminalWorkflowObservation.kind !== "known") return true;
	const observation = row.terminalWorkflowObservation.value;

	return (
		observation.workflowSha !== record.mainSha ||
		observation.workflowDigest !== row.provenance.policy.workflowDigest
	);
}

function assetsOf(row: LedgerRow): string[] | null {
	if (row.models.kind !== "known" || row.models.value.length === 0) return null;
	const assets: string[] = [];

	for (const model of row.models.value) {
		if (model.runtime.kind !== "known") return null;
		assets.push(model.runtime.value.assetsDigest);
	}

	return [...new Set(assets)].sort();
}

function sideReport(side: ReplaySide, expected: ReplayCase["expected"]) {
	const row = side.row;

	if (row.provenance.kind !== "verification") refuse("replay_not_verification");

	if (!isGitSha(side.headSha)) refuse("replay_sha_required");

	const certified =
		row.outcome.kind === "landed" &&
		row.outcome.assurance.kind === "factory_verified" &&
		row.artifacts.kind === "candidate"
			? row.artifacts.generations.find(
					(g) =>
						row.outcome.kind === "landed" &&
						row.outcome.assurance.kind === "factory_verified" &&
						g.intentDigest === row.outcome.assurance.generationDigest,
				)
			: null;

	return {
		headSha: side.headSha,
		caseId: side.record.caseId,
		corpusDigest: side.record.corpusDigest,
		issue: row.issue,
		side: side.record.side,
		stageCaps: side.record.stageCaps,
		trustedRunTokenCap: row.provenance.trustedRunTokenCap,
		effectiveRunTokenCap: row.provenance.effectiveRunTokenCap,
		mainSha: side.record.mainSha,
		terminalMainSha: side.record.terminalMainSha,
		runId: row.runId,
		originalBase: row.originalBase,
		policy: row.provenance.policy,
		verificationDigest: row.provenance.verificationDigest,
		outcome: row.outcome,
		expected,
		matchesExpected:
			expected === "needs_info"
				? row.outcome.kind === "needs_info"
					? "yes"
					: "no"
				: "unknown",
		certifiedRound: certified?.round ?? null,
		lastGenerationRound:
			row.artifacts.kind === "candidate"
				? (row.artifacts.generations.at(-1)?.round ?? null)
				: null,
		stages: row.stages,
		models: row.models,
		assetsDigests: assetsOf(row),
		tokens: row.usage.tokens,
		interruptedAttempts: row.interruptedAttempts,
		wallMs:
			row.stages.kind === "known"
				? row.stages.value.reduce((n, s) => n + s.wallMs.total, 0)
				: null,
		spend: { kind: "unavailable", reason: "provider_not_reported" },
	};
}

export function replayReport(input: {
	readonly previous: ReplaySide;
	readonly candidate: ReplaySide;
	readonly expected: ReplayCase["expected"];
	readonly expectedAssets?: {
		readonly previous: string;
		readonly candidate: string;
	};
	/** Read-only former names: a row recorded under one is the same repository. */
	readonly history?: HistoricalRepositories;
}) {
	const previous = sideReport(input.previous, input.expected);
	const candidate = sideReport(input.candidate, input.expected);
	const reasons: string[] = [];
	const p = input.previous;
	const c = input.candidate;

	if (p.record.caseId !== c.record.caseId) reasons.push("case_mismatch");

	if (p.record.corpusDigest !== c.record.corpusDigest)
		reasons.push("corpus_mismatch");

	if (p.record.issueDigest !== c.record.issueDigest)
		reasons.push("issue_text_mismatch");

	if (p.record.side !== "prev" || c.record.side !== "cand")
		reasons.push("side_mismatch");

	if (p.row.runId === c.row.runId) reasons.push("same_run");

	const history = input.history ?? {};

	const sameRepository =
		currentRepository(history, p.row.repo) ===
		currentRepository(history, c.row.repo);

	if (sameRepository && p.row.issue === c.row.issue)
		reasons.push("same_fixture_issue");

	if (
		[p, c].some(
			(s) =>
				s.record.issue !== s.row.issue ||
				s.record.runId !== s.row.runId ||
				s.record.headSha !== s.headSha,
		)
	)
		reasons.push("fixture_binding_mismatch");

	if (JSON.stringify(p.record.stageCaps) !== JSON.stringify(c.record.stageCaps))
		reasons.push("stage_cap_mismatch");

	if (
		previous.trustedRunTokenCap !== candidate.trustedRunTokenCap ||
		previous.effectiveRunTokenCap !== candidate.effectiveRunTokenCap
	)
		reasons.push("run_cap_mismatch");
	const pm = modelsOf(p.row);
	const cm = modelsOf(c.row);

	if (pm === null || cm === null) reasons.push("models_unavailable");
	else if (JSON.stringify(pm) !== JSON.stringify(cm))
		reasons.push("model_mismatch");

	if (mainMoved(p) || mainMoved(c)) reasons.push("main_moved");

	if (!sameRepository) reasons.push("repository_mismatch");

	if (previous.originalBase !== candidate.originalBase)
		reasons.push("original_base_mismatch");

	if (JSON.stringify(previous.policy) !== JSON.stringify(candidate.policy))
		reasons.push("policy_mismatch");

	if (
		previous.policy.gates.kind !== "known" ||
		candidate.policy.gates.kind !== "known"
	)
		reasons.push("gates_unavailable");

	if (previous.assetsDigests === null || candidate.assetsDigests === null)
		reasons.push("assets_unavailable");
	else if (input.expectedAssets !== undefined) {
		if (
			JSON.stringify(previous.assetsDigests) !==
				JSON.stringify([input.expectedAssets.previous]) ||
			JSON.stringify(candidate.assetsDigests) !==
				JSON.stringify([input.expectedAssets.candidate])
		)
			reasons.push("unexpected_assets");
	} else if (
		JSON.stringify(previous.assetsDigests) !==
		JSON.stringify(candidate.assetsDigests)
	)
		reasons.push("unexpected_assets");

	return {
		v: 1,
		primaryMetric: {
			kind: "unavailable",
			reason: "replays_do_not_establish_seven_day_clean_landings",
		},
		comparability: reasons.length === 0 ? "comparable" : "incomparable",
		reasons,
		previous,
		candidate,
		promotes: false,
		limitations: [
			"The 540,000-token reservation equals the replay hard run limit. Heavy runs can exhaust at review or repair where production's larger run cap would continue.",
			"Context-isolated same-family stages are not independent cross-family proof.",
			"Provider versions and spend are unavailable unless recorded; unavailable is not zero.",
			"Frozen main policy and gates judge both factories, not candidate WORKFLOW changes.",
			"Terminal ledger rows do not attest readiness at handoff. Cancelled fixture candidates have unknown handoff outcomes; retain the handoff receipt separately.",
		],
	};
}

type Reservation = {
	key: string;
	status: "reserved" | "settled" | "voided";
	tokens: number;
	wallMs: number;
	startedAt: number;
	outcome: string | null;
	runId: string | null;
};

type ReplayPolicyChange = {
	from: number;
	to: number;
	at: number;
	workflowDigest: string;
	mainSha: string;
};

type ReplayPolicySource = { mainSha: string; workflowText: string };

export type ReplayBudget = {
	v: 1;
	policyChanges: ReplayPolicyChange[];
	maxTokens: number | null;
	reservations: Reservation[];
	chargedTokens: number;
	wallMs: number;
};

export async function readReplayBudget(path: string): Promise<ReplayBudget> {
	let text: string;

	try {
		text = await readFile(path, "utf8");
	} catch (error) {
		if (error instanceof Error && "code" in error && error.code === "ENOENT")
			return {
				v: 1,
				maxTokens: null,
				policyChanges: [],
				reservations: [],
				chargedTokens: 0,
				wallMs: 0,
			};
		throw error;
	}

	const raw = objectOf(parseJson(text));
	const maxTokens = countOf(fieldOf(raw, "maxTokens"));
	const entries = arrayOf(fieldOf(raw, "reservations"));

	if (
		fieldOf(raw, "v") !== 1 ||
		maxTokens === null ||
		maxTokens === 0 ||
		entries === null
	)
		refuse("replay_budget_invalid");
	const changes = fieldOf(raw, "policyChanges");
	const policyChanges: ReplayPolicyChange[] = [];
	const history = changes === undefined ? [] : arrayOf(changes);

	if (history === null) refuse("replay_budget_invalid");

	for (const item of history) {
		const change = objectOf(item);
		const from = countOf(fieldOf(change, "from"));
		const to = countOf(fieldOf(change, "to"));
		const at = countOf(fieldOf(change, "at"));
		const workflowDigest = textOf(fieldOf(change, "workflowDigest"));
		const mainSha = textOf(fieldOf(change, "mainSha"));

		if (
			from === null ||
			from < 1 ||
			to === null ||
			to <= from ||
			at === null ||
			workflowDigest === null ||
			!DIGEST.test(workflowDigest) ||
			mainSha === null ||
			!isGitSha(mainSha) ||
			(policyChanges.length > 0 && policyChanges.at(-1)?.to !== from)
		)
			refuse("replay_budget_invalid");
		policyChanges.push({ from, to, at, workflowDigest, mainSha });
	}

	if (policyChanges.length > 0 && policyChanges.at(-1)?.to !== maxTokens)
		refuse("replay_budget_invalid");
	const reservations: Reservation[] = [];

	for (const item of entries) {
		const r = objectOf(item);
		const key = required(textOf(fieldOf(r, "key")));
		const status = textOf(fieldOf(r, "status"));

		if (
			(status !== "reserved" && status !== "settled" && status !== "voided") ||
			reservations.some((old) => old.key === key)
		)
			refuse("replay_budget_invalid");
		reservations.push({
			key,
			status,
			tokens: natural(countOf(fieldOf(r, "tokens"))),
			wallMs: natural(countOf(fieldOf(r, "wallMs"))),
			startedAt: natural(countOf(fieldOf(r, "startedAt"))),
			outcome: textOf(fieldOf(r, "outcome")),
			runId: textOf(fieldOf(r, "runId")),
		});
	}

	return {
		v: 1,
		maxTokens,
		policyChanges,
		reservations,
		chargedTokens: reservations.reduce((n, r) => n + r.tokens, 0),
		wallMs: reservations.reduce(
			(n, r) =>
				n +
				(r.status === "reserved"
					? Math.max(r.wallMs, Date.now() - r.startedAt)
					: r.wallMs),
			0,
		),
	};
}

async function saveBudget(path: string, budget: ReplayBudget): Promise<void> {
	const temp = `${path}.${process.pid}.tmp`;
	await writeFile(
		temp,
		`${JSON.stringify({ v: 1, maxTokens: budget.maxTokens, policyChanges: budget.policyChanges, reservations: budget.reservations })}\n`,
		{ mode: 0o600 },
	);
	await rename(temp, path);
}

export function decideReplayBudget(
	budget: ReplayBudget,
	maxTokens: number | null,
	key?: string,
) {
	const reasons: string[] = [];

	const valid =
		maxTokens !== null && Number.isSafeInteger(maxTokens) && maxTokens > 0;

	const changed = budget.maxTokens !== null && budget.maxTokens !== maxTokens;

	if (
		changed &&
		(!valid || (budget.maxTokens !== null && maxTokens < budget.maxTokens))
	)
		reasons.push("replay_policy_changed");
	else if (!valid) reasons.push("replay_disabled");

	if (key !== undefined && budget.reservations.some((r) => r.key === key))
		reasons.push("replay_already_reserved");

	const remainingTokens = valid
		? Math.max(0, maxTokens - budget.chargedTokens)
		: null;

	if (remainingTokens !== null && remainingTokens < REPLAY_RUN_CAP)
		reasons.push("replay_cap");

	return {
		reasons,
		remainingTokens,
		pendingPolicyChange:
			valid && budget.maxTokens !== null && maxTokens > budget.maxTokens
				? { from: budget.maxTokens, to: maxTokens }
				: null,
	};
}

function replayPolicySource(): ReplayPolicySource {
	try {
		const mainSha = execFileSync(
			"git",
			[
				"rev-parse",
				"--verify",
				`${process.env.REPLAY_MAIN_SHA ?? "refs/remotes/origin/main"}^{commit}`,
			],
			{ encoding: "utf8" },
		).trim();

		if (!isGitSha(mainSha)) refuse("replay_policy_changed");

		return {
			mainSha,
			workflowText: execFileSync(
				"git",
				["show", `${mainSha}:.github/factory/WORKFLOW.md`],
				{ encoding: "utf8" },
			),
		};
	} catch {
		return refuse("replay_policy_changed");
	}
}

/** The driver serializes pairs with flock. A retained reservation is a charge, not a refund. */
export async function reserveReplay(
	path: string,
	maxTokens: number,
	key: string,
	platform: PlatformProfile,
	policySource?: ReplayPolicySource,
): Promise<void> {
	const budget = await readReplayBudget(path);
	const decision = decideReplayBudget(budget, maxTokens, key);

	if (decision.reasons.length > 0)
		refuse(decision.reasons[0] ?? "replay_policy_changed");

	if (decision.pendingPolicyChange !== null) {
		const repo = soleRepository(platform);

		if (repo === null) refuse("replay_repository_ambiguous");

		const source = policySource ?? replayPolicySource();

		if (!isGitSha(source.mainSha)) refuse("replay_policy_changed");

		const policy = parseWorkflow({
			text: source.workflowText,
			repo,
			env: (name) => process.env[name],
			platform,
		});

		if (
			policy.kind !== "valid" ||
			policy.config.replay?.maxTokens !== maxTokens
		)
			refuse("replay_policy_changed");
		budget.policyChanges.push({
			...decision.pendingPolicyChange,
			at: Date.now(),
			mainSha: source.mainSha,
			workflowDigest: digestOf(source.workflowText),
		});
	}

	budget.maxTokens = maxTokens;
	budget.reservations.push({
		key,
		status: "reserved",
		tokens: REPLAY_RUN_CAP,
		wallMs: 0,
		startedAt: Date.now(),
		outcome: null,
		runId: null,
	});
	await saveBudget(path, budget);
}

export async function settleReplay(
	path: string,
	key: string,
	row: LedgerRow,
): Promise<void> {
	if (row.provenance.kind !== "verification") refuse("replay_not_verification");
	const budget = await readReplayBudget(path);
	const reservation = budget.reservations.find((r) => r.key === key);

	if (reservation === undefined) refuse("replay_reservation_missing");

	if (reservation.status === "voided") refuse("replay_settlement_conflict");

	if (reservation.status === "settled") {
		if (reservation.runId !== row.runId) refuse("replay_settlement_conflict");

		return;
	}

	if (budget.reservations.some((r) => r.key !== key && r.runId === row.runId))
		refuse("replay_duplicate_run");
	reservation.status = "settled";
	reservation.tokens =
		row.usage.tokens.kind === "exact"
			? row.usage.tokens.total
			: Math.max(REPLAY_RUN_CAP, row.usage.tokens.total);
	reservation.wallMs = Math.max(0, Date.now() - reservation.startedAt);
	reservation.outcome = row.outcome.kind;
	reservation.runId = row.runId;
	await saveBudget(path, budget);
}

export async function voidReplay(
	path: string,
	key: string,
	evidence: {
		readonly stages: number;
		readonly tokens: number;
		readonly complete: boolean;
	},
	reason: string,
): Promise<void> {
	if (
		!evidence.complete ||
		evidence.stages !== 0 ||
		evidence.tokens !== 0 ||
		!reason
	)
		refuse("replay_void_unproven");
	const budget = await readReplayBudget(path);
	const reservation = budget.reservations.find((r) => r.key === key);

	if (reservation === undefined) refuse("replay_reservation_missing");

	if (reservation.status === "voided") return;

	if (reservation.status !== "reserved") refuse("replay_settlement_conflict");
	reservation.status = "voided";
	reservation.tokens = 0;
	reservation.wallMs = Math.max(0, Date.now() - reservation.startedAt);
	reservation.outcome = reason;
	await saveBudget(path, budget);
}

/**
 * Where each stage cap is declared, oldest layout first. A revision must
 * declare each cap in exactly one of its files; none or several refuses.
 */
const STAGE_CAP_DECLARATIONS = [
	[
		"accept",
		"ACCEPTANCE_MAX_TOKENS",
		"src/accept.ts",
		"src/contract/acceptance.ts",
	],
	["build", "BUILD_MAX_TOKENS", "src/build.ts", "src/candidate/build.ts"],
	["review", "REVIEW_MAX_TOKENS", "src/run.ts", "src/core/run.ts"],
	["repair", "REPAIR_BUILD_MAX_TOKENS", "src/run.ts", "src/core/run.ts"],
] as const;

export async function replayStageCaps(
	sha: string,
	exec: Exec,
): Promise<Record<string, number>> {
	const result: Record<string, number> = {};

	for (const [key, name, ...files] of STAGE_CAP_DECLARATIONS) {
		const values: number[] = [];

		for (const file of files) {
			const source = await exec("git", ["show", `${sha}:${file}`]);

			if (source.code !== 0) continue;

			const match = new RegExp(`export const ${name} = ([0-9_]+);`).exec(
				source.stdout,
			);

			if (match !== null) values.push(Number(match[1]?.replaceAll("_", "")));
		}

		const [value] = values;

		if (
			values.length !== 1 ||
			value === undefined ||
			!Number.isSafeInteger(value) ||
			value <= 0
		)
			refuse("replay_stage_caps_unavailable");
		result[key] = value;
	}

	return result;
}
