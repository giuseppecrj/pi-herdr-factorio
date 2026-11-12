import assert from "node:assert/strict";
import { execFileSync, spawn } from "node:child_process";
import {
	mkdirSync,
	mkdtempSync,
	readdirSync,
	rmSync,
	symlinkSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import { factoryCommandText, registerFactory } from "../extension/index.ts";
import { EXIT, runCli } from "../server/cli.ts";
import { fileRunFiles, writeStatus } from "../server/controller.ts";
import { readStatus } from "../server/controller/state.ts";
import { parseEvent } from "../server/sandbox/control.ts";
import {
	buildUpstreamHeaders,
	parseCeilings,
} from "../server/sandbox/credentials.ts";
import { startGatewayProcess } from "../server/sandbox/gateway-client.ts";
import { decideHead, type RequestHead } from "../server/sandbox/policy.ts";
import {
	builtinTable,
	credentialId,
	isForbiddenUpstreamHost,
	parseRouteTable,
	type Route,
	type RouteTable,
} from "../server/sandbox/routes.ts";
import type { CommentEdit, IssueComment } from "../src/github/adapter.ts";
import { GitHubTicketAdapter } from "../src/github/adapter.ts";
import {
	formatMarker,
	type Marker,
	markerLedger,
} from "../src/trust/markers.ts";
import { checkIdentity, type TickReport } from "../src/orchestrator.ts";
import {
	currentRepository,
	EXE_DEV_PLATFORM,
	measuredRepositories,
	type PlatformFile,
	type PlatformNetwork,
	type PlatformProfile,
	type PlatformRefusal,
	parsePlatformProfile,
	platformDefect,
	platformSummary,
	readPlatformFile,
	resolvePlatform,
} from "../src/trust/platform.ts";
import { reserveReplay } from "../src/maintenance/replay.ts";
import { digestOf, runIdOf } from "../src/core/run.ts";
import type { JsonValue } from "../src/core/json.ts";
import {
	type Exec,
	type GitSha,
	isGitSha,
	isRepoSlug,
	parseWorkflow,
	type RepoSlug,
} from "../src/workflow.ts";
import { noPlatformFile } from "./helpers.ts";

function slug(text: string): RepoSlug {
	if (!isRepoSlug(text)) throw new Error(`bad slug ${text}`);

	return text;
}

function sha(text: string): GitSha {
	if (!isGitSha(text)) throw new Error(`bad sha ${text}`);

	return text;
}

const repo = slug("nublai/pi-herdr-factorio");
const mainSha = sha("a".repeat(40));

const PUBLISHED_IDENTITY = {
	controllerLogin: "nubl-agent[bot]",
	controllerAppSlug: "nubl-agent",
	botEmail: "353429311+nubl-agent[bot]@users.noreply.github.com",
};

const OVERRIDE_IDENTITY = {
	controllerLogin: "exmach-integration[bot]",
	controllerAppSlug: "exmach-integration",
	botEmail: "4242+exmach-integration[bot]@users.noreply.github.com",
};

function file(fields: { readonly [key: string]: JsonValue }): PlatformFile {
	return { kind: "present", text: JSON.stringify(fields) };
}

function exmachFile(
	fields: { readonly [key: string]: JsonValue } = {},
): PlatformFile {
	return file({
		version: 1,
		platform: "exmach:example.net",
		...fields,
	});
}

const ABSENT: PlatformFile = { kind: "absent" };

function resolved(
	selector: string | undefined,
	source: PlatformFile,
): PlatformProfile {
	const result = parsePlatformProfile({ selector, file: source });

	assert.ok(result.ok, result.ok ? "" : result.reason);

	return result.profile;
}

function refusal(
	selector: string | undefined,
	source: PlatformFile,
): PlatformRefusal | null {
	const result = parsePlatformProfile({ selector, file: source });

	return result.ok ? null : result.reason;
}

const EXMACH = resolved(undefined, exmachFile());

function tableFor(
	platform: PlatformNetwork,
	input: { provider?: "openai" | "anthropic"; fallback?: string | null } = {},
): RouteTable {
	return builtinTable({
		platform,
		stage: input.provider === "anthropic" ? "accept" : "specify",
		runId: "a".repeat(64),
		attempt: 1,
		provider: input.provider,
		model: input.provider === "anthropic" ? "claude-sonnet-5-5" : "gpt-6.1-sol",
		fallback: input.fallback ?? null,
		modelTokens: 50_000,
		modelRequests: 200,
	});
}

function roundTrip(table: RouteTable): JsonValue {
	const value: JsonValue = JSON.parse(JSON.stringify(table));

	return value;
}

function withRoute(
	table: RouteTable,
	edit: (route: Route) => Route,
): JsonValue {
	return roundTrip({
		...table,
		routes: table.routes.map((route, index) =>
			index === 0 ? edit(route) : route,
		),
	});
}

function head(
	method: string,
	target: string,
	headers: readonly string[] = [],
): RequestHead {
	return {
		method,
		target,
		rawHeaders: ["Host", "127.0.0.1:18080", ...headers],
	};
}

function upstreamPath(table: RouteTable, request: RequestHead): string {
	const decision = decideHead(
		request,
		table,
		{ routeOpen: () => true, gateOpen: () => true, rateOk: () => true },
		() => false,
	);

	return decision.kind === "admit"
		? `${decision.route.id}:${decision.upstreamPath}`
		: decision.code;
}

function credentialed(host: string): Route {
	const npm = tableFor(EXMACH).routes.find((route) => route.id === "npm");
	const id = credentialId("echo-read");

	assert.ok(npm !== undefined && id !== null);

	return {
		...npm,
		id: routeIdOf("echo-read"),
		prefix: "/echo/",
		upstream: {
			scheme: "https",
			host,
			port: 443,
			basePath: "/",
			hostHeader: host,
			sni: host,
			address: { kind: "resolve" },
		},
		methods: ["GET"],
		paths: [{ kind: "prefix", prefix: "api" }],
		credential: {
			id,
			placement: { kind: "header", name: "Authorization", scheme: "Bearer" },
		},
	};
}

/** A branded route id, read back through the boundary parser's test mode. */
function routeIdOf(text: string): Route["id"] {
	const value: JsonValue = JSON.parse(
		JSON.stringify(tableFor(EXE_DEV_PLATFORM)).replace(
			'"id":"npm"',
			`"id":"${text}"`,
		),
	);

	const parsed = parseRouteTable(value, "test", EXE_DEV_PLATFORM);

	assert.ok(parsed.ok);

	const route = parsed.table.routes.find((entry) => entry.prefix === "/npm/");

	assert.ok(route !== undefined && route.id === text);

	return route.id;
}

function ceilings(host: string): string {
	return JSON.stringify({
		"echo-read": {
			scheme: "https",
			host,
			port: 443,
			placement: { kind: "header", name: "Authorization", scheme: "Bearer" },
			methods: ["GET"],
			paths: [{ kind: "prefix", prefix: "api" }],
		},
	});
}

function unforbidden(platform: PlatformProfile, drop: string): PlatformProfile {
	return {
		...platform,
		forbiddenDomains: platform.forbiddenDomains.filter(
			(domain) => domain !== drop,
		),
	};
}

function workflowText(lines: string): string {
	return `---\nrepository: ${repo}\n${lines}\n---\nbody\n`;
}

function parsed(text: string, platform: PlatformProfile) {
	return parseWorkflow({ text, repo, env: () => "/home/factory", platform });
}

function errorOf(text: string, platform: PlatformProfile) {
	const result = parsed(text, platform);

	assert.equal(result.kind, "invalid");

	return result.kind === "invalid" ? result.error : null;
}

type CliRun = {
	readonly code: number;
	readonly stdout: string;
	readonly stderr: string;
	readonly calls: readonly (readonly string[])[];
};

async function cli(
	argv: readonly string[],
	input: {
		readonly env?: { readonly [name: string]: string };
		readonly file?: PlatformFile;
		readonly reader?: () => Promise<PlatformFile>;
		readonly workflow?: string;
	} = {},
): Promise<CliRun> {
	let stdout = "";
	let stderr = "";
	const calls: string[][] = [];

	const exec: Exec = async (command, args) => {
		calls.push([command, ...args]);

		if (args.includes("--jq")) {
			return { code: 0, stdout: `${mainSha}\n`, stderr: "" };
		}

		return input.workflow === undefined
			? { code: 1, stdout: "", stderr: "HTTP 404" }
			: { code: 0, stdout: input.workflow, stderr: "" };
	};

	const code = await runCli(argv, {
		readPlatformFile: input.reader ?? (async () => input.file ?? ABSENT),
		exec,
		env: (name) =>
			input.env?.[name] ?? (name === "HOME" ? "/home/factory" : undefined),
		stdout: (text) => {
			stdout += text;
		},
		stderr: (text) => {
			stderr += text;
		},
	});

	return { code, stdout, stderr, calls };
}

function privateDir(prefix: string): string {
	const dir = mkdtempSync(join(tmpdir(), prefix));

	return dir;
}

const runId = runIdOf({ repo, issue: 14, eventId: "34537521383" });

function marker(): Marker {
	return {
		v: 1,
		runId,
		repo,
		issue: 14,
		eventId: "34537521383",
		eventAt: "2026-10-29T01:21:37Z",
		snapshotDigest: digestOf("snapshot"),
		workflowSha: sha("c".repeat(40)),
		workflowDigest: digestOf("workflow"),
		stage: "specify",
		status: "claimed",
		attempt: 1,
		seq: 1,
		branch: null,
		pr: null,
		usage: 0,
		cursor: "2026-10-29T01:00:00Z",
	};
}

function comment(id: string, login: string, appSlug: string): IssueComment {
	return {
		id,
		nodeId: `IC_${id}`,
		issueUrl: `https://api.github.com/repos/${repo}/issues/14`,
		author: { login, type: "Bot" },
		appSlug,
		body: formatMarker(marker()),
		createdAt: "2026-10-29T02:00:00Z",
	};
}

function edits(comments: readonly IssueComment[]): Map<string, CommentEdit> {
	return new Map(
		comments.map((item) => [
			item.nodeId,
			{ id: item.id, issue: 14, repo, lastEditedAt: null },
		]),
	);
}

const REPORT: TickReport = {
	repo,
	at: "2026-11-10T12:00:00.000Z",
	executionEnabled: false,
	dispatch: { enabled: false, reasons: ["locally_disabled"] },
	workflowSha: null,
	maxConcurrent: 2,
	active: 0,
	runs: [],
	feedbackIntake: [],
	unverifiedClaims: [],
	queued: [],
	absent: [],
	refused: [],
	corrupt: [],
	ledgerBehind: [],
	totals: {
		claims: 0,
		launches: 0,
		retries: 0,
		stalls: 0,
		releases: 0,
		failures: 0,
		markersPosted: 0,
		usage: 0,
	},
};

describe("platform selection", () => {
	it("selects today's exe-dev values with no source, identically to an explicit exe-dev", () => {
		const unset = resolved(undefined, ABSENT);

		assert.deepEqual(resolved("exe-dev", ABSENT), unset);
		assert.deepEqual(
			resolved(undefined, file({ version: 1, platform: "exe-dev" })),
			unset,
		);
		assert.deepEqual(
			resolved("exe-dev", file({ version: 1, platform: "exe-dev" })),
			unset,
		);
		assert.deepEqual(EXE_DEV_PLATFORM, unset);
		assert.deepEqual(
			platformSummary(resolved("exe-dev", ABSENT)),
			platformSummary(unset),
		);
		assert.deepEqual(unset, {
			name: "exe-dev",
			domain: "exe.xyz",
			modelHost: "llm.int.exe.xyz",
			edgeAddress: "169.254.169.254",
			modelBasePaths: {
				openai: "/openai/v1/",
				anthropic: "/anthropic/",
				xai: "/xai/v1/",
			},
			forbiddenDomains: [
				"exe.xyz",
				"int.exe.xyz",
				"github.com",
				"githubusercontent.com",
				"ghe.com",
			],
			controllerLogin: "exe-dev-github-integration[bot]",
			controllerAppSlug: "exe-dev-github-integration",
			botEmail:
				"267204973+exe-dev-github-integration[bot]@users.noreply.github.com",
			ghHost: "github.int.exe.xyz",
			repositories: ["nublai/pi-herdr-factorio"],
			historicalRepositories: {
				"nublai/pi-herdr-factorio": ["giuseppecrj/pi-herdr-factorio"],
			},
			anthropicStages: ["accept", "code-review"],
		});
		assert.equal(Object.isFrozen(unset), true);
		assert.equal(Object.isFrozen(unset.modelBasePaths), true);
		assert.equal(Object.isFrozen(unset.forbiddenDomains), true);
		assert.equal(Object.isFrozen(unset.repositories), true);
	});

	it("builds exmach from the built-in contract with the published identity and factorio GitHub host", () => {
		assert.deepEqual(EXMACH, {
			name: "exmach",
			domain: "example.net",
			modelHost: "llm.int.example.net",
			edgeAddress: "10.74.1.1",
			modelBasePaths: { openai: "/v1/", anthropic: "/", xai: null },
			forbiddenDomains: [
				"example.net",
				"int.example.net",
				"github.com",
				"githubusercontent.com",
				"ghe.com",
			],
			...PUBLISHED_IDENTITY,
			ghHost: "factorio.int.example.net",
			repositories: ["nublai/pi-herdr-factorio"],
			historicalRepositories: {
				"nublai/pi-herdr-factorio": ["giuseppecrj/pi-herdr-factorio"],
			},
			anthropicStages: ["accept", "code-review"],
		});
		assert.deepEqual(resolved("exmach:example.net", ABSENT), EXMACH);
		assert.deepEqual(
			resolved("exmach:example.net", file({ version: 1 })),
			EXMACH,
		);

		const published = resolved("exmach:exmach.net", ABSENT);

		assert.equal(published.controllerLogin, "nubl-agent[bot]");
		assert.equal(published.controllerAppSlug, "nubl-agent");
		assert.equal(
			published.botEmail,
			"353429311+nubl-agent[bot]@users.noreply.github.com",
		);
		assert.equal(published.ghHost, "factorio.int.exmach.net");
		assert.equal(published.modelHost, "llm.int.exmach.net");
		assert.equal(Object.isFrozen(published), true);
	});

	it("lets the exmach file override the whole identity, the repositories and one GitHub host label", () => {
		assert.deepEqual(resolved(undefined, exmachFile(OVERRIDE_IDENTITY)), {
			...EXMACH,
			...OVERRIDE_IDENTITY,
		});
		assert.deepEqual(
			resolved(
				"exmach:example.net",
				file({ version: 1, ...OVERRIDE_IDENTITY }),
			),
			{ ...EXMACH, ...OVERRIDE_IDENTITY },
		);
		assert.deepEqual(
			resolved(undefined, exmachFile({ repositories: ["acme/widgets"] })),
			{ ...EXMACH, repositories: ["acme/widgets"] },
		);

		for (const ghHost of [
			"github.int.example.net",
			"factorio-2.int.example.net",
			"x.int.example.net",
		]) {
			assert.deepEqual(resolved(undefined, exmachFile({ ghHost })), {
				...EXMACH,
				ghHost,
			});
		}

		const everything = resolved(
			undefined,
			exmachFile({
				...OVERRIDE_IDENTITY,
				repositories: ["acme/widgets", "acme/gears"],
				ghHost: "github.int.example.net",
			}),
		);

		assert.deepEqual(everything, {
			...EXMACH,
			...OVERRIDE_IDENTITY,
			repositories: ["acme/widgets", "acme/gears"],
			ghHost: "github.int.example.net",
		});
		assert.equal(Object.isFrozen(everything.repositories), true);
	});

	it("lets the file replace the read-only historical repository alias under the same validation", () => {
		assert.equal(
			Object.isFrozen(EXE_DEV_PLATFORM.historicalRepositories),
			true,
		);

		assert.deepEqual(
			resolved(undefined, exmachFile({ historicalRepositories: {} }))
				.historicalRepositories,
			{},
		);

		const moved = resolved(
			undefined,
			exmachFile({
				repositories: ["acme/widgets"],
				historicalRepositories: {
					"acme/widgets": ["acme/old-widgets", "someone/widgets"],
				},
			}),
		);

		assert.deepEqual(moved.historicalRepositories, {
			"acme/widgets": ["acme/old-widgets", "someone/widgets"],
		});
		assert.equal(Object.isFrozen(moved.historicalRepositories), true);
		assert.equal(
			Object.isFrozen(moved.historicalRepositories["acme/widgets"]),
			true,
		);
		assert.deepEqual(
			platformSummary(moved).historicalRepositories,
			moved.historicalRepositories,
		);

		const invalid: JsonValue[] = [
			[],
			"acme/old-widgets",
			{ "acme/widgets": [] },
			{ "acme/widgets": "acme/old-widgets" },
			{ "not a slug": ["acme/old-widgets"] },
			{ "acme/widgets": ["not a slug"] },
			{ "acme/widgets": [7] },
			{ "acme/widgets": ["acme/widgets"] },
			{ "acme/widgets": ["acme/old", "acme/old"] },
			{ "acme/widgets": ["acme/old"], "acme/gears": ["acme/old"] },
			{ "acme/widgets": ["acme/gears"], "acme/gears": ["acme/old"] },
			// A former name is never an active repository.
			{ "acme/widgets": ["nublai/pi-herdr-factorio"] },
		];

		for (const historicalRepositories of invalid)
			assert.equal(
				refusal(undefined, exmachFile({ historicalRepositories })),
				"historical_repository_invalid",
				JSON.stringify(historicalRepositories),
			);
	});

	it("validates the built-in historical alias against the resolved repositories exactly as an explicit one", () => {
		const builtin: JsonValue = {
			"nublai/pi-herdr-factorio": ["giuseppecrj/pi-herdr-factorio"],
		};

		const colliding = [
			"nublai/pi-herdr-factorio",
			"giuseppecrj/pi-herdr-factorio",
		];

		for (const source of [file, exmachFile]) {
			const omitted = refusal(
				undefined,
				source({ version: 1, repositories: colliding }),
			);

			const explicit = refusal(
				undefined,
				source({
					version: 1,
					repositories: colliding,
					historicalRepositories: builtin,
				}),
			);

			assert.equal(explicit, "historical_repository_invalid");
			assert.equal(
				omitted,
				explicit,
				"omitting the map behaves as supplying it",
			);
		}

		// Without a collision, omitting and supplying the built-in map agree too.
		assert.deepEqual(
			resolved(undefined, file({ version: 1 })),
			resolved(
				undefined,
				file({ version: 1, historicalRepositories: builtin }),
			),
		);
		assert.deepEqual(
			resolved(undefined, file({ version: 1, repositories: ["acme/widgets"] }))
				.historicalRepositories,
			builtin,
		);
	});

	it("names a repository's former names for measurement and maps them back to its current name", () => {
		const history = EXE_DEV_PLATFORM.historicalRepositories;

		assert.deepEqual(
			measuredRepositories(history, "nublai/pi-herdr-factorio"),
			["nublai/pi-herdr-factorio", "giuseppecrj/pi-herdr-factorio"],
		);
		assert.deepEqual(measuredRepositories(history, "acme/widgets"), [
			"acme/widgets",
		]);
		assert.deepEqual(
			measuredRepositories(history, "giuseppecrj/pi-herdr-factorio"),
			["giuseppecrj/pi-herdr-factorio"],
			"a former name has no history of its own",
		);
		assert.deepEqual(measuredRepositories(history, "__proto__"), ["__proto__"]);
		assert.equal(
			currentRepository(history, "giuseppecrj/pi-herdr-factorio"),
			"nublai/pi-herdr-factorio",
		);
		assert.equal(
			currentRepository(history, "nublai/pi-herdr-factorio"),
			"nublai/pi-herdr-factorio",
		);
		assert.equal(currentRepository(history, "acme/widgets"), "acme/widgets");
	});

	it("refuses a partial identity override and any GitHub host that is not one label under int.<domain>", () => {
		const partials: { readonly [key: string]: JsonValue }[] = [
			{ controllerLogin: OVERRIDE_IDENTITY.controllerLogin },
			{ controllerAppSlug: OVERRIDE_IDENTITY.controllerAppSlug },
			{ botEmail: OVERRIDE_IDENTITY.botEmail },
			{
				controllerLogin: OVERRIDE_IDENTITY.controllerLogin,
				controllerAppSlug: OVERRIDE_IDENTITY.controllerAppSlug,
			},
			{
				controllerAppSlug: OVERRIDE_IDENTITY.controllerAppSlug,
				botEmail: OVERRIDE_IDENTITY.botEmail,
			},
		];

		for (const partial of partials) {
			assert.equal(
				refusal(undefined, exmachFile(partial)),
				"controller_identity_missing",
				JSON.stringify(partial),
			);
			assert.equal(
				refusal("exmach:example.net", file({ version: 1, ...partial })),
				"controller_identity_missing",
				JSON.stringify(partial),
			);
		}

		for (const ghHost of [
			"a.b.int.example.net",
			"factorio.int.other.net",
			"factorio.example.net",
			"factorio.int.example.net.evil.org",
			"-factorio.int.example.net",
			"factorio-.int.example.net",
			".int.example.net",
			"int.example.net",
			"",
			"Factorio.int.example.net",
			"factorio.int.example.net.",
			"factorio_1.int.example.net",
			`${"a".repeat(64)}.int.example.net`,
			"github.com",
		]) {
			assert.equal(
				refusal(undefined, exmachFile({ ghHost })),
				"gh_host_invalid",
				ghHost,
			);
		}

		for (const ghHost of [null, 7, ["factorio.int.example.net"]]) {
			assert.equal(
				refusal(undefined, exmachFile({ ghHost })),
				"gh_host_invalid",
				JSON.stringify(ghHost),
			);
		}

		assert.equal(
			refusal(undefined, file({ version: 1, ghHost: "github.int.exe.xyz" })),
			"gh_host_unexpected",
		);
		assert.equal(
			refusal(
				"exe-dev",
				file({
					version: 1,
					platform: "exe-dev",
					ghHost: "factorio.int.exe.xyz",
				}),
			),
			"gh_host_unexpected",
		);
	});

	it("refuses every malformed or contradictory source with a named reason and never falls back", () => {
		const cases: [string | undefined, PlatformFile, PlatformRefusal][] = [
			[
				"exmach:example.net",
				file({
					version: 1,
					controllerLogin: OVERRIDE_IDENTITY.controllerLogin,
					controllerAppSlug: OVERRIDE_IDENTITY.controllerAppSlug,
				}),
				"controller_identity_missing",
			],
			[
				undefined,
				exmachFile({ botEmail: null }),
				"controller_identity_invalid",
			],
			["exe-dev", exmachFile(), "platform_selection_mismatch"],
			["exmach:other.net", exmachFile(), "platform_selection_mismatch"],
			[
				undefined,
				file({ version: 1, ...OVERRIDE_IDENTITY }),
				"controller_identity_unexpected",
			],
			["aws", ABSENT, "unknown_platform"],
			["", ABSENT, "unknown_platform"],
			["EXE-DEV", ABSENT, "unknown_platform"],
			["exe-dev:exe.xyz", ABSENT, "unknown_platform"],
			["exmach:", ABSENT, "domain_invalid"],
			["exmach:Example.NET", ABSENT, "domain_invalid"],
			["exmach:example.net.", ABSENT, "domain_invalid"],
			["exmach:localhost", ABSENT, "domain_invalid"],
			["exmach:10.74.1.1", ABSENT, "domain_invalid"],
			[
				undefined,
				exmachFile({ platform: "exmach:bad_domain" }),
				"domain_invalid",
			],
			[undefined, { kind: "unreadable" }, "platform_file_unreadable"],
			[undefined, { kind: "present", text: "{" }, "platform_file_malformed"],
			[undefined, { kind: "present", text: "[]" }, "platform_file_malformed"],
			[
				undefined,
				{
					kind: "present",
					text: '{"version":1,"platform":"exe-dev","platform":"exmach:example.net"}',
				},
				"platform_file_malformed",
			],
			[undefined, exmachFile({ platform: 7 }), "platform_file_malformed"],
			[undefined, file({ platform: "exe-dev" }), "version_unsupported"],
			[undefined, exmachFile({ version: 2 }), "version_unsupported"],
			[
				undefined,
				exmachFile({ modelHost: "llm.int.evil.example" }),
				"unknown_field",
			],
			[undefined, exmachFile({ edgeAddress: "10.0.0.1" }), "unknown_field"],
			[undefined, exmachFile({ repositories: [] }), "repositories_empty"],
			[
				undefined,
				exmachFile({ repositories: ["not a slug"] }),
				"repository_invalid",
			],
			[
				undefined,
				exmachFile({ repositories: ["acme/widgets", "acme/widgets"] }),
				"repository_invalid",
			],
			[
				undefined,
				exmachFile({ repositories: "acme/widgets" }),
				"repository_invalid",
			],
			[
				undefined,
				exmachFile({ controllerLogin: "exmach-integration" }),
				"controller_identity_invalid",
			],
			[
				undefined,
				exmachFile({ controllerLogin: "Exmach-Integration[bot]" }),
				"controller_identity_invalid",
			],
			[
				undefined,
				exmachFile({ botEmail: "bot <evil@example.net>" }),
				"controller_identity_invalid",
			],
		];

		for (const [selector, source, reason] of cases) {
			assert.equal(
				refusal(selector, source),
				reason,
				`${selector} ${JSON.stringify(source)}`,
			);
		}
	});

	it("resolves through the injected env and reader, and reads the file at the edge", async () => {
		const result = await resolvePlatform({
			env: (name) =>
				name === "FACTORY_PLATFORM" ? "exmach:example.net" : "ignored",
			readFile: async () => ABSENT,
		});

		assert.ok(result.ok);
		assert.deepEqual(result.profile, EXMACH);

		const dir = privateDir("platform-file-");

		try {
			assert.deepEqual(await readPlatformFile(join(dir, "missing.json")), {
				kind: "absent",
			});
			assert.deepEqual(await readPlatformFile(dir), { kind: "unsafe" });
			writeFileSync(join(dir, "platform.json"), '{"version":1}');
			assert.deepEqual(await readPlatformFile(join(dir, "platform.json")), {
				kind: "present",
				text: '{"version":1}',
			});
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});
});

describe("forbidden domains", () => {
	it("refuses a resolved profile that leaves its own or its internal domain unforbidden", () => {
		for (const platform of [EXE_DEV_PLATFORM, EXMACH]) {
			assert.equal(platformDefect(platform), null);
			assert.equal(
				platformDefect(unforbidden(platform, platform.domain)),
				"own_domain_not_forbidden",
			);
			assert.equal(
				platformDefect(unforbidden(platform, `int.${platform.domain}`)),
				"internal_domain_not_forbidden",
			);
		}

		assert.equal(
			platformDefect({ ...EXMACH, edgeAddress: "10.0.0.1" }),
			"network_contract_mismatch",
		);
		assert.equal(
			platformDefect({ ...EXMACH, modelHost: "llm.example.net" }),
			"network_contract_mismatch",
		);
	});

	it("both parsers refuse everything under a profile missing either mandatory domain", () => {
		for (const platform of [EXE_DEV_PLATFORM, EXMACH]) {
			const table = roundTrip(tableFor(platform));

			assert.equal(parseRouteTable(table, "production", platform).ok, true);
			assert.equal(
				parseCeilings(ceilings("api.linear.app"), "production", platform).ok,
				true,
			);

			for (const drop of [platform.domain, `int.${platform.domain}`]) {
				const malformed = unforbidden(platform, drop);

				assert.equal(
					parseRouteTable(table, "production", malformed).ok,
					false,
					drop,
				);
				assert.equal(parseRouteTable(table, "test", malformed).ok, false, drop);
				assert.equal(
					parseCeilings(ceilings("api.linear.app"), "production", malformed).ok,
					false,
					drop,
				);
			}
		}
	});

	it("forbids the exmach domain and every name under it, on domain boundaries, in both parsers", () => {
		for (const host of [
			"example.net",
			"EXAMPLE.NET.",
			"int.example.net",
			"llm.int.example.net",
			"x.int.example.net",
			"github.int.example.net",
			"reflection.int.example.net",
			"github.com",
			"registry.npmjs.org",
			"localhost",
			"10.74.1.1",
		]) {
			assert.equal(isForbiddenUpstreamHost(host, EXMACH), true, host);
			assert.equal(
				parseCeilings(ceilings(host), "production", EXMACH).ok,
				false,
				host,
			);
			assert.equal(
				parseRouteTable(
					roundTrip({ ...tableFor(EXMACH), routes: [credentialed(host)] }),
					"production",
					EXMACH,
				).ok,
				false,
				host,
			);
		}

		for (const host of [
			"notexample.net",
			"example.network",
			"api.linear.app",
		]) {
			assert.equal(isForbiddenUpstreamHost(host, EXMACH), false, host);
			assert.equal(
				parseCeilings(ceilings(host), "production", EXMACH).ok,
				true,
				host,
			);
			assert.equal(
				parseRouteTable(
					roundTrip({ ...tableFor(EXMACH), routes: [credentialed(host)] }),
					"production",
					EXMACH,
				).ok,
				true,
				host,
			);
		}
	});
});

describe("exmach model routes", () => {
	it("routes OpenAI and Anthropic to llm.int.<domain> on the flat paths, pinned to the exmach edge", () => {
		const openai = tableFor(EXMACH, { fallback: "openai/gpt-6.1-terra" });
		const anthropic = tableFor(EXMACH, { provider: "anthropic" });
		const pinned = { kind: "pinned", ip: "10.74.1.1" };

		assert.deepEqual(
			openai.routes.map((route) => [route.id, route.prefix, route.upstream]),
			[
				[
					"model-openai",
					"/openai/v1/",
					{
						scheme: "https",
						host: "llm.int.example.net",
						port: 443,
						basePath: "/v1/",
						hostHeader: "llm.int.example.net",
						sni: "llm.int.example.net",
						address: pinned,
					},
				],
				[
					"npm",
					"/npm/",
					{
						scheme: "https",
						host: "registry.npmjs.org",
						port: 443,
						basePath: "/",
						hostHeader: "registry.npmjs.org",
						sni: "registry.npmjs.org",
						address: { kind: "resolve" },
					},
				],
			],
		);
		assert.deepEqual(anthropic.routes[0]?.upstream, {
			scheme: "https",
			host: "llm.int.example.net",
			port: 443,
			basePath: "/",
			hostHeader: "llm.int.example.net",
			sni: "llm.int.example.net",
			address: pinned,
		});

		assert.equal(
			upstreamPath(openai, head("POST", "/openai/v1/responses")),
			"model-openai:/v1/responses",
		);
		assert.equal(
			upstreamPath(anthropic, head("POST", "/anthropic/v1/messages?beta=true")),
			"model-anthropic:/v1/messages?beta=true",
		);
		assert.equal(
			upstreamPath(anthropic, head("POST", "/anthropic/v1/messages")),
			"model-anthropic:/v1/messages",
		);
		assert.equal(
			upstreamPath(
				anthropic,
				head("POST", "/anthropic/v1/messages?beta=false"),
			),
			"query-not-allowed",
		);
		assert.equal(
			upstreamPath(
				tableFor(EXE_DEV_PLATFORM, { provider: "anthropic" }),
				head("POST", "/anthropic/v1/messages?beta=true"),
			),
			"model-anthropic:/anthropic/v1/messages?beta=true",
		);

		const route = anthropic.routes[0];

		assert.ok(route !== undefined);
		assert.deepEqual(
			buildUpstreamHeaders(
				route,
				[
					"Host",
					"127.0.0.1:18080",
					"anthropic-version",
					"2023-06-01",
					"x-api-key",
					"sk-ant-client",
					"Authorization",
					"Bearer client",
				],
				0,
				null,
			).filter(([name]) =>
				["host", "anthropic-version", "x-api-key", "authorization"].includes(
					name.toLowerCase(),
				),
			),
			[
				["Host", "llm.int.example.net"],
				["anthropic-version", "2023-06-01"],
			],
		);

		for (const table of [openai, anthropic]) {
			assert.deepEqual(
				parseRouteTable(roundTrip(table), "production", EXMACH),
				{
					ok: true,
					table,
				},
			);
		}
	});

	it("refuses an exmach table whose host, pin, base path, Host header or SNI differs from the gateway's own platform", () => {
		const table = tableFor(EXMACH, { fallback: "openai/gpt-6.1-terra" });

		assert.equal(
			parseRouteTable(roundTrip(table), "production", EXE_DEV_PLATFORM).ok,
			false,
		);
		assert.equal(
			parseRouteTable(
				roundTrip(tableFor(EXE_DEV_PLATFORM)),
				"production",
				EXMACH,
			).ok,
			false,
		);
		assert.equal(
			parseRouteTable(
				roundTrip(
					tableFor(
						resolved(undefined, exmachFile({ platform: "exmach:other.net" })),
					),
				),
				"production",
				EXMACH,
			).ok,
			false,
		);

		const edits: ((upstream: Route["upstream"]) => Route["upstream"])[] = [
			(upstream) => ({ ...upstream, host: "llm.int.other.net" }),
			(upstream) => ({
				...upstream,
				address: { kind: "pinned", ip: "169.254.169.254" },
			}),
			(upstream) => ({ ...upstream, address: { kind: "resolve" } }),
			(upstream) => ({ ...upstream, basePath: "/openai/v1/" }),
			(upstream) => ({ ...upstream, hostHeader: "llm.int.exe.xyz" }),
			(upstream) => ({ ...upstream, sni: "llm.int.exe.xyz" }),
		];

		for (const edit of edits) {
			assert.equal(
				parseRouteTable(
					withRoute(table, (route) => ({
						...route,
						upstream: edit(route.upstream),
					})),
					"production",
					EXMACH,
				).ok,
				false,
			);
		}
	});

	it("a real gateway refuses a table built for another platform and an invalid --platform", async () => {
		const root = privateDir("platform-gw-");

		try {
			const mismatch = await startGatewayProcess({
				gatewayDir: join(root, "a"),
				auditPath: join(root, "a.jsonl"),
				table: tableFor(EXMACH),
				platform: EXE_DEV_PLATFORM,
				readyTimeoutMs: 10_000,
			});

			assert.deepEqual(mismatch, { ok: false, reason: "bad-table" });

			const matched = await startGatewayProcess({
				gatewayDir: join(root, "b"),
				auditPath: join(root, "b.jsonl"),
				table: tableFor(EXMACH),
				platform: EXMACH,
				readyTimeoutMs: 10_000,
			});

			assert.ok(matched.ok, matched.ok ? "" : matched.reason);
			await matched.handle.shutdown();

			for (const [platform, code] of [
				[["--platform", "exmach:Example.NET"], "bad-platform"],
				[["--platform", "exmach"], "bad-platform"],
				[[], "bad-arguments"],
			] as const) {
				const child = spawn(
					process.execPath,
					[
						new URL("../server/sandbox/gateway-main.ts", import.meta.url)
							.pathname,
						"--socket",
						join(root, "c.sock"),
						"--audit",
						join(root, "c.jsonl"),
						...platform,
					],
					{ stdio: ["pipe", "pipe", "ignore"], env: {} },
				);

				let out = "";

				child.stdout.on("data", (chunk: Buffer) => {
					out += chunk.toString();
				});

				const exited = new Promise<number | null>((done) =>
					child.on("exit", (status) => done(status)),
				);

				child.stdin.end(`${JSON.stringify(tableFor(EXMACH))}\n`);
				assert.equal(await exited, 2);
				assert.deepEqual(parseEvent(out.trim()), { event: "fatal", code });
			}
		} finally {
			rmSync(root, { recursive: true, force: true });
		}
	});

	it("refuses an xAI fallback under exmach in workflow validation and in route construction", () => {
		const text = workflowText(
			"stages:\n  review:\n    fallback_model: xai/grok-4.6",
		);

		assert.equal(parsed(text, EXE_DEV_PLATFORM).kind, "valid");
		assert.deepEqual(errorOf(text, EXMACH), {
			kind: "workflow_validation_error",
			field: "stages.review.fallback_model",
			message:
				"stages.review.fallback_model must be an openai model: the exmach platform has no xai route",
		});
		assert.deepEqual(
			errorOf(
				workflowText("stages:\n  build:\n    fallback_model: other/x"),
				EXE_DEV_PLATFORM,
			),
			{
				kind: "workflow_validation_error",
				field: "stages.build.fallback_model",
				message: "stages.build.fallback_model must be an openai or xai model",
			},
		);
		assert.throws(
			() => tableFor(EXMACH, { fallback: "xai/grok-4.6" }),
			/no xai route/,
		);
		assert.deepEqual(
			tableFor(EXE_DEV_PLATFORM, { fallback: "xai/grok-4.6" }).routes.map(
				(route) => route.id,
			),
			["model-openai", "model-xai", "npm"],
		);

		const smuggled = tableFor(EXMACH);
		const openai = smuggled.routes[0];

		assert.ok(openai !== undefined);
		assert.equal(
			parseRouteTable(
				roundTrip({
					...smuggled,
					routes: [
						...smuggled.routes,
						{ ...openai, id: routeIdOf("model-xai"), prefix: "/xai/v1/" },
					],
				}),
				"production",
				EXMACH,
			).ok,
			false,
		);
	});
});

describe("Anthropic positions", () => {
	it("keeps exe-dev's refusal text byte-identical and gives exmach its own", () => {
		const cases: [string, string][] = [
			[
				"stages:\n  build:\n    model: anthropic/claude-sonnet-5-5",
				"stages.build.model",
			],
			[
				"stages:\n  review:\n    fallback_model: anthropic/claude-sonnet-5-5",
				"stages.review.fallback_model",
			],
			[
				"stages:\n  specify:\n    model: anthropic/claude-sonnet-5-5",
				"stages.specify.model",
			],
		];

		for (const [lines, field] of cases) {
			assert.deepEqual(errorOf(workflowText(lines), EXE_DEV_PLATFORM), {
				kind: "workflow_validation_error",
				field,
				message: `${field} provider anthropic is allowed only for stages.accept.model and stages.review.seats.code-review.model: on the VM it spends exe.dev credits`,
			});
			assert.deepEqual(errorOf(workflowText(lines), EXMACH), {
				kind: "workflow_validation_error",
				field,
				message: `${field} provider anthropic is allowed only for stages.accept.model and stages.review.seats.code-review.model on the exmach platform`,
			});
		}

		for (const platform of [EXE_DEV_PLATFORM, EXMACH]) {
			assert.equal(
				parsed(
					workflowText(
						"stages:\n  accept:\n    model: anthropic/claude-sonnet-5-5\n  review:\n    seats:\n      code-review:\n        model: anthropic/claude-sonnet-5-5",
					),
					platform,
				).kind,
				"valid",
			);
		}
	});
});

describe("controller identity", () => {
	it("trusts the exmach login and never adopts a marker by the old exe-dev login", () => {
		const fresh = comment(
			"100",
			EXMACH.controllerLogin,
			EXMACH.controllerAppSlug,
		);

		const old = comment(
			"101",
			EXE_DEV_PLATFORM.controllerLogin,
			EXE_DEV_PLATFORM.controllerAppSlug,
		);

		const exmach = markerLedger({
			repo,
			issue: 14,
			comments: [fresh],
			edits: edits([fresh]),
			identity: EXMACH,
		});

		assert.equal(exmach.kind, "clean");
		assert.equal(exmach.kind === "clean" ? exmach.markers.length : -1, 1);

		const adopted = markerLedger({
			repo,
			issue: 14,
			comments: [old],
			edits: edits([old]),
			identity: EXMACH,
		});

		assert.deepEqual(adopted, { kind: "clean", markers: [], ignored: 1 });

		const wrongApp = comment(
			"102",
			EXMACH.controllerLogin,
			"exe-dev-github-integration",
		);

		assert.deepEqual(
			markerLedger({
				repo,
				issue: 14,
				comments: [wrongApp],
				edits: edits([wrongApp]),
				identity: EXMACH,
			}),
			{ kind: "corrupt", defect: "wrong_app", commentId: "102" },
		);

		const exeDev = markerLedger({
			repo,
			issue: 14,
			comments: [old],
			edits: edits([old]),
			identity: EXE_DEV_PLATFORM,
		});

		assert.equal(exeDev.kind === "clean" ? exeDev.markers.length : -1, 1);
	});

	it("checks the gh viewer against the selected profile's login", async () => {
		const viewer = (login: string) =>
			new GitHubTicketAdapter({
				repo,
				exec: async () => ({
					code: 0,
					stdout: JSON.stringify({ data: { viewer: { login } } }),
					stderr: "",
				}),
			});

		assert.deepEqual(
			await checkIdentity(
				viewer(EXMACH.controllerLogin),
				EXMACH.controllerLogin,
			),
			{ kind: "ok" },
		);
		assert.deepEqual(
			await checkIdentity(
				viewer(EXE_DEV_PLATFORM.controllerLogin),
				EXMACH.controllerLogin,
			),
			{ kind: "mismatch" },
		);
	});
});

describe("CLI platform resolution", () => {
	const workflow = workflowText(
		"stages:\n  review:\n    fallback_model: xai/grok-4.6",
	);

	it("status --json reports one deterministic platform, identical unset and explicit exe-dev", async () => {
		const unset = await cli(["status", "--json", "--repo", repo], { workflow });

		const explicit = await cli(["status", "--json", "--repo", repo], {
			workflow,
			env: { FACTORY_PLATFORM: "exe-dev" },
		});

		const fromFile = await cli(["status", "--json", "--repo", repo], {
			workflow,
			file: file({ version: 1, platform: "exe-dev" }),
		});

		assert.equal(unset.code, EXIT.ok, unset.stderr);

		const platform = JSON.parse(unset.stdout).platform;

		assert.deepEqual(JSON.parse(explicit.stdout).platform, platform);
		assert.deepEqual(JSON.parse(fromFile.stdout).platform, platform);
		assert.deepEqual(
			platform,
			JSON.parse(JSON.stringify(platformSummary(EXE_DEV_PLATFORM))),
		);
		assert.equal(platform.name, "exe-dev");
		assert.equal(platform.descriptor, "exe-dev");
		assert.match(platform.digest, /^[a-f0-9]{64}$/);

		const exmach = await cli(["status", "--json", "--repo", repo], {
			workflow,
			file: exmachFile(),
		});

		const reported = JSON.parse(exmach.stdout);

		assert.equal(reported.platform.name, "exmach");
		assert.equal(reported.platform.modelHost, "llm.int.example.net");
		assert.equal(reported.platform.descriptor, "exmach:example.net");
		assert.notEqual(reported.platform.digest, platform.digest);
		assert.equal(reported.workflow, "invalid");
		assert.match(
			JSON.stringify(reported),
			/the exmach platform has no xai route/,
		);
	});

	it("workflow-check and admit parse with the selected platform", async () => {
		const exeDev = await cli(["workflow-check", "--json", "--repo", repo], {
			workflow,
		});

		assert.equal(exeDev.code, EXIT.ok, exeDev.stdout);

		const exmach = await cli(["workflow-check", "--json", "--repo", repo], {
			workflow,
			file: exmachFile(),
		});

		assert.equal(exmach.code, EXIT.invalid);
		assert.equal(
			JSON.parse(exmach.stdout).error.field,
			"stages.review.fallback_model",
		);

		const dir = privateDir("platform-admit-");

		try {
			const admit = await cli(
				[
					"admit",
					"--json",
					"--repo",
					repo,
					"--issue",
					"14",
					"--state-dir",
					dir,
				],
				{ workflow, file: exmachFile({ repositories: ["acme/widgets"] }) },
			);

			assert.equal(admit.code, EXIT.invalid);
			assert.deepEqual(JSON.parse(admit.stdout).reasons, [
				{ kind: "repo_not_allowed" },
			]);
			assert.deepEqual(admit.calls, []);
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});

	it("every command refuses an invalid platform with exit 2 before any lock, GitHub call or stage", async () => {
		const sources: [
			string,
			{ env?: { [name: string]: string }; file?: PlatformFile },
		][] = [
			[
				"controller_identity_missing",
				{
					env: { FACTORY_PLATFORM: "exmach:example.net" },
					file: exmachFile({ controllerLogin: "other-agent[bot]" }),
				},
			],
			[
				"platform_selection_mismatch",
				{ env: { FACTORY_PLATFORM: "exe-dev" }, file: exmachFile() },
			],
			["platform_file_malformed", { file: { kind: "present", text: "{" } }],
			["platform_file_unreadable", { file: { kind: "unreadable" } }],
			[
				"unknown_field",
				{ file: exmachFile({ modelHost: "llm.int.evil.example" }) },
			],
			["gh_host_invalid", { file: exmachFile({ ghHost: "github.com" }) }],
			["repositories_empty", { file: exmachFile({ repositories: [] }) }],
			["unknown_platform", { env: { FACTORY_PLATFORM: "exmach" } }],
		];

		const dir = privateDir("platform-invalid-");
		const run = "a".repeat(64);

		const commands = [
			["tick", "--once", "--json", "--repo", repo, "--state-dir", dir],
			["run", "--json", "--repo", repo, "--issue", "14", "--state-dir", dir],
			["serve", "--repo", repo, "--state-dir", dir],
			[
				"cadence",
				"--once",
				"--job",
				"architecture",
				"--json",
				"--repo",
				repo,
				"--state-dir",
				dir,
			],
			["score", "--run", run, "--repo", repo, "--state-dir", dir, "--json"],
			["explain", "--run", run, "--repo", repo, "--state-dir", dir, "--json"],
			["status", "--json", "--repo", repo, "--state-dir", dir],
			["workflow-check", "--json", "--repo", repo],
			["admit", "--json", "--repo", repo, "--issue", "14", "--state-dir", dir],
			["owner-feed", "--json", "--state-dir", dir],
			["metrics", "--json", "--repo", repo],
			["replay", "check", "--json"],
			["viewer", "--state-dir", dir],
			["gates", "--repository", dir],
		];

		try {
			for (const [reason, source] of sources) {
				for (const argv of commands) {
					const result = await cli(argv, { ...source, workflow });
					const label = `${reason} ${argv.join(" ")}`;

					assert.equal(result.code, EXIT.usage, label);
					assert.match(
						result.stderr,
						new RegExp(`event=platform_invalid reason=${reason}\\n$`),
						label,
					);
					assert.equal(result.stdout, "", label);
					assert.deepEqual(result.calls, [], label);
					assert.deepEqual(readdirSync(dir), [], label);
				}
			}
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});

	it("tick, run, serve and cadence refuse a GH_HOST that is not the profile's before the lock", async () => {
		const dir = privateDir("platform-gh-host-");

		try {
			for (const [env, source] of [
				[{}, ABSENT],
				[{ GH_HOST: "github.com" }, ABSENT],
				[{ GH_HOST: "github.int.exe.xyz" }, exmachFile()],
			] as const) {
				for (const argv of [
					["tick", "--once", "--json", "--repo", repo, "--state-dir", dir],
					[
						"run",
						"--json",
						"--repo",
						repo,
						"--issue",
						"14",
						"--state-dir",
						dir,
					],
					["serve", "--repo", repo, "--state-dir", dir],
					[
						"cadence",
						"--once",
						"--job",
						"architecture",
						"--json",
						"--repo",
						repo,
						"--state-dir",
						dir,
					],
				]) {
					const result = await cli(argv, { env, file: source });

					assert.equal(result.code, EXIT.invalid, result.stderr);
					assert.match(
						result.stderr,
						/event=controller_refused reason=gh_host_mismatch\n$/,
					);
					assert.deepEqual(result.calls, []);
					assert.deepEqual(readdirSync(dir), []);
				}
			}
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});

	it("status shows the running controller's recorded platform beside the CLI's selection", async () => {
		const dir = privateDir("platform-status-");

		try {
			assert.equal(await writeStatus(dir, REPORT, EXMACH), true);

			const stored = await readStatus(dir);

			assert.deepEqual(
				stored !== null && !Array.isArray(stored) && stored instanceof Object
					? stored.platform
					: null,
				JSON.parse(JSON.stringify(platformSummary(EXMACH))),
			);

			const status = await cli(
				["status", "--json", "--repo", repo, "--state-dir", dir],
				{
					workflow,
				},
			);

			const report = JSON.parse(status.stdout);

			assert.equal(report.platform.name, "exe-dev");
			assert.equal(report.controller.lastTick.platform.name, "exmach");
			assert.notEqual(
				report.controller.lastTick.platform.digest,
				report.platform.digest,
			);
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});
});

describe("platform propagation", () => {
	it("pins recovered policy with the controller's platform", async () => {
		const archive = privateDir("platform-archive-");
		const tree = join(archive, "repo", ".github", "factory");

		const text = workflowText(
			"stages:\n  review:\n    fallback_model: xai/grok-4.6",
		);

		mkdirSync(join(tree, "gates"), { recursive: true });
		writeFileSync(join(tree, "WORKFLOW.md"), text);
		writeFileSync(join(tree, "gates", "ci.sh"), "echo trusted\n");

		const bytes = execFileSync("tar", ["-czf", "-", "-C", archive, "repo"]);
		const dirs: string[] = [archive];

		try {
			for (const [platform, expected] of [
				[EXE_DEV_PLATFORM, true],
				[EXMACH, false],
			] as const) {
				const dir = privateDir("platform-recover-");

				dirs.push(dir);

				const files = fileRunFiles(dir, { platform, fetch: async () => bytes });

				assert.equal(
					await files.prepareRun?.({
						runId,
						repo,
						workflowSha: mainSha,
						workflowDigest: digestOf(text),
						startedAt: "2026-11-10T12:00:00.000Z",
						runTokenCap: 500_000,
					}),
					expected,
					platform.name,
				);
			}
		} finally {
			for (const dir of dirs) rmSync(dir, { recursive: true, force: true });
		}
	});

	it("the extension parses with its resolved platform and reports a refused one", async () => {
		const text = workflowText(
			"stages:\n  review:\n    fallback_model: xai/grok-4.6",
		);

		const exec: Exec = async (command, args) =>
			command === "git"
				? {
						code: 0,
						stdout: `https://github.com/${repo}.git\n`,
						stderr: "",
					}
				: args.includes("--jq")
					? { code: 0, stdout: `${mainSha}\n`, stderr: "" }
					: { code: 0, stdout: text, stderr: "" };

		const env = (name: string) =>
			name === "HOME" ? "/home/factory" : undefined;

		assert.doesNotMatch(
			await factoryCommandText("status", {
				exec,
				env,
				platform: EXE_DEV_PLATFORM,
			}),
			/workflow +unavailable/,
		);
		assert.match(
			await factoryCommandText("status", { exec, env, platform: EXMACH }),
			/the exmach platform has no xai route/,
		);

		const sent: string[] = [];
		let handler: ((args: string) => Promise<void>) | undefined;

		registerFactory(
			{
				registerCommand: (_name, options) => {
					// SAFETY: the factory handler reads only `cwd` from its context.
					const ctx = { cwd: "/work" } as Parameters<typeof options.handler>[1];

					handler = (args) => options.handler(args, ctx);
				},
				sendMessage: (message) => {
					sent.push(String(message.content));
				},
				exec: async () => {
					throw new Error("no command runs under a refused platform");
				},
			},
			Promise.resolve({ ok: false, reason: "controller_identity_missing" }),
		);

		await handler?.("status");

		assert.deepEqual(sent, [
			"platform    unavailable: platform_invalid reason=controller_identity_missing",
		]);
	});

	it("reserveReplay uses the profile's only repository and refuses an ambiguous allowlist", async () => {
		const dir = privateDir("platform-replay-");
		const path = join(dir, "budget.json");
		const text = `---\nrepository: ${repo}\nreplay:\n  max_tokens: 1650000\n---\n`;

		try {
			writeFileSync(
				path,
				JSON.stringify({ v: 1, maxTokens: 1100000, reservations: [] }),
			);

			const two = resolved(
				undefined,
				file({ version: 1, repositories: [repo, "acme/widgets"] }),
			);

			await assert.rejects(
				reserveReplay(path, 1650000, "next", two, {
					mainSha,
					workflowText: text,
				}),
				/replay_repository_ambiguous/,
			);
			await reserveReplay(path, 1650000, "next", EXE_DEV_PLATFORM, {
				mainSha,
				workflowText: text,
			});
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});
});

describe("selection file safety", () => {
	const tick = (state: string) => [
		"tick",
		"--once",
		"--json",
		"--repo",
		repo,
		"--state-dir",
		state,
	];

	async function refusedAtStartup(
		result: Promise<CliRun>,
		state: string,
		reason: PlatformRefusal,
		label: string,
	): Promise<void> {
		const run = await result;

		assert.equal(run.code, EXIT.usage, `${label}: ${run.stderr}`);
		assert.match(
			run.stderr,
			new RegExp(`event=platform_invalid reason=${reason}\\n$`),
			label,
		);
		assert.deepEqual(run.calls, [], label);
		assert.deepEqual(readdirSync(state), [], label);
	}

	it("refuses a symlinked, dangling or non-regular selection file before any lock or gh, and never falls back to exe-dev", async () => {
		const dir = privateDir("platform-unsafe-");
		const state = privateDir("platform-unsafe-state-");

		try {
			const target = join(dir, "target.json");

			writeFileSync(
				target,
				JSON.stringify({ version: 1, platform: "exmach:example.net" }),
			);
			symlinkSync(target, join(dir, "live.json"));
			symlinkSync(join(dir, "missing.json"), join(dir, "dangling.json"));

			for (const [path, ghHost] of [
				[join(dir, "live.json"), "factorio.int.example.net"],
				[join(dir, "dangling.json"), "github.int.exe.xyz"],
				[dir, "github.int.exe.xyz"],
				["/dev/null", "github.int.exe.xyz"],
			] as const) {
				await refusedAtStartup(
					cli(tick(state), {
						env: { GH_HOST: ghHost },
						reader: () => readPlatformFile(path),
					}),
					state,
					"platform_file_unsafe",
					path,
				);
				assert.deepEqual(
					await readPlatformFile(path),
					{ kind: "unsafe" },
					path,
				);
			}

			assert.deepEqual(await readPlatformFile(join(dir, "missing.json")), {
				kind: "absent",
			});
			assert.equal(
				refusal(undefined, await readPlatformFile(target)),
				null,
				"the regular file itself is accepted",
			);

			const oversized = join(dir, "oversized.json");

			writeFileSync(oversized, `{"version":1}${" ".repeat(16 * 1024)}`);
			assert.deepEqual(await readPlatformFile(oversized), {
				kind: "oversized",
			});
			await refusedAtStartup(
				cli(tick(state), {
					env: { GH_HOST: "github.int.exe.xyz" },
					reader: () => readPlatformFile(oversized),
				}),
				state,
				"platform_file_malformed",
				oversized,
			);
		} finally {
			rmSync(dir, { recursive: true, force: true });
			rmSync(state, { recursive: true, force: true });
		}
	});

	it("refuses a value of the wrong JSON type with its named reason and never coerces it", async () => {
		const object = { toString: 0 };
		const state = privateDir("platform-nonstring-");

		const cases: [PlatformFile, PlatformRefusal][] = [
			[file({ version: 1, platform: object }), "platform_file_malformed"],
			[file({ version: 1, platform: ["exe-dev"] }), "platform_file_malformed"],
			[file({ version: object }), "version_unsupported"],
			[file({ version: "1" }), "version_unsupported"],
			[exmachFile({ controllerLogin: object }), "controller_identity_invalid"],
			[
				exmachFile({ controllerAppSlug: object }),
				"controller_identity_invalid",
			],
			[exmachFile({ botEmail: object }), "controller_identity_invalid"],
			[
				exmachFile({ controllerLogin: [OVERRIDE_IDENTITY.controllerLogin] }),
				"controller_identity_invalid",
			],
			[exmachFile({ repositories: [object] }), "repository_invalid"],
			[exmachFile({ repositories: [[repo]] }), "repository_invalid"],
			[exmachFile({ repositories: object }), "repository_invalid"],
			[exmachFile({ ghHost: object }), "gh_host_invalid"],
			[exmachFile({ ghHost: ["github.int.example.net"] }), "gh_host_invalid"],
		];

		try {
			for (const [source, reason] of cases) {
				const label = JSON.stringify(source);

				assert.equal(refusal(undefined, source), reason, label);
				await refusedAtStartup(
					cli(tick(state), {
						env: { GH_HOST: "factorio.int.example.net" },
						file: source,
					}),
					state,
					reason,
					label,
				);
			}
		} finally {
			rmSync(state, { recursive: true, force: true });
		}
	});

	it("refuses a GitHub host over 253 characters even when each label is valid", async () => {
		const domain = ["a", "b", "c"]
			.map((letter) => letter.repeat(63))
			.concat("d".repeat(48))
			.join(".");

		const selector = `exmach:${domain}`;
		const overlong = `${"z".repeat(63)}.int.${domain}`;
		const oneOver = `githubxyz.int.${domain}`;
		const state = privateDir("platform-overlong-");

		try {
			assert.equal(domain.length, 240);
			assert.equal(oneOver.length, 254);
			assert.equal(resolved(selector, ABSENT).ghHost.length, 253);
			assert.equal(
				resolved(selector, file({ version: 1, ghHost: `github.int.${domain}` }))
					.ghHost,
				`github.int.${domain}`,
			);

			for (const ghHost of [overlong, oneOver]) {
				const source = file({ version: 1, ghHost });

				assert.equal(refusal(selector, source), "gh_host_invalid", ghHost);
				await refusedAtStartup(
					cli(tick(state), {
						env: { FACTORY_PLATFORM: selector, GH_HOST: ghHost },
						file: source,
					}),
					state,
					"gh_host_invalid",
					ghHost,
				);
			}

			assert.equal(refusal(`exmach:x${domain}`, ABSENT), "domain_invalid");
		} finally {
			rmSync(state, { recursive: true, force: true });
		}
	});
});

describe("CLI fixtures", () => {
	it("read no host selection file", async () => {
		assert.deepEqual(await noPlatformFile(), { kind: "absent" });
	});
});
