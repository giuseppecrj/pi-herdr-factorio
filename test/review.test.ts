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
import {
	mkdtempSync,
	cpSync,
	mkdirSync,
	writeFileSync,
	readFileSync,
	rmSync,
	existsSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFileSync } from "node:child_process";
import { fileRunFiles } from "../server/controller.ts";
import { sandboxExecutor } from "../server/sandbox.ts";
import { collectPatch, storePatch, finishPatch } from "../src/build.ts";
import {
	contractBytes,
	contractDigestOf,
	type Contract,
} from "../src/specify.ts";
import { writeAcceptance } from "../src/accept.ts";
import { isGitSha, isRepoSlug } from "../src/workflow.ts";

it("prepares real review input from a public-mode tarball without exposing private suite bytes", async () => {
	const root = mkdtempSync(join(tmpdir(), "factory-review-input-"));

	try {
		const base = join(root, "base"),
			work = join(root, "work"),
			state = join(root, "state");

		const repo = "giuseppecrj/pi-herdr-factorio",
			sha = "a".repeat(40);

		if (!isRepoSlug(repo) || !isGitSha(sha)) throw new Error("fixture");

		for (const dir of [base, work, state]) mkdirSync(dir, { mode: 0o700 });
		mkdirSync(join(base, ".github/factory"), { recursive: true });
		writeFileSync(
			join(base, ".github/factory/WORKFLOW.md"),
			`---\nrepository: ${repo}\n---\n## review\nReview the contract.\n`,
			{ mode: 0o644 },
		);
		cpSync(join(base, ".github"), join(work, ".github"), { recursive: true });
		writeFileSync(join(work, "value.ts"), "export const value = 1;\n");
		const runId = digestOf("review fixture");

		const contract: Contract = {
			version: 1,
			runId,
			issue: 1,
			base: { repo, sha },
			snapshot: {
				digest: digestOf("snapshot"),
				source: "unedited",
				eventId: "1",
				eventAt: "2026-10-31T00:00:00Z",
			},
			link: null,
			summary: "Add value",
			behavior: ["Export value"],
			exclusions: [],
			acceptance: [{ id: "A1", text: "Value is one" }],
			compatibility: [],
			limits: [],
			files: ["value.ts"],
			evidence: [],
		};

		const bytes = contractBytes(contract),
			digest = contractDigestOf(bytes);

		const files = fileRunFiles(state);
		assert.equal(await files.writeContract({ contract, bytes, digest }), true);

		const accepted = writeAcceptance(
			JSON.stringify({
				version: 1,
				scenarios: [
					{
						id: "S1",
						criteria: ["A1"],
						checks: ["value.test.ts"],
						judge: null,
					},
				],
				files: [
					{
						path: "value.test.ts",
						type: "node:test",
						content: "PRIVATE_ORACLE_MARKER",
					},
				],
			}),
			contract,
		);

		if (accepted.kind !== "suite") throw new Error("suite");

		const stored = await files.artifacts.store({
			contract,
			contractDigest: digest,
			suite: accepted.suite,
			model: "openai/gpt-6.1-sol",
			observed: null,
		});

		if (stored.kind !== "found") throw new Error("suite store");
		const patch = await collectPatch({ base, workspace: work });

		if (patch.kind !== "collected") throw new Error("patch");

		const binding = {
			runId,
			baseSha: sha,
			contractDigest: digest,
			acceptanceDigest: stored.receipt.acceptanceDigest,
		};

		storePatch(state, binding, patch, {
			model: "openai/gpt-6.1-sol",
			observed: null,
			commands: [],
		});
		finishPatch(state, binding, {
			command: "test",
			exitCode: 0,
			tail: "",
			wallMs: 0,
		});

		const verdict = {
			...passingVerdict(patch.patchDigest),
			originalBase: sha,
			baseSha: sha,
			acceptanceDigest: stored.receipt.acceptanceDigest,
		};

		const dir = join(state, "validation", runId);
		mkdirSync(dir, { recursive: true, mode: 0o700 });
		writeFileSync(join(dir, "verdict.json"), JSON.stringify(verdict), {
			mode: 0o600,
		});
		writeFileSync(
			join(dir, "receipt.json"),
			JSON.stringify({ modelCalls: 0, candidateSha: verdict.candidateSha }),
			{ mode: 0o600 },
		);

		const archive = execFileSync(
			"tar",
			["-czf", "-", "--transform=s,^,repo/,", ".github"],
			{ cwd: base },
		);

		const executor = sandboxExecutor({
			stateDir: state,
			exec: async () => ({ code: 0, stdout: "", stderr: "" }),
			log: () => {},
			xdgRuntimeDir: "/run/user/1000",
			fetchTarball: async () => archive,
		});

		const workspace = join(root, "review");

		const prepared = await executor.prepareReview!({
			runId,
			round: 0,
			workspace,
		});

		assert.deepEqual(prepared.input.seats, [
			"code-review",
			"security-review",
			"simplify",
		]);
		assert.ok(prepared.input.files.has("value.ts"));
		assert.match(
			readFileSync(join(workspace, "value.ts"), "utf8"),
			/value = 1/,
		);
		assert.ok(!prepared.input.prompt.includes("PRIVATE_ORACLE_MARKER"));
		assert.equal(existsSync(join(workspace, "test/acceptance")), false);
		assert.equal(existsSync(join(workspace, ".factory-feedback.json")), false);
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});

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
