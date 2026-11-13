import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { describe, it } from "node:test";
import { fileURLToPath } from "node:url";

const repo = fileURLToPath(new URL("../../../", import.meta.url));

const css = readFileSync(
	new URL("../../../host/viewer/design/tokens.css", import.meta.url),
	"utf8",
);

describe("design tokens", () => {
	it("tokens.css is exactly what tokens.json generates", () => {
		const output = execFileSync(
			process.execPath,
			["scripts/design-tokens.mjs", "--check"],
			{ cwd: repo, encoding: "utf8" },
		);

		assert.equal(output, "");
	});

	it("every var(--…) in tokens.css is defined there", () => {
		const defined = new Set(
			[...css.matchAll(/^\s*(--[a-z0-9-]+):/gm)].map((m) => m[1]),
		);

		const used = [...css.matchAll(/var\((--[a-z0-9-]+)\)/g)].map((m) => m[1]);
		assert.ok(used.length > 0);
		assert.deepEqual(
			used.filter((name) => !defined.has(name)),
			[],
		);
	});
});
