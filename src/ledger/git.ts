import {
	GitHubPublicationApi,
	PublicationError,
	createCommit,
	createTree,
	gitObjectSha,
	shaOf,
} from "../github/publish.ts";
import { isGitSha, type GitSha } from "../workflow.ts";
import { arrayOf, fieldOf, objectOf, textOf } from "../core/json.ts";

const LEDGER_BRANCH = "factory/ledger";

export const LEDGER_FILE = "ledger/runs.jsonl";
export const SCORE_FILE = "ledger/scores.jsonl";

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

export async function ledgerRef(
	api: GitHubPublicationApi,
): Promise<GitSha | null> {
	const value = await api.request("GET", `git/ref/heads/${LEDGER_BRANCH}`);

	if (value === undefined) return null;
	const ref = objectOf(value);

	if (textOf(fieldOf(ref, "ref")) !== `refs/heads/${LEDGER_BRANCH}`)
		throw new PublicationError("malformed_ref");

	return shaOf(fieldOf(objectOf(fieldOf(ref, "object")), "sha"));
}

export async function advanceLedger(
	api: GitHubPublicationApi,
	from: GitSha | null,
	next: GitSha,
): Promise<LedgerAdvance> {
	if (!isGitSha(next) || (from !== null && !isGitSha(from)))
		throw new PublicationError("invalid_sha");
	let failure: Error | null = null;

	try {
		if (from === null)
			await api.request(
				"POST",
				"git/refs",
				{ ref: `refs/heads/${LEDGER_BRANCH}`, sha: next },
				true,
			);
		else
			await api.request(
				"PATCH",
				`git/refs/heads/${LEDGER_BRANCH}`,
				{ sha: next, force: false },
				true,
			);
	} catch (error) {
		if (!(error instanceof Error)) throw error;
		failure = error;
	}

	const tip = await ledgerRef(api);

	if (tip === next) return { kind: "advanced", tip };

	if (
		failure === null ||
		(failure instanceof PublicationError && failure.reason === "conflict")
	)
		return { kind: "conflict", tip };
	throw failure;
}

export async function createLedgerRoot(
	api: GitHubPublicationApi,
	date: string,
): Promise<LedgerCommit> {
	const root = await createTree(api, null, [
		{ path: LEDGER_FILE, mode: "100644", bytes: new Uint8Array() },
	]);

	const sha = await createCommit(api, root, [], date, "factory: ledger root\n");

	return { sha, tree: root, parents: [] };
}

export async function createLedgerChild(
	api: GitHubPublicationApi,
	parent: LedgerCommit,
	bytes: Uint8Array,
	date: string,
	message: string,
	file: typeof LEDGER_FILE | typeof SCORE_FILE = LEDGER_FILE,
): Promise<LedgerCommit> {
	if (!message.endsWith("\n")) throw new PublicationError("invalid_message");

	const child = await createTree(api, parent.tree, [
		{ path: file, mode: "100644", bytes },
	]);

	const sha = await createCommit(api, child, [parent.sha], date, message);

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
	file: typeof LEDGER_FILE | typeof SCORE_FILE = LEDGER_FILE,
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

		if (path !== file) continue;

		if (
			textOf(fieldOf(item, "type")) !== "blob" ||
			textOf(fieldOf(item, "mode")) !== "100644"
		)
			throw new PublicationError("malformed_tree");
		blob = shaOf(fieldOf(item, "sha"));
	}

	if (blob === null) {
		if (file === SCORE_FILE)
			return {
				blob: gitObjectSha("blob", new Uint8Array()),
				bytes: Buffer.alloc(0),
				paths: paths.sort(),
			};
		throw new PublicationError("ledger_file_missing");
	}

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

export interface LedgerApi {
	startJob?(): void;
	ref(): Promise<GitSha | null>;
	commit(sha: GitSha): Promise<LedgerCommit>;
	file(tree: GitSha): Promise<LedgerFile>;
	root(date: string): Promise<LedgerCommit>;
	child(
		parent: LedgerCommit,
		bytes: Uint8Array,
		date: string,
		message: string,
	): Promise<LedgerCommit>;
	advance(from: GitSha | null, next: GitSha): Promise<LedgerAdvance>;
}

export function ledgerApiOf(
	api: GitHubPublicationApi,
	stream: "runs" | "scores" = "runs",
): LedgerApi {
	const file = stream === "scores" ? SCORE_FILE : LEDGER_FILE;

	return {
		startJob: () => api.startJob(),
		ref: () => ledgerRef(api),
		commit: (sha) => readLedgerCommit(api, sha),
		file: (tree) => readLedgerFile(api, tree, file),
		root: (date) => createLedgerRoot(api, date),
		child: (parent, bytes, date, message) =>
			createLedgerChild(
				api,
				parent,
				bytes,
				date,
				stream === "scores"
					? message
							.replace("factory: ledger row", "factory: score event")
							.replace("Factory-Run:", "Factory-Score:")
							.replace("Factory-Row:", "Factory-Event:")
					: message,
				file,
			),
		advance: (from, next) => advanceLedger(api, from, next),
	};
}
