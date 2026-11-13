import { CadenceRunner } from "../../../src/maintenance/cadence.ts";
import { parseStoredContract } from "../../../src/contract/artifacts.ts";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach } from "node:test";
import { type ControllerRuntime } from "../../../host/cli/platform.ts";
import { runCli } from "../../../host/cli/index.ts";
import { runStage, type StageHost } from "../../../host/sandbox/run-stage.ts";
import { PassThrough } from "node:stream";
import type { JsonValue } from "../../../src/core/json.ts";
import type { ControlEvent } from "../../../host/gateway/control.ts";
import {
	acquireLock,
	type ProcessTable,
} from "../../../host/controller/lock.ts";
import { fileRunFiles } from "../../../host/controller/run-files.ts";
import { GitHubTicketAdapter } from "../../../src/github/adapter.ts";
import {
	type AdmissionStore,
	type AdmittedReceipt,
	type IssueSnapshot,
	type LocalSwitch,
	type SnapshotReader,
} from "../../../src/trust/admission.ts";
import {
	type AnswersRecord,
	type Link,
} from "../../../src/contract/contract.ts";
import type { Exec } from "../../../src/github/exec.ts";
import { parseMarker } from "../../../src/trust/markers.ts";
import {
	type LogFields,
	Orchestrator,
	type OrchestratorInput,
	type TickReport,
} from "../../../src/controller/orchestrator.ts";
import type { ClaimRecord, RunFiles } from "../../../src/controller/claims.ts";
import type {
	CheckoutResult,
	StageExecutor,
	StageLaunch,
	StageLaunchInput,
	StageOutput,
	StageResult,
} from "../../../src/controller/launch.ts";
import { type SessionOutcome } from "../../../src/core/execution.ts";
import { stageResult } from "../../../host/sandbox/result.ts";
import { READY_LABEL } from "../../../src/trust/policy.ts";
import {
	qualifiedProof,
	storedAssessment,
	verdictAssessment,
} from "../../helpers.ts";
import {
	assessBase,
	type BaseCheckInput,
	type BaseCheckProgress,
	type BaseReason,
	type BaseReceipt,
} from "../../../src/candidate/diagnosis.ts";
import { type LedgerOutbox } from "../../../src/ledger/outbox.ts";
import { readAssessmentBytes } from "../../../src/candidate/validation.ts";
import type { CandidateState } from "../../../src/candidate/state.ts";
import { type Digest, digestOf, runIdOf } from "../../../src/core/run.ts";
import { type GitSha, isGitSha } from "../../../src/config/schema.ts";
import { isRepoSlug, type RepoSlug } from "../../../src/trust/platform.ts";
import {
	FAKE_REPO,
	FakeGitHub,
	type FakeIssue,
	fakeIssue,
	labelEvent,
	BOT_LOGIN,
	httpError,
	MAIN_SHA,
	networkError,
	renamedEvent,
	TRUSTED_RUN_CAP,
	TRUSTED_WORKFLOW,
} from "../../fake-ticket-adapter.ts";
import { EXE_DEV_PLATFORM } from "../../../src/trust/platform.ts";
import { controllerEnv, noPlatformFile } from "../../helpers.ts";

export function slug(text: string): RepoSlug {
	if (!isRepoSlug(text)) throw new Error(`bad slug ${text}`);

	return text;
}

export function sha(text: string): GitSha {
	if (!isGitSha(text)) throw new Error(`bad sha ${text}`);

	return text;
}

export const repo = slug(FAKE_REPO);

export const START = Date.parse("2026-10-29T02:00:00Z");

export class FakeClock {
	t = START;

	now(): number {
		return this.t;
	}
}

export function memoryStore(): AdmissionStore &
	SnapshotReader & {
		records: Map<string, AdmittedReceipt>;
		snapshots: Map<string, IssueSnapshot>;
		local: LocalSwitch;
	} {
	const records = new Map<string, AdmittedReceipt>();
	const snapshots = new Map<string, IssueSnapshot>();
	const local: LocalSwitch = "enabled";

	const store = {
		records,
		snapshots,
		local,
		async localSwitch() {
			return store.local;
		},
		async record(receipt: AdmittedReceipt, snapshot: IssueSnapshot) {
			const key = `${receipt.issue}/${receipt.eventId}`;

			if (records.has(key)) return "duplicate" as const;
			records.set(key, receipt);
			snapshots.set(key, snapshot);

			return "recorded" as const;
		},
		async readSnapshot(key: { issue: number; eventId: string }) {
			const id = `${key.issue}/${key.eventId}`;
			const receipt = records.get(id);

			return receipt === undefined
				? { kind: "absent" as const }
				: {
						kind: "found" as const,
						receipt,
						snapshot: snapshots.get(id) ?? { title: "seeded", body: "" },
					};
		},
		async read(key: { issue: number; eventId: string }) {
			const receipt = records.get(`${key.issue}/${key.eventId}`);

			return receipt === undefined
				? { kind: "absent" as const }
				: { kind: "found" as const, receipt };
		},
		async listEvents(key: { issue: number }) {
			return [...records.values()].flatMap((receipt) =>
				receipt.issue === key.issue ? [receipt.eventId] : [],
			);
		},
	};

	return store;
}

const CHECKOUT_TREE: ReadonlyMap<string, string> = new Map([
	[".github/factory/WORKFLOW.md", TRUSTED_WORKFLOW],
	["README.md", "# pi-herdr-factorio\n"],
	["server/cli.ts", "export const VERSION = 1;\n"],
]);

export function memoryFiles(): RunFiles & {
	claims: Map<string, ClaimRecord>;
	workspaces: Set<string>;
	contracts: Map<string, { bytes: string; digest: string }>;
	questions: Map<string, string>;
	links: Map<string, Link>;
	answers: Map<string, AnswersRecord>;
	unavailable: Set<"contract" | "link">;
	artifactRoot: string;
} {
	const artifactRoot = stateDir();
	const claims = new Map<string, ClaimRecord>();
	const workspaces = new Set<string>();
	const contracts = new Map<string, { bytes: string; digest: string }>();
	const questions = new Map<string, string>();
	const links = new Map<string, Link>();
	const unlinked = new Set<string>();
	const answers = new Map<string, AnswersRecord>();
	const unavailable = new Set<"contract" | "link">();

	return {
		artifactRoot,
		artifacts: fileRunFiles(artifactRoot).artifacts,
		async readContract(runId) {
			const stored = contracts.get(runId);

			if (stored === undefined)
				return { kind: "blocked", reason: "contract_missing" };

			return parseStoredContract(
				stored.bytes,
				JSON.stringify({
					runId,
					contractDigest: stored.digest,
					bytes: Buffer.byteLength(stored.bytes),
					baseSha: MAIN_SHA,
					snapshotDigest: JSON.parse(stored.bytes).snapshot.digest,
				}),
				runId,
			);
		},
		claims,
		workspaces,
		contracts,
		questions,
		links,
		answers,
		unavailable,
		async writeContract({ contract, bytes, digest }) {
			if (unavailable.has("contract")) return false;

			const known = contracts.get(contract.runId);

			if (known !== undefined) return known.bytes === bytes;

			contracts.set(contract.runId, { bytes, digest });

			return true;
		},
		writeQuestionsComment: fileRunFiles(artifactRoot).writeQuestionsComment,
		async writeQuestions({ runId, digest }) {
			questions.set(runId, digest);

			return true;
		},
		async writeLink(runId, link) {
			if (unavailable.has("link")) return false;

			if (link === null) {
				links.delete(runId);
				unlinked.add(runId);
			} else {
				unlinked.delete(runId);
				links.set(runId, link);
			}

			return true;
		},
		async readLink(runId) {
			if (unlinked.has(runId)) return { kind: "unlinked" };

			const link = links.get(runId);

			return link === undefined ? { kind: "none" } : { kind: "found", link };
		},
		async writeAnswers(record) {
			answers.set(record.runId, record);

			return true;
		},
		async readAnswers(runId) {
			return answers.get(runId) ?? null;
		},
		workspacePath: (runId) => `/state/workspaces/${runId}`,
		async workspaceState(runId) {
			return workspaces.has(runId) ? "present" : "missing";
		},
		async ensureWorkspace(runId) {
			if (workspaces.has(runId)) return "present";
			workspaces.add(runId);

			return "created";
		},
		async listClaims() {
			return [...claims.values()];
		},
		async writeClaim(claim) {
			claims.set(claim.runId, claim);

			return true;
		},
	};
}

type Behavior =
	| { readonly kind: "unavailable" }
	| { readonly kind: "hang" }
	| { readonly kind: "fail"; readonly usage: number }
	| { readonly kind: "pass"; readonly usage: number }
	| { readonly kind: "refuse"; readonly usage: number }
	| { readonly kind: "budget"; readonly usage: number }
	| { readonly kind: "later"; readonly result: Promise<StageResult> };

export function resultOf(
	input: StageLaunchInput,
	outcome: SessionOutcome,
	usage: number,
): StageResult {
	return stageResult({
		version: 1,
		runId: input.runId,
		stage: input.stage,
		attempt: input.attempt,
		outcome,
		settlement: { event: "agent_settled", aborted: false },
		models: { requested: input.settings.model, observed: null },
		fallback: null,
		refusal: null,
		wallMs: 1,
		turns: 1,
		usage: {
			total: usage,
			parent: usage,
			children: 0,
			byModel: {},
			gateway: usage,
			unreadChildren: 0,
		},
		egress: null,
		stderr: [],
		output: null,
		assetsDigest: "a".repeat(64),
		versions: { pi: "1.4.0", piHerdrAgents: "3.3.1", piHerdrPstack: "0.5.0" },
		pricing: "unavailable",
	});
}

export const CONTRACT_TEXT = JSON.stringify({
	kind: "contract",
	summary: "Print the package version",
	behavior: ["The CLI prints the version"],
	exclusions: ["No other command changes"],
	acceptance: [{ kind: "new_behavior", text: "--version prints 0.1.0" }],
	compatibility: [],
	limits: [],
	files: ["server/cli.ts"],
	evidence: [{ path: "server/cli.ts", start: 1, end: 1, fact: "VERSION" }],
});

export const ACCEPTANCE_TEXT = JSON.stringify({
	version: 2,
	scenarios: [
		{ id: "S1", criteria: ["A1"], checks: ["version.test.ts"], judge: null },
	],
	files: [
		{
			path: "version.test.ts",
			type: "node:test",
			content:
				"import assert from 'node:assert/strict';\nimport { test } from 'node:test';\ntest('version', () => assert.equal(1, 1));\n",
		},
	],
});

export const QUESTIONS_TEXT = JSON.stringify({
	kind: "questions",
	questions: [
		{
			text: "Should the version come from package.json or a constant?",
			cites: [{ path: "server/cli.ts", start: 1, end: 1 }],
		},
	],
});

type BaseOutcome = "ready" | "checking" | "interrupted" | BaseReason;

export class FakeExecutor implements StageExecutor {
	baseOutcome: BaseOutcome = "ready";
	/**
	 * Outcomes by suite, in the order suites first reach the base check. A
	 * list is consumed one launching check at a time; its last entry stays.
	 */
	baseOutcomes: (BaseOutcome | BaseOutcome[])[] | null = null;
	readonly baseSuites: Digest[] = [];
	/** The stored receipt a refusal carries, when the check ran. */
	baseReceipt: ((binding: BaseCheckInput["binding"]) => BaseReceipt) | null =
		null;
	/** What each interrupted base check charged. */
	baseInterruptMs = 1000;
	readonly #interrupted = new Map<Digest, number>();
	readonly baseChecks: BaseCheckInput[] = [];
	readonly baseStops: Digest[] = [];

	async baseCheck(input: BaseCheckInput): Promise<BaseCheckProgress> {
		this.baseChecks.push(input);
		const suite = input.binding.acceptanceDigest;

		if (!this.baseSuites.includes(suite)) this.baseSuites.push(suite);

		const planned = this.baseOutcomes?.[this.baseSuites.indexOf(suite)];

		const outcome =
			planned === undefined
				? this.baseOutcome
				: !Array.isArray(planned)
					? planned
					: input.readOnly !== true && planned.length > 1
						? (planned.shift() ?? this.baseOutcome)
						: (planned.at(-1) ?? this.baseOutcome);

		switch (outcome) {
			case "ready":
				return { kind: "ready", proof: qualifiedProof(input.binding) };
			case "checking":
				return { kind: "checking" };
			case "interrupted":
				this.#interrupted.set(
					suite,
					(this.#interrupted.get(suite) ?? 0) + this.baseInterruptMs,
				);

				return { kind: "interrupted", wallMs: this.baseInterruptMs };
			default: {
				const failure = {
					binding: input.binding,
					receiptDigest: digestOf(
						JSON.stringify([input.binding, input.acceptAttempt]),
					),
					reason: outcome,
					scenarios: ["S1"],
				};

				if (this.baseReceipt === null) return { kind: "refused", failure };
				const receipt = this.baseReceipt(input.binding);

				// Like the controller: every attempt's wall on this binding.
				return {
					kind: "refused",
					failure,
					receipt,
					baseWallMs:
						receipt.evidence.finishedAt -
						receipt.evidence.startedAt +
						(this.#interrupted.get(suite) ?? 0),
				};
			}
		}
	}

	async stopBase(runId: Digest): Promise<void> {
		this.baseStops.push(runId);
	}

	candidate?: StageExecutor["candidate"];
	readonly candidateSpent = new Map<string, number>();
	prepareReview?: StageExecutor["prepareReview"];
	ownerValidate?: import("../../../src/candidate/validation.ts").Validator;
	readonly validations: import("../../../src/candidate/validation.ts").ValidationInput[] =
		[];
	validate: import("../../../src/candidate/validation.ts").Validator = async (
		input,
	) => {
		this.validations.push(input);

		const state = input.state ?? {
			version: 1,
			startedAt: input.now,
			deadline: input.now + input.wallMs,
			round: 0,
			originalBase: input.baseSha,
			baseSha: input.baseSha,
			baseResolved: true,
			publication: null,
			dispatchTry: 0,
			dispatchedAt: null,
			ciRunId: null,
			counters: {},
		};

		await input.save(state);

		return { kind: "waiting", state };
	};
	behaviors: Behavior[] = [];
	fallback: Behavior = { kind: "unavailable" };
	buildBehavior: Behavior = { kind: "unavailable" };
	buildExitCode: number | null = 0;
	buildBaseExitCode: number | null | undefined;
	buildRuntime: "matching" | "legacy" | "different" = "matching";
	missingBuildTests = false;
	buildPolicy: "clean" | "forbidden" = "clean";
	readonly builds = new Map<string, Extract<StageOutput, { kind: "build" }>>();
	acceptBehavior: Behavior = { kind: "unavailable" };
	/** Accept behaviors by launch, before `acceptBehavior`. */
	acceptBehaviors: Behavior[] = [];
	acceptText: string | null = ACCEPTANCE_TEXT;
	outputs: (string | null)[] = [];
	text: string | null = CONTRACT_TEXT;
	readonly kept = new Map<string, string>();
	pending = false;
	readonly outputReads: string[] = [];
	readonly tree = new Map(CHECKOUT_TREE);
	readonly checkouts: string[] = [];
	checkoutResult: "ready" | "unavailable" | "refused" = "ready";
	checkoutOmitted: number | null = 0;
	workflow: () => string | null = () => TRUSTED_WORKFLOW;
	readonly launches: StageLaunchInput[] = [];
	readonly spentBy = new Map<string, number>();
	readonly assessments = new Map<string, string>();
	readonly assessmentReads: string[] = [];

	assess(
		input: import("../../../src/candidate/validation.ts").ValidationInput,
		verdict: import("../../../src/core/run.ts").Verdict,
	) {
		const round = input.round ?? 0;
		const generation = input.generation?.generation ?? 0;
		const read = verdictAssessment(input.runId, round, generation, verdict);

		this.assessments.set(
			`${input.runId}/${round}/${generation}`,
			storedAssessment({
				runId: input.runId,
				round,
				generation,
				verdict,
				assessment: read.assessment,
			}).text,
		);

		return read;
	}

	async readAssessment(input: {
		runId: Digest;
		round: number;
		generation: number;
	}) {
		const key = `${input.runId}/${input.round}/${input.generation}`;
		this.assessmentReads.push(key);
		const text = this.assessments.get(key);

		return text === undefined ? null : readAssessmentBytes(text);
	}

	async output(
		input: Parameters<StageExecutor["output"]>[0],
	): Promise<StageOutput | null> {
		const key = `${input.runId}/${input.stage}${input.round ? `-r${input.round}` : ""}-${input.attempt}`;

		this.outputReads.push(key);

		if (input.stage === "build") return this.builds.get(key) ?? null;

		return this.kept.get(key) ?? (this.pending ? { kind: "pending" } : null);
	}

	async checkout(input: { runId: string }): Promise<CheckoutResult> {
		this.checkouts.push(input.runId);

		if (this.checkoutResult === "unavailable") return { kind: "unavailable" };

		if (this.checkoutResult === "refused") {
			return { kind: "refused", reason: "hardlink" };
		}

		const tree = new Map(this.tree);
		const workflow = this.workflow();

		if (workflow !== null) tree.set(".github/factory/WORKFLOW.md", workflow);

		return {
			kind: "ready",
			omitted: this.checkoutOmitted,
			checkout: {
				files: [...tree.keys()].sort(),
				async read(path, cap) {
					const text = tree.get(path);

					return text === undefined || text.length > cap ? null : text;
				},
			},
		};
	}

	#keep(input: StageLaunchInput): void {
		if (input.stage === "build" && input.build !== undefined) {
			this.builds.set(
				`${input.runId}/build${input.round ? `-r${input.round}` : ""}-${input.attempt}`,
				{
					kind: "build",
					result: {
						kind: "found",
						patch: input.round ? `patch-r${input.round}` : "patch",
						receipt: {
							...input.build.binding,
							version: 1,
							patchDigest: digestOf(
								input.round ? `patch-r${input.round}` : "patch",
							),
							changedPaths: ["server/cli.ts", "test/version.test.ts"],
							policy: this.buildPolicy,
							model: input.settings.model,
							observed: null,
							testCommand: "npm test",
							commandsSource: "builder-reported",
							commandsOmitted: 0,
							scriptsChanged: false,
							testScriptChanged: false,
							testInputsChanged: false,
							commands: [
								{ command: "npm test", exitCode: 1 },
								{ command: "npm test", exitCode: this.buildExitCode },
							],
							visibleTests: this.missingBuildTests
								? null
								: {
										command: "npm test",
										environment:
											this.buildRuntime === "legacy"
												? undefined
												: {
														dependenciesDigest: digestOf("dependencies"),
														runtimeDigest: digestOf("runtime"),
													},
										exitCode: this.buildExitCode,
										base:
											this.buildBaseExitCode === undefined
												? undefined
												: {
														command: "npm test",
														environment:
															this.buildRuntime === "legacy"
																? undefined
																: {
																		dependenciesDigest:
																			digestOf("dependencies"),
																		runtimeDigest: digestOf(
																			this.buildRuntime === "different"
																				? "another runtime"
																				: "runtime",
																		),
																	},
														exitCode: this.buildBaseExitCode,
														tail: "PRIVATE BASE",
														wallMs: 1,
													},
										tail: "private output",
										wallMs: 1,
									},
						},
					},
				},
			);

			return;
		}

		const text =
			input.stage === "accept"
				? this.acceptText
				: this.outputs.length > 0
					? this.outputs.shift()
					: this.text;

		if (text !== null && text !== undefined) {
			this.kept.set(`${input.runId}/${input.stage}-${input.attempt}`, text);
		}
	}
	recovered = 0;
	ready: boolean | null = null;
	stopped = true;

	async recover(): Promise<void> {
		this.recovered++;
	}

	async reconciled(): Promise<boolean> {
		return this.stopped;
	}

	async spent(input: {
		runId: string;
		stage: string;
		attempt: number;
		round?: number;
		execution?: import("../../../src/candidate/state.ts").CandidateExecution;
	}): Promise<number | null> {
		if (input.execution !== undefined)
			return (
				this.candidateSpent.get(input.execution.id) ??
				this.spentBy.get(`${input.stage}-${input.attempt}`) ??
				null
			);

		return this.spentBy.get(`${input.stage}-${input.attempt}`) ?? null;
	}

	async preflight(): Promise<boolean> {
		return (
			this.ready ??
			((this.behaviors[0] ?? this.fallback).kind !== "unavailable" ||
				this.acceptBehavior.kind !== "unavailable")
		);
	}

	async launch(input: StageLaunchInput): Promise<StageLaunch> {
		const launch = await this.launchAttempt(input);
		const execution = input.execution;

		if (launch.kind !== "started" || execution === undefined) return launch;

		return {
			...launch,
			done: launch.done.then((result) => {
				this.candidateSpent.set(
					execution.id,
					(this.candidateSpent.get(execution.id) ?? 0) + result.usage,
				);

				return result;
			}),
		};
	}

	async launchAttempt(input: StageLaunchInput): Promise<StageLaunch> {
		const behavior =
			input.stage === "build"
				? this.buildBehavior
				: input.stage === "accept"
					? (this.acceptBehaviors.shift() ?? this.acceptBehavior)
					: (this.behaviors.shift() ?? this.fallback);

		this.launches.push(input);

		switch (behavior.kind) {
			case "unavailable":
				return {
					kind: "unavailable",
					stage: input.stage,
					reason: "sandbox_unavailable",
				};
			case "hang":
				return { kind: "started", done: new Promise(() => undefined) };
			case "later":
				this.#keep(input);

				return { kind: "started", done: behavior.result };
			case "fail":
				return started(
					resultOf(input, { kind: "failed", exit: "error" }, behavior.usage),
				);
			case "pass":
				this.#keep(input);

				return started(resultOf(input, { kind: "passed" }, behavior.usage));
			case "refuse":
				return started(resultOf(input, { kind: "refused" }, behavior.usage));
			case "budget":
				return started(
					resultOf(
						input,
						{ kind: "budget_exhausted", cap: "tokens" },
						behavior.usage,
					),
				);
			default: {
				const _exhaustive: never = behavior;

				return _exhaustive;
			}
		}
	}
}

function started(result: StageResult): StageLaunch {
	return { kind: "started", done: Promise.resolve(result) };
}

export const EVENT_ID = 34537521383;

export function labeled(
	number: number,
	change: Partial<FakeIssue> = {},
): FakeIssue {
	return fakeIssue(number, {
		timeline: [
			labelEvent({
				id: EVENT_ID + number,
				at: "2026-10-29T01:21:37Z",
				actor: "giuseppecrj",
			}),
		],
		...change,
	});
}

export function runOf(issue: number): Digest {
	return runIdOf({ repo, issue, eventId: String(EVENT_ID + issue) });
}

type Wire = { intercept: Exec | null };

type WorldOptions = {
	verification: OrchestratorInput["verification"];
	cadence?: CadenceRunner;
	measurement?: OrchestratorInput["measurement"];
};

export function world(
	scope: readonly number[] | null = null,
	ledger?: LedgerOutbox,
) {
	const github = new FakeGitHub();
	const clock = new FakeClock();
	const store = memoryStore();
	const memory = memoryFiles();
	const files = ledger === undefined ? memory : { ...memory, ledger };
	const executor = new FakeExecutor();
	const logs: { event: string; fields: LogFields }[] = [];
	const wire: Wire = { intercept: null };

	/** The verification pin each started controller receives, as `serve` reads it from `verification.json`. */
	const options: WorldOptions = { verification: null };

	executor.workflow = () => github.workflow;
	const published = new Map<Digest, { number: number; head: GitSha }>();
	executor.candidate = {
		async observe(state, now) {
			const issue = await new GitHubTicketAdapter({
				exec: wire.intercept ?? github.exec,
				repo,
			}).readIssue(state.pin.issue);

			const pr = published.get(state.pin.runId);

			const report =
				state.kind === "selected" ? state.current.certification?.report : null;

			return {
				kind: "observed",
				now,
				main: sha(MAIN_SHA),
				pr:
					pr === undefined
						? { kind: "none" }
						: {
								kind: "open",
								number: pr.number,
								head: pr.head,
								refHead: pr.head,
							},
				eligibility:
					issue.kind === "failed"
						? "unverified"
						: issue.value.open && issue.value.labels.includes(READY_LABEL)
							? "ready"
							: "withdrawn",
				readiness:
					report == null
						? { kind: "unavailable" }
						: { kind: "current", head: report.candidateSha, report },
			};
		},
		async patch(state, round) {
			const output = [...executor.builds.values()].find(
				(entry) =>
					entry.result.kind === "found" &&
					entry.result.receipt.runId === state.pin.runId &&
					(entry.result.receipt.round ?? 0) === round,
			);

			return output?.result.kind === "found" ? output.result : null;
		},
		async execute(state, request) {
			if (request.kind === "derive_owner_patch") return null;

			if (request.kind === "open_pr") {
				published.set(state.pin.runId, { number: 99, head: request.head });

				return {
					kind: "open_pr",
					request,
					number: 99,
					head: request.head,
					refHead: request.head,
				};
			}

			if (request.kind === "promote_pr") {
				published.set(state.pin.runId, {
					number: request.number,
					head: request.head,
				});

				return {
					kind: "promote_pr",
					request,
					head: request.head,
					refHead: request.head,
				};
			}

			if (request.kind === "complete_handoff")
				return { kind: "complete_handoff", request, now: clock.now() };

			if (request.kind === "void_readiness")
				return { kind: "void_readiness", request };

			if (request.kind === "post_notice")
				return { kind: "post_notice", request };

			return { kind: "finish_pr", request };
		},
	};

	const start = () =>
		new Orchestrator({
			platform: EXE_DEV_PLATFORM,
			exec: (command, args) => (wire.intercept ?? github.exec)(command, args),
			env: () => "/home/exedev",
			repo,
			store,
			files,
			executor,
			clock,
			scope,
			log: (event, fields) => logs.push({ event, fields }),
			verification: options.verification,
			cadence: options.cadence,
			measurement: options.measurement,
		});

	return { github, clock, store, files, executor, logs, wire, options, start };
}

export function statuses(github: FakeGitHub, issue: number): string[] {
	return github.markers(issue).flatMap((body) => {
		const parsed = parseMarker(body);

		if (parsed.kind === "none" && body.includes("<!-- factory-")) return [];

		return [
			parsed.kind === "marker"
				? `${parsed.marker.seq}:${parsed.marker.status}`
				: parsed.kind,
		];
	});
}

export function keepAdmissions(
	from: ReturnType<typeof memoryStore>,
	to: ReturnType<typeof memoryStore>,
): void {
	for (const [key, receipt] of from.records) to.records.set(key, receipt);

	for (const [key, snapshot] of from.snapshots) to.snapshots.set(key, snapshot);
}

export function runIssues(report: TickReport): number[] {
	return report.runs.map((run) => run.issue);
}

export function events(logs: { event: string }[]): string[] {
	return logs.map((entry) => entry.event);
}

/** Pins the admission policy a native run starts with, so attempts are counted. */
export async function instrument(files: RunFiles) {
	assert.equal(
		await files.accounting?.begin({
			v: 2,
			runId: runOf(14),
			startedAt: new Date(START).toISOString(),
			context: {
				kind: "production",
				trustedCap: TRUSTED_RUN_CAP,
				policy: {
					workflowSha: sha(MAIN_SHA),
					workflowDigest: digestOf(TRUSTED_WORKFLOW),
					gates: {
						kind: "known",
						value: { sourceSha: sha(MAIN_SHA), digest: digestOf("gates") },
					},
					autonomy: {
						approveMerge: "always",
						land: "propose",
						digest: digestOf(
							JSON.stringify({ approveMerge: "always", land: "propose" }),
						),
					},
				},
			},
		}),
		true,
	);
}

export async function replayAcceptStop(
	input: StageLaunchInput,
	guard: "tools" | "length" | "requests" | "abort_model" | "abort_draft",
) {
	const stop = new AbortController();
	const interrupted = guard === "abort_model" || guard === "abort_draft";
	let wallMs = 0;
	const stdin = new PassThrough();
	const stdout = new PassThrough();
	let exit = (_code: number | null) => {};

	const exited = new Promise<number | null>((resolve) => {
		exit = resolve;
	});

	let listener: ((event: ControlEvent) => void) | undefined;

	const emit = (record: JsonValue) =>
		stdout.write(`${JSON.stringify(record)}\n`);

	stdin.on("data", (chunk: Buffer) => {
		const command = JSON.parse(chunk.toString());

		if (command.type === "abort")
			emit({ type: "agent_settled", aborted: true });

		if (command.type === "get_last_assistant_text")
			emit({
				type: "response",
				id: command.id,
				command: command.type,
				success: true,
				data: { text: ACCEPTANCE_TEXT },
			});

		if (command.type !== "prompt") return;

		emit({
			type: "response",
			id: command.id,
			command: "prompt",
			success: true,
			data: { disposition: "started" },
		});
		emit({
			type: "message_end",
			message: {
				role: "assistant",
				stopReason:
					guard === "length"
						? "length"
						: guard === "abort_draft"
							? "stop"
							: "toolUse",
				provider: "openai",
				model: "gpt-6.1-sol",
				usage: { totalTokens: 70 },
			},
		});

		if (guard === "abort_model") {
			wallMs = 25;
			stop.abort();
		} else if (guard === "abort_draft")
			emit({ type: "agent_settled", aborted: false });

		if (guard === "tools")
			for (const id of ["a", "b"])
				emit({
					type: "tool_execution_start",
					toolCallId: id,
					toolName: "read",
					args: { path: "PRIVATE-TOOL-ARG" },
				});

		if (guard === "requests") {
			listener?.({ event: "gate_closed", reason: "requests" });
			listener?.({
				event: "usage",
				route: null,
				decision: "deny",
				reason: "budget-closed",
				status: 403,
				bytesIn: 0,
				bytesOut: 0,
				inputTokens: null,
				outputTokens: null,
			});
		}
	});
	stdin.on("end", () => exit(0));

	const host: StageHost = {
		platform: EXE_DEV_PLATFORM,
		now: interrupted ? () => wallMs : Date.now,
		cleanupReserveMs: 100,
		assetsDigest: "a".repeat(64),
		versions: { pi: "1.4.0", piHerdrAgents: "3.3.1", piHerdrPstack: "0.5.0" },
		async startGateway() {
			return {
				socketPath: "unused",
				exited: new Promise(() => {}),
				subscribe: (callback) => {
					listener = callback;
				},
				closeGate: async () => true,
				setRoute: async () => true,
				drainAbort: async () => true,
				shutdown: async () => null,
				kill: () => {},
			};
		},
		async launchPi() {
			return {
				stdin,
				stdout,
				exited,
				kill: () => exit(null),
			};
		},
		stopSandbox: async () => {},
		readChildUsage: async () => null,
		writeReceipt: async () => true,
		writeOutput: async () => {
			throw new Error("must not keep partial suite");
		},
		stderrLog: async () => null,
	};

	return runStage(
		{
			...input,
			signal: AbortSignal.any([input.signal, stop.signal]),
			draftCheck:
				guard !== "abort_draft"
					? undefined
					: async (_text, context) =>
							new Promise((done) => {
								context.signal.addEventListener("abort", () => done(null));
								wallMs = 25;
								stop.abort();
							}),
		},
		host,
	);
}

const dirs: string[] = [];

afterEach(() => {
	for (const dir of dirs.splice(0))
		rmSync(dir, { recursive: true, force: true });
});

export function stateDir(): string {
	const dir = mkdtempSync(join(tmpdir(), "factory-controller-"));

	dirs.push(dir);

	return dir;
}

export function table(pid: number, startTime = "1"): ProcessTable {
	return { self: { pid, startTime } };
}

export const STALE_HOLDER = JSON.stringify({
	pid: 5000,
	startTime: "7",
	acquiredAt: "2026-10-29T01:00:00.000Z",
});

export async function holdLock(state: string, pid = 5000) {
	const held = await acquireLock({
		stateDir: state,
		procs: table(pid, "7"),
		now: () => START,
	});

	assert.equal(held.kind, "acquired");

	return held;
}

export async function cli(
	argv: readonly string[],
	github: FakeGitHub,
	signal = new AbortController(),
	executor = new FakeExecutor(),
	policySource?: ControllerRuntime["policySource"],
) {
	let stdout = "";
	let stderr = "";

	const code = await runCli(argv, {
		readPlatformFile: noPlatformFile,
		exec: github.exec,
		env: controllerEnv(() => "/home/exedev"),
		stdout: (text) => {
			stdout += text;
		},
		stderr: (text) => {
			stderr += text;
		},
		runtime: {
			clock: new FakeClock(),
			procs: table(4242, "100"),
			sleep: async () => {
				signal.abort();
			},
			signal: signal.signal,
			executor: () => executor,
			policySource,
		},
	});

	return { code, stdout, stderr };
}

export function relabel(github: FakeGitHub, issue: FakeIssue): Digest {
	issue.timeline.push(
		labelEvent({
			id: 1,
			at: "2026-10-29T02:30:00Z",
			actor: "giuseppecrj",
			event: "unlabeled",
		}),
		labelEvent({
			id: 34537529999,
			at: "2026-10-29T02:31:00Z",
			actor: "giuseppecrj",
		}),
	);
	issue.updatedAt = "2026-10-29T02:31:00Z";
	github.now = "2026-10-29T02:32:00Z";

	return runIdOf({ repo, issue: issue.number, eventId: "34537529999" });
}

export function lagComments(
	ctx: { github: FakeGitHub; wire: Wire },
	issue: FakeIssue,
	reads: number,
): void {
	const visible = issue.comments.length;
	const path = `repos/${FAKE_REPO}/issues/${issue.number}/comments?`;
	let left = reads;

	ctx.wire.intercept = async (command, args) => {
		if (
			left === 0 ||
			issue.comments.length === visible ||
			!args.some((arg) => arg.startsWith(path))
		) {
			return ctx.github.exec(command, args);
		}

		left--;

		const later = issue.comments.splice(visible);

		try {
			return await ctx.github.exec(command, args);
		} finally {
			issue.comments.push(...later);
		}
	};
}

export function hideMarker(
	ctx: { github: FakeGitHub; wire: Wire },
	issue: FakeIssue,
	seq: number,
) {
	const toggle = { hidden: true };
	const path = `repos/${FAKE_REPO}/issues/${issue.number}/comments?`;

	ctx.wire.intercept = async (command, args) => {
		if (!toggle.hidden || !args.some((arg) => arg.startsWith(path))) {
			return ctx.github.exec(command, args);
		}

		const saved = issue.comments.splice(0);

		issue.comments.push(
			...saved.filter((comment) => !comment.body.includes(`"seq":${seq},`)),
		);

		try {
			return await ctx.github.exec(command, args);
		} finally {
			issue.comments.splice(0, issue.comments.length, ...saved);
		}
	};

	return toggle;
}

export function failClaimWrite(
	files: ReturnType<typeof memoryFiles>,
	seq: number,
) {
	const write = files.writeClaim;
	const control = { failing: true };

	files.writeClaim = async (claim) =>
		control.failing && claim.seq === seq ? false : write(claim);

	return control;
}

export function bySeq(github: FakeGitHub, issue: number): string[] {
	return statuses(github, issue).sort(
		(left, right) => Number.parseInt(left, 10) - Number.parseInt(right, 10),
	);
}

export function behindLogs(logs: { event: string; fields: LogFields }[]) {
	return logs.flatMap((entry) =>
		entry.event === "ledger_behind" ? [entry.fields] : [],
	);
}

export function blockedClaim(issue: number, seq: number): ClaimRecord {
	return {
		runId: runOf(issue),
		issue,
		eventId: String(EVENT_ID + issue),
		seq,
		status: "blocked",
		stage: "specify",
		attempt: 1,
		usage: 0,
	};
}

export function hideStatus(
	ctx: { github: FakeGitHub; wire: Wire },
	issue: FakeIssue,
	status: string,
) {
	const toggle = { hidden: true };
	const path = `repos/${FAKE_REPO}/issues/${issue.number}/comments?`;

	ctx.wire.intercept = async (command, args) => {
		if (!toggle.hidden || !args.some((arg) => arg.startsWith(path))) {
			return ctx.github.exec(command, args);
		}

		const saved = issue.comments.splice(0);

		issue.comments.push(
			...saved.filter(
				(comment) => !comment.body.includes(`"status":"${status}"`),
			),
		);

		try {
			return await ctx.github.exec(command, args);
		} finally {
			issue.comments.splice(0, issue.comments.length, ...saved);
		}
	};

	return toggle;
}

export function endedClaim(
	issue: number,
	seq: number,
	change: Partial<ClaimRecord>,
): ClaimRecord {
	return { ...blockedClaim(issue, seq), ...change };
}

export function capAt(github: FakeGitHub, limit: number): void {
	github.workflow = (github.workflow ?? "").replace(
		/max_concurrent: \d/,
		`max_concurrent: ${limit}`,
	);
}

export function setWorkflow(
	github: FakeGitHub,
	from: string,
	to: string,
): void {
	github.workflow = (github.workflow ?? "").replace(from, to);
}

export function omitFromList(github: FakeGitHub, issue: number): Exec {
	return async (command, args) => {
		const path = args.find((arg) => arg.startsWith("repos/")) ?? "";
		const hidden = github.issues.get(issue);

		if (!path.includes("/issues?") || hidden === undefined) {
			return github.exec(command, args);
		}

		github.issues.delete(issue);

		try {
			return await github.exec(command, args);
		} finally {
			github.issues.set(issue, hidden);
		}
	};
}

export function lastMarkerUsage(
	github: FakeGitHub,
	issue: number,
): number | null {
	const body = github.markers(issue).at(-1) ?? "";
	const parsed = parseMarker(body);

	return parsed.kind === "marker" ? parsed.marker.usage : null;
}

export function settle(): Promise<void> {
	return new Promise((done) => setImmediate(done));
}

export function claimUsage(
	files: ReturnType<typeof memoryFiles>,
	issue: number,
) {
	return [...files.claims.values()].find((claim) => claim.issue === issue)
		?.usage;
}

type Deferred = {
	readonly behavior: Behavior;
	readonly finish: (result: StageResult) => void;
};

export function deferred(): Deferred {
	let finish: (result: StageResult) => void = () => undefined;

	const result = new Promise<StageResult>((done) => {
		finish = done;
	});

	return { behavior: { kind: "later", result }, finish };
}

type Unproved = {
	readonly name: string;
	readonly reason: string;
	readonly degrade: (issue: FakeIssue) => () => void;
};

export const UNPROVED: readonly Unproved[] = [
	{
		name: "an empty timeline",
		reason: "no_label_event",
		degrade(issue) {
			const timeline = issue.timeline;

			issue.timeline = [];

			return () => {
				issue.timeline = timeline;
			};
		},
	},
	{
		name: "a timeline whose latest ready entry is an older removal",
		reason: "not_labeled",
		degrade(issue) {
			const timeline = issue.timeline;

			issue.timeline = [
				labelEvent({
					id: 1234,
					at: "2026-10-29T01:20:00Z",
					actor: "giuseppecrj",
					event: "unlabeled",
				}),
			];

			return () => {
				issue.timeline = timeline;
			};
		},
	},
	{
		name: "an edit count on a never-edited issue",
		reason: "ambiguous_snapshot",
		degrade(issue) {
			issue.totalVersions = 1;

			return () => {
				issue.totalVersions = null;
			};
		},
	},
];

export function touches(call: readonly string[], issue: number): boolean {
	const path = `/issues/${issue}`;

	return call.some(
		(arg) =>
			arg.endsWith(path) ||
			arg.includes(`${path}/`) ||
			arg === `number=${issue}`,
	);
}

export function staleList(github: FakeGitHub, issue: number): Exec {
	return async (command, args) => {
		const path = args.find((arg) => arg.startsWith("repos/")) ?? "";
		const stale = github.issues.get(issue);

		if (!path.includes("/issues?") || stale === undefined) {
			return github.exec(command, args);
		}

		const { state } = stale;

		stale.state = "open";

		try {
			return await github.exec(command, args);
		} finally {
			stale.state = state;
		}
	};
}

export function issueReads(github: FakeGitHub, issue: number): number {
	const path = `repos/${FAKE_REPO}/issues/${issue}`;

	return github.calls.filter((call) => call.includes(path)).length;
}

export function launched(
	logs: { event: string; fields: LogFields }[],
): unknown[] {
	return logs.flatMap((entry) =>
		entry.event === "stage_launched" ? [entry.fields.issue] : [],
	);
}

type Refusal = {
	readonly expect: string;
	readonly settles: boolean;
	readonly degrade: (ctx: ReturnType<typeof world>, issue: FakeIssue) => void;
};

function failing(
	github: FakeGitHub,
	hit: (args: readonly string[]) => boolean,
): Exec {
	return async (command, args) =>
		hit(args) ? networkError() : github.exec(command, args);
}

const ISSUE_14 = `repos/${FAKE_REPO}/issues/14`;

const LABEL_AT = "2026-10-29T01:21:37Z";

const BODY_14 = "Body of fixture 14.";

function version(
	editedAt: string,
	diff: string | null,
	deletedAt: string | null = null,
) {
	return { editedAt, deletedAt, diff };
}

/** Each reachable refusal from a fresh candidate, with its exact detail. */
export const REFUSALS: readonly Refusal[] = [
	{
		expect: "issue_closed",
		settles: true,
		degrade({ github, wire }, issue) {
			issue.state = "closed";
			wire.intercept = staleList(github, 14);
		},
	},
	{
		expect: "actor_withheld",
		settles: true,
		degrade(_, issue) {
			issue.timeline = [
				labelEvent({
					id: EVENT_ID + 14,
					at: LABEL_AT,
					actor: "evil; rm -rf /",
				}),
			];
		},
	},
	{
		expect: "bot_actor",
		settles: true,
		degrade({ github }, issue) {
			github.permissions.set(EXE_DEV_PLATFORM.controllerLogin, "write");
			issue.timeline = [
				labelEvent({
					id: EVENT_ID + 14,
					at: LABEL_AT,
					actor: EXE_DEV_PLATFORM.controllerLogin,
					actorType: "Bot",
				}),
			];
		},
	},
	{
		expect: "unauthorized",
		settles: true,
		degrade(_, issue) {
			issue.timeline = [
				labelEvent({ id: EVENT_ID + 14, at: LABEL_AT, actor: "triager" }),
			];
		},
	},
	{
		expect: "ambiguous_snapshot:label_events_same_second",
		settles: true,
		degrade(_, issue) {
			issue.timeline = [
				labelEvent({ id: 5, at: LABEL_AT, actor: "giuseppecrj" }),
				labelEvent({ id: 6, at: LABEL_AT, actor: "giuseppecrj" }),
			];
		},
	},
	{
		expect: "ambiguous_snapshot:renamed_since_label",
		settles: true,
		degrade(_, issue) {
			issue.timeline = [
				...issue.timeline,
				renamedEvent("2026-10-29T01:30:00Z"),
			];
		},
	},
	{
		expect: "ambiguous_snapshot:edited_at_label_time",
		settles: true,
		degrade(_, issue) {
			issue.versions = [version(LABEL_AT, BODY_14)];
		},
	},
	{
		expect: "ambiguous_snapshot:version_withheld",
		settles: true,
		degrade(_, issue) {
			issue.includesCreatedEdit = true;
			issue.versions = [
				version("2026-10-29T01:00:00Z", null, "2026-10-29T01:10:00Z"),
			];
		},
	},
	{
		expect: "not_labeled",
		settles: false,
		degrade(_, issue) {
			issue.timeline = [
				labelEvent({
					id: 1234,
					at: "2026-10-29T01:20:00Z",
					actor: "giuseppecrj",
					event: "unlabeled",
				}),
			];
		},
	},
	{
		expect: "no_label_event",
		settles: false,
		degrade(_, issue) {
			issue.timeline = [];
		},
	},
	{
		expect: "issue_unavailable",
		settles: false,
		degrade({ github, wire }) {
			wire.intercept = failing(github, (args) => args.includes(ISSUE_14));
		},
	},
	{
		expect: "timeline_unavailable",
		settles: false,
		degrade({ github, wire }) {
			wire.intercept = failing(github, (args) =>
				args.some((arg) => arg.startsWith(`${ISSUE_14}/timeline`)),
			);
		},
	},
	{
		expect: "permission_unavailable",
		settles: false,
		degrade({ github, wire }) {
			wire.intercept = failing(github, (args) =>
				args.some((arg) => arg.startsWith(`repos/${FAKE_REPO}/collaborators/`)),
			);
		},
	},
	{
		expect: "snapshot_unavailable",
		settles: false,
		degrade({ github, wire }) {
			wire.intercept = failing(github, (args) => args.includes("number=14"));
		},
	},
	{
		expect: "state_unwritable",
		settles: false,
		degrade({ store }) {
			store.record = async () => "unwritable";
		},
	},
	{
		expect: "ambiguous_snapshot:rename_history_incomplete",
		settles: false,
		degrade(_, issue) {
			issue.totalRenames = 1;
		},
	},
	{
		expect: "ambiguous_snapshot:title_changed_between_reads",
		settles: false,
		degrade(_, issue) {
			issue.renames = [
				{
					createdAt: "2026-10-29T01:00:00Z",
					previousTitle: "Old",
					currentTitle: "Other",
				},
			];
		},
	},
	{
		expect: "ambiguous_snapshot:body_changed_between_reads",
		settles: false,
		degrade({ github }) {
			github.beforeGraphql = (read) => {
				read.body =
					read.body === BODY_14 ? "Changed after the issue read." : BODY_14;
			};
		},
	},
	{
		expect: "ambiguous_snapshot:history_contradicts_last_edit",
		settles: false,
		degrade(_, issue) {
			issue.totalVersions = 1;
		},
	},
	{
		expect: "ambiguous_snapshot:history_incomplete",
		settles: false,
		degrade(_, issue) {
			issue.lastEditedAt = "2026-10-29T01:40:00Z";
			issue.includesCreatedEdit = true;
			issue.totalVersions = 1;
		},
	},
	{
		expect: "ambiguous_snapshot:history_without_original",
		settles: false,
		degrade(_, issue) {
			issue.lastEditedAt = "2026-10-29T01:40:00Z";
			issue.versions = [version("2026-10-29T01:40:00Z", BODY_14)];
		},
	},
	{
		expect: "ambiguous_snapshot:history_disagrees_with_body",
		settles: false,
		degrade(_, issue) {
			issue.includesCreatedEdit = true;
			issue.versions = [version("2026-10-29T01:00:00Z", "Other body.")];
		},
	},
	{
		expect: "ambiguous_snapshot:no_version_before_label",
		settles: false,
		degrade(_, issue) {
			issue.lastEditedAt = "2026-10-29T01:40:00Z";
			issue.includesCreatedEdit = true;
			issue.versions = [version("2026-10-29T01:40:00Z", BODY_14)];
		},
	},
];

let nextLabelEvent = 34537600000;

export function writesWire(github: FakeGitHub, writes: string[]): Exec {
	return async (command, args) => {
		const method = args[1] === "--method" ? args[2] : null;
		const path = args.find((arg) => arg.startsWith("repos/")) ?? "";

		const route =
			/^repos\/[^/]+\/[^/]+\/issues\/(\d+)\/labels(?:\/(.+))?$/.exec(path);

		if (method !== null && route !== null) {
			const issue = github.issues.get(Number(route[1]));

			if (issue === undefined) return httpError(404, "Not Found");

			if (method === "POST") {
				const names = args.flatMap((arg) =>
					arg.startsWith("labels[]=") ? [arg.slice(9)] : [],
				);

				writes.push(`label+${names.join(",")}`);

				for (const name of names) {
					if (!issue.labels.includes(name)) issue.labels.push(name);
				}

				issue.updatedAt = github.now;

				return { stdout: "[]", stderr: "", code: 0 };
			}

			const name = decodeURIComponent(route[2] ?? "");

			writes.push(`label-${name}`);

			if (!issue.labels.includes(name)) {
				return httpError(404, "Label does not exist");
			}

			issue.labels = issue.labels.filter((label) => label !== name);
			issue.timeline.push(
				labelEvent({
					id: nextLabelEvent++,
					at: github.now,
					actor: BOT_LOGIN,
					label: name,
					event: "unlabeled",
				}),
			);
			issue.updatedAt = github.now;

			return { stdout: "[]", stderr: "", code: 0 };
		}

		if (method === "POST") {
			const body = args.find((arg) => arg.startsWith("body="))?.slice(5) ?? "";
			const parsed = parseMarker(body);

			writes.push(
				parsed.kind === "marker"
					? `marker:${parsed.marker.status}`
					: body.includes("<!-- factory-questions ")
						? "questions"
						: body.includes("<!-- factory-contract ")
							? "summary"
							: "comment",
			);
		}

		return github.exec(command, args);
	};
}

export async function once(controller: Orchestrator): Promise<TickReport> {
	const ticked = await controller.tick();

	await settle();

	return (await controller.drain(async () => settle())) ?? ticked;
}

export function keyed(
	github: FakeGitHub,
	issue: number,
	kind: string,
): string[] {
	return github
		.markers(issue)
		.filter((body) => body.includes(`<!-- factory-${kind} `));
}

export function validationOf(claim: ClaimRecord | undefined) {
	return claim?.handoff?.kind === "selected"
		? (claim.handoff.current.validation ?? undefined)
		: claim?.validation;
}

export function reportOf(verdict: import("../../../src/core/run.ts").Verdict) {
	if (!isGitSha(verdict.candidateSha) || !isGitSha(verdict.gateSha))
		throw new Error("report fixture");

	return {
		candidateSha: verdict.candidateSha,
		gateSha: verdict.gateSha,
		ciRunId: verdict.ciRunId,
		reportId: 456,
		nonce: `${runOf(14).slice(0, 16)}-r0-d1`,
		heldoutDigest: verdict.heldoutDigest,
		externalId: `factory-gates:${verdict.ciRunId}:${runOf(14).slice(0, 16)}-r0-d1`,
	};
}

export function refusedReceipt(
	binding: BaseCheckInput["binding"],
	message: string,
): BaseReceipt {
	const execution = {
		kind: "observed" as const,
		exitCode: 1,
		wallMs: 5,
		files: [
			{
				file: "checks/version.test.ts",
				registered: 1,
				failures: [
					{
						file: "checks/version.test.ts",
						name: "PRIVATE-TEST-NAME",
						message,
						code: "ERR_ASSERTION",
						kind: "assertion" as const,
					},
				],
			},
		],
	};

	return assessBase({
		binding,
		runtime: {
			runner: "fixture",
			node: process.version,
			platform: process.platform,
			bwrap: "fixture",
			protocolDigest: digestOf("protocol"),
		},
		startedAt: 0,
		finishedAt: 4_000,
		source: {
			kind: "ready",
			treeDigest: digestOf("tree"),
			lockDigest: digestOf("lock"),
			gatesDigest: digestOf("gates"),
		},
		execution,
		repeat: execution,
		scenarios: [
			{
				scenario: "S1",
				kind: "preservation",
				mode: "checked",
				file: "checks/version.test.ts",
				oracleKey: {
					contractScopeDigest: digestOf("scope"),
					criteriaDigest: digestOf("criteria"),
					sourceDigest: digestOf("source"),
				},
			},
		],
	}).receipt;
}

/** The handoff request the real port last served, for the faked GitHub reads. */
type PendingHandoff = { readonly state: CandidateState; readonly head: GitSha };

export type HandoffSeen = { pending: PendingHandoff | null };

/** Moves the fake's clock on every POST, so each marker changes the issue's `updated_at` as on GitHub. */
export function advanceOnPost(
	github: FakeGitHub,
	args: readonly string[],
): void {
	if (args[1] !== "--method" || args[2] !== "POST") return;

	github.now = new Date(Date.parse(github.now) + 1000)
		.toISOString()
		.replace(".000Z", "Z");
}

/** Everything one step of a scheduling trace changed: the report, logs, GitHub calls, claim records and markers. */
type TraceStep = {
	readonly name: string;
	readonly report: TickReport | null;
	readonly events: readonly { event: string; fields: LogFields }[];
	readonly calls: readonly string[][];
	readonly claims: readonly ClaimRecord[];
	readonly markers: readonly string[][];
	readonly launches: readonly string[];
};

export async function schedulingTrace(): Promise<TraceStep[]> {
	const { github, clock, executor, files, logs, start } = world();
	const steps: TraceStep[] = [];
	let logged = 0;
	let called = 0;

	const step = (name: string, report: TickReport | null) => {
		steps.push({
			name,
			report: report === null ? null : structuredClone(report),
			events: structuredClone(logs.slice(logged)),
			calls: structuredClone(github.calls.slice(called)),
			claims: structuredClone(
				[...files.claims.values()].sort((a, b) => a.issue - b.issue),
			),
			markers: [14, 15, 16].map((issue) => statuses(github, issue)),
			launches: executor.launches.map(
				(launch) =>
					`${launch.stage}:${launch.runId}:${launch.attempt}:${launch.remainingRunTokens}`,
			),
		});
		logged = logs.length;
		called = github.calls.length;
	};

	for (const issue of [14, 15, 16]) github.add(labeled(issue));

	const late = deferred();

	executor.behaviors = [
		{ kind: "fail", usage: 100 },
		{ kind: "pass", usage: 200 },
		late.behavior,
	];
	executor.acceptBehavior = { kind: "pass", usage: 50 };

	const first = start();

	step("claim and launch", await first.tick());
	await settle();
	step("complete", await first.tick());
	clock.t += 10_000;
	step("retry", await first.tick());

	const launch = executor.launches.at(-1);

	assert.ok(launch);
	launch.progress(40);
	clock.t += 1_000;
	step("progress", await first.tick());

	executor.spentBy.set("specify-2", 75);
	executor.behaviors = [{ kind: "pass", usage: 60 }];

	const second = start();

	step("restart", await second.tick());
	await settle();
	clock.t += 10_000;
	step("after restart", await second.tick());
	await settle();
	clock.t += 10_000;
	step("settled", await second.tick());

	late.finish(resultOf(launch, { kind: "failed", exit: "aborted" }, 90));
	await settle();
	clock.t += 10_000;
	step("late result", await first.tick());

	const third = start();

	step("second restart", await third.tick());

	return steps;
}

/**
 * Two traces as text, with each digest that differs between them, such as a
 * suite's random canary and what it binds, replaced by its order of first
 * appearance. Its 12-character display prefix is replaced too.
 */
export function stableTraces(
	first: readonly TraceStep[],
	second: readonly TraceStep[],
): [string, string] {
	const texts = [JSON.stringify(first), JSON.stringify(second)];
	const [a, b] = texts.map((text) => text.match(/[0-9a-f]{64}/g) ?? []);

	assert.ok(a && b);
	assert.equal(a.length, b.length);
	const names = new Map<string, string>();

	a.forEach((digest, index) => {
		const other = b[index] ?? "";

		if (digest === other || names.has(digest)) return;
		const name = `random-${names.size / 2}`;

		names.set(digest, name);
		names.set(other, name);
	});

	const stable = (text: string) =>
		[...names].reduce(
			(out, [digest, name]) =>
				out.replaceAll(digest, name).replaceAll(digest.slice(0, 12), name),
			text,
		);

	return [stable(texts[0] ?? ""), stable(texts[1] ?? "")];
}

export type FreshPhase = {
	readonly preflight: boolean;
	readonly launch: "unavailable" | "hang" | "pass";
	readonly usage: number;
	readonly spent: Readonly<Record<string, number>>;
	readonly ticks: number;
	readonly now: number;
};

export type FreshOutput = {
	readonly reports: TickReport[];
	readonly logs: { event: string; fields: LogFields }[];
	readonly calls: string[][];
	readonly launches: string[];
	readonly issues: FakeIssue[];
};

/** Runs one controller process over `state` and the issues a previous process left, then exits without cleanup. */
export function freshProcess(
	state: string,
	issues: readonly FakeIssue[],
	phase: FreshPhase,
): FreshOutput {
	const modules = {
		orchestrator: new URL(
			"../../../src/controller/orchestrator.ts",
			import.meta.url,
		).href,
		controller: new URL(
			"../../../host/controller/run-files.ts",
			import.meta.url,
		).href,
		admission: new URL("../../../src/trust/admission.ts", import.meta.url).href,
		fake: new URL("../../fake-ticket-adapter.ts", import.meta.url).href,
		result: new URL("../../../host/sandbox/result.ts", import.meta.url).href,
		platform: new URL("../../../src/trust/platform.ts", import.meta.url).href,
	};

	const code = `
		import { Orchestrator } from ${JSON.stringify(modules.orchestrator)};
		import { fileRunFiles } from ${JSON.stringify(modules.controller)};
		import { fileAdmissionStore } from ${JSON.stringify(modules.admission)};
		import { FakeGitHub, fakeIssue } from ${JSON.stringify(modules.fake)};
		import { stageResult } from ${JSON.stringify(modules.result)};
		import { EXE_DEV_PLATFORM } from ${JSON.stringify(modules.platform)};
		const input = JSON.parse(process.env.L10_FRESH);
		const { state, issues, phase, tree, contract } = input;
		const github = new FakeGitHub();
		const next = Math.max(8999, ...issues.flatMap((i) => i.comments.map((c) => c.id))) + 1;
		const scratch = fakeIssue(1);
		for (let id = 9000; id < next; id++) github.comment(scratch, "");
		for (const issue of issues) github.add(issue);
		const logs = [];
		const launches = [];
		const files = new Map(tree);
		let now = phase.now;
		const executor = {
			async recover() {},
			async reconciled() { return true; },
			async preflight() { return phase.preflight; },
			async spent(at) { return phase.spent[at.stage + "-" + at.attempt] ?? null; },
			async output(at) { return at.stage === "specify" ? contract : null; },
			async readAssessment() { return null; },
			async checkout() {
				return { kind: "ready", omitted: 0, checkout: { files: [...files.keys()].sort(), async read(path, cap) { const text = files.get(path); return text === undefined || text.length > cap ? null : text; } } };
			},
			async launch(at) {
				launches.push(at.stage + ":" + at.attempt + ":" + at.remainingRunTokens);
				if (at.stage !== "specify" || phase.launch === "unavailable") return { kind: "unavailable", stage: at.stage, reason: "sandbox_unavailable" };
				if (phase.launch === "hang") {
					at.progress(phase.usage);
					return { kind: "started", done: new Promise(() => {}) };
				}
				return { kind: "started", done: Promise.resolve(stageResult({
					version: 1, runId: at.runId, stage: at.stage, attempt: at.attempt,
					outcome: { kind: "passed" }, settlement: { event: "agent_settled", aborted: false },
					models: { requested: at.settings.model, observed: null }, fallback: null, refusal: null,
					wallMs: 1, turns: 1,
					usage: { total: phase.usage, parent: phase.usage, children: 0, byModel: {}, gateway: phase.usage, unreadChildren: 0 },
					egress: null, stderr: [], output: null, assetsDigest: "a".repeat(64),
					versions: { pi: "1.4.0", piHerdrAgents: "3.3.1", piHerdrPstack: "0.5.0" }, pricing: "unavailable",
				})) };
			},
		};
		const controller = new Orchestrator({
			platform: EXE_DEV_PLATFORM,
			exec: github.exec,
			env: () => "/home/exedev",
			repo: ${JSON.stringify(repo)},
			store: fileAdmissionStore(state),
			files: fileRunFiles(state),
			executor,
			clock: { now: () => now },
			scope: null,
			log: (event, fields) => logs.push({ event, fields }),
		});
		const reports = [];
		for (let tick = 0; tick < phase.ticks; tick++) {
			reports.push(await controller.tick());
			await new Promise((done) => setImmediate(done));
			now += 30000;
		}
		process.stdout.write(JSON.stringify({ reports, logs, calls: github.calls, launches, issues: [...github.issues.values()] }), () => process.exit(0));
	`;

	const result = spawnSync(
		process.execPath,
		[
			"--experimental-strip-types",
			"--no-warnings",
			"--input-type=module",
			"-e",
			code,
		],
		{
			encoding: "utf8",
			maxBuffer: 64 * 1024 * 1024,
			env: {
				...process.env,
				L10_FRESH: JSON.stringify({
					state,
					issues,
					phase,
					tree: [...CHECKOUT_TREE],
					contract: CONTRACT_TEXT,
				}),
			},
		},
	);

	assert.equal(result.status, 0, result.stderr);

	return JSON.parse(result.stdout);
}
