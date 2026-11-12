import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { parseArgs } from "node:util";
import {
	type HistoricalRepositories,
	measuredRepositories,
	type PlatformProfile,
} from "../../src/trust/platform.ts";
import type { JsonValue } from "../../src/core/json.ts";
import { isRepoSlug, type RepoSlug } from "../../src/trust/platform.ts";
import { GitHubPublicationApi } from "../../src/github/publish.ts";
import {
	arrayOf,
	boolOf,
	countOf,
	fieldOf,
	objectOf,
	parseJson,
	textOf,
} from "../../src/core/json.ts";
import { parseLedger } from "../../src/ledger/schema.ts";
import { ledgerApiOf } from "../../src/ledger/git.ts";
import {
	computeMetrics,
	type DefectIssue,
	type DefectRead,
	excludedRunReason,
	type InterventionRead,
	type Interventions,
	METRIC_POLICY,
	readReceiptDigests,
} from "../../src/views/metrics.ts";
import { type CliIo, EXIT, FETCH_TIMEOUT_MS, json, USAGE } from "./platform.ts";

function defectIssueOf(value: JsonValue): DefectIssue | null {
	const record = objectOf(value);
	const number = countOf(fieldOf(record, "number"));
	const title = textOf(fieldOf(record, "title"));
	const rawBody = fieldOf(record, "body");
	const body = rawBody === null ? "" : textOf(rawBody);
	const createdAt = textOf(fieldOf(record, "created_at"));
	const rawLabels = arrayOf(fieldOf(record, "labels"));

	if (
		number === null ||
		number === 0 ||
		title === null ||
		body === null ||
		createdAt === null ||
		!validMetricInstant(createdAt) ||
		rawLabels === null
	)
		return null;
	const labels: string[] = [];

	for (const label of rawLabels) {
		const name = textOf(fieldOf(objectOf(label), "name"));

		if (name === null) return null;
		labels.push(name);
	}

	return { number, title, body, createdAt, labels };
}

function validMetricInstant(value: string): boolean {
	const time = Date.parse(value);

	return (
		/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{3})?Z$/.test(value) &&
		Number.isFinite(time) &&
		new Date(time).toISOString() === value.replace(/(?<!\.\d{3})Z$/, ".000Z")
	);
}

async function readMetricDefects(repo: string, io: CliIo): Promise<DefectRead> {
	try {
		const label = await io.exec(
			"gh",
			[
				"api",
				`repos/${repo}/labels/${encodeURIComponent(METRIC_POLICY.defect.label)}`,
			],
			{ timeoutMs: FETCH_TIMEOUT_MS },
		);

		if (label.code !== 0)
			return { kind: "unknown", reason: "label_unreadable" };

		if (
			textOf(fieldOf(objectOf(parseJson(label.stdout)), "name")) !==
			METRIC_POLICY.defect.label
		)
			return { kind: "unknown", reason: "label_missing" };
	} catch {
		return { kind: "unknown", reason: "label_unreadable" };
	}

	const deadline = Date.now() + FETCH_TIMEOUT_MS;
	const issues: DefectIssue[] = [];

	try {
		for (let page = 1; page <= METRIC_POLICY.defect.queryLimit / 100; page++) {
			const remaining = deadline - Date.now();

			if (remaining <= 0)
				return { kind: "unknown", reason: "defect_query_failed" };

			const result = await io.exec(
				"gh",
				[
					"api",
					`repos/${repo}/issues?labels=${encodeURIComponent(METRIC_POLICY.defect.label)}&state=all&sort=created&direction=asc&per_page=100&page=${page}`,
				],
				{ timeoutMs: remaining },
			);

			if (result.code !== 0 || Date.now() >= deadline)
				return { kind: "unknown", reason: "defect_query_failed" };
			const value = arrayOf(parseJson(result.stdout));

			if (value === null || value.length > 100)
				return { kind: "unknown", reason: "defect_query_invalid" };

			for (const item of value) {
				if (fieldOf(objectOf(item), "pull_request") !== undefined) continue;
				const issue = defectIssueOf(item);

				if (issue === null)
					return { kind: "unknown", reason: "defect_query_invalid" };
				issues.push(issue);
			}

			if (value.length < 100) return { kind: "known", issues };
		}

		return { kind: "unknown", reason: "defect_query_incomplete" };
	} catch {
		return { kind: "unknown", reason: "defect_query_failed" };
	}
}

type MetricReview = {
	id: number | null;
	state: string;
	actor: string;
	bot: boolean;
	submittedAt: number;
};

const INTERVENTION_UNREADABLE = {
	kind: "unknown",
	reason: "intervention_unreadable",
} as const;

async function readMetricPages(
	path: string,
	io: CliIo,
): Promise<JsonValue[] | null> {
	const deadline = Date.now() + FETCH_TIMEOUT_MS;
	const entries: JsonValue[] = [];

	try {
		for (let page = 1; page <= 10; page++) {
			const remaining = deadline - Date.now();

			if (remaining <= 0) return null;

			const result = await io.exec(
				"gh",
				["api", `${path}?per_page=100&page=${page}`],
				{ timeoutMs: remaining },
			);

			if (result.code !== 0 || Date.now() >= deadline) return null;
			const items = arrayOf(parseJson(result.stdout));

			if (items === null || items.length > 100) return null;
			entries.push(...items);

			if (items.length < 100) return entries;
		}
	} catch {
		return null;
	}

	return null;
}

async function readMetricReviews(
	repo: string,
	pr: number,
	io: CliIo,
): Promise<MetricReview[] | null> {
	const items = await readMetricPages(`repos/${repo}/pulls/${pr}/reviews`, io);

	if (items === null) return null;
	const reviews: MetricReview[] = [];

	for (const item of items) {
		const record = objectOf(item);
		const state = textOf(fieldOf(record, "state"));

		const actor = textOf(fieldOf(objectOf(fieldOf(record, "user")), "login"));

		const submitted = fieldOf(record, "submitted_at");

		if (
			state === null ||
			![
				"APPROVED",
				"CHANGES_REQUESTED",
				"COMMENTED",
				"DISMISSED",
				"PENDING",
			].includes(state) ||
			actor === null ||
			actor === ""
		)
			return null;

		if (state === "PENDING" && submitted === null) continue;
		const submittedAt = textOf(submitted);

		if (submittedAt === null || !validMetricInstant(submittedAt)) return null;
		reviews.push({
			id: countOf(fieldOf(record, "id")),
			state,
			actor,
			bot:
				actor.toLowerCase().endsWith("[bot]") ||
				textOf(fieldOf(objectOf(fieldOf(record, "user")), "type")) === "Bot",
			submittedAt: Date.parse(submittedAt),
		});
	}

	const timeline = await readMetricPages(
		`repos/${repo}/issues/${pr}/timeline`,
		io,
	);

	if (timeline === null) return null;

	for (const item of timeline) {
		const record = objectOf(item);
		const event = textOf(fieldOf(record, "event"));

		if (event === null) return null;

		if (event !== "review_dismissed") continue;
		const dismissed = objectOf(fieldOf(record, "dismissed_review"));
		const state = textOf(fieldOf(dismissed, "state"))?.toUpperCase();

		if (
			state === undefined ||
			!["APPROVED", "COMMENTED", "CHANGES_REQUESTED"].includes(state)
		)
			return null;

		if (state !== "CHANGES_REQUESTED") continue;
		const id = countOf(fieldOf(dismissed, "review_id"));

		const original =
			id === null ? undefined : reviews.find((review) => review.id === id);

		if (original === undefined) return null;

		if (!original.bot) reviews.push({ ...original, state });
	}

	return reviews;
}

async function readMetricInterventions(
	ledger: Uint8Array,
	repo: string,
	io: CliIo,
	controllerLogin: string,
	cache?: Map<string, InterventionRead>,
	history: HistoricalRepositories = {},
): Promise<Interventions> {
	const names = measuredRepositories(history, repo);
	const byPr = new Map<number, MetricReview[] | null>();
	const result = new Map<string, InterventionRead>();

	for (const line of parseLedger(ledger)) {
		if (
			line.kind !== "known" ||
			!names.includes(line.row.repo) ||
			excludedRunReason(line.row) !== null ||
			result.has(line.row.runId)
		)
			continue;
		const row = line.row;
		const outcome = row.outcome;

		if (outcome.kind !== "landed") continue;

		if (row.pr === null || outcome.mergedAt.kind !== "known") {
			result.set(row.runId, INTERVENTION_UNREADABLE);
			continue;
		}

		const pr = row.pr.number;
		const key = `${repo}/${pr}/${outcome.mergeSha}`;
		const cached = cache?.get(key);

		if (cached !== undefined) {
			result.set(row.runId, cached);
			continue;
		}

		if (!byPr.has(pr)) byPr.set(pr, await readMetricReviews(repo, pr, io));
		const reviews = byPr.get(pr);
		const mergedAt = Date.parse(outcome.mergedAt.value);
		result.set(
			row.runId,
			reviews === null || reviews === undefined
				? INTERVENTION_UNREADABLE
				: {
						kind: "known",
						source: "github_reviews",
						value: reviews.some(
							(review) =>
								review.state === "CHANGES_REQUESTED" &&
								review.submittedAt < mergedAt &&
								review.actor.toLowerCase() !== controllerLogin,
						),
					},
		);
		const intervention = result.get(row.runId);

		if (intervention?.kind === "known") cache?.set(key, intervention);
	}

	return result;
}

async function readInterventionFixture(
	path: string,
): Promise<Interventions | null> {
	try {
		const value = objectOf(parseJson(await readFile(resolve(path), "utf8")));
		const landings = arrayOf(fieldOf(value, "landings"));

		if (fieldOf(value, "version") !== 1 || landings === null) return null;
		const result = new Map<string, InterventionRead>();

		for (const landing of landings) {
			const entry = objectOf(landing);
			const runId = textOf(fieldOf(entry, "runId"));
			const intervention = boolOf(fieldOf(entry, "intervention"));

			if (
				runId === null ||
				!/^[a-f0-9]{64}$/.test(runId) ||
				intervention === null ||
				result.has(runId)
			)
				return null;
			result.set(runId, {
				kind: "known",
				value: intervention,
				source: "fixture",
			});
		}

		return result;
	} catch {
		return null;
	}
}

export async function collectOwnerMetrics(
	stateDir: string,
	repo: RepoSlug,
	io: CliIo,
	cache: Map<string, InterventionRead>,
	platform: PlatformProfile,
): Promise<JsonValue> {
	const deadline = Date.now() + 120_000;
	let deadlineExpired = false;

	const bounded: CliIo = {
		...io,
		exec: async (command, args, options) => {
			const remaining = deadline - Date.now();

			if (remaining <= 0) {
				deadlineExpired = true;
				throw new Error("metric_deadline");
			}

			const result = await io.exec(command, args, {
				...options,
				timeoutMs: Math.min(options?.timeoutMs ?? FETCH_TIMEOUT_MS, remaining),
			});

			if (Date.now() >= deadline) {
				deadlineExpired = true;
				throw new Error("metric_deadline");
			}

			return result;
		},
	};

	let report: ReturnType<typeof computeMetrics> | null = null;
	let ledgerIdentity: string | null = null;
	const gaps: string[] = [];
	let failure = "ledger_ref_unavailable";

	try {
		const api = ledgerApiOf(
			new GitHubPublicationApi(bounded.exec, repo, platform),
		);

		const tip = await api.ref();

		if (tip === null) {
			failure = "ledger_missing";
			throw new Error(failure);
		}

		failure = "ledger_commit_unavailable";
		const commit = await api.commit(tip);
		failure = "ledger_file_unavailable";
		const ledger = (await api.file(commit.tree)).bytes;
		ledgerIdentity = tip;
		failure = "defect_query_failed";
		const defects = await readMetricDefects(repo, bounded);

		if (defects.kind !== "known") {
			failure = defects.reason;
			throw new Error(failure);
		}

		const evaluatedAt = new Date().toISOString();

		failure = "intervention_unreadable";

		const interventions = await readMetricInterventions(
			ledger,
			repo,
			bounded,
			platform.controllerLogin,
			cache,
			platform.historicalRepositories,
		);

		if ([...interventions.values()].some((read) => read.kind !== "known"))
			throw new Error(failure);
		failure = "receipt_read_unavailable";

		const receiptDigests = await readReceiptDigests(
			stateDir,
			ledger,
			repo,
			platform.historicalRepositories,
		);

		failure = "metric_compute_unavailable";
		report = computeMetrics({
			ledger,
			repo,
			now: evaluatedAt,
			defects,
			interventions,
			receiptDigests,
			source: "ledger",
			history: platform.historicalRepositories,
		});

		if (report.status !== "complete") gaps.push(`report_${report.status}`);
	} catch (error) {
		throw new Error(
			deadlineExpired ||
				Date.now() >= deadline ||
				(error instanceof Error && error.message === "metric_deadline")
				? "metric_deadline"
				: failure,
		);
	}

	return {
		version: 1,
		stale: false,
		computedAt: new Date().toISOString(),
		ledgerIdentity,
		report,
		gaps,
	};
}

export async function runMetricsCli(
	argv: readonly string[],
	io: CliIo,
	platform: PlatformProfile,
): Promise<number> {
	let parsed;

	try {
		parsed = parseArgs({
			args: [...argv],
			allowPositionals: true,
			strict: true,
			options: {
				json: { type: "boolean" },
				repo: { type: "string" },
				ledger: { type: "string" },
				"ledger-file": { type: "string" },
				"intervention-file": { type: "string" },
				"state-dir": { type: "string" },
				now: { type: "string" },
				cohort: { type: "string" },
				offline: { type: "boolean" },
			},
		});
	} catch {
		io.stderr(`unrecognized or incomplete metrics options\n${USAGE}\n`);

		return EXIT.usage;
	}

	const { values, positionals } = parsed;

	if (
		positionals.length > 0 ||
		values.json !== true ||
		values.repo === undefined ||
		!isRepoSlug(values.repo) ||
		(values.now !== undefined && !validMetricInstant(values.now)) ||
		(values.cohort !== undefined && values.cohort !== "production") ||
		(values.ledger !== undefined && values["ledger-file"] !== undefined) ||
		values.ledger === "" ||
		values["ledger-file"] === "" ||
		values["intervention-file"] === "" ||
		(values["intervention-file"] !== undefined &&
			(values.offline !== true ||
				(values.ledger === undefined &&
					values["ledger-file"] === undefined))) ||
		values["state-dir"] === ""
	) {
		io.stderr(
			`metrics requires --json --repo <owner/name>, a UTC --now instant and the production cohort\n${USAGE}\n`,
		);

		return EXIT.usage;
	}

	let ledger: Buffer;

	let ledgerError: "ledger_unavailable" | "ledger_too_large" =
		"ledger_unavailable";

	const ledgerFile = values["ledger-file"] ?? values.ledger;

	try {
		if (ledgerFile !== undefined) ledger = await readFile(resolve(ledgerFile));
		else {
			const result = await io.exec(
				"git",
				["show", "refs/remotes/origin/factory/ledger:ledger/runs.jsonl"],
				{ timeoutMs: FETCH_TIMEOUT_MS },
			);

			if (result.code !== 0) {
				if (result.stderr === "metric_ledger_too_large")
					ledgerError = "ledger_too_large";
				throw new Error(ledgerError);
			}

			ledger = Buffer.from(result.stdout);
		}
	} catch {
		io.stdout(json({ error: ledgerError }));

		return EXIT.invalid;
	}

	const githubDeadline = Date.now() + 120_000;

	const githubIo: CliIo = {
		...io,
		exec: async (command, args, options) => {
			const remaining = githubDeadline - Date.now();

			if (remaining <= 0) throw new Error("metric_github_deadline");

			const result = await io.exec(command, args, {
				...options,
				timeoutMs: Math.min(options?.timeoutMs ?? FETCH_TIMEOUT_MS, remaining),
			});

			if (Date.now() >= githubDeadline)
				throw new Error("metric_github_deadline");

			return result;
		},
	};

	const defects: DefectRead =
		values.offline === true
			? { kind: "unknown", reason: "offline" }
			: await readMetricDefects(values.repo, githubIo);

	const defectReadAt = Date.now();

	if (
		values.offline !== true &&
		values.now !== undefined &&
		Date.parse(values.now) > defectReadAt
	) {
		io.stdout(json({ error: "now_after_defect_read" }));

		return EXIT.invalid;
	}

	const interventions =
		values["intervention-file"] !== undefined
			? await readInterventionFixture(values["intervention-file"])
			: values.offline === true
				? undefined
				: await readMetricInterventions(
						ledger,
						values.repo,
						githubIo,
						platform.controllerLogin,
						undefined,
						platform.historicalRepositories,
					);

	if (interventions === null) {
		io.stdout(json({ error: "intervention_fixture_invalid" }));

		return EXIT.invalid;
	}

	const receiptDigests =
		values["state-dir"] === undefined
			? undefined
			: await readReceiptDigests(
					resolve(values["state-dir"]),
					ledger,
					values.repo,
					platform.historicalRepositories,
				);

	io.stdout(
		json(
			computeMetrics({
				ledger,
				repo: values.repo,
				now: values.now ?? new Date(defectReadAt).toISOString(),
				defects,
				interventions,
				receiptDigests,
				source: ledgerFile === undefined ? "ledger" : "file",
				history: platform.historicalRepositories,
			}),
		),
	);

	return EXIT.ok;
}
