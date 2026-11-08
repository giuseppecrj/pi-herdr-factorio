import { lstat, readFile, readdir } from "node:fs/promises";
import { join } from "node:path";
import { parseLedger, type LedgerRow, type RunContextV2 } from "./ledger.ts";
import { digestOf } from "./run.ts";

// Coordinator defaults pending the owner's F12a design calls; metric policy, not workflow knobs.
export const METRIC_POLICY = {
	windowDays: 7,
	contextPressureThreshold: 0.1,
	restartEndedThreshold: 0.1,
	intakeDemandThreshold: 0.1,
	cleanCertifiedRound: 0,
	excludeOwnerAuthoredHeads: true,
	contextPressureSignal: "promptCapHit",
	intakeDemandUnavailable: "no_intake_signal",
	defect: { label: "factory:defect", queryLimit: 10_000 },
} as const;

// Append only: these verification runs were written with production provenance.
export const EXCLUDED_RUNS = [
	{
		runId: "199df6dc85d53522b12bded884ebe6351dffcb80f7e456d42124ab39e994489f",
		reason: "F10c verification issue 621, ledger line 13",
	},
	{
		runId: "bd3db33b9ed3951db0800d381f3ea4a61eadcc1e615091eb4024dd9b4a465f22",
		reason: "F10 fixture issue 650",
	},
	{
		runId: "89290787949a04cdbdc956f3b57356fa48c57f604823d232acba61108b266783",
		reason: "F10 fixture issue 658",
	},
] as const;

const WINDOW_MS = METRIC_POLICY.windowDays * 24 * 60 * 60 * 1000;

export type DefectIssue = {
	readonly number: number;
	readonly title: string;
	readonly body: string;
	readonly createdAt: string;
	readonly labels: readonly string[];
};

export type DefectRead =
	| { readonly kind: "known"; readonly issues: readonly DefectIssue[] }
	| { readonly kind: "unknown"; readonly reason: string };

export type InterventionRead =
	| {
			readonly kind: "known";
			readonly value: boolean;
			readonly source: "github_reviews" | "fixture" | "ledger";
	  }
	| { readonly kind: "unknown"; readonly reason: "intervention_unreadable" };

export type Interventions = ReadonlyMap<string, InterventionRead>;

type DefectResult =
	| { kind: "none" }
	| { kind: "linked"; issues: number[] }
	| { kind: "pending" }
	| { kind: "unknown"; reason: string };

type Unknown =
	| { kind: "ledger"; line: number; reason: string }
	| { kind: "ticket"; issue: number; runId: string; reason: string };

type TicketStatus =
	| "clean"
	| "landed_not_clean"
	| "not_landed"
	| "pending"
	| "unknown";

type Landing = {
	runId: string;
	pr: number | null;
	mergedAt: string | null;
	maturesAt: string | null;
	certifiedRound: number | null;
	authored: "factory" | "owner" | "not_recorded";
	intervention: InterventionRead;
	defect: DefectResult;
	status: TicketStatus;
	reasons: string[];
};

export type ReceiptDigests = ReadonlyMap<string, ReadonlySet<string>>;

export function excludedRunReason(row: {
	readonly runId: string;
	readonly provenance: LedgerRow["provenance"];
	readonly runContext?: RunContextV2;
}): string | null {
	const explicit = EXCLUDED_RUNS.find((entry) => entry.runId === row.runId);

	if (explicit) return explicit.reason;

	if (row.provenance.kind === "verification") return "verification";
	const context = row.runContext;

	if (
		context?.kind === "verification" ||
		(context?.kind === "legacy" && context.known.verification !== null)
	)
		return "verification_manifest";

	return null;
}

function indexDefects(
	rows: readonly LedgerRow[],
	repo: string,
	defects: DefectRead,
) {
	const targets = new Set(
		rows.flatMap((row) =>
			row.pr === null ? [row.issue] : [row.issue, row.pr.number],
		),
	);

	const byReference = new Map<number, DefectIssue[]>();
	const unmatched = new Set<number>();

	if (defects.kind === "unknown") return { byReference, unmatched: [] };

	const reference =
		/(?<![\w/.-])(?:(?:https?:\/\/)?(?:www\.)?github\.com\/([\w.-]+\/[\w.-]+)\/(?:issues|pull)\/([1-9]\d*)|([\w.-]+\/[\w.-]+)#([1-9]\d*)|(?:GH-|PR#|#)([1-9]\d*))(?![\w])/gi;

	for (const issue of defects.issues) {
		if (!issue.labels.includes(METRIC_POLICY.defect.label)) continue;
		const numbers = new Set<number>();

		for (const match of `${issue.title}\n${issue.body}`.matchAll(reference)) {
			const qualifiedRepo = match[1] ?? match[3];

			if (
				qualifiedRepo !== undefined &&
				qualifiedRepo.toLowerCase() !== repo.toLowerCase()
			)
				continue;
			const number = Number(match[2] ?? match[4] ?? match[5]);

			if (targets.has(number)) numbers.add(number);
		}

		if (numbers.size === 0) unmatched.add(issue.number);

		for (const number of numbers) {
			const entries = byReference.get(number) ?? [];
			entries.push(issue);
			byReference.set(number, entries);
		}
	}

	return { byReference, unmatched: [...unmatched].sort((a, b) => a - b) };
}

function landingOf(
	row: LedgerRow,
	now: number,
	defects: DefectRead,
	byReference: ReadonlyMap<number, readonly DefectIssue[]>,
	interventions: Interventions | undefined,
	unknowns: Unknown[],
): Landing | null {
	if (row.outcome.kind !== "landed") return null;
	const outcome = row.outcome;

	const mergedAt =
		outcome.mergedAt.kind === "known" ? outcome.mergedAt.value : null;

	const matures = mergedAt === null ? null : Date.parse(mergedAt) + WINDOW_MS;
	const assurance = outcome.assurance;

	const generations =
		row.artifacts.kind === "candidate" ? row.artifacts.generations : [];

	const certified =
		assurance.kind === "factory_verified"
			? generations.filter(
					(generation) =>
						generation.intentDigest === assurance.generationDigest,
				)
			: [];

	const certifiedRound =
		certified.length === 1 ? (certified[0]?.round ?? null) : null;

	const authored =
		assurance.kind === "factory_verified" && "authored" in assurance
			? assurance.authored
			: "not_recorded";

	const reasons: string[] = [];

	if (assurance.kind === "owner_override") reasons.push("owner_override");

	if (
		certifiedRound !== null &&
		certifiedRound !== METRIC_POLICY.cleanCertifiedRound
	)
		reasons.push("repair_round");

	if (authored === "owner" && METRIC_POLICY.excludeOwnerAuthoredHeads)
		reasons.push("owner_authored");

	if (row.repairRounds.kind === "known" && row.repairRounds.value.started > 0)
		reasons.push("repair_started");

	const intervention: InterventionRead =
		assurance.kind === "owner_override" || authored === "owner"
			? { kind: "known", value: true, source: "ledger" }
			: (interventions?.get(row.runId) ?? {
					kind: "unknown",
					reason: "intervention_unreadable",
				});

	if (intervention.kind === "known" && intervention.value)
		reasons.push("owner_intervention");
	const knownNotClean = reasons.length > 0;

	if (mergedAt === null) reasons.push("merged_at_unavailable");

	if (assurance.kind === "factory_verified" && certifiedRound === null)
		reasons.push("certified_generation_unavailable");
	const pending = matures !== null && now < matures;
	let defect: DefectResult;

	if (mergedAt === null)
		defect = { kind: "unknown", reason: "merged_at_unavailable" };
	else if (defects.kind === "unknown") defect = defects;
	else if (pending) defect = { kind: "pending" };
	else {
		const start = Date.parse(mergedAt);

		const candidates = [
			...(byReference.get(row.issue) ?? []),
			...(row.pr === null ? [] : (byReference.get(row.pr.number) ?? [])),
		];

		const issues = candidates.flatMap((item) =>
			item.number !== row.issue &&
			Date.parse(item.createdAt) > start &&
			Date.parse(item.createdAt) <= start + WINDOW_MS
				? [item.number]
				: [],
		);

		defect =
			issues.length > 0
				? { kind: "linked", issues: [...new Set(issues)].sort((a, b) => a - b) }
				: { kind: "none" };
	}

	if (defect.kind === "linked") reasons.push("follow_up_defect");

	const interventionUnknown = intervention.kind === "unknown";

	if (interventionUnknown) reasons.push(intervention.reason);

	if (defect.kind === "unknown" && !reasons.includes(defect.reason))
		reasons.push(defect.reason);

	for (const reason of reasons) {
		if (
			reason === "merged_at_unavailable" ||
			reason === "certified_generation_unavailable" ||
			reason === "intervention_unreadable" ||
			(defect.kind === "unknown" && reason === defect.reason)
		)
			unknowns.push({
				kind: "ticket",
				issue: row.issue,
				runId: row.runId,
				reason,
			});
	}

	const status: TicketStatus =
		mergedAt === null
			? "unknown"
			: pending
				? "pending"
				: knownNotClean || defect.kind === "linked"
					? "landed_not_clean"
					: certifiedRound === null ||
							defect.kind === "unknown" ||
							interventionUnknown
						? "unknown"
						: "clean";

	return {
		runId: row.runId,
		pr: row.pr?.number ?? null,
		mergedAt,
		maturesAt: matures === null ? null : new Date(matures).toISOString(),
		certifiedRound,
		authored,
		intervention,
		defect,
		status,
		reasons,
	};
}

function share(count: number, denominator: number) {
	return {
		count,
		denominator,
		share: denominator === 0 ? null : count / denominator,
	};
}

function signal(
	count: number,
	denominator: number,
	threshold: number,
	matureCount: number,
) {
	return {
		...share(count, denominator),
		threshold,
		matureCount,
		flagBasis: "includes immature runs",
		belowThreshold: denominator === 0 ? null : count / denominator < threshold,
		insufficientData: denominator === 0,
	};
}

function deferredOf(rows: readonly LedgerRow[], now: number) {
	const mature = (row: LedgerRow) =>
		Date.parse(row.terminalObservedAt) + WINDOW_MS <= now;

	const known = rows.filter((row) => row.contextPressure.kind === "known");

	const caps = known.filter(
		(row) =>
			row.contextPressure.kind === "known" &&
			row.contextPressure.value.promptCapHit,
	).length;

	const truncated = known.filter(
		(row) =>
			row.contextPressure.kind === "known" &&
			row.contextPressure.value.truncated,
	).length;

	const byStage = new Map<
		string,
		{ caps: boolean[]; truncated: boolean[]; mature: number }
	>();

	for (const row of rows) {
		if (row.v < 3 || row.stages.kind !== "known") continue;

		for (const summary of row.stages.value) {
			if (!("efficiency" in summary)) continue;

			const item = byStage.get(summary.stage) ?? {
				caps: [],
				truncated: [],
				mature: 0,
			};

			if (summary.efficiency.sourceCapHits !== null) {
				item.caps.push(summary.efficiency.sourceCapHits > 0);

				if (mature(row)) item.mature += 1;
			}

			if (summary.efficiency.excerptOmissions !== null)
				item.truncated.push(summary.efficiency.excerptOmissions > 0);
			byStage.set(summary.stage, item);
		}
	}

	const restartKnown = rows.filter(
		(row) => row.interruptedAttempts.kind === "known",
	);

	const restarted = restartKnown.filter(
		(row) =>
			(row.outcome.kind === "failed" ||
				row.outcome.kind === "budget_exhausted") &&
			row.interruptedAttempts.kind === "known" &&
			row.interruptedAttempts.value > 0,
	);

	return {
		contextPressure: {
			decisionSignal: METRIC_POLICY.contextPressureSignal,
			denominatorBasis: "all_runs_with_known_fact",
			promptCapHit: signal(
				caps,
				known.length,
				METRIC_POLICY.contextPressureThreshold,
				known.filter(mature).length,
			),
			truncated: share(truncated, known.length),
			unknownRuns: rows.length - known.length,
			stages: [...byStage].map(([stage, item]) => ({
				stage,
				unit: "stage_summaries",
				promptCapHit: signal(
					item.caps.filter(Boolean).length,
					item.caps.length,
					METRIC_POLICY.contextPressureThreshold,
					item.mature,
				),
				truncated: share(
					item.truncated.filter(Boolean).length,
					item.truncated.length,
				),
			})),
		},
		restartEnded: {
			...signal(
				restarted.length,
				restartKnown.length,
				METRIC_POLICY.restartEndedThreshold,
				restartKnown.filter(mature).length,
			),
			denominatorBasis: "all_runs_with_known_fact",
			unknownRuns: rows.length - restartKnown.length,
			runs: restarted.map((row) => ({
				runId: row.runId,
				issue: row.issue,
				outcome: row.outcome.kind,
				interruptedAttempts:
					row.interruptedAttempts.kind === "known"
						? row.interruptedAttempts.value
						: null,
				failureClass:
					row.v !== 1 && row.failure?.kind === "known"
						? row.failure.value.class
						: null,
			})),
		},
		intakeDemand: {
			kind: "unavailable",
			reason: METRIC_POLICY.intakeDemandUnavailable,
			threshold: METRIC_POLICY.intakeDemandThreshold,
			belowThreshold: null,
			insufficientData: true,
		},
	};
}

export function computeMetrics(input: {
	readonly ledger: Uint8Array;
	readonly repo: string;
	readonly now: string;
	readonly defects: DefectRead;
	readonly interventions?: Interventions;
	readonly receiptDigests?: ReceiptDigests;
	readonly source?: "file" | "ledger";
}) {
	const now = Date.parse(input.now);

	if (!Number.isFinite(now)) throw new Error("invalid_now");
	const unknowns: Unknown[] = [];
	const excluded: { runId: string; reason: string }[] = [];
	const rows: LedgerRow[] = [];
	const seen = new Set<string>();
	const excludedRowCounts = { otherRepo: 0, repoCasingMismatch: 0 };

	for (const [at, line] of parseLedger(input.ledger).entries()) {
		if (line.kind !== "known") {
			unknowns.push({
				kind: "ledger",
				line: at + 1,
				reason: line.kind === "corrupt" ? line.code : "unknown_version",
			});
			continue;
		}

		const row = line.row;

		if (row.repo !== input.repo) {
			if (row.repo.toLowerCase() === input.repo.toLowerCase())
				excludedRowCounts.repoCasingMismatch += 1;
			else excludedRowCounts.otherRepo += 1;
			continue;
		}

		const reason = excludedRunReason(row);

		if (reason !== null) {
			excluded.push({ runId: row.runId, reason });
			continue;
		}

		if (seen.has(row.runId)) {
			unknowns.push({ kind: "ledger", line: at + 1, reason: "duplicate_run" });
			continue;
		}

		seen.add(row.runId);
		rows.push(row);
	}

	const indexed = indexDefects(rows, input.repo, input.defects);
	const groups = new Map<number, LedgerRow[]>();

	for (const row of rows) {
		const attempts = groups.get(row.issue) ?? [];
		attempts.push(row);
		groups.set(row.issue, attempts);
	}

	const tickets = [...groups]
		.sort(([a], [b]) => a - b)
		.map(([issue, attempts]) => {
			const ordered = [...attempts].sort(
				(a, b) =>
					a.terminalObservedAt.localeCompare(b.terminalObservedAt) ||
					a.runId.localeCompare(b.runId),
			);

			const landings = ordered
				.map((row) =>
					landingOf(
						row,
						now,
						input.defects,
						indexed.byReference,
						input.interventions,
						unknowns,
					),
				)
				.filter((landing) => landing !== null);

			const lastObserved = Math.max(
				...ordered.map((row) => Date.parse(row.terminalObservedAt)),
			);

			const missingReceipts = ordered.filter(
				(row) =>
					input.receiptDigests !== undefined &&
					(row.redactedReceiptDigests.length === 0 ||
						row.redactedReceiptDigests.some(
							(digest) => !input.receiptDigests?.get(row.runId)?.has(digest),
						)),
			);

			for (const row of missingReceipts)
				unknowns.push({
					kind: "ticket",
					issue,
					runId: row.runId,
					reason: "receipt_missing_or_changed",
				});
			const clean = landings.some((landing) => landing.status === "clean");

			const pending =
				landings.length === 0
					? now < lastObserved + WINDOW_MS
					: landings.some((landing) => landing.status === "pending");

			const missing = landings.some((landing) => landing.status === "unknown");

			const status: TicketStatus =
				missingReceipts.length > 0
					? "unknown"
					: clean
						? "clean"
						: pending
							? "pending"
							: missing
								? "unknown"
								: landings.length > 0
									? "landed_not_clean"
									: "not_landed";

			const maturityTimes = landings
				.map((landing) => landing.maturesAt)
				.filter((time) => time !== null);

			const maturesAt =
				landings.length === 0
					? new Date(lastObserved + WINDOW_MS).toISOString()
					: maturityTimes.length === landings.length
						? (maturityTimes.sort().at(-1) ?? null)
						: null;

			return {
				repo: input.repo,
				issue,
				status,
				maturesAt,
				pending: !clean && pending,
				mature: clean || (maturesAt !== null && Date.parse(maturesAt) <= now),
				landed: landings.length > 0,
				tokens: ordered.reduce((sum, row) => sum + row.usage.tokens.total, 0),
				attempts: ordered.map((row) => ({
					runId: row.runId,
					outcome: row.outcome.kind,
					tokens: row.usage.tokens.total,
					coverage: row.usage.tokens.kind,
					previousRunId:
						row.previousRunId.kind === "known" ? row.previousRunId.value : null,
				})),
				landings,
			};
		});

	const numerator = tickets.filter(
		(ticket) => ticket.status === "clean",
	).length;

	const denominator = tickets.length;

	const pending = tickets.filter((ticket) => ticket.pending).length;

	const unknownTickets = tickets.filter(
		(ticket) => ticket.status === "unknown",
	).length;

	const status =
		pending > 0
			? "pending"
			: unknownTickets > 0 || unknowns.some((item) => item.kind === "ledger")
				? "unknown"
				: denominator === 0
					? "insufficient_data"
					: "complete";

	const total = rows.reduce((sum, row) => sum + row.usage.tokens.total, 0);

	return {
		schemaVersion: 1,
		source: input.source ?? "ledger",
		repo: input.repo,
		now: new Date(now).toISOString(),
		cohort: "production",
		windowDays: METRIC_POLICY.windowDays,
		status,
		runs: rows.length,
		primary: {
			numerator,
			denominator,
			share: status === "complete" ? numerator / denominator : null,
			landedTickets: tickets.filter((ticket) => ticket.landed).length,
			matureTickets: tickets.filter((ticket) => ticket.mature).length,
			pendingTickets: pending,
			unknownTickets,
		},
		tokens: {
			total,
			coverage: rows.some((row) => row.usage.tokens.kind === "lower_bound")
				? "lower_bound"
				: rows.some((row) => row.usage.tokens.kind === "uncertain")
					? "uncertain"
					: "exact",
			uncertainRuns: rows.flatMap((row) =>
				row.usage.tokens.kind === "uncertain" ? [row.runId] : [],
			),
		},
		tokensPerCleanLanding:
			status !== "complete" || numerator === 0 ? null : total / numerator,
		tokensPerCleanLandingReason:
			status === "pending"
				? "cohort_pending"
				: status === "unknown"
					? "cohort_unknown"
					: numerator === 0
						? "no_clean_landings"
						: null,
		spend: { kind: "unavailable", reason: "provider_not_reported" },
		defectRead:
			input.defects.kind === "known"
				? { kind: "known", issues: input.defects.issues.length }
				: input.defects,
		receiptVerification:
			input.receiptDigests === undefined ? "not_requested" : "checked",
		tickets,
		unknowns,
		unmatchedDefects: indexed.unmatched,
		excluded,
		excludedRowCounts,
		legacyRuns: rows.flatMap((row) =>
			row.provenance.kind === "legacy_import" ? [row.runId] : [],
		),
		deferred: deferredOf(rows, now),
	};
}

// Read only redacted receipt.json files at the controller's attempt/session depths.
export async function readReceiptDigests(
	stateDir: string,
	ledger: Uint8Array,
	repo: string,
): Promise<ReceiptDigests> {
	const result = new Map<string, ReadonlySet<string>>();

	async function visit(dir: string, depth: number, digests: Set<string>) {
		const entries = await readdir(dir, { withFileTypes: true }).catch(() => []);

		for (const entry of entries) {
			const path = join(dir, entry.name);

			if (entry.isDirectory() && depth < 2)
				await visit(path, depth + 1, digests);
			else if (entry.isFile() && entry.name === "receipt.json") {
				const bytes = await readFile(path).catch(() => null);

				if (bytes !== null) digests.add(digestOf(bytes));
			}
		}
	}

	for (const line of parseLedger(ledger)) {
		if (
			line.kind !== "known" ||
			line.row.repo !== repo ||
			excludedRunReason(line.row) !== null
		)
			continue;
		const root = join(stateDir, "stages", line.row.runId);
		const digests = new Set<string>();

		if ((await lstat(root).catch(() => null))?.isDirectory())
			await visit(root, 0, digests);
		result.set(line.row.runId, digests);
	}

	return result;
}
