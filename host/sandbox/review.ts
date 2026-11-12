import {
	existsSync,
	mkdirSync,
	readdirSync,
	readFileSync,
	rmSync,
} from "node:fs";
import { join } from "node:path";
import { collectPatch, prepareRepairTree } from "../../src/candidate/build.ts";
import {
	readFeedbackBatch,
	renderFeedbackCards,
} from "../../src/candidate/feedback.ts";
import {
	candidateReviewPrompt,
	parseSeat,
	ReviewEvidenceUnavailable,
	reviewFeedback,
	type ReviewInput,
	type ReviewInputRefusal,
	reviewSeats,
	seatPrompt,
	type SeatReceipt,
} from "../../src/candidate/review.ts";
import type { ReviewExecution } from "../../src/candidate/state.ts";
import { validationDir } from "../../src/candidate/validation.ts";
import { parseWorkflow } from "../../src/config/parse.ts";
import { isGitSha, WORKFLOW_PATH } from "../../src/config/schema.ts";
import { fileArtifacts, regularText } from "../../src/contract/artifacts.ts";
import {
	aggregateEfficiency,
	parseEfficiency,
	type SessionOutcome,
	unknownEfficiency,
} from "../../src/core/execution.ts";
import {
	arrayOf,
	countOf,
	fieldOf,
	objectOf,
	parseJson,
	textOf,
} from "../../src/core/json.ts";
import {
	FAMILY_MISSING,
	familyLabel,
	parseFamily,
} from "../../src/core/models.ts";
import {
	digestOf,
	isDigest,
	type Verdict,
	verdictPasses,
} from "../../src/core/run.ts";
import { ownerPatchPath, readOwnerPatch } from "../../src/github/publish.ts";
import type {
	ReviewPreparation,
	StageExecutor,
	StageLaunchInput,
} from "../../src/controller/launch.ts";
import {
	ACCEPTANCE_SUITE_DIR,
	CONTROL_PLANE_DIR,
	FEEDBACK_FILE,
	FEEDBACK_FULL_FILE,
} from "../../src/trust/protected-paths.ts";
import { PINNED_VERSIONS } from "../bundle/manifest.ts";
import { checkoutWorkspace, ghTarball } from "../controller/checkout.ts";
import { fileRunFiles } from "../controller/run-files.ts";
import type { SandboxExecutorConfig } from "./executor.ts";
import {
	boundedText,
	builderFamily,
	executionSpent,
	executionWindow,
	OUTPUT_MAX_BYTES,
	publishFile,
	readRunPatch,
	readStageReceipt,
	replaceUsage,
	stageName,
} from "./receipts.ts";
import { type StageReceipt, type StageResult, stageResult } from "./result.ts";
import { CRASHED, runStage, type StageHost } from "./run-stage.ts";

function capturedReviewText(path: string, cap?: number): string {
	try {
		return regularText(path, cap);
	} catch {
		throw new ReviewEvidenceUnavailable("review_execution_binding");
	}
}

function reviewInputRecord(input: ReviewInput) {
	return {
		binding: input.binding,
		seats: input.seats,
		files: [...input.files],
		scenarios: input.scenarios,
		prompt: input.prompt,
	};
}

function readCapturedReview(
	dir: string,
	execution: ReviewExecution,
	expected: Omit<ReviewInput, "prompt">,
): ReviewInput {
	const record = objectOf(
		parseJson(capturedReviewText(join(dir, "review.json"), Infinity)),
	);

	const input = objectOf(fieldOf(record, "input"));
	const files = arrayOf(fieldOf(input, "files"));
	const prompt = textOf(fieldOf(input, "prompt"));
	const reviewedFiles = new Map<string, number>();

	if (
		capturedReviewText(join(dir, "execution.json")) !==
			`${JSON.stringify(execution)}\n` ||
		record === null ||
		Object.keys(record).sort().join() !==
			"execution,input,inputDigest,version" ||
		fieldOf(record, "version") !== 3 ||
		JSON.stringify(fieldOf(record, "execution")) !==
			JSON.stringify(execution) ||
		input === null ||
		Object.keys(input).sort().join() !==
			"binding,files,prompt,scenarios,seats" ||
		JSON.stringify(fieldOf(input, "binding")) !==
			JSON.stringify(expected.binding) ||
		JSON.stringify(fieldOf(input, "seats")) !==
			JSON.stringify(expected.seats) ||
		JSON.stringify(fieldOf(input, "scenarios")) !==
			JSON.stringify(expected.scenarios) ||
		files === null ||
		files.length !== expected.files.size ||
		prompt === null ||
		prompt.length === 0
	)
		throw new ReviewEvidenceUnavailable("review_execution_binding");

	for (const entry of files) {
		const tuple = arrayOf(entry);
		const path = textOf(tuple?.[0]);
		const lines = countOf(tuple?.[1]);

		if (
			tuple?.length !== 2 ||
			path === null ||
			lines === null ||
			reviewedFiles.has(path) ||
			expected.files.get(path) !== lines
		)
			throw new ReviewEvidenceUnavailable("review_execution_binding");
		reviewedFiles.set(path, lines);
	}

	const restored = { ...expected, files: reviewedFiles, prompt };

	if (
		fieldOf(record, "inputDigest") !==
			digestOf(JSON.stringify(reviewInputRecord(restored))) ||
		JSON.stringify(execution.binding) !== JSON.stringify(restored.binding) ||
		JSON.stringify(execution.seats) !== JSON.stringify(restored.seats)
	)
		throw new ReviewEvidenceUnavailable("review_execution_binding");

	return restored;
}

function reviewVerdict(path: string): Verdict {
	const record = objectOf(parseJson(capturedReviewText(path, 1024 * 1024)));
	const checks = arrayOf(fieldOf(record, "checks"));
	const required = arrayOf(fieldOf(record, "requiredChecks"));
	const unjudged = arrayOf(fieldOf(record, "unjudged"));
	const patchDigest = textOf(fieldOf(record, "patchDigest"));
	const acceptanceDigest = textOf(fieldOf(record, "acceptanceDigest"));
	const heldoutDigest = textOf(fieldOf(record, "heldoutDigest"));

	if (
		record === null ||
		checks === null ||
		required === null ||
		unjudged === null ||
		patchDigest === null ||
		!isDigest(patchDigest) ||
		acceptanceDigest === null ||
		!isDigest(acceptanceDigest) ||
		heldoutDigest === null ||
		!isDigest(heldoutDigest) ||
		[...required, ...unjudged].some((value) => textOf(value) === null)
	)
		throw new ReviewEvidenceUnavailable("stored_verdict_invalid");

	return {
		...record,
		patchDigest,
		acceptanceDigest,
		heldoutDigest,
		candidateSha: textOf(record.candidateSha) ?? "",
		gateSha: textOf(record.gateSha) ?? "",
		ciRunId: countOf(record.ciRunId) ?? 0,
		originalBase: textOf(record.originalBase) ?? "",
		baseSha: textOf(record.baseSha) ?? "",
		pass: record.pass === true,
		checks: checks.map((check) => {
			const item = objectOf(check);
			const name = textOf(fieldOf(item, "name"));
			const passed = fieldOf(item, "passed");

			if (name === null || (passed !== true && passed !== false))
				throw new ReviewEvidenceUnavailable("stored_verdict_invalid");

			return { ...item, name, passed };
		}),
		requiredChecks: required.map((value) => textOf(value) ?? ""),
		unjudged: unjudged.map((value) => textOf(value) ?? ""),
	};
}

export async function prepareCandidateReview(
	config: SandboxExecutorConfig,
	input: Parameters<NonNullable<StageExecutor["prepareReview"]>>[0],
): Promise<ReviewPreparation | ReviewInputRefusal> {
	try {
		return await candidateReviewInputs(config, input);
	} catch (error) {
		if (
			error instanceof Error &&
			"code" in error &&
			["ENOSPC", "EROFS", "EIO", "EMFILE", "ENFILE"].includes(
				String(error.code),
			)
		)
			throw new ReviewEvidenceUnavailable("review_inputs_unavailable");
		throw error;
	}
}

async function candidateReviewInputs(
	config: SandboxExecutorConfig,
	input: Parameters<NonNullable<StageExecutor["prepareReview"]>>[0],
): Promise<ReviewPreparation | ReviewInputRefusal> {
	const { runId, round, workspace, workflowSha, workflowDigest, execution } =
		input;

	if (
		execution === undefined ||
		execution.runId !== runId ||
		execution.round !== round ||
		execution.generation.round !== round ||
		execution.workflowSha !== workflowSha ||
		execution.workflowDigest !== workflowDigest
	)
		throw new ReviewEvidenceUnavailable("review_binding");

	const { id, ...descriptor } = execution;

	if (id !== digestOf(JSON.stringify(descriptor)))
		throw new ReviewEvidenceUnavailable("review_execution_binding");

	const files = fileRunFiles(config.stateDir);
	const bound = await files.readContract(runId);

	if (bound.kind !== "found")
		throw new ReviewEvidenceUnavailable("contract_missing");

	const suite = await fileArtifacts(config.stateDir).read(
		runId,
		bound.contract,
		bound.digest,
	);

	const dir = validationDir(
		config.stateDir,
		runId,
		round,
		execution?.generation.generation,
	);

	const verdict = reviewVerdict(join(dir, "verdict.json"));

	if (!isGitSha(verdict.candidateSha) || !isGitSha(verdict.baseSha))
		throw new ReviewEvidenceUnavailable("review_binding");

	const isOwner =
		existsSync(
			ownerPatchPath(
				config.stateDir,
				runId,
				verdict.candidateSha,
				verdict.baseSha,
			),
		) ||
		existsSync(ownerPatchPath(config.stateDir, runId, verdict.candidateSha));

	const patch = isOwner
		? readOwnerPatch(
				config.stateDir,
				runId,
				verdict.candidateSha,
				verdict.baseSha,
			)
		: readRunPatch(config.stateDir, runId, round);

	if (suite.kind !== "found" || patch === null || patch.kind !== "found")
		throw new ReviewEvidenceUnavailable("review_inputs_missing");

	if (
		"kind" in patch.receipt &&
		(patch.receipt.head !== verdict.candidateSha ||
			patch.receipt.baseSha !== verdict.baseSha ||
			patch.receipt.heldoutDigest !== verdict.heldoutDigest)
	)
		throw new ReviewEvidenceUnavailable("review_binding");

	if (
		!verdictPasses(verdict) ||
		!isGitSha(verdict.baseSha) ||
		verdict.originalBase !== bound.contract.base.sha ||
		verdict.patchDigest !== patch.receipt.patchDigest ||
		patch.receipt.contractDigest !== bound.digest ||
		patch.receipt.acceptanceDigest !== suite.receipt.acceptanceDigest ||
		verdict.acceptanceDigest !== suite.receipt.acceptanceDigest ||
		(execution !== undefined &&
			(execution.runId !== runId ||
				execution.round !== round ||
				execution.workflowSha !== workflowSha ||
				execution.workflowDigest !== workflowDigest ||
				execution.binding.candidateSha !== verdict.candidateSha ||
				execution.binding.baseSha !== verdict.baseSha ||
				execution.binding.ciRunId !== verdict.ciRunId ||
				execution.binding.patchDigest !== verdict.patchDigest))
	)
		throw new ReviewEvidenceUnavailable("review_binding");

	const gate = objectOf(
		parseJson(capturedReviewText(join(dir, "receipt.json"))),
	);

	if (
		countOf(fieldOf(gate, "modelCalls")) !== 0 ||
		fieldOf(gate, "candidateSha") !== verdict.candidateSha
	)
		throw new ReviewEvidenceUnavailable("review_gate_binding");

	if (workflowSha !== bound.contract.base.sha)
		throw new ReviewEvidenceUnavailable("workflow_mismatch");

	const workflowWorkspace = files.workspacePath(runId);
	mkdirSync(workflowWorkspace, { recursive: true, mode: 0o700 });

	const pinned = await checkoutWorkspace({
		stateDir: config.stateDir,
		workspace: workflowWorkspace,
		runId,
		repo: bound.contract.base.repo,
		sha: workflowSha,
		fetch: config.fetchTarball ?? ghTarball,
	});

	if (pinned.kind !== "ready")
		throw new ReviewEvidenceUnavailable("workflow_checkout");

	const text = await pinned.checkout.read(WORKFLOW_PATH, 256 * 1024);

	if (text === null || digestOf(text) !== workflowDigest)
		throw new ReviewEvidenceUnavailable("workflow_mismatch");

	const workflow = parseWorkflow({
		text,
		repo: bound.contract.base.repo,
		env: (name) => process.env[name],
		platform: config.platform,
	});

	if (workflow.kind !== "valid")
		throw new ReviewEvidenceUnavailable("workflow_invalid");

	const reviewBase = join(config.stateDir, "review-base", verdict.baseSha);
	const base = join(reviewBase, "trees", runId);
	mkdirSync(base, { recursive: true, mode: 0o700 });

	const checked = await checkoutWorkspace({
		stateDir: reviewBase,
		workspace: base,
		runId,
		repo: bound.contract.base.repo,
		sha: verdict.baseSha,
		fetch: config.fetchTarball ?? ghTarball,
	});

	if (checked.kind !== "ready")
		throw new ReviewEvidenceUnavailable("review_checkout");

	rmSync(workspace, { recursive: true, force: true });

	try {
		await prepareRepairTree(
			base,
			workspace,
			patch.patch,
			patch.receipt.changedPaths,
			"{}",
		);
	} catch (error) {
		if (
			error instanceof Error &&
			[
				"stale_base",
				"patch_invalid",
				"forbidden_paths",
				"unsafe_symlink",
				"unsafe_tree",
				"unsafe_path",
				"special_file",
				"too_large",
			].includes(error.message)
		)
			throw new ReviewEvidenceUnavailable(error.message);
		throw error;
	}

	rmSync(join(workspace, FEEDBACK_FILE));
	rmSync(join(workspace, FEEDBACK_FULL_FILE), { force: true });
	const reviewedFiles = new Map<string, number>();

	const walk = (root: string, prefix = "") => {
		for (const entry of readdirSync(root, { withFileTypes: true })) {
			const path = prefix + entry.name;

			if (
				path === CONTROL_PLANE_DIR ||
				path === ACCEPTANCE_SUITE_DIR ||
				entry.name === "node_modules" ||
				entry.name === ".git"
			)
				continue;

			if (entry.isDirectory()) walk(join(root, entry.name), `${path}/`);
			else if (entry.isFile())
				reviewedFiles.set(
					path,
					readFileSync(join(root, entry.name), "utf8").split("\n").length,
				);
		}
	};

	walk(workspace);

	const risks = {
		newDependency: fieldOf(gate, "newDependency") === true,
		scriptsChanged: fieldOf(gate, "scriptsChanged") === true,
		dependencies: objectOf(fieldOf(gate, "dependencies")) ?? {},
		installScripts: arrayOf(fieldOf(gate, "installScripts")) ?? [],
	};

	const expected = {
		binding: {
			runId,
			round,
			candidateSha: verdict.candidateSha,
			patchDigest: patch.receipt.patchDigest,
			contractDigest: bound.digest,
			acceptanceDigest: suite.receipt.acceptanceDigest,
			ciRunId: verdict.ciRunId,
			originalBase: bound.contract.base.sha,
			baseSha: verdict.baseSha,
			execution: {
				generation: execution.generation.generation,
				intentDigest: execution.generation.digest,
				attempt: execution.attempt,
				workflowSha,
				workflowDigest,
			},
		},
		files: reviewedFiles,
		scenarios: verdict.unjudged,
		seats: reviewSeats(patch.receipt.changedPaths, risks),
	};

	const stageDir = join(
		config.stateDir,
		"stages",
		runId,
		stageName("review", execution.attempt, round),
	);

	if (
		capturedReviewText(join(stageDir, "execution.json")) !==
			`${JSON.stringify(execution)}\n` ||
		JSON.stringify(expected.binding) !== JSON.stringify(execution.binding) ||
		JSON.stringify(expected.seats) !== JSON.stringify(execution.seats)
	)
		throw new ReviewEvidenceUnavailable("review_execution_binding");

	const path = join(stageDir, "review.json");

	if (!existsSync(path)) {
		if (readdirSync(stageDir).some((name) => name !== "execution.json"))
			throw new ReviewEvidenceUnavailable("review_execution_binding");

		let owner = "";
		let repairDiff: string | null = null;
		let previousFindings: ReturnType<typeof reviewFeedback> = [];

		if (round > 0 && !isOwner) {
			const book = (await files.listClaims()).find(
				(claim) => claim.runId === runId,
			)?.handoff;

			if (book?.kind !== "selected")
				throw new ReviewEvidenceUnavailable("repair_book_missing");

			const build = book.accounts.find(
				(a) => a.execution.stage === "build" && a.execution.round === round,
			)?.execution;

			if (build?.stage === "build" && build.cause.kind === "feedback") {
				const batch = readFeedbackBatch(
					config.stateDir,
					runId,
					build.cause.batch,
				);

				if (batch === null)
					throw new ReviewEvidenceUnavailable("feedback_batch_missing");

				owner = renderFeedbackCards(batch.batch.cards);
			}

			const from = build?.stage === "build" ? build.feedbackFrom : null;

			const prior = [...book.history, book.current].find(
				(g) => g.intent.digest === from?.digest,
			);

			if (
				prior?.review !== undefined ||
				(prior?.certification !== null && prior?.certification !== undefined)
			)
				previousFindings = reviewFeedback(
					prior.review ?? prior.certification!.review,
				);

			const previous = readRunPatch(
				config.stateDir,
				runId,
				from?.round ?? round - 1,
			);

			if (previous.kind !== "found")
				throw new ReviewEvidenceUnavailable("repair_patch_missing");

			const before = `${workspace}-before`;
			rmSync(before, { recursive: true, force: true });

			try {
				await prepareRepairTree(
					base,
					before,
					previous.patch,
					previous.receipt.changedPaths,
					"{}",
				);
				rmSync(join(before, FEEDBACK_FILE));

				const delta = await collectPatch({
					base: before,
					workspace,
					allowNoChange: true,
					repairTree: true,
				});

				if (delta.kind !== "collected")
					throw new ReviewEvidenceUnavailable("repair_diff_missing");

				repairDiff = Buffer.from(delta.patch).toString("utf8");
			} finally {
				rmSync(before, { recursive: true, force: true });
			}
		}

		const prompt = candidateReviewPrompt({
			owner,
			repairDiff,
			previousFindings,
			contract: bound.contract,
			diff: patch.patch,
			paths: patch.receipt.changedPaths,
			judges: suite.suite.scenarios.filter((s) =>
				verdict.unjudged.includes(s.id),
			),
			guidance: workflow.guidance.stages.review ?? "",
			verdict,
		});

		if (prompt.kind === "refused") return prompt;

		const captured = reviewInputRecord({ ...expected, prompt: prompt.prompt });

		if (
			!publishFile(
				path,
				JSON.stringify({
					version: 3,
					execution,
					input: captured,
					inputDigest: digestOf(JSON.stringify(captured)),
				}),
			)
		)
			throw new ReviewEvidenceUnavailable("review_manifest_unwritable");
	}

	return {
		workspace,
		verdict,
		builder: "model" in patch.receipt ? patch.receipt.model : "unavailable",
		families: {
			builder:
				"model" in patch.receipt
					? await builderFamily(
							config.stateDir,
							runId,
							round,
							patch.receipt.model,
						)
					: FAMILY_MISSING,
			accept: suite.receipt.family ?? FAMILY_MISSING,
		},
		input: readCapturedReview(stageDir, execution, expected),
	};
}

export async function runReview(
	input: StageLaunchInput,
	dir: string,
	createHost: (dir: string, tools: readonly string[]) => StageHost,
	decorate: (prompt: string, seat: string) => Promise<string | null> = async (
		prompt,
	) => prompt,
): Promise<StageResult> {
	const prepared = input.review;

	if (prepared === undefined) throw new Error("review_missing");
	mkdirSync(dir, { recursive: true, mode: 0o700 });

	const execution = input.execution;

	if (
		execution?.stage !== "review" ||
		execution.runId !== input.runId ||
		execution.attempt !== input.attempt ||
		execution.round !== input.round
	)
		throw new ReviewEvidenceUnavailable("review_execution_binding");

	const captured = readCapturedReview(dir, execution, prepared.input);

	if (
		JSON.stringify(reviewInputRecord(captured)) !==
		JSON.stringify(reviewInputRecord(prepared.input))
	)
		throw new ReviewEvidenceUnavailable("review_execution_binding");
	const window = await executionWindow(dir, input);
	const previous = (await executionSpent(dir)) ?? 0;
	const receipts: SeatReceipt[] = [];
	const records: Awaited<ReturnType<typeof readStageReceipt>>[] = [];

	let total = 0,
		turns = 0,
		wallMs = 0;

	const byModel: Record<string, number> = {};

	let parent = 0,
		children = 0;

	let lastHost: StageHost | null = null;

	const finish = async (outcome: SessionOutcome): Promise<StageResult> => {
		const text = JSON.stringify(receipts);

		const kept =
			outcome.kind === "passed" &&
			(existsSync(join(dir, "output.txt")) ||
				publishFile(join(dir, "output.txt"), text));

		const first = records.find((r) => r !== null);

		const receipt: StageReceipt = {
			version: 1,
			runId: input.runId,
			stage: "review",
			attempt: input.attempt,
			outcome: outcome.kind === "passed" && !kept ? CRASHED : outcome,
			settlement: { event: "agent_settled", aborted: null },
			models: { requested: input.settings.model, observed: null },
			fallback: null,
			refusal: null,
			usage: {
				total,
				parent,
				children,
				byModel,
				gateway: total,
				unreadChildren: 0,
			},
			turns,
			wallMs,
			efficiency: aggregateEfficiency(
				records.map(
					(r) =>
						parseEfficiency(fieldOf(r?.record ?? null, "efficiency")) ??
						unknownEfficiency(),
				),
			),
			egress: null,
			stderr: [],
			output: kept
				? {
						file: "output.txt",
						bytes: Buffer.byteLength(text),
						kept: Buffer.byteLength(text),
					}
				: null,
			assetsDigest:
				lastHost?.assetsDigest ??
				textOf(fieldOf(first?.record ?? null, "assetsDigest")) ??
				"",
			versions: lastHost?.versions ?? PINNED_VERSIONS,
			pricing: "unavailable",
		};

		const written =
			replaceUsage(join(dir, "usage.json"), {
				...window,
				turns,
				usage: receipt.usage,
			}) && publishFile(join(dir, "receipt.json"), JSON.stringify(receipt));

		return {
			...stageResult(written ? receipt : { ...receipt, outcome: CRASHED }),
			usage: Math.max(0, total - previous),
		};
	};

	for (const seat of prepared.input.seats) {
		const sessionDir = join(dir, seat);
		let record = await readStageReceipt(join(sessionDir, "receipt.json"));

		if (record === null) {
			if (existsSync(sessionDir)) {
				records.push(null);
				total += (await executionSpent(sessionDir)) ?? 0;

				return finish(CRASHED);
			}

			const host = createHost(sessionDir, input.tools);
			lastHost = host;

			const prompt = await decorate(seatPrompt(prepared.input, seat), seat);

			if (prompt === null) return finish(CRASHED);

			const maxTokens =
				input.settings.maxTokens === null
					? null
					: Math.max(0, input.settings.maxTokens + previous - total);

			const result = await runStage(
				{
					...input,
					prompt,
					source: { bytes: 0, omissions: 0, capHit: false },
					settings: {
						...input.settings,
						model:
							seat === "code-review"
								? (input.settings.codeReviewModel ?? input.settings.model)
								: input.settings.model,
						fallback:
							seat === "security-review" ? input.settings.fallback : null,
						maxTokens,
						budget: {
							...input.settings.budget,
							maxTurns: Math.max(0, input.settings.budget.maxTurns - turns),
							wallMs: Math.max(
								0,
								Math.min(
									window.deadline - Date.now(),
									input.settings.budget.wallMs - wallMs,
								),
							),
						},
					},
					remainingRunTokens: Math.max(
						0,
						input.remainingRunTokens - (total - previous),
					),
					progress: (value) =>
						input.progress(Math.max(0, total - previous) + value),
				},
				host,
			);

			record = await readStageReceipt(join(sessionDir, "receipt.json"));

			if (record === null) {
				total += result.usage;

				return finish(CRASHED);
			}
		}

		records.push(record);
		total += record.usage.total;
		parent += record.usage.parent;
		children += record.usage.children;
		turns += record.turns;
		wallMs += record.wallMs;

		for (const [model, tokens] of Object.entries(record.usage.byModel))
			byModel[model] = (byModel[model] ?? 0) + tokens;

		if (record.outcome.kind !== "passed") return finish(record.outcome);

		const parsed = parseSeat(
			(await boundedText(join(sessionDir, "output.txt"), OUTPUT_MAX_BYTES)) ??
				"",
			seat,
			prepared.input.files,
			prepared.input.scenarios,
		);

		if (parsed === null) return finish({ kind: "failed", exit: "malformed" });
		const models = objectOf(fieldOf(record.record, "models"));
		const fallback = objectOf(fieldOf(record.record, "fallback"));

		const requested =
			textOf(fieldOf(fallback, "requested")) ??
			textOf(fieldOf(models, "requested")) ??
			input.settings.model;

		const family =
			parseFamily(fieldOf(record.record, "family")) ?? FAMILY_MISSING;

		receipts.push({
			...parsed,
			family,
			requested,
			observed:
				textOf(fieldOf(fallback, "observed")) ??
				textOf(fieldOf(models, "observed")),
			label: familyLabel(family, prepared.families?.builder ?? FAMILY_MISSING),
			primary: textOf(fieldOf(models, "requested")) ?? input.settings.model,
			refusal: textOf(fieldOf(record.record, "refusal")),
			fallbackRecord: fallback,
			fallback: fallback !== null,
			tokens: record.usage.total,
		});
	}

	return finish({ kind: "passed" });
}
