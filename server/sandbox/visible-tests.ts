import { randomBytes } from "node:crypto";
import {
	trustedVisiblePlan,
	visibleEnvironment,
	checkBuildDisk,
	patchedTree,
	TEST_TAIL_BYTES,
	type VisibleTests,
} from "../../src/candidate/build.ts";
import { lstatSync, mkdirSync, rmSync } from "node:fs";
import { dirname, join } from "node:path";
import { digestOf } from "../../src/core/run.ts";
import { type GatewayHandle, startGatewayProcess } from "./gateway-client.ts";
import { builtinTable } from "./routes.ts";
import { stopScopeArgv } from "./scope.ts";
import { boundedText } from "./receipts.ts";
import { type SandboxHostConfig, freshDir, launchSandbox } from "./launch.ts";

export const VISIBLE_LIMIT_MS = 180_000;

const VISIBLE_WARN_MS = 150_000;

export function visibleBudget<T extends VisibleTests>(tests: T) {
	return tests.exitCode !== null &&
		tests.wallMs > VISIBLE_WARN_MS &&
		tests.wallMs < VISIBLE_LIMIT_MS
		? { ...tests, nearLimit: true }
		: tests;
}

export async function runVisibleTests(
	config: SandboxHostConfig,
	base: string,
	patch: string | Uint8Array,
	command: string,
	replacesTests: readonly { readonly path: string }[] = [],
): Promise<VisibleTests> {
	const start = Date.now();
	const dir = join(config.stateDir, "visible-tests", config.runId);
	mkdirSync(dir, { recursive: true, mode: 0o700 });
	const execution = freshDir(join(dir, "execution"));
	const workspace = join(execution, "tree");
	let gateway: GatewayHandle | null = null;
	let unit: string | null = null;
	let timer: ReturnType<typeof setTimeout> | null = null;
	let tail = Buffer.alloc(0);
	let timedOut = false;
	let environment: VisibleTests["environment"];

	try {
		await patchedTree(base, workspace, patch);
		command = trustedVisiblePlan(
			base,
			workspace,
			command,
			replacesTests,
		).command;
		environment = visibleEnvironment(
			workspace,
			digestOf(
				JSON.stringify({
					bundle: config.assetsDigest,
					arch: config.arch,
					versions: config.versions,
					runner: "visible-bwrap-v1",
				}),
			),
		);

		const table = builtinTable({
			platform: config.platform,
			stage: "build",
			runId: config.runId,
			attempt: config.attempt,
			model: "disabled",
			fallback: null,
			modelTokens: 0,
			modelRequests: 0,
		});

		mkdirSync(join(config.stateDir, "gw"), { recursive: true, mode: 0o700 });

		const started = await startGatewayProcess({
			gatewayDir: join(config.stateDir, "gw", randomBytes(4).toString("hex")),
			auditPath: join(execution, "egress.jsonl"),
			table: {
				...table,
				routes: table.routes
					.filter((route) => route.id === "npm")
					.map((route) => ({ ...route, budget: false })),
			},
			platform: config.platform,
			readyTimeoutMs: 10_000,
		});

		if (!started.ok) throw new Error("gateway_unavailable");
		gateway = started.handle;

		const launched = (config.launch ?? launchSandbox)({
			...config,
			workspace,
			tools: [],
			agentDir: join(execution, "agent"),
			socketPath: gateway.socketPath,
			command: [
				"/bin/bash",
				"-c",
				`set -o pipefail; export PATH="/workspace/node_modules/.bin:$PATH"; export npm_config_ignore_scripts=true; if [ -f package-lock.json ]; then npm ci --ignore-scripts --no-audit --no-fund || exit 125; fi; /bin/bash -o pipefail -c '${command.replaceAll("'", "'\\''")}'; code=$?; printf '%s\\n' "$code" > /run/pi-agent/visible-exit; exit "$code"`,
			],
		});

		if (launched === null) throw new Error("sandbox_unavailable");
		unit = launched.unit;

		const keep = (chunk: Buffer) => {
			tail = Buffer.concat([tail, chunk]).subarray(-TEST_TAIL_BYTES);
		};

		launched.child.stdout?.on("data", keep);
		launched.child.stderr?.on("data", keep);
		launched.child.stdin?.end();
		timer = setTimeout(() => {
			timedOut = true;

			if (unit !== null) {
				const [cmd, ...args] = stopScopeArgv(unit);
				void config.exec(cmd ?? "systemctl", args);
			}

			launched.child.kill("SIGKILL");
		}, VISIBLE_LIMIT_MS);

		const exitCode = await new Promise<number | null>((done) => {
			launched.child.once("close", done);
			launched.child.once("error", () => done(null));
		});

		if (timedOut) throw new Error("timeout");

		const resultPath = join(execution, "agent", "visible-exit");

		if (
			exitCode === null ||
			!lstatSync(resultPath).isFile() ||
			(await boundedText(resultPath, 4))?.trim() !== String(exitCode)
		)
			throw new Error("sandbox_unavailable");

		if (checkBuildDisk([workspace, join(execution, "agent")]) !== null)
			throw new Error("build_disk_limit");

		return visibleBudget({
			command,
			environment,
			exitCode,
			tail: tail.toString(),
			wallMs: Date.now() - start,
		});
	} catch (error) {
		const detail =
			error instanceof Error &&
			[
				"gateway_unavailable",
				"malformed_patch",
				"timeout",
				"build_disk_limit",
			].includes(error.message)
				? error.message
				: "sandbox_unavailable";

		return {
			command,
			environment,
			exitCode: null,
			reason: "visible_tests_unavailable",
			// SAFETY: only the fixed infrastructure reason allowlist above reaches this field.
			detail: detail as NonNullable<VisibleTests["detail"]>,
			tail: "Visible tests could not run",
			wallMs: Date.now() - start,
		};
	} finally {
		if (timer !== null) clearTimeout(timer);

		if (unit !== null) {
			const [cmd, ...args] = stopScopeArgv(unit);
			await config.exec(cmd ?? "systemctl", args);
		}

		await gateway?.shutdown();
		rmSync(workspace, { recursive: true, force: true });
		rmSync(join(execution, "agent"), { recursive: true, force: true });

		if (gateway !== null)
			rmSync(dirname(gateway.socketPath), { recursive: true, force: true });
	}
}
