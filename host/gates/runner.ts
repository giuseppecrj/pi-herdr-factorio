import { execFile } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import {
	cpSync,
	existsSync,
	mkdirSync,
	readFileSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { dirname, join } from "node:path";
import { digestOf } from "../../src/core/run.ts";
import {
	DEFAULT_SCOPE_LIMITS,
	scopeArgv,
	stopScopeArgv,
} from "../isolation/scope.ts";
import { type Dependency } from "./manifest.ts";

const GATE_IMAGE =
	"node@sha256:6d2c7d5d074bf72f81ddc252b4fbb5d625bc028eeda49cb4b8c2ff8eda1ee617";

export const CLEAN_ENV = {
	PATH: "/usr/local/bin:/usr/bin:/bin",
	HOME: "/tmp",
	TMPDIR: "/tmp",
	LANG: "C.UTF-8",
	CI: "true",
};

export type Result = {
	readonly timedOut?: boolean;
	readonly signal?: string | null;
	readonly runnerError?: boolean;
	readonly exitCode: number;
	readonly stdout: string;
	readonly stderr: string;
};

type RunInput = {
	readonly tree: string;
	readonly gates: string;
	readonly argv: readonly string[];
	readonly deadlineMs?: number;
	readonly install?: boolean;
	readonly cache?: string;
	readonly archives?: string;
	readonly dependencies?: string;
	readonly detailReporter?: string;
	readonly scope?: string;
	readonly signal?: AbortSignal;
};

export interface GateRunner {
	readonly kind: string;
	run(input: RunInput): Promise<Result>;
}

export function command(
	command: string,
	args: readonly string[],
	cwd: string,
	env: NodeJS.ProcessEnv = CLEAN_ENV,
	deadlineMs = 90000,
): Promise<Result> {
	return new Promise((done) => {
		execFile(
			command,
			[...args],
			{
				cwd,
				env,
				encoding: "utf8",
				timeout: deadlineMs,
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
					timedOut: error?.killed === true,
					signal: error?.signal ?? null,
					runnerError:
						error !== null &&
						!error.killed &&
						error.code !== undefined &&
						!Number.isSafeInteger(error.code),
					stdout,
					stderr,
				});
			},
		);
	});
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
				CLEAN_ENV,
				input.deadlineMs,
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

		if (input.dependencies)
			binds.push("--ro-bind", input.dependencies, "/w/node_modules");

		if (input.detailReporter)
			binds.push("--ro-bind", input.detailReporter, "/d");

		const args = [
			"--die-with-parent",
			"--new-session",
			"--unshare-all",
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
		];

		const argv = input.scope
			? scopeArgv(input.scope, DEFAULT_SCOPE_LIMITS, ["bwrap", ...args])
			: ["bwrap", ...args];

		const stop = async () => {
			if (input.scope) {
				const [cmd = "systemctl", ...rest] = stopScopeArgv(input.scope);
				await command(
					cmd,
					rest,
					input.tree,
					{
						PATH: "/usr/bin:/bin",
						XDG_RUNTIME_DIR: process.env.XDG_RUNTIME_DIR,
					},
					5000,
				);
			}
		};

		const abort = () => {
			void stop();
		};

		input.signal?.addEventListener("abort", abort, { once: true });

		try {
			if (input.signal?.aborted)
				return { exitCode: 1, stdout: "", stderr: "", timedOut: true };

			return await command(
				argv[0] ?? "bwrap",
				argv.slice(1),
				input.tree,
				{ ...CLEAN_ENV, XDG_RUNTIME_DIR: process.env.XDG_RUNTIME_DIR },
				input.deadlineMs,
			);
		} finally {
			input.signal?.removeEventListener("abort", abort);
			await stop();
		}
	},
};

export async function prefetch(
	deps: readonly Dependency[],
	archives: string,
	deadline = Date.now() + 180_000,
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
					signal: AbortSignal.timeout(
						Math.max(1, Math.min(30000, deadline - Date.now())),
					),
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

export async function install(
	tree: string,
	gates: string,
	archives: string,
	cache: string,
	runner: GateRunner,
	cacheReady = false,
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
			`${cacheReady ? "" : "npm cache add --offline --ignore-scripts --cache /cache /archives/*.tgz && "}npm ci --offline --ignore-scripts --cache /cache --no-audit --no-fund`,
		],
	});
}

export function testArgv(
	files: readonly string[],
	details = false,
	concurrency = 1,
): string[] {
	return [
		"node",
		"--import",
		"/g/freeze.mjs",
		"--experimental-strip-types",
		"--test",
		`--test-concurrency=${concurrency}`,
		"--test-timeout=60000",
		"--test-reporter",
		"/g/reporter.mjs",
		...(details
			? [
					"--test-reporter-destination",
					"stdout",
					"--test-reporter",
					"/d/draft-reporter.mjs",
					"--test-reporter-destination",
					"stderr",
				]
			: []),
		...files,
	];
}

const dependencyJobs = new Map<string, Promise<string>>();

export async function dependencyCache(
	source: string,
	gates: string,
	cacheDir: string,
	deps: readonly Dependency[],
	deadline: number,
	run: GateRunner,
	remaining: () => number,
): Promise<string | undefined> {
	if (deps.length === 0) return undefined;
	const lockDigest = digestOf(readFileSync(join(source, "package-lock.json")));
	const cache = join(cacheDir, lockDigest);
	let job = dependencyJobs.get(cache);

	if (job === undefined) {
		job = (async () => {
			if (existsSync(join(cache, "READY"))) {
				if (readFileSync(join(cache, "READY"), "utf8") !== lockDigest)
					throw new Error("invalid_dependency_cache");

				return join(cache, "tree/node_modules");
			}

			mkdirSync(cacheDir, { recursive: true, mode: 0o700 });
			rmSync(cache, { recursive: true, force: true });
			mkdirSync(cache, { mode: 0o700 });
			const tree = join(cache, "tree");
			mkdirSync(tree);

			for (const path of ["package.json", "package-lock.json"])
				cpSync(join(source, path), join(tree, path));
			const archives = join(cache, "archives");
			await prefetch(deps, archives, deadline);

			const installed = await install(
				tree,
				gates,
				archives,
				join(cache, "npm"),
				run,
			);

			if (
				installed.exitCode !== 0 ||
				installed.timedOut ||
				installed.runnerError
			)
				throw new Error("dependency_setup_failed");
			remaining();
			writeFileSync(join(cache, "READY"), lockDigest, {
				flag: "wx",
				mode: 0o600,
			});

			return join(tree, "node_modules");
		})();
		dependencyJobs.set(cache, job);
		void job.catch(() => dependencyJobs.delete(cache));
	}

	return job;
}
