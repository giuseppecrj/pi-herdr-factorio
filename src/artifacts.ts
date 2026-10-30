import { randomBytes } from "node:crypto";
import {
	lstatSync,
	mkdirSync,
	readFileSync,
	readdirSync,
	openSync,
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
	writeAcceptance,
	type AcceptanceSuite,
} from "./accept.ts";
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
	readonly isolation: typeof ACCEPTANCE_ISOLATION;
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
	}): Promise<AcceptanceRead>;
}

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
		fieldOf(value, "version") !== 1 ||
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
	};

	const paths = textsOf([...rawFiles]) ?? [];
	const evidence = arrayOf(fieldOf(value, "evidence")) ?? [];

	const evidencePaths = evidence.flatMap((v) => {
		const p = textOf(fieldOf(objectOf(v), "path"));

		return p === null ? [] : [p];
	});

	const acceptance = arrayOf(fieldOf(value, "acceptance"));

	if (acceptance === null) return blocked("contract_invalid");

	const parsed = parseSpecifyOutput(
		JSON.stringify({
			...draft,
			acceptance: acceptance.map((v) => fieldOf(objectOf(v), "text")),
		}),
		new Set([...paths, ...evidencePaths]),
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
		version: 1,
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

			if (
				!isDigest(acceptanceDigest) ||
				fieldOf(record, "version") !== 1 ||
				fieldOf(record, "runId") !== runId ||
				fieldOf(record, "contractDigest") !== digest ||
				fieldOf(record, "baseSha") !== contract.base.sha ||
				fieldOf(record, "isolation") !== ACCEPTANCE_ISOLATION ||
				model === null ||
				provider !== model.split("/")[0] ||
				(observed !== null && textOf(observed) === null)
			)
				return { kind: "blocked", reason: "acceptance_invalid" };
			const canary = regularText(join(dir, "canary.txt")).trimEnd();

			const stored = objectOf(
				parseJson(
					regularText(join(dir, "suite.json"), ACCEPTANCE_STORED_MAX_BYTES),
				),
			);

			if (
				!CANARY.test(canary) ||
				stored === null ||
				fieldOf(stored, "canary") !== canary
			)
				return { kind: "blocked", reason: "acceptance_changed" };
			const { canary: _planted, ...body } = stored;
			const parsed = writeAcceptance(JSON.stringify(body), contract);

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
				acceptanceDigestOf(parsed.suite, canary) !== acceptanceDigest
			)
				return { kind: "blocked", reason: "acceptance_changed" };

			return {
				kind: "found",
				suite: parsed.suite,
				receipt: {
					version: 1,
					runId,
					acceptanceDigest,
					contractDigest: digest,
					baseSha: contract.base.sha,
					model,
					provider,
					observed: textOf(observed),
					isolation: ACCEPTANCE_ISOLATION,
				},
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
		async store(input) {
			const { contract, contractDigest, suite, model, observed } = input;
			const previous = await read(contract.runId, contract, contractDigest);

			if (previous.kind !== "absent") return previous;
			const validated = writeAcceptance(JSON.stringify(suite), contract);

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

			const receipt: AcceptanceReceipt = {
				version: 1,
				runId: contract.runId,
				acceptanceDigest: acceptanceDigestOf(validated.suite, canary),
				contractDigest,
				baseSha: contract.base.sha,
				model,
				provider: model.split("/")[0] ?? "",
				observed,
				isolation: ACCEPTANCE_ISOLATION,
			};

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
	review: ["contract"],
} as const;
