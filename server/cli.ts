import {
	execFile as execFileCallback,
	type ExecFileOptionsWithStringEncoding,
} from "node:child_process";
import { lstat, readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { setTimeout as delay } from "node:timers/promises";
import { parseArgs } from "node:util";
import manifest from "../package.json" with { type: "json" };
import { readAttention, type AttentionRead } from "../src/attention.ts";
import {
	type AdmissionReceipt,
	admitTicket,
	FACTORY_REPOSITORIES,
	fileAdmissionStore,
} from "../src/admission.ts";
import { GitHubTicketAdapter } from "../src/adapters/github.ts";
import {
	type Clock,
	checkIdentity,
	type Log,
	Orchestrator,
	type StageExecutor,
	type TickReport,
} from "../src/orchestrator.ts";
import type { JsonValue } from "../src/tickets.ts";
import {
	type CheckReport,
	checkReport,
	type EnvLookup,
	type Exec,
	type ExecResult,
	isBranchName,
	isGitSha,
	isRepoSlug,
	parseWorkflow,
	loadWorkflow,
	type RepoSlug,
	redactCredentials,
	type StatusReport,
	statusReport,
	TRUSTED_REF,
} from "../src/workflow.ts";
import {
	acquireLock,
	fileRunFiles,
	type SocketLockState,
	lineLog,
	type ProcessTable,
	procTable,
	readLock,
	pinVerification,
	pumpLedgerOutbox,
	readStatus,
	readLedgerBacklog,
	readDurableAccounting,
	type Sleep,
	type TarballFetch,
	serveLoop,
	writeStatus,
	startMetricSnapshots,
	durableUsageOf,
} from "./controller.ts";
import { readOwnerFeed } from "../src/feed.ts";
import { GitHubPublicationApi } from "../src/publication.ts";
import { sandboxExecutor } from "./sandbox.ts";
import { runGatesCli } from "./gates.ts";
import { runViewerCli } from "./viewer.ts";
import {
	arrayOf,
	boolOf,
	countOf,
	fieldOf,
	objectOf,
	parseJson,
	textOf,
} from "./sandbox/json.ts";
import { parseLedger, ledgerApiOf } from "../src/ledger.ts";
import { digestOf } from "../src/run.ts";
import {
	computeMetrics,
	excludedRunReason,
	METRIC_POLICY,
	type Interventions,
	type InterventionRead,
	readReceiptDigests,
	type DefectIssue,
	type DefectRead,
} from "../src/metrics.ts";

import {
	checkReplay,
	decideReplayBudget,
	loadReplayCorpus,
	readReplayBudget,
	replayReport,
	replayRow,
	readReplayRecord,
	checkReplayBundles,
	REPLAY_CORPUS,
	REPLAY_RUN_CAP,
} from "../src/replay.ts";

export const USAGE = `Usage:
  node server/cli.ts replay check --json [--corpus <dir>] [--main-sha <sha>] [--previous-sha <sha>] [--candidate-sha <sha>] [--case <id> --production-state-dir <dir> --budget-file <file>]
  node server/cli.ts replay report --json --case <id> --previous-row <file> --candidate-row <file> --previous-record <file> --candidate-record <file> --previous-sha <sha> --candidate-sha <sha> [--corpus <dir>] [--previous-assets <digest> --candidate-assets <digest>]
  node server/cli.ts metrics --json --repo <owner/name> [--ledger-file <path>] [--state-dir <dir>] [--now <instant>] [--cohort production] [--offline] [--intervention-file <fixture>]
  node server/cli.ts owner-feed --json --state-dir <dir> [--repo <owner/name>]
  node server/cli.ts viewer --state-dir <dir> [--run <id>] [--port <n>] [--allowed-host <authorized.ts.net>] [--base-path </prefix>]
  node server/cli.ts gates --repository <dir> --gate-sha <sha> --candidate-sha <sha> --nonce <id> --output <dir> [--runner docker|local]
  node server/cli.ts workflow-check --json --repo <owner/name> [--ref <branch>] [--reload-ref <branch>]
  node server/cli.ts status --json --repo <owner/name> [--ref <branch>] [--state-dir <dir>]
  node server/cli.ts admit --json --repo <owner/name> --issue <number> --state-dir <dir>
  node server/cli.ts tick --once --json --repo <owner/name> --state-dir <dir> [--issue <number>]... [--verification-token-cap <n>]
  node server/cli.ts run --json --repo <owner/name> --issue <number> --state-dir <dir> [--verification-token-cap <n>]
  node server/cli.ts serve --repo <owner/name> --state-dir <dir> [--issue <number>]... [--verification-token-cap <n>]`;

export const EXIT = { ok: 0, invalid: 1, usage: 2 } as const;

/** What the controller commands need besides `exec`. The process entry passes the real ones. */
export type ControllerRuntime = {
	clock: Clock;
	procs: ProcessTable;
	sleep: Sleep;
	signal: AbortSignal;
	policySource?: { readonly fetch?: TarballFetch };
	executor: (context: ExecutorContext) => StageExecutor;
};

export type ExecutorContext = {
	readonly stateDir: string;
	readonly exec: Exec;
	readonly log: Log;
};

const XDG_RUNTIME_DIR = "/run/user/1000";

export type CliIo = {
	exec: Exec;
	env: EnvLookup;
	stdout: (text: string) => void;
	stderr: (text: string) => void;
	runtime?: ControllerRuntime;
};

export const FETCH_TIMEOUT_MS = 30_000;

const ISSUE_NUMBER = /^[1-9][0-9]{0,9}$/;

const CONTROLLER_COMMANDS = ["tick", "run", "serve"] as const;

type ControllerCommand = (typeof CONTROLLER_COMMANDS)[number];

type Parsed =
	| {
			kind: "workflow";
			command: "workflow-check" | "status";
			repo: RepoSlug;
			ref: string;
			reloadRef: string | null;
			stateDir: string | null;
	  }
	| { kind: "admit"; repo: RepoSlug; issue: number; stateDir: string }
	| {
			kind: "controller";
			command: ControllerCommand;
			repo: RepoSlug;
			stateDir: string;
			scope: readonly number[] | null;
			verificationCap: number | null;
	  }
	| { kind: "usage"; message: string };

type Values = ReturnType<typeof parseCliArgs>["values"];

function isControllerCommand(command: string): command is ControllerCommand {
	return CONTROLLER_COMMANDS.some((known) => known === command);
}

function issuesOf(values: Values): number[] | null {
	const issues = values.issue ?? [];

	return issues.every((issue) => ISSUE_NUMBER.test(issue))
		? issues.map(Number)
		: null;
}

function parseController(
	command: ControllerCommand,
	repo: RepoSlug,
	values: Values,
): Parsed {
	if (values.ref !== undefined || values["reload-ref"] !== undefined) {
		return {
			kind: "usage",
			message: `${command} always reads main and takes no --ref`,
		};
	}

	if ((command === "tick") !== (values.once === true)) {
		return {
			kind: "usage",
			message: "--once applies only to tick, and tick requires it",
		};
	}

	if ((command === "serve") === (values.json === true)) {
		return {
			kind: "usage",
			message: "--json is required, except for serve, which logs lines",
		};
	}

	const issues = issuesOf(values);

	if (issues === null || (command === "run" && issues.length !== 1)) {
		return {
			kind: "usage",
			message:
				command === "run"
					? "--issue <number> is required"
					: "--issue must be a number",
		};
	}

	if (values["state-dir"] === undefined || values["state-dir"] === "") {
		return { kind: "usage", message: "--state-dir <dir> is required" };
	}

	const cap = values["verification-token-cap"];

	if (cap !== undefined && (issues.length === 0 || !ISSUE_NUMBER.test(cap))) {
		return {
			kind: "usage",
			message:
				"--verification-token-cap takes a positive integer and requires --issue",
		};
	}

	return {
		kind: "controller",
		command,
		repo,
		stateDir: resolve(values["state-dir"]),
		scope: issues.length === 0 ? null : [...new Set(issues)],
		verificationCap: cap === undefined ? null : Number(cap),
	};
}

function parse(argv: readonly string[]): Parsed {
	let parsed: ReturnType<typeof parseCliArgs>;

	try {
		parsed = parseCliArgs(argv);
	} catch {
		return { kind: "usage", message: "unrecognized or incomplete options" };
	}

	const { values, positionals } = parsed;
	const [command, ...extra] = positionals;

	if (
		command !== "workflow-check" &&
		command !== "status" &&
		command !== "admit" &&
		(command === undefined || !isControllerCommand(command))
	) {
		return {
			kind: "usage",
			message: "expected workflow-check, status, admit, tick, run or serve",
		};
	}

	if (extra.length > 0) {
		return { kind: "usage", message: "unexpected extra arguments" };
	}

	if (values.repo === undefined || !isRepoSlug(values.repo)) {
		return values.json !== true && command !== "serve"
			? { kind: "usage", message: "--json is required" }
			: { kind: "usage", message: "--repo <owner/name> is required" };
	}

	if (isControllerCommand(command)) {
		return parseController(command, values.repo, values);
	}

	if (values.json !== true) {
		return { kind: "usage", message: "--json is required" };
	}

	if (values.once !== undefined) {
		return {
			kind: "usage",
			message: "--once applies only to tick, and tick requires it",
		};
	}

	if (values["verification-token-cap"] !== undefined) {
		return {
			kind: "usage",
			message: "--verification-token-cap applies only to tick, run and serve",
		};
	}

	if (command === "admit") {
		if (values.ref !== undefined || values["reload-ref"] !== undefined) {
			return {
				kind: "usage",
				message: "admit always reads main and takes no --ref",
			};
		}

		const issues = issuesOf(values);

		if (issues === null || issues.length !== 1 || issues[0] === undefined) {
			return { kind: "usage", message: "--issue <number> is required" };
		}

		if (values["state-dir"] === undefined || values["state-dir"] === "") {
			return { kind: "usage", message: "--state-dir <dir> is required" };
		}

		return {
			kind: "admit",
			repo: values.repo,
			issue: issues[0],
			stateDir: resolve(values["state-dir"]),
		};
	}

	if (
		values.issue !== undefined ||
		(values["state-dir"] !== undefined && command !== "status")
	) {
		return {
			kind: "usage",
			message: "--issue applies only to admit, tick, run and serve",
		};
	}

	const ref = values.ref ?? TRUSTED_REF;
	const reloadRef = values["reload-ref"] ?? null;

	if (reloadRef !== null && command !== "workflow-check") {
		return {
			kind: "usage",
			message: "--reload-ref applies only to workflow-check",
		};
	}

	for (const branch of [ref, reloadRef]) {
		if (branch !== null && !isBranchName(branch)) {
			return {
				kind: "usage",
				message: "--ref and --reload-ref must be branch names",
			};
		}
	}

	const stateDir = values["state-dir"];

	return {
		kind: "workflow",
		command,
		repo: values.repo,
		ref,
		reloadRef,
		stateDir:
			stateDir === undefined || stateDir === "" ? null : resolve(stateDir),
	};
}

function parseCliArgs(argv: readonly string[]) {
	return parseArgs({
		args: [...argv],
		allowPositionals: true,
		strict: true,
		options: {
			json: { type: "boolean" },
			once: { type: "boolean" },
			repo: { type: "string" },
			ref: { type: "string" },
			"reload-ref": { type: "string" },
			issue: { type: "string", multiple: true },
			"state-dir": { type: "string" },
			"verification-token-cap": { type: "string" },
		},
	});
}

function redactString(_key: string, item: JsonValue): JsonValue {
	const text = String(item);

	return item === text ? redactCredentials(text) : item;
}

type ControllerView =
	| { readonly state: "unavailable"; readonly reason: string }
	| {
			readonly state: "running" | "stopped" | "stale_lock" | "unreadable_lock";
			readonly pid: number | null;
			readonly since: string | null;
			readonly lastTick: JsonValue | null;
	  };

type StatusOutput = Omit<StatusReport, "controller"> & {
	readonly controller: ControllerView;
	readonly attention: AttentionRead;
	readonly ledger: Awaited<ReturnType<typeof readLedgerBacklog>>;
	readonly accounting: Awaited<ReturnType<typeof readDurableAccounting>>;
	readonly durableUsage: JsonValue;
};

type Printable =
	| StatusOutput
	| CheckReport
	| ReturnType<typeof computeMetrics>
	| {
			readonly error:
				| "ledger_unavailable"
				| "ledger_too_large"
				| "intervention_fixture_invalid"
				| "now_after_defect_read";
	  }
	| AdmissionReceipt
	| TickReport
	| { readonly error: "controller_running"; readonly pid: number | null };

function json(report: Printable): string {
	return `${JSON.stringify(report, redactString, 2)}\n`;
}

function controllerView(
	lock: SocketLockState,
	lastTick: JsonValue | null,
): ControllerView {
	const holder =
		lock.kind === "socket_bound" || lock.kind === "holder_file_without_socket"
			? lock.holderFile
			: null;

	const state = {
		none: "stopped",
		socket_bound: "running",
		holder_file_without_socket: "stale_lock",
		unreadable: "unreadable_lock",
	} as const;

	return {
		state: state[lock.kind],
		pid: holder?.pid ?? null,
		since: holder?.acquiredAt ?? null,
		lastTick,
	};
}

async function isPrivateDirectory(path: string): Promise<boolean> {
	try {
		const info = await lstat(path);

		return (
			info.isDirectory() &&
			info.uid === process.geteuid?.() &&
			(info.mode & 0o022) === 0
		);
	} catch {
		return false;
	}
}

function realRuntime(): ControllerRuntime {
	return {
		clock: { now: () => Date.now() },
		policySource: {},
		procs: procTable(),
		sleep: async (ms, signal) => {
			await delay(ms, undefined, { signal }).catch(() => undefined);
		},
		signal: new AbortController().signal,
		executor: (context) =>
			sandboxExecutor({
				...context,
				xdgRuntimeDir: XDG_RUNTIME_DIR,
				sourceRoot: fileURLToPath(new URL("..", import.meta.url)),
			}),
	};
}

async function runController(
	parsed: Extract<Parsed, { kind: "controller" }>,
	io: CliIo,
): Promise<number> {
	const runtime = io.runtime ?? realRuntime();
	const { clock } = runtime;
	const log = lineLog(io.stderr, () => clock.now());

	if (!FACTORY_REPOSITORIES.includes(parsed.repo)) {
		log("controller_refused", { reason: "repo_not_allowed" });

		return EXIT.invalid;
	}

	if (!(await isPrivateDirectory(parsed.stateDir))) {
		log("controller_refused", { reason: "state_unavailable" });

		return EXIT.invalid;
	}

	const acquired = await acquireLock({
		stateDir: parsed.stateDir,
		procs: runtime.procs,
		now: () => clock.now(),
	});

	if (acquired.kind === "held") {
		const pid = acquired.holder?.pid ?? null;

		log("controller_running", { pid });

		if (parsed.command !== "serve") {
			io.stdout(json({ error: "controller_running", pid }));
		}

		return EXIT.usage;
	}

	if (acquired.kind === "unavailable") {
		log("controller_refused", { reason: "lock_unavailable" });

		return EXIT.invalid;
	}

	const { lock } = acquired;

	try {
		if (acquired.replaced !== null) {
			log("lock_stale_replaced", {
				pid: acquired.replaced.pid,
				since: acquired.replaced.acquiredAt,
			});
		}

		const identity = await checkIdentity(
			new GitHubTicketAdapter({ exec: io.exec, repo: parsed.repo }),
		);

		if (identity.kind !== "ok") {
			log("controller_refused", {
				reason:
					identity.kind === "mismatch"
						? "identity_mismatch"
						: "identity_unavailable",
			});

			return EXIT.invalid;
		}

		const pinned = await pinVerification(
			parsed.stateDir,
			parsed.verificationCap === null
				? null
				: {
						repo: parsed.repo,
						issues: parsed.scope ?? [],
						tokenCap: parsed.verificationCap,
					},
		);

		if (pinned.kind === "refused") {
			log("controller_refused", { reason: pinned.reason });

			return EXIT.invalid;
		}

		if (pinned.kind === "pinned")
			log("verification_cap_pinned", {
				tokenCap: pinned.tokenCap,
				digest: pinned.digest.slice(0, 12),
			});

		const orchestrator = new Orchestrator({
			exec: io.exec,
			env: io.env,
			repo: parsed.repo,
			store: fileAdmissionStore(parsed.stateDir),
			files: fileRunFiles(parsed.stateDir, runtime.policySource),
			executor: runtime.executor({
				stateDir: parsed.stateDir,
				exec: io.exec,
				log,
			}),
			clock,
			scope: parsed.scope,
			log,
			verification:
				pinned.kind === "pinned"
					? { digest: pinned.digest, tokenCap: pinned.tokenCap }
					: null,
		});

		const pump = () =>
			pumpLedgerOutbox({
				stateDir: parsed.stateDir,
				exec: io.exec,
				repo: parsed.repo,
				now: clock.now(),
				log,
			});

		if (parsed.command === "serve") {
			log("controller_ready", {
				pid: lock.holder.pid,
				repo: parsed.repo,
				scope: parsed.scope?.join("+") ?? "all",
			});

			const interventionCache = new Map<string, InterventionRead>();

			const metrics = startMetricSnapshots({
				stateDir: parsed.stateDir,
				collect: () =>
					collectOwnerMetrics(
						parsed.stateDir,
						parsed.repo,
						io,
						interventionCache,
					),
				log,
			});

			try {
				await serveLoop({
					orchestrator,
					stateDir: parsed.stateDir,
					sleep: runtime.sleep,
					signal: runtime.signal,
					log,
					pump,
				});
			} finally {
				await metrics.stop();
			}

			return EXIT.ok;
		}

		const ticked = await orchestrator.tick();

		const report =
			(await orchestrator.drain((ms) =>
				runtime.sleep(ms, new AbortController().signal),
			)) ?? ticked;

		if (!(await writeStatus(parsed.stateDir, report))) {
			log("status_unwritable", {});
		}

		await pump();
		io.stdout(json(report));

		if (parsed.command === "tick") return EXIT.ok;

		return report.runs.some((run) => parsed.scope?.includes(run.issue))
			? EXIT.ok
			: EXIT.invalid;
	} finally {
		await lock.release();
	}
}

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

		if (
			label.code !== 0 ||
			textOf(fieldOf(objectOf(parseJson(label.stdout)), "name")) !==
				METRIC_POLICY.defect.label
		)
			return { kind: "unknown", reason: "label_missing" };
	} catch {
		return { kind: "unknown", reason: "label_missing" };
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
					`repos/${repo}/issues?labels=${encodeURIComponent(METRIC_POLICY.defect.label)}&state=all&per_page=100&page=${page}`,
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
	cache?: Map<string, InterventionRead>,
): Promise<Interventions> {
	const byPr = new Map<number, MetricReview[] | null>();
	const result = new Map<string, InterventionRead>();

	for (const line of parseLedger(ledger)) {
		if (
			line.kind !== "known" ||
			line.row.repo !== repo ||
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
								review.actor.toLowerCase() !==
									"exe-dev-github-integration[bot]",
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
): Promise<JsonValue> {
	const deadline = Date.now() + 120_000;

	const bounded: CliIo = {
		...io,
		exec: async (command, args, options) => {
			const remaining = deadline - Date.now();

			if (remaining <= 0) throw new Error("metric_deadline");

			const result = await io.exec(command, args, {
				...options,
				timeoutMs: Math.min(options?.timeoutMs ?? FETCH_TIMEOUT_MS, remaining),
			});

			if (Date.now() >= deadline) throw new Error("metric_deadline");

			return result;
		},
	};

	let report: ReturnType<typeof computeMetrics> | null = null;
	let ledgerIdentity: string | null = null;
	const gaps: string[] = [];
	let failure = "ledger_ref_unavailable";

	try {
		const api = ledgerApiOf(new GitHubPublicationApi(bounded.exec, repo));
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
			cache,
		);

		if ([...interventions.values()].some((read) => read.kind !== "known"))
			throw new Error(failure);
		failure = "receipt_read_unavailable";
		const receiptDigests = await readReceiptDigests(stateDir, ledger, repo);
		failure = "metric_compute_unavailable";
		report = computeMetrics({
			ledger,
			repo,
			now: evaluatedAt,
			defects,
			interventions,
			receiptDigests,
			source: "ledger",
		});

		if (report.status !== "complete") gaps.push(`report_${report.status}`);
	} catch (error) {
		throw new Error(
			error instanceof Error && error.message === "metric_deadline"
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

async function runOwnerFeedCli(
	argv: readonly string[],
	io: CliIo,
): Promise<number> {
	try {
		const { values, positionals } = parseArgs({
			args: [...argv],
			allowPositionals: true,
			strict: true,
			options: {
				json: { type: "boolean" },
				"state-dir": { type: "string" },
				repo: { type: "string" },
			},
		});

		if (
			values.json !== true ||
			!values["state-dir"] ||
			positionals.length > 0 ||
			(values.repo !== undefined && !isRepoSlug(values.repo))
		)
			throw new Error("usage");
		const repo = values.repo;
		io.stdout(
			`${JSON.stringify(await readOwnerFeed({ stateDir: values["state-dir"], repo: repo !== undefined && isRepoSlug(repo) ? repo : undefined }), null, 2)}\n`,
		);

		return EXIT.ok;
	} catch {
		io.stderr(
			"Usage: node server/cli.ts owner-feed --json --state-dir <dir> [--repo <owner/name>]\n",
		);

		return EXIT.usage;
	}
}

async function runMetricsCli(
	argv: readonly string[],
	io: CliIo,
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
				: await readMetricInterventions(ledger, values.repo, githubIo);

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
			}),
		),
	);

	return EXIT.ok;
}

async function runReplayCli(
	argv: readonly string[],
	io: CliIo,
): Promise<number> {
	let parsed;

	try {
		parsed = parseArgs({
			args: [...argv],
			allowPositionals: true,
			strict: true,
			options: {
				json: { type: "boolean" },
				corpus: { type: "string" },
				case: { type: "string" },
				"main-sha": { type: "string" },
				"previous-sha": { type: "string" },
				"candidate-sha": { type: "string" },
				"production-state-dir": { type: "string" },
				"budget-file": { type: "string" },
				"previous-row": { type: "string" },
				"candidate-row": { type: "string" },
				"previous-record": { type: "string" },
				"candidate-record": { type: "string" },
				"bundle-root": { type: "string" },
				side: { type: "string" },
				"previous-assets": { type: "string" },
				"candidate-assets": { type: "string" },
			},
		});
	} catch {
		io.stderr(`unrecognized replay options\n${USAGE}\n`);

		return EXIT.usage;
	}

	const { values: v, positionals } = parsed;
	const [action] = positionals;

	if (
		v.json !== true ||
		positionals.length !== 1 ||
		(action !== "check" && action !== "report")
	) {
		io.stderr(`replay requires check or report and --json\n${USAGE}\n`);

		return EXIT.usage;
	}

	try {
		const corpus = await loadReplayCorpus(resolve(v.corpus ?? REPLAY_CORPUS));

		const selected =
			v.case === undefined ? null : corpus.cases.find((c) => c.id === v.case);

		if (selected === undefined) throw new Error("replay_case_unknown");

		const pin = async (value: string | undefined, fallback: string) => {
			if (value !== undefined) {
				if (!isGitSha(value)) throw new Error("replay_sha_required");

				return value;
			}

			const result = await io.exec("git", [
				"rev-parse",
				"--verify",
				`${fallback}^{commit}`,
			]);

			const sha = result.stdout.trim();

			if (result.code !== 0 || !isGitSha(sha))
				throw new Error("replay_sha_unavailable");

			return sha;
		};

		if (action === "report") {
			if (
				selected === null ||
				v["previous-row"] === undefined ||
				v["candidate-row"] === undefined ||
				v["previous-record"] === undefined ||
				v["candidate-record"] === undefined ||
				v["previous-sha"] === undefined ||
				v["candidate-sha"] === undefined
			)
				throw new Error("replay_report_inputs_required");

			const previous = {
				headSha: await pin(v["previous-sha"], "HEAD"),
				row: replayRow(await readFile(resolve(v["previous-row"]))),
				record: readReplayRecord(
					await readFile(resolve(v["previous-record"]), "utf8"),
				),
			};

			const candidate = {
				headSha: await pin(v["candidate-sha"], "HEAD"),
				row: replayRow(await readFile(resolve(v["candidate-row"]))),
				record: readReplayRecord(
					await readFile(resolve(v["candidate-record"]), "utf8"),
				),
			};

			if (
				previous.record.caseId !== selected.id ||
				candidate.record.caseId !== selected.id
			)
				throw new Error("replay_case_mismatch");

			const previousAssets = v["previous-assets"];
			const candidateAssets = v["candidate-assets"];

			if (
				(previousAssets === undefined) !== (candidateAssets === undefined) ||
				[previousAssets, candidateAssets].some(
					(d) => d !== undefined && !/^[a-f0-9]{64}$/.test(d),
				)
			)
				throw new Error("replay_assets_invalid");
			io.stdout(
				`${JSON.stringify({ caseId: selected.id, expectedRound: selected.expectedRound, ...replayReport({ previous, candidate, expected: selected.expected, expectedAssets: previousAssets === undefined || candidateAssets === undefined ? undefined : { previous: previousAssets, candidate: candidateAssets } }) }, null, 2)}\n`,
			);

			return EXIT.ok;
		}

		const mainSha = await pin(v["main-sha"], "refs/remotes/origin/main");

		const previousSha = await pin(
			v["previous-sha"],
			"refs/remotes/origin/main",
		);

		const candidateSha = await pin(v["candidate-sha"], "HEAD");

		const report = await checkReplay({
			corpus,
			mainSha,
			previousSha,
			candidateSha,
			exec: io.exec,
		});

		const reasons: string[] = [];
		let production = "not_checked";

		if (v["production-state-dir"] !== undefined) {
			const lock = await readLock(resolve(v["production-state-dir"]));
			production = lock.kind;

			if (lock.kind === "socket_bound")
				reasons.push("production_controller_running");

			if (lock.kind === "unreadable")
				reasons.push("production_lock_unavailable");
		}

		const source = await io.exec("git", [
			"show",
			`${mainSha}:.github/factory/WORKFLOW.md`,
		]);

		const repo = "giuseppecrj/pi-herdr-factorio";

		if (!isRepoSlug(repo)) throw new Error("replay_repository_invalid");

		const policy =
			source.code === 0
				? parseWorkflow({ text: source.stdout, repo, env: io.env })
				: null;

		const cap =
			policy?.kind === "valid"
				? (policy.config.replay?.maxTokens ?? null)
				: null;

		const budget =
			v["budget-file"] === undefined
				? null
				: await readReplayBudget(resolve(v["budget-file"]));

		const budgetDecision = decideReplayBudget(
			budget ?? {
				v: 1,
				maxTokens: null,
				policyChanges: [],
				reservations: [],
				chargedTokens: 0,
				wallMs: 0,
			},
			cap,
		);

		reasons.push(
			...budgetDecision.reasons.filter(
				(reason) => reason !== "replay_disabled" || selected !== null,
			),
		);

		if (selected !== null) {
			const c = report.cases.find((entry) => entry.id === selected.id);

			if (c?.status !== "ready")
				reasons.push(c?.status ?? "replay_case_unknown");

			if (v["budget-file"] === undefined)
				reasons.push("replay_budget_required");

			if (v["production-state-dir"] === undefined)
				reasons.push("production_lock_required");

			if (report.bundle === "unavailable") reasons.push("bundle_unavailable");

			if (
				v["bundle-root"] !== undefined &&
				v["previous-assets"] !== undefined &&
				v["candidate-assets"] !== undefined &&
				v.side !== undefined
			) {
				await checkReplayBundles({
					root: resolve(v["bundle-root"]),
					previousSha,
					candidateSha,
					previousAssets: v["previous-assets"],
					candidateAssets: v["candidate-assets"],
					side: v.side,
					exec: io.exec,
				});
			} else if (report.bundle === "bundle_switch_required")
				reasons.push("bundle_switch_required");
		}

		io.stdout(
			`${JSON.stringify({ ...report, production, policy: policy?.kind === "valid" ? { workflowSha: mainSha, workflowDigest: digestOf(source.stdout) } : null, budget: { maxTokens: cap, perRunCap: REPLAY_RUN_CAP, chargedTokens: budget?.chargedTokens ?? null, remainingTokens: budget === null ? null : budgetDecision.remainingTokens, pendingPolicyChange: budgetDecision.pendingPolicyChange === null ? null : { ...budgetDecision.pendingPolicyChange, workflowDigest: digestOf(source.stdout), mainSha }, wallMs: budget?.wallMs ?? null }, reasons, allowed: selected === null ? null : reasons.length === 0 }, null, 2)}\n`,
		);

		return reasons.length === 0 &&
			!report.cases.some((c) => c.status === "unavailable")
			? EXIT.ok
			: EXIT.invalid;
	} catch (error) {
		const code =
			error instanceof Error && /^[a-z_]+$/.test(error.message)
				? error.message
				: "replay_input_unavailable";

		io.stdout(`${JSON.stringify({ error: code, promotes: false })}\n`);

		return EXIT.invalid;
	}
}

export async function runCli(
	argv: readonly string[],
	caller: CliIo,
): Promise<number> {
	const io: CliIo = {
		...caller,
		stderr: (text) => caller.stderr(redactCredentials(text)),
	};

	if (argv[0] === "replay") return runReplayCli(argv.slice(1), io);

	if (argv[0] === "metrics") return runMetricsCli(argv.slice(1), io);

	if (argv[0] === "owner-feed") return runOwnerFeedCli(argv.slice(1), io);

	if (argv[0] === "viewer") return runViewerCli(argv.slice(1), io);

	if (argv[0] === "gates") return runGatesCli(argv.slice(1), io);

	const parsed = parse(argv);

	if (parsed.kind === "usage") {
		io.stderr(`${parsed.message}\n${USAGE}\n`);

		return EXIT.usage;
	}

	if (parsed.kind === "controller") return runController(parsed, io);

	if (parsed.kind === "admit") {
		const receipt = await admitTicket({
			exec: io.exec,
			env: io.env,
			repo: parsed.repo,
			issue: parsed.issue,
			allowlist: FACTORY_REPOSITORIES,
			store: fileAdmissionStore(parsed.stateDir),
		});

		io.stdout(json(receipt));

		return receipt.decision === "admitted" ? EXIT.ok : EXIT.invalid;
	}

	const { repo, ref, reloadRef } = parsed;
	const load = await loadWorkflow({ exec: io.exec, repo, ref, env: io.env });

	if (parsed.command === "status") {
		const report = statusReport(load, manifest.version);

		const controller: ControllerView =
			parsed.stateDir === null
				? {
						state: "unavailable",
						reason: "pass --state-dir to read the controller lock",
					}
				: controllerView(
						await readLock(parsed.stateDir),
						await readStatus(parsed.stateDir),
					);

		const attention = await readAttention({
			stateDir: parsed.stateDir,
			repo,
			now: Date.now(),
			thresholds:
				load.kind === "loaded" ? load.snapshot.config.attention : undefined,
		});

		const ledger = await readLedgerBacklog(
			parsed.stateDir,
			io.runtime?.clock.now() ?? Date.now(),
		);

		const accounting = await readDurableAccounting(parsed.stateDir, repo);
		const durableUsage = durableUsageOf(accounting);

		io.stdout(
			json({
				...report,
				controller,
				attention,
				ledger,
				accounting,
				durableUsage,
			}),
		);

		return EXIT.ok;
	}

	if (reloadRef === null) {
		io.stdout(json(checkReport(load, null)));

		return load.kind === "loaded" ? EXIT.ok : EXIT.invalid;
	}

	const next = await loadWorkflow({
		exec: io.exec,
		repo,
		ref: reloadRef,
		env: io.env,
	});

	io.stdout(json(checkReport(load, next)));

	return load.kind === "loaded" && next.kind === "loaded"
		? EXIT.ok
		: EXIT.invalid;
}

/**
 * Runs a program asynchronously with an argument array, so `serve` never
 * blocks on a child. A program that cannot start throws. One that times out
 * is killed and reported as a failure whose stderr says it timed out.
 */
export async function execFile(
	command: string,
	args: readonly string[],
	timeoutMs: number,
): Promise<ExecResult> {
	const metricLedger =
		command === "git" &&
		args.length === 2 &&
		args[0] === "show" &&
		args[1] === "refs/remotes/origin/factory/ledger:ledger/runs.jsonl";

	const options: ExecFileOptionsWithStringEncoding = {
		encoding: "utf8",
		timeout: timeoutMs,
		maxBuffer: 4 * 1024 * 1024,
		killSignal: "SIGKILL",
	};

	if (metricLedger) options.maxBuffer = 256 * 1024 * 1024;

	return new Promise((done, fail) => {
		const child = execFileCallback(
			command,
			[...args],
			options,
			(error, stdout, stderr) => {
				if (error === null) {
					done({ stdout, stderr, code: 0 });

					return;
				}

				if (child.pid === undefined) {
					fail(error);

					return;
				}

				const timedOut = error.killed === true && error.code === null;

				done({
					stdout,
					stderr:
						metricLedger && error.code === "ERR_CHILD_PROCESS_STDIO_MAXBUFFER"
							? "metric_ledger_too_large"
							: timedOut
								? `${command} timed out`
								: stderr || error.message,
					code: Number.isSafeInteger(error.code) ? Number(error.code) || 1 : 1,
				});
			},
		);
	});
}

if (import.meta.main) {
	process.env.XDG_RUNTIME_DIR ??= XDG_RUNTIME_DIR;

	const stop = new AbortController();

	for (const name of ["SIGTERM", "SIGINT"] as const) {
		process.on(name, () => stop.abort());
	}

	process.exitCode = await runCli(process.argv.slice(2), {
		exec: (command, args, options) =>
			execFile(
				command,
				args,
				Math.min(FETCH_TIMEOUT_MS, options?.timeoutMs ?? FETCH_TIMEOUT_MS),
			),
		env: (name) => process.env[name],
		stdout: (text) => process.stdout.write(text),
		stderr: (text) => process.stderr.write(text),
		runtime: { ...realRuntime(), signal: stop.signal },
	});
}
