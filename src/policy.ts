import { posix } from "node:path";
import {
	type NonEmpty,
	type RejectReason,
	type Run,
	verdictPasses,
} from "./run.ts";

export const READY_LABEL = "factory:ready";

export const CONTROL_PLANE_DIR = ".github";
export const ACCEPTANCE_SUITE_DIR = "test/acceptance";

export type PermissionLevel =
	| "admin"
	| "maintain"
	| "write"
	| "triage"
	| "read"
	| "none";

export function hasWriteAccess(level: PermissionLevel): boolean {
	return level === "admin" || level === "maintain" || level === "write";
}

export type AdmissionDecision =
	| { kind: "admitted" }
	| {
			kind: "refused";
			reason: Extract<RejectReason, "policy" | "unauthorized">;
	  };

export function decideAdmission(input: {
	label: string;
	actorPermission: PermissionLevel;
}): AdmissionDecision {
	if (input.label !== READY_LABEL) return { kind: "refused", reason: "policy" };

	if (!hasWriteAccess(input.actorPermission)) {
		return { kind: "refused", reason: "unauthorized" };
	}

	return { kind: "admitted" };
}

export function isFactoryEnabled(variable: string | undefined): boolean {
	return variable === "true";
}

export type PathCheck =
	| { kind: "clean" }
	| { kind: "forbidden"; paths: NonEmpty<string> };

function isAtOrUnder(path: string, dir: string): boolean {
	return path === dir || path.startsWith(`${dir}/`);
}

// Paths are compared lowercase so a case-insensitive checkout cannot reach
// `.GitHub/`.
function isForbidden(changed: string, acceptanceDir: string): boolean {
	const path = posix.normalize(changed.replaceAll("\\", "/")).toLowerCase();

	return (
		path.startsWith("../") ||
		path.startsWith("/") ||
		isAtOrUnder(path, CONTROL_PLANE_DIR) ||
		isAtOrUnder(path, posix.normalize(acceptanceDir).toLowerCase())
	);
}

export function checkChangedPaths(input: {
	changedPaths: readonly string[];
	acceptanceDir?: string;
}): PathCheck {
	const acceptanceDir = input.acceptanceDir ?? ACCEPTANCE_SUITE_DIR;

	const [first, ...rest] = input.changedPaths.filter((path) =>
		isForbidden(path, acceptanceDir),
	);

	return first === undefined
		? { kind: "clean" }
		: { kind: "forbidden", paths: [first, ...rest] };
}

export type LandCheck =
	| { kind: "ready" }
	| {
			kind: "blocked";
			reason: "no_patch" | "no_verdict" | "digest_mismatch" | "verdict_failed";
	  };

export function checkLandPrecondition(
	run: Pick<Run, "patchDigest" | "verdict">,
): LandCheck {
	const { patchDigest, verdict } = run;

	if (patchDigest === undefined) return { kind: "blocked", reason: "no_patch" };

	if (verdict === undefined) return { kind: "blocked", reason: "no_verdict" };

	if (verdict.patchDigest !== patchDigest) {
		return { kind: "blocked", reason: "digest_mismatch" };
	}

	if (!verdictPasses(verdict)) {
		return { kind: "blocked", reason: "verdict_failed" };
	}

	return { kind: "ready" };
}
