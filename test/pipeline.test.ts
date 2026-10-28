import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { decideAdmission, checkChangedPaths } from "../src/policy.ts";
import { outcomeOf, startRun, type Run } from "../src/run.ts";
import { advance, type RunEvent } from "../src/stages.ts";
import type { FactoryEvent, Ticket } from "../src/tickets.ts";
import { FakeTicketAdapter } from "./fake-ticket-adapter.ts";
import {
	acceptanceDigest,
	apply,
	contractDigest,
	passingVerdict,
	patch,
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
		adapter.rawEvent({ kind: "ready", ref: ticket, actor }),
	);
	if (event === null || event.kind !== "ready") return "ignored";
	const canAdmit = await adapter.canAdmit(event.ref, event.actor);
	const decision = decideAdmission({
		label: "factory:ready",
		actorPermission: canAdmit ? "write" : "none",
	});
	if (decision.kind === "refused") return "refused";
	return apply(
		startRun({
			id: "run-1",
			ticket: event.ref,
			repo: "r",
			baseSha: "a".repeat(40),
		}),
		{ kind: "admitted" },
	);
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
			ref: ticket,
			actor: "maintainer",
			prUrl: "https://github.com/giuseppecrj/pi-herdr-factorio/pull/7",
			comment: "rename this",
		};
		assert.deepEqual(adapter.normalize(adapter.rawEvent(event)), event);
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
		if (typeof admitted === "string") return;

		const fetched = await adapter.fetch(admitted.ticket);
		assert.equal(fetched.title, "Add a thing");

		const events: RunEvent[] = [
			{ kind: "specified", contractDigest },
			{ kind: "accepted", acceptanceDigest },
			{ kind: "built", patchDigest: patch("a") },
			{ kind: "validated", verdict: passingVerdict(patch("a")) },
			{ kind: "reviewed", blockingFindings: [] },
			{ kind: "landed", mergeSha: "e".repeat(40) },
		];
		const done = apply(admitted, ...events);
		await adapter.report(done.ticket, done);
		await adapter.close(done.ticket, done);

		assert.deepEqual(outcomeOf(done), {
			kind: "landed",
			mergeSha: "e".repeat(40),
		});
		assert.deepEqual(
			adapter.calls.map((call) => call.kind),
			["report", "close"],
		);
	});

	it("asks the ticket's questions when specify needs info", async () => {
		const adapter = fixture();
		const admitted = await admitFromLabel(adapter, "maintainer");
		if (typeof admitted === "string") throw new Error(admitted);
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
		if (typeof admitted === "string") throw new Error(admitted);
		const built = apply(
			admitted,
			{ kind: "specified", contractDigest },
			{ kind: "accepted", acceptanceDigest },
			{ kind: "built", patchDigest: patch("bad") },
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
		assert.equal(
			advance(done, { kind: "landed", mergeSha: "f".repeat(40) }).kind,
			"invalid",
		);
	});
});
