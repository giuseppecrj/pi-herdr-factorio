import { execFile } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { performance } from "node:perf_hooks";
import {
	readFeedGeneration,
	refreshFeedGeneration,
} from "../../../host/controller/feed-generation.ts";
import { ownerState, now } from "./state.ts";

const run = promisify(execFile);
const cwd = fileURLToPath(new URL("../../../", import.meta.url));
const root = await mkdtemp(join(tmpdir(), "feed-generation-cost-"));

function median(values: readonly number[]): number {
	const sorted = [...values].sort((a, b) => a - b);
	const middle = sorted.length / 2;

	return (
		((sorted[Math.floor(middle)] ?? 0) + (sorted[Math.ceil(middle) - 1] ?? 0)) /
		2
	);
}

try {
	await ownerState(root);

	if (!(await refreshFeedGeneration({ stateDir: root, now })))
		throw new Error("generation_missing");
	const signalMs: number[] = [];
	const cliMs: number[] = [];
	const publishMs: number[] = [];

	for (let index = 0; index < 1000; index++) {
		const start = performance.now();

		if ((await readFeedGeneration(root)) === null)
			throw new Error("generation_unreadable");

		signalMs.push(performance.now() - start);
	}

	for (let index = 0; index < 10; index++) {
		let start = performance.now();

		const { stdout } = await run(
			process.execPath,
			["host/cli/index.ts", "owner-feed", "--json", "--state-dir", root],
			{ cwd },
		);

		if (JSON.parse(stdout).version !== 1) throw new Error("feed_unavailable");
		cliMs.push(performance.now() - start);
		start = performance.now();

		if (!(await refreshFeedGeneration({ stateDir: root, now })))
			throw new Error("publish_failed");
		publishMs.push(performance.now() - start);
	}

	console.log(
		JSON.stringify(
			{
				node: process.version,
				fixture: "ownerState, seven visible runs",
				cliMs,
				cliMedianMs: median(cliMs),
				signalReads: signalMs.length,
				signalMedianMs: median(signalMs),
				unchangedPublishMedianMs: median(publishMs),
				note: "Signal timing is a validated file read in a resident bridge. CLI timing includes process and module startup. Local synthetic state, not production VM evidence.",
			},
			null,
			2,
		),
	);
} finally {
	await rm(root, { recursive: true, force: true });
}
