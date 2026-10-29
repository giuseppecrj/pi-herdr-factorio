import { type ChildProcessByStdio, spawn } from "node:child_process";
import { lstatSync, mkdirSync } from "node:fs";
import { request } from "node:http";
import { join } from "node:path";
import type { Readable, Writable } from "node:stream";
import {
	type CloseReason,
	type ControlEvent,
	encodeCommand,
	type FatalCode,
	parseEvent,
	type SummaryEvent,
} from "./control.ts";
import { LineSplitter } from "./lines.ts";
import type { RouteId, RouteTable } from "./routes.ts";

export const GATEWAY_MAIN = new URL("./gateway-main.ts", import.meta.url)
	.pathname;

const MAX_SOCKET_PATH = 107;

const ACK_TIMEOUT_MS = 1_000;

export type GatewayStartFailure =
	| "socket-path-too-long"
	| "dir-exists"
	| "dir-failed"
	| "timeout"
	| "exited"
	| "bad-event"
	| "inode-mismatch"
	| "probe-failed"
	| FatalCode;

export interface GatewayHandle {
	readonly socketPath: string;
	readonly exited: Promise<number | null>;
	subscribe(listener: (event: ControlEvent) => void): void;
	closeGate(reason: CloseReason): Promise<boolean>;
	setRoute(route: RouteId, open: boolean): Promise<boolean>;
	drainAbort(): Promise<boolean>;
	shutdown(): Promise<SummaryEvent | null>;
	kill(): void;
}

export type GatewayStart =
	| { readonly ok: true; readonly handle: GatewayHandle }
	| { readonly ok: false; readonly reason: GatewayStartFailure };

export type GatewaySpec = {
	readonly gatewayDir: string;
	readonly auditPath: string;
	readonly table: RouteTable;
	readonly readyTimeoutMs: number;
	readonly ceilingsPath?: string;
	readonly credentialsDirectory?: string;
	/** Tests only: lets the table point a route at a loopback fixture. */
	readonly testMode?: boolean;
};

function probeNoRoute(socketPath: string, host: string): Promise<boolean> {
	return new Promise((done) => {
		const req = request(
			{
				socketPath,
				method: "GET",
				path: "/",
				headers: { Host: host },
				setHost: false,
			},
			(res) => {
				res.resume();
				res.on("end", () =>
					done(
						res.statusCode === 403 &&
							res.headers["x-proxy-error"] === "no-route",
					),
				);
			},
		);

		req.on("error", () => done(false));
		req.end();
	});
}

class ProcessHandle implements GatewayHandle {
	readonly socketPath: string;
	readonly exited: Promise<number | null>;
	readonly #child: ChildProcessByStdio<Writable, Readable, null>;
	readonly #listeners: ((event: ControlEvent) => void)[] = [];
	#bad = false;

	constructor(
		child: ChildProcessByStdio<Writable, Readable, null>,
		socketPath: string,
	) {
		this.#child = child;
		this.socketPath = socketPath;
		this.exited = new Promise((done) => {
			child.on("exit", (code) => done(code));
			child.on("error", () => done(null));
		});

		const splitter = new LineSplitter(1024 * 1024);

		child.stdout.on("data", (chunk: Buffer) => {
			const lines = splitter.push(chunk);

			for (const line of lines ?? [""]) {
				const event = parseEvent(line);

				if (event === null) {
					this.#bad = true;
					this.kill();

					return;
				}

				for (const listener of this.#listeners.slice()) listener(event);
			}
		});
		child.stdin.on("error", () => {});
	}

	get bad(): boolean {
		return this.#bad;
	}

	subscribe(listener: (event: ControlEvent) => void): void {
		this.#listeners.push(listener);
	}

	#await<T>(
		match: (event: ControlEvent) => T | null,
		timeoutMs: number,
	): Promise<T | null> {
		return new Promise((done) => {
			let settled = false;

			const finish = (value: T | null) => {
				if (settled) return;

				settled = true;
				clearTimeout(timer);
				done(value);
			};

			const timer = setTimeout(() => finish(null), timeoutMs);

			this.#listeners.push((event) => {
				const value = match(event);

				if (value !== null) finish(value);
			});
			this.exited.then(() => finish(null));
		});
	}

	#send(line: string): boolean {
		if (!this.#child.stdin.writable) return false;

		this.#child.stdin.write(line);

		return true;
	}

	waitReady(timeoutMs: number): Promise<ControlEvent | null> {
		return this.#await(
			(event) =>
				event.event === "ready" || event.event === "fatal" ? event : null,
			timeoutMs,
		);
	}

	/** Closes admission and waits for the ack. No ack within a second kills the gateway, which also ends egress. */
	async closeGate(reason: CloseReason): Promise<boolean> {
		const ack = this.#await(
			(event) => (event.event === "gate_closed" ? true : null),
			ACK_TIMEOUT_MS,
		);

		if (!this.#send(encodeCommand({ cmd: "close", reason }))) {
			this.kill();

			return false;
		}

		if ((await ack) === true) return true;

		this.kill();

		return false;
	}

	async setRoute(route: RouteId, open: boolean): Promise<boolean> {
		const ack = this.#await(
			(event) =>
				event.event === "route" && event.route === route ? event.state : null,
			ACK_TIMEOUT_MS,
		);

		this.#send(
			encodeCommand({ cmd: open ? "open_route" : "close_route", route }),
		);

		return (await ack) === (open ? "open" : "closed");
	}

	async drainAbort(): Promise<boolean> {
		const ack = this.#await(
			(event) => (event.event === "drained" ? true : null),
			ACK_TIMEOUT_MS,
		);

		this.#send(encodeCommand({ cmd: "drain_abort" }));

		return (await ack) === true;
	}

	async shutdown(): Promise<SummaryEvent | null> {
		const summary = this.#await(
			(event) => (event.event === "summary" ? event : null),
			5_000,
		);

		this.#child.stdin.end();

		const result = await summary;

		const exited = await Promise.race([
			this.exited.then(() => true),
			new Promise<boolean>((done) => setTimeout(() => done(false), 5_000)),
		]);

		if (!exited) this.kill();

		return result;
	}

	kill(): void {
		if (this.#child.exitCode === null) this.#child.kill("SIGKILL");
	}
}

/**
 * Starts one gateway for one stage in the order that removes the socket
 * race: a fresh 0700 dir that must not exist, the process, its `ready`
 * line, an inode check on the socket, then one probe that must see
 * `403 no-route`. Only after that may the sandbox bind the socket.
 */
export async function startGatewayProcess(
	spec: GatewaySpec,
): Promise<GatewayStart> {
	const socketPath = join(spec.gatewayDir, "gw.sock");

	if (Buffer.byteLength(socketPath) > MAX_SOCKET_PATH) {
		return { ok: false, reason: "socket-path-too-long" };
	}

	try {
		mkdirSync(spec.gatewayDir, { mode: 0o700 });
	} catch (error) {
		return {
			ok: false,
			reason:
				error instanceof Error && "code" in error && error.code === "EEXIST"
					? "dir-exists"
					: "dir-failed",
		};
	}

	const args = [
		GATEWAY_MAIN,
		...(spec.testMode === true ? ["--test-mode"] : []),
		"--socket",
		socketPath,
		"--audit",
		spec.auditPath,
	];

	if (spec.ceilingsPath !== undefined)
		args.push("--ceilings", spec.ceilingsPath);

	const env: Record<string, string> =
		spec.credentialsDirectory === undefined
			? {}
			: { CREDENTIALS_DIRECTORY: spec.credentialsDirectory };

	const child = spawn(process.execPath, args, {
		stdio: ["pipe", "pipe", "ignore"],
		env,
	});

	const handle = new ProcessHandle(child, socketPath);
	const ready = handle.waitReady(spec.readyTimeoutMs);

	child.stdin.write(`${JSON.stringify(spec.table)}\n`);

	const fail = (reason: GatewayStartFailure): GatewayStart => {
		handle.kill();

		return { ok: false, reason };
	};

	const event = await ready;

	if (event === null) {
		if (handle.bad) return fail("bad-event");

		return fail(child.exitCode === null ? "timeout" : "exited");
	}

	if (event.event === "fatal") return fail(event.code);

	if (event.event !== "ready") return fail("bad-event");

	try {
		const stat = lstatSync(socketPath);

		if (!stat.isSocket() || stat.ino !== event.ino)
			return fail("inode-mismatch");
	} catch {
		return fail("inode-mismatch");
	}

	if (!(await probeNoRoute(socketPath, spec.table.forwarderHost))) {
		return fail("probe-failed");
	}

	return { ok: true, handle };
}
