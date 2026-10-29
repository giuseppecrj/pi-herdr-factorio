import { type ChildProcess, spawn } from "node:child_process";
import type { Exec } from "../../src/gh.ts";

export type ScopeLimits = {
	readonly memoryMax: string;
	readonly tasksMax: number;
	readonly cpuQuota: string;
	readonly timeoutStopSec: number;
};

/** Starting values for a two-vCPU, 8 GB VM running two stages. Lane 10 measures them. */
export const DEFAULT_SCOPE_LIMITS: ScopeLimits = {
	memoryMax: "2G",
	tasksMax: 512,
	cpuQuota: "100%",
	timeoutStopSec: 5,
};

export const SCOPE_PREFIX = "factory-stage-";

const UNIT = /^factory-stage-[0-9a-f]{16}-[a-z]{1,16}-[0-9]{1,6}-[0-9a-f]{8}$/;

/** A unit name that is unique per launch, so a retry never meets a leftover scope. */
export function scopeUnit(
	runId: string,
	stage: string,
	attempt: number,
	nonce: string,
): string {
	const unit = `${SCOPE_PREFIX}${runId.slice(0, 16)}-${stage}-${attempt}-${nonce}`;

	if (!/^[0-9a-f]{64}$/.test(runId) || !UNIT.test(unit)) {
		throw new Error("scope unit parts are malformed");
	}

	return unit;
}

export function scopeArgv(
	unit: string,
	limits: ScopeLimits,
	inner: readonly string[],
): string[] {
	return [
		"systemd-run",
		"--user",
		"--scope",
		"--quiet",
		`--unit=${unit}`,
		"-p",
		`MemoryMax=${limits.memoryMax}`,
		"-p",
		`TasksMax=${limits.tasksMax}`,
		"-p",
		`CPUQuota=${limits.cpuQuota}`,
		"-p",
		`TimeoutStopSec=${limits.timeoutStopSec}`,
		"--",
		...inner,
	];
}

export function stopScopeArgv(unit: string): string[] {
	return ["systemctl", "--user", "stop", `${unit}.scope`];
}

export const LIST_SCOPES_ARGV = [
	"systemctl",
	"--user",
	"list-units",
	"--all",
	"--plain",
	"--no-legend",
	"--type=scope",
	`${SCOPE_PREFIX}*`,
] as const;

/** Stage scope names from `systemctl list-units`. Anything not shaped like ours is ignored. */
export function parseScopeList(stdout: string): string[] {
	return stdout.split("\n").flatMap((line) => {
		const name = line.trim().split(/\s+/)[0] ?? "";
		const unit = name.endsWith(".scope") ? name.slice(0, -".scope".length) : "";

		return UNIT.test(unit) ? [unit] : [];
	});
}

export type Reconciled = {
	readonly stopped: readonly string[];
	readonly failed: readonly string[];
};

/**
 * Stops every leftover stage scope by name. The controller runs this at
 * startup before it adopts `running` markers, so no orphan keeps spending.
 */
export async function reconcileScopes(exec: Exec): Promise<Reconciled> {
	const [command, ...args] = LIST_SCOPES_ARGV;
	const listed = await exec(command, args);

	if (listed.code !== 0) return { stopped: [], failed: [`${SCOPE_PREFIX}*`] };

	const stopped: string[] = [];
	const failed: string[] = [];

	for (const unit of parseScopeList(listed.stdout)) {
		const [stop, ...stopArgs] = stopScopeArgv(unit);
		const result = await exec(stop ?? "systemctl", stopArgs);

		(result.code === 0 ? stopped : failed).push(unit);
	}

	return { stopped, failed };
}

/**
 * Spawns `systemd-run --user --scope … env -i … bwrap …` with an explicit
 * minimal environment and the seccomp program on a pipe at `seccompFd`.
 * Pi RPC runs over the child's stdin and stdout.
 */
export function spawnScoped(input: {
	argv: readonly string[];
	seccomp: Buffer;
	seccompFd: number;
	xdgRuntimeDir: string;
}): ChildProcess {
	const [command, ...args] = input.argv;
	const stdio: ("pipe" | "ignore")[] = ["pipe", "pipe", "pipe"];

	while (stdio.length < input.seccompFd) stdio.push("ignore");

	stdio.push("pipe");

	const child = spawn(command ?? "systemd-run", args, {
		stdio,
		env: { PATH: "/usr/bin:/bin", XDG_RUNTIME_DIR: input.xdgRuntimeDir },
	});

	const pipe = child.stdio[input.seccompFd];

	if (pipe !== null && pipe !== undefined && "end" in pipe) {
		pipe.on("error", () => {});
		pipe.end(input.seccomp);
	}

	return child;
}
