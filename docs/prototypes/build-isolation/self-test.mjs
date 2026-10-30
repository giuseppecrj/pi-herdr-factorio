import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import * as fs from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import vm from "node:vm";

const text = fs.readFileSync(new URL("./probe.ts", import.meta.url), "utf8");
const source = text
	.match(/const source = String.raw`([\s\S]*?)`;/)[1]
	.replace(/^import .*;$/gm, "");
const predicate = text.match(/const pass =([\s\S]*?);\n\n\tconsole.log/)[1];
const tools = ["read", "grep", "ls", "bash", "write", "edit"];
const canary = `factory-holdout-${"b".repeat(64)}`;
const id = "a".repeat(64);
const body =
	'import assert from "node:assert/strict"; assert.equal(PRIVATE_FIXTURE,42);';
const path = "private-heldout.test.ts";
const raw = JSON.stringify({
	version: 1,
	files: [{ path, type: "node:test", content: body }],
});
const hash = (s) => createHash("sha256").update(s).digest("hex");

const input = {
	__build: true,
	runId: id,
	gitLayout: "tmpfs",
	privatePaths: [
		`acceptance/${id}`,
		`acceptance/${id}.json`,
		`contracts/${id}`,
		`stages/${id}/accept-1`,
		`stages/${id}/accept-2.2`,
	],
	fingerprints: { files: [hash(raw), hash(body)], paths: [hash(path)] },
};

const passes = (seen, stdout, code) =>
	vm.runInNewContext(`(${predicate})`, {
		seen,
		tools,
		stdout,
		stderr: "",
		canary,
		code,
		privateOutputLeak: false,
	});

async function fixture(change = () => {}, code = 0) {
	const root = fs.mkdtempSync(join(tmpdir(), "acceptance-detector-"));
	const mapped = (p) => join(root, p);
	const config = structuredClone(input);

	const write = (p, data) => {
		fs.mkdirSync(join(mapped(p), ".."), { recursive: true });
		fs.writeFileSync(mapped(p), data);
	};

	try {
		for (const p of [
			"workspace/.git",
			"run/pi-agent/sessions",
			"home/agent",
			"tmp",
			"opt/factory",
			"etc",
			"proc/self",
		])
			fs.mkdirSync(mapped(p), { recursive: true });
		write("/workspace/README.md", "public checkout\n");
		write(
			"/proc/1/cmdline",
			`bwrap\0--bind\0/state/workspaces/${id}-build-1\0/workspace\0`,
		);
		write(
			"/proc/self/mountinfo",
			["/home", "/tmp", "/run", "/workspace/.git"]
				.map(
					(p, i) =>
						`${i + 1} 0 0:1 / ${p} ${p === "/workspace/.git" ? "ro" : "rw"} - tmpfs tmpfs rw`,
				)
				.join("\n"),
		);
		change({ write, mapped, config });
		let stdout = "";

		const ctx = {
			Buffer,
			createHash,
			existsSync: (p) => fs.existsSync(mapped(p)),
			readFileSync: (p, ...args) =>
				p === 0 ? JSON.stringify(config) : fs.readFileSync(mapped(p), ...args),
			readdirSync: (p, ...args) => fs.readdirSync(mapped(p), ...args),
			lstatSync: (p) => fs.lstatSync(mapped(p)),
			statSync: (p) => fs.statSync(mapped(p)),
			process: { env: { FACTORY_PI_TOOLS: tools.join(",") } },
			AbortSignal,
			http: {
				get: (_url, cb) => {
					cb({
						resume() {},
						statusCode: 403,
						on(_event, done) {
							done();
						},
					});

					return { on() {} };
				},
			},
			fetch: async () => {
				throw new Error("network intentionally stubbed");
			},
			console: {
				log: (s) => {
					stdout += `${s}\n`;
				},
			},
		};

		await vm.runInNewContext(`(async () => {${source}})()`, ctx);
		const seen = JSON.parse(stdout.slice(6));

		return { seen, pass: passes(seen, stdout, code) };
	} finally {
		if (fs.existsSync(mapped("/etc/ssl")))
			fs.chmodSync(mapped("/etc/ssl"), 0o700);

		if (fs.existsSync(mapped("/etc/ssl/private")))
			fs.chmodSync(mapped("/etc/ssl/private"), 0o700);
		fs.rmSync(root, { recursive: true, force: true });
	}
}

test("clean positive control completes the detector", async () => {
	const r = await fixture();
	assert.equal(r.pass, true);
});

test("rejects a copied raw accept output in the build workspace", async () => {
	assert.equal(
		(await fixture(({ write }) => write("/workspace/copied.json", raw))).pass,
		false,
	);
});

test("rejects a copied test body under node_modules", async () => {
	assert.equal(
		(
			await fixture(({ write }) =>
				write("/workspace/node_modules/x/body.ts", body),
			)
		).pass,
		false,
	);
});

test("rejects readable accept session dir", async () => {
	assert.equal(
		(
			await fixture(({ write }) =>
				write(`/state/stages/${id}/accept-1/agent-0/sessions/p.jsonl`, "x"),
			)
		).pass,
		false,
	);
});

test("rejects discovery of the accept (non-build) workspace", async () => {
	assert.equal(
		(
			await fixture(({ write }) =>
				write(
					"/proc/1/cmdline",
					`bwrap\0--bind\0/state/workspaces/${id}\0/workspace\0`,
				),
			)
		).pass,
		false,
	);
});

test("rejects a leftover own session", async () => {
	assert.equal(
		(
			await fixture(({ write }) =>
				write("/run/pi-agent/sessions/old.jsonl", "x"),
			)
		).pass,
		false,
	);
});

test("positive leak control detects a canary", async () => {
	assert.equal(
		(await fixture(({ write }) => write("/workspace/c.txt", canary))).pass,
		false,
	);
});

test("does NOT check pristine/patches/visible-tests (not inventoried): readable pristine still passes", async () => {
	assert.equal(
		(
			await fixture(({ write }) =>
				write(`/state/pristine/${id}/README.md`, "public"),
			)
		).pass,
		true,
	);
});
