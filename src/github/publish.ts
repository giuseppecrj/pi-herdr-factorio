import { createHash } from "node:crypto";
import {
	mkdtempSync,
	rmSync,
	writeFileSync,
	mkdirSync,
	cpSync,
	existsSync,
} from "node:fs";
import { collectPatch } from "../candidate/build.ts";
import {
	exclusive,
	privateDir,
	regularText,
	present,
} from "../contract/artifacts.ts";
import { checkChangedPaths } from "../trust/policy.ts";
import { ACCEPTANCE_SUITE_DIR, isAtOrUnder } from "../trust/protected-paths.ts";
import { REVIEW_DIFF_MAX_BYTES } from "../candidate/review.ts";
import type {
	OwnerPatchReceipt,
	OwnerPatchRead,
	OwnerHeadRefusal,
} from "../candidate/state.ts";
import { parseOwnerPatchReceipt } from "../candidate/codec.ts";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ghFailure, type Exec, type ExecResult } from "./exec.ts";
import {
	type ControllerIdentity,
	EXE_DEV_PLATFORM,
} from "../trust/platform.ts";
import { digestOf, type Digest } from "../core/run.ts";
import { isGitSha, type GitSha } from "../config/schema.ts";
import type { RepoSlug } from "../trust/platform.ts";
import {
	arrayOf,
	fieldOf,
	objectOf,
	parseJson,
	textOf,
	type JsonValue,
} from "../core/json.ts";

/** The exe-dev commit email, kept for test imports. Commits use the API's identity. */
export const BOT_EMAIL = EXE_DEV_PLATFORM.botEmail;

/** Who authors and commits the controller's ledger commits. */
export type CommitIdentity = Pick<
	ControllerIdentity,
	"controllerLogin" | "botEmail"
>;

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

export function ownerPatchPath(
	stateDir: string,
	runId: Digest,
	head: GitSha,
	baseSha?: GitSha,
): string {
	return join(
		stateDir,
		"handoff",
		runId,
		"owner",
		`${head}${baseSha === undefined ? "" : `-${baseSha}`}.json`,
	);
}

export function readOwnerPatch(
	stateDir: string,
	runId: Digest,
	head: GitSha,
	baseSha: GitSha,
): OwnerPatchRead | null {
	try {
		const keyed = ownerPatchPath(stateDir, runId, head, baseSha);
		const path = present(keyed) ? keyed : ownerPatchPath(stateDir, runId, head);

		const value = objectOf(parseJson(regularText(path, 256 * 1024)));

		const receipt = parseOwnerPatchReceipt(value?.receipt);
		const patch = textOf(value?.patch);

		return receipt !== null &&
			patch !== null &&
			receipt.runId === runId &&
			receipt.head === head &&
			receipt.baseSha === baseSha &&
			digestOf(patch) === receipt.patchDigest &&
			Buffer.byteLength(patch) <= REVIEW_DIFF_MAX_BYTES
			? { kind: "found", receipt, patch }
			: null;
	} catch {
		return null;
	}
}

export function storeOwnerPatch(
	stateDir: string,
	receipt: OwnerPatchReceipt,
	patch: string,
): void {
	if (
		digestOf(patch) !== receipt.patchDigest ||
		Buffer.byteLength(patch) > REVIEW_DIFF_MAX_BYTES
	)
		throw new Error("owner_patch_binding");

	const path = ownerPatchPath(
		stateDir,
		receipt.runId,
		receipt.head,
		receipt.baseSha,
	);

	privateDir(join(path, ".."));
	const bytes = `${JSON.stringify({ receipt, patch })}\n`;

	if (present(path)) {
		if (regularText(path, 256 * 1024) !== bytes)
			throw new Error("owner_patch_changed");
	} else exclusive(path, bytes);
}

/** Derive only reviewable owner bytes. Acceptance is replaced before collecting a diff. */
export async function deriveOwnerPatch(
	api: GitHubPublicationApi,
	input: {
		stateDir: string;
		runId: Digest;
		head: GitSha;
		baseSha: GitSha;
		contractDigest: Digest;
		acceptanceDigest: Digest;
		heldoutDigest: Digest;
		suite: readonly PublishedFile[];
		checkout: (sha: GitSha, workspace: string) => Promise<boolean>;
	},
): Promise<
	| { kind: "found"; patch: OwnerPatchReceipt }
	| { kind: "refused"; reason: OwnerHeadRefusal }
> {
	const refused = (reason: OwnerHeadRefusal) =>
		({ kind: "refused", reason }) as const;

	let scratch: string | null = null;

	try {
		const existing = readOwnerPatch(
			input.stateDir,
			input.runId,
			input.head,
			input.baseSha,
		);

		if (existing !== null) {
			return existing.receipt.contractDigest === input.contractDigest &&
				existing.receipt.acceptanceDigest === input.acceptanceDigest &&
				existing.receipt.heldoutDigest === input.heldoutDigest
				? { kind: "found", patch: existing.receipt }
				: refused("unreadable");
		}

		if (
			present(
				ownerPatchPath(input.stateDir, input.runId, input.head, input.baseSha),
			)
		)
			return refused("unreadable");

		const compare = objectOf(
			await api.request("GET", `compare/${input.baseSha}...${input.head}`),
		);

		if (compare?.status !== "ahead")
			return compare?.status === "behind" ||
				compare?.status === "diverged" ||
				compare?.status === "identical"
				? refused("behind_main")
				: refused("unreadable");
		const trees: Map<string, string>[] = [];

		for (const sha of [input.baseSha, input.head]) {
			const raw = objectOf(
				await api.request("GET", `git/trees/${sha}?recursive=1`),
			);

			const entries = arrayOf(raw?.tree);

			if (raw?.truncated !== false || entries === null)
				return refused("unreadable");
			const files = new Map<string, string>();

			for (const entry of entries) {
				const e = objectOf(entry);

				if (e?.type === "tree") continue;

				const path = textOf(e?.path),
					blob = textOf(e?.sha);

				if (
					e?.type !== "blob" ||
					path === null ||
					blob === null ||
					!isGitSha(blob) ||
					!["100644", "100755", "120000"].includes(String(e.mode)) ||
					files.has(path)
				)
					return refused("unreadable");
				files.set(path, `${e.mode}:${blob}`);
			}

			trees.push(files);
		}

		const baseTree = trees[0]!,
			ownerTree = trees[1]!;

		const isHeldout = (path: string) => isAtOrUnder(path, ACCEPTANCE_SUITE_DIR);

		const expected = new Map([...baseTree].filter(([p]) => isHeldout(p)));

		for (const file of input.suite) {
			if (file.bytes === null) expected.delete(file.path);
			else
				expected.set(
					file.path,
					`${file.mode}:${gitObjectSha("blob", file.bytes)}`,
				);
		}

		const actual = new Map([...ownerTree].filter(([p]) => isHeldout(p)));

		if (
			actual.size !== expected.size ||
			[...expected].some(([p, v]) => actual.get(p) !== v)
		)
			return refused("heldout_changed");

		const changedPaths = [...new Set([...baseTree.keys(), ...ownerTree.keys()])]
			.filter((p) => !isHeldout(p) && baseTree.get(p) !== ownerTree.get(p))
			.sort();

		if (checkChangedPaths({ changedPaths }).kind !== "clean")
			return refused("forbidden_path");
		scratch = mkdtempSync(join(tmpdir(), "factory-owner-"));

		const base = join(scratch, "base"),
			workspace = join(scratch, "owner");

		mkdirSync(base);
		mkdirSync(workspace);

		if (
			!(await input.checkout(input.baseSha, base)) ||
			!(await input.checkout(input.head, workspace))
		)
			return refused("unreadable");
		rmSync(join(workspace, ACCEPTANCE_SUITE_DIR), {
			recursive: true,
			force: true,
		});

		if (existsSync(join(base, ACCEPTANCE_SUITE_DIR))) {
			mkdirSync(join(workspace, "test"), { recursive: true });
			cpSync(
				join(base, ACCEPTANCE_SUITE_DIR),
				join(workspace, ACCEPTANCE_SUITE_DIR),
				{ recursive: true, verbatimSymlinks: true },
			);
		}

		const collected = await collectPatch({
			base,
			workspace,
			allowNoChange: true,
		});

		if (
			collected.kind !== "collected" ||
			JSON.stringify(collected.changedPaths) !== JSON.stringify(changedPaths)
		)
			return refused("unreadable");
		const patch = Buffer.from(collected.patch).toString("utf8");

		if (Buffer.byteLength(patch) > REVIEW_DIFF_MAX_BYTES)
			return refused("too_large");

		const receipt: OwnerPatchReceipt = {
			version: 1,
			kind: "owner",
			runId: input.runId,
			head: input.head,
			baseSha: input.baseSha,
			contractDigest: input.contractDigest,
			acceptanceDigest: input.acceptanceDigest,
			heldoutDigest: input.heldoutDigest,
			patchDigest: collected.patchDigest,
			changedPaths,
			policy: "clean",
		};

		storeOwnerPatch(input.stateDir, receipt, patch);

		return { kind: "found", patch: receipt };
	} catch {
		return refused("unreadable");
	} finally {
		if (scratch !== null) rmSync(scratch, { recursive: true, force: true });
	}
}

export async function pinOwnerCandidate(
	api: GitHubPublicationApi,
	branch: string,
	head: GitSha,
): Promise<Publication> {
	if (!isCandidateBranch(branch)) throw new PublicationError("invalid_branch");
	const tip = await api.ref(branch);

	if (tip !== null && tip !== head) throw new PublicationError("branch_moved");

	if (tip === null) {
		try {
			await api.request("POST", "git/refs", {
				ref: `refs/heads/${branch}`,
				sha: head,
			});
		} catch (error) {
			if (!(error instanceof PublicationError) || error.reason !== "conflict")
				throw error;
		}

		if ((await api.ref(branch)) !== head)
			throw new PublicationError("branch_moved");
	}

	return { branch, patchSha: head, candidateSha: head };
}

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
	readonly identity: CommitIdentity;
	readonly counters: TransportCounters;
	readonly persist: () => Promise<boolean>;
	readonly sleep: (ms: number) => Promise<void>;
	readonly budget?: {
		readonly now: () => number;
		readonly sliceMs: number;
		readonly callMs: number;
	};
	#deadline = Infinity;

	startJob(): void {
		this.#deadline =
			this.budget === undefined
				? Infinity
				: this.budget.now() + this.budget.sliceMs;
	}

	constructor(
		exec: Exec,
		repo: RepoSlug,
		identity: CommitIdentity,
		counters: TransportCounters = {},
		persist: () => Promise<boolean> = async () => true,
		sleep: (ms: number) => Promise<void> = (ms) =>
			new Promise((done) => setTimeout(done, ms)),
		budget?: {
			readonly now: () => number;
			readonly sliceMs: number;
			readonly callMs: number;
		},
	) {
		this.exec = exec;
		this.repo = repo;
		this.identity = identity;
		this.counters = counters;
		this.persist = persist;
		this.sleep = sleep;
		this.budget = budget;
	}

	async request(
		method: "GET" | "POST" | "PATCH" | "DELETE",
		path: string,
		body?: JsonValue,
		once = false,
	): Promise<JsonValue | undefined> {
		const key = digestOf(JSON.stringify([method, path, body ?? null]));
		const max = once || this.budget !== undefined ? 1 : 3;

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

				const timeoutMs =
					this.budget === undefined
						? undefined
						: Math.min(this.budget.callMs, this.#deadline - this.budget.now());

				if (timeoutMs !== undefined && timeoutMs <= 0)
					throw new PublicationError("slice_exhausted");

				result = await this.exec(
					"gh",
					args,
					timeoutMs === undefined ? undefined : { timeoutMs },
				).catch(() => ({
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

export function shaOf(value: JsonValue | undefined): GitSha {
	const sha = textOf(value);

	if (sha === null || !isGitSha(sha))
		throw new PublicationError("malformed_sha");

	return sha;
}

export async function createCommit(
	api: GitHubPublicationApi,
	tree: GitSha,
	parents: readonly GitSha[],
	date: string,
	message: string,
): Promise<GitSha> {
	const epoch = Date.parse(date) / 1000;

	if (!Number.isSafeInteger(epoch)) throw new PublicationError("invalid_date");
	const { controllerLogin, botEmail } = api.identity;
	const identity = `${controllerLogin} <${botEmail}> ${epoch} +0000`;

	const bytes = Buffer.from(
		`tree ${tree}\n${parents.map((parent) => `parent ${parent}\n`).join("")}author ${identity}\ncommitter ${identity}\n\n${message}`,
	);

	const expected = gitObjectSha("commit", bytes);
	const actor = { name: controllerLogin, email: botEmail, date };

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

export async function createTree(
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

	const patchTree = await createTree(api, baseTree, input.patch);
	const trailers = `Factory-Run: ${input.runId}\nFactory-Round: ${input.round}\n${(input.generation ?? 0) === 0 ? "" : `Factory-Generation: ${input.generation}\n`}Patch-Digest: ${input.patchDigest}\nAcceptance-Digest: ${input.acceptanceDigest}\n`;

	const patchSha = await createCommit(
		api,
		patchTree,
		[input.baseSha],
		input.eventAt,
		`factory: builder patch\n\n${trailers}Factory-Role: patch\n`,
	);

	const suiteTree = await createTree(api, patchTree, input.suite);

	const candidateSha = await createCommit(
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
