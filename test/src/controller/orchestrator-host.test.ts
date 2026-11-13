import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import {
	chmodSync,
	existsSync,
	mkdirSync,
	readFileSync,
	readdirSync,
	rmSync,
	statSync,
	writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { describe, it } from "node:test";
import { EXIT } from "../../../host/cli/platform.ts";
import { acquireLock, parseStartTime } from "../../../host/controller/lock.ts";
import { readRunCharges } from "../../../host/controller/terminal.ts";
import { HOLDER_FILE } from "../../../host/controller/state.ts";
import { GitHubTicketAdapter } from "../../../src/github/adapter.ts";
import { admitTicket } from "../../../src/trust/admission.ts";
import {
	formatMarker,
	parseMarker,
	type RunStatus,
} from "../../../src/trust/markers.ts";
import {
	checkIdentity,
	type LogFields,
	Orchestrator,
} from "../../../src/controller/orchestrator.ts";
import type { StageResult } from "../../../src/controller/launch.ts";
import { type Digest, digestOf, runIdOf } from "../../../src/core/run.ts";
import {
	FakeGitHub,
	TRUSTED_RUN_CAP,
	TRUSTED_WORKFLOW,
} from "../../fake-ticket-adapter.ts";
import { EXE_DEV_PLATFORM } from "../../../src/trust/platform.ts";
import {
	repo,
	START,
	FakeClock,
	memoryStore,
	memoryFiles,
	resultOf,
	FakeExecutor,
	EVENT_ID,
	labeled,
	runOf,
	world,
	statuses,
	runIssues,
	events,
	stateDir,
	table,
	STALE_HOLDER,
	holdLock,
	cli,
	relabel,
	blockedClaim,
} from "./orchestrator-fixtures.ts";

describe("checkIdentity", () => {
	it("accepts only the integration bot", async () => {
		const { github } = world();
		const adapter = new GitHubTicketAdapter({ exec: github.exec, repo });

		assert.deepEqual(
			await checkIdentity(adapter, EXE_DEV_PLATFORM.controllerLogin),
			{ kind: "ok" },
		);

		github.viewer = "giuseppecrj";
		assert.deepEqual(
			await checkIdentity(adapter, EXE_DEV_PLATFORM.controllerLogin),
			{ kind: "mismatch" },
		);
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

describe("server/cli.ts controller commands", () => {
	const base = ["--repo", repo];

	describe("--verification-token-cap", () => {
		const tick = (state: string, ...extra: string[]) => [
			"tick",
			"--once",
			"--json",
			...base,
			"--state-dir",
			state,
			...extra,
		];

		const manifestOf = (state: string) =>
			JSON.parse(readFileSync(join(state, "verification.json"), "utf8"));

		it("requires --issue scope and a positive integer cap", async () => {
			for (const extra of [
				["--verification-token-cap", "1000"],
				["--issue", "14", "--verification-token-cap", "0"],
				["--issue", "14", "--verification-token-cap", "1e3"],
				["--issue", "14", "--verification-token-cap", "-5"],
			]) {
				const run = await cli(tick(stateDir(), ...extra), new FakeGitHub());

				assert.equal(run.code, EXIT.usage, extra.join(" "));
				assert.match(run.stderr, /--verification-token-cap/);
			}

			const admit = await cli(
				[
					"admit",
					"--json",
					...base,
					"--issue",
					"14",
					"--state-dir",
					stateDir(),
					"--verification-token-cap",
					"1000",
				],
				new FakeGitHub(),
			);

			assert.equal(admit.code, EXIT.usage);
		});

		it("pins a write-once manifest in a fresh state dir and refuses changed scope, cap or production use", async () => {
			const state = stateDir();
			const github = new FakeGitHub();

			github.add(labeled(14));

			const first = await cli(
				tick(state, "--issue", "14", "--verification-token-cap", "12000"),
				github,
			);

			assert.equal(first.code, EXIT.ok, first.stderr);
			assert.deepEqual(manifestOf(state), {
				v: 1,
				repo,
				issues: [14],
				tokenCap: 12_000,
			});
			assert.equal(
				statSync(join(state, "verification.json")).mode & 0o777,
				0o600,
			);

			const again = await cli(
				tick(state, "--issue", "14", "--verification-token-cap", "12000"),
				github,
			);

			assert.equal(again.code, EXIT.ok, again.stderr);

			for (const extra of [
				["--issue", "14", "--verification-token-cap", "13000"],
				["--issue", "14", "--issue", "15", "--verification-token-cap", "12000"],
				["--issue", "14"],
				[],
			]) {
				const refused = await cli(tick(state, ...extra), github);

				assert.equal(refused.code, EXIT.invalid, extra.join(" "));
				assert.match(
					refused.stderr,
					/event=controller_refused reason=verification_(manifest_mismatch|state)/,
				);
			}

			assert.deepEqual(manifestOf(state).tokenCap, 12_000);
		});

		it("refuses a state dir that already holds production state", async () => {
			const state = stateDir();
			const github = new FakeGitHub();

			github.add(labeled(14));
			assert.equal(
				(await cli(tick(state, "--issue", "14"), github)).code,
				EXIT.ok,
			);

			const run = await cli(
				tick(state, "--issue", "14", "--verification-token-cap", "12000"),
				github,
			);

			assert.equal(run.code, EXIT.invalid);
			assert.match(
				run.stderr,
				/event=controller_refused reason=verification_state_not_new/,
			);
			assert.equal(existsSync(join(state, "verification.json")), false);
		});

		it("only lowers the trusted run cap and marks the terminal row as verification", async () => {
			const archive = stateDir();
			const tree = join(archive, "repo", ".github", "factory");
			mkdirSync(join(tree, "gates"), { recursive: true });
			writeFileSync(join(tree, "WORKFLOW.md"), TRUSTED_WORKFLOW);
			writeFileSync(join(tree, "gates", "ci.sh"), "echo trusted\n");
			const bytes = execFileSync("tar", ["-czf", "-", "-C", archive, "repo"]);
			const policySource = { fetch: async () => bytes };

			for (const [cap, effective] of [
				[12_000, 12_000],
				[TRUSTED_RUN_CAP + 400_000, TRUSTED_RUN_CAP],
			] as const) {
				const state = stateDir();
				const github = new FakeGitHub();
				const executor = new FakeExecutor();

				github.add(labeled(14));
				executor.behaviors = [{ kind: "fail", usage: effective }];

				const argv = tick(
					state,
					"--issue",
					"14",
					"--verification-token-cap",
					String(cap),
				);

				const run = await cli(
					argv,
					github,
					new AbortController(),
					executor,
					policySource,
				);

				assert.equal(run.code, EXIT.ok, run.stderr);
				assert.equal(executor.launches[0]?.remainingRunTokens, effective);
				await cli(argv, github, new AbortController(), executor, policySource);
				assert.equal(statuses(github, 14).at(-1), "3:budget_exhausted");

				const terminal = JSON.parse(
					readFileSync(
						join(state, "ledger", runOf(14), "terminal.json"),
						"utf8",
					),
				);

				assert.partialDeepStrictEqual(terminal.provenance, {
					kind: "verification",
					trustedRunTokenCap: TRUSTED_RUN_CAP,
					effectiveRunTokenCap: effective,
				});
				assert.equal(
					terminal.provenance.verificationDigest,
					digestOf(readFileSync(join(state, "verification.json"), "utf8")),
				);
			}
		});

		it("never reaches the production unit's ExecStart", () => {
			const unit = readFileSync(
				new URL("../../../host/install/factory.service", import.meta.url),
				"utf8",
			);

			const exec = unit
				.split("\n")
				.filter((line) => line.startsWith("ExecStart"));

			assert.equal(exec.length, 1);
			assert.match(exec[0] ?? "", /host\/cli\/index\.ts serve /);
			assert.doesNotMatch(unit, /verification/);
		});
	});

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
		executor.acceptBehavior = { kind: "pass", usage: 0 };

		const run = await cli(
			["tick", "--once", "--json", ...base, "--state-dir", state],
			github,
			new AbortController(),
			executor,
		);

		assert.equal(run.code, EXIT.ok, run.stderr);

		const report = JSON.parse(run.stdout);

		assert.equal(report.executionEnabled, true);
		assert.equal(report.runs[0]?.stage, "build");
		assert.equal(report.runs[0]?.status, "claimed");
		assert.equal(report.totals.usage, 9);
		assert.equal(executor.recovered, 1);
		assert.deepEqual(statuses(github, 14), [
			"1:claimed",
			"2:running",
			"3:claimed",
			"4:running",
			"5:claimed",
		]);
		assert.equal(
			JSON.parse(readFileSync(join(state, "status.json"), "utf8")).runs.length,
			1,
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
			/event=controller_ready pid=4242 repo=nublai\/pi-herdr-factorio scope=14/,
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

	it("an --issue tick keeps ticket behavior and never constructs or launches cadence", async () => {
		const github = new FakeGitHub();
		const state = stateDir();
		const executor = new FakeExecutor();
		github.add(labeled(14));
		github.add(labeled(15));
		executor.behaviors = [{ kind: "refuse", usage: 40 }];

		const report = await cli(
			[
				"tick",
				"--once",
				"--json",
				...base,
				"--state-dir",
				state,
				"--issue",
				"14",
			],
			github,
			new AbortController(),
			executor,
		);

		assert.equal(report.code, EXIT.ok, report.stderr);
		assert.deepEqual(
			executor.launches.map((launch) => launch.stage),
			["specify"],
		);
		assert.equal(existsSync(join(state, "cadence")), false);
		assert.deepEqual(statuses(github, 15), []);
		assert.equal(JSON.parse(report.stdout).totals.usage, 40);
	});

	it("status reports a durable ended-run floor and ledger backlog without launching or writing", async () => {
		const github = new FakeGitHub();
		const state = stateDir();
		const executor = new FakeExecutor();
		github.add(labeled(14));
		executor.behaviors = [{ kind: "refuse", usage: 40 }];
		await cli(
			["tick", "--once", "--json", ...base, "--state-dir", state],
			github,
			new AbortController(),
			executor,
		);
		const before = readdirSync(state).sort();
		const launches = executor.launches.length;

		const result = await cli(
			["status", "--json", ...base, "--state-dir", state],
			github,
			new AbortController(),
			executor,
		);

		const status = JSON.parse(result.stdout);
		assert.equal(status.ledger.pending, 1);
		assert.equal(status.ledger.oldestAgeMs, 0);
		assert.equal(status.ledger.state, "pending");
		assert.equal(status.durableUsage.total, 40);
		assert.equal(status.durableUsage.kind, "lower_bound");
		assert.equal(status.accounting.runs.length, 1);
		assert.equal(status.accounting.runs[0].money.kind, "unavailable");
		assert.deepEqual(status.accounting.runs[0].terminal.failure, {
			kind: "known",
			value: {
				stage: "specify",
				class: "provider",
				reason: "refused",
				failedVisibleChecks: [],
				retainedPatch: null,
			},
		});
		assert.equal(status.accounting.countersScope, "process");
		assert.equal(executor.launches.length, launches);
		assert.deepEqual(readdirSync(state).sort(), before);
		writeFileSync(join(state, "ledger", runOf(14), "retry.json"), "{");

		const broken = await cli(
			["status", "--json", ...base, "--state-dir", state],
			github,
		);

		assert.deepEqual(
			["state", "pending", "blocked", "lastError"].map(
				(key) => JSON.parse(broken.stdout).ledger[key],
			),
			["blocked", 1, 1, "state_invalid"],
		);
	});

	for (const coverage of ["exact", "missing", "unsettled", "incomplete"]) {
		it(`status JSON aggregates runs with ${coverage} coverage`, async () => {
			const state = stateDir();
			const github = new FakeGitHub();

			for (const issue of [14, 15]) {
				const runGithub = new FakeGitHub();
				runGithub.add(labeled(issue));
				const executor = new FakeExecutor();
				executor.behaviors = [{ kind: "refuse", usage: 40 }];
				await cli(
					["tick", "--once", "--json", ...base, "--state-dir", state],
					runGithub,
					new AbortController(),
					executor,
				);
				const stage = join(state, "stages", runOf(issue), "specify-1");

				mkdirSync(stage, { recursive: true });

				if (issue === 14 || coverage === "exact" || coverage === "incomplete") {
					writeFileSync(
						join(stage, "receipt.json"),
						JSON.stringify({
							version: 1,
							runId: runOf(issue),
							stage: "specify",
							attempt: 1,
							outcome: { kind: "passed" },
							turns: 1,
							wallMs: 10,
							usage: {
								total: 40,
								parent: 40,
								children: 0,
								gateway: 40,
								unreadChildren: 0,
								byModel: {},
							},
						}),
					);
				} else if (coverage === "unsettled") {
					writeFileSync(
						join(stage, "egress.requests.jsonl"),
						'{"kind":"result","req":1,"inputTokens":10,"outputTokens":0}\n{"kind":"dispatch","req":2,"inputTokenEstimate":20,"maxOutputTokens":50}\n',
					);
				}
			}

			if (coverage === "incomplete") {
				writeFileSync(join(state, "claims", `${"0".repeat(64)}.json`), "{");
			}

			const result = await cli(
				["status", "--json", ...base, "--state-dir", state],
				github,
			);

			const status = JSON.parse(result.stdout);

			assert.deepEqual(
				status.accounting.runs.map(
					(run: { tokens: { kind: string } }) => run.tokens.kind,
				),
				[
					"exact",
					coverage === "exact" || coverage === "incomplete"
						? "exact"
						: coverage === "missing"
							? "lower_bound"
							: "uncertain",
				],
			);
			assert.deepEqual(
				status.durableUsage,
				coverage === "exact"
					? {
							kind: "exact",
							unit: "tokens",
							total: 80,
							maintenance: { kind: "exact", unit: "tokens", total: 0 },
						}
					: {
							maintenance: { kind: "exact", unit: "tokens", total: 0 },
							kind: coverage === "unsettled" ? "uncertain" : "lower_bound",
							unit: "tokens",
							total: coverage === "unsettled" ? 120 : 80,
							reason:
								coverage === "unsettled"
									? "request_unsettled"
									: "receipt_missing",
						},
			);
		});
	}

	for (const incomplete of [false, true]) {
		it(`status JSON classifies empty accounting with incomplete=${incomplete}`, async () => {
			const state = stateDir();

			if (incomplete) {
				mkdirSync(join(state, "claims"));
				writeFileSync(join(state, "claims", `${"0".repeat(64)}.json`), "{");
			}

			const result = await cli(
				["status", "--json", ...base, "--state-dir", state],
				new FakeGitHub(),
			);

			const status = JSON.parse(result.stdout);
			assert.equal(
				status.accounting.state,
				incomplete ? "incomplete" : "readable",
			);
			assert.deepEqual(status.accounting.runs, []);
			assert.deepEqual(
				status.durableUsage,
				incomplete
					? {
							kind: "lower_bound",
							unit: "tokens",
							total: 0,
							reason: "receipt_missing",
						}
					: { kind: "exact", unit: "tokens", total: 0 },
			);
		});
	}

	it("status JSON classifies complete and missing receipt coverage", async () => {
		const github = new FakeGitHub();
		const state = stateDir();
		github.add(labeled(14));
		const executor = new FakeExecutor();
		executor.behaviors = [{ kind: "refuse", usage: 40 }];
		await cli(
			["tick", "--once", "--json", ...base, "--state-dir", state],
			github,
			new AbortController(),
			executor,
		);
		const stage = join(state, "stages", runOf(14), "specify-1");
		mkdirSync(stage, { recursive: true });
		writeFileSync(
			join(stage, "receipt.json"),
			JSON.stringify({
				version: 1,
				runId: runOf(14),
				stage: "specify",
				attempt: 1,
				outcome: { kind: "passed" },
				turns: 1,
				wallMs: 10,
				usage: {
					total: 40,
					parent: 40,
					children: 0,
					gateway: 40,
					unreadChildren: 0,
					byModel: {},
				},
			}),
		);

		const result = await cli(
			["status", "--json", ...base, "--state-dir", state],
			github,
		);

		assert.deepEqual(JSON.parse(result.stdout).accounting.runs[0].tokens, {
			kind: "exact",
			unit: "tokens",
			total: 40,
		});
		const receiptPath = join(stage, "receipt.json");
		const receipt = JSON.parse(readFileSync(receiptPath, "utf8"));
		writeFileSync(receiptPath, JSON.stringify({ ...receipt, attempt: 2 }));

		const mismatched = await cli(
			["status", "--json", ...base, "--state-dir", state],
			github,
		);

		assert.deepEqual(JSON.parse(mismatched.stdout).accounting.runs[0].tokens, {
			kind: "lower_bound",
			unit: "tokens",
			total: 40,
			reason: "receipt_missing",
		});
		writeFileSync(receiptPath, JSON.stringify(receipt));
		assert.deepEqual((await readRunCharges(state, runOf(14), 50)).tokens, {
			kind: "lower_bound",
			unit: "tokens",
			total: 50,
			reason: "receipt_missing",
		});
		rmSync(join(stage, "receipt.json"));

		const missing = await cli(
			["status", "--json", ...base, "--state-dir", state],
			github,
		);

		assert.deepEqual(JSON.parse(missing.stdout).accounting.runs[0].tokens, {
			kind: "lower_bound",
			unit: "tokens",
			total: 40,
			reason: "receipt_missing",
		});
	});

	it("status marks upper-bound charges uncertain and never calls missing state an empty backlog", async () => {
		const github = new FakeGitHub();
		const state = stateDir();
		github.add(labeled(14));
		const executor = new FakeExecutor();
		executor.behaviors = [{ kind: "refuse", usage: 40 }];
		await cli(
			["tick", "--once", "--json", ...base, "--state-dir", state],
			github,
			new AbortController(),
			executor,
		);
		const stage = join(state, "stages", runOf(14), "specify-1");
		mkdirSync(stage, { recursive: true });
		writeFileSync(
			join(stage, "egress.requests.jsonl"),
			'{"kind":"result","req":1,"inputTokens":10,"outputTokens":0}\n{"kind":"dispatch","req":2,"inputTokenEstimate":20,"maxOutputTokens":50}\n',
		);

		const result = await cli(
			["status", "--json", ...base, "--state-dir", state],
			github,
		);

		const status = JSON.parse(result.stdout);
		assert.equal(status.accounting.runs[0].tokens.kind, "uncertain");
		assert.equal(status.accounting.runs[0].tokens.reason, "request_unsettled");
		assert.equal(status.durableUsage.kind, "uncertain");
		assert.equal(status.durableUsage.total, 80);

		const missing = await cli(
			["status", "--json", ...base, "--state-dir", join(state, "missing")],
			github,
		);

		const unavailable = JSON.parse(missing.stdout);
		assert.equal(unavailable.accounting.state, "unavailable");
		assert.deepEqual(unavailable.durableUsage, {
			kind: "unavailable",
			reason: "legacy_not_recorded",
		});
		assert.equal(unavailable.ledger.state, "unreadable");
		assert.equal(unavailable.ledger.pending, null);
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

describe("Orchestrator runs of another state directory", () => {
	const base = ["--repo", repo];

	function writes(github: FakeGitHub, from: number): string[][] {
		return github.calls.slice(from).filter((call) => {
			const at = call.indexOf("--method");

			return at >= 0 && call[at + 1] !== "GET";
		});
	}

	for (const lane of ["running", "blocked"] as const)
		for (const held of [true, false])
			it(`leaves a ${lane} run alone from a ${held ? "held" : "live"} controller`, async () => {
				const f = world();
				f.github.add(labeled(14));

				if (lane === "running") f.executor.behaviors = [{ kind: "hang" }];
				const controller = f.start();
				await controller.tick();
				const before = statuses(f.github, 14);
				assert.deepEqual(before, ["1:claimed", `2:${lane}`]);

				const state = stateDir();

				if (held) writeFileSync(join(state, "disabled"), "");

				const executor = new FakeExecutor();
				const calls = f.github.calls.length;

				const other = await cli(
					["tick", "--once", "--json", ...base, "--state-dir", state],
					f.github,
					new AbortController(),
					executor,
				);

				assert.equal(other.code, EXIT.ok, other.stderr);
				assert.deepEqual(writes(f.github, calls), []);
				assert.deepEqual(statuses(f.github, 14), before);
				assert.deepEqual(JSON.parse(other.stdout).runs, []);
				assert.equal(executor.launches.length, 0);
				assert.equal(
					existsSync(join(state, "claims", `${runOf(14)}.json`)),
					false,
				);
				assert.doesNotMatch(
					other.stderr,
					/event=(claim_adopted|claim_taken|marker_posted|marker_corrupt|claim_dropped)/,
				);
				assert.equal(
					other.stderr.match(/event=claim_foreign issue=14 /g)?.length,
					1,
				);

				await controller.tick();
				assert.deepEqual(statuses(f.github, 14), before);
				assert.equal(events(f.logs).includes("marker_corrupt"), false);
				assert.equal(controller.state.runs.get(14)?.runId, runOf(14));
			});

	for (const held of [true, false])
		it(`adopts its own run after a restart that lost its claim file (${held ? "held" : "live"})`, async () => {
			const github = new FakeGitHub();
			const state = stateDir();
			github.add(labeled(14));

			const first = await cli(
				["tick", "--once", "--json", ...base, "--state-dir", state],
				github,
			);

			assert.equal(first.code, EXIT.ok, first.stderr);
			assert.deepEqual(statuses(github, 14), ["1:claimed", "2:blocked"]);
			const claim = join(state, "claims", `${runOf(14)}.json`);
			rmSync(claim);

			if (held) writeFileSync(join(state, "disabled"), "");

			const restarted = await cli(
				["tick", "--once", "--json", ...base, "--state-dir", state],
				github,
			);

			assert.equal(restarted.code, EXIT.ok, restarted.stderr);
			assert.match(restarted.stderr, /event=claim_adopted issue=14 /);
			assert.doesNotMatch(restarted.stderr, /event=claim_foreign/);
			assert.equal(JSON.parse(restarted.stdout).runs[0]?.runId, runOf(14));
			assert.equal(JSON.parse(readFileSync(claim, "utf8")).seq, 2);
			assert.deepEqual(statuses(github, 14), ["1:claimed", "2:blocked"]);
		});

	it("turns its own interrupted running stage into a retry after losing the claim file", async () => {
		const { github, executor, files, logs, start } = world();

		github.add(labeled(14));
		executor.behaviors = [{ kind: "hang" }];
		await start().tick();
		assert.deepEqual(statuses(github, 14), ["1:claimed", "2:running"]);
		files.claims.clear();

		const report = await start().tick();

		assert.equal(report.runs[0]?.attempt, 2);
		assert.equal(report.runs[0]?.status, "retrying");
		assert.deepEqual(statuses(github, 14), [
			"1:claimed",
			"2:running",
			"3:retrying",
		]);
		assert.equal(events(logs).includes("claim_foreign"), false);
	});

	async function foreignMarker(
		github: FakeGitHub,
		change: {
			eventId: string;
			eventAt: string;
			seq: number;
			status: RunStatus;
		},
	): Promise<Digest> {
		const f = world();
		f.github.add(labeled(14));
		await f.start().tick();
		const parsed = parseMarker(f.github.markers(14)[0] ?? "");

		if (parsed.kind !== "marker") throw new Error("marker");
		const runId = runIdOf({ repo, issue: 14, eventId: change.eventId });
		const issue = github.issues.get(14);
		assert.ok(issue);
		github.comment(issue, formatMarker({ ...parsed.marker, ...change, runId }));

		return runId;
	}

	it("frees its own claim's slot under another controller's live run, posting nothing there", async () => {
		const github = new FakeGitHub();
		const state = stateDir();
		const issue = github.add(labeled(14));
		const once = ["tick", "--once", "--json", ...base, "--state-dir", state];

		const first = await cli(once, github);

		assert.equal(first.code, EXIT.ok, first.stderr);
		assert.deepEqual(statuses(github, 14), ["1:claimed", "2:blocked"]);
		const replaced = relabel(github, issue);

		const foreign = await foreignMarker(github, {
			eventId: "34537529999",
			eventAt: "2026-10-29T02:31:00Z",
			seq: 3,
			status: "blocked",
		});

		assert.equal(foreign, replaced);
		github.add(labeled(15));
		github.add(labeled(16));
		const before = statuses(github, 14);

		const restarted = await cli(once, github);

		assert.equal(restarted.code, EXIT.ok, restarted.stderr);
		assert.deepEqual(statuses(github, 14), before);
		assert.match(restarted.stderr, /event=claim_foreign issue=14 /);
		assert.doesNotMatch(
			restarted.stderr,
			/event=(claim_adopted|claim_released|claim_taken|marker_posted) issue=14 /,
		);
		assert.deepEqual(
			runIssues(JSON.parse(restarted.stdout)).sort((a, b) => a - b),
			[15, 16],
		);
		assert.deepEqual(statuses(github, 15), ["1:claimed", "2:blocked"]);
		assert.deepEqual(statuses(github, 16), ["1:claimed", "2:blocked"]);
		assert.equal(
			JSON.parse(
				readFileSync(join(state, "claims", `${runOf(14)}.json`), "utf8"),
			).status,
			"blocked",
		);
	});

	for (const claimFile of ["kept", "lost"] as const)
		it(`waits with its own recovered admission until another controller's live run ends (claim file ${claimFile})`, async () => {
			const f = world();
			const issue = f.github.add(labeled(14));
			let finish: (result: StageResult) => void = () => undefined;
			f.executor.behaviors = [
				{
					kind: "later",
					result: new Promise((done) => {
						finish = done;
					}),
				},
			];
			const owner = f.start();
			await owner.tick();
			assert.deepEqual(statuses(f.github, 14), ["1:claimed", "2:running"]);

			const newer = relabel(f.github, issue);
			const store = memoryStore();
			const files = memoryFiles();

			const admitted = await admitTicket({
				platform: EXE_DEV_PLATFORM,
				exec: f.github.exec,
				env: () => "/home/exedev",
				repo,
				issue: 14,
				allowlist: [repo],
				store,
			});

			assert.equal(admitted.decision, "admitted");

			if (claimFile === "kept")
				files.claims.set(newer, {
					runId: newer,
					issue: 14,
					eventId: "34537529999",
					seq: null,
					status: null,
					stage: null,
					attempt: null,
					usage: null,
				});

			f.github.add(labeled(15));
			f.github.add(labeled(16));
			const clock = new FakeClock();
			clock.t = START + 3_600_000;
			const executor = new FakeExecutor();
			executor.workflow = () => f.github.workflow;
			const logs: { event: string; fields: LogFields }[] = [];

			const other = new Orchestrator({
				platform: EXE_DEV_PLATFORM,
				exec: f.github.exec,
				env: () => "/home/exedev",
				repo,
				store,
				files,
				executor,
				clock,
				scope: null,
				log: (event, fields) => logs.push({ event, fields }),
			});

			await other.tick();
			assert.deepEqual(statuses(f.github, 14), ["1:claimed", "2:running"]);
			assert.equal(other.state.runs.has(14), false);
			assert.deepEqual(
				[...other.state.runs.keys()].sort((a, b) => a - b),
				[15, 16],
			);

			const launch = f.executor.launches[0];
			assert.ok(launch);
			finish(resultOf(launch, { kind: "failed", exit: "error" }, 0));
			f.store.local = "disabled";
			await owner.tick();
			assert.equal(statuses(f.github, 14)[2], "3:retrying");

			for (let tick = 0; tick < 3; tick++) {
				f.clock.t += 60_000;
				clock.t += 60_000;
				await other.tick();
				await owner.tick();
			}

			assert.equal(events(f.logs).includes("marker_corrupt"), false);
			assert.equal(events(logs).includes("marker_corrupt"), false);
			const ended = statuses(f.github, 14);
			assert.match(ended.at(-1) ?? "", /^\d+:released$/);
			assert.equal(other.state.runs.has(14), false);

			for (const number of [15, 16]) {
				const done = f.github.issues.get(number);
				assert.ok(done);
				done.state = "closed";
				done.updatedAt = "2026-10-29T02:40:00Z";
			}

			clock.t += 60_000;
			await other.tick();
			assert.deepEqual([...other.state.runs.keys()], [14]);
			assert.equal(other.state.runs.get(14)?.runId, newer);
			assert.equal(
				statuses(f.github, 14)[ended.length],
				`${ended.length + 1}:claimed`,
			);
			assert.equal(events(f.logs).includes("marker_corrupt"), false);
			assert.equal(events(logs).includes("marker_corrupt"), false);
		});

	it("frees the slot of a claim ahead of the ledger that has no admission here", async () => {
		const { github, files, logs, start } = world();
		github.add(labeled(14));
		github.add(labeled(15));
		github.add(labeled(16));
		files.claims.set(runOf(14), blockedClaim(14, 3));

		const report = await start().tick();

		assert.deepEqual(
			runIssues(report).sort((a, b) => a - b),
			[15, 16],
		);
		assert.deepEqual(statuses(github, 14), []);
		assert.equal(events(logs).includes("claim_adopted"), false);
	});

	for (const lane of ["ready", "closed"] as const)
		it(`frees the slot of an unmarked ${lane} claim that has no admission here`, async () => {
			const { github, files, logs, start } = world();
			const issue = github.add(labeled(14));

			if (lane === "closed") issue.state = "closed";
			github.add(labeled(15));
			github.add(labeled(16));
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

			const report = await start().tick();

			assert.deepEqual(
				runIssues(report).sort((a, b) => a - b),
				[15, 16],
			);
			assert.deepEqual(statuses(github, 14), []);
			assert.equal(events(logs).includes("claim_released"), false);
		});

	it("admits a newer ready event only once the owner ends its run", async () => {
		const f = world();
		const issue = f.github.add(labeled(14));
		const owner = f.start();
		await owner.tick();
		assert.deepEqual(statuses(f.github, 14), ["1:claimed", "2:blocked"]);

		const clock = new FakeClock();
		clock.t = START + 3_600_000;
		const executor = new FakeExecutor();
		executor.workflow = () => f.github.workflow;
		const logs: { event: string; fields: LogFields }[] = [];

		const other = new Orchestrator({
			platform: EXE_DEV_PLATFORM,
			exec: f.github.exec,
			env: () => "/home/exedev",
			repo,
			store: memoryStore(),
			files: memoryFiles(),
			executor,
			clock,
			scope: null,
			log: (event, fields) => logs.push({ event, fields }),
		});

		await other.tick();
		const calls = f.github.calls.length;
		const newer = relabel(f.github, issue);
		await other.tick();
		clock.t += 60_000;
		await other.tick();
		assert.deepEqual(writes(f.github, calls), []);
		assert.equal(other.state.runs.size, 0);
		assert.equal(events(logs).filter((e) => e === "claim_foreign").length, 1);

		f.store.local = "disabled";
		await owner.tick();
		assert.deepEqual(statuses(f.github, 14), [
			"1:claimed",
			"2:blocked",
			"3:released",
		]);

		clock.t += 60_000;
		await other.tick();
		assert.equal(other.state.runs.get(14)?.runId, newer);
		assert.deepEqual(statuses(f.github, 14).slice(0, 4), [
			"1:claimed",
			"2:blocked",
			"3:released",
			"4:claimed",
		]);
	});
});
