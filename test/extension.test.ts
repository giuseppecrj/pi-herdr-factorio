import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, it } from "node:test";
import {
	factoryCommandText,
	readPackageVersion,
	readWorkflowState,
	registerFactory,
	type StatusSources,
} from "../extension/index.ts";
import { STAGE_ORDER } from "../src/stages.ts";
import type { Exec, ExecResult } from "../src/workflow.ts";

const remote = "git@github.com:giuseppecrj/pi-herdr-factorio.git\n";
const mainSha = "c".repeat(40);

const workflow = `---
repository: giuseppecrj/pi-herdr-factorio
---
## build
Write the test first.
`;

function ok(stdout: string): ExecResult {
	return { stdout, stderr: "", code: 0 };
}

const offline: ExecResult = {
	stdout: "",
	stderr: "error connecting to api.github.com",
	code: 1,
};

function sources(
	origin: ExecResult,
	gh: (args: readonly string[]) => ExecResult,
): StatusSources {
	const exec: Exec = async (command, args) =>
		command === "git" ? origin : gh(args);

	return {
		exec,
		env: (name) => (name === "HOME" ? "/home/factory" : undefined),
	};
}

function online(args: readonly string[]): ExecResult {
	return args.includes("--jq") ? ok(`${mainSha}\n`) : ok(workflow);
}

describe("/factory command", () => {
	it("registers a single factory command", () => {
		const registered: string[] = [];

		registerFactory({
			registerCommand: (name) => {
				registered.push(name);
			},
			sendMessage: () => {},
			exec: async () => ({ ...offline, killed: false }),
		});

		assert.deepEqual(registered, ["factory"]);
	});

	it("status reports the package version and every stage", async () => {
		const manifest: unknown = JSON.parse(readFileSync("package.json", "utf8"));
		const version = readPackageVersion();

		assert.partialDeepStrictEqual(manifest, { version });

		const text = await factoryCommandText(
			"status",
			sources(ok(remote), online),
		);

		assert.ok(text.startsWith(`pi-herdr-factorio ${version}\n`));

		for (const stage of STAGE_ORDER) {
			assert.match(text, new RegExp(`^${stage}\\s`, "m"));
		}
	});

	it("tolerates surrounding whitespace and explains usage otherwise", async () => {
		const status = sources(ok(remote), online);

		assert.match(
			await factoryCommandText("  status  ", status),
			/^pi-herdr-factorio /,
		);
		assert.equal(
			await factoryCommandText("", status),
			"Usage: /factory status",
		);
		assert.equal(
			await factoryCommandText("run 42", status),
			"Usage: /factory status",
		);
	});

	it("shows trusted main settings and no running controller", async () => {
		const text = await factoryCommandText(
			"status",
			sources(ok(remote), online),
		);

		assert.match(
			text,
			new RegExp(
				`^workflow +giuseppecrj/pi-herdr-factorio main ${mainSha.slice(0, 12)}`,
				"m",
			),
		);
		assert.match(text, /^models +specify openai\/gpt-6\.1-sol/m);
		assert.match(text, /^controller +unavailable: no controller is installed/m);
		assert.match(text, /^execution +disabled$/m);
	});

	it("works offline and says the workflow is unavailable", async () => {
		const text = await factoryCommandText(
			"status",
			sources(ok(remote), () => offline),
		);

		assert.match(
			text,
			/^workflow +unavailable: source_unavailable: .*error connecting/m,
		);
		assert.match(text, /^controller +unavailable/m);
		assert.match(text, /^execution +disabled$/m);
		assert.doesNotMatch(text, /^models/m);
	});

	it("explains a missing or non-GitHub origin", async () => {
		const gitlab = await readWorkflowState(
			sources(ok("https://gitlab.com/a/b.git\n"), online),
		);

		assert.equal(gitlab.kind, "no_repository");

		const none = await factoryCommandText("status", sources(offline, online));

		assert.match(none, /^workflow +unavailable: no git remote named origin$/m);
	});

	it("reads main, never another branch", async () => {
		const refs: string[] = [];

		await readWorkflowState(
			sources(ok(remote), (args) => {
				refs.push(...args.filter((arg) => arg.includes("/git/ref/")));

				return online(args);
			}),
		);

		assert.deepEqual(refs, [
			"repos/giuseppecrj/pi-herdr-factorio/git/ref/heads/main",
		]);
	});

	it("runs the handler with the session cwd and sends the status", async () => {
		const sent: string[] = [];
		const cwds: (string | undefined)[] = [];
		let handler: ((args: string) => Promise<void>) | undefined;

		registerFactory({
			registerCommand: (_name, options) => {
				// SAFETY: the factory handler reads only `cwd` from its context.
				const ctx = { cwd: "/work/checkout" } as Parameters<
					typeof options.handler
				>[1];

				handler = (args) => options.handler(args, ctx);
			},
			sendMessage: (message) => {
				sent.push(String(message.content));
			},
			exec: async (command, args, options) => {
				cwds.push(options?.cwd);

				return {
					...(command === "git" ? ok(remote) : online(args)),
					killed: false,
				};
			},
		});

		await handler?.("status");

		assert.equal(sent.length, 1);
		assert.match(sent[0] ?? "", /^pi-herdr-factorio /);
		assert.ok(cwds.length > 0);
		assert.ok(cwds.every((cwd) => cwd === "/work/checkout"));
	});
});
