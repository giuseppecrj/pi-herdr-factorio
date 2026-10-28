import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import manifest from "../package.json" with { type: "json" };
import { formatStageTable } from "../src/stages.ts";

const STATUS_MESSAGE_TYPE = "factory-status";

export function readPackageVersion(): string {
	return manifest.version;
}

export function formatStatus(version: string): string {
	return `pi-herdr-factorio ${version}\n\n${formatStageTable()}`;
}

export function factoryCommandText(args: string): string {
	const subcommand = args.trim().split(/\s+/)[0] ?? "";

	return subcommand === "status"
		? formatStatus(readPackageVersion())
		: "Usage: /factory status";
}

export function registerFactory(
	pi: Pick<ExtensionAPI, "registerCommand" | "sendMessage">,
) {
	pi.registerCommand("factory", {
		description: "Software factory: /factory status",
		handler: async (args) => {
			pi.sendMessage({
				customType: STATUS_MESSAGE_TYPE,
				content: factoryCommandText(args),
				display: true,
			});
		},
	});
}

export default function piHerdrFactorio(pi: ExtensionAPI) {
	registerFactory(pi);
}
