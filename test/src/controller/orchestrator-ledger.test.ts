import assert from "node:assert/strict";
import {
	existsSync,
	mkdirSync,
	readFileSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { describe, it } from "node:test";
import {
	fileLedgerOutbox,
	readLedgerBacklog,
} from "../../../host/controller/outbox.ts";
import { fileRunFiles } from "../../../host/controller/run-files.ts";
import { readRunCharges } from "../../../host/controller/terminal.ts";
import { serveLoop } from "../../../host/controller/serve-loop.ts";
import { parseMarker } from "../../../src/trust/markers.ts";
import {
	AUTONOMY_DIGEST,
	contextPolicy,
	parseLedger,
} from "../../../src/ledger/schema.ts";
import { ledgerApiOf, readLedgerFile } from "../../../src/ledger/git.ts";
import { pumpLedger, type LedgerOutbox } from "../../../src/ledger/outbox.ts";
import { GitHubPublicationApi } from "../../../src/github/publish.ts";
import { LedgerGit, repo as ledgerRepo } from "../../ledger-git.ts";
import { digestOf } from "../../../src/core/run.ts";
import { isGitSha } from "../../../src/config/schema.ts";
import {
	MAIN_SHA,
	TRUSTED_RUN_CAP,
	TRUSTED_WORKFLOW,
} from "../../fake-ticket-adapter.ts";
import { EXE_DEV_PLATFORM } from "../../../src/trust/platform.ts";
import {
	sha,
	START,
	resultOf,
	QUESTIONS_TEXT,
	labeled,
	runOf,
	world,
	statuses,
	instrument,
	stateDir,
	deferred,
	writesWire,
	once,
} from "./orchestrator-fixtures.ts";

describe("ledger outbox enrollment", () => {
	const ledgerApi = (fake: LedgerGit) =>
		ledgerApiOf(
			new GitHubPublicationApi(
				fake.exec,
				ledgerRepo,
				EXE_DEV_PLATFORM,
				{},
				async () => true,
				async () => {},
			),
		);

	async function remoteRows(fake: LedgerGit) {
		const tip = fake.refs.get("factory/ledger") ?? assert.fail("no ledger");
		const tree = fake.trees.get(`commit:${tip}`)?.get("tree");
		assert.ok(tree !== undefined && isGitSha(tree));

		const file = await readLedgerFile(
			new GitHubPublicationApi(fake.exec, ledgerRepo, EXE_DEV_PLATFORM),
			tree,
		);

		return parseLedger(file.bytes);
	}

	function needsInfoWorld(outbox: LedgerOutbox) {
		const ctx = world(null, outbox);
		ctx.wire.intercept = writesWire(ctx.github, []);
		ctx.github.add(labeled(14));
		ctx.executor.outputs = [QUESTIONS_TEXT];
		ctx.executor.behaviors = [{ kind: "pass", usage: 300 }];

		return ctx;
	}

	it("a measurement enrollment failure cannot veto the terminal row or its outcome", async () => {
		const dir = stateDir();
		const outbox = fileLedgerOutbox(dir);
		const ctx = needsInfoWorld(outbox);
		let called = 0;
		ctx.options.measurement = {
			occupied: () => 0,
			terminal() {
				called++;
				throw new Error("measurement storage unavailable");
			},
		};
		await once(ctx.start());
		assert.equal(called, 1);
		assert.equal(
			(await outbox.scan())?.[0]?.row?.row.outcome.kind,
			"needs_info",
		);
		assert.ok(ctx.logs.some((entry) => entry.event === "measurement_failed"));
	});

	it("projects retained receipt facts, model identities and uncertain charges without counting aggregate children twice", async () => {
		const dir = stateDir();
		const outbox = fileLedgerOutbox(dir);
		const ctx = needsInfoWorld(outbox);
		const native = fileRunFiles(dir);
		ctx.files.accounting = native.accounting;
		ctx.files.terminalEvidence = native.terminalEvidence;
		await instrument(native);
		const controller = ctx.start();
		await controller.tick();
		const input = ctx.executor.launches[0];
		assert.ok(input);
		const receipt = resultOf(input, { kind: "passed" }, 300).receipt;
		const stage = join(dir, "stages", runOf(14), "specify-1");
		mkdirSync(join(stage, "draft"), { recursive: true });
		writeFileSync(join(stage, "receipt.json"), JSON.stringify(receipt));
		writeFileSync(join(stage, "specify.json"), "{}");
		writeFileSync(
			join(stage, "draft", "egress.requests.jsonl"),
			`${JSON.stringify({ kind: "result", req: 1, inputTokens: 300, outputTokens: 0 })}\n${JSON.stringify({ kind: "dispatch", req: 2, inputTokenEstimate: 20, maxOutputTokens: 100 })}\n`,
		);
		writeFileSync(
			join(stage, "draft", "receipt.json"),
			JSON.stringify({
				...receipt,
				models: { ...receipt.models, observed: "gpt-6.1-sol" },
				fallback: {
					requested: "xai/grok-4.6",
					observed: "grok-4.6",
					outcome: { kind: "passed" },
					settlement: { event: "agent_settled", aborted: false },
					refusal: null,
				},
			}),
		);
		await once(controller);
		const row = (await outbox.scan())?.[0]?.row?.row;
		assert.ok(row);
		assert.equal(row.stages.kind, "known");
		assert.equal(row.models.kind, "known");
		assert.deepEqual(row.usage.parentTokens, { kind: "known", value: 300 });
		assert.deepEqual(row.usage.childTokens, { kind: "known", value: 0 });
		assert.deepEqual(row.usage.unattributedTokens, {
			kind: "known",
			value: 120,
		});
		assert.deepEqual(row.previousRunId, { kind: "known", value: null });
		assert.equal(row.usage.tokens.total, 420);
		assert.equal(row.usage.tokens.kind, "uncertain");
		assert.ok(row.gaps.includes("request_unsettled"));
		assert.equal(
			row.stages.kind === "known" && row.stages.value[0]?.tokens.total,
			420,
		);
		assert.equal(
			row.stages.kind === "known" && row.stages.value[0]?.attempts.kind,
			"known",
		);
		assert.equal(
			row.models.kind === "known" && row.models.value[0]?.observed.kind,
			"known",
		);
		assert.equal(row.redactedReceiptDigests.length, 2);
		assert.equal(row.contextPressure.kind, "unavailable");
		assert.deepEqual(row.startedAt, {
			kind: "known",
			value: new Date(START).toISOString(),
		});
		assert.equal(row.provenance.kind, "production");
		assert.equal(row.models.kind === "known" && row.models.value.length, 2);
		assert.equal(
			row.models.kind === "known" && row.models.value[1]?.requested,
			"xai/grok-4.6",
		);

		const accept = join(dir, "stages", runOf(14), "accept-1");
		mkdirSync(accept);
		writeFileSync(
			join(accept, "receipt.json"),
			JSON.stringify({
				...receipt,
				stage: "accept",
				usage: { ...receipt.usage, total: 20, parent: 20, gateway: 20 },
			}),
		);
		const later = await native.terminalEvidence?.(runOf(14), 300, null);
		assert.deepEqual(
			later?.stages?.kind === "known" && later.stages.value.map((s) => s.stage),
			["specify", "accept"],
		);
	});

	it("keeps the ordinary terminal path's admitted verification context when the workflow changes", async () => {
		const dir = stateDir();
		const native = fileRunFiles(dir);
		const ctx = needsInfoWorld(native.ledger!);
		ctx.files.accounting = native.accounting;

		const context = {
			kind: "verification",
			policy: {
				workflowSha: sha(MAIN_SHA),
				workflowDigest: digestOf(TRUSTED_WORKFLOW),
				gates: {
					kind: "known",
					value: { sourceSha: sha(MAIN_SHA), digest: digestOf("gates") },
				},
				autonomy: {
					approveMerge: "always",
					land: "propose",
					digest: AUTONOMY_DIGEST,
				},
			},
			trustedCap: TRUSTED_RUN_CAP,
			manifestDigest: digestOf("admitted manifest"),
			effectiveCap: 12_000,
		} as const;

		assert.equal(
			await native.accounting?.begin({
				v: 2,
				runId: runOf(14),
				startedAt: new Date(START).toISOString(),
				context,
			}),
			true,
		);
		const stage = deferred();
		ctx.executor.behaviors = [stage.behavior];
		const controller = ctx.start();
		await controller.tick();
		const changed = `${TRUSTED_WORKFLOW}\nChanged guidance after admission.\n`;
		ctx.github.workflow = changed;
		await controller.tick();
		const launch = ctx.executor.launches[0];
		assert.ok(launch);
		stage.finish(resultOf(launch, { kind: "passed" }, 300));
		await once(controller);
		const row = (await native.ledger?.scan())?.[0]?.row?.row;
		assert.ok(row && row.v === 5);
		assert.equal(row.outcome.kind, "needs_info");
		assert.deepEqual(row.runContext, context);
		assert.equal(row.provenance.kind, "verification");
		assert.deepEqual(row.terminalWorkflowObservation, {
			kind: "known",
			value: { workflowSha: sha(MAIN_SHA), workflowDigest: digestOf(changed) },
		});
		assert.equal(
			contextPolicy(row.runContext)?.workflowDigest,
			digestOf(TRUSTED_WORKFLOW),
		);
		const before = readFileSync(join(dir, "ledger", runOf(14), "row.json"));
		ctx.github.workflow = null;
		await ctx.start().tick();
		assert.ok(
			readFileSync(join(dir, "ledger", runOf(14), "row.json")).equals(before),
		);
	});

	it("makes accounting unavailable, never a known empty zero, when the stages directory cannot be read", async () => {
		const dir = stateDir();
		const native = fileRunFiles(dir);
		await instrument(native);

		const none = await native.terminalEvidence?.(runOf(14), 7, null);
		assert.deepEqual(none?.stages, { kind: "known", value: [] });

		mkdirSync(join(dir, "stages"), { recursive: true });
		writeFileSync(join(dir, "stages", runOf(14)), "not a directory");

		const unreadable = await native.terminalEvidence?.(runOf(14), 7, null);
		const gap = { kind: "unavailable", reason: "receipt_invalid" };
		assert.deepEqual(unreadable?.stages, gap);
		assert.deepEqual(unreadable?.models, gap);
		assert.deepEqual(unreadable?.usage, {
			tokens: {
				kind: "lower_bound",
				unit: "tokens",
				total: 7,
				reason: "receipt_invalid",
			},
			parentTokens: gap,
			childTokens: gap,
			unattributedTokens: gap,
			money: { kind: "unavailable", reason: "provider_not_reported" },
		});
		assert.deepEqual(unreadable?.redactedReceiptDigests, []);
	});

	it("records interrupted attempts on the terminal row without charging the interruption twice", async () => {
		const dir = stateDir();
		const outbox = fileLedgerOutbox(dir);
		const ctx = world(null, outbox);

		ctx.files.accounting = fileRunFiles(dir).accounting;
		await instrument(ctx.files);
		ctx.github.add(labeled(14));
		ctx.executor.behaviors = [{ kind: "hang" }];
		await ctx.start().tick();
		ctx.executor.spentBy.set("specify-1", 17);
		await ctx.start().tick();
		ctx.clock.t += 10_000;
		ctx.executor.behaviors = [{ kind: "refuse", usage: 3 }];
		await once(ctx.start());
		const row = (await outbox.scan())?.[0]?.row?.row;

		assert.ok(row);
		assert.deepEqual(row.interruptedAttempts, { kind: "known", value: 1 });
		assert.equal(row.usage.tokens.total, 20);
	});

	it("F10 feedback cannot revive a needs_info terminal run", async () => {
		const outbox = fileLedgerOutbox(stateDir());
		const ctx = needsInfoWorld(outbox);
		const controller = ctx.start();
		await once(controller);
		assert.equal(
			(await outbox.scan())?.[0]?.row?.row.outcome.kind,
			"needs_info",
		);
		const launches = ctx.executor.launches.length;
		const issue = ctx.github.issues.get(14);

		assert.ok(issue && ctx.executor.candidate);
		ctx.github.comment(issue, "Please fix", {
			login: "giuseppecrj",
			type: "User",
		});
		ctx.github.reviews.set(99, [
			{
				id: 3,
				state: "CHANGES_REQUESTED",
				commit_id: MAIN_SHA,
				body: "fix",
				submitted_at: "2026-11-07T00:00:00Z",
				user: { login: "writer" },
			},
		]);
		let observations = 0;
		ctx.executor.candidate.observe = async () => {
			observations++;
			throw new Error("terminal run must not be observed for feedback");
		};

		await ctx.start().tick();
		await ctx.start().tick();

		assert.equal(observations, 0);
		assert.equal(ctx.executor.launches.length, launches);
		assert.equal(
			statuses(ctx.github, 14).at(-1)?.endsWith(":needs_info"),
			true,
		);
	});

	it("keeps the terminal snapshot before the needs_info marker and freezes one row after it", async () => {
		const dir = stateDir();
		const outbox = fileLedgerOutbox(dir);
		const ctx = needsInfoWorld(outbox);
		const runDir = join(dir, "ledger", runOf(14));
		const seen: string[] = [];
		const writes: string[] = [];
		const inner = writesWire(ctx.github, writes);

		ctx.wire.intercept = async (command, args) => {
			const body = args.find((arg) => arg.startsWith("body="))?.slice(5) ?? "";
			const parsed = parseMarker(body);

			if (parsed.kind === "marker" && parsed.marker.status === "needs_info")
				seen.push(
					`${existsSync(join(runDir, "terminal.json"))}:${existsSync(join(runDir, "row.json"))}`,
				);

			return inner(command, args);
		};

		await once(ctx.start());
		assert.equal(statuses(ctx.github, 14).at(-1), "3:needs_info");
		assert.deepEqual(seen, ["true:false"]);

		const jobs = (await outbox.scan()) ?? assert.fail("scan");
		assert.equal(jobs.length, 1);
		const row = jobs[0]?.row?.row ?? assert.fail("row");
		assert.equal(row.outcome.kind, "needs_info");
		assert.equal(row.terminalMarker.seq, 3);
		assert.deepEqual(row.usage.tokens, {
			kind: "lower_bound",
			unit: "tokens",
			total: 300,
			reason: "not_instrumented",
		});
		assert.equal(row.usage.money.kind, "unavailable");
		assert.equal(row.issue, 14);

		const fake = new LedgerGit();
		const first = await pumpLedger(outbox, ledgerApi(fake), ctx.clock.now());
		assert.equal(first.published, 1);
		assert.equal(first.pending, 0);
		const again = await pumpLedger(outbox, ledgerApi(fake), ctx.clock.now());
		assert.deepEqual([again.published, again.pending], [0, 0]);

		const restarted = ctx.start();
		await once(restarted);
		await once(restarted);
		assert.deepEqual(await outbox.scan(), []);
		const rows = await remoteRows(fake);
		assert.equal(rows.length, 1);
		assert.equal(rows[0]?.kind === "known" && rows[0].row.runId, runOf(14));
	});

	it("finishes the row from the confirmed marker after a crash before row.json", async () => {
		const dir = stateDir();
		const outbox = fileLedgerOutbox(dir);
		const ctx = needsInfoWorld(outbox);
		await once(ctx.start());
		const rowPath = join(dir, "ledger", runOf(14), "row.json");
		const before = readFileSync(rowPath);
		rmSync(rowPath);
		assert.equal((await outbox.scan())?.[0]?.row, null);

		const restarted = ctx.start();
		await once(restarted);
		await once(restarted);
		assert.ok(readFileSync(rowPath).equals(before));
		assert.equal(ctx.executor.launches.length, 1);
	});

	it("posts no marker for an unencodable snapshot, reports it blocked, and ends once it encodes", async () => {
		const dir = stateDir();
		const outbox = fileLedgerOutbox(dir);
		const ctx = needsInfoWorld(outbox);
		const native = fileRunFiles(dir);
		let mismatched = true;

		ctx.files.accounting = {
			...(native.accounting ?? assert.fail("accounting")),
			start: async (runId) => {
				const start = await native.accounting?.start(runId);

				return start == null || !mismatched
					? start
					: {
							...start,
							context: {
								kind: "production" as const,
								trustedCap: TRUSTED_RUN_CAP,
								policy: {
									...contextPolicy(start.context)!,
									workflowDigest: digestOf("other"),
								},
							},
						};
			},
		};
		await instrument(native);
		const controller = ctx.start();
		await once(controller);

		assert.notEqual(statuses(ctx.github, 14).at(-1), "3:needs_info");
		assert.ok(ctx.logs.some((entry) => entry.event === "ledger_row_invalid"));
		assert.deepEqual(
			((await outbox.scan()) ?? assert.fail("scan")).map((job) => [
				job.runId,
				job.row,
				job.retry?.reason,
				job.retry?.blocked,
			]),
			[[runOf(14), null, "row_invalid", true]],
		);
		const backlog = await readLedgerBacklog(dir, ctx.clock.now());
		assert.deepEqual(
			[backlog.state, backlog.pending, backlog.blocked, backlog.lastError],
			["blocked", 1, 1, "row_invalid"],
		);

		mismatched = false;
		ctx.clock.t += 60_000;
		await once(controller);
		assert.equal(statuses(ctx.github, 14).at(-1), "3:needs_info");
		assert.equal(
			(await outbox.scan())?.[0]?.row?.row.outcome.kind,
			"needs_info",
		);
		assert.equal(ctx.executor.launches.length, 1);
	});

	it("retries a failed freeze on later ticks until row.json is durable, without a restart", async () => {
		const dir = stateDir();
		const real = fileLedgerOutbox(dir);
		let failures = 3;
		let calls = 0;

		const outbox: LedgerOutbox = {
			...real,
			freeze: async (runId, marker) => {
				calls += 1;

				if (failures > 0) {
					failures -= 1;

					return "unwritable";
				}

				return real.freeze(runId, marker);
			},
		};

		const ctx = needsInfoWorld(outbox);
		const controller = ctx.start();
		const rowPath = join(dir, "ledger", runOf(14), "row.json");

		for (let tick = 0; tick < 6 && !existsSync(rowPath); tick++) {
			ctx.clock.t += 60_000;
			await once(controller);
		}

		assert.equal(statuses(ctx.github, 14).at(-1), "3:needs_info");
		assert.equal(existsSync(rowPath), true);
		assert.equal(calls, 4);
		const settled = calls;
		await once(controller);
		await once(controller);
		assert.equal(calls, settled);
		assert.equal(ctx.executor.launches.length, 1);
	});

	it("serve pumps the outbox after every tick", async () => {
		const ctx = world();
		const stop = new AbortController();
		const order: string[] = [];
		let ticks = 0;

		await serveLoop({
			platform: EXE_DEV_PLATFORM,
			orchestrator: ctx.start(),
			stateDir: stateDir(),
			signal: stop.signal,
			log: () => {},
			pump: async () => {
				order.push(`pump${ticks}`);

				return null;
			},
			sleep: async () => {
				ticks += 1;
				order.push(`sleep${ticks}`);

				if (ticks === 2) stop.abort();
			},
		});

		assert.deepEqual(order, ["pump0", "sleep1", "pump1", "sleep2"]);
	});

	it("posts no terminal marker while the snapshot cannot be written, then ends once it can", async () => {
		const dir = stateDir();
		const real = fileLedgerOutbox(dir);
		let writable = false;

		const outbox: LedgerOutbox = {
			...real,
			prepare: async (runId, snapshot) =>
				writable && real.prepare(runId, snapshot),
		};

		const ctx = needsInfoWorld(outbox);
		const controller = ctx.start();
		await once(controller);
		assert.notEqual(statuses(ctx.github, 14).at(-1), "3:needs_info");
		assert.ok(
			ctx.logs.some((entry) => entry.event === "ledger_terminal_unwritable"),
		);

		writable = true;
		ctx.clock.t += 60_000;
		await once(controller);
		assert.equal(statuses(ctx.github, 14).at(-1), "3:needs_info");
		assert.equal(
			(await outbox.scan())?.[0]?.row?.row.outcome.kind,
			"needs_info",
		);
		assert.equal(ctx.executor.launches.length, 1);
	});
});

describe("terminal rows keep the real cause", () => {
	async function causeWorld(setup: (f: ReturnType<typeof world>) => void) {
		const dir = stateDir();
		const outbox = fileLedgerOutbox(dir);
		const f = world(null, outbox);
		const native = fileRunFiles(dir);
		f.files.accounting = native.accounting;
		f.files.terminalEvidence = native.terminalEvidence;
		await instrument(f.files);
		f.github.add(labeled(14));
		setup(f);
		const controller = f.start();

		for (let tick = 0; tick < 4; tick++) {
			await once(controller);
			f.clock.t += 600_000;
		}

		const row = (await outbox.scan())?.[0]?.row?.row;
		assert.ok(row?.v === 5, "a version 5 row");

		return { ...f, dir, row };
	}

	it("names the stage allowance a budget-exhausted stage spent", async () => {
		const { row } = await causeWorld((f) => {
			f.executor.behaviors = [{ kind: "budget", usage: 900 }];
		});

		assert.deepEqual(row.outcome, {
			kind: "budget_exhausted",
			stage: "specify",
			cap: { kind: "known", value: "stage_tokens" },
		});
		assert.deepEqual(row.failure, {
			kind: "known",
			value: {
				stage: "specify",
				class: "budget",
				reason: "stage_tokens",
				failedVisibleChecks: [],
				retainedPatch: null,
			},
		});
		assert.deepEqual(row.acceptAttempts, { kind: "known", value: [] });
	});

	it("names the run cap when retries spend the run's tokens", async () => {
		const { row } = await causeWorld((f) => {
			f.executor.behaviors = [{ kind: "fail", usage: TRUSTED_RUN_CAP }];
		});

		assert.deepEqual(row.outcome, {
			kind: "budget_exhausted",
			stage: "specify",
			cap: { kind: "known", value: "run_tokens" },
		});
		assert.deepEqual(
			row.failure?.kind === "known" && [
				row.failure.value.class,
				row.failure.value.reason,
			],
			["budget", "run_tokens"],
		);
	});

	it("names a base_timeout refusal and records the refused accept attempt", async () => {
		const { row } = await causeWorld((f) => {
			f.executor.behaviors = [{ kind: "pass", usage: 10 }];
			f.executor.acceptBehavior = { kind: "pass", usage: 20 };
			f.executor.baseOutcome = "base_timeout";
		});

		assert.deepEqual(row.outcome, {
			kind: "failed",
			stage: "accept",
			cause: { kind: "known", value: "base_refused" },
		});
		assert.deepEqual(row.failure, {
			kind: "known",
			value: {
				stage: "accept",
				class: "base",
				reason: "base_timeout",
				failedVisibleChecks: [],
				retainedPatch: null,
			},
		});
		assert.deepEqual(row.acceptAttempts, {
			kind: "known",
			value: [{ attempt: 1, disposition: "base_refused" }],
		});

		const accept =
			row.stages.kind === "known"
				? row.stages.value.find((s) => s.stage === "accept")
				: undefined;

		assert.deepEqual(
			accept?.attempts.kind === "known" && accept.attempts.value.refused,
			1,
		);
	});

	it("names a provider refusal in the row and in status --json", async () => {
		const { row, dir } = await causeWorld((f) => {
			f.executor.behaviors = [{ kind: "refuse", usage: 40 }];
		});

		const expected = {
			kind: "known",
			value: {
				stage: "specify",
				class: "provider",
				reason: "refused",
				failedVisibleChecks: [],
				retainedPatch: null,
			},
		};

		assert.deepEqual(row.failure, expected);
		assert.deepEqual((await readRunCharges(dir, runOf(14), 0)).terminal, {
			outcome: row.outcome,
			failure: expected,
		});
	});
});
