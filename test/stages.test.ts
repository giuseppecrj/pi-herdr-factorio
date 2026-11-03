import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { Stage } from "../src/run.ts";
import { candidateUsage, candidateProjection } from "../src/handoff.ts";
import {
	advance,
	formatStageTable,
	MAX_REPAIR_ROUNDS,
	nextStage,
	STAGE_ORDER,
	STAGE_PROFILES,
} from "../src/stages.ts";
import {
	acceptedEvent,
	acceptanceDigest,
	apply,
	builtEvent,
	contractDigest,
	newRun,
	reachBuild,
	stageOf,
} from "./helpers.ts";

describe("stage table", () => {
	it("covers every stage exactly once in order", () => {
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
		assert.equal(nextStage("admit"), "specify");
		assert.equal(nextStage("review"), "land");
		assert.equal(nextStage("land"), undefined);
		assert.equal(MAX_REPAIR_ROUNDS, 2);
	});

	it("renders truthful access profiles", () => {
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

		for (const profile of Object.values(STAGE_PROFILES)) {
			assert.equal(
				profile.runsIn,
				profile.modelAccess === "none" ? "controller" : "sandbox",
			);
			assert.equal(
				profile.githubAccess === "none",
				profile.modelAccess !== "none",
			);
		}
	});
});

describe("public advance", () => {
	it("preserves early stages and starts one authoritative candidate book", () => {
		const run = newRun();
		const before = structuredClone(run);
		assert.equal(stageOf(run), "admit");
		const specify = apply(run, { kind: "admitted" });
		const accept = apply(specify, { kind: "specified", contractDigest });
		const build = apply(accept, acceptedEvent());
		assert.equal(stageOf(specify), "specify");
		assert.equal(stageOf(accept), "accept");
		assert.equal(stageOf(build), "build");
		assert.deepEqual(run, before);
		const candidate = apply(build, builtEvent());
		assert.ok(candidate.handoff);
		assert.equal(candidate.handoff.kind, "unprepared");
		assert.equal(candidateUsage(candidate.handoff), 1234);
		assert.deepEqual(
			candidate.progress,
			candidateProjection(candidate.handoff).progress,
		);
		assert.equal("candidateSha" in candidate, false);
		assert.equal("verdict" in candidate, false);
		assert.equal("repairRounds" in candidate, false);
	});

	it("rejects another stage and a wrong candidate admission pin", () => {
		assert.deepEqual(advance(newRun(), builtEvent()), {
			kind: "invalid",
			reason: "built is not valid during admit",
		});
		const event = builtEvent();
		assert.equal(
			advance(reachBuild(), {
				...event,
				pin: { ...event.pin, contractDigest: acceptanceDigest },
			}).kind,
			"invalid",
		);
	});

	it("never accepts a model-supplied landed event or legacy candidate writer", () => {
		const candidate = apply(reachBuild(), builtEvent());

		for (const kind of ["landed", "validated", "reviewed", "kill_switch_off"]) {
			const untrusted = JSON.parse(
				JSON.stringify({ kind, mergeSha: "c".repeat(40) }),
			);

			assert.equal(advance(candidate, untrusted).kind, "invalid", kind);
			assert.equal(advance(newRun(), untrusted).kind, "invalid", kind);
		}
	});

	it("asks questions only during specify", () => {
		const done = apply(apply(newRun(), { kind: "admitted" }), {
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
		assert.equal(
			advance(reachBuild(), { kind: "needs_info", questions: ["why?"] }).kind,
			"invalid",
		);
	});

	it("keeps early failure, rejection, budget and cancellation outcomes", () => {
		assert.deepEqual(
			apply(reachBuild(), { kind: "stage_failed", evidence: "builder crashed" })
				.progress,
			{
				kind: "finished",
				outcome: {
					kind: "failed",
					stage: "build",
					evidence: "builder crashed",
				},
			},
		);
		assert.deepEqual(
			apply(reachBuild(), { kind: "budget_exhausted" }).progress,
			{
				kind: "finished",
				outcome: { kind: "budget_exhausted", stage: "build" },
			},
		);
		assert.deepEqual(
			apply(reachBuild(), { kind: "rejected", reason: "forbidden_paths" })
				.progress,
			{
				kind: "finished",
				outcome: { kind: "rejected", reason: "forbidden_paths" },
			},
		);
		const cancelled = apply(newRun(), { kind: "cancelled" });
		assert.deepEqual(cancelled.progress, {
			kind: "finished",
			outcome: { kind: "cancelled" },
		});
		assert.equal(advance(cancelled, { kind: "cancelled" }).kind, "invalid");
	});
});
