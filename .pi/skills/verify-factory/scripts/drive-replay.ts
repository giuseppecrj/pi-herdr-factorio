import { execFile, execFileSync, spawnSync } from "node:child_process";
import {
	mkdir,
	open,
	readdir,
	readFile,
	rename,
	stat,
	writeFile,
} from "node:fs/promises";
import { dirname, join } from "node:path";
import { promisify } from "node:util";

// drive-replay.sh runs each step from its trusted control checkout, which is
// also the working directory, so relative state paths resolve there.
const [command = "", ...args] = process.argv.slice(2);

function arg(at: number): string {
	const value = args[at];

	if (value === undefined)
		throw Error(`${command}: missing argument ${at + 1}`);

	return value;
}

function isMissing(error: NodeJS.ErrnoException): boolean {
	return error.code === "ENOENT" || error.code === "ESRCH";
}

async function entries(dir: string): Promise<string[]> {
	return readdir(dir).catch((error: NodeJS.ErrnoException) => {
		if (isMissing(error)) return [];
		throw error;
	});
}

function platformProfile() {
	return import("../../../../src/platform.ts").then(
		async ({ readPlatformFile, resolvePlatform }) => {
			const platform = await resolvePlatform({
				env: (name) => process.env[name],
				readFile: () => readPlatformFile(),
			});

			if (!platform.ok)
				throw Error(`platform_invalid reason=${platform.reason}`);

			return platform.profile;
		},
	);
}

// Reads exact argv, not a substring, because a recorded PID may be reused.
async function owned(): Promise<void> {
	const [pid, state] = [arg(0), arg(1)];

	try {
		const argv = (await readFile(`/proc/${pid}/cmdline`, "utf8")).split("\0");
		const at = argv.indexOf("--state-dir");

		process.exit(
			argv.includes("server/cli.ts") &&
				argv.includes("serve") &&
				at >= 0 &&
				argv[at + 1] === state
				? 0
				: 1,
		);
	} catch {
		process.exit(1);
	}
}

async function visibleLimit(): Promise<void> {
	const limit = (await readFile(arg(0), "utf8")).match(
		/^export const VISIBLE_LIMIT_MS = ([\d_]+);$/m,
	)?.[1];

	if (limit === undefined) throw Error("visible-test deadline not found");
	console.log(Number(limit.replaceAll("_", "")));
}

async function productionFree(): Promise<void> {
	const { readLock } = await import("../../../../server/controller.ts");
	const state = arg(0);
	const lock = await readLock(state);
	console.log(`production=${lock.kind}`);

	if (!["none", "holder_file_without_socket"].includes(lock.kind))
		throw Error("production_controller_running");

	for (const name of await readdir("/proc")) {
		if (!/^\d+$/.test(name)) continue;
		let argv: string[];

		try {
			if ((await stat(`/proc/${name}`)).uid !== process.getuid?.()) continue;
			argv = (await readFile(`/proc/${name}/cmdline`, "utf8")).split("\0");
		} catch (error) {
			if (error instanceof Error && isMissing(error)) continue;
			throw error;
		}

		if (
			argv.includes("serve") &&
			argv.includes("--state-dir") &&
			argv[argv.indexOf("--state-dir") + 1] === state
		)
			throw Error("production_controller_process_remains");
	}
}

async function settle(): Promise<void> {
	const [
		{ readReplayBudget, readReplayRecord, replayRow, settleReplay, voidReplay },
		{ readDurableAccounting },
		{ digestOf },
		{ isRepoSlug },
		{ objectOf, parseJson },
	] = await Promise.all([
		import("../../../../src/replay.ts"),
		import("../../../../server/controller.ts"),
		import("../../../../src/core/run.ts"),
		import("../../../../src/platform.ts"),
		import("../../../../src/core/json.ts"),
	]);

	const [budget, state, path, log, terminal] = [
		arg(0),
		arg(1),
		arg(2),
		arg(3),
		arg(4),
	];

	const text = await readFile(path, "utf8");
	const record = readReplayRecord(text);
	const raw = objectOf(parseJson(text));

	if (raw === null) throw Error("replay_record_invalid");
	const repo = "nublai/pi-herdr-factorio";

	if (!isRepoSlug(repo)) throw Error("replay_repository_invalid");

	const rows = (await entries(join(state, "ledger"))).filter((name) =>
		/^[a-f0-9]{64}$/.test(name),
	);

	const accounting = await readDurableAccounting(state, repo);
	const stageDirs = await entries(join(state, "stages"));

	const serveLog = await readFile(log, "utf8").catch(
		(error: NodeJS.ErrnoException) => {
			if (isMissing(error)) return "";
			throw error;
		},
	);

	const reservation = (await readReplayBudget(budget)).reservations.find(
		(r) => r.key === state,
	);

	let status: string = reservation?.status ?? "not_reserved";
	let reason = "terminal_accounting_unavailable";
	let runId = record.runId;
	const only = rows.length === 1 ? rows[0] : undefined;

	const row =
		only === undefined
			? null
			: replayRow(await readFile(join(state, "ledger", only, "row.json")));

	if (row !== null) {
		const manifest = await readFile(join(state, "verification.json"), "utf8");

		if (
			row.provenance.kind !== "verification" ||
			row.provenance.verificationDigest !== digestOf(manifest) ||
			row.issue !== record.issue
		)
			throw Error("replay_manifest_mismatch");
		runId = row.runId;
	}

	const zeroRow =
		row === null ||
		(row.usage.tokens.kind === "exact" &&
			row.usage.tokens.total === 0 &&
			row.stages.kind === "known" &&
			row.stages.value.length === 0);

	if (
		reservation !== undefined &&
		rows.length <= 1 &&
		zeroRow &&
		stageDirs.length === 0 &&
		!serveLog.includes("event=stage_launched") &&
		accounting.state === "readable" &&
		accounting.runs.every(
			(r) => r.executions === 0 && r.tokens.total === 0 && r.readable,
		)
	) {
		reason = "no_stage_executed_zero_usage";
		await voidReplay(
			budget,
			state,
			{ stages: 0, tokens: 0, complete: true },
			reason,
		);
		status = "voided";
	} else if (row !== null) {
		await settleReplay(budget, state, row);
		status = "settled";
		reason = row.outcome.kind;
	}

	const next = {
		...raw,
		runId,
		terminalMainSha: /^[a-f0-9]{40}$/.test(terminal) ? terminal : null,
		status,
		reason,
	};

	await writeFile(`${path}.tmp`, `${JSON.stringify(next, null, 2)}\n`, {
		mode: 0o600,
	});
	await rename(`${path}.tmp`, path);
	console.log(`replay=${status} reason=${reason}`);
}

async function restoreRecord(): Promise<JsonObject> {
	const { objectOf, parseJson } = await import("../../../../src/core/json.ts");

	const record = objectOf(parseJson(await readFile(arg(0), "utf8")));

	if (record === null) throw Error("restore_record_mismatch");

	return record;
}

type JsonObject = import("../../../../src/core/json.ts").JsonObject;

const quote = (value: string) => `'${value.replaceAll("'", "'\\''")}'`;

async function recoveryCommand(): Promise<void> {
	const { fieldOf, objectOf, parseJson } = await import(
		"../../../../src/core/json.ts"
	);

	const parsed = parseJson(await readFile(arg(0), "utf8"));

	if (parsed === undefined) throw Error("restore_record_unreadable");
	const r = objectOf(parsed);
	const text = (key: string) => String(fieldOf(r, key));

	const vars = {
		FIXTURE_GRANT: text("grant"),
		REPLAY_CONTROL_CHECKOUT: text("control"),
		REPLAY_MAIN_SHA: text("mainSha"),
		REPLAY_CANDIDATE_SHA: text("trusted"),
		REPLAY_ROOT: text("root"),
		REPLAY_SANDBOX_ROOT: text("sandbox"),
		REPLAY_OUTPUT_ROOT: text("out"),
	};

	const driver = `${text("control")}/.pi/skills/verify-factory/scripts/drive-replay.sh`;

	console.error(
		`Keep the hold in place. Run: ${Object.entries(vars)
			.map(([k, v]) => `${k}=${quote(v)}`)
			.join(
				" ",
			)} bash ${quote(driver)} ${quote(text("pr"))} ${quote(text("n"))} stop${fieldOf(r, "bootstrap") ? " --bootstrap-candidate" : ""}`,
	);
}

async function restoreFields(): Promise<void> {
	const { boolOf, fieldOf, textOf } = await import(
		"../../../../src/core/json.ts"
	);

	const [lane, production, sandbox] = [arg(1), arg(2), arg(3)];
	const r = await restoreRecord();
	const oldBundle = textOf(fieldOf(r, "oldBundle"));
	const serviceState = textOf(fieldOf(r, "serviceState"));
	const hadHold = boolOf(fieldOf(r, "hadHold"));
	const issue = fieldOf(r, "issue");
	const out = textOf(fieldOf(r, "out"));

	if (
		fieldOf(r, "v") !== 1 ||
		fieldOf(r, "lane") !== lane ||
		fieldOf(r, "production") !== production ||
		fieldOf(r, "sandbox") !== sandbox ||
		oldBundle === null ||
		!/^assets-[a-f0-9]{64}$/.test(oldBundle) ||
		serviceState === null ||
		!["active", "inactive", "failed"].includes(serviceState) ||
		hadHold === null ||
		!Number.isSafeInteger(issue) ||
		Number(issue) < 1 ||
		fieldOf(r, "fixtureLabel") !== "factory:ready" ||
		out === null ||
		out.includes("\n")
	)
		throw Error("restore_record_mismatch");

	console.log(
		[oldBundle, serviceState, hadHold, String(issue), out].join("\n"),
	);
}

async function fixtureDisarmed(): Promise<void> {
	const { arrayOf, fieldOf, objectOf, parseJson, textOf } = await import(
		"../../../../src/core/json.ts"
	);

	const issue = objectOf(parseJson(await readFile(arg(0), "utf8")));

	const names = arrayOf(fieldOf(issue, "labels"))?.map((l) =>
		textOf(fieldOf(objectOf(l), "name")),
	);

	if (
		names === undefined ||
		names.some((name) => name === null || name === "factory:ready")
	)
		throw Error("fixture_still_ready");
}

async function fixtureReady(): Promise<void> {
	const [
		{ loadReplayCorpus, REPLAY_CORPUS },
		{ arrayOf, fieldOf, objectOf, parseJson, textOf },
	] = await Promise.all([
		import("../../../../src/replay.ts"),
		import("../../../../src/core/json.ts"),
	]);

	const [path, id] = [arg(0), arg(1)];

	const c = (await loadReplayCorpus(REPLAY_CORPUS)).cases.find(
		(item) => item.id === id,
	);

	const issue = objectOf(parseJson(await readFile(path, "utf8")));
	const labels = arrayOf(fieldOf(issue, "labels")) ?? [];

	if (!c || fieldOf(issue, "title") !== c.title)
		throw Error("not_the_pinned_fixture_title");

	if (
		fieldOf(issue, "body") !==
		(await readFile(`${REPLAY_CORPUS}/cases/${id}/issue.md`, "utf8"))
	)
		throw Error("fixture_body_mismatch");

	if (
		fieldOf(issue, "state") !== "OPEN" ||
		!labels.some((l) => fieldOf(objectOf(l), "name") === "factory:ready")
	)
		throw Error("fixture_not_ready");

	const bodies = (arrayOf(fieldOf(issue, "comments")) ?? [null]).map(
		(comment) => textOf(fieldOf(objectOf(comment), "body")),
	);

	if (bodies.some((body) => body === null))
		throw Error("fixture_comments_unreadable");

	if (bodies.some((body) => body?.includes("<!-- factory:run")))
		throw Error("use a fresh fixture issue; prior controller marker exists");
}

// Synced before any hold, stop or bundle change, and kept until recovery completes.
async function journal(): Promise<void> {
	const [
		path,
		oldBundle,
		serviceState,
		hadHold,
		issue,
		lane,
		production,
		sandbox,
		out,
		pr,
		n,
		trusted,
		bootstrap,
	] = args;

	if (path === undefined || bootstrap === undefined)
		throw Error("journal: missing arguments");

	const r = {
		v: 1,
		oldBundle,
		serviceState,
		hadHold: hadHold === "true",
		issue: Number(issue),
		fixtureLabel: "factory:ready",
		lane,
		production,
		sandbox,
		out,
		pr,
		n,
		trusted,
		bootstrap: bootstrap === "true",
		control: process.cwd(),
		mainSha: process.env.REPLAY_MAIN_SHA,
		grant: process.env.FIXTURE_GRANT,
		root: dirname(path),
	};

	const file = await open(`${path}.tmp`, "w", 0o600);

	try {
		await file.writeFile(`${JSON.stringify(r, null, 2)}\n`);
		await file.sync();
	} finally {
		await file.close();
	}

	await rename(`${path}.tmp`, path);
	const dir = await open(dirname(path), "r");

	try {
		await dir.sync();
	} finally {
		await dir.close();
	}
}

// Preflight executes trusted-main code, not either factory's implementation.
async function preflight(): Promise<void> {
	const { sandboxExecutor } = await import("../../../../server/sandbox.ts");
	const profile = await platformProfile();
	const run = promisify(execFile);
	const [stateDir, root] = [arg(0), arg(1)];
	await mkdir(stateDir, { recursive: true, mode: 0o700 });

	const exec = async (cmd: string, cmdArgs: readonly string[]) => {
		try {
			const r = await run(cmd, [...cmdArgs]);

			return { code: 0, ...r };
		} catch (error) {
			const output = error instanceof Error ? error : {};

			return {
				code: 1,
				stdout: "stdout" in output ? String(output.stdout ?? "") : "",
				stderr: "stderr" in output ? String(output.stderr ?? "") : "",
			};
		}
	};

	const xdgRuntimeDir = process.env.XDG_RUNTIME_DIR;

	if (!xdgRuntimeDir)
		throw Error("XDG_RUNTIME_DIR must be set for replay preflight");

	const executor = sandboxExecutor({
		stateDir,
		root,
		exec,
		xdgRuntimeDir,
		platform: profile,
		log: (event, data) => console.log(event, JSON.stringify(data)),
	});

	if (!(await executor.preflight())) throw Error("replay_preflight_failed");
}

async function prepare(): Promise<void> {
	const [
		{ parseWorkflow },
		{ soleRepository },
		{ loadReplayCorpus, reserveReplay, replayStageCaps, REPLAY_CORPUS },
	] = await Promise.all([
		import("../../../../src/workflow.ts"),
		import("../../../../src/platform.ts"),
		import("../../../../src/replay.ts"),
	]);

	const [path, key, record, headSha, controlSha, bootstrap, issue] = [
		arg(0),
		arg(1),
		arg(2),
		arg(3),
		arg(4),
		arg(5),
		arg(6),
	];

	const mainSha = process.env.REPLAY_MAIN_SHA;
	const profile = await platformProfile();
	const repo = soleRepository(profile);

	if (repo === null) throw Error("replay_repository_ambiguous");

	const text = execFileSync(
		"git",
		["show", `${mainSha}:.github/factory/WORKFLOW.md`],
		{ encoding: "utf8" },
	);

	const parsed = parseWorkflow({
		text,
		repo,
		env: (name) => process.env[name],
		platform: profile,
	});

	if (parsed.kind !== "valid" || parsed.config.replay == null)
		throw Error("replay_disabled");
	const corpus = await loadReplayCorpus(REPLAY_CORPUS);
	const c = corpus.cases.find((item) => item.id === process.env.REPLAY_CASE);

	if (!c) throw Error("replay_case_unknown");

	const stageCaps = await replayStageCaps(headSha, async (cmd, cmdArgs) => {
		const result = spawnSync(cmd, [...cmdArgs], { encoding: "utf8" });

		return {
			code: result.status ?? 1,
			stdout: result.stdout,
			stderr: result.stderr,
		};
	});

	await writeFile(
		record,
		`${JSON.stringify(
			{
				v: 1,
				caseId: c.id,
				corpusDigest: corpus.digest,
				issueDigest: c.issueDigest,
				side: process.env.REPLAY_SIDE === "previous" ? "prev" : "cand",
				issue: Number(issue),
				headSha,
				mainSha,
				terminalMainSha: null,
				runId: null,
				stageCaps,
				controlSha,
				bootstrap: bootstrap === "true",
				grant: process.env.FIXTURE_GRANT,
				status: "prepared",
			},
			null,
			2,
		)}\n`,
		{ mode: 0o600, flag: "wx" },
	);
	await reserveReplay(path, parsed.config.replay.maxTokens, key, profile);
}

const commands = {
	owned,
	"visible-limit": visibleLimit,
	"production-free": productionFree,
	settle,
	"recovery-command": recoveryCommand,
	"restore-fields": restoreFields,
	"fixture-disarmed": fixtureDisarmed,
	"fixture-ready": fixtureReady,
	journal,
	preflight,
	prepare,
};

const run = Object.entries(commands).find(([name]) => name === command)?.[1];

if (run === undefined) {
	console.error(
		`usage: drive-replay.ts ${Object.keys(commands).join("|")} <args>`,
	);
	process.exit(2);
}

await run();
