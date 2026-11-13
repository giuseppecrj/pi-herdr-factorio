import { randomBytes, timingSafeEqual } from "node:crypto";
import { lstat, open, readFile, realpath, unlink } from "node:fs/promises";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { join } from "node:path";
import { parseArgs } from "node:util";
import { objectOf, textOf } from "../../src/core/json.ts";
import { isDigest } from "../../src/core/run.ts";
import { plainTitle } from "../../src/views/attention.ts";
import {
	readPlatformFile,
	resolvePlatform,
	type PlatformProfile,
} from "../../src/trust/platform.ts";
import {
	readOwnerFeed,
	readOwnerHeader,
	readOwnerRun,
} from "../cli/owner-feed.ts";
import {
	renderDashboard,
	renderHeader,
	renderRunSummary,
	renderSteps,
	runAction,
} from "./dashboard.ts";
import { readViewerRun, viewerRuns } from "./evidence.ts";
import { renderRun } from "./render.ts";

export type ViewerOptions = {
	stateDir: string;
	platform?: PlatformProfile;
	runId?: string;
	port?: number;
	allowedHost?: string;
	basePath?: string;
	bind?: string;
	log?: (line: string) => void;
};

const holdToken = randomBytes(32).toString("hex");

const basePathPattern = /^(?:\/[a-z0-9-]+)+$/;

export async function startViewer(options: ViewerOptions) {
	if (options.bind !== undefined && options.bind !== "127.0.0.1")
		throw new Error("loopback bind required");
	const info = await lstat(options.stateDir);

	if (
		!info.isDirectory() ||
		info.isSymbolicLink() ||
		info.uid !== process.geteuid?.() ||
		(info.mode & 0o077) !== 0
	)
		throw new Error("state directory unavailable");

	if (options.runId !== undefined && !isDigest(options.runId))
		throw new Error("invalid run id");
	const stateDir = await realpath(options.stateDir);

	const resolved =
		options.platform === undefined
			? await resolvePlatform({
					env: (name) => process.env[name],
					readFile: readPlatformFile,
				})
			: ({ ok: true, profile: options.platform } as const);

	if (!resolved.ok) throw new Error("platform unavailable");
	const platform = resolved.profile;

	const css = (
		await Promise.all(
			["./design/tokens.css", "./style.css"].map((path) =>
				readFile(new URL(path, import.meta.url), "utf8"),
			),
		)
	).join("\n");

	if (
		options.allowedHost !== undefined &&
		!/^[a-z0-9-]+(?:\.[a-z0-9-]+)+\.ts\.net$/.test(options.allowedHost)
	)
		throw new Error("expected an authorized Tailscale hostname");

	if (options.basePath !== undefined && !basePathPattern.test(options.basePath))
		throw new Error("invalid base path");
	const base = options.basePath ?? "";
	let port = options.port ?? 8080;

	const server = createServer(async (req, res) => {
		res.setHeader(
			"Content-Security-Policy",
			"default-src 'none'; style-src 'self'; img-src 'self'; manifest-src 'self'; base-uri 'none'; frame-ancestors 'none'; form-action 'self'",
		);
		res.setHeader("X-Content-Type-Options", "nosniff");
		res.setHeader("Referrer-Policy", "same-origin");
		res.setHeader("Cache-Control", "no-store");

		const send = (
			code: number,
			body: string | Buffer,
			contentType = "text/plain; charset=utf-8",
		) => {
			res.writeHead(code, { "Content-Type": contentType });
			res.end(body);
		};

		const host = req.headers.host;
		const local = host === `127.0.0.1:${port}` || host === `localhost:${port}`;

		const proxyLogin = textOf(req.headers["tailscale-user-login"]);

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

		const url = req.url ?? "";

		const path =
			base !== "" && (url === `${base}/` || url.startsWith(`${base}/`))
				? url.slice(base.length)
				: url;

		if (path === "/hold" && req.method === "POST") {
			if (
				req.headers.origin !== `${local ? "http" : "https"}://${host}` ||
				req.headers["content-type"] !== "application/x-www-form-urlencoded"
			) {
				send(403, "Forbidden");

				return;
			}

			try {
				let body = "";

				for await (const chunk of req) {
					body += String(chunk);

					if (Buffer.byteLength(body) > 4096) {
						send(413, "Form too large");

						return;
					}
				}

				const form = new URLSearchParams(body);
				const token = form.get("token") ?? "";
				const hold = form.get("hold");

				if (
					Buffer.byteLength(token) !== Buffer.byteLength(holdToken) ||
					!timingSafeEqual(Buffer.from(token), Buffer.from(holdToken)) ||
					form.size !== 2 ||
					(hold !== "on" && hold !== "off")
				) {
					send(403, "Forbidden");

					return;
				}

				const disabled = join(stateDir, "disabled");

				const existing = await lstat(disabled).catch(
					(error: NodeJS.ErrnoException) => {
						if (error.code === "ENOENT") return null;
						throw error;
					},
				);

				if (
					existing !== null &&
					(!existing.isFile() || existing.uid !== process.geteuid?.())
				) {
					send(409, "Hold file unavailable");

					return;
				}

				if (hold === "on" && existing === null) {
					try {
						const file = await open(disabled, "wx", 0o600);
						await file.close();
					} catch (error) {
						if (
							!(error instanceof Error) ||
							!("code" in error) ||
							error.code !== "EEXIST"
						)
							throw error;
						const concurrent = await lstat(disabled);

						if (
							!concurrent.isFile() ||
							concurrent.uid !== process.geteuid?.()
						) {
							send(409, "Hold file unavailable");

							return;
						}
					}
				}

				if (hold === "off" && existing !== null)
					await unlink(disabled).catch((error: NodeJS.ErrnoException) => {
						if (error.code !== "ENOENT") throw error;
					});
				(options.log ?? ((line) => process.stderr.write(`${line}\n`)))(
					`at=${new Date().toISOString()} event=local_hold hold=${hold} source=${req.socket.remoteAddress ?? "unknown"} host=${host}${exposed && proxyLogin !== null ? ` proxy_reported_login=${JSON.stringify(proxyLogin)}` : ""}`,
				);
				res.writeHead(303, { Location: `${base}/` });
				res.end();
			} catch {
				send(500, "Hold unavailable");
			}

			return;
		}

		if (req.method !== "GET" || path === "/hold") {
			res.setHeader("Allow", path === "/hold" ? "POST" : "GET");
			send(405, path === "/hold" ? "POST only" : "GET only");

			return;
		}

		try {
			if (path === "/style.css") {
				send(200, css, "text/css; charset=utf-8");

				return;
			}

			if (
				path === "/manifest.webmanifest" ||
				path === "/icon-192.png" ||
				path === "/icon-512.png"
			) {
				const name = path.slice(1);
				send(
					200,
					await readFile(new URL(`./${name}`, import.meta.url)),
					name.endsWith(".png") ? "image/png" : "application/manifest+json",
				);

				return;
			}

			if (path === "/owner-feed.json") {
				send(
					200,
					JSON.stringify(await readOwnerFeed({ stateDir, platform })),
					"application/json; charset=utf-8",
				);

				return;
			}

			if (path === "/" || /^\/\?run=[a-f0-9]{64}$/.test(path)) {
				if (options.runId === undefined)
					send(
						200,
						renderDashboard(
							await readOwnerFeed({ stateDir, platform }),
							base,
							holdToken,
							path.startsWith("/?run=") ? path.slice(6) : undefined,
						),
						"text/html; charset=utf-8",
					);
				else {
					res.writeHead(302, {
						Location: `${base}/run/${options.runId}/timeline`,
					});
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
			} else {
				const feed = await readOwnerHeader(stateDir);
				const entry = await readOwnerRun(stateDir, id, feed);
				send(
					200,
					renderRun(run, view, base, {
						header: renderHeader(feed, base, holdToken),
						issue: entry?.issue ?? null,
						title:
							entry === null
								? plainTitle(
										textOf(objectOf(run.issue)?.title) ?? "Title unavailable",
									)
								: `#${entry.issue} ${entry.title}`,
						summary: entry === null ? "" : renderRunSummary(entry),
						steps:
							entry === null
								? "<p class=muted>Stage summary unavailable. See the retained events below.</p>"
								: renderSteps(entry),
						links: entry === null ? "" : runAction(entry),
					}),
					"text/html; charset=utf-8",
				);
			}
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
	platform: PlatformProfile,
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
				"base-path": { type: "string" },
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
				!/^[a-z0-9-]+(?:\.[a-z0-9-]+)+\.ts\.net$/.test(
					values["allowed-host"],
				)) ||
			(values["base-path"] !== undefined &&
				!basePathPattern.test(values["base-path"]))
		)
			throw new Error("usage");
		options = { stateDir, port, platform };

		if (values.run !== undefined) options.runId = values.run;

		if (values["allowed-host"] !== undefined)
			options.allowedHost = values["allowed-host"];

		if (values["base-path"] !== undefined)
			options.basePath = values["base-path"];
	} catch {
		io.stderr(
			"Usage: node host/cli/index.ts viewer --state-dir <dir> [--run <id>] [--port <1-65535>] [--allowed-host <authorized.ts.net>] [--base-path </prefix>]\n",
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
