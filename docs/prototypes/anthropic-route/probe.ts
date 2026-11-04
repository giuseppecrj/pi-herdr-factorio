import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import {
	existsSync,
	mkdirSync,
	mkdtempSync,
	readFileSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import {
	launchSandbox,
	locateBundle,
	SANDBOX_ROOT,
	STAGE_SYSTEM_PROMPT,
	withSkills,
} from "../../../server/sandbox.ts";
import { PI_AGENT_DIR } from "../../../server/sandbox/assets/pi.ts";
import {
	anthropicMaxOutput,
	isAnthropicModelId,
	parseAnthropicModel,
} from "../../../server/sandbox/anthropic-limits.ts";
import { JOURNAL_FILE, journalCharge } from "../../../server/sandbox/audit.ts";
import { BUNDLE } from "../../../server/sandbox/bwrap.ts";
import {
	countOf,
	fieldOf,
	type JsonObject,
	objectOf,
	parseJson,
	textOf,
} from "../../../server/sandbox/json.ts";
import { startGatewayProcess } from "../../../server/sandbox/gateway-client.ts";
import {
	builtinTable,
	FORWARDER_HOST,
} from "../../../server/sandbox/routes.ts";
import { stopScopeArgv } from "../../../server/sandbox/scope.ts";
import { detectArch } from "../../../server/sandbox/seccomp.ts";
import {
	ACCEPTANCE_MAX_TOKENS,
	ACCEPTANCE_SKILLS,
	ACCEPTANCE_TOOLS,
} from "../../../src/accept.ts";
import { isDigest } from "../../../src/run.ts";

// One metered accept-shaped call through the real gateway, on the VM host.
// Usage: node docs/prototypes/anthropic-route/probe.ts <out-dir> [anthropic/<model>]

const [outArg, modelArg = "anthropic/claude-sonnet-5-5"] =
	process.argv.slice(2);

assert.ok(
	outArg !== undefined,
	"usage: probe.ts <out-dir> [anthropic/<model>]",
);

const model = parseAnthropicModel(modelArg);

assert.ok(
	model !== null && modelArg.startsWith("anthropic/"),
	"model must be anthropic/<id> from server/sandbox/anthropic-limits.ts",
);

const out = resolve(outArg);

assert.ok(!existsSync(out), "out-dir must not exist yet");

const PI_TIMEOUT_MS = 180_000;

// The only prompt text the probe adds. The rest is the real accept stage's
// system prompt, tools and acceptance SKILL.md, so the input is the size a
// real accept stage sends before its contract.
const LINE =
	"This is a transport probe, not an accept run. Do not call any tool. Reply with the single word ok.";

const bundle = await locateBundle(SANDBOX_ROOT);
const arch = detectArch(process.arch);

assert.ok(bundle !== null && arch !== null, "no sandbox bundle or arch");

const providers = objectOf(
	fieldOf(
		objectOf(
			parseJson(
				readFileSync(join(bundle.dir, "pi-agent", "models.json"), "utf8"),
			),
		),
		"providers",
	),
);

assert.equal(
	textOf(fieldOf(objectOf(fieldOf(providers, "anthropic")), "baseUrl")),
	`http://${FORWARDER_HOST}/anthropic`,
	"the installed bundle has no anthropic provider: run bash server/provision.sh sandbox",
);

const runId = randomBytes(32).toString("hex");

assert.ok(isDigest(runId));

const prompt = await withSkills(bundle.dir, LINE, ACCEPTANCE_SKILLS);

assert.ok(prompt !== null, "acceptance skill missing from the bundle");

const stageDir = join(out, "stages", runId, "accept-1");
const workspace = join(out, "workspace");
const scratch = mkdtempSync(join(tmpdir(), "f10c-gw-"));

const runtime =
	process.env.XDG_RUNTIME_DIR ?? `/run/user/${process.getuid?.()}`;

mkdirSync(stageDir, { recursive: true, mode: 0o700 });

mkdirSync(workspace, { mode: 0o700 });

// One model request, as a real accept stage's ceiling would bound it: the
// gateway closes its own gate as it admits the first, so no second call
// leaves. Pi's max_tokens (the model card's 128000) is clamped to the
// accept cap.
const table = builtinTable({
	stage: "accept",
	runId,
	attempt: 1,
	provider: "anthropic",
	model,
	fallback: null,
	modelTokens: ACCEPTANCE_MAX_TOKENS,
	modelRequests: 1,
});

const started = await startGatewayProcess({
	gatewayDir: join(scratch, "gw"),
	auditPath: join(stageDir, "egress.jsonl"),
	table,
	readyTimeoutMs: 10_000,
});

assert.ok(started.ok, `gateway ${started.ok ? "" : started.reason}`);

const gateway = started.handle;
let unit: string | null = null;
let stdout = "";
let stderr = "";
let exit: number | null = null;
let timedOut = false;

try {
	const launched = launchSandbox({
		stateDir: out,
		bundleDir: bundle.dir,
		workspace,
		runId,
		stage: "accept",
		attempt: 1,
		tools: ACCEPTANCE_TOOLS,
		arch,
		xdgRuntimeDir: runtime,
		agentDir: join(stageDir, "agent-0"),
		socketPath: gateway.socketPath,
		command: [
			`${BUNDLE.bin}/pi`,
			"--print",
			"--no-skills",
			"--system-prompt",
			STAGE_SYSTEM_PROMPT,
			"--session-dir",
			`${PI_AGENT_DIR}/sessions`,
			"--thinking",
			"off",
			"--model",
			`anthropic/${model}`,
			prompt,
		],
	});

	assert.ok(launched !== null, "unsafe workspace");
	unit = launched.unit;

	const child = launched.child;

	child.stdout?.on("data", (chunk) => {
		stdout += chunk;
	});
	child.stderr?.on("data", (chunk) => {
		stderr += chunk;
	});
	child.stdin?.on("error", () => {});
	child.stdin?.end();

	exit = await new Promise<number | null>((done) => {
		const timer = setTimeout(() => {
			timedOut = true;
			child.kill("SIGKILL");
		}, PI_TIMEOUT_MS);

		child.on("close", (code) => {
			clearTimeout(timer);
			done(code);
		});
		child.on("error", () => {
			clearTimeout(timer);
			done(null);
		});
	});
} finally {
	if (unit !== null) {
		const [command, ...args] = stopScopeArgv(unit);

		try {
			execFileSync(command ?? "systemctl", args, {
				env: { ...process.env, XDG_RUNTIME_DIR: runtime },
				stdio: "ignore",
			});
		} catch {
			console.error("scope stop returned nonzero; verify no scope remains");
		}
	}
}

// The meter receipt: the gateway's per-route summary at shutdown.
const summary = await gateway.shutdown();

rmSync(scratch, { recursive: true, force: true });

rmSync(workspace, { recursive: true, force: true });

/** A JSONL file as objects. A line that does not parse, such as one cut short, is skipped. */
const lines = (name: string): JsonObject[] => {
	const path = join(stageDir, name);

	if (!existsSync(path)) return [];

	return readFileSync(path, "utf8")
		.split("\n")
		.flatMap((line) => {
			const record = objectOf(parseJson(line));

			return record === null ? [] : [record];
		});
};

const audit = lines("egress.jsonl");
const journal = lines(JOURNAL_FILE);

// Each routed request the gateway denied, with its reason. The gateway's own
// `GET /` readiness probe has no route, so it is left out.
const denied = audit
	.filter(
		(entry) =>
			fieldOf(entry, "decision") === "deny" && fieldOf(entry, "route") !== null,
	)
	.map((entry) => ({
		route: textOf(fieldOf(entry, "route")),
		path: textOf(fieldOf(entry, "path")),
		reason: textOf(fieldOf(entry, "reason")),
		bytesIn: countOf(fieldOf(entry, "bytesIn")),
	}));

const dispatches = journal.filter(
	(entry) => fieldOf(entry, "kind") === "dispatch",
);

const results = journal.filter((entry) => fieldOf(entry, "kind") === "result");
const result = results[0] ?? null;
const observedModel = textOf(fieldOf(result, "observedModel"));
const bound = countOf(fieldOf(dispatches[0] ?? null, "maxOutputTokens"));

const checks = {
	oneCall: dispatches.length === 1 && results.length === 1,
	status200:
		fieldOf(result, "status") === 200 &&
		fieldOf(result, "decision") === "forward",
	metered:
		countOf(fieldOf(result, "inputTokens")) !== null &&
		countOf(fieldOf(result, "outputTokens")) !== null,
	observedModelBare:
		observedModel !== null && isAnthropicModelId(observedModel),
	observedModelIsRequested: observedModel === model,
	boundAtMostModelMax:
		bound !== null && bound <= (anthropicMaxOutput(model) ?? 0),
	routeAnthropic: fieldOf(result, "route") === "model-anthropic",
	piExitZero: exit === 0 && !timedOut,
	noDenial: denied.length === 0,
};

const receipt = {
	v: 1,
	probe: "anthropic-route",
	date: `${new Date().toISOString().slice(0, 19)}Z`,
	controller: (() => {
		try {
			return execFileSync("git", ["rev-parse", "HEAD"], {
				encoding: "utf8",
			}).trim();
		} catch {
			return null;
		}
	})(),
	bundle: bundle.digest,
	runId,
	requested: `anthropic/${model}`,
	ceiling: table.ceiling,
	promptBytes: Buffer.byteLength(prompt),
	pi: {
		exit,
		timedOut,
		stdout: stdout.slice(0, 400),
		stdoutBytes: Buffer.byteLength(stdout),
		stderrTail: stderr.slice(-2000),
		stderrBytes: Buffer.byteLength(stderr),
	},
	denied,
	audit,
	journal,
	charge: journalCharge(
		journal.map((entry) => JSON.stringify(entry)).join("\n"),
	),
	summary,
	checks,
	pass: Object.values(checks).every((check) => check),
};

writeFileSync(
	join(out, "receipt.json"),
	`${JSON.stringify(receipt, null, "\t")}\n`,
	{
		mode: 0o644,
	},
);

process.stdout.write(`${JSON.stringify(receipt, null, 2)}\n`);

process.exitCode = receipt.pass ? 0 : 1;
