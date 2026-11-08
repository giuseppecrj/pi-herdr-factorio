import assert from "node:assert/strict";
import { spawn, execFileSync, type ChildProcess } from "node:child_process";
import {
	cp,
	mkdir,
	mkdtemp,
	readFile,
	rm,
	symlink,
	writeFile,
} from "node:fs/promises";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, beforeEach, describe, it } from "node:test";
import { acquireLock, procTable } from "../server/controller.ts";
import { manifestDigest } from "../server/sandbox/manifest.ts";
import { readReplayBudget } from "../src/replay.ts";

// The reviewer's fake gh/serve + real socket-lock harness, made hermetic.
const script = ".pi/skills/verify-factory/scripts/drive-replay.sh";
let dir: string;
let control: string;
let root: string;
let lane: string;
let env: NodeJS.ProcessEnv;
let active: ChildProcess[];
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
			...(mode === "start" ? ["900", ...extra] : []),
		],
		{ env, stdio: ["ignore", "pipe", "pipe"] },
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

		if (run.child.exitCode !== null) assert.fail(run.text());
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
	assert.match(log, /start factory.service hold=false/);
	assert.ok(
		log.indexOf("stop factory.service") <
			log.lastIndexOf("start factory.service"),
	);
}

describe("replay driver with fake GitHub/controller and real guards", {
	concurrency: false,
}, () => {
	beforeEach(async () => {
		dir = await mkdtemp(join(tmpdir(), "replay-driver-"));
		control = join(dir, "control");
		root = join(dir, "root");
		lane = join(root, "F12a-replay-c3-w1");
		active = [];
		execFileSync("git", [
			"clone",
			"--shared",
			"--quiet",
			"--no-hardlinks",
			process.cwd(),
			control,
		]);

		for (const path of [
			script,
			"src/replay.ts",
			"server/cli.ts",
			"test/fixtures/replay/corpus.json",
		])
			await cp(resolve(path), join(control, path));
		await symlink(resolve("node_modules"), join(control, "node_modules"));
		git(control, "config", "user.email", "fixture@example.invalid");
		git(control, "config", "user.name", "Local fixture");
		git(control, "add", ".");
		git(
			control,
			"commit",
			"--no-verify",
			"--allow-empty",
			"-qm",
			"local trusted replay fixture",
		);
		const sha = git(control, "rev-parse", "HEAD");
		git(control, "update-ref", "refs/remotes/origin/main", sha);
		await mkdir(join(lane, "state"), { recursive: true });
		await mkdir(join(lane, "ws/server"), { recursive: true });
		await mkdir(join(dir, "home/factory-state"), { recursive: true });
		await mkdir(join(dir, "home/.local/bin"), { recursive: true });
		await writeFile(join(lane, "head-sha"), `${sha}\n`);
		await writeFile(
			join(lane, "ws/server/cli.ts"),
			`import { writeFileSync, mkdirSync } from 'node:fs';
const state = process.argv[process.argv.indexOf('--state-dir') + 1];
writeFileSync(process.env.FAKE_ARGS, JSON.stringify(process.argv.slice(2)));
if (process.env.FAKE_STAGE) { mkdirSync(state + '/stages/run/specify-1', {recursive:true}); writeFileSync(state + '/stages/run/specify-1/usage.json', '{"total":1}'); }
process.stderr.write('event=controller_ready pid=' + process.pid + ' \\n');
process.on('SIGTERM', () => process.exit(0));
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
  *"issue view"*) printf '%s\\n' "$FAKE_ISSUE";;
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
echo "$* hold=$hold" >> "$FAKE_SYSTEMCTL_LOG"
case "$1" in
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
		await cp(join(control, "skills"), join(bundle, "skills"), {
			recursive: true,
		});

		for (const [from, to] of [
			["pi.ts", "sandbox/pi.ts"],
			["stage-init.ts", "sandbox/stage-init.ts"],
			["package.json", "pkg/package.json"],
			["package-lock.json", "pkg/package-lock.json"],
		])
			await cp(join(control, "server/sandbox/assets", from), join(bundle, to));
		const digest = await manifestDigest(bundle);
		assert.ok(digest);
		await mkdir(join(dir, "sandbox"));
		await cp(bundle, join(dir, "sandbox", `assets-${digest}`), {
			recursive: true,
		});
		await symlink(`assets-${digest}`, join(dir, "sandbox/current"));
		const body = await readFile(
			join(control, "test/fixtures/replay/cases/c3/issue.md"),
			"utf8",
		);
		env = {
			...process.env,
			HOME: join(dir, "home"),
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
			FAKE_ARGS: join(dir, "args.json"),
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
			if (child.exitCode === null) child.kill("SIGTERM");
		await Promise.all(
			active.map((child) =>
				child.exitCode !== null
					? undefined
					: new Promise((r) => child.on("close", r)),
			),
		);
		await rm(dir, { recursive: true, force: true });
	});

	it("rejects missing grants before any launch", async () => {
		delete env.FIXTURE_GRANT;
		assert.notEqual((await drive().done).code, 0);
		await missingBudget();
	});

	it("verifies the control HEAD; bootstrap is explicit and logged", async () => {
		env.REPLAY_MAIN_SHA = "a".repeat(40);
		const result = await drive().done;
		assert.notEqual(result.code, 0);
		assert.match(result.text, /control checkout.*pin/);
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
		await writeFile(join(dir, "sandbox/current/sandbox/pi.ts"), "stale");
		assert.notEqual((await drive().done).code, 0);
		await missingBudget();
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

	it("restores production on controller failure", async () => {
		env.FAKE_EXIT = "1";
		const result = await drive().done;
		assert.notEqual(result.code, 0);
		await restored();
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
