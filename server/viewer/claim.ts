import type { ClaimRecord } from "../../src/orchestrator.ts";
import { isRunStatus, isStage } from "../../src/markers.ts";
import { isDigest } from "../../src/run.ts";
import { parseValidationState } from "../../src/validation.ts";
import {
	countOf,
	fieldOf,
	objectOf,
	parseJson,
	textOf,
} from "../sandbox/json.ts";

export function viewerClaim(text: string, runId: string): ClaimRecord | null {
	const value = objectOf(parseJson(text));
	const id = textOf(fieldOf(value, "runId"));
	const issue = countOf(fieldOf(value, "issue"));
	const eventId = textOf(fieldOf(value, "eventId"));
	const stage = textOf(fieldOf(value, "stage"));
	const status = textOf(fieldOf(value, "status"));
	const attempt = countOf(fieldOf(value, "attempt"));
	const seq = countOf(fieldOf(value, "seq"));
	const usage = countOf(fieldOf(value, "usage"));
	const validationValue = fieldOf(value, "validation");

	const validation =
		validationValue === undefined
			? undefined
			: parseValidationState(validationValue);

	if (
		id === null ||
		!isDigest(id) ||
		id !== runId ||
		issue === null ||
		issue < 1 ||
		eventId === null ||
		!/^[1-9][0-9]{0,19}$/.test(eventId) ||
		validation === null
	)
		return null;

	if (
		stage === null &&
		status === null &&
		attempt === null &&
		seq === null &&
		usage === null
	)
		return { runId: id, issue, eventId, stage, status, attempt, seq, usage };

	if (
		stage === null ||
		!isStage(stage) ||
		status === null ||
		!isRunStatus(status) ||
		attempt === null ||
		attempt < 1 ||
		seq === null ||
		usage === null
	)
		return null;

	const claim: ClaimRecord = {
		runId: id,
		issue,
		eventId,
		stage,
		status,
		attempt,
		seq,
		usage,
	};

	return validation === undefined
		? claim
		: { ...claim, validation, round: validation.round };
}
