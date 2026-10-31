import { createHash } from "node:crypto";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ghFailure, type Exec, type ExecResult } from "./gh.ts";
import { CONTROLLER_LOGIN } from "./markers.ts";
import { digestOf, type Digest } from "./run.ts";
import { isGitSha, type GitSha, type RepoSlug } from "./workflow.ts";
import {
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
): string {
	if (
		!Number.isSafeInteger(issue) ||
		issue < 1 ||
		!Number.isInteger(round) ||
		round < 0 ||
		round > 2
	)
		throw new Error("invalid_branch");

	return `factory/run/${issue}-${runId.slice(0, 12)}-r${round}`;
}

export function isCandidateBranch(branch: string): boolean {
	return /^factory\/run\/[1-9][0-9]*-[a-f0-9]{12}-r[0-2]$/.test(branch);
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
		method: "GET" | "POST" | "DELETE",
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
	parent: GitSha,
	date: string,
	message: string,
): Promise<GitSha> {
	const epoch = Date.parse(date) / 1000;

	if (!Number.isSafeInteger(epoch)) throw new PublicationError("invalid_date");
	const identity = `${CONTROLLER_LOGIN} <${BOT_EMAIL}> ${epoch} +0000`;

	const bytes = Buffer.from(
		`tree ${tree}\nparent ${parent}\nauthor ${identity}\ncommitter ${identity}\n\n${message}`,
	);

	const expected = gitObjectSha("commit", bytes);
	const actor = { name: CONTROLLER_LOGIN, email: BOT_EMAIL, date };

	const result = await api.request("POST", "git/commits", {
		tree,
		parents: [parent],
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
	base: GitSha,
	files: readonly PublishedFile[],
): Promise<GitSha> {
	const entries: JsonValue[] = [];

	for (const file of files) {
		if (file.bytes === null) {
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

	const result = await api.request("POST", "git/trees", {
		base_tree: base,
		tree: entries,
	});

	return shaOf(fieldOf(objectOf(result), "sha"));
}

export async function publishCandidate(
	api: GitHubPublicationApi,
	input: {
		readonly issue: number;
		readonly runId: Digest;
		readonly round: number;
		readonly eventAt: string;
		readonly baseSha: GitSha;
		readonly patchDigest: Digest;
		readonly acceptanceDigest: Digest;
		readonly heldoutDigest: Digest;
		readonly patch: readonly PublishedFile[];
		readonly suite: readonly PublishedFile[];
	},
): Promise<Publication> {
	const branch = candidateBranch(input.issue, input.runId, input.round);
	const base = await api.request("GET", `git/commits/${input.baseSha}`);

	const baseTree = shaOf(
		fieldOf(objectOf(fieldOf(objectOf(base), "tree")), "sha"),
	);

	const patchTree = await tree(api, baseTree, input.patch);
	const trailers = `Factory-Run: ${input.runId}\nFactory-Round: ${input.round}\nPatch-Digest: ${input.patchDigest}\nAcceptance-Digest: ${input.acceptanceDigest}\n`;

	const patchSha = await commit(
		api,
		patchTree,
		input.baseSha,
		input.eventAt,
		`factory: builder patch\n\n${trailers}Factory-Role: patch\n`,
	);

	const suiteTree = await tree(api, patchTree, input.suite);

	const candidateSha = await commit(
		api,
		suiteTree,
		patchSha,
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
