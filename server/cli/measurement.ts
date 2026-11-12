import {
	measurementInputOf,
	type MeasurementInput,
} from "../../src/views/explain.ts";
import type { Digest } from "../../src/core/run.ts";
import { readStageReceipt } from "../sandbox/receipts.ts";

export function measurementInput(
	stateDir: string,
	runId: Digest,
	includeChildren = false,
	includeContract = false,
): Promise<MeasurementInput> {
	return measurementInputOf(
		readStageReceipt,
		stateDir,
		runId,
		includeChildren,
		includeContract,
	);
}
