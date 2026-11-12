import { resolve } from "node:path";
import {
	ownerFeed,
	ownerHeader,
	ownerRun,
	type ControllerReads,
	type FeedEntry,
	type OwnerFeed,
	type OwnerHeader,
	type RunReads,
} from "../../src/feed.ts";
import type { RepoSlug } from "../../src/workflow.ts";
import {
	readLock,
	readStatus,
	readStoredVerdict,
} from "../controller/state.ts";
import { readStageReceipt } from "../sandbox/receipts.ts";

const RUN_READS: RunReads = { readStoredVerdict, readStageReceipt };

async function controllerReads(root: string): Promise<ControllerReads> {
	return { status: await readStatus(root), lock: await readLock(root) };
}

export async function readOwnerHeader(
	stateDir: string,
	now = Date.now(),
	repo?: RepoSlug | null,
): Promise<OwnerHeader> {
	const root = resolve(stateDir);

	return ownerHeader(root, await controllerReads(root), now, repo);
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
		controller: await controllerReads(root),
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
