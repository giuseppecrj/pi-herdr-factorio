import { lstat, readdir, readFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { readPatch } from "../../src/candidate/build.ts";
import { parseBaseReceipt } from "../../src/candidate/diagnosis.ts";
import { candidateGenerations } from "../../src/candidate/handoff.ts";
import type { CandidateState } from "../../src/candidate/state.ts";
import {
	assessmentBinding,
	validationDir,
} from "../../src/candidate/validation.ts";
import {
	fileArtifacts,
	readStoredContract,
} from "../../src/contract/artifacts.ts";
import {
	countOf,
	fieldOf as jsonField,
	objectOf,
	parseJson as parseJsonText,
	textOf,
	type JsonValue,
} from "../../src/core/json.ts";
import { digestOf, isDigest, type Digest } from "../../src/core/run.ts";
import { STAGE_ORDER, type Stage } from "../../src/core/stages.ts";
import {
	contextPolicy,
	ledgerModelOf,
	type LedgerRow,
} from "../../src/ledger/schema.ts";
import {
	terminalFailureOf,
	type TerminalEvidence,
} from "../../src/ledger/terminal.ts";
import { cadenceCharges } from "../../src/maintenance/cadence.ts";
import type { Log } from "../../src/controller/orchestrator.ts";
import { fileAdmissionStore } from "../../src/trust/admission.ts";
import type { RepoSlug } from "../../src/trust/platform.ts";
import { readStageReceipt } from "../sandbox/receipts.ts";
import { measurementCharges } from "./measurement.ts";
import { validLedgerInstant } from "./outbox.ts";
import { fileRunAccounting, parseClaim } from "./state.ts";

const EXECUTION_NAME =
	/^(specify|accept|build|review)(?:-r[0-9]+)?-[1-9][0-9]*(?:\.[1-9][0-9]*)?$/;

/** Receipt coverage is independent of token splits and wall-time accounting. */
async function tokenCoverage(stateDir: string, runId: Digest) {
	const { executionCharge } = await import("../sandbox/receipts.ts");
	const root = join(resolve(stateDir), "stages", runId);

	const names = await readdir(root).catch((error: NodeJS.ErrnoException) =>
		error.code === "ENOENT" ? [] : null,
	);

	const attempts = await fileRunAccounting(stateDir).attempts(runId);
	const stages = new Map<string, boolean>();
	const covered = new Set<string>();

	for (const name of names ?? []) {
		const stage = EXECUTION_NAME.exec(name)?.[1];

		if (stage === undefined) continue;
		const receipt = await readStageReceipt(join(root, name, "receipt.json"));
		const charge = await executionCharge(join(root, name)).catch(() => null);

		const valid =
			receipt !== null &&
			charge !== null &&
			jsonField(receipt.record, "runId") === runId &&
			jsonField(receipt.record, "stage") === stage &&
			jsonField(receipt.record, "attempt") ===
				Number(/-([1-9][0-9]*)(?:\.[1-9][0-9]*)?$/.exec(name)?.[1]) &&
			jsonField(receipt.record, "version") === 1;

		stages.set(stage, (stages.get(stage) ?? true) && valid);

		if (valid) covered.add(name);
	}

	for (const attempt of attempts ?? []) {
		const valid =
			covered.has(`${attempt.stage}-r${attempt.round}-${attempt.attempt}`) ||
			(attempt.round === 0 &&
				covered.has(`${attempt.stage}-${attempt.attempt}`));

		stages.set(attempt.stage, (stages.get(attempt.stage) ?? true) && valid);
	}

	return {
		stages,
		readable: names !== null && attempts !== null,
		complete:
			stages.size > 0 &&
			names !== null &&
			attempts !== null &&
			[...stages.values()].every(Boolean),
	};
}

/** Project only validated controller-private records; never scan a workspace. */
export async function readTerminalEvidence(
	stateDir: string,
	runId: Digest,
	floor: number,
	candidate: CandidateState | null,
): Promise<TerminalEvidence> {
	const { executionCharge, executionEfficiency } = await import(
		"../sandbox/receipts.ts"
	);

	const { aggregateEfficiency, unknownEfficiency } = await import(
		"../../src/core/execution.ts"
	);

	const root = join(resolve(stateDir), "stages", runId);

	const listed = await readdir(root).catch((error: NodeJS.ErrnoException) =>
		error.code === "ENOENT" ? [] : null,
	);

	const names = (listed ?? [])
		.filter((name) => EXECUTION_NAME.test(name))
		.sort((a, b) => a.localeCompare(b, undefined, { numeric: true }));

	const coverage = await tokenCoverage(stateDir, runId);
	const accounting = fileRunAccounting(stateDir);
	const attempts = await accounting.attempts(runId);
	const start = await accounting.start(runId);
	const known = <T>(value: T) => ({ kind: "known" as const, value });

	const missing = {
		kind: "unavailable" as const,
		reason: "receipt_missing" as const,
	};

	const stages = new Map<
		Stage,
		{
			total: number;
			uncertain: number;
			wall: number;
			wallComplete: boolean;
			efficiency: import("../../src/core/execution.ts").EfficiencyFacts[];
		}
	>();

	const models = new Map<
		string,
		NonNullable<ReturnType<typeof ledgerModelOf>>
	>();

	const digests = new Set<Digest>();

	const executions: {
		facts: import("../../src/core/execution.ts").EfficiencyFacts;
		started: number | null;
	}[] = [];

	let total = 0,
		uncertain = 0,
		parent = 0,
		children = 0;

	let splitComplete = true;

	const stageOf = (stage: Stage) => {
		let value = stages.get(stage);

		if (value === undefined) {
			value = {
				total: 0,
				uncertain: 0,
				wall: 0,
				wallComplete: true,
				efficiency: [],
			};
			stages.set(stage, value);
		}

		return value;
	};

	for (const name of names) {
		const stageName = EXECUTION_NAME.exec(name)?.[1];

		if (
			stageName !== "specify" &&
			stageName !== "accept" &&
			stageName !== "build" &&
			stageName !== "review"
		)
			continue;
		const dir = join(root, name);
		const charge = await executionCharge(dir).catch(() => null);
		const summary = stageOf(stageName);

		const efficiency = await executionEfficiency(dir).catch(() =>
			unknownEfficiency(),
		);

		const high = objectOf(
			parseJsonText(
				await readFile(join(dir, "usage.json"), "utf8").catch(() => ""),
			),
		);

		summary.efficiency.push(efficiency);
		executions.push({
			facts: efficiency,
			started: countOf(jsonField(high, "startedAt")),
		});
		summary.total += charge?.total ?? 0;
		summary.uncertain += charge?.uncertain ?? 0;
		total += charge?.total ?? 0;
		uncertain += charge?.uncertain ?? 0;
		const receipt = await readStageReceipt(join(dir, "receipt.json"));

		const valid =
			receipt !== null &&
			jsonField(receipt.record, "runId") === runId &&
			jsonField(receipt.record, "stage") === stageName &&
			jsonField(receipt.record, "version") === 1;

		if (valid) {
			summary.wall += receipt.wallMs;
			const usage = objectOf(jsonField(receipt.record, "usage"));
			const p = countOf(jsonField(usage, "parent"));
			const c = countOf(jsonField(usage, "children"));

			if (
				p === null ||
				c === null ||
				p + c > receipt.usage.total ||
				receipt.usage.unreadChildren > 0
			)
				splitComplete = false;
			else {
				parent += p;
				children += c;
			}
		} else {
			splitComplete = false;
			summary.wallComplete = false;
		}

		const sessionNames = [
			"draft",
			"review",
			"revision",
			"code-review",
			"security-review",
			"simplify",
			"ultrareview",
		];

		const sessions = (
			await readdir(dir, { withFileTypes: true }).catch(() => [])
		).filter(
			(entry) => entry.isDirectory() && sessionNames.includes(entry.name),
		);

		const paths = [
			join(dir, "receipt.json"),
			...sessions.map((entry) => join(dir, entry.name, "receipt.json")),
		];

		for (const path of paths) {
			const saved = await readStageReceipt(path);

			if (
				saved === null ||
				jsonField(saved.record, "runId") !== runId ||
				jsonField(saved.record, "stage") !== stageName ||
				jsonField(saved.record, "version") !== 1
			)
				continue;
			const bytes = await readFile(path);
			digests.add(digestOf(bytes));

			if (sessions.length > 0 && path === paths[0]) continue;
			const rawModels = objectOf(jsonField(saved.record, "models"));
			const versions = objectOf(jsonField(saved.record, "versions"));

			const runtime = {
				pi: jsonField(versions, "pi") ?? null,
				agents: jsonField(versions, "piHerdrAgents") ?? null,
				pstack: jsonField(versions, "piHerdrPstack") ?? null,
				assetsDigest: jsonField(saved.record, "assetsDigest") ?? null,
			};

			for (const identity of [
				rawModels,
				objectOf(jsonField(saved.record, "fallback")),
			]) {
				if (identity === null) continue;
				const observed = textOf(jsonField(identity, "observed"));

				const input = {
					requested: jsonField(identity, "requested") ?? null,
					observed:
						observed === null
							? { kind: "unavailable", reason: "provider_not_reported" }
							: known(observed),
					providerVersion: {
						kind: "unavailable",
						reason: "provider_not_reported",
					},
					runtime: known(runtime),
					executions: 1,
				};

				const projected =
					ledgerModelOf(input) ?? ledgerModelOf({ ...input, runtime: missing });

				if (projected !== null) {
					const key = JSON.stringify([
						projected.requested,
						projected.observed,
						projected.runtime,
					]);

					const previous = models.get(key);
					models.set(key, {
						...projected,
						executions: (previous?.executions ?? 0) + 1,
					});
				}
			}
		}
	}

	const uncovered = floor > total;
	total = Math.max(total, floor);

	const summaries: Extract<LedgerRow["stages"], { kind: "known" }>["value"] =
		[];

	for (const attempt of attempts ?? []) stageOf(attempt.stage);

	for (const [stage, data] of stages) {
		const ends = attempts?.filter((attempt) => attempt.stage === stage);

		const counts = {
			passed: 0,
			failed: 0,
			interrupted: 0,
			refused: 0,
			budgetExhausted: 0,
			aborted: 0,
		};

		for (const end of ends ?? []) {
			const key = {
				completed: "passed",
				model_failure: "failed",
				interrupted: "interrupted",
				refused: "refused",
				base_refused: "refused",
				budget_stop: "budgetExhausted",
				aborted: "aborted",
			} as const;

			counts[key[end.disposition]]++;
		}

		summaries.push({
			stage,
			efficiency: aggregateEfficiency(data.efficiency),
			wallMs: data.wallComplete
				? { kind: "exact", unit: "milliseconds", total: data.wall }
				: {
						kind: "lower_bound",
						unit: "milliseconds",
						total: data.wall,
						reason: "receipt_missing",
					},
			attempts: ends == null || start == null ? missing : known(counts),
			tokens:
				data.uncertain > 0
					? {
							kind: "uncertain",
							unit: "tokens",
							total: data.total,
							reason: "request_unsettled",
						}
					: coverage.readable && coverage.stages.get(stage) === true
						? { kind: "exact", unit: "tokens", total: data.total }
						: {
								kind: "lower_bound",
								unit: "tokens",
								total: data.total,
								reason: "receipt_missing",
							},
		});
	}

	summaries.sort(
		(a, b) => STAGE_ORDER.indexOf(a.stage) - STAGE_ORDER.indexOf(b.stage),
	);

	const orderedModels = [...models]
		.sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
		.map(([, model]) => model);

	const artifactPrefix = async (): Promise<LedgerRow["artifacts"]> => {
		const contract = await readStoredContract(stateDir, runId);

		if (contract.kind !== "found") return { kind: "admission" };

		const suite = await fileArtifacts(stateDir).read(
			runId,
			contract.contract,
			contract.digest,
		);

		if (suite.kind !== "found")
			return { kind: "contract", contractDigest: contract.digest };

		const patch = readPatch(stateDir, {
			runId,
			baseSha: contract.contract.base.sha,
			contractDigest: contract.digest,
			acceptanceDigest: suite.receipt.acceptanceDigest,
		});

		return patch.kind === "found"
			? {
					kind: "built",
					contractDigest: contract.digest,
					acceptanceDigest: suite.receipt.acceptanceDigest,
					patchDigest: patch.receipt.patchDigest,
				}
			: {
					kind: "acceptance",
					contractDigest: contract.digest,
					acceptanceDigest: suite.receipt.acceptanceDigest,
				};
	};

	const invalid = {
		kind: "unavailable" as const,
		reason: "receipt_invalid" as const,
	};

	const evidence: TerminalEvidence =
		listed === null
			? {
					artifacts: await artifactPrefix(),
					stages: invalid,
					models: invalid,
					usage: {
						tokens: {
							kind: "lower_bound",
							unit: "tokens",
							total,
							reason: "receipt_invalid",
						},
						parentTokens: invalid,
						childTokens: invalid,
						unattributedTokens: invalid,
						money: { kind: "unavailable", reason: "provider_not_reported" },
					},
					redactedReceiptDigests: [],
				}
			: {
					artifacts: await artifactPrefix(),
					stages:
						summaries.length === 0 && start == null
							? missing
							: known(summaries),
					models:
						models.size === 0 && (names.length > 0 || start == null)
							? missing
							: known(orderedModels),
					usage: {
						tokens:
							uncertain > 0
								? {
										kind: "uncertain",
										unit: "tokens",
										total,
										reason: "request_unsettled",
									}
								: coverage.complete && !uncovered
									? { kind: "exact", unit: "tokens", total }
									: {
											kind: "lower_bound",
											unit: "tokens",
											total,
											reason: "receipt_missing",
										},
						parentTokens: splitComplete ? known(parent) : missing,
						childTokens: splitComplete ? known(children) : missing,
						unattributedTokens:
							splitComplete && parent + children <= total
								? known(total - parent - children)
								: missing,
						money: { kind: "unavailable", reason: "provider_not_reported" },
					},
					redactedReceiptDigests: [...digests].sort(),
				};

	const generationGates: Record<string, Digest> = {};

	const admittedPolicy = start == null ? null : contextPolicy(start.context);

	if (admittedPolicy?.gates.kind === "known")
		generationGates[admittedPolicy.gates.value.sourceSha] =
			admittedPolicy.gates.value.digest;

	for (const generation of candidate?.kind === "selected"
		? candidateGenerations(candidate)
		: []) {
		const verdict = generation.verdict;
		const expectedSha = verdict?.gateSha ?? generation.intent.baseSha;

		const dir = validationDir(
			stateDir,
			runId,
			generation.intent.round,
			generation.intent.generation,
		);

		try {
			const pin = objectOf(
				parseJsonText(await readFile(join(dir, "gate-policy.json"), "utf8")),
			);

			const digest = textOf(jsonField(pin, "digest"));

			if (
				jsonField(pin, "v") === 1 &&
				jsonField(pin, "runId") === runId &&
				jsonField(pin, "round") === generation.intent.round &&
				jsonField(pin, "generation") === generation.intent.generation &&
				jsonField(pin, "sourceSha") === expectedSha &&
				digest !== null &&
				isDigest(digest)
			)
				generationGates[expectedSha] = digest;
		} catch {
			/* Older generations have only base qualification evidence. */
		}

		try {
			if (verdict === null) continue;

			const bindingDigest = digestOf(
				JSON.stringify(
					assessmentBinding({
						runId,
						round: generation.intent.round,
						generation: generation.intent.generation,
						verdict,
					}),
				),
			);

			const base = parseBaseReceipt(
				await readFile(
					join(
						validationDir(
							stateDir,
							runId,
							generation.intent.round,
							generation.intent.generation,
						),
						"diagnosis",
						bindingDigest,
						"refreshed-base.json",
					),
					"utf8",
				),
			);

			if (
				base?.evidence.binding.runId === runId &&
				base.evidence.binding.repo === candidate?.pin.repo &&
				base.evidence.binding.issue === candidate?.pin.issue &&
				base.evidence.binding.contractDigest ===
					candidate?.pin.contractDigest &&
				base.evidence.binding.acceptanceDigest ===
					candidate?.pin.acceptanceDigest &&
				base.evidence.binding.baseSha === verdict.gateSha &&
				base.evidence.binding.gateSha === verdict.gateSha &&
				base.evidence.source.kind === "ready"
			)
				generationGates[base.evidence.binding.baseSha] =
					base.evidence.source.gatesDigest;
		} catch {
			/* Missing historical base evidence remains unavailable. */
		}
	}

	const terminal =
		candidate?.kind === "selected" && candidate.work.kind === "terminal"
			? candidate.work.terminal
			: null;

	let mergedAt: string | undefined;

	if (terminal?.kind === "merged") {
		try {
			const metadata = objectOf(
				parseJsonText(
					await readFile(
						join(stateDir, "accounting", runId, "merge.json"),
						"utf8",
					),
				),
			);

			const at = textOf(jsonField(metadata, "mergedAt"));

			if (
				jsonField(metadata, "runId") === runId &&
				jsonField(metadata, "repo") === candidate?.pin.repo &&
				jsonField(metadata, "number") === terminal.number &&
				jsonField(metadata, "headSha") === terminal.head &&
				jsonField(metadata, "mergeSha") === terminal.mergeSha &&
				at !== null &&
				validLedgerInstant(at)
			)
				mergedAt = at;
		} catch {
			/* Public merge time is optional, never inferred from observation time. */
		}
	}

	executions.sort((a, b) => (a.started ?? 0) - (b.started ?? 0));
	const endpoints = aggregateEfficiency(executions.map((e) => e.facts));

	const efficiency = uncovered
		? unknownEfficiency()
		: aggregateEfficiency(
				[...stages.values()].map((data) =>
					aggregateEfficiency(data.efficiency),
				),
			);

	const ordered =
		!uncovered &&
		[...stages.values()].every((data) => data.efficiency.length > 0) &&
		executions.every((e) => e.started !== null);

	const omissions = efficiency.excerptOmissions;
	const caps = efficiency.sourceCapHits;

	return {
		...evidence,
		generationGates,
		mergedAt,
		efficiency: {
			...efficiency,
			firstInputTokens: ordered ? endpoints.firstInputTokens : null,
			lastInputTokens: ordered ? endpoints.lastInputTokens : null,
		},
		contextPressure:
			omissions !== null && caps !== null
				? known({ truncated: omissions > 0, promptCapHit: caps > 0 })
				: { kind: "unavailable", reason: "not_instrumented" },
	};
}

export async function readRunCharges(
	stateDir: string,
	runId: Digest,
	floor: number,
) {
	const { executionCharge } = await import("../sandbox/receipts.ts");
	const coverage = await tokenCoverage(stateDir, runId);
	let readable = true;
	let total = 0;
	let uncertainRequests = 0;
	let executions = 0;
	const root = join(resolve(stateDir), "stages", runId);

	const names = await readdir(root).catch((error: NodeJS.ErrnoException) => {
		if (error.code !== "ENOENT") readable = false;

		return [];
	});

	for (const name of names) {
		if (!EXECUTION_NAME.test(name)) continue;
		const charge = await executionCharge(join(root, name)).catch(() => null);

		if (charge === null) {
			readable = false;
			continue;
		}

		executions++;
		total += charge.total;
		uncertainRequests += charge.uncertain;
	}

	return {
		runId,
		executions,
		readable,
		uncertainRequests,
		tokens:
			coverage.complete && readable && uncertainRequests === 0 && floor <= total
				? { kind: "exact" as const, unit: "tokens" as const, total }
				: {
						kind:
							uncertainRequests > 0
								? ("uncertain" as const)
								: ("lower_bound" as const),
						unit: "tokens" as const,
						total: Math.max(floor, total),
						reason:
							uncertainRequests > 0
								? ("request_unsettled" as const)
								: ("receipt_missing" as const),
					},
		money: {
			kind: "unavailable" as const,
			reason: "provider_not_reported" as const,
		},
		attempts: await fileRunAccounting(stateDir).attempts(runId),
		terminal: await readFile(
			join(resolve(stateDir), "ledger", runId, "terminal.json"),
			"utf8",
		).then(
			(text) => terminalFailureOf(parseJsonText(text)),
			() => null,
		),
	};
}

export async function readDurableAccounting(
	stateDir: string | null,
	repo: RepoSlug,
) {
	const runs: Awaited<ReturnType<typeof readRunCharges>>[] = [];

	const available =
		stateDir !== null &&
		(await lstat(stateDir).then(
			(info) => info.isDirectory(),
			() => false,
		));

	let readable = available;

	if (stateDir !== null && available) {
		const root = join(resolve(stateDir), "claims");

		const names = await readdir(root).catch((error: NodeJS.ErrnoException) => {
			if (error.code !== "ENOENT") readable = false;

			return [];
		});

		const seen = new Set<Digest>();

		for (const name of names.sort()) {
			if (!/^[a-f0-9]{64}\.json$/.test(name)) continue;
			const text = await readFile(join(root, name), "utf8").catch(() => null);
			const claim = text === null ? null : parseClaim(text);

			if (claim === null || name !== `${claim.runId}.json`) {
				readable = false;
				continue;
			}

			if (seen.has(claim.runId)) continue;

			const admitted = await fileAdmissionStore(stateDir).read({
				repo,
				issue: claim.issue,
				eventId: claim.eventId,
			});

			if (admitted.kind === "unreadable") {
				readable = false;
				continue;
			}

			if (admitted.kind !== "found") continue;
			seen.add(claim.runId);
			const run = await readRunCharges(stateDir, claim.runId, claim.usage ?? 0);
			readable &&= run.readable;
			runs.push(run);
		}
	}

	let maintenance: ReturnType<typeof cadenceCharges> = [];

	if (available && stateDir !== null) {
		try {
			maintenance = cadenceCharges(stateDir, repo);
		} catch {
			readable = false;
		}
	}

	const measurement =
		stateDir === null || !available
			? {
					executions: 0,
					uncertainRequests: 0,
					tokens: { kind: "exact", unit: "tokens", total: 0 },
					money: { kind: "unavailable", reason: "provider_not_reported" },
				}
			: await measurementCharges(stateDir, repo);

	return {
		state: !available ? "unavailable" : readable ? "readable" : "incomplete",
		countersScope: "process",
		measurement,
		runs,
		maintenance: {
			executions: maintenance.reduce(
				(sum, charge) => sum + charge.executions,
				0,
			),
			uncertainRequests: maintenance.filter((charge) => charge.uncertain)
				.length,
			tokens: {
				kind: maintenance.every((charge) => charge.exact)
					? "exact"
					: "lower_bound",
				unit: "tokens",
				total: maintenance.reduce((sum, charge) => sum + charge.tokens, 0),
			},
			money: { kind: "unavailable", reason: "provider_not_reported" },
			entries: maintenance,
		},
	};
}

type DurableTokenUsage = { kind: string; unit: string; total: number };

type DurableUsage = DurableTokenUsage & {
	reason?: string;
	maintenance?: DurableTokenUsage;
	measurement?: DurableTokenUsage;
};

export function durableUsageOf(
	accounting: Awaited<ReturnType<typeof readDurableAccounting>>,
): JsonValue {
	const uncertain =
		accounting.runs.some((run) => run.uncertainRequests > 0) ||
		accounting.maintenance.uncertainRequests > 0 ||
		accounting.measurement.uncertainRequests > 0;

	const exact =
		accounting.state === "readable" &&
		accounting.runs.every((run) => run.tokens.kind === "exact") &&
		accounting.maintenance.tokens.kind === "exact" &&
		accounting.measurement.tokens.kind === "exact";

	if (accounting.state === "unavailable")
		return { kind: "unavailable", reason: "legacy_not_recorded" };

	const usage: DurableUsage = {
		kind: uncertain ? "uncertain" : exact ? "exact" : "lower_bound",
		unit: "tokens",
		total:
			accounting.runs.reduce((sum, run) => sum + run.tokens.total, 0) +
			accounting.maintenance.tokens.total +
			accounting.measurement.tokens.total,
		...(uncertain
			? { reason: "request_unsettled" }
			: exact
				? {}
				: { reason: "receipt_missing" }),
	};

	if (accounting.maintenance.executions > 0)
		usage.maintenance = accounting.maintenance.tokens;

	if (accounting.measurement.executions > 0)
		usage.measurement = accounting.measurement.tokens;

	return usage;
}

export async function startDurableUsage(input: {
	stateDir: string;
	repo: RepoSlug;
	log: Log;
}) {
	let current: JsonValue = {
		kind: "unavailable",
		reason: "legacy_not_recorded",
	};

	let pending: Promise<void> | null = null;

	const refresh = () => {
		pending ??= (async () => {
			try {
				current = durableUsageOf(
					await readDurableAccounting(input.stateDir, input.repo),
				);
			} catch {
				input.log("accounting_unavailable", {});
			}
		})().finally(() => {
			pending = null;
		});

		return pending;
	};

	await refresh();
	const timer = setInterval(() => void refresh(), 300_000);
	timer.unref();

	return {
		current: () => current,
		stop: async () => {
			clearInterval(timer);
			await pending;
		},
	};
}
