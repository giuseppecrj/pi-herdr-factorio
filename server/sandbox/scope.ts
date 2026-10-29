import { type ChildProcess, spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { realpathSync } from "node:fs";
import { resolve } from "node:path";
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

const UNIT =
	/^factory-stage-([0-9a-f]{8})-[0-9a-f]{16}-[a-z]{1,16}-[0-9]{1,6}-[0-9a-f]{8}$/;

/** The unit name before it carried an owner, as builds up to `d97bbce` made it. */
const LEGACY_UNIT =
	/^factory-stage-[0-9a-f]{16}-[a-z]{1,16}-[0-9]{1,6}-[0-9a-f]{8}$/;

/**
 * The controller a stage scope belongs to: the first 8 hex of the sha256 of
 * its state dir's real path. Controllers with different state dirs, such
 * as scoped verification lanes, never claim each other's scopes. A state
 * dir that does not resolve yet hashes its absolute path.
 */
export function scopeOwner(stateDir: string): string {
	let path: string;

	try {
		path = realpathSync(stateDir);
	} catch {
		path = resolve(stateDir);
	}

	return createHash("sha256").update(path).digest("hex").slice(0, 8);
}

/**
 * A unit name that is unique per launch, so a retry never meets a leftover
 * scope, and that names the controller that owns it.
 */
export function scopeUnit(
	owner: string,
	runId: string,
	stage: string,
	attempt: number,
	nonce: string,
): string {
	const unit = `${SCOPE_PREFIX}${owner}-${runId.slice(0, 16)}-${stage}-${attempt}-${nonce}`;

	if (!/^[0-9a-f]{64}$/.test(runId) || UNIT.exec(unit)?.[1] !== owner) {
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

export function listScopesArgv(): string[] {
	return [
		"systemctl",
		"--user",
		"list-units",
		"--all",
		"--plain",
		"--no-legend",
		"--type=scope",
		`${SCOPE_PREFIX}*`,
	];
}

export function describeScopeArgv(unit: string): string[] {
	return [
		"systemctl",
		"--user",
		"show",
		"-p",
		"Description",
		"--value",
		`${unit}.scope`,
	];
}

function unitsOf(stdout: string): string[] {
	return stdout.split("\n").map((line) => {
		const name = line.trim().split(/\s+/)[0] ?? "";

		return name.endsWith(".scope") ? name.slice(0, -".scope".length) : "";
	});
}

/**
 * This controller's stage scope names from `systemctl list-units`.
 * Anything not shaped like ours, or owned by another controller, is ignored.
 */
export function parseScopeList(stdout: string, owner: string): string[] {
	return unitsOf(stdout).filter((unit) => UNIT.exec(unit)?.[1] === owner);
}

/** Stage scopes named before units carried an owner. */
export function parseLegacyScopes(stdout: string): string[] {
	return unitsOf(stdout).filter((unit) => LEGACY_UNIT.test(unit));
}

/**
 * True when a scope's description, which `systemd-run` sets to the command
 * it ran, binds a path under this state dir's `stages/` or `gw/`. Only
 * absolute spellings of the state dir count, each at the start of an
 * argument, so `/x/state-lane/stages/` never matches `/x/state`.
 */
export function namesStateDir(description: string, stateDir: string): boolean {
	const dirs = new Set([resolve(stateDir)]);

	try {
		dirs.add(realpathSync(stateDir));
	} catch {
		// A state dir that does not resolve is matched by its absolute path only.
	}

	return [...dirs].some((dir) =>
		["stages", "gw"].some((sub) => {
			const needle = `${dir}/${sub}/`;
			let at = description.indexOf(needle);

			while (at !== -1) {
				if (at === 0 || /[\s"'=]/.test(description[at - 1] ?? "")) return true;

				at = description.indexOf(needle, at + 1);
			}

			return false;
		}),
	);
}

export type Reconciled = {
	readonly stopped: readonly string[];
	readonly failed: readonly string[];
	readonly unowned: readonly string[];
};

/**
 * Stops every leftover stage scope this controller owns, by name. The
 * controller runs this at startup before it adopts `running` markers, so
 * no orphan keeps spending. Scopes another controller owns are left alone.
 * An old-format scope, named before units carried an owner, is stopped only
 * when its command line binds this state dir. One whose command line cannot
 * be read, or names another dir, is `unowned` and left running.
 */
export async function reconcileScopes(
	stateDir: string,
	exec: Exec,
): Promise<Reconciled> {
	const owner = scopeOwner(stateDir);
	const [command = "systemctl", ...args] = listScopesArgv();
	const listed = await exec(command, args);

	if (listed.code !== 0) {
		return { stopped: [], failed: [`${SCOPE_PREFIX}*`], unowned: [] };
	}

	const stopped: string[] = [];
	const failed: string[] = [];
	const unowned: string[] = [];
	const ours = parseScopeList(listed.stdout, owner);

	for (const unit of parseLegacyScopes(listed.stdout)) {
		const [show = "systemctl", ...showArgs] = describeScopeArgv(unit);
		const shown = await exec(show, showArgs);

		if (shown.code === 0 && namesStateDir(shown.stdout, stateDir))
			ours.push(unit);
		else unowned.push(unit);
	}

	for (const unit of ours) {
		const [stop, ...stopArgs] = stopScopeArgv(unit);
		const result = await exec(stop ?? "systemctl", stopArgs);

		(result.code === 0 ? stopped : failed).push(unit);
	}

	return { stopped, failed, unowned };
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
