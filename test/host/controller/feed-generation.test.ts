import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import {
	chmod,
	mkdir,
	lstat,
	mkdtemp,
	readFile,
	rm,
	symlink,
	writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { promisify } from "node:util";
import { serveLoop } from "../../../host/controller/serve-loop.ts";
import {
	readFeedGeneration,
	refreshFeedGeneration,
} from "../../../host/controller/feed-generation.ts";
import { readOwnerFeed } from "../../../host/cli/owner-feed.ts";
import { acquireLock, procTable } from "../../../host/controller/lock.ts";
import type { TickReport } from "../../../src/controller/orchestrator.ts";
import { digestOf } from "../../../src/core/run.ts";
import { EXE_DEV_PLATFORM } from "../../../src/trust/platform.ts";
import { snapshotDigest } from "../../../src/trust/admission.ts";
import { ledgerRowOf, legacyRunContext } from "../../../src/ledger/schema.ts";
import { isGitSha } from "../../../src/config/schema.ts";
import {
	addRun,
	ownerState,
	now,
	repo,
	save,
} from "../../fixtures/owner-feed/state.ts";

import { runCli } from "../../../host/cli/index.ts";
import { realRuntime } from "../../../host/cli/platform.ts";
import { FakeGitHub } from "../../fake-ticket-adapter.ts";
import { FakeExecutor } from "../../src/controller/orchestrator-fixtures.ts";
import { noPlatformFile } from "../../helpers.ts";

const run = promisify(execFile);

async function fixture(body: (root: string) => Promise<void>) {
	const root = await mkdtemp(join(tmpdir(), "feed-generation-"));

	try {
		await ownerState(root);
		await body(root);
	} finally {
		await rm(root, { recursive: true, force: true });
	}
}

async function tick(root: string, at = now) {
	const status = JSON.parse(await readFile(join(root, "status.json"), "utf8"));
	const stop = new AbortController();
	await serveLoop({
		stateDir: root,
		platform: EXE_DEV_PLATFORM,
		durableUsage: () => status.durableUsage,
		orchestrator: {
			pollIntervalMs: 1,
			tick: async () =>
				({ ...status, at: new Date(at).toISOString() }) satisfies TickReport,
		},
		signal: stop.signal,
		sleep: async () => {
			stop.abort();
		},
		log: () => undefined,
		notify: async () => undefined,
	});

	return readFile(join(root, "feed-generation"), "utf8");
}

async function changed(
	root: string,
	mutate: () => Promise<void | string>,
	label = "feed input",
) {
	const before = await tick(root);
	await mutate();
	assert.notEqual(await tick(root), before, label);
}

test("feed generation is stable across routine status rewrites and a fresh serve loop", async () => {
	await fixture(async (root) => {
		const first = await tick(root);
		const info = await lstat(join(root, "feed-generation"));
		assert.match(first, /^[a-f0-9]{64}\n$/);
		assert.equal(await tick(root, now + 31_000), first);
		assert.equal(await tick(root, now + 62_000), first);
		assert.equal((await lstat(join(root, "feed-generation"))).ino, info.ino);
		assert.equal(info.mode & 0o777, 0o600);
		assert.equal(info.uid, process.geteuid?.());
		assert.equal(info.isSymbolicLink(), false);
	});
});

test("feed generation changes for rendered status and claims but not unused status fields", async () => {
	await fixture(async (root) => {
		const before = await tick(root);

		const status = JSON.parse(
			await readFile(join(root, "status.json"), "utf8"),
		);

		await save(root, ["status.json"], { ...status, pollDurationMs: 77 });
		assert.equal(await tick(root), before);
		await changed(root, () =>
			save(root, ["status.json"], { ...status, corrupt: [{ issue: 123 }] }),
		);
		await changed(root, () => addRun(root, 20, "running"));

		const current = JSON.parse(
			await readFile(join(root, "status.json"), "utf8"),
		);

		await changed(root, () =>
			save(root, ["status.json"], {
				...current,
				durableUsage: { kind: "exact", total: 40 },
			}),
		);
	});
});

test("feed generation changes for digest-bound admissions and intake markers", async () => {
	await fixture(async (root) => {
		await addRun(root, 20, "running");
		const parts = ["admissions", "github", ...repo.split("/"), "20", "1.json"];
		const stored = JSON.parse(await readFile(join(root, ...parts), "utf8"));
		const snapshot = { ...stored.snapshot, title: "A changed title" };
		await changed(root, () =>
			save(root, parts, {
				...stored,
				snapshot,
				receipt: {
					...stored.receipt,
					snapshotDigest: snapshotDigest(snapshot),
				},
			}),
		);

		const intake = {
			...snapshot,
			body: "<!-- factory-intake: shep-123456 -->",
		};

		await changed(root, () =>
			save(root, parts, {
				...stored,
				snapshot: intake,
				receipt: { ...stored.receipt, snapshotDigest: snapshotDigest(intake) },
			}),
		);
	});
});

test("feed generation changes for ledger terminal records and frozen rows", async () => {
	await fixture(async (root) => {
		const id = (
			await readOwnerFeed({ stateDir: root, repo, now })
		).entries.find((entry) => entry.issue === 4)?.runId;

		assert.ok(id);

		const terminal = JSON.parse(
			await readFile(join(root, "ledger", id, "terminal.json"), "utf8"),
		);

		await changed(root, () =>
			save(root, ["ledger", id, "terminal.json"], {
				...terminal,
				terminalObservedAt: new Date(now - 2000).toISOString(),
			}),
		);
		await changed(root, () =>
			writeFile(
				join(root, "ledger", id, "row.json"),
				ledgerRowOf({
					v: 1,
					repo,
					runId: id,
					issue: 4,
					eventId: "1",
					eventAt: new Date(now - 86_400_000).toISOString(),
					previousRunId: { kind: "known", value: null },
					snapshotDigest: digestOf("snapshot"),
					originalBase: "a".repeat(40),
					startedAt: {
						kind: "known",
						value: new Date(now - 10_000).toISOString(),
					},
					terminalObservedAt: new Date(now - 3000).toISOString(),
					provenance: {
						kind: "legacy_import",
						workflowSha: "a".repeat(40),
						workflowDigest: digestOf("workflow"),
						gates: { kind: "unavailable", reason: "legacy_not_recorded" },
						autonomy: { kind: "unavailable", reason: "legacy_not_recorded" },
					},
					terminalMarker: { seq: 2, digest: digestOf("marker") },
					outcome: { kind: "needs_info", stage: "specify" },
					pr: null,
					artifacts: { kind: "admission" },
					repairRounds: {
						kind: "known",
						value: { authorized: 0, started: 0, completed: 0 },
					},
					stages: { kind: "known", value: [] },
					models: { kind: "known", value: [] },
					usage: {
						tokens: { kind: "exact", unit: "tokens", total: 0 },
						parentTokens: { kind: "known", value: 0 },
						childTokens: { kind: "known", value: 0 },
						unattributedTokens: { kind: "known", value: 0 },
						money: { kind: "unavailable", reason: "provider_not_reported" },
					},
					interruptedAttempts: { kind: "known", value: 0 },
					contextPressure: { kind: "unavailable", reason: "not_instrumented" },
					redactedReceiptDigests: [],
					evidence: {
						issueUrl: `https://github.com/${repo}/issues/4`,
						ciUrls: [],
					},
				}).bytes,
				{ mode: 0o600 },
			),
		);
	});
});

test("feed generation changes for questions data and its bound comment reference", async () => {
	await fixture(async (root) => {
		const id = (
			await readOwnerFeed({ stateDir: root, repo, now })
		).entries.find((entry) => entry.issue === 8)?.runId;

		assert.ok(id);
		const digest = digestOf("questions");
		await save(root, ["contracts", id, "questions-comment.json"], {
			version: 1,
			runId: id,
			repo,
			issue: 8,
			digest,
			commentId: "12345",
		});
		await changed(root, () =>
			save(root, ["contracts", id, "questions.json"], {
				version: 1,
				runId: id,
				digest,
			}),
		);
		await changed(root, () =>
			save(root, ["contracts", id, "questions-comment.json"], {
				version: 1,
				runId: id,
				repo,
				issue: 8,
				digest,
				commentId: "12346",
			}),
		);
	});
});

test("feed generation changes for metrics, stage receipts, links, accounting and the local switch", async () => {
	await fixture(async (root) => {
		const id = await addRun(root, 20, "running");
		await changed(root, () =>
			save(root, ["metrics.json"], {
				computedAt: new Date(now).toISOString(),
				stale: true,
			}),
		);
		await changed(root, () =>
			save(root, ["stages", id, "build-1", "receipt.json"], {
				version: 1,
				runId: id,
				stage: "build",
				outcome: { kind: "passed" },
				turns: 1,
				wallMs: 20,
				usage: { total: 30 },
			}),
		);
		await changed(root, () =>
			save(root, ["links", `${id}.json`], {
				version: 1,
				prevRunId: digestOf("previous"),
				questionsDigest: digestOf("questions"),
				answersDigest: digestOf("answers"),
			}),
		);
		const sha = "a".repeat(40);
		assert.ok(isGitSha(sha));
		await changed(root, () =>
			save(root, ["accounting", id, "policy.json"], {
				v: 2,
				runId: id,
				startedAt: new Date(now).toISOString(),
				context: legacyRunContext(
					{
						workflowSha: sha,
						workflowDigest: digestOf("workflow"),
						trustedCap: 5000,
					},
					"legacy_not_recorded",
				),
			}),
		);
		await changed(root, () => save(root, ["disabled"], {}));
		await changed(root, () => rm(join(root, "disabled")));
	});
});

test("feed generation refuses symlinks and group-readable files for reading and publishing", async () => {
	await fixture(async (root) => {
		const first = await tick(root);
		assert.equal(await readFeedGeneration(root), first.trim());
		await chmod(join(root, "feed-generation"), 0o640);
		assert.equal(await readFeedGeneration(root), null);
		assert.equal(
			await refreshFeedGeneration({
				stateDir: root,
				repo,
				now,
				platform: EXE_DEV_PLATFORM,
			}),
			false,
		);
		await rm(join(root, "feed-generation"));
		await save(root, ["target"], { untouched: true });
		const target = await readFile(join(root, "target"));
		await symlink(join(root, "target"), join(root, "feed-generation"));
		assert.equal(await readFeedGeneration(root), null);
		assert.equal(
			await refreshFeedGeneration({
				stateDir: root,
				repo,
				now,
				platform: EXE_DEV_PLATFORM,
			}),
			false,
		);
		assert.ok((await readFile(join(root, "target"))).equals(target));
		assert.equal(
			(await lstat(join(root, "feed-generation"))).isSymbolicLink(),
			true,
		);
	});
});

test("feed generation includes validation verdicts, controller lock and platform repositories", async () => {
	await fixture(async (root) => {
		const id = await addRun(root, 20, "running", { stage: "validate" });

		const claim = JSON.parse(
			await readFile(join(root, "claims", `${id}.json`), "utf8"),
		);

		await save(root, ["claims", `${id}.json`], { ...claim, validation: {} });
		await changed(root, () =>
			save(root, ["validation", id, "verdict.json"], { pass: true }),
		);
		await changed(root, () =>
			save(root, ["validation", id, "verdict.json"], { pass: false }),
		);

		const before = await tick(root);

		const lock = await acquireLock({
			stateDir: root,
			procs: procTable(),
			now: () => now,
		});

		assert.equal(lock.kind, "acquired");

		if (lock.kind !== "acquired") assert.fail("fixture lock");

		try {
			assert.notEqual(await tick(root), before);
		} finally {
			await lock.lock.release();
		}

		await tick(root);
		assert.equal(
			await refreshFeedGeneration({
				stateDir: root,
				now,
				platform: { ...EXE_DEV_PLATFORM, repositories: [repo] },
			}),
			true,
		);
		assert.notEqual(
			await readFile(join(root, "feed-generation"), "utf8"),
			before,
		);
	});
});

test("feed generation retains time-driven stale and terminal-retention changes", async () => {
	await fixture(async (root) => {
		await addRun(root, 20, "blocked", {
			enteredAt: now - 6 * 3_600_000 + 1000,
		});
		const first = await tick(root);
		const stale = await tick(root, now + 1000);
		assert.notEqual(stale, first);
		assert.equal(await tick(root, now + 2000), stale);
		assert.notEqual(await tick(root, now + 8 * 86_400_000), stale);
	});
});

for (const command of ["tick", "serve"] as const) {
	test(`${command} publishes the stopped feed after releasing the controller lock`, async () => {
		const root = await mkdtemp(join(tmpdir(), "feed-generation-cli-"));

		try {
			await mkdir(join(root, "claims"), { mode: 0o700 });
			await save(root, ["disabled"], {});
			const cliRepo = EXE_DEV_PLATFORM.repositories[0];
			assert.ok(cliRepo);
			const github = new FakeGitHub(cliRepo);
			const stop = new AbortController();
			const executor = new FakeExecutor();
			const platform = EXE_DEV_PLATFORM;
			let running: string | null = null;
			assert.equal(
				await runCli(
					[
						command,
						...(command === "tick" ? ["--once", "--json"] : []),
						"--repo",
						cliRepo,
						"--state-dir",
						root,
						"--issue",
						"20",
					],
					{
						exec: github.exec,
						env: (name) => (name === "GH_HOST" ? platform.ghHost : undefined),
						readPlatformFile: noPlatformFile,
						stdout: () => undefined,
						stderr: () => undefined,
						runtime: {
							...realRuntime(),
							clock: { now: () => now },
							signal: stop.signal,
							executor: () => executor,
							sleep: async () => {
								running = await readFeedGeneration(root);
								stop.abort();
							},
						},
					},
				),
				0,
			);
			const stopped = await readFeedGeneration(root);
			assert.ok(stopped !== null);

			if (command === "serve") {
				assert.ok(running !== null);
				assert.notEqual(stopped, running);
			}

			assert.equal(
				(await readOwnerFeed({ stateDir: root, platform, now })).controller
					.state,
				"stopped",
			);
			assert.equal(
				await refreshFeedGeneration({ stateDir: root, platform, now }),
				true,
			);
			assert.equal(
				await readFeedGeneration(root),
				stopped,
				"shutdown published the current projection",
			);
			assert.equal(executor.launches.length, 0);
		} finally {
			await rm(root, { recursive: true, force: true });
		}
	});
}

test("real owner-feed CLI bytes are identical with and without the generation file", async () => {
	await fixture(async (root) => {
		const args = [
			"--import",
			new URL("../../fixtures/owner-feed/fixed-clock.ts", import.meta.url)
				.pathname,
			"host/cli/index.ts",
			"owner-feed",
			"--json",
			"--state-dir",
			root,
		];

		const env = { ...process.env, OWNER_FEED_FIXED_NOW: String(now) };
		await tick(root);
		await rm(join(root, "feed-generation"));
		const before = (await run(process.execPath, args, { env })).stdout;
		await tick(root);
		const after = (await run(process.execPath, args, { env })).stdout;
		assert.ok(Buffer.from(before).equals(Buffer.from(after)));
	});
});
