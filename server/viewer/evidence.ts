import { constants } from "node:fs";
import { lstat, open, readdir, realpath } from "node:fs/promises";
import { join, relative, sep } from "node:path";
import { readStoredVerdict } from "../controller.ts";
import {
	readAssessmentBytes,
	validationDir,
	type ValidationAssessment,
} from "../../src/validation.ts";
import { diagnosisDetail } from "../../src/diagnosis.ts";
import { viewerClaim } from "./claim.ts";
import { readStageReceipt } from "../sandbox.ts";
import {
	arrayOf,
	countOf,
	fieldOf,
	objectOf,
	parseJson,
	textOf,
	type JsonObject,
	type JsonValue,
} from "../sandbox/json.ts";
import { childUsageOf } from "../sandbox/settle.ts";
import { isDigest, runIdOf } from "../../src/run.ts";
import { isRepoSlug, isGitSha } from "../../src/workflow.ts";
import { isLogin } from "../../src/adapters/github.ts";
import { parseMarker } from "../../src/markers.ts";
import {
	candidateGenerations,
	candidateProjection,
	candidateUsage,
	migrateCertificationValue,
	migrateEvidenceValue,
	parseReviewReceipt,
	type GenerationEvidence,
	type GenerationIntent,
	type Certification,
	type CandidateExecution,
} from "../../src/handoff.ts";
import { reviewDir, type ReviewReceipt } from "../../src/review.ts";
import { blocksReview, type Verdict } from "../../src/run.ts";

export type Gap = { source: string; reason: string };

export type TimelineEvent = {
	source: string;
	at: string | null;
	stage: string;
	attempt: number | null;
	round: number | null;
	generation: number | null;
	event: string;
	detail: string;
};

export type SessionView = {
	id: string;
	source: string;
	parent: string | null;
	stage: string;
	attempt: number | null;
	round: number | null;
	generation: number | null;
	tokens: number;
	byModel: Record<string, number>;
	timeline: TimelineEvent[];
};

export type UsageRow = {
	model: string;
	parent: number;
	children: number;
	total: number;
	cost: "unavailable";
};

export type GatewayDecision = {
	source: string;
	at: string;
	stage: string;
	attempt: number | null;
	round: number | null;
	generation: number | null;
	decision: string;
	destination: string;
	method: string;
	path: string;
	reason: string | null;
};

export type ViewerRun = {
	runId: string;
	complete: boolean;
	status: string;
	issue: JsonValue | null;
	gaps: Gap[];
	timeline: TimelineEvent[];
	usage: {
		total: number;
		accounted: number | null;
		parent: number;
		children: number;
		models: UsageRow[];
		sessions: SessionView[];
		cost: "unavailable";
	};
	children: SessionView[];
	gateway: GatewayDecision[];
};

const FILE_CAP = 8 * 1024 * 1024;
const RUN_CAP = 48 * 1024 * 1024;

export class Evidence {
	readonly gaps: Gap[] = [];
	bytes = 0;
	entries = 0;
	readonly root: string;
	constructor(root: string) {
		this.root = root;
	}
	gap(path: string, reason: string) {
		this.gaps.push({ source: relative(this.root, path) || ".", reason });
	}
	async safe(path: string): Promise<boolean> {
		const rel = relative(this.root, path);

		if (rel === ".." || rel.startsWith(`..${sep}`)) return false;
		let current = this.root;

		for (const part of rel.split(sep).filter(Boolean)) {
			current = join(current, part);

			if ((await lstat(current)).isSymbolicLink()) return false;
		}

		return true;
	}
	async text(
		path: string,
		cap = FILE_CAP,
		privateSource = false,
	): Promise<string | null> {
		try {
			if (!(await this.safe(path))) throw new Error("unsafe source");

			const handle = await open(
				path,
				constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
			);

			try {
				const info = await handle.stat();

				if (
					!info.isFile() ||
					(privateSource &&
						(info.uid !== process.geteuid?.() || (info.mode & 0o077) !== 0)) ||
					info.size > cap ||
					this.bytes + info.size > RUN_CAP
				)
					throw new Error("source limit");
				this.bytes += info.size;

				return await handle.readFile("utf8");
			} finally {
				await handle.close();
			}
		} catch {
			this.gap(path, "missing, unsafe, unreadable or over size limit");

			return null;
		}
	}
	async json(path: string): Promise<JsonObject | null> {
		const text = await this.text(path);

		if (text === null) return null;
		const parsed = objectOf(parseJson(text));

		if (parsed === null) this.gap(path, "corrupt JSON object");

		return parsed;
	}
	async files(dir: string): Promise<string[]> {
		const result: string[] = [];

		try {
			if (!(await this.safe(dir))) throw new Error("unsafe source");

			for (const entry of await readdir(dir, { withFileTypes: true })) {
				const path = join(dir, entry.name);
				this.entries += 1;

				if (this.entries > 10000) {
					this.gap(dir, "entry limit");
					break;
				}

				if (entry.isSymbolicLink()) this.gap(path, "symlink refused");
				else if (entry.isDirectory()) result.push(...(await this.files(path)));
				else if (entry.isFile()) result.push(path);
			}
		} catch {
			this.gap(dir, "missing or unreadable directory");
		}

		return result.sort();
	}
	async lines(path: string): Promise<JsonObject[]> {
		const text = await this.text(path);
		const result: JsonObject[] = [];

		if (text === null) return result;

		for (const [index, line] of text.split("\n").entries()) {
			if (!line.trim()) continue;
			const record = objectOf(parseJson(line));

			if (record === null) this.gap(path, `corrupt JSONL line ${index + 1}`);
			else result.push(record);
		}

		return result;
	}
}

function field(record: JsonObject | null, key: string) {
	return textOf(fieldOf(record, key));
}

function atOf(record: JsonObject | null) {
	const at = field(record, "timestamp") ?? field(record, "ts");

	return at !== null && Number.isFinite(Date.parse(at)) ? at : null;
}

function assessmentDetail(assessment: ValidationAssessment): string {
	if (assessment.kind === "passed") return "passed.";
	const failure = assessment.failure;

	const subreason = failure.kind === "oracle" ? failure.cause : failure.reason;

	const scenarios =
		failure.kind === "candidate" || failure.kind === "oracle"
			? failure.scenarios.filter((s) => /^S[1-9][0-9]{0,2}$/.test(s))
			: [];

	const detail =
		diagnosisDetail(failure) ??
		(failure.kind === "infrastructure" ? "Held." : null);

	return [
		`${failure.kind}: ${subreason}.`,
		detail,
		scenarios.length > 0 ? `Scenarios ${scenarios.join(", ")}.` : null,
		failure.kind === "candidate"
			? "One bounded repair authorized."
			: "No repair spent.",
	]
		.filter((x) => x !== null)
		.join(" ");
}

function event(
	source: string,
	stage: string,
	name: string,
	detail: string,
	at: string | null = null,
	attempt: number | null = null,
	round: number | null = null,
	generation: number | null = null,
): TimelineEvent {
	return { source, at, stage, event: name, detail, attempt, round, generation };
}

export async function viewerRuns(stateDir: string): Promise<string[]> {
	const ids = new Set<string>();

	for (const dir of ["claims", "stages"]) {
		try {
			const base = join(stateDir, dir);

			if ((await lstat(base)).isSymbolicLink()) continue;

			for (const name of await readdir(base)) {
				const id = name.replace(/\.json$/, "");

				if (isDigest(id)) ids.add(id);
			}
		} catch {
			continue;
		}
	}

	return [...ids].sort();
}

export async function readViewerRun(
	stateDir: string,
	runId: string,
): Promise<ViewerRun> {
	if (!isDigest(runId)) throw new Error("invalid run id");
	const root = await realpath(stateDir);
	const io = new Evidence(root);
	const timeline: TimelineEvent[] = [];
	const sessions: SessionView[] = [];
	const gateway: GatewayDecision[] = [];
	const stageRoot = join(root, "stages", runId);
	const files = await io.files(stageRoot);
	const claimPath = join(root, "claims", `${runId}.json`);
	const claimText = await io.text(claimPath, FILE_CAP, true);

	const claim = claimText === null ? null : viewerClaim(claimText, runId);

	if (claimText !== null && claim === null)
		io.gap(claimPath, "corrupt or wrong-owner claim/book");
	const book = claim?.handoff;
	const projection = book === undefined ? null : candidateProjection(book);

	if (
		projection !== null &&
		(claim?.status !== projection.status ||
			claim?.stage !== projection.stage ||
			claim?.attempt !== projection.attempt ||
			claim?.round !== projection.round)
	)
		io.gap(claimPath, "claim/book projection mismatch");

	const generationOf = (
		stage: string,
		round: number,
		attempt: number | null,
	) => {
		const execution = book?.accounts.find(
			(a) =>
				a.execution.stage === stage &&
				a.execution.round === round &&
				a.execution.attempt === attempt,
		)?.execution;

		return execution?.stage === "review"
			? execution.generation.generation
			: null;
	};

	if (claim !== null)
		timeline.push(
			event(
				relative(root, claimPath),
				projection?.stage ?? claim.stage ?? "admit",
				"local claim",
				projection?.status ?? claim.status ?? "unmarked",
				null,
				claim.attempt,
				book === undefined && claim.marker?.v === 3
					? null
					: (projection?.round ?? claim.round ?? null),
			),
		);
	const statusPath = join(root, "status.json");

	await io.json(statusPath);
	let issue: JsonValue | null = null;

	if (claim !== null) {
		const base = join(root, "admissions", "github");

		const candidates = (await io.files(base)).filter((path) => {
			const parts = relative(base, path).split(sep);
			const repo = `${parts[0]}/${parts[1]}`;

			return (
				parts.length === 4 &&
				parts[2] === String(claim.issue) &&
				parts[3] === `${claim.eventId}.json` &&
				isRepoSlug(repo) &&
				runIdOf({ repo, issue: claim.issue, eventId: claim.eventId }) === runId
			);
		});

		if (candidates.length === 1) {
			const path = candidates[0];
			const admission = path === undefined ? null : await io.json(path);
			issue = fieldOf(admission, "snapshot") ?? null;
		}

		if (objectOf(issue) === null)
			io.gap(base, "issue snapshot missing or corrupt");
	}

	let total = 0;
	let parent = 0;
	let children = 0;
	const modelTotals = new Map<string, number>();

	const receiptPaths = files.filter((path) =>
		path.endsWith(`${sep}receipt.json`),
	);

	try {
		if (!(await io.safe(stageRoot))) throw new Error("unsafe source");

		for (const entry of await readdir(stageRoot, { withFileTypes: true })) {
			if (
				!entry.isDirectory() ||
				!/^(specify|accept|build|review)(?:-r[0-2])?-[1-9][0-9]*(?:\.[0-9]+)?$/.test(
					entry.name,
				)
			)
				continue;
			const path = join(stageRoot, entry.name, "receipt.json");

			if (!receiptPaths.includes(path)) receiptPaths.push(path);
		}
	} catch {
		io.gap(stageRoot, "stage directory unavailable");
	}

	if (receiptPaths.length === 0) io.gap(stageRoot, "no stage receipts");

	const received = new Set<string>();

	for (const path of receiptPaths) {
		if ((await io.text(path)) === null) continue;
		const receipt = await readStageReceipt(path);

		if (
			receipt === null ||
			field(receipt.record, "runId") !== runId ||
			countOf(fieldOf(receipt.record, "version")) !== 1
		) {
			io.gap(path, "corrupt or mismatched stage receipt");
			continue;
		}

		const source = relative(root, path);
		const stage = field(receipt.record, "stage") ?? "unknown";
		const attempt = countOf(fieldOf(receipt.record, "attempt"));
		const round = Number(/(?:build|review)-r([0-2])-/.exec(source)?.[1] ?? 0);
		const generation = generationOf(stage, round, attempt);
		received.add(
			`${stage}${round > 0 || stage === "review" ? `-r${round}` : ""}-${attempt}`,
		);

		for (const dropped of arrayOf(
			fieldOf(receipt.record, "session_truncated"),
		) ?? [])
			io.gap(
				path,
				`session_truncated: ${textOf(dropped) ?? "unknown session"}`,
			);

		if (attempt === null || stage === "unknown")
			io.gap(path, "missing stage identity");
		timeline.push(
			event(
				source,
				stage,
				"stage receipt",
				receipt.outcome.kind,
				null,
				attempt,
				round,
				generation,
			),
		);
		const settlement = objectOf(fieldOf(receipt.record, "settlement"));
		timeline.push(
			event(
				source,
				stage,
				"settlement",
				field(settlement, "event") ?? "unavailable",
				null,
				attempt,
				round,
				generation,
			),
		);

		if (field(settlement, "event") !== "agent_settled")
			io.gap(path, "settlement not observed");

		const aggregate = receiptPaths.some(
			(other) =>
				other !== path &&
				path.startsWith(other.slice(0, -"receipt.json".length)),
		);

		if (!aggregate) {
			total += receipt.usage.total;
			parent += receipt.usage.parent;
			children += receipt.usage.children;

			for (const [model, tokens] of Object.entries(receipt.usage.byModel))
				modelTotals.set(model, (modelTotals.get(model) ?? 0) + tokens);

			if (receipt.usage.unreadChildren > 0) io.gap(path, "unread child usage");
		}

		for (const metadata of arrayOf(fieldOf(receipt.record, "stderr")) ?? []) {
			const name = field(objectOf(metadata), "file");
			const bytes = countOf(fieldOf(objectOf(metadata), "bytes"));

			if (
				name === null ||
				!/^pi-stderr-\d+\.log$/.test(name) ||
				bytes === null
			) {
				io.gap(path, "corrupt stderr metadata");
				continue;
			}

			const stderr = join(path.slice(0, -"receipt.json".length), name);

			if ((await io.text(stderr, 65536)) !== null)
				timeline.push(
					event(
						relative(root, stderr),
						stage,
						"stderr metadata",
						`${bytes} bytes (untrusted; not executed)`,
						null,
						attempt,
					),
				);
		}
	}

	const sessionPaths = files.filter(
		(path) => path.includes(`${sep}sessions${sep}`) && path.endsWith(".jsonl"),
	);

	if (sessionPaths.length === 0)
		io.gap(stageRoot, "Pi session JSONL files missing");
	const childLinks = new Map<string, { parent: string; source: string }>();

	for (const path of sessionPaths) {
		const records = await io.lines(path);
		const source = relative(root, path);

		const header = records.find(
			(record) => field(record, "type") === "session",
		);

		if (header === undefined) {
			io.gap(path, "session header missing");
			continue;
		}

		const id = field(header, "id") ?? source;

		const identity = /\/(specify|accept|build|review)(?:-r([0-2]))?-(\d+)/.exec(
			path,
		);

		const stage = identity?.[1] ?? "unknown";
		const round = identity?.[2] === undefined ? null : Number(identity[2]);
		const attempt = identity?.[3] === undefined ? null : Number(identity[3]);
		const generation = generationOf(stage, round ?? 0, attempt);

		const sessionTimeline: TimelineEvent[] = [];

		for (const record of records) {
			const message = objectOf(fieldOf(record, "message"));
			const type = field(record, "type") ?? "unknown";
			const role = field(message, "role");
			sessionTimeline.push(
				event(
					source,
					stage,
					type === "message" ? (role ?? type) : type,
					field(record, "customType") ??
						field(message, "customType") ??
						field(message, "stopReason") ??
						"",
					atOf(record),
					attempt,
					round,
					generation,
				),
			);

			const custom = type === "custom_message" ? record : message;

			if (field(custom, "customType") === "subagent_result") {
				const details = objectOf(fieldOf(custom, "details"));
				const child = field(details, "sessionFile");

				if (child !== null)
					childLinks.set(child.split("/").at(-1) ?? child, {
						parent: id,
						source,
					});
				else io.gap(path, "child result has no session file");
			}
		}

		const usage = childUsageOf(
			records.map((record) => JSON.stringify(record)).join("\n"),
		);

		if (sessions.some((session) => session.id === id)) {
			io.gap(path, "duplicate session identity");
			continue;
		}

		sessions.push({
			id,
			source,
			parent: field(header ?? null, "parentSession"),
			stage,
			attempt,
			round,
			generation,
			tokens: usage.total,
			byModel: Object.fromEntries(usage.byModel),
			timeline: sessionTimeline,
		});
	}

	for (const session of sessions) {
		const name = session.source.split("/").at(-1) ?? "";
		session.parent = childLinks.get(name)?.parent ?? session.parent;

		if (session.parent === null) timeline.push(...session.timeline);
	}

	for (const [file, link] of childLinks) {
		if (!sessions.some((session) => session.source.endsWith(`/${file}`)))
			io.gap(
				join(root, link.source),
				`missing_child_session: ${file} (parent ${link.parent})`,
			);
	}

	const childSessions = sessions.filter((session) => session.parent !== null);
	const sessionModels = new Map<string, { parent: number; children: number }>();

	for (const session of sessions) {
		for (const [model, tokens] of Object.entries(session.byModel)) {
			const row = sessionModels.get(model) ?? { parent: 0, children: 0 };
			row[session.parent === null ? "parent" : "children"] += tokens;
			sessionModels.set(model, row);
		}
	}

	const sessionTotal = sessions.reduce(
		(sum, session) => sum + session.tokens,
		0,
	);

	if (
		sessionTotal !== total ||
		childSessions.reduce((sum, session) => sum + session.tokens, 0) !==
			children ||
		[...new Set([...modelTotals.keys(), ...sessionModels.keys()])].some(
			(model) => {
				const split = sessionModels.get(model);

				return (
					(split?.parent ?? 0) + (split?.children ?? 0) !==
					(modelTotals.get(model) ?? 0)
				);
			},
		)
	)
		io.gap(stageRoot, "session usage does not reconcile with receipt totals");

	const models = [...new Set([...modelTotals.keys(), ...sessionModels.keys()])]
		.sort()
		.map((model) => {
			const split = sessionModels.get(model) ?? { parent: 0, children: 0 };

			return {
				model,
				...split,
				total: modelTotals.get(model) ?? 0,
				cost: "unavailable" as const,
			};
		});

	const audits = files.filter((path) => path.endsWith(`${sep}egress.jsonl`));

	if (audits.length === 0) io.gap(stageRoot, "gateway audit missing");

	for (const path of audits) {
		for (const record of await io.lines(path)) {
			const upstream = objectOf(fieldOf(record, "upstream"));
			const decision = field(record, "decision");
			const stage = field(record, "stage");
			const at = atOf(record);

			if (
				field(record, "runId") !== runId ||
				decision === null ||
				!["forward", "deny", "error", "blocked_mid_stream"].includes(
					decision,
				) ||
				stage === null ||
				at === null
			) {
				io.gap(path, "corrupt or mismatched audit line");
				continue;
			}

			const identity =
				/\/(specify|accept|build|review)(?:-r([0-2]))?-(\d+)/.exec(path);

			const round = identity?.[2] === undefined ? null : Number(identity[2]);
			const attempt = countOf(fieldOf(record, "attempt"));

			gateway.push({
				source: relative(root, path),
				at,
				stage,
				attempt,
				round,
				generation: generationOf(stage, round ?? 0, attempt),
				decision,
				destination: field(upstream, "host") ?? "not forwarded (no upstream)",
				path: field(record, "path") ?? "unavailable",
				method: field(record, "method") ?? "unavailable",
				reason: field(record, "reason"),
			});
		}
	}

	gateway.sort((a, b) => Date.parse(a.at) - Date.parse(b.at));

	if (book?.kind === "selected") {
		const generations = candidateGenerations(book);

		const stored = async (
			path: string,
			expected:
				| GenerationEvidence
				| GenerationIntent
				| Certification
				| CandidateExecution
				| ReviewReceipt
				| Verdict,
			canonical: (value: JsonValue | undefined) => string | undefined = (
				value,
			) => JSON.stringify(value),
		) => {
			const text = await io.text(path, FILE_CAP, true);

			if (
				text !== null &&
				canonical(parseJson(text)) !== JSON.stringify(expected)
			)
				io.gap(path, "evidence binding mismatch");
		};

		for (const evidence of generations) {
			const g = evidence.intent;
			const dir = validationDir(root, runId, g.round, g.generation);
			await stored(join(dir, "generation.json"), g);

			if (g.digest !== book.current.intent.digest)
				await stored(join(dir, "archive.json"), evidence, (value) =>
					JSON.stringify(migrateEvidenceValue(value)),
				);
			timeline.push(
				event(
					relative(root, dir),
					"validate",
					g.digest === book.current.intent.digest
						? "selected generation"
						: "archived generation",
					`base ${g.baseSha}; patch ${g.patchDigest}; workflow ${book.pin.workflowSha}; pin ${book.pin.workflowDigest}`,
					null,
					null,
					g.round,
					g.generation,
				),
			);
			const validation = evidence.validation;

			if (validation?.publication != null)
				timeline.push(
					event(
						relative(root, dir),
						"validate",
						"publication",
						validation.publication.candidateSha,
						null,
						null,
						g.round,
						g.generation,
					),
				);

			if (validation?.ciRunId != null)
				timeline.push(
					event(
						relative(root, dir),
						"validate",
						"CI run",
						String(validation.ciRunId),
						null,
						null,
						g.round,
						g.generation,
					),
				);

			if (evidence.verdict !== null) {
				await stored(join(dir, "verdict.json"), evidence.verdict);
				timeline.push(
					event(
						relative(root, dir),
						"validate",
						"CI verdict",
						`${evidence.verdict.pass ? "passed" : "failed"}; candidate ${evidence.verdict.candidateSha}; gate ${evidence.verdict.gateSha}`,
						null,
						null,
						g.round,
						g.generation,
					),
				);
			}

			const assessmentPath = join(dir, "assessment.json");

			if (
				evidence.verdict !== null &&
				(!evidence.verdict.pass ||
					(await lstat(assessmentPath).then(
						() => true,
						() => false,
					)))
			) {
				const path = assessmentPath;
				const text = await io.text(path, FILE_CAP, true);
				const read = text === null ? null : readAssessmentBytes(text);

				if (text !== null && read === null)
					io.gap(path, "assessment unreadable");

				if (read !== null)
					timeline.push(
						event(
							relative(root, dir),
							"validate",
							"diagnosis",
							assessmentDetail(read.assessment),
							null,
							null,
							g.round,
							g.generation,
						),
					);
			}

			const certificate = evidence.certification;

			if (certificate !== null) {
				await stored(join(dir, "certification.json"), certificate, (value) =>
					JSON.stringify(migrateCertificationValue(value)),
				);
				await stored(
					join(
						reviewDir(root, book.pin.runId, g.round, g.generation),
						"receipt.json",
					),
					certificate.review,
					(value) => JSON.stringify(parseReviewReceipt(value)),
				);
				timeline.push(
					event(
						relative(root, dir),
						"review",
						"historical certification",
						`candidate ${certificate.verdict.candidateSha}; CI ${certificate.verdict.ciRunId}; report ${certificate.report.reportId}; execution ${certificate.execution.id}`,
						null,
						certificate.execution.attempt,
						g.round,
						g.generation,
					),
				);

				for (const seat of certificate.review.seats)
					timeline.push(
						event(
							relative(root, dir),
							"review",
							seat.seat,
							`${seat.requested}; observed ${seat.observed ?? "unknown"}; ${seat.label}; tokens ${seat.tokens}`,
							null,
							certificate.execution.attempt,
							g.round,
							g.generation,
						),
					);
			}
		}

		const published = book.published;

		const certified = generations.find(
			(g) => g.intent.digest === published?.promoted.digest,
		)?.certification;

		if (published !== null)
			timeline.push(
				event(
					"claims",
					"land",
					"published PR",
					`PR ${published.number}; historical certification ${certified?.verdict.candidateSha ?? "unavailable"}; recorded readiness ${published.readiness.kind}${published.readiness.kind === "not_ready" ? ` (${published.readiness.reason})` : ""}; working ${book.work.kind}`,
					new Date(published.readiness.since).toISOString(),
					null,
					published.promoted.round,
					published.promoted.generation,
				),
			);

		const work = book.work;

		const terminal =
			work.kind === "terminal"
				? work.terminal
				: work.kind === "effect" && work.request.kind === "finish_pr"
					? work.request.terminal
					: null;

		if (terminal?.kind === "merged") {
			const matching = generations.find(
				(g) => g.certification?.verdict.candidateSha === terminal.head,
			);

			timeline.push(
				event(
					"claims",
					"land",
					"actual merge",
					`${terminal.mergeSha}; head ${terminal.head}; actor ${terminal.actor ?? "unknown"}; ${matching === undefined ? "owner override (no matching certification)" : "matching historical factory certification"}; recorded readiness ${terminal.readiness?.kind ?? "unknown"}`,
					null,
					null,
					matching?.intent.round ?? null,
					matching?.intent.generation ?? null,
				),
			);
		}

		for (const account of book.accounts) {
			const e = account.execution;

			const path = join(
				stageRoot,
				`${e.stage}-r${e.round}-${e.attempt}`,
				"execution.json",
			);

			await stored(path, e);

			if (account.spend.kind === "unknown" || account.settlement !== "settled")
				io.gap(path, "execution settlement or usage unavailable");
			timeline.push(
				event(
					relative(root, path),
					e.stage,
					"execution account",
					`${account.settlement}; tokens ${account.spend.kind === "known" ? account.spend.tokens : `unknown (floor ${account.spend.floor})`}`,
					null,
					e.attempt,
					e.round,
					e.stage === "review" ? e.generation.generation : null,
				),
			);
		}

		if (candidateUsage(book) !== total)
			io.gap(
				claimPath,
				"candidate accounting does not reconcile with retained receipt totals",
			);
	} else if (
		claim?.marker?.v === 3 ||
		claim?.status === "waiting" ||
		(claim?.validation === undefined &&
			["validate", "review", "land"].includes(claim?.stage ?? ""))
	) {
		io.gap(
			claimPath,
			"candidate book unavailable; certification and working generation unknown",
		);
		timeline.push(
			event(
				"claims",
				"land",
				"candidate evidence unavailable",
				`PR ${claim?.marker?.pr ?? "unknown"}; selected public floor r${claim?.marker?.round ?? "unknown"}/g${claim?.marker?.handoff?.generation ?? "unknown"}; active execution unknown; no certification reconstructed`,
			),
		);

		const path = join(
			root,
			"handoff",
			runId,
			"missing-evidence-observation.json",
		);

		if (claim?.marker?.pr != null) {
			try {
				await lstat(path);

				const observed = objectOf(
					parseJson((await io.text(path, FILE_CAP, true)) ?? ""),
				);

				const head = field(observed, "head");
				const mergeSha = field(observed, "mergeSha");
				const actor = fieldOf(observed, "actor");

				if (
					fieldOf(observed, "kind") !== "merged" ||
					fieldOf(observed, "number") !== claim.marker.pr ||
					head === null ||
					!isGitSha(head) ||
					mergeSha === null ||
					!isGitSha(mergeSha) ||
					(actor !== null &&
						(actor !== String(actor) || !isLogin(String(actor))))
				)
					io.gap(path, "invalid missing-evidence merge observation");
				else
					timeline.push(
						event(
							relative(root, path),
							"land",
							"actual merge (evidence unavailable)",
							`${mergeSha}; head ${head}; actor ${actor ?? "unknown"}; certification unavailable; accounting unresolved`,
						),
					);
			} catch {
				io.gap(path, "merge observation unavailable");
			}
		}
	}

	if (book === undefined && claim?.validation !== undefined) {
		const state = claim.validation;

		if (state.publication !== null)
			timeline.push(
				event(
					"claims",
					"validate",
					"publication",
					state.publication.candidateSha,
					null,
					null,
					state.round,
				),
			);

		if (state.ciRunId !== null)
			timeline.push(
				event(
					"claims",
					"validate",
					"CI run",
					String(state.ciRunId),
					null,
					null,
					state.round,
				),
			);
		const path = join(validationDir(root, runId, state.round), "verdict.json");

		if ((await io.text(path)) !== null) {
			try {
				const verdict = readStoredVerdict(path);

				if (
					!Array.isArray(verdict.checks) ||
					![true, false].includes(verdict.pass)
				)
					throw new Error("corrupt verdict");
				timeline.push(
					event(
						relative(root, path),
						"validate",
						"CI verdict",
						verdict.pass ? "passed" : "failed",
						null,
						null,
						state.round,
					),
				);
			} catch {
				io.gap(path, "corrupt stored verdict");
			}
		}
	}

	if (
		book === undefined &&
		(claim?.stage === "review" || (claim?.round ?? 0) > 0)
	) {
		for (let round = 0; round <= (claim?.round ?? 0); round++) {
			if (round === (claim?.round ?? 0) && claim?.stage !== "review") continue;

			if (round < (claim?.round ?? 0)) {
				const prior = objectOf(
					await io.json(
						join(validationDir(root, runId, round), "verdict.json"),
					),
				);

				const attempted = receiptPaths.some((path) =>
					relative(stageRoot, path)
						.split(sep)[0]
						?.startsWith(`review-r${round}-`),
				);

				if (fieldOf(prior, "pass") !== true && !attempted) continue;
			}

			const path = join(root, "review", runId, `r${round}`, "receipt.json");
			const raw = await io.json(path);
			const receipt = raw === null ? null : parseReviewReceipt(raw);

			if (
				receipt === null ||
				receipt.runId !== runId ||
				receipt.round !== round
			) {
				io.gap(path, "missing_or_corrupt_round_review");
				continue;
			}

			const verdict =
				receipt.blocking || blocksReview(receipt.seats) ? "blocking" : "clean";

			for (const seat of receipt.seats) {
				timeline.push(
					event(
						relative(root, path),
						"review",
						seat.seat,
						`${seat.requested}; ${seat.label}; tokens ${seat.tokens}; ${verdict}`,
						null,
						null,
						round,
					),
				);
			}
		}
	}

	const required = new Set<string>();

	const stageOrder = [
		"admit",
		"specify",
		"accept",
		"build",
		"validate",
		"review",
		"land",
	];

	const modelStages = ["specify", "accept", "build", "review"];

	const reached = (stage: string, attempt: number | null, round = 0) => {
		const keyOf = (name: string, n: number) =>
			`${name}${(name === "build" && round > 0) || name === "review" ? `-r${round}` : ""}-${n}`;

		for (const earlier of modelStages)
			if (
				stageOrder.indexOf(earlier) < stageOrder.indexOf(stage) &&
				![...received].some((key) =>
					key.startsWith(keyOf(earlier, 1).slice(0, -1)),
				)
			)
				required.add(keyOf(earlier, 1));

		if (modelStages.includes(stage) && attempt !== null)
			required.add(keyOf(stage, attempt));
	};

	if (claim?.stage !== undefined && claim?.stage !== null)
		reached(claim.stage, claim.attempt, claim.round);

	const markerPath = join(root, "markers", `${runId}.jsonl`);

	try {
		await lstat(markerPath);

		for (const record of await io.lines(markerPath)) {
			const parsed = parseMarker(field(record, "body") ?? "");

			if (parsed.kind !== "marker" || parsed.marker.runId !== runId) {
				io.gap(markerPath, "corrupt recorded marker");
				continue;
			}

			const marker = parsed.marker;
			reached(marker.stage, marker.attempt, marker.round);
			timeline.push(
				event(
					relative(root, markerPath),
					marker.stage,
					`marker ${marker.seq}`,
					marker.status,
					atOf(record),
					marker.attempt,
					marker.round ?? null,
				),
			);
		}
	} catch {
		io.gap(
			markerPath,
			"marker comment history is not retained locally; claim is only the latest state",
		);
	}

	for (const key of required)
		if (!received.has(key))
			io.gap(join(stageRoot, key, "receipt.json"), "missing_stage_receipt");

	timeline.sort((a, b) => {
		if (a.at !== null && b.at !== null)
			return Date.parse(a.at) - Date.parse(b.at);

		if (a.at !== null) return -1;

		if (b.at !== null) return 1;

		return (
			(a.round ?? 0) - (b.round ?? 0) ||
			(a.generation ?? 0) - (b.generation ?? 0) ||
			stageOrder.indexOf(a.stage) - stageOrder.indexOf(b.stage) ||
			(a.attempt ?? 0) - (b.attempt ?? 0)
		);
	});

	const status = projection?.status ?? claim?.status ?? "unavailable";

	const terminal = [
		"stage_passed",
		"failed",
		"released",
		"needs_info",
		"budget_exhausted",
		"landed",
		"cancelled",
	].includes(status);

	return {
		runId,
		complete: terminal && io.gaps.length === 0,
		status,
		issue,
		gaps: io.gaps,
		timeline,
		usage: {
			total,
			accounted: book === undefined ? null : candidateUsage(book),
			parent,
			children,
			models,
			sessions,
			cost: "unavailable",
		},
		children: childSessions,
		gateway,
	};
}
