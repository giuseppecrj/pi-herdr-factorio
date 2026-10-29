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
} from "../server/controller.ts";
import type {
	AdmissionStore,
	AdmittedReceipt,
	LocalSwitch,
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
	type StageResult,
	type TickReport,
} from "../src/orchestrator.ts";
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
		async removeClaim(runId) {
			claims.delete(runId);
		},
	};
}

type Behavior =
	| { readonly kind: "unavailable" }
	| { readonly kind: "hang" }
	| { readonly kind: "fail"; readonly usage: number };

class FakeExecutor implements StageExecutor {
	behaviors: Behavior[] = [];
	fallback: Behavior = { kind: "unavailable" };
	readonly launches: {
		runId: Digest;
		signal: AbortSignal;
		progress: () => void;
	}[] = [];

	async launch(input: {
		runId: Digest;
		stage: string;
		signal: AbortSignal;
		progress: () => void;
	}): Promise<StageLaunch> {
		const behavior = this.behaviors.shift() ?? this.fallback;

		this.launches.push(input);

		if (behavior.kind === "unavailable") {
			return {
				kind: "unavailable",
				stage: "specify",
				reason: "stage_runner_not_installed",
			};
		}

		const done: Promise<StageResult> =
			behavior.kind === "hang"
				? new Promise(() => undefined)
				: Promise.resolve({ kind: "failed", usage: behavior.usage });

		return { kind: "started", done };
	}
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
		assert.equal(files.claims.size, 0);
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
		assert.equal(files.claims.size, 0);
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
		assert.equal(statuses(github, 14).at(-1)?.endsWith(":failed"), true);
		assert.equal(files.claims.size, 0);
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
		launch.progress();
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

describe("checkIdentity", () => {
	it("accepts only the integration bot", async () => {
		const { github, start } = world();
		const { adapter } = start();

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
			executor: new FakeExecutor(),
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

		assert.equal(await files.workspaceState(runId), "missing");
		assert.equal(await files.ensureWorkspace(runId), "created");
		assert.equal(await files.ensureWorkspace(runId), "present");
		assert.ok(
			await files.writeClaim({ runId, issue: 14, eventId: "5", seq: null }),
		);
		assert.deepEqual(await files.listClaims(), [
			{ runId, issue: 14, eventId: "5", seq: null },
		]);

		writeFileSync(join(state, "claims", "junk.json"), "{}");
		assert.equal((await files.listClaims()).length, 1);

		await files.removeClaim(runId);
		assert.deepEqual(await files.listClaims(), []);
	});

	it("loads a claim record written without a seq as unconfirmed", async () => {
		const state = stateDir();
		const files = fileRunFiles(state);
		const runId = runOf(14);

		assert.ok(
			await files.writeClaim({ runId, issue: 14, eventId: "5", seq: 3 }),
		);
		assert.deepEqual(await files.listClaims(), [
			{ runId, issue: 14, eventId: "5", seq: 3 },
		]);

		writeFileSync(
			join(state, "claims", `${runId}.json`),
			`${JSON.stringify({ runId, issue: 14, eventId: "5" })}\n`,
		);
		assert.deepEqual(await files.listClaims(), [
			{ runId, issue: 14, eventId: "5", seq: null },
		]);

		writeFileSync(
			join(state, "claims", `${runId}.json`),
			`${JSON.stringify({ runId, issue: 14, eventId: "5", seq: 0 })}\n`,
		);
		assert.deepEqual(await files.listClaims(), []);
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

describe("Orchestrator acknowledged marker floor", () => {
	it("defers an issue whose comments read after its release lags, then claims the new event", async () => {
		const ctx = world();
		const { github, executor, start } = ctx;
		const issue = github.add(labeled(14));
		const controller = start();

		await controller.tick();

		const next = relabel(github, issue);

		lagComments(ctx, issue, 1);

		const lagging = await controller.tick();

		assert.deepEqual(statuses(github, 14), [
			"1:claimed",
			"2:blocked",
			"3:released",
		]);
		assert.deepEqual(lagging.runs, []);
		assert.deepEqual(lagging.corrupt, []);
		assert.equal(executor.launches.length, 1);

		const resumed = await controller.tick();

		assert.deepEqual(statuses(github, 14), [
			"1:claimed",
			"2:blocked",
			"3:released",
			"4:claimed",
			"5:blocked",
		]);
		assert.deepEqual(
			resumed.runs.map((run) => [run.runId, run.status, run.seq]),
			[[next, "blocked", 5]],
		);
		assert.deepEqual(resumed.corrupt, []);
		assert.equal(executor.launches.length, 2);
	});

	it("reports marker_missing when the comments read stays behind the release on the next tick", async () => {
		const ctx = world();
		const { github, executor, logs, start } = ctx;
		const issue = github.add(labeled(14));
		const controller = start();

		await controller.tick();
		relabel(github, issue);
		lagComments(ctx, issue, 2);
		await controller.tick();

		const missing = await controller.tick();

		assert.deepEqual(missing.corrupt, [
			{ issue: 14, defect: "marker_missing" },
		]);
		assert.deepEqual(missing.runs, []);
		assert.deepEqual(statuses(github, 14), [
			"1:claimed",
			"2:blocked",
			"3:released",
		]);
		assert.equal(executor.launches.length, 1);
		assert.deepEqual(
			logs.flatMap((entry) =>
				entry.event === "ledger_stale" ? [entry.fields] : [],
			),
			[{ issue: 14, seq: 2, floor: 3 }],
		);
	});

	it("reports marker_missing when a live controller's bot comments are deleted", async () => {
		const { github, clock, executor, start } = world();
		const issue = github.add(labeled(14));
		const controller = start();

		await controller.tick();
		clock.t += 30_000;
		await controller.tick();
		issue.comments.length = 0;
		issue.updatedAt = "2026-10-29T03:00:00Z";
		clock.t += 30_000;

		const deferred = await controller.tick();

		assert.deepEqual(deferred.corrupt, []);
		assert.equal(deferred.runs[0]?.status, "blocked");

		clock.t += 30_000;

		const missing = await controller.tick();

		assert.deepEqual(missing.corrupt, [
			{ issue: 14, defect: "marker_missing" },
		]);
		assert.deepEqual(missing.runs, []);
		assert.equal(github.markers(14).length, 0);
		assert.equal(executor.launches.length, 1);
	});

	it("reports marker_missing in the first tick after a restart when the claim record has a confirmed seq and the bot comments are gone", async () => {
		const { github, files, executor, logs, start } = world();
		const issue = github.add(labeled(14));

		await start().tick();
		issue.comments.length = 0;
		issue.updatedAt = "2026-10-29T03:00:00Z";

		const missing = await start().tick();

		assert.deepEqual(missing.corrupt, [
			{ issue: 14, defect: "marker_missing" },
		]);
		assert.deepEqual(missing.runs, []);
		assert.equal(github.markers(14).length, 0);
		assert.equal(executor.launches.length, 1);
		assert.ok(!events(logs).includes("ledger_stale"));
		assert.deepEqual(
			[...files.claims.values()].map((claim) => claim.seq),
			[2],
		);
	});

	it("records each confirmed seq in the claim record and upgrades a record without one on adoption", async () => {
		const { github, files, start } = world();

		github.add(labeled(14));
		await start().tick();

		assert.deepEqual(
			[...files.claims.values()],
			[{ runId: runOf(14), issue: 14, eventId: String(EVENT_ID + 14), seq: 2 }],
		);

		files.claims.set(runOf(14), {
			runId: runOf(14),
			issue: 14,
			eventId: String(EVENT_ID + 14),
			seq: null,
		});

		await start().tick();

		assert.deepEqual(statuses(github, 14), ["1:claimed", "2:blocked"]);
		assert.equal(files.claims.get(runOf(14))?.seq, 2);
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
		});
		issue.comments.length = 0;
		issue.updatedAt = "2026-10-29T03:00:00Z";

		const report = await start().tick();

		assert.deepEqual(report.corrupt, []);
		assert.equal(report.runs[0]?.runId, runOf(14));
		assert.deepEqual(statuses(github, 14), ["1:claimed", "2:blocked"]);
	});
});

describe("Orchestrator deferred ledger publication", () => {
	it("posts no marker for a stage that stalls while its issue is deferred, then reports marker_missing", async () => {
		const { github, clock, executor, start } = world();
		const issue = github.add(labeled(14));

		executor.behaviors = [{ kind: "hang" }];

		const controller = start();

		await controller.tick();
		issue.comments.length = 0;
		issue.updatedAt = "2026-10-29T02:00:01Z";
		clock.t += 30_000;

		const deferred = await controller.tick();

		assert.equal(deferred.runs[0]?.status, "running");
		assert.deepEqual(deferred.corrupt, []);
		clock.t += 300_001;
		github.now = "2026-10-29T02:05:30Z";

		const missing = await controller.tick();

		assert.equal(executor.launches[0]?.signal.aborted, true);
		assert.deepEqual(missing.corrupt, [
			{ issue: 14, defect: "marker_missing" },
		]);
		assert.deepEqual(missing.runs, []);
		assert.equal(github.markers(14).length, 0);
		assert.equal(executor.launches.length, 1);
	});

	it("reads the ledger before it releases for a new ready event, so deleted markers end as marker_missing with no POST or launch", async () => {
		const { github, clock, executor, start } = world();
		const issue = github.add(labeled(14));
		const controller = start();

		await controller.tick();
		clock.t += 30_000;
		await controller.tick();
		issue.comments.length = 0;
		relabel(github, issue);
		clock.t += 32 * 60_000;

		const deferred = await controller.tick();

		assert.deepEqual(deferred.corrupt, []);
		assert.equal(deferred.runs[0]?.status, "blocked");

		const missing = await controller.tick();

		assert.deepEqual(missing.corrupt, [
			{ issue: 14, defect: "marker_missing" },
		]);
		assert.deepEqual(missing.runs, []);

		const later = await controller.tick();

		assert.deepEqual(later.runs, []);
		assert.equal(github.markers(14).length, 0);
		assert.equal(executor.launches.length, 1);
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
