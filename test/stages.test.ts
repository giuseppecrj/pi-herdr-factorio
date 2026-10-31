import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { Stage } from "../src/run.ts";
import {
	advance,
	formatStageTable,
	MAX_REPAIR_ROUNDS,
	nextStage,
	STAGE_ORDER,
	STAGE_PROFILES,
} from "../src/stages.ts";
import {
	acceptanceDigest,
	candidateEvent,
	currentHead,
	apply,
	contractDigest,
	failingVerdict,
	newRun,
	passingVerdict,
	patch,
	reachBuild,
	reviewedEvent,
	reachLand,
	reachReview,
	reachValidate,
	stageOf,
} from "./helpers.ts";

describe("stage table", () => {
	it("covers every stage exactly once, in pipeline order", () => {
		const all: Record<Stage, true> = {
			admit: true,
			specify: true,
			accept: true,
			build: true,
			validate: true,
			review: true,
			land: true,
		};

		assert.deepEqual([...STAGE_ORDER].sort(), Object.keys(all).sort());
		assert.deepEqual(
			Object.keys(STAGE_PROFILES).sort(),
			Object.keys(all).sort(),
		);
		assert.equal(new Set(STAGE_ORDER).size, STAGE_ORDER.length);
		assert.equal(STAGE_ORDER[0], "admit");
		assert.equal(STAGE_ORDER.at(-1), "land");
	});

	it("walks forward and ends after land", () => {
		assert.equal(nextStage("admit"), "specify");
		assert.equal(nextStage("review"), "land");
		assert.equal(nextStage("land"), undefined);
	});

	it("renders one row per stage", () => {
		const lines = formatStageTable().split("\n");
		assert.equal(lines.length, STAGE_ORDER.length + 1);
		assert.match(
			lines[0] ?? "",
			/^stage\s+runs in\s+model access\s+github access$/,
		);
		assert.match(lines[1] ?? "", /^admit\s+controller\s+none\s+issues: write$/);
		assert.match(lines[2] ?? "", /^specify\s+sandbox\s+full\s+none$/);
		assert.match(
			lines.at(-1) ?? "",
			/^land\s+controller\s+none\s+contents: write/,
		);
		assert.doesNotMatch(formatStageTable(), /\bread\b|token/);
	});

	it("gives GitHub access only to the controller, never to a model stage", () => {
		for (const stage of STAGE_ORDER) {
			const profile = STAGE_PROFILES[stage];

			if (profile.modelAccess === "none") {
				assert.equal(profile.runsIn, "controller", stage);
				assert.notEqual(profile.githubAccess, "none", stage);
			} else {
				assert.equal(profile.runsIn, "sandbox", stage);
				assert.equal(profile.githubAccess, "none", stage);
			}
		}
	});
});

describe("advance: forward path", () => {
	it("moves through every stage on success and lands", () => {
		const run = newRun();
		assert.equal(stageOf(run), "admit");
		const specify = apply(run, { kind: "admitted" });
		assert.equal(stageOf(specify), "specify");
		const accept = apply(specify, { kind: "specified", contractDigest });
		assert.equal(stageOf(accept), "accept");
		assert.equal(accept.contractDigest, contractDigest);
		const build = apply(accept, { kind: "accepted", acceptanceDigest });
		assert.equal(stageOf(build), "build");
		assert.equal(build.acceptanceDigest, acceptanceDigest);

		const validate = apply(
			build,
			{ kind: "built", patchDigest: patch("a") },
			candidateEvent,
		);

		assert.equal(stageOf(validate), "validate");
		assert.equal(validate.patchDigest, patch("a"));

		const review = apply(validate, {
			kind: "validated",
			verdict: passingVerdict(patch("a")),
		});

		assert.equal(stageOf(review), "review");
		assert.equal(review.verdict?.pass, true);
		const land = apply(review, reviewedEvent("a"));
		assert.equal(stageOf(land), "land");

		const done = apply(land, {
			kind: "landed",
			mergeSha: "b".repeat(40),
			...currentHead,
		});

		assert.deepEqual(done.progress, {
			kind: "finished",
			outcome: { kind: "landed", mergeSha: "b".repeat(40) },
		});
		assert.equal(done.repairRounds, 0);
	});

	it("does not mutate the run it was given", () => {
		const run = newRun();
		const before = structuredClone(run);
		apply(run, { kind: "admitted" });
		assert.deepEqual(run, before);
	});

	it("rejects an event that belongs to another stage", () => {
		const result = advance(newRun(), {
			kind: "built",
			patchDigest: patch("a"),
		});

		assert.deepEqual(result, {
			kind: "invalid",
			reason: "built is not valid during admit",
		});
	});

	it("ignores nothing once finished", () => {
		const done = apply(newRun(), { kind: "cancelled" });
		const result = advance(done, { kind: "admitted" });
		assert.deepEqual(result, {
			kind: "invalid",
			reason: "run already finished: cancelled",
		});
	});
});

describe("advance: needs_info", () => {
	it("ends the run with the questions when specify cannot proceed", () => {
		const run = apply(newRun(), { kind: "admitted" });

		const done = apply(run, {
			kind: "needs_info",
			questions: ["Which API?", "Which platform?"],
		});

		assert.deepEqual(done.progress, {
			kind: "finished",
			outcome: {
				kind: "needs_info",
				questions: ["Which API?", "Which platform?"],
			},
		});
	});

	it("is only valid from specify", () => {
		const result = advance(reachBuild(), {
			kind: "needs_info",
			questions: ["why?"],
		});

		assert.equal(result.kind, "invalid");
	});
});

describe("advance: validate failure and bounded repair", () => {
	it("sends a failing verdict back to build and drops the stale patch and verdict", () => {
		const run = apply(reachValidate("first"), {
			kind: "validated",
			verdict: failingVerdict(patch("first")),
		});

		assert.equal(stageOf(run), "build");
		assert.equal(run.repairRounds, 1);
		assert.equal(run.patchDigest, undefined);
		assert.equal(run.verdict, undefined);
		assert.equal(run.contractDigest, contractDigest);
		assert.equal(run.acceptanceDigest, acceptanceDigest);
		assert.equal(run.candidateSha, undefined);
		assert.equal(run.gateSha, undefined);
		assert.equal(run.ciRunId, undefined);
		assert.equal(run.heldoutDigest, undefined);
	});

	it("clears the previously validated gate on review repair", () => {
		const reviewed = reachReview("first");

		assert.equal(reviewed.gateSha, currentHead.currentGate);

		const repaired = apply(reviewed, reviewedEvent("first", ["repair"]));

		assert.equal(repaired.gateSha, undefined);
	});

	it("rejects a passing verdict for another head with the same patch", () => {
		const verdict = {
			...passingVerdict(patch("first")),
			candidateSha: "d".repeat(40),
		};

		assert.deepEqual(
			advance(reachValidate("first"), { kind: "validated", verdict }),
			{ kind: "invalid", reason: "verdict is bound to different CI inputs" },
		);
	});

	for (const change of [
		{ ciRunId: 124 },
		{ acceptanceDigest: patch("other suite") },
	])
		it(`rejects independently mismatched validate input ${JSON.stringify(change)}`, () => {
			assert.deepEqual(
				advance(reachValidate("first"), {
					kind: "validated",
					verdict: { ...passingVerdict(patch("first")), ...change },
				}),
				{ kind: "invalid", reason: "verdict is bound to different CI inputs" },
			);
		});

	it("lets a repaired patch pass validate and continue", () => {
		const repaired = apply(
			reachValidate("first"),
			{ kind: "validated", verdict: failingVerdict(patch("first")) },
			{ kind: "built", patchDigest: patch("second") },
			candidateEvent,
			{ kind: "validated", verdict: passingVerdict(patch("second")) },
		);

		assert.equal(stageOf(repaired), "review");
		assert.equal(repaired.repairRounds, 1);
		assert.equal(repaired.patchDigest, patch("second"));
	});

	it("allows exactly the maximum rounds, then fails at validate with evidence", () => {
		assert.equal(MAX_REPAIR_ROUNDS, 2);
		let run = reachValidate("p0");

		for (let round = 1; round <= MAX_REPAIR_ROUNDS; round++) {
			run = apply(
				run,
				{ kind: "validated", verdict: failingVerdict(patch(`p${round - 1}`)) },
				{ kind: "built", patchDigest: patch(`p${round}`) },
				candidateEvent,
			);
			assert.equal(run.repairRounds, round);
			assert.equal(stageOf(run), "validate");
		}

		const done = apply(run, {
			kind: "validated",
			verdict: failingVerdict(patch(`p${MAX_REPAIR_ROUNDS}`)),
		});

		assert.deepEqual(done.progress, {
			kind: "finished",
			outcome: {
				kind: "failed",
				stage: "validate",
				evidence: "failed checks: heldout",
			},
		});
		assert.equal(done.repairRounds, MAX_REPAIR_ROUNDS);
	});

	it("treats a failed check as a veto even when the verdict claims pass", () => {
		const verdict = {
			...failingVerdict(patch("first")),
			pass: true,
		};

		const run = apply(reachValidate("first"), { kind: "validated", verdict });
		assert.equal(stageOf(run), "build");
	});

	it("refuses a verdict bound to a different patch", () => {
		const result = advance(reachValidate("first"), {
			kind: "validated",
			verdict: passingVerdict(patch("other")),
		});

		assert.deepEqual(result, {
			kind: "invalid",
			reason: "verdict is bound to a different patch",
		});
	});
});

describe("advance: review", () => {
	it("rejects stale SHA, stale digest and missing criterion judgments", () => {
		const run = reachReview("first");

		for (const changed of [
			{ candidateSha: "d".repeat(40) },
			{ patchDigest: patch("other") },
		])
			assert.equal(
				advance(run, { ...reviewedEvent("first"), ...changed }).kind,
				"invalid",
			);
		assert.equal(
			advance(
				{
					...run,
					verdict: { ...passingVerdict(patch("first")), unjudged: ["J1"] },
				},
				reviewedEvent("first"),
			).kind,
			"invalid",
		);
	});
	it("sends blocking findings back to build as a repair round", () => {
		const run = apply(
			reachReview(),
			reviewedEvent("first", ["SQL injection in query builder"]),
		);

		assert.equal(stageOf(run), "build");
		assert.equal(run.repairRounds, 1);
		assert.equal(run.patchDigest, undefined);
		assert.equal(run.verdict, undefined);
	});

	it("shares the repair budget with validate", () => {
		let run = reachValidate("p0");
		run = apply(
			run,
			{ kind: "validated", verdict: failingVerdict(patch("p0")) },
			{ kind: "built", patchDigest: patch("p1") },
			candidateEvent,
			{ kind: "validated", verdict: passingVerdict(patch("p1")) },
			reviewedEvent("p1", ["a"]),
			{ kind: "built", patchDigest: patch("p2") },
			candidateEvent,
			{ kind: "validated", verdict: passingVerdict(patch("p2")) },
		);
		assert.equal(run.repairRounds, 2);

		const done = apply(run, reviewedEvent("p2", ["still bad", "also bad"]));

		assert.deepEqual(done.progress, {
			kind: "finished",
			outcome: {
				kind: "failed",
				stage: "review",
				evidence: "blocking findings: still bad; also bad",
			},
		});
	});

	it("re-runs validate on the repaired patch before review again", () => {
		const run = apply(reachReview("first"), reviewedEvent("first", ["x"]), {
			kind: "built",
			patchDigest: patch("second"),
		});

		assert.equal(stageOf(run), "validate");
		const result = advance(run, reviewedEvent("second"));
		assert.equal(result.kind, "invalid");
	});
});

describe("advance: land", () => {
	it("records the merge sha as the landed outcome", () => {
		const done = apply(reachLand(), {
			kind: "landed",
			mergeSha: "c".repeat(40),
			...currentHead,
		});

		assert.equal(done.progress.kind, "finished");
		assert.equal(
			done.progress.kind === "finished" && done.progress.outcome.kind,
			"landed",
		);
	});

	it("refuses to land when the precondition does not hold", () => {
		const run = reachLand();
		const tampered = { ...run, patchDigest: patch("swapped") };

		const result = advance(tampered, {
			kind: "landed",
			mergeSha: "d".repeat(40),
			...currentHead,
		});

		assert.deepEqual(result, {
			kind: "invalid",
			reason: "land precondition not met: digest_mismatch",
		});
	});
});

describe("advance: kill switch, cancellation, policy and budget", () => {
	const stages: Array<[string, () => ReturnType<typeof newRun>]> = [
		["admit", newRun],
		["build", reachBuild],
		["validate", () => reachValidate()],
		["review", () => reachReview()],
		["land", () => reachLand()],
	];

	for (const [name, reach] of stages) {
		it(`rejects as disabled when the kill switch is off during ${name}`, () => {
			const done = apply(reach(), { kind: "kill_switch_off" });
			assert.deepEqual(done.progress, {
				kind: "finished",
				outcome: { kind: "rejected", reason: "disabled" },
			});
		});

		it(`cancels during ${name}`, () => {
			const done = apply(reach(), { kind: "cancelled" });
			assert.deepEqual(done.progress, {
				kind: "finished",
				outcome: { kind: "cancelled" },
			});
		});
	}

	it("records a policy rejection with its reason", () => {
		const done = apply(reachValidate(), {
			kind: "rejected",
			reason: "forbidden_paths",
		});

		assert.deepEqual(done.progress, {
			kind: "finished",
			outcome: { kind: "rejected", reason: "forbidden_paths" },
		});
	});

	it("fails the current stage with evidence", () => {
		const done = apply(reachBuild(), {
			kind: "stage_failed",
			evidence: "builder crashed",
		});

		assert.deepEqual(done.progress, {
			kind: "finished",
			outcome: { kind: "failed", stage: "build", evidence: "builder crashed" },
		});
	});

	it("records budget exhaustion at the current stage", () => {
		const done = apply(reachReview(), { kind: "budget_exhausted" });
		assert.deepEqual(done.progress, {
			kind: "finished",
			outcome: { kind: "budget_exhausted", stage: "review" },
		});
	});

	it("cannot be cancelled twice", () => {
		const done = apply(newRun(), { kind: "cancelled" });
		assert.equal(advance(done, { kind: "cancelled" }).kind, "invalid");
	});
});
