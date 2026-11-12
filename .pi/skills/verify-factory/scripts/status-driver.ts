import { spawnSync } from "node:child_process";
import { registerFactory } from "../../../../extension/index.ts";
import {
	readPlatformFile,
	resolvePlatform,
} from "../../../../src/trust/platform.ts";

let handler: ((args: string) => Promise<void>) | undefined;
const sent: string[] = [];

registerFactory(
	{
		registerCommand: (name, options) => {
			if (name !== "factory") return;

			// SAFETY: the factory handler reads only `cwd` from its context.
			const ctx = { cwd: process.cwd() } as Parameters<
				typeof options.handler
			>[1];

			handler = (args) => options.handler(args, ctx);
		},
		sendMessage: (message) => {
			sent.push(String(message.content));
		},
		exec: async (command, args, options) => {
			const r = spawnSync(command, args, {
				cwd: options?.cwd,
				encoding: "utf8",
				timeout: 30_000,
			});

			return {
				stdout: r.stdout ?? "",
				stderr: r.stderr ?? "",
				code: r.status ?? 1,
				killed: false,
			};
		},
	},
	resolvePlatform({
		env: (name) => process.env[name],
		readFile: () => readPlatformFile(),
	}),
);

if (handler === undefined) {
	console.error("command factory not registered");
	process.exit(2);
}

await handler(process.argv[2] ?? "status");

console.log(sent.join("\n"));
