import { parseStoredContract } from "../src/artifacts.ts";
import assert from "node:assert/strict";
import { execFile, execFileSync } from "node:child_process";
import {
	chmodSync,
	cpSync,
	existsSync,
	mkdirSync,
	symlinkSync,
	renameSync,
	mkdtempSync,
	readFileSync,
	readdirSync,
	rmSync,
	statSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, it } from "node:test";
import { EXIT, runCli } from "../server/cli.ts";
import { sandboxExecutor } from "../server/sandbox.ts";
import { readViewerRun } from "../server/viewer.ts";
import { manifestDigest } from "../server/sandbox/manifest.ts";
import {
	collectPatch,
	storePatch,
	readPatch,
	finishPatch,
} from "../src/build.ts";
import {
	acquireLock,
	fileLedgerOutbox,
	fileRunFiles,
	controllerCandidatePort,
	HOLDER_FILE,
	type ProcessTable,
	parseStartTime,
	readLedgerBacklog,
	serveLoop,
	writeStatus,
} from "../server/controller.ts";
import { GitHubTicketAdapter } from "../src/adapters/github.ts";
import {
	type AdmissionStore,
	type AdmittedReceipt,
	admitTicket,
	type IssueSnapshot,
	type LocalSwitch,
	type SnapshotReader,
} from "../src/admission.ts";
import {
	answersDigestOf,
	type AnswersRecord,
	type Link,
} from "../src/specify.ts";
import type { Exec } from "../src/gh.ts";
import { formatMarker, parseMarker, type RunStatus } from "../src/markers.ts";
import {
	backoffMs,
	type CheckoutResult,
	type ClaimRecord,
	checkIdentity,
	type LogFields,
	Orchestrator,
	type RunFiles,
	type StageExecutor,
	type StageLaunch,
	type StageLaunchInput,
	type StageOutput,
	type StageResult,
	type TickReport,
} from "../src/orchestrator.ts";
import { type SessionOutcome, stageResult } from "../server/sandbox/result.ts";
import { READY_LABEL } from "../src/policy.ts";
import {
	classifiedCase,
	passingVerdict,
	failingVerdict,
	qualifiedProof,
	storedAssessment,
	verdictAssessment,
} from "./helpers.ts";
import {
	assessBase,
	parseBaseReceipt,
	type BaseCheckInput,
	type BaseCheckProgress,
	type BaseReason,
	type BaseReceipt,
} from "../src/diagnosis.ts";
import { advance } from "../src/stages.ts";
import {
	ledgerApiOf,
	parseLedger,
	pumpLedger,
	type LedgerOutbox,
} from "../src/ledger.ts";
import { GitHubPublicationApi, readLedgerFile } from "../src/publication.ts";
import { LedgerGit, repo as ledgerRepo } from "./ledger-git.ts";
import {
	assessmentBinding,
	readAssessmentBytes,
	validationDir,
} from "../src/validation.ts";
import {
	candidateProjection,
	handoffCandidate,
	parseCandidateState,
	type CandidateState,
} from "../src/handoff.ts";
import type { Run } from "../src/run.ts";
import {
	blocksReview,
	JUDGMENT_OUTCOMES,
	ReviewEvidenceUnavailable,
	type JudgmentOutcome,
	type ReviewReceipt,
} from "../src/review.ts";
import { type Digest, digestOf, runIdOf } from "../src/run.ts";
import {
	type GitSha,
	isGitSha,
	isRepoSlug,
	type RepoSlug,
} from "../src/workflow.ts";
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
	TRUSTED_WORKFLOW,
} from "./fake-ticket-adapter.ts";

function slug(text: string): RepoSlug {
	if (!isRepoSlug(text)) throw new Error(`bad slug ${text}`);

	return text;
}

function sha(text: string): GitSha {
	if (!isGitSha(text)) throw new Error(`bad sha ${text}`);

	return text;
}

const repo = slug(FAKE_REPO);
const START = Date.parse("2026-10-29T02:00:00Z");

class FakeClock {
	t = START;

	now(): number {
		return this.t;
	}
}

function memoryStore(): AdmissionStore &
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

function memoryFiles(): RunFiles & {
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

function resultOf(
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

const CONTRACT_TEXT = JSON.stringify({
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

const ACCEPTANCE_TEXT = JSON.stringify({
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

const QUESTIONS_TEXT = JSON.stringify({
	kind: "questions",
	questions: [
		{
			text: "Should the version come from package.json or a constant?",
			cites: [{ path: "server/cli.ts", start: 1, end: 1 }],
		},
	],
});

type BaseOutcome = "ready" | "checking" | "interrupted" | BaseReason;

class FakeExecutor implements StageExecutor {
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
	readonly validations: import("../src/validation.ts").ValidationInput[] = [];
	validate: import("../src/validation.ts").Validator = async (input) => {
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
		input: import("../src/validation.ts").ValidationInput,
		verdict: import("../src/run.ts").Verdict,
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
										exitCode: this.buildExitCode,
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
		execution?: import("../src/handoff.ts").CandidateExecution;
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

const EVENT_ID = 34537521383;

function labeled(number: number, change: Partial<FakeIssue> = {}): FakeIssue {
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

function runOf(issue: number): Digest {
	return runIdOf({ repo, issue, eventId: String(EVENT_ID + issue) });
}

type Wire = { intercept: Exec | null };

function world(scope: readonly number[] | null = null, ledger?: LedgerOutbox) {
	const github = new FakeGitHub();
	const clock = new FakeClock();
	const store = memoryStore();
	const memory = memoryFiles();
	const files = ledger === undefined ? memory : { ...memory, ledger };
	const executor = new FakeExecutor();
	const logs: { event: string; fields: LogFields }[] = [];
	const wire: Wire = { intercept: null };

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

			return { kind: "finish_pr", request };
		},
	};

	const start = () =>
		new Orchestrator({
			exec: (command, args) => (wire.intercept ?? github.exec)(command, args),
			env: () => "/home/exedev",
			repo,
			store,
			files,
			executor,
			clock,
			scope,
			log: (event, fields) => logs.push({ event, fields }),
		});

	return { github, clock, store, files, executor, logs, wire, start };
}

function statuses(github: FakeGitHub, issue: number): string[] {
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

function keepAdmissions(
	from: ReturnType<typeof memoryStore>,
	to: ReturnType<typeof memoryStore>,
): void {
	for (const [key, receipt] of from.records) to.records.set(key, receipt);

	for (const [key, snapshot] of from.snapshots) to.snapshots.set(key, snapshot);
}

function runIssues(report: TickReport): number[] {
	return report.runs.map((run) => run.issue);
}

function events(logs: { event: string }[]): string[] {
	return logs.map((entry) => entry.event);
}

describe("backoffMs", () => {
	it("follows min(10000 * 2^(retry - 1), max)", () => {
		assert.deepEqual(
			[1, 2, 3, 4, 6, 7].map((retry) => backoffMs(retry, 300_000)),
			[10_000, 20_000, 40_000, 80_000, 300_000, 300_000],
		);
	});
});

describe("Orchestrator claims and dispatch", () => {
	it("claims a labeled issue, makes its workspace and records the blocked stage", async () => {
		const { github, files, executor, start } = world();

		github.add(labeled(14));

		const report = await start().tick();

		assert.equal(report.executionEnabled, false);
		assert.deepEqual(report.dispatch, { enabled: true, reasons: [] });
		assert.deepEqual(report.runs, [
			{
				issue: 14,
				runId: runOf(14),
				eventId: String(EVENT_ID + 14),
				stage: "specify",
				status: "blocked",
				attempt: 1,
				seq: 2,
				markerPending: false,
				workspace: "present",
				retryAt: null,
				usage: 0,
			},
		]);
		assert.deepEqual(statuses(github, 14), ["1:claimed", "2:blocked"]);
		assert.ok(files.workspaces.has(runOf(14)));
		assert.deepEqual([...files.claims.keys()], [runOf(14)]);
		assert.equal(executor.launches.length, 1);
	});

	it("makes no per-issue reads and posts nothing on unchanged polls", async () => {
		const { github, clock, start } = world();

		for (const number of [14, 15, 16, 17, 18, 19, 20, 21, 22, 23]) {
			github.add(labeled(number));
		}

		const controller = start();

		await controller.tick();
		clock.t += 30_000;
		await controller.tick();
		clock.t += 30_000;

		const markers = github.calls.filter((call) => call.includes("POST")).length;

		github.calls.length = 0;

		const report = await controller.tick();

		assert.deepEqual(runIssues(report), [14, 15]);
		assert.deepEqual(report.queued, [16, 17, 18, 19, 20, 21, 22, 23]);
		assert.equal(github.calls.length, 4, JSON.stringify(github.calls));
		assert.equal(
			github.calls.filter((call) => call.includes("POST")).length,
			0,
		);
		assert.equal(markers, 4);
	});

	it("keeps at most two claims and queues the third until one is released", async () => {
		const { github, start } = world();

		for (const number of [14, 15, 16]) github.add(labeled(number));

		const controller = start();
		const first = await controller.tick();

		assert.deepEqual(runIssues(first), [14, 15]);
		assert.deepEqual(first.queued, [16]);
		assert.deepEqual(statuses(github, 16), []);

		const closed = github.issues.get(14);

		assert.ok(closed);
		closed.state = "closed";
		closed.updatedAt = "2026-10-29T03:00:00Z";

		const second = await controller.tick();

		assert.deepEqual(runIssues(second), [15, 16]);
		assert.deepEqual(second.queued, []);
		assert.deepEqual(statuses(github, 14), [
			"1:claimed",
			"2:blocked",
			"3:released",
		]);
		assert.deepEqual(statuses(github, 16), ["1:claimed", "2:blocked"]);
		assert.equal(second.totals.releases, 1);
	});

	it("releases a claim whose ready label was removed", async () => {
		const { github, files, start } = world();
		const issue = github.add(labeled(14));
		const controller = start();

		await controller.tick();
		issue.labels = [];
		issue.updatedAt = "2026-10-29T03:00:00Z";

		const report = await controller.tick();

		assert.deepEqual(report.runs, []);
		assert.equal(statuses(github, 14).at(-1), "3:released");
		assert.deepEqual(
			[...files.claims.values()],
			[endedClaim(14, 3, { status: "released" })],
		);

		await controller.tick();

		assert.deepEqual(
			[...files.claims.values()],
			[endedClaim(14, 3, { status: "released" })],
		);
	});

	it("starts a new run when a new ready event replaces the claimed one", async () => {
		const { github, start } = world();
		const issue = github.add(labeled(14));
		const controller = start();

		await controller.tick();

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

		const report = await controller.tick();
		const next = runIdOf({ repo, issue: 14, eventId: "34537529999" });

		assert.deepEqual(statuses(github, 14), [
			"1:claimed",
			"2:blocked",
			"3:released",
			"4:claimed",
			"5:blocked",
		]);
		assert.equal(report.runs[0]?.runId, next);
		assert.notEqual(next, runOf(14));
	});

	it("only touches the issues in scope and reports scoped issues that are not candidates", async () => {
		const { github, start } = world([15, 99]);

		github.add(labeled(14));
		github.add(labeled(15));

		const report = await start().tick();

		assert.deepEqual(runIssues(report), [15]);
		assert.deepEqual(report.absent, [99]);
		assert.deepEqual(statuses(github, 14), []);
	});

	it("records a refusal and does not read the issue again until it changes", async () => {
		const { github, start } = world();

		github.add(
			fakeIssue(14, {
				labels: [READY_LABEL],
				timeline: [
					labelEvent({ id: 5, at: "2026-10-29T01:21:37Z", actor: "triager" }),
				],
			}),
		);

		const controller = start();
		const first = await controller.tick();

		assert.deepEqual(first.refused, [{ issue: 14, reasons: ["unauthorized"] }]);

		github.calls.length = 0;

		const second = await controller.tick();

		assert.deepEqual(second.refused, []);
		assert.equal(github.calls.length, 4);
		assert.deepEqual(statuses(github, 14), []);
	});
});

describe("Orchestrator switches and per-tick reads", () => {
	it("stops new claims while the repository switch is off but keeps existing runs", async () => {
		const { github, start } = world();

		github.add(labeled(14));

		const controller = start();

		await controller.tick();
		github.add(labeled(15));
		github.repoLabels = [];

		const report = await controller.tick();

		assert.deepEqual(report.dispatch, {
			enabled: false,
			reasons: ["repo_switch_off"],
		});
		assert.deepEqual(runIssues(report), [14]);
		assert.equal(report.runs[0]?.status, "blocked");
		assert.deepEqual(statuses(github, 14), ["1:claimed", "2:blocked"]);
		assert.deepEqual(statuses(github, 15), []);
	});

	it("stops new claims while the local switch is off", async () => {
		const { github, store, start } = world();

		github.add(labeled(14));
		store.local = "disabled";

		const report = await start().tick();

		assert.deepEqual(report.dispatch.reasons, ["locally_disabled"]);
		assert.deepEqual(report.runs, []);
		assert.equal(store.records.size, 0);
	});

	it("still reconciles when the workflow cannot load", async () => {
		const { github, start } = world();
		const issue = github.add(labeled(14));
		const controller = start();

		await controller.tick();
		github.workflow = null;
		issue.state = "closed";

		const report = await controller.tick();

		assert.deepEqual(report.dispatch.reasons, ["workflow_unavailable"]);
		assert.equal(statuses(github, 14).at(-1), "3:released");
	});

	it("reads the switch and the workflow once per tick, not per candidate", async () => {
		const { github, start } = world();

		for (const number of [14, 15]) github.add(labeled(number));

		await start().tick();

		const switchReads = github.calls.filter((call) =>
			call.some((arg) => arg.includes("labels/factory%3Aenabled")),
		);

		const workflowReads = github.calls.filter((call) =>
			call.some((arg) => arg.includes("WORKFLOW.md")),
		);

		assert.equal(switchReads.length, 1);
		assert.equal(workflowReads.length, 1);
	});
});

describe("Orchestrator markers", () => {
	it("ignores a forged marker from another account", async () => {
		const { github, start } = world();
		const issue = github.add(labeled(14));

		github.comment(
			issue,
			formatMarker({
				v: 1,
				runId: runOf(14),
				repo,
				issue: 14,
				eventId: String(EVENT_ID + 14),
				eventAt: "2026-10-29T01:21:37Z",
				snapshotDigest: digestOf("x"),
				workflowSha: sha("c".repeat(40)),
				workflowDigest: digestOf("y"),
				stage: "land",
				status: "released",
				attempt: 1,
				seq: 50,
				branch: null,
				pr: null,
				usage: 0,
				cursor: null,
			}),
			{ login: "giuseppecrj", type: "User", appSlug: null },
		);

		const report = await start().tick();

		assert.deepEqual(runIssues(report), [14]);
		assert.deepEqual(statuses(github, 14), ["1:claimed", "2:blocked"]);
	});

	it("fails closed on an edited marker after a restart and dispatches nothing", async () => {
		const { github, start } = world();
		const issue = github.add(labeled(14));

		await start().tick();

		const first = issue.comments[0];

		assert.ok(first);
		first.lastEditedAt = "2026-10-29T03:00:00Z";

		const report = await start().tick();

		assert.deepEqual(report.runs, []);
		assert.deepEqual(report.corrupt, [{ issue: 14, defect: "edited" }]);
		assert.equal(github.markers(14).length, 2);
	});

	it("fails closed on a corrupt bot marker", async () => {
		const { github, start } = world();
		const issue = github.add(labeled(14));

		github.comment(issue, '<!-- factory:run {"v":7} -->');

		const report = await start().tick();

		assert.deepEqual(report.corrupt, [
			{ issue: 14, defect: "unknown_version" },
		]);
		assert.deepEqual(report.runs, []);
		assert.equal(github.markers(14).length, 1);
	});

	it("reads an unanswered POST back on the next tick and never posts it twice", async () => {
		const { github, start } = world();

		github.add(labeled(14));
		github.posts = ["landed_unanswered"];

		const controller = start();
		const first = await controller.tick();

		assert.equal(first.runs[0]?.markerPending, true);
		assert.deepEqual(statuses(github, 14), ["1:claimed"]);

		const second = await controller.tick();

		assert.deepEqual(statuses(github, 14), ["1:claimed", "2:blocked"]);
		assert.equal(second.runs[0]?.markerPending, false);
	});

	it("posts again after the read-back finds a lost POST missing", async () => {
		const { github, start } = world();

		github.add(labeled(14));
		github.posts = ["lost"];

		const controller = start();

		await controller.tick();
		assert.deepEqual(statuses(github, 14), []);

		await controller.tick();
		assert.deepEqual(statuses(github, 14), ["1:claimed", "2:blocked"]);
	});
});

describe("Orchestrator restart recovery", () => {
	it("keeps the run ID and posts no second marker", async () => {
		const { github, executor, logs, start } = world();

		github.add(labeled(14));
		await start().tick();

		const report = await start().tick();

		assert.equal(report.runs[0]?.runId, runOf(14));
		assert.equal(report.runs[0]?.status, "blocked");
		assert.deepEqual(statuses(github, 14), ["1:claimed", "2:blocked"]);
		assert.ok(events(logs).includes("claim_adopted"));
		assert.equal(executor.launches.length, 2);
	});

	it("records a missing workspace, replays the stage and invents nothing", async () => {
		const { github, files, logs, start } = world();

		github.add(labeled(14));
		await start().tick();
		files.workspaces.clear();

		const report = await start().tick();

		assert.equal(report.runs[0]?.workspace, "missing_replayed");
		assert.equal(report.runs[0]?.status, "blocked");
		assert.ok(events(logs).includes("workspace_missing"));
		assert.ok(files.workspaces.has(runOf(14)));
		assert.deepEqual(statuses(github, 14), ["1:claimed", "2:blocked"]);
	});

	it("claims once after a crash between the admission record and the marker", async () => {
		const { github, store, files, start } = world();

		github.add(labeled(14));
		github.posts = ["lost"];
		await start().tick();

		assert.equal(store.records.size, 1);
		assert.equal(files.claims.size, 1);
		assert.deepEqual(statuses(github, 14), []);

		const report = await start().tick();

		assert.equal(report.runs[0]?.runId, runOf(14));
		assert.deepEqual(statuses(github, 14), ["1:claimed", "2:blocked"]);
	});

	it("adopts a claimed marker after a crash before the stage launched", async () => {
		const { github, start, executor } = world();

		github.add(labeled(14));
		github.posts = ["ok", "lost"];
		await start().tick();

		assert.deepEqual(statuses(github, 14), ["1:claimed"]);

		const report = await start().tick();

		assert.equal(report.runs[0]?.status, "blocked");
		assert.deepEqual(statuses(github, 14), ["1:claimed", "2:blocked"]);
		assert.equal(executor.launches.length, 2);
	});

	it("releases a claim whose issue closed while the controller was down", async () => {
		const { github, files, start } = world();
		const issue = github.add(labeled(14));

		await start().tick();
		issue.state = "closed";

		const report = await start().tick();

		assert.deepEqual(report.runs, []);
		assert.equal(statuses(github, 14).at(-1), "3:released");
		assert.deepEqual(
			[...files.claims.values()],
			[endedClaim(14, 3, { status: "released" })],
		);
	});

	it("counts what an interrupted stage spent, from its receipt or gateway tally, when a restart adopts it", async () => {
		const { github, executor, start } = world();

		github.add(labeled(14));
		executor.behaviors = [{ kind: "hang" }];
		await start().tick();

		executor.spentBy.set("specify-1", 700);

		const report = await start().tick();

		assert.deepEqual(
			report.runs.map((run) => [run.status, run.attempt, run.usage]),
			[["retrying", 2, 700]],
		);
		assert.equal(report.totals.usage, 700);
	});

	it("keeps an attempt-end decision across a lost marker and preserves its original retry time", async () => {
		const { github, executor, files, start, clock } = world();
		const disk = fileRunFiles(files.artifactRoot);

		files.accounting = disk.accounting;
		github.add(labeled(14));
		executor.behaviors = [{ kind: "hang" }];
		await start().tick();
		executor.spentBy.set("specify-1", 700);
		github.posts = ["rejected"];
		await start().tick();

		const record = await disk.accounting!.readAttempt(
			runOf(14),
			"specify",
			0,
			1,
		);

		assert.equal(record?.disposition, "interrupted");
		assert.equal(record?.usage, 700);
		assert.equal(record?.next.kind, "retry");
		clock.t += 6_000;
		const restored = await start().tick();

		assert.equal(restored.runs[0]?.attempt, 2);
		assert.equal(restored.runs[0]?.usage, 700);
		assert.equal(executor.launches.length, 1);
		clock.t += 4_000;
		executor.behaviors = [{ kind: "hang" }];
		await start().tick();
		assert.equal(executor.launches.length, 2);
		assert.deepEqual(
			await disk.accounting!.readAttempt(runOf(14), "specify", 0, 1),
			record,
		);
	});

	it("turns an interrupted running stage into a counted retry", async () => {
		const { github, executor, start } = world();

		github.add(labeled(14));
		executor.behaviors = [{ kind: "hang" }];
		await start().tick();

		assert.deepEqual(statuses(github, 14), ["1:claimed", "2:running"]);

		const report = await start().tick();

		assert.equal(report.runs[0]?.attempt, 2);
		assert.equal(report.runs[0]?.status, "retrying");
		assert.deepEqual(statuses(github, 14), [
			"1:claimed",
			"2:running",
			"3:retrying",
		]);
	});

	async function stopAfterUnmarkedSpend(
		ctx: ReturnType<typeof world>,
		spent: number,
	): Promise<void> {
		const { github, executor, start } = ctx;

		github.add(labeled(14));
		github.posts = ["ok", "rejected"];
		executor.behaviors = [{ kind: "hang" }];

		const stop = new AbortController();
		const stateDir = mkdtempSync(join(tmpdir(), "factory-serve-stop-"));

		try {
			await serveLoop({
				orchestrator: start(),
				stateDir,
				signal: stop.signal,
				log: () => {},
				sleep: async () => {
					executor.launches[0]?.progress(spent);
					executor.spentBy.set("specify-1", spent);
					stop.abort();
				},
			});
		} finally {
			rmSync(stateDir, { recursive: true, force: true });
		}

		assert.deepEqual(statuses(github, 14), ["1:claimed"]);
	}

	function usageOf(github: FakeGitHub, issue: number): number[] {
		return github.markers(issue).map((body) => {
			const parsed = parseMarker(body);

			return parsed.kind === "marker" ? parsed.marker.usage : -1;
		});
	}

	for (const [spent, launches] of [
		[499_999, true],
		[500_000, false],
		[500_001, false],
	] as const)
		it(`restores ${spent} spent tokens against the 500000 run cap and ${launches ? "launches with what is left" : "launches nothing"}`, async () => {
			const ctx = world();
			const { github, executor, start } = ctx;

			await stopAfterUnmarkedSpend(ctx, spent);
			executor.behaviors = [{ kind: "hang" }];

			const report = await start().tick();

			if (launches) {
				assert.equal(executor.launches.length, 2);
				assert.equal(executor.launches[1]?.remainingRunTokens, 500_000 - spent);

				return;
			}

			assert.equal(executor.launches.length, 1);
			assert.deepEqual(report.runs, []);
			assert.equal(statuses(github, 14).at(-1), "2:budget_exhausted");
			assert.equal(usageOf(github, 14).at(-1), spent);
		});

	it("gives a replay of a claimed attempt only what that attempt's earlier execution left of the run cap", async () => {
		const ctx = world();
		const { github, executor, start } = ctx;

		await stopAfterUnmarkedSpend(ctx, 499_900);

		executor.behaviors = [{ kind: "pass", usage: 200 }];

		const second = start();

		await second.tick();
		assert.equal(executor.launches[1]?.attempt, 1);
		assert.equal(executor.launches[1]?.remainingRunTokens, 100);

		executor.spentBy.set("specify-1", 500_100);

		const ended = await second.tick();

		assert.deepEqual(statuses(github, 14), [
			"1:claimed",
			"2:running",
			"3:claimed",
			"4:budget_exhausted",
		]);
		assert.equal(usageOf(github, 14).at(-1), 500_100);
		assert.equal(ended.totals.usage, 500_100);
	});

	it("counts a replayed attempt's executions once when the replay is interrupted too", async () => {
		const ctx = world();
		const { github, executor, start } = ctx;

		await stopAfterUnmarkedSpend(ctx, 300);

		executor.behaviors = [{ kind: "hang" }];
		await start().tick();
		assert.equal(executor.launches[1]?.remainingRunTokens, 499_700);
		assert.deepEqual(statuses(github, 14), ["1:claimed", "2:running"]);

		executor.spentBy.set("specify-1", 300 + 50);

		const report = await start().tick();

		assert.deepEqual(
			report.runs.map((run) => [run.status, run.attempt, run.usage]),
			[["retrying", 2, 350]],
		);
		assert.equal(usageOf(github, 14).at(-1), 350);
	});

	/**
	 * Leaves attempt 1 with 300 tokens on disk that no marker counts, and its
	 * last marker `claimed`, or `blocked` after a restart whose launch was
	 * refused.
	 */
	async function seedReplay(
		ctx: ReturnType<typeof world>,
		origin: "claimed" | "blocked",
	): Promise<number> {
		await stopAfterUnmarkedSpend(ctx, 300);

		if (origin === "blocked") {
			await ctx.start().tick();
			assert.deepEqual(statuses(ctx.github, 14), ["1:claimed", "2:blocked"]);
		}

		return statuses(ctx.github, 14).length;
	}

	for (const origin of ["claimed", "blocked"] as const) {
		it(`keeps a ${origin} replay's earlier spend when it stalls with no progress and reports nothing late`, async () => {
			const ctx = world();
			const { github, clock, executor, start } = ctx;

			await seedReplay(ctx, origin);
			executor.behaviors = [{ kind: "hang" }];

			const controller = start();

			await controller.tick();
			assert.equal(executor.launches.at(-1)?.remainingRunTokens, 499_700);

			clock.t += 300_001;

			const stalled = await controller.tick();

			assert.deepEqual(
				stalled.runs.map((run) => [run.status, run.attempt, run.usage]),
				[["retrying", 2, 300]],
			);
			assert.equal(usageOf(github, 14).at(-1), 300);

			executor.behaviors = [{ kind: "hang" }];
			clock.t += 15_000;
			await controller.tick();

			assert.equal(executor.launches.at(-1)?.attempt, 2);
			assert.equal(executor.launches.at(-1)?.remainingRunTokens, 499_700);
		});

		it(`counts a ${origin} replay's progress on top of its earlier spend at a stall, and late usage once`, async () => {
			const ctx = world();
			const { github, clock, executor, start } = ctx;
			const stage = deferred();

			await seedReplay(ctx, origin);
			executor.behaviors = [stage.behavior];

			const controller = start();

			await controller.tick();

			const launch = executor.launches.at(-1);

			assert.ok(launch);
			launch.progress(50);
			clock.t += 300_001;

			const stalled = await controller.tick();

			assert.equal(launch.signal.aborted, true);
			assert.deepEqual(
				stalled.runs.map((run) => [run.status, run.usage]),
				[["retrying", 350]],
			);
			assert.equal(usageOf(github, 14).at(-1), 350);

			stage.finish(resultOf(launch, { kind: "failed", exit: "aborted" }, 80));
			await settle();

			const counted = await controller.tick();

			assert.equal(counted.runs[0]?.usage, 380);
			assert.equal(usageOf(github, 14).at(-1), 380);

			const again = await start().tick();

			assert.equal(again.runs[0]?.usage, 380);
		});

		it(`releases an aborted ${origin} replay with its earlier spend and its progress`, async () => {
			const ctx = world();
			const { github, clock, executor, start } = ctx;

			const seq = await seedReplay(ctx, origin);

			executor.behaviors = [{ kind: "hang" }];

			const controller = start();

			await controller.tick();

			const launch = executor.launches.at(-1);

			assert.ok(launch);
			launch.progress(50);

			const issue = github.issues.get(14);

			assert.ok(issue);
			issue.state = "closed";
			issue.updatedAt = "2026-10-29T03:00:00Z";
			await controller.tick();

			assert.equal(launch.signal.aborted, true);
			assert.equal(statuses(github, 14).at(-1), `${seq + 1}:running`);

			clock.t += 15_000;

			const ended = await controller.tick();

			assert.deepEqual(ended.runs, []);
			assert.equal(statuses(github, 14).at(-1), `${seq + 2}:released`);
			assert.equal(usageOf(github, 14).at(-1), 350);
		});

		it(`counts a ${origin} attempt's earlier executions when a restart releases it`, async () => {
			const ctx = world();
			const { github, start } = ctx;

			const seq = await seedReplay(ctx, origin);
			const issue = github.issues.get(14);

			assert.ok(issue);
			issue.state = "closed";

			const report = await start().tick();

			assert.deepEqual(report.runs, []);
			assert.equal(statuses(github, 14).at(-1), `${seq + 1}:released`);
			assert.equal(usageOf(github, 14).at(-1), 300);
			assert.equal(report.totals.usage, 300);
		});
	}

	it("counts an adopted attempt's earlier executions when its issue closes after a refused launch", async () => {
		const ctx = world();
		const { github, executor, start } = ctx;

		await stopAfterUnmarkedSpend(ctx, 300);

		const controller = start();

		await controller.tick();
		assert.equal(executor.launches.length, 2);
		assert.deepEqual(statuses(github, 14), ["1:claimed", "2:blocked"]);

		const issue = github.issues.get(14);

		assert.ok(issue);
		issue.state = "closed";
		issue.updatedAt = "2026-10-29T03:00:00Z";

		const report = await controller.tick();

		assert.deepEqual(report.runs, []);
		assert.equal(statuses(github, 14).at(-1), "3:released");
		assert.equal(usageOf(github, 14).at(-1), 300);
		assert.equal(report.totals.usage, 300);
	});
});

describe("Orchestrator retries and stalls", () => {
	it("backs off 10 s then 20 s and stops at the attempt cap", async () => {
		const { github, clock, files, executor, start } = world();

		github.add(labeled(14));
		executor.fallback = { kind: "fail", usage: 0 };

		const controller = start();

		await controller.tick();

		const queued = await controller.tick();

		assert.equal(queued.runs[0]?.status, "retrying");
		assert.equal(queued.runs[0]?.attempt, 2);
		assert.equal(
			queued.runs[0]?.retryAt,
			new Date(START + 10_000).toISOString(),
		);

		clock.t += 9_999;
		await controller.tick();
		assert.equal(executor.launches.length, 1);

		clock.t += 1;
		await controller.tick();
		assert.equal(executor.launches.length, 2);

		const second = await controller.tick();

		assert.equal(second.runs[0]?.attempt, 3);
		assert.equal(
			second.runs[0]?.retryAt,
			new Date(clock.t + 20_000).toISOString(),
		);

		clock.t += 20_000;
		await controller.tick();
		assert.equal(executor.launches.length, 3);

		const last = await controller.tick();

		assert.deepEqual(last.runs, []);
		assert.equal(last.totals.retries, 2);
		assert.equal(last.totals.failures, 1);
		assert.equal(statuses(github, 14).at(-1), "7:failed");
		assert.deepEqual(
			[...files.claims.values()],
			[endedClaim(14, 7, { status: "failed", attempt: 3 })],
		);
	});

	it("terminates a stalled stage and queues a retry", async () => {
		const { github, clock, executor, start } = world();

		github.add(labeled(14));
		executor.behaviors = [{ kind: "hang" }];

		const controller = start();

		await controller.tick();

		const launch = executor.launches[0];

		assert.ok(launch);

		clock.t += 200_000;
		launch.progress(0);
		clock.t += 300_000;
		await controller.tick();
		assert.equal(launch.signal.aborted, false);

		clock.t += 1;

		const report = await controller.tick();

		assert.equal(launch.signal.aborted, true);
		assert.equal(report.runs[0]?.status, "retrying");
		assert.equal(report.totals.stalls, 1);
	});

	it("counts retry usage in one run budget", async () => {
		const { github, executor, start } = world();

		github.add(labeled(14));
		executor.behaviors = [{ kind: "fail", usage: 500_000 }];

		const controller = start();

		await controller.tick();

		const report = await controller.tick();

		assert.deepEqual(report.runs, []);
		assert.equal(report.totals.usage, 500_000);
		assert.equal(
			statuses(github, 14).at(-1)?.endsWith(":budget_exhausted"),
			true,
		);
	});

	it("releases a queued retry whose issue closed instead of launching it", async () => {
		const { github, clock, executor, start } = world();
		const issue = github.add(labeled(14));

		executor.behaviors = [{ kind: "fail", usage: 0 }];

		const controller = start();

		await controller.tick();
		await controller.tick();
		issue.state = "closed";
		clock.t += 10_000;

		const report = await controller.tick();

		assert.deepEqual(report.runs, []);
		assert.equal(executor.launches.length, 1);
		assert.equal(statuses(github, 14).at(-1)?.endsWith(":released"), true);
	});
});

describe("Orchestrator base qualification", () => {
	const refusals = (github: FakeGitHub) => keyed(github, 14, "base-refusal");

	it("refuses a broken suite twice before build with only the final keyed public reason", async () => {
		const { github, executor, start } = world();
		github.add(labeled(14));
		executor.behaviors = [{ kind: "pass", usage: 10 }];
		executor.acceptBehavior = { kind: "pass", usage: 20 };
		executor.baseOutcome = "preservation_failed";
		executor.baseReceipt = (binding) => refusedReceipt(binding, FEEDBACK);
		executor.spentBy.set("accept-1", 20);
		const controller = start();
		const report = await once(controller);
		await controller.tick();
		assert.ok(!executor.launches.some((l) => l.stage === "build"));
		assert.deepEqual(
			executor.launches.map((l) => `${l.stage}-${l.attempt}`),
			["specify-1", "accept-1", "accept-2"],
		);
		assert.equal(statuses(github, 14).at(-1)?.endsWith(":failed"), true);
		assert.equal(report.totals.failures, 1);
		assert.equal(refusals(github).length, 1);
		assert.match(
			refusals(github)[0] ?? "",
			/^Acceptance refused before build: preservation_failed\. A preservation check fails on the unchanged base\. Scenarios: S1\.\n\n<!-- factory-base-refusal run=[0-9a-f]{64} r=[0-9a-f]{64} -->$/,
		);
		const checked = executor.baseChecks.filter((c) => c.readOnly !== true);
		assert.equal(executor.baseSuites.length, 2);
		assert.deepEqual(
			checked.map((c) => [c.binding.acceptanceDigest, c.acceptAttempt]),
			[
				[executor.baseSuites[0], 1],
				[executor.baseSuites[1], 2],
			],
		);
		assert.ok(
			refusals(github)[0]?.includes(
				digestOf(JSON.stringify([checked[1]?.binding, 2])),
			),
			"the notice is the second suite's refusal",
		);
		assert.equal(keyed(github, 14, "acceptance").length, 0);
		assert.equal(checked[0]?.binding.issue, 14);
	});

	function refusedReceipt(
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

	const FEEDBACK = "Expected PRIVATE-FEEDBACK-MESSAGE to equal 'v0.1.0'";

	/** Ticks a controller; `pending` leaves a checking base check undrained. */
	async function drive(
		controller: Orchestrator,
		clock: FakeClock,
		pending = false,
	) {
		for (let tick = 0; tick < 4; tick++) {
			if (pending) {
				await controller.tick();
				await settle();
			} else await once(controller);
			clock.t += 600_000;
		}
	}

	const launched = (executor: FakeExecutor) => [
		...new Set(executor.launches.map((l) => `${l.stage}-${l.attempt}`)),
	];

	it("retries a retryable refusal once with private feedback, then builds on a qualified proof", async () => {
		const { github, executor, files, clock, start } = world();
		github.add(labeled(14));
		executor.behaviors = [{ kind: "pass", usage: 10 }];
		executor.acceptBehavior = { kind: "pass", usage: 20 };
		executor.baseOutcomes = ["preservation_failed", "ready"];
		executor.baseReceipt = (binding) => refusedReceipt(binding, FEEDBACK);
		executor.spentBy.set("accept-1", 20);
		await drive(start(), clock);

		assert.deepEqual(launched(executor), [
			"specify-1",
			"accept-1",
			"accept-2",
			"build-1",
		]);
		const [, first, retry, build] = executor.launches;
		assert.doesNotMatch(first?.prompt ?? "", /base-refusal/);

		const block =
			/<base-refusal-([0-9a-f]{32})>\n(.*)\n<\/base-refusal-\1>/.exec(
				retry?.prompt ?? "",
			);

		assert.ok(block, "the retry prompt carries one nonce-tagged block");
		assert.match(retry?.prompt ?? "", new RegExp(`<contract-${block[1]}>`));
		assert.deepEqual(JSON.parse(block[2] ?? ""), {
			reason: "preservation_failed",
			sentence: "A preservation check fails on the unchanged base.",
			scenarios: ["S1"],
			files: [
				{
					scenario: "S1",
					file: "checks/version.test.ts",
					kind: "assertion",
					code: "ERR_ASSERTION",
					message: FEEDBACK,
					failedIn: "both",
				},
			],
			omitted: 0,
		});
		assert.doesNotMatch(retry?.prompt ?? "", /PRIVATE-TEST-NAME/);
		assert.equal(retry?.settings.maxTokens, 25_000 - 20);
		// The retry runs in what is left of the one accept wall.
		assert.equal(first?.settings.budget.wallMs, 900_000);
		assert.equal(retry?.settings.budget.wallMs, 900_000 - 1 - 4_000);

		const run = runOf(14);
		const aside = join(files.artifactRoot, "acceptance", `${run}.retired`);

		const retiredCanary = readFileSync(
			join(aside, "suite", "canary.txt"),
			"utf8",
		).trim();

		assert.match(retiredCanary, /^factory-holdout-[0-9a-f]{64}$/);

		const current = readFileSync(
			join(files.artifactRoot, "acceptance", run, "canary.txt"),
			"utf8",
		).trim();

		assert.notEqual(current, retiredCanary);

		for (const text of [
			build?.prompt ?? "",
			JSON.stringify(build),
			...github.markers(14),
		]) {
			assert.ok(!text.includes(retiredCanary));
			assert.ok(!text.includes("PRIVATE-FEEDBACK-MESSAGE"));
			assert.doesNotMatch(text, /base-refusal-|PRIVATE-TEST-NAME/);
		}

		assert.equal(refusals(github).length, 0);
		assert.equal(keyed(github, 14, "acceptance").length, 1);
		assert.ok(
			keyed(github, 14, "acceptance")[0]?.includes(
				`a=${executor.baseSuites[1]?.slice(0, 12)}`,
			) ?? false,
			keyed(github, 14, "acceptance")[0] ?? "no acceptance summary",
		);
		const claim = files.claims.get(run);
		assert.equal(claim?.stage, "build");
		assert.equal(
			claim?.baseCheck?.retry?.refused.acceptanceDigest,
			executor.baseSuites[0],
		);
		assert.equal(
			claim?.baseCheck?.binding.acceptanceDigest,
			executor.baseSuites[1],
		);
		assert.equal(claim?.baseCheck?.acceptAttempt, 2);
		assert.equal(claim?.baseCheck?.remainingAcceptMs, 900_000 - 2 - 4_000);
		assert.ok(
			executor.baseChecks
				.filter((c) => c.readOnly === true)
				.every(
					(c) =>
						c.binding.acceptanceDigest !== executor.baseSuites[0] ||
						c.acceptAttempt === 1,
				),
		);
	});

	for (const reason of ["base_timeout", "base_runner_error"] as const)
		it(`fails a ${reason} refusal at once, with no retry`, async () => {
			const { github, executor, clock, start } = world();
			github.add(labeled(14));
			executor.behaviors = [{ kind: "pass", usage: 10 }];
			executor.acceptBehavior = { kind: "pass", usage: 20 };
			executor.baseOutcome = reason;
			await drive(start(), clock);
			assert.deepEqual(
				executor.launches.map((l) => l.stage),
				["specify", "accept"],
			);
			assert.equal(statuses(github, 14).at(-1)?.endsWith(":failed"), true);
			assert.equal(refusals(github).length, 1);
			assert.match(refusals(github)[0] ?? "", new RegExp(`: ${reason}\\. `));
		});

	for (const [exhausted, why] of [
		["tokens", "stage_tokens"],
		["attempts", "attempts"],
		["run", "run_tokens"],
		// An accept attempt with no spend record is unknown spend, not zero.
		["unknown_spend", "stage_tokens"],
		// Without the refused suite's receipt its base wall is unknown.
		["no_receipt", "base_receipt"],
		// An interrupted base check on the same suite spent the accept wall.
		["wall", "wall"],
	] as const)
		it(`does not retry when the accept ${exhausted} allowance cannot admit it`, async () => {
			const { github, executor, files, clock, logs, start } = world();
			github.add(labeled(14));
			executor.behaviors = [{ kind: "pass", usage: 10 }];
			executor.acceptBehavior = {
				kind: "pass",
				usage: exhausted === "run" ? 499_990 : 20,
			};
			executor.baseOutcome = "preservation_failed";

			if (exhausted !== "no_receipt")
				executor.baseReceipt = (binding) => refusedReceipt(binding, FEEDBACK);

			if (exhausted !== "unknown_spend")
				executor.spentBy.set("accept-1", exhausted === "tokens" ? 25_000 : 20);

			if (exhausted === "attempts")
				setWorkflow(github, "max_attempts: 3", "max_attempts: 1");

			if (exhausted === "wall") {
				// 1 ms of model wall, 895,000 interrupted and the 4,000 refusal.
				executor.baseOutcomes = [["interrupted", "preservation_failed"]];
				executor.baseInterruptMs = 895_999;
			}

			await drive(start(), clock);
			assert.deepEqual(
				executor.launches.map((l) => l.stage),
				["specify", "accept"],
			);
			assert.deepEqual(
				logs
					.filter((l) => l.event === "accept_retry_unavailable")
					.map((l) => l.fields.why),
				[why],
			);
			assert.equal(statuses(github, 14).at(-1)?.endsWith(":failed"), true);
			assert.equal(refusals(github).length, 1);
			assert.match(refusals(github)[0] ?? "", /: preservation_failed\. /);
			assert.ok(
				existsSync(join(files.artifactRoot, "acceptance", runOf(14))),
				"the refused suite is not retired",
			);
		});

	it("charges the retry to what is left of the accept token allowance", async () => {
		const { github, executor, clock, start } = world();
		github.add(labeled(14));
		executor.behaviors = [{ kind: "pass", usage: 10 }];
		executor.acceptBehavior = { kind: "pass", usage: 20 };
		executor.baseOutcomes = ["preservation_failed", "ready"];
		executor.baseReceipt = (binding) => refusedReceipt(binding, FEEDBACK);
		executor.spentBy.set("accept-1", 18_000);
		await drive(start(), clock);

		const retry = executor.launches.find(
			(l) => l.stage === "accept" && l.attempt === 2,
		);

		assert.equal(retry?.settings.maxTokens, 7_000);
	});

	for (const crash of ["before_retire", "after_retire", "after_claim"] as const)
		it(`relaunches once after a restart between the refusal and the relaunch (${crash})`, async () => {
			const { github, executor, files, clock, start } = world();
			github.add(labeled(14));
			executor.behaviors = [{ kind: "pass", usage: 10 }];
			executor.acceptBehavior = { kind: "pass", usage: 20 };
			executor.baseOutcomes = ["checking"];
			executor.baseReceipt = (binding) => refusedReceipt(binding, FEEDBACK);
			executor.spentBy.set("accept-1", 20);
			await drive(start(), clock, true);
			const claim = files.claims.get(runOf(14));
			const first = claim?.baseCheck;
			assert.ok(first);
			assert.equal(first.retry, undefined);

			if (crash !== "before_retire") {
				const contract = await files.readContract(runOf(14));
				assert.ok(contract.kind === "found");
				assert.equal(
					await files.artifacts.retire(
						runOf(14),
						contract.contract,
						contract.digest,
						first.binding.acceptanceDigest,
					),
					"retired",
				);

				if (crash === "after_claim")
					files.claims.set(runOf(14), {
						...claim,
						baseCheck: {
							...first,
							retry: {
								refused: first.binding,
								reason: "preservation_failed",
								receiptDigest: digestOf(JSON.stringify([first.binding, 1])),
								scenarios: ["S1"],
								baseWallMs: 4_000,
							},
						},
					});
			}

			executor.baseOutcomes = ["preservation_failed", "ready"];
			await drive(start(), clock);
			await drive(start(), clock);
			assert.deepEqual(launched(executor), [
				"specify-1",
				"accept-1",
				"accept-2",
				"build-1",
			]);
			assert.match(
				executor.launches[2]?.prompt ?? "",
				/PRIVATE-FEEDBACK-MESSAGE/,
			);
			assert.equal(refusals(github).length, 0);
			assert.equal(files.claims.get(runOf(14))?.stage, "build");
		});

	it("never grants a second retry after a restart once the retried suite is stored", async () => {
		const { github, executor, files, clock, start } = world();
		github.add(labeled(14));
		executor.behaviors = [{ kind: "pass", usage: 10 }];
		executor.acceptBehavior = { kind: "pass", usage: 20 };
		executor.baseOutcomes = ["preservation_failed", "checking"];
		executor.baseReceipt = (binding) => refusedReceipt(binding, FEEDBACK);
		executor.spentBy.set("accept-1", 20);
		await drive(start(), clock, true);
		assert.equal(
			files.claims.get(runOf(14))?.baseCheck?.binding.acceptanceDigest,
			executor.baseSuites[1],
		);
		executor.baseOutcomes = ["preservation_failed", "preservation_failed"];
		await drive(start(), clock);
		await drive(start(), clock);
		assert.deepEqual(launched(executor), ["specify-1", "accept-1", "accept-2"]);
		assert.equal(statuses(github, 14).at(-1)?.endsWith(":failed"), true);
		assert.equal(refusals(github).length, 1);
		const contract = await files.readContract(runOf(14));
		assert.ok(contract.kind === "found");
		assert.equal(
			await files.artifacts.retire(
				runOf(14),
				contract.contract,
				contract.digest,
				executor.baseSuites[1] ?? digestOf("none"),
			),
			"refused",
		);
	});

	/** The first suite's refusal notice, as the fake keys it. */
	const original = (executor: FakeExecutor, run: Digest) =>
		digestOf(
			JSON.stringify([
				executor.baseChecks.find(
					(c) => c.binding.acceptanceDigest === executor.baseSuites[0],
				)?.binding ?? { runId: run },
				1,
			]),
		);

	for (const ending of ["fail", "budget", "refuse", "hang"] as const)
		it(`posts the first refusal once when the feedback attempt is the last allowed and ends ${ending}`, async () => {
			const { github, executor, clock, start } = world();
			github.add(labeled(14));
			setWorkflow(github, "max_attempts: 3", "max_attempts: 2");
			executor.behaviors = [{ kind: "pass", usage: 10 }];
			executor.acceptBehaviors = [{ kind: "pass", usage: 20 }];
			executor.acceptBehavior =
				ending === "hang" ? { kind: "hang" } : { kind: ending, usage: 30 };
			executor.baseOutcomes = ["preservation_failed"];
			executor.baseReceipt = (binding) => refusedReceipt(binding, FEEDBACK);
			executor.spentBy.set("accept-1", 20);
			const controller = start();
			await drive(controller, clock, true);
			await drive(controller, clock, true);

			assert.deepEqual(launched(executor), [
				"specify-1",
				"accept-1",
				"accept-2",
			]);
			assert.match(
				statuses(github, 14).at(-1) ?? "",
				ending === "budget" ? /:budget_exhausted$/ : /:failed$/,
			);
			assert.equal(refusals(github).length, 1);
			assert.match(
				refusals(github)[0] ?? "",
				new RegExp(
					`^Acceptance refused before build: preservation_failed\\. .* r=${original(executor, runOf(14))} -->$`,
					"s",
				),
			);
		});

	for (const [maxAttempts, recorded] of [
		[2, true],
		[3, true],
		// The interrupted feedback attempt left no spend record: unknown spend.
		[3, false],
	] as const)
		it(`recovers a restart while the feedback attempt runs, at max_attempts: ${maxAttempts}${recorded ? "" : " with its spend unknown"}`, async () => {
			const { github, executor, files, clock, logs, start } = world();
			github.add(labeled(14));
			setWorkflow(github, "max_attempts: 3", `max_attempts: ${maxAttempts}`);
			executor.behaviors = [{ kind: "pass", usage: 10 }];
			executor.acceptBehaviors = [
				{ kind: "pass", usage: 20 },
				{ kind: "hang" },
			];
			executor.acceptBehavior = { kind: "pass", usage: 20 };
			executor.baseOutcomes = ["preservation_failed", "ready"];
			executor.baseReceipt = (binding) => refusedReceipt(binding, FEEDBACK);
			executor.spentBy.set("accept-1", 20);
			const first = start();

			// No clock movement, so the hung feedback attempt never stalls.
			for (let tick = 0; tick < 6; tick++) {
				await first.tick();
				await settle();
			}

			assert.deepEqual(launched(executor), [
				"specify-1",
				"accept-1",
				"accept-2",
			]);
			assert.equal(statuses(github, 14).at(-1)?.endsWith(":running"), true);

			if (recorded) executor.spentBy.set("accept-2", 5);
			await drive(start(), clock);
			await drive(start(), clock);

			if (!recorded) {
				assert.deepEqual(launched(executor), [
					"specify-1",
					"accept-1",
					"accept-2",
				]);
				assert.deepEqual(
					logs
						.filter((l) => l.event === "launch_refused")
						.map((l) => l.fields.why),
					["stage_tokens"],
				);
				assert.equal(
					statuses(github, 14).at(-1)?.endsWith(":budget_exhausted"),
					true,
				);
				assert.equal(refusals(github).length, 1);
				assert.ok(refusals(github)[0]?.includes(original(executor, runOf(14))));

				return;
			}

			if (maxAttempts === 2) {
				assert.deepEqual(launched(executor), [
					"specify-1",
					"accept-1",
					"accept-2",
				]);
				assert.equal(statuses(github, 14).at(-1)?.endsWith(":failed"), true);
				assert.equal(refusals(github).length, 1);
				assert.ok(refusals(github)[0]?.includes(original(executor, runOf(14))));

				return;
			}

			assert.deepEqual(launched(executor), [
				"specify-1",
				"accept-1",
				"accept-2",
				"accept-3",
				"build-1",
			]);

			const relaunch = executor.launches.find(
				(l) => l.stage === "accept" && l.attempt === 3,
			);

			assert.match(relaunch?.prompt ?? "", /PRIVATE-FEEDBACK-MESSAGE/);
			assert.equal(relaunch?.settings.maxTokens, 25_000 - 20 - 5);
			assert.equal(refusals(github).length, 0);
			assert.equal(files.claims.get(runOf(14))?.stage, "build");
		});

	for (const failure of ["retire", "contract_once"] as const)
		it(`recovers a granted retry whose retirement ${failure === "retire" ? "fails, posting the first refusal" : "meets one transient contract read failure"}`, async () => {
			const { github, executor, files, clock, start } = world();
			github.add(labeled(14));
			executor.behaviors = [{ kind: "pass", usage: 10 }];
			executor.acceptBehavior = { kind: "pass", usage: 20 };
			executor.baseOutcomes = ["checking"];
			executor.baseReceipt = (binding) => refusedReceipt(binding, FEEDBACK);
			executor.spentBy.set("accept-1", 20);
			await drive(start(), clock, true);
			const claim = files.claims.get(runOf(14));
			const first = claim?.baseCheck;
			assert.ok(claim && first);
			files.claims.set(runOf(14), {
				...claim,
				baseCheck: {
					...first,
					retry: {
						refused: first.binding,
						reason: "preservation_failed",
						receiptDigest: digestOf(JSON.stringify([first.binding, 1])),
						scenarios: ["S1"],
						baseWallMs: 4_000,
					},
				},
			});

			if (failure === "retire") files.artifacts.retire = async () => "failed";
			else {
				const read = files.readContract.bind(files);
				let failures = 1;

				files.readContract = async (runId) =>
					failures-- > 0
						? { kind: "blocked", reason: "contract_invalid" }
						: read(runId);
			}

			executor.baseOutcomes = ["preservation_failed", "ready"];
			await drive(start(), clock);
			await drive(start(), clock);

			if (failure === "contract_once") {
				assert.deepEqual(launched(executor), [
					"specify-1",
					"accept-1",
					"accept-2",
					"build-1",
				]);
				assert.equal(refusals(github).length, 0);

				return;
			}

			assert.deepEqual(launched(executor), ["specify-1", "accept-1"]);
			assert.equal(statuses(github, 14).at(-1)?.endsWith(":failed"), true);
			assert.equal(refusals(github).length, 1);
			assert.ok(
				refusals(github)[0]?.includes(
					`r=${digestOf(JSON.stringify([first.binding, 1]))} -->`,
				),
			);
		});

	it("never relaunches a forged retry of a reason the author cannot fix", async () => {
		const { github, executor, files, clock, start } = world();
		github.add(labeled(14));
		executor.behaviors = [{ kind: "pass", usage: 10 }];
		executor.acceptBehavior = { kind: "pass", usage: 20 };
		executor.baseOutcomes = ["checking"];
		executor.baseReceipt = (binding) => refusedReceipt(binding, FEEDBACK);
		executor.spentBy.set("accept-1", 20);
		await drive(start(), clock, true);
		const claim = files.claims.get(runOf(14));
		const first = claim?.baseCheck;
		assert.ok(claim && first);
		files.claims.set(runOf(14), {
			...claim,
			baseCheck: {
				...first,
				retry: {
					refused: first.binding,
					reason: "base_timeout",
					receiptDigest: digestOf("forged"),
					scenarios: [],
					baseWallMs: 0,
				},
			},
		});
		executor.baseOutcomes = ["base_timeout", "ready"];
		await drive(start(), clock);
		await drive(start(), clock);
		assert.deepEqual(launched(executor), ["specify-1", "accept-1"]);
		assert.equal(statuses(github, 14).at(-1)?.endsWith(":failed"), true);
		assert.ok(
			existsSync(join(files.artifactRoot, "acceptance", runOf(14))),
			"the suite is not retired",
		);
		assert.equal(refusals(github).length, 1);
		assert.match(refusals(github)[0] ?? "", /: base_timeout\. /);
	});

	it("fails closed without a base-check port", async () => {
		const { github, executor, start } = world();
		github.add(labeled(14));
		executor.behaviors = [{ kind: "pass", usage: 10 }];
		executor.acceptBehavior = { kind: "pass", usage: 20 };
		Object.defineProperty(executor, "baseCheck", { value: undefined });
		await once(start());
		assert.ok(!executor.launches.some((l) => l.stage === "build"));
		assert.equal(statuses(github, 14).at(-1)?.endsWith(":failed"), true);
		assert.match(refusals(github)[0] ?? "", /base_evidence_missing/);
	});

	it("ends round 0 with one keyed refusal when the stored proof is gone at build launch", async () => {
		const { github, executor, clock, start } = world();
		github.add(labeled(14));
		executor.behaviors = [{ kind: "pass", usage: 10 }];
		executor.acceptBehavior = { kind: "pass", usage: 20 };
		const ready = executor.baseCheck.bind(executor);

		executor.baseCheck = async (input) => {
			if (input.readOnly !== true) return ready(input);
			executor.baseChecks.push(input);

			return {
				kind: "refused",
				failure: {
					binding: input.binding,
					receiptDigest: digestOf("missing"),
					reason: "base_evidence_missing",
					scenarios: [],
				},
			};
		};

		const controller = start();

		for (let tick = 0; tick < 4; tick++) {
			await once(controller);
			clock.t += 600_000;
		}

		assert.ok(!executor.launches.some((l) => l.stage === "build"));
		assert.equal(statuses(github, 14).at(-1)?.endsWith(":failed"), true);
		assert.equal(refusals(github).length, 1);
		assert.match(refusals(github)[0] ?? "", /: base_evidence_missing\. /);
	});

	it("keeps a pending check running across ticks and restarts without another model launch", async () => {
		const { github, executor, files, clock, start } = world();
		github.add(labeled(14));
		executor.behaviors = [{ kind: "pass", usage: 10 }];
		executor.acceptBehavior = { kind: "pass", usage: 20 };
		executor.baseOutcome = "checking";
		const first = start();

		for (let tick = 0; tick < 4; tick++) {
			await first.tick();
			await settle();
		}

		assert.equal(statuses(github, 14).at(-1), "5:running");
		assert.ok(executor.baseChecks.length >= 2);
		const claim = files.claims.get(runOf(14));
		assert.equal(claim?.stage, "accept");
		assert.equal(claim?.baseCheck?.acceptAttempt, 1);
		assert.equal(claim?.usage, 30);
		executor.baseOutcome = "ready";
		clock.t += 60_000;
		const restarted = start();
		await once(restarted);
		assert.deepEqual(
			executor.launches.map((l) => l.stage),
			["specify", "accept"],
		);
		assert.equal(files.claims.get(runOf(14))?.stage, "build");
		assert.equal(keyed(github, 14, "acceptance").length, 1);
		assert.equal(refusals(github).length, 0);
	});

	it("persists base interruption and its retry deadline across a restart", async () => {
		const f = world();
		f.files.accounting = fileRunFiles(f.files.artifactRoot).accounting;
		f.github.add(labeled(14));
		f.executor.behaviors = [{ kind: "pass", usage: 10 }];
		f.executor.acceptBehavior = { kind: "pass", usage: 20 };
		f.executor.baseOutcome = "interrupted";
		await once(f.start());

		const ended = await f.files.accounting!.readAttempt(
			runOf(14),
			"accept",
			0,
			1,
		);

		assert.equal(ended?.disposition, "interrupted");
		assert.equal(ended?.next.kind, "base_retry");
		f.clock.t += 5_000;
		f.executor.baseOutcome = "ready";
		const restarted = f.start();
		await restarted.tick();
		assert.equal(f.executor.baseChecks.length, 1);
		f.clock.t += 5_000;
		await once(restarted);
		assert.equal(f.files.claims.get(runOf(14))?.stage, "build");
		assert.equal((await f.files.accounting!.attempts(runOf(14)))?.length, 3);
	});

	it("charges an interrupted check once to the accept attempt and retries the stored suite", async () => {
		const { github, executor, files, clock, start } = world();
		github.add(labeled(14));
		executor.behaviors = [{ kind: "pass", usage: 10 }];
		executor.acceptBehavior = { kind: "pass", usage: 20 };
		executor.baseOutcome = "interrupted";
		const controller = start();
		const report = await once(controller);
		assert.equal(report.totals.retries, 1);
		assert.equal(files.claims.get(runOf(14))?.baseCheck?.acceptAttempt, 2);
		executor.baseOutcome = "ready";
		clock.t += 60_000;
		await once(controller);
		assert.deepEqual(
			executor.baseChecks.map((c) => c.acceptAttempt),
			[1, 2],
		);
		assert.deepEqual(
			executor.launches.map((l) => l.stage),
			["specify", "accept"],
		);
		assert.equal(files.claims.get(runOf(14))?.stage, "build");
	});

	it("refuses an interruption on every accept attempt with its own public reason", async () => {
		const { github, executor, clock, start } = world();
		github.add(labeled(14));
		executor.behaviors = [{ kind: "pass", usage: 10 }];
		executor.acceptBehavior = { kind: "pass", usage: 20 };
		executor.baseOutcome = "interrupted";
		const controller = start();

		for (let i = 0; i < 6; i++) {
			await once(controller);
			clock.t += 600_000;
		}

		assert.ok(!executor.launches.some((l) => l.stage === "build"));
		assert.equal(statuses(github, 14).at(-1)?.endsWith(":failed"), true);
		assert.equal(refusals(github).length, 1);
		assert.match(
			refusals(github)[0] ?? "",
			/^Acceptance refused before build: base_interrupted\. Base qualification was interrupted on every accept attempt\.\n\n<!-- factory-base-refusal /,
		);
		assert.doesNotMatch(refusals(github)[0] ?? "", /base_evidence_missing/);
	});

	it("refuses accept on a checkout that omitted base paths, while specify still reads it", async () => {
		const { github, executor, logs, start } = world();
		github.add(labeled(14));
		executor.behaviors = [{ kind: "pass", usage: 10 }];
		executor.acceptBehavior = { kind: "pass", usage: 20 };
		executor.checkoutOmitted = 1;
		await once(start());
		assert.deepEqual(
			executor.launches.map((l) => l.stage),
			["specify"],
		);
		assert.equal(statuses(github, 14).at(-1)?.endsWith(":failed"), true);
		assert.ok(
			logs.some(
				(e) =>
					e.event === "stage_inputs_refused" &&
					e.fields.why === "checkout_base_tree_unsupported",
			),
		);
		assert.equal(executor.baseChecks.length, 0);
	});

	it("treats an unrecorded omission count as unsupported at accept", async () => {
		const { github, executor, start } = world();
		github.add(labeled(14));
		executor.behaviors = [{ kind: "pass", usage: 10 }];
		executor.acceptBehavior = { kind: "pass", usage: 20 };
		executor.checkoutOmitted = null;
		await once(start());
		assert.deepEqual(
			executor.launches.map((l) => l.stage),
			["specify"],
		);
	});
});

describe("Orchestrator stage results", () => {
	it("advances a passing accept to build and keeps its usage", async () => {
		const { github, executor, files, start } = world();

		github.add(labeled(14));
		executor.behaviors = [{ kind: "pass", usage: 812 }];
		executor.acceptBehavior = { kind: "pass", usage: 0 };

		const controller = start();
		const first = await controller.tick();

		assert.equal(first.executionEnabled, true);

		const launch = executor.launches[0];

		assert.ok(launch);
		assert.equal(launch.stage, "specify");
		assert.equal(launch.attempt, 1);
		assert.equal(launch.remainingRunTokens, 500_000);
		assert.deepEqual(launch.settings, {
			model: "openai/gpt-6.1-sol",
			fallback: null,
			budget: { maxTurns: 20, wallMs: 900_000, stallMs: 300_000 },
			maxTokens: null,
		});

		const report = await once(controller);

		assert.equal(report.runs[0]?.stage, "build");
		assert.equal(report.runs[0]?.status, "claimed");
		assert.equal(report.active, 1);
		assert.equal(report.totals.usage, 812);
		assert.equal(report.totals.failures, 0);
		assert.deepEqual(statuses(github, 14), [
			"1:claimed",
			"2:running",
			"3:claimed",
			"4:running",
			"5:claimed",
		]);
		assert.deepEqual(
			[...files.claims.values()],
			[
				endedClaim(14, 5, {
					stage: "build",
					status: "claimed",
					usage: 812,
					baseCheck: executor.baseChecks[0] && {
						binding: executor.baseChecks[0].binding,
						acceptAttempt: 1,
						storedAttempt: 1,
						remainingAcceptMs: 900_000 - 1,
					},
					acceptWallMs: 1,
				}),
			],
		);
		assert.deepEqual(executor.baseChecks[0]?.binding, {
			runId: runOf(14),
			repo,
			issue: 14,
			contractDigest: executor.baseChecks[0]?.binding.contractDigest,
			acceptanceDigest: executor.baseChecks[0]?.binding.acceptanceDigest,
			baseSha: sha(MAIN_SHA),
			gateSha: sha(MAIN_SHA),
		});
	});

	it("passes the stage's fallback_model to the launch", async () => {
		const { github, executor, start } = world();

		github.add(labeled(14));
		setWorkflow(
			github,
			"  specify:\n    model: openai/gpt-6.1-sol\n",
			"  specify:\n    model: openai/gpt-6.1-sol\n    fallback_model: xai/grok-4.6\n",
		);
		executor.behaviors = [{ kind: "pass", usage: 1 }];

		await start().tick();

		assert.equal(executor.launches[0]?.settings.fallback, "xai/grok-4.6");
	});

	it("passes the run's remaining tokens and the next attempt to a retry", async () => {
		const { github, clock, executor, start } = world();

		github.add(labeled(14));
		executor.behaviors = [
			{ kind: "fail", usage: 120_000 },
			{ kind: "pass", usage: 1 },
		];

		const controller = start();

		await controller.tick();
		await controller.tick();
		clock.t += 10_000;
		await controller.tick();

		assert.equal(executor.launches[1]?.attempt, 2);
		assert.equal(executor.launches[1]?.remainingRunTokens, 380_000);
	});

	it("ends the run failed on a refusal, with no scheduler retry", async () => {
		const { github, executor, start } = world();

		github.add(labeled(14));
		executor.behaviors = [{ kind: "refuse", usage: 40 }];
		executor.fallback = { kind: "pass", usage: 0 };

		const controller = start();

		await controller.tick();

		const report = await controller.tick();

		assert.deepEqual(report.runs, []);
		assert.equal(report.totals.retries, 0);
		assert.equal(report.totals.failures, 1);
		assert.equal(report.totals.usage, 40);
		assert.equal(executor.launches.length, 1);
		assert.deepEqual(statuses(github, 14), [
			"1:claimed",
			"2:running",
			"3:failed",
		]);
	});

	it("ends the run budget_exhausted when the stage hits a cap", async () => {
		const { github, executor, start } = world();

		github.add(labeled(14));
		executor.behaviors = [{ kind: "budget", usage: 900 }];
		executor.fallback = { kind: "pass", usage: 0 };

		const controller = start();

		await controller.tick();

		const report = await controller.tick();

		assert.deepEqual(report.runs, []);
		assert.equal(report.totals.retries, 0);
		assert.equal(report.totals.usage, 900);
		assert.equal(statuses(github, 14).at(-1), "3:budget_exhausted");
	});

	it("keeps the usage a stalled stage reported before it stalled", async () => {
		const { github, clock, executor, start } = world();

		github.add(labeled(14));
		executor.behaviors = [{ kind: "hang" }];

		const controller = start();

		await controller.tick();
		executor.launches[0]?.progress(2_500);
		clock.t += 300_001;

		const report = await controller.tick();

		assert.equal(report.totals.stalls, 1);
		assert.equal(report.runs[0]?.status, "retrying");
		assert.equal(report.runs[0]?.usage, 2_500);
		assert.equal(report.totals.usage, 2_500);
	});

	it("blocks a run while the preflight fails and replays it once a later preflight passes", async () => {
		const { github, executor, start } = world();

		github.add(labeled(14));

		const controller = start();
		const blocked = await controller.tick();

		assert.equal(blocked.executionEnabled, false);
		assert.equal(blocked.runs[0]?.status, "blocked");
		assert.equal(executor.launches.length, 1);

		const still = await controller.tick();

		assert.equal(still.runs[0]?.status, "blocked");
		assert.equal(executor.launches.length, 1);
		assert.deepEqual(statuses(github, 14), ["1:claimed", "2:blocked"]);

		executor.fallback = { kind: "hang" };

		const running = await controller.tick();

		assert.equal(running.executionEnabled, true);
		assert.equal(running.runs[0]?.status, "running");
		assert.equal(executor.launches.length, 2);
		assert.deepEqual(statuses(github, 14), [
			"1:claimed",
			"2:blocked",
			"3:running",
		]);
	});

	it("stops leftover sandboxes once, before the first tick adopts any run", async () => {
		const { github, executor, start } = world();

		github.add(labeled(14));
		executor.fallback = { kind: "hang" };
		await start().tick();

		const controller = start();

		await controller.tick();
		await controller.tick();
		assert.equal(executor.recovered, 2);
	});

	it("waits for a launched stage and posts its end when a one-shot tick drains", async () => {
		const { github, executor, start } = world();
		let finish: (result: StageResult) => void = () => undefined;

		github.add(labeled(14));
		executor.behaviors = [
			{
				kind: "later",
				result: new Promise((done) => {
					finish = done;
				}),
			},
		];

		const controller = start();

		await controller.tick();

		const launch = executor.launches[0];

		assert.ok(launch);

		let waits = 0;
		executor.acceptBehavior = { kind: "pass", usage: 0 };

		const report = await controller.drain(async () => {
			waits++;
			finish(resultOf(launch, { kind: "passed" }, 77));
		});

		assert.ok(waits >= 1);
		assert.ok(report);
		assert.equal(report.runs[0]?.stage, "build");
		assert.equal(report.runs[0]?.status, "claimed");
		assert.equal(report.totals.usage, 77);
		assert.deepEqual(statuses(github, 14), [
			"1:claimed",
			"2:running",
			"3:claimed",
			"4:running",
			"5:claimed",
		]);
		assert.equal(await controller.drain(async () => undefined), null);
	});
});

describe("checkIdentity", () => {
	it("accepts only the integration bot", async () => {
		const { github } = world();
		const adapter = new GitHubTicketAdapter({ exec: github.exec, repo });

		assert.deepEqual(await checkIdentity(adapter), { kind: "ok" });

		github.viewer = "giuseppecrj";
		assert.deepEqual(await checkIdentity(adapter), { kind: "mismatch" });
	});
});

describe("parseStartTime", () => {
	it("reads field 22 after a command name with spaces and parentheses", () => {
		const stat =
			"4242 (node (x) y) S 1 4242 4242 0 -1 4194560 100 0 0 0 1 2 0 0 20 0 11 0 987654 1000 10";

		assert.equal(parseStartTime(stat), "987654");
		assert.equal(parseStartTime("garbage"), null);
	});
});

const dirs: string[] = [];

afterEach(() => {
	for (const dir of dirs.splice(0))
		rmSync(dir, { recursive: true, force: true });
});

function stateDir(): string {
	const dir = mkdtempSync(join(tmpdir(), "factory-controller-"));

	dirs.push(dir);

	return dir;
}

function table(pid: number, startTime = "1"): ProcessTable {
	return { self: { pid, startTime } };
}

const STALE_HOLDER = JSON.stringify({
	pid: 5000,
	startTime: "7",
	acquiredAt: "2026-10-29T01:00:00.000Z",
});

async function holdLock(state: string, pid = 5000) {
	const held = await acquireLock({
		stateDir: state,
		procs: table(pid, "7"),
		now: () => START,
	});

	assert.equal(held.kind, "acquired");

	return held;
}

async function cli(
	argv: readonly string[],
	github: FakeGitHub,
	signal = new AbortController(),
	executor = new FakeExecutor(),
) {
	let stdout = "";
	let stderr = "";

	const code = await runCli(argv, {
		exec: github.exec,
		env: () => "/home/exedev",
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
		},
	});

	return { code, stdout, stderr };
}

describe("server/cli.ts controller commands", () => {
	const base = ["--repo", repo];

	describe("--verification-token-cap", () => {
		const tick = (state: string, ...extra: string[]) => [
			"tick",
			"--once",
			"--json",
			...base,
			"--state-dir",
			state,
			...extra,
		];

		const manifestOf = (state: string) =>
			JSON.parse(readFileSync(join(state, "verification.json"), "utf8"));

		it("requires --issue scope and a positive integer cap", async () => {
			for (const extra of [
				["--verification-token-cap", "1000"],
				["--issue", "14", "--verification-token-cap", "0"],
				["--issue", "14", "--verification-token-cap", "1e3"],
				["--issue", "14", "--verification-token-cap", "-5"],
			]) {
				const run = await cli(tick(stateDir(), ...extra), new FakeGitHub());

				assert.equal(run.code, EXIT.usage, extra.join(" "));
				assert.match(run.stderr, /--verification-token-cap/);
			}

			const admit = await cli(
				[
					"admit",
					"--json",
					...base,
					"--issue",
					"14",
					"--state-dir",
					stateDir(),
					"--verification-token-cap",
					"1000",
				],
				new FakeGitHub(),
			);

			assert.equal(admit.code, EXIT.usage);
		});

		it("pins a write-once manifest in a fresh state dir and refuses changed scope, cap or production use", async () => {
			const state = stateDir();
			const github = new FakeGitHub();

			github.add(labeled(14));

			const first = await cli(
				tick(state, "--issue", "14", "--verification-token-cap", "12000"),
				github,
			);

			assert.equal(first.code, EXIT.ok, first.stderr);
			assert.deepEqual(manifestOf(state), {
				v: 1,
				repo,
				issues: [14],
				tokenCap: 12_000,
			});
			assert.equal(
				statSync(join(state, "verification.json")).mode & 0o777,
				0o600,
			);

			const again = await cli(
				tick(state, "--issue", "14", "--verification-token-cap", "12000"),
				github,
			);

			assert.equal(again.code, EXIT.ok, again.stderr);

			for (const extra of [
				["--issue", "14", "--verification-token-cap", "13000"],
				["--issue", "14", "--issue", "15", "--verification-token-cap", "12000"],
				["--issue", "14"],
				[],
			]) {
				const refused = await cli(tick(state, ...extra), github);

				assert.equal(refused.code, EXIT.invalid, extra.join(" "));
				assert.match(
					refused.stderr,
					/event=controller_refused reason=verification_(manifest_mismatch|state)/,
				);
			}

			assert.deepEqual(manifestOf(state).tokenCap, 12_000);
		});

		it("refuses a state dir that already holds production state", async () => {
			const state = stateDir();
			const github = new FakeGitHub();

			github.add(labeled(14));
			assert.equal(
				(await cli(tick(state, "--issue", "14"), github)).code,
				EXIT.ok,
			);

			const run = await cli(
				tick(state, "--issue", "14", "--verification-token-cap", "12000"),
				github,
			);

			assert.equal(run.code, EXIT.invalid);
			assert.match(
				run.stderr,
				/event=controller_refused reason=verification_state_not_new/,
			);
			assert.equal(existsSync(join(state, "verification.json")), false);
		});

		it("only lowers the trusted run cap and marks the terminal row as verification", async () => {
			for (const [cap, effective] of [
				[12_000, 12_000],
				[900_000, 500_000],
			] as const) {
				const state = stateDir();
				const github = new FakeGitHub();
				const executor = new FakeExecutor();

				github.add(labeled(14));
				executor.behaviors = [{ kind: "fail", usage: effective }];

				const argv = tick(
					state,
					"--issue",
					"14",
					"--verification-token-cap",
					String(cap),
				);

				const run = await cli(argv, github, new AbortController(), executor);

				assert.equal(run.code, EXIT.ok, run.stderr);
				assert.equal(executor.launches[0]?.remainingRunTokens, effective);
				await cli(argv, github, new AbortController(), executor);
				assert.equal(statuses(github, 14).at(-1), "3:budget_exhausted");

				const terminal = JSON.parse(
					readFileSync(
						join(state, "ledger", runOf(14), "terminal.json"),
						"utf8",
					),
				);

				assert.partialDeepStrictEqual(terminal.provenance, {
					kind: "verification",
					trustedRunTokenCap: 500_000,
					effectiveRunTokenCap: effective,
				});
				assert.equal(
					terminal.provenance.verificationDigest,
					digestOf(readFileSync(join(state, "verification.json"), "utf8")),
				);
			}
		});

		it("never reaches the production unit's ExecStart", () => {
			const unit = readFileSync(
				new URL("../server/factory.service", import.meta.url),
				"utf8",
			);

			const exec = unit
				.split("\n")
				.filter((line) => line.startsWith("ExecStart"));

			assert.equal(exec.length, 1);
			assert.match(exec[0] ?? "", /server\/cli\.ts serve /);
			assert.doesNotMatch(unit, /verification/);
		});
	});

	it("tick --once prints the claim snapshot, writes status and releases the lock", async () => {
		const github = new FakeGitHub();
		const state = stateDir();

		github.add(labeled(14));

		const run = await cli(
			["tick", "--once", "--json", ...base, "--state-dir", state],
			github,
		);

		assert.equal(run.code, EXIT.ok, run.stderr);
		assert.equal(JSON.parse(run.stdout).runs[0].status, "blocked");
		assert.equal(existsSync(join(state, HOLDER_FILE)), false);
		assert.equal(
			JSON.parse(readFileSync(join(state, "status.json"), "utf8")).runs.length,
			1,
		);
		assert.ok(existsSync(join(state, "workspaces", runOf(14))));
		assert.match(run.stderr, /event=claim_taken issue=14/);
	});

	it("tick --once waits for the stage it launched and prints its end", async () => {
		const github = new FakeGitHub();
		const state = stateDir();
		const executor = new FakeExecutor();

		github.add(labeled(14));
		executor.behaviors = [{ kind: "pass", usage: 9 }];
		executor.acceptBehavior = { kind: "pass", usage: 0 };

		const run = await cli(
			["tick", "--once", "--json", ...base, "--state-dir", state],
			github,
			new AbortController(),
			executor,
		);

		assert.equal(run.code, EXIT.ok, run.stderr);

		const report = JSON.parse(run.stdout);

		assert.equal(report.executionEnabled, true);
		assert.equal(report.runs[0]?.stage, "build");
		assert.equal(report.runs[0]?.status, "claimed");
		assert.equal(report.totals.usage, 9);
		assert.equal(executor.recovered, 1);
		assert.deepEqual(statuses(github, 14), [
			"1:claimed",
			"2:running",
			"3:claimed",
			"4:running",
			"5:claimed",
		]);
		assert.equal(
			JSON.parse(readFileSync(join(state, "status.json"), "utf8")).runs.length,
			1,
		);
	});

	it("run --issue uses the same admission and exits 1 when nothing runs", async () => {
		const github = new FakeGitHub();
		const state = stateDir();

		github.add(labeled(14));
		github.repoLabels = [];

		const off = await cli(
			["run", "--json", ...base, "--issue", "14", "--state-dir", state],
			github,
		);

		assert.equal(off.code, EXIT.invalid);
		assert.deepEqual(JSON.parse(off.stdout).dispatch.reasons, [
			"repo_switch_off",
		]);
		assert.deepEqual(statuses(github, 14), []);

		github.repoLabels = ["factory:enabled"];

		const on = await cli(
			["run", "--json", ...base, "--issue", "14", "--state-dir", state],
			github,
		);

		assert.equal(on.code, EXIT.ok, on.stderr);
		assert.deepEqual(statuses(github, 14), ["1:claimed", "2:blocked"]);
	});

	it("refuses a second controller before any gh call", async () => {
		const github = new FakeGitHub();
		const state = stateDir();
		const held = await holdLock(state);

		const run = await cli(
			["tick", "--once", "--json", ...base, "--state-dir", state],
			github,
		);

		assert.ok(existsSync(join(state, HOLDER_FILE)));

		rmSync(join(state, HOLDER_FILE));

		const unnamed = await cli(
			["run", "--json", ...base, "--issue", "14", "--state-dir", state],
			github,
		);

		if (held.kind === "acquired") await held.lock.release();

		assert.equal(run.code, EXIT.usage);
		assert.deepEqual(JSON.parse(run.stdout), {
			error: "controller_running",
			pid: 5000,
		});
		assert.match(run.stderr, /event=controller_running pid=5000/);
		assert.equal(unnamed.code, EXIT.usage);
		assert.deepEqual(JSON.parse(unnamed.stdout), {
			error: "controller_running",
			pid: null,
		});
		assert.equal(github.calls.length, 0);
	});

	it("reports and replaces a lock file left by a controller that is gone", async () => {
		const github = new FakeGitHub();
		const state = stateDir();

		writeFileSync(join(state, HOLDER_FILE), STALE_HOLDER);

		const run = await cli(
			["tick", "--once", "--json", ...base, "--state-dir", state],
			github,
		);

		assert.equal(run.code, EXIT.ok, run.stderr);
		assert.match(run.stderr, /event=lock_stale_replaced pid=5000/);
		assert.equal(existsSync(join(state, HOLDER_FILE)), false);
	});

	it("refuses to start as any identity but the integration bot", async () => {
		const github = new FakeGitHub();
		const state = stateDir();

		github.add(labeled(14));
		github.viewer = "giuseppecrj";

		const run = await cli(
			["tick", "--once", "--json", ...base, "--state-dir", state],
			github,
		);

		assert.equal(run.code, EXIT.invalid);
		assert.match(
			run.stderr,
			/event=controller_refused reason=identity_mismatch/,
		);
		assert.equal(existsSync(join(state, HOLDER_FILE)), false);
		assert.deepEqual(statuses(github, 14), []);
	});

	it("serve logs controller_ready, finishes the tick on stop and releases the lock", async () => {
		const github = new FakeGitHub();
		const state = stateDir();

		github.add(labeled(14));

		const run = await cli(
			["serve", ...base, "--state-dir", state, "--issue", "14"],
			github,
		);

		assert.equal(run.code, EXIT.ok, run.stderr);
		assert.match(
			run.stderr,
			/event=controller_ready pid=4242 repo=giuseppecrj\/pi-herdr-factorio scope=14/,
		);
		assert.match(run.stderr, /event=controller_stopping/);
		assert.equal(run.stdout, "");
		assert.equal(existsSync(join(state, HOLDER_FILE)), false);
		assert.ok(existsSync(join(state, "status.json")));
	});

	it("status --json reports the lock holder and the last tick without taking the lock", async () => {
		const github = new FakeGitHub();
		const state = stateDir();

		github.add(labeled(14));
		await cli(
			["tick", "--once", "--json", ...base, "--state-dir", state],
			github,
		);

		const status = async () => {
			const run = await cli(
				["status", "--json", ...base, "--state-dir", state],
				github,
			);

			assert.equal(run.code, EXIT.ok);

			return JSON.parse(run.stdout);
		};

		const held = await holdLock(state);
		const running = await status();

		const second = await acquireLock({
			stateDir: state,
			procs: table(6001),
			now: () => START,
		});

		if (held.kind === "acquired") await held.lock.release();

		const stopped = await status();

		writeFileSync(join(state, HOLDER_FILE), STALE_HOLDER);

		const stale = await status();

		assert.equal(running.controller.state, "running");
		assert.equal(running.controller.pid, 5000);
		assert.equal(running.controller.lastTick.runs[0].issue, 14);
		assert.equal(running.executionEnabled, false);
		assert.equal(second.kind, "held");
		assert.deepEqual(
			[stopped.controller.state, stopped.controller.pid],
			["stopped", null],
		);
		assert.deepEqual(
			[stale.controller.state, stale.controller.pid],
			["stale_lock", 5000],
		);
	});

	it("status reports a durable ended-run floor and ledger backlog without launching or writing", async () => {
		const github = new FakeGitHub();
		const state = stateDir();
		const executor = new FakeExecutor();
		github.add(labeled(14));
		executor.behaviors = [{ kind: "refuse", usage: 40 }];
		await cli(
			["tick", "--once", "--json", ...base, "--state-dir", state],
			github,
			new AbortController(),
			executor,
		);
		const before = readdirSync(state).sort();
		const launches = executor.launches.length;

		const result = await cli(
			["status", "--json", ...base, "--state-dir", state],
			github,
			new AbortController(),
			executor,
		);

		const status = JSON.parse(result.stdout);
		assert.equal(status.ledger.pending, 1);
		assert.equal(status.ledger.oldestAgeMs, 0);
		assert.equal(status.ledger.state, "pending");
		assert.equal(status.durableUsage.total, 40);
		assert.equal(status.durableUsage.kind, "lower_bound");
		assert.equal(status.accounting.runs.length, 1);
		assert.equal(status.accounting.runs[0].money.kind, "unavailable");
		assert.equal(status.accounting.countersScope, "process");
		assert.equal(executor.launches.length, launches);
		assert.deepEqual(readdirSync(state).sort(), before);
		writeFileSync(join(state, "ledger", runOf(14), "retry.json"), "{");

		const broken = await cli(
			["status", "--json", ...base, "--state-dir", state],
			github,
		);

		assert.deepEqual(
			["state", "pending", "blocked", "lastError"].map(
				(key) => JSON.parse(broken.stdout).ledger[key],
			),
			["blocked", 1, 1, "state_invalid"],
		);
	});

	it("status marks upper-bound charges uncertain and never calls missing state an empty backlog", async () => {
		const github = new FakeGitHub();
		const state = stateDir();
		github.add(labeled(14));
		const executor = new FakeExecutor();
		executor.behaviors = [{ kind: "refuse", usage: 40 }];
		await cli(
			["tick", "--once", "--json", ...base, "--state-dir", state],
			github,
			new AbortController(),
			executor,
		);
		const stage = join(state, "stages", runOf(14), "specify-1");
		mkdirSync(stage, { recursive: true });
		writeFileSync(
			join(stage, "egress.requests.jsonl"),
			'{"kind":"result","req":1,"inputTokens":10,"outputTokens":0}\n{"kind":"dispatch","req":2,"inputTokenEstimate":20,"maxOutputTokens":50}\n',
		);

		const result = await cli(
			["status", "--json", ...base, "--state-dir", state],
			github,
		);

		const status = JSON.parse(result.stdout);
		assert.equal(status.accounting.runs[0].tokens.kind, "uncertain");
		assert.equal(status.durableUsage.kind, "uncertain");
		assert.equal(status.durableUsage.total, 80);

		const missing = await cli(
			["status", "--json", ...base, "--state-dir", join(state, "missing")],
			github,
		);

		const unavailable = JSON.parse(missing.stdout);
		assert.equal(unavailable.accounting.state, "unavailable");
		assert.equal(unavailable.durableUsage.kind, "unavailable");
		assert.equal(unavailable.ledger.state, "unreadable");
		assert.equal(unavailable.ledger.pending, null);
	});

	it("rejects a state directory others can write", async () => {
		const github = new FakeGitHub();
		const state = stateDir();

		chmodSync(state, 0o777);

		const run = await cli(
			["tick", "--once", "--json", ...base, "--state-dir", state],
			github,
		);

		assert.equal(run.code, EXIT.invalid);
		assert.match(run.stderr, /reason=state_unavailable/);
		assert.equal(github.calls.length, 0);
	});

	for (const argv of [
		["serve", "--json", ...base, "--state-dir", "/tmp"],
		["tick", "--json", ...base, "--state-dir", "/tmp"],
		["run", "--json", ...base, "--state-dir", "/tmp"],
		[
			"run",
			"--json",
			...base,
			"--issue",
			"1",
			"--issue",
			"2",
			"--state-dir",
			"/tmp",
		],
		["tick", "--once", "--json", ...base],
		[
			"admit",
			"--once",
			"--json",
			...base,
			"--issue",
			"1",
			"--state-dir",
			"/tmp",
		],
		[
			"tick",
			"--once",
			"--json",
			...base,
			"--ref",
			"main",
			"--state-dir",
			"/tmp",
		],
	]) {
		it(`exits 2 on ${argv.join(" ")}`, async () => {
			const github = new FakeGitHub();
			const run = await cli(argv, github);

			assert.equal(run.code, EXIT.usage);
			assert.equal(github.calls.length, 0);
		});
	}
});

describe("Orchestrator runs of another state directory", () => {
	const base = ["--repo", repo];

	function writes(github: FakeGitHub, from: number): string[][] {
		return github.calls.slice(from).filter((call) => {
			const at = call.indexOf("--method");

			return at >= 0 && call[at + 1] !== "GET";
		});
	}

	for (const lane of ["running", "blocked"] as const)
		for (const held of [true, false])
			it(`leaves a ${lane} run alone from a ${held ? "held" : "live"} controller`, async () => {
				const f = world();
				f.github.add(labeled(14));

				if (lane === "running") f.executor.behaviors = [{ kind: "hang" }];
				const controller = f.start();
				await controller.tick();
				const before = statuses(f.github, 14);
				assert.deepEqual(before, ["1:claimed", `2:${lane}`]);

				const state = stateDir();

				if (held) writeFileSync(join(state, "disabled"), "");

				const executor = new FakeExecutor();
				const calls = f.github.calls.length;

				const other = await cli(
					["tick", "--once", "--json", ...base, "--state-dir", state],
					f.github,
					new AbortController(),
					executor,
				);

				assert.equal(other.code, EXIT.ok, other.stderr);
				assert.deepEqual(writes(f.github, calls), []);
				assert.deepEqual(statuses(f.github, 14), before);
				assert.deepEqual(JSON.parse(other.stdout).runs, []);
				assert.equal(executor.launches.length, 0);
				assert.equal(
					existsSync(join(state, "claims", `${runOf(14)}.json`)),
					false,
				);
				assert.doesNotMatch(
					other.stderr,
					/event=(claim_adopted|claim_taken|marker_posted|marker_corrupt|claim_dropped)/,
				);
				assert.equal(
					other.stderr.match(/event=claim_foreign issue=14 /g)?.length,
					1,
				);

				await controller.tick();
				assert.deepEqual(statuses(f.github, 14), before);
				assert.equal(events(f.logs).includes("marker_corrupt"), false);
				assert.equal(controller.state.runs.get(14)?.runId, runOf(14));
			});

	for (const held of [true, false])
		it(`adopts its own run after a restart that lost its claim file (${held ? "held" : "live"})`, async () => {
			const github = new FakeGitHub();
			const state = stateDir();
			github.add(labeled(14));

			const first = await cli(
				["tick", "--once", "--json", ...base, "--state-dir", state],
				github,
			);

			assert.equal(first.code, EXIT.ok, first.stderr);
			assert.deepEqual(statuses(github, 14), ["1:claimed", "2:blocked"]);
			const claim = join(state, "claims", `${runOf(14)}.json`);
			rmSync(claim);

			if (held) writeFileSync(join(state, "disabled"), "");

			const restarted = await cli(
				["tick", "--once", "--json", ...base, "--state-dir", state],
				github,
			);

			assert.equal(restarted.code, EXIT.ok, restarted.stderr);
			assert.match(restarted.stderr, /event=claim_adopted issue=14 /);
			assert.doesNotMatch(restarted.stderr, /event=claim_foreign/);
			assert.equal(JSON.parse(restarted.stdout).runs[0]?.runId, runOf(14));
			assert.equal(JSON.parse(readFileSync(claim, "utf8")).seq, 2);
			assert.deepEqual(statuses(github, 14), ["1:claimed", "2:blocked"]);
		});

	it("turns its own interrupted running stage into a retry after losing the claim file", async () => {
		const { github, executor, files, logs, start } = world();

		github.add(labeled(14));
		executor.behaviors = [{ kind: "hang" }];
		await start().tick();
		assert.deepEqual(statuses(github, 14), ["1:claimed", "2:running"]);
		files.claims.clear();

		const report = await start().tick();

		assert.equal(report.runs[0]?.attempt, 2);
		assert.equal(report.runs[0]?.status, "retrying");
		assert.deepEqual(statuses(github, 14), [
			"1:claimed",
			"2:running",
			"3:retrying",
		]);
		assert.equal(events(logs).includes("claim_foreign"), false);
	});

	async function foreignMarker(
		github: FakeGitHub,
		change: {
			eventId: string;
			eventAt: string;
			seq: number;
			status: RunStatus;
		},
	): Promise<Digest> {
		const f = world();
		f.github.add(labeled(14));
		await f.start().tick();
		const parsed = parseMarker(f.github.markers(14)[0] ?? "");

		if (parsed.kind !== "marker") throw new Error("marker");
		const runId = runIdOf({ repo, issue: 14, eventId: change.eventId });
		const issue = github.issues.get(14);
		assert.ok(issue);
		github.comment(issue, formatMarker({ ...parsed.marker, ...change, runId }));

		return runId;
	}

	it("frees its own claim's slot under another controller's live run, posting nothing there", async () => {
		const github = new FakeGitHub();
		const state = stateDir();
		const issue = github.add(labeled(14));
		const once = ["tick", "--once", "--json", ...base, "--state-dir", state];

		const first = await cli(once, github);

		assert.equal(first.code, EXIT.ok, first.stderr);
		assert.deepEqual(statuses(github, 14), ["1:claimed", "2:blocked"]);
		const replaced = relabel(github, issue);

		const foreign = await foreignMarker(github, {
			eventId: "34537529999",
			eventAt: "2026-10-29T02:31:00Z",
			seq: 3,
			status: "blocked",
		});

		assert.equal(foreign, replaced);
		github.add(labeled(15));
		github.add(labeled(16));
		const before = statuses(github, 14);

		const restarted = await cli(once, github);

		assert.equal(restarted.code, EXIT.ok, restarted.stderr);
		assert.deepEqual(statuses(github, 14), before);
		assert.match(restarted.stderr, /event=claim_foreign issue=14 /);
		assert.doesNotMatch(
			restarted.stderr,
			/event=(claim_adopted|claim_released|claim_taken|marker_posted) issue=14 /,
		);
		assert.deepEqual(
			runIssues(JSON.parse(restarted.stdout)).sort((a, b) => a - b),
			[15, 16],
		);
		assert.deepEqual(statuses(github, 15), ["1:claimed", "2:blocked"]);
		assert.deepEqual(statuses(github, 16), ["1:claimed", "2:blocked"]);
		assert.equal(
			JSON.parse(
				readFileSync(join(state, "claims", `${runOf(14)}.json`), "utf8"),
			).status,
			"blocked",
		);
	});

	for (const claimFile of ["kept", "lost"] as const)
		it(`waits with its own recovered admission until another controller's live run ends (claim file ${claimFile})`, async () => {
			const f = world();
			const issue = f.github.add(labeled(14));
			let finish: (result: StageResult) => void = () => undefined;
			f.executor.behaviors = [
				{
					kind: "later",
					result: new Promise((done) => {
						finish = done;
					}),
				},
			];
			const owner = f.start();
			await owner.tick();
			assert.deepEqual(statuses(f.github, 14), ["1:claimed", "2:running"]);

			const newer = relabel(f.github, issue);
			const store = memoryStore();
			const files = memoryFiles();

			const admitted = await admitTicket({
				exec: f.github.exec,
				env: () => "/home/exedev",
				repo,
				issue: 14,
				allowlist: [repo],
				store,
			});

			assert.equal(admitted.decision, "admitted");

			if (claimFile === "kept")
				files.claims.set(newer, {
					runId: newer,
					issue: 14,
					eventId: "34537529999",
					seq: null,
					status: null,
					stage: null,
					attempt: null,
					usage: null,
				});

			f.github.add(labeled(15));
			f.github.add(labeled(16));
			const clock = new FakeClock();
			clock.t = START + 3_600_000;
			const executor = new FakeExecutor();
			executor.workflow = () => f.github.workflow;
			const logs: { event: string; fields: LogFields }[] = [];

			const other = new Orchestrator({
				exec: f.github.exec,
				env: () => "/home/exedev",
				repo,
				store,
				files,
				executor,
				clock,
				scope: null,
				log: (event, fields) => logs.push({ event, fields }),
			});

			await other.tick();
			assert.deepEqual(statuses(f.github, 14), ["1:claimed", "2:running"]);
			assert.equal(other.state.runs.has(14), false);
			assert.deepEqual(
				[...other.state.runs.keys()].sort((a, b) => a - b),
				[15, 16],
			);

			const launch = f.executor.launches[0];
			assert.ok(launch);
			finish(resultOf(launch, { kind: "failed", exit: "error" }, 0));
			f.store.local = "disabled";
			await owner.tick();
			assert.equal(statuses(f.github, 14)[2], "3:retrying");

			for (let tick = 0; tick < 3; tick++) {
				f.clock.t += 60_000;
				clock.t += 60_000;
				await other.tick();
				await owner.tick();
			}

			assert.equal(events(f.logs).includes("marker_corrupt"), false);
			assert.equal(events(logs).includes("marker_corrupt"), false);
			const ended = statuses(f.github, 14);
			assert.match(ended.at(-1) ?? "", /^\d+:released$/);
			assert.equal(other.state.runs.has(14), false);

			for (const number of [15, 16]) {
				const done = f.github.issues.get(number);
				assert.ok(done);
				done.state = "closed";
				done.updatedAt = "2026-10-29T02:40:00Z";
			}

			clock.t += 60_000;
			await other.tick();
			assert.deepEqual([...other.state.runs.keys()], [14]);
			assert.equal(other.state.runs.get(14)?.runId, newer);
			assert.equal(
				statuses(f.github, 14)[ended.length],
				`${ended.length + 1}:claimed`,
			);
			assert.equal(events(f.logs).includes("marker_corrupt"), false);
			assert.equal(events(logs).includes("marker_corrupt"), false);
		});

	it("frees the slot of a claim ahead of the ledger that has no admission here", async () => {
		const { github, files, logs, start } = world();
		github.add(labeled(14));
		github.add(labeled(15));
		github.add(labeled(16));
		files.claims.set(runOf(14), blockedClaim(14, 3));

		const report = await start().tick();

		assert.deepEqual(
			runIssues(report).sort((a, b) => a - b),
			[15, 16],
		);
		assert.deepEqual(statuses(github, 14), []);
		assert.equal(events(logs).includes("claim_adopted"), false);
	});

	for (const lane of ["ready", "closed"] as const)
		it(`frees the slot of an unmarked ${lane} claim that has no admission here`, async () => {
			const { github, files, logs, start } = world();
			const issue = github.add(labeled(14));

			if (lane === "closed") issue.state = "closed";
			github.add(labeled(15));
			github.add(labeled(16));
			files.claims.set(runOf(14), {
				runId: runOf(14),
				issue: 14,
				eventId: String(EVENT_ID + 14),
				seq: null,
				status: null,
				stage: null,
				attempt: null,
				usage: null,
			});

			const report = await start().tick();

			assert.deepEqual(
				runIssues(report).sort((a, b) => a - b),
				[15, 16],
			);
			assert.deepEqual(statuses(github, 14), []);
			assert.equal(events(logs).includes("claim_released"), false);
		});

	it("admits a newer ready event only once the owner ends its run", async () => {
		const f = world();
		const issue = f.github.add(labeled(14));
		const owner = f.start();
		await owner.tick();
		assert.deepEqual(statuses(f.github, 14), ["1:claimed", "2:blocked"]);

		const clock = new FakeClock();
		clock.t = START + 3_600_000;
		const executor = new FakeExecutor();
		executor.workflow = () => f.github.workflow;
		const logs: { event: string; fields: LogFields }[] = [];

		const other = new Orchestrator({
			exec: f.github.exec,
			env: () => "/home/exedev",
			repo,
			store: memoryStore(),
			files: memoryFiles(),
			executor,
			clock,
			scope: null,
			log: (event, fields) => logs.push({ event, fields }),
		});

		await other.tick();
		const calls = f.github.calls.length;
		const newer = relabel(f.github, issue);
		await other.tick();
		clock.t += 60_000;
		await other.tick();
		assert.deepEqual(writes(f.github, calls), []);
		assert.equal(other.state.runs.size, 0);
		assert.equal(events(logs).filter((e) => e === "claim_foreign").length, 1);

		f.store.local = "disabled";
		await owner.tick();
		assert.deepEqual(statuses(f.github, 14), [
			"1:claimed",
			"2:blocked",
			"3:released",
		]);

		clock.t += 60_000;
		await other.tick();
		assert.equal(other.state.runs.get(14)?.runId, newer);
		assert.deepEqual(statuses(f.github, 14).slice(0, 4), [
			"1:claimed",
			"2:blocked",
			"3:released",
			"4:claimed",
		]);
	});
});

describe("admission accounting policy", () => {
	it("pins policy bytes from the original SHA once, caches its gates and retains start time across restart", async () => {
		const dir = stateDir();
		const archive = stateDir();
		const tree = join(archive, "repo", ".github", "factory");
		mkdirSync(join(tree, "gates"), { recursive: true });
		writeFileSync(join(tree, "WORKFLOW.md"), TRUSTED_WORKFLOW);
		writeFileSync(join(tree, "gates", "ci.sh"), "echo trusted\n");
		const bytes = execFileSync("tar", ["-czf", "-", "-C", archive, "repo"]);
		let fetched = 0;

		const files = fileRunFiles(dir, {
			fetch: async (requestedRepo, requestedSha) => {
				assert.equal(requestedRepo, repo);
				assert.equal(requestedSha, MAIN_SHA);
				fetched++;

				return bytes;
			},
		});

		const input = {
			runId: runOf(14),
			repo,
			workflowSha: sha(MAIN_SHA),
			workflowDigest: digestOf(TRUSTED_WORKFLOW),
			startedAt: new Date(START).toISOString(),
		};

		assert.equal(await files.prepareRun?.(input), true);
		const pinned = await files.accounting?.start(input.runId);
		assert.ok(pinned);
		assert.equal(pinned.policy.gates.kind, "known");
		assert.equal(
			statSync(join(dir, "accounting", input.runId, "policy.json")).mode &
				0o777,
			0o600,
		);
		assert.equal(
			await files.prepareRun?.({ ...input, runId: runOf(15) }),
			true,
		);
		assert.equal(fetched, 1);
		assert.equal(
			await files.accounting?.begin({
				...pinned,
				runId: runOf(16),
				policy: {
					...pinned.policy,
					gates: {
						kind: "known",
						value: {
							sourceSha: sha("f".repeat(40)),
							digest: digestOf("gates"),
						},
					},
				},
			}),
			false,
		);
		assert.equal(
			await files.accounting?.begin({
				...pinned,
				runId: runOf(16),
				policy: {
					...pinned.policy,
					autonomy: {
						...pinned.policy.autonomy,
						digest: digestOf("not autonomy"),
					},
				},
			}),
			false,
		);

		const restarted = fileRunFiles(dir, {
			fetch: async () => {
				throw new Error("must not fetch");
			},
		});

		assert.equal(
			await restarted.prepareRun?.({
				...input,
				startedAt: new Date(START + 1000).toISOString(),
			}),
			true,
		);
		assert.deepEqual(await restarted.accounting?.start(input.runId), pinned);
		assert.equal(
			await restarted.prepareRun?.({
				...input,
				workflowDigest: digestOf("different"),
			}),
			false,
		);
		assert.equal(
			await restarted.accounting?.begin({
				...pinned,
				startedAt: new Date(START + 1000).toISOString(),
			}),
			false,
		);
		assert.equal(
			await files.prepareRun?.({
				...input,
				runId: runOf(16),
				workflowDigest: digestOf("different"),
			}),
			false,
		);
		symlinkSync("ci.sh", join(tree, "gates", "omitted-link"));
		const partial = execFileSync("tar", ["-czf", "-", "-C", archive, "repo"]);
		const refused = fileRunFiles(stateDir(), { fetch: async () => partial });
		assert.equal(await refused.prepareRun?.(input), false);
		assert.equal(await refused.accounting?.start(input.runId), null);
	});

	it("defers the first claim until its original workflow and gate policy are durably pinned", async () => {
		const f = world();
		f.github.add(labeled(14));
		let ready = false;
		const calls: string[] = [];
		f.files.prepareRun = async (input) => {
			assert.equal(input.workflowSha, MAIN_SHA);
			assert.equal(input.runId, runOf(14));
			assert.equal(f.files.claims.size, 0);
			calls.push(input.startedAt);

			return ready;
		};

		const controller = f.start();
		await controller.tick();
		assert.equal(f.files.claims.size, 0);
		assert.equal(f.executor.launches.length, 0);
		assert.deepEqual(statuses(f.github, 14), []);
		ready = true;
		await controller.tick();
		assert.equal(f.files.claims.size, 1);
		assert.equal(calls.length, 2);
	});
});

describe("durable attempt ends", () => {
	it("writes each disposition once, rejects conflicting bytes and distinguishes corrupt from absent", async () => {
		const state = stateDir();
		const accounting = fileRunFiles(state).accounting!;

		const dispositions = [
			"completed",
			"model_failure",
			"interrupted",
			"refused",
			"budget_stop",
			"aborted",
		] as const;

		for (const [index, disposition] of dispositions.entries()) {
			const attempt = index + 1;

			const record = {
				v: 1 as const,
				runId: runOf(14),
				stage: "specify" as const,
				round: 0,
				attempt,
				disposition,
				usage: 37,
				next: { kind: "end" as const, status: "failed" as const },
			};

			assert.equal(await accounting.writeAttempt(record), true);
			assert.equal(await accounting.writeAttempt(record), true);
			assert.equal(
				await accounting.writeAttempt({ ...record, usage: 99 }),
				false,
			);
			assert.deepEqual(
				await accounting.readAttempt(runOf(14), "specify", 0, attempt),
				record,
			);
		}

		assert.equal((await accounting.attempts(runOf(14)))?.length, 6);
		assert.equal(
			await accounting.readAttempt(runOf(14), "specify", 0, 7),
			null,
		);

		const path = join(
			state,
			"accounting",
			runOf(14),
			"attempts",
			"specify-r0-1.json",
		);

		assert.equal(statSync(path).mode & 0o777, 0o600);
		writeFileSync(path, "{");
		assert.equal(
			await accounting.readAttempt(runOf(14), "specify", 0, 1),
			undefined,
		);
		assert.equal(await accounting.attempts(runOf(14)), null);
	});
});

describe("fileRunFiles", () => {
	it("creates private workspaces and round-trips claim records", async () => {
		const state = stateDir();
		const files = fileRunFiles(state);
		const runId = runOf(14);

		const unconfirmed: ClaimRecord = {
			runId,
			issue: 14,
			eventId: "5",
			seq: null,
			status: null,
			stage: null,
			attempt: null,
			usage: null,
		};

		assert.equal(await files.workspaceState(runId), "missing");
		assert.equal(await files.ensureWorkspace(runId), "created");
		assert.equal(await files.ensureWorkspace(runId), "present");
		assert.ok(await files.writeClaim(unconfirmed));
		assert.deepEqual(await files.listClaims(), [unconfirmed]);

		writeFileSync(join(state, "claims", "junk.json"), "{}");
		assert.equal((await files.listClaims()).length, 1);
	});

	it("loads a record without a status as unknown, and rejects a partial or invalid one", async () => {
		const state = stateDir();
		const files = fileRunFiles(state);
		const runId = runOf(14);
		const path = join(state, "claims", `${runId}.json`);
		const confirmed = { ...blockedClaim(14, 3), eventId: "5" };

		assert.ok(await files.writeClaim(confirmed));
		assert.deepEqual(await files.listClaims(), [confirmed]);

		const load = async (record: Record<string, string | number | null>) => {
			writeFileSync(path, `${JSON.stringify(record)}\n`);

			return files.listClaims();
		};

		const base = { runId, issue: 14, eventId: "5" };
		const unknown = { status: null, stage: null, attempt: null, usage: null };
		const mirrored = { status: "blocked", stage: "specify", attempt: 1 };

		assert.deepEqual(await load({ ...base, seq: 3 }), [
			{ ...base, seq: 3, ...unknown },
		]);
		assert.deepEqual(await load({ ...base, seq: 3, ...mirrored }), [
			{ ...base, seq: 3, ...mirrored, usage: null },
		]);
		assert.deepEqual(
			await load({ ...base, seq: 3, ...mirrored, usage: 300_000 }),
			[{ ...base, seq: 3, ...mirrored, usage: 300_000 }],
		);
		assert.deepEqual(
			await load({
				...base,
				seq: 3,
				...mirrored,
				status: "released",
				usage: 0,
			}),
			[{ ...base, seq: 3, ...mirrored, status: "released", usage: 0 }],
		);
		assert.deepEqual(
			await load({ ...base, seq: 3, ...mirrored, usage: -1 }),
			[],
		);
		assert.deepEqual(
			await load({ ...base, seq: 3, ...mirrored, usage: 1.5 }),
			[],
		);
		assert.deepEqual(await load({ ...base, seq: 3, usage: 5 }), []);
		assert.deepEqual(await load({ ...base, seq: null, usage: 0 }), []);
		assert.deepEqual(await load(base), [{ ...base, seq: null, ...unknown }]);
		assert.deepEqual(await load({ ...base, seq: 0 }), []);
		assert.deepEqual(await load({ ...base, seq: 3, status: "blocked" }), []);
		assert.deepEqual(
			await load({
				...base,
				seq: 3,
				status: "paused",
				stage: "specify",
				attempt: 1,
			}),
			[],
		);
		assert.deepEqual(
			await load({
				...base,
				seq: null,
				status: "blocked",
				stage: "specify",
				attempt: 1,
			}),
			[],
		);
	});
});

describe("Orchestrator restart reads", () => {
	it("retries a recorded claim whose issue read failed on the first tick", async () => {
		const { github, start } = world();
		const issue = github.add(labeled(14));

		await start().tick();
		issue.state = "closed";
		github.failures.set(`repos/${FAKE_REPO}/issues/14`, networkError());

		const controller = start();
		const first = await controller.tick();

		assert.deepEqual(first.runs, []);
		assert.deepEqual(statuses(github, 14), ["1:claimed", "2:blocked"]);

		github.failures.clear();
		await controller.tick();

		assert.equal(statuses(github, 14).at(-1), "3:released");
	});
});

function relabel(github: FakeGitHub, issue: FakeIssue): Digest {
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

describe("Orchestrator new ready events", () => {
	it("claims the new event in the restart tick that releases the old run", async () => {
		const { github, start } = world();
		const issue = github.add(labeled(14));

		await start().tick();

		const next = relabel(github, issue);
		const report = await start().tick();

		assert.deepEqual(statuses(github, 14), [
			"1:claimed",
			"2:blocked",
			"3:released",
			"4:claimed",
			"5:blocked",
		]);
		assert.deepEqual(
			report.runs.map((run) => [run.runId, run.status, run.seq]),
			[[next, "blocked", 5]],
		);
	});

	it("claims the new event on the next tick when the release marker is unconfirmed", async () => {
		const { github, start } = world();
		const issue = github.add(labeled(14));

		await start().tick();

		const next = relabel(github, issue);

		github.posts = ["landed_unanswered"];

		const controller = start();
		const first = await controller.tick();

		assert.equal(first.runs[0]?.markerPending, true);

		const second = await controller.tick();

		assert.deepEqual(statuses(github, 14), [
			"1:claimed",
			"2:blocked",
			"3:released",
			"4:claimed",
			"5:blocked",
		]);
		assert.equal(second.runs[0]?.runId, next);
	});
});

describe("Orchestrator slot accounting", () => {
	for (const behavior of ["landed_unanswered", "rejected", "lost"] as const) {
		it(`counts a claim whose first marker POST is ${behavior} against the limit`, async () => {
			const { github, start } = world();

			for (const number of [14, 15, 16]) github.add(labeled(number));

			github.posts = [behavior];

			const controller = start();
			const first = await controller.tick();

			assert.deepEqual(runIssues(first), [14, 15]);
			assert.deepEqual(first.queued, [16]);

			const second = await controller.tick();

			assert.deepEqual(runIssues(second), [14, 15]);
			assert.deepEqual(second.queued, [16]);
			assert.deepEqual(statuses(github, 16), []);
		});
	}
});

describe("Orchestrator eligibility before launch", () => {
	async function queuedRetry() {
		const ctx = world();
		const issue = ctx.github.add(labeled(14));

		ctx.executor.behaviors = [{ kind: "fail", usage: 0 }];

		const controller = ctx.start();

		await controller.tick();

		const queued = await controller.tick();

		assert.equal(queued.runs[0]?.status, "retrying");

		return { ...ctx, issue, controller };
	}

	it("defers a due retry whose issue read failed and releases it once the read works", async () => {
		const { github, clock, executor, issue, controller } = await queuedRetry();

		issue.state = "closed";
		github.failures.set(`repos/${FAKE_REPO}/issues/14`, networkError());
		clock.t += 10_000;

		const deferred = await controller.tick();

		assert.equal(executor.launches.length, 1);
		assert.equal(deferred.runs[0]?.status, "retrying");

		github.failures.clear();

		const released = await controller.tick();

		assert.deepEqual(released.runs, []);
		assert.equal(executor.launches.length, 1);
		assert.equal(statuses(github, 14).at(-1)?.endsWith(":released"), true);
	});

	it("defers a due retry whose changed issue has an unreadable timeline", async () => {
		const { github, clock, executor, issue, controller } = await queuedRetry();

		issue.updatedAt = "2026-10-29T03:00:00Z";
		github.failures.set(
			`repos/${FAKE_REPO}/issues/14/timeline`,
			networkError(),
		);
		clock.t += 10_000;

		const deferred = await controller.tick();

		assert.equal(executor.launches.length, 1);
		assert.equal(deferred.runs[0]?.status, "retrying");

		github.failures.clear();
		await controller.tick();

		assert.equal(executor.launches.length, 2);
	});

	it("does not replay an adopted run until its eligibility is read", async () => {
		const { github, executor, start } = world();

		github.add(labeled(14));
		await start().tick();
		github.failures.set(
			`repos/${FAKE_REPO}/issues/14/timeline`,
			networkError(),
		);

		const controller = start();
		const deferred = await controller.tick();

		assert.equal(executor.launches.length, 1);
		assert.equal(deferred.runs[0]?.status, "blocked");

		github.failures.clear();
		await controller.tick();

		assert.equal(executor.launches.length, 2);
		assert.deepEqual(statuses(github, 14), ["1:claimed", "2:blocked"]);
	});
});

describe("Orchestrator bot comment edits", () => {
	it("fails closed after a restart when an owner strips the marker prefix from bot comments", async () => {
		const { github, start } = world();
		const issue = github.add(labeled(14));

		await start().tick();

		for (const comment of issue.comments) {
			comment.body = comment.body.replace("<!-- factory:", "<!-- note:");
			comment.lastEditedAt = "2026-10-29T03:00:00Z";
		}

		const report = await start().tick();

		assert.deepEqual(report.runs, []);
		assert.deepEqual(report.corrupt, [{ issue: 14, defect: "edited" }]);
		assert.equal(issue.comments.length, 2);
	});
});

describe("Orchestrator live marker validation", () => {
	it("drops a held issue from dispatch when a live controller sees its marker edited", async () => {
		const { github, clock, executor, start } = world();
		const issue = github.add(labeled(14));

		executor.behaviors = [{ kind: "fail", usage: 0 }];

		const controller = start();

		await controller.tick();
		await controller.tick();

		const first = issue.comments[0];

		assert.ok(first);
		first.lastEditedAt = "2026-10-29T03:00:00Z";
		issue.updatedAt = "2026-10-29T03:00:00Z";
		clock.t += 10_000;

		const report = await controller.tick();

		assert.equal(executor.launches.length, 1);
		assert.deepEqual(report.runs, []);
		assert.deepEqual(report.corrupt, [{ issue: 14, defect: "edited" }]);
		assert.equal(github.markers(14).length, 3);

		const again = await controller.tick();

		assert.deepEqual(again.runs, []);
		assert.equal(github.markers(14).length, 3);
	});
});

describe("Orchestrator local admission recovery", () => {
	for (const lost of ["the first marker", "the marker and the claim record"]) {
		it(`adopts the recorded admission after losing ${lost} and a later rename`, async () => {
			const { github, files, store, start } = world();
			const issue = github.add(labeled(14));

			github.posts = ["lost"];
			await start().tick();

			assert.equal(store.records.size, 1);

			if (lost.includes("claim")) files.claims.clear();

			issue.title = "A new title";
			issue.timeline.push(renamedEvent("2026-10-29T01:30:00Z"));
			issue.updatedAt = "2026-10-29T01:30:00Z";

			const report = await start().tick();

			assert.deepEqual(report.refused, []);
			assert.equal(report.runs[0]?.runId, runOf(14));
			assert.deepEqual(statuses(github, 14), ["1:claimed", "2:blocked"]);
		});
	}
});

describe("Orchestrator reconcile order", () => {
	it("terminates a stall and releases a closed claim before the per-tick reads", async () => {
		const { github, clock, executor, start } = world();

		github.add(labeled(14));

		const closing = github.add(labeled(15));

		executor.behaviors = [{ kind: "hang" }];

		const controller = start();

		await controller.tick();

		const launch = executor.launches[0];

		assert.ok(launch);
		closing.state = "closed";
		clock.t += 300_001;

		const atGate: { aborted: boolean; released: string | undefined }[] = [];

		github.beforeCall = (args) => {
			if (args.some((arg) => arg.includes("labels/factory%3Aenabled"))) {
				atGate.push({
					aborted: launch.signal.aborted,
					released: statuses(github, 15).at(-1),
				});
			}
		};

		await controller.tick();

		assert.deepEqual(atGate, [{ aborted: true, released: "3:released" }]);
	});
});

function lagComments(
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

function hideMarker(
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

function failClaimWrite(files: ReturnType<typeof memoryFiles>, seq: number) {
	const write = files.writeClaim;
	const control = { failing: true };

	files.writeClaim = async (claim) =>
		control.failing && claim.seq === seq ? false : write(claim);

	return control;
}

function bySeq(github: FakeGitHub, issue: number): string[] {
	return statuses(github, issue).sort(
		(left, right) => Number.parseInt(left, 10) - Number.parseInt(right, 10),
	);
}

function behindLogs(logs: { event: string; fields: LogFields }[]) {
	return logs.flatMap((entry) =>
		entry.event === "ledger_behind" ? [entry.fields] : [],
	);
}

function blockedClaim(issue: number, seq: number): ClaimRecord {
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

describe("Orchestrator ledger behind the local claim record", () => {
	it("claims the new event in the tick whose comments read lags its own release", async () => {
		const ctx = world();
		const { github, executor, logs, start } = ctx;
		const issue = github.add(labeled(14));
		const controller = start();

		await controller.tick();

		const next = relabel(github, issue);

		lagComments(ctx, issue, 1);

		const report = await controller.tick();

		assert.deepEqual(statuses(github, 14), [
			"1:claimed",
			"2:blocked",
			"3:released",
			"4:claimed",
			"5:blocked",
		]);
		assert.deepEqual(
			report.runs.map((run) => [run.runId, run.status, run.seq]),
			[[next, "blocked", 5]],
		);
		assert.deepEqual(report.corrupt, []);
		assert.deepEqual(behindLogs(logs), [
			{ issue: 14, ledgerSeq: 2, localSeq: 3 },
		]);
		assert.equal(executor.launches.length, 2);
	});

	it("keeps a fresh process's run and its slot when the first comments read is empty", async () => {
		const { github, clock, files, logs, start } = world();
		const issue = github.add(labeled(14));

		github.add(labeled(15));
		github.add(labeled(16));

		const first = start();

		await first.tick();
		clock.t += 30_000;
		await first.tick();

		const kept = issue.comments.splice(0);
		const controller = start();

		clock.t += 5000;

		const behind = await controller.tick();

		assert.deepEqual(
			behind.runs.map((run) => [run.issue, run.status, run.seq]),
			[
				[14, "blocked", 2],
				[15, "blocked", 2],
			],
		);
		assert.deepEqual(behind.queued, [16]);
		assert.deepEqual(behind.corrupt, []);
		assert.deepEqual(behind.ledgerBehind, [
			{ issue: 14, ledgerSeq: 0, localSeq: 2 },
		]);
		assert.deepEqual(behindLogs(logs), [
			{ issue: 14, ledgerSeq: 0, localSeq: 2 },
		]);
		assert.equal(github.markers(14).length, 0);
		assert.deepEqual(files.claims.get(runOf(14)), blockedClaim(14, 2));

		issue.comments.push(...kept);
		clock.t += 35_000;

		const back = await controller.tick();

		assert.deepEqual(runIssues(back), [14, 15]);
		assert.deepEqual(back.queued, [16]);
		assert.deepEqual(statuses(github, 14), ["1:claimed", "2:blocked"]);
		assert.deepEqual(statuses(github, 16), []);
	});

	it("keeps a live run and its slot when its bot comments are deleted, and polls 4 requests after", async () => {
		const { github, clock, executor, logs, start } = world();
		const issue = github.add(labeled(14));

		github.add(labeled(15));
		github.add(labeled(16));

		const controller = start();

		await controller.tick();
		clock.t += 30_000;
		await controller.tick();

		const kept = issue.comments.splice(0);

		issue.updatedAt = "2026-10-29T02:01:00Z";
		clock.t += 30_000;

		const behind = await controller.tick();

		assert.deepEqual(
			behind.runs.map((run) => [run.issue, run.status, run.seq]),
			[
				[14, "blocked", 2],
				[15, "blocked", 2],
			],
		);
		assert.deepEqual(behind.queued, [16]);
		assert.deepEqual(behind.corrupt, []);
		assert.deepEqual(behind.ledgerBehind, [
			{ issue: 14, ledgerSeq: 0, localSeq: 2 },
		]);
		assert.equal(github.markers(14).length, 0);

		issue.comments.push(...kept);
		clock.t += 30_000;

		const back = await controller.tick();

		assert.deepEqual(runIssues(back), [14, 15]);
		assert.deepEqual(back.queued, [16]);
		assert.deepEqual(back.ledgerBehind, []);
		assert.deepEqual(statuses(github, 16), []);
		assert.equal(behindLogs(logs).length, 1);
		assert.equal(executor.launches.length, 2);

		clock.t += 30_000;
		github.calls.length = 0;
		await controller.tick();

		assert.equal(github.calls.length, 4, JSON.stringify(github.calls));
	});

	it("posts the next marker after the local seq when a stage ends while the bot comments are gone", async () => {
		const { github, clock, executor, start } = world();
		const issue = github.add(labeled(14));

		executor.behaviors = [{ kind: "hang" }];

		const controller = start();

		await controller.tick();
		issue.comments.length = 0;
		issue.updatedAt = "2026-10-29T02:00:01Z";
		clock.t += 30_000;
		await controller.tick();
		clock.t += 300_001;

		const report = await controller.tick();

		assert.equal(executor.launches[0]?.signal.aborted, true);
		assert.deepEqual(
			report.runs.map((run) => [run.status, run.attempt, run.seq]),
			[["retrying", 2, 3]],
		);
		assert.deepEqual(report.corrupt, []);
		assert.deepEqual(statuses(github, 14), ["3:retrying"]);
	});

	it("releases at the next seq and claims the new event when the bot comments are deleted before a relabel", async () => {
		const { github, clock, executor, start } = world();
		const issue = github.add(labeled(14));
		const controller = start();

		await controller.tick();
		clock.t += 30_000;
		await controller.tick();
		issue.comments.length = 0;

		const next = relabel(github, issue);

		clock.t += 32 * 60_000;

		const report = await controller.tick();

		assert.deepEqual(statuses(github, 14), [
			"3:released",
			"4:claimed",
			"5:blocked",
		]);
		assert.deepEqual(
			report.runs.map((run) => [run.runId, run.status, run.seq]),
			[[next, "blocked", 5]],
		);
		assert.deepEqual(report.corrupt, []);
		assert.equal(executor.launches.length, 2);
	});

	it("releases at the next seq when the issue closes in the tick its bot comments are deleted", async () => {
		const { github, clock, files, start } = world();
		const issue = github.add(labeled(14));
		const controller = start();

		await controller.tick();
		clock.t += 30_000;
		await controller.tick();
		issue.comments.length = 0;
		issue.state = "closed";
		issue.updatedAt = "2026-10-29T02:03:00Z";
		github.now = "2026-10-29T02:03:00Z";
		clock.t += 30_000;

		const report = await controller.tick();

		assert.deepEqual(statuses(github, 14), ["3:released"]);
		assert.deepEqual(report.runs, []);
		assert.deepEqual(report.corrupt, []);
		assert.deepEqual(
			[...files.claims.values()],
			[endedClaim(14, 3, { status: "released" })],
		);

		clock.t += 30_000;
		await controller.tick();

		assert.deepEqual(
			[...files.claims.values()],
			[endedClaim(14, 3, { status: "released" })],
		);
	});

	it("handles a close and reopen of an issue whose bot comments were deleted the same as one whose comments stayed", async () => {
		async function closeAndReopen(deleted: boolean) {
			const { github, clock, executor, start } = world();
			const issue = github.add(labeled(14));
			const controller = start();

			await controller.tick();

			const kept = deleted ? issue.comments.splice(0) : [];

			issue.updatedAt = "2026-10-29T02:00:01Z";
			clock.t += 30_000;
			await controller.tick();
			issue.state = "closed";
			issue.updatedAt = "2026-10-29T02:01:00Z";
			clock.t += 30_000;

			const closing = await controller.tick();

			issue.state = "open";
			issue.comments.push(...kept);
			issue.updatedAt = "2026-10-29T02:02:00Z";
			github.now = "2026-10-29T02:02:30Z";
			clock.t += 30_000;

			const reopened = await controller.tick();

			clock.t += 30_000;

			const later = await controller.tick();
			const next = relabel(github, issue);

			clock.t += 32 * 60_000;

			const relabeled = await controller.tick();

			return {
				closing: closing.runs,
				reopened: [reopened.runs, reopened.corrupt],
				later: [later.runs, later.corrupt],
				relabeled: relabeled.runs.map((run) => [run.runId, run.status]),
				next,
				markers: bySeq(github, 14),
				launches: executor.launches.length,
			};
		}

		const deleted = await closeAndReopen(true);

		assert.deepEqual(deleted, await closeAndReopen(false));
		assert.deepEqual(deleted.closing, []);
		assert.deepEqual(deleted.relabeled, [[deleted.next, "blocked"]]);
		assert.deepEqual(deleted.markers, [
			"1:claimed",
			"2:blocked",
			"3:released",
			"4:claimed",
			"5:blocked",
		]);
	});
});

describe("Orchestrator claim record", () => {
	it("mirrors each confirmed marker and upgrades a record without a seq on adoption", async () => {
		const { github, files, start } = world();

		github.add(labeled(14));
		await start().tick();

		assert.deepEqual([...files.claims.values()], [blockedClaim(14, 2)]);

		files.claims.set(runOf(14), {
			runId: runOf(14),
			issue: 14,
			eventId: String(EVENT_ID + 14),
			seq: null,
			status: null,
			stage: null,
			attempt: null,
			usage: null,
		});

		await start().tick();

		assert.deepEqual(statuses(github, 14), ["1:claimed", "2:blocked"]);
		assert.deepEqual(files.claims.get(runOf(14)), blockedClaim(14, 2));
	});

	it("treats a claim record without a seq as unconfirmed, so deleted markers are written again", async () => {
		const { github, files, start } = world();
		const issue = github.add(labeled(14));

		await start().tick();
		files.claims.set(runOf(14), {
			runId: runOf(14),
			issue: 14,
			eventId: String(EVENT_ID + 14),
			seq: null,
			status: null,
			stage: null,
			attempt: null,
			usage: null,
		});
		issue.comments.length = 0;
		issue.updatedAt = "2026-10-29T03:00:00Z";

		const report = await start().tick();

		assert.deepEqual(report.corrupt, []);
		assert.equal(report.runs[0]?.runId, runOf(14));
		assert.deepEqual(statuses(github, 14), ["1:claimed", "2:blocked"]);
	});

	it("adopts the ledger's marker and rewrites the record when the ledger is ahead of it", async () => {
		const { github, files, logs, start } = world();

		github.add(labeled(14));
		await start().tick();
		files.claims.set(runOf(14), {
			...blockedClaim(14, 1),
			status: "claimed",
		});

		const report = await start().tick();

		assert.deepEqual(
			report.runs.map((run) => [run.status, run.seq]),
			[["blocked", 2]],
		);
		assert.deepEqual(report.ledgerBehind, []);
		assert.deepEqual(behindLogs(logs), []);
		assert.deepEqual(statuses(github, 14), ["1:claimed", "2:blocked"]);
		assert.deepEqual(files.claims.get(runOf(14)), blockedClaim(14, 2));
	});

	it("takes the status from the ledger for a record written before it carried one", async () => {
		const { github, files, start } = world();

		github.add(labeled(14));
		await start().tick();
		files.claims.set(runOf(14), {
			...blockedClaim(14, 2),
			status: null,
			stage: null,
			attempt: null,
			usage: null,
		});

		const report = await start().tick();

		assert.deepEqual(
			report.runs.map((run) => [run.status, run.seq]),
			[["blocked", 2]],
		);
		assert.deepEqual(statuses(github, 14), ["1:claimed", "2:blocked"]);
		assert.deepEqual(files.claims.get(runOf(14)), blockedClaim(14, 2));
	});

	it("adopts a record without a status from the newest readable marker when the ledger is behind it too, and posts after its seq", async () => {
		const ctx = world();
		const { github, clock, files, logs, start } = ctx;
		const issue = github.add(labeled(14));

		await start().tick();
		files.claims.set(runOf(14), {
			...blockedClaim(14, 2),
			status: null,
			stage: null,
			attempt: null,
			usage: null,
		});

		const hidden = hideMarker(ctx, issue, 2);
		const controller = start();
		const report = await controller.tick();

		assert.deepEqual(
			report.runs.map((run) => [run.status, run.seq]),
			[["blocked", 3]],
		);
		assert.deepEqual(behindLogs(logs), [
			{ issue: 14, ledgerSeq: 1, localSeq: 2 },
		]);
		assert.deepEqual(report.ledgerBehind, []);
		assert.deepEqual(statuses(github, 14), [
			"1:claimed",
			"2:blocked",
			"3:blocked",
		]);

		hidden.hidden = false;
		issue.updatedAt = "2026-10-29T03:00:00Z";
		clock.t = Date.parse("2026-10-29T03:00:05Z");

		const revealed = await controller.tick();

		assert.deepEqual(revealed.corrupt, []);
		assert.deepEqual(revealed.ledgerBehind, []);
		assert.equal(github.markers(14).length, 3);
	});

	it("retries a failed rewrite on a tick whose comments read lags, so a restart keeps the run without a second post", async () => {
		const ctx = world();
		const { github, clock, files, executor, logs, start } = ctx;
		const issue = github.add(labeled(14));
		const writes = failClaimWrite(files, 2);
		const controller = start();

		await controller.tick();

		assert.equal(files.claims.get(runOf(14))?.seq, 1);
		assert.ok(events(logs).includes("claim_unwritable"));
		writes.failing = false;

		const hidden = hideMarker(ctx, issue, 2);

		issue.updatedAt = "2026-10-29T02:01:00Z";
		clock.t = Date.parse("2026-10-29T02:01:05Z");
		await controller.tick();

		assert.deepEqual(files.claims.get(runOf(14)), blockedClaim(14, 2));

		clock.t += 30_000;

		const restarted = start();
		const report = await restarted.tick();

		assert.deepEqual(
			report.runs.map((run) => [run.status, run.seq]),
			[["blocked", 2]],
		);
		assert.deepEqual(report.ledgerBehind, [
			{ issue: 14, ledgerSeq: 1, localSeq: 2 },
		]);
		assert.deepEqual(statuses(github, 14), ["1:claimed", "2:blocked"]);

		hidden.hidden = false;
		issue.updatedAt = "2026-10-29T02:03:00Z";
		clock.t = Date.parse("2026-10-29T02:03:05Z");

		const revealed = await restarted.tick();

		assert.deepEqual(revealed.corrupt, []);
		assert.deepEqual(statuses(github, 14), ["1:claimed", "2:blocked"]);
		assert.equal(executor.launches.length, 2);
	});

	it("retries a failed rewrite after its marker is deleted, so a restart keeps the run without a second post", async () => {
		const { github, clock, files, executor, start } = world();
		const issue = github.add(labeled(14));
		const writes = failClaimWrite(files, 2);
		const controller = start();

		await controller.tick();
		writes.failing = false;
		issue.comments.pop();
		issue.updatedAt = "2026-10-29T02:01:00Z";
		github.now = "2026-10-29T02:01:00Z";
		clock.t += 30_000;

		const observed = await controller.tick();

		assert.equal(observed.runs[0]?.status, "blocked");
		assert.deepEqual(files.claims.get(runOf(14)), blockedClaim(14, 2));

		const report = await start().tick();

		assert.deepEqual(
			report.runs.map((run) => [run.status, run.seq]),
			[["blocked", 2]],
		);
		assert.deepEqual(report.corrupt, []);
		assert.deepEqual(statuses(github, 14), ["1:claimed"]);
		assert.equal(executor.launches.length, 2);
	});

	it("ends as duplicate_seq when the claim record and the comments read are both behind across a restart", async () => {
		const ctx = world();
		const { github, clock, files, start } = ctx;
		const issue = github.add(labeled(14));

		failClaimWrite(files, 2);
		await start().tick();

		const hidden = hideMarker(ctx, issue, 2);

		await start().tick();

		assert.deepEqual(statuses(github, 14), [
			"1:claimed",
			"2:blocked",
			"2:blocked",
		]);

		hidden.hidden = false;
		issue.updatedAt = "2026-10-29T03:00:00Z";
		clock.t = Date.parse("2026-10-29T03:00:05Z");

		const report = await start().tick();

		assert.deepEqual(report.corrupt, [{ issue: 14, defect: "duplicate_seq" }]);
		assert.deepEqual(report.runs, []);
	});

	it("writes the record upgrade on a later tick when adoption cannot write it", async () => {
		const { github, clock, files, start } = world();

		github.add(labeled(14));
		await start().tick();
		files.claims.set(runOf(14), {
			runId: runOf(14),
			issue: 14,
			eventId: String(EVENT_ID + 14),
			seq: null,
			status: null,
			stage: null,
			attempt: null,
			usage: null,
		});

		const write = files.writeClaim;
		let failing = true;

		files.writeClaim = async (claim) => (failing ? false : write(claim));

		const controller = start();

		await controller.tick();

		assert.equal(files.claims.get(runOf(14))?.seq, null);
		failing = false;
		clock.t += 30_000;
		await controller.tick();

		assert.deepEqual(files.claims.get(runOf(14)), blockedClaim(14, 2));
		assert.deepEqual(statuses(github, 14), ["1:claimed", "2:blocked"]);
	});

	it("retries a failed rewrite on every tick while the comments read stays behind", async () => {
		const ctx = world();
		const { github, clock, files, start } = ctx;
		const issue = github.add(labeled(14));
		const writes = failClaimWrite(files, 2);
		const controller = start();
		const behind = [{ issue: 14, ledgerSeq: 1, localSeq: 2 }];

		await controller.tick();

		assert.equal(files.claims.get(runOf(14))?.seq, 1);

		hideMarker(ctx, issue, 2);
		clock.t += 30_000;

		const lagging = await controller.tick();

		assert.deepEqual(lagging.ledgerBehind, behind);

		clock.t += 30_000;
		await controller.tick();

		assert.equal(files.claims.get(runOf(14))?.seq, 1);

		writes.failing = false;
		clock.t += 30_000;

		const healed = await controller.tick();

		assert.deepEqual(healed.ledgerBehind, behind);
		assert.deepEqual(files.claims.get(runOf(14)), blockedClaim(14, 2));
	});
});

function hideStatus(
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

function endedClaim(
	issue: number,
	seq: number,
	change: Partial<ClaimRecord>,
): ClaimRecord {
	return { ...blockedClaim(issue, seq), ...change };
}

describe("Orchestrator terminal claim records", () => {
	it("keeps a failed run's record until a read shows the marker, so a restart whose read hides it posts nothing", async () => {
		const ctx = world();
		const { github, clock, files, executor, start } = ctx;
		const issue = github.add(labeled(14));

		executor.fallback = { kind: "fail", usage: 0 };

		const controller = start();

		await controller.tick();
		await controller.tick();
		clock.t += 10_000;
		await controller.tick();
		await controller.tick();
		clock.t += 20_000;
		await controller.tick();

		const failed = await controller.tick();

		const ended = [
			"1:claimed",
			"2:running",
			"3:retrying",
			"4:running",
			"5:retrying",
			"6:running",
			"7:failed",
		];

		assert.deepEqual(failed.runs, []);
		assert.deepEqual(statuses(github, 14), ended);
		assert.deepEqual(
			files.claims.get(runOf(14)),
			endedClaim(14, 7, { status: "failed", attempt: 3 }),
		);

		const hidden = hideStatus(ctx, issue, "failed");

		issue.updatedAt = "2026-10-29T03:00:00Z";
		clock.t = Date.parse("2026-10-29T03:00:05Z");

		const restarted = await start().tick();

		assert.deepEqual(restarted.runs, []);
		assert.deepEqual(restarted.corrupt, []);
		assert.deepEqual(statuses(github, 14), ended);
		assert.equal(executor.launches.length, 3);
		assert.equal(files.claims.get(runOf(14))?.status, "failed");

		hidden.hidden = false;
		issue.updatedAt = "2026-10-29T03:10:00Z";
		clock.t = Date.parse("2026-10-29T03:10:05Z");

		const revealed = await start().tick();

		assert.deepEqual(revealed.runs, []);
		assert.deepEqual(revealed.corrupt, []);
		assert.deepEqual(
			files.claims.get(runOf(14)),
			endedClaim(14, 7, { status: "failed", attempt: 3 }),
		);

		const next = relabel(github, issue);

		executor.fallback = { kind: "unavailable" };
		clock.t += 32 * 60_000;

		const relabeled = await start().tick();

		assert.deepEqual(
			relabeled.runs.map((run) => [run.runId, run.status, run.seq]),
			[[next, "blocked", 9]],
		);
		assert.deepEqual(relabeled.corrupt, []);
		assert.deepEqual(statuses(github, 14), [
			...ended,
			"8:claimed",
			"9:blocked",
		]);
	});

	it("keeps a released run's record across a restart whose read hides the release, and the run takes no slot back", async () => {
		const ctx = world();
		const { github, clock, files, executor, start } = ctx;
		const issue = github.add(labeled(14));

		github.add(labeled(15));
		github.add(labeled(16));
		await start().tick();
		issue.state = "closed";
		issue.updatedAt = "2026-10-29T02:10:00Z";
		clock.t = Date.parse("2026-10-29T02:10:05Z");

		const closed = await start().tick();

		assert.deepEqual(runIssues(closed), [15, 16]);
		assert.deepEqual(statuses(github, 14), [
			"1:claimed",
			"2:blocked",
			"3:released",
		]);
		assert.deepEqual(
			files.claims.get(runOf(14)),
			endedClaim(14, 3, { status: "released" }),
		);

		issue.state = "open";
		issue.updatedAt = "2026-10-29T02:20:00Z";
		clock.t = Date.parse("2026-10-29T02:20:05Z");

		const hidden = hideStatus(ctx, issue, "released");
		const controller = start();
		const restarted = await controller.tick();

		assert.deepEqual(runIssues(restarted), [15, 16]);
		assert.deepEqual(restarted.corrupt, []);
		assert.equal(github.markers(14).length, 3);
		assert.equal(files.claims.get(runOf(14))?.status, "released");

		hidden.hidden = false;
		issue.updatedAt = "2026-10-29T02:30:00Z";
		clock.t = Date.parse("2026-10-29T02:30:05Z");

		const visible = await controller.tick();

		assert.deepEqual(runIssues(visible), [15, 16]);
		assert.deepEqual(visible.corrupt, []);
		assert.deepEqual(
			files.claims.get(runOf(14)),
			endedClaim(14, 3, { status: "released" }),
		);
		assert.equal(github.markers(14).length, 3);
		assert.deepEqual(statuses(github, 16), ["1:claimed", "2:blocked"]);
		assert.equal(executor.launches.length, 6);
	});

	it("does not revive a released event when its issue reopens and the comments read is empty", async () => {
		const ctx = world();
		const { github, clock, files, executor, start } = ctx;
		const issue = github.add(labeled(14, { author: "triager" }));
		const controller = start();

		await controller.tick();
		clock.t += 30_000;
		await controller.tick();
		issue.state = "closed";
		issue.updatedAt = "2026-10-29T02:01:00Z";
		github.now = issue.updatedAt;
		clock.t += 30_000;

		const closed = await controller.tick();

		assert.deepEqual(closed.runs, []);
		assert.deepEqual(
			files.claims.get(runOf(14)),
			endedClaim(14, 3, { status: "released" }),
		);

		issue.state = "open";
		issue.updatedAt = "2026-10-29T02:02:00Z";
		github.now = issue.updatedAt;
		clock.t += 60_000;

		const saved = issue.comments.splice(0);
		const reopened = await controller.tick();

		issue.comments.push(...saved);

		assert.deepEqual(reopened.runs, []);
		assert.deepEqual(reopened.corrupt, []);
		assert.equal(executor.launches.length, 1);
		assert.deepEqual(statuses(github, 14), [
			"1:claimed",
			"2:blocked",
			"3:released",
		]);

		issue.updatedAt = "2026-10-29T02:03:00Z";
		clock.t += 60_000;

		const revealed = await controller.tick();

		assert.deepEqual(revealed.runs, []);
		assert.deepEqual(revealed.corrupt, []);
		assert.deepEqual(
			files.claims.get(runOf(14)),
			endedClaim(14, 3, { status: "released" }),
		);

		issue.updatedAt = "2026-10-29T02:04:00Z";
		clock.t += 60_000;

		const emptied = issue.comments.splice(0);
		const reopenedAgain = await controller.tick();

		issue.comments.push(...emptied);

		assert.deepEqual(reopenedAgain.runs, []);
		assert.deepEqual(reopenedAgain.corrupt, []);
		assert.equal(executor.launches.length, 1);
		assert.deepEqual(statuses(github, 14), [
			"1:claimed",
			"2:blocked",
			"3:released",
		]);

		const next = relabel(github, issue);

		clock.t += 32 * 60_000;

		const relabeled = await controller.tick();

		assert.deepEqual(
			relabeled.runs.map((run) => [run.runId, run.status, run.seq]),
			[[next, "blocked", 5]],
		);
		assert.deepEqual(relabeled.corrupt, []);
		assert.equal(executor.launches.length, 2);
	});

	it("keeps a terminal record once a read shows its marker, reads it no more and loads it again after a restart", async () => {
		const { github, clock, files, start } = world();
		const issue = github.add(labeled(14));
		const controller = start();
		const released = endedClaim(14, 3, { status: "released" });

		await controller.tick();
		issue.state = "closed";
		issue.updatedAt = "2026-10-29T02:01:00Z";
		clock.t += 30_000;
		await controller.tick();

		assert.deepEqual(files.claims.get(runOf(14)), released);

		clock.t += 30_000;
		await controller.tick();

		assert.deepEqual([...files.claims.values()], [released]);

		clock.t += 30_000;
		github.calls.length = 0;
		await controller.tick();

		assert.equal(github.calls.length, 4, JSON.stringify(github.calls));

		const restarted = start();

		clock.t += 30_000;
		await restarted.tick();
		clock.t += 30_000;
		github.calls.length = 0;

		const report = await restarted.tick();

		assert.equal(github.calls.length, 4, JSON.stringify(github.calls));
		assert.deepEqual(report.runs, []);
		assert.deepEqual([...files.claims.values()], [released]);
		assert.deepEqual(statuses(github, 14), [
			"1:claimed",
			"2:blocked",
			"3:released",
		]);
	});

	it("keeps a budget-exhausted record that its posting tick read back, so a restart whose read lags posts nothing and a relabel dispatches", async () => {
		const ctx = world();
		const { github, clock, files, executor, start } = ctx;
		const issue = github.add(labeled(14));
		const other = github.add(labeled(15));

		github.add(labeled(16));
		executor.behaviors = [{ kind: "fail", usage: 500_000 }];

		const controller = start();
		const exhausted = ["1:claimed", "2:running", "3:budget_exhausted"];

		const record = endedClaim(14, 3, {
			status: "budget_exhausted",
			usage: 500_000,
		});

		await controller.tick();
		clock.t += 30_000;
		github.now = "2026-10-29T02:00:30Z";

		const ended = await controller.tick();

		assert.deepEqual(runIssues(ended), [15, 16]);
		assert.deepEqual(statuses(github, 14), exhausted);
		assert.deepEqual(files.claims.get(runOf(14)), record);

		const hidden = hideStatus(ctx, issue, "budget_exhausted");

		issue.updatedAt = "2026-10-29T03:00:00Z";
		clock.t = Date.parse("2026-10-29T03:00:05Z");

		const restarted = await start().tick();

		assert.deepEqual(runIssues(restarted), [15, 16]);
		assert.deepEqual(restarted.corrupt, []);
		assert.deepEqual(restarted.ledgerBehind, [
			{ issue: 14, ledgerSeq: 2, localSeq: 3 },
		]);
		assert.deepEqual(statuses(github, 14), exhausted);

		hidden.hidden = false;
		issue.updatedAt = "2026-10-29T03:10:00Z";
		clock.t = Date.parse("2026-10-29T03:10:05Z");

		const revealed = await start().tick();

		assert.deepEqual(runIssues(revealed), [15, 16]);
		assert.deepEqual(revealed.corrupt, []);
		assert.deepEqual(files.claims.get(runOf(14)), record);

		const next = relabel(github, issue);

		other.state = "closed";
		other.updatedAt = "2026-10-29T02:31:00Z";
		clock.t += 32 * 60_000;

		const relabeled = await start().tick();

		assert.deepEqual(
			relabeled.runs.map((run) => [run.runId, run.status, run.seq]),
			[
				[next, "blocked", 5],
				[runOf(16), "blocked", 2],
			],
		);
		assert.deepEqual(relabeled.corrupt, []);
		assert.deepEqual(statuses(github, 14), [
			...exhausted,
			"4:claimed",
			"5:blocked",
		]);
	});

	it("keeps the terminal record a read shows when the record missed that rewrite, so a later lagging read posts nothing", async () => {
		const ctx = world();
		const { github, clock, files, start } = ctx;
		const issue = github.add(labeled(14));
		const controller = start();
		const ended = ["1:claimed", "2:blocked", "3:released"];

		await controller.tick();

		const writes = failClaimWrite(files, 3);

		issue.state = "closed";
		issue.updatedAt = "2026-10-29T02:01:00Z";
		clock.t += 30_000;
		await controller.tick();

		assert.deepEqual(statuses(github, 14), ended);
		assert.deepEqual(files.claims.get(runOf(14)), blockedClaim(14, 2));

		writes.failing = false;
		clock.t += 30_000;
		await start().tick();

		assert.deepEqual(
			[...files.claims.values()],
			[endedClaim(14, 3, { status: "released" })],
		);

		hideStatus(ctx, issue, "released");
		issue.updatedAt = "2026-10-29T02:05:00Z";
		clock.t += 5 * 60_000;

		const restarted = await start().tick();

		assert.deepEqual(restarted.runs, []);
		assert.deepEqual(restarted.corrupt, []);
		assert.deepEqual(statuses(github, 14), ended);
	});

	it("retries a failed terminal rewrite on every tick after its marker is read, then stops", async () => {
		const { github, clock, files, start } = world();
		const issue = github.add(labeled(14));
		const write = files.writeClaim;
		const control = { failing: true, attempts: 0 };

		files.writeClaim = async (claim) => {
			if (claim.status === "released") {
				control.attempts++;

				if (control.failing) return false;
			}

			return write(claim);
		};

		const controller = start();

		await controller.tick();
		clock.t += 30_000;
		await controller.tick();
		issue.state = "closed";
		issue.updatedAt = "2026-10-29T02:01:00Z";
		clock.t += 60_000;
		await controller.tick();

		assert.deepEqual(files.claims.get(runOf(14)), blockedClaim(14, 2));

		const failed = control.attempts;

		clock.t += 30_000;
		await controller.tick();

		assert.equal(control.attempts, failed + 1);
		assert.deepEqual(files.claims.get(runOf(14)), blockedClaim(14, 2));

		control.failing = false;
		clock.t += 30_000;
		await controller.tick();

		assert.deepEqual(
			files.claims.get(runOf(14)),
			endedClaim(14, 3, { status: "released" }),
		);

		const landed = control.attempts;

		clock.t += 30_000;
		await controller.tick();

		assert.equal(control.attempts, landed);
		assert.deepEqual(statuses(github, 14), [
			"1:claimed",
			"2:blocked",
			"3:released",
		]);
	});
});

describe("Orchestrator persisted claim slots", () => {
	it("holds the slot of a claim whose recovery read failed, and adopts it later within the cap", async () => {
		const { github, clock, start } = world();

		github.add(labeled(14));
		github.add(labeled(15));
		github.add(labeled(16));
		await start().tick();
		clock.t += 30_000;
		github.failures.set(
			`repos/${FAKE_REPO}/issues/14/comments`,
			networkError(),
		);

		const controller = start();
		const failed = await controller.tick();

		assert.deepEqual(runIssues(failed), [15]);
		assert.deepEqual(failed.queued, [16]);
		assert.deepEqual(statuses(github, 16), []);

		github.failures.clear();
		clock.t += 30_000;

		const next = await controller.tick();

		assert.deepEqual(runIssues(next), [14, 15]);
		assert.deepEqual(next.queued, [16]);
		assert.equal(next.maxConcurrent, 2);
		assert.deepEqual(statuses(github, 16), []);
	});

	it("adopts a claim whose corrupt ledger heals only when a slot is free", async () => {
		const { github, clock, start } = world();
		const issue = github.add(labeled(14));
		const other = github.add(labeled(15));

		github.add(labeled(16));

		const controller = start();

		await controller.tick();
		clock.t += 30_000;
		await controller.tick();

		const blocked = issue.comments[1];

		assert.ok(blocked);
		blocked.lastEditedAt = "2026-10-29T02:01:00Z";
		issue.updatedAt = "2026-10-29T02:01:00Z";
		clock.t += 60_000;

		const dropped = await controller.tick();

		assert.deepEqual(dropped.corrupt, [{ issue: 14, defect: "edited" }]);
		assert.deepEqual(runIssues(dropped), [15, 16]);

		issue.comments.pop();
		issue.updatedAt = "2026-10-29T02:02:00Z";
		clock.t += 60_000;

		const healed = await controller.tick();

		assert.deepEqual(healed.corrupt, []);
		assert.deepEqual(runIssues(healed), [15, 16]);
		assert.deepEqual(healed.queued, [14]);

		clock.t += 60_000;

		const waiting = await controller.tick();

		assert.deepEqual(runIssues(waiting), [15, 16]);
		assert.deepEqual(waiting.queued, [14]);

		other.state = "closed";
		other.updatedAt = "2026-10-29T02:03:00Z";
		clock.t += 60_000;

		const freed = await controller.tick();

		assert.deepEqual(runIssues(freed), [14, 16]);
		assert.deepEqual(freed.queued, []);
		assert.deepEqual(statuses(github, 14), ["1:claimed"]);
	});

	it("recovers a claim recorded before its first marker with its own slot before admitting fresh candidates", async () => {
		const { github, clock, files, start } = world();
		const first = github.add(labeled(14, { state: "closed" }));

		github.add(labeled(16));
		github.posts = ["lost"];

		const seed = await start().tick();

		assert.deepEqual(
			seed.runs.map((run) => [run.issue, run.markerPending]),
			[[16, true]],
		);
		assert.equal(files.claims.get(runOf(16))?.seq, null);
		assert.deepEqual(statuses(github, 16), []);

		first.state = "open";
		github.add(labeled(15));
		clock.t += 30_000;

		const recovered = await start().tick();

		assert.deepEqual(runIssues(recovered), [14, 16]);
		assert.deepEqual(recovered.queued, [15]);
		assert.deepEqual(statuses(github, 16), ["1:claimed", "2:blocked"]);
		assert.deepEqual(statuses(github, 15), []);
		assert.deepEqual(
			[...files.claims.keys()].sort(),
			[runOf(14), runOf(16)].sort(),
		);
	});

	it("recovers claims recorded before their first marker only while a slot is free, and lists the rest in queued", async () => {
		const { github, clock, files, start } = world();

		github.add(labeled(14));
		github.add(labeled(15));
		github.add(labeled(16));
		github.workflow = (github.workflow ?? "").replace(
			"max_concurrent: 2",
			"max_concurrent: 3",
		);
		github.posts = ["lost", "lost", "lost"];
		await start().tick();

		assert.equal(files.claims.size, 3);

		github.workflow = github.workflow.replace(
			"max_concurrent: 3",
			"max_concurrent: 2",
		);
		clock.t += 30_000;

		const controller = start();
		const recovered = await controller.tick();

		assert.deepEqual(runIssues(recovered), [14, 15]);
		assert.deepEqual(recovered.queued, [16]);
		assert.deepEqual(statuses(github, 16), []);

		clock.t += 30_000;

		const again = await controller.tick();

		assert.deepEqual(runIssues(again), [14, 15]);
		assert.deepEqual(again.queued, [16]);
		assert.equal(files.claims.size, 3);
	});

	it("lists a claimed run that waits for a slot after the cap is lowered in queued", async () => {
		const { github, clock, files, start } = world();

		const cap = (limit: number) => {
			github.workflow = (github.workflow ?? "").replace(
				/max_concurrent: \d/,
				`max_concurrent: ${limit}`,
			);
		};

		github.add(labeled(14));
		github.add(labeled(15));
		github.add(labeled(16));
		cap(3);
		await start().tick();

		assert.equal(files.claims.size, 3);

		cap(2);
		clock.t += 30_000;

		const controller = start();
		const waiting = await controller.tick();

		assert.deepEqual(runIssues(waiting), [14, 15]);
		assert.deepEqual(waiting.queued, [16]);
		assert.deepEqual(waiting.corrupt, []);
		assert.deepEqual(waiting.ledgerBehind, []);

		clock.t += 30_000;

		const again = await controller.tick();

		assert.deepEqual(runIssues(again), [14, 15]);
		assert.deepEqual(again.queued, [16]);
		assert.equal(files.claims.size, 3);
		assert.deepEqual(statuses(github, 16), ["1:claimed", "2:blocked"]);
	});

	it("keeps a ready claim the candidate list omits waiting for a slot on every tick", async () => {
		const { github, clock, files, wire, start } = world();

		github.add(labeled(14));
		const other = github.add(labeled(15));

		github.add(labeled(16));
		capAt(github, 3);
		await start().tick();

		assert.equal(files.claims.size, 3);

		capAt(github, 2);
		wire.intercept = omitFromList(github, 14);
		clock.t += 30_000;

		const controller = start();
		const lagging = await controller.tick();

		assert.deepEqual(runIssues(lagging), [15, 16]);
		assert.deepEqual(lagging.queued, [14]);
		assert.equal(lagging.maxConcurrent, 2);

		clock.t += 30_000;

		const again = await controller.tick();

		assert.deepEqual(runIssues(again), [15, 16]);
		assert.deepEqual(again.queued, [14]);

		wire.intercept = null;
		clock.t += 30_000;

		const listed = await controller.tick();

		assert.deepEqual(runIssues(listed), [15, 16]);
		assert.deepEqual(listed.queued, [14]);

		other.state = "closed";
		other.updatedAt = "2026-10-29T02:03:00Z";
		clock.t += 60_000;

		const freed = await controller.tick();

		assert.deepEqual(runIssues(freed), [14, 16]);
		assert.deepEqual(freed.queued, []);
		assert.deepEqual(statuses(github, 14), ["1:claimed", "2:blocked"]);
	});

	it("releases a closed claim from the read that shows it closed, without a slot, when a later issue read fails", async () => {
		const { github, clock, files, logs, wire, start } = world();
		const issue = github.add(labeled(14));

		github.add(labeled(15));
		github.add(labeled(16));
		capAt(github, 3);
		await start().tick();

		assert.equal(files.claims.size, 3);

		capAt(github, 2);
		issue.state = "closed";
		issue.updatedAt = "2026-10-29T02:00:20Z";
		clock.t += 30_000;

		let gets = 0;

		wire.intercept = async (command, args) => {
			const path = args.find((arg) => arg.startsWith("repos/")) ?? "";

			if (!args.includes("--method") && path.endsWith("/issues/14")) {
				gets += 1;

				if (gets >= 2) return networkError();
			}

			return github.exec(command, args);
		};

		const controller = start();
		const closed = await controller.tick();

		assert.deepEqual(runIssues(closed), [15, 16]);
		assert.deepEqual(closed.queued, []);
		assert.deepEqual(statuses(github, 14), [
			"1:claimed",
			"2:blocked",
			"3:released",
		]);
		assert.equal(files.claims.get(runOf(14))?.status, "released");
		assert.deepEqual(
			logs
				.filter((entry) => entry.event === "claim_released")
				.map((entry) => [entry.fields.issue, entry.fields.why]),
			[[14, "closed"]],
		);

		clock.t += 30_000;

		const next = await controller.tick();

		assert.deepEqual(runIssues(next), [15, 16]);
		assert.deepEqual(next.queued, []);
		assert.equal(statuses(github, 14).length, 3);
	});
});

function capAt(github: FakeGitHub, limit: number): void {
	github.workflow = (github.workflow ?? "").replace(
		/max_concurrent: \d/,
		`max_concurrent: ${limit}`,
	);
}

function setWorkflow(github: FakeGitHub, from: string, to: string): void {
	github.workflow = (github.workflow ?? "").replace(from, to);
}

function omitFromList(github: FakeGitHub, issue: number): Exec {
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

describe("Orchestrator claims recorded before their first marker", () => {
	it("recovers one the candidate list omits from the issue read, with its own slot, before fresh admissions", async () => {
		const { github, clock, files, wire, start } = world();

		github.add(labeled(14));
		github.posts = ["lost"];
		await start().tick();

		assert.equal(files.claims.get(runOf(14))?.seq, null);
		assert.deepEqual(statuses(github, 14), []);

		github.add(labeled(15));
		github.add(labeled(16));
		wire.intercept = omitFromList(github, 14);
		clock.t += 30_000;

		const lagging = await start().tick();

		assert.deepEqual(runIssues(lagging), [14, 15]);
		assert.deepEqual(lagging.queued, [16]);
		assert.deepEqual(statuses(github, 14), ["1:claimed", "2:blocked"]);
		assert.deepEqual(statuses(github, 16), []);

		wire.intercept = null;
		clock.t += 30_000;

		const listed = await start().tick();

		assert.deepEqual(runIssues(listed), [14, 15]);
		assert.deepEqual(listed.queued, [16]);
		assert.deepEqual(statuses(github, 16), []);
	});

	it("does not cache a ready one the candidate list omits as decided", async () => {
		const { github, clock, files, wire, start } = world();

		github.add(labeled(14));
		github.posts = ["lost"];
		await start().tick();

		assert.equal(files.claims.get(runOf(14))?.seq, null);

		clock.t += 30_000;
		wire.intercept = omitFromList(github, 14);

		const controller = start();

		await controller.tick();
		wire.intercept = null;

		for (let n = 0; n < 2; n++) {
			clock.t += 30_000;

			const report = await controller.tick();

			assert.deepEqual(runIssues(report), [14]);
			assert.deepEqual(report.queued, []);
		}

		assert.deepEqual(statuses(github, 14), ["1:claimed", "2:blocked"]);
		assert.deepEqual(files.claims.get(runOf(14)), blockedClaim(14, 2));
	});

	it("releases one whose issue closed, keeps the released record, and does not rerun the event on reopen", async () => {
		const { github, clock, files, executor, logs, start } = world();
		const issue = github.add(labeled(14));

		github.posts = ["lost"];
		await start().tick();

		assert.equal(files.claims.get(runOf(14))?.seq, null);

		issue.state = "closed";
		issue.updatedAt = "2026-10-29T02:00:20Z";
		clock.t += 30_000;

		const closed = await start().tick();

		assert.deepEqual(closed.runs, []);
		assert.deepEqual(closed.queued, []);
		assert.deepEqual(statuses(github, 14), ["1:released"]);
		assert.deepEqual(
			[...files.claims.values()],
			[endedClaim(14, 1, { status: "released" })],
		);
		assert.deepEqual(
			logs
				.filter((entry) => entry.event === "claim_released")
				.map((entry) => [entry.fields.issue, entry.fields.why]),
			[[14, "closed"]],
		);

		issue.state = "open";
		issue.updatedAt = "2026-10-29T02:01:00Z";
		clock.t += 60_000;

		const reopened = await start().tick();

		assert.deepEqual(reopened.runs, []);
		assert.deepEqual(statuses(github, 14), ["1:released"]);
		assert.equal(executor.launches.length, 0);
	});

	it("keeps one whose issue closed while its admission record cannot be read, and releases it once it can", async () => {
		const { github, clock, files, store, start } = world();
		const issue = github.add(labeled(14));

		github.posts = ["lost"];
		await start().tick();
		issue.state = "closed";
		issue.updatedAt = "2026-10-29T02:00:20Z";

		const read = store.read;

		store.read = async () => ({ kind: "unreadable" });
		clock.t += 30_000;

		const controller = start();
		const unread = await controller.tick();

		assert.deepEqual(unread.runs, []);
		assert.deepEqual(statuses(github, 14), []);
		assert.equal(files.claims.get(runOf(14))?.seq, null);

		store.read = read;
		clock.t += 30_000;
		await controller.tick();

		assert.deepEqual(statuses(github, 14), ["1:released"]);
		assert.equal(files.claims.get(runOf(14))?.status, "released");
	});
});

describe("Orchestrator before the first workflow load", () => {
	it("adopts no run into a slot until the process has loaded a workflow", async () => {
		const { github, clock, files, start } = world();

		github.add(labeled(14));
		github.add(labeled(15));
		await start().tick();

		assert.equal(files.claims.size, 2);

		capAt(github, 1);
		clock.t += 30_000;

		const fresh = await start().tick();

		assert.deepEqual(runIssues(fresh), [14]);
		assert.deepEqual(fresh.queued, [15]);
		assert.equal(fresh.maxConcurrent, 1);

		const workflow = github.workflow;

		github.workflow = null;
		clock.t += 30_000;

		const controller = start();
		const unloaded = await controller.tick();

		assert.deepEqual(unloaded.dispatch.reasons, ["workflow_unavailable"]);
		assert.deepEqual(runIssues(unloaded), []);
		assert.deepEqual(unloaded.queued, [14, 15]);
		assert.equal(unloaded.maxConcurrent, 0);

		github.workflow = workflow;
		clock.t += 60_000;

		const loaded = await controller.tick();

		assert.equal(loaded.dispatch.enabled, true);
		assert.deepEqual(runIssues(loaded), [14]);
		assert.deepEqual(loaded.queued, [15]);
		assert.equal(loaded.maxConcurrent, 1);
		assert.deepEqual(statuses(github, 15), ["1:claimed", "2:blocked"]);
	});

	it("still releases a closed claim before the first workflow load", async () => {
		const { github, clock, start } = world();
		const issue = github.add(labeled(14));

		await start().tick();
		issue.state = "closed";
		issue.updatedAt = "2026-10-29T02:00:20Z";
		github.workflow = null;
		clock.t += 30_000;

		const report = await start().tick();

		assert.deepEqual(report.dispatch.reasons, ["workflow_unavailable"]);
		assert.deepEqual(report.runs, []);
		assert.deepEqual(statuses(github, 14), [
			"1:claimed",
			"2:blocked",
			"3:released",
		]);
	});

	it("cannot launch an attempt past max_attempts: 1 after a restart whose first workflow read failed", async () => {
		const { github, clock, executor, start } = world();

		setWorkflow(github, "max_attempts: 3", "max_attempts: 1");
		github.add(labeled(14));
		executor.fallback = { kind: "hang" };
		await start().tick();

		const workflow = github.workflow;

		github.workflow = null;
		clock.t += 30_000;

		const controller = start();
		const unloaded = await controller.tick();

		assert.deepEqual(unloaded.runs, []);
		assert.deepEqual(unloaded.queued, [14]);
		assert.deepEqual(statuses(github, 14), ["1:claimed", "2:running"]);

		github.workflow = workflow;
		clock.t += 30_000;

		const loaded = await controller.tick();

		assert.equal(executor.launches.length, 1);
		assert.deepEqual(loaded.runs, []);
		assert.deepEqual(statuses(github, 14), [
			"1:claimed",
			"2:running",
			"3:failed",
		]);
	});

	it("does not fail an interrupted attempt under max_attempts: 5 before the first workflow load", async () => {
		const { github, clock, executor, start } = world();

		setWorkflow(github, "max_attempts: 3", "max_attempts: 5");
		github.add(labeled(14));
		executor.behaviors = [
			{ kind: "fail", usage: 0 },
			{ kind: "fail", usage: 0 },
			{ kind: "hang" },
		];

		const first = start();

		for (const offset of [0, 1, 10_001, 10_002, 30_002]) {
			clock.t = START + offset;
			await first.tick();
		}

		assert.equal(statuses(github, 14).at(-1), "6:running");

		const workflow = github.workflow;

		github.workflow = null;
		clock.t = START + 30_003;

		const controller = start();
		const unloaded = await controller.tick();

		assert.deepEqual(unloaded.runs, []);
		assert.deepEqual(unloaded.queued, [14]);
		assert.equal(statuses(github, 14).length, 6);

		github.workflow = workflow;
		clock.t = START + 60_003;

		const loaded = await controller.tick();

		assert.deepEqual(
			loaded.runs.map((run) => [run.issue, run.status, run.attempt]),
			[[14, "retrying", 4]],
		);
		assert.equal(statuses(github, 14).at(-1), "7:retrying");
	});

	it("does not end an interrupted run on the default token budget before the first workflow load", async () => {
		const { github, clock, executor, start } = world();

		setWorkflow(
			github,
			"max_tokens_per_run: 500000",
			"max_tokens_per_run: 2000000",
		);
		github.add(labeled(14));
		executor.behaviors = [{ kind: "fail", usage: 600_000 }, { kind: "hang" }];

		const first = start();

		for (const offset of [0, 1, 10_001]) {
			clock.t = START + offset;
			await first.tick();
		}

		assert.equal(statuses(github, 14).at(-1), "4:running");

		const workflow = github.workflow;

		github.workflow = null;
		clock.t += 1;

		const controller = start();

		await controller.tick();

		assert.equal(statuses(github, 14).length, 4);

		github.workflow = workflow;
		clock.t += 30_000;

		const loaded = await controller.tick();

		assert.deepEqual(
			loaded.runs.map((run) => [run.status, run.attempt, run.usage]),
			[["retrying", 3, 600_000]],
		);
		assert.equal(statuses(github, 14).at(-1), "5:retrying");
	});

	it("computes an adopted retry's due time from the loaded max_backoff_ms, not the default", async () => {
		const { github, clock, executor, start } = world();

		setWorkflow(github, "max_backoff_ms: 300000", "max_backoff_ms: 1000");
		github.add(labeled(14));
		executor.behaviors = [{ kind: "fail", usage: 0 }];

		const first = start();

		await first.tick();
		clock.t += 1;
		await first.tick();

		assert.equal(statuses(github, 14).at(-1), "3:retrying");

		const workflow = github.workflow;

		github.workflow = null;
		clock.t = START + 2_000;

		const controller = start();
		const unloaded = await controller.tick();

		assert.deepEqual(unloaded.runs, []);
		assert.deepEqual(unloaded.queued, [14]);

		github.workflow = workflow;
		clock.t = START + 3_001;

		const loaded = await controller.tick();

		assert.equal(executor.launches.length, 2);
		assert.deepEqual(
			loaded.runs.map((run) => [run.status, run.attempt]),
			[["blocked", 2]],
		);
	});

	it("releases a closed issue's running marker without deciding the interruption before the first workflow load", async () => {
		const { github, clock, executor, start } = world();
		const issue = github.add(labeled(14));

		executor.fallback = { kind: "hang" };
		await start().tick();
		issue.state = "closed";
		issue.updatedAt = "2026-10-29T02:00:20Z";
		github.workflow = null;
		clock.t += 30_000;

		const report = await start().tick();

		assert.deepEqual(report.runs, []);
		assert.deepEqual(statuses(github, 14), [
			"1:claimed",
			"2:running",
			"3:released",
		]);
	});

	it("lists a claim recorded before its first marker in queued while the workflow is unavailable", async () => {
		const { github, clock, files, start } = world();

		github.add(labeled(14));
		github.posts = ["lost"];
		await start().tick();

		assert.equal(files.claims.get(runOf(14))?.seq, null);

		const workflow = github.workflow;

		github.workflow = null;
		clock.t += 30_000;

		const controller = start();
		const unloaded = await controller.tick();

		assert.deepEqual(unloaded.runs, []);
		assert.deepEqual(unloaded.queued, [14]);
		assert.deepEqual(statuses(github, 14), []);

		github.workflow = workflow;
		clock.t += 30_000;

		const loaded = await controller.tick();

		assert.deepEqual(runIssues(loaded), [14]);
		assert.deepEqual(statuses(github, 14), ["1:claimed", "2:blocked"]);
	});

	it("adopts running and retrying markers while the loaded cap is full, because neither holds a slot once adopted", async () => {
		const { github, clock, executor, start } = world();

		for (const number of [14, 15, 16]) github.add(labeled(number));

		executor.behaviors = [{ kind: "unavailable" }, { kind: "fail", usage: 0 }];
		executor.fallback = { kind: "hang" };

		const first = start();

		await first.tick();
		clock.t += 1;
		executor.ready = false;
		await first.tick();
		executor.ready = null;

		assert.equal(statuses(github, 15).at(-1), "3:retrying");
		assert.equal(statuses(github, 16).at(-1), "2:running");

		executor.fallback = { kind: "unavailable" };
		capAt(github, 1);
		clock.t += 1;

		const report = await start().tick();

		assert.deepEqual(
			report.runs.map((run) => [run.issue, run.status]),
			[
				[14, "blocked"],
				[15, "retrying"],
				[16, "retrying"],
			],
		);
		assert.deepEqual(report.queued, []);
		assert.equal(statuses(github, 16).at(-1), "3:retrying");
	});
});

describe("Orchestrator retry workspace preparation", () => {
	it("does not spend the free slot on a due retry whose workspace is unavailable", async () => {
		const { github, clock, files, executor, start } = world();

		capAt(github, 1);
		github.add(labeled(14));
		executor.behaviors = [{ kind: "fail", usage: 0 }];

		const controller = start();

		await controller.tick();
		clock.t += 1;
		await controller.tick();

		const ensure = files.ensureWorkspace;
		let failing = true;

		files.ensureWorkspace = async (runId) =>
			failing && runId === runOf(14) ? "unavailable" : ensure(runId);
		github.add(labeled(15));
		clock.t += 30_000;

		const report = await controller.tick();

		assert.deepEqual(
			report.runs.map((run) => [run.issue, run.status]),
			[
				[14, "retrying"],
				[15, "blocked"],
			],
		);
		assert.deepEqual(report.queued, []);
		assert.equal(executor.launches.length, 2);

		failing = false;
		clock.t += 30_000;
		await controller.tick();

		assert.equal(executor.launches.length, 2);
	});

	it("does not spend the free slot when a real workspace path is obstructed", async () => {
		const { github, clock, store, executor, logs } = world();
		const state = stateDir();
		const files = fileRunFiles(state);

		const controller = new Orchestrator({
			exec: github.exec,
			env: () => "/home/exedev",
			repo,
			store,
			files,
			executor,
			clock,
			scope: null,
			log: (event, fields) => logs.push({ event, fields }),
		});

		capAt(github, 1);
		github.add(labeled(14));
		executor.behaviors = [{ kind: "fail", usage: 0 }];
		await controller.tick();
		clock.t += 1;
		await controller.tick();

		const workspace = files.workspacePath(runOf(14));

		rmSync(workspace, { recursive: true });
		writeFileSync(workspace, "");
		github.add(labeled(15));
		clock.t += 30_000;

		const report = await controller.tick();

		assert.deepEqual(
			report.runs.map((run) => [run.issue, run.status]),
			[
				[14, "retrying"],
				[15, "blocked"],
			],
		);
		assert.equal(executor.launches.length, 2);
		assert.ok(events(logs).includes("workspace_unavailable"));
	});
});

describe("Orchestrator claims before their first marker whose event was replaced", () => {
	it("releases the old claim at seq 1 before claiming the new event", async () => {
		const { github, clock, files, logs, start } = world();
		const issue = github.add(labeled(14));

		github.posts = ["lost"];
		await start().tick();

		const next = relabel(github, issue);

		clock.t += 40 * 60_000;

		const report = await start().tick();

		assert.equal(report.runs[0]?.runId, next);
		assert.equal(files.claims.get(runOf(14))?.status, "released");
		assert.deepEqual(statuses(github, 14), [
			"1:released",
			"2:claimed",
			"3:blocked",
		]);
		assert.deepEqual(
			logs
				.filter((entry) => entry.event === "claim_released")
				.map((entry) => [entry.fields.runId, entry.fields.why]),
			[[runOf(14), "new_event"]],
		);
	});

	it("gives the replaced claim no slot, so the healthy candidates fill the cap", async () => {
		const { github, clock, files, start } = world();
		const issue = github.add(labeled(15));

		github.posts = ["lost"];
		await start().tick();
		relabel(github, issue);
		github.issues.delete(15);
		github.add(labeled(13));
		github.add(labeled(14));
		github.add(issue);
		clock.t += 40 * 60_000;

		const report = await start().tick();

		assert.deepEqual(runIssues(report), [13, 14]);
		assert.deepEqual(report.queued, [15]);
		assert.deepEqual(statuses(github, 15), ["1:released"]);
		assert.equal(files.claims.get(runOf(15))?.status, "released");
	});
});

describe("Orchestrator cap reduction in a running process", () => {
	it("keeps the runs that hold slots, and launches or adopts nothing while they are at or above the new cap", async () => {
		const { github, clock, files, executor, wire, start } = world();

		github.add(labeled(16));
		await start().tick();
		files.claims.delete(runOf(16));

		github.add(labeled(14));
		github.add(labeled(15));
		wire.intercept = omitFromList(github, 16);
		clock.t += 30_000;

		const controller = start();
		const before = await controller.tick();

		assert.deepEqual(runIssues(before), [14, 15]);
		assert.equal(executor.launches.length, 3);

		wire.intercept = null;
		capAt(github, 1);
		github.add(labeled(17));

		for (let n = 0; n < 2; n++) {
			clock.t += 30_000;

			const report = await controller.tick();

			assert.equal(report.maxConcurrent, 1);
			assert.equal(report.active, 2);
			assert.deepEqual(runIssues(report), [14, 15]);
			assert.deepEqual(report.queued, [16, 17]);
		}

		assert.equal(executor.launches.length, 3);
		assert.deepEqual(statuses(github, 16), ["1:claimed", "2:blocked"]);
		assert.deepEqual(statuses(github, 17), []);
	});
});

describe("Orchestrator workspace replay", () => {
	it("keeps the replay of an adopted run whose workspace preparation failed, and replays it once preparation works", async () => {
		const { github, clock, files, executor, start } = world();

		github.add(labeled(14));
		await start().tick();
		files.workspaces.delete(runOf(14));

		const ensure = files.ensureWorkspace;
		let failing = true;

		files.ensureWorkspace = async (runId) =>
			failing ? "unavailable" : ensure(runId);
		clock.t += 30_000;

		const controller = start();

		await controller.tick();

		assert.equal(executor.launches.length, 1);

		failing = false;
		clock.t += 30_000;

		const replayed = await controller.tick();

		assert.equal(executor.launches.length, 2);
		assert.ok(files.workspaces.has(runOf(14)));
		assert.equal(replayed.runs[0]?.workspace, "missing_replayed");

		clock.t += 30_000;
		await controller.tick();

		assert.equal(executor.launches.length, 2);
		assert.deepEqual(statuses(github, 14), ["1:claimed", "2:blocked"]);
	});
});

describe("Orchestrator loaded terminal records", () => {
	it("does not count a loaded terminal record as a reservation when its issue cannot be read", async () => {
		const { github, clock, files, start } = world();
		const issue = github.add(labeled(14));
		const controller = start();

		await controller.tick();
		issue.state = "closed";
		issue.updatedAt = "2026-10-29T02:00:20Z";
		clock.t += 30_000;
		await controller.tick();

		assert.equal(files.claims.get(runOf(14))?.status, "released");

		github.failures.set(`repos/${FAKE_REPO}/issues/14`, networkError());
		github.add(labeled(15));
		github.add(labeled(16));
		clock.t += 30_000;

		const report = await start().tick();

		assert.deepEqual(runIssues(report), [15, 16]);
		assert.deepEqual(report.queued, []);
	});
});

describe("Orchestrator claim record usage", () => {
	it("keeps the recorded usage when the ledger is behind, so the run budget still ends the run", async () => {
		const ctx = world();
		const { github, clock, files, start } = ctx;
		const issue = github.add(labeled(14));

		ctx.executor.fallback = { kind: "fail", usage: 300_000 };

		const controller = start();

		await controller.tick();
		clock.t += 30_000;
		github.now = "2026-10-29T02:00:30Z";

		const failed = await controller.tick();

		assert.equal(failed.runs[0]?.usage, 300_000);
		assert.deepEqual(
			files.claims.get(runOf(14)),
			endedClaim(14, 3, { status: "retrying", attempt: 2, usage: 300_000 }),
		);

		const hidden = hideMarker(ctx, issue, 3);

		clock.t += 30_000;

		const restarted = start();
		const adopted = await restarted.tick();

		assert.deepEqual(
			adopted.runs.map((run) => [run.status, run.attempt, run.usage]),
			[["retrying", 2, 300_000]],
		);

		hidden.hidden = false;
		clock.t += 30_000;
		github.now = "2026-10-29T02:01:30Z";
		await restarted.tick();
		clock.t += 30_000;
		github.now = "2026-10-29T02:02:00Z";

		const ended = await restarted.tick();

		assert.deepEqual(ended.runs, []);
		assert.equal(statuses(github, 14).at(-1), "5:budget_exhausted");
	});
});

describe("Orchestrator release reasons", () => {
	it("names an unlabel seen only through the timeline as unlabeled", async () => {
		const { github, clock, logs, start } = world();
		const issue = github.add(labeled(14));
		const controller = start();

		await controller.tick();
		issue.timeline.push(
			labelEvent({
				id: 1,
				at: "2026-10-29T02:00:30Z",
				actor: "giuseppecrj",
				event: "unlabeled",
			}),
		);
		issue.updatedAt = "2026-10-29T02:00:30Z";
		clock.t += 60_000;
		await controller.tick();

		assert.deepEqual(
			logs.flatMap((entry) =>
				entry.event === "claim_released" ? [entry.fields.why] : [],
			),
			["unlabeled"],
		);
		assert.equal(statuses(github, 14).at(-1), "3:released");
	});
});

describe("Orchestrator retry marker confirmation", () => {
	async function lostRetryMarker() {
		const ctx = world();

		ctx.github.add(labeled(14));
		ctx.executor.behaviors = [{ kind: "fail", usage: 0 }];

		const controller = ctx.start();

		await controller.tick();
		ctx.clock.t += 30_000;
		ctx.github.posts = ["lost"];

		const queued = await controller.tick();

		assert.equal(queued.runs[0]?.status, "retrying");
		assert.equal(queued.runs[0]?.markerPending, true);
		ctx.clock.t += 30_000;

		return { ...ctx, controller };
	}

	it("keeps a due retry queued while the read-back of its marker fails", async () => {
		const { github, executor, controller } = await lostRetryMarker();

		github.failures.set(
			`repos/${FAKE_REPO}/issues/14/comments`,
			networkError(),
		);

		const deferred = await controller.tick();

		assert.equal(executor.launches.length, 1);
		assert.equal(deferred.runs[0]?.status, "retrying");
		assert.equal(deferred.runs[0]?.markerPending, true);

		github.failures.clear();
		await controller.tick();

		assert.equal(executor.launches.length, 2);
		assert.deepEqual(statuses(github, 14), [
			"1:claimed",
			"2:running",
			"3:retrying",
			"4:blocked",
		]);
	});

	it("keeps a due retry queued while the replacement for a lost marker is unconfirmed too", async () => {
		const { github, executor, controller } = await lostRetryMarker();

		github.posts = ["lost"];

		const deferred = await controller.tick();

		assert.equal(executor.launches.length, 1);
		assert.equal(deferred.runs[0]?.status, "retrying");
		assert.equal(deferred.runs[0]?.markerPending, true);
		assert.deepEqual(statuses(github, 14), ["1:claimed", "2:running"]);

		await controller.tick();

		assert.equal(executor.launches.length, 2);
		assert.deepEqual(statuses(github, 14), [
			"1:claimed",
			"2:running",
			"3:retrying",
			"4:blocked",
		]);
	});
});

describe("Orchestrator same-second cache", () => {
	it("reads the timeline before a due retry when the label was replaced in the cached second", async () => {
		const { github, clock, executor, start } = world();
		const issue = github.add(labeled(14));

		executor.behaviors = [{ kind: "fail", usage: 0 }];

		const controller = start();

		await controller.tick();
		clock.t += 30_000;
		github.now = "2026-10-29T02:00:30Z";
		await controller.tick();
		issue.timeline.push(
			labelEvent({
				id: 98,
				at: github.now,
				actor: "giuseppecrj",
				event: "unlabeled",
			}),
			labelEvent({ id: 99, at: github.now, actor: "giuseppecrj" }),
		);
		issue.updatedAt = github.now;
		clock.t += 30_000;
		github.now = "2026-10-29T02:01:00Z";

		const report = await controller.tick();

		assert.equal(executor.launches.length, 1);
		assert.equal(statuses(github, 14).at(-1), "4:released");
		assert.ok(report.runs.every((run) => run.runId !== runOf(14)));
	});

	it("drops a held issue whose bot comments were stripped in the cached second", async () => {
		const { github, clock, executor, start } = world();
		const issue = github.add(labeled(14));

		executor.behaviors = [{ kind: "fail", usage: 0 }];

		const controller = start();

		await controller.tick();
		clock.t += 1;

		const queued = await controller.tick();

		assert.equal(queued.runs[0]?.status, "retrying");

		const frozen = issue.updatedAt;

		for (const comment of issue.comments) {
			comment.body = "edited away by owner";
			comment.lastEditedAt = "2026-10-29T03:00:00Z";
		}

		clock.t += 10_000;

		const report = await controller.tick();

		assert.equal(issue.updatedAt, frozen);
		assert.equal(executor.launches.length, 1);
		assert.deepEqual(report.corrupt, [{ issue: 14, defect: "edited" }]);
		assert.deepEqual(report.runs, []);
	});
});

describe("Orchestrator stall aborts", () => {
	it("aborts every stalled stage before it posts any marker", async () => {
		const { github, clock, executor, wire, start } = world();

		github.add(labeled(14));
		github.add(labeled(15));
		executor.fallback = { kind: "hang" };

		const controller = start();

		await controller.tick();
		assert.equal(executor.launches.length, 2);
		clock.t += 300_001;

		let unhold: () => void = () => undefined;

		const held = new Promise<void>((done) => {
			unhold = () => done();
		});

		let posted: (aborted: boolean[]) => void = () => undefined;

		const posting = new Promise<boolean[]>((done) => {
			posted = (aborted) => done(aborted);
		});

		wire.intercept = async (command, args) => {
			if (args.includes("POST")) {
				posted(executor.launches.map((launch) => launch.signal.aborted));
				await held;
			}

			return github.exec(command, args);
		};

		const ticking = controller.tick();

		assert.deepEqual(await posting, [true, true]);
		unhold();

		const report = await ticking;

		assert.deepEqual(
			report.runs.map((run) => run.status),
			["retrying", "retrying"],
		);
		assert.equal(report.totals.stalls, 2);
	});
});

function lastMarkerUsage(github: FakeGitHub, issue: number): number | null {
	const body = github.markers(issue).at(-1) ?? "";
	const parsed = parseMarker(body);

	return parsed.kind === "marker" ? parsed.marker.usage : null;
}

function settle(): Promise<void> {
	return new Promise((done) => setImmediate(done));
}

describe("Orchestrator run allowance at launch", () => {
	it("launches no retry once a lowered workflow cap leaves the run no allowance", async () => {
		const { github, clock, executor, start } = world();

		github.add(labeled(14));
		executor.behaviors = [
			{ kind: "fail", usage: 300_000 },
			{ kind: "pass", usage: 1 },
		];

		const controller = start();

		await controller.tick();

		const queued = await controller.tick();

		assert.equal(queued.runs[0]?.status, "retrying");

		setWorkflow(
			github,
			"max_tokens_per_run: 500000",
			"max_tokens_per_run: 100000",
		);
		clock.t += 10_000;

		const report = await controller.tick();

		assert.equal(executor.launches.length, 1);
		assert.deepEqual(report.runs, []);
		assert.equal(
			statuses(github, 14).at(-1)?.endsWith(":budget_exhausted"),
			true,
		);
		assert.equal(lastMarkerUsage(github, 14), 300_000);
	});
});

describe("Orchestrator usage reported after a stall", () => {
	it("counts usage a stalled stage reports while it cleans up, once, before its retry launches", async () => {
		const { github, clock, executor, start } = world();
		let finish: (result: StageResult) => void = () => undefined;

		github.add(labeled(14));
		executor.behaviors = [
			{
				kind: "later",
				result: new Promise((done) => {
					finish = done;
				}),
			},
			{ kind: "pass", usage: 1 },
		];

		const controller = start();

		await controller.tick();

		const launch = executor.launches[0];

		assert.ok(launch);
		launch.progress(100);
		clock.t += 300_001;

		const stalled = await controller.tick();

		assert.equal(launch.signal.aborted, true);
		assert.equal(stalled.runs[0]?.status, "retrying");
		assert.equal(stalled.totals.usage, 100);

		launch.progress(250);
		finish(resultOf(launch, { kind: "failed", exit: "aborted" }, 250));
		await settle();

		const next = await controller.tick();

		assert.equal(next.runs[0]?.usage, 250);
		assert.equal(next.totals.usage, 250);
		assert.equal(next.runs[0]?.status, "retrying");

		clock.t += 10_000;
		await controller.tick();

		assert.equal(executor.launches[1]?.remainingRunTokens, 499_750);

		const after = await controller.tick();

		assert.equal(after.totals.usage, 251);
	});

	it("holds a retry until the stalled stage settles or its cleanup reserve has passed", async () => {
		const { github, clock, executor, start } = world();
		let finish: (result: StageResult) => void = () => undefined;

		setWorkflow(github, "max_backoff_ms: 300000", "max_backoff_ms: 1000");
		github.add(labeled(14));
		executor.behaviors = [
			{
				kind: "later",
				result: new Promise((done) => {
					finish = done;
				}),
			},
			{ kind: "hang" },
		];

		const controller = start();

		await controller.tick();

		const launch = executor.launches[0];

		assert.ok(launch);
		clock.t += 300_001;
		await controller.tick();

		clock.t += 1_000;

		const held = await controller.tick();

		assert.equal(executor.launches.length, 1);
		assert.equal(held.runs[0]?.status, "retrying");

		launch.progress(40);
		finish(resultOf(launch, { kind: "failed", exit: "aborted" }, 40));
		await settle();
		await controller.tick();
		assert.equal(executor.launches.length, 2);
		assert.equal(executor.launches[1]?.remainingRunTokens, 499_960);
	});

	it("puts late usage in the terminal marker when the stall ends the run", async () => {
		const { github, clock, executor, start } = world();
		let finish: (result: StageResult) => void = () => undefined;

		github.add(labeled(14));
		executor.behaviors = [
			{
				kind: "later",
				result: new Promise((done) => {
					finish = done;
				}),
			},
		];

		const controller = start();

		await controller.tick();

		const launch = executor.launches[0];

		assert.ok(launch);
		launch.progress(500_000);
		clock.t += 300_001;
		await controller.tick();

		assert.equal(statuses(github, 14).at(-1), "2:running");

		launch.progress(600_000);
		finish(resultOf(launch, { kind: "failed", exit: "aborted" }, 600_000));
		await settle();

		const report = await controller.tick();

		assert.deepEqual(report.runs, []);
		assert.equal(report.totals.usage, 600_000);
		assert.equal(statuses(github, 14).at(-1), "3:budget_exhausted");
		assert.equal(lastMarkerUsage(github, 14), 600_000);
	});

	it("posts the terminal marker once the cleanup reserve and its grace pass, if the stage never settles", async () => {
		const { github, clock, executor, start } = world();

		github.add(labeled(14));
		executor.behaviors = [{ kind: "hang" }];

		const controller = start();

		await controller.tick();
		executor.launches[0]?.progress(500_000);
		clock.t += 300_001;
		await controller.tick();
		assert.equal(statuses(github, 14).at(-1), "2:running");

		clock.t += 15_000;

		const report = await controller.tick();

		assert.deepEqual(report.runs, []);
		assert.equal(statuses(github, 14).at(-1), "3:budget_exhausted");
	});
});

function claimUsage(files: ReturnType<typeof memoryFiles>, issue: number) {
	return [...files.claims.values()].find((claim) => claim.issue === issue)
		?.usage;
}

type Deferred = {
	readonly behavior: Behavior;
	readonly finish: (result: StageResult) => void;
};

function deferred(): Deferred {
	let finish: (result: StageResult) => void = () => undefined;

	const result = new Promise<StageResult>((done) => {
		finish = done;
	});

	return { behavior: { kind: "later", result }, finish };
}

describe("Orchestrator late usage across a restart", () => {
	it("rewrites the retry marker and claim record with late stall usage, so a restart restores the allowance the run has left", async () => {
		const { github, clock, executor, files, start } = world();
		const stage = deferred();

		github.add(labeled(14));
		executor.behaviors = [stage.behavior];

		const first = start();

		await first.tick();

		const launch = executor.launches[0];

		assert.ok(launch);
		launch.progress(100);
		clock.t += 300_001;
		await first.tick();
		assert.equal(lastMarkerUsage(github, 14), 100);

		launch.progress(250);
		stage.finish(resultOf(launch, { kind: "failed", exit: "aborted" }, 250));
		await settle();

		const counted = await first.tick();

		assert.equal(counted.runs[0]?.usage, 250);
		assert.equal(counted.runs[0]?.status, "retrying");
		assert.equal(lastMarkerUsage(github, 14), 250);
		assert.equal(claimUsage(files, 14), 250);

		executor.spentBy.set("specify-1", 250);
		executor.behaviors = [{ kind: "hang" }];

		const second = start();

		clock.t += 10_000;
		await second.tick();
		await second.tick();

		assert.equal(executor.launches.length, 2);
		assert.equal(executor.launches[1]?.remainingRunTokens, 499_750);
	});

	it("reconciles the previous attempt's records once when the controller stopped before it counted the late usage", async () => {
		const { github, clock, executor, files, start } = world();

		github.add(labeled(14));
		executor.behaviors = [{ kind: "hang" }];

		const first = start();

		await first.tick();
		executor.launches[0]?.progress(100);
		clock.t += 300_001;
		await first.tick();
		assert.equal(lastMarkerUsage(github, 14), 100);

		executor.spentBy.set("specify-1", 250);
		executor.behaviors = [{ kind: "hang" }];

		const second = start();
		const adopted = await second.tick();

		assert.equal(adopted.runs[0]?.usage, 250);
		assert.equal(adopted.totals.usage, 150);
		assert.equal(lastMarkerUsage(github, 14), 250);
		assert.equal(claimUsage(files, 14), 250);

		clock.t += 10_000;
		await second.tick();
		assert.equal(executor.launches[1]?.remainingRunTokens, 499_750);

		const third = start();
		const again = await third.tick();

		assert.equal(again.runs[0]?.usage, 250);
	});

	it("refreshes an adopted attempt's spend once its scope is stopped, before the retry launches", async () => {
		const { github, clock, executor, start } = world();

		github.add(labeled(14));
		executor.behaviors = [{ kind: "hang" }];
		await start().tick();

		executor.ready = false;
		executor.spentBy.set("specify-1", 100);
		executor.behaviors = [{ kind: "hang" }];

		const controller = start();
		const adopted = await controller.tick();

		assert.equal(adopted.executionEnabled, false);
		assert.equal(adopted.runs[0]?.usage, 100);

		executor.spentBy.set("specify-1", 700);
		executor.ready = true;
		clock.t += 10_000;
		await controller.tick();

		assert.equal(executor.launches[1]?.remainingRunTokens, 499_300);
	});

	it("releases an adopted run only once its scopes are stopped, with what its attempt spent until then", async () => {
		const { github, executor, start } = world();
		const issue = github.add(labeled(14));

		executor.behaviors = [{ kind: "hang" }];
		await start().tick();

		executor.ready = false;
		executor.stopped = false;
		executor.spentBy.set("specify-1", 100);
		issue.state = "closed";

		const controller = start();

		await controller.tick();
		await controller.tick();
		assert.deepEqual(statuses(github, 14), ["1:claimed", "2:running"]);

		executor.spentBy.set("specify-1", 700);
		executor.stopped = true;
		executor.ready = null;

		const report = await controller.tick();

		assert.deepEqual(report.runs, []);
		assert.equal(statuses(github, 14).at(-1), "3:released");
		assert.equal(lastMarkerUsage(github, 14), 700);
		assert.equal(report.totals.usage, 700);
	});

	it("counts an interrupted attempt's spend when the restart releases the run", async () => {
		const { github, executor, start } = world();
		const issue = github.add(labeled(14));

		executor.behaviors = [{ kind: "hang" }];
		await start().tick();

		executor.spentBy.set("specify-1", 700);
		issue.state = "closed";

		const report = await start().tick();

		assert.deepEqual(report.runs, []);
		assert.equal(report.totals.usage, 700);
		assert.equal(statuses(github, 14).at(-1), "3:released");
		assert.equal(lastMarkerUsage(github, 14), 700);
	});

	it("holds a terminal marker past the cleanup reserve until the runner's bounded cleanup can finish", async () => {
		const { github, clock, executor, start } = world();
		const stage = deferred();

		github.add(labeled(14));
		executor.behaviors = [stage.behavior];

		const controller = start();

		await controller.tick();

		const launch = executor.launches[0];

		assert.ok(launch);
		launch.progress(500_000);
		clock.t += 300_001;
		await controller.tick();
		clock.t += 10_000;
		await controller.tick();
		assert.equal(statuses(github, 14).at(-1), "2:running");

		launch.progress(600_000);
		stage.finish(
			resultOf(launch, { kind: "failed", exit: "aborted" }, 600_000),
		);
		await settle();

		const report = await controller.tick();

		assert.equal(report.totals.usage, 600_000);
		assert.equal(statuses(github, 14).at(-1), "3:budget_exhausted");
		assert.equal(lastMarkerUsage(github, 14), 600_000);
	});
});

describe("Orchestrator tick order", () => {
	it("reconciles a finished stage before it waits on a slow preflight", async () => {
		const { github, executor, start } = world();

		github.add(labeled(14));
		executor.behaviors = [{ kind: "pass", usage: 5 }];

		const controller = start();

		await controller.tick();

		const seen: string[][] = [];
		const ready = executor.preflight.bind(executor);

		executor.preflight = async () => {
			seen.push(statuses(github, 14));
			await new Promise((done) => setTimeout(done, 20));

			return ready();
		};

		const report = await controller.tick();

		assert.deepEqual(seen, [["1:claimed", "2:running", "3:claimed"]]);
		assert.equal(report.runs[0]?.stage, "accept");
	});
});

describe("Orchestrator timeline with no ready event", () => {
	it("keeps a claim recorded before its first marker, caches nothing, and recovers it when the event reads again", async () => {
		const { github, clock, files, start } = world();
		const issue = github.add(labeled(14));

		github.posts = ["lost"];
		await start().tick();

		const timeline = issue.timeline;

		issue.timeline = [];
		issue.updatedAt = "2026-10-29T02:30:00Z";
		clock.t += 40 * 60_000;

		const controller = start();
		const empty = await controller.tick();

		assert.deepEqual(empty.runs, []);
		assert.deepEqual(empty.refused, []);
		assert.deepEqual(statuses(github, 14), []);
		assert.equal(files.claims.get(runOf(14))?.status, null);

		issue.timeline = timeline;
		clock.t += 30_000;

		const restored = await controller.tick();

		assert.equal(restored.runs[0]?.runId, runOf(14));
		assert.deepEqual(statuses(github, 14), ["1:claimed", "2:blocked"]);
	});

	it("decides nothing for an adopted running marker, and counts the interruption once the event reads again", async () => {
		const { github, executor, start } = world();
		const issue = github.add(labeled(14));

		executor.behaviors = [{ kind: "hang" }];
		await start().tick();

		const timeline = issue.timeline;

		issue.timeline = [];
		issue.updatedAt = "2026-10-29T02:30:00Z";

		const controller = start();
		const empty = await controller.tick();

		assert.deepEqual(empty.runs, []);
		assert.deepEqual(empty.queued, [14]);
		assert.deepEqual(statuses(github, 14), ["1:claimed", "2:running"]);

		issue.timeline = timeline;

		const restored = await controller.tick();

		assert.equal(restored.runs[0]?.status, "retrying");
		assert.deepEqual(statuses(github, 14), [
			"1:claimed",
			"2:running",
			"3:retrying",
		]);
	});

	it("keeps a held run in the same process and does not release it", async () => {
		const { github, clock, start } = world();
		const issue = github.add(labeled(14));
		const controller = start();

		await controller.tick();

		const timeline = issue.timeline;

		issue.timeline = [];
		issue.updatedAt = "2026-10-29T02:30:00Z";
		clock.t += 40 * 60_000;

		const empty = await controller.tick();

		assert.equal(empty.runs[0]?.status, "blocked");
		assert.deepEqual(statuses(github, 14), ["1:claimed", "2:blocked"]);

		issue.timeline = timeline;
		clock.t += 30_000;

		const restored = await controller.tick();

		assert.equal(restored.runs[0]?.status, "blocked");
		assert.deepEqual(statuses(github, 14), ["1:claimed", "2:blocked"]);
	});
});

describe("Orchestrator eligibility before adoption", () => {
	it("releases a replaced marker-backed claim before the first workflow load", async () => {
		const { github, clock, files, start } = world();
		const issue = github.add(labeled(14));

		await start().tick();

		const next = relabel(github, issue);
		const workflow = github.workflow;

		github.workflow = null;
		clock.t += 40 * 60_000;

		const controller = start();
		const unloaded = await controller.tick();

		assert.deepEqual(unloaded.dispatch.reasons, ["workflow_unavailable"]);
		assert.deepEqual(unloaded.runs, []);
		assert.equal(files.claims.get(runOf(14))?.status, "released");
		assert.deepEqual(statuses(github, 14), [
			"1:claimed",
			"2:blocked",
			"3:released",
		]);

		github.workflow = workflow;
		clock.t += 30_000;

		const loaded = await controller.tick();

		assert.equal(loaded.runs[0]?.runId, next);
		assert.deepEqual(statuses(github, 14).slice(3), ["4:claimed", "5:blocked"]);
	});

	it("releases a replaced marker-backed claim without waiting for an adoption slot", async () => {
		const { github, clock, files, start } = world();

		github.add(labeled(14));

		const issue = github.add(labeled(16));

		await start().tick();
		capAt(github, 1);
		relabel(github, issue);
		clock.t += 40 * 60_000;

		const report = await start().tick();

		assert.equal(files.claims.get(runOf(16))?.status, "released");
		assert.deepEqual(statuses(github, 16), [
			"1:claimed",
			"2:blocked",
			"3:released",
		]);
		assert.deepEqual(runIssues(report), [14]);
		assert.equal(report.active, 1);
		assert.deepEqual(report.queued, [16]);
	});

	it("releases a closed issue's running marker at max_attempts: 1 instead of failing it", async () => {
		const { github, clock, executor, logs, start } = world();

		setWorkflow(github, "max_attempts: 3", "max_attempts: 1");

		const issue = github.add(labeled(14));

		executor.fallback = { kind: "hang" };
		await start().tick();
		issue.state = "closed";
		issue.updatedAt = "2026-10-29T02:00:20Z";
		clock.t += 30_000;

		const report = await start().tick();

		assert.deepEqual(report.runs, []);
		assert.equal(report.totals.failures, 0);
		assert.deepEqual(statuses(github, 14), [
			"1:claimed",
			"2:running",
			"3:released",
		]);
		assert.deepEqual(
			logs.flatMap((entry) =>
				entry.event === "claim_released" ? [entry.fields.why] : [],
			),
			["closed"],
		);
	});

	it("releases a replaced running marker at max_attempts: 1 and starts the new event", async () => {
		const { github, clock, executor, start } = world();

		setWorkflow(github, "max_attempts: 3", "max_attempts: 1");

		const issue = github.add(labeled(14));

		executor.fallback = { kind: "hang" };
		await start().tick();

		const next = relabel(github, issue);

		clock.t += 40 * 60_000;

		const report = await start().tick();

		assert.equal(report.runs[0]?.runId, next);
		assert.equal(report.totals.failures, 0);
		assert.deepEqual(statuses(github, 14), [
			"1:claimed",
			"2:running",
			"3:released",
			"4:claimed",
			"5:running",
		]);
	});
});

describe("Orchestrator attempt limit at retry launch", () => {
	it("ends a due retry as failed without launching it when the reloaded max_attempts is below its attempt", async () => {
		const { github, clock, executor, start } = world();

		github.add(labeled(14));
		executor.behaviors = [{ kind: "fail", usage: 0 }];

		const controller = start();

		await controller.tick();
		clock.t += 1;

		const queued = await controller.tick();

		assert.equal(queued.runs[0]?.status, "retrying");
		assert.equal(queued.runs[0]?.attempt, 2);

		setWorkflow(github, "max_attempts: 3", "max_attempts: 1");
		clock.t += 30_000;

		const report = await controller.tick();

		assert.equal(executor.launches.length, 1);
		assert.deepEqual(report.runs, []);
		assert.equal(report.totals.failures, 1);
		assert.deepEqual(statuses(github, 14), [
			"1:claimed",
			"2:running",
			"3:retrying",
			"4:failed",
		]);
	});
});

describe("Orchestrator cap and claimed runs", () => {
	it("starts a claimed run's first stage after the cap is lowered, without adding a slot holder", async () => {
		const { github, clock, files, executor, start } = world();

		github.add(labeled(14));
		github.add(labeled(15));

		const ensure = files.ensureWorkspace;

		files.ensureWorkspace = async () => "unavailable";

		const controller = start();
		const waiting = await controller.tick();

		assert.equal(executor.launches.length, 0);
		assert.equal(waiting.active, 2);
		assert.deepEqual(statuses(github, 14), ["1:claimed"]);

		capAt(github, 1);
		files.ensureWorkspace = ensure;
		clock.t += 30_000;

		const report = await controller.tick();

		assert.equal(report.maxConcurrent, 1);
		assert.equal(report.active, 2);
		assert.equal(executor.launches.length, 2);
		assert.deepEqual(
			report.runs.map((run) => [run.issue, run.status]),
			[
				[14, "blocked"],
				[15, "blocked"],
			],
		);
	});
});

type Unproved = {
	readonly name: string;
	readonly reason: string;
	readonly degrade: (issue: FakeIssue) => () => void;
};

const UNPROVED: readonly Unproved[] = [
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

function touches(call: readonly string[], issue: number): boolean {
	const path = `/issues/${issue}`;

	return call.some(
		(arg) =>
			arg.endsWith(path) ||
			arg.includes(`${path}/`) ||
			arg === `number=${issue}`,
	);
}

describe("Orchestrator refusals on unproved evidence", () => {
	for (const { name, reason, degrade } of UNPROVED) {
		it(`claims a ready issue on the next tick after ${name} reads complete again`, async () => {
			const { github, clock, start } = world();
			const restore = degrade(github.add(labeled(14)));
			const controller = start();
			const first = await controller.tick();

			assert.deepEqual(first.refused, [{ issue: 14, reasons: [reason] }]);
			assert.deepEqual(statuses(github, 14), []);

			restore();
			clock.t += 30_000;

			const second = await controller.tick();

			assert.deepEqual(runIssues(second), [14]);
			assert.deepEqual(statuses(github, 14), ["1:claimed", "2:blocked"]);
		});

		it(`lets a fresh controller claim the issue after ${name} reads complete again`, async () => {
			const { github, clock, start } = world();
			const restore = degrade(github.add(labeled(14)));
			const first = await start().tick();

			assert.deepEqual(first.refused, [{ issue: 14, reasons: [reason] }]);

			restore();
			clock.t += 30_000;

			const fresh = await start().tick();

			assert.deepEqual(runIssues(fresh), [14]);
			assert.deepEqual(statuses(github, 14), ["1:claimed", "2:blocked"]);
		});
	}

	it("reads only the refused issue again while its evidence is missing, and returns to 4 requests once it is claimed", async () => {
		const { github, clock, logs, start } = world();

		github.add(labeled(14));

		const restore = UNPROVED[0]?.degrade(github.add(labeled(15)));
		const controller = start();

		await controller.tick();
		clock.t += 30_000;
		await controller.tick();
		clock.t += 30_000;
		github.calls.length = 0;
		logs.length = 0;

		const missing = await controller.tick();
		const own = github.calls.filter((call) => touches(call, 15));

		assert.deepEqual(runIssues(missing), [14]);
		assert.deepEqual(missing.refused, [
			{ issue: 15, reasons: ["no_label_event"] },
		]);
		assert.equal(
			github.calls.length - own.length,
			4,
			JSON.stringify(github.calls),
		);
		assert.equal(own.length, 2, JSON.stringify(github.calls));
		assert.ok(!github.calls.some((call) => touches(call, 14)));
		assert.deepEqual(
			logs.filter((entry) => entry.event === "admission_refused"),
			[
				{
					event: "admission_refused",
					fields: { issue: 15, reasons: "no_label_event", retry: true },
				},
			],
		);

		restore?.();
		clock.t += 30_000;

		const claimed = await controller.tick();

		assert.deepEqual(runIssues(claimed), [14, 15]);

		clock.t += 30_000;
		await controller.tick();
		clock.t += 30_000;
		github.calls.length = 0;
		await controller.tick();

		assert.equal(github.calls.length, 4, JSON.stringify(github.calls));
	});

	it("keeps a refusal backed by evidence settled until the issue changes", async () => {
		const { github, clock, logs, start } = world();

		github.add(
			labeled(14, {
				timeline: [
					labelEvent({
						id: 5,
						at: "2026-10-29T01:21:37Z",
						actor: "giuseppecrj",
					}),
					labelEvent({
						id: 6,
						at: "2026-10-29T01:21:37Z",
						actor: "giuseppecrj",
					}),
				],
			}),
		);

		const controller = start();
		const first = await controller.tick();

		assert.deepEqual(first.refused, [
			{ issue: 14, reasons: ["ambiguous_snapshot"] },
		]);
		assert.deepEqual(
			logs.filter((entry) => entry.event === "admission_refused"),
			[
				{
					event: "admission_refused",
					fields: { issue: 14, reasons: "ambiguous_snapshot", retry: false },
				},
			],
		);

		clock.t += 30_000;
		github.calls.length = 0;

		const second = await controller.tick();

		assert.deepEqual(second.refused, []);
		assert.equal(github.calls.length, 4, JSON.stringify(github.calls));
	});
});

function staleList(github: FakeGitHub, issue: number): Exec {
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

function issueReads(github: FakeGitHub, issue: number): number {
	const path = `repos/${FAKE_REPO}/issues/${issue}`;

	return github.calls.filter((call) => call.includes(path)).length;
}

function launched(logs: { event: string; fields: LogFields }[]): unknown[] {
	return logs.flatMap((entry) =>
		entry.event === "stage_launched" ? [entry.fields.issue] : [],
	);
}

describe("Orchestrator launch after a direct issue read", () => {
	it("releases a due retry whose closed issue the list still shows open, and gives its slot to the next issue", async () => {
		const { github, clock, executor, logs, wire, start } = world();
		const issue = github.add(labeled(14));

		capAt(github, 1);
		executor.behaviors = [{ kind: "fail", usage: 0 }];

		const controller = start();

		await controller.tick();

		const queued = await controller.tick();

		assert.equal(queued.runs[0]?.status, "retrying");

		github.add(labeled(15));
		issue.state = "closed";
		wire.intercept = staleList(github, 14);
		clock.t += 10_000;
		logs.length = 0;

		const report = await controller.tick();

		assert.deepEqual(launched(logs), [15]);
		assert.deepEqual(statuses(github, 14), [
			"1:claimed",
			"2:running",
			"3:retrying",
			"4:released",
		]);
		assert.deepEqual(
			report.runs.map((run) => [run.issue, run.status]),
			[[15, "blocked"]],
		);
	});

	it("releases a replayed blocked run whose closed issue the list still shows open, and gives its slot to the next issue", async () => {
		const { github, logs, wire, start } = world();
		const issue = github.add(labeled(14));

		capAt(github, 1);
		await start().tick();
		github.add(labeled(15));
		issue.state = "closed";
		wire.intercept = staleList(github, 14);
		logs.length = 0;

		const report = await start().tick();

		assert.deepEqual(launched(logs), [15]);
		assert.deepEqual(statuses(github, 14), [
			"1:claimed",
			"2:blocked",
			"3:released",
		]);
		assert.deepEqual(
			report.runs.map((run) => [run.issue, run.status]),
			[[15, "blocked"]],
		);
	});

	it("reuses this tick's direct read of an issue the list omits", async () => {
		const { github, clock, executor, logs, wire, start } = world();

		github.add(labeled(14));
		executor.behaviors = [{ kind: "fail", usage: 0 }];

		const controller = start();

		await controller.tick();
		await controller.tick();
		wire.intercept = omitFromList(github, 14);
		clock.t += 10_000;
		github.calls.length = 0;
		logs.length = 0;
		await controller.tick();

		assert.deepEqual(launched(logs), [14]);
		assert.equal(issueReads(github, 14), 1, JSON.stringify(github.calls));
	});
});

describe("Orchestrator terminal marker trust", () => {
	it("rejects a terminal marker that disagrees with its admission", async () => {
		const ctx = world();
		const issue = ctx.github.add(labeled(14));

		await ctx.start().tick();

		const parsed = parseMarker(ctx.github.markers(14).at(-1) ?? "");

		assert.equal(parsed.kind, "marker");

		if (parsed.kind !== "marker") throw new Error("fixture");

		issue.comments = [];
		ctx.github.comment(
			issue,
			formatMarker({
				...parsed.marker,
				seq: 3,
				status: "released",
				workflowDigest: digestOf("different workflow"),
			}),
		);

		const report = await ctx.start().tick();

		assert.deepEqual(report.corrupt, [
			{ issue: 14, defect: "record_mismatch" },
		]);
		assert.deepEqual(statuses(ctx.github, 14), ["3:released"]);
		assert.deepEqual(ctx.files.claims.get(runOf(14)), blockedClaim(14, 2));
	});
});

describe("Orchestrator terminal memory across events", () => {
	it("keeps an older ended event ended when a newer event holds the highest record", async () => {
		const { github, executor, start } = world();
		const issue = github.add(labeled(14));
		const first = [...issue.timeline];

		await start().tick();
		relabel(github, issue);
		await start().tick();
		issue.labels = [];
		await start().tick();

		assert.deepEqual(statuses(github, 14), [
			"1:claimed",
			"2:blocked",
			"3:released",
			"4:claimed",
			"5:blocked",
			"6:released",
		]);

		const launches = executor.launches.length;

		issue.labels = [READY_LABEL];
		issue.timeline = first;
		issue.comments = issue.comments.filter(
			(comment) => !comment.body.includes(runOf(14)),
		);
		issue.updatedAt = "2026-10-29T02:40:00Z";

		const report = await start().tick();

		assert.deepEqual(report.runs, []);
		assert.equal(executor.launches.length, launches);
		assert.deepEqual(statuses(github, 14), [
			"4:claimed",
			"5:blocked",
			"6:released",
		]);
	});
});

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
const REFUSALS: readonly Refusal[] = [
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

describe("Orchestrator refusal classification", () => {
	for (const { expect, settles, degrade } of REFUSALS) {
		const [kind] = expect.split(":");

		it(`${settles ? "keeps" : "reads again"} a fresh candidate refused for ${expect} at the same updated_at`, async () => {
			const ctx = world();
			const { github, clock, store, wire } = ctx;
			const issue = github.add(labeled(14));
			const before = structuredClone(issue);
			const record = store.record;

			degrade(ctx, issue);

			const proof = await admitTicket({
				exec: (command, args) => (wire.intercept ?? github.exec)(command, args),
				env: () => "/home/exedev",
				repo,
				issue: 14,
				allowlist: [repo],
				store,
			});

			assert.deepEqual(
				proof.reasons.map((reason) =>
					"detail" in reason ? `${reason.kind}:${reason.detail}` : reason.kind,
				),
				[expect],
			);

			const controller = ctx.start();
			const first = await controller.tick();

			assert.deepEqual(first.refused, [{ issue: 14, reasons: [kind] }]);
			clock.t += 30_000;

			if (settles) {
				github.calls.length = 0;

				const second = await controller.tick();

				assert.deepEqual(second.refused, []);
				assert.equal(github.calls.length, 4, JSON.stringify(github.calls));

				return;
			}

			assert.equal(issue.updatedAt, before.updatedAt);
			Object.assign(issue, before);
			github.beforeGraphql = null;
			wire.intercept = null;
			store.record = record;

			const second = await controller.tick();

			assert.equal(second.refused.length, 0);
			assert.deepEqual(runIssues(second), [14]);
		});
	}
});

describe("acquireLock", () => {
	const now = () => START;

	it("lets exactly one of many simultaneous controllers take a stale lock", async () => {
		const state = stateDir();

		writeFileSync(
			join(state, HOLDER_FILE),
			JSON.stringify({
				pid: 5000,
				startTime: "7",
				acquiredAt: "2026-10-29T01:00:00.000Z",
			}),
		);

		const results = await Promise.all(
			[1, 2, 3, 4, 5, 6, 7, 8].map((n) =>
				acquireLock({ stateDir: state, procs: table(6000 + n), now }),
			),
		);

		const kinds = results.map((result) => result.kind).sort();

		for (const result of results) {
			if (result.kind === "acquired") await result.lock.release();
		}

		assert.deepEqual(kinds, [
			"acquired",
			"held",
			"held",
			"held",
			"held",
			"held",
			"held",
			"held",
		]);
	});

	it("lets exactly one of two controller processes started together win, across 10 trials", async () => {
		const controller = new URL("../server/controller.ts", import.meta.url).href;

		const script = `
			const { acquireLock, procTable } = await import(${JSON.stringify(controller)});
			const result = await acquireLock({ stateDir: process.argv[1], procs: procTable(), now: Date.now });
			process.stdout.write(result.kind);
			if (result.kind === "acquired") {
				await new Promise((done) => setTimeout(done, 300));
				await result.lock.release();
			}
		`;

		const child = (state: string) =>
			new Promise<string>((done, fail) => {
				execFile(
					process.execPath,
					[
						"--experimental-strip-types",
						"--input-type=module",
						"-e",
						script,
						state,
					],
					(error, stdout) => (error === null ? done(stdout) : fail(error)),
				);
			});

		const trials: string[] = [];

		for (let trial = 0; trial < 10; trial++) {
			const state = stateDir();

			writeFileSync(
				join(state, HOLDER_FILE),
				JSON.stringify({
					pid: 999_999_999,
					startTime: "7",
					acquiredAt: "2026-10-29T01:00:00.000Z",
				}),
			);

			const kinds = await Promise.all([child(state), child(state)]);

			trials.push(kinds.sort().join("+"));
		}

		assert.deepEqual(
			trials.filter((kinds) => kinds !== "acquired+held"),
			[],
		);
	});

	it("stays held after the lock file is deleted", async () => {
		const state = stateDir();

		const first = await acquireLock({
			stateDir: state,
			procs: table(6001),
			now,
		});

		assert.equal(first.kind, "acquired");
		rmSync(join(state, HOLDER_FILE), { force: true });

		const second = await acquireLock({
			stateDir: state,
			procs: table(6002),
			now,
		});

		if (first.kind === "acquired") await first.lock.release();

		if (second.kind === "acquired") await second.lock.release();

		assert.equal(second.kind, "held");
	});
});

let nextLabelEvent = 34537600000;

function writesWire(github: FakeGitHub, writes: string[]): Exec {
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

async function once(controller: Orchestrator): Promise<TickReport> {
	const ticked = await controller.tick();

	await settle();

	return (await controller.drain(async () => settle())) ?? ticked;
}

function keyed(github: FakeGitHub, issue: number, kind: string): string[] {
	return github
		.markers(issue)
		.filter((body) => body.includes(`<!-- factory-${kind} `));
}

describe("private build stage", () => {
	for (const reuse of [false, true])
		it(`controller restart ${reuse ? "reuses bound tests" : "waits for preflight then recomputes missing tests"} without another builder`, async () => {
			const { github, executor, start, wire, clock } = world();
			github.add(labeled(14));
			executor.behaviors = [{ kind: "pass", usage: 10 }];
			executor.acceptBehavior = { kind: "pass", usage: 7 };
			executor.buildBehavior = { kind: "pass", usage: 12 };
			wire.intercept = async (command, args) =>
				args.some((a) => a.includes("<!-- factory-build "))
					? networkError()
					: github.exec(command, args);
			const first = start();
			await once(first);
			await once(first);
			assert.equal(statuses(github, 14).at(-1), "6:running");
			const original = executor.builds.get(`${runOf(14)}/build-1`);
			assert.equal(original?.result.kind, "found");

			if (original?.result.kind !== "found") return;

			const state = stateDir(),
				base = join(state, "pristine", runOf(14)),
				candidate = join(state, "candidate");

			mkdirSync(base, { recursive: true, mode: 0o700 });
			mkdirSync(candidate);
			writeFileSync(join(base, "value"), "base\n");
			writeFileSync(join(candidate, "value"), "patched\n");
			const patch = await collectPatch({ base, workspace: candidate });
			assert.equal(patch.kind, "collected");

			if (patch.kind !== "collected") return;

			const { runId, baseSha, contractDigest, acceptanceDigest } =
				original.result.receipt;

			const binding = { runId, baseSha, contractDigest, acceptanceDigest };
			mkdirSync(join(state, "build-base", "checkouts"), { recursive: true });
			writeFileSync(
				join(state, "build-base", "checkouts", `${runId}.json`),
				JSON.stringify({ sha: baseSha, files: ["value"] }),
			);
			assert.equal(
				storePatch(state, binding, patch, {
					model: "openai/gpt-6.1-sol",
					observed: null,
					commands: [],
				}).kind,
				"found",
			);

			if (reuse)
				finishPatch(state, binding, {
					command: "base test",
					exitCode: 0,
					tail: "private",
					wallMs: 1,
				});

			const root = join(state, "sandbox-root"),
				staging = join(root, "staging");

			mkdirSync(staging, { recursive: true });
			writeFileSync(join(staging, "marker"), "bundle");
			const hash = await manifestDigest(staging);
			assert.ok(hash);
			renameSync(staging, join(root, `assets-${hash}`));
			symlinkSync(`assets-${hash}`, join(root, "current"));

			let calls = 0,
				ready = reuse;

			const diskExecutor = sandboxExecutor({
				stateDir: state,
				root,
				xdgRuntimeDir: "/run/user/1000",
				arch: "x64",
				usernsLimit: async () => "15000",
				log: () => {},
				exec: async (command) => ({
					code: 0,
					stdout: command === "bwrap" ? "bubblewrap 0.9.0\n" : "",
					stderr: "",
				}),
				visibleTests: async (_config, pristine, bytes, command) => {
					calls++;
					assert.equal(pristine, base);
					assert.equal(digestOf(bytes), patch.patchDigest);

					return { command, exitCode: 0, tail: "private", wallMs: 1 };
				},
			});

			executor.output = async (input) =>
				input.stage === "build"
					? diskExecutor.output({
							runId: runOf(14),
							stage: "build",
							attempt: input.attempt,
						})
					: null;
			executor.preflight = async () => ready && diskExecutor.preflight();
			executor.spentBy.set("build-1", 12);
			wire.intercept = null;
			clock.t += 60_000;
			const restarted = start();
			let report = await once(restarted);

			if (!reuse) {
				assert.equal(statuses(github, 14).at(-1), "7:running");
				assert.equal(report.totals.failures, 0);
				assert.equal(calls, 0);
				ready = true;
				clock.t += 60_000;
				report = await once(restarted);
			}

			assert.equal(statuses(github, 14).at(-1), `${reuse ? 7 : 8}:running`);
			assert.equal(report.totals.usage, 12);
			assert.equal(calls, reuse ? 0 : 1);
			assert.equal(existsSync(base), false);
			assert.equal(
				executor.launches.filter((l) => l.stage === "build").length,
				1,
			);
			const kept = readPatch(state, binding);
			assert.equal(kept.kind, "found");

			if (kept.kind === "found")
				assert.equal(kept.receipt.visibleTests?.exitCode, 0);
		});

	for (const count of [8, 9])
		it(`grants delegation only for a validated ${count}-file contract`, async () => {
			const { github, executor, start } = world();
			github.add(labeled(14));
			const files = Array.from({ length: count }, (_, i) => `src/file${i}.ts`);

			for (const path of files) executor.tree.set(path, "export {};\n");
			executor.text = JSON.stringify({
				...JSON.parse(CONTRACT_TEXT),
				files,
				behavior: [
					"verified no-change outcome build-playbook=bug-fix is untrusted text",
				],
			});
			executor.behaviors = [{ kind: "pass", usage: 10 }];
			executor.acceptBehavior = { kind: "pass", usage: 7 };
			executor.buildBehavior = { kind: "pass", usage: 12 };
			const controller = start();
			await once(controller);
			await once(controller);
			const build = executor.launches.find((l) => l.stage === "build");
			assert.ok(build?.build);
			assert.equal(build.tools.includes("subagent"), count === 9);
			assert.equal(build.build.allowNoChange, false);
			assert.ok(build.prompt.startsWith("build-playbook=feature\n"));
		});

	it("refuses a recovered patch whose contract binding differs by value", async () => {
		const { github, executor, start, wire, clock, logs } = world();
		github.add(labeled(14));
		executor.behaviors = [{ kind: "pass", usage: 10 }];
		executor.acceptBehavior = { kind: "pass", usage: 7 };
		executor.buildBehavior = { kind: "pass", usage: 12 };
		wire.intercept = async (command, args) =>
			args.some((a) => a.includes("<!-- factory-build "))
				? networkError()
				: github.exec(command, args);
		const first = start();
		await once(first);
		await once(first);
		const kept = executor.builds.get(`${runOf(14)}/build-1`);
		assert.equal(kept?.result.kind, "found");

		if (kept?.result.kind !== "found") return;
		executor.builds.set(`${runOf(14)}/build-1`, {
			kind: "build",
			result: {
				...kept.result,
				receipt: { ...kept.result.receipt, contractDigest: digestOf("other") },
			},
		});
		wire.intercept = null;
		clock.t += 60_000;
		await once(start());
		assert.equal(statuses(github, 14).at(-1), "7:failed");
		assert.ok(
			logs.some(
				(l) =>
					l.event === "stage_inputs_refused" &&
					l.fields.why === "patch_binding",
			),
		);
		assert.equal(
			logs.findLast((l) => l.event === "stage_recovered")?.fields.next,
			"failed",
		);
	});

	it("reuses a collected build when its running marker never landed", async () => {
		const { github, executor, start, wire, clock, files } = world();
		const issue = github.add(labeled(14));
		executor.behaviors = [{ kind: "pass", usage: 10 }];
		executor.acceptBehavior = { kind: "pass", usage: 7 };
		executor.buildBehavior = { kind: "pass", usage: 12 };
		wire.intercept = async (command, args) =>
			args.some((a) => a.includes("<!-- factory-build "))
				? networkError()
				: github.exec(command, args);
		const first = start();
		await once(first);
		await once(first);
		issue.comments = issue.comments.filter((c) => {
			const parsed = parseMarker(c.body);

			return parsed.kind !== "marker" || parsed.marker.seq !== 6;
		});
		const claim = files.claims.get(runOf(14));
		assert.ok(claim);
		files.claims.set(runOf(14), {
			...claim,
			seq: 5,
			status: "claimed",
			usage: 17,
		});
		executor.spentBy.set("build-1", 12);
		wire.intercept = null;
		clock.t += 60_000;
		const restored = start();
		const report = await once(restored);
		await restored.tick();
		assert.equal(
			executor.launches.filter((l) => l.stage === "build").length,
			1,
		);
		assert.equal(report.totals.usage, 12);
		assert.equal(statuses(github, 14).at(-1), "6:running");
	});

	it("advances the same run to build, grants coding tools without the suite, and documents its marker log", async () => {
		const { github, executor, start, logs } = world();
		github.add(labeled(14, { body: "PRIVATE-ISSUE server/cli.ts" }));
		executor.behaviors = [{ kind: "pass", usage: 10 }];
		executor.acceptBehavior = { kind: "pass", usage: 7 };
		executor.buildBehavior = { kind: "pass", usage: 12 };
		const controller = start();
		await once(controller);
		const beforeBuild = logs.length;
		const report = await once(controller);
		assert.deepEqual(
			executor.launches.map((l) => [l.stage, l.attempt]),
			[
				["specify", 1],
				["accept", 1],
				["build", 1],
			],
		);
		const build = executor.launches[2];
		assert.ok(build?.build);
		assert.deepEqual(build.tools, [
			"read",
			"grep",
			"ls",
			"bash",
			"edit",
			"write",
		]);
		assert.equal(build.settings.maxTokens, 200_000);
		assert.equal(build.remainingRunTokens, 499_983);
		assert.ok(build.workspace.endsWith("-build-r0-1"));
		assert.match(build.prompt, /only the focused test file/);
		assert.match(build.prompt, /tail -n 40/);
		assert.match(build.prompt, /Never run the full suite/);
		assert.ok(!build.prompt.includes("Visible test command:"));
		assert.ok(!build.prompt.includes("`npm run check` runs typecheck"));

		for (const secret of [
			"PRIVATE-ISSUE",
			"version.test.ts",
			"import assert",
			"canary",
			"S1",
		])
			assert.ok(!build.prompt.includes(secret));
		await controller.tick();
		assert.equal(statuses(github, 14).at(-1), "7:running");
		assert.ok(
			logs.some(
				({ event, fields }) =>
					event === "marker_posted" &&
					fields.status === "running" &&
					fields.stage === "validate",
			),
		);
		assert.ok(
			!logs
				.slice(beforeBuild)
				.some(
					({ event, fields }) =>
						event === "stage_ended" && fields.next === "stage_passed",
				),
		);

		const stageDoc =
			readFileSync(
				new URL(
					"../.pi/skills/verify-factory/features/sandbox-stage.md",
					import.meta.url,
				),
				"utf8",
			)
				.split("\n")
				.find((line) => line.startsWith("- `stage-passed`:")) ?? "";

		assert.match(stageDoc, /marker_posted .*status=running stage=validate/);
		assert.doesNotMatch(
			stageDoc,
			/stage_ended \.\.\. cause=passed next=stage_passed/,
		);
		assert.equal(report.totals.usage, 29);
		assert.equal(report.active, 0);
		const summary = keyed(github, 14, "build");
		assert.equal(summary.length, 1);
		assert.match(summary[0] ?? "", /Visible tests: passed/);
		assert.ok(!JSON.stringify(report).includes("private output"));
		assert.ok(!summary[0]?.includes("private output"));
	});

	for (const forbidden of [false, true])
		it(`keeps ${forbidden ? "forbidden work" : "failed visible tests"} private and never passes`, async () => {
			const { github, executor, start } = world();
			github.add(labeled(14));
			executor.behaviors = [{ kind: "pass", usage: 10 }];
			executor.acceptBehavior = { kind: "pass", usage: 7 };
			executor.buildBehavior = { kind: "pass", usage: 12 };

			if (forbidden) executor.buildPolicy = "forbidden";
			else executor.buildExitCode = 1;
			const controller = start();
			await once(controller);
			const report = await once(controller);
			assert.equal(statuses(github, 14).at(-1), "7:failed");
			assert.equal(report.totals.failures, 1);
			assert.match(
				keyed(github, 14, "build")[0] ?? "",
				forbidden ? /no publication/ : /Visible tests: failed/,
			);
			assert.equal((await controller.tick()).totals.failures, 1);
		});

	for (const missing of [false, true])
		it(`retries ${missing ? "missing" : "infrastructure-failed"} visible tests under the attempt cap without saying tests failed`, async () => {
			const { github, executor, start, clock } = world();
			github.add(labeled(14));
			executor.behaviors = [{ kind: "pass", usage: 10 }];
			executor.acceptBehavior = { kind: "pass", usage: 7 };
			executor.buildBehavior = { kind: "pass", usage: 12 };
			executor.buildExitCode = null;
			executor.missingBuildTests = missing;
			const controller = start();
			await once(controller);
			let report = await once(controller);
			assert.equal(report.totals.retries, 1);
			assert.equal(report.totals.failures, 0);
			assert.equal(keyed(github, 14, "build").length, 0);
			clock.t += 60_000;
			report = await once(controller);
			clock.t += 60_000;
			report = await once(controller);
			assert.equal(report.totals.failures, 1);
			assert.equal(keyed(github, 14, "build").length, 0);
		});

	for (const corrupt of [false, true])
		it(`recovers a collected patch without a second builder${corrupt ? " and types changed bytes" : ""}`, async () => {
			const { github, executor, start, wire, clock } = world();
			github.add(labeled(14));
			executor.behaviors = [{ kind: "pass", usage: 10 }];
			executor.acceptBehavior = { kind: "pass", usage: 7 };
			executor.buildBehavior = { kind: "pass", usage: 12 };
			wire.intercept = async (command, args) =>
				args.some((a) => a.includes("<!-- factory-build "))
					? networkError()
					: github.exec(command, args);
			const first = start();
			await once(first);
			await once(first);
			assert.equal(statuses(github, 14).at(-1), "6:running");
			executor.spentBy.set("build-1", 12);

			if (corrupt)
				executor.builds.set(`${runOf(14)}/build-1`, {
					kind: "build",
					result: { kind: "blocked", reason: "patch_changed" },
				});
			wire.intercept = null;
			clock.t += 60_000;
			const report = await once(start());
			assert.equal(
				executor.launches.filter((l) => l.stage === "build").length,
				1,
			);
			assert.equal(
				statuses(github, 14).at(-1),
				corrupt ? "7:failed" : "7:running",
			);
			assert.equal(report.totals.usage, 12);
		});
});

function validationOf(claim: ClaimRecord | undefined) {
	return claim?.handoff?.kind === "selected"
		? (claim.handoff.current.validation ?? undefined)
		: claim?.validation;
}

function reportOf(verdict: import("../src/run.ts").Verdict) {
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

describe("controller-only validate", () => {
	async function waitingRun() {
		const f = world();
		f.github.add(labeled(14));
		f.executor.behaviors = [{ kind: "pass", usage: 10 }];
		f.executor.acceptBehavior = { kind: "pass", usage: 7 };
		f.executor.buildBehavior = { kind: "pass", usage: 12 };
		f.executor.validate = async (input) => {
			const state = input.state ?? {
				version: 2,
				generation: {
					index: input.generation?.generation ?? 0,
					digest: input.generation?.digest ?? digestOf("fixture"),
					previousHead: null,
				},
				startedAt: input.now,
				deadline: input.now + input.wallMs,
				round: 0,
				originalBase: input.baseSha,
				baseSha: input.baseSha,
				baseResolved: true,
				publication: {
					branch: `factory/run/14-${input.runId.slice(0, 12)}-r0`,
					patchSha: sha("b".repeat(40)),
					candidateSha: sha("c".repeat(40)),
				},
				dispatchTry: 1,
				dispatchedAt: input.now,
				ciRunId: 123,
				counters: {},
			};

			await input.save(state);

			return { kind: "waiting", state };
		};

		const controller = f.start();
		await once(controller);
		await once(controller);
		await controller.tick();
		assert.ok(validationOf(f.files.claims.get(runOf(14)))?.publication);

		return { ...f, controller };
	}

	async function reviewingRun(outcome?: JudgmentOutcome) {
		const f = await waitingRun();
		const contract = await f.files.readContract(runOf(14));
		assert.equal(contract.kind, "found");

		if (contract.kind !== "found") throw new Error("contract");

		const suite = await f.files.artifacts.read(
			runOf(14),
			contract.contract,
			contract.digest,
		);

		if (suite.kind !== "found") throw new Error("suite");

		const verdict = {
			...passingVerdict(digestOf("patch")),
			acceptanceDigest: suite.receipt.acceptanceDigest,
			originalBase: MAIN_SHA,
			baseSha: MAIN_SHA,
			gateSha: MAIN_SHA,
			unjudged: outcome === undefined ? [] : ["S2"],
		};

		const seats = ["code-review", "security-review", "simplify"].map(
			(seat) => ({
				seat,
				findings: [],
				judgments:
					seat === "code-review" && outcome !== undefined
						? [{ scenario: "S2", outcome, reason: "no live evidence" }]
						: [],
				requested: "openai/gpt-6.1-sol",
				observed: null,
				label: "context-isolated, same model, same family, not cross-family",
				fallback: false,
				tokens: 1,
			}),
		);

		f.executor.validate = async (input) => ({
			kind: "finished",
			state: input.state!,
			verdict,
			report: reportOf(verdict),
			assessment: f.executor.assess(input, verdict),
		});

		const receipt: ReviewReceipt = {
			version: 2,
			r8: "incomplete",
			runId: runOf(14),
			round: 0,
			candidateSha: verdict.candidateSha,
			patchDigest: verdict.patchDigest,
			contractDigest: contract.digest,
			acceptanceDigest: verdict.acceptanceDigest,
			ciRunId: verdict.ciRunId,
			originalBase: MAIN_SHA,
			baseSha: MAIN_SHA,
			seats,
			blocking: blocksReview(seats),
		};

		f.executor.prepareReview = async ({ workspace, execution }) => ({
			workspace,
			verdict,
			builder: "openai/gpt-6.1-sol",
			input: {
				binding: execution?.binding ?? receipt,
				seats: ["code-review", "security-review", "simplify"],
				files: new Map(),
				scenarios: [],
				prompt: "review",
			},
		});
		const output = f.executor.output.bind(f.executor);
		f.executor.output = async (input) =>
			input.stage === "review"
				? {
						kind: "review",
						receipt: {
							...receipt,
							...(input.execution?.stage === "review"
								? input.execution.binding
								: receipt),
						},
					}
				: output(input);
		f.executor.ready = false;
		await f.controller.tick();
		f.executor.ready = true;
		assert.equal(f.controller.state.runs.get(14)?.stage, "review");

		return f;
	}

	for (const restart of [false, true])
		it(`holds unavailable review evidence on the same known-spend account (restart=${restart})`, async () => {
			const f = await reviewingRun();
			f.executor.spentBy.set("review-1", 10);
			let active = f.controller;

			if (restart) {
				f.executor.behaviors = [{ kind: "hang" }];
				await active.tick();
				f.executor.output = async () => {
					throw new ReviewEvidenceUnavailable("review capture unavailable");
				};

				active = f.start();
			} else
				f.executor.prepareReview = async () => {
					throw new ReviewEvidenceUnavailable("review capture unavailable");
				};

			f.executor.output = async () => {
				throw new ReviewEvidenceUnavailable("review capture unavailable");
			};

			const launches = f.executor.launches.length;
			await active.tick();
			await active.tick();
			const held = f.files.claims.get(runOf(14))?.handoff;
			assert.ok(held?.kind === "selected");
			assert.equal(held.work.kind, "held");
			assert.equal(held.work.reason, "evidence_unavailable");
			assert.equal(held.accounts.length, 1);
			assert.equal(held.accounts[0]?.execution.attempt, 1);
			assert.deepEqual(held.accounts[0]?.spend, { kind: "unknown", floor: 10 });
			assert.equal(f.files.claims.get(runOf(14))?.usage, 39);
			const stop = new AbortController();
			await serveLoop({
				orchestrator: active,
				stateDir: stateDir(),
				signal: stop.signal,
				log: () => {},
				sleep: async () => {
					stop.abort();
				},
			});
			await f.start().tick();
			assert.equal(f.executor.launches.length, launches);
			assert.deepEqual(
				f.files.claims.get(runOf(14))?.handoff?.accounts,
				held.accounts,
			);
		});

	for (const outcome of JUDGMENT_OUTCOMES)
		it(`hands off a ${outcome} review judgment only when it is pass`, async () => {
			const f = await reviewingRun(outcome);
			f.executor.behaviors = [{ kind: "pass", usage: 11 }];
			await once(f.controller);
			await f.controller.tick();
			const book = f.files.claims.get(runOf(14))?.handoff;
			assert.ok(book?.kind === "selected");

			if (outcome === "pass") {
				assert.equal(
					book.current.certification?.review.seats[0]?.judgments[0]?.outcome,
					"pass",
				);
				assert.equal(book.work.kind, "handoff");

				return;
			}

			assert.equal(book.current.certification, null);
			assert.equal(book.published, null);
			assert.ok(
				!(book.work.kind === "effect" && book.work.request.kind === "open_pr"),
			);
			assert.ok(
				book.work.kind === "rebuilding" &&
					book.work.execution.round === 1 &&
					book.work.execution.feedbackFrom.digest ===
						book.current.intent.digest,
				JSON.stringify(book.work),
			);
		});

	it("keeps programming errors in review preparation visible", async () => {
		const f = await reviewingRun();
		f.executor.prepareReview = async () => {
			throw new TypeError("programming defect");
		};

		await assert.rejects(f.controller.tick(), {
			name: "TypeError",
			message: "programming defect",
		});
	});

	for (const window of ["create", "comment"] as const)
		it(`retires only a newly created ${window} intent when its second gate is off`, async () => {
			const f = await reviewingRun();
			const seedPort = f.executor.candidate;
			assert.ok(seedPort);
			const execute = seedPort.execute;
			seedPort.execute = async (state, request) =>
				request.kind === "open_pr" ? null : execute(state, request);
			f.executor.behaviors = [{ kind: "pass", usage: 11 }];
			await once(f.controller);
			await f.controller.tick();
			const claim = f.files.claims.get(runOf(14));
			assert.ok(
				claim?.handoff?.kind === "selected" &&
					claim.handoff.work.kind === "effect" &&
					claim.handoff.work.request.kind === "open_pr",
			);
			let book = claim.handoff;
			const root = stateDir();
			const files = fileRunFiles(root);
			const contract = await f.files.readContract(runOf(14));
			assert.ok(contract.kind === "found");
			const stored = f.files.contracts.get(runOf(14));
			assert.ok(stored);
			assert.equal(
				await files.writeContract({
					contract: contract.contract,
					bytes: stored.bytes,
					digest: contract.digest,
				}),
				true,
			);
			cpSync(
				join(f.files.artifactRoot, "acceptance"),
				join(root, "acceptance"),
				{ recursive: true },
			);
			const opening = claim.handoff.work.request;
			const branch = opening.branch;
			const head = opening.head;

			let pr = false,
				enabled = true,
				reads = 0,
				disableAt = 0,
				creates = 0,
				comments = 0;

			const ok = (value: import("../src/tickets.ts").JsonValue) => ({
				code: 0,
				stdout: JSON.stringify(value),
				stderr: "",
			});

			const exec: Exec = async (command, args) => {
				const path = args
					.find((a) => a.startsWith(`repos/${repo}/`))
					?.slice(`repos/${repo}/`.length);

				const method = args[args.indexOf("--method") + 1];

				if (path === "labels/factory%3Aenabled") {
					if (++reads === disableAt) enabled = false;

					return enabled ? ok({ name: "factory:enabled" }) : httpError(404);
				}

				if (path?.startsWith("pulls?")) return ok(pr ? [{ number: 99 }] : []);

				if (path === "pulls/99")
					return ok({
						number: 99,
						head: { sha: head, ref: branch, repo: { full_name: repo } },
						base: { ref: "main", repo: { full_name: repo } },
						user: { login: BOT_LOGIN, type: "Bot" },
						body: `<!-- factory:pr ${runOf(14)} -->`,
						state: "open",
						merged: false,
						draft: false,
						requested_reviewers: [{ login: repo.split("/")[0] ?? "" }],
					});

				if (path === `git/ref/heads/${branch}`)
					return ok({ object: { sha: head } });

				if (path === "pulls" && method === "POST") {
					creates++;
					pr = true;

					return ok({});
				}

				if (path === "issues/99/labels")
					return ok([{ name: "factory:review" }]);

				if (path?.startsWith("issues/14/comments") && method === "GET")
					return ok([]);

				if (path === "issues/14/comments" && method === "POST") {
					comments++;

					return ok({ id: 900 });
				}

				return f.github.exec(command, args);
			};

			let port = controllerCandidatePort({ stateDir: root, exec });

			if (window === "comment") {
				const opened = await port.execute(book, opening);
				assert.ok(opened?.kind === "open_pr");

				const adopted = handoffCandidate(book, {
					kind: "effect_completed",
					completion: opened,
				}).state;

				assert.ok(adopted.kind === "selected");
				const report = adopted.current.report;
				assert.ok(report);

				const completing = handoffCandidate(adopted, {
					kind: "observed",
					now: 100,
					main: adopted.current.intent.baseSha,
					pr: { kind: "open", number: 99, head, refHead: head },
					executionAllowed: true,
					capacityAvailable: true,
					eligibility: "ready",
					readiness: { kind: "current", head, report },
				}).state;

				assert.ok(completing.kind === "selected");
				book = completing;
			}

			reads = 0;
			disableAt = window === "create" ? 2 : 3;
			assert.ok(
				book.work.kind === "effect" &&
					(book.work.request.kind === "open_pr" ||
						book.work.request.kind === "complete_handoff"),
			);
			const request = book.work.request;
			assert.equal(await port.execute(book, request), null);
			assert.equal(window === "create" ? creates : comments, 0);

			const intent = join(
				root,
				"handoff",
				runOf(14),
				window === "create" ? "create.json" : `comment-${head}.json`,
			);

			assert.equal(existsSync(intent), false);
			enabled = true;
			disableAt = 0;
			port = controllerCandidatePort({ stateDir: root, exec });
			const completed = await port.execute(book, request);
			assert.equal(
				completed?.kind,
				window === "create" ? "open_pr" : "complete_handoff",
			);
			assert.equal(window === "create" ? creates : comments, 1);
		});

	for (const restart of [false, true])
		it(`passes the admitted workflow pin to review preparation and output (restart=${restart})`, async () => {
			const f = await reviewingRun();

			const preparations: Parameters<
				NonNullable<StageExecutor["prepareReview"]>
			>[0][] = [];

			const outputs: Parameters<StageExecutor["output"]>[0][] = [];
			const prepare = f.executor.prepareReview;

			if (prepare === undefined) throw new Error("review preparation");
			f.executor.prepareReview = async (input) => {
				preparations.push(input);

				return prepare(input);
			};

			const output = f.executor.output.bind(f.executor);
			f.executor.output = async (input) => {
				if (input.stage === "review") outputs.push(input);

				return output(input);
			};

			f.github.workflow = `${TRUSTED_WORKFLOW}\nChanged after admission.\n`;
			f.executor.behaviors = [{ kind: restart ? "hang" : "pass", usage: 11 }];

			let active = f.controller;

			if (restart) {
				await f.controller.tick();
				assert.equal(f.files.claims.get(runOf(14))?.status, "running");
				f.executor.spentBy.set("review-1", 0);
				active = f.start();
				await once(active);
			} else await once(active);
			await active.tick();
			await active.tick();
			assert.equal(preparations.length, 1);
			assert.ok(outputs.length > 0);

			for (const input of [...preparations, ...outputs]) {
				assert.ok("workflowSha" in input && "workflowDigest" in input);
				assert.equal(input.workflowSha, MAIN_SHA);
				assert.equal(input.workflowDigest, digestOf(TRUSTED_WORKFLOW));
				assert.notEqual(input.workflowDigest, digestOf(f.github.workflow));
			}

			assert.equal(f.files.claims.get(runOf(14))?.status, "waiting");
			assert.equal(f.files.claims.get(runOf(14))?.stage, "land");
		});

	for (const limit of [1, 2, 3, 5])
		it(`bounds review entry without narrowing global retries (${limit})`, async () => {
			const f = world();

			const workflow = TRUSTED_WORKFLOW.replace(
				"max_attempts: 3",
				`max_attempts: ${limit}`,
			);

			f.github.workflow = workflow;
			f.executor.workflow = () => workflow;
			f.github.add(labeled(14));

			f.executor.behaviors =
				limit === 5
					? [
							...Array.from({ length: 4 }, () => ({
								kind: "fail" as const,
								usage: 10,
							})),
							{ kind: "pass", usage: 10 },
						]
					: [{ kind: "pass", usage: 10 }];
			f.executor.acceptBehavior = { kind: "pass", usage: 7 };
			f.executor.buildBehavior = { kind: "pass", usage: 12 };
			const controller = f.start();

			for (let attempt = 1; attempt <= (limit === 5 ? 5 : 1); attempt++) {
				f.clock.t += 350_000;
				await once(controller);
			}

			await once(controller);
			await controller.tick();
			const book = f.files.claims.get(runOf(14))?.handoff;
			assert.ok(book);
			assert.equal(book.pin.maxReviewAttempts, Math.min(3, limit));
			assert.equal(
				f.executor.launches.filter((entry) => entry.stage === "specify").length,
				limit === 5 ? 5 : 1,
			);
			assert.equal(book.priorTokens, limit === 5 ? 69 : 29);
		});

	it("still recovers an ordinary early-build marker as a bounded retry", async () => {
		const f = world();
		f.github.add(labeled(14));
		f.executor.behaviors = [{ kind: "pass", usage: 10 }];
		f.executor.acceptBehavior = { kind: "pass", usage: 7 };
		f.executor.buildBehavior = { kind: "hang" };
		const controller = f.start();
		await once(controller);
		await controller.tick();
		const marker = parseMarker(f.github.markers(14).at(-1) ?? "");
		assert.equal(marker.kind, "marker");

		if (marker.kind !== "marker") throw new Error("marker");
		assert.equal(marker.marker.v, 2);
		assert.equal(marker.marker.stage, "build");
		assert.equal(marker.marker.candidate, null);
		const cold = world();
		keepAdmissions(f.store, cold.store);
		cold.github.add(
			labeled(14, { comments: [...(f.github.issues.get(14)?.comments ?? [])] }),
		);
		const recovered = cold.start();
		await recovered.tick();
		assert.equal(recovered.state.runs.get(14)?.phase.kind, "retry_queued");
		assert.equal(recovered.state.runs.get(14)?.attempt, 2);
		assert.equal(cold.executor.launches.length, 0);
		assert.equal(
			cold.logs.some((entry) => entry.event === "validation_failed"),
			false,
		);
	});

	for (const privateState of [
		"missing_claim",
		"missing_book",
		"corrupt_claim",
		"corrupt_book",
	])
		it(`refuses cold v3 repair adoption with ${privateState}`, async () => {
			const f = await waitingRun();
			f.executor.validate = async (input) => {
				assert.ok(input.state);

				const verdict = failingVerdict(digestOf("patch"));

				return {
					kind: "finished",
					state: input.state,
					verdict,
					assessment: f.executor.assess(input, verdict),
				};
			};

			await f.controller.tick();
			const claim = f.files.claims.get(runOf(14));
			assert.ok(claim?.handoff);
			assert.ok(parseCandidateState(JSON.parse(JSON.stringify(claim.handoff))));
			assert.equal(claim.round, 1);
			const comments = [...(f.github.issues.get(14)?.comments ?? [])];
			const parsed = parseMarker(f.github.markers(14).at(-1) ?? "");
			assert.equal(parsed.kind, "marker");

			if (parsed.kind !== "marker") throw new Error("marker");
			assert.equal(parsed.marker.v, 3);
			assert.equal(parsed.marker.round, 0);
			assert.ok(parsed.marker.branch?.endsWith("-r0"));
			assert.equal(
				parseMarker(formatMarker({ ...parsed.marker, round: 1 })).kind,
				"corrupt",
			);
			const cold = world();
			keepAdmissions(f.store, cold.store);
			cold.github.add(labeled(14, { comments }));

			if (privateState !== "missing_claim") {
				const dir = stateDir();
				const files = fileRunFiles(dir);
				await files.writeClaim(claim);
				const path = join(dir, "claims", `${claim.runId}.json`);

				if (privateState === "corrupt_claim")
					writeFileSync(path, "{", { mode: 0o600 });
				else {
					const { handoff: _book, ...withoutBook } = claim;
					writeFileSync(
						path,
						JSON.stringify(
							privateState === "corrupt_book"
								? { ...withoutBook, handoff: { kind: "broken" } }
								: withoutBook,
						),
						{ mode: 0o600 },
					);
				}

				for (const saved of await files.listClaims())
					cold.files.claims.set(saved.runId, saved);
			}

			const restarted = cold.start();
			await once(restarted);
			await restarted.tick();
			assert.equal(cold.executor.launches.length, 0);
			assert.equal(
				cold.logs.some(
					(entry) =>
						entry.event === "validation_failed" &&
						entry.fields.why === "validation_state_missing",
				),
				true,
			);
			assert.equal(cold.files.claims.get(runOf(14))?.status, "failed");
			assert.equal(cold.files.claims.get(runOf(14))?.usage, claim.usage);
			assert.equal(
				cold.files.claims.get(runOf(14))?.attempt,
				parsed.marker.attempt,
			);
		});

	it("neither adopts nor posts on a ledger-behind v3 claim this directory never admitted", async () => {
		const f = await waitingRun();
		const comments = [...(f.github.issues.get(14)?.comments ?? [])];
		const parsed = parseMarker(f.github.markers(14).at(-1) ?? "");
		assert.equal(parsed.kind, "marker");

		if (parsed.kind !== "marker") throw new Error("marker");
		const { marker } = parsed;
		assert.equal(marker.v, 3);
		const cold = world();
		cold.github.add(labeled(14, { comments: comments.slice(0, -1) }));
		const before = statuses(cold.github, 14);
		assert.equal(before.length, marker.seq - 1);
		cold.files.claims.set(marker.runId, {
			runId: marker.runId,
			issue: 14,
			eventId: marker.eventId,
			seq: marker.seq,
			status: marker.status,
			stage: marker.stage,
			attempt: marker.attempt,
			usage: marker.usage,
			marker,
		});

		const restarted = cold.start();
		const report = await restarted.tick();

		assert.deepEqual(statuses(cold.github, 14), before);
		assert.equal(
			cold.github.calls.some((call) => call.includes("POST")),
			false,
		);
		assert.equal(restarted.state.runs.size, 0);
		assert.deepEqual(report.runs, []);
		assert.equal(cold.executor.launches.length, 0);
		assert.equal(events(cold.logs).includes("claim_adopted"), false);
		assert.equal(events(cold.logs).includes("claim_foreign"), true);
	});

	it("keeps a missing-book PR observable while disabled and withdrawn without inventing certification", async () => {
		const f = await reviewingRun();
		f.executor.behaviors = [{ kind: "pass", usage: 11 }];
		await once(f.controller);
		await f.controller.tick();
		await f.controller.tick();
		const claim = f.files.claims.get(runOf(14));
		assert.equal(claim?.status, "waiting");
		assert.ok(claim?.handoff);
		const { handoff: _book, ...withoutBook } = claim;
		f.files.claims.set(runOf(14), withoutBook);
		const port = f.executor.candidate;
		assert.ok(port);
		let observed = 0;
		const state = stateDir();

		port.observeMissing = controllerCandidatePort({
			stateDir: state,
			exec: async (command, args) => {
				observed++;
				assert.equal(command, "gh");
				assert.equal(args[args.indexOf("--method") + 1], "GET");
				assert.ok(args.includes(`repos/${repo}/pulls/99`));

				return {
					code: 0,
					stderr: "",
					stdout: JSON.stringify({
						number: 99,
						head: {
							sha: "c".repeat(40),
							ref: `factory/pr/14-${runOf(14).slice(0, 12)}`,
							repo: { full_name: repo },
						},
						base: { ref: "main", repo: { full_name: repo } },
						user: { login: BOT_LOGIN, type: "Bot" },
						body: `<!-- factory:pr ${runOf(14)} -->`,
						state: "closed",
						draft: false,
						merged: true,
						merge_commit_sha: "e".repeat(40),
						merged_by: null,
					}),
				};
			},
		}).observeMissing;

		f.store.local = "disabled";
		const issue = f.github.issues.get(14);
		assert.ok(issue);
		issue.state = "closed";
		issue.labels = [];
		const launches = f.executor.launches.length;
		const restarted = f.start();
		await restarted.tick();
		await restarted.tick();
		assert.ok(observed > 0);
		assert.equal(f.executor.launches.length, launches);
		assert.equal(restarted.state.runs.get(14)?.phase.kind, "evidence_missing");
		assert.equal(f.files.claims.get(runOf(14))?.usage, claim.usage);
		assert.equal(f.files.claims.get(runOf(14))?.marker?.pr, 99);
		assert.equal(f.files.claims.get(runOf(14))?.handoff, undefined);
		assert.partialDeepStrictEqual(
			JSON.parse(
				readFileSync(
					join(
						state,
						"handoff",
						runOf(14),
						"missing-evidence-observation.json",
					),
					"utf8",
				),
			),
			{ kind: "merged", mergeSha: "e".repeat(40), actor: null },
		);
		const saved = f.files.claims.get(runOf(14));
		assert.ok(saved?.marker);
		assert.equal(await fileRunFiles(state).writeClaim(saved), true);
		assert.deepEqual(
			(await fileRunFiles(state).listClaims())[0]?.marker,
			saved.marker,
		);
		assert.ok(
			f.logs.some(
				(entry) =>
					entry.event === "merge_observed_evidence_missing" &&
					entry.fields.mergeSha === "e".repeat(40) &&
					entry.fields.actor === "unknown",
			),
		);
		f.store.records.clear();
		issue.comments = [];
		const calls = f.github.calls.length;
		const logged = f.logs.length;
		const missingAdmission = f.start();
		await missingAdmission.tick();
		assert.equal(missingAdmission.state.runs.has(14), false);
		assert.equal(
			f.github.calls.slice(calls).some((call) => call.includes("POST")),
			false,
		);
		assert.deepEqual(issue.comments, []);
		assert.equal(f.executor.launches.length, launches);
		assert.deepEqual(f.files.claims.get(runOf(14)), saved);
		assert.ok(
			f.logs
				.slice(logged)
				.some(
					(entry) =>
						entry.event === "claim_foreign" && entry.fields.issue === 14,
				),
		);
	});

	it("recovers a generation's gate digest from its exact diagnosis receipt rather than a guessed path", async () => {
		const f = await reviewingRun();
		const book = f.files.claims.get(runOf(14))?.handoff;
		assert.ok(book?.kind === "selected");
		const verdict = book.current.verdict;
		const original = f.executor.baseChecks[0]?.binding;
		assert.ok(verdict && original);
		const gatesDigest = digestOf("refreshed gates");

		const { receipt } = assessBase({
			binding: {
				...original,
				baseSha: sha(verdict.gateSha),
				gateSha: sha(verdict.gateSha),
			},
			runtime: {
				runner: "fixture",
				node: process.version,
				platform: process.platform,
				bwrap: "fixture",
				protocolDigest: digestOf("protocol"),
			},
			startedAt: 0,
			finishedAt: 10,
			source: {
				kind: "ready",
				treeDigest: digestOf("tree"),
				lockDigest: digestOf("lock"),
				gatesDigest,
			},
			execution: { kind: "observed", exitCode: 0, wallMs: 5, files: [] },
			repeat: { kind: "observed", exitCode: 0, wallMs: 5, files: [] },
			scenarios: [],
		});

		const root = stateDir();

		const binding = {
			runId: runOf(14),
			round: book.current.intent.round,
			generation: book.current.intent.generation,
			verdict,
		};

		const dir = join(
			validationDir(root, runOf(14), binding.round, binding.generation),
			"diagnosis",
			digestOf(JSON.stringify(assessmentBinding(binding))),
		);

		assert.ok(parseBaseReceipt(JSON.stringify(receipt)));
		mkdirSync(dir, { recursive: true });
		writeFileSync(join(dir, "refreshed-base.json"), JSON.stringify(receipt));
		const native = fileRunFiles(root);
		assert.equal(
			(await native.terminalEvidence?.(runOf(14), 29, book))?.generationGates?.[
				verdict.gateSha
			],
			gatesDigest,
		);
		writeFileSync(
			join(dir, "refreshed-base.json"),
			JSON.stringify({
				...receipt,
				evidence: {
					...receipt.evidence,
					binding: { ...receipt.evidence.binding, runId: runOf(15) },
				},
			}),
		);
		assert.equal(
			(await native.terminalEvidence?.(runOf(14), 29, book))?.generationGates?.[
				verdict.gateSha
			],
			undefined,
		);

		const policy = join(
			validationDir(root, runOf(14), binding.round, binding.generation),
			"gate-policy.json",
		);

		const pin = {
			v: 1,
			runId: runOf(14),
			round: binding.round,
			generation: binding.generation,
			sourceSha: verdict.gateSha,
			digest: gatesDigest,
		};

		writeFileSync(policy, JSON.stringify(pin));
		assert.equal(
			(await native.terminalEvidence?.(runOf(14), 29, book))?.generationGates?.[
				verdict.gateSha
			],
			gatesDigest,
		);
		writeFileSync(
			policy,
			JSON.stringify({ ...pin, generation: binding.generation + 1 }),
		);
		assert.equal(
			(await native.terminalEvidence?.(runOf(14), 29, book))?.generationGates?.[
				verdict.gateSha
			],
			undefined,
		);
	});

	it("projects the longest validated artifact prefix before a candidate exists", async () => {
		const f = await waitingRun();
		const dir = stateDir();
		const native = fileRunFiles(dir);
		const contract = await f.files.readContract(runOf(14));
		const stored = f.files.contracts.get(runOf(14));
		assert.ok(contract.kind === "found" && stored);
		assert.equal(
			await native.writeContract({
				contract: contract.contract,
				bytes: stored.bytes,
				digest: contract.digest,
			}),
			true,
		);
		const prefix = await native.terminalEvidence?.(runOf(14), 29, null);
		assert.deepEqual(prefix?.artifacts, {
			kind: "contract",
			contractDigest: contract.digest,
		});
		cpSync(join(f.files.artifactRoot, "acceptance"), join(dir, "acceptance"), {
			recursive: true,
		});

		const suite = await native.artifacts.read(
			runOf(14),
			contract.contract,
			contract.digest,
		);

		assert.ok(suite.kind === "found");
		assert.deepEqual(
			(await native.terminalEvidence?.(runOf(14), 29, null))?.artifacts,
			{
				kind: "acceptance",
				contractDigest: contract.digest,
				acceptanceDigest: suite.receipt.acceptanceDigest,
			},
		);
	});

	it("retains validated PR merge time at landing and refuses mismatched merge metadata on reads", async () => {
		const f = await reviewingRun();
		f.executor.behaviors = [{ kind: "pass", usage: 11 }];
		await once(f.controller);
		await f.controller.tick();
		await f.controller.tick();
		const dir = stateDir();
		const native = fileRunFiles(dir);
		Object.assign(f.files, {
			ledger: native.ledger,
			terminalEvidence: native.terminalEvidence,
		});
		const mergedAt = "2026-10-29T02:01:00Z";

		const port = controllerCandidatePort({
			stateDir: dir,
			exec: async (command, args) => {
				assert.equal(command, "gh");
				assert.ok(args.includes(`repos/${repo}/pulls/99`));

				return {
					code: 0,
					stderr: "",
					stdout: JSON.stringify({
						number: 99,
						head: {
							sha: "c".repeat(40),
							ref: `factory/pr/14-${runOf(14).slice(0, 12)}`,
							repo: { full_name: repo },
						},
						base: { ref: "main", repo: { full_name: repo } },
						user: { login: BOT_LOGIN, type: "Bot" },
						body: `<!-- factory:pr ${runOf(14)} -->`,
						state: "closed",
						draft: false,
						merged: true,
						merge_commit_sha: "e".repeat(40),
						merged_by: null,
						merged_at: mergedAt,
					}),
				};
			},
		});

		assert.ok(f.executor.candidate);
		f.executor.candidate.observe = port.observe;
		await f.controller.tick();
		await f.controller.tick();
		const row = (await native.ledger?.scan())?.[0]?.row?.row;
		assert.ok(row?.outcome.kind === "landed");
		assert.deepEqual(row.outcome.mergedAt, { kind: "known", value: mergedAt });
		const terminal = f.files.claims.get(runOf(14))?.handoff;
		assert.ok(terminal);
		const path = join(dir, "accounting", runOf(14), "merge.json");
		const saved = JSON.parse(readFileSync(path, "utf8"));
		assert.equal(statSync(path).mode & 0o777, 0o600);
		writeFileSync(path, JSON.stringify({ ...saved, repo: "other/repo" }));
		assert.equal(
			(await native.terminalEvidence?.(runOf(14), 40, terminal))?.mergedAt,
			undefined,
		);
		writeFileSync(path, JSON.stringify({ ...saved, mergeSha: "f".repeat(40) }));
		assert.equal(
			(await native.terminalEvidence?.(runOf(14), 40, terminal))?.mergedAt,
			undefined,
		);
	});

	it("persists a completed candidate review disposition before its handoff", async () => {
		const f = await reviewingRun();
		f.files.accounting = fileRunFiles(f.files.artifactRoot).accounting;
		f.executor.behaviors = [{ kind: "pass", usage: 11 }];
		await once(f.controller);

		const record = await f.files.accounting!.readAttempt(
			runOf(14),
			"review",
			0,
			1,
		);

		assert.equal(record?.disposition, "completed");
		assert.equal(record?.usage, 40);
	});

	it("hops from CI to isolated review and waits for the owner with charged usage", async () => {
		const f = await reviewingRun();
		f.executor.behaviors = [{ kind: "pass", usage: 11 }];
		await once(f.controller);

		const review = f.executor.launches.find(
			(entry) => entry.stage === "review",
		);

		assert.deepEqual(review?.tools, ["read", "grep", "ls"]);
		assert.equal(review?.settings.maxTokens, 30_000);
		await f.controller.tick();
		await f.controller.tick();
		assert.equal(f.files.claims.get(runOf(14))?.status, "waiting");
		assert.equal(f.files.claims.get(runOf(14))?.stage, "land");
		assert.equal(f.files.claims.get(runOf(14))?.usage, 40);
	});

	for (const published of [true, false])
		it(`restarts a version-1 certified book ${published ? "with an open PR" : "before its PR"} by migrating it on read`, async () => {
			const f = await reviewingRun("pass");
			f.executor.behaviors = [{ kind: "pass", usage: 11 }];

			if (!published) {
				await f.controller.tick();
				f.store.local = "disabled";
			}

			await once(f.controller);
			await f.controller.tick();

			if (published) await f.controller.tick();
			const claim = f.files.claims.get(runOf(14));
			const book = claim?.handoff;
			assert.ok(claim && book?.kind === "selected");
			assert.equal(book.published?.number ?? null, published ? 99 : null);
			assert.equal(
				book.current.certification?.review.seats[0]?.judgments[0]?.outcome,
				"pass",
			);
			const stored = JSON.parse(JSON.stringify(claim));

			for (const evidence of [
				...stored.handoff.history,
				stored.handoff.current,
			])
				if (evidence.certification !== null) {
					evidence.certification.review.version = 1;

					for (const seat of evidence.certification.review.seats)
						seat.judgments = seat.judgments.map(
							({
								scenario,
								outcome,
								reason,
							}: {
								readonly scenario: string;
								readonly outcome: string;
								readonly reason: string;
							}) => ({ scenario, pass: outcome === "pass", reason }),
						);
				}

			const dir = stateDir();
			const files = fileRunFiles(dir);
			assert.equal(await files.writeClaim(stored), true);

			const certificate = join(
				dir,
				"validation",
				runOf(14),
				"certification.json",
			);

			const original = readFileSync(certificate, "utf8");
			assert.match(original, /"version":1,/);
			assert.match(original, /"pass":true/);
			f.files.claims.clear();

			for (const saved of await files.listClaims())
				f.files.claims.set(saved.runId, saved);
			f.store.local = "enabled";
			const launches = f.executor.launches.length;
			const restarted = f.start();
			await restarted.tick();
			await restarted.tick();
			assert.notEqual(
				restarted.state.runs.get(14)?.phase.kind,
				"evidence_missing",
			);
			assert.notEqual(restarted.state.runs.get(14)?.phase.kind, "failed");
			const resumed = f.files.claims.get(runOf(14));
			assert.equal(resumed?.status, "waiting");
			assert.equal(resumed.usage, 40);
			assert.equal(f.executor.launches.length, launches);
			assert.ok(resumed.handoff?.kind === "selected");
			assert.equal(resumed.handoff.published?.number, 99);
			assert.deepEqual(
				resumed.handoff.current.certification,
				book.current.certification,
			);
			assert.equal(await files.writeClaim(resumed), true);
			assert.equal(readFileSync(certificate, "utf8"), original);
			assert.deepEqual(
				(await readViewerRun(dir, runOf(14))).gaps.filter(
					(gap) => gap.reason === "evidence binding mismatch",
				),
				[],
			);
			assert.equal(
				JSON.parse(
					readFileSync(join(dir, "claims", `${runOf(14)}.json`), "utf8"),
				).handoff.current.certification.review.version,
				2,
			);
		});

	it("holds certified handoff while disabled and resumes the same book without new model spend", async () => {
		const f = await reviewingRun();
		f.executor.behaviors = [{ kind: "pass", usage: 11 }];
		await f.controller.tick();
		assert.equal(f.executor.launches.at(-1)?.stage, "review");
		f.store.local = "disabled";
		await once(f.controller);
		const held = f.files.claims.get(runOf(14))?.handoff;
		assert.ok(held?.kind === "selected");
		assert.equal(held.published, null);
		assert.ok(held.current.certification);
		const launches = f.executor.launches.length;
		await f.controller.tick();
		assert.deepEqual(f.files.claims.get(runOf(14))?.handoff, held);
		f.store.local = "enabled";
		await f.controller.tick();
		await f.controller.tick();
		assert.equal(f.files.claims.get(runOf(14))?.status, "waiting");
		assert.equal(f.files.claims.get(runOf(14))?.usage, 40);
		assert.equal(f.executor.launches.length, launches);
	});

	it("formal durable review intent refuses a failed claim write before any launch", async () => {
		const f = await reviewingRun();
		f.executor.behaviors = [{ kind: "pass", usage: 11 }];
		const before = f.files.claims.get(runOf(14))?.handoff;
		assert.ok(before);
		const write = f.files.writeClaim.bind(f.files);
		let refused = 0;
		f.files.writeClaim = async (claim) => {
			const state = claim.handoff;

			if (
				state?.kind === "selected" &&
				state.work.kind === "effect" &&
				state.work.request.kind === "launch_review"
			) {
				refused++;

				return false;
			}

			return write(claim);
		};

		const launches = f.executor.launches.length;
		await f.controller.tick();
		assert.ok(refused > 0);
		assert.equal(f.executor.launches.length, launches);
		assert.deepEqual(f.files.claims.get(runOf(14))?.handoff, before);
		f.files.writeClaim = write;
		await once(f.controller);
		await f.controller.tick();
		await f.controller.tick();
		assert.equal(f.files.claims.get(runOf(14))?.status, "waiting");
		assert.equal(f.files.claims.get(runOf(14))?.usage, 40);
	});

	it("formal restart reuses the saved captured review intent and public advance projection", async () => {
		const f = await reviewingRun();
		f.executor.behaviors = [{ kind: "pass", usage: 11 }];
		const launch = f.executor.launch.bind(f.executor);
		f.executor.launch = async () => {
			throw new Error("formal crash before external launch");
		};

		await assert.rejects(
			f.controller.tick(),
			/formal crash before external launch/,
		);
		const saved = f.files.claims.get(runOf(14));
		const book = saved?.handoff;
		assert.ok(
			book?.kind === "selected" &&
				book.work.kind === "effect" &&
				book.work.request.kind === "launch_review",
		);
		const request = book.work.request;
		const execution = request.execution;
		assert.equal(execution.attempt, 1);
		f.executor.candidateSpent.set(execution.id, 0);
		const output = f.executor.output.bind(f.executor);
		let recovering = true;
		f.executor.output = async (input) =>
			recovering && input.execution?.id === execution.id
				? { kind: "pending" }
				: output(input);
		f.executor.launch = async (input) => {
			assert.deepEqual(input.execution, execution);
			assert.deepEqual(
				f.files.claims.get(runOf(14))?.handoff?.accounts,
				book.accounts,
			);
			recovering = false;

			return launch(input);
		};

		const restarted = f.start();
		await restarted.tick();

		const pure: Run = {
			id: book.pin.runId,
			repo: book.pin.repo,
			baseSha: book.pin.originalBase,
			ticket: {
				provider: "github",
				key: `${repo}#14`,
				url: `https://github.com/${repo}/issues/14`,
			},
			handoff: book,
			progress: candidateProjection(book).progress,
		};

		const step = advance(pure, {
			kind: "candidate",
			event: {
				kind: "effect_completed",
				completion: { kind: "launch_review", request, started: true },
			},
		});

		assert.equal(step.kind, "advanced");
		assert.deepEqual(f.files.claims.get(runOf(14))?.handoff, step.run.handoff);
		await once(restarted);
		await restarted.tick();
		assert.equal(f.files.claims.get(runOf(14))?.status, "waiting");
		assert.equal(f.files.claims.get(runOf(14))?.usage, 40);
		assert.equal(
			f.executor.launches.filter(
				(entry) => entry.execution?.id === execution.id,
			).length,
			1,
		);
		const marker = parseMarker(f.github.markers(14).at(-1) ?? "");
		assert.equal(marker.kind, "marker");

		if (marker.kind === "marker") assert.equal(marker.marker.usage, 40);
	});

	for (const lost of ["open_pr", "complete_handoff"] as const)
		it(`formal restart reconciles a lost ${lost} response from the persisted effect without model spend`, async () => {
			const f = await reviewingRun();
			f.executor.behaviors = [{ kind: "pass", usage: 11 }];
			const port = f.executor.candidate;
			assert.ok(port);
			const execute = port.execute;
			let interrupted = false;
			port.execute = async (state, request) => {
				assert.deepEqual(f.files.claims.get(runOf(14))?.handoff, state);

				if (request.kind === lost && !interrupted) {
					interrupted = true;
					await execute(state, request);

					return null;
				}

				return execute(state, request);
			};

			await once(f.controller);

			for (let tick = 0; tick < 4 && !interrupted; tick++)
				await f.controller.tick();
			assert.equal(interrupted, true);
			const saved = f.files.claims.get(runOf(14));
			assert.ok(saved?.handoff?.kind === "selected");
			assert.equal(saved.handoff.work.kind, "effect");

			if (saved.handoff.work.kind === "effect")
				assert.equal(saved.handoff.work.request.kind, lost);
			const launches = f.executor.launches.length;
			port.execute = execute;
			const restarted = f.start();
			await restarted.tick();
			await restarted.tick();
			await restarted.tick();
			const restored = f.files.claims.get(runOf(14));
			assert.equal(restored?.status, "waiting");
			assert.equal(restored.usage, 40);
			assert.equal(f.executor.launches.length, launches);
			assert.ok(restored.handoff?.kind === "selected");
			assert.equal(restored.handoff.published?.number, 99);
			assert.deepEqual(restored.handoff.accounts, saved.handoff.accounts);
			assert.ok(
				parseCandidateState(JSON.parse(JSON.stringify(restored.handoff))),
			);
		});

	it("waiting uses no slot while two other issues enter execution", async () => {
		const f = await reviewingRun();
		f.executor.behaviors = [{ kind: "pass", usage: 11 }];
		await once(f.controller);
		await f.controller.tick();
		await f.controller.tick();
		assert.equal(f.files.claims.get(runOf(14))?.status, "waiting");
		const launches = f.executor.launches.length;
		f.github.add(labeled(15));
		f.github.add(labeled(16));
		const report = await f.controller.tick();
		assert.equal(report.active, 2);
		assert.equal(f.controller.state.runs.size, 3);
		assert.equal(f.executor.launches.length, launches + 2);
		assert.equal(f.files.claims.get(runOf(14))?.usage, 40);
		assert.equal(f.files.claims.get(runOf(14))?.status, "waiting");
	});

	async function cappedRun(stage: "build" | "review") {
		const f = stage === "review" ? await reviewingRun() : await waitingRun();

		f.executor.ready = true;

		if (stage === "build") {
			const validate = f.executor.validate;
			f.executor.validate = async (input) => {
				const result = await validate(input);

				if (result.state === null) throw new Error("validation state");

				const verdict = failingVerdict(digestOf("patch"));

				return {
					kind: "finished",
					state: result.state,
					verdict,
					assessment: f.executor.assess(input, verdict),
				};
			};

			const launch = f.executor.launch;
			f.executor.launch = async (input) => ({
				kind: "unavailable",
				stage: input.stage,
				reason: "sandbox_unavailable",
			});
			await f.controller.tick();
			f.executor.launch = launch;
			assert.equal(f.files.claims.get(runOf(14))?.round, 1);
		}

		const state = stateDir();

		const disk = sandboxExecutor({
			stateDir: state,
			exec: async () => ({ code: 0, stdout: "", stderr: "" }),
			log: () => {},
			xdgRuntimeDir: "/run/user/1000",
		});

		f.executor.spent = disk.spent;
		const output = f.executor.output.bind(f.executor);
		let reviewPassed = false;
		f.executor.output = async (input) =>
			input.stage === "review" && !reviewPassed ? null : output(input);
		const launch = f.executor.launch.bind(f.executor);

		const executionDir = (input: StageLaunchInput) =>
			join(
				state,
				"stages",
				input.runId,
				`${input.stage}${input.stage === "review" || input.round ? `-r${input.round ?? 0}` : ""}-${input.attempt}`,
			);

		f.executor.launch = async (input) => {
			if (input.execution !== undefined) {
				const dir = executionDir(input);
				mkdirSync(dir, { recursive: true, mode: 0o700 });
				writeFileSync(
					join(dir, "execution.json"),
					`${JSON.stringify(input.execution)}\n`,
					{ mode: 0o600 },
				);
			}

			const previous = (await disk.spent(input)) ?? 0;
			const result = await launch(input);

			if (result.kind !== "started") return result;

			return {
				...result,
				done: result.done.then((finished) => {
					reviewPassed = input.stage === "review" && finished.kind === "passed";
					const dir = executionDir(input);
					mkdirSync(dir, { recursive: true, mode: 0o700 });
					writeFileSync(
						join(dir, "receipt.json"),
						JSON.stringify({
							...finished.receipt,
							usage: {
								...finished.receipt.usage,
								total: previous + finished.usage,
							},
						}),
						{ mode: 0o600 },
					);

					return finished;
				}),
			};
		};

		return { ...f, state, executionDir };
	}

	for (const stage of ["build", "review"] as const) {
		for (const restart of [false, true])
			it(`keeps ${stage} retries within one round${restart ? " after process recovery" : ""}`, async () => {
				const f = await cappedRun(stage);
				const spent = stage === "build" ? 25_169 : 12_000;
				const cap = stage === "build" ? 50_000 : 30_000;

				if (stage === "build")
					f.executor.buildBehavior = { kind: "fail", usage: spent };
				else f.executor.behaviors = [{ kind: "fail", usage: spent }];
				await once(f.controller);
				assert.equal(f.files.claims.get(runOf(14))?.attempt, 2);

				if (stage === "build")
					f.executor.buildBehavior = { kind: "pass", usage: 11 };
				else f.executor.behaviors = [{ kind: "pass", usage: 11 }];
				f.clock.t += 60_000;
				const controller = restart ? f.start() : f.controller;
				await once(controller);

				const attempts = f.executor.launches.filter(
					(entry) =>
						entry.stage === stage &&
						entry.round === (stage === "build" ? 1 : 0),
				);

				assert.deepEqual(
					attempts.map((entry) => entry.settings.maxTokens),
					[cap, cap - spent],
				);
				assert.equal(f.files.claims.get(runOf(14))?.usage, 29 + spent + 11);

				if (stage === "review") {
					await controller.tick();
					await controller.tick();
				}

				assert.equal(
					stage === "review"
						? f.files.claims.get(runOf(14))?.status
						: f.files.claims.get(runOf(14))?.stage,
					stage === "review" ? "waiting" : "validate",
				);
			});

		it(`counts interrupted ${stage} gateway usage before a retry in the same round`, async () => {
			const f = await cappedRun(stage);

			if (stage === "build") f.executor.buildBehavior = { kind: "hang" };
			else f.executor.behaviors = [{ kind: "hang" }];
			await f.controller.tick();
			const first = f.executor.launches.at(-1);
			assert.ok(first);
			const dir = f.executionDir(first);
			mkdirSync(dir, { recursive: true, mode: 0o700 });
			writeFileSync(
				join(dir, "egress.jsonl"),
				JSON.stringify({ inputTokens: 25_000, outputTokens: 169 }) + "\n",
			);

			if (stage === "build")
				f.executor.buildBehavior = { kind: "pass", usage: 11 };
			else f.executor.behaviors = [{ kind: "pass", usage: 11 }];
			const restarted = f.start();
			await once(restarted);
			f.clock.t += 60_000;
			await once(restarted);
			assert.equal(f.executor.launches.at(-1)?.attempt, 2);
			assert.equal(
				f.executor.launches.at(-1)?.settings.maxTokens,
				(stage === "build" ? 50_000 : 30_000) - 25_169,
			);
			assert.equal(f.files.claims.get(runOf(14))?.usage, 29 + 25_169 + 11);
		});

		it(`does not launch or approve ${stage} after cumulative round exhaustion`, async () => {
			const f = await cappedRun(stage);
			const cap = stage === "build" ? 50_000 : 30_000;

			if (stage === "build")
				f.executor.buildBehavior = { kind: "fail", usage: cap / 2 };
			else f.executor.behaviors = [{ kind: "fail", usage: cap / 2 }];
			await once(f.controller);
			f.clock.t += 60_000;

			if (stage === "review")
				f.executor.behaviors = [{ kind: "fail", usage: cap / 2 }];
			await once(f.controller);
			assert.equal(f.executor.launches.at(-1)?.settings.maxTokens, cap / 2);
			const launches = f.executor.launches.length;
			f.clock.t += 60_000;
			await once(f.start());
			assert.equal(f.executor.launches.length, launches);
			assert.equal(f.files.claims.get(runOf(14))?.status, "budget_exhausted");
			assert.equal(f.files.claims.get(runOf(14))?.usage, 29 + cap);
		});
	}

	it("subtracts failed attempts and retained review seats once on process recovery", async () => {
		const f = await cappedRun("review");
		f.executor.behaviors = [{ kind: "fail", usage: 12_000 }];
		await once(f.controller);
		f.executor.behaviors = [{ kind: "hang" }];
		f.clock.t += 60_000;
		await f.controller.tick();
		const issued = f.executor.launches.at(-1);
		assert.ok(
			issued?.execution?.stage === "review" && issued.review !== undefined,
		);
		const dir = join(f.state, "stages", runOf(14), "review-r0-2");
		mkdirSync(join(dir, "code-review"), { recursive: true, mode: 0o700 });
		writeFileSync(
			join(dir, "review.json"),
			JSON.stringify({
				version: 2,
				execution: issued.execution,
				binding: issued.review.input.binding,
				seats: issued.review.input.seats,
				inputDigest: digestOf(
					JSON.stringify({
						binding: issued.review.input.binding,
						seats: issued.review.input.seats,
						files: [...issued.review.input.files],
						scenarios: issued.review.input.scenarios,
						prompt: issued.review.input.prompt,
					}),
				),
			}),
			{ mode: 0o600 },
		);
		writeFileSync(
			join(dir, "code-review/receipt.json"),
			JSON.stringify({ usage: { total: 4_000 } }),
		);
		const output = f.executor.output.bind(f.executor);
		f.executor.output = async (input) =>
			input.stage === "review" &&
			input.attempt === 2 &&
			!existsSync(join(dir, "receipt.json"))
				? { kind: "pending" }
				: output(input);
		f.executor.behaviors = [{ kind: "pass", usage: 11 }];
		f.clock.t += 60_000;
		const restarted = f.start();
		await once(restarted);
		assert.equal(f.executor.launches.at(-1)?.attempt, 2);
		assert.equal(f.executor.launches.at(-1)?.settings.maxTokens, 14_000);
		assert.equal(
			f.executor.launches.at(-1)?.remainingRunTokens,
			500_000 - 29 - 12_000 - 4_000,
		);
		assert.equal(
			f.files.claims.get(runOf(14))?.usage,
			29 + 12_000 + 4_000 + 11,
		);
		await restarted.tick();
		await restarted.tick();
		assert.equal(f.files.claims.get(runOf(14))?.status, "waiting");
		assert.equal(
			await f.executor.spent({
				runId: runOf(14),
				stage: "review",
				attempt: 2,
				round: 0,
			}),
			4_011,
		);
		assert.equal(restarted.state.totals.usage, 4_011);
	});

	for (const stage of ["specify", "accept", "build"] as const)
		it(`keeps ${stage}'s original attempt accounting outside repair rounds`, async () => {
			const f = world();
			f.github.add(labeled(14));
			f.executor.ready = true;
			f.executor.behaviors = [
				{
					kind: stage === "specify" ? "fail" : "pass",
					usage: stage === "specify" ? 200 : 10,
				},
			];
			f.executor.acceptBehavior = {
				kind: stage === "accept" ? "fail" : "pass",
				usage: stage === "accept" ? 200 : 7,
			};
			f.executor.buildBehavior = { kind: "fail", usage: 200 };
			const controller = f.start();
			await once(controller);

			if (stage === "build") await once(controller);
			f.executor.spentBy.set(`${stage}-1`, 200);
			f.executor.behaviors = [{ kind: "pass", usage: 11 }];
			f.executor.acceptBehavior = { kind: "pass", usage: 11 };
			f.executor.buildBehavior = { kind: "pass", usage: 11 };
			f.clock.t += 60_000;
			await once(controller);

			const attempts = f.executor.launches.filter(
				(entry) => entry.stage === stage,
			);

			const cap =
				stage === "specify" ? null : stage === "accept" ? 25_000 : 200_000;

			assert.deepEqual(
				attempts.map((entry) => entry.settings.maxTokens),
				[cap, cap],
			);
			assert.equal(
				attempts[1]?.remainingRunTokens,
				500_000 -
					200 -
					(stage === "specify" ? 0 : stage === "accept" ? 10 : 17),
			);
		});

	it("gives a fresh repair round its own allowance without refreshing the run budget", async () => {
		const f = await cappedRun("build");
		f.executor.buildBehavior = { kind: "pass", usage: 25_169 };
		await once(f.controller);
		await f.controller.tick();
		assert.equal(f.files.claims.get(runOf(14))?.round, 2);
		await once(f.controller);
		assert.equal(f.executor.launches.at(-1)?.settings.maxTokens, 50_000);
		assert.equal(
			f.executor.launches.at(-1)?.remainingRunTokens,
			500_000 - 29 - 25_169,
		);
	});

	it("shares the pure machine's two-round cap and resumes a repair without round-zero output", async () => {
		const f = await waitingRun();
		let expected: CandidateState | undefined;
		f.executor.validate = async (input) => {
			const round = input.round ?? 0;

			const state = input.state ?? {
				version: 1,
				startedAt: input.now,
				deadline: input.now + input.wallMs,
				round,
				originalBase: input.baseSha,
				baseSha: input.baseSha,
				baseResolved: true,
				publication: {
					branch: `factory/run/14-${input.runId.slice(0, 12)}-r${round}`,
					patchSha: sha("b".repeat(40)),
					candidateSha: sha("c".repeat(40)),
				},
				dispatchTry: 1,
				dispatchedAt: input.now,
				ciRunId: 123,
				counters: {},
			};

			await input.save(state);

			const verdict = failingVerdict(
				digestOf(round ? `patch-r${round}` : "patch"),
			);

			const assessment = f.executor.assess(input, verdict);
			const book = f.files.claims.get(runOf(14))?.handoff;
			assert.ok(
				book?.kind === "selected" &&
					book.work.kind === "effect" &&
					book.work.request.kind === "validate",
			);

			const pure: Run = {
				id: book.pin.runId,
				repo: book.pin.repo,
				baseSha: book.pin.originalBase,
				ticket: {
					provider: "github",
					key: `${book.pin.repo}#14`,
					url: `https://github.com/${book.pin.repo}/issues/14`,
				},
				handoff: book,
				progress: candidateProjection(book).progress,
			};

			const decision = advance(pure, {
				kind: "candidate",
				event: {
					kind: "effect_completed",
					completion: {
						kind: "validate",
						request: book.work.request,
						result: {
							kind: "finished",
							validation: state,
							verdict,
							report: null,
							seats: ["code-review", "security-review", "simplify"],
							assessment,
						},
					},
				},
			});

			assert.equal(decision.kind, "advanced");
			expected = decision.run.handoff;

			return { kind: "finished", state, verdict, assessment };
		};

		await f.controller.tick();
		assert.deepEqual(f.files.claims.get(runOf(14))?.handoff, expected);
		assert.equal(f.files.claims.get(runOf(14))?.round, 1);
		assert.equal(f.files.claims.get(runOf(14))?.validation, undefined);
		const restarted = f.start();
		await once(restarted);

		const repair = f.executor.launches.find(
			(entry) => entry.stage === "build" && entry.round === 1,
		);

		assert.equal(repair?.build?.binding.round, 1);
		assert.equal(repair?.settings.maxTokens, 50_000);
		assert.equal(
			f.executor.launches.filter(
				(entry) => entry.stage === "build" && entry.round === 1,
			).length,
			1,
		);
		await once(restarted);
		assert.equal(f.files.claims.get(runOf(14))?.round, 2);
		await once(restarted);
		await restarted.tick();
		assert.equal(f.files.claims.get(runOf(14))?.status, "failed");
		assert.equal(f.files.claims.get(runOf(14))?.round, 2);
		assert.equal(
			f.executor.launches.filter((entry) => entry.stage === "build").length,
			3,
		);
	});

	for (const receipt of ["missing", "drifted"] as const)
		it(`refuses a repair build before launch when the stored base receipt is ${receipt}`, async () => {
			const f = await waitingRun();
			f.executor.validate = async (input) => {
				const round = input.round ?? 0;

				const state = input.state ?? {
					version: 1,
					startedAt: input.now,
					deadline: input.now + input.wallMs,
					round,
					originalBase: input.baseSha,
					baseSha: input.baseSha,
					baseResolved: true,
					publication: {
						branch: `factory/run/14-${input.runId.slice(0, 12)}-r${round}`,
						patchSha: sha("b".repeat(40)),
						candidateSha: sha("c".repeat(40)),
					},
					dispatchTry: 1,
					dispatchedAt: input.now,
					ciRunId: 123,
					counters: {},
				};

				await input.save(state);

				const verdict = failingVerdict(
					digestOf(round ? `patch-r${round}` : "patch"),
				);

				return {
					kind: "finished",
					state,
					verdict,
					assessment: f.executor.assess(input, verdict),
				};
			};

			await f.controller.tick();
			assert.equal(f.files.claims.get(runOf(14))?.round, 1);
			const checks = f.executor.baseChecks.length;

			f.executor.baseCheck = async (input) => {
				f.executor.baseChecks.push(input);

				return receipt === "missing"
					? {
							kind: "refused",
							failure: {
								binding: input.binding,
								receiptDigest: digestOf("missing"),
								reason: "base_evidence_missing",
								scenarios: [],
							},
						}
					: {
							kind: "ready",
							proof: qualifiedProof({
								...input.binding,
								acceptanceDigest: digestOf("drifted suite"),
							}),
						};
			};

			const restarted = f.start();
			await once(restarted);

			for (let tick = 0; tick < 4; tick++) {
				await restarted.tick();
				await settle();
				f.clock.t += 600_000;
			}

			assert.equal(
				f.executor.launches.filter(
					(entry) => entry.stage === "build" && entry.round === 1,
				).length,
				0,
			);
			assert.equal(f.files.claims.get(runOf(14))?.status, "failed");

			const ended = statuses(f.github, 14).filter((s) => s.endsWith(":failed"));

			assert.equal(ended.length, 1);
			assert.equal(statuses(f.github, 14).at(-1), ended[0]);
			const refused = keyed(f.github, 14, "base-refusal");
			assert.equal(refused.length, 1);
			assert.match(
				refused[0] ?? "",
				/^Acceptance refused before build: base_evidence_missing\. Base qualification evidence is incomplete or invalid\.\n\n<!-- factory-base-refusal /,
			);
			const settledChecks = f.executor.baseChecks.length;
			await restarted.tick();
			await settle();
			assert.equal(f.executor.baseChecks.length, settledChecks);
			assert.equal(keyed(f.github, 14, "base-refusal").length, 1);
			const repairChecks = f.executor.baseChecks.slice(checks);
			assert.ok(repairChecks.length > 0);
			assert.ok(repairChecks.every((c) => c.readOnly === true));
			assert.ok(
				f.logs.some(
					(e) =>
						e.event === "stage_inputs_refused" &&
						e.fields.why === "base_evidence_missing",
				),
			);
		});

	function assessedValidator(
		f: Awaited<ReturnType<typeof waitingRun>>,
		failure: import("../src/diagnosis.ts").FailureClass,
	): import("../src/validation.ts").Validator {
		return async (input) => {
			const round = input.round ?? 0;

			const state = input.state ?? {
				version: 1,
				startedAt: input.now,
				deadline: input.now + input.wallMs,
				round,
				originalBase: input.baseSha,
				baseSha: input.baseSha,
				baseResolved: true,
				publication: {
					branch: `factory/run/14-${input.runId.slice(0, 12)}-r${round}`,
					patchSha: sha("b".repeat(40)),
					candidateSha: sha("c".repeat(40)),
				},
				dispatchTry: 1,
				dispatchedAt: input.now,
				ciRunId: 123,
				counters: {},
			};

			await input.save(state);

			if (round > 0) return { kind: "waiting", state };
			const verdict = failingVerdict(digestOf("patch"));
			const generation = input.generation?.generation ?? 0;

			const { text, read } = storedAssessment({
				runId: input.runId,
				round,
				generation,
				verdict,
				assessment: { kind: "failed", failure },
			});

			f.executor.assessments.set(`${input.runId}/${round}/${generation}`, text);

			return { kind: "finished", state, verdict, assessment: read };
		};
	}

	async function drive(
		controller: Awaited<ReturnType<typeof waitingRun>>["controller"],
		f: Awaited<ReturnType<typeof waitingRun>>,
	) {
		for (let tick = 0; tick < 4; tick++) {
			await controller.tick();
			await settle();
			f.clock.t += 600_000;
		}
	}

	it("ends a #576-shape failure as missing evidence with zero repairs", async () => {
		const f = await waitingRun();
		const failure = classifiedCase("tree_disagreement");
		assert.deepEqual(failure, {
			kind: "missing_evidence",
			reason: "tree_replays_disagree",
		});
		f.executor.validate = assessedValidator(f, failure);
		await drive(f.controller, f);

		assert.equal(
			f.executor.launches.filter(
				(entry) => entry.stage === "build" && (entry.round ?? 0) > 0,
			).length,
			0,
		);
		const claim = f.files.claims.get(runOf(14));
		assert.equal(claim?.status, "failed");
		assert.equal(claim?.round, 0);
		const book = claim?.handoff;
		assert.ok(book?.kind === "selected");
		assert.deepEqual(book.work, {
			kind: "terminal",
			terminal: { kind: "failed", reason: "diagnosis_missing_evidence" },
		});

		const notices = keyed(f.github, 14, "diagnosis");
		assert.equal(notices.length, 1);
		assert.match(
			notices[0] ?? "",
			/^Stopped: CI diagnosis could not establish reliable evidence\. Gate and candidate replays disagree\.\n\n<!-- factory-diagnosis run=[a-f0-9]{64} g=0\.0 a=[a-f0-9]{64} -->$/,
		);
		await f.controller.tick();
		await settle();
		assert.equal(keyed(f.github, 14, "diagnosis").length, 1);
	});

	it("repairs a candidate load error after a qualified base exactly once, bound to its assessment", async () => {
		const f = await waitingRun();
		const failure = classifiedCase("candidate_load_error");
		assert.equal(failure.kind, "candidate");
		f.executor.validate = assessedValidator(f, failure);
		await drive(f.controller, f);

		const repairs = f.executor.launches.filter(
			(entry) => entry.stage === "build" && (entry.round ?? 0) > 0,
		);

		assert.equal(repairs.length, 1);
		const execution = repairs[0]?.execution;
		assert.ok(execution?.stage === "build");
		const stored = f.executor.assessments.get(`${runOf(14)}/0/0`);
		assert.ok(stored !== undefined);
		assert.deepEqual(execution.cause, {
			kind: "validation",
			assessment: readAssessmentBytes(stored)?.ref,
		});
		assert.ok(f.executor.assessmentReads.includes(`${runOf(14)}/0/0`));
		assert.equal(keyed(f.github, 14, "diagnosis").length, 0);
	});

	for (const stored of [true, false])
		it(`launches ${stored ? "one repair" : "no repair"} through the production executor's assessment reader when the candidate assessment is ${stored ? "stored" : "absent"}`, async () => {
			const f = await waitingRun();
			const state = stateDir();

			const disk = sandboxExecutor({
				stateDir: state,
				exec: async () => ({ code: 0, stdout: "", stderr: "" }),
				log: () => {},
				xdgRuntimeDir: "/run/user/1000",
			});

			f.executor.readAssessment = disk.readAssessment.bind(disk);

			const validate = assessedValidator(
				f,
				classifiedCase("candidate_load_error"),
			);

			f.executor.validate = async (input) => {
				const result = await validate(input);

				for (const [key, text] of f.executor.assessments) {
					const [runId, round, generation] = key.split("/");

					const dir = validationDir(
						state,
						runId ?? "",
						Number(round),
						Number(generation),
					);

					mkdirSync(dir, { recursive: true, mode: 0o700 });

					if (stored)
						writeFileSync(join(dir, "assessment.json"), text, {
							mode: 0o600,
						});
				}

				f.executor.assessments.clear();

				return result;
			};

			await drive(f.controller, f);

			assert.equal(
				f.executor.launches.filter(
					(entry) => entry.stage === "build" && (entry.round ?? 0) > 0,
				).length,
				stored ? 1 : 0,
			);
		});

	it("does not repair a restored repair_due whose assessment is missing", async () => {
		const f = await waitingRun();
		f.executor.validate = assessedValidator(
			f,
			classifiedCase("candidate_load_error"),
		);
		await f.controller.tick();
		assert.equal(f.files.claims.get(runOf(14))?.round, 1);
		assert.equal(
			f.executor.launches.filter(
				(entry) => entry.stage === "build" && (entry.round ?? 0) > 0,
			).length,
			0,
		);
		f.executor.assessments.clear();
		const restarted = f.start();
		await once(restarted);
		await drive(restarted, f);

		assert.equal(
			f.executor.launches.filter(
				(entry) => entry.stage === "build" && (entry.round ?? 0) > 0,
			).length,
			0,
		);
		const claim = f.files.claims.get(runOf(14));
		assert.equal(claim?.status, "failed");
		const book = claim?.handoff;
		assert.ok(book?.kind === "selected");
		assert.deepEqual(book.work, {
			kind: "terminal",
			terminal: { kind: "failed", reason: "diagnosis_missing_evidence" },
		});
	});

	for (const field of ["candidate", "ciRun"] as const)
		it(`posts another marker when only ${field} changes`, async () => {
			const f = await waitingRun();
			const before = f.github.markers(14).length;
			f.executor.validate = async (input) => {
				const state = input.state;

				if (state?.publication == null) throw new Error("fixture");

				if (field === "candidate")
					state.publication = {
						...state.publication,
						candidateSha: sha("d".repeat(40)),
					};
				else state.ciRunId = 124;
				await input.save(state);

				return { kind: "waiting", state };
			};

			await f.controller.tick();
			assert.equal(f.github.markers(14).length, before + 1);
			const last = parseMarker(f.github.markers(14).at(-1) ?? "");
			assert.equal(last.kind, "marker");

			if (last.kind === "marker")
				assert.equal(
					last.marker[field],
					field === "candidate" ? "d".repeat(40) : 124,
				);
		});

	it("fails closed when a published marker loses its private validation state", async () => {
		const f = await waitingRun();
		const claim = f.files.claims.get(runOf(14));

		if (claim === undefined) throw new Error("fixture");
		const missing = { ...claim };
		delete missing.validation;
		delete missing.handoff;
		f.files.claims.set(runOf(14), missing);
		let calls = 0;
		f.executor.validate = async (input) => {
			calls++;

			return { kind: "waiting", state: input.state ?? claim.validation! };
		};

		const result = await f.start().tick();
		assert.equal(calls, 0);
		assert.equal(result.totals.failures, 1);
		assert.ok(
			f.logs.some(
				(entry) =>
					entry.event === "validation_failed" &&
					entry.fields.why === "validation_state_missing",
			),
		);
	});

	it("keeps cleanup identities when adopting a remotely ended marker", async () => {
		const f = await waitingRun();
		const claim = f.files.claims.get(runOf(14));
		const last = parseMarker(f.github.markers(14).at(-1) ?? "");

		if (last.kind !== "marker") throw new Error("fixture");
		f.github.comment(
			f.github.issues.get(14)!,
			formatMarker({
				...last.marker,
				status: "failed",
				seq: last.marker.seq + 1,
			}),
		);
		await f.start().tick();
		assert.deepEqual(
			validationOf(f.files.claims.get(runOf(14))),
			validationOf(claim),
		);
		assert.equal(f.files.claims.get(runOf(14))?.status, "failed");
	});

	it("does not progress an awaiting run on an unconfirmed issue read", async () => {
		const f = await waitingRun();
		let calls = 0;
		const validate = f.executor.validate;
		f.executor.validate = async (input) => {
			calls++;

			return validate(input);
		};

		f.github.failures.set(`repos/${FAKE_REPO}/issues/14`, networkError());
		await f.controller.tick();
		assert.equal(calls, 0);
	});

	it("retains publication identities when a waiting run is released across restart", async () => {
		const { github, executor, files, start } = world();
		const issue = github.add(labeled(14));
		executor.behaviors = [{ kind: "pass", usage: 10 }];
		executor.acceptBehavior = { kind: "pass", usage: 7 };
		executor.buildBehavior = { kind: "pass", usage: 12 };
		executor.validate = async (input) => {
			const state = {
				version: 1,
				startedAt: input.now,
				deadline: input.now + input.wallMs,
				round: 0,
				originalBase: input.baseSha,
				baseSha: input.baseSha,
				baseResolved: true,
				publication: {
					branch: `factory/run/14-${input.runId.slice(0, 12)}-r0`,
					patchSha: sha("b".repeat(40)),
					candidateSha: sha("c".repeat(40)),
				},
				dispatchTry: 1,
				dispatchedAt: input.now,
				ciRunId: 123,
				counters: {},
			} as const;

			await input.save(state);

			return { kind: "waiting", state };
		};

		const first = start();
		await once(first);
		await once(first);
		await first.tick();
		const publication = validationOf(files.claims.get(runOf(14)))?.publication;
		assert.ok(publication);
		issue.labels = [];
		issue.updatedAt = "2026-10-29T03:00:00Z";
		const report = await start().tick();
		assert.deepEqual(report.runs, []);
		assert.equal(files.claims.get(runOf(14))?.status, "released");
		assert.deepEqual(
			validationOf(files.claims.get(runOf(14)))?.publication,
			publication,
		);
	});
	it("adopts a v1 validate marker on the old workflow without a model interruption or slot", async () => {
		const { github, executor, start, clock } = world();
		const issue = github.add(labeled(14));

		const legacy = TRUSTED_WORKFLOW.replace(
			"  validate:\n",
			"  validate:\n    model: openai/gpt-6.1-sol\n",
		);

		github.workflow = legacy;
		executor.workflow = () => legacy;
		executor.behaviors = [{ kind: "pass", usage: 10 }];
		executor.acceptBehavior = { kind: "pass", usage: 7 };
		executor.buildBehavior = { kind: "pass", usage: 12 };
		const first = start();
		await once(first);
		const built = await once(first);
		assert.equal(built.active, 0);
		await first.tick();
		const last = issue.comments.at(-1);
		assert.ok(last);
		const parsed = parseMarker(last.body);
		assert.equal(parsed.kind, "marker");

		if (parsed.kind !== "marker") return;
		assert.equal(parsed.marker.stage, "validate");
		last.body = formatMarker({ ...parsed.marker, v: 1 });
		clock.t += 60_000;
		const restored = start();
		const report = await restored.tick();
		assert.equal(report.active, 0);
		assert.equal(report.totals.retries, 0);
		assert.equal(restored.state.runs.get(14)?.phase.kind, "candidate");
		assert.equal(restored.state.runs.get(14)?.attempt, 1);
		assert.equal(executor.validations.length, 2);
		assert.equal(
			executor.validations[0]?.generation?.digest,
			executor.validations[1]?.generation?.digest,
		);
		assert.equal(
			executor.launches.filter((launch) => launch.stage === "build").length,
			1,
		);
		assert.equal(executor.launches.length, 3);
	});
});

describe("held-out acceptance stage", () => {
	it("runs specify then a fresh accept, stores the suite, and claims build after one redacted summary", async () => {
		const { github, executor, files, start } = world();
		github.add(labeled(14, { body: "PRIVATE-ISSUE-TRANSCRIPT server/cli.ts" }));
		executor.behaviors = [{ kind: "pass", usage: 100 }];
		executor.acceptBehavior = { kind: "pass", usage: 20 };
		const report = await once(start());
		assert.deepEqual(statuses(github, 14), [
			"1:claimed",
			"2:running",
			"3:claimed",
			"4:running",
			"5:claimed",
		]);
		assert.deepEqual(
			executor.launches.map((l) => [l.stage, l.attempt]),
			[
				["specify", 1],
				["accept", 1],
			],
		);
		const accept = executor.launches[1];
		assert.ok(accept);
		assert.equal(accept.specify, undefined);
		assert.deepEqual(accept.tools, ["read", "grep", "ls"]);
		assert.deepEqual(accept.skills, ["acceptance"]);
		assert.equal(accept.settings.maxTokens, 25_000);
		assert.equal(accept.remainingRunTokens, 499_900);
		assert.ok(!accept.prompt.includes("PRIVATE-ISSUE-TRANSCRIPT"));
		assert.ok(!accept.prompt.includes("snapshot"));
		assert.ok(accept.prompt.includes(MAIN_SHA));
		assert.ok(accept.prompt.includes('"id":"A1"'));
		assert.ok(accept.prompt.includes("export const VERSION"));
		const bound = await files.readContract(runOf(14));
		assert.equal(bound.kind, "found");

		if (bound.kind !== "found") throw new Error("contract missing");

		const suite = await files.artifacts.read(
			runOf(14),
			bound.contract,
			bound.digest,
		);

		assert.equal(suite.kind, "found");

		if (suite.kind !== "found") throw new Error("suite missing");
		assert.equal(suite.receipt.contractDigest, bound.digest);
		assert.equal(suite.receipt.model, "anthropic/claude-sonnet-5-5");
		const [summary] = keyed(github, 14, "acceptance");
		assert.ok(summary?.includes("S1: A1"));
		assert.ok(
			summary?.includes("context-isolated, same family, not cross-family"),
		);

		for (const value of [
			"canary",
			"version.test.ts",
			"import assert",
			"/acceptance/",
		])
			assert.ok(!summary?.includes(value));
		assert.equal(keyed(github, 14, "acceptance").length, 1);
		assert.equal(report.totals.usage, 120);
		assert.equal(report.active, 1);
		assert.equal(report.runs[0]?.stage, "build");
		assert.deepEqual(report.corrupt, []);
	});

	it("counts an acceptance store failure once", async () => {
		const { github, executor, files, start } = world();
		github.add(labeled(14));
		executor.behaviors = [{ kind: "pass", usage: 10 }];
		executor.acceptBehavior = { kind: "pass", usage: 7 };
		files.artifacts.store = async () => ({
			kind: "blocked",
			reason: "acceptance_invalid",
		});
		const controller = start();
		const report = await once(controller);
		assert.equal(statuses(github, 14).at(-1), "5:failed");
		assert.equal(report.totals.failures, 1);
		assert.equal((await controller.tick()).totals.failures, 1);
	});

	for (const corrupt of [false, true]) {
		it(`counts unmarked accept spend on claimed-marker reuse${corrupt ? " with an integrity failure" : ""}`, async () => {
			const ctx = world();
			const { github, executor, files, wire, clock } = ctx;
			github.add(labeled(14));
			executor.behaviors = [{ kind: "pass", usage: 10 }];
			executor.acceptBehavior = { kind: "pass", usage: 7 };
			wire.intercept = async (command, args) => {
				const body = args.find((a) => a.startsWith("body="))?.slice(5) ?? "";
				const parsed = parseMarker(body);

				return (parsed.kind === "marker" &&
					parsed.marker.stage === "accept" &&
					parsed.marker.status === "running") ||
					body.includes("<!-- factory-acceptance ")
					? httpError(403)
					: github.exec(command, args);
			};

			const first = ctx.start();
			await once(first);
			await first.tick();
			assert.equal(statuses(github, 14).at(-1), "3:claimed");
			const bound = await files.readContract(runOf(14));

			if (bound.kind !== "found") throw new Error("no contract");
			assert.equal(
				(await files.artifacts.read(runOf(14), bound.contract, bound.digest))
					.kind,
				"found",
			);
			executor.spentBy.set("accept-1", 7);

			if (corrupt)
				files.artifacts.read = async () => ({
					kind: "blocked",
					reason: "acceptance_changed",
				});
			wire.intercept = null;
			clock.t += 60_000;
			const controller = ctx.start();
			const report = await once(controller);
			const terminal = parseMarker(github.markers(14).at(-1) ?? "");
			assert.equal(terminal.kind, "marker");

			if (terminal.kind !== "marker") throw new Error("no marker");
			assert.equal(terminal.marker.status, corrupt ? "failed" : "claimed");
			assert.equal(terminal.marker.usage, 17);
			assert.equal(report.totals.usage, 7);
			assert.equal(report.totals.failures, corrupt ? 1 : 0);
			assert.equal((await controller.tick()).totals.usage, 7);
			assert.equal(
				executor.launches.filter((l) => l.stage !== "build").length,
				2,
			);
		});
	}

	it("recovers model identity from passed output before storing the suite", async () => {
		const ctx = world();
		const { github, executor, files, clock } = ctx;
		github.add(labeled(14));
		executor.behaviors = [{ kind: "pass", usage: 10 }];
		executor.acceptBehavior = { kind: "pass", usage: 7 };
		const store = files.artifacts.store;
		files.artifacts.store = async () => {
			throw new Error("crash before store");
		};

		await assert.rejects(once(ctx.start()), /crash before store/);
		files.artifacts.store = store;
		assert.equal(statuses(github, 14).at(-1), "4:running");
		executor.spentBy.set("accept-1", 7);
		executor.output = async () => ({
			kind: "output",
			text: ACCEPTANCE_TEXT,
			model: "openai/recorded-model",
			observed: "recorded-observation",
		});
		clock.t += 60_000;
		const report = await ctx.start().tick();
		const bound = await files.readContract(runOf(14));

		if (bound.kind !== "found") throw new Error("no contract");

		const stored = await files.artifacts.read(
			runOf(14),
			bound.contract,
			bound.digest,
		);

		assert.equal(stored.kind, "found");

		if (stored.kind !== "found") throw new Error("no suite");
		assert.equal(stored.receipt.model, "openai/recorded-model");
		assert.equal(stored.receipt.observed, "recorded-observation");
		assert.equal(report.totals.usage, 7);
		assert.equal(
			executor.launches.filter((l) => l.stage !== "build").length,
			2,
		);
	});

	for (const output of [
		"",
		"{}",
		JSON.stringify({ version: 1, scenarios: [], files: [] }),
		ACCEPTANCE_TEXT.replace("version.test.ts", "../escape.test.ts"),
	]) {
		it(`fails invalid accept output without storing or advancing: ${output.slice(0, 40)}`, async () => {
			const { github, executor, files, start, clock } = world();
			github.add(labeled(14));
			executor.behaviors = [{ kind: "pass", usage: 10 }];
			executor.acceptBehavior = { kind: "pass", usage: 7 };
			executor.acceptText = output;
			const controller = start();
			await once(controller);
			assert.equal(controller.state.runs.get(14)?.stage, "accept");
			assert.equal(controller.state.runs.get(14)?.attempt, 2);
			clock.t += 10_000;
			await once(controller);
			clock.t += 20_000;
			const report = await once(controller);
			assert.equal(statuses(github, 14).at(-1), "9:failed");
			assert.equal(report.totals.usage, 31);
			assert.equal(keyed(github, 14, "acceptance").length, 0);
			const bound = await files.readContract(runOf(14));

			if (bound.kind !== "found") throw new Error("contract missing");
			assert.deepEqual(
				await files.artifacts.read(runOf(14), bound.contract, bound.digest),
				{ kind: "absent" },
			);
		});
	}

	it("drops exhausted accept output while retaining its usage", async () => {
		const { github, executor, files, start } = world();
		github.add(labeled(14));
		executor.behaviors = [{ kind: "pass", usage: 10 }];
		executor.acceptBehavior = { kind: "budget", usage: 7 };
		const report = await once(start());
		assert.equal(statuses(github, 14).at(-1), "5:budget_exhausted");
		assert.equal(report.totals.usage, 17);
		assert.equal(keyed(github, 14, "acceptance").length, 0);
		const bound = await files.readContract(runOf(14));

		if (bound.kind !== "found") throw new Error("contract missing");
		assert.deepEqual(
			await files.artifacts.read(runOf(14), bound.contract, bound.digest),
			{ kind: "absent" },
		);
	});

	for (const corrupt of [false, true]) {
		it(`recovers after suite storage without regenerating${corrupt ? ", blocking changed bytes" : ""}`, async () => {
			const ctx = world();
			const { github, executor, files, wire, clock } = ctx;
			github.add(labeled(14));
			executor.behaviors = [{ kind: "pass", usage: 10 }];
			executor.acceptBehavior = { kind: "pass", usage: 7 };
			wire.intercept = async (command, args) =>
				args.some(
					(a) =>
						a.startsWith("body=") && a.includes("<!-- factory-acceptance "),
				)
					? networkError()
					: github.exec(command, args);
			await once(ctx.start());
			assert.equal(statuses(github, 14).at(-1), "5:running");
			const bound = await files.readContract(runOf(14));

			if (bound.kind !== "found") throw new Error("contract missing");

			const kept = await files.artifacts.read(
				runOf(14),
				bound.contract,
				bound.digest,
			);

			assert.equal(kept.kind, "found");

			if (corrupt)
				files.artifacts.read = async () => ({
					kind: "blocked",
					reason: "acceptance_changed",
				});
			executor.kept.delete(`${runOf(14)}/accept-1`);
			executor.spentBy.set("accept-1", 7);
			wire.intercept = null;
			clock.t += 60_000;
			const report = await once(ctx.start());
			assert.equal(
				executor.launches.filter((l) => l.stage !== "build").length,
				2,
			);
			assert.equal(
				statuses(github, 14).at(-1),
				corrupt ? "6:failed" : "6:claimed",
			);
			assert.equal(keyed(github, 14, "acceptance").length, corrupt ? 0 : 1);
			assert.deepEqual(report.corrupt, []);

			assert.equal(report.totals.failures, corrupt ? 1 : 0);

			if (corrupt)
				assert.ok(ctx.logs.some((e) => e.fields.why === "acceptance_changed"));
			else
				assert.deepEqual(
					await files.artifacts.read(runOf(14), bound.contract, bound.digest),
					kept,
				);
		});
	}
});

describe("held-out acceptance stage: needs_info", () => {
	it("ends a questions result at specify and never launches accept", async () => {
		const { github, executor, files, clock, wire, start } = world();

		wire.intercept = writesWire(github, []);
		github.add(labeled(14));
		executor.outputs = [QUESTIONS_TEXT];
		executor.behaviors = [{ kind: "pass", usage: 3 }];
		executor.acceptBehavior = { kind: "pass", usage: 7 };

		const controller = start();

		for (let tick = 0; tick < 3; tick++) {
			await once(controller);
			clock.t += 60_000;
		}

		assert.equal(statuses(github, 14).at(-1), "3:needs_info");
		assert.deepEqual(
			executor.launches.map((l) => l.stage),
			["specify"],
		);
		assert.equal(keyed(github, 14, "acceptance").length, 0);
		assert.equal((await files.readContract(runOf(14))).kind, "blocked");
	});
});

describe("specify: contract", () => {
	it("stores a validated contract and posts its summary before claiming accept", async () => {
		const { github, files, executor, wire, start } = world();
		const writes: string[] = [];

		wire.intercept = writesWire(github, writes);
		github.add(
			labeled(14, {
				title: "Add --version",
				body: "Print the version from server/cli.ts.",
			}),
		);
		executor.behaviors = [{ kind: "pass", usage: 900 }];

		const report = await once(start());

		assert.deepEqual(statuses(github, 14), [
			"1:claimed",
			"2:running",
			"3:claimed",
			"4:blocked",
		]);
		assert.deepEqual(writes, [
			"marker:claimed",
			"marker:running",
			"summary",
			"marker:claimed",
			"marker:blocked",
		]);
		assert.equal(report.totals.usage, 900);

		const stored = files.contracts.get(runOf(14));

		assert.ok(stored);
		assert.equal(stored.digest, digestOf(stored.bytes));

		const contract = JSON.parse(stored.bytes);

		assert.equal(contract.version, 2);
		assert.deepEqual(contract.base, { repo, sha: MAIN_SHA });
		assert.equal(contract.runId, runOf(14));
		assert.equal(
			contract.snapshot.digest,
			digestOf(
				JSON.stringify([
					"Add --version",
					"Print the version from server/cli.ts.",
				]),
			),
		);
		assert.equal(contract.link, null);
		assert.deepEqual(contract.acceptance, [
			{ id: "A1", kind: "new_behavior", text: "--version prints 0.1.0" },
		]);

		const [summary] = keyed(github, 14, "contract");

		assert.ok(summary?.includes(stored.digest.slice(0, 12)));
		assert.ok(summary?.endsWith(`c=${stored.digest} -->\n`));
		assert.ok(!summary?.includes("VERSION"));
		assert.deepEqual(github.issues.get(14)?.labels, [READY_LABEL]);
	});

	it("launches specify with the snapshot, the base commit's guidance, the repository map, read tools and the skills", async () => {
		const { github, executor, start } = world();

		github.add(
			labeled(14, {
				title: "Add --version",
				body: "Print the version from server/cli.ts.",
			}),
		);
		executor.behaviors = [{ kind: "pass", usage: 1 }];

		await once(start());

		const launch = executor.launches[0];

		assert.ok(launch);
		assert.deepEqual(launch.tools, ["read", "grep", "ls"]);
		assert.deepEqual(launch.specify, {
			title: "Add --version",
			body: "Print the version from server/cli.ts.",
			answers: null,
			files: [...executor.tree.keys()],
		});
		assert.deepEqual(launch.skills, [
			"audit-ticket",
			"grill-me",
			"deep-research",
		]);
		assert.ok(launch.prompt.includes(`at commit ${MAIN_SHA}`));
		assert.match(
			launch.prompt,
			/<issue-([0-9a-f]{32})>\nAdd --version\n\nPrint the version from server\/cli.ts\.\n<\/issue-\1>/,
		);
		assert.ok(launch.prompt.includes("Turn the issue into a short contract"));
		assert.ok(
			launch.prompt.includes(
				"=== server/cli.ts ===\n1\texport const VERSION = 1;",
			),
		);
		assert.ok(launch.prompt.includes("=== README.md ==="));
		assert.ok(!launch.prompt.includes("subagent"));
		assert.deepEqual(executor.checkouts, [runOf(14), runOf(14)]);
	});

	it("inlines the files the issue names within a 16 KiB budget and leaves the rest to the read tool", async () => {
		const { github, executor, start } = world();
		const line = `${"x".repeat(99)}\n`;

		for (const name of ["a.ts", "b.ts", "c.ts"]) {
			executor.tree.set(`src/${name}`, line.repeat(100));
		}

		github.add(labeled(14, { body: "Touch src/a.ts, src/b.ts and src/c.ts." }));
		executor.behaviors = [{ kind: "pass", usage: 1 }];

		await once(start());

		const prompt = executor.launches[0]?.prompt ?? "";

		assert.ok(prompt.includes("=== src/a.ts ===\n"));
		assert.match(prompt, /=== src\/b\.ts \(lines 1-\d+ of 101\) ===\n/);
		assert.ok(!prompt.includes("=== src/c.ts"));
		assert.ok(prompt.includes("src/c.ts\n"));
	});

	it("takes the guidance from the run's base commit, not from a later main", async () => {
		const { github, executor, start } = world();

		github.add(labeled(14));
		executor.behaviors = [{ kind: "unavailable" }, { kind: "pass", usage: 1 }];
		executor.workflow = () => TRUSTED_WORKFLOW;

		const controller = start();

		await once(controller);
		assert.deepEqual(statuses(github, 14), ["1:claimed", "2:blocked"]);
		assert.deepEqual(executor.checkouts, []);

		setWorkflow(
			github,
			"Turn the issue into a short contract",
			"Write a haiku about the issue",
		);
		github.issues.get(14)?.timeline.push();
		await once(controller);

		const launch = executor.launches[1];

		assert.ok(launch);
		assert.ok(launch.prompt.includes("Turn the issue into a short contract"));
		assert.ok(!launch.prompt.includes("haiku"));
	});

	it("fails the run when the checkout's WORKFLOW.md is not the admitted one", async () => {
		const { github, executor, logs, start } = world();

		github.add(labeled(14));
		executor.behaviors = [{ kind: "pass", usage: 1 }];
		executor.workflow = () => `${TRUSTED_WORKFLOW}\nextra\n`;

		await once(start());

		assert.equal(executor.launches.length, 0);
		assert.deepEqual(statuses(github, 14), ["1:claimed", "2:failed"]);
		assert.ok(
			logs.some(
				(entry) =>
					entry.event === "stage_inputs_refused" &&
					entry.fields.why === "workflow_mismatch",
			),
		);
	});

	it("waits without a launch while the checkout is unavailable, and fails a refused tarball", async () => {
		const { github, executor, logs, start } = world();

		github.add(labeled(14));
		github.add(labeled(15));
		executor.fallback = { kind: "pass", usage: 1 };
		executor.checkoutResult = "unavailable";

		const controller = start();
		const report = await once(controller);

		assert.equal(executor.launches.length, 0);
		assert.deepEqual(
			report.runs.map((run) => run.status),
			["claimed", "claimed"],
		);
		assert.ok(
			logs.some(
				(entry) =>
					entry.event === "stage_inputs_unavailable" &&
					entry.fields.why === "checkout",
			),
		);

		executor.checkoutResult = "refused";
		await once(controller);

		assert.equal(executor.launches.length, 0);
		assert.equal(statuses(github, 14).at(-1), "2:failed");
	});
});

describe("specify: no contract without a passing, valid output", () => {
	it("retries malformed output as stage_failed and ends failed with no contract or comment", async () => {
		const { github, clock, files, executor, logs, start } = world();

		github.add(labeled(14));
		executor.outputs = ["Here is the contract: {}", '{"kind":"plan"}', null];
		executor.behaviors = [
			{ kind: "pass", usage: 10 },
			{ kind: "pass", usage: 10 },
			{ kind: "pass", usage: 10 },
		];

		const controller = start();

		await once(controller);
		assert.deepEqual(statuses(github, 14), [
			"1:claimed",
			"2:running",
			"3:retrying",
		]);
		clock.t += 11_000;
		await once(controller);
		clock.t += 21_000;
		await once(controller);

		assert.equal(executor.launches.length, 3);
		assert.equal(statuses(github, 14).at(-1)?.endsWith(":failed"), true);
		assert.deepEqual(
			logs.flatMap((entry) =>
				entry.event === "specify_malformed" ? [entry.fields.reason] : [],
			),
			["not_json", "bad_kind", "no_output"],
		);
		assert.equal(files.contracts.size, 0);
		assert.equal(files.questions.size, 0);
		assert.deepEqual(keyed(github, 14, "contract"), []);
	});

	it("never reads the output of a budget_exhausted or refused stage", async () => {
		for (const behavior of [
			{ kind: "budget", usage: 50 },
			{ kind: "refuse", usage: 50 },
		] as const) {
			const { github, files, executor, start } = world();

			github.add(labeled(14));
			executor.behaviors = [behavior];
			executor.kept.set(`${runOf(14)}/specify-1`, CONTRACT_TEXT);

			await once(start());

			assert.deepEqual(executor.outputReads, [], behavior.kind);
			assert.equal(files.contracts.size, 0, behavior.kind);
			assert.deepEqual(keyed(github, 14, "contract"), [], behavior.kind);
			assert.equal(
				statuses(github, 14).at(-1),
				behavior.kind === "budget" ? "3:budget_exhausted" : "3:failed",
			);
		}
	});

	it("ends a stage whose summary is not storable without a terminal marker until it is", async () => {
		const { github, clock, files, executor, start } = world();

		github.add(labeled(14));
		executor.behaviors = [{ kind: "pass", usage: 5 }];
		files.unavailable.add("contract");

		const controller = start();

		await once(controller);
		assert.deepEqual(statuses(github, 14), ["1:claimed", "2:running"]);
		assert.deepEqual(keyed(github, 14, "contract"), []);

		files.unavailable.delete("contract");
		clock.t += 1_000;
		await once(controller);

		assert.equal(statuses(github, 14).at(-1), "3:claimed");
		assert.equal(keyed(github, 14, "contract").length, 1);
		assert.equal(executor.launches.length, 1);
	});
});

describe("specify: questions", () => {
	for (const outcome of ["rejected", "unknown"] as const) {
		it(`waits for a confirmed label swap after a ${outcome} write`, async () => {
			const ctx = world();
			const write = writesWire(ctx.github, []);
			let removals = 0;
			ctx.github.add(labeled(14));
			ctx.executor.outputs = [QUESTIONS_TEXT];
			ctx.executor.behaviors = [{ kind: "pass", usage: 3 }];
			ctx.wire.intercept = async (command, args) => {
				if (
					args.includes("DELETE") &&
					args.some((arg) => arg.endsWith("labels/factory%3Aready"))
				) {
					removals++;

					if (removals === 1)
						return outcome === "rejected"
							? httpError(422, "denied")
							: networkError();
				}

				return write(command, args);
			};

			const controller = ctx.start();
			await once(controller);
			assert.deepEqual(statuses(ctx.github, 14), ["1:claimed", "2:running"]);
			assert.ok(
				ctx.logs.some(
					({ event, fields }) =>
						event === "label_unconfirmed" && fields.outcome === outcome,
				),
			);
			ctx.clock.t += 60_000;
			await once(controller);
			assert.equal(statuses(ctx.github, 14).at(-1), "3:needs_info");
			assert.equal(removals, 2);
		});
	}

	it("starts a restarted new run at zero after the previous run exhausted label retries (T-CARRY)", async () => {
		const ctx = world();
		const write = writesWire(ctx.github, []);
		const disk = fileRunFiles(stateDir());
		ctx.files.writeClaim = disk.writeClaim;
		ctx.files.listClaims = disk.listClaims;
		const issue = ctx.github.add(labeled(14));
		ctx.executor.outputs = [QUESTIONS_TEXT, CONTRACT_TEXT];
		ctx.executor.behaviors = [
			{ kind: "pass", usage: 3 },
			{ kind: "pass", usage: 3 },
		];
		let rejectAdds = true;
		ctx.wire.intercept = async (command, args) =>
			rejectAdds &&
			args.includes("POST") &&
			args.some((arg) => arg.endsWith("/labels"))
				? httpError(422, "denied")
				: write(command, args);

		await once(ctx.start());

		for (let n = 0; n < 4; n++) {
			ctx.clock.t += 60_000;
			await once(ctx.start());
		}

		assert.equal(statuses(ctx.github, 14).at(-1), "3:failed");
		assert.equal((await disk.listClaims())[0]?.labelFailures, 3);

		rejectAdds = false;
		ctx.github.now = "2026-10-29T03:00:00Z";
		issue.timeline.push(
			labelEvent({
				id: EVENT_ID + 80,
				at: "2026-10-29T02:59:59Z",
				actor: "giuseppecrj",
				event: "unlabeled",
			}),
			labelEvent({
				id: EVENT_ID + 81,
				at: ctx.github.now,
				actor: "giuseppecrj",
			}),
		);
		issue.updatedAt = ctx.github.now;
		ctx.github.now = "2026-10-29T03:01:00Z";
		ctx.clock.t += 31 * 60_000;
		ctx.github.posts = ["landed_unanswered"];
		ctx.executor.fallback = { kind: "unavailable" };
		const behaviors = ctx.executor.behaviors;
		ctx.executor.behaviors = [];
		await once(ctx.start());
		assert.equal(statuses(ctx.github, 14).at(-1), "4:claimed");

		ctx.executor.behaviors = behaviors;
		ctx.clock.t += 60_000;
		const restarted = ctx.start();
		await once(restarted);
		ctx.clock.t += 60_000;
		await once(restarted);
		assert.equal(statuses(ctx.github, 14).at(-1), "7:blocked");
		assert.equal(ctx.files.contracts.size, 1);
		assert.equal(
			ctx.executor.launches.filter((l) => l.stage === "specify").length,
			2,
		);
		assert.equal(
			ctx.logs.filter(({ event }) => event === "label_retries_exhausted")
				.length,
			1,
		);
	});

	it("resets persisted label failures after a successful critical write", async () => {
		const ctx = world();
		const write = writesWire(ctx.github, []);
		const disk = fileRunFiles(stateDir());
		ctx.files.writeClaim = disk.writeClaim;
		ctx.files.listClaims = disk.listClaims;
		ctx.github.add(labeled(14));
		ctx.executor.outputs = [QUESTIONS_TEXT];
		ctx.executor.behaviors = [{ kind: "pass", usage: 3 }];
		let additions = 0;
		ctx.wire.intercept = async (command, args) => {
			if (
				args.includes("POST") &&
				args.some((arg) => arg.endsWith("/labels"))
			) {
				additions++;

				if (additions <= 2) return networkError();
			}

			if (
				args.includes("DELETE") &&
				args.some((arg) => arg.endsWith("labels/factory%3Aready"))
			)
				return networkError();

			return write(command, args);
		};

		await once(ctx.start());
		assert.equal((await disk.listClaims())[0]?.labelFailures, 1);
		ctx.clock.t += 60_000;
		await once(ctx.start());
		assert.equal((await disk.listClaims())[0]?.labelFailures, 2);
		ctx.clock.t += 60_000;
		await once(ctx.start());
		assert.equal((await disk.listClaims())[0]?.labelFailures, 1);
		ctx.clock.t += 60_000;
		await once(ctx.start());
		assert.equal((await disk.listClaims())[0]?.labelFailures, 2);
		assert.ok(
			!ctx.logs.some(({ event }) => event === "label_retries_exhausted"),
		);
	});

	it("caps persistently rejected label writes across separate controllers and disk claims without rerunning specify", async () => {
		const ctx = world();
		const write = writesWire(ctx.github, []);
		let additions = 0;
		const disk = fileRunFiles(stateDir());
		ctx.files.writeClaim = disk.writeClaim;
		ctx.files.listClaims = disk.listClaims;
		ctx.github.add(labeled(14));
		ctx.executor.outputs = [QUESTIONS_TEXT];
		ctx.executor.behaviors = [{ kind: "pass", usage: 3 }];
		ctx.wire.intercept = async (command, args) => {
			if (
				args.includes("POST") &&
				args.some((arg) => arg.endsWith("/labels"))
			) {
				additions++;

				return httpError(422, "denied");
			}

			return write(command, args);
		};

		await once(ctx.start());

		for (let n = 0; n < 5; n++) {
			ctx.clock.t += 60_000;
			await once(ctx.start());
		}

		assert.equal(additions, 3);
		assert.equal(statuses(ctx.github, 14).at(-1), "3:failed");
		assert.equal(ctx.executor.launches.length, 1);
		assert.equal(
			ctx.logs.filter(
				({ event, fields }) =>
					event === "label_unconfirmed" && fields.outcome === "rejected",
			).length,
			3,
		);
	});

	it("links a preserved owner relabel to the questions posted before a delayed terminal marker", async () => {
		const ctx = world();
		const write = writesWire(ctx.github, []);
		const issue = ctx.github.add(labeled(14));
		let removals = 0;
		ctx.executor.outputs = [QUESTIONS_TEXT, CONTRACT_TEXT];
		ctx.executor.behaviors = [
			{ kind: "pass", usage: 3 },
			{ kind: "pass", usage: 5 },
		];
		ctx.wire.intercept = async (command, args) => {
			if (
				args.includes("DELETE") &&
				args.some((arg) => arg.endsWith("labels/factory%3Aready"))
			) {
				removals++;
				await write(command, args);

				return networkError();
			}

			return write(command, args);
		};

		const controller = ctx.start();
		await once(controller);
		ctx.github.now = "2026-10-29T02:00:20Z";
		ctx.github.comment(issue, "PRESERVED-OWNER-ANSWER", {
			login: "writer",
			type: "User",
			appSlug: null,
		});
		ctx.github.now = "2026-10-29T02:00:40Z";
		issue.labels.push(READY_LABEL);
		issue.timeline.push(
			labelEvent({
				id: EVENT_ID + 50,
				at: ctx.github.now,
				actor: "giuseppecrj",
			}),
		);
		issue.updatedAt = ctx.github.now;
		ctx.github.now = "2026-10-29T02:01:00Z";
		ctx.clock.t += 60_000;
		await once(controller);
		ctx.clock.t += 60_000;
		await once(controller);
		assert.equal(removals, 1);
		assert.ok(issue.labels.includes(READY_LABEL));
		assert.equal(statuses(ctx.github, 14).at(-1), "7:blocked");
		const linked = runIdOf({ repo, issue: 14, eventId: String(EVENT_ID + 50) });
		assert.equal(ctx.files.links.get(linked)?.prevRunId, runOf(14));
		assert.match(
			ctx.executor.launches[1]?.prompt ?? "",
			/PRESERVED-OWNER-ANSWER/,
		);
	});

	it("settles a same-second owner relabel during a lost label removal without stalling reporting", async () => {
		const ctx = world();
		const write = writesWire(ctx.github, []);
		const issue = ctx.github.add(labeled(14));
		ctx.executor.outputs = [QUESTIONS_TEXT];
		ctx.executor.behaviors = [{ kind: "pass", usage: 3 }];
		let removals = 0;
		ctx.wire.intercept = async (command, args) => {
			if (
				args.includes("DELETE") &&
				args.some((arg) => arg.endsWith("labels/factory%3Aready"))
			) {
				removals++;
				await write(command, args);
				issue.labels.push(READY_LABEL);
				issue.timeline.push(
					labelEvent({
						id: EVENT_ID + 60,
						at: ctx.github.now,
						actor: "giuseppecrj",
					}),
				);

				return networkError();
			}

			return write(command, args);
		};

		const controller = ctx.start();
		await once(controller);
		ctx.github.now = "2026-10-29T02:10:00Z";
		ctx.clock.t += 600_000;
		const report = await once(controller);
		assert.equal(statuses(ctx.github, 14).at(-1), "3:needs_info");
		assert.equal(report.runs.length, 0);
		assert.equal(removals, 1);
		assert.ok(
			ctx.logs.some(
				({ event, fields }) =>
					event === "ready_label_preserved" && fields.why === "tied",
			),
		);
		assert.deepEqual(report.refused, [
			{ issue: 14, reasons: ["ambiguous_snapshot"] },
		]);
	});

	it("releases a recovering run when its issue closes without posting questions or labels again", async () => {
		const ctx = world();
		const writes: string[] = [];
		ctx.wire.intercept = writesWire(ctx.github, writes);
		const issue = ctx.github.add(labeled(14));
		ctx.github.posts = ["ok", "ok", "ok", "lost"];
		ctx.executor.outputs = [QUESTIONS_TEXT];
		ctx.executor.behaviors = [{ kind: "pass", usage: 3 }];
		await once(ctx.start());
		ctx.executor.checkoutResult = "unavailable";
		ctx.clock.t += 60_000;
		const restarted = ctx.start();
		await once(restarted);
		assert.equal(restarted.state.runs.get(14)?.phase.kind, "recovering");
		issue.state = "closed";
		issue.updatedAt = "2026-10-29T02:30:00Z";
		ctx.github.now = issue.updatedAt;
		writes.length = 0;
		ctx.clock.t += 31 * 60_000;
		await once(restarted);
		ctx.executor.checkoutResult = "ready";
		ctx.clock.t += 60_000;
		await once(restarted);
		assert.equal(statuses(ctx.github, 14).at(-1), "3:released");
		assert.deepEqual(writes, ["marker:released"]);
		assert.equal(ctx.executor.launches.length, 1);
	});

	it("waits through transient recovery reads after ready was removed, then finishes needs_info", async () => {
		const ctx = world();
		ctx.wire.intercept = writesWire(ctx.github, []);
		ctx.github.add(labeled(14));
		ctx.github.posts = ["ok", "ok", "ok", "lost"];
		ctx.executor.outputs = [QUESTIONS_TEXT];
		ctx.executor.behaviors = [{ kind: "pass", usage: 3 }];
		await once(ctx.start());
		assert.deepEqual(statuses(ctx.github, 14), ["1:claimed", "2:running"]);
		ctx.executor.checkoutResult = "unavailable";
		ctx.clock.t += 60_000;
		const restarted = ctx.start();
		await once(restarted);
		assert.deepEqual(statuses(ctx.github, 14), ["1:claimed", "2:running"]);
		ctx.clock.t += 60_000;
		await once(restarted);
		assert.deepEqual(statuses(ctx.github, 14), ["1:claimed", "2:running"]);
		ctx.executor.checkoutResult = "ready";
		ctx.clock.t += 60_000;
		await once(restarted);
		assert.equal(statuses(ctx.github, 14).at(-1), "3:needs_info");
		assert.equal(ctx.executor.launches.length, 1);
	});

	it("posts one questions comment, swaps the labels, then ends needs_info and spends nothing more", async () => {
		const { github, clock, files, executor, wire, logs, start } = world();
		const writes: string[] = [];

		wire.intercept = writesWire(github, writes);
		github.add(labeled(14));
		executor.outputs = [QUESTIONS_TEXT];
		executor.behaviors = [{ kind: "pass", usage: 300 }];

		const controller = start();
		const first = await once(controller);

		assert.deepEqual(writes, [
			"marker:claimed",
			"marker:running",
			"questions",
			"label+factory:needs-info",
			"label-factory:ready",
			"marker:needs_info",
		]);
		assert.deepEqual(statuses(github, 14), [
			"1:claimed",
			"2:running",
			"3:needs_info",
		]);
		assert.deepEqual(github.issues.get(14)?.labels, ["factory:needs-info"]);
		assert.deepEqual(
			logs
				.filter(({ event }) => event === "label_write")
				.map(({ fields }) => fields.outcome),
			["posted", "posted"],
		);
		assert.equal(first.totals.usage, 300);
		assert.equal(files.contracts.size, 0);
		assert.ok(files.questions.has(runOf(14)));

		const [asked] = keyed(github, 14, "questions");

		assert.ok(
			asked?.includes(
				"Should the version come from package\\.json or a constant?",
			),
		);
		assert.ok(
			asked?.includes(
				`(https://github.com/${FAKE_REPO}/blob/${MAIN_SHA}/server/cli.ts#L1)`,
			),
		);

		writes.length = 0;

		for (let n = 0; n < 3; n++) {
			clock.t += 60_000;

			const report = await once(controller);

			assert.equal(report.totals.usage, 300);
		}

		assert.equal(executor.launches.length, 1);
		assert.deepEqual(writes, []);
	});

	it("posts the questions once when the first POST's outcome is unknown", async () => {
		const { github, clock, executor, wire, start } = world();

		wire.intercept = writesWire(github, []);
		github.add(labeled(14));
		github.posts = ["ok", "ok", "landed_unanswered"];
		executor.outputs = [QUESTIONS_TEXT];
		executor.behaviors = [{ kind: "pass", usage: 300 }];

		const controller = start();

		await controller.tick();
		await settle();
		await controller.drain(async () => settle());

		assert.equal(keyed(github, 14, "questions").length, 1);

		clock.t += 1_000;
		await once(controller);

		assert.equal(keyed(github, 14, "questions").length, 1);
		assert.deepEqual(statuses(github, 14), [
			"1:claimed",
			"2:running",
			"3:needs_info",
		]);
	});

	it("resumes an interrupted specify review in the same attempt and counts recorded sessions once", async () => {
		const ctx = world();
		const { github, executor, clock } = ctx;

		github.add(labeled(14));
		executor.behaviors = [{ kind: "hang" }];
		await ctx.start().tick();
		assert.deepEqual(statuses(github, 14), ["1:claimed", "2:running"]);

		executor.pending = true;
		executor.spentBy.set("specify-1", 300);
		executor.behaviors = [{ kind: "pass", usage: 20 }];
		clock.t += 60_000;
		const report = await once(ctx.start());

		assert.equal(
			executor.launches.filter((l) => l.stage === "specify").length,
			2,
		);
		assert.equal(executor.launches[1]?.attempt, 1);
		assert.equal(executor.launches[1]?.remainingRunTokens, 500_000 - 300);
		assert.equal(report.totals.usage, 320);
		assert.deepEqual(statuses(github, 14), [
			"1:claimed",
			"2:running",
			"3:claimed",
			"4:running",
			"5:claimed",
			"6:blocked",
		]);
	});

	it("recovers an interrupted specify attempt from its kept output without a second comment or launch", async () => {
		const ctx = world();
		const { github, executor, logs, wire } = ctx;
		const writes: string[] = [];

		wire.intercept = writesWire(github, writes);
		github.add(labeled(14));
		github.posts = ["ok", "ok", "ok", "lost"];
		executor.outputs = [QUESTIONS_TEXT];
		executor.behaviors = [{ kind: "pass", usage: 300 }];

		await once(ctx.start());

		assert.deepEqual(writes, [
			"marker:claimed",
			"marker:running",
			"questions",
			"label+factory:needs-info",
			"label-factory:ready",
			"marker:needs_info",
		]);
		assert.deepEqual(statuses(github, 14), ["1:claimed", "2:running"]);

		writes.length = 0;
		github.now = "2026-10-29T02:05:00Z";
		ctx.clock.t += 60_000;

		await once(ctx.start());

		assert.equal(executor.launches.length, 1);
		assert.equal(keyed(github, 14, "questions").length, 1);
		assert.deepEqual(statuses(github, 14), [
			"1:claimed",
			"2:running",
			"3:needs_info",
		]);
		assert.ok(logs.some((entry) => entry.event === "stage_recovered"));
		assert.deepEqual(writes, ["marker:needs_info"]);
	});
});

describe("specify: linked runs and answers", () => {
	const NEXT_EVENT = 34537529999;
	const nextRun = runIdOf({ repo, issue: 14, eventId: String(NEXT_EVENT) });

	async function askedThenRelabeled(
		answers: (github: FakeGitHub, issue: FakeIssue) => void,
		labelAt = "2026-10-29T02:20:00Z",
		configure: (ctx: ReturnType<typeof world>) => void = () => undefined,
	) {
		const ctx = world();
		const writes: string[] = [];

		ctx.wire.intercept = writesWire(ctx.github, writes);

		const issue = ctx.github.add(labeled(14));

		ctx.executor.outputs = [QUESTIONS_TEXT, CONTRACT_TEXT];
		ctx.executor.behaviors = [
			{ kind: "pass", usage: 300 },
			{ kind: "pass", usage: 900 },
		];

		const controller = ctx.start();

		await once(controller);

		ctx.github.now = "2026-10-29T02:10:00Z";
		answers(ctx.github, issue);
		ctx.github.now = labelAt;
		issue.labels.push(READY_LABEL);
		issue.timeline.push(
			labelEvent({ id: NEXT_EVENT, at: labelAt, actor: "giuseppecrj" }),
		);
		issue.updatedAt = labelAt;
		ctx.github.now = "2026-10-29T02:31:00Z";
		ctx.clock.t += 31 * 60_000;
		writes.length = 0;
		configure(ctx);

		const report = await once(controller);

		return { ...ctx, controller, report, writes, issue };
	}

	const user = (login: string) => ({
		login,
		type: "User" as const,
		appSlug: null,
	});

	it("continues after an explicitly unlinked needs_info run following a delayed questions comment (T-STUCK)", async () => {
		const ctx = world();
		const write = writesWire(ctx.github, []);
		const state = stateDir();
		const disk = fileRunFiles(state);
		ctx.files.writeLink = disk.writeLink;
		ctx.files.readLink = disk.readLink;
		ctx.files.writeAnswers = disk.writeAnswers;
		ctx.files.readAnswers = disk.readAnswers;
		let allowQuestions = false;
		ctx.wire.intercept = async (command, args) =>
			!allowQuestions &&
			args.some(
				(arg) =>
					arg.startsWith("body=") && arg.includes("<!-- factory-questions "),
			)
				? networkError()
				: write(command, args);
		const issue = ctx.github.add(labeled(14));
		ctx.executor.outputs = [QUESTIONS_TEXT, QUESTIONS_TEXT, CONTRACT_TEXT];
		ctx.executor.behaviors = [
			{ kind: "pass", usage: 3 },
			{ kind: "pass", usage: 3 },
			{ kind: "pass", usage: 3 },
		];
		const controller = ctx.start();
		await once(controller);
		assert.equal(controller.state.runs.get(14)?.phase.kind, "reporting");
		issue.timeline.push(
			labelEvent({
				id: EVENT_ID + 70,
				at: "2026-10-29T02:00:29Z",
				actor: "giuseppecrj",
				event: "unlabeled",
			}),
			labelEvent({
				id: EVENT_ID + 71,
				at: "2026-10-29T02:00:30Z",
				actor: "giuseppecrj",
			}),
		);
		issue.updatedAt = "2026-10-29T02:00:30Z";
		allowQuestions = true;

		for (let n = 2; n <= 5; n++) {
			ctx.github.now = `2026-10-29T02:0${n}:00Z`;
			ctx.clock.t += 60_000;
			await once(controller);
		}

		assert.equal(statuses(ctx.github, 14).at(-1), "6:needs_info");

		const unlinkedRun = runIdOf({
			repo,
			issue: 14,
			eventId: String(EVENT_ID + 71),
		});

		assert.ok(!ctx.logs.some(({ event }) => event === "run_linked"));

		ctx.github.now = "2026-10-29T02:10:00Z";
		ctx.github.comment(issue, "OWNER-ANSWER", user("giuseppecrj"));
		ctx.github.now = "2026-10-29T02:11:00Z";
		issue.labels.push(READY_LABEL);
		issue.timeline.push(
			labelEvent({
				id: EVENT_ID + 72,
				at: ctx.github.now,
				actor: "giuseppecrj",
			}),
		);
		issue.updatedAt = ctx.github.now;
		ctx.github.now = "2026-10-29T02:20:00Z";
		ctx.clock.t += 31 * 60_000;
		const report = await once(ctx.start());
		assert.deepEqual(report.refused, []);
		assert.equal(statuses(ctx.github, 14).at(-1), "10:blocked");
		assert.match(ctx.executor.launches[2]?.prompt ?? "", /OWNER-ANSWER/);
		assert.deepEqual(
			JSON.parse(
				readFileSync(join(state, "links", `${unlinkedRun}.json`), "utf8"),
			),
			{ version: 1, prevRunId: null },
		);
	});

	it("puts the original run ID on a linked terminal row without adding its tokens again", async () => {
		const outbox = fileLedgerOutbox(stateDir());

		const ctx = await askedThenRelabeled(
			(github, issue) => {
				github.comment(issue, "Use package.json.", user("giuseppecrj"));
			},
			undefined,
			({ files, executor }) => {
				Object.assign(files, { ledger: outbox });
				executor.outputs = [QUESTIONS_TEXT];
			},
		);

		const row = (await outbox.scan())?.[0]?.row?.row;
		assert.ok(row);
		assert.equal(row.runId, nextRun);
		assert.deepEqual(row.previousRunId, { kind: "known", value: runOf(14) });
		assert.equal(row.usage.tokens.total, 900);
		assert.equal(ctx.executor.launches.length, 2);
	});

	it("links a relabel after needs_info to the earlier run and feeds it only authorized answers", async () => {
		const { github, files, executor, logs, writes, report } =
			await askedThenRelabeled((github, issue) => {
				github.comment(issue, "Use package.json.", user("giuseppecrj"));
				github.comment(issue, "Use a constant.", user("triager"));
				github.comment(issue, "Bot echo.", {
					login: "dependabot[bot]",
					type: "Bot",
					appSlug: "dependabot",
				});
				github.comment(issue, "Edited after the label.", {
					...user("writer"),
					lastEditedAt: "2026-10-29T02:25:00Z",
				});
				github.comment(issue, "Writer agrees: package.json.", user("writer"));
			});

		assert.deepEqual(statuses(github, 14), [
			"1:claimed",
			"2:running",
			"3:needs_info",
			"4:claimed",
			"5:running",
			"6:claimed",
			"7:blocked",
		]);
		assert.deepEqual(writes, [
			"marker:claimed",
			"label-factory:needs-info",
			"marker:running",
			"summary",
			"marker:claimed",
			"marker:blocked",
		]);
		assert.deepEqual(report.corrupt, []);

		const link = files.links.get(nextRun);
		const answers = files.answers.get(nextRun);

		assert.equal(link?.prevRunId, runOf(14));
		assert.equal(link?.answersDigest, answers?.digest);
		assert.deepEqual(
			answers?.answers.map((answer) => [answer.author, answer.body]),
			[
				["giuseppecrj", "Use package.json."],
				["writer", "Writer agrees: package.json."],
			],
		);
		assert.ok(answers?.questions.includes("package\\.json or a constant"));

		const prompt = executor.launches[1]?.prompt ?? "";

		assert.ok(
			prompt.includes('"author":"giuseppecrj","body":"Use package.json."'),
		);
		assert.ok(!prompt.includes("Use a constant."));
		assert.ok(!prompt.includes("Bot echo."));
		assert.match(prompt, /<previous-questions-[0-9a-f]{32}>/);

		const contract = JSON.parse(files.contracts.get(nextRun)?.bytes ?? "{}");

		assert.deepEqual(contract.link, {
			prevRunId: runOf(14),
			questionsDigest: link?.questionsDigest,
			answersDigest: answers?.digest,
		});
		assert.ok(link?.questionsDigest);
		assert.ok(
			logs.some(
				(entry) => entry.event === "run_linked" && entry.fields.answers === 2,
			),
		);
		assert.deepEqual(github.issues.get(14)?.labels, [READY_LABEL]);
	});

	async function thirdRound(
		ctx: Awaited<ReturnType<typeof askedThenRelabeled>>,
	) {
		ctx.github.now = "2026-10-29T02:40:00Z";
		ctx.github.comment(ctx.issue, "ROUND-TWO-ANSWER", user("giuseppecrj"));
		ctx.github.now = "2026-10-29T02:50:00Z";
		ctx.issue.labels.push(READY_LABEL);
		ctx.issue.timeline.push(
			labelEvent({
				id: NEXT_EVENT + 1,
				at: ctx.github.now,
				actor: "giuseppecrj",
			}),
		);
		ctx.issue.updatedAt = ctx.github.now;
		ctx.clock.t = Date.parse("2026-10-29T03:00:00Z");
		ctx.github.now = "2026-10-29T03:00:00Z";

		return once(ctx.controller);
	}

	for (const defect of [
		"answers_digest",
		"answers_missing",
		"answers_corrupt",
		"link_unreadable",
		"link_missing",
	] as const) {
		it(`refuses ${defect} in earlier clarification records once per issue change and keeps the reason in status JSON`, async () => {
			const ctx = await askedThenRelabeled(
				(github, issue) => {
					github.comment(issue, "ROUND-ONE-ANSWER", user("writer"));
				},
				undefined,
				({ executor }) => {
					executor.outputs = [QUESTIONS_TEXT];
				},
			);

			const kept = ctx.files.answers.get(nextRun);
			assert.ok(kept);

			if (defect === "answers_digest") {
				const altered = { ...kept, questions: "TAMPERED" };
				ctx.files.answers.set(nextRun, {
					...altered,
					digest: answersDigestOf(altered),
				});
			} else if (defect === "answers_missing") {
				ctx.files.answers.delete(nextRun);
			} else if (defect === "answers_corrupt") {
				ctx.files.answers.set(nextRun, { ...kept, questions: "TAMPERED" });
			} else if (defect === "link_unreadable") {
				const read = ctx.files.readLink.bind(ctx.files);
				ctx.files.readLink = async (id) =>
					id === nextRun ? { kind: "unreadable" } : read(id);
			} else {
				ctx.files.links.delete(nextRun);
			}

			const before = ctx.logs.length;

			const reason = defect.startsWith("link")
				? "link_record_invalid"
				: "answers_record_invalid";

			const expected = [{ issue: 14, reasons: [reason] }];
			assert.deepEqual((await thirdRound(ctx)).refused, expected);
			const state = stateDir();

			for (let n = 0; n < 3; n++) {
				ctx.clock.t += 60_000;
				const report = await once(ctx.controller);
				assert.equal(await writeStatus(state, report), true);

				const status = await cli(
					["status", "--json", "--repo", repo, "--state-dir", state],
					ctx.github,
				);

				assert.equal(status.code, EXIT.ok);
				assert.deepEqual(
					JSON.parse(status.stdout).controller.lastTick.refused,
					expected,
				);
			}

			assert.equal(ctx.executor.launches.length, 2);

			const refusals = () =>
				ctx.logs
					.slice(before)
					.filter(({ event }) => event === "admission_refused");

			assert.equal(refusals().length, 1);
			assert.equal(refusals()[0]?.fields.retry, false);
			assert.equal(
				refusals()[0]?.fields.detail,
				defect.startsWith("link") ? "previous_link" : "previous_answers",
			);
			ctx.issue.updatedAt = "2026-10-29T03:05:00Z";
			ctx.clock.t += 600_000;
			await once(ctx.controller);
			assert.equal(refusals().length, 2);
		});
	}

	for (const outcome of ["unknown", "rejected"] as const) {
		it(`never gates or fails a linked run on ${outcome} cosmetic label removals and logs every retry`, async () => {
			const ctx = await askedThenRelabeled(
				(github, issue) => {
					github.comment(issue, "Use package.json.", user("writer"));
				},
				undefined,
				({ wire, github, executor }) => {
					const write = writesWire(github, []);
					wire.intercept = async (command, args) =>
						args.includes("DELETE") &&
						args.some((arg) => arg.endsWith("labels/factory%3Aneeds-info"))
							? outcome === "unknown"
								? networkError()
								: httpError(422, "denied")
							: write(command, args);
					executor.fallback = { kind: "unavailable" };
					executor.behaviors = [];
				},
			);

			assert.equal(ctx.executor.launches.length, 2);

			for (let n = 0; n < 4; n++) {
				ctx.clock.t += 60_000;
				await once(ctx.controller);
			}

			assert.ok(
				ctx.logs.filter(
					({ event, fields }) =>
						event === "label_write" &&
						fields.label === "factory:needs-info" &&
						fields.outcome === outcome,
				).length >= 4,
			);
			ctx.executor.behaviors = [{ kind: "pass", usage: 1 }];
			ctx.clock.t += 60_000;
			await once(ctx.controller);
			assert.equal(statuses(ctx.github, 14).at(-1)?.endsWith(":blocked"), true);
			assert.ok(ctx.files.contracts.has(nextRun));
			assert.ok(
				!ctx.logs.some(({ event }) => event === "label_retries_exhausted"),
			);
		});
	}

	it("does not remove and re-add a linked run's own needs-info after a crash before its marker", async () => {
		const writes: string[] = [];

		const ctx = await askedThenRelabeled(
			(github, issue) => {
				github.comment(issue, "ROUND-ONE-ANSWER", user("writer"));
			},
			undefined,
			({ executor, github, wire }) => {
				executor.outputs = [QUESTIONS_TEXT];
				github.posts = ["ok", "ok", "ok", "lost"];
				wire.intercept = writesWire(github, writes);
			},
		);

		writes.length = 0;
		ctx.clock.t += 60_000;
		await once(ctx.start());
		assert.equal(statuses(ctx.github, 14).at(-1), "6:needs_info");
		assert.ok(!writes.includes("label-factory:needs-info"));
		assert.ok(
			ctx.logs.some(({ event }) => event === "ready_label_already_removed"),
		);
	});

	it("reconstructs every earlier question round from legacy accumulated records after a restart", async () => {
		const ctx = await askedThenRelabeled(
			(github, issue) => {
				github.comment(issue, "ROUND-ONE-ANSWER", user("writer"));
			},
			undefined,
			({ executor }) => {
				executor.outputs = [
					JSON.stringify({
						kind: "questions",
						questions: [{ text: "SECOND-QUESTION?" }],
					}),
				];
			},
		);

		ctx.executor.outputs = [
			JSON.stringify({
				kind: "questions",
				questions: [{ text: "THIRD-QUESTION?" }],
			}),
		];
		ctx.executor.behaviors = [{ kind: "pass", usage: 1 }];
		await thirdRound(ctx);

		const thirdRun = runIdOf({
			repo,
			issue: 14,
			eventId: String(NEXT_EVENT + 1),
		});

		for (const id of [nextRun, thirdRun]) {
			const record = ctx.files.answers.get(id);
			const link = ctx.files.links.get(id);
			assert.ok(record && link);
			const { rounds: _rounds, ...legacy } = record;
			const digest = answersDigestOf(legacy);
			ctx.files.answers.set(id, { ...legacy, digest });
			ctx.files.links.set(id, { ...link, answersDigest: digest });
		}

		ctx.github.now = "2026-10-29T03:10:00Z";
		ctx.github.comment(ctx.issue, "ROUND-THREE-ANSWER", user("writer"));
		ctx.github.now = "2026-10-29T03:20:00Z";
		ctx.issue.labels.push(READY_LABEL);
		ctx.issue.timeline.push(
			labelEvent({
				id: NEXT_EVENT + 2,
				at: ctx.github.now,
				actor: "giuseppecrj",
			}),
		);
		ctx.issue.updatedAt = ctx.github.now;
		ctx.clock.t = Date.parse("2026-10-29T03:30:00Z");
		ctx.github.now = "2026-10-29T03:30:00Z";
		ctx.executor.behaviors = [{ kind: "pass", usage: 1 }];
		await once(ctx.start());
		const prompt = ctx.executor.launches[3]?.prompt.replaceAll("\\", "") ?? "";

		const positions = [
			"package.json or a constant",
			"ROUND-ONE-ANSWER",
			"SECOND-QUESTION",
			"ROUND-TWO-ANSWER",
			"THIRD-QUESTION",
			"ROUND-THREE-ANSWER",
		].map((text) => prompt.indexOf(text));

		assert.ok(
			positions.every(
				(at, index) =>
					at >= 0 && (index === 0 || at > (positions[index - 1] ?? -1)),
			),
		);
	});

	it("carries both clarification rounds in order with authors, distinct questions and a digest of the whole set", async () => {
		const ctx = await askedThenRelabeled(
			(github, issue) => {
				github.comment(issue, "ROUND-ONE-ANSWER", user("writer"));
			},
			undefined,
			({ executor }) => {
				executor.outputs = [
					JSON.stringify({
						kind: "questions",
						questions: [{ text: "ROUND-TWO-QUESTION?" }],
					}),
				];
			},
		);

		assert.equal(statuses(ctx.github, 14).at(-1), "6:needs_info");
		ctx.github.now = "2026-10-29T02:40:00Z";
		ctx.github.comment(ctx.issue, "ROUND-TWO-ANSWER", user("giuseppecrj"));
		ctx.github.now = "2026-10-29T02:50:00Z";
		ctx.issue.labels.push(READY_LABEL);
		ctx.issue.timeline.push(
			labelEvent({
				id: NEXT_EVENT + 1,
				at: ctx.github.now,
				actor: "giuseppecrj",
			}),
		);
		ctx.issue.updatedAt = ctx.github.now;
		ctx.clock.t = Date.parse("2026-10-29T03:00:00Z");
		ctx.github.now = "2026-10-29T03:00:00Z";
		ctx.executor.behaviors = [{ kind: "pass", usage: 5 }];
		await once(ctx.controller);

		const finalRun = runIdOf({
			repo,
			issue: 14,
			eventId: String(NEXT_EVENT + 1),
		});

		const record = ctx.files.answers.get(finalRun);
		assert.ok(record);
		assert.deepEqual(
			record.answers.map(({ author, body }) => [author, body]),
			[
				["writer", "ROUND-ONE-ANSWER"],
				["giuseppecrj", "ROUND-TWO-ANSWER"],
			],
		);
		assert.equal(record.digest, answersDigestOf(record));
		assert.notEqual(
			record.digest,
			answersDigestOf({ ...record, answers: record.answers.slice(1) }),
		);
		const prompt = ctx.executor.launches[2]?.prompt ?? "";
		assert.ok(
			prompt.indexOf("ROUND-ONE-ANSWER") < prompt.indexOf("ROUND-TWO-ANSWER"),
		);
		assert.match(prompt, /ROUND-ONE-ANSWER/);
		assert.match(prompt, /ROUND-TWO-ANSWER/);
		const readable = prompt.replaceAll("\\", "");
		assert.ok(readable.includes("package.json or a constant"));
		assert.match(readable, /ROUND-TWO-QUESTION/);
		const firstQuestion = readable.indexOf("package");
		assert.ok(firstQuestion < readable.indexOf("ROUND-ONE-ANSWER"));
		assert.ok(
			readable.indexOf("ROUND-ONE-ANSWER") <
				readable.indexOf("ROUND-TWO-QUESTION"),
		);
		assert.ok(
			readable.indexOf("ROUND-TWO-QUESTION") <
				readable.indexOf("ROUND-TWO-ANSWER"),
		);
	});

	it("excludes a pre-question id, a post-label comment and an edit in the label second", async () => {
		const { files } = await askedThenRelabeled((github, issue) => {
			const asked = issue.comments.find((comment) =>
				comment.body.includes("<!-- factory-questions "),
			);

			assert.ok(asked);
			github.comment(issue, "PRE-QUESTION", {
				...user("writer"),
				id: 1,
				createdAt: "2026-10-29T01:59:00Z",
			});
			github.comment(issue, "SAME-SECOND-EDIT", {
				...user("writer"),
				lastEditedAt: "2026-10-29T02:20:00Z",
			});
			github.comment(issue, "VALID", user("writer"));
			github.now = "2026-10-29T02:21:00Z";
			github.comment(issue, "POST-LABEL", user("writer"));
		});

		assert.deepEqual(
			files.answers.get(nextRun)?.answers.map(({ body }) => body),
			["VALID"],
		);
	});

	it("refuses a label in the needs_info marker's second", async () => {
		const { report, executor, files, logs } = await askedThenRelabeled(
			(_github, issue) => {
				const marker = issue.comments.findLast(
					(comment) => parseMarker(comment.body).kind === "marker",
				);

				assert.ok(marker);
				marker.createdAt = "2026-10-29T02:01:00Z";
			},
			"2026-10-29T02:01:00Z",
		);

		assert.deepEqual(report.refused, [
			{ issue: 14, reasons: ["ambiguous_snapshot"] },
		]);
		assert.equal(executor.launches.length, 1);
		assert.equal(files.links.size, 0);
		assert.ok(
			logs.some(
				({ event, fields }) =>
					event === "admission_refused" &&
					fields.detail === "answer_at_label_time",
			),
		);
	});

	it("persists the link and answers on disk before a rejected writeClaim and reuses their digest", async () => {
		let keptDigest = "";

		const ctx = await askedThenRelabeled(
			(github, issue) => {
				github.comment(issue, "Use package.json.", user("writer"));
			},
			undefined,
			({ files }) => {
				const disk = fileRunFiles(stateDir());
				const write = files.writeClaim.bind(files);
				files.writeAnswers = disk.writeAnswers;
				files.writeLink = disk.writeLink;
				files.readAnswers = disk.readAnswers;
				files.readLink = disk.readLink;
				files.writeClaim = async (claim) => {
					if (claim.runId !== nextRun) return write(claim);
					const link = await disk.readLink(nextRun);
					const answers = await disk.readAnswers(nextRun);
					assert.equal(link.kind, "found");
					assert.ok(answers);
					keptDigest = answers.digest;

					return false;
				};
			},
		);

		assert.ok(keptDigest);
		assert.equal(ctx.executor.launches.length, 1);
		ctx.files.writeClaim = async (claim) => {
			ctx.files.claims.set(claim.runId, claim);

			return true;
		};

		ctx.clock.t += 60_000;
		await once(ctx.controller);
		assert.equal((await ctx.files.readAnswers(nextRun))?.digest, keptDigest);
		assert.equal(
			ctx.executor.launches.filter((l) => l.stage === "specify").length,
			2,
		);
	});

	it("caches answer permissions once per author within admission", async () => {
		let permissionCalls = 0;
		await askedThenRelabeled(
			(github, issue) => {
				for (const body of ["first", "second", "third"])
					github.comment(issue, body, user("writer"));
			},
			undefined,
			({ github }) => {
				github.beforeCall = (args) => {
					if (
						args.some((arg) => arg.includes("collaborators/writer/permission"))
					)
						permissionCalls++;
				};
			},
		);
		assert.equal(permissionCalls, 1);
	});

	it("retries stale needs-info removal after adopting the linked claim", async () => {
		const ctx = await askedThenRelabeled(
			() => undefined,
			undefined,
			({ wire, github, executor }) => {
				const write = writesWire(github, []);
				wire.intercept = async (command, args) =>
					args.some((arg) => arg.endsWith("labels/factory%3Aneeds-info"))
						? httpError(422, "denied")
						: write(command, args);
				executor.behaviors = [{ kind: "unavailable" }];
			},
		);

		assert.ok(ctx.issue.labels.includes("factory:needs-info"));
		ctx.wire.intercept = writesWire(ctx.github, []);
		ctx.executor.behaviors = [{ kind: "pass", usage: 1 }];
		ctx.clock.t += 60_000;
		await once(ctx.start());
		assert.ok(!ctx.issue.labels.includes("factory:needs-info"));
	});

	it("still links a relabel with no answers, for an owner who edited the body", async () => {
		const { github, files } = await askedThenRelabeled(() => undefined);

		assert.equal(statuses(github, 14).at(-1), "7:blocked");
		assert.equal(files.links.get(nextRun)?.prevRunId, runOf(14));
		assert.deepEqual(files.answers.get(nextRun)?.answers, []);
	});

	it("refuses a relabel in the same second as an answer, as ambiguous", async () => {
		const { github, files, executor, logs, report } = await askedThenRelabeled(
			(github, issue) => {
				github.now = "2026-10-29T02:20:00Z";
				github.comment(issue, "Use package.json.", user("giuseppecrj"));
			},
		);

		assert.deepEqual(report.refused, [
			{ issue: 14, reasons: ["ambiguous_snapshot"] },
		]);
		assert.equal(executor.launches.length, 1);
		assert.equal(statuses(github, 14).length, 3);
		assert.equal(files.links.size, 0);
		assert.ok(
			logs.some(
				(entry) =>
					entry.event === "admission_refused" &&
					entry.fields.detail === "answer_at_label_time",
			),
		);
	});

	it("starts nothing on an answer without a fresh ready label", async () => {
		const { github, clock, executor, wire, start } = world();
		const issue = github.add(labeled(14));

		wire.intercept = writesWire(github, []);
		executor.outputs = [QUESTIONS_TEXT];
		executor.behaviors = [{ kind: "pass", usage: 300 }];

		const controller = start();

		await once(controller);
		assert.deepEqual(issue.labels, ["factory:needs-info"]);
		github.now = "2026-10-29T02:10:00Z";
		github.comment(issue, "Use package.json.", user("giuseppecrj"));
		clock.t += 60_000;
		await once(controller);

		assert.equal(executor.launches.length, 1);
		assert.equal(statuses(github, 14).length, 3);
	});
});

describe("ledger outbox enrollment", () => {
	const ledgerApi = (fake: LedgerGit) =>
		ledgerApiOf(
			new GitHubPublicationApi(
				fake.exec,
				ledgerRepo,
				{},
				async () => true,
				async () => {},
			),
		);

	async function remoteRows(fake: LedgerGit) {
		const tip = fake.refs.get("factory/ledger") ?? assert.fail("no ledger");
		const tree = fake.trees.get(`commit:${tip}`)?.get("tree");
		assert.ok(tree !== undefined && isGitSha(tree));

		const file = await readLedgerFile(
			new GitHubPublicationApi(fake.exec, ledgerRepo),
			tree,
		);

		return parseLedger(file.bytes);
	}

	function needsInfoWorld(outbox: LedgerOutbox) {
		const ctx = world(null, outbox);
		ctx.wire.intercept = writesWire(ctx.github, []);
		ctx.github.add(labeled(14));
		ctx.executor.outputs = [QUESTIONS_TEXT];
		ctx.executor.behaviors = [{ kind: "pass", usage: 300 }];

		return ctx;
	}

	async function instrument(files: RunFiles) {
		assert.equal(
			await files.accounting?.begin({
				v: 1,
				runId: runOf(14),
				startedAt: new Date(START).toISOString(),
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
			}),
			true,
		);
	}

	it("projects retained receipt facts, model identities and uncertain charges without counting aggregate children twice", async () => {
		const dir = stateDir();
		const outbox = fileLedgerOutbox(dir);
		const ctx = needsInfoWorld(outbox);
		const native = fileRunFiles(dir);
		ctx.files.accounting = native.accounting;
		ctx.files.terminalEvidence = native.terminalEvidence;
		await instrument(native);
		const controller = ctx.start();
		await controller.tick();
		const input = ctx.executor.launches[0];
		assert.ok(input);
		const receipt = resultOf(input, { kind: "passed" }, 300).receipt;
		const stage = join(dir, "stages", runOf(14), "specify-1");
		mkdirSync(join(stage, "draft"), { recursive: true });
		writeFileSync(join(stage, "receipt.json"), JSON.stringify(receipt));
		writeFileSync(join(stage, "specify.json"), "{}");
		writeFileSync(
			join(stage, "draft", "egress.requests.jsonl"),
			`${JSON.stringify({ kind: "result", req: 1, inputTokens: 300, outputTokens: 0 })}\n${JSON.stringify({ kind: "dispatch", req: 2, inputTokenEstimate: 20, maxOutputTokens: 100 })}\n`,
		);
		writeFileSync(
			join(stage, "draft", "receipt.json"),
			JSON.stringify({
				...receipt,
				models: { ...receipt.models, observed: "gpt-6.1-sol" },
				fallback: {
					requested: "xai/grok-4.6",
					observed: "grok-4.6",
					outcome: { kind: "passed" },
					settlement: { event: "agent_settled", aborted: false },
					refusal: null,
				},
			}),
		);
		await once(controller);
		const row = (await outbox.scan())?.[0]?.row?.row;
		assert.ok(row);
		assert.equal(row.stages.kind, "known");
		assert.equal(row.models.kind, "known");
		assert.deepEqual(row.usage.parentTokens, { kind: "known", value: 300 });
		assert.deepEqual(row.usage.childTokens, { kind: "known", value: 0 });
		assert.deepEqual(row.usage.unattributedTokens, {
			kind: "known",
			value: 120,
		});
		assert.deepEqual(row.previousRunId, { kind: "known", value: null });
		assert.equal(row.usage.tokens.total, 420);
		assert.equal(row.usage.tokens.kind, "uncertain");
		assert.ok(row.gaps.includes("request_unsettled"));
		assert.equal(
			row.stages.kind === "known" && row.stages.value[0]?.tokens.total,
			420,
		);
		assert.equal(
			row.stages.kind === "known" && row.stages.value[0]?.attempts.kind,
			"known",
		);
		assert.equal(
			row.models.kind === "known" && row.models.value[0]?.observed.kind,
			"known",
		);
		assert.equal(row.redactedReceiptDigests.length, 2);
		assert.equal(row.contextPressure.kind, "unavailable");
		assert.deepEqual(row.startedAt, {
			kind: "known",
			value: new Date(START).toISOString(),
		});
		assert.equal(row.provenance.kind, "production");
		assert.equal(row.models.kind === "known" && row.models.value.length, 2);
		assert.equal(
			row.models.kind === "known" && row.models.value[1]?.requested,
			"xai/grok-4.6",
		);

		const accept = join(dir, "stages", runOf(14), "accept-1");
		mkdirSync(accept);
		writeFileSync(
			join(accept, "receipt.json"),
			JSON.stringify({
				...receipt,
				stage: "accept",
				usage: { ...receipt.usage, total: 20, parent: 20, gateway: 20 },
			}),
		);
		const later = await native.terminalEvidence?.(runOf(14), 300, null);
		assert.deepEqual(
			later?.stages?.kind === "known" && later.stages.value.map((s) => s.stage),
			["specify", "accept"],
		);
	});

	it("makes accounting unavailable, never a known empty zero, when the stages directory cannot be read", async () => {
		const dir = stateDir();
		const native = fileRunFiles(dir);
		await instrument(native);

		const none = await native.terminalEvidence?.(runOf(14), 7, null);
		assert.deepEqual(none?.stages, { kind: "known", value: [] });

		mkdirSync(join(dir, "stages"), { recursive: true });
		writeFileSync(join(dir, "stages", runOf(14)), "not a directory");

		const unreadable = await native.terminalEvidence?.(runOf(14), 7, null);
		const gap = { kind: "unavailable", reason: "receipt_invalid" };
		assert.deepEqual(unreadable?.stages, gap);
		assert.deepEqual(unreadable?.models, gap);
		assert.deepEqual(unreadable?.usage, {
			tokens: {
				kind: "lower_bound",
				unit: "tokens",
				total: 7,
				reason: "receipt_invalid",
			},
			parentTokens: gap,
			childTokens: gap,
			unattributedTokens: gap,
			money: { kind: "unavailable", reason: "provider_not_reported" },
		});
		assert.deepEqual(unreadable?.redactedReceiptDigests, []);
	});

	it("records interrupted attempts on the terminal row without charging the interruption twice", async () => {
		const dir = stateDir();
		const outbox = fileLedgerOutbox(dir);
		const ctx = world(null, outbox);

		ctx.files.accounting = fileRunFiles(dir).accounting;
		await instrument(ctx.files);
		ctx.github.add(labeled(14));
		ctx.executor.behaviors = [{ kind: "hang" }];
		await ctx.start().tick();
		ctx.executor.spentBy.set("specify-1", 17);
		await ctx.start().tick();
		ctx.clock.t += 10_000;
		ctx.executor.behaviors = [{ kind: "refuse", usage: 3 }];
		await once(ctx.start());
		const row = (await outbox.scan())?.[0]?.row?.row;

		assert.ok(row);
		assert.deepEqual(row.interruptedAttempts, { kind: "known", value: 1 });
		assert.equal(row.usage.tokens.total, 20);
	});

	it("keeps the terminal snapshot before the needs_info marker and freezes one row after it", async () => {
		const dir = stateDir();
		const outbox = fileLedgerOutbox(dir);
		const ctx = needsInfoWorld(outbox);
		const runDir = join(dir, "ledger", runOf(14));
		const seen: string[] = [];
		const writes: string[] = [];
		const inner = writesWire(ctx.github, writes);

		ctx.wire.intercept = async (command, args) => {
			const body = args.find((arg) => arg.startsWith("body="))?.slice(5) ?? "";
			const parsed = parseMarker(body);

			if (parsed.kind === "marker" && parsed.marker.status === "needs_info")
				seen.push(
					`${existsSync(join(runDir, "terminal.json"))}:${existsSync(join(runDir, "row.json"))}`,
				);

			return inner(command, args);
		};

		await once(ctx.start());
		assert.equal(statuses(ctx.github, 14).at(-1), "3:needs_info");
		assert.deepEqual(seen, ["true:false"]);

		const jobs = (await outbox.scan()) ?? assert.fail("scan");
		assert.equal(jobs.length, 1);
		const row = jobs[0]?.row?.row ?? assert.fail("row");
		assert.equal(row.outcome.kind, "needs_info");
		assert.equal(row.terminalMarker.seq, 3);
		assert.deepEqual(row.usage.tokens, {
			kind: "lower_bound",
			unit: "tokens",
			total: 300,
			reason: "not_instrumented",
		});
		assert.equal(row.usage.money.kind, "unavailable");
		assert.equal(row.issue, 14);

		const fake = new LedgerGit();
		const first = await pumpLedger(outbox, ledgerApi(fake), ctx.clock.now());
		assert.equal(first.published, 1);
		assert.equal(first.pending, 0);
		const again = await pumpLedger(outbox, ledgerApi(fake), ctx.clock.now());
		assert.deepEqual([again.published, again.pending], [0, 0]);

		const restarted = ctx.start();
		await once(restarted);
		await once(restarted);
		assert.deepEqual(await outbox.scan(), []);
		const rows = await remoteRows(fake);
		assert.equal(rows.length, 1);
		assert.equal(rows[0]?.kind === "known" && rows[0].row.runId, runOf(14));
	});

	it("finishes the row from the confirmed marker after a crash before row.json", async () => {
		const dir = stateDir();
		const outbox = fileLedgerOutbox(dir);
		const ctx = needsInfoWorld(outbox);
		await once(ctx.start());
		const rowPath = join(dir, "ledger", runOf(14), "row.json");
		const before = readFileSync(rowPath);
		rmSync(rowPath);
		assert.equal((await outbox.scan())?.[0]?.row, null);

		const restarted = ctx.start();
		await once(restarted);
		await once(restarted);
		assert.ok(readFileSync(rowPath).equals(before));
		assert.equal(ctx.executor.launches.length, 1);
	});

	it("posts no marker for an unencodable snapshot, reports it blocked, and ends once it encodes", async () => {
		const dir = stateDir();
		const outbox = fileLedgerOutbox(dir);
		const ctx = needsInfoWorld(outbox);
		const native = fileRunFiles(dir);
		let mismatched = true;

		ctx.files.accounting = {
			...(native.accounting ?? assert.fail("accounting")),
			start: async (runId) => {
				const start = await native.accounting?.start(runId);

				return start == null || !mismatched
					? start
					: {
							...start,
							policy: { ...start.policy, workflowDigest: digestOf("other") },
						};
			},
		};
		await instrument(native);
		const controller = ctx.start();
		await once(controller);

		assert.notEqual(statuses(ctx.github, 14).at(-1), "3:needs_info");
		assert.ok(ctx.logs.some((entry) => entry.event === "ledger_row_invalid"));
		assert.deepEqual(
			((await outbox.scan()) ?? assert.fail("scan")).map((job) => [
				job.runId,
				job.row,
				job.retry?.reason,
				job.retry?.blocked,
			]),
			[[runOf(14), null, "row_invalid", true]],
		);
		const backlog = await readLedgerBacklog(dir, ctx.clock.now());
		assert.deepEqual(
			[backlog.state, backlog.pending, backlog.blocked, backlog.lastError],
			["blocked", 1, 1, "row_invalid"],
		);

		mismatched = false;
		ctx.clock.t += 60_000;
		await once(controller);
		assert.equal(statuses(ctx.github, 14).at(-1), "3:needs_info");
		assert.equal(
			(await outbox.scan())?.[0]?.row?.row.outcome.kind,
			"needs_info",
		);
		assert.equal(ctx.executor.launches.length, 1);
	});

	it("retries a failed freeze on later ticks until row.json is durable, without a restart", async () => {
		const dir = stateDir();
		const real = fileLedgerOutbox(dir);
		let failures = 3;
		let calls = 0;

		const outbox: LedgerOutbox = {
			...real,
			freeze: async (runId, marker) => {
				calls += 1;

				if (failures > 0) {
					failures -= 1;

					return "unwritable";
				}

				return real.freeze(runId, marker);
			},
		};

		const ctx = needsInfoWorld(outbox);
		const controller = ctx.start();
		const rowPath = join(dir, "ledger", runOf(14), "row.json");

		for (let tick = 0; tick < 6 && !existsSync(rowPath); tick++) {
			ctx.clock.t += 60_000;
			await once(controller);
		}

		assert.equal(statuses(ctx.github, 14).at(-1), "3:needs_info");
		assert.equal(existsSync(rowPath), true);
		assert.equal(calls, 4);
		const settled = calls;
		await once(controller);
		await once(controller);
		assert.equal(calls, settled);
		assert.equal(ctx.executor.launches.length, 1);
	});

	it("serve pumps the outbox after every tick", async () => {
		const ctx = world();
		const stop = new AbortController();
		const order: string[] = [];
		let ticks = 0;

		await serveLoop({
			orchestrator: ctx.start(),
			stateDir: stateDir(),
			signal: stop.signal,
			log: () => {},
			pump: async () => {
				order.push(`pump${ticks}`);

				return null;
			},
			sleep: async () => {
				ticks += 1;
				order.push(`sleep${ticks}`);

				if (ticks === 2) stop.abort();
			},
		});

		assert.deepEqual(order, ["pump0", "sleep1", "pump1", "sleep2"]);
	});

	it("posts no terminal marker while the snapshot cannot be written, then ends once it can", async () => {
		const dir = stateDir();
		const real = fileLedgerOutbox(dir);
		let writable = false;

		const outbox: LedgerOutbox = {
			...real,
			prepare: async (runId, snapshot) =>
				writable && real.prepare(runId, snapshot),
		};

		const ctx = needsInfoWorld(outbox);
		const controller = ctx.start();
		await once(controller);
		assert.notEqual(statuses(ctx.github, 14).at(-1), "3:needs_info");
		assert.ok(
			ctx.logs.some((entry) => entry.event === "ledger_terminal_unwritable"),
		);

		writable = true;
		ctx.clock.t += 60_000;
		await once(controller);
		assert.equal(statuses(ctx.github, 14).at(-1), "3:needs_info");
		assert.equal(
			(await outbox.scan())?.[0]?.row?.row.outcome.kind,
			"needs_info",
		);
		assert.equal(ctx.executor.launches.length, 1);
	});
});
