import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type Exec, type ExecResult } from "../src/github/exec.ts";
import {
	arrayOf,
	fieldOf,
	objectOf,
	parseJson,
	textOf,
	type JsonValue,
} from "../src/core/json.ts";

const ZERO = "0".repeat(40);

type GitResult = { readonly code: number; readonly stdout: Buffer };

/**
 * Serves the Git Data API calls the controller makes from a real bare
 * repository on disk, so a fresh process sees the same objects and refs.
 * Fast-forward only: a forced or non-descendant ref update is refused.
 */
export class RealGit {
	readonly dir: string;
	readonly served: string;
	readonly writes: { method: string; path: string; body: JsonValue }[] = [];
	readonly requests: string[] = [];

	constructor(dir: string, served: string) {
		this.dir = dir;
		this.served = served;

		if (!existsSync(join(dir, "HEAD"))) this.git(["init", "--bare", "-q"]);
	}

	git(
		args: readonly string[],
		input?: Buffer | string,
		env: Record<string, string> = {},
	): GitResult {
		const result = spawnSync("git", args, {
			cwd: this.dir,
			input,
			env: {
				PATH: process.env.PATH ?? "",
				GIT_CONFIG_NOSYSTEM: "1",
				GIT_CONFIG_GLOBAL: "/dev/null",
				GIT_DIR: this.dir,
				...env,
			},
		});

		return { code: result.status ?? 1, stdout: result.stdout };
	}

	out(args: readonly string[], input?: Buffer | string, env = {}): string {
		const result = this.git(args, input, env);

		if (result.code !== 0) throw new Error(`git ${args.join(" ")} failed`);

		return result.stdout.toString("utf8").trim();
	}

	typeOf(sha: string): string | null {
		const result = this.git(["cat-file", "-t", sha]);

		return result.code === 0 ? result.stdout.toString("utf8").trim() : null;
	}

	refOf(name: string): string | null {
		const result = this.git([
			"rev-parse",
			"-q",
			"--verify",
			`refs/heads/${name}`,
		]);

		return result.code === 0 ? result.stdout.toString("utf8").trim() : null;
	}

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

		return this.answer(method, path, objectOf(body));
	};

	answer(
		method: string,
		path: string,
		body: ReturnType<typeof objectOf>,
	): ExecResult {
		const ok = (value: JsonValue): ExecResult => ({
			code: 0,
			stdout: JSON.stringify(value),
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

			return ok({ sha: this.out(["hash-object", "-w", "--stdin"], bytes) });
		}

		if (method === "POST" && path === "git/trees") {
			const scratch = mkdtempSync(join(tmpdir(), "real-git-index-"));
			const env = { GIT_INDEX_FILE: join(scratch, "index") };

			try {
				const base = textOf(fieldOf(body, "base_tree"));
				this.out(
					base === null ? ["read-tree", "--empty"] : ["read-tree", base],
					undefined,
					env,
				);

				const info = (arrayOf(fieldOf(body, "tree")) ?? []).map((entry) => {
					const item = objectOf(entry);
					const name = textOf(fieldOf(item, "path")) ?? "";
					const sha = textOf(fieldOf(item, "sha"));
					const mode = textOf(fieldOf(item, "mode")) ?? "";

					return sha === null
						? `0 ${ZERO}\t${name}\n`
						: `${mode} ${sha}\t${name}\n`;
				});

				this.out(["update-index", "--index-info"], info.join(""), env);

				return ok({ sha: this.out(["write-tree"], undefined, env) });
			} finally {
				rmSync(scratch, { recursive: true, force: true });
			}
		}

		if (method === "GET" && path.startsWith("git/trees/")) {
			const sha = path.slice("git/trees/".length).replace(/\?.*$/, "");

			if (this.typeOf(sha) !== "tree") return no(404);
			const listing = this.git(["ls-tree", "-r", "-t", "-z", sha]).stdout;

			return ok({
				sha,
				truncated: false,
				tree: listing
					.toString("utf8")
					.split("\0")
					.filter((line) => line !== "")
					.map((line) => {
						const [meta = "", name = ""] = line.split("\t");
						const [mode = "", type = "", object = ""] = meta.split(" ");

						return { path: name, mode, type, sha: object };
					}),
			});
		}

		if (method === "GET" && path.startsWith("git/blobs/")) {
			const sha = path.slice("git/blobs/".length);

			if (this.typeOf(sha) !== "blob") return no(404);
			const bytes = this.git(["cat-file", "blob", sha]).stdout;

			return ok({ sha, encoding: "base64", content: bytes.toString("base64") });
		}

		if (method === "POST" && path === "git/commits") {
			const tree = textOf(fieldOf(body, "tree")) ?? "";

			const parents = (arrayOf(fieldOf(body, "parents")) ?? []).map(
				(p) => textOf(p) ?? "",
			);

			const message = textOf(fieldOf(body, "message")) ?? "";
			const author = objectOf(fieldOf(body, "author"));
			const committer = objectOf(fieldOf(body, "committer"));

			const when = (actor: ReturnType<typeof objectOf>) =>
				`@${Date.parse(textOf(fieldOf(actor, "date")) ?? "") / 1000} +0000`;

			return ok({
				sha: this.out(
					[
						"commit-tree",
						tree,
						...parents.flatMap((p) => ["-p", p]),
						"-F",
						"-",
					],
					message,
					{
						GIT_AUTHOR_NAME: textOf(fieldOf(author, "name")) ?? "",
						GIT_AUTHOR_EMAIL: textOf(fieldOf(author, "email")) ?? "",
						GIT_AUTHOR_DATE: when(author),
						GIT_COMMITTER_NAME: textOf(fieldOf(committer, "name")) ?? "",
						GIT_COMMITTER_EMAIL: textOf(fieldOf(committer, "email")) ?? "",
						GIT_COMMITTER_DATE: when(committer),
					},
				),
			});
		}

		if (method === "GET" && path.startsWith("git/commits/")) {
			const sha = path.slice("git/commits/".length);

			if (this.typeOf(sha) !== "commit") return no(404);

			const header =
				this.out(["cat-file", "commit", sha]).split("\n\n")[0] ?? "";

			const lines = header.split("\n");

			return ok({
				sha,
				tree: { sha: lines[0]?.slice("tree ".length) ?? "" },
				parents: lines
					.filter((line) => line.startsWith("parent "))
					.map((line) => ({ sha: line.slice("parent ".length) })),
			});
		}

		if (method === "POST" && path === "git/refs") {
			const ref = textOf(fieldOf(body, "ref")) ?? "";
			const sha = textOf(fieldOf(body, "sha")) ?? "";

			if (this.git(["update-ref", ref, sha, ZERO]).code !== 0) return no(422);

			return ok({ ref, object: { sha } });
		}

		if (method === "GET" && path.startsWith("git/ref/heads/")) {
			const name = path.slice("git/ref/heads/".length);
			const sha = this.refOf(name);

			return sha === null
				? no(404)
				: ok({ ref: `refs/heads/${name}`, object: { sha, type: "commit" } });
		}

		if (method === "PATCH" && path.startsWith("git/refs/heads/")) {
			const name = path.slice("git/refs/heads/".length);
			const current = this.refOf(name);
			const next = textOf(fieldOf(body, "sha")) ?? "";

			if (
				current === null ||
				fieldOf(body, "force") !== false ||
				this.typeOf(next) !== "commit" ||
				this.git(["merge-base", "--is-ancestor", current, next]).code !== 0 ||
				this.git(["update-ref", `refs/heads/${name}`, next, current]).code !== 0
			)
				return no(422);

			return ok({ ref: `refs/heads/${name}`, object: { sha: next } });
		}

		throw new Error(`unexpected ${method} ${path}`);
	}

	/** The bytes of a path at a ref, read by real Git. */
	show(ref: string, path: string): Buffer {
		const result = this.git(["show", `refs/heads/${ref}:${path}`]);

		if (result.code !== 0) throw new Error(`git show ${ref}:${path} failed`);

		return result.stdout;
	}
}
