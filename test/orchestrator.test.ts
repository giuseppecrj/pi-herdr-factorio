import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import {
	chmodSync,
	existsSync,
	mkdtempSync,
	readFileSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, it } from "node:test";
import { EXIT, runCli } from "../server/cli.ts";
import {
	acquireLock,
	fileRunFiles,
	HOLDER_FILE,
	type ProcessTable,
	parseStartTime,
	serveLoop,
} from "../server/controller.ts";
import { GitHubTicketAdapter } from "../src/adapters/github.ts";
import {
	type AdmissionStore,
	type AdmittedReceipt,
	admitTicket,
	type LocalSwitch,
} from "../src/admission.ts";
import type { Exec } from "../src/gh.ts";
import { formatMarker, parseMarker } from "../src/markers.ts";
import {
	backoffMs,
	type ClaimRecord,
	checkIdentity,
	type LogFields,
	Orchestrator,
	type RunFiles,
	type StageExecutor,
	type StageLaunch,
	type StageLaunchInput,
	type StageResult,
	type TickReport,
} from "../src/orchestrator.ts";
import { type SessionOutcome, stageResult } from "../server/sandbox/result.ts";
import { READY_LABEL } from "../src/policy.ts";
import { type Digest, digestOf, runIdOf } from "../src/run.ts";
import {
	type GitSha,
	isGitSha,
	isRepoSlug,
	type RepoSlug,
} from "../src/workflow.ts";
import {
	FAKE_REPO,
	FakeGitHub,
	type FakeIssue,
	fakeIssue,
	labelEvent,
	networkError,
	renamedEvent,
} from "./fake-ticket-adapter.ts";

function slug(text: string): RepoSlug {
	if (!isRepoSlug(text)) throw new Error(`bad slug ${text}`);

	return text;
}

function sha(text: string): GitSha {
	if (!isGitSha(text)) throw new Error(`bad sha ${text}`);

	return text;
}

const repo = slug(FAKE_REPO);
const START = Date.parse("2026-10-29T02:00:00Z");

class FakeClock {
	t = START;

	now(): number {
		return this.t;
	}
}

function memoryStore(): AdmissionStore & {
	records: Map<string, AdmittedReceipt>;
	local: LocalSwitch;
} {
	const records = new Map<string, AdmittedReceipt>();
	const local: LocalSwitch = "enabled";

	const store = {
		records,
		local,
		async localSwitch() {
			return store.local;
		},
		async record(receipt: AdmittedReceipt) {
			const key = `${receipt.issue}/${receipt.eventId}`;

			if (records.has(key)) return "duplicate" as const;
			records.set(key, receipt);

			return "recorded" as const;
		},
		async read(key: { issue: number; eventId: string }) {
			const receipt = records.get(`${key.issue}/${key.eventId}`);

			return receipt === undefined
				? { kind: "absent" as const }
				: { kind: "found" as const, receipt };
		},
		async listEvents(key: { issue: number }) {
			return [...records.values()].flatMap((receipt) =>
				receipt.issue === key.issue ? [receipt.eventId] : [],
			);
		},
	};

	return store;
}

function memoryFiles(): RunFiles & {
	claims: Map<string, ClaimRecord>;
	workspaces: Set<string>;
} {
	const claims = new Map<string, ClaimRecord>();
	const workspaces = new Set<string>();

	return {
		claims,
		workspaces,
		workspacePath: (runId) => `/state/workspaces/${runId}`,
		async workspaceState(runId) {
			return workspaces.has(runId) ? "present" : "missing";
		},
		async ensureWorkspace(runId) {
			if (workspaces.has(runId)) return "present";
			workspaces.add(runId);

			return "created";
		},
		async listClaims() {
			return [...claims.values()];
		},
		async writeClaim(claim) {
			claims.set(claim.runId, claim);

			return true;
		},
	};
}

type Behavior =
	| { readonly kind: "unavailable" }
	| { readonly kind: "hang" }
	| { readonly kind: "fail"; readonly usage: number }
	| { readonly kind: "pass"; readonly usage: number }
	| { readonly kind: "refuse"; readonly usage: number }
	| { readonly kind: "budget"; readonly usage: number }
	| { readonly kind: "later"; readonly result: Promise<StageResult> };

function resultOf(
	input: StageLaunchInput,
	outcome: SessionOutcome,
	usage: number,
): StageResult {
	return stageResult({
		version: 1,
		runId: input.runId,
		stage: input.stage,
		attempt: input.attempt,
		outcome,
		settlement: { event: "agent_settled", aborted: false },
		models: { requested: input.settings.model, observed: null },
		fallback: null,
		refusal: null,
		wallMs: 1,
		turns: 1,
		usage: {
			total: usage,
			parent: usage,
			children: 0,
			byModel: {},
			gateway: usage,
			unreadChildren: 0,
		},
		egress: null,
		stderr: [],
		assetsDigest: "a".repeat(64),
		versions: { pi: "1.4.0", piHerdrAgents: "3.3.1", piHerdrPstack: "0.5.0" },
		pricing: "unavailable",
	});
}

class FakeExecutor implements StageExecutor {
	behaviors: Behavior[] = [];
	fallback: Behavior = { kind: "unavailable" };
	readonly launches: StageLaunchInput[] = [];
	readonly spentBy = new Map<string, number>();
	recovered = 0;
	ready: boolean | null = null;
	stopped = true;

	async recover(): Promise<void> {
		this.recovered++;
	}

	async reconciled(): Promise<boolean> {
		return this.stopped;
	}

	async spent(input: {
		runId: string;
		stage: string;
		attempt: number;
	}): Promise<number | null> {
		return this.spentBy.get(`${input.stage}-${input.attempt}`) ?? null;
	}

	async preflight(): Promise<boolean> {
		return (
			this.ready ?? (this.behaviors[0] ?? this.fallback).kind !== "unavailable"
		);
	}

	async launch(input: StageLaunchInput): Promise<StageLaunch> {
		const behavior = this.behaviors.shift() ?? this.fallback;

		this.launches.push(input);

		switch (behavior.kind) {
			case "unavailable":
				return {
					kind: "unavailable",
					stage: "specify",
					reason: "sandbox_unavailable",
				};
			case "hang":
				return { kind: "started", done: new Promise(() => undefined) };
			case "later":
				return { kind: "started", done: behavior.result };
			case "fail":
				return started(
					resultOf(input, { kind: "failed", exit: "error" }, behavior.usage),
				);
			case "pass":
				return started(resultOf(input, { kind: "passed" }, behavior.usage));
			case "refuse":
				return started(resultOf(input, { kind: "refused" }, behavior.usage));
			case "budget":
				return started(
					resultOf(
						input,
						{ kind: "budget_exhausted", cap: "tokens" },
						behavior.usage,
					),
				);
			default: {
				const _exhaustive: never = behavior;

				return _exhaustive;
			}
		}
	}
}

function started(result: StageResult): StageLaunch {
	return { kind: "started", done: Promise.resolve(result) };
}

const EVENT_ID = 34537521383;

function labeled(number: number, change: Partial<FakeIssue> = {}): FakeIssue {
	return fakeIssue(number, {
		timeline: [
			labelEvent({
				id: EVENT_ID + number,
				at: "2026-10-29T01:21:37Z",
				actor: "giuseppecrj",
			}),
		],
		...change,
	});
}

function runOf(issue: number): Digest {
	return runIdOf({ repo, issue, eventId: String(EVENT_ID + issue) });
}

type Wire = { intercept: Exec | null };

function world(scope: readonly number[] | null = null) {
	const github = new FakeGitHub();
	const clock = new FakeClock();
	const store = memoryStore();
	const files = memoryFiles();
	const executor = new FakeExecutor();
	const logs: { event: string; fields: LogFields }[] = [];
	const wire: Wire = { intercept: null };

	const start = () =>
		new Orchestrator({
			exec: (command, args) => (wire.intercept ?? github.exec)(command, args),
			env: () => "/home/exedev",
			repo,
			store,
			files,
			executor,
			clock,
			scope,
			log: (event, fields) => logs.push({ event, fields }),
		});

	return { github, clock, store, files, executor, logs, wire, start };
}

function statuses(github: FakeGitHub, issue: number): string[] {
	return github.markers(issue).map((body) => {
		const parsed = parseMarker(body);

		return parsed.kind === "marker"
			? `${parsed.marker.seq}:${parsed.marker.status}`
			: parsed.kind;
	});
}

function runIssues(report: TickReport): number[] {
	return report.runs.map((run) => run.issue);
}

function events(logs: { event: string }[]): string[] {
	return logs.map((entry) => entry.event);
}

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

	it("gives a replay of a claimed attempt only what that attempt's earlier execution left of the run cap", async () => {
		const ctx = world();
		const { github, executor, start } = ctx;

		await stopAfterUnmarkedSpend(ctx, 499_900);

		executor.behaviors = [{ kind: "pass", usage: 200 }];

		const second = start();

		await second.tick();
		assert.equal(executor.launches[1]?.attempt, 1);
		assert.equal(executor.launches[1]?.remainingRunTokens, 100);

		executor.spentBy.set("specify-1", 500_100);

		const ended = await second.tick();

		assert.deepEqual(statuses(github, 14), [
			"1:claimed",
			"2:running",
			"3:stage_passed",
		]);
		assert.equal(usageOf(github, 14).at(-1), 500_100);
		assert.equal(ended.totals.usage, 500_100);
	});

	it("counts a replayed attempt's executions once when the replay is interrupted too", async () => {
		const ctx = world();
		const { github, executor, start } = ctx;

		await stopAfterUnmarkedSpend(ctx, 300);

		executor.behaviors = [{ kind: "hang" }];
		await start().tick();
		assert.equal(executor.launches[1]?.remainingRunTokens, 499_700);
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
			assert.equal(executor.launches.at(-1)?.remainingRunTokens, 499_700);

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
			assert.equal(executor.launches.at(-1)?.remainingRunTokens, 499_700);
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
		executor.behaviors = [{ kind: "fail", usage: 500_000 }];

		const controller = start();

		await controller.tick();

		const report = await controller.tick();

		assert.deepEqual(report.runs, []);
		assert.equal(report.totals.usage, 500_000);
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

describe("Orchestrator stage results", () => {
	it("ends a passing stage as stage_passed, frees its slot and keeps its usage", async () => {
		const { github, executor, files, start } = world();

		github.add(labeled(14));
		executor.behaviors = [{ kind: "pass", usage: 812 }];

		const controller = start();
		const first = await controller.tick();

		assert.equal(first.executionEnabled, true);

		const launch = executor.launches[0];

		assert.ok(launch);
		assert.equal(launch.stage, "specify");
		assert.equal(launch.attempt, 1);
		assert.equal(launch.remainingRunTokens, 500_000);
		assert.deepEqual(launch.settings, {
			model: "openai/gpt-6.1-sol",
			fallback: null,
			budget: { maxTurns: 20, wallMs: 900_000, stallMs: 300_000 },
			maxTokens: null,
		});

		const report = await controller.tick();

		assert.deepEqual(report.runs, []);
		assert.equal(report.active, 0);
		assert.equal(report.totals.usage, 812);
		assert.equal(report.totals.failures, 0);
		assert.deepEqual(statuses(github, 14), [
			"1:claimed",
			"2:running",
			"3:stage_passed",
		]);
		assert.deepEqual(
			[...files.claims.values()],
			[endedClaim(14, 3, { status: "stage_passed", usage: 812 })],
		);
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
		assert.equal(executor.launches[1]?.remainingRunTokens, 380_000);
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

		const report = await controller.drain(async () => {
			waits++;
			finish(resultOf(launch, { kind: "passed" }, 77));
		});

		assert.ok(waits >= 1);
		assert.ok(report);
		assert.deepEqual(report.runs, []);
		assert.equal(report.totals.usage, 77);
		assert.deepEqual(statuses(github, 14), [
			"1:claimed",
			"2:running",
			"3:stage_passed",
		]);
		assert.equal(await controller.drain(async () => undefined), null);
	});
});

describe("checkIdentity", () => {
	it("accepts only the integration bot", async () => {
		const { github } = world();
		const adapter = new GitHubTicketAdapter({ exec: github.exec, repo });

		assert.deepEqual(await checkIdentity(adapter), { kind: "ok" });

		github.viewer = "giuseppecrj";
		assert.deepEqual(await checkIdentity(adapter), { kind: "mismatch" });
	});
});

describe("parseStartTime", () => {
	it("reads field 22 after a command name with spaces and parentheses", () => {
		const stat =
			"4242 (node (x) y) S 1 4242 4242 0 -1 4194560 100 0 0 0 1 2 0 0 20 0 11 0 987654 1000 10";

		assert.equal(parseStartTime(stat), "987654");
		assert.equal(parseStartTime("garbage"), null);
	});
});

const dirs: string[] = [];

afterEach(() => {
	for (const dir of dirs.splice(0))
		rmSync(dir, { recursive: true, force: true });
});

function stateDir(): string {
	const dir = mkdtempSync(join(tmpdir(), "factory-controller-"));

	dirs.push(dir);

	return dir;
}

function table(pid: number, startTime = "1"): ProcessTable {
	return { self: { pid, startTime } };
}

const STALE_HOLDER = JSON.stringify({
	pid: 5000,
	startTime: "7",
	acquiredAt: "2026-10-29T01:00:00.000Z",
});

async function holdLock(state: string, pid = 5000) {
	const held = await acquireLock({
		stateDir: state,
		procs: table(pid, "7"),
		now: () => START,
	});

	assert.equal(held.kind, "acquired");

	return held;
}

async function cli(
	argv: readonly string[],
	github: FakeGitHub,
	signal = new AbortController(),
	executor = new FakeExecutor(),
) {
	let stdout = "";
	let stderr = "";

	const code = await runCli(argv, {
		exec: github.exec,
		env: () => "/home/exedev",
		stdout: (text) => {
			stdout += text;
		},
		stderr: (text) => {
			stderr += text;
		},
		runtime: {
			clock: new FakeClock(),
			procs: table(4242, "100"),
			sleep: async () => {
				signal.abort();
			},
			signal: signal.signal,
			executor: () => executor,
		},
	});

	return { code, stdout, stderr };
}

describe("server/cli.ts controller commands", () => {
	const base = ["--repo", repo];

	it("tick --once prints the claim snapshot, writes status and releases the lock", async () => {
		const github = new FakeGitHub();
		const state = stateDir();

		github.add(labeled(14));

		const run = await cli(
			["tick", "--once", "--json", ...base, "--state-dir", state],
			github,
		);

		assert.equal(run.code, EXIT.ok, run.stderr);
		assert.equal(JSON.parse(run.stdout).runs[0].status, "blocked");
		assert.equal(existsSync(join(state, HOLDER_FILE)), false);
		assert.equal(
			JSON.parse(readFileSync(join(state, "status.json"), "utf8")).runs.length,
			1,
		);
		assert.ok(existsSync(join(state, "workspaces", runOf(14))));
		assert.match(run.stderr, /event=claim_taken issue=14/);
	});

	it("tick --once waits for the stage it launched and prints its end", async () => {
		const github = new FakeGitHub();
		const state = stateDir();
		const executor = new FakeExecutor();

		github.add(labeled(14));
		executor.behaviors = [{ kind: "pass", usage: 9 }];

		const run = await cli(
			["tick", "--once", "--json", ...base, "--state-dir", state],
			github,
			new AbortController(),
			executor,
		);

		assert.equal(run.code, EXIT.ok, run.stderr);

		const report = JSON.parse(run.stdout);

		assert.equal(report.executionEnabled, true);
		assert.deepEqual(report.runs, []);
		assert.equal(report.totals.usage, 9);
		assert.equal(executor.recovered, 1);
		assert.deepEqual(statuses(github, 14), [
			"1:claimed",
			"2:running",
			"3:stage_passed",
		]);
		assert.equal(
			JSON.parse(readFileSync(join(state, "status.json"), "utf8")).runs.length,
			0,
		);
	});

	it("run --issue uses the same admission and exits 1 when nothing runs", async () => {
		const github = new FakeGitHub();
		const state = stateDir();

		github.add(labeled(14));
		github.repoLabels = [];

		const off = await cli(
			["run", "--json", ...base, "--issue", "14", "--state-dir", state],
			github,
		);

		assert.equal(off.code, EXIT.invalid);
		assert.deepEqual(JSON.parse(off.stdout).dispatch.reasons, [
			"repo_switch_off",
		]);
		assert.deepEqual(statuses(github, 14), []);

		github.repoLabels = ["factory:enabled"];

		const on = await cli(
			["run", "--json", ...base, "--issue", "14", "--state-dir", state],
			github,
		);

		assert.equal(on.code, EXIT.ok, on.stderr);
		assert.deepEqual(statuses(github, 14), ["1:claimed", "2:blocked"]);
	});

	it("refuses a second controller before any gh call", async () => {
		const github = new FakeGitHub();
		const state = stateDir();
		const held = await holdLock(state);

		const run = await cli(
			["tick", "--once", "--json", ...base, "--state-dir", state],
			github,
		);

		assert.ok(existsSync(join(state, HOLDER_FILE)));

		rmSync(join(state, HOLDER_FILE));

		const unnamed = await cli(
			["run", "--json", ...base, "--issue", "14", "--state-dir", state],
			github,
		);

		if (held.kind === "acquired") await held.lock.release();

		assert.equal(run.code, EXIT.usage);
		assert.deepEqual(JSON.parse(run.stdout), {
			error: "controller_running",
			pid: 5000,
		});
		assert.match(run.stderr, /event=controller_running pid=5000/);
		assert.equal(unnamed.code, EXIT.usage);
		assert.deepEqual(JSON.parse(unnamed.stdout), {
			error: "controller_running",
			pid: null,
		});
		assert.equal(github.calls.length, 0);
	});

	it("reports and replaces a lock file left by a controller that is gone", async () => {
		const github = new FakeGitHub();
		const state = stateDir();

		writeFileSync(join(state, HOLDER_FILE), STALE_HOLDER);

		const run = await cli(
			["tick", "--once", "--json", ...base, "--state-dir", state],
			github,
		);

		assert.equal(run.code, EXIT.ok, run.stderr);
		assert.match(run.stderr, /event=lock_stale_replaced pid=5000/);
		assert.equal(existsSync(join(state, HOLDER_FILE)), false);
	});

	it("refuses to start as any identity but the integration bot", async () => {
		const github = new FakeGitHub();
		const state = stateDir();

		github.add(labeled(14));
		github.viewer = "giuseppecrj";

		const run = await cli(
			["tick", "--once", "--json", ...base, "--state-dir", state],
			github,
		);

		assert.equal(run.code, EXIT.invalid);
		assert.match(
			run.stderr,
			/event=controller_refused reason=identity_mismatch/,
		);
		assert.equal(existsSync(join(state, HOLDER_FILE)), false);
		assert.deepEqual(statuses(github, 14), []);
	});

	it("serve logs controller_ready, finishes the tick on stop and releases the lock", async () => {
		const github = new FakeGitHub();
		const state = stateDir();

		github.add(labeled(14));

		const run = await cli(
			["serve", ...base, "--state-dir", state, "--issue", "14"],
			github,
		);

		assert.equal(run.code, EXIT.ok, run.stderr);
		assert.match(
			run.stderr,
			/event=controller_ready pid=4242 repo=giuseppecrj\/pi-herdr-factorio scope=14/,
		);
		assert.match(run.stderr, /event=controller_stopping/);
		assert.equal(run.stdout, "");
		assert.equal(existsSync(join(state, HOLDER_FILE)), false);
		assert.ok(existsSync(join(state, "status.json")));
	});

	it("status --json reports the lock holder and the last tick without taking the lock", async () => {
		const github = new FakeGitHub();
		const state = stateDir();

		github.add(labeled(14));
		await cli(
			["tick", "--once", "--json", ...base, "--state-dir", state],
			github,
		);

		const status = async () => {
			const run = await cli(
				["status", "--json", ...base, "--state-dir", state],
				github,
			);

			assert.equal(run.code, EXIT.ok);

			return JSON.parse(run.stdout);
		};

		const held = await holdLock(state);
		const running = await status();

		const second = await acquireLock({
			stateDir: state,
			procs: table(6001),
			now: () => START,
		});

		if (held.kind === "acquired") await held.lock.release();

		const stopped = await status();

		writeFileSync(join(state, HOLDER_FILE), STALE_HOLDER);

		const stale = await status();

		assert.equal(running.controller.state, "running");
		assert.equal(running.controller.pid, 5000);
		assert.equal(running.controller.lastTick.runs[0].issue, 14);
		assert.equal(running.executionEnabled, false);
		assert.equal(second.kind, "held");
		assert.deepEqual(
			[stopped.controller.state, stopped.controller.pid],
			["stopped", null],
		);
		assert.deepEqual(
			[stale.controller.state, stale.controller.pid],
			["stale_lock", 5000],
		);
	});

	it("rejects a state directory others can write", async () => {
		const github = new FakeGitHub();
		const state = stateDir();

		chmodSync(state, 0o777);

		const run = await cli(
			["tick", "--once", "--json", ...base, "--state-dir", state],
			github,
		);

		assert.equal(run.code, EXIT.invalid);
		assert.match(run.stderr, /reason=state_unavailable/);
		assert.equal(github.calls.length, 0);
	});

	for (const argv of [
		["serve", "--json", ...base, "--state-dir", "/tmp"],
		["tick", "--json", ...base, "--state-dir", "/tmp"],
		["run", "--json", ...base, "--state-dir", "/tmp"],
		[
			"run",
			"--json",
			...base,
			"--issue",
			"1",
			"--issue",
			"2",
			"--state-dir",
			"/tmp",
		],
		["tick", "--once", "--json", ...base],
		[
			"admit",
			"--once",
			"--json",
			...base,
			"--issue",
			"1",
			"--state-dir",
			"/tmp",
		],
		[
			"tick",
			"--once",
			"--json",
			...base,
			"--ref",
			"main",
			"--state-dir",
			"/tmp",
		],
	]) {
		it(`exits 2 on ${argv.join(" ")}`, async () => {
			const github = new FakeGitHub();
			const run = await cli(argv, github);

			assert.equal(run.code, EXIT.usage);
			assert.equal(github.calls.length, 0);
		});
	}
});

describe("fileRunFiles", () => {
	it("creates private workspaces and round-trips claim records", async () => {
		const state = stateDir();
		const files = fileRunFiles(state);
		const runId = runOf(14);

		const unconfirmed: ClaimRecord = {
			runId,
			issue: 14,
			eventId: "5",
			seq: null,
			status: null,
			stage: null,
			attempt: null,
			usage: null,
		};

		assert.equal(await files.workspaceState(runId), "missing");
		assert.equal(await files.ensureWorkspace(runId), "created");
		assert.equal(await files.ensureWorkspace(runId), "present");
		assert.ok(await files.writeClaim(unconfirmed));
		assert.deepEqual(await files.listClaims(), [unconfirmed]);

		writeFileSync(join(state, "claims", "junk.json"), "{}");
		assert.equal((await files.listClaims()).length, 1);
	});

	it("loads a record without a status as unknown, and rejects a partial or invalid one", async () => {
		const state = stateDir();
		const files = fileRunFiles(state);
		const runId = runOf(14);
		const path = join(state, "claims", `${runId}.json`);
		const confirmed = { ...blockedClaim(14, 3), eventId: "5" };

		assert.ok(await files.writeClaim(confirmed));
		assert.deepEqual(await files.listClaims(), [confirmed]);

		const load = async (record: Record<string, string | number | null>) => {
			writeFileSync(path, `${JSON.stringify(record)}\n`);

			return files.listClaims();
		};

		const base = { runId, issue: 14, eventId: "5" };
		const unknown = { status: null, stage: null, attempt: null, usage: null };
		const mirrored = { status: "blocked", stage: "specify", attempt: 1 };

		assert.deepEqual(await load({ ...base, seq: 3 }), [
			{ ...base, seq: 3, ...unknown },
		]);
		assert.deepEqual(await load({ ...base, seq: 3, ...mirrored }), [
			{ ...base, seq: 3, ...mirrored, usage: null },
		]);
		assert.deepEqual(
			await load({ ...base, seq: 3, ...mirrored, usage: 300_000 }),
			[{ ...base, seq: 3, ...mirrored, usage: 300_000 }],
		);
		assert.deepEqual(
			await load({
				...base,
				seq: 3,
				...mirrored,
				status: "released",
				usage: 0,
			}),
			[{ ...base, seq: 3, ...mirrored, status: "released", usage: 0 }],
		);
		assert.deepEqual(
			await load({ ...base, seq: 3, ...mirrored, usage: -1 }),
			[],
		);
		assert.deepEqual(
			await load({ ...base, seq: 3, ...mirrored, usage: 1.5 }),
			[],
		);
		assert.deepEqual(await load({ ...base, seq: 3, usage: 5 }), []);
		assert.deepEqual(await load({ ...base, seq: null, usage: 0 }), []);
		assert.deepEqual(await load(base), [{ ...base, seq: null, ...unknown }]);
		assert.deepEqual(await load({ ...base, seq: 0 }), []);
		assert.deepEqual(await load({ ...base, seq: 3, status: "blocked" }), []);
		assert.deepEqual(
			await load({
				...base,
				seq: 3,
				status: "paused",
				stage: "specify",
				attempt: 1,
			}),
			[],
		);
		assert.deepEqual(
			await load({
				...base,
				seq: null,
				status: "blocked",
				stage: "specify",
				attempt: 1,
			}),
			[],
		);
	});
});

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

function relabel(github: FakeGitHub, issue: FakeIssue): Digest {
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

	return runIdOf({ repo, issue: issue.number, eventId: "34537529999" });
}

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

function lagComments(
	ctx: { github: FakeGitHub; wire: Wire },
	issue: FakeIssue,
	reads: number,
): void {
	const visible = issue.comments.length;
	const path = `repos/${FAKE_REPO}/issues/${issue.number}/comments?`;
	let left = reads;

	ctx.wire.intercept = async (command, args) => {
		if (
			left === 0 ||
			issue.comments.length === visible ||
			!args.some((arg) => arg.startsWith(path))
		) {
			return ctx.github.exec(command, args);
		}

		left--;

		const later = issue.comments.splice(visible);

		try {
			return await ctx.github.exec(command, args);
		} finally {
			issue.comments.push(...later);
		}
	};
}

function hideMarker(
	ctx: { github: FakeGitHub; wire: Wire },
	issue: FakeIssue,
	seq: number,
) {
	const toggle = { hidden: true };
	const path = `repos/${FAKE_REPO}/issues/${issue.number}/comments?`;

	ctx.wire.intercept = async (command, args) => {
		if (!toggle.hidden || !args.some((arg) => arg.startsWith(path))) {
			return ctx.github.exec(command, args);
		}

		const saved = issue.comments.splice(0);

		issue.comments.push(
			...saved.filter((comment) => !comment.body.includes(`"seq":${seq},`)),
		);

		try {
			return await ctx.github.exec(command, args);
		} finally {
			issue.comments.splice(0, issue.comments.length, ...saved);
		}
	};

	return toggle;
}

function failClaimWrite(files: ReturnType<typeof memoryFiles>, seq: number) {
	const write = files.writeClaim;
	const control = { failing: true };

	files.writeClaim = async (claim) =>
		control.failing && claim.seq === seq ? false : write(claim);

	return control;
}

function bySeq(github: FakeGitHub, issue: number): string[] {
	return statuses(github, issue).sort(
		(left, right) => Number.parseInt(left, 10) - Number.parseInt(right, 10),
	);
}

function behindLogs(logs: { event: string; fields: LogFields }[]) {
	return logs.flatMap((entry) =>
		entry.event === "ledger_behind" ? [entry.fields] : [],
	);
}

function blockedClaim(issue: number, seq: number): ClaimRecord {
	return {
		runId: runOf(issue),
		issue,
		eventId: String(EVENT_ID + issue),
		seq,
		status: "blocked",
		stage: "specify",
		attempt: 1,
		usage: 0,
	};
}

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

function hideStatus(
	ctx: { github: FakeGitHub; wire: Wire },
	issue: FakeIssue,
	status: string,
) {
	const toggle = { hidden: true };
	const path = `repos/${FAKE_REPO}/issues/${issue.number}/comments?`;

	ctx.wire.intercept = async (command, args) => {
		if (!toggle.hidden || !args.some((arg) => arg.startsWith(path))) {
			return ctx.github.exec(command, args);
		}

		const saved = issue.comments.splice(0);

		issue.comments.push(
			...saved.filter(
				(comment) => !comment.body.includes(`"status":"${status}"`),
			),
		);

		try {
			return await ctx.github.exec(command, args);
		} finally {
			issue.comments.splice(0, issue.comments.length, ...saved);
		}
	};

	return toggle;
}

function endedClaim(
	issue: number,
	seq: number,
	change: Partial<ClaimRecord>,
): ClaimRecord {
	return { ...blockedClaim(issue, seq), ...change };
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
		executor.behaviors = [{ kind: "fail", usage: 500_000 }];

		const controller = start();
		const exhausted = ["1:claimed", "2:running", "3:budget_exhausted"];

		const record = endedClaim(14, 3, {
			status: "budget_exhausted",
			usage: 500_000,
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

function capAt(github: FakeGitHub, limit: number): void {
	github.workflow = (github.workflow ?? "").replace(
		/max_concurrent: \d/,
		`max_concurrent: ${limit}`,
	);
}

function setWorkflow(github: FakeGitHub, from: string, to: string): void {
	github.workflow = (github.workflow ?? "").replace(from, to);
}

function omitFromList(github: FakeGitHub, issue: number): Exec {
	return async (command, args) => {
		const path = args.find((arg) => arg.startsWith("repos/")) ?? "";
		const hidden = github.issues.get(issue);

		if (!path.includes("/issues?") || hidden === undefined) {
			return github.exec(command, args);
		}

		github.issues.delete(issue);

		try {
			return await github.exec(command, args);
		} finally {
			github.issues.set(issue, hidden);
		}
	};
}

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
			"max_tokens_per_run: 500000",
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

		ctx.executor.fallback = { kind: "fail", usage: 300_000 };

		const controller = start();

		await controller.tick();
		clock.t += 30_000;
		github.now = "2026-10-29T02:00:30Z";

		const failed = await controller.tick();

		assert.equal(failed.runs[0]?.usage, 300_000);
		assert.deepEqual(
			files.claims.get(runOf(14)),
			endedClaim(14, 3, { status: "retrying", attempt: 2, usage: 300_000 }),
		);

		const hidden = hideMarker(ctx, issue, 3);

		clock.t += 30_000;

		const restarted = start();
		const adopted = await restarted.tick();

		assert.deepEqual(
			adopted.runs.map((run) => [run.status, run.attempt, run.usage]),
			[["retrying", 2, 300_000]],
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

function lastMarkerUsage(github: FakeGitHub, issue: number): number | null {
	const body = github.markers(issue).at(-1) ?? "";
	const parsed = parseMarker(body);

	return parsed.kind === "marker" ? parsed.marker.usage : null;
}

function settle(): Promise<void> {
	return new Promise((done) => setImmediate(done));
}

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
			"max_tokens_per_run: 500000",
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

		assert.equal(executor.launches[1]?.remainingRunTokens, 499_750);

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
		assert.equal(executor.launches[1]?.remainingRunTokens, 499_960);
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
		launch.progress(500_000);
		clock.t += 300_001;
		await controller.tick();

		assert.equal(statuses(github, 14).at(-1), "2:running");

		launch.progress(600_000);
		finish(resultOf(launch, { kind: "failed", exit: "aborted" }, 600_000));
		await settle();

		const report = await controller.tick();

		assert.deepEqual(report.runs, []);
		assert.equal(report.totals.usage, 600_000);
		assert.equal(statuses(github, 14).at(-1), "3:budget_exhausted");
		assert.equal(lastMarkerUsage(github, 14), 600_000);
	});

	it("posts the terminal marker once the cleanup reserve and its grace pass, if the stage never settles", async () => {
		const { github, clock, executor, start } = world();

		github.add(labeled(14));
		executor.behaviors = [{ kind: "hang" }];

		const controller = start();

		await controller.tick();
		executor.launches[0]?.progress(500_000);
		clock.t += 300_001;
		await controller.tick();
		assert.equal(statuses(github, 14).at(-1), "2:running");

		clock.t += 15_000;

		const report = await controller.tick();

		assert.deepEqual(report.runs, []);
		assert.equal(statuses(github, 14).at(-1), "3:budget_exhausted");
	});
});

function claimUsage(files: ReturnType<typeof memoryFiles>, issue: number) {
	return [...files.claims.values()].find((claim) => claim.issue === issue)
		?.usage;
}

type Deferred = {
	readonly behavior: Behavior;
	readonly finish: (result: StageResult) => void;
};

function deferred(): Deferred {
	let finish: (result: StageResult) => void = () => undefined;

	const result = new Promise<StageResult>((done) => {
		finish = done;
	});

	return { behavior: { kind: "later", result }, finish };
}

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
		assert.equal(executor.launches[1]?.remainingRunTokens, 499_750);
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
		assert.equal(executor.launches[1]?.remainingRunTokens, 499_750);

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

		assert.equal(executor.launches[1]?.remainingRunTokens, 499_300);
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
		launch.progress(500_000);
		clock.t += 300_001;
		await controller.tick();
		clock.t += 10_000;
		await controller.tick();
		assert.equal(statuses(github, 14).at(-1), "2:running");

		launch.progress(600_000);
		stage.finish(
			resultOf(launch, { kind: "failed", exit: "aborted" }, 600_000),
		);
		await settle();

		const report = await controller.tick();

		assert.equal(report.totals.usage, 600_000);
		assert.equal(statuses(github, 14).at(-1), "3:budget_exhausted");
		assert.equal(lastMarkerUsage(github, 14), 600_000);
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

		assert.deepEqual(seen, [["1:claimed", "2:running", "3:stage_passed"]]);
		assert.deepEqual(report.runs, []);
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

type Unproved = {
	readonly name: string;
	readonly reason: string;
	readonly degrade: (issue: FakeIssue) => () => void;
};

const UNPROVED: readonly Unproved[] = [
	{
		name: "an empty timeline",
		reason: "no_label_event",
		degrade(issue) {
			const timeline = issue.timeline;

			issue.timeline = [];

			return () => {
				issue.timeline = timeline;
			};
		},
	},
	{
		name: "a timeline whose latest ready entry is an older removal",
		reason: "not_labeled",
		degrade(issue) {
			const timeline = issue.timeline;

			issue.timeline = [
				labelEvent({
					id: 1234,
					at: "2026-10-29T01:20:00Z",
					actor: "giuseppecrj",
					event: "unlabeled",
				}),
			];

			return () => {
				issue.timeline = timeline;
			};
		},
	},
	{
		name: "an edit count on a never-edited issue",
		reason: "ambiguous_snapshot",
		degrade(issue) {
			issue.totalVersions = 1;

			return () => {
				issue.totalVersions = null;
			};
		},
	},
];

function touches(call: readonly string[], issue: number): boolean {
	const path = `/issues/${issue}`;

	return call.some(
		(arg) =>
			arg.endsWith(path) ||
			arg.includes(`${path}/`) ||
			arg === `number=${issue}`,
	);
}

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

function staleList(github: FakeGitHub, issue: number): Exec {
	return async (command, args) => {
		const path = args.find((arg) => arg.startsWith("repos/")) ?? "";
		const stale = github.issues.get(issue);

		if (!path.includes("/issues?") || stale === undefined) {
			return github.exec(command, args);
		}

		const { state } = stale;

		stale.state = "open";

		try {
			return await github.exec(command, args);
		} finally {
			stale.state = state;
		}
	};
}

function issueReads(github: FakeGitHub, issue: number): number {
	const path = `repos/${FAKE_REPO}/issues/${issue}`;

	return github.calls.filter((call) => call.includes(path)).length;
}

function launched(logs: { event: string; fields: LogFields }[]): unknown[] {
	return logs.flatMap((entry) =>
		entry.event === "stage_launched" ? [entry.fields.issue] : [],
	);
}

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

type Refusal = {
	readonly expect: string;
	readonly settles: boolean;
	readonly degrade: (ctx: ReturnType<typeof world>, issue: FakeIssue) => void;
};

function failing(
	github: FakeGitHub,
	hit: (args: readonly string[]) => boolean,
): Exec {
	return async (command, args) =>
		hit(args) ? networkError() : github.exec(command, args);
}

const ISSUE_14 = `repos/${FAKE_REPO}/issues/14`;
const LABEL_AT = "2026-10-29T01:21:37Z";
const BODY_14 = "Body of fixture 14.";

function version(
	editedAt: string,
	diff: string | null,
	deletedAt: string | null = null,
) {
	return { editedAt, deletedAt, diff };
}

/** Each reachable refusal from a fresh candidate, with its exact detail. */
const REFUSALS: readonly Refusal[] = [
	{
		expect: "issue_closed",
		settles: true,
		degrade({ github, wire }, issue) {
			issue.state = "closed";
			wire.intercept = staleList(github, 14);
		},
	},
	{
		expect: "actor_withheld",
		settles: true,
		degrade(_, issue) {
			issue.timeline = [
				labelEvent({
					id: EVENT_ID + 14,
					at: LABEL_AT,
					actor: "evil; rm -rf /",
				}),
			];
		},
	},
	{
		expect: "unauthorized",
		settles: true,
		degrade(_, issue) {
			issue.timeline = [
				labelEvent({ id: EVENT_ID + 14, at: LABEL_AT, actor: "triager" }),
			];
		},
	},
	{
		expect: "ambiguous_snapshot:label_events_same_second",
		settles: true,
		degrade(_, issue) {
			issue.timeline = [
				labelEvent({ id: 5, at: LABEL_AT, actor: "giuseppecrj" }),
				labelEvent({ id: 6, at: LABEL_AT, actor: "giuseppecrj" }),
			];
		},
	},
	{
		expect: "ambiguous_snapshot:renamed_since_label",
		settles: true,
		degrade(_, issue) {
			issue.timeline = [
				...issue.timeline,
				renamedEvent("2026-10-29T01:30:00Z"),
			];
		},
	},
	{
		expect: "ambiguous_snapshot:edited_at_label_time",
		settles: true,
		degrade(_, issue) {
			issue.versions = [version(LABEL_AT, BODY_14)];
		},
	},
	{
		expect: "ambiguous_snapshot:version_withheld",
		settles: true,
		degrade(_, issue) {
			issue.includesCreatedEdit = true;
			issue.versions = [
				version("2026-10-29T01:00:00Z", null, "2026-10-29T01:10:00Z"),
			];
		},
	},
	{
		expect: "not_labeled",
		settles: false,
		degrade(_, issue) {
			issue.timeline = [
				labelEvent({
					id: 1234,
					at: "2026-10-29T01:20:00Z",
					actor: "giuseppecrj",
					event: "unlabeled",
				}),
			];
		},
	},
	{
		expect: "no_label_event",
		settles: false,
		degrade(_, issue) {
			issue.timeline = [];
		},
	},
	{
		expect: "issue_unavailable",
		settles: false,
		degrade({ github, wire }) {
			wire.intercept = failing(github, (args) => args.includes(ISSUE_14));
		},
	},
	{
		expect: "timeline_unavailable",
		settles: false,
		degrade({ github, wire }) {
			wire.intercept = failing(github, (args) =>
				args.some((arg) => arg.startsWith(`${ISSUE_14}/timeline`)),
			);
		},
	},
	{
		expect: "permission_unavailable",
		settles: false,
		degrade({ github, wire }) {
			wire.intercept = failing(github, (args) =>
				args.some((arg) => arg.startsWith(`repos/${FAKE_REPO}/collaborators/`)),
			);
		},
	},
	{
		expect: "snapshot_unavailable",
		settles: false,
		degrade({ github, wire }) {
			wire.intercept = failing(github, (args) => args.includes("number=14"));
		},
	},
	{
		expect: "state_unwritable",
		settles: false,
		degrade({ store }) {
			store.record = async () => "unwritable";
		},
	},
	{
		expect: "ambiguous_snapshot:rename_history_incomplete",
		settles: false,
		degrade(_, issue) {
			issue.totalRenames = 1;
		},
	},
	{
		expect: "ambiguous_snapshot:title_changed_between_reads",
		settles: false,
		degrade(_, issue) {
			issue.renames = [
				{
					createdAt: "2026-10-29T01:00:00Z",
					previousTitle: "Old",
					currentTitle: "Other",
				},
			];
		},
	},
	{
		expect: "ambiguous_snapshot:body_changed_between_reads",
		settles: false,
		degrade({ github }) {
			github.beforeGraphql = (read) => {
				read.body =
					read.body === BODY_14 ? "Changed after the issue read." : BODY_14;
			};
		},
	},
	{
		expect: "ambiguous_snapshot:history_contradicts_last_edit",
		settles: false,
		degrade(_, issue) {
			issue.totalVersions = 1;
		},
	},
	{
		expect: "ambiguous_snapshot:history_incomplete",
		settles: false,
		degrade(_, issue) {
			issue.lastEditedAt = "2026-10-29T01:40:00Z";
			issue.includesCreatedEdit = true;
			issue.totalVersions = 1;
		},
	},
	{
		expect: "ambiguous_snapshot:history_without_original",
		settles: false,
		degrade(_, issue) {
			issue.lastEditedAt = "2026-10-29T01:40:00Z";
			issue.versions = [version("2026-10-29T01:40:00Z", BODY_14)];
		},
	},
	{
		expect: "ambiguous_snapshot:history_disagrees_with_body",
		settles: false,
		degrade(_, issue) {
			issue.includesCreatedEdit = true;
			issue.versions = [version("2026-10-29T01:00:00Z", "Other body.")];
		},
	},
	{
		expect: "ambiguous_snapshot:no_version_before_label",
		settles: false,
		degrade(_, issue) {
			issue.lastEditedAt = "2026-10-29T01:40:00Z";
			issue.includesCreatedEdit = true;
			issue.versions = [version("2026-10-29T01:40:00Z", BODY_14)];
		},
	},
];

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
		const controller = new URL("../server/controller.ts", import.meta.url).href;

		const script = `
			const { acquireLock, procTable } = await import(${JSON.stringify(controller)});
			const result = await acquireLock({ stateDir: process.argv[1], procs: procTable(), now: Date.now });
			process.stdout.write(result.kind);
			if (result.kind === "acquired") {
				await new Promise((done) => setTimeout(done, 300));
				await result.lock.release();
			}
		`;

		const child = (state: string) =>
			new Promise<string>((done, fail) => {
				execFile(
					process.execPath,
					[
						"--experimental-strip-types",
						"--input-type=module",
						"-e",
						script,
						state,
					],
					(error, stdout) => (error === null ? done(stdout) : fail(error)),
				);
			});

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

			const kinds = await Promise.all([child(state), child(state)]);

			trials.push(kinds.sort().join("+"));
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
