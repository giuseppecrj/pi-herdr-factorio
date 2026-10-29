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

const secret = `ghp_${"aB3dE6gH9k".repeat(4).slice(0, 36)}`;
const credentialedOrigin = `https://x-access-token:${secret}@github.com/giuseppecrj/pi-herdr-factorio.git`;

function assertNoCredential(text: string): void {
	assert.doesNotMatch(text, new RegExp(secret));
	assert.doesNotMatch(text, /x-access-token/);
}

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
			/^workflow +unavailable: source_unavailable: cannot resolve the branch: network error$/m,
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

	it("resolves a credentialed GitHub origin without printing the token", async () => {
		const text = await factoryCommandText(
			"status",
			sources(ok(`${credentialedOrigin}\n`), online),
		);

		assert.match(text, /^workflow +giuseppecrj\/pi-herdr-factorio main /m);
		assertNoCredential(text);
	});

	it("prints no part of a credentialed non-GitHub origin", async () => {
		const origin = "https://deploy:hunter2@gitlab.example.com/team/repo.git\n";

		const text = await factoryCommandText(
			"status",
			sources(ok(origin), online),
		);

		assert.match(
			text,
			/^workflow +unavailable: origin is not a GitHub repository$/m,
		);
		assert.doesNotMatch(text, /hunter2|deploy|gitlab|team\/repo/);
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

function serving(text: string): (args: readonly string[]) => ExecResult {
	return (args) => (args.includes("--jq") ? ok(`${mainSha}\n`) : ok(text));
}

function frontMatter(lines: string): string {
	return `---\nrepository: giuseppecrj/pi-herdr-factorio\n${lines}\n---\nbody\n`;
}

type Scenario = {
	origin: string;
	gh: (args: readonly string[]) => Promise<ExecResult>;
};

function file(text: string): Scenario {
	return { origin: remote, gh: async (args) => serving(text)(args) };
}

function failing(result: () => Promise<ExecResult>, step: "resolve" | "fetch") {
	return {
		origin: remote,
		gh: async (args: readonly string[]) =>
			step === "fetch" && args.includes("--jq") ? ok(`${mainSha}\n`) : result(),
	};
}

const scenarios: [string, Scenario][] = [
	[
		"a YAML error excerpt with an unclosed [",
		file(`---\nrepository: [${secret}\n---\n`),
	],
	[
		"an anchor name",
		file(frontMatter(`polling: &${secret}\n  interval_ms: 1`)),
	],
	["an integer value", file(frontMatter(`polling:\n  interval_ms: ${secret}`))],
	[
		"a model value",
		file(frontMatter(`stages:\n  build:\n    model: ${secret}`)),
	],
	[
		"a checkpoint mode",
		file(frontMatter(`checkpoints:\n  approve_merge:\n    mode: ${secret}`)),
	],
	[
		"an environment reference",
		file(frontMatter(`workspace:\n  root: $${secret}`)),
	],
	["a repository value", file(`---\nrepository: owner/${secret}\n---\n`)],
	["a stage heading", file(`${frontMatter("")}\n## ${secret}\n`)],
	[
		"an unknown section key",
		file(frontMatter(`polling:\n  "token ${secret}": 1`)),
	],
	[
		"gh stderr when resolving",
		failing(
			async () => ({ stdout: "", stderr: `gh: ${secret} (HTTP 401)`, code: 1 }),
			"resolve",
		),
	],
	[
		"gh stderr when fetching",
		failing(
			async () => ({
				stdout: "",
				stderr: `fatal: '${credentialedOrigin}' (HTTP 403)`,
				code: 1,
			}),
			"fetch",
		),
	],
	[
		"a query string in gh stderr",
		failing(
			async () => ({
				stdout: "",
				stderr: `Get "https://api.github.com/x?access_token=${secret}": no such host`,
				code: 1,
			}),
			"resolve",
		),
	],
	[
		"a rejected exec when resolving",
		failing(
			async () => Promise.reject(new Error(`spawn gh ${credentialedOrigin}`)),
			"resolve",
		),
	],
	[
		"a rejected exec when fetching",
		failing(
			async () => Promise.reject(new Error(`spawn gh ?token=${secret}`)),
			"fetch",
		),
	],
	[
		"a query string in origin",
		{
			origin: `https://github.com/giuseppecrj/pi-herdr-factorio.git?token=${secret}\n`,
			gh: async (args) => online(args),
		},
	],
	[
		"an origin that hides its host before ?@",
		{
			origin: `https://evil.io?token=${secret}@github.com/giuseppecrj/pi-herdr-factorio.git\n`,
			gh: async (args) => online(args),
		},
	],
];

async function sentFor(scenario: Scenario): Promise<string[]> {
	const sent: string[] = [];
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
		exec: async (command, args) =>
			command === "git"
				? { ...ok(scenario.origin), killed: false }
				: { ...(await scenario.gh(args)), killed: false },
	});

	await handler?.("status");

	return sent;
}

describe("untrusted text never reaches /factory status", () => {
	it("uses a realistic 40-character token", () => {
		assert.match(secret, /^ghp_[A-Za-z0-9]{36}$/);
	});

	for (const [name, scenario] of scenarios) {
		it(`withholds ${name}`, async () => {
			const exec: Exec = async (command, args) =>
				command === "git" ? ok(scenario.origin) : scenario.gh(args);

			const text = await factoryCommandText("status", {
				exec,
				env: (key) => (key === "HOME" ? "/home/factory" : undefined),
			});

			assert.match(text, /^workflow +unavailable: /m);
			assertNoCredential(text);

			const sent = await sentFor(scenario);

			assert.equal(sent.length, 1);
			assert.match(sent[0] ?? "", /^workflow +unavailable: /m);
			assertNoCredential(sent[0] ?? "");
		});
	}

	it("reports a rejected gh exec as other", async () => {
		const sent = await sentFor(
			failing(async () => Promise.reject(new Error("spawn failed")), "fetch"),
		);

		assert.match(
			sent[0] ?? "",
			/^workflow +unavailable: source_unavailable: cannot run gh$/m,
		);
	});
});
