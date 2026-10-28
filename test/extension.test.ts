import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, it } from "node:test";
import {
	factoryCommandText,
	readPackageVersion,
	registerFactory,
} from "../extension/index.ts";
import { STAGE_ORDER } from "../src/stages.ts";

describe("/factory command", () => {
	it("registers a single factory command", () => {
		const registered: string[] = [];
		registerFactory({
			registerCommand: (name) => {
				registered.push(name);
			},
			sendMessage: () => {},
		});
		assert.deepEqual(registered, ["factory"]);
	});

	it("status reports the package version and every stage", () => {
		const manifest: unknown = JSON.parse(readFileSync("package.json", "utf8"));

		const version =
			typeof manifest === "object" && manifest !== null && "version" in manifest
				? manifest.version
				: undefined;

		assert.equal(readPackageVersion(), version);

		const text = factoryCommandText("status");
		assert.ok(text.startsWith(`pi-herdr-factorio ${version}\n`));

		for (const stage of STAGE_ORDER) {
			assert.match(text, new RegExp(`^${stage}\\s`, "m"));
		}
	});

	it("tolerates surrounding whitespace and explains usage otherwise", () => {
		assert.match(factoryCommandText("  status  "), /^pi-herdr-factorio /);
		assert.equal(factoryCommandText(""), "Usage: /factory status");
		assert.equal(factoryCommandText("run 42"), "Usage: /factory status");
	});
});
