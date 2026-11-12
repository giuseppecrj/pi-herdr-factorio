import { existsSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import type { StageLaunchInput } from "../../src/controller/launch.ts";
import {
	parseSpecifyOutput,
	parseReviewOutput,
} from "../../src/contract/parse.ts";
import { reviewPrompt, revisionPrompt } from "../../src/contract/prompt.ts";
import { fieldOf, objectOf, parseJson, textOf } from "../../src/core/json.ts";
import { PINNED_VERSIONS } from "./manifest.ts";
import {
	type BudgetCap,
	type SessionOutcome,
	type StageUsage,
	unknownEfficiency,
	parseEfficiency,
	aggregateEfficiency,
	type EfficiencyFacts,
} from "../../src/core/execution.ts";
import { type StageReceipt, type StageResult, stageResult } from "./result.ts";
import {
	MAX_RECEIPT_BYTES,
	boundedText,
	readStageReceipt,
	OUTPUT_MAX_BYTES,
	publishFile,
	replaceUsage,
	executionSpent,
	type SPECIFY_SESSIONS,
	executionWindow,
} from "./receipts.ts";
import { type StageHost, Ledger, CRASHED, runStage } from "./run-stage.ts";

type KeptSession = {
	readonly outcome: SessionOutcome;
	readonly usage: StageUsage;
	readonly turns: number;
	readonly wallMs: number;
	readonly text: string | null;
	readonly efficiency?: EfficiencyFacts;
};

async function keptSession(dir: string): Promise<KeptSession | null> {
	const parsed = await readStageReceipt(join(dir, "receipt.json"));

	if (parsed === null) return null;

	const file = textOf(
		fieldOf(objectOf(fieldOf(parsed.record, "output")), "file"),
	);

	return {
		outcome: parsed.outcome,
		usage: parsed.usage,
		turns: parsed.turns,
		wallMs: parsed.wallMs,
		efficiency:
			parseEfficiency(fieldOf(parsed.record, "efficiency")) ?? undefined,
		text:
			parsed.outcome.kind === "passed" && file === "output.txt"
				? await boundedText(join(dir, file), OUTPUT_MAX_BYTES)
				: null,
	};
}

export async function runSpecify(
	input: StageLaunchInput,
	dir: string,
	createHost: (dir: string, tools: readonly string[]) => StageHost,
): Promise<StageResult> {
	const review = input.specify;

	if (review === undefined) throw new Error("specify inputs missing");

	mkdirSync(dir, { recursive: true, mode: 0o700 });

	if (
		!existsSync(join(dir, "specify.json")) &&
		!publishFile(join(dir, "specify.json"), '{"version":1}\n')
	)
		throw new Error("specify checkpoint unavailable");

	const window = await executionWindow(dir, input);
	const previous = (await executionSpent(dir)) ?? 0;
	const records: KeptSession[] = [];
	let metadata: Pick<StageReceipt, "assetsDigest" | "versions"> | null = null;

	const usage = (): StageUsage => {
		const ledger = new Ledger();
		let gatewayRan = false;

		for (const record of records) {
			ledger.parent += record.usage.parent;
			ledger.children += record.usage.children;
			ledger.gateway += record.usage.gateway ?? 0;
			ledger.unreadChildren += record.usage.unreadChildren;
			ledger.add(new Map(Object.entries(record.usage.byModel)));
			gatewayRan ||= record.usage.gateway !== null;
		}

		return {
			...ledger.usage(gatewayRan),
			total: records.reduce((sum, record) => sum + record.usage.total, 0),
		};
	};

	const turns = () => records.reduce((sum, record) => sum + record.turns, 0);
	const wallMs = () => records.reduce((sum, record) => sum + record.wallMs, 0);

	const session = async (
		name: (typeof SPECIFY_SESSIONS)[number],
		prompt: string,
		tools: readonly string[],
	): Promise<KeptSession> => {
		const sessionDir = join(dir, name);
		const kept = await keptSession(sessionDir);

		if (kept !== null) {
			records.push(kept);

			return kept;
		}

		const used = usage().total;

		const maxTokens =
			input.settings.maxTokens === null
				? null
				: Math.max(0, input.settings.maxTokens - used);

		const remainingRunTokens = Math.max(
			0,
			input.remainingRunTokens - (used - previous),
		);

		const remainingTurns = Math.max(
			0,
			input.settings.budget.maxTurns - turns(),
		);

		const remainingWall = Math.max(
			0,
			Math.min(
				window.deadline - Date.now(),
				input.settings.budget.wallMs - wallMs(),
			),
		);

		const cap: BudgetCap | null =
			maxTokens !== null && maxTokens <= 0
				? "tokens"
				: remainingRunTokens <= 0
					? "run_tokens"
					: remainingTurns <= 0
						? "turns"
						: remainingWall <= 0
							? "wall"
							: null;

		if (cap !== null || existsSync(sessionDir)) {
			const partial = (await executionSpent(sessionDir)) ?? 0;

			const record: KeptSession = {
				outcome: cap === null ? CRASHED : { kind: "budget_exhausted", cap },
				usage: {
					total: partial,
					parent: 0,
					children: 0,
					gateway: partial,
					unreadChildren: 0,
					byModel: {},
				},
				turns: 0,
				wallMs: 0,
				text: null,
			};

			records.push(record);

			return record;
		}

		const host = createHost(sessionDir, tools);
		metadata = host;

		const result = await runStage(
			{
				...input,
				prompt,
				source:
					name === "draft"
						? input.source
						: { bytes: 0, omissions: 0, capHit: false },
				settings: {
					...input.settings,
					fallback: name === "draft" ? input.settings.fallback : null,
					maxTokens,
					budget: {
						...input.settings.budget,
						maxTurns: remainingTurns,
						wallMs: remainingWall,
					},
				},
				remainingRunTokens,
				progress: (value) =>
					input.progress(Math.max(0, used - previous) + value),
			},
			host,
		);

		const record: KeptSession = {
			...result.receipt,
			text:
				result.kind === "passed"
					? await boundedText(join(sessionDir, "output.txt"), OUTPUT_MAX_BYTES)
					: null,
		};

		records.push(record);

		return record;
	};

	const finish = async (
		outcome: SessionOutcome,
		text: string | null,
	): Promise<StageResult> => {
		const last = records.at(-1);

		const raw = objectOf(
			parseJson(
				(await boundedText(
					join(dir, "draft", "receipt.json"),
					MAX_RECEIPT_BYTES,
				)) ?? "",
			),
		);

		const assetsDigest =
			metadata?.assetsDigest ?? textOf(fieldOf(raw, "assetsDigest")) ?? "";

		const versions = objectOf(fieldOf(raw, "versions"));
		const kept = outcome.kind === "passed" && text !== null;
		const bytes = text === null ? 0 : Buffer.byteLength(text);

		const outputWritten =
			!kept ||
			existsSync(join(dir, "output.txt")) ||
			publishFile(join(dir, "output.txt"), text ?? "");

		const receipt: StageReceipt = {
			version: 1,
			runId: input.runId,
			stage: input.stage,
			attempt: input.attempt,
			outcome: outputWritten ? outcome : CRASHED,
			settlement: {
				event: last === undefined ? "none" : "agent_settled",
				aborted: null,
			},
			models: { requested: input.settings.model, observed: null },
			fallback: null,
			refusal: null,
			usage: usage(),
			efficiency: aggregateEfficiency(
				records.map((r) => r.efficiency ?? unknownEfficiency()),
			),
			turns: turns(),
			wallMs: wallMs(),
			egress: null,
			stderr: [],
			output:
				kept && outputWritten
					? { file: "output.txt", bytes, kept: bytes }
					: null,
			assetsDigest,
			versions: metadata?.versions ?? {
				pi: textOf(fieldOf(versions, "pi")) ?? PINNED_VERSIONS.pi,
				piHerdrAgents:
					textOf(fieldOf(versions, "piHerdrAgents")) ??
					PINNED_VERSIONS.piHerdrAgents,
				piHerdrPstack:
					textOf(fieldOf(versions, "piHerdrPstack")) ??
					PINNED_VERSIONS.piHerdrPstack,
			},
			pricing: "unavailable",
		};

		const checkpoint = replaceUsage(join(dir, "usage.json"), {
			...window,
			turns: receipt.turns,
			usage: receipt.usage,
		});

		const written =
			checkpoint &&
			(existsSync(join(dir, "receipt.json")) ||
				publishFile(
					join(dir, "receipt.json"),
					JSON.stringify(receipt, null, "\t"),
				));

		return {
			...stageResult(written ? receipt : { ...receipt, outcome: CRASHED }),
			usage: Math.max(0, receipt.usage.total - previous),
		};
	};

	const draft = await session("draft", input.prompt, input.tools);

	if (draft.outcome.kind !== "passed") return finish(draft.outcome, null);

	const parsed = parseSpecifyOutput(draft.text ?? "", new Set(review.files));

	if (parsed.kind === "malformed")
		return finish({ kind: "failed", exit: "malformed" }, null);

	if (parsed.kind === "questions")
		return finish({ kind: "passed" }, draft.text);

	const critique = await session(
		"review",
		reviewPrompt(review, draft.text ?? ""),
		[],
	);

	if (critique.outcome.kind !== "passed") return finish(critique.outcome, null);

	const ambiguities = parseReviewOutput(critique.text ?? "");

	if (ambiguities === null)
		return finish({ kind: "failed", exit: "malformed" }, null);

	if (ambiguities.length === 0) return finish({ kind: "passed" }, draft.text);

	const revision = await session(
		"revision",
		revisionPrompt(review, draft.text ?? "", ambiguities),
		[],
	);

	if (revision.outcome.kind !== "passed") return finish(revision.outcome, null);

	if (
		parseSpecifyOutput(revision.text ?? "", new Set(review.files)).kind ===
		"malformed"
	)
		return finish({ kind: "failed", exit: "malformed" }, null);

	return finish({ kind: "passed" }, revision.text);
}
