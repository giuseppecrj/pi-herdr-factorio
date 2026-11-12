import {
	type PatchBinding,
	type PatchRead,
	buildPrompt,
	visibleTestCommand,
} from "../candidate/build.ts";
import { type BaseRefusal, matchingBaseProof } from "../candidate/diagnosis.ts";
import type { FeedbackBatch } from "../candidate/feedback.ts";
import type {
	CandidateEffectResult,
	CandidateEvent,
	PrObservation,
} from "../candidate/handoff.ts";
import type {
	ReviewInput,
	ReviewInputRefusal,
	ReviewReceipt,
} from "../candidate/review.ts";
import type {
	CandidateEffect,
	CandidateExecution,
	CandidateState,
	GenerationRef,
	RepairCause,
} from "../candidate/state.ts";
import type { Validator } from "../candidate/validation.ts";
import { parseWorkflow } from "../config/parse.ts";
import {
	type AcceptEffort,
	type GitSha,
	type ModelId,
	WORKFLOW_PATH,
} from "../config/schema.ts";
import { acceptancePrompt } from "../contract/acceptance.ts";
import type { ContractRead } from "../contract/artifacts.ts";
import type {
	Contract,
	ContractDigest,
	InlinedFile,
	Link,
	SourceFacts,
	SpecifyReviewInput,
} from "../contract/contract.ts";
import {
	INLINE_TOTAL_BYTES,
	NAMED_FILE_BYTES,
	NAMED_FILE_READ_BYTES,
	inlined,
	namedFiles,
	sourceExcerpts,
	sourceFacts,
	specifyPrompt,
	specifySourceFacts,
} from "../contract/prompt.ts";
import type {
	BudgetCap,
	FailedExit,
	RefusalSignal,
	StageRunSettings,
	StageUsage,
} from "../core/execution.ts";
import type { FamilyInput } from "../core/models.ts";
import { type Digest, type Verdict, digestOf } from "../core/run.ts";
import type { ExecutionStage, ModelStage } from "../core/stages.ts";
import type { SnapshotSource } from "../trust/admission.ts";
import type { Marker } from "../trust/markers.ts";
import type { RepoSlug } from "../trust/platform.ts";
import { retryFeedback, retrySuite } from "./base-check.ts";
import type { ActiveRun } from "./claims.ts";
import type { OrchestratorInput } from "./orchestrator.ts";

type StageAttemptReceipt = {
	readonly wallMs: number;
	readonly usage: StageUsage;
	readonly models: {
		readonly requested: ModelId;
		readonly observed: string | null;
	};
	readonly fallback: {
		readonly requested: ModelId;
		readonly observed: string | null;
	} | null;
	readonly refusal: RefusalSignal | null;
};

/** How a started stage attempt ended, as the sandbox host reports it. */
export type StageResult =
	| {
			readonly kind: "passed";
			readonly usage: number;
			readonly receipt: StageAttemptReceipt;
	  }
	| {
			readonly kind: "failed";
			readonly exit: FailedExit;
			readonly usage: number;
			readonly receipt: StageAttemptReceipt;
	  }
	| {
			readonly kind: "refused";
			readonly usage: number;
			readonly receipt: StageAttemptReceipt;
	  }
	| {
			readonly kind: "budget_exhausted";
			readonly cap: BudgetCap;
			readonly usage: number;
			readonly receipt: StageAttemptReceipt;
	  };

/** How a stage launch ended before any model ran. */
export type StageLaunch =
	| {
			readonly kind: "unavailable";
			readonly stage: import("../core/stages.ts").SandboxStage;
			readonly reason: "sandbox_unavailable";
	  }
	| { readonly kind: "started"; readonly done: Promise<StageResult> };

export type StageLaunchInput = {
	readonly runId: Digest;
	readonly stage: ExecutionStage;
	readonly attempt: number;
	readonly execution?: CandidateExecution;
	readonly workspace: string;
	readonly prompt: string;
	readonly source?: SourceFacts;
	readonly specify?: SpecifyReviewInput;
	readonly acceptDraft?: {
		readonly contract: Contract;
		readonly digest: ContractDigest;
		readonly repo: RepoSlug;
		readonly issue: number;
		readonly baseSha: GitSha;
	};
	readonly round?: number;
	readonly review?: ReviewPreparation;
	readonly build?: {
		readonly binding: PatchBinding;
		readonly command: string;
		readonly allowNoChange: boolean;
	};
	readonly tools: readonly string[];
	readonly skills: readonly string[];
	readonly measurement?: {
		readonly kind: "score" | "explain";
		readonly scoredRunId: Digest;
		readonly seq: number;
	};
	readonly maintenance?: {
		readonly job: import("../config/schema.ts").CadenceJob;
		readonly windowStart: number;
	};
	readonly acceptEffort?: AcceptEffort;
	readonly settings: StageRunSettings;
	readonly remainingRunTokens: number;
	readonly signal: AbortSignal;
	/** Called on every sign of life, with the tokens the stage has used so far. */
	readonly progress: (usage: number) => void;
};

export type ReviewPreparation = {
	readonly input: ReviewInput;
	readonly verdict: Verdict;
	readonly builder: string;
	/** The builder's and the accept author's stored family evidence. Absent, both are missing. */
	readonly families?: {
		readonly builder: FamilyInput;
		readonly accept: FamilyInput;
	};
	readonly workspace: string;
};

export type StageOutput =
	| ReviewInputRefusal
	| { readonly kind: "review"; readonly receipt: ReviewReceipt }
	| { readonly kind: "build"; readonly result: PatchRead }
	| string
	| { readonly kind: "pending" }
	| {
			readonly kind: "output";
			readonly text: string;
			readonly model: string;
			readonly observed: string | null;
			/** The answering session's stored family, for accept. */
			readonly family?: FamilyInput;
	  };

type WorkflowPin = Pick<ActiveRun, "workflowSha" | "workflowDigest">;

export interface StageExecutor {
	baseCheck?(
		input: import("../candidate/diagnosis.ts").BaseCheckInput,
	): Promise<import("../candidate/diagnosis.ts").BaseCheckProgress>;
	stopBase?(runId: Digest): Promise<void>;
	candidate?: {
		sweep?(repo: RepoSlug, now: number): Promise<void>;
		observeMissing?(marker: Marker): Promise<PrObservation>;
		observe(
			state: CandidateState,
			now: number,
		): Promise<
			Omit<
				Extract<CandidateEvent, { kind: "observed" }>,
				"executionAllowed" | "capacityAvailable"
			>
		>;
		execute(
			state: CandidateState,
			effect: Exclude<
				CandidateEffect,
				{
					kind:
						| "validate"
						| "launch_review"
						| "repair_build"
						| "stop_execution";
				}
			>,
		): Promise<CandidateEffectResult | null>;
		patch(
			state: CandidateState,
			round: number,
		): Promise<
			| Extract<PatchRead, { kind: "found" }>
			| import("../candidate/state.ts").OwnerPatchRead
			| null
		>;
	};
	prepareReview?(
		input: WorkflowPin & {
			runId: Digest;
			round: number;
			execution?: Extract<CandidateExecution, { stage: "review" }>;
			workspace: string;
		},
	): Promise<ReviewPreparation | ReviewInputRefusal>;
	readonly validate?: Validator;
	readonly ownerValidate?: Validator;
	/** Re-reads a stored validation assessment; null when absent or unreadable. */
	readAssessment(input: {
		runId: Digest;
		round: number;
		generation: number;
	}): Promise<import("../candidate/validation.ts").ReadAssessment | null>;
	/** Re-reads the content-addressed owner batch before a repair launch. */
	readFeedback?(runId: Digest, digest: Digest): Promise<FeedbackBatch | null>;
	cleanupValidation?(): Promise<void>;
	/** Stops whatever a previous controller left running. Called once, before the first tick adopts a run. */
	recover(): Promise<void>;
	/**
	 * Whether nothing a previous controller left can still be running, so
	 * `spent` no longer grows for its attempts. A reconcile that failed is
	 * tried again.
	 */
	reconciled(): Promise<boolean>;
	/** Whether the stage sandbox can run. A `blocked` run replays only after this passes. */
	preflight(): Promise<boolean>;
	/** Result usage is new spend; a resumed attempt's receipt also includes its recorded sessions. */
	launch(input: StageLaunchInput): Promise<StageLaunch>;
	/**
	 * Tokens an attempt an earlier controller ran is known to have used: its
	 * receipt's total, else its session receipts or gateway audit tallies. `null` when none exists.
	 */
	spent(input: {
		readonly runId: Digest;
		readonly stage: ExecutionStage;
		readonly attempt: number;
		readonly round?: number;
		readonly execution?: CandidateExecution;
	}): Promise<number | null>;
	/**
	 * The final text of an execution of the attempt that passed and kept it,
	 * so a restart can finish a stage without running it again. Untrusted.
	 * `pending` resumes a recorded session sequence in the same attempt.
	 */
	output(
		input: {
			readonly runId: Digest;
			readonly attempt: number;
			readonly round?: number;
			readonly execution?: CandidateExecution;
		} & (
			| { readonly stage: Exclude<ModelStage, "review"> }
			| ({ readonly stage: "review" } & WorkflowPin)
		),
	): Promise<StageOutput | null>;
	checkout(input: {
		readonly runId: Digest;
		readonly repo: RepoSlug;
		readonly sha: GitSha;
		readonly workspace: string;
		readonly build?: boolean;
		readonly round?: number;
		readonly feedbackFrom?: GenerationRef;
		readonly cause?: RepairCause;
	}): Promise<CheckoutResult>;
}

export type StageEnd = Pick<StageResult, "kind" | "usage"> & {
	readonly wallMs?: number;
	/** The sandbox cap a `budget_exhausted` attempt hit. */
	readonly cap?: Extract<StageResult, { kind: "budget_exhausted" }>["cap"];
	/** The structured signal a `refused` attempt reported. */
	readonly refusal?: StageResult["receipt"]["refusal"];
	readonly output: string | null;
	readonly build?: PatchRead;
	readonly model?: string;
	readonly observed?: string | null;
	readonly family?: FamilyInput;
};

export type Checkout = {
	readonly files: readonly string[];
	/** A listed file's text, or `null` when it is over `capBytes` or unreadable. */
	read(path: string, capBytes: number): Promise<string | null>;
};

export type CheckoutResult =
	| {
			readonly kind: "ready";
			readonly checkout: Checkout;
			readonly omitted: number | null;
	  }
	| { readonly kind: "refused"; readonly reason: string }
	| { readonly kind: "unavailable" };

export type StageInputs = {
	readonly contract?: Extract<ContractRead, { kind: "found" }>;
	readonly files: ReadonlySet<string>;
	readonly source: SnapshotSource;
	readonly link: Link | null;
};

type Prepared = {
	readonly kind: "ready";
	/** `null` for a launch the sandbox will refuse, which reads no input. */
	readonly inputs: StageInputs | null;
	readonly prompt: string;
	readonly workspace?: string;
	readonly source?: SourceFacts;
	readonly build?: StageLaunchInput["build"];
	readonly specify?: SpecifyReviewInput;
};

export const UNPREPARED: Prepared = { kind: "ready", inputs: null, prompt: "" };

type WorkspacePreparation =
	| { readonly kind: "fresh" }
	| { readonly kind: "replayed_missing" }
	| { readonly kind: "unavailable" };

export async function prepareWorkspace(
	input: Pick<OrchestratorInput, "files" | "log">,
	run: ActiveRun,
): Promise<WorkspacePreparation> {
	const workspace = await input.files.ensureWorkspace(run.runId);

	if (workspace === "unavailable") {
		input.log("workspace_unavailable", {
			issue: run.issue,
			runId: run.runId,
		});

		return { kind: "unavailable" };
	}

	run.replay = false;

	if (workspace === "created") {
		run.workspaceMissing = true;
		input.log("workspace_missing", {
			issue: run.issue,
			runId: run.runId,
			stage: run.stage,
		});

		return { kind: "replayed_missing" };
	}

	return { kind: "fresh" };
}

export async function stageInputs(
	input: Pick<
		OrchestratorInput,
		"files" | "repo" | "log" | "executor" | "env" | "platform" | "store"
	>,
	run: ActiveRun,
): Promise<
	| Prepared
	| { readonly kind: "wait" }
	| {
			readonly kind: "fail";
			readonly why: string;
			readonly refusal?: BaseRefusal;
	  }
> {
	const { files, repo } = input;
	const fields = { issue: run.issue, runId: run.runId };

	const wait = (why: string) => {
		input.log("stage_inputs_unavailable", { ...fields, why });

		return { kind: "wait" } as const;
	};

	const fail = (why: string, refusal?: BaseRefusal) => {
		input.log("stage_inputs_refused", { ...fields, why });

		return { kind: "fail", why, refusal } as const;
	};

	if (
		run.stage !== "specify" &&
		run.stage !== "accept" &&
		run.stage !== "build"
	)
		return fail("no_prompt");

	const contract =
		run.stage !== "specify" ? await files.readContract(run.runId) : null;

	if (contract?.kind === "blocked") return fail(contract.reason);

	if (
		contract?.kind === "found" &&
		(contract.contract.base.sha !== run.workflowSha ||
			contract.contract.base.repo !== repo ||
			contract.contract.issue !== run.issue ||
			contract.contract.snapshot.digest !== run.snapshotDigest)
	)
		return fail("contract_binding");

	const workspace =
		run.stage === "build"
			? `${files.workspacePath(run.runId)}-build-r${run.round ?? 0}-${run.attempt}`
			: files.workspacePath(run.runId);

	const checked = await input.executor
		.checkout({
			runId: run.runId,
			repo,
			sha: run.workflowSha,
			workspace,
			build: run.stage === "build",
			round: run.round ?? 0,
			feedbackFrom:
				run.handoff?.kind === "selected" &&
				run.handoff.work.kind === "effect" &&
				run.handoff.work.request.kind === "repair_build"
					? run.handoff.work.request.execution.feedbackFrom
					: undefined,
			cause:
				run.handoff?.kind === "selected" &&
				run.handoff.work.kind === "effect" &&
				run.handoff.work.request.kind === "repair_build"
					? run.handoff.work.request.execution.cause
					: undefined,
		})
		.catch((): CheckoutResult => ({ kind: "unavailable" }));

	if (checked.kind === "unavailable") return wait("checkout");

	if (checked.kind === "refused") return fail(`checkout_${checked.reason}`);

	if (run.stage === "accept" && checked.omitted !== 0)
		return fail("checkout_base_tree_unsupported");

	const { checkout } = checked;

	const workflow = await checkout.read(WORKFLOW_PATH, 256 * 1024);

	if (workflow === null || digestOf(workflow) !== run.workflowDigest) {
		return fail("workflow_mismatch");
	}

	const parsed = parseWorkflow({
		text: workflow,
		repo,
		env: input.env,
		platform: input.platform,
	});

	if (parsed.kind === "invalid") return fail("workflow_invalid");

	if (contract?.kind === "found") {
		const shown = await sourceExcerpts({
			files: contract.contract.files,
			evidence: contract.contract.evidence,
			checkout,
			identity: `${repo}@${run.workflowSha}${run.stage === "build" && (run.round ?? 0) > 0 ? ` workspace-r${run.round}-${run.attempt}` : ""}`,
			repair: run.stage === "build" && (run.round ?? 0) > 0,
			accept: run.stage === "accept",
		});

		let build: Prepared["build"];

		if (run.stage === "build") {
			const suite = await files.artifacts.read(
				run.runId,
				contract.contract,
				contract.digest,
			);

			if (suite.kind !== "found")
				return fail(
					suite.kind === "blocked" ? suite.reason : "acceptance_missing",
				);

			const binding = {
				runId: run.runId,
				repo,
				issue: run.issue,
				contractDigest: contract.digest,
				acceptanceDigest: suite.receipt.acceptanceDigest,
				baseSha: run.workflowSha,
				gateSha: run.workflowSha,
			};

			const qualified = await input.executor
				.baseCheck?.({
					binding,
					acceptAttempt: run.baseCheck?.acceptAttempt ?? 1,
					storedAttempt: run.baseCheck?.storedAttempt,
					remainingAcceptMs: 0,
					signal: new AbortController().signal,
					readOnly: true,
				})
				.catch(() => undefined);

			if (
				qualified?.kind !== "ready" ||
				!matchingBaseProof(qualified.proof, binding)
			)
				return fail("base_evidence_missing", {
					binding,
					receiptDigest: digestOf(
						JSON.stringify({ binding, round: run.round ?? 0 }),
					),
					reason: "base_evidence_missing",
					scenarios: [],
				});

			build = {
				binding: {
					runId: run.runId,
					round: run.round ?? 0,
					baseSha: contract.contract.base.sha,
					contractDigest: contract.digest,
					acceptanceDigest: suite.receipt.acceptanceDigest,
				},
				command: visibleTestCommand(parsed.guidance),
				allowNoChange: false,
			};
		}

		return {
			kind: "ready",
			workspace,
			build,
			source: sourceFacts(shown),
			inputs: {
				contract,
				files: new Set(checkout.files),
				source: contract.contract.snapshot.source,
				link: null,
			},
			prompt:
				run.stage === "build"
					? buildPrompt({
							feedback:
								run.handoff?.kind === "selected" &&
								run.handoff.work.kind === "effect" &&
								run.handoff.work.request.kind === "repair_build" &&
								run.handoff.work.request.execution.cause.kind === "feedback",
							contract: contract.contract,
							guidance: parsed.guidance,
							inlined: shown,
						})
					: acceptancePrompt({
							contract: contract.contract,
							files: checkout.files,
							inlined: shown,
							guidance: parsed.guidance,
							feedback: await retryFeedback(input, run),
							previousSuite: await retrySuite(input, run, contract),
						}),
		};
	}

	const stored = await input.store.readSnapshot({
		repo,
		issue: run.issue,
		eventId: run.eventId,
	});

	if (stored.kind !== "found") return wait("snapshot");

	if (stored.receipt.snapshotDigest !== run.snapshotDigest) {
		return fail("snapshot_mismatch");
	}

	const linked = await files.readLink(run.runId);

	if (linked.kind === "unreadable") return wait("link");

	const link = linked.kind === "found" ? linked.link : null;
	const answers = link === null ? null : await files.readAnswers(run.runId);

	if (
		link !== null &&
		(answers === null || answers.digest !== link.answersDigest)
	) {
		return wait("answers");
	}

	const set = new Set(checkout.files);
	const { title, body } = stored.snapshot;
	const readme = checkout.files.find((path) => /^readme\.md$/i.test(path));

	const wanted = [
		...(readme === undefined ? [] : [readme]),
		...namedFiles(
			[title, body, ...(answers?.answers ?? []).map((a) => a.body)].join("\n"),
			set,
		),
	];

	const shown: InlinedFile[] = [];
	let budget = INLINE_TOTAL_BYTES;

	for (const path of new Set(wanted)) {
		const text = await checkout.read(path, NAMED_FILE_READ_BYTES);

		if (text === null || budget < 1024) continue;

		const file = inlined(path, text, Math.min(NAMED_FILE_BYTES, budget));

		budget -= Buffer.byteLength(file.text, "utf8");
		shown.push(file);
	}

	return {
		kind: "ready",
		inputs: { files: set, source: stored.receipt.snapshotSource, link },
		source: specifySourceFacts(shown),
		specify: { title, body, answers, files: checkout.files },
		prompt: specifyPrompt({
			repo,
			baseSha: run.workflowSha,
			guidance: parsed.guidance,
			files: checkout.files,
			inlined: shown,
			title,
			body,
			answers,
		}),
	};
}
