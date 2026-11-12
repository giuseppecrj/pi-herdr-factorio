import { createHash } from "node:crypto";
import { lstat, readdir, readFile, readlink } from "node:fs/promises";
import { join } from "node:path";
import type { PinnedVersions } from "../sandbox/result.ts";

/** The versions `host/bundle/assets/package-lock.json` pins. A test keeps them in step. */
export const PINNED_VERSIONS: PinnedVersions = {
	pi: "1.4.0",
	piHerdrAgents: "3.3.1",
	piHerdrPstack: "0.5.0",
};

async function walk(
	root: string,
	relative: string,
	lines: string[],
): Promise<boolean> {
	const entries = await readdir(join(root, relative));

	for (const name of entries) {
		const path = relative === "" ? name : `${relative}/${name}`;
		const full = join(root, path);
		const stat = await lstat(full);

		if (stat.isDirectory()) {
			if (!(await walk(root, path, lines))) return false;
		} else if (stat.isSymbolicLink()) {
			lines.push(`symlink ${await readlink(full)} ${path}`);
		} else if (stat.isFile()) {
			const hash = createHash("sha256")
				.update(await readFile(full))
				.digest("hex");

			lines.push(
				`file ${(stat.mode & 0o111) === 0 ? "644" : "755"} ${hash} ${path}`,
			);
		} else {
			return false;
		}
	}

	return true;
}

function pathOf(line: string): string {
	return line.slice(line.lastIndexOf(" ") + 1);
}

/**
 * One line per file or symlink under the bundle, sorted by path. Files
 * carry their sha256 and exec bit; symlinks their target. Directories are
 * implied. A socket, device or FIFO refuses the bundle with `null`.
 */
export async function manifestLines(root: string): Promise<string[] | null> {
	const lines: string[] = [];

	try {
		if (!(await walk(root, "", lines))) return null;
	} catch {
		return null;
	}

	return lines.sort((left, right) => {
		const a = pathOf(left);
		const b = pathOf(right);

		return a < b ? -1 : a > b ? 1 : 0;
	});
}

/** The sha256 of the sorted manifest listing: the receipt's assets digest. */
export async function manifestDigest(root: string): Promise<string | null> {
	const lines = await manifestLines(root);

	return lines === null
		? null
		: createHash("sha256")
				.update(`${lines.join("\n")}\n`)
				.digest("hex");
}

/** Bundle path, then checkout path, of each single file `provision.sh` copies in. */
const ASSET_FILES: readonly (readonly [string, string])[] = [
	["sandbox/pi.ts", "host/bundle/assets/pi.ts"],
	["sandbox/stage-init.ts", "host/bundle/assets/stage-init.ts"],
	["pkg/package.json", "host/bundle/assets/package.json"],
	["pkg/package-lock.json", "host/bundle/assets/package-lock.json"],
];

async function fileLine(path: string, name: string): Promise<string> {
	const hash = createHash("sha256")
		.update(await readFile(path))
		.digest("hex");

	return `${hash} ${name}`;
}

async function skillLines(skills: string): Promise<string[]> {
	const lines: string[] = [];

	for (const skill of await readdir(skills, { withFileTypes: true })) {
		if (!skill.isDirectory()) continue;

		const dir = join(skills, skill.name);

		for (const file of await readdir(dir, { withFileTypes: true })) {
			if (file.isFile())
				lines.push(
					await fileLine(
						join(dir, file.name),
						`skills/${skill.name}/${file.name}`,
					),
				);
		}
	}

	return lines;
}

/**
 * Whether the installed bundle holds the checkout's own copy of every input
 * `host/install/provision.sh` copies in: each skill's top-level files, `pi.ts`,
 * `stage-init.ts` and the pinned package files. The Node tarball, Herdr and
 * the npm tree cannot be rebuilt cheaply, so they are not compared. Their
 * pins live in `provision.sh` and `package-lock.json`, and a change to the
 * lockfile is compared. Any read error is a mismatch.
 */
export async function bundleMatchesSource(
	sourceRoot: string,
	bundleDir: string,
): Promise<boolean> {
	try {
		const source = [
			...(await skillLines(join(sourceRoot, "skills"))),
			...(await Promise.all(
				ASSET_FILES.map(([name, path]) =>
					fileLine(join(sourceRoot, path), name),
				),
			)),
		];

		const bundle = [
			...(await skillLines(join(bundleDir, "skills"))),
			...(await Promise.all(
				ASSET_FILES.map(([name]) => fileLine(join(bundleDir, name), name)),
			)),
		];

		return source.sort().join("\n") === bundle.sort().join("\n");
	} catch {
		return false;
	}
}

if (import.meta.main) {
	const digest = await manifestDigest(process.argv[2] ?? "");

	if (digest === null) {
		process.stderr.write("manifest: the bundle cannot be read\n");
		process.exitCode = 1;
	} else {
		process.stdout.write(`${digest}\n`);
	}
}
