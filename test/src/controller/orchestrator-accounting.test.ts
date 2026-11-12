import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import {
	mkdirSync,
	symlinkSync,
	readFileSync,
	statSync,
	writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { describe, it } from "node:test";
import { EXIT } from "../../../host/cli/platform.ts";
import { fileRunFiles } from "../../../host/controller/run-files.ts";
import { pinVerification } from "../../../host/controller/state.ts";
import type { ClaimRecord } from "../../../src/controller/claims.ts";
import { contextPolicy } from "../../../src/ledger/schema.ts";
import { digestOf } from "../../../src/core/run.ts";
import { type GitSha } from "../../../src/config/schema.ts";
import { type RepoSlug } from "../../../src/trust/platform.ts";
import {
	FakeGitHub,
	MAIN_SHA,
	TRUSTED_RUN_CAP,
	TRUSTED_WORKFLOW,
} from "../../fake-ticket-adapter.ts";
import { EXE_DEV_PLATFORM } from "../../../src/trust/platform.ts";
import {
	slug,
	sha,
	repo,
	START,
	labeled,
	runOf,
	world,
	statuses,
	stateDir,
	cli,
	blockedClaim,
} from "./orchestrator-fixtures.ts";

describe("admission accounting policy", () => {
	for (const verification of [false, true])
		it(`recovers the admitted cap after workflow drift before policy pinning (${verification ? "verification" : "production"})`, async () => {
			const state = stateDir();
			const archive = stateDir();
			const tree = join(archive, "repo", ".github", "factory");
			mkdirSync(join(tree, "gates"), { recursive: true });
			writeFileSync(join(tree, "WORKFLOW.md"), TRUSTED_WORKFLOW);
			writeFileSync(join(tree, "gates", "ci.sh"), "echo trusted\n");
			const bytes = execFileSync("tar", ["-czf", "-", "-C", archive, "repo"]);
			const github = new FakeGitHub();
			github.add(labeled(14));
			let available = false;

			const policySource = {
				fetch: async (requestedRepo: RepoSlug, requestedSha: GitSha) => {
					assert.equal(requestedRepo, repo);
					assert.equal(requestedSha, MAIN_SHA);

					if (!available) throw new Error("checkout unavailable before pin");

					return bytes;
				},
			};

			const argv = [
				"tick",
				"--once",
				"--json",
				"--repo",
				repo,
				"--state-dir",
				state,
				"--issue",
				"14",
				...(verification ? ["--verification-token-cap", "12000"] : []),
			];

			const first = await cli(
				argv,
				github,
				new AbortController(),
				undefined,
				policySource,
			);

			assert.equal(first.code, EXIT.ok, first.stderr);
			const files = fileRunFiles(state);
			assert.equal(await files.accounting?.start(runOf(14)), null);
			assert.deepEqual(await files.listClaims(), []);
			assert.deepEqual(statuses(github, 14), []);

			available = true;
			github.workflow = TRUSTED_WORKFLOW.replace(
				`max_tokens_per_run: ${TRUSTED_RUN_CAP}`,
				`max_tokens_per_run: ${TRUSTED_RUN_CAP + 400_000}`,
			);

			const recovered = await cli(
				argv,
				github,
				new AbortController(),
				undefined,
				policySource,
			);

			assert.equal(recovered.code, EXIT.ok, recovered.stderr);
			const pinned = await files.accounting?.start(runOf(14));
			assert.ok(pinned);
			assert.partialDeepStrictEqual(pinned.context, {
				kind: verification ? "verification" : "production",
				policy: {
					workflowSha: MAIN_SHA,
					workflowDigest: digestOf(TRUSTED_WORKFLOW),
				},
				trustedCap: TRUSTED_RUN_CAP,
			});

			if (verification)
				assert.partialDeepStrictEqual(pinned.context, { effectiveCap: 12_000 });
			assert.equal((await files.listClaims()).length, 1);

			const before = readFileSync(
				join(state, "accounting", runOf(14), "policy.json"),
			);

			await cli(argv, github, new AbortController(), undefined, policySource);
			assert.ok(
				readFileSync(
					join(state, "accounting", runOf(14), "policy.json"),
				).equals(before),
			);

			const issue = github.issues.get(14);
			assert.ok(issue);
			issue.state = "closed";
			issue.updatedAt = "2026-10-29T03:00:00Z";
			await cli(argv, github, new AbortController(), undefined, policySource);

			const terminal = JSON.parse(
				readFileSync(join(state, "ledger", runOf(14), "terminal.json"), "utf8"),
			);

			assert.deepEqual(terminal.runContext, pinned.context);
			assert.equal(
				terminal.provenance.kind,
				verification ? "verification" : "production",
			);

			if (verification) {
				assert.equal(terminal.provenance.trustedRunTokenCap, TRUSTED_RUN_CAP);
				assert.equal(terminal.provenance.effectiveRunTokenCap, 12_000);
			}
		});

	it("pins policy bytes from the original SHA once, caches its gates and retains start time across restart", async () => {
		const dir = stateDir();
		const archive = stateDir();
		const tree = join(archive, "repo", ".github", "factory");
		mkdirSync(join(tree, "gates"), { recursive: true });
		writeFileSync(join(tree, "WORKFLOW.md"), TRUSTED_WORKFLOW);
		writeFileSync(join(tree, "gates", "ci.sh"), "echo trusted\n");
		const bytes = execFileSync("tar", ["-czf", "-", "-C", archive, "repo"]);
		let fetched = 0;

		const files = fileRunFiles(dir, {
			platform: EXE_DEV_PLATFORM,
			fetch: async (requestedRepo, requestedSha) => {
				assert.equal(requestedRepo, repo);
				assert.equal(requestedSha, MAIN_SHA);
				fetched++;

				return bytes;
			},
		});

		const input = {
			runId: runOf(14),
			repo,
			workflowSha: sha(MAIN_SHA),
			workflowDigest: digestOf(TRUSTED_WORKFLOW),
			startedAt: new Date(START).toISOString(),
			runTokenCap: TRUSTED_RUN_CAP,
		};

		assert.equal(await files.prepareRun?.(input), true);
		const pinned = await files.accounting?.start(input.runId);
		assert.ok(pinned);
		assert.equal(pinned.v, 2);
		assert.equal(pinned.context.kind, "production");
		const policy = contextPolicy(pinned.context);

		assert.ok(policy);
		assert.equal(policy.gates.kind, "known");
		assert.deepEqual(pinned.context, {
			kind: "production",
			policy,
			trustedCap: TRUSTED_RUN_CAP,
		});
		assert.equal(
			statSync(join(dir, "accounting", input.runId, "policy.json")).mode &
				0o777,
			0o600,
		);
		assert.equal(
			await files.prepareRun?.({
				...input,
				runId: runOf(15),
				runTokenCap: TRUSTED_RUN_CAP + 400_000,
			}),
			true,
		);
		assert.equal(
			await files.prepareRun?.({
				...input,
				runId: runOf(17),
				runTokenCap: null,
			}),
			true,
		);
		assert.deepEqual(
			(await files.accounting?.start(runOf(15)))?.context,
			pinned.context,
		);
		const unknown = await files.accounting?.start(runOf(17));
		assert.ok(unknown);
		assert.deepEqual(unknown.context, {
			kind: "production",
			policy,
			trustedCap: TRUSTED_RUN_CAP,
		});
		assert.equal(fetched, 1);
		assert.equal(
			await files.accounting?.begin({
				...pinned,
				runId: runOf(16),
				context: {
					...pinned.context,
					policy: {
						...policy,
						gates: {
							kind: "known",
							value: {
								sourceSha: sha("f".repeat(40)),
								digest: digestOf("gates"),
							},
						},
					},
				},
			}),
			false,
		);
		assert.equal(
			await files.accounting?.begin({
				...pinned,
				runId: runOf(16),
				context: {
					...pinned.context,
					policy: {
						...policy,
						autonomy: { ...policy.autonomy, digest: digestOf("not autonomy") },
					},
				},
			}),
			false,
		);

		const restarted = fileRunFiles(dir, {
			platform: EXE_DEV_PLATFORM,
			fetch: async () => {
				throw new Error("must not fetch");
			},
		});

		assert.equal(
			await restarted.prepareRun?.({
				...input,
				startedAt: new Date(START + 1000).toISOString(),
			}),
			true,
		);
		assert.deepEqual(await restarted.accounting?.start(input.runId), pinned);
		assert.equal(
			await restarted.prepareRun?.({
				...input,
				workflowDigest: digestOf("different"),
			}),
			false,
		);
		assert.equal(
			await restarted.accounting?.begin({
				...pinned,
				startedAt: new Date(START + 1000).toISOString(),
			}),
			false,
		);
		assert.equal(
			await files.prepareRun?.({
				...input,
				runId: runOf(16),
				workflowDigest: digestOf("different"),
			}),
			false,
		);
		symlinkSync("ci.sh", join(tree, "gates", "omitted-link"));
		const partial = execFileSync("tar", ["-czf", "-", "-C", archive, "repo"]);

		const refused = fileRunFiles(stateDir(), {
			platform: EXE_DEV_PLATFORM,
			fetch: async () => partial,
		});

		assert.equal(await refused.prepareRun?.(input), false);
		assert.equal(await refused.accounting?.start(input.runId), null);
	});

	for (const workflow of [
		null,
		TRUSTED_WORKFLOW.replace(
			`max_tokens_per_run: ${TRUSTED_RUN_CAP}`,
			"max_tokens_per_run: 1",
		),
	])
		it(`refuses to pin a cap from ${workflow === null ? "missing" : "digest-mismatched"} admitted workflow bytes`, async () => {
			const dir = stateDir();
			const archive = stateDir();
			const tree = join(archive, "repo", ".github", "factory");
			mkdirSync(join(tree, "gates"), { recursive: true });
			writeFileSync(join(tree, "gates", "ci.sh"), "echo trusted\n");

			if (workflow !== null) writeFileSync(join(tree, "WORKFLOW.md"), workflow);

			const bytes = execFileSync("tar", ["-czf", "-", "-C", archive, "repo"]);

			const files = fileRunFiles(dir, {
				platform: EXE_DEV_PLATFORM,
				fetch: async () => bytes,
			});

			assert.equal(
				await files.prepareRun?.({
					runId: runOf(14),
					repo,
					workflowSha: sha(MAIN_SHA),
					workflowDigest: digestOf(TRUSTED_WORKFLOW),
					startedAt: new Date(START).toISOString(),
					runTokenCap: TRUSTED_RUN_CAP,
				}),
				false,
			);
			assert.equal(await files.accounting?.start(runOf(14)), null);
		});

	it("pins the verification manifest and caps at admission and refuses mixed manifests or scope", async () => {
		const dir = stateDir();
		const archive = stateDir();
		const tree = join(archive, "repo", ".github", "factory");
		mkdirSync(join(tree, "gates"), { recursive: true });
		writeFileSync(join(tree, "WORKFLOW.md"), TRUSTED_WORKFLOW);
		writeFileSync(join(tree, "gates", "ci.sh"), "echo trusted\n");
		const bytes = execFileSync("tar", ["-czf", "-", "-C", archive, "repo"]);
		const wanted = { repo, issues: [14], tokenCap: 12_000 };
		const manifest = await pinVerification(dir, wanted);
		assert.ok(manifest.kind === "pinned");

		const files = fileRunFiles(dir, {
			platform: EXE_DEV_PLATFORM,
			fetch: async () => bytes,
		});

		const input = {
			runId: runOf(14),
			repo,
			workflowSha: sha(MAIN_SHA),
			workflowDigest: digestOf(TRUSTED_WORKFLOW),
			startedAt: new Date(START).toISOString(),
			runTokenCap: TRUSTED_RUN_CAP,
		};

		assert.equal(await files.prepareRun?.(input), true);
		const pinned = await files.accounting?.start(input.runId);
		assert.ok(pinned);
		assert.deepEqual(pinned.context, {
			kind: "verification",
			policy: contextPolicy(pinned.context),
			trustedCap: TRUSTED_RUN_CAP,
			manifestDigest: manifest.digest,
			effectiveCap: 12_000,
		});

		const before = readFileSync(
			join(dir, "accounting", input.runId, "policy.json"),
		);

		assert.deepEqual(await pinVerification(dir, null), {
			kind: "refused",
			reason: "verification_state",
		});

		for (const mixed of [
			{ ...wanted, issues: [15] },
			{ ...wanted, tokenCap: 13_000 },
			{ ...wanted, repo: slug("other/repo") },
		])
			assert.deepEqual(await pinVerification(dir, mixed), {
				kind: "refused",
				reason: "verification_manifest_mismatch",
			});
		assert.equal(
			await files.prepareRun?.({ ...input, repo: slug("other/repo") }),
			false,
		);
		assert.equal(
			await files.prepareRun?.({
				...input,
				startedAt: new Date(START + 1_000).toISOString(),
			}),
			true,
		);
		assert.ok(
			readFileSync(join(dir, "accounting", input.runId, "policy.json")).equals(
				before,
			),
		);
		assert.deepEqual(
			(await fileRunFiles(dir).accounting?.start(input.runId))?.context,
			pinned.context,
		);
	});

	it("defers the first claim until its original workflow and gate policy are durably pinned", async () => {
		const f = world();
		f.github.add(labeled(14));
		let ready = false;
		const calls: string[] = [];
		f.files.prepareRun = async (input) => {
			assert.equal(input.workflowSha, MAIN_SHA);
			assert.equal(input.runId, runOf(14));
			assert.equal(f.files.claims.size, 0);
			calls.push(input.startedAt);

			return ready;
		};

		const controller = f.start();
		await controller.tick();
		assert.equal(f.files.claims.size, 0);
		assert.equal(f.executor.launches.length, 0);
		assert.deepEqual(statuses(f.github, 14), []);
		ready = true;
		await controller.tick();
		assert.equal(f.files.claims.size, 1);
		assert.equal(calls.length, 2);
	});
});

describe("durable attempt ends", () => {
	it("writes each disposition once, rejects conflicting bytes and distinguishes corrupt from absent", async () => {
		const state = stateDir();
		const accounting = fileRunFiles(state).accounting!;

		const dispositions = [
			"completed",
			"model_failure",
			"interrupted",
			"refused",
			"budget_stop",
			"aborted",
		] as const;

		for (const [index, disposition] of dispositions.entries()) {
			const attempt = index + 1;

			const record = {
				v: 1 as const,
				runId: runOf(14),
				stage: "specify" as const,
				round: 0,
				attempt,
				disposition,
				usage: 37,
				next: { kind: "end" as const, status: "failed" as const },
			};

			assert.equal(await accounting.writeAttempt(record), true);
			assert.equal(await accounting.writeAttempt(record), true);
			assert.equal(
				await accounting.writeAttempt({ ...record, usage: 99 }),
				false,
			);
			assert.deepEqual(
				await accounting.readAttempt(runOf(14), "specify", 0, attempt),
				record,
			);
		}

		assert.equal((await accounting.attempts(runOf(14)))?.length, 6);
		assert.equal(
			await accounting.readAttempt(runOf(14), "specify", 0, 7),
			null,
		);

		const path = join(
			state,
			"accounting",
			runOf(14),
			"attempts",
			"specify-r0-1.json",
		);

		assert.equal(statSync(path).mode & 0o777, 0o600);
		writeFileSync(path, "{");
		assert.equal(
			await accounting.readAttempt(runOf(14), "specify", 0, 1),
			undefined,
		);
		assert.equal(await accounting.attempts(runOf(14)), null);
	});
});

describe("fileRunFiles", () => {
	it("creates private workspaces and round-trips claim records", async () => {
		const state = stateDir();
		const files = fileRunFiles(state);
		const runId = runOf(14);

		const unconfirmed: ClaimRecord = {
			runId,
			issue: 14,
			eventId: "5",
			seq: null,
			status: null,
			stage: null,
			attempt: null,
			usage: null,
		};

		assert.equal(await files.workspaceState(runId), "missing");
		assert.equal(await files.ensureWorkspace(runId), "created");
		assert.equal(await files.ensureWorkspace(runId), "present");
		assert.ok(await files.writeClaim(unconfirmed));
		assert.deepEqual(await files.listClaims(), [unconfirmed]);

		writeFileSync(join(state, "claims", "junk.json"), "{}");
		assert.equal((await files.listClaims()).length, 1);
	});

	it("loads a record without a status as unknown, and rejects a partial or invalid one", async () => {
		const state = stateDir();
		const files = fileRunFiles(state);
		const runId = runOf(14);
		const path = join(state, "claims", `${runId}.json`);
		const confirmed = { ...blockedClaim(14, 3), eventId: "5" };

		assert.ok(await files.writeClaim(confirmed));
		assert.deepEqual(await files.listClaims(), [confirmed]);

		const load = async (record: Record<string, string | number | null>) => {
			writeFileSync(path, `${JSON.stringify(record)}\n`);

			return files.listClaims();
		};

		const base = { runId, issue: 14, eventId: "5" };
		const unknown = { status: null, stage: null, attempt: null, usage: null };
		const mirrored = { status: "blocked", stage: "specify", attempt: 1 };

		assert.deepEqual(await load({ ...base, seq: 3 }), [
			{ ...base, seq: 3, ...unknown },
		]);
		assert.deepEqual(await load({ ...base, seq: 3, ...mirrored }), [
			{ ...base, seq: 3, ...mirrored, usage: null },
		]);
		assert.deepEqual(
			await load({ ...base, seq: 3, ...mirrored, usage: 300_000 }),
			[{ ...base, seq: 3, ...mirrored, usage: 300_000 }],
		);
		assert.deepEqual(
			await load({
				...base,
				seq: 3,
				...mirrored,
				status: "released",
				usage: 0,
			}),
			[{ ...base, seq: 3, ...mirrored, status: "released", usage: 0 }],
		);
		assert.deepEqual(
			await load({ ...base, seq: 3, ...mirrored, usage: -1 }),
			[],
		);
		assert.deepEqual(
			await load({ ...base, seq: 3, ...mirrored, usage: 1.5 }),
			[],
		);
		assert.deepEqual(await load({ ...base, seq: 3, usage: 5 }), []);
		assert.deepEqual(await load({ ...base, seq: null, usage: 0 }), []);
		assert.deepEqual(await load(base), [{ ...base, seq: null, ...unknown }]);
		assert.deepEqual(await load({ ...base, seq: 0 }), []);
		assert.deepEqual(await load({ ...base, seq: 3, status: "blocked" }), []);
		assert.deepEqual(
			await load({
				...base,
				seq: 3,
				status: "paused",
				stage: "specify",
				attempt: 1,
			}),
			[],
		);
		assert.deepEqual(
			await load({
				...base,
				seq: null,
				status: "blocked",
				stage: "specify",
				attempt: 1,
			}),
			[],
		);
	});
});
