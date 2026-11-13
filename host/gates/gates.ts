import { isUtf8 } from "node:buffer";
import { createHash } from "node:crypto";
import {
	cpSync,
	existsSync,
	mkdirSync,
	mkdtempSync,
	readFileSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { parseArgs } from "node:util";
import { scanSource, type Signal } from "../../.github/factory/gates/scan.ts";
import { isGitSha } from "../../src/config/schema.ts";
import { readStoredContract } from "../../src/contract/artifacts.ts";
import type { ReplacedTest } from "../../src/contract/contract.ts";
import {
	arrayOf,
	fieldOf,
	objectOf,
	parseJson,
	textOf,
} from "../../src/core/json.ts";
import { isDigest } from "../../src/core/run.ts";
import { countsOf, heldoutProjection } from "./base.ts";
import {
	CHECK_NAMES,
	manifestOf,
	readDependencies,
	validateDependencies,
} from "./manifest.ts";
import {
	entries,
	exportTree,
	git,
	heldoutOf,
	materializeCandidate,
	replacementDigest,
	replacementsOf,
	SHA,
	SOURCE,
} from "./materialize.ts";
import {
	command,
	dockerRunner,
	type GateRunner,
	install,
	localRunner,
	prefetch,
	type Result,
	testArgv,
} from "./runner.ts";

const GATE_TEST_CONCURRENCY = 3;

type GateCheck = {
	readonly name: string;
	readonly exitCode: number;
	readonly durationMs: number;
	readonly deadlineMs?: number;
	readonly timedOut?: boolean;
	readonly signal?: string | null;
};

export type GateReceipt = {
	readonly version: 2;
	readonly requiredChecks: string[];
	tamperSignals: readonly Signal[];
	heldoutDigest: string | null;
	heldoutCounts: Readonly<Record<string, number>>;
	heldoutFailures: readonly string[];
	readonly gateSha: string;
	readonly candidateSha: string;
	readonly nonce: string;
	readonly runner: string;
	status: "passed" | "failed" | "incomplete";
	reason: string | null;
	readonly checks: GateCheck[];
	ignoredChanges: readonly string[];
	replacedTests: readonly (ReplacedTest & {
		beforeDigest: string;
		afterDigest: string;
	})[];
	replacementsDigest: string;
	dependencies: { added: string[]; removed: string[]; changed: string[] };
	newDependency: boolean;
	installScripts: readonly string[];
	baselineCounts: Readonly<Record<string, number>>;
	candidateCounts: Readonly<Record<string, number>>;
	wallMs: number;
	readonly modelCalls: 0;
};

export type CandidateInput = {
	readonly repository: string;
	readonly gateSha: string;
	readonly candidateSha: string;
	readonly nonce: string;
	readonly output: string;
	readonly runner: GateRunner;
	readonly install?: boolean;
	readonly replacements?: readonly ReplacedTest[];
	readonly replacementsDigest?: string;
	readonly heldoutDir?: string;
	readonly heldoutDigest?: string;
};

function sameCounts(
	base: Readonly<Record<string, number>>,
	candidate: Readonly<Record<string, number>>,
	replacements: readonly ReplacedTest[],
): boolean {
	const except = new Set(replacements.map((r) => r.path));

	for (const path of new Set([...Object.keys(base), ...Object.keys(candidate)]))
		if (!except.has(path) && base[path] !== candidate[path]) return false;

	return replacements.every((r) => (candidate[r.path] ?? 0) >= 1);
}

export function receiptPasses(receipt: GateReceipt): boolean {
	const required = [
		"baseline_tests",
		...CHECK_NAMES,
		"main_tests",
		"candidate_tests",
		...(receipt.heldoutDigest ? ["heldout"] : []),
	];

	return (
		receipt.version === 2 &&
		required.every((name) => receipt.requiredChecks.includes(name)) &&
		new Set(receipt.requiredChecks).size === receipt.requiredChecks.length &&
		receipt.requiredChecks.every(
			(name) => receipt.checks.filter((c) => c.name === name).length === 1,
		) &&
		receipt.checks.every((c) => c.exitCode === 0) &&
		receipt.checks.length === receipt.requiredChecks.length
	);
}

async function scanCandidate(
	input: CandidateInput,
	baseline: string,
	tree: string,
	replacements: readonly ReplacedTest[],
	heldout: readonly string[],
): Promise<Signal[]> {
	const base = await entries(input.repository, input.gateSha);
	const candidate = await entries(input.repository, input.candidateSha);
	const result: Signal[] = [];
	const encoding: Signal[] = [];

	for (const [path, entry] of candidate) {
		if (
			!/\.[cm]?[jt]sx?$/.test(path) ||
			!existsSync(join(tree, path)) ||
			(!SOURCE.some((dir) => path.startsWith(`${dir}/`)) &&
				!(
					path.startsWith("test/") &&
					(!base.has(path) ||
						replacements.some((r) => r.path === path) ||
						heldout.includes(path))
				))
		)
			continue;

		const bytes = readFileSync(join(tree, path));
		const text = bytes.toString("utf8");

		if (
			!isUtf8(bytes) ||
			bytes.includes(0) ||
			/[\u2028\u2029]|\r(?!\n)/.test(text)
		) {
			encoding.push({ path, line: 0, rule: "invalid_source_encoding" });

			continue;
		}

		if (encoding.length > 0) continue;

		if (base.get(path)?.blob === entry.blob && !heldout.includes(path))
			continue;
		const changed = new Set<number>();

		if (!base.has(path) || heldout.includes(path))
			text.split("\n").forEach((_, i) => {
				changed.add(i + 1);
			});
		else {
			const diff = await git(input.repository, [
				"diff",
				"--no-ext-diff",
				"--no-textconv",
				"--text",
				"--unified=0",
				input.gateSha,
				input.candidateSha,
				"--",
				path,
			]);

			for (const match of diff.matchAll(
				/^@@ -\d+(?:,\d+)? \+(\d+)(?:,(\d+))? @@/gm,
			)) {
				const first = Number(match[1]),
					count = Number(match[2] ?? "1");

				for (let line = first; line < first + count; line++) changed.add(line);
			}
		}

		result.push(
			...scanSource(
				path,
				text,
				changed,
				join(baseline, ".github/factory/gates/scan-rules.json"),
			).filter(
				(s) => !heldout.includes(path) || s.rule !== "suppression_added",
			),
		);
	}

	return encoding.length > 0 ? encoding : result;
}

export async function checkCandidate(
	input: CandidateInput,
): Promise<GateReceipt> {
	const start = Date.now();

	const receipt: GateReceipt = {
		version: 2,
		requiredChecks: [
			...(input.install === false ? [] : ["install"]),
			"baseline_tests",
			...CHECK_NAMES,
			"main_tests",
			"candidate_tests",
			...(input.heldoutDir || input.heldoutDigest ? ["heldout"] : []),
		],
		tamperSignals: [],
		heldoutDigest: input.heldoutDigest ?? null,
		heldoutCounts: {},
		heldoutFailures: [],
		gateSha: input.gateSha,
		candidateSha: input.candidateSha,
		nonce: input.nonce,
		runner: input.runner.kind,
		status: "incomplete",
		reason: null,
		checks: [],
		ignoredChanges: [],
		replacedTests: [],
		replacementsDigest: replacementDigest([]),
		dependencies: { added: [], removed: [], changed: [] },
		newDependency: false,
		installScripts: [],
		baselineCounts: {},
		candidateCounts: {},
		wallMs: 0,
		modelCalls: 0,
	};

	mkdirSync(input.output, { recursive: true, mode: 0o755 });
	const temp = mkdtempSync(join(tmpdir(), "factory-gate-"));

	const baseline = join(temp, "baseline"),
		tree = join(temp, "tree"),
		gates = join(temp, "gates");

	let deadlineMs = 180000;

	const run = async (name: string, source: string, argv: readonly string[]) => {
		const began = Date.now();

		const result = await input.runner
			.run({
				tree: source,
				gates,
				argv,
				deadlineMs,
			})
			.catch(() => {
				throw new Error("runner_error");
			});

		if (name !== "heldout")
			writeFileSync(
				join(input.output, `${name}.log`),
				result.stdout + result.stderr,
			);

		if (
			result.runnerError ||
			(input.runner.kind === "docker" &&
				[125, 126, 127].includes(result.exitCode))
		)
			throw new Error("runner_error");

		const check = {
			name,
			exitCode: result.exitCode,
			durationMs: Date.now() - began,
			deadlineMs,
			timedOut: result.timedOut ?? false,
			signal: result.signal ?? null,
		};

		receipt.checks.push(check);

		return { result, check };
	};

	try {
		if (
			!SHA.test(input.gateSha) ||
			!SHA.test(input.candidateSha) ||
			!/^[a-zA-Z0-9_-]{1,100}$/.test(input.nonce)
		)
			throw new Error("invalid_input");

		const ancestor = await command(
			"git",
			[
				"-C",
				resolve(input.repository),
				"merge-base",
				"--is-ancestor",
				input.gateSha,
				input.candidateSha,
			],
			input.repository,
		);

		if (ancestor.exitCode !== 0) throw new Error("stale_base");

		const replacements = replacementsOf(
			JSON.stringify(input.replacements ?? []),
		);

		const digest = replacementDigest(replacements);

		if ((input.replacementsDigest ?? replacementDigest([])) !== digest)
			throw new Error("replacement_digest_mismatch");
		receipt.replacementsDigest = digest;
		await exportTree(input.repository, input.gateSha, baseline);
		const manifest = manifestOf(baseline);

		const material = await materializeCandidate({
			...input,
			dest: tree,
			replacements,
		});

		receipt.ignoredChanges = material.ignoredChanges;
		receipt.replacedTests = replacements.map((r) => ({
			...r,
			beforeDigest: createHash("sha256")
				.update(readFileSync(join(baseline, r.path)))
				.digest("hex"),
			afterDigest: createHash("sha256")
				.update(readFileSync(join(tree, r.path)))
				.digest("hex"),
		}));
		const heldoutFiles = heldoutOf(tree, input.heldoutDir, input.heldoutDigest);
		receipt.tamperSignals = await scanCandidate(
			input,
			baseline,
			tree,
			replacements,
			heldoutFiles,
		);

		if (receipt.tamperSignals.length)
			throw new Error(
				receipt.tamperSignals.some((s) => s.rule === "invalid_source_encoding")
					? "invalid_source_encoding"
					: receipt.tamperSignals.some((s) => s.rule === "runtime_patching")
						? "runtime_patching"
						: "suppression_added",
			);
		mkdirSync(gates, { mode: 0o755 });
		cpSync(join(baseline, ".github/factory/gates"), gates, { recursive: true });
		cpSync(baseline, join(gates, "tooling"), { recursive: true });

		const lint =
			objectOf(
				parseJson(readFileSync(join(baseline, ".oxlintrc.json"), "utf8")),
			) ?? {};

		const plugins = arrayOf(fieldOf(lint, "jsPlugins")) ?? [];
		writeFileSync(
			join(gates, "lint.json"),
			JSON.stringify({
				...lint,
				jsPlugins: plugins.map((p) => {
					const obj = objectOf(p);
					const spec = textOf(fieldOf(obj, "specifier")) ?? "";

					return {
						...obj,
						specifier: spec.startsWith("./")
							? `/g/tooling/${spec.slice(2)}`
							: spec,
					};
				}),
			}),
		);
		const baseDeps = readDependencies(baseline);

		for (const name of ["package.json", "package-lock.json"])
			writeFileSync(
				join(temp, `candidate-${name}`),
				await git(input.repository, ["show", `${input.candidateSha}:${name}`]),
			);

		const manifestText = readFileSync(
				join(temp, "candidate-package.json"),
				"utf8",
			),
			lockText = readFileSync(
				join(temp, "candidate-package-lock.json"),
				"utf8",
			);

		const deps = validateDependencies(
			manifestText,
			lockText,
			readFileSync(join(baseline, "package-lock.json"), "utf8"),
		);

		const old = new Map(baseDeps.map((d) => [d.path, d])),
			current = new Map(deps.map((d) => [d.path, d]));

		receipt.dependencies = {
			added: deps.filter((d) => !old.has(d.path)).map((d) => d.path),
			removed: baseDeps.filter((d) => !current.has(d.path)).map((d) => d.path),
			changed: deps
				.filter((d) => {
					const prev = old.get(d.path);

					return (
						prev !== undefined &&
						(prev.integrity !== d.integrity || prev.version !== d.version)
					);
				})
				.map((d) => d.path),
		};
		receipt.newDependency = receipt.dependencies.added.length > 0;
		receipt.installScripts = [
			...new Set(
				[...baseDeps, ...deps].flatMap((d) =>
					d.installScript ? [`${d.path}@${d.version}`] : [],
				),
			),
		].sort();

		if (input.install !== false) {
			const archives = join(temp, "archives"),
				cache = join(temp, "cache");

			const began = Date.now();
			await prefetch([...baseDeps, ...deps], archives);
			let result: Result;

			if (baseDeps.length === 0 && deps.length === 0) {
				mkdirSync(join(baseline, "node_modules"));
				result = { exitCode: 0, stdout: "No packages\n", stderr: "" };
			} else
				result = await install(baseline, gates, archives, cache, input.runner);

			if (result.exitCode === 0)
				cpSync(
					join(baseline, "node_modules"),
					join(gates, "tooling/node_modules"),
					{ recursive: true, verbatimSymlinks: true },
				);

			if (
				result.exitCode === 0 &&
				lockText === readFileSync(join(baseline, "package-lock.json"), "utf8")
			)
				cpSync(join(baseline, "node_modules"), join(tree, "node_modules"), {
					recursive: true,
					verbatimSymlinks: true,
				});
			else if (result.exitCode === 0) {
				const installTree = join(temp, "install");
				mkdirSync(installTree);
				writeFileSync(join(installTree, "package.json"), manifestText);
				writeFileSync(join(installTree, "package-lock.json"), lockText);
				result = await install(
					installTree,
					gates,
					archives,
					cache,
					input.runner,
					true,
				);

				if (result.exitCode === 0)
					cpSync(
						join(installTree, "node_modules"),
						join(tree, "node_modules"),
						{ recursive: true, verbatimSymlinks: true },
					);
			}

			receipt.checks.push({
				name: "install",
				exitCode: result.exitCode,
				durationMs: Date.now() - began,
			});
			writeFileSync(
				join(input.output, "install.log"),
				result.stdout + result.stderr,
			);

			if (
				result.runnerError ||
				result.timedOut ||
				(input.runner.kind === "docker" &&
					[125, 126, 127].includes(result.exitCode))
			)
				throw new Error("runner_error");

			if (result.exitCode !== 0) throw new Error("install_failed");
		}

		const baselineRun = await run(
			"baseline_tests",
			baseline,
			testArgv(manifest.tests, false, GATE_TEST_CONCURRENCY),
		);

		const baseCounts = countsOf(baselineRun.result);

		if (baseCounts === null) {
			baselineRun.check.exitCode = 1;
			throw new Error("baseline_failed");
		}

		receipt.baselineCounts = baseCounts;
		deadlineMs = Math.max(90000, baselineRun.check.durationMs * 3 + 30000);

		for (const check of manifest.checks)
			await run(check.name, tree, check.argv);
		const mainTests = manifest.tests.filter((p) => existsSync(join(tree, p)));

		if (mainTests.length === 0) throw new Error("missing_tests");

		const candidateRun = await run(
			"main_tests",
			tree,
			testArgv(mainTests, false, GATE_TEST_CONCURRENCY),
		);

		const candidateCounts = countsOf(candidateRun.result);
		receipt.candidateCounts = candidateCounts ?? {};

		if (
			candidateCounts === null ||
			!sameCounts(baseCounts, candidateCounts, replacements)
		)
			candidateRun.check.exitCode = 1;

		if (material.newTests.length > 0) {
			const extra = await run(
				"candidate_tests",
				tree,
				testArgv(material.newTests),
			);

			if (countsOf(extra.result) === null) extra.check.exitCode = 1;
		} else
			receipt.checks.push({
				name: "candidate_tests",
				exitCode: 0,
				durationMs: 0,
			});

		if (heldoutFiles.length) {
			const heldout = await run("heldout", tree, testArgv(heldoutFiles));
			const projection = heldoutProjection(heldout.result, heldoutFiles);
			receipt.heldoutCounts = projection.counts;
			receipt.heldoutFailures = projection.failed;

			if (!projection.passed) heldout.check.exitCode = 1;
		}

		for (const timed of receipt.checks.filter((c) => c.timedOut)) {
			const name = `${timed.name}_deadline_control`;
			receipt.requiredChecks.push(name);

			const control = await run(
				name,
				baseline,
				manifest.checks.find((c) => c.name === timed.name)?.argv ??
					testArgv(manifest.tests, false, GATE_TEST_CONCURRENCY),
			);

			if (control.result.timedOut) throw new Error("baseline_deadline");

			if (control.result.exitCode !== 0) throw new Error("baseline_failed");
		}

		receipt.status = receiptPasses(receipt) ? "passed" : "failed";
	} catch (error) {
		receipt.reason = error instanceof Error ? error.message : "gate_error";
		receipt.status =
			/^(?:npmrc_changed|runtime_patching|suppression_added|invalid_source_encoding|unauthorized_acceptance|package_swap|replacement_deleted|invalid_dependency_|dependency_integrity|install_failed|unsafe_tree|heldout_digest_mismatch)/.test(
				receipt.reason,
			)
				? "failed"
				: "incomplete";
	} finally {
		receipt.wallMs = Date.now() - start;
		writeFileSync(
			join(input.output, "receipt.json"),
			`${JSON.stringify(receipt, null, 2)}\n`,
		);
		rmSync(temp, { recursive: true, force: true });
	}

	return receipt;
}

export async function runGatesCli(
	argv: readonly string[],
	io: { stdout(text: string): void; stderr(text: string): void },
): Promise<number> {
	try {
		const { values, positionals } = parseArgs({
			args: [...argv],
			strict: true,
			options: {
				repository: { type: "string" },
				"gate-sha": { type: "string" },
				"candidate-sha": { type: "string" },
				nonce: { type: "string" },
				output: { type: "string" },
				runner: { type: "string" },
				replacements: { type: "string" },
				"replacements-digest": { type: "string" },
				"state-dir": { type: "string" },
				"run-id": { type: "string" },
				"contract-digest": { type: "string" },
				"heldout-dir": { type: "string" },
				"heldout-digest": { type: "string" },
			},
		});

		if (
			positionals.length ||
			!values.repository ||
			!values["gate-sha"] ||
			!values["candidate-sha"] ||
			!values.nonce ||
			!values.output ||
			!isGitSha(values["gate-sha"]) ||
			!isGitSha(values["candidate-sha"])
		)
			throw new Error(
				"gates requires --repository, --gate-sha, --candidate-sha, --nonce and --output",
			);

		let replacements = replacementsOf(values.replacements ?? "[]"),
			digest = values["replacements-digest"];

		if (values["state-dir"] || values["run-id"] || values["contract-digest"]) {
			const runId = values["run-id"] ?? "",
				contractDigest = values["contract-digest"] ?? "";

			if (
				!values["state-dir"] ||
				!isDigest(runId) ||
				!isDigest(contractDigest) ||
				values.replacements ||
				digest
			)
				throw new Error("invalid_private_contract_input");
			const stored = readStoredContract(values["state-dir"], runId);

			if (stored.kind !== "found" || stored.digest !== contractDigest)
				throw new Error("private_contract_unavailable");
			replacements = stored.contract.replacesTests ?? [];
			digest = replacementDigest(replacements);
		}

		if (
			values.runner !== undefined &&
			values.runner !== "docker" &&
			values.runner !== "local"
		)
			throw new Error("invalid_runner");

		const receipt = await checkCandidate({
			repository: resolve(values.repository),
			gateSha: values["gate-sha"],
			candidateSha: values["candidate-sha"],
			nonce: values.nonce,
			output: resolve(values.output),
			runner: values.runner === "local" ? localRunner : dockerRunner,
			replacements,
			replacementsDigest: digest,
			heldoutDir: values["heldout-dir"],
			heldoutDigest: values["heldout-digest"],
		});

		io.stdout(`${JSON.stringify(receipt, null, 2)}\n`);

		return receipt.status === "passed" ? 0 : 1;
	} catch (error) {
		io.stderr(
			`${error instanceof Error ? error.message : "invalid_gates_input"}\n`,
		);

		return 2;
	}
}
