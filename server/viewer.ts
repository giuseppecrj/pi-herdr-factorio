import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { lstat, readFile, realpath } from "node:fs/promises";
import { parseArgs } from "node:util";
import { isDigest } from "../src/run.ts";
import { readViewerRun, viewerRuns } from "./viewer/evidence.ts";
import { renderIndex, renderRun } from "./viewer/render.ts";

export { readViewerRun } from "./viewer/evidence.ts";

export type ViewerOptions = {
	stateDir: string;
	runId?: string;
	port?: number;
	allowedHost?: string;
};

export async function startViewer(options: ViewerOptions) {
	const info = await lstat(options.stateDir);

	if (!info.isDirectory() || info.isSymbolicLink())
		throw new Error("state directory unavailable");

	if (options.runId !== undefined && !isDigest(options.runId))
		throw new Error("invalid run id");
	const stateDir = await realpath(options.stateDir);

	const css = await readFile(
		new URL("./viewer/style.css", import.meta.url),
		"utf8",
	);

	if (
		options.allowedHost !== undefined &&
		!/^[a-z0-9-]+(?:\.[a-z0-9-]+)+\.ts\.net$/.test(options.allowedHost)
	)
		throw new Error("expected an authorized Tailscale hostname");
	let port = options.port ?? 8080;

	const server = createServer(async (req, res) => {
		res.setHeader(
			"Content-Security-Policy",
			"default-src 'none'; style-src 'self'; base-uri 'none'; frame-ancestors 'none'; form-action 'none'",
		);
		res.setHeader("X-Content-Type-Options", "nosniff");
		res.setHeader("Referrer-Policy", "no-referrer");
		res.setHeader("Cache-Control", "no-store");

		const send = (
			code: number,
			body: string,
			contentType = "text/plain; charset=utf-8",
		) => {
			res.writeHead(code, { "Content-Type": contentType });
			res.end(body);
		};

		const host = req.headers.host;
		const local = host === `127.0.0.1:${port}` || host === `localhost:${port}`;

		const exposed =
			options.allowedHost !== undefined && host === options.allowedHost;

		if (
			(!local && !exposed) ||
			(req.headers.origin !== undefined &&
				req.headers.origin !== `${local ? "http" : "https"}://${host}`)
		) {
			send(403, "Forbidden");

			return;
		}

		if (req.method !== "GET") {
			res.setHeader("Allow", "GET");
			send(405, "GET only");

			return;
		}

		try {
			const path = req.url ?? "";

			if (path === "/style.css") {
				send(200, css, "text/css; charset=utf-8");

				return;
			}

			if (path === "/") {
				if (options.runId === undefined)
					send(
						200,
						renderIndex(await viewerRuns(stateDir)),
						"text/html; charset=utf-8",
					);
				else {
					res.writeHead(302, { Location: `/run/${options.runId}/timeline` });
					res.end();
				}

				return;
			}

			const match =
				/^\/run\/([a-f0-9]{64})\/(timeline|usage|children|gateway)(\.json)?$/.exec(
					path,
				);

			if (match === null) {
				send(404, "Not found");

				return;
			}

			const id = match[1] ?? "";

			if (
				(options.runId !== undefined && options.runId !== id) ||
				!(await viewerRuns(stateDir)).includes(id)
			) {
				send(404, "Run not found");

				return;
			}

			const view = match[2] ?? "timeline";
			const run = await readViewerRun(stateDir, id);

			if (match[3] !== undefined) {
				const data =
					view === "timeline"
						? run.timeline
						: view === "usage"
							? run.usage
							: view === "children"
								? run.children
								: run.gateway;

				send(
					200,
					JSON.stringify({
						runId: id,
						status: run.status,
						complete: run.complete,
						gaps: run.gaps,
						data,
					}),
					"application/json; charset=utf-8",
				);
			} else send(200, renderRun(run, view), "text/html; charset=utf-8");
		} catch {
			send(500, "Evidence unavailable");
		}
	});

	await new Promise<void>((done, reject) => {
		server.once("error", reject);
		server.listen(port, "127.0.0.1", () => {
			server.off("error", reject);
			done();
		});
	});
	// SAFETY: listen above binds TCP on loopback, never a Unix-domain socket.
	const address = server.address() as AddressInfo | null;

	if (address === null) {
		server.close();
		throw new Error("viewer unavailable");
	}

	port = address.port;

	return {
		port,
		address: address.address,
		close: () =>
			new Promise<void>((done, reject) => {
				server.close((error) => (error ? reject(error) : done()));
				server.closeIdleConnections();
			}),
	};
}

export async function runViewerCli(
	argv: readonly string[],
	io: { stdout: (text: string) => void; stderr: (text: string) => void },
) {
	let options: ViewerOptions;

	try {
		const { values } = parseArgs({
			args: [...argv],
			strict: true,
			options: {
				"state-dir": { type: "string" },
				run: { type: "string" },
				port: { type: "string" },
				"allowed-host": { type: "string" },
			},
		});

		const stateDir = values["state-dir"];
		const port = values.port === undefined ? 8080 : Number(values.port);

		if (
			!stateDir ||
			!Number.isInteger(port) ||
			port < 1 ||
			port > 65535 ||
			(values.run !== undefined && !isDigest(values.run)) ||
			(values["allowed-host"] !== undefined &&
				!/^[a-z0-9-]+(?:\.[a-z0-9-]+)+\.ts\.net$/.test(values["allowed-host"]))
		)
			throw new Error("usage");
		options = { stateDir, port };

		if (values.run !== undefined) options.runId = values.run;

		if (values["allowed-host"] !== undefined)
			options.allowedHost = values["allowed-host"];
	} catch {
		io.stderr(
			"Usage: node server/cli.ts viewer --state-dir <dir> [--run <id>] [--port <1-65535>] [--allowed-host <authorized.ts.net>]\n",
		);

		return 2;
	}

	try {
		const viewer = await startViewer(options);
		io.stdout(`viewer_ready bind=127.0.0.1 port=${viewer.port}\n`);
		await new Promise<void>((done) => {
			const stop = () => {
				process.off("SIGINT", stop);
				process.off("SIGTERM", stop);
				void viewer.close().then(done);
			};

			process.once("SIGINT", stop);
			process.once("SIGTERM", stop);
		});

		return 0;
	} catch {
		io.stderr(
			"viewer refused: state unavailable, invalid host, or port in use\n",
		);

		return 1;
	}
}
