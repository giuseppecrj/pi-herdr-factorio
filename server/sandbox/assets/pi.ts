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

const REFUSED_FLAGS = ["--approve", "-a", "--api-key"];

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
 * supplies the allowlist when none is given), and refuses flags and
 * subcommands that would trust project files, take a key or change installs.
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

		if (REFUSED_FLAGS.includes(arg) || arg.startsWith("--api-key=")) {
			return { ok: false };
		}

		if (arg === "--tools" || arg === "-t") {
			requested = options[index + 1] ?? "";
			index += 1;
		} else if (arg.startsWith("--tools=")) {
			requested = arg.slice("--tools=".length);
		} else {
			kept.push(arg);
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
