import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, it } from "node:test";
import { EXIT } from "../../../host/cli/platform.ts";
import { fileLedgerOutbox } from "../../../host/controller/outbox.ts";
import { fileRunFiles } from "../../../host/controller/run-files.ts";
import { writeStatus } from "../../../host/controller/state.ts";
import { answersDigestOf } from "../../../src/contract/contract.ts";
import { parseMarker } from "../../../src/trust/markers.ts";
import { READY_LABEL } from "../../../src/trust/policy.ts";
import { digestOf, runIdOf } from "../../../src/core/run.ts";
import {
	FAKE_REPO,
	FakeGitHub,
	type FakeIssue,
	labelEvent,
	httpError,
	MAIN_SHA,
	networkError,
	TRUSTED_RUN_CAP,
	TRUSTED_WORKFLOW,
} from "../../fake-ticket-adapter.ts";
import { EXE_DEV_PLATFORM } from "../../../src/trust/platform.ts";
import {
	repo,
	CONTRACT_TEXT,
	QUESTIONS_TEXT,
	EVENT_ID,
	labeled,
	runOf,
	world,
	statuses,
	stateDir,
	cli,
	setWorkflow,
	settle,
	writesWire,
	once,
	keyed,
} from "./orchestrator-fixtures.ts";

describe("specify: contract", () => {
	it("stores a validated contract and posts its summary before claiming accept", async () => {
		const { github, files, executor, wire, start } = world();
		const writes: string[] = [];

		wire.intercept = writesWire(github, writes);
		github.add(
			labeled(14, {
				title: "Add --version",
				body: "Print the version from server/cli.ts.",
			}),
		);
		executor.behaviors = [{ kind: "pass", usage: 900 }];

		const report = await once(start());

		assert.deepEqual(statuses(github, 14), [
			"1:claimed",
			"2:running",
			"3:claimed",
			"4:blocked",
		]);
		assert.deepEqual(writes, [
			"marker:claimed",
			"marker:running",
			"summary",
			"marker:claimed",
			"marker:blocked",
		]);
		assert.equal(report.totals.usage, 900);

		const stored = files.contracts.get(runOf(14));

		assert.ok(stored);
		assert.equal(stored.digest, digestOf(stored.bytes));

		const contract = JSON.parse(stored.bytes);

		assert.equal(contract.version, 2);
		assert.deepEqual(contract.base, { repo, sha: MAIN_SHA });
		assert.equal(contract.runId, runOf(14));
		assert.equal(
			contract.snapshot.digest,
			digestOf(
				JSON.stringify([
					"Add --version",
					"Print the version from server/cli.ts.",
				]),
			),
		);
		assert.equal(contract.link, null);
		assert.deepEqual(contract.acceptance, [
			{ id: "A1", kind: "new_behavior", text: "--version prints 0.1.0" },
		]);

		const [summary] = keyed(github, 14, "contract");

		assert.ok(summary?.includes(stored.digest.slice(0, 12)));
		assert.ok(summary?.endsWith(`c=${stored.digest} -->\n`));
		assert.ok(!summary?.includes("VERSION"));
		assert.deepEqual(github.issues.get(14)?.labels, [READY_LABEL]);
	});

	it("launches specify with the snapshot, the base commit's guidance, the repository map, read tools and the skills", async () => {
		const { github, executor, start } = world();

		github.add(
			labeled(14, {
				title: "Add --version",
				body: "Print the version from server/cli.ts.",
			}),
		);
		executor.behaviors = [{ kind: "pass", usage: 1 }];

		await once(start());

		const launch = executor.launches[0];

		assert.ok(launch);
		assert.deepEqual(launch.tools, ["read", "grep", "ls"]);
		assert.deepEqual(launch.specify, {
			title: "Add --version",
			body: "Print the version from server/cli.ts.",
			answers: null,
			files: [...executor.tree.keys()],
		});
		assert.deepEqual(launch.skills, [
			"audit-ticket",
			"grill-me",
			"deep-research",
		]);
		assert.ok(launch.prompt.includes(`at commit ${MAIN_SHA}`));
		assert.match(
			launch.prompt,
			/<issue-([0-9a-f]{32})>\nAdd --version\n\nPrint the version from server\/cli.ts\.\n<\/issue-\1>/,
		);
		assert.ok(launch.prompt.includes("Turn the issue into a short contract"));
		assert.ok(
			launch.prompt.includes(
				"=== server/cli.ts ===\n1\texport const VERSION = 1;",
			),
		);
		assert.ok(launch.prompt.includes("=== README.md ==="));
		assert.ok(!launch.prompt.includes("subagent"));
		assert.deepEqual(executor.checkouts, [runOf(14), runOf(14)]);
	});

	it("inlines the files the issue names within a 16 KiB budget and leaves the rest to the read tool", async () => {
		const { github, executor, start } = world();
		const line = `${"x".repeat(99)}\n`;

		for (const name of ["a.ts", "b.ts", "c.ts"]) {
			executor.tree.set(`src/${name}`, line.repeat(100));
		}

		github.add(labeled(14, { body: "Touch src/a.ts, src/b.ts and src/c.ts." }));
		executor.behaviors = [{ kind: "pass", usage: 1 }];

		await once(start());

		const prompt = executor.launches[0]?.prompt ?? "";

		assert.ok(prompt.includes("=== src/a.ts ===\n"));
		assert.match(prompt, /=== src\/b\.ts \(lines 1-\d+ of 101\) ===\n/);
		assert.ok(!prompt.includes("=== src/c.ts"));
		assert.ok(prompt.includes("src/c.ts\n"));
	});

	it("takes the guidance from the run's base commit, not from a later main", async () => {
		const { github, executor, start } = world();

		github.add(labeled(14));
		executor.behaviors = [{ kind: "unavailable" }, { kind: "pass", usage: 1 }];
		executor.workflow = () => TRUSTED_WORKFLOW;

		const controller = start();

		await once(controller);
		assert.deepEqual(statuses(github, 14), ["1:claimed", "2:blocked"]);
		assert.deepEqual(executor.checkouts, []);

		setWorkflow(
			github,
			"Turn the issue into a short contract",
			"Write a haiku about the issue",
		);
		github.issues.get(14)?.timeline.push();
		await once(controller);

		const launch = executor.launches[1];

		assert.ok(launch);
		assert.ok(launch.prompt.includes("Turn the issue into a short contract"));
		assert.ok(!launch.prompt.includes("haiku"));
	});

	it("fails the run when the checkout's WORKFLOW.md is not the admitted one", async () => {
		const { github, executor, logs, start } = world();

		github.add(labeled(14));
		executor.behaviors = [{ kind: "pass", usage: 1 }];
		executor.workflow = () => `${TRUSTED_WORKFLOW}\nextra\n`;

		await once(start());

		assert.equal(executor.launches.length, 0);
		assert.deepEqual(statuses(github, 14), ["1:claimed", "2:failed"]);
		assert.ok(
			logs.some(
				(entry) =>
					entry.event === "stage_inputs_refused" &&
					entry.fields.why === "workflow_mismatch",
			),
		);
	});

	it("waits without a launch while the checkout is unavailable, and fails a refused tarball", async () => {
		const { github, executor, logs, start } = world();

		github.add(labeled(14));
		github.add(labeled(15));
		executor.fallback = { kind: "pass", usage: 1 };
		executor.checkoutResult = "unavailable";

		const controller = start();
		const report = await once(controller);

		assert.equal(executor.launches.length, 0);
		assert.deepEqual(
			report.runs.map((run) => run.status),
			["claimed", "claimed"],
		);
		assert.ok(
			logs.some(
				(entry) =>
					entry.event === "stage_inputs_unavailable" &&
					entry.fields.why === "checkout",
			),
		);

		executor.checkoutResult = "refused";
		await once(controller);

		assert.equal(executor.launches.length, 0);
		assert.equal(statuses(github, 14).at(-1), "2:failed");
	});
});

describe("specify: no contract without a passing, valid output", () => {
	it("retries malformed output as stage_failed and ends failed with no contract or comment", async () => {
		const { github, clock, files, executor, logs, start } = world();

		github.add(labeled(14));
		executor.outputs = ["Here is the contract: {}", '{"kind":"plan"}', null];
		executor.behaviors = [
			{ kind: "pass", usage: 10 },
			{ kind: "pass", usage: 10 },
			{ kind: "pass", usage: 10 },
		];

		const controller = start();

		await once(controller);
		assert.deepEqual(statuses(github, 14), [
			"1:claimed",
			"2:running",
			"3:retrying",
		]);
		clock.t += 11_000;
		await once(controller);
		clock.t += 21_000;
		await once(controller);

		assert.equal(executor.launches.length, 3);
		assert.equal(statuses(github, 14).at(-1)?.endsWith(":failed"), true);
		assert.deepEqual(
			logs.flatMap((entry) =>
				entry.event === "specify_malformed" ? [entry.fields.reason] : [],
			),
			["not_json", "bad_kind", "no_output"],
		);
		assert.equal(files.contracts.size, 0);
		assert.equal(files.questions.size, 0);
		assert.deepEqual(keyed(github, 14, "contract"), []);
	});

	it("never reads the output of a budget_exhausted or refused stage", async () => {
		for (const behavior of [
			{ kind: "budget", usage: 50 },
			{ kind: "refuse", usage: 50 },
		] as const) {
			const { github, files, executor, start } = world();

			github.add(labeled(14));
			executor.behaviors = [behavior];
			executor.kept.set(`${runOf(14)}/specify-1`, CONTRACT_TEXT);

			await once(start());

			assert.deepEqual(executor.outputReads, [], behavior.kind);
			assert.equal(files.contracts.size, 0, behavior.kind);
			assert.deepEqual(keyed(github, 14, "contract"), [], behavior.kind);
			assert.equal(
				statuses(github, 14).at(-1),
				behavior.kind === "budget" ? "3:budget_exhausted" : "3:failed",
			);
		}
	});

	it("ends a stage whose summary is not storable without a terminal marker until it is", async () => {
		const { github, clock, files, executor, start } = world();

		github.add(labeled(14));
		executor.behaviors = [{ kind: "pass", usage: 5 }];
		files.unavailable.add("contract");

		const controller = start();

		await once(controller);
		assert.deepEqual(statuses(github, 14), ["1:claimed", "2:running"]);
		assert.deepEqual(keyed(github, 14, "contract"), []);

		files.unavailable.delete("contract");
		clock.t += 1_000;
		await once(controller);

		assert.equal(statuses(github, 14).at(-1), "3:claimed");
		assert.equal(keyed(github, 14, "contract").length, 1);
		assert.equal(executor.launches.length, 1);
	});
});

describe("specify: questions", () => {
	for (const outcome of ["rejected", "unknown"] as const) {
		it(`waits for a confirmed label swap after a ${outcome} write`, async () => {
			const ctx = world();
			const write = writesWire(ctx.github, []);
			let removals = 0;
			ctx.github.add(labeled(14));
			ctx.executor.outputs = [QUESTIONS_TEXT];
			ctx.executor.behaviors = [{ kind: "pass", usage: 3 }];
			ctx.wire.intercept = async (command, args) => {
				if (
					args.includes("DELETE") &&
					args.some((arg) => arg.endsWith("labels/factory%3Aready"))
				) {
					removals++;

					if (removals === 1)
						return outcome === "rejected"
							? httpError(422, "denied")
							: networkError();
				}

				return write(command, args);
			};

			const controller = ctx.start();
			await once(controller);
			assert.deepEqual(statuses(ctx.github, 14), ["1:claimed", "2:running"]);
			assert.ok(
				ctx.logs.some(
					({ event, fields }) =>
						event === "label_unconfirmed" && fields.outcome === outcome,
				),
			);
			ctx.clock.t += 60_000;
			await once(controller);
			assert.equal(statuses(ctx.github, 14).at(-1), "3:needs_info");
			assert.equal(removals, 2);
		});
	}

	it("starts a restarted new run at zero after the previous run exhausted label retries (T-CARRY)", async () => {
		const ctx = world();
		const write = writesWire(ctx.github, []);
		const disk = fileRunFiles(stateDir());
		ctx.files.writeClaim = disk.writeClaim;
		ctx.files.listClaims = disk.listClaims;
		const issue = ctx.github.add(labeled(14));
		ctx.executor.outputs = [QUESTIONS_TEXT, CONTRACT_TEXT];
		ctx.executor.behaviors = [
			{ kind: "pass", usage: 3 },
			{ kind: "pass", usage: 3 },
		];
		let rejectAdds = true;
		ctx.wire.intercept = async (command, args) =>
			rejectAdds &&
			args.includes("POST") &&
			args.some((arg) => arg.endsWith("/labels"))
				? httpError(422, "denied")
				: write(command, args);

		await once(ctx.start());

		for (let n = 0; n < 4; n++) {
			ctx.clock.t += 60_000;
			await once(ctx.start());
		}

		assert.equal(statuses(ctx.github, 14).at(-1), "3:failed");
		assert.equal((await disk.listClaims())[0]?.labelFailures, 3);

		rejectAdds = false;
		ctx.github.now = "2026-10-29T03:00:00Z";
		issue.timeline.push(
			labelEvent({
				id: EVENT_ID + 80,
				at: "2026-10-29T02:59:59Z",
				actor: "giuseppecrj",
				event: "unlabeled",
			}),
			labelEvent({
				id: EVENT_ID + 81,
				at: ctx.github.now,
				actor: "giuseppecrj",
			}),
		);
		issue.updatedAt = ctx.github.now;
		ctx.github.now = "2026-10-29T03:01:00Z";
		ctx.clock.t += 31 * 60_000;
		ctx.github.posts = ["landed_unanswered"];
		ctx.executor.fallback = { kind: "unavailable" };
		const behaviors = ctx.executor.behaviors;
		ctx.executor.behaviors = [];
		await once(ctx.start());
		assert.equal(statuses(ctx.github, 14).at(-1), "4:claimed");

		ctx.executor.behaviors = behaviors;
		ctx.clock.t += 60_000;
		const restarted = ctx.start();
		await once(restarted);
		ctx.clock.t += 60_000;
		await once(restarted);
		assert.equal(statuses(ctx.github, 14).at(-1), "7:blocked");
		assert.equal(ctx.files.contracts.size, 1);
		assert.equal(
			ctx.executor.launches.filter((l) => l.stage === "specify").length,
			2,
		);
		assert.equal(
			ctx.logs.filter(({ event }) => event === "label_retries_exhausted")
				.length,
			1,
		);
	});

	it("resets persisted label failures after a successful critical write", async () => {
		const ctx = world();
		const write = writesWire(ctx.github, []);
		const disk = fileRunFiles(stateDir());
		ctx.files.writeClaim = disk.writeClaim;
		ctx.files.listClaims = disk.listClaims;
		ctx.github.add(labeled(14));
		ctx.executor.outputs = [QUESTIONS_TEXT];
		ctx.executor.behaviors = [{ kind: "pass", usage: 3 }];
		let additions = 0;
		ctx.wire.intercept = async (command, args) => {
			if (
				args.includes("POST") &&
				args.some((arg) => arg.endsWith("/labels"))
			) {
				additions++;

				if (additions <= 2) return networkError();
			}

			if (
				args.includes("DELETE") &&
				args.some((arg) => arg.endsWith("labels/factory%3Aready"))
			)
				return networkError();

			return write(command, args);
		};

		await once(ctx.start());
		assert.equal((await disk.listClaims())[0]?.labelFailures, 1);
		ctx.clock.t += 60_000;
		await once(ctx.start());
		assert.equal((await disk.listClaims())[0]?.labelFailures, 2);
		ctx.clock.t += 60_000;
		await once(ctx.start());
		assert.equal((await disk.listClaims())[0]?.labelFailures, 1);
		ctx.clock.t += 60_000;
		await once(ctx.start());
		assert.equal((await disk.listClaims())[0]?.labelFailures, 2);
		assert.ok(
			!ctx.logs.some(({ event }) => event === "label_retries_exhausted"),
		);
	});

	it("caps persistently rejected label writes across separate controllers and disk claims without rerunning specify", async () => {
		const ctx = world();
		const write = writesWire(ctx.github, []);
		let additions = 0;
		const disk = fileRunFiles(stateDir());
		ctx.files.writeClaim = disk.writeClaim;
		ctx.files.listClaims = disk.listClaims;
		ctx.github.add(labeled(14));
		ctx.executor.outputs = [QUESTIONS_TEXT];
		ctx.executor.behaviors = [{ kind: "pass", usage: 3 }];
		ctx.wire.intercept = async (command, args) => {
			if (
				args.includes("POST") &&
				args.some((arg) => arg.endsWith("/labels"))
			) {
				additions++;

				return httpError(422, "denied");
			}

			return write(command, args);
		};

		await once(ctx.start());

		for (let n = 0; n < 5; n++) {
			ctx.clock.t += 60_000;
			await once(ctx.start());
		}

		assert.equal(additions, 3);
		assert.equal(statuses(ctx.github, 14).at(-1), "3:failed");
		assert.equal(ctx.executor.launches.length, 1);
		assert.equal(
			ctx.logs.filter(
				({ event, fields }) =>
					event === "label_unconfirmed" && fields.outcome === "rejected",
			).length,
			3,
		);
	});

	it("links a preserved owner relabel to the questions posted before a delayed terminal marker", async () => {
		const ctx = world();
		const write = writesWire(ctx.github, []);
		const issue = ctx.github.add(labeled(14));
		let removals = 0;
		ctx.executor.outputs = [QUESTIONS_TEXT, CONTRACT_TEXT];
		ctx.executor.behaviors = [
			{ kind: "pass", usage: 3 },
			{ kind: "pass", usage: 5 },
		];
		ctx.wire.intercept = async (command, args) => {
			if (
				args.includes("DELETE") &&
				args.some((arg) => arg.endsWith("labels/factory%3Aready"))
			) {
				removals++;
				await write(command, args);

				return networkError();
			}

			return write(command, args);
		};

		const controller = ctx.start();
		await once(controller);
		ctx.github.now = "2026-10-29T02:00:20Z";
		ctx.github.comment(issue, "PRESERVED-OWNER-ANSWER", {
			login: "writer",
			type: "User",
			appSlug: null,
		});
		ctx.github.now = "2026-10-29T02:00:40Z";
		issue.labels.push(READY_LABEL);
		issue.timeline.push(
			labelEvent({
				id: EVENT_ID + 50,
				at: ctx.github.now,
				actor: "giuseppecrj",
			}),
		);
		issue.updatedAt = ctx.github.now;
		ctx.github.now = "2026-10-29T02:01:00Z";
		ctx.clock.t += 60_000;
		await once(controller);
		ctx.clock.t += 60_000;
		await once(controller);
		assert.equal(removals, 1);
		assert.ok(issue.labels.includes(READY_LABEL));
		assert.equal(statuses(ctx.github, 14).at(-1), "7:blocked");
		const linked = runIdOf({ repo, issue: 14, eventId: String(EVENT_ID + 50) });
		assert.equal(ctx.files.links.get(linked)?.prevRunId, runOf(14));
		assert.match(
			ctx.executor.launches[1]?.prompt ?? "",
			/PRESERVED-OWNER-ANSWER/,
		);
	});

	it("settles a same-second owner relabel during a lost label removal without stalling reporting", async () => {
		const ctx = world();
		const write = writesWire(ctx.github, []);
		const issue = ctx.github.add(labeled(14));
		ctx.executor.outputs = [QUESTIONS_TEXT];
		ctx.executor.behaviors = [{ kind: "pass", usage: 3 }];
		let removals = 0;
		ctx.wire.intercept = async (command, args) => {
			if (
				args.includes("DELETE") &&
				args.some((arg) => arg.endsWith("labels/factory%3Aready"))
			) {
				removals++;
				await write(command, args);
				issue.labels.push(READY_LABEL);
				issue.timeline.push(
					labelEvent({
						id: EVENT_ID + 60,
						at: ctx.github.now,
						actor: "giuseppecrj",
					}),
				);

				return networkError();
			}

			return write(command, args);
		};

		const controller = ctx.start();
		await once(controller);
		ctx.github.now = "2026-10-29T02:10:00Z";
		ctx.clock.t += 600_000;
		const report = await once(controller);
		assert.equal(statuses(ctx.github, 14).at(-1), "3:needs_info");
		assert.equal(report.runs.length, 0);
		assert.equal(removals, 1);
		assert.ok(
			ctx.logs.some(
				({ event, fields }) =>
					event === "ready_label_preserved" && fields.why === "tied",
			),
		);
		assert.deepEqual(report.refused, [
			{ issue: 14, reasons: ["ambiguous_snapshot"] },
		]);
	});

	it("releases a recovering run when its issue closes without posting questions or labels again", async () => {
		const ctx = world();
		const writes: string[] = [];
		ctx.wire.intercept = writesWire(ctx.github, writes);
		const issue = ctx.github.add(labeled(14));
		ctx.github.posts = ["ok", "ok", "ok", "lost"];
		ctx.executor.outputs = [QUESTIONS_TEXT];
		ctx.executor.behaviors = [{ kind: "pass", usage: 3 }];
		await once(ctx.start());
		ctx.executor.checkoutResult = "unavailable";
		ctx.clock.t += 60_000;
		const restarted = ctx.start();
		await once(restarted);
		assert.equal(restarted.state.runs.get(14)?.phase.kind, "recovering");
		issue.state = "closed";
		issue.updatedAt = "2026-10-29T02:30:00Z";
		ctx.github.now = issue.updatedAt;
		writes.length = 0;
		ctx.clock.t += 31 * 60_000;
		await once(restarted);
		ctx.executor.checkoutResult = "ready";
		ctx.clock.t += 60_000;
		await once(restarted);
		assert.equal(statuses(ctx.github, 14).at(-1), "3:released");
		assert.deepEqual(writes, ["marker:released"]);
		assert.equal(ctx.executor.launches.length, 1);
	});

	it("waits through transient recovery reads after ready was removed, then finishes needs_info", async () => {
		const ctx = world();
		ctx.wire.intercept = writesWire(ctx.github, []);
		ctx.github.add(labeled(14));
		ctx.github.posts = ["ok", "ok", "ok", "lost"];
		ctx.executor.outputs = [QUESTIONS_TEXT];
		ctx.executor.behaviors = [{ kind: "pass", usage: 3 }];
		await once(ctx.start());
		assert.deepEqual(statuses(ctx.github, 14), ["1:claimed", "2:running"]);
		ctx.executor.checkoutResult = "unavailable";
		ctx.clock.t += 60_000;
		const restarted = ctx.start();
		await once(restarted);
		assert.deepEqual(statuses(ctx.github, 14), ["1:claimed", "2:running"]);
		ctx.clock.t += 60_000;
		await once(restarted);
		assert.deepEqual(statuses(ctx.github, 14), ["1:claimed", "2:running"]);
		ctx.executor.checkoutResult = "ready";
		ctx.clock.t += 60_000;
		await once(restarted);
		assert.equal(statuses(ctx.github, 14).at(-1), "3:needs_info");
		assert.equal(ctx.executor.launches.length, 1);
	});

	it("posts one questions comment, swaps the labels, then ends needs_info and spends nothing more", async () => {
		const { github, clock, files, executor, wire, logs, start } = world();
		const writes: string[] = [];

		wire.intercept = writesWire(github, writes);
		github.add(labeled(14));
		executor.outputs = [QUESTIONS_TEXT];
		executor.behaviors = [{ kind: "pass", usage: 300 }];

		const controller = start();
		const first = await once(controller);

		assert.deepEqual(writes, [
			"marker:claimed",
			"marker:running",
			"questions",
			"label+factory:needs-info",
			"label-factory:ready",
			"marker:needs_info",
		]);
		assert.deepEqual(statuses(github, 14), [
			"1:claimed",
			"2:running",
			"3:needs_info",
		]);
		assert.deepEqual(github.issues.get(14)?.labels, ["factory:needs-info"]);
		assert.deepEqual(
			logs
				.filter(({ event }) => event === "label_write")
				.map(({ fields }) => fields.outcome),
			["posted", "posted"],
		);
		assert.equal(first.totals.usage, 300);
		assert.equal(files.contracts.size, 0);
		assert.ok(files.questions.has(runOf(14)));

		const [asked] = keyed(github, 14, "questions");

		assert.ok(
			asked?.includes(
				"Should the version come from package\\.json or a constant?",
			),
		);
		assert.ok(
			asked?.includes(
				`(https://github.com/${FAKE_REPO}/blob/${MAIN_SHA}/server/cli.ts#L1)`,
			),
		);

		writes.length = 0;

		for (let n = 0; n < 3; n++) {
			clock.t += 60_000;

			const report = await once(controller);

			assert.equal(report.totals.usage, 300);
		}

		assert.equal(executor.launches.length, 1);
		assert.deepEqual(writes, []);
	});

	it("posts the questions once when the first POST's outcome is unknown", async () => {
		const { github, clock, executor, wire, start } = world();

		wire.intercept = writesWire(github, []);
		github.add(labeled(14));
		github.posts = ["ok", "ok", "landed_unanswered"];
		executor.outputs = [QUESTIONS_TEXT];
		executor.behaviors = [{ kind: "pass", usage: 300 }];

		const controller = start();

		await controller.tick();
		await settle();
		await controller.drain(async () => settle());

		assert.equal(keyed(github, 14, "questions").length, 1);

		clock.t += 1_000;
		await once(controller);

		assert.equal(keyed(github, 14, "questions").length, 1);
		assert.deepEqual(statuses(github, 14), [
			"1:claimed",
			"2:running",
			"3:needs_info",
		]);
	});

	it("resumes an interrupted specify review in the same attempt and counts recorded sessions once", async () => {
		const ctx = world();
		const { github, executor, clock } = ctx;

		github.add(labeled(14));
		executor.behaviors = [{ kind: "hang" }];
		await ctx.start().tick();
		assert.deepEqual(statuses(github, 14), ["1:claimed", "2:running"]);

		executor.pending = true;
		executor.spentBy.set("specify-1", 300);
		executor.behaviors = [{ kind: "pass", usage: 20 }];
		clock.t += 60_000;
		const report = await once(ctx.start());

		assert.equal(
			executor.launches.filter((l) => l.stage === "specify").length,
			2,
		);
		assert.equal(executor.launches[1]?.attempt, 1);
		assert.equal(
			executor.launches[1]?.remainingRunTokens,
			TRUSTED_RUN_CAP - 300,
		);
		assert.equal(report.totals.usage, 320);
		assert.deepEqual(statuses(github, 14), [
			"1:claimed",
			"2:running",
			"3:claimed",
			"4:running",
			"5:claimed",
			"6:blocked",
		]);
	});

	it("recovers an interrupted specify attempt from its kept output without a second comment or launch", async () => {
		const ctx = world();
		const { github, executor, logs, wire } = ctx;
		const writes: string[] = [];

		wire.intercept = writesWire(github, writes);
		github.add(labeled(14));
		github.posts = ["ok", "ok", "ok", "lost"];
		executor.outputs = [QUESTIONS_TEXT];
		executor.behaviors = [{ kind: "pass", usage: 300 }];

		await once(ctx.start());

		assert.deepEqual(writes, [
			"marker:claimed",
			"marker:running",
			"questions",
			"label+factory:needs-info",
			"label-factory:ready",
			"marker:needs_info",
		]);
		assert.deepEqual(statuses(github, 14), ["1:claimed", "2:running"]);

		writes.length = 0;
		github.now = "2026-10-29T02:05:00Z";
		ctx.clock.t += 60_000;

		await once(ctx.start());

		assert.equal(executor.launches.length, 1);
		assert.equal(keyed(github, 14, "questions").length, 1);
		assert.deepEqual(statuses(github, 14), [
			"1:claimed",
			"2:running",
			"3:needs_info",
		]);
		assert.ok(logs.some((entry) => entry.event === "stage_recovered"));
		assert.deepEqual(writes, ["marker:needs_info"]);
	});
});

describe("specify: linked runs and answers", () => {
	const NEXT_EVENT = 34537529999;
	const nextRun = runIdOf({ repo, issue: 14, eventId: String(NEXT_EVENT) });

	async function askedThenRelabeled(
		answers: (github: FakeGitHub, issue: FakeIssue) => void,
		labelAt = "2026-10-29T02:20:00Z",
		configure: (ctx: ReturnType<typeof world>) => void = () => undefined,
	) {
		const ctx = world();
		const writes: string[] = [];

		ctx.wire.intercept = writesWire(ctx.github, writes);

		const issue = ctx.github.add(labeled(14));

		ctx.executor.outputs = [QUESTIONS_TEXT, CONTRACT_TEXT];
		ctx.executor.behaviors = [
			{ kind: "pass", usage: 300 },
			{ kind: "pass", usage: 900 },
		];

		const controller = ctx.start();

		await once(controller);

		ctx.github.now = "2026-10-29T02:10:00Z";
		answers(ctx.github, issue);
		ctx.github.now = labelAt;
		issue.labels.push(READY_LABEL);
		issue.timeline.push(
			labelEvent({ id: NEXT_EVENT, at: labelAt, actor: "giuseppecrj" }),
		);
		issue.updatedAt = labelAt;
		ctx.github.now = "2026-10-29T02:31:00Z";
		ctx.clock.t += 31 * 60_000;
		writes.length = 0;
		configure(ctx);

		const report = await once(controller);

		return { ...ctx, controller, report, writes, issue };
	}

	const user = (login: string) => ({
		login,
		type: "User" as const,
		appSlug: null,
	});

	it("continues after an explicitly unlinked needs_info run following a delayed questions comment (T-STUCK)", async () => {
		const ctx = world();
		const write = writesWire(ctx.github, []);
		const state = stateDir();
		const disk = fileRunFiles(state);
		ctx.files.writeLink = disk.writeLink;
		ctx.files.readLink = disk.readLink;
		ctx.files.writeAnswers = disk.writeAnswers;
		ctx.files.readAnswers = disk.readAnswers;
		let allowQuestions = false;
		ctx.wire.intercept = async (command, args) =>
			!allowQuestions &&
			args.some(
				(arg) =>
					arg.startsWith("body=") && arg.includes("<!-- factory-questions "),
			)
				? networkError()
				: write(command, args);
		const issue = ctx.github.add(labeled(14));
		ctx.executor.outputs = [QUESTIONS_TEXT, QUESTIONS_TEXT, CONTRACT_TEXT];
		ctx.executor.behaviors = [
			{ kind: "pass", usage: 3 },
			{ kind: "pass", usage: 3 },
			{ kind: "pass", usage: 3 },
		];
		const controller = ctx.start();
		await once(controller);
		assert.equal(controller.state.runs.get(14)?.phase.kind, "reporting");
		issue.timeline.push(
			labelEvent({
				id: EVENT_ID + 70,
				at: "2026-10-29T02:00:29Z",
				actor: "giuseppecrj",
				event: "unlabeled",
			}),
			labelEvent({
				id: EVENT_ID + 71,
				at: "2026-10-29T02:00:30Z",
				actor: "giuseppecrj",
			}),
		);
		issue.updatedAt = "2026-10-29T02:00:30Z";
		allowQuestions = true;

		for (let n = 2; n <= 5; n++) {
			ctx.github.now = `2026-10-29T02:0${n}:00Z`;
			ctx.clock.t += 60_000;
			await once(controller);
		}

		assert.equal(statuses(ctx.github, 14).at(-1), "6:needs_info");

		const unlinkedRun = runIdOf({
			repo,
			issue: 14,
			eventId: String(EVENT_ID + 71),
		});

		assert.ok(!ctx.logs.some(({ event }) => event === "run_linked"));

		ctx.github.now = "2026-10-29T02:10:00Z";
		ctx.github.comment(issue, "OWNER-ANSWER", user("giuseppecrj"));
		ctx.github.now = "2026-10-29T02:11:00Z";
		issue.labels.push(READY_LABEL);
		issue.timeline.push(
			labelEvent({
				id: EVENT_ID + 72,
				at: ctx.github.now,
				actor: "giuseppecrj",
			}),
		);
		issue.updatedAt = ctx.github.now;
		ctx.github.now = "2026-10-29T02:20:00Z";
		ctx.clock.t += 31 * 60_000;
		const report = await once(ctx.start());
		assert.deepEqual(report.refused, []);
		assert.equal(statuses(ctx.github, 14).at(-1), "10:blocked");
		assert.match(ctx.executor.launches[2]?.prompt ?? "", /OWNER-ANSWER/);
		assert.deepEqual(
			JSON.parse(
				readFileSync(join(state, "links", `${unlinkedRun}.json`), "utf8"),
			),
			{ version: 1, prevRunId: null },
		);
	});

	it("puts the original run ID on a linked terminal row without adding its tokens again", async () => {
		const outbox = fileLedgerOutbox(stateDir());

		const ctx = await askedThenRelabeled(
			(github, issue) => {
				github.comment(issue, "Use package.json.", user("giuseppecrj"));
			},
			undefined,
			({ files, executor }) => {
				Object.assign(files, { ledger: outbox });
				executor.outputs = [QUESTIONS_TEXT];
			},
		);

		const row = (await outbox.scan())?.[0]?.row?.row;
		assert.ok(row);
		assert.equal(row.runId, nextRun);
		assert.deepEqual(row.previousRunId, { kind: "known", value: runOf(14) });
		assert.equal(row.usage.tokens.total, 900);
		assert.equal(ctx.executor.launches.length, 2);
	});

	it("links a relabel after needs_info to the earlier run and feeds it only authorized answers", async () => {
		const { github, files, executor, logs, writes, report } =
			await askedThenRelabeled((github, issue) => {
				github.comment(issue, "Use package.json.", user("giuseppecrj"));
				github.comment(issue, "Use a constant.", user("triager"));
				github.comment(issue, "Bot echo.", {
					login: "dependabot[bot]",
					type: "Bot",
					appSlug: "dependabot",
				});
				github.comment(issue, "Edited after the label.", {
					...user("writer"),
					lastEditedAt: "2026-10-29T02:25:00Z",
				});
				github.comment(issue, "Writer agrees: package.json.", user("writer"));
			});

		assert.deepEqual(statuses(github, 14), [
			"1:claimed",
			"2:running",
			"3:needs_info",
			"4:claimed",
			"5:running",
			"6:claimed",
			"7:blocked",
		]);
		assert.deepEqual(writes, [
			"marker:claimed",
			"label-factory:needs-info",
			"marker:running",
			"summary",
			"marker:claimed",
			"marker:blocked",
		]);
		assert.deepEqual(report.corrupt, []);

		const link = files.links.get(nextRun);
		const answers = files.answers.get(nextRun);

		assert.equal(link?.prevRunId, runOf(14));
		assert.equal(link?.answersDigest, answers?.digest);
		assert.deepEqual(
			answers?.answers.map((answer) => [answer.author, answer.body]),
			[
				["giuseppecrj", "Use package.json."],
				["writer", "Writer agrees: package.json."],
			],
		);
		assert.ok(answers?.questions.includes("package\\.json or a constant"));

		const prompt = executor.launches[1]?.prompt ?? "";

		assert.ok(
			prompt.includes('"author":"giuseppecrj","body":"Use package.json."'),
		);
		assert.ok(!prompt.includes("Use a constant."));
		assert.ok(!prompt.includes("Bot echo."));
		assert.match(prompt, /<previous-questions-[0-9a-f]{32}>/);

		const contract = JSON.parse(files.contracts.get(nextRun)?.bytes ?? "{}");

		assert.deepEqual(contract.link, {
			prevRunId: runOf(14),
			questionsDigest: link?.questionsDigest,
			answersDigest: answers?.digest,
		});
		assert.ok(link?.questionsDigest);
		assert.ok(
			logs.some(
				(entry) => entry.event === "run_linked" && entry.fields.answers === 2,
			),
		);
		assert.deepEqual(github.issues.get(14)?.labels, [READY_LABEL]);
	});

	async function thirdRound(
		ctx: Awaited<ReturnType<typeof askedThenRelabeled>>,
	) {
		ctx.github.now = "2026-10-29T02:40:00Z";
		ctx.github.comment(ctx.issue, "ROUND-TWO-ANSWER", user("giuseppecrj"));
		ctx.github.now = "2026-10-29T02:50:00Z";
		ctx.issue.labels.push(READY_LABEL);
		ctx.issue.timeline.push(
			labelEvent({
				id: NEXT_EVENT + 1,
				at: ctx.github.now,
				actor: "giuseppecrj",
			}),
		);
		ctx.issue.updatedAt = ctx.github.now;
		ctx.clock.t = Date.parse("2026-10-29T03:00:00Z");
		ctx.github.now = "2026-10-29T03:00:00Z";

		return once(ctx.controller);
	}

	for (const defect of [
		"answers_digest",
		"answers_missing",
		"answers_corrupt",
		"link_unreadable",
		"link_missing",
	] as const) {
		it(`refuses ${defect} in earlier clarification records once per issue change and keeps the reason in status JSON`, async () => {
			const ctx = await askedThenRelabeled(
				(github, issue) => {
					github.comment(issue, "ROUND-ONE-ANSWER", user("writer"));
				},
				undefined,
				({ executor }) => {
					executor.outputs = [QUESTIONS_TEXT];
				},
			);

			const kept = ctx.files.answers.get(nextRun);
			assert.ok(kept);

			if (defect === "answers_digest") {
				const altered = { ...kept, questions: "TAMPERED" };
				ctx.files.answers.set(nextRun, {
					...altered,
					digest: answersDigestOf(altered),
				});
			} else if (defect === "answers_missing") {
				ctx.files.answers.delete(nextRun);
			} else if (defect === "answers_corrupt") {
				ctx.files.answers.set(nextRun, { ...kept, questions: "TAMPERED" });
			} else if (defect === "link_unreadable") {
				const read = ctx.files.readLink.bind(ctx.files);
				ctx.files.readLink = async (id) =>
					id === nextRun ? { kind: "unreadable" } : read(id);
			} else {
				ctx.files.links.delete(nextRun);
			}

			const before = ctx.logs.length;

			const reason = defect.startsWith("link")
				? "link_record_invalid"
				: "answers_record_invalid";

			const expected = [{ issue: 14, reasons: [reason] }];
			assert.deepEqual((await thirdRound(ctx)).refused, expected);
			const state = stateDir();

			for (let n = 0; n < 3; n++) {
				ctx.clock.t += 60_000;
				const report = await once(ctx.controller);
				assert.equal(await writeStatus(state, report, EXE_DEV_PLATFORM), true);

				const status = await cli(
					["status", "--json", "--repo", repo, "--state-dir", state],
					ctx.github,
				);

				assert.equal(status.code, EXIT.ok);
				assert.deepEqual(
					JSON.parse(status.stdout).controller.lastTick.refused,
					expected,
				);
			}

			assert.equal(ctx.executor.launches.length, 2);

			const refusals = () =>
				ctx.logs
					.slice(before)
					.filter(({ event }) => event === "admission_refused");

			assert.equal(refusals().length, 1);
			assert.equal(refusals()[0]?.fields.retry, false);
			assert.equal(
				refusals()[0]?.fields.detail,
				defect.startsWith("link") ? "previous_link" : "previous_answers",
			);
			ctx.issue.updatedAt = "2026-10-29T03:05:00Z";
			ctx.clock.t += 600_000;
			await once(ctx.controller);
			assert.equal(refusals().length, 2);
		});
	}

	for (const outcome of ["unknown", "rejected"] as const) {
		it(`never gates or fails a linked run on ${outcome} cosmetic label removals and logs every retry`, async () => {
			const ctx = await askedThenRelabeled(
				(github, issue) => {
					github.comment(issue, "Use package.json.", user("writer"));
				},
				undefined,
				({ wire, github, executor }) => {
					const write = writesWire(github, []);
					wire.intercept = async (command, args) =>
						args.includes("DELETE") &&
						args.some((arg) => arg.endsWith("labels/factory%3Aneeds-info"))
							? outcome === "unknown"
								? networkError()
								: httpError(422, "denied")
							: write(command, args);
					executor.fallback = { kind: "unavailable" };
					executor.behaviors = [];
				},
			);

			assert.equal(ctx.executor.launches.length, 2);

			for (let n = 0; n < 4; n++) {
				ctx.clock.t += 60_000;
				await once(ctx.controller);
			}

			assert.ok(
				ctx.logs.filter(
					({ event, fields }) =>
						event === "label_write" &&
						fields.label === "factory:needs-info" &&
						fields.outcome === outcome,
				).length >= 4,
			);
			ctx.executor.behaviors = [{ kind: "pass", usage: 1 }];
			ctx.clock.t += 60_000;
			await once(ctx.controller);
			assert.equal(statuses(ctx.github, 14).at(-1)?.endsWith(":blocked"), true);
			assert.ok(ctx.files.contracts.has(nextRun));
			assert.ok(
				!ctx.logs.some(({ event }) => event === "label_retries_exhausted"),
			);
		});
	}

	it("does not remove and re-add a linked run's own needs-info after a crash before its marker", async () => {
		const writes: string[] = [];

		const ctx = await askedThenRelabeled(
			(github, issue) => {
				github.comment(issue, "ROUND-ONE-ANSWER", user("writer"));
			},
			undefined,
			({ executor, github, wire }) => {
				executor.outputs = [QUESTIONS_TEXT];
				github.posts = ["ok", "ok", "ok", "lost"];
				wire.intercept = writesWire(github, writes);
			},
		);

		writes.length = 0;
		ctx.clock.t += 60_000;
		await once(ctx.start());
		assert.equal(statuses(ctx.github, 14).at(-1), "6:needs_info");
		assert.ok(!writes.includes("label-factory:needs-info"));
		assert.ok(
			ctx.logs.some(({ event }) => event === "ready_label_already_removed"),
		);
	});

	it("reconstructs every earlier question round from legacy accumulated records after a restart", async () => {
		const ctx = await askedThenRelabeled(
			(github, issue) => {
				github.comment(issue, "ROUND-ONE-ANSWER", user("writer"));
			},
			undefined,
			({ executor }) => {
				executor.outputs = [
					JSON.stringify({
						kind: "questions",
						questions: [{ text: "SECOND-QUESTION?" }],
					}),
				];
			},
		);

		ctx.executor.outputs = [
			JSON.stringify({
				kind: "questions",
				questions: [{ text: "THIRD-QUESTION?" }],
			}),
		];
		ctx.executor.behaviors = [{ kind: "pass", usage: 1 }];
		await thirdRound(ctx);

		const thirdRun = runIdOf({
			repo,
			issue: 14,
			eventId: String(NEXT_EVENT + 1),
		});

		for (const id of [nextRun, thirdRun]) {
			const record = ctx.files.answers.get(id);
			const link = ctx.files.links.get(id);
			assert.ok(record && link);
			const { rounds: _rounds, ...legacy } = record;
			const digest = answersDigestOf(legacy);
			ctx.files.answers.set(id, { ...legacy, digest });
			ctx.files.links.set(id, { ...link, answersDigest: digest });
		}

		ctx.github.now = "2026-10-29T03:10:00Z";
		ctx.github.comment(ctx.issue, "ROUND-THREE-ANSWER", user("writer"));
		ctx.github.now = "2026-10-29T03:20:00Z";
		ctx.issue.labels.push(READY_LABEL);
		ctx.issue.timeline.push(
			labelEvent({
				id: NEXT_EVENT + 2,
				at: ctx.github.now,
				actor: "giuseppecrj",
			}),
		);
		ctx.issue.updatedAt = ctx.github.now;
		ctx.clock.t = Date.parse("2026-10-29T03:30:00Z");
		ctx.github.now = "2026-10-29T03:30:00Z";
		ctx.executor.behaviors = [{ kind: "pass", usage: 1 }];
		await once(ctx.start());
		const prompt = ctx.executor.launches[3]?.prompt.replaceAll("\\", "") ?? "";

		const positions = [
			"package.json or a constant",
			"ROUND-ONE-ANSWER",
			"SECOND-QUESTION",
			"ROUND-TWO-ANSWER",
			"THIRD-QUESTION",
			"ROUND-THREE-ANSWER",
		].map((text) => prompt.indexOf(text));

		assert.ok(
			positions.every(
				(at, index) =>
					at >= 0 && (index === 0 || at > (positions[index - 1] ?? -1)),
			),
		);
	});

	it("carries both clarification rounds in order with authors, distinct questions and a digest of the whole set", async () => {
		const ctx = await askedThenRelabeled(
			(github, issue) => {
				github.comment(issue, "ROUND-ONE-ANSWER", user("writer"));
			},
			undefined,
			({ executor }) => {
				executor.outputs = [
					JSON.stringify({
						kind: "questions",
						questions: [{ text: "ROUND-TWO-QUESTION?" }],
					}),
				];
			},
		);

		assert.equal(statuses(ctx.github, 14).at(-1), "6:needs_info");
		ctx.github.now = "2026-10-29T02:40:00Z";
		ctx.github.comment(ctx.issue, "ROUND-TWO-ANSWER", user("giuseppecrj"));
		ctx.github.now = "2026-10-29T02:50:00Z";
		ctx.issue.labels.push(READY_LABEL);
		ctx.issue.timeline.push(
			labelEvent({
				id: NEXT_EVENT + 1,
				at: ctx.github.now,
				actor: "giuseppecrj",
			}),
		);
		ctx.issue.updatedAt = ctx.github.now;
		ctx.clock.t = Date.parse("2026-10-29T03:00:00Z");
		ctx.github.now = "2026-10-29T03:00:00Z";
		ctx.executor.behaviors = [{ kind: "pass", usage: 5 }];
		await once(ctx.controller);

		const finalRun = runIdOf({
			repo,
			issue: 14,
			eventId: String(NEXT_EVENT + 1),
		});

		const record = ctx.files.answers.get(finalRun);
		assert.ok(record);
		assert.deepEqual(
			record.answers.map(({ author, body }) => [author, body]),
			[
				["writer", "ROUND-ONE-ANSWER"],
				["giuseppecrj", "ROUND-TWO-ANSWER"],
			],
		);
		assert.equal(record.digest, answersDigestOf(record));
		assert.notEqual(
			record.digest,
			answersDigestOf({ ...record, answers: record.answers.slice(1) }),
		);
		const prompt = ctx.executor.launches[2]?.prompt ?? "";
		assert.ok(
			prompt.indexOf("ROUND-ONE-ANSWER") < prompt.indexOf("ROUND-TWO-ANSWER"),
		);
		assert.match(prompt, /ROUND-ONE-ANSWER/);
		assert.match(prompt, /ROUND-TWO-ANSWER/);
		const readable = prompt.replaceAll("\\", "");
		assert.ok(readable.includes("package.json or a constant"));
		assert.match(readable, /ROUND-TWO-QUESTION/);
		const firstQuestion = readable.indexOf("package");
		assert.ok(firstQuestion < readable.indexOf("ROUND-ONE-ANSWER"));
		assert.ok(
			readable.indexOf("ROUND-ONE-ANSWER") <
				readable.indexOf("ROUND-TWO-QUESTION"),
		);
		assert.ok(
			readable.indexOf("ROUND-TWO-QUESTION") <
				readable.indexOf("ROUND-TWO-ANSWER"),
		);
	});

	it("excludes a pre-question id, a post-label comment and an edit in the label second", async () => {
		const { files } = await askedThenRelabeled((github, issue) => {
			const asked = issue.comments.find((comment) =>
				comment.body.includes("<!-- factory-questions "),
			);

			assert.ok(asked);
			github.comment(issue, "PRE-QUESTION", {
				...user("writer"),
				id: 1,
				createdAt: "2026-10-29T01:59:00Z",
			});
			github.comment(issue, "SAME-SECOND-EDIT", {
				...user("writer"),
				lastEditedAt: "2026-10-29T02:20:00Z",
			});
			github.comment(issue, "VALID", user("writer"));
			github.now = "2026-10-29T02:21:00Z";
			github.comment(issue, "POST-LABEL", user("writer"));
		});

		assert.deepEqual(
			files.answers.get(nextRun)?.answers.map(({ body }) => body),
			["VALID"],
		);
	});

	it("refuses a label in the needs_info marker's second", async () => {
		const { report, executor, files, logs } = await askedThenRelabeled(
			(_github, issue) => {
				const marker = issue.comments.findLast(
					(comment) => parseMarker(comment.body).kind === "marker",
				);

				assert.ok(marker);
				marker.createdAt = "2026-10-29T02:01:00Z";
			},
			"2026-10-29T02:01:00Z",
		);

		assert.deepEqual(report.refused, [
			{ issue: 14, reasons: ["ambiguous_snapshot"] },
		]);
		assert.equal(executor.launches.length, 1);
		assert.equal(files.links.size, 0);
		assert.ok(
			logs.some(
				({ event, fields }) =>
					event === "admission_refused" &&
					fields.detail === "answer_at_label_time",
			),
		);
	});

	it("persists the link and answers on disk before a rejected writeClaim and reuses their digest", async () => {
		let keptDigest = "";

		const ctx = await askedThenRelabeled(
			(github, issue) => {
				github.comment(issue, "Use package.json.", user("writer"));
			},
			undefined,
			({ files }) => {
				const disk = fileRunFiles(stateDir());
				const write = files.writeClaim.bind(files);
				files.writeAnswers = disk.writeAnswers;
				files.writeLink = disk.writeLink;
				files.readAnswers = disk.readAnswers;
				files.readLink = disk.readLink;
				files.writeClaim = async (claim) => {
					if (claim.runId !== nextRun) return write(claim);
					const link = await disk.readLink(nextRun);
					const answers = await disk.readAnswers(nextRun);
					assert.equal(link.kind, "found");
					assert.ok(answers);
					keptDigest = answers.digest;

					return false;
				};
			},
		);

		assert.ok(keptDigest);
		assert.equal(ctx.executor.launches.length, 1);
		ctx.files.writeClaim = async (claim) => {
			ctx.files.claims.set(claim.runId, claim);

			return true;
		};

		ctx.clock.t += 60_000;
		await once(ctx.controller);
		assert.equal((await ctx.files.readAnswers(nextRun))?.digest, keptDigest);
		assert.equal(
			ctx.executor.launches.filter((l) => l.stage === "specify").length,
			2,
		);
	});

	it("caches answer permissions once per author within admission", async () => {
		let permissionCalls = 0;
		await askedThenRelabeled(
			(github, issue) => {
				for (const body of ["first", "second", "third"])
					github.comment(issue, body, user("writer"));
			},
			undefined,
			({ github }) => {
				github.beforeCall = (args) => {
					if (
						args.some((arg) => arg.includes("collaborators/writer/permission"))
					)
						permissionCalls++;
				};
			},
		);
		assert.equal(permissionCalls, 1);
	});

	it("retries stale needs-info removal after adopting the linked claim", async () => {
		const ctx = await askedThenRelabeled(
			() => undefined,
			undefined,
			({ wire, github, executor }) => {
				const write = writesWire(github, []);
				wire.intercept = async (command, args) =>
					args.some((arg) => arg.endsWith("labels/factory%3Aneeds-info"))
						? httpError(422, "denied")
						: write(command, args);
				executor.behaviors = [{ kind: "unavailable" }];
			},
		);

		assert.ok(ctx.issue.labels.includes("factory:needs-info"));
		ctx.wire.intercept = writesWire(ctx.github, []);
		ctx.executor.behaviors = [{ kind: "pass", usage: 1 }];
		ctx.clock.t += 60_000;
		await once(ctx.start());
		assert.ok(!ctx.issue.labels.includes("factory:needs-info"));
	});

	it("still links a relabel with no answers, for an owner who edited the body", async () => {
		const { github, files } = await askedThenRelabeled(() => undefined);

		assert.equal(statuses(github, 14).at(-1), "7:blocked");
		assert.equal(files.links.get(nextRun)?.prevRunId, runOf(14));
		assert.deepEqual(files.answers.get(nextRun)?.answers, []);
	});

	it("refuses a relabel in the same second as an answer, as ambiguous", async () => {
		const { github, files, executor, logs, report } = await askedThenRelabeled(
			(github, issue) => {
				github.now = "2026-10-29T02:20:00Z";
				github.comment(issue, "Use package.json.", user("giuseppecrj"));
			},
		);

		assert.deepEqual(report.refused, [
			{ issue: 14, reasons: ["ambiguous_snapshot"] },
		]);
		assert.equal(executor.launches.length, 1);
		assert.equal(statuses(github, 14).length, 3);
		assert.equal(files.links.size, 0);
		assert.ok(
			logs.some(
				(entry) =>
					entry.event === "admission_refused" &&
					entry.fields.detail === "answer_at_label_time",
			),
		);
	});

	it("starts nothing on an answer without a fresh ready label", async () => {
		const { github, clock, executor, wire, start } = world();
		const issue = github.add(labeled(14));

		wire.intercept = writesWire(github, []);
		executor.outputs = [QUESTIONS_TEXT];
		executor.behaviors = [{ kind: "pass", usage: 300 }];

		const controller = start();

		await once(controller);
		assert.deepEqual(issue.labels, ["factory:needs-info"]);
		github.now = "2026-10-29T02:10:00Z";
		github.comment(issue, "Use package.json.", user("giuseppecrj"));
		clock.t += 60_000;
		await once(controller);

		assert.equal(executor.launches.length, 1);
		assert.equal(statuses(github, 14).length, 3);
	});
});
