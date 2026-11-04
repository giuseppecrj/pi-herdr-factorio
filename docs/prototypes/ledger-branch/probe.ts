import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { ghFailure, type Exec } from "../../../src/gh.ts";
import {
	GitHubPublicationApi,
	LEDGER_FILE,
	PublicationError,
	createLedgerChild,
	createLedgerRoot,
	readLedgerCommit,
	readLedgerFile,
	type LedgerCommit,
} from "../../../src/publication.ts";
import { isRepoSlug } from "../../../src/workflow.ts";
import {
	fieldOf,
	objectOf,
	parseJson,
	textOf,
} from "../../../server/sandbox/json.ts";

const [repoArg, outArg] = process.argv.slice(2);

assert.ok(
	repoArg !== undefined && outArg !== undefined && isRepoSlug(repoArg),
	"usage: probe.ts <owner/repo> <receipt.json>",
);

const repo = repoArg;
const out = resolve(outArg);
const ledgerRef = "refs/heads/factory/ledger";

type Call = {
	method: string;
	path: string;
	code: number;
	status: number | null;
	cause: string | null;
	ms: number;
	dropped: boolean;
	refused: string | null;
};

type Summary = {
	sha: string;
	tree: string;
	parents: readonly string[];
};

type Advance = { kind: string; tip: string | null };

type Receipt = {
	v: 1;
	probe: "ledger-branch";
	repo: string;
	ref: string;
	date: string;
	controller: string | null;
	root?: {
		created: boolean;
		observedTip: string | null;
		commit: Summary;
		blob: string;
		paths: readonly string[];
		bytes: number;
		historyLength: number;
	};
	siblings?: {
		base: string;
		a: Summary;
		b: Summary;
		toA: Advance;
		toB: Advance;
		bPatchStatus: number | null;
		refAfterB: string | null;
	};
	lostResponse?: {
		c: Summary;
		realPatchCode: number | null;
		responseDropped: boolean;
		reconciled: Advance;
		d: Summary;
		advanced: Advance;
		finalTip: string | null;
		finalHistoryLength: number;
		finalBlob: string;
	};
	ok?: boolean;
	error?: string;
	calls?: Call[];
	deletes?: number;
	refusedByGuard?: number;
};

const calls: Call[] = [];
let dropNextPatch = false;

const run: Exec = (command, args) =>
	new Promise((done) =>
		execFile(
			command,
			[...args],
			{ encoding: "utf8", timeout: 30_000, maxBuffer: 16 * 1024 * 1024 },
			(error, stdout, stderr) =>
				done({ code: error === null ? 0 : 1, stdout, stderr }),
		),
	);

function refusal(method: string, path: string, body: string | null) {
	if (method === "DELETE") return "delete";

	if (body !== null && fieldOf(objectOf(parseJson(body)), "force") === true)
		return "force";

	if (method === "PATCH" && path !== "git/refs/heads/factory/ledger")
		return "foreign_ref";

	if (
		method === "POST" &&
		path === "git/refs" &&
		textOf(fieldOf(objectOf(parseJson(body ?? "")), "ref")) !== ledgerRef
	)
		return "foreign_ref";

	if (
		method === "POST" &&
		!["git/refs", "git/blobs", "git/trees", "git/commits"].includes(path)
	)
		return "foreign_write";

	return null;
}

const exec: Exec = async (command, args) => {
	const method = args[args.indexOf("--method") + 1] ?? "GET";

	const path =
		args
			.find((arg) => arg.startsWith(`repos/${repo}/`))
			?.slice(`repos/${repo}/`.length) ?? "";

	const input = args.includes("--input")
		? args[args.indexOf("--input") + 1]
		: undefined;

	const body = input === undefined ? null : readFileSync(input, "utf8");
	const refused = command === "gh" ? refusal(method, path, body) : "command";

	if (refused !== null) {
		calls.push({
			method,
			path,
			code: 1,
			status: null,
			cause: null,
			ms: 0,
			dropped: false,
			refused,
		});

		return { code: 1, stdout: "", stderr: "probe guard" };
	}

	const started = performance.now();
	const result = await run(command, args);
	const failure = result.code === 0 ? null : ghFailure(result);
	const dropped = dropNextPatch && method === "PATCH";

	if (dropped) dropNextPatch = false;
	calls.push({
		method,
		path,
		code: result.code,
		status: failure?.status ?? null,
		cause: failure?.cause ?? null,
		ms: Math.round(performance.now() - started),
		dropped,
		refused: null,
	});

	return dropped ? { code: 1, stdout: "", stderr: "connection reset" } : result;
};

const api = new GitHubPublicationApi(exec, repo);
const date = `${new Date().toISOString().slice(0, 19)}Z`;

const receipt: Receipt = {
	v: 1,
	probe: "ledger-branch",
	repo,
	ref: ledgerRef,
	date,
	controller: await run("git", ["rev-parse", "HEAD"]).then((r) =>
		r.code === 0 ? r.stdout.trim() : null,
	),
};

const message = (name: string) =>
	`factory: ledger probe ${name}\n\nFactory-Probe: ledger-branch\n`;

const summary = (commit: LedgerCommit) => ({
	sha: commit.sha,
	tree: commit.tree,
	parents: commit.parents,
});

async function history(tip: LedgerCommit) {
	const chain = [tip];

	for (let head = tip; head.parents.length > 0; ) {
		assert.equal(head.parents.length, 1, "ledger history must be linear");
		assert.ok(chain.length < 1000, "ledger history too long for the probe");
		const parent = head.parents[0];
		assert.ok(parent !== undefined);
		head = await readLedgerCommit(api, parent);
		chain.push(head);
	}

	return chain;
}

try {
	const observed = await api.ledgerRef();
	let tip = observed;

	if (tip === null) {
		const root = await createLedgerRoot(api, date);
		const created = await api.advanceLedger(null, root.sha);
		assert.deepEqual(created, { kind: "advanced", tip: root.sha });
		tip = root.sha;
	}

	const chain = await history(await readLedgerCommit(api, tip));
	const root = chain.at(-1);
	assert.ok(root !== undefined);
	assert.deepEqual(root.parents, []);
	const rootFile = await readLedgerFile(api, root.tree);
	assert.deepEqual(rootFile.paths, ["ledger", LEDGER_FILE]);
	assert.equal(rootFile.bytes.length, 0);
	assert.equal(await api.ledgerRef(), tip);
	receipt.root = {
		created: observed === null,
		observedTip: observed,
		commit: summary(root),
		blob: rootFile.blob,
		paths: rootFile.paths,
		bytes: rootFile.bytes.length,
		historyLength: chain.length,
	};

	const head = chain[0];
	assert.ok(head !== undefined);
	const headFile = await readLedgerFile(api, head.tree);

	const a = await createLedgerChild(
		api,
		head,
		headFile.bytes,
		date,
		message("A"),
	);

	const b = await createLedgerChild(
		api,
		head,
		headFile.bytes,
		date,
		message("B"),
	);

	assert.notEqual(a.sha, b.sha);
	assert.equal(a.tree, head.tree);
	assert.equal(b.tree, head.tree);
	const toA = await api.advanceLedger(head.sha, a.sha);
	assert.deepEqual(toA, { kind: "advanced", tip: a.sha });
	const bCalls = calls.length;
	const toB = await api.advanceLedger(head.sha, b.sha);
	const bPatch = calls.slice(bCalls).find((call) => call.method === "PATCH");
	assert.deepEqual(toB, { kind: "conflict", tip: a.sha });
	assert.equal(bPatch?.code, 1);
	const afterB = await api.ledgerRef();
	assert.equal(afterB, a.sha);
	receipt.siblings = {
		base: head.sha,
		a: summary(a),
		b: summary(b),
		toA,
		toB,
		bPatchStatus: bPatch?.status ?? null,
		refAfterB: afterB,
	};

	const readA = await readLedgerCommit(api, a.sha);
	assert.deepEqual(readA, a);

	const c = await createLedgerChild(
		api,
		readA,
		headFile.bytes,
		date,
		message("C"),
	);

	dropNextPatch = true;
	const cCalls = calls.length;
	const toC = await api.advanceLedger(a.sha, c.sha);
	const cPatch = calls.slice(cCalls).find((call) => call.method === "PATCH");
	assert.equal(cPatch?.dropped, true);
	assert.equal(cPatch?.code, 0);
	assert.deepEqual(toC, { kind: "advanced", tip: c.sha });
	const d = await createLedgerChild(api, c, headFile.bytes, date, message("D"));
	const toD = await api.advanceLedger(c.sha, d.sha);
	assert.deepEqual(toD, { kind: "advanced", tip: d.sha });
	const finalTip = await api.ledgerRef();
	assert.equal(finalTip, d.sha);
	const finalChain = await history(await readLedgerCommit(api, d.sha));

	assert.deepEqual(
		finalChain.slice(0, 4).map((commit) => commit.sha),
		[d.sha, c.sha, a.sha, head.sha],
	);
	assert.equal(finalChain.at(-1)?.sha, root.sha);
	const finalFile = await readLedgerFile(api, d.tree);
	assert.deepEqual(finalFile.bytes, headFile.bytes);
	receipt.lostResponse = {
		c: summary(c),
		realPatchCode: cPatch?.code ?? null,
		responseDropped: cPatch?.dropped ?? false,
		reconciled: toC,
		d: summary(d),
		advanced: toD,
		finalTip,
		finalHistoryLength: finalChain.length,
		finalBlob: finalFile.blob,
	};
	receipt.ok = true;
} catch (error) {
	receipt.ok = false;

	receipt.error =
		error instanceof PublicationError
			? error.reason
			: error instanceof assert.AssertionError
				? `assertion: ${error.message.split("\n")[0]}`
				: "unexpected";
	process.exitCode = 1;
}

receipt.calls = calls;

receipt.deletes = calls.filter((call) => call.method === "DELETE").length;

receipt.refusedByGuard = calls.filter((call) => call.refused !== null).length;

writeFileSync(out, `${JSON.stringify(receipt, null, "\t")}\n`, { mode: 0o644 });

process.stdout.write(`${JSON.stringify({ ok: receipt.ok, receipt: out })}\n`);
