import { lookup as dnsLookup } from "node:dns/promises";
import { lstat } from "node:fs/promises";
import {
	type ClientRequest,
	createServer,
	type IncomingMessage,
	request as httpRequest,
	type Server,
	type ServerResponse,
} from "node:http";
import { request as httpsRequest } from "node:https";
import { BlockList, isIP, type Socket } from "node:net";
import { networkInterfaces } from "node:os";
import { TLSSocket } from "node:tls";
import type { Duplex } from "node:stream";
import type { AuditDecision, AuditLog, AuditUpstream } from "./audit.ts";
import { REDACTED_PATH, redactMethod, redactPath } from "./audit.ts";
import type {
	CloseReason,
	ControlEvent,
	RouteSummary,
	SummaryEvent,
} from "./control.ts";
import {
	type BoundCredential,
	buildUpstreamHeaders,
	type CredentialBinding,
	ReflectionFilter,
	responseHeadersFor,
	SecretScanner,
} from "./credentials.ts";
import { SseMeter } from "./meter.ts";
import {
	type AdmissionState,
	checkBody,
	type DenyCode,
	decideHead,
	denyBody,
	pathMatches,
	type ProxyCode,
} from "./policy.ts";
import type { PathRule, Route, RouteId, RouteTable } from "./routes.ts";

export type GatewayOptions = {
	readonly table: RouteTable;
	readonly credentials: CredentialBinding;
	readonly audit: AuditLog;
	readonly emit: (event: ControlEvent) => void;
	readonly lookup?: (host: string) => Promise<string[]>;
	readonly now?: () => number;
};

type RouteState = {
	open: boolean;
	tokens: number;
	refilledAt: number;
	active: number;
	forwarded: number;
	denied: number;
	bytesIn: number;
	bytesOut: number;
	inputTokens: number;
	outputTokens: number;
	unmetered: number;
	peakConcurrent: number;
};

type Exchange = {
	readonly req: number;
	readonly started: number;
	readonly method: string;
	readonly target: string;
	route: Route | null;
	upstream: AuditUpstream | null;
	bytesIn: number;
	bytesOut: number;
	inputTokens: number | null;
	outputTokens: number | null;
	finished: boolean;
};

const REFUSED_V4 = [
	["0.0.0.0", 8],
	["10.0.0.0", 8],
	["100.64.0.0", 10],
	["127.0.0.0", 8],
	["169.254.0.0", 16],
	["172.16.0.0", 12],
	["192.0.0.0", 24],
	["192.168.0.0", 16],
	["198.18.0.0", 15],
	["224.0.0.0", 4],
	["240.0.0.0", 4],
] as const;

const REFUSED_V6 = [
	["::", 128],
	["::1", 128],
	["::ffff:0:0", 96],
	["64:ff9b::", 96],
	["fc00::", 7],
	["fe80::", 10],
	["ff00::", 8],
] as const;

/**
 * One list per family. Node's `BlockList` checks an IPv4 address against
 * IPv6 rules in its `::ffff:` form too, so a single list holding
 * `::ffff:0:0/96` refused every IPv4 upstream.
 */
export type RefusedAddresses = {
	readonly v4: BlockList;
	readonly v6: BlockList;
};

export function refusedAddresses(): RefusedAddresses {
	const v4 = new BlockList();
	const v6 = new BlockList();

	for (const [network, prefix] of REFUSED_V4)
		v4.addSubnet(network, prefix, "ipv4");

	for (const [network, prefix] of REFUSED_V6)
		v6.addSubnet(network, prefix, "ipv6");

	for (const entries of Object.values(networkInterfaces())) {
		for (const entry of entries ?? []) {
			if (entry.family === "IPv6") v6.addAddress(entry.address, "ipv6");
			else v4.addAddress(entry.address, "ipv4");
		}
	}

	return { v4, v6 };
}

/** True when a resolved address may be dialled: public unicast only. */
export function addressAllowed(
	address: string,
	refused: RefusedAddresses,
): boolean {
	const family = isIP(address);

	if (family === 4) return !refused.v4.check(address, "ipv4");

	return family === 6 && !refused.v6.check(address, "ipv6");
}

/**
 * IPv4 addresses first, each family in resolver order. `pi-factorio` has
 * no IPv6 route, so an AAAA record is only a last resort.
 */
export function dialOrder(addresses: readonly string[]): string[] {
	return [
		...addresses.filter((address) => isIP(address) === 4),
		...addresses.filter((address) => isIP(address) !== 4),
	];
}

async function systemLookup(host: string): Promise<string[]> {
	const found = await dnsLookup(host, { all: true, verbatim: true });

	return dialOrder(found.map((entry) => entry.address));
}

function writeRaw(socket: Duplex, status: string, code: ProxyCode | null) {
	if (!socket.writable) {
		socket.destroy();

		return;
	}

	const body = code === null ? "" : denyBody(code);

	const head = [
		`HTTP/1.1 ${status}`,
		...(code === null
			? []
			: [`X-Proxy-Error: ${code}`, "Content-Type: text/plain; charset=utf-8"]),
		`Content-Length: ${Buffer.byteLength(body)}`,
		"Connection: close",
	];

	socket.end(`${head.join("\r\n")}\r\n\r\n${body}`);
}

function ruleText(rule: PathRule): string {
	if (rule.kind === "exact") return rule.path;

	return rule.kind === "prefix" ? `${rule.prefix}/…` : rule.pattern;
}

/**
 * What the audit records for a credentialed route: its prefix and the path
 * rule the request matched, both from the route table, never the raw path.
 */
function pathTemplate(route: Route, target: string): string {
	const question = target.indexOf("?");
	const path = question === -1 ? target : target.slice(0, question);

	const rule = path.startsWith(route.prefix)
		? route.paths.find((candidate) =>
				pathMatches(candidate, path.slice(route.prefix.length)),
			)
		: undefined;

	return `${route.prefix}${rule === undefined ? "…" : ruleText(rule)}`;
}

/**
 * The egress gateway: a path-routed reverse proxy on a unix socket that
 * builds every upstream request itself. One instance serves one stage.
 */
export class Gateway implements AdmissionState {
	readonly #table: RouteTable;
	readonly #bound: ReadonlyMap<RouteId, BoundCredential>;
	readonly #scanner: SecretScanner;
	readonly #audit: AuditLog;
	readonly #emit: (event: ControlEvent) => void;
	readonly #lookup: (host: string) => Promise<string[]>;
	readonly #now: () => number;
	readonly #refused = refusedAddresses();
	readonly #routes = new Map<RouteId, RouteState>();
	readonly #inflight = new Set<{
		upstream: ClientRequest;
		res: ServerResponse;
	}>();
	readonly #server: Server;
	#gate: CloseReason | null = null;
	#requests = 0;
	#modelTokens = 0;
	#modelRequests = 0;

	constructor(options: GatewayOptions) {
		if (!options.credentials.ok)
			throw new Error("gateway needs a bound credential table");

		this.#table = options.table;
		this.#bound = options.credentials.bound;
		this.#scanner = new SecretScanner(options.credentials.forms);
		this.#audit = options.audit;
		this.#emit = options.emit;
		this.#lookup = options.lookup ?? systemLookup;
		this.#now = options.now ?? Date.now;

		for (const route of options.table.routes) {
			this.#routes.set(route.id, {
				open: route.initially === "open",
				tokens: route.limits.perMinute,
				refilledAt: this.#now(),
				active: 0,
				forwarded: 0,
				denied: 0,
				bytesIn: 0,
				bytesOut: 0,
				inputTokens: 0,
				outputTokens: 0,
				unmetered: 0,
				peakConcurrent: 0,
			});
		}

		this.#server = createServer({
			maxHeaderSize: 32 * 1024,
			headersTimeout: 30_000,
			requestTimeout: 300_000,
			keepAliveTimeout: 1_000,
			joinDuplicateHeaders: false,
			insecureHTTPParser: false,
		});
		this.#server.maxHeadersCount = 100;
		this.#server.on("request", (req, res) => {
			this.#handle(req, res).catch(() => {
				res.destroy();
			});
		});
		this.#server.on("connect", (req: IncomingMessage, socket: Duplex) => {
			this.#rawDeny(req, socket, "method-forbidden");
		});
		this.#server.on("upgrade", (req: IncomingMessage, socket: Duplex) => {
			this.#rawDeny(req, socket, "forbidden-header");
		});
		this.#server.on("clientError", (_error, socket: Duplex) => {
			if (!socket.writable) {
				socket.destroy();

				return;
			}

			this.#record(this.#exchange("", ""), "deny", "bad-request", 403);
			writeRaw(socket, "403 Forbidden", "bad-request");
		});
	}

	/** Binds a socket path that must not exist yet, and returns its inode. */
	async listen(socketPath: string): Promise<number> {
		const existing = await lstat(socketPath).then(
			() => true,
			() => false,
		);

		if (existing) throw new Error("gateway socket path already exists");

		await new Promise<void>((done, fail) => {
			this.#server.once("error", fail);
			this.#server.listen(socketPath, () => {
				this.#server.off("error", fail);
				done();
			});
		});

		return (await lstat(socketPath)).ino;
	}

	routeOpen(id: RouteId): boolean {
		return this.#routes.get(id)?.open ?? false;
	}

	gateOpen(): boolean {
		return this.#gate === null;
	}

	rateOk(id: RouteId): boolean {
		const state = this.#routes.get(id);
		const route = this.#table.routes.find((candidate) => candidate.id === id);

		if (state === undefined || route === undefined) return false;

		const now = this.#now();
		const perMinute = route.limits.perMinute;

		state.tokens = Math.min(
			perMinute,
			state.tokens + ((now - state.refilledAt) * perMinute) / 60_000,
		);
		state.refilledAt = now;

		return state.tokens >= 1 && state.active < route.limits.maxConcurrent;
	}

	/** Closes admission for good. A repeated close acknowledges with the first reason. */
	closeGate(reason: CloseReason): void {
		if (this.#gate === null) this.#gate = reason;

		this.#emit({ event: "gate_closed", reason: this.#gate });
	}

	setRoute(id: RouteId, open: boolean): boolean {
		const state = this.#routes.get(id);

		if (state === undefined) {
			this.#emit({ event: "route", route: id, state: "unknown" });

			return false;
		}

		state.open = open;
		this.#emit({ event: "route", route: id, state: open ? "open" : "closed" });

		return true;
	}

	drainAbort(): void {
		for (const flight of this.#inflight) {
			flight.upstream.destroy();
			flight.res.destroy();
		}

		this.#inflight.clear();
		this.#emit({ event: "drained" });
	}

	summary(): SummaryEvent {
		const routes: RouteSummary[] = this.#table.routes.flatMap((route) => {
			const state = this.#routes.get(route.id);

			return state === undefined
				? []
				: [
						{
							route: route.id,
							forwarded: state.forwarded,
							denied: state.denied,
							bytesIn: state.bytesIn,
							bytesOut: state.bytesOut,
							inputTokens: state.inputTokens,
							outputTokens: state.outputTokens,
							unmetered: state.unmetered,
							peakConcurrent: state.peakConcurrent,
						},
					];
		});

		return {
			event: "summary",
			gate: this.#gate === null ? "open" : "closed",
			modelTokens: this.#modelTokens,
			modelRequests: this.#modelRequests,
			routes,
		};
	}

	async close(): Promise<void> {
		for (const flight of this.#inflight) {
			flight.upstream.destroy();
			flight.res.destroy();
		}

		this.#inflight.clear();

		await new Promise<void>((done) => {
			this.#server.close(() => done());
			this.#server.closeAllConnections();
		});
	}

	#exchange(method: string, target: string): Exchange {
		this.#requests += 1;

		return {
			req: this.#requests,
			started: this.#now(),
			method,
			target,
			route: null,
			upstream: null,
			bytesIn: 0,
			bytesOut: 0,
			inputTokens: null,
			outputTokens: null,
			finished: false,
		};
	}

	#record(
		exchange: Exchange,
		decision: AuditDecision,
		reason: ProxyCode | null,
		status: number,
	): void {
		if (exchange.finished) return;

		exchange.finished = true;

		const route = exchange.route;
		const state = route === null ? undefined : this.#routes.get(route.id);

		if (state !== undefined) {
			if (decision === "forward") state.forwarded += 1;
			else state.denied += 1;

			state.bytesIn += exchange.bytesIn;
			state.bytesOut += exchange.bytesOut;
		}

		const written = this.#audit.append({
			v: 1,
			ts: new Date(this.#now()).toISOString(),
			stage: this.#table.stage,
			runId: this.#table.runId,
			attempt: this.#table.attempt,
			req: exchange.req,
			route: route?.id ?? null,
			method: redactMethod(exchange.method),
			path: this.#auditPath(exchange, route, reason),
			upstream: exchange.upstream,
			status,
			bytesIn: exchange.bytesIn,
			bytesOut: exchange.bytesOut,
			durationMs: Math.max(0, this.#now() - exchange.started),
			credential:
				route === null ? null : (this.#bound.get(route.id)?.id ?? null),
			decision,
			reason,
			gate: this.#gate === null ? "open" : "closed",
			inputTokens: exchange.inputTokens,
			outputTokens: exchange.outputTokens,
		});

		if (!written && this.#gate === null) {
			this.closeGate(this.#audit.full ? "audit_full" : "audit_failed");
		}

		this.#emit({
			event: "usage",
			route: route?.id ?? null,
			decision,
			reason,
			status,
			bytesIn: exchange.bytesIn,
			bytesOut: exchange.bytesOut,
			inputTokens: exchange.inputTokens,
			outputTokens: exchange.outputTokens,
		});
	}

	/**
	 * A request that carried a secret logs no path at all, and a credentialed
	 * route logs only its path template. Anything else logs the redacted path
	 * with every segment that reveals a secret removed.
	 */
	#auditPath(
		exchange: Exchange,
		route: Route | null,
		reason: ProxyCode | null,
	): string {
		if (reason === "secret-in-request") return REDACTED_PATH;

		if (route !== null && this.#bound.has(route.id)) {
			return pathTemplate(route, exchange.target);
		}

		return redactPath(exchange.target, (text) => this.#scanner.reveals(text));
	}

	#deny(
		exchange: Exchange,
		res: ServerResponse,
		code: ProxyCode,
		after: () => void = () => {},
	): void {
		const status =
			code === "upstream-error" ? 502 : code === "upstream-timeout" ? 504 : 403;

		const body = denyBody(code);

		this.#record(
			exchange,
			code === "upstream-error" || code === "upstream-timeout"
				? "error"
				: "deny",
			code,
			status,
		);

		if (res.headersSent) {
			res.destroy();

			return;
		}

		res.writeHead(status, {
			"X-Proxy-Error": code,
			"Content-Type": "text/plain; charset=utf-8",
			"Content-Length":
				exchange.method === "HEAD" ? 0 : Buffer.byteLength(body),
			Connection: "close",
		});
		res.end(exchange.method === "HEAD" ? undefined : body, after);
	}

	#rawDeny(req: IncomingMessage, socket: Duplex, code: DenyCode): void {
		const exchange = this.#exchange(req.method ?? "", req.url ?? "");

		this.#record(exchange, "deny", code, 403);
		writeRaw(socket, "403 Forbidden", code);
	}

	async #readBody(req: IncomingMessage, limit: number): Promise<Buffer | null> {
		return new Promise((done) => {
			const chunks: Buffer[] = [];
			let size = 0;
			let over = false;

			req.on("data", (chunk: Buffer) => {
				size += chunk.length;

				if (size > limit) {
					if (!over) done(null);

					over = true;
					chunks.length = 0;

					return;
				}

				chunks.push(chunk);
			});
			req.on("end", () => {
				if (!over) done(Buffer.concat(chunks));
			});
			req.on("error", () => {
				if (!over) done(null);

				over = true;
			});
		});
	}

	async #address(route: Route): Promise<string | null> {
		if (route.upstream.address.kind === "pinned")
			return route.upstream.address.ip;

		const found = await this.#lookup(route.upstream.host).catch(() => []);

		return (
			found.find((address) => addressAllowed(address, this.#refused)) ?? null
		);
	}

	async #handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
		const exchange = this.#exchange(req.method ?? "", req.url ?? "");

		if (!this.#audit.healthy()) {
			this.#deny(exchange, res, "audit-unavailable");

			return;
		}

		const decision = decideHead(
			{
				method: exchange.method,
				target: exchange.target,
				rawHeaders: req.rawHeaders,
			},
			this.#table,
			this,
			(text) => this.#scanner.reveals(text),
		);

		exchange.route = decision.route;

		if (decision.kind === "deny") {
			this.#deny(exchange, res, decision.code);

			return;
		}

		const route = decision.route;
		const body = await this.#readBody(req, route.limits.maxRequestBytes);

		if (body === null) {
			this.#deny(exchange, res, "body-too-large", () => req.destroy());

			return;
		}

		exchange.bytesIn = body.length;

		const bodyCode = this.#scanner.reveals(body)
			? "secret-in-request"
			: checkBody(route, decision.contentType, body);

		if (bodyCode !== null) {
			this.#deny(exchange, res, bodyCode);

			return;
		}

		const address = await this.#address(route);

		if (address === null) {
			this.#deny(exchange, res, "upstream-address-refused");

			return;
		}

		if (!this.routeOpen(route.id))
			return this.#deny(exchange, res, "route-closed");

		if (route.budget && !this.gateOpen())
			return this.#deny(exchange, res, "budget-closed");

		if (!this.rateOk(route.id))
			return this.#deny(exchange, res, "rate-limited");

		if (!this.#audit.healthy())
			return this.#deny(exchange, res, "audit-unavailable");

		this.#forward(
			exchange,
			req,
			res,
			route,
			decision.upstreamPath,
			address,
			body,
		);
	}

	#forward(
		exchange: Exchange,
		req: IncomingMessage,
		res: ServerResponse,
		route: Route,
		upstreamPath: string,
		address: string,
		body: Buffer,
	): void {
		const state = this.#routes.get(route.id);

		if (state === undefined) return this.#deny(exchange, res, "no-route");

		state.tokens -= 1;
		state.active += 1;
		state.peakConcurrent = Math.max(state.peakConcurrent, state.active);

		if (route.meter !== null) {
			this.#modelRequests += 1;

			if (this.#modelRequests >= this.#table.ceiling.modelRequests) {
				this.closeGate("ceiling");
			}
		}

		const credential = this.#bound.get(route.id) ?? null;
		const https = route.upstream.scheme === "https";

		exchange.upstream = {
			host: route.upstream.hostHeader,
			sni: null,
			port: route.upstream.port,
			addr: address,
			tls: null,
		};

		const headers = buildUpstreamHeaders(
			route,
			req.rawHeaders,
			body.length,
			credential?.header ?? null,
		);

		const options = {
			host: address,
			port: route.upstream.port,
			method: exchange.method,
			path: upstreamPath,
			headers: Object.fromEntries(headers),
			setHost: false,
			agent: false,
			timeout: route.limits.idleTimeoutMs,
		} as const;

		const upstream = https
			? httpsRequest({
					...options,
					servername: route.upstream.sni,
					rejectUnauthorized: true,
				})
			: httpRequest(options);

		const flight = { upstream, res };
		let responded = false;

		this.#inflight.add(flight);

		let released = false;

		const release = () => {
			if (released) return;

			released = true;
			clearTimeout(headersTimer);
			clearTimeout(totalTimer);
			this.#inflight.delete(flight);
			state.active -= 1;
		};

		const done = (
			decision: AuditDecision,
			reason: ProxyCode | null,
			status: number,
		) => {
			if (exchange.finished) return;

			release();
			this.#record(exchange, decision, reason, status);
		};

		const refuse = (code: ProxyCode) => {
			if (exchange.finished) return;

			release();
			this.#deny(exchange, res, code);
		};

		const fail = (code: "upstream-error" | "upstream-timeout") => {
			if (exchange.finished) return;

			upstream.destroy();

			if (responded) {
				res.destroy();
				done("error", code, res.statusCode);
			} else {
				refuse(code);
			}
		};

		const headersTimer = setTimeout(() => {
			if (!responded) fail("upstream-timeout");
		}, route.limits.headersTimeoutMs);

		const totalTimer = setTimeout(
			() => fail("upstream-timeout"),
			route.limits.totalTimeoutMs,
		);

		upstream.on("socket", (socket: Socket) => {
			if (socket instanceof TLSSocket) {
				socket.once("secureConnect", () => {
					const name = socket.servername;

					exchange.upstream = {
						host: route.upstream.hostHeader,
						sni: name === String(name) ? name : null,
						port: route.upstream.port,
						addr: address,
						tls: socket.getProtocol(),
					};
				});
			}
		});
		upstream.on("timeout", () => fail("upstream-timeout"));
		upstream.on("error", () => fail("upstream-error"));
		upstream.on("response", (incoming) => {
			responded = true;
			clearTimeout(headersTimer);
			this.#respond(
				exchange,
				route,
				credential,
				incoming,
				res,
				upstream,
				done,
				refuse,
			);
		});
		upstream.end(body);
	}

	#respond(
		exchange: Exchange,
		route: Route,
		credential: BoundCredential | null,
		incoming: IncomingMessage,
		res: ServerResponse,
		upstream: ClientRequest,
		done: (
			decision: AuditDecision,
			reason: ProxyCode | null,
			status: number,
		) => void,
		refuse: (code: ProxyCode) => void,
	): void {
		const status = incoming.statusCode ?? 502;

		const blockedHead = (code: DenyCode) => {
			incoming.destroy();
			upstream.destroy();
			refuse(code);
		};

		if (credential !== null) {
			const encoding = incoming.headers["content-encoding"];

			if (status >= 300 && status < 400) return blockedHead("redirect-refused");

			if (encoding !== undefined && encoding.toLowerCase() !== "identity") {
				return blockedHead("response-blocked");
			}

			if (incoming.rawHeaders.some((entry) => this.#scanner.contains(entry))) {
				return blockedHead("response-blocked");
			}
		}

		const headers = responseHeadersFor(route, incoming.rawHeaders);

		res.writeHead(status, [...headers.flat(), "Connection", "close"]);

		const filter =
			credential === null ? null : new ReflectionFilter(credential.forms);

		const meter = route.meter === null ? null : new SseMeter();

		incoming.on("data", (chunk: Buffer) => {
			exchange.bytesOut += chunk.length;

			if (exchange.bytesOut > route.limits.maxResponseBytes) {
				upstream.destroy();
				res.destroy();
				done("error", "upstream-error", status);

				return;
			}

			meter?.push(chunk);

			if (filter === null) {
				res.write(chunk);

				return;
			}

			const step = filter.push(chunk);

			if (step.kind === "blocked") {
				upstream.destroy();
				res.destroy();
				done("blocked_mid_stream", "response-blocked", status);

				return;
			}

			res.write(step.bytes);
		});
		incoming.on("end", () => {
			if (exchange.finished) return;

			if (filter !== null) res.write(filter.end());

			meter?.end();
			this.#meter(exchange, route, meter);
			res.end();
			done("forward", null, status);
		});
		incoming.on("error", () => {
			res.destroy();
			done("error", "upstream-error", status);
		});
	}

	#meter(exchange: Exchange, route: Route, meter: SseMeter | null): void {
		if (meter === null) return;

		const state = this.#routes.get(route.id);
		const usage = meter.usage();

		if (usage === null) {
			if (state !== undefined) state.unmetered += 1;

			return;
		}

		exchange.inputTokens = usage.inputTokens;
		exchange.outputTokens = usage.outputTokens;

		if (state !== undefined) {
			state.inputTokens += usage.inputTokens;
			state.outputTokens += usage.outputTokens;
		}

		this.#modelTokens += usage.inputTokens + usage.outputTokens;

		if (this.#modelTokens >= this.#table.ceiling.modelTokens) {
			this.closeGate("ceiling");
		}
	}
}
