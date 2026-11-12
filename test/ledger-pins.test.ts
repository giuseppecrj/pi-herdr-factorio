import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, describe, it } from "node:test";
import {
	GitHubPublicationApi,
	publishCandidate,
} from "../src/github/publish.ts";
import {
	LEDGER_FILE,
	createLedgerChild,
	createLedgerRoot,
	ledgerApiOf,
	type LedgerApi,
} from "../src/ledger/git.ts";
import {
	AUTONOMY_DIGEST,
	frozenRowOf,
	ledgerRowOf,
	parseLedger,
	type FrozenRow,
	type RunContextV2,
} from "../src/ledger/schema.ts";
import {
	appendRun,
	type AdoptionCursor,
	type AppendResult,
} from "../src/ledger/append.ts";
import {
	terminalSnapshot,
	type TerminalFacts,
} from "../src/ledger/terminal.ts";
import { fileLedgerOutbox } from "../host/controller/outbox.ts";
import { digestOf, runIdOf } from "../src/core/run.ts";
import { objectOf, type JsonValue } from "../src/core/json.ts";
import { isGitSha, type GitSha } from "../src/config/schema.ts";
import { EXE_DEV_PLATFORM } from "../src/trust/platform.ts";
import { RealGit } from "./ledger-real-git.ts";
import { repo } from "./ledger-git.ts";
import { candidateLifecycleFixture } from "./helpers.ts";
import { TRUSTED_RUN_CAP } from "./fake-ticket-adapter.ts";

const FIXTURE = readFileSync(
	new URL("./fixtures/metrics/runs-2026-11-08.jsonl", import.meta.url),
);

const date = "2026-11-04T12:00:00Z";

type Pins = {
	readonly fixture: string;
	readonly versions: readonly number[];
	readonly v5: string;
	readonly tip: string;
	readonly terminal: Readonly<Record<string, string>>;
	readonly publication: Readonly<Record<string, string>>;
};

const PIN: Pins = {
	fixture: "9148f06ec98c3eeb522be04a5f6538aa3d5905f982b7ce8ca9478cecbe1a5fcc",
	versions: [
		1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 2, 2, 2, 2, 2, 3, 3, 4, 4, 4, 4,
		4,
	],
	v5: "b0b932f6431d48d596c118489801c76cd8504ad7f34b4bf9d111b0641b32b7ad",
	tip: "c80b569d5e18cc7d7effb9431f559a9eddc09e2e",
	terminal: {
		failed: "a601a4d847617b7e1f0ee8373b6ba8eb4fa1400230e99842c0792e9a34589575",
		unknownCost:
			"d82f7edf8cd59b9a468837610f41113061961487b819c230b5d2b72bc367a77d",
		unrecorded:
			"7718b51066582145d257a5fbc5caf8c3c7a89c908e317c629b185378f3db041c",
		merged: "34d8d68f269a73cfdd7d3b123c6896d98fd1ca15f5c0268b95859adc92235244",
	},
	publication: {
		base: "25672b8c9ac3ce109d44b854e221584254ade4d5",
		first:
			"factory/run/7-298c444d4de0-r0 36ab19dae0e544275cf678cb16e946d959f3e836 e8916232300fb1826d001d6918b984d415fa6910",
		successor:
			"factory/run/7-298c444d4de0-r0-g1 510e759fa0f214ab354c3f1901e7c3a8643ca387 9f0070430eea859cea34ace2a8ed79e2cdf4e9ab",
		firstRequests:
			"eb75439ef4302a7d7c486da44cf98acdf691f24a5c760b9f19c9dc5678049ce3",
		successorRequests:
			"84e062b868a114b91f60f909aacc29118890ff69dd364310805ca5f74ce71fb8",
		writes: "1125cee0e9bbc5019bf55bf27e94b785394550b959ccbe7d1ee284ffd71cd6a1",
	},
};

const dirs: string[] = [];

after(() => {
	for (const dir of dirs) rmSync(dir, { recursive: true, force: true });
});

const temp = (name: string) => {
	const dir = mkdtempSync(join(tmpdir(), `ledger-pins-${name}-`));
	dirs.push(dir);

	return dir;
};

const sha = (char: string): GitSha => {
	const value = char.repeat(40);
	assert.ok(isGitSha(value));

	return value;
};

const realApi = (git: RealGit) =>
	new GitHubPublicationApi(
		git.exec,
		repo,
		EXE_DEV_PLATFORM,
		{},
		async () => true,
		async () => {},
	);

const pending = (row: FrozenRow) => ({
	runId: row.row.runId,
	bytes: row.bytes,
	digest: row.digest,
	date,
});

const published = (result: AppendResult) =>
	result.kind === "published" ? result : assert.fail(JSON.stringify(result));

function shippedRows(): FrozenRow[] {
	return parseLedger(FIXTURE).map((line) =>
		line.kind === "known" ? line : assert.fail(line.kind),
	);
}

function v5Row(): FrozenRow {
	const landed = shippedRows().find(
		(line) => line.row.v === 4 && line.row.outcome.kind === "landed",
	);

	assert.ok(landed && landed.row.outcome.kind === "landed");
	const assurance = landed.row.outcome.assurance;

	const { repo: owner, issue } = landed.row;

	return ledgerRowOf({
		...landed.row,
		v: 5,
		eventId: "5000",
		runId: runIdOf({ repo: owner, issue, eventId: "5000" }),
		outcome: {
			...landed.row.outcome,
			assurance:
				assurance.kind === "factory_verified"
					? { ...assurance, authored: "factory" }
					: assurance,
		},
	});
}

const policy = {
	workflowSha: sha("1"),
	workflowDigest: digestOf("workflow"),
	gates: {
		kind: "known" as const,
		value: { sourceSha: sha("1"), digest: digestOf("gates") },
	},
	autonomy: {
		approveMerge: "always" as const,
		land: "propose" as const,
		digest: AUTONOMY_DIGEST,
	},
};

const production: RunContextV2 = {
	kind: "production",
	policy,
	trustedCap: TRUSTED_RUN_CAP,
};

function facts(issue: number, change: Partial<TerminalFacts>): TerminalFacts {
	const runId = runIdOf({ repo, issue, eventId: `${issue}00` });

	return {
		repo,
		runId,
		issue,
		eventId: `${issue}00`,
		eventAt: "2026-11-04T11:00:00Z",
		snapshotDigest: digestOf(`snapshot-${issue}`),
		workflowSha: policy.workflowSha,
		workflowDigest: policy.workflowDigest,
		status: "needs_info",
		stage: "specify",
		usage: 1_234,
		observedAt: date,
		candidate: null,
		context: production,
		terminalWorkflowObservation: null,
		start: { v: 2, runId, startedAt: date, context: production },
		...change,
	};
}

function terminalRow(input: TerminalFacts): FrozenRow {
	return ledgerRowOf({
		...(objectOf(terminalSnapshot(input)) ?? assert.fail("snapshot")),
		terminalMarker: { seq: 4, digest: digestOf(`marker-${input.issue}`) },
	});
}

function terminalCases() {
	const failed = facts(51, {
		status: "failed",
		stage: "accept",
		cause: { stage: "accept", class: "attempts", reason: "attempts_exhausted" },
		attemptEnds: [1, 2].map((attempt) => ({
			v: 1,
			runId: runIdOf({ repo, issue: 51, eventId: "5100" }),
			stage: "accept",
			round: 0,
			attempt,
			disposition: "model_failure",
			usage: 600,
			next:
				attempt === 1
					? { kind: "retry", attempt: 2, dueAt: 0 }
					: { kind: "end", status: "failed" },
		})),
	});

	const unknownCost = facts(52, {
		status: "budget_exhausted",
		stage: "build",
		cause: { stage: "build", class: "budget", reason: "run_tokens" },
		start: null,
	});

	const unrecorded = facts(53, { status: "failed", stage: "review" });
	const state = candidateLifecycleFixture();
	const certified = state.history[0] ?? assert.fail("history");
	const head = certified.certification?.report.candidateSha ?? assert.fail();
	const pin = state.pin;

	const merged: TerminalFacts = {
		...facts(1, {}),
		repo: pin.repo,
		runId: pin.runId,
		issue: pin.issue,
		eventId: "1",
		workflowSha: pin.workflowSha,
		workflowDigest: pin.workflowDigest,
		status: "landed",
		stage: "land",
		usage: 40,
		context: {
			kind: "legacy",
			known: {
				workflowSha: pin.workflowSha,
				workflowDigest: pin.workflowDigest,
				policy: null,
				trustedCap: { kind: "unavailable", reason: "receipt_missing" },
				verification: null,
			},
			gaps: ["receipt_missing"],
		},
		start: null,
		evidence: { mergedAt: "2026-11-04T12:30:00Z" },
		candidate: {
			...state,
			work: {
				kind: "terminal",
				terminal: {
					kind: "merged",
					number: 5,
					head,
					mergeSha: sha("d"),
					actor: "owner",
					assurance: {
						kind: "factory_verified",
						certification: certified.intent,
					},
					readiness: state.published?.readiness ?? assert.fail(),
				},
			},
		},
	};

	return { failed, unknownCost, unrecorded, merged };
}

describe("L09 ledger and publication characterization", () => {
	it("re-reads every shipped v1-v4 row and a v5 row to unchanged bytes", () => {
		assert.equal(digestOf(FIXTURE), PIN.fixture);
		const rows = shippedRows();
		assert.deepEqual(
			rows.map((row) => row.row.v),
			PIN.versions,
		);
		assert.ok(Buffer.concat(rows.map((row) => row.bytes)).equals(FIXTURE));

		for (const row of [...rows, v5Row()]) {
			const again = ledgerRowOf(JSON.parse(row.bytes.toString("utf8")));
			assert.ok(again.bytes.equals(row.bytes));
			assert.equal(again.digest, digestOf(row.bytes));
			assert.ok(frozenRowOf(row.bytes)?.bytes.equals(row.bytes));
		}

		assert.equal(v5Row().row.v, 5);
		assert.equal(v5Row().digest, PIN.v5);
	});

	it("appends every row version to a real Git ledger whose objects match the client's", async () => {
		const git = new RealGit(temp("append"), repo);
		const api = ledgerApiOf(realApi(git));
		const rows = [...shippedRows(), v5Row()];
		let anchor = null;

		for (const [at, row] of rows.entries()) {
			const result = published(await appendRun(api, pending(row), anchor));
			assert.equal(result.line, at + 1);
			anchor = result.anchor;
		}

		const bytes = git.show("factory/ledger", LEDGER_FILE);
		assert.ok(bytes.equals(Buffer.concat(rows.map((row) => row.bytes))));
		assert.equal(git.refOf("factory/ledger"), PIN.tip);
		assert.equal(
			git.out(["rev-list", "--count", "refs/heads/factory/ledger"]),
			String(rows.length + 1),
		);
		assert.equal(git.git(["fsck", "--strict", "--no-dangling"]).code, 0);
		const last = rows.at(-1) ?? assert.fail();
		assert.equal(
			git.out(["log", "-1", "--format=%B", "refs/heads/factory/ledger"]),
			`factory: ledger row ${last.row.runId}\n\nFactory-Run: ${last.row.runId}\nFactory-Row: ${last.digest}`,
		);
		assert.equal(
			git.out([
				"log",
				"-1",
				"--format=%an <%ae> %at",
				"refs/heads/factory/ledger",
			]),
			`${EXE_DEV_PLATFORM.controllerLogin} <${EXE_DEV_PLATFORM.botEmail}> ${Date.parse(date) / 1000}`,
		);
		assert.equal(
			git.writes.some((write) => write.method === "DELETE"),
			false,
		);
	});

	it("appends the same run twice and keeps one row without a second write", async () => {
		const git = new RealGit(temp("twice"), repo);
		const api = ledgerApiOf(realApi(git));
		const row = shippedRows()[0] ?? assert.fail();
		const first = published(await appendRun(api, pending(row), null));
		const writes = git.writes.length;
		const again = published(await appendRun(api, pending(row), first.anchor));
		const fresh = published(await appendRun(api, pending(row), null));

		assert.deepEqual(
			[again.line, again.tip, fresh.line, fresh.tip],
			[1, first.tip, 1, first.tip],
		);
		assert.equal(git.writes.length, writes);
		assert.ok(git.show("factory/ledger", LEDGER_FILE).equals(row.bytes));
	});

	it("rebases over a remote tip that moved between read and append, never forcing", async () => {
		const git = new RealGit(temp("conflict"), repo);
		const api = ledgerApiOf(realApi(git));
		const [first, second, third] = shippedRows();
		assert.ok(first && second && third);
		const one = published(await appendRun(api, pending(first), null));
		let raced = false;

		const racing: LedgerApi = {
			...api,
			child: async (parent, bytes, when, message) => {
				if (!raced) {
					raced = true;
					published(await appendRun(api, pending(third), null));
				}

				return api.child(parent, bytes, when, message);
			},
		};

		const two = published(await appendRun(racing, pending(second), one.anchor));
		assert.equal(two.line, 3);
		assert.ok(
			git
				.show("factory/ledger", LEDGER_FILE)
				.equals(Buffer.concat([first.bytes, third.bytes, second.bytes])),
		);

		const patches = git.writes.filter((write) => write.method === "PATCH");
		assert.equal(patches.length, 4);
		assert.ok(
			patches.every(
				(write) =>
					JSON.stringify(write.body).includes('"force":false') &&
					write.path === "git/refs/heads/factory/ledger",
			),
		);

		const changed = ledgerRowOf({
			...JSON.parse(second.bytes.toString("utf8")),
			terminalObservedAt: "2026-11-09T00:00:00Z",
		});

		const writes = git.writes.length;
		const conflict = await appendRun(api, pending(changed), two.anchor);
		assert.deepEqual(
			[conflict.kind, conflict.kind === "blocked" && conflict.reason],
			["blocked", "row_conflict"],
		);
		assert.equal(git.writes.length, writes);
	});

	it("adopts a pre-existing real Git ledger through a saved cursor", async () => {
		const git = new RealGit(temp("adopt"), repo);
		const transport = realApi(git);
		let parent = await createLedgerRoot(transport, date);

		for (let n = 0; n < 20; n++)
			parent = await createLedgerChild(
				transport,
				parent,
				Buffer.alloc(0),
				date,
				"empty\n",
			);

		assert.equal(
			git.git(["update-ref", "refs/heads/factory/ledger", parent.sha]).code,
			0,
		);
		const api = ledgerApiOf(transport);
		const row = shippedRows()[0] ?? assert.fail();
		const saved: AdoptionCursor[] = [];

		const adoption = () => ({
			cursor: saved.at(-1) ?? null,
			save: async (cursor: AdoptionCursor) => {
				saved.push(cursor);

				return true;
			},
		});

		const first = await appendRun(api, pending(row), null, 3, adoption());
		assert.deepEqual(
			[first.kind, first.kind === "deferred" && first.reason],
			["deferred", "adoption_pending"],
		);

		const second = published(
			await appendRun(api, pending(row), null, 3, adoption()),
		);

		assert.deepEqual(
			saved.map((cursor) => cursor.walked),
			[...Array.from({ length: 20 }, (_, at) => at + 1), 1],
		);
		assert.equal(second.line, 1);
		assert.equal(
			git.out(["rev-list", "--count", "refs/heads/factory/ledger"]),
			"22",
		);
	});

	it("projects merged, failed and unknown-cost terminal evidence to pinned rows", () => {
		const rows = Object.fromEntries(
			Object.entries(terminalCases()).map(([name, input]) => [
				name,
				terminalRow(input),
			]),
		);

		assert.deepEqual(
			Object.fromEntries(
				Object.entries(rows).map(([name, row]) => [name, row.digest]),
			),
			PIN.terminal,
		);

		const view = (row: FrozenRow | undefined) => {
			assert.ok(row && row.row.v === 5);

			return {
				outcome: row.row.outcome,
				failure: row.row.failure,
				acceptAttempts: row.row.acceptAttempts,
				tokens: row.row.usage.tokens,
				money: row.row.usage.money,
				gaps: row.row.gaps,
			};
		};

		assert.deepEqual(view(rows.failed), {
			outcome: {
				kind: "failed",
				stage: "accept",
				cause: { kind: "known", value: "attempts_exhausted" },
			},
			failure: {
				kind: "known",
				value: {
					stage: "accept",
					class: "attempts",
					reason: "attempts_exhausted",
					failedVisibleChecks: [],
					retainedPatch: null,
				},
			},
			acceptAttempts: {
				kind: "known",
				value: [
					{ attempt: 1, disposition: "model_failed" },
					{ attempt: 2, disposition: "model_failed" },
				],
			},
			tokens: {
				kind: "lower_bound",
				unit: "tokens",
				total: 1_234,
				reason: "not_instrumented",
			},
			money: { kind: "unavailable", reason: "provider_not_reported" },
			gaps: ["not_instrumented", "provider_not_reported", "receipt_missing"],
		});
		assert.deepEqual(view(rows.unknownCost).outcome, {
			kind: "budget_exhausted",
			stage: "build",
			cap: { kind: "known", value: "run_tokens" },
		});
		assert.deepEqual(view(rows.unknownCost).acceptAttempts, {
			kind: "unavailable",
			reason: "receipt_missing",
		});
		assert.deepEqual(view(rows.unrecorded).failure, {
			kind: "unavailable",
			reason: "receipt_missing",
		});
		assert.deepEqual(view(rows.merged).outcome, {
			kind: "landed",
			stage: "land",
			headSha:
				rows.merged?.row.outcome.kind === "landed"
					? rows.merged.row.outcome.headSha
					: assert.fail(),
			mergeSha: sha("d"),
			mergedAt: { kind: "known", value: "2026-11-04T12:30:00Z" },
			assurance: {
				kind: "factory_verified",
				generationDigest:
					rows.merged?.row.outcome.kind === "landed" &&
					rows.merged.row.outcome.assurance.kind === "factory_verified"
						? rows.merged.row.outcome.assurance.generationDigest
						: assert.fail(),
				authored: "factory",
			},
		});

		for (const row of Object.values(rows))
			assert.ok(frozenRowOf(row.bytes)?.bytes.equals(row.bytes));
	});

	it("reconciles a publication interrupted after its Git write in a fresh process, without another append", async () => {
		const state = temp("state");
		const bare = temp("remote");
		const input = terminalCases().failed;
		const outbox = fileLedgerOutbox(state);
		assert.equal(
			await outbox.prepare(input.runId, terminalSnapshot(input)),
			true,
		);
		const marker = { seq: 4, digest: digestOf(`marker-${input.issue}`) };
		assert.equal(await outbox.freeze(input.runId, marker), "frozen");
		const frozen = (await outbox.scan())?.[0]?.row ?? assert.fail("frozen");
		assert.equal(frozen.digest, PIN.terminal.failed);

		const modules = {
			git: new URL("./ledger-real-git.ts", import.meta.url).href,
			controller: new URL("../host/controller/outbox.ts", import.meta.url).href,
			ledger: new URL("../src/ledger/schema.ts", import.meta.url).href,
			platform: new URL("../src/trust/platform.ts", import.meta.url).href,
		};

		const child = (body: string, crash = false) => {
			const code = `
				import { RealGit } from ${JSON.stringify(modules.git)};
				import { fileLedgerOutbox, pumpLedgerOutbox } from ${JSON.stringify(modules.controller)};
				import { parseLedger } from ${JSON.stringify(modules.ledger)};
				import { EXE_DEV_PLATFORM } from ${JSON.stringify(modules.platform)};
				const git = new RealGit(${JSON.stringify(bare)}, ${JSON.stringify(repo)});
				const stateDir = ${JSON.stringify(state)};
				const exec = async (command, args, options) => {
					const result = await git.exec(command, args, options);
					if (${crash} && result.code === 0 && args.includes("PATCH")) process.exit(9);
					return result;
				};
				const pump = () => pumpLedgerOutbox({ stateDir, exec, platform: EXE_DEV_PLATFORM, repo: ${JSON.stringify(repo)}, now: 0, log: () => {} });
				${body}
			`;

			const result = spawnSync(
				process.execPath,
				[
					"--experimental-strip-types",
					"--no-warnings",
					"--input-type=module",
					"-e",
					code,
				],
				{ encoding: "utf8" },
			);

			return {
				status: result.status,
				output: result.stdout === "" ? null : JSON.parse(result.stdout),
				stderr: result.stderr,
			};
		};

		const crashed = child("await pump();", true);
		assert.equal(crashed.status, 9, crashed.stderr);
		const git = new RealGit(bare, repo);
		assert.ok(git.show("factory/ledger", LEDGER_FILE).equals(frozen.bytes));
		assert.equal((await fileLedgerOutbox(state).scan())?.length, 1);
		const tip = git.refOf("factory/ledger");

		const recovered = child(
			"const backlog = await pump(); console.log(JSON.stringify({ backlog, writes: git.writes.length }));",
		);

		assert.equal(recovered.status, 0, recovered.stderr);
		assert.deepEqual(recovered.output, {
			backlog: {
				readable: true,
				pending: 0,
				blocked: 0,
				published: 1,
				oldestObservedAt: null,
				lastError: null,
			},
			writes: 0,
		});

		const reread = child(`
			const outbox = fileLedgerOutbox(stateDir);
			const lines = parseLedger(git.show("factory/ledger", "ledger/runs.jsonl"));
			const again = await pump();
			console.log(JSON.stringify({
				scan: await outbox.scan(),
				anchor: await outbox.anchor(),
				lines: lines.map((line) => [line.kind, line.digest]),
				again: again?.published ?? null,
				writes: git.writes.length,
			}));
		`);

		assert.equal(reread.status, 0, reread.stderr);
		assert.deepEqual(reread.output.scan, []);
		assert.equal(reread.output.anchor.tipSha, tip);
		assert.equal(reread.output.anchor.byteLength, frozen.bytes.length);
		assert.deepEqual(reread.output.lines, [["known", frozen.digest]]);
		assert.deepEqual([reread.output.again, reread.output.writes], [0, 0]);
		assert.equal(git.refOf("factory/ledger"), tip);
	});

	it("publishes candidate commits and branch requests to pinned real Git objects", async () => {
		const git = new RealGit(temp("candidate"), repo);

		const fixed = {
			GIT_AUTHOR_NAME: "owner",
			GIT_AUTHOR_EMAIL: "owner@example.com",
			GIT_AUTHOR_DATE: "@1762257600 +0000",
			GIT_COMMITTER_NAME: "owner",
			GIT_COMMITTER_EMAIL: "owner@example.com",
			GIT_COMMITTER_DATE: "@1762257600 +0000",
		};

		const index = { GIT_INDEX_FILE: join(git.dir, "pin-index") };

		for (const [path, text] of [
			["README.md", "base\n"],
			["src/app.ts", "export const app = 1;\n"],
			["test/acceptance/old.test.ts", "old\n"],
		] as const) {
			const blob = git.out(["hash-object", "-w", "--stdin"], text);
			git.out(
				["update-index", "--add", "--cacheinfo", `100644,${blob},${path}`],
				undefined,
				index,
			);
		}

		const baseTree = git.out(["write-tree"], undefined, index);

		const baseSha = git.out(
			["commit-tree", baseTree, "-m", "base"],
			undefined,
			fixed,
		);

		assert.ok(isGitSha(baseSha));
		const api = realApi(git);
		const runId = runIdOf({ repo, issue: 7, eventId: "700" });

		const common = {
			issue: 7,
			runId,
			round: 0,
			eventAt: date,
			baseSha,
			patchDigest: digestOf("patch"),
			acceptanceDigest: digestOf("acceptance"),
			heldoutDigest: digestOf("heldout"),
			patch: [
				{
					path: "src/app.ts",
					mode: "100644" as const,
					bytes: Buffer.from("export const app = 2;\n"),
				},
				{ path: "README.md", mode: "100644" as const, bytes: null },
			],
			suite: [
				{
					path: "test/acceptance/7.test.ts",
					mode: "100644" as const,
					bytes: Buffer.from("held out\n"),
				},
			],
		};

		const first = await publishCandidate(api, common);
		const requests = git.requests.length;

		const successor = await publishCandidate(api, {
			...common,
			generation: 1,
			ancestry: { kind: "successor", previousHead: first.candidateSha },
		});

		const writes = (from: number, to?: number): JsonValue =>
			git.writes
				.slice(from, to)
				.map((write) => [write.method, write.path, write.body]);

		assert.deepEqual(
			{
				base: baseSha,
				first: [first.branch, first.patchSha, first.candidateSha].join(" "),
				successor: [
					successor.branch,
					successor.patchSha,
					successor.candidateSha,
				].join(" "),
				firstRequests: digestOf(
					JSON.stringify(git.requests.slice(0, requests)),
				),
				successorRequests: digestOf(
					JSON.stringify(git.requests.slice(requests)),
				),
				writes: digestOf(JSON.stringify(writes(0))),
			},
			PIN.publication,
		);
		assert.equal(
			git.out(["log", "-1", "--format=%P", first.candidateSha]),
			first.patchSha,
		);
		assert.equal(
			git.out(["log", "-1", "--format=%P", successor.candidateSha]),
			`${successor.patchSha} ${first.candidateSha}`,
		);
		assert.equal(git.refOf(first.branch), first.candidateSha);
		assert.equal(git.refOf(successor.branch), successor.candidateSha);
		assert.equal(git.git(["fsck", "--strict", "--no-dangling"]).code, 0);
	});
});
