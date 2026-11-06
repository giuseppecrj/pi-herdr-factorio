import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { inlined } from "../../../../src/specify.ts";

const DEFAULT_CAP = 12 * 1024;

function exact(unit: string, cap: number): string {
	const lines: string[] = [];
	while (Buffer.byteLength(lines.join("\n") + "\n" + unit, "utf8") <= cap) {
		lines.push(unit);
	}
	let text = lines.join("\n");
	while (Buffer.byteLength(text, "utf8") < cap) text += "a";
	return text;
}

describe("inlined exact fit", () => {
	it("A1: keeps both lines of x\\ny at cap 3", () => {
		const r = inlined("a.ts", "x\ny", 3);
		assert.equal(r.text, "x\ny");
		assert.equal(r.path, "a.ts");
		assert.equal(r.totalLines, 2);
	});

	it("keeps a multibyte exact fit at a custom cap", () => {
		const text = "éé\né";
		assert.equal(Buffer.byteLength(text, "utf8"), 7);
		const r = inlined("m.ts", text, 7);
		assert.equal(r.text, text);
		assert.equal(r.totalLines, 2);
	});

	it("keeps an ASCII exact fit at the default cap", () => {
		const text = exact("a".repeat(63), DEFAULT_CAP);
		assert.equal(Buffer.byteLength(text, "utf8"), DEFAULT_CAP);
		assert.ok(!text.endsWith("\n"));
		const r = inlined("d.ts", text);
		assert.equal(r.text, text);
		assert.equal(r.totalLines, text.split("\n").length);
	});

	it("keeps a multibyte exact fit at the default cap", () => {
		const text = exact("é".repeat(31), DEFAULT_CAP);
		assert.equal(Buffer.byteLength(text, "utf8"), DEFAULT_CAP);
		const r = inlined("d.ts", text);
		assert.equal(r.text, text);
		assert.equal(r.totalLines, text.split("\n").length);
	});
});
// factory-holdout-4f0b6d4450eb67b6dd6700dd89cfc363c109729283b452ade68effe8196b866b
