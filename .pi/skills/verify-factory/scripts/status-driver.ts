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
};
piHerdrFactorio(stub as unknown as Parameters<typeof piHerdrFactorio>[0]);
const handler = handlers.get("factory");
if (!handler) {
	console.error("command factory not registered");
	process.exit(2);
}
await handler(process.argv[2] ?? "status", {});
console.log(sent.join("\n"));
