import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const HEADER = "ts\tphase\tdecision\twhy\tevidence\tresult";
const TIMESTAMP = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/;
const FORMULA = /^[=+@-]/;

function checkpointOf(root) {
	const path = "scripts/decisions-checkpoint.json";

	try {
		return JSON.parse(readFileSync(join(root, path), "utf8"));
	} catch (error) {
		throw new Error(`${path} is unreadable: ${error.message}`);
	}
}

function isTimestamp(ts) {
	const time = Date.parse(ts);

	return (
		TIMESTAMP.test(ts) &&
		!Number.isNaN(time) &&
		new Date(time).toISOString().replace(".000Z", "Z") === ts
	);
}

function checkPrefix(checkpoint, bytes) {
	const prefix = bytes.subarray(0, checkpoint.bytes);
	const digest = createHash("sha256").update(prefix).digest("hex");

	if (bytes.length < checkpoint.bytes || digest !== checkpoint.sha256)
		return [
			`${checkpoint.file}: the first ${checkpoint.bytes} bytes changed; recorded rows are append-only`,
		];

	if (prefix.at(-1) !== 0x0a)
		return [
			`${checkpoint.file}: the checkpoint does not end at a row boundary`,
		];

	const rows = prefix.toString("utf8").split("\n").length - 2;

	return rows === checkpoint.rows
		? []
		: [
				`${checkpoint.file}: the checkpoint prefix holds ${rows} rows, but the checkpoint records ${checkpoint.rows}`,
			];
}

function checkRows(file, lines) {
	const problems = [];
	let previous = "";

	for (let i = 1; i < lines.length; i++) {
		const where = `${file}:${i + 1}`;
		const cells = lines[i].split("\t");

		if (cells.length !== 6) {
			problems.push(`${where} has ${cells.length} cells, expected 6`);
			continue;
		}

		const [ts, ...rest] = cells;

		if (!isTimestamp(ts))
			problems.push(`${where} has an invalid timestamp ${JSON.stringify(ts)}`);
		else if (ts < previous)
			problems.push(`${where} timestamp ${ts} is earlier than ${previous}`);
		else previous = ts;

		rest.forEach((cell, column) => {
			if (cell === "") problems.push(`${where} column ${column + 2} is empty`);
			else if (FORMULA.test(cell))
				problems.push(
					`${where} column ${column + 2} starts with a spreadsheet formula character`,
				);
		});
	}

	return problems;
}

export function checkDecisions(root) {
	const checkpoint = checkpointOf(root);
	let bytes;

	try {
		bytes = readFileSync(join(root, checkpoint.file));
	} catch {
		return [`${checkpoint.file} is missing`];
	}

	const problems = checkPrefix(checkpoint, bytes);
	const text = bytes.toString("utf8");

	if (text.includes("\r"))
		problems.push(`${checkpoint.file}: contains a carriage return`);

	if (!text.endsWith("\n"))
		problems.push(`${checkpoint.file}: does not end with a newline`);

	const lines = text.split("\n");

	if (lines.at(-1) === "") lines.pop();

	if (lines[0] !== HEADER)
		problems.push(
			`${checkpoint.file}:1 header is not ${JSON.stringify(HEADER)}`,
		);

	return [...problems, ...checkRows(checkpoint.file, lines)];
}

function main(argv) {
	let root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
	let json = false;

	for (let i = 0; i < argv.length; i++) {
		if (argv[i] === "--root") root = resolve(argv[++i] ?? "");
		else if (argv[i] === "--json") json = true;
		else {
			process.stderr.write(
				"usage: node scripts/check-decisions.mjs [--root DIR] [--json]\n",
			);
			process.exit(2);
		}
	}

	const problems = checkDecisions(root);

	if (json) process.stdout.write(`${JSON.stringify(problems)}\n`);
	else for (const problem of problems) process.stderr.write(`${problem}\n`);

	if (problems.length > 0) process.exit(1);
}

if (import.meta.main) main(process.argv.slice(2));
