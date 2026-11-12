import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { existsSync } from "node:fs";
import {
	mkdtemp,
	rm,
	readdir,
	readFile,
	lstat,
	writeFile,
	mkdir,
	symlink,
	unlink,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { request, type OutgoingHttpHeaders } from "node:http";
import { test } from "node:test";
import { performance } from "node:perf_hooks";
import {
	renderDashboard,
	renderSteps,
	renderRunSummary,
	duration,
	runSentence,
	runAction,
	stateWord,
} from "../server/viewer/dashboard.ts";
import { startViewer } from "../server/viewer.ts";
import { collectOwnerMetrics, runCli } from "../server/cli.ts";
import { parseLedger, ledgerRow } from "../src/ledger.ts";
import { gitObjectSha } from "../src/publication.ts";
import type { InterventionRead } from "../src/metrics.ts";
import type { JsonValue } from "../src/core/json.ts";
import { readOwnerFeed, readOwnerRun, type FeedEntry } from "../src/feed.ts";
import { fileAdmissionStore } from "../src/admission.ts";
import {
	Orchestrator,
	type TickReport,
	type StageExecutor,
} from "../src/orchestrator.ts";
import {
	fileRunFiles,
	serveLoop,
	startMetricSnapshots,
	startDurableUsage,
	systemdNotify,
	writeStatus,
} from "../server/controller.ts";
import { digestOf, runIdOf } from "../src/core/run.ts";
import {
	addRun,
	now,
	ownerState,
	repo,
	save,
} from "./fixtures/owner-feed/state.ts";
import { EXE_DEV_PLATFORM } from "../src/platform.ts";
import { noPlatformFile } from "./helpers.ts";

async function state<T>(body: (root: string) => Promise<T>) {
	const root = await mkdtemp(join(tmpdir(), "owner-dashboard-"));

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

async function tree(root: string, prefix = ""): Promise<string[]> {
	const rows: string[] = [];

	for (const name of (await readdir(join(root, prefix))).sort()) {
		const path = join(prefix, name);
		const info = await lstat(join(root, path));

		if (info.isDirectory()) rows.push(...(await tree(root, path)));
		else
			rows.push(
				`${path} ${info.mode & 0o777} ${digestOf(await readFile(join(root, path)))}`,
			);
	}

	return rows;
}

function http(
	port: number,
	path: string,
	options: {
		method?: string;
		host?: string;
		origin?: string;
		body?: string;
		contentType?: string;
		proxyLogin?: string;
	} = {},
) {
	return new Promise<{
		status: number;
		body: string;
		location: string | undefined;
		allow: string | undefined;
	}>((resolve, reject) => {
		const headers: OutgoingHttpHeaders = {
			Host: options.host ?? `127.0.0.1:${port}`,
		};

		if (options.origin !== undefined) headers.Origin = options.origin;

		if (options.body !== undefined)
			headers["Content-Type"] =
				options.contentType ?? "application/x-www-form-urlencoded";

		if (options.proxyLogin !== undefined)
			headers["Tailscale-User-Login"] = options.proxyLogin;

		const req = request(
			{
				hostname: "127.0.0.1",
				port,
				path,
				method: options.method ?? "GET",
				headers,
			},
			(res) => {
				let body = "";
				res.setEncoding("utf8");
				res.on("data", (chunk) => {
					body += String(chunk);
				});
				res.on("end", () =>
					resolve({
						status: res.statusCode ?? 0,
						body,
						location: res.headers.location,
						allow: res.headers.allow,
					}),
				);
			},
		);

		req.on("error", reject);
		req.end(options.body);
	});
}

test("dashboard groups follow the state table, newest first, no empty groups or row badges", async () => {
	await state(async (root) => {
		const feed = await readOwnerFeed({ stateDir: root, repo, now });
		const html = renderDashboard(feed, "/factory", "test-token");

		const positions = [
			"Needs you",
			">Failed</h2>",
			">Working</h2>",
			"Done recently",
		].map((word) => html.indexOf(word));

		assert.ok(positions.every((position) => position >= 0));
		assert.deepEqual(
			[...positions].sort((a, b) => a - b),
			positions,
		);
		assert.match(html, /<details class="group" id="done-recently">/);
		assert.equal((html.match(/class="badge"/g) ?? []).length, 1);
		assert.match(html, /Your review/);
		assert.match(html, /Your answer/);
		assert.match(html, /Out of budget/);
		assert.match(html, /On hold:/);
		assert.match(html, /Waiting 4 days/);
		assert.match(
			html,
			/#1<\/span><span class="row-title">Let the owner review the dashboard/,
		);
		assert.match(html, /class="run-pane"/);
		assert.doesNotMatch(html, /run-card|stage-disclosure|Round 0|cap unknown/);
		assert.doesNotMatch(
			html,
			/No failed runs|colour legend|attentionTint|class="pill"/,
		);

		const empty = renderDashboard(
			{ ...feed, entries: [], unreadable: [], gaps: [] },
			"",
			"token",
		);

		assert.doesNotMatch(
			empty,
			/Needs you|Done recently|<h2>Failed|<h2>Working|class="badge"/,
		);
		const rows = feed.entries.filter((entry) => entry.group === "needs_you");
		assert.deepEqual(
			rows.map((entry) => entry.issue),
			[8, 3, 2, 1],
		);
		assert.match(html, /Clean landings/);
		assert.match(html, /Pending/);
	});
});

test("all ticket actions go to GitHub, internal links and forms keep the prefix, and text is escaped", async () => {
	await state(async (root) => {
		await addRun(root, 20, "needs_info", {
			title: `<img src=x onerror="bad()"> & review`,
		});
		const feed = await readOwnerFeed({ stateDir: root, repo, now });
		const html = renderDashboard(feed, "/factory", 'a"b');
		assert.ok(
			html.includes("&lt;img src=x onerror=&quot;bad()&quot;&gt; &amp; review"),
		);
		assert.ok(!html.includes("<img src=x"));
		assert.match(html, /name="token" value="a&quot;b"/);
		assert.match(html, /action="\/factory\/hold"/);
		assert.match(html, /external-link|M12 6h-6/);

		for (const [, href] of html.matchAll(/(?:href|action)="([^"]+)"/g))
			assert.ok(
				href?.startsWith("/factory/") ||
					href?.startsWith(`https://github.com/${repo}/`),
				href ?? "missing href",
			);
		assert.equal((html.match(/<form /g) ?? []).length, 1);
		assert.doesNotMatch(html, /<script|serviceWorker|onclick=/);
	});
});

test("selection is a prefixed GET query, with phone links to run pages and a shared header", async () => {
	await state(async (root) => {
		const feed = await readOwnerFeed({ stateDir: root, repo, now });
		const selected = feed.entries.find((entry) => entry.issue === 1);
		assert.ok(selected);

		const viewer = await startViewer({
			stateDir: root,
			port: 0,
			basePath: "/factory",
		});

		try {
			const home = await http(viewer.port, `/factory/?run=${selected.runId}`);
			assert.equal(home.status, 200);
			assert.match(
				home.body,
				new RegExp(
					`href="/factory/\\?run=${selected.runId}" aria-current="true"`,
				),
			);
			assert.ok(
				home.body.includes(
					`class="row-main to-page" href="/factory/run/${selected.runId}/timeline"`,
				),
			);
			assert.match(home.body, /Review PR #5 on GitHub/);
			assert.match(home.body, /At least 5.2M tokens recorded/);
			assert.doesNotMatch(home.body, /14.6M|Stopped since \d{4}-/);

			const run = await http(
				viewer.port,
				`/factory/run/${selected.runId}/timeline`,
			);

			assert.equal(run.status, 200);
			assert.equal(
				run.body.match(/<header>.*?<\/header>/)?.[0],
				home.body
					.match(/<header>.*?<\/header>/)?.[0]
					?.replace('class="brand"', 'class=""'),
			);
			assert.doesNotMatch(run.body, /class="stats"/);
		} finally {
			await viewer.close();
		}
	});
});

test("the ledger failure stage owns the glyph, never the terminal PR projection; old pages remain reachable", async () => {
	await state(async (root) => {
		const feed = await readOwnerFeed({ stateDir: root, repo, now });
		const entry = feed.entries.find((item) => item.issue === 4);
		assert.ok(entry);
		assert.equal(entry.stage, "land");
		assert.equal(entry.failure?.stage, "review");
		const html = renderSteps(entry);
		assert.match(html, /class="status-error" data-stage="review"/);
		assert.doesNotMatch(html, /class="status-error" data-stage="land"/);
		assert.doesNotMatch(
			renderSteps({ ...entry, failure: null }),
			/alert-triangle/,
		);

		const old = await addRun(root, 30, "released", {
			enteredAt: now - 8 * 86_400_000,
		});

		const updated = await readOwnerFeed({ stateDir: root, repo, now });
		assert.ok(!updated.entries.some((item) => item.runId === old));
		assert.equal((await readOwnerRun(root, old, updated))?.title, "Ticket 30");
	});
});

test("summaries use one failure sentence, singular hours, and show a saved failed CI result", async () => {
	assert.equal(duration(3_600_000), "1 hour");
	assert.equal(duration(7_200_000), "2 hours");
	await state(async (root) => {
		const feed = await readOwnerFeed({ stateDir: root, repo, now });
		const entry = feed.entries.find((item) => item.issue === 4);
		assert.ok(entry);
		assert.equal((renderRunSummary(entry).match(/Stopped/g) ?? []).length, 1);
		assert.equal(
			runSentence({ ...entry, failure: null }),
			"Stopped. The reason was not recorded.",
		);
		assert.match(
			renderSteps({ ...entry, ci: "Failed" }),
			/data-stage="validate">.*?<span>Failed<\/span>/,
		);
	});
});

test("owner summaries use plain metadata, failure words and the right action hierarchy", async () => {
	await state(async (root) => {
		const feed = await readOwnerFeed({ stateDir: root, repo, now });
		const working = feed.entries.find((entry) => entry.issue === 5);
		const failed = feed.entries.find((entry) => entry.issue === 4);
		const waiting = feed.entries.find((entry) => entry.issue === 1);
		assert.ok(working && failed && waiting);
		assert.match(renderRunSummary(working), /1,234 tokens/);
		assert.doesNotMatch(
			renderRunSummary(working),
			/Round 0|CI Pending|cap unknown/,
		);
		assert.match(
			renderRunSummary({ ...working, round: 1, cap: 800000 }),
			/Repair round 1 · 1,234 of 800,000 tokens/,
		);
		assert.match(renderRunSummary(failed), /class="meta">Review/);
		assert.match(
			stateWord(failed),
			/^Failed: the change is too large for review$/,
		);
		assert.equal(
			stateWord({ ...failed, failure: null }),
			"Failed: reason not recorded",
		);
		assert.doesNotMatch(runAction(failed), /primary/);
		assert.match(runAction(failed), /class="github button"/);
		assert.match(runAction(waiting), /class="github button primary"/);
		assert.match(renderSteps(working), /data-stage="validate">.*?no model/);

		for (const reason of ["run_tokens", "review_tokens", "repair_tokens"]) {
			const held: FeedEntry = { ...waiting, kind: "blocked", reason };
			assert.equal(stateWord(held), "On hold: token cap reached");
			assert.match(renderRunSummary(held), /class="state attention"/);
		}
	});
});

test("hold refuses missing tokens, foreign or absent Origin, unlisted hosts and every other write; only disabled changes", async () => {
	await state(async (root) => {
		const logs: string[] = [];

		const viewer = await startViewer({
			stateDir: root,
			port: 0,
			basePath: "/factory",
			allowedHost: "owner.example.ts.net",
			log: (line) => logs.push(line),
		});

		try {
			const before = await tree(root);
			const home = await http(viewer.port, "/factory/");
			assert.equal(home.status, 200);
			const token = /name="token" value="([a-f0-9]+)"/.exec(home.body)?.[1];
			assert.ok(token);
			const origin = `http://127.0.0.1:${viewer.port}`;

			for (const options of [
				{ origin, body: "hold=on" },
				{ body: `hold=on&token=${token}` },
				{ origin: "https://foreign.example", body: `hold=on&token=${token}` },
				{ origin: "null", body: `hold=on&token=${token}` },
				{
					host: "evil.example",
					origin: "https://evil.example",
					body: `hold=on&token=${token}`,
				},
				{ origin, body: `hold=on&token=${token}&path=claims` },
				{ origin, body: `hold=on&token=${"🧪".repeat(32)}` },
				{
					origin,
					body: `hold=on&token=${token === "0".repeat(64) ? "1".repeat(64) : "0".repeat(64)}`,
				},
				{ origin, body: `hold=on&token=${token}`, contentType: "text/plain" },
			])
				assert.equal(
					(
						await http(viewer.port, "/factory/hold", {
							...options,
							method: "POST",
						})
					).status,
					403,
				);

			for (const path of [
				"/factory/owner-feed.json",
				"/factory/",
				"/factory/retry",
				"/factory/disabled",
				"/factory/hold/",
				"/factory/hold?x=1",
				"/factory//hold",
			])
				assert.equal(
					(
						await http(viewer.port, path, {
							method: "POST",
							origin,
							body: `hold=on&token=${token}`,
						})
					).status,
					405,
				);

			for (const method of ["HEAD", "OPTIONS", "PUT", "DELETE", "PATCH"])
				assert.equal(
					(await http(viewer.port, "/factory/owner-feed.json", { method }))
						.status,
					405,
				);
			assert.equal((await http(viewer.port, "/factory/hold")).allow, "POST");
			assert.deepEqual(await tree(root), before);

			assert.equal(
				(
					await http(viewer.port, "/factory/hold", {
						method: "POST",
						origin,
						body: `hold=on&token=${token}&padding=${"x".repeat(4096)}`,
					})
				).status,
				413,
			);

			for (const dangling of [false, true]) {
				const target = join(root, "outside-hold-target");

				if (!dangling) await writeFile(target, "untouched", { mode: 0o600 });
				await symlink(target, join(root, "disabled"));

				for (const hold of ["on", "off"]) {
					assert.equal(
						(
							await http(viewer.port, "/factory/hold", {
								method: "POST",
								origin,
								body: `hold=${hold}&token=${token}`,
							})
						).status,
						409,
					);
					assert.ok((await lstat(join(root, "disabled"))).isSymbolicLink());
				}

				if (!dangling) {
					assert.equal(await readFile(target, "utf8"), "untouched");
					await unlink(target);
				} else await assert.rejects(lstat(target), { code: "ENOENT" });
				await unlink(join(root, "disabled"));
			}

			await mkdir(join(root, "disabled"));
			assert.equal(
				(
					await http(viewer.port, "/factory/hold", {
						method: "POST",
						origin,
						body: `hold=off&token=${token}`,
					})
				).status,
				409,
			);
			await rm(join(root, "disabled"), { recursive: true });
			assert.deepEqual(await tree(root), before);

			const on = await http(viewer.port, "/factory/hold", {
				method: "POST",
				origin,
				body: `hold=on&token=${token}`,
			});

			assert.equal(on.status, 303);
			assert.equal(on.location, "/factory/");
			const held = await tree(root);
			assert.deepEqual(
				held.filter((line) => !line.startsWith("disabled ")),
				before,
			);
			assert.equal(held.length, before.length + 1);
			assert.equal((await lstat(join(root, "disabled"))).mode & 0o777, 0o600);
			assert.equal(
				(await readOwnerFeed({ stateDir: root, repo, now })).controller
					.localSwitch,
				"disabled",
			);

			const off = await http(viewer.port, "/factory/hold", {
				method: "POST",
				host: "owner.example.ts.net",
				origin: "https://owner.example.ts.net",
				proxyLogin: "owner@example.com",
				body: `hold=off&token=${token}`,
			});

			assert.equal(off.status, 303);
			assert.deepEqual(await tree(root), before);
			assert.equal(logs.length, 2);
			assert.match(
				logs[0] ?? "",
				/at=\S+ event=local_hold hold=on source=127.0.0.1/,
			);
			assert.match(logs[1] ?? "", /proxy_reported_login="owner@example.com"/);
			assert.ok(!logs.join("").includes(token));
		} finally {
			await viewer.close();
		}
	});
});

const report: TickReport = {
	repo,
	at: new Date(now).toISOString(),
	executionEnabled: false,
	dispatch: { enabled: false, reasons: ["locally_disabled"] },
	workflowSha: null,
	maxConcurrent: 2,
	active: 0,
	runs: [],
	feedbackIntake: [],
	unverifiedClaims: [],
	queued: [],
	absent: [],
	refused: [],
	corrupt: [],
	ledgerBehind: [],
	totals: {
		claims: 0,
		launches: 0,
		retries: 0,
		stalls: 0,
		releases: 0,
		failures: 0,
		markersPosted: 0,
		usage: 0,
	},
};

test("simultaneous hold requests succeed idempotently and change only disabled", async () => {
	await state(async (root) => {
		const viewer = await startViewer({
			stateDir: root,
			port: 0,
			log: () => undefined,
		});

		try {
			const before = await tree(root);
			const home = await http(viewer.port, "/");
			const token = /name="token" value="([a-f0-9]+)"/.exec(home.body)?.[1];
			assert.ok(token);
			const origin = `http://127.0.0.1:${viewer.port}`;

			for (const hold of ["on", "off"]) {
				const replies: Awaited<ReturnType<typeof http>>[] = await Promise.all(
					Array.from({ length: 8 }, () =>
						http(viewer.port, "/hold", {
							method: "POST",
							origin,
							body: `hold=${hold}&token=${token}`,
						}),
					),
				);

				assert.deepEqual(
					replies.map((reply) => reply.status),
					Array(8).fill(303),
				);
			}

			assert.deepEqual(await tree(root), before);
		} finally {
			await viewer.close();
		}
	});
});

test("READY precedes the first tick; tick start and failed status writes still feed WATCHDOG", async () => {
	await state(async (root) => {
		const signal = new AbortController();
		const sent: string[] = [];
		let ticks = 0;
		const log: string[] = [];
		await serveLoop({
			platform: EXE_DEV_PLATFORM,
			stateDir: root,
			orchestrator: {
				pollIntervalMs: 1,
				tick: async () => {
					ticks++;
					await new Promise<void>((done) => setImmediate(done));

					assert.equal(sent[0], "READY=1");
					assert.equal(sent.at(-1), "WATCHDOG=1");

					if (ticks === 1) {
						await rm(join(root, "status.json"));
						await mkdir(join(root, "status.json"));
					}

					return report;
				},
			},
			signal: signal.signal,
			log: (event) => log.push(event),
			notify: async (message) => {
				sent.push(message);
			},
			sleep: async () => {
				await new Promise<void>((done) => setImmediate(done));

				if (ticks === 2) signal.abort();
			},
		});
		assert.deepEqual(sent, [
			"READY=1",
			"WATCHDOG=1",
			"WATCHDOG=1",
			"WATCHDOG=1",
			"WATCHDOG=1",
		]);
		assert.ok(log.includes("status_unwritable"));
	});
});

test("watchdog child settlement stays off the tick path, with at most one in flight", async (context) => {
	await state(async (root) => {
		const tickState = join(root, "tick-state");
		await mkdir(tickState, { mode: 0o700 });
		const stop = new AbortController();
		let release: () => void = () => undefined;
		let calls = 0;
		let ticks = 0;
		let started = 0;
		let ready = false;

		const done = new Promise<void>((resolve) => {
			release = resolve;
		});

		const loop = serveLoop({
			platform: EXE_DEV_PLATFORM,
			stateDir: tickState,
			signal: stop.signal,
			orchestrator: {
				pollIntervalMs: 1,
				tick: async () => {
					assert.equal(ready, true, "READY must settle before the first tick");
					ticks++;

					return report;
				},
			},
			notify: async (message) => {
				if (message === "READY=1") {
					await new Promise<void>((resolve) => setImmediate(resolve));
					ready = true;
					started = performance.now();

					return;
				}

				calls++;
				await done;
			},
			log: (event) => assert.equal(event, "controller_stopping"),
			sleep: async () => {
				await new Promise<void>((resolve) => setImmediate(resolve));

				if (ticks === 30) stop.abort();
			},
		});

		const timeout = setTimeout(() => {
			stop.abort();
			release();
		}, 3000);

		try {
			await loop;
			const perTickMs = (performance.now() - started) / ticks;
			assert.equal(ticks, 30);
			assert.equal(
				calls,
				1,
				"ticks must neither wait nor launch overlapping children",
			);
			assert.ok(perTickMs < 10, `${perTickMs} ms per tick exceeds 10 ms`);
			context.diagnostic(
				`notify scheduling plus local status I/O: ${perTickMs.toFixed(3)} ms/tick; 30 ticks finished with child still pending`,
			);
		} finally {
			clearTimeout(timeout);
			release();
		}
	});
});

test("missing systemd-notify is logged once while ticks continue", async () => {
	await state(async (root) => {
		const signal = new AbortController();
		let ticks = 0;
		let attempts = 0;
		const logs: string[] = [];
		await serveLoop({
			platform: EXE_DEV_PLATFORM,
			stateDir: root,
			signal: signal.signal,
			orchestrator: {
				pollIntervalMs: 1,
				tick: async () => {
					ticks++;

					return report;
				},
			},
			log: (event) => logs.push(event),
			notify: async () => {
				attempts++;
				throw Object.assign(new Error("missing binary"), { code: "ENOENT" });
			},
			sleep: async () => {
				if (ticks === 3) signal.abort();
			},
		});
		assert.equal(attempts, 1);
		assert.equal(logs.filter((event) => event === "notify_failed").length, 1);
		assert.equal(ticks, 3);
	});
});

test("systemd-notify uses the inherited socket and a bounded child, proved with a PATH stub", async () => {
	await state(async (root) => {
		const bin = join(root, "bin");
		await mkdir(bin, { mode: 0o700 });
		await writeFile(
			join(bin, "systemd-notify"),
			`#!/bin/sh\nprintf '%s %s\\n' "$NOTIFY_SOCKET" "$1" >> '${root}/notify.log'\n`,
			{ mode: 0o700 },
		);
		const previousPath = process.env.PATH;
		const previousSocket = process.env.NOTIFY_SOCKET;

		try {
			process.env.PATH = `${bin}:${previousPath}`;
			process.env.NOTIFY_SOCKET = "@fake-notify-socket";
			await systemdNotify("READY=1");
			await systemdNotify("WATCHDOG=1");
			assert.equal(
				await readFile(join(root, "notify.log"), "utf8"),
				"@fake-notify-socket READY=1\n@fake-notify-socket WATCHDOG=1\n",
			);
		} finally {
			if (previousPath === undefined) delete process.env.PATH;
			else process.env.PATH = previousPath;

			if (previousSocket === undefined) delete process.env.NOTIFY_SOCKET;
			else process.env.NOTIFY_SOCKET = previousSocket;
		}
	});
});

test("a detached watchdog child that hangs is killed within its one-second bound", async () => {
	await state(async (root) => {
		const bin = join(root, "bin");
		await mkdir(bin, { mode: 0o700 });
		await writeFile(
			join(bin, "systemd-notify"),
			`#!${process.execPath}\nsetInterval(() => {}, 10000);\n`,
			{ mode: 0o700 },
		);
		const previousPath = process.env.PATH;
		const previousSocket = process.env.NOTIFY_SOCKET;

		try {
			process.env.PATH = `${bin}:${previousPath}`;
			process.env.NOTIFY_SOCKET = "@fake-notify-socket";
			const started = performance.now();
			await assert.rejects(systemdNotify("WATCHDOG=1"), /notify_exit/);
			const elapsed = performance.now() - started;
			assert.ok(
				elapsed >= 900 && elapsed < 3000,
				`hung notify bounded at ${elapsed} ms`,
			);
		} finally {
			if (previousPath === undefined) delete process.env.PATH;
			else process.env.PATH = previousPath;

			if (previousSocket === undefined) delete process.env.NOTIFY_SOCKET;
			else process.env.NOTIFY_SOCKET = previousSocket;
		}
	});
});

test("metric collection is private and independent of tick and watchdog, with no overlapping refresh", async () => {
	await state(async (root) => {
		let release: () => void = () => undefined;

		const done = new Promise<void>((resolve) => {
			release = resolve;
		});

		let calls = 0;

		const snapshots = startMetricSnapshots({
			stateDir: root,
			collect: async () => {
				calls++;
				await done;

				return {
					version: 1,
					computedAt: new Date(now).toISOString(),
					report: null,
				};
			},
			intervalMs: 5,
			log: assert.fail,
		});

		const stop = new AbortController();
		const sent: string[] = [];
		await serveLoop({
			platform: EXE_DEV_PLATFORM,
			stateDir: root,
			orchestrator: {
				tick: async () => {
					await new Promise<void>((done) => setImmediate(done));

					return report;
				},
				pollIntervalMs: 1,
			},
			signal: stop.signal,
			log: () => undefined,
			notify: async (message) => {
				sent.push(message);
			},
			sleep: async () => {
				await new Promise<void>((done) => setImmediate(done));
				stop.abort();
			},
		});
		assert.deepEqual(sent, ["READY=1", "WATCHDOG=1", "WATCHDOG=1"]);
		assert.equal(calls, 1);
		release();
		await snapshots.stop();
		assert.equal((await lstat(join(root, "metrics.json"))).mode & 0o777, 0o600);
		assert.equal(
			JSON.parse(await readFile(join(root, "metrics.json"), "utf8")).version,
			1,
		);
	});
});

test("repo-scoped fake gh writes a metric snapshot despite forbidden global search, paginates defects and skips PRs", async () => {
	await state(async (root) => {
		const bin = join(root, "bin");
		await mkdir(bin, { mode: 0o700 });
		const ledger = Buffer.from("");
		const sha = "a".repeat(40);
		const treeSha = "b".repeat(40);

		const issue = {
			number: 999,
			title: "Defect",
			body: null,
			created_at: "2026-11-01T00:00:00Z",
			labels: [{ name: "factory:defect" }],
		};

		const route = `repos/${repo}/issues?labels=factory%3Adefect&state=all&sort=created&direction=asc&per_page=100`;

		const responses = {
			[`repos/${repo}/git/ref/heads/factory/ledger`]: {
				ref: "refs/heads/factory/ledger",
				object: { sha },
			},
			[`repos/${repo}/git/commits/${sha}`]: {
				sha,
				tree: { sha: treeSha },
				parents: [],
			},
			[`repos/${repo}/git/trees/${treeSha}?recursive=1`]: {
				truncated: false,
				tree: [
					{
						path: "ledger/runs.jsonl",
						mode: "100644",
						type: "blob",
						sha: gitObjectSha("blob", ledger),
					},
				],
			},
			[`repos/${repo}/git/blobs/${gitObjectSha("blob", ledger)}`]: {
				encoding: "base64",
				content: ledger.toString("base64"),
			},
			[`repos/${repo}/labels/factory%3Adefect`]: { name: "factory:defect" },
			[`${route}&page=1`]: [
				{ pull_request: {} },
				...Array.from({ length: 99 }, (_, n) => ({ ...issue, number: n + 1 })),
			],
			[`${route}&page=2`]: [issue],
		};

		await writeFile(
			join(bin, "gh"),
			`#!${process.execPath}
const fs = require("node:fs");
const args = process.argv.slice(2);
fs.appendFileSync(${JSON.stringify(join(root, "gh-calls.jsonl"))}, JSON.stringify(args) + "\\n");
const responses = ${JSON.stringify(responses)};
const path = args.find(arg => arg.startsWith("repos/"));
if (args[0] !== "api" || !(path in responses)) {
 process.stderr.write("HTTP 403: global search forbidden (private diagnostic)");
 process.exit(1);
}
process.stdout.write(JSON.stringify(responses[path]));
`,
			{ mode: 0o700 },
		);

		const io = {
			readPlatformFile: noPlatformFile,
			env: () => undefined,
			stdout: assert.fail,
			stderr: assert.fail,
			exec: async (
				command: string,
				args: readonly string[],
				options?: { timeoutMs?: number },
			) => {
				try {
					const result = await promisify(execFile)(command, [...args], {
						env: { ...process.env, PATH: `${bin}:${process.env.PATH}` },
						timeout: options?.timeoutMs,
					});

					return { code: 0, ...result };
				} catch {
					return {
						code: 1,
						stdout: "",
						stderr: "HTTP 403: global search forbidden",
					};
				}
			},
		};

		await unlink(join(root, "metrics.json"));
		const logs: string[] = [];

		const snapshots = startMetricSnapshots({
			stateDir: root,
			collect: () =>
				collectOwnerMetrics(root, repo, io, new Map(), EXE_DEV_PLATFORM),
			log: (event, fields) => logs.push(`${event}:${fields.reason}`),
		});

		await snapshots.stop();
		assert.deepEqual(
			logs,
			[],
			"REST collection must write, not report metrics_unavailable",
		);

		const saved = JSON.parse(
			await readFile(join(root, "metrics.json"), "utf8"),
		);

		assert.deepEqual(saved.report.defectRead, { kind: "known", issues: 100 });
		await writeFile(join(root, "ledger.jsonl"), ledger);
		let output = "";
		assert.equal(
			await runCli(
				[
					"metrics",
					"--json",
					"--repo",
					repo,
					"--ledger-file",
					join(root, "ledger.jsonl"),
				],
				{
					...io,
					stdout: (text) => {
						output += text;
					},
				},
			),
			0,
		);
		assert.deepEqual(JSON.parse(output).defectRead, {
			kind: "known",
			issues: 100,
		});
		const calls = await readFile(join(root, "gh-calls.jsonl"), "utf8");
		assert.doesNotMatch(calls, /"issue","list"|search|graphql/);
	});
});

test("metric refreshes query defects once and cache merged interventions by PR and merge SHA", async () => {
	await state(async (root) => {
		const lines = parseLedger(
			await readFile(
				new URL("./fixtures/metrics/runs-2026-11-08.jsonl", import.meta.url),
			),
		);

		const source = lines.find(
			(line) =>
				line.kind === "known" &&
				line.row.v === 1 &&
				line.row.outcome.kind === "landed" &&
				line.row.provenance.kind !== "verification" &&
				line.row.pr !== null,
		);

		assert.ok(source?.kind === "known" && source.row.outcome.kind === "landed");
		assert.ok(source.row.v === 1 && source.row.outcome.kind === "landed");

		const original = {
			...source.row,
			eventId: "100",
			runId: runIdOf({ repo, issue: source.row.issue, eventId: "100" }),
		};

		assert.ok(original.outcome.kind === "landed");
		const rows = [original];
		const sha = "a".repeat(40);
		const treeSha = "b".repeat(40);
		const calls: string[][] = [];
		const cache = new Map<string, InterventionRead>();

		const io = {
			readPlatformFile: noPlatformFile,
			env: () => undefined,
			stdout: assert.fail,
			stderr: assert.fail,
			exec: async (_command: string, args: readonly string[]) => {
				calls.push([...args]);
				const path = args.find((arg) => arg.startsWith("repos/")) ?? "";
				const ledger = Buffer.concat(rows.map((row) => ledgerRow(row).bytes));
				const blob = gitObjectSha("blob", ledger);
				let value: JsonValue;

				if (path.includes("/git/ref/heads/factory/ledger"))
					value = { ref: "refs/heads/factory/ledger", object: { sha } };
				else if (path.includes("/git/commits/"))
					value = { sha, tree: { sha: treeSha }, parents: [] };
				else if (path.includes("/git/trees/"))
					value = {
						truncated: false,
						tree: [
							{
								path: "ledger/runs.jsonl",
								mode: "100644",
								type: "blob",
								sha: blob,
							},
						],
					};
				else if (path.includes("/git/blobs/"))
					value = { encoding: "base64", content: ledger.toString("base64") };
				else if (path.includes("/labels/")) value = { name: "factory:defect" };
				else if (/\/(?:issues\?labels=|reviews\?|timeline\?)/.test(path))
					value = [];
				else
					return {
						code: 1,
						stdout: "",
						stderr: "workflow unavailable in fixture",
					};

				return { code: 0, stdout: JSON.stringify(value), stderr: "" };
			},
		};

		const refresh = async (expectedReviewQueries: number) => {
			calls.length = 0;

			const snapshot = await collectOwnerMetrics(
				root,
				repo,
				io,
				cache,
				EXE_DEV_PLATFORM,
			);

			assert.ok(snapshot !== null);
			assert.equal(
				calls.filter((args) =>
					args.some((arg) => arg.includes("/issues?labels=")),
				).length,
				1,
			);
			assert.equal(
				calls.filter((args) => args.some((arg) => /\/reviews\?/.test(arg)))
					.length,
				expectedReviewQueries,
			);
			assert.equal(
				calls.filter((args) => args.some((arg) => /\/timeline\?/.test(arg)))
					.length,
				expectedReviewQueries,
			);
		};

		await refresh(1);
		await refresh(0);
		assert.ok(original.pr !== null);
		rows.push({
			...original,
			eventId: "101",
			runId: runIdOf({ repo, issue: original.issue, eventId: "101" }),
			pr: {
				...original.pr,
				number: original.pr.number + 1,
				url: `https://github.com/${repo}/pull/${original.pr.number + 1}`,
			},
		});
		await refresh(1);
		rows[0] = {
			...original,
			outcome: {
				...original.outcome,
				mergeSha: gitObjectSha("blob", Buffer.from("different merge")),
			},
		};
		await refresh(1);
	});
});

test("metric collection stops remote reads at the 120 second deadline", async (context) => {
	await state(async (root) => {
		let elapsed = 0;
		let calls = 0;
		context.mock.method(Date, "now", () => now + elapsed);
		await assert.rejects(
			collectOwnerMetrics(
				root,
				repo,
				{
					readPlatformFile: noPlatformFile,
					env: () => undefined,
					stdout: assert.fail,
					stderr: assert.fail,
					exec: async (_command, _args, options) => {
						calls++;
						const timeout = options?.timeoutMs ?? 30000;
						assert.ok(timeout <= 120000 - elapsed);
						elapsed += timeout;

						return calls === 1
							? {
									code: 0,
									stdout: JSON.stringify({
										ref: "refs/heads/factory/ledger",
										object: { sha: "a".repeat(40) },
									}),
									stderr: "",
								}
							: { code: 1, stdout: "", stderr: "connection reset" };
					},
				},
				new Map(),
				EXE_DEV_PLATFORM,
			),
			/metric_deadline/,
		);
		assert.ok(calls > 0);
		assert.equal(elapsed, 120000);
	});
});

test("status writes use cached tokens without recomputing local accounting", async () => {
	await state(async (root) => {
		const usage = { kind: "exact", unit: "tokens", total: 123456 };

		assert.equal(
			await writeStatus(root, report, EXE_DEV_PLATFORM, usage),
			true,
		);

		const stored = JSON.parse(
			await readFile(join(root, "status.json"), "utf8"),
		);

		assert.deepEqual(stored.durableUsage, usage);
	});
});

test("durable usage refreshes at startup and every five minutes on its own timer", async (context) => {
	context.mock.timers.enable({ apis: ["setInterval"] });
	await state(async (root) => {
		const usage = await startDurableUsage({
			stateDir: root,
			repo,
			log: assert.fail,
		});

		try {
			assert.deepEqual(usage.current(), {
				kind: "lower_bound",
				unit: "tokens",
				total: 9912,
				reason: "receipt_missing",
			});
			await rm(join(root, "claims"), { recursive: true });
			context.mock.timers.tick(299_999);
			await writeStatus(root, report, EXE_DEV_PLATFORM, usage.current());
			assert.equal(
				JSON.parse(await readFile(join(root, "status.json"), "utf8"))
					.durableUsage.total,
				9912,
			);
			context.mock.timers.tick(1);
		} finally {
			await usage.stop();
		}

		assert.deepEqual(usage.current(), {
			kind: "exact",
			unit: "tokens",
			total: 0,
		});
	});
});

test("local durable tokens and workflow thresholds survive absent, failed and stale GitHub snapshots", async () => {
	await state(async (root) => {
		const thresholds = { waitingMs: 5 * 86_400_000, blockedMs: 8 * 3_600_000 };

		const usage = await startDurableUsage({
			stateDir: root,
			repo,
			log: assert.fail,
		});

		await usage.stop();
		assert.equal(
			await writeStatus(
				root,
				{ ...report, attentionThresholds: thresholds },
				EXE_DEV_PLATFORM,
				usage.current(),
			),
			true,
		);
		await unlink(join(root, "metrics.json"));

		const check = async () => {
			const feed = await readOwnerFeed({ stateDir: root, repo, now });
			assert.deepEqual(feed.durableUsage, { kind: "lower_bound", total: 9912 });
			assert.equal(
				feed.entries.find((entry) => entry.issue === 1)?.stale,
				false,
			);
			assert.equal(
				feed.entries.find((entry) => entry.issue === 2)?.stale,
				false,
			);
			const waiting = feed.entries.find((entry) => entry.issue === 1);
			assert.ok(waiting);
			assert.equal(
				(
					await readOwnerRun(root, waiting.runId, {
						repo,
						at: now,
						controller: feed.controller,
					})
				)?.stale,
				false,
			);
			assert.match(
				renderDashboard(feed, "", "token"),
				/At least 9.9K tokens recorded/,
			);
		};

		await check();
		const logs: { event: string; reason: unknown }[] = [];

		const failed = () =>
			startMetricSnapshots({
				stateDir: root,
				collect: async () => {
					throw new Error("defect_query_failed");
				},
				log: (event, fields) => {
					logs.push({ event, reason: fields.reason });
				},
			});

		await failed().stop();
		await check();
		await save(root, ["metrics.json"], {
			attentionThresholds: { waitingMs: 1, blockedMs: 1 },
			durableUsage: { kind: "exact", total: 0 },
			report: {
				repo,
				status: "complete",
				primary: { numerator: 1, denominator: 2, share: 0.5 },
			},
		});
		await failed().stop();
		await check();
		assert.deepEqual(
			logs,
			Array.from({ length: 2 }, () => ({
				event: "metrics_unavailable",
				reason: "defect_query_failed",
			})),
		);
		const feed = await readOwnerFeed({ stateDir: root, repo, now });
		assert.equal(feed.metrics.stale, true);
		assert.equal(feed.metrics.share, 0.5);
	});
});

test("metrics_unavailable reasons are bounded and never include transport text or paths", async () => {
	await state(async (root) => {
		const logs: unknown[] = [];

		const snapshots = startMetricSnapshots({
			stateDir: root,
			collect: async () => {
				throw new Error(`private /home/account/token=${"secret".repeat(1000)}`);
			},
			log: (event, fields) => logs.push({ event, ...fields }),
		});

		await snapshots.stop();
		assert.deepEqual(logs, [
			{ event: "metrics_unavailable", reason: "collection_failed" },
		]);
	});
});

test("a failed metric refresh retains the last good snapshot and records staleness", async () => {
	await state(async (root) => {
		const previous = {
			version: 1,
			computedAt: new Date(now).toISOString(),
			report: {
				repo,
				status: "complete",
				primary: { share: 0.5, numerator: 1, denominator: 2 },
			},
		};

		await writeFile(join(root, "metrics.json"), JSON.stringify(previous), {
			mode: 0o600,
		});

		const snapshots = startMetricSnapshots({
			stateDir: root,
			collect: async () => {
				throw new Error("metric_deadline");
			},
			log: () => undefined,
		});

		await snapshots.stop();

		const saved = JSON.parse(
			await readFile(join(root, "metrics.json"), "utf8"),
		);

		assert.deepEqual(saved.report, previous.report);
		assert.equal(saved.computedAt, previous.computedAt);
		assert.equal(saved.stale, true);
		assert.ok(Number.isFinite(Date.parse(saved.lastAttemptAt)));
		const feed = await readOwnerFeed({ stateDir: root, repo, now });
		assert.equal(feed.metrics.share, 0.5);
		assert.equal(feed.metrics.stale, true);
		assert.match(renderDashboard(feed, "", "token"), /Stale snapshot/);
	});
});

test("score publication starts after status and WATCHDOG and cannot widen the maximum ping gap", async () => {
	await state(async (root) => {
		const measure = async (scoring: boolean) => {
			const dir = join(root, scoring ? "scores" : "baseline");
			await mkdir(dir, { mode: 0o700 });
			const stop = new AbortController();
			let elapsed = 0;
			let ticks = 0;
			let calls = 0;
			const pings: number[] = [];
			let release = () => {};

			const pending = new Promise<boolean>((done) => {
				release = () => done(true);
			});

			await serveLoop({
				platform: EXE_DEV_PLATFORM,
				stateDir: dir,
				orchestrator: {
					pollIntervalMs: 30000,
					tick: async () => {
						ticks++;
						await new Promise<void>((done) => setImmediate(done));

						return report;
					},
				},
				signal: stop.signal,
				log: () => {},
				notify: async (message) => {
					if (message === "WATCHDOG=1") pings.push(elapsed);
				},
				pump: async () => {
					elapsed += 20000;
					await new Promise<void>((done) => setImmediate(done));

					return null;
				},
				scorePump: scoring
					? () => {
							calls++;
							assert.ok(existsSync(join(dir, "status.json")));
							assert.ok(
								pings.length >= 2,
								"the post-status WATCHDOG has already been sent",
							);

							return pending;
						}
					: undefined,
				sleep: async () => {
					elapsed += 30000;
					await new Promise<void>((done) => setImmediate(done));

					if (ticks === 3) {
						stop.abort();
						release();
					}
				},
			});
			assert.equal(
				calls,
				scoring ? 1 : 0,
				"only one score pump in flight; its settlement stays off the loop path",
			);

			return pings;
		};

		const baseline = await measure(false);
		const withScores = await measure(true);
		assert.deepEqual(withScores, baseline);
		assert.ok(
			Math.max(
				...withScores.slice(1).map((ping, i) => ping - withScores[i]!),
			) <= 50000,
		);
	});
});

test("a real orchestrator tick measures hung GitHub calls to their timeouts on a fake clock", async (context) => {
	const root = await mkdtemp(join(tmpdir(), "watchdog-tick-"));

	try {
		let elapsed = 0;
		const timeouts: number[] = [];

		const executor: StageExecutor = {
			recover: async () => undefined,
			reconciled: async () => true,
			preflight: async () => false,
			readAssessment: async () => null,
			spent: async () => null,
			output: async () => null,
			checkout: async () => ({ kind: "unavailable" }),
			launch: async () => {
				throw new Error("no model launch");
			},
		};

		const orchestrator = new Orchestrator({
			platform: EXE_DEV_PLATFORM,
			repo,
			scope: null,
			clock: { now: () => now + elapsed },
			log: () => undefined,
			store: fileAdmissionStore(root),
			files: fileRunFiles(root),
			executor,
			env: () => undefined,
			exec: async (_command, _args, options) => {
				const timeout = options?.timeoutMs ?? 30_000;
				timeouts.push(timeout);
				await new Promise((resolve) => setTimeout(resolve, 1));
				elapsed += timeout;

				return { code: 1, stdout: "", stderr: "fake GitHub timed out" };
			},
		});

		const started = performance.now();
		const signal = new AbortController();
		const pings: number[] = [];
		let iterations = 0;
		await serveLoop({
			platform: EXE_DEV_PLATFORM,
			stateDir: root,
			orchestrator,
			signal: signal.signal,
			log: () => undefined,
			notify: async (message) => {
				if (message === "READY=1") assert.equal(timeouts.length, 0);
				else pings.push(elapsed);
			},
			pump: async () => {
				await new Promise<void>((done) => setImmediate(done));
				elapsed += 20_000;

				return null;
			},
			sleep: async () => {
				elapsed += 30_000;

				if (++iterations === 3) signal.abort();
			},
		});
		assert.ok(timeouts.length > 0 && elapsed >= 30_000);

		const worstGapMs = Math.max(
			...pings.slice(1).map((ping, i) => ping - pings[i]!),
		);

		assert.ok(worstGapMs < 120_000, `worst watchdog gap ${worstGapMs} ms`);
		context.diagnostic(
			JSON.stringify({
				clock: "fake; each remote call hangs until its timeout",
				calls: timeouts.length,
				timeouts,
				worstGapMs,
				watchdogMs: 120_000,
				realTestMs: Math.round(performance.now() - started),
			}),
		);
	} finally {
		await rm(root, { recursive: true, force: true });
	}
});
