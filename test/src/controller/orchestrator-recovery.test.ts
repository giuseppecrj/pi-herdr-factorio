import { CadenceRunner } from "../../../src/maintenance/cadence.ts";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import { fileRunFiles } from "../../../host/controller/run-files.ts";
import { writeStatus } from "../../../host/controller/state.ts";
import { Orchestrator } from "../../../src/controller/orchestrator.ts";
import { digestOf } from "../../../src/core/run.ts";
import { admitTicket } from "../../../src/trust/admission.ts";
import type { JsonValue } from "../../../src/core/json.ts";
import {
	BOT_LOGIN,
	FAKE_REPO,
	type FakeIssue,
	labelEvent,
	networkError,
	TRUSTED_RUN_CAP,
} from "../../fake-ticket-adapter.ts";
import { EXE_DEV_PLATFORM } from "../../../src/trust/platform.ts";
import {
	repo,
	START,
	labeled,
	runOf,
	world,
	statuses,
	runIssues,
	events,
	stateDir,
	relabel,
	hideMarker,
	failClaimWrite,
	blockedClaim,
	hideStatus,
	endedClaim,
	capAt,
	setWorkflow,
	omitFromList,
	EVENT_ID,
} from "./orchestrator-fixtures.ts";

const LABEL_AT = "2026-10-29T01:21:37Z";

/** Rewrites issue 14's ready event and its admission record as older code stored a bot's label. */
function botApplied(
	ctx: ReturnType<typeof world>,
	issue: FakeIssue,
	login: string,
): void {
	const key = `14/${EVENT_ID + 14}`;
	const receipt = ctx.store.records.get(key);

	assert.ok(receipt);
	ctx.store.records.set(key, { ...receipt, actor: login });
	ctx.github.permissions.set(login, "write");
	issue.timeline = [
		labelEvent({
			id: EVENT_ID + 14,
			at: LABEL_AT,
			actor: login,
			actorType: "Bot",
		}),
	];
}

describe("Orchestrator terminal claim records", () => {
	it("keeps a failed run's record until a read shows the marker, so a restart whose read hides it posts nothing", async () => {
		const ctx = world();
		const { github, clock, files, executor, start } = ctx;
		const issue = github.add(labeled(14));

		executor.fallback = { kind: "fail", usage: 0 };

		const controller = start();

		await controller.tick();
		await controller.tick();
		clock.t += 10_000;
		await controller.tick();
		await controller.tick();
		clock.t += 20_000;
		await controller.tick();

		const failed = await controller.tick();

		const ended = [
			"1:claimed",
			"2:running",
			"3:retrying",
			"4:running",
			"5:retrying",
			"6:running",
			"7:failed",
		];

		assert.deepEqual(failed.runs, []);
		assert.deepEqual(statuses(github, 14), ended);
		assert.deepEqual(
			files.claims.get(runOf(14)),
			endedClaim(14, 7, { status: "failed", attempt: 3 }),
		);

		const hidden = hideStatus(ctx, issue, "failed");

		issue.updatedAt = "2026-10-29T03:00:00Z";
		clock.t = Date.parse("2026-10-29T03:00:05Z");

		const restarted = await start().tick();

		assert.deepEqual(restarted.runs, []);
		assert.deepEqual(restarted.corrupt, []);
		assert.deepEqual(statuses(github, 14), ended);
		assert.equal(executor.launches.length, 3);
		assert.equal(files.claims.get(runOf(14))?.status, "failed");

		hidden.hidden = false;
		issue.updatedAt = "2026-10-29T03:10:00Z";
		clock.t = Date.parse("2026-10-29T03:10:05Z");

		const revealed = await start().tick();

		assert.deepEqual(revealed.runs, []);
		assert.deepEqual(revealed.corrupt, []);
		assert.deepEqual(
			files.claims.get(runOf(14)),
			endedClaim(14, 7, { status: "failed", attempt: 3 }),
		);

		const next = relabel(github, issue);

		executor.fallback = { kind: "unavailable" };
		clock.t += 32 * 60_000;

		const relabeled = await start().tick();

		assert.deepEqual(
			relabeled.runs.map((run) => [run.runId, run.status, run.seq]),
			[[next, "blocked", 9]],
		);
		assert.deepEqual(relabeled.corrupt, []);
		assert.deepEqual(statuses(github, 14), [
			...ended,
			"8:claimed",
			"9:blocked",
		]);
	});

	it("keeps a released run's record across a restart whose read hides the release, and the run takes no slot back", async () => {
		const ctx = world();
		const { github, clock, files, executor, start } = ctx;
		const issue = github.add(labeled(14));

		github.add(labeled(15));
		github.add(labeled(16));
		await start().tick();
		issue.state = "closed";
		issue.updatedAt = "2026-10-29T02:10:00Z";
		clock.t = Date.parse("2026-10-29T02:10:05Z");

		const closed = await start().tick();

		assert.deepEqual(runIssues(closed), [15, 16]);
		assert.deepEqual(statuses(github, 14), [
			"1:claimed",
			"2:blocked",
			"3:released",
		]);
		assert.deepEqual(
			files.claims.get(runOf(14)),
			endedClaim(14, 3, { status: "released" }),
		);

		issue.state = "open";
		issue.updatedAt = "2026-10-29T02:20:00Z";
		clock.t = Date.parse("2026-10-29T02:20:05Z");

		const hidden = hideStatus(ctx, issue, "released");
		const controller = start();
		const restarted = await controller.tick();

		assert.deepEqual(runIssues(restarted), [15, 16]);
		assert.deepEqual(restarted.corrupt, []);
		assert.equal(github.markers(14).length, 3);
		assert.equal(files.claims.get(runOf(14))?.status, "released");

		hidden.hidden = false;
		issue.updatedAt = "2026-10-29T02:30:00Z";
		clock.t = Date.parse("2026-10-29T02:30:05Z");

		const visible = await controller.tick();

		assert.deepEqual(runIssues(visible), [15, 16]);
		assert.deepEqual(visible.corrupt, []);
		assert.deepEqual(
			files.claims.get(runOf(14)),
			endedClaim(14, 3, { status: "released" }),
		);
		assert.equal(github.markers(14).length, 3);
		assert.deepEqual(statuses(github, 16), ["1:claimed", "2:blocked"]);
		assert.equal(executor.launches.length, 6);
	});

	it("does not revive a released event when its issue reopens and the comments read is empty", async () => {
		const ctx = world();
		const { github, clock, files, executor, start } = ctx;
		const issue = github.add(labeled(14, { author: "triager" }));
		const controller = start();

		await controller.tick();
		clock.t += 30_000;
		await controller.tick();
		issue.state = "closed";
		issue.updatedAt = "2026-10-29T02:01:00Z";
		github.now = issue.updatedAt;
		clock.t += 30_000;

		const closed = await controller.tick();

		assert.deepEqual(closed.runs, []);
		assert.deepEqual(
			files.claims.get(runOf(14)),
			endedClaim(14, 3, { status: "released" }),
		);

		issue.state = "open";
		issue.updatedAt = "2026-10-29T02:02:00Z";
		github.now = issue.updatedAt;
		clock.t += 60_000;

		const saved = issue.comments.splice(0);
		const reopened = await controller.tick();

		issue.comments.push(...saved);

		assert.deepEqual(reopened.runs, []);
		assert.deepEqual(reopened.corrupt, []);
		assert.equal(executor.launches.length, 1);
		assert.deepEqual(statuses(github, 14), [
			"1:claimed",
			"2:blocked",
			"3:released",
		]);

		issue.updatedAt = "2026-10-29T02:03:00Z";
		clock.t += 60_000;

		const revealed = await controller.tick();

		assert.deepEqual(revealed.runs, []);
		assert.deepEqual(revealed.corrupt, []);
		assert.deepEqual(
			files.claims.get(runOf(14)),
			endedClaim(14, 3, { status: "released" }),
		);

		issue.updatedAt = "2026-10-29T02:04:00Z";
		clock.t += 60_000;

		const emptied = issue.comments.splice(0);
		const reopenedAgain = await controller.tick();

		issue.comments.push(...emptied);

		assert.deepEqual(reopenedAgain.runs, []);
		assert.deepEqual(reopenedAgain.corrupt, []);
		assert.equal(executor.launches.length, 1);
		assert.deepEqual(statuses(github, 14), [
			"1:claimed",
			"2:blocked",
			"3:released",
		]);

		const next = relabel(github, issue);

		clock.t += 32 * 60_000;

		const relabeled = await controller.tick();

		assert.deepEqual(
			relabeled.runs.map((run) => [run.runId, run.status, run.seq]),
			[[next, "blocked", 5]],
		);
		assert.deepEqual(relabeled.corrupt, []);
		assert.equal(executor.launches.length, 2);
	});

	it("keeps a terminal record once a read shows its marker, reads it no more and loads it again after a restart", async () => {
		const { github, clock, files, start } = world();
		const issue = github.add(labeled(14));
		const controller = start();
		const released = endedClaim(14, 3, { status: "released" });

		await controller.tick();
		issue.state = "closed";
		issue.updatedAt = "2026-10-29T02:01:00Z";
		clock.t += 30_000;
		await controller.tick();

		assert.deepEqual(files.claims.get(runOf(14)), released);

		clock.t += 30_000;
		await controller.tick();

		assert.deepEqual([...files.claims.values()], [released]);

		clock.t += 30_000;
		github.calls.length = 0;
		await controller.tick();

		assert.equal(github.calls.length, 4, JSON.stringify(github.calls));

		const restarted = start();

		clock.t += 30_000;
		await restarted.tick();
		clock.t += 30_000;
		github.calls.length = 0;

		const report = await restarted.tick();

		assert.equal(github.calls.length, 4, JSON.stringify(github.calls));
		assert.deepEqual(report.runs, []);
		assert.deepEqual([...files.claims.values()], [released]);
		assert.deepEqual(statuses(github, 14), [
			"1:claimed",
			"2:blocked",
			"3:released",
		]);
	});

	it("keeps a budget-exhausted record that its posting tick read back, so a restart whose read lags posts nothing and a relabel dispatches", async () => {
		const ctx = world();
		const { github, clock, files, executor, start } = ctx;
		const issue = github.add(labeled(14));
		const other = github.add(labeled(15));

		github.add(labeled(16));
		executor.behaviors = [{ kind: "fail", usage: TRUSTED_RUN_CAP }];

		const controller = start();
		const exhausted = ["1:claimed", "2:running", "3:budget_exhausted"];

		const record = endedClaim(14, 3, {
			status: "budget_exhausted",
			usage: TRUSTED_RUN_CAP,
		});

		await controller.tick();
		clock.t += 30_000;
		github.now = "2026-10-29T02:00:30Z";

		const ended = await controller.tick();

		assert.deepEqual(runIssues(ended), [15, 16]);
		assert.deepEqual(statuses(github, 14), exhausted);
		assert.deepEqual(files.claims.get(runOf(14)), record);

		const hidden = hideStatus(ctx, issue, "budget_exhausted");

		issue.updatedAt = "2026-10-29T03:00:00Z";
		clock.t = Date.parse("2026-10-29T03:00:05Z");

		const restarted = await start().tick();

		assert.deepEqual(runIssues(restarted), [15, 16]);
		assert.deepEqual(restarted.corrupt, []);
		assert.deepEqual(restarted.ledgerBehind, [
			{ issue: 14, ledgerSeq: 2, localSeq: 3 },
		]);
		assert.deepEqual(statuses(github, 14), exhausted);

		hidden.hidden = false;
		issue.updatedAt = "2026-10-29T03:10:00Z";
		clock.t = Date.parse("2026-10-29T03:10:05Z");

		const revealed = await start().tick();

		assert.deepEqual(runIssues(revealed), [15, 16]);
		assert.deepEqual(revealed.corrupt, []);
		assert.deepEqual(files.claims.get(runOf(14)), record);

		const next = relabel(github, issue);

		other.state = "closed";
		other.updatedAt = "2026-10-29T02:31:00Z";
		clock.t += 32 * 60_000;

		const relabeled = await start().tick();

		assert.deepEqual(
			relabeled.runs.map((run) => [run.runId, run.status, run.seq]),
			[
				[next, "blocked", 5],
				[runOf(16), "blocked", 2],
			],
		);
		assert.deepEqual(relabeled.corrupt, []);
		assert.deepEqual(statuses(github, 14), [
			...exhausted,
			"4:claimed",
			"5:blocked",
		]);
	});

	it("keeps the terminal record a read shows when the record missed that rewrite, so a later lagging read posts nothing", async () => {
		const ctx = world();
		const { github, clock, files, start } = ctx;
		const issue = github.add(labeled(14));
		const controller = start();
		const ended = ["1:claimed", "2:blocked", "3:released"];

		await controller.tick();

		const writes = failClaimWrite(files, 3);

		issue.state = "closed";
		issue.updatedAt = "2026-10-29T02:01:00Z";
		clock.t += 30_000;
		await controller.tick();

		assert.deepEqual(statuses(github, 14), ended);
		assert.deepEqual(files.claims.get(runOf(14)), blockedClaim(14, 2));

		writes.failing = false;
		clock.t += 30_000;
		await start().tick();

		assert.deepEqual(
			[...files.claims.values()],
			[endedClaim(14, 3, { status: "released" })],
		);

		hideStatus(ctx, issue, "released");
		issue.updatedAt = "2026-10-29T02:05:00Z";
		clock.t += 5 * 60_000;

		const restarted = await start().tick();

		assert.deepEqual(restarted.runs, []);
		assert.deepEqual(restarted.corrupt, []);
		assert.deepEqual(statuses(github, 14), ended);
	});

	it("retries a failed terminal rewrite on every tick after its marker is read, then stops", async () => {
		const { github, clock, files, start } = world();
		const issue = github.add(labeled(14));
		const write = files.writeClaim;
		const control = { failing: true, attempts: 0 };

		files.writeClaim = async (claim) => {
			if (claim.status === "released") {
				control.attempts++;

				if (control.failing) return false;
			}

			return write(claim);
		};

		const controller = start();

		await controller.tick();
		clock.t += 30_000;
		await controller.tick();
		issue.state = "closed";
		issue.updatedAt = "2026-10-29T02:01:00Z";
		clock.t += 60_000;
		await controller.tick();

		assert.deepEqual(files.claims.get(runOf(14)), blockedClaim(14, 2));

		const failed = control.attempts;

		clock.t += 30_000;
		await controller.tick();

		assert.equal(control.attempts, failed + 1);
		assert.deepEqual(files.claims.get(runOf(14)), blockedClaim(14, 2));

		control.failing = false;
		clock.t += 30_000;
		await controller.tick();

		assert.deepEqual(
			files.claims.get(runOf(14)),
			endedClaim(14, 3, { status: "released" }),
		);

		const landed = control.attempts;

		clock.t += 30_000;
		await controller.tick();

		assert.equal(control.attempts, landed);
		assert.deepEqual(statuses(github, 14), [
			"1:claimed",
			"2:blocked",
			"3:released",
		]);
	});
});

describe("Orchestrator persisted claim slots", () => {
	it("holds the slot of a claim whose recovery read failed, and adopts it later within the cap", async () => {
		const { github, clock, start } = world();

		github.add(labeled(14));
		github.add(labeled(15));
		github.add(labeled(16));
		await start().tick();
		clock.t += 30_000;
		github.failures.set(
			`repos/${FAKE_REPO}/issues/14/comments`,
			networkError(),
		);

		const controller = start();
		const failed = await controller.tick();

		assert.deepEqual(runIssues(failed), [15]);
		assert.deepEqual(failed.queued, [16]);
		assert.deepEqual(statuses(github, 16), []);

		github.failures.clear();
		clock.t += 30_000;

		const next = await controller.tick();

		assert.deepEqual(runIssues(next), [14, 15]);
		assert.deepEqual(next.queued, [16]);
		assert.equal(next.maxConcurrent, 2);
		assert.deepEqual(statuses(github, 16), []);
	});

	it("adopts a claim whose corrupt ledger heals only when a slot is free", async () => {
		const { github, clock, start } = world();
		const issue = github.add(labeled(14));
		const other = github.add(labeled(15));

		github.add(labeled(16));

		const controller = start();

		await controller.tick();
		clock.t += 30_000;
		await controller.tick();

		const blocked = issue.comments[1];

		assert.ok(blocked);
		blocked.lastEditedAt = "2026-10-29T02:01:00Z";
		issue.updatedAt = "2026-10-29T02:01:00Z";
		clock.t += 60_000;

		const dropped = await controller.tick();

		assert.deepEqual(dropped.corrupt, [{ issue: 14, defect: "edited" }]);
		assert.deepEqual(runIssues(dropped), [15, 16]);

		issue.comments.pop();
		issue.updatedAt = "2026-10-29T02:02:00Z";
		clock.t += 60_000;

		const healed = await controller.tick();

		assert.deepEqual(healed.corrupt, []);
		assert.deepEqual(runIssues(healed), [15, 16]);
		assert.deepEqual(healed.queued, [14]);

		clock.t += 60_000;

		const waiting = await controller.tick();

		assert.deepEqual(runIssues(waiting), [15, 16]);
		assert.deepEqual(waiting.queued, [14]);

		other.state = "closed";
		other.updatedAt = "2026-10-29T02:03:00Z";
		clock.t += 60_000;

		const freed = await controller.tick();

		assert.deepEqual(runIssues(freed), [14, 16]);
		assert.deepEqual(freed.queued, []);
		assert.deepEqual(statuses(github, 14), ["1:claimed"]);
	});

	it("recovers a claim recorded before its first marker with its own slot before admitting fresh candidates", async () => {
		const { github, clock, files, start } = world();
		const first = github.add(labeled(14, { state: "closed" }));

		github.add(labeled(16));
		github.posts = ["lost"];

		const seed = await start().tick();

		assert.deepEqual(
			seed.runs.map((run) => [run.issue, run.markerPending]),
			[[16, true]],
		);
		assert.equal(files.claims.get(runOf(16))?.seq, null);
		assert.deepEqual(statuses(github, 16), []);

		first.state = "open";
		github.add(labeled(15));
		clock.t += 30_000;

		const recovered = await start().tick();

		assert.deepEqual(runIssues(recovered), [14, 16]);
		assert.deepEqual(recovered.queued, [15]);
		assert.deepEqual(statuses(github, 16), ["1:claimed", "2:blocked"]);
		assert.deepEqual(statuses(github, 15), []);
		assert.deepEqual(
			[...files.claims.keys()].sort(),
			[runOf(14), runOf(16)].sort(),
		);
	});

	it("cadence launches only with leftover capacity after real ticket dispatch and recovered reservations", async () => {
		for (const recovered of [false, true]) {
			const { github, executor, files, clock, options, start } = world();
			github.add(labeled(14));
			github.add(labeled(15));

			if (!recovered) executor.fallback = { kind: "hang" };

			if (recovered) {
				github.add(labeled(16));
				capAt(github, 3);
				github.posts = ["lost", "lost", "lost"];
				await start().tick();
				const admittedWorkflow = github.workflow;
				executor.workflow = () => admittedWorkflow;
				capAt(github, 2);
				clock.t += 30_000;
			}

			let launches = 0;
			options.cadence = new CadenceRunner({
				stateDir: stateDir(),
				repo,
				log: () => undefined,
				port: {
					execute: async (execution) => {
						launches++;

						return {
							kind: "passed",
							tokens: 0,
							exact: true,
							model: execution.settings.model,
							receiptDigest: digestOf("cadence priority"),
							output: '{"proposals":[]}',
							reason: "passed",
						};
					},
					retained: async () => {
						throw new Error("unexpected retained execution");
					},
					publish: async () => true,
				},
			});
			const controller = start();

			if (recovered) {
				await controller.tick();
				executor.fallback = { kind: "hang" };
				clock.t += 30_000;
			}

			const report = await controller.tick();
			await options.cadence.wait();
			assert.equal(report.dispatch.enabled, true);
			assert.equal(
				report.active,
				2,
				JSON.stringify({
					recovered,
					report,
					launches: executor.launches.map((launch) => launch.stage),
				}),
			);
			assert.equal(launches, 0);
			assert.deepEqual(runIssues(report), [14, 15]);

			if (recovered) {
				assert.deepEqual(report.queued, [16]);
				assert.equal(files.claims.size, 3);
				github.issues.get(14)!.state = "closed";
				clock.t += 30_000;
				const freed = await controller.tick();
				assert.ok(freed.runs.some((run) => run.issue === 16));
				assert.deepEqual(freed.queued, []);
				assert.equal(freed.active, 2);
				assert.equal(launches, 0);
			}
		}
	});

	it("an unavailable GitHub tick holds filing without aborting a running cadence audit", async () => {
		const { executor, clock, wire, store, options, start } = world();
		executor.ready = true;
		let signal: AbortSignal | null = null;
		let finish: () => void = () => undefined;

		const held = new Promise<void>((done) => {
			finish = done;
		});

		options.cadence = new CadenceRunner({
			stateDir: stateDir(),
			repo,
			log: () => undefined,
			port: {
				execute: async (execution, abort) => {
					signal = abort;
					await held;

					return {
						kind: "passed",
						tokens: 16,
						exact: true,
						model: execution.settings.model,
						receiptDigest: digestOf("transient cadence"),
						output: '{"proposals":[]}',
						reason: "passed",
					};
				},
				retained: async () => {
					throw new Error("unexpected retained execution");
				},
				publish: async () => true,
			},
		});
		const controller = start();
		await controller.tick();
		assert.equal(options.cadence.occupied(), 1);
		wire.intercept = async () => ({ code: 1, stdout: "", stderr: "HTTP 503" });
		clock.t += 30_000;
		const failedRead = await controller.tick();
		assert.equal(failedRead.dispatch.enabled, false);
		assert.ok(signal !== null);
		// SAFETY: the first healthy tick synchronously launched and captured this signal.
		assert.equal((signal as AbortSignal).aborted, false);
		store.local = "disabled";
		clock.t += 30_000;
		await controller.tick();
		// SAFETY: the same captured execution is still held by the fake model.
		assert.equal((signal as AbortSignal).aborted, true);
		finish();
		await options.cadence.wait();
	});

	it("recovers claims recorded before their first marker only while a slot is free, and lists the rest in queued", async () => {
		const { github, clock, files, start } = world();

		github.add(labeled(14));
		github.add(labeled(15));
		github.add(labeled(16));
		github.workflow = (github.workflow ?? "").replace(
			"max_concurrent: 2",
			"max_concurrent: 3",
		);
		github.posts = ["lost", "lost", "lost"];
		await start().tick();

		assert.equal(files.claims.size, 3);

		github.workflow = github.workflow.replace(
			"max_concurrent: 3",
			"max_concurrent: 2",
		);
		clock.t += 30_000;

		const controller = start();
		const recovered = await controller.tick();

		assert.deepEqual(runIssues(recovered), [14, 15]);
		assert.deepEqual(recovered.queued, [16]);
		assert.deepEqual(statuses(github, 16), []);

		clock.t += 30_000;

		const again = await controller.tick();

		assert.deepEqual(runIssues(again), [14, 15]);
		assert.deepEqual(again.queued, [16]);
		assert.equal(files.claims.size, 3);
	});

	it("lists a claimed run that waits for a slot after the cap is lowered in queued", async () => {
		const { github, clock, files, start } = world();

		const cap = (limit: number) => {
			github.workflow = (github.workflow ?? "").replace(
				/max_concurrent: \d/,
				`max_concurrent: ${limit}`,
			);
		};

		github.add(labeled(14));
		github.add(labeled(15));
		github.add(labeled(16));
		cap(3);
		await start().tick();

		assert.equal(files.claims.size, 3);

		cap(2);
		clock.t += 30_000;

		const controller = start();
		const waiting = await controller.tick();

		assert.deepEqual(runIssues(waiting), [14, 15]);
		assert.deepEqual(waiting.queued, [16]);
		assert.deepEqual(waiting.corrupt, []);
		assert.deepEqual(waiting.ledgerBehind, []);

		clock.t += 30_000;

		const again = await controller.tick();

		assert.deepEqual(runIssues(again), [14, 15]);
		assert.deepEqual(again.queued, [16]);
		assert.equal(files.claims.size, 3);
		assert.deepEqual(statuses(github, 16), ["1:claimed", "2:blocked"]);
	});

	it("keeps a ready claim the candidate list omits waiting for a slot on every tick", async () => {
		const { github, clock, files, wire, start } = world();

		github.add(labeled(14));
		const other = github.add(labeled(15));

		github.add(labeled(16));
		capAt(github, 3);
		await start().tick();

		assert.equal(files.claims.size, 3);

		capAt(github, 2);
		wire.intercept = omitFromList(github, 14);
		clock.t += 30_000;

		const controller = start();
		const lagging = await controller.tick();

		assert.deepEqual(runIssues(lagging), [15, 16]);
		assert.deepEqual(lagging.queued, [14]);
		assert.equal(lagging.maxConcurrent, 2);

		clock.t += 30_000;

		const again = await controller.tick();

		assert.deepEqual(runIssues(again), [15, 16]);
		assert.deepEqual(again.queued, [14]);

		wire.intercept = null;
		clock.t += 30_000;

		const listed = await controller.tick();

		assert.deepEqual(runIssues(listed), [15, 16]);
		assert.deepEqual(listed.queued, [14]);

		other.state = "closed";
		other.updatedAt = "2026-10-29T02:03:00Z";
		clock.t += 60_000;

		const freed = await controller.tick();

		assert.deepEqual(runIssues(freed), [14, 16]);
		assert.deepEqual(freed.queued, []);
		assert.deepEqual(statuses(github, 14), ["1:claimed", "2:blocked"]);
	});

	it("releases a closed claim from the read that shows it closed, without a slot, when a later issue read fails", async () => {
		const { github, clock, files, logs, wire, start } = world();
		const issue = github.add(labeled(14));

		github.add(labeled(15));
		github.add(labeled(16));
		capAt(github, 3);
		await start().tick();

		assert.equal(files.claims.size, 3);

		capAt(github, 2);
		issue.state = "closed";
		issue.updatedAt = "2026-10-29T02:00:20Z";
		clock.t += 30_000;

		let gets = 0;

		wire.intercept = async (command, args) => {
			const path = args.find((arg) => arg.startsWith("repos/")) ?? "";

			if (!args.includes("--method") && path.endsWith("/issues/14")) {
				gets += 1;

				if (gets >= 2) return networkError();
			}

			return github.exec(command, args);
		};

		const controller = start();
		const closed = await controller.tick();

		assert.deepEqual(runIssues(closed), [15, 16]);
		assert.deepEqual(closed.queued, []);
		assert.deepEqual(statuses(github, 14), [
			"1:claimed",
			"2:blocked",
			"3:released",
		]);
		assert.equal(files.claims.get(runOf(14))?.status, "released");
		assert.deepEqual(
			logs
				.filter((entry) => entry.event === "claim_released")
				.map((entry) => [entry.fields.issue, entry.fields.why]),
			[[14, "closed"]],
		);

		clock.t += 30_000;

		const next = await controller.tick();

		assert.deepEqual(runIssues(next), [15, 16]);
		assert.deepEqual(next.queued, []);
		assert.equal(statuses(github, 14).length, 3);
	});
});

describe("Orchestrator claims recorded before their first marker", () => {
	it("recovers one the candidate list omits from the issue read, with its own slot, before fresh admissions", async () => {
		const { github, clock, files, wire, start } = world();

		github.add(labeled(14));
		github.posts = ["lost"];
		await start().tick();

		assert.equal(files.claims.get(runOf(14))?.seq, null);
		assert.deepEqual(statuses(github, 14), []);

		github.add(labeled(15));
		github.add(labeled(16));
		wire.intercept = omitFromList(github, 14);
		clock.t += 30_000;

		const lagging = await start().tick();

		assert.deepEqual(runIssues(lagging), [14, 15]);
		assert.deepEqual(lagging.queued, [16]);
		assert.deepEqual(statuses(github, 14), ["1:claimed", "2:blocked"]);
		assert.deepEqual(statuses(github, 16), []);

		wire.intercept = null;
		clock.t += 30_000;

		const listed = await start().tick();

		assert.deepEqual(runIssues(listed), [14, 15]);
		assert.deepEqual(listed.queued, [16]);
		assert.deepEqual(statuses(github, 16), []);
	});

	it("does not cache a ready one the candidate list omits as decided", async () => {
		const { github, clock, files, wire, start } = world();

		github.add(labeled(14));
		github.posts = ["lost"];
		await start().tick();

		assert.equal(files.claims.get(runOf(14))?.seq, null);

		clock.t += 30_000;
		wire.intercept = omitFromList(github, 14);

		const controller = start();

		await controller.tick();
		wire.intercept = null;

		for (let n = 0; n < 2; n++) {
			clock.t += 30_000;

			const report = await controller.tick();

			assert.deepEqual(runIssues(report), [14]);
			assert.deepEqual(report.queued, []);
		}

		assert.deepEqual(statuses(github, 14), ["1:claimed", "2:blocked"]);
		assert.deepEqual(files.claims.get(runOf(14)), blockedClaim(14, 2));
	});

	it("releases one whose issue closed, keeps the released record, and does not rerun the event on reopen", async () => {
		const { github, clock, files, executor, logs, start } = world();
		const issue = github.add(labeled(14));

		github.posts = ["lost"];
		await start().tick();

		assert.equal(files.claims.get(runOf(14))?.seq, null);

		issue.state = "closed";
		issue.updatedAt = "2026-10-29T02:00:20Z";
		clock.t += 30_000;

		const closed = await start().tick();

		assert.deepEqual(closed.runs, []);
		assert.deepEqual(closed.queued, []);
		assert.deepEqual(statuses(github, 14), ["1:released"]);
		assert.deepEqual(
			[...files.claims.values()],
			[endedClaim(14, 1, { status: "released" })],
		);
		assert.deepEqual(
			logs
				.filter((entry) => entry.event === "claim_released")
				.map((entry) => [entry.fields.issue, entry.fields.why]),
			[[14, "closed"]],
		);

		issue.state = "open";
		issue.updatedAt = "2026-10-29T02:01:00Z";
		clock.t += 60_000;

		const reopened = await start().tick();

		assert.deepEqual(reopened.runs, []);
		assert.deepEqual(statuses(github, 14), ["1:released"]);
		assert.equal(executor.launches.length, 0);
	});

	it("keeps one whose issue closed while its admission record cannot be read, and releases it once it can", async () => {
		const { github, clock, files, store, start } = world();
		const issue = github.add(labeled(14));

		github.posts = ["lost"];
		await start().tick();
		issue.state = "closed";
		issue.updatedAt = "2026-10-29T02:00:20Z";

		const read = store.read;

		store.read = async () => ({ kind: "unreadable" });
		clock.t += 30_000;

		const controller = start();
		const unread = await controller.tick();

		assert.deepEqual(unread.runs, []);
		assert.deepEqual(statuses(github, 14), []);
		assert.equal(files.claims.get(runOf(14))?.seq, null);

		store.read = read;
		clock.t += 30_000;
		await controller.tick();

		assert.deepEqual(statuses(github, 14), ["1:released"]);
		assert.equal(files.claims.get(runOf(14))?.status, "released");
	});
});

describe("Orchestrator before the first workflow load", () => {
	it("projects only the last valid workflow's attention thresholds through status", async () => {
		const { github, start } = world();
		const controller = start();
		const trusted = github.workflow;
		assert.ok(trusted !== null);
		github.workflow = null;
		assert.equal((await controller.tick()).attentionThresholds, undefined);
		github.workflow = trusted
			.replace("waiting_ms: 259200000", "waiting_ms: 432000000")
			.replace("blocked_ms: 21600000", "blocked_ms: 28800000");
		const thresholds = { waitingMs: 432000000, blockedMs: 28800000 };
		assert.deepEqual((await controller.tick()).attentionThresholds, thresholds);
		github.workflow = github.workflow.replace(
			"waiting_ms: 432000000",
			"waiting_ms: -1",
		);
		const invalid = await controller.tick();
		assert.ok(invalid.dispatch.reasons.includes("workflow_unavailable"));
		assert.deepEqual(invalid.attentionThresholds, thresholds);
		github.workflow = null;
		assert.deepEqual((await controller.tick()).attentionThresholds, thresholds);
		const dir = mkdtempSync(join(tmpdir(), "threshold-status-"));

		try {
			assert.equal(await writeStatus(dir, invalid, EXE_DEV_PLATFORM), true);
			assert.deepEqual(
				JSON.parse(readFileSync(join(dir, "status.json"), "utf8"))
					.attentionThresholds,
				thresholds,
			);
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});
	it("adopts no run into a slot until the process has loaded a workflow", async () => {
		const { github, clock, files, start } = world();

		github.add(labeled(14));
		github.add(labeled(15));
		await start().tick();

		assert.equal(files.claims.size, 2);

		capAt(github, 1);
		clock.t += 30_000;

		const fresh = await start().tick();

		assert.deepEqual(runIssues(fresh), [14]);
		assert.deepEqual(fresh.queued, [15]);
		assert.equal(fresh.maxConcurrent, 1);

		const workflow = github.workflow;

		github.workflow = null;
		clock.t += 30_000;

		const controller = start();
		const unloaded = await controller.tick();

		assert.deepEqual(unloaded.dispatch.reasons, ["workflow_unavailable"]);
		assert.deepEqual(runIssues(unloaded), []);
		assert.deepEqual(unloaded.queued, [14, 15]);
		assert.equal(unloaded.maxConcurrent, 0);

		github.workflow = workflow;
		clock.t += 60_000;

		const loaded = await controller.tick();

		assert.equal(loaded.dispatch.enabled, true);
		assert.deepEqual(runIssues(loaded), [14]);
		assert.deepEqual(loaded.queued, [15]);
		assert.equal(loaded.maxConcurrent, 1);
		assert.deepEqual(statuses(github, 15), ["1:claimed", "2:blocked"]);
	});

	it("still releases a closed claim before the first workflow load", async () => {
		const { github, clock, start } = world();
		const issue = github.add(labeled(14));

		await start().tick();
		issue.state = "closed";
		issue.updatedAt = "2026-10-29T02:00:20Z";
		github.workflow = null;
		clock.t += 30_000;

		const report = await start().tick();

		assert.deepEqual(report.dispatch.reasons, ["workflow_unavailable"]);
		assert.deepEqual(report.runs, []);
		assert.deepEqual(statuses(github, 14), [
			"1:claimed",
			"2:blocked",
			"3:released",
		]);
	});

	it("cannot launch an attempt past max_attempts: 1 after a restart whose first workflow read failed", async () => {
		const { github, clock, executor, start } = world();

		setWorkflow(github, "max_attempts: 3", "max_attempts: 1");
		github.add(labeled(14));
		executor.fallback = { kind: "hang" };
		await start().tick();

		const workflow = github.workflow;

		github.workflow = null;
		clock.t += 30_000;

		const controller = start();
		const unloaded = await controller.tick();

		assert.deepEqual(unloaded.runs, []);
		assert.deepEqual(unloaded.queued, [14]);
		assert.deepEqual(statuses(github, 14), ["1:claimed", "2:running"]);

		github.workflow = workflow;
		clock.t += 30_000;

		const loaded = await controller.tick();

		assert.equal(executor.launches.length, 1);
		assert.deepEqual(loaded.runs, []);
		assert.deepEqual(statuses(github, 14), [
			"1:claimed",
			"2:running",
			"3:failed",
		]);
	});

	it("does not fail an interrupted attempt under max_attempts: 5 before the first workflow load", async () => {
		const { github, clock, executor, start } = world();

		setWorkflow(github, "max_attempts: 3", "max_attempts: 5");
		github.add(labeled(14));
		executor.behaviors = [
			{ kind: "fail", usage: 0 },
			{ kind: "fail", usage: 0 },
			{ kind: "hang" },
		];

		const first = start();

		for (const offset of [0, 1, 10_001, 10_002, 30_002]) {
			clock.t = START + offset;
			await first.tick();
		}

		assert.equal(statuses(github, 14).at(-1), "6:running");

		const workflow = github.workflow;

		github.workflow = null;
		clock.t = START + 30_003;

		const controller = start();
		const unloaded = await controller.tick();

		assert.deepEqual(unloaded.runs, []);
		assert.deepEqual(unloaded.queued, [14]);
		assert.equal(statuses(github, 14).length, 6);

		github.workflow = workflow;
		clock.t = START + 60_003;

		const loaded = await controller.tick();

		assert.deepEqual(
			loaded.runs.map((run) => [run.issue, run.status, run.attempt]),
			[[14, "retrying", 4]],
		);
		assert.equal(statuses(github, 14).at(-1), "7:retrying");
	});

	it("does not end an interrupted run on the default token budget before the first workflow load", async () => {
		const { github, clock, executor, start } = world();

		setWorkflow(
			github,
			`max_tokens_per_run: ${TRUSTED_RUN_CAP}`,
			"max_tokens_per_run: 2000000",
		);
		github.add(labeled(14));
		executor.behaviors = [{ kind: "fail", usage: 600_000 }, { kind: "hang" }];

		const first = start();

		for (const offset of [0, 1, 10_001]) {
			clock.t = START + offset;
			await first.tick();
		}

		assert.equal(statuses(github, 14).at(-1), "4:running");

		const workflow = github.workflow;

		github.workflow = null;
		clock.t += 1;

		const controller = start();

		await controller.tick();

		assert.equal(statuses(github, 14).length, 4);

		github.workflow = workflow;
		clock.t += 30_000;

		const loaded = await controller.tick();

		assert.deepEqual(
			loaded.runs.map((run) => [run.status, run.attempt, run.usage]),
			[["retrying", 3, 600_000]],
		);
		assert.equal(statuses(github, 14).at(-1), "5:retrying");
	});

	it("computes an adopted retry's due time from the loaded max_backoff_ms, not the default", async () => {
		const { github, clock, executor, start } = world();

		setWorkflow(github, "max_backoff_ms: 300000", "max_backoff_ms: 1000");
		github.add(labeled(14));
		executor.behaviors = [{ kind: "fail", usage: 0 }];

		const first = start();

		await first.tick();
		clock.t += 1;
		await first.tick();

		assert.equal(statuses(github, 14).at(-1), "3:retrying");

		const workflow = github.workflow;

		github.workflow = null;
		clock.t = START + 2_000;

		const controller = start();
		const unloaded = await controller.tick();

		assert.deepEqual(unloaded.runs, []);
		assert.deepEqual(unloaded.queued, [14]);

		github.workflow = workflow;
		clock.t = START + 3_001;

		const loaded = await controller.tick();

		assert.equal(executor.launches.length, 2);
		assert.deepEqual(
			loaded.runs.map((run) => [run.status, run.attempt]),
			[["blocked", 2]],
		);
	});

	it("releases a closed issue's running marker without deciding the interruption before the first workflow load", async () => {
		const { github, clock, executor, start } = world();
		const issue = github.add(labeled(14));

		executor.fallback = { kind: "hang" };
		await start().tick();
		issue.state = "closed";
		issue.updatedAt = "2026-10-29T02:00:20Z";
		github.workflow = null;
		clock.t += 30_000;

		const report = await start().tick();

		assert.deepEqual(report.runs, []);
		assert.deepEqual(statuses(github, 14), [
			"1:claimed",
			"2:running",
			"3:released",
		]);
	});

	it("lists a claim recorded before its first marker in queued while the workflow is unavailable", async () => {
		const { github, clock, files, start } = world();

		github.add(labeled(14));
		github.posts = ["lost"];
		await start().tick();

		assert.equal(files.claims.get(runOf(14))?.seq, null);

		const workflow = github.workflow;

		github.workflow = null;
		clock.t += 30_000;

		const controller = start();
		const unloaded = await controller.tick();

		assert.deepEqual(unloaded.runs, []);
		assert.deepEqual(unloaded.queued, [14]);
		assert.deepEqual(statuses(github, 14), []);

		github.workflow = workflow;
		clock.t += 30_000;

		const loaded = await controller.tick();

		assert.deepEqual(runIssues(loaded), [14]);
		assert.deepEqual(statuses(github, 14), ["1:claimed", "2:blocked"]);
	});

	it("adopts running and retrying markers while the loaded cap is full, because neither holds a slot once adopted", async () => {
		const { github, clock, executor, start } = world();

		for (const number of [14, 15, 16]) github.add(labeled(number));

		executor.behaviors = [{ kind: "unavailable" }, { kind: "fail", usage: 0 }];
		executor.fallback = { kind: "hang" };

		const first = start();

		await first.tick();
		clock.t += 1;
		executor.ready = false;
		await first.tick();
		executor.ready = null;

		assert.equal(statuses(github, 15).at(-1), "3:retrying");
		assert.equal(statuses(github, 16).at(-1), "2:running");

		executor.fallback = { kind: "unavailable" };
		capAt(github, 1);
		clock.t += 1;

		const report = await start().tick();

		assert.deepEqual(
			report.runs.map((run) => [run.issue, run.status]),
			[
				[14, "blocked"],
				[15, "retrying"],
				[16, "retrying"],
			],
		);
		assert.deepEqual(report.queued, []);
		assert.equal(statuses(github, 16).at(-1), "3:retrying");
	});
});

describe("Orchestrator retry workspace preparation", () => {
	it("does not spend the free slot on a due retry whose workspace is unavailable", async () => {
		const { github, clock, files, executor, start } = world();

		capAt(github, 1);
		github.add(labeled(14));
		executor.behaviors = [{ kind: "fail", usage: 0 }];

		const controller = start();

		await controller.tick();
		clock.t += 1;
		await controller.tick();

		const ensure = files.ensureWorkspace;
		let failing = true;

		files.ensureWorkspace = async (runId) =>
			failing && runId === runOf(14) ? "unavailable" : ensure(runId);
		github.add(labeled(15));
		clock.t += 30_000;

		const report = await controller.tick();

		assert.deepEqual(
			report.runs.map((run) => [run.issue, run.status]),
			[
				[14, "retrying"],
				[15, "blocked"],
			],
		);
		assert.deepEqual(report.queued, []);
		assert.equal(executor.launches.length, 2);

		failing = false;
		clock.t += 30_000;
		await controller.tick();

		assert.equal(executor.launches.length, 2);
	});

	it("does not spend the free slot when a real workspace path is obstructed", async () => {
		const { github, clock, store, executor, logs } = world();
		const state = stateDir();
		const files = fileRunFiles(state);

		const controller = new Orchestrator({
			platform: EXE_DEV_PLATFORM,
			exec: github.exec,
			env: () => "/home/exedev",
			repo,
			store,
			files,
			executor,
			clock,
			scope: null,
			log: (event, fields) => logs.push({ event, fields }),
		});

		capAt(github, 1);
		github.add(labeled(14));
		executor.behaviors = [{ kind: "fail", usage: 0 }];
		await controller.tick();
		clock.t += 1;
		await controller.tick();

		const workspace = files.workspacePath(runOf(14));

		rmSync(workspace, { recursive: true });
		writeFileSync(workspace, "");
		github.add(labeled(15));
		clock.t += 30_000;

		const report = await controller.tick();

		assert.deepEqual(
			report.runs.map((run) => [run.issue, run.status]),
			[
				[14, "retrying"],
				[15, "blocked"],
			],
		);
		assert.equal(executor.launches.length, 2);
		assert.ok(events(logs).includes("workspace_unavailable"));
	});
});

describe("Orchestrator claims before their first marker whose event was replaced", () => {
	it("releases the old claim at seq 1 before claiming the new event", async () => {
		const { github, clock, files, logs, start } = world();
		const issue = github.add(labeled(14));

		github.posts = ["lost"];
		await start().tick();

		const next = relabel(github, issue);

		clock.t += 40 * 60_000;

		const report = await start().tick();

		assert.equal(report.runs[0]?.runId, next);
		assert.equal(files.claims.get(runOf(14))?.status, "released");
		assert.deepEqual(statuses(github, 14), [
			"1:released",
			"2:claimed",
			"3:blocked",
		]);
		assert.deepEqual(
			logs
				.filter((entry) => entry.event === "claim_released")
				.map((entry) => [entry.fields.runId, entry.fields.why]),
			[[runOf(14), "new_event"]],
		);
	});

	it("gives the replaced claim no slot, so the healthy candidates fill the cap", async () => {
		const { github, clock, files, start } = world();
		const issue = github.add(labeled(15));

		github.posts = ["lost"];
		await start().tick();
		relabel(github, issue);
		github.issues.delete(15);
		github.add(labeled(13));
		github.add(labeled(14));
		github.add(issue);
		clock.t += 40 * 60_000;

		const report = await start().tick();

		assert.deepEqual(runIssues(report), [13, 14]);
		assert.deepEqual(report.queued, [15]);
		assert.deepEqual(statuses(github, 15), ["1:released"]);
		assert.equal(files.claims.get(runOf(15))?.status, "released");
	});
});

describe("Orchestrator cap reduction in a running process", () => {
	it("keeps the runs that hold slots, and launches or adopts nothing while they are at or above the new cap", async () => {
		const { github, clock, files, executor, wire, start } = world();

		github.add(labeled(16));
		await start().tick();
		files.claims.delete(runOf(16));

		github.add(labeled(14));
		github.add(labeled(15));
		wire.intercept = omitFromList(github, 16);
		clock.t += 30_000;

		const controller = start();
		const before = await controller.tick();

		assert.deepEqual(runIssues(before), [14, 15]);
		assert.equal(executor.launches.length, 3);

		wire.intercept = null;
		capAt(github, 1);
		github.add(labeled(17));

		for (let n = 0; n < 2; n++) {
			clock.t += 30_000;

			const report = await controller.tick();

			assert.equal(report.maxConcurrent, 1);
			assert.equal(report.active, 2);
			assert.deepEqual(runIssues(report), [14, 15]);
			assert.deepEqual(report.queued, [16, 17]);
		}

		assert.equal(executor.launches.length, 3);
		assert.deepEqual(statuses(github, 16), ["1:claimed", "2:blocked"]);
		assert.deepEqual(statuses(github, 17), []);
	});
});

describe("Orchestrator workspace replay", () => {
	it("keeps the replay of an adopted run whose workspace preparation failed, and replays it once preparation works", async () => {
		const { github, clock, files, executor, start } = world();

		github.add(labeled(14));
		await start().tick();
		files.workspaces.delete(runOf(14));

		const ensure = files.ensureWorkspace;
		let failing = true;

		files.ensureWorkspace = async (runId) =>
			failing ? "unavailable" : ensure(runId);
		clock.t += 30_000;

		const controller = start();

		await controller.tick();

		assert.equal(executor.launches.length, 1);

		failing = false;
		clock.t += 30_000;

		const replayed = await controller.tick();

		assert.equal(executor.launches.length, 2);
		assert.ok(files.workspaces.has(runOf(14)));
		assert.equal(replayed.runs[0]?.workspace, "missing_replayed");

		clock.t += 30_000;
		await controller.tick();

		assert.equal(executor.launches.length, 2);
		assert.deepEqual(statuses(github, 14), ["1:claimed", "2:blocked"]);
	});
});

describe("Orchestrator loaded terminal records", () => {
	it("does not count a loaded terminal record as a reservation when its issue cannot be read", async () => {
		const { github, clock, files, start } = world();
		const issue = github.add(labeled(14));
		const controller = start();

		await controller.tick();
		issue.state = "closed";
		issue.updatedAt = "2026-10-29T02:00:20Z";
		clock.t += 30_000;
		await controller.tick();

		assert.equal(files.claims.get(runOf(14))?.status, "released");

		github.failures.set(`repos/${FAKE_REPO}/issues/14`, networkError());
		github.add(labeled(15));
		github.add(labeled(16));
		clock.t += 30_000;

		const report = await start().tick();

		assert.deepEqual(runIssues(report), [15, 16]);
		assert.deepEqual(report.queued, []);
	});
});

describe("Orchestrator claim record usage", () => {
	it("keeps the recorded usage when the ledger is behind, so the run budget still ends the run", async () => {
		const ctx = world();
		const { github, clock, files, start } = ctx;
		const issue = github.add(labeled(14));
		const attemptUsage = TRUSTED_RUN_CAP * 0.6;

		ctx.executor.fallback = { kind: "fail", usage: attemptUsage };

		const controller = start();

		await controller.tick();
		clock.t += 30_000;
		github.now = "2026-10-29T02:00:30Z";

		const failed = await controller.tick();

		assert.equal(failed.runs[0]?.usage, attemptUsage);
		assert.deepEqual(
			files.claims.get(runOf(14)),
			endedClaim(14, 3, {
				status: "retrying",
				attempt: 2,
				usage: attemptUsage,
			}),
		);

		const hidden = hideMarker(ctx, issue, 3);

		clock.t += 30_000;

		const restarted = start();
		const adopted = await restarted.tick();

		assert.deepEqual(
			adopted.runs.map((run) => [run.status, run.attempt, run.usage]),
			[["retrying", 2, attemptUsage]],
		);

		hidden.hidden = false;
		clock.t += 30_000;
		github.now = "2026-10-29T02:01:30Z";
		await restarted.tick();
		clock.t += 30_000;
		github.now = "2026-10-29T02:02:00Z";

		const ended = await restarted.tick();

		assert.deepEqual(ended.runs, []);
		assert.equal(statuses(github, 14).at(-1), "5:budget_exhausted");
	});
});

describe("Orchestrator release reasons", () => {
	it("names an unlabel seen only through the timeline as unlabeled", async () => {
		const { github, clock, logs, start } = world();
		const issue = github.add(labeled(14));
		const controller = start();

		await controller.tick();
		issue.timeline.push(
			labelEvent({
				id: 1,
				at: "2026-10-29T02:00:30Z",
				actor: "giuseppecrj",
				event: "unlabeled",
			}),
		);
		issue.updatedAt = "2026-10-29T02:00:30Z";
		clock.t += 60_000;
		await controller.tick();

		assert.deepEqual(
			logs.flatMap((entry) =>
				entry.event === "claim_released" ? [entry.fields.why] : [],
			),
			["unlabeled"],
		);
		assert.equal(statuses(github, 14).at(-1), "3:released");
	});
});

describe("Orchestrator retry marker confirmation", () => {
	async function lostRetryMarker() {
		const ctx = world();

		ctx.github.add(labeled(14));
		ctx.executor.behaviors = [{ kind: "fail", usage: 0 }];

		const controller = ctx.start();

		await controller.tick();
		ctx.clock.t += 30_000;
		ctx.github.posts = ["lost"];

		const queued = await controller.tick();

		assert.equal(queued.runs[0]?.status, "retrying");
		assert.equal(queued.runs[0]?.markerPending, true);
		ctx.clock.t += 30_000;

		return { ...ctx, controller };
	}

	it("keeps a due retry queued while the read-back of its marker fails", async () => {
		const { github, executor, controller } = await lostRetryMarker();

		github.failures.set(
			`repos/${FAKE_REPO}/issues/14/comments`,
			networkError(),
		);

		const deferred = await controller.tick();

		assert.equal(executor.launches.length, 1);
		assert.equal(deferred.runs[0]?.status, "retrying");
		assert.equal(deferred.runs[0]?.markerPending, true);

		github.failures.clear();
		await controller.tick();

		assert.equal(executor.launches.length, 2);
		assert.deepEqual(statuses(github, 14), [
			"1:claimed",
			"2:running",
			"3:retrying",
			"4:blocked",
		]);
	});

	it("keeps a due retry queued while the replacement for a lost marker is unconfirmed too", async () => {
		const { github, executor, controller } = await lostRetryMarker();

		github.posts = ["lost"];

		const deferred = await controller.tick();

		assert.equal(executor.launches.length, 1);
		assert.equal(deferred.runs[0]?.status, "retrying");
		assert.equal(deferred.runs[0]?.markerPending, true);
		assert.deepEqual(statuses(github, 14), ["1:claimed", "2:running"]);

		await controller.tick();

		assert.equal(executor.launches.length, 2);
		assert.deepEqual(statuses(github, 14), [
			"1:claimed",
			"2:running",
			"3:retrying",
			"4:blocked",
		]);
	});
});

describe("Orchestrator same-second cache", () => {
	it("reads the timeline before a due retry when the label was replaced in the cached second", async () => {
		const { github, clock, executor, start } = world();
		const issue = github.add(labeled(14));

		executor.behaviors = [{ kind: "fail", usage: 0 }];

		const controller = start();

		await controller.tick();
		clock.t += 30_000;
		github.now = "2026-10-29T02:00:30Z";
		await controller.tick();
		issue.timeline.push(
			labelEvent({
				id: 98,
				at: github.now,
				actor: "giuseppecrj",
				event: "unlabeled",
			}),
			labelEvent({ id: 99, at: github.now, actor: "giuseppecrj" }),
		);
		issue.updatedAt = github.now;
		clock.t += 30_000;
		github.now = "2026-10-29T02:01:00Z";

		const report = await controller.tick();

		assert.equal(executor.launches.length, 1);
		assert.equal(statuses(github, 14).at(-1), "4:released");
		assert.ok(report.runs.every((run) => run.runId !== runOf(14)));
	});

	it("drops a held issue whose bot comments were stripped in the cached second", async () => {
		const { github, clock, executor, start } = world();
		const issue = github.add(labeled(14));

		executor.behaviors = [{ kind: "fail", usage: 0 }];

		const controller = start();

		await controller.tick();
		clock.t += 1;

		const queued = await controller.tick();

		assert.equal(queued.runs[0]?.status, "retrying");

		const frozen = issue.updatedAt;

		for (const comment of issue.comments) {
			comment.body = "edited away by owner";
			comment.lastEditedAt = "2026-10-29T03:00:00Z";
		}

		clock.t += 10_000;

		const report = await controller.tick();

		assert.equal(issue.updatedAt, frozen);
		assert.equal(executor.launches.length, 1);
		assert.deepEqual(report.corrupt, [{ issue: 14, defect: "edited" }]);
		assert.deepEqual(report.runs, []);
	});
});

describe("Orchestrator stall aborts", () => {
	it("aborts every stalled stage before it posts any marker", async () => {
		const { github, clock, executor, wire, start } = world();

		github.add(labeled(14));
		github.add(labeled(15));
		executor.fallback = { kind: "hang" };

		const controller = start();

		await controller.tick();
		assert.equal(executor.launches.length, 2);
		clock.t += 300_001;

		let unhold: () => void = () => undefined;

		const held = new Promise<void>((done) => {
			unhold = () => done();
		});

		let posted: (aborted: boolean[]) => void = () => undefined;

		const posting = new Promise<boolean[]>((done) => {
			posted = (aborted) => done(aborted);
		});

		wire.intercept = async (command, args) => {
			if (args.includes("POST")) {
				posted(executor.launches.map((launch) => launch.signal.aborted));
				await held;
			}

			return github.exec(command, args);
		};

		const ticking = controller.tick();

		assert.deepEqual(await posting, [true, true]);
		unhold();

		const report = await ticking;

		assert.deepEqual(
			report.runs.map((run) => run.status),
			["retrying", "retrying"],
		);
		assert.equal(report.totals.stalls, 2);
	});
});

describe("Orchestrator admissions recorded for a bot-applied ready event", () => {
	for (const actor of [null, { login: "ghost", type: "User" }]) {
		const shown = actor === null ? "withheld" : "ghost";

		for (const actorType of ["Bot", "User", undefined]) {
			for (const recovery of [
				"admission",
				"unmarked claim",
				"blocked claim",
				"running claim",
				"marker only",
			]) {
				it(`recovers ${recovery} with stored actor type ${actorType ?? "unknown"} and ${shown} timeline actor only when not Bot`, async () => {
					const ctx = world();
					const issue = ctx.github.add(labeled(14));

					if (recovery === "admission") {
						const receipt = await admitTicket({
							platform: EXE_DEV_PLATFORM,
							exec: ctx.github.exec,
							env: () => "/home/exedev",
							repo,
							issue: 14,
							allowlist: [repo],
							store: ctx.store,
						});

						assert.equal(receipt.decision, "admitted");
					} else {
						if (recovery === "unmarked claim") ctx.github.posts = ["lost"];

						if (recovery === "running claim")
							ctx.executor.fallback = { kind: "hang" };
						await ctx.start().tick();

						if (recovery === "marker only") ctx.files.claims.clear();
					}

					const key = `14/${EVENT_ID + 14}`;
					const receipt = ctx.store.records.get(key);

					assert.ok(receipt);
					const stored = { ...receipt, actor: "automation", actorType };

					if (actorType === undefined) delete stored.actorType;
					ctx.store.records.set(key, stored);
					issue.timeline = [readyEventBy(actor)];
					const launched = ctx.executor.launches.length;

					ctx.executor.fallback = { kind: "hang" };
					ctx.clock.t += 30_000;
					ctx.github.calls.length = 0;
					const report = await ctx.start().tick();

					if (actorType === "Bot") {
						assert.deepEqual(report.runs, []);
						assert.equal(ctx.executor.launches.length, launched);

						if (recovery === "admission") {
							assert.deepEqual(report.refused, [
								{ issue: 14, reasons: ["bot_actor"] },
							]);
							assert.deepEqual(statuses(ctx.github, 14), []);
						} else {
							assert.ok(statuses(ctx.github, 14).at(-1)?.endsWith(":released"));
							assert.ok(
								ctx.logs.some(
									(entry) =>
										entry.event === "claim_released" &&
										entry.fields.why === "bot_actor",
								),
							);
						}

						ctx.clock.t += 30_000;
						await ctx.start().tick();
						assert.equal(ctx.executor.launches.length, launched);
					} else {
						assert.deepEqual(runIssues(report), [14]);

						if (recovery !== "running claim")
							assert.equal(ctx.executor.launches.length, launched + 1);
						assert.ok(
							!statuses(ctx.github, 14).some((s) => s.endsWith(":released")),
						);
					}

					assert.ok(
						!ctx.github.calls.some((call) =>
							call.join(" ").includes("collaborators/automation/permission"),
						),
					);
				});
			}
		}
	}

	for (const login of [BOT_LOGIN, "renovate"]) {
		it(`refuses a recorded, unmarked admission of ${login} as bot_actor and launches nothing`, async () => {
			const ctx = world();
			const issue = ctx.github.add(labeled(14));

			const admitted = await admitTicket({
				platform: EXE_DEV_PLATFORM,
				exec: ctx.github.exec,
				env: () => "/home/exedev",
				repo,
				issue: 14,
				allowlist: [repo],
				store: ctx.store,
			});

			assert.equal(admitted.decision, "admitted");
			botApplied(ctx, issue, login);
			ctx.executor.fallback = { kind: "hang" };

			const report = await ctx.start().tick();

			assert.deepEqual(report.refused, [{ issue: 14, reasons: ["bot_actor"] }]);
			assert.deepEqual(report.runs, []);
			assert.equal(ctx.executor.launches.length, 0);
			assert.deepEqual(statuses(ctx.github, 14), []);
			assert.ok(!events(ctx.logs).includes("admission_recovered"));

			ctx.clock.t += 30_000;
			ctx.github.calls.length = 0;

			const again = await ctx.start().tick();

			assert.deepEqual(again.runs, []);
			assert.equal(ctx.executor.launches.length, 0);
			assert.equal(
				ctx.github.calls.filter((call) =>
					call.join(" ").includes("collaborators"),
				).length,
				0,
			);
		});
	}

	it("still recovers a recorded, unmarked admission a human applied", async () => {
		const ctx = world();

		ctx.github.add(labeled(14));
		await admitTicket({
			platform: EXE_DEV_PLATFORM,
			exec: ctx.github.exec,
			env: () => "/home/exedev",
			repo,
			issue: 14,
			allowlist: [repo],
			store: ctx.store,
		});
		ctx.executor.fallback = { kind: "hang" };

		const report = await ctx.start().tick();

		assert.deepEqual(runIssues(report), [14]);
		assert.ok(events(ctx.logs).includes("admission_recovered"));
		assert.equal(ctx.executor.launches.length, 1);
	});

	for (const login of [BOT_LOGIN, "renovate"]) {
		it(`releases an adopted running run of ${login} as bot_actor and relaunches nothing`, async () => {
			const ctx = world();
			const issue = ctx.github.add(labeled(14));

			ctx.executor.fallback = { kind: "hang" };
			await ctx.start().tick();
			assert.deepEqual(statuses(ctx.github, 14), ["1:claimed", "2:running"]);
			assert.equal(ctx.executor.launches.length, 1);

			botApplied(ctx, issue, login);
			ctx.clock.t += 30_000;

			const report = await ctx.start().tick();

			assert.deepEqual(report.runs, []);
			assert.equal(statuses(ctx.github, 14).at(-1), "3:released");
			assert.equal(ctx.executor.launches.length, 1);
			assert.deepEqual(
				ctx.logs.flatMap((entry) =>
					entry.event === "claim_released" ? [entry.fields.why] : [],
				),
				["bot_actor"],
			);
		});

		it(`releases an unmarked claim of ${login} as bot_actor and launches nothing`, async () => {
			const ctx = world();
			const issue = ctx.github.add(labeled(14));

			ctx.github.posts = ["lost"];
			await ctx.start().tick();
			assert.deepEqual(statuses(ctx.github, 14), []);

			botApplied(ctx, issue, login);
			ctx.executor.fallback = { kind: "hang" };
			ctx.clock.t += 30_000;

			const report = await ctx.start().tick();

			assert.deepEqual(report.runs, []);
			assert.deepEqual(statuses(ctx.github, 14), ["1:released"]);
			assert.equal(ctx.executor.launches.length, 0);
			assert.equal(ctx.files.claims.get(runOf(14))?.status, "released");
		});
	}

	for (const actor of [null, { login: "ghost", type: "User" }]) {
		const shown = actor === null ? "withheld" : "ghost";

		it(`releases a marked blocked claim recorded for ${BOT_LOGIN} when the timeline actor reads ${shown}`, async () => {
			const ctx = world();
			const issue = ctx.github.add(labeled(14));

			await ctx.start().tick();
			assert.deepEqual(statuses(ctx.github, 14), ["1:claimed", "2:blocked"]);
			const launched = ctx.executor.launches.length;

			botApplied(ctx, issue, BOT_LOGIN);
			issue.timeline = [readyEventBy(actor)];
			ctx.executor.fallback = { kind: "hang" };
			ctx.clock.t += 30_000;

			const report = await ctx.start().tick();

			assert.deepEqual(report.runs, []);
			assert.equal(ctx.executor.launches.length, launched);
			assert.deepEqual(statuses(ctx.github, 14), [
				"1:claimed",
				"2:blocked",
				"3:released",
			]);
			assert.deepEqual(
				ctx.logs.flatMap((entry) =>
					entry.event === "claim_released" ? [entry.fields.why] : [],
				),
				["bot_actor"],
			);

			ctx.clock.t += 30_000;
			await ctx.start().tick();
			assert.equal(ctx.executor.launches.length, launched);
			assert.equal(statuses(ctx.github, 14).length, 3);
		});

		it(`still resumes a marked blocked claim a human applied when the timeline actor reads ${shown}`, async () => {
			const ctx = world();
			const issue = ctx.github.add(labeled(14));

			await ctx.start().tick();
			assert.deepEqual(statuses(ctx.github, 14), ["1:claimed", "2:blocked"]);
			const launched = ctx.executor.launches.length;

			issue.timeline = [readyEventBy(actor)];
			ctx.executor.fallback = { kind: "hang" };
			ctx.clock.t += 30_000;

			const report = await ctx.start().tick();

			assert.deepEqual(runIssues(report), [14]);
			assert.equal(ctx.executor.launches.length, launched + 1);
			assert.ok(
				!statuses(ctx.github, 14).some((status) =>
					status.endsWith(":released"),
				),
			);
		});
	}
});

/** Issue 14's ready event as GitHub returns it with a withheld (`null`) or deleted actor. */
function readyEventBy(actor: JsonValue): JsonValue {
	return {
		id: EVENT_ID + 14,
		event: "labeled",
		actor,
		created_at: LABEL_AT,
		label: { name: "factory:ready", color: "ededed" },
	};
}
