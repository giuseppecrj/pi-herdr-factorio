import { spawnSync } from "node:child_process";
import piHerdrFactorio from "./extension/index.ts";

type Handler = (args: string, ctx: unknown) => Promise<void>;
const handlers = new Map<string, Handler>();
const sent: string[] = [];
const stub = {
	registerCommand: (name: string, def: { handler: Handler }) => {
		handlers.set(name, def.handler);
	},
	sendMessage: (m: { content: string }) => {
		sent.push(m.content);
	},
	exec: async (command: string, args: string[], options?: { cwd?: string }) => {
		const r = spawnSync(command, args, { cwd: options?.cwd, encoding: "utf8", timeout: 30_000 });
		return { stdout: r.stdout ?? "", stderr: r.stderr ?? "", code: r.status ?? 1, killed: false };
	},
};
piHerdrFactorio(stub as unknown as Parameters<typeof piHerdrFactorio>[0]);
const handler = handlers.get("factory");
if (!handler) {
	console.error("command factory not registered");
	process.exit(2);
}
await handler(process.argv[2] ?? "status", { cwd: process.cwd() });
console.log(sent.join("\n"));
