import { ACCEPTANCE_MAX_TOKENS } from "../../../src/contract/acceptance.ts";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import {
	cpSync,
	existsSync,
	mkdirSync,
	symlinkSync,
	readFileSync,
	statSync,
	writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { describe, it } from "node:test";
import { sandboxExecutor } from "../../../host/sandbox/executor.ts";
import type { JsonValue } from "../../../src/core/json.ts";
import type { FeedbackObservation } from "../../../src/candidate/feedback.ts";
import { readAttention } from "../../../src/views/attention.ts";
import { readViewerRun } from "../../../host/viewer/evidence.ts";
import {
	BUILD_MAX_TOKENS,
	collectPatch,
	storePatch,
	finishPatch,
} from "../../../src/candidate/build.ts";
import { fileLedgerOutbox } from "../../../host/controller/outbox.ts";
import { fileRunFiles } from "../../../host/controller/run-files.ts";
import {
	pinVerification,
	writeStatus,
} from "../../../host/controller/state.ts";
import {
	controllerCandidatePort,
	WORKFLOW_READ_LIMIT,
	observeFeedback,
	storeFeedbackBatch,
} from "../../../host/controller/candidate-port.ts";
import { readRunCharges } from "../../../host/controller/terminal.ts";
import { serveLoop } from "../../../host/controller/serve-loop.ts";
import { GitHubTicketAdapter } from "../../../src/github/adapter.ts";
import type { Exec } from "../../../src/github/exec.ts";
import { formatMarker, parseMarker } from "../../../src/trust/markers.ts";
import type {
	StageExecutor,
	StageLaunchInput,
	StageResult,
} from "../../../src/controller/launch.ts";
import {
	classifiedCase,
	passingVerdict,
	failingVerdict,
	qualifiedProof,
	storedAssessment,
	issuedReviewFixture,
} from "../../helpers.ts";
import {
	assessBase,
	parseBaseReceipt,
} from "../../../src/candidate/diagnosis.ts";
import { advance } from "../../../src/candidate/stages.ts";
import { AUTONOMY_DIGEST, contextPolicy } from "../../../src/ledger/schema.ts";
import { ledgerApiOf } from "../../../src/ledger/git.ts";
import { pumpLedger } from "../../../src/ledger/outbox.ts";
import {
	GitHubPublicationApi,
	storeOwnerPatch,
	readOwnerPatch,
	ownerPatchPath,
	PublicationError,
	candidateBranch,
} from "../../../src/github/publish.ts";
import { LedgerGit } from "../../ledger-git.ts";
import {
	assessmentBinding,
	dispatchNonce,
	readAssessmentBytes,
	validationDir,
} from "../../../src/candidate/validation.ts";
import {
	candidateProjection,
	candidateUsage,
	promotedHead,
	handoffCandidate,
} from "../../../src/candidate/handoff.ts";
import { parseCandidateState } from "../../../src/candidate/codec.ts";
import type { CandidateState } from "../../../src/candidate/state.ts";
import type { Run } from "../../../src/core/run.ts";
import {
	blocksReview,
	candidateReviewPrompt,
	JUDGMENT_OUTCOMES,
	ReviewEvidenceUnavailable,
	REVIEW_DIFF_MAX_BYTES,
	type JudgmentOutcome,
	type ReviewReceipt,
} from "../../../src/candidate/review.ts";
import {
	type Digest,
	digestOf,
	REPAIR_BUILD_MAX_TOKENS,
	REVIEW_MAX_TOKENS,
} from "../../../src/core/run.ts";
import {
	FAKE_REPO,
	fakeIssue,
	BOT_LOGIN,
	httpError,
	MAIN_SHA,
	networkError,
	TRUSTED_RUN_CAP,
	TRUSTED_WORKFLOW,
} from "../../fake-ticket-adapter.ts";
import { EXE_DEV_PLATFORM } from "../../../src/trust/platform.ts";
import {
	sha,
	repo,
	resultOf,
	ACCEPTANCE_TEXT,
	labeled,
	runOf,
	world,
	statuses,
	keepAdmissions,
	events,
	stateDir,
	settle,
	once,
	keyed,
	validationOf,
	reportOf,
	refusedReceipt,
	type HandoffSeen,
} from "./orchestrator-fixtures.ts";

describe("controller-only validate", () => {
	async function waitingRun(
		setup: (f: ReturnType<typeof world>) => void = () => {},
	) {
		const f = world();
		setup(f);
		f.github.add(labeled(14));
		f.executor.behaviors = [{ kind: "pass", usage: 10 }];
		f.executor.acceptBehavior = { kind: "pass", usage: 7 };
		f.executor.buildBehavior = { kind: "pass", usage: 12 };
		f.executor.validate = async (input) => {
			const state = input.state ?? {
				version: 2,
				generation: {
					index: input.generation?.generation ?? 0,
					digest: input.generation?.digest ?? digestOf("fixture"),
					previousHead: null,
				},
				startedAt: input.now,
				deadline: input.now + input.wallMs,
				round: 0,
				originalBase: input.baseSha,
				baseSha: input.baseSha,
				baseResolved: true,
				publication: {
					branch: `factory/run/14-${input.runId.slice(0, 12)}-r0`,
					patchSha: sha("b".repeat(40)),
					candidateSha: sha("c".repeat(40)),
				},
				dispatchTry: 1,
				dispatchedAt: input.now,
				ciRunId: 123,
				counters: {},
			};

			await input.save(state);

			return { kind: "waiting", state };
		};

		const controller = f.start();
		await once(controller);
		await once(controller);
		await controller.tick();
		assert.ok(validationOf(f.files.claims.get(runOf(14)))?.publication);

		return { ...f, controller };
	}

	async function reviewingRun(
		outcome?: JudgmentOutcome,
		setup?: (f: ReturnType<typeof world>) => void,
	) {
		const f = await waitingRun(setup);
		const contract = await f.files.readContract(runOf(14));
		assert.equal(contract.kind, "found");

		if (contract.kind !== "found") throw new Error("contract");

		const suite = await f.files.artifacts.read(
			runOf(14),
			contract.contract,
			contract.digest,
		);

		if (suite.kind !== "found") throw new Error("suite");

		const verdict = {
			...passingVerdict(digestOf("patch")),
			acceptanceDigest: suite.receipt.acceptanceDigest,
			originalBase: MAIN_SHA,
			baseSha: MAIN_SHA,
			gateSha: MAIN_SHA,
			unjudged: outcome === undefined ? [] : ["S2"],
		};

		const seats = ["code-review", "security-review", "simplify"].map(
			(seat) => ({
				seat,
				findings: [],
				judgments:
					seat === "code-review" && outcome !== undefined
						? [{ scenario: "S2", outcome, reason: "no live evidence" }]
						: [],
				requested: "openai/gpt-6.1-sol",
				observed: null,
				label: "context-isolated, same model, same family, not cross-family",
				fallback: false,
				tokens: 1,
			}),
		);

		f.executor.validate = async (input) => ({
			kind: "finished",
			state: input.state!,
			verdict,
			report: reportOf(verdict),
			assessment: f.executor.assess(input, verdict),
		});

		const receipt: ReviewReceipt = {
			version: 2,
			r8: "incomplete",
			runId: runOf(14),
			round: 0,
			candidateSha: verdict.candidateSha,
			patchDigest: verdict.patchDigest,
			contractDigest: contract.digest,
			acceptanceDigest: verdict.acceptanceDigest,
			ciRunId: verdict.ciRunId,
			originalBase: MAIN_SHA,
			baseSha: MAIN_SHA,
			seats,
			blocking: blocksReview(seats),
		};

		f.executor.prepareReview = async ({ workspace, execution }) => ({
			workspace,
			verdict,
			builder: "openai/gpt-6.1-sol",
			input: {
				binding: execution?.binding ?? receipt,
				seats: ["code-review", "security-review", "simplify"],
				files: new Map(),
				scenarios: [],
				prompt: "review",
			},
		});
		const output = f.executor.output.bind(f.executor);
		f.executor.output = async (input) =>
			input.stage === "review"
				? {
						kind: "review",
						receipt: {
							...receipt,
							...(input.execution?.stage === "review"
								? input.execution.binding
								: receipt),
						},
					}
				: output(input);
		f.executor.ready = false;
		await f.controller.tick();
		f.executor.ready = true;
		assert.equal(f.controller.state.runs.get(14)?.stage, "review");

		return f;
	}

	for (const recovery of [false, true])
		for (const fault of [
			"none",
			"notice_response",
			"terminal_claim",
			"programmer_enoent",
			"disk_eio",
		] as const)
			it(`terminates oversized review input without crashing the tick (recovery=${recovery}, fault=${fault})`, async () => {
				const outbox = fileLedgerOutbox(stateDir());

				const f = await reviewingRun(undefined, (ctx) => {
					Object.assign(ctx.files, { ledger: outbox });
				});

				const root = stateDir();
				const disk = fileRunFiles(root);
				const bound = await f.files.readContract(runOf(14));
				assert.ok(bound.kind === "found");
				const bytes = f.files.contracts.get(runOf(14))?.bytes;
				assert.ok(bytes);
				assert.ok(await disk.writeContract({ ...bound, bytes }));
				cpSync(
					join(f.files.artifactRoot, "acceptance"),
					join(root, "acceptance"),
					{ recursive: true },
				);
				const claim = f.files.claims.get(runOf(14));
				assert.ok(claim?.handoff?.kind === "selected");

				const base = join(root, "base"),
					work = join(root, "work");

				mkdirSync(join(base, ".github/factory"), { recursive: true });
				mkdirSync(join(base, "src"));
				writeFileSync(
					join(base, ".github/factory/WORKFLOW.md"),
					TRUSTED_WORKFLOW,
				);
				writeFileSync(join(base, "src/a.ts"), "export const value = 0;\n");
				cpSync(base, work, { recursive: true });
				writeFileSync(
					join(work, "src/a.ts"),
					`export const value = '${"é".repeat(REVIEW_DIFF_MAX_BYTES)}';\n`,
				);
				const patch = await collectPatch({ base, workspace: work });
				assert.ok(patch.kind === "collected");
				assert.ok(Buffer.byteLength(patch.patch) > REVIEW_DIFF_MAX_BYTES);

				const binding = {
					runId: runOf(14),
					baseSha: MAIN_SHA,
					contractDigest: bound.digest,
					acceptanceDigest: claim.handoff.pin.acceptanceDigest,
				};

				storePatch(root, binding, patch, {
					model: "openai/gpt-6.1-sol",
					observed: null,
					commands: [],
				});

				const kept = finishPatch(root, binding, {
					command: "test",
					exitCode: 0,
					tail: "",
					wallMs: 0,
				});

				assert.ok(kept.kind === "found");

				const verdict = {
					...passingVerdict(patch.patchDigest),
					originalBase: MAIN_SHA,
					baseSha: MAIN_SHA,
					gateSha: MAIN_SHA,
					acceptanceDigest: binding.acceptanceDigest,
				};

				const { book, execution } = issuedReviewFixture(
					claim.handoff.pin,
					kept.receipt,
					verdict,
				);

				const stored = {
					...claim,
					handoff: { ...book, priorTokens: claim.usage ?? 0 },
				};

				assert.ok(await disk.writeClaim(stored));
				f.files.claims.set(runOf(14), stored);
				let faulted = false;
				const write = f.files.writeClaim;

				f.files.writeClaim = async (next) => {
					if (
						fault === "terminal_claim" &&
						!faulted &&
						next.handoff?.kind === "selected" &&
						next.handoff.work.kind === "effect" &&
						next.handoff.work.request.kind === "finish_pr"
					) {
						faulted = true;

						return false;
					}

					return (await disk.writeClaim(next)) && write(next);
				};

				f.files.listClaims = disk.listClaims;
				f.github.beforeCall = (args) => {
					if (
						fault === "notice_response" &&
						!faulted &&
						args.some(
							(arg) =>
								arg.startsWith("body=") &&
								arg.includes("<!-- factory-review-input "),
						)
					) {
						faulted = true;
						f.github.posts = ["landed_unanswered"];
					}
				};

				const dir = validationDir(root, runOf(14), 0);
				mkdirSync(dir, { recursive: true });
				writeFileSync(join(dir, "verdict.json"), JSON.stringify(verdict), {
					mode: 0o600,
				});
				writeFileSync(
					join(dir, "receipt.json"),
					JSON.stringify({ modelCalls: 0, candidateSha: verdict.candidateSha }),
					{ mode: 0o600 },
				);

				const archive = execFileSync(
					"tar",
					["-czf", "-", "--transform=s,^,repo/,", ".github", "src"],
					{ cwd: base },
				);

				if (fault === "programmer_enoent")
					symlinkSync(join(root, "absent"), join(root, "review-base"));

				const native = sandboxExecutor({
					platform: EXE_DEV_PLATFORM,
					stateDir: root,
					exec: f.github.exec,
					log: () => {},
					xdgRuntimeDir: join(root, "xdg"),
					fetchTarball: async () => {
						if (fault === "disk_eio")
							throw Object.assign(new Error("checkout I/O error"), {
								code: "EIO",
							});

						return archive;
					},
				});

				f.files.workspacePath = disk.workspacePath;
				f.executor.prepareReview = native.prepareReview;
				f.executor.output = native.output;
				f.executor.spentBy.set("review-1", 0);
				const active = f.start();

				if (!recovery) {
					// Skip account recovery only in the fresh preparation case.
					f.executor.output = async () => ({ kind: "pending" });
				}

				const launches = f.executor.launches.length;

				if (fault === "programmer_enoent") {
					await assert.rejects(active.tick(), {
						code: "ENOENT",
						syscall: "mkdir",
					});
					assert.equal(f.executor.launches.length, launches);

					return;
				}

				await active.tick();

				if (fault === "disk_eio") {
					await f.start().tick();
					const held = f.files.claims.get(runOf(14))?.handoff;
					assert.ok(held?.kind === "selected" && held.work.kind === "held");
					assert.equal(held.work.reason, "evidence_unavailable");
					assert.equal(f.executor.launches.length, launches);

					return;
				}

				const resumed = fault === "none" ? active : f.start();
				await resumed.tick();
				const terminal = f.files.claims.get(runOf(14));
				assert.equal(terminal?.status, "failed");
				assert.ok(
					terminal?.handoff?.kind === "selected" &&
						terminal.handoff.work.kind === "terminal",
				);
				assert.deepEqual(terminal.handoff.work.terminal, {
					kind: "failed",
					reason: "review_input_too_large",
				});
				assert.ok(
					parseCandidateState(JSON.parse(JSON.stringify(terminal.handoff))),
				);
				assert.equal(f.executor.launches.length, launches);

				const notices = () =>
					f.github
						.markers(14)
						.filter((body) => body.includes("<!-- factory-review-input "));

				assert.equal(notices().length, 1);
				assert.match(
					notices()[0] ?? "",
					new RegExp(
						`${Buffer.byteLength(patch.patch)} bytes.*${REVIEW_DIFF_MAX_BYTES} bytes`,
					),
				);
				await f.start().tick();
				assert.equal(f.files.claims.get(runOf(14))?.status, "failed");
				assert.equal(f.executor.launches.length, launches);
				assert.equal(notices().length, 1);
				const row = (await outbox.scan())?.[0]?.row?.row;
				assert.ok(row?.v === 5);
				assert.equal(row.outcome.kind, "failed");
				assert.deepEqual(row.failure?.kind === "known" && row.failure.value, {
					stage: "review",
					class: "input",
					reason: "review_input_too_large",
					failedVisibleChecks: [],
					retainedPatch: null,
				});
				assert.equal(execution.attempt, 1);
				assert.equal(faulted, fault !== "none");
				f.github.add(labeled(15));
				f.executor.behaviors = [{ kind: "pass", usage: 1 }];
				await f.start().tick();
				assert.ok(
					f.executor.launches.some(
						(launch) =>
							launch.runId === runOf(15) && launch.stage === "specify",
					),
				);
				assert.equal(
					f.executor.launches.filter((launch) => launch.runId === runOf(14))
						.length,
					launches,
				);
			});

	for (const restart of [false, true])
		it(`holds unavailable review evidence on the same known-spend account (restart=${restart})`, async () => {
			const f = await reviewingRun();
			f.executor.spentBy.set("review-1", 10);
			let active = f.controller;

			if (restart) {
				f.executor.behaviors = [{ kind: "hang" }];
				await active.tick();
				f.executor.output = async () => {
					throw new ReviewEvidenceUnavailable("review capture unavailable");
				};

				active = f.start();
			} else
				f.executor.prepareReview = async () => {
					throw new ReviewEvidenceUnavailable("review capture unavailable");
				};

			f.executor.output = async () => {
				throw new ReviewEvidenceUnavailable("review capture unavailable");
			};

			const launches = f.executor.launches.length;
			await active.tick();
			await active.tick();
			const held = f.files.claims.get(runOf(14))?.handoff;
			assert.ok(held?.kind === "selected");
			assert.equal(held.work.kind, "held");
			assert.equal(held.work.reason, "evidence_unavailable");
			assert.equal(held.accounts.length, 1);
			assert.equal(held.accounts[0]?.execution.attempt, 1);
			assert.deepEqual(held.accounts[0]?.spend, { kind: "unknown", floor: 10 });
			assert.equal(f.files.claims.get(runOf(14))?.usage, 39);
			const stop = new AbortController();
			await serveLoop({
				platform: EXE_DEV_PLATFORM,
				orchestrator: active,
				stateDir: stateDir(),
				signal: stop.signal,
				log: () => {},
				sleep: async () => {
					stop.abort();
				},
			});
			await f.start().tick();
			assert.equal(f.executor.launches.length, launches);
			assert.deepEqual(
				f.files.claims.get(runOf(14))?.handoff?.accounts,
				held.accounts,
			);
		});

	for (const outcome of JUDGMENT_OUTCOMES)
		it(`hands off a ${outcome} review judgment only when it is pass`, async () => {
			const f = await reviewingRun(outcome);
			f.executor.behaviors = [{ kind: "pass", usage: 11 }];
			await once(f.controller);
			await f.controller.tick();
			const book = f.files.claims.get(runOf(14))?.handoff;
			assert.ok(book?.kind === "selected");

			if (outcome === "pass") {
				assert.equal(
					book.current.certification?.review.seats[0]?.judgments[0]?.outcome,
					"pass",
				);
				assert.equal(book.work.kind, "handoff");

				return;
			}

			assert.equal(book.current.certification, null);
			assert.equal(book.published, null);
			assert.ok(
				!(book.work.kind === "effect" && book.work.request.kind === "open_pr"),
			);
			assert.ok(
				book.work.kind === "rebuilding" &&
					book.work.execution.round === 1 &&
					book.work.execution.feedbackFrom.digest ===
						book.current.intent.digest,
				JSON.stringify(book.work),
			);
		});

	for (const reason of ["evidence_unavailable"])
		it(`holds a candidate effect's input refusal (${reason}) without crashing the tick`, async () => {
			const f = await reviewingRun();
			f.executor.behaviors = [{ kind: "pass", usage: 11 }];
			const port = f.executor.candidate;
			assert.ok(port);
			port.execute = async () => {
				throw new PublicationError(reason);
			};

			await once(f.controller);
			await f.controller.tick();
			const book = f.files.claims.get(runOf(14))?.handoff;
			assert.ok(book?.kind === "selected");
			assert.equal(book.work.kind, "held");
			assert.equal(book.work.reason, "evidence_unavailable");
			const launches = f.executor.launches.length;
			await f.start().tick();
			assert.equal(f.executor.launches.length, launches);
		});

	for (const target of ["open_pr", "complete_handoff"] as const)
		for (const reason of ["pr_identity", "pr_ambiguous"] as const)
			it(`retains an owner hold without retrying ${target} (${reason})`, async () => {
				const f = await reviewingRun();
				f.executor.behaviors = [{ kind: "pass", usage: 11 }];
				const port = f.executor.candidate;
				assert.ok(port);
				const execute = port.execute;
				let calls = 0;
				port.execute = async (state, request) => {
					if (request.kind !== target) return execute(state, request);
					calls++;
					throw new PublicationError(reason);
				};

				await once(f.controller);
				await f.controller.tick();
				await f.controller.tick();
				const book = f.files.claims.get(runOf(14))?.handoff;
				assert.ok(book?.kind === "selected" && book.work.kind === "held");
				assert.equal(book.work.reason, reason);
				assert.equal(
					book.published?.readiness.kind,
					target === "open_pr" ? undefined : "not_ready",
				);
				assert.equal(
					JSON.stringify(parseCandidateState(JSON.parse(JSON.stringify(book)))),
					JSON.stringify(book),
				);
				const launches = f.executor.launches.length;
				const restarted = f.start();
				await restarted.tick();
				await restarted.tick();
				assert.equal(
					JSON.stringify(f.files.claims.get(runOf(14))?.handoff),
					JSON.stringify(book),
				);
				assert.equal(calls, 1);
				assert.equal(f.executor.launches.length, launches);
			});

	for (const failure of ["transient", "digest_mismatch", "recovers"] as const)
		it(`bounds the pinned WORKFLOW.md read at handoff through the real port across restart (${failure})`, async () => {
			const f = await reviewingRun();
			f.executor.behaviors = [{ kind: "pass", usage: 11 }];
			const root = stateDir();
			const port = f.executor.candidate;
			assert.ok(port);
			const execute = port.execute;
			const trusted = f.github.workflow;
			assert.ok(trusted !== null);
			let reads = 0;
			let labels = 0;

			const seen: HandoffSeen = { pending: null };

			// Only the external GitHub responses are faked; the controller's own
			// candidate port reads, counts and holds.
			const exec: Exec = async (command, args) => {
				if (
					args.some((a) => a.includes("contents/.github/factory/WORKFLOW.md"))
				) {
					reads++;

					if (failure === "digest_mismatch")
						return { code: 0, stdout: `${trusted}\n`, stderr: "" };

					return failure === "recovers" && reads > 3
						? { code: 0, stdout: trusted, stderr: "" }
						: { code: 1, stdout: "", stderr: "HTTP 404: Not Found" };
				}

				assert.ok(seen.pending);
				const { state, head } = seen.pending;
				const branch = `factory/pr/14-${state.pin.runId.slice(0, 12)}`;

				if (args.some((a) => a.endsWith(`git/ref/heads/${branch}`)))
					return {
						code: 0,
						stdout: JSON.stringify({ object: { sha: head } }),
						stderr: "",
					};

				if (args.includes("GET") && args.some((a) => a.endsWith("/pulls/99")))
					return {
						code: 0,
						stdout: JSON.stringify({
							number: 99,
							head: { sha: head, ref: branch, repo: { full_name: repo } },
							base: { ref: "main", repo: { full_name: repo } },
							user: { login: BOT_LOGIN, type: "Bot" },
							body: `<!-- factory:pr ${state.pin.runId} -->`,
							state: "open",
							merged: false,
							draft: false,
							requested_reviewers: [{ login: "giuseppecrj" }],
						}),
						stderr: "",
					};

				if (
					args.includes("POST") &&
					args.some((a) => a.endsWith("issues/99/labels"))
				) {
					labels++;

					return { code: 0, stdout: '["factory:review"]', stderr: "" };
				}

				return f.github.exec(command, args);
			};

			const real = () =>
				controllerCandidatePort({
					platform: EXE_DEV_PLATFORM,
					stateDir: root,
					exec,
					log: (event, fields) => f.logs.push({ event, fields }),
				});

			let handoff = real();

			port.execute = async (state, request) => {
				if (request.kind !== "complete_handoff") return execute(state, request);
				seen.pending = { state, head: request.head };

				return handoff.execute(state, request);
			};

			const book = () => {
				const saved = f.files.claims.get(runOf(14))?.handoff;
				assert.ok(saved?.kind === "selected");

				return saved;
			};

			const unavailable = () =>
				f.logs.filter((l) => l.event === "handoff_workflow_unavailable");

			const counter = join(root, "handoff", runOf(14), "workflow-read.json");

			await once(f.controller);
			let controller = f.controller;
			const restartAt = failure === "transient" ? 4 : 1;

			// The count survives a restart: a fresh port and controller resume it.
			for (let tick = 0; tick < 40 && reads < restartAt; tick++) {
				f.clock.t += 30_000;
				await controller.tick();
			}

			assert.equal(reads, restartAt);
			handoff = real();
			controller = f.start();

			if (failure === "recovers") {
				// An existing handoff comment stands in for the private contract
				// evidence a fresh comment would render.
				const issue = f.github.issues.get(14);
				assert.ok(issue && seen.pending);
				const { state, head } = seen.pending;
				f.github.comment(
					issue,
					`handoff\n<!-- factory:handoff ${state.pin.runId} ${head} -->`,
				);
			}

			for (
				let tick = 0;
				tick < 40 &&
				book().work.kind !== "held" &&
				f.files.claims.get(runOf(14))?.status !== "waiting";
				tick++
			) {
				f.clock.t += 30_000;
				await controller.tick();
			}

			if (failure === "recovers") {
				assert.equal(reads, 4);
				assert.equal(unavailable().length, 3);
				assert.equal(f.files.claims.get(runOf(14))?.status, "waiting");
				assert.equal(labels, 1);
				assert.equal(existsSync(counter), false);
				assert.equal(
					f.logs.some((l) => l.event === "candidate_effect_held"),
					false,
				);

				return;
			}

			const bound = failure === "transient" ? WORKFLOW_READ_LIMIT : 1;
			assert.equal(WORKFLOW_READ_LIMIT, 10);
			assert.equal(reads, bound);
			const held = book();
			assert.ok(held.work.kind === "held");
			assert.equal(held.work.reason, "workflow_unavailable");
			assert.deepEqual(held.published?.readiness, {
				kind: "not_ready",
				reason: "workflow_unavailable",
				since: held.work.since,
			});
			assert.deepEqual(
				unavailable().map((l) => [
					l.fields.issue,
					l.fields.runId,
					l.fields.workflowSha,
					l.fields.reason,
					l.fields.failures,
					l.fields.held,
				]),
				Array.from({ length: bound }, (_, index) => [
					14,
					runOf(14),
					held.pin.workflowSha,
					failure === "transient" ? "read_failed" : "digest_mismatch",
					index + 1,
					index + 1 === bound,
				]),
			);
			assert.deepEqual(
				f.logs
					.filter((l) => l.event === "candidate_effect_held")
					.map((l) => l.fields.reason),
				["workflow_unavailable"],
			);
			assert.equal(
				JSON.stringify(parseCandidateState(JSON.parse(JSON.stringify(held)))),
				JSON.stringify(held),
			);

			// The hold is sticky across another restart: no read, no label.
			handoff = real();
			const restarted = f.start();

			for (let tick = 0; tick < 5; tick++) {
				f.clock.t += 30_000;
				await restarted.tick();
			}

			assert.equal(reads, bound);
			assert.equal(labels, 0);
			assert.equal(JSON.stringify(book()), JSON.stringify(held));
		});

	for (const target of ["open_pr", "complete_handoff"] as const)
		for (const fault of ["none", "notice_response", "terminal_claim"] as const)
			it(`ends a summary refusal at ${target} once across restart (${fault})`, async () => {
				const outbox = fileLedgerOutbox(stateDir());

				const f = await reviewingRun(undefined, (ctx) => {
					Object.assign(ctx.files, { ledger: outbox });
				});

				f.executor.behaviors = [{ kind: "pass", usage: 11 }];
				const port = f.executor.candidate;
				assert.ok(port);
				const execute = port.execute;
				let calls = 0;
				port.execute = async (state, request) => {
					if (request.kind !== target) return execute(state, request);
					calls++;
					throw new PublicationError("summary_too_large");
				};

				let faulted = false;
				const write = f.files.writeClaim;
				f.files.writeClaim = async (next) => {
					if (
						fault === "terminal_claim" &&
						!faulted &&
						next.handoff?.kind === "selected" &&
						((next.handoff.work.kind === "effect" &&
							next.handoff.work.request.kind === "finish_pr") ||
							(target === "complete_handoff" &&
								next.handoff.work.kind === "held" &&
								next.handoff.work.reason === "summary_too_large"))
					) {
						faulted = true;

						return false;
					}

					return write(next);
				};

				f.github.beforeCall = (args) => {
					if (
						fault === "notice_response" &&
						!faulted &&
						args.some(
							(arg) =>
								arg.startsWith("body=") &&
								arg.includes("<!-- factory-handoff-input "),
						)
					) {
						faulted = true;
						f.github.posts = ["landed_unanswered"];
					}
				};

				await once(f.controller);
				await f.controller.tick();
				await f.start().tick();
				await f.start().tick();
				const terminal = f.files.claims.get(runOf(14));
				assert.equal(
					terminal?.status,
					target === "open_pr" ? "failed" : "blocked",
				);
				assert.ok(terminal?.handoff?.kind === "selected");

				if (target === "open_pr") {
					assert.ok(terminal.handoff.work.kind === "terminal");
					assert.deepEqual(terminal.handoff.work.terminal, {
						kind: "failed",
						reason: "summary_too_large",
					});
				} else {
					assert.partialDeepStrictEqual(terminal.handoff.work, {
						kind: "held",
						reason: "summary_too_large",
					});
					assert.ok(f.controller.state.runs.has(14));
					assert.partialDeepStrictEqual(terminal.handoff.published?.readiness, {
						kind: "not_ready",
						reason: "summary_too_large",
					});
				}

				assert.ok(
					parseCandidateState(JSON.parse(JSON.stringify(terminal.handoff))),
				);
				assert.equal(keyed(f.github, 14, "handoff-input").length, 1);
				assert.match(
					keyed(f.github, 14, "handoff-input")[0] ?? "",
					/summary_too_large/,
				);
				const row = (await outbox.scan())?.[0]?.row?.row;

				if (target === "open_pr") {
					assert.ok(row?.v === 5);
					assert.equal(row.outcome.kind, "failed");
					assert.deepEqual(row.failure?.kind === "known" && row.failure.value, {
						stage: "land",
						class: "input",
						reason: "summary_too_large",
						failedVisibleChecks: [],
						retainedPatch: null,
					});
				} else assert.equal(row, undefined);
				assert.equal(faulted, fault !== "none");
				const launches = f.executor.launches.length;
				const attempts = calls;
				await f.start().tick();
				assert.equal(calls, attempts);
				assert.equal(f.executor.launches.length, launches);
			});

	it("keeps programming errors in review preparation visible", async () => {
		const f = await reviewingRun();
		f.executor.prepareReview = async () => {
			throw new TypeError("programming defect");
		};

		await assert.rejects(f.controller.tick(), {
			name: "TypeError",
			message: "programming defect",
		});
	});

	for (const window of ["create", "comment"] as const)
		it(`retires only a newly created ${window} intent when its second gate is off`, async () => {
			const f = await reviewingRun();
			const seedPort = f.executor.candidate;
			assert.ok(seedPort);
			const execute = seedPort.execute;
			seedPort.execute = async (state, request) =>
				request.kind === "open_pr" ? null : execute(state, request);
			f.executor.behaviors = [{ kind: "pass", usage: 11 }];
			await once(f.controller);
			await f.controller.tick();
			const claim = f.files.claims.get(runOf(14));
			assert.ok(
				claim?.handoff?.kind === "selected" &&
					claim.handoff.work.kind === "effect" &&
					claim.handoff.work.request.kind === "open_pr",
			);
			let book = claim.handoff;
			const root = stateDir();
			const files = fileRunFiles(root);
			const contract = await f.files.readContract(runOf(14));
			assert.ok(contract.kind === "found");
			const stored = f.files.contracts.get(runOf(14));
			assert.ok(stored);
			assert.equal(
				await files.writeContract({
					contract: contract.contract,
					bytes: stored.bytes,
					digest: contract.digest,
				}),
				true,
			);
			cpSync(
				join(f.files.artifactRoot, "acceptance"),
				join(root, "acceptance"),
				{
					recursive: true,
				},
			);
			const opening = claim.handoff.work.request;
			const branch = opening.branch;
			const head = opening.head;

			let pr = false,
				enabled = true,
				reads = 0,
				disableAt = 0,
				creates = 0,
				comments = 0;

			const ok = (value: import("../../../src/core/json.ts").JsonValue) => ({
				code: 0,
				stdout: JSON.stringify(value),
				stderr: "",
			});

			const exec: Exec = async (command, args) => {
				const path = args
					.find((a) => a.startsWith(`repos/${repo}/`))
					?.slice(`repos/${repo}/`.length);

				const method = args[args.indexOf("--method") + 1];

				if (path === "labels/factory%3Aenabled") {
					if (++reads === disableAt) enabled = false;

					return enabled ? ok({ name: "factory:enabled" }) : httpError(404);
				}

				if (path?.startsWith("pulls?")) return ok(pr ? [{ number: 99 }] : []);

				if (path === "pulls/99")
					return ok({
						number: 99,
						head: { sha: head, ref: branch, repo: { full_name: repo } },
						base: { ref: "main", repo: { full_name: repo } },
						user: { login: BOT_LOGIN, type: "Bot" },
						body: `<!-- factory:pr ${runOf(14)} -->`,
						state: "open",
						merged: false,
						draft: false,
						// The trusted WORKFLOW.md's handoff.reviewers, already requested.
						requested_reviewers: [{ login: "giuseppecrj" }],
					});

				if (path === `git/ref/heads/${branch}`)
					return ok({ object: { sha: head } });

				if (path === "pulls" && method === "POST") {
					creates++;
					pr = true;

					return ok({});
				}

				if (path === "issues/99/labels")
					return ok([{ name: "factory:review" }]);

				if (path?.startsWith("issues/14/comments") && method === "GET")
					return ok([]);

				if (path === "issues/14/comments" && method === "POST") {
					comments++;

					return ok({ id: 900 });
				}

				return f.github.exec(command, args);
			};

			let port = controllerCandidatePort({
				platform: EXE_DEV_PLATFORM,
				stateDir: root,
				exec,
			});

			if (window === "comment") {
				const opened = await port.execute(book, opening);
				assert.ok(opened?.kind === "open_pr");

				const adopted = handoffCandidate(book, {
					kind: "effect_completed",
					completion: opened,
				}).state;

				assert.ok(adopted.kind === "selected");
				const report = adopted.current.report;
				assert.ok(report);

				const completing = handoffCandidate(adopted, {
					kind: "observed",
					now: 100,
					main: adopted.current.intent.baseSha,
					pr: { kind: "open", number: 99, head, refHead: head },
					executionAllowed: true,
					capacityAvailable: true,
					eligibility: "ready",
					readiness: { kind: "current", head, report },
				}).state;

				assert.ok(completing.kind === "selected");
				book = completing;
			}

			reads = 0;
			disableAt = window === "create" ? 2 : 3;
			assert.ok(
				book.work.kind === "effect" &&
					(book.work.request.kind === "open_pr" ||
						book.work.request.kind === "complete_handoff"),
			);
			const request = book.work.request;
			assert.equal(await port.execute(book, request), null);
			assert.equal(window === "create" ? creates : comments, 0);

			const intent = join(
				root,
				"handoff",
				runOf(14),
				window === "create" ? "create.json" : `comment-${head}.json`,
			);

			assert.equal(existsSync(intent), false);
			enabled = true;
			disableAt = 0;
			port = controllerCandidatePort({
				platform: EXE_DEV_PLATFORM,
				stateDir: root,
				exec,
			});
			const completed = await port.execute(book, request);
			assert.equal(
				completed?.kind,
				window === "create" ? "open_pr" : "complete_handoff",
			);
			assert.equal(window === "create" ? creates : comments, 1);
		});

	it("F10-3 N1 reset after a failed repair never reuses spent rounds or their controller artifacts", async () => {
		const f = await reviewingRun();
		f.executor.behaviors = [{ kind: "pass", usage: 11 }];
		await once(f.controller);
		await f.controller.tick();
		await f.controller.tick();
		const initial = f.files.claims.get(runOf(14))?.handoff;
		const port = f.executor.candidate;
		assert.ok(initial?.kind === "selected" && initial.published && port);
		const root = stateDir();

		const native = controllerCandidatePort({
			platform: EXE_DEV_PLATFORM,
			stateDir: root,
			exec: f.github.exec,
		});

		const pr = f.github.add(fakeIssue(99, { pullRequest: true }));
		const factoryHead = initial.current.report!.candidateSha;
		let head = factoryHead;
		let feedback: FeedbackObservation = { kind: "unavailable" };
		const observe = port.observe;
		port.observe = async (state, now) => ({
			...(await observe(state, now)),
			pr: { kind: "open", number: 99, head, refHead: head },
			readiness:
				head === factoryHead
					? { kind: "current", head, report: initial.current.report! }
					: { kind: "unavailable" },
			feedback,
		});
		const execute = port.execute;
		port.execute = async (state, request) => {
			if (request.kind === "post_notice") return native.execute(state, request);

			if (request.kind === "derive_owner_patch")
				return {
					kind: "derive_owner_patch",
					request,
					result: {
						kind: "found",
						patch: {
							version: 1,
							kind: "owner",
							runId: state.pin.runId,
							head: request.head,
							baseSha: request.baseSha,
							contractDigest: state.pin.contractDigest,
							acceptanceDigest: state.pin.acceptanceDigest,
							heldoutDigest: initial.current.verdict!.heldoutDigest,
							patchDigest: digestOf("owner patch"),
							changedPaths: ["src/example.ts"],
							policy: "clean",
						},
					},
				};

			return execute(state, request);
		};

		port.patch = native.patch;

		const batches = new Map<
			string,
			import("../../../src/candidate/feedback.ts").FeedbackBatch
		>();

		Object.assign(f.executor, {
			readFeedback: async (_run: Digest, digest: Digest) =>
				batches.get(digest) ?? null,
		});
		const output = f.executor.output.bind(f.executor);
		f.executor.output = async (input) => {
			const built = await output(input);

			if (
				input.stage !== "build" ||
				!(built instanceof Object) ||
				built.kind !== "build" ||
				built.result.kind !== "found"
			)
				return built;

			const binding = {
				runId: initial.pin.runId,
				round: input.round,
				baseSha: initial.pin.originalBase,
				contractDigest: initial.pin.contractDigest,
				acceptanceDigest: initial.pin.acceptanceDigest,
			};

			const stored = storePatch(
				root,
				binding,
				{
					kind: "collected",
					patch: built.result.patch,
					patchDigest: built.result.receipt.patchDigest,
					changedPaths: built.result.receipt.changedPaths,
					policy: "clean",
				},
				{ model: built.result.receipt.model, observed: null, commands: [] },
			);

			assert.ok(stored.kind === "found");
			assert.equal(
				digestOf(stored.patch),
				digestOf(built.result.patch),
				"paid-for builder output must not be replaced by an older round",
			);

			return {
				kind: "build",
				result: finishPatch(root, binding, built.result.receipt.visibleTests!),
			};
		};

		const validationKeys: string[] = [];
		f.executor.validate = async (input) => {
			assert.ok(input.generation);
			const generation = input.generation;

			const branch = candidateBranch(
				14,
				input.runId,
				generation.round,
				generation.generation,
			);

			const candidateSha =
				generation.origin.kind === "owner"
					? generation.origin.head
					: sha(digestOf(branch).slice(0, 40));

			const state = {
				...initial.current.validation!,
				round: generation.round,
				generation: {
					index: generation.generation,
					digest: generation.digest,
					previousHead: factoryHead,
				},
				publication: { branch, patchSha: candidateSha, candidateSha },
			};

			await input.save(state);

			const verdict = {
				...initial.current.verdict!,
				candidateSha,
				pass: false,
				patchDigest: input.generation.patchDigest,
				checks: initial.current.verdict!.checks.map((c) => ({
					...c,
					passed: c.name !== "heldout",
				})),
			};

			const nonce = dispatchNonce(
				input.runId,
				generation.round,
				1,
				generation.generation,
			);

			validationKeys.push(nonce);

			return {
				kind: "finished",
				state,
				verdict,
				report: {
					...reportOf(verdict),
					nonce,
					externalId: `factory-gates:123:${nonce}`,
				},
				assessment: f.executor.assess(input, verdict),
			};
		};

		f.executor.ownerValidate = f.executor.validate;

		const book = () => {
			const state = f.files.claims.get(runOf(14))?.handoff;
			assert.ok(state?.kind === "selected");
			assert.ok(
				parseCandidateState(JSON.parse(JSON.stringify(state))),
				"saved book must load",
			);

			return state;
		};

		let controller = f.controller;

		const until = async (done: () => boolean) => {
			for (let tick = 0; tick < 20 && !done(); tick++) await once(controller);
			assert.ok(
				done(),
				JSON.stringify({
					work: book().work,
					current: book().current.intent,
					logs: f.logs.filter((l) => l.event !== "tick").slice(-4),
				}),
			);
		};

		const requestChanges = async (id: number) => {
			const event = `github:${repo}:review:${id}` as const;

			const batch = {
				version: 1,
				runId: initial.pin.runId,
				pr: 99,
				head: factoryHead,
				records: [
					{
						event,
						actor: "writer",
						intake: { kind: "actionable" },
						inline: [],
					},
				],
				cards: [
					{
						event,
						head: factoryHead,
						path: null,
						line: null,
						excerpt: "fix it",
						truncated: false,
					},
				],
				full: null,
			} as const;

			const stored = await storeFeedbackBatch(root, batch, null);
			batches.set(stored.digest, batch);
			feedback = {
				kind: "read",
				head: factoryHead,
				dismissed: [],
				batch: stored,
			};
		};

		const failedRound = async (round: number) => {
			await until(
				() =>
					book().work.kind === "held" && book().current.intent.round === round,
			);
			assert.equal(book().current.intent.round, round);
			const state = book();
			const patch = await native.patch(state, round);
			assert.ok(patch && !("kind" in patch.receipt));
			assert.equal(patch.receipt.patchDigest, state.current.intent.patchDigest);

			return state;
		};

		await requestChanges(701);
		const first = await failedRound(1);
		const firstUsage = candidateUsage(first);
		head = sha("b".repeat(40));
		feedback = { kind: "unavailable" };
		await until(
			() =>
				book().work.kind === "held" &&
				book().current.intent.origin.kind === "owner",
		);
		assert.equal(
			f.executor.launches.filter(
				(l) => l.stage === "build" && (l.round ?? 0) > 0,
			).length,
			1,
		);
		head = factoryHead;
		await until(() => book().published?.readiness.kind === "ready");
		assert.equal(book().current.intent.digest, initial.current.intent.digest);
		assert.equal(candidateUsage(book()), firstUsage);
		controller = f.start();
		await requestChanges(702);
		await until(
			() =>
				f.executor.launches.filter(
					(l) => l.stage === "build" && (l.round ?? 0) > 0,
				).length === 2,
		);

		const launches = f.executor.launches.filter(
			(l) => l.stage === "build" && (l.round ?? 0) > 0,
		);

		assert.deepEqual(
			launches.map((l) => [l.round, l.attempt]),
			[
				[1, 1],
				[2, 1],
			],
		);
		const second = await failedRound(2);
		assert.notEqual(second.current.intent.digest, first.current.intent.digest);
		assert.notEqual(
			second.current.validation!.publication!.branch,
			first.current.validation!.publication!.branch,
		);
		assert.equal(new Set(validationKeys).size, validationKeys.length);
		assert.deepEqual(
			pr.comments.map((c) => c.body.match(/round_summary [12]/)?.[0]),
			["round_summary 1", "round_summary 2"],
		);
		assert.ok(
			existsSync(
				join(root, "handoff", initial.pin.runId, "feedback", "round-1-a1.json"),
			),
		);
		assert.ok(
			existsSync(
				join(root, "handoff", initial.pin.runId, "feedback", "round-2-a1.json"),
			),
		);
		head = sha("d".repeat(40));
		feedback = { kind: "unavailable" };
		await until(
			() =>
				book().work.kind === "held" &&
				book().current.intent.origin.kind === "owner",
		);
		head = factoryHead;
		await until(() => book().published?.readiness.kind === "ready");
		const usage = candidateUsage(book());
		await requestChanges(703);
		await until(
			() =>
				book().feedback?.batches.length === 3 &&
				book().feedback?.batches.at(-1)?.status.kind === "settled",
		);
		assert.partialDeepStrictEqual(book().feedback?.batches.at(-1)?.status, {
			kind: "settled",
			outcome: { kind: "refused", reason: "cap_reached" },
		});
		await once(controller);
		assert.ok(
			f.github
				.markers(14)
				.some((body) => body.includes("No repair starts: cap_reached")),
		);
		assert.equal(candidateUsage(book()), usage);
		assert.equal(
			f.executor.launches.filter(
				(l) => l.stage === "build" && (l.round ?? 0) > 0,
			).length,
			2,
		);
	});

	for (const reason of ["behind_main", "unreadable"] as const)
		it(`F10-3 posts and logs ${reason} before holding when main moved`, async () => {
			const f = await reviewingRun();
			f.executor.behaviors = [{ kind: "pass", usage: 11 }];
			await once(f.controller);
			await f.controller.tick();
			await f.controller.tick();
			const initial = f.files.claims.get(runOf(14))?.handoff;
			const port = f.executor.candidate;
			assert.ok(initial?.kind === "selected" && initial.published && port);
			const head = sha("b".repeat(40));
			const main = sha("d".repeat(40));
			assert.notEqual(main, initial.current.intent.baseSha);
			const observe = port.observe;
			port.observe = async (state, now) => ({
				...(await observe(state, now)),
				main,
				pr: { kind: "open", number: 99, head, refHead: head },
				readiness: { kind: "unavailable" },
			});

			const root = stateDir();

			const pr = f.github.add(
				fakeIssue(99, { pullRequest: true, labels: ["factory:review"] }),
			);

			const native = controllerCandidatePort({
				platform: EXE_DEV_PLATFORM,
				stateDir: root,
				exec: async (command, args) => {
					if (
						args.includes("DELETE") &&
						args.includes(`repos/${repo}/issues/99/labels/factory%3Areview`)
					) {
						pr.labels = pr.labels.filter((label) => label !== "factory:review");

						return { code: 0, stdout: "", stderr: "" };
					}

					return f.github.exec(command, args);
				},
			});

			const execute = port.execute;
			let derivations = 0;
			port.execute = async (state, request) => {
				if (request.kind === "post_notice")
					return native.execute(state, request);

				if (request.kind !== "derive_owner_patch")
					return execute(state, request);
				derivations++;
				assert.equal(request.baseSha, main);

				return {
					kind: "derive_owner_patch",
					request,
					result: { kind: "refused", reason },
				};
			};

			const launches = f.executor.launches.length;
			const restarted = f.start();

			for (let tick = 0; tick < 8; tick++) await restarted.tick();

			const stopped = f.files.claims.get(runOf(14))?.handoff;
			assert.ok(stopped?.kind === "selected" && stopped.work.kind === "held");
			assert.equal(stopped.work.reason, "owner_head_refused");
			assert.partialDeepStrictEqual(stopped.published?.readiness, {
				kind: "not_ready",
				reason: "owner_head_refused",
			});

			const notices = f.github.issues
				.get(14)!
				.comments.filter((c) =>
					c.body.includes(`owner_head_refused (${reason})`),
				);

			assert.equal(notices.length, 1);
			assert.ok(notices[0]!.body.includes(`Head: ${head}`));
			assert.ok(!pr.labels.includes("factory:review"));
			assert.equal(derivations, reason === "unreadable" ? 3 : 1);
			assert.equal(f.executor.launches.length, launches);
			assert.deepEqual(
				f.logs
					.filter((l) => l.event === "owner_derive_result")
					.map((l) => l.fields),
				Array.from({ length: derivations }, () => ({
					runId: runOf(14),
					head,
					baseSha: main,
					result: "refused",
					reason,
				})),
			);
			await f.start().tick();
			assert.deepEqual(f.files.claims.get(runOf(14))?.handoff, stopped);
			assert.equal(derivations, reason === "unreadable" ? 3 : 1);
		});

	it("F10-3 crashes after the C8 owner file write, adopts it after restart and settles owner review without a build (review R8)", async () => {
		const f = await reviewingRun();
		f.executor.behaviors = [{ kind: "pass", usage: 11 }];
		await once(f.controller);
		await f.controller.tick();
		await f.controller.tick();
		const initial = f.files.claims.get(runOf(14))?.handoff;
		const port = f.executor.candidate;
		assert.ok(initial?.kind === "selected" && initial.published && port);
		const head = sha("b".repeat(40));
		const observe = port.observe;
		port.observe = async (state, now) => ({
			...(await observe(state, now)),
			pr: {
				kind: "open",
				number: initial.published!.number,
				head,
				refHead: head,
			},
		});
		const execute = port.execute;
		const root = stateDir();
		let attempts = 0;
		let patchReads = 0;

		const ownerPort = controllerCandidatePort({
			platform: EXE_DEV_PLATFORM,
			stateDir: root,
			exec: f.github.exec,
		});

		port.patch = async (state, round) => {
			patchReads++;

			return ownerPort.patch(state, round);
		};

		port.execute = async (state, request) => {
			if (request.kind === "post_notice")
				return { kind: "post_notice", request };

			if (request.kind !== "derive_owner_patch") return execute(state, request);
			attempts++;

			if (attempts === 1) {
				storeOwnerPatch(
					root,
					{
						version: 1,
						kind: "owner",
						runId: state.pin.runId,
						head,
						baseSha: request.baseSha,
						contractDigest: state.pin.contractDigest,
						acceptanceDigest: state.pin.acceptanceDigest,
						heldoutDigest: initial.current.verdict!.heldoutDigest,
						patchDigest: digestOf("owner"),
						changedPaths: ["src/example.ts"],
						policy: "clean",
					},
					"owner",
				);

				throw new Error(
					"C8 crash after durable owner file, before book completion",
				);
			}

			const stored = readOwnerPatch(
				root,
				state.pin.runId,
				head,
				request.baseSha,
			);

			assert.ok(stored);

			return {
				kind: "derive_owner_patch",
				request,
				result: { kind: "found", patch: stored.receipt },
			};
		};

		let ownerCalls = 0;

		const verdict = {
			...initial.current.verdict!,
			candidateSha: head,
			patchDigest: digestOf("owner"),
		};

		f.executor.ownerValidate = async (input) => {
			ownerCalls++;
			assert.equal(input.generation?.origin.kind, "owner");

			const state = {
				...initial.current.validation!,
				publication: {
					branch: `factory/run/14-${input.runId.slice(0, 12)}-r0-g1`,
					patchSha: head,
					candidateSha: head,
				},
			};

			await input.save(state);

			return {
				kind: "finished",
				state,
				verdict,
				report: reportOf(verdict),
				assessment: f.executor.assess(input, verdict),
			};
		};

		f.executor.prepareReview = async ({ workspace, execution }) => ({
			workspace,
			verdict,
			builder: "unavailable",
			input: {
				binding: execution!.binding,
				seats: ["code-review", "security-review", "simplify"],
				files: new Map(),
				scenarios: [],
				prompt: "review owner",
			},
		});
		f.executor.output = async ({ execution }) => {
			assert.ok(execution?.stage === "review");

			return {
				kind: "review",
				receipt: {
					...initial.current.certification!.review,
					...execution.binding,
					version: 3,
					builder: { kind: "unavailable", reason: "missing" },
					accept: { kind: "unavailable", reason: "missing" },
					seats: initial.current.certification!.review.seats.map((s) => ({
						...s,
						family: { kind: "unavailable", reason: "missing" },
						label: "context-isolated, unknown family, not cross-family",
					})),
				},
			};
		};

		f.executor.behaviors = [{ kind: "pass", usage: 19 }];

		f.executor.validate = async () => {
			throw new Error("factory validator reached");
		};

		const launches = f.executor.launches.length;

		await assert.rejects(async () => {
			for (let tick = 0; tick < 8 && attempts === 0; tick++)
				await f.controller.tick();
		}, /C8 crash/);
		assert.equal(attempts, 1);
		assert.ok(
			existsSync(
				ownerPatchPath(
					root,
					initial.pin.runId,
					head,
					initial.current.intent.baseSha,
				),
			),
		);
		const saved = f.files.claims.get(runOf(14))?.handoff;
		assert.ok(
			saved?.kind === "selected" &&
				saved.work.kind === "effect" &&
				saved.work.request.kind === "derive_owner_patch",
		);
		const restarted = f.start();

		for (let tick = 0; tick < 8 && ownerCalls === 0; tick++)
			await restarted.tick();
		assert.equal(ownerCalls, 1);
		assert.equal(attempts, 2);
		assert.deepEqual(
			f.logs
				.filter((l) => l.event === "owner_derive_result")
				.map((l) => l.fields),
			[
				{
					runId: runOf(14),
					head,
					baseSha: initial.current.intent.baseSha,
					result: "found",
					reason: null,
				},
			],
		);
		assert.equal(f.executor.launches.length, launches);

		for (let tick = 0; tick < 12; tick++) {
			await restarted.tick();
			await new Promise((resolve) => setImmediate(resolve));
		}

		const completed = f.files.claims.get(runOf(14))?.handoff;
		assert.ok(completed?.kind === "selected");
		assert.ok(completed.current.certification);
		assert.equal(completed.current.intent.origin.kind, "owner");
		assert.equal(completed.published?.readiness.kind, "ready");
		assert.equal(patchReads, 1);
		assert.equal(f.executor.launches.length, launches + 1);
		assert.equal(f.executor.launches.at(-1)?.stage, "review");
	});

	for (const restart of [false, true])
		it(`passes the admitted workflow pin to review preparation and output (restart=${restart})`, async () => {
			const f = await reviewingRun();

			const preparations: Parameters<
				NonNullable<StageExecutor["prepareReview"]>
			>[0][] = [];

			const outputs: Parameters<StageExecutor["output"]>[0][] = [];
			const prepare = f.executor.prepareReview;

			if (prepare === undefined) throw new Error("review preparation");
			f.executor.prepareReview = async (input) => {
				preparations.push(input);

				return prepare(input);
			};

			const output = f.executor.output.bind(f.executor);
			f.executor.output = async (input) => {
				if (input.stage === "review") outputs.push(input);

				return output(input);
			};

			f.github.workflow = `${TRUSTED_WORKFLOW}\nChanged after admission.\n`;
			f.executor.behaviors = [{ kind: restart ? "hang" : "pass", usage: 11 }];

			let active = f.controller;

			if (restart) {
				await f.controller.tick();
				assert.equal(f.files.claims.get(runOf(14))?.status, "running");
				f.executor.spentBy.set("review-1", 0);
				active = f.start();
				await once(active);
			} else await once(active);
			await active.tick();
			await active.tick();
			assert.equal(preparations.length, 1);
			assert.ok(outputs.length > 0);

			for (const input of [...preparations, ...outputs]) {
				assert.ok("workflowSha" in input && "workflowDigest" in input);
				assert.equal(input.workflowSha, MAIN_SHA);
				assert.equal(input.workflowDigest, digestOf(TRUSTED_WORKFLOW));
				assert.notEqual(input.workflowDigest, digestOf(f.github.workflow));
			}

			assert.equal(f.files.claims.get(runOf(14))?.status, "waiting");
			assert.equal(f.files.claims.get(runOf(14))?.stage, "land");
		});

	for (const limit of [1, 2, 3, 5])
		it(`bounds review entry without narrowing global retries (${limit})`, async () => {
			const f = world();

			const workflow = TRUSTED_WORKFLOW.replace(
				"max_attempts: 3",
				`max_attempts: ${limit}`,
			);

			f.github.workflow = workflow;
			f.executor.workflow = () => workflow;
			f.github.add(labeled(14));

			f.executor.behaviors =
				limit === 5
					? [
							...Array.from({ length: 4 }, () => ({
								kind: "fail" as const,
								usage: 10,
							})),
							{ kind: "pass", usage: 10 },
						]
					: [{ kind: "pass", usage: 10 }];
			f.executor.acceptBehavior = { kind: "pass", usage: 7 };
			f.executor.buildBehavior = { kind: "pass", usage: 12 };
			const controller = f.start();

			for (let attempt = 1; attempt <= (limit === 5 ? 5 : 1); attempt++) {
				f.clock.t += 350_000;
				await once(controller);
			}

			await once(controller);
			await controller.tick();
			const book = f.files.claims.get(runOf(14))?.handoff;
			assert.ok(book);
			assert.equal(book.pin.maxReviewAttempts, Math.min(3, limit));
			assert.equal(
				f.executor.launches.filter((entry) => entry.stage === "specify").length,
				limit === 5 ? 5 : 1,
			);
			assert.equal(book.priorTokens, limit === 5 ? 69 : 29);
		});

	it("still recovers an ordinary early-build marker as a bounded retry", async () => {
		const f = world();
		f.github.add(labeled(14));
		f.executor.behaviors = [{ kind: "pass", usage: 10 }];
		f.executor.acceptBehavior = { kind: "pass", usage: 7 };
		f.executor.buildBehavior = { kind: "hang" };
		const controller = f.start();
		await once(controller);
		await controller.tick();
		const marker = parseMarker(f.github.markers(14).at(-1) ?? "");
		assert.equal(marker.kind, "marker");

		if (marker.kind !== "marker") throw new Error("marker");
		assert.equal(marker.marker.v, 2);
		assert.equal(marker.marker.stage, "build");
		assert.equal(marker.marker.candidate, null);
		const cold = world();
		keepAdmissions(f.store, cold.store);
		cold.github.add(
			labeled(14, { comments: [...(f.github.issues.get(14)?.comments ?? [])] }),
		);
		const recovered = cold.start();
		await recovered.tick();
		assert.equal(recovered.state.runs.get(14)?.phase.kind, "retry_queued");
		assert.equal(recovered.state.runs.get(14)?.attempt, 2);
		assert.equal(cold.executor.launches.length, 0);
		assert.equal(
			cold.logs.some((entry) => entry.event === "validation_failed"),
			false,
		);
	});

	for (const privateState of [
		"missing_claim",
		"missing_book",
		"corrupt_claim",
		"corrupt_book",
	])
		it(`refuses cold v3 repair adoption with ${privateState}`, async () => {
			const f = await waitingRun();
			f.executor.validate = async (input) => {
				assert.ok(input.state);

				const verdict = failingVerdict(digestOf("patch"));

				return {
					kind: "finished",
					state: input.state,
					verdict,
					assessment: f.executor.assess(input, verdict),
				};
			};

			await f.controller.tick();
			const claim = f.files.claims.get(runOf(14));
			assert.ok(claim?.handoff);
			assert.ok(parseCandidateState(JSON.parse(JSON.stringify(claim.handoff))));
			assert.equal(claim.round, 1);
			const comments = [...(f.github.issues.get(14)?.comments ?? [])];
			const parsed = parseMarker(f.github.markers(14).at(-1) ?? "");
			assert.equal(parsed.kind, "marker");

			if (parsed.kind !== "marker") throw new Error("marker");
			assert.equal(parsed.marker.v, 3);
			assert.equal(parsed.marker.round, 0);
			assert.ok(parsed.marker.branch?.endsWith("-r0"));
			assert.equal(
				parseMarker(formatMarker({ ...parsed.marker, round: 1 })).kind,
				"corrupt",
			);
			const cold = world();
			keepAdmissions(f.store, cold.store);
			cold.github.add(labeled(14, { comments }));

			if (privateState !== "missing_claim") {
				const dir = stateDir();
				const files = fileRunFiles(dir);
				await files.writeClaim(claim);
				const path = join(dir, "claims", `${claim.runId}.json`);

				if (privateState === "corrupt_claim")
					writeFileSync(path, "{", { mode: 0o600 });
				else {
					const { handoff: _book, ...withoutBook } = claim;
					writeFileSync(
						path,
						JSON.stringify(
							privateState === "corrupt_book"
								? { ...withoutBook, handoff: { kind: "broken" } }
								: withoutBook,
						),
						{ mode: 0o600 },
					);
				}

				for (const saved of await files.listClaims())
					cold.files.claims.set(saved.runId, saved);
			}

			const restarted = cold.start();
			await once(restarted);
			await restarted.tick();
			assert.equal(cold.executor.launches.length, 0);
			assert.equal(
				cold.logs.some(
					(entry) =>
						entry.event === "validation_failed" &&
						entry.fields.why === "validation_state_missing",
				),
				true,
			);
			assert.equal(cold.files.claims.get(runOf(14))?.status, "failed");
			assert.equal(cold.files.claims.get(runOf(14))?.usage, claim.usage);
			assert.equal(
				cold.files.claims.get(runOf(14))?.attempt,
				parsed.marker.attempt,
			);
		});

	it("neither adopts nor posts on a ledger-behind v3 claim this directory never admitted", async () => {
		const f = await waitingRun();
		const comments = [...(f.github.issues.get(14)?.comments ?? [])];
		const parsed = parseMarker(f.github.markers(14).at(-1) ?? "");
		assert.equal(parsed.kind, "marker");

		if (parsed.kind !== "marker") throw new Error("marker");
		const { marker } = parsed;
		assert.equal(marker.v, 3);
		const cold = world();
		cold.github.add(labeled(14, { comments: comments.slice(0, -1) }));
		const before = statuses(cold.github, 14);
		assert.equal(before.length, marker.seq - 1);
		cold.files.claims.set(marker.runId, {
			runId: marker.runId,
			issue: 14,
			eventId: marker.eventId,
			seq: marker.seq,
			status: marker.status,
			stage: marker.stage,
			attempt: marker.attempt,
			usage: marker.usage,
			marker,
		});

		const restarted = cold.start();
		const report = await restarted.tick();

		assert.deepEqual(statuses(cold.github, 14), before);
		assert.equal(
			cold.github.calls.some((call) => call.includes("POST")),
			false,
		);
		assert.equal(restarted.state.runs.size, 0);
		assert.deepEqual(report.runs, []);
		assert.equal(cold.executor.launches.length, 0);
		assert.equal(events(cold.logs).includes("claim_adopted"), false);
		assert.equal(events(cold.logs).includes("claim_foreign"), true);
	});

	it("keeps a missing-book PR observable while disabled and withdrawn without inventing certification", async () => {
		const f = await reviewingRun();
		f.executor.behaviors = [{ kind: "pass", usage: 11 }];
		await once(f.controller);
		await f.controller.tick();
		await f.controller.tick();
		const claim = f.files.claims.get(runOf(14));
		assert.equal(claim?.status, "waiting");
		assert.ok(claim?.handoff);
		const { handoff: _book, ...withoutBook } = claim;
		f.files.claims.set(runOf(14), withoutBook);
		const port = f.executor.candidate;
		assert.ok(port);
		let observed = 0;
		const state = stateDir();

		port.observeMissing = controllerCandidatePort({
			platform: EXE_DEV_PLATFORM,
			stateDir: state,
			exec: async (command, args) => {
				observed++;
				assert.equal(command, "gh");
				assert.equal(args[args.indexOf("--method") + 1], "GET");
				assert.ok(args.includes(`repos/${repo}/pulls/99`));

				return {
					code: 0,
					stderr: "",
					stdout: JSON.stringify({
						number: 99,
						head: {
							sha: "c".repeat(40),
							ref: `factory/pr/14-${runOf(14).slice(0, 12)}`,
							repo: { full_name: repo },
						},
						base: { ref: "main", repo: { full_name: repo } },
						user: { login: BOT_LOGIN, type: "Bot" },
						body: `<!-- factory:pr ${runOf(14)} -->`,
						state: "closed",
						draft: false,
						merged: true,
						merge_commit_sha: "e".repeat(40),
						merged_by: null,
					}),
				};
			},
		}).observeMissing;

		f.store.local = "disabled";
		const issue = f.github.issues.get(14);
		assert.ok(issue);
		issue.state = "closed";
		issue.labels = [];
		const launches = f.executor.launches.length;
		const restarted = f.start();
		await restarted.tick();
		await restarted.tick();
		assert.ok(observed > 0);
		assert.equal(f.executor.launches.length, launches);
		assert.equal(restarted.state.runs.get(14)?.phase.kind, "evidence_missing");
		assert.equal(f.files.claims.get(runOf(14))?.usage, claim.usage);
		assert.equal(f.files.claims.get(runOf(14))?.marker?.pr, 99);
		assert.equal(f.files.claims.get(runOf(14))?.handoff, undefined);
		assert.partialDeepStrictEqual(
			JSON.parse(
				readFileSync(
					join(
						state,
						"handoff",
						runOf(14),
						"missing-evidence-observation.json",
					),
					"utf8",
				),
			),
			{ kind: "merged", mergeSha: "e".repeat(40), actor: null },
		);
		const saved = f.files.claims.get(runOf(14));
		assert.ok(saved?.marker);
		assert.equal(await fileRunFiles(state).writeClaim(saved), true);
		assert.deepEqual(
			(await fileRunFiles(state).listClaims())[0]?.marker,
			saved.marker,
		);
		assert.ok(
			f.logs.some(
				(entry) =>
					entry.event === "merge_observed_evidence_missing" &&
					entry.fields.mergeSha === "e".repeat(40) &&
					entry.fields.actor === "unknown",
			),
		);
		f.store.records.clear();
		issue.comments = [];
		const calls = f.github.calls.length;
		const logged = f.logs.length;
		const missingAdmission = f.start();
		await missingAdmission.tick();
		assert.equal(missingAdmission.state.runs.has(14), false);
		assert.equal(
			f.github.calls.slice(calls).some((call) => call.includes("POST")),
			false,
		);
		assert.deepEqual(issue.comments, []);
		assert.equal(f.executor.launches.length, launches);
		assert.deepEqual(f.files.claims.get(runOf(14)), saved);
		assert.ok(
			f.logs
				.slice(logged)
				.some(
					(entry) =>
						entry.event === "claim_foreign" && entry.fields.issue === 14,
				),
		);
	});

	it("recovers a generation's gate digest from its exact diagnosis receipt rather than a guessed path", async () => {
		const f = await reviewingRun();
		const book = f.files.claims.get(runOf(14))?.handoff;
		assert.ok(book?.kind === "selected");
		const verdict = book.current.verdict;
		const original = f.executor.baseChecks[0]?.binding;
		assert.ok(verdict && original);
		const gatesDigest = digestOf("refreshed gates");

		const { receipt } = assessBase({
			binding: {
				...original,
				baseSha: sha(verdict.gateSha),
				gateSha: sha(verdict.gateSha),
			},
			runtime: {
				runner: "fixture",
				node: process.version,
				platform: process.platform,
				bwrap: "fixture",
				protocolDigest: digestOf("protocol"),
			},
			startedAt: 0,
			finishedAt: 10,
			source: {
				kind: "ready",
				treeDigest: digestOf("tree"),
				lockDigest: digestOf("lock"),
				gatesDigest,
			},
			execution: { kind: "observed", exitCode: 0, wallMs: 5, files: [] },
			repeat: { kind: "observed", exitCode: 0, wallMs: 5, files: [] },
			scenarios: [],
		});

		const root = stateDir();

		const binding = {
			runId: runOf(14),
			round: book.current.intent.round,
			generation: book.current.intent.generation,
			verdict,
		};

		const dir = join(
			validationDir(root, runOf(14), binding.round, binding.generation),
			"diagnosis",
			digestOf(JSON.stringify(assessmentBinding(binding))),
		);

		assert.ok(parseBaseReceipt(JSON.stringify(receipt)));
		mkdirSync(dir, { recursive: true });
		writeFileSync(join(dir, "refreshed-base.json"), JSON.stringify(receipt));
		const native = fileRunFiles(root);
		assert.equal(
			(await native.terminalEvidence?.(runOf(14), 29, book))?.generationGates?.[
				verdict.gateSha
			],
			gatesDigest,
		);
		writeFileSync(
			join(dir, "refreshed-base.json"),
			JSON.stringify({
				...receipt,
				evidence: {
					...receipt.evidence,
					binding: { ...receipt.evidence.binding, runId: runOf(15) },
				},
			}),
		);
		assert.equal(
			(await native.terminalEvidence?.(runOf(14), 29, book))?.generationGates?.[
				verdict.gateSha
			],
			undefined,
		);

		const policy = join(
			validationDir(root, runOf(14), binding.round, binding.generation),
			"gate-policy.json",
		);

		const pin = {
			v: 1,
			runId: runOf(14),
			round: binding.round,
			generation: binding.generation,
			sourceSha: verdict.gateSha,
			digest: gatesDigest,
		};

		writeFileSync(policy, JSON.stringify(pin));
		assert.equal(
			(await native.terminalEvidence?.(runOf(14), 29, book))?.generationGates?.[
				verdict.gateSha
			],
			gatesDigest,
		);
		writeFileSync(
			policy,
			JSON.stringify({ ...pin, generation: binding.generation + 1 }),
		);
		assert.equal(
			(await native.terminalEvidence?.(runOf(14), 29, book))?.generationGates?.[
				verdict.gateSha
			],
			undefined,
		);
	});

	it("projects the longest validated artifact prefix before a candidate exists", async () => {
		const f = await waitingRun();
		const dir = stateDir();
		const native = fileRunFiles(dir);
		const contract = await f.files.readContract(runOf(14));
		const stored = f.files.contracts.get(runOf(14));
		assert.ok(contract.kind === "found" && stored);
		assert.equal(
			await native.writeContract({
				contract: contract.contract,
				bytes: stored.bytes,
				digest: contract.digest,
			}),
			true,
		);
		const prefix = await native.terminalEvidence?.(runOf(14), 29, null);
		assert.deepEqual(prefix?.artifacts, {
			kind: "contract",
			contractDigest: contract.digest,
		});
		cpSync(join(f.files.artifactRoot, "acceptance"), join(dir, "acceptance"), {
			recursive: true,
		});

		const suite = await native.artifacts.read(
			runOf(14),
			contract.contract,
			contract.digest,
		);

		assert.ok(suite.kind === "found");
		assert.deepEqual(
			(await native.terminalEvidence?.(runOf(14), 29, null))?.artifacts,
			{
				kind: "acceptance",
				contractDigest: contract.digest,
				acceptanceDigest: suite.receipt.acceptanceDigest,
			},
		);
	});

	it("retains validated PR merge time at landing and refuses mismatched merge metadata on reads", async () => {
		const f = await reviewingRun();
		f.executor.behaviors = [{ kind: "pass", usage: 11 }];
		await once(f.controller);
		await f.controller.tick();
		await f.controller.tick();
		const dir = stateDir();
		const native = fileRunFiles(dir);
		Object.assign(f.files, {
			ledger: native.ledger,
			terminalEvidence: native.terminalEvidence,
		});
		const mergedAt = "2026-10-29T02:01:00Z";

		const port = controllerCandidatePort({
			platform: EXE_DEV_PLATFORM,
			stateDir: dir,
			exec: async (command, args) => {
				assert.equal(command, "gh");
				assert.ok(args.includes(`repos/${repo}/pulls/99`));

				return {
					code: 0,
					stderr: "",
					stdout: JSON.stringify({
						number: 99,
						head: {
							sha: "c".repeat(40),
							ref: `factory/pr/14-${runOf(14).slice(0, 12)}`,
							repo: { full_name: repo },
						},
						base: { ref: "main", repo: { full_name: repo } },
						user: { login: BOT_LOGIN, type: "Bot" },
						body: `<!-- factory:pr ${runOf(14)} -->`,
						state: "closed",
						draft: false,
						merged: true,
						merge_commit_sha: "e".repeat(40),
						merged_by: null,
						merged_at: mergedAt,
					}),
				};
			},
		});

		assert.ok(f.executor.candidate);
		f.executor.candidate.observe = port.observe;
		await f.controller.tick();
		await f.controller.tick();
		const row = (await native.ledger?.scan())?.[0]?.row?.row;
		assert.ok(row?.outcome.kind === "landed");
		assert.deepEqual(row.outcome.mergedAt, { kind: "known", value: mergedAt });
		const terminal = f.files.claims.get(runOf(14))?.handoff;
		assert.ok(terminal);
		const path = join(dir, "accounting", runOf(14), "merge.json");
		const saved = JSON.parse(readFileSync(path, "utf8"));
		assert.equal(statSync(path).mode & 0o777, 0o600);
		writeFileSync(path, JSON.stringify({ ...saved, repo: "other/repo" }));
		assert.equal(
			(await native.terminalEvidence?.(runOf(14), 40, terminal))?.mergedAt,
			undefined,
		);
		writeFileSync(path, JSON.stringify({ ...saved, mergeSha: "f".repeat(40) }));
		assert.equal(
			(await native.terminalEvidence?.(runOf(14), 40, terminal))?.mergedAt,
			undefined,
		);
	});

	for (const captured of [false, true])
		it(`keeps a verification run's landed row verification when a restart observes the merge before any workflow load (${captured ? "captured" : "legacy"} admission pin)`, async () => {
			const dir = stateDir();
			const native = fileRunFiles(dir);

			const manifest = await pinVerification(dir, {
				repo,
				issues: [14],
				tokenCap: 12_000,
			});

			assert.ok(manifest.kind === "pinned");
			const pin = manifest;

			const f = await reviewingRun(undefined, (world) => {
				world.options.verification = pin;
				Object.assign(world.files, {
					ledger: native.ledger,
					accounting: native.accounting,
					terminalEvidence: native.terminalEvidence,
				});
				world.files.prepareRun = (input) => {
					assert.equal(input.runTokenCap, TRUSTED_RUN_CAP);

					const start = {
						v: 1,
						runId: input.runId,
						startedAt: input.startedAt,
						policy: {
							workflowSha: input.workflowSha,
							workflowDigest: input.workflowDigest,
							gates: {
								kind: "known",
								value: {
									sourceSha: input.workflowSha,
									digest: digestOf("gates"),
								},
							},
							autonomy: {
								approveMerge: "always",
								land: "propose",
								digest: AUTONOMY_DIGEST,
							},
						},
					} as const;

					// A legacy pin is one an earlier build wrote, with no captured run cap.
					return native.accounting!.begin(
						captured
							? {
									v: 2,
									runId: input.runId,
									startedAt: input.startedAt,
									context: {
										kind: "verification",
										policy: start.policy,
										trustedCap: input.runTokenCap,
										manifestDigest: pin.digest,
										effectiveCap: Math.min(input.runTokenCap!, pin.tokenCap),
									},
								}
							: start,
					);
				};
			});

			f.executor.behaviors = [{ kind: "pass", usage: 11 }];
			await once(f.controller);
			await f.controller.tick();
			await f.controller.tick();
			assert.equal(f.files.claims.get(runOf(14))?.status, "waiting");
			const admitted = await native.accounting?.start(runOf(14));
			assert.ok(admitted);
			const policy = contextPolicy(admitted.context);
			assert.ok(policy);

			const port = controllerCandidatePort({
				platform: EXE_DEV_PLATFORM,
				stateDir: dir,
				exec: async () => ({
					code: 0,
					stderr: "",
					stdout: JSON.stringify({
						number: 99,
						head: {
							sha: "c".repeat(40),
							ref: `factory/pr/14-${runOf(14).slice(0, 12)}`,
							repo: { full_name: repo },
						},
						base: { ref: "main", repo: { full_name: repo } },
						user: { login: BOT_LOGIN, type: "Bot" },
						body: `<!-- factory:pr ${runOf(14)} -->`,
						state: "closed",
						draft: false,
						merged: true,
						merge_commit_sha: "e".repeat(40),
						merged_by: null,
						merged_at: "2026-10-29T02:01:00Z",
					}),
				}),
			});

			assert.ok(f.executor.candidate);
			f.executor.candidate.observe = port.observe;

			// The restarted controller cannot load WORKFLOW.md at all, so nothing
			// it writes can lean on a workflow load.
			f.wire.intercept = (command, args) =>
				args.some((arg) => arg.includes("WORKFLOW.md"))
					? Promise.resolve({ code: 1, stdout: "", stderr: "HTTP 502" })
					: f.github.exec(command, args);
			f.options.verification = null;
			const restarted = f.start();
			const report = await restarted.tick();
			assert.deepEqual(report.dispatch.reasons, ["workflow_unavailable"]);
			assert.equal(statuses(f.github, 14).at(-1)?.endsWith(":landed"), true);

			const terminal = JSON.parse(
				readFileSync(join(dir, "ledger", runOf(14), "terminal.json"), "utf8"),
			);

			assert.equal(terminal.outcome.kind, "landed");
			assert.deepEqual(terminal.provenance, {
				kind: "verification",
				policy,
				verificationDigest: pin.digest,
				trustedRunTokenCap: captured
					? TRUSTED_RUN_CAP
					: { kind: "unavailable", reason: "legacy_not_recorded" },
				effectiveRunTokenCap: captured
					? pin.tokenCap
					: { kind: "unavailable", reason: "legacy_not_recorded" },
			});
			assert.deepEqual(terminal.runContext, admitted.context);
			assert.deepEqual(terminal.terminalWorkflowObservation, {
				kind: "unavailable",
				reason: "receipt_missing",
			});
			await restarted.tick();
			const row = (await native.ledger?.scan())?.[0]?.row?.row;
			assert.ok(row);
			assert.deepEqual(row.provenance, terminal.provenance);
			assert.equal(row.gaps.includes("legacy_not_recorded"), !captured);
		});

	it("persists a completed candidate review disposition before its handoff", async () => {
		const f = await reviewingRun();
		f.files.accounting = fileRunFiles(f.files.artifactRoot).accounting;
		f.executor.behaviors = [{ kind: "pass", usage: 11 }];
		await once(f.controller);

		const record = await f.files.accounting!.readAttempt(
			runOf(14),
			"review",
			0,
			1,
		);

		assert.equal(record?.disposition, "completed");
		assert.equal(record?.usage, 40);
	});

	for (const repair of [false, true])
		it(`keeps the refused author's files out of every build and review input (${repair ? "repair" : "initial"})`, async () => {
			const secret = "PRIVATE-REFUSED-AUTHOR-SOURCE";

			const f = await reviewingRun(
				repair ? "fail" : undefined,
				({ executor }) => {
					executor.acceptText = ACCEPTANCE_TEXT.replace(
						"test('version'",
						`/* ${secret} */ test('version'`,
					);
					executor.baseOutcomes = ["preservation_failed", "ready"];
					executor.spentBy.set("accept-1", 7);
					executor.baseReceipt = (binding) => {
						executor.acceptText = ACCEPTANCE_TEXT;

						return refusedReceipt(binding, "PRIVATE-RETRY-FEEDBACK");
					};
				},
			);

			f.executor.behaviors = [{ kind: "pass", usage: 11 }];
			await once(f.controller);

			const retry = f.executor.launches.find(
				(entry) => entry.stage === "accept" && entry.attempt === 2,
			);

			assert.ok(retry);
			assert.ok(retry.prompt.includes(secret));
			assert.ok(retry.prompt.includes("PRIVATE-RETRY-FEEDBACK"));

			if (repair) {
				await f.controller.tick();
				await once(f.controller);
			}

			const downstream = f.executor.launches.filter(
				(entry) => entry.stage === "build" || entry.stage === "review",
			);

			assert.ok(downstream.some((entry) => entry.stage === "build"));
			assert.ok(downstream.some((entry) => entry.stage === "review"));

			if (repair)
				assert.ok(
					downstream.some(
						(entry) => entry.stage === "build" && entry.round === 1,
					),
				);

			for (const input of downstream) {
				const serialized = JSON.stringify(input);
				assert.ok(!serialized.includes(secret));
				assert.doesNotMatch(
					serialized,
					/PRIVATE-RETRY-FEEDBACK|previous-suite-|base-refusal-/,
				);
			}
		});

	const publishedStopFaults = [
		"batch",
		"inputs",
		"review_size",
		"review_size_callback",
		"review_size_recovery",
		"no_change",
		"review_evidence",
		"review_spend",
		"build_spend",
		"notice_error",
		"summary_size",
	] as const;

	for (const { fault, tokens } of publishedStopFaults.flatMap((fault) =>
		(fault.startsWith("review_size") ? [0, null] : [null]).map((tokens) => ({
			fault,
			tokens,
		})),
	))
		it(`F10-2 published ${fault} stop holds with one summary instead of orphaning PR (tokens=${tokens})`, async () => {
			const f = await reviewingRun();
			f.executor.behaviors = [{ kind: "pass", usage: 11 }];
			await once(f.controller);
			await f.controller.tick();
			await f.controller.tick();
			const claim = f.files.claims.get(runOf(14));
			assert.ok(claim?.handoff?.kind === "selected" && claim.handoff.published);
			const book = claim.handoff;
			const batch = digestOf("feedback repair fixture");
			const id = `github:${repo}:review:77` as const;

			const queued = {
				...book,
				feedback: {
					pr: 99,
					seen: [id],
					batches: [
						{
							digest: batch,
							head: book.current.report!.candidateSha,
							actionable: true,
							reviews: [id],
							notice: "posted" as const,
							status: { kind: "queued" as const },
						},
					],
				},
			};

			f.files.claims.set(runOf(14), { ...claim, handoff: queued });
			const notices: string[] = [];
			let summarySince: number | undefined;
			const startedAt = f.clock.now();
			const port = f.executor.candidate!;
			const execute = port.execute;
			port.execute = async (state, request) => {
				if (request.kind === "complete_handoff" && fault === "summary_size")
					throw new PublicationError("summary_too_large");

				if (request.kind === "post_notice") {
					notices.push(request.notice.kind);

					if (request.notice.kind === "round_summary") {
						summarySince = request.at;
						assert.ok(
							summarySince !== undefined &&
								summarySince >= startedAt &&
								summarySince <= f.clock.now(),
						);
					}

					if (
						fault === "notice_error" &&
						request.notice.kind === "repair_started"
					)
						throw new PublicationError("evidence_unavailable");
				}

				return execute(state, request);
			};

			if (fault !== "batch")
				Object.assign(f.executor, {
					readFeedback: async () => ({
						version: 1,
						runId: book.pin.runId,
						pr: 99,
						head: book.current.report!.candidateSha,
						records: [
							{
								event: id,
								actor: "writer",
								intake: { kind: "actionable" },
								inline: [],
							},
						],
						cards: [],
						full: null,
					}),
				});

			if (fault === "inputs")
				f.executor.baseCheck = async () => ({
					kind: "interrupted",
					wallMs: 0,
				});

			if (fault.startsWith("review") || fault === "summary_size") {
				f.executor.fallback = { kind: "pass", usage: 11 };
				const validate = f.executor.validate;
				f.executor.validate = async (input) => {
					const result = await validate(input);
					assert.ok(result.kind === "finished" && input.generation);

					const verdict = {
						...result.verdict,
						patchDigest: input.generation.patchDigest,
					};

					return {
						...result,
						verdict,
						report: reportOf(verdict),
						assessment: f.executor.assess(input, verdict),
					};
				};
			}

			let preparations = 0;

			const reviewLaunches = f.executor.launches.filter(
				(l) => l.stage === "review",
			).length;

			if (fault.startsWith("review_size")) {
				const diff = `diff --git a/server/cli.ts b/server/cli.ts\n--- a/server/cli.ts\n+++ b/server/cli.ts\n@@ -1 +1 @@\n-export const text = '';\n+export const text = '${"é".repeat(REVIEW_DIFF_MAX_BYTES)}';\n`;
				assert.ok(Buffer.byteLength(diff) > REVIEW_DIFF_MAX_BYTES);
				const contract = await f.files.readContract(runOf(14));
				assert.ok(contract.kind === "found");
				const output = f.executor.output.bind(f.executor);
				const prepare = f.executor.prepareReview!;

				const refuse = (
					verdict: import("../../../src/core/run.ts").Verdict,
				) => {
					const refusal = candidateReviewPrompt({
						contract: contract.contract,
						diff,
						paths: ["server/cli.ts"],
						judges: [],
						guidance: "Review read-only",
						verdict,
					});

					assert.ok(refusal.kind === "refused");

					return refusal;
				};

				f.executor.output = async (input) => {
					const result = await output(input);

					if (
						input.round === 1 &&
						input.stage === "build" &&
						result instanceof Object &&
						result.kind === "build" &&
						result.result.kind === "found"
					) {
						const built = {
							kind: "build",
							result: {
								...result.result,
								patch: diff,
								receipt: {
									...result.result.receipt,
									patchDigest: digestOf(diff),
								},
							},
						} as const;

						f.executor.builds.set(
							`${input.runId}/build-r1-${input.attempt}`,
							built,
						);

						return built;
					}

					if (input.round === 1 && input.stage === "review") {
						assert.ok(preparations > 0);
						const current = f.files.claims.get(runOf(14))?.handoff;
						assert.ok(current?.kind === "selected" && current.current.verdict);
						const refusal = refuse(current.current.verdict);
						assert.ok(refusal.kind === "refused");

						return refusal;
					}

					return result;
				};

				f.executor.prepareReview = async (input) => {
					preparations++;
					const current = f.files.claims.get(runOf(14))?.handoff;
					assert.ok(current?.kind === "selected" && current.current.verdict);
					assert.equal(current.current.verdict.patchDigest, digestOf(diff));
					assert.equal(current.current.verdict.pass, true);
					assert.equal(current.current.intent.publication.kind, "successor");

					return fault === "review_size"
						? refuse(current.current.verdict)
						: await prepare(input);
				};

				const spent = f.executor.spent.bind(f.executor);
				f.executor.spent = async (input) =>
					input.round === 1 && input.stage === "review" ? tokens : spent(input);

				if (fault === "review_size_recovery") {
					const launch = f.executor.launch.bind(f.executor);
					f.executor.launch = async (input) => {
						if (input.round === 1 && input.stage === "review")
							throw new Error("crash before repair review launch");

						return launch(input);
					};
				}
			}

			if (fault === "review_evidence")
				f.executor.prepareReview = async () => {
					throw new ReviewEvidenceUnavailable(
						"review preparation lost its evidence",
					);
				};

			if (fault === "review_spend" || fault === "build_spend") {
				const spent = f.executor.spent.bind(f.executor);
				f.executor.spent = async (input) =>
					input.round === 1 &&
					input.stage === (fault === "review_spend" ? "review" : "build")
						? null
						: spent(input);
			}

			if (fault === "no_change") {
				const output = f.executor.output.bind(f.executor);
				f.executor.output = async (input) =>
					input.stage === "build" && input.round === 1
						? {
								kind: "build",
								result: { kind: "blocked", reason: "repair_no_change" },
							}
						: output(input);
			}

			let restarted = f.start();

			if (fault === "review_size_recovery") {
				await assert.rejects(
					drive(restarted, f),
					/crash before repair review launch/,
				);
				restarted = f.start();
			}

			await drive(restarted, f);
			await drive(restarted, f);
			const result = f.files.claims.get(runOf(14))?.handoff;
			assert.ok(result?.kind === "selected");

			if (fault.startsWith("review_size"))
				assert.equal(
					preparations,
					1,
					"must reach review preparation after validation",
				);
			assert.equal(result.work.kind, "held");
			const heldMarker = f.github.markers(14).at(-1) ?? "";

			assert.equal(parseMarker(heldMarker).kind, "marker");
			assert.ok(heldMarker.includes(`(${result.work.reason})`));
			assert.doesNotMatch(heldMarker, /the stage sandbox is unavailable/);

			if (fault === "no_change")
				assert.match(heldMarker, /Stage build, round 1, attempt 1\./);
			assert.equal(
				notices.filter((kind) => kind === "repair_started").length,
				1,
			);
			assert.equal(
				notices.filter((kind) => kind === "round_summary").length,
				1,
			);
			assert.equal(
				result.feedback?.batches.some((b) => b.status.kind === "applying"),
				false,
			);
			assert.partialDeepStrictEqual(result.feedback?.batches[0]?.status, {
				kind: "settled",
				outcome: { kind: "stopped" },
			});

			if (fault.startsWith("review_size")) {
				assert.deepEqual(result.feedback?.batches[0]?.status, {
					kind: "settled",
					outcome: { kind: "stopped", reason: "review_input_too_large" },
				});
				assert.equal(
					result.work.kind === "held" && result.work.reason,
					"review_input_too_large",
				);
				assert.equal(
					f.executor.launches.filter((l) => l.stage === "review").length -
						reviewLaunches,
					fault === "review_size_callback" ? 1 : 0,
				);
				assert.equal(keyed(f.github, 14, "review-input").length, 1);
			}

			assert.ok(restarted.state.runs.has(14));
			const heldSince = result.published?.readiness.since;
			assert.equal(heldSince, summarySince);
			const heldMarkerCount = f.github.markers(14).length;
			await drive(f.start(), f);
			assert.equal(
				f.github.markers(14).length,
				heldMarkerCount,
				"unchanged durable hold must not post another marker after restart",
			);
			assert.equal(f.github.markers(14).at(-1), heldMarker);
			assert.equal(
				notices.filter((kind) => kind === "round_summary").length,
				1,
			);
			const restored = f.files.claims.get(runOf(14))?.handoff;
			assert.ok(restored?.kind === "selected");
			assert.equal(restored.published?.readiness.since, heldSince);

			if (fault.startsWith("review_size")) {
				assert.equal(keyed(f.github, 14, "review-input").length, 1);
				assert.deepEqual(restored.feedback, result.feedback);
				assert.deepEqual(restored.work, result.work);
			}

			if (fault === "no_change") {
				const repair = f.executor.launches.find(
					(launch) => launch.stage === "build" && launch.round === 1,
				);

				assert.ok(repair);
				assert.ok(repair.prompt.startsWith("build-playbook=feedback\n"));
				assert.doesNotMatch(
					repair.prompt,
					/Reproduce a bug with a failing test/,
				);
				const saved = f.files.claims.get(runOf(14));
				assert.ok(saved && restored.work.kind === "held");
				f.files.claims.set(runOf(14), {
					...saved,
					handoff: {
						...restored,
						work: { ...restored.work, reason: "repair_tokens" },
					},
				});
				const changed = f.start();
				await drive(changed, f);
				assert.match(f.github.markers(14).at(-1) ?? "", /\(repair_tokens\)/);
				const count = f.github.markers(14).length;
				assert.equal(count, heldMarkerCount + 1);
				await drive(changed, f);
				await drive(f.start(), f);
				assert.equal(f.github.markers(14).length, count);

				const heldClaim = f.files.claims.get(runOf(14));
				const heldBook = heldClaim?.handoff;
				assert.ok(heldClaim && heldBook?.kind === "selected");
				const last = heldBook.accounts.at(-1);
				assert.ok(last && last.execution.round === 1);
				f.files.claims.set(runOf(14), {
					...heldClaim,
					handoff: {
						...heldBook,
						accounts: [
							...heldBook.accounts.slice(0, -1),
							{ ...last, execution: { ...last.execution, round: 2 } },
						],
					},
				});
				await drive(f.start(), f);
				assert.equal(f.github.markers(14).length, count + 1);
				assert.match(
					f.github.markers(14).at(-1) ?? "",
					/Stage build, round 2, attempt 1\./,
				);
				await drive(f.start(), f);
				assert.equal(f.github.markers(14).length, count + 1);
			}
		});

	it("hops from CI to isolated review and waits for the owner with charged usage", async () => {
		const f = await reviewingRun();
		f.executor.behaviors = [{ kind: "pass", usage: 11 }];
		await once(f.controller);

		const review = f.executor.launches.find(
			(entry) => entry.stage === "review",
		);

		assert.deepEqual(review?.tools, ["read", "grep", "ls"]);
		assert.equal(review?.settings.maxTokens, REVIEW_MAX_TOKENS);
		await f.controller.tick();
		await f.controller.tick();
		assert.equal(f.files.claims.get(runOf(14))?.status, "waiting");
		assert.equal(f.files.claims.get(runOf(14))?.stage, "land");
		assert.equal(f.files.claims.get(runOf(14))?.usage, 40);
	});

	for (const published of [true, false])
		it(`restarts a version-1 certified book ${published ? "with an open PR" : "before its PR"} by migrating it on read`, async () => {
			const f = await reviewingRun("pass");
			f.executor.behaviors = [{ kind: "pass", usage: 11 }];

			if (!published) {
				await f.controller.tick();
				f.store.local = "disabled";
			}

			await once(f.controller);
			await f.controller.tick();

			if (published) await f.controller.tick();
			const claim = f.files.claims.get(runOf(14));
			const book = claim?.handoff;
			assert.ok(claim && book?.kind === "selected");
			assert.equal(book.published?.number ?? null, published ? 99 : null);
			assert.equal(
				book.current.certification?.review.seats[0]?.judgments[0]?.outcome,
				"pass",
			);
			const stored = JSON.parse(JSON.stringify(claim));

			for (const evidence of [
				...stored.handoff.history,
				stored.handoff.current,
			])
				if (evidence.certification !== null) {
					evidence.certification.review.version = 1;

					for (const seat of evidence.certification.review.seats)
						seat.judgments = seat.judgments.map(
							({
								scenario,
								outcome,
								reason,
							}: {
								readonly scenario: string;
								readonly outcome: string;
								readonly reason: string;
							}) => ({ scenario, pass: outcome === "pass", reason }),
						);
				}

			const dir = stateDir();
			const files = fileRunFiles(dir);
			assert.equal(await files.writeClaim(stored), true);

			const certificate = join(
				dir,
				"validation",
				runOf(14),
				"certification.json",
			);

			const original = readFileSync(certificate, "utf8");
			assert.match(original, /"version":1,/);
			assert.match(original, /"pass":true/);
			f.files.claims.clear();

			for (const saved of await files.listClaims())
				f.files.claims.set(saved.runId, saved);
			f.store.local = "enabled";
			const launches = f.executor.launches.length;
			const restarted = f.start();
			await restarted.tick();
			await restarted.tick();
			assert.notEqual(
				restarted.state.runs.get(14)?.phase.kind,
				"evidence_missing",
			);
			assert.notEqual(restarted.state.runs.get(14)?.phase.kind, "failed");
			const resumed = f.files.claims.get(runOf(14));
			assert.equal(resumed?.status, "waiting");
			assert.equal(resumed.usage, 40);
			assert.equal(f.executor.launches.length, launches);
			assert.ok(resumed.handoff?.kind === "selected");
			assert.equal(resumed.handoff.published?.number, 99);
			assert.deepEqual(
				resumed.handoff.current.certification,
				book.current.certification,
			);
			assert.equal(await files.writeClaim(resumed), true);
			assert.equal(readFileSync(certificate, "utf8"), original);
			assert.deepEqual(
				(await readViewerRun(dir, runOf(14))).gaps.filter(
					(gap) => gap.reason === "evidence binding mismatch",
				),
				[],
			);
			assert.equal(
				JSON.parse(
					readFileSync(join(dir, "claims", `${runOf(14)}.json`), "utf8"),
				).handoff.current.certification.review.version,
				2,
			);
		});

	for (const permission of ["read", "triage", "none", "failed"] as const)
		for (const source of [
			"review",
			"conversation",
			"inline",
			"heldout inline",
		] as const)
			it(`feedback authority: ${permission} ${source} adds no card, queued batch or repair_started`, async () => {
				const f = await reviewingRun();
				f.executor.behaviors = [{ kind: "pass", usage: 11 }];
				await once(f.controller);
				await f.controller.tick();
				await f.controller.tick();
				const port = f.executor.candidate;
				assert.ok(port);
				const observe = port.observe;
				const execute = port.execute;
				const dir = stateDir();
				const book = f.files.claims.get(runOf(14))?.handoff;
				assert.ok(book?.kind === "selected");
				const head = promotedHead(book);
				assert.ok(head);
				const issue = f.github.add(fakeIssue(99, { pullRequest: true }));
				f.github.permissions.set("writer", permission);

				if (permission === "failed")
					f.github.failures.set(
						`repos/${repo}/collaborators/writer/permission`,
						httpError(503),
					);

				if (source === "conversation")
					f.github.comment(issue, "Please fix this", {
						login: "writer",
						type: "User",
						appSlug: null,
					});
				else {
					const recorded: {
						reviews: Record<string, JsonValue>[];
						comments: Record<string, JsonValue>[];
					} = JSON.parse(
						readFileSync(
							new URL(
								"../../fixtures/feedback/github-review.json",
								import.meta.url,
							),
							"utf8",
						),
					);

					f.github.reviews.set(
						99,
						recorded.reviews.map((r) => ({
							...r,
							commit_id: head,
							body: source === "review" ? "Please fix this" : "",
						})),
					);
					f.github.reviewComments.set(
						"99/5812783128",
						source === "review"
							? []
							: recorded.comments
									.filter((c) =>
										source === "inline"
											? c.path === "server/viewer.ts"
											: String(c.path).startsWith("test/acceptance/"),
									)
									.map((c) => ({ ...c, commit_id: head })),
					);
				}

				let observations = 0;
				port.observe = async (state, now) => {
					const obs = await observe(state, now);

					const feedback = await observeFeedback({
						controllerLogin: EXE_DEV_PLATFORM.controllerLogin,
						stateDir: dir,
						adapter: new GitHubTicketAdapter({ exec: f.github.exec, repo }),
						runId: state.pin.runId,
						pr: 99,
						head,
						prHead: head,
						refHead: head,
						seen: state.kind === "selected" ? (state.feedback?.seen ?? []) : [],
					});

					observations++;

					if (permission === "failed")
						assert.partialDeepStrictEqual(feedback, {
							kind: "unavailable",
							reason: "permission",
						});
					else {
						assert.ok(feedback.kind === "read");

						if (observations === 1) assert.ok(feedback.batch);

						if (feedback.batch !== null) {
							assert.equal(feedback.batch.actionable, false);

							const batch = JSON.parse(
								readFileSync(
									join(
										dir,
										"handoff",
										runOf(14),
										"feedback",
										`${feedback.batch.digest}.json`,
									),
									"utf8",
								),
							);

							assert.deepEqual(batch.cards, []);
							assert.equal(batch.records.length, 1);
							assert.deepEqual(batch.records[0].intake, {
								kind: "refused",
								reason: "unauthorized",
							});
						}
					}

					return { ...obs, feedback };
				};

				const notices: string[] = [];
				port.execute = async (state, request) => {
					if (request.kind === "post_notice") notices.push(request.notice.kind);

					return execute(state, request);
				};

				const launches = f.executor.launches.length;

				for (let tick = 0; tick < 4; tick++) await f.controller.tick();
				assert.ok(observations > 1);
				const stored = f.files.claims.get(runOf(14))?.handoff;
				assert.ok(stored?.kind === "selected");
				assert.equal(
					stored.feedback?.batches.some(
						(b) => b.status.kind === "queued" || b.status.kind === "applying",
					) ?? false,
					false,
				);
				assert.equal(notices.includes("repair_started"), false);
				assert.equal(f.executor.launches.length, launches);
				assert.deepEqual(stored.accounts, book.accounts);
				assert.deepEqual(stored.current.intent, book.current.intent);

				if (permission === "failed") {
					assert.deepEqual(stored.feedback, book.feedback);
					assert.equal(
						existsSync(join(dir, "handoff", runOf(14), "feedback")),
						false,
					);
				} else {
					assert.equal(stored.feedback?.batches.length, 1);
					assert.deepEqual(stored.feedback.batches[0]?.status, {
						kind: "settled",
						outcome: { kind: "no_action" },
					});
				}
			});

	it("ingests recorded GitHub review shapes into one queued batch and one intake notice", async () => {
		const f = await reviewingRun();
		f.executor.behaviors = [{ kind: "pass", usage: 11 }];
		await once(f.controller);
		await f.controller.tick();
		await f.controller.tick();
		const port = f.executor.candidate;
		assert.ok(port);
		const observe = port.observe;
		const execute = port.execute;
		const dir = stateDir();

		const recorded: {
			reviews: Record<string, JsonValue>[];
			comments: Record<string, JsonValue>[];
		} = JSON.parse(
			readFileSync(
				new URL("../../fixtures/feedback/github-review.json", import.meta.url),
				"utf8",
			),
		);

		const book = f.files.claims.get(runOf(14))?.handoff;
		assert.ok(book?.kind === "selected");
		const head = promotedHead(book);
		assert.ok(head);
		f.github.add(fakeIssue(99, { pullRequest: true }));
		f.github.reviews.set(
			99,
			recorded.reviews.map((r) => ({ ...r, commit_id: head })),
		);
		f.github.reviewComments.set(
			"99/5812783128",
			recorded.comments.map((c) => ({ ...c, commit_id: head })),
		);
		const notices: string[] = [];
		port.observe = async (state, now) => {
			const obs = await observe(state, now);

			const feedback = await observeFeedback({
				controllerLogin: EXE_DEV_PLATFORM.controllerLogin,
				stateDir: dir,
				adapter: new GitHubTicketAdapter({ exec: f.github.exec, repo }),
				runId: state.pin.runId,
				pr: 99,
				head,
				prHead: head,
				refHead: head,
				seen: state.kind === "selected" ? (state.feedback?.seen ?? []) : [],
			});

			assert.equal(feedback.kind, "read");

			return { ...obs, feedback };
		};

		port.execute = async (state, request) => {
			if (request.kind === "post_notice") notices.push(request.notice.kind);

			return execute(state, request);
		};

		for (let tick = 0; tick < 4; tick++) await f.controller.tick();
		const stored = f.files.claims.get(runOf(14))?.handoff;
		assert.ok(stored?.kind === "selected");
		assert.equal(stored.feedback?.batches.length, 1);
		assert.deepEqual(stored.feedback.batches[0]?.status, {
			kind: "settled",
			outcome: { kind: "stopped", reason: "diagnosis_missing_evidence" },
		});
		assert.equal(stored.feedback.batches[0]?.notice, "posted");
		assert.deepEqual(notices, [
			"feedback_intake",
			"repair_started",
			"round_summary",
		]);
		assert.equal(stored.published?.number, book.published?.number);
		assert.equal(stored.published?.readiness.kind, "not_ready");
		assert.deepEqual(
			stored.accounts.slice(0, book.accounts.length),
			book.accounts,
		);
		assert.equal(stored.accounts.length, book.accounts.length + 1);

		const batch = readFileSync(
			join(
				dir,
				"handoff",
				runOf(14),
				"feedback",
				`${stored.feedback.batches[0]!.digest}.json`,
			),
			"utf8",
		);

		assert.match(batch, /heldout_path/);
		assert.doesNotMatch(batch, /REDACTED-HUNK|REDACTED-HELDOUT-CONTENT/);
		assert.equal(JSON.parse(batch).cards.length, 2);
	});

	it("logs feedback failures once per reason change and retains their age until recovery", async () => {
		const f = await reviewingRun();
		f.executor.behaviors = [{ kind: "pass", usage: 11 }];
		await once(f.controller);
		await f.controller.tick();
		await f.controller.tick();
		const port = f.executor.candidate;
		assert.ok(port);
		const observe = port.observe;

		let feedback: FeedbackObservation = {
			kind: "unavailable",
			reason: "review_comments",
			failure: "malformed_response",
		};

		port.observe = async (state, now) => ({
			...(await observe(state, now)),
			feedback,
		});

		const since = f.clock.now();
		const first = await f.controller.tick();
		assert.partialDeepStrictEqual(first, {
			feedbackIntake: [
				{
					runId: runOf(14),
					issue: 14,
					eventId: "34537521397",
					pr: 99,
					kind: "unavailable",
					reason: "review_comments",
					failure: "malformed_response",
					since,
				},
			],
		});
		const dir = stateDir();
		const claim = f.files.claims.get(runOf(14));
		assert.ok(claim);
		assert.equal(await fileRunFiles(dir).writeClaim(claim), true);
		assert.equal(await writeStatus(dir, first, EXE_DEV_PLATFORM), true);

		const attention = await readAttention({
			stateDir: dir,
			repo,
			now: since + 60_000,
		});

		assert.ok(attention.kind === "available");
		assert.partialDeepStrictEqual(attention.groups.blocked, [
			{
				runId: runOf(14),
				ageMs: 60_000,
				reason: "feedback_unavailable:review_comments:malformed_response",
			},
		]);
		assert.equal(attention.groups.pr_review.length, 0);
		f.clock.t += 60_000;
		await f.controller.tick();
		feedback = { kind: "unavailable", reason: "reviews", failure: "gh_failed" };
		const changed = await f.controller.tick();
		assert.partialDeepStrictEqual(changed, { feedbackIntake: [{ since }] });
		await f.controller.tick();
		const failures = f.logs.filter((l) => l.event === "feedback_unavailable");
		assert.equal(failures.length, 2);
		assert.partialDeepStrictEqual(
			failures.map((l) => l.fields),
			[
				{ reason: "review_comments", failure: "malformed_response", pr: 99 },
				{ reason: "reviews", failure: "gh_failed", pr: 99 },
			],
		);
		feedback = { kind: "deferred", reason: "head_mismatch" };
		await f.controller.tick();
		await f.controller.tick();
		assert.equal(
			f.logs.filter((l) => l.event === "feedback_deferred").length,
			1,
		);
		feedback = { kind: "none" };
		assert.partialDeepStrictEqual(await f.controller.tick(), {
			feedbackIntake: [],
		});
		feedback = {
			kind: "unavailable",
			reason: "review_comments",
			failure: "malformed_response",
		};
		assert.partialDeepStrictEqual(await f.controller.tick(), {
			feedbackIntake: [{ since: f.clock.now() }],
		});
		assert.equal(
			f.logs.filter((l) => l.event === "feedback_unavailable").length,
			3,
		);
	});

	for (const busy of [false, true])
		it(`F10 C1/C2/C11 durable feedback and one notice across callback double-apply and restart (busy=${busy})`, async () => {
			const f = await reviewingRun();
			f.executor.behaviors = [{ kind: "pass", usage: 11 }];

			if (!busy) {
				await once(f.controller);
				await f.controller.tick();
				await f.controller.tick();
			}

			const port = f.executor.candidate;
			assert.ok(port);
			const observe = port.observe;
			let notices = 0;
			let lost = true;
			const execute = port.execute;
			port.observe = async (state, now) => {
				const obs = await observe(state, now);

				if (state.kind !== "selected" || state.published === null) return obs;
				const head = state.current.report!.candidateSha;

				return {
					...obs,
					feedback: {
						kind: "read",
						head,
						batch: {
							digest: digestOf("feedback-batch"),
							seen: [`github:${repo}:review:1`],
							reviews: [`github:${repo}:review:1`],
							actionable: true,
							refusedInline: false,
						},
						dismissed: [],
					},
				};
			};

			port.execute = async (state, request) => {
				if (request.kind !== "post_notice") return execute(state, request);
				assert.deepEqual(f.files.claims.get(runOf(14))?.handoff, state);

				if (notices === 0) notices++;

				if (lost) {
					lost = false;

					return null;
				}

				return { kind: "post_notice", request };
			};

			if (busy) {
				await f.controller.tick();
				await settle();
				// A published old generation can be reviewed while its successor callback is pending.
				const claim = f.files.claims.get(runOf(14));
				assert.ok(claim?.handoff?.kind === "selected");
			}

			for (let tick = 0; tick < 6 && notices === 0; tick++)
				await once(f.controller);
			assert.equal(notices, 1);
			const saved = f.files.claims.get(runOf(14));
			assert.ok(saved?.handoff?.kind === "selected");
			assert.equal(saved.handoff.feedback?.batches.length, 1);
			assert.deepEqual(saved.handoff.feedback?.batches[0]?.status, {
				kind: "applying",
				round: 1,
			});
			const launches = f.executor.launches.length;
			const restored = f.start();
			await restored.tick();
			await restored.tick();
			const book = f.files.claims.get(runOf(14))?.handoff;
			assert.ok(book?.kind === "selected");
			assert.equal(book.feedback?.batches.length, 1);
			assert.equal(book.feedback?.batches[0]?.notice, "none");
			assert.deepEqual(book.feedback?.batches[0]?.status, {
				kind: "settled",
				outcome: { kind: "stopped", reason: "diagnosis_missing_evidence" },
			});
			assert.equal(notices, 1);
			assert.equal(f.executor.launches.length, launches);
		});

	async function feedbackCallback(capped: boolean) {
		const f = await reviewingRun();
		f.executor.behaviors = [{ kind: "pass", usage: 11 }];
		await once(f.controller);
		await f.controller.tick();
		await f.controller.tick();
		const initial = f.files.claims.get(runOf(14))?.handoff;
		const port = f.executor.candidate;

		assert.ok(
			initial?.kind === "selected" &&
				initial.current.verdict &&
				initial.current.validation &&
				port,
		);
		const template = initial.current.validation;
		const oldHead = promotedHead(initial);

		assert.ok(oldHead);
		const main = sha("d".repeat(40));
		const head = sha("e".repeat(40));

		const verdict = {
			...initial.current.verdict,
			candidateSha: head,
			baseSha: main,
			gateSha: main,
		};

		const prepare = f.executor.prepareReview;

		assert.ok(prepare);
		f.executor.prepareReview = async (input) => {
			const prepared = await prepare(input);

			assert.ok("verdict" in prepared);

			return { ...prepared, verdict };
		};

		f.executor.validate = async (input) => {
			assert.ok(input.generation);
			const generation = input.generation;
			const nonce = dispatchNonce(input.runId, 0, 1, generation.generation);

			const state = {
				...template,
				baseSha: main,
				generation: {
					index: generation.generation,
					digest: generation.digest,
					previousHead: oldHead,
				},
				publication: {
					branch: `factory/run/14-${input.runId.slice(0, 12)}-r0-g1`,
					patchSha: head,
					candidateSha: head,
				},
			};

			return {
				kind: "finished",
				state,
				verdict,
				report: {
					...reportOf(verdict),
					nonce,
					externalId: `factory-gates:123:${nonce}`,
				},
				assessment: f.executor.assess(input, verdict),
			};
		};

		let finish: (result: StageResult) => void = () => {
			throw new Error("review not launched");
		};

		const result = new Promise<StageResult>((resolve) => {
			finish = resolve;
		});

		f.executor.behaviors = [{ kind: "later", result }];
		f.executor.ready = true;
		const observe = port.observe;
		let reads = 0;
		let release: (() => void) | null = null;
		let feedback = false;

		port.observe = async (state, now) => {
			const observation = await observe(state, now);
			reads++;

			if (release !== null && reads === 2) {
				release();
				release = null;
				await settle();
				feedback = true;
			}

			return {
				...observation,
				main,
				feedback: feedback
					? {
							kind: "read",
							head: oldHead,
							batch: {
								digest: digestOf("interleaved-batch"),
								seen: capped
									? Array.from(
											{ length: 501 },
											(_, n) => `github:${repo}:review:${n + 5}` as const,
										)
									: [`github:${repo}:review:5`],
								reviews: [`github:${repo}:review:5`],
								actionable: true,
								refusedInline: false,
							},
							dismissed: [],
						}
					: { kind: "none" },
			};
		};

		await f.controller.tick();
		await f.controller.tick();
		const launched = f.executor.launches.at(-1);

		assert.ok(
			launched?.stage === "review" && launched.execution?.stage === "review",
		);
		assert.equal(launched.execution.generation.generation, 1);
		assert.equal(f.files.claims.get(runOf(14))?.handoff?.kind, "selected");
		reads = 0;
		release = () => finish(resultOf(launched, { kind: "passed" }, 11));
		const writes: CandidateState[] = [];
		const write = f.files.writeClaim;
		f.files.writeClaim = async (claim) => {
			if (claim.handoff) writes.push(claim.handoff);

			return write(claim);
		};

		await f.controller.tick();
		const book = f.files.claims.get(runOf(14))?.handoff;

		assert.ok(book?.kind === "selected");
		assert.equal(book.feedback?.batches.length, capped ? 0 : 1);
		assert.deepEqual(
			book.feedback?.seen,
			capped ? [] : [`github:${repo}:review:5`],
		);
		assert.equal(
			book.current.certification?.execution.id,
			launched.execution.id,
		);
		assert.ok(
			writes.some(
				(s) =>
					s.kind === "selected" &&
					s.work.kind === "reviewing" &&
					(capped
						? s.feedback?.overflow !== undefined
						: s.feedback?.batches.length === 1),
			),
			"intake commit precedes consuming the queued review callback",
		);
		assert.ok(
			writes.filter(
				(s) =>
					s.kind === "selected" &&
					(capped
						? s.feedback?.overflow !== undefined
						: s.feedback?.batches.length === 1),
			).length >= 2,
			"the same observation crosses both candidate commits",
		);
		let notices = 0;
		const noticeKinds: string[] = [];
		const execute = port.execute;
		port.execute = async (state, request) => {
			if (request.kind !== "post_notice") return execute(state, request);
			notices++;
			noticeKinds.push(request.notice.kind);

			return { kind: "post_notice", request };
		};

		for (let tick = 0; tick < 4 && notices === 0; tick++)
			await f.controller.tick();
		assert.equal(notices, 1);
		const restarted = f.start();
		await restarted.tick();
		await restarted.tick();
		const restored = f.files.claims.get(runOf(14))?.handoff;

		assert.ok(restored?.kind === "selected");
		assert.equal(restored.feedback?.batches.length, capped ? 0 : 1);
		assert.equal(
			capped
				? restored.feedback?.overflow?.notice
				: restored.feedback?.batches[0]?.notice,
			capped ? "posted" : "none",
		);
		assert.deepEqual(
			noticeKinds,
			capped ? ["feedback_overflow"] : ["repair_started", "round_summary"],
		);
		assert.equal(notices, capped ? 1 : 2);
		assert.equal(
			f.executor.launches.filter((l) => l.stage === "build").length,
			1,
		);
	}

	for (const capped of [false, true])
		it(`F10 published refresh callback survives the second feedback observation (cursor capped=${capped})`, async () =>
			feedbackCallback(capped));

	it("F10 tick sweeps landed ledger PRs hourly, survives a lost proposal POST and never admits proposals", async () => {
		const dir = stateDir();
		const outbox = fileLedgerOutbox(dir);

		const f = await reviewingRun(undefined, (ctx) =>
			Object.assign(ctx.files, { ledger: outbox }),
		);

		f.executor.behaviors = [{ kind: "pass", usage: 11 }];
		await once(f.controller);
		await f.controller.tick();
		await f.controller.tick();
		const port = f.executor.candidate;
		const book = f.files.claims.get(runOf(14))?.handoff;

		assert.ok(port && book?.kind === "selected" && book.current.report);
		const observe = port.observe;
		port.observe = async (state, now) => ({
			...(await observe(state, now)),
			pr: {
				kind: "merged",
				number: 99,
				head: book.current.report!.candidateSha,
				mergeSha: sha("f".repeat(40)),
				actor: "giuseppecrj",
			},
		});
		await f.controller.tick();
		const jobs = await outbox.scan();

		assert.equal(jobs?.[0]?.row?.row.outcome.kind, "landed");
		const remote = new LedgerGit(repo);

		const api = ledgerApiOf(
			new GitHubPublicationApi(remote.exec, repo, EXE_DEV_PLATFORM),
		);

		assert.equal((await pumpLedger(outbox, api, f.clock.now())).published, 1);
		f.github.pulls.set(99, { merged_at: "2026-10-29T01:00:00Z" });
		f.github.reviews.set(99, [
			{
				id: 71,
				state: "APPROVED",
				commit_id: book.current.report.candidateSha,
				body: "Follow up on this",
				submitted_at: "2026-10-29T02:00:00Z",
				user: { login: "writer" },
			},
		]);
		f.github.posts.push("landed_unanswered");

		const exec: Exec = (command, args) =>
			args.some((a) => a.startsWith(`repos/${repo}/git/`))
				? remote.exec(command, args)
				: f.github.exec(command, args);

		port.sweep = controllerCandidatePort({
			platform: EXE_DEV_PLATFORM,
			stateDir: dir,
			exec,
		}).sweep;
		const launches = f.executor.launches.length;

		await f.controller.tick();
		await f.controller.tick();

		const polls = () =>
			f.github.calls.filter((c) => c.includes(`repos/${repo}/pulls/99`)).length;

		assert.equal(polls(), 1);
		f.clock.t += 3_600_001;
		const restarted = f.start();
		await restarted.tick();
		await restarted.tick();

		const proposals = [...f.github.issues.values()].filter((i) =>
			i.labels.includes("factory:proposed"),
		);

		assert.equal(polls(), 2);
		assert.equal(proposals.length, 1);
		assert.ok(!proposals[0]?.labels.includes("factory:ready"));
		assert.equal(f.executor.launches.length, launches);

		const cursor = JSON.parse(
			readFileSync(join(dir, "feedback-sweep", "99.json"), "utf8"),
		);

		assert.deepEqual(cursor.seen, [`github:${repo}:review:71`]);
		assert.equal(restarted.state.runs.size, 0);
	});

	it("holds certified handoff while disabled and resumes the same book without new model spend", async () => {
		const f = await reviewingRun();
		f.executor.behaviors = [{ kind: "pass", usage: 11 }];
		await f.controller.tick();
		assert.equal(f.executor.launches.at(-1)?.stage, "review");
		f.store.local = "disabled";
		await once(f.controller);
		const held = f.files.claims.get(runOf(14))?.handoff;
		assert.ok(held?.kind === "selected");
		assert.equal(held.published, null);
		assert.ok(held.current.certification);
		const launches = f.executor.launches.length;
		await f.controller.tick();
		assert.deepEqual(f.files.claims.get(runOf(14))?.handoff, held);
		f.store.local = "enabled";
		await f.controller.tick();
		await f.controller.tick();
		assert.equal(f.files.claims.get(runOf(14))?.status, "waiting");
		assert.equal(f.files.claims.get(runOf(14))?.usage, 40);
		assert.equal(f.executor.launches.length, launches);
	});

	it("formal durable review intent refuses a failed claim write before any launch", async () => {
		const f = await reviewingRun();
		f.executor.behaviors = [{ kind: "pass", usage: 11 }];
		const before = f.files.claims.get(runOf(14))?.handoff;
		assert.ok(before);
		const write = f.files.writeClaim.bind(f.files);
		let refused = 0;
		f.files.writeClaim = async (claim) => {
			const state = claim.handoff;

			if (
				state?.kind === "selected" &&
				state.work.kind === "effect" &&
				state.work.request.kind === "launch_review"
			) {
				refused++;

				return false;
			}

			return write(claim);
		};

		const launches = f.executor.launches.length;
		await f.controller.tick();
		assert.ok(refused > 0);
		assert.equal(f.executor.launches.length, launches);
		assert.deepEqual(f.files.claims.get(runOf(14))?.handoff, before);
		f.files.writeClaim = write;
		await once(f.controller);
		await f.controller.tick();
		await f.controller.tick();
		assert.equal(f.files.claims.get(runOf(14))?.status, "waiting");
		assert.equal(f.files.claims.get(runOf(14))?.usage, 40);
	});

	it("formal restart reuses the saved captured review intent and public advance projection", async () => {
		const f = await reviewingRun();
		f.executor.behaviors = [{ kind: "pass", usage: 11 }];
		const launch = f.executor.launch.bind(f.executor);
		f.executor.launch = async () => {
			throw new Error("formal crash before external launch");
		};

		await assert.rejects(
			f.controller.tick(),
			/formal crash before external launch/,
		);
		const saved = f.files.claims.get(runOf(14));
		const book = saved?.handoff;
		assert.ok(
			book?.kind === "selected" &&
				book.work.kind === "effect" &&
				book.work.request.kind === "launch_review",
		);
		const request = book.work.request;
		const execution = request.execution;
		assert.equal(execution.attempt, 1);
		f.executor.candidateSpent.set(execution.id, 0);
		const output = f.executor.output.bind(f.executor);
		let recovering = true;
		f.executor.output = async (input) =>
			recovering && input.execution?.id === execution.id
				? { kind: "pending" }
				: output(input);
		f.executor.launch = async (input) => {
			assert.deepEqual(input.execution, execution);
			assert.deepEqual(
				f.files.claims.get(runOf(14))?.handoff?.accounts,
				book.accounts,
			);
			recovering = false;

			return launch(input);
		};

		const restarted = f.start();
		await restarted.tick();

		const pure: Run = {
			id: book.pin.runId,
			repo: book.pin.repo,
			baseSha: book.pin.originalBase,
			ticket: {
				provider: "github",
				key: `${repo}#14`,
				url: `https://github.com/${repo}/issues/14`,
			},
			handoff: book,
			progress: candidateProjection(book).progress,
		};

		const step = advance(pure, {
			kind: "candidate",
			event: {
				kind: "effect_completed",
				completion: { kind: "launch_review", request, started: true },
			},
		});

		assert.equal(step.kind, "advanced");
		assert.deepEqual(f.files.claims.get(runOf(14))?.handoff, step.run.handoff);
		await once(restarted);
		await restarted.tick();
		assert.equal(f.files.claims.get(runOf(14))?.status, "waiting");
		assert.equal(f.files.claims.get(runOf(14))?.usage, 40);
		assert.equal(
			f.executor.launches.filter(
				(entry) => entry.execution?.id === execution.id,
			).length,
			1,
		);
		const marker = parseMarker(f.github.markers(14).at(-1) ?? "");
		assert.equal(marker.kind, "marker");

		if (marker.kind === "marker") assert.equal(marker.marker.usage, 40);
	});

	for (const lost of ["open_pr", "complete_handoff"] as const)
		it(`formal restart reconciles a lost ${lost} response from the persisted effect without model spend`, async () => {
			const f = await reviewingRun();
			f.executor.behaviors = [{ kind: "pass", usage: 11 }];
			const port = f.executor.candidate;
			assert.ok(port);
			const execute = port.execute;
			let interrupted = false;
			port.execute = async (state, request) => {
				assert.deepEqual(f.files.claims.get(runOf(14))?.handoff, state);

				if (request.kind === lost && !interrupted) {
					interrupted = true;
					await execute(state, request);

					return null;
				}

				return execute(state, request);
			};

			await once(f.controller);

			for (let tick = 0; tick < 4 && !interrupted; tick++)
				await f.controller.tick();
			assert.equal(interrupted, true);
			const saved = f.files.claims.get(runOf(14));
			assert.ok(saved?.handoff?.kind === "selected");
			assert.equal(saved.handoff.work.kind, "effect");

			if (saved.handoff.work.kind === "effect")
				assert.equal(saved.handoff.work.request.kind, lost);
			const launches = f.executor.launches.length;
			port.execute = execute;
			const restarted = f.start();
			await restarted.tick();
			await restarted.tick();
			await restarted.tick();
			const restored = f.files.claims.get(runOf(14));
			assert.equal(restored?.status, "waiting");
			assert.equal(restored.usage, 40);
			assert.equal(f.executor.launches.length, launches);
			assert.ok(restored.handoff?.kind === "selected");
			assert.equal(restored.handoff.published?.number, 99);
			assert.deepEqual(restored.handoff.accounts, saved.handoff.accounts);
			assert.ok(
				parseCandidateState(JSON.parse(JSON.stringify(restored.handoff))),
			);
		});

	it("waiting uses no slot while two other issues enter execution", async () => {
		const f = await reviewingRun();
		f.executor.behaviors = [{ kind: "pass", usage: 11 }];
		await once(f.controller);
		await f.controller.tick();
		await f.controller.tick();
		assert.equal(f.files.claims.get(runOf(14))?.status, "waiting");
		const launches = f.executor.launches.length;
		f.github.add(labeled(15));
		f.github.add(labeled(16));
		const report = await f.controller.tick();
		assert.equal(report.active, 2);
		assert.equal(f.controller.state.runs.size, 3);
		assert.equal(f.executor.launches.length, launches + 2);
		assert.equal(f.files.claims.get(runOf(14))?.usage, 40);
		assert.equal(f.files.claims.get(runOf(14))?.status, "waiting");
	});

	async function cappedRun(stage: "build" | "review") {
		const f = stage === "review" ? await reviewingRun() : await waitingRun();

		f.executor.ready = true;

		if (stage === "build") {
			const validate = f.executor.validate;
			f.executor.validate = async (input) => {
				const result = await validate(input);

				if (result.state === null) throw new Error("validation state");

				const verdict = failingVerdict(digestOf("patch"));

				return {
					kind: "finished",
					state: result.state,
					verdict,
					assessment: f.executor.assess(input, verdict),
				};
			};

			const launch = f.executor.launch;
			f.executor.launch = async (input) => ({
				kind: "unavailable",
				stage: input.stage,
				reason: "sandbox_unavailable",
			});
			await f.controller.tick();
			f.executor.launch = launch;
			assert.equal(f.files.claims.get(runOf(14))?.round, 1);
		}

		const state = stateDir();

		const disk = sandboxExecutor({
			platform: EXE_DEV_PLATFORM,
			stateDir: state,
			exec: async () => ({ code: 0, stdout: "", stderr: "" }),
			log: () => {},
			xdgRuntimeDir: "/run/user/1000",
		});

		f.executor.spent = disk.spent;
		const output = f.executor.output.bind(f.executor);
		let reviewPassed = false;
		f.executor.output = async (input) =>
			input.stage === "review" && !reviewPassed ? null : output(input);
		const launch = f.executor.launch.bind(f.executor);

		const executionDir = (input: StageLaunchInput) =>
			join(
				state,
				"stages",
				input.runId,
				`${input.stage}${input.stage === "review" || input.round ? `-r${input.round ?? 0}` : ""}-${input.attempt}`,
			);

		f.executor.launch = async (input) => {
			if (input.execution !== undefined) {
				const dir = executionDir(input);
				mkdirSync(dir, { recursive: true, mode: 0o700 });
				writeFileSync(
					join(dir, "execution.json"),
					`${JSON.stringify(input.execution)}\n`,
					{
						mode: 0o600,
					},
				);
			}

			const previous = (await disk.spent(input)) ?? 0;
			const result = await launch(input);

			if (result.kind !== "started") return result;

			return {
				...result,
				done: result.done.then((finished) => {
					reviewPassed = input.stage === "review" && finished.kind === "passed";
					const dir = executionDir(input);
					mkdirSync(dir, { recursive: true, mode: 0o700 });
					writeFileSync(
						join(dir, "receipt.json"),
						JSON.stringify({
							...finished.receipt,
							usage: {
								...finished.receipt.usage,
								total: previous + finished.usage,
							},
						}),
						{ mode: 0o600 },
					);

					return finished;
				}),
			};
		};

		return { ...f, state, executionDir };
	}

	for (const stage of ["build", "review"] as const) {
		for (const restart of [false, true])
			it(`keeps ${stage} retries within one round${restart ? " after process recovery" : ""}`, async () => {
				const f = await cappedRun(stage);

				const spent =
					stage === "build" ? REPAIR_BUILD_MAX_TOKENS / 2 + 169 : 12_000;

				const cap =
					stage === "build" ? REPAIR_BUILD_MAX_TOKENS : REVIEW_MAX_TOKENS;

				if (stage === "build")
					f.executor.buildBehavior = { kind: "fail", usage: spent };
				else f.executor.behaviors = [{ kind: "fail", usage: spent }];
				await once(f.controller);
				assert.equal(f.files.claims.get(runOf(14))?.attempt, 2);

				if (stage === "build")
					f.executor.buildBehavior = { kind: "pass", usage: 11 };
				else f.executor.behaviors = [{ kind: "pass", usage: 11 }];
				f.clock.t += 60_000;
				const controller = restart ? f.start() : f.controller;
				await once(controller);

				const attempts = f.executor.launches.filter(
					(entry) =>
						entry.stage === stage &&
						entry.round === (stage === "build" ? 1 : 0),
				);

				assert.deepEqual(
					attempts.map((entry) => entry.settings.maxTokens),
					[cap, cap - spent],
				);
				assert.equal(f.files.claims.get(runOf(14))?.usage, 29 + spent + 11);

				if (stage === "review") {
					await controller.tick();
					await controller.tick();
				}

				assert.equal(
					stage === "review"
						? f.files.claims.get(runOf(14))?.status
						: f.files.claims.get(runOf(14))?.stage,
					stage === "review" ? "waiting" : "validate",
				);
			});

		it(`counts interrupted ${stage} gateway usage before a retry in the same round`, async () => {
			const f = await cappedRun(stage);

			const interrupted =
				(stage === "build" ? REPAIR_BUILD_MAX_TOKENS / 2 : 25_000) + 169;

			if (stage === "build") f.executor.buildBehavior = { kind: "hang" };
			else f.executor.behaviors = [{ kind: "hang" }];
			await f.controller.tick();
			const first = f.executor.launches.at(-1);
			assert.ok(first);
			const dir = f.executionDir(first);
			mkdirSync(dir, { recursive: true, mode: 0o700 });
			writeFileSync(
				join(dir, "egress.jsonl"),
				JSON.stringify({
					inputTokens: stage === "build" ? REPAIR_BUILD_MAX_TOKENS / 2 : 25_000,
					outputTokens: 169,
				}) + "\n",
			);

			if (stage === "build")
				f.executor.buildBehavior = { kind: "pass", usage: 11 };
			else f.executor.behaviors = [{ kind: "pass", usage: 11 }];
			const restarted = f.start();
			await once(restarted);
			f.clock.t += 60_000;
			await once(restarted);
			assert.equal(f.executor.launches.at(-1)?.attempt, 2);
			assert.equal(
				f.executor.launches.at(-1)?.settings.maxTokens,
				(stage === "build" ? REPAIR_BUILD_MAX_TOKENS : REVIEW_MAX_TOKENS) -
					interrupted,
			);
			assert.equal(f.files.claims.get(runOf(14))?.usage, 29 + interrupted + 11);
		});

		it(`does not launch or approve ${stage} after cumulative round exhaustion`, async () => {
			const f = await cappedRun(stage);

			const cap =
				stage === "build" ? REPAIR_BUILD_MAX_TOKENS : REVIEW_MAX_TOKENS;

			if (stage === "build")
				f.executor.buildBehavior = { kind: "fail", usage: cap / 2 };
			else f.executor.behaviors = [{ kind: "fail", usage: cap / 2 }];
			await once(f.controller);
			f.clock.t += 60_000;

			if (stage === "review")
				f.executor.behaviors = [{ kind: "fail", usage: cap / 2 }];
			await once(f.controller);
			assert.equal(f.executor.launches.at(-1)?.settings.maxTokens, cap / 2);
			const launches = f.executor.launches.length;
			f.clock.t += 60_000;
			await once(f.start());
			assert.equal(f.executor.launches.length, launches);
			assert.equal(f.files.claims.get(runOf(14))?.status, "budget_exhausted");
			assert.equal(f.files.claims.get(runOf(14))?.usage, 29 + cap);
		});
	}

	it("subtracts failed attempts and retained review seats once on process recovery", async () => {
		const f = await cappedRun("review");
		f.executor.behaviors = [{ kind: "fail", usage: 12_000 }];
		await once(f.controller);
		f.executor.behaviors = [{ kind: "hang" }];
		f.clock.t += 60_000;
		await f.controller.tick();
		const issued = f.executor.launches.at(-1);
		assert.ok(
			issued?.execution?.stage === "review" && issued.review !== undefined,
		);
		const dir = join(f.state, "stages", runOf(14), "review-r0-2");
		mkdirSync(join(dir, "code-review"), { recursive: true, mode: 0o700 });
		writeFileSync(
			join(dir, "review.json"),
			JSON.stringify({
				version: 2,
				execution: issued.execution,
				binding: issued.review.input.binding,
				seats: issued.review.input.seats,
				inputDigest: digestOf(
					JSON.stringify({
						binding: issued.review.input.binding,
						seats: issued.review.input.seats,
						files: [...issued.review.input.files],
						scenarios: issued.review.input.scenarios,
						prompt: issued.review.input.prompt,
					}),
				),
			}),
			{ mode: 0o600 },
		);
		writeFileSync(
			join(dir, "code-review/receipt.json"),
			JSON.stringify({ usage: { total: 4_000 } }),
		);
		const output = f.executor.output.bind(f.executor);
		f.executor.output = async (input) =>
			input.stage === "review" &&
			input.attempt === 2 &&
			!existsSync(join(dir, "receipt.json"))
				? { kind: "pending" }
				: output(input);
		f.executor.behaviors = [{ kind: "pass", usage: 11 }];
		f.clock.t += 60_000;
		const restarted = f.start();
		await once(restarted);
		assert.equal(f.executor.launches.at(-1)?.attempt, 2);
		assert.equal(
			f.executor.launches.at(-1)?.settings.maxTokens,
			REVIEW_MAX_TOKENS - 12_000 - 4_000,
		);
		assert.equal(
			f.executor.launches.at(-1)?.remainingRunTokens,
			TRUSTED_RUN_CAP - 29 - 12_000 - 4_000,
		);
		assert.equal(
			f.files.claims.get(runOf(14))?.usage,
			29 + 12_000 + 4_000 + 11,
		);
		await restarted.tick();
		await restarted.tick();
		assert.equal(f.files.claims.get(runOf(14))?.status, "waiting");
		assert.equal(
			await f.executor.spent({
				runId: runOf(14),
				stage: "review",
				attempt: 2,
				round: 0,
			}),
			4_011,
		);
		assert.equal(restarted.state.totals.usage, 4_011);
	});

	for (const stage of ["specify", "accept", "build"] as const)
		it(`keeps ${stage}'s original attempt accounting outside repair rounds`, async () => {
			const f = world();
			f.github.add(labeled(14));
			f.executor.ready = true;
			f.executor.behaviors = [
				{
					kind: stage === "specify" ? "fail" : "pass",
					usage: stage === "specify" ? 200 : 10,
				},
			];
			f.executor.acceptBehavior = {
				kind: stage === "accept" ? "fail" : "pass",
				usage: stage === "accept" ? 200 : 7,
			};
			f.executor.buildBehavior = { kind: "fail", usage: 200 };
			const controller = f.start();
			await once(controller);

			if (stage === "build") await once(controller);
			f.executor.spentBy.set(`${stage}-1`, 200);
			f.executor.behaviors = [{ kind: "pass", usage: 11 }];
			f.executor.acceptBehavior = { kind: "pass", usage: 11 };
			f.executor.buildBehavior = { kind: "pass", usage: 11 };
			f.clock.t += 60_000;
			await once(controller);

			const attempts = f.executor.launches.filter(
				(entry) => entry.stage === stage,
			);

			const cap =
				stage === "specify"
					? null
					: stage === "accept"
						? ACCEPTANCE_MAX_TOKENS
						: BUILD_MAX_TOKENS;

			assert.deepEqual(
				attempts.map((entry) => entry.settings.maxTokens),
				[cap, cap],
			);
			assert.equal(
				attempts[1]?.remainingRunTokens,
				TRUSTED_RUN_CAP -
					200 -
					(stage === "specify" ? 0 : stage === "accept" ? 10 : 17),
			);
		});

	it("gives a fresh repair round its own allowance without refreshing the run budget", async () => {
		const f = await cappedRun("build");
		f.executor.buildBehavior = { kind: "pass", usage: 25_169 };
		await once(f.controller);
		await f.controller.tick();
		assert.equal(f.files.claims.get(runOf(14))?.round, 2);
		await once(f.controller);
		assert.equal(
			f.executor.launches.at(-1)?.settings.maxTokens,
			REPAIR_BUILD_MAX_TOKENS,
		);
		assert.equal(
			f.executor.launches.at(-1)?.remainingRunTokens,
			TRUSTED_RUN_CAP - 29 - 25_169,
		);
	});

	it("shares the pure machine's two-round cap and resumes a repair without round-zero output", async () => {
		const f = await waitingRun();
		let expected: CandidateState | undefined;
		f.executor.validate = async (input) => {
			const round = input.round ?? 0;

			const state = input.state ?? {
				version: 1,
				startedAt: input.now,
				deadline: input.now + input.wallMs,
				round,
				originalBase: input.baseSha,
				baseSha: input.baseSha,
				baseResolved: true,
				publication: {
					branch: `factory/run/14-${input.runId.slice(0, 12)}-r${round}`,
					patchSha: sha("b".repeat(40)),
					candidateSha: sha("c".repeat(40)),
				},
				dispatchTry: 1,
				dispatchedAt: input.now,
				ciRunId: 123,
				counters: {},
			};

			await input.save(state);

			const verdict = failingVerdict(
				digestOf(round ? `patch-r${round}` : "patch"),
			);

			const assessment = f.executor.assess(input, verdict);
			const book = f.files.claims.get(runOf(14))?.handoff;
			assert.ok(
				book?.kind === "selected" &&
					book.work.kind === "effect" &&
					book.work.request.kind === "validate",
			);

			const pure: Run = {
				id: book.pin.runId,
				repo: book.pin.repo,
				baseSha: book.pin.originalBase,
				ticket: {
					provider: "github",
					key: `${book.pin.repo}#14`,
					url: `https://github.com/${book.pin.repo}/issues/14`,
				},
				handoff: book,
				progress: candidateProjection(book).progress,
			};

			const decision = advance(pure, {
				kind: "candidate",
				event: {
					kind: "effect_completed",
					completion: {
						kind: "validate",
						request: book.work.request,
						result: {
							kind: "finished",
							validation: state,
							verdict,
							report: null,
							seats: ["code-review", "security-review", "simplify"],
							assessment,
						},
					},
				},
			});

			assert.equal(decision.kind, "advanced");
			expected = decision.run.handoff;

			return { kind: "finished", state, verdict, assessment };
		};

		await f.controller.tick();
		assert.deepEqual(f.files.claims.get(runOf(14))?.handoff, expected);
		assert.equal(f.files.claims.get(runOf(14))?.round, 1);
		assert.equal(f.files.claims.get(runOf(14))?.validation, undefined);
		const restarted = f.start();
		await once(restarted);

		const repair = f.executor.launches.find(
			(entry) => entry.stage === "build" && entry.round === 1,
		);

		assert.equal(repair?.build?.binding.round, 1);
		assert.equal(repair?.settings.maxTokens, REPAIR_BUILD_MAX_TOKENS);
		assert.equal(
			f.executor.launches.filter(
				(entry) => entry.stage === "build" && entry.round === 1,
			).length,
			1,
		);
		await once(restarted);
		assert.equal(f.files.claims.get(runOf(14))?.round, 2);
		await once(restarted);
		await restarted.tick();
		assert.equal(f.files.claims.get(runOf(14))?.status, "failed");
		assert.equal(f.files.claims.get(runOf(14))?.round, 2);
		assert.equal(
			f.executor.launches.filter((entry) => entry.stage === "build").length,
			3,
		);
	});

	for (const receipt of ["missing", "drifted"] as const)
		it(`refuses a repair build before launch when the stored base receipt is ${receipt}`, async () => {
			const f = await waitingRun();
			f.executor.validate = async (input) => {
				const round = input.round ?? 0;

				const state = input.state ?? {
					version: 1,
					startedAt: input.now,
					deadline: input.now + input.wallMs,
					round,
					originalBase: input.baseSha,
					baseSha: input.baseSha,
					baseResolved: true,
					publication: {
						branch: `factory/run/14-${input.runId.slice(0, 12)}-r${round}`,
						patchSha: sha("b".repeat(40)),
						candidateSha: sha("c".repeat(40)),
					},
					dispatchTry: 1,
					dispatchedAt: input.now,
					ciRunId: 123,
					counters: {},
				};

				await input.save(state);

				const verdict = failingVerdict(
					digestOf(round ? `patch-r${round}` : "patch"),
				);

				return {
					kind: "finished",
					state,
					verdict,
					assessment: f.executor.assess(input, verdict),
				};
			};

			await f.controller.tick();
			assert.equal(f.files.claims.get(runOf(14))?.round, 1);
			const checks = f.executor.baseChecks.length;

			f.executor.baseCheck = async (input) => {
				f.executor.baseChecks.push(input);

				return receipt === "missing"
					? {
							kind: "refused",
							failure: {
								binding: input.binding,
								receiptDigest: digestOf("missing"),
								reason: "base_evidence_missing",
								scenarios: [],
							},
						}
					: {
							kind: "ready",
							proof: qualifiedProof({
								...input.binding,
								acceptanceDigest: digestOf("drifted suite"),
							}),
						};
			};

			const restarted = f.start();
			await once(restarted);

			for (let tick = 0; tick < 4; tick++) {
				await restarted.tick();
				await settle();
				f.clock.t += 600_000;
			}

			assert.equal(
				f.executor.launches.filter(
					(entry) => entry.stage === "build" && entry.round === 1,
				).length,
				0,
			);
			assert.equal(f.files.claims.get(runOf(14))?.status, "failed");

			const ended = statuses(f.github, 14).filter((s) => s.endsWith(":failed"));

			assert.equal(ended.length, 1);
			assert.equal(statuses(f.github, 14).at(-1), ended[0]);
			const refused = keyed(f.github, 14, "base-refusal");
			assert.equal(refused.length, 1);
			assert.match(
				refused[0] ?? "",
				/^Acceptance refused before build: base_evidence_missing\. Base qualification evidence is incomplete or invalid\.\n\n<!-- factory-base-refusal /,
			);
			const settledChecks = f.executor.baseChecks.length;
			await restarted.tick();
			await settle();
			assert.equal(f.executor.baseChecks.length, settledChecks);
			assert.equal(keyed(f.github, 14, "base-refusal").length, 1);
			const repairChecks = f.executor.baseChecks.slice(checks);
			assert.ok(repairChecks.length > 0);
			assert.ok(repairChecks.every((c) => c.readOnly === true));
			assert.ok(
				f.logs.some(
					(e) =>
						e.event === "stage_inputs_refused" &&
						e.fields.why === "base_evidence_missing",
				),
			);
		});

	function assessedValidator(
		f: Awaited<ReturnType<typeof waitingRun>>,
		failure: import("../../../src/candidate/diagnosis.ts").FailureClass,
		verdictOf = failingVerdict,
	): import("../../../src/candidate/validation.ts").Validator {
		return async (input) => {
			const round = input.round ?? 0;

			const state = input.state ?? {
				version: 1,
				startedAt: input.now,
				deadline: input.now + input.wallMs,
				round,
				originalBase: input.baseSha,
				baseSha: input.baseSha,
				baseResolved: true,
				publication: {
					branch: `factory/run/14-${input.runId.slice(0, 12)}-r${round}`,
					patchSha: sha("b".repeat(40)),
					candidateSha: sha("c".repeat(40)),
				},
				dispatchTry: 1,
				dispatchedAt: input.now,
				ciRunId: 123,
				counters: {},
			};

			await input.save(state);

			if (round > 0) return { kind: "waiting", state };
			const verdict = verdictOf(digestOf("patch"));
			const generation = input.generation?.generation ?? 0;

			const { text, read } = storedAssessment({
				runId: input.runId,
				round,
				generation,
				verdict,
				assessment: { kind: "failed", failure },
			});

			f.executor.assessments.set(`${input.runId}/${round}/${generation}`, text);

			return { kind: "finished", state, verdict, assessment: read };
		};
	}

	async function drive(
		controller: Awaited<ReturnType<typeof waitingRun>>["controller"],
		f: Awaited<ReturnType<typeof waitingRun>>,
	) {
		for (let tick = 0; tick < 4; tick++) {
			await controller.tick();
			await settle();
			f.clock.t += 600_000;
		}
	}

	it("ends a #576-shape failure as missing evidence with zero repairs", async () => {
		const f = await waitingRun();
		const failure = classifiedCase("tree_disagreement");
		assert.deepEqual(failure, {
			kind: "missing_evidence",
			reason: "tree_replays_disagree",
		});
		f.executor.validate = assessedValidator(f, failure);
		await drive(f.controller, f);

		assert.equal(
			f.executor.launches.filter(
				(entry) => entry.stage === "build" && (entry.round ?? 0) > 0,
			).length,
			0,
		);
		const claim = f.files.claims.get(runOf(14));
		assert.equal(claim?.status, "failed");
		assert.equal(claim?.round, 0);
		const book = claim?.handoff;
		assert.ok(book?.kind === "selected");
		assert.deepEqual(book.work, {
			kind: "terminal",
			terminal: { kind: "failed", reason: "diagnosis_missing_evidence" },
		});

		const notices = keyed(f.github, 14, "diagnosis");
		assert.equal(notices.length, 1);
		assert.match(
			notices[0] ?? "",
			/^Stopped: CI diagnosis could not establish reliable evidence\. Gate and candidate replays disagree\. Retained private patch: [a-f0-9]{64}\.\n\n<!-- factory-diagnosis run=[a-f0-9]{64} g=0\.0 a=[a-f0-9]{64} -->$/,
		);
		await f.controller.tick();
		await settle();
		assert.equal(keyed(f.github, 14, "diagnosis").length, 1);
	});

	it("shows the owner an H2-shape dead end's other failed visible checks and retained patch, with no held-out content and no repair", async () => {
		const dir = stateDir();
		const outbox = fileLedgerOutbox(dir);

		const f = await waitingRun((world) => {
			const native = fileRunFiles(dir);
			Object.assign(world.files, {
				ledger: outbox,
				accounting: native.accounting,
			});
		});

		const failure = classifiedCase("tree_disagreement");
		const patch = digestOf("patch");

		// H2: tree disagreement plus failing lint and candidate_tests.
		f.executor.validate = assessedValidator(f, failure, (digest) => {
			const verdict = failingVerdict(digest);

			return {
				...verdict,
				checks: verdict.checks.map((check) =>
					check.name === "lint" || check.name === "candidate_tests"
						? { ...check, passed: false, detail: "PRIVATE-CHECK-DETAIL" }
						: check,
				),
			};
		});
		await drive(f.controller, f);

		assert.equal(
			f.executor.launches.filter(
				(entry) => entry.stage === "build" && (entry.round ?? 0) > 0,
			).length,
			0,
		);
		const [notice, ...others] = keyed(f.github, 14, "diagnosis");
		assert.equal(others.length, 0);
		assert.match(
			notice ?? "",
			new RegExp(
				`^Stopped: CI diagnosis could not establish reliable evidence\\. Gate and candidate replays disagree\\. Other failed checks: lint, candidate_tests\\. Retained private patch: ${patch}\\.\\n\\n<!-- factory-diagnosis `,
			),
		);

		const failed = {
			kind: "known",
			value: {
				stage: "validate",
				class: "missing_evidence",
				reason: "tree_replays_disagree",
				failedVisibleChecks: ["lint", "candidate_tests"],
				retainedPatch: patch,
			},
		};

		const row = (await outbox.scan())?.[0]?.row?.row;
		assert.ok(row?.v === 5);
		assert.deepEqual(row.failure, failed);
		assert.deepEqual(row.outcome, {
			kind: "failed",
			stage: "land",
			cause: { kind: "known", value: "evidence_missing" },
		});

		const status = await readRunCharges(dir, runOf(14), 0);
		assert.deepEqual(status.terminal, {
			outcome: row.outcome,
			failure: failed,
		});

		for (const text of [
			notice ?? "",
			JSON.stringify(row),
			JSON.stringify(status),
		]) {
			assert.doesNotMatch(text, /"heldout"|1 failing|PRIVATE-CHECK-DETAIL/);
			assert.doesNotMatch(text, /version\.test\.ts|checks\//);
		}
	});

	it("repairs a candidate load error after a qualified base exactly once, bound to its assessment", async () => {
		const f = await waitingRun();
		const failure = classifiedCase("candidate_load_error");
		assert.equal(failure.kind, "candidate");
		f.executor.validate = assessedValidator(f, failure);
		await drive(f.controller, f);

		const repairs = f.executor.launches.filter(
			(entry) => entry.stage === "build" && (entry.round ?? 0) > 0,
		);

		assert.equal(repairs.length, 1);
		const execution = repairs[0]?.execution;
		assert.ok(execution?.stage === "build");
		const stored = f.executor.assessments.get(`${runOf(14)}/0/0`);
		assert.ok(stored !== undefined);
		assert.deepEqual(execution.cause, {
			kind: "validation",
			assessment: readAssessmentBytes(stored)?.ref,
		});
		assert.ok(f.executor.assessmentReads.includes(`${runOf(14)}/0/0`));
		assert.equal(keyed(f.github, 14, "diagnosis").length, 0);
	});

	for (const stored of [true, false])
		it(`launches ${stored ? "one repair" : "no repair"} through the production executor's assessment reader when the candidate assessment is ${stored ? "stored" : "absent"}`, async () => {
			const f = await waitingRun();
			const state = stateDir();

			const disk = sandboxExecutor({
				platform: EXE_DEV_PLATFORM,
				stateDir: state,
				exec: async () => ({ code: 0, stdout: "", stderr: "" }),
				log: () => {},
				xdgRuntimeDir: "/run/user/1000",
			});

			f.executor.readAssessment = disk.readAssessment.bind(disk);

			const validate = assessedValidator(
				f,
				classifiedCase("candidate_load_error"),
			);

			f.executor.validate = async (input) => {
				const result = await validate(input);

				for (const [key, text] of f.executor.assessments) {
					const [runId, round, generation] = key.split("/");

					const dir = validationDir(
						state,
						runId ?? "",
						Number(round),
						Number(generation),
					);

					mkdirSync(dir, { recursive: true, mode: 0o700 });

					if (stored)
						writeFileSync(join(dir, "assessment.json"), text, {
							mode: 0o600,
						});
				}

				f.executor.assessments.clear();

				return result;
			};

			await drive(f.controller, f);

			assert.equal(
				f.executor.launches.filter(
					(entry) => entry.stage === "build" && (entry.round ?? 0) > 0,
				).length,
				stored ? 1 : 0,
			);
		});

	it("does not repair a restored repair_due whose assessment is missing", async () => {
		const f = await waitingRun();
		f.executor.validate = assessedValidator(
			f,
			classifiedCase("candidate_load_error"),
		);
		await f.controller.tick();
		assert.equal(f.files.claims.get(runOf(14))?.round, 1);
		assert.equal(
			f.executor.launches.filter(
				(entry) => entry.stage === "build" && (entry.round ?? 0) > 0,
			).length,
			0,
		);
		f.executor.assessments.clear();
		const restarted = f.start();
		await once(restarted);
		await drive(restarted, f);

		assert.equal(
			f.executor.launches.filter(
				(entry) => entry.stage === "build" && (entry.round ?? 0) > 0,
			).length,
			0,
		);
		const claim = f.files.claims.get(runOf(14));
		assert.equal(claim?.status, "failed");
		const book = claim?.handoff;
		assert.ok(book?.kind === "selected");
		assert.deepEqual(book.work, {
			kind: "terminal",
			terminal: { kind: "failed", reason: "diagnosis_missing_evidence" },
		});
	});

	for (const field of ["candidate", "ciRun"] as const)
		it(`posts another marker when only ${field} changes`, async () => {
			const f = await waitingRun();
			const before = f.github.markers(14).length;
			f.executor.validate = async (input) => {
				const state = input.state;

				if (state?.publication == null) throw new Error("fixture");

				if (field === "candidate")
					state.publication = {
						...state.publication,
						candidateSha: sha("d".repeat(40)),
					};
				else state.ciRunId = 124;
				await input.save(state);

				return { kind: "waiting", state };
			};

			await f.controller.tick();
			assert.equal(f.github.markers(14).length, before + 1);
			const last = parseMarker(f.github.markers(14).at(-1) ?? "");
			assert.equal(last.kind, "marker");

			if (last.kind === "marker")
				assert.equal(
					last.marker[field],
					field === "candidate" ? "d".repeat(40) : 124,
				);
		});

	it("fails closed when a published marker loses its private validation state", async () => {
		const f = await waitingRun();
		const claim = f.files.claims.get(runOf(14));

		if (claim === undefined) throw new Error("fixture");
		const missing = { ...claim };
		delete missing.validation;
		delete missing.handoff;
		f.files.claims.set(runOf(14), missing);
		let calls = 0;
		f.executor.validate = async (input) => {
			calls++;

			return { kind: "waiting", state: input.state ?? claim.validation! };
		};

		const result = await f.start().tick();
		assert.equal(calls, 0);
		assert.equal(result.totals.failures, 1);
		assert.ok(
			f.logs.some(
				(entry) =>
					entry.event === "validation_failed" &&
					entry.fields.why === "validation_state_missing",
			),
		);
	});

	it("keeps cleanup identities when adopting a remotely ended marker", async () => {
		const f = await waitingRun();
		const claim = f.files.claims.get(runOf(14));
		const last = parseMarker(f.github.markers(14).at(-1) ?? "");

		if (last.kind !== "marker") throw new Error("fixture");
		f.github.comment(
			f.github.issues.get(14)!,
			formatMarker({
				...last.marker,
				status: "failed",
				seq: last.marker.seq + 1,
			}),
		);
		await f.start().tick();
		assert.deepEqual(
			validationOf(f.files.claims.get(runOf(14))),
			validationOf(claim),
		);
		assert.equal(f.files.claims.get(runOf(14))?.status, "failed");
	});

	it("does not progress an awaiting run on an unconfirmed issue read", async () => {
		const f = await waitingRun();
		let calls = 0;
		const validate = f.executor.validate;
		f.executor.validate = async (input) => {
			calls++;

			return validate(input);
		};

		f.github.failures.set(`repos/${FAKE_REPO}/issues/14`, networkError());
		await f.controller.tick();
		assert.equal(calls, 0);
	});

	it("retains publication identities when a waiting run is released across restart", async () => {
		const { github, executor, files, start } = world();
		const issue = github.add(labeled(14));
		executor.behaviors = [{ kind: "pass", usage: 10 }];
		executor.acceptBehavior = { kind: "pass", usage: 7 };
		executor.buildBehavior = { kind: "pass", usage: 12 };
		executor.validate = async (input) => {
			const state = {
				version: 1,
				startedAt: input.now,
				deadline: input.now + input.wallMs,
				round: 0,
				originalBase: input.baseSha,
				baseSha: input.baseSha,
				baseResolved: true,
				publication: {
					branch: `factory/run/14-${input.runId.slice(0, 12)}-r0`,
					patchSha: sha("b".repeat(40)),
					candidateSha: sha("c".repeat(40)),
				},
				dispatchTry: 1,
				dispatchedAt: input.now,
				ciRunId: 123,
				counters: {},
			} as const;

			await input.save(state);

			return { kind: "waiting", state };
		};

		const first = start();
		await once(first);
		await once(first);
		await first.tick();
		const publication = validationOf(files.claims.get(runOf(14)))?.publication;
		assert.ok(publication);
		issue.labels = [];
		issue.updatedAt = "2026-10-29T03:00:00Z";
		const report = await start().tick();
		assert.deepEqual(report.runs, []);
		assert.equal(files.claims.get(runOf(14))?.status, "released");
		assert.deepEqual(
			validationOf(files.claims.get(runOf(14)))?.publication,
			publication,
		);
	});
	it("adopts a v1 validate marker on the old workflow without a model interruption or slot", async () => {
		const { github, executor, start, clock } = world();
		const issue = github.add(labeled(14));

		const legacy = TRUSTED_WORKFLOW.replace(
			"  validate:\n",
			"  validate:\n    model: openai/gpt-6.1-sol\n",
		);

		github.workflow = legacy;
		executor.workflow = () => legacy;
		executor.behaviors = [{ kind: "pass", usage: 10 }];
		executor.acceptBehavior = { kind: "pass", usage: 7 };
		executor.buildBehavior = { kind: "pass", usage: 12 };
		const first = start();
		await once(first);
		const built = await once(first);
		assert.equal(built.active, 0);
		await first.tick();
		const last = issue.comments.at(-1);
		assert.ok(last);
		const parsed = parseMarker(last.body);
		assert.equal(parsed.kind, "marker");

		if (parsed.kind !== "marker") return;
		assert.equal(parsed.marker.stage, "validate");
		last.body = formatMarker({ ...parsed.marker, v: 1 });
		clock.t += 60_000;
		const restored = start();
		const report = await restored.tick();
		assert.equal(report.active, 0);
		assert.equal(report.totals.retries, 0);
		assert.equal(restored.state.runs.get(14)?.phase.kind, "candidate");
		assert.equal(restored.state.runs.get(14)?.attempt, 1);
		assert.equal(executor.validations.length, 2);
		assert.equal(
			executor.validations[0]?.generation?.digest,
			executor.validations[1]?.generation?.digest,
		);
		assert.equal(
			executor.launches.filter((launch) => launch.stage === "build").length,
			1,
		);
		assert.equal(executor.launches.length, 3);
	});
});
