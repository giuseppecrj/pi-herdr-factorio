import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
	cpSync,
	existsSync,
	lstatSync,
	mkdirSync,
	mkdtempSync,
	readdirSync,
	readFileSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { dirname, join, resolve } from "node:path";
import type { ReplacedTest } from "../../src/contract/contract.ts";
import { hasControl } from "../../src/contract/parse.ts";
import {
	arrayOf,
	fieldOf,
	objectOf,
	parseJson,
	textOf,
} from "../../src/core/json.ts";
import { digestOf, isDigest } from "../../src/core/run.ts";
import {
	ACCEPTANCE_SUITE_DIR,
	ACCEPTANCE_SUITE_PREFIX,
	CONTROL_PLANE_PREFIX,
} from "../../src/trust/protected-paths.ts";
import { CLEAN_ENV, command } from "./runner.ts";

export const MATERIALIZER_FILES = [
	"host/gates/gates.ts",
	"host/gates/materialize.ts",
	"host/gates/manifest.ts",
	"host/gates/runner.ts",
	"host/gates/base.ts",
	"host/gates/draft-reporter.mjs",
] as const;

export function materializerIdentity(tree: string): Buffer {
	return Buffer.from(
		JSON.stringify(
			MATERIALIZER_FILES.map((path) => {
				const file = join(tree, path);
				const stat = lstatSync(file);

				if (!stat.isFile()) throw new Error("unsupported_materializer");

				return [path, digestOf(readFileSync(file))];
			}),
		),
	);
}

export const SOURCE = [
	"src",
	"extension",
	"host",
	"skills",
	"scripts",
	".pi/skills",
	"docs/models",
];

export const SHA = /^[a-f0-9]{40}$/;

function isDocumentation(path: string): boolean {
	return (
		path.endsWith(".md") &&
		!path.startsWith(CONTROL_PLANE_PREFIX) &&
		!path.startsWith(".pi/") &&
		!path.startsWith(ACCEPTANCE_SUITE_PREFIX) &&
		!SOURCE.some((dir) => path.startsWith(`${dir}/`))
	);
}

const CONFIG = new Set([
	"biome.json",
	"biome.jsonc",
	".editorconfig",
	".gitignore",
	".eslintignore",
	".prettierignore",
]);

export async function git(
	repository: string,
	args: readonly string[],
): Promise<string> {
	const result = await command(
		"git",
		["-C", resolve(repository), ...args],
		repository,
	);

	if (result.exitCode !== 0) throw new Error("git_failed");

	return result.stdout;
}

export function safePath(path: string): boolean {
	return (
		path.length > 0 &&
		path.length < 512 &&
		!hasControl(path) &&
		!/[\\:]/.test(path) &&
		path
			.split("/")
			.every(
				(p) =>
					p !== "" &&
					p !== "." &&
					p !== ".." &&
					p !== ".git" &&
					p !== "node_modules",
			)
	);
}

export async function entries(
	repository: string,
	sha: string,
): Promise<Map<string, { mode: string; blob: string }>> {
	if (!SHA.test(sha)) throw new Error("invalid_sha");
	const entries = new Map<string, { mode: string; blob: string }>();

	for (const row of (
		await git(repository, ["ls-tree", "-rz", "--full-tree", sha])
	).split("\0")) {
		if (!row) continue;
		const match = /^(100644|100755) blob ([a-f0-9]{40})\t(.+)$/.exec(row);

		if (match === null || !safePath(match[3] ?? ""))
			throw new Error("unsafe_tree");
		entries.set(match[3] ?? "", { mode: match[1] ?? "", blob: match[2] ?? "" });
	}

	if (entries.size > 10000) throw new Error("tree_too_large");

	return entries;
}

export async function exportTree(
	repository: string,
	sha: string,
	dest: string,
): Promise<void> {
	const files = await entries(repository, sha);
	mkdirSync(dest, { recursive: true, mode: 0o755 });

	const bytes = execFileSync(
		"git",
		["-C", resolve(repository), "cat-file", "--batch"],
		{
			input: [...files.values()].map((entry) => entry.blob).join("\n") + "\n",
			env: CLEAN_ENV,
			timeout: 90000,
			maxBuffer: 128 * 1024 * 1024,
		},
	);

	let at = 0;

	for (const [path, entry] of files) {
		const end = bytes.indexOf(10, at);
		const header = bytes.subarray(at, end).toString();
		const match = /^([a-f0-9]{40}) blob (\d+)$/.exec(header);
		const size = Number(match?.[2]);

		if (
			end < 0 ||
			match?.[1] !== entry.blob ||
			!Number.isSafeInteger(size) ||
			size < 0 ||
			end + size + 1 >= bytes.length
		)
			throw new Error("unsafe_tree");
		mkdirSync(dirname(join(dest, path)), { recursive: true, mode: 0o755 });
		writeFileSync(join(dest, path), bytes.subarray(end + 1, end + 1 + size), {
			mode: entry.mode === "100755" ? 0o755 : 0o644,
		});
		at = end + size + 2;
	}
}

export function replacementDigest(
	replacements: readonly ReplacedTest[],
): string {
	return createHash("sha256")
		.update(JSON.stringify(replacements))
		.digest("hex");
}

export function replacementsOf(text: string): readonly ReplacedTest[] {
	const list = arrayOf(parseJson(text));

	if (list === null || list.length > 50)
		throw new Error("invalid_replacements");
	const seen = new Set<string>();

	return list.map((item) => {
		const obj = objectOf(item);
		const path = textOf(fieldOf(obj, "path")) ?? "";
		const reason = textOf(fieldOf(obj, "reason")) ?? "";

		if (
			obj === null ||
			Object.keys(obj).some((k) => k !== "path" && k !== "reason") ||
			!safePath(path) ||
			!path.startsWith("test/") ||
			path.startsWith(ACCEPTANCE_SUITE_PREFIX) ||
			!/\.(?:test|cases)\.[cm]?[jt]s$/.test(path) ||
			!reason.trim() ||
			reason.length > 500 ||
			hasControl(reason) ||
			seen.has(path)
		)
			throw new Error("invalid_replacements");
		seen.add(path);

		return { path, reason };
	});
}

type Inventory = ReadonlyMap<string, { mode: string; blob: string }>;

function checkReplacements(
	base: Inventory,
	candidate: Inventory,
	list: readonly ReplacedTest[],
): readonly ReplacedTest[] {
	const replacements = replacementsOf(JSON.stringify(list));

	for (const item of replacements) {
		if (!base.has(item.path)) throw new Error("invalid_replacements");

		if (!candidate.has(item.path)) throw new Error("replacement_deleted");
	}

	return replacements;
}

function overlay(input: {
	readonly base: Inventory;
	readonly candidate: Inventory;
	readonly candidateDir: string;
	readonly dest: string;
	readonly replacements: readonly ReplacedTest[];
	readonly heldoutDir?: string;
	readonly heldoutDigest?: string;
}) {
	const { base, candidate, replacements } = input;
	const source = input.candidateDir;
	const ignoredChanges: string[] = [];
	const newTests: string[] = [];
	const heldout = heldoutOf(source, input.heldoutDir, input.heldoutDigest);

	for (const [path, entry] of candidate)
		if (
			path.startsWith(ACCEPTANCE_SUITE_PREFIX) &&
			(entry.blob !== base.get(path)?.blob ||
				entry.mode !== base.get(path)?.mode) &&
			!heldout.includes(path)
		)
			throw new Error("unauthorized_acceptance");
	rmSync(join(input.dest, ACCEPTANCE_SUITE_DIR), {
		recursive: true,
		force: true,
	});

	for (const dir of SOURCE) {
		rmSync(join(input.dest, dir), { recursive: true, force: true });

		if (existsSync(join(source, dir)))
			cpSync(join(source, dir), join(input.dest, dir), {
				recursive: true,
			});
	}

	for (const path of base.keys())
		if (isDocumentation(path) && !candidate.has(path))
			rmSync(join(input.dest, path), { force: true });

	for (const [path, item] of candidate) {
		if (isDocumentation(path)) {
			if (item.blob !== base.get(path)?.blob) {
				mkdirSync(dirname(join(input.dest, path)), { recursive: true });
				cpSync(join(source, path), join(input.dest, path));
			}

			continue;
		}

		const fromSource = SOURCE.some((dir) => path.startsWith(`${dir}/`));
		const replacement = replacements.some((r) => r.path === path);

		const additional =
			path.startsWith("test/") &&
			(!base.has(path) || path.startsWith(ACCEPTANCE_SUITE_PREFIX));

		if (
			path.split("/").at(-1) === ".npmrc" &&
			item.blob !== base.get(path)?.blob
		)
			throw new Error("npmrc_changed");

		if (additional || replacement) {
			mkdirSync(dirname(join(input.dest, path)), { recursive: true });
			cpSync(join(source, path), join(input.dest, path));

			if (
				additional &&
				/\.(?:test|cases)\.[cm]?[jt]s$/.test(path) &&
				!path.startsWith(ACCEPTANCE_SUITE_PREFIX)
			)
				newTests.push(path);
		}

		if (
			(fromSource || additional) &&
			CONFIG.has(path.split("/").at(-1) ?? "")
		) {
			rmSync(join(input.dest, path), { force: true });
			ignoredChanges.push(path);
		} else if (
			!fromSource &&
			!additional &&
			!replacement &&
			item.blob !== base.get(path)?.blob &&
			path !== "package-lock.json" &&
			path !== "package.json"
		)
			ignoredChanges.push(path);
	}

	for (const path of base.keys())
		if (path.split("/").at(-1) === ".npmrc" && !candidate.has(path))
			throw new Error("npmrc_changed");

	return { ignoredChanges: ignoredChanges.sort(), newTests: newTests.sort() };
}

export async function materializeCandidate(input: {
	readonly repository: string;
	readonly gateSha: string;
	readonly candidateSha: string;
	readonly dest: string;
	readonly replacements: readonly ReplacedTest[];
	readonly heldoutDir?: string;
	readonly heldoutDigest?: string;
}) {
	const base = await entries(input.repository, input.gateSha);
	const candidate = await entries(input.repository, input.candidateSha);
	const replacements = checkReplacements(base, candidate, input.replacements);
	await exportTree(input.repository, input.gateSha, input.dest);
	const temp = mkdtempSync(join(dirname(input.dest), "candidate-"));

	try {
		await exportTree(input.repository, input.candidateSha, join(temp, "tree"));

		return overlay({
			...input,
			base,
			candidate,
			candidateDir: join(temp, "tree"),
			replacements,
		});
	} finally {
		rmSync(temp, { recursive: true, force: true });
	}
}

function inventory(tree: string): Inventory {
	const found = new Map<string, { mode: string; blob: string }>();

	const walk = (rel: string) => {
		for (const entry of readdirSync(join(tree, rel), { withFileTypes: true })) {
			const path = rel ? `${rel}/${entry.name}` : entry.name;
			const stat = lstatSync(join(tree, path));

			if (
				!safePath(path) ||
				entry.name === ".gitattributes" ||
				stat.isSymbolicLink() ||
				(!stat.isDirectory() && !stat.isFile())
			)
				throw new Error("unsafe_tree");

			if (stat.isDirectory()) walk(path);
			else
				found.set(path, {
					mode: stat.mode & 0o111 ? "100755" : "100644",
					blob: digestOf(readFileSync(join(tree, path))),
				});
		}
	};

	walk("");

	if (found.size > 10000) throw new Error("tree_too_large");

	return found;
}

export function materializeFromDirectories(input: {
	readonly gateTree: string;
	readonly candidateTree: string;
	readonly dest: string;
	readonly replacements: readonly ReplacedTest[];
	readonly heldoutDir?: string;
	readonly heldoutDigest?: string;
}) {
	const base = inventory(input.gateTree);
	const candidate = inventory(input.candidateTree);
	const replacements = checkReplacements(base, candidate, input.replacements);
	cpSync(input.gateTree, input.dest, { recursive: true, errorOnExist: true });

	return overlay({
		...input,
		base,
		candidate,
		candidateDir: input.candidateTree,
		replacements,
	});
}

export function heldoutDigest(
	files: readonly { path: string; bytes: Buffer }[],
): string {
	return createHash("sha256")
		.update(
			JSON.stringify(
				files
					.toSorted((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0))
					.map((f) => [
						f.path,
						createHash("sha256").update(f.bytes).digest("hex"),
					]),
			),
		)
		.digest("hex");
}

export function heldoutOf(
	tree: string,
	directory?: string,
	digest?: string,
): string[] {
	if (!directory && !digest) return [];

	if (
		!directory ||
		!digest ||
		!isDigest(digest) ||
		!directory.startsWith(ACCEPTANCE_SUITE_PREFIX) ||
		!/^[a-zA-Z0-9_-]+$/.test(directory.slice(ACCEPTANCE_SUITE_PREFIX.length)) ||
		!existsSync(join(tree, directory, "checks"))
	)
		throw new Error("heldout_digest_mismatch");

	const files = readdirSync(join(tree, directory, "checks"), {
		withFileTypes: true,
	});

	if (
		!files.length ||
		files.some(
			(f) =>
				!f.isFile() ||
				!/^[a-zA-Z0-9_.-]+\.(?:test|cases)\.[cm]?[jt]s$/.test(f.name),
		)
	)
		throw new Error("heldout_digest_mismatch");
	const paths = files.map((f) => `${directory}/checks/${f.name}`).sort();

	if (
		heldoutDigest(
			paths.map((path) => ({ path, bytes: readFileSync(join(tree, path)) })),
		) !== digest
	)
		throw new Error("heldout_digest_mismatch");

	return paths;
}
