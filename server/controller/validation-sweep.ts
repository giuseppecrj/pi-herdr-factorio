import {
	fileArtifacts,
	readStoredContract,
	regularText,
	exclusive,
	privateDir,
	present,
} from "../../src/contract/artifacts.ts";
import { readPatch, publicationTree } from "../../src/candidate/build.ts";
import { type PlatformProfile } from "../../src/trust/platform.ts";
import { ownerPatchValid } from "../../src/candidate/state.ts";
import { candidateGenerations } from "../../src/candidate/handoff.ts";
import {
	type CommitIdentity,
	GitHubPublicationApi,
	PublicationError,
	publishCandidate,
	pinOwnerCandidate,
	readOwnerPatch,
	candidateBranch,
} from "../../src/github/publish.ts";
import {
	type Validator,
	type ValidationState,
	CI_DEADLINE_MS,
	DISPATCH_SETTLE_MS,
	publishedSuite,
	dispatchNonce,
	parseCiRun,
	matchesCiRun,
	collectVerdict,
	collectTrustedReport,
	repairFeedback,
	checkFeedback,
	parseCheckFeedback,
	FEEDBACK_CHECKS,
	parseValidationState,
	validationDir,
	assessmentBinding,
	feedbackBytes,
	type ReadAssessment,
} from "../../src/candidate/validation.ts";
import {
	arrayOf,
	objectOf,
	fieldOf as jsonField,
	textOf,
	textsOf,
	countOf,
} from "../../src/core/json.ts";
import { type Exec } from "../../src/github/exec.ts";
import { digestOf, type Verdict, type Digest } from "../../src/core/run.ts";
import { isGitSha, type GitSha } from "../../src/config/schema.ts";
import type { RepoSlug } from "../../src/trust/platform.ts";
import { execFile } from "node:child_process";
import { baseTreeDigest, replacementDigest } from "../gates.ts";
import type { AcceptanceBinding } from "../../src/contract/acceptance.ts";
import {
	classifyFailure,
	diagnosisNeeds,
	type FailureClass,
} from "../../src/candidate/diagnosis.ts";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import {
	parseJson,
	writeAtomic,
	readStoredAssessment,
	storeAssessment,
	keepValidationFile,
	readStoredVerdict,
} from "./state.ts";
import { type TarballFetch, ghTarball, checkoutWorkspace } from "./checkout.ts";
import {
	type DiagnosisFacts,
	storedBaseReceipt,
	controllerDiagnosis,
} from "./checkers.ts";
import { fileRunFiles } from "./run-files.ts";

async function cleanupPublication(
	api: GitHubPublicationApi,
	dir: string,
	publication: { readonly branch: string; readonly candidateSha: GitSha },
): Promise<"done" | "pending" | "branch_moved"> {
	privateDir(dir);

	try {
		await api.remove(publication.branch, publication.candidateSha);
		keepValidationFile(
			join(dir, "cleanup.json"),
			`${JSON.stringify({ branch: publication.branch, candidateSha: publication.candidateSha })}\n`,
		);
		await rm(join(dir, "pending-deletion.json"), { force: true });

		return "done";
	} catch (error) {
		const reason =
			error instanceof Error ? error.message : "cleanup_unavailable";

		await writeAtomic(
			join(dir, "pending-deletion.json"),
			`${JSON.stringify({ ...publication, reason })}\n`,
		);

		return reason === "branch_moved" ? "branch_moved" : "pending";
	}
}

type ValidatorConfig = {
	readonly stateDir: string;
	readonly exec: Exec;
	readonly platform: PlatformProfile;
	readonly sleep?: (ms: number) => Promise<void>;
	readonly fetch?: TarballFetch;
	readonly receipt?: GateReceiptSource;
	readonly diagnosis?: ReturnType<typeof controllerDiagnosis>;
};

export function controllerValidator(config: ValidatorConfig): Validator {
	return candidateValidator(config, false);
}

export function ownerValidator(config: ValidatorConfig): Validator {
	return candidateValidator(config, true);
}

// Both paths use the same dispatch, identity, diagnosis, report and cleanup code.
function candidateValidator(
	config: ValidatorConfig,
	owner: boolean,
): Validator {
	return async (input) => {
		const initial: ValidationState = {
			version: input.generation === undefined ? 1 : 2,
			startedAt: input.now,
			deadline: input.now + Math.min(input.wallMs, CI_DEADLINE_MS),
			round: input.round ?? 0,
			originalBase: input.baseSha,
			baseSha: input.generation?.baseSha ?? input.baseSha,
			baseResolved: input.generation !== undefined,
			publication: null,
			dispatchTry: 0,
			dispatchedAt: null,
			ciRunId: null,
			counters: {},
		};

		const generation = input.generation;

		const prepared =
			generation === undefined
				? initial
				: {
						...initial,
						generation: {
							index: generation.generation,
							digest: generation.digest,
							previousHead:
								generation.publication.kind === "successor"
									? generation.publication.expectedHead
									: null,
						},
					};

		const state: ValidationState = input.state ?? prepared;

		const save = () => input.save(state);
		let repository: RepoSlug | null = null;

		let identities: {
			patchDigest: Digest;
			acceptanceDigest: Digest;
			heldoutDigest: Digest;
		} | null = null;

		const failed = async (reason: string) => {
			const publication = state.publication;

			if (publication !== null && repository !== null) {
				const dir = validationDir(
					config.stateDir,
					input.runId,
					state.round,
					state.generation?.index,
				);

				privateDir(dir);
				const path = join(dir, "failure.json");

				if (
					!present(path) &&
					(reason === "ci_timeout" || !present(join(dir, "verdict.json")))
				)
					exclusive(
						path,
						`${JSON.stringify({ ...identities, candidateSha: publication.candidateSha, gateSha: null, ciRunId: state.ciRunId, originalBase: state.originalBase, baseSha: state.baseSha, pass: false, checks: [], reason })}\n`,
					);

				if (reason !== "branch_moved") {
					const cleanup = await cleanupPublication(
						new GitHubPublicationApi(
							config.exec,
							repository,
							config.platform,
							{},
							undefined,
							config.sleep,
						),
						dir,
						publication,
					);

					if (cleanup === "branch_moved") reason = "branch_moved";
				}
			}

			return { kind: "failed", state, reason } as const;
		};

		try {
			if (
				state.originalBase !== input.baseSha ||
				state.round !== (input.round ?? 0) ||
				(input.generation !== undefined &&
					(state.generation?.digest !== input.generation.digest ||
						state.baseSha !== input.generation.baseSha ||
						state.generation.index !== input.generation.generation))
			)
				return failed("validation_binding");

			if (!(await save())) return failed("claim_unwritable");
			const contract = await readStoredContract(config.stateDir, input.runId);

			if (
				contract.kind !== "found" ||
				contract.contract.base.sha !== input.baseSha ||
				contract.contract.issue !== input.issue
			)
				return failed("contract_binding");
			const repo = contract.contract.base.repo;
			repository = repo;

			const suite = await fileArtifacts(config.stateDir).read(
				input.runId,
				contract.contract,
				contract.digest,
			);

			if (suite.kind !== "found")
				return failed(
					suite.kind === "blocked" ? suite.reason : "acceptance_missing",
				);

			const patch =
				owner && generation?.origin.kind === "owner"
					? readOwnerPatch(
							config.stateDir,
							input.runId,
							generation.origin.head,
							generation.baseSha,
						)
					: owner
						? null
						: readPatch(config.stateDir, {
								round: state.round,
								runId: input.runId,
								baseSha: input.baseSha,
								contractDigest: contract.digest,
								acceptanceDigest: suite.receipt.acceptanceDigest,
							});

			if (patch === null || patch.kind !== "found")
				return failed(
					patch?.kind === "blocked" ? patch.reason : "patch_missing",
				);

			if (owner) {
				if (
					!("kind" in patch.receipt) ||
					generation === undefined ||
					!ownerPatchValid(
						{
							runId: input.runId,
							contractDigest: contract.digest,
							acceptanceDigest: suite.receipt.acceptanceDigest,
						},
						generation,
						patch.receipt,
					)
				)
					return failed("owner_patch_binding");
			} else if (
				"kind" in patch.receipt ||
				patch.receipt.policy !== "clean" ||
				patch.receipt.visibleTests?.exitCode !== 0
			)
				return failed("patch_failed");

			const canary = regularText(
				join(config.stateDir, "acceptance", input.runId, "canary.txt"),
			).trimEnd();

			const heldout = publishedSuite({
				issue: input.issue,
				suite: suite.suite,
				canary,
				acceptanceDigest: suite.receipt.acceptanceDigest,
			});

			if (
				owner &&
				"heldoutDigest" in patch.receipt &&
				patch.receipt.heldoutDigest !== heldout.digest
			)
				return failed("owner_patch_binding");
			identities = {
				patchDigest: patch.receipt.patchDigest,
				acceptanceDigest: suite.receipt.acceptanceDigest,
				heldoutDigest: heldout.digest,
			};

			const api = new GitHubPublicationApi(
				config.exec,
				repo,
				config.platform,
				state.counters,
				save,
				config.sleep,
			);

			const dir = validationDir(
				config.stateDir,
				input.runId,
				state.round,
				state.generation?.index,
			);

			privateDir(dir);
			const verdictPath = join(dir, "verdict.json");
			const failurePath = join(dir, "failure.json");
			const receiptPath = join(dir, "receipt.json");
			const checksPath = join(dir, "checks.json");

			const receiptOf = () =>
				objectOf(
					parseJson(
						present(receiptPath) ? regularText(receiptPath, 1024 * 1024) : "",
					),
				);

			const bindingOf = (verdict: Verdict) => ({
				runId: input.runId,
				round: state.round,
				generation: state.generation?.index ?? 0,
				verdict,
			});

			const classifyWith = (
				raw: ReturnType<typeof receiptOf>,
				facts: DiagnosisFacts | null,
			): FailureClass => {
				const nonces = Array.from({ length: state.dispatchTry }, (_, index) =>
					dispatchNonce(
						input.runId,
						state.round,
						index + 1,
						state.generation?.index,
					),
				);

				return classifyFailure({
					receipt: raw ?? undefined,
					identity: {
						gateSha: state.baseSha,
						candidateSha: state.publication?.candidateSha ?? state.baseSha,
						nonce:
							nonces.find((n) => n === jsonField(raw, "nonce")) ?? "missing",
						heldoutDigest: heldout.digest,
						replacementsDigest: replacementDigest(
							contract.contract.replacesTests ?? [],
						),
					},
					expected: heldout.files.map((f) => f.path).toSorted(),
					scenarios: suite.suite.scenarios.flatMap((s) =>
						s.checks.length === 1
							? [
									{
										scenario: s.id,
										kind: s.kind,
										file: `${heldout.directory}/checks/${s.checks[0]}`,
									},
								]
							: [],
					),
					base: facts?.base ?? null,
					ignoredChanges: facts?.ignoredChanges ?? null,
					replay: facts?.replay ?? null,
					dependencies: facts?.dependencies ?? null,
					candidatePaths: patch.receipt.changedPaths,
					baseRefusal: facts?.baseRefusal ?? null,
				});
			};

			const diagnosed = async (verdict: Verdict): Promise<boolean> => {
				if (verdict.pass || readStoredAssessment(dir) !== null) return true;
				const raw = receiptOf();
				const needs = diagnosisNeeds(raw ?? undefined);
				const binding = bindingOf(verdict);

				const fail = (failure: FailureClass) => {
					storeAssessment(dir, binding, { kind: "failed", failure });
				};

				if (!needs.replay && !needs.dependencies) {
					fail(classifyWith(raw, null));

					return true;
				}

				const bindingDigest = digestOf(
					JSON.stringify(assessmentBinding(binding)),
				);

				const allowanceMs = state.deadline - input.now;

				if (
					allowanceMs <= 0 &&
					!present(join(dir, "diagnosis", bindingDigest, "intent.json"))
				) {
					fail({ kind: "infrastructure", reason: "timeout" });

					return true;
				}

				const publication = state.publication;

				if (config.diagnosis === undefined || publication === null)
					return false;

				const original: AcceptanceBinding = {
					runId: input.runId,
					repo,
					issue: input.issue,
					contractDigest: contract.digest,
					acceptanceDigest: suite.receipt.acceptanceDigest,
					baseSha: state.originalBase,
					gateSha: state.originalBase,
				};

				return (
					(await config.diagnosis.check({
						runId: input.runId,
						dir,
						bindingDigest,
						repo,
						gateSha: state.baseSha,
						candidateSha: publication.candidateSha,
						round: state.round,
						allowanceMs,
						needs,
						heldoutDir: heldout.directory,
						heldoutDigest: heldout.digest,
						replacements: contract.contract.replacesTests ?? [],
						base:
							state.baseSha === state.originalBase
								? {
										kind: "stored",
										receipt: storedBaseReceipt(config.stateDir, original),
									}
								: {
										kind: "fresh",
										binding: {
											...original,
											baseSha: state.baseSha,
											gateSha: state.baseSha,
										},
										contract: contract.contract,
										suite: suite.suite,
										canary,
									},
						finish: (facts) => fail(classifyWith(raw, facts)),
						interrupted: () =>
							fail({ kind: "infrastructure", reason: "interrupted" }),
					})) === "settled"
				);
			};

			const assess = (verdict: Verdict): ReadAssessment => {
				const raw = receiptOf();

				const read =
					readStoredAssessment(dir) ??
					storeAssessment(
						dir,
						bindingOf(verdict),
						verdict.pass
							? { kind: "passed" }
							: { kind: "failed", failure: classifyWith(raw, null) },
					);

				if (
					read.assessment.kind === "failed" &&
					read.assessment.failure.kind === "candidate"
				)
					keepValidationFile(
						join(dir, "feedback.json"),
						feedbackBytes(read.ref, [
							...repairFeedback(
								suite.suite,
								contract.contract,
								textsOf(jsonField(raw, "heldoutFailures")) ?? [],
								heldout.directory,
							),
							...((present(checksPath)
								? parseCheckFeedback(
										parseJson(regularText(checksPath, 64 * 1024)),
										{
											changedPaths: patch.receipt.changedPaths,
											heldoutDir: heldout.directory,
										},
									)
								: null) ?? []),
						]),
					);

				return read;
			};

			if (state.publication !== null) {
				const tip = await api.ref(state.publication.branch);

				if (tip !== null && tip !== state.publication.candidateSha)
					return failed("branch_moved");

				if (
					tip === null &&
					state.rebaseSha === undefined &&
					!present(verdictPath) &&
					!present(failurePath)
				)
					return failed("branch_moved");
			}

			if (present(verdictPath)) {
				const verdict = readStoredVerdict(verdictPath);

				if (
					verdict.patchDigest !== patch.receipt.patchDigest ||
					verdict.acceptanceDigest !== suite.receipt.acceptanceDigest ||
					verdict.heldoutDigest !== heldout.digest ||
					verdict.candidateSha !== state.publication?.candidateSha ||
					verdict.gateSha !== state.baseSha ||
					verdict.baseSha !== state.baseSha ||
					verdict.originalBase !== state.originalBase ||
					verdict.ciRunId !== state.ciRunId
				)
					return failed("verdict_binding");

				if (!(await diagnosed(verdict))) return { kind: "waiting", state };
				const cleanup = await cleanupPublication(api, dir, state.publication);

				if (cleanup === "branch_moved") return failed("branch_moved");

				if (input.generation !== undefined && verdict.pass) {
					if (
						present(failurePath) &&
						jsonField(
							objectOf(parseJson(regularText(failurePath))),
							"reason",
						) === "ci_timeout"
					)
						return failed("ci_timeout");

					const report = await controllerReport(
						config,
						repo,
						input.runId,
						state,
						verdict,
					);

					if (report !== null)
						return {
							kind: "finished",
							state,
							verdict,
							report,
							assessment: assess(verdict),
						};

					return input.now >= state.deadline
						? failed("ci_timeout")
						: { kind: "waiting", state };
				}

				return {
					kind: "finished",
					state,
					verdict,
					assessment: assess(verdict),
				};
			}

			if (present(failurePath))
				return failed(
					textOf(
						jsonField(objectOf(parseJson(regularText(failurePath))), "reason"),
					) ?? "validation_failed",
				);

			if (state.rebaseSha !== undefined) {
				if (state.publication !== null)
					await api.remove(
						state.publication.branch,
						state.publication.candidateSha,
					);
				state.baseSha = state.rebaseSha;
				delete state.rebaseSha;
				state.publication = null;
				state.ciRunId = null;

				if (!(await save())) return failed("claim_unwritable");
			}

			if (state.publication === null && input.now >= state.deadline)
				return failed("ci_timeout");

			if (state.publication === null) {
				if (!state.baseResolved) {
					const main = objectOf(await api.request("GET", "git/ref/heads/main"));

					const sha = textOf(
						jsonField(objectOf(jsonField(main, "object")), "sha"),
					);

					if (sha === null || !isGitSha(sha)) return failed("main_unavailable");
					state.baseSha = sha;
					state.baseResolved = true;

					if (!(await save())) return failed("claim_unwritable");
				}

				if (owner && generation?.publication.kind === "owner") {
					state.publication = await pinOwnerCandidate(
						api,
						candidateBranch(
							input.issue,
							input.runId,
							state.round,
							generation.generation,
						),
						generation.publication.head,
					);
				} else {
					const scratch = await mkdtemp(join(dir, "tree-"));

					try {
						const base = join(scratch, "base");
						await mkdir(base);

						const checked = await checkoutWorkspace({
							stateDir: scratch,
							runId: input.runId,
							workspace: base,
							repo,
							sha: state.baseSha,
							fetch: config.fetch ?? ghTarball,
						});

						if (checked.kind !== "ready") return failed("base_unavailable");
						let gatesDigest: Digest | null = null;

						if (checked.omitted === 0) {
							try {
								gatesDigest = baseTreeDigest(
									join(base, ".github/factory/gates"),
								);
							} catch {
								/* A missing or unsafe historical gate tree is not a digest. */
							}
						}

						if (gatesDigest !== null)
							keepValidationFile(
								join(dir, "gate-policy.json"),
								`${JSON.stringify({
									v: 1,
									runId: input.runId,
									round: state.round,
									generation: state.generation?.index ?? 0,
									sourceSha: state.baseSha,
									digest: gatesDigest,
								})}\n`,
							);

						if (
							checked.checkout.files.some(
								(path) =>
									path === heldout.directory ||
									path.startsWith(`${heldout.directory}/`),
							)
						)
							return failed("stale_base");

						const files = await publicationTree(
							base,
							join(scratch, "patched"),
							patch.patch,
							patch.receipt.changedPaths,
						);

						state.publication = await publishCandidate(api, {
							issue: input.issue,
							runId: input.runId,
							round: state.round,
							generation: state.generation?.index,
							ancestry:
								state.generation?.previousHead == null
									? undefined
									: {
											kind: "successor",
											previousHead: state.generation.previousHead,
										},
							eventAt: input.eventAt,
							baseSha: state.baseSha,
							patchDigest: patch.receipt.patchDigest,
							acceptanceDigest: suite.receipt.acceptanceDigest,
							heldoutDigest: heldout.digest,
							patch: files,
							suite: heldout.files,
						});
					} finally {
						await rm(scratch, { recursive: true, force: true });
					}
				}

				if (!(await save())) return failed("claim_unwritable");
			}

			const publication = state.publication;

			if (publication === null) return failed("publication_missing");

			if ((await api.ref(publication.branch)) !== publication.candidateSha)
				return failed("branch_moved");

			let run =
				state.ciRunId === null
					? null
					: parseCiRun(
							await api.request("GET", `actions/runs/${state.ciRunId}`),
						);

			if ((run === null || state.dispatchTry > 1) && state.dispatchTry > 0) {
				const listed = objectOf(
					await api.request(
						"GET",
						"actions/workflows/ci.yml/runs?event=workflow_dispatch&per_page=100",
					),
				);

				const matches = (
					arrayOf(jsonField(listed, "workflow_runs")) ?? []
				).flatMap((value) => {
					const found = parseCiRun(value);

					return found !== null &&
						Array.from({ length: state.dispatchTry }, (_, index) =>
							dispatchNonce(
								input.runId,
								state.round,
								index + 1,
								state.generation?.index,
							),
						).some((nonce) =>
							matchesCiRun(
								found,
								publication.candidateSha,
								nonce,
								state.startedAt,
								config.platform.controllerLogin,
							),
						)
						? [found]
						: [];
				});

				if (matches.length > 1) {
					if (matches.some((match) => match.status !== "completed"))
						return input.now >= state.deadline
							? failed("ci_timeout")
							: { kind: "waiting", state };

					return failed("duplicate_dispatch");
				}

				run = matches[0] ?? run;
			}

			if (run === null) {
				if (input.now >= state.deadline) return failed("ci_timeout");

				if (input.dispatchAllowed === false) return failed("ci_missing");

				if (
					state.dispatchedAt !== null &&
					input.now - state.dispatchedAt < DISPATCH_SETTLE_MS
				)
					return { kind: "waiting", state };

				if (state.dispatchTry >= 2) return { kind: "waiting", state };
				const main = objectOf(await api.request("GET", "git/ref/heads/main"));

				const tip = textOf(
					jsonField(objectOf(jsonField(main, "object")), "sha"),
				);

				if (tip === null || !isGitSha(tip)) return failed("main_unavailable");

				if (tip !== state.baseSha) {
					if (input.generation !== undefined) return failed("stale_base");
					state.rebaseSha = tip;

					if (!(await save())) return failed("claim_unwritable");

					return { kind: "waiting", state };
				}

				state.dispatchTry++;
				state.dispatchedAt = input.now;

				if (!(await save())) return failed("claim_unwritable");

				const nonce = dispatchNonce(
					input.runId,
					state.round,
					state.dispatchTry,
					state.generation?.index,
				);

				const replacements = JSON.stringify(
					contract.contract.replacesTests ?? [],
				);

				try {
					const response = objectOf(
						await api.request(
							"POST",
							"actions/workflows/ci.yml/dispatches",
							{
								ref: "main",
								inputs: {
									candidate_sha: publication.candidateSha,
									nonce,
									replacements,
									replacements_digest: digestOf(replacements),
									heldout_dir: heldout.directory,
									heldout_digest: heldout.digest,
								},
							},
							true,
						),
					);

					state.ciRunId = countOf(jsonField(response, "workflow_run_id"));
				} catch (error) {
					if (!(error instanceof PublicationError)) throw error;
				}

				await save();

				return { kind: "waiting", state };
			}

			const nonce =
				Array.from({ length: state.dispatchTry }, (_, index) =>
					dispatchNonce(
						input.runId,
						state.round,
						index + 1,
						state.generation?.index,
					),
				).find(
					(nonce) => run.title === `gates ${publication.candidateSha} ${nonce}`,
				) ?? "missing";

			if (
				!matchesCiRun(
					run,
					publication.candidateSha,
					nonce,
					state.startedAt,
					config.platform.controllerLogin,
				)
			)
				return failed("ci_identity");
			state.ciRunId = run.id;

			if (!(await save())) return failed("claim_unwritable");

			if (run.status !== "completed")
				return input.now >= state.deadline
					? failed("ci_timeout")
					: { kind: "waiting", state };

			if (
				input.now >= state.deadline &&
				(run.completedAt === null ||
					Date.parse(run.completedAt) > state.deadline)
			)
				return failed("ci_timeout");

			if (run.headSha !== state.baseSha) return failed("stale_base");

			const logs = new Map<string, string>();

			const text = await (
				config.receipt ??
				((repo, id, sink) =>
					downloadGateReceipt(
						config.exec,
						repo,
						config.platform,
						id,
						"gate-receipt",
						sink,
					))
			)(repo, run.id, logs).catch(() => null);

			if (text === null && run.conclusion === "success")
				return input.now >= state.deadline
					? failed("ci_timeout")
					: { kind: "waiting", state };

			const raw = objectOf(parseJson(text ?? ""));

			if (
				jsonField(raw, "reason") === "stale_base" ||
				(text !== null && jsonField(raw, "gateSha") !== state.baseSha)
			)
				return failed("stale_base");

			const verdict = collectVerdict({
				text,
				run,
				nonce,
				patchDigest: patch.receipt.patchDigest,
				acceptanceDigest: suite.receipt.acceptanceDigest,
				heldoutDigest: heldout.digest,
				candidateSha: publication.candidateSha,
				originalBase: state.originalBase,
				baseSha: state.baseSha,
				unjudged: suite.suite.scenarios.flatMap((s) =>
					s.judge === null ? [] : [s.id],
				),
				controllerLogin: config.platform.controllerLogin,
			});

			keepValidationFile(receiptPath, text ?? "null\n");

			// Written once: a later download may differ in which logs it fetched.
			if (!present(checksPath))
				exclusive(
					checksPath,
					`${JSON.stringify(
						checkFeedback({
							logs,
							failed: verdict.checks
								.filter((check) => !check.passed)
								.map((check) => check.name),
							changedPaths: patch.receipt.changedPaths,
							heldoutDir: heldout.directory,
						}),
					)}\n`,
				);
			keepValidationFile(verdictPath, `${JSON.stringify(verdict)}\n`);

			if (!(await diagnosed(verdict))) return { kind: "waiting", state };
			const cleanup = await cleanupPublication(api, dir, publication);

			if (cleanup === "branch_moved") return failed("branch_moved");

			if (input.generation !== undefined && verdict.pass) {
				const report = await controllerReport(
					config,
					repo,
					input.runId,
					state,
					verdict,
				);

				if (report !== null)
					return {
						kind: "finished",
						state,
						verdict,
						report,
						assessment: assess(verdict),
					};

				return input.now >= state.deadline
					? failed("ci_timeout")
					: { kind: "waiting", state };
			}

			return { kind: "finished", state, verdict, assessment: assess(verdict) };
		} catch (error) {
			if (
				error instanceof PublicationError &&
				error.reason === "transport_exhausted"
			)
				return input.now >= state.deadline
					? failed("ci_timeout")
					: { kind: "waiting", state };

			return failed(
				error instanceof Error ? error.message : "validation_unavailable",
			);
		}
	};
}

export async function controllerReport(
	config: {
		readonly stateDir: string;
		readonly exec: Exec;
		readonly platform: PlatformProfile;
	},
	repo: RepoSlug,
	runId: Digest,
	state: ValidationState,
	verdict: Verdict,
) {
	const api = new GitHubPublicationApi(config.exec, repo, config.platform);

	const run = parseCiRun(
		await api.request("GET", `actions/runs/${verdict.ciRunId}`),
	);

	if (run === null) return null;

	const text = await downloadGateReceipt(
		config.exec,
		repo,
		config.platform,
		verdict.ciRunId,
		"factory-report",
	);

	if (text === null) return null;

	const nonce = Array.from({ length: state.dispatchTry }, (_, i) =>
		dispatchNonce(runId, state.round, i + 1, state.generation?.index),
	).find((n) =>
		matchesCiRun(
			run,
			state.publication?.candidateSha ?? state.baseSha,
			n,
			state.startedAt,
			config.platform.controllerLogin,
		),
	);

	if (nonce === undefined) return null;

	const checks = await api.request(
		"GET",
		`commits/${verdict.candidateSha}/check-runs?filter=all&per_page=100`,
	);

	const report = collectTrustedReport({
		record: parseJson(text),
		checks,
		run,
		nonce,
		verdict,
		controllerLogin: config.platform.controllerLogin,
	});

	if (report !== null) {
		const dir = validationDir(
			config.stateDir,
			runId,
			state.round,
			state.generation?.index,
		);

		keepValidationFile(join(dir, "report-receipt.json"), text);
		keepValidationFile(join(dir, "report.json"), `${JSON.stringify(report)}\n`);
	}

	return report;
}

export async function sweepValidation(config: {
	readonly stateDir: string;
	readonly exec: Exec;
	readonly platform: PlatformProfile;
	readonly fetch?: TarballFetch;
	readonly receipt?: GateReceiptSource;
	readonly now?: () => number;
}): Promise<void> {
	const files = fileRunFiles(config.stateDir);

	for (const claim of await files.listClaims()) {
		const book = claim.handoff;

		const terminal =
			claim.status !== null &&
			[
				"released",
				"failed",
				"budget_exhausted",
				"stage_passed",
				"landed",
				"cancelled",
			].includes(claim.status);

		const generations =
			book?.kind === "selected" ? candidateGenerations(book) : [];

		const entries: {
			state: ValidationState | null;
			generation: (typeof generations)[number]["intent"] | undefined;
			retired: boolean;
		}[] = generations.map((evidence) => ({
			state: evidence.validation,
			generation: evidence.intent,
			retired:
				terminal ||
				(book?.kind === "selected" &&
					(book.current.intent.digest !== evidence.intent.digest ||
						book.work.kind === "terminal" ||
						book.work.kind === "held" ||
						(book.work.kind === "effect" &&
							book.work.request.kind === "finish_pr"))),
		}));

		if (book === undefined && terminal && claim.validation !== undefined)
			entries.push({
				state: claim.validation,
				generation: undefined,
				retired: true,
			});

		for (const entry of entries) {
			const original = entry.state;
			const publication = original?.publication;

			if (original == null || publication == null) continue;

			const index =
				entry.generation?.generation ?? original.generation?.index ?? 0;

			if (
				publication.branch !==
				candidateBranch(claim.issue, claim.runId, original.round, index)
			)
				continue;

			const dir = validationDir(
				config.stateDir,
				claim.runId,
				original.round,
				index,
			);

			if (present(join(dir, "cleanup.json"))) continue;
			const contract = await files.readContract(claim.runId);

			if (
				contract.kind !== "found" ||
				(book !== undefined && book.pin.repo !== contract.contract.base.repo)
			)
				continue;

			const api = new GitHubPublicationApi(
				config.exec,
				contract.contract.base.repo,
				config.platform,
			);

			const progress = join(dir, "cleanup-validation.json");
			let state = structuredClone(original);

			if (present(progress)) {
				const restored = parseValidationState(parseJson(regularText(progress)));

				if (
					restored === null ||
					restored.startedAt !== original.startedAt ||
					restored.deadline !== original.deadline ||
					restored.round !== original.round ||
					restored.originalBase !== original.originalBase ||
					restored.baseSha !== original.baseSha ||
					JSON.stringify(restored.generation) !==
						JSON.stringify(original.generation) ||
					JSON.stringify(restored.publication) !== JSON.stringify(publication)
				)
					continue;
				state = restored;
			}

			if (
				!present(join(dir, "verdict.json")) &&
				!present(join(dir, "failure.json"))
			) {
				if (!entry.retired) continue;

				const listed = objectOf(
					await api
						.request(
							"GET",
							"actions/workflows/ci.yml/runs?event=workflow_dispatch&per_page=100",
						)
						.catch(() => undefined),
				);

				const runs = (
					arrayOf(jsonField(listed, "workflow_runs")) ?? []
				).flatMap((value) => {
					const run = parseCiRun(value);

					return run !== null &&
						Array.from({ length: state.dispatchTry }, (_, attempt) =>
							dispatchNonce(
								claim.runId,
								state.round,
								attempt + 1,
								state.generation?.index,
							),
						).some((nonce) =>
							matchesCiRun(
								run,
								publication.candidateSha,
								nonce,
								state.startedAt,
								config.platform.controllerLogin,
							),
						)
						? [run]
						: [];
				});

				const now = config.now?.() ?? Date.now();

				if (
					now < state.deadline &&
					(runs.length === 0 || runs.some((run) => run.status !== "completed"))
				)
					continue;

				if (runs.length === 1) state.ciRunId = runs[0]?.id ?? null;
				await (entry.generation?.origin.kind === "owner"
					? ownerValidator
					: controllerValidator)(config)({
					runId: claim.runId,
					issue: claim.issue,
					eventAt: contract.contract.snapshot.eventAt,
					baseSha: contract.contract.base.sha,
					now,
					wallMs: CI_DEADLINE_MS,
					round: state.round,
					generation: entry.generation,
					state,
					dispatchAllowed: false,
					save: async (validation) =>
						entry.generation === undefined
							? files.writeClaim({ ...claim, validation })
							: writeAtomic(progress, `${JSON.stringify(validation)}\n`),
				});
			}

			if (
				(!present(join(dir, "verdict.json")) &&
					!present(join(dir, "failure.json"))) ||
				(!entry.retired &&
					present(join(dir, "verdict.json")) &&
					!present(join(dir, "assessment.json")) &&
					jsonField(
						objectOf(
							parseJson(regularText(join(dir, "verdict.json"), 1024 * 1024)),
						),
						"pass",
					) !== true)
			)
				continue;
			await cleanupPublication(api, dir, publication);
		}
	}
}

/**
 * Fetches a run's trusted gate receipt. A `logs` sink also receives the
 * visible check logs beside it in the artifact, for repair feedback.
 */
export type GateReceiptSource = (
	repo: RepoSlug,
	id: number,
	logs?: Map<string, string>,
) => Promise<string | null>;

export async function downloadGateReceipt(
	exec: Exec,
	repo: RepoSlug,
	identity: CommitIdentity,
	id: number,
	artifactName = "gate-receipt",
	checkLogs?: Map<string, string>,
): Promise<string | null> {
	const dir = mkdtempSync(join(tmpdir(), "factory-ci-"));

	try {
		const api = new GitHubPublicationApi(exec, repo, identity);

		const listed = objectOf(
			await api
				.request("GET", `actions/runs/${id}/artifacts`)
				.catch(() => undefined),
		);

		const artifacts = (arrayOf(jsonField(listed, "artifacts")) ?? []).filter(
			(value) =>
				jsonField(objectOf(value), "name") === artifactName &&
				jsonField(objectOf(value), "expired") === false,
		);

		if (artifacts.length === 1) {
			const artifactId = countOf(jsonField(objectOf(artifacts[0]), "id"));

			if (artifactId !== null) {
				for (let attempt = 0; attempt < 3; attempt++) {
					const zip = await new Promise<Buffer | null>((done) => {
						execFile(
							"gh",
							["api", `repos/${repo}/actions/artifacts/${artifactId}/zip`],
							{
								encoding: "buffer",
								maxBuffer: 8 * 1024 * 1024,
								timeout: 30_000,
							},
							(error, stdout) => done(error === null ? stdout : null),
						);
					});

					if (zip !== null) {
						const path = join(dir, "artifact.zip");
						await writeFile(path, zip, { mode: 0o600 });
						const receipt = await exec("unzip", ["-p", path, "receipt.json"]);

						if (
							receipt.code === 0 &&
							Buffer.byteLength(receipt.stdout) < 1024 * 1024
						) {
							for (const name of checkLogs === undefined
								? []
								: FEEDBACK_CHECKS) {
								const member = await exec("unzip", [
									"-p",
									path,
									`${name}.log`,
								]).catch(() => null);

								if (member?.code === 0)
									checkLogs?.set(name, member.stdout.slice(0, 1024 * 1024));
							}

							return receipt.stdout;
						}
					}

					if (attempt < 2)
						await new Promise((done) => setTimeout(done, 1000 * 2 ** attempt));
				}
			}
		}

		if (artifactName !== "gate-receipt") return null;

		const jobs = objectOf(await api.request("GET", `actions/runs/${id}/jobs`));

		const gates = (arrayOf(jsonField(jobs, "jobs")) ?? []).filter(
			(value) => jsonField(objectOf(value), "name") === "gates",
		);

		if (gates.length !== 1) return null;
		const jobId = countOf(jsonField(objectOf(gates[0]), "id"));

		if (jobId === null) return null;

		const logs = await exec("gh", [
			"api",
			"--allow-escape-sequences",
			`repos/${repo}/actions/jobs/${jobId}/logs`,
		]);

		if (logs.code !== 0) throw new PublicationError("transport_exhausted");

		const lines = logs.stdout
			.split("\n")
			.map((line) => line.replace(/^\S+\s/, ""));

		const start = lines.findIndex((line) => line === "{");
		const end = lines.findIndex((line, index) => index > start && line === "}");

		return logs.code === 0 && start >= 0 && end > start
			? lines.slice(start, end + 1).join("\n")
			: null;
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
}
