import assert from "node:assert/strict";
import {
	mkdtempSync,
	mkdirSync,
	readFileSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { runCli, USAGE, EXIT } from "../server/cli.ts";
import {
	checkCandidate,
	materializeFromDirectories,
	replacementDigest,
} from "../server/gates.ts";
import { noPlatformFile } from "./helpers.ts";

const snapshot = JSON.parse(
	readFileSync(
		new URL("./fixtures/layout-host/cli.json", import.meta.url),
		"utf8",
	),
);

const argumentsToPin = [
	[],
	["--help"],
	["platform", "--env"],
	["platform", "--json"],
	["workflow-check", "--json", "--repo", "nublai/pi-herdr-factorio"],
	["status", "--json", "--repo", "nublai/pi-herdr-factorio"],
	[
		"owner-feed",
		"--json",
		"--state-dir",
		"/nonexistent-layout-contract-state",
		"--repo",
		"nublai/pi-herdr-factorio",
	],
	...[
		"owner-feed",
		"metrics",
		"replay",
		"cadence",
		"score",
		"explain",
		"viewer",
		"gates",
		"admit",
		"tick",
		"run",
		"serve",
	].map((verb) => [verb, "--unknown-layout-option"]),
	["tick", "--json", "--repo", "nublai/pi-herdr-factorio"],
	["run", "--json", "--repo", "nublai/pi-herdr-factorio", "--issue", "0"],
	["serve", "--json", "--repo", "nublai/pi-herdr-factorio"],
];

test("L13 pins CLI help, verb flags, exit codes and unavailable status/feed bytes", async (t) => {
	t.mock.timers.enable({
		apis: ["Date"],
		now: Date.parse("2026-11-12T00:00:00Z"),
	});
	const actual = [];

	for (const argv of argumentsToPin) {
		let stdout = "",
			stderr = "";

		const exit = await runCli(argv, {
			exec: async () => ({
				code: 1,
				stdout: "",
				stderr: "gh: Not Found (HTTP 404)",
			}),
			env: () => undefined,
			readPlatformFile: noPlatformFile,
			stdout: (text) => {
				stdout += text;
			},
			stderr: (text) => {
				stderr += text;
			},
		});

		actual.push({
			argv,
			exit,
			stdout,
			stderr: stderr.replaceAll("server/cli.ts", "<cli>"),
		});
	}

	assert.deepEqual(EXIT, { ok: 0, invalid: 1, usage: 2 });
	assert.equal(USAGE.replaceAll("server/cli.ts", "<cli>"), snapshot.usage);
	assert.deepEqual(actual, snapshot.commands);
});

test("L13 pins invalid gate receipt bytes and forbids runner execution", async () => {
	const root = mkdtempSync(join(tmpdir(), "layout-gate-pin-"));

	try {
		const receipt = await checkCandidate({
			repository: root,
			gateSha: "invalid",
			candidateSha: "b".repeat(40),
			nonce: "layout-pin",
			output: join(root, "out"),
			runner: {
				kind: "must-not-run",
				run: async () => {
					throw new Error("runner unexpectedly called");
				},
			},
		});

		assert.deepEqual({ ...receipt, wallMs: 0 }, snapshot.receipt);
		assert.equal(
			readFileSync(join(root, "out/receipt.json"), "utf8"),
			`${JSON.stringify(receipt, null, 2)}\n`,
		);
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});

test("L13 pins materialization roots, held-out exclusion and immutable main tests/config", () => {
	const root = mkdtempSync(join(tmpdir(), "layout-material-pin-"));

	const put = (tree: string, path: string, text: string) => {
		const file = join(root, tree, path);
		mkdirSync(join(file, ".."), { recursive: true });
		writeFileSync(file, text);
	};

	try {
		for (const tree of ["gate", "candidate"]) {
			put(tree, "server/value.ts", tree);
			put(tree, "test/value.test.ts", tree);
			put(tree, "tsconfig.json", tree);
			put(tree, ".github/factory/gates/gates.json", tree);
			put(tree, "test/acceptance/old/checks/a.test.ts", "frozen");
		}

		const result = materializeFromDirectories({
			gateTree: join(root, "gate"),
			candidateTree: join(root, "candidate"),
			dest: join(root, "out"),
			replacements: [],
		});

		assert.equal(
			readFileSync(join(root, "out/server/value.ts"), "utf8"),
			"candidate",
		);

		for (const path of [
			"test/value.test.ts",
			"tsconfig.json",
			".github/factory/gates/gates.json",
		])
			assert.equal(readFileSync(join(root, "out", path), "utf8"), "gate");
		assert.deepEqual(result, {
			ignoredChanges: [
				".github/factory/gates/gates.json",
				"test/value.test.ts",
				"tsconfig.json",
			],
			newTests: [],
		});
		assert.equal(
			replacementDigest([]),
			"4f53cda18c2baa0c0354bb5f9a3ecbe5ed12ab4d8e11ba873c2f11161202b945",
		);
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});
