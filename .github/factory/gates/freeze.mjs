import assert from "node:assert";
import strict from "node:assert/strict";
import test from "node:test";
import * as tests from "node:test";
import { syncBuiltinESMExports } from "node:module";
import { writeSync } from "node:fs";

function freeze(value, seen = new Set()) {
	if (!(value instanceof Object) || seen.has(value)) return;
	seen.add(value);

	for (const key of Reflect.ownKeys(value)) {
		const descriptor = Object.getOwnPropertyDescriptor(value, key);

		if (descriptor && "value" in descriptor) freeze(descriptor.value, seen);
	}

	Object.freeze(value);
}

for (const value of [assert, strict, test, ...Object.values(tests)]) freeze(value);

syncBuiltinESMExports();

const reallyExit = process.reallyExit.bind(process);
const reject = () => { writeSync(2, "GATE_VIOLATION: early process exit\n"); reallyExit(86); };

for (const key of ["exit", "reallyExit"]) Object.defineProperty(process, key, { value: reject, writable: false, configurable: false });
