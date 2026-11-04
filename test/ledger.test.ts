import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
	GitHubPublicationApi,
	LEDGER_FILE,
	createLedgerChild,
	createLedgerRoot,
	readLedgerFile,
} from "../src/publication.ts";
import {
	appendRun,
	frozenRowOf,
	indexLedger,
	ledgerApiOf,
	ledgerRow,
	parseLedger,
	type FrozenRow,
	type LedgerApi,
	type LedgerRowInput,
} from "../src/ledger.ts";
import { digestOf, runIdOf } from "../src/run.ts";
import { isGitSha, type GitSha } from "../src/workflow.ts";
import { LedgerGit, repo } from "./ledger-git.ts";

const sha = (char: string): GitSha => {
	const value = char.repeat(40);
	assert.ok(isGitSha(value));

	return value;
};

const date = "2026-11-04T12:00:00Z";

function rowInput(issue: number, eventId = "100"): LedgerRowInput {
	const runId = runIdOf({ repo, issue, eventId });

	const policy = {
		workflowSha: sha("1"),
		workflowDigest: digestOf("workflow"),
		gates: { sourceSha: sha("1"), digest: digestOf("gates") },
		autonomy: {
			approveMerge: "always" as const,
			land: "propose" as const,
			digest: digestOf('{"approveMerge":"always","land":"propose"}'),
		},
	};

	return {
		v: 1,
		runId,
		repo,
		issue,
		eventId,
		eventAt: "2026-11-04T11:00:00Z",
		previousRunId: { kind: "known", value: null },
		snapshotDigest: digestOf(`snapshot-${issue}`),
		originalBase: sha("2"),
		startedAt: { kind: "known", value: "2026-11-04T11:00:05.000Z" },
		terminalObservedAt: "2026-11-04T11:05:00Z",
		provenance: { kind: "production", policy },
		terminalMarker: { seq: 4, digest: digestOf(`marker-${issue}`) },
		outcome: { kind: "needs_info", stage: "specify" },
		pr: null,
		artifacts: { kind: "admission" },
		repairRounds: {
			kind: "known",
			value: { authorized: 0, started: 0, completed: 0 },
		},
		stages: [
			{
				stage: "specify",
				wallMs: { kind: "exact", unit: "milliseconds", total: 41_000 },
				attempts: {
					kind: "known",
					value: {
						passed: 1,
						failed: 0,
						interrupted: 0,
						refused: 0,
						budgetExhausted: 0,
						aborted: 0,
					},
				},
				tokens: { kind: "exact", unit: "tokens", total: 5_900 },
			},
		],
		models: [
			{
				requested: "openai/gpt-6.1-sol",
				observed: { kind: "unavailable", reason: "receipt_missing" },
				providerVersion: {
					kind: "unavailable",
					reason: "provider_not_reported",
				},
				runtime: {
					kind: "known",
					value: {
						pi: "1.5.0",
						agents: "0.9.1",
						pstack: "0.4.2",
						assetsDigest: digestOf("assets"),
					},
				},
				executions: 1,
			},
		],
		usage: {
			tokens: { kind: "exact", unit: "tokens", total: 5_900 },
			parentTokens: { kind: "known", value: 5_900 },
			childTokens: { kind: "known", value: 0 },
			unattributedTokens: { kind: "known", value: 0 },
			money: { kind: "unavailable", reason: "provider_not_reported" },
		},
		interruptedAttempts: { kind: "known", value: 0 },
		contextPressure: { kind: "unavailable", reason: "not_instrumented" },
		redactedReceiptDigests: [digestOf(`receipt-${issue}`)],
		evidence: {
			issueUrl: `https://github.com/${repo}/issues/${issue}`,
			ciUrls: [],
		},
	};
}

function landedInput(issue: number): LedgerRowInput {
	const base = rowInput(issue);
	const intent = digestOf(`intent-${issue}`);

	return {
		...base,
		outcome: {
			kind: "landed",
			stage: "land",
			headSha: sha("c"),
			mergeSha: sha("d"),
			mergedAt: { kind: "unavailable", reason: "public_metadata_unavailable" },
			assurance: { kind: "factory_verified", generationDigest: intent },
		},
		pr: { number: 900, url: `https://github.com/${repo}/pull/900` },
		artifacts: {
			kind: "candidate",
			contractDigest: digestOf("contract"),
			acceptanceDigest: digestOf("acceptance"),
			generations: [
				{
					round: 0,
					generation: 0,
					intentDigest: intent,
					baseSha: sha("2"),
					patchDigest: digestOf("patch"),
					heldoutDigest: { kind: "known", value: digestOf("heldout") },
					candidateSha: { kind: "known", value: sha("c") },
					gateSha: { kind: "known", value: sha("2") },
					gatesDigest: { kind: "known", value: digestOf("gates") },
					ciRunId: { kind: "known", value: 77 },
				},
			],
		},
		evidence: {
			issueUrl: `https://github.com/${repo}/issues/${issue}`,
			ciUrls: [`https://github.com/${repo}/actions/runs/77`],
		},
	};
}

const pending = (row: FrozenRow) => ({
	runId: row.row.runId,
	bytes: row.bytes,
	digest: row.digest,
	date,
});

const quietApi = (fake: LedgerGit) =>
	new GitHubPublicationApi(
		fake.exec,
		repo,
		{},
		async () => true,
		async () => {},
	);

async function remoteBytes(fake: LedgerGit): Promise<Buffer> {
	const api = quietApi(fake);
	const tip = fake.refs.get("factory/ledger");
	assert.ok(tip !== undefined && isGitSha(tip));
	const tree = fake.trees.get(`commit:${tip}`)?.get("tree");
	assert.ok(tree !== undefined && isGitSha(tree));

	return (await readLedgerFile(api, tree)).bytes;
}

async function probeHistory(fake: LedgerGit): Promise<GitSha> {
	const api = quietApi(fake);
	const root = await createLedgerRoot(api, date);
	await api.advanceLedger(null, root.sha);

	const probe = (name: string) =>
		`factory: ledger probe ${name}\n\nFactory-Probe: ledger-branch\n`;

	const empty = Buffer.alloc(0);
	const a = await createLedgerChild(api, root, empty, date, probe("A"));
	await api.advanceLedger(root.sha, a.sha);
	const b = await createLedgerChild(api, root, empty, date, probe("B"));
	assert.equal((await api.advanceLedger(a.sha, b.sha)).kind, "conflict");
	const c = await createLedgerChild(api, a, empty, date, probe("C"));
	await api.advanceLedger(a.sha, c.sha);
	const d = await createLedgerChild(api, c, empty, date, probe("D"));
	await api.advanceLedger(c.sha, d.sha);

	return d.sha;
}

describe("ledger row codec", () => {
	it("round-trips every terminal kind as one canonical LF-terminated line", () => {
		const base = rowInput(1);

		const outcomes: LedgerRowInput["outcome"][] = [
			{ kind: "needs_info", stage: "specify" },
			{ kind: "released", stage: "build" },
			{
				kind: "cancelled",
				stage: "review",
				reason: { kind: "known", value: "withdrawn" },
			},
			{
				kind: "failed",
				stage: "accept",
				cause: { kind: "known", value: "attempts_exhausted" },
			},
			{
				kind: "budget_exhausted",
				stage: "build",
				cap: { kind: "unavailable", reason: "legacy_not_recorded" },
			},
			{ kind: "stage_passed", stage: "specify" },
		];

		for (const outcome of outcomes) {
			const row = ledgerRow({ ...base, outcome });
			assert.equal(row.bytes.at(-1), 0x0a);
			assert.equal(row.bytes.indexOf(0x0a), row.bytes.length - 1);
			assert.equal(row.digest, digestOf(row.bytes));
			assert.deepEqual(frozenRowOf(row.bytes)?.row, row.row);
		}

		const landed = ledgerRow(landedInput(2));
		assert.equal(frozenRowOf(landed.bytes)?.digest, landed.digest);
	});

	it("derives gaps from every unavailable fact and lower bound, and never writes money as zero", () => {
		const row = ledgerRow({
			...rowInput(3),
			usage: {
				...rowInput(3).usage,
				tokens: {
					kind: "lower_bound",
					unit: "tokens",
					total: 5_900,
					reason: "request_unsettled",
				},
			},
		});

		assert.deepEqual(row.row.gaps, [
			"not_instrumented",
			"provider_not_reported",
			"receipt_missing",
			"request_unsettled",
		]);
		assert.equal(row.row.usage.money.kind, "unavailable");
		assert.equal(row.row.usage.tokens.total, 5_900);
		assert.doesNotMatch(row.bytes.toString(), /"micros"/);
	});

	it("refuses rows whose cross-field facts disagree", () => {
		const base = rowInput(4);
		const landed = landedInput(5);

		const cases: [string, LedgerRowInput][] = [
			["run_id_mismatch", { ...base, eventId: "101" }],
			[
				"issue_url_mismatch",
				{
					...base,
					evidence: {
						issueUrl: `https://github.com/${repo}/issues/5`,
						ciUrls: [],
					},
				},
			],
			["landing_incomplete", { ...landed, pr: null }],
			[
				"landing_unverified",
				{
					...landed,
					outcome: {
						kind: "landed",
						stage: "land",
						headSha: sha("e"),
						mergeSha: sha("d"),
						mergedAt: { kind: "known", value: "2026-11-04T12:00:00Z" },
						assurance: {
							kind: "factory_verified",
							generationDigest: digestOf("intent-5"),
						},
					},
				},
			],
			[
				"verification_cap_raised",
				{
					...base,
					provenance: {
						kind: "verification",
						policy:
							base.provenance.kind === "production"
								? base.provenance.policy
								: assert.fail("fixture"),
						verificationDigest: digestOf("manifest"),
						trustedRunTokenCap: 500_000,
						effectiveRunTokenCap: 500_001,
					},
				},
			],
			[
				"interrupted_mismatch",
				{ ...base, interruptedAttempts: { kind: "known", value: 2 } },
			],
			[
				"usage_parts_mismatch",
				{
					...base,
					usage: {
						...base.usage,
						childTokens: { kind: "known", value: 1 },
					},
				},
			],
			[
				"stages_unordered",
				{
					...base,
					stages: [
						{ ...(base.stages[0] ?? assert.fail()), stage: "build" },
						{ ...(base.stages[0] ?? assert.fail()), stage: "specify" },
					],
					usage: {
						...base.usage,
						tokens: { kind: "exact", unit: "tokens", total: 11_800 },
						parentTokens: { kind: "known", value: 11_800 },
					},
				},
			],
		];

		for (const [code, input] of cases)
			assert.throws(() => ledgerRow(input), new RegExp(code), code);
	});

	it("diagnoses each line and keeps its exact bytes", () => {
		const good = ledgerRow(rowInput(6));

		const lines = [
			good.bytes,
			Buffer.from('{"v":2,"future":true}\n'),
			Buffer.from("{not json\n"),
			Buffer.from(
				`${good.bytes.toString().slice(0, -1).replace('"v":1,', "")}\n`,
			),
			Buffer.from(` ${good.bytes.toString()}`),
			Buffer.from(
				good.bytes.toString().replace('"gaps":[', '"extra":1,"gaps":['),
			),
			Buffer.from('{"v":1,"v":1}\n'),
			Buffer.from([0xff, 0x0a]),
			good.bytes.subarray(0, -1),
		];

		const all = Buffer.concat(lines);
		const parsed = parseLedger(all);

		assert.deepEqual(
			parsed.map((line) =>
				line.kind === "corrupt" ? `corrupt:${line.code}` : line.kind,
			),
			[
				"known",
				"unknown_version",
				"corrupt:malformed_json",
				"corrupt:missing_version",
				"corrupt:noncanonical",
				"corrupt:unexpected_keys",
				"corrupt:malformed_json",
				"corrupt:invalid_utf8",
				"corrupt:missing_lf",
			],
		);
		assert.ok(Buffer.concat(parsed.map((line) => line.bytes)).equals(all));
	});

	it("indexes by parsed run ID, not by substring, and blocks on duplicates, corrupt or newer rows", () => {
		const first = ledgerRow(rowInput(7));
		const second = ledgerRow(rowInput(8));
		const index = indexLedger(parseLedger(first.bytes));
		assert.equal(index.kind, "indexed");
		assert.equal(
			index.kind === "indexed" && index.rows.has(second.row.runId),
			false,
		);

		const mentions = Buffer.from(`{"v":9,"note":"${second.row.runId}"}\n`);

		assert.deepEqual(indexLedger(parseLedger(mentions)), {
			kind: "blocked",
			reason: "ledger_version_unsupported",
			line: 1,
		});
		assert.deepEqual(
			indexLedger(parseLedger(Buffer.concat([first.bytes, first.bytes]))),
			{ kind: "blocked", reason: "row_conflict", line: 2 },
		);
		assert.deepEqual(indexLedger(parseLedger(Buffer.from("x\n"))), {
			kind: "blocked",
			reason: "ledger_corrupt",
			line: 1,
		});
	});

	it("parses, validates and indexes 1,000 varied rows in under one second", () => {
		const rows: Buffer[] = [];

		for (let issue = 1; issue <= 1_000; issue++) {
			const input = issue % 3 === 0 ? landedInput(issue) : rowInput(issue);

			const outcome: LedgerRowInput["outcome"] =
				issue % 3 === 1
					? {
							kind: "failed",
							stage: "accept",
							cause: { kind: "known", value: "base_refused" },
						}
					: input.outcome;

			rows.push(ledgerRow({ ...input, outcome }).bytes);
		}

		const bytes = Buffer.concat(rows);
		const started = performance.now();
		const index = indexLedger(parseLedger(bytes));
		const elapsed = performance.now() - started;

		assert.equal(index.kind === "indexed" && index.rows.size, 1_000);
		assert.ok(
			elapsed < 1_000,
			`1,000 rows took ${elapsed.toFixed(1)} ms (${bytes.length} bytes)`,
		);
	});
});

describe("ledger append protocol", () => {
	it("accepts the probe's empty commits and appends one row on top of them", async () => {
		const fake = new LedgerGit();
		const probeTip = await probeHistory(fake);
		const row = ledgerRow(rowInput(10));

		const result = await appendRun(
			ledgerApiOf(quietApi(fake)),
			pending(row),
			null,
		);

		assert.equal(result.kind, "published");
		const tip = fake.refs.get("factory/ledger") ?? assert.fail();
		assert.deepEqual(fake.commits.get(tip), [probeTip]);
		assert.ok((await remoteBytes(fake)).equals(row.bytes));
		assert.equal(result.kind === "published" && result.line, 1);
		assert.equal(
			result.kind === "published" && result.anchor.byteLength,
			row.bytes.length,
		);
	});

	it("creates the empty orphan root when the ref is absent, then appends", async () => {
		const fake = new LedgerGit();
		const row = ledgerRow(rowInput(11));

		const result = await appendRun(
			ledgerApiOf(quietApi(fake)),
			pending(row),
			null,
		);

		assert.equal(result.kind, "published");
		const tip = fake.refs.get("factory/ledger") ?? assert.fail();
		const [root] = fake.commits.get(tip) ?? [];
		assert.deepEqual(fake.commits.get(root ?? ""), []);
		assert.equal(result.kind === "published" && result.anchor.rootSha, root);
	});

	it("deduplicates an exact row and refuses a different row for the same run", async () => {
		const fake = new LedgerGit();
		const api = ledgerApiOf(quietApi(fake));
		const row = ledgerRow(rowInput(12));
		const first = await appendRun(api, pending(row), null);
		assert.equal(first.kind, "published");
		const writes = fake.writes.length;

		const again = await appendRun(
			api,
			pending(row),
			first.kind === "published" ? first.anchor : null,
		);

		assert.equal(again.kind, "published");
		assert.equal(fake.writes.length, writes);

		const changedRow = ledgerRow({
			...rowInput(12),
			terminalObservedAt: "2026-11-04T11:06:00Z",
		});

		const conflict = await appendRun(api, pending(changedRow), null);
		assert.equal(conflict.kind, "blocked");
		assert.equal(
			conflict.kind === "blocked" && conflict.reason,
			"row_conflict",
		);
		assert.equal(fake.writes.length, writes);
		assert.ok((await remoteBytes(fake)).equals(row.bytes));
	});

	it("serializes two endings and rebases over a remote advance without force", async () => {
		const fake = new LedgerGit();
		const api = ledgerApiOf(quietApi(fake));
		const first = ledgerRow(rowInput(13));
		const second = ledgerRow(rowInput(14));
		const third = ledgerRow(rowInput(15));
		const one = await appendRun(api, pending(first), null);
		assert.equal(one.kind, "published");
		let raced = false;

		const racing: LedgerApi = {
			...api,
			child: async (parent, bytes, when, message) => {
				if (!raced) {
					raced = true;
					const other = await appendRun(api, pending(third), null);
					assert.equal(other.kind, "published");
				}

				return api.child(parent, bytes, when, message);
			},
		};

		const two = await appendRun(
			racing,
			pending(second),
			one.kind === "published" ? one.anchor : null,
		);

		assert.equal(two.kind, "published");
		assert.ok(
			(await remoteBytes(fake)).equals(
				Buffer.concat([first.bytes, third.bytes, second.bytes]),
			),
		);
		const patches = fake.writes.filter((write) => write.method === "PATCH");
		assert.ok(patches.length >= 4);
		assert.ok(
			patches.every(
				(write) =>
					JSON.stringify(write.body).includes('"force":false') &&
					write.path === "git/refs/heads/factory/ledger",
			),
		);
		assert.equal(
			fake.requests.some((request) => request.startsWith("DELETE")),
			false,
		);
	});

	it("reconciles a ref PATCH whose response was lost, with no duplicate row", async () => {
		const fake = new LedgerGit();
		const api = ledgerApiOf(quietApi(fake));
		await appendRun(api, pending(ledgerRow(rowInput(16))), null);
		const row = ledgerRow(rowInput(17));

		fake.lose = (method) => (method === "PATCH" ? "after" : null);
		const lost = await appendRun(api, pending(row), null);
		fake.lose = null;
		assert.equal(lost.kind, "published");

		const again = await appendRun(api, pending(row), null);
		assert.equal(again.kind, "published");
		const bytes = await remoteBytes(fake);
		assert.equal(
			parseLedger(bytes).filter(
				(line) => line.kind === "known" && line.row.runId === row.row.runId,
			).length,
			1,
		);
	});

	it("survives a crash at every remote write boundary and converges to one row", async () => {
		const boundaries = [
			["POST", "git/blobs"],
			["POST", "git/trees"],
			["POST", "git/commits"],
			["PATCH", "git/refs/heads/factory/ledger"],
		] as const;

		for (const [method, path] of boundaries)
			for (const when of ["before", "after"] as const) {
				const fake = new LedgerGit();
				const api = ledgerApiOf(quietApi(fake));

				const seed = await appendRun(
					api,
					pending(ledgerRow(rowInput(18))),
					null,
				);

				assert.equal(seed.kind, "published");
				const row = ledgerRow(rowInput(19));
				fake.lose = (m, p) => (m === method && p === path ? when : null);

				const crashed = await appendRun(
					api,
					pending(row),
					seed.kind === "published" ? seed.anchor : null,
				).catch(() => null);

				fake.lose = null;
				assert.notEqual(crashed?.kind, "blocked", `${method} ${path} ${when}`);

				const recovered = await appendRun(
					api,
					pending(row),
					seed.kind === "published" ? seed.anchor : null,
				);

				assert.equal(recovered.kind, "published", `${method} ${path} ${when}`);

				const known = parseLedger(await remoteBytes(fake)).map((line) =>
					line.kind === "known" ? line.row.issue : 0,
				);

				assert.deepEqual(known, [18, 19], `${method} ${path} ${when}`);
			}
	});

	it("defers on transport failure and blocks on integrity failures, never writing", async () => {
		const fake = new LedgerGit();
		const api = ledgerApiOf(quietApi(fake));
		const seed = await appendRun(api, pending(ledgerRow(rowInput(20))), null);
		assert.equal(seed.kind, "published");
		const anchor = seed.kind === "published" ? seed.anchor : null;
		const row = ledgerRow(rowInput(21));

		fake.hook = (method) =>
			method === "GET" ? { code: 1, stdout: "", stderr: "HTTP 502" } : null;
		const outage = await appendRun(api, pending(row), anchor);
		fake.hook = null;
		assert.deepEqual(
			[outage.kind, outage.kind === "deferred" && outage.reason],
			["deferred", "transport_unavailable"],
		);

		const deleted = new LedgerGit();

		const missing = await appendRun(
			ledgerApiOf(quietApi(deleted)),
			pending(row),
			anchor,
		);

		assert.deepEqual(
			[missing.kind, missing.kind === "blocked" && missing.reason],
			["blocked", "ref_missing"],
		);
		assert.equal(deleted.writes.length, 0);

		const divergent = new LedgerGit();
		await appendRun(
			ledgerApiOf(quietApi(divergent)),
			pending(ledgerRow(rowInput(22))),
			null,
		);
		const writes = divergent.writes.length;

		const forked = await appendRun(
			ledgerApiOf(quietApi(divergent)),
			pending(row),
			anchor,
		);

		assert.deepEqual(
			[forked.kind, forked.kind === "blocked" && forked.reason],
			["blocked", "lineage_changed"],
		);
		assert.equal(divergent.writes.length, writes);
	});

	it("refuses a ledger whose root carries a source tree or whose rows are corrupt", async () => {
		const fake = new LedgerGit();
		const api = quietApi(fake);
		const root = await createLedgerRoot(api, date);
		await api.advanceLedger(null, root.sha);

		const corrupt = await createLedgerChild(
			api,
			root,
			Buffer.from("not json\n"),
			date,
			"x\n",
		);

		await api.advanceLedger(root.sha, corrupt.sha);
		const before = fake.writes.length;

		const blocked = await appendRun(
			ledgerApiOf(api),
			pending(ledgerRow(rowInput(23))),
			null,
		);

		assert.deepEqual(
			[blocked.kind, blocked.kind === "blocked" && blocked.reason],
			["blocked", "ledger_corrupt"],
		);
		assert.equal(fake.writes.length, before);
		assert.ok((await remoteBytes(fake)).equals(Buffer.from("not json\n")));

		const source = new LedgerGit();
		const sourceApi = quietApi(source);
		const sourceRoot = await createLedgerRoot(sourceApi, date);
		const tree = source.trees.get(sourceRoot.tree) ?? assert.fail();
		tree.set("package.json", tree.get(LEDGER_FILE) ?? "");
		await sourceApi.advanceLedger(null, sourceRoot.sha);

		const refused = await appendRun(
			ledgerApiOf(sourceApi),
			pending(ledgerRow(rowInput(24))),
			null,
		);

		assert.deepEqual(
			[refused.kind, refused.kind === "blocked" && refused.reason],
			["blocked", "lineage_changed"],
		);
	});
});
