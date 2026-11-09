import assert from "node:assert/strict";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { fileAdmissionStore, snapshotDigest } from "../../../src/admission.ts";
import { digestOf, runIdOf } from "../../../src/run.ts";
import { isRepoSlug, isGitSha } from "../../../src/workflow.ts";
import type { JsonValue } from "../../../src/tickets.ts";
import { candidateLifecycleFixture } from "../../helpers.ts";
import {
	parseCandidateState,
	candidateUsage,
	candidateProjection,
} from "../../../src/handoff.ts";

const slug = "giuseppecrj/pi-herdr-factorio";

function fixtureSha(text: string) {
	assert.ok(isGitSha(text));

	return text;
}

const sha = fixtureSha("a".repeat(40));

assert.ok(isRepoSlug(slug));

export const repo = slug;
export const now = Date.parse("2026-11-09T18:00:00Z");

export async function save(root: string, parts: string[], value: JsonValue) {
	const path = join(root, ...parts);
	await mkdir(join(path, ".."), { recursive: true, mode: 0o700 });
	await writeFile(path, JSON.stringify(value), { mode: 0o600 });
}

export async function addRun(
	root: string,
	issue: number,
	status: string,
	options: {
		title?: string;
		enteredAt?: number;
		stage?: string;
		eventId?: string;
		seq?: number;
		handoff?: JsonValue;
	} = {},
) {
	const eventId = options.eventId ?? "1";
	const runId = runIdOf({ repo, issue, eventId });

	const snapshot = {
		title: options.title ?? `Ticket ${issue}`,
		body: "Fixture only.",
	};

	await fileAdmissionStore(root).record(
		{
			repo,
			issue,
			issueUrl: `https://github.com/${repo}/issues/${issue}`,
			decision: "admitted",
			reasons: [],
			eventId,
			eventAt: new Date(now - 86_400_000).toISOString().replace(".000Z", "Z"),
			actor: "owner",
			actorPermission: "write",
			snapshotDigest: snapshotDigest(snapshot),
			snapshotSource: "unedited",
			baseSha: sha,
			workflowDigest: digestOf("workflow"),
		},
		snapshot,
	);

	const record = {
		runId,
		issue,
		eventId,
		seq: options.seq ?? 1,
		status,
		stage: options.stage ?? "specify",
		enteredAt: options.enteredAt ?? now - 1000,
		usage: 1234,
		attempt: 1,
		round: 0,
	};

	if (options.handoff === undefined)
		await save(root, ["claims", `${runId}.json`], record);
	else {
		const book = parseCandidateState(options.handoff);
		assert.ok(book !== null);
		await save(root, ["claims", `${runId}.json`], {
			...record,
			handoff: options.handoff,
			usage: candidateUsage(book),
		});
	}

	return runId;
}

export async function ownerState(root: string) {
	await mkdir(join(root, "claims"), { mode: 0o700, recursive: true });
	await save(root, ["status.json"], {
		repo,
		at: new Date(now - 12_000).toISOString(),
		corrupt: [{ issue: 99, defect: "duplicate_seq" }],
	});
	const refreshing = candidateLifecycleFixture();
	assert.ok(refreshing.kind === "selected");

	const certified = refreshing.history.find(
		(entry) => entry.intent.digest === refreshing.published?.promoted.digest,
	);

	assert.ok(
		certified?.certification !== null &&
			certified !== undefined &&
			refreshing.published !== null,
	);

	const ready = {
		...refreshing,
		current: certified,
		history: refreshing.history.filter((entry) => entry !== certified),
		published: {
			...refreshing.published,
			readiness: { kind: "ready", since: now - 4 * 86_400_000 },
		},
		work: { kind: "waiting" },
	};

	const book = parseCandidateState(JSON.parse(JSON.stringify(ready)));
	assert.ok(book !== null);
	const projection = candidateProjection(book);

	const waiting = await addRun(root, 1, projection.status, {
		title: "Let the owner review the dashboard",
		stage: projection.stage,
		enteredAt: now - 4 * 86_400_000,
		handoff: JSON.parse(JSON.stringify(book)),
	});

	await addRun(root, 2, "blocked", {
		title: "Check the saved input",
		enteredAt: now - 7 * 3_600_000,
	});
	await addRun(root, 3, "budget_exhausted", {
		title: "Stop when the token budget is used",
	});

	const failed = await addRun(root, 4, "failed", {
		title: "Review a change that is too large",
		stage: "land",
	});

	await save(root, ["ledger", failed, "terminal.json"], {
		v: 5,
		repo,
		runId: failed,
		terminalObservedAt: new Date(now - 1000).toISOString(),
		outcome: {
			kind: "failed",
			stage: "land",
			cause: { kind: "known", value: "input_refused" },
		},
		failure: {
			kind: "known",
			value: {
				stage: "review",
				class: "input",
				reason: "review_input_too_large",
				failedVisibleChecks: [],
				retainedPatch: null,
			},
		},
	});
	await addRun(root, 5, "running", {
		title: "Build the next small feature",
		stage: "build",
	});

	const landed = await addRun(root, 6, "landed", {
		title: "Keep token accounting honest",
		stage: "land",
		enteredAt: now - 86_400_000,
	});

	await addRun(root, 7, "released", {
		title: "An older closed ticket",
		enteredAt: now - 8 * 86_400_000,
	});
	await addRun(root, 8, "needs_info", {
		title: "Ask before changing the product",
	});
	await addRun(root, 99, "retrying", {
		title: "Unreadable run must not count as working",
	});

	return { waiting, failed, landed };
}
