import { createHash } from "node:crypto";
import { lstat, readdir, readFile, readlink } from "node:fs/promises";
import { join } from "node:path";
import type { PinnedVersions } from "./result.ts";

/** The versions `server/sandbox/assets/package-lock.json` pins. A test keeps them in step. */
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

if (import.meta.main) {
	const digest = await manifestDigest(process.argv[2] ?? "");

	if (digest === null) {
		process.stderr.write("manifest: the bundle cannot be read\n");
		process.exitCode = 1;
	} else {
		process.stdout.write(`${digest}\n`);
	}
}
