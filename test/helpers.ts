import assert from "node:assert/strict";
import {
	type Digest,
	digestOf,
	type Run,
	startRun,
	type TicketRef,
	type Verdict,
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

export function passingVerdict(patchDigest: Digest): Verdict {
	return {
		patchDigest,
		pass: true,
		checks: [{ name: "check", passed: true }],
	};
}

export function failingVerdict(patchDigest: Digest): Verdict {
	return {
		patchDigest,
		pass: false,
		checks: [
			{ name: "typecheck", passed: true },
			{ name: "acceptance", passed: false, detail: "1 failing" },
		],
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
	return apply(reachBuild(), { kind: "built", patchDigest: patch(name) });
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
