import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import type { TestContext } from "node:test";

/** Match the base/diagnosis suites: unavailable native checks are diagnostic
 * outside the strict native CI job, and a failure in that job. */
export function nativeUserScope(t: TestContext): boolean {
	const probe = spawnSync(
		"systemd-run",
		["--user", "--scope", "--quiet", "true"],
		{ encoding: "utf8", timeout: 10_000 },
	);

	if (probe.status === 0) return true;

	const reason = probe.error?.message ?? probe.stderr.trim();
	assert.notEqual(
		process.env.FACTORY_REQUIRE_SANDBOX_TESTS,
		"1",
		`FACTORY_REQUIRE_SANDBOX_TESTS=1 but user systemd scopes unavailable: ${reason}`,
	);
	t.diagnostic(`not run: user systemd scopes unavailable: ${reason}`);

	return false;
}
