import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
	parseSeat,
	reviewSeats,
	blocksReview,
	REVIEW_MAX_TOKENS,
	REPAIR_BUILD_MAX_TOKENS,
	reviewCandidate,
	type ReviewInput,
	type SeatReceipt,
} from "../src/review.ts";

import { passingVerdict, patch } from "./helpers.ts";
import { digestOf } from "../src/run.ts";

describe("candidate review", () => {
	const files = new Map([["src/a.ts", 10]]);

	const seat = {
		seat: "code-review",
		findings: [],
		judgments: [{ scenario: "J1", pass: true, reason: "satisfied" }],
	};

	it("requires exact seats, binds findings to the SHA and patch, and lets hard checks veto approval", () => {
		const verdict = passingVerdict(patch("one"));

		const input: ReviewInput = {
			binding: {
				runId: digestOf("run"),
				round: 1,
				candidateSha: verdict.candidateSha,
				patchDigest: verdict.patchDigest,
				contractDigest: digestOf("contract"),
				acceptanceDigest: verdict.acceptanceDigest,
				ciRunId: verdict.ciRunId,
				originalBase: verdict.originalBase,
				baseSha: verdict.baseSha,
			},
			seats: ["code-review", "security-review", "simplify"],
			files,
			scenarios: ["J1"],
			prompt: "",
		};

		const receipts: SeatReceipt[] = input.seats.map((name) => ({
			seat: name,
			findings: [],
			judgments: name === "code-review" ? seat.judgments : [],
			requested: "openai/gpt-6.1-sol",
			observed: "openai/gpt-6.1-sol",
			label: "context-isolated, same model, same family, not cross-family",
			fallback: false,
			tokens: 10,
		}));

		assert.equal(reviewCandidate(input, verdict, receipts).blocking, false);
		assert.throws(
			() => reviewCandidate(input, verdict, receipts.slice(1)),
			/missing_seat/,
		);
		assert.throws(
			() =>
				reviewCandidate(input, verdict, [
					receipts[0]!,
					receipts[0]!,
					receipts[2]!,
				]),
			/missing_seat/,
		);
		assert.throws(
			() =>
				reviewCandidate(
					{
						...input,
						binding: { ...input.binding, candidateSha: "d".repeat(40) },
					},
					verdict,
					receipts,
				),
			/binding/,
		);
		assert.throws(
			() =>
				reviewCandidate(
					{
						...input,
						binding: { ...input.binding, patchDigest: patch("other") },
					},
					verdict,
					receipts,
				),
			/binding/,
		);
		assert.throws(
			() =>
				reviewCandidate(
					input,
					{
						...verdict,
						checks: verdict.checks.map((check) => ({
							...check,
							passed: false,
						})),
					},
					receipts,
				),
			/binding/,
		);
		assert.throws(
			() =>
				reviewCandidate(
					input,
					verdict,
					receipts.map((entry) => ({ ...entry, judgments: [] })),
				),
			/malformed/,
		);
	});

	it("requires every judge-only scenario exactly once", () => {
		assert.ok(parseSeat(JSON.stringify(seat), "code-review", files, ["J1"]));
		assert.equal(
			parseSeat(
				JSON.stringify({ ...seat, judgments: [] }),
				"code-review",
				files,
				["J1"],
			),
			null,
		);
		assert.equal(
			parseSeat(
				JSON.stringify({
					...seat,
					judgments: [...seat.judgments, ...seat.judgments],
				}),
				"code-review",
				files,
				["J1"],
			),
			null,
		);
	});
	it("rejects extra keys, foreign paths and out-of-range lines", () => {
		assert.equal(
			parseSeat(
				JSON.stringify({ ...seat, extra: true }),
				"code-review",
				files,
				["J1"],
			),
			null,
		);

		for (const path of [
			"../src/a.ts",
			".github/x",
			"test/acceptance/1/a.ts",
			"missing.ts",
		]) {
			assert.equal(
				parseSeat(
					JSON.stringify({
						...seat,
						findings: [
							{
								id: "F1",
								severity: "blocking",
								category: "bug",
								path,
								startLine: 1,
								endLine: 1,
								claim: "bad",
								evidence: "proof",
							},
						],
					}),
					"code-review",
					files,
					["J1"],
				),
				null,
			);
		}
	});
	it("selects a fourth seat only for narrow deterministic risks", () => {
		assert.equal(reviewSeats(["src/format.ts"]).length, 3);

		for (const path of [
			"src/policy.ts",
			"server/sandbox/rpc.ts",
			"package.json",
			"skills/build/SKILL.md",
		])
			assert.equal(reviewSeats([path]).length, 4);
		assert.equal(reviewSeats([], { scriptsChanged: true }).length, 4);
	});
	it("simplify and advisory findings never block", () => {
		assert.equal(
			blocksReview([
				{
					...seat,
					seat: "simplify",
					findings: [
						{
							id: "F1",
							severity: "blocking",
							category: "simplify",
							path: "src/a.ts",
							startLine: 1,
							endLine: 1,
							claim: "duplication",
							evidence: "same",
						},
					],
				},
			]),
			false,
		);
		assert.equal(
			blocksReview([
				{
					...seat,
					judgments: [{ scenario: "J1", pass: false, reason: "missing" }],
				},
			]),
			true,
		);
		assert.equal(REVIEW_MAX_TOKENS + REPAIR_BUILD_MAX_TOKENS, 80_000);
	});
});
