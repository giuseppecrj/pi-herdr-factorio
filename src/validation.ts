import { join } from "node:path";
import {
	acceptanceDigestOf,
	acceptanceEntries,
	type AcceptanceSuite,
} from "./accept.ts";
import {
	type Digest,
	digestOf,
	isDigest,
	type Verdict,
	verdictPasses,
} from "./run.ts";
import {
	type Publication,
	type PublishedFile,
	type TransportCounters,
} from "./publication.ts";
import type { Contract } from "./specify.ts";
import { isGitSha, type GitSha } from "./workflow.ts";
import {
	arrayOf,
	countOf,
	fieldOf,
	objectOf,
	parseJson,
	textOf,
	textsOf,
	type JsonValue,
} from "../server/sandbox/json.ts";
import { CONTROLLER_LOGIN } from "./markers.ts";
import { type FailureClass, parseFailureClass } from "./diagnosis.ts";

export { REQUIRED_CI_CHECKS } from "./run.ts";

export const CI_DEADLINE_MS = 1_200_000;
export const DISPATCH_SETTLE_MS = 120_000;

export type TrustedReport = Readonly<{
	candidateSha: GitSha;
	gateSha: GitSha;
	ciRunId: number;
	reportId: number;
	nonce: string;
	heldoutDigest: Digest;
	externalId: string;
}>;

export function collectTrustedReport(input: {
	readonly record: JsonValue | undefined;
	readonly checks: JsonValue | undefined;
	readonly run: CiRun;
	readonly nonce: string;
	readonly verdict: Verdict;
}): TrustedReport | null {
	const record = objectOf(input.record);
	const checks = objectOf(input.checks);
	const listed = arrayOf(fieldOf(checks, "check_runs"));
	const total = countOf(fieldOf(checks, "total_count"));
	const reportId = countOf(fieldOf(record, "checkId"));
	const externalId = `factory-gates:${input.run.id}:${input.nonce}`;
	const v = input.verdict;

	if (
		!verdictPasses(v) ||
		!isGitSha(v.candidateSha) ||
		!isGitSha(v.gateSha) ||
		!matchesCiRun(input.run, v.candidateSha, input.nonce, 0) ||
		input.run.id !== v.ciRunId ||
		input.run.headSha !== v.gateSha ||
		input.run.status !== "completed" ||
		input.run.conclusion !== "success" ||
		record === null ||
		fieldOf(record, "version") !== 1 ||
		fieldOf(record, "status") !== "passed" ||
		reportId === null ||
		reportId < 1 ||
		fieldOf(record, "candidateSha") !== v.candidateSha ||
		fieldOf(record, "gateSha") !== v.gateSha ||
		fieldOf(record, "runId") !== input.run.id ||
		fieldOf(record, "nonce") !== input.nonce ||
		fieldOf(record, "workflow") !== ".github/workflows/ci.yml" ||
		fieldOf(record, "event") !== "workflow_dispatch" ||
		fieldOf(record, "ref") !== "refs/heads/main" ||
		fieldOf(record, "actor") !== CONTROLLER_LOGIN ||
		fieldOf(record, "triggeringActor") !== CONTROLLER_LOGIN ||
		fieldOf(record, "externalId") !== externalId ||
		fieldOf(record, "heldoutDigest") !== v.heldoutDigest ||
		listed === null ||
		total !== listed.length ||
		listed.length > 100
	)
		return null;

	const reports = listed.filter(
		(item) => fieldOf(objectOf(item), "name") === "factory-gates",
	);

	if (reports.length !== 1) return null;
	const report = objectOf(reports[0]);

	if (
		fieldOf(report, "id") !== reportId ||
		fieldOf(report, "head_sha") !== v.candidateSha ||
		fieldOf(objectOf(fieldOf(report, "app")), "id") !== 15368 ||
		fieldOf(report, "external_id") !== externalId ||
		fieldOf(report, "status") !== "completed" ||
		fieldOf(report, "conclusion") !== "success"
	)
		return null;

	return Object.freeze({
		candidateSha: v.candidateSha,
		gateSha: v.gateSha,
		ciRunId: v.ciRunId,
		reportId,
		nonce: input.nonce,
		heldoutDigest: v.heldoutDigest,
		externalId,
	});
}

export type ValidationState = {
	readonly version: 1 | 2;
	readonly generation?: {
		readonly index: number;
		readonly digest: Digest;
		readonly previousHead: GitSha | null;
	};
	readonly startedAt: number;
	readonly deadline: number;
	readonly round: number;
	readonly originalBase: GitSha;
	baseSha: GitSha;
	rebaseSha?: GitSha;
	baseResolved: boolean;
	publication: Publication | null;
	dispatchTry: number;
	dispatchedAt: number | null;
	ciRunId: number | null;
	counters: TransportCounters;
};

export type ValidationInput = {
	readonly runId: Digest;
	readonly issue: number;
	readonly eventAt: string;
	readonly baseSha: GitSha;
	readonly now: number;
	readonly wallMs: number;
	readonly round?: number;
	readonly generation?: import("./handoff.ts").GenerationIntent;
	readonly state: ValidationState | null;
	readonly save: (state: ValidationState) => Promise<boolean>;
	readonly dispatchAllowed?: boolean;
};

export type ValidationResult =
	| { readonly kind: "waiting"; readonly state: ValidationState }
	| {
			readonly kind: "finished";
			readonly state: ValidationState;
			readonly verdict: Verdict;
			readonly report?: TrustedReport;
			readonly assessment: ReadAssessment;
	  }
	| {
			readonly kind: "failed";
			readonly state: ValidationState | null;
			readonly reason: string;
	  };

export type Validator = (input: ValidationInput) => Promise<ValidationResult>;

export function validationDir(
	stateDir: string,
	runId: string,
	round = 0,
	generation = 0,
): string {
	const dir =
		round === 0
			? join(stateDir, "validation", runId)
			: join(stateDir, "validation", runId, `r${round}`);

	return generation === 0 ? dir : join(dir, `g${generation}`);
}

export function dispatchNonce(
	runId: Digest,
	round: number,
	dispatchTry: number,
	generation = 0,
): string {
	return `${runId.slice(0, 16)}-r${round}-d${dispatchTry}${generation === 0 ? "" : `-g${generation}`}`;
}

export function publishedSuite(input: {
	issue: number;
	suite: AcceptanceSuite;
	canary: string;
	acceptanceDigest: Digest;
}) {
	if (acceptanceDigestOf(input.suite, input.canary) !== input.acceptanceDigest)
		throw new Error("acceptance_changed");

	if (input.suite.files.length === 0) throw new Error("empty_checks");
	const directory = `test/acceptance/${input.issue}`;

	const files = acceptanceEntries(input.suite, input.canary).flatMap(
		([path, text]): PublishedFile[] =>
			path.startsWith("checks/")
				? [
						{
							path: `${directory}/${path}`,
							mode: "100644",
							bytes: Buffer.from(text),
						},
					]
				: [],
	);

	const digest = digestOf(
		JSON.stringify(
			files.map((f) => [f.path, digestOf(f.bytes ?? new Uint8Array())]),
		),
	);

	return { files, digest, directory };
}

export type CiRun = {
	readonly id: number;
	readonly headSha: GitSha;
	readonly headBranch: string;
	readonly completedAt: string | null;
	readonly title: string;
	readonly status: string;
	readonly conclusion: string | null;
	readonly event: string;
	readonly path: string;
	readonly actor: string;
	readonly triggeringActor: string;
	readonly createdAt: string;
};

export function parseCiRun(value: JsonValue | undefined): CiRun | null {
	const object = objectOf(value);
	const id = countOf(fieldOf(object, "id"));
	const headSha = textOf(fieldOf(object, "head_sha"));
	const headBranch = textOf(fieldOf(object, "head_branch"));
	const completedAt = textOf(fieldOf(object, "updated_at"));
	const title = textOf(fieldOf(object, "display_title"));
	const status = textOf(fieldOf(object, "status"));
	const rawConclusion = fieldOf(object, "conclusion");
	const conclusion = rawConclusion === null ? null : textOf(rawConclusion);
	const event = textOf(fieldOf(object, "event"));
	const path = textOf(fieldOf(object, "path"));
	const actor = textOf(fieldOf(objectOf(fieldOf(object, "actor")), "login"));

	const triggeringActor = textOf(
		fieldOf(objectOf(fieldOf(object, "triggering_actor")), "login"),
	);

	const createdAt = textOf(fieldOf(object, "created_at"));

	if (
		id === null ||
		id < 1 ||
		headSha === null ||
		!isGitSha(headSha) ||
		headBranch === null ||
		(completedAt !== null && !Number.isFinite(Date.parse(completedAt))) ||
		title === null ||
		status === null ||
		(rawConclusion !== null && conclusion === null) ||
		event === null ||
		path === null ||
		actor === null ||
		triggeringActor === null ||
		createdAt === null ||
		!Number.isFinite(Date.parse(createdAt))
	)
		return null;

	return {
		id,
		headSha,
		headBranch,
		completedAt,
		title,
		status,
		conclusion,
		event,
		path,
		actor,
		triggeringActor,
		createdAt,
	};
}

export function matchesCiRun(
	run: CiRun,
	candidate: GitSha,
	nonce: string,
	startedAt: number,
): boolean {
	return (
		run.title === `gates ${candidate} ${nonce}` &&
		run.headBranch === "main" &&
		run.event === "workflow_dispatch" &&
		run.path === ".github/workflows/ci.yml" &&
		run.actor === CONTROLLER_LOGIN &&
		run.triggeringActor === CONTROLLER_LOGIN &&
		Date.parse(run.createdAt) >= Math.floor(startedAt / 1000) * 1000
	);
}

export function collectVerdict(input: {
	readonly text: string | null;
	readonly run: CiRun;
	readonly nonce: string;
	readonly patchDigest: Digest;
	readonly acceptanceDigest: Digest;
	readonly heldoutDigest: Digest;
	readonly candidateSha: GitSha;
	readonly originalBase: GitSha;
	readonly baseSha: GitSha;
	readonly unjudged: readonly string[];
}): Verdict {
	const value = objectOf(parseJson(input.text ?? ""));
	const required = textsOf(fieldOf(value, "requiredChecks")) ?? [];
	const raw = arrayOf(fieldOf(value, "checks")) ?? [];

	const checks = raw.map((item) => {
		const check = objectOf(item);

		return {
			name: textOf(fieldOf(check, "name")) ?? "invalid",
			passed:
				fieldOf(check, "exitCode") === 0 &&
				fieldOf(check, "timedOut") !== true &&
				fieldOf(check, "signal") == null,
		};
	});

	const verdict: Verdict = {
		patchDigest: input.patchDigest,
		acceptanceDigest: input.acceptanceDigest,
		heldoutDigest: input.heldoutDigest,
		candidateSha: input.candidateSha,
		gateSha: input.run.headSha,
		ciRunId: input.run.id,
		originalBase: input.originalBase,
		baseSha: input.baseSha,
		pass:
			matchesCiRun(input.run, input.candidateSha, input.nonce, 0) &&
			input.run.headSha === input.baseSha &&
			input.run.status === "completed" &&
			input.run.conclusion === "success" &&
			fieldOf(value, "version") === 2 &&
			fieldOf(value, "status") === "passed" &&
			fieldOf(value, "modelCalls") === 0 &&
			fieldOf(value, "gateSha") === input.run.headSha &&
			fieldOf(value, "candidateSha") === input.candidateSha &&
			fieldOf(value, "nonce") === input.nonce &&
			fieldOf(value, "heldoutDigest") === input.heldoutDigest,
		checks,
		requiredChecks: required,
		unjudged: [...input.unjudged],
	};

	return { ...verdict, pass: verdictPasses(verdict) };
}

export function repairFeedback(
	suite: AcceptanceSuite,
	contract: Pick<Contract, "acceptance">,
	failures: readonly string[],
	directory: string,
) {
	const failed = new Set(
		failures.map((file) =>
			file.startsWith(`${directory}/checks/`)
				? file.slice(`${directory}/checks/`.length)
				: "",
		),
	);

	return suite.scenarios.flatMap((scenario) =>
		scenario.checks.some((path) => failed.has(path))
			? [
					{
						scenario: scenario.id,
						criteria: contract.acceptance
							.filter((criterion) => scenario.criteria.includes(criterion.id))
							.map(({ id, text }) => ({ id, text })),
					},
				]
			: [],
	);
}

export function parseValidationState(
	value: JsonValue | undefined,
): ValidationState | null {
	const object = objectOf(value);
	const startedAt = countOf(fieldOf(object, "startedAt"));
	const deadline = countOf(fieldOf(object, "deadline"));
	const round = countOf(fieldOf(object, "round"));
	const originalBase = textOf(fieldOf(object, "originalBase"));
	const baseSha = textOf(fieldOf(object, "baseSha"));
	const rawRebase = fieldOf(object, "rebaseSha");
	const rebaseSha = textOf(rawRebase);
	const dispatchTry = countOf(fieldOf(object, "dispatchTry"));
	const rawAt = fieldOf(object, "dispatchedAt");
	const dispatchedAt = rawAt === null ? null : countOf(rawAt);
	const rawRun = fieldOf(object, "ciRunId");
	const ciRunId = rawRun === null ? null : countOf(rawRun);
	const rawPublication = fieldOf(object, "publication");
	const pub = objectOf(rawPublication);
	const branch = textOf(fieldOf(pub, "branch"));
	const patchSha = textOf(fieldOf(pub, "patchSha"));
	const candidateSha = textOf(fieldOf(pub, "candidateSha"));
	const counters = objectOf(fieldOf(object, "counters"));

	if (
		(fieldOf(object, "baseResolved") !== true &&
			fieldOf(object, "baseResolved") !== false) ||
		(fieldOf(object, "version") !== 1 && fieldOf(object, "version") !== 2) ||
		startedAt === null ||
		deadline === null ||
		deadline <= startedAt ||
		round === null ||
		round > 2 ||
		originalBase === null ||
		!isGitSha(originalBase) ||
		baseSha === null ||
		!isGitSha(baseSha) ||
		(rawRebase !== undefined && (rebaseSha === null || !isGitSha(rebaseSha))) ||
		dispatchTry === null ||
		dispatchTry > 2 ||
		(rawAt !== null && dispatchedAt === null) ||
		(rawRun !== null && (ciRunId === null || ciRunId < 1)) ||
		counters === null
	)
		return null;
	let publication: Publication | null = null;

	if (rawPublication !== null) {
		if (
			branch === null ||
			!/^factory\/run\/[1-9][0-9]*-[a-f0-9]{12}-r[0-2](?:-g[1-3])?$/.test(
				branch,
			) ||
			patchSha === null ||
			!isGitSha(patchSha) ||
			candidateSha === null ||
			!isGitSha(candidateSha)
		)
			return null;
		publication = { branch, patchSha, candidateSha };
	}

	const counts: TransportCounters = {};

	for (const [key, value] of Object.entries(counters)) {
		if (
			!isDigest(key) ||
			!Number.isSafeInteger(value) ||
			Number(value) < 0 ||
			Number(value) > 3
		)
			return null;
		counts[key] = Number(value);
	}

	const gen = objectOf(fieldOf(object, "generation"));
	const index = countOf(fieldOf(gen, "index"));
	const intent = textOf(fieldOf(gen, "digest"));
	const previous = fieldOf(gen, "previousHead");

	if (
		fieldOf(object, "version") === 2 &&
		(index === null ||
			index > 3 ||
			intent === null ||
			!isDigest(intent) ||
			(previous !== null &&
				(textOf(previous) === null || !isGitSha(String(previous)))))
	)
		return null;

	const state: ValidationState = {
		version: fieldOf(object, "version") === 2 ? 2 : 1,
		startedAt,
		deadline,
		round,
		originalBase,
		baseSha,
		dispatchTry,
		dispatchedAt,
		ciRunId,
		publication,
		baseResolved: fieldOf(object, "baseResolved") === true,
		counters: counts,
	};

	if (rebaseSha !== null && isGitSha(rebaseSha)) state.rebaseSha = rebaseSha;
	const previousHead = previous === null ? null : textOf(previous);

	if (
		index !== null &&
		intent !== null &&
		isDigest(intent) &&
		(previousHead === null || isGitSha(previousHead))
	)
		return { ...state, generation: { index, digest: intent, previousHead } };

	return state;
}

export type AssessmentRef = Readonly<{
	bindingDigest: Digest;
	recordDigest: Digest;
}>;

export type AssessmentBinding = Readonly<{
	runId: Digest;
	round: number;
	generation: number;
	candidateSha: string;
	ciRunId: number;
	verdictDigest: Digest;
}>;

export type ValidationAssessment =
	| Readonly<{ kind: "passed" }>
	| Readonly<{ kind: "failed"; failure: FailureClass }>;

export type AssessmentRecord = Readonly<{
	version: 1;
	classifier: 1;
	binding: AssessmentBinding;
	assessment: ValidationAssessment;
}>;

export type ReadAssessment = Readonly<{
	ref: AssessmentRef;
	binding: AssessmentBinding;
	assessment: ValidationAssessment;
}>;

export type RepairFeedbackFile = Readonly<{
	version: 2;
	assessment: AssessmentRef;
	scenarios: ReturnType<typeof repairFeedback>;
}>;

export function assessmentBinding(input: {
	runId: Digest;
	round: number;
	generation: number;
	verdict: Verdict;
}): AssessmentBinding {
	return {
		runId: input.runId,
		round: input.round,
		generation: input.generation,
		candidateSha: input.verdict.candidateSha,
		ciRunId: input.verdict.ciRunId,
		verdictDigest: digestOf(JSON.stringify(input.verdict)),
	};
}

export function assessmentBytes(
	binding: AssessmentBinding,
	assessment: ValidationAssessment,
): string {
	const record: AssessmentRecord = {
		version: 1,
		classifier: 1,
		binding: {
			runId: binding.runId,
			round: binding.round,
			generation: binding.generation,
			candidateSha: binding.candidateSha,
			ciRunId: binding.ciRunId,
			verdictDigest: binding.verdictDigest,
		},
		assessment:
			assessment.kind === "passed"
				? { kind: "passed" }
				: { kind: "failed", failure: assessment.failure },
	};

	return `${JSON.stringify(record)}\n`;
}

function parseAssessmentBinding(
	value: JsonValue | undefined,
): AssessmentBinding | null {
	const v = objectOf(value);
	const runId = textOf(fieldOf(v, "runId"));
	const round = countOf(fieldOf(v, "round"));
	const generation = countOf(fieldOf(v, "generation"));
	const candidateSha = textOf(fieldOf(v, "candidateSha"));
	const ciRunId = countOf(fieldOf(v, "ciRunId"));
	const verdictDigest = textOf(fieldOf(v, "verdictDigest"));

	return runId !== null &&
		isDigest(runId) &&
		round !== null &&
		round <= 2 &&
		generation !== null &&
		generation <= 3 &&
		candidateSha !== null &&
		isGitSha(candidateSha) &&
		ciRunId !== null &&
		verdictDigest !== null &&
		isDigest(verdictDigest)
		? { runId, round, generation, candidateSha, ciRunId, verdictDigest }
		: null;
}

export function readAssessmentBytes(text: string): ReadAssessment | null {
	const v = objectOf(parseJson(text));
	const binding = parseAssessmentBinding(fieldOf(v, "binding"));
	const raw = objectOf(fieldOf(v, "assessment"));

	const assessment: ValidationAssessment | null =
		fieldOf(raw, "kind") === "passed"
			? { kind: "passed" }
			: fieldOf(raw, "kind") === "failed"
				? (() => {
						const failure = parseFailureClass(fieldOf(raw, "failure"));

						return failure === null ? null : { kind: "failed", failure };
					})()
				: null;

	if (
		fieldOf(v, "version") !== 1 ||
		fieldOf(v, "classifier") !== 1 ||
		binding === null ||
		assessment === null ||
		assessmentBytes(binding, assessment) !== text
	)
		return null;

	return {
		ref: {
			bindingDigest: digestOf(JSON.stringify(binding)),
			recordDigest: digestOf(text),
		},
		binding,
		assessment,
	};
}

export function sameAssessmentRef(
	a: AssessmentRef | null | undefined,
	b: AssessmentRef | null | undefined,
): boolean {
	return (
		a != null &&
		b != null &&
		a.bindingDigest === b.bindingDigest &&
		a.recordDigest === b.recordDigest
	);
}

export function feedbackBytes(
	ref: AssessmentRef,
	scenarios: ReturnType<typeof repairFeedback>,
): string {
	const file: RepairFeedbackFile = {
		version: 2,
		assessment: {
			bindingDigest: ref.bindingDigest,
			recordDigest: ref.recordDigest,
		},
		scenarios,
	};

	return `${JSON.stringify(file)}\n`;
}

export function readFeedbackBytes(
	text: string,
	ref: AssessmentRef,
): ReturnType<typeof repairFeedback> | null {
	const v = objectOf(parseJson(text));
	const a = objectOf(fieldOf(v, "assessment"));
	const list = arrayOf(fieldOf(v, "scenarios"));

	const scenarios: {
		scenario: string;
		criteria: { id: string; text: string }[];
	}[] = [];

	for (const item of list ?? []) {
		const o = objectOf(item);
		const scenario = textOf(fieldOf(o, "scenario"));
		const criteria: { id: string; text: string }[] = [];

		for (const c of arrayOf(fieldOf(o, "criteria")) ?? []) {
			const id = textOf(fieldOf(objectOf(c), "id"));
			const body = textOf(fieldOf(objectOf(c), "text"));

			if (id === null || body === null) return null;
			criteria.push({ id, text: body });
		}

		if (scenario === null) return null;
		scenarios.push({ scenario, criteria });
	}

	const bindingDigest = textOf(fieldOf(a, "bindingDigest"));
	const recordDigest = textOf(fieldOf(a, "recordDigest"));

	return fieldOf(v, "version") === 2 &&
		list !== null &&
		bindingDigest === ref.bindingDigest &&
		recordDigest === ref.recordDigest &&
		feedbackBytes(ref, scenarios) === text
		? scenarios
		: null;
}
