import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
	FAKE_REPO,
	networkError,
	renamedEvent,
} from "../../fake-ticket-adapter.ts";
import {
	EVENT_ID,
	labeled,
	runOf,
	world,
	statuses,
	runIssues,
	events,
	relabel,
	lagComments,
	hideMarker,
	failClaimWrite,
	bySeq,
	behindLogs,
	blockedClaim,
	endedClaim,
} from "./orchestrator-fixtures.ts";

describe("Orchestrator restart reads", () => {
	it("retries a recorded claim whose issue read failed on the first tick", async () => {
		const { github, start } = world();
		const issue = github.add(labeled(14));

		await start().tick();
		issue.state = "closed";
		github.failures.set(`repos/${FAKE_REPO}/issues/14`, networkError());

		const controller = start();
		const first = await controller.tick();

		assert.deepEqual(first.runs, []);
		assert.deepEqual(statuses(github, 14), ["1:claimed", "2:blocked"]);

		github.failures.clear();
		await controller.tick();

		assert.equal(statuses(github, 14).at(-1), "3:released");
	});
});

describe("Orchestrator new ready events", () => {
	it("claims the new event in the restart tick that releases the old run", async () => {
		const { github, start } = world();
		const issue = github.add(labeled(14));

		await start().tick();

		const next = relabel(github, issue);
		const report = await start().tick();

		assert.deepEqual(statuses(github, 14), [
			"1:claimed",
			"2:blocked",
			"3:released",
			"4:claimed",
			"5:blocked",
		]);
		assert.deepEqual(
			report.runs.map((run) => [run.runId, run.status, run.seq]),
			[[next, "blocked", 5]],
		);
	});

	it("claims the new event on the next tick when the release marker is unconfirmed", async () => {
		const { github, start } = world();
		const issue = github.add(labeled(14));

		await start().tick();

		const next = relabel(github, issue);

		github.posts = ["landed_unanswered"];

		const controller = start();
		const first = await controller.tick();

		assert.equal(first.runs[0]?.markerPending, true);

		const second = await controller.tick();

		assert.deepEqual(statuses(github, 14), [
			"1:claimed",
			"2:blocked",
			"3:released",
			"4:claimed",
			"5:blocked",
		]);
		assert.equal(second.runs[0]?.runId, next);
	});
});

describe("Orchestrator slot accounting", () => {
	for (const behavior of ["landed_unanswered", "rejected", "lost"] as const) {
		it(`counts a claim whose first marker POST is ${behavior} against the limit`, async () => {
			const { github, start } = world();

			for (const number of [14, 15, 16]) github.add(labeled(number));

			github.posts = [behavior];

			const controller = start();
			const first = await controller.tick();

			assert.deepEqual(runIssues(first), [14, 15]);
			assert.deepEqual(first.queued, [16]);

			const second = await controller.tick();

			assert.deepEqual(runIssues(second), [14, 15]);
			assert.deepEqual(second.queued, [16]);
			assert.deepEqual(statuses(github, 16), []);
		});
	}
});

describe("Orchestrator eligibility before launch", () => {
	async function queuedRetry() {
		const ctx = world();
		const issue = ctx.github.add(labeled(14));

		ctx.executor.behaviors = [{ kind: "fail", usage: 0 }];

		const controller = ctx.start();

		await controller.tick();

		const queued = await controller.tick();

		assert.equal(queued.runs[0]?.status, "retrying");

		return { ...ctx, issue, controller };
	}

	it("defers a due retry whose issue read failed and releases it once the read works", async () => {
		const { github, clock, executor, issue, controller } = await queuedRetry();

		issue.state = "closed";
		github.failures.set(`repos/${FAKE_REPO}/issues/14`, networkError());
		clock.t += 10_000;

		const deferred = await controller.tick();

		assert.equal(executor.launches.length, 1);
		assert.equal(deferred.runs[0]?.status, "retrying");

		github.failures.clear();

		const released = await controller.tick();

		assert.deepEqual(released.runs, []);
		assert.equal(executor.launches.length, 1);
		assert.equal(statuses(github, 14).at(-1)?.endsWith(":released"), true);
	});

	it("defers a due retry whose changed issue has an unreadable timeline", async () => {
		const { github, clock, executor, issue, controller } = await queuedRetry();

		issue.updatedAt = "2026-10-29T03:00:00Z";
		github.failures.set(
			`repos/${FAKE_REPO}/issues/14/timeline`,
			networkError(),
		);
		clock.t += 10_000;

		const deferred = await controller.tick();

		assert.equal(executor.launches.length, 1);
		assert.equal(deferred.runs[0]?.status, "retrying");

		github.failures.clear();
		await controller.tick();

		assert.equal(executor.launches.length, 2);
	});

	it("does not replay an adopted run until its eligibility is read", async () => {
		const { github, executor, start } = world();

		github.add(labeled(14));
		await start().tick();
		github.failures.set(
			`repos/${FAKE_REPO}/issues/14/timeline`,
			networkError(),
		);

		const controller = start();
		const deferred = await controller.tick();

		assert.equal(executor.launches.length, 1);
		assert.equal(deferred.runs[0]?.status, "blocked");

		github.failures.clear();
		await controller.tick();

		assert.equal(executor.launches.length, 2);
		assert.deepEqual(statuses(github, 14), ["1:claimed", "2:blocked"]);
	});
});

describe("Orchestrator bot comment edits", () => {
	it("fails closed after a restart when an owner strips the marker prefix from bot comments", async () => {
		const { github, start } = world();
		const issue = github.add(labeled(14));

		await start().tick();

		for (const comment of issue.comments) {
			comment.body = comment.body.replace("<!-- factory:", "<!-- note:");
			comment.lastEditedAt = "2026-10-29T03:00:00Z";
		}

		const report = await start().tick();

		assert.deepEqual(report.runs, []);
		assert.deepEqual(report.corrupt, [{ issue: 14, defect: "edited" }]);
		assert.equal(issue.comments.length, 2);
	});
});

describe("Orchestrator live marker validation", () => {
	it("drops a held issue from dispatch when a live controller sees its marker edited", async () => {
		const { github, clock, executor, start } = world();
		const issue = github.add(labeled(14));

		executor.behaviors = [{ kind: "fail", usage: 0 }];

		const controller = start();

		await controller.tick();
		await controller.tick();

		const first = issue.comments[0];

		assert.ok(first);
		first.lastEditedAt = "2026-10-29T03:00:00Z";
		issue.updatedAt = "2026-10-29T03:00:00Z";
		clock.t += 10_000;

		const report = await controller.tick();

		assert.equal(executor.launches.length, 1);
		assert.deepEqual(report.runs, []);
		assert.deepEqual(report.corrupt, [{ issue: 14, defect: "edited" }]);
		assert.equal(github.markers(14).length, 3);

		const again = await controller.tick();

		assert.deepEqual(again.runs, []);
		assert.equal(github.markers(14).length, 3);
	});
});

describe("Orchestrator local admission recovery", () => {
	for (const lost of ["the first marker", "the marker and the claim record"]) {
		it(`adopts the recorded admission after losing ${lost} and a later rename`, async () => {
			const { github, files, store, start } = world();
			const issue = github.add(labeled(14));

			github.posts = ["lost"];
			await start().tick();

			assert.equal(store.records.size, 1);

			if (lost.includes("claim")) files.claims.clear();

			issue.title = "A new title";
			issue.timeline.push(renamedEvent("2026-10-29T01:30:00Z"));
			issue.updatedAt = "2026-10-29T01:30:00Z";

			const report = await start().tick();

			assert.deepEqual(report.refused, []);
			assert.equal(report.runs[0]?.runId, runOf(14));
			assert.deepEqual(statuses(github, 14), ["1:claimed", "2:blocked"]);
		});
	}
});

describe("Orchestrator reconcile order", () => {
	it("terminates a stall and releases a closed claim before the per-tick reads", async () => {
		const { github, clock, executor, start } = world();

		github.add(labeled(14));

		const closing = github.add(labeled(15));

		executor.behaviors = [{ kind: "hang" }];

		const controller = start();

		await controller.tick();

		const launch = executor.launches[0];

		assert.ok(launch);
		closing.state = "closed";
		clock.t += 300_001;

		const atGate: { aborted: boolean; released: string | undefined }[] = [];

		github.beforeCall = (args) => {
			if (args.some((arg) => arg.includes("labels/factory%3Aenabled"))) {
				atGate.push({
					aborted: launch.signal.aborted,
					released: statuses(github, 15).at(-1),
				});
			}
		};

		await controller.tick();

		assert.deepEqual(atGate, [{ aborted: true, released: "3:released" }]);
	});
});

describe("Orchestrator ledger behind the local claim record", () => {
	it("claims the new event in the tick whose comments read lags its own release", async () => {
		const ctx = world();
		const { github, executor, logs, start } = ctx;
		const issue = github.add(labeled(14));
		const controller = start();

		await controller.tick();

		const next = relabel(github, issue);

		lagComments(ctx, issue, 1);

		const report = await controller.tick();

		assert.deepEqual(statuses(github, 14), [
			"1:claimed",
			"2:blocked",
			"3:released",
			"4:claimed",
			"5:blocked",
		]);
		assert.deepEqual(
			report.runs.map((run) => [run.runId, run.status, run.seq]),
			[[next, "blocked", 5]],
		);
		assert.deepEqual(report.corrupt, []);
		assert.deepEqual(behindLogs(logs), [
			{ issue: 14, ledgerSeq: 2, localSeq: 3 },
		]);
		assert.equal(executor.launches.length, 2);
	});

	it("keeps a fresh process's run and its slot when the first comments read is empty", async () => {
		const { github, clock, files, logs, start } = world();
		const issue = github.add(labeled(14));

		github.add(labeled(15));
		github.add(labeled(16));

		const first = start();

		await first.tick();
		clock.t += 30_000;
		await first.tick();

		const kept = issue.comments.splice(0);
		const controller = start();

		clock.t += 5000;

		const behind = await controller.tick();

		assert.deepEqual(
			behind.runs.map((run) => [run.issue, run.status, run.seq]),
			[
				[14, "blocked", 2],
				[15, "blocked", 2],
			],
		);
		assert.deepEqual(behind.queued, [16]);
		assert.deepEqual(behind.corrupt, []);
		assert.deepEqual(behind.ledgerBehind, [
			{ issue: 14, ledgerSeq: 0, localSeq: 2 },
		]);
		assert.deepEqual(behindLogs(logs), [
			{ issue: 14, ledgerSeq: 0, localSeq: 2 },
		]);
		assert.equal(github.markers(14).length, 0);
		assert.deepEqual(files.claims.get(runOf(14)), blockedClaim(14, 2));

		issue.comments.push(...kept);
		clock.t += 35_000;

		const back = await controller.tick();

		assert.deepEqual(runIssues(back), [14, 15]);
		assert.deepEqual(back.queued, [16]);
		assert.deepEqual(statuses(github, 14), ["1:claimed", "2:blocked"]);
		assert.deepEqual(statuses(github, 16), []);
	});

	it("keeps a live run and its slot when its bot comments are deleted, and polls 4 requests after", async () => {
		const { github, clock, executor, logs, start } = world();
		const issue = github.add(labeled(14));

		github.add(labeled(15));
		github.add(labeled(16));

		const controller = start();

		await controller.tick();
		clock.t += 30_000;
		await controller.tick();

		const kept = issue.comments.splice(0);

		issue.updatedAt = "2026-10-29T02:01:00Z";
		clock.t += 30_000;

		const behind = await controller.tick();

		assert.deepEqual(
			behind.runs.map((run) => [run.issue, run.status, run.seq]),
			[
				[14, "blocked", 2],
				[15, "blocked", 2],
			],
		);
		assert.deepEqual(behind.queued, [16]);
		assert.deepEqual(behind.corrupt, []);
		assert.deepEqual(behind.ledgerBehind, [
			{ issue: 14, ledgerSeq: 0, localSeq: 2 },
		]);
		assert.equal(github.markers(14).length, 0);

		issue.comments.push(...kept);
		clock.t += 30_000;

		const back = await controller.tick();

		assert.deepEqual(runIssues(back), [14, 15]);
		assert.deepEqual(back.queued, [16]);
		assert.deepEqual(back.ledgerBehind, []);
		assert.deepEqual(statuses(github, 16), []);
		assert.equal(behindLogs(logs).length, 1);
		assert.equal(executor.launches.length, 2);

		clock.t += 30_000;
		github.calls.length = 0;
		await controller.tick();

		assert.equal(github.calls.length, 4, JSON.stringify(github.calls));
	});

	it("posts the next marker after the local seq when a stage ends while the bot comments are gone", async () => {
		const { github, clock, executor, start } = world();
		const issue = github.add(labeled(14));

		executor.behaviors = [{ kind: "hang" }];

		const controller = start();

		await controller.tick();
		issue.comments.length = 0;
		issue.updatedAt = "2026-10-29T02:00:01Z";
		clock.t += 30_000;
		await controller.tick();
		clock.t += 300_001;

		const report = await controller.tick();

		assert.equal(executor.launches[0]?.signal.aborted, true);
		assert.deepEqual(
			report.runs.map((run) => [run.status, run.attempt, run.seq]),
			[["retrying", 2, 3]],
		);
		assert.deepEqual(report.corrupt, []);
		assert.deepEqual(statuses(github, 14), ["3:retrying"]);
	});

	it("releases at the next seq and claims the new event when the bot comments are deleted before a relabel", async () => {
		const { github, clock, executor, start } = world();
		const issue = github.add(labeled(14));
		const controller = start();

		await controller.tick();
		clock.t += 30_000;
		await controller.tick();
		issue.comments.length = 0;

		const next = relabel(github, issue);

		clock.t += 32 * 60_000;

		const report = await controller.tick();

		assert.deepEqual(statuses(github, 14), [
			"3:released",
			"4:claimed",
			"5:blocked",
		]);
		assert.deepEqual(
			report.runs.map((run) => [run.runId, run.status, run.seq]),
			[[next, "blocked", 5]],
		);
		assert.deepEqual(report.corrupt, []);
		assert.equal(executor.launches.length, 2);
	});

	it("releases at the next seq when the issue closes in the tick its bot comments are deleted", async () => {
		const { github, clock, files, start } = world();
		const issue = github.add(labeled(14));
		const controller = start();

		await controller.tick();
		clock.t += 30_000;
		await controller.tick();
		issue.comments.length = 0;
		issue.state = "closed";
		issue.updatedAt = "2026-10-29T02:03:00Z";
		github.now = "2026-10-29T02:03:00Z";
		clock.t += 30_000;

		const report = await controller.tick();

		assert.deepEqual(statuses(github, 14), ["3:released"]);
		assert.deepEqual(report.runs, []);
		assert.deepEqual(report.corrupt, []);
		assert.deepEqual(
			[...files.claims.values()],
			[endedClaim(14, 3, { status: "released" })],
		);

		clock.t += 30_000;
		await controller.tick();

		assert.deepEqual(
			[...files.claims.values()],
			[endedClaim(14, 3, { status: "released" })],
		);
	});

	it("handles a close and reopen of an issue whose bot comments were deleted the same as one whose comments stayed", async () => {
		async function closeAndReopen(deleted: boolean) {
			const { github, clock, executor, start } = world();
			const issue = github.add(labeled(14));
			const controller = start();

			await controller.tick();

			const kept = deleted ? issue.comments.splice(0) : [];

			issue.updatedAt = "2026-10-29T02:00:01Z";
			clock.t += 30_000;
			await controller.tick();
			issue.state = "closed";
			issue.updatedAt = "2026-10-29T02:01:00Z";
			clock.t += 30_000;

			const closing = await controller.tick();

			issue.state = "open";
			issue.comments.push(...kept);
			issue.updatedAt = "2026-10-29T02:02:00Z";
			github.now = "2026-10-29T02:02:30Z";
			clock.t += 30_000;

			const reopened = await controller.tick();

			clock.t += 30_000;

			const later = await controller.tick();
			const next = relabel(github, issue);

			clock.t += 32 * 60_000;

			const relabeled = await controller.tick();

			return {
				closing: closing.runs,
				reopened: [reopened.runs, reopened.corrupt],
				later: [later.runs, later.corrupt],
				relabeled: relabeled.runs.map((run) => [run.runId, run.status]),
				next,
				markers: bySeq(github, 14),
				launches: executor.launches.length,
			};
		}

		const deleted = await closeAndReopen(true);

		assert.deepEqual(deleted, await closeAndReopen(false));
		assert.deepEqual(deleted.closing, []);
		assert.deepEqual(deleted.relabeled, [[deleted.next, "blocked"]]);
		assert.deepEqual(deleted.markers, [
			"1:claimed",
			"2:blocked",
			"3:released",
			"4:claimed",
			"5:blocked",
		]);
	});
});

describe("Orchestrator claim record", () => {
	it("mirrors each confirmed marker and upgrades a record without a seq on adoption", async () => {
		const { github, files, start } = world();

		github.add(labeled(14));
		await start().tick();

		assert.deepEqual([...files.claims.values()], [blockedClaim(14, 2)]);

		files.claims.set(runOf(14), {
			runId: runOf(14),
			issue: 14,
			eventId: String(EVENT_ID + 14),
			seq: null,
			status: null,
			stage: null,
			attempt: null,
			usage: null,
		});

		await start().tick();

		assert.deepEqual(statuses(github, 14), ["1:claimed", "2:blocked"]);
		assert.deepEqual(files.claims.get(runOf(14)), blockedClaim(14, 2));
	});

	it("treats a claim record without a seq as unconfirmed, so deleted markers are written again", async () => {
		const { github, files, start } = world();
		const issue = github.add(labeled(14));

		await start().tick();
		files.claims.set(runOf(14), {
			runId: runOf(14),
			issue: 14,
			eventId: String(EVENT_ID + 14),
			seq: null,
			status: null,
			stage: null,
			attempt: null,
			usage: null,
		});
		issue.comments.length = 0;
		issue.updatedAt = "2026-10-29T03:00:00Z";

		const report = await start().tick();

		assert.deepEqual(report.corrupt, []);
		assert.equal(report.runs[0]?.runId, runOf(14));
		assert.deepEqual(statuses(github, 14), ["1:claimed", "2:blocked"]);
	});

	it("adopts the ledger's marker and rewrites the record when the ledger is ahead of it", async () => {
		const { github, files, logs, start } = world();

		github.add(labeled(14));
		await start().tick();
		files.claims.set(runOf(14), {
			...blockedClaim(14, 1),
			status: "claimed",
		});

		const report = await start().tick();

		assert.deepEqual(
			report.runs.map((run) => [run.status, run.seq]),
			[["blocked", 2]],
		);
		assert.deepEqual(report.ledgerBehind, []);
		assert.deepEqual(behindLogs(logs), []);
		assert.deepEqual(statuses(github, 14), ["1:claimed", "2:blocked"]);
		assert.deepEqual(files.claims.get(runOf(14)), blockedClaim(14, 2));
	});

	it("takes the status from the ledger for a record written before it carried one", async () => {
		const { github, files, start } = world();

		github.add(labeled(14));
		await start().tick();
		files.claims.set(runOf(14), {
			...blockedClaim(14, 2),
			status: null,
			stage: null,
			attempt: null,
			usage: null,
		});

		const report = await start().tick();

		assert.deepEqual(
			report.runs.map((run) => [run.status, run.seq]),
			[["blocked", 2]],
		);
		assert.deepEqual(statuses(github, 14), ["1:claimed", "2:blocked"]);
		assert.deepEqual(files.claims.get(runOf(14)), blockedClaim(14, 2));
	});

	it("adopts a record without a status from the newest readable marker when the ledger is behind it too, and posts after its seq", async () => {
		const ctx = world();
		const { github, clock, files, logs, start } = ctx;
		const issue = github.add(labeled(14));

		await start().tick();
		files.claims.set(runOf(14), {
			...blockedClaim(14, 2),
			status: null,
			stage: null,
			attempt: null,
			usage: null,
		});

		const hidden = hideMarker(ctx, issue, 2);
		const controller = start();
		const report = await controller.tick();

		assert.deepEqual(
			report.runs.map((run) => [run.status, run.seq]),
			[["blocked", 3]],
		);
		assert.deepEqual(behindLogs(logs), [
			{ issue: 14, ledgerSeq: 1, localSeq: 2 },
		]);
		assert.deepEqual(report.ledgerBehind, []);
		assert.deepEqual(statuses(github, 14), [
			"1:claimed",
			"2:blocked",
			"3:blocked",
		]);

		hidden.hidden = false;
		issue.updatedAt = "2026-10-29T03:00:00Z";
		clock.t = Date.parse("2026-10-29T03:00:05Z");

		const revealed = await controller.tick();

		assert.deepEqual(revealed.corrupt, []);
		assert.deepEqual(revealed.ledgerBehind, []);
		assert.equal(github.markers(14).length, 3);
	});

	it("retries a failed rewrite on a tick whose comments read lags, so a restart keeps the run without a second post", async () => {
		const ctx = world();
		const { github, clock, files, executor, logs, start } = ctx;
		const issue = github.add(labeled(14));
		const writes = failClaimWrite(files, 2);
		const controller = start();

		await controller.tick();

		assert.equal(files.claims.get(runOf(14))?.seq, 1);
		assert.ok(events(logs).includes("claim_unwritable"));
		writes.failing = false;

		const hidden = hideMarker(ctx, issue, 2);

		issue.updatedAt = "2026-10-29T02:01:00Z";
		clock.t = Date.parse("2026-10-29T02:01:05Z");
		await controller.tick();

		assert.deepEqual(files.claims.get(runOf(14)), blockedClaim(14, 2));

		clock.t += 30_000;

		const restarted = start();
		const report = await restarted.tick();

		assert.deepEqual(
			report.runs.map((run) => [run.status, run.seq]),
			[["blocked", 2]],
		);
		assert.deepEqual(report.ledgerBehind, [
			{ issue: 14, ledgerSeq: 1, localSeq: 2 },
		]);
		assert.deepEqual(statuses(github, 14), ["1:claimed", "2:blocked"]);

		hidden.hidden = false;
		issue.updatedAt = "2026-10-29T02:03:00Z";
		clock.t = Date.parse("2026-10-29T02:03:05Z");

		const revealed = await restarted.tick();

		assert.deepEqual(revealed.corrupt, []);
		assert.deepEqual(statuses(github, 14), ["1:claimed", "2:blocked"]);
		assert.equal(executor.launches.length, 2);
	});

	it("retries a failed rewrite after its marker is deleted, so a restart keeps the run without a second post", async () => {
		const { github, clock, files, executor, start } = world();
		const issue = github.add(labeled(14));
		const writes = failClaimWrite(files, 2);
		const controller = start();

		await controller.tick();
		writes.failing = false;
		issue.comments.pop();
		issue.updatedAt = "2026-10-29T02:01:00Z";
		github.now = "2026-10-29T02:01:00Z";
		clock.t += 30_000;

		const observed = await controller.tick();

		assert.equal(observed.runs[0]?.status, "blocked");
		assert.deepEqual(files.claims.get(runOf(14)), blockedClaim(14, 2));

		const report = await start().tick();

		assert.deepEqual(
			report.runs.map((run) => [run.status, run.seq]),
			[["blocked", 2]],
		);
		assert.deepEqual(report.corrupt, []);
		assert.deepEqual(statuses(github, 14), ["1:claimed"]);
		assert.equal(executor.launches.length, 2);
	});

	it("ends as duplicate_seq when the claim record and the comments read are both behind across a restart", async () => {
		const ctx = world();
		const { github, clock, files, start } = ctx;
		const issue = github.add(labeled(14));

		failClaimWrite(files, 2);
		await start().tick();

		const hidden = hideMarker(ctx, issue, 2);

		await start().tick();

		assert.deepEqual(statuses(github, 14), [
			"1:claimed",
			"2:blocked",
			"2:blocked",
		]);

		hidden.hidden = false;
		issue.updatedAt = "2026-10-29T03:00:00Z";
		clock.t = Date.parse("2026-10-29T03:00:05Z");

		const report = await start().tick();

		assert.deepEqual(report.corrupt, [{ issue: 14, defect: "duplicate_seq" }]);
		assert.deepEqual(report.runs, []);
	});

	it("writes the record upgrade on a later tick when adoption cannot write it", async () => {
		const { github, clock, files, start } = world();

		github.add(labeled(14));
		await start().tick();
		files.claims.set(runOf(14), {
			runId: runOf(14),
			issue: 14,
			eventId: String(EVENT_ID + 14),
			seq: null,
			status: null,
			stage: null,
			attempt: null,
			usage: null,
		});

		const write = files.writeClaim;
		let failing = true;

		files.writeClaim = async (claim) => (failing ? false : write(claim));

		const controller = start();

		await controller.tick();

		assert.equal(files.claims.get(runOf(14))?.seq, null);
		failing = false;
		clock.t += 30_000;
		await controller.tick();

		assert.deepEqual(files.claims.get(runOf(14)), blockedClaim(14, 2));
		assert.deepEqual(statuses(github, 14), ["1:claimed", "2:blocked"]);
	});

	it("retries a failed rewrite on every tick while the comments read stays behind", async () => {
		const ctx = world();
		const { github, clock, files, start } = ctx;
		const issue = github.add(labeled(14));
		const writes = failClaimWrite(files, 2);
		const controller = start();
		const behind = [{ issue: 14, ledgerSeq: 1, localSeq: 2 }];

		await controller.tick();

		assert.equal(files.claims.get(runOf(14))?.seq, 1);

		hideMarker(ctx, issue, 2);
		clock.t += 30_000;

		const lagging = await controller.tick();

		assert.deepEqual(lagging.ledgerBehind, behind);

		clock.t += 30_000;
		await controller.tick();

		assert.equal(files.claims.get(runOf(14))?.seq, 1);

		writes.failing = false;
		clock.t += 30_000;

		const healed = await controller.tick();

		assert.deepEqual(healed.ledgerBehind, behind);
		assert.deepEqual(files.claims.get(runOf(14)), blockedClaim(14, 2));
	});
});
