import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { decideAdmission, checkChangedPaths } from "../src/policy.ts";
import { outcomeOf, type Run } from "../src/run.ts";
import { advance, type RunEvent } from "../src/stages.ts";
import { type FactoryEvent, type Ticket, ticketKey } from "../src/tickets.ts";
import { FakeTicketAdapter } from "./fake-ticket-adapter.ts";
import {
	acceptanceDigest,
	builtEvent,
	newRun,
	apply,
	contractDigest,
	ticket,
} from "./helpers.ts";

const issue: Ticket = {
	ref: ticket,
	title: "Add a thing",
	body: "Please add a thing.",
	labels: ["factory:ready"],
	author: "maintainer",
};

function fixture() {
	const adapter = new FakeTicketAdapter();
	adapter.addTicket(issue);
	adapter.setPermission("maintainer", "write");
	adapter.setPermission("stranger", "read");

	return adapter;
}

async function admitFromLabel(
	adapter: FakeTicketAdapter,
	actor: string,
): Promise<Run | "refused" | "ignored"> {
	const event = adapter.normalize(
		adapter.rawEvent({
			kind: "ready",
			id: "34537521383",
			at: "2026-10-29T01:21:37Z",
			ref: ticket,
			actor,
		}),
	);

	if (event === null || event.kind !== "ready") return "ignored";
	const canAdmit = await adapter.canAdmit(event.ref, event.actor);

	const decision = decideAdmission({
		label: "factory:ready",
		actorPermission: canAdmit ? "write" : "none",
	});

	if (decision.kind === "refused") return "refused";

	return apply(newRun(), { kind: "admitted" });
}

describe("controller driven through the fake adapter", () => {
	it("ignores payloads the adapter does not recognise", () => {
		const adapter = fixture();
		assert.equal(adapter.normalize({ action: "labeled" }), null);
		assert.equal(adapter.normalize("nope"), null);
		assert.equal(adapter.normalize(null), null);
	});

	it("round-trips events minted by the fake", () => {
		const adapter = fixture();

		const event: FactoryEvent = {
			kind: "pr_feedback",
			id: "6485238589",
			at: "2026-10-29T01:21:48Z",
			ref: ticket,
			actor: "maintainer",
			prUrl: "https://github.com/giuseppecrj/pi-herdr-factorio/pull/7",
			comment: "rename this",
		};

		assert.deepEqual(adapter.normalize(adapter.rawEvent(event)), event);
	});

	it("lists open ready tickets and reads states keyed by provider and repository", async () => {
		const adapter = fixture();

		const sameNumberElsewhere: Ticket = {
			...issue,
			ref: {
				provider: "github",
				key: "giuseppecrj/other#42",
				url: "https://github.com/giuseppecrj/other/issues/42",
			},
			labels: [],
		};

		adapter.addTicket(sameNumberElsewhere);

		assert.deepEqual(
			(await adapter.fetchCandidates()).map((each) => each.ref),
			[ticket],
		);

		adapter.closeTicket(ticket);
		assert.deepEqual(await adapter.fetchCandidates(), []);

		const states = await adapter.fetchStates([ticket, sameNumberElsewhere.ref]);

		assert.notEqual(ticketKey(ticket), ticketKey(sameNumberElsewhere.ref));
		assert.equal(states.get(ticketKey(ticket))?.open, false);
		assert.deepEqual(states.get(ticketKey(sameNumberElsewhere.ref)), {
			ref: sameNumberElsewhere.ref,
			open: true,
			labels: [],
		});
	});

	it("refuses the ready label from an account without write access", async () => {
		const adapter = fixture();
		assert.equal(await admitFromLabel(adapter, "stranger"), "refused");
		assert.deepEqual(adapter.calls, []);
	});

	it("takes an admitted ticket to landed and reports and closes it", async () => {
		const adapter = fixture();
		const admitted = await admitFromLabel(adapter, "maintainer");
		assert.notEqual(admitted, "refused");
		assert.notEqual(admitted, "ignored");

		if (admitted === "refused" || admitted === "ignored") return;

		const fetched = await adapter.fetch(admitted.ticket);
		assert.equal(fetched.title, "Add a thing");

		const events: RunEvent[] = [
			{ kind: "specified", contractDigest },
			{ kind: "accepted", acceptanceDigest },
			builtEvent(),
		];

		const candidate = apply(admitted, ...events);
		assert.equal(outcomeOf(candidate), undefined);
		assert.equal(adapter.calls.length, 0);

		const observed = {
			kind: "observed",
			now: 100,
			main: builtEvent().pin.originalBase,
			pr: { kind: "none" },
			executionAllowed: true,
			eligibility: "ready",
			capacityAvailable: true,
			readiness: { kind: "unavailable" },
		} as const;

		const selected = apply(candidate, { kind: "candidate", event: observed });

		const merging = advance(selected, {
			kind: "candidate",
			event: {
				...observed,
				executionAllowed: false,
				eligibility: "withdrawn",
				pr: {
					kind: "merged",
					number: 5,
					head: builtEvent().pin.originalBase,
					mergeSha: builtEvent().pin.originalBase,
					actor: "owner",
				},
			},
		});

		assert.equal(merging.kind, "advanced");
		assert.equal(merging.effect?.kind, "finish_pr");

		if (merging.effect?.kind !== "finish_pr") throw new Error("missing finish");

		const done = apply(merging.run, {
			kind: "candidate",
			event: {
				kind: "effect_completed",
				completion: { kind: "finish_pr", request: merging.effect },
			},
		});

		await adapter.report(done.ticket, done);
		await adapter.close(done.ticket, done);

		assert.deepEqual(outcomeOf(done), {
			kind: "landed",
			mergeSha: builtEvent().pin.originalBase,
		});
		assert.deepEqual(
			adapter.calls.map((call) => call.kind),
			["report", "close"],
		);
	});

	it("asks the ticket's questions when specify needs info", async () => {
		const adapter = fixture();
		const admitted = await admitFromLabel(adapter, "maintainer");

		if (admitted === "refused" || admitted === "ignored")
			throw new Error(admitted);
		const questions: [string, ...string[]] = ["Which database?"];
		const done = apply(admitted, { kind: "needs_info", questions });
		const outcome = outcomeOf(done);
		assert.equal(outcome?.kind, "needs_info");

		if (outcome?.kind === "needs_info") {
			await adapter.ask(done.ticket, outcome.questions);
		}

		assert.deepEqual(adapter.calls, [
			{ kind: "ask", ref: ticket, questions: ["Which database?"] },
		]);
	});

	it("rejects a patch that touches workflows and lands nothing", async () => {
		const adapter = fixture();
		const admitted = await admitFromLabel(adapter, "maintainer");

		if (admitted === "refused" || admitted === "ignored")
			throw new Error(admitted);

		const built = apply(
			admitted,
			{ kind: "specified", contractDigest },
			{ kind: "accepted", acceptanceDigest },
		);

		const paths = checkChangedPaths({
			changedPaths: ["src/a.ts", ".github/workflows/factory.yml"],
		});

		assert.equal(paths.kind, "forbidden");
		const done = apply(built, { kind: "rejected", reason: "forbidden_paths" });
		assert.deepEqual(outcomeOf(done), {
			kind: "rejected",
			reason: "forbidden_paths",
		});
		assert.equal(advance(done, builtEvent()).kind, "invalid");
	});
});
