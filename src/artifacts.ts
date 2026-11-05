import { randomBytes } from "node:crypto";
import {
	lstatSync,
	mkdirSync,
	readFileSync,
	readdirSync,
	openSync,
	renameSync,
	writeFileSync,
	fsyncSync,
	closeSync,
} from "node:fs";
import { dirname, join, resolve } from "node:path";
import {
	ACCEPTANCE_ISOLATION,
	ACCEPTANCE_MAX_BYTES,
	ACCEPTANCE_STORED_MAX_BYTES,
	CANARY,
	acceptanceDigestOf,
	acceptanceEntries,
	readAcceptanceSuite,
	type AcceptanceSuite,
} from "./accept.ts";
import {
	type FamilyInput,
	familyLabel,
	parseFamily,
	withFamily,
} from "./review.ts";
import { type Digest, isDigest } from "./run.ts";
import {
	type Contract,
	type ContractDigest,
	contractBytes,
	contractDigestOf,
	parseSpecifyOutput,
	isAnswersDigest,
	isQuestionsDigest,
	type Link,
} from "./specify.ts";
import { isGitSha, isRepoSlug, type GitSha } from "./workflow.ts";
import {
	arrayOf,
	countOf,
	fieldOf,
	objectOf,
	parseJson,
	textOf,
	textsOf,
} from "../server/sandbox/json.ts";

export type ContractRead =
	| {
			readonly kind: "found";
			readonly contract: Contract;
			readonly digest: ContractDigest;
	  }
	| {
			readonly kind: "blocked";
			readonly reason:
				| "contract_missing"
				| "contract_changed"
				| "contract_invalid";
	  };

export type AcceptanceReceipt = {
	readonly version: 1;
	readonly runId: Digest;
	readonly acceptanceDigest: Digest;
	readonly contractDigest: ContractDigest;
	readonly baseSha: GitSha;
	readonly model: string;
	readonly provider: string;
	readonly observed: string | null;
	/**
	 * `ACCEPTANCE_ISOLATION` on a receipt without `family`, written before
	 * F10c. With `family`, exactly `familyLabel(family)`, which names the
	 * author's family and defers the cross-family claim to certification.
	 */
	readonly isolation: string;
	/** The accept author's family evidence from the answering session's journal. */
	readonly family?: FamilyInput;
};

export type AcceptanceRead =
	| { readonly kind: "absent" }
	| {
			readonly kind: "found";
			readonly suite: AcceptanceSuite;
			readonly receipt: AcceptanceReceipt;
	  }
	| {
			readonly kind: "blocked";
			readonly reason:
				| "acceptance_missing"
				| "acceptance_changed"
				| "acceptance_invalid";
	  };

export interface ArtifactStore {
	read(
		runId: Digest,
		contract: Contract,
		digest: ContractDigest,
	): Promise<AcceptanceRead>;
	store(input: {
		readonly contract: Contract;
		readonly contractDigest: ContractDigest;
		readonly suite: AcceptanceSuite;
		readonly model: string;
		readonly observed: string | null;
		/** Absent writes the legacy receipt shape, with no family evidence. */
		readonly family?: FamilyInput;
	}): Promise<AcceptanceRead>;
	/**
	 * Retires the run's stored suite once, for the one accept feedback retry.
	 * An exclusive marker names the retired digest; the suite and its guard
	 * then move to `acceptance/<runId>.retired/`, kept as private evidence and
	 * never overwritten. The same digest again finishes or repeats the move;
	 * any other digest is `refused`, so a run retires at most one suite.
	 */
	retire(
		runId: Digest,
		contract: Contract,
		digest: ContractDigest,
		acceptanceDigest: Digest,
	): Promise<RetireResult>;
}

export type RetireResult = "retired" | "refused" | "failed";

export function checkPrivateDir(path: string): void {
	const stat = lstatSync(path);

	if (!stat.isDirectory() || (stat.mode & 0o077) !== 0)
		throw new Error("unsafe private directory");
}

export function privateDir(path: string): void {
	mkdirSync(path, { recursive: true, mode: 0o700 });
	checkPrivateDir(path);
}

function missing(error: NodeJS.ErrnoException): boolean {
	return error.code === "ENOENT";
}

export function present(path: string): boolean {
	try {
		lstatSync(path);

		return true;
	} catch (error) {
		if (error instanceof Error && missing(error)) return false;
		throw error;
	}
}

function regenerationGuard(root: string, runId: Digest): string {
	return join(root, `${runId}.json`);
}

function retirementMarker(root: string, runId: Digest): string {
	return join(root, `${runId}.retired.json`);
}

/** The retired digest the run's marker names, or `null` with no marker. */
function retiredDigest(root: string, runId: Digest): string | null {
	const path = retirementMarker(root, runId);

	if (!present(path)) return null;
	const marker = objectOf(parseJson(regularText(path)));
	const retired = textOf(fieldOf(marker, "acceptanceDigest"));

	if (fieldOf(marker, "runId") !== runId || retired === null)
		throw new Error("invalid retirement marker");

	return retired;
}

function syncDir(path: string): void {
	const dir = openSync(path, "r");

	try {
		fsyncSync(dir);
	} finally {
		closeSync(dir);
	}
}

function acceptanceEntryCap(path: string): number {
	return path === "suite.json"
		? ACCEPTANCE_STORED_MAX_BYTES
		: ACCEPTANCE_MAX_BYTES;
}

export function regularBytes(path: string, cap: number): Buffer {
	const stat = lstatSync(path);

	if (!stat.isFile() || stat.size > cap || (stat.mode & 0o077) !== 0)
		throw new Error("unsafe private file");

	return readFileSync(path);
}

export function regularText(path: string, cap = ACCEPTANCE_MAX_BYTES): string {
	return regularBytes(path, cap).toString("utf8");
}

export function exclusive(path: string, text: string | Uint8Array): void {
	privateDir(dirname(path));
	const fd = openSync(path, "wx", 0o600);

	try {
		writeFileSync(fd, text);
		fsyncSync(fd);
	} finally {
		closeSync(fd);
	}

	const dir = openSync(dirname(path), "r");

	try {
		fsyncSync(dir);
	} finally {
		closeSync(dir);
	}
}

export function parseStoredContract(
	bytes: string,
	receiptText: string,
	runId: Digest,
): ContractRead {
	const blocked = (
		reason: Extract<ContractRead, { kind: "blocked" }>["reason"],
	): ContractRead => ({ kind: "blocked", reason });

	const receipt = objectOf(parseJson(receiptText));
	const digest = contractDigestOf(bytes);

	if (
		fieldOf(receipt, "contractDigest") !== digest ||
		fieldOf(receipt, "runId") !== runId
	)
		return blocked("contract_changed");
	const value = objectOf(parseJson(bytes));
	const base = objectOf(fieldOf(value, "base"));
	const snapshot = objectOf(fieldOf(value, "snapshot"));
	const repo = textOf(fieldOf(base, "repo")) ?? "";
	const sha = textOf(fieldOf(base, "sha")) ?? "";
	const snapshotDigest = textOf(fieldOf(snapshot, "digest")) ?? "";
	const source = fieldOf(snapshot, "source");
	const eventId = textOf(fieldOf(snapshot, "eventId"));
	const eventAt = textOf(fieldOf(snapshot, "eventAt"));
	const issue = countOf(fieldOf(value, "issue"));
	const rawFiles = arrayOf(fieldOf(value, "files"));

	if (
		value === null ||
		rawFiles === null ||
		!isRepoSlug(repo) ||
		!isGitSha(sha) ||
		!isDigest(snapshotDigest) ||
		(source !== "unedited" && source !== "edit_history") ||
		eventId === null ||
		eventAt === null ||
		issue === null ||
		issue < 1 ||
		fieldOf(value, "version") !== 2 ||
		fieldOf(value, "runId") !== runId ||
		fieldOf(receipt, "baseSha") !== sha ||
		fieldOf(receipt, "bytes") !== Buffer.byteLength(bytes) ||
		fieldOf(receipt, "snapshotDigest") !== snapshotDigest
	)
		return blocked("contract_invalid");

	const draft = {
		kind: "contract",
		summary: fieldOf(value, "summary"),
		behavior: fieldOf(value, "behavior"),
		exclusions: fieldOf(value, "exclusions"),
		compatibility: fieldOf(value, "compatibility"),
		limits: fieldOf(value, "limits"),
		files: fieldOf(value, "files"),
		evidence: fieldOf(value, "evidence"),
		replacesTests: fieldOf(value, "replacesTests"),
	};

	const paths = textsOf([...rawFiles]) ?? [];
	const evidence = arrayOf(fieldOf(value, "evidence")) ?? [];

	const evidencePaths = evidence.flatMap((v) => {
		const p = textOf(fieldOf(objectOf(v), "path"));

		return p === null ? [] : [p];
	});

	const replacementPaths = (
		arrayOf(fieldOf(value, "replacesTests")) ?? []
	).flatMap((item) => {
		const path = textOf(fieldOf(objectOf(item), "path"));

		return path === null ? [] : [path];
	});

	const acceptance = arrayOf(fieldOf(value, "acceptance"));

	if (acceptance === null) return blocked("contract_invalid");

	const parsed = parseSpecifyOutput(
		JSON.stringify({
			...draft,
			acceptance: acceptance.map((v) => ({
				kind: fieldOf(objectOf(v), "kind"),
				text: fieldOf(objectOf(v), "text"),
			})),
		}),
		new Set([...paths, ...evidencePaths, ...replacementPaths]),
	);

	if (
		parsed.kind !== "contract" ||
		JSON.stringify(parsed.draft.acceptance) !== JSON.stringify(acceptance)
	)
		return blocked("contract_invalid");
	const rawLink = fieldOf(value, "link");
	let link: Link | null = null;

	if (rawLink !== null) {
		const object = objectOf(rawLink);
		const prevRunId = textOf(fieldOf(object, "prevRunId")) ?? "";
		const answersDigest = textOf(fieldOf(object, "answersDigest")) ?? "";
		const q = fieldOf(object, "questionsDigest");
		const questionsDigest = textOf(q) ?? "";

		if (
			!isDigest(prevRunId) ||
			!isAnswersDigest(answersDigest) ||
			(q !== null && !isQuestionsDigest(questionsDigest))
		)
			return blocked("contract_invalid");
		link = {
			prevRunId,
			questionsDigest:
				q === null
					? null
					: isQuestionsDigest(questionsDigest)
						? questionsDigest
						: null,
			answersDigest,
		};
	}

	const contract: Contract = {
		version: 2,
		runId,
		issue,
		base: { repo, sha },
		snapshot: { digest: snapshotDigest, source, eventId, eventAt },
		link,
		...parsed.draft,
	};

	if (contractBytes(contract) !== bytes) return blocked("contract_invalid");

	return { kind: "found", contract, digest };
}

export function readStoredContract(
	stateDir: string,
	runId: Digest,
): ContractRead {
	const root = join(stateDir, "contracts", runId);

	try {
		checkPrivateDir(join(stateDir, "contracts"));
		checkPrivateDir(root);

		return parseStoredContract(
			regularText(join(root, "contract.json")),
			regularText(join(root, "receipt.json")),
			runId,
		);
	} catch (error) {
		return {
			kind: "blocked",
			reason:
				error instanceof Error && missing(error)
					? "contract_missing"
					: "contract_invalid",
		};
	}
}

export function fileArtifacts(stateDir: string): ArtifactStore {
	const root = join(resolve(stateDir), "acceptance");

	const read: ArtifactStore["read"] = async (runId, contract, digest) => {
		const dir = join(root, runId);

		try {
			if (present(root)) checkPrivateDir(root);

			if (!present(dir)) {
				const guard = regenerationGuard(root, runId);

				if (!present(guard)) return { kind: "absent" };
				regularText(guard);

				return { kind: "blocked", reason: "acceptance_missing" };
			}

			checkPrivateDir(dir);
			const receiptText = regularText(join(dir, "receipt.json"));

			if (regularText(regenerationGuard(root, runId)) !== receiptText)
				return { kind: "blocked", reason: "acceptance_changed" };
			const record = objectOf(parseJson(receiptText));

			const acceptanceDigest =
				textOf(fieldOf(record, "acceptanceDigest")) ?? "";

			const model = textOf(fieldOf(record, "model"));
			const provider = textOf(fieldOf(record, "provider"));
			const observed = fieldOf(record, "observed");
			const stored = fieldOf(record, "family");
			const family = stored === undefined ? null : parseFamily(stored);

			const isolation =
				family === null ? ACCEPTANCE_ISOLATION : familyLabel(family);

			if (
				!isDigest(acceptanceDigest) ||
				fieldOf(record, "version") !== 1 ||
				fieldOf(record, "runId") !== runId ||
				fieldOf(record, "contractDigest") !== digest ||
				fieldOf(record, "baseSha") !== contract.base.sha ||
				(stored !== undefined && family === null) ||
				fieldOf(record, "isolation") !== isolation ||
				model === null ||
				provider !== model.split("/")[0] ||
				(observed !== null && textOf(observed) === null)
			)
				return { kind: "blocked", reason: "acceptance_invalid" };
			const canary = regularText(join(dir, "canary.txt")).trimEnd();

			const kept = objectOf(
				parseJson(
					regularText(join(dir, "suite.json"), ACCEPTANCE_STORED_MAX_BYTES),
				),
			);

			if (
				!CANARY.test(canary) ||
				kept === null ||
				fieldOf(kept, "canary") !== canary
			)
				return { kind: "blocked", reason: "acceptance_changed" };
			const { canary: _planted, ...body } = kept;
			const parsed = readAcceptanceSuite(body, contract);

			if (parsed.kind !== "suite")
				return { kind: "blocked", reason: "acceptance_changed" };
			const entries = acceptanceEntries(parsed.suite, canary);

			for (const [path, bytes] of entries) {
				if (regularText(join(dir, path), acceptanceEntryCap(path)) !== bytes)
					return { kind: "blocked", reason: "acceptance_changed" };
			}

			const expected = new Set([
				"receipt.json",
				"suite.json",
				...entries.map(([path]) => path),
			]);

			const walk = (base: string): boolean => {
				checkPrivateDir(join(dir, base));

				return readdirSync(join(dir, base), { withFileTypes: true }).every(
					(entry) => {
						const path = base === "" ? entry.name : `${base}/${entry.name}`;

						return entry.isDirectory()
							? [...expected].some((p) => p.startsWith(`${path}/`)) &&
									walk(path)
							: entry.isFile() && expected.has(path);
					},
				);
			};

			if (
				!walk("") ||
				acceptanceDigestOf(parsed.suite, canary) !== acceptanceDigest ||
				// A retirement interrupted before its move never serves the old suite.
				retiredDigest(root, runId) === acceptanceDigest
			)
				return { kind: "blocked", reason: "acceptance_changed" };

			return {
				kind: "found",
				suite: parsed.suite,
				receipt: withFamily(
					{
						version: 1,
						runId,
						acceptanceDigest,
						contractDigest: digest,
						baseSha: contract.base.sha,
						model,
						provider,
						observed: textOf(observed),
						isolation,
					},
					family,
				),
			};
		} catch (error) {
			return {
				kind: "blocked",
				reason:
					error instanceof Error && missing(error)
						? "acceptance_missing"
						: "acceptance_invalid",
			};
		}
	};

	return {
		read,
		async retire(runId, contract, digest, acceptanceDigest) {
			const marker = retirementMarker(root, runId);
			const aside = join(root, `${runId}.retired`);
			const text = `${JSON.stringify({ version: 1, runId, contractDigest: digest, acceptanceDigest })}\n`;

			const movable = (path: string) =>
				fieldOf(objectOf(parseJson(regularText(path))), "acceptanceDigest") ===
				acceptanceDigest;

			try {
				if (contract.runId !== runId) return "refused";

				if (present(marker)) {
					if (regularText(marker) !== text) return "refused";
				} else {
					const current = await read(runId, contract, digest);

					if (
						current.kind !== "found" ||
						current.receipt.acceptanceDigest !== acceptanceDigest
					)
						return "refused";
					exclusive(marker, text);
				}

				if (!present(aside)) {
					mkdirSync(aside, { mode: 0o700 });
					syncDir(root);
				}

				checkPrivateDir(aside);
				const suite = join(aside, "suite");
				const guard = join(aside, "guard.json");

				// Each step is skipped once done, so a restart finishes the move
				// and a suite stored after it is never touched.
				if (!present(suite)) {
					const dir = join(root, runId);

					if (!movable(join(dir, "receipt.json"))) return "refused";
					renameSync(dir, suite);
					syncDir(aside);
					syncDir(root);
				}

				if (!present(guard)) {
					const current = regenerationGuard(root, runId);

					if (!movable(current)) return "refused";
					renameSync(current, guard);
					syncDir(aside);
					syncDir(root);
				}

				return "retired";
			} catch {
				return "failed";
			}
		},
		async store(input) {
			const { contract, contractDigest, suite, model, observed, family } =
				input;

			const previous = await read(contract.runId, contract, contractDigest);

			if (previous.kind !== "absent") return previous;

			const validated = readAcceptanceSuite(
				objectOf(parseJson(JSON.stringify(suite))) ?? {},
				contract,
			);

			if (validated.kind !== "suite")
				return { kind: "blocked", reason: "acceptance_invalid" };
			const dir = join(root, contract.runId);
			const canary = `factory-holdout-${randomBytes(32).toString("hex")}`;
			const entries = acceptanceEntries(validated.suite, canary);

			if (
				entries.some(
					([path, bytes]) =>
						Buffer.byteLength(bytes) > acceptanceEntryCap(path),
				)
			)
				return { kind: "blocked", reason: "acceptance_invalid" };

			const receipt: AcceptanceReceipt = withFamily(
				{
					version: 1,
					runId: contract.runId,
					acceptanceDigest: acceptanceDigestOf(validated.suite, canary),
					contractDigest,
					baseSha: contract.base.sha,
					model,
					provider: model.split("/")[0] ?? "",
					observed,
					isolation:
						family === undefined ? ACCEPTANCE_ISOLATION : familyLabel(family),
				},
				family,
			);

			try {
				privateDir(root);
				const receiptText = `${JSON.stringify(receipt, null, "\t")}\n`;
				exclusive(regenerationGuard(root, contract.runId), receiptText);
				mkdirSync(dir, { mode: 0o700 });
				exclusive(join(dir, "receipt.json"), receiptText);

				for (const [path, bytes] of entries) exclusive(join(dir, path), bytes);
			} catch (error) {
				return {
					kind: "blocked",
					reason:
						error instanceof Error && missing(error)
							? "acceptance_missing"
							: "acceptance_invalid",
				};
			}

			return read(contract.runId, contract, contractDigest);
		},
	};
}

export const ARTIFACT_ACCESS = {
	specify: [],
	accept: ["contract", "trusted-base"],
	build: ["contract", "scenario-ids"],
	validate: ["contract", "acceptance"],
	review: ["contract", "judge-lines"],
} as const;
