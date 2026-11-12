import { measurementInput } from "../cli/measurement.ts";
import {
	explainPrompt,
	explainFindings,
	EXPLAIN_MAX_TOKENS,
	EXPLAIN_WALL_MS,
} from "../../src/views/explain.ts";
import { measurementPrimary } from "../../src/views/metrics.ts";
import {
	allocateMeasurement,
	measurementDir,
	sampled,
	scorerDigest,
	scorerPrompt,
	scorerAnswer,
	scorerTouched,
	enqueueScore,
	previousScore,
	scoreHistory,
	automaticScoreEnrolled,
	FAMILY_NOTE,
	type MeasurementKind,
	type MeasurementOwner,
} from "../../src/maintenance/scorers.ts";
import {
	regularText,
	exclusive,
	privateDir,
	present,
} from "../../src/contract/artifacts.ts";
import type { PlatformProfile } from "../../src/trust/platform.ts";
import { writeCadenceFile } from "../../src/maintenance/cadence.ts";
import { GitHubTicketAdapter } from "../../src/github/adapter.ts";
import { GitHubPublicationApi } from "../../src/github/publish.ts";
import {
	objectOf,
	parseJson as parseJsonText,
	textOf,
	textsOf,
	countOf,
} from "../../src/core/json.ts";
import type { Exec } from "../../src/github/exec.ts";
import { digestOf, type Digest, isDigest } from "../../src/core/run.ts";
import {
	type LedgerRow,
	indexScores,
	parseScores,
	type ScoreEvent,
} from "../../src/ledger/schema.ts";
import {
	parseAdoption,
	parseAnchor,
	appendRun,
} from "../../src/ledger/append.ts";
import { parseRetry } from "../../src/ledger/outbox.ts";
import { ledgerApiOf } from "../../src/ledger/git.ts";
import {
	STAGE_CLEANUP_RESERVE_MS,
	isPinnedGrader,
	type WorkflowConfig,
} from "../../src/config/schema.ts";
import type { RepoSlug } from "../../src/trust/platform.ts";
import { readdirSync, lstatSync } from "node:fs";
import { readdir } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import type { StageExecutor } from "../../src/controller/launch.ts";
import type { Log } from "../../src/controller/orchestrator.ts";
import { readStageReceipt } from "../sandbox/receipts.ts";
import { writeAtomic } from "./state.ts";
import { fileLedgerOutbox } from "./outbox.ts";
import { cadenceSwitches, runImprovementTrigger } from "./cadence.ts";

const scorePumps = new Map<string, Promise<boolean | null>>();

export const SCORE_PUBLISH_SLICE_MS = 5_000;

export type ScorePumpInput = {
	stateDir: string;
	repo: RepoSlug;
	exec: Exec;
	platform: PlatformProfile;
	log: Log;
	clock?: () => number;
	config?: WorkflowConfig;
};

export async function pumpScoreOutbox(
	input: ScorePumpInput,
): Promise<boolean | null> {
	const key = resolve(input.stateDir);
	const previous = scorePumps.get(key) ?? Promise.resolve(null);

	const pending = previous.then(async () => {
		let published: boolean | null = null;

		try {
			published = await publishScoreOutbox(input);
		} catch {
			input.log("score_pump_failed", {});
		}

		try {
			await runImprovementTrigger(input);
		} catch {
			input.log("improvement_trigger_failed", {});
		}

		return published;
	});

	scorePumps.set(key, pending);

	try {
		return await pending;
	} finally {
		if (scorePumps.get(key) === pending) scorePumps.delete(key);
	}
}

async function publishScoreOutbox(input: ScorePumpInput) {
	const root = join(input.stateDir, "measure", "score-outbox");

	const clock = input.clock ?? Date.now;
	const deadline = clock() + SCORE_PUBLISH_SLICE_MS;

	const api = ledgerApiOf(
		new GitHubPublicationApi(
			input.exec,
			input.repo,
			input.platform,
			{},
			async () => true,
			undefined,
			{ now: clock, sliceMs: SCORE_PUBLISH_SLICE_MS, callMs: 5_000 },
		),
		"scores",
	);

	api.startJob?.();

	let anchor = present(join(root, "anchor.json"))
		? parseAnchor(parseJsonText(regularText(join(root, "anchor.json"))))
		: null;

	if (present(join(root, "anchor.json")) && anchor === null)
		throw new Error("score_anchor_invalid");
	const history = scoreHistory(input.stateDir);

	if (
		anchor === null &&
		history.some((event) => present(join(root, event.id, "published.json")))
	)
		throw new Error("score_anchor_orphaned");

	if (anchor === null && history.length > 0) {
		const runs = await fileLedgerOutbox(input.stateDir).anchor();

		// Both streams share a ref. Reuse proven ancestry, never the runs-file prefix.
		if (runs !== null && runs !== "invalid" && runs !== "orphaned") {
			const head = await api.commit(runs.tipSha);
			const file = await api.file(head.tree);
			parseScores(file.bytes);
			anchor = {
				v: 1,
				rootSha: runs.rootSha,
				tipSha: head.sha,
				blobSha: file.blob,
				byteLength: file.bytes.length,
				prefixDigest: digestOf(file.bytes),
			};
		}
	}

	for (const event of history) {
		const dir = join(root, event.id);

		if (present(join(dir, "published.json"))) continue;

		const retry = present(join(dir, "retry.json"))
			? parseRetry(parseJsonText(regularText(join(dir, "retry.json"))))
			: null;

		if (present(join(dir, "retry.json")) && retry === null)
			throw new Error("score_retry_invalid");

		if (retry?.blocked || (retry !== null && retry.nextAt > clock())) continue;
		const bytes = Buffer.from(`${JSON.stringify(event)}\n`);
		const adoptionPath = join(dir, "adoption.json");
		let result: Awaited<ReturnType<typeof appendRun>>;

		do {
			const cursor = present(adoptionPath)
				? parseAdoption(parseJsonText(regularText(adoptionPath)))
				: null;

			if (present(adoptionPath) && cursor === null)
				throw new Error("score_adoption_invalid");
			result = await appendRun(
				api,
				{ runId: event.id, bytes, digest: digestOf(bytes), date: event.at },
				anchor,
				3,
				{
					cursor,
					save: (value) =>
						writeAtomic(adoptionPath, `${JSON.stringify(value)}\n`),
				},
				false,
				indexScores,
			);
		} while (
			result.kind === "deferred" &&
			result.reason === "adoption_pending" &&
			clock() < deadline
		);

		if (result.kind === "published") {
			if (
				!(await writeAtomic(
					join(root, "anchor.json"),
					`${JSON.stringify(result.anchor)}\n`,
				))
			)
				throw new Error("score_anchor_unwritable");
			anchor = result.anchor;
			exclusive(
				join(dir, "published.json"),
				`${JSON.stringify({ tip: result.tip, line: result.line })}\n`,
			);
		} else {
			const attempts = (retry?.attempts ?? 0) + 1;
			await writeAtomic(
				join(dir, "retry.json"),
				`${JSON.stringify({ attempts, nextAt: clock() + Math.min(60_000, 1000 * 2 ** Math.min(attempts, 6)), reason: result.reason, blocked: result.kind === "blocked" })}\n`,
			);
			input.log("score_publication_pending", {
				id: event.id,
				reason: result.reason,
			});
			break;
		}

		if (clock() >= deadline) break;
	}

	return scoreHistory(input.stateDir).every((event) =>
		present(join(root, event.id, "published.json")),
	);
}

async function syncScoreHistory(input: {
	stateDir: string;
	repo: RepoSlug;
	exec: Exec;
	platform: PlatformProfile;
}) {
	const api = ledgerApiOf(
		new GitHubPublicationApi(
			input.exec,
			input.repo,
			input.platform,
			{},
			async () => true,
		),
		"scores",
	);

	const tip = await api.ref();

	if (tip === null) return;
	const head = await api.commit(tip);
	const file = await api.file(head.tree);

	for (const [index, event] of parseScores(file.bytes).entries()) {
		enqueueScore(input.stateDir, event);

		if (
			!(await writeAtomic(
				join(input.stateDir, "measure/score-outbox", event.id, "stream.json"),
				`${JSON.stringify({ line: index + 1 })}\n`,
			))
		)
			throw new Error("score_history_unwritable");
	}
}

/** Only controller-written patch metadata is inspected; no patch or transcript enters the judge. */
function measurementScorerTouched(
	stateDir: string,
	runId: Digest,
	row: LedgerRow,
): boolean {
	if (row.artifacts.kind !== "built" && row.artifacts.kind !== "candidate")
		return false;
	const root = join(stateDir, "patches");

	const names = readdirSync(root).filter(
		(name) => name === runId || new RegExp(`^${runId}-r[0-9]+$`).test(name),
	);

	let found = false;

	for (const name of names) {
		if (!lstatSync(join(root, name)).isDirectory()) continue;
		const raw = regularText(join(root, name, "collected.json"), 128 * 1024);
		const receipt = objectOf(parseJsonText(raw));
		const paths = textsOf(receipt?.changedPaths);

		if (
			receipt?.runId !== runId ||
			paths === null ||
			regularText(join(root, `${name}.json`), 128 * 1024) !== raw
		)
			throw new Error("scorer_change_evidence_unavailable");
		found = true;

		if (scorerTouched(paths)) return true;
	}

	if (!found) throw new Error("scorer_change_evidence_unavailable");

	return false;
}

type MeasurementContext = {
	stateDir: string;
	repo: RepoSlug;
	exec: Exec;
	platform: PlatformProfile;
	executor: StageExecutor;
	log: Log;
	signal?: AbortSignal;
};

export async function controllerMeasure(
	input: MeasurementContext & {
		kind: MeasurementKind;
		runId: Digest;
		config: WorkflowConfig;
		scorerId?: string;
		onLaunch?: () => void;
		preflighted?: boolean;
	},
) {
	const start = Date.now();
	const primary = measurementPrimary(input.stateDir, input.repo);
	const model = input.config.grader?.model;

	if (model === undefined || !isPinnedGrader(model))
		throw new Error("grader_unpinned");

	const scorer =
		input.kind === "score"
			? (input.config.scorers?.find(
					(s) => s.id === (input.scorerId ?? "outcome-quality"),
				) ?? null)
			: null;

	if (input.kind === "score" && scorer === null)
		throw new Error("scorer_unknown");

	if (!present(join(input.stateDir, "ledger", input.runId, "row.json")))
		throw new Error("ledger_row_unavailable");

	const evidence = await measurementInput(
		input.stateDir,
		input.runId,
		scorer?.includeChildren ?? false,
		scorer !== null,
	);

	if (evidence.input.ledger.row.repo !== input.repo)
		throw new Error("measurement_repo_mismatch");

	const touched =
		scorer !== null &&
		measurementScorerTouched(
			input.stateDir,
			input.runId,
			evidence.input.ledger.row,
		);

	if (scorer !== null) await syncScoreHistory(input);

	const execution = allocateMeasurement(
		input.stateDir,
		input.kind,
		input.runId,
	);

	const owner: MeasurementOwner = {
		repo: input.repo,
		identity: execution.identity,
		executionId: execution.executionId,
		kind: input.kind,
		runId: input.runId,
		model,
		maxTokens:
			input.kind === "explain"
				? EXPLAIN_MAX_TOKENS
				: (input.config.grader?.maxTokens ?? 16_000),
		at: new Date(Math.floor(Date.now() / 1000) * 1000).toISOString(),
		inputDigest: evidence.digest,
		scorer,
		supersedes:
			scorer === null
				? null
				: previousScore(input.stateDir, input.runId, scorer.id),
	};

	const ownerPath = join(execution.dir, "owner.json");
	exclusive(ownerPath, `${JSON.stringify(owner)}\n`);
	exclusive(join(execution.dir, "input.json"), evidence.bytes);
	const workspace = join(execution.dir, "workspace");
	privateDir(workspace);

	const prompt =
		scorer === null ? explainPrompt(evidence) : scorerPrompt(scorer, evidence);

	exclusive(join(execution.dir, "prompt.txt"), prompt);
	let launched = false;
	let reason = touched ? "scorer_touched" : "sandbox_unavailable";

	if (!touched && (input.preflighted || (await input.executor.preflight()))) {
		const wallMs = EXPLAIN_WALL_MS - (Date.now() - start);

		if (wallMs <= STAGE_CLEANUP_RESERVE_MS)
			throw new Error("measurement_wall_exhausted");

		const signal = AbortSignal.any([
			input.signal ?? new AbortController().signal,
			AbortSignal.timeout(wallMs - STAGE_CLEANUP_RESERVE_MS),
		]);

		const launch = await input.executor.launch({
			runId: execution.executionId,
			stage: "maintain",
			attempt: 1,
			measurement: {
				kind: input.kind,
				scoredRunId: input.runId,
				seq: execution.seq,
			},
			workspace,
			prompt,
			tools: [],
			skills: [],
			settings: {
				model,
				fallback: null,
				maxTokens: owner.maxTokens,
				budget: { maxTurns: 2, wallMs, stallMs: Math.min(120_000, wallMs) },
			},
			remainingRunTokens: owner.maxTokens,
			signal,
			progress: () => undefined,
		});

		if (launch.kind === "started") {
			launched = true;
			input.onLaunch?.();
			reason = (await launch.done).kind;
		}
	}

	const { executionCharge } = await import("../sandbox/receipts.ts");
	const runtime = join(execution.dir, "runtime");
	const native = await readStageReceipt(join(runtime, "receipt.json"));
	const charge = await executionCharge(runtime);

	const usage = {
		tokens: launched
			? Math.max(native?.usage.total ?? owner.maxTokens, charge?.total ?? 0)
			: 0,
		wallMs: Date.now() - start,
		exact:
			!launched ||
			(native !== null && charge !== null && charge.uncertain === 0),
	};

	const valid =
		native?.record?.runId === execution.executionId &&
		native.record.measurementIdentity === owner.identity &&
		native.record.stage === "maintain" &&
		native.outcome.kind === "passed" &&
		usage.tokens <= owner.maxTokens &&
		usage.wallMs <= EXPLAIN_WALL_MS;

	const observed = textOf(objectOf(native?.record?.models)?.observed);

	const modelMatches =
		observed === model || observed === model.slice("openai/".length);

	if (launched && !modelMatches && native?.outcome.kind === "passed")
		reason = "judge_model_mismatch";

	if (usage.tokens > owner.maxTokens) reason = "measurement_tokens_exhausted";

	if (usage.wallMs > EXPLAIN_WALL_MS) reason = "measurement_wall_exhausted";

	const output =
		valid && modelMatches
			? regularText(join(runtime, "output.txt"), 64 * 1024)
			: null;

	if (scorer !== null) {
		const answer = output === null ? null : scorerAnswer(output, scorer);

		const event: ScoreEvent = {
			id: execution.eventId,
			scoredRunId: input.runId,
			scorerId: scorer.id,
			scorerDigest: scorerDigest(scorer, model),
			inputDigest: evidence.digest,
			includeChildren: scorer.includeChildren,
			label: answer?.label ?? null,
			score: answer?.score ?? null,
			passingScore: scorer.passingScore,
			reasoning:
				answer?.reasoning ??
				(touched
					? "Candidate touched a scorer source file."
					: output === null
						? `Scoring did not produce a bounded, pinned answer (${reason}).`
						: "Judge returned an undeclared label or malformed answer."),
			judgeModel: model,
			judgeFamily: "openai",
			familyNote: FAMILY_NOTE,
			usage,
			supersedes: owner.supersedes,
			at: owner.at,
			status: touched ? "voided" : answer === null ? "failed" : "scored",
			voided: touched ? "scorer_touched" : null,
		};

		enqueueScore(input.stateDir, event);
		exclusive(
			join(execution.dir, "result.json"),
			`${JSON.stringify({ usage, launched, event })}\n`,
		);
		await pumpScoreOutbox(input);

		const root = join(input.stateDir, "measure/score-outbox");
		const published = present(join(root, event.id, "published.json"));

		const queuedScores = scoreHistory(input.stateDir).filter(
			(other) =>
				other.id !== event.id &&
				!present(join(root, other.id, "published.json")),
		).length;

		return {
			primary,
			kind: "score" as const,
			identity: owner.identity,
			event,
			passing: event.score === null ? null : event.score >= event.passingScore,
			persisted: true,
			published,
			publication: published ? "published" : "queued_for_controller",
			queuedScores,
		};
	}

	const findings = output === null ? null : explainFindings(output, evidence);
	exclusive(
		join(execution.dir, "result.json"),
		`${JSON.stringify({ usage, launched, findings })}\n`,
	);

	return {
		primary,
		kind: "explain" as const,
		identity: owner.identity,
		findings,
		usage,
		reason:
			findings === null
				? output === null
					? reason
					: "invalid_findings"
				: "explained",
	};
}

export function controllerMeasurements(input: MeasurementContext) {
	const adapter = new GitHubTicketAdapter({
		exec: input.exec,
		repo: input.repo,
	});

	const queued = new Set<string>();
	const eligible = new Map<string, { runId: Digest; config: WorkflowConfig }>();
	let pending = Promise.resolve();
	let occupied = 0;

	const terminal = (runId: Digest, config: WorkflowConfig) => {
		for (const scorer of config.scorers ?? []) {
			const key = `${runId}-${scorer.id}`;

			if (queued.has(key) || !sampled(runId, scorer)) continue;

			const marker = join(
				input.stateDir,
				"measure",
				"automatic",
				`${key}.json`,
			);

			if (automaticScoreEnrolled(input.stateDir, runId, scorer.id)) {
				eligible.delete(key);
				continue;
			}

			eligible.set(key, { runId, config });
			queued.add(key);
			pending = pending.then(async () => {
				occupied = 1;

				try {
					if (input.signal?.aborted) return;

					if (!(await cadenceSwitches(input.stateDir, adapter))) {
						input.log("measurement_skipped", { runId, reason: "disabled" });

						return;
					}

					if (!(await input.executor.preflight())) return;

					const report = await controllerMeasure({
						...input,
						kind: "score",
						runId,
						config,
						scorerId: scorer.id,
						preflighted: true,
						onLaunch: () => {
							privateDir(dirname(marker));
							writeCadenceFile(
								marker,
								`${JSON.stringify({ runId, scorerId: scorer.id, launched: true })}\n`,
							);
							eligible.delete(key);
						},
					});

					eligible.delete(key);

					if (report.kind === "score") {
						privateDir(dirname(marker));
						writeCadenceFile(
							marker,
							JSON.stringify({ runId, scorerId: scorer.id, settled: true }),
						);
					}
				} catch (error) {
					eligible.delete(key);

					const reason =
						error instanceof Error &&
						/^[a-z][a-z0-9_]{0,95}$/.test(error.message)
							? error.message
							: "measurement_prelaunch_failed";

					if (!automaticScoreEnrolled(input.stateDir, runId, scorer.id)) {
						const model = config.grader?.model;

						if (model === undefined) throw new Error("grader_unpinned");

						const execution = allocateMeasurement(
							input.stateDir,
							"score",
							runId,
						);

						const usage = { tokens: 0, wallMs: 0, exact: true };

						const event: ScoreEvent = {
							id: execution.eventId,
							scoredRunId: runId,
							scorerId: scorer.id,
							scorerDigest: scorerDigest(scorer, model),
							inputDigest: digestOf(
								JSON.stringify({ unavailable: reason, runId }),
							),
							includeChildren: scorer.includeChildren,
							label: null,
							score: null,
							passingScore: scorer.passingScore,
							reasoning: `Automatic scoring failed before launch (${reason}). Use score --run to retry on demand.`,
							judgeModel: model,
							judgeFamily: "openai",
							familyNote: FAMILY_NOTE,
							usage,
							supersedes: previousScore(input.stateDir, runId, scorer.id),
							at: new Date().toISOString(),
							status: "failed",
							voided: null,
						};

						exclusive(
							join(execution.dir, "owner.json"),
							JSON.stringify({
								repo: input.repo,
								identity: execution.identity,
								executionId: execution.executionId,
								kind: "score",
								runId,
								model,
								maxTokens: config.grader?.maxTokens ?? 16_000,
								at: event.at,
								inputDigest: event.inputDigest,
								scorer,
								supersedes: event.supersedes,
							}),
						);
						enqueueScore(input.stateDir, event);
						exclusive(
							join(execution.dir, "result.json"),
							JSON.stringify({ usage, launched: false, event }),
						);
						privateDir(dirname(marker));
						writeCadenceFile(
							marker,
							JSON.stringify({
								runId,
								scorerId: scorer.id,
								settled: true,
								reason,
							}),
						);
					}

					input.log("measurement_failed", { runId, reason });
				} finally {
					queued.delete(key);
					occupied = 0;
				}
			});
		}
	};

	return {
		occupied: () => occupied,
		terminal,
		retry() {
			for (const { runId, config } of eligible.values())
				terminal(runId, config);
		},
		stop: () => pending,
	};
}

export async function measurementCharges(stateDir: string, repo: string) {
	const { executionCharge } = await import("../sandbox/receipts.ts");
	let tokens = 0;
	let executions = 0;
	let uncertainRequests = 0;
	let exact = true;

	for (const kind of ["score", "explain"] as const) {
		const root = join(stateDir, "measure", kind);

		for (const runId of await readdir(root).catch(() => [])) {
			if (!isDigest(runId)) continue;

			for (const seq of await readdir(join(root, runId))) {
				if (!/^[1-9][0-9]*$/.test(seq)) continue;
				const dir = measurementDir(stateDir, kind, runId, Number(seq));

				const owner = present(join(dir, "owner.json"))
					? objectOf(parseJsonText(regularText(join(dir, "owner.json"))))
					: null;

				if (owner !== null && owner.repo !== repo) continue;

				const result = present(join(dir, "result.json"))
					? objectOf(parseJsonText(regularText(join(dir, "result.json"))))
					: null;

				const usage = objectOf(result?.usage);
				const charge = await executionCharge(join(dir, "runtime"));
				executions++;
				tokens += Math.max(
					(owner === null ? null : countOf(usage?.tokens)) ??
						countOf(owner?.maxTokens) ??
						EXPLAIN_MAX_TOKENS,
					charge?.total ?? 0,
				);
				uncertainRequests += charge?.uncertain ?? 0;
				exact &&=
					owner !== null &&
					usage?.exact === true &&
					(charge?.uncertain ?? 0) === 0;
			}
		}
	}

	return {
		executions,
		uncertainRequests,
		tokens: {
			kind: exact ? "exact" : "lower_bound",
			unit: "tokens",
			total: tokens,
		},
		money: { kind: "unavailable", reason: "provider_not_reported" },
	};
}
