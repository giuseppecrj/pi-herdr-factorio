import assert from "node:assert/strict";
import { test } from "node:test";
import {
	mkdtempSync,
	readFileSync,
	readdirSync,
	statSync,
	writeFileSync,
	rmSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	classifyFeedback,
	feedbackId,
	FEEDBACK_CARD_BYTES,
	type FeedbackEvent,
	type FeedbackId,
} from "../src/feedback.ts";
import {
	storeFeedbackBatch,
	observeFeedback,
	sweepMergedFeedback,
} from "../server/controller.ts";
import { GitHubTicketAdapter } from "../src/adapters/github.ts";
import { digestOf } from "../src/run.ts";
import { isGitSha, isRepoSlug } from "../src/workflow.ts";
import {
	FAKE_REPO,
	FakeGitHub,
	fakeIssue,
	BOT_LOGIN,
	httpError,
} from "./fake-ticket-adapter.ts";

const repo = FAKE_REPO;

function sha(value: string) {
	if (!isGitSha(value)) throw new Error("fixture");

	return value;
}

const head = sha("a".repeat(40));

if (!isRepoSlug(repo)) throw new Error("fixture");

const runId = digestOf("feedback run");
const id = (n: number) => feedbackId(repo, "review", n);

function review(
	n = 1,
	change: Partial<Extract<FeedbackEvent, { kind: "review" }>> = {},
): FeedbackEvent {
	return {
		kind: "review",
		id: id(n),
		pr: 5,
		actor: "writer",
		at: "2026-11-07T00:00:00Z",
		state: "CHANGES_REQUESTED",
		commit: head,
		body: "Please fix this",
		comments: [],
		...change,
	};
}

const classify = (
	events: readonly FeedbackEvent[],
	seen: readonly FeedbackId[] = [],
	permission: "write" | "read" | "failed" = "write",
) =>
	classifyFeedback({
		runId,
		pr: 5,
		head,
		events,
		seen,
		permission: async () => permission,
	});

test("feedback identities are provider- and source-qualified", () => {
	for (const source of ["issue-comment", "review", "review-comment"] as const)
		assert.equal(feedbackId(repo, source, 12), `github:${repo}:${source}:12`);
});

test("controller messages are dropped case-insensitively before intake", async () => {
	const result = await classify([
		review(1, { actor: BOT_LOGIN.toUpperCase() }),
	]);

	assert.equal(result.kind, "read");
	assert.equal(result.kind === "read" && result.batch, null);
});

for (const state of [
	"CHANGES_REQUESTED",
	"APPROVED",
	"COMMENTED",
	"DISMISSED",
] as const)
	test(`feedback intake ${state}`, async () => {
		const result = await classify([review(1, { state })]);
		assert.equal(result.kind, "read");
		assert.ok(result.kind === "read" && result.batch);
		assert.deepEqual(
			result.batch.records[0]?.intake,
			state === "CHANGES_REQUESTED"
				? { kind: "actionable" }
				: { kind: "ignored", reason: "not_change_request" },
		);
	});

test("conversation is classified once but cannot request repair", async () => {
	const result = await classify([
		{
			kind: "conversation",
			id: feedbackId(repo, "issue-comment", 1),
			pr: 5,
			actor: "writer",
			at: "2026-11-07T00:00:00Z",
			body: "fix",
		},
	]);

	assert.ok(result.kind === "read" && result.batch);
	assert.deepEqual(result.batch.records[0]?.intake, {
		kind: "ignored",
		reason: "not_change_request",
	});
});

for (const [permission, expected] of [
	["read", "unauthorized"],
	["failed", "unavailable"],
] as const)
	test(`permission ${permission} never grants feedback authority`, async () => {
		const result = await classify([review()], [], permission);

		if (expected === "unavailable")
			assert.deepEqual(result, { kind: "unavailable" });
		else {
			assert.ok(result.kind === "read" && result.batch);
			assert.deepEqual(result.batch.records[0]?.intake, {
				kind: "refused",
				reason: expected,
			});
		}
	});

test("review of a gone head is refused", async () => {
	const result = await classify([review(1, { commit: sha("b".repeat(40)) })]);
	assert.ok(result.kind === "read" && result.batch);
	assert.deepEqual(result.batch.records[0]?.intake, {
		kind: "refused",
		reason: "stale_head",
	});
});

test("held-out inline text and diff hunks never enter cards or full text", async () => {
	const comment = {
		id: feedbackId(repo, "review-comment", 7),
		path: "test/acceptance/42/test.ts",
		line: 1,
		commit: head,
		inReplyTo: null,
		body: "PRIVATE-HELDOUT",
	};

	const withHunk = { ...comment, diff_hunk: "PRIVATE-HUNK" };

	const result = await classify([
		review(1, {
			body: "x".repeat(12000),
			comments: [
				withHunk,
				{
					...comment,
					id: feedbackId(repo, "review-comment", 8),
					path: "src/a.ts",
					body: "public",
				},
			],
		}),
	]);

	assert.ok(result.kind === "read" && result.batch);
	assert.deepEqual(result.batch.records[0]?.inline[0]?.intake, {
		kind: "refused",
		reason: "heldout_path",
	});
	assert.doesNotMatch(
		JSON.stringify(result),
		/PRIVATE-HELDOUT|PRIVATE-HUNK|diff_hunk/,
	);
	assert.ok(
		result.batch.cards.every((c) => !c.path?.startsWith("test/acceptance/")),
	);
});

test("a review with only refused inline text is empty", async () => {
	const result = await classify([
		review(1, {
			body: "",
			comments: [
				{
					id: feedbackId(repo, "review-comment", 7),
					path: "test/acceptance/a",
					line: null,
					commit: head,
					inReplyTo: null,
					body: "private",
				},
			],
		}),
	]);

	assert.ok(result.kind === "read" && result.batch);
	assert.deepEqual(result.batch.records[0]?.intake, {
		kind: "refused",
		reason: "empty",
	});
});

test("seen set admits a lower-id review submitted later and observes dismissals", async () => {
	const result = await classify(
		[review(101, { state: "DISMISSED" }), review(100)],
		[id(101)],
	);

	assert.ok(result.kind === "read" && result.batch);
	assert.deepEqual(
		result.batch.records.map((r) => r.event),
		[id(100)],
	);
	assert.deepEqual(result.dismissed, [id(101)]);
});

test("batch digest and bytes are independent of event read order", async () => {
	assert.deepEqual(
		await classify([review(2), review(1)]),
		await classify([review(1), review(2)]),
	);
});

test("8 KiB cards truncate UTF-8 safely and bind full-text bytes", async () => {
	const result = await classify([review(1, { body: "😀".repeat(8000) })]);
	assert.ok(result.kind === "read" && result.batch && result.full);
	assert.ok(
		Buffer.byteLength(JSON.stringify(result.batch.cards)) <=
			FEEDBACK_CARD_BYTES,
	);
	assert.equal(result.batch.cards[0]?.truncated, true);
	assert.doesNotMatch(result.batch.cards[0]?.excerpt ?? "", /�/);
	assert.deepEqual(result.batch.full, {
		digest: digestOf(result.full),
		bytes: Buffer.byteLength(result.full),
	});
});

test("47 short inline comments overflow durably instead of retrying as unavailable", async () => {
	const result = await classify([
		review(1, {
			body: "",
			comments: Array.from({ length: 47 }, (_, n) => ({
				id: feedbackId(repo, "review-comment", 100000 + n),
				path: "src/a.ts",
				line: 1,
				commit: head,
				inReplyTo: null,
				body: "fix",
			})),
		}),
	]);

	assert.ok(result.kind === "read" && result.batch && result.full);
	assert.partialDeepStrictEqual(result.batch, { overflow: true });
	assert.ok(
		Buffer.byteLength(JSON.stringify(result.batch.cards)) <=
			FEEDBACK_CARD_BYTES,
	);
	assert.deepEqual(result.batch.full, {
		digest: digestOf(result.full),
		bytes: Buffer.byteLength(result.full),
	});
	assert.equal(JSON.parse(result.full).length, 47);
	const root = mkdtempSync(join(tmpdir(), "feedback-"));

	try {
		const stored = await storeFeedbackBatch(root, result.batch, result.full);
		assert.deepEqual(stored.seen, [id(1)]);
		assert.partialDeepStrictEqual(stored, { overflow: true });
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});

for (const path of [
	"Test/Acceptance/secret.ts",
	"test/foo/../acceptance/secret.ts",
	"test/acceptance",
	"test\\\\acceptance\\\\secret.ts",
])
	test(`held-out policy normalization refuses ${path}`, async () => {
		const result = await classify([
			review(1, {
				body: "x".repeat(12000),
				comments: [
					{
						id: feedbackId(repo, "review-comment", 7),
						path,
						line: 1,
						commit: head,
						inReplyTo: null,
						body: "PRIVATE-NORMALIZED",
					},
				],
			}),
		]);

		assert.ok(result.kind === "read" && result.batch);
		assert.deepEqual(result.batch.records[0]?.inline[0]?.intake, {
			kind: "refused",
			reason: "heldout_path",
		});
		assert.doesNotMatch(JSON.stringify(result), /PRIVATE-NORMALIZED/);
	});

test("C1 torn batch and full-text files recover to their content-addressed bytes", async () => {
	const root = mkdtempSync(join(tmpdir(), "feedback-"));

	try {
		const result = await classify([review(1, { body: "long".repeat(4000) })]);
		assert.ok(result.kind === "read" && result.batch && result.full);
		const first = await storeFeedbackBatch(root, result.batch, result.full);
		const dir = join(root, "handoff", runId, "feedback");

		for (const name of readdirSync(dir))
			writeFileSync(join(dir, name), '{"version":');
		assert.deepEqual(
			await storeFeedbackBatch(root, result.batch, result.full),
			first,
		);
		assert.equal(
			digestOf(readFileSync(join(dir, `${first.digest}.json`), "utf8")),
			first.digest,
		);
		assert.equal(
			readFileSync(join(dir, `${result.batch.full!.digest}.full.json`), "utf8"),
			result.full,
		);

		for (const name of readdirSync(dir))
			assert.equal(statSync(join(dir, name)).mode & 0o777, 0o600);
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});

test("C1 batch files are exclusive, private and retryable before cursor commit", async () => {
	const root = mkdtempSync(join(tmpdir(), "feedback-"));

	try {
		const result = await classify([review(1, { body: "long".repeat(4000) })]);
		assert.ok(result.kind === "read" && result.batch && result.full);
		const first = await storeFeedbackBatch(root, result.batch, result.full);
		assert.deepEqual(
			await storeFeedbackBatch(root, result.batch, result.full),
			first,
		);
		const dir = join(root, "handoff", runId, "feedback");
		assert.equal(readdirSync(dir).length, 2);

		for (const name of readdirSync(dir))
			assert.equal(statSync(join(dir, name)).mode & 0o777, 0o600);
		assert.deepEqual(
			JSON.parse(readFileSync(join(dir, `${first.digest}.json`), "utf8")),
			result.batch,
		);
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});

test("C1 a legal multi-review full-text file larger than the acceptance-file cap remains replayable", async () => {
	const root = mkdtempSync(join(tmpdir(), "feedback-"));

	try {
		const result = await classify(
			Array.from({ length: 5 }, (_, n) =>
				review(n + 1, { body: "x".repeat(65000) }),
			),
		);

		assert.ok(result.kind === "read" && result.batch && result.full);
		assert.ok(Buffer.byteLength(result.full) > 256 * 1024);
		const first = await storeFeedbackBatch(root, result.batch, result.full);

		assert.deepEqual(
			await storeFeedbackBatch(root, result.batch, result.full),
			first,
		);
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});

test("C9 a review edit after an uncertain proposal POST reuses the original intent", async () => {
	const github = new FakeGitHub();
	github.pulls.set(5, { merged_at: "2026-11-06T00:00:00Z" });

	const reviews = [
		{
			id: 3,
			state: "COMMENTED",
			commit_id: head,
			body: "original request",
			submitted_at: "2026-11-07T00:00:00Z",
			user: { login: "writer" },
		},
	];

	github.reviews.set(5, reviews);
	github.posts.push("landed_unanswered");
	const root = mkdtempSync(join(tmpdir(), "feedback-"));

	try {
		const input = {
			stateDir: root,
			repo,
			exec: github.exec,
			now: 0,
			landed: [{ runId, pr: 5 }],
		};

		await sweepMergedFeedback(input);
		reviews[0]!.body = "edited after posting";
		await sweepMergedFeedback({ ...input, now: 3_600_001 });

		const cursor = JSON.parse(
			readFileSync(join(root, "feedback-sweep", "5.json"), "utf8"),
		);

		assert.deepEqual(cursor.seen, [id(3)]);
		assert.equal(github.issues.size, 1);
		assert.match(
			[...github.issues.values()][0]?.body ?? "",
			/original request/,
		);
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});

test("head binding defers without reading any feedback source or permission", async () => {
	const github = new FakeGitHub();
	const root = mkdtempSync(join(tmpdir(), "feedback-"));

	try {
		const adapter = new GitHubTicketAdapter({ exec: github.exec, repo });

		for (const [prHead, refHead] of [
			["b".repeat(40), head],
			[head, "b".repeat(40)],
			["b".repeat(40), "b".repeat(40)],
		] as const) {
			assert.deepEqual(
				await observeFeedback({
					stateDir: root,
					adapter,
					runId,
					pr: 5,
					head,
					prHead,
					refHead,
					seen: [],
				}),
				{ kind: "deferred", reason: "head_mismatch" },
			);
		}

		assert.equal(github.calls.length, 0);
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});

test("overflow holds read only known-review dismissals, never classify the overflowing set again", async () => {
	const github = new FakeGitHub();
	github.reviews.set(5, [
		{
			id: 1,
			state: "DISMISSED",
			commit_id: head,
			body: "",
			submitted_at: "2026-11-07T00:00:00Z",
			user: { login: "writer" },
		},
		{
			id: 2,
			state: "CHANGES_REQUESTED",
			commit_id: head,
			body: "new",
			submitted_at: "2026-11-07T00:00:00Z",
			user: { login: "writer" },
		},
	]);
	const root = mkdtempSync(join(tmpdir(), "feedback-"));

	try {
		const input = {
			stateDir: root,
			adapter: new GitHubTicketAdapter({ exec: github.exec, repo }),
			runId,
			pr: 5,
			head,
			prHead: head,
			refHead: head,
			seen: [id(1)],
			held: true,
		};

		for (let n = 0; n < 2; n++)
			assert.deepEqual(await observeFeedback(input), {
				kind: "read",
				head,
				batch: null,
				dismissed: [id(1)],
			});
		assert.equal(github.calls.length, 2);
		assert.deepEqual(readdirSync(root), []);
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});

test("feedback failures retain their source and failure kind without moving the cursor", async () => {
	const github = new FakeGitHub();
	github.add(fakeIssue(5));
	github.reviews.set(5, [
		{
			id: 1,
			state: "CHANGES_REQUESTED",
			commit_id: head,
			body: "fix",
			submitted_at: "2026-11-07T00:00:00Z",
			user: { login: "writer" },
		},
	]);
	const root = mkdtempSync(join(tmpdir(), "feedback-"));

	try {
		for (const [path, reason] of [
			["issues/5/comments", "comments"],
			["pulls/5/reviews", "reviews"],
			["pulls/5/reviews/1/comments", "review_comments"],
			["collaborators/writer/permission", "permission"],
		] as const) {
			github.failures.set(`repos/${repo}/${path}`, httpError(503));
			assert.deepEqual(
				await observeFeedback({
					stateDir: root,
					adapter: new GitHubTicketAdapter({ exec: github.exec, repo }),
					runId,
					pr: 5,
					head,
					prHead: head,
					refHead: head,
					seen: [],
				}),
				{ kind: "unavailable", reason, failure: "gh_failed" },
			);
			assert.deepEqual(readdirSync(root), []);
			github.failures.clear();
		}

		github.reviewComments.set("5/1", [{ invalid: true }]);
		assert.deepEqual(
			await observeFeedback({
				stateDir: root,
				adapter: new GitHubTicketAdapter({ exec: github.exec, repo }),
				runId,
				pr: 5,
				head,
				prHead: head,
				refHead: head,
				seen: [],
			}),
			{
				kind: "unavailable",
				reason: "review_comments",
				failure: "malformed_response",
			},
		);
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});

test("feedback transport failures are unavailable without files or cursor", async () => {
	const github = new FakeGitHub();
	github.add(fakeIssue(5));
	github.failures.set(`repos/${repo}/pulls/5/reviews`, httpError(503));
	const root = mkdtempSync(join(tmpdir(), "feedback-"));

	try {
		assert.deepEqual(
			await observeFeedback({
				stateDir: root,
				adapter: new GitHubTicketAdapter({ exec: github.exec, repo }),
				runId,
				pr: 5,
				head,
				prHead: head,
				refHead: head,
				seen: [],
			}),
			{ kind: "unavailable", reason: "reviews", failure: "gh_failed" },
		);
		assert.deepEqual(readdirSync(root), []);
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});

test("C9 merged sweep deduplicates after an issue POST lost its response", async () => {
	const github = new FakeGitHub();
	github.add(fakeIssue(5, { pullRequest: true }));
	github.pulls.set(5, {
		merged_at: "2026-11-06T00:00:00Z",
		head: { sha: head },
	});
	github.reviews.set(5, [
		{
			id: 1,
			state: "COMMENTED",
			commit_id: head,
			body: "before",
			submitted_at: "2026-11-05T00:00:00Z",
			user: { login: "writer" },
		},
		{
			id: 2,
			state: "COMMENTED",
			commit_id: head,
			body: "",
			submitted_at: "2026-11-07T00:00:00Z",
			user: { login: "writer" },
		},
		{
			id: 3,
			state: "APPROVED",
			commit_id: head,
			body: "follow up @owner other/repo#1",
			submitted_at: "2026-11-07T00:00:00Z",
			user: { login: "writer" },
		},
	]);
	github.comment(
		github.issues.get(5)!,
		"conversation must not create a proposal",
		{ login: "writer", type: "User" },
	);
	github.posts.push("landed_unanswered");
	const root = mkdtempSync(join(tmpdir(), "feedback-"));

	try {
		const input = {
			stateDir: root,
			repo,
			exec: github.exec,
			now: 0,
			landed: [{ runId, pr: 5 }],
		};

		await sweepMergedFeedback(input);
		await sweepMergedFeedback({ ...input, now: 3_600_001 });
		await sweepMergedFeedback({ ...input, now: 7_200_002 });

		const proposals = [...github.issues.values()].filter((i) =>
			i.labels.includes("factory:proposed"),
		);

		assert.equal(proposals.length, 1);
		assert.ok(!proposals[0]?.labels.includes("factory:ready"));
		assert.doesNotMatch(proposals[0]?.body ?? "", /@owner|other\/repo#1/);
		proposals[0]!.state = "closed";
		await sweepMergedFeedback({ ...input, now: 10_800_003 });
		assert.equal(
			[...github.issues.values()].filter((i) =>
				i.labels.includes("factory:proposed"),
			).length,
			1,
		);
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});
