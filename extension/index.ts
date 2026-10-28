import { readFileSync } from "node:fs";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { formatStageTable } from "../src/stages.ts";

const STATUS_MESSAGE_TYPE = "factory-status";

export function readPackageVersion(): string {
	const manifest: unknown = JSON.parse(
		readFileSync(new URL("../package.json", import.meta.url), "utf8"),
	);

	if (
		typeof manifest === "object" &&
		manifest !== null &&
		"version" in manifest &&
		typeof manifest.version === "string"
	) {
		return manifest.version;
	}

	return "unknown";
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
