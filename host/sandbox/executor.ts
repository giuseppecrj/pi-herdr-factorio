import { randomBytes } from "node:crypto";
import {
	chmodSync,
	existsSync,
	lstatSync,
	mkdirSync,
	readdirSync,
	readFileSync,
	renameSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { readlink, rm } from "node:fs/promises";
import { dirname, join } from "node:path";
import {
	baseTestCommand,
	checkBuildDisk,
	collectPatch,
	finishPatch,
	patchBinding,
	prepareRepairTree,
	readPatch,
	readRepairBuildResult,
	roundKey,
	storePatch,
	type VisibleTests,
} from "../../src/candidate/build.ts";
import { parseReviewReceipt } from "../../src/candidate/codec.ts";
import {
	builderDispositions,
	builderFindingDispositions,
	readFeedbackBatch,
} from "../../src/candidate/feedback.ts";
import {
	feedbackPrompt,
	findingFingerprint,
	findingFingerprints,
	keepReview,
	reviewCandidate,
	reviewDir,
	reviewFeedback,
	type SeatReceipt,
} from "../../src/candidate/review.ts";
import { reviewReceiptDigest } from "../../src/candidate/state.ts";
import {
	readFeedbackBytes,
	validationDir,
} from "../../src/candidate/validation.ts";
import { regularText } from "../../src/contract/artifacts.ts";
import { objectOf, parseJson } from "../../src/core/json.ts";
import { FAMILY_MISSING } from "../../src/core/models.ts";
import { blocksReview, digestOf, type Digest } from "../../src/core/run.ts";
import type { Exec } from "../../src/github/exec.ts";
import type {
	StageExecutor,
	StageLaunch,
	StageLaunchInput,
} from "../../src/controller/launch.ts";
import type { Log } from "../../src/controller/orchestrator.ts";
import type { PlatformProfile } from "../../src/trust/platform.ts";
import {
	FEEDBACK_FILE,
	FEEDBACK_FULL_FILE,
} from "../../src/trust/protected-paths.ts";
import {
	bundleMatchesSource,
	manifestDigest,
	PINNED_VERSIONS,
} from "../bundle/manifest.ts";
import { controllerCandidatePort } from "../controller/candidate-port.ts";
import {
	controllerBaseChecker,
	controllerDiagnosis,
	controllerDraftChecker,
} from "../controller/checkers.ts";
import {
	checkoutBuildWorkspace,
	checkoutOf,
	checkoutWorkspace,
	ghTarball,
	type TarballFetch,
} from "../controller/checkout.ts";
import { fileRunFiles } from "../controller/run-files.ts";
import { readStoredAssessment } from "../controller/state.ts";
import {
	controllerValidator,
	ownerValidator,
	sweepValidation,
} from "../controller/validation-sweep.ts";
import { startGatewayProcess } from "../gateway/client.ts";
import { builtinTable } from "../gateway/routes.ts";
import { readUsernsLimit, runPreflight } from "../isolation/preflight.ts";
import { reconcileScopes } from "../isolation/scope.ts";
import type { SeccompArch } from "../isolation/seccomp.ts";
import { freshDir, sandboxHost, type SandboxHostConfig } from "./launch.ts";
import {
	attemptOutput,
	attemptSpent,
	boundedText,
	buildCommands,
	publishFile,
	readRunPatch,
	stageName,
} from "./receipts.ts";
import { stageResult } from "./result.ts";
import { prepareCandidateReview, runReview } from "./review.ts";
import { runStage } from "./run-stage.ts";
import { runSpecify } from "./specify.ts";
import { runVisibleTests, visibleBudget } from "./visible-tests.ts";

/** Where `host/install/provision.sh` installs content-addressed asset bundles. */
export const SANDBOX_ROOT = "/var/lib/factory-sandbox";

const BUNDLE_NAME = /^assets-([0-9a-f]{64})$/;

export type Bundle = { readonly dir: string; readonly digest: string };

/**
 * The bundle `<root>/current` links to. Its name carries the manifest digest
 * it was installed under, which the preflight recomputes.
 */
export async function locateBundle(root: string): Promise<Bundle | null> {
	try {
		const target = await readlink(join(root, "current"));
		const digest = BUNDLE_NAME.exec(target)?.[1];

		return digest === undefined ? null : { dir: join(root, target), digest };
	} catch {
		return null;
	}
}

const SKILL_NAME = /^[a-z0-9][a-z0-9-]{0,63}$/;

const SKILL_MAX_BYTES = 32 * 1024;

function skillBody(text: string): string {
	const match = /^---\n[\s\S]*?\n---\n/.exec(text);

	return (match === null ? text : text.slice(match[0].length)).trim();
}

export async function withSkills(
	bundleDir: string,
	prompt: string,
	skills: readonly string[],
): Promise<string | null> {
	if (skills.length === 0) return prompt;

	const parts: string[] = [];

	for (const name of skills) {
		if (!SKILL_NAME.test(name)) return null;

		const text = await boundedText(
			join(bundleDir, "skills", name, "SKILL.md"),
			SKILL_MAX_BYTES,
		);

		if (text === null) return null;

		parts.push(`### Skill: ${name}\n\n${skillBody(text)}`);

		if (
			name === "build" &&
			!(prompt + "\n").startsWith("build-playbook=feedback\n")
		) {
			const playbook = (prompt + "\n").startsWith("build-playbook=bug-fix\n")
				? "bug-fix"
				: "feature";

			const source = await boundedText(
				join(
					bundleDir,
					"pkg/node_modules/pi-herdr-pstack/skills/poteto-mode/playbooks",
					`${playbook}.md`,
				),
				SKILL_MAX_BYTES,
			);

			if (source === null) return null;

			const excerpt = source
				.split("\n")
				.filter((line) =>
					playbook === "bug-fix"
						? /^(Be scientific\.|1\. |4\. )/.test(line)
						: line.startsWith("5. "),
				)
				.join("\n\n");

			if (!excerpt) return null;
			parts.push(`### Pstack ${playbook} playbook excerpt\n\n${excerpt}`);
		}
	}

	return `${prompt}\n\n## Skills\n\n${parts.join("\n\n")}\n`;
}

function cleanupBuildAgents(
	stateDir: string,
	runId: Digest,
	attempt: number,
	round = 0,
): void {
	const root = join(stateDir, "stages", runId);

	if (!existsSync(root)) return;

	for (const name of readdirSync(root)) {
		if (
			name !== stageName("build", attempt, round) &&
			!new RegExp(`^${stageName("build", attempt, round)}\\.[0-9]+$`).test(name)
		)
			continue;

		const stage = join(root, name);

		const agents = readdirSync(stage).filter((agent) =>
			/^agent-[0-9]+$/.test(agent),
		);

		const sessions: {
			source: string;
			dest: string;
			size: number;
			mtime: number;
		}[] = [];

		const walk = (source: string, dest: string) => {
			const info = lstatSync(source);

			if (info.isSymbolicLink()) return;

			if (info.isDirectory()) {
				for (const entry of readdirSync(source))
					walk(join(source, entry), join(dest, entry));
			} else if (info.isFile() && source.endsWith(".jsonl"))
				sessions.push({ source, dest, size: info.size, mtime: info.mtimeMs });
		};

		for (const agent of agents) {
			const source = join(stage, agent, "sessions");

			if (!lstatSync(join(stage, agent)).isSymbolicLink() && existsSync(source))
				walk(source, join(stage, "sessions", agent));
		}

		sessions.sort(
			(a, b) => b.mtime - a.mtime || a.source.localeCompare(b.source),
		);
		let bytes = 0;
		const dropped: string[] = [];
		chmodSync(stage, 0o700);

		for (const session of sessions) {
			if (bytes + session.size > 8 * 1024 * 1024) {
				dropped.push(session.source.slice(stage.length + 1));
				continue;
			}

			mkdirSync(dirname(session.dest), { recursive: true, mode: 0o700 });
			renameSync(session.source, session.dest);
			chmodSync(session.dest, 0o600);
			bytes += session.size;
		}

		if (dropped.length > 0) {
			const path = join(stage, "receipt.json");
			const receipt = objectOf(parseJson(readFileSync(path, "utf8")));

			const updated = `${path}.sessions-${randomBytes(4).toString("hex")}`;

			if (
				receipt !== null &&
				publishFile(
					updated,
					JSON.stringify(
						{ ...receipt, session_truncated: dropped },
						null,
						"\t",
					),
				)
			)
				renameSync(updated, path);
		}

		for (const agent of agents)
			rmSync(join(stage, agent), { recursive: true, force: true });
	}
}

function cleanupBuildBase(stateDir: string, runId: Digest): void {
	rmSync(join(stateDir, "build-base", "checkouts", `${runId}.json`), {
		force: true,
	});
	rmSync(join(stateDir, "pristine", runId), { recursive: true, force: true });
}

export type SandboxExecutorConfig = {
	readonly stateDir: string;
	readonly exec: Exec;
	readonly log: Log;
	readonly platform: PlatformProfile;
	readonly xdgRuntimeDir: string;
	readonly root?: string;
	/** The checkout whose inputs the installed bundle must match. Absent skips the check. */
	readonly sourceRoot?: string;
	readonly arch?: string;
	readonly usernsLimit?: () => Promise<string>;
	readonly fetchTarball?: TarballFetch;
	readonly visibleTests?: typeof runVisibleTests;
	readonly host?: typeof sandboxHost;
};

const PREFLIGHT_RUN =
	"0000000000000000000000000000000000000000000000000000000000000000";

/**
 * The stage executor the controller installs. It stops leftover stage
 * scopes at startup, runs the preflight until it passes, and launches each
 * stage in a fresh sandbox, or specify's bounded session sequence. Until the preflight has
 * passed, every launch is `sandbox_unavailable` and no model runs. A
 * reconcile that failed fails the preflight, which retries it: no stage of
 * this process can be running yet, so a retry stops only leftovers.
 */
export function sandboxExecutor(config: SandboxExecutorConfig): StageExecutor {
	const root = config.root ?? SANDBOX_ROOT;

	const baseChecker = controllerBaseChecker({
		stateDir: config.stateDir,
		fetch: config.fetchTarball,
	});

	const diagnosis = controllerDiagnosis({
		stateDir: config.stateDir,
		fetch: config.fetchTarball,
	});

	let ready: { readonly bundle: Bundle; readonly arch: SeccompArch } | null =
		null;

	let reported: string | null = null;
	let reconciled = false;

	const reconcile = async (always: boolean): Promise<boolean> => {
		const result = await reconcileScopes(config.stateDir, config.exec);

		reconciled = result.failed.length === 0;

		if (!always && !reconciled) return false;

		for (const unit of result.unowned) config.log("scope_unowned", { unit });

		config.log("sandbox_reconciled", {
			stopped: result.stopped.length,
			failed: result.failed.length,
			unowned: result.unowned.length,
		});

		return reconciled;
	};

	const gatewayReady = async (): Promise<boolean> => {
		const nonce = randomBytes(4).toString("hex");
		const dir = join(config.stateDir, "gw");
		const audit = join(dir, `preflight-${nonce}.jsonl`);

		mkdirSync(dir, { recursive: true, mode: 0o700 });

		const started = await startGatewayProcess({
			gatewayDir: join(dir, `p-${nonce}`),
			auditPath: audit,
			platform: config.platform,
			table: builtinTable({
				platform: config.platform,
				stage: "specify",
				runId: PREFLIGHT_RUN,
				attempt: 1,
				model: "preflight",
				fallback: null,
				modelTokens: 0,
				modelRequests: 0,
			}),
			readyTimeoutMs: 10_000,
		});

		if (started.ok) await started.handle.shutdown();

		await rm(join(dir, `p-${nonce}`), { recursive: true, force: true });
		await rm(audit, { force: true });

		return started.ok;
	};

	return {
		baseCheck: baseChecker.check,
		async stopBase(runId) {
			await baseChecker.stop(runId);
			await diagnosis.stop(runId);
		},
		candidate: controllerCandidatePort({
			stateDir: config.stateDir,
			exec: config.exec,
			platform: config.platform,
			log: config.log,
		}),
		validate: controllerValidator({
			stateDir: config.stateDir,
			exec: config.exec,
			platform: config.platform,
			fetch: config.fetchTarball,
			diagnosis,
		}),
		ownerValidate: ownerValidator({
			stateDir: config.stateDir,
			exec: config.exec,
			platform: config.platform,
			fetch: config.fetchTarball,
			diagnosis,
		}),
		async readFeedback(runId, digest) {
			return readFeedbackBatch(config.stateDir, runId, digest)?.batch ?? null;
		},

		async readAssessment({ runId, round, generation }) {
			return readStoredAssessment(
				validationDir(config.stateDir, runId, round, generation),
			);
		},
		cleanupValidation: () =>
			sweepValidation({
				stateDir: config.stateDir,
				exec: config.exec,
				platform: config.platform,
				fetch: config.fetchTarball,
			}),
		async recover() {
			await reconcile(true);
		},

		async reconciled() {
			return reconciled || reconcile(false);
		},

		async spent({ runId, stage, attempt, round, execution }) {
			if (execution !== undefined) {
				try {
					const intent = regularText(
						join(
							config.stateDir,
							"stages",
							runId,
							stageName(stage, attempt, round),
							"execution.json",
						),
					);

					if (intent !== `${JSON.stringify(execution)}\n`) return null;
				} catch {
					return null;
				}
			}

			return attemptSpent(config.stateDir, runId, stage, attempt, round);
		},

		prepareReview: (input) => prepareCandidateReview(config, input),

		async output(input) {
			const { runId, stage, attempt, round = 0 } = input;

			if (stage === "build") {
				const outcomePath = join(
					config.stateDir,
					"stages",
					runId,
					`${stageName(stage, attempt, round)}-result.json`,
				);

				if (existsSync(outcomePath)) {
					const result = readRepairBuildResult(
						config.stateDir,
						runId,
						round,
						attempt,
					);

					return {
						kind: "build",
						result: {
							kind: "blocked",
							...(result ?? { reason: "patch_invalid" }),
						},
					};
				}

				let kept = readRunPatch(config.stateDir, runId, round);

				if (round > 0 && kept.kind === "found") {
					const previous = readRunPatch(
						config.stateDir,
						runId,
						input.execution?.stage === "build"
							? input.execution.feedbackFrom.round
							: round - 1,
					);

					if (
						previous.kind !== "found" ||
						kept.receipt.patchDigest === previous.receipt.patchDigest
					)
						return {
							kind: "build",
							result: {
								kind: "blocked",
								reason:
									previous.kind === "found"
										? "repair_no_change"
										: "patch_missing",
							},
						};
				}

				if (
					kept.kind === "found" &&
					(kept.receipt.visibleTests !== null ||
						kept.receipt.policy === "forbidden")
				)
					cleanupBuildBase(config.stateDir, runId);

				if (
					kept.kind === "found" &&
					kept.receipt.policy === "clean" &&
					kept.receipt.visibleTests === null
				) {
					if (ready === null) return { kind: "pending" };
					const base = join(config.stateDir, "pristine", runId);

					if (
						!existsSync(base) ||
						!existsSync(
							join(config.stateDir, "build-base", "checkouts", `${runId}.json`),
						)
					) {
						const bound = await fileRunFiles(config.stateDir).readContract(
							runId,
						);

						if (bound.kind !== "found")
							return {
								kind: "build",
								result: { kind: "blocked", reason: "patch_invalid" },
							};
						mkdirSync(base, { recursive: true, mode: 0o700 });

						const checked = await checkoutWorkspace({
							stateDir: join(config.stateDir, "build-base"),
							workspace: base,
							runId,
							repo: bound.contract.base.repo,
							sha: bound.contract.base.sha,
							fetch: config.fetchTarball ?? ghTarball,
						});

						if (checked.kind !== "ready") {
							cleanupBuildBase(config.stateDir, runId);
							const candidate = kept.receipt.candidateTests;

							if (candidate !== undefined)
								return {
									kind: "build",
									result: finishPatch(
										config.stateDir,
										patchBinding(kept.receipt),
										{
											...candidate,
											base: {
												command: candidate.command,
												exitCode: null,
												reason: "visible_tests_unavailable",
												tail: "Visible base could not be prepared",
												wallMs: 0,
											},
										},
									),
								};

							return {
								kind: "build",
								result: {
									kind: "unavailable",
									reason: "visible_tests_unavailable",
								},
							};
						}
					}

					const contract = await fileRunFiles(config.stateDir).readContract(
						runId,
					);

					const testConfig: SandboxHostConfig = {
						platform: config.platform,
						stateDir: config.stateDir,
						bundleDir: ready.bundle.dir,
						workspace: "",
						runId,
						stage: "build",
						attempt,
						tools: [],
						arch: ready.arch,
						xdgRuntimeDir: config.xdgRuntimeDir,
						assetsDigest: ready.bundle.digest,
						versions: PINNED_VERSIONS,
						exec: config.exec,
					};

					const runTests = async (
						...args: Parameters<typeof runVisibleTests>
					) => {
						const tests = visibleBudget(
							await (config.visibleTests ?? runVisibleTests)(...args),
						);

						if ("nearLimit" in tests && tests.nearLimit === true)
							config.log("visible_tests_near_limit", {
								runId,
								wallMs: tests.wallMs,
								target: args[2].length > 0 ? "candidate" : "base",
							});

						return tests;
					};

					const binding = patchBinding(kept.receipt);

					let tests: VisibleTests =
						kept.receipt.candidateTests ??
						(await runTests(
							testConfig,
							base,
							kept.patch,
							kept.receipt.testCommand,
							contract.kind === "found" &&
								contract.digest === kept.receipt.contractDigest
								? (contract.contract.replacesTests ?? [])
								: [],
						));

					if (tests.exitCode !== null && tests.exitCode !== 0) {
						const checkpoint = finishPatch(
							config.stateDir,
							binding,
							tests,
							"candidate",
						);

						if (checkpoint.kind !== "found")
							return { kind: "build", result: checkpoint };
						tests = {
							...tests,
							base: await runTests(
								testConfig,
								base,
								"",
								kept.receipt.testCommand,
							),
						};
					}

					kept = finishPatch(
						config.stateDir,
						patchBinding(kept.receipt),
						tests,
					);

					if (kept.kind === "unavailable")
						config.log("visible_tests_unavailable", {
							runId,
							why: tests.detail ?? "sandbox_unavailable",
						});
					cleanupBuildBase(config.stateDir, runId);
				}

				return kept.kind === "absent" ? null : { kind: "build", result: kept };
			}

			if (stage === "review") {
				const execution = input.execution;

				if (execution !== undefined && execution.stage !== "review")
					return null;

				const prepared = await prepareCandidateReview(config, {
					runId,
					round,
					execution,
					workflowSha: input.workflowSha,
					workflowDigest: input.workflowDigest,
					workspace: join(
						config.stateDir,
						"review-tree",
						`${roundKey(runId, round)}-a${attempt}`,
					),
				});

				if ("kind" in prepared) return prepared;

				const output = await attemptOutput(
					config.stateDir,
					runId,
					stage,
					attempt,
					round,
				);

				if (
					output === null ||
					(output instanceof Object && output.kind === "pending")
				)
					return output;

				try {
					const text =
						output instanceof Object
							? output.kind === "output"
								? output.text
								: ""
							: output;

					// SAFETY: output is the host-authored aggregate; reviewCandidate revalidates each seat's schema and exact binding.
					const seats = JSON.parse(text) as SeatReceipt[];

					const receipt = reviewCandidate(
						prepared.input,
						prepared.verdict,
						seats,
						prepared.families ?? {
							builder: FAMILY_MISSING,
							accept: FAMILY_MISSING,
						},
					);

					keepReview(config.stateDir, receipt);

					return { kind: "review", receipt };
				} catch {
					return null;
				}
			}

			return attemptOutput(config.stateDir, runId, stage, attempt, round);
		},

		async checkout({
			runId,
			repo,
			sha,
			workspace,
			build,
			round = 0,
			feedbackFrom,
			cause,
		}) {
			const checked = await (build
				? checkoutBuildWorkspace
				: checkoutWorkspace)({
				stateDir: config.stateDir,
				runId,
				workspace,
				repo,
				sha,
				fetch: config.fetchTarball ?? ghTarball,
				log: config.log,
			});

			if (build && round > 0 && checked.kind === "ready") {
				try {
					const previous = readRunPatch(
						config.stateDir,
						runId,
						feedbackFrom?.round ?? round - 1,
					);

					if (previous.kind !== "found")
						return { kind: "refused", reason: "repair_patch_missing" };

					const dir = validationDir(
						config.stateDir,
						runId,
						feedbackFrom?.round ?? round - 1,
						feedbackFrom?.generation,
					);

					const assessed = readStoredAssessment(dir);
					const feedbackPath = join(dir, "feedback.json");

					if (
						assessed === null ||
						cause === undefined ||
						assessed.binding.runId !== runId ||
						assessed.binding.round !== (feedbackFrom?.round ?? round - 1) ||
						assessed.binding.generation !== (feedbackFrom?.generation ?? 0) ||
						assessed.ref.bindingDigest !== cause.assessment.bindingDigest ||
						assessed.ref.recordDigest !== cause.assessment.recordDigest
					)
						throw new Error("assessment_missing");
					let validation: ReturnType<typeof readFeedbackBytes> = null;

					if (assessed.assessment.kind === "passed") {
						if (
							existsSync(feedbackPath) ||
							(cause.kind !== "review" && cause.kind !== "feedback")
						)
							throw new Error("feedback_unexpected");
						validation = [];
					} else if (
						assessed.assessment.failure.kind === "candidate" &&
						(cause.kind === "validation" || cause.kind === "feedback")
					)
						validation = readFeedbackBytes(
							regularText(feedbackPath),
							assessed.ref,
						);

					if (validation === null) throw new Error("feedback_provenance");

					const reviewPath = join(
						reviewDir(
							config.stateDir,
							runId,
							feedbackFrom?.round ?? round - 1,
							feedbackFrom?.generation,
						),
						"receipt.json",
					);

					const stored = existsSync(reviewPath)
						? parseReviewReceipt(parseJson(regularText(reviewPath)))
						: undefined;

					if (stored === null) throw new Error("review_receipt_invalid");

					if (
						(cause.kind === "review" ||
							(cause.kind === "feedback" && cause.review !== null)) &&
						(stored === undefined ||
							reviewReceiptDigest(stored) !== cause.review ||
							stored.runId !== runId ||
							stored.round !== (feedbackFrom?.round ?? round - 1) ||
							(stored.execution?.generation ?? 0) !==
								(feedbackFrom?.generation ?? 0) ||
							!stored.blocking ||
							!blocksReview(stored.seats))
					)
						throw new Error("review_receipt_mismatch");

					const review = stored === undefined ? [] : reviewFeedback(stored);

					if (cause.kind === "review" && review.length === 0)
						throw new Error("review_feedback_empty");

					const owner =
						cause.kind === "feedback"
							? readFeedbackBatch(config.stateDir, runId, cause.batch)
							: null;

					if (
						cause.kind === "feedback" &&
						(owner === null ||
							!owner.batch.records.some((r) => r.intake.kind === "actionable"))
					)
						throw new Error("feedback_batch_missing");

					const content = { version: 1, round, validation, review };

					const feedback = JSON.stringify(
						owner === null
							? content
							: {
									...content,
									version: 2,
									review: review.map((f) => ({
										...f,
										fingerprint: findingFingerprint(
											f.seat,
											f.category,
											"path" in f ? f.path : f.scenario,
											f.claim,
										),
									})),
									owner: owner.batch.cards,
									truncated: owner.batch.cards.some((c) => c.truncated),
									full: owner.batch.full,
								},
					);

					rmSync(workspace, { recursive: true, force: true });
					await prepareRepairTree(
						join(config.stateDir, "pristine", runId),
						workspace,
						previous.patch,
						previous.receipt.changedPaths,
						feedback,
					);

					if (owner?.full != null)
						writeFileSync(join(workspace, FEEDBACK_FULL_FILE), owner.full, {
							flag: "wx",
							mode: 0o600,
						});

					const paths = [
						...new Set([
							...checked.checkout.files,
							...previous.receipt.changedPaths,
						]),
					].filter((path) => {
						try {
							return lstatSync(join(workspace, path)).isFile();
						} catch {
							return false;
						}
					});

					return { ...checked, checkout: checkoutOf(workspace, paths) };
				} catch {
					return { kind: "refused", reason: "repair_inputs_invalid" };
				}
			}

			return checked;
		},

		async preflight() {
			if (ready !== null) return true;

			const bundle = await locateBundle(root);

			const result = await runPreflight({
				reconciled: async () => reconciled || reconcile(false),
				xdgRuntimeDir: config.xdgRuntimeDir,
				arch: config.arch ?? process.arch,
				usernsLimit: config.usernsLimit ?? readUsernsLimit,
				exec: config.exec,
				assetsDigest: async () =>
					bundle === null ? null : manifestDigest(bundle.dir),
				expectedDigest: bundle?.digest ?? "",
				bundleCurrent:
					config.sourceRoot === undefined || bundle === null
						? undefined
						: () => bundleMatchesSource(config.sourceRoot ?? "", bundle.dir),
				gatewayReady,
			});

			const summary = result.ok ? "ok" : result.failed.join("+");

			if (summary !== reported) {
				reported = summary;
				config.log("sandbox_preflight", {
					ok: result.ok,
					failed: result.ok ? "none" : summary,
					assets: bundle?.digest.slice(0, 12) ?? "none",
				});
			}

			if (result.ok && bundle !== null) ready = { bundle, arch: result.arch };

			return ready !== null;
		},

		async launch(input: StageLaunchInput): Promise<StageLaunch> {
			if (ready === null) {
				return {
					kind: "unavailable",
					stage: input.stage,
					reason: "sandbox_unavailable",
				};
			}

			const { bundle, arch } = ready;

			const repair =
				input.stage === "build" && (input.round ?? 0) > 0
					? feedbackPrompt(regularText(join(input.workspace, FEEDBACK_FILE)))
					: "";

			const prompt = await withSkills(
				bundle.dir,
				`${input.prompt}\n${repair}`,
				input.skills,
			);

			if (prompt === null) {
				config.log("skills_unavailable", {
					runId: input.runId,
					stage: input.stage,
				});

				return {
					kind: "unavailable",
					stage: input.stage,
					reason: "sandbox_unavailable",
				};
			}

			const hostConfig: SandboxHostConfig = {
				platform: config.platform,
				stateDir: config.stateDir,
				bundleDir: bundle.dir,
				workspace: input.workspace,
				runId: input.runId,
				stage: input.stage,
				attempt: input.attempt,
				tools: input.tools,
				acceptEffort: input.acceptEffort,
				arch,
				xdgRuntimeDir: config.xdgRuntimeDir,
				assetsDigest: bundle.digest,
				versions: PINNED_VERSIONS,
				exec: config.exec,
			};

			if (input.stage === "specify" && input.specify !== undefined) {
				const stages = join(config.stateDir, "stages", input.runId);
				const base = `${input.stage}-${input.attempt}`;

				mkdirSync(stages, { recursive: true, mode: 0o700 });

				const saved = readdirSync(stages)
					.filter(
						(name) =>
							(name === base ||
								(name.startsWith(`${base}.`) &&
									/^\d+$/.test(name.slice(base.length + 1)))) &&
							existsSync(join(stages, name, "specify.json")),
					)
					.sort(
						(a, b) =>
							Number(b.slice(base.length + 1) || "1") -
							Number(a.slice(base.length + 1) || "1"),
					)[0];

				const dir =
					saved === undefined
						? freshDir(join(stages, base))
						: join(stages, saved);

				return {
					kind: "started",
					done: runSpecify({ ...input, prompt }, dir, (stageDir, tools) =>
						sandboxHost({ ...hostConfig, stageDir, tools }),
					),
				};
			}

			if (input.stage === "review" && input.review !== undefined) {
				const stages = join(config.stateDir, "stages", input.runId);

				const dir = join(
					stages,
					stageName(input.stage, input.attempt, input.round),
				);

				return {
					kind: "started",
					done: runReview(
						input,
						dir,
						(stageDir, tools) =>
							(config.host ?? sandboxHost)({ ...hostConfig, stageDir, tools }),
						(prompt, seat) => withSkills(bundle.dir, prompt, [seat]),
					),
				};
			}

			if (
				input.stage === "maintain" &&
				((input.maintenance === undefined && input.measurement === undefined) ||
					input.tools.length !== 0 ||
					(input.skills.length !== 0 && input.measurement !== undefined))
			)
				return {
					kind: "unavailable",
					stage: input.stage,
					reason: "sandbox_unavailable",
				};

			if (
				input.measurement !== undefined &&
				(input.stage !== "maintain" ||
					!/^[a-f0-9]{64}$/.test(input.measurement.scoredRunId) ||
					!Number.isSafeInteger(input.measurement.seq) ||
					input.measurement.seq < 1)
			)
				return {
					kind: "unavailable",
					stage: input.stage,
					reason: "sandbox_unavailable",
				};

			const measurementIdentity =
				input.measurement === undefined
					? undefined
					: `measure/${input.measurement.kind}/${input.measurement.scoredRunId}/${input.measurement.seq}`;

			if (
				measurementIdentity !== undefined &&
				digestOf(measurementIdentity) !== input.runId
			)
				return {
					kind: "unavailable",
					stage: input.stage,
					reason: "sandbox_unavailable",
				};

			const stageDir =
				input.measurement !== undefined
					? join(
							config.stateDir,
							"measure",
							input.measurement.kind,
							input.measurement.scoredRunId,
							String(input.measurement.seq),
							"runtime",
						)
					: input.stage === "maintain" && input.maintenance !== undefined
						? join(
								config.stateDir,
								"cadence",
								input.maintenance.job,
								"executions",
								String(input.maintenance.windowStart),
								"runtime",
							)
						: freshDir(
								join(
									config.stateDir,
									"stages",
									input.runId,
									stageName(input.stage, input.attempt, input.round),
								),
							);

			if (input.stage === "maintain" && existsSync(stageDir))
				return {
					kind: "unavailable",
					stage: input.stage,
					reason: "sandbox_unavailable",
				};

			const draftCheck =
				input.stage === "accept" && input.acceptDraft !== undefined
					? controllerDraftChecker({
							stateDir: config.stateDir,
							stageDir,
							attempt: input.attempt,
							input: input.acceptDraft,
							fetch: config.fetchTarball,
						})
					: undefined;

			const done = runStage(
				{
					runId: input.runId,
					stage: input.stage,
					attempt: input.attempt,
					prompt,
					measurementIdentity,
					source: input.source,
					draftCheck,
					settings: input.settings,
					remainingRunTokens: input.remainingRunTokens,
					signal: input.signal,
					progress: input.progress,
				},
				(config.host ?? sandboxHost)({
					...hostConfig,
					stageDir,
				}),
			);

			return {
				kind: "started",
				done: done
					.then(async (result) => {
						if (
							input.stage !== "build" ||
							input.build === undefined ||
							result.kind !== "passed"
						)
							return result;
						const binding = input.build.binding;
						const base = join(config.stateDir, "pristine", input.runId);

						if (
							checkBuildDisk([
								input.workspace,
								join(config.stateDir, "stages", input.runId),
							]) !== null
						) {
							config.log("stage_inputs_refused", {
								runId: input.runId,
								why: "build_disk_limit",
							});
							publishFile(
								join(
									config.stateDir,
									"stages",
									input.runId,
									`build-${input.attempt}-failure.json`,
								),
								JSON.stringify({ reason: "build_disk_limit" }),
							);

							return stageResult({
								...result.receipt,
								outcome: { kind: "failed", exit: "crashed" },
							});
						}

						let kept = readPatch(config.stateDir, binding);

						if (kept.kind === "absent") {
							const collectionStart = Date.now();

							const cause =
								input.execution?.stage === "build"
									? input.execution.cause
									: null;

							const owner =
								cause?.kind === "feedback"
									? readFeedbackBatch(config.stateDir, input.runId, cause.batch)
									: null;

							const text = await attemptOutput(
								config.stateDir,
								input.runId,
								"build",
								input.attempt,
								input.round,
							);

							const dispositions =
								owner === null
									? undefined
									: builderDispositions(
											text === null || text instanceof Object ? "" : text,
											owner.batch.cards,
										);

							let findingDispositions:
								| ReturnType<typeof builderFindingDispositions>
								| undefined;

							if (owner !== null && input.execution?.stage === "build") {
								const from = input.execution.feedbackFrom;

								const path = join(
									reviewDir(
										config.stateDir,
										input.runId,
										from.round,
										from.generation,
									),
									"receipt.json",
								);

								const review = existsSync(path)
									? parseReviewReceipt(parseJson(regularText(path)))
									: null;

								findingDispositions = builderFindingDispositions(
									text === null || text instanceof Object ? "" : text,
									findingFingerprints(review ?? { seats: [] }),
								);
							}

							if ((input.round ?? 0) > 0) {
								rmSync(join(input.workspace, FEEDBACK_FILE), {
									force: true,
								});
								rmSync(join(input.workspace, FEEDBACK_FULL_FILE), {
									force: true,
								});
							}

							const patch = await collectPatch({
								base,
								workspace: input.workspace,
								allowNoChange: input.build.allowNoChange,
								repairTree: (input.round ?? 0) > 0,
							});

							if (patch.kind === "error") {
								config.log("patch_refused", {
									runId: input.runId,
									why: patch.reason,
								});

								return stageResult({
									...result.receipt,
									outcome: { kind: "failed", exit: "crashed" },
								});
							}

							config.log("patch_collected", {
								runId: input.runId,
								digest: patch.patchDigest,
								ms: Date.now() - collectionStart,
								paths: patch.changedPaths.length,
							});

							const commands = buildCommands(
								config.stateDir,
								input.runId,
								input.attempt,
								input.round,
							);

							if ((input.round ?? 0) > 0) {
								const previous = readRunPatch(
									config.stateDir,
									input.runId,
									input.execution?.stage === "build"
										? input.execution.feedbackFrom.round
										: input.round! - 1,
								);

								const reason =
									previous.kind !== "found"
										? "patch_missing"
										: previous.receipt.patchDigest === patch.patchDigest
											? "repair_no_change"
											: null;

								if (reason !== null) {
									const saved = publishFile(
										join(
											config.stateDir,
											"stages",
											input.runId,
											`${stageName("build", input.attempt, input.round)}-result.json`,
										),
										JSON.stringify({
											reason,
											dispositions,
											findingDispositions,
										}),
									);

									return saved
										? result
										: stageResult({
												...result.receipt,
												outcome: { kind: "failed", exit: "crashed" },
											});
								}
							}

							kept = storePatch(config.stateDir, binding, patch, {
								model:
									result.receipt.fallback?.requested ??
									result.receipt.models.requested,
								observed:
									result.receipt.fallback?.observed ??
									result.receipt.models.observed,
								commands,
								dispositions,
								findingDispositions,
								testCommand: baseTestCommand(base, input.build.command),
							});

							if (kept.kind === "blocked")
								config.log("patch_refused", {
									runId: input.runId,
									why: kept.reason,
								});
						}

						return result;
					})
					.finally(() => {
						if (input.stage !== "build") return;
						rmSync(input.workspace, { recursive: true, force: true });
						cleanupBuildAgents(
							config.stateDir,
							input.runId,
							input.attempt,
							input.round,
						);

						const kept = readRunPatch(
							config.stateDir,
							input.runId,
							input.round,
						);

						if (kept.kind !== "found" || kept.receipt.policy === "forbidden")
							cleanupBuildBase(config.stateDir, input.runId);
					}),
			};
		},
	};
}
