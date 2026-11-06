import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { inlined, specifyPrompt } from "../../../../src/specify.ts";

function check(text: string, cap: number) {
	const r = inlined("p.ts", text, cap);
	assert.ok(Buffer.byteLength(r.text, "utf8") <= cap);
	assert.equal(r.path, "p.ts");
	assert.equal(r.totalLines, text.split("\n").length);
	const kept = r.text === "" ? [] : r.text.split("\n");
	const all = text.split("\n");
	assert.deepEqual(kept, all.slice(0, kept.length));
	return r;
}

describe("inlined oversized input", () => {
	it("truncates ASCII at a line boundary", () => {
		const r = check("aaaa\nbbbb\ncccc", 10);
		assert.equal(r.text, "aaaa\nbbbb");
		assert.equal(r.totalLines, 3);
	});

	it("truncates multibyte input without splitting characters", () => {
		const r = check("éé\néé\néé", 8);
		assert.equal(r.text, "éé");
		assert.equal(r.totalLines, 3);
	});

	it("yields empty text when the first line is oversized", () => {
		const r = check("abcdefgh\nz", 4);
		assert.equal(r.text, "");
		assert.equal(r.totalLines, 2);
	});

	it("never exceeds the default cap on large input", () => {
		const text = `${"x".repeat(100)}\n`.repeat(200);
		const r = check(text, 12 * 1024);
		assert.equal(r.totalLines, 201);
		const d = inlined("p.ts", text);
		assert.equal(d.text, r.text);
		assert.equal(d.text.split("\n").length, 121);
	});

	it("A5: large file prompt shows partial range", () => {
		const file = inlined("src/run.ts", `${"x".repeat(100)}\n`.repeat(200));
		const prompt = specifyPrompt({
			repo: "giuseppecrj/pi-herdr-factorio",
			baseSha: "c".repeat(40),
			guidance: { general: "g", stages: { specify: "s" } },
			files: ["src/run.ts"],
			inlined: [file],
			title: "t",
			body: "b",
			answers: null,
		} as never);
		assert.ok(prompt.includes("=== src/run.ts (lines 1-121 of 201) ===\n1\t"));
		assert.ok(!prompt.includes("122\txxx"));
	});
});
// factory-holdout-4f0b6d4450eb67b6dd6700dd89cfc363c109729283b452ade68effe8196b866b
