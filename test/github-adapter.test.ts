import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
	actorText,
	GitHubReadError,
	GitHubTicketAdapter,
	isLogin,
	type Login,
} from "../src/adapters/github.ts";
import { READY_LABEL } from "../src/policy.ts";
import { type JsonValue, ticketKey } from "../src/tickets.ts";
import { isRepoSlug, type RepoSlug } from "../src/workflow.ts";
import {
	commentEvent,
	FAKE_REPO,
	FakeGitHub,
	fakeIssue,
	httpError,
	labelEvent,
	networkError,
	renamedEvent,
} from "./fake-ticket-adapter.ts";

function slug(text: string): RepoSlug {
	if (!isRepoSlug(text)) throw new Error(`bad slug ${text}`);

	return text;
}

const repo = slug(FAKE_REPO);

function login(text: string): Login {
	if (!isLogin(text)) throw new Error(`bad login ${text}`);

	return text;
}

function adapterFor(github: FakeGitHub, pageSize = 100, maxPages = 10) {
	return new GitHubTicketAdapter({
		exec: github.exec,
		repo,
		paging: { pageSize, maxPages },
	});
}

function events(count: number) {
	return Array.from({ length: count }, (_, i) =>
		labelEvent({
			id: 1000 + i,
			at: `2026-10-29T01:00:${String(i).padStart(2, "0")}Z`,
			actor: "writer",
			label: "documentation",
			event: i % 2 === 0 ? "labeled" : "unlabeled",
		}),
	);
}

function assertScopedCalls(github: FakeGitHub): void {
	for (const call of github.calls) {
		assert.equal(call[0], "gh");
		assert.equal(call[1], "api");
		assert.ok(!call.includes("--paginate"), call.join(" "));

		const path = call.find((arg) => arg.startsWith("repos/")) ?? call[2];

		assert.ok(
			path === "graphql" || path?.startsWith(`repos/${FAKE_REPO}/`),
			call.join(" "),
		);
	}
}

describe("GitHubTicketAdapter timeline paging", () => {
	it("requests numbered pages under repos/<repo>/ and never --paginate", async () => {
		const github = new FakeGitHub();

		github.add(fakeIssue(14, { timeline: events(5) }));

		const read = await adapterFor(github, 2).readTimeline(14);

		assert.equal(read.kind, "ok");
		assert.equal(read.kind === "ok" ? read.value.length : 0, 5);

		assert.deepEqual(
			github.calls.map((call) => call[2]),
			[1, 2, 3].map(
				(page) =>
					`repos/${FAKE_REPO}/issues/14/timeline?per_page=2&page=${page}`,
			),
		);

		assertScopedCalls(github);
	});

	it("reads one empty page past an exactly full last page", async () => {
		const github = new FakeGitHub();

		github.add(fakeIssue(14, { timeline: events(4) }));

		const read = await adapterFor(github, 2).readTimeline(14);

		assert.equal(read.kind === "ok" ? read.value.length : -1, 4);
		assert.equal(github.calls.length, 3);
	});

	it("fails with pagination_limit instead of reading without bound", async () => {
		const github = new FakeGitHub();

		github.add(fakeIssue(14, { timeline: events(7) }));

		const read = await adapterFor(github, 2, 3).readTimeline(14);

		assert.deepEqual(read, {
			kind: "failed",
			failure: { kind: "pagination_limit" },
		});
		assert.equal(github.calls.length, 3);
	});

	it("keeps label events, renames and other entries apart", async () => {
		const github = new FakeGitHub();

		github.add(
			fakeIssue(14, {
				timeline: [
					labelEvent({
						id: 7,
						at: "2026-10-29T01:21:37Z",
						actor: "giuseppecrj",
					}),
					commentEvent(8, "2026-10-29T01:21:48Z"),
					renamedEvent("2026-10-29T01:21:50Z"),
				],
			}),
		);

		const read = await adapterFor(github).readTimeline(14);

		assert.deepEqual(read, {
			kind: "ok",
			value: [
				{
					kind: "labeled",
					id: "7",
					at: "2026-10-29T01:21:37Z",
					actor: { kind: "login", login: "giuseppecrj" },
					label: READY_LABEL,
				},
				{ kind: "other" },
				{ kind: "renamed", at: "2026-10-29T01:21:50Z" },
			],
		});
	});

	it("rejects a label event without an ID or a valid time", async () => {
		const broken: JsonValue[] = [
			{
				event: "labeled",
				created_at: "2026-10-29T01:21:37Z",
				label: { name: "x" },
			},
			{
				event: "labeled",
				id: 9,
				created_at: "yesterday",
				label: { name: "x" },
			},
			{
				event: "labeled",
				id: -1,
				created_at: "2026-10-29T01:21:37Z",
				label: { name: "x" },
			},
			{ event: "labeled", id: 9, created_at: "2026-10-29T01:21:37Z" },
			"not an object",
		];

		for (const entry of broken) {
			const github = new FakeGitHub();

			github.add(fakeIssue(14, { timeline: [entry] }));

			assert.deepEqual(await adapterFor(github).readTimeline(14), {
				kind: "failed",
				failure: { kind: "malformed_response" },
			});
		}
	});
});

describe("GitHubTicketAdapter reads", () => {
	it("maps gh failures to causes and a throwing exec to cannot_run_gh", async () => {
		const github = new FakeGitHub();

		github.add(fakeIssue(14));
		github.failures.set(`repos/${FAKE_REPO}/issues/14`, httpError(403));

		assert.deepEqual(await adapterFor(github).readIssue(14), {
			kind: "failed",
			failure: { kind: "gh_failed", cause: "auth", status: 403 },
		});

		github.failures.set(`repos/${FAKE_REPO}/issues/14`, {
			stdout: "",
			stderr: "error connecting to github.int.exe.xyz\n",
			code: 1,
		});

		assert.deepEqual(await adapterFor(github).readIssue(14), {
			kind: "failed",
			failure: { kind: "gh_failed", cause: "network", status: null },
		});

		const throwing = new GitHubTicketAdapter({
			exec: async () => {
				throw new Error("spawn gh ENOENT");
			},
			repo,
		});

		assert.deepEqual(await throwing.readIssue(14), {
			kind: "failed",
			failure: { kind: "cannot_run_gh" },
		});
	});

	it("treats non-JSON and wrong-typed output as malformed", async () => {
		for (const stdout of ["<html>", "[]", '{"number":"14"}', "null"]) {
			const adapter = new GitHubTicketAdapter({
				exec: async () => ({ stdout, stderr: "", code: 0 }),
				repo,
			});

			assert.deepEqual(await adapter.readIssue(14), {
				kind: "failed",
				failure: { kind: "malformed_response" },
			});
		}
	});

	it("reads the permission of a login, encoding a bot login", async () => {
		const github = new FakeGitHub();
		const adapter = adapterFor(github);

		for (const [login, level] of [
			["giuseppecrj", "admin"],
			["writer", "write"],
			["triager", "read"],
			["exe-dev-github-integration[bot]", "none"],
		] as const) {
			assert.ok(isLogin(login), login);
			assert.deepEqual(await adapter.readPermission(login), {
				kind: "ok",
				value: level,
			});
		}

		assert.ok(
			github.calls.some(
				(call) =>
					call[2] ===
					`repos/${FAKE_REPO}/collaborators/exe-dev-github-integration%5Bbot%5D/permission`,
			),
		);

		assert.deepEqual(await adapter.readPermission(login("ghost-user")), {
			kind: "failed",
			failure: { kind: "gh_failed", cause: "not_found", status: 404 },
		});
	});

	it("rejects a permission answer for another user or an unknown level", async () => {
		for (const answer of [
			{ permission: "admin", user: { login: "someone-else" } },
			{ permission: "superuser", user: { login: "writer" } },
		]) {
			const adapter = new GitHubTicketAdapter({
				exec: async () => ({
					stdout: JSON.stringify(answer),
					stderr: "",
					code: 0,
				}),
				repo,
			});

			assert.deepEqual(await adapter.readPermission(login("writer")), {
				kind: "failed",
				failure: { kind: "malformed_response" },
			});
		}
	});

	it("reads body history through GraphQL variables, not query text", async () => {
		const github = new FakeGitHub();

		github.add(
			fakeIssue(15, {
				body: "v2",
				lastEditedAt: "2026-10-29T01:21:47Z",
				includesCreatedEdit: true,
				versions: [
					{ editedAt: "2026-10-29T01:21:47Z", deletedAt: null, diff: "v2" },
					{ editedAt: "2026-10-29T01:21:21Z", deletedAt: null, diff: "v1" },
				],
			}),
		);

		const read = await adapterFor(github).readBodyHistory(15);

		assert.deepEqual(read, {
			kind: "ok",
			value: {
				title: "Fixture 15",
				body: "v2",
				lastEditedAt: "2026-10-29T01:21:47Z",
				includesCreatedEdit: true,
				totalVersions: 2,
				versions: [
					{ editedAt: "2026-10-29T01:21:47Z", deleted: false, text: "v2" },
					{ editedAt: "2026-10-29T01:21:21Z", deleted: false, text: "v1" },
				],
			},
		});

		const [call] = github.calls;
		const query = call?.find((arg) => arg.startsWith("query=")) ?? "";

		assert.ok(!query.includes("giuseppecrj"));
		assert.ok(!query.includes("15"));
		assert.ok(call?.includes("number=15"));
		assert.ok(call?.includes("owner=giuseppecrj"));
	});

	it("fails body history for a missing issue and a version without diff", async () => {
		const github = new FakeGitHub();

		assert.equal((await adapterFor(github).readBodyHistory(99)).kind, "failed");

		const adapter = new GitHubTicketAdapter({
			exec: async () => ({
				stdout: JSON.stringify({
					data: {
						repository: {
							issue: {
								title: "t",
								body: "b",
								lastEditedAt: null,
								includesCreatedEdit: false,
								userContentEdits: {
									totalCount: 1,
									nodes: [
										{ editedAt: "2026-10-29T01:21:47Z", deletedAt: null },
									],
								},
							},
						},
					},
				}),
				stderr: "",
				code: 0,
			}),
			repo,
		});

		assert.deepEqual(await adapter.readBodyHistory(1), {
			kind: "failed",
			failure: { kind: "malformed_response" },
		});
	});

	it("reads the repository switch label by its encoded name", async () => {
		const github = new FakeGitHub();
		const adapter = adapterFor(github);

		assert.deepEqual(await adapter.readRepoSwitch(), {
			kind: "ok",
			value: { kind: "present", name: "factory:enabled" },
		});
		assert.deepEqual(github.calls, [
			["gh", "api", `repos/${FAKE_REPO}/labels/factory%3Aenabled`],
		]);
	});

	it("returns the stored name of a label that differs in case", async () => {
		const github = new FakeGitHub();

		github.repoLabels = ["Factory:Enabled"];

		assert.deepEqual(await adapterFor(github).readRepoSwitch(), {
			kind: "ok",
			value: { kind: "present", name: "Factory:Enabled" },
		});
	});

	it("reads an absent switch label from HTTP 404", async () => {
		const github = new FakeGitHub();

		github.repoLabels = [];

		assert.deepEqual(await adapterFor(github).readRepoSwitch(), {
			kind: "ok",
			value: { kind: "absent" },
		});
	});

	it("fails the switch read on auth and network errors", async () => {
		const cases = [
			[
				httpError(403, "Resource not accessible by integration"),
				{ kind: "gh_failed", cause: "auth", status: 403 },
			],
			[networkError(), { kind: "gh_failed", cause: "network", status: null }],
		] as const;

		for (const [result, failure] of cases) {
			const github = new FakeGitHub();

			github.failures.set(`repos/${FAKE_REPO}/labels`, result);

			assert.deepEqual(await adapterFor(github).readRepoSwitch(), {
				kind: "failed",
				failure,
			});
		}
	});
});

describe("GitHubTicketAdapter as a TicketReader", () => {
	it("keys refs by repository and provider", () => {
		const ref = adapterFor(new FakeGitHub()).ref(14);

		assert.deepEqual(ref, {
			provider: "github",
			key: `${FAKE_REPO}#14`,
			url: `https://github.com/${FAKE_REPO}/issues/14`,
		});
		assert.equal(ticketKey(ref), `github:${FAKE_REPO}#14`);
	});

	it("normalizes a repository issue event into a ready event with ID and time", () => {
		const adapter = adapterFor(new FakeGitHub());

		const raw = (actor: string, label = READY_LABEL) => ({
			id: 34537521383,
			event: "labeled",
			actor: { login: actor },
			created_at: "2026-10-29T01:21:37Z",
			label: { name: label },
			issue: { number: 14 },
		});

		assert.deepEqual(adapter.normalize(raw("giuseppecrj")), {
			kind: "ready",
			id: "34537521383",
			at: "2026-10-29T01:21:37Z",
			ref: adapter.ref(14),
			actor: "giuseppecrj",
		});

		assert.equal(adapter.normalize(raw("giuseppecrj", "bug")), null);
		assert.equal(adapter.normalize(raw("$(touch /tmp/x)")), null);
		assert.equal(adapter.normalize({ ...raw("writer"), issue: null }), null);
		assert.equal(adapter.normalize(null), null);
		assert.equal(adapter.normalize([raw("writer")]), null);
	});

	it("lists open ready issues without pull requests, paging by number", async () => {
		const github = new FakeGitHub();

		github.add(fakeIssue(14));
		github.add(fakeIssue(15));
		github.add(fakeIssue(16, { pullRequest: true }));
		github.add(fakeIssue(17, { state: "closed" }));
		github.add(fakeIssue(18, { labels: ["bug"] }));

		const tickets = await adapterFor(github, 2).fetchCandidates();

		assert.deepEqual(
			tickets.map((ticket) => ticket.ref.key),
			[`${FAKE_REPO}#14`, `${FAKE_REPO}#15`],
		);
		assert.equal(tickets[0]?.author, "exe-dev-github-integration[bot]");
		assert.ok(
			github.calls.every((call) =>
				call[2]?.startsWith(
					`repos/${FAKE_REPO}/issues?state=open&labels=factory%3Aready&per_page=2&page=`,
				),
			),
		);
	});

	it("reads states keyed by ticketKey and refuses a ref from another repository", async () => {
		const github = new FakeGitHub();
		const adapter = adapterFor(github);

		github.add(fakeIssue(14, { state: "closed", labels: [] }));

		const ref = adapter.ref(14);
		const states = await adapter.fetchStates([ref]);

		assert.deepEqual(states.get(ticketKey(ref)), {
			ref,
			open: false,
			labels: [],
		});

		const foreign = { ...ref, key: "giuseppecrj/other#14" };

		await assert.rejects(adapter.fetchStates([foreign]), /not an issue of/);
		await assert.rejects(adapter.fetch(adapter.ref(99)), GitHubReadError);
	});

	it("admits only write access and never looks up a login outside the grammar", async () => {
		const github = new FakeGitHub();
		const adapter = adapterFor(github);
		const ref = adapter.ref(14);

		assert.equal(await adapter.canAdmit(ref, "writer"), true);
		assert.equal(await adapter.canAdmit(ref, "triager"), false);
		assert.equal(
			await adapter.canAdmit(ref, "exe-dev-github-integration[bot]"),
			false,
		);
		assert.equal(await adapter.canAdmit(ref, "nobody-known"), false);

		const before = github.calls.length;

		for (const hostile of [
			"../../x",
			"a b",
			"-lead",
			"trail-",
			"a--b",
			"x".repeat(40),
			"$(id)",
		]) {
			assert.equal(isLogin(hostile), false, hostile);
			assert.equal(await adapter.canAdmit(ref, hostile), false);
		}

		assert.equal(github.calls.length, before);
	});

	it("keeps hostile issue text as literal data", async () => {
		const github = new FakeGitHub();
		const title = "$(touch /tmp/factory-pwned) `id`; rm -rf ~";

		const body =
			"https://x-access-token:ghp_secret@github.com/a/b\n'; DROP TABLE";

		github.add(fakeIssue(14, { title, body, author: "evil user" }));

		const ticket = await adapterFor(github).fetch(adapterFor(github).ref(14));

		assert.equal(ticket.title, title);
		assert.equal(ticket.body, body);
		assert.equal(ticket.author, "(withheld)");
		assert.equal(actorText({ kind: "withheld" }), "(withheld)");
		assertScopedCalls(github);
	});
});
