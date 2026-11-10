import { execFile } from "node:child_process";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import type { AttentionKind } from "../../../src/attention.ts";
import {
	addAnsweredRun,
	addFailedRun,
	addRun,
	addWaitingRun,
	emptyState,
	now,
	save,
} from "./state.ts";

const run = promisify(execFile);

const ROOT = fileURLToPath(new URL("../../../", import.meta.url));

/**
 * One capture for each attention kind a v1 feed can carry, plus one for a run
 * that is working. `spec_review` has no capture. `readAttention` reports it as
 * `not_enabled_in_v1`, so no state produces an entry of that kind.
 */
export const CAPTURED_KINDS = [
	"question_asked",
	"question_answered",
	"pr_review",
	"blocked",
	"budget",
	"failed",
] as const satisfies readonly AttentionKind[];

export const CAPTURE_NAMES = [...CAPTURED_KINDS, "working"] as const;

export type CaptureName = (typeof CAPTURE_NAMES)[number];

const BUILDERS = {
	question_asked: async (root) => {
		await addRun(root, 11, "needs_info", {
			title: "Ask before changing the product",
			stage: "specify",
		});
	},
	question_answered: async (root) => {
		await addAnsweredRun(root, 12, "Continue after the owner answered");
	},
	pr_review: async (root) => {
		await addWaitingRun(root, "Let the owner review the dashboard");
	},
	blocked: async (root) => {
		await addRun(root, 14, "blocked", {
			title: "Check the saved input",
			enteredAt: now - 7 * 3_600_000,
		});
	},
	budget: async (root) => {
		await addRun(root, 15, "budget_exhausted", {
			title: "Stop when the token budget is used",
		});
	},
	failed: async (root) => {
		await addFailedRun(root, 16, "Review a change that is too large");
	},
	working: async (root) => {
		const runId = await addRun(root, 17, "running", {
			title: "Render <b>raw</b> **markdown** titles as plain text",
			stage: "build",
		});

		await save(root, ["stages", runId, "build-1", "receipt.json"], {
			version: 1,
			runId,
			stage: "build",
			outcome: { kind: "passed" },
			turns: 3,
			wallMs: 61_000,
			usage: { total: 48_000 },
		});
	},
} satisfies Record<CaptureName, (root: string) => Promise<void>>;

export function captureFile(name: CaptureName): URL {
	return new URL(`./captures/${name}.json`, import.meta.url);
}

/** Lists every way a capture could carry state it must not publish. */
export function redactionProblems(text: string, root: string): string[] {
	return [
		[root, "the temporary state directory"],
		[homedir(), "the home directory"],
		["Fixture only.", "an admission snapshot body"],
	].flatMap(([needle, what]) =>
		needle !== undefined && needle !== "" && text.includes(needle)
			? [`capture contains ${what}`]
			: [],
	);
}

/**
 * Builds the fixture state for `name`, runs the real `owner-feed --json` CLI
 * in a child process with the clock fixed at `now`, and returns its stdout.
 * Throws if the output carries anything `redactionProblems` names.
 */
export async function captureOwnerFeed(name: CaptureName): Promise<string> {
	const root = await mkdtemp(join(tmpdir(), "owner-feed-capture-"));

	try {
		await emptyState(root);
		await BUILDERS[name](root);

		const { stdout } = await run(
			process.execPath,
			[
				"--experimental-strip-types",
				"--import",
				fileURLToPath(new URL("./fixed-clock.ts", import.meta.url)),
				"server/cli.ts",
				"owner-feed",
				"--json",
				"--state-dir",
				root,
			],
			{
				cwd: ROOT,
				env: { ...process.env, OWNER_FEED_FIXED_NOW: String(now) },
			},
		);

		const problems = redactionProblems(stdout, root);

		if (problems.length > 0) throw new Error(problems.join("; "));

		return stdout;
	} finally {
		await rm(root, { recursive: true, force: true });
	}
}

/**
 * Regenerates every capture. Run `node test/fixtures/owner-feed/capture.ts`,
 * then `npx biome format --write test/fixtures/owner-feed`.
 */
if (import.meta.main) {
	await mkdir(new URL("./captures/", import.meta.url), { recursive: true });

	for (const name of CAPTURE_NAMES)
		await writeFile(
			captureFile(name),
			`${JSON.stringify(JSON.parse(await captureOwnerFeed(name)), null, "\t")}\n`,
		);
}
