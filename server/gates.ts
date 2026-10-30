import { execFile } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import {
	cpSync,
	existsSync,
	mkdirSync,
	mkdtempSync,
	readFileSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { parseArgs } from "node:util";
import { readStoredContract } from "../src/artifacts.ts";
import { isDigest } from "../src/run.ts";
import type { ReplacedTest } from "../src/specify.ts";
import { isGitSha } from "../src/workflow.ts";
import {
	arrayOf,
	countOf,
	fieldOf,
	objectOf,
	parseJson,
	textOf,
	textsOf,
	type JsonObject,
} from "./sandbox/json.ts";

export const GATE_IMAGE =
	"node@sha256:6d2c7d5d074bf72f81ddc252b4fbb5d625bc028eeda49cb4b8c2ff8eda1ee617";

const SOURCE = ["src", "extension", "server", "skills"];
const CHECK_NAMES = ["typecheck", "lint", "format"];
const SHA = /^[a-f0-9]{40}$/;
const CONFIG = new Set(["biome.json", "biome.jsonc", ".editorconfig"]);

const CLEAN_ENV = {
	PATH: "/usr/local/bin:/usr/bin:/bin",
	HOME: "/tmp",
	TMPDIR: "/tmp",
	LANG: "C.UTF-8",
	CI: "true",
};

type Result = {
	readonly exitCode: number;
	readonly stdout: string;
	readonly stderr: string;
};

type RunInput = {
	readonly tree: string;
	readonly gates: string;
	readonly argv: readonly string[];
	readonly install?: boolean;
	readonly cache?: string;
	readonly archives?: string;
};

export interface GateRunner {
	readonly kind: string;
	run(input: RunInput): Promise<Result>;
}

export type GateCheck = {
	readonly name: string;
	readonly exitCode: number;
	readonly durationMs: number;
};

export type GateReceipt = {
	readonly version: 1;
	readonly gateSha: string;
	readonly candidateSha: string;
	readonly nonce: string;
	readonly runner: string;
	status: "passed" | "failed" | "incomplete";
	reason: string | null;
	readonly checks: GateCheck[];
	ignoredChanges: readonly string[];
	replacedTests: readonly ReplacedTest[];
	replacementsDigest: string;
	dependencies: { added: string[]; removed: string[]; changed: string[] };
	newDependency: boolean;
	installScripts: readonly string[];
	baselineCounts: Readonly<Record<string, number>>;
	candidateCounts: Readonly<Record<string, number>>;
	wallMs: number;
	readonly modelCalls: 0;
};

type Dependency = {
	readonly path: string;
	readonly version: string;
	readonly resolved: string;
	readonly integrity: string;
	readonly installScript: boolean;
};

type GateManifest = {
	readonly checks: readonly { name: string; argv: readonly string[] }[];
	readonly tests: readonly string[];
};

export type CandidateInput = {
	readonly repository: string;
	readonly gateSha: string;
	readonly candidateSha: string;
	readonly nonce: string;
	readonly output: string;
	readonly runner: GateRunner;
	readonly install?: boolean;
	readonly replacements?: readonly ReplacedTest[];
	readonly replacementsDigest?: string;
};

function command(
	command: string,
	args: readonly string[],
	cwd: string,
	env: NodeJS.ProcessEnv = CLEAN_ENV,
): Promise<Result> {
	return new Promise((done) => {
		execFile(
			command,
			[...args],
			{
				cwd,
				env,
				encoding: "utf8",
				timeout: 570000,
				maxBuffer: 32 * 1024 * 1024,
				killSignal: "SIGKILL",
			},
			(error, stdout, stderr) => {
				done({
					exitCode:
						error === null
							? 0
							: Number.isSafeInteger(error.code)
								? Number(error.code) || 1
								: 1,
					stdout,
					stderr,
				});
			},
		);
	});
}

async function git(
	repository: string,
	args: readonly string[],
): Promise<string> {
	const result = await command(
		"git",
		["-C", resolve(repository), ...args],
		repository,
	);

	if (result.exitCode !== 0) throw new Error("git_failed");

	return result.stdout;
}

function safePath(path: string): boolean {
	return (
		path.length > 0 &&
		path.length < 512 &&
		!/[\x00-\x1f\x7f\\:]/.test(path) &&
		path
			.split("/")
			.every(
				(p) =>
					p !== "" &&
					p !== "." &&
					p !== ".." &&
					p !== ".git" &&
					p !== "node_modules",
			)
	);
}

async function entries(
	repository: string,
	sha: string,
): Promise<Map<string, { mode: string; blob: string }>> {
	if (!SHA.test(sha)) throw new Error("invalid_sha");
	const entries = new Map<string, { mode: string; blob: string }>();

	for (const row of (
		await git(repository, ["ls-tree", "-rz", "--full-tree", sha])
	).split("\0")) {
		if (!row) continue;
		const match = /^(100644|100755) blob ([a-f0-9]{40})\t(.+)$/.exec(row);

		if (match === null || !safePath(match[3] ?? ""))
			throw new Error("unsafe_tree");
		entries.set(match[3] ?? "", { mode: match[1] ?? "", blob: match[2] ?? "" });
	}

	if (entries.size > 10000) throw new Error("tree_too_large");

	return entries;
}

async function exportTree(
	repository: string,
	sha: string,
	dest: string,
): Promise<void> {
	await entries(repository, sha);
	mkdirSync(dest, { recursive: true, mode: 0o755 });
	const tar = join(dirname(dest), `${randomBytes(6).toString("hex")}.tar`);

	try {
		await git(repository, ["archive", "--format=tar", `--output=${tar}`, sha]);

		const extracted = await command(
			"tar",
			["-xf", tar, "--no-same-owner", "-C", dest],
			repository,
		);

		if (extracted.exitCode !== 0) throw new Error("unsafe_tree");
	} finally {
		rmSync(tar, { force: true });
	}
}

export function replacementDigest(
	replacements: readonly ReplacedTest[],
): string {
	return createHash("sha256")
		.update(JSON.stringify(replacements))
		.digest("hex");
}

function replacementsOf(text: string): readonly ReplacedTest[] {
	const list = arrayOf(parseJson(text));

	if (list === null || list.length > 50)
		throw new Error("invalid_replacements");
	const seen = new Set<string>();

	return list.map((item) => {
		const obj = objectOf(item);
		const path = textOf(fieldOf(obj, "path")) ?? "";
		const reason = textOf(fieldOf(obj, "reason")) ?? "";

		if (
			obj === null ||
			Object.keys(obj).some((k) => k !== "path" && k !== "reason") ||
			!safePath(path) ||
			!path.startsWith("test/") ||
			path.startsWith("test/acceptance/") ||
			!/\.(?:test|cases)\.[cm]?[jt]s$/.test(path) ||
			!reason.trim() ||
			reason.length > 500 ||
			/[\r\n\x00-\x1f]/.test(reason) ||
			seen.has(path)
		)
			throw new Error("invalid_replacements");
		seen.add(path);

		return { path, reason };
	});
}

export async function materializeCandidate(input: {
	readonly repository: string;
	readonly gateSha: string;
	readonly candidateSha: string;
	readonly dest: string;
	readonly replacements: readonly ReplacedTest[];
}) {
	const base = await entries(input.repository, input.gateSha);
	const candidate = await entries(input.repository, input.candidateSha);
	const replacements = replacementsOf(JSON.stringify(input.replacements));

	for (const item of replacements)
		if (!base.has(item.path)) throw new Error("invalid_replacements");
	await exportTree(input.repository, input.gateSha, input.dest);
	const temp = mkdtempSync(join(dirname(input.dest), "candidate-"));
	const ignoredChanges: string[] = [];
	const newTests: string[] = [];

	try {
		await exportTree(input.repository, input.candidateSha, join(temp, "tree"));

		for (const dir of SOURCE) {
			rmSync(join(input.dest, dir), { recursive: true, force: true });

			if (existsSync(join(temp, "tree", dir)))
				cpSync(join(temp, "tree", dir), join(input.dest, dir), {
					recursive: true,
				});
		}

		for (const [path, item] of candidate) {
			const fromSource = SOURCE.some((dir) => path.startsWith(`${dir}/`));
			const replacement = replacements.some((r) => r.path === path);
			const additional = path.startsWith("test/") && !base.has(path);

			if (
				path.split("/").at(-1) === ".npmrc" &&
				item.blob !== base.get(path)?.blob
			)
				throw new Error("npmrc_changed");

			if (additional || replacement) {
				mkdirSync(dirname(join(input.dest, path)), { recursive: true });
				cpSync(join(temp, "tree", path), join(input.dest, path));

				if (
					additional &&
					/\.test\.[cm]?[jt]s$/.test(path) &&
					!path.startsWith("test/acceptance/")
				)
					newTests.push(path);
			}

			if (
				(fromSource || additional) &&
				CONFIG.has(path.split("/").at(-1) ?? "")
			) {
				rmSync(join(input.dest, path), { force: true });
				ignoredChanges.push(path);
			} else if (
				!fromSource &&
				!additional &&
				!replacement &&
				item.blob !== base.get(path)?.blob &&
				path !== "package-lock.json" &&
				path !== "package.json"
			)
				ignoredChanges.push(path);
		}

		for (const path of base.keys())
			if (path.split("/").at(-1) === ".npmrc" && !candidate.has(path))
				throw new Error("npmrc_changed");

		for (const item of replacements)
			if (!candidate.has(item.path))
				rmSync(join(input.dest, item.path), { force: true });
	} finally {
		rmSync(temp, { recursive: true, force: true });
	}

	return { ignoredChanges: ignoredChanges.sort(), newTests: newTests.sort() };
}

function specs(value: JsonObject | null): void {
	if (value === null) throw new Error("invalid_dependency_manifest");

	for (const group of [
		"dependencies",
		"devDependencies",
		"optionalDependencies",
		"peerDependencies",
	]) {
		const item = fieldOf(value, group);

		if (item === undefined) continue;
		const deps = objectOf(item);

		if (deps === null) throw new Error("invalid_dependency_manifest");

		for (const [name, version] of Object.entries(deps)) {
			const spec = textOf(version) ?? "";

			if (
				!/^(?:@[a-z0-9._-]+\/)?[a-z0-9._-]+$/i.test(name) ||
				!/^[a-z0-9*^~<>=| .+-]+$/i.test(spec) ||
				!spec ||
				/^(?:git|file|workspace|https?|npm):/i.test(spec)
			)
				throw new Error("invalid_dependency_spec");
		}
	}
}

export function validateDependencies(
	manifestText: string,
	lockText: string,
): readonly Dependency[] {
	const manifest = objectOf(parseJson(manifestText));
	const lock = objectOf(parseJson(lockText));
	const packages = objectOf(fieldOf(lock, "packages"));
	specs(manifest);

	if (
		fieldOf(lock, "lockfileVersion") !== 3 ||
		packages === null ||
		Object.keys(packages).length > 2000
	)
		throw new Error("invalid_dependency_lock");
	specs(objectOf(fieldOf(packages, "")));
	const result: Dependency[] = [];

	for (const [path, item] of Object.entries(packages)) {
		if (!path) continue;
		const value = objectOf(item);
		const resolved = textOf(fieldOf(value, "resolved")) ?? "";
		const version = textOf(fieldOf(value, "version")) ?? "";
		const integrity = textOf(fieldOf(value, "integrity")) ?? "";
		let url: URL;

		try {
			url = new URL(resolved);
		} catch {
			throw new Error("invalid_dependency_url");
		}

		if (
			!/^(?:node_modules\/(?:@[a-z0-9._-]+\/)?[a-z0-9._-]+\/)*node_modules\/(?:@[a-z0-9._-]+\/)?[a-z0-9._-]+$/i.test(
				path,
			) ||
			url.protocol !== "https:" ||
			url.hostname !== "registry.npmjs.org" ||
			url.port ||
			url.username ||
			url.password ||
			url.search ||
			url.hash ||
			!url.pathname.endsWith(".tgz") ||
			!/^sha512-[A-Za-z0-9+/]{86}==$/.test(integrity) ||
			!version ||
			fieldOf(value, "link") === true
		)
			throw new Error("invalid_dependency_lock");
		specs(value);
		result.push({
			path,
			version,
			resolved,
			integrity,
			installScript: fieldOf(value, "hasInstallScript") === true,
		});
	}

	return result;
}

function readDependencies(tree: string) {
	return validateDependencies(
		readFileSync(join(tree, "package.json"), "utf8"),
		readFileSync(join(tree, "package-lock.json"), "utf8"),
	);
}

function manifestOf(tree: string): GateManifest {
	const value = objectOf(
		parseJson(
			readFileSync(join(tree, ".github/factory/gates/gates.json"), "utf8"),
		),
	);

	const rawChecks = arrayOf(fieldOf(value, "checks"));
	const tests = textsOf(fieldOf(value, "tests"));

	if (
		fieldOf(value, "version") !== 1 ||
		rawChecks === null ||
		tests === null ||
		tests.length === 0 ||
		tests.some(
			(p) =>
				!safePath(p) ||
				!p.startsWith("test/") ||
				!/\.test\.[cm]?[jt]s$/.test(p) ||
				!existsSync(join(tree, p)),
		)
	)
		throw new Error("invalid_gate_manifest");

	const checks = rawChecks.map((item) => {
		const obj = objectOf(item);
		const name = textOf(fieldOf(obj, "name")) ?? "";
		const argv = textsOf(fieldOf(obj, "argv"));

		if (
			!CHECK_NAMES.includes(name) ||
			argv === null ||
			argv.length === 0 ||
			argv.some((a) => a.includes("\0"))
		)
			throw new Error("invalid_gate_manifest");

		return { name, argv };
	});

	if (
		checks.length !== CHECK_NAMES.length ||
		new Set(checks.map((c) => c.name)).size !== CHECK_NAMES.length
	)
		throw new Error("missing_checks");

	return { checks, tests };
}

export const dockerRunner: GateRunner = {
	kind: "docker",
	async run(input) {
		const mounts = [
			"--mount",
			`type=bind,src=${input.tree},dst=/w${input.install ? "" : ",readonly"}`,
			"--mount",
			`type=bind,src=${input.gates},dst=/g,readonly`,
		];

		if (input.cache)
			mounts.push("--mount", `type=bind,src=${input.cache},dst=/cache`);

		if (input.archives)
			mounts.push(
				"--mount",
				`type=bind,src=${input.archives},dst=/archives,readonly`,
			);
		const id = `factory-gate-${randomBytes(8).toString("hex")}`;

		try {
			return await command(
				"docker",
				[
					"run",
					"--rm",
					"--name",
					id,
					"--network",
					"none",
					"--read-only",
					"--tmpfs",
					"/tmp:exec,size=1g",
					"--user",
					"1001",
					"--cap-drop",
					"ALL",
					"--security-opt",
					"no-new-privileges",
					"--pids-limit",
					"512",
					"--memory",
					"4g",
					...mounts,
					"--workdir",
					"/w",
					GATE_IMAGE,
					"env",
					"-i",
					...Object.entries(CLEAN_ENV).map(([k, v]) => `${k}=${v}`),
					...input.argv,
				],
				input.tree,
			);
		} finally {
			await command("docker", ["rm", "-f", id], input.tree);
		}
	},
};

export const localRunner: GateRunner = {
	kind: "local-bwrap",
	async run(input) {
		const binds = [
			"--ro-bind",
			input.tree,
			"/w",
			"--ro-bind",
			input.gates,
			"/g",
		];

		if (input.install) binds.push("--bind", input.tree, "/w");

		if (input.cache) binds.push("--bind", input.cache, "/cache");

		if (input.archives) binds.push("--ro-bind", input.archives, "/archives");

		return command(
			"bwrap",
			[
				"--die-with-parent",
				"--unshare-net",
				"--unshare-pid",
				"--ro-bind",
				"/usr",
				"/usr",
				"--symlink",
				"usr/bin",
				"/bin",
				"--symlink",
				"usr/lib",
				"/lib",
				"--symlink",
				"usr/lib64",
				"/lib64",
				"--ro-bind",
				dirname(dirname(process.execPath)),
				dirname(dirname(process.execPath)),
				...["/etc/passwd", "/etc/group", "/etc/ld.so.cache"].flatMap((path) =>
					existsSync(path) ? ["--ro-bind", path, path] : [],
				),
				"--tmpfs",
				"/tmp",
				"--dev",
				"/dev",
				"--proc",
				"/proc",
				...binds,
				"--chdir",
				"/w",
				"--clearenv",
				...Object.entries({
					...CLEAN_ENV,
					PATH: `${dirname(process.execPath)}:/usr/bin:/bin`,
				}).flatMap(([k, v]) => ["--setenv", k, v]),
				...input.argv,
			],
			input.tree,
		);
	},
};

async function prefetch(
	deps: readonly Dependency[],
	archives: string,
): Promise<void> {
	mkdirSync(archives, { recursive: true });
	const unique = [...new Map(deps.map((d) => [d.integrity, d])).values()];
	let index = 0;
	await Promise.all(
		Array.from({ length: 8 }, async () => {
			for (;;) {
				const dep = unique[index++];

				if (dep === undefined) return true;

				const path = join(
					archives,
					`${createHash("sha256").update(dep.integrity).digest("hex")}.tgz`,
				);

				if (existsSync(path)) continue;
				let url: URL;

				try {
					url = new URL(dep.resolved);
				} catch {
					throw new Error("invalid_dependency_url");
				}

				if (
					url.origin !== "https://registry.npmjs.org" ||
					url.username ||
					url.password
				)
					throw new Error("invalid_dependency_url");

				const response = await fetch(url, {
					redirect: "error",
					signal: AbortSignal.timeout(30000),
				});

				if (!response.ok) throw new Error("dependency_fetch_failed");
				const data = Buffer.from(await response.arrayBuffer());

				if (
					data.length > 64 * 1024 * 1024 ||
					`sha512-${createHash("sha512").update(data).digest("base64")}` !==
						dep.integrity
				)
					throw new Error("dependency_integrity");
				writeFileSync(path, data, { mode: 0o644 });
			}
		}),
	);
}

async function install(
	tree: string,
	gates: string,
	archives: string,
	cache: string,
	runner: GateRunner,
): Promise<Result> {
	mkdirSync(cache, { recursive: true, mode: 0o777 });

	return runner.run({
		tree,
		gates,
		archives,
		cache,
		install: true,
		argv: [
			"/bin/sh",
			"-c",
			"npm cache add --offline --ignore-scripts --cache /cache /archives/*.tgz && npm ci --offline --ignore-scripts --cache /cache --no-audit --no-fund",
		],
	});
}

function testArgv(files: readonly string[]): string[] {
	return [
		"node",
		"--import",
		"/g/freeze.mjs",
		"--experimental-strip-types",
		"--test",
		"--test-concurrency=1",
		"--test-reporter",
		"/g/reporter.mjs",
		...files,
	];
}

function countsOf(result: Result): Readonly<Record<string, number>> | null {
	const value = objectOf(parseJson(result.stdout.trim()));
	const counts = objectOf(fieldOf(value, "counts"));

	if (
		result.exitCode !== 0 ||
		fieldOf(value, "complete") !== true ||
		fieldOf(value, "bad") !== false ||
		counts === null ||
		Object.keys(counts).length === 0
	)
		return null;
	const found: Record<string, number> = {};

	for (const [path, count] of Object.entries(counts)) {
		const number = countOf(count);

		if (!safePath(path) || number === null || number === 0) return null;
		found[path] = number;
	}

	return found;
}

function sameCounts(
	base: Readonly<Record<string, number>>,
	candidate: Readonly<Record<string, number>>,
	replacements: readonly ReplacedTest[],
): boolean {
	const except = new Set(replacements.map((r) => r.path));

	for (const path of new Set([...Object.keys(base), ...Object.keys(candidate)]))
		if (!except.has(path) && base[path] !== candidate[path]) return false;

	return true;
}

export async function checkCandidate(
	input: CandidateInput,
): Promise<GateReceipt> {
	const start = Date.now();

	const receipt: GateReceipt = {
		version: 1,
		gateSha: input.gateSha,
		candidateSha: input.candidateSha,
		nonce: input.nonce,
		runner: input.runner.kind,
		status: "incomplete",
		reason: null,
		checks: [],
		ignoredChanges: [],
		replacedTests: [],
		replacementsDigest: replacementDigest([]),
		dependencies: { added: [], removed: [], changed: [] },
		newDependency: false,
		installScripts: [],
		baselineCounts: {},
		candidateCounts: {},
		wallMs: 0,
		modelCalls: 0,
	};

	mkdirSync(input.output, { recursive: true, mode: 0o755 });
	const temp = mkdtempSync(join(tmpdir(), "factory-gate-"));

	const baseline = join(temp, "baseline"),
		tree = join(temp, "tree"),
		gates = join(temp, "gates");

	const run = async (name: string, source: string, argv: readonly string[]) => {
		const began = Date.now();
		const result = await input.runner.run({ tree: source, gates, argv });
		writeFileSync(
			join(input.output, `${name}.log`),
			result.stdout + result.stderr,
		);

		const check = {
			name,
			exitCode: result.exitCode,
			durationMs: Date.now() - began,
		};

		receipt.checks.push(check);

		return { result, check };
	};

	try {
		if (
			!SHA.test(input.gateSha) ||
			!SHA.test(input.candidateSha) ||
			!/^[a-zA-Z0-9_-]{1,100}$/.test(input.nonce)
		)
			throw new Error("invalid_input");

		const ancestor = await command(
			"git",
			[
				"-C",
				resolve(input.repository),
				"merge-base",
				"--is-ancestor",
				input.gateSha,
				input.candidateSha,
			],
			input.repository,
		);

		if (ancestor.exitCode !== 0) throw new Error("stale_base");

		const replacements = replacementsOf(
			JSON.stringify(input.replacements ?? []),
		);

		const digest = replacementDigest(replacements);

		if ((input.replacementsDigest ?? replacementDigest([])) !== digest)
			throw new Error("replacement_digest_mismatch");
		receipt.replacedTests = replacements;
		receipt.replacementsDigest = digest;
		await exportTree(input.repository, input.gateSha, baseline);
		const manifest = manifestOf(baseline);

		const material = await materializeCandidate({
			...input,
			dest: tree,
			replacements,
		});

		receipt.ignoredChanges = material.ignoredChanges;
		mkdirSync(gates, { mode: 0o755 });
		cpSync(join(baseline, ".github/factory/gates"), gates, { recursive: true });
		cpSync(baseline, join(gates, "tooling"), { recursive: true });

		const lint =
			objectOf(
				parseJson(readFileSync(join(baseline, ".oxlintrc.json"), "utf8")),
			) ?? {};

		const plugins = arrayOf(fieldOf(lint, "jsPlugins")) ?? [];
		writeFileSync(
			join(gates, "lint.json"),
			JSON.stringify({
				...lint,
				jsPlugins: plugins.map((p) => {
					const obj = objectOf(p);
					const spec = textOf(fieldOf(obj, "specifier")) ?? "";

					return {
						...obj,
						specifier: spec.startsWith("./")
							? `/g/tooling/${spec.slice(2)}`
							: spec,
					};
				}),
			}),
		);
		const baseDeps = readDependencies(baseline);

		for (const name of ["package.json", "package-lock.json"])
			writeFileSync(
				join(temp, `candidate-${name}`),
				await git(input.repository, ["show", `${input.candidateSha}:${name}`]),
			);

		const manifestText = readFileSync(
				join(temp, "candidate-package.json"),
				"utf8",
			),
			lockText = readFileSync(
				join(temp, "candidate-package-lock.json"),
				"utf8",
			);

		const deps = validateDependencies(manifestText, lockText);

		const old = new Map(baseDeps.map((d) => [d.path, d])),
			current = new Map(deps.map((d) => [d.path, d]));

		receipt.dependencies = {
			added: deps.filter((d) => !old.has(d.path)).map((d) => d.path),
			removed: baseDeps.filter((d) => !current.has(d.path)).map((d) => d.path),
			changed: deps
				.filter((d) => {
					const prev = old.get(d.path);

					return (
						prev !== undefined &&
						(prev.integrity !== d.integrity || prev.version !== d.version)
					);
				})
				.map((d) => d.path),
		};
		receipt.newDependency = receipt.dependencies.added.length > 0;
		receipt.installScripts = [
			...new Set(
				[...baseDeps, ...deps].flatMap((d) =>
					d.installScript ? [`${d.path}@${d.version}`] : [],
				),
			),
		].sort();

		if (input.install !== false) {
			const archives = join(temp, "archives"),
				cache = join(temp, "cache");

			const began = Date.now();
			await prefetch([...baseDeps, ...deps], archives);
			let result: Result;

			if (baseDeps.length === 0 && deps.length === 0) {
				mkdirSync(join(baseline, "node_modules"));
				result = { exitCode: 0, stdout: "No packages\n", stderr: "" };
			} else
				result = await install(baseline, gates, archives, cache, input.runner);

			if (result.exitCode === 0)
				cpSync(
					join(baseline, "node_modules"),
					join(gates, "tooling/node_modules"),
					{ recursive: true, verbatimSymlinks: true },
				);

			if (
				result.exitCode === 0 &&
				lockText === readFileSync(join(baseline, "package-lock.json"), "utf8")
			)
				cpSync(join(baseline, "node_modules"), join(tree, "node_modules"), {
					recursive: true,
					verbatimSymlinks: true,
				});
			else if (result.exitCode === 0) {
				const installTree = join(temp, "install");
				mkdirSync(installTree);
				writeFileSync(join(installTree, "package.json"), manifestText);
				writeFileSync(join(installTree, "package-lock.json"), lockText);
				result = await install(
					installTree,
					gates,
					archives,
					cache,
					input.runner,
				);

				if (result.exitCode === 0)
					cpSync(
						join(installTree, "node_modules"),
						join(tree, "node_modules"),
						{ recursive: true, verbatimSymlinks: true },
					);
			}

			receipt.checks.push({
				name: "install",
				exitCode: result.exitCode,
				durationMs: Date.now() - began,
			});
			writeFileSync(
				join(input.output, "install.log"),
				result.stdout + result.stderr,
			);

			if (result.exitCode !== 0) throw new Error("install_failed");
		}

		const baselineRun = await run(
			"baseline_tests",
			baseline,
			testArgv(manifest.tests),
		);

		const baseCounts = countsOf(baselineRun.result);

		if (baseCounts === null) {
			baselineRun.check.exitCode = 1;
			throw new Error("baseline_failed");
		}

		receipt.baselineCounts = baseCounts;

		for (const check of manifest.checks)
			await run(check.name, tree, check.argv);
		const mainTests = manifest.tests.filter((p) => existsSync(join(tree, p)));

		if (mainTests.length === 0) throw new Error("missing_tests");
		const candidateRun = await run("main_tests", tree, testArgv(mainTests));
		const candidateCounts = countsOf(candidateRun.result);
		receipt.candidateCounts = candidateCounts ?? {};

		if (
			candidateCounts === null ||
			!sameCounts(baseCounts, candidateCounts, replacements)
		)
			candidateRun.check.exitCode = 1;

		if (material.newTests.length > 0) {
			const extra = await run(
				"candidate_tests",
				tree,
				testArgv(material.newTests),
			);

			if (countsOf(extra.result) === null) extra.check.exitCode = 1;
		} else
			receipt.checks.push({
				name: "candidate_tests",
				exitCode: 0,
				durationMs: 0,
			});
		receipt.status = receipt.checks.every((c) => c.exitCode === 0)
			? "passed"
			: "failed";
	} catch (error) {
		receipt.reason = error instanceof Error ? error.message : "gate_error";
		receipt.status = "incomplete";
	} finally {
		receipt.wallMs = Date.now() - start;
		writeFileSync(
			join(input.output, "receipt.json"),
			`${JSON.stringify(receipt, null, 2)}\n`,
		);
		rmSync(temp, { recursive: true, force: true });
	}

	return receipt;
}

export async function runGatesCli(
	argv: readonly string[],
	io: { stdout(text: string): void; stderr(text: string): void },
): Promise<number> {
	try {
		const { values, positionals } = parseArgs({
			args: [...argv],
			strict: true,
			options: {
				repository: { type: "string" },
				"gate-sha": { type: "string" },
				"candidate-sha": { type: "string" },
				nonce: { type: "string" },
				output: { type: "string" },
				runner: { type: "string" },
				replacements: { type: "string" },
				"replacements-digest": { type: "string" },
				"state-dir": { type: "string" },
				"run-id": { type: "string" },
				"contract-digest": { type: "string" },
			},
		});

		if (
			positionals.length ||
			!values.repository ||
			!values["gate-sha"] ||
			!values["candidate-sha"] ||
			!values.nonce ||
			!values.output ||
			!isGitSha(values["gate-sha"]) ||
			!isGitSha(values["candidate-sha"])
		)
			throw new Error(
				"gates requires --repository, --gate-sha, --candidate-sha, --nonce and --output",
			);

		let replacements = replacementsOf(values.replacements ?? "[]"),
			digest = values["replacements-digest"];

		if (values["state-dir"] || values["run-id"] || values["contract-digest"]) {
			const runId = values["run-id"] ?? "",
				contractDigest = values["contract-digest"] ?? "";

			if (
				!values["state-dir"] ||
				!isDigest(runId) ||
				!isDigest(contractDigest) ||
				values.replacements ||
				digest
			)
				throw new Error("invalid_private_contract_input");
			const stored = readStoredContract(values["state-dir"], runId);

			if (stored.kind !== "found" || stored.digest !== contractDigest)
				throw new Error("private_contract_unavailable");
			replacements = stored.contract.replacesTests ?? [];
			digest = replacementDigest(replacements);
		}

		if (
			values.runner !== undefined &&
			values.runner !== "docker" &&
			values.runner !== "local"
		)
			throw new Error("invalid_runner");

		const receipt = await checkCandidate({
			repository: resolve(values.repository),
			gateSha: values["gate-sha"],
			candidateSha: values["candidate-sha"],
			nonce: values.nonce,
			output: resolve(values.output),
			runner: values.runner === "local" ? localRunner : dockerRunner,
			replacements,
			replacementsDigest: digest,
		});

		io.stdout(`${JSON.stringify(receipt, null, 2)}\n`);

		return receipt.status === "passed" ? 0 : 1;
	} catch (error) {
		io.stderr(
			`${error instanceof Error ? error.message : "invalid_gates_input"}\n`,
		);

		return 2;
	}
}
