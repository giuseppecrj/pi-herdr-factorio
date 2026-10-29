import { execFile, spawn } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { connect, createServer, type Server } from "node:net";
import { join } from "node:path";

/**
 * The sandbox's first process. It serves `127.0.0.1:<port>` and relays each
 * connection to the gateway socket, starts a headless Herdr server when
 * asked, then runs the stage command with the sandbox's stdio. It ships in
 * the asset bundle and imports nothing but Node.
 */

export type StageInitArgs = {
	readonly port: number;
	readonly socket: string;
	readonly herdr: string | null;
	readonly command: readonly string[];
};

export const HERDR_SESSION = "factory";

const HERDR_READY_MS = 10_000;

const HERDR_STOP_MS = 3_000;

export function parseStageInitArgs(
	argv: readonly string[],
): StageInitArgs | null {
	const [portFlag, portText, socketFlag, socket, ...rest] = argv;
	const port = Number(portText);
	const herdr = rest[0] === "--herdr" ? (rest[1] ?? "") : null;
	const [separator, ...command] = herdr === null ? rest : rest.slice(2);

	if (
		portFlag !== "--port" ||
		socketFlag !== "--socket" ||
		separator !== "--" ||
		socket === undefined ||
		!socket.startsWith("/") ||
		(herdr !== null && !herdr.startsWith("/")) ||
		!/^[0-9]{1,5}$/.test(portText ?? "") ||
		port > 65535 ||
		command.length === 0
	) {
		return null;
	}

	return { port, socket, herdr, command };
}

/** Listens on loopback only. Every accepted connection gets its own socket connection. */
export async function startForwarder(
	port: number,
	socketPath: string,
): Promise<Server> {
	const server = createServer((client) => {
		const upstream = connect(socketPath);

		const close = () => {
			client.destroy();
			upstream.destroy();
		};

		client.on("error", close);
		upstream.on("error", close);
		client.on("close", close);
		upstream.on("close", close);
		client.pipe(upstream);
		upstream.pipe(client);
	});

	await new Promise<void>((done, fail) => {
		server.once("error", fail);
		server.listen(port, "127.0.0.1", () => {
			server.off("error", fail);
			done();
		});
	});

	return server;
}

/** The environment that lets `pi-herdr-agents` open child panes from the stage's root pane. */
export type HerdrEnv = {
	readonly HERDR_ENV: "1";
	readonly HERDR_SOCKET_PATH: string;
	readonly HERDR_PANE_ID: string;
	readonly HERDR_TAB_ID: string;
	readonly HERDR_WORKSPACE_ID: string;
};

/** Reads the root pane of `herdr workspace create` JSON output, or `null`. */
export function herdrEnvOf(
	stdout: string,
	socketPath: string,
): HerdrEnv | null {
	const ids = ["pane_id", "tab_id", "workspace_id"].map((key) =>
		idOf(stdout, key),
	);

	const [paneId, tabId, workspaceId] = ids;

	if (!paneId || !tabId || !workspaceId) return null;

	return {
		HERDR_ENV: "1",
		HERDR_SOCKET_PATH: socketPath,
		HERDR_PANE_ID: paneId,
		HERDR_TAB_ID: tabId,
		HERDR_WORKSPACE_ID: workspaceId,
	};
}

type Json =
	| string
	| number
	| boolean
	| null
	| readonly Json[]
	| { readonly [key: string]: Json };

function parsed(text: string): Json | undefined {
	try {
		const value: Json = JSON.parse(text);

		return value;
	} catch {
		return undefined;
	}
}

function field(value: Json | undefined, key: string): Json | undefined {
	if (
		value === undefined ||
		value === null ||
		Array.isArray(value) ||
		!(value instanceof Object)
	) {
		return undefined;
	}

	return Object.entries(value).find(([name]) => name === key)?.[1];
}

function idOf(stdout: string, key: string): string | null {
	const value = field(field(field(parsed(stdout), "result"), "root_pane"), key);
	const text = String(value);

	return value === text && /^[A-Za-z0-9:_-]{1,64}$/.test(text) ? text : null;
}

function run(
	file: string,
	args: readonly string[],
	timeout: number,
): Promise<string | null> {
	return new Promise((done) => {
		execFile(file, [...args], { timeout, encoding: "utf8" }, (error, out) =>
			done(error === null ? out : null),
		);
	});
}

function connects(path: string): Promise<boolean> {
	return new Promise((done) => {
		const socket = connect(path);

		socket.once("connect", () => {
			socket.destroy();
			done(true);
		});
		socket.once("error", () => done(false));
	});
}

type Herdr = { readonly env: HerdrEnv; stop(): Promise<void> };

/**
 * Starts `herdr --session factory server` with its output kept off the RPC
 * stdout, waits for its socket, and creates one workspace on `cwd`. Child
 * panes inherit this process's environment, so they find the same `pi`.
 */
async function startHerdr(bin: string, cwd: string): Promise<Herdr | null> {
	const config = join(process.env.XDG_CONFIG_HOME ?? "/tmp", "herdr");

	mkdirSync(config, { recursive: true, mode: 0o700 });
	writeFileSync(
		join(config, "config.toml"),
		'[terminal]\ndefault_shell = "/bin/bash"\nshell_mode = "non_login"\n',
	);

	const server = spawn(bin, ["--session", HERDR_SESSION, "server"], {
		stdio: "ignore",
	});

	const exited = new Promise<void>((done) => {
		server.on("exit", () => done());
		server.on("error", () => done());
	});

	const stop = async () => {
		await run(
			bin,
			["--session", HERDR_SESSION, "server", "stop"],
			HERDR_STOP_MS,
		);

		const timer = setTimeout(() => server.kill("SIGKILL"), HERDR_STOP_MS);

		await exited;
		clearTimeout(timer);
	};

	const socketPath = join(config, "sessions", HERDR_SESSION, "herdr.sock");
	const deadline = Date.now() + HERDR_READY_MS;

	while (!(await connects(socketPath))) {
		if (Date.now() > deadline || server.exitCode !== null) {
			await stop();

			return null;
		}

		await new Promise((done) => setTimeout(done, 100));
	}

	const created = await run(
		bin,
		[
			"--session",
			HERDR_SESSION,
			"workspace",
			"create",
			"--cwd",
			cwd,
			"--label",
			"stage",
			"--no-focus",
		],
		HERDR_READY_MS,
	);

	const env = created === null ? null : herdrEnvOf(created, socketPath);

	if (env === null) {
		await stop();

		return null;
	}

	return { env, stop };
}

async function main(): Promise<void> {
	const args = parseStageInitArgs(process.argv.slice(2));

	if (args === null) {
		process.stderr.write("factory stage-init: bad arguments\n");
		process.exitCode = 2;

		return;
	}

	const forwarder = await startForwarder(args.port, args.socket);

	const herdr =
		args.herdr === null ? null : await startHerdr(args.herdr, process.cwd());

	if (args.herdr !== null && herdr === null) {
		process.stderr.write("factory stage-init: herdr unavailable\n");
	}

	const [command, ...rest] = args.command;

	const child = spawn(command ?? "", rest, {
		stdio: "inherit",
		env: { ...process.env, ...herdr?.env },
	});

	for (const signal of ["SIGTERM", "SIGINT", "SIGHUP"] as const) {
		process.on(signal, () => child.kill(signal));
	}

	const finish = async (code: number) => {
		await herdr?.stop();
		forwarder.close();
		process.exitCode = code;
	};

	child.on("error", () => void finish(127));
	child.on("exit", (code, signal) => {
		void finish(code ?? (signal === null ? 1 : 128));
	});
}

if (import.meta.main) await main();
