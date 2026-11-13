import { lstatSync } from "node:fs";
import { unlink } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { readPatch, readRepairBuildResult } from "../../src/candidate/build.ts";
import {
	canonicalJson,
	classifyFeedback,
	feedbackId,
	readFeedbackBatch,
	type BuilderDisposition,
	type FeedbackBatch,
	type FeedbackBatchRef,
	type FeedbackDisposition,
	type FeedbackEvent,
	type FeedbackId,
	type FeedbackObservation,
	type RoundReceipt,
} from "../../src/candidate/feedback.ts";
import {
	candidateGenerations,
	candidateUsage,
	completingFeedbackBatch,
	handoffGeneration,
	notProven,
	promotedHead,
	renderLimitation,
	type CandidateEvent,
} from "../../src/candidate/handoff.ts";
import {
	familyClaimsHold,
	findingFingerprints,
	reviewR8,
} from "../../src/candidate/review.ts";
import {
	sameGeneration,
	type CandidateState,
	type GenerationRef,
} from "../../src/candidate/state.ts";
import { publishedSuite } from "../../src/candidate/validation.ts";
import { loadPinnedWorkflow } from "../../src/config/load.ts";
import {
	isGitSha,
	type GitSha,
	type HandoffSettings,
} from "../../src/config/schema.ts";
import {
	exclusive,
	present,
	privateDir,
	regularText,
} from "../../src/contract/artifacts.ts";
import { inert, renderSummary, withoutKey } from "../../src/contract/render.ts";
import {
	arrayOf,
	countOf,
	fieldOf as jsonField,
	objectOf,
	parseJson as parseJsonText,
	textOf,
	textsOf,
	type JsonValue,
} from "../../src/core/json.ts";
import { FAMILY_MISSING } from "../../src/core/models.ts";
import { digestOf, type Digest } from "../../src/core/run.ts";
import {
	GitHubTicketAdapter,
	GitHubTicketWriter,
	isBotLogin,
	isLogin,
	parseOwnedPullRequest,
	type GitHubFailure,
	type OwnedPullRequest,
} from "../../src/github/adapter.ts";
import type { Exec } from "../../src/github/exec.ts";
import {
	GitHubPublicationApi,
	PublicationError,
	deriveOwnerPatch,
	readOwnerPatch,
} from "../../src/github/publish.ts";
import { ledgerApiOf } from "../../src/ledger/git.ts";
import { parseLedger } from "../../src/ledger/schema.ts";
import type { StageExecutor } from "../../src/controller/launch.ts";
import type { Log } from "../../src/controller/orchestrator.ts";
import {
	fileAdmissionStore,
	latestReadyEntry,
} from "../../src/trust/admission.ts";
import type { PlatformProfile, RepoSlug } from "../../src/trust/platform.ts";
import {
	READY_LABEL,
	REPO_SWITCH_LABEL,
	hasWriteAccess,
} from "../../src/trust/policy.ts";
import { ACCEPTANCE_SUITE_PREFIX } from "../../src/trust/protected-paths.ts";
import { checkoutWorkspace, ghTarball } from "./checkout.ts";
import { validLedgerInstant } from "./outbox.ts";
import { fileRunFiles } from "./run-files.ts";
import { lineLog } from "./serve-loop.ts";
import {
	fieldOf,
	installOnce,
	parseJson,
	writeAtomic,
	writeOnce,
} from "./state.ts";
import { controllerReport } from "./validation-sweep.ts";

async function retireUnissuedIntent(path: string, text: string): Promise<void> {
	try {
		if (present(path) && regularText(path) === text) await unlink(path);
	} catch {
		return;
	}
}

/** Failed pinned-workflow reads before handoff holds, about 5 minutes of ticks. */
export const WORKFLOW_READ_LIMIT = 10;

/**
 * The durable failed-read count for the run's pinned workflow. A count for
 * another SHA or digest, or an unreadable file, counts as none.
 */
function storedWorkflowFailures(path: string, state: CandidateState): number {
	try {
		const stored = objectOf(parseJsonText(regularText(path)));

		return jsonField(stored, "workflowSha") === state.pin.workflowSha &&
			jsonField(stored, "workflowDigest") === state.pin.workflowDigest
			? (countOf(jsonField(stored, "failures")) ?? 0)
			: 0;
	} catch {
		return 0;
	}
}

export function controllerCandidatePort(config: {
	readonly stateDir: string;
	readonly exec: Exec;
	readonly platform: PlatformProfile;
	/** Defaults to the controller's structured lines on stderr. */
	readonly log?: Log;
}): NonNullable<StageExecutor["candidate"]> {
	const files = fileRunFiles(config.stateDir);

	const log =
		config.log ??
		lineLog(
			(text) => process.stderr.write(text),
			() => Date.now(),
		);

	const pinnedHandoff = new Map<string, HandoffSettings | null>();
	const workflowFailures = new Map<string, number>();

	/**
	 * The reviewers named by the run's pinned WORKFLOW.md: settings, `null`
	 * for a pinned workflow without `handoff`, or `undefined` while a failed
	 * read may still clear. A failed integrity check, or the 10th failed read,
	 * throws `workflow_unavailable` so the run holds.
	 */
	const handoffOf = async (
		state: CandidateState,
	): Promise<HandoffSettings | null | undefined> => {
		const key = `${state.pin.repo} ${state.pin.workflowSha} ${state.pin.workflowDigest}`;

		if (pinnedHandoff.has(key)) return pinnedHandoff.get(key);

		const pinned = await loadPinnedWorkflow({
			exec: config.exec,
			repo: state.pin.repo,
			sha: state.pin.workflowSha,
			digest: state.pin.workflowDigest,
			env: (name) => process.env[name],
			platform: config.platform,
		});

		const counter = join(
			config.stateDir,
			"handoff",
			state.pin.runId,
			"workflow-read.json",
		);

		const runKey = `${state.pin.runId} ${key}`;

		if (pinned.kind !== "loaded") {
			// A transient read retries up to the bound, counted durably per run
			// and pin; an integrity failure can never clear, so it holds at once.
			const failures =
				Math.max(
					workflowFailures.get(runKey) ?? 0,
					storedWorkflowFailures(counter, state),
				) + 1;

			const held =
				pinned.kind === "integrity" || failures >= WORKFLOW_READ_LIMIT;

			log("handoff_workflow_unavailable", {
				issue: state.pin.issue,
				runId: state.pin.runId,
				workflowSha: state.pin.workflowSha,
				kind: pinned.kind,
				reason: pinned.reason,
				failures,
				limit: WORKFLOW_READ_LIMIT,
				held,
			});

			if (held) throw new PublicationError("workflow_unavailable");

			workflowFailures.set(runKey, failures);
			privateDir(dirname(counter));
			await writeAtomic(
				counter,
				JSON.stringify({
					workflowSha: state.pin.workflowSha,
					workflowDigest: state.pin.workflowDigest,
					failures,
				}),
			);

			return undefined;
		}

		workflowFailures.delete(runKey);
		await unlink(counter).catch(() => undefined);

		const handoff = pinned.config.handoff ?? null;
		pinnedHandoff.set(key, handoff);

		return handoff;
	};

	const branchOf = (state: CandidateState) =>
		`factory/pr/${state.pin.issue}-${state.pin.runId.slice(0, 12)}`;

	const allowed = async (state: CandidateState) => {
		if ((await fileAdmissionStore(config.stateDir).localSwitch()) !== "enabled")
			return false;

		const enabled = await new GitHubTicketAdapter({
			exec: config.exec,
			repo: state.pin.repo,
		}).readRepoSwitch();

		return (
			enabled.kind === "ok" &&
			enabled.value.kind === "present" &&
			enabled.value.name === REPO_SWITCH_LABEL
		);
	};

	const postNotice = async (
		state: CandidateState,
		number: number,
		key: string,
		body: string,
		update = false,
	): Promise<boolean> => {
		const adapter = new GitHubTicketAdapter({
			exec: config.exec,
			repo: state.pin.repo,
		});

		const comments = await adapter.readComments(number);

		if (comments.kind !== "ok") return false;

		const matching = comments.value.filter(
			(c) =>
				c.author?.login.toLowerCase() ===
					config.platform.controllerLogin.toLowerCase() &&
				c.author.type === "Bot" &&
				c.body.split("\n").includes(key),
		);

		if (matching.length > 1) return false;

		if (matching.length === 1) {
			const comment = matching[0]!;

			if (!update || comment.body === body) return true;

			if (!(await allowed(state))) return false;

			return (
				(
					await new GitHubTicketWriter({
						exec: config.exec,
						repo: state.pin.repo,
					}).editComment(comment.id, body)
				).kind === "posted"
			);
		}

		const dir = join(config.stateDir, "handoff", state.pin.runId, "feedback");
		privateDir(dir);
		const intent = join(dir, `notice-${digestOf(key)}.json`);
		const bytes = JSON.stringify({ key });

		if (present(intent)) {
			if (regularText(intent) !== bytes) return false;
		} else exclusive(intent, bytes);

		if (!(await allowed(state))) {
			await retireUnissuedIntent(intent, bytes);

			return false;
		}

		const posted = await new GitHubTicketWriter({
			exec: config.exec,
			repo: state.pin.repo,
		}).postComment(number, body);

		if (posted.kind === "rejected") await retireUnissuedIntent(intent, bytes);

		return posted.kind === "posted";
	};

	const apiOf = (state: CandidateState) =>
		new GitHubPublicationApi(config.exec, state.pin.repo, config.platform);

	const retainMerge = async (
		state: CandidateState,
		raw: JsonValue | undefined,
		pr: OwnedPullRequest,
	) => {
		const mergedAt = textOf(jsonField(objectOf(raw), "merged_at"));

		if (
			pr.status.kind !== "merged" ||
			mergedAt === null ||
			!validLedgerInstant(mergedAt)
		)
			return;
		await installOnce(
			join(config.stateDir, "accounting", state.pin.runId, "merge.json"),
			`${JSON.stringify({
				v: 1,
				runId: state.pin.runId,
				repo: state.pin.repo,
				number: pr.number,
				headSha: pr.head,
				mergeSha: pr.status.mergeSha,
				mergedAt,
			})}\n`,
		);
	};

	const ownedPr = async (
		state: CandidateState,
	): Promise<OwnedPullRequest | null> => {
		const api = apiOf(state);
		const branch = branchOf(state);

		const number =
			state.kind === "selected" ? state.published?.number : undefined;

		if (number !== undefined) {
			const raw = await api.request("GET", `pulls/${number}`);

			const pr = parseOwnedPullRequest(raw, {
				...state.pin,
				branch,
				controllerLogin: config.platform.controllerLogin,
				knownNumber: number,
			});

			if (pr === null) throw new PublicationError("pr_identity");
			await retainMerge(state, raw, pr);

			return pr;
		}

		const listed = arrayOf(
			await api.request(
				"GET",
				`pulls?state=all&head=${encodeURIComponent(`${state.pin.repo.split("/")[0]}:${branch}`)}&base=main&per_page=100`,
			),
		);

		if (listed === null || listed.length >= 100 || listed.length > 1)
			throw new PublicationError("pr_ambiguous");

		if (listed.length === 0) return null;
		const discovered = countOf(jsonField(objectOf(listed[0]), "number"));

		if (discovered === null) throw new PublicationError("pr_identity");

		const raw = await api.request("GET", `pulls/${discovered}`);

		const pr = parseOwnedPullRequest(raw, {
			...state.pin,
			branch,
			controllerLogin: config.platform.controllerLogin,
		});

		if (pr === null) throw new PublicationError("pr_identity");
		await retainMerge(state, raw, pr);

		return pr;
	};

	const observation = async (
		state: CandidateState,
		now: number,
	): Promise<
		Omit<
			Extract<CandidateEvent, { kind: "observed" }>,
			"executionAllowed" | "capacityAvailable"
		>
	> => {
		if (state.kind === "selected")
			await keepFeedbackRounds(config.stateDir, state);
		const api = apiOf(state);

		let pr: Extract<CandidateEvent, { kind: "observed" }>["pr"] = {
			kind: "none",
		};

		const possible =
			state.kind === "selected" &&
			(state.published !== null ||
				(state.work.kind === "effect" &&
					state.work.request.kind === "open_pr"));

		if (possible) {
			try {
				const found = await ownedPr(state);

				if (found !== null) {
					if (found.status.kind === "merged")
						pr = {
							kind: "merged",
							number: found.number,
							head: found.head,
							mergeSha: found.status.mergeSha,
							actor: found.status.actor,
						};
					else if (found.status.kind === "closed")
						pr = { kind: "closed", number: found.number, head: found.head };
					else {
						const refHead = await api.prRef(branchOf(state));
						pr =
							refHead === null
								? { kind: "unavailable" }
								: {
										kind: "open",
										number: found.number,
										head: found.head,
										refHead,
									};
					}
				} else if (
					present(
						join(config.stateDir, "handoff", state.pin.runId, "create.json"),
					)
				) {
					pr = { kind: "unavailable" };
				}
			} catch {
				pr = { kind: "unavailable" };
			}
		}

		const result: Omit<
			Extract<CandidateEvent, { kind: "observed" }>,
			"executionAllowed" | "capacityAvailable"
		> = {
			kind: "observed",
			now,
			pr,
			main: null,
			eligibility: "unverified",
			feedback: { kind: "none" },
			readiness: { kind: "unavailable" },
		};

		if (pr.kind === "merged" || pr.kind === "closed") return result;

		const adapter = new GitHubTicketAdapter({
			exec: config.exec,
			repo: state.pin.repo,
		});

		const issue = await adapter.readIssue(state.pin.issue);
		let eligibility: "ready" | "withdrawn" | "unverified" = "unverified";

		if (issue.kind === "ok") {
			if (!issue.value.open || !issue.value.labels.includes(READY_LABEL))
				eligibility = "withdrawn";
			else {
				const timeline = await adapter.readTimeline(state.pin.issue);

				if (timeline.kind === "ok") {
					const latest = latestReadyEntry(timeline.value);

					if (latest.kind === "found") {
						const admission = await fileAdmissionStore(config.stateDir).read({
							repo: state.pin.repo,
							issue: state.pin.issue,
							eventId: latest.entry.id,
						});

						eligibility =
							latest.entry.kind === "labeled" &&
							!(
								latest.entry.actor.kind === "login" && latest.entry.actor.bot
							) &&
							admission.kind === "found" &&
							!isBotLogin(admission.receipt.actor) &&
							admission.receipt.baseSha === state.pin.workflowSha
								? "ready"
								: "withdrawn";
					}
				}
			}
		}

		let main: GitSha | null = null;

		try {
			const ref = objectOf(await api.request("GET", "git/ref/heads/main"));
			const head = textOf(jsonField(objectOf(jsonField(ref, "object")), "sha"));

			if (head !== null && isGitSha(head)) main = head;
		} catch {
			main = null;
		}

		let readiness: Extract<CandidateEvent, { kind: "observed" }>["readiness"] =
			{ kind: "unavailable" };

		const candidate =
			state.kind === "selected" ? handoffGeneration(state, pr) : null;

		if (
			state.kind === "selected" &&
			candidate?.certification != null &&
			candidate.validation !== null
		) {
			const certificate = candidate.certification;

			try {
				const report = await controllerReport(
					config,
					state.pin.repo,
					state.pin.runId,
					candidate.validation,
					certificate.verdict,
				);

				const checks = objectOf(
					await api.request(
						"GET",
						`commits/${certificate.verdict.candidateSha}/check-runs?filter=all&per_page=100`,
					),
				);

				const runs = arrayOf(jsonField(checks, "check_runs"));

				const mandatory =
					runs?.filter((r) => jsonField(objectOf(r), "name") === "check") ?? [];

				const check = objectOf(mandatory[0]);

				if (
					report !== null &&
					runs !== null &&
					jsonField(checks, "total_count") === runs.length &&
					(state.published === null ||
						(state.current.intent.publication.kind === "successor" &&
							pr.kind === "open" &&
							pr.head !== report.candidateSha &&
							pr.head === state.current.intent.publication.expectedHead &&
							pr.refHead === state.current.intent.publication.expectedHead) ||
						(mandatory.length === 1 &&
							jsonField(check, "head_sha") === report.candidateSha &&
							jsonField(check, "status") === "completed" &&
							jsonField(check, "conclusion") === "success" &&
							jsonField(objectOf(jsonField(check, "app")), "id") === 15368))
				)
					readiness = { kind: "current", head: report.candidateSha, report };
				else
					readiness = {
						kind: "not_ready",
						reason:
							mandatory.length === 1 &&
							jsonField(check, "head_sha") ===
								certificate.verdict.candidateSha &&
							jsonField(check, "status") === "completed" &&
							jsonField(check, "conclusion") !== "success" &&
							jsonField(objectOf(jsonField(check, "app")), "id") === 15368
								? "checks_failed"
								: "checks_incomplete",
					};
			} catch {
				readiness = { kind: "unavailable" };
			}
		}

		const head = promotedHead(state);

		const feedback =
			state.kind === "selected" &&
			state.published !== null &&
			pr.kind === "open" &&
			head !== null
				? await observeFeedback({
						stateDir: config.stateDir,
						controllerLogin: config.platform.controllerLogin,
						adapter,
						runId: state.pin.runId,
						pr: pr.number,
						head,
						prHead: pr.head,
						refHead: pr.refHead,
						seen: state.feedback?.seen ?? [],
						held: state.feedback?.overflow !== undefined,
					})
				: { kind: "none" as const };

		return { ...result, main, eligibility, readiness, feedback };
	};

	const publicBody = async (
		state: Extract<CandidateState, { kind: "selected" }>,
		ref?: GenerationRef,
	) => {
		const contract = await files.readContract(state.pin.runId);

		const certificate =
			ref === undefined
				? state.current.certification
				: (candidateGenerations(state).find((g) =>
						sameGeneration(g.intent, ref),
					)?.certification ?? null);

		if (contract.kind !== "found" || certificate === null)
			throw new PublicationError("evidence_unavailable");

		const summary = renderSummary({
			runId: state.pin.runId,
			contract: contract.contract,
			digest: contract.digest,
		});

		if (summary === null) throw new PublicationError("summary_too_large");

		const suite = await files.artifacts.read(
			state.pin.runId,
			contract.contract,
			contract.digest,
		);

		// The body states R8 from the stored family evidence, recomputed here,
		// never from the receipt's own `r8` or labels. A version 3 receipt's
		// accept evidence must be the acceptance receipt's own.
		const review = certificate.review;

		if (
			suite.kind !== "found" ||
			suite.receipt.acceptanceDigest !== certificate.verdict.acceptanceDigest ||
			!familyClaimsHold(review) ||
			(review.version === 3 &&
				JSON.stringify(review.accept) !==
					JSON.stringify(suite.receipt.family ?? FAMILY_MISSING))
		)
			throw new PublicationError("evidence_unavailable");

		const limitations = notProven({
			criteria: contract.contract.acceptance,
			scenarios: suite.suite.scenarios,
			r8: reviewR8(review),
			judgments: certificate.review.seats.flatMap((seat) => seat.judgments),
		});

		return [
			`## Factory handoff`,
			withoutKey(summary),
			`Candidate: ${certificate.verdict.candidateSha}\nGate: ${certificate.verdict.gateSha}\nCI: https://github.com/${state.pin.repo}/actions/runs/${certificate.verdict.ciRunId}`,
			`All required hard checks passed. Patch ${certificate.verdict.patchDigest.slice(0, 12)}; acceptance ${certificate.verdict.acceptanceDigest.slice(0, 12)}.`,
			...certificate.review.seats.map(
				(seat) =>
					`- ${inert(seat.seat)}: ${inert(seat.label)}; ${seat.findings.length} findings`,
			),
			...certificate.review.seats.flatMap((seat) =>
				seat.findings
					.slice(0, 5)
					.map((f) => `- ${inert(f.severity)}: ${inert(f.claim)}`),
			),
			"## Not proven",
			limitations.map(renderLimitation).join("\n"),
			"The factory waits for the owner's merge; it cannot merge or arm auto-merge.",
			`<!-- factory:pr ${state.pin.runId} -->`,
		].join("\n\n");
	};

	return {
		async observeMissing(marker) {
			if (marker.pr === null) return { kind: "none" };

			const api = new GitHubPublicationApi(
				config.exec,
				marker.repo,
				config.platform,
			);

			const branch = `factory/pr/${marker.issue}-${marker.runId.slice(0, 12)}`;

			const pr = parseOwnedPullRequest(
				await api.request("GET", `pulls/${marker.pr}`),
				{
					repo: marker.repo,
					runId: marker.runId,
					branch,
					controllerLogin: config.platform.controllerLogin,
					knownNumber: marker.pr,
				},
			);

			if (pr === null) return { kind: "unavailable" };
			const status = pr.status;

			if (status.kind !== "merged") return { kind: "unavailable" };

			const observed = {
				kind: "merged" as const,
				number: pr.number,
				head: pr.head,
				mergeSha: status.mergeSha,
				actor: status.actor,
			};

			const dir = join(config.stateDir, "handoff", marker.runId);
			privateDir(dir);
			await writeOnce(
				join(dir, "missing-evidence-observation.json"),
				`${JSON.stringify(observed)}\n`,
			);

			return observed;
		},
		observe: observation,
		async sweep(repo, now) {
			if (
				(await fileAdmissionStore(config.stateDir).localSwitch()) !== "enabled"
			)
				return;
			const dir = join(config.stateDir, "feedback-sweep");
			privateDir(dir);
			const cursor = join(dir, "ledger.json");

			const last = present(cursor)
				? countOf(jsonField(objectOf(parseJson(regularText(cursor))), "at"))
				: null;

			if (last !== null && now - last < 3_600_000) return;

			if (!(await writeAtomic(cursor, JSON.stringify({ version: 1, at: now }))))
				return;

			const api = ledgerApiOf(
				new GitHubPublicationApi(
					config.exec,
					repo,
					config.platform,
					{},
					async () => true,
					undefined,
					{ now: Date.now, sliceMs: 20_000, callMs: 5_000 },
				),
			);

			const tip = await api.ref();

			if (tip === null) return;
			const commit = await api.commit(tip);
			const file = await api.file(commit.tree);
			const lines = parseLedger(file.bytes);

			if (!lines.every((line) => line.kind === "known")) return;

			const landed = lines.flatMap((line) =>
				line.kind === "known" &&
				line.row.repo === repo &&
				line.row.outcome.kind === "landed" &&
				line.row.pr !== null
					? [{ runId: line.row.runId, pr: line.row.pr.number }]
					: [],
			);

			if (landed.length > 0)
				await sweepMergedFeedback({ ...config, repo, now, landed });
		},
		async patch(state, round) {
			if (
				state.kind === "selected" &&
				state.current.intent.origin.kind === "owner"
			)
				return readOwnerPatch(
					config.stateDir,
					state.pin.runId,
					state.current.intent.origin.head,
					state.current.intent.baseSha,
				);

			const patch = readPatch(config.stateDir, {
				runId: state.pin.runId,
				round,
				baseSha: state.pin.originalBase,
				contractDigest: state.pin.contractDigest,
				acceptanceDigest: state.pin.acceptanceDigest,
			});

			return patch.kind === "found" ? patch : null;
		},
		async execute(state, request) {
			if (state.kind !== "selected") return null;
			await keepFeedbackRounds(config.stateDir, state);
			const api = apiOf(state);

			const writer = new GitHubTicketWriter({
				exec: config.exec,
				repo: state.pin.repo,
			});

			if (request.kind === "finish_pr") {
				const terminal = request.terminal;
				const pr = terminal.kind === "failed" ? null : await ownedPr(state);

				if (terminal.kind === "cancelled" && pr?.status.kind === "merged")
					return null;

				if (terminal.kind === "merged") {
					if (
						pr?.status.kind !== "merged" ||
						pr.status.mergeSha !== terminal.mergeSha
					)
						return null;

					const issue = objectOf(
						await api.request("GET", `issues/${state.pin.issue}`),
					);

					if (jsonField(issue, "state") !== "closed")
						await api.request(
							"PATCH",
							`issues/${state.pin.issue}`,
							{ state: "closed" },
							true,
						);
				} else if (terminal.kind === "cancelled" && pr?.status.kind === "open")
					await api.request(
						"PATCH",
						`pulls/${pr.number}`,
						{ state: "closed" },
						true,
					);

				return { kind: "finish_pr", request };
			}

			if (!(await allowed(state))) return null;

			if (request.kind === "derive_owner_patch") {
				const contract = await files.readContract(state.pin.runId);

				if (
					contract.kind !== "found" ||
					contract.digest !== state.pin.contractDigest
				)
					return {
						kind: "derive_owner_patch",
						request,
						result: { kind: "refused", reason: "unreadable" },
					};

				const suite = await files.artifacts.read(
					state.pin.runId,
					contract.contract,
					contract.digest,
				);

				if (
					suite.kind !== "found" ||
					suite.receipt.acceptanceDigest !== state.pin.acceptanceDigest
				)
					return {
						kind: "derive_owner_patch",
						request,
						result: { kind: "refused", reason: "unreadable" },
					};

				try {
					const heldout = publishedSuite({
						issue: state.pin.issue,
						suite: suite.suite,
						canary: regularText(
							join(
								config.stateDir,
								"acceptance",
								state.pin.runId,
								"canary.txt",
							),
						).trimEnd(),
						acceptanceDigest: state.pin.acceptanceDigest,
					});

					const result = await deriveOwnerPatch(api, {
						stateDir: config.stateDir,
						runId: state.pin.runId,
						head: request.head,
						baseSha: request.baseSha,
						contractDigest: state.pin.contractDigest,
						acceptanceDigest: state.pin.acceptanceDigest,
						heldoutDigest: heldout.digest,
						suite: heldout.files,
						checkout: async (sha, workspace) => {
							const checked = await checkoutWorkspace({
								stateDir: join(workspace, "..", `checkout-${sha}`),
								workspace,
								runId: state.pin.runId,
								repo: state.pin.repo,
								sha,
								fetch: ghTarball,
							});

							return checked.kind === "ready" && checked.omitted === 0;
						},
					});

					return { kind: "derive_owner_patch", request, result };
				} catch {
					return {
						kind: "derive_owner_patch",
						request,
						result: { kind: "refused", reason: "unreadable" },
					};
				}
			}

			if (request.kind === "post_notice") {
				const batch = state.feedback?.batches.findLast((b) =>
					request.notice.kind === "round_summary"
						? b.round !== undefined &&
							b.status.kind === "settled" &&
							b.status.outcome.kind === "stopped" &&
							request.notice.key ===
								`<!-- factory:notice ${state.pin.runId} round_summary ${b.round} -->`
						: request.notice.key ===
							`<!-- factory:notice ${state.pin.runId} ${request.notice.kind} ${b.digest} -->`,
				);

				if (request.number !== state.published?.number) return null;

				const dir = join(
					config.stateDir,
					"handoff",
					state.pin.runId,
					"feedback",
				);

				if (
					request.withdraw !== null &&
					(await writer.removeLabel(request.number, "factory:review")).kind !==
						"posted"
				)
					return null;
				let body: string | null;

				if (request.notice.kind === "round_summary") {
					if (batch === undefined) return null;
					const receipt = feedbackRound(config.stateDir, state, batch);

					if (receipt === null) return null;
					body = await roundSummary(
						config.stateDir,
						state.pin.runId,
						receipt.receipt,
						request.notice.key,
						batch.status.kind === "settled" &&
							batch.status.outcome.kind === "stopped"
							? `held: ${batch.status.outcome.reason}`
							: "held",
						state.current.intent.round === receipt.receipt.round
							? (state.current.verdict?.candidateSha ??
									state.current.validation?.publication?.candidateSha ??
									null)
							: null,
						!receipt.batchAvailable,
					);
				} else if (
					["owner_head", "owner_head_failed", "checks_failed"].includes(
						request.notice.kind,
					)
				) {
					body = [
						"## Factory owner-head review",
						request.notice.kind === "owner_head"
							? "An owner push withdrew readiness. The factory will run trusted gates and review on this exact head, without building or rewriting owner commits."
							: request.detail === "owner_head_behind"
								? "Readiness is withdrawn. Main moved under the owner head. Please update the branch; the factory will not refresh or build on owner commits."
								: `Readiness is withdrawn. Owner-head certification is held: ${request.detail ?? request.notice.kind}${request.refusal === undefined ? "" : ` (${request.refusal})`}. No owner commit was rewritten.${request.refusal === "behind_main" ? " Please update the branch with main before certification can continue." : ""}`,
						`Head: ${request.notice.key.split(" ").at(-2)}`,
						request.notice.key,
					].join("\n\n");
				} else if (request.notice.kind === "feedback_overflow") {
					if (state.feedback?.overflow === undefined) return null;
					body = [
						"## Factory feedback overflow",
						"Feedback intake is held as feedback_overflow. A card metadata or cursor limit was reached. Stored feedback is retained; no repair will start. Owner intervention is needed before intake can continue. Readiness and budgets are unchanged.",
						request.notice.key,
					].join("\n\n");
				} else {
					if (batch === undefined) return null;

					const bytes = regularText(join(dir, `${batch.digest}.json`));

					if (digestOf(bytes) !== batch.digest) return null;
					const stored = objectOf(parseJson(bytes));
					const records = arrayOf(jsonField(stored, "records"));

					if (
						records === null ||
						jsonField(stored, "runId") !== state.pin.runId ||
						jsonField(stored, "head") !== batch.head ||
						jsonField(stored, "pr") !== request.number
					)
						return null;

					const refused = records
						.flatMap((r) => arrayOf(jsonField(objectOf(r), "inline")) ?? [])
						.filter(
							(c) =>
								jsonField(
									objectOf(jsonField(objectOf(c), "intake")),
									"kind",
								) === "refused",
						).length;

					body = [
						request.notice.kind === "repair_started"
							? "## Factory feedback repair started"
							: request.notice.kind === "repair_unavailable"
								? "## Factory feedback repair unavailable"
								: "## Factory feedback intake",
						...(request.notice.kind === "repair_started"
							? [
									"Readiness is withdrawn: factory:review was removed. One repair round will run on this same PR, with fresh validation and review before readiness can return. The shared two-round cap and cumulative budgets are unchanged. Owner commits will never be overwritten.",
								]
							: request.notice.kind === "repair_unavailable"
								? [
										`No repair starts: ${request.detail ?? (batch.status.kind === "settled" && batch.status.outcome.kind === "refused" ? batch.status.outcome.reason : "repair_unavailable")}.  Readiness and budgets are unchanged. Current round ${state.current.intent.round}; the shared cap is two rounds. Budget usage ${candidateUsage(state)} of ${state.pin.maxTokens} tokens; the current assessment and remaining attempt/round allowance must also authorize a repair.`,
									]
								: batch.actionable && batch.status.kind === "queued"
									? [
											"Your change request is queued for the next stage boundary. Dismissing the review or pushing an owner head cancels it. A controller refresh of the unchanged patch carries it forward. Readiness and budgets are unchanged until repair starts.",
										]
									: []),
						...(refused > 0
							? [
									`Refused ${refused} inline comment(s) on held-out acceptance files. Their text is not forwarded.`,
								]
							: []),
						request.notice.key,
					].join("\n\n");
				}

				if (body === null) return null;

				const number =
					request.notice.place === "pr" ? request.number : state.pin.issue;

				if (
					!(await postNotice(
						state,
						number,
						request.notice.key,
						body,
						request.notice.kind === "round_summary",
					))
				)
					return null;

				return { kind: "post_notice", request };
			}

			if (request.kind === "open_pr") {
				let found = await ownedPr(state);

				if (found === null) {
					await api.promotePr(request.branch, null, request.head);
					const dir = join(config.stateDir, "handoff", state.pin.runId);
					privateDir(dir);
					const intent = join(dir, "create.json");

					if (present(intent)) return null;
					const bytes = `${JSON.stringify(request)}\n`;
					exclusive(intent, bytes);

					if (!(await allowed(state))) {
						await retireUnissuedIntent(intent, bytes);

						return null;
					}

					try {
						await api.request(
							"POST",
							"pulls",
							{
								head: request.branch,
								base: "main",
								draft: false,
								title: `factory: issue ${state.pin.issue}`,
								body: await publicBody(state),
							},
							true,
						);
					} catch {
						return null;
					}

					found = await ownedPr(state);
				}

				if (found === null) return null;
				const refHead = await api.prRef(request.branch);

				if (refHead === null) return null;

				return {
					kind: "open_pr",
					request,
					number: found.number,
					head: found.head,
					refHead,
				};
			}

			if (request.kind === "promote_pr") {
				try {
					await api.promotePr(
						branchOf(state),
						request.expectedHead,
						request.head,
					);
				} catch (error) {
					if (
						!(error instanceof PublicationError) ||
						error.reason !== "branch_moved"
					)
						throw error;

					try {
						const pr = await ownedPr(state);
						const refHead = await api.prRef(branchOf(state));

						return pr === null || refHead === null
							? null
							: { kind: "promote_pr", request, head: pr.head, refHead };
					} catch {
						return null;
					}
				}

				const pr = await ownedPr(state);
				const refHead = await api.prRef(branchOf(state));

				return pr === null || refHead === null
					? null
					: { kind: "promote_pr", request, head: pr.head, refHead };
			}

			if (request.kind === "void_readiness") {
				const result = await writer.removeLabel(
					request.number,
					"factory:review",
				);

				return result.kind === "posted"
					? { kind: "void_readiness", request }
					: null;
			}

			const applying = completingFeedbackBatch(state, request.certification);

			const receipt =
				applying === null
					? null
					: feedbackRound(config.stateDir, state, applying, request.head);

			if (applying !== null && receipt === null) return null;

			const pr = await ownedPr(state);

			if (
				pr?.status.kind !== "open" ||
				pr.head !== request.head ||
				(await api.prRef(branchOf(state))) !== request.head
			)
				return null;
			const handoff = await handoffOf(state);

			if (handoff === undefined) return null;

			if (handoff === null) {
				// A workflow pinned before `handoff.reviewers` existed: request
				// nobody rather than guess, and never the repository owner.
				log("handoff_reviewer_unconfigured", {
					issue: state.pin.issue,
					runId: state.pin.runId,
					pr: pr.number,
					workflowSha: state.pin.workflowSha,
				});
			} else {
				const raw = objectOf(await api.request("GET", `pulls/${pr.number}`));

				const requested = new Set(
					(arrayOf(jsonField(raw, "requested_reviewers")) ?? []).flatMap(
						(r) => {
							const login = textOf(jsonField(objectOf(r), "login"));

							return login === null ? [] : [login.toLowerCase()];
						},
					),
				);

				const missing = handoff.reviewers.filter(
					(login) => !requested.has(login.toLowerCase()),
				);

				if (missing.length > 0) {
					if (!(await allowed(state))) return null;
					await api.request(
						"POST",
						`pulls/${pr.number}/requested_reviewers`,
						{ reviewers: missing },
						true,
					);
				}
			}

			if (!(await allowed(state))) return null;
			const labeled = await writer.addLabels(pr.number, ["factory:review"]);

			if (labeled.kind !== "posted") return null;
			const key = `<!-- factory:handoff ${state.pin.runId} ${request.head} -->`;

			const adapter = new GitHubTicketAdapter({
				exec: config.exec,
				repo: state.pin.repo,
			});

			const comments = await adapter.readComments(state.pin.issue);

			if (comments.kind !== "ok") return null;

			const matching = comments.value.filter(
				(c) =>
					c.author?.login === config.platform.controllerLogin &&
					c.author.type === "Bot" &&
					c.body.split("\n").includes(key),
			);

			if (matching.length > 1) return null;

			if (matching.length === 0) {
				const dir = join(config.stateDir, "handoff", state.pin.runId);
				privateDir(dir);
				const intent = join(dir, `comment-${request.head}.json`);

				if (present(intent)) return null;
				const bytes = JSON.stringify({ key });
				exclusive(intent, bytes);

				if (!(await allowed(state))) {
					await retireUnissuedIntent(intent, bytes);

					return null;
				}

				const comment = await writer.postComment(
					state.pin.issue,
					`${await publicBody(state, request.certification)}\n\nPR: https://github.com/${state.pin.repo}/pull/${pr.number}\n${key}`,
				);

				if (comment.kind !== "posted") return null;
			}

			if (receipt !== null) {
				const summaryKey = `<!-- factory:notice ${state.pin.runId} round_summary ${receipt.receipt.round} -->`;

				const summary = await roundSummary(
					config.stateDir,
					state.pin.runId,
					receipt.receipt,
					summaryKey,
					"ready after fresh validation and review",
					request.head,
					!receipt.batchAvailable,
				);

				if (summary === null) return null;

				if (
					!(await postNotice(state, request.number, summaryKey, summary, true))
				)
					return null;
			}

			return { kind: "complete_handoff", request, now: Date.now() };
		},
	};
}

function roundDisposition(
	outcome: RoundReceipt["outcome"],
	item: Omit<BuilderDisposition, "event"> | undefined,
): FeedbackDisposition {
	if (outcome.kind === "merged")
		return { kind: "merged", mergeSha: outcome.mergeSha };

	if (outcome.kind === "superseded")
		return { kind: "rejected", reason: "superseded" };

	if (outcome.kind === "stopped" || outcome.kind === "build_failed")
		return { kind: "rejected", reason: "repair_stopped" };

	return item?.kind === "adopted"
		? { kind: "adopted", head: outcome.head, source: "builder_reported" }
		: { kind: "rejected", reason: item?.reason ?? "builder_declined" };
}

function feedbackRound(
	stateDir: string,
	state: Extract<CandidateState, { kind: "selected" }>,
	ref: FeedbackBatchRef,
	appliedHead?: import("../../src/config/schema.ts").GitSha,
	failedAttempt?: number,
): Readonly<{ receipt: RoundReceipt; batchAvailable: boolean }> | null {
	const read = readFeedbackBatch(stateDir, state.pin.runId, ref.digest);

	const stored =
		read !== null &&
		read.batch.pr === state.published?.number &&
		read.batch.head === ref.head
			? read
			: null;

	const round =
		ref.round ??
		(ref.status.kind === "applying" ? ref.status.round : undefined);

	if (round === undefined) return null;

	const outcome =
		failedAttempt !== undefined
			? { kind: "build_failed" as const }
			: appliedHead === undefined
				? ref.status.kind === "settled"
					? ref.status.outcome
					: null
				: { kind: "applied" as const, head: appliedHead };

	if (
		outcome === null ||
		outcome.kind === "no_action" ||
		outcome.kind === "refused"
	)
		return null;

	if (stored === null && outcome.kind === "applied") return null;

	const patch = readPatch(stateDir, {
		runId: state.pin.runId,
		baseSha: state.pin.originalBase,
		contractDigest: state.pin.contractDigest,
		acceptanceDigest: state.pin.acceptanceDigest,
		round,
	});

	const attempt = failedAttempt ?? ref.attempt ?? 1;

	const noChange = readRepairBuildResult(
		stateDir,
		state.pin.runId,
		round,
		attempt,
	);

	const decisions = noChange ?? (patch.kind === "found" ? patch.receipt : null);
	const reported = decisions?.dispositions ?? [];
	const findingReported = decisions?.findingDispositions ?? [];

	const decision = (item: Omit<BuilderDisposition, "event"> | undefined) =>
		roundDisposition(outcome, item);

	const disposition = (event: FeedbackId) =>
		decision(reported.find((d) => d.event === event));

	const builderDecision = (event: FeedbackId, forwarded = true) => {
		const item = forwarded
			? reported.find((d) => d.event === event)
			: undefined;

		if (item === undefined) return {};
		const { event: _event, ...builder } = item;

		return { builder };
	};

	const records =
		stored?.batch.records ??
		ref.reviews.map((event) => ({
			event,
			actor: "",
			intake: { kind: "actionable" } as const,
			inline: [],
		}));

	const items = records.flatMap((r) => [
		...(r.intake.kind === "actionable"
			? [
					{
						event: r.event,
						disposition: disposition(r.event),
						...builderDecision(r.event),
					},
				]
			: []),
		...r.inline.map((c) => ({
			event: c.id,
			...builderDecision(c.id, c.intake.kind !== "refused"),
			disposition:
				c.intake.kind === "refused"
					? ({ kind: "rejected", reason: "heldout_path" } as const)
					: disposition(c.id),
		})),
	]);

	const build = state.accounts.findLast(
		(a) =>
			a.execution.stage === "build" &&
			a.execution.cause.kind === "feedback" &&
			a.execution.cause.batch === ref.digest &&
			(failedAttempt === undefined || a.execution.attempt === failedAttempt),
	)?.execution;

	const prior =
		build?.stage === "build"
			? candidateGenerations(state).find(
					(g) => g.intent.digest === build.feedbackFrom.digest,
				)
			: state.current;

	const reviews = [
		prior?.review ?? prior?.certification?.review,
		...candidateGenerations(state)
			.filter((g) => g.intent.round === round)
			.map((g) => g.review ?? g.certification?.review),
	];

	const findings = [
		...new Map(
			reviews.flatMap(
				(r) =>
					r?.seats.flatMap((seat) =>
						findingFingerprints({ seats: [seat] }).map(
							(fingerprint) =>
								[
									fingerprint,
									{
										fingerprint,
										seat: seat.seat,
										disposition: decision(
											findingReported.find(
												(f) => f.fingerprint === fingerprint,
											),
										),
									},
								] as const,
						),
					) ?? [],
			),
		).values(),
	];

	return {
		receipt: {
			round,
			attempt: failedAttempt ?? build?.attempt ?? ref.attempt ?? 1,
			outcome,
			batch: ref.digest,
			items,
			findings,
		},
		batchAvailable: stored !== null,
	};
}

async function roundSummary(
	stateDir: string,
	runId: Digest,
	receipt: RoundReceipt,
	key: string,
	result: string,
	head: string | null,
	batchUnavailable = false,
): Promise<string | null> {
	try {
		if (!(await keepRoundReceipt(stateDir, runId, receipt))) return null;
		const dir = join(stateDir, "handoff", runId, "feedback");
		const attempts: RoundReceipt[] = [];

		for (let attempt = 1; attempt <= receipt.attempt; attempt++) {
			const path = join(dir, `round-${receipt.round}-a${attempt}.json`);

			if (!present(path)) continue;
			// SAFETY: controller-written immutable attempt artifact, never candidate input.
			attempts.push(JSON.parse(regularText(path)) as RoundReceipt);
		}

		const describe = (d: FeedbackDisposition) =>
			d.kind === "adopted"
				? `adopted (builder-reported), head ${d.head}`
				: d.kind === "merged"
					? `merged at ${d.mergeSha}`
					: `rejected: ${d.reason}`;

		return [
			`## Factory feedback round ${receipt.round}`,
			`Result: ${result}. Head: ${head ?? "no new candidate head"}.`,
			...(batchUnavailable
				? [
						"Original batch text is unavailable. Only review IDs retained in the book can be listed; inline details are not reconstructed.",
					]
				: []),
			"Adoption is builder-reported, not controller proof. Readiness requires fresh validation and review. No owner commits were rewritten.",
			...attempts.flatMap((attempt) => [
				`### Attempt ${attempt.attempt}\n\n${attempt.attempt === receipt.attempt ? result : attempt.outcome.kind === "stopped" ? `held: ${attempt.outcome.reason}` : attempt.outcome.kind}`,
				...attempt.items.map(
					(i) =>
						`- \`${i.event}\`: ${describe(i.disposition)}${i.builder === undefined ? "" : ` — Builder ${i.builder.kind === "rejected" && i.builder.reason === "builder_declined" ? "declined" : i.builder.kind}: ${inert(i.builder.detail ?? i.builder.reason ?? "builder-reported")}`}`,
				),
				...attempt.findings.map(
					(f) =>
						`- Finding \`${f.fingerprint}\` (${f.seat}): ${describe(f.disposition)}`,
				),
			]),
			key,
		].join("\n\n");
	} catch {
		return null;
	}
}

/** Attempt evidence is immutable; the per-round index always names its latest attempt. */
async function keepRoundReceipt(
	stateDir: string,
	runId: Digest,
	receipt: RoundReceipt,
): Promise<boolean> {
	try {
		const dir = join(stateDir, "handoff", runId, "feedback");
		const name = `round-${receipt.round}-a${receipt.attempt}.json`;
		const path = join(dir, name);

		if (!present(path)) exclusive(path, `${JSON.stringify(receipt)}\n`);
		// SAFETY: controller-authored write-once artifact, not model output.
		const stored = JSON.parse(regularText(path)) as RoundReceipt;
		const index = join(dir, `round-${receipt.round}.json`);

		const previous = present(index)
			? countOf(
					fieldOf(objectOf(parseJson(regularText(index))), "latestAttempt"),
				)
			: null;

		if (previous !== null && previous > stored.attempt) return true;
		const bytes = `${JSON.stringify({ round: stored.round, latestAttempt: stored.attempt, outcome: stored.outcome, receipt: name })}\n`;

		if (present(index) && regularText(index) === bytes) return true;

		return await writeAtomic(index, bytes);
	} catch {
		return false;
	}
}

/** Recreate missing receipts and indices from the book, without a model replay. */
async function keepFeedbackRounds(
	stateDir: string,
	state: Extract<CandidateState, { kind: "selected" }>,
): Promise<void> {
	for (const ref of state.feedback?.batches ?? []) {
		for (const attempt of ref.failedAttempts ?? []) {
			const failed = feedbackRound(stateDir, state, ref, undefined, attempt);

			if (failed !== null)
				await keepRoundReceipt(stateDir, state.pin.runId, failed.receipt);
		}

		if (ref.status.kind !== "settled" || ref.round === undefined) continue;
		const receipt = feedbackRound(stateDir, state, ref);

		if (receipt !== null)
			await keepRoundReceipt(stateDir, state.pin.runId, receipt.receipt);
	}
}

export async function storeFeedbackBatch(
	stateDir: string,
	batch: FeedbackBatch,
	full: string | null,
): Promise<
	NonNullable<Extract<FeedbackObservation, { kind: "read" }>["batch"]>
> {
	const dir = join(resolve(stateDir), "handoff", batch.runId, "feedback");
	privateDir(dir);

	const put = async (path: string, bytes: string) => {
		if (present(path)) {
			const stat = lstatSync(path);

			if (!stat.isFile() || (stat.mode & 0o077) !== 0)
				throw new Error("unsafe private file");

			if (
				stat.size === Buffer.byteLength(bytes) &&
				digestOf(regularText(path, stat.size)) === digestOf(bytes)
			)
				return;
		}

		if (!(await writeAtomic(path, bytes))) throw new Error("feedback_write");
	};

	if (batch.full !== null) {
		if (
			full === null ||
			digestOf(full) !== batch.full.digest ||
			Buffer.byteLength(full) !== batch.full.bytes
		)
			throw new Error("feedback_full_binding");
		await put(join(dir, `${batch.full.digest}.full.json`), full);
	}

	const bytes = canonicalJson(batch);
	const digest = digestOf(bytes);
	await put(join(dir, `${digest}.json`), bytes);

	const stored: NonNullable<
		Extract<FeedbackObservation, { kind: "read" }>["batch"]
	> = {
		digest,
		seen: batch.records.map((r) => r.event).sort(),
		reviews: batch.records
			.filter((r) => r.intake.kind === "actionable")
			.map((r) => r.event)
			.sort(),
		actionable: batch.records.some((r) => r.intake.kind === "actionable"),
		refusedInline: batch.records.some((r) =>
			r.inline.some((c) => c.intake.kind === "refused"),
		),
	};

	return batch.overflow === true ? { ...stored, overflow: true } : stored;
}

async function feedbackEvents(
	adapter: GitHubTicketAdapter,
	pr: number,
	seen: readonly FeedbackId[],
	controllerLogin: string,
): Promise<
	| Readonly<{ kind: "read"; events: readonly FeedbackEvent[] }>
	| Extract<FeedbackObservation, { kind: "unavailable" }>
> {
	const comments = await adapter.readComments(pr);
	const reviews = await adapter.readPullReviews(pr);

	if (comments.kind === "failed")
		return {
			kind: "unavailable",
			reason: "comments",
			failure: comments.failure.kind,
		};

	if (reviews.kind === "failed")
		return {
			kind: "unavailable",
			reason: "reviews",
			failure: reviews.failure.kind,
		};
	const events: FeedbackEvent[] = [];

	for (const c of comments.value) {
		if (c.author === null) continue;
		events.push({
			kind: "conversation",
			id: feedbackId(adapter.repo, "issue-comment", Number(c.id)),
			pr,
			actor: c.author.login,
			at: c.createdAt,
			body: c.body,
		});
	}

	for (const r of reviews.value) {
		if (
			seen.includes(r.id) ||
			r.actor.toLowerCase() === controllerLogin.toLowerCase()
		) {
			events.push(r);
			continue;
		}

		const inline = await adapter.readReviewComments(
			pr,
			Number(r.id.split(":").at(-1)),
		);

		if (inline.kind === "failed")
			return {
				kind: "unavailable",
				reason: "review_comments",
				failure: inline.failure.kind,
			};
		events.push({ ...r, comments: inline.value });
	}

	return { kind: "read", events };
}

export async function observeFeedback(input: {
	stateDir: string;
	controllerLogin: string;
	adapter: GitHubTicketAdapter;
	runId: Digest;
	pr: number;
	head: GitSha;
	prHead: string;
	refHead: string;
	seen: readonly FeedbackId[];
	held?: boolean;
}): Promise<FeedbackObservation> {
	if (input.prHead !== input.head || input.refHead !== input.head)
		return { kind: "deferred", reason: "head_mismatch" };

	let reason: "unexpected" | "storage" = "unexpected";

	try {
		if (input.held === true) {
			const reviews = await input.adapter.readPullReviews(input.pr);

			return reviews.kind !== "ok"
				? {
						kind: "unavailable",
						reason: "reviews",
						failure: reviews.failure.kind,
					}
				: {
						kind: "read",
						head: input.head,
						batch: null,
						dismissed: reviews.value
							.filter(
								(r) => r.state === "DISMISSED" && input.seen.includes(r.id),
							)
							.map((r) => r.id),
					};
		}

		const read = await feedbackEvents(
			input.adapter,
			input.pr,
			input.seen,
			input.controllerLogin,
		);

		if (read.kind === "unavailable") return read;
		let permissionFailure: GitHubFailure["kind"] | null = null;

		const classified = await classifyFeedback({
			...input,
			events: read.events,
			permission: async (actor) => {
				if (!isLogin(actor) || isBotLogin(actor)) return "read";
				const permission = await input.adapter.readPermission(actor);

				if (permission.kind === "failed")
					permissionFailure = permission.failure.kind;

				return permission.kind === "failed"
					? "failed"
					: hasWriteAccess(permission.value)
						? "write"
						: "read";
			},
		});

		if (classified.kind === "unavailable")
			return {
				kind: "unavailable",
				reason: "permission",
				failure: permissionFailure,
			};

		reason = "storage";

		const batch =
			classified.batch === null
				? null
				: await storeFeedbackBatch(
						input.stateDir,
						classified.batch,
						classified.full,
					);

		return {
			kind: "read",
			head: input.head,
			batch,
			dismissed: classified.dismissed,
		};
	} catch {
		return { kind: "unavailable", reason, failure: null };
	}
}

type MergedFeedbackSweep = Readonly<{
	stateDir: string;
	exec: Exec;
	platform: PlatformProfile;
	repo: RepoSlug;
	now: number;
	landed: readonly Readonly<{ runId: Digest; pr: number }>[];
}>;

type SubmittedFeedback = Extract<FeedbackEvent, { kind: "review" }>;

function proposalBody(
	repo: RepoSlug,
	review: SubmittedFeedback,
	key: string,
): string {
	return [
		`Feedback on merged factory PR https://github.com/${repo}/pull/${review.pr}`,
		`Review: ${inert(review.id)}`,
		inert(review.body),
		...review.comments.map((c) =>
			c.path.startsWith(ACCEPTANCE_SUITE_PREFIX)
				? `Refused inline comment ${inert(c.id)} on a held-out acceptance file; text is not quoted.`
				: `${inert(c.path)}${c.line === null ? "" : `:${c.line}`}\n${inert(c.body)}`,
		),
		"This proposal needs owner review and is not ready for automatic admission.",
		key,
	].join("\n\n");
}

async function proposeMergedReview(
	input: MergedFeedbackSweep,
	adapter: GitHubTicketAdapter,
	review: SubmittedFeedback,
): Promise<boolean> {
	const key = `<!-- factory:proposal ${input.repo} ${review.id} -->`;

	const path = join(
		input.stateDir,
		"feedback-sweep",
		"proposals",
		`${review.pr}-${review.id.split(":").at(-1)}.json`,
	);

	let body = proposalBody(input.repo, review, key);

	if (present(path)) {
		const intent = objectOf(parseJson(regularText(path)));
		const savedBody = textOf(jsonField(intent, "body"));

		if (
			jsonField(intent, "key") !== key ||
			savedBody === null ||
			!savedBody.endsWith(`\n\n${key}`)
		)
			return false;
		body = savedBody;
	} else exclusive(path, JSON.stringify({ key, body }));
	const proposals = await adapter.readProposedIssues();

	if (proposals.kind !== "ok") return false;

	const matching = proposals.value.filter((p) =>
		p.body.split("\n").includes(key),
	);

	if (matching.length > 0) return matching.length === 1;

	if ((await fileAdmissionStore(input.stateDir).localSwitch()) !== "enabled")
		return false;
	const enabled = await adapter.readRepoSwitch();

	if (enabled.kind !== "ok" || enabled.value.kind !== "present") return false;
	const writer = new GitHubTicketWriter({ exec: input.exec, repo: input.repo });

	const created = await writer.createIssue(
		`Factory follow-up for PR ${review.pr}`,
		body,
		["factory:proposed"],
	);

	return created.kind === "posted";
}

async function sweepMergedPr(
	input: MergedFeedbackSweep,
	adapter: GitHubTicketAdapter,
	number: number,
): Promise<void> {
	const dir = join(input.stateDir, "feedback-sweep");
	privateDir(dir);
	const path = join(dir, `${number}.json`);
	const cursor = present(path) ? objectOf(parseJson(regularText(path))) : null;
	const last = countOf(jsonField(cursor, "at"));

	if (last !== null && input.now - last < 3_600_000) return;
	const seen = new Set(textsOf(jsonField(cursor, "seen")) ?? []);

	const save = () =>
		writeAtomic(
			path,
			JSON.stringify({ version: 1, at: input.now, seen: [...seen].sort() }),
		);

	if (!(await save())) return;
	const api = new GitHubPublicationApi(input.exec, input.repo, input.platform);
	const pr = objectOf(await api.request("GET", `pulls/${number}`));
	const mergedAt = textOf(jsonField(pr, "merged_at"));

	if (mergedAt === null || !validLedgerInstant(mergedAt)) return;
	const reviews = await adapter.readPullReviews(number);

	if (reviews.kind !== "ok") return;

	for (const review of reviews.value) {
		if (
			seen.has(review.id) ||
			review.actor.toLowerCase() ===
				input.platform.controllerLogin.toLowerCase() ||
			Date.parse(review.at) <= Date.parse(mergedAt) ||
			!isLogin(review.actor)
		)
			continue;
		const permission = await adapter.readPermission(review.actor);

		if (permission.kind !== "ok") return;

		if (!hasWriteAccess(permission.value)) continue;

		const comments = await adapter.readReviewComments(
			number,
			Number(review.id.split(":").at(-1)),
		);

		if (comments.kind !== "ok") return;

		if (!review.body.trim() && comments.value.length === 0) continue;

		if (
			!(await proposeMergedReview(input, adapter, {
				...review,
				comments: comments.value,
			}))
		)
			return;
		seen.add(review.id);

		if (!(await save())) return;
	}
}

export async function sweepMergedFeedback(
	input: MergedFeedbackSweep,
): Promise<void> {
	if ((await fileAdmissionStore(input.stateDir).localSwitch()) !== "enabled")
		return;

	const adapter = new GitHubTicketAdapter({
		exec: input.exec,
		repo: input.repo,
	});

	const enabled = await adapter.readRepoSwitch();

	if (enabled.kind !== "ok" || enabled.value.kind !== "present") return;

	for (const number of new Set(input.landed.map((row) => row.pr))) {
		try {
			await sweepMergedPr(input, adapter, number);
		} catch {
			continue;
		}
	}
}
