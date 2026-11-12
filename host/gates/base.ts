import {
	cpSync,
	lstatSync,
	mkdirSync,
	readdirSync,
	readFileSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { scanSource, type Signal } from "../../.github/factory/gates/scan.ts";
import {
	BASE_PROTOCOL_VERSION,
	oracleKey,
	runtimeCause,
	SCAN_RULES,
	type BaseEvidence,
	type DraftDetail,
	type HeldoutProjection,
	type HeldoutReplay,
	type PrivateExecution,
	type SuiteSignal,
	type TestFailure,
	type TreeReplay,
} from "../../src/candidate/diagnosis.ts";
import {
	acceptanceEntries,
	type AcceptanceBinding,
	type AcceptanceSuite,
} from "../../src/contract/acceptance.ts";
import type { Contract } from "../../src/contract/contract.ts";
import {
	arrayOf,
	countOf,
	fieldOf,
	objectOf,
	parseJson,
	textOf,
	textsOf,
	type JsonObject,
} from "../../src/core/json.ts";
import { digestOf } from "../../src/core/run.ts";
import { ACCEPTANCE_SUITE_PREFIX } from "../../src/trust/protected-paths.ts";

import {
	type Dependency,
	readDependencies,
	validateDependencies,
} from "./manifest.ts";
import { heldoutOf, safePath } from "./materialize.ts";
import {
	CLEAN_ENV,
	command,
	dependencyCache,
	type GateRunner,
	localRunner,
	type Result,
	testArgv,
} from "./runner.ts";

function privateExecution(
	result: Result,
	files: readonly string[],
	wallMs: number,
): PrivateExecution {
	if (result.timedOut)
		return { kind: "unavailable", reason: "timeout", wallMs };

	if (result.runnerError || result.exitCode > 1)
		return { kind: "unavailable", reason: "runner_error", wallMs };
	const summary = objectOf(parseJson(result.stdout.trim()));
	const counts = objectOf(fieldOf(summary, "counts"));
	const raw = arrayOf(fieldOf(summary, "failures"));

	if (
		result.stdout.length > 1024 * 1024 ||
		fieldOf(summary, "complete") !== true ||
		fieldOf(summary, "invalid") !== false ||
		fieldOf(summary, "truncated") !== false ||
		counts === null ||
		raw === null
	)
		return { kind: "unavailable", reason: "invalid_report", wallMs };
	const failures: TestFailure[] = [];

	for (const value of raw) {
		const f = objectOf(value);
		const file = textOf(fieldOf(f, "file"));
		const name = textOf(fieldOf(f, "name"));
		const message = textOf(fieldOf(f, "message"));
		const code = fieldOf(f, "code");
		const kind = fieldOf(f, "kind");

		if (
			file === null ||
			!files.includes(file) ||
			name === null ||
			name.length > 300 ||
			message === null ||
			message.length > 200 ||
			(code !== null && textOf(code) === null) ||
			(kind !== "assertion" &&
				kind !== "runtime_error" &&
				kind !== "load_error" &&
				kind !== "timeout" &&
				kind !== "skip" &&
				kind !== "todo" &&
				kind !== "cancelled")
		)
			return { kind: "unavailable", reason: "invalid_report", wallMs };
		failures.push({ file, name, message, code: textOf(code), kind });
	}

	if (
		Object.keys(counts).some((p) => !files.includes(p)) ||
		files.some(
			(p) =>
				fieldOf(counts, p) !== undefined &&
				countOf(fieldOf(counts, p)) === null,
		) ||
		(result.exitCode !== 0 && failures.length === 0) ||
		(fieldOf(summary, "bad") === true &&
			failures.length === 0 &&
			files.some((p) => (countOf(fieldOf(counts, p)) ?? 0) > 0))
	)
		return { kind: "unavailable", reason: "invalid_report", wallMs };

	return {
		kind: "observed",
		exitCode: result.exitCode,
		wallMs,
		files: files.map((file) => ({
			file,
			registered: countOf(fieldOf(counts, file)) ?? 0,
			failures: failures.filter((f) => f.file === file),
		})),
	};
}

export function countsOf(
	result: Result,
): Readonly<Record<string, number>> | null {
	const value = objectOf(parseJson(result.stdout.trim()));
	const counts = objectOf(fieldOf(value, "counts"));

	if (
		result.exitCode !== 0 ||
		fieldOf(value, "complete") !== true ||
		fieldOf(value, "bad") !== false ||
		counts === null ||
		Object.keys(counts).length === 0
	)
		return null;
	const found: Record<string, number> = {};

	for (const [path, count] of Object.entries(counts)) {
		const number = countOf(count);

		if (!safePath(path) || number === null || number === 0) return null;
		found[path] = number;
	}

	return found;
}

export function parseDraftDetails(
	text: string,
	files: readonly string[],
): readonly DraftDetail[] | null {
	if (Buffer.byteLength(text) > 1024 * 1024) return null;
	const value = objectOf(parseJson(text.trim()));
	const raw = arrayOf(fieldOf(value, "failures"));

	if (
		fieldOf(value, "complete") !== true ||
		fieldOf(value, "invalid") !== false ||
		fieldOf(value, "truncated") !== false ||
		raw === null ||
		raw.length > 1000
	)
		return null;
	const details: DraftDetail[] = [];

	for (const item of raw) {
		const v = objectOf(item),
			file = textOf(fieldOf(v, "file")),
			name = textOf(fieldOf(v, "name")),
			message = textOf(fieldOf(v, "message")),
			kind = fieldOf(v, "kind"),
			code = fieldOf(v, "code"),
			causes = textsOf(fieldOf(v, "causes")),
			at = textsOf(fieldOf(v, "at"));

		if (
			file === null ||
			!files.includes(file) ||
			name === null ||
			name.length > 300 ||
			message === null ||
			message.length > 300 ||
			(code !== null &&
				(textOf(code) === null || (textOf(code)?.length ?? 0) > 100)) ||
			causes === null ||
			causes.length > 3 ||
			causes.some(
				(c) => c.length > 200 || !/^(?:[A-Z][A-Za-z]*Error\b|Error:)/.test(c),
			) ||
			at === null ||
			at.length > 3 ||
			at.some(
				(f) =>
					f.length > 400 ||
					!/^\/w\/test\/acceptance\/[A-Za-z0-9_-]+\/checks\/[A-Za-z0-9_./-]+:\d+:\d+$/.test(
						f,
					),
			) ||
			(kind !== "assertion" &&
				kind !== "runtime_error" &&
				kind !== "load_error" &&
				kind !== "timeout" &&
				kind !== "skip" &&
				kind !== "todo" &&
				kind !== "cancelled")
		)
			return null;
		details.push({ file, name, kind, code: textOf(code), message, causes, at });
	}

	return details;
}

function publicFailurePaths(
	summary: JsonObject | null,
	files: readonly string[],
): readonly string[] {
	return [
		...new Set(
			(arrayOf(fieldOf(summary, "failures")) ?? [])
				.map((f) => textOf(fieldOf(objectOf(f), "file")) ?? "")
				.filter((p) => files.includes(p)),
		),
	];
}

export function heldoutProjection(
	result: Result,
	files: readonly string[],
): HeldoutProjection {
	const summary = objectOf(parseJson(result.stdout.trim()));
	const counts = objectOf(fieldOf(summary, "counts"));

	const projected = Object.fromEntries(
		files.map((p) => [p, countOf(fieldOf(counts, p)) ?? 0]),
	);

	const passed = countsOf(result) !== null && files.every((p) => projected[p]);
	const failed = publicFailurePaths(summary, files);

	return {
		counts: projected,
		failed: !passed && failed.length === 0 ? [...files] : failed,
		passed,
	};
}

export function baseTreeDigest(tree: string): ReturnType<typeof digestOf> {
	const entries: (readonly [string, number, string])[] = [];

	const walk = (rel: string) => {
		for (const entry of readdirSync(join(tree, rel), {
			withFileTypes: true,
		}).sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0))) {
			const path = rel ? `${rel}/${entry.name}` : entry.name;
			const stat = lstatSync(join(tree, path));

			if (
				!safePath(path) ||
				entry.name === ".gitattributes" ||
				stat.isSymbolicLink() ||
				(!stat.isDirectory() && !stat.isFile())
			)
				throw new Error("unsafe_tree");

			if (stat.isDirectory()) walk(path);
			else
				entries.push([
					path,
					stat.mode & 0o111 ? 0o755 : 0o644,
					digestOf(readFileSync(join(tree, path))),
				]);
		}
	};

	walk("");

	return digestOf(JSON.stringify(entries));
}

type BaseRunInput = {
	readonly tree: string;
	readonly refused?: "tree_partial" | "tree_refused" | "tree_unavailable";
	readonly workDir: string;
	readonly cacheDir: string;
	readonly binding: AcceptanceBinding;
	readonly contract: Contract;
	readonly suite: AcceptanceSuite;
	readonly canary: string;
	readonly startedAt: number;
	readonly deadline: number;
	readonly scope?: string;
	readonly signal?: AbortSignal;
	readonly runner?: GateRunner;
};

export async function runHeldoutBase(
	input: BaseRunInput,
): Promise<BaseEvidence> {
	return runBase(input, []);
}

export async function runDraftBase(
	input: BaseRunInput,
): Promise<{ evidence: BaseEvidence; details: readonly DraftDetail[] }> {
	const details: DraftDetail[] = [];
	const evidence = await runBase(input, details);

	return { evidence, details };
}

async function runBase(
	input: BaseRunInput,
	details: DraftDetail[],
): Promise<BaseEvidence> {
	const runner = input.runner ?? localRunner;
	const detailReporter = fileURLToPath(new URL("./", import.meta.url));

	const detailBytes = readFileSync(
		join(detailReporter, "draft-reporter.mjs"),
		"utf8",
	);

	const gates = join(input.tree, ".github/factory/gates");

	const gateBytes = ["reporter.mjs", "freeze.mjs", "scan-rules.json"].map(
		(name) => {
			try {
				const path = join(gates, name);

				return lstatSync(path).isFile() ? readFileSync(path, "utf8") : null;
			} catch {
				return null;
			}
		},
	);

	const runtime = {
		runner: runner.kind,
		node: process.version,
		platform: `${process.platform}/${process.arch}`,
		bwrap: "unavailable",
		protocolDigest: digestOf(
			BASE_PROTOCOL_VERSION + JSON.stringify(gateBytes) + detailBytes,
		),
	};

	const scenarios = input.suite.scenarios.map((s) => {
		const path = s.checks[0];
		const file = input.suite.files.find((f) => f.path === path);

		return path === undefined || file === undefined
			? { scenario: s.id, kind: s.kind, mode: "judge_only" as const }
			: {
					scenario: s.id,
					kind: s.kind,
					mode: "checked" as const,
					file: `${ACCEPTANCE_SUITE_PREFIX}${input.binding.issue}/checks/${path}`,
					oracleKey: oracleKey(input.contract, s.criteria, file.content),
				};
	});

	let source: BaseEvidence["source"] = {
		kind: "unavailable",
		reason:
			input.refused ??
			(gateBytes.includes(null) ? "gates_missing" : "unsafe_tree"),
	};

	let execution: PrivateExecution = {
		kind: "unavailable",
		reason: "runner_error",
		wallMs: 0,
	};

	let repeat: PrivateExecution = execution;
	let tamper: SuiteSignal[] = [];

	const evidence = (): BaseEvidence => {
		const clean: BaseEvidence = {
			binding: input.binding,
			runtime,
			startedAt: input.startedAt,
			finishedAt: Date.now(),
			source,
			execution,
			repeat,
			scenarios,
		};

		return tamper.length > 0 ? { ...clean, tamper } : clean;
	};

	const remaining = () => {
		if (input.signal?.aborted || Date.now() >= input.deadline)
			throw new Error("base_timeout");

		return Math.max(1, input.deadline - Date.now());
	};

	const run: GateRunner = {
		kind: runner.kind,
		run: (request) =>
			runner.run({
				...request,
				deadlineMs: Math.min(request.deadlineMs ?? Infinity, remaining()),
				scope: input.scope,
				signal: input.signal,
			}),
	};

	try {
		if (source.reason !== "unsafe_tree") throw new Error(source.reason);
		remaining();

		const version = await command(
			"bwrap",
			["--version"],
			input.tree,
			CLEAN_ENV,
			remaining(),
		);

		runtime.bwrap = version.stdout.trim().slice(0, 100);
		const treeDigest = baseTreeDigest(input.tree);
		const gatesDigest = baseTreeDigest(gates);

		const lockDigest = digestOf(
			readFileSync(join(input.tree, "package-lock.json")),
		);

		// The gate's tamper scan, with the base tree's own rules, before any
		// install or run: a suite CI would reject never runs or qualifies.
		tamper = scanSuite(
			input.suite,
			input.binding.issue,
			input.canary,
			join(gates, "scan-rules.json"),
		);

		if (tamper.length > 0) {
			source = { kind: "ready", treeDigest, lockDigest, gatesDigest };

			return evidence();
		}

		const dependency = await dependencyCache(
			input.tree,
			gates,
			input.cacheDir,
			readDependencies(input.tree),
			input.deadline,
			run,
			remaining,
		);

		remaining();
		source = { kind: "ready", treeDigest, lockDigest, gatesDigest };
		const tree = join(input.workDir, "tree");

		const files = scenarios.flatMap((s) =>
			s.mode === "checked" ? [s.file] : [],
		);

		const once = async (): Promise<PrivateExecution> => {
			rmSync(tree, { recursive: true, force: true });
			cpSync(input.tree, tree, {
				recursive: true,
				errorOnExist: true,
				force: false,
			});

			if (dependency !== undefined)
				mkdirSync(join(tree, "node_modules"), { recursive: true });

			for (const [path, bytes] of acceptanceEntries(
				input.suite,
				input.canary,
			).filter(([p]) => p.startsWith("checks/"))) {
				const target = join(
					tree,
					`${ACCEPTANCE_SUITE_PREFIX}${input.binding.issue}`,
					path,
				);

				mkdirSync(dirname(target), { recursive: true });
				writeFileSync(target, bytes, { flag: "wx", mode: 0o600 });
			}

			const started = Date.now();

			const result = await run.run({
				tree,
				gates,
				dependencies: dependency,
				detailReporter,
				argv: testArgv(files, true),
			});

			const execution = privateExecution(result, files, Date.now() - started);

			if (execution.kind !== "observed") return execution;
			const parsed = parseDraftDetails(result.stderr, files);
			const failures = execution.files.flatMap((f) => f.failures);

			const identity = (
				f: Pick<DraftDetail, "file" | "name" | "kind" | "code" | "message">,
			) =>
				JSON.stringify([
					f.file,
					f.name,
					f.kind,
					f.code,
					f.message.slice(0, 200),
				]);

			if (
				parsed === null ||
				JSON.stringify(parsed.map(identity).sort()) !==
					JSON.stringify(failures.map(identity).sort())
			)
				return {
					kind: "unavailable",
					reason: "invalid_report",
					wallMs: execution.wallMs,
				};
			details.push(...parsed);

			// A wrapped runtime error is never an expected assertion red. All other
			// refusal facts stay intact: the companion can only strengthen this gate.
			return {
				...execution,
				files: execution.files.map((f) => ({
					...f,
					failures: f.failures.map((failure) =>
						failure.kind === "assertion" &&
						parsed.some(
							(d) =>
								d.file === failure.file &&
								d.name === failure.name &&
								d.causes.some(runtimeCause),
						)
							? { ...failure, kind: "runtime_error" as const }
							: failure,
					),
				})),
			};
		};

		execution = await once();
		repeat = await once();
	} catch (error) {
		const failed: PrivateExecution = {
			kind: "unavailable",
			reason:
				input.signal?.aborted ||
				Date.now() >= input.deadline ||
				(error instanceof Error && error.message === "base_timeout")
					? "timeout"
					: "runner_error",
			wallMs: 0,
		};

		if (execution.kind === "observed") repeat = failed;
		else execution = repeat = failed;
	}

	return evidence();
}

/**
 * `scanCandidate`'s held-out treatment of the suite's installed checks: every
 * line counts as changed, suppression comments are allowed, and an encoding
 * rejection replaces every other hit.
 */
function scanSuite(
	suite: AcceptanceSuite,
	issue: number,
	canary: string,
	rulesPath: string,
): SuiteSignal[] {
	const result: SuiteSignal[] = [];
	const encoding: SuiteSignal[] = [];

	const rule = (signal: Signal): SuiteSignal[] => {
		const known = SCAN_RULES.find((r) => r === signal.rule);

		if (known === undefined) throw new Error("invalid_scan_rule");

		return [{ file: signal.path, line: signal.line, rule: known }];
	};

	for (const [path, text] of acceptanceEntries(suite, canary)) {
		const file = `${ACCEPTANCE_SUITE_PREFIX}${issue}/${path}`;

		if (!path.startsWith("checks/") || !/\.[cm]?[jt]sx?$/.test(path)) continue;

		if (/[\u2028\u2029]|\r(?!\n)/.test(text)) {
			encoding.push({ file, line: 0, rule: "invalid_source_encoding" });

			continue;
		}

		const changed = new Set(text.split("\n").map((_, i) => i + 1));

		result.push(
			...scanSource(file, text, changed, rulesPath)
				.filter((s) => s.rule !== "suppression_added")
				.flatMap(rule),
		);
	}

	return encoding.length > 0 ? encoding : result;
}

export async function replayHeldoutCandidate(input: {
	readonly gateTree: string;
	readonly fullTree: string;
	readonly gates: string;
	readonly heldoutDir: string;
	readonly heldoutDigest: string;
	readonly workDir: string;
	readonly cacheDir: string;
	readonly deadline: number;
	readonly scope?: string;
	readonly signal?: AbortSignal;
	readonly runner?: GateRunner;
}): Promise<HeldoutReplay> {
	const runner = input.runner ?? localRunner;
	const started = Date.now();

	const remaining = () => {
		if (input.signal?.aborted || Date.now() >= input.deadline)
			throw new Error("replay_timeout");

		return Math.max(1, input.deadline - Date.now());
	};

	const run: GateRunner = {
		kind: runner.kind,
		run: (request) =>
			runner.run({
				...request,
				deadlineMs: Math.min(request.deadlineMs ?? Infinity, remaining()),
				scope: input.scope,
				signal: input.signal,
			}),
	};

	const unavailable = (
		reason: Extract<HeldoutReplay, { kind: "unavailable" }>["reason"],
	): HeldoutReplay => ({
		kind: "unavailable",
		reason,
		wallMs: Date.now() - started,
	});

	let files: string[];
	let deps: readonly Dependency[];

	try {
		remaining();
		baseTreeDigest(input.gateTree);
		baseTreeDigest(input.fullTree);
		baseTreeDigest(input.gates);
		deps = validateDependencies(
			readFileSync(join(input.fullTree, "package.json"), "utf8"),
			readFileSync(join(input.fullTree, "package-lock.json"), "utf8"),
			readFileSync(join(input.gateTree, "package-lock.json"), "utf8"),
		);
	} catch (error) {
		return error instanceof Error && error.message === "replay_timeout"
			? unavailable("timeout")
			: unavailable("unsupported_tree");
	}

	try {
		files = heldoutOf(input.fullTree, input.heldoutDir, input.heldoutDigest);

		if (
			JSON.stringify(
				heldoutOf(input.gateTree, input.heldoutDir, input.heldoutDigest),
			) !== JSON.stringify(files)
		)
			return unavailable("suite_mismatch");
	} catch {
		return unavailable("suite_mismatch");
	}

	let dependency: string | undefined;

	try {
		dependency = await dependencyCache(
			input.fullTree,
			input.gates,
			input.cacheDir,
			deps,
			input.deadline,
			run,
			remaining,
		);
	} catch {
		return input.signal?.aborted || Date.now() >= input.deadline
			? unavailable("timeout")
			: unavailable("dependency_transport");
	}

	const replayTree = async (
		name: string,
		source: string,
	): Promise<TreeReplay> => {
		const tree = join(input.workDir, name);
		cpSync(source, tree, { recursive: true, errorOnExist: true, force: false });

		if (dependency !== undefined)
			mkdirSync(join(tree, "node_modules"), { recursive: true });
		const began = Date.now();

		const result = await run.run({
			tree,
			gates: input.gates,
			dependencies: dependency,
			argv: testArgv(files),
		});

		return {
			execution: privateExecution(result, files, Date.now() - began),
			projection: heldoutProjection(result, files),
		};
	};

	try {
		mkdirSync(input.workDir, { recursive: true, mode: 0o700 });
		const gate = await replayTree("gate", input.gateTree);
		const full = await replayTree("full", input.fullTree);

		return {
			kind: "observed",
			files,
			gate,
			full,
			wallMs: Date.now() - started,
		};
	} catch (error) {
		return input.signal?.aborted ||
			Date.now() >= input.deadline ||
			(error instanceof Error && error.message === "replay_timeout")
			? unavailable("timeout")
			: unavailable("runner_error");
	}
}
