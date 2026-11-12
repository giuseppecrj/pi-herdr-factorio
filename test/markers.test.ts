import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { CommentEdit, IssueComment } from "../src/adapters/github.ts";
import {
	CONTROLLER_LOGIN,
	currentMarker,
	formatMarker,
	isTerminal,
	type Marker,
	MARKER_MAX_BYTES,
	MARKER_PREFIX,
	markerLedger,
	parseMarker,
	RUN_STATUSES,
} from "../src/markers.ts";
import { digestOf, runIdOf } from "../src/core/run.ts";
import type { HandoffReason } from "../src/handoff.ts";
import type { JsonValue } from "../src/core/json.ts";
import {
	type GitSha,
	isGitSha,
	isRepoSlug,
	type RepoSlug,
} from "../src/workflow.ts";
import { EXE_DEV_PLATFORM } from "../src/platform.ts";

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

function rawBody(
	edit: (fields: Map<string, JsonValue>) => void,
	value: Marker = marker(),
): string {
	const encoded: JsonValue = JSON.parse(JSON.stringify(value));
	assert.ok(encoded instanceof Object && !Array.isArray(encoded));
	const fields = new Map<string, JsonValue>(Object.entries(encoded));

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
	return markerLedger({
		identity: EXE_DEV_PLATFORM,
		repo,
		issue: 14,
		comments,
		edits,
	});
}

describe("repository move", () => {
	it("keeps a pre-move marker untrusted after the move, under the new name and the alias alike", () => {
		const moved = slug("nublai/pi-herdr-factorio");

		// The platform records the former name only as read-only history.
		assert.deepEqual(EXE_DEV_PLATFORM.historicalRepositories[moved], [repo]);

		const old = marker({ status: "needs_info", seq: 3 });
		assert.equal(parseMarker(formatMarker(old)).kind, "marker");

		// GitHub now serves the old comment under the new owner.
		const served = comment(formatMarker(old), {
			issueUrl: `https://api.github.com/repos/${moved}/issues/14`,
		});

		const edits = new Map([
			[
				served.nodeId,
				{ id: served.id, issue: 14, repo: moved, lastEditedAt: null },
			],
		]);

		for (const expected of [moved, repo]) {
			const result = markerLedger({
				identity: EXE_DEV_PLATFORM,
				repo: expected,
				issue: 14,
				comments: [served],
				edits,
			});

			assert.equal(result.kind, "corrupt", expected);
			assert.equal(result.kind === "corrupt" && result.defect, "wrong_issue");
		}

		const fresh = marker({
			repo: moved,
			runId: runIdOf({ repo: moved, issue: 14, eventId: "34537521383" }),
		});

		assert.equal(
			markerLedger({
				identity: EXE_DEV_PLATFORM,
				repo: moved,
				issue: 14,
				comments: [{ ...served, body: formatMarker(fresh) }],
				edits,
			}).kind,
			"clean",
		);
	});
});

describe("needs_info status", () => {
	it("is a terminal status that round-trips and tells the owner how to resume", () => {
		const body = formatMarker(marker({ status: "needs_info", seq: 3 }));

		assert.ok(RUN_STATUSES.includes("needs_info"));
		assert.ok(isTerminal("needs_info"));
		assert.deepEqual(parseMarker(body), {
			kind: "marker",
			marker: marker({ status: "needs_info", seq: 3 }),
		});
		assert.match(
			body,
			/ is stopped: questions are on the issue; answer them and add factory:ready again\. /,
		);
	});

	it("keeps every earlier status, so markers already on issues still parse", () => {
		assert.deepEqual(
			[...RUN_STATUSES],
			[
				"claimed",
				"running",
				"blocked",
				"retrying",
				"released",
				"failed",
				"budget_exhausted",
				"stage_passed",
				"needs_info",
				"waiting",
				"landed",
				"cancelled",
			],
		);
	});

	it("rejects a marker after a run's needs_info as after_terminal", () => {
		const ledger = ledgerOf([
			comment(formatMarker(marker({ status: "needs_info", seq: 1 }))),
			comment(formatMarker(marker({ status: "running", seq: 2 }))),
		]);

		assert.equal(ledger.kind === "corrupt" && ledger.defect, "after_terminal");
	});
});

describe("keyed specify comments in the ledger", () => {
	const key = `<!-- factory-questions run=${runId} q=${"d".repeat(64)} -->`;

	it("ignores a controller comment whose hidden key trails the body", () => {
		const ledger = ledgerOf([
			comment(formatMarker(marker())),
			comment(`The factory needs answers.\n\n1. Which one?\n\n${key}\n`),
		]);

		assert.equal(ledger.kind, "clean");
		assert.equal(ledger.kind === "clean" && ledger.markers.length, 1);
	});

	it("marks the issue corrupt when a controller comment starts with <!-- factory:", () => {
		const ledger = ledgerOf([
			comment(`<!-- factory:questions run=${runId} -->\n1. Which one?\n`),
		]);

		assert.equal(ledger.kind === "corrupt" && ledger.defect, "malformed");
	});

	it("marks the issue corrupt when someone edits the questions comment", () => {
		const asked = comment(`1. Which one?\n\n${key}\n`);
		const edits = unedited([asked]);

		edits.set(asked.nodeId, {
			id: asked.id,
			issue: 14,
			repo,
			lastEditedAt: "2026-10-29T03:00:00Z",
		});

		const ledger = ledgerOf([asked], edits);

		assert.equal(ledger.kind === "corrupt" && ledger.defect, "edited");
	});
});

const holdLabels = {
	disabled: "factory execution is disabled",
	main_moving: "the base branch keeps changing",
	refresh_limit: "the base refresh allowance is used",
	review_attempts: "the review attempt allowance is used",
	review_tokens: "a review round used its token allowance",
	repair_tokens: "a repair round used its token allowance",
	run_tokens: "the run used its token allowance",
	head_drift: "the PR head changed unexpectedly",
	owner_head: "an owner push requires fresh checks and review",
	owner_head_refused: "the owner head cannot be certified as is",
	owner_head_failed: "owner-head checks or review did not pass",
	owner_head_behind: "the owner must update the branch from main",
	checks_failed: "a required check failed on the certified head",
	head_lag: "the PR head has not caught up",
	checks_incomplete: "waiting for required checks",
	review_failed: "the review did not pass",
	review_input_too_large: "the review input is too large",
	summary_too_large: "the PR summary is too large",
	pr_identity: "the PR identity could not be verified",
	pr_ambiguous: "more than one PR matches this run",
	workflow_unavailable:
		"the run's pinned WORKFLOW.md cannot be read or verified",
	validation_failed: "validation did not pass",
	evidence_unavailable: "required evidence is unavailable",
	repair_limit: "the repair round allowance is used",
	diagnosis_oracle: "the acceptance checks need attention",
	diagnosis_missing_evidence: "diagnosis is missing required evidence",
	diagnosis_infrastructure: "diagnosis found an infrastructure problem",
	feedback_overflow: "owner feedback exceeds the intake limit",
	feedback_repair: "owner feedback requires a repair",
	repair_no_progress: "the repair made no progress",
	repair_repeated_finding: "the repair repeated a blocking finding",
	closed: "the PR is closed",
	withdrawn: "authorization was withdrawn",
} satisfies Record<HandoffReason, string>;

describe("held marker text", () => {
	it("uses stable neutral text when a candidate hold reason is unavailable", () => {
		const value = marker({
			v: 3,
			status: "blocked",
			stage: "land",
			candidate: null,
			round: 0,
			ciRun: null,
			handoff: {
				generation: 0,
				intentDigest: digestOf("intent"),
				refreshes: 0,
				reviewAttempts: [0, 0, 0],
				promoted: null,
			},
		});

		const body = formatMarker(value);

		assert.match(body, /blocked: this run is on hold/);
		assert.doesNotMatch(body, /sandbox/);
		assert.equal(formatMarker(structuredClone(value)), body);
		assert.deepEqual(parseMarker(body), { kind: "marker", marker: value });
	});

	it("retains the authenticated comment body for restart-stable comparison", () => {
		const body = formatMarker(
			marker({ status: "blocked", stage: "build" }),
			"repair_tokens",
			2,
		);

		const ledger = ledgerOf([comment(body)]);

		assert.ok(ledger.kind === "clean");
		assert.partialDeepStrictEqual(ledger.markers[0], { body });
	});

	for (const [reason, label] of Object.entries(holdLabels)) {
		it(`explains ${reason} without changing the marker wire format`, () => {
			const value = marker({
				v: 2,
				status: "blocked",
				stage: "build",
				round: 1,
				candidate: null,
				ciRun: null,
			});

			// SAFETY: holdLabels is exhaustively checked against HandoffReason above.
			const body = formatMarker(value, reason as HandoffReason);

			assert.ok(body.includes(`blocked: ${label} (${reason})`));
			assert.match(body, /Stage build, round 1, attempt 1\./);
			assert.equal(body.split("\n")[0], formatMarker(value).split("\n")[0]);
			assert.deepEqual(parseMarker(body), { kind: "marker", marker: value });
		});
	}
});

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

	it("says a passed stage stops the run, and a blocked one lacks its sandbox", () => {
		const passed = formatMarker(marker({ status: "stage_passed" }));

		assert.match(
			passed,
			/ is stopped: stage passed; the next stage is not installed\. Stage specify, attempt 1\.\n$/,
		);
		assert.deepEqual(parseMarker(passed), {
			kind: "marker",
			marker: marker({ status: "stage_passed" }),
		});
		assert.ok(isTerminal("stage_passed"));
		assert.match(
			formatMarker(marker({ status: "blocked" })),
			/ is blocked: the stage sandbox is unavailable\. /,
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
				f.set("v", 4);
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

describe("marker v2", () => {
	it("round-trips publication and CI identities, while v1 still parses", () => {
		const value = marker({
			v: 2,
			branch: `factory/run/14-${runId.slice(0, 12)}-r2`,
			candidate: sha("d".repeat(40)),
			round: 2,
			ciRun: 41153584933,
		});

		assert.deepEqual(parseMarker(formatMarker(value)), {
			kind: "marker",
			marker: value,
		});
		assert.deepEqual(parseMarker(formatMarker(marker())), {
			kind: "marker",
			marker: marker(),
		});
	});
	it("binds v2 branch, candidate and CI fields to issue, run and round", () => {
		for (const change of [
			{ branch: `factory/run/999-${runId.slice(0, 12)}-r2` },
			{ branch: `factory/run/14-${"f".repeat(12)}-r2` },
			{ branch: `factory/run/14-${runId.slice(0, 12)}-r1` },
			{ branch: null },
			{ candidate: null },
		])
			assert.equal(
				parseMarker(
					formatMarker(
						marker({
							v: 2,
							branch: `factory/run/14-${runId.slice(0, 12)}-r2`,
							candidate: sha("d".repeat(40)),
							round: 2,
							ciRun: 123,
							...change,
						}),
					),
				).kind,
				"corrupt",
			);
		assert.equal(
			parseMarker(formatMarker(marker({ v: 2, ciRun: 123 }))).kind,
			"corrupt",
		);
	});
	it("keeps a fully populated v2 marker below the 4096-byte cap", () => {
		const value = marker({
			v: 2,
			branch: `factory/run/9007199254740991-${runId.slice(0, 12)}-r2`,
			candidate: sha("d".repeat(40)),
			round: 2,
			ciRun: Number.MAX_SAFE_INTEGER,
			attempt: Number.MAX_SAFE_INTEGER,
			seq: Number.MAX_SAFE_INTEGER,
			usage: Number.MAX_SAFE_INTEGER,
			cursor: "x".repeat(64),
		});

		assert.ok(Buffer.byteLength(formatMarker(value)) < MARKER_MAX_BYTES);
	});
	it("rejects unrelated branches and malformed v2 identities", () => {
		for (const change of [
			{ branch: "factory/ledger" },
			{ round: 3 },
			{ ciRun: 0 },
		])
			assert.equal(
				parseMarker(formatMarker(marker({ v: 2, ...change }))).kind,
				"corrupt",
			);
	});
});

it("refuses non-text branch and candidate values in marker v2", () => {
	for (const key of ["branch", "candidate"]) {
		const body = rawBody((fields) => {
			fields.set("v", 2);
			fields.set("candidate", null);
			fields.set("round", 0);
			fields.set("ciRun", null);
			fields.set(key, false);
		});

		assert.deepEqual(parseMarker(body), {
			kind: "corrupt",
			defect: "bad_value",
		});
	}
});

describe("marker v3 boundaries", () => {
	const issue = Number.MAX_SAFE_INTEGER;
	const eventId = "9".repeat(20);
	const id = runIdOf({ repo, issue, eventId });

	const value = marker({
		v: 3,
		runId: id,
		issue,
		eventId,
		eventAt: "9999-12-31T23:59:59Z",
		stage: "land",
		status: "waiting",
		branch: `factory/run/${issue}-${id.slice(0, 12)}-r2-g3`,
		candidate: sha("d".repeat(40)),
		round: 2,
		ciRun: Number.MAX_SAFE_INTEGER,
		pr: Number.MAX_SAFE_INTEGER,
		attempt: Number.MAX_SAFE_INTEGER,
		seq: Number.MAX_SAFE_INTEGER,
		usage: Number.MAX_SAFE_INTEGER,
		cursor: "x".repeat(64),
		handoff: {
			generation: 3,
			intentDigest: digestOf("intent"),
			refreshes: 3,
			reviewAttempts: [3, 3, 3],
			promoted: digestOf("promoted"),
		},
	});

	it("round-trips a fully populated configured-repo v3 marker with codec-legal maximal counters, not a controller-reachable state", (t) => {
		const body = formatMarker(value);
		const bytes = Buffer.byteLength(body, "utf8");

		assert.deepEqual(parseMarker(body), { kind: "marker", marker: value });
		assert.ok(bytes < MARKER_MAX_BYTES);
		t.diagnostic(`configured-repo populated v3 marker: ${bytes} UTF-8 bytes`);
	});

	it("accepts exactly 4096 whole-comment UTF-8 bytes and rejects 4097 with multibyte human text", () => {
		const body = `${formatMarker(value)}Owner review: café 工厂 😀\n`;

		const exact =
			body + "x".repeat(MARKER_MAX_BYTES - Buffer.byteLength(body, "utf8"));

		assert.equal(Buffer.byteLength(exact, "utf8"), 4096);
		assert.ok(exact.length < Buffer.byteLength(exact, "utf8"));
		assert.deepEqual(parseMarker(exact), { kind: "marker", marker: value });
		assert.equal(Buffer.byteLength(`${exact}x`, "utf8"), 4097);
		assert.deepEqual(parseMarker(`${exact}x`), {
			kind: "corrupt",
			defect: "too_large",
		});
	});

	const invalid: [string, string, JsonValue][] = [
		["generation over 3", "generation", 4],
		["negative generation", "generation", -1],
		["fractional generation", "generation", 0.5],
		["refreshes over 3", "refreshes", 4],
		["negative refreshes", "refreshes", -1],
		["fractional refreshes", "refreshes", 0.5],
		["short review attempts", "reviewAttempts", [3, 3]],
		["long review attempts", "reviewAttempts", [3, 3, 3, 0]],
		["negative review attempt", "reviewAttempts", [3, -1, 3]],
		["fractional review attempt", "reviewAttempts", [3, 0.5, 3]],
		["review attempt over 3", "reviewAttempts", [3, 4, 3]],
		["string review attempt", "reviewAttempts", [3, "3", 3]],
		["malformed intent digest", "intentDigest", "not-a-digest"],
		["Git SHA instead of intent digest", "intentDigest", "a".repeat(40)],
		["malformed promoted digest", "promoted", "g".repeat(64)],
		["Git SHA instead of promoted digest", "promoted", "a".repeat(40)],
	];

	for (const [name, key, changed] of invalid)
		it(`rejects untrusted v3 ${name} as bad_value`, () => {
			assert.deepEqual(parseMarker(formatMarker(value)), {
				kind: "marker",
				marker: value,
			});

			const body = rawBody((fields) => {
				const handoff = fields.get("handoff");
				assert.ok(handoff instanceof Object && !Array.isArray(handoff));
				fields.set("handoff", { ...handoff, [key]: changed });
			}, value);

			assert.deepEqual(parseMarker(body), {
				kind: "corrupt",
				defect: "bad_value",
			});
		});

	it("rejects null handoff as bad_value and an absent handoff as missing_key", () => {
		assert.deepEqual(parseMarker(formatMarker(value)), {
			kind: "marker",
			marker: value,
		});
		assert.deepEqual(
			parseMarker(rawBody((fields) => fields.set("handoff", null), value)),
			{
				kind: "corrupt",
				defect: "bad_value",
			},
		);
		assert.deepEqual(
			parseMarker(rawBody((fields) => fields.delete("handoff"), value)),
			{
				kind: "corrupt",
				defect: "missing_key",
			},
		);
	});
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

	it("fails closed on a bot comment edited to drop the marker prefix", () => {
		const item = comment("A plain note from the bot.");

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

	it("fails closed on a bot comment without the prefix whose edit read is missing or names another comment", () => {
		const item = comment("A plain note from the bot.");

		assert.deepEqual(ledgerOf([item], new Map()), {
			kind: "corrupt",
			defect: "edit_unverified",
			commentId: item.id,
		});

		const wrong = new Map([
			[item.nodeId, { id: "1", issue: 14, repo, lastEditedAt: null }],
		]);

		assert.deepEqual(ledgerOf([item], wrong), {
			kind: "corrupt",
			defect: "edit_unverified",
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
