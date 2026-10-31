import assert from "node:assert/strict";
import {
	type Digest,
	digestOf,
	type Run,
	startRun,
	type TicketRef,
	type Verdict,
	REQUIRED_CI_CHECKS,
} from "../src/run.ts";
import { advance, type RunEvent } from "../src/stages.ts";
import type { AdmissionPin } from "../src/handoff.ts";
import type { PatchReceipt } from "../src/build.ts";
import { isGitSha, isRepoSlug } from "../src/workflow.ts";

export const ticket: TicketRef = {
	provider: "github",
	key: "giuseppecrj/pi-herdr-factorio#42",
	url: "https://github.com/giuseppecrj/pi-herdr-factorio/issues/42",
};

export const contractDigest = digestOf("contract");
export const acceptanceDigest = digestOf("acceptance");
const repo = "giuseppecrj/pi-herdr-factorio";
const base = "a".repeat(40);

if (!isRepoSlug(repo) || !isGitSha(base)) throw new Error("fixture");

export const admissionPin: AdmissionPin = {
	runId: digestOf("run"),
	repo,
	issue: 42,
	originalBase: base,
	workflowSha: base,
	workflowDigest: digestOf("workflow"),
	contractDigest,
	acceptanceDigest,
	maxTokens: 500_000,
	maxReviewAttempts: 3,
};

export function patch(name: string): Digest {
	return digestOf(`patch:${name}`);
}

export function newRun(): Run {
	return startRun({ id: admissionPin.runId, ticket, repo, baseSha: base });
}

export const ciCandidate = {
	candidateSha: "c".repeat(40),
	heldoutDigest: digestOf("heldout"),
	ciRunId: 123,
};

export function passingVerdict(patchDigest: Digest): Verdict {
	return {
		patchDigest,
		acceptanceDigest,
		...ciCandidate,
		gateSha: base,
		originalBase: base,
		baseSha: base,
		unjudged: [],
		pass: true,
		requiredChecks: [...REQUIRED_CI_CHECKS],
		checks: REQUIRED_CI_CHECKS.map((name) => ({ name, passed: true })),
	};
}

export function failingVerdict(patchDigest: Digest): Verdict {
	const verdict = passingVerdict(patchDigest);

	return {
		...verdict,
		pass: false,
		checks: verdict.checks.map((check) =>
			check.name === "heldout"
				? { ...check, passed: false, detail: "1 failing" }
				: check,
		),
	};
}

export function patchReceipt(name = "first"): PatchReceipt {
	return {
		version: 1,
		runId: admissionPin.runId,
		round: 0,
		baseSha: base,
		contractDigest,
		acceptanceDigest,
		patchDigest: patch(name),
		changedPaths: ["src/example.ts"],
		policy: "clean",
		testCommand: "npm test",
		model: "openai/gpt-6.1-sol",
		observed: null,
		commands: [],
		commandsSource: "builder-reported",
		commandsOmitted: 0,
		scriptsChanged: false,
		testScriptChanged: false,
		testInputsChanged: false,
		visibleTests: { command: "npm test", exitCode: 0, tail: "", wallMs: 1 },
	};
}

export function builtEvent(
	name = "first",
): Extract<RunEvent, { kind: "built" }> {
	return {
		kind: "built",
		pin: admissionPin,
		patch: patchReceipt(name),
		priorTokens: 1234,
	};
}

export function apply(run: Run, ...events: RunEvent[]): Run {
	let current = run;

	for (const event of events) {
		const result = advance(current, event);
		assert.equal(
			result.kind,
			"advanced",
			`${event.kind} rejected: ${result.kind === "invalid" ? result.reason : ""}`,
		);
		current = result.run;
	}

	return current;
}

export function reachBuild(): Run {
	return apply(
		newRun(),
		{ kind: "admitted" },
		{ kind: "specified", contractDigest },
		{ kind: "accepted", acceptanceDigest },
	);
}

export function stageOf(run: Run): string {
	return run.progress.kind === "active"
		? run.progress.stage
		: run.progress.kind;
}
