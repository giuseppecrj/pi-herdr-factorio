import { randomBytes } from "node:crypto";
import {
	FAMILY_MISSING,
	type FamilyInput,
	parseFamily,
	withFamily,
} from "../../src/core/models.ts";
import type { ExecutionStage as ModelStage } from "../../src/core/stages.ts";
import {
	commandReceipts,
	patchDir,
	roundKey,
	readPatch,
	type PatchRead,
} from "../../src/candidate/build.ts";
import {
	closeSync,
	existsSync,
	fsyncSync,
	lstatSync,
	mkdirSync,
	openSync,
	readdirSync,
	readFileSync,
	renameSync,
	rmSync,
	statSync,
	writeFileSync,
} from "node:fs";
import { readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import type {
	StageLaunchInput,
	StageOutput,
} from "../../src/controller/launch.ts";
import { isDigest, type Digest } from "../../src/core/run.ts";
import { AUDIT_CAP_BYTES, JOURNAL_FILE } from "./audit.ts";
import { journalCharge } from "../../src/core/journal.ts";
import {
	countOf,
	fieldOf,
	objectOf,
	parseJson,
	textOf,
} from "../../src/core/json.ts";
import {
	type SessionOutcome,
	unknownEfficiency,
	parseEfficiency,
	requestEfficiency,
	aggregateEfficiency,
	type EfficiencyFacts,
	executionUsageOf,
	type ExecutionUsage,
} from "../../src/core/execution.ts";

export const MAX_RECEIPT_BYTES = 1024 * 1024;

export async function boundedText(
	path: string,
	cap: number,
): Promise<string | null> {
	try {
		return statSync(path).size > cap ? null : await readFile(path, "utf8");
	} catch {
		return null;
	}
}

export async function readStageReceipt(path: string) {
	const raw = await boundedText(path, MAX_RECEIPT_BYTES);
	const record = objectOf(parseJson(raw ?? ""));
	const result = objectOf(fieldOf(record, "outcome"));
	const kind = textOf(fieldOf(result, "kind"));
	let outcome: SessionOutcome;

	if (kind === "passed" || kind === "refused") outcome = { kind };
	else if (kind === "failed") {
		const exit = textOf(fieldOf(result, "exit"));

		if (
			exit !== "error" &&
			exit !== "malformed" &&
			exit !== "crashed" &&
			exit !== "aborted"
		)
			return null;

		outcome = { kind, exit };
	} else if (kind === "budget_exhausted") {
		const cap = textOf(fieldOf(result, "cap"));

		if (
			cap !== "tokens" &&
			cap !== "run_tokens" &&
			cap !== "turns" &&
			cap !== "wall"
		)
			return null;

		outcome = { kind, cap };
	} else return null;

	const usage = objectOf(fieldOf(record, "usage"));
	const byModel: Record<string, number> = {};

	for (const [key, value] of Object.entries(
		objectOf(fieldOf(usage, "byModel")) ?? {},
	)) {
		const count = countOf(value);

		if (count === null) return null;

		byModel[key] = count;
	}

	const total = countOf(fieldOf(usage, "total"));
	const turns = countOf(fieldOf(record, "turns"));
	const wallMs = countOf(fieldOf(record, "wallMs"));

	if (total === null || turns === null || wallMs === null) return null;

	return {
		record,
		outcome,
		turns,
		wallMs,
		usage: {
			total,
			byModel,
			parent: countOf(fieldOf(usage, "parent")) ?? 0,
			children: countOf(fieldOf(usage, "children")) ?? 0,
			gateway: countOf(fieldOf(usage, "gateway")),
			unreadChildren: countOf(fieldOf(usage, "unreadChildren")) ?? 0,
		},
	};
}

export const OUTPUT_MAX_BYTES = 256 * 1024;

export const MAX_SESSION_BYTES = 64 * 1024 * 1024;

/**
 * Publishes `text` at `path` whole or not at all: it is written to a fresh
 * 0600 temp file beside it, fsynced, then renamed into place, and the
 * directory is fsynced. An existing `path` is never replaced. Any failure
 * removes the temp file and returns `false`.
 */
export function publishFile(
	path: string,
	text: string,
	write: (fd: number, text: string) => void = (fd, data) =>
		writeFileSync(fd, data),
): boolean {
	if (existsSync(path)) return false;

	const temp = `${path}.tmp-${randomBytes(4).toString("hex")}`;
	let fd: number | null = null;

	try {
		fd = openSync(temp, "wx", 0o600);
		write(fd, text);
		fsyncSync(fd);
		closeSync(fd);
		fd = null;
		renameSync(temp, path);
	} catch {
		try {
			if (fd !== null) closeSync(fd);

			rmSync(temp, { force: true });
		} catch {
			// Best effort: the publish already failed and returns false below.
		}

		return false;
	}

	try {
		const dir = openSync(dirname(path), "r");

		try {
			fsyncSync(dir);
		} finally {
			closeSync(dir);
		}
	} catch {
		// Best effort: the file is renamed into place; a directory fsync is extra durability.
	}

	return true;
}

export function replaceUsage(path: string, usage: ExecutionUsage): boolean {
	const temp = `${path}.next`;

	try {
		mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
		rmSync(temp, { force: true });

		if (!publishFile(temp, `${JSON.stringify(usage)}\n`)) return false;
		renameSync(temp, path);
		const dir = openSync(dirname(path), "r");

		try {
			fsyncSync(dir);
		} finally {
			closeSync(dir);
		}

		return true;
	} catch {
		return false;
	}
}

/**
 * Tokens one stage attempt is known to have used: the sum over each of its
 * execution dirs, `<stage>-<attempt>` and any replay `<stage>-<attempt>.<n>`,
 * each counted once. `null` when no dir left a receipt or an audit.
 */
export async function attemptSpent(
	stateDir: string,
	runId: Digest,
	stage: ModelStage,
	attempt: number,
	round = 0,
): Promise<number | null> {
	const base = stageName(stage, attempt, round);
	const root = join(stateDir, "stages", runId);
	let names: string[];

	try {
		names = readdirSync(root);
	} catch {
		return null;
	}

	let total: number | null = null;

	for (const name of names) {
		const replay =
			name.startsWith(`${base}.`) && /^\d+$/.test(name.slice(base.length + 1));

		if (name !== base && !replay) continue;

		const spent = await executionSpent(join(root, name));

		if (spent !== null) total = (total ?? 0) + spent;
	}

	return total;
}

export async function executionSpent(dir: string): Promise<number | null> {
	return (await executionCharge(dir))?.total ?? null;
}

export type ExecutionCharge = {
	readonly total: number;
	readonly uncertain: number;
};

export function uncertainCharge(
	floor: number,
	requests: number,
	metered = 0,
	upperBound = 0,
): ExecutionCharge {
	return { total: Math.max(floor, metered + upperBound), uncertain: requests };
}

function summed(charges: (ExecutionCharge | null)[]): ExecutionCharge | null {
	return charges.some((charge) => charge !== null)
		? {
				total: charges.reduce((sum, charge) => sum + (charge?.total ?? 0), 0),
				uncertain: charges.reduce(
					(sum, charge) => sum + (charge?.uncertain ?? 0),
					0,
				),
			}
		: null;
}

/**
 * What one execution dir is known to have charged, from host-side files
 * only. A finished receipt's `usage.total` covers everything under it, so
 * its leaves are not added again. Without one, an aggregate specify or
 * review dir sums its session dirs, and a leaf takes the larger of its
 * synced request journal and the gateway's `egress.jsonl` tally, never
 * their sum. A dispatched request with no result is `uncertain`: its
 * recorded input-plus-output bound is charged by `uncertainCharge` and the
 * request is never sent again. Legacy dispatches without bounds remain floors. A line cut short by a crash is skipped. `null` when the dir
 * has no receipt, journal or audit.
 */
export async function executionCharge(
	dir: string,
): Promise<ExecutionCharge | null> {
	const receipt = await boundedText(
		join(dir, "receipt.json"),
		MAX_RECEIPT_BYTES,
	);

	const total =
		receipt === null
			? null
			: countOf(
					fieldOf(
						objectOf(fieldOf(objectOf(parseJson(receipt)), "usage")),
						"total",
					),
				);

	const covered = (charge: ExecutionCharge | null): ExecutionCharge | null =>
		total === null
			? charge
			: {
					total: Math.max(total, charge?.total ?? 0),
					uncertain: charge?.uncertain ?? 0,
				};

	if (existsSync(join(dir, "specify.json"))) {
		return covered(
			summed(
				await Promise.all(
					SPECIFY_SESSIONS.map((name) => executionCharge(join(dir, name))),
				),
			),
		);
	}

	if (
		[
			"review.json",
			"code-review",
			"security-review",
			"simplify",
			"ultrareview",
		].some((name) => existsSync(join(dir, name)))
	) {
		const names = readdirSync(dir).filter((name) =>
			["code-review", "security-review", "simplify", "ultrareview"].includes(
				name,
			),
		);

		return covered(
			summed(
				await Promise.all(
					names.map((name) => executionCharge(join(dir, name))),
				),
			),
		);
	}

	const high = objectOf(
		parseJson(
			(await boundedText(join(dir, "usage.json"), MAX_RECEIPT_BYTES)) ?? "",
		),
	);

	const highTotal = countOf(fieldOf(objectOf(fieldOf(high, "usage")), "total"));
	const journal = await boundedText(join(dir, JOURNAL_FILE), AUDIT_CAP_BYTES);
	const charged = journal === null ? null : journalCharge(journal);
	const audit = await boundedText(join(dir, "egress.jsonl"), AUDIT_CAP_BYTES);

	if (audit === null && charged === null && highTotal === null)
		return covered(null);

	let sum = 0;

	for (const line of (audit ?? "").split("\n")) {
		const record = objectOf(parseJson(line));

		if (record === null) continue;

		sum += countOf(fieldOf(record, "inputTokens")) ?? 0;
		sum += countOf(fieldOf(record, "outputTokens")) ?? 0;
	}

	return {
		...uncertainCharge(
			Math.max(sum, charged?.tokens ?? 0, highTotal ?? 0, total ?? 0),
			charged?.uncertain ?? 0,
			Math.max(sum, charged?.tokens ?? 0),
			charged?.uncertainTokens ?? 0,
		),
	};
}

/** Numeric diagnostics follow the same aggregate/leaf boundary as charges. */
export async function executionEfficiency(
	dir: string,
): Promise<EfficiencyFacts> {
	const receipt = objectOf(
		parseJson(
			(await boundedText(join(dir, "receipt.json"), MAX_RECEIPT_BYTES)) ?? "",
		),
	);

	const saved = parseEfficiency(fieldOf(receipt, "efficiency"));

	if (saved !== null) return saved;

	const leaves = [
		...SPECIFY_SESSIONS,
		"code-review",
		"security-review",
		"simplify",
		"ultrareview",
	];

	const names = leaves.filter((name) => existsSync(join(dir, name)));

	if (names.length > 0)
		return aggregateEfficiency(
			await Promise.all(
				names.map((name) => executionEfficiency(join(dir, name))),
			),
		);

	const high = objectOf(
		parseJson(
			(await boundedText(join(dir, "usage.json"), MAX_RECEIPT_BYTES)) ?? "",
		),
	);

	const progress =
		parseEfficiency(fieldOf(high, "efficiency")) ?? unknownEfficiency();

	const journal = await boundedText(join(dir, JOURNAL_FILE), AUDIT_CAP_BYTES);

	return { ...progress, ...requestEfficiency(journal) };
}

export const SPECIFY_SESSIONS = ["draft", "review", "revision"] as const;

export async function executionWindow(
	dir: string,
	input: StageLaunchInput,
): Promise<ExecutionUsage> {
	const path = join(dir, "usage.json");
	const text = await boundedText(path, MAX_RECEIPT_BYTES);
	const now = Date.now();

	const record =
		text === null
			? {
					version: 1 as const,
					runId: input.runId,
					stage: input.stage,
					attempt: input.attempt,
					startedAt: now,
					deadline: now + input.settings.budget.wallMs,
					turns: 0,
					usage: {
						total: 0,
						parent: 0,
						children: 0,
						gateway: null,
						unreadChildren: 0,
						byModel: {},
					},
				}
			: executionUsageOf(parseJson(text), input);

	if (
		record === null ||
		(text === null && existsSync(path)) ||
		!replaceUsage(path, record)
	)
		throw new Error("execution_usage_unavailable");

	return record;
}

export async function attemptOutput(
	stateDir: string,
	runId: Digest,
	stage: ModelStage,
	attempt: number,
	round = 0,
): Promise<StageOutput | null> {
	const base = stageName(stage, attempt, round);
	const root = join(stateDir, "stages", runId);
	let names: string[];

	try {
		names = readdirSync(root);
	} catch {
		return null;
	}

	const replays = names
		.flatMap((name) => {
			if (name === base) return [{ name, n: 1 }];

			const suffix = name.slice(base.length + 1);

			return name.startsWith(`${base}.`) && /^\d+$/.test(suffix)
				? [{ name, n: Number(suffix) }]
				: [];
		})
		.sort((left, right) => right.n - left.n);

	for (const { name } of replays) {
		const dir = join(root, name);

		const receipt = objectOf(
			parseJson(
				(await boundedText(join(dir, "receipt.json"), MAX_RECEIPT_BYTES)) ?? "",
			),
		);

		const outcome = textOf(
			fieldOf(objectOf(fieldOf(receipt, "outcome")), "kind"),
		);

		const file = textOf(fieldOf(objectOf(fieldOf(receipt, "output")), "file"));

		if (
			outcome === null &&
			(existsSync(join(dir, "specify.json")) ||
				existsSync(join(dir, "review.json")))
		)
			return { kind: "pending" };

		if (outcome !== "passed" || file !== "output.txt") continue;

		const text = await boundedText(join(dir, file), OUTPUT_MAX_BYTES);

		if (text !== null) {
			if (stage !== "accept") return text;
			const models = objectOf(fieldOf(receipt, "models"));
			const fallback = objectOf(fieldOf(receipt, "fallback"));

			const model =
				textOf(fieldOf(fallback, "requested")) ??
				textOf(fieldOf(models, "requested"));

			const family = parseFamily(fieldOf(receipt, "family"));

			return model === null
				? null
				: withFamily(
						{
							kind: "output" as const,
							text,
							model,
							observed:
								textOf(fieldOf(fallback, "observed")) ??
								textOf(fieldOf(models, "observed")),
						},
						family,
					);
		}
	}

	return null;
}

/**
 * The builder's family for a round: the family stored on the latest passed
 * build attempt of that round whose answering request is the patch's
 * recorded model. Only `openai-request` for that exact model counts;
 * anything else is unavailable, so `r8` stays incomplete.
 */
export async function builderFamily(
	stateDir: string,
	runId: Digest,
	round: number,
	model: string,
): Promise<FamilyInput> {
	const root = join(stateDir, "stages", runId);
	const prefix = round > 0 ? `build-r${round}-` : "build-";
	const name = /^(\d+)(?:\.(\d+))?$/;
	let names: string[];

	try {
		names = readdirSync(root);
	} catch {
		return FAMILY_MISSING;
	}

	const attempts = names
		.flatMap((entry) => {
			const match = entry.startsWith(prefix)
				? name.exec(entry.slice(prefix.length))
				: null;

			return match === null
				? []
				: [{ entry, attempt: Number(match[1]), n: Number(match[2] ?? 1) }];
		})
		.sort((a, b) => b.attempt - a.attempt || b.n - a.n);

	for (const { entry } of attempts) {
		const receipt = objectOf(
			parseJson(
				(await boundedText(
					join(root, entry, "receipt.json"),
					MAX_RECEIPT_BYTES,
				)) ?? "",
			),
		);

		if (
			textOf(fieldOf(objectOf(fieldOf(receipt, "outcome")), "kind")) !==
			"passed"
		)
			continue;

		const requested =
			textOf(fieldOf(objectOf(fieldOf(receipt, "fallback")), "requested")) ??
			textOf(fieldOf(objectOf(fieldOf(receipt, "models")), "requested"));

		const family = parseFamily(fieldOf(receipt, "family"));

		return requested === model &&
			family?.kind === "openai-request" &&
			family.model === model
			? family
			: FAMILY_MISSING;
	}

	return FAMILY_MISSING;
}

export function stageName(
	stage: ModelStage,
	attempt: number,
	round = 0,
): string {
	return round > 0 || stage === "review"
		? `${stage}-r${round}-${attempt}`
		: `${stage}-${attempt}`;
}

export function readRunPatch(
	stateDir: string,
	runId: Digest,
	round = 0,
): PatchRead {
	try {
		const record = objectOf(
			parseJson(
				readFileSync(
					join(stateDir, "patches", `${roundKey(runId, round)}.json`),
					"utf8",
				),
			),
		);

		const baseSha = textOf(fieldOf(record, "baseSha"));
		const contractDigest = textOf(fieldOf(record, "contractDigest"));
		const acceptanceDigest = textOf(fieldOf(record, "acceptanceDigest"));

		if (
			baseSha === null ||
			contractDigest === null ||
			acceptanceDigest === null ||
			!isDigest(acceptanceDigest)
		)
			return { kind: "blocked", reason: "patch_invalid" };

		return readPatch(stateDir, {
			round,
			runId,
			baseSha,
			contractDigest,
			acceptanceDigest,
		});
	} catch (error) {
		return error instanceof Error && "code" in error && error.code === "ENOENT"
			? existsSync(patchDir(stateDir, runId, round))
				? { kind: "blocked", reason: "patch_missing" }
				: { kind: "absent" }
			: { kind: "blocked", reason: "patch_invalid" };
	}
}

export function buildCommands(
	stateDir: string,
	runId: Digest,
	attempt: number,
	round = 0,
) {
	const root = join(stateDir, "stages", runId);
	const commands: ReturnType<typeof commandReceipts> = [];

	const walk = (dir: string) => {
		for (const name of readdirSync(dir).sort()) {
			const path = join(dir, name);
			const stat = lstatSync(path);

			if (stat.isDirectory()) walk(path);
			else if (
				stat.isFile() &&
				name.endsWith(".jsonl") &&
				stat.size <= MAX_SESSION_BYTES &&
				path.includes("/sessions/")
			)
				commands.push(...commandReceipts(readFileSync(path, "utf8")));
		}
	};

	for (const name of readdirSync(root).sort())
		if (
			name === stageName("build", attempt, round) ||
			name.startsWith(`${stageName("build", attempt, round)}.`)
		)
			walk(join(root, name));

	return commands;
}
