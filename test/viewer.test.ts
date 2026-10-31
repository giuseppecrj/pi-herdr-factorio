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
import { runCli } from "../server/cli.ts";
import { readStageReceipt } from "../server/sandbox.ts";
import { readStoredVerdict } from "../server/controller.ts";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { readViewerRun, startViewer } from "../server/viewer.ts";
import { runIdOf, digestOf } from "../src/run.ts";
import { formatMarker } from "../src/markers.ts";
import { isRepoSlug, isGitSha } from "../src/workflow.ts";
import fixture from "./fixtures/viewer/sessions.json" with { type: "json" };

const runId = runIdOf({
	repo: "giuseppecrj/pi-herdr-factorio",
	issue: 1,
	eventId: "1",
});

async function fixtureState() {
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

	const admission = join(
		root,
		"admissions/github/giuseppecrj/pi-herdr-factorio/1",
	);

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
	const repo = "giuseppecrj/pi-herdr-factorio";
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

	return { root, stage, sessions };
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
			run.gaps.some((gap) => gap.reason.includes("child session missing")),
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
