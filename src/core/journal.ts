import {
	countOf,
	fieldOf,
	objectOf,
	parseJson,
	textOf,
	type JsonValue,
} from "./json.ts";

export type RequestBound = {
	readonly inputTokens: number;
	readonly maxOutputTokens: number;
};

export type RequestUsage =
	| {
			readonly kind: "metered";
			readonly inputTokens: number;
			readonly outputTokens: number;
	  }
	| {
			readonly kind: "partial";
			readonly inputTokens: number;
			readonly outputTokens: null;
	  }
	| {
			readonly kind: "partial";
			readonly inputTokens: null;
			readonly outputTokens: number;
	  }
	| {
			readonly kind: "missing";
			readonly inputTokens: null;
			readonly outputTokens: null;
	  };

type ReplyFacts = {
	readonly status: number | null;
	readonly observedModel: JsonValue | undefined;
};

/** Normalized result facts, including legacy partial measurements. */
export type RequestReply = ReplyFacts &
	(
		| {
				readonly kind: "Unreachable";
				readonly origin: "gateway-before-headers";
				readonly usage: RequestUsage;
		  }
		| {
				readonly kind: "ProviderRejected";
				readonly completed: true;
				readonly usage: RequestUsage;
		  }
		| {
				readonly kind: "Metered";
				readonly usage: Extract<RequestUsage, { readonly kind: "metered" }>;
		  }
		| {
				readonly kind: "Unmetered";
				readonly reason: "missing-usage" | "partial-usage";
				readonly usage: Exclude<RequestUsage, { readonly kind: "metered" }>;
		  }
	);

type RequestFacts = {
	readonly req: number | null;
	readonly route: string | null;
	/** Retained only for the usability veto, which historically examines every result. */
	readonly laterResults: readonly RequestReply[];
};

/** One request's observation, independent of charging or family assurance policy. */
export type RequestSettlement = RequestFacts &
	(
		| { readonly kind: "Admitted"; readonly bound: null }
		| { readonly kind: "Dispatched"; readonly bound: RequestBound }
		| (RequestReply & { readonly bound: RequestBound | null })
		| {
				readonly kind: "Uncertain";
				readonly bound: RequestBound;
				readonly result: (RequestReply & { readonly kind: "Unmetered" }) | null;
		  }
	);

/** The first result, also when an unmetered reply retains an uncertain bound. */
export function settlementReply(
	request: RequestSettlement,
): RequestReply | null {
	switch (request.kind) {
		case "Admitted":
		case "Dispatched":
			return null;
		case "Uncertain":
			return request.result;
		default:
			return request;
	}
}

function requestUsage(
	inputTokens: number | null,
	outputTokens: number | null,
): RequestUsage {
	if (inputTokens !== null)
		return outputTokens !== null
			? { kind: "metered", inputTokens, outputTokens }
			: { kind: "partial", inputTokens, outputTokens };

	return outputTokens !== null
		? { kind: "partial", inputTokens, outputTokens }
		: { kind: "missing", inputTokens, outputTokens };
}

/**
 * Replays v1 bytes without changing their acceptance rules. Request numbers are
 * local to one gateway journal. Optional route scoping retains the family
 * reader's per-route identity while charging uses the whole journal.
 * First dispatch/result wins for charging and family; all later results remain
 * available to the conservative usability veto. Results stay in arrival order.
 * `Admitted` has only an identity observation, not proof of durable dispatch.
 */
export function requestSettlements(
	text: string,
	options: { readonly route?: string; readonly stopped?: boolean } = {},
) {
	type Replay = {
		req: number | null;
		route: string | null;
		bound: RequestBound | null;
		results: RequestReply[];
		order: number;
	};

	const requests = new Map<number | symbol, Replay>();
	const routes = new Set<string>();
	let order = 0;

	for (const line of text.split("\n")) {
		const record = objectOf(parseJson(line));
		const req = countOf(fieldOf(record, "req"));
		const route = textOf(fieldOf(record, "route"));
		const kind = fieldOf(record, "kind");

		if (record === null) continue;

		if (req !== null && route !== null) routes.add(route);

		if (options.route !== undefined && route !== options.route) continue;

		// A legacy result without a request number can prove metered presence,
		// but cannot contribute a charge, a veto or family evidence.
		if (req === null && kind !== "result") continue;

		const key = req ?? Symbol();

		const replay = requests.get(key) ?? {
			req,
			route,
			bound: null,
			results: [],
			order: Number.MAX_SAFE_INTEGER,
		};

		requests.set(key, replay);

		if (kind === "dispatch" && replay.bound === null) {
			replay.bound = {
				inputTokens: countOf(fieldOf(record, "inputTokenEstimate")) ?? 0,
				maxOutputTokens: countOf(fieldOf(record, "maxOutputTokens")) ?? 0,
			};
		}

		if (kind !== "result") continue;

		const usage = requestUsage(
			countOf(fieldOf(record, "inputTokens")),
			countOf(fieldOf(record, "outputTokens")),
		);

		const facts: ReplyFacts = {
			status: countOf(fieldOf(record, "status")),
			observedModel: fieldOf(record, "observedModel"),
		};

		const reason = fieldOf(record, "reason");

		const reply: RequestReply =
			reason === "upstream_unreachable"
				? {
						...facts,
						kind: "Unreachable",
						origin: "gateway-before-headers",
						usage,
					}
				: reason === "provider_rejected"
					? { ...facts, kind: "ProviderRejected", completed: true, usage }
					: usage.kind === "metered"
						? { ...facts, kind: "Metered", usage }
						: {
								...facts,
								kind: "Unmetered",
								usage,
								reason:
									usage.kind === "missing" ? "missing-usage" : "partial-usage",
							};

		if (replay.results.length === 0) replay.order = order++;

		replay.results.push(reply);
	}

	return {
		routes: [...routes],
		requests: [...requests.values()]
			.sort((a, b) => a.order - b.order)
			.map((replay): RequestSettlement => {
				const [result, ...laterResults] = replay.results;
				const { req, route, bound } = replay;
				const facts = { req, route, bound, laterResults };

				if (result !== undefined) {
					if (
						result.kind === "Unmetered" &&
						result.usage.kind === "missing" &&
						bound !== null &&
						bound.inputTokens + bound.maxOutputTokens > 0
					)
						return { ...facts, kind: "Uncertain", bound, result };

					return { ...facts, ...result };
				}

				if (bound === null) return { ...facts, kind: "Admitted", bound };

				return options.stopped === false
					? { ...facts, kind: "Dispatched", bound }
					: { ...facts, kind: "Uncertain", bound, result: null };
			}),
	};
}

export type JournalCharge = {
	readonly tokens: number;
	readonly dispatched: number;
	readonly settled: number;
	readonly unmetered: number;
	readonly uncertain: number;
	readonly uncertainTokens: number;
};

/**
 * What a journal proves: metered tokens of each settled request, once per
 * request number. A provider-rejected result that completed is charged its reported usage, or a known zero. A dispatch with
 * no result, or with an unmetered result and a positive recorded bound, is an
 * uncertain charge, so the tokens retain the recorded input-plus-output bound
 * separately. Legacy dispatches without a bound remain a floor. A line cut
 * short by a crash is skipped.
 */
export function journalCharge(text: string): JournalCharge {
	const charge = {
		tokens: 0,
		dispatched: 0,
		settled: 0,
		unmetered: 0,
		uncertain: 0,
		uncertainTokens: 0,
	};

	for (const request of requestSettlements(text).requests) {
		if (request.req === null) continue;

		const result = settlementReply(request);
		const bound = request.bound;

		const upper =
			bound === null ? 0 : bound.inputTokens + bound.maxOutputTokens;

		if (bound !== null) charge.dispatched += 1;

		if (result !== null) {
			charge.settled += 1;
			charge.tokens +=
				(result.usage.inputTokens ?? 0) + (result.usage.outputTokens ?? 0);

			if (result.usage.kind === "missing") charge.unmetered += 1;
		}

		if (
			bound !== null &&
			(result === null || (result.usage.kind === "missing" && upper > 0))
		) {
			charge.uncertain += 1;
			charge.uncertainTokens += upper;
		}
	}

	return charge;
}
