import assert from "node:assert/strict";
import {
	mkdtemp,
	mkdir,
	rm,
	writeFile,
	cp,
	readdir,
	readFile,
	symlink,
} from "node:fs/promises";
import { request } from "node:http";
import { execFileSync } from "node:child_process";
import fs from "node:fs/promises";
import fsSync from "node:fs";
import { Evidence } from "../server/viewer/evidence.ts";
import { escapeHtml } from "../server/viewer/render.ts";
import { runCli } from "../server/cli.ts";
import { readStageReceipt, runSpecify } from "../server/sandbox.ts";
import { readStoredVerdict } from "../server/controller.ts";
import { viewerClaim } from "../server/viewer/claim.ts";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { readViewerRun, startViewer } from "../server/viewer.ts";
import { runIdOf, digestOf } from "../src/run.ts";
import { formatMarker } from "../src/markers.ts";
import { isRepoSlug, isGitSha, parseWorkflow } from "../src/workflow.ts";
import fixture from "./fixtures/viewer/sessions.json" with { type: "json" };

const runId = runIdOf({
	repo: "giuseppecrj/pi-herdr-factorio",
	issue: 1,
	eventId: "1",
});

test("repair claims preserve their counter without validation and display only the current round verdict", async () => {
	const f = await fixtureState();

	try {
		const claim = JSON.parse(
			await readFile(join(f.root, "claims", `${runId}.json`), "utf8"),
		);

		assert.equal(
			viewerClaim(JSON.stringify({ ...claim, round: 1 }), runId)?.round,
			1,
		);

		const validation = {
			version: 1,
			startedAt: 1,
			deadline: 2,
			round: 1,
			originalBase: "a".repeat(40),
			baseSha: "a".repeat(40),
			baseResolved: true,
			publication: null,
			dispatchTry: 1,
			dispatchedAt: 1,
			ciRunId: 1,
			counters: {},
		};

		await writeFile(
			join(f.root, "claims", `${runId}.json`),
			JSON.stringify({ ...claim, stage: "review", round: 1, validation }),
		);
		const dir = join(f.root, "validation", runId);
		await mkdir(join(dir, "r1"), { recursive: true });
		await writeFile(
			join(dir, "verdict.json"),
			JSON.stringify({ pass: false, checks: [] }),
			{ mode: 0o600 },
		);
		await writeFile(
			join(dir, "r1", "verdict.json"),
			JSON.stringify({ pass: true, checks: [] }),
			{ mode: 0o600 },
		);
		await mkdir(join(f.root, "stages", runId, "review-r1-1"));
		const viewed = await readViewerRun(f.root, runId);
		assert.deepEqual(
			viewed.timeline
				.filter((entry) => entry.event === "CI verdict")
				.map((entry) => [entry.round, entry.detail]),
			[[1, "passed"]],
		);
		assert.ok(
			viewed.gaps.some((entry) =>
				entry.source.includes("review-r1-1/receipt.json"),
			),
		);
		assert.ok(
			viewed.gaps.some(
				(entry) =>
					entry.source.includes("review/") &&
					entry.source.includes("r1/receipt.json"),
			),
		);
	} finally {
		await rm(f.root, { recursive: true, force: true });
	}
});

async function fixtureState(repo = "giuseppecrj/pi-herdr-factorio") {
	const runId = runIdOf({ repo, issue: 1, eventId: "1" });
	const root = await mkdtemp(join(tmpdir(), "factory-viewer-"));
	const stage = join(root, "stages", runId, "build-1");
	const sessions = join(stage, "agent-0", "sessions");
	await mkdir(sessions, { recursive: true });
	await mkdir(join(root, "claims"));
	await writeFile(
		join(root, "claims", `${runId}.json`),
		JSON.stringify({
			runId,
			issue: 1,
			eventId: "1",
			status: "stage_passed",
			stage: "build",
			seq: 2,
			attempt: 1,
			usage: 20,
		}),
	);
	await writeFile(
		join(root, "status.json"),
		JSON.stringify({ runs: [{ runId }] }),
	);

	const admission = join(root, `admissions/github/${repo}/1`);

	await mkdir(admission, { recursive: true });
	await writeFile(
		join(admission, "1.json"),
		JSON.stringify({
			snapshot: {
				title: "<script>alert('canary')</script>",
				body: "<img src=x onerror=alert(1)> & text",
			},
		}),
	);

	const receipt = {
		version: 1,
		runId,
		stage: "build",
		attempt: 1,
		outcome: { kind: "passed" },
		settlement: { event: "agent_settled", aborted: false },
		models: { requested: "openai/gpt-6.1-sol", observed: "gpt-6.1-sol" },
		turns: 1,
		wallMs: 100,
		usage: {
			total: 20,
			parent: 10,
			children: 10,
			byModel: { "openai/gpt-6.1-sol": 13, "openai/gpt-6.1-terra": 7 },
			gateway: 20,
			unreadChildren: 0,
		},
		stderr: [{ session: 0, file: "pi-stderr-0.log", bytes: 0 }],
		pricing: "unavailable",
	};

	await writeFile(join(stage, "receipt.json"), JSON.stringify(receipt));
	await writeFile(join(stage, "pi-stderr-0.log"), "");
	await writeFile(
		join(sessions, "parent.jsonl"),
		fixture.parent.map((record) => JSON.stringify(record)).join("\n"),
	);

	for (const [index, records] of fixture.children.entries())
		await writeFile(
			join(sessions, `child-${index === 0 ? "one" : "two"}.jsonl`),
			records.map((record) => JSON.stringify(record)).join("\n"),
		);
	await writeFile(
		join(stage, "egress.jsonl"),
		JSON.stringify({
			v: 1,
			runId,
			stage: "build",
			attempt: 1,
			ts: "2026-10-31T00:00:01Z",
			decision: "deny",
			upstream: null,
			path: "/github/repos/example",
			method: "GET",
			reason: "no-route",
		}),
	);
	await mkdir(join(root, "markers"));

	for (const name of ["specify", "accept"]) {
		const earlier = join(root, "stages", runId, `${name}-1`);
		await mkdir(earlier);
		await writeFile(
			join(earlier, "receipt.json"),
			JSON.stringify({
				...receipt,
				stage: name,
				usage: {
					total: 0,
					parent: 0,
					children: 0,
					byModel: {},
					gateway: 0,
					unreadChildren: 0,
				},
				stderr: [],
			}),
		);
	}

	const sha = "a".repeat(40);
	assert.ok(isRepoSlug(repo));
	assert.ok(isGitSha(sha));

	const body = formatMarker({
		v: 1,
		runId,
		repo,
		issue: 1,
		eventId: "1",
		eventAt: "2026-10-31T00:00:00Z",
		snapshotDigest: digestOf("snapshot"),
		workflowSha: sha,
		workflowDigest: digestOf("workflow"),
		stage: "build",
		status: "stage_passed",
		attempt: 1,
		seq: 2,
		branch: null,
		pr: null,
		usage: 20,
		cursor: null,
	});

	await writeFile(
		join(root, "markers", `${runId}.jsonl`),
		JSON.stringify({ timestamp: "2026-10-31T00:00:06Z", body }),
	);

	return { root, stage, sessions, runId };
}

async function inventory(root: string): Promise<string[]> {
	const entries: string[] = [];

	for (const entry of await readdir(root, { withFileTypes: true })) {
		const path = join(root, entry.name);

		if (entry.isDirectory()) entries.push(...(await inventory(path)));
		else entries.push(`${path}:${digestOf(await readFile(path))}`);
	}

	return entries.sort();
}

test("receipt and verdict reader extractions preserve their existing parse contracts", async () => {
	const { root, stage } = await fixtureState();

	try {
		const parsed = await readStageReceipt(join(stage, "receipt.json"));
		assert.equal(parsed?.usage.total, 20);
		assert.deepEqual(parsed?.outcome, { kind: "passed" });
		assert.equal(await readStageReceipt(join(stage, "absent")), null);
		const verdict = { pass: false, checks: [] };
		await writeFile(join(root, "verdict.json"), JSON.stringify(verdict), {
			mode: 0o600,
		});
		assert.deepEqual(readStoredVerdict(join(root, "verdict.json")), verdict);
		await fs.chmod(join(root, "verdict.json"), 0o644);
		assert.throws(() => readStoredVerdict(join(root, "verdict.json")));
		await fs.chmod(join(root, "verdict.json"), 0o600);
		await writeFile(join(root, "verdict.json"), "{");
		assert.throws(() => readStoredVerdict(join(root, "verdict.json")));
	} finally {
		await rm(root, { recursive: true, force: true });
	}
});

test("viewer aggregates parent and two child models without double counting", async () => {
	const { root, stage } = await fixtureState();

	try {
		const run = await readViewerRun(root, runId);
		assert.equal(run.complete, true, JSON.stringify(run.gaps));
		assert.equal(run.usage.total, 20);
		assert.deepEqual(run.usage.models, [
			{
				model: "openai/gpt-6.1-sol",
				parent: 10,
				children: 3,
				total: 13,
				cost: "unavailable",
			},
			{
				model: "openai/gpt-6.1-terra",
				parent: 0,
				children: 7,
				total: 7,
				cost: "unavailable",
			},
		]);
		assert.equal(run.children.length, 2);
		assert.ok(
			run.children.every(
				(child) => child.parent === "parent" && child.timeline.length === 2,
			),
		);
		assert.equal(run.gateway[0]?.decision, "deny");
		assert.match(run.gateway[0]?.path ?? "", /github/);
		await mkdir(join(stage, "draft"));
		await cp(join(stage, "receipt.json"), join(stage, "draft", "receipt.json"));
		assert.equal((await readViewerRun(root, runId)).usage.total, 20);
	} finally {
		await rm(root, { recursive: true, force: true });
	}
});

test("an execution missing its receipt is a gap even when other stages have receipts", async () => {
	const { root, stage } = await fixtureState();

	try {
		const other = join(root, "stages", runId, "accept-1");
		await mkdir(other, { recursive: true });
		await cp(join(stage, "receipt.json"), join(other, "receipt.json"));
		await rm(join(stage, "receipt.json"));
		const run = await readViewerRun(root, runId);
		assert.ok(
			run.gaps.some((gap) => gap.source.endsWith("build-1/receipt.json")),
		);
	} finally {
		await rm(root, { recursive: true, force: true });
	}
});

test("corrupt receipts, sessions and unsafe sources stay visible gaps", async () => {
	const { root, stage, sessions } = await fixtureState();

	try {
		await rm(join(sessions, "child-one.jsonl"));
		await writeFile(join(sessions, "broken.jsonl"), "{bad\n");
		await writeFile(join(stage, "receipt.json"), "{broken");
		await symlink("/etc/passwd", join(stage, "leak.jsonl"));
		const run = await readViewerRun(root, runId);
		assert.equal(run.complete, false);
		assert.ok(
			run.gaps.some((gap) => gap.reason.includes("missing_child_session")),
		);
		assert.ok(run.gaps.some((gap) => gap.reason.includes("corrupt JSONL")));
		assert.ok(run.gaps.some((gap) => gap.reason.includes("stage receipt")));
		assert.ok(run.gaps.some((gap) => gap.reason.includes("symlink")));
	} finally {
		await rm(root, { recursive: true, force: true });
	}
});

test("HTML is escaped, four JSON views exist and requests do not mutate evidence", async () => {
	const { root } = await fixtureState();
	const before = await inventory(root);
	const viewer = await startViewer({ stateDir: root, runId, port: 0 });

	try {
		const url = `http://127.0.0.1:${viewer.port}/run/${runId}`;
		const html = await (await fetch(`${url}/timeline`)).text();
		assert.match(
			html,
			/&lt;script&gt;alert\(&#39;canary&#39;\)&lt;\/script&gt;/,
		);
		assert.ok(!html.includes("<script>"));
		assert.match(html, /&lt;img/);

		for (const view of ["timeline", "usage", "children", "gateway"]) {
			const response = await fetch(`${url}/${view}.json`);
			assert.equal(response.status, 200);
			assert.match(
				response.headers.get("content-type") ?? "",
				/application\/json/,
			);
		}

		for (const method of ["POST", "PUT", "DELETE"])
			assert.equal((await fetch(`${url}/timeline`, { method })).status, 405);
		assert.equal((await fetch(`${url}/../../etc/passwd`)).status, 404);
		assert.deepEqual(await inventory(root), before);
	} finally {
		await viewer.close();
		await rm(root, { recursive: true, force: true });
	}
});

test("viewer CLI errors never call gh or a model", async () => {
	const stderr: string[] = [];

	for (const argv of [
		["viewer"],
		["viewer", "--state-dir", "/absent"],
		["viewer", "--state-dir", "/tmp", "--port", "0"],
		["viewer", "--state-dir", "/tmp", "--run", "../../etc/passwd"],
	]) {
		const code = await runCli(argv, {
			exec: async () => {
				throw new Error("unexpected command");
			},
			env: () => undefined,
			stdout: () => {},
			stderr: (text) => stderr.push(text),
		});

		assert.ok(code > 0);
	}

	assert.equal(stderr.length, 4);
});

test("viewer reports gaps instead of inventing a complete run", async () => {
	const root = await mkdtemp(join(tmpdir(), "factory-viewer-"));

	try {
		await mkdir(join(root, "stages", runId), { recursive: true });
		const run = await readViewerRun(root, runId);
		assert.equal(run.complete, false);
		assert.ok(run.gaps.some((gap) => gap.source === "status.json"));
		assert.ok(run.gaps.some((gap) => gap.source.includes("claims")));
	} finally {
		await rm(root, { recursive: true, force: true });
	}
});

test("viewer is loopback-only, rejects foreign authorities and has no writes", async () => {
	const root = await mkdtemp(join(tmpdir(), "factory-viewer-"));
	const viewer = await startViewer({ stateDir: root, port: 0 });

	try {
		const url = `http://127.0.0.1:${viewer.port}`;
		assert.equal((await fetch(url)).status, 200);
		assert.equal(
			await new Promise<number>((done, reject) => {
				const req = request(
					url,
					{ headers: { Host: "evil.example" } },
					(response) => {
						response.resume();
						done(response.statusCode ?? 0);
					},
				);

				req.on("error", reject);
				req.end();
			}),
			403,
		);
		assert.equal(
			(await fetch(url, { headers: { Origin: "https://evil.example" } }))
				.status,
			403,
		);

		for (const method of ["POST", "PUT", "DELETE", "HEAD", "OPTIONS"]) {
			assert.equal((await fetch(url, { method })).status, 405);
		}

		const response = await fetch(url);
		assert.match(
			response.headers.get("content-security-policy") ?? "",
			/default-src 'none'/,
		);
		assert.equal(response.headers.get("access-control-allow-origin"), null);
	} finally {
		await viewer.close();
		await rm(root, { recursive: true, force: true });
	}
});

test("missing earlier stage receipts are gaps even when the entire directory is gone", async () => {
	const { root } = await fixtureState();

	try {
		await rm(join(root, "stages", runId, "specify-1"), { recursive: true });
		const run = await readViewerRun(root, runId);
		assert.equal(run.complete, false);
		assert.ok(
			run.gaps.some((g) => g.source.endsWith("specify-1/receipt.json")),
		);
	} finally {
		await rm(root, { recursive: true, force: true });
	}
});

test("timeline uses parsed mixed-precision timestamps and stable source order on ties", async () => {
	const { root, sessions } = await fixtureState();

	try {
		const path = join(sessions, "parent.jsonl");
		const text = await readFile(path, "utf8");
		await writeFile(
			path,
			text
				.replaceAll("2026-10-31T00:00:00Z", "2026-10-31T06:31:54.863Z")
				.replaceAll("2026-10-31T00:00:01Z", "2026-10-31T06:31:54.863Z"),
		);
		const marker = join(root, "markers", `${runId}.jsonl`);
		await writeFile(
			marker,
			(await readFile(marker, "utf8")).replace(
				"2026-10-31T00:00:06Z",
				"2026-10-31T06:31:54Z",
			),
		);
		const run = await readViewerRun(root, runId);
		const timed = run.timeline.filter((e) => e.at !== null);
		assert.deepEqual(
			timed.map((e) => Date.parse(e.at ?? "")),
			timed.map((e) => Date.parse(e.at ?? "")).sort((a, b) => a - b),
		);
		assert.deepEqual(
			timed
				.filter((e) => e.at === "2026-10-31T06:31:54.863Z")
				.map((e) => e.event),
			["session", "assistant"],
		);
	} finally {
		await rm(root, { recursive: true, force: true });
	}
});

test("admission repository comes from the run identity, not the default repository", async () => {
	const { root, runId: id } = await fixtureState("different/project");

	try {
		const run = await readViewerRun(root, id);
		assert.equal(run.complete, true, JSON.stringify(run.gaps));
		assert.ok(run.issue !== null);
	} finally {
		await rm(root, { recursive: true, force: true });
	}
});

test("claims are guarded regular bounded reads and sibling FIFOs cannot hang a view", async () => {
	const { root } = await fixtureState();
	const outside = await mkdtemp(join(tmpdir(), "viewer-outside-"));

	try {
		const sibling = join(root, "claims", `${"d".repeat(64)}.json`);
		execFileSync("mkfifo", [sibling]);
		const script = `import { readViewerRun } from ${JSON.stringify(new URL("../server/viewer.ts", import.meta.url).href)}; await readViewerRun(${JSON.stringify(root)}, ${JSON.stringify(runId)});`;
		execFileSync(process.execPath, ["--input-type=module", "-e", script], {
			timeout: 5000,
		});
		const path = join(root, "claims", `${runId}.json`);
		await rm(path);
		await writeFile(join(outside, "claim"), "{}");
		await symlink(join(outside, "claim"), path);
		assert.ok(
			(await readViewerRun(root, runId)).gaps.some(
				(g) => g.source === `claims/${runId}.json`,
			),
		);
		await rm(path);
		execFileSync("mkfifo", [path]);
		execFileSync(process.execPath, ["--input-type=module", "-e", script], {
			timeout: 5000,
		});
		await rm(path);
		await writeFile(path, " ".repeat(8 * 1024 * 1024 + 1));
		assert.ok(
			(await readViewerRun(root, runId)).gaps.some(
				(g) =>
					g.source === `claims/${runId}.json` && g.reason.includes("limit"),
			),
		);
	} finally {
		await rm(root, { recursive: true, force: true });
		await rm(outside, { recursive: true, force: true });
	}
});

test("invalid allowed-host is a usage error, exit 2", async () => {
	for (const host of ["evil.com", "Box.Tail.ts.net", "box.tail.ts.net:443"]) {
		assert.equal(
			await runCli(["viewer", "--state-dir", "/tmp", "--allowed-host", host], {
				exec: async () => {
					throw new Error("unexpected command");
				},
				env: () => undefined,
				stdout: () => {},
				stderr: () => {},
			}),
			2,
		);
	}
});

test("escaping quotes and every bidi control leaves visible escapes", () => {
	assert.equal(escapeHtml('"'), "&quot;");

	for (const n of [
		0x061c, 0x200e, 0x200f, 0x202a, 0x202b, 0x202c, 0x202d, 0x202e, 0x2066,
		0x2067, 0x2068, 0x2069,
	])
		assert.equal(
			escapeHtml(String.fromCodePoint(n)),
			`\\u${n.toString(16).padStart(4, "0")}`,
		);
});

test("run pin, unknown runs, listener and security headers are enforced", async () => {
	const { root } = await fixtureState();
	const other = "e".repeat(64);
	await mkdir(join(root, "stages", other));
	const viewer = await startViewer({ stateDir: root, port: 0, runId });
	const unpinned = await startViewer({ stateDir: root, port: 0 });

	try {
		assert.equal(viewer.address, "127.0.0.1");
		assert.equal(
			(await fetch(`http://127.0.0.1:${viewer.port}/run/${other}/timeline`))
				.status,
			404,
		);
		assert.equal(
			(
				await fetch(
					`http://127.0.0.1:${unpinned.port}/run/${"f".repeat(64)}/timeline`,
				)
			).status,
			404,
		);

		for (const path of [
			"/",
			`/run/${runId}/timeline`,
			`/run/${runId}/usage.json`,
			"/absent",
		]) {
			const response = await fetch(`http://127.0.0.1:${viewer.port}${path}`);
			assert.match(
				response.headers.get("content-security-policy") ?? "",
				/frame-ancestors 'none'/,
			);
			assert.equal(response.headers.get("x-content-type-options"), "nosniff");
			assert.equal(response.headers.get("cache-control"), "no-store");
		}
	} finally {
		await viewer.close();
		await unpinned.close();
		await rm(root, { recursive: true, force: true });
	}
});

test("guarded reader refuses symlinked run directories and nofollow closes a final-path swap", async () => {
	const { root } = await fixtureState();
	const dir = join(root, "stages", runId);
	await fs.rename(dir, `${dir}-outside`);
	await symlink(`${dir}-outside`, dir);

	try {
		assert.ok(
			(await readViewerRun(root, runId)).gaps.some(
				(g) => g.source === `stages/${runId}`,
			),
		);
		assert.ok(
			!(await readViewerRun(root, runId)).timeline.some(
				(e) => e.event === "stage receipt",
			),
		);
		const claimPath = join(root, "claims", `${runId}.json`);
		await fs.rename(claimPath, `${claimPath}.saved`);
		await symlink(`${claimPath}.saved`, claimPath);
		const reader = new Evidence(root);
		reader.safe = async () => true;
		assert.equal(await reader.text(claimPath), null);
		assert.ok(reader.gaps.some((g) => g.source === `claims/${runId}.json`));
	} finally {
		await rm(root, { recursive: true, force: true });
	}
});

test("file, aggregate byte and directory entry caps yield gaps", async () => {
	const { root, sessions, stage } = await fixtureState();

	try {
		const large = join(sessions, "large.jsonl");
		await writeFile(large, " ".repeat(8 * 1024 * 1024 + 1));
		assert.ok(
			(await readViewerRun(root, runId)).gaps.some(
				(g) => g.source.endsWith("large.jsonl") && g.reason.includes("limit"),
			),
		);
		await rm(large);

		for (let i = 0; i < 7; i++)
			await writeFile(
				join(sessions, `large-${i}.jsonl`),
				" ".repeat(8 * 1024 * 1024),
			);
		assert.ok(
			(await readViewerRun(root, runId)).gaps.some(
				(g) => g.source.includes("large-") && g.reason.includes("limit"),
			),
		);

		for (let i = 0; i < 7; i++) await rm(join(sessions, `large-${i}.jsonl`));
		const many = join(stage, "many");
		await mkdir(many);

		for (let i = 0; i < 10001; i++)
			fsSync.writeFileSync(join(many, String(i)), "");
		assert.ok(
			(await readViewerRun(root, runId)).gaps.some(
				(g) => g.reason === "entry limit",
			),
		);
	} finally {
		await rm(root, { recursive: true, force: true });
	}
});

for (const scenario of [
	"session",
	"reconcile",
	"receipt total reconcile",
	"gateway",
	"markers",
	"settlement",
	"receipt binding",
	"audit binding",
	"truncated",
])
	test(`named evidence gap: ${scenario}`, async () => {
		const { root, sessions, stage } = await fixtureState();

		try {
			let reason = "";

			if (scenario === "session") {
				await rm(sessions, { recursive: true });
				reason = "Pi session JSONL";
			}

			if (scenario === "reconcile") {
				await writeFile(
					join(sessions, "parent.jsonl"),
					(await readFile(join(sessions, "parent.jsonl"), "utf8")).replace(
						'"totalTokens":10',
						'"totalTokens":11',
					),
				);
				reason = "reconcile";
			}

			if (scenario === "receipt total reconcile") {
				const path = join(stage, "receipt.json");
				const receipt = JSON.parse(await readFile(path, "utf8"));
				receipt.usage.total++;
				await writeFile(path, JSON.stringify(receipt));
				reason = "reconcile";
			}

			if (scenario === "gateway") {
				await rm(join(stage, "egress.jsonl"));
				reason = "gateway audit missing";
			}

			if (scenario === "markers") {
				await rm(join(root, "markers", `${runId}.jsonl`));
				reason = "marker comment history";
			}

			if (["settlement", "receipt binding", "truncated"].includes(scenario)) {
				const path = join(stage, "receipt.json");
				const receipt = JSON.parse(await readFile(path, "utf8"));

				if (scenario === "settlement") {
					receipt.settlement.event = null;
					reason = "settlement not observed";
				}

				if (scenario === "receipt binding") {
					receipt.runId = "a".repeat(64);
					reason = "mismatched stage receipt";
				}

				if (scenario === "truncated") {
					receipt.session_truncated = ["old.jsonl"];
					reason = "session_truncated";
				}

				await writeFile(path, JSON.stringify(receipt));
			}

			if (scenario === "audit binding") {
				const path = join(stage, "egress.jsonl");
				await writeFile(
					path,
					(await readFile(path, "utf8")).replace(runId, "b".repeat(64)),
				);
				reason = "mismatched audit";
			}

			const run = await readViewerRun(root, runId);
			assert.equal(run.complete, false);
			assert.ok(
				run.gaps.some((g) => g.reason.includes(reason)),
				JSON.stringify(run.gaps),
			);
		} finally {
			await rm(root, { recursive: true, force: true });
		}
	});

test("receipt recovery only reads the designated output file", async () => {
	const { root, stage } = await fixtureState();

	try {
		const receipt = JSON.parse(
			await readFile(join(stage, "receipt.json"), "utf8"),
		);

		receipt.output = { file: "other.txt", kept: true, bytes: 6 };
		receipt.stage = "specify";
		const target = join(root, "stages", runId, "specify-1", "draft");
		await mkdir(target);
		await writeFile(join(target, "receipt.json"), JSON.stringify(receipt));
		await writeFile(
			join(target, "other.txt"),
			JSON.stringify({
				kind: "questions",
				questions: [{ text: "Which format?", cites: [] }],
			}),
		);
		const repo = "giuseppecrj/pi-herdr-factorio";
		assert.ok(isRepoSlug(repo));

		const parsed = parseWorkflow({
			text: `---\nrepository: ${repo}\n---\n`,
			repo,
			env: (name) => (name === "HOME" ? "/home/factory" : undefined),
		});

		assert.equal(parsed.kind, "valid");

		if (parsed.kind !== "valid") return;
		const settings = parsed.config.stages.specify;

		const result = await runSpecify(
			{
				runId,
				stage: "specify",
				attempt: 1,
				workspace: root,
				prompt: "unused",
				tools: [],
				skills: [],
				settings: {
					model: settings.model,
					fallback: null,
					maxTokens: 40000,
					budget: { maxTurns: 10, wallMs: 60000, stallMs: 60000 },
				},
				remainingRunTokens: 40000,
				signal: new AbortController().signal,
				progress: () => {},
				specify: { title: "Title", body: "Body", answers: null, files: [] },
			},
			join(target, ".."),
			() => {
				throw new Error("unexpected model");
			},
		);

		assert.equal(result.kind, "failed");
	} finally {
		await rm(root, { recursive: true, force: true });
	}
});

test("denied gateway requests never invent an upstream", async () => {
	const { root } = await fixtureState();

	try {
		assert.equal(
			(await readViewerRun(root, runId)).gateway[0]?.destination,
			"not forwarded (no upstream)",
		);
	} finally {
		await rm(root, { recursive: true, force: true });
	}
});

test("viewer refuses missing state and occupied port", async () => {
	await assert.rejects(
		startViewer({ stateDir: "/not/a/factory/state", port: 0 }),
	);
	const root = await mkdtemp(join(tmpdir(), "factory-viewer-"));
	const viewer = await startViewer({ stateDir: root, port: 0 });

	try {
		await assert.rejects(startViewer({ stateDir: root, port: viewer.port }));
	} finally {
		await viewer.close();
		await rm(root, { recursive: true, force: true });
	}
});
