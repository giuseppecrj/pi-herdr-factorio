import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, it } from "node:test";
import { acquireLock } from "../../../host/controller/lock.ts";
import { HOLDER_FILE } from "../../../host/controller/state.ts";
import { admitTicket } from "../../../src/trust/admission.ts";
import { formatMarker, parseMarker } from "../../../src/trust/markers.ts";
import { READY_LABEL } from "../../../src/trust/policy.ts";
import { digestOf } from "../../../src/core/run.ts";
import { labelEvent } from "../../fake-ticket-adapter.ts";
import { EXE_DEV_PLATFORM } from "../../../src/trust/platform.ts";
import {
	repo,
	START,
	labeled,
	runOf,
	world,
	statuses,
	runIssues,
	stateDir,
	table,
	relabel,
	blockedClaim,
	capAt,
	omitFromList,
	UNPROVED,
	touches,
	staleList,
	issueReads,
	launched,
	REFUSALS,
} from "./orchestrator-fixtures.ts";

describe("Orchestrator refusals on unproved evidence", () => {
	for (const { name, reason, degrade } of UNPROVED) {
		it(`claims a ready issue on the next tick after ${name} reads complete again`, async () => {
			const { github, clock, start } = world();
			const restore = degrade(github.add(labeled(14)));
			const controller = start();
			const first = await controller.tick();

			assert.deepEqual(first.refused, [{ issue: 14, reasons: [reason] }]);
			assert.deepEqual(statuses(github, 14), []);

			restore();
			clock.t += 30_000;

			const second = await controller.tick();

			assert.deepEqual(runIssues(second), [14]);
			assert.deepEqual(statuses(github, 14), ["1:claimed", "2:blocked"]);
		});

		it(`lets a fresh controller claim the issue after ${name} reads complete again`, async () => {
			const { github, clock, start } = world();
			const restore = degrade(github.add(labeled(14)));
			const first = await start().tick();

			assert.deepEqual(first.refused, [{ issue: 14, reasons: [reason] }]);

			restore();
			clock.t += 30_000;

			const fresh = await start().tick();

			assert.deepEqual(runIssues(fresh), [14]);
			assert.deepEqual(statuses(github, 14), ["1:claimed", "2:blocked"]);
		});
	}

	it("reads only the refused issue again while its evidence is missing, and returns to 4 requests once it is claimed", async () => {
		const { github, clock, logs, start } = world();

		github.add(labeled(14));

		const restore = UNPROVED[0]?.degrade(github.add(labeled(15)));
		const controller = start();

		await controller.tick();
		clock.t += 30_000;
		await controller.tick();
		clock.t += 30_000;
		github.calls.length = 0;
		logs.length = 0;

		const missing = await controller.tick();
		const own = github.calls.filter((call) => touches(call, 15));

		assert.deepEqual(runIssues(missing), [14]);
		assert.deepEqual(missing.refused, [
			{ issue: 15, reasons: ["no_label_event"] },
		]);
		assert.equal(
			github.calls.length - own.length,
			4,
			JSON.stringify(github.calls),
		);
		assert.equal(own.length, 2, JSON.stringify(github.calls));
		assert.ok(!github.calls.some((call) => touches(call, 14)));
		assert.deepEqual(
			logs.filter((entry) => entry.event === "admission_refused"),
			[
				{
					event: "admission_refused",
					fields: { issue: 15, reasons: "no_label_event", retry: true },
				},
			],
		);

		restore?.();
		clock.t += 30_000;

		const claimed = await controller.tick();

		assert.deepEqual(runIssues(claimed), [14, 15]);

		clock.t += 30_000;
		await controller.tick();
		clock.t += 30_000;
		github.calls.length = 0;
		await controller.tick();

		assert.equal(github.calls.length, 4, JSON.stringify(github.calls));
	});

	it("keeps a refusal backed by evidence settled until the issue changes", async () => {
		const { github, clock, logs, start } = world();

		github.add(
			labeled(14, {
				timeline: [
					labelEvent({
						id: 5,
						at: "2026-10-29T01:21:37Z",
						actor: "giuseppecrj",
					}),
					labelEvent({
						id: 6,
						at: "2026-10-29T01:21:37Z",
						actor: "giuseppecrj",
					}),
				],
			}),
		);

		const controller = start();
		const first = await controller.tick();

		assert.deepEqual(first.refused, [
			{ issue: 14, reasons: ["ambiguous_snapshot"] },
		]);
		assert.deepEqual(
			logs.filter((entry) => entry.event === "admission_refused"),
			[
				{
					event: "admission_refused",
					fields: { issue: 14, reasons: "ambiguous_snapshot", retry: false },
				},
			],
		);

		clock.t += 30_000;
		github.calls.length = 0;

		const second = await controller.tick();

		assert.deepEqual(second.refused, []);
		assert.equal(github.calls.length, 4, JSON.stringify(github.calls));
	});
});

describe("Orchestrator launch after a direct issue read", () => {
	it("releases a due retry whose closed issue the list still shows open, and gives its slot to the next issue", async () => {
		const { github, clock, executor, logs, wire, start } = world();
		const issue = github.add(labeled(14));

		capAt(github, 1);
		executor.behaviors = [{ kind: "fail", usage: 0 }];

		const controller = start();

		await controller.tick();

		const queued = await controller.tick();

		assert.equal(queued.runs[0]?.status, "retrying");

		github.add(labeled(15));
		issue.state = "closed";
		wire.intercept = staleList(github, 14);
		clock.t += 10_000;
		logs.length = 0;

		const report = await controller.tick();

		assert.deepEqual(launched(logs), [15]);
		assert.deepEqual(statuses(github, 14), [
			"1:claimed",
			"2:running",
			"3:retrying",
			"4:released",
		]);
		assert.deepEqual(
			report.runs.map((run) => [run.issue, run.status]),
			[[15, "blocked"]],
		);
	});

	it("releases a replayed blocked run whose closed issue the list still shows open, and gives its slot to the next issue", async () => {
		const { github, logs, wire, start } = world();
		const issue = github.add(labeled(14));

		capAt(github, 1);
		await start().tick();
		github.add(labeled(15));
		issue.state = "closed";
		wire.intercept = staleList(github, 14);
		logs.length = 0;

		const report = await start().tick();

		assert.deepEqual(launched(logs), [15]);
		assert.deepEqual(statuses(github, 14), [
			"1:claimed",
			"2:blocked",
			"3:released",
		]);
		assert.deepEqual(
			report.runs.map((run) => [run.issue, run.status]),
			[[15, "blocked"]],
		);
	});

	it("reuses this tick's direct read of an issue the list omits", async () => {
		const { github, clock, executor, logs, wire, start } = world();

		github.add(labeled(14));
		executor.behaviors = [{ kind: "fail", usage: 0 }];

		const controller = start();

		await controller.tick();
		await controller.tick();
		wire.intercept = omitFromList(github, 14);
		clock.t += 10_000;
		github.calls.length = 0;
		logs.length = 0;
		await controller.tick();

		assert.deepEqual(launched(logs), [14]);
		assert.equal(issueReads(github, 14), 1, JSON.stringify(github.calls));
	});
});

describe("Orchestrator terminal marker trust", () => {
	it("rejects a terminal marker that disagrees with its admission", async () => {
		const ctx = world();
		const issue = ctx.github.add(labeled(14));

		await ctx.start().tick();

		const parsed = parseMarker(ctx.github.markers(14).at(-1) ?? "");

		assert.equal(parsed.kind, "marker");

		if (parsed.kind !== "marker") throw new Error("fixture");

		issue.comments = [];
		ctx.github.comment(
			issue,
			formatMarker({
				...parsed.marker,
				seq: 3,
				status: "released",
				workflowDigest: digestOf("different workflow"),
			}),
		);

		const report = await ctx.start().tick();

		assert.deepEqual(report.corrupt, [
			{ issue: 14, defect: "record_mismatch" },
		]);
		assert.deepEqual(statuses(ctx.github, 14), ["3:released"]);
		assert.deepEqual(ctx.files.claims.get(runOf(14)), blockedClaim(14, 2));
	});
});

describe("Orchestrator terminal memory across events", () => {
	it("keeps an older ended event ended when a newer event holds the highest record", async () => {
		const { github, executor, start } = world();
		const issue = github.add(labeled(14));
		const first = [...issue.timeline];

		await start().tick();
		relabel(github, issue);
		await start().tick();
		issue.labels = [];
		await start().tick();

		assert.deepEqual(statuses(github, 14), [
			"1:claimed",
			"2:blocked",
			"3:released",
			"4:claimed",
			"5:blocked",
			"6:released",
		]);

		const launches = executor.launches.length;

		issue.labels = [READY_LABEL];
		issue.timeline = first;
		issue.comments = issue.comments.filter(
			(comment) => !comment.body.includes(runOf(14)),
		);
		issue.updatedAt = "2026-10-29T02:40:00Z";

		const report = await start().tick();

		assert.deepEqual(report.runs, []);
		assert.equal(executor.launches.length, launches);
		assert.deepEqual(statuses(github, 14), [
			"4:claimed",
			"5:blocked",
			"6:released",
		]);
	});
});

describe("Orchestrator refusal classification", () => {
	for (const { expect, settles, degrade } of REFUSALS) {
		const [kind] = expect.split(":");

		it(`${settles ? "keeps" : "reads again"} a fresh candidate refused for ${expect} at the same updated_at`, async () => {
			const ctx = world();
			const { github, clock, store, wire } = ctx;
			const issue = github.add(labeled(14));
			const before = structuredClone(issue);
			const record = store.record;

			degrade(ctx, issue);

			const proof = await admitTicket({
				platform: EXE_DEV_PLATFORM,
				exec: (command, args) => (wire.intercept ?? github.exec)(command, args),
				env: () => "/home/exedev",
				repo,
				issue: 14,
				allowlist: [repo],
				store,
			});

			assert.deepEqual(
				proof.reasons.map((reason) =>
					"detail" in reason ? `${reason.kind}:${reason.detail}` : reason.kind,
				),
				[expect],
			);

			const controller = ctx.start();
			const first = await controller.tick();

			assert.deepEqual(first.refused, [{ issue: 14, reasons: [kind] }]);
			clock.t += 30_000;

			if (settles) {
				github.calls.length = 0;

				const second = await controller.tick();

				assert.deepEqual(second.refused, []);
				assert.equal(github.calls.length, 4, JSON.stringify(github.calls));

				return;
			}

			assert.equal(issue.updatedAt, before.updatedAt);
			Object.assign(issue, before);
			github.beforeGraphql = null;
			wire.intercept = null;
			store.record = record;

			const second = await controller.tick();

			assert.equal(second.refused.length, 0);
			assert.deepEqual(runIssues(second), [14]);
		});
	}
});

describe("acquireLock", () => {
	const now = () => START;

	it("lets exactly one of many simultaneous controllers take a stale lock", async () => {
		const state = stateDir();

		writeFileSync(
			join(state, HOLDER_FILE),
			JSON.stringify({
				pid: 5000,
				startTime: "7",
				acquiredAt: "2026-10-29T01:00:00.000Z",
			}),
		);

		const results = await Promise.all(
			[1, 2, 3, 4, 5, 6, 7, 8].map((n) =>
				acquireLock({ stateDir: state, procs: table(6000 + n), now }),
			),
		);

		const kinds = results.map((result) => result.kind).sort();

		for (const result of results) {
			if (result.kind === "acquired") await result.lock.release();
		}

		assert.deepEqual(kinds, [
			"acquired",
			"held",
			"held",
			"held",
			"held",
			"held",
			"held",
			"held",
		]);
	});

	it("lets exactly one of two controller processes started together win, across 10 trials", async () => {
		const controller = new URL(
			"../../../host/controller/lock.ts",
			import.meta.url,
		).href;

		const script = `
			const { acquireLock, procTable } = await import(${JSON.stringify(controller)});
			const released = new Promise((done) => process.stdin.once("end", done));
			process.stdin.resume();
			const result = await acquireLock({ stateDir: process.argv[1], procs: procTable(), now: Date.now });
			process.stdout.write(result.kind);
			await released;
			if (result.kind === "acquired") await result.lock.release();
		`;

		const child = (state: string) => {
			let attempted = () => {};
			let finish = (_result: { error: Error | null; stdout: string }) => {};

			const ready = new Promise<void>((done) => {
				attempted = done;
			});

			const finished = new Promise<{ error: Error | null; stdout: string }>(
				(done) => {
					finish = done;
				},
			);

			const proc = execFile(
				process.execPath,
				[
					"--experimental-strip-types",
					"--input-type=module",
					"-e",
					script,
					state,
				],
				{ timeout: 10000 },
				(error, stdout) => {
					attempted();
					finish({ error, stdout });
				},
			);

			proc.stdout?.once("data", () => attempted());

			return {
				attempted: ready,
				finished,
				release: () => proc.stdin?.end(),
			};
		};

		const trials: string[] = [];

		for (let trial = 0; trial < 10; trial++) {
			const state = stateDir();

			writeFileSync(
				join(state, HOLDER_FILE),
				JSON.stringify({
					pid: 999_999_999,
					startTime: "7",
					acquiredAt: "2026-10-29T01:00:00.000Z",
				}),
			);

			const controllers = [child(state), child(state)];

			try {
				await Promise.all(controllers.map((c) => c.attempted));
			} finally {
				for (const c of controllers) c.release();
				const completed = await Promise.all(controllers.map((c) => c.finished));

				for (const result of completed) assert.equal(result.error, null);
				trials.push(
					completed
						.map((c) => c.stdout)
						.sort()
						.join("+"),
				);
			}
		}

		assert.deepEqual(
			trials.filter((kinds) => kinds !== "acquired+held"),
			[],
		);
	});

	it("stays held after the lock file is deleted", async () => {
		const state = stateDir();

		const first = await acquireLock({
			stateDir: state,
			procs: table(6001),
			now,
		});

		assert.equal(first.kind, "acquired");
		rmSync(join(state, HOLDER_FILE), { force: true });

		const second = await acquireLock({
			stateDir: state,
			procs: table(6002),
			now,
		});

		if (first.kind === "acquired") await first.lock.release();

		if (second.kind === "acquired") await second.lock.release();

		assert.equal(second.kind, "held");
	});
});
