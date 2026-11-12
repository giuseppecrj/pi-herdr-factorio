import { resolve } from "node:path";
import { parseArgs } from "node:util";
import { isRepoSlug, type RepoSlug } from "../../src/trust/platform.ts";
import { readLock, readStatus } from "../controller/state.ts";
import {
	type ControllerReads,
	type FeedEntry,
	ownerFeed,
	type OwnerFeed,
	ownerHeader,
	type OwnerHeader,
	ownerRun,
	type RunReads,
} from "../../src/views/feed.ts";
import { readStoredVerdict } from "../controller/state.ts";
import { readStageReceipt } from "../sandbox/receipts.ts";
import { type CliIo, EXIT } from "./platform.ts";

export async function runOwnerFeedCli(
	argv: readonly string[],
	io: CliIo,
): Promise<number> {
	try {
		const { values, positionals } = parseArgs({
			args: [...argv],
			allowPositionals: true,
			strict: true,
			options: {
				json: { type: "boolean" },
				"state-dir": { type: "string" },
				repo: { type: "string" },
			},
		});

		if (
			values.json !== true ||
			!values["state-dir"] ||
			positionals.length > 0 ||
			(values.repo !== undefined && !isRepoSlug(values.repo))
		)
			throw new Error("usage");
		const repo = values.repo;
		io.stdout(
			`${JSON.stringify(await readOwnerFeed({ stateDir: values["state-dir"], repo: repo !== undefined && isRepoSlug(repo) ? repo : undefined }), null, 2)}\n`,
		);

		return EXIT.ok;
	} catch {
		io.stderr(
			"Usage: node host/cli/index.ts owner-feed --json --state-dir <dir> [--repo <owner/name>]\n",
		);

		return EXIT.usage;
	}
}

const RUN_READS: RunReads = { readStoredVerdict, readStageReceipt };

function controllerReads(root: string): ControllerReads {
	return {
		readStatus: () => readStatus(root),
		readLock: () => readLock(root),
	};
}

export async function readOwnerHeader(
	stateDir: string,
	now = Date.now(),
	repo?: RepoSlug | null,
): Promise<OwnerHeader> {
	const root = resolve(stateDir);

	return ownerHeader(root, controllerReads(root), now, repo);
}

export async function readOwnerFeed(input: {
	stateDir: string;
	repo?: RepoSlug | null;
	now?: number;
}): Promise<OwnerFeed> {
	const root = resolve(input.stateDir);

	return ownerFeed({
		stateDir: root,
		repo: input.repo,
		now: input.now ?? Date.now(),
		controller: controllerReads(root),
		host: RUN_READS,
	});
}

export async function readOwnerRun(
	stateDir: string,
	runId: string,
	feed: OwnerHeader & { entries?: OwnerFeed["entries"] },
): Promise<FeedEntry | null> {
	return ownerRun(stateDir, runId, feed, {
		...RUN_READS,
		readStatus: () => readStatus(resolve(stateDir)),
	});
}
