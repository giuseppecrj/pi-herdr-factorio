import type { GitSha } from "../config/schema.ts";
import {
	parseAcceptanceBinding,
	type AcceptanceBinding,
} from "../contract/acceptance.ts";
import type { Contract, CriterionKind } from "../contract/contract.ts";
import type { JsonValue } from "../core/json.ts";
import {
	arrayOf,
	countOf,
	fieldOf,
	objectOf,
	parseJson,
	textOf,
	textsOf,
} from "../core/json.ts";
import { digestOf, isDigest, type Digest } from "../core/run.ts";
import { ACCEPTANCE_SUITE_PREFIX } from "../trust/protected-paths.ts";
import type { VisibleTests } from "./build.ts";

/**
 * The one accept feedback retry, persisted in the claim once granted, so a
 * restart never grants another.
 */
export type AcceptRetry = Readonly<{
	/** The refused, retired first suite. Its stored receipt sources the feedback. */
	refused: AcceptanceBinding;
	/** Always an `author` reason; the rest of the original refusal notice. */
	reason: AuthorRetryReason;
	receiptDigest: Digest;
	scenarios: readonly string[];
	/** Every base-check attempt's wall on the refused suite, charged to accept. */
	baseWallMs: number;
}>;

type AcceptanceSuiteReference = Readonly<{
	/** The current suite, or the retired suite while a replacement is pending. */
	binding: AcceptanceBinding;
	acceptAttempt: number;
	/** The model attempt in the acceptance receipt, not a later check-only attempt. */
	storedAttempt: number;
	remainingAcceptMs: number;
}>;

export type AcceptanceQualification = AcceptanceSuiteReference &
	(
		| Readonly<{ kind: "checking"; retry?: never }>
		| Readonly<{ kind: "retry_pending"; retry: AcceptRetry }>
		| Readonly<{ kind: "rechecking_replacement"; retry: AcceptRetry }>
		| Readonly<{ kind: "qualified"; proof: BaseProof; retry?: AcceptRetry }>
		| Readonly<{
				kind: "refused";
				failure: BaseRefusal;
				noticeKey: string;
				retry?: AcceptRetry;
		  }>
	);

/** The granted retry's original refusal, posted if the run ends without a final one. */
export function retriedRefusal(retry: AcceptRetry): BaseRefusal {
	return {
		binding: retry.refused,
		receiptDigest: retry.receiptDigest,
		reason: retry.reason,
		scenarios: retry.scenarios,
	};
}

/** Whether the granted retry still awaits its new suite. */
export function retryPending(
	reference: AcceptanceQualification,
): reference is Extract<AcceptanceQualification, { kind: "retry_pending" }> {
	return reference.kind === "retry_pending";
}

export function parseBaseCheckReference(
	value: JsonValue | undefined,
): AcceptanceQualification | null {
	const v = objectOf(value),
		binding = parseAcceptanceBinding(fieldOf(v, "binding")),
		acceptAttempt = countOf(fieldOf(v, "acceptAttempt")),
		rawStored = fieldOf(v, "storedAttempt"),
		storedAttempt = countOf(rawStored),
		remainingAcceptMs = countOf(fieldOf(v, "remainingAcceptMs"));

	if (
		binding === null ||
		acceptAttempt === null ||
		acceptAttempt < 1 ||
		remainingAcceptMs === null ||
		(rawStored !== undefined &&
			(storedAttempt === null ||
				storedAttempt < 1 ||
				storedAttempt > acceptAttempt))
	)
		return null;

	const reference: AcceptanceSuiteReference = {
		binding,
		acceptAttempt,
		storedAttempt: storedAttempt ?? acceptAttempt,
		remainingAcceptMs,
	};

	const rawKind = fieldOf(v, "kind");
	const rawRetry = fieldOf(v, "retry");

	const retry =
		rawRetry === undefined ? undefined : parseAcceptRetry(rawRetry, binding);

	if (retry === null) return null;

	// Legacy claims inferred pending from digest equality. Only the decoder does
	// that now; every live transition carries its own discriminant.
	const kind =
		rawKind === undefined
			? retry === undefined
				? "checking"
				: retry.refused.acceptanceDigest === binding.acceptanceDigest
					? "retry_pending"
					: "rechecking_replacement"
			: rawKind;

	if (kind === "checking")
		return retry === undefined ? { ...reference, kind } : null;

	if (kind === "retry_pending" || kind === "rechecking_replacement") {
		if (
			retry === undefined ||
			(retry.refused.acceptanceDigest === binding.acceptanceDigest) !==
				(kind === "retry_pending")
		)
			return null;

		return { ...reference, kind, retry };
	}

	if (kind === "qualified") {
		// A serialized claim cannot mint BaseProof's private brand. Recovery goes
		// back to the stored base receipt, including after a summary-write crash.
		return retry === undefined
			? { ...reference, kind: "checking" }
			: retry.refused.acceptanceDigest !== binding.acceptanceDigest
				? { ...reference, kind: "rechecking_replacement", retry }
				: null;
	}

	if (kind === "refused") {
		const failure = parseBaseRefusal(fieldOf(v, "failure"));
		const noticeKey = textOf(fieldOf(v, "noticeKey"));

		if (
			failure === null ||
			noticeKey !== baseRefusalNotice(failure).key ||
			(JSON.stringify(failure.binding) !== JSON.stringify(binding) &&
				(retry === undefined ||
					JSON.stringify(failure) !== JSON.stringify(retriedRefusal(retry))))
		)
			return null;

		return retry === undefined
			? { ...reference, kind, failure, noticeKey }
			: { ...reference, kind, failure, noticeKey, retry };
	}

	return null;
}

function parseAcceptRetry(
	rawRetry: JsonValue,
	binding: AcceptanceBinding,
): AcceptRetry | null {
	const r = objectOf(rawRetry),
		refused = parseAcceptanceBinding(fieldOf(r, "refused")),
		reason = parseBaseReason(fieldOf(r, "reason")),
		receiptDigest = textOf(fieldOf(r, "receiptDigest")) ?? "",
		scenarios = textsOf(fieldOf(r, "scenarios")),
		baseWallMs = countOf(fieldOf(r, "baseWallMs"));

	// Only a retry the controller could have granted: an author reason, the
	// original notice's facts, and the same run and contract.
	return refused !== null &&
		reason !== null &&
		retryableBaseReason(reason) &&
		isDigest(receiptDigest) &&
		scenarios !== null &&
		scenarios.length <= 50 &&
		scenarios.every((s) => SCENARIO_ID.test(s)) &&
		baseWallMs !== null &&
		JSON.stringify(refused) ===
			JSON.stringify({ ...binding, acceptanceDigest: refused.acceptanceDigest })
		? { refused, reason, receiptDigest, scenarios, baseWallMs }
		: null;
}

function parseBaseRefusal(value: JsonValue | undefined): BaseRefusal | null {
	const v = objectOf(value);
	const binding = parseAcceptanceBinding(fieldOf(v, "binding"));
	const receiptDigest = textOf(fieldOf(v, "receiptDigest")) ?? "";
	const reason = parseBaseReason(fieldOf(v, "reason"));
	const scenarios = textsOf(fieldOf(v, "scenarios"));

	return binding !== null &&
		isDigest(receiptDigest) &&
		reason !== null &&
		scenarios !== null &&
		scenarios.length <= 50 &&
		scenarios.every((s) => SCENARIO_ID.test(s))
		? { binding, receiptDigest, reason, scenarios }
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
	| "base_evidence_missing"
	| "suite_tamper_signal";

/** The gate's closed set of tamper-scan rules. */
export const SCAN_RULES = [
	"runtime_patching",
	"suppression_added",
	"invalid_source_encoding",
] as const;

/** One trusted tamper-scan hit in a held-out check, found before it runs. */
export type SuiteSignal = Readonly<{
	file: string;
	line: number;
	rule: (typeof SCAN_RULES)[number];
}>;

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
	/**
	 * The gate's tamper-scan hits in the suite, present only when non-empty.
	 * The suite then never ran.
	 */
	tamper?: readonly SuiteSignal[];
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
	storedAttempt?: number;
	remainingAcceptMs: number;
	signal: AbortSignal;
	allowLaunch?: boolean;
	readOnly?: boolean;
}>;

export type BaseCheckProgress =
	| Readonly<{ kind: "checking" }>
	| Readonly<{ kind: "interrupted"; wallMs: number }>
	| Readonly<{ kind: "ready"; proof: BaseProof }>
	| Readonly<{
			kind: "refused";
			failure: BaseRefusal;
			/** The stored receipt, when the check ran; private, for retry feedback only. */
			receipt?: BaseReceipt;
			/** With the receipt: every attempt's base-check wall on this binding. */
			baseWallMs?: number;
	  }>;

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

export const BASE_PROTOCOL_VERSION = "heldout-base-v2-4";

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
			: (evidence.tamper?.length ?? 0) > 0
				? "suite_tamper_signal"
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

const REPLAY_UNAVAILABLE: ReadonlySet<string> = new Set([
	"timeout",
	"runner_error",
	"dependency_transport",
	"unsupported_tree",
	"unsupported_materializer",
	"suite_mismatch",
]);

function parseProjection(
	value: JsonValue | undefined,
): HeldoutProjection | null {
	const v = objectOf(value);
	const rawCounts = objectOf(fieldOf(v, "counts"));
	const failed = textsOf(fieldOf(v, "failed"));
	const passed = fieldOf(v, "passed");

	if (
		rawCounts === null ||
		failed === null ||
		(passed !== true && passed !== false)
	)
		return null;
	const counts: Record<string, number> = {};

	for (const [file, raw] of Object.entries(rawCounts)) {
		const count = countOf(raw);

		if (count === null) return null;
		counts[file] = count;
	}

	return { counts, failed, passed };
}

/** Reads a stored replay back; null unless it round-trips byte for byte. */
export function parseHeldoutReplay(
	value: JsonValue | undefined,
): HeldoutReplay | null {
	const v = objectOf(value);
	const wallMs = countOf(fieldOf(v, "wallMs"));
	const reason = textOf(fieldOf(v, "reason"));

	if (wallMs === null) return null;
	let replay: HeldoutReplay | null = null;

	if (fieldOf(v, "kind") === "unavailable") {
		if (reason === null || !REPLAY_UNAVAILABLE.has(reason)) return null;
		replay = {
			kind: "unavailable",
			// SAFETY: membership in REPLAY_UNAVAILABLE is checked on the line above.
			reason: reason as Extract<
				HeldoutReplay,
				{ kind: "unavailable" }
			>["reason"],
			wallMs,
		};
	} else if (fieldOf(v, "kind") === "observed") {
		const files = textsOf(fieldOf(v, "files"));

		const tree = (name: string): TreeReplay | null => {
			const t = objectOf(fieldOf(v, name));
			const execution = parseExecution(fieldOf(t, "execution"));
			const projection = parseProjection(fieldOf(t, "projection"));

			return execution === null || projection === null
				? null
				: { execution, projection };
		};

		const gate = tree("gate"),
			full = tree("full");

		if (files === null || gate === null || full === null) return null;
		replay = { kind: "observed", files, gate, full, wallMs };
	}

	return replay !== null && JSON.stringify(replay) === JSON.stringify(v)
		? replay
		: null;
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
	const rawTamper = fieldOf(e, "tamper");
	const tamper: SuiteSignal[] = [];

	for (const raw of rawTamper === undefined ? [] : (arrayOf(rawTamper) ?? [])) {
		const v = objectOf(raw),
			file = textOf(fieldOf(v, "file")),
			line = countOf(fieldOf(v, "line")),
			rule = SCAN_RULES.find((r) => r === fieldOf(v, "rule"));

		if (file === null || line === null || rule === undefined) return null;
		tamper.push({ file, line, rule });
	}

	if (rawTamper !== undefined && tamper.length === 0) return null;

	const clean: BaseEvidence = {
		binding,
		runtime: { runner, node, platform, bwrap, protocolDigest },
		startedAt,
		finishedAt,
		source,
		execution,
		repeat,
		scenarios,
	};

	const evidence = tamper.length > 0 ? { ...clean, tamper } : clean;

	const { receipt } = assessBase(evidence);

	return JSON.stringify(receipt) === JSON.stringify(record) ? receipt : null;
}

const BASE_REASON_SENTENCES: Readonly<Record<BaseReason, string>> = {
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
	base_nondeterministic: "Two base runs of the checks gave different results.",
	base_evidence_missing:
		"Base qualification evidence is incomplete or invalid.",
	suite_tamper_signal:
		"A check uses a module loader hook, a runtime patch or a process exit hook that the trusted tamper scan rejects.",
};

const BASE_REASONS: readonly BaseReason[] = [
	"acceptance_not_reproduced",
	"preservation_failed",
	"base_load_error",
	"base_no_tests",
	"base_runner_error",
	"base_timeout",
	"base_non_assertion_failure",
	"base_skip",
	"base_todo",
	"base_cancelled",
	"base_tree_unsupported",
	"base_interrupted",
	"base_nondeterministic",
	"base_evidence_missing",
	"suite_tamper_signal",
];

export function parseBaseReason(
	value: JsonValue | undefined,
): BaseReason | null {
	return BASE_REASONS.find((r) => r === value) ?? null;
}

/**
 * Whether the accept author can fix a base refusal. `author` allows the one
 * feedback retry; `final` keeps the pre-retry behavior. Typed over every
 * `BaseReason`, so a new reason must be classified to compile.
 */
export const BASE_RETRY = {
	acceptance_not_reproduced: "author",
	preservation_failed: "author",
	base_load_error: "author",
	base_no_tests: "author",
	base_non_assertion_failure: "author",
	base_skip: "author",
	base_todo: "author",
	base_cancelled: "author",
	base_nondeterministic: "author",
	suite_tamper_signal: "author",
	base_runner_error: "final",
	base_timeout: "final",
	base_tree_unsupported: "final",
	base_interrupted: "final",
	base_evidence_missing: "final",
} as const satisfies Readonly<Record<BaseReason, "author" | "final">>;

export type AuthorRetryReason = {
	[Reason in BaseReason]: (typeof BASE_RETRY)[Reason] extends "author"
		? Reason
		: never;
}[BaseReason];

export function retryableBaseReason(
	reason: BaseReason,
): reason is AuthorRetryReason {
	return BASE_RETRY[reason] === "author";
}

export const RETRY_MESSAGE_CHARS = 500;
export const RETRY_FEEDBACK_BYTES = 4096;

export type RetryFileFeedback = Readonly<{
	scenario: string;
	file: string;
	kind: TestFailure["kind"] | "passed" | "not_observed";
	code: string | null;
	message: string;
	/** Which of the two base runs failed the file. */
	failedIn: "both" | "first" | "repeat" | "neither";
}>;

/** Private refusal facts for the accept retry prompt only; never published. */
export type RetryFeedback = Readonly<{
	reason: BaseReason;
	sentence: string;
	scenarios: readonly string[];
	files: readonly RetryFileFeedback[];
	/** The tamper scan's file, line and rule hits; only for `suite_tamper_signal`. */
	signals?: readonly SuiteSignal[];
	/** Files or signals cut by the byte bound. */
	omitted: number;
}>;

export function baseRetryFeedback(
	receipt: BaseReceipt | null,
	failure: Pick<BaseRefusal, "reason" | "scenarios">,
): RetryFeedback {
	const scenarios = failure.scenarios.filter((s) => SCENARIO_ID.test(s));

	const observe = (execution: PrivateExecution | undefined, file: string) =>
		execution?.kind === "observed"
			? execution.files.find((f) => f.file === file)
			: undefined;

	const candidates = (receipt?.evidence.scenarios ?? []).flatMap(
		(s): RetryFileFeedback[] => {
			if (s.mode !== "checked" || !scenarios.includes(s.scenario)) return [];

			// Both runs count: a nondeterministic file may fail only on the repeat.
			const runs = [
				observe(receipt?.evidence.execution, s.file),
				observe(receipt?.evidence.repeat, s.file),
			];

			const [inFirst, inRepeat] = runs.map(
				(o) => o !== undefined && o.failures.length > 0,
			);

			const first = runs.find((o) => (o?.failures.length ?? 0) > 0)
				?.failures[0];

			return [
				{
					scenario: s.scenario,
					file: s.file.slice(0, 300),
					kind:
						first?.kind ??
						(runs.every((o) => o === undefined) ? "not_observed" : "passed"),
					code: first?.code?.slice(0, 100) ?? null,
					message: (first?.message ?? "").slice(0, RETRY_MESSAGE_CHARS),
					failedIn: inFirst
						? inRepeat
							? "both"
							: "first"
						: inRepeat
							? "repeat"
							: "neither",
				},
			];
		},
	);

	// A tampered suite never ran: its feedback is the scan's own hits, the
	// author's file, line and a closed rule name.
	const tamper =
		failure.reason === "suite_tamper_signal"
			? (receipt?.evidence.tamper ?? []).map((s) => ({
					file: s.file.slice(0, 300),
					line: s.line,
					rule: s.rule,
				}))
			: [];

	const entries: readonly unknown[] = tamper.length > 0 ? tamper : candidates;

	const feedback = (count: number, omitted: number): RetryFeedback => {
		const common = {
			reason: failure.reason,
			sentence: BASE_REASON_SENTENCES[failure.reason],
			scenarios,
		};

		return tamper.length > 0
			? { ...common, files: [], signals: tamper.slice(0, count), omitted }
			: { ...common, files: candidates.slice(0, count), omitted };
	};

	let kept = 0;

	while (
		kept < entries.length &&
		Buffer.byteLength(JSON.stringify(feedback(kept + 1, entries.length))) <=
			RETRY_FEEDBACK_BYTES
	)
		kept++;

	return feedback(kept, entries.length - kept);
}

export const DRAFT_FEEDBACK_BYTES = 6144;
export const DRAFT_MESSAGE_CHARS = 300;
export const DRAFT_CAUSE_CHARS = 200;

export type DraftDetail = Readonly<{
	file: string;
	name: string;
	kind: TestFailure["kind"];
	code?: string | null;
	message: string;
	causes: readonly string[];
	at: readonly string[];
}>;

export type DraftFailure = Readonly<{
	test: string;
	kind: TestFailure["kind"];
	code: string | null;
	message: string;
	causes: readonly string[];
	at: readonly string[];
}>;

export type DraftFileFeedback = Readonly<{
	scenario: string;
	file: string;
	kind: CriterionKind;
	result: ScenarioBaseResult["result"];
	qualifies: boolean;
	suspect: boolean;
	registered: number;
	failedIn: "both" | "first" | "repeat" | "neither";
	failures: readonly DraftFailure[];
	omittedFailures: number;
}>;

export type DraftFeedback = Readonly<{
	run: 1 | 2;
	verdict: "would_qualify" | "would_refuse";
	reason: BaseReason | null;
	sentence: string | null;
	files: readonly DraftFileFeedback[];
	signals?: readonly SuiteSignal[];
	omitted: number;
}>;

export function runtimeCause(cause: string): boolean {
	return (
		/^(?:[A-Z][A-Za-z]*Error\b|Error:)/.test(cause.trim()) &&
		!/^AssertionError\b/.test(cause.trim())
	);
}

function draftText(text: string, limit: number): string {
	return text
		.replace(
			new RegExp(`${String.fromCharCode(27)}\\[[0-?]*[ -/]*[@-~]`, "g"),
			"",
		)
		.replace(/factory-holdout-[a-f0-9]+/g, "[canary]")
		.split("\n")
		.filter((line) => !/^\s*at\s/.test(line))
		.join("\n")
		.replace(/(?:file:\/\/)?\/(?:[A-Za-z0-9_.%:@+-]+\/?)+/g, "[path]")
		.slice(0, limit);
}

/** Private facts about the author's own draft, never a qualification proof. */
export function draftCheckFeedback(
	receipt: BaseReceipt,
	details: readonly DraftDetail[],
	issue: number,
): DraftFeedback {
	const { assessment } = assessBase(receipt.evidence);

	const reason =
		assessment.kind === "refused" ? assessment.failure.reason : null;

	const prefix = `${ACCEPTANCE_SUITE_PREFIX}${issue}/checks/`;

	const checkFiles = new Set(
		receipt.evidence.scenarios.flatMap((s) =>
			s.mode === "checked" ? [s.file] : [],
		),
	);

	const observe = (run: PrivateExecution, file: string) =>
		run.kind === "observed"
			? run.files.find((f) => f.file === file)
			: undefined;

	const candidates: DraftFileFeedback[] = receipt.evidence.scenarios.flatMap(
		(s) => {
			if (s.mode !== "checked") return [];

			const first = observe(receipt.evidence.execution, s.file),
				repeat = observe(receipt.evidence.repeat, s.file);

			const result =
				receipt.results.find((r) => r.scenario === s.scenario)?.result ??
				"base_evidence_missing";

			const raw: readonly DraftDetail[] = details.some((d) => d.file === s.file)
				? details.filter((d) => d.file === s.file)
				: [...(first?.failures ?? []), ...(repeat?.failures ?? [])].map(
						(f) => ({ ...f, causes: [], at: [] }),
					);

			const unique = [
				...new Map(raw.map((f) => [JSON.stringify(f), f])).values(),
			];

			const failures: DraftFailure[] = unique.slice(0, 2).map((f) => ({
				test: draftText(f.name, 120),
				kind: f.kind,
				code:
					draftText(
						f.code ??
							first?.failures.find((x) => x.name === f.name)?.code ??
							"",
						40,
					) || null,
				message: draftText(f.message, DRAFT_MESSAGE_CHARS),
				causes: [
					...new Set(f.causes.map((c) => draftText(c, DRAFT_CAUSE_CHARS))),
				].slice(0, 3),
				at: [
					...new Set(
						f.at.flatMap((frame) => {
							const relative = frame.replace(/^\/w\//, "");

							const own =
								relative.startsWith(prefix) &&
								checkFiles.has(relative.replace(/:\d+:\d+$/, ""))
									? relative.slice(prefix.length)
									: "";

							return /^(?!.*(?:^|\/)\.\.?\/)[A-Za-z0-9_./-]+:\d+:\d+$/.test(own)
								? [own]
								: [];
						}),
					),
				].slice(0, 3),
			}));

			const a = (first?.failures.length ?? 0) > 0,
				b = (repeat?.failures.length ?? 0) > 0;

			return [
				{
					scenario: s.scenario,
					file: s.file.startsWith(prefix)
						? s.file.slice(prefix.length)
						: draftText(s.file, 300),
					kind: s.kind,
					result,
					qualifies: result === "expected_red" || result === "preserved",
					suspect:
						result === "expected_red" &&
						raw.some((f) => f.causes.some(runtimeCause)),
					registered: first?.registered ?? repeat?.registered ?? 0,
					failedIn: a ? (b ? "both" : "first") : b ? "repeat" : "neither",
					failures,
					omittedFailures: Math.max(0, unique.length - failures.length),
				},
			];
		},
	);

	const signals = (receipt.evidence.tamper ?? []).map((s) => ({
		...s,
		file: s.file.startsWith(prefix)
			? s.file.slice(prefix.length)
			: draftText(s.file, 300),
	}));

	const feedback = (files: number, hits: number): DraftFeedback => {
		const value: DraftFeedback = {
			run: 1,
			verdict: reason === null ? "would_qualify" : "would_refuse",
			reason,
			sentence: reason === null ? null : BASE_REASON_SENTENCES[reason],
			files: candidates.slice(0, files),
			omitted: candidates.length - files + signals.length - hits,
		};

		return signals.length > 0
			? { ...value, signals: signals.slice(0, hits) }
			: value;
	};

	const size = (f: DraftFeedback) =>
		Buffer.byteLength(JSON.stringify(f).replaceAll("<", "\\u003c"));

	let files = 0,
		hits = 0;

	while (
		files < candidates.length &&
		size(feedback(files + 1, hits)) <= DRAFT_FEEDBACK_BYTES
	)
		files++;

	while (
		hits < signals.length &&
		size(feedback(files, hits + 1)) <= DRAFT_FEEDBACK_BYTES
	)
		hits++;

	return feedback(files, hits);
}

export function draftNeedsRevision(feedback: DraftFeedback): boolean {
	return feedback.reason === null
		? feedback.files.some((f) => f.suspect)
		: retryableBaseReason(feedback.reason);
}

export function baseRefusalNotice(failure: BaseRefusal) {
	const reasons = BASE_REASON_SENTENCES;

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
	| "unsupported_materializer"
	| "materialize_mismatch"
	| "ci_replay_disagrees"
	| "tree_replays_disagree"
	| "visible_base_failed";

export type InfrastructureReason =
	| "runner_unavailable"
	| "runner_error"
	| "base_nondeterministic"
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

export type CheckEnvironment = Readonly<{
	dependenciesDigest: Digest;
	runtimeDigest: Digest;
}>;

/** Visible checks precede publication: base + exact patch, not an invented commit SHA. */
export type CheckBinding = Readonly<{
	baseSha: string;
	candidate:
		| Readonly<{ kind: "patch"; digest: Digest }>
		| Readonly<{ kind: "commit"; sha: string }>;
	plan: string;
	dependencies:
		| Readonly<{ kind: "lock"; digest: Digest }>
		| Readonly<{ kind: "trees"; baseSha: string; candidateSha: string }>
		| Readonly<{ kind: "unknown" }>;
	runtime:
		| Readonly<{ kind: "bundle"; digest: Digest }>
		| Readonly<{ kind: "gate"; sha: string; runner: string | null }>
		| Readonly<{ kind: "execution"; identity: RuntimeIdentity }>
		| Readonly<{ kind: "unknown" }>;
	source:
		| Readonly<{ kind: "visible"; runId: Digest }>
		| Readonly<{ kind: "ci"; nonce: string; receiptDigest: Digest }>;
}>;

export type CheckFact = Readonly<{
	name: string;
	exitCode: number | null;
	timedOut: boolean;
}>;

export type BoundCheck = Readonly<{
	binding: CheckBinding;
	checks: readonly CheckFact[];
}>;

export type BoundControl = Readonly<{
	check: BoundCheck;
	receiptDigest: Digest;
	/** Qualified held-out outcomes, not a claim that expected-red checks passed. */
	scenarios?: readonly ScenarioBaseResult[];
}>;

type SingleControlProof =
	| Readonly<{ kind: "base_passed"; control: BoundControl }>
	| Readonly<{
			kind: "candidate_only_check";
			justification:
				| Readonly<{
						kind: "candidate_policy";
						rule: string;
						receiptDigest: Digest;
				  }>
				| Readonly<{
						kind: "new_visible_tests";
						gateSha: string;
						receiptDigest: Digest;
				  }>
				| Readonly<{
						kind: "qualified_new_behavior";
						scenarios: readonly string[];
						control: BoundControl;
				  }>;
	  }>;

type CheckControlProof = Readonly<{
	name: string;
	scenario?: string;
	proof: SingleControlProof;
}>;

export type ControlProof =
	| SingleControlProof
	| Readonly<{ kind: "combined"; checks: readonly CheckControlProof[] }>;

export type RequiredEvidence = "candidate_result" | "base_control";

type CheckFacts = Readonly<{
	binding: CheckBinding;
	failedChecks: readonly CheckFact[];
}>;

export type CheckAssessment = CheckFacts &
	(
		| Readonly<{ kind: "pending"; required: readonly RequiredEvidence[] }>
		| Readonly<{ kind: "passed"; check: BoundCheck }>
		| Readonly<{
				kind: "candidate_failure";
				check: BoundCheck;
				proof: ControlProof;
				failure: Extract<FailureClass, { kind: "candidate" }>;
		  }>
		| Readonly<{
				kind: "base_failure";
				control: BoundControl;
				failure: Exclude<FailureClass, { kind: "candidate" }>;
		  }>
		| Readonly<{
				kind: "unavailable";
				reason: MissingEvidenceReason | InfrastructureReason;
				failure: Exclude<FailureClass, { kind: "candidate" }>;
		  }>
	);

/** Adapt host receipts; a failed check vetoes progress even when its author is unknown. */
export function assessVisibleChecks(
	receipt: Readonly<{
		runId: Digest;
		baseSha: string;
		patchDigest: Digest;
		visibleTests: VisibleTests | null;
	}>,
	phase: "candidate" | "complete" = "complete",
): CheckAssessment {
	const tests = receipt.visibleTests;

	const bindingOf = (result: VisibleTests | null): CheckBinding => ({
		baseSha: receipt.baseSha,
		candidate: { kind: "patch", digest: receipt.patchDigest },
		plan: result?.command ?? "",
		dependencies:
			result?.environment === undefined
				? { kind: "unknown" }
				: { kind: "lock", digest: result.environment.dependenciesDigest },
		runtime:
			result?.environment === undefined
				? { kind: "unknown" }
				: { kind: "bundle", digest: result.environment.runtimeDigest },
		source: { kind: "visible", runId: receipt.runId },
	});

	const binding = bindingOf(tests);

	const facts = (
		result: VisibleTests | null,
		name = "visible_tests",
	): CheckFact[] =>
		result === null
			? []
			: [
					{
						name,
						exitCode: result.exitCode,
						timedOut: result.detail === "timeout",
					},
				];

	const failedChecks = [
		...facts(tests),
		...facts(tests?.base ?? null, "visible_base_tests"),
	].filter((c) => c.exitCode !== 0 || c.timedOut);

	const common = { binding, failedChecks };

	const unavailable = (
		reason:
			| Exclude<MissingEvidenceReason, "materialize_mismatch">
			| "timeout"
			| "runner_error",
	): CheckAssessment => ({
		...common,
		kind: "unavailable",
		reason,
		failure:
			reason === "timeout" || reason === "runner_error"
				? infrastructure(reason)
				: missing(reason),
	});

	if (tests === null)
		return { ...common, kind: "pending", required: ["candidate_result"] };

	if (tests.exitCode === null)
		return unavailable(tests.detail === "timeout" ? "timeout" : "runner_error");
	const check: BoundCheck = { binding, checks: facts(tests) };
	const base = tests.base;

	const control = (result: NonNullable<typeof base>): BoundControl => ({
		check: {
			binding: {
				...bindingOf(result),
				candidate: { kind: "commit", sha: receipt.baseSha },
			},
			checks: facts(result, "visible_base_tests"),
		},
		receiptDigest: digestOf(JSON.stringify(result)),
	});

	if (
		base !== undefined &&
		(base.command !== tests.command ||
			(base.environment !== undefined &&
				tests.environment !== undefined &&
				base.environment.runtimeDigest !== tests.environment.runtimeDigest))
	)
		return unavailable("identity_mismatch");

	// A control failure is independently meaningful, even if candidate tests passed.
	if (base?.exitCode != null && base.exitCode !== 0)
		return {
			...common,
			kind: "base_failure",
			control: control(base),
			failure: missing("visible_base_failed"),
		};

	if (tests.exitCode === 0) return { ...common, kind: "passed", check };

	if (base === undefined)
		return phase === "candidate"
			? { ...common, kind: "pending", required: ["base_control"] }
			: unavailable("base_missing");

	if (base.exitCode === null)
		return unavailable(base.detail === "timeout" ? "timeout" : "base_missing");

	if (tests.environment === undefined || base.environment === undefined)
		return unavailable("identity_mismatch");

	return {
		...common,
		kind: "candidate_failure",
		check,
		proof: { kind: "base_passed", control: control(base) },
		failure: { kind: "candidate", reason: "candidate_check", scenarios: [] },
	};
}

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
				| "unsupported_materializer"
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
	baseRefusal: BaseReason | null;
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
): Extract<FailureClass, { kind: "missing_evidence" }> => ({
	kind: "missing_evidence",
	reason,
});

const infrastructure = (
	reason: InfrastructureReason,
): Extract<FailureClass, { kind: "infrastructure" }> => ({
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
						s.path.startsWith(ACCEPTANCE_SUITE_PREFIX) ||
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
		return replay.reason === "unsupported_tree" ||
			replay.reason === "unsupported_materializer"
			? missing(replay.reason)
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

	if (input.baseRefusal !== null)
		return input.baseRefusal === "base_nondeterministic"
			? infrastructure("base_nondeterministic")
			: input.baseRefusal === "base_timeout"
				? infrastructure("timeout")
				: input.baseRefusal === "base_runner_error"
					? infrastructure("runner_error")
					: input.baseRefusal === "base_interrupted"
						? infrastructure("interrupted")
						: missing("base_missing");
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

function classifyCiFailure(input: ClassifyInput): FailureClass {
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

/** Pure projection of classifier v1. It does not grant repair or change precedence. */
export function assessCiFailure(
	input: ClassifyInput,
): Extract<
	CheckAssessment,
	{ kind: "candidate_failure" | "base_failure" | "unavailable" }
> {
	const failure = classifyCiFailure(input);
	const r = objectOf(input.receipt);

	const checks: CheckFact[] = (arrayOf(fieldOf(r, "checks")) ?? []).flatMap(
		(raw) => {
			const c = objectOf(raw),
				name = textOf(fieldOf(c, "name")),
				exitCode = countOf(fieldOf(c, "exitCode"));

			return name === null || exitCode === null
				? []
				: [{ name, exitCode, timedOut: fieldOf(c, "timedOut") === true }];
		},
	);

	const receiptDigest = digestOf(JSON.stringify(input.receipt) ?? "null");

	const binding: CheckBinding = {
		baseSha: input.identity.gateSha,
		candidate: { kind: "commit", sha: input.identity.candidateSha },
		plan: JSON.stringify({
			gateSha: input.identity.gateSha,
			requiredChecks: fieldOf(r, "requiredChecks") ?? null,
			heldoutDigest: input.identity.heldoutDigest,
			replacementsDigest: input.identity.replacementsDigest,
		}),
		dependencies: {
			kind: "trees",
			baseSha: input.identity.gateSha,
			candidateSha: input.identity.candidateSha,
		},
		runtime: {
			kind: "gate",
			sha: input.identity.gateSha,
			runner: textOf(fieldOf(r, "runner")),
		},
		source: {
			kind: "ci",
			nonce: input.identity.nonce,
			receiptDigest,
		},
	};

	const common = {
		binding,
		failedChecks: checks.filter((c) => c.exitCode !== 0 || c.timedOut),
	};

	const check = { binding, checks };
	const base = input.base;

	const qualifiedBase =
		base !== null &&
		(failure.kind === "oracle" ||
			(failure.kind === "candidate" && failure.reason === "candidate_heldout"))
			? base
			: null;

	const controlOf = (qualifiedBase: BaseReceipt | null): BoundControl => ({
		check: {
			binding: {
				...binding,
				candidate: { kind: "commit", sha: binding.baseSha },
				dependencies:
					qualifiedBase?.evidence.source.kind === "ready"
						? { kind: "lock", digest: qualifiedBase.evidence.source.lockDigest }
						: {
								kind: "trees",
								baseSha: binding.baseSha,
								candidateSha: binding.baseSha,
							},
				runtime:
					qualifiedBase === null
						? binding.runtime
						: { kind: "execution", identity: qualifiedBase.evidence.runtime },
			},
			checks:
				qualifiedBase === null
					? checks.filter((c) => c.name === "baseline_tests")
					: [],
		},
		receiptDigest:
			qualifiedBase === null
				? receiptDigest
				: digestOf(JSON.stringify(qualifiedBase)),
		scenarios:
			qualifiedBase === null
				? undefined
				: qualifiedBase.results.filter(
						(s) =>
							(failure.kind === "candidate" || failure.kind === "oracle") &&
							failure.scenarios.includes(s.scenario),
					),
	});

	const control = controlOf(qualifiedBase);

	if (failure.kind === "candidate") {
		const reason = textOf(fieldOf(r, "reason"));

		const newBehavior =
			base?.results
				.filter(
					(s) =>
						failure.scenarios.includes(s.scenario) && s.kind === "new_behavior",
				)
				.map((s) => s.scenario) ?? [];

		let proof: ControlProof;

		if (reason !== null)
			proof = {
				kind: "candidate_only_check",
				justification: {
					kind: "candidate_policy",
					rule: reason,
					receiptDigest,
				},
			};
		else {
			const proofs = common.failedChecks.flatMap(
				(failed): CheckControlProof[] => {
					if (failed.name === "heldout")
						return failure.scenarios.map((scenario) => {
							const scenarioControl = {
								...control,
								scenarios: control.scenarios?.filter(
									(s) => s.scenario === scenario,
								),
							};

							return {
								name: failed.name,
								scenario,
								proof: newBehavior.includes(scenario)
									? {
											kind: "candidate_only_check",
											justification: {
												kind: "qualified_new_behavior",
												scenarios: [scenario],
												control: scenarioControl,
											},
										}
									: { kind: "base_passed", control: scenarioControl },
							};
						});

					return [
						{
							name: failed.name,
							proof:
								failed.name === "candidate_tests"
									? {
											kind: "candidate_only_check",
											justification: {
												kind: "new_visible_tests",
												gateSha: input.identity.gateSha,
												receiptDigest,
											},
										}
									: { kind: "base_passed", control: controlOf(null) },
						},
					];
				},
			);

			const [only] = proofs;
			proof =
				proofs.length === 1 && only !== undefined
					? only.proof
					: { kind: "combined", checks: proofs };
		}

		return { ...common, kind: "candidate_failure", check, proof, failure };
	}

	if (
		failure.kind === "oracle" ||
		(failure.kind === "infrastructure" && failure.reason === "baseline_failed")
	)
		return { ...common, kind: "base_failure", control, failure };

	return { ...common, kind: "unavailable", reason: failure.reason, failure };
}

export function classifyFailure(input: ClassifyInput): FailureClass {
	return assessCiFailure(input).failure;
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
	"unsupported_materializer",
	"materialize_mismatch",
	"ci_replay_disagrees",
	"tree_replays_disagree",
	"visible_base_failed",
];

const INFRASTRUCTURE_REASONS: readonly InfrastructureReason[] = [
	"runner_unavailable",
	"runner_error",
	"base_nondeterministic",
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
		case "unsupported_materializer":
			return "The gate's materializer differs from the controller's.";
		case "materialize_mismatch":
			return `The replay's ignored changes differ from CI's in ${failure.differing} path${failure.differing === 1 ? "" : "s"}.`;
		default:
			return null;
	}
}

/**
 * The trusted gate's visible checks, in gate order. `heldout` is never one:
 * a dead end names only these, so no held-out suite detail leaves the gate.
 */
export const VISIBLE_CHECKS = [
	"baseline_tests",
	"typecheck",
	"lint",
	"format",
	"main_tests",
	"candidate_tests",
] as const;

export type VisibleCheck = (typeof VISIBLE_CHECKS)[number];

/** The names of the failed visible checks, in gate order. Never a detail. */
export function failedVisibleChecks(
	checks: readonly Readonly<{ name: string; passed: boolean }>[] | null,
): VisibleCheck[] {
	return VISIBLE_CHECKS.filter((name) =>
		(checks ?? []).some((check) => check.name === name && !check.passed),
	);
}

/** What else the owner sees at a validation dead end: check names and the retained patch. */
export type DeadEndContext = Readonly<{
	failedChecks: readonly VisibleCheck[];
	patchDigest: Digest | null;
}>;

export function diagnosisNotice(
	failure: FailureClass,
	key: string,
	context?: DeadEndContext,
) {
	const scenarios =
		failure.kind === "candidate" || failure.kind === "oracle"
			? failure.scenarios.filter((s) => SCENARIO_ID.test(s))
			: [];

	const detail = diagnosisDetail(failure);
	const extra = detail === null ? "" : ` ${detail}`;

	const checks = (context?.failedChecks ?? []).filter((name) =>
		VISIBLE_CHECKS.includes(name),
	);

	const patch = context?.patchDigest ?? null;

	const others = `${checks.length > 0 ? ` Other failed checks: ${checks.join(", ")}.` : ""}${patch !== null && isDigest(patch) ? ` Retained private patch: ${patch}.` : ""}`;

	return {
		key,
		body: `${FAILURE_SENTENCES[failure.kind]}${extra}${scenarios.length > 0 ? ` Scenarios: ${scenarios.join(", ")}.` : ""}${others}\n\n${key}`,
	};
}
