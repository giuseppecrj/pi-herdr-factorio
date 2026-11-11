import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, it } from "node:test";

const script = fileURLToPath(
	new URL("../server/install-exe-dev.sh", import.meta.url),
);

const root = fileURLToPath(new URL("..", import.meta.url));
const sha = "a".repeat(40);

function shell(body: string, args: string[] = []) {
	return spawnSync(
		"bash",
		["-c", `source "$1"\n${body}`, "installer-test", script, ...args],
		{
			encoding: "utf8",
			env: { ...process.env, PATH: `/usr/bin:/bin:${process.env.PATH}` },
			timeout: 10_000,
		},
	);
}

const probes = `
repo=nublai/pi-herdr-factorio
vm=nubl-factory
HOME=/home/exedev
unset FACTORY_PLATFORM
command() {
  if [ "$1" = -v ] && [ "$2" = "__MISSING__" ]; then return 1; fi
  builtin command "$@"
}
uname() { case "$1" in -s) echo Linux;; -m) echo "__ARCH__";; esac; }
id() { case "$1" in -u) echo "__UID__";; -un) echo exedev;; esac; }
sudo() { [ "$*" = '-n -l -- /usr/bin/loginctl enable-linger exedev' ] && [ "__FAIL__" != sudo ]; }
getent() { [ "__FAIL__" != exe_dev_vm ] && echo '169.254.169.254 STREAM integration'; }
sysctl() { echo "__LIMIT__"; }
unshare() { [ "__FAIL__" != user_namespaces ]; }
bwrap() {
  if [ "$1" = --version ]; then echo 'bubblewrap __VERSION__'; else [ "__FAIL__" != bwrap_smoke ]; fi
}
systemctl() { if [ "__FAIL__" = systemd ]; then echo unavailable; else echo running; fi; }
loginctl() { [ "$*" = 'list-users --no-legend' ] && [ "__FAIL__" != linger ]; }
curl() {
  case "$*" in
    *github.int.exe.xyz*)
      if [ "__FAIL__" = github_integration ]; then echo 'integration not found or not attached to this VM'; return 22; fi
      echo '{"full_name":"nublai/pi-herdr-factorio"}' ;;
    *openai/v1/models*)
      if [ "__FAIL__" = model_route ]; then echo 'private-error-canary' >&2; return 22; fi
      echo '{"data":[{"id":"catalog-only-no-model-call"}]}' ;;
    *) echo 'unexpected network probe' >&2; exit 99;;
  esac
}
df() {
  echo 'Filesystem blocks used available capacity mounted'
  if [ "__FAIL__" = disk ]; then echo 'fixture 100 99 1 99% /'; else echo 'fixture 9999999 0 9999999 0% /'; fi
}
install_controller() { echo 'MUTATION ATTEMPT' >&2; exit 99; }
`;

function fixture(
	options: {
		fail?: string;
		missing?: string;
		arch?: string;
		uid?: string;
		limit?: string;
		version?: string;
	} = {},
) {
	return probes
		.replaceAll("__FAIL__", options.fail ?? "none")
		.replaceAll("__MISSING__", options.missing ?? "none")
		.replaceAll("__ARCH__", options.arch ?? "x86_64")
		.replaceAll("__UID__", options.uid ?? "1000")
		.replaceAll("__LIMIT__", options.limit ?? "15000")
		.replaceAll("__VERSION__", options.version ?? "0.9.0");
}

describe("exe.dev installer read-only preflight (stubbed external infrastructure)", () => {
	it("--check runs all probes but never enters installation, even with a commit", () => {
		const result = shell(`${fixture()}\nmain --check --vm pi-factorio ${sha}`);
		assert.equal(result.status, 0, result.stderr);
		assert.match(
			result.stdout,
			/preflight=ok repo=nublai\/pi-herdr-factorio vm=pi-factorio/,
		);
		assert.equal(result.stderr, "");
	});

	for (const tool of [
		"sudo",
		"curl",
		"git",
		"gh",
		"jq",
		"bwrap",
		"unshare",
		"systemctl",
		"loginctl",
		"systemd-notify",
		"getent",
		"df",
		"awk",
		"timeout",
		"flock",
		"sysctl",
		"tar",
		"xz",
		"sha256sum",
	]) {
		it(`refuses missing package ${tool} before mutation`, (t) => {
			const result = shell(`${fixture({ missing: tool })}\nmain --check`);
			assert.equal(result.status, 1);
			assert.match(
				result.stderr,
				new RegExp(
					`REFUSE package_${tool}\\nfix: sudo apt-get update && sudo apt-get install -y `,
				),
			);
			assert.doesNotMatch(result.stderr, /MUTATION/);
			t.diagnostic(result.stderr.trim());
		});
	}

	for (const reason of [
		"exe_dev_vm",
		"sudo",
		"user_namespaces",
		"bwrap_smoke",
		"systemd",
		"linger",
		"github_integration",
		"model_route",
		"disk",
	]) {
		it(`refuses ${reason} with an actionable named fix`, (t) => {
			const result = shell(`${fixture({ fail: reason })}\nmain --check`);
			assert.equal(result.status, 1, result.stdout);
			assert.match(result.stderr, new RegExp(`REFUSE ${reason}\\nfix: .+`));
			assert.doesNotMatch(
				result.stdout + result.stderr,
				/MUTATION|private-error-canary|integration not found/,
			);
			t.diagnostic(result.stderr.trim());
		});
	}

	for (const [name, options] of [
		["architecture", { arch: "aarch64" }],
		["user", { uid: "0" }],
		["user_namespaces", { limit: "0" }],
		["bwrap_version", { version: "0.8.0" }],
	] satisfies [string, Parameters<typeof fixture>[0]][]) {
		it(`refuses ${name} inputs`, () => {
			const result = shell(`${fixture(options)}\nmain --check`);
			assert.equal(result.status, 1);
			assert.match(result.stderr, new RegExp(`REFUSE ${name}\\nfix: `));
		});
	}

	it("refuses another selected platform and an existing selection file", () => {
		for (const setup of [
			"FACTORY_PLATFORM=exmach:exmach.net",
			`[() { if [[ "$*" = '! -e /etc/factory/platform.json ]' ]]; then return 1; fi; builtin [ "$@"; }`,
		]) {
			const result = shell(`${fixture()}\n${setup}\nmain --check`);
			assert.equal(result.status, 1, result.stderr);
			assert.match(result.stderr, /REFUSE platform\nfix: /);
		}
	});

	it("rejects an unrelated repository response and an empty model catalog", () => {
		const wrongRepo = shell(
			`${fixture().replace('nublai/pi-herdr-factorio"}', 'wrong/repo"}')}\nmain --check`,
		);

		assert.equal(wrongRepo.status, 1);
		assert.match(wrongRepo.stderr, /REFUSE github_integration/);

		const emptyModels = shell(
			`${fixture().replace('{"data":[{"id":"catalog-only-no-model-call"}]}', '{"data":[]}')}\nmain --check`,
		);

		assert.equal(emptyModels.status, 1);
		assert.match(emptyModels.stderr, /REFUSE model_route/);
	});
});

describe("exe.dev installer pure and isolated helpers (never a full install)", () => {
	it("requires a full lowercase SHA and validates arguments before any probe", () => {
		for (const invalid of [
			"",
			"main",
			"v1.0",
			"abcdef1",
			"a".repeat(39),
			"a".repeat(41),
			"A".repeat(40),
			"--help",
		]) {
			const result = shell('main "$2"', [invalid]);
			assert.equal(result.status, 1);
			assert.match(result.stderr, /REFUSE commit_sha/);
		}

		assert.equal(shell(`validate_commit ${sha}`).status, 0);

		for (const args of [
			"--repo",
			"--repo ../bad --check",
			"--vm",
			"--vm --option --check",
			"--check --repo a/b extra extra",
			"--check --repo a/b?secret=value",
		]) {
			const result = shell(`main ${args}`);
			assert.equal(result.status, 1);
			assert.match(result.stderr, /REFUSE arguments/);
		}
	});

	it("checks HEAD using real local git and refuses a mismatch", () => {
		const dir = mkdtempSync(join(tmpdir(), "installer-head-"));

		try {
			const result = shell(
				`git init -q "$2"; git -C "$2" -c user.name=fixture -c user.email=fixture@example.invalid commit -q --allow-empty -m fixture; head=$(git -C "$2" rev-parse HEAD); verify_head "$2" "$head"; verify_head "$2" ${sha}`,
				[dir],
			);

			assert.equal(result.status, 1);
			assert.match(result.stderr, /REFUSE checkout_sha/);
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});

	it("creates a private state and hold once, preserving hold bytes and metadata on rerun", () => {
		const dir = mkdtempSync(join(tmpdir(), "installer-hold-"));

		try {
			const result = shell(
				'ensure_hold "$2/state"; stat -c "%a:%u" "$2/state"; stat -c "%a" "$2/state/disabled"; printf retained >"$2/state/disabled"; before=$(stat -c "%i:%s:%Y:%Z" "$2/state/disabled"); ensure_hold "$2/state"; [ "$before" = "$(stat -c "%i:%s:%Y:%Z" "$2/state/disabled")" ]; command cat "$2/state/disabled"',
				[dir],
			);

			assert.equal(result.status, 0, result.stderr);
			assert.match(result.stdout, /^700:\d+\n600\nretained$/);

			const unsafe = shell(
				'mkdir -m 755 "$2/unsafe"; ensure_hold "$2/unsafe"',
				[dir],
			);

			assert.equal(unsafe.status, 1);
			assert.match(unsafe.stderr, /REFUSE state_permissions/);

			const symlink = shell(
				'ln -s "$2/state" "$2/link"; ensure_hold "$2/link"',
				[dir],
			);

			assert.equal(symlink.status, 1);
			assert.match(symlink.stderr, /REFUSE state_directory/);

			const heldLink = shell(
				'rm "$2/state/disabled"; ln -s "$2/absent" "$2/state/disabled"; ensure_hold "$2/state"; test -L "$2/state/disabled"; test ! -e "$2/absent"',
				[dir],
			);

			assert.equal(heldLink.status, 0, heldLink.stderr);
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});

	it("renders the selected repository without changing the static unit", () => {
		const before = readFileSync(join(root, "server/factory.service"), "utf8");
		const result = shell('repo=acme/widgets; render_unit "$2"', [root]);
		assert.equal(result.status, 0, result.stderr);
		assert.equal(
			result.stdout,
			before.replace("--repo nublai/pi-herdr-factorio", "--repo acme/widgets"),
		);
		assert.equal(
			readFileSync(join(root, "server/factory.service"), "utf8"),
			before,
		);
	});

	it("requires a running controller's locally_disabled dispatch reason from status --json", () => {
		const dir = mkdtempSync(join(tmpdir(), "installer-status-"));

		try {
			for (const [state, reasons, enabled, expected] of [
				["running", ["locally_disabled", "sandbox_preflight"], false, 0],
				["running", [], false, 1],
				["stopped", ["locally_disabled"], false, 1],
				["running", ["locally_disabled"], true, 1],
			] satisfies [string, string[], boolean, number][]) {
				writeFileSync(
					join(dir, "status"),
					JSON.stringify({
						controller: { state, lastTick: { dispatch: { reasons, enabled } } },
					}),
				);

				const result = shell(
					'checkout=$2; state_dir=$2; repo=nublai/pi-herdr-factorio; timeout() { command cat "$checkout/status"; }; held_status',
					[dir],
				);

				assert.equal(result.status, expected, result.stderr);

				if (expected === 0) assert.match(result.stdout, /locally_disabled/);
			}
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});

	it("keeps the hold before every mutating install phase and never removes it", () => {
		const source = readFileSync(script, "utf8");
		const hold = source.indexOf('ensure_hold "$state_dir"');

		for (const phase of [
			"sudo systemctl stop",
			" clone --quiet",
			" fetch --quiet",
			'bash "$checkout/server/provision.sh"',
			"sudo systemctl enable",
			"sudo systemctl restart",
		]) {
			assert.ok(source.indexOf(phase) > hold, phase);
		}

		assert.doesNotMatch(source, /(?:^|;)\s*(?:rm|unlink)\s[^\n]*disabled/m);
		assert.match(source, /verify_head "\$checkout" "\$commit"/);
		assert.match(source, /already_installed=/);
		assert.match(source, /_SYSTEMD_INVOCATION_ID=/);
	});
});
