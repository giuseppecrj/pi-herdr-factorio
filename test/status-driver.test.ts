import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { after, describe, it } from "node:test";
import { readPackageVersion, registerFactory } from "../extension/index.ts";
import { readPlatformFile, resolvePlatform } from "../src/trust/platform.ts";

const driver = ".pi/skills/verify-factory/scripts/status-driver.ts";
const temps: string[] = [];

after(() => {
	for (const dir of temps) rmSync(dir, { recursive: true, force: true });
});

function temp(prefix: string): string {
	const dir = mkdtempSync(join(tmpdir(), prefix));
	temps.push(dir);

	return dir;
}

function checkout(): string {
	const dir = temp("status-driver-cwd-");
	execFileSync("git", ["-C", dir, "init", "-q"]);

	return dir;
}

async function registered(args: string, cwd: string) {
	const names: string[] = [];
	const sent: string[] = [];
	let handler: ((args: string) => Promise<void>) | undefined;

	registerFactory(
		{
			registerCommand: (name, options) => {
				names.push(name);

				// SAFETY: the factory handler reads only `cwd` from its context, as in status-driver.ts.
				const ctx = { cwd } as Parameters<typeof options.handler>[1];

				handler = (commandArgs) => options.handler(commandArgs, ctx);
			},
			sendMessage: (message) => {
				sent.push(String(message.content));
			},
			exec: async (command, commandArgs, options) => {
				const result = spawnSync(command, commandArgs, {
					cwd: options?.cwd,
					encoding: "utf8",
					timeout: 30_000,
				});

				return {
					stdout: result.stdout ?? "",
					stderr: result.stderr ?? "",
					code: result.status ?? 1,
					killed: false,
				};
			},
		},
		resolvePlatform({
			env: (name) => process.env[name],
			readFile: () => readPlatformFile(),
		}),
	);

	assert.ok(handler !== undefined);
	await handler(args);

	return { names, text: sent.join("\n") };
}

function drive(args: string, cwd: string) {
	return spawnSync(
		process.execPath,
		["--experimental-strip-types", resolve(driver), args],
		{ cwd, encoding: "utf8" },
	);
}

describe("verify-factory status driver", () => {
	it("prints exactly what the registered factory command sends for status", async () => {
		const cwd = checkout();
		const expected = await registered("status", cwd);
		assert.deepEqual(expected.names, ["factory"]);
		assert.ok(
			expected.text.startsWith(`pi-herdr-factorio ${readPackageVersion()}\n`),
		);

		const result = drive("status", cwd);
		assert.equal(result.status, 0, result.stderr);
		assert.equal(result.stdout, `${expected.text}\n`);
	});

	it("prints the registered usage for an unknown subcommand", async () => {
		const cwd = checkout();
		const expected = await registered("bogus", cwd);
		assert.equal(
			expected.text,
			"Usage: /factory status | /factory run <issue>",
		);

		const result = drive("bogus", cwd);
		assert.equal(result.status, 0, result.stderr);
		assert.equal(result.stdout, `${expected.text}\n`);
	});
});
