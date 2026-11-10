import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import {
	mkdtempSync,
	readFileSync,
	rmSync,
	statSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import { runCli } from "../server/cli.ts";
import { runPreflight } from "../server/sandbox/preflight.ts";
import type { PlatformFile } from "../src/platform.ts";

const script = readFileSync(
	new URL("../server/provision.sh", import.meta.url),
	"utf8",
);

const unit = readFileSync(
	new URL("../server/factory.service", import.meta.url),
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
GH_ENTERPRISE_TOKEN=exe-dev-integration
LLM_BASE_URL=https://llm.int.exe.xyz
LLM_OPENAI_BASE_URL=https://llm.int.exe.xyz/openai/v1
LLM_ANTHROPIC_BASE_URL=https://llm.int.exe.xyz/anthropic
`;

const EXMACH_ENV = `FACTORY_PLATFORM=exmach:exmach.net
GH_HOST=factorio.int.exmach.net
GH_ENTERPRISE_TOKEN=exmach
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

	it("keeps today's exe-dev host and Pi URLs exactly, adding only nonsecret selectors and placeholders", async () => {
		const result = await render();
		assert.equal(result.stdout, DEFAULT_ENV);
		assert.match(result.stdout, /^GH_HOST=github\.int\.exe\.xyz$/m);
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
			'  platform_env=$(node "$repo/server/cli.ts" platform --env)',
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

	it("sources the CLI output rather than duplicating platform rules in bash", async () => {
		assert.match(
			script,
			/platform_env=\$\(node "\$repo\/server\/cli\.ts" platform --env\)/,
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

	it("writes the exact environment at 0644 with root ownership requested, without rewriting an equal file", async () => {
		const lines = script.split("\n");

		const first = lines.indexOf(
			'  printf \'%s\\n\' "$platform_env" >"$build/factory.env"',
		);

		const last = lines.findIndex(
			(line, index) =>
				index > first &&
				line.includes('"$build/factory.env" /etc/factory/factory.env'),
		);

		assert.ok(first >= 0 && last > first);
		const dir = mkdtempSync(join(tmpdir(), "factory-env-install-"));

		try {
			const target = join(dir, "etc-factory");

			const snippet = lines
				.slice(first, last + 1)
				.join("\n")
				.replaceAll("/etc/factory", target);

			const env = (await render("exmach:exmach.net")).stdout;

			const run = () =>
				spawnSync(
					"bash",
					[
						"-c",
						`set -eu
build=$1
platform_env=$(printf '%s' "$2")
sudo() {
  printf '%s\\n' "$*" >>"$build/calls"
  test "$1" = install
  shift
  local args=()
  while [ "$#" -gt 0 ]; do
    case "$1" in -o|-g) test "$2" = root; shift 2;; *) args+=("$1"); shift;; esac
  done
  command install "\${args[@]}"
}
${snippet}`,
						"provision-fragment",
						dir,
						env,
					],
					{ encoding: "utf8" },
				);

			let result = run();
			assert.equal(result.status, 0, result.stderr);
			const path = join(target, "factory.env");
			assert.equal(readFileSync(path, "utf8"), env);
			assert.equal(statSync(path).mode & 0o777, 0o644);
			const before = statSync(path).mtimeMs;
			result = run();
			assert.equal(result.status, 0, result.stderr);
			assert.equal(statSync(path).mtimeMs, before);
			assert.match(
				readFileSync(join(dir, "calls"), "utf8"),
				/install -C -m 0644 -o root -g root/,
			);
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
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
	assert.ok(calls.some((call) => call.join(" ") === "test -d /run/user/1000"));
	assert.equal(
		calls.some(([command]) => command === "systemd-run"),
		false,
	);
});
