import { spawnSync } from "node:child_process";
import { parseArgs } from "node:util";
import manifest from "../package.json" with { type: "json" };
import {
	checkReport,
	type EnvLookup,
	type Exec,
	type ExecResult,
	isBranchName,
	isRepoSlug,
	loadWorkflow,
	type RepoSlug,
	reloadWorkflow,
	statusReport,
	TRUSTED_REF,
} from "../src/workflow.ts";

export const USAGE = `Usage:
  node server/cli.ts workflow-check --json --repo <owner/name> [--ref <branch>] [--reload-ref <branch>]
  node server/cli.ts status --json --repo <owner/name> [--ref <branch>]`;

export const EXIT = { ok: 0, invalid: 1, usage: 2 } as const;

export type CliIo = {
	exec: Exec;
	env: EnvLookup;
	stdout: (text: string) => void;
	stderr: (text: string) => void;
};

const FETCH_TIMEOUT_MS = 30_000;

type Parsed =
	| {
			kind: "ok";
			command: "workflow-check" | "status";
			repo: RepoSlug;
			ref: string;
			reloadRef: string | null;
	  }
	| { kind: "usage"; message: string };

function parse(argv: readonly string[]): Parsed {
	let parsed: ReturnType<typeof parseCliArgs>;

	try {
		parsed = parseCliArgs(argv);
	} catch (error) {
		return {
			kind: "usage",
			message: error instanceof Error ? error.message : "bad arguments",
		};
	}

	const { values, positionals } = parsed;
	const [command, ...extra] = positionals;

	if (command !== "workflow-check" && command !== "status") {
		return { kind: "usage", message: "expected workflow-check or status" };
	}

	if (extra.length > 0) {
		return { kind: "usage", message: `unexpected ${extra.join(" ")}` };
	}

	if (values.json !== true)
		return { kind: "usage", message: "--json is required" };

	if (values.repo === undefined || !isRepoSlug(values.repo)) {
		return { kind: "usage", message: "--repo <owner/name> is required" };
	}

	const ref = values.ref ?? TRUSTED_REF;
	const reloadRef = values["reload-ref"] ?? null;

	if (reloadRef !== null && command !== "workflow-check") {
		return {
			kind: "usage",
			message: "--reload-ref applies only to workflow-check",
		};
	}

	for (const branch of [ref, reloadRef]) {
		if (branch !== null && !isBranchName(branch)) {
			return { kind: "usage", message: `${branch} is not a branch name` };
		}
	}

	return { kind: "ok", command, repo: values.repo, ref, reloadRef };
}

function parseCliArgs(argv: readonly string[]) {
	return parseArgs({
		args: [...argv],
		allowPositionals: true,
		strict: true,
		options: {
			json: { type: "boolean" },
			repo: { type: "string" },
			ref: { type: "string" },
			"reload-ref": { type: "string" },
		},
	});
}

export async function runCli(
	argv: readonly string[],
	io: CliIo,
): Promise<number> {
	const parsed = parse(argv);

	if (parsed.kind === "usage") {
		io.stderr(`${parsed.message}\n${USAGE}\n`);

		return EXIT.usage;
	}

	const { repo, ref, reloadRef } = parsed;
	const load = await loadWorkflow({ exec: io.exec, repo, ref, env: io.env });

	if (parsed.command === "status") {
		io.stdout(
			`${JSON.stringify(statusReport(load, manifest.version), null, 2)}\n`,
		);

		return EXIT.ok;
	}

	if (reloadRef === null) {
		io.stdout(`${JSON.stringify(checkReport(load, null), null, 2)}\n`);

		return load.kind === "loaded" ? EXIT.ok : EXIT.invalid;
	}

	const next = await loadWorkflow({
		exec: io.exec,
		repo,
		ref: reloadRef,
		env: io.env,
	});

	const current = load.kind === "loaded" ? load.snapshot : null;
	const result = reloadWorkflow(current, next);

	io.stdout(
		`${JSON.stringify(checkReport(load, { next, result }), null, 2)}\n`,
	);

	return load.kind === "loaded" && next.kind === "loaded"
		? EXIT.ok
		: EXIT.invalid;
}

async function execFile(
	command: string,
	args: readonly string[],
): Promise<ExecResult> {
	const result = spawnSync(command, [...args], {
		encoding: "utf8",
		timeout: FETCH_TIMEOUT_MS,
		maxBuffer: 4 * 1024 * 1024,
	});

	return {
		stdout: result.stdout ?? "",
		stderr:
			result.error === undefined ? (result.stderr ?? "") : result.error.message,
		code: result.status ?? 1,
	};
}

if (import.meta.main) {
	process.exitCode = await runCli(process.argv.slice(2), {
		exec: execFile,
		env: (name) => process.env[name],
		stdout: (text) => process.stdout.write(text),
		stderr: (text) => process.stderr.write(text),
	});
}
