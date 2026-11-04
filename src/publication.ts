import { createHash } from "node:crypto";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ghFailure, type Exec, type ExecResult } from "./gh.ts";
import { CONTROLLER_LOGIN } from "./markers.ts";
import { digestOf, type Digest } from "./run.ts";
import { isGitSha, type GitSha, type RepoSlug } from "./workflow.ts";
import {
	arrayOf,
	fieldOf,
	objectOf,
	parseJson,
	textOf,
	type JsonValue,
} from "../server/sandbox/json.ts";

export const BOT_EMAIL =
	"267204973+exe-dev-github-integration[bot]@users.noreply.github.com";

export type PublishedFile = {
	readonly path: string;
	readonly mode: "100644" | "100755" | "120000";
	readonly bytes: Uint8Array | null;
};

export type Publication = {
	readonly branch: string;
	readonly patchSha: GitSha;
	readonly candidateSha: GitSha;
};

export function candidateBranch(
	issue: number,
	runId: Digest,
	round: number,
	generation = 0,
): string {
	if (
		!Number.isSafeInteger(issue) ||
		issue < 1 ||
		!Number.isInteger(round) ||
		round < 0 ||
		round > 2 ||
		!Number.isInteger(generation) ||
		generation < 0 ||
		generation > 3
	)
		throw new Error("invalid_branch");

	return `factory/run/${issue}-${runId.slice(0, 12)}-r${round}${generation === 0 ? "" : `-g${generation}`}`;
}

const LEDGER_BRANCH = "factory/ledger";

export const LEDGER_FILE = "ledger/runs.jsonl";

export type LedgerAdvance =
	| { readonly kind: "advanced"; readonly tip: GitSha }
	| { readonly kind: "conflict"; readonly tip: GitSha | null };

export type LedgerCommit = {
	readonly sha: GitSha;
	readonly tree: GitSha;
	readonly parents: readonly GitSha[];
};

export type LedgerFile = {
	readonly blob: GitSha;
	readonly bytes: Buffer;
	readonly paths: readonly string[];
};

export function isCandidateBranch(branch: string): boolean {
	return /^factory\/run\/[1-9][0-9]*-[a-f0-9]{12}-r[0-2](?:-g[1-3])?$/.test(
		branch,
	);
}

export function gitObjectSha(
	type: "blob" | "commit",
	bytes: Uint8Array,
): GitSha {
	const sha = createHash("sha1")
		.update(`${type} ${bytes.length}\0`)
		.update(bytes)
		.digest("hex");

	if (!isGitSha(sha)) throw new Error("invalid_sha");

	return sha;
}

export class PublicationError extends Error {
	readonly reason: string;
	constructor(reason: string) {
		super(reason);
		this.reason = reason;
	}
}

export type TransportCounters = Record<string, number>;

export class GitHubPublicationApi {
	readonly exec: Exec;
	readonly repo: RepoSlug;
	readonly counters: TransportCounters;
	readonly persist: () => Promise<boolean>;
	readonly sleep: (ms: number) => Promise<void>;
	constructor(
		exec: Exec,
		repo: RepoSlug,
		counters: TransportCounters = {},
		persist: () => Promise<boolean> = async () => true,
		sleep: (ms: number) => Promise<void> = (ms) =>
			new Promise((done) => setTimeout(done, ms)),
	) {
		this.exec = exec;
		this.repo = repo;
		this.counters = counters;
		this.persist = persist;
		this.sleep = sleep;
	}

	async request(
		method: "GET" | "POST" | "PATCH" | "DELETE",
		path: string,
		body?: JsonValue,
		once = false,
	): Promise<JsonValue | undefined> {
		const key = digestOf(JSON.stringify([method, path, body ?? null]));
		const max = once ? 1 : 3;

		for (let attempt = 0; attempt < max; attempt++) {
			this.counters[key] = attempt + 1;

			if (!(await this.persist()))
				throw new PublicationError("claim_unwritable");
			const dir = mkdtempSync(join(tmpdir(), "factory-api-"));
			let result: ExecResult;

			try {
				const args = ["api", "--method", method, `repos/${this.repo}/${path}`];

				if (body !== undefined) {
					const file = join(dir, "body.json");
					writeFileSync(file, JSON.stringify(body), { mode: 0o600 });
					args.push("--input", file);
				}

				result = await this.exec("gh", args).catch(() => ({
					code: 1,
					stdout: "",
					stderr: "connection reset",
				}));
			} finally {
				rmSync(dir, { recursive: true, force: true });
			}

			if (result.code === 0) {
				delete this.counters[key];

				if (!(await this.persist()))
					throw new PublicationError("claim_unwritable");

				if (result.stdout.trim() === "") return undefined;
				const value = parseJson(result.stdout);

				if (value === undefined)
					throw new PublicationError("malformed_response");

				return value;
			}

			const failure = ghFailure(result);

			if (failure.status === 404) {
				delete this.counters[key];

				return undefined;
			}

			if (failure.status === 422) {
				delete this.counters[key];
				throw new PublicationError("conflict");
			}

			if (
				once ||
				!(
					failure.cause === "network" ||
					failure.status === 429 ||
					(failure.status !== null && failure.status >= 500)
				)
			)
				throw new PublicationError("github_refused");

			if (attempt + 1 < max) await this.sleep(1000 * 2 ** attempt);
		}

		throw new PublicationError("transport_exhausted");
	}

	async ref(branch: string): Promise<GitSha | null> {
		if (!isCandidateBranch(branch))
			throw new PublicationError("invalid_branch");
		const value = await this.request("GET", `git/ref/heads/${branch}`);

		if (value === undefined) return null;

		return shaOf(fieldOf(objectOf(fieldOf(objectOf(value), "object")), "sha"));
	}

	async prRef(branch: string): Promise<GitSha | null> {
		if (!/^factory\/pr\/[1-9][0-9]*-[a-f0-9]{12}$/.test(branch))
			throw new PublicationError("invalid_branch");
		const value = await this.request("GET", `git/ref/heads/${branch}`);

		return value === undefined
			? null
			: shaOf(fieldOf(objectOf(fieldOf(objectOf(value), "object")), "sha"));
	}

	async promotePr(
		branch: string,
		expectedHead: GitSha | null,
		candidateSha: GitSha,
	): Promise<void> {
		const current = await this.prRef(branch);

		if (current === candidateSha) return;

		if (current !== expectedHead) throw new PublicationError("branch_moved");

		try {
			if (current === null)
				await this.request(
					"POST",
					"git/refs",
					{ ref: `refs/heads/${branch}`, sha: candidateSha },
					true,
				);
			else
				await this.request(
					"PATCH",
					`git/refs/heads/${branch}`,
					{ sha: candidateSha, force: false },
					true,
				);
		} catch (error) {
			if ((await this.prRef(branch)) !== candidateSha) throw error;
		}

		if ((await this.prRef(branch)) !== candidateSha)
			throw new PublicationError("branch_moved");
	}

	async ledgerRef(): Promise<GitSha | null> {
		const value = await this.request("GET", `git/ref/heads/${LEDGER_BRANCH}`);

		if (value === undefined) return null;
		const ref = objectOf(value);

		if (textOf(fieldOf(ref, "ref")) !== `refs/heads/${LEDGER_BRANCH}`)
			throw new PublicationError("malformed_ref");

		return shaOf(fieldOf(objectOf(fieldOf(ref, "object")), "sha"));
	}

	async advanceLedger(
		from: GitSha | null,
		next: GitSha,
	): Promise<LedgerAdvance> {
		if (!isGitSha(next) || (from !== null && !isGitSha(from)))
			throw new PublicationError("invalid_sha");
		let failure: Error | null = null;

		try {
			if (from === null)
				await this.request(
					"POST",
					"git/refs",
					{ ref: `refs/heads/${LEDGER_BRANCH}`, sha: next },
					true,
				);
			else
				await this.request(
					"PATCH",
					`git/refs/heads/${LEDGER_BRANCH}`,
					{ sha: next, force: false },
					true,
				);
		} catch (error) {
			if (!(error instanceof Error)) throw error;
			failure = error;
		}

		const tip = await this.ledgerRef();

		if (tip === next) return { kind: "advanced", tip };

		if (
			failure === null ||
			(failure instanceof PublicationError && failure.reason === "conflict")
		)
			return { kind: "conflict", tip };
		throw failure;
	}

	async remove(branch: string, candidateSha: GitSha): Promise<void> {
		const tip = await this.ref(branch);

		if (tip === null) return;

		if (tip !== candidateSha) throw new PublicationError("branch_moved");

		try {
			await this.request("DELETE", `git/refs/heads/${branch}`);
		} catch (error) {
			if (
				error instanceof PublicationError &&
				error.reason === "conflict" &&
				(await this.ref(branch)) === null
			)
				return;
			throw error;
		}
	}
}

function shaOf(value: JsonValue | undefined): GitSha {
	const sha = textOf(value);

	if (sha === null || !isGitSha(sha))
		throw new PublicationError("malformed_sha");

	return sha;
}

async function commit(
	api: GitHubPublicationApi,
	tree: GitSha,
	parents: readonly GitSha[],
	date: string,
	message: string,
): Promise<GitSha> {
	const epoch = Date.parse(date) / 1000;

	if (!Number.isSafeInteger(epoch)) throw new PublicationError("invalid_date");
	const identity = `${CONTROLLER_LOGIN} <${BOT_EMAIL}> ${epoch} +0000`;

	const bytes = Buffer.from(
		`tree ${tree}\n${parents.map((parent) => `parent ${parent}\n`).join("")}author ${identity}\ncommitter ${identity}\n\n${message}`,
	);

	const expected = gitObjectSha("commit", bytes);
	const actor = { name: CONTROLLER_LOGIN, email: BOT_EMAIL, date };

	const result = await api.request("POST", "git/commits", {
		tree,
		parents: [...parents],
		message,
		author: actor,
		committer: actor,
	});

	if (shaOf(fieldOf(objectOf(result), "sha")) !== expected)
		throw new PublicationError("commit_mismatch");

	return expected;
}

async function tree(
	api: GitHubPublicationApi,
	base: GitSha | null,
	files: readonly PublishedFile[],
): Promise<GitSha> {
	const entries: JsonValue[] = [];

	for (const file of files) {
		if (file.bytes === null) {
			if (base === null) throw new PublicationError("invalid_tree");
			entries.push({
				path: file.path,
				mode: file.mode,
				type: "blob",
				sha: null,
			});
			continue;
		}

		const bytes = Buffer.from(file.bytes);

		const result = await api.request("POST", "git/blobs", {
			content: bytes.toString("base64"),
			encoding: "base64",
		});

		const sha = shaOf(fieldOf(objectOf(result), "sha"));

		if (sha !== gitObjectSha("blob", bytes))
			throw new PublicationError("blob_mismatch");
		entries.push({ path: file.path, mode: file.mode, type: "blob", sha });
	}

	const result = await api.request(
		"POST",
		"git/trees",
		base === null ? { tree: entries } : { base_tree: base, tree: entries },
	);

	return shaOf(fieldOf(objectOf(result), "sha"));
}

export async function createLedgerRoot(
	api: GitHubPublicationApi,
	date: string,
): Promise<LedgerCommit> {
	const root = await tree(api, null, [
		{ path: LEDGER_FILE, mode: "100644", bytes: new Uint8Array() },
	]);

	const sha = await commit(api, root, [], date, "factory: ledger root\n");

	return { sha, tree: root, parents: [] };
}

export async function createLedgerChild(
	api: GitHubPublicationApi,
	parent: LedgerCommit,
	bytes: Uint8Array,
	date: string,
	message: string,
): Promise<LedgerCommit> {
	if (!message.endsWith("\n")) throw new PublicationError("invalid_message");

	const child = await tree(api, parent.tree, [
		{ path: LEDGER_FILE, mode: "100644", bytes },
	]);

	const sha = await commit(api, child, [parent.sha], date, message);

	return { sha, tree: child, parents: [parent.sha] };
}

export async function readLedgerCommit(
	api: GitHubPublicationApi,
	sha: GitSha,
): Promise<LedgerCommit> {
	const value = objectOf(await api.request("GET", `git/commits/${sha}`));

	if (value === null) throw new PublicationError("object_missing");

	if (shaOf(fieldOf(value, "sha")) !== sha)
		throw new PublicationError("object_mismatch");
	const parents = arrayOf(fieldOf(value, "parents"));

	if (parents === null) throw new PublicationError("malformed_commit");

	return {
		sha,
		tree: shaOf(fieldOf(objectOf(fieldOf(value, "tree")), "sha")),
		parents: parents.map((parent) => shaOf(fieldOf(objectOf(parent), "sha"))),
	};
}

export async function readLedgerFile(
	api: GitHubPublicationApi,
	root: GitSha,
): Promise<LedgerFile> {
	const value = objectOf(
		await api.request("GET", `git/trees/${root}?recursive=1`),
	);

	if (value === null) throw new PublicationError("object_missing");

	if (fieldOf(value, "truncated") !== false)
		throw new PublicationError("tree_truncated");
	const entries = arrayOf(fieldOf(value, "tree"));

	if (entries === null) throw new PublicationError("malformed_tree");
	const paths: string[] = [];
	let blob: GitSha | null = null;

	for (const entry of entries) {
		const item = objectOf(entry);
		const path = textOf(fieldOf(item, "path"));

		if (path === null) throw new PublicationError("malformed_tree");
		paths.push(path);

		if (path !== LEDGER_FILE) continue;

		if (
			textOf(fieldOf(item, "type")) !== "blob" ||
			textOf(fieldOf(item, "mode")) !== "100644"
		)
			throw new PublicationError("malformed_tree");
		blob = shaOf(fieldOf(item, "sha"));
	}

	if (blob === null) throw new PublicationError("ledger_file_missing");
	const content = objectOf(await api.request("GET", `git/blobs/${blob}`));

	if (content === null) throw new PublicationError("object_missing");
	const encoded = textOf(fieldOf(content, "content"));

	if (textOf(fieldOf(content, "encoding")) !== "base64" || encoded === null)
		throw new PublicationError("malformed_blob");
	const bytes = Buffer.from(encoded, "base64");

	if (gitObjectSha("blob", bytes) !== blob)
		throw new PublicationError("blob_mismatch");

	return { blob, bytes, paths: paths.sort() };
}

export async function publishCandidate(
	api: GitHubPublicationApi,
	input: {
		readonly issue: number;
		readonly runId: Digest;
		readonly round: number;
		readonly generation?: number;
		readonly ancestry?: {
			readonly kind: "successor";
			readonly previousHead: GitSha;
		};
		readonly eventAt: string;
		readonly baseSha: GitSha;
		readonly patchDigest: Digest;
		readonly acceptanceDigest: Digest;
		readonly heldoutDigest: Digest;
		readonly patch: readonly PublishedFile[];
		readonly suite: readonly PublishedFile[];
	},
): Promise<Publication> {
	const branch = candidateBranch(
		input.issue,
		input.runId,
		input.round,
		input.generation,
	);

	const base = await api.request("GET", `git/commits/${input.baseSha}`);

	const baseTree = shaOf(
		fieldOf(objectOf(fieldOf(objectOf(base), "tree")), "sha"),
	);

	const patchTree = await tree(api, baseTree, input.patch);
	const trailers = `Factory-Run: ${input.runId}\nFactory-Round: ${input.round}\n${(input.generation ?? 0) === 0 ? "" : `Factory-Generation: ${input.generation}\n`}Patch-Digest: ${input.patchDigest}\nAcceptance-Digest: ${input.acceptanceDigest}\n`;

	const patchSha = await commit(
		api,
		patchTree,
		[input.baseSha],
		input.eventAt,
		`factory: builder patch\n\n${trailers}Factory-Role: patch\n`,
	);

	const suiteTree = await tree(api, patchTree, input.suite);

	const candidateSha = await commit(
		api,
		suiteTree,
		input.ancestry === undefined
			? [patchSha]
			: [patchSha, input.ancestry.previousHead],
		input.eventAt,
		`factory: held-out checks\n\n${trailers}Heldout-Digest: ${input.heldoutDigest}\nFactory-Role: suite\n`,
	);

	let ref = await api.ref(branch);

	if (ref === null) {
		try {
			await api.request("POST", "git/refs", {
				ref: `refs/heads/${branch}`,
				sha: candidateSha,
			});
		} catch (error) {
			if (!(error instanceof PublicationError) || error.reason !== "conflict")
				throw error;
		}

		ref = await api.ref(branch);
	}

	if (ref !== candidateSha) throw new PublicationError("branch_moved");

	return { branch, patchSha, candidateSha };
}
