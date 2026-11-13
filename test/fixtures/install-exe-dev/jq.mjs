import { readFileSync } from "node:fs";

// Only the installer's JSON protocol, not a general jq interpreter. Unknown
// filters or flags fail so a changed installer cannot silently bypass a check.
const args = process.argv.slice(2);
const vars = new Map();
let exitStatus = false;

while (args[0]?.startsWith("-")) {
	const flag = args.shift();

	if (flag === "-e") exitStatus = true;
	else if (flag === "--arg") vars.set(args.shift(), args.shift());
	else throw new Error(`unsupported fixture jq flag: ${flag}`);
}

const filter = args.shift();
const text = readFileSync(args.shift() ?? 0, "utf8");

if (args.length !== 0) throw new Error("unexpected fixture jq arguments");

function* documents(text) {
	let start = 0;
	let depth = 0;
	let quoted = false;
	let escaped = false;

	for (let i = 0; i <= text.length; i++) {
		const char = text[i];

		if (!quoted && depth === 0 && (char === undefined || /\s/.test(char))) {
			if (i > start) yield JSON.parse(text.slice(start, i));
			start = i + 1;
		} else if (quoted) {
			if (escaped) escaped = false;
			else if (char === "\\") escaped = true;
			else if (char === '"') quoted = false;
		} else if (char === '"') quoted = true;
		else if (char === "{" || char === "[") depth++;
		else if (char === "}" || char === "]") {
			depth--;

			if (depth === 0) {
				yield JSON.parse(text.slice(start, i + 1));
				start = i + 1;
			}
		}
	}

	if (quoted || depth !== 0) throw new Error("incomplete JSON");
}

function field(input, key) {
	if (input === null || input === undefined) return null;

	if (!(input instanceof Object) || Array.isArray(input))
		throw new Error(`cannot index value with ${key}`);

	return input[key] ?? null;
}

const dispatchOf = (tick) => field(tick, "dispatch");

const held = (tick) => {
	const dispatch = dispatchOf(tick);
	const reasons = field(dispatch, "reasons");

	return (
		field(tick, "at") > vars.get("after") &&
		field(dispatch, "enabled") === false &&
		Array.isArray(reasons) &&
		reasons.includes("locally_disabled")
	);
};

function evaluate(input) {
	switch (filter) {
		case ".full_name == $repo":
			return field(input, "full_name") === vars.get("repo");
		case '.data | type == "array" and length > 0': {
			const data = field(input, "data");

			return Array.isArray(data) && data.length > 0;
		}

		case '.controller.state == "running" and .controller.lastTick.at > $after and .controller.lastTick.dispatch.enabled == false and (.controller.lastTick.dispatch.reasons | type == "array" and index("locally_disabled") != null)': {
			const controller = field(input, "controller");

			return (
				field(controller, "state") === "running" &&
				held(field(controller, "lastTick"))
			);
		}

		case "{dispatch: .controller.lastTick.dispatch}":
			return {
				dispatch: dispatchOf(field(field(input, "controller"), "lastTick")),
			};
		case '.at > $after and .dispatch.enabled == false and (.dispatch.reasons | type == "array" and index("locally_disabled") != null)':
			return held(input);
		case ".platform.repositories | index($repo) != null": {
			const repositories = field(field(input, "platform"), "repositories");

			return repositories !== null && repositories.includes(vars.get("repo"));
		}

		default:
			throw new Error(`unsupported fixture jq filter: ${filter}`);
	}
}

try {
	for (const input of documents(text)) {
		const result = evaluate(input);
		console.log(JSON.stringify(result, null, 2));
		process.exitCode =
			exitStatus && (result === false || result === null) ? 1 : 0;
	}
} catch (error) {
	console.error(String(error));
	process.exitCode = 5;
}
