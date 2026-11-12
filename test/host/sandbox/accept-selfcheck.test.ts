import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { test } from "node:test";
import { LineSplitter } from "../../../host/sandbox/lines.ts";
import {
	objectOf,
	parseJson,
	type JsonObject,
} from "../../../src/core/json.ts";

test("pinned Pi 1.4.0 accepts a second prompt after settlement (scripted local transport, zero model calls)", {
	timeout: 30000,
}, async (t) => {
	const dir = mkdtempSync(join(tmpdir(), "selfcheck-pi-"));
	t.after(() => rmSync(dir, { recursive: true, force: true }));
	const requests: string[] = [];

	const server = createServer((req, res) => {
		const chunks: Buffer[] = [];
		req.on("data", (chunk) => chunks.push(chunk));
		req.on("end", () => {
			requests.push(Buffer.concat(chunks).toString("utf8"));
			res.writeHead(200, { "Content-Type": "text/event-stream" });
			res.end(
				`data: ${JSON.stringify({ id: "scripted", object: "chat.completion.chunk", created: 0, model: "scripted", choices: [{ index: 0, delta: { role: "assistant", content: `reply-${requests.length}` }, finish_reason: "stop" }], usage: { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 } })}\n\ndata: [DONE]\n\n`,
			);
		});
	});

	await new Promise<void>((done) => server.listen(0, "127.0.0.1", done));
	t.after(() => new Promise<void>((done) => server.close(() => done())));
	const address = server.address();
	assert.ok(address !== null && address instanceof Object);
	writeFileSync(
		join(dir, "models.json"),
		JSON.stringify({
			providers: {
				selfcheck: {
					baseUrl: `http://127.0.0.1:${address.port}/v1`,
					api: "openai-completions",
					apiKey: "synthetic-not-a-secret",
					models: [
						{
							id: "scripted",
							reasoning: false,
							input: ["text"],
							contextWindow: 128000,
							maxTokens: 100,
							cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
						},
					],
				},
			},
		}),
	);

	const cli = resolve(
		"node_modules/@earendil-works/pi-coding-agent/dist/cli.js",
	);

	const pi = spawn(
		process.execPath,
		[
			cli,
			"--mode",
			"rpc",
			"--no-session",
			"--no-extensions",
			"--no-skills",
			"--no-prompt-templates",
			"--no-context-files",
			"--tools",
			"",
			"--provider",
			"selfcheck",
			"--model",
			"scripted",
			"--thinking",
			"off",
		],
		{
			cwd: dir,
			env: { PATH: process.env.PATH, HOME: dir, PI_CODING_AGENT_DIR: dir },
			stdio: ["pipe", "pipe", "pipe"],
		},
	);

	t.after(() => pi.kill());
	let stderr = "";
	pi.stderr.on("data", (chunk) => {
		stderr += String(chunk);
	});
	const splitter = new LineSplitter(1024 * 1024);
	const records: JsonObject[] = [];
	await new Promise<void>((done, reject) => {
		let settled = 0;
		pi.on("error", reject);
		pi.on("exit", () => {
			if (settled !== 2) reject(new Error(`Pi exited: ${stderr}`));
		});
		pi.stdout.on("data", (chunk: Buffer) => {
			for (const line of splitter.push(chunk) ?? []) {
				const record = objectOf(parseJson(line));
				assert.ok(record !== null);
				records.push(record);

				if (record.type !== "agent_settled") continue;
				settled++;

				if (settled === 1)
					pi.stdin.write(
						`${JSON.stringify({ id: "second", type: "prompt", message: "second prompt" })}\n`,
					);
				else {
					pi.stdin.end();
					done();
				}
			}
		});
		pi.stdin.write(
			`${JSON.stringify({ id: "first", type: "prompt", message: "first prompt" })}\n`,
		);
	});

	for (const id of ["first", "second"])
		assert.ok(
			records.some(
				(r) => r.type === "response" && r.id === id && r.success === true,
			),
		);
	assert.equal(requests.length, 2);
	assert.ok(requests[1]?.includes("first prompt"));
	assert.ok(requests[1]?.includes("reply-1"));
	assert.ok(requests[1]?.includes("second prompt"));
	assert.equal(
		records.filter((r) => r.type === "auto_compaction_start").length,
		0,
	);
});
