import { openAuditFile, AUDIT_CAP_BYTES } from "./audit.ts";
import {
	type ControlEvent,
	encodeEvent,
	type FatalCode,
	parseCommand,
} from "./control.ts";
import {
	bindCredentials,
	CEILINGS_PATH,
	credentialIdsOf,
	loadCeilings,
	loadSecrets,
} from "./credentials.ts";
import { Gateway } from "./gateway.ts";
import { parseJson } from "./json.ts";
import { LineSplitter } from "./lines.ts";
import { parseRouteTable, type TableMode } from "./routes.ts";

export type GatewayArgs = {
	readonly socket: string;
	readonly audit: string;
	readonly ceilings: string;
	readonly mode: TableMode;
};

/** Reads the gateway's argv. Unknown or repeated flags refuse the whole command line. */
export function parseGatewayArgs(argv: readonly string[]): GatewayArgs | null {
	const values = new Map<string, string>();
	let mode: TableMode = "production";

	for (let index = 0; index < argv.length; index += 1) {
		const flag = argv[index];

		if (flag === "--test-mode") {
			mode = "test";
			continue;
		}

		const value = argv[index + 1];

		if (
			(flag !== "--socket" && flag !== "--audit" && flag !== "--ceilings") ||
			value === undefined ||
			values.has(flag)
		) {
			return null;
		}

		values.set(flag, value);
		index += 1;
	}

	const socket = values.get("--socket");
	const audit = values.get("--audit");

	if (socket === undefined || audit === undefined) return null;

	return {
		socket,
		audit,
		ceilings: values.get("--ceilings") ?? CEILINGS_PATH,
		mode,
	};
}

function emit(event: ControlEvent): void {
	process.stdout.write(encodeEvent(event));
}

function fatal(code: FatalCode): void {
	emit({ event: "fatal", code });
	process.exitCode = 2;
	process.stdin.destroy();
}

async function start(
	args: GatewayArgs,
	tableLine: string,
): Promise<Gateway | null> {
	const parsed = parseRouteTable(parseJson(tableLine), args.mode);

	if (!parsed.ok) {
		fatal("bad-table");

		return null;
	}

	const ids = credentialIdsOf(parsed.table);

	const ceilings =
		ids.length === 0
			? { ok: true as const, ceilings: new Map() }
			: loadCeilings(args.ceilings, args.mode);

	const secrets = loadSecrets(process.env.CREDENTIALS_DIRECTORY, ids);

	delete process.env.CREDENTIALS_DIRECTORY;

	const credentials =
		ceilings.ok && secrets.ok
			? bindCredentials(parsed.table, ceilings.ceilings, secrets.secrets)
			: { ok: false as const };

	if (!credentials.ok) {
		fatal("bad-credentials");

		return null;
	}

	let audit: ReturnType<typeof openAuditFile>;

	try {
		audit = openAuditFile(args.audit, AUDIT_CAP_BYTES);
	} catch {
		fatal("audit-unavailable");

		return null;
	}

	const gateway = new Gateway({
		table: parsed.table,
		credentials,
		audit: audit.log,
		emit,
	});

	try {
		emit({ event: "ready", ino: await gateway.listen(args.socket) });
	} catch (error) {
		fatal(
			error instanceof Error && error.message.includes("already exists")
				? "socket-exists"
				: "listen-failed",
		);

		return null;
	}

	return gateway;
}

/**
 * The gateway process. Line one of stdin is the route table; later lines
 * are control commands. EOF on stdin closes the gate and exits, so the
 * gateway never outlives the controller that holds its pipe.
 */
async function main(): Promise<void> {
	process.umask(0o077);

	const args = parseGatewayArgs(process.argv.slice(2));

	if (args === null) {
		fatal("bad-arguments");

		return;
	}

	const splitter = new LineSplitter(64 * 1024 * 1024);
	let gateway: Promise<Gateway | null> | null = null;
	let queue = Promise.resolve();

	const handle = async (line: string) => {
		if (gateway === null) {
			gateway = start(args, line);
			await gateway;

			return;
		}

		const live = await gateway;
		const command = parseCommand(line);

		if (live === null || command === null) return;

		if (command.cmd === "close") live.closeGate(command.reason);
		else if (command.cmd === "open_route") live.setRoute(command.route, true);
		else if (command.cmd === "close_route") live.setRoute(command.route, false);
		else if (command.cmd === "drain_abort") live.drainAbort();
		else emit(live.summary());
	};

	process.stdin.on("data", (chunk: Buffer) => {
		const lines = splitter.push(chunk);

		if (lines === null) {
			fatal("bad-arguments");

			return;
		}

		for (const line of lines) queue = queue.then(() => handle(line));
	});

	process.stdin.on("end", () => {
		queue = queue.then(async () => {
			const live = gateway === null ? null : await gateway;

			if (live === null) {
				if (gateway === null) fatal("bad-table");

				return;
			}

			live.closeGate("control_closed");
			emit(live.summary());
			await live.close();
			process.exitCode = 0;
		});
	});
}

if (import.meta.main) await main();
