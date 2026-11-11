import { lstat, readFile } from "node:fs/promises";
import { isIP } from "node:net";
import {
	arrayOf,
	fieldOf,
	hasDuplicateKey,
	hasOnlyKeys,
	objectOf,
	parseJson,
	textOf,
} from "../server/sandbox/json.ts";
import { type Digest, digestOf } from "./run.ts";

export type RepoSlug = string & { readonly __brand: "RepoSlug" };

const REPO_SLUG = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/;

export function isRepoSlug(input: string): input is RepoSlug {
	return (
		REPO_SLUG.test(input) &&
		input.split("/").every((segment) => segment !== "." && segment !== "..")
	);
}

/** The optional root-owned selection file. Its only host is an exmach `ghHost` label; it never holds upstreams, addresses, paths or provider permissions. */
export const PLATFORM_FILE = "/etc/factory/platform.json";

export const PLATFORM_NAMES = ["exe-dev", "exmach"] as const;

export type PlatformName = (typeof PLATFORM_NAMES)[number];

/** Every place a workflow names a primary model. */
export const MODEL_POSITIONS = [
	"specify",
	"accept",
	"build",
	"validate",
	"review",
	"code-review",
	"cadence",
] as const;

export type ModelPosition = (typeof MODEL_POSITIONS)[number];

export type PlatformSelector =
	| { readonly name: "exe-dev" }
	| { readonly name: "exmach"; readonly domain: string };

/** The egress contract the gateway rebuilds from a selector alone. */
export type PlatformNetwork = {
	readonly name: PlatformName;
	readonly domain: string;
	readonly modelHost: string;
	readonly edgeAddress: string;
	readonly modelBasePaths: {
		readonly openai: string;
		readonly anthropic: string;
		readonly xai: string | null;
	};
	readonly forbiddenDomains: readonly string[];
};

export type ControllerIdentity = {
	readonly controllerLogin: string;
	readonly controllerAppSlug: string;
	readonly botEmail: string;
};

/**
 * Former names of a repository, keyed by its current name. Read-only
 * history: metrics and replay use it to keep counting frozen rows recorded
 * under a former name. Marker trust, admission, claims, dispatch and
 * publication never read it.
 */
export type HistoricalRepositories = Readonly<
	Record<string, readonly RepoSlug[]>
>;

export type PlatformProfile = PlatformNetwork &
	ControllerIdentity & {
		readonly ghHost: string;
		readonly repositories: readonly RepoSlug[];
		readonly historicalRepositories: HistoricalRepositories;
		readonly anthropicStages: readonly ModelPosition[];
	};

export const PLATFORM_REFUSALS = [
	"unknown_platform",
	"domain_invalid",
	"platform_selection_mismatch",
	"platform_file_unreadable",
	"platform_file_unsafe",
	"platform_file_malformed",
	"version_unsupported",
	"unknown_field",
	"controller_identity_missing",
	"controller_identity_invalid",
	"controller_identity_unexpected",
	"repositories_empty",
	"repository_invalid",
	"historical_repository_invalid",
	"gh_host_invalid",
	"gh_host_unexpected",
	"own_domain_not_forbidden",
	"internal_domain_not_forbidden",
	"network_contract_mismatch",
] as const;

export type PlatformRefusal = (typeof PLATFORM_REFUSALS)[number];

export type PlatformResolution =
	| { readonly ok: true; readonly profile: PlatformProfile }
	| { readonly ok: false; readonly reason: PlatformRefusal };

export type PlatformFile =
	| { readonly kind: "absent" }
	| { readonly kind: "present"; readonly text: string }
	| { readonly kind: "unreadable" }
	| { readonly kind: "unsafe" }
	| { readonly kind: "oversized" };

type Parsed<T> =
	| { readonly ok: true; readonly value: T }
	| { readonly ok: false; readonly reason: PlatformRefusal };

const GITHUB_DOMAINS = ["github.com", "githubusercontent.com", "ghe.com"];

const FILE_KEYS = [
	"version",
	"platform",
	"controllerLogin",
	"controllerAppSlug",
	"botEmail",
	"repositories",
	"historicalRepositories",
	"ghHost",
] as const;

const MAX_FILE_BYTES = 16 * 1024;

const DOMAIN =
	/^(?=.{1,240}$)[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?(\.[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?)+$/;

const DNS_LABEL = /^[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?$/;

const LOGIN_PATTERN = /^[a-z0-9][a-z0-9-]{0,98}\[bot\]$/;

const SLUG_PATTERN = /^[a-z0-9][a-z0-9-]{0,98}$/;

const EMAIL_PATTERN = /^[A-Za-z0-9+._[\]-]{1,128}@[a-z0-9.-]{1,128}$/;

const EXE_DEV_IDENTITY: ControllerIdentity = Object.freeze({
	controllerLogin: "exe-dev-github-integration[bot]",
	controllerAppSlug: "exe-dev-github-integration",
	botEmail:
		"267204973+exe-dev-github-integration[bot]@users.noreply.github.com",
});

const EXMACH_IDENTITY: ControllerIdentity = Object.freeze({
	controllerLogin: "nubl-agent[bot]",
	controllerAppSlug: "nubl-agent",
	botEmail: "353429311+nubl-agent[bot]@users.noreply.github.com",
});

const DEFAULT_REPOSITORIES: readonly RepoSlug[] = Object.freeze(
	["nublai/pi-herdr-factorio"].filter(isRepoSlug),
);

/** The repository moved from giuseppecrj to nublai on 2026-11-10. */
const DEFAULT_HISTORICAL_REPOSITORIES: HistoricalRepositories = Object.freeze({
	"nublai/pi-herdr-factorio": Object.freeze(
		["giuseppecrj/pi-herdr-factorio"].filter(isRepoSlug),
	),
});

const ANTHROPIC_STAGES: readonly ModelPosition[] = Object.freeze([
	"accept",
	"code-review",
]);

/** A whole DNS hostname: at most 253 characters, each label at most 63. */
function isHostname(text: string): boolean {
	return (
		text.length <= 253 &&
		text.split(".").every((label) => DNS_LABEL.test(label))
	);
}

function isPlatformDomain(text: string): boolean {
	return (
		DOMAIN.test(text) &&
		isHostname(text) &&
		isIP(text) === 0 &&
		!/^[0-9.]+$/.test(text)
	);
}

/**
 * The value when it is a JSON string. An object or array is refused before
 * any conversion, so no value's own `toString` ever runs.
 */
function stringOf(value: ReturnType<typeof fieldOf>): string | null {
	return objectOf(value) === null && arrayOf(value) === null
		? textOf(value)
		: null;
}

/** The built-in egress contract for one selector. Nothing outside this function chooses an upstream. */
export function platformNetwork(selector: PlatformSelector): PlatformNetwork {
	switch (selector.name) {
		case "exe-dev":
			return Object.freeze({
				name: "exe-dev",
				domain: "exe.xyz",
				modelHost: "llm.int.exe.xyz",
				edgeAddress: "169.254.169.254",
				modelBasePaths: Object.freeze({
					openai: "/openai/v1/",
					anthropic: "/anthropic/",
					xai: "/xai/v1/",
				}),
				forbiddenDomains: Object.freeze([
					"exe.xyz",
					"int.exe.xyz",
					...GITHUB_DOMAINS,
				]),
			});
		case "exmach":
			return Object.freeze({
				name: "exmach",
				domain: selector.domain,
				modelHost: `llm.int.${selector.domain}`,
				edgeAddress: "10.74.1.1",
				modelBasePaths: Object.freeze({
					openai: "/v1/",
					anthropic: "/",
					xai: null,
				}),
				forbiddenDomains: Object.freeze([
					selector.domain,
					`int.${selector.domain}`,
					...GITHUB_DOMAINS,
				]),
			});
		default: {
			const _exhaustive: never = selector;

			return _exhaustive;
		}
	}
}

/** The canonical `--platform` and `FACTORY_PLATFORM` spelling of a selection. */
export function platformDescriptor(
	network: Pick<PlatformNetwork, "name" | "domain">,
): string {
	return network.name === "exe-dev" ? "exe-dev" : `exmach:${network.domain}`;
}

/** Reads `exe-dev` or `exmach:<domain>`. Only the canonical lowercase spelling parses. */
export function parsePlatformSelector(text: string): Parsed<PlatformSelector> {
	if (text === "exe-dev") return { ok: true, value: { name: "exe-dev" } };

	if (!text.startsWith("exmach:"))
		return { ok: false, reason: "unknown_platform" };

	const domain = text.slice("exmach:".length);

	if (!isPlatformDomain(domain)) return { ok: false, reason: "domain_invalid" };

	const value: PlatformSelector = { name: "exmach", domain };

	return isHostname(platformNetwork(value).modelHost)
		? { ok: true, value }
		: { ok: false, reason: "domain_invalid" };
}

/**
 * Why a resolved network is not its selector's built-in contract, or `null`.
 * The route and ceiling parsers call it too, so a malformed profile cannot
 * reach them with its own domain unforbidden.
 */
export function platformDefect(
	network: PlatformNetwork,
): PlatformRefusal | null {
	if (!network.forbiddenDomains.includes(network.domain)) {
		return "own_domain_not_forbidden";
	}

	if (!network.forbiddenDomains.includes(`int.${network.domain}`)) {
		return "internal_domain_not_forbidden";
	}

	const selector = parsePlatformSelector(platformDescriptor(network));

	if (!selector.ok) return selector.reason;

	const builtin = platformNetwork(selector.value);

	return networkText(builtin) === networkText(network)
		? null
		: "network_contract_mismatch";
}

function networkText(network: PlatformNetwork): string {
	return JSON.stringify([
		network.name,
		network.domain,
		network.modelHost,
		network.edgeAddress,
		network.modelBasePaths.openai,
		network.modelBasePaths.anthropic,
		network.modelBasePaths.xai,
		network.forbiddenDomains,
	]);
}

type FileSelection = {
	readonly selector: PlatformSelector | null;
	readonly login: string | null;
	readonly appSlug: string | null;
	readonly email: string | null;
	readonly repositories: readonly RepoSlug[] | null;
	readonly historicalRepositories: HistoricalRepositories | null;
	readonly ghHost: string | null;
};

function optionalText(
	value: ReturnType<typeof fieldOf>,
	valid: RegExp,
): Parsed<string | null> {
	if (value === undefined) return { ok: true, value: null };

	const text = stringOf(value);

	return text !== null && valid.test(text)
		? { ok: true, value: text }
		: { ok: false, reason: "controller_identity_invalid" };
}

function readRepositories(
	value: ReturnType<typeof fieldOf>,
): Parsed<readonly RepoSlug[] | null> {
	if (value === undefined) return { ok: true, value: null };

	const items = arrayOf(value);

	if (items === null) return { ok: false, reason: "repository_invalid" };

	if (items.length === 0) return { ok: false, reason: "repositories_empty" };

	const repositories: RepoSlug[] = [];

	for (const item of items) {
		const text = stringOf(item);

		if (text === null || !isRepoSlug(text) || repositories.includes(text)) {
			return { ok: false, reason: "repository_invalid" };
		}

		repositories.push(text);
	}

	return { ok: true, value: Object.freeze(repositories) };
}

/**
 * Reads `{ "<current>": ["<former>", ...] }`. Every name is a distinct
 * repository slug, each list is non-empty, and a former name is never a
 * current name or listed twice. `aliasesActive` checks the resolved map.
 */
function readHistoricalRepositories(
	value: ReturnType<typeof fieldOf>,
): Parsed<HistoricalRepositories | null> {
	if (value === undefined) return { ok: true, value: null };

	const invalid = {
		ok: false,
		reason: "historical_repository_invalid",
	} as const;

	const root = objectOf(value);

	if (root === null) return invalid;

	const current = Object.keys(root);
	const seen: RepoSlug[] = [];
	const result: Record<string, readonly RepoSlug[]> = {};

	for (const name of current) {
		const items = arrayOf(fieldOf(root, name));

		if (!isRepoSlug(name) || items === null || items.length === 0)
			return invalid;

		const former: RepoSlug[] = [];

		for (const item of items) {
			const text = stringOf(item);

			if (
				text === null ||
				!isRepoSlug(text) ||
				current.includes(text) ||
				seen.includes(text)
			)
				return invalid;

			seen.push(text);
			former.push(text);
		}

		result[name] = Object.freeze(former);
	}

	return { ok: true, value: Object.freeze(result) };
}

/**
 * A former name is never an active repository, whether the map came from the
 * file or is the built-in default.
 */
function aliasesActive(
	history: HistoricalRepositories,
	active: readonly RepoSlug[],
): boolean {
	return Object.values(history).some((former) =>
		former.some((name) => active.includes(name)),
	);
}

function parsePlatformFile(text: string): Parsed<FileSelection> {
	const root =
		text.length > MAX_FILE_BYTES || hasDuplicateKey(text)
			? null
			: objectOf(parseJson(text));

	if (root === null) return { ok: false, reason: "platform_file_malformed" };

	if (fieldOf(root, "version") !== 1) {
		return { ok: false, reason: "version_unsupported" };
	}

	if (!hasOnlyKeys(root, FILE_KEYS))
		return { ok: false, reason: "unknown_field" };

	const platformValue = fieldOf(root, "platform");
	const platformText = stringOf(platformValue);

	if (platformValue !== undefined && platformText === null) {
		return { ok: false, reason: "platform_file_malformed" };
	}

	const selector =
		platformText === null ? null : parsePlatformSelector(platformText);

	if (selector !== null && !selector.ok) return selector;

	const login = optionalText(fieldOf(root, "controllerLogin"), LOGIN_PATTERN);

	const appSlug = optionalText(
		fieldOf(root, "controllerAppSlug"),
		SLUG_PATTERN,
	);

	const email = optionalText(fieldOf(root, "botEmail"), EMAIL_PATTERN);
	const repositories = readRepositories(fieldOf(root, "repositories"));
	const ghHostValue = fieldOf(root, "ghHost");
	const ghHost = ghHostValue === undefined ? null : stringOf(ghHostValue);

	if (!login.ok) return login;

	if (!appSlug.ok) return appSlug;

	if (!email.ok) return email;

	if (!repositories.ok) return repositories;

	const historicalRepositories = readHistoricalRepositories(
		fieldOf(root, "historicalRepositories"),
	);

	if (!historicalRepositories.ok) return historicalRepositories;

	if (ghHostValue !== undefined && ghHost === null) {
		return { ok: false, reason: "gh_host_invalid" };
	}

	return {
		ok: true,
		value: {
			selector: selector === null ? null : selector.value,
			login: login.value,
			appSlug: appSlug.value,
			email: email.value,
			repositories: repositories.value,
			historicalRepositories: historicalRepositories.value,
			ghHost,
		},
	};
}

function identityOf(
	selector: PlatformSelector,
	file: FileSelection | null,
): Parsed<ControllerIdentity> {
	const given = [
		file?.login ?? null,
		file?.appSlug ?? null,
		file?.email ?? null,
	];

	if (given.every((value) => value === null)) {
		return {
			ok: true,
			value: selector.name === "exe-dev" ? EXE_DEV_IDENTITY : EXMACH_IDENTITY,
		};
	}

	if (selector.name === "exe-dev") {
		return { ok: false, reason: "controller_identity_unexpected" };
	}

	const [controllerLogin, controllerAppSlug, botEmail] = given;

	if (
		controllerLogin === null ||
		controllerLogin === undefined ||
		controllerAppSlug === null ||
		controllerAppSlug === undefined ||
		botEmail === null ||
		botEmail === undefined
	) {
		return { ok: false, reason: "controller_identity_missing" };
	}

	return {
		ok: true,
		value: Object.freeze({ controllerLogin, controllerAppSlug, botEmail }),
	};
}

/**
 * The controller's `GH_HOST`. exe-dev's is fixed. exmach defaults to
 * `factorio.int.<domain>`, and the file may name exactly one other DNS label
 * under `int.<domain>`.
 */
function ghHostOf(
	selector: PlatformSelector,
	override: string | null,
): Parsed<string> {
	switch (selector.name) {
		case "exe-dev":
			return override === null
				? { ok: true, value: "github.int.exe.xyz" }
				: { ok: false, reason: "gh_host_unexpected" };
		case "exmach": {
			const suffix = `.int.${selector.domain}`;
			const host = override ?? `factorio${suffix}`;

			return host.endsWith(suffix) &&
				DNS_LABEL.test(host.slice(0, -suffix.length)) &&
				isHostname(host)
				? { ok: true, value: host }
				: { ok: false, reason: "gh_host_invalid" };
		}

		default: {
			const _exhaustive: never = selector;

			return _exhaustive;
		}
	}
}

/**
 * Resolves the platform from `FACTORY_PLATFORM` and the selection file. With
 * neither, it is `exe-dev`. Both naming a platform must agree. Any malformed
 * source refuses; nothing falls back to `exe-dev` after an error.
 */
export function parsePlatformProfile(input: {
	readonly selector: string | undefined;
	readonly file: PlatformFile;
}): PlatformResolution {
	const fromEnv =
		input.selector === undefined ? null : parsePlatformSelector(input.selector);

	if (fromEnv !== null && !fromEnv.ok) return fromEnv;

	const file = fileSelectionOf(input.file);

	if (file !== null && !file.ok) return file;

	const fromFile = file?.value.selector ?? null;

	if (
		fromEnv !== null &&
		fromFile !== null &&
		platformDescriptor(platformNetwork(fromEnv.value)) !==
			platformDescriptor(platformNetwork(fromFile))
	) {
		return { ok: false, reason: "platform_selection_mismatch" };
	}

	const selector = fromEnv?.value ?? fromFile ?? { name: "exe-dev" };
	const identity = identityOf(selector, file?.value ?? null);

	if (!identity.ok) return identity;

	const ghHost = ghHostOf(selector, file?.value.ghHost ?? null);

	if (!ghHost.ok) return ghHost;

	const repositories = file?.value.repositories ?? DEFAULT_REPOSITORIES;

	const historicalRepositories =
		file?.value.historicalRepositories ?? DEFAULT_HISTORICAL_REPOSITORIES;

	if (aliasesActive(historicalRepositories, repositories))
		return { ok: false, reason: "historical_repository_invalid" };

	const network = platformNetwork(selector);

	const profile: PlatformProfile = Object.freeze({
		...network,
		...identity.value,
		ghHost: ghHost.value,
		repositories,
		historicalRepositories,
		anthropicStages: ANTHROPIC_STAGES,
	});

	const defect = platformDefect(profile);

	return defect === null
		? { ok: true, profile }
		: { ok: false, reason: defect };
}

function fileSelectionOf(file: PlatformFile): Parsed<FileSelection> | null {
	switch (file.kind) {
		case "absent":
			return null;
		case "present":
			return parsePlatformFile(file.text);
		case "unreadable":
			return { ok: false, reason: "platform_file_unreadable" };
		case "unsafe":
			return { ok: false, reason: "platform_file_unsafe" };
		case "oversized":
			return { ok: false, reason: "platform_file_malformed" };
		default: {
			const _exhaustive: never = file;

			return _exhaustive;
		}
	}
}

/**
 * Reads the selection file at an entry point, without following a symlink.
 * Only a missing path is `absent`. A symlink, even a dangling one, or any
 * non-regular file is `unsafe`, and a file over the size limit is never read.
 */
export async function readPlatformFile(
	path: string = PLATFORM_FILE,
): Promise<PlatformFile> {
	try {
		const stats = await lstat(path);

		if (!stats.isFile()) return { kind: "unsafe" };

		if (stats.size > MAX_FILE_BYTES) return { kind: "oversized" };

		return { kind: "present", text: await readFile(path, "utf8") };
	} catch (error) {
		return error instanceof Error && "code" in error && error.code === "ENOENT"
			? { kind: "absent" }
			: { kind: "unreadable" };
	}
}

/** The entry-point resolver the CLI, the replay driver and the extension share. */
export async function resolvePlatform(input: {
	readonly env: (name: string) => string | undefined;
	readonly readFile: () => Promise<PlatformFile>;
}): Promise<PlatformResolution> {
	return parsePlatformProfile({
		selector: input.env("FACTORY_PLATFORM"),
		file: await input.readFile(),
	});
}

/** The immutable no-configuration profile. Production reads it only through `parsePlatformProfile`. */
export const EXE_DEV_PLATFORM: PlatformProfile = (() => {
	const resolved = parsePlatformProfile({
		selector: undefined,
		file: { kind: "absent" },
	});

	if (!resolved.ok) throw new Error(`exe-dev platform: ${resolved.reason}`);

	return resolved.profile;
})();

/** The one repository a single-repository command acts on, or `null` when the allowlist names several. */
export function soleRepository(profile: PlatformProfile): RepoSlug | null {
	const [only, ...rest] = profile.repositories;

	return only !== undefined && rest.length === 0 ? only : null;
}

/**
 * `repo` followed by its read-only former names. Only measurement readers
 * (metrics and replay) may call this; trust, admission, claims, dispatch
 * and publication compare the configured name exactly.
 */
export function measuredRepositories(
	history: HistoricalRepositories,
	repo: string,
): readonly string[] {
	return [repo, ...(Object.hasOwn(history, repo) ? (history[repo] ?? []) : [])];
}

/** The current name for `repo` when it is a recorded former name, else `repo`. */
export function currentRepository(
	history: HistoricalRepositories,
	repo: string,
): string {
	return (
		Object.keys(history).find((current) =>
			measuredRepositories(history, current).includes(repo),
		) ?? repo
	);
}

export type PlatformSummary = {
	readonly name: PlatformName;
	readonly domain: string;
	readonly descriptor: string;
	readonly digest: Digest;
	readonly modelHost: string;
	readonly edgeAddress: string;
	readonly modelBasePaths: PlatformNetwork["modelBasePaths"];
	readonly forbiddenDomains: readonly string[];
	readonly ghHost: string;
	readonly controllerLogin: string;
	readonly controllerAppSlug: string;
	readonly botEmail: string;
	readonly repositories: readonly RepoSlug[];
	readonly historicalRepositories: HistoricalRepositories;
	readonly anthropicStages: readonly ModelPosition[];
};

/** The nonsecret, deterministic report of a profile. Equal profiles have equal digests. */
export function platformSummary(profile: PlatformProfile): PlatformSummary {
	const fields = {
		modelHost: profile.modelHost,
		edgeAddress: profile.edgeAddress,
		modelBasePaths: {
			openai: profile.modelBasePaths.openai,
			anthropic: profile.modelBasePaths.anthropic,
			xai: profile.modelBasePaths.xai,
		},
		forbiddenDomains: [...profile.forbiddenDomains],
		ghHost: profile.ghHost,
		controllerLogin: profile.controllerLogin,
		controllerAppSlug: profile.controllerAppSlug,
		botEmail: profile.botEmail,
		repositories: [...profile.repositories],
		historicalRepositories: Object.fromEntries(
			Object.entries(profile.historicalRepositories).map(([name, former]) => [
				name,
				[...former],
			]),
		),
		anthropicStages: [...profile.anthropicStages],
	};

	return {
		name: profile.name,
		domain: profile.domain,
		descriptor: platformDescriptor(profile),
		digest: digestOf(
			JSON.stringify({ name: profile.name, domain: profile.domain, ...fields }),
		),
		...fields,
	};
}
