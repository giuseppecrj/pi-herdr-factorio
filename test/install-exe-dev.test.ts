import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, it } from "node:test";

const script =
	process.env.INSTALLER_UNDER_TEST ??
	fileURLToPath(new URL("../server/install-exe-dev.sh", import.meta.url));

const root = fileURLToPath(new URL("..", import.meta.url));
const sha = "a".repeat(40);

function shell(body: string, args: string[] = []) {
	return spawnSync(
		"bash",
		["-c", `source "$1"\n${body}`, "installer-test", script, ...args],
		{
			encoding: "utf8",
			env: { ...process.env, PATH: `/usr/bin:/bin:${process.env.PATH}` },
			timeout: 30_000,
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
sudo() { [ "$*" = '-n true' ] && [ "__FAIL__" != sudo ]; }
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
			`[() { if [[ "$*" = '-e /etc/factory/platform.json ]' ]]; then return 0; fi; builtin [ "$@"; }`,
			`[() { if [[ "$*" = '-L /etc/factory/platform.json ]' ]]; then return 0; fi; builtin [ "$@"; }`,
		]) {
			const result = shell(`${fixture()}\n${setup}\nmain --check`);
			assert.equal(result.status, 1, result.stderr);
			assert.match(result.stderr, /REFUSE platform\nfix: /);
		}
	});

	it("reports any hold entry and gives correct package and integration recovery text", () => {
		for (const type of ["-e", "-L"]) {
			const result = shell(
				`${fixture()}\n[() { if [[ "$*" = '${type} /home/exedev/factory-state/disabled ]' ]]; then return 0; fi; builtin [ "$@"; }\nmain --check`,
			);

			assert.equal(result.status, 0, result.stderr);
			assert.match(result.stdout, /existing_hold=present/);
		}

		const login = shell(`${fixture({ missing: "loginctl" })}\nmain --check`);
		assert.match(login.stderr, /install -y systemd/);
		assert.doesNotMatch(login.stderr, /libpam-systemd/);

		const github = shell(
			`${fixture({ fail: "github_integration" })}\nmain --check`,
		);

		assert.match(github.stderr, /integrations list/);
		assert.match(github.stderr, /add github --repository/);
		assert.match(github.stderr, /attach <existing> vm:nubl-factory/);
		assert.doesNotMatch(github.stderr, /--name/);

		const model = shell(`${fixture({ fail: "model_route" })}\nmain --check`);
		assert.match(model.stderr, /auto:all/);
		assert.match(model.stderr, /ssh exe.dev integrations list/);
		assert.doesNotMatch(model.stderr, /integrations attach llm/);
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

// Adapted from install-review/h/{setup,run}.sh: real local Git, fake host services.
const installHarness = String.raw`
W=$2
export W FAKE="$W/fake" LOG="$W/log"
mkdir -p "$FAKE/etc" "$W/home" "$W/bin" "$W/src/server"
cp "$1" "$W/src/server/install-exe-dev.sh"
cp "$3/server/factory.service" "$W/src/server/"
cat >"$W/src/server/provision.sh" <<'P'
echo "provision hold=$([ -e "$HOME/factory-state/disabled" ] && echo y || echo n)" >>"$LOG"
[ -z "${"${PROVISION_FAIL:-}"}" ] || { echo provision-fail >&2; exit 1; }
mkdir -p "$(dirname "$0")/../node_modules"
P
# A marker exists only in the pinned installer, not in the bootstrap being sourced.
sed -i '2i echo pinned-installer >>"$LOG"' "$W/src/server/install-exe-dev.sh"
echo node_modules/ >"$W/src/.gitignore"
git init -q --bare "$W/origin.git"
git init -q "$W/src"
git -C "$W/src" add -A
git -C "$W/src" -c user.name=x -c user.email=x@x commit -qm A
A=$(git -C "$W/src" rev-parse HEAD)
echo B >"$W/src/B"
git -C "$W/src" add -A
git -C "$W/src" -c user.name=x -c user.email=x@x commit -qm B
B=$(git -C "$W/src" rev-parse HEAD)
git -C "$W/src" push -q "$W/origin.git" HEAD:refs/heads/main
git -C "$W/origin.git" symbolic-ref HEAD refs/heads/main
cat >"$W/home/.gitconfig" <<G
[url "file://$W/origin.git"]
  insteadOf = https://github.int.exe.xyz/nublai/pi-herdr-factorio.git
[protocol "file"]
  allow = always
G
cat >"$W/bin/systemctl" <<'S'
#!/bin/bash
echo "systemctl $* hold=$([ -e "$HOME/factory-state/disabled" ] && echo y || echo n)" >>"$LOG"
case "$1" in
  stop) [ -z "${"${STOP_FAIL:-}"}" ] || exit 1; rm -f "$FAKE/active"; [ -f "$FAKE/etc/factory.service" ] || exit 5;;
  restart) touch "$FAKE/active"; echo new-invocation >"$FAKE/inv"; fresh-status;;
  is-active) [ -f "$FAKE/active" ];;
  show) case "$*" in *LoadState*) [ -f "$FAKE/etc/factory.service" ] && echo loaded || echo not-found;; *InvocationID*) cat "$FAKE/inv";; esac;;
  enable) touch "$FAKE/enabled";;
  disable) rm -f "$FAKE/enabled"; [[ "$*" != *--now* ]] || rm -f "$FAKE/active";;
  daemon-reload) :;;
  *) exit 99;;
esac
S
cat >"$W/bin/sudo" <<'S'
#!/bin/bash
echo "sudo $*" >>"$LOG"
case "$1" in
  install) args=("$@"); [ "${"${args[-1]}"}" = /etc/systemd/system/factory.service ] || exit 99; cp "${"${args[-2]}"}" "$FAKE/etc/factory.service";;
  systemctl) shift; exec systemctl "$@";;
  journalctl) [ -z "${"${JOURNAL_FAIL:-}"}" ] || exit 1; echo event=controller_ready; if [ -n "${"${LARGE_JOURNAL:-}"}" ]; then for chunk in {1..100}; do printf '%10000s\n' end || exit $?; done; fi;;
  *) echo "UNEXPECTED sudo $*" >&2; exit 99;;
esac
S
cat >"$W/bin/node" <<'S'
#!/bin/bash
echo "node $*" >>"$LOG"
st=stopped; [ ! -f "$FAKE/active" ] || st=running
jq -n --arg st "$st" --slurpfile tick "$HOME/factory-state/status.json" '{platform:{repositories:["nublai/pi-herdr-factorio"]},controller:{state:$st,lastTick:$tick[0]}}'
S
cat >"$W/bin/fresh-status" <<'S'
#!/bin/bash
[ -z "${"${STALE_STATUS:-}"}" ] || exit 0
# A deterministic future ISO timestamp avoids same-millisecond fixture races.
printf '{"at":"2099-01-01T00:00:00.000Z","dispatch":{"enabled":false,"reasons":["locally_disabled"]}}\n' >"$HOME/factory-state/status.json"
S
cat >"$W/bin/sleep" <<'S'
#!/bin/bash
echo wait >>"$LOG"
[ -z "${"${REFRESH_ON_WAIT:-}"}" ] || fresh-status
exit 0
S
cat >"$W/bin/git" <<'S'
#!/bin/bash
if [[ " $* " == *" remote get-url origin "* ]]; then echo https://github.int.exe.xyz/nublai/pi-herdr-factorio.git; exit; fi
if [ -n "${"${FETCH_FAIL:-}"}" ] && [[ " $* " == *" fetch "* ]]; then echo fetch-failed >>"$LOG"; exit 128; fi
exec /usr/bin/git "$@"
S
cat >"$W/bin/cmp" <<'S'
#!/bin/bash
args=("$@"); [ "${"${args[-1]}"}" != /etc/systemd/system/factory.service ] || args[-1]="$FAKE/etc/factory.service"
exec /usr/bin/cmp "${"${args[@]}"}"
S
chmod +x "$W/bin/"*
export HOME="$W/home" PATH="$W/bin:/usr/bin:/bin"
mkdir -m 700 "$HOME/factory-state"
echo '{"at":"2000-01-01T00:00:00.000Z","dispatch":{"enabled":false,"reasons":["locally_disabled"]}}' >"$HOME/factory-state/status.json"
cat >"$W/run.sh" <<'S'
source "$1"
preflight() { echo preflight-stubbed; }
main "$2"
S
run() { bash "$W/run.sh" "$1" "$2"; }
bootstrap=$1
checkout="$HOME/pi-herdr-factorio"
state="$HOME/factory-state"
absent_log() { if grep -Eq "$1" "$LOG"; then exit 92; fi; }
`;

function isolatedInstall(body: string) {
	const dir = mkdtempSync(join(tmpdir(), "installer-lifecycle-"));

	try {
		return shell(`${installHarness}\n${body}`, [dir, root]);
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
}

describe("exe.dev installer lifecycle (reviewer's stub harness, no real host writes)", () => {
	it("cleans a failed first fetch and retries from a complete verified checkout", () => {
		const result = isolatedInstall(`
if FETCH_FAIL=1 run "$bootstrap" "$A"; then exit 91; fi
[ ! -e "$checkout" ]
[ -z "$(find "$HOME" -maxdepth 1 -name '.pi-herdr-factorio.install.*' -print)" ]
absent_log 'systemctl stop'
run "$bootstrap" "$A"
[ "$(git -C "$checkout" rev-parse HEAD)" = "$A" ]
[ -z "$(git -C "$checkout" status --porcelain)" ]
[ -f "$FAKE/active" ]
[ -f "$FAKE/enabled" ]
[ -f "$state/disabled" ]
[ "$(cat "$state/install-exe-dev.commit")" = "$A nublai/pi-herdr-factorio" ]
[ -z "$(find "$HOME" -maxdepth 1 -name '.pi-herdr-factorio.install.*' -print)" ]
`);

		assert.equal(result.status, 0, result.stdout + result.stderr);
		assert.match(result.stderr, /REFUSE fetch_commit/);
		assert.match(result.stdout, /installed=/);
	});

	it("leaves the old controller running and checkout unchanged on upgrade fetch failure", () => {
		const result = isolatedInstall(`
run "$bootstrap" "$A"
: >"$LOG"
if FETCH_FAIL=1 run "$bootstrap" "$B"; then exit 91; fi
[ -f "$FAKE/active" ]
[ -f "$FAKE/enabled" ]
[ "$(git -C "$checkout" rev-parse HEAD)" = "$A" ]
absent_log 'systemctl stop|REFUSE checkout_sha'
`);

		assert.equal(result.status, 0, result.stdout + result.stderr);
		assert.match(result.stderr, /REFUSE fetch_commit/);
		assert.doesNotMatch(result.stderr, /REFUSE checkout_sha/);
	});

	it("stops and disables a failed provision, retains the hold and old receipt, then recovers", () => {
		const result = isolatedInstall(`
run "$bootstrap" "$A"
if PROVISION_FAIL=1 run "$bootstrap" "$B"; then exit 91; fi
[ ! -f "$FAKE/active" ]
[ ! -f "$FAKE/enabled" ]
[ -e "$state/disabled" ]
[ "$(cat "$state/install-exe-dev.commit")" = "$A nublai/pi-herdr-factorio" ]
[ -z "$(find "$HOME" -maxdepth 1 -name '.pi-herdr-factorio.install.*' -print)" ]
run "$bootstrap" "$B"
[ -f "$FAKE/active" ]
[ -f "$FAKE/enabled" ]
absent_log 'hold=n'
`);

		assert.equal(result.status, 0, result.stdout + result.stderr);
		assert.match(result.stderr, /provision-fail/);
		assert.match(
			result.stderr,
			/controller is stopped and disabled; the hold is in place/,
		);
		assert.doesNotMatch(result.stderr, /REFUSE checkout_sha/);
	});

	it("rejects stale held status and does not write a success receipt", () => {
		const result = isolatedInstall(`
if STALE_STATUS=1 run "$bootstrap" "$A"; then exit 91; fi
[ ! -f "$state/install-exe-dev.commit" ]
[ ! -f "$FAKE/active" ]
[ ! -f "$FAKE/enabled" ]
[ -e "$state/disabled" ]
[ "$(grep -c '^wait$' "$LOG")" = 24 ]
`);

		assert.equal(result.status, 0, result.stdout + result.stderr);
		assert.match(result.stderr, /REFUSE hold_unconfirmed/);
	});

	it("runs the pinned installer before provisioning and does not recurse", () => {
		const result = isolatedInstall(`
run "$bootstrap" "$A"
[ "$(grep -c '^pinned-installer$' "$LOG")" = 1 ]
[ "$(grep -c '^provision ' "$LOG")" = 1 ]
[ "$(grep -n '^pinned-installer$' "$LOG" | cut -d: -f1)" -lt "$(grep -n '^provision ' "$LOG" | cut -d: -f1)" ]
`);

		assert.equal(result.status, 0, result.stdout + result.stderr);
	});

	it("reports a no-op without a false refusal, restores a lifted hold and waits for fresh evidence", () => {
		const result = isolatedInstall(`
run "$bootstrap" "$A"
rm "$state/disabled"
echo '{"at":"2000-01-01T00:00:00.000Z","dispatch":{"enabled":true,"reasons":[]}}' >"$state/status.json"
: >"$LOG"
REFRESH_ON_WAIT=1 run "$bootstrap" "$A"
[ -e "$state/disabled" ]
grep -q '^wait$' "$LOG"
absent_log '^provision |systemctl restart|systemctl stop'
`);

		assert.equal(result.status, 0, result.stdout + result.stderr);
		assert.match(result.stdout, /already_installed=.*hold retained/);
		assert.doesNotMatch(result.stderr, /REFUSE/);
	});

	it("captures large journals without a pipefail SIGPIPE false refusal", () => {
		const result = isolatedInstall('LARGE_JOURNAL=1 run "$bootstrap" "$A"');

		assert.equal(result.status, 0, result.stdout + result.stderr);
		assert.doesNotMatch(result.stderr, /REFUSE controller_ready/);
	});

	it("cleans temporary files and reports recovery on a post-stop journal failure", () => {
		const result = isolatedInstall(`
if JOURNAL_FAIL=1 run "$bootstrap" "$A"; then exit 91; fi
[ ! -f "$FAKE/active" ]
[ ! -f "$FAKE/enabled" ]
[ -e "$state/disabled" ]
[ ! -f "$state/install-exe-dev.commit" ]
[ -z "$(find "$HOME" -maxdepth 1 -name '.pi-herdr-factorio.install.*' -print)" ]
`);

		assert.equal(result.status, 0, result.stdout + result.stderr);
		assert.match(
			result.stderr,
			/controller is stopped and disabled; the hold is in place/,
		);
	});
});

describe("exe.dev installer pure and isolated helpers (never a real install)", () => {
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

	it("rejects direct continuation instead of recursing or probing the host", () => {
		const result = shell(`main --continue /tmp/unverified ${sha}`);
		assert.equal(result.status, 1);
		assert.match(result.stderr, /REFUSE continuation/);
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

	it("changes only the repo argument in a unit with additional start flags", () => {
		const dir = mkdtempSync(join(tmpdir(), "installer-unit-"));

		try {
			const result = shell(
				`mkdir "$2/server"; printf '%s\\n' 'ExecStart=/custom/node server/cli.ts serve --repo old/repo --state-dir /custom/state --issue 42' >"$2/server/factory.service"; repo=acme/widgets; render_unit "$2"`,
				[dir],
			);

			assert.equal(result.status, 0, result.stderr);
			assert.equal(
				result.stdout,
				"ExecStart=/custom/node server/cli.ts serve --repo acme/widgets --state-dir /custom/state --issue 42\n",
			);
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
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
						controller: {
							state,
							lastTick: {
								at: "2026-11-11T00:00:00.000Z",
								dispatch: { reasons, enabled },
							},
						},
					}),
				);

				const result = shell(
					'checkout=$2; state_dir=$2; repo=nublai/pi-herdr-factorio; timeout() { command cat "$checkout/status"; }; held_status 2026-11-10T00:00:00.000Z',
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
