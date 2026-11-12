import type { ClaimRecord } from "../../src/controller/claims.ts";
import { isRunStatus } from "../../src/trust/markers.ts";
import { isStage } from "../../src/core/stages.ts";
import { isDigest, runIdOf } from "../../src/core/run.ts";
import { parseCandidateState } from "../../src/candidate/codec.ts";
import { candidateUsage } from "../../src/candidate/handoff.ts";
import { parseMarker, MARKER_PREFIX } from "../../src/trust/markers.ts";
import { parseValidationState } from "../../src/candidate/validation.ts";
import {
	countOf,
	fieldOf,
	objectOf,
	parseJson,
	textOf,
} from "../../src/core/json.ts";

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

	const rawBook = fieldOf(value, "handoff");
	const book = parseCandidateState(rawBook);

	if (
		rawBook !== undefined &&
		(book === null ||
			book.pin.runId !== id ||
			book.pin.issue !== issue ||
			runIdOf({ repo: book.pin.repo, issue, eventId }) !== id ||
			usage !== candidateUsage(book))
	)
		return null;

	const rawMarker = fieldOf(value, "marker");

	const marker =
		rawMarker === undefined
			? null
			: parseMarker(`${MARKER_PREFIX}${JSON.stringify(rawMarker)} -->`);

	if (
		marker !== null &&
		(marker.kind !== "marker" ||
			marker.marker.runId !== id ||
			marker.marker.issue !== issue ||
			marker.marker.seq !== seq ||
			marker.marker.status !== status ||
			marker.marker.usage !== usage)
	)
		return null;

	const retained: ClaimRecord = {
		...claim,
		handoff: book ?? undefined,
		marker: marker?.kind === "marker" ? marker.marker : undefined,
	};

	const round = countOf(fieldOf(value, "round")) ?? validation?.round ?? 0;

	if (round > 2 || (validation !== undefined && round !== validation.round))
		return null;

	return validation === undefined
		? { ...retained, round }
		: { ...retained, validation, round };
}
