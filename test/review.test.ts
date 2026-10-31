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
import {
	collectPatch,
	storePatch,
	finishPatch,
	publicationTree,
} from "../src/build.ts";
import {
	contractBytes,
	contractDigestOf,
	type Contract,
} from "../src/specify.ts";
import { writeAcceptance } from "../src/accept.ts";
import { isGitSha, isRepoSlug } from "../src/workflow.ts";

async function checkReviewTree(mode: string) {
	const root = mkdtempSync(join(tmpdir(), "factory-review-input-"));

	try {
		const base = join(root, "base"),
			work = join(root, "work"),
			state = join(root, "state");

		const repo = "giuseppecrj/pi-herdr-factorio",
			sha = "a".repeat(40),
			certifiedSha = mode === "unchanged" ? sha : "e".repeat(40);

		if (!isRepoSlug(repo) || !isGitSha(sha) || !isGitSha(certifiedSha))
			throw new Error("fixture");

		for (const dir of [base, work, state]) mkdirSync(dir, { mode: 0o700 });
		mkdirSync(join(base, ".github/factory"), { recursive: true });
		const workflow = `---\nrepository: ${repo}\n---\n## review\nPINNED_ADMISSION_GUIDANCE\n`;

		const pin = {
			workflowSha: mode === "workflow-sha-mismatch" ? certifiedSha : sha,
			workflowDigest:
				mode === "workflow-digest-mismatch"
					? digestOf("different workflow")
					: digestOf(workflow),
		};

		writeFileSync(join(base, ".github/factory/WORKFLOW.md"), workflow, {
			mode: 0o644,
		});

		const original =
			"export const first = 1;\nexport const second = 2;\nexport const third = 3;\nexport const fourth = 4;\nexport const value = 0;\n";

		writeFileSync(join(base, "value.ts"), original);
		writeFileSync(
			join(base, "dependency.ts"),
			"export const dependency = 'original';\n",
		);
		cpSync(base, work, { recursive: true });
		writeFileSync(
			join(work, "value.ts"),
			original.replace("value = 0", "value = 1"),
		);
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
			baseSha: certifiedSha,
			acceptanceDigest: stored.receipt.acceptanceDigest,
		};

		const dir = join(state, "validation", runId);
		mkdirSync(dir, { recursive: true, mode: 0o700 });
		writeFileSync(join(dir, "verdict.json"), JSON.stringify(verdict), {
			mode: 0o600,
		});
		writeFileSync(
			join(dir, "receipt.json"),
			JSON.stringify({
				modelCalls: 0,
				candidateSha: verdict.candidateSha,
				newDependency: false,
				dependencies: { added: [], changed: [] },
				installScripts: [
					"node_modules/@google/genai@2.21.0",
					"node_modules/protobufjs@7.6.6",
				],
			}),
			{ mode: 0o600 },
		);

		const archiveOf = (path: string) =>
			execFileSync(
				"tar",
				[
					"-czf",
					"-",
					"--transform=s,^,repo/,",
					".github",
					"value.ts",
					"dependency.ts",
				],
				{ cwd: path },
			);

		const originalArchive = archiveOf(base);
		const moved = join(root, "moved");
		cpSync(base, moved, { recursive: true });

		if (mode !== "unchanged") {
			writeFileSync(
				join(moved, "value.ts"),
				mode === "conflict"
					? "incompatible\n"
					: `export const inserted = true;\n${original}`,
			);
			writeFileSync(
				join(moved, "dependency.ts"),
				"export const dependency = 'certified';\n",
			);
		}

		if (mode === "workflow-removed")
			rmSync(join(moved, ".github/factory/WORKFLOW.md"));
		else if (mode !== "unchanged")
			writeFileSync(
				join(moved, ".github/factory/WORKFLOW.md"),
				workflow.replace("PINNED_ADMISSION_GUIDANCE", "MOVED_MAIN_GUIDANCE"),
			);

		const certifiedArchive = archiveOf(moved);
		const fetched: string[] = [];

		const config = {
			stateDir: state,
			exec: async () => ({ code: 0, stdout: "", stderr: "" }),
			log: () => {},
			xdgRuntimeDir: "/run/user/1000",
			fetchTarball: async (_repo: string, ref: string) => {
				fetched.push(ref);

				return ref === sha
					? originalArchive
					: mode === "missing"
						? null
						: certifiedArchive;
			},
		};

		const executor = sandboxExecutor(config);

		const workspace = join(root, "review");

		const build = await executor.checkout({
			runId,
			repo,
			sha,
			workspace: join(root, "build"),
			build: true,
		});

		assert.equal(build.kind, "ready");
		const pristine = join(state, "pristine", runId);
		const pristineBefore = readFileSync(join(pristine, "value.ts"), "utf8");

		const baseRecord = readFileSync(
			join(state, "build-base/checkouts", `${runId}.json`),
			"utf8",
		);

		mkdirSync(files.workspacePath(runId), { recursive: true, mode: 0o700 });

		const admitted = await executor.checkout({
			runId,
			repo,
			sha,
			workspace: files.workspacePath(runId),
		});

		assert.equal(admitted.kind, "ready");

		const pinnedPath = join(
			files.workspacePath(runId),
			".github/factory/WORKFLOW.md",
		);

		if (mode === "workflow-missing") rmSync(pinnedPath);

		if (mode === "workflow-modified")
			writeFileSync(pinnedPath, `${workflow}\n`);

		if (mode === "workflow-invalid") {
			writeFileSync(pinnedPath, "not a workflow");
			pin.workflowDigest = digestOf("not a workflow");
		}

		if (mode === "uncached") {
			rmSync(join(state, "checkouts", `${runId}.json`));
			rmSync(files.workspacePath(runId), { recursive: true });
		}

		if (mode === "workflow-unavailable") {
			rmSync(join(state, "checkouts", `${runId}.json`));
			config.fetchTarball = async (_repo, ref) =>
				ref === sha ? null : certifiedArchive;
		}

		fetched.length = 0;

		if (mode.startsWith("workflow-") && mode !== "workflow-removed") {
			await assert.rejects(
				executor.prepareReview!({ runId, round: 0, workspace, ...pin }),
				new RegExp(
					mode === "workflow-unavailable"
						? "^Error: workflow_checkout$"
						: mode === "workflow-invalid"
							? "^Error: workflow_invalid$"
							: "^Error: workflow_mismatch$",
				),
			);
			assert.equal(
				readFileSync(join(pristine, "value.ts"), "utf8"),
				pristineBefore,
			);
			assert.equal(
				readFileSync(
					join(state, "build-base/checkouts", `${runId}.json`),
					"utf8",
				),
				baseRecord,
			);

			return;
		}

		if (mode === "missing" || mode === "conflict") {
			await assert.rejects(
				executor.prepareReview!({ runId, round: 0, workspace, ...pin }),
			);
			assert.equal(
				readFileSync(join(pristine, "value.ts"), "utf8"),
				pristineBefore,
			);

			return;
		}

		const prepared = await executor.prepareReview!({
			runId,
			round: 0,
			workspace,
			...pin,
		});

		assert.ok(prepared.input.prompt.includes("PINNED_ADMISSION_GUIDANCE"));
		assert.equal(prepared.input.prompt.includes("MOVED_MAIN_GUIDANCE"), false);

		const certified = join(root, "certified");
		await publicationTree(moved, certified, patch.patch, patch.changedPaths);

		for (const path of ["value.ts", "dependency.ts"])
			assert.equal(
				readFileSync(join(workspace, path), "utf8"),
				readFileSync(join(certified, path), "utf8"),
			);

		const expectedFetches =
			mode === "uncached" ? [sha, certifiedSha] : [certifiedSha];

		assert.deepEqual(fetched, expectedFetches);
		assert.deepEqual(prepared.input.seats, [
			"code-review",
			"security-review",
			"simplify",
		]);
		assert.equal(prepared.input.binding.originalBase, sha);
		assert.equal(prepared.input.binding.baseSha, certifiedSha);
		assert.equal(
			prepared.input.files.get("value.ts"),
			readFileSync(join(certified, "value.ts"), "utf8").split("\n").length,
		);
		assert.equal(
			readFileSync(join(pristine, "value.ts"), "utf8"),
			pristineBefore,
		);
		assert.equal(
			readFileSync(
				join(state, "build-base/checkouts", `${runId}.json`),
				"utf8",
			),
			baseRecord,
		);
		const restarted = sandboxExecutor(config);

		const recoveredPreparation = await restarted.prepareReview!({
			runId,
			round: 0,
			workspace,
			...pin,
		});

		assert.deepEqual(
			{
				...recoveredPreparation,
				input: {
					...recoveredPreparation.input,
					prompt: recoveredPreparation.input.prompt.replace(
						/candidate-[a-f0-9]+/g,
						"candidate-NONCE",
					),
				},
			},
			{
				...prepared,
				input: {
					...prepared.input,
					prompt: prepared.input.prompt.replace(
						/candidate-[a-f0-9]+/g,
						"candidate-NONCE",
					),
				},
			},
		);

		const stage = join(state, "stages", runId, "review-r0-1");
		mkdirSync(stage, { recursive: true, mode: 0o700 });
		writeFileSync(
			join(stage, "receipt.json"),
			JSON.stringify({
				outcome: { kind: "passed" },
				output: { file: "output.txt" },
			}),
			{ mode: 0o600 },
		);
		writeFileSync(
			join(stage, "output.txt"),
			JSON.stringify(
				prepared.input.seats.map((seat) => ({
					seat,
					findings: [],
					judgments: [],
					requested: "openai/gpt-6.1-sol",
					observed: null,
					label: "context-isolated, same model, same family, not cross-family",
					fallback: false,
					tokens: 1,
				})),
			),
			{ mode: 0o600 },
		);

		const recovered = await restarted.output({
			runId,
			stage: "review",
			attempt: 1,
			round: 0,
			...pin,
		});

		assert.ok(recovered instanceof Object && recovered.kind === "review");
		assert.deepEqual(recovered.receipt, {
			...prepared.input.binding,
			version: 1,
			r8: "incomplete",
			seats: JSON.parse(readFileSync(join(stage, "output.txt"), "utf8")),
			blocking: false,
		});
		assert.equal(
			await restarted.output({
				runId,
				stage: "review",
				attempt: 1,
				round: 0,
				...pin,
				workflowDigest: digestOf("wrong"),
			}),
			null,
		);
		writeFileSync(pinnedPath, `${workflow}\n`);
		assert.equal(
			await restarted.output({
				runId,
				stage: "review",
				attempt: 1,
				round: 0,
				...pin,
			}),
			null,
		);
		rmSync(pinnedPath);
		assert.equal(
			await restarted.output({
				runId,
				stage: "review",
				attempt: 1,
				round: 0,
				...pin,
			}),
			null,
		);
		writeFileSync(pinnedPath, workflow);
		assert.deepEqual(fetched, expectedFetches);
		writeFileSync(join(dir, "feedback.json"), "[]", { mode: 0o600 });
		const repairWorkspace = join(root, "repair");

		const repaired = await executor.checkout({
			runId,
			repo,
			sha,
			workspace: repairWorkspace,
			build: true,
			round: 1,
		});

		assert.equal(repaired.kind, "ready");
		assert.equal(
			readFileSync(join(repairWorkspace, "value.ts"), "utf8"),
			original.replace("value = 0", "value = 1"),
		);
		assert.equal(
			readFileSync(join(repairWorkspace, "dependency.ts"), "utf8"),
			readFileSync(join(base, "dependency.ts"), "utf8"),
		);
		rmSync(join(repairWorkspace, ".factory-feedback.json"));
		writeFileSync(
			join(repairWorkspace, "value.ts"),
			original.replace("value = 0", "value = 2"),
		);

		const repairedPatch = await collectPatch({
			base: pristine,
			workspace: repairWorkspace,
		});

		assert.equal(repairedPatch.kind, "collected");

		if (repairedPatch.kind !== "collected") throw new Error("repair patch");
		assert.equal(repairedPatch.changedPaths.includes("dependency.ts"), false);
		assert.match(
			Buffer.from(repairedPatch.patch).toString(),
			/-export const value = 0/,
		);
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
}

for (const mode of [
	"unchanged",
	"moved",
	"uncached",
	"missing",
	"conflict",
	"workflow-removed",
	"workflow-missing",
	"workflow-modified",
	"workflow-invalid",
	"workflow-unavailable",
	"workflow-sha-mismatch",
	"workflow-digest-mismatch",
])
	it(`prepares review from the certified base (${mode}) while preserving the repair base`, () =>
		checkReviewTree(mode));

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
	it("ignores baseline install scripts and retains candidate dependency risks", () => {
		const baseline = {
			installScripts: [
				"node_modules/@google/genai@2.21.0",
				"node_modules/protobufjs@7.6.6",
			],
			newDependency: false,
			dependencies: { added: [], changed: [] },
		};

		assert.deepEqual(reviewSeats(["value.ts"], baseline), [
			"code-review",
			"security-review",
			"simplify",
		]);

		for (const gate of [
			{ ...baseline, newDependency: true },
			{ ...baseline, scriptsChanged: true },
			{
				...baseline,
				dependencies: { added: ["node_modules/new@1"], changed: [] },
			},
			{
				...baseline,
				dependencies: { added: [], changed: ["node_modules/protobufjs@8"] },
			},
		])
			assert.equal(reviewSeats(["value.ts"], gate).length, 4);
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
