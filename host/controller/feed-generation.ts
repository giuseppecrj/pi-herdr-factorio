import { constants, type Stats } from "node:fs";
import { lstat, open } from "node:fs/promises";
import { join, resolve } from "node:path";
import { digestOf } from "../../src/core/run.ts";
import { readOwnerFeed } from "../cli/owner-feed.ts";
import { writeAtomic } from "./state.ts";

const FILE = "feed-generation";

function privateOwner(info: Stats): boolean {
	return info.uid === process.geteuid?.() && (info.mode & 0o077) === 0;
}

export async function readFeedGeneration(
	stateDir: string,
): Promise<string | null> {
	try {
		const root = resolve(stateDir);
		const dir = await lstat(root);

		if (!dir.isDirectory() || !privateOwner(dir)) return null;

		const file = await open(
			join(root, FILE),
			constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
		);

		try {
			const info = await file.stat();

			if (!info.isFile() || !privateOwner(info) || info.size !== 65)
				return null;
			const text = await file.readFile("utf8");

			return /^[a-f0-9]{64}\n$/.test(text) ? text.slice(0, -1) : null;
		} finally {
			await file.close();
		}
	} catch {
		return null;
	}
}

export async function refreshFeedGeneration(
	input: Parameters<typeof readOwnerFeed>[0],
): Promise<boolean> {
	try {
		const root = resolve(input.stateDir);
		const dir = await lstat(root);

		if (!dir.isDirectory() || !privateOwner(dir)) return false;
		const path = join(root, FILE);

		const existing = await lstat(path).catch((error: NodeJS.ErrnoException) => {
			if (error.code === "ENOENT") return null;
			throw error;
		});

		const previous = existing === null ? null : await readFeedGeneration(root);

		if (existing !== null && previous === null) return false;
		const feed = await readOwnerFeed(input);

		const generation = digestOf(
			JSON.stringify({
				...feed,
				at: null,
				controller: { ...feed.controller, lastTick: null },
				entries: feed.entries.map((entry) => ({ ...entry, ageMs: null })),
			}),
		);

		return (
			previous === generation || (await writeAtomic(path, `${generation}\n`))
		);
	} catch {
		return false;
	}
}
