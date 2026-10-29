import { spawnSync } from "node:child_process";
import { parseArgs } from "node:util";
import { resolve } from "node:path";
import manifest from "../package.json" with { type: "json" };
import {
	type AdmissionReceipt,
	admitTicket,
	FACTORY_REPOSITORIES,
	fileAdmissionStore,
} from "../src/admission.ts";
import type { JsonValue } from "../src/tickets.ts";
import {
	type CheckReport,
	checkReport,
	type EnvLookup,
	type Exec,
	type ExecResult,
	isBranchName,
	isRepoSlug,
	loadWorkflow,
	type RepoSlug,
	redactCredentials,
	type StatusReport,
	statusReport,
	TRUSTED_REF,
} from "../src/workflow.ts";

export const USAGE = `Usage:
  node server/cli.ts workflow-check --json --repo <owner/name> [--ref <branch>] [--reload-ref <branch>]
  node server/cli.ts status --json --repo <owner/name> [--ref <branch>]
  node server/cli.ts admit --json --repo <owner/name> --issue <number> --state-dir <dir>`;

export const EXIT = { ok: 0, invalid: 1, usage: 2 } as const;

export type CliIo = {
	exec: Exec;
	env: EnvLookup;
	stdout: (text: string) => void;
	stderr: (text: string) => void;
};

export const FETCH_TIMEOUT_MS = 30_000;

const ISSUE_NUMBER = /^[1-9][0-9]{0,9}$/;

type Parsed =
	| {
			kind: "workflow";
			command: "workflow-check" | "status";
			repo: RepoSlug;
			ref: string;
			reloadRef: string | null;
	  }
	| { kind: "admit"; repo: RepoSlug; issue: number; stateDir: string }
	| { kind: "usage"; message: string };

function parse(argv: readonly string[]): Parsed {
	let parsed: ReturnType<typeof parseCliArgs>;

	try {
		parsed = parseCliArgs(argv);
	} catch {
		return { kind: "usage", message: "unrecognized or incomplete options" };
	}

	const { values, positionals } = parsed;
	const [command, ...extra] = positionals;

	if (
		command !== "workflow-check" &&
		command !== "status" &&
		command !== "admit"
	) {
		return {
			kind: "usage",
			message: "expected workflow-check, status or admit",
		};
	}

	if (extra.length > 0) {
		return { kind: "usage", message: "unexpected extra arguments" };
	}

	if (values.json !== true)
		return { kind: "usage", message: "--json is required" };

	if (values.repo === undefined || !isRepoSlug(values.repo)) {
		return { kind: "usage", message: "--repo <owner/name> is required" };
	}

	if (command === "admit") {
		if (values.ref !== undefined || values["reload-ref"] !== undefined) {
			return {
				kind: "usage",
				message: "admit always reads main and takes no --ref",
			};
		}

		if (values.issue === undefined || !ISSUE_NUMBER.test(values.issue)) {
			return { kind: "usage", message: "--issue <number> is required" };
		}

		if (values["state-dir"] === undefined || values["state-dir"] === "") {
			return { kind: "usage", message: "--state-dir <dir> is required" };
		}

		return {
			kind: "admit",
			repo: values.repo,
			issue: Number(values.issue),
			stateDir: resolve(values["state-dir"]),
		};
	}

	if (values.issue !== undefined || values["state-dir"] !== undefined) {
		return {
			kind: "usage",
			message: "--issue and --state-dir apply only to admit",
		};
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
			return {
				kind: "usage",
				message: "--ref and --reload-ref must be branch names",
			};
		}
	}

	return { kind: "workflow", command, repo: values.repo, ref, reloadRef };
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
			issue: { type: "string" },
			"state-dir": { type: "string" },
		},
	});
}

function redactString(_key: string, item: JsonValue): JsonValue {
	const text = String(item);

	return item === text ? redactCredentials(text) : item;
}

function json(report: StatusReport | CheckReport | AdmissionReceipt): string {
	return `${JSON.stringify(report, redactString, 2)}\n`;
}

export async function runCli(
	argv: readonly string[],
	caller: CliIo,
): Promise<number> {
	const io: CliIo = {
		...caller,
		stderr: (text) => caller.stderr(redactCredentials(text)),
	};

	const parsed = parse(argv);

	if (parsed.kind === "usage") {
		io.stderr(`${parsed.message}\n${USAGE}\n`);

		return EXIT.usage;
	}

	if (parsed.kind === "admit") {
		const receipt = await admitTicket({
			exec: io.exec,
			env: io.env,
			repo: parsed.repo,
			issue: parsed.issue,
			allowlist: FACTORY_REPOSITORIES,
			store: fileAdmissionStore(parsed.stateDir),
		});

		io.stdout(json(receipt));

		return receipt.decision === "admitted" ? EXIT.ok : EXIT.invalid;
	}

	const { repo, ref, reloadRef } = parsed;
	const load = await loadWorkflow({ exec: io.exec, repo, ref, env: io.env });

	if (parsed.command === "status") {
		io.stdout(json(statusReport(load, manifest.version)));

		return EXIT.ok;
	}

	if (reloadRef === null) {
		io.stdout(json(checkReport(load, null)));

		return load.kind === "loaded" ? EXIT.ok : EXIT.invalid;
	}

	const next = await loadWorkflow({
		exec: io.exec,
		repo,
		ref: reloadRef,
		env: io.env,
	});

	io.stdout(json(checkReport(load, next)));

	return load.kind === "loaded" && next.kind === "loaded"
		? EXIT.ok
		: EXIT.invalid;
}

export async function execFile(
	command: string,
	args: readonly string[],
	timeoutMs: number,
): Promise<ExecResult> {
	const result = spawnSync(command, [...args], {
		encoding: "utf8",
		timeout: timeoutMs,
		maxBuffer: 4 * 1024 * 1024,
	});

	if (result.error !== undefined && result.pid === 0) throw result.error;

	return {
		stdout: result.stdout ?? "",
		stderr:
			result.error === undefined ? (result.stderr ?? "") : result.error.message,
		code: result.status ?? 1,
	};
}

if (import.meta.main) {
	process.exitCode = await runCli(process.argv.slice(2), {
		exec: (command, args) => execFile(command, args, FETCH_TIMEOUT_MS),
		env: (name) => process.env[name],
		stdout: (text) => process.stdout.write(text),
		stderr: (text) => process.stderr.write(text),
	});
}
