import assert from "node:assert/strict";
import {
	chmod,
	lstat,
	mkdir,
	mkdtemp,
	readFile,
	rm,
	utimes,
	writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import {
	readOwnerFeed,
	readOwnerHeader,
	readOwnerRun,
	type FeedEntry,
} from "../src/feed.ts";
import { acquireLock, procTable } from "../server/controller.ts";
import { ATTENTION_KINDS, readAttention } from "../src/attention.ts";
import { objectOf, parseJson } from "../src/core/json.ts";
import type { JsonValue } from "../src/core/json.ts";
import { runCli } from "../server/cli.ts";
import { digestOf } from "../src/core/run.ts";
import { AUTONOMY_DIGEST } from "../src/ledger.ts";
import { candidateLifecycleFixture, withUmask } from "./helpers.ts";
import {
	addRun,
	emptyState,
	ownerState,
	now,
	repo,
	save,
} from "./fixtures/owner-feed/state.ts";
import {
	CAPTURE_NAMES,
	CAPTURED_KINDS,
	captureFile,
	captureOwnerFeed,
	redactionProblems,
	type CaptureName,
} from "./fixtures/owner-feed/capture.ts";
import { v1Problems } from "./fixtures/owner-feed/contract.ts";
import { noPlatformFile } from "./helpers.ts";

async function state<T>(body: (root: string) => Promise<T>) {
	const root = await mkdtemp(join(tmpdir(), "owner-feed-"));

	try {
		await ownerState(root);
		await save(root, ["status.json"], {
			...JSON.parse(await readFile(join(root, "status.json"), "utf8")),
			durableUsage: { kind: "lower_bound", total: 5200000 },
		});

		return await body(root);
	} finally {
		await rm(root, { recursive: true, force: true });
	}
}

test("OwnerFeed v1 matches the golden offline contract, seven counts and ungrouped working count", async () => {
	await state(async (root) => {
		const feed = await readOwnerFeed({ stateDir: root, repo, now });

		const golden = JSON.parse(
			await readFile(
				new URL("./fixtures/owner-feed/feed-v1.json", import.meta.url),
				"utf8",
			),
		);

		assert.deepEqual(feed, golden);
		assert.equal(feed.version, 1);
		assert.equal(feed.counts.pr_review, 1);
		assert.equal(feed.counts.blocked, 1);
		assert.equal(feed.counts.budget, 1);
		assert.equal(feed.workingRunCount, 1);
		assert.ok(
			!feed.entries.some((entry) => entry.issue === 99 || entry.issue === 7),
		);
		assert.equal(feed.unreadable[0]?.issue, 99);
		assert.equal(
			feed.entries.find((entry) => entry.issue === 4)?.failure?.stage,
			"review",
		);
		assert.equal(
			(await readOwnerRun(root, feed.entries[0]?.runId ?? "", feed))?.title,
			feed.entries[0]?.title,
		);
	});
});

test("read CLI and feed perform no transport or model calls, including unavailable state", async () => {
	await state(async (root) => {
		let output = "";

		const exit = await runCli(["owner-feed", "--json", "--state-dir", root], {
			readPlatformFile: noPlatformFile,
			exec: async () => {
				throw new Error("read must not spawn");
			},
			env: () => undefined,
			stdout: (text) => {
				output += text;
			},
			stderr: assert.fail,
		});

		assert.equal(exit, 0);
		assert.equal(JSON.parse(output).version, 1);
		assert.equal(JSON.parse(output).repo, repo);
	});

	const unavailable = await readOwnerFeed({
		stateDir: "/not/a/controller",
		repo,
		now,
	});

	assert.deepEqual(unavailable.entries, []);
	assert.deepEqual(unavailable.gaps, ["state_unavailable"]);
	assert.equal(unavailable.controller.localSwitch, "unavailable");
});

test("thresholds are local projections, inclusive at the boundary, with future ages unknown", async () => {
	await state(async (root) => {
		const read = await readAttention({
			stateDir: root,
			repo,
			now,
			thresholds: { waitingMs: 4 * 86_400_000, blockedMs: 7 * 3_600_000 },
		});

		assert.equal(read.kind, "available");
		assert.equal(read.groups.pr_review[0]?.stale, true);
		assert.equal(read.groups.blocked[0]?.stale, true);
		await save(root, ["status.json"], {
			repo,
			attentionThresholds: {
				waitingMs: 5 * 86_400_000,
				blockedMs: 8 * 3_600_000,
			},
		});
		const feed = await readOwnerFeed({ stateDir: root, repo, now });
		assert.equal(feed.entries.find((entry) => entry.issue === 1)?.stale, false);
		assert.equal(feed.entries.find((entry) => entry.issue === 2)?.stale, false);
		await addRun(root, 20, "blocked", { enteredAt: now + 1 });
		const future = await readOwnerFeed({ stateDir: root, repo, now });
		assert.equal(
			future.entries.find((entry) => entry.issue === 20)?.ageMs,
			null,
		);
		assert.equal(
			future.entries.find((entry) => entry.issue === 20)?.stale,
			false,
		);
	});
});

test("titles are digest-bound plain text capped at 120 code points; the latest event replaces a high old sequence", async () => {
	await state(async (root) => {
		await addRun(root, 20, "needs_info", { title: "old", seq: 100 });

		const id = await addRun(root, 20, "running", {
			title: `<script>\u0001\u202e${"🧪".repeat(130)}`,
			eventId: "2",
			seq: 1,
		});

		const feed = await readOwnerFeed({ stateDir: root, repo, now });
		const entries = feed.entries.filter((entry) => entry.issue === 20);
		assert.equal(entries.length, 1);
		assert.equal(entries[0]?.runId, id);
		assert.equal(entries[0]?.status, "running");
		assert.equal([...entries[0]!.title].length, 120);
		assert.ok(
			!entries[0]!.title.includes("\u0001") &&
				!entries[0]!.title.includes("\u202e"),
		);
	});
});

test("historical verification cap wins; missing caps stay unknown; metrics require a complete report", async () => {
	await state(async (root) => {
		const runId = await addRun(root, 20, "running");
		await save(root, ["accounting", runId, "policy.json"], {
			v: 2,
			runId,
			startedAt: new Date(now - 1000).toISOString(),
			context: {
				kind: "verification",
				trustedCap: 800000,
				effectiveCap: 10000,
				manifestDigest: digestOf("verification"),
				policy: {
					workflowSha: "a".repeat(40),
					workflowDigest: digestOf("workflow"),
					gates: {
						kind: "known",
						value: { sourceSha: "a".repeat(40), digest: digestOf("gate") },
					},
					autonomy: {
						approveMerge: "always",
						land: "propose",
						digest: AUTONOMY_DIGEST,
					},
				},
			},
		});

		const report = {
			repo,
			status: "pending",
			primary: { numerator: 1, denominator: 2, share: 0.5 },
			tokensPerCleanLanding: 12345.5,
		};

		await save(root, ["metrics.json"], {
			computedAt: new Date(now).toISOString(),
			report,
		});
		let feed = await readOwnerFeed({ stateDir: root, repo, now });
		assert.equal(
			feed.entries.find((entry) => entry.runId === runId)?.cap,
			10000,
		);
		assert.equal(feed.entries.find((entry) => entry.issue === 5)?.cap, null);
		assert.equal(feed.metrics.share, null);
		await save(root, ["metrics.json"], {
			computedAt: new Date(now).toISOString(),
			report: { ...report, status: "complete" },
		});
		feed = await readOwnerFeed({ stateDir: root, repo, now });
		assert.equal(feed.metrics.share, 0.5);
		assert.equal(feed.metrics.tokensPerCleanLanding, 12345.5);
	});
});

test("active published refresh stays blocked in the feed but neutral Working on the dashboard", async () => {
	await state(async (root) => {
		const book = candidateLifecycleFixture();
		await addRun(root, 1, "running", {
			stage: "validate",
			handoff: JSON.parse(JSON.stringify(book)),
		});
		const feed = await readOwnerFeed({ stateDir: root, repo, now });
		assert.equal(
			feed.entries.find((entry) => entry.issue === 1)?.kind,
			"blocked",
		);
		assert.equal(
			feed.entries.find((entry) => entry.issue === 1)?.group,
			"working",
		);
		assert.equal(feed.counts.blocked, 2);
		assert.equal(feed.workingRunCount, 1);
	});
});

test("stage totals retain repair retry receipts with dotted attempt suffixes", async () => {
	await state(async (root) => {
		const runId = await addRun(root, 20, "running", { stage: "build" });

		for (const [name, tokens, wallMs] of [
			["build-1", 100, 1000],
			["build-r1-1.2", 200, 2000],
		] as const)
			await save(root, ["stages", runId, name, "receipt.json"], {
				version: 1,
				runId,
				stage: "build",
				outcome: { kind: "passed" },
				turns: 1,
				wallMs,
				usage: { total: tokens },
			});

		const feed = await readOwnerFeed({ stateDir: root, repo, now });
		assert.deepEqual(
			feed.entries.find((entry) => entry.runId === runId)?.steps,
			[{ stage: "build", outcome: "passed", tokens: 300, wallMs: 3000 }],
		);
	});
});

test("old terminal runs skip admission snapshots and stage receipts, but recently observed landings stay visible", async () => {
	await state(async (root) => {
		const runId = await addRun(root, 20, "landed", {
			stage: "land",
			enteredAt: now - 30 * 86_400_000,
		});

		await save(root, ["stages", runId, "build-1", "receipt.json"], {
			version: 1,
			runId,
			stage: "build",
			outcome: { kind: "passed" },
			turns: 1,
			wallMs: 1000,
			usage: { total: 10 },
		});

		const paths = [
			join(root, "admissions/github", repo, "20/1.json"),
			join(root, "stages", runId, "build-1/receipt.json"),
		];

		for (const path of paths) await utimes(path, 0, 0);
		const control = join(root, "claims", `${runId}.json`);
		await utimes(control, 0, 0);
		const feed = await readOwnerFeed({ stateDir: root, repo, now });
		assert.ok(!feed.entries.some((entry) => entry.runId === runId));
		assert.ok(
			(await lstat(control)).atimeMs > 0,
			"filesystem tracks reads for the control claim",
		);

		for (const path of paths)
			assert.equal(
				(await lstat(path)).atimeMs,
				0,
				`old detail was not read: ${path}`,
			);
		await save(root, ["ledger", runId, "terminal.json"], {
			runId,
			terminalObservedAt: new Date(now).toISOString(),
		});
		assert.ok(
			(await readOwnerFeed({ stateDir: root, repo, now })).entries.some(
				(entry) => entry.runId === runId,
			),
		);
	});
});

test("published token-cap holds stay blocked and orange; off-feed budget stops retain their kind", async () => {
	await state(async (root) => {
		const feed = await readOwnerFeed({ stateDir: root, repo, now });
		const waiting = feed.entries.find((entry) => entry.issue === 1);
		assert.ok(waiting);

		const claim = JSON.parse(
			await readFile(join(root, "claims", `${waiting.runId}.json`), "utf8"),
		);

		for (const reason of ["run_tokens", "review_tokens", "repair_tokens"]) {
			await save(root, ["claims", `${waiting.runId}.json`], {
				...claim,
				status: "blocked",
				handoff: {
					...claim.handoff,
					published: {
						...claim.handoff.published,
						readiness: { kind: "not_ready", reason, since: now },
					},
					work: { kind: "held", reason, since: now },
				},
			});

			const updated = await readOwnerFeed({ stateDir: root, repo, now });

			const held: FeedEntry | undefined = updated.entries.find(
				(entry) => entry.runId === waiting.runId,
			);

			assert.equal(held?.status, "blocked");
			assert.equal(held?.kind, "blocked");
			assert.equal(held?.group, "needs_you");
		}

		const budget = await addRun(root, 30, "budget_exhausted");
		await addRun(root, 30, "running", { eventId: "2" });
		const updated = await readOwnerFeed({ stateDir: root, repo, now });
		assert.equal((await readOwnerRun(root, budget, updated))?.kind, "budget");
	});
});

test("private fixtures also work at restrictive umasks without changing their semantics", async () => {
	await withUmask(0o077, async () => {
		await state(async (root) => {
			const feed = await readOwnerFeed({ stateDir: root, repo, now });
			assert.equal(feed.entries.length, 7);
		});
	});
});

async function committed(name: CaptureName): Promise<JsonValue> {
	const feed = parseJson(await readFile(captureFile(name), "utf8"));
	assert.ok(feed !== undefined, `${name} capture is not JSON`);

	return feed;
}

type FieldPath = readonly (string | number)[];

function fieldPaths(value: JsonValue, prefix: FieldPath = []): FieldPath[] {
	if (Array.isArray(value))
		return value.flatMap((item, index) => fieldPaths(item, [...prefix, index]));
	const object = objectOf(value);

	return object === null
		? []
		: Object.entries(object).flatMap(([key, child]) => [
				[...prefix, key],
				...fieldPaths(child, [...prefix, key]),
			]);
}

function without(value: JsonValue, path: FieldPath): JsonValue {
	const [head, ...rest] = path;

	if (head === undefined) return value;

	if (Array.isArray(value))
		return value.map((item, index) =>
			index === head ? without(item, rest) : item,
		);
	const object = objectOf(value);

	if (object === null) return value;

	return Object.fromEntries(
		Object.entries(object).flatMap(([key, child]): [string, JsonValue][] =>
			key !== head
				? [[key, child]]
				: rest.length === 0
					? []
					: [[key, without(child, rest)]],
		),
	);
}

function withField(feed: JsonValue, key: string, value: JsonValue): JsonValue {
	const object = objectOf(feed);
	assert.ok(object !== null);

	return { ...object, [key]: value };
}

test("every capture is the real CLI's v1 output and together they cover every attention kind", async () => {
	const seen = new Set<string>();

	for (const name of CAPTURE_NAMES) {
		const saved = await committed(name);
		assert.deepEqual(v1Problems(saved), [], `${name} is not a v1 feed`);

		assert.deepEqual(
			parseJson(await captureOwnerFeed(name)),
			saved,
			`${name} differs from the CLI output; run node test/fixtures/owner-feed/capture.ts`,
		);

		const feed = objectOf(saved);
		const counts = objectOf(feed?.counts);
		const entries = Array.isArray(feed?.entries) ? feed.entries : [];
		assert.equal(entries.length, 1, `${name} holds exactly one run`);
		const kind = objectOf(entries[0])?.kind;

		if (name === "working") {
			assert.equal(kind, null);
			assert.equal(feed?.workingRunCount, 1);
		} else {
			assert.equal(kind, name);
			assert.equal(counts?.[name], 1);
			seen.add(name);
		}

		assert.equal(counts?.spec_review, 0);
	}

	assert.deepEqual([...seen].sort(), [...CAPTURED_KINDS].sort());

	// spec_review is the one kind with no capture. No state can produce it.
	assert.deepEqual(
		ATTENTION_KINDS.filter((kind) => !seen.has(kind)),
		["spec_review"],
	);
});

test("captures carry no state path, home path or issue body", async () => {
	for (const name of CAPTURE_NAMES)
		assert.deepEqual(
			redactionProblems(
				await readFile(captureFile(name), "utf8"),
				"/tmp/owner-feed-capture-fixture",
			),
			[],
			name,
		);
});

test("the v1 check fails when any field is removed or version changes, and accepts a new field", async () => {
	const feeds = [
		parseJson(
			await readFile(
				new URL("./fixtures/owner-feed/feed-v1.json", import.meta.url),
				"utf8",
			),
		),
		...(await Promise.all(CAPTURE_NAMES.map(committed))),
	];

	for (const feed of feeds) {
		assert.ok(feed !== undefined);
		assert.deepEqual(v1Problems(feed), []);
		assert.deepEqual(v1Problems(withField(feed, "addedLater", 1)), []);
		assert.notDeepEqual(v1Problems(withField(feed, "version", 2)), []);
		assert.notDeepEqual(v1Problems(withField(feed, "version", "1")), []);
		assert.notDeepEqual(v1Problems(withField(feed, "at", "now")), []);

		for (const path of fieldPaths(feed))
			assert.notDeepEqual(
				v1Problems(without(feed, path)),
				[],
				`removing ${path.join(".")} must fail the v1 check`,
			);
	}
});

/** The fields the contract's change test compares between two reads of one key. */
function decision(entry: FeedEntry | undefined) {
	assert.ok(entry !== undefined);

	return JSON.stringify([entry.kind, entry.runId, entry.reason]);
}

test("a held run keeps its kind, group and runId when only the hold reason changes, so the decision fingerprint needs reason", async () => {
	await state(async (root) => {
		const runId = await addRun(root, 30, "running", { title: "Held run" });

		const hold = async (why: string) => {
			await save(root, ["status.json"], {
				repo,
				unverifiedClaims: [
					{
						issue: 30,
						runId,
						eventId: "1",
						why,
						failure: null,
						since: now - 5,
					},
				],
			});

			return (await readOwnerFeed({ stateDir: root, repo, now })).entries.find(
				(entry) => entry.issue === 30,
			);
		};

		const first = await hold("issue");
		const same = await hold("issue");
		const second = await hold("timeline");

		assert.equal(first?.reason, "claim_unverified:issue");
		assert.equal(second?.reason, "claim_unverified:timeline");
		assert.equal(first?.kind, "blocked");
		assert.equal(first?.group, "needs_you");
		assert.equal(second?.kind, first?.kind);
		assert.equal(second?.group, first?.group);
		assert.equal(second?.runId, first?.runId);
		assert.equal(decision(same), decision(first));
		assert.notEqual(decision(second), decision(first));
	});
});

test("L05 pins the owner header's controller state from the lock and its status read regardless of mode", async () => {
	const root = await mkdtemp(join(tmpdir(), "owner-header-"));

	try {
		await emptyState(root);
		const lastTick = new Date(now - 12_000).toISOString();

		const header = (state: string) => ({
			repo,
			at: now,
			controller: { state, lastTick, localSwitch: "enabled" },
		});

		assert.deepEqual(await readOwnerHeader(root, now, repo), header("stopped"));

		const acquired = await acquireLock({
			stateDir: root,
			procs: procTable(),
			now: () => now,
		});

		assert.equal(acquired.kind, "acquired");

		try {
			assert.deepEqual(
				await readOwnerHeader(root, now, repo),
				header("running"),
			);
		} finally {
			if (acquired.kind === "acquired") await acquired.lock.release();
		}

		await writeFile(
			join(root, "controller.lock"),
			`${JSON.stringify({ pid: 1, startTime: "1", acquiredAt: lastTick })}\n`,
			{ mode: 0o600 },
		);
		assert.deepEqual(
			await readOwnerHeader(root, now, repo),
			header("unavailable"),
		);
		await rm(join(root, "controller.lock"));

		await chmod(join(root, "status.json"), 0o644);
		assert.deepEqual(await readOwnerHeader(root, now, repo), header("stopped"));
		assert.deepEqual(await readOwnerHeader(root, now), {
			repo: null,
			at: now,
			controller: { state: "stopped", lastTick: null, localSwitch: "enabled" },
		});
		assert.deepEqual(await readOwnerHeader(join(root, "absent"), now, repo), {
			repo,
			at: now,
			controller: {
				state: "unavailable",
				lastTick: null,
				localSwitch: "unavailable",
			},
		});
	} finally {
		await rm(root, { recursive: true, force: true });
	}
});

test("L05 pins stage steps: missing, corrupt, wrong-mode and foreign receipts are skipped", async () => {
	await state(async (root) => {
		const runId = await addRun(root, 20, "running", { stage: "build" });

		const receipt = (id: string, stage: string, total: number) => ({
			version: 1,
			runId: id,
			stage,
			outcome: { kind: "failed", exit: "error" },
			turns: 1,
			wallMs: 10,
			usage: { total },
		});

		await save(
			root,
			["stages", runId, "build-1", "receipt.json"],
			receipt(runId, "build", 7),
		);
		await save(
			root,
			["stages", runId, "build-2", "receipt.json"],
			receipt(runId, "build", 8),
		);
		await writeFile(
			join(root, "stages", runId, "build-2", "receipt.json"),
			"{",
		);
		await save(
			root,
			["stages", runId, "review-1", "receipt.json"],
			receipt(runId, "review", 9),
		);
		await chmod(join(root, "stages", runId, "review-1", "receipt.json"), 0o644);
		await mkdir(join(root, "stages", runId, "accept-1"), { mode: 0o700 });
		await save(
			root,
			["stages", runId, "specify-1", "receipt.json"],
			receipt(digestOf("other"), "specify", 10),
		);
		await save(
			root,
			["stages", runId, "notes-1", "receipt.json"],
			receipt(runId, "notes", 11),
		);

		const feed = await readOwnerFeed({ stateDir: root, repo, now });

		assert.deepEqual(
			feed.entries.find((entry) => entry.runId === runId)?.steps,
			[{ stage: "build", outcome: "failed", tokens: 7, wallMs: 10 }],
		);
	});
});

test("L05 pins stored validation verdicts: valid, missing, corrupt and wrong-mode", async () => {
	await state(async (root) => {
		const runId = await addRun(root, 20, "running", { stage: "validate" });
		const claim = ["claims", `${runId}.json`];

		const saved = objectOf(
			parseJson(await readFile(join(root, ...claim), "utf8")),
		);

		assert.ok(saved !== null);

		const ci = async () =>
			(await readOwnerFeed({ stateDir: root, repo, now })).entries.find(
				(entry) => entry.runId === runId,
			)?.ci;

		await save(root, claim, { ...saved, validation: {} });
		assert.equal(await ci(), "Pending");

		const verdict = ["validation", runId, "verdict.json"];
		await save(root, verdict, { pass: true });
		assert.equal(await ci(), "Passed");
		await save(root, verdict, { pass: false });
		assert.equal(await ci(), "Failed");
		await chmod(join(root, ...verdict), 0o644);
		assert.equal(await ci(), "Pending");
		await writeFile(join(root, ...verdict), "{", { mode: 0o600 });
		await chmod(join(root, ...verdict), 0o600);
		assert.equal(await ci(), "Pending");

		await save(root, claim, { ...saved, round: 1, validation: {} });
		assert.equal(await ci(), "Pending");
		await save(root, ["validation", runId, "r1", "verdict.json"], {
			pass: true,
		});
		assert.equal(await ci(), "Passed");

		await save(root, claim, { ...saved, round: 1 });
		assert.equal(await ci(), "Pending");
	});
});
