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

export const BASE_PROTOCOL_VERSION = "heldout-base-v2-1";

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

export function assessBase(evidence: BaseEvidence): BaseEvaluation {
	const execution = evidence.execution;

	const global: BaseReason | null =
		evidence.source.kind !== "ready"
			? UNSUPPORTED_TREE.has(evidence.source.reason)
				? "base_tree_unsupported"
				: "base_runner_error"
			: execution.kind === "unavailable"
				? execution.reason === "timeout"
					? "base_timeout"
					: execution.reason === "runner_error"
						? "base_runner_error"
						: "base_evidence_missing"
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

	const x = objectOf(fieldOf(e, "execution")),
		wallMs = countOf(fieldOf(x, "wallMs"));

	if (wallMs === null) return null;
	let execution: PrivateExecution;

	if (fieldOf(x, "kind") === "unavailable") {
		const reason = fieldOf(x, "reason");

		if (
			reason !== "runner_error" &&
			reason !== "timeout" &&
			reason !== "invalid_report"
		)
			return null;
		execution = { kind: "unavailable", reason, wallMs };
	} else {
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

		execution = { kind: "observed", exitCode, wallMs, files };
	}

	const evidence: BaseEvidence = {
		binding,
		runtime: { runner, node, platform, bwrap, protocolDigest },
		startedAt,
		finishedAt,
		source,
		execution,
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
