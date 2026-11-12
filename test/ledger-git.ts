import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { BOT_EMAIL, gitObjectSha } from "../src/publication.ts";
import { type Exec, type ExecResult } from "../src/github/exec.ts";
import { CONTROLLER_LOGIN } from "../src/trust/markers.ts";
import { isRepoSlug, type RepoSlug } from "../src/workflow.ts";
import {
	arrayOf,
	fieldOf,
	objectOf,
	parseJson,
	textOf,
	type JsonValue,
} from "../src/core/json.ts";

const slug = "giuseppecrj/pi-herdr-factorio";

if (!isRepoSlug(slug)) throw new Error("invalid_repo");

export const repo: RepoSlug = slug;

export class LedgerGit {
	/** The repository whose `factory/ledger` this fake serves. */
	readonly served: RepoSlug;

	constructor(served: RepoSlug = repo) {
		this.served = served;
	}

	readonly blobs = new Map<string, Buffer>();
	readonly trees = new Map<string, Map<string, string>>();
	readonly commits = new Map<string, readonly string[]>();
	readonly refs = new Map<string, string>();
	readonly writes: { method: string; path: string; body: JsonValue }[] = [];
	readonly requests: string[] = [];
	lose: ((method: string, path: string) => "before" | "after" | null) | null =
		null;
	hook: ((method: string, path: string) => ExecResult | null) | null = null;
	readonly exec: Exec = async (_command, args): Promise<ExecResult> => {
		const path =
			args
				.find((a) => a.startsWith(`repos/${this.served}/`))
				?.slice(`repos/${this.served}/`.length) ?? "";

		const method = args[args.indexOf("--method") + 1] ?? "GET";
		const file = args[args.indexOf("--input") + 1];

		const body =
			args.includes("--input") && file !== undefined
				? (parseJson(readFileSync(file, "utf8")) ?? null)
				: null;

		this.requests.push(`${method} ${path}`);

		if (method !== "GET") this.writes.push({ method, path, body });
		const hooked = this.hook?.(method, path);

		if (hooked != null) return hooked;
		const lost = this.lose?.(method, path) ?? null;

		if (lost === "before")
			return { code: 1, stdout: "", stderr: "connection reset" };
		const result = this.answer(method, path, objectOf(body));

		return lost === "after"
			? { code: 1, stdout: "", stderr: "connection reset" }
			: result;
	};
	answer(method: string, path: string, body: ReturnType<typeof objectOf>) {
		const ok = (value?: JsonValue): ExecResult => ({
			code: 0,
			stdout: value === undefined ? "" : JSON.stringify(value),
			stderr: "",
		});

		const no = (status: number): ExecResult => ({
			code: 1,
			stdout: "",
			stderr: `HTTP ${status}`,
		});

		if (method === "POST" && path === "git/blobs") {
			const bytes = Buffer.from(
				textOf(fieldOf(body, "content")) ?? "",
				"base64",
			);

			const sha = gitObjectSha("blob", bytes);
			this.blobs.set(sha, bytes);

			return ok({ sha });
		}

		if (method === "POST" && path === "git/trees") {
			const base = textOf(fieldOf(body, "base_tree"));
			const files = new Map(base === null ? [] : this.trees.get(base));

			for (const entry of arrayOf(fieldOf(body, "tree")) ?? []) {
				const sha = textOf(fieldOf(objectOf(entry), "sha"));
				const name = textOf(fieldOf(objectOf(entry), "path")) ?? "";

				if (sha === null) files.delete(name);
				else files.set(name, sha);
			}

			const sha = createHash("sha1")
				.update(JSON.stringify([...files].sort()))
				.digest("hex");

			this.trees.set(sha, files);

			return ok({ sha });
		}

		if (method === "GET" && path.startsWith("git/trees/")) {
			const sha = path.slice("git/trees/".length).replace(/\?.*$/, "");
			const files = this.trees.get(sha);

			if (files === undefined) return no(404);
			const dirs = new Set<string>();

			for (const name of files.keys()) {
				const parts = name.split("/");

				for (let i = 1; i < parts.length; i++)
					dirs.add(parts.slice(0, i).join("/"));
			}

			return ok({
				sha,
				truncated: false,
				tree: [
					...[...dirs].map((dir) => ({
						path: dir,
						mode: "040000",
						type: "tree",
						sha: "e".repeat(40),
					})),
					...[...files].map(([name, blob]) => ({
						path: name,
						mode: "100644",
						type: "blob",
						sha: blob,
					})),
				],
			});
		}

		if (method === "GET" && path.startsWith("git/blobs/")) {
			const sha = path.slice("git/blobs/".length);
			const bytes = this.blobs.get(sha);

			return bytes === undefined
				? no(404)
				: ok({ sha, encoding: "base64", content: bytes.toString("base64") });
		}

		if (method === "POST" && path === "git/commits") {
			const tree = textOf(fieldOf(body, "tree")) ?? "";

			const parents = (arrayOf(fieldOf(body, "parents")) ?? []).map(
				(p) => textOf(p) ?? "",
			);

			const message = textOf(fieldOf(body, "message")) ?? "";
			const date = textOf(fieldOf(objectOf(fieldOf(body, "author")), "date"));
			const actor = `${CONTROLLER_LOGIN} <${BOT_EMAIL}> ${Date.parse(date ?? "") / 1000} +0000`;

			const sha = gitObjectSha(
				"commit",
				Buffer.from(
					`tree ${tree}\n${parents.map((p) => `parent ${p}\n`).join("")}author ${actor}\ncommitter ${actor}\n\n${message}`,
				),
			);

			this.commits.set(sha, parents);
			this.trees.set(`commit:${sha}`, new Map([["tree", tree]]));

			return ok({ sha });
		}

		if (method === "GET" && path.startsWith("git/commits/")) {
			const sha = path.slice("git/commits/".length);
			const parents = this.commits.get(sha);
			const tree = this.trees.get(`commit:${sha}`)?.get("tree");

			return parents === undefined || tree === undefined
				? no(404)
				: ok({
						sha,
						tree: { sha: tree },
						parents: parents.map((parent) => ({ sha: parent })),
					});
		}

		if (method === "POST" && path === "git/refs") {
			const name = (textOf(fieldOf(body, "ref")) ?? "").slice(
				"refs/heads/".length,
			);

			if (this.refs.has(name)) return no(422);
			const sha = textOf(fieldOf(body, "sha")) ?? "";
			this.refs.set(name, sha);

			return ok({ ref: `refs/heads/${name}`, object: { sha } });
		}

		if (method === "GET" && path.startsWith("git/ref/heads/")) {
			const name = path.slice("git/ref/heads/".length);
			const sha = this.refs.get(name);

			return sha === undefined
				? no(404)
				: ok({ ref: `refs/heads/${name}`, object: { sha, type: "commit" } });
		}

		if (method === "PATCH" && path.startsWith("git/refs/heads/")) {
			const name = path.slice("git/refs/heads/".length);
			const current = this.refs.get(name);
			const next = textOf(fieldOf(body, "sha")) ?? "";

			if (current === undefined) return no(422);

			if (fieldOf(body, "force") !== false || !this.descends(next, current))
				return no(422);
			this.refs.set(name, next);

			return ok({ ref: `refs/heads/${name}`, object: { sha: next } });
		}

		throw new Error(`unexpected ${method} ${path}`);
	}
	descends(sha: string, ancestor: string): boolean {
		const queue = [sha];

		for (let next = queue.pop(); next !== undefined; next = queue.pop()) {
			if (next === ancestor) return true;
			queue.push(...(this.commits.get(next) ?? []));
		}

		return false;
	}
}
