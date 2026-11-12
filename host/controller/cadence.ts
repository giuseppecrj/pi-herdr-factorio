import { lstatSync, readdirSync, readFileSync } from "node:fs";
import { lstat, readdir, readFile, stat } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { trustedWorkflowConfig } from "../../src/config/load.ts";
import { STAGE_CLEANUP_RESERVE_MS } from "../../src/config/schema.ts";
import { inert } from "../../src/contract/render.ts";
import {
	arrayOf,
	countOf,
	objectOf,
	parseJson as parseJsonText,
	textOf,
	type JsonValue,
} from "../../src/core/json.ts";
import { digestOf, isDigest } from "../../src/core/run.ts";
import {
	GitHubTicketAdapter,
	GitHubTicketWriter,
} from "../../src/github/adapter.ts";
import type { Exec } from "../../src/github/exec.ts";
import { frozenRowOf } from "../../src/ledger/schema.ts";
import {
	cadenceExcerpt,
	cadenceExecutionDir,
	cadenceIssueBody,
	cadencePrivateDir,
	cadencePrompt,
	CadenceRunner,
	cadenceScope,
	cadenceSkills,
	inCadenceScope,
	isReflectionPath,
	parseCadenceProposals,
	readCadenceFile,
	readCadenceInput,
	reflectionCitation,
	triggerProposal,
	triggerRecord,
	writeCadenceFile,
	type CadenceInput,
	type CadenceKnownProposal,
	type CadenceProposal,
	type CadenceResult,
} from "../../src/maintenance/cadence.ts";
import {
	reflectScores,
	scoreHistory,
	unreviewedFailures,
} from "../../src/maintenance/scorers.ts";
import type { StageExecutor } from "../../src/controller/launch.ts";
import type { Log } from "../../src/controller/orchestrator.ts";
import { fileAdmissionStore } from "../../src/trust/admission.ts";
import { cadenceMarker } from "../../src/trust/markers.ts";
import type { PlatformProfile, RepoSlug } from "../../src/trust/platform.ts";
import { REPO_SWITCH_LABEL } from "../../src/trust/policy.ts";
import { measurementPrimary } from "../../src/views/metrics.ts";
import { readStageReceipt } from "../sandbox/receipts.ts";
import type { ScorePumpInput } from "./measurement.ts";

export async function cadenceSwitches(
	stateDir: string,
	adapter: GitHubTicketAdapter,
): Promise<boolean> {
	if ((await fileAdmissionStore(stateDir).localSwitch()) !== "enabled")
		return false;

	const enabled = await adapter.readRepoSwitch();

	return (
		enabled.kind === "ok" &&
		enabled.value.kind === "present" &&
		enabled.value.name === REPO_SWITCH_LABEL
	);
}

/** Local, already-redacted ledger rows only. No sessions, private suites or inferred zeroes. */
async function cadenceLedger(stateDir: string): Promise<string> {
	const root = join(stateDir, "ledger");
	const names = (await readdir(root).catch(() => [])).filter(isDigest);

	const dated = await Promise.all(
		names.map(async (name) => ({
			name,
			at: await stat(join(root, name, "row.json")).then(
				(info) => info.mtimeMs,
				() => 0,
			),
		})),
	);

	const rows: JsonValue[] = [];
	let bytes = 0;

	for (const { name } of dated.sort((a, b) => b.at - a.at).slice(0, 20)) {
		const path = join(root, name, "row.json");
		const info = await lstat(path).catch(() => null);

		if (
			info === null ||
			!info.isFile() ||
			info.isSymbolicLink() ||
			info.size > 128 * 1024
		)
			continue;

		const text = await readFile(path, "utf8");
		const frozen = frozenRowOf(Buffer.from(text));

		if (frozen === null || bytes + Buffer.byteLength(text) > 16 * 1024)
			continue;

		bytes += Buffer.byteLength(text);
		rows.push(parseJsonText(frozen.bytes.toString("utf8")) ?? null);
	}

	return JSON.stringify({
		source: "local_redacted_ledger",
		coverage:
			"at most 20 retained rows and 16 KiB; missing evidence is unknown",
		rows,
	});
}

async function publishProposalIntent(input: {
	stateDir: string;
	intents: string;
	key: string;
	fingerprint: string;
	title: string;
	body: string;
	issues: readonly { body: string }[];
	adapter: GitHubTicketAdapter;
	writer: GitHubTicketWriter;
	signal?: AbortSignal;
}): Promise<boolean> {
	const { key, fingerprint, intents, adapter, writer } = input;

	if (input.signal?.aborted) return false;
	cadencePrivateDir(intents);
	const path = join(intents, `${fingerprint}.json`);
	const saved = readCadenceFile(path);
	let { title, body } = input;

	if (saved === null)
		writeCadenceFile(path, JSON.stringify({ key, title, body }));
	else {
		const intent = objectOf(parseJsonText(saved));

		const keptBody = textOf(intent?.body),
			keptTitle = textOf(intent?.title);

		if (
			intent?.key !== key ||
			keptBody === null ||
			keptTitle === null ||
			keptBody.length > 24_000 ||
			keptTitle.length > 220 ||
			!keptBody.endsWith(`\n\n${key}`)
		)
			return false;

		if (intent.posted === true) return true;
		body = keptBody;
		title = keptTitle;
	}

	if (input.issues.some((issue) => issue.body.split("\n").includes(key))) {
		writeCadenceFile(path, JSON.stringify({ key, title, body, posted: true }));

		return true;
	}

	if (
		input.signal?.aborted ||
		!(await cadenceSwitches(input.stateDir, adapter)) ||
		input.signal?.aborted
	)
		return false;
	const created = await writer.createIssue(title, body, ["factory:proposed"]);

	// Unknown creates must reconcile on a later pass, never retry here.
	if (created.kind !== "posted") return false;
	writeCadenceFile(path, JSON.stringify({ key, title, body, posted: true }));

	return true;
}

/** Local eligibility first; at most one remote reconciliation per hour per scorer. */
export async function runImprovementTrigger(
	input: ScorePumpInput,
): Promise<boolean> {
	const config = trustedWorkflowConfig(input.repo) ?? input.config;
	const { trigger, scorers } = config ?? {};

	if (trigger == null || !scorers?.length) return true;
	const events = scoreHistory(input.stateDir);
	const now = (input.clock ?? Date.now)();
	const intents = join(input.stateDir, "cadence", "trigger", "proposals");
	const primary = measurementPrimary(input.stateDir, input.repo);
	const due = [];

	for (const scorer of scorers) {
		const path = join(intents, `read-${scorer.id}.json`);
		const saved = objectOf(parseJsonText(readCadenceFile(path) ?? ""));

		const filed = (arrayOf(saved?.runs) ?? []).flatMap((value) => {
			const run = textOf(value);

			return run !== null && isDigest(run) ? [run] : [];
		});

		const proposal = triggerProposal({
			repo: input.repo,
			scorerId: scorer.id,
			failures: unreviewedFailures(events, scorer.id, new Set(filed)),
			...trigger,
			now,
			primary,
		});

		if (proposal === null) continue;
		const at = countOf(saved?.at);

		if (at !== null && now - at < 3_600_000) continue;
		due.push({ scorer, path, filed });
	}

	if (due.length === 0) return true;

	if ((await fileAdmissionStore(input.stateDir).localSwitch()) !== "enabled")
		return false;
	cadencePrivateDir(intents);

	for (const { path, filed } of due)
		writeCadenceFile(path, JSON.stringify({ at: now, runs: filed }));

	const adapter = new GitHubTicketAdapter({
		exec: input.exec,
		repo: input.repo,
	});

	if (!(await cadenceSwitches(input.stateDir, adapter))) return false;

	const issues = await adapter.readCadenceIssues(
		input.platform.controllerLogin,
	);

	if (issues.kind !== "ok") return false;

	const records = issues.value.flatMap((issue) => {
		const record = triggerRecord(issue.body, input.repo);

		return record === null ? [] : [{ ...record, state: issue.state }];
	});

	const writer = new GitHubTicketWriter({ exec: input.exec, repo: input.repo });

	for (const { scorer, path, filed } of due) {
		const knownRuns = new Set([
			...filed,
			...records
				.filter((record) => record.scorerId === scorer.id)
				.flatMap((record) => record.runs),
		]);

		writeCadenceFile(path, JSON.stringify({ at: now, runs: [...knownRuns] }));

		if (
			records.some(
				(record) => record.scorerId === scorer.id && record.state === "open",
			)
		)
			continue;

		const reviewed = knownRuns;

		const proposal = triggerProposal({
			repo: input.repo,
			scorerId: scorer.id,
			failures: unreviewedFailures(events, scorer.id, reviewed),
			...trigger,
			now,
			primary,
		});

		if (proposal === null) continue;

		if (
			!(await publishProposalIntent({
				...input,
				...proposal,
				intents,
				issues: issues.value,
				adapter,
				writer,
			}))
		)
			return false;

		for (const run of triggerRecord(proposal.body, input.repo)?.runs ?? [])
			knownRuns.add(run);
		writeCadenceFile(path, JSON.stringify({ at: now, runs: [...knownRuns] }));
		input.log("improvement_proposed", {
			scorer: scorer.id,
			fingerprint: proposal.fingerprint,
		});
	}

	return true;
}

export async function publishCadenceProposals(input: {
	stateDir: string;
	exec: Exec;
	platform: PlatformProfile;
	execution: CadenceInput;
	result: CadenceResult;
	proposals: readonly CadenceProposal[];
	signal?: AbortSignal;
}): Promise<boolean> {
	const { execution, result } = input;

	const adapter = new GitHubTicketAdapter({
		exec: input.exec,
		repo: execution.repo,
	});

	const writer = new GitHubTicketWriter({
		exec: input.exec,
		repo: execution.repo,
	});

	const intents = join(input.stateDir, "cadence", execution.job, "proposals");
	cadencePrivateDir(intents);

	const issues = await adapter.readCadenceIssues(
		input.platform.controllerLogin,
		input.signal,
	);

	if (issues.kind !== "ok" || input.signal?.aborted) return false;

	const invalidEvidence: {
		fingerprint: string;
		path: string;
		start: number;
		end: number;
	}[] = [];

	const dropped: string[] = [];

	const dir = cadenceExecutionDir(
		input.stateDir,
		execution.job,
		execution.windowStart,
	);

	const excerpt = objectOf(
		parseJsonText(readCadenceFile(join(dir, "excerpt.json")) ?? ""),
	);

	const shown = arrayOf(excerpt?.files) ?? [];

	for (const finding of input.proposals) {
		if (input.signal?.aborted) return false;
		const evidence = [];

		for (const citation of finding.evidence) {
			if (execution.job === "reflect" && isReflectionPath(citation.path)) {
				if (reflectionCitation(citation, excerpt?.reflection))
					evidence.push(citation);
				else
					invalidEvidence.push({
						fingerprint: finding.fingerprint,
						...citation,
					});
				continue;
			}

			const source = join(dir, "tree", citation.path);
			const info = await lstat(source).catch(() => null);

			const lines =
				info?.isFile() && !info.isSymbolicLink() && info.size <= 1024 * 1024
					? (await readFile(source, "utf8")).split("\n")
					: [];

			if (lines.at(-1) === "") lines.pop();

			const visible = shown.some((file) => {
				const entry = objectOf(file);

				return (
					entry?.path === citation.path &&
					(arrayOf(entry.ranges) ?? []).some((value) => {
						const range = objectOf(value);

						const start = countOf(range?.start),
							end = countOf(range?.end);

						return (
							start !== null &&
							end !== null &&
							citation.start >= start &&
							citation.end <= end
						);
					})
				);
			});

			if (
				visible &&
				citation.start >= 1 &&
				citation.end >= citation.start &&
				citation.end <= lines.length
			)
				evidence.push(citation);
			else
				invalidEvidence.push({ fingerprint: finding.fingerprint, ...citation });
		}

		if (evidence.length === 0) dropped.push(finding.fingerprint);
		writeCadenceFile(
			execution.job === "reflect"
				? join(intents, `filing-${execution.windowStart}.json`)
				: join(dir, "filing.json"),
			JSON.stringify({
				reason:
					invalidEvidence.length > 0 ? "invalid_evidence" : "valid_evidence",
				invalidEvidence,
				dropped,
			}),
		);

		if (evidence.length === 0) continue;
		const proposal = { ...finding, evidence };

		const key = cadenceMarker(
			execution.repo,
			execution.job,
			proposal.fingerprint,
		);

		const body = cadenceIssueBody(
			proposal,
			result,
			measurementPrimary(input.stateDir, execution.repo),
		);

		const title = `Factory ${execution.job}: ${inert(proposal.title)
			.replace(/\\(.)/gs, "$1")
			.replaceAll("\\", "")
			.replace(/\p{Cc}/gu, " ")}`.slice(0, 220);

		if (
			!(await publishProposalIntent({
				...input,
				intents,
				key,
				fingerprint: proposal.fingerprint,
				title,
				body,
				issues: issues.value,
				adapter,
				writer,
			}))
		)
			return false;
	}

	return true;
}

export function controllerCadence(input: {
	stateDir: string;
	repo: RepoSlug;
	exec: Exec;
	platform: PlatformProfile;
	executor: StageExecutor;
	log: Log;
	signal?: AbortSignal;
}): CadenceRunner {
	const adapter = new GitHubTicketAdapter({
		exec: input.exec,
		repo: input.repo,
	});

	const retained = async (execution: CadenceInput): Promise<CadenceResult> => {
		const { executionCharge } = await import("../sandbox/receipts.ts");

		const runtime = join(
			cadenceExecutionDir(input.stateDir, execution.job, execution.windowStart),
			"runtime",
		);

		const native = await readStageReceipt(join(runtime, "receipt.json"));

		const raw =
			native === null ? null : readCadenceFile(join(runtime, "receipt.json"));

		const charge = await executionCharge(runtime);

		const valid =
			native !== null &&
			native.record !== null &&
			raw !== null &&
			native.record.runId === execution.runId &&
			native.record.stage === "maintain" &&
			native.record.attempt === 1;

		const completed = valid && native.outcome.kind === "passed";
		const capped = valid && native.outcome.kind === "budget_exhausted";

		const output =
			completed || capped ? readCadenceFile(join(runtime, "output.txt")) : null;

		const passed =
			completed ||
			(capped &&
				output !== null &&
				parseCadenceProposals(output, execution) !== null);

		const usable =
			passed && output !== null && Buffer.byteLength(output) <= 64 * 1024;

		return {
			kind: usable ? "passed" : "failed",
			tokens: valid
				? Math.max(native.usage.total, charge?.total ?? 0)
				: Math.max(execution.settings.maxTokens, charge?.total ?? 0),
			uncertain: (charge?.uncertain ?? 0) > 0,
			exact: valid && charge !== null && charge.uncertain === 0,
			model: valid
				? (textOf(objectOf(native.record?.models)?.observed) ??
					execution.settings.model)
				: execution.settings.model,
			receiptDigest: digestOf(
				raw ??
					JSON.stringify({
						execution,
						reason: "interrupted",
						tokens: charge?.total ?? null,
					}),
			),
			output: usable ? output : null,
			reason:
				usable && capped
					? "answered_at_cap"
					: passed && !usable
						? "invalid_output"
						: valid
							? native.outcome.kind
							: "interrupted",
		};
	};

	return new CadenceRunner({
		stateDir: input.stateDir,
		repo: input.repo,
		log: input.log,
		port: {
			retained,
			publish: (execution, result, proposals, signal) =>
				publishCadenceProposals({
					...input,
					execution,
					result,
					proposals,
					signal,
				}),
			async execute(execution, signal) {
				const started = Date.now();

				const dir = cadenceExecutionDir(
					input.stateDir,
					execution.job,
					execution.windowStart,
				);

				const failed = (reason: string): CadenceResult => ({
					launched: false,
					kind: "failed",
					tokens: 0,
					exact: true,
					model: execution.settings.model,
					receiptDigest: digestOf(JSON.stringify({ execution, reason })),
					output: null,
					reason,
				});

				const deadline = AbortSignal.any([
					signal,
					input.signal ?? signal,
					AbortSignal.timeout(
						execution.settings.budget.wallMs - STAGE_CLEANUP_RESERVE_MS,
					),
				]);

				if (
					deadline.aborted ||
					!(await cadenceSwitches(input.stateDir, adapter))
				)
					return failed("disabled");

				if (!(await input.executor.preflight()))
					return failed("sandbox_unavailable");

				const previous = readdirSync(join(dir, ".."))
					.filter(
						(name) =>
							/^\d+$/.test(name) && Number(name) < execution.windowStart,
					)
					.sort((a, b) => Number(b) - Number(a))
					.find((name) => {
						const receipt = objectOf(
							parseJsonText(
								readCadenceFile(join(dir, "..", name, "receipt.json")) ?? "",
							),
						);

						return (
							receipt?.launched !== false && (countOf(receipt?.tokens) ?? 0) > 0
						);
					});

				const previousBaseSha =
					execution.previousBaseSha ??
					(previous === undefined
						? undefined
						: readCadenceInput(
								join(dir, "..", previous, "input.json"),
								execution.repo,
								execution.job,
								Number(previous),
							).baseSha);

				let changedPaths: string[] = [];

				if (previousBaseSha !== undefined) {
					const changes = await input.exec("git", [
						"-C",
						fileURLToPath(new URL("../..", import.meta.url)),
						"diff",
						"--name-only",
						"--no-renames",
						"-z",
						previousBaseSha,
						execution.baseSha,
						"--",
					]);

					if (changes.code !== 0) return failed("changes_unavailable");
					changedPaths = changes.stdout
						.split("\0")
						.filter((path) => path !== "");
				}

				execution = { ...execution, changedPaths, previousBaseSha };

				const existing = await adapter.readCadenceIssues(
					input.platform.controllerLogin,
					deadline,
				);

				if (existing.kind !== "ok") return failed("proposals_unavailable");
				const existingProposals: CadenceKnownProposal[] = [];

				for (const issue of existing.value) {
					const marker = issue.body
						.split("\n")
						.find((line) =>
							line.startsWith(
								`<!-- factory:cadence ${execution.repo} ${execution.job} `,
							),
						);

					const fingerprint = marker?.split(" ").at(-2);

					const link = issue.body.match(
						/\]\(https:\/\/github\.com\/[^/]+\/[^/]+\/blob\/[a-f0-9]{40}\/([A-Za-z0-9_.\-/]+)#L\d+-L\d+\)/,
					);

					const path = link?.[1];

					if (
						fingerprint !== undefined &&
						/^[a-f0-9]{64}$/.test(fingerprint) &&
						(path !== undefined || execution.job === "reflect") &&
						(execution.job === "reflect" ||
							inCadenceScope(
								path ?? "",
								cadenceScope(execution.rotation, execution.job),
							) ||
							changedPaths.includes(path ?? ""))
					)
						existingProposals.push({
							fingerprint,
							title: issue.title.slice(0, 220),
							state: issue.state,
							path: path ?? "ledger",
						});
				}

				const workspace = join(dir, "tree");
				cadencePrivateDir(workspace);

				const checked = await input.executor.checkout({
					runId: execution.runId,
					repo: execution.repo,
					sha: execution.baseSha,
					workspace,
				});

				if (checked.kind !== "ready" || checked.omitted !== 0)
					return failed("checkout_unavailable");

				const sourceExcerpt = cadenceExcerpt(
					execution,
					checked.checkout.files,
					(path) => {
						const source = join(workspace, path);

						try {
							const info = lstatSync(source);

							return info.isFile() &&
								!info.isSymbolicLink() &&
								info.size <= 1024 * 1024
								? readFileSync(source, "utf8")
								: null;
						} catch {
							return null;
						}
					},
				);

				const ledger =
					execution.job === "hygiene" || execution.job === "reflect"
						? await cadenceLedger(input.stateDir)
						: "unavailable; not requested by this job";

				const excerpt =
					execution.job === "reflect"
						? {
								...sourceExcerpt,
								reflection: {
									primary: measurementPrimary(input.stateDir, execution.repo),
									ledger: parseJsonText(ledger) ?? null,
									scores: reflectScores(scoreHistory(input.stateDir)),
								},
							}
						: sourceExcerpt;

				writeCadenceFile(join(dir, "excerpt.json"), JSON.stringify(excerpt));
				const files = excerpt.files.map((file) => file.path);

				execution = {
					...execution,
					existingProposals: existingProposals
						.sort(
							(a, b) =>
								Number(files.includes(b.path)) -
									Number(files.includes(a.path)) ||
								Number(a.state === "open") - Number(b.state === "open"),
						)
						.slice(0, 100),
				};
				writeCadenceFile(join(dir, "input.json"), JSON.stringify(execution));

				const prompt = cadencePrompt(execution, files, ledger, excerpt);
				writeCadenceFile(join(dir, "prompt.txt"), prompt);

				if (
					deadline.aborted ||
					!(await cadenceSwitches(input.stateDir, adapter))
				)
					return failed("disabled_or_wall");

				const wallMs =
					execution.settings.budget.wallMs - (Date.now() - started);

				if (deadline.aborted || wallMs <= STAGE_CLEANUP_RESERVE_MS)
					return failed("wall");

				const launch = await input.executor.launch({
					runId: execution.runId,
					stage: "maintain",
					attempt: 1,
					maintenance: {
						job: execution.job,
						windowStart: execution.windowStart,
					},
					workspace,
					prompt,
					tools: [],
					skills: cadenceSkills(execution.job),
					settings: {
						model: execution.settings.model,
						fallback: null,
						maxTokens: execution.settings.maxTokens,
						budget: { ...execution.settings.budget, wallMs },
					},
					remainingRunTokens: execution.settings.maxTokens,
					signal: deadline,
					progress: () => undefined,
				});

				if (launch.kind !== "started") return failed("sandbox_unavailable");

				await launch.done;

				return retained(execution);
			},
		},
	});
}
