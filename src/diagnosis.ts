import { isDigest, digestOf, type Digest } from "./run.ts";
import type { Contract, ContractDigest, CriterionKind } from "./specify.ts";
import {
	isGitSha,
	isRepoSlug,
	type GitSha,
	type RepoSlug,
} from "./workflow.ts";
import { isContractDigest } from "./specify.ts";
import {
	arrayOf,
	countOf,
	fieldOf,
	objectOf,
	parseJson,
	textOf,
	textsOf,
} from "../server/sandbox/json.ts";
import type { JsonValue } from "./tickets.ts";

export type AcceptanceBinding = Readonly<{
	runId: Digest;
	repo: RepoSlug;
	issue: number;
	contractDigest: ContractDigest;
	acceptanceDigest: Digest;
	baseSha: GitSha;
	gateSha: GitSha;
}>;

export type BaseCheckReference = Readonly<{
	binding: AcceptanceBinding;
	acceptAttempt: number;
	remainingAcceptMs: number;
}>;

export function parseAcceptanceBinding(
	value: JsonValue | undefined,
): AcceptanceBinding | null {
	const v = objectOf(value);

	const runId = textOf(fieldOf(v, "runId")) ?? "",
		repo = textOf(fieldOf(v, "repo")) ?? "",
		issue = countOf(fieldOf(v, "issue"));

	const contractDigest = textOf(fieldOf(v, "contractDigest")) ?? "",
		acceptanceDigest = textOf(fieldOf(v, "acceptanceDigest")) ?? "",
		baseSha = textOf(fieldOf(v, "baseSha")) ?? "",
		gateSha = textOf(fieldOf(v, "gateSha")) ?? "";

	return isDigest(runId) &&
		isRepoSlug(repo) &&
		issue !== null &&
		issue > 0 &&
		isContractDigest(contractDigest) &&
		isDigest(acceptanceDigest) &&
		isGitSha(baseSha) &&
		isGitSha(gateSha)
		? { runId, repo, issue, contractDigest, acceptanceDigest, baseSha, gateSha }
		: null;
}

export function parseBaseCheckReference(
	value: JsonValue | undefined,
): BaseCheckReference | null {
	const v = objectOf(value),
		binding = parseAcceptanceBinding(fieldOf(v, "binding")),
		acceptAttempt = countOf(fieldOf(v, "acceptAttempt")),
		remainingAcceptMs = countOf(fieldOf(v, "remainingAcceptMs"));

	return binding !== null &&
		acceptAttempt !== null &&
		acceptAttempt >= 1 &&
		remainingAcceptMs !== null
		? { binding, acceptAttempt, remainingAcceptMs }
		: null;
}

export type RuntimeIdentity = Readonly<{
	runner: string;
	node: string;
	platform: string;
	bwrap: string;
	protocolDigest: Digest;
}>;

export type TestFailure = Readonly<{
	file: string;
	name: string;
	message: string;
	code: string | null;
	kind:
		| "assertion"
		| "runtime_error"
		| "load_error"
		| "timeout"
		| "skip"
		| "todo"
		| "cancelled";
}>;

export type FileObservation = Readonly<{
	file: string;
	registered: number;
	failures: readonly TestFailure[];
}>;

export type PrivateExecution =
	| Readonly<{
			kind: "observed";
			files: readonly FileObservation[];
			exitCode: number;
			wallMs: number;
	  }>
	| Readonly<{
			kind: "unavailable";
			reason: "runner_error" | "timeout" | "invalid_report";
			wallMs: number;
	  }>;

export type OracleKey = Readonly<{
	contractScopeDigest: Digest;
	criteriaDigest: Digest;
	sourceDigest: Digest;
}>;

export type BaseReason =
	| "acceptance_not_reproduced"
	| "preservation_failed"
	| "base_load_error"
	| "base_no_tests"
	| "base_runner_error"
	| "base_timeout"
	| "base_non_assertion_failure"
	| "base_skip"
	| "base_todo"
	| "base_cancelled"
	| "base_tree_unsupported"
	| "base_interrupted"
	| "base_nondeterministic"
	| "base_evidence_missing";

export type ScenarioBaseEvidence = Readonly<{
	scenario: string;
	kind: CriterionKind;
}> &
	(
		| Readonly<{ mode: "checked"; file: string; oracleKey: OracleKey }>
		| Readonly<{ mode: "judge_only" }>
	);

export type BaseEvidence = Readonly<{
	binding: AcceptanceBinding;
	runtime: RuntimeIdentity;
	startedAt: number;
	finishedAt: number;
	source:
		| Readonly<{
				kind: "ready";
				treeDigest: Digest;
				lockDigest: Digest;
				gatesDigest: Digest;
		  }>
		| Readonly<{ kind: "unavailable"; reason: string }>;
	execution: PrivateExecution;
	repeat: PrivateExecution;
	scenarios: readonly ScenarioBaseEvidence[];
}>;

export type ScenarioBaseResult = Readonly<{
	scenario: string;
	kind: CriterionKind;
	result: "expected_red" | "preserved" | "judge_only" | BaseReason;
}>;

export type BaseReceipt = Readonly<{
	evidence: BaseEvidence;
	results: readonly ScenarioBaseResult[];
}>;

const qualified = Symbol("qualified-base");

export type BaseProof = Readonly<{
	binding: AcceptanceBinding;
	receiptDigest: Digest;
	[qualified]: true;
}>;

export type BaseRefusal = Readonly<{
	binding: AcceptanceBinding;
	receiptDigest: Digest;
	reason: BaseReason;
	scenarios: readonly string[];
}>;

export type BaseAssessment =
	| Readonly<{ kind: "ready"; proof: BaseProof }>
	| Readonly<{ kind: "refused"; failure: BaseRefusal }>;

export type BaseCheckInput = Readonly<{
	binding: AcceptanceBinding;
	acceptAttempt: number;
	remainingAcceptMs: number;
	signal: AbortSignal;
	allowLaunch?: boolean;
	readOnly?: boolean;
}>;

export type BaseCheckProgress =
	| Readonly<{ kind: "checking" }>
	| Readonly<{ kind: "interrupted"; wallMs: number }>
	| BaseAssessment;

export function oracleKey(
	contract: Contract,
	criteria: readonly string[],
	source: string,
): OracleKey {
	const scope = {
		base: contract.base,
		summary: contract.summary,
		behavior: contract.behavior,
		exclusions: contract.exclusions,
		acceptance: contract.acceptance,
		compatibility: contract.compatibility,
		limits: contract.limits,
		files: contract.files,
		replacesTests: contract.replacesTests ?? [],
	};

	return {
		contractScopeDigest: digestOf(JSON.stringify(scope)),
		criteriaDigest: digestOf(
			JSON.stringify(
				contract.acceptance.filter((c) => criteria.includes(c.id)),
			),
		),
		sourceDigest: digestOf(source),
	};
}

export const BASE_PROTOCOL_VERSION = "heldout-base-v2-2";

const UNSUPPORTED_TREE: ReadonlySet<string> = new Set([
	"tree_partial",
	"tree_refused",
	"gates_missing",
]);

export function matchingBaseProof(
	proof: BaseProof,
	binding: AcceptanceBinding,
): boolean {
	return (
		proof[qualified] === true &&
		JSON.stringify(proof.binding) === JSON.stringify(binding)
	);
}

export type BaseEvaluation = Readonly<{
	receipt: BaseReceipt;
	assessment: BaseAssessment;
}>;

export function executionOutcomes(execution: PrivateExecution): string | null {
	return execution.kind === "observed"
		? JSON.stringify(
				execution.files
					.map((f) => [f.file, f.registered, signature([f])])
					.toSorted((a, b) => (String(a[0]) < String(b[0]) ? -1 : 1)),
			)
		: null;
}

export function assessBase(evidence: BaseEvidence): BaseEvaluation {
	const execution = evidence.execution;

	const unavailable = [execution, evidence.repeat].find(
		(x) => x.kind === "unavailable",
	);

	const global: BaseReason | null =
		evidence.source.kind !== "ready"
			? UNSUPPORTED_TREE.has(evidence.source.reason)
				? "base_tree_unsupported"
				: "base_runner_error"
			: unavailable?.kind === "unavailable"
				? unavailable.reason === "timeout"
					? "base_timeout"
					: unavailable.reason === "runner_error"
						? "base_runner_error"
						: "base_evidence_missing"
				: executionOutcomes(execution) !== executionOutcomes(evidence.repeat)
					? "base_nondeterministic"
					: null;

	const results: ScenarioBaseResult[] = evidence.scenarios.map((s) => {
		if (global !== null)
			return { scenario: s.scenario, kind: s.kind, result: global };

		if (s.mode === "judge_only")
			return { scenario: s.scenario, kind: s.kind, result: "judge_only" };

		if (execution.kind !== "observed") throw new Error("unreachable execution");
		const file = execution.files.find((f) => f.file === s.file);
		let result: ScenarioBaseResult["result"];

		if (file === undefined) result = "base_evidence_missing";
		else if (file.failures.some((f) => f.kind === "load_error"))
			result = "base_load_error";
		else if (file.registered === 0) result = "base_no_tests";
		else if (file.failures.some((f) => f.kind === "timeout"))
			result = "base_timeout";
		else if (file.failures.some((f) => f.kind === "runtime_error"))
			result = "base_non_assertion_failure";
		else if (file.failures.some((f) => f.kind === "skip")) result = "base_skip";
		else if (file.failures.some((f) => f.kind === "todo")) result = "base_todo";
		else if (file.failures.some((f) => f.kind === "cancelled"))
			result = "base_cancelled";
		else if (s.kind === "preservation")
			result = file.failures.length === 0 ? "preserved" : "preservation_failed";
		else
			result = file.failures.some(
				(f) => f.kind === "assertion" && f.code === "ERR_ASSERTION",
			)
				? "expected_red"
				: "acceptance_not_reproduced";

		return { scenario: s.scenario, kind: s.kind, result };
	});

	const receipt = { evidence, results };
	const receiptDigest = digestOf(JSON.stringify(receipt));

	const refused = results.filter(
		(r) =>
			r.result !== "expected_red" &&
			r.result !== "preserved" &&
			r.result !== "judge_only",
	);

	const first = refused[0];

	if (
		first !== undefined &&
		first.result !== "expected_red" &&
		first.result !== "preserved" &&
		first.result !== "judge_only"
	)
		return {
			receipt,
			assessment: {
				kind: "refused",
				failure: {
					binding: evidence.binding,
					receiptDigest,
					reason: first.result,
					scenarios: refused.map((r) => r.scenario),
				},
			},
		};

	if (
		results.length === 0 ||
		!evidence.scenarios.some((s) => s.mode === "checked")
	)
		return {
			receipt,
			assessment: {
				kind: "refused",
				failure: {
					binding: evidence.binding,
					receiptDigest,
					reason: "base_no_tests",
					scenarios: [],
				},
			},
		};

	return {
		receipt,
		assessment: {
			kind: "ready",
			proof: { binding: evidence.binding, receiptDigest, [qualified]: true },
		},
	};
}

function parseExecution(value: JsonValue | undefined): PrivateExecution | null {
	const x = objectOf(value),
		wallMs = countOf(fieldOf(x, "wallMs"));

	if (wallMs === null) return null;

	if (fieldOf(x, "kind") === "unavailable") {
		const reason = fieldOf(x, "reason");

		if (
			reason !== "runner_error" &&
			reason !== "timeout" &&
			reason !== "invalid_report"
		)
			return null;

		return { kind: "unavailable", reason, wallMs };
	}

	const exitCode = countOf(fieldOf(x, "exitCode")),
		rawFiles = arrayOf(fieldOf(x, "files"));

	if (
		fieldOf(x, "kind") !== "observed" ||
		exitCode === null ||
		rawFiles === null
	)
		return null;
	const files: FileObservation[] = [];

	for (const raw of rawFiles) {
		const v = objectOf(raw),
			file = textOf(fieldOf(v, "file")),
			registered = countOf(fieldOf(v, "registered")),
			rawFailures = arrayOf(fieldOf(v, "failures"));

		if (file === null || registered === null || rawFailures === null)
			return null;
		const failures: TestFailure[] = [];

		for (const item of rawFailures) {
			const f = objectOf(item),
				failureFile = textOf(fieldOf(f, "file")),
				name = textOf(fieldOf(f, "name")),
				message = textOf(fieldOf(f, "message")),
				code = fieldOf(f, "code"),
				kind = fieldOf(f, "kind");

			if (
				failureFile !== file ||
				name === null ||
				name.length > 300 ||
				message === null ||
				message.length > 200 ||
				(code !== null && textOf(code) === null) ||
				(kind !== "assertion" &&
					kind !== "runtime_error" &&
					kind !== "load_error" &&
					kind !== "timeout" &&
					kind !== "skip" &&
					kind !== "todo" &&
					kind !== "cancelled")
			)
				return null;
			failures.push({ file, name, message, code: textOf(code), kind });
		}

		files.push({ file, registered, failures });
	}

	return { kind: "observed", exitCode, wallMs, files };
}

export function parseBaseReceipt(text: string): BaseReceipt | null {
	const record = objectOf(parseJson(text));
	const e = objectOf(fieldOf(record, "evidence"));
	const binding = parseAcceptanceBinding(fieldOf(e, "binding"));
	const r = objectOf(fieldOf(e, "runtime"));

	const runner = textOf(fieldOf(r, "runner")),
		node = textOf(fieldOf(r, "node")),
		platform = textOf(fieldOf(r, "platform")),
		bwrap = textOf(fieldOf(r, "bwrap")),
		protocolDigest = textOf(fieldOf(r, "protocolDigest")) ?? "";

	const startedAt = countOf(fieldOf(e, "startedAt")),
		finishedAt = countOf(fieldOf(e, "finishedAt"));

	const s = objectOf(fieldOf(e, "source")),
		sourceKind = fieldOf(s, "kind"),
		treeDigest = textOf(fieldOf(s, "treeDigest")) ?? "",
		lockDigest = textOf(fieldOf(s, "lockDigest")) ?? "",
		gatesDigest = textOf(fieldOf(s, "gatesDigest")) ?? "",
		sourceReason = textOf(fieldOf(s, "reason"));

	const rawScenarios = arrayOf(fieldOf(e, "scenarios"));

	if (
		binding === null ||
		runner === null ||
		node === null ||
		platform === null ||
		bwrap === null ||
		!isDigest(protocolDigest) ||
		startedAt === null ||
		finishedAt === null ||
		finishedAt < startedAt ||
		rawScenarios === null
	)
		return null;

	const source: BaseEvidence["source"] | null =
		sourceKind === "ready" &&
		isDigest(treeDigest) &&
		isDigest(lockDigest) &&
		isDigest(gatesDigest)
			? { kind: "ready", treeDigest, lockDigest, gatesDigest }
			: sourceKind === "unavailable" && sourceReason !== null
				? { kind: "unavailable", reason: sourceReason }
				: null;

	if (source === null) return null;
	const scenarios: ScenarioBaseEvidence[] = [];

	for (const raw of rawScenarios) {
		const v = objectOf(raw),
			scenario = textOf(fieldOf(v, "scenario")),
			kind = fieldOf(v, "kind"),
			mode = fieldOf(v, "mode"),
			file = textOf(fieldOf(v, "file"));

		if (
			scenario === null ||
			!/^S[1-9][0-9]{0,2}$/.test(scenario) ||
			(kind !== "new_behavior" && kind !== "preservation")
		)
			return null;

		if (mode === "judge_only") scenarios.push({ scenario, kind, mode });
		else {
			const key = objectOf(fieldOf(v, "oracleKey")),
				contractScopeDigest = textOf(fieldOf(key, "contractScopeDigest")) ?? "",
				criteriaDigest = textOf(fieldOf(key, "criteriaDigest")) ?? "",
				sourceDigest = textOf(fieldOf(key, "sourceDigest")) ?? "";

			if (
				mode !== "checked" ||
				file === null ||
				!isDigest(contractScopeDigest) ||
				!isDigest(criteriaDigest) ||
				!isDigest(sourceDigest)
			)
				return null;
			scenarios.push({
				scenario,
				kind,
				mode,
				file,
				oracleKey: { contractScopeDigest, criteriaDigest, sourceDigest },
			});
		}
	}

	const execution = parseExecution(fieldOf(e, "execution")),
		repeat = parseExecution(fieldOf(e, "repeat"));

	if (execution === null || repeat === null) return null;

	const evidence: BaseEvidence = {
		binding,
		runtime: { runner, node, platform, bwrap, protocolDigest },
		startedAt,
		finishedAt,
		source,
		execution,
		repeat,
		scenarios,
	};

	const { receipt } = assessBase(evidence);

	return JSON.stringify(receipt) === JSON.stringify(record) ? receipt : null;
}

export function baseRefusalNotice(failure: BaseRefusal) {
	const reasons: Record<BaseReason, string> = {
		acceptance_not_reproduced:
			"Acceptance does not reproduce the ticket on the unchanged base.",
		preservation_failed: "A preservation check fails on the unchanged base.",
		base_load_error: "A check could not load on the unchanged base.",
		base_no_tests: "A check registered no tests.",
		base_runner_error: "The isolated base runner could not execute.",
		base_timeout: "Base qualification exceeded its deadline.",
		base_non_assertion_failure: "A check raised a non-assertion error.",
		base_skip: "A check skipped a test.",
		base_todo: "A check left a test as todo.",
		base_cancelled: "A check cancelled a test.",
		base_tree_unsupported:
			"The unchanged base tree is partial or lacks its trusted gates.",
		base_interrupted:
			"Base qualification was interrupted on every accept attempt.",
		base_nondeterministic:
			"Two base runs of the checks gave different results.",
		base_evidence_missing:
			"Base qualification evidence is incomplete or invalid.",
	};

	const key = `<!-- factory-base-refusal run=${failure.binding.runId} r=${failure.receiptDigest} -->`;
	const ids = failure.scenarios.filter((s) => /^S[1-9][0-9]{0,2}$/.test(s));

	return {
		key,
		body: `Acceptance refused before build: ${failure.reason}. ${reasons[failure.reason]}${ids.length ? ` Scenarios: ${ids.join(", ")}.` : ""}\n\n${key}`,
	};
}

export type MissingEvidenceReason =
	| "assessment_missing"
	| "identity_mismatch"
	| "incomplete_ci"
	| "base_missing"
	| "invalid_report"
	| "unsupported_tree"
	| "materialize_mismatch"
	| "ci_replay_disagrees"
	| "tree_replays_disagree";

export type InfrastructureReason =
	| "runner_unavailable"
	| "runner_error"
	| "timeout"
	| "dependency_transport"
	| "baseline_failed"
	| "interrupted";

export type FailureClass =
	| Readonly<{
			kind: "candidate";
			reason: "candidate_check" | "candidate_heldout";
			scenarios: readonly string[];
	  }>
	| Readonly<{
			kind: "oracle";
			cause: "unexpected_base";
			scenarios: readonly string[];
	  }>
	| Readonly<{
			kind: "missing_evidence";
			reason: Exclude<MissingEvidenceReason, "materialize_mismatch">;
	  }>
	| Readonly<{
			kind: "missing_evidence";
			reason: "materialize_mismatch";
			differing: number;
	  }>
	| Readonly<{ kind: "infrastructure"; reason: InfrastructureReason }>;

export type HeldoutProjection = Readonly<{
	counts: Readonly<Record<string, number>>;
	failed: readonly string[];
	passed: boolean;
}>;

export type TreeReplay = Readonly<{
	execution: PrivateExecution;
	projection: HeldoutProjection;
}>;

export type HeldoutReplay =
	| Readonly<{
			kind: "unavailable";
			reason:
				| "timeout"
				| "runner_error"
				| "dependency_transport"
				| "unsupported_tree"
				| "suite_mismatch";
			wallMs: number;
	  }>
	| Readonly<{
			kind: "observed";
			files: readonly string[];
			gate: TreeReplay;
			full: TreeReplay;
			wallMs: number;
	  }>;

export type DiagnosisIdentity = Readonly<{
	gateSha: GitSha;
	candidateSha: GitSha;
	nonce: string;
	heldoutDigest: string;
	replacementsDigest: string;
}>;

export type CheckedScenario = Readonly<{
	scenario: string;
	kind: CriterionKind;
	file: string;
}>;

export type ClassifyInput = Readonly<{
	receipt: JsonValue | undefined;
	identity: DiagnosisIdentity;
	expected: readonly string[];
	scenarios: readonly CheckedScenario[];
	base: BaseReceipt | null;
	ignoredChanges: readonly string[] | null;
	replay: HeldoutReplay | null;
	dependencies: Readonly<{ reason: string | null }> | null;
	candidatePaths: readonly string[] | null;
}>;

const SCANNED_ABORTS: ReadonlySet<string> = new Set([
	"runtime_patching",
	"suppression_added",
	"invalid_source_encoding",
]);

const CANDIDATE_ABORTS: ReadonlySet<string> = new Set([
	"npmrc_changed",
	"replacement_deleted",
	"unauthorized_acceptance",
	"runtime_patching",
	"suppression_added",
	"invalid_source_encoding",
]);

const DEPENDENCY_ABORTS: ReadonlySet<string> = new Set([
	"invalid_dependency_manifest",
	"invalid_dependency_spec",
	"invalid_dependency_lock",
	"invalid_dependency_url",
	"package_swap",
]);

const INFRASTRUCTURE_ABORTS: ReadonlyMap<string, InfrastructureReason> =
	new Map([
		["runner_error", "runner_error"],
		["baseline_failed", "baseline_failed"],
		["baseline_deadline", "timeout"],
		["dependency_fetch_failed", "dependency_transport"],
		["dependency_integrity", "dependency_transport"],
	]);

const NORMAL_CHECKS = [
	"baseline_tests",
	"typecheck",
	"lint",
	"format",
	"main_tests",
	"candidate_tests",
	"heldout",
] as const;

type ReceiptCheck = Readonly<{
	name: string;
	exitCode: number;
	timedOut: boolean;
	signal: string | null;
}>;

const missing = (
	reason: Exclude<MissingEvidenceReason, "materialize_mismatch">,
): FailureClass => ({
	kind: "missing_evidence",
	reason,
});

const infrastructure = (reason: InfrastructureReason): FailureClass => ({
	kind: "infrastructure",
	reason,
});

function sameList(a: readonly string[], b: readonly string[]): boolean {
	return JSON.stringify(a.toSorted()) === JSON.stringify(b.toSorted());
}

function signature(files: readonly FileObservation[]): string {
	return JSON.stringify(
		files
			.map((f) => [
				f.file,
				f.failures
					.map((x) => JSON.stringify([x.name, x.kind, x.code]))
					.toSorted(),
			])
			.toSorted((a, b) => (String(a[0]) < String(b[0]) ? -1 : 1)),
	);
}

export type DiagnosisNeeds = Readonly<{
	replay: boolean;
	dependencies: boolean;
}>;

export function diagnosisNeeds(receipt: JsonValue | undefined): DiagnosisNeeds {
	const r = objectOf(receipt);
	const reason = textOf(fieldOf(r, "reason"));

	const heldout = (arrayOf(fieldOf(r, "checks")) ?? []).some((c) => {
		const check = objectOf(c);

		return (
			fieldOf(check, "name") === "heldout" && fieldOf(check, "exitCode") !== 0
		);
	});

	return {
		replay: reason === null && fieldOf(r, "reason") === null && heldout,
		dependencies: reason !== null && DEPENDENCY_ABORTS.has(reason),
	};
}

function earlyAbort(
	reason: string,
	receipt: NonNullable<ReturnType<typeof objectOf>>,
	checks: readonly ReceiptCheck[],
	input: ClassifyInput,
): FailureClass {
	if (checks.some((c) => c.timedOut)) return infrastructure("timeout");
	const infra = INFRASTRUCTURE_ABORTS.get(reason);

	if (infra !== undefined) return infrastructure(infra);

	if (fieldOf(receipt, "status") !== "failed") return missing("incomplete_ci");

	if (CANDIDATE_ABORTS.has(reason)) {
		if (SCANNED_ABORTS.has(reason)) {
			const signals = (arrayOf(fieldOf(receipt, "tamperSignals")) ?? []).map(
				(s) => ({
					rule: fieldOf(objectOf(s), "rule"),
					path: textOf(fieldOf(objectOf(s), "path")),
				}),
			);

			const rules = signals.map((s) => s.rule);

			if (
				!rules.includes(reason) ||
				(reason !== "invalid_source_encoding" &&
					rules.includes("invalid_source_encoding")) ||
				(reason === "suppression_added" && rules.includes("runtime_patching"))
			)
				return missing("invalid_report");

			if (
				input.candidatePaths === null ||
				signals.some(
					(s) =>
						s.path === null ||
						s.path.startsWith("test/acceptance/") ||
						input.expected.includes(s.path) ||
						!input.candidatePaths?.includes(s.path),
				)
			)
				return missing("incomplete_ci");
		}

		return { kind: "candidate", reason: "candidate_check", scenarios: [] };
	}

	if (DEPENDENCY_ABORTS.has(reason))
		return input.dependencies?.reason === reason
			? { kind: "candidate", reason: "candidate_check", scenarios: [] }
			: missing("incomplete_ci");

	return missing("incomplete_ci");
}

type BaseJudgement =
	| Readonly<{ kind: "class"; failure: FailureClass }>
	| Readonly<{ kind: "wrong"; scenarios: readonly string[] }>;

function baseClass(
	input: ClassifyInput,
	failed: readonly string[],
): BaseJudgement {
	const stop = (failure: FailureClass): BaseJudgement => ({
		kind: "class",
		failure,
	});

	const base = input.base;

	if (
		base === null ||
		base.evidence.binding.baseSha !== input.identity.gateSha ||
		base.evidence.binding.gateSha !== input.identity.gateSha
	)
		return stop(missing("base_missing"));
	const wrong: string[] = [];

	for (const file of failed) {
		const s = input.scenarios.find((x) => x.file === file);

		if (s === undefined) return stop(missing("identity_mismatch"));
		const result = base.results.find((r) => r.scenario === s.scenario)?.result;

		if (result === undefined) return stop(missing("base_missing"));

		if (result === "base_timeout") return stop(infrastructure("timeout"));

		if (result === "base_runner_error")
			return stop(infrastructure("runner_error"));

		if (result === "base_interrupted")
			return stop(infrastructure("interrupted"));

		if (
			result === "base_evidence_missing" ||
			result === "base_tree_unsupported" ||
			result === "judge_only"
		)
			return stop(missing("base_missing"));

		if (result !== (s.kind === "new_behavior" ? "expected_red" : "preserved"))
			wrong.push(s.scenario);
	}

	return { kind: "wrong", scenarios: wrong };
}

function heldoutClass(
	input: ClassifyInput,
	receipt: NonNullable<ReturnType<typeof objectOf>>,
): FailureClass {
	const expected = input.expected.toSorted();
	const ciFailed = textsOf(fieldOf(receipt, "heldoutFailures"));
	const ciCounts = objectOf(fieldOf(receipt, "heldoutCounts"));

	if (
		expected.length === 0 ||
		new Set(expected).size !== expected.length ||
		ciFailed === null ||
		ciFailed.length === 0 ||
		new Set(ciFailed).size !== ciFailed.length ||
		ciFailed.some((f) => !expected.includes(f)) ||
		ciCounts === null ||
		!sameList(Object.keys(ciCounts), expected) ||
		expected.some((f) => countOf(fieldOf(ciCounts, f)) === null)
	)
		return missing("invalid_report");
	const replay = input.replay;

	if (replay === null) return missing("unsupported_tree");

	if (replay.kind === "unavailable")
		return replay.reason === "unsupported_tree"
			? missing("unsupported_tree")
			: replay.reason === "suite_mismatch"
				? missing("identity_mismatch")
				: infrastructure(replay.reason);

	for (const tree of [replay.gate, replay.full])
		if (tree.execution.kind === "unavailable")
			return tree.execution.reason === "invalid_report"
				? missing("invalid_report")
				: infrastructure(tree.execution.reason);

	for (const tree of [replay.gate, replay.full])
		if (
			tree.execution.kind === "observed" &&
			tree.execution.files.some((f) =>
				f.failures.some((x) => x.kind === "timeout"),
			)
		)
			return infrastructure("timeout");

	const ignored = textsOf(fieldOf(receipt, "ignoredChanges"));

	if (ignored === null) return missing("invalid_report");

	if (input.ignoredChanges === null) return missing("unsupported_tree");
	const replayed = input.ignoredChanges;

	if (!sameList(ignored, replayed))
		return {
			kind: "missing_evidence",
			reason: "materialize_mismatch",
			differing: new Set(
				[...ignored, ...replayed].filter(
					(p) => !ignored.includes(p) || !replayed.includes(p),
				),
			).size,
		};

	if (!sameList(replay.files, expected)) return missing("identity_mismatch");

	const gate = replay.gate.projection,
		full = replay.full.projection;

	if (
		gate.passed ||
		!sameList(gate.failed, ciFailed) ||
		expected.some((f) => gate.counts[f] !== countOf(fieldOf(ciCounts, f)))
	)
		return missing("ci_replay_disagrees");

	if (
		replay.gate.execution.kind !== "observed" ||
		replay.full.execution.kind !== "observed" ||
		full.passed ||
		!sameList(full.failed, gate.failed) ||
		expected.some((f) => full.counts[f] !== gate.counts[f]) ||
		signature(replay.gate.execution.files) !==
			signature(replay.full.execution.files)
	)
		return missing("tree_replays_disagree");
	const base = baseClass(input, gate.failed);

	if (base.kind === "class") return base.failure;

	if (base.scenarios.length > 0)
		return {
			kind: "oracle",
			cause: "unexpected_base",
			scenarios: base.scenarios,
		};

	return {
		kind: "candidate",
		reason: "candidate_heldout",
		scenarios: gate.failed.flatMap(
			(f) => input.scenarios.find((s) => s.file === f)?.scenario ?? [],
		),
	};
}

export function classifyFailure(input: ClassifyInput): FailureClass {
	const r = objectOf(input.receipt);
	const id = input.identity;

	if (
		r === null ||
		fieldOf(r, "version") !== 2 ||
		fieldOf(r, "gateSha") !== id.gateSha ||
		fieldOf(r, "candidateSha") !== id.candidateSha ||
		fieldOf(r, "nonce") !== id.nonce ||
		fieldOf(r, "heldoutDigest") !== id.heldoutDigest ||
		fieldOf(r, "modelCalls") !== 0
	)
		return missing("identity_mismatch");
	const required = textsOf(fieldOf(r, "requiredChecks"));
	const rawChecks = arrayOf(fieldOf(r, "checks"));
	const rawReason = fieldOf(r, "reason");
	const reason = rawReason === null ? null : textOf(rawReason);

	if (
		required === null ||
		new Set(required).size !== required.length ||
		rawChecks === null ||
		(rawReason !== null && reason === null)
	)
		return missing("invalid_report");
	const checks: ReceiptCheck[] = [];

	for (const raw of rawChecks) {
		const c = objectOf(raw);
		const name = textOf(fieldOf(c, "name"));
		const exitCode = countOf(fieldOf(c, "exitCode"));
		const timedOut = fieldOf(c, "timedOut");
		const signal = fieldOf(c, "signal");

		if (
			name === null ||
			exitCode === null ||
			(timedOut !== undefined && timedOut !== true && timedOut !== false) ||
			(signal !== undefined && signal !== null && textOf(signal) === null)
		)
			return missing("invalid_report");
		checks.push({
			name,
			exitCode,
			timedOut: timedOut === true,
			signal: signal == null ? null : textOf(signal),
		});
	}

	if (fieldOf(r, "replacementsDigest") !== id.replacementsDigest)
		return missing("identity_mismatch");

	if (reason !== null) return earlyAbort(reason, r, checks, input);

	if (fieldOf(r, "status") !== "failed") return missing("incomplete_ci");

	if (checks.some((c) => c.timedOut)) return infrastructure("timeout");

	if (checks.some((c) => c.signal !== null))
		return infrastructure("runner_error");

	if (
		NORMAL_CHECKS.some((n) => !required.includes(n)) ||
		required.some((n) => checks.filter((c) => c.name === n).length !== 1) ||
		checks.length !== required.length
	)
		return missing("incomplete_ci");
	const failed = checks.flatMap((c) => (c.exitCode !== 0 ? [c.name] : []));

	if (failed.includes("baseline_tests"))
		return infrastructure("baseline_failed");

	if (!failed.includes("heldout"))
		return failed.length > 0
			? { kind: "candidate", reason: "candidate_check", scenarios: [] }
			: missing("incomplete_ci");

	return heldoutClass(input, r);
}

export const FAILURE_SENTENCES: Readonly<Record<FailureClass["kind"], string>> =
	{
		candidate: "Hard CI failed for this candidate. A bounded repair is next.",
		oracle: "Stopped: acceptance checks are invalid for this contract or base.",
		missing_evidence:
			"Stopped: CI diagnosis could not establish reliable evidence.",
		infrastructure:
			"Held: validation could not execute reliably. No repair was started.",
	};

const MISSING_REASONS: readonly MissingEvidenceReason[] = [
	"assessment_missing",
	"identity_mismatch",
	"incomplete_ci",
	"base_missing",
	"invalid_report",
	"unsupported_tree",
	"materialize_mismatch",
	"ci_replay_disagrees",
	"tree_replays_disagree",
];

const INFRASTRUCTURE_REASONS: readonly InfrastructureReason[] = [
	"runner_unavailable",
	"runner_error",
	"timeout",
	"dependency_transport",
	"baseline_failed",
	"interrupted",
];

const SCENARIO_ID = /^S[1-9][0-9]{0,2}$/;

export function parseFailureClass(
	value: JsonValue | undefined,
): FailureClass | null {
	const v = objectOf(value);
	const kind = fieldOf(v, "kind");
	const keys = Object.keys(v ?? {}).toSorted();
	const scenarios = textsOf(fieldOf(v, "scenarios"));

	const ids =
		scenarios !== null &&
		scenarios.length <= 50 &&
		new Set(scenarios).size === scenarios.length &&
		scenarios.every((s) => SCENARIO_ID.test(s));

	if (kind === "candidate") {
		const reason = fieldOf(v, "reason");

		return ids &&
			scenarios !== null &&
			(reason === "candidate_check" || reason === "candidate_heldout") &&
			keys.join() === "kind,reason,scenarios"
			? { kind, reason, scenarios }
			: null;
	}

	if (kind === "oracle")
		return ids &&
			scenarios !== null &&
			scenarios.length > 0 &&
			fieldOf(v, "cause") === "unexpected_base" &&
			keys.join() === "cause,kind,scenarios"
			? { kind, cause: "unexpected_base", scenarios }
			: null;
	const reason = textOf(fieldOf(v, "reason"));
	const differing = countOf(fieldOf(v, "differing"));

	if (
		kind === "missing_evidence" &&
		reason === "materialize_mismatch" &&
		keys.join() === "differing,kind,reason" &&
		differing !== null &&
		differing > 0
	)
		return { kind, reason, differing };

	if (keys.join() !== "kind,reason" || reason === null) return null;

	const missingReason = MISSING_REASONS.find(
		(r) => r === reason && r !== "materialize_mismatch",
	);

	if (
		kind === "missing_evidence" &&
		missingReason !== undefined &&
		missingReason !== "materialize_mismatch"
	)
		return { kind, reason: missingReason };
	const infraReason = INFRASTRUCTURE_REASONS.find((r) => r === reason);

	return kind === "infrastructure" && infraReason !== undefined
		? { kind, reason: infraReason }
		: null;
}

export function diagnosisDetail(failure: FailureClass): string | null {
	if (failure.kind !== "missing_evidence") return null;

	switch (failure.reason) {
		case "ci_replay_disagrees":
			return "CI and the gate-tree replay disagree.";
		case "tree_replays_disagree":
			return "Gate and candidate replays disagree.";
		case "materialize_mismatch":
			return `The replay's ignored changes differ from CI's in ${failure.differing} path${failure.differing === 1 ? "" : "s"}.`;
		default:
			return null;
	}
}

export function diagnosisNotice(failure: FailureClass, key: string) {
	const scenarios =
		failure.kind === "candidate" || failure.kind === "oracle"
			? failure.scenarios.filter((s) => SCENARIO_ID.test(s))
			: [];

	const detail = diagnosisDetail(failure);
	const extra = detail === null ? "" : ` ${detail}`;

	return {
		key,
		body: `${FAILURE_SENTENCES[failure.kind]}${extra}${scenarios.length > 0 ? ` Scenarios: ${scenarios.join(", ")}.` : ""}\n\n${key}`,
	};
}
