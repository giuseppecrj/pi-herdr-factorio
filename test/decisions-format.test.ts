import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import {
	appendFileSync,
	cpSync,
	mkdirSync,
	mkdtempSync,
	readFileSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, describe, it } from "node:test";
import { fileURLToPath } from "node:url";
import {
	fieldOf,
	numberOf,
	objectOf,
	parseJson,
	textsOf,
} from "../server/sandbox/json.ts";

const repo = fileURLToPath(new URL("../", import.meta.url));
const script = join(repo, "scripts/check-decisions.mjs");
const file = "docs/decisions.tsv";
const temps: string[] = [];

after(() => {
	for (const dir of temps) rmSync(dir, { recursive: true, force: true });
});

function copyRepo(): string {
	const root = mkdtempSync(join(tmpdir(), "decisions-"));
	temps.push(root);
	mkdirSync(join(root, "docs"));
	mkdirSync(join(root, "scripts"));
	cpSync(join(repo, file), join(root, file));
	cpSync(
		join(repo, "scripts/decisions-checkpoint.json"),
		join(root, "scripts/decisions-checkpoint.json"),
	);

	return root;
}

function appendLoggedRow(root: string): void {
	appendFileSync(
		join(root, file),
		`${lastTimestamp(root)}\tlayout\tappend a row\twhy it was appended\t'-evidence starting with a dash\tdone\n`,
	);
}

function checkpointBytes(root: string): number {
	const checkpoint = parseJson(
		readFileSync(join(root, "scripts/decisions-checkpoint.json"), "utf8"),
	);

	const bytes = numberOf(fieldOf(objectOf(checkpoint), "bytes"));
	assert.ok(bytes !== null);

	return bytes;
}

function check(root: string): string[] {
	const result = spawnSync(
		process.execPath,
		[script, "--root", root, "--json"],
		{
			encoding: "utf8",
		},
	);

	const problems = textsOf(parseJson(result.stdout));
	assert.ok(problems !== null, result.stderr);
	assert.equal(result.status, problems.length === 0 ? 0 : 1);

	return problems;
}

function lastTimestamp(root: string): string {
	const rows = readFileSync(join(root, file), "utf8").trimEnd().split("\n");

	return rows.at(-1)?.split("\t")[0] ?? "";
}

function rowCount(root: string): number {
	return readFileSync(join(root, file), "utf8").trimEnd().split("\n").length;
}

function decisionsSuite(withAppendedRow: boolean): void {
	const scratch = (): string => {
		const root = copyRepo();

		if (withAppendedRow) appendLoggedRow(root);

		return root;
	};

	it("passes the committed log", () => {
		assert.deepEqual(check(scratch()), []);
	});

	it("passes a valid appended row", () => {
		const root = scratch();
		const ts = lastTimestamp(root);
		appendFileSync(
			join(root, file),
			`${ts}\tphase\tdecision\twhy\tevidence\tresult\n`,
		);

		assert.deepEqual(check(root), []);
	});

	it("fails a truncated row", () => {
		const root = scratch();
		const ts = lastTimestamp(root);
		appendFileSync(join(root, file), `${ts}\tphase\tdecision\n`);

		assert.deepEqual(check(root), [
			`${file}:${rowCount(root)} has 3 cells, expected 6`,
		]);
	});

	it("fails a changed byte in the committed prefix", () => {
		const root = scratch();
		const bytes = readFileSync(join(root, file));
		const at = bytes.indexOf("\n") + 1;
		bytes[at] = bytes[at] === 0x31 ? 0x32 : 0x31;
		writeFileSync(join(root, file), bytes);

		const problems = check(root);
		assert.ok(
			problems.includes(
				`${file}: the first ${checkpointBytes(root)} bytes changed; recorded rows are append-only`,
			),
			problems.join("\n"),
		);
	});

	it("fails a deleted historical row even when the rest is well formed", () => {
		const root = scratch();
		const lines = readFileSync(join(root, file), "utf8").split("\n");
		lines.splice(1, 1);
		writeFileSync(join(root, file), lines.join("\n"));

		assert.match(
			check(root)[0] ?? "",
			/bytes changed; recorded rows are append-only$/,
		);
	});

	it("fails a bad header, timestamp, order, empty cell, formula cell and missing newline", () => {
		const root = scratch();
		const ts = lastTimestamp(root);
		const text = readFileSync(join(root, file), "utf8");

		const appended = [
			"2026-13-01T00:00:00Z\ta\tb\tc\td\te",
			"2026-01-01T00:00:00Z\ta\tb\tc\td\te",
			`${ts}\ta\t\tc\td\te`,
			`${ts}\ta\t=SUM(A1)\tc\td\te`,
		];

		const base = rowCount(root);
		writeFileSync(join(root, file), `${text}${appended.join("\n")}`);

		assert.deepEqual(check(root), [
			`${file}: does not end with a newline`,
			`${file}:${base + 1} has an invalid timestamp "2026-13-01T00:00:00Z"`,
			`${file}:${base + 2} timestamp 2026-01-01T00:00:00Z is earlier than ${ts}`,
			`${file}:${base + 3} column 3 is empty`,
			`${file}:${base + 4} column 3 starts with a spreadsheet formula character`,
		]);

		const header = scratch();
		const bytes = readFileSync(join(header, file), "utf8");
		writeFileSync(join(header, file), bytes.replace("ts\tphase", "ts\tstage"));
		assert.ok(
			check(header).some((p) => p.startsWith(`${file}:1 header is not`)),
		);
	});
}

describe("decisions guard", () => decisionsSuite(false));

describe("decisions guard after a log.sh-style appended row", () =>
	decisionsSuite(true));
