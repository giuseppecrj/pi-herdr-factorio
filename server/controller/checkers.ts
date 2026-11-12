import {
	regularText,
	exclusive,
	privateDir,
	present,
} from "../../src/contract/artifacts.ts";
import {
	objectOf,
	fieldOf as jsonField,
	textOf,
	textsOf,
	countOf,
} from "../../src/core/json.ts";
import { digestOf, type Digest } from "../../src/core/run.ts";
import { execFile } from "node:child_process";
import { randomBytes } from "node:crypto";
import {
	readFileSync,
	readdirSync,
	mkdirSync,
	existsSync,
	lstatSync,
} from "node:fs";
import {
	materializeFromDirectories,
	replayHeldoutCandidate,
	runHeldoutBase,
	runDraftBase,
	validateDependencies,
	type GateRunner,
} from "../gates.ts";
import type { AcceptanceBinding } from "../../src/contract/acceptance.ts";
import {
	assessBase,
	draftCheckFeedback,
	parseBaseReason,
	parseBaseReceipt,
	parseHeldoutReplay,
	type BaseCheckInput,
	type BaseCheckProgress,
	type BaseReason,
	type BaseReceipt,
	type DiagnosisNeeds,
	type HeldoutReplay,
} from "../../src/candidate/diagnosis.ts";
import {
	writeAcceptance,
	acceptanceDigestOf,
	type AcceptanceSuite,
} from "../../src/contract/acceptance.ts";
import { type DraftCheckContext, type StageRunInput } from "../sandbox.ts";
import type { Contract, ReplacedTest } from "../../src/contract/contract.ts";
import { scopeOwner, scopeUnit, stopScopeArgv } from "../sandbox/scope.ts";
import { mkdir, rm } from "node:fs/promises";
import { join } from "node:path";
import type { GitSha } from "../../src/config/schema.ts";
import type { RepoSlug } from "../../src/trust/platform.ts";
import { parseJson, writeAtomic, keepValidationFile } from "./state.ts";
import {
	type TarballFetch,
	ghTarball,
	checkoutWorkspace,
	checkoutTree,
} from "./checkout.ts";
import { fileRunFiles } from "./run-files.ts";

export function controllerDraftChecker(config: {
	readonly stateDir: string;
	readonly stageDir: string;
	readonly attempt: number;
	readonly input: NonNullable<
		import("../../src/orchestrator.ts").StageLaunchInput["acceptDraft"]
	>;
	readonly fetch?: TarballFetch;
	readonly runner?: GateRunner;
}): NonNullable<StageRunInput["draftCheck"]> {
	let cached: ReturnType<TarballFetch> | null = null;

	const fetch: TarballFetch = (repo, sha, bound) => {
		cached ??= (config.fetch ?? ghTarball)(repo, sha, bound);

		return cached;
	};

	return async (text: string, context: DraftCheckContext) => {
		const parsed = writeAcceptance(text, config.input.contract);

		if (parsed.kind !== "suite") return null;
		const { contract, digest, repo, issue, baseSha } = config.input;

		const dir = join(config.stageDir, `draft-${context.run}`),
			tree = join(dir, "source");

		privateDir(dir);
		const deadline = context.deadline;

		const signal = AbortSignal.any([
			context.signal,
			AbortSignal.timeout(Math.max(1, deadline - Date.now())),
		]);

		const startedAt = Date.now();
		const canary = `factory-holdout-${randomBytes(32).toString("hex")}`;

		try {
			await mkdir(tree, { mode: 0o700 });

			const checked = await checkoutWorkspace({
				stateDir: dir,
				runId: contract.runId,
				workspace: tree,
				repo,
				sha: baseSha,
				fetch,
				signal,
				deadline,
			});

			const { evidence, details } = await runDraftBase({
				tree,
				workDir: dir,
				cacheDir: join(config.stateDir, "base-dependencies"),
				binding: {
					runId: contract.runId,
					repo,
					issue,
					contractDigest: digest,
					acceptanceDigest: acceptanceDigestOf(parsed.suite, canary),
					baseSha,
					gateSha: baseSha,
				},
				contract,
				suite: parsed.suite,
				canary,
				startedAt,
				deadline,
				signal,
				scope: scopeUnit(
					scopeOwner(config.stateDir),
					contract.runId,
					"draftcheck",
					config.attempt,
					randomBytes(4).toString("hex"),
				),
				runner: config.runner,
				refused:
					checked.kind === "unavailable"
						? "tree_unavailable"
						: checked.kind === "refused"
							? "tree_refused"
							: checked.omitted !== 0
								? "tree_partial"
								: undefined,
			});

			const { receipt } = assessBase(evidence);

			const feedback = {
				...draftCheckFeedback(receipt, details, issue),
				run: context.run,
			};

			exclusive(
				join(config.stageDir, `draft-${context.run}.json`),
				JSON.stringify({ receipt, details, feedback }),
			);

			return feedback;
		} finally {
			await rm(dir, { recursive: true, force: true });
		}
	};
}

export function controllerBaseChecker(config: {
	readonly stateDir: string;
	readonly fetch?: TarballFetch;
}) {
	const jobs = new Map<
		string,
		{ runId: Digest; abort: AbortController; done: Promise<void> }
	>();

	const files = fileRunFiles(config.stateDir);

	const fail = (
		input: BaseCheckInput,
		reason: "base_evidence_missing" | "base_runner_error" | "base_timeout",
	): BaseCheckProgress => ({
		kind: "refused",
		failure: {
			binding: input.binding,
			receiptDigest: digestOf(JSON.stringify([input.binding, reason])),
			reason,
			scenarios: [],
		},
	});

	/**
	 * Every attempt's base-check wall on one binding: each stored receipt's run
	 * plus each interruption's charge. `null` when an attempt has neither.
	 */
	const bindingWall = (parent: string): number | null => {
		let charged = 0;

		if (!existsSync(parent)) return 0;

		for (const name of readdirSync(parent)) {
			if (!/^a[1-9][0-9]*$/.test(name)) return null;
			const previous = join(parent, name);

			const completed = present(join(previous, "result.json"))
				? parseBaseReceipt(
						regularText(join(previous, "result.json"), 2 * 1024 * 1024),
					)
				: null;

			const interrupted = present(join(previous, "interrupted.json"))
				? countOf(
						jsonField(
							objectOf(
								parseJson(regularText(join(previous, "interrupted.json"))),
							),
							"wallMs",
						),
					)
				: null;

			if (completed !== null)
				charged += completed.evidence.finishedAt - completed.evidence.startedAt;
			else if (interrupted !== null) charged += interrupted;
			else return null;
		}

		return charged;
	};

	const check = async (input: BaseCheckInput): Promise<BaseCheckProgress> => {
		const bindingDigest = digestOf(JSON.stringify(input.binding));

		const parent = join(
			config.stateDir,
			"base-check",
			input.binding.runId,
			bindingDigest,
		);

		const stored =
			input.readOnly && existsSync(parent)
				? readdirSync(parent)
						.flatMap((name) => {
							const n = /^a([1-9][0-9]*)$/.exec(name)?.[1];

							return n !== undefined &&
								present(join(parent, name, "result.json"))
								? [Number(n)]
								: [];
						})
						.sort((a, b) => b - a)[0]
				: undefined;

		const dir = join(parent, `a${stored ?? input.acceptAttempt}`);
		const resultPath = join(dir, "result.json");

		try {
			if (input.binding.gateSha !== input.binding.baseSha)
				return fail(input, "base_evidence_missing");

			if (input.storedAttempt !== undefined) {
				const receipt = await files.artifacts.receipt(
					input.binding.runId,
					input.binding.acceptanceDigest,
				);

				if (
					receipt === null ||
					receipt.contractDigest !== input.binding.contractDigest ||
					receipt.baseSha !== input.binding.baseSha ||
					(receipt.storedAttempt !== undefined &&
						receipt.storedAttempt !== input.storedAttempt)
				)
					return fail(input, "base_evidence_missing");
			}

			if (present(resultPath)) {
				const text = regularText(resultPath, 2 * 1024 * 1024);
				const receipt = parseBaseReceipt(text);

				if (
					receipt === null ||
					digestOf(text) !== regularText(join(dir, "result.digest")) ||
					JSON.stringify(receipt.evidence.binding) !==
						JSON.stringify(input.binding)
				)
					return fail(input, "base_evidence_missing");
				const { assessment } = assessBase(receipt.evidence);

				if (assessment.kind !== "refused") return assessment;
				let baseWallMs: number | null;

				try {
					baseWallMs = bindingWall(parent);
				} catch {
					baseWallMs = null;
				}

				// The receipt goes only to the accept retry's private feedback; its
				// binding's whole base wall is charged before any retry is granted.
				return baseWallMs === null
					? { ...assessment, receipt }
					: { ...assessment, receipt, baseWallMs };
			}

			if (input.readOnly) return fail(input, "base_evidence_missing");

			if (jobs.has(dir)) return { kind: "checking" };

			if (present(join(dir, "intent.json"))) {
				const intent = objectOf(
					parseJson(regularText(join(dir, "intent.json"))),
				);

				const startedAt = countOf(jsonField(intent, "startedAt")),
					deadline = countOf(jsonField(intent, "deadline"));

				if (
					startedAt === null ||
					deadline === null ||
					deadline < startedAt ||
					jsonField(intent, "bindingDigest") !== bindingDigest
				)
					return fail(input, "base_evidence_missing");
				const interrupted = join(dir, "interrupted.json");
				const record = `${JSON.stringify({ wallMs: deadline - startedAt })}\n`;

				if (!present(interrupted)) exclusive(interrupted, record);
				else if (regularText(interrupted) !== record)
					return fail(input, "base_evidence_missing");

				return { kind: "interrupted", wallMs: deadline - startedAt };
			}

			if (input.allowLaunch === false) return { kind: "checking" };
			const bound = await files.readContract(input.binding.runId);

			if (
				bound.kind !== "found" ||
				bound.digest !== input.binding.contractDigest ||
				bound.contract.base.sha !== input.binding.baseSha ||
				bound.contract.base.repo !== input.binding.repo ||
				bound.contract.issue !== input.binding.issue
			)
				return fail(input, "base_evidence_missing");

			const suite = await files.artifacts.read(
				input.binding.runId,
				bound.contract,
				bound.digest,
			);

			if (
				suite.kind !== "found" ||
				suite.receipt.acceptanceDigest !== input.binding.acceptanceDigest
			)
				return fail(input, "base_evidence_missing");
			const charged = bindingWall(parent);

			if (charged === null) return fail(input, "base_evidence_missing");

			const startedAt = Date.now();

			const allowance = Math.max(
				0,
				Math.min(180_000, input.remainingAcceptMs - charged),
			);

			const deadline = startedAt + allowance;

			const scope = scopeUnit(
				scopeOwner(config.stateDir),
				input.binding.runId,
				"basecheck",
				input.acceptAttempt,
				randomBytes(4).toString("hex"),
			);

			privateDir(parent);
			mkdirSync(dir, { mode: 0o700 });
			exclusive(
				join(dir, "intent.json"),
				`${JSON.stringify({ bindingDigest, binding: input.binding, startedAt, deadline, scope })}\n`,
			);
			const abort = new AbortController();
			const externalAbort = () => abort.abort();
			input.signal.addEventListener("abort", externalAbort, { once: true });

			if (input.signal.aborted) abort.abort();

			const done = (async () => {
				const tree = join(dir, "source");
				await mkdir(tree, { mode: 0o700 });

				const checked =
					Date.now() < deadline && !abort.signal.aborted
						? await checkoutWorkspace({
								stateDir: dir,
								runId: input.binding.runId,
								workspace: tree,
								repo: input.binding.repo,
								sha: input.binding.baseSha,
								fetch: config.fetch ?? ghTarball,
							})
						: ({ kind: "unavailable" } as const);

				const evidence = await runHeldoutBase({
					tree,
					refused:
						checked.kind === "unavailable"
							? "tree_unavailable"
							: checked.kind === "refused"
								? "tree_refused"
								: checked.omitted !== 0
									? "tree_partial"
									: undefined,
					workDir: dir,
					cacheDir: join(config.stateDir, "base-dependencies"),
					binding: input.binding,
					contract: bound.contract,
					suite: suite.suite,
					canary: regularText(
						join(
							config.stateDir,
							"acceptance",
							input.binding.runId,
							"canary.txt",
						),
					).trimEnd(),
					startedAt,
					deadline,
					scope,
					signal: abort.signal,
				});

				const { receipt } = assessBase(evidence);
				const text = JSON.stringify(receipt);
				await rm(join(dir, "tree"), { recursive: true, force: true });
				await rm(tree, { recursive: true, force: true });
				await rm(join(dir, "checkouts"), { recursive: true, force: true });
				exclusive(join(dir, "result.digest"), digestOf(text));

				if (!(await writeAtomic(resultPath, text)))
					throw new Error("base_result_unwritable");
			})().finally(() => {
				input.signal.removeEventListener("abort", externalAbort);
				jobs.delete(dir);
			});

			jobs.set(dir, { runId: input.binding.runId, abort, done });
			void done.catch(() => {});

			return { kind: "checking" };
		} catch {
			return fail(input, "base_evidence_missing");
		}
	};

	return {
		check,
		async stop(runId: Digest) {
			const owned = [...jobs.values()].filter((j) => j.runId === runId);

			for (const job of owned) job.abort.abort();
			await Promise.allSettled(owned.map((j) => j.done));
		},
	};
}

export type DiagnosisFacts = Readonly<{
	base: BaseReceipt | null;
	baseRefusal: BaseReason | null;
	ignoredChanges: readonly string[] | null;
	replay: HeldoutReplay | null;
	dependencies: Readonly<{ reason: string | null }> | null;
}>;

export type DiagnosisRequest = Readonly<{
	runId: Digest;
	dir: string;
	bindingDigest: Digest;
	repo: RepoSlug;
	gateSha: GitSha;
	candidateSha: GitSha;
	round: number;
	allowanceMs: number;
	needs: DiagnosisNeeds;
	heldoutDir: string;
	heldoutDigest: string;
	replacements: readonly ReplacedTest[];
	base:
		| Readonly<{ kind: "stored"; receipt: BaseReceipt | null }>
		| Readonly<{
				kind: "fresh";
				binding: AcceptanceBinding;
				contract: Contract;
				suite: AcceptanceSuite;
				canary: string;
		  }>;
	finish: (facts: DiagnosisFacts) => void;
	interrupted: () => void;
}>;

export function storedBaseReceipt(
	stateDir: string,
	binding: AcceptanceBinding,
): BaseReceipt | null {
	const parent = join(
		stateDir,
		"base-check",
		binding.runId,
		digestOf(JSON.stringify(binding)),
	);

	if (!existsSync(parent)) return null;

	const attempts = readdirSync(parent)
		.flatMap((name) => {
			const n = /^a([1-9][0-9]*)$/.exec(name)?.[1];

			return n === undefined ? [] : [Number(n)];
		})
		.sort((a, b) => b - a);

	for (const n of attempts) {
		const dir = join(parent, `a${n}`);

		if (!present(join(dir, "result.json"))) continue;
		const text = regularText(join(dir, "result.json"), 2 * 1024 * 1024);
		const receipt = parseBaseReceipt(text);

		return receipt !== null &&
			digestOf(text) === regularText(join(dir, "result.digest")) &&
			JSON.stringify(receipt.evidence.binding) === JSON.stringify(binding)
			? receipt
			: null;
	}

	return null;
}

function dependencyFacts(
	gate: string,
	candidate: string,
): DiagnosisFacts["dependencies"] {
	const text = (tree: string, name: string) =>
		readFileSync(join(tree, name), "utf8");

	try {
		validateDependencies(
			text(gate, "package.json"),
			text(gate, "package-lock.json"),
			text(gate, "package-lock.json"),
		);
	} catch {
		return null;
	}

	try {
		validateDependencies(
			text(candidate, "package.json"),
			text(candidate, "package-lock.json"),
			text(gate, "package-lock.json"),
		);

		return { reason: null };
	} catch (error) {
		return { reason: error instanceof Error ? error.message : null };
	}
}

async function stopDiagnosisScope(unit: string): Promise<void> {
	const [command = "systemctl", ...args] = stopScopeArgv(unit);

	await new Promise<void>((done) => {
		execFile(
			command,
			args,
			{
				env: {
					PATH: "/usr/bin:/bin",
					XDG_RUNTIME_DIR: process.env.XDG_RUNTIME_DIR,
				},
				timeout: 5_000,
			},
			() => done(),
		);
	});
}

function completedDiagnosis(root: string): DiagnosisFacts | null {
	try {
		if (
			!present(join(root, "replay.json")) ||
			!present(join(root, "charge.json"))
		)
			return null;
		const charge = objectOf(parseJson(regularText(join(root, "charge.json"))));
		const text = regularText(join(root, "replay.json"), 4 * 1024 * 1024);
		const raw = objectOf(parseJson(text));
		const rawBase = jsonField(raw, "base");
		const rawRefusal = jsonField(raw, "baseRefusal");
		const rawIgnored = jsonField(raw, "ignoredChanges");
		const rawReplay = jsonField(raw, "replay");
		const rawDependencies = jsonField(raw, "dependencies");

		const base =
			rawBase === null ? null : parseBaseReceipt(JSON.stringify(rawBase));

		const ignoredChanges = rawIgnored === null ? null : textsOf(rawIgnored);
		const replay = rawReplay === null ? null : parseHeldoutReplay(rawReplay);

		const dependencies =
			rawDependencies === null
				? null
				: { reason: textOf(jsonField(objectOf(rawDependencies), "reason")) };

		const refusal = parseBaseReason(rawRefusal);

		if (
			countOf(jsonField(charge, "wallMs")) === null ||
			jsonField(charge, "tokens") !== 0 ||
			(rawBase !== null && base === null) ||
			(rawRefusal !== null && refusal === null) ||
			(rawIgnored !== null && ignoredChanges === null) ||
			(rawReplay !== null && replay === null)
		)
			return null;

		const facts: DiagnosisFacts = {
			base,
			baseRefusal: refusal,
			ignoredChanges,
			replay,
			dependencies,
		};

		return `${JSON.stringify(facts)}\n` === text ? facts : null;
	} catch {
		return null;
	}
}

function sameMaterializer(gate: string, source: Uint8Array): boolean {
	const path = join(gate, "server/gates.ts");

	try {
		const stat = lstatSync(path);

		return (
			stat.isFile() &&
			stat.size === source.byteLength &&
			Buffer.from(source).equals(readFileSync(path))
		);
	} catch {
		return false;
	}
}

export function controllerDiagnosis(config: {
	readonly stateDir: string;
	readonly fetch?: TarballFetch;
	readonly runner?: GateRunner;
	readonly materialize?: (input: {
		readonly gateTree: string;
		readonly candidateTree: string;
		readonly dest: string;
		readonly replacements: readonly ReplacedTest[];
		readonly heldoutDir: string;
		readonly heldoutDigest: string;
	}) => { readonly ignoredChanges: readonly string[] };
	readonly materializerSource?: Uint8Array;
	readonly stopScope?: (unit: string) => Promise<void>;
}) {
	const stopScope = config.stopScope ?? stopDiagnosisScope;

	const materializerSource =
		config.materializerSource ??
		readFileSync(new URL("../gates.ts", import.meta.url));

	const jobs = new Map<
		string,
		{ runId: Digest; abort: AbortController; done: Promise<void> }
	>();

	const check = async (
		request: DiagnosisRequest,
	): Promise<"checking" | "settled"> => {
		const root = join(request.dir, "diagnosis", request.bindingDigest);
		const intentPath = join(root, "intent.json");

		if (jobs.has(root)) return "checking";

		if (present(intentPath)) {
			const intent = objectOf(parseJson(regularText(intentPath)));

			const startedAt = countOf(jsonField(intent, "startedAt")),
				deadline = countOf(jsonField(intent, "deadline")),
				unit = textOf(jsonField(intent, "scope"));

			if (
				startedAt === null ||
				deadline === null ||
				deadline < startedAt ||
				unit === null ||
				jsonField(intent, "bindingDigest") !== request.bindingDigest
			)
				throw new Error("diagnosis_intent_invalid");
			const completed = completedDiagnosis(root);

			if (completed !== null) {
				request.finish(completed);

				return "settled";
			}

			await stopScope(unit);
			keepValidationFile(
				join(root, "interrupted.json"),
				`${JSON.stringify({ wallMs: deadline - startedAt, tokens: 0 })}\n`,
			);
			request.interrupted();

			return "settled";
		}

		const startedAt = Date.now();
		const deadline = startedAt + Math.min(180_000, request.allowanceMs);

		const scope = scopeUnit(
			scopeOwner(config.stateDir),
			request.runId,
			"diagnosis",
			request.round,
			randomBytes(4).toString("hex"),
		);

		privateDir(join(request.dir, "diagnosis"));
		privateDir(root);
		exclusive(
			intentPath,
			`${JSON.stringify({ bindingDigest: request.bindingDigest, gateSha: request.gateSha, candidateSha: request.candidateSha, startedAt, deadline, scope })}\n`,
		);
		const abort = new AbortController();
		const late = () => abort.signal.aborted || Date.now() >= deadline;

		const acquireBy =
			deadline - Math.min(5_000, Math.floor((deadline - startedAt) / 10));

		const work = [
			"gate",
			"candidate",
			"materialized",
			"replay",
			"base",
			"gate-meta",
			"candidate-meta",
		];

		const done = (async () => {
			let timedOut = false;

			const acquire = async (sha: GitSha, name: string) => {
				const tree = join(root, name);
				await mkdir(tree, { recursive: true, mode: 0o700 });

				if (late()) return false;

				const checked = await checkoutTree({
					stateDir: join(root, `${name}-meta`),
					runId: request.runId,
					workspace: tree,
					repo: request.repo,
					sha,
					fetch: config.fetch ?? ghTarball,
					signal: abort.signal,
					deadline: acquireBy,
				});

				timedOut ||= checked.kind === "timeout";

				return checked.kind === "ready" && checked.omitted === 0;
			};

			const gate = join(root, "gate"),
				candidate = join(root, "candidate");

			const acquired =
				(await acquire(request.gateSha, "gate")) &&
				(await acquire(request.candidateSha, "candidate"));

			let facts: DiagnosisFacts = {
				base: request.base.kind === "stored" ? request.base.receipt : null,
				baseRefusal: null,
				ignoredChanges: null,
				replay: null,
				dependencies: null,
			};

			if (!acquired || late())
				facts = {
					...facts,
					replay: {
						kind: "unavailable",
						reason:
							timedOut || late() || Date.now() >= acquireBy
								? "timeout"
								: "unsupported_tree",
						wallMs: Date.now() - startedAt,
					},
				};
			else {
				if (request.needs.dependencies)
					facts = { ...facts, dependencies: dependencyFacts(gate, candidate) };

				if (request.needs.replay && request.base.kind === "fresh") {
					const { receipt, assessment } = assessBase(
						await runHeldoutBase({
							tree: gate,
							workDir: join(root, "base"),
							cacheDir: join(config.stateDir, "base-dependencies"),
							binding: request.base.binding,
							contract: request.base.contract,
							suite: request.base.suite,
							canary: request.base.canary,
							startedAt: Date.now(),
							deadline,
							scope,
							signal: abort.signal,
							runner: config.runner,
						}),
					);

					keepValidationFile(
						join(root, "refreshed-base.json"),
						JSON.stringify(receipt),
					);
					facts = {
						...facts,
						base: receipt,
						baseRefusal:
							assessment.kind === "refused" ? assessment.failure.reason : null,
					};
				}

				if (request.needs.replay && !sameMaterializer(gate, materializerSource))
					facts = {
						...facts,
						replay: {
							kind: "unavailable",
							reason: "unsupported_materializer",
							wallMs: Date.now() - startedAt,
						},
					};
				else if (request.needs.replay) {
					const materialized = join(root, "materialized");
					let ignoredChanges: readonly string[] | null = null;

					try {
						ignoredChanges = (config.materialize ?? materializeFromDirectories)(
							{
								gateTree: gate,
								candidateTree: candidate,
								dest: materialized,
								replacements: request.replacements,
								heldoutDir: request.heldoutDir,
								heldoutDigest: request.heldoutDigest,
							},
						).ignoredChanges;
					} catch {
						ignoredChanges = null;
					}

					facts = {
						...facts,
						ignoredChanges,
						replay:
							ignoredChanges === null
								? {
										kind: "unavailable",
										reason: "unsupported_tree",
										wallMs: Date.now() - startedAt,
									}
								: await replayHeldoutCandidate({
										gateTree: materialized,
										fullTree: candidate,
										gates: join(gate, ".github/factory/gates"),
										heldoutDir: request.heldoutDir,
										heldoutDigest: request.heldoutDigest,
										workDir: join(root, "replay"),
										cacheDir: join(config.stateDir, "base-dependencies"),
										deadline,
										scope,
										signal: abort.signal,
										runner: config.runner,
									}),
					};
				}
			}

			for (const name of work)
				await rm(join(root, name), { recursive: true, force: true });
			keepValidationFile(
				join(root, "replay.json"),
				`${JSON.stringify(facts)}\n`,
			);
			keepValidationFile(
				join(root, "charge.json"),
				`${JSON.stringify({ wallMs: Date.now() - startedAt, tokens: 0 })}\n`,
			);
			request.finish(facts);
		})().finally(async () => {
			for (const name of work)
				await rm(join(root, name), { recursive: true, force: true }).catch(
					() => undefined,
				);
			jobs.delete(root);
		});

		jobs.set(root, { runId: request.runId, abort, done });
		void done.catch(() => {});

		return "checking";
	};

	return {
		check,
		async stop(runId: Digest) {
			const owned = [...jobs.values()].filter((j) => j.runId === runId);

			for (const job of owned) job.abort.abort();
			await Promise.allSettled(owned.map((j) => j.done));
		},
	};
}
