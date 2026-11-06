import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { inlined, specifyPrompt } from "../../../../src/specify.ts";

describe("specify prompt exact-fit file", () => {
	it("A3: includes final numbered line and no partial range", () => {
		const text = "const a = 1;\nconst b = 2;";
		const file = inlined(
			"server/cli.ts",
			text,
			Buffer.byteLength(text, "utf8"),
		);
		const prompt = specifyPrompt({
			repo: "giuseppecrj/pi-herdr-factorio",
			baseSha: "c".repeat(40),
			guidance: { general: "g", stages: { specify: "s" } },
			files: ["server/cli.ts"],
			inlined: [file],
			title: "t",
			body: "b",
			answers: null,
		} as never);
		assert.ok(prompt.includes("2\tconst b = 2;"));
		assert.ok(prompt.includes("1\tconst a = 1;"));
		assert.ok(!prompt.includes("(lines "));
	});
});
// factory-holdout-4f0b6d4450eb67b6dd6700dd89cfc363c109729283b452ade68effe8196b866b
