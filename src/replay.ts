import { readFile, rename, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { digestOf } from "./run.ts";
import { parseLedger, type LedgerRow } from "./ledger.ts";
import { isGitSha, type Exec } from "./workflow.ts";
import {
	arrayOf,
	boolOf,
	countOf,
	fieldOf,
	objectOf,
	parseJson,
	textOf,
	textsOf,
} from "../server/sandbox/json.ts";

export const REPLAY_RUN_CAP = 540_000;
export const REPLAY_CORPUS = "test/fixtures/replay";
const DIGEST = /^[a-f0-9]{64}$/;

const BUNDLE_PATHS = [
	"skills",
	"server/sandbox/assets",
	"server/sandbox/pi.ts",
	"server/sandbox/stage-init.ts",
	"server/sandbox/echo-fixture.ts",
];

export type ReplayCase = {
	readonly id: string;
	readonly sourceIssues: readonly number[];
	readonly kind: string;
	readonly liveReplayable: boolean;
	readonly baseSha: string;
	readonly paths: readonly string[];
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

		if (/#\d+|@[\w-]+|https?:\/\/github\.com/i.test(text))
			refuse("issue_not_sanitized");
		result.push({
			id,
			baseSha,
			paths,
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

	const cases = await Promise.all(
		input.corpus.cases.map(async (c) => {
			const change = c.liveReplayable
				? await diff(c.baseSha, input.mainSha, c.paths)
				: null;

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

export type ReplaySide = { readonly headSha: string; readonly row: LedgerRow };

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
}) {
	const previous = sideReport(input.previous, input.expected);
	const candidate = sideReport(input.candidate, input.expected);
	const reasons: string[] = [];

	if (input.previous.row.repo !== input.candidate.row.repo)
		reasons.push("repository_mismatch");

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
			"Context-isolated same-family stages are not independent cross-family proof.",
			"Provider versions and spend are unavailable unless recorded; unavailable is not zero.",
			"Frozen main policy and gates judge both factories, not candidate WORKFLOW changes.",
			"Terminal ledger rows do not attest readiness at handoff. Cancelled fixture candidates have unknown handoff outcomes; retain the handoff receipt separately.",
		],
	};
}

type Reservation = {
	key: string;
	status: "reserved" | "settled";
	tokens: number;
	wallMs: number;
	startedAt: number;
	outcome: string | null;
	runId: string | null;
};

export type ReplayBudget = {
	v: 1;
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
	const reservations: Reservation[] = [];

	for (const item of entries) {
		const r = objectOf(item);
		const key = required(textOf(fieldOf(r, "key")));
		const status = textOf(fieldOf(r, "status"));

		if (
			(status !== "reserved" && status !== "settled") ||
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
		`${JSON.stringify({ v: 1, maxTokens: budget.maxTokens, reservations: budget.reservations })}\n`,
		{ mode: 0o600 },
	);
	await rename(temp, path);
}

/** The driver serializes pairs with flock. A retained reservation is a charge, not a refund. */
export async function reserveReplay(
	path: string,
	maxTokens: number,
	key: string,
): Promise<void> {
	const budget = await readReplayBudget(path);

	if (!Number.isSafeInteger(maxTokens) || maxTokens < 1)
		refuse("replay_disabled");

	if (budget.maxTokens !== null && budget.maxTokens !== maxTokens)
		refuse("replay_policy_changed");

	if (budget.reservations.some((r) => r.key === key))
		refuse("replay_already_reserved");

	if (maxTokens - budget.chargedTokens < REPLAY_RUN_CAP) refuse("replay_cap");
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
