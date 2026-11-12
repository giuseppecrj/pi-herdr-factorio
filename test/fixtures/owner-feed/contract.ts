import { ATTENTION_KINDS } from "../../../src/attention.ts";
import type { JsonValue } from "../../../src/core/json.ts";
import { objectOf } from "../../../src/core/json.ts";

/**
 * The OwnerFeed v1 fields a client may rely on, with the JSON type of each.
 * Adding a field to the feed is allowed within v1 and needs no change here.
 * Removing a field, changing its type, or changing `version` must fail
 * `v1Problems`.
 */
type Leaf =
	| "string"
	| "number"
	| "boolean"
	| "array"
	| "object"
	| "string|null"
	| "number|null"
	| "object|null";

type FieldTypes = Readonly<Record<string, Leaf>>;

const FEED = {
	repo: "string|null",
	at: "number",
	controller: "object",
	entries: "array",
	counts: "object",
	workingRunCount: "number",
	durableUsage: "object",
	unreadable: "array",
	gaps: "array",
	metrics: "object",
} satisfies FieldTypes;

const CONTROLLER = {
	state: "string",
	lastTick: "string|null",
	localSwitch: "string",
} satisfies FieldTypes;

function countTypes(): FieldTypes {
	return Object.fromEntries(
		ATTENTION_KINDS.map((kind) => [kind, "number" satisfies Leaf]),
	);
}

const DURABLE_USAGE = {
	kind: "string",
	total: "number|null",
} satisfies FieldTypes;

const METRICS = {
	computedAt: "string|null",
	stale: "boolean",
	status: "string",
	share: "number|null",
	numerator: "number|null",
	denominator: "number|null",
	tokensPerCleanLanding: "number|null",
} satisfies FieldTypes;

const ENTRY = {
	issue: "number",
	eventId: "string",
	stage: "string",
	since: "number|null",
	terminal: "boolean",
	kind: "string|null",
	title: "string",
	status: "string",
	stale: "boolean",
	runId: "string",
	issueUrl: "string",
	prUrl: "string|null",
	ageMs: "number|null",
	reason: "string|null",
	group: "string",
	round: "number|null",
	tokens: "number|null",
	cap: "number|null",
	ci: "string",
	failure: "object|null",
	notProven: "array",
	steps: "array",
} satisfies FieldTypes;

const FAILURE = {
	stage: "string",
	class: "string",
	reason: "string",
} satisfies FieldTypes;

const STEP = {
	stage: "string",
	outcome: "string",
	wallMs: "number|null",
	tokens: "number|null",
} satisfies FieldTypes;

const UNREADABLE = {
	issue: "number",
	issueUrl: "string",
	reason: "string",
} satisfies FieldTypes;

function kindOf(value: JsonValue | undefined): string {
	if (value === null) return "null";

	if (Array.isArray(value)) return "array";

	if (value === String(value)) return "string";

	if (value === Number(value)) return "number";

	if (value === true || value === false) return "boolean";

	return objectOf(value) === null ? "undefined" : "object";
}

function fieldProblems(
	value: JsonValue | undefined,
	types: FieldTypes,
	path: string,
): string[] {
	const object = objectOf(value);

	if (object === null) return [`${path} is not an object`];

	return Object.entries(types).flatMap(([key, leaf]) => {
		if (!(key in object)) return [`${path}.${key} is missing`];
		const actual = kindOf(object[key]);

		return leaf.split("|").includes(actual)
			? []
			: [`${path}.${key} is ${actual}, expected ${leaf}`];
	});
}

function itemsOf(value: JsonValue | undefined): JsonValue[] {
	return Array.isArray(value) ? value : [];
}

/** Returns every way `feed` fails to be an OwnerFeed v1. Empty means valid. */
export function v1Problems(feed: JsonValue): string[] {
	const object = objectOf(feed);

	if (object === null) return ["feed is not an object"];

	return [
		...(object.version === 1
			? []
			: [`version is ${JSON.stringify(object.version)}`]),
		...fieldProblems(feed, FEED, "feed"),
		...fieldProblems(object.controller, CONTROLLER, "controller"),
		...fieldProblems(object.counts, countTypes(), "counts"),
		...fieldProblems(object.durableUsage, DURABLE_USAGE, "durableUsage"),
		...fieldProblems(object.metrics, METRICS, "metrics"),
		...itemsOf(object.entries).flatMap((entry, index) => {
			const failure = objectOf(entry)?.failure;

			return [
				...fieldProblems(entry, ENTRY, `entries[${index}]`),
				...(failure === null || failure === undefined
					? []
					: fieldProblems(failure, FAILURE, `entries[${index}].failure`)),
				...itemsOf(objectOf(entry)?.steps).flatMap((step, at) =>
					fieldProblems(step, STEP, `entries[${index}].steps[${at}]`),
				),
			];
		}),
		...itemsOf(object.unreadable).flatMap((item, index) =>
			fieldProblems(item, UNREADABLE, `unreadable[${index}]`),
		),
	];
}
