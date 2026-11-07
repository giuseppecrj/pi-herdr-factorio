import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
	ACCEPTANCE_SUITE_DIR,
	checkChangedPaths,
	decideAdmission,
	hasWriteAccess,
	type PermissionLevel,
	READY_LABEL,
	REPO_SWITCH_LABEL,
} from "../src/policy.ts";

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
			// SAFETY: `levels` is a literal typed Record<PermissionLevel, boolean>,
			// so its own keys are exactly the PermissionLevel members.
			assert.equal(hasWriteAccess(level as PermissionLevel), expected, level);
		}
	});
});

describe("kill switch", () => {
	it("is the repository label factory:enabled, apart from the ready label", () => {
		assert.equal(REPO_SWITCH_LABEL, "factory:enabled");
		assert.notEqual(REPO_SWITCH_LABEL, READY_LABEL);
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
		for (const path of [
			"../outside.txt",
			"/etc/passwd",
			"..",
			"src/../../outside",
			".git/config",
			"src/.GIT/config",
			"",
		]) {
			assert.equal(
				checkChangedPaths({ changedPaths: [path] }).kind,
				"forbidden",
				path,
			);
		}
	});
});

it("reserves the controller-owned repair feedback path and descendants", () => {
	for (const path of [
		".factory-feedback-full.json",
		".factory-feedback-full.json/x.ts",
		".FACTORY-FEEDBACK-FULL.JSON",
		".factory-feedback.json",
		"./.factory-feedback.json",
		".FACTORY-FEEDBACK.JSON",
		".factory-feedback.json/x.ts",
		"./.FACTORY-FEEDBACK.JSON/deep/x.ts",
		".factory-feedback.json\\x.ts",
	])
		assert.equal(checkChangedPaths({ changedPaths: [path] }).kind, "forbidden");

	for (const path of [
		"src/feedback.json",
		".factory-feedback.json.ts",
		".factory-feedback.json-backup/x.ts",
		"src/.factory-feedback.json",
	])
		assert.equal(checkChangedPaths({ changedPaths: [path] }).kind, "clean");
});
