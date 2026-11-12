import type { JsonValue } from "../core/json.ts";
import type { NonEmpty } from "../core/run.ts";
import { ACCEPTANCE_SUITE_PREFIX } from "../trust/protected-paths.ts";
import {
	type Cite,
	type ContractDraft,
	type Evidence,
	type JsonObject,
	LINE_MAX,
	type MalformedReason,
	MAX_BEHAVIOR,
	MAX_CITE_SPAN,
	MAX_CITES,
	MAX_CRITERIA,
	MAX_EVIDENCE,
	MAX_FILES,
	MAX_LIST,
	MAX_QUESTIONS,
	OUTPUT_MAX_BYTES,
	type Question,
	type SpecifyOutput,
} from "./contract.ts";

export function hasControl(text: string): boolean {
	for (const char of text) {
		const code = char.codePointAt(0) ?? 0;

		if (
			code <= 0x1f ||
			(code >= 0x7f && code <= 0x9f) ||
			/\p{Cf}/u.test(char) ||
			/[\u034f\u115f\u2800\u3164]/u.test(char) ||
			code === 0x2028 ||
			code === 0x2029
		) {
			return true;
		}
	}

	return false;
}

const PATH = /^[A-Za-z0-9._-]+(?:\/[A-Za-z0-9._-]+)*$/;

function objectOf(value: JsonValue | undefined): JsonObject | null {
	if (
		value === undefined ||
		value === null ||
		Array.isArray(value) ||
		!(value instanceof Object)
	) {
		return null;
	}

	return value;
}

function parseJson(text: string): JsonValue | undefined {
	try {
		const parsed: JsonValue = JSON.parse(text);

		return parsed;
	} catch {
		return undefined;
	}
}

function fieldOf(value: JsonObject, key: string): JsonValue | undefined {
	return Object.hasOwn(value, key) ? value[key] : undefined;
}

function textOf(value: JsonValue | undefined): string | null {
	if (value === undefined) return null;

	const text = String(value);

	return value === text ? text : null;
}

function countOf(value: JsonValue | undefined): number | null {
	if (value === undefined) return null;

	const count = Number(value);

	return value === count && Number.isSafeInteger(count) && count >= 1
		? count
		: null;
}

export function lineOf(value: JsonValue | undefined): string | null {
	const text = textOf(value)?.trim() ?? null;

	if (text === null || text === "" || hasControl(text)) return null;

	return [...text].length <= LINE_MAX ? text : null;
}

export function isRepoPath(path: string): boolean {
	return (
		path.length <= 200 &&
		PATH.test(path) &&
		path.split("/").every((part) => part !== "." && part !== "..")
	);
}

class Malformed extends Error {
	readonly reason: MalformedReason;

	constructor(reason: MalformedReason) {
		super(reason);
		this.reason = reason;
	}
}

function reject(reason: MalformedReason): never {
	throw new Malformed(reason);
}

function only(value: JsonObject, keys: readonly string[]): JsonObject {
	if (!Object.keys(value).every((key) => keys.includes(key))) {
		reject("unknown_key");
	}

	return value;
}

function listOf(
	value: JsonValue | undefined,
	min: number,
	max: number,
): readonly JsonValue[] {
	const items = value === undefined ? [] : value;

	if (!Array.isArray(items) || items.length < min || items.length > max) {
		reject("bad_field");
	}

	return items;
}

function linesOf(
	value: JsonValue | undefined,
	min: number,
	max: number,
): string[] {
	return listOf(value, min, max).map(
		(item) => lineOf(item) ?? reject("bad_field"),
	);
}

function nonEmpty<T>(items: readonly T[]): NonEmpty<T> {
	const [first, ...rest] = items;

	return first === undefined ? reject("bad_field") : [first, ...rest];
}

function citeOf(value: JsonValue, files: ReadonlySet<string>): Cite {
	const cite = only(objectOf(value) ?? reject("bad_field"), [
		"path",
		"start",
		"end",
		"fact",
	]);

	const path = textOf(fieldOf(cite, "path"));
	const start = countOf(fieldOf(cite, "start"));
	const end = countOf(fieldOf(cite, "end")) ?? start;

	if (
		path === null ||
		!isRepoPath(path) ||
		start === null ||
		end === null ||
		end < start ||
		end - start > MAX_CITE_SPAN
	) {
		return reject("bad_field");
	}

	if (!files.has(path)) reject("unknown_path");

	return { path, start, end };
}

function evidenceOf(value: JsonValue, files: ReadonlySet<string>): Evidence {
	const fact = lineOf(fieldOf(objectOf(value) ?? reject("bad_field"), "fact"));

	return { ...citeOf(value, files), fact: fact ?? reject("bad_field") };
}

function contractOf(
	value: JsonObject,
	files: ReadonlySet<string>,
): ContractDraft {
	only(value, [
		"kind",
		"summary",
		"behavior",
		"exclusions",
		"acceptance",
		"compatibility",
		"limits",
		"files",
		"evidence",
		"replacesTests",
	]);

	const replacements = fieldOf(value, "replacesTests");

	const replacesTests = listOf(replacements, 0, MAX_FILES).map((item) => {
		const entry = only(objectOf(item) ?? reject("bad_field"), [
			"path",
			"reason",
		]);

		const path = lineOf(fieldOf(entry, "path")) ?? reject("bad_field");
		const reason = lineOf(fieldOf(entry, "reason")) ?? reject("bad_field");

		if (
			!isRepoPath(path) ||
			!path.startsWith("test/") ||
			path.startsWith(ACCEPTANCE_SUITE_PREFIX) ||
			!/\.(?:test|cases)\.[cm]?[jt]s$/.test(path)
		)
			reject("bad_field");

		if (!files.has(path)) reject("unknown_path");

		return { path, reason };
	});

	if (
		new Set(replacesTests.map((entry) => entry.path)).size !==
		replacesTests.length
	)
		reject("bad_field");

	const paths = linesOf(fieldOf(value, "files"), 0, MAX_FILES);

	if (!paths.every(isRepoPath)) reject("bad_field");

	const draft: ContractDraft = {
		summary: lineOf(fieldOf(value, "summary")) ?? reject("bad_field"),
		behavior: nonEmpty(linesOf(fieldOf(value, "behavior"), 1, MAX_BEHAVIOR)),
		exclusions: linesOf(fieldOf(value, "exclusions"), 0, MAX_LIST),
		acceptance: nonEmpty(
			listOf(fieldOf(value, "acceptance"), 1, MAX_CRITERIA).map(
				(item, index) => {
					const criterion = only(objectOf(item) ?? reject("bad_field"), [
						"kind",
						"text",
					]);

					const kind = fieldOf(criterion, "kind");

					if (kind !== "new_behavior" && kind !== "preservation")
						return reject("bad_field");

					return {
						id: `A${index + 1}`,
						kind,
						text: lineOf(fieldOf(criterion, "text")) ?? reject("bad_field"),
					};
				},
			),
		),
		compatibility: linesOf(fieldOf(value, "compatibility"), 0, MAX_LIST),
		limits: linesOf(fieldOf(value, "limits"), 0, MAX_LIST),
		files: [...new Set(paths)],
		evidence: listOf(fieldOf(value, "evidence"), 0, MAX_EVIDENCE).map((item) =>
			evidenceOf(item, files),
		),
	};

	return replacements === undefined ? draft : { ...draft, replacesTests };
}

function questionsOf(
	value: JsonObject,
	files: ReadonlySet<string>,
): NonEmpty<Question> {
	only(value, ["kind", "questions"]);

	const seen = new Set<string>();
	const questions: Question[] = [];

	for (const item of listOf(fieldOf(value, "questions"), 1, MAX_QUESTIONS)) {
		const question = only(objectOf(item) ?? reject("bad_field"), [
			"text",
			"cites",
		]);

		const text = lineOf(fieldOf(question, "text")) ?? reject("bad_field");

		const cites = listOf(fieldOf(question, "cites"), 0, MAX_CITES).map(
			(cite) => {
				const parsed = citeOf(cite, files);

				return {
					path: parsed.path,
					start: parsed.start,
					end: parsed.end,
				};
			},
		);

		const key = text.toLowerCase().replace(/\s+/g, " ");

		if (seen.has(key)) continue;

		seen.add(key);
		questions.push({ text, cites });
	}

	return nonEmpty(questions);
}

function unfenced(text: string): string {
	const trimmed = text.trim();
	const fence = /^```(?:json)?\n([\s\S]*)\n```$/.exec(trimmed);

	return (fence?.[1] ?? trimmed).trim();
}

/**
 * True when some object in already-valid JSON text names one key twice.
 * `JSON.parse` keeps the last duplicate, so a validated output has none.
 */
function hasDuplicateKey(text: string): boolean {
	const scopes: (Set<string> | null)[] = [];
	let expectKey = false;
	let at = 0;

	while (at < text.length) {
		const char = text[at];

		if (char === '"') {
			let end = at + 1;

			while (end < text.length && text[end] !== '"') {
				end += text[end] === "\\" ? 2 : 1;
			}

			const keys = scopes.at(-1);

			if (expectKey && keys instanceof Set) {
				const key = textOf(parseJson(text.slice(at, end + 1))) ?? "";

				if (keys.has(key)) return true;

				keys.add(key);
				expectKey = false;
			}

			at = end + 1;
			continue;
		}

		if (char === "{") {
			scopes.push(new Set());
			expectKey = true;
		} else if (char === "[") {
			scopes.push(null);
			expectKey = false;
		} else if (char === "}" || char === "]") {
			scopes.pop();
			expectKey = false;
		} else if (char === ",") {
			expectKey = scopes.at(-1) instanceof Set;
		}

		at += 1;
	}

	return false;
}

/**
 * Validates specify's final text against the output schema. The text is
 * one JSON object, optionally in a single fenced block. `files` is the
 * checkout's file list: every cited path must be in it.
 */
export function parseSpecifyOutput(
	text: string,
	files: ReadonlySet<string>,
): SpecifyOutput {
	if (Buffer.byteLength(text, "utf8") > OUTPUT_MAX_BYTES) {
		return { kind: "malformed", reason: "too_large" };
	}

	const body = unfenced(text);

	if (body === "") return { kind: "malformed", reason: "empty" };

	const value = objectOf(parseJson(body));

	if (value === null) return { kind: "malformed", reason: "not_json" };

	if (hasDuplicateKey(body)) {
		return { kind: "malformed", reason: "duplicate_key" };
	}

	try {
		const kind = textOf(fieldOf(value, "kind"));

		if (kind === "contract") {
			return { kind, draft: contractOf(value, files) };
		}

		if (kind === "questions") {
			return { kind, questions: questionsOf(value, files) };
		}

		return { kind: "malformed", reason: "bad_kind" };
	} catch (error) {
		if (error instanceof Malformed) {
			return { kind: "malformed", reason: error.reason };
		}

		throw error;
	}
}

export function parseReviewOutput(text: string): readonly string[] | null {
	try {
		if (Buffer.byteLength(text) > OUTPUT_MAX_BYTES) return null;
		const raw = unfenced(text);
		const value = objectOf(parseJson(raw));

		if (value === null || hasDuplicateKey(raw)) return null;
		const kind = fieldOf(value, "kind");

		if (kind === "no_finding") {
			only(value, ["kind"]);

			return [];
		}

		if (kind !== "ambiguities") return null;
		only(value, ["kind", "ambiguities"]);

		return linesOf(fieldOf(value, "ambiguities"), 1, 3);
	} catch (error) {
		if (error instanceof Malformed) return null;
		throw error;
	}
}
