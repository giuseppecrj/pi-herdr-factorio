import { spawn } from "node:child_process";

/**
 * The only `pi` on the sandbox PATH. Herdr children start `pi` by name
 * without the parent's flags, so this wrapper is where child hardening is
 * enforced. It ships in the asset bundle and imports nothing but Node.
 */

export const PI_AGENT_DIR = "/run/pi-agent";

export const PI_CLI =
	"/opt/factory/pkg/node_modules/@earendil-works/pi-coding-agent/dist/bundle/cli.js";

export const FORCED_PI_FLAGS = [
	"--no-mcp",
	"--no-approve",
	"--no-context-files",
] as const;

/**
 * Flags that take a value and load no code or tools. `--tools`, `-t`,
 * `--extension` and `-e` are handled apart. Every other flag is refused.
 */
const VALUE_FLAGS = [
	"--mode",
	"--model",
	"--thinking",
	"--session",
	"--session-id",
	"--session-dir",
	"--name",
	"-n",
	"--system-prompt",
	"--append-system-prompt",
	"--exclude-tools",
	"-xt",
];

const SWITCH_FLAGS = [
	"--print",
	"-p",
	"--no-session",
	"--no-tools",
	"-nt",
	"--no-extensions",
	"-ne",
	"--no-skills",
	"-ns",
	"--no-prompt-templates",
	"-np",
	"--no-themes",
	"--no-context-files",
	"-nc",
	"--no-mcp",
	"--no-approve",
	"-na",
	"--offline",
	"--verbose",
];

/**
 * The only extension a Pi in the sandbox may load by flag: the one
 * `pi-herdr-agents` passes to every child it starts. It is in the read-only
 * bundle. The match is exact, so no other path, `builtin:` name or `..`
 * spelling passes.
 */
export const CHILD_EXTENSIONS = [
	"/opt/factory/pkg/node_modules/pi-herdr-agents/maestro/adapters/pi/child/subagent-done.ts",
];

const REFUSED_SUBCOMMANDS = [
	"install",
	"remove",
	"uninstall",
	"update",
	"config",
	"auth",
	"mcp",
	"list",
];

export type Wrapped =
	| { readonly ok: true; readonly argv: string[] }
	| { readonly ok: false };

function narrowTools(requested: string, allowed: readonly string[]): string[] {
	return requested
		.split(",")
		.map((entry) => entry.trim())
		.filter((entry) => allowed.includes(entry));
}

/**
 * Prepends the forced flags, narrows any `--tools` to the allowlist (or
 * supplies the allowlist when none is given), and refuses the subcommands
 * that change installs or read keys. Options are an allowlist: a flag
 * outside it, a missing value, or an extension other than the child one
 * refuses the whole command line. Arguments after `--` are messages.
 */
export function wrapPiArgv(
	args: readonly string[],
	allowed: readonly string[],
): Wrapped {
	const first = args[0];

	if (first !== undefined && REFUSED_SUBCOMMANDS.includes(first)) {
		return { ok: false };
	}

	const split = args.indexOf("--");
	const options = split === -1 ? args : args.slice(0, split);
	const messages = split === -1 ? [] : args.slice(split);
	const kept: string[] = [];
	let requested: string | null = null;

	for (let index = 0; index < options.length; index += 1) {
		const arg = options[index] ?? "";

		if (!arg.startsWith("-")) {
			kept.push(arg);
			continue;
		}

		if (SWITCH_FLAGS.includes(arg)) {
			kept.push(arg);
			continue;
		}

		const equals = arg.startsWith("--") ? arg.indexOf("=") : -1;
		const flag = equals === -1 ? arg : arg.slice(0, equals);
		const inline = equals === -1 ? undefined : arg.slice(equals + 1);
		const value = inline ?? options[index + 1];

		if (value === undefined) return { ok: false };

		if (inline === undefined) index += 1;

		if (flag === "--tools" || flag === "-t") {
			requested = value;
		} else if (flag === "--extension" || flag === "-e") {
			if (!CHILD_EXTENSIONS.includes(value)) return { ok: false };

			kept.push(flag, value);
		} else if (VALUE_FLAGS.includes(flag)) {
			kept.push(flag, value);
		} else {
			return { ok: false };
		}
	}

	const tools =
		requested === null ? [...allowed] : narrowTools(requested, allowed);

	const toolArgs =
		tools.length === 0 ? ["--no-tools"] : ["--tools", tools.join(",")];

	return {
		ok: true,
		argv: [...FORCED_PI_FLAGS, ...toolArgs, ...kept, ...messages],
	};
}

function main(): void {
	const allowed = (process.env.FACTORY_PI_TOOLS ?? "")
		.split(",")
		.filter((tool) => tool !== "");

	const wrapped = wrapPiArgv(process.argv.slice(2), allowed);

	if (process.env.FACTORY_PI_TOOLS === undefined || !wrapped.ok) {
		process.stderr.write("factory pi wrapper: refused\n");
		process.exitCode = 2;

		return;
	}

	const child = spawn(process.execPath, [PI_CLI, ...wrapped.argv], {
		stdio: "inherit",
		env: { ...process.env, PI_CODING_AGENT_DIR: PI_AGENT_DIR },
	});

	for (const signal of ["SIGTERM", "SIGINT", "SIGHUP"] as const) {
		process.on(signal, () => child.kill(signal));
	}

	child.on("exit", (code, signal) => {
		process.exitCode = code ?? (signal === null ? 1 : 128);
	});
}

if (import.meta.main) main();
