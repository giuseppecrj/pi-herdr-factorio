import { readFile } from "node:fs/promises";
import { randomBytes } from "node:crypto";
import type { Exec } from "../../src/gh.ts";
import { detectArch, type SeccompArch } from "./seccomp.ts";

export const PREFLIGHT_CHECKS = [
	"reconcile",
	"arch",
	"userns",
	"bwrap",
	"assets",
	"scope",
	"gateway",
] as const;

export type PreflightCheck = (typeof PREFLIGHT_CHECKS)[number];

export type PreflightResult =
	| {
			readonly ok: true;
			readonly arch: SeccompArch;
			readonly bwrap: string;
	  }
	| { readonly ok: false; readonly failed: readonly PreflightCheck[] };

export type PreflightDeps = {
	/** True once leftover stage scopes were listed and every one of ours stopped. */
	readonly reconciled: () => Promise<boolean>;
	readonly arch: string;
	readonly usernsLimit: () => Promise<string>;
	readonly exec: Exec;
	readonly assetsDigest: () => Promise<string | null>;
	readonly expectedDigest: string;
	readonly gatewayReady: () => Promise<boolean>;
};

export const MIN_BWRAP = [0, 9, 0] as const;

/** The bwrap version from `bwrap --version`, or `null` when the output is not `bubblewrap X.Y.Z`. */
export function bwrapVersion(stdout: string): string | null {
	const match = /^bubblewrap (\d+)\.(\d+)\.(\d+)\s*$/.exec(stdout);

	if (match === null) return null;

	const parts = [match[1], match[2], match[3]].map(Number);

	for (const [index, part] of parts.entries()) {
		const minimum = MIN_BWRAP[index] ?? 0;

		if (part > minimum) break;

		if (part < minimum) return null;
	}

	return parts.join(".");
}

export function readUsernsLimit(): Promise<string> {
	return readFile("/proc/sys/user/max_user_namespaces", "utf8");
}

export function preflightScopeArgv(nonce: string): string[] {
	return [
		"--user",
		"--scope",
		"--quiet",
		`--unit=factory-preflight-${nonce}`,
		"-p",
		"MemoryMax=64M",
		"-p",
		"TasksMax=8",
		"--",
		"true",
	];
}

async function safely<T>(work: () => Promise<T>, fallback: T): Promise<T> {
	try {
		return await work();
	} catch {
		return fallback;
	}
}

/**
 * The runner's preflight: leftover stage scopes stopped, a known CPU
 * architecture, unprivileged user namespaces, bwrap at least 0.9.0, the
 * expected asset digest, a user scope that launches, and a gateway that
 * comes up ready. Every check runs, so a failure names each cause.
 * `executionEnabled` follows `ok`.
 */
export async function runPreflight(
	deps: PreflightDeps,
): Promise<PreflightResult> {
	const failed: PreflightCheck[] = [];

	if (!(await safely(deps.reconciled, false))) failed.push("reconcile");

	const arch = detectArch(deps.arch);

	if (arch === null) failed.push("arch");

	const userns = await safely(deps.usernsLimit, "0");

	if (!/^[1-9][0-9]*\s*$/.test(userns)) failed.push("userns");

	const bwrap = await safely(async () => {
		const result = await deps.exec("bwrap", ["--version"]);

		return result.code === 0 ? bwrapVersion(result.stdout) : null;
	}, null);

	if (bwrap === null) failed.push("bwrap");

	const digest = await safely(deps.assetsDigest, null);

	if (digest === null || digest !== deps.expectedDigest) failed.push("assets");

	const scope = await safely(
		async () =>
			(
				await deps.exec(
					"systemd-run",
					preflightScopeArgv(randomBytes(4).toString("hex")),
				)
			).code === 0,
		false,
	);

	if (!scope) failed.push("scope");

	if (!(await safely(deps.gatewayReady, false))) failed.push("gateway");

	if (failed.length > 0 || arch === null || bwrap === null) {
		return { ok: false, failed };
	}

	return { ok: true, arch, bwrap };
}
