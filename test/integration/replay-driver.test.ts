import assert from "node:assert/strict";
import {
	spawn,
	spawnSync,
	execFileSync,
	type ChildProcess,
} from "node:child_process";
import {
	cp,
	mkdir,
	mkdtemp,
	readFile,
	readdir,
	readlink,
	realpath,
	rm,
	symlink,
	stat,
	writeFile,
} from "node:fs/promises";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { after, afterEach, before, beforeEach, describe, it } from "node:test";
import { acquireLock, procTable } from "../../server/controller/lock.ts";
import { manifestDigest } from "../../server/sandbox/manifest.ts";
import {
	readReplayBudget,
	replayRow,
	replayStageCaps,
} from "../../src/maintenance/replay.ts";
import { digestOf, runIdOf } from "../../src/core/run.ts";
import { ledgerRowOf } from "../../src/ledger/schema.ts";

// The reviewer's fake gh/serve + real socket-lock harness, made hermetic.
const script = ".pi/skills/verify-factory/scripts/drive-replay.sh";
let dir: string;
let control: string;
let root: string;
let lane: string;
let env: NodeJS.ProcessEnv;
let active: ChildProcess[];
let template: string;
let templateSha: string;

const git = (cwd: string, ...args: string[]) =>
	execFileSync("git", ["-C", cwd, ...args], {
		encoding: "utf8",
		stdio: ["ignore", "pipe", "pipe"],
	}).trim();

const pause = () => new Promise((r) => setTimeout(r, 50));

function drive(mode = "start", extra: string[] = []) {
	const child = spawn(
		"bash",
		[
			join(control, script),
			"F12a-replay-c3",
			"1",
			mode,
			...(mode === "start" ? ["900", ...extra] : extra),
		],
		{ env, stdio: ["ignore", "pipe", "pipe"], detached: true },
	);

	active.push(child);
	let text = "";
	child.stdout.on("data", (b) => {
		text += b;
	});
	child.stderr.on("data", (b) => {
		text += b;
	});

	const done = new Promise<{ code: number | null; text: string }>((r) =>
		child.on("close", (code) => r({ code, text })),
	);

	return { child, done, text: () => text };
}

async function ready(run: ReturnType<typeof drive>) {
	for (let i = 0; i < 200; i++) {
		if (run.text().includes("replay=ready")) return;

		if (run.child.exitCode !== null)
			assert.fail(
				`${run.text()}\n${await readFile(join(dir, "output/replay-check.json"), "utf8").catch(() => "no check output")}`,
			);
		await pause();
	}

	assert.fail(`readiness timeout: ${run.text()}`);
}

async function missingBudget() {
	await assert.rejects(readFile(join(root, "replay-budget.json")), /ENOENT/);
}

async function restored() {
	const log = await readFile(join(dir, "systemctl.log"), "utf8");
	assert.match(log, /stop factory.service hold=true/);
	assert.match(log, /start factory.service hold=false disarmed=true/);
	assert.ok(
		log.indexOf("stop factory.service") <
			log.lastIndexOf("start factory.service"),
	);
}

it("waits for two visible-test deadlines plus 60 seconds after signaling stop", async () => {
	const source = await readFile(script, "utf8");
	const stop = source.match(/stop_child\(\) \{[\s\S]*?\n\}/)?.[0];
	const step = source.match(/^replay_step\(\) \{.*\}$/m)?.[0] ?? "";
	assert.ok(stop);

	const sandbox = await readFile("server/sandbox.ts", "utf8");

	const limit = sandbox.match(
		/^export const VISIBLE_LIMIT_MS = ([\d_]+);$/m,
	)?.[1];

	assert.ok(limit, "server/sandbox.ts declares VISIBLE_LIMIT_MS");

	const polls = Math.ceil(
		((2 * Number(limit.replaceAll("_", ""))) / 1000 + 60) * 10,
	);

	const pidfile = join(await mkdtemp(join(tmpdir(), "stop-wait-")), "pid");

	try {
		await writeFile(pidfile, "123");

		const output = execFileSync(
			"bash",
			[
				"-c",
				`
set -euo pipefail
pidfile="$1"
control="$3"
polls=0
target="$2"
alive() { polls=$((polls + 1)); (( polls <= target )); }
owned() { return 0; }
kill() { [[ "$*" == "-TERM 123" ]]; }
sleep() { [[ "$1" == 0.1 ]]; }
${step}
${stop}
stop_child
printf '%s' "$polls"
`,
				"stop-wait",
				pidfile,
				String(polls),
				resolve("."),
			],
			{ encoding: "utf8" },
		);

		assert.equal(Number(output), polls + 1);
	} finally {
		await rm(join(pidfile, ".."), { recursive: true, force: true });
	}
});

it("refuses to signal or wait when the visible-test deadline is not declared", async () => {
	const source = await readFile(script, "utf8");
	const stop = source.match(/stop_child\(\) \{[\s\S]*?\n\}/)?.[0];
	const step = source.match(/^replay_step\(\) \{.*\}$/m)?.[0];
	assert.ok(stop && step);

	const fake = await mkdtemp(join(tmpdir(), "stop-undeclared-"));
	const steps = ".pi/skills/verify-factory/scripts/drive-replay.ts";

	try {
		await mkdir(join(fake, ".pi/skills/verify-factory/scripts"), {
			recursive: true,
		});
		await cp(steps, join(fake, steps));
		await mkdir(join(fake, "server"));
		await writeFile(
			join(fake, "server/sandbox.ts"),
			"export const VISIBLE_LIMIT = 300_000;\n",
		);
		await writeFile(join(fake, "pid"), "123");

		const result = spawnSync(
			"bash",
			[
				"-c",
				`
set -euo pipefail
pidfile="$1/pid"
control="$1"
polls=0
alive() { polls=$((polls + 1)); (( polls <= 5 )); }
owned() { return 0; }
kill() { echo "signaled $*"; }
sleep() { :; }
${step}
${stop}
if stop_child; then echo "stopped after $polls"; else echo "refused after $polls"; fi
`,
				"stop-undeclared",
				fake,
			],
			{ encoding: "utf8" },
		);

		assert.equal(result.stdout, "refused after 1\n");
		assert.match(result.stderr, /visible-test deadline not found/);
	} finally {
		await rm(fake, { recursive: true, force: true });
	}
});

it("keeps the production hold unless the stopped fixture's labels are well formed", async () => {
	const steps = ".pi/skills/verify-factory/scripts/drive-replay.ts";
	const fake = await mkdtemp(join(tmpdir(), "stopped-fixture-"));
	const path = join(fake, "stopped-fixture.json");

	const disarmed = async (labels: string) => {
		await writeFile(path, `{"labels":${labels}}`);

		return spawnSync(process.execPath, [steps, "fixture-disarmed", path], {
			encoding: "utf8",
		}).status;
	};

	try {
		assert.equal(await disarmed("[]"), 0);
		assert.equal(await disarmed('[{"name":"factory:enabled"}]'), 0);

		for (const labels of [
			"null",
			"{}",
			'[{"name":"factory:ready"}]',
			"[null]",
			'["factory:ready"]',
			"[{}]",
			'[{"name":1}]',
			'[{"name":"factory:enabled"},7]',
		])
			assert.notEqual(await disarmed(labels), 0, labels);
	} finally {
		await rm(fake, { recursive: true, force: true });
	}
});

it("signals only a live serve process for this lane's state directory", async () => {
	const source = await readFile(script, "utf8");
	const alive = source.match(/^alive\(\) \{.*\}$/m)?.[0];
	const owned = source.match(/^owned\(\) \{\n[\s\S]*?\n\}\n/m)?.[0];
	const step = source.match(/^replay_step\(\) \{.*\}$/m)?.[0] ?? "";
	assert.ok(alive && owned);

	const lane = await mkdtemp(join(tmpdir(), "owned-lane-"));
	const state = join(lane, "state");
	const children: ChildProcess[] = [];

	const start = (...args: string[]) => {
		const child = spawn(
			process.execPath,
			["-e", "setInterval(() => {}, 1000)", ...args],
			{ stdio: "ignore" },
		);

		children.push(child);
		assert.ok(child.pid);

		return child.pid;
	};

	const verdict = (pid: number) =>
		execFileSync(
			"bash",
			[
				"-c",
				`
set -euo pipefail
lane="$1"
control="$2"
${step}
${alive}
${owned}
if alive "$3" && owned "$3"; then echo owned; else echo foreign; fi
`,
				"owned",
				lane,
				resolve("."),
				String(pid),
			],
			{ encoding: "utf8" },
		).trim();

	try {
		const serve = start("server/cli.ts", "serve", "--state-dir", state);
		const other = start("server/cli.ts", "serve", "--state-dir", `${state}2`);
		const tick = start("server/cli.ts", "tick", "--state-dir", state);
		const bare = start("serve", "--state-dir", state);
		const dangling = start("server/cli.ts", "serve", "--state-dir");
		await new Promise((r) => setTimeout(r, 100));

		assert.equal(verdict(serve), "owned");

		for (const pid of [other, tick, bare, dangling])
			assert.equal(verdict(pid), "foreign", String(pid));

		const gone = children[0];
		assert.ok(gone);
		gone.kill("SIGKILL");
		await new Promise((r) => gone.on("close", r));
		assert.equal(verdict(serve), "foreign");
	} finally {
		for (const child of children) child.kill("SIGKILL");
		await rm(lane, { recursive: true, force: true });
	}
});

describe("replay driver with fake GitHub/controller and real guards", {
	concurrency: false,
}, () => {
	before(async () => {
		template = await mkdtemp(join(tmpdir(), "replay-driver-template-"));
		control = join(template, "control");
		await mkdir(control);

		for (const path of [
			"src",
			"server",
			"skills",
			"package.json",
			"README.md",
			"docs/decisions.tsv",
			".github/factory",
			"test/fixtures/replay",
			script,
			".pi/skills/verify-factory/scripts/drive-replay.ts",
			".pi/skills/verify-factory/scripts/lane-id.sh",
		]) {
			const target = join(control, path);
			await mkdir(join(target, ".."), { recursive: true });
			await cp(resolve(path), target, { recursive: true });
		}

		git(control, "init", "-q");
		await symlink(resolve("node_modules"), join(control, "node_modules"));
		git(control, "config", "user.email", "fixture@example.invalid");
		git(control, "config", "user.name", "Local fixture");
		git(control, "add", ".");
		git(
			control,
			"-c",
			"core.hooksPath=/dev/null",
			"commit",
			"-qm",
			"local factory baseline",
		);
		const baseline = git(control, "rev-parse", "HEAD");
		const manifest = join(control, "test/fixtures/replay/corpus.json");
		const corpus = JSON.parse(await readFile(manifest, "utf8"));

		for (const c of corpus.cases) if (c.liveReplayable) c.baseSha = baseline;
		corpus.digest = digestOf(JSON.stringify({ v: 1, cases: corpus.cases }));
		await writeFile(manifest, JSON.stringify(corpus));
		const decisions = join(control, "docs/decisions.tsv");
		await writeFile(
			decisions,
			`${await readFile(decisions, "utf8")}\n2026-11-08T00:00:00Z\tlocal-test-grant\tOwner grants local fake replay fixture, model spend, production stop and bundle selection\tlocal tests only\tfixture\tnone\n`,
		);
		git(control, "add", ".");
		git(
			control,
			"commit",
			"--no-verify",
			"--allow-empty",
			"-qm",
			"local trusted replay fixture",
		);
		templateSha = git(control, "rev-parse", "HEAD");
		git(control, "update-ref", "refs/remotes/origin/main", templateSha);
	});

	after(async () => {
		await rm(template, { recursive: true, force: true });
	});

	beforeEach(async () => {
		dir = await mkdtemp(join(tmpdir(), "replay-driver-"));
		control = join(dir, "control");
		root = join(dir, "root");
		lane = join(root, "F12a-replay-c3-w1");
		active = [];
		await cp(join(template, "control"), control, { recursive: true });
		const sha = templateSha;

		await mkdir(join(lane, "state"), { recursive: true });
		await mkdir(join(lane, "ws/server"), { recursive: true });
		await mkdir(join(dir, "home/factory-state"), { recursive: true });
		await mkdir(join(dir, "home/.local/bin"), { recursive: true });
		await mkdir(join(dir, "runtime"), { mode: 0o700 });
		await writeFile(join(lane, "head-sha"), `${sha}\n`);
		await writeFile(
			join(lane, "ws/server/cli.ts"),
			`import { writeFileSync, mkdirSync } from 'node:fs';
const state = process.argv[process.argv.indexOf('--state-dir') + 1];
writeFileSync(process.env.FAKE_ARGS, JSON.stringify(process.argv.slice(2)));
writeFileSync(process.env.FAKE_UMASK, String(process.umask()));
if (process.env.FAKE_STAGE) { mkdirSync(state + '/stages/run/specify-1', {recursive:true}); writeFileSync(state + '/stages/run/specify-1/usage.json', '{"total":1}'); }
process.stderr.write('event=controller_ready pid=' + process.pid + ' \\n');
process.on('SIGINT', () => {});
process.on('SIGTERM', () => { writeFileSync(process.env.FAKE_TERM_SEEN, 'yes'); setTimeout(() => process.exit(0), Number(process.env.FAKE_TERM_WAIT ?? 0)); });
if (process.env.FAKE_EXIT) setTimeout(() => process.exit(7), 100);
setInterval(() => {}, 1000);
`,
		);
		const bin = join(dir, "home/.local/bin");
		await writeFile(
			join(bin, "gh"),
			`#!/usr/bin/env bash
case "$*" in
  *"commits/main"*) echo "$FAKE_MAIN";;
  *"issue edit"*) [[ -n "\${FAKE_DISARM_FAIL:-}" ]] && exit 1; touch "$FAKE_DISARMED";;
  *"issue view"*) if [[ -e "$FAKE_DISARMED" ]]; then node -e 'const x=JSON.parse(process.env.FAKE_ISSUE);x.labels=[];console.log(JSON.stringify(x))'; else printf '%s\\n' "$FAKE_ISSUE"; fi;;
  *) echo "unexpected gh $*" >&2; exit 9;;
esac
`,
			{ mode: 0o755 },
		);
		await writeFile(join(bin, "sudo"), '#!/usr/bin/env bash\nexec "$@"\n', {
			mode: 0o755,
		});
		await writeFile(
			join(bin, "systemctl"),
			`#!/usr/bin/env bash
[[ "$*" == *"--user"* ]] && exit 0
[[ -e "$HOME/factory-state/disabled" ]] && hold=true || hold=false
[[ -e "$FAKE_DISARMED" ]] && disarmed=true || disarmed=false
echo "$* hold=$hold disarmed=$disarmed" >> "$FAKE_SYSTEMCTL_LOG"
case "$1" in
  show) [[ "$*" == "show factory.service --property=UMask --value" ]] || exit 9; [[ "$FAKE_UNIT_UMASK" == unavailable ]] && exit 1; printf '%s\\n' "$FAKE_UNIT_UMASK";;
  is-active) [[ -e "$FAKE_SERVICE" ]] && { echo active; exit 0; }; echo inactive; exit 3;;
  stop) rm -f "$FAKE_SERVICE";;
  start) touch "$FAKE_SERVICE";;
esac
`,
			{ mode: 0o755 },
		);
		await writeFile(
			join(bin, "bwrap"),
			'#!/usr/bin/env bash\n[[ -n "${FAKE_PREFLIGHT_FAIL:-}" ]] && exit 1\necho "bubblewrap 0.11.0"\n',
			{ mode: 0o755 },
		);
		await writeFile(join(bin, "systemd-run"), "#!/usr/bin/env bash\nexit 0\n", {
			mode: 0o755,
		});
		await writeFile(join(dir, "service"), "active");
		const bundle = join(dir, "bundle");
		await mkdir(join(bundle, "sandbox"), { recursive: true });
		await mkdir(join(bundle, "pkg"), { recursive: true });
		await mkdir(join(bundle, "skills"));

		for (const skill of await readdir(join(control, "skills"), {
			withFileTypes: true,
		}))
			if (skill.isDirectory())
				await cp(
					join(control, "skills", skill.name),
					join(bundle, "skills", skill.name),
					{ recursive: true },
				);

		for (const [from, to] of [
			["pi.ts", "sandbox/pi.ts"],
			["stage-init.ts", "sandbox/stage-init.ts"],
			["package.json", "pkg/package.json"],
			["package-lock.json", "pkg/package-lock.json"],
		])
			if (from !== undefined && to !== undefined)
				await cp(
					join(control, "server/sandbox/assets", from),
					join(bundle, to),
				);
		const digest = await manifestDigest(bundle);
		assert.ok(digest);
		await mkdir(join(dir, "sandbox"));
		await cp(bundle, join(dir, "sandbox", `assets-${digest}`), {
			recursive: true,
		});
		await mkdir(join(dir, "sandbox", `assets-${"e".repeat(64)}`));
		await symlink(`assets-${"e".repeat(64)}`, join(dir, "sandbox/current"));

		const body = await readFile(
			join(control, "test/fixtures/replay/cases/c3/issue.md"),
			"utf8",
		);

		env = {
			...process.env,
			GH_HOST: "github.int.exe.invalid",
			HOME: join(dir, "home"),
			XDG_RUNTIME_DIR: join(dir, "runtime"),
			DBUS_SESSION_BUS_ADDRESS: `unix:path=${join(dir, "runtime/bus")}`,
			REPLAY_ROOT: root,
			REPLAY_OUTPUT_ROOT: join(dir, "output"),
			FIXTURE_GRANT: "local-test-grant",
			REPLAY_CONTROL_CHECKOUT: control,
			REPLAY_CASE: "c3",
			REPLAY_SIDE: "previous",
			REPLAY_MAIN_SHA: sha,
			REPLAY_PREVIOUS_SHA: sha,
			REPLAY_CANDIDATE_SHA: sha,
			REPLAY_PREVIOUS_ASSETS: digest,
			REPLAY_CANDIDATE_ASSETS: digest,
			REPLAY_SANDBOX_ROOT: join(dir, "sandbox"),
			FAKE_MAIN: sha,
			FAKE_SERVICE: join(dir, "service"),
			FAKE_DISARMED: join(dir, "disarmed"),
			FAKE_ARGS: join(dir, "args.json"),
			FAKE_UMASK: join(dir, "serve-umask"),
			FAKE_UNIT_UMASK: "0022",
			FAKE_TERM_SEEN: join(dir, "term-seen"),
			FAKE_SYSTEMCTL_LOG: join(dir, "systemctl.log"),
			FAKE_ISSUE: JSON.stringify({
				title: `[F12a-replay-c3] ${body.split("\n")[0]?.slice(2)}`,
				body,
				state: "OPEN",
				labels: [{ name: "factory:ready" }],
				comments: [],
			}),
		};
	});

	afterEach(async () => {
		for (const child of active)
			if (child.exitCode === null && child.signalCode === null)
				child.kill("SIGTERM");
		await Promise.all(
			active.map((child) =>
				child.exitCode !== null || child.signalCode !== null
					? undefined
					: new Promise((r) => child.on("close", r)),
			),
		);

		const pid = Number(
			await readFile(join(lane, "serve.pid"), "utf8").catch(() => "0"),
		);

		if (pid > 0) {
			try {
				process.kill(pid, "SIGTERM");
			} catch (error) {
				if (
					!(error instanceof Error) ||
					!("code" in error) ||
					error.code !== "ESRCH"
				)
					throw error;
			}
		}

		await rm(dir, { recursive: true, force: true });
	});

	it("rejects missing grants before any launch", async () => {
		delete env.FIXTURE_GRANT;
		assert.notEqual((await drive().done).code, 0);
		await missingBudget();
	});

	it("verifies the control HEAD", async () => {
		env.REPLAY_MAIN_SHA = "a".repeat(40);
		const result = await drive().done;
		assert.notEqual(result.code, 0);
		assert.match(result.text, /control checkout.*pin/);
		await missingBudget();
	});

	it("allows only explicit, logged bootstrap-candidate control code", async () => {
		env.REPLAY_MAIN_SHA = git(control, "rev-parse", "HEAD^");
		env.FAKE_MAIN = env.REPLAY_MAIN_SHA;
		const denied = await drive().done;
		assert.notEqual(denied.code, 0);
		await missingBudget();
		const run = drive("start", ["--bootstrap-candidate"]);
		await ready(run);
		assert.match(run.text(), /bootstrap=true/);
		assert.equal((await drive("stop", ["--bootstrap-candidate"]).done).code, 0);
		assert.equal((await run.done).code, 0);

		const record = JSON.parse(
			await readFile(join(lane, "replay.json"), "utf8"),
		);

		assert.equal(record.bootstrap, true);
		assert.equal(record.controlSha, env.REPLAY_CANDIDATE_SHA);
		await restored();
	});

	it("refuses unknown grants and dirty trusted code", async () => {
		env.FIXTURE_GRANT = "not-an-owner-decision";
		assert.match((await drive().done).text, /not a recorded owner decision/);
		await missingBudget();
		env.FIXTURE_GRANT = "local-test-grant";
		await writeFile(join(control, "src/maintenance/replay.ts"), "tampered");
		assert.match((await drive().done).text, /dirty/);
		await missingBudget();
	});

	it("rejects a held production socket and restores service after refusal", async () => {
		const lock = await acquireLock({
			stateDir: join(dir, "home/factory-state"),
			procs: procTable(),
			now: Date.now,
		});

		assert.ok(lock.kind === "acquired");

		try {
			const result = await drive().done;
			assert.notEqual(result.code, 0);
			await missingBudget();
			await restored();
		} finally {
			await lock.lock.release();
		}
	});

	it("pins titles identically on both sides and rejects foreign markers in fresh state", async () => {
		const issue = JSON.parse(env.FAKE_ISSUE ?? "{}");
		env.FAKE_ISSUE = JSON.stringify({
			...issue,
			title: `${issue.title}-previous`,
		});
		assert.notEqual((await drive().done).code, 0);
		await missingBudget();
		env.FAKE_ISSUE = JSON.stringify({
			...issue,
			comments: [{ body: '<!-- factory:run {"status":"running"} -->' }],
		});
		const reused = await drive().done;
		assert.notEqual(reused.code, 0);
		assert.match(reused.text, /fresh fixture issue/);
		await missingBudget();
	});

	it("refuses missing/stale bundles and failed preflight before reserving", async () => {
		await writeFile(
			join(
				dir,
				"sandbox",
				`assets-${env.REPLAY_PREVIOUS_ASSETS}`,
				"sandbox/pi.ts",
			),
			"stale",
		);
		assert.notEqual((await drive().done).code, 0);
		await missingBudget();
	});

	it("refuses a missing runtime directory before reserving and restores production", async () => {
		env.XDG_RUNTIME_DIR = join(dir, "absent-runtime");
		const result = await drive().done;
		assert.notEqual(result.code, 0);
		assert.match(result.text, /runtime_directory/);
		await missingBudget();
		await restored();
	});

	it("refuses an unusable sandbox before reserving and restores production", async () => {
		env.FAKE_PREFLIGHT_FAIL = "1";
		const result = await drive().done;
		assert.notEqual(result.code, 0);
		assert.match(result.text, /preflight/);
		await missingBudget();
		await restored();
	});

	it("supervises an isolated scoped controller, voids a zero-stage stop, and restores production", async () => {
		const run = drive();
		await ready(run);
		const args = JSON.parse(await readFile(join(dir, "args.json"), "utf8"));
		assert.ok(args.includes("--issue") && args.includes("900"));
		assert.ok(
			args.includes("--verification-token-cap") && args.includes("540000"),
		);
		assert.equal(
			run.child.exitCode,
			null,
			"the supervisor must not restore production while replay runs",
		);
		assert.equal((await drive("stop").done).code, 0);
		assert.equal((await run.done).code, 0);
		const budget = await readReplayBudget(join(root, "replay-budget.json"));
		assert.equal(budget.chargedTokens, 0);
		assert.equal(budget.reservations[0]?.status, "voided");
		await restored();

		const record = JSON.parse(
			await readFile(join(lane, "replay.json"), "utf8"),
		);

		assert.equal(record.caseId, "c3");
		assert.equal(record.side, "prev");
		assert.equal(record.issue, 900);
	});

	it("prepares the restore journal, preflight, replay record and reservation before serve", async () => {
		const run = drive();
		await ready(run);
		const sha = git(control, "rev-parse", "HEAD");
		const real = await realpath(control);

		const corpus = JSON.parse(
			await readFile(join(control, "test/fixtures/replay/corpus.json"), "utf8"),
		);

		const c3 = corpus.cases.find((c: { id: string }) => c.id === "c3");

		const stageCaps = await replayStageCaps(sha, async (cmd, args) => {
			const result = spawnSync(cmd, args, { cwd: control, encoding: "utf8" });

			return {
				code: result.status ?? 1,
				stdout: result.stdout,
				stderr: result.stderr,
			};
		});

		assert.deepEqual(
			JSON.parse(await readFile(join(root, "replay-restore.json"), "utf8")),
			{
				v: 1,
				oldBundle: `assets-${"e".repeat(64)}`,
				serviceState: "active",
				hadHold: false,
				issue: 900,
				fixtureLabel: "factory:ready",
				lane,
				production: join(dir, "home/factory-state"),
				sandbox: join(dir, "sandbox"),
				out: join(dir, "output"),
				pr: "F12a-replay-c3",
				n: "1",
				trusted: sha,
				bootstrap: false,
				control: real,
				mainSha: sha,
				grant: "local-test-grant",
				root,
			},
		);

		assert.equal((await stat(join(lane, "preflight"))).mode & 0o777, 0o700);

		assert.deepEqual(
			JSON.parse(await readFile(join(lane, "replay.json"), "utf8")),
			{
				v: 1,
				caseId: "c3",
				corpusDigest: corpus.digest,
				issueDigest: c3.issueDigest,
				side: "prev",
				issue: 900,
				headSha: sha,
				mainSha: sha,
				terminalMainSha: null,
				runId: null,
				stageCaps,
				controlSha: sha,
				bootstrap: false,
				grant: "local-test-grant",
				status: "prepared",
			},
		);

		const budget = await readReplayBudget(join(root, "replay-budget.json"));
		assert.equal(budget.reservations.length, 1);

		assert.partialDeepStrictEqual(budget.reservations[0], {
			key: join(lane, "state"),
			status: "reserved",
		});

		assert.match(
			await readFile(join(dir, "output/replay-check.json"), "utf8"),
			/\S/,
		);
		assert.equal((await drive("stop").done).code, 0);
		assert.equal((await run.done).code, 0);
		await restored();
	});

	for (const [unitMask, expected] of [
		["0022", 0o022],
		["0027", 0o027],
		["", 0o022],
		["unavailable", 0o022],
	] as const)
		it(`uses the production unit umask for serve, keeping driver files private (${unitMask || "empty"})`, async () => {
			env.FAKE_UNIT_UMASK = unitMask;
			const run = drive();
			await ready(run);
			assert.equal(
				Number(await readFile(join(dir, "serve-umask"), "utf8")),
				expected,
			);

			for (const path of [
				join(root, "replay-restore.json"),
				join(root, "replay-budget.json"),
				join(lane, "replay.json"),
				join(dir, "output/serve.log"),
				join(dir, "output/replay-check.json"),
			])
				assert.equal((await stat(path)).mode & 0o777, 0o600, path);

			assert.equal((await drive("stop").done).code, 0);
			assert.equal((await run.done).code, 0);
			assert.equal(
				(await stat(join(dir, "output/disarm.log"))).mode & 0o777,
				0o600,
			);
			await restored();
		});

	it("voids a terminal zero-stage, exact-zero-usage run too", async () => {
		const run = drive();
		await ready(run);

		const fixture = (
			await readFile("test/fixtures/metrics/runs-2026-11-08.jsonl", "utf8")
		).split("\n")[0];

		assert.ok(fixture);
		const row = JSON.parse(fixture);
		const manifest = '{"fixture":true}\n';
		row.issue = 900;
		row.runId = runIdOf(row);
		row.evidence.issueUrl = `https://github.com/${row.repo}/issues/900`;
		row.provenance.verificationDigest = digestOf(manifest);
		row.usage.tokens = { kind: "exact", unit: "tokens", total: 0 };
		row.usage.parentTokens = { kind: "known", value: 0 };
		row.stages = { kind: "known", value: [] };
		row.interruptedAttempts = { kind: "known", value: 0 };
		const bytes = ledgerRowOf(row).bytes;
		replayRow(bytes);
		await mkdir(join(lane, "state/ledger", row.runId), { recursive: true });
		await writeFile(join(lane, "state/ledger", row.runId, "row.json"), bytes);
		await writeFile(join(lane, "state/verification.json"), manifest);
		assert.equal((await drive("stop").done).code, 0);
		assert.equal((await run.done).code, 0);
		assert.equal(
			(await readReplayBudget(join(root, "replay-budget.json"))).reservations[0]
				?.status,
			"voided",
		);
		await restored();
	});

	it("retains charges after any stage/usage and restores on a signal", async () => {
		env.FAKE_STAGE = "1";
		const run = drive();
		await ready(run);
		run.child.kill("SIGTERM");
		assert.notEqual((await run.done).code, 0);
		assert.equal(
			(await readReplayBudget(join(root, "replay-budget.json"))).chargedTokens,
			540000,
		);
		await restored();
	});

	it("ignores a second terminal Ctrl-C while restoring", async () => {
		env.FAKE_TERM_WAIT = "1500";
		const run = drive();
		await ready(run);
		assert.ok(run.child.pid);
		process.kill(-run.child.pid, "SIGINT");

		for (let i = 0; i < 100; i++) {
			if (
				await readFile(join(dir, "term-seen")).then(
					() => true,
					() => false,
				)
			)
				break;
			await pause();
		}

		assert.equal(await readFile(join(dir, "term-seen"), "utf8"), "yes");
		process.kill(-run.child.pid, "SIGINT");
		await run.done;
		await restored();
		await assert.rejects(readFile(join(root, "replay-restore.json")), /ENOENT/);
	});

	it("detects a mid-restore SIGKILL on the next run and recovers via stop", async () => {
		env.FAKE_STAGE = "1";
		env.FAKE_TERM_WAIT = "1500";
		const run = drive();
		await ready(run);
		const path = join(root, "replay-restore.json");
		run.child.kill("SIGTERM");

		for (let i = 0; i < 100; i++) {
			if (
				await readFile(join(dir, "term-seen")).then(
					() => true,
					() => false,
				)
			)
				break;
			await pause();
		}

		assert.equal(await readFile(join(dir, "term-seen"), "utf8"), "yes");
		run.child.kill("SIGKILL");
		await run.done;
		const journal = JSON.parse(await readFile(path, "utf8"));
		assert.equal(journal.oldBundle, `assets-${"e".repeat(64)}`);
		assert.equal(journal.serviceState, "active");
		assert.equal(journal.hadHold, false);
		assert.equal(journal.issue, 900);
		assert.equal(journal.fixtureLabel, "factory:ready");
		const next = await drive().done;
		assert.notEqual(next.code, 0);
		assert.match(next.text, /WARNING.*unfinished production restoration/);
		assert.match(next.text, /'F12a-replay-c3' '1' stop/);
		assert.equal((await drive("stop").done).code, 0);
		await restored();
		assert.equal(
			await readlink(join(dir, "sandbox/current")),
			journal.oldBundle,
		);
		await assert.rejects(readFile(path), /ENOENT/);
		assert.equal(
			(await readReplayBudget(join(root, "replay-budget.json"))).chargedTokens,
			540000,
		);
	});

	it("retains recovery evidence on a disarm failure and warns while held", async () => {
		env.FAKE_DISARM_FAIL = "1";
		const run = drive();
		await ready(run);
		run.child.kill("SIGTERM");
		assert.notEqual((await run.done).code, 0);
		assert.ok(await readFile(join(root, "replay-restore.json")));
		const failed = await drive("stop").done;
		assert.notEqual(failed.code, 0);
		assert.match(failed.text, /WARNING.*production.*hold/);
		delete env.FAKE_DISARM_FAIL;
		assert.equal((await drive("stop").done).code, 0);
		await restored();
	});

	it("preserves an original hold and inactive service and warns on stop", async () => {
		await rm(join(dir, "service"));
		await writeFile(join(dir, "home/factory-state/disabled"), "owner hold");
		const run = drive();
		await ready(run);
		const stopped = await drive("stop").done;
		assert.equal(stopped.code, 0);
		assert.match(stopped.text, /WARNING.*production.*hold/);
		await run.done;
		assert.equal(
			await readFile(join(dir, "home/factory-state/disabled"), "utf8"),
			"owner hold",
		);
		await assert.rejects(readFile(join(dir, "service")), /ENOENT/);
	});

	it("restores production on controller failure", async () => {
		env.FAKE_EXIT = "1";
		const result = await drive().done;
		assert.notEqual(result.code, 0);
		await restored();
	});

	it("does not signal an unrelated reused PID", async () => {
		const unrelated = spawn(
			process.execPath,
			["-e", "setInterval(() => {}, 1000)"],
			{ stdio: "ignore" },
		);

		active.push(unrelated);
		await writeFile(join(lane, "serve.pid"), String(unrelated.pid));
		const result = await drive("stop").done;
		assert.notEqual(result.code, 0);
		assert.match(result.text, /not this lane/);
		assert.equal(unrelated.exitCode, null);
	});

	it("keeps PID metadata after failed settlement so stop can retry", async () => {
		const run = drive();
		await ready(run);
		const path = join(root, "replay-budget.json");
		const budget = await readFile(path);
		await writeFile(path, "corrupt");
		assert.notEqual((await drive("stop").done).code, 0);
		await run.done;
		assert.ok((await readFile(join(lane, "serve.pid"), "utf8")).trim());
		await writeFile(path, budget);
		assert.equal((await drive("stop").done).code, 0);
		await assert.rejects(readFile(join(lane, "serve.pid")), /ENOENT/);
		await restored();
	});
});
