import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import {
	appendFileSync,
	cpSync,
	existsSync,
	mkdirSync,
	mkdtempSync,
	readdirSync,
	readFileSync,
	renameSync,
	rmSync,
	symlinkSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { after, afterEach, before, describe, it } from "node:test";
import { fileURLToPath } from "node:url";
import {
	arrayOf,
	countOf,
	fieldOf,
	objectOf,
	parseJson,
	textOf,
	textsOf,
} from "../src/core/json.ts";

const repo = fileURLToPath(new URL("../", import.meta.url));
const guard = join(repo, "scripts/check-layout.mjs");
const decisions = join(repo, "scripts/check-decisions.mjs");
const temps: string[] = [];

after(() => {
	for (const dir of temps) rmSync(dir, { recursive: true, force: true });
});

function temp(prefix: string): string {
	const dir = mkdtempSync(join(tmpdir(), prefix));
	temps.push(dir);

	return dir;
}

function treeFiles(): string[] {
	if (existsSync(join(repo, ".git")))
		return execFileSync(
			"git",
			[
				"-C",
				repo,
				"ls-files",
				"-z",
				"--cached",
				"--others",
				"--exclude-standard",
			],
			{ encoding: "utf8", maxBuffer: 64 * 1024 * 1024 },
		)
			.split("\0")
			.filter(
				(path) =>
					path !== "" &&
					!path.split("/").includes("node_modules") &&
					existsSync(join(repo, path)),
			);

	const found: string[] = [];

	const walk = (dir: string) => {
		for (const entry of readdirSync(join(repo, dir), { withFileTypes: true })) {
			if (entry.name === ".git" || entry.name === "node_modules") continue;
			const path = dir === "" ? entry.name : `${dir}/${entry.name}`;

			if (entry.isDirectory()) walk(path);
			else found.push(path);
		}
	};

	walk("");

	return found;
}

function copyTree(dest: string): void {
	for (const path of treeFiles()) {
		mkdirSync(dirname(join(dest, path)), { recursive: true });
		cpSync(join(repo, path), join(dest, path));
	}
}

function run(script: string, root: string, extra: readonly string[] = []) {
	const result = spawnSync(
		process.execPath,
		["--experimental-strip-types", script, "--root", root, "--json", ...extra],
		{ encoding: "utf8" },
	);

	const problems = textsOf(parseJson(result.stdout));
	assert.ok(problems !== null, result.stderr);

	return { status: result.status, problems };
}

function layout(root: string, only: string): string[] {
	const { status, problems } = run(guard, root, ["--only", only]);
	assert.equal(status, problems.length === 0 ? 0 : 1);

	return problems;
}

function read(root: string, path: string): string {
	return readFileSync(join(root, path), "utf8");
}

function write(root: string, path: string, text: string): void {
	mkdirSync(dirname(join(root, path)), { recursive: true });
	writeFileSync(join(root, path), text);
}

function edit(root: string, path: string, from: string | RegExp, to: string) {
	const text = read(root, path);
	const next = text.replace(from, to);
	assert.notEqual(next, text, `${String(from)} not found in ${path}`);
	writeFileSync(join(root, path), next);
}

function includesMatch(problems: readonly string[], pattern: RegExp): void {
	assert.ok(
		problems.some((problem) => pattern.test(problem)),
		`expected ${String(pattern)} in:\n${problems.join("\n")}`,
	);
}

type Target = { readonly path: string; readonly type: string };

type Reader =
	| {
			readonly kind: "constants";
			readonly id: string;
			readonly readers: readonly string[];
			readonly declarations: readonly { file: string; name: string }[];
	  }
	| {
			readonly kind: "paths";
			readonly id: string;
			readonly reader: string;
			readonly tokens: readonly (readonly [string, number])[];
			readonly targets: readonly Target[];
	  };

function required<T>(value: T | null | undefined, what: string): T {
	assert.ok(value !== null && value !== undefined, `baseline ${what}`);

	return value;
}

function readersOf(root: string): Reader[] {
	const baseline = objectOf(
		parseJson(read(root, "scripts/layout-baseline.json")),
	);

	return required(arrayOf(fieldOf(baseline, "readers")), "readers").map(
		(value): Reader => {
			const item = objectOf(value);
			const id = required(textOf(fieldOf(item, "id")), "id");

			const pathsOf = (key: string) =>
				required(arrayOf(fieldOf(item, key)), key).map((entry) => {
					const target = objectOf(entry);

					return {
						file: textOf(fieldOf(target, "file")) ?? "",
						name: textOf(fieldOf(target, "name")) ?? "",
						path: textOf(fieldOf(target, "path")) ?? "",
						type: textOf(fieldOf(target, "type")) ?? "",
					};
				});

			if (textOf(fieldOf(item, "kind")) === "constants")
				return {
					kind: "constants",
					id,
					readers: required(textsOf(fieldOf(item, "readers")), "readers"),
					declarations: pathsOf("declarations"),
				};

			const tokens = Object.entries(
				required(objectOf(fieldOf(item, "tokens")), "tokens"),
			).map(
				([token, count]) => [token, required(countOf(count), token)] as const,
			);

			return {
				kind: "paths",
				id,
				reader: required(textOf(fieldOf(item, "reader")), "reader"),
				tokens,
				targets: pathsOf("targets"),
			};
		},
	);
}

function loose(token: string): RegExp {
	return new RegExp(
		token.replace(/[.*+?^${}()|[\]\\]/g, "\\$&").replaceAll(" ", "\\s+"),
	);
}

describe("layout guard", () => {
	let pristine = "";
	const scratches: string[] = [];

	before(() => {
		pristine = temp("layout-pristine-");
		copyTree(pristine);
		symlinkSync(join(repo, "node_modules"), join(pristine, "node_modules"));
	});

	function release(...dirs: string[]): void {
		for (const dir of dirs) {
			rmSync(dir, { recursive: true, force: true });
			scratches.splice(scratches.indexOf(dir), 1);
		}
	}

	afterEach(() => release(...scratches));

	function scratch(): string {
		const dir = mkdtempSync(join(tmpdir(), "layout-scratch-"));
		scratches.push(dir);
		cpSync(pristine, dir, { recursive: true });

		return dir;
	}

	it("passes every category on an exported tree without Git", () => {
		assert.deepEqual(run(guard, pristine).problems, []);
	});

	describe("imports", () => {
		it("fails the trusted scanner when the JSON module it imports is removed", () => {
			const root = scratch();
			rmSync(join(root, "src/core/json.ts"));

			includesMatch(
				layout(root, "imports"),
				/^imports: \.github\/factory\/gates\/scan\.ts imports \.\.\/\.\.\/\.\.\/src\/core\/json\.ts, but src\/core\/json\.ts does not exist$/,
			);
		});

		it("reports every category when a module the guard loads is removed", () => {
			const root = scratch();
			rmSync(join(root, "src/core/json.ts"));

			const { status, problems } = run(guard, root);
			assert.equal(status, 1);
			includesMatch(
				problems,
				/^imports: \.github\/factory\/gates\/scan\.ts imports \.\.\/\.\.\/\.\.\/src\/core\/json\.ts, but src\/core\/json\.ts does not exist$/,
			);
			includesMatch(
				problems,
				/^classification: cannot load src\/review\.ts: .*src\/core\/json\.ts/,
			);
			includesMatch(
				problems,
				/^readers: replay-stage-caps: src\/replay\.ts replayStageCaps failed at HEAD: /,
			);
		});

		it("fails an unlisted reverse edge into server or host", () => {
			const root = scratch();
			appendFileSync(
				join(root, "src/core/run.ts"),
				'export { readLock } from "../../server/controller.ts";\nimport "../../host/cli/index.ts";\n',
			);

			const problems = layout(root, "imports");
			includesMatch(
				problems,
				/src\/core\/run\.ts -> server\/controller\.ts is a new reverse edge/,
			);
			includesMatch(
				problems,
				/src\/core\/run\.ts -> host\/cli\/index\.ts is a new reverse edge/,
			);
			includesMatch(
				problems,
				/src\/core\/run\.ts imports \.\.\/\.\.\/host\/cli\/index\.ts, but host\/cli\/index\.ts does not exist/,
			);
		});

		it("fails a listed reverse edge that no longer exists, so the list only shrinks", () => {
			const root = scratch();
			edit(
				root,
				"src/replay.ts",
				"../server/sandbox/manifest.ts",
				"./core/run.ts",
			);

			includesMatch(
				layout(root, "imports"),
				/src\/replay\.ts -> server\/sandbox\/manifest\.ts is listed in reverseEdges but no longer exists/,
			);
		});

		const driver = ".pi/skills/verify-factory/scripts/status-driver.ts";
		const caller = ".pi/skills/verify-factory/scripts/drive-status.sh";

		function plantRootCopy(root: string): void {
			write(
				root,
				driver,
				`import piHerdrFactorio from "./extension/index.ts";\n${read(root, driver)}`,
			);
			edit(
				root,
				caller,
				`[ -f "$lane/ws/${driver}" ]`,
				`cp "$lane/ws/${driver}" "$lane/ws/.status-driver.ts" 2>/dev/null`,
			);
			edit(root, caller, ` ${driver} status)`, " .status-driver.ts status)");
			edit(
				root,
				"scripts/layout-baseline.json",
				'"exceptions": [],',
				`"exceptions": [${JSON.stringify({
					file: driver,
					specifier: "./extension/index.ts",
					resolveFrom: ".",
					until: "L02",
					caller,
				})}],`,
			);
		}

		it("fails the retired root-copy import now that no exception allows it", () => {
			const root = scratch();
			write(
				root,
				driver,
				`import piHerdrFactorio from "./extension/index.ts";\n${read(root, driver)}`,
			);

			includesMatch(
				layout(root, "imports"),
				/^imports: \.pi\/skills\/verify-factory\/scripts\/status-driver\.ts imports \.\/extension\/index\.ts, but \.pi\/skills\/verify-factory\/scripts\/extension\/index\.ts does not exist$/,
			);
		});

		it("keeps the status driver's root-copy exception to its one import", () => {
			const root = scratch();
			plantRootCopy(root);
			appendFileSync(join(root, driver), 'import "./src/run.ts";\n');

			includesMatch(
				layout(root, "imports"),
				/status-driver\.ts imports \.\/src\/run\.ts, but \.pi\/skills\/verify-factory\/scripts\/src\/run\.ts does not exist/,
			);

			edit(
				root,
				driver,
				'import piHerdrFactorio from "./extension/index.ts";',
				"",
			);
			includesMatch(
				layout(root, "imports"),
				/exception for .*status-driver\.ts importing \.\/extension\/index\.ts is no longer used/,
			);
		});

		it("binds the status driver's exception to where its staging caller copies and runs it", () => {
			const outside = scratch();
			plantRootCopy(outside);
			edit(
				outside,
				caller,
				'"$lane/ws/.status-driver.ts"',
				'"$lane/.status-driver.ts"',
			);

			includesMatch(
				layout(outside, "imports"),
				/^imports: exception for \.pi\/skills\/verify-factory\/scripts\/status-driver\.ts: staging caller .*drive-status\.sh copies it to \$lane\/\.status-driver\.ts, outside the checkout \$lane\/ws$/,
			);

			const nested = scratch();
			plantRootCopy(nested);
			edit(
				nested,
				caller,
				'"$lane/ws/.status-driver.ts"',
				'"$lane/ws/lane/.status-driver.ts"',
			);

			includesMatch(
				layout(nested, "imports"),
				/copies it to lane\/\.status-driver\.ts, which resolves imports from lane, not \.$/,
			);

			const elsewhere = scratch();
			plantRootCopy(elsewhere);
			edit(elsewhere, caller, '(cd "$lane/ws" && node', '(cd "$lane" && node');

			includesMatch(
				layout(elsewhere, "imports"),
				/staging caller .*drive-status\.sh never runs \.status-driver\.ts from the checkout \$lane\/ws$/,
			);
		});
	});

	describe("classification", () => {
		it("fails an unclassified file and a classified file that is gone", () => {
			const root = scratch();
			write(root, "src/unclassified.ts", "export const x = 1;\n");
			rmSync(join(root, "server/viewer/icon-192.png"));

			const problems = layout(root, "classification");
			includesMatch(
				problems,
				/^classification: src\/unclassified\.ts is unclassified/,
			);
			includesMatch(
				problems,
				/^classification: server\/viewer\/icon-192\.png is classified but missing/,
			);
		});

		it("fails an extraction that drops a seat its source required", () => {
			const root = scratch();
			write(root, "src/core/extracted.ts", "export const x = 1;\n");
			const seats = '["code-review", "security-review", "simplify"]';

			edit(
				root,
				"scripts/layout-baseline.json",
				/"files": \{\n/,
				`"files": {\n\t\t\t"src/core/extracted.ts": { "owner": "src/core", "seats": ${seats}, "from": ["server/sandbox/json.ts"], "since": "L03" },\n`,
			);

			includesMatch(
				layout(root, "classification"),
				/^classification: src\/core\/extracted\.ts drops review seat ultrareview inherited from server\/sandbox\/json\.ts$/,
			);
		});

		it("fails review routing that drops a branch outside src and server", () => {
			const branches = [
				[
					"package(?:-lock)?\\.json$|",
					"",
					["package.json", "package-lock.json"],
				],
				["package(?:-lock)?\\.json$", "package\\.json$", ["package-lock.json"]],
				["|skills\\/)", ")", ["skills/build/SKILL.md"]],
			] as const;

			for (const [from, to, routes] of branches) {
				const root = scratch();
				edit(root, "src/review.ts", from, to);
				const problems = layout(root, "classification");

				for (const route of routes)
					assert.ok(
						problems.includes(
							`classification: route ${route} requires review seat ultrareview, but reviewSeats gives code-review,security-review,simplify`,
						),
						`${route}:\n${problems.join("\n")}`,
					);
				release(root);
			}
		});

		it("fails a recorded seat that reviewSeats no longer grants", () => {
			const root = scratch();
			write(root, "src/extracted.ts", "export const x = 1;\n");

			const seats =
				'["code-review", "security-review", "simplify", "ultrareview"]';

			edit(
				root,
				"scripts/layout-baseline.json",
				/"files": \{\n/,
				`"files": {\n\t\t\t"src/extracted.ts": { "owner": "src/core", "seats": ${seats}, "from": ["server/sandbox/json.ts", "src/gone.ts"], "since": "L03" },\n`,
			);

			const problems = layout(root, "classification");
			includesMatch(
				problems,
				/^classification: src\/extracted\.ts requires review seat ultrareview, but reviewSeats gives code-review,security-review,simplify$/,
			);
			includesMatch(
				problems,
				/^classification: src\/extracted\.ts names unknown source src\/gone\.ts$/,
			);
		});
	});

	describe("readers", () => {
		it("fails when any inventoried reader snippet is changed", () => {
			for (const entry of readersOf(pristine)) {
				if (entry.kind !== "paths") continue;
				const root = scratch();

				for (const [token] of entry.tokens)
					edit(root, entry.reader, loose(token), "MUTATED");

				const problems = layout(root, "readers");

				for (const [token, count] of entry.tokens)
					assert.ok(
						problems.includes(
							`readers: ${entry.id}: ${entry.reader} has ${count - 1} of ${JSON.stringify(token)}, expected ${count}`,
						),
						`${entry.id} ${token}:\n${problems.join("\n")}`,
					);
				release(root);
			}
		});

		it("fails when any inventoried reader target is moved", () => {
			for (const entry of readersOf(pristine)) {
				if (entry.kind !== "paths") continue;

				const moved = entry.targets.filter(
					(t) =>
						t.path !== "." &&
						!"scripts/layout-baseline.json".startsWith(`${t.path}/`),
				);

				if (moved.length === 0) continue;
				const root = scratch();

				for (const target of new Set(moved.map((t) => t.path)))
					if (existsSync(join(root, target)))
						renameSync(join(root, target), join(root, `${target}.moved`));

				const problems = layout(root, "readers");

				for (const target of moved)
					includesMatch(
						problems,
						new RegExp(
							`^readers: ${entry.id}: ${target.path.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")} is missing, expected ${target.type}$`,
						),
					);
				release(root);
			}
		});

		it("fails a reader whose relative root depth changes when it moves", () => {
			const root = scratch();
			mkdirSync(join(root, "server/cli"));
			renameSync(
				join(root, "server/cli.ts"),
				join(root, "server/cli/index.ts"),
			);
			edit(
				root,
				"scripts/layout-baseline.json",
				'"reader": "server/cli.ts"',
				'"reader": "server/cli/index.ts"',
			);

			includesMatch(
				layout(root, "readers"),
				/^readers: cli-source-root: \.\. from server\/cli resolves to server, expected \.$/,
			);
		});

		it("fails a constant that is renamed or declared twice", () => {
			for (const entry of readersOf(pristine)) {
				if (entry.kind !== "constants") continue;

				for (const declaration of entry.declarations) {
					const root = scratch();
					const line = new RegExp(`^export const ${declaration.name} = `, "m");
					edit(
						root,
						declaration.file,
						line,
						`export const ${declaration.name}_MOVED = `,
					);

					includesMatch(
						layout(root, "readers"),
						new RegExp(
							`^readers: ${entry.id}: .* has 0 declarations of ${declaration.name}, expected exactly 1$`,
						),
					);

					const twice = scratch();

					const original = read(twice, declaration.file).match(
						new RegExp(`^export const ${declaration.name} = .*$`, "m"),
					);

					assert.ok(original);
					appendFileSync(join(twice, declaration.file), `${original[0]}\n`);

					includesMatch(
						layout(twice, "readers"),
						new RegExp(
							`^readers: ${entry.id}: .* has 2 declarations of ${declaration.name}, expected exactly 1$`,
						),
					);
					release(root, twice);
				}

				for (const reader of entry.readers) {
					const root = scratch();
					const file = entry.declarations[0]?.file ?? "";
					edit(
						root,
						reader,
						new RegExp(file.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "g"),
						"MOVED",
					);
					includesMatch(
						layout(root, "readers"),
						new RegExp(
							`^readers: ${entry.id}: ${reader.replace(/\./g, "\\.")} no longer names ${file.replace(/\./g, "\\.")}$`,
						),
					);
					release(root);
				}
			}
		});

		it("runs each reader's own constant lookup against the declaration", () => {
			const readers = [
				".pi/skills/verify-factory/scripts/drive-replay.ts",
				"test/integration/replay-driver.test.ts",
			];

			for (const reader of readers) {
				const moved = scratch();
				edit(
					moved,
					reader,
					"const VISIBLE_LIMIT_MS = (",
					"const VISIBLE_LIMIT_MS_MOVED = (",
				);

				includesMatch(
					layout(moved, "readers"),
					new RegExp(
						`^readers: visible-test-deadline: ${reader.replace(/\./g, "\\.")} lookup /.*VISIBLE_LIMIT_MS_MOVED.*/m? finds 0 declarations in server/sandbox\\.ts, expected exactly 1$`,
					),
				);

				const gone = scratch();
				edit(gone, reader, /\/\^?export const VISIBLE_LIMIT_MS = /, '"');

				includesMatch(
					layout(gone, "readers"),
					new RegExp(
						`^readers: visible-test-deadline: ${reader.replace(/\./g, "\\.")} has 0 lookups of VISIBLE_LIMIT_MS, expected exactly 1$`,
					),
				);
				release(moved, gone);
			}
		});

		it("fails when a fixture a test reads at runtime moves", () => {
			const root = scratch();

			for (const target of [
				"test/fixtures/replay/cases/c3",
				"test/fixtures/metrics/runs-2026-11-08.jsonl",
			])
				renameSync(join(root, target), join(root, `${target}.moved`));

			const problems = layout(root, "readers");
			includesMatch(
				problems,
				/^readers: test-reads-integration-replay-driver: test\/fixtures\/replay\/cases\/c3\/issue\.md is missing, expected file$/,
			);
			includesMatch(
				problems,
				/^readers: test-reads-integration-replay-driver: test\/fixtures\/metrics\/runs-2026-11-08\.jsonl is missing, expected file$/,
			);
		});

		it("runs the real replayStageCaps against the working tree", () => {
			const root = scratch();
			edit(
				root,
				"src/build.ts",
				/^export const BUILD_MAX_TOKENS = /m,
				"export const BUILD_TOKENS = ",
			);

			includesMatch(
				layout(root, "readers"),
				/^readers: replay-stage-caps: src\/replay\.ts replayStageCaps failed at HEAD: replay_stage_caps_unavailable$/,
			);
		});
	});

	describe("literals", () => {
		const moves = [
			{
				category: "TypeScript constants",
				target: ".github/factory/WORKFLOW.md",
				expect: [
					/^literals: src\/workflow\.ts:\d+ names \.github\/factory\/WORKFLOW\.md, which does not exist/,
					/^literals: src\/cadence\.ts:\d+ names \.github\/factory\/WORKFLOW\.md, which does not exist/,
					/^literals: src\/scorers\.ts:\d+ names \.github\/factory\/WORKFLOW\.md, which does not exist/,
				],
			},
			{
				category: "bare root names beside paths",
				target: "AGENTS.md",
				expect: [
					/^literals: src\/cadence\.ts:\d+ names AGENTS\.md, which does not exist/,
				],
			},
			{
				category: "path prefixes",
				target: "test/acceptance",
				expect: [
					/^literals: src\/publication\.ts:\d+ names test\/acceptance\/, which is not a directory/,
					/^literals: src\/feedback\.ts:\d+ names test\/acceptance/,
					/^literals: src\/validation\.ts:\d+ names test\/acceptance/,
					/^literals: src\/specify\.ts:\d+ names test\/acceptance/,
					/^literals: src\/adapters\/github\.ts:\d+ names test\/acceptance/,
					/^literals: server\/sandbox\.ts:\d+ names test\/acceptance/,
					/^literals: server\/gates\.ts:\d+ names test\/acceptance\/, which is the prefix of no file/,
				],
			},
			{
				category: "trusted gate files",
				target: ".github/factory/gates/scan-rules.json",
				expect: [
					/^literals: server\/gates\.ts:\d+ names \.github\/factory\/gates\/scan-rules\.json, which does not exist/,
				],
			},
			{
				category: "trusted gate manifest",
				target: ".github/factory/gates",
				expect: [
					/^literals: server\/gates\.ts:\d+ names \.github\/factory\/gates\/gates\.json, which does not exist/,
					/^literals: server\/controller\.ts:\d+ names \.github\/factory\/gates, which does not exist/,
				],
			},
			{
				category: "script roots",
				target: "server/viewer/design",
				expect: [
					/^literals: scripts\/design-tokens\.mjs:\d+ names server\/viewer\/design, which does not exist/,
					/^literals: src\/cadence\.ts:\d+ names server\/viewer\/design\/tokens\., which is the prefix of no file/,
					/^literals: biome\.json:files\.includes\[2\] names server\/viewer\/design\/tokens\.json, which does not exist/,
				],
			},
			{
				category: "workflow identities",
				target: ".github/workflows/ci.yml",
				expect: [
					/^literals: src\/validation\.ts:\d+ names \.github\/workflows\/ci\.yml, which does not exist/,
				],
			},
			{
				category: "config roots",
				target: "extension",
				expect: [
					/^literals: tsconfig\.json:include\[1\] names extension, which is not a directory/,
					/^literals: package\.json:scripts\.lint names extension, which is not a directory/,
					/^literals: package\.json:scripts\.format names extension, which is not a directory/,
					/^literals: \.github\/factory\/gates\/gates\.json:checks\[1\]\.argv\[\d+\] names extension, which is not a directory/,
				],
			},
			{
				category: "lint plugins",
				target: "tools/oxlint/anti-slop/index.ts",
				expect: [
					/^literals: \.oxlintrc\.json:jsPlugins\[0\]\.specifier names tools\/oxlint\/anti-slop\/index\.ts, which does not exist/,
				],
			},
		] as const;

		for (const move of moves)
			it(`fails ${move.category} when ${move.target} moves`, () => {
				const root = scratch();
				renameSync(join(root, move.target), join(root, `${move.target}.moved`));
				const problems = layout(root, "literals");

				for (const pattern of move.expect) includesMatch(problems, pattern);
			});

		it("leaves synthetic paths in a new test alone", () => {
			const root = scratch();
			write(
				root,
				"test/newfeature.test.ts",
				[
					'import assert from "node:assert/strict";',
					'import { it } from "node:test";',
					'it("plans a fake diff", () => {',
					'\tconst paths = ["src/widget.ts", "server/gadget.ts", "test/foo.test.ts", ".github/workflows/x.yml"];',
					"\tassert.equal(paths.length, 4);",
					"});",
					"",
				].join("\n"),
			);

			assert.deepEqual(run(guard, root).problems, []);
		});

		it("fails a new unresolved literal and an allowlist entry nothing needs", () => {
			const root = scratch();
			appendFileSync(
				join(root, "src/core/run.ts"),
				'export const NOWHERE = "src/nowhere.ts";\n',
			);
			edit(
				root,
				"scripts/layout-baseline.json",
				/"allow": \[\n/,
				'"allow": [\n{ "reason": "stale", "files": ["src/**"], "paths": ["src/stale.ts"], "globs": ["src/stale/**"] },\n',
			);

			const problems = layout(root, "literals");
			includesMatch(
				problems,
				/^literals: src\/core\/run\.ts:\d+ names src\/nowhere\.ts, which does not exist; fix the path, or add it to literals\.allow/,
			);
			includesMatch(
				problems,
				/^literals: allow entry "stale" lists src\/stale\.ts, which no scanned literal still needs; delete it$/,
			);
			includesMatch(
				problems,
				/^literals: allow entry "stale" lists src\/stale\/\*\*, which no scanned literal still needs; delete it$/,
			);
		});

		it("fails a tsconfig include that matches no file", () => {
			const root = scratch();
			edit(
				root,
				"tsconfig.json",
				'"docs/statecharts"]',
				'"docs/statecharts", "tests/**/*.ts"]',
			);

			includesMatch(
				layout(root, "literals"),
				/^literals: tsconfig\.json:include\[6\] tests\/\*\*\/\*\.ts matches no file, so typecheck silently skips it$/,
			);
		});
	});

	describe("shell", () => {
		it("fails added, removed and dangling path tokens", () => {
			const root = scratch();
			appendFileSync(
				join(root, ".pi/skills/verify-factory/scripts/drive-serve.sh"),
				"node server/new-entry.ts\n",
			);
			edit(
				root,
				"server/factory.service",
				"node server/cli.ts serve",
				"node host/cli/index.ts serve",
			);
			rmSync(join(root, "server/provision.sh"));
			write(
				root,
				".pi/skills/verify-factory/scripts/new-driver.sh",
				"#!/bin/sh\n",
			);

			const problems = layout(root, "shell");
			includesMatch(
				problems,
				/^shell: \.pi\/skills\/verify-factory\/scripts\/drive-serve\.sh has unclassified path token server\/new-entry\.ts$/,
			);
			includesMatch(
				problems,
				/^shell: server\/factory\.service no longer has path token server\/cli\.ts$/,
			);
			includesMatch(
				problems,
				/^shell: server\/factory\.service has unclassified path token host\/cli\/index\.ts$/,
			);
			includesMatch(
				problems,
				/^shell: server\/install-exe-dev\.sh token server\/provision\.sh names server\/provision\.sh, which is missing, expected file$/,
			);
			includesMatch(
				problems,
				/^shell: \.pi\/skills\/verify-factory\/scripts\/new-driver\.sh is not inventoried/,
			);
		});

		it("fails workflow and scripts shell tokens whose targets move", () => {
			const root = scratch();
			renameSync(join(root, "server/cli.ts"), join(root, "server/cli.moved"));
			renameSync(
				join(root, "research/PROVENANCE.md"),
				join(root, "research/PROVENANCE.moved"),
			);

			const problems = layout(root, "shell");
			includesMatch(
				problems,
				/^shell: \.github\/workflows\/ci\.yml token server\/cli\.ts names server\/cli\.ts, which is missing, expected file$/,
			);
			includesMatch(
				problems,
				/^shell: scripts\/provenance\.sh token research\/PROVENANCE\.md names research\/PROVENANCE\.md, which is missing, expected file$/,
			);
		});

		it("fails a heredoc import whose name the target no longer exports", () => {
			const root = scratch();
			const script = ".pi/skills/verify-factory/scripts/drive-replay.sh";
			appendFileSync(
				join(root, script),
				"node --input-type=module - <<'NODE'\nimport { readLock } from './server/controller.ts';\nNODE\n",
			);
			edit(
				root,
				"scripts/layout-baseline.json",
				`"${script}": {\n\t\t\t\t"tokens": {`,
				`"${script}": {\n\t\t\t\t"imports": { "./server/controller.ts": ["readLock"] },\n\t\t\t\t"tokens": {\n\t\t\t\t\t"./server/controller.ts": { "path": "server/controller.ts", "type": "file" },`,
			);
			assert.deepEqual(layout(root, "shell"), []);
			edit(
				root,
				"server/controller.ts",
				"export async function readLock(",
				"async function readLock(",
			);

			includesMatch(
				layout(root, "shell"),
				/^shell: \.pi\/skills\/verify-factory\/scripts\/drive-replay\.sh imports readLock from \.\/server\/controller\.ts, but server\/controller\.ts does not export it$/,
			);
		});
	});

	describe("discovery", () => {
		it("fails tests outside runner discovery and cases imported other than once", () => {
			const root = scratch();
			write(
				root,
				"test/sandbox/stray.test.ts",
				'import { it } from "node:test";\nit("never runs", () => {});\n',
			);
			write(root, "src/colocated.test.ts", "");
			write(root, "test/sandbox/orphan.cases.ts", "");
			appendFileSync(
				join(root, "test/policy.test.ts"),
				'import "./sandbox/audit.cases.ts";\n',
			);
			write(root, "test/acceptance/999/checks/held.test.ts", "");
			write(root, "test/fixtures/payload/x.test.ts", "");

			const problems = layout(root, "discovery");
			includesMatch(
				problems,
				/^discovery: test\/sandbox\/stray\.test\.ts is a test outside runner discovery/,
			);
			includesMatch(
				problems,
				/^discovery: src\/colocated\.test\.ts is a test outside runner discovery/,
			);
			includesMatch(
				problems,
				/^discovery: test\/sandbox\/orphan\.cases\.ts is registered by 0 bare imports/,
			);
			includesMatch(
				problems,
				/^discovery: test\/sandbox\/orphan\.cases\.ts runs under 0 discovered tests/,
			);
			includesMatch(
				problems,
				/^discovery: test\/sandbox\/audit\.cases\.ts is registered by 2 bare imports \(test\/policy\.test\.ts, test\/sandbox\.test\.ts\)/,
			);
			includesMatch(
				problems,
				/^discovery: test\/sandbox\/audit\.cases\.ts runs under 2 discovered tests/,
			);
			assert.ok(
				!problems.some((p) => /acceptance|fixtures/.test(p)),
				problems.join("\n"),
			);
		});

		it("does not count an erased type-only import as running a cases file", () => {
			const line = 'import "./sandbox/audit.cases.ts";';
			const direct = scratch();
			edit(
				direct,
				"test/sandbox.test.ts",
				line,
				'import type {} from "./sandbox/audit.cases.ts";',
			);

			const problems = layout(direct, "discovery");
			includesMatch(
				problems,
				/^discovery: test\/sandbox\/audit\.cases\.ts is registered by 0 bare imports/,
			);
			includesMatch(
				problems,
				/^discovery: test\/sandbox\/audit\.cases\.ts runs under 0 discovered tests/,
			);

			const helper = scratch();
			write(helper, "test/sandbox/registry.ts", 'import "./audit.cases.ts";\n');
			edit(
				helper,
				"test/sandbox.test.ts",
				line,
				'import type {} from "./sandbox/registry.ts";',
			);

			includesMatch(
				layout(helper, "discovery"),
				/^discovery: test\/sandbox\/audit\.cases\.ts runs under 0 discovered tests \(none\), expected exactly 1$/,
			);
		});

		it("fails when trusted discovery and the local runner disagree", () => {
			const manifest = ".github/factory/gates/gates.json";
			const empty = scratch();
			edit(empty, manifest, /"testGlobs": \[[^\]]*\]/, '"testGlobs": []');

			const emptied = layout(empty, "discovery");
			includesMatch(
				emptied,
				/^discovery: \.github\/factory\/gates\/gates\.json testGlobs is empty or not a list of globs, so the trusted gate refuses the manifest$/,
			);
			includesMatch(
				emptied,
				/^discovery: test\/layout\.test\.ts runs under the local runner but not under trusted discovery \(testGlobs: none\)$/,
			);

			const prefix = scratch();
			edit(
				prefix,
				"server/gates.ts",
				'path.startsWith("test/") &&\n\t\t\t(!base.has(path)',
				'path.startsWith("tests/") &&\n\t\t\t(!base.has(path)',
			);

			includesMatch(
				layout(prefix, "discovery"),
				/^discovery: server\/gates\.ts has 0 of the trusted test predicate "path\.startsWith\(\\"test\/\\"\) && .*", expected 1/,
			);

			const twice = scratch();
			edit(
				twice,
				manifest,
				'"test/integration/*.test.ts"',
				'"test/integration/*.test.ts", "test/integration/*.test.ts"',
			);

			includesMatch(
				layout(twice, "discovery"),
				/^discovery: \.github\/factory\/gates\/gates\.json lists testGlob test\/integration\/\*\.test\.ts more than once, so the trusted gate refuses the manifest$/,
			);

			const moved = scratch();
			renameSync(
				join(moved, "server/gates.ts"),
				join(moved, "server/gates.moved"),
			);

			includesMatch(
				layout(moved, "discovery"),
				/^discovery: server\/gates\.ts is missing, so the trusted test selection cannot be checked; audit the moved or changed test selection code, then update discovery\.trusted\.materializer and discovery\.trusted\.predicates in scripts\/layout-baseline\.json$/,
			);

			const nested = scratch();
			edit(
				nested,
				"package.json",
				"test/*.test.ts",
				"test/*.test.ts test/sandbox/*.test.ts",
			);
			write(
				nested,
				"test/sandbox/nested.test.ts",
				'import { it } from "node:test";\nit("runs locally only", () => {});\n',
			);
			edit(
				nested,
				manifest,
				'"test/integration/*.test.ts"',
				'"test/integration/*.test.ts", "test/fixtures/**/*.test.ts"',
			);

			const split = layout(nested, "discovery");
			includesMatch(
				split,
				/^discovery: test\/sandbox\/nested\.test\.ts runs under the local runner but not under trusted discovery/,
			);
			includesMatch(
				split,
				/^discovery: \.github\/factory\/gates\/gates\.json testGlob test\/fixtures\/\*\*\/\*\.test\.ts is refused by server\/gates\.ts/,
			);
		});
	});

	describe("navigation", () => {
		it("fails a maintained folder without a README", () => {
			const root = scratch();
			rmSync(join(root, "docs/README.md"));
			rmSync(join(root, ".pi/skills/README.md"));
			write(root, "newdir/notes.txt", "x\n");

			const problems = layout(root, "navigation");
			assert.deepEqual(problems, [
				"navigation: .pi/skills/ has no README.md",
				"navigation: docs/ has no README.md",
				"navigation: newdir/ has no README.md",
			]);
		});

		it("fails a README without a full sentence", () => {
			const root = scratch();
			write(root, "tools/README.md", "");
			write(root, "research/README.md", "# Research\n\n- notes\n");

			assert.deepEqual(layout(root, "navigation"), [
				"navigation: research/README.md has no full sentence; say what the folder holds and where new things go",
				"navigation: tools/README.md has no full sentence; say what the folder holds and where new things go",
			]);
		});
	});

	describe("citations", () => {
		it("fails missing and out-of-range current citations and checks pinned ones by form", () => {
			const root = scratch();
			const lines = read(root, "src/core/run.ts").split("\n").length - 1;

			appendFileSync(
				join(root, "docs/operations/viewer.md"),
				[
					"See `src/missing.ts:3`.",
					`See \`src/core/run.ts:${lines + 1}\` and \`src/core/run.ts\` line ${lines + 5}.`,
					`See \`src/core/run.ts:${lines}\` and 5bd77d5:src/gone.ts:12.`,
					"See 5bd77d5:src/gone.ts:0.",
					"",
				].join("\n"),
			);

			appendFileSync(
				join(root, "docs/handoff.md"),
				"See `src/missing.ts:3`.\n",
			);
			edit(
				root,
				"docs/operations/sandbox.md",
				"at `f88069f`.",
				"at `abc1234`.",
			);

			const problems = layout(root, "citations");
			const viewer = lineCountOf(read(pristine, "docs/operations/viewer.md"));

			assert.deepEqual(
				problems.sort(),
				[
					`citations: docs/operations/sandbox.md is listed as pinned to f88069f, but no longer says "Repo paths are relative to \`pi-herdr-factorio/\` at \`f88069f\`."`,
					`citations: docs/operations/viewer.md:${viewer + 1} cites src/missing.ts, which does not exist`,
					`citations: docs/operations/viewer.md:${viewer + 2} cites src/core/run.ts:${lines + 1}, but the file has ${lines} lines`,
					`citations: docs/operations/viewer.md:${viewer + 2} cites src/core/run.ts:${lines + 5}, but the file has ${lines} lines`,
					`citations: docs/operations/viewer.md:${viewer + 4} cites src/gone.ts:0, which is not a valid citation`,
				].sort(),
			);
		});
	});

	it("passes both guards in a real depth-1 clone without fetching", () => {
		const source = temp("layout-source-");
		copyTree(source);

		const git = (cwd: string, ...args: string[]) =>
			execFileSync("git", ["-C", cwd, ...args], {
				encoding: "utf8",
				env: {
					...process.env,
					GIT_AUTHOR_NAME: "layout",
					GIT_AUTHOR_EMAIL: "layout@example.invalid",
					GIT_COMMITTER_NAME: "layout",
					GIT_COMMITTER_EMAIL: "layout@example.invalid",
				},
			});

		git(source, "init", "--quiet");
		git(source, "add", "-A");
		git(source, "commit", "--quiet", "-m", "parent");
		git(source, "commit", "--quiet", "--allow-empty", "-m", "head");

		const clone = join(temp("layout-clone-"), "repo");
		execFileSync("git", [
			"clone",
			"--quiet",
			"--depth",
			"1",
			`file://${source}`,
			clone,
		]);
		assert.equal(
			git(clone, "rev-parse", "--is-shallow-repository").trim(),
			"true",
		);
		assert.equal(
			spawnSync("git", ["-C", clone, "cat-file", "-e", "HEAD^"]).status,
			128,
		);
		symlinkSync(join(repo, "node_modules"), join(clone, "node_modules"));

		for (const script of [guard, decisions]) {
			const result = spawnSync(
				process.execPath,
				[
					"--experimental-strip-types",
					join(clone, script.slice(repo.length)),
					"--json",
				],
				{
					encoding: "utf8",
					env: { ...process.env, GIT_ALLOW_PROTOCOL: "none" },
				},
			);

			assert.equal(result.stdout.trim(), "[]", result.stderr);
			assert.equal(result.status, 0);
		}
	});
});

function lineCountOf(text: string): number {
	return text.endsWith("\n")
		? text.split("\n").length - 1
		: text.split("\n").length;
}
