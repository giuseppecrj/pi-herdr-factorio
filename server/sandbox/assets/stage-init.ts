import { spawn } from "node:child_process";
import { connect, createServer, type Server } from "node:net";

/**
 * The sandbox's first process. It serves `127.0.0.1:<port>` and relays each
 * connection to the gateway socket, then runs the stage command with the
 * sandbox's stdio. It ships in the asset bundle and imports nothing but Node.
 */

export type StageInitArgs = {
	readonly port: number;
	readonly socket: string;
	readonly command: readonly string[];
};

export function parseStageInitArgs(
	argv: readonly string[],
): StageInitArgs | null {
	const [portFlag, portText, socketFlag, socket, separator, ...command] = argv;
	const port = Number(portText);

	if (
		portFlag !== "--port" ||
		socketFlag !== "--socket" ||
		separator !== "--" ||
		socket === undefined ||
		!socket.startsWith("/") ||
		!/^[0-9]{1,5}$/.test(portText ?? "") ||
		port > 65535 ||
		command.length === 0
	) {
		return null;
	}

	return { port, socket, command };
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

async function main(): Promise<void> {
	const args = parseStageInitArgs(process.argv.slice(2));

	if (args === null) {
		process.stderr.write("factory stage-init: bad arguments\n");
		process.exitCode = 2;

		return;
	}

	const forwarder = await startForwarder(args.port, args.socket);
	const [command, ...rest] = args.command;
	const child = spawn(command ?? "", rest, { stdio: "inherit" });

	for (const signal of ["SIGTERM", "SIGINT", "SIGHUP"] as const) {
		process.on(signal, () => child.kill(signal));
	}

	child.on("error", () => {
		forwarder.close();
		process.exitCode = 127;
	});
	child.on("exit", (code, signal) => {
		forwarder.close();
		process.exitCode = code ?? (signal === null ? 1 : 128);
	});
}

if (import.meta.main) await main();
