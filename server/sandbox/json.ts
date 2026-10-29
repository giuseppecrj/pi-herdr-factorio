import type { JsonValue } from "../../src/tickets.ts";

export type { JsonValue } from "../../src/tickets.ts";

export type JsonObject = { readonly [key: string]: JsonValue };

/** Parses JSON text at an I/O boundary. Invalid text is `undefined`, never a throw. */
export function parseJson(text: string): JsonValue | undefined {
	try {
		const parsed: JsonValue = JSON.parse(text);

		return parsed;
	} catch {
		return undefined;
	}
}

export function objectOf(value: JsonValue | undefined): JsonObject | null {
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

export function arrayOf(
	value: JsonValue | undefined,
): readonly JsonValue[] | null {
	return Array.isArray(value) ? value : null;
}

export function fieldOf(
	value: JsonObject | null,
	key: string,
): JsonValue | undefined {
	return value !== null && Object.hasOwn(value, key) ? value[key] : undefined;
}

export function textOf(value: JsonValue | undefined): string | null {
	if (value === undefined) return null;

	const text = String(value);

	return value === text ? text : null;
}

export function numberOf(value: JsonValue | undefined): number | null {
	if (value === undefined) return null;

	const number = Number(value);

	return value === number && Number.isFinite(number) ? number : null;
}

export function countOf(value: JsonValue | undefined): number | null {
	const number = numberOf(value);

	return number !== null && Number.isSafeInteger(number) && number >= 0
		? number
		: null;
}

export function boolOf(value: JsonValue | undefined): boolean | null {
	return value === true || value === false ? value : null;
}

/** True when every key of `value` is in `allowed`. Unknown keys reject the record. */
export function hasOnlyKeys(
	value: JsonObject,
	allowed: readonly string[],
): boolean {
	return Object.keys(value).every((key) => allowed.includes(key));
}

export function textsOf(value: JsonValue | undefined): string[] | null {
	const items = arrayOf(value);

	if (items === null) return null;

	const texts: string[] = [];

	for (const item of items) {
		const text = textOf(item);

		if (text === null) return null;

		texts.push(text);
	}

	return texts;
}
