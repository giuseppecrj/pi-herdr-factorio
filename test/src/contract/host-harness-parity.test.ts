import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { test } from "node:test";
import { sourceExcerpts } from "../../../src/contract/prompt.ts";

function mainHarness(sources: string[], tests: string[]): string[] {
	const stem = (path: string) =>
		path
			.replace(/^(?:src|server|lib|test|tests)\//, "")
			.replace(/(?:\.(?:test|spec|cases))?\.[cm]?[jt]sx?$/, "");

	const harness = new Set<string>();

	for (const source of sources) {
		const key = stem(source);

		const rank = (path: string) => {
			const candidate = stem(path);

			if (candidate === key) return 100;

			if (candidate.split("/").at(-1) === key.split("/").at(-1)) return 50;

			const directory = key.includes("/")
				? key.slice(0, key.lastIndexOf("/") + 1)
				: "";

			return directory !== "" &&
				candidate.startsWith(directory) &&
				/(?:runner|index)$/.test(candidate)
				? 10
				: 0;
		};

		const nearest = tests
			.filter((path) => rank(path) > 0)
			.sort((a, b) => rank(b) - rank(a) || a.localeCompare(b))[0];

		if (nearest !== undefined && harness.size < 3) harness.add(nearest);
	}

	return [...harness].sort();
}

async function matched(source: string, tests: string[]): Promise<string[]> {
	const shown = await sourceExcerpts({
		files: [source],
		evidence: [],
		checkout: {
			files: [source, ...tests],
			read: async () => "export const value = 1;",
		},
		identity: "repo@base",
		accept: true,
	});

	return [...new Set(shown.map((file) => file.path))]
		.filter((path) => tests.includes(path))
		.sort();
}

for (const [source, expected] of [
	["host/viewer/server.ts", "test/viewer.test.ts"],
	["host/gates/runner.ts", "test/gates.test.ts"],
]) {
	test(`L13 preserves the acceptance harness for ${source}`, async () => {
		assert.ok(source !== undefined && expected !== undefined);

		const tests = [
			"test/viewer.test.ts",
			"test/gates.test.ts",
			"test/runner.test.ts",
		];

		assert.deepEqual(await matched(source, tests), [expected]);
	});
}

test("L13 path-map harness selections equal main 7a9744d, retaining both sources of merged collectors", async () => {
	const paths = readFileSync("docs/history/path-map.md", "utf8");
	const moves = new Map<string, string[]>();

	for (const row of paths.split("\n")) {
		if (!row.startsWith("| L13 |")) continue;

		const [oldPath, newPath] = [...row.matchAll(/`([^`]+)`/g)].map(
			(match) => match[1],
		);

		assert.ok(oldPath !== undefined && oldPath.startsWith("server/"));
		assert.ok(newPath !== undefined && newPath.startsWith("host/"));
		moves.set(newPath, [...(moves.get(newPath) ?? []), oldPath]);
	}

	assert.equal(moves.size, 75);

	const tests = readdirSync("test", { recursive: true, encoding: "utf8" })
		.filter((path) => /\.(?:test|spec|cases)\.[cm]?[jt]sx?$/.test(path))
		.filter((path) => !/^(?:acceptance|fixtures)\//.test(path))
		.map((path) => `test/${path}`);

	const probes = [
		"test/cli.test.ts",
		"test/gates.test.ts",
		"test/server.test.ts",
		"test/runner.test.ts",
		"test/sandbox/gateway-client.test.ts",
		"test/sandbox/gateway-main.test.ts",
		"test/sandbox/assets/runner.test.ts",
	];

	const differences = [];

	for (const [newPath, oldPaths] of moves) {
		for (const candidates of [tests, [...tests, ...probes]]) {
			const expected = mainHarness(oldPaths, candidates);
			const actual = await matched(newPath, candidates);

			if (JSON.stringify(actual) !== JSON.stringify(expected))
				differences.push({ newPath, oldPaths, expected, actual });
		}
	}

	assert.deepEqual(differences, []);
});
