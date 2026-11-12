import {
	fileArtifacts,
	readStoredContract,
	privateDir,
} from "../../src/contract/artifacts.ts";
import type { PlatformProfile } from "../../src/trust/platform.ts";
import {
	migrateCertificationValue,
	migrateEvidenceValue,
} from "../../src/candidate/codec.ts";
import { candidateGenerations } from "../../src/candidate/handoff.ts";
import { validationDir } from "../../src/candidate/validation.ts";
import { digestOf, type Digest, isDigest } from "../../src/core/run.ts";
import { contextPolicy, AUTONOMY_DIGEST } from "../../src/ledger/schema.ts";
import type { GitSha } from "../../src/config/schema.ts";
import { parseWorkflow } from "../../src/config/parse.ts";
import { baseTreeDigest } from "../gates.ts";
import { lstat, mkdir, mkdtemp, readdir, readFile, rm } from "node:fs/promises";
import { join, resolve } from "node:path";
import type {
	ClaimRecord,
	LinkRead,
	RunFiles,
} from "../../src/orchestrator.ts";
import {
	type Answer,
	type AnswersRecord,
	type ClarificationRound,
	answersDigestOf,
	isAnswersDigest,
	isQuestionsDigest,
} from "../../src/contract/contract.ts";
import type { JsonValue } from "../../src/core/json.ts";
import {
	parseJson,
	fieldOf,
	textList,
	parseClaim,
	writeAtomic,
	writeOnce,
	fileRunAccounting,
	readVerificationContext,
	errorCode,
} from "./state.ts";
import { type TarballFetch, ghTarball, checkoutWorkspace } from "./checkout.ts";
import { fileLedgerOutbox } from "./outbox.ts";
import { readTerminalEvidence } from "./terminal.ts";

function parseAnswer(value: JsonValue): Answer | null {
	const commentId = textList(fieldOf(value, "commentId"));
	const author = textList(fieldOf(value, "author"));
	const createdAt = textList(fieldOf(value, "createdAt"));
	const body = textList(fieldOf(value, "body"));

	return commentId === null ||
		author === null ||
		createdAt === null ||
		body === null
		? null
		: { commentId, author, createdAt, body };
}

function parseRounds(
	value: JsonValue | undefined,
): readonly ClarificationRound[] | null | undefined {
	if (value === undefined) return undefined;

	if (!Array.isArray(value)) return null;

	const rounds: ClarificationRound[] = [];

	for (const item of value) {
		const questions = textList(fieldOf(item, "questions"));
		const items = fieldOf(item, "answers");

		if (questions === null || !Array.isArray(items)) return null;

		const answers: Answer[] = [];

		for (const value of items) {
			const answer = parseAnswer(value);

			if (answer === null) return null;

			answers.push(answer);
		}

		rounds.push({ questions, answers });
	}

	return rounds;
}

export function parseAnswers(
	text: string,
	runId: Digest,
): AnswersRecord | null {
	const value = parseJson(text);
	const prevRunId = textList(fieldOf(value, "prevRunId"));
	const questions = textList(fieldOf(value, "questions"));
	const commentId = fieldOf(value, "questionsCommentId");
	const questionsCommentId = commentId === null ? null : textList(commentId);
	const items = fieldOf(value, "answers");
	const digest = textList(fieldOf(value, "digest"));
	const rounds = parseRounds(fieldOf(value, "rounds"));

	if (
		rounds === null ||
		fieldOf(value, "version") !== 1 ||
		fieldOf(value, "runId") !== runId ||
		prevRunId === null ||
		!isDigest(prevRunId) ||
		questions === null ||
		(commentId !== null && questionsCommentId === null) ||
		!Array.isArray(items) ||
		digest === null ||
		!isAnswersDigest(digest)
	) {
		return null;
	}

	const answers: Answer[] = [];

	for (const item of items) {
		const answer = parseAnswer(item);

		if (answer === null) return null;

		answers.push(answer);
	}

	if (answersDigestOf({ prevRunId, questions, answers, rounds }) !== digest)
		return null;

	const record: AnswersRecord = {
		version: 1,
		runId,
		prevRunId,
		questionsCommentId,
		questions,
		answers,
		digest,
	};

	return rounds === undefined ? record : { ...record, rounds };
}

function parseLink(text: string): LinkRead {
	const value = parseJson(text);

	if (
		fieldOf(value, "version") === 1 &&
		fieldOf(value, "prevRunId") === null &&
		fieldOf(value, "questionsDigest") === undefined &&
		fieldOf(value, "answersDigest") === undefined
	) {
		return { kind: "unlinked" };
	}

	const prevRunId = textList(fieldOf(value, "prevRunId"));
	const questions = fieldOf(value, "questionsDigest");
	const questionsDigest = questions === null ? null : textList(questions);
	const answersDigest = textList(fieldOf(value, "answersDigest"));

	if (
		fieldOf(value, "version") !== 1 ||
		prevRunId === null ||
		!isDigest(prevRunId) ||
		(questions !== null &&
			(questionsDigest === null || !isQuestionsDigest(questionsDigest))) ||
		answersDigest === null ||
		!isAnswersDigest(answersDigest)
	) {
		return { kind: "unreadable" };
	}

	return {
		kind: "found",
		link: {
			prevRunId,
			questionsDigest:
				questionsDigest !== null && isQuestionsDigest(questionsDigest)
					? questionsDigest
					: null,
			answersDigest,
		},
	};
}

export function fileRunFiles(
	stateDir: string,
	policySource?: {
		readonly fetch?: TarballFetch;
		readonly platform: PlatformProfile;
	},
): RunFiles {
	const root = resolve(stateDir);
	const claims = join(root, "claims");
	const workspaces = join(root, "workspaces");
	const contracts = join(root, "contracts");
	const links = join(root, "links");
	const answers = join(root, "answers");

	const policyPins = new Map<
		GitSha,
		{ workflowDigest: Digest; gatesDigest: Digest; runTokenCap: number }
	>();

	const workspacePath = (runId: string) => join(workspaces, runId);

	const ensure = async (dir: string) => {
		try {
			await mkdir(dir, { recursive: true, mode: 0o700 });

			return true;
		} catch {
			return false;
		}
	};

	return {
		workspacePath,
		artifacts: fileArtifacts(root),
		ledger: fileLedgerOutbox(root),
		accounting: fileRunAccounting(root),
		terminalEvidence: (runId, floor, candidate) =>
			readTerminalEvidence(root, runId, floor, candidate),
		prepareRun:
			policySource === undefined
				? undefined
				: async (input) => {
						const accounting = fileRunAccounting(root);
						const existing = await accounting.start(input.runId);
						const manifest = await readVerificationContext(root);

						if (
							existing === undefined ||
							manifest.kind === "refused" ||
							(manifest.kind === "pinned" && manifest.repo !== input.repo)
						)
							return false;

						const verification = manifest.kind === "pinned" ? manifest : null;

						if (existing !== null) {
							const pinned = contextPolicy(existing.context);
							const context = existing.context;

							const manifestDigest =
								context.kind === "verification"
									? context.manifestDigest
									: context.kind === "legacy"
										? (context.known.verification?.manifestDigest ?? null)
										: null;

							return (
								pinned?.workflowSha === input.workflowSha &&
								pinned.workflowDigest === input.workflowDigest &&
								pinned.gates.kind === "known" &&
								manifestDigest === (verification?.digest ?? null)
							);
						}

						const begin = (gatesDigest: Digest, runTokenCap: number) => {
							const policy = {
								workflowSha: input.workflowSha,
								workflowDigest: input.workflowDigest,
								gates: {
									kind: "known",
									value: {
										sourceSha: input.workflowSha,
										digest: gatesDigest,
									},
								},
								autonomy: {
									approveMerge: "always",
									land: "propose",
									digest: AUTONOMY_DIGEST,
								},
							} as const;

							const context =
								verification === null
									? ({
											kind: "production",
											policy,
											trustedCap: runTokenCap,
										} as const)
									: ({
											kind: "verification",
											policy,
											trustedCap: runTokenCap,
											manifestDigest: verification.digest,
											effectiveCap: Math.min(
												runTokenCap,
												verification.tokenCap,
											),
										} as const);

							return accounting.begin({
								v: 2,
								runId: input.runId,
								startedAt: input.startedAt,
								context,
							});
						};

						const cached = policyPins.get(input.workflowSha);

						if (cached !== undefined)
							return (
								cached.workflowDigest === input.workflowDigest &&
								(await begin(cached.gatesDigest, cached.runTokenCap))
							);
						let scratch: string | null = null;

						try {
							privateDir(root);
							scratch = await mkdtemp(join(root, "policy-"));
							const workspace = join(scratch, "source");
							await mkdir(workspace, { mode: 0o700 });

							const checked = await checkoutWorkspace({
								stateDir: scratch,
								workspace,
								runId: input.runId,
								repo: input.repo,
								sha: input.workflowSha,
								fetch: policySource.fetch ?? ghTarball,
							});

							if (checked.kind !== "ready" || checked.omitted !== 0)
								return false;

							const workflow = await readFile(
								join(workspace, ".github/factory/WORKFLOW.md"),
							);

							if (digestOf(workflow) !== input.workflowDigest) return false;

							const parsed = parseWorkflow({
								text: workflow.toString("utf8"),
								repo: input.repo,
								env: (name) => process.env[name],
								platform: policySource.platform,
							});

							if (parsed.kind !== "valid") return false;

							const runTokenCap = parsed.config.usage.maxTokensPerRun;

							const gatesDigest = baseTreeDigest(
								join(workspace, ".github/factory/gates"),
							);

							policyPins.set(input.workflowSha, {
								workflowDigest: input.workflowDigest,
								gatesDigest,
								runTokenCap,
							});

							return begin(gatesDigest, runTokenCap);
						} catch {
							return false;
						} finally {
							if (scratch !== null)
								await rm(scratch, { recursive: true, force: true });
						}
					},
		async readContract(runId) {
			return readStoredContract(root, runId);
		},

		async writeContract({ contract, bytes, digest }) {
			const dir = join(contracts, contract.runId);

			const receipt = {
				version: 1,
				runId: contract.runId,
				contractDigest: digest,
				bytes: Buffer.byteLength(bytes, "utf8"),
				baseSha: contract.base.sha,
				snapshotDigest: contract.snapshot.digest,
				answersDigest: contract.link?.answersDigest ?? null,
			};

			return (
				(await ensure(contracts)) &&
				(await writeOnce(join(dir, "contract.json"), bytes)) &&
				(await writeOnce(
					join(dir, "receipt.json"),
					`${JSON.stringify(receipt, null, "\t")}\n`,
				))
			);
		},

		async writeQuestions({ runId, questions, digest }) {
			return (
				(await ensure(contracts)) &&
				(await writeOnce(
					join(contracts, runId, "questions.json"),
					`${JSON.stringify({ version: 1, runId, digest, questions }, null, "\t")}\n`,
				))
			);
		},

		async writeLink(runId, link) {
			return (
				(await ensure(links)) &&
				(await writeAtomic(
					join(links, `${runId}.json`),
					`${JSON.stringify(link === null ? { version: 1, prevRunId: null } : { version: 1, ...link })}\n`,
				))
			);
		},

		async readLink(runId) {
			try {
				return parseLink(await readFile(join(links, `${runId}.json`), "utf8"));
			} catch (error) {
				return (error instanceof Error ? errorCode(error) : null) === "ENOENT"
					? { kind: "none" }
					: { kind: "unreadable" };
			}
		},

		async writeAnswers(record) {
			return (
				(await ensure(answers)) &&
				(await writeAtomic(
					join(answers, `${record.runId}.json`),
					`${JSON.stringify(record, null, "\t")}\n`,
				))
			);
		},

		async readAnswers(runId) {
			const text = await readFile(join(answers, `${runId}.json`), "utf8").catch(
				() => null,
			);

			return text === null ? null : parseAnswers(text, runId);
		},

		async workspaceState(runId) {
			try {
				const info = await lstat(workspacePath(runId));

				return info.isDirectory() ? "present" : "unavailable";
			} catch (error) {
				return (error instanceof Error ? errorCode(error) : null) === "ENOENT"
					? "missing"
					: "unavailable";
			}
		},

		async ensureWorkspace(runId) {
			try {
				await mkdir(workspaces, { recursive: true, mode: 0o700 });
				await mkdir(workspacePath(runId), { mode: 0o700 });

				return "created";
			} catch (error) {
				if ((error instanceof Error ? errorCode(error) : null) !== "EEXIST")
					return "unavailable";
			}

			const info = await lstat(workspacePath(runId)).catch(() => null);

			return info?.isDirectory() === true ? "present" : "unavailable";
		},

		async listClaims() {
			let names: string[];

			try {
				names = await readdir(claims);
			} catch {
				return [];
			}

			const records: ClaimRecord[] = [];

			for (const name of names.filter((entry) => entry.endsWith(".json"))) {
				const text = await readFile(join(claims, name), "utf8").catch(() => "");

				const claim = parseClaim(text);

				if (claim !== null && `${claim.runId}.json` === name) {
					records.push(claim);
				}
			}

			return records;
		},

		async writeClaim(claim) {
			try {
				const book = claim.handoff;

				if (book?.kind === "selected") {
					for (const evidence of candidateGenerations(book)) {
						const dir = validationDir(
							root,
							claim.runId,
							evidence.intent.round,
							evidence.intent.generation,
						);

						privateDir(dir);

						if (
							!(await writeOnce(
								join(dir, "generation.json"),
								`${JSON.stringify(evidence.intent)}\n`,
							))
						)
							return false;

						if (
							book.history.some(
								(entry) => entry.intent.digest === evidence.intent.digest,
							) &&
							!(await writeOnce(
								join(dir, "archive.json"),
								`${JSON.stringify(evidence)}\n`,
								migrateEvidenceValue,
							))
						)
							return false;

						if (
							evidence.certification !== null &&
							!(await writeOnce(
								join(dir, "certification.json"),
								`${JSON.stringify(evidence.certification)}\n`,
								migrateCertificationValue,
							))
						)
							return false;
					}

					for (const account of book.accounts) {
						const e = account.execution;

						const dir = join(
							root,
							"stages",
							claim.runId,
							`${e.stage}-r${e.round}-${e.attempt}`,
						);

						privateDir(dir);

						if (
							!(await writeOnce(
								join(dir, "execution.json"),
								`${JSON.stringify(e)}\n`,
							))
						)
							return false;
					}
				}

				await mkdir(claims, { recursive: true, mode: 0o700 });
			} catch {
				return false;
			}

			return writeAtomic(
				join(claims, `${claim.runId}.json`),
				`${JSON.stringify(claim)}\n`,
			);
		},
	};
}
