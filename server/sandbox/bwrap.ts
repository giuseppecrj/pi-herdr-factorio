import { PI_AGENT_DIR } from "./assets/pi.ts";
import { FORWARDER_PORT } from "./routes.ts";

/** Paths inside the read-only asset bundle, mounted at `/opt/factory`. */
export const BUNDLE = {
	root: "/opt/factory",
	bin: "/opt/factory/bin",
	nodeBin: "/opt/factory/node/bin",
	node: "/opt/factory/node/bin/node",
	stageInit: "/opt/factory/sandbox/stage-init.ts",
	herdr: "/opt/factory/bin/herdr",
	etc: "/opt/factory/etc",
} as const;

/** Fixed paths inside the sandbox. */
export const SANDBOX = {
	workspace: "/workspace",
	agentDir: PI_AGENT_DIR,
	socket: "/run/gw.sock",
	home: "/home/agent",
} as const;

export type SandboxLayout = {
	readonly bundleDir: string;
	readonly workspaceDir: string;
	readonly workspaceHasGit: boolean;
	readonly agentDir: string;
	readonly socketPath: string;
	readonly seccompFd: number;
	readonly tools: readonly string[];
	readonly command: readonly string[];
};

const HOST_READ_ONLY = [
	"/etc/ssl",
	"/etc/alternatives",
	"/etc/nsswitch.conf",
	"/etc/ld.so.cache",
] as const;

const SYNTHETIC_ETC = ["passwd", "group", "hosts", "resolv.conf"] as const;

function setenv(name: string, value: string): string[] {
	return ["--setenv", name, value];
}

/**
 * The full launch argv after the scope wrapper: `env -i` so bwrap's own
 * `/proc/1/environ` holds only PATH, then bwrap from an empty root. Only the
 * stage workspace and the per-stage agent dir are writable; the bundle,
 * `.git` and the agent config files are read-only; nothing else from the
 * host home, controller state or `/run` is mounted.
 */
export function bwrapArgv(layout: SandboxLayout): string[] {
	const git = `${SANDBOX.workspace}/.git`;
	const home = SANDBOX.home;

	return [
		"env",
		"-i",
		"PATH=/usr/bin:/bin",
		"bwrap",
		"--unshare-all",
		"--die-with-parent",
		"--new-session",
		"--cap-drop",
		"ALL",
		"--clearenv",
		"--hostname",
		"factory-sandbox",
		"--ro-bind",
		"/usr",
		"/usr",
		"--symlink",
		"usr/bin",
		"/bin",
		"--symlink",
		"usr/sbin",
		"/sbin",
		"--symlink",
		"usr/lib",
		"/lib",
		"--symlink",
		"usr/lib64",
		"/lib64",
		"--proc",
		"/proc",
		"--dev",
		"/dev",
		"--tmpfs",
		"/tmp",
		"--tmpfs",
		"/run",
		"--tmpfs",
		"/home",
		"--dir",
		home,
		"--dir",
		"/tmp/run",
		...HOST_READ_ONLY.flatMap((path) => ["--ro-bind", path, path]),
		...SYNTHETIC_ETC.flatMap((name) => [
			"--ro-bind",
			`${layout.bundleDir}/etc/${name}`,
			`/etc/${name}`,
		]),
		"--ro-bind",
		layout.bundleDir,
		BUNDLE.root,
		"--bind",
		layout.workspaceDir,
		SANDBOX.workspace,
		...(layout.workspaceHasGit
			? ["--ro-bind", `${layout.workspaceDir}/.git`, git]
			: ["--tmpfs", git, "--remount-ro", git]),
		"--bind",
		layout.agentDir,
		SANDBOX.agentDir,
		"--ro-bind",
		`${layout.agentDir}/models.json`,
		`${SANDBOX.agentDir}/models.json`,
		"--ro-bind",
		`${layout.agentDir}/settings.json`,
		`${SANDBOX.agentDir}/settings.json`,
		"--bind",
		layout.socketPath,
		SANDBOX.socket,
		"--seccomp",
		String(layout.seccompFd),
		"--chdir",
		SANDBOX.workspace,
		...setenv("PATH", `${BUNDLE.bin}:${BUNDLE.nodeBin}:/usr/bin:/bin`),
		...setenv("HOME", home),
		...setenv("USER", "agent"),
		...setenv("LANG", "C.UTF-8"),
		...setenv("TERM", "xterm-256color"),
		...setenv("XDG_CONFIG_HOME", `${home}/.config`),
		...setenv("XDG_CACHE_HOME", `${home}/.cache`),
		...setenv("XDG_STATE_HOME", `${home}/.local/state`),
		...setenv("XDG_DATA_HOME", `${home}/.local/share`),
		...setenv("XDG_RUNTIME_DIR", "/tmp/run"),
		...setenv("PI_CODING_AGENT_DIR", SANDBOX.agentDir),
		...setenv("PI_OFFLINE", "1"),
		...setenv("PI_SKIP_VERSION_CHECK", "1"),
		...setenv("PI_TELEMETRY", "0"),
		...setenv("FACTORY_PI_TOOLS", layout.tools.join(",")),
		...setenv("npm_config_registry", `http://127.0.0.1:${FORWARDER_PORT}/npm/`),
		...setenv("npm_config_ignore_scripts", "true"),
		...setenv("npm_config_audit", "false"),
		...setenv("npm_config_fund", "false"),
		...setenv("npm_config_update_notifier", "false"),
		"--",
		BUNDLE.node,
		BUNDLE.stageInit,
		"--port",
		String(FORWARDER_PORT),
		"--socket",
		SANDBOX.socket,
		"--herdr",
		BUNDLE.herdr,
		"--",
		...layout.command,
	];
}
