import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import {
	chmodSync,
	mkdtempSync,
	readFileSync,
	rmSync,
	statSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import { runCli } from "../host/cli/index.ts";
import { runPreflight } from "../host/isolation/preflight.ts";
import type { PlatformFile } from "../src/trust/platform.ts";

const script = readFileSync(
	new URL("../host/install/provision.sh", import.meta.url),
	"utf8",
);

const unit = readFileSync(
	new URL("../host/install/factory.service", import.meta.url),
	"utf8",
);

async function render(
	selector?: string,
	file: PlatformFile = { kind: "absent" },
	argv: readonly string[] = ["platform", "--env"],
) {
	let stdout = "";
	let stderr = "";

	const code = await runCli(argv, {
		exec: async () => {
			throw new Error("platform --env must not execute a command");
		},
		env: (name) => (name === "FACTORY_PLATFORM" ? selector : undefined),
		readPlatformFile: async () => file,
		stdout: (text) => {
			stdout += text;
		},
		stderr: (text) => {
			stderr += text;
		},
	});

	return { code, stdout, stderr };
}

function providerUrls(env: string) {
	return spawnSync(
		"bash",
		[
			"-c",
			'set -eu; source /dev/stdin <<<"$1"; printf "%s\\n" "$LLM_OPENAI_BASE_URL" "$LLM_ANTHROPIC_BASE_URL"',
			"provider-urls",
			env,
		],
		{ encoding: "utf8" },
	);
}

const DEFAULT_ENV = `FACTORY_PLATFORM=exe-dev
GH_HOST=github.int.exe.xyz
LLM_API_KEY_PLACEHOLDER=exe-dev-integration
LLM_BASE_URL=https://llm.int.exe.xyz
LLM_OPENAI_BASE_URL=https://llm.int.exe.xyz/openai/v1
LLM_ANTHROPIC_BASE_URL=https://llm.int.exe.xyz/anthropic
`;

const EXMACH_ENV = `FACTORY_PLATFORM=exmach:exmach.net
GH_HOST=factorio.int.exmach.net
GH_ENTERPRISE_TOKEN=exmach
LLM_API_KEY_PLACEHOLDER=exmach
LLM_BASE_URL=https://llm.int.exmach.net
LLM_OPENAI_BASE_URL=https://llm.int.exmach.net/v1
LLM_ANTHROPIC_BASE_URL=https://llm.int.exmach.net
`;

function present(fields: {
	readonly [key: string]: string | number;
}): PlatformFile {
	return { kind: "present", text: JSON.stringify({ version: 1, ...fields }) };
}

describe("platform environment for provisioning", () => {
	for (const selector of [undefined, "exe-dev", "exmach:exmach.net"]) {
		for (const withFile of [false, true]) {
			it(`renders ${selector ?? "unset"} ${withFile ? "with" : "without"} a selection file`, async () => {
				assert.deepEqual(
					await render(
						selector,
						withFile ? present({ platform: selector ?? "exe-dev" }) : undefined,
					),
					{
						code: 0,
						stdout: selector === "exmach:exmach.net" ? EXMACH_ENV : DEFAULT_ENV,
						stderr: "",
					},
				);
			});
		}
	}

	it("takes the platform and one-label GitHub override from the same resolver", async () => {
		const result = await render(
			undefined,
			present({
				platform: "exmach:exmach.net",
				ghHost: "github.int.exmach.net",
			}),
		);

		assert.equal(result.code, 0);
		assert.equal(
			result.stdout,
			EXMACH_ENV.replace("factorio.int.", "github.int."),
		);
	});

	it("keeps today's exe-dev host and Pi URLs without adding a GitHub token", async () => {
		const result = await render();
		assert.equal(result.stdout, DEFAULT_ENV);
		assert.match(result.stdout, /^GH_HOST=github\.int\.exe\.xyz$/m);
		assert.doesNotMatch(result.stdout, /^GH_ENTERPRISE_TOKEN=/m);
		const run = providerUrls(result.stdout);
		assert.equal(run.status, 0, run.stderr);
		assert.equal(
			run.stdout,
			"https://llm.int.exe.xyz/openai/v1\nhttps://llm.int.exe.xyz/anthropic\n",
		);
	});

	for (const [selector, file] of [
		["broken", { kind: "absent" }],
		["exmach:exmach.net", present({ platform: "exe-dev" })],
		[undefined, { kind: "present", text: "not json" }],
	] satisfies [string | undefined, PlatformFile][]) {
		it(`refuses invalid input ${selector ?? "file"} before printing any environment`, async () => {
			const result = await render(selector, file);
			assert.equal(result.code, 2);
			assert.equal(result.stdout, "");
			assert.match(result.stderr, /event=platform_invalid reason=/);
		});
	}

	it("rejects missing or extra env-command options without printing assignments", async () => {
		for (const args of [
			["platform"],
			["platform", "--json"],
			["platform", "--env", "--repo", "acme/widgets"],
		]) {
			const result = await render(undefined, undefined, args);
			assert.equal(result.code, 2);
			assert.equal(result.stdout, "");
			assert.match(result.stderr, /Usage:/);
		}
	});

	it("keeps the exe-dev host models.json byte-identical to the main baseline", async () => {
		const first = script.indexOf("  cat >~/.pi/agent/models.json <<JSON\n");
		const last = script.indexOf("\nJSON", first);
		assert.ok(first >= 0 && last > first);
		const template = script.slice(first, last + "\nJSON".length);

		const run = spawnSync(
			"bash",
			[
				"-c",
				`set -eu; source /dev/stdin <<<"$1"\n${template.replace("cat >~/.pi/agent/models.json", "cat")}`,
				"models-fragment",
				(await render()).stdout,
			],
			{ encoding: "utf8" },
		);

		assert.equal(run.status, 0, run.stderr);
		assert.equal(
			run.stdout,
			`{
  "providers": {
    "anthropic": { "baseUrl": "https://llm.int.exe.xyz/anthropic", "apiKey": "exe-dev-integration" },
    "openai": { "baseUrl": "https://llm.int.exe.xyz/openai/v1", "apiKey": "exe-dev-integration" }
  }
}
`,
		);
	});

	it("keeps the unit static and requires the generated environment file", () => {
		assert.match(unit, /^EnvironmentFile=\/etc\/factory\/factory\.env$/m);
		assert.doesNotMatch(unit, /^Environment=GH_(HOST|ENTERPRISE_TOKEN)=/m);
		assert.match(unit, /^Environment=XDG_RUNTIME_DIR=\/run\/user\/1000$/m);
	});
});

describe("provisioning shell fragments (isolated, never the full script)", () => {
	it("installs missing checkout dependencies once before the full-mode env command", () => {
		const lines = script.split("\n");
		const first = lines.indexOf('  if [ ! -d "$repo/node_modules" ]; then');
		const last = lines.indexOf("  fi", first);
		assert.ok(first >= 0 && last > first);
		assert.equal(lines[first - 1], 'if [ "$mode" = all ]; then');
		assert.equal(
			lines[last + 1],
			'  platform_env=$(node "$repo/host/cli/index.ts" platform --env)',
		);
		const snippet = lines.slice(first, last + 1).join("\n");
		const dir = mkdtempSync(join(tmpdir(), "factory-provision-deps-"));

		try {
			const run = () =>
				spawnSync(
					"bash",
					[
						"-c",
						`set -eu
repo=$1
npm() {
  test "$*" = 'ci --ignore-scripts --no-audit --no-fund'
  mkdir node_modules
  printf 'installed\\n'
}
${snippet}`,
						"checkout-deps-fragment",
						dir,
					],
					{ encoding: "utf8" },
				);

			const firstRun = run();
			assert.equal(firstRun.status, 0, firstRun.stderr);
			assert.equal(firstRun.stdout, "installed\n");
			const secondRun = run();
			assert.equal(secondRun.status, 0, secondRun.stderr);
			assert.equal(secondRun.stdout, "");
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});

	it("validates every assignment before sourcing the CLI output", async () => {
		const first = script.indexOf("  while IFS= read -r assignment; do\n");

		const last = script.indexOf(
			'  source /dev/stdin <<<"$platform_env"',
			first,
		);

		assert.ok(first >= 0 && last > first);
		const snippet = script.slice(first, last);

		const check = (env: string) =>
			spawnSync(
				"bash",
				["-c", `set -eu\nplatform_env=$1\n${snippet}`, "env-validation", env],
				{ encoding: "utf8" },
			);

		for (const selector of [undefined, "exe-dev", "exmach:exmach.net"]) {
			const run = check((await render(selector)).stdout.trimEnd());
			assert.equal(run.status, 0, run.stderr);
		}

		for (const bad of [
			"GH_HOST=$(printf unsafe)",
			"PATH=/unsafe",
			"GH_HOST=valid\nnot-an-assignment",
			"GH_HOST=valid\n",
			"export GH_HOST=valid",
			"GH_HOST=valid;false",
		]) {
			const run = check(`GH_HOST=valid\n${bad}`);
			assert.equal(run.status, 1, bad);
			assert.match(run.stderr, /provision: invalid platform environment/);
		}
	});

	it("sources the CLI output rather than duplicating platform rules in bash", async () => {
		assert.match(
			script,
			/platform_env=\$\(node "\$repo\/host\/cli\/index\.ts" platform --env\)/,
		);
		assert.match(script, /source \/dev\/stdin <<<"\$platform_env"/);
		assert.doesNotMatch(script, /LLM=https:\/\/llm\.int\./);
		assert.match(script, /"baseUrl": "\$LLM_OPENAI_BASE_URL"/);
		assert.match(script, /"baseUrl": "\$LLM_ANTHROPIC_BASE_URL"/);
		const result = await render("exmach:exmach.net");
		const run = providerUrls(result.stdout);
		assert.equal(run.status, 0, run.stderr);
		assert.equal(
			run.stdout,
			"https://llm.int.exmach.net/v1\nhttps://llm.int.exmach.net\n",
		);
	});

	it("atomically installs changed env bytes at 0644, preserves equal files and existing directory permissions", async () => {
		const first = script.indexOf("  if [ ! -d /etc/factory ]; then");

		const last = script.indexOf(
			"  fi\n",
			script.indexOf("sudo mv -T /etc/factory/factory.env.tmp", first),
		);

		assert.ok(first >= 0 && last > first);
		const dir = mkdtempSync(join(tmpdir(), "factory-env-install-"));

		try {
			const target = join(dir, "etc-factory");

			const snippet = script
				.slice(first, last + "  fi\n".length)
				.replaceAll("/etc/factory", target);

			const env = (await render("exmach:exmach.net")).stdout;

			const run = (text = env, fail = false) =>
				spawnSync(
					"bash",
					[
						"-c",
						`set -eu
build=$1
platform_env=$(printf '%s' "$2")
fail=$3
sudo() {
  printf '%s\\n' "$*" >>"$build/calls"
  case "$1" in
    install)
      shift
      local args=()
      while [ "$#" -gt 0 ]; do
        case "$1" in -o|-g) test "$2" = root; shift 2;; *) args+=("$1"); shift;; esac
      done
      if [ "$fail" = true ]; then return 1; fi
      command install "\${args[@]}";;
    cmp|mv|rm) command "$@";;
    *) return 99;;
  esac
}
${snippet}`,
						"provision-fragment",
						dir,
						text,
						String(fail),
					],
					{ encoding: "utf8" },
				);

			let result = run();
			assert.equal(result.status, 0, result.stderr);
			const path = join(target, "factory.env");
			assert.equal(readFileSync(path, "utf8"), env);
			assert.equal(statSync(path).mode & 0o777, 0o644);
			assert.equal(statSync(target).mode & 0o777, 0o755);
			chmodSync(target, 0o700);
			const before = statSync(path);
			result = run();
			assert.equal(result.status, 0, result.stderr);
			assert.equal(statSync(path).mtimeMs, before.mtimeMs);
			assert.equal(statSync(path).ino, before.ino);
			assert.equal(statSync(target).mode & 0o777, 0o700);
			result = run(DEFAULT_ENV, true);
			assert.equal(result.status, 1);
			assert.equal(readFileSync(path, "utf8"), env);
			result = run(DEFAULT_ENV);
			assert.equal(result.status, 0, result.stderr);
			assert.equal(readFileSync(path, "utf8"), DEFAULT_ENV);
			assert.notEqual(statSync(path).ino, before.ino);
			assert.equal(statSync(path).mode & 0o777, 0o644);
			const calls = readFileSync(join(dir, "calls"), "utf8");
			assert.match(
				calls,
				/install -m 0644 -o root -g root \/dev\/stdin .*factory.env.tmp/,
			);
			assert.match(calls, /mv -T .*factory.env.tmp .*factory.env/);
			assert.equal(calls.split("install -d").length - 1, 1);
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});

	it("writes the env file beside the host models before settings or package work", () => {
		const first = script.indexOf(
			'if [ "$mode" = all ]; then\n  # The platform edge',
		);

		const last = script.indexOf("\nfi\n", first);
		const block = script.slice(first, last);
		assert.ok(first >= 0 && last > first);
		assert.ok(
			block.indexOf("cat >~/.pi/agent/models.json") <
				block.indexOf("sudo mv -T /etc/factory/factory.env.tmp"),
		);
		assert.ok(
			block.indexOf("sudo mv -T /etc/factory/factory.env.tmp") <
				block.indexOf("settings=~/.pi/agent/settings.json"),
		);
		assert.equal(
			script.split("sudo mv -T /etc/factory/factory.env.tmp").length - 1,
			1,
		);
	});

	it("enables linger once and leaves an already lingering user unchanged", () => {
		const lines = script.split("\n");

		const first = lines.findIndex((line) =>
			line.includes('if [ "$(loginctl show-user exedev'),
		);

		const last = lines.indexOf("  fi", first);
		assert.ok(first >= 0 && last > first);
		const snippet = lines.slice(first, last + 1).join("\n");
		const dir = mkdtempSync(join(tmpdir(), "factory-linger-"));

		try {
			const state = join(dir, "linger");
			writeFileSync(state, "no\n");

			const run = () =>
				spawnSync(
					"bash",
					[
						"-c",
						`set -eu
state=$1
loginctl() {
  case "$1" in
    show-user) test "$*" = 'show-user exedev -p Linger --value'; read -r linger <"$state"; printf '%s\\n' "$linger";;
    enable-linger) test "$*" = 'enable-linger exedev'; printf 'yes\\n' >"$state"; printf 'enabled\\n';;
    *) exit 99;;
  esac
}
sudo() { "$@"; }
${snippet}`,
						"linger-fragment",
						state,
					],
					{ encoding: "utf8" },
				);

			const firstRun = run();
			assert.equal(firstRun.status, 0, firstRun.stderr);
			assert.equal(firstRun.stdout, "enabled\n");
			assert.equal(readFileSync(state, "utf8"), "yes\n");
			const secondRun = run();
			assert.equal(secondRun.status, 0, secondRun.stderr);
			assert.equal(secondRun.stdout, "");
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});
});

it("preflight names an absent runtime directory and does not attempt a user scope", async () => {
	const calls: string[][] = [];

	const result = await runPreflight({
		reconciled: async () => true,
		arch: "x64",
		xdgRuntimeDir: "/run/user/4242",
		usernsLimit: async () => "15000",
		exec: async (command, args) => {
			calls.push([command, ...args]);

			return command === "test"
				? { code: 1, stdout: "", stderr: "" }
				: {
						code: 0,
						stdout: command === "bwrap" ? "bubblewrap 0.9.0\n" : "",
						stderr: "",
					};
		},
		assetsDigest: async () => "digest",
		expectedDigest: "digest",
		gatewayReady: async () => true,
	});

	assert.deepEqual(result, { ok: false, failed: ["runtime_directory"] });
	assert.ok(calls.some((call) => call.join(" ") === "test -d /run/user/4242"));
	assert.equal(
		calls.some(([command]) => command === "systemd-run"),
		false,
	);
});
