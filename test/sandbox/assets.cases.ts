import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
	chmodSync,
	existsSync,
	mkdirSync,
	mkdtempSync,
	readFileSync,
	rmSync,
	statSync,
	symlinkSync,
	writeFileSync,
} from "node:fs";
import { createServer as createHttpServer } from "node:http";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import {
	manifestDigest,
	manifestLines,
	PINNED_VERSIONS,
} from "../../server/sandbox/manifest.ts";
import {
	fieldOf,
	objectOf,
	parseJson,
	textOf,
} from "../../server/sandbox/json.ts";

const ASSETS = new URL("../../server/sandbox/assets/", import.meta.url)
	.pathname;

function bundle(): string {
	const root = mkdtempSync(join(tmpdir(), "factory-bundle-"));

	mkdirSync(join(root, "bin"));
	mkdirSync(join(root, "etc"));
	writeFileSync(join(root, "etc", "hosts"), "127.0.0.1 localhost\n");
	writeFileSync(join(root, "bin", "tool"), "#!/bin/sh\n");
	chmodSync(join(root, "bin", "tool"), 0o755);
	symlinkSync("tool", join(root, "bin", "pi"));

	return root;
}

describe("asset manifest digest", () => {
	it("lists every file sorted by path with its sha256, exec bit and symlink targets", async () => {
		const root = bundle();

		try {
			const sha = (text: string) =>
				createHash("sha256").update(text).digest("hex");

			assert.deepEqual(await manifestLines(root), [
				"symlink tool bin/pi",
				`file 755 ${sha("#!/bin/sh\n")} bin/tool`,
				`file 644 ${sha("127.0.0.1 localhost\n")} etc/hosts`,
			]);
			assert.match((await manifestDigest(root)) ?? "", /^[0-9a-f]{64}$/);
		} finally {
			rmSync(root, { recursive: true, force: true });
		}
	});

	it("changes when content, mode or a link target changes, and is stable otherwise", async () => {
		const root = bundle();

		try {
			const first = await manifestDigest(root);

			assert.equal(await manifestDigest(root), first);
			writeFileSync(join(root, "etc", "hosts"), "127.0.0.1 localhost evil\n");

			const content = await manifestDigest(root);

			assert.notEqual(content, first);
			chmodSync(join(root, "etc", "hosts"), 0o755);

			const mode = await manifestDigest(root);

			assert.notEqual(mode, content);
			rmSync(join(root, "bin", "pi"));
			symlinkSync("/usr/bin/env", join(root, "bin", "pi"));
			assert.notEqual(await manifestDigest(root), mode);
		} finally {
			rmSync(root, { recursive: true, force: true });
		}
	});

	it("refuses a bundle holding a socket or other special file", async () => {
		const root = bundle();
		const server = createServer();

		try {
			await new Promise<void>((done) =>
				server.listen(join(root, "etc", "sock"), done),
			);
			assert.equal(await manifestDigest(root), null);
			assert.equal(await manifestDigest(join(root, "missing")), null);
		} finally {
			server.close();
			rmSync(root, { recursive: true, force: true });
		}
	});
});

describe("pinned asset inputs", () => {
	const manifest = objectOf(
		parseJson(readFileSync(join(ASSETS, "package.json"), "utf8")),
	);

	const lock = objectOf(
		parseJson(readFileSync(join(ASSETS, "package-lock.json"), "utf8")),
	);

	const packages = objectOf(fieldOf(lock, "packages"));

	it("pins npm Pi 1.4.0, pi-herdr-agents 3.3.1 and an explicit pi-herdr-pstack", () => {
		assert.deepEqual(fieldOf(manifest, "dependencies"), {
			"@earendil-works/pi-coding-agent": PINNED_VERSIONS.pi,
			"pi-herdr-agents": PINNED_VERSIONS.piHerdrAgents,
			"pi-herdr-pstack": PINNED_VERSIONS.piHerdrPstack,
		});
		assert.deepEqual(PINNED_VERSIONS, {
			pi: "1.4.0",
			piHerdrAgents: "3.3.1",
			piHerdrPstack: "0.5.0",
		});

		for (const [name, version] of [
			["@earendil-works/pi-coding-agent", "1.4.0"],
			["pi-herdr-agents", "3.3.1"],
			["pi-herdr-pstack", "0.5.0"],
		] as const) {
			assert.equal(
				textOf(
					fieldOf(
						objectOf(fieldOf(packages, `node_modules/${name}`)),
						"version",
					),
				),
				version,
				name,
			);
		}
	});

	it("locks every package with an sha512 integrity hash from registry.npmjs.org only", () => {
		assert.equal(fieldOf(lock, "lockfileVersion"), 3);
		assert.ok(packages);

		const entries = Object.entries(packages).filter(([path]) => path !== "");

		assert.ok(entries.length > 100);

		for (const [path, value] of entries) {
			const entry = objectOf(value);

			const integrity = textOf(fieldOf(entry, "integrity")) ?? "";
			const hash = integrity.slice("sha512-".length);

			assert.match(integrity, /^sha512-[A-Za-z0-9+/]{86}==$/, path);
			assert.equal(Buffer.from(hash, "base64").length, 64, path);
			assert.equal(Buffer.from(hash, "base64").toString("base64"), hash, path);
			assert.match(
				textOf(fieldOf(entry, "resolved")) ?? "",
				/^https:\/\/registry\.npmjs\.org\//,
				path,
			);
		}
	});
});

describe("asset lock integrity against downloaded bytes", () => {
	const nameOf = (path: string, entry: ReturnType<typeof objectOf>) =>
		textOf(fieldOf(entry, "name")) ??
		path.slice(path.lastIndexOf("node_modules/") + "node_modules/".length);

	function integrities(file: string): Map<string, string> {
		const packages = objectOf(
			fieldOf(objectOf(parseJson(readFileSync(file, "utf8"))), "packages"),
		);

		const found = new Map<string, string>();

		for (const [path, value] of Object.entries(packages ?? {})) {
			const entry = objectOf(value);
			const integrity = textOf(fieldOf(entry, "integrity"));
			const version = textOf(fieldOf(entry, "version"));

			if (path !== "" && integrity !== null && version !== null) {
				found.set(`${nameOf(path, entry)}@${version}`, integrity);
			}
		}

		return found;
	}

	it("agrees with the repository lock, which CI's npm ci checks against downloaded bytes, on every shared package", () => {
		const assets = integrities(join(ASSETS, "package-lock.json"));

		const root = integrities(
			new URL("../../package-lock.json", import.meta.url).pathname,
		);

		const shared = [...assets].filter(([key]) => root.has(key));

		assert.ok(shared.length > 100, String(shared.length));

		for (const [key, integrity] of shared) {
			assert.equal(integrity, root.get(key), key);
		}
	});

	it("makes the provisioning npm ci fail on a wrong but canonical sha512, offline", {
		timeout: 60_000,
	}, async () => {
		const dir = mkdtempSync(join(tmpdir(), "factory-npm-integrity-"));
		const pack = join(dir, "src", "package");

		mkdirSync(pack, { recursive: true });
		writeFileSync(
			join(pack, "package.json"),
			'{"name":"fixture-dep","version":"1.0.0"}\n',
		);
		writeFileSync(join(pack, "index.js"), "module.exports = 1;\n");

		const tar = spawnSync("tar", [
			"-czf",
			join(dir, "fixture-dep-1.0.0.tgz"),
			"-C",
			join(dir, "src"),
			"package",
		]);

		assert.equal(tar.status, 0);

		const tarball = readFileSync(join(dir, "fixture-dep-1.0.0.tgz"));

		const server = createHttpServer((_req, res) => {
			res.writeHead(200, { "Content-Type": "application/octet-stream" });
			res.end(tarball);
		});

		await new Promise<void>((done) => server.listen(0, "127.0.0.1", done));

		const address = server.address();

		const port =
			address !== null && address instanceof Object ? address.port : 0;

		const resolved = `http://127.0.0.1:${port}/fixture-dep/-/fixture-dep-1.0.0.tgz`;

		const ci = async (integrity: string, name: string) => {
			const app = join(dir, name);
			const manifest = { name: "app", version: "1.0.0" };
			const dependencies = { "fixture-dep": "1.0.0" };

			mkdirSync(app);
			writeFileSync(
				join(app, "package.json"),
				JSON.stringify({ ...manifest, dependencies }),
			);
			writeFileSync(
				join(app, "package-lock.json"),
				JSON.stringify({
					...manifest,
					lockfileVersion: 3,
					requires: true,
					packages: {
						"": { ...manifest, dependencies },
						"node_modules/fixture-dep": {
							version: "1.0.0",
							resolved,
							integrity,
						},
					},
				}),
			);

			const child = spawn(
				"npm",
				["ci", "--ignore-scripts", "--no-audit", "--no-fund"],
				{
					cwd: app,
					stdio: ["ignore", "ignore", "pipe"],
					env: {
						PATH: process.env.PATH ?? "/usr/bin:/bin",
						HOME: join(dir, "home"),
						npm_config_cache: join(dir, `cache-${name}`),
						npm_config_update_notifier: "false",
						npm_config_fetch_retries: "0",
					},
				},
			);

			let stderr = "";

			child.stderr.on("data", (chunk: Buffer) => {
				stderr += chunk.toString();
			});

			const code = await new Promise<number | null>((done) =>
				child.on("exit", (status) => done(status)),
			);

			return { code, stderr };
		};

		try {
			const wrong = `sha512-${Buffer.alloc(64).toString("base64")}`;

			const right = `sha512-${createHash("sha512").update(tarball).digest("base64")}`;

			assert.match(wrong, /^sha512-[A-Za-z0-9+/]{86}==$/);

			const refused = await ci(wrong, "wrong");

			assert.notEqual(refused.code, 0);
			assert.match(refused.stderr, /EINTEGRITY/);
			assert.equal((await ci(right, "right")).code, 0);
		} finally {
			server.close();
			rmSync(dir, { recursive: true, force: true });
		}
	});
});

describe("asset bundle install in server/provision.sh", () => {
	const script = readFileSync(
		new URL("../../server/provision.sh", import.meta.url),
		"utf8",
	);

	it("runs the bundle's npm ci with lifecycle scripts off, in a clean environment", () => {
		const lines = script.split("\n");
		const first = lines.findIndex((line) => line.includes('(cd "$b/pkg"'));

		const last = lines.findIndex(
			(line, index) => index >= first && line.endsWith(">/dev/null)"),
		);

		assert.ok(first !== -1 && last >= first);

		const dir = mkdtempSync(join(tmpdir(), "factory-provision-"));

		try {
			const bundle = join(dir, "bundle");
			const record = join(dir, "npm-call");

			mkdirSync(join(bundle, "pkg"), { recursive: true });
			mkdirSync(join(bundle, "node", "bin"), { recursive: true });
			writeFileSync(
				join(bundle, "node", "bin", "npm"),
				`#!/bin/sh\n{ printf '%s\\n' "$@"; printf 'cwd=%s\\n' "$PWD"; env | sort; } >${JSON.stringify(record)}\n`,
			);
			chmodSync(join(bundle, "node", "bin", "npm"), 0o755);

			const snippet = lines.slice(first, last + 1).join("\n");

			const run = spawnSync(
				"bash",
				["-c", `set -eu\nb=$1\nbuild=$2\n${snippet}`, "provision", bundle, dir],
				{ env: { PATH: "/usr/bin:/bin", SECRET_TOKEN: "must-not-leak" } },
			);

			assert.equal(run.status, 0, run.stderr.toString());

			const seen = readFileSync(record, "utf8").trim().split("\n");
			const cwd = seen.findIndex((line) => line.startsWith("cwd="));

			assert.deepEqual(seen.slice(0, cwd), [
				"ci",
				"--ignore-scripts",
				"--no-audit",
				"--no-fund",
			]);
			assert.equal(seen[cwd], `cwd=${join(bundle, "pkg")}`);
			assert.equal(
				seen.some((line) => line.includes("must-not-leak")),
				false,
			);
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});

	it("copies every committed skill into the bundle's skills directory", () => {
		const lines = script.split("\n");
		const first = lines.indexOf('for skill in "$repo"/skills/*/; do');
		const last = lines.indexOf("done", first);

		assert.ok(first !== -1 && last > first);

		const dir = mkdtempSync(join(tmpdir(), "factory-provision-skills-"));

		try {
			const bundle = join(dir, "bundle");
			const repo = new URL("../..", import.meta.url).pathname;

			mkdirSync(join(bundle, "skills"), { recursive: true });

			const run = spawnSync(
				"bash",
				[
					"-c",
					`set -eu\nb=$1\nrepo=$2\n${lines.slice(first, last + 1).join("\n")}`,
					"provision",
					bundle,
					repo,
				],
				{ env: { PATH: "/usr/bin:/bin" } },
			);

			assert.equal(run.status, 0, run.stderr.toString());

			for (const name of ["audit-ticket", "grill-me", "deep-research"]) {
				const copied = join(bundle, "skills", name, "SKILL.md");

				assert.equal(
					readFileSync(copied, "utf8"),
					readFileSync(join(repo, "skills", name, "SKILL.md"), "utf8"),
				);
				assert.equal(statSync(copied).mode & 0o777, 0o644);
			}

			assert.ok(existsSync(join(bundle, "skills", "grill-me", "LICENSE")));
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});

	it("passes --ignore-scripts to every npm install and ci it runs", () => {
		const calls = script
			.split("\n")
			.filter((line) => /\bnpm (ci|install|i)\b/.test(line));

		assert.ok(calls.length >= 2);

		for (const line of calls) assert.match(line, /--ignore-scripts\b/, line);
	});
});
