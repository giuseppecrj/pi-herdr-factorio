import { lstat, readFile, readdir } from "node:fs/promises";
import { join, resolve } from "node:path";
import {
	ATTENTION_KINDS,
	readAttention,
	type AttentionKind,
	type AttentionRun,
	type AttentionThresholds,
	plainTitle,
} from "./attention.ts";
import { fileAdmissionStore } from "./admission.ts";
import {
	parseCandidateState,
	candidateProjection,
	candidateUsage,
	candidateGenerations,
	notProven,
	renderLimitation,
} from "./handoff.ts";
import { fileArtifacts, readStoredContract } from "./artifacts.ts";
import { familyClaimsHold, reviewR8 } from "./review.ts";
import {
	frozenRowOf,
	parseRunStart,
	isKnownCap,
	terminalFailureOf,
} from "./ledger.ts";
import { readLock, readStatus } from "../server/controller.ts";
import {
	objectOf,
	fieldOf,
	countOf,
	textOf,
	parseJson,
} from "../server/sandbox/json.ts";
import type { JsonValue } from "./tickets.ts";
import { isRepoSlug, type RepoSlug } from "./workflow.ts";
import { readStageReceipt } from "../server/sandbox.ts";
import { isDigest, runIdOf } from "./run.ts";
import { isRunStatus, isStage } from "./markers.ts";
import { readStoredVerdict } from "../server/controller.ts";
import { FAMILY_MISSING } from "./review.ts";

export type FeedStep = {
	stage: string;
	outcome: string;
	wallMs: number | null;
	tokens: number | null;
};

export type DisplayGroup = "needs_you" | "failed" | "working" | "done";

export type FeedEntry = AttentionRun & {
	group: DisplayGroup;
	round: number | null;
	tokens: number | null;
	cap: number | null;
	ci: "Passed" | "Failed" | "Pending";
	failure: { stage: string; class: string; reason: string } | null;
	notProven: readonly string[];
	steps: readonly FeedStep[];
};

export type OwnerFeed = {
	version: 1;
	repo: RepoSlug | null;
	at: number;
	controller: {
		state: string;
		lastTick: string | null;
		localSwitch: "enabled" | "disabled" | "unavailable";
	};
	entries: readonly FeedEntry[];
	counts: Record<AttentionKind, number>;
	workingRunCount: number;
	unreadable: readonly { issue: number; issueUrl: string; reason: string }[];
	gaps: readonly string[];
	metrics: {
		computedAt: string | null;
		status: string;
		share: number | null;
		numerator: number | null;
		denominator: number | null;
		tokensPerCleanLanding: number | null;
	};
};

async function localJson(
	root: string,
	...parts: string[]
): Promise<JsonValue | undefined> {
	try {
		let path = root;

		for (const part of parts) {
			path = join(path, part);
			const info = await lstat(path);

			if (
				info.isSymbolicLink() ||
				info.uid !== process.geteuid?.() ||
				(info.mode & 0o077) !== 0
			)
				return undefined;
		}

		const info = await lstat(path);

		if (!info.isFile() || info.size > 8 * 1024 * 1024) return undefined;

		return parseJson(await readFile(path, "utf8"));
	} catch {
		return undefined;
	}
}

export async function feedRepo(stateDir: string): Promise<RepoSlug | null> {
	const status = objectOf(await localJson(resolve(stateDir), "status.json"));
	const repo = textOf(status?.repo);

	return repo !== null && isRepoSlug(repo) ? repo : null;
}

function thresholdsOf(
	snapshot: JsonValue | undefined,
): AttentionThresholds | undefined {
	const value = objectOf(fieldOf(objectOf(snapshot), "attentionThresholds"));
	const waitingMs = countOf(value?.waitingMs);
	const blockedMs = countOf(value?.blockedMs);

	return waitingMs !== null &&
		waitingMs > 0 &&
		blockedMs !== null &&
		blockedMs > 0
		? { waitingMs, blockedMs }
		: undefined;
}

function metricOf(
	snapshot: JsonValue | undefined,
	repo: RepoSlug | null,
): OwnerFeed["metrics"] {
	const saved = objectOf(snapshot);
	const report = objectOf(saved?.report);
	const primary = objectOf(report?.primary);
	const share = primary?.share;

	const complete =
		report?.status === "complete" &&
		report.repo === repo &&
		share === Number(share) &&
		Number(share) >= 0 &&
		Number(share) <= 1;

	return {
		computedAt: textOf(saved?.computedAt),
		status: complete ? "Complete" : "Pending",
		share: complete ? Number(share) : null,
		numerator: complete ? countOf(primary?.numerator) : null,
		denominator: complete ? countOf(primary?.denominator) : null,
		tokensPerCleanLanding: complete
			? report?.tokensPerCleanLanding === Number(report?.tokensPerCleanLanding)
				? Number(report?.tokensPerCleanLanding)
				: null
			: null,
	};
}

async function stepReceipts(
	root: string,
	entry: AttentionRun,
): Promise<FeedStep[]> {
	const steps: FeedStep[] = [];

	try {
		const dir = join(root, "stages", entry.runId);

		for (const name of (await readdir(dir)).sort((a, b) =>
			a.localeCompare(b, "en", { numeric: true }),
		)) {
			if (
				!/^(specify|accept|build|review)(?:-r[0-2])?-[1-9][0-9]*(?:\.[0-9]+)?$/.test(
					name,
				)
			)
				continue;

			if (
				(await localJson(root, "stages", entry.runId, name, "receipt.json")) ===
				undefined
			)
				continue;
			const receipt = await readStageReceipt(join(dir, name, "receipt.json"));

			if (
				receipt === null ||
				receipt.record === null ||
				receipt.record.runId !== entry.runId
			)
				continue;
			const stage = textOf(receipt.record.stage);

			if (stage === null) continue;
			const previous = steps.find((step) => step.stage === stage);

			if (previous === undefined)
				steps.push({
					stage,
					outcome: receipt.outcome.kind,
					wallMs: countOf(receipt.record.wallMs),
					tokens: receipt.usage.total,
				});
			else {
				previous.outcome = receipt.outcome.kind;
				previous.tokens = (previous.tokens ?? 0) + receipt.usage.total;
				previous.wallMs =
					(previous.wallMs ?? 0) + (countOf(receipt.record.wallMs) ?? 0);
			}
		}
	} catch {
		/* Old runs need not retain stage directories. */
	}

	return steps;
}

async function detail(
	root: string,
	entry: AttentionRun,
	now: number,
): Promise<FeedEntry> {
	const raw = objectOf(await localJson(root, "claims", `${entry.runId}.json`));
	const book = parseCandidateState(raw?.handoff);
	const projection = book === null ? null : candidateProjection(book);

	const start = parseRunStart(
		await localJson(root, "accounting", entry.runId, "policy.json"),
	);

	const context = start?.context;

	const historicCap =
		context?.kind === "production"
			? context.trustedCap
			: context?.kind === "verification"
				? context.effectiveCap
				: (context?.known.verification?.effectiveCap ??
					context?.known.trustedCap);

	const cap =
		historicCap !== undefined && isKnownCap(historicCap)
			? historicCap
			: (book?.pin.maxTokens ?? null);

	const rowValue = await localJson(root, "ledger", entry.runId, "row.json");

	const row =
		rowValue === undefined
			? null
			: (frozenRowOf(
					await readFile(join(root, "ledger", entry.runId, "row.json")),
				)?.row ?? null);

	const terminal = objectOf(
		await localJson(root, "ledger", entry.runId, "terminal.json"),
	);

	const stopped =
		terminal?.runId === entry.runId
			? objectOf(terminalFailureOf(terminal))
			: null;

	const stopFact = objectOf(stopped?.failure);
	const stopValue = objectOf(stopFact?.value);

	const failure =
		row !== null && "failure" in row && row.failure?.kind === "known"
			? row.failure.value
			: stopFact?.kind === "known" &&
					textOf(stopValue?.stage) !== null &&
					textOf(stopValue?.class) !== null &&
					textOf(stopValue?.reason) !== null
				? {
						stage: String(stopValue?.stage),
						class: String(stopValue?.class),
						reason: String(stopValue?.reason),
					}
				: null;

	const terminalAt = Date.parse(
		row?.terminalObservedAt ??
			(terminal?.runId === entry.runId
				? textOf(terminal.terminalObservedAt)
				: null) ??
			"",
	);

	const since = Number.isFinite(terminalAt)
		? terminalAt
		: entry.terminal
			? (countOf(raw?.enteredAt) ?? entry.since)
			: entry.since;

	const selected = book?.kind === "selected" ? book.current : null;
	let verdict = selected?.verdict ?? selected?.certification?.verdict ?? null;

	if (book === null && raw?.validation !== undefined) {
		const round = countOf(raw.round) ?? 0;

		try {
			verdict = readStoredVerdict(
				join(
					root,
					"validation",
					entry.runId,
					...(round === 0 ? [] : [`r${round}`]),
					"verdict.json",
				),
			);
		} catch {
			/* Missing verdicts are Pending, never a pass. */
		}
	}

	const notProvenEntries: string[] = [];
	const published = book?.kind === "selected" ? book.published : null;

	const certificate =
		book?.kind !== "selected"
			? null
			: published === null
				? book.current.certification
				: (candidateGenerations(book).find(
						(g) =>
							g.intent.round === published.promoted.round &&
							g.intent.generation === published.promoted.generation &&
							g.intent.digest === published.promoted.digest,
					)?.certification ?? null);

	if (certificate !== null) {
		const contract = await readStoredContract(root, entry.runId);

		const suite =
			contract.kind === "found"
				? await fileArtifacts(root).read(
						entry.runId,
						contract.contract,
						contract.digest,
					)
				: null;

		const review = certificate.review;

		if (
			contract.kind === "found" &&
			suite?.kind === "found" &&
			suite.receipt.acceptanceDigest === certificate.verdict.acceptanceDigest &&
			familyClaimsHold(review) &&
			(review.version !== 3 ||
				JSON.stringify(review.accept) ===
					JSON.stringify(suite.receipt.family ?? FAMILY_MISSING))
		) {
			notProvenEntries.push(
				...notProven({
					criteria: contract.contract.acceptance,
					scenarios: suite.suite.scenarios,
					r8: reviewR8(review),
					judgments: review.seats.flatMap((s) => s.judgments),
				}).map((item) => renderLimitation(item).replace(/^- /, "")),
			);
		} else
			notProvenEntries.push(
				"The saved checks and review cannot be verified here.",
			);
	}

	const refreshing =
		entry.kind === "blocked" &&
		(entry.reason === "working_generation" ||
			(book?.kind === "selected" &&
				book.work.kind !== "held" &&
				book.work.kind !== "waiting" &&
				!["claim_unverified", "feedback_unavailable"].some((p) =>
					entry.reason?.startsWith(p),
				)));

	const group: DisplayGroup = entry.terminal
		? "done"
		: entry.kind === "failed"
			? "failed"
			: entry.kind === null || entry.kind === "question_answered" || refreshing
				? "working"
				: "needs_you";

	return {
		...entry,
		since,
		ageMs: since === null || since > now ? null : now - since,
		group,
		round: projection?.round ?? countOf(raw?.round),
		tokens: book === null ? countOf(raw?.usage) : candidateUsage(book),
		cap,
		ci: verdict === null ? "Pending" : verdict.pass ? "Passed" : "Failed",
		failure,
		notProven: notProvenEntries,
		steps: await stepReceipts(root, entry),
	};
}

export async function readOwnerRun(
	stateDir: string,
	runId: string,
	feed: OwnerFeed,
): Promise<FeedEntry | null> {
	const existing = feed.entries.find((entry) => entry.runId === runId);

	if (existing !== undefined) return existing;

	if (feed.repo === null || !isDigest(runId)) return null;
	const root = resolve(stateDir);
	const raw = objectOf(await localJson(root, "claims", `${runId}.json`));
	const issue = countOf(raw?.issue);
	const eventId = textOf(raw?.eventId);
	const status = textOf(raw?.status);
	const stage = textOf(raw?.stage);

	if (
		issue === null ||
		issue < 1 ||
		eventId === null ||
		!/^[1-9][0-9]{0,19}$/.test(eventId) ||
		runIdOf({ repo: feed.repo, issue, eventId }) !== runId ||
		status === null ||
		!isRunStatus(status) ||
		stage === null ||
		!isStage(stage)
	)
		return null;

	const snapshot = await fileAdmissionStore(root).readSnapshot({
		repo: feed.repo,
		issue,
		eventId,
	});

	const since = countOf(raw?.enteredAt);

	const entry = await detail(
		root,
		{
			runId,
			issue,
			eventId,
			status,
			stage,
			since,
			ageMs: since === null || since > feed.at ? null : feed.at - since,
			title:
				snapshot.kind === "found"
					? plainTitle(snapshot.snapshot.title)
					: "Title unavailable",
			terminal: ["landed", "released", "cancelled", "stage_passed"].includes(
				status,
			),
			kind:
				status === "failed" || status === "budget_exhausted"
					? "failed"
					: status === "needs_info"
						? "question_asked"
						: null,
			issueUrl: `https://github.com/${feed.repo}/issues/${issue}`,
			prUrl: null,
			reason: null,
			stale: false,
		},
		feed.at,
	);

	return entry;
}

export async function readOwnerFeed(input: {
	stateDir: string;
	repo?: RepoSlug | null;
	now?: number;
}): Promise<OwnerFeed> {
	const root = resolve(input.stateDir);
	const now = input.now ?? Date.now();
	const repo = input.repo ?? (await feedRepo(root));
	const status = repo === null ? null : objectOf(await readStatus(root));
	const snapshot = await localJson(root, "metrics.json");

	const attention = await readAttention({
		stateDir: root,
		repo,
		now,
		thresholds: thresholdsOf(snapshot),
	});

	const lock = await readLock(root);
	const rawCorrupt = status?.corrupt;

	const unreadable = !Array.isArray(rawCorrupt)
		? []
		: rawCorrupt.flatMap((raw) => {
				const item = objectOf(raw);
				const issue = countOf(item?.issue);

				return issue === null || issue < 1 || repo === null
					? []
					: [
							{
								issue,
								issueUrl: `https://github.com/${repo}/issues/${issue}`,
								reason:
									"Run history cannot be read: conflicting or corrupt records.",
							},
						];
			});

	const corruptIssues = new Set(unreadable.map((item) => item.issue));
	const counts = Object.fromEntries(ATTENTION_KINDS.map((kind) => [kind, 0]));
	// SAFETY: every AttentionKind is inserted by the constant list above.
	const typedCounts = counts as Record<AttentionKind, number>;
	const entries: FeedEntry[] = [];

	const gaps =
		attention.kind === "available" ? [...attention.gaps] : [attention.reason];

	let workingRunCount = 0;

	if (attention.kind === "available") {
		for (const run of attention.runs) {
			if (corruptIssues.has(run.issue)) continue;
			const entry = await detail(root, run, now);

			if (!entry.terminal && entry.kind === null) workingRunCount++;

			if (entry.kind !== null) typedCounts[entry.kind]++;

			if (
				entry.terminal &&
				(entry.since === null || now - entry.since > 7 * 86_400_000)
			)
				continue;
			entries.push(entry);
		}

		for (const held of attention.groups.blocked) {
			if (entries.some((entry) => entry.runId === held.runId)) continue;
			const issue = Number(held.issueUrl.split("/").at(-1));

			if (!Number.isSafeInteger(issue) || corruptIssues.has(issue)) continue;
			typedCounts.blocked++;
			entries.push({
				...held,
				issue,
				eventId: "",
				stage: "admit",
				since: held.ageMs === null ? null : now - held.ageMs,
				terminal: false,
				kind: "blocked",
				group: "needs_you",
				round: null,
				tokens: null,
				cap: null,
				ci: "Pending",
				failure: null,
				notProven: [],
				steps: [],
			});
		}
	}

	entries.sort((a, b) => (b.since ?? 0) - (a.since ?? 0) || b.issue - a.issue);

	return {
		version: 1,
		repo,
		at: now,
		controller: {
			state:
				lock.kind === "socket_bound"
					? "running"
					: lock.kind === "none"
						? "stopped"
						: "unavailable",
			lastTick: textOf(status?.at),
			localSwitch: await fileAdmissionStore(root).localSwitch(),
		},
		entries,
		counts: typedCounts,
		workingRunCount,
		unreadable,
		gaps,
		metrics: metricOf(snapshot, repo),
	};
}
