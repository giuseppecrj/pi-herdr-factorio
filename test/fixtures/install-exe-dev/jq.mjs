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
const input = JSON.parse(readFileSync(args.shift() ?? 0, "utf8"));

if (args.length !== 0) throw new Error("unexpected fixture jq arguments");

const held = (tick) =>
	tick?.at > vars.get("after") &&
	tick?.dispatch?.enabled === false &&
	Array.isArray(tick?.dispatch?.reasons) &&
	tick.dispatch.reasons.includes("locally_disabled");

let result;

switch (filter) {
	case ".full_name == $repo":
		result = input.full_name === vars.get("repo");
		break;
	case '.data | type == "array" and length > 0':
		result = Array.isArray(input.data) && input.data.length > 0;
		break;
	case '.controller.state == "running" and .controller.lastTick.at > $after and .controller.lastTick.dispatch.enabled == false and (.controller.lastTick.dispatch.reasons | index("locally_disabled") != null)':
		result =
			input.controller?.state === "running" && held(input.controller?.lastTick);
		break;
	case "{dispatch: .controller.lastTick.dispatch}":
		result = { dispatch: input.controller?.lastTick?.dispatch ?? null };
		break;
	case '.at > $after and .dispatch.enabled == false and (.dispatch.reasons | index("locally_disabled") != null)':
		result = held(input);
		break;
	case ".platform.repositories | index($repo) != null":
		result =
			Array.isArray(input.platform?.repositories) &&
			input.platform.repositories.includes(vars.get("repo"));
		break;
	default:
		throw new Error(`unsupported fixture jq filter: ${filter}`);
}

console.log(JSON.stringify(result));

if (exitStatus && (result === false || result === null)) process.exit(1);
