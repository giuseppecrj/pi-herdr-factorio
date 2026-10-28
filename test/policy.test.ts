import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
	ACCEPTANCE_SUITE_DIR,
	checkChangedPaths,
	checkLandPrecondition,
	decideAdmission,
	hasWriteAccess,
	isFactoryEnabled,
	type PermissionLevel,
	READY_LABEL,
} from "../src/policy.ts";
import { failingVerdict, passingVerdict, patch } from "./helpers.ts";

describe("admission", () => {
	it("admits the ready label from admin, maintain and write", () => {
		for (const actorPermission of ["admin", "maintain", "write"] as const) {
			assert.deepEqual(
				decideAdmission({ label: READY_LABEL, actorPermission }),
				{ kind: "admitted" },
			);
		}
	});

	it("refuses the ready label from an actor without write access", () => {
		for (const actorPermission of ["triage", "read", "none"] as const) {
			assert.deepEqual(
				decideAdmission({ label: READY_LABEL, actorPermission }),
				{ kind: "refused", reason: "unauthorized" },
			);
		}
	});

	it("refuses any other label whoever applied it", () => {
		for (const label of [
			"factory:proposed",
			"bug",
			"Factory:Ready",
			"factory:ready ",
		]) {
			assert.deepEqual(decideAdmission({ label, actorPermission: "admin" }), {
				kind: "refused",
				reason: "policy",
			});
		}
	});

	it("maps permission levels to write access", () => {
		const levels: Record<PermissionLevel, boolean> = {
			admin: true,
			maintain: true,
			write: true,
			triage: false,
			read: false,
			none: false,
		};
		for (const [level, expected] of Object.entries(levels)) {
			assert.equal(hasWriteAccess(level as PermissionLevel), expected, level);
		}
	});
});

describe("kill switch", () => {
	it("is on only for the exact string true", () => {
		assert.equal(isFactoryEnabled("true"), true);
		for (const value of [undefined, "", "false", "TRUE", "1", " true"]) {
			assert.equal(isFactoryEnabled(value), false, String(value));
		}
	});
});

describe("forbidden paths", () => {
	it("is clean for ordinary source and test files", () => {
		assert.deepEqual(
			checkChangedPaths({
				changedPaths: ["src/run.ts", "test/run.test.ts", "README.md"],
			}),
			{ kind: "clean" },
		);
	});

	it("is clean for an empty change", () => {
		assert.deepEqual(checkChangedPaths({ changedPaths: [] }), {
			kind: "clean",
		});
	});

	it("rejects anything under .github, not only workflows", () => {
		assert.deepEqual(
			checkChangedPaths({
				changedPaths: [
					"src/a.ts",
					".github/workflows/ci.yml",
					".github/actions/setup/action.yml",
					".github/CODEOWNERS",
				],
			}),
			{
				kind: "forbidden",
				paths: [
					".github/workflows/ci.yml",
					".github/actions/setup/action.yml",
					".github/CODEOWNERS",
				],
			},
		);
	});

	it("rejects anything touching the acceptance suite directory", () => {
		const result = checkChangedPaths({
			changedPaths: [
				`${ACCEPTANCE_SUITE_DIR}/ticket-42.test.ts`,
				ACCEPTANCE_SUITE_DIR,
			],
		});
		assert.equal(result.kind, "forbidden");
	});

	it("honours a custom acceptance directory", () => {
		assert.equal(
			checkChangedPaths({
				changedPaths: ["oracle/x.ts"],
				acceptanceDir: "oracle",
			}).kind,
			"forbidden",
		);
		assert.equal(
			checkChangedPaths({
				changedPaths: [`${ACCEPTANCE_SUITE_DIR}/x.ts`],
				acceptanceDir: "oracle",
			}).kind,
			"clean",
		);
	});

	it("is not fooled by sibling names", () => {
		assert.deepEqual(
			checkChangedPaths({
				changedPaths: [
					".github-notes.md",
					"docs/.github/x.md",
					`${ACCEPTANCE_SUITE_DIR}-helpers/x.ts`,
				],
			}),
			{ kind: "clean" },
		);
	});

	it("is not fooled by path spelling", () => {
		const spellings = [
			"./.github/workflows/ci.yml",
			".github//workflows/ci.yml",
			"src/../.github/workflows/ci.yml",
			".GitHub/Workflows/ci.yml",
			".github\\workflows\\ci.yml",
			".github/workflows",
		];
		for (const path of spellings) {
			assert.equal(
				checkChangedPaths({ changedPaths: [path] }).kind,
				"forbidden",
				path,
			);
		}
	});

	it("rejects paths that escape the repository", () => {
		for (const path of ["../outside.txt", "/etc/passwd"]) {
			assert.equal(
				checkChangedPaths({ changedPaths: [path] }).kind,
				"forbidden",
				path,
			);
		}
	});
});

describe("land precondition", () => {
	it("is ready when the passing verdict is bound to the run's patch", () => {
		assert.deepEqual(
			checkLandPrecondition({
				patchDigest: patch("a"),
				verdict: passingVerdict(patch("a")),
			}),
			{ kind: "ready" },
		);
	});

	it("is blocked when the verdict was issued for a different patch", () => {
		assert.deepEqual(
			checkLandPrecondition({
				patchDigest: patch("a"),
				verdict: passingVerdict(patch("b")),
			}),
			{ kind: "blocked", reason: "digest_mismatch" },
		);
	});

	it("is blocked when the verdict failed", () => {
		assert.deepEqual(
			checkLandPrecondition({
				patchDigest: patch("a"),
				verdict: failingVerdict(patch("a")),
			}),
			{ kind: "blocked", reason: "verdict_failed" },
		);
	});

	it("is blocked when a check failed under a verdict that claims pass", () => {
		assert.deepEqual(
			checkLandPrecondition({
				patchDigest: patch("a"),
				verdict: { ...failingVerdict(patch("a")), pass: true },
			}),
			{ kind: "blocked", reason: "verdict_failed" },
		);
	});

	it("is blocked without a patch or without a verdict", () => {
		assert.deepEqual(
			checkLandPrecondition({ verdict: passingVerdict(patch("a")) }),
			{
				kind: "blocked",
				reason: "no_patch",
			},
		);
		assert.deepEqual(checkLandPrecondition({ patchDigest: patch("a") }), {
			kind: "blocked",
			reason: "no_verdict",
		});
	});
});
