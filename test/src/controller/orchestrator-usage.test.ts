import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { Orchestrator } from "../../../src/controller/orchestrator.ts";
import type { StageResult } from "../../../src/controller/launch.ts";
import { TRUSTED_RUN_CAP } from "../../fake-ticket-adapter.ts";
import { EXE_DEV_PLATFORM } from "../../../src/trust/platform.ts";
import {
	repo,
	resultOf,
	labeled,
	runOf,
	world,
	statuses,
	runIssues,
	relabel,
	capAt,
	setWorkflow,
	lastMarkerUsage,
	settle,
	claimUsage,
	deferred,
} from "./orchestrator-fixtures.ts";

describe("Orchestrator run allowance at launch", () => {
	it("launches no retry once a lowered workflow cap leaves the run no allowance", async () => {
		const { github, clock, executor, start } = world();

		github.add(labeled(14));
		executor.behaviors = [
			{ kind: "fail", usage: 300_000 },
			{ kind: "pass", usage: 1 },
		];

		const controller = start();

		await controller.tick();

		const queued = await controller.tick();

		assert.equal(queued.runs[0]?.status, "retrying");

		setWorkflow(
			github,
			`max_tokens_per_run: ${TRUSTED_RUN_CAP}`,
			"max_tokens_per_run: 100000",
		);
		clock.t += 10_000;

		const report = await controller.tick();

		assert.equal(executor.launches.length, 1);
		assert.deepEqual(report.runs, []);
		assert.equal(
			statuses(github, 14).at(-1)?.endsWith(":budget_exhausted"),
			true,
		);
		assert.equal(lastMarkerUsage(github, 14), 300_000);
	});
});

describe("Orchestrator usage reported after a stall", () => {
	it("counts usage a stalled stage reports while it cleans up, once, before its retry launches", async () => {
		const { github, clock, executor, start } = world();
		let finish: (result: StageResult) => void = () => undefined;

		github.add(labeled(14));
		executor.behaviors = [
			{
				kind: "later",
				result: new Promise((done) => {
					finish = done;
				}),
			},
			{ kind: "pass", usage: 1 },
		];

		const controller = start();

		await controller.tick();

		const launch = executor.launches[0];

		assert.ok(launch);
		launch.progress(100);
		clock.t += 300_001;

		const stalled = await controller.tick();

		assert.equal(launch.signal.aborted, true);
		assert.equal(stalled.runs[0]?.status, "retrying");
		assert.equal(stalled.totals.usage, 100);

		launch.progress(250);
		finish(resultOf(launch, { kind: "failed", exit: "aborted" }, 250));
		await settle();

		const next = await controller.tick();

		assert.equal(next.runs[0]?.usage, 250);
		assert.equal(next.totals.usage, 250);
		assert.equal(next.runs[0]?.status, "retrying");

		clock.t += 10_000;
		await controller.tick();

		assert.equal(
			executor.launches[1]?.remainingRunTokens,
			TRUSTED_RUN_CAP - 250,
		);

		const after = await controller.tick();

		assert.equal(after.totals.usage, 251);
	});

	it("holds a retry until the stalled stage settles or its cleanup reserve has passed", async () => {
		const { github, clock, executor, start } = world();
		let finish: (result: StageResult) => void = () => undefined;

		setWorkflow(github, "max_backoff_ms: 300000", "max_backoff_ms: 1000");
		github.add(labeled(14));
		executor.behaviors = [
			{
				kind: "later",
				result: new Promise((done) => {
					finish = done;
				}),
			},
			{ kind: "hang" },
		];

		const controller = start();

		await controller.tick();

		const launch = executor.launches[0];

		assert.ok(launch);
		clock.t += 300_001;
		await controller.tick();

		clock.t += 1_000;

		const held = await controller.tick();

		assert.equal(executor.launches.length, 1);
		assert.equal(held.runs[0]?.status, "retrying");

		launch.progress(40);
		finish(resultOf(launch, { kind: "failed", exit: "aborted" }, 40));
		await settle();
		await controller.tick();
		assert.equal(executor.launches.length, 2);
		assert.equal(
			executor.launches[1]?.remainingRunTokens,
			TRUSTED_RUN_CAP - 40,
		);
	});

	it("puts late usage in the terminal marker when the stall ends the run", async () => {
		const { github, clock, executor, start } = world();
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
		launch.progress(TRUSTED_RUN_CAP);
		clock.t += 300_001;
		await controller.tick();

		assert.equal(statuses(github, 14).at(-1), "2:running");

		launch.progress(TRUSTED_RUN_CAP + 100_000);
		finish(
			resultOf(
				launch,
				{ kind: "failed", exit: "aborted" },
				TRUSTED_RUN_CAP + 100_000,
			),
		);
		await settle();

		const report = await controller.tick();

		assert.deepEqual(report.runs, []);
		assert.equal(report.totals.usage, TRUSTED_RUN_CAP + 100_000);
		assert.equal(statuses(github, 14).at(-1), "3:budget_exhausted");
		assert.equal(lastMarkerUsage(github, 14), TRUSTED_RUN_CAP + 100_000);
	});

	it("posts the terminal marker once the cleanup reserve and its grace pass, if the stage never settles", async () => {
		const { github, clock, executor, start } = world();

		github.add(labeled(14));
		executor.behaviors = [{ kind: "hang" }];

		const controller = start();

		await controller.tick();
		executor.launches[0]?.progress(TRUSTED_RUN_CAP);
		clock.t += 300_001;
		await controller.tick();
		assert.equal(statuses(github, 14).at(-1), "2:running");

		clock.t += 15_000;

		const report = await controller.tick();

		assert.deepEqual(report.runs, []);
		assert.equal(statuses(github, 14).at(-1), "3:budget_exhausted");
	});
});

describe("Orchestrator logger receiver", () => {
	it("calls a method-style logger on its input when a stalled stage reports late usage", async () => {
		const { github, clock, store, files, executor } = world();
		const stage = deferred();

		github.add(labeled(14));
		executor.behaviors = [stage.behavior, { kind: "hang" }];

		const seen: string[] = [];

		const input = {
			platform: EXE_DEV_PLATFORM,
			exec: github.exec,
			env: () => "/home/exedev",
			repo,
			store,
			files,
			executor,
			clock,
			scope: null,
			seen,
			log(event: string) {
				this.seen.push(event);
			},
		};

		const controller = new Orchestrator(input);

		await controller.tick();

		const launch = executor.launches[0];

		assert.ok(launch);
		clock.t += 300_001;
		await controller.tick();
		launch.progress(40);
		stage.finish(resultOf(launch, { kind: "failed", exit: "aborted" }, 40));
		await settle();

		const report = await controller.tick();

		assert.equal(report.totals.usage, 40);
		assert.equal(
			input.seen.filter((event) => event === "stage_late_usage").length,
			1,
		);
	});
});

describe("Orchestrator late usage across a restart", () => {
	it("rewrites the retry marker and claim record with late stall usage, so a restart restores the allowance the run has left", async () => {
		const { github, clock, executor, files, start } = world();
		const stage = deferred();

		github.add(labeled(14));
		executor.behaviors = [stage.behavior];

		const first = start();

		await first.tick();

		const launch = executor.launches[0];

		assert.ok(launch);
		launch.progress(100);
		clock.t += 300_001;
		await first.tick();
		assert.equal(lastMarkerUsage(github, 14), 100);

		launch.progress(250);
		stage.finish(resultOf(launch, { kind: "failed", exit: "aborted" }, 250));
		await settle();

		const counted = await first.tick();

		assert.equal(counted.runs[0]?.usage, 250);
		assert.equal(counted.runs[0]?.status, "retrying");
		assert.equal(lastMarkerUsage(github, 14), 250);
		assert.equal(claimUsage(files, 14), 250);

		executor.spentBy.set("specify-1", 250);
		executor.behaviors = [{ kind: "hang" }];

		const second = start();

		clock.t += 10_000;
		await second.tick();
		await second.tick();

		assert.equal(executor.launches.length, 2);
		assert.equal(
			executor.launches[1]?.remainingRunTokens,
			TRUSTED_RUN_CAP - 250,
		);
	});

	it("reconciles the previous attempt's records once when the controller stopped before it counted the late usage", async () => {
		const { github, clock, executor, files, start } = world();

		github.add(labeled(14));
		executor.behaviors = [{ kind: "hang" }];

		const first = start();

		await first.tick();
		executor.launches[0]?.progress(100);
		clock.t += 300_001;
		await first.tick();
		assert.equal(lastMarkerUsage(github, 14), 100);

		executor.spentBy.set("specify-1", 250);
		executor.behaviors = [{ kind: "hang" }];

		const second = start();
		const adopted = await second.tick();

		assert.equal(adopted.runs[0]?.usage, 250);
		assert.equal(adopted.totals.usage, 150);
		assert.equal(lastMarkerUsage(github, 14), 250);
		assert.equal(claimUsage(files, 14), 250);

		clock.t += 10_000;
		await second.tick();
		assert.equal(
			executor.launches[1]?.remainingRunTokens,
			TRUSTED_RUN_CAP - 250,
		);

		const third = start();
		const again = await third.tick();

		assert.equal(again.runs[0]?.usage, 250);
	});

	it("refreshes an adopted attempt's spend once its scope is stopped, before the retry launches", async () => {
		const { github, clock, executor, start } = world();

		github.add(labeled(14));
		executor.behaviors = [{ kind: "hang" }];
		await start().tick();

		executor.ready = false;
		executor.spentBy.set("specify-1", 100);
		executor.behaviors = [{ kind: "hang" }];

		const controller = start();
		const adopted = await controller.tick();

		assert.equal(adopted.executionEnabled, false);
		assert.equal(adopted.runs[0]?.usage, 100);

		executor.spentBy.set("specify-1", 700);
		executor.ready = true;
		clock.t += 10_000;
		await controller.tick();

		assert.equal(
			executor.launches[1]?.remainingRunTokens,
			TRUSTED_RUN_CAP - 700,
		);
	});

	it("releases an adopted run only once its scopes are stopped, with what its attempt spent until then", async () => {
		const { github, executor, start } = world();
		const issue = github.add(labeled(14));

		executor.behaviors = [{ kind: "hang" }];
		await start().tick();

		executor.ready = false;
		executor.stopped = false;
		executor.spentBy.set("specify-1", 100);
		issue.state = "closed";

		const controller = start();

		await controller.tick();
		await controller.tick();
		assert.deepEqual(statuses(github, 14), ["1:claimed", "2:running"]);

		executor.spentBy.set("specify-1", 700);
		executor.stopped = true;
		executor.ready = null;

		const report = await controller.tick();

		assert.deepEqual(report.runs, []);
		assert.equal(statuses(github, 14).at(-1), "3:released");
		assert.equal(lastMarkerUsage(github, 14), 700);
		assert.equal(report.totals.usage, 700);
	});

	it("counts an interrupted attempt's spend when the restart releases the run", async () => {
		const { github, executor, start } = world();
		const issue = github.add(labeled(14));

		executor.behaviors = [{ kind: "hang" }];
		await start().tick();

		executor.spentBy.set("specify-1", 700);
		issue.state = "closed";

		const report = await start().tick();

		assert.deepEqual(report.runs, []);
		assert.equal(report.totals.usage, 700);
		assert.equal(statuses(github, 14).at(-1), "3:released");
		assert.equal(lastMarkerUsage(github, 14), 700);
	});

	it("holds a terminal marker past the cleanup reserve until the runner's bounded cleanup can finish", async () => {
		const { github, clock, executor, start } = world();
		const stage = deferred();

		github.add(labeled(14));
		executor.behaviors = [stage.behavior];

		const controller = start();

		await controller.tick();

		const launch = executor.launches[0];

		assert.ok(launch);
		launch.progress(TRUSTED_RUN_CAP);
		clock.t += 300_001;
		await controller.tick();
		clock.t += 10_000;
		await controller.tick();
		assert.equal(statuses(github, 14).at(-1), "2:running");

		launch.progress(TRUSTED_RUN_CAP + 100_000);
		stage.finish(
			resultOf(
				launch,
				{ kind: "failed", exit: "aborted" },
				TRUSTED_RUN_CAP + 100_000,
			),
		);
		await settle();

		const report = await controller.tick();

		assert.equal(report.totals.usage, TRUSTED_RUN_CAP + 100_000);
		assert.equal(statuses(github, 14).at(-1), "3:budget_exhausted");
		assert.equal(lastMarkerUsage(github, 14), TRUSTED_RUN_CAP + 100_000);
	});
});

describe("Orchestrator tick order", () => {
	it("reconciles a finished stage before it waits on a slow preflight", async () => {
		const { github, executor, start } = world();

		github.add(labeled(14));
		executor.behaviors = [{ kind: "pass", usage: 5 }];

		const controller = start();

		await controller.tick();

		const seen: string[][] = [];
		const ready = executor.preflight.bind(executor);

		executor.preflight = async () => {
			seen.push(statuses(github, 14));
			await new Promise((done) => setTimeout(done, 20));

			return ready();
		};

		const report = await controller.tick();

		assert.deepEqual(seen, [["1:claimed", "2:running", "3:claimed"]]);
		assert.equal(report.runs[0]?.stage, "accept");
	});
});

describe("Orchestrator timeline with no ready event", () => {
	it("keeps a claim recorded before its first marker, caches nothing, and recovers it when the event reads again", async () => {
		const { github, clock, files, start } = world();
		const issue = github.add(labeled(14));

		github.posts = ["lost"];
		await start().tick();

		const timeline = issue.timeline;

		issue.timeline = [];
		issue.updatedAt = "2026-10-29T02:30:00Z";
		clock.t += 40 * 60_000;

		const controller = start();
		const empty = await controller.tick();

		assert.deepEqual(empty.runs, []);
		assert.deepEqual(empty.refused, []);
		assert.deepEqual(statuses(github, 14), []);
		assert.equal(files.claims.get(runOf(14))?.status, null);

		issue.timeline = timeline;
		clock.t += 30_000;

		const restored = await controller.tick();

		assert.equal(restored.runs[0]?.runId, runOf(14));
		assert.deepEqual(statuses(github, 14), ["1:claimed", "2:blocked"]);
	});

	it("decides nothing for an adopted running marker, and counts the interruption once the event reads again", async () => {
		const { github, executor, start } = world();
		const issue = github.add(labeled(14));

		executor.behaviors = [{ kind: "hang" }];
		await start().tick();

		const timeline = issue.timeline;

		issue.timeline = [];
		issue.updatedAt = "2026-10-29T02:30:00Z";

		const controller = start();
		const empty = await controller.tick();

		assert.deepEqual(empty.runs, []);
		assert.deepEqual(empty.queued, [14]);
		assert.deepEqual(statuses(github, 14), ["1:claimed", "2:running"]);

		issue.timeline = timeline;

		const restored = await controller.tick();

		assert.equal(restored.runs[0]?.status, "retrying");
		assert.deepEqual(statuses(github, 14), [
			"1:claimed",
			"2:running",
			"3:retrying",
		]);
	});

	it("keeps a held run in the same process and does not release it", async () => {
		const { github, clock, start } = world();
		const issue = github.add(labeled(14));
		const controller = start();

		await controller.tick();

		const timeline = issue.timeline;

		issue.timeline = [];
		issue.updatedAt = "2026-10-29T02:30:00Z";
		clock.t += 40 * 60_000;

		const empty = await controller.tick();

		assert.equal(empty.runs[0]?.status, "blocked");
		assert.deepEqual(statuses(github, 14), ["1:claimed", "2:blocked"]);

		issue.timeline = timeline;
		clock.t += 30_000;

		const restored = await controller.tick();

		assert.equal(restored.runs[0]?.status, "blocked");
		assert.deepEqual(statuses(github, 14), ["1:claimed", "2:blocked"]);
	});
});

describe("Orchestrator eligibility before adoption", () => {
	it("releases a replaced marker-backed claim before the first workflow load", async () => {
		const { github, clock, files, start } = world();
		const issue = github.add(labeled(14));

		await start().tick();

		const next = relabel(github, issue);
		const workflow = github.workflow;

		github.workflow = null;
		clock.t += 40 * 60_000;

		const controller = start();
		const unloaded = await controller.tick();

		assert.deepEqual(unloaded.dispatch.reasons, ["workflow_unavailable"]);
		assert.deepEqual(unloaded.runs, []);
		assert.equal(files.claims.get(runOf(14))?.status, "released");
		assert.deepEqual(statuses(github, 14), [
			"1:claimed",
			"2:blocked",
			"3:released",
		]);

		github.workflow = workflow;
		clock.t += 30_000;

		const loaded = await controller.tick();

		assert.equal(loaded.runs[0]?.runId, next);
		assert.deepEqual(statuses(github, 14).slice(3), ["4:claimed", "5:blocked"]);
	});

	it("releases a replaced marker-backed claim without waiting for an adoption slot", async () => {
		const { github, clock, files, start } = world();

		github.add(labeled(14));

		const issue = github.add(labeled(16));

		await start().tick();
		capAt(github, 1);
		relabel(github, issue);
		clock.t += 40 * 60_000;

		const report = await start().tick();

		assert.equal(files.claims.get(runOf(16))?.status, "released");
		assert.deepEqual(statuses(github, 16), [
			"1:claimed",
			"2:blocked",
			"3:released",
		]);
		assert.deepEqual(runIssues(report), [14]);
		assert.equal(report.active, 1);
		assert.deepEqual(report.queued, [16]);
	});

	it("releases a closed issue's running marker at max_attempts: 1 instead of failing it", async () => {
		const { github, clock, executor, logs, start } = world();

		setWorkflow(github, "max_attempts: 3", "max_attempts: 1");

		const issue = github.add(labeled(14));

		executor.fallback = { kind: "hang" };
		await start().tick();
		issue.state = "closed";
		issue.updatedAt = "2026-10-29T02:00:20Z";
		clock.t += 30_000;

		const report = await start().tick();

		assert.deepEqual(report.runs, []);
		assert.equal(report.totals.failures, 0);
		assert.deepEqual(statuses(github, 14), [
			"1:claimed",
			"2:running",
			"3:released",
		]);
		assert.deepEqual(
			logs.flatMap((entry) =>
				entry.event === "claim_released" ? [entry.fields.why] : [],
			),
			["closed"],
		);
	});

	it("releases a replaced running marker at max_attempts: 1 and starts the new event", async () => {
		const { github, clock, executor, start } = world();

		setWorkflow(github, "max_attempts: 3", "max_attempts: 1");

		const issue = github.add(labeled(14));

		executor.fallback = { kind: "hang" };
		await start().tick();

		const next = relabel(github, issue);

		clock.t += 40 * 60_000;

		const report = await start().tick();

		assert.equal(report.runs[0]?.runId, next);
		assert.equal(report.totals.failures, 0);
		assert.deepEqual(statuses(github, 14), [
			"1:claimed",
			"2:running",
			"3:released",
			"4:claimed",
			"5:running",
		]);
	});
});

describe("Orchestrator attempt limit at retry launch", () => {
	it("ends a due retry as failed without launching it when the reloaded max_attempts is below its attempt", async () => {
		const { github, clock, executor, start } = world();

		github.add(labeled(14));
		executor.behaviors = [{ kind: "fail", usage: 0 }];

		const controller = start();

		await controller.tick();
		clock.t += 1;

		const queued = await controller.tick();

		assert.equal(queued.runs[0]?.status, "retrying");
		assert.equal(queued.runs[0]?.attempt, 2);

		setWorkflow(github, "max_attempts: 3", "max_attempts: 1");
		clock.t += 30_000;

		const report = await controller.tick();

		assert.equal(executor.launches.length, 1);
		assert.deepEqual(report.runs, []);
		assert.equal(report.totals.failures, 1);
		assert.deepEqual(statuses(github, 14), [
			"1:claimed",
			"2:running",
			"3:retrying",
			"4:failed",
		]);
	});
});

describe("Orchestrator cap and claimed runs", () => {
	it("starts a claimed run's first stage after the cap is lowered, without adding a slot holder", async () => {
		const { github, clock, files, executor, start } = world();

		github.add(labeled(14));
		github.add(labeled(15));

		const ensure = files.ensureWorkspace;

		files.ensureWorkspace = async () => "unavailable";

		const controller = start();
		const waiting = await controller.tick();

		assert.equal(executor.launches.length, 0);
		assert.equal(waiting.active, 2);
		assert.deepEqual(statuses(github, 14), ["1:claimed"]);

		capAt(github, 1);
		files.ensureWorkspace = ensure;
		clock.t += 30_000;

		const report = await controller.tick();

		assert.equal(report.maxConcurrent, 1);
		assert.equal(report.active, 2);
		assert.equal(executor.launches.length, 2);
		assert.deepEqual(
			report.runs.map((run) => [run.issue, run.status]),
			[
				[14, "blocked"],
				[15, "blocked"],
			],
		);
	});
});
