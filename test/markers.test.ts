import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { CommentEdit, IssueComment } from "../src/adapters/github.ts";
import {
	CONTROLLER_LOGIN,
	currentMarker,
	formatMarker,
	type Marker,
	MARKER_MAX_BYTES,
	MARKER_PREFIX,
	markerLedger,
	parseMarker,
} from "../src/markers.ts";
import { digestOf, runIdOf } from "../src/run.ts";
import type { JsonValue } from "../src/tickets.ts";
import {
	type GitSha,
	isGitSha,
	isRepoSlug,
	type RepoSlug,
} from "../src/workflow.ts";

function slug(text: string): RepoSlug {
	if (!isRepoSlug(text)) throw new Error(`bad slug ${text}`);

	return text;
}

function sha(text: string): GitSha {
	if (!isGitSha(text)) throw new Error(`bad sha ${text}`);

	return text;
}

const repo = slug("giuseppecrj/pi-herdr-factorio");
const runId = runIdOf({ repo, issue: 14, eventId: "34537521383" });

function marker(change: Partial<Marker> = {}): Marker {
	return {
		v: 1,
		runId,
		repo,
		issue: 14,
		eventId: "34537521383",
		eventAt: "2026-10-29T01:21:37Z",
		snapshotDigest: digestOf("snapshot"),
		workflowSha: sha("c".repeat(40)),
		workflowDigest: digestOf("workflow"),
		stage: "specify",
		status: "claimed",
		attempt: 1,
		seq: 1,
		branch: null,
		pr: null,
		usage: 0,
		cursor: "2026-10-29T01:00:00Z",
		...change,
	};
}

function rawBody(edit: (fields: Map<string, JsonValue>) => void): string {
	const fields = new Map<string, JsonValue>(Object.entries(marker()));

	edit(fields);

	return `${MARKER_PREFIX}${JSON.stringify(Object.fromEntries(fields))} -->`;
}

let nextId = 100;

function comment(
	body: string,
	change: Partial<IssueComment> = {},
): IssueComment {
	const id = String(nextId++);

	return {
		id,
		nodeId: `IC_${id}`,
		issueUrl: `https://api.github.com/repos/${repo}/issues/14`,
		author: { login: CONTROLLER_LOGIN, type: "Bot" },
		appSlug: "exe-dev-github-integration",
		body,
		createdAt: "2026-10-29T02:00:00Z",
		...change,
	};
}

function unedited(comments: readonly IssueComment[]): Map<string, CommentEdit> {
	return new Map(
		comments.map((item) => [
			item.nodeId,
			{ id: item.id, issue: 14, repo, lastEditedAt: null },
		]),
	);
}

function ledgerOf(
	comments: readonly IssueComment[],
	edits = unedited(comments),
) {
	return markerLedger({ repo, issue: 14, comments, edits });
}

describe("marker format", () => {
	it("round-trips every field", () => {
		const written = marker({ status: "blocked", seq: 4, attempt: 2, usage: 7 });
		const parsed = parseMarker(formatMarker(written));

		assert.deepEqual(parsed, { kind: "marker", marker: written });
	});

	it("starts with the exact prefix and closes the comment once", () => {
		const body = formatMarker(marker());

		assert.ok(body.startsWith(MARKER_PREFIX));
		assert.equal(body.split("-->").length, 2);
		assert.match(
			body,
			/\nFactory run `[0-9a-f]{12}` is claimed\. Stage specify, attempt 1\.\n$/,
		);
	});

	it("never carries issue text, labels or paths", () => {
		const body = formatMarker(marker());

		assert.doesNotMatch(body, /factory:ready|\/home\/|title|body/);
	});

	it("escapes < and > inside the JSON", () => {
		const body = rawBody((fields) => {
			fields.set("cursor", "<x>");
		});

		assert.equal(parseMarker(body).kind, "corrupt");
		assert.doesNotMatch(
			formatMarker(marker()).slice(MARKER_PREFIX.length).split(" -->")[0] ?? "",
			/[<>]/,
		);
	});

	it("keeps every marker under the size cap", () => {
		const body = formatMarker(
			marker({ seq: Number.MAX_SAFE_INTEGER, usage: Number.MAX_SAFE_INTEGER }),
		);

		assert.ok(Buffer.byteLength(body) <= MARKER_MAX_BYTES);
	});
});

describe("parseMarker", () => {
	it("ignores a body that is not shaped like a marker", () => {
		assert.deepEqual(parseMarker("Looks good to me."), { kind: "none" });
		assert.deepEqual(parseMarker(" <!-- factory:run {} -->"), { kind: "none" });
	});

	const cases: [string, string, string][] = [
		[
			"an unknown version",
			rawBody((f) => {
				f.set("v", 2);
			}),
			"unknown_version",
		],
		[
			"a string version",
			rawBody((f) => {
				f.set("v", "1");
			}),
			"unknown_version",
		],
		[
			"an unknown key",
			rawBody((f) => {
				f.set("title", "x");
			}),
			"unknown_key",
		],
		[
			"a missing key",
			rawBody((f) => {
				f.delete("cursor");
			}),
			"missing_key",
		],
		[
			"a missing version",
			rawBody((f) => {
				f.delete("v");
			}),
			"missing_key",
		],
		[
			"a bad stage",
			rawBody((f) => {
				f.set("stage", "deploy");
			}),
			"bad_value",
		],
		[
			"a bad status",
			rawBody((f) => {
				f.set("status", "done");
			}),
			"bad_value",
		],
		[
			"a zero seq",
			rawBody((f) => {
				f.set("seq", 0);
			}),
			"bad_value",
		],
		[
			"a fractional attempt",
			rawBody((f) => {
				f.set("attempt", 1.5);
			}),
			"bad_value",
		],
		[
			"a negative usage",
			rawBody((f) => {
				f.set("usage", -1);
			}),
			"bad_value",
		],
		[
			"a branch before F07",
			rawBody((f) => {
				f.set("branch", "factory/14");
			}),
			"bad_value",
		],
		[
			"a PR before F07",
			rawBody((f) => {
				f.set("pr", 3);
			}),
			"bad_value",
		],
		[
			"a short SHA",
			rawBody((f) => {
				f.set("workflowSha", "abc");
			}),
			"bad_value",
		],
		[
			"a path in the cursor",
			rawBody((f) => {
				f.set("cursor", "/home/x");
			}),
			"bad_value",
		],
		[
			"a forged run ID",
			rawBody((f) => {
				f.set("eventId", "1");
			}),
			"run_id_mismatch",
		],
		["a JSON array", `${MARKER_PREFIX}[1] -->`, "malformed"],
		["broken JSON", `${MARKER_PREFIX}{"v":1 -->`, "malformed"],
		["no closing", `${MARKER_PREFIX}{"v":1}`, "malformed"],
		["the wrong lead", "<!-- factory:runs {} -->", "malformed"],
		["text glued to the close", `${rawBody(() => {})}x`, "malformed"],
		[
			"an oversized body",
			`${rawBody(() => {})}\n${"x".repeat(MARKER_MAX_BYTES)}`,
			"too_large",
		],
	];

	for (const [name, body, defect] of cases) {
		it(`marks ${name} corrupt`, () => {
			assert.deepEqual(parseMarker(body), { kind: "corrupt", defect });
		});
	}
});

describe("markerLedger trust rule", () => {
	it("trusts an unedited bot marker on its own issue", () => {
		const ledger = ledgerOf([comment(formatMarker(marker()))]);

		assert.equal(ledger.kind, "clean");
		assert.equal(
			ledger.kind === "clean" && currentMarker(ledger)?.runId,
			runId,
		);
	});

	it("ignores a marker written by any other account", () => {
		const forged = comment(
			formatMarker(marker({ status: "released", seq: 9 })),
			{
				author: { login: "giuseppecrj", type: "User" },
				appSlug: null,
			},
		);

		const ledger = ledgerOf([comment(formatMarker(marker())), forged]);

		assert.equal(ledger.kind, "clean");

		if (ledger.kind !== "clean") return;

		assert.equal(ledger.ignored, 1);
		assert.equal(currentMarker(ledger)?.status, "claimed");
	});

	it("ignores a bot comment that is not shaped like a marker", () => {
		const ledger = ledgerOf([comment("A plain note from the bot.")]);

		assert.deepEqual(ledger, { kind: "clean", markers: [], ignored: 0 });
	});

	const defects: [string, IssueComment, string][] = [
		[
			"the bot login with a User type",
			comment(formatMarker(marker()), {
				author: { login: CONTROLLER_LOGIN, type: "User" },
			}),
			"not_bot_type",
		],
		[
			"another app",
			comment(formatMarker(marker()), { appSlug: "someone-else" }),
			"wrong_app",
		],
		[
			"a comment on another issue",
			comment(formatMarker(marker()), {
				issueUrl: `https://api.github.com/repos/${repo}/issues/15`,
			}),
			"wrong_issue",
		],
		[
			"a marker naming another issue",
			comment(
				formatMarker(
					marker({
						issue: 15,
						runId: runIdOf({ repo, issue: 15, eventId: "34537521383" }),
					}),
				),
			),
			"wrong_issue",
		],
		[
			"a corrupt body",
			comment(
				rawBody((f) => {
					f.set("v", 9);
				}),
			),
			"unknown_version",
		],
	];

	for (const [name, item, defect] of defects) {
		it(`fails closed on ${name}`, () => {
			assert.deepEqual(ledgerOf([item]), {
				kind: "corrupt",
				defect,
				commentId: item.id,
			});
		});
	}

	it("fails closed on a marker edited after it was posted", () => {
		const item = comment(formatMarker(marker()));

		const edits = new Map([
			[
				item.nodeId,
				{ id: item.id, issue: 14, repo, lastEditedAt: "2026-10-29T03:00:00Z" },
			],
		]);

		assert.deepEqual(ledgerOf([item], edits), {
			kind: "corrupt",
			defect: "edited",
			commentId: item.id,
		});
	});

	it("fails closed when the edit read names another comment or is missing", () => {
		const item = comment(formatMarker(marker()));

		assert.equal(ledgerOf([item], new Map()).kind, "corrupt");

		const wrong = new Map([
			[item.nodeId, { id: "1", issue: 14, repo, lastEditedAt: null }],
		]);

		assert.deepEqual(ledgerOf([item], wrong), {
			kind: "corrupt",
			defect: "edit_unverified",
			commentId: item.id,
		});
	});

	it("takes the highest seq as current", () => {
		const ledger = ledgerOf([
			comment(formatMarker(marker({ seq: 2, status: "blocked" }))),
			comment(formatMarker(marker({ seq: 1 }))),
		]);

		assert.equal(
			ledger.kind === "clean" && currentMarker(ledger)?.status,
			"blocked",
		);
	});

	it("fails closed on two markers with the same seq", () => {
		const second = comment(formatMarker(marker({ status: "blocked" })));
		const ledger = ledgerOf([comment(formatMarker(marker())), second]);

		assert.deepEqual(ledger, {
			kind: "corrupt",
			defect: "duplicate_seq",
			commentId: second.id,
		});
	});

	it("fails closed when one run's markers disagree", () => {
		const second = comment(
			formatMarker(marker({ seq: 2, snapshotDigest: digestOf("other") })),
		);

		const ledger = ledgerOf([comment(formatMarker(marker())), second]);

		assert.equal(ledger.kind === "corrupt" && ledger.defect, "conflicting_run");
	});

	it("fails closed on a marker after its run ended", () => {
		const ledger = ledgerOf([
			comment(formatMarker(marker({ seq: 1, status: "released" }))),
			comment(formatMarker(marker({ seq: 2, status: "blocked" }))),
		]);

		assert.equal(ledger.kind === "corrupt" && ledger.defect, "after_terminal");
	});

	it("accepts a new run after an ended one", () => {
		const next = runIdOf({ repo, issue: 14, eventId: "34537521999" });

		const ledger = ledgerOf([
			comment(formatMarker(marker({ seq: 1, status: "released" }))),
			comment(
				formatMarker(marker({ seq: 2, runId: next, eventId: "34537521999" })),
			),
		]);

		assert.equal(ledger.kind === "clean" && currentMarker(ledger)?.runId, next);
	});
});
