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

export const ticket: TicketRef = {
	provider: "github",
	key: "giuseppecrj/pi-herdr-factorio#42",
	url: "https://github.com/giuseppecrj/pi-herdr-factorio/issues/42",
};

export const contractDigest = digestOf("contract");
export const acceptanceDigest = digestOf("acceptance");

export function patch(name: string): Digest {
	return digestOf(`patch:${name}`);
}

export function newRun(): Run {
	return startRun({
		id: "run-1",
		ticket,
		repo: "giuseppecrj/pi-herdr-factorio",
		baseSha: "a".repeat(40),
	});
}

export const candidateEvent = {
	kind: "candidate",
	candidateSha: "c".repeat(40),
	heldoutDigest: digestOf("heldout"),
	ciRunId: 123,
} as const;

export const currentHead = {
	currentTip: "c".repeat(40),
	currentGate: "a".repeat(40),
};

export const ciBinding = {
	...candidateEvent,
	acceptanceDigest,
	gateSha: currentHead.currentGate,
};

export function passingVerdict(patchDigest: Digest): Verdict {
	return {
		patchDigest,
		acceptanceDigest,
		heldoutDigest: candidateEvent.heldoutDigest,
		candidateSha: candidateEvent.candidateSha,
		ciRunId: candidateEvent.ciRunId,
		gateSha: currentHead.currentGate,
		originalBase: "a".repeat(40),
		baseSha: "a".repeat(40),
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

export function reachValidate(name = "first"): Run {
	return apply(
		reachBuild(),
		{ kind: "built", patchDigest: patch(name) },
		candidateEvent,
	);
}

export function reachReview(name = "first"): Run {
	return apply(reachValidate(name), {
		kind: "validated",
		verdict: passingVerdict(patch(name)),
	});
}

export function reachLand(name = "first"): Run {
	return apply(reachReview(name), { kind: "reviewed", blockingFindings: [] });
}

export function stageOf(run: Run): string {
	return run.progress.kind === "active" ? run.progress.stage : "finished";
}
