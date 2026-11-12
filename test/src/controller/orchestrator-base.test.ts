import {
	ACCEPTANCE_MAX_TOKENS,
	SCAN_SENTENCE,
} from "../../../src/contract/acceptance.ts";
import assert from "node:assert/strict";
import {
	existsSync,
	mkdirSync,
	renameSync,
	readFileSync,
	writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { describe, it } from "node:test";
import { fileLedgerOutbox } from "../../../host/controller/outbox.ts";
import { fileRunFiles } from "../../../host/controller/run-files.ts";
import { controllerBaseChecker } from "../../../host/controller/checkers.ts";
import { Orchestrator } from "../../../src/controller/orchestrator.ts";
import type { ClaimRecord } from "../../../src/controller/claims.ts";
import type {
	StageLaunch,
	StageResult,
} from "../../../src/controller/launch.ts";
import { qualifiedProof } from "../../helpers.ts";
import {
	assessBase,
	type AcceptRetry,
} from "../../../src/candidate/diagnosis.ts";
import { type Digest, digestOf } from "../../../src/core/run.ts";
import {
	FakeGitHub,
	MAIN_SHA,
	TRUSTED_RUN_CAP,
} from "../../fake-ticket-adapter.ts";
import {
	repo,
	sha,
	FakeClock,
	resultOf,
	ACCEPTANCE_TEXT,
	FakeExecutor,
	labeled,
	runOf,
	world,
	statuses,
	instrument,
	replayAcceptStop,
	stateDir,
	endedClaim,
	setWorkflow,
	settle,
	once,
	keyed,
	refusedReceipt,
} from "./orchestrator-fixtures.ts";

describe("Orchestrator base qualification", () => {
	it("rejects a hand-edited storedAttempt before reusing a base check", async () => {
		const { github, executor, files, clock, start } = world();
		github.add(labeled(14));
		executor.behaviors = [{ kind: "pass", usage: 10 }];
		executor.acceptBehavior = { kind: "pass", usage: 20 };
		executor.baseOutcome = "interrupted";
		await once(start());
		const claim = files.claims.get(runOf(14));
		assert.ok(claim?.baseCheck);
		assert.equal(claim.baseCheck.acceptAttempt, 2);
		files.claims.set(runOf(14), {
			...claim,
			baseCheck: { ...claim.baseCheck, storedAttempt: 2 },
		});
		executor.baseOutcome = "ready";
		clock.t += 60_000;
		await once(start());
		assert.ok(!executor.launches.some((l) => l.stage === "build"));
		assert.notEqual(files.claims.get(runOf(14))?.stage, "build");
		assert.equal(statuses(github, 14).at(-1)?.endsWith(":failed"), true);
	});

	it("rejects lowering the stored attempt to hide a model attempt from the feedback allowance", async () => {
		const { github, executor, files, clock, start } = world();
		github.add(labeled(14));
		executor.behaviors = [{ kind: "pass", usage: 10 }];
		executor.acceptBehaviors = [
			{ kind: "fail", usage: 10 },
			{ kind: "pass", usage: 20 },
		];
		executor.acceptBehavior = { kind: "pass", usage: 20 };
		executor.baseOutcome = "checking";
		executor.baseReceipt = (binding) => refusedReceipt(binding, FEEDBACK);
		executor.spentBy.set("accept-1", 10);
		executor.spentBy.set("accept-2", 20);
		const controller = start();
		await drive(controller, clock, true);
		await drive(controller, clock, true);
		const claim = files.claims.get(runOf(14));
		assert.ok(claim?.baseCheck);
		assert.equal(claim.baseCheck.storedAttempt, 2);
		files.claims.set(runOf(14), {
			...claim,
			baseCheck: { ...claim.baseCheck, storedAttempt: 1 },
		});
		await roundTripQualification(files);
		executor.baseOutcome = "preservation_failed";
		await drive(start(), clock);
		assert.deepEqual(launched(executor), ["specify-1", "accept-1", "accept-2"]);
		assert.equal(statuses(github, 14).at(-1)?.endsWith(":failed"), true);
	});

	it("checks the receipt's model attempt before recovering a cached controller base result", async () => {
		const { github, executor, files, clock, start } = world();
		github.add(labeled(14));
		executor.behaviors = [{ kind: "pass", usage: 10 }];
		executor.acceptBehavior = { kind: "pass", usage: 20 };
		executor.baseOutcome = "checking";
		await drive(start(), clock, true);
		const reference = files.claims.get(runOf(14))?.baseCheck;
		assert.ok(reference);

		const dir = join(
			files.artifactRoot,
			"base-check",
			runOf(14),
			digestOf(JSON.stringify(reference.binding)),
			"a1",
		);

		mkdirSync(dir, { recursive: true, mode: 0o700 });
		const text = JSON.stringify(refusedReceipt(reference.binding, FEEDBACK));
		writeFileSync(join(dir, "result.json"), text, { mode: 0o600 });
		writeFileSync(join(dir, "result.digest"), digestOf(text), { mode: 0o600 });
		const checker = controllerBaseChecker({ stateDir: files.artifactRoot });

		const input = {
			...reference,
			signal: new AbortController().signal,
			readOnly: true,
		};

		const found = await checker.check(input);
		assert.ok(found.kind === "refused");
		assert.equal(found.failure.reason, "preservation_failed");
		const forged = await checker.check({ ...input, storedAttempt: 2 });
		assert.ok(forged.kind === "refused");
		assert.equal(forged.failure.reason, "base_evidence_missing");
		const contract = await files.readContract(runOf(14));
		assert.ok(contract.kind === "found");
		assert.equal(
			await files.artifacts.retire(
				runOf(14),
				contract.contract,
				contract.digest,
				reference.binding.acceptanceDigest,
			),
			"retired",
		);
		assert.deepEqual(await checker.check(input), found);
	});

	for (const granted of [false, true])
		it(`keeps a legacy receipt's feedback retry after a check-only recheck (${granted ? "already granted" : "not yet granted"})`, async () => {
			const { github, executor, files, clock, logs, start } = world();
			github.add(labeled(14));
			executor.behaviors = [{ kind: "pass", usage: 10 }];
			executor.acceptBehavior = { kind: "pass", usage: 20 };
			executor.baseOutcome = "checking";
			executor.baseReceipt = (binding) => refusedReceipt(binding, FEEDBACK);
			executor.spentBy.set("accept-1", 20);
			await drive(start(), clock, true);
			const runId = runOf(14);
			const root = join(files.artifactRoot, "acceptance");
			const receiptPath = join(root, runId, "receipt.json");

			const { storedAttempt: _legacy, ...legacy } = JSON.parse(
				readFileSync(receiptPath, "utf8"),
			);

			// Main wrote both copies with tabs, a trailing newline and no storedAttempt.
			const bytes = `${JSON.stringify(legacy, null, "\t")}\n`;
			writeFileSync(receiptPath, bytes);
			writeFileSync(join(root, `${runId}.json`), bytes);
			executor.baseOutcomes = [["interrupted", "checking"]];
			await drive(start(), clock, true);
			const claim = files.claims.get(runId);
			assert.ok(claim?.baseCheck);
			const reference = claim.baseCheck;
			assert.equal(reference.storedAttempt, 1);
			assert.equal(reference.acceptAttempt, 2);
			assert.ok(
				executor.baseChecks.some(
					(check) => check.acceptAttempt === 2 && check.readOnly !== true,
				),
			);
			assert.equal(
				await executor.spent({ runId, stage: "accept", attempt: 2 }),
				null,
			);
			assert.equal(readFileSync(receiptPath, "utf8"), bytes);

			if (granted) {
				const contract = await files.readContract(runId);
				assert.ok(contract.kind === "found");
				assert.equal(
					await files.artifacts.retire(
						runId,
						contract.contract,
						contract.digest,
						reference.binding.acceptanceDigest,
					),
					"retired",
				);
			}

			const disk = fileRunFiles(files.artifactRoot);
			assert.equal(await disk.writeClaim(claim), true);
			const claimPath = join(files.artifactRoot, "claims", `${runId}.json`);
			const stored = JSON.parse(readFileSync(claimPath, "utf8"));
			delete stored.baseCheck.kind;

			if (granted)
				stored.baseCheck.retry = {
					refused: reference.binding,
					reason: "preservation_failed",
					receiptDigest: digestOf(JSON.stringify([reference.binding, 2])),
					scenarios: ["S1"],
					baseWallMs: 5_000,
				};

			const claimBytes = `${JSON.stringify(stored)}\n`;

			writeFileSync(claimPath, claimBytes);

			const recovered = (await disk.listClaims()).find(
				(c) => c.runId === runId,
			);

			assert.ok(recovered?.baseCheck);
			assert.equal(readFileSync(claimPath, "utf8"), claimBytes);
			assert.equal(
				recovered.baseCheck.kind,
				granted ? "retry_pending" : "checking",
			);
			files.claims.set(runId, recovered);
			executor.baseOutcomes = ["preservation_failed", "preservation_failed"];
			await drive(start(), clock);
			await drive(start(), clock);
			assert.deepEqual(launched(executor), [
				"specify-1",
				"accept-1",
				"accept-3",
			]);
			assert.equal(files.claims.get(runId)?.status, "failed");
			assert.ok(
				!statuses(github, 14).some((status) =>
					status.endsWith(":budget_exhausted"),
				),
			);
			assert.ok(!logs.some((log) => log.event === "launch_refused"));

			const retry = executor.launches.find(
				(l) => l.stage === "accept" && l.attempt === 3,
			);

			assert.equal(retry?.settings.maxTokens, ACCEPTANCE_MAX_TOKENS - 20);
			assert.equal(retry?.settings.budget.wallMs, 900_000 - 1 - 5_000);
			assert.equal(refusals(github).length, 1);
			assert.equal(
				readFileSync(
					join(root, `${runId}.retired`, "suite", "receipt.json"),
					"utf8",
				),
				bytes,
			);
			assert.equal(
				readFileSync(join(root, `${runId}.retired`, "guard.json"), "utf8"),
				bytes,
			);
		});

	const refusals = (github: FakeGitHub) => keyed(github, 14, "base-refusal");

	for (const guard of [
		"tools",
		"length",
		"requests",
		"abort_model",
		"abort_draft",
	] as const)
		for (const beforeFeedback of [true, false])
			it(`retries a charged ${guard} stop ${beforeFeedback ? "before" : "during"} base feedback, preserving attempts across restart and the one-shot`, async () => {
				const { github, executor, files, clock, start, logs } = world();
				github.add(labeled(14));
				executor.behaviors = [{ kind: "pass", usage: 10 }];
				executor.acceptBehavior = { kind: "pass", usage: 20 };
				executor.baseOutcome = "preservation_failed";
				executor.baseReceipt = (binding) => refusedReceipt(binding, FEEDBACK);
				const failedAttempt = beforeFeedback ? 1 : 2;
				const launch = executor.launch.bind(executor);

				executor.launch = async (input) => {
					let attempt: StageLaunch;

					if (input.stage === "accept" && input.attempt === failedAttempt) {
						executor.launches.push(input);
						attempt = {
							kind: "started",
							done: replayAcceptStop(input, guard),
						};
					} else attempt = await launch(input);

					if (attempt.kind !== "started" || input.stage !== "accept")
						return attempt;

					return {
						kind: "started",
						done: attempt.done.then((result) => {
							executor.spentBy.set(`accept-${input.attempt}`, result.usage);

							return result;
						}),
					};
				};

				const first = start();
				await once(first);
				const claim = files.claims.get(runOf(14));
				assert.equal(claim?.status, "retrying");
				assert.equal(claim.attempt, failedAttempt + 1);
				assert.equal(claim.usage, beforeFeedback ? 80 : 100);
				assert.equal(claim.baseCheck?.retry !== undefined, !beforeFeedback);
				assert.ok(!executor.launches.some((l) => l.stage === "build"));
				const restarted = start();
				await once(restarted);
				assert.equal(
					executor.launches.filter((l) => l.stage === "accept").length,
					failedAttempt,
				);
				clock.t += 9_999;
				await once(restarted);
				assert.equal(
					executor.launches.filter((l) => l.stage === "accept").length,
					failedAttempt,
				);
				clock.t += 20_001;
				await once(restarted);
				await restarted.tick();

				assert.deepEqual(launched(executor), [
					"specify-1",
					"accept-1",
					"accept-2",
					"accept-3",
				]);
				assert.equal(files.claims.get(runOf(14))?.usage, 120);
				assert.equal(files.claims.get(runOf(14))?.status, "failed");
				assert.equal(refusals(github).length, 1);
				assert.equal(keyed(github, 14, "acceptance").length, 0);
				assert.ok(
					!JSON.stringify(github.markers(14)).includes("PRIVATE-TOOL-ARG"),
				);
				const last = executor.launches.at(-1);
				assert.equal(last?.remainingRunTokens, TRUSTED_RUN_CAP - 100);
				assert.equal(last?.settings.maxTokens, ACCEPTANCE_MAX_TOKENS - 90);

				if (guard === "abort_model" || guard === "abort_draft") {
					assert.equal(
						last?.settings.budget.wallMs,
						900_000 - (beforeFeedback ? 1 : 26) - 4_000,
					);
					assert.equal(
						logs.filter((log) => log.event === "accept_retry").length,
						1,
					);
					assert.ok(
						!statuses(github, 14).some((status) =>
							status.endsWith(":budget_exhausted"),
						),
					);
				}
			});

	it("refuses a broken suite twice before build with only the final keyed public reason", async () => {
		const { github, executor, start } = world();
		github.add(labeled(14));
		executor.behaviors = [{ kind: "pass", usage: 10 }];
		executor.acceptBehavior = { kind: "pass", usage: 20 };
		executor.baseOutcome = "preservation_failed";
		executor.baseReceipt = (binding) => refusedReceipt(binding, FEEDBACK);
		executor.spentBy.set("accept-1", 20);
		const controller = start();
		const report = await once(controller);
		await controller.tick();
		assert.ok(!executor.launches.some((l) => l.stage === "build"));
		assert.deepEqual(
			executor.launches.map((l) => `${l.stage}-${l.attempt}`),
			["specify-1", "accept-1", "accept-2"],
		);
		assert.equal(statuses(github, 14).at(-1)?.endsWith(":failed"), true);
		assert.equal(report.totals.failures, 1);
		assert.equal(refusals(github).length, 1);
		assert.match(
			refusals(github)[0] ?? "",
			/^Acceptance refused before build: preservation_failed\. A preservation check fails on the unchanged base\. Scenarios: S1\.\n\n<!-- factory-base-refusal run=[0-9a-f]{64} r=[0-9a-f]{64} -->$/,
		);
		const checked = executor.baseChecks.filter((c) => c.readOnly !== true);
		assert.equal(executor.baseSuites.length, 2);
		assert.deepEqual(
			checked.map((c) => [c.binding.acceptanceDigest, c.acceptAttempt]),
			[
				[executor.baseSuites[0], 1],
				[executor.baseSuites[1], 2],
			],
		);
		assert.ok(
			refusals(github)[0]?.includes(
				digestOf(JSON.stringify([checked[1]?.binding, 2])),
			),
			"the notice is the second suite's refusal",
		);
		assert.equal(keyed(github, 14, "acceptance").length, 0);
		assert.equal(checked[0]?.binding.issue, 14);
	});

	it("records a retried accept and its final refusal on the terminal row", async () => {
		const dir = stateDir();
		const outbox = fileLedgerOutbox(dir);
		const { github, executor, files, start } = world(null, outbox);
		files.accounting = fileRunFiles(dir).accounting;
		await instrument(files);
		github.add(labeled(14));
		executor.behaviors = [{ kind: "pass", usage: 10 }];
		executor.acceptBehavior = { kind: "pass", usage: 20 };
		executor.baseOutcome = "preservation_failed";
		executor.baseReceipt = (binding) => refusedReceipt(binding, FEEDBACK);
		executor.spentBy.set("accept-1", 20);
		const controller = start();
		await once(controller);
		await controller.tick();
		assert.equal(statuses(github, 14).at(-1)?.endsWith(":failed"), true);

		const row = (await outbox.scan())?.[0]?.row?.row;
		assert.ok(row?.v === 5);
		assert.deepEqual(row.acceptAttempts, {
			kind: "known",
			value: [
				{ attempt: 1, disposition: "retried" },
				{ attempt: 2, disposition: "base_refused" },
			],
		});
		assert.deepEqual(
			row.failure?.kind === "known" && [
				row.failure.value.stage,
				row.failure.value.class,
				row.failure.value.reason,
			],
			["accept", "base", "preservation_failed"],
		);
		assert.deepEqual(row.outcome, {
			kind: "failed",
			stage: "accept",
			cause: { kind: "known", value: "base_refused" },
		});
	});

	it("never names a cap on the row when a feedback attempt's spend is unknown", async () => {
		const dir = stateDir();
		const outbox = fileLedgerOutbox(dir);
		const { github, executor, files, clock, start } = world(null, outbox);
		files.accounting = fileRunFiles(dir).accounting;
		await instrument(files);
		github.add(labeled(14));
		executor.behaviors = [{ kind: "pass", usage: 10 }];
		executor.acceptBehaviors = [{ kind: "pass", usage: 20 }, { kind: "hang" }];
		executor.acceptBehavior = { kind: "pass", usage: 20 };
		executor.baseOutcomes = ["preservation_failed", "ready"];
		executor.baseReceipt = (binding) => refusedReceipt(binding, FEEDBACK);
		executor.spentBy.set("accept-1", 20);
		const first = start();

		for (let tick = 0; tick < 6; tick++) {
			await first.tick();
			await settle();
		}

		await drive(start(), clock);
		await drive(start(), clock);
		assert.equal(
			statuses(github, 14).at(-1)?.endsWith(":budget_exhausted"),
			true,
		);

		const row = (await outbox.scan())?.[0]?.row?.row;
		assert.ok(row?.v === 5);
		assert.equal(row.outcome.kind, "budget_exhausted");
		assert.ok(row.outcome.kind === "budget_exhausted");
		assert.equal(row.outcome.cap.kind, "unavailable");
		assert.notEqual(
			row.failure?.kind === "known" && row.failure.value.reason,
			"stage_tokens",
		);
	});

	const FEEDBACK = "Expected PRIVATE-FEEDBACK-MESSAGE to equal 'v0.1.0'";

	/** Ticks a controller; `pending` leaves a checking base check undrained. */
	async function drive(
		controller: Orchestrator,
		clock: FakeClock,
		pending = false,
	) {
		for (let tick = 0; tick < 4; tick++) {
			if (pending) {
				await controller.tick();
				await settle();
			} else await once(controller);
			clock.t += 600_000;
		}
	}

	async function roundTripQualification(
		files: ReturnType<typeof world>["files"],
	) {
		const disk = fileRunFiles(files.artifactRoot);
		const claim = files.claims.get(runOf(14));
		assert.ok(claim);
		assert.equal(await disk.writeClaim(claim), true);
		const path = join(files.artifactRoot, "claims", `${claim.runId}.json`);
		const before = readFileSync(path, "utf8");

		const recovered = (await disk.listClaims()).find(
			(c) => c.runId === claim.runId,
		);

		assert.ok(recovered?.baseCheck);
		assert.equal(readFileSync(path, "utf8"), before);
		files.claims.set(claim.runId, recovered);

		return recovered.baseCheck;
	}

	const launched = (executor: FakeExecutor) => [
		...new Set(executor.launches.map((l) => `${l.stage}-${l.attempt}`)),
	];

	it("retries a retryable refusal once with private feedback, then builds on a qualified proof", async () => {
		const { github, executor, files, clock, start } = world();
		github.add(labeled(14));
		executor.behaviors = [{ kind: "pass", usage: 10 }];
		executor.acceptBehavior = { kind: "pass", usage: 20 };
		executor.baseOutcomes = ["preservation_failed", "ready"];
		executor.baseReceipt = (binding) => refusedReceipt(binding, FEEDBACK);
		executor.spentBy.set("accept-1", 20);
		await drive(start(), clock);

		assert.deepEqual(launched(executor), [
			"specify-1",
			"accept-1",
			"accept-2",
			"build-1",
		]);
		const [, first, retry, build] = executor.launches;
		assert.ok(first?.acceptDraft);
		assert.deepEqual(
			retry?.acceptDraft,
			first.acceptDraft,
			"both attempts get the same immutable contract for private drafts",
		);
		assert.equal(first.acceptDraft.contract.runId, runOf(14));
		assert.equal(first.acceptDraft.issue, 14);
		assert.equal(
			first.acceptDraft.baseSha,
			first.acceptDraft.contract.base.sha,
		);
		assert.equal(
			build?.acceptDraft,
			undefined,
			"held-out draft inputs never reach build",
		);
		assert.doesNotMatch(first?.prompt ?? "", /base-refusal/);

		const block =
			/<base-refusal-([0-9a-f]{32})>\n(.*)\n<\/base-refusal-\1>/.exec(
				retry?.prompt ?? "",
			);

		assert.ok(block, "the retry prompt carries one nonce-tagged block");
		assert.match(retry?.prompt ?? "", new RegExp(`<contract-${block[1]}>`));
		assert.deepEqual(JSON.parse(block[2] ?? ""), {
			reason: "preservation_failed",
			sentence: "A preservation check fails on the unchanged base.",
			scenarios: ["S1"],
			files: [
				{
					scenario: "S1",
					file: "checks/version.test.ts",
					kind: "assertion",
					code: "ERR_ASSERTION",
					message: FEEDBACK,
					failedIn: "both",
				},
			],
			omitted: 0,
		});
		assert.doesNotMatch(retry?.prompt ?? "", /PRIVATE-TEST-NAME/);

		const previous =
			/<previous-suite-([0-9a-f]{32})>\n(.*)\n<\/previous-suite-\1>/.exec(
				retry?.prompt ?? "",
			);

		assert.ok(previous, "the retry receives its own refused check files");
		assert.equal(previous[1], block[1]);
		const supplied = JSON.parse(previous[2] ?? "");
		assert.equal(supplied.truncated, false);
		assert.equal(supplied.files[0].path, "suite.json");
		assert.deepEqual(JSON.parse(supplied.files[0].content), {
			version: 2,
			scenarios: [
				{ ...JSON.parse(ACCEPTANCE_TEXT).scenarios[0], kind: "new_behavior" },
			],
		});
		assert.deepEqual(supplied.files.slice(1), [
			{
				path: "checks/version.test.ts",
				content: JSON.parse(ACCEPTANCE_TEXT).files[0].content,
			},
		]);
		assert.doesNotMatch(retry?.prompt ?? "", /Write a new suite/);
		assert.match(
			retry?.prompt ?? "",
			/fix it rather than rewrite unless the feedback requires it/i,
		);
		assert.equal(retry?.settings.maxTokens, ACCEPTANCE_MAX_TOKENS - 20);
		// The retry runs in what is left of the one accept wall.
		assert.equal(first?.settings.budget.wallMs, 900_000);
		assert.equal(retry?.settings.budget.wallMs, 900_000 - 1 - 4_000);

		const run = runOf(14);
		const aside = join(files.artifactRoot, "acceptance", `${run}.retired`);

		const retiredCanary = readFileSync(
			join(aside, "suite", "canary.txt"),
			"utf8",
		).trim();

		assert.match(retiredCanary, /^factory-holdout-[0-9a-f]{64}$/);

		const current = readFileSync(
			join(files.artifactRoot, "acceptance", run, "canary.txt"),
			"utf8",
		).trim();

		assert.notEqual(current, retiredCanary);

		for (const text of [
			build?.prompt ?? "",
			JSON.stringify(build),
			...github.markers(14),
		]) {
			assert.ok(!text.includes(retiredCanary));
			assert.ok(!text.includes("PRIVATE-FEEDBACK-MESSAGE"));
			assert.doesNotMatch(text, /base-refusal-|PRIVATE-TEST-NAME/);
		}

		assert.equal(refusals(github).length, 0);
		assert.equal(keyed(github, 14, "acceptance").length, 1);
		assert.ok(
			keyed(github, 14, "acceptance")[0]?.includes(
				`a=${executor.baseSuites[1]?.slice(0, 12)}`,
			) ?? false,
			keyed(github, 14, "acceptance")[0] ?? "no acceptance summary",
		);
		const claim = files.claims.get(run);
		assert.equal(claim?.stage, "build");
		assert.equal(
			claim?.baseCheck?.retry?.refused.acceptanceDigest,
			executor.baseSuites[0],
		);
		assert.equal(
			claim?.baseCheck?.binding.acceptanceDigest,
			executor.baseSuites[1],
		);
		assert.equal(claim?.baseCheck?.acceptAttempt, 2);
		assert.equal(claim?.baseCheck?.remainingAcceptMs, 900_000 - 2 - 4_000);
		assert.ok(
			executor.baseChecks
				.filter((c) => c.readOnly === true)
				.every(
					(c) =>
						c.binding.acceptanceDigest !== executor.baseSuites[0] ||
						c.acceptAttempt === 1,
				),
		);
	});

	it("omits all refused files if their retired bytes fail verification", async () => {
		const { github, executor, files, clock, start } = world();
		github.add(labeled(14));
		executor.behaviors = [{ kind: "pass", usage: 10 }];
		executor.acceptBehavior = { kind: "pass", usage: 20 };
		executor.baseOutcomes = ["preservation_failed", "ready"];
		executor.baseReceipt = (binding) => refusedReceipt(binding, FEEDBACK);
		executor.spentBy.set("accept-1", 20);
		const retire = files.artifacts.retire.bind(files.artifacts);
		files.artifacts.retire = async (...args) => {
			const result = await retire(...args);

			if (result === "retired")
				writeFileSync(
					join(
						files.artifactRoot,
						"acceptance",
						`${runOf(14)}.retired`,
						"suite",
						"checks",
						"version.test.ts",
					),
					"PRIVATE-TAMPERED-CHECK",
				);

			return result;
		};

		await drive(start(), clock);

		const retry = executor.launches.find(
			(entry) => entry.stage === "accept" && entry.attempt === 2,
		);

		assert.ok(retry);
		assert.match(
			retry.prompt,
			/Previous suite unavailable:.*failed digest verification; no refused files are included/,
		);

		const block =
			/<previous-suite-([0-9a-f]{32})>\n(.*)\n<\/previous-suite-\1>/.exec(
				retry.prompt,
			);

		assert.ok(block);
		assert.deepEqual(JSON.parse(block[2] ?? ""), {
			files: [],
			truncated: false,
			unavailable: true,
		});
		assert.doesNotMatch(retry.prompt, /PRIVATE-TAMPERED-CHECK/);
		assert.match(retry.prompt, /PRIVATE-FEEDBACK-MESSAGE/);
	});

	it("retries a tampered suite once with the scan's file, line and rule as feedback", async () => {
		const { github, executor, clock, start } = world();
		github.add(labeled(14));
		executor.behaviors = [{ kind: "pass", usage: 10 }];
		executor.acceptBehavior = { kind: "pass", usage: 20 };
		executor.baseOutcomes = ["suite_tamper_signal", "ready"];

		const signal = {
			file: "test/acceptance/14/checks/version.test.ts",
			line: 25,
			rule: "runtime_patching" as const,
		};

		executor.baseReceipt = (binding) => {
			const { evidence } = refusedReceipt(binding, FEEDBACK);

			const skipped = {
				kind: "unavailable" as const,
				reason: "runner_error" as const,
				wallMs: 0,
			};

			return assessBase({
				...evidence,
				execution: skipped,
				repeat: skipped,
				tamper: [signal],
			}).receipt;
		};

		executor.spentBy.set("accept-1", 20);
		await drive(start(), clock);

		assert.deepEqual(launched(executor), [
			"specify-1",
			"accept-1",
			"accept-2",
			"build-1",
		]);
		const [, first, retry] = executor.launches;
		assert.ok(first?.prompt.includes(SCAN_SENTENCE));

		const block =
			/<base-refusal-([0-9a-f]{32})>\n(.*)\n<\/base-refusal-\1>/.exec(
				retry?.prompt ?? "",
			);

		assert.ok(block, "the retry prompt carries one nonce-tagged block");
		const feedback = JSON.parse(block[2] ?? "");
		assert.equal(feedback.reason, "suite_tamper_signal");
		assert.deepEqual(feedback.signals, [signal]);
		assert.deepEqual(feedback.files, []);
		assert.doesNotMatch(retry?.prompt ?? "", /PRIVATE-/);
		assert.equal(refusals(github).length, 0);
	});

	for (const reason of ["base_timeout", "base_runner_error"] as const)
		it(`fails a ${reason} refusal at once, with no retry`, async () => {
			const { github, executor, clock, start } = world();
			github.add(labeled(14));
			executor.behaviors = [{ kind: "pass", usage: 10 }];
			executor.acceptBehavior = { kind: "pass", usage: 20 };
			executor.baseOutcome = reason;
			await drive(start(), clock);
			assert.deepEqual(
				executor.launches.map((l) => l.stage),
				["specify", "accept"],
			);
			assert.equal(statuses(github, 14).at(-1)?.endsWith(":failed"), true);
			assert.equal(refusals(github).length, 1);
			assert.match(refusals(github)[0] ?? "", new RegExp(`: ${reason}\\. `));
		});

	for (const [exhausted, why] of [
		["tokens", "stage_tokens"],
		["attempts", "attempts"],
		["run", "run_tokens"],
		// An accept attempt with no spend record is unknown spend, not zero.
		["unknown_spend", "stage_tokens"],
		// Without the refused suite's receipt its base wall is unknown.
		["no_receipt", "base_receipt"],
		// An interrupted base check on the same suite spent the accept wall.
		["wall", "wall"],
	] as const)
		it(`does not retry when the accept ${exhausted} allowance cannot admit it`, async () => {
			const { github, executor, files, clock, logs, start } = world();
			github.add(labeled(14));
			executor.behaviors = [{ kind: "pass", usage: 10 }];
			executor.acceptBehavior = {
				kind: "pass",
				usage: exhausted === "run" ? TRUSTED_RUN_CAP - 10 : 20,
			};
			executor.baseOutcome = "preservation_failed";

			if (exhausted !== "no_receipt")
				executor.baseReceipt = (binding) => refusedReceipt(binding, FEEDBACK);

			if (exhausted !== "unknown_spend")
				executor.spentBy.set(
					"accept-1",
					exhausted === "tokens" ? ACCEPTANCE_MAX_TOKENS : 20,
				);

			if (exhausted === "attempts")
				setWorkflow(github, "max_attempts: 3", "max_attempts: 1");

			if (exhausted === "wall") {
				// 1 ms of model wall, 895,000 interrupted and the 4,000 refusal.
				executor.baseOutcomes = [["interrupted", "preservation_failed"]];
				executor.baseInterruptMs = 895_999;
			}

			await drive(start(), clock);
			assert.deepEqual(
				executor.launches.map((l) => l.stage),
				["specify", "accept"],
			);
			assert.deepEqual(
				logs
					.filter((l) => l.event === "accept_retry_unavailable")
					.map((l) => l.fields.why),
				[why],
			);
			assert.equal(statuses(github, 14).at(-1)?.endsWith(":failed"), true);
			assert.equal(refusals(github).length, 1);
			assert.match(refusals(github)[0] ?? "", /: preservation_failed\. /);
			assert.ok(
				existsSync(join(files.artifactRoot, "acceptance", runOf(14))),
				"the refused suite is not retired",
			);
		});

	it("charges the retry to what is left of the accept token allowance", async () => {
		const { github, executor, clock, start } = world();
		github.add(labeled(14));
		executor.behaviors = [{ kind: "pass", usage: 10 }];
		executor.acceptBehavior = { kind: "pass", usage: 20 };
		executor.baseOutcomes = ["preservation_failed", "ready"];
		executor.baseReceipt = (binding) => refusedReceipt(binding, FEEDBACK);
		// Receipt usage includes the original generation plus same-session revisions.
		executor.spentBy.set("accept-1", 18_000);
		await drive(start(), clock);

		const retry = executor.launches.find(
			(l) => l.stage === "accept" && l.attempt === 2,
		);

		assert.equal(retry?.settings.maxTokens, ACCEPTANCE_MAX_TOKENS - 18_000);
	});

	for (const crash of [
		"before_retire",
		"after_suite_move",
		"after_retire",
		"after_claim",
	] as const)
		it(`relaunches once after a restart between the refusal and the relaunch (${crash})`, async () => {
			const { github, executor, files, clock, start } = world();
			github.add(labeled(14));
			executor.behaviors = [{ kind: "pass", usage: 10 }];
			executor.acceptBehavior = { kind: "pass", usage: 20 };
			executor.baseOutcomes = ["checking"];
			executor.baseReceipt = (binding) => refusedReceipt(binding, FEEDBACK);
			executor.spentBy.set("accept-1", 20);
			await drive(start(), clock, true);
			const claim = files.claims.get(runOf(14));
			const first = claim?.baseCheck;
			assert.ok(first);
			assert.equal(first.retry, undefined);

			if (crash !== "before_retire") {
				const contract = await files.readContract(runOf(14));
				assert.ok(contract.kind === "found");
				assert.equal(
					await files.artifacts.retire(
						runOf(14),
						contract.contract,
						contract.digest,
						first.binding.acceptanceDigest,
					),
					"retired",
				);

				if (crash === "after_suite_move")
					renameSync(
						join(
							files.artifactRoot,
							"acceptance",
							`${runOf(14)}.retired`,
							"guard.json",
						),
						join(files.artifactRoot, "acceptance", `${runOf(14)}.json`),
					);

				if (crash === "after_claim")
					files.claims.set(runOf(14), {
						...claim,
						baseCheck: {
							...first,
							kind: "retry_pending",
							retry: {
								refused: first.binding,
								reason: "preservation_failed",
								receiptDigest: digestOf(JSON.stringify([first.binding, 1])),
								scenarios: ["S1"],
								baseWallMs: 4_000,
							},
						},
					});
			}

			assert.equal(
				(await roundTripQualification(files)).kind,
				crash === "after_claim" ? "retry_pending" : "checking",
			);
			executor.baseOutcomes = ["preservation_failed", "ready"];
			await drive(start(), clock);
			await drive(start(), clock);
			assert.deepEqual(launched(executor), [
				"specify-1",
				"accept-1",
				"accept-2",
				"build-1",
			]);
			assert.match(
				executor.launches[2]?.prompt ?? "",
				/PRIVATE-FEEDBACK-MESSAGE/,
			);
			assert.equal(refusals(github).length, 0);
			assert.equal(files.claims.get(runOf(14))?.stage, "build");
		});

	for (const crash of ["before_claim", "after_claim"] as const)
		it(`never grants a second retry after replacement storage and restart (${crash})`, async () => {
			const { github, executor, files, clock, start } = world();
			let pending: ClaimRecord | undefined;
			const writeClaim = files.writeClaim.bind(files);

			files.writeClaim = async (claim) => {
				if (claim.baseCheck?.kind === "retry_pending") pending = claim;

				return writeClaim(claim);
			};

			github.add(labeled(14));
			executor.behaviors = [{ kind: "pass", usage: 10 }];
			executor.acceptBehavior = { kind: "pass", usage: 20 };
			executor.baseOutcomes = ["preservation_failed", "checking"];
			executor.baseReceipt = (binding) => refusedReceipt(binding, FEEDBACK);
			executor.spentBy.set("accept-1", 20);
			await drive(start(), clock, true);
			assert.equal(
				files.claims.get(runOf(14))?.baseCheck?.binding.acceptanceDigest,
				executor.baseSuites[1],
			);

			if (crash === "before_claim") {
				assert.ok(pending);
				files.claims.set(runOf(14), pending);
			}

			assert.equal(
				(await roundTripQualification(files)).kind,
				crash === "before_claim" ? "retry_pending" : "rechecking_replacement",
			);
			executor.baseOutcomes = ["preservation_failed", "preservation_failed"];
			await drive(start(), clock);
			await drive(start(), clock);
			assert.deepEqual(launched(executor), [
				"specify-1",
				"accept-1",
				"accept-2",
			]);
			assert.equal(statuses(github, 14).at(-1)?.endsWith(":failed"), true);
			assert.equal(refusals(github).length, 1);
			const contract = await files.readContract(runOf(14));
			assert.ok(contract.kind === "found");
			assert.equal(
				await files.artifacts.retire(
					runOf(14),
					contract.contract,
					contract.digest,
					executor.baseSuites[1] ?? digestOf("none"),
				),
				"refused",
			);
		});

	/** The first suite's refusal notice, as the fake keys it. */
	const original = (executor: FakeExecutor, run: Digest) =>
		digestOf(
			JSON.stringify([
				executor.baseChecks.find(
					(c) => c.binding.acceptanceDigest === executor.baseSuites[0],
				)?.binding ?? { runId: run },
				1,
			]),
		);

	for (const ending of ["fail", "budget", "refuse", "hang"] as const)
		it(`posts the first refusal once when the feedback attempt is the last allowed and ends ${ending}`, async () => {
			const { github, executor, clock, start } = world();
			github.add(labeled(14));
			setWorkflow(github, "max_attempts: 3", "max_attempts: 2");
			executor.behaviors = [{ kind: "pass", usage: 10 }];
			executor.acceptBehaviors = [{ kind: "pass", usage: 20 }];
			executor.acceptBehavior =
				ending === "hang" ? { kind: "hang" } : { kind: ending, usage: 30 };
			executor.baseOutcomes = ["preservation_failed"];
			executor.baseReceipt = (binding) => refusedReceipt(binding, FEEDBACK);
			executor.spentBy.set("accept-1", 20);
			const controller = start();
			await drive(controller, clock, true);
			await drive(controller, clock, true);

			assert.deepEqual(launched(executor), [
				"specify-1",
				"accept-1",
				"accept-2",
			]);
			assert.match(
				statuses(github, 14).at(-1) ?? "",
				ending === "budget" ? /:budget_exhausted$/ : /:failed$/,
			);
			assert.equal(refusals(github).length, 1);
			assert.match(
				refusals(github)[0] ?? "",
				new RegExp(
					`^Acceptance refused before build: preservation_failed\\. .* r=${original(executor, runOf(14))} -->$`,
					"s",
				),
			);
		});

	for (const [maxAttempts, recorded] of [
		[2, true],
		[3, true],
		// The interrupted feedback attempt left no spend record: unknown spend.
		[3, false],
	] as const)
		it(`recovers a restart while the feedback attempt runs, at max_attempts: ${maxAttempts}${recorded ? "" : " with its spend unknown"}`, async () => {
			const { github, executor, files, clock, logs, start } = world();
			github.add(labeled(14));
			setWorkflow(github, "max_attempts: 3", `max_attempts: ${maxAttempts}`);
			executor.behaviors = [{ kind: "pass", usage: 10 }];
			executor.acceptBehaviors = [
				{ kind: "pass", usage: 20 },
				{ kind: "hang" },
			];
			executor.acceptBehavior = { kind: "pass", usage: 20 };
			executor.baseOutcomes = ["preservation_failed", "ready"];
			executor.baseReceipt = (binding) => refusedReceipt(binding, FEEDBACK);
			executor.spentBy.set("accept-1", 20);
			const first = start();

			// No clock movement, so the hung feedback attempt never stalls.
			for (let tick = 0; tick < 6; tick++) {
				await first.tick();
				await settle();
			}

			assert.deepEqual(launched(executor), [
				"specify-1",
				"accept-1",
				"accept-2",
			]);
			assert.equal(statuses(github, 14).at(-1)?.endsWith(":running"), true);

			if (recorded) executor.spentBy.set("accept-2", 5);
			await drive(start(), clock);
			await drive(start(), clock);

			if (!recorded) {
				assert.deepEqual(launched(executor), [
					"specify-1",
					"accept-1",
					"accept-2",
				]);
				assert.deepEqual(
					logs
						.filter((l) => l.event === "launch_refused")
						.map((l) => l.fields.why),
					["stage_tokens"],
				);
				assert.equal(
					statuses(github, 14).at(-1)?.endsWith(":budget_exhausted"),
					true,
				);
				assert.equal(refusals(github).length, 1);
				assert.ok(refusals(github)[0]?.includes(original(executor, runOf(14))));

				return;
			}

			if (maxAttempts === 2) {
				assert.deepEqual(launched(executor), [
					"specify-1",
					"accept-1",
					"accept-2",
				]);
				assert.equal(statuses(github, 14).at(-1)?.endsWith(":failed"), true);
				assert.equal(refusals(github).length, 1);
				assert.ok(refusals(github)[0]?.includes(original(executor, runOf(14))));

				return;
			}

			assert.deepEqual(launched(executor), [
				"specify-1",
				"accept-1",
				"accept-2",
				"accept-3",
				"build-1",
			]);

			const relaunch = executor.launches.find(
				(l) => l.stage === "accept" && l.attempt === 3,
			);

			assert.match(relaunch?.prompt ?? "", /PRIVATE-FEEDBACK-MESSAGE/);
			assert.equal(
				relaunch?.settings.maxTokens,
				ACCEPTANCE_MAX_TOKENS - 20 - 5,
			);
			assert.equal(refusals(github).length, 0);
			assert.equal(files.claims.get(runOf(14))?.stage, "build");
		});

	for (const failure of ["retire", "contract_once"] as const)
		it(`recovers a granted retry whose retirement ${failure === "retire" ? "fails, posting the first refusal" : "meets one transient contract read failure"}`, async () => {
			const { github, executor, files, clock, start } = world();
			github.add(labeled(14));
			executor.behaviors = [{ kind: "pass", usage: 10 }];
			executor.acceptBehavior = { kind: "pass", usage: 20 };
			executor.baseOutcomes = ["checking"];
			executor.baseReceipt = (binding) => refusedReceipt(binding, FEEDBACK);
			executor.spentBy.set("accept-1", 20);
			await drive(start(), clock, true);
			const claim = files.claims.get(runOf(14));
			const first = claim?.baseCheck;
			assert.ok(claim && first);
			files.claims.set(runOf(14), {
				...claim,
				baseCheck: {
					...first,
					kind: "retry_pending",
					retry: {
						refused: first.binding,
						reason: "preservation_failed",
						receiptDigest: digestOf(JSON.stringify([first.binding, 1])),
						scenarios: ["S1"],
						baseWallMs: 4_000,
					},
				},
			});

			if (failure === "retire") files.artifacts.retire = async () => "failed";
			else {
				const read = files.readContract.bind(files);
				let failures = 1;

				files.readContract = async (runId) =>
					failures-- > 0
						? { kind: "blocked", reason: "contract_invalid" }
						: read(runId);
			}

			executor.baseOutcomes = ["preservation_failed", "ready"];
			await drive(start(), clock);
			await drive(start(), clock);

			if (failure === "contract_once") {
				assert.deepEqual(launched(executor), [
					"specify-1",
					"accept-1",
					"accept-2",
					"build-1",
				]);
				assert.equal(refusals(github).length, 0);

				return;
			}

			assert.deepEqual(launched(executor), ["specify-1", "accept-1"]);
			assert.equal(statuses(github, 14).at(-1)?.endsWith(":failed"), true);
			assert.equal(refusals(github).length, 1);
			assert.ok(
				refusals(github)[0]?.includes(
					`r=${digestOf(JSON.stringify([first.binding, 1]))} -->`,
				),
			);
		});

	it("never relaunches a forged retry of a reason the author cannot fix", async () => {
		const { github, executor, files, clock, start } = world();
		github.add(labeled(14));
		executor.behaviors = [{ kind: "pass", usage: 10 }];
		executor.acceptBehavior = { kind: "pass", usage: 20 };
		executor.baseOutcomes = ["checking"];
		executor.baseReceipt = (binding) => refusedReceipt(binding, FEEDBACK);
		executor.spentBy.set("accept-1", 20);
		await drive(start(), clock, true);
		const claim = files.claims.get(runOf(14));
		const first = claim?.baseCheck;
		assert.ok(claim && first);

		const forged: AcceptRetry = {
			refused: first.binding,
			// @ts-expect-error A hostile claim also proves the retry reason is narrowed.
			reason: "base_timeout",
			receiptDigest: digestOf("forged"),
			scenarios: [],
			baseWallMs: 0,
		};

		files.claims.set(runOf(14), {
			...claim,
			baseCheck: { ...first, kind: "retry_pending", retry: forged },
		});
		executor.baseOutcomes = ["base_timeout", "ready"];
		await drive(start(), clock);
		await drive(start(), clock);
		assert.deepEqual(launched(executor), ["specify-1", "accept-1"]);
		assert.equal(statuses(github, 14).at(-1)?.endsWith(":failed"), true);
		assert.ok(
			existsSync(join(files.artifactRoot, "acceptance", runOf(14))),
			"the suite is not retired",
		);
		assert.equal(refusals(github).length, 1);
		assert.match(refusals(github)[0] ?? "", /: base_timeout\. /);
	});

	for (const outcome of ["ready", "base_timeout"] as const)
		it(`recovers the stored ${outcome === "ready" ? "proof before its summary" : "final refusal before its notice"} without a model replay`, async () => {
			const { github, executor, files, clock, start } = world();
			github.add(labeled(14));
			executor.behaviors = [{ kind: "pass", usage: 10 }];
			executor.acceptBehavior = { kind: "pass", usage: 20 };
			executor.baseOutcome = outcome;

			const key =
				outcome === "ready" ? "factory-acceptance" : "factory-base-refusal";

			github.beforeCall = (args) => {
				if (args.some((a) => a.startsWith("body=") && a.includes(key)))
					github.posts = ["rejected"];
			};

			await once(start());
			const qualification = files.claims.get(runOf(14))?.baseCheck;
			assert.equal(
				qualification?.kind,
				outcome === "ready" ? "qualified" : "refused",
			);
			assert.equal(
				(await roundTripQualification(files)).kind,
				outcome === "ready" ? "checking" : "refused",
			);
			const checks = executor.baseChecks.length;
			github.beforeCall = null;

			if (outcome === "base_timeout") executor.baseOutcome = "ready";
			await once(start());
			await drive(start(), clock);
			assert.equal(
				executor.launches.filter((l) => l.stage === "accept").length,
				1,
			);

			if (outcome === "ready") {
				assert.equal(keyed(github, 14, "acceptance").length, 1);
				assert.equal(refusals(github).length, 0);
			} else {
				assert.equal(executor.baseChecks.length, checks);
				assert.equal(refusals(github).length, 1);
				assert.match(refusals(github)[0] ?? "", /: base_timeout\. /);
				assert.ok(!executor.launches.some((l) => l.stage === "build"));
			}
		});

	it("fails closed without a base-check port", async () => {
		const { github, executor, start } = world();
		github.add(labeled(14));
		executor.behaviors = [{ kind: "pass", usage: 10 }];
		executor.acceptBehavior = { kind: "pass", usage: 20 };
		Object.defineProperty(executor, "baseCheck", { value: undefined });
		await once(start());
		assert.ok(!executor.launches.some((l) => l.stage === "build"));
		assert.equal(statuses(github, 14).at(-1)?.endsWith(":failed"), true);
		assert.match(refusals(github)[0] ?? "", /base_evidence_missing/);
	});

	it("ends round 0 with one keyed refusal when the stored proof is gone at build launch", async () => {
		const { github, executor, clock, start } = world();
		github.add(labeled(14));
		executor.behaviors = [{ kind: "pass", usage: 10 }];
		executor.acceptBehavior = { kind: "pass", usage: 20 };
		const ready = executor.baseCheck.bind(executor);

		executor.baseCheck = async (input) => {
			if (input.readOnly !== true) return ready(input);
			executor.baseChecks.push(input);

			return {
				kind: "refused",
				failure: {
					binding: input.binding,
					receiptDigest: digestOf("missing"),
					reason: "base_evidence_missing",
					scenarios: [],
				},
			};
		};

		const controller = start();

		for (let tick = 0; tick < 4; tick++) {
			await once(controller);
			clock.t += 600_000;
		}

		assert.ok(!executor.launches.some((l) => l.stage === "build"));
		assert.equal(statuses(github, 14).at(-1)?.endsWith(":failed"), true);
		assert.equal(refusals(github).length, 1);
		assert.match(refusals(github)[0] ?? "", /: base_evidence_missing\. /);
	});

	it("keeps a pending check running across ticks and restarts without another model launch", async () => {
		const { github, executor, files, clock, start } = world();
		github.add(labeled(14));
		executor.behaviors = [{ kind: "pass", usage: 10 }];
		executor.acceptBehavior = { kind: "pass", usage: 20 };
		executor.baseOutcome = "checking";
		const first = start();

		for (let tick = 0; tick < 4; tick++) {
			await first.tick();
			await settle();
		}

		assert.equal(statuses(github, 14).at(-1), "5:running");
		assert.ok(executor.baseChecks.length >= 2);
		const claim = files.claims.get(runOf(14));
		assert.equal(claim?.stage, "accept");
		assert.equal(claim?.baseCheck?.acceptAttempt, 1);
		assert.equal(claim?.usage, 30);
		assert.equal((await roundTripQualification(files)).kind, "checking");
		executor.baseOutcome = "ready";
		clock.t += 60_000;
		const restarted = start();
		await once(restarted);
		assert.deepEqual(
			executor.launches.map((l) => l.stage),
			["specify", "accept"],
		);
		assert.equal(files.claims.get(runOf(14))?.stage, "build");
		assert.equal(keyed(github, 14, "acceptance").length, 1);
		assert.equal(refusals(github).length, 0);
	});

	it("persists base interruption and its retry deadline across a restart", async () => {
		const f = world();
		f.files.accounting = fileRunFiles(f.files.artifactRoot).accounting;
		f.github.add(labeled(14));
		f.executor.behaviors = [{ kind: "pass", usage: 10 }];
		f.executor.acceptBehavior = { kind: "pass", usage: 20 };
		f.executor.baseOutcome = "interrupted";
		await once(f.start());

		const ended = await f.files.accounting!.readAttempt(
			runOf(14),
			"accept",
			0,
			1,
		);

		assert.equal(ended?.disposition, "interrupted");
		assert.equal(ended?.next.kind, "base_retry");
		f.clock.t += 5_000;
		f.executor.baseOutcome = "ready";
		const restarted = f.start();
		await restarted.tick();
		assert.equal(f.executor.baseChecks.length, 1);
		f.clock.t += 5_000;
		await once(restarted);
		assert.equal(f.files.claims.get(runOf(14))?.stage, "build");
		assert.equal((await f.files.accounting!.attempts(runOf(14)))?.length, 3);
	});

	it("charges an interrupted check once to the accept attempt and retries the stored suite", async () => {
		const { github, executor, files, clock, start } = world();
		github.add(labeled(14));
		executor.behaviors = [{ kind: "pass", usage: 10 }];
		executor.acceptBehavior = { kind: "pass", usage: 20 };
		executor.baseOutcome = "interrupted";
		const controller = start();
		const report = await once(controller);
		assert.equal(report.totals.retries, 1);
		assert.equal(files.claims.get(runOf(14))?.baseCheck?.acceptAttempt, 2);
		executor.baseOutcome = "ready";
		clock.t += 60_000;
		await once(controller);
		assert.deepEqual(
			executor.baseChecks.map((c) => c.acceptAttempt),
			[1, 2],
		);
		assert.deepEqual(
			executor.launches.map((l) => l.stage),
			["specify", "accept"],
		);
		assert.equal(files.claims.get(runOf(14))?.stage, "build");
	});

	it("refuses an interruption on every accept attempt with its own public reason", async () => {
		const { github, executor, clock, start } = world();
		github.add(labeled(14));
		executor.behaviors = [{ kind: "pass", usage: 10 }];
		executor.acceptBehavior = { kind: "pass", usage: 20 };
		executor.baseOutcome = "interrupted";
		const controller = start();

		for (let i = 0; i < 6; i++) {
			await once(controller);
			clock.t += 600_000;
		}

		assert.ok(!executor.launches.some((l) => l.stage === "build"));
		assert.equal(statuses(github, 14).at(-1)?.endsWith(":failed"), true);
		assert.equal(refusals(github).length, 1);
		assert.match(
			refusals(github)[0] ?? "",
			/^Acceptance refused before build: base_interrupted\. Base qualification was interrupted on every accept attempt\.\n\n<!-- factory-base-refusal /,
		);
		assert.doesNotMatch(refusals(github)[0] ?? "", /base_evidence_missing/);
	});

	it("refuses accept on a checkout that omitted base paths, while specify still reads it", async () => {
		const { github, executor, logs, start } = world();
		github.add(labeled(14));
		executor.behaviors = [{ kind: "pass", usage: 10 }];
		executor.acceptBehavior = { kind: "pass", usage: 20 };
		executor.checkoutOmitted = 1;
		await once(start());
		assert.deepEqual(
			executor.launches.map((l) => l.stage),
			["specify"],
		);
		assert.equal(statuses(github, 14).at(-1)?.endsWith(":failed"), true);
		assert.ok(
			logs.some(
				(e) =>
					e.event === "stage_inputs_refused" &&
					e.fields.why === "checkout_base_tree_unsupported",
			),
		);
		assert.equal(executor.baseChecks.length, 0);
	});

	it("treats an unrecorded omission count as unsupported at accept", async () => {
		const { github, executor, start } = world();
		github.add(labeled(14));
		executor.behaviors = [{ kind: "pass", usage: 10 }];
		executor.acceptBehavior = { kind: "pass", usage: 20 };
		executor.checkoutOmitted = null;
		await once(start());
		assert.deepEqual(
			executor.launches.map((l) => l.stage),
			["specify"],
		);
	});
});

describe("Orchestrator stage results", () => {
	it("advances a passing accept to build and keeps its usage", async () => {
		const { github, executor, files, start } = world();

		github.add(labeled(14));
		executor.behaviors = [{ kind: "pass", usage: 812 }];
		executor.acceptBehavior = { kind: "pass", usage: 0 };

		const controller = start();
		const first = await controller.tick();

		assert.equal(first.executionEnabled, true);

		const launch = executor.launches[0];

		assert.ok(launch);
		assert.equal(launch.stage, "specify");
		assert.equal(launch.attempt, 1);
		assert.equal(launch.remainingRunTokens, TRUSTED_RUN_CAP);
		assert.deepEqual(launch.settings, {
			model: "openai/gpt-6.1-sol",
			fallback: null,
			budget: { maxTurns: 20, wallMs: 900_000, stallMs: 300_000 },
			maxTokens: null,
		});

		const report = await once(controller);

		assert.equal(report.runs[0]?.stage, "build");
		assert.equal(report.runs[0]?.status, "claimed");
		assert.equal(report.active, 1);
		assert.equal(report.totals.usage, 812);
		assert.equal(report.totals.failures, 0);
		assert.deepEqual(statuses(github, 14), [
			"1:claimed",
			"2:running",
			"3:claimed",
			"4:running",
			"5:claimed",
		]);
		assert.deepEqual(
			[...files.claims.values()],
			[
				endedClaim(14, 5, {
					stage: "build",
					status: "claimed",
					usage: 812,
					baseCheck: executor.baseChecks[0] && {
						kind: "qualified",
						proof: qualifiedProof(executor.baseChecks[0].binding),
						binding: executor.baseChecks[0].binding,
						acceptAttempt: 1,
						storedAttempt: 1,
						remainingAcceptMs: 900_000 - 1,
					},
					acceptWallMs: 1,
				}),
			],
		);
		assert.deepEqual(executor.baseChecks[0]?.binding, {
			runId: runOf(14),
			repo,
			issue: 14,
			contractDigest: executor.baseChecks[0]?.binding.contractDigest,
			acceptanceDigest: executor.baseChecks[0]?.binding.acceptanceDigest,
			baseSha: sha(MAIN_SHA),
			gateSha: sha(MAIN_SHA),
		});
	});

	it("passes the stage's fallback_model to the launch", async () => {
		const { github, executor, start } = world();

		github.add(labeled(14));
		setWorkflow(
			github,
			"  specify:\n    model: openai/gpt-6.1-sol\n",
			"  specify:\n    model: openai/gpt-6.1-sol\n    fallback_model: xai/grok-4.6\n",
		);
		executor.behaviors = [{ kind: "pass", usage: 1 }];

		await start().tick();

		assert.equal(executor.launches[0]?.settings.fallback, "xai/grok-4.6");
	});

	it("passes the run's remaining tokens and the next attempt to a retry", async () => {
		const { github, clock, executor, start } = world();

		github.add(labeled(14));
		executor.behaviors = [
			{ kind: "fail", usage: 120_000 },
			{ kind: "pass", usage: 1 },
		];

		const controller = start();

		await controller.tick();
		await controller.tick();
		clock.t += 10_000;
		await controller.tick();

		assert.equal(executor.launches[1]?.attempt, 2);
		assert.equal(
			executor.launches[1]?.remainingRunTokens,
			TRUSTED_RUN_CAP - 120_000,
		);
	});

	it("ends the run failed on a refusal, with no scheduler retry", async () => {
		const { github, executor, start } = world();

		github.add(labeled(14));
		executor.behaviors = [{ kind: "refuse", usage: 40 }];
		executor.fallback = { kind: "pass", usage: 0 };

		const controller = start();

		await controller.tick();

		const report = await controller.tick();

		assert.deepEqual(report.runs, []);
		assert.equal(report.totals.retries, 0);
		assert.equal(report.totals.failures, 1);
		assert.equal(report.totals.usage, 40);
		assert.equal(executor.launches.length, 1);
		assert.deepEqual(statuses(github, 14), [
			"1:claimed",
			"2:running",
			"3:failed",
		]);
	});

	it("ends the run budget_exhausted when the stage hits a cap", async () => {
		const { github, executor, start } = world();

		github.add(labeled(14));
		executor.behaviors = [{ kind: "budget", usage: 900 }];
		executor.fallback = { kind: "pass", usage: 0 };

		const controller = start();

		await controller.tick();

		const report = await controller.tick();

		assert.deepEqual(report.runs, []);
		assert.equal(report.totals.retries, 0);
		assert.equal(report.totals.usage, 900);
		assert.equal(statuses(github, 14).at(-1), "3:budget_exhausted");
	});

	it("keeps the usage a stalled stage reported before it stalled", async () => {
		const { github, clock, executor, start } = world();

		github.add(labeled(14));
		executor.behaviors = [{ kind: "hang" }];

		const controller = start();

		await controller.tick();
		executor.launches[0]?.progress(2_500);
		clock.t += 300_001;

		const report = await controller.tick();

		assert.equal(report.totals.stalls, 1);
		assert.equal(report.runs[0]?.status, "retrying");
		assert.equal(report.runs[0]?.usage, 2_500);
		assert.equal(report.totals.usage, 2_500);
	});

	it("blocks a run while the preflight fails and replays it once a later preflight passes", async () => {
		const { github, executor, start } = world();

		github.add(labeled(14));

		const controller = start();
		const blocked = await controller.tick();

		assert.equal(blocked.executionEnabled, false);
		assert.equal(blocked.runs[0]?.status, "blocked");
		assert.equal(executor.launches.length, 1);

		const still = await controller.tick();

		assert.equal(still.runs[0]?.status, "blocked");
		assert.equal(executor.launches.length, 1);
		assert.deepEqual(statuses(github, 14), ["1:claimed", "2:blocked"]);

		executor.fallback = { kind: "hang" };

		const running = await controller.tick();

		assert.equal(running.executionEnabled, true);
		assert.equal(running.runs[0]?.status, "running");
		assert.equal(executor.launches.length, 2);
		assert.deepEqual(statuses(github, 14), [
			"1:claimed",
			"2:blocked",
			"3:running",
		]);
	});

	it("stops leftover sandboxes once, before the first tick adopts any run", async () => {
		const { github, executor, start } = world();

		github.add(labeled(14));
		executor.fallback = { kind: "hang" };
		await start().tick();

		const controller = start();

		await controller.tick();
		await controller.tick();
		assert.equal(executor.recovered, 2);
	});

	it("waits for a launched stage and posts its end when a one-shot tick drains", async () => {
		const { github, executor, start } = world();
		let finish: (result: StageResult) => void = () => undefined;

		github.add(labeled(14));
		executor.behaviors = [
			{
				kind: "later",
				result: new Promise((done) => {
					finish = done;
				}),
			},
		];

		const controller = start();

		await controller.tick();

		const launch = executor.launches[0];

		assert.ok(launch);

		let waits = 0;
		executor.acceptBehavior = { kind: "pass", usage: 0 };

		const report = await controller.drain(async () => {
			waits++;
			finish(resultOf(launch, { kind: "passed" }, 77));
		});

		assert.ok(waits >= 1);
		assert.ok(report);
		assert.equal(report.runs[0]?.stage, "build");
		assert.equal(report.runs[0]?.status, "claimed");
		assert.equal(report.totals.usage, 77);
		assert.deepEqual(statuses(github, 14), [
			"1:claimed",
			"2:running",
			"3:claimed",
			"4:running",
			"5:claimed",
		]);
		assert.equal(await controller.drain(async () => undefined), null);
	});
});
