import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import { fileRunFiles } from "../../../host/controller/run-files.ts";
import { serveLoop } from "../../../host/controller/serve-loop.ts";
import { formatMarker, parseMarker } from "../../../src/trust/markers.ts";
import { backoffMs } from "../../../src/controller/orchestrator.ts";
import { READY_LABEL } from "../../../src/trust/policy.ts";
import { digestOf, runIdOf } from "../../../src/core/run.ts";
import {
	FakeGitHub,
	fakeIssue,
	labelEvent,
	TRUSTED_RUN_CAP,
} from "../../fake-ticket-adapter.ts";
import { EXE_DEV_PLATFORM } from "../../../src/trust/platform.ts";
import {
	repo,
	sha,
	START,
	resultOf,
	EVENT_ID,
	labeled,
	runOf,
	world,
	statuses,
	runIssues,
	events,
	endedClaim,
	settle,
	deferred,
} from "./orchestrator-fixtures.ts";

describe("backoffMs", () => {
	it("follows min(10000 * 2^(retry - 1), max)", () => {
		assert.deepEqual(
			[1, 2, 3, 4, 6, 7].map((retry) => backoffMs(retry, 300_000)),
			[10_000, 20_000, 40_000, 80_000, 300_000, 300_000],
		);
	});
});

describe("Orchestrator claims and dispatch", () => {
	it("claims a labeled issue, makes its workspace and records the blocked stage", async () => {
		const { github, files, executor, start } = world();

		github.add(labeled(14));

		const report = await start().tick();

		assert.equal(report.executionEnabled, false);
		assert.deepEqual(report.dispatch, { enabled: true, reasons: [] });
		assert.deepEqual(report.runs, [
			{
				issue: 14,
				runId: runOf(14),
				eventId: String(EVENT_ID + 14),
				stage: "specify",
				status: "blocked",
				attempt: 1,
				seq: 2,
				markerPending: false,
				workspace: "present",
				retryAt: null,
				usage: 0,
				unverified: null,
			},
		]);
		assert.deepEqual(statuses(github, 14), ["1:claimed", "2:blocked"]);
		assert.ok(files.workspaces.has(runOf(14)));
		assert.deepEqual([...files.claims.keys()], [runOf(14)]);
		assert.equal(executor.launches.length, 1);
	});

	it("makes no per-issue reads and posts nothing on unchanged polls", async () => {
		const { github, clock, start } = world();

		for (const number of [14, 15, 16, 17, 18, 19, 20, 21, 22, 23]) {
			github.add(labeled(number));
		}

		const controller = start();

		await controller.tick();
		clock.t += 30_000;
		await controller.tick();
		clock.t += 30_000;

		const markers = github.calls.filter((call) => call.includes("POST")).length;

		github.calls.length = 0;

		const report = await controller.tick();

		assert.deepEqual(runIssues(report), [14, 15]);
		assert.deepEqual(report.queued, [16, 17, 18, 19, 20, 21, 22, 23]);
		assert.equal(github.calls.length, 4, JSON.stringify(github.calls));
		assert.equal(
			github.calls.filter((call) => call.includes("POST")).length,
			0,
		);
		assert.equal(markers, 4);
	});

	it("keeps at most two claims and queues the third until one is released", async () => {
		const { github, start } = world();

		for (const number of [14, 15, 16]) github.add(labeled(number));

		const controller = start();
		const first = await controller.tick();

		assert.deepEqual(runIssues(first), [14, 15]);
		assert.deepEqual(first.queued, [16]);
		assert.deepEqual(statuses(github, 16), []);

		const closed = github.issues.get(14);

		assert.ok(closed);
		closed.state = "closed";
		closed.updatedAt = "2026-10-29T03:00:00Z";

		const second = await controller.tick();

		assert.deepEqual(runIssues(second), [15, 16]);
		assert.deepEqual(second.queued, []);
		assert.deepEqual(statuses(github, 14), [
			"1:claimed",
			"2:blocked",
			"3:released",
		]);
		assert.deepEqual(statuses(github, 16), ["1:claimed", "2:blocked"]);
		assert.equal(second.totals.releases, 1);
	});

	it("releases a claim whose ready label was removed", async () => {
		const { github, files, start } = world();
		const issue = github.add(labeled(14));
		const controller = start();

		await controller.tick();
		issue.labels = [];
		issue.updatedAt = "2026-10-29T03:00:00Z";

		const report = await controller.tick();

		assert.deepEqual(report.runs, []);
		assert.equal(statuses(github, 14).at(-1), "3:released");
		assert.deepEqual(
			[...files.claims.values()],
			[endedClaim(14, 3, { status: "released" })],
		);

		await controller.tick();

		assert.deepEqual(
			[...files.claims.values()],
			[endedClaim(14, 3, { status: "released" })],
		);
	});

	it("starts a new run when a new ready event replaces the claimed one", async () => {
		const { github, start } = world();
		const issue = github.add(labeled(14));
		const controller = start();

		await controller.tick();

		issue.timeline.push(
			labelEvent({
				id: 1,
				at: "2026-10-29T02:30:00Z",
				actor: "giuseppecrj",
				event: "unlabeled",
			}),
			labelEvent({
				id: 34537529999,
				at: "2026-10-29T02:31:00Z",
				actor: "giuseppecrj",
			}),
		);
		issue.updatedAt = "2026-10-29T02:31:00Z";
		github.now = "2026-10-29T02:32:00Z";

		const report = await controller.tick();
		const next = runIdOf({ repo, issue: 14, eventId: "34537529999" });

		assert.deepEqual(statuses(github, 14), [
			"1:claimed",
			"2:blocked",
			"3:released",
			"4:claimed",
			"5:blocked",
		]);
		assert.equal(report.runs[0]?.runId, next);
		assert.notEqual(next, runOf(14));
	});

	it("only touches the issues in scope and reports scoped issues that are not candidates", async () => {
		const { github, start } = world([15, 99]);

		github.add(labeled(14));
		github.add(labeled(15));

		const report = await start().tick();

		assert.deepEqual(runIssues(report), [15]);
		assert.deepEqual(report.absent, [99]);
		assert.deepEqual(statuses(github, 14), []);
	});

	it("records a refusal and does not read the issue again until it changes", async () => {
		const { github, start } = world();

		github.add(
			fakeIssue(14, {
				labels: [READY_LABEL],
				timeline: [
					labelEvent({ id: 5, at: "2026-10-29T01:21:37Z", actor: "triager" }),
				],
			}),
		);

		const controller = start();
		const first = await controller.tick();

		assert.deepEqual(first.refused, [{ issue: 14, reasons: ["unauthorized"] }]);

		github.calls.length = 0;

		const second = await controller.tick();

		assert.deepEqual(second.refused, []);
		assert.equal(github.calls.length, 4);
		assert.deepEqual(statuses(github, 14), []);
	});
});

describe("Orchestrator switches and per-tick reads", () => {
	it("stops new claims while the repository switch is off but keeps existing runs", async () => {
		const { github, start } = world();

		github.add(labeled(14));

		const controller = start();

		await controller.tick();
		github.add(labeled(15));
		github.repoLabels = [];

		const report = await controller.tick();

		assert.deepEqual(report.dispatch, {
			enabled: false,
			reasons: ["repo_switch_off"],
		});
		assert.deepEqual(runIssues(report), [14]);
		assert.equal(report.runs[0]?.status, "blocked");
		assert.deepEqual(statuses(github, 14), ["1:claimed", "2:blocked"]);
		assert.deepEqual(statuses(github, 15), []);
	});

	it("stops new claims while the local switch is off", async () => {
		const { github, store, start } = world();

		github.add(labeled(14));
		store.local = "disabled";

		const report = await start().tick();

		assert.deepEqual(report.dispatch.reasons, ["locally_disabled"]);
		assert.deepEqual(report.runs, []);
		assert.equal(store.records.size, 0);
	});

	it("still reconciles when the workflow cannot load", async () => {
		const { github, start } = world();
		const issue = github.add(labeled(14));
		const controller = start();

		await controller.tick();
		github.workflow = null;
		issue.state = "closed";

		const report = await controller.tick();

		assert.deepEqual(report.dispatch.reasons, ["workflow_unavailable"]);
		assert.equal(statuses(github, 14).at(-1), "3:released");
	});

	it("reads the switch and the workflow once per tick, not per candidate", async () => {
		const { github, start } = world();

		for (const number of [14, 15]) github.add(labeled(number));

		await start().tick();

		const switchReads = github.calls.filter((call) =>
			call.some((arg) => arg.includes("labels/factory%3Aenabled")),
		);

		const workflowReads = github.calls.filter((call) =>
			call.some((arg) => arg.includes("WORKFLOW.md")),
		);

		assert.equal(switchReads.length, 1);
		assert.equal(workflowReads.length, 1);
	});
});

describe("Orchestrator markers", () => {
	it("ignores a forged marker from another account", async () => {
		const { github, start } = world();
		const issue = github.add(labeled(14));

		github.comment(
			issue,
			formatMarker({
				v: 1,
				runId: runOf(14),
				repo,
				issue: 14,
				eventId: String(EVENT_ID + 14),
				eventAt: "2026-10-29T01:21:37Z",
				snapshotDigest: digestOf("x"),
				workflowSha: sha("c".repeat(40)),
				workflowDigest: digestOf("y"),
				stage: "land",
				status: "released",
				attempt: 1,
				seq: 50,
				branch: null,
				pr: null,
				usage: 0,
				cursor: null,
			}),
			{ login: "giuseppecrj", type: "User", appSlug: null },
		);

		const report = await start().tick();

		assert.deepEqual(runIssues(report), [14]);
		assert.deepEqual(statuses(github, 14), ["1:claimed", "2:blocked"]);
	});

	it("fails closed on an edited marker after a restart and dispatches nothing", async () => {
		const { github, start } = world();
		const issue = github.add(labeled(14));

		await start().tick();

		const first = issue.comments[0];

		assert.ok(first);
		first.lastEditedAt = "2026-10-29T03:00:00Z";

		const report = await start().tick();

		assert.deepEqual(report.runs, []);
		assert.deepEqual(report.corrupt, [{ issue: 14, defect: "edited" }]);
		assert.equal(github.markers(14).length, 2);
	});

	it("fails closed on a corrupt bot marker", async () => {
		const { github, start } = world();
		const issue = github.add(labeled(14));

		github.comment(issue, '<!-- factory:run {"v":7} -->');

		const report = await start().tick();

		assert.deepEqual(report.corrupt, [
			{ issue: 14, defect: "unknown_version" },
		]);
		assert.deepEqual(report.runs, []);
		assert.equal(github.markers(14).length, 1);
	});

	it("reads an unanswered POST back on the next tick and never posts it twice", async () => {
		const { github, start } = world();

		github.add(labeled(14));
		github.posts = ["landed_unanswered"];

		const controller = start();
		const first = await controller.tick();

		assert.equal(first.runs[0]?.markerPending, true);
		assert.deepEqual(statuses(github, 14), ["1:claimed"]);

		const second = await controller.tick();

		assert.deepEqual(statuses(github, 14), ["1:claimed", "2:blocked"]);
		assert.equal(second.runs[0]?.markerPending, false);
	});

	it("posts again after the read-back finds a lost POST missing", async () => {
		const { github, start } = world();

		github.add(labeled(14));
		github.posts = ["lost"];

		const controller = start();

		await controller.tick();
		assert.deepEqual(statuses(github, 14), []);

		await controller.tick();
		assert.deepEqual(statuses(github, 14), ["1:claimed", "2:blocked"]);
	});
});

describe("Orchestrator restart recovery", () => {
	it("keeps the run ID and posts no second marker", async () => {
		const { github, executor, logs, start } = world();

		github.add(labeled(14));
		await start().tick();

		const report = await start().tick();

		assert.equal(report.runs[0]?.runId, runOf(14));
		assert.equal(report.runs[0]?.status, "blocked");
		assert.deepEqual(statuses(github, 14), ["1:claimed", "2:blocked"]);
		assert.ok(events(logs).includes("claim_adopted"));
		assert.equal(executor.launches.length, 2);
	});

	it("records a missing workspace, replays the stage and invents nothing", async () => {
		const { github, files, logs, start } = world();

		github.add(labeled(14));
		await start().tick();
		files.workspaces.clear();

		const report = await start().tick();

		assert.equal(report.runs[0]?.workspace, "missing_replayed");
		assert.equal(report.runs[0]?.status, "blocked");
		assert.ok(events(logs).includes("workspace_missing"));
		assert.ok(files.workspaces.has(runOf(14)));
		assert.deepEqual(statuses(github, 14), ["1:claimed", "2:blocked"]);
	});

	it("claims once after a crash between the admission record and the marker", async () => {
		const { github, store, files, start } = world();

		github.add(labeled(14));
		github.posts = ["lost"];
		await start().tick();

		assert.equal(store.records.size, 1);
		assert.equal(files.claims.size, 1);
		assert.deepEqual(statuses(github, 14), []);

		const report = await start().tick();

		assert.equal(report.runs[0]?.runId, runOf(14));
		assert.deepEqual(statuses(github, 14), ["1:claimed", "2:blocked"]);
	});

	it("adopts a claimed marker after a crash before the stage launched", async () => {
		const { github, start, executor } = world();

		github.add(labeled(14));
		github.posts = ["ok", "lost"];
		await start().tick();

		assert.deepEqual(statuses(github, 14), ["1:claimed"]);

		const report = await start().tick();

		assert.equal(report.runs[0]?.status, "blocked");
		assert.deepEqual(statuses(github, 14), ["1:claimed", "2:blocked"]);
		assert.equal(executor.launches.length, 2);
	});

	it("releases a claim whose issue closed while the controller was down", async () => {
		const { github, files, start } = world();
		const issue = github.add(labeled(14));

		await start().tick();
		issue.state = "closed";

		const report = await start().tick();

		assert.deepEqual(report.runs, []);
		assert.equal(statuses(github, 14).at(-1), "3:released");
		assert.deepEqual(
			[...files.claims.values()],
			[endedClaim(14, 3, { status: "released" })],
		);
	});

	it("counts what an interrupted stage spent, from its receipt or gateway tally, when a restart adopts it", async () => {
		const { github, executor, start } = world();

		github.add(labeled(14));
		executor.behaviors = [{ kind: "hang" }];
		await start().tick();

		executor.spentBy.set("specify-1", 700);

		const report = await start().tick();

		assert.deepEqual(
			report.runs.map((run) => [run.status, run.attempt, run.usage]),
			[["retrying", 2, 700]],
		);
		assert.equal(report.totals.usage, 700);
	});

	it("keeps an attempt-end decision across a lost marker and preserves its original retry time", async () => {
		const { github, executor, files, start, clock } = world();
		const disk = fileRunFiles(files.artifactRoot);

		files.accounting = disk.accounting;
		github.add(labeled(14));
		executor.behaviors = [{ kind: "hang" }];
		await start().tick();
		executor.spentBy.set("specify-1", 700);
		github.posts = ["rejected"];
		await start().tick();

		const record = await disk.accounting!.readAttempt(
			runOf(14),
			"specify",
			0,
			1,
		);

		assert.equal(record?.disposition, "interrupted");
		assert.equal(record?.usage, 700);
		assert.equal(record?.next.kind, "retry");
		clock.t += 6_000;
		const restored = await start().tick();

		assert.equal(restored.runs[0]?.attempt, 2);
		assert.equal(restored.runs[0]?.usage, 700);
		assert.equal(executor.launches.length, 1);
		clock.t += 4_000;
		executor.behaviors = [{ kind: "hang" }];
		await start().tick();
		assert.equal(executor.launches.length, 2);
		assert.deepEqual(
			await disk.accounting!.readAttempt(runOf(14), "specify", 0, 1),
			record,
		);
	});

	it("turns an interrupted running stage into a counted retry", async () => {
		const { github, executor, start } = world();

		github.add(labeled(14));
		executor.behaviors = [{ kind: "hang" }];
		await start().tick();

		assert.deepEqual(statuses(github, 14), ["1:claimed", "2:running"]);

		const report = await start().tick();

		assert.equal(report.runs[0]?.attempt, 2);
		assert.equal(report.runs[0]?.status, "retrying");
		assert.deepEqual(statuses(github, 14), [
			"1:claimed",
			"2:running",
			"3:retrying",
		]);
	});

	async function stopAfterUnmarkedSpend(
		ctx: ReturnType<typeof world>,
		spent: number,
	): Promise<void> {
		const { github, executor, start } = ctx;

		github.add(labeled(14));
		github.posts = ["ok", "rejected"];
		executor.behaviors = [{ kind: "hang" }];

		const stop = new AbortController();
		const stateDir = mkdtempSync(join(tmpdir(), "factory-serve-stop-"));

		try {
			await serveLoop({
				platform: EXE_DEV_PLATFORM,
				orchestrator: start(),
				stateDir,
				signal: stop.signal,
				log: () => {},
				sleep: async () => {
					executor.launches[0]?.progress(spent);
					executor.spentBy.set("specify-1", spent);
					stop.abort();
				},
			});
		} finally {
			rmSync(stateDir, { recursive: true, force: true });
		}

		assert.deepEqual(statuses(github, 14), ["1:claimed"]);
	}

	function usageOf(github: FakeGitHub, issue: number): number[] {
		return github.markers(issue).map((body) => {
			const parsed = parseMarker(body);

			return parsed.kind === "marker" ? parsed.marker.usage : -1;
		});
	}

	for (const [spent, launches] of [
		[TRUSTED_RUN_CAP - 1, true],
		[TRUSTED_RUN_CAP, false],
		[TRUSTED_RUN_CAP + 1, false],
	] as const)
		it(`restores ${spent} spent tokens against the ${TRUSTED_RUN_CAP} run cap and ${launches ? "launches with what is left" : "launches nothing"}`, async () => {
			const ctx = world();
			const { github, executor, start } = ctx;

			await stopAfterUnmarkedSpend(ctx, spent);
			executor.behaviors = [{ kind: "hang" }];

			const report = await start().tick();

			if (launches) {
				assert.equal(executor.launches.length, 2);
				assert.equal(
					executor.launches[1]?.remainingRunTokens,
					TRUSTED_RUN_CAP - spent,
				);

				return;
			}

			assert.equal(executor.launches.length, 1);
			assert.deepEqual(report.runs, []);
			assert.equal(statuses(github, 14).at(-1), "2:budget_exhausted");
			assert.equal(usageOf(github, 14).at(-1), spent);
		});

	it("gives a replay of a claimed attempt only what that attempt's earlier execution left of the run cap", async () => {
		const ctx = world();
		const { github, executor, start } = ctx;

		await stopAfterUnmarkedSpend(ctx, TRUSTED_RUN_CAP - 100);

		executor.behaviors = [{ kind: "pass", usage: 200 }];

		const second = start();

		await second.tick();
		assert.equal(executor.launches[1]?.attempt, 1);
		assert.equal(executor.launches[1]?.remainingRunTokens, 100);

		executor.spentBy.set("specify-1", TRUSTED_RUN_CAP + 100);

		const ended = await second.tick();

		assert.deepEqual(statuses(github, 14), [
			"1:claimed",
			"2:running",
			"3:claimed",
			"4:budget_exhausted",
		]);
		assert.equal(usageOf(github, 14).at(-1), TRUSTED_RUN_CAP + 100);
		assert.equal(ended.totals.usage, TRUSTED_RUN_CAP + 100);
	});

	it("counts a replayed attempt's executions once when the replay is interrupted too", async () => {
		const ctx = world();
		const { github, executor, start } = ctx;

		await stopAfterUnmarkedSpend(ctx, 300);

		executor.behaviors = [{ kind: "hang" }];
		await start().tick();
		assert.equal(
			executor.launches[1]?.remainingRunTokens,
			TRUSTED_RUN_CAP - 300,
		);
		assert.deepEqual(statuses(github, 14), ["1:claimed", "2:running"]);

		executor.spentBy.set("specify-1", 300 + 50);

		const report = await start().tick();

		assert.deepEqual(
			report.runs.map((run) => [run.status, run.attempt, run.usage]),
			[["retrying", 2, 350]],
		);
		assert.equal(usageOf(github, 14).at(-1), 350);
	});

	/**
	 * Leaves attempt 1 with 300 tokens on disk that no marker counts, and its
	 * last marker `claimed`, or `blocked` after a restart whose launch was
	 * refused.
	 */
	async function seedReplay(
		ctx: ReturnType<typeof world>,
		origin: "claimed" | "blocked",
	): Promise<number> {
		await stopAfterUnmarkedSpend(ctx, 300);

		if (origin === "blocked") {
			await ctx.start().tick();
			assert.deepEqual(statuses(ctx.github, 14), ["1:claimed", "2:blocked"]);
		}

		return statuses(ctx.github, 14).length;
	}

	for (const origin of ["claimed", "blocked"] as const) {
		it(`keeps a ${origin} replay's earlier spend when it stalls with no progress and reports nothing late`, async () => {
			const ctx = world();
			const { github, clock, executor, start } = ctx;

			await seedReplay(ctx, origin);
			executor.behaviors = [{ kind: "hang" }];

			const controller = start();

			await controller.tick();
			assert.equal(
				executor.launches.at(-1)?.remainingRunTokens,
				TRUSTED_RUN_CAP - 300,
			);

			clock.t += 300_001;

			const stalled = await controller.tick();

			assert.deepEqual(
				stalled.runs.map((run) => [run.status, run.attempt, run.usage]),
				[["retrying", 2, 300]],
			);
			assert.equal(usageOf(github, 14).at(-1), 300);

			executor.behaviors = [{ kind: "hang" }];
			clock.t += 15_000;
			await controller.tick();

			assert.equal(executor.launches.at(-1)?.attempt, 2);
			assert.equal(
				executor.launches.at(-1)?.remainingRunTokens,
				TRUSTED_RUN_CAP - 300,
			);
		});

		it(`counts a ${origin} replay's progress on top of its earlier spend at a stall, and late usage once`, async () => {
			const ctx = world();
			const { github, clock, executor, start } = ctx;
			const stage = deferred();

			await seedReplay(ctx, origin);
			executor.behaviors = [stage.behavior];

			const controller = start();

			await controller.tick();

			const launch = executor.launches.at(-1);

			assert.ok(launch);
			launch.progress(50);
			clock.t += 300_001;

			const stalled = await controller.tick();

			assert.equal(launch.signal.aborted, true);
			assert.deepEqual(
				stalled.runs.map((run) => [run.status, run.usage]),
				[["retrying", 350]],
			);
			assert.equal(usageOf(github, 14).at(-1), 350);

			stage.finish(resultOf(launch, { kind: "failed", exit: "aborted" }, 80));
			await settle();

			const counted = await controller.tick();

			assert.equal(counted.runs[0]?.usage, 380);
			assert.equal(usageOf(github, 14).at(-1), 380);

			const again = await start().tick();

			assert.equal(again.runs[0]?.usage, 380);
		});

		it(`releases an aborted ${origin} replay with its earlier spend and its progress`, async () => {
			const ctx = world();
			const { github, clock, executor, start } = ctx;

			const seq = await seedReplay(ctx, origin);

			executor.behaviors = [{ kind: "hang" }];

			const controller = start();

			await controller.tick();

			const launch = executor.launches.at(-1);

			assert.ok(launch);
			launch.progress(50);

			const issue = github.issues.get(14);

			assert.ok(issue);
			issue.state = "closed";
			issue.updatedAt = "2026-10-29T03:00:00Z";
			await controller.tick();

			assert.equal(launch.signal.aborted, true);
			assert.equal(statuses(github, 14).at(-1), `${seq + 1}:running`);

			clock.t += 15_000;

			const ended = await controller.tick();

			assert.deepEqual(ended.runs, []);
			assert.equal(statuses(github, 14).at(-1), `${seq + 2}:released`);
			assert.equal(usageOf(github, 14).at(-1), 350);
		});

		it(`counts a ${origin} attempt's earlier executions when a restart releases it`, async () => {
			const ctx = world();
			const { github, start } = ctx;

			const seq = await seedReplay(ctx, origin);
			const issue = github.issues.get(14);

			assert.ok(issue);
			issue.state = "closed";

			const report = await start().tick();

			assert.deepEqual(report.runs, []);
			assert.equal(statuses(github, 14).at(-1), `${seq + 1}:released`);
			assert.equal(usageOf(github, 14).at(-1), 300);
			assert.equal(report.totals.usage, 300);
		});
	}

	it("counts an adopted attempt's earlier executions when its issue closes after a refused launch", async () => {
		const ctx = world();
		const { github, executor, start } = ctx;

		await stopAfterUnmarkedSpend(ctx, 300);

		const controller = start();

		await controller.tick();
		assert.equal(executor.launches.length, 2);
		assert.deepEqual(statuses(github, 14), ["1:claimed", "2:blocked"]);

		const issue = github.issues.get(14);

		assert.ok(issue);
		issue.state = "closed";
		issue.updatedAt = "2026-10-29T03:00:00Z";

		const report = await controller.tick();

		assert.deepEqual(report.runs, []);
		assert.equal(statuses(github, 14).at(-1), "3:released");
		assert.equal(usageOf(github, 14).at(-1), 300);
		assert.equal(report.totals.usage, 300);
	});
});

describe("Orchestrator retries and stalls", () => {
	it("backs off 10 s then 20 s and stops at the attempt cap", async () => {
		const { github, clock, files, executor, start } = world();

		github.add(labeled(14));
		executor.fallback = { kind: "fail", usage: 0 };

		const controller = start();

		await controller.tick();

		const queued = await controller.tick();

		assert.equal(queued.runs[0]?.status, "retrying");
		assert.equal(queued.runs[0]?.attempt, 2);
		assert.equal(
			queued.runs[0]?.retryAt,
			new Date(START + 10_000).toISOString(),
		);

		clock.t += 9_999;
		await controller.tick();
		assert.equal(executor.launches.length, 1);

		clock.t += 1;
		await controller.tick();
		assert.equal(executor.launches.length, 2);

		const second = await controller.tick();

		assert.equal(second.runs[0]?.attempt, 3);
		assert.equal(
			second.runs[0]?.retryAt,
			new Date(clock.t + 20_000).toISOString(),
		);

		clock.t += 20_000;
		await controller.tick();
		assert.equal(executor.launches.length, 3);

		const last = await controller.tick();

		assert.deepEqual(last.runs, []);
		assert.equal(last.totals.retries, 2);
		assert.equal(last.totals.failures, 1);
		assert.equal(statuses(github, 14).at(-1), "7:failed");
		assert.deepEqual(
			[...files.claims.values()],
			[endedClaim(14, 7, { status: "failed", attempt: 3 })],
		);
	});

	it("terminates a stalled stage and queues a retry", async () => {
		const { github, clock, executor, start } = world();

		github.add(labeled(14));
		executor.behaviors = [{ kind: "hang" }];

		const controller = start();

		await controller.tick();

		const launch = executor.launches[0];

		assert.ok(launch);

		clock.t += 200_000;
		launch.progress(0);
		clock.t += 300_000;
		await controller.tick();
		assert.equal(launch.signal.aborted, false);

		clock.t += 1;

		const report = await controller.tick();

		assert.equal(launch.signal.aborted, true);
		assert.equal(report.runs[0]?.status, "retrying");
		assert.equal(report.totals.stalls, 1);
	});

	it("counts retry usage in one run budget", async () => {
		const { github, executor, start } = world();

		github.add(labeled(14));
		executor.behaviors = [{ kind: "fail", usage: TRUSTED_RUN_CAP }];

		const controller = start();

		await controller.tick();

		const report = await controller.tick();

		assert.deepEqual(report.runs, []);
		assert.equal(report.totals.usage, TRUSTED_RUN_CAP);
		assert.equal(
			statuses(github, 14).at(-1)?.endsWith(":budget_exhausted"),
			true,
		);
	});

	it("releases a queued retry whose issue closed instead of launching it", async () => {
		const { github, clock, executor, start } = world();
		const issue = github.add(labeled(14));

		executor.behaviors = [{ kind: "fail", usage: 0 }];

		const controller = start();

		await controller.tick();
		await controller.tick();
		issue.state = "closed";
		clock.t += 10_000;

		const report = await controller.tick();

		assert.deepEqual(report.runs, []);
		assert.equal(executor.launches.length, 1);
		assert.equal(statuses(github, 14).at(-1)?.endsWith(":released"), true);
	});
});
