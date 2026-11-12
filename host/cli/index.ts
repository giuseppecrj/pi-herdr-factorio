import { resolve } from "node:path";
import { parseArgs } from "node:util";
import manifest from "../../package.json" with { type: "json" };
import { readAttention } from "../../src/views/attention.ts";
import { admitTicket, fileAdmissionStore } from "../../src/trust/admission.ts";
import {
	platformEnvironment,
	platformSummary,
	readPlatformFile,
	resolvePlatform,
} from "../../src/trust/platform.ts";
import type { JsonValue } from "../../src/core/json.ts";
import {
	isBranchName,
	redactCredentials,
	TRUSTED_REF,
} from "../../src/config/schema.ts";
import { loadWorkflow } from "../../src/config/load.ts";
import { checkReport, statusReport } from "../../src/config/views.ts";
import { isRepoSlug, type RepoSlug } from "../../src/trust/platform.ts";
import { readLedgerBacklog } from "../controller/outbox.ts";
import { lineLog } from "../controller/serve-loop.ts";
import {
	durableUsageOf,
	readDurableAccounting,
} from "../controller/terminal.ts";
import {
	readLock,
	readStatus,
	type SocketLockState,
} from "../controller/state.ts";
import { runGatesCli } from "../gates/gates.ts";
import { runViewerCli } from "../viewer/server.ts";
import { runCadenceCli } from "./cadence.ts";
import { runMeasurementCli } from "./measurement.ts";
import { runMetricsCli } from "./metrics.ts";
import { runOwnerFeedCli } from "./owner-feed.ts";
import {
	type CliIo,
	CONTROLLER_COMMANDS,
	type ControllerCommand,
	type ControllerView,
	execFile,
	EXIT,
	FETCH_TIMEOUT_MS,
	json,
	type Parsed,
	realRuntime,
	USAGE,
	XDG_RUNTIME_DIR,
} from "./platform.ts";
import { runReplayCli } from "./replay.ts";
import { runController } from "./serve.ts";

const ISSUE_NUMBER = /^[1-9][0-9]{0,9}$/;

type Values = ReturnType<typeof parseCliArgs>["values"];

function isControllerCommand(command: string): command is ControllerCommand {
	return CONTROLLER_COMMANDS.some((known) => known === command);
}

function issuesOf(values: Values): number[] | null {
	const issues = values.issue ?? [];

	return issues.every((issue) => ISSUE_NUMBER.test(issue))
		? issues.map(Number)
		: null;
}

function parseController(
	command: ControllerCommand,
	repo: RepoSlug,
	values: Values,
): Parsed {
	if (values.ref !== undefined || values["reload-ref"] !== undefined) {
		return {
			kind: "usage",
			message: `${command} always reads main and takes no --ref`,
		};
	}

	if ((command === "tick") !== (values.once === true)) {
		return {
			kind: "usage",
			message: "--once applies only to tick, and tick requires it",
		};
	}

	if ((command === "serve") === (values.json === true)) {
		return {
			kind: "usage",
			message: "--json is required, except for serve, which logs lines",
		};
	}

	const issues = issuesOf(values);

	if (issues === null || (command === "run" && issues.length !== 1)) {
		return {
			kind: "usage",
			message:
				command === "run"
					? "--issue <number> is required"
					: "--issue must be a number",
		};
	}

	if (values["state-dir"] === undefined || values["state-dir"] === "") {
		return { kind: "usage", message: "--state-dir <dir> is required" };
	}

	const cap = values["verification-token-cap"];

	if (cap !== undefined && (issues.length === 0 || !ISSUE_NUMBER.test(cap))) {
		return {
			kind: "usage",
			message:
				"--verification-token-cap takes a positive integer and requires --issue",
		};
	}

	return {
		kind: "controller",
		command,
		repo,
		stateDir: resolve(values["state-dir"]),
		scope: issues.length === 0 ? null : [...new Set(issues)],
		verificationCap: cap === undefined ? null : Number(cap),
	};
}

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
		command !== "admit" &&
		(command === undefined || !isControllerCommand(command))
	) {
		return {
			kind: "usage",
			message: "expected workflow-check, status, admit, tick, run or serve",
		};
	}

	if (extra.length > 0) {
		return { kind: "usage", message: "unexpected extra arguments" };
	}

	if (values.repo === undefined || !isRepoSlug(values.repo)) {
		return values.json !== true && command !== "serve"
			? { kind: "usage", message: "--json is required" }
			: { kind: "usage", message: "--repo <owner/name> is required" };
	}

	if (isControllerCommand(command)) {
		return parseController(command, values.repo, values);
	}

	if (values.json !== true) {
		return { kind: "usage", message: "--json is required" };
	}

	if (values.once !== undefined) {
		return {
			kind: "usage",
			message: "--once applies only to tick, and tick requires it",
		};
	}

	if (values["verification-token-cap"] !== undefined) {
		return {
			kind: "usage",
			message: "--verification-token-cap applies only to tick, run and serve",
		};
	}

	if (command === "admit") {
		if (values.ref !== undefined || values["reload-ref"] !== undefined) {
			return {
				kind: "usage",
				message: "admit always reads main and takes no --ref",
			};
		}

		const issues = issuesOf(values);

		if (issues === null || issues.length !== 1 || issues[0] === undefined) {
			return { kind: "usage", message: "--issue <number> is required" };
		}

		if (values["state-dir"] === undefined || values["state-dir"] === "") {
			return { kind: "usage", message: "--state-dir <dir> is required" };
		}

		return {
			kind: "admit",
			repo: values.repo,
			issue: issues[0],
			stateDir: resolve(values["state-dir"]),
		};
	}

	if (
		values.issue !== undefined ||
		(values["state-dir"] !== undefined && command !== "status")
	) {
		return {
			kind: "usage",
			message: "--issue applies only to admit, tick, run and serve",
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

	const stateDir = values["state-dir"];

	return {
		kind: "workflow",
		command,
		repo: values.repo,
		ref,
		reloadRef,
		stateDir:
			stateDir === undefined || stateDir === "" ? null : resolve(stateDir),
	};
}

function parseCliArgs(argv: readonly string[]) {
	return parseArgs({
		args: [...argv],
		allowPositionals: true,
		strict: true,
		options: {
			json: { type: "boolean" },
			once: { type: "boolean" },
			repo: { type: "string" },
			ref: { type: "string" },
			"reload-ref": { type: "string" },
			issue: { type: "string", multiple: true },
			"state-dir": { type: "string" },
			"verification-token-cap": { type: "string" },
		},
	});
}

function controllerView(
	lock: SocketLockState,
	lastTick: JsonValue | null,
): ControllerView {
	const holder =
		lock.kind === "socket_bound" || lock.kind === "holder_file_without_socket"
			? lock.holderFile
			: null;

	const state = {
		none: "stopped",
		socket_bound: "running",
		holder_file_without_socket: "stale_lock",
		unreadable: "unreadable_lock",
	} as const;

	return {
		state: state[lock.kind],
		pid: holder?.pid ?? null,
		since: holder?.acquiredAt ?? null,
		lastTick,
	};
}

export async function runCli(
	argv: readonly string[],
	caller: CliIo,
): Promise<number> {
	const io: CliIo = {
		...caller,
		stderr: (text) => caller.stderr(redactCredentials(text)),
	};

	const resolved = await resolvePlatform({
		env: io.env,
		readFile: io.readPlatformFile,
	});

	if (!resolved.ok) {
		lineLog(io.stderr, () => io.runtime?.clock.now() ?? Date.now())(
			"platform_invalid",
			{ reason: resolved.reason },
		);

		return EXIT.usage;
	}

	const { profile: platform } = resolved;

	if (argv[0] === "platform") {
		if (argv.length !== 2 || argv[1] !== "--env") {
			io.stderr(`${USAGE}\n`);

			return EXIT.usage;
		}

		io.stdout(platformEnvironment(platform));

		return EXIT.ok;
	}

	if (argv[0] === "score" || argv[0] === "explain")
		return runMeasurementCli(argv[0], argv.slice(1), io, platform);

	if (argv[0] === "cadence") return runCadenceCli(argv.slice(1), io, platform);

	if (argv[0] === "replay") return runReplayCli(argv.slice(1), io, platform);

	if (argv[0] === "metrics") return runMetricsCli(argv.slice(1), io, platform);

	if (argv[0] === "owner-feed") return runOwnerFeedCli(argv.slice(1), io);

	if (argv[0] === "viewer") return runViewerCli(argv.slice(1), io);

	if (argv[0] === "gates") return runGatesCli(argv.slice(1), io);

	const parsed = parse(argv);

	if (parsed.kind === "usage") {
		io.stderr(`${parsed.message}\n${USAGE}\n`);

		return EXIT.usage;
	}

	if (parsed.kind === "controller") return runController(parsed, io, platform);

	if (parsed.kind === "admit") {
		const receipt = await admitTicket({
			exec: io.exec,
			env: io.env,
			platform,
			repo: parsed.repo,
			issue: parsed.issue,
			allowlist: platform.repositories,
			store: fileAdmissionStore(parsed.stateDir),
		});

		io.stdout(json(receipt));

		return receipt.decision === "admitted" ? EXIT.ok : EXIT.invalid;
	}

	const { repo, ref, reloadRef } = parsed;

	const load = await loadWorkflow({
		exec: io.exec,
		repo,
		ref,
		env: io.env,
		platform,
	});

	if (parsed.command === "status") {
		const report = statusReport(load, manifest.version);

		const controller: ControllerView =
			parsed.stateDir === null
				? {
						state: "unavailable",
						reason: "pass --state-dir to read the controller lock",
					}
				: controllerView(
						await readLock(parsed.stateDir),
						await readStatus(parsed.stateDir),
					);

		const attention = await readAttention({
			stateDir: parsed.stateDir,
			repo,
			now: Date.now(),
			thresholds:
				load.kind === "loaded" ? load.snapshot.config.attention : undefined,
		});

		const ledger = await readLedgerBacklog(
			parsed.stateDir,
			io.runtime?.clock.now() ?? Date.now(),
		);

		const accounting = await readDurableAccounting(parsed.stateDir, repo);
		const durableUsage = durableUsageOf(accounting);

		io.stdout(
			json({
				...report,
				platform: platformSummary(platform),
				controller,
				attention,
				ledger,
				accounting,
				durableUsage,
			}),
		);

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
		platform,
	});

	io.stdout(json(checkReport(load, next)));

	return load.kind === "loaded" && next.kind === "loaded"
		? EXIT.ok
		: EXIT.invalid;
}

if (import.meta.main) {
	process.env.XDG_RUNTIME_DIR ??= XDG_RUNTIME_DIR;

	const stop = new AbortController();

	for (const name of ["SIGTERM", "SIGINT"] as const) {
		process.on(name, () => stop.abort());
	}

	process.exitCode = await runCli(process.argv.slice(2), {
		exec: (command, args, options) =>
			execFile(
				command,
				args,
				Math.min(FETCH_TIMEOUT_MS, options?.timeoutMs ?? FETCH_TIMEOUT_MS),
			),
		env: (name) => process.env[name],
		readPlatformFile: () => readPlatformFile(),
		stdout: (text) => process.stdout.write(text),
		stderr: (text) => process.stderr.write(text),
		runtime: { ...realRuntime(), signal: stop.signal },
	});
}
