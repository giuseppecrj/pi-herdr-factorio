import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { execFileSync, spawnSync } from "node:child_process";
import {
	mkdtempSync,
	mkdirSync,
	cpSync,
	readFileSync,
	writeFileSync,
	rmSync,
	existsSync,
	symlinkSync,
	lstatSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, describe, it } from "node:test";
import {
	GitHubPublicationApi,
	deriveOwnerPatch,
	readOwnerPatch,
	ownerPatchPath,
	candidateBranch,
	publishCandidate,
	gitObjectSha,
	BOT_EMAIL,
} from "../src/github/publish.ts";
import {
	LEDGER_FILE,
	createLedgerChild,
	createLedgerRoot,
	readLedgerCommit,
	readLedgerFile,
	advanceLedger,
	ledgerRef,
} from "../src/ledger/git.ts";
import { digestOf, REQUIRED_CI_CHECKS } from "../src/core/run.ts";
import { type Exec, type ExecResult } from "../src/github/exec.ts";
import {
	fieldOf,
	objectOf,
	parseJson,
	textOf,
	arrayOf,
	type JsonValue,
} from "../src/core/json.ts";
import { isGitSha, isRepoSlug, type GitSha } from "../src/workflow.ts";
import {
	type Contract,
	contractBytes,
	contractDigestOf,
} from "../src/specify.ts";
import { type AcceptanceSuite } from "../src/contract/acceptance.ts";
import { fileArtifacts } from "../src/contract/artifacts.ts";
import {
	collectPatch,
	storePatch,
	finishPatch,
	prepareRepairTree,
	publicationTree,
} from "../src/candidate/build.ts";
import {
	controllerValidator,
	sweepValidation,
	fileRunFiles,
	downloadGateReceipt,
} from "../server/controller.ts";
import {
	type ValidationState,
	readFeedbackBytes,
	feedbackBytes,
} from "../src/candidate/validation.ts";
import { baseTreeDigest, replacementDigest } from "../server/gates.ts";
import { CONTROLLER_LOGIN } from "../src/trust/markers.ts";
import { LedgerGit } from "./ledger-git.ts";
import {
	withLocalArtifactDownload,
	preparedReviewFixture,
	storedAssessment,
} from "./helpers.ts";
import { classifyFeedback } from "../src/candidate/feedback.ts";
import { storeFeedbackBatch } from "../server/controller.ts";
import { sandboxExecutor } from "../server/sandbox.ts";
import { EXE_DEV_PLATFORM } from "../src/trust/platform.ts";

const repo = "giuseppecrj/pi-herdr-factorio";
const baseSha = "a".repeat(40);

if (!isRepoSlug(repo) || !isGitSha(baseSha)) throw new Error("fixture");

const identity = { repo, baseSha };
const runId = digestOf("publication-run");
const roots: string[] = [];

const fresh = () => {
	const dir = mkdtempSync(join(tmpdir(), "factory-publish-"));
	roots.push(dir);

	return dir;
};

after(() => {
	for (const dir of roots) rmSync(dir, { recursive: true, force: true });
});

describe("F10-3 owner derivation", () => {
	async function derive(
		options: {
			status?: string;
			forbidden?: boolean;
			heldout?: boolean;
			truncated?: boolean;
			large?: boolean;
			omitted?: boolean;
			symlink?: boolean;
		} = {},
	) {
		assert.ok(isRepoSlug(repo) && isGitSha(baseSha));
		const stateDir = fresh();
		const head = "b".repeat(40);
		assert.ok(isGitSha(head));

		const suite = [
			{
				path: "test/acceptance/42/checks/a.ts",
				mode: "100644" as const,
				bytes: Buffer.from("PRIVATE-SUITE\n"),
			},
		];

		const source = options.forbidden ? ".github/evil.yml" : "src/a.ts";
		const content = options.large ? "a".repeat(20_000) : "owner\n";

		const base = [
			{
				path: source,
				type: "blob",
				mode: "100644",
				sha: gitObjectSha("blob", Buffer.from("base\n")),
			},
		];

		if (options.symlink)
			base.push({
				path: "test/acceptance/link.ts",
				type: "blob",
				mode: "120000",
				sha: gitObjectSha("blob", Buffer.from("./existing.ts")),
			});

		const owner = [
			...base.slice(1),
			{ ...base[0], sha: gitObjectSha("blob", Buffer.from(content)) },
			{
				path: suite[0]!.path,
				type: "blob",
				mode: "100644",
				sha: gitObjectSha(
					"blob",
					Buffer.from(options.heldout ? "TAMPER" : "PRIVATE-SUITE\n"),
				),
			},
		];

		const api = new GitHubPublicationApi(
			async (_command, args) => {
				assert.ok(!args.includes("POST") && !args.includes("PATCH"));
				const path = args.at(-1)!;

				const value = path.includes("compare/")
					? { status: options.status ?? "ahead" }
					: {
							truncated: options.truncated ?? false,
							tree: path.includes(head) ? owner : base,
						};

				return { code: 0, stdout: JSON.stringify(value), stderr: "" };
			},
			repo,
			EXE_DEV_PLATFORM,
		);

		const input = {
			stateDir,
			runId,
			head,
			baseSha,
			contractDigest: digestOf("contract"),
			acceptanceDigest: digestOf("acceptance"),
			heldoutDigest: digestOf("heldout"),
			suite,
			checkout: async (sha: GitSha, workspace: string) => {
				mkdirSync(join(workspace, source, ".."), { recursive: true });
				writeFileSync(
					join(workspace, source),
					sha === head ? content : "base\n",
				);

				if (sha === head) {
					mkdirSync(join(workspace, "test/acceptance/42/checks"), {
						recursive: true,
					});
					writeFileSync(join(workspace, suite[0]!.path), "PRIVATE-SUITE\n");
				}

				if (options.symlink) {
					mkdirSync(join(workspace, "test/acceptance"), { recursive: true });
					symlinkSync(
						"./existing.ts",
						join(workspace, "test/acceptance/link.ts"),
					);
				}

				return !options.omitted;
			},
		};

		return { result: await deriveOwnerPatch(api, input), input, api };
	}

	it("strips heldout at tree level, persists private bytes and adopts C8 replay", async () => {
		const f = await derive();
		assert.equal(f.result.kind, "found");

		const read = readOwnerPatch(
			f.input.stateDir,
			runId,
			f.input.head,
			f.input.baseSha,
		);

		assert.ok(read);
		assert.doesNotMatch(read.patch, /PRIVATE-SUITE|test\/acceptance/);
		assert.deepEqual(read.receipt.changedPaths, ["src/a.ts"]);
		assert.deepEqual(await deriveOwnerPatch(f.api, f.input), f.result);
	});

	it("adopts a legacy head-only file only on its recorded base", async () => {
		const f = await derive();

		const keyed = ownerPatchPath(
			f.input.stateDir,
			runId,
			f.input.head,
			f.input.baseSha,
		);

		const legacy = ownerPatchPath(f.input.stateDir, runId, f.input.head);
		cpSync(keyed, legacy);
		rmSync(keyed);
		assert.deepEqual(await deriveOwnerPatch(f.api, f.input), f.result);

		const baseSha = "c".repeat(40);
		assert.ok(isGitSha(baseSha));
		assert.equal(
			readOwnerPatch(f.input.stateDir, runId, f.input.head, baseSha),
			null,
		);
		assert.equal(
			(await deriveOwnerPatch(f.api, { ...f.input, baseSha })).kind,
			"found",
		);
		assert.deepEqual(await deriveOwnerPatch(f.api, f.input), f.result);
	});

	it("preserves base acceptance symlink bytes when stripping the suite (review R6)", async () => {
		const f = await derive({ symlink: true });
		assert.equal(f.result.kind, "found");
	});

	it("recertifies a stored head on a new base without losing either patch (review R4)", async () => {
		const f = await derive();
		assert.equal(f.result.kind, "found");

		const baseSha = "c".repeat(40);
		assert.ok(isGitSha(baseSha));
		const result = await deriveOwnerPatch(f.api, { ...f.input, baseSha });
		assert.equal(result.kind, "found");

		if (result.kind === "found") assert.equal(result.patch.baseSha, baseSha);
		assert.equal(
			readOwnerPatch(f.input.stateDir, runId, f.input.head, baseSha)?.receipt
				.baseSha,
			baseSha,
		);
		assert.equal(
			readOwnerPatch(f.input.stateDir, runId, f.input.head, f.input.baseSha)
				?.receipt.baseSha,
			f.input.baseSha,
		);
		assert.deepEqual(await deriveOwnerPatch(f.api, f.input), f.result);
	});

	for (const [options, reason] of [
		[{ heldout: true }, "heldout_changed"],
		[{ forbidden: true }, "forbidden_path"],
		[{ status: "behind" }, "behind_main"],
		[{ status: "diverged" }, "behind_main"],
		[{ status: "identical" }, "behind_main"],
		[{ truncated: true }, "unreadable"],
		[{ omitted: true }, "unreadable"],
		[{ large: true }, "too_large"],
	] as const)
		it(`refuses ${JSON.stringify(options)} as ${reason}`, async () => {
			assert.deepEqual((await derive(options)).result, {
				kind: "refused",
				reason,
			});
		});
});

it("F10-2 feedback checkout binds batch, full text and passed or candidate assessment", async () => {
	const f = await preparedReviewFixture();

	try {
		const { pin } = f.book;
		const head = f.book.current.verdict!.candidateSha;
		assert.ok(isGitSha(head));

		const classified = await classifyFeedback({
			controllerLogin: EXE_DEV_PLATFORM.controllerLogin,
			runId: pin.runId,
			pr: 5,
			head,
			seen: [],
			permission: async () => "write",
			events: [
				{
					kind: "review",
					id: `github:${pin.repo}:review:1`,
					pr: 5,
					actor: "writer",
					at: "2026-11-07T00:00:00Z",
					state: "CHANGES_REQUESTED",
					commit: head,
					body: "fix this ".repeat(3000),
					comments: [],
				},
			],
		});

		assert.ok(
			classified.kind === "read" && classified.batch && classified.full,
		);

		const batch = await storeFeedbackBatch(
			f.state,
			classified.batch,
			classified.full,
		);

		for (const candidate of [false, true]) {
			const assessment = storedAssessment({
				runId: pin.runId,
				round: 0,
				generation: 0,
				verdict: f.book.current.verdict!,
				assessment: candidate
					? {
							kind: "failed",
							failure: {
								kind: "candidate",
								reason: "candidate_heldout",
								scenarios: ["S1"],
							},
						}
					: { kind: "passed" },
			});

			const dir = join(f.state, "validation", pin.runId);
			writeFileSync(join(dir, "assessment.json"), assessment.text, {
				mode: 0o600,
			});

			if (candidate)
				writeFileSync(
					join(dir, "feedback.json"),
					feedbackBytes(assessment.read.ref, [
						{ scenario: "S1", criteria: [{ id: "A1", text: "Value is one" }] },
					]),
					{ mode: 0o600 },
				);
			const workspace = join(f.root, `feedback-${candidate}`);

			const input = {
				runId: pin.runId,
				repo: pin.repo,
				sha: pin.originalBase,
				workspace,
				build: true,
				round: 1,
				feedbackFrom: f.book.current.intent,
				cause: {
					kind: "feedback" as const,
					batch: batch.digest,
					assessment: assessment.read.ref,
					review: null,
				},
			};

			const checked = await f.executor.checkout(input);
			assert.equal(checked.kind, "ready", JSON.stringify(checked));

			const data = JSON.parse(
				readFileSync(join(workspace, ".factory-feedback.json"), "utf8"),
			);

			assert.equal(data.version, 2);
			assert.deepEqual(data.owner, classified.batch.cards);
			assert.equal(data.truncated, true);
			assert.deepEqual(data.full, classified.batch.full);
			assert.equal(
				readFileSync(join(workspace, ".factory-feedback-full.json"), "utf8"),
				classified.full,
			);
			assert.equal(
				lstatSync(join(workspace, ".factory-feedback-full.json")).mode & 0o777,
				0o600,
			);
			assert.deepEqual(
				await f.executor.checkout({
					...input,
					workspace: `${workspace}-bad`,
					cause: { ...input.cause, batch: digestOf("mismatch") },
				}),
				{ kind: "refused", reason: "repair_inputs_invalid" },
			);
		}
	} finally {
		f.close();
	}
});

it("F10-2 missing previous patch is patch_missing, not no progress", async () => {
	const f = await preparedReviewFixture();

	try {
		const binding = {
			runId: f.book.pin.runId,
			baseSha: f.book.pin.originalBase,
			contractDigest: f.book.pin.contractDigest,
			acceptanceDigest: f.book.pin.acceptanceDigest,
			round: 1,
		};

		storePatch(
			f.state,
			binding,
			{
				kind: "collected",
				patch: f.kept.patch,
				patchDigest: f.kept.receipt.patchDigest,
				changedPaths: f.kept.receipt.changedPaths,
				policy: "clean",
			},
			{ model: f.kept.receipt.model, observed: null, commands: [] },
		);
		rmSync(join(f.state, "patches", `${binding.runId}.json`));
		rmSync(join(f.state, "patches", binding.runId), {
			recursive: true,
			force: true,
		});

		const result = await sandboxExecutor(f.config).output({
			runId: binding.runId,
			stage: "build",
			attempt: 1,
			round: 1,
		});

		assert.deepEqual(result, {
			kind: "build",
			result: { kind: "blocked", reason: "patch_missing" },
		});
	} finally {
		f.close();
	}
});

class GitData {
	main = baseSha;
	refs = new Map<string, string>();
	commits = new Map<
		string,
		{ parent: string; parents: string[]; message: string; tree: string }
	>();
	requests: string[] = [];
	dispatches = 0;
	visible = true;
	completed = false;
	crashAfterRef = false;
	crashAfterDispatch = false;
	failure: number | null = null;
	hook?: (args: readonly string[]) => ExecResult | null;
	receiptMissing = false;
	logs = new Map<string, string>();
	beforeDispatch?: () => void;
	onSave?: (state: ValidationState) => void;
	input: Record<string, string> = {};
	readonly dispatchInputs: Record<string, string>[] = [];
	readonly exec: Exec = async (_command, args): Promise<ExecResult> => {
		const path =
			args
				.find((a) => a.startsWith(`repos/${repo}/`))
				?.slice(`repos/${repo}/`.length) ?? "";

		const method = args[args.indexOf("--method") + 1] ?? "GET";
		const file = args[args.indexOf("--input") + 1];

		const body =
			args.includes("--input") && file !== undefined
				? objectOf(parseJson(readFileSync(file, "utf8")))
				: null;

		this.requests.push(`${method} ${path}`);

		const ok = (value?: JsonValue): ExecResult => ({
			code: 0,
			stdout: value === undefined ? "" : JSON.stringify(value),
			stderr: "",
		});

		const no = (status: number): ExecResult => ({
			code: 1,
			stdout: "",
			stderr: `HTTP ${status}`,
		});

		const intercepted = this.hook?.(args);

		if (intercepted != null) return intercepted;

		if (this.failure !== null) return no(this.failure);

		if (path === "git/ref/heads/main")
			return ok({ object: { sha: this.main } });

		if (method === "GET" && path.startsWith("git/commits/"))
			return ok({ tree: { sha: "b".repeat(40) } });

		if (path === "git/blobs")
			return ok({
				sha: gitObjectSha(
					"blob",
					Buffer.from(textOf(fieldOf(body, "content")) ?? "", "base64"),
				),
			});

		if (path === "git/trees")
			return ok({
				sha: createHash("sha1").update(JSON.stringify(body)).digest("hex"),
			});

		if (path === "git/commits") {
			const tree = textOf(fieldOf(body, "tree")) ?? "";

			const parents = (arrayOf(fieldOf(body, "parents")) ?? []).map(
				(p) => textOf(p) ?? "",
			);

			const parent = parents[0] ?? "";
			const message = textOf(fieldOf(body, "message")) ?? "";
			const actor = objectOf(fieldOf(body, "author"));
			const date = textOf(fieldOf(actor, "date")) ?? "";
			const identity = `${CONTROLLER_LOGIN} <${BOT_EMAIL}> ${Date.parse(date) / 1000} +0000`;
			assert.deepEqual(fieldOf(body, "committer"), actor);

			const sha = gitObjectSha(
				"commit",
				Buffer.from(
					`tree ${tree}\n${parents.map((p) => `parent ${p}\n`).join("")}author ${identity}\ncommitter ${identity}\n\n${message}`,
				),
			);

			this.commits.set(sha, { parent, parents, tree, message });

			return ok({ sha });
		}

		if (path === "git/refs") {
			const ref = (textOf(fieldOf(body, "ref")) ?? "").slice(
				"refs/heads/".length,
			);

			if (this.refs.has(ref)) return no(422);
			this.refs.set(ref, textOf(fieldOf(body, "sha")) ?? "");

			if (this.crashAfterRef) {
				this.crashAfterRef = false;
				throw new Error("crash");
			}

			return ok();
		}

		if (path.startsWith("git/ref/heads/")) {
			const sha = this.refs.get(path.slice("git/ref/heads/".length));

			return sha === undefined ? no(404) : ok({ object: { sha } });
		}

		if (method === "DELETE") {
			const branch = path.slice("git/refs/heads/".length);

			if (!this.refs.has(branch)) return no(422);
			this.refs.delete(branch);

			return ok();
		}

		if (path.endsWith("/dispatches")) {
			this.beforeDispatch?.();
			this.dispatches++;
			// SAFETY: fixed synthetic inputs authored by the controller under test.
			this.input = fieldOf(body, "inputs") as Record<string, string>;
			this.dispatchInputs.push({ ...this.input });

			if (this.crashAfterDispatch) {
				this.crashAfterDispatch = false;
				throw new Error("crash");
			}

			return ok();
		}

		if (path.startsWith("actions/workflows/ci.yml/runs"))
			return ok({
				workflow_runs: this.visible
					? this.dispatchInputs.map((input, index) => ({
							...this.run(),
							id: 123 + index,
							display_title: `gates ${input.candidate_sha} ${input.nonce}`,
						}))
					: [],
			});

		if (path === "actions/runs/123") return ok(this.run());
		throw new Error(`unexpected ${method} ${path}`);
	};
	run() {
		return {
			id: 123,
			head_sha: this.main,
			head_branch: "main",
			updated_at: "2026-10-31T00:01:00Z",
			display_title: `gates ${this.input.candidate_sha} ${this.input.nonce}`,
			status: this.completed ? "completed" : "in_progress",
			conclusion: this.completed ? "success" : null,
			event: "workflow_dispatch",
			path: ".github/workflows/ci.yml",
			actor: { login: CONTROLLER_LOGIN },
			triggering_actor: { login: CONTROLLER_LOGIN },
			created_at: "2026-10-31T00:00:00Z",
		};
	}
	receipt() {
		return JSON.stringify({
			version: 2,
			status: "passed",
			requiredChecks: REQUIRED_CI_CHECKS,
			checks: REQUIRED_CI_CHECKS.map((name) => ({ name, exitCode: 0 })),
			modelCalls: 0,
			gateSha: this.main,
			candidateSha: this.input.candidate_sha,
			nonce: this.input.nonce,
			heldoutDigest: this.input.heldout_digest,
			heldoutFailures: [],
		});
	}
}

const publicationInput = {
	issue: 1,
	runId,
	round: 0,
	eventAt: "2026-10-30T12:00:00Z",
	baseSha,
	patchDigest: digestOf("patch"),
	acceptanceDigest: digestOf("suite"),
	heldoutDigest: digestOf("checks"),
	patch: [{ path: "src/a.ts", mode: "100644", bytes: Buffer.from("code") }],
	suite: [
		{
			path: "test/acceptance/1/checks/a.test.ts",
			mode: "100644",
			bytes: Buffer.from("test"),
		},
	],
} as const;

describe("deterministic Git Data publication", () => {
	it("formal promotion refuses an unexpected predecessor before any non-force update", async () => {
		const target = "c".repeat(40);
		const foreign = "d".repeat(40);
		assert.ok(isGitSha(target));
		const calls: string[] = [];

		const api = new GitHubPublicationApi(
			async (_command, args) => {
				const method = args[args.indexOf("--method") + 1];
				calls.push(method ?? "GET");

				return {
					code: 0,
					stdout: JSON.stringify({ object: { sha: foreign } }),
					stderr: "",
				};
			},
			repo,
			EXE_DEV_PLATFORM,
		);

		await assert.rejects(
			api.promotePr(`factory/pr/1-${runId.slice(0, 12)}`, baseSha, target),
			/branch_moved/,
		);
		assert.deepEqual(calls, ["GET"]);
	});

	for (const race of [false, true])
		it(`formal promotion reconciles a lost response but does not claim expected-head CAS (race=${race})`, async () => {
			const target = "c".repeat(40);
			const foreign = "d".repeat(40);
			assert.ok(isGitSha(target));
			assert.ok(isGitSha(foreign));
			let head = baseSha;
			let reads = 0;
			let updates = 0;

			const api = new GitHubPublicationApi(
				async (_command, args) => {
					const method = args[args.indexOf("--method") + 1];

					if (method === "GET") {
						const observed = head;

						if (reads++ === 0 && race) head = foreign;

						return {
							code: 0,
							stdout: JSON.stringify({ object: { sha: observed } }),
							stderr: "",
						};
					}

					assert.equal(method, "PATCH");
					const file = args[args.indexOf("--input") + 1];
					assert.ok(file);
					assert.deepEqual(parseJson(readFileSync(file, "utf8")), {
						sha: target,
						force: false,
					});
					updates++;

					if (head === foreign)
						return { code: 1, stdout: "", stderr: "HTTP 422" };
					head = target;

					return { code: 1, stdout: "", stderr: "HTTP 502" };
				},
				repo,
				EXE_DEV_PLATFORM,
			);

			if (race)
				await assert.rejects(
					api.promotePr(`factory/pr/1-${runId.slice(0, 12)}`, baseSha, target),
				);
			else
				await api.promotePr(
					`factory/pr/1-${runId.slice(0, 12)}`,
					baseSha,
					target,
				);
			assert.equal(head, race ? foreign : target);
			assert.equal(updates, 1);
			assert.ok(reads >= 2);
		});
	it("keeps g0 bytes and builds the final ordered-parent SHA before certification", async () => {
		const fake = new GitData();
		const api = new GitHubPublicationApi(fake.exec, repo, EXE_DEV_PLATFORM);
		const initial = await publishCandidate(api, publicationInput);
		assert.doesNotMatch(
			fake.commits.get(initial.candidateSha)?.message ?? "",
			/Factory-Generation/,
		);

		const explicitZero = await publishCandidate(api, {
			...publicationInput,
			generation: 0,
		});

		assert.deepEqual(explicitZero, initial);

		const next = await publishCandidate(api, {
			...publicationInput,
			generation: 1,
			ancestry: { kind: "successor", previousHead: initial.candidateSha },
		});

		assert.equal(next.branch, `${initial.branch}-g1`);
		const candidate = fake.commits.get(next.candidateSha);
		assert.ok(candidate);
		assert.deepEqual(candidate.parents, [next.patchSha, initial.candidateSha]);
		assert.match(candidate.message, /Factory-Generation: 1/);
		const actor = `${CONTROLLER_LOGIN} <${BOT_EMAIL}> ${Date.parse(publicationInput.eventAt) / 1000} +0000`;
		const bytes = `tree ${candidate.tree}\n${candidate.parents.map((p) => `parent ${p}\n`).join("")}author ${actor}\ncommitter ${actor}\n\n${candidate.message}`;

		const native = execFileSync(
			"git",
			["hash-object", "-t", "commit", "--stdin"],
			{ input: bytes, encoding: "utf8" },
		).trim();

		assert.equal(next.candidateSha, native);
		assert.equal(
			fake.requests.some((p) => p.startsWith("PATCH")),
			false,
		);
	});
	it("publishes patch then suite, and adopts the same branch without moving it", async () => {
		const fake = new GitData();

		const api = new GitHubPublicationApi(
			fake.exec,
			repo,
			EXE_DEV_PLATFORM,
			{},
			async () => true,
			async () => {},
		);

		const first = await publishCandidate(api, publicationInput);
		const second = await publishCandidate(api, publicationInput);
		assert.deepEqual(second, first);
		assert.equal(fake.commits.size, 2);
		assert.equal(fake.commits.get(first.patchSha)?.parent, baseSha);
		assert.equal(fake.commits.get(first.candidateSha)?.parent, first.patchSha);
		assert.match(
			fake.commits.get(first.candidateSha)?.message ?? "",
			/Factory-Role: suite/,
		);
		assert.equal(fake.requests.filter((p) => p === "POST git/refs").length, 1);
	});
	it("recovers a crash after ref creation without force pushing", async () => {
		const fake = new GitData();
		fake.crashAfterRef = true;

		const api = new GitHubPublicationApi(
			fake.exec,
			repo,
			EXE_DEV_PLATFORM,
			{},
			async () => true,
			async () => {},
		);

		const result = await publishCandidate(api, publicationInput);
		assert.equal(fake.refs.get(result.branch), result.candidateSha);
		assert.equal(fake.requests.filter((p) => p === "POST git/refs").length, 2);
		assert.equal(fake.commits.size, 2);
	});
	it("refuses a moved branch", async () => {
		const fake = new GitData();
		fake.refs.set(candidateBranch(1, runId, 0), "f".repeat(40));
		await assert.rejects(
			publishCandidate(
				new GitHubPublicationApi(fake.exec, repo, EXE_DEV_PLATFORM),
				publicationInput,
			),
			/branch_moved/,
		);
	});
	it("retries afresh after old persisted counters and persists before every attempt", async () => {
		const fake = new GitData();
		const key = digestOf(JSON.stringify(["GET", "git/ref/heads/main", null]));
		const counters = { [key]: 3 };
		const snapshots: number[] = [];

		const api = new GitHubPublicationApi(
			fake.exec,
			repo,
			EXE_DEV_PLATFORM,
			counters,
			async () => {
				snapshots.push(counters[key] ?? 0);

				return true;
			},
			async () => {},
		);

		fake.failure = 502;
		await assert.rejects(
			api.request("GET", "git/ref/heads/main"),
			/transport_exhausted/,
		);
		assert.deepEqual(snapshots, [1, 2, 3]);
		fake.failure = null;
		await api.request("GET", "git/ref/heads/main");
		assert.deepEqual(snapshots, [1, 2, 3, 1, 0]);
	});
	it("checks the deterministic commit SHA returned by GitHub", async () => {
		const fake = new GitData();
		fake.hook = (args) =>
			args.includes(`repos/${repo}/git/commits`)
				? {
						code: 0,
						stdout: JSON.stringify({ sha: "f".repeat(40) }),
						stderr: "",
					}
				: null;
		await assert.rejects(
			publishCandidate(
				new GitHubPublicationApi(fake.exec, repo, EXE_DEV_PLATFORM),
				publicationInput,
			),
			/commit_mismatch/,
		);
		assert.equal(fake.refs.size, 0);
	});
	it("does not accept DELETE 422 while the owned ref still exists", async () => {
		const fake = new GitData();

		const publication = await publishCandidate(
			new GitHubPublicationApi(fake.exec, repo, EXE_DEV_PLATFORM),
			publicationInput,
		);

		fake.hook = (args) =>
			args.includes("DELETE")
				? { code: 1, stdout: "", stderr: "HTTP 422" }
				: null;
		await assert.rejects(
			new GitHubPublicationApi(fake.exec, repo, EXE_DEV_PLATFORM).remove(
				publication.branch,
				publication.candidateSha,
			),
			/conflict/,
		);
		assert.equal(fake.refs.get(publication.branch), publication.candidateSha);
	});
	it("bounds transport retries, and does not retry authorization failures", async () => {
		for (const status of [500, 429, 403]) {
			const fake = new GitData();
			fake.failure = status;
			const counters = {};

			const api = new GitHubPublicationApi(
				fake.exec,
				repo,
				EXE_DEV_PLATFORM,
				counters,
				async () => true,
				async () => {},
			);

			await assert.rejects(api.request("GET", "git/ref/heads/main"));
			assert.equal(fake.requests.length, status === 403 ? 1 : 3);
		}
	});
});

async function validationFixture(withGates = false) {
	const root = fresh();
	const base = join(root, "source");
	mkdirSync(base);
	mkdirSync(join(base, "src"));
	writeFileSync(join(base, "src/a.ts"), "export const a = 1;\n");

	if (withGates) {
		mkdirSync(join(base, ".github/factory/gates"), { recursive: true });
		writeFileSync(
			join(base, ".github/factory/gates/check.sh"),
			"echo trusted\n",
		);
	}

	execFileSync("git", ["init", "-q", base]);
	execFileSync("git", ["-C", base, "add", "."]);
	execFileSync("git", [
		"-C",
		base,
		"-c",
		"user.name=fixture",
		"-c",
		"user.email=fixture@example.com",
		"commit",
		"-qm",
		"base",
	]);

	const archive = execFileSync("git", [
		"-C",
		base,
		"archive",
		"--format=tar.gz",
		"--prefix=root/",
		"HEAD",
	]);

	rmSync(join(base, ".git"), { recursive: true });
	const workspace = join(root, "builder");
	mkdirSync(workspace);
	mkdirSync(join(workspace, "src"));
	writeFileSync(join(workspace, "src/a.ts"), "export const a = 2;\n");

	if (withGates)
		cpSync(join(base, ".github"), join(workspace, ".github"), {
			recursive: true,
		});

	const contract: Contract = {
		version: 2,
		runId,
		issue: 1,
		base: { repo: identity.repo, sha: identity.baseSha },
		snapshot: {
			digest: digestOf("snapshot"),
			source: "unedited",
			eventId: "1",
			eventAt: "2026-10-30T00:00:00Z",
		},
		link: null,
		summary: "Change a",
		behavior: ["Return 2"],
		acceptance: [{ id: "A1", kind: "new_behavior", text: "Return 2" }],
		exclusions: [],
		compatibility: [],
		limits: [],
		files: ["src/a.ts"],
		evidence: [],
	};

	const digest = contractDigestOf(contractBytes(contract));
	assert.equal(
		await fileRunFiles(root).writeContract({
			contract,
			digest,
			bytes: contractBytes(contract),
		}),
		true,
	);

	const suite: AcceptanceSuite = {
		version: 2,
		scenarios: [
			{
				id: "S1",
				kind: "new_behavior",
				criteria: ["A1"],
				checks: ["a.test.ts"],
				judge: null,
			},
		],
		files: [
			{
				path: "a.test.ts",
				type: "node:test",
				content: "import {test} from 'node:test'; test('a',()=>{});",
			},
		],
	};

	const stored = await fileArtifacts(root).store({
		contract,
		contractDigest: digest,
		suite,
		model: "openai/gpt-6.1-sol",
		observed: null,
	});

	assert.equal(stored.kind, "found");

	if (stored.kind !== "found") throw new Error("fixture");

	const binding = {
		runId,
		baseSha,
		contractDigest: digest,
		acceptanceDigest: stored.receipt.acceptanceDigest,
	};

	const patch = await collectPatch({ base, workspace });
	assert.equal(patch.kind, "collected");

	if (patch.kind !== "collected") throw new Error("fixture");
	storePatch(root, binding, patch, {
		model: "openai/gpt-6.1-sol",
		observed: null,
		commands: [],
	});
	finishPatch(root, binding, {
		command: "npm test",
		exitCode: 0,
		tail: "",
		wallMs: 1,
	});
	const fake = new GitData();
	const sleeps: number[] = [];
	let state: ValidationState | null = null;

	const step = (now = Date.parse("2026-10-31T00:00:00Z"), fetch = archive) =>
		controllerValidator({
			platform: EXE_DEV_PLATFORM,
			stateDir: root,
			exec: fake.exec,
			sleep: async (ms: number) => {
				sleeps.push(ms);
			},
			fetch: async () => fetch,
			receipt: async (_repo, _id, logs) => {
				for (const [name, text] of fake.logs) logs?.set(name, text);

				return fake.receiptMissing ? null : fake.receipt();
			},
		})({
			runId,
			issue: 1,
			eventAt: contract.snapshot.eventAt,
			baseSha: identity.baseSha,
			now,
			wallMs: 1_200_000,
			state,
			save: async (value) => {
				state = structuredClone(value);
				fake.onSave?.(state);

				return true;
			},
		});

	return {
		root,
		base,
		workspace,
		patch,
		fake,
		sleeps,
		step,
		state: () => state,
		archive,
	};
}

describe("generation policy evidence", () => {
	it("retains the gate-set digest from the exact exported validation base before deleting its source", async () => {
		const f = await validationFixture(true);
		assert.equal((await f.step()).kind, "waiting");
		const path = join(f.root, "validation", runId, "gate-policy.json");
		assert.equal(existsSync(path), true);
		assert.deepEqual(JSON.parse(readFileSync(path, "utf8")), {
			v: 1,
			runId,
			round: 0,
			generation: 0,
			sourceSha: baseSha,
			digest: baseTreeDigest(join(f.base, ".github/factory/gates")),
		});
		assert.equal(lstatSync(path).mode & 0o777, 0o600);
	});
});

describe("fix round 1 recovery regressions", () => {
	const start = Date.parse("2026-10-31T00:00:00Z");
	const unavailable = { code: 1, stdout: "", stderr: "HTTP 502" };

	it("B1 refuses a moved branch after a real post-verdict process crash", async () => {
		const f = await validationFixture();
		await f.step(start);
		await f.step(start + 30_000);
		f.fake.completed = true;
		const state = f.state();
		const candidate = state?.publication?.candidateSha;
		assert.ok(candidate);

		const crash = spawnSync(process.execPath, [
			"--experimental-strip-types",
			"--input-type=module",
			"-e",
			`
			import {controllerValidator} from './server/controller.ts';
			import {EXE_DEV_PLATFORM} from './src/trust/platform.ts';
			const input = JSON.parse(process.argv[1]);
			const exec = async (_, args) => {
				if (args.includes('DELETE')) process.kill(process.pid, 'SIGKILL');
				const path = args.find(a => a.startsWith('repos/'));
				const value = path.includes('/git/ref/') ? {object:{sha:input.state.publication.candidateSha}} : input.run;
				return {code:0,stdout:JSON.stringify(value),stderr:''};
			};
			await controllerValidator({stateDir:input.root,exec,platform:EXE_DEV_PLATFORM,receipt:async()=>input.receipt})({
				...input, save:async()=>true
			});
		`,
			JSON.stringify({
				root: f.root,
				state,
				run: f.fake.run(),
				receipt: f.fake.receipt(),
				runId,
				issue: 1,
				eventAt: publicationInput.eventAt,
				baseSha,
				now: start + 60_000,
				wallMs: 1_200_000,
			}),
		]);

		assert.equal(crash.signal, "SIGKILL", crash.stderr.toString());
		assert.equal(
			JSON.parse(
				readFileSync(join(f.root, "validation", runId, "verdict.json"), "utf8"),
			).pass,
			true,
		);
		const branch = candidateBranch(1, runId, 0);
		f.fake.refs.set(branch, "d".repeat(40));
		const result = await f.step(start + 90_000);
		assert.equal(result.kind, "failed");

		if (result.kind === "failed") assert.equal(result.reason, "branch_moved");
		assert.equal(f.fake.refs.get(branch), "d".repeat(40));
	});

	for (const expired of [false, true])
		it(`P1/P1b retries after persisted transport exhaustion (expired=${expired})`, async () => {
			const f = await validationFixture();
			await f.step(start);
			f.fake.failure = 502;
			assert.equal((await f.step(start + 30_000)).kind, "waiting");
			assert.deepEqual(f.sleeps, [1000, 2000]);
			assert.equal(
				existsSync(join(f.root, "validation", runId, "failure.json")),
				false,
			);
			f.fake.failure = null;
			f.fake.completed = !expired;
			const before = f.fake.requests.length;
			const result = await f.step(start + (expired ? 1_200_000 : 60_000));
			assert.ok(f.fake.requests.length > before);
			assert.equal(result.kind, expired ? "failed" : "finished");

			if (result.kind === "failed") assert.equal(result.reason, "ci_timeout");

			if (result.kind === "finished") assert.equal(result.verdict.pass, true);
			assert.equal(f.fake.refs.size, 0);
		});

	for (const legacyFailure of [false, true])
		it(`P5/P5b cleanup failure never shadows a stored pass (legacy failure=${legacyFailure})`, async () => {
			const f = await validationFixture();
			await f.step(start);
			f.fake.completed = true;
			let deletes = 0;
			f.fake.hook = (args) =>
				args.includes("DELETE") && deletes++ < 3 ? unavailable : null;
			const result = await f.step(start + 60_000);
			assert.equal(result.kind, "finished");

			if (result.kind === "finished") assert.equal(result.verdict.pass, true);
			const dir = join(f.root, "validation", runId);
			assert.equal(existsSync(join(dir, "failure.json")), false);
			assert.equal(existsSync(join(dir, "pending-deletion.json")), true);

			if (legacyFailure)
				writeFileSync(
					join(dir, "failure.json"),
					JSON.stringify({ reason: "transport_exhausted" }),
					{ mode: 0o600 },
				);
			assert.equal((await f.step(start + 90_000)).kind, "finished");
			assert.equal(f.fake.refs.size, 0);
		});

	it("P2 collects CI concluded by the deadline on a late tick", async () => {
		const f = await validationFixture();
		await f.step(start);
		f.fake.completed = true;
		const result = await f.step(start + 1_230_000);
		assert.equal(result.kind, "finished");

		if (result.kind === "finished") assert.equal(result.verdict.pass, true);
	});

	it("P6 waits for an unavailable receipt without storing a verdict", async () => {
		const f = await validationFixture();
		await f.step(start);
		f.fake.completed = true;
		f.fake.receiptMissing = true;
		assert.equal((await f.step(start + 60_000)).kind, "waiting");
		assert.equal(
			existsSync(join(f.root, "validation", runId, "verdict.json")),
			false,
		);
		f.fake.receiptMissing = false;
		assert.equal((await f.step(start + 90_000)).kind, "finished");
	});

	it("writes the dispatch try durably before the dispatch POST", async () => {
		const f = await validationFixture();
		let saved = false;
		f.fake.beforeDispatch = () => {
			saved = f.state()?.dispatchTry === 1 && f.state()?.dispatchedAt === start;
		};

		await f.step(start);
		assert.equal(saved, true);
	});

	it("ends on persistent transport failure at the deadline and sweeps pending cleanup", async () => {
		const f = await validationFixture();
		await f.step(start);
		f.fake.failure = 502;
		const result = await f.step(start + 1_200_000);
		assert.equal(result.kind, "failed");
		assert.deepEqual(f.sleeps, [1000, 2000, 1000, 2000]);

		if (result.kind === "failed") assert.equal(result.reason, "ci_timeout");
		const validation = f.state();

		if (validation === null) throw new Error("fixture");
		assert.equal(
			existsSync(join(f.root, "validation", runId, "pending-deletion.json")),
			true,
		);
		await fileRunFiles(f.root).writeClaim({
			runId,
			issue: 1,
			eventId: "1",
			seq: 1,
			status: "failed",
			stage: "validate",
			attempt: 1,
			usage: 0,
			validation,
		});
		f.fake.failure = null;
		await sweepValidation({
			platform: EXE_DEV_PLATFORM,
			stateDir: f.root,
			exec: f.fake.exec,
		});
		assert.equal(f.fake.refs.size, 0);
		assert.equal(
			existsSync(join(f.root, "validation", runId, "cleanup.json")),
			true,
		);
	});

	it("rechecks a just-published branch before the first dispatch", async () => {
		const f = await validationFixture();
		f.fake.onSave = (state) => {
			if (state.publication !== null)
				f.fake.refs.set(state.publication.branch, "d".repeat(40));
		};

		const result = await f.step(start);
		assert.equal(result.kind, "failed");

		if (result.kind === "failed") assert.equal(result.reason, "branch_moved");
		assert.equal(f.fake.dispatches, 0);
		assert.equal(f.fake.refs.get(candidateBranch(1, runId, 0)), "d".repeat(40));
	});

	it("checks live identity on every wait tick and preserves a moved ref", async () => {
		const f = await validationFixture();
		await f.step(start);
		const branch = candidateBranch(1, runId, 0);
		f.fake.refs.set(branch, "d".repeat(40));
		const result = await f.step(start + 30_000);
		assert.equal(result.kind, "failed");

		if (result.kind === "failed") assert.equal(result.reason, "branch_moved");
		assert.equal(f.fake.refs.get(branch), "d".repeat(40));
	});

	it("rejects a bound CI run whose authenticated identity changed", async () => {
		const f = await validationFixture();
		await f.step(start);
		await f.step(start + 30_000);
		f.fake.completed = true;
		f.fake.hook = (args) =>
			args.includes(`repos/${repo}/actions/runs/123`)
				? {
						code: 0,
						stdout: JSON.stringify({
							...f.fake.run(),
							head_branch: "not-main",
						}),
						stderr: "",
					}
				: null;
		const result = await f.step(start + 60_000);
		assert.equal(result.kind, "failed");

		if (result.kind === "failed") assert.equal(result.reason, "ci_identity");
	});

	it("refuses a concluded run on a gate different from its base", async () => {
		const f = await validationFixture();
		await f.step(start);
		f.fake.main = "e".repeat(40);
		f.fake.completed = true;
		const result = await f.step(start + 60_000);
		assert.equal(result.kind, "failed");

		if (result.kind === "failed") assert.equal(result.reason, "stale_base");
	});

	it("reapplies after publication when main moves before the second dispatch", async () => {
		const f = await validationFixture();
		f.fake.visible = false;
		await f.step(start);
		const old = f.state()?.publication?.candidateSha;
		f.fake.main = "e".repeat(40);
		await f.step(start + 120_000);
		await f.step(start + 121_000);
		assert.equal(f.state()?.baseSha, f.fake.main);
		assert.notEqual(f.state()?.publication?.candidateSha, old);
		assert.equal(f.state()?.round, 0);
		assert.equal(
			f.fake.commits.get(f.state()?.publication?.patchSha ?? "")?.parent,
			f.fake.main,
		);
		assert.equal(f.fake.dispatches, 2);
	});

	for (const field of [
		"candidateSha",
		"acceptanceDigest",
		"patchDigest",
		"heldoutDigest",
		"gateSha",
		"baseSha",
		"originalBase",
		"ciRunId",
	])
		it(`refuses stored-verdict reuse with changed ${field}`, async () => {
			const f = await validationFixture();
			await f.step(start);
			f.fake.completed = true;
			await f.step(start + 60_000);
			const path = join(f.root, "validation", runId, "verdict.json");
			const verdict = JSON.parse(readFileSync(path, "utf8"));
			writeFileSync(
				path,
				JSON.stringify({
					...verdict,
					[field]: field === "ciRunId" ? 124 : digestOf("other"),
				}),
				{ mode: 0o600 },
			);
			const result = await f.step(start + 90_000);
			assert.equal(result.kind, "failed");

			if (result.kind === "failed")
				assert.equal(result.reason, "verdict_binding");
		});

	it("refuses symlinks before publication", async () => {
		const f = await validationFixture();
		symlinkSync("a.ts", join(f.workspace, "src/link.ts"));
		const patch = await collectPatch({ base: f.base, workspace: f.workspace });
		assert.equal(patch.kind, "collected");

		if (patch.kind !== "collected") throw new Error("fixture");
		await assert.rejects(
			publicationTree(
				f.base,
				join(f.root, "publish"),
				patch.patch,
				patch.changedPaths,
			),
			/unsafe_symlink/,
		);
	});
});

describe("receipt download transport", () => {
	it("hands the visible check logs beside the receipt to a logs sink, never the held-out run", async () => {
		await withLocalArtifactDownload(async () => {
			const members: string[] = [];

			const exec: Exec = async (command, args) => {
				if (command === "unzip") {
					const member = args[2] ?? "";
					members.push(member);

					return member === "format.log"
						? { code: 11, stdout: "", stderr: "missing" }
						: { code: 0, stdout: `bytes of ${member}`, stderr: "" };
				}

				return {
					code: 0,
					stdout: JSON.stringify({
						artifacts: [{ id: 9, name: "gate-receipt", expired: false }],
					}),
					stderr: "",
				};
			};

			const logs = new Map<string, string>();
			assert.equal(
				await downloadGateReceipt(
					exec,
					repo,
					EXE_DEV_PLATFORM,
					123,
					"gate-receipt",
					logs,
				),
				"bytes of receipt.json",
			);
			assert.deepEqual(Object.fromEntries(logs), {
				typecheck: "bytes of typecheck.log",
				lint: "bytes of lint.log",
				candidate_tests: "bytes of candidate_tests.log",
			});
			assert.deepEqual(members, [
				"receipt.json",
				"typecheck.log",
				"lint.log",
				"format.log",
				"candidate_tests.log",
			]);
			members.length = 0;
			await downloadGateReceipt(exec, repo, EXE_DEV_PLATFORM, 123);
			assert.deepEqual(members, ["receipt.json"]);
		});
	});

	it("does not turn a transport failure into an absent receipt", async () => {
		let failures = true;

		const exec: Exec = async (_, args) => {
			const path = args.find((arg) => arg.startsWith("repos/")) ?? "";

			if (path.endsWith("/artifacts"))
				return {
					code: 0,
					stdout: JSON.stringify({ artifacts: [] }),
					stderr: "",
				};

			if (path.endsWith("/jobs"))
				return {
					code: 0,
					stdout: JSON.stringify({ jobs: [{ id: 7, name: "gates" }] }),
					stderr: "",
				};

			return failures
				? { code: 1, stdout: "", stderr: "HTTP 502" }
				: {
						code: 0,
						stdout:
							'2026-10-31T00:00:00Z {\n2026-10-31T00:00:00Z "version":2\n2026-10-31T00:00:00Z }',
						stderr: "",
					};
		};

		await assert.rejects(
			downloadGateReceipt(exec, repo, EXE_DEV_PLATFORM, 123),
		);
		failures = false;
		assert.equal(
			await downloadGateReceipt(exec, repo, EXE_DEV_PLATFORM, 123),
			'{\n"version":2\n}',
		);
	});
});

describe("controller publication and waiting recovery", () => {
	for (const crash of [false, true])
		it(`reconciles a dispatch across restart (lost response=${crash})`, async () => {
			const f = await validationFixture();
			f.fake.crashAfterDispatch = crash;
			assert.equal((await f.step()).kind, "waiting");
			assert.equal(f.state()?.dispatchTry, 1);
			assert.equal((await f.step()).kind, "waiting");
			assert.equal(f.fake.dispatches, 1);
			f.fake.completed = true;
			const result = await f.step();
			assert.equal(result.kind, "finished");

			if (result.kind !== "finished") throw new Error(JSON.stringify(result));
			assert.equal(result.verdict.pass, true);
			assert.equal(f.fake.refs.size, 0);
			assert.equal(
				existsSync(join(f.root, "validation", runId, "verdict.json")),
				true,
			);
			assert.equal((await f.step()).kind, "finished");
			assert.equal(f.fake.dispatches, 1);
		});
	it("sweeps only its released candidate after CI finishes, without redispatch", async () => {
		const f = await validationFixture();
		await f.step();
		const validation = f.state();

		if (validation === null) throw new Error("fixture");
		await fileRunFiles(f.root).writeClaim({
			runId,
			issue: 1,
			eventId: "1",
			seq: 1,
			status: "released",
			stage: "validate",
			attempt: 1,
			usage: 0,
			validation,
		});

		const config = {
			platform: EXE_DEV_PLATFORM,
			stateDir: f.root,
			exec: f.fake.exec,
			receipt: async () => f.fake.receipt(),
			now: () => Date.parse("2026-10-31T00:00:01Z"),
		};

		f.fake.refs.set("factory/ledger", "f".repeat(40));
		await sweepValidation(config);
		assert.equal(f.fake.refs.size, 2);
		f.fake.completed = true;
		await sweepValidation(config);
		assert.equal(f.fake.refs.size, 1);
		assert.equal(f.fake.refs.has("factory/ledger"), true);
		assert.equal(f.fake.dispatches, 1);
		assert.equal(
			existsSync(join(f.root, "validation", runId, "verdict.json")),
			true,
		);
		assert.equal(
			existsSync(join(f.root, "validation", runId, "cleanup.json")),
			true,
		);
		const calls = f.fake.requests.length;
		await sweepValidation(config);
		assert.equal(f.fake.requests.length, calls);
	});

	for (const status of ["running", "released"] as const)
		it(`sweep preserves a ${status} claim with a non-derived branch`, async () => {
			const f = await validationFixture();
			await f.step();
			const validation = f.state();

			if (validation?.publication == null) throw new Error("fixture");
			validation.publication = {
				...validation.publication,
				branch: candidateBranch(999, runId, 0),
			};
			f.fake.refs.set(
				validation.publication.branch,
				validation.publication.candidateSha,
			);
			f.fake.completed = true;
			await fileRunFiles(f.root).writeClaim({
				runId,
				issue: 1,
				eventId: "1",
				seq: 1,
				status,
				stage: "validate",
				attempt: 1,
				usage: 0,
				validation,
			});
			await sweepValidation({
				platform: EXE_DEV_PLATFORM,
				stateDir: f.root,
				exec: f.fake.exec,
				receipt: async () => f.fake.receipt(),
			});
			assert.equal(f.fake.refs.size, 2);
		});

	it("sweep never collects or removes a running claim", async () => {
		const f = await validationFixture();
		await f.step();
		const validation = f.state();

		if (validation === null) throw new Error("fixture");
		await fileRunFiles(f.root).writeClaim({
			runId,
			issue: 1,
			eventId: "1",
			seq: 1,
			status: "running",
			stage: "validate",
			attempt: 1,
			usage: 0,
			validation,
		});
		f.fake.completed = true;
		const calls = f.fake.requests.length;
		await sweepValidation({
			platform: EXE_DEV_PLATFORM,
			stateDir: f.root,
			exec: f.fake.exec,
			receipt: async () => f.fake.receipt(),
		});
		assert.equal(f.fake.requests.length, calls);
		assert.equal(f.fake.refs.size, 1);
	});

	for (const visible of [false, true])
		it(`sweep waits before deadline, then ends released CI (visible=${visible})`, async () => {
			const f = await validationFixture();
			const start = Date.parse("2026-10-31T00:00:00Z");
			await f.step(start);
			const validation = f.state();

			if (validation === null) throw new Error("fixture");
			await fileRunFiles(f.root).writeClaim({
				runId,
				issue: 1,
				eventId: "1",
				seq: 1,
				status: "released",
				stage: "validate",
				attempt: 1,
				usage: 0,
				validation,
			});
			f.fake.visible = visible;
			const calls = f.fake.requests.length;
			await sweepValidation({
				platform: EXE_DEV_PLATFORM,
				stateDir: f.root,
				exec: f.fake.exec,
				now: () => start + 30_000,
			});
			assert.equal(f.fake.requests.length, calls + 1);
			assert.equal(f.fake.refs.size, 1);
			await sweepValidation({
				platform: EXE_DEV_PLATFORM,
				stateDir: f.root,
				exec: f.fake.exec,
				now: () => start + 1_200_000,
			});
			assert.equal(f.fake.refs.size, 0);
		});

	it("settles an absent dispatch before retrying, with no third try", async () => {
		const f = await validationFixture();
		f.fake.visible = false;
		const start = Date.parse("2026-10-31T00:00:00Z");
		await f.step(start);
		await f.step(start + 119_999);
		assert.equal(f.fake.dispatches, 1);
		await f.step(start + 120_000);
		assert.equal(f.fake.dispatches, 2);
		await f.step(start + 240_000);
		assert.equal(f.fake.dispatches, 2);
		const timeout = await f.step(start + 1_200_000);
		assert.equal(timeout.kind, "failed");

		if (timeout.kind === "failed") assert.equal(timeout.reason, "ci_timeout");
	});
	it("rejects two late-visible dispatch tries instead of taking a passing one", async () => {
		const f = await validationFixture();
		const start = Date.parse("2026-10-31T00:00:00Z");
		f.fake.visible = false;
		await f.step(start);
		await f.step(start + 120_000);
		assert.equal(f.fake.dispatches, 2);
		f.fake.visible = true;
		const waiting = await f.step(start + 121_000);
		assert.equal(waiting.kind, "waiting");
		assert.equal(f.fake.refs.size, 1);
		f.fake.completed = true;
		const result = await f.step(start + 122_000);
		assert.equal(result.kind, "failed");

		if (result.kind === "failed")
			assert.equal(result.reason, "duplicate_dispatch");
		assert.equal(f.fake.refs.size, 0);
	});

	for (const failing of ["lint", "candidate_tests", "heldout"] as const)
		it(`stores the assessment before feedback and returns it on the fresh and stored-verdict paths; a held-out failure waits for its diagnosis job and keeps the branch (${failing})`, async () => {
			const f = await validationFixture();
			const passing = f.fake.receipt.bind(f.fake);

			f.fake.receipt = () => {
				const r = JSON.parse(passing());

				return JSON.stringify({
					...r,
					status: "failed",
					reason: null,
					replacementsDigest: replacementDigest([]),
					checks: REQUIRED_CI_CHECKS.map((name) => ({
						name,
						exitCode: name === failing ? 1 : 0,
					})),
					heldoutFailures: failing === "heldout" ? ["unknown"] : [],
				});
			};

			f.fake.logs.set(
				"lint",
				"  × eslint(no-unused-vars): unused value\n    ╭─[src/a.ts:1:1]\n  × eslint(no-debugger): hidden\n    ╭─[test/acceptance/1/checks/a.test.ts:1:1]\n",
			);
			// A candidate test that read the published suite in CI and failed
			// with its names and bytes, the path stripped.
			f.fake.logs.set(
				"candidate_tests",
				`${JSON.stringify({
					complete: true,
					bad: true,
					failures: [
						{
							file: "src/a.ts",
							name: "secret-scenario.test.mjs",
							kind: "assertion",
							code: "ERR_ASSERTION",
							message:
								"+ [ 'secret-scenario.test.mjs' ] export const canary = 'CANARY-secret-bytes'",
						},
					],
				})}\n`,
			);
			f.fake.logs.set("heldout", "hidden held-out output naming src/a.ts");

			const dir = join(f.root, "validation", runId);
			await f.step();
			assert.equal(existsSync(join(dir, "assessment.json")), false);
			f.fake.completed = true;
			const first = await f.step();

			if (failing === "heldout") {
				assert.equal(first.kind, "waiting");
				assert.equal(existsSync(join(dir, "assessment.json")), false);
				assert.equal(existsSync(join(dir, "feedback.json")), false);
				assert.equal(f.fake.refs.size, 1);

				return;
			}

			assert.equal(first.kind, "finished");

			if (first.kind !== "finished") return;
			assert.equal(first.verdict.pass, false);
			const stored = readFileSync(join(dir, "assessment.json"), "utf8");
			assert.equal(digestOf(stored), first.assessment.ref.recordDigest);

			{
				assert.deepEqual(first.assessment.assessment, {
					kind: "failed",
					failure: {
						kind: "candidate",
						reason: "candidate_check",
						scenarios: [],
					},
				});

				const feedback = JSON.parse(
					readFileSync(join(dir, "feedback.json"), "utf8"),
				);

				assert.equal(feedback.version, 2);
				assert.deepEqual(feedback.assessment, first.assessment.ref);
				assert.deepEqual(feedback.scenarios, [
					failing === "lint"
						? { check: "lint", file: "src/a.ts" }
						: {
								check: "candidate_tests",
								file: "src/a.ts",
								code: "ERR_ASSERTION",
							},
				]);

				// The repair workspace file carries the same list as validation.
				const validation = readFeedbackBytes(
					readFileSync(join(dir, "feedback.json"), "utf8"),
					first.assessment.ref,
				);

				assert.deepEqual(validation, feedback.scenarios);
				const repair = join(f.root, "repair");
				await prepareRepairTree(
					f.base,
					repair,
					f.patch.patch,
					f.patch.changedPaths,
					JSON.stringify({ version: 1, round: 1, validation, review: [] }),
				);

				for (const text of [
					readFileSync(join(dir, "feedback.json"), "utf8"),
					readFileSync(join(dir, "checks.json"), "utf8"),
					readFileSync(join(repair, ".factory-feedback.json"), "utf8"),
				])
					assert.doesNotMatch(
						text,
						/hidden|acceptance|secret|canary|unused value|debugger/i,
					);
			}

			const again = await f.step();
			assert.ok(again.kind === "finished");
			assert.deepEqual(again.assessment, first.assessment);
			rmSync(join(dir, "assessment.json"));
			const restored = await f.step();
			assert.ok(restored.kind === "finished");
			assert.deepEqual(restored.assessment, first.assessment);
			assert.equal(readFileSync(join(dir, "assessment.json"), "utf8"), stored);
		});

	it("reapplies on moved main without a model or repair round", async () => {
		const f = await validationFixture();
		f.fake.main = "e".repeat(40);
		await f.step();
		assert.equal(f.state()?.baseSha, f.fake.main);
		assert.equal(f.state()?.originalBase, baseSha);
		assert.equal(f.state()?.round, 0);
		f.fake.completed = true;
		const result = await f.step();
		assert.equal(result.kind, "finished");

		if (result.kind === "finished") {
			assert.equal(result.verdict.baseSha, f.fake.main);
			assert.equal(result.verdict.originalBase, baseSha);
		}
	});
	it("refuses an existing held-out directory on a moved base", async () => {
		const f = await validationFixture();
		f.fake.main = "e".repeat(40);
		mkdirSync(join(f.base, "test/acceptance/1/checks"), { recursive: true });
		writeFileSync(
			join(f.base, "test/acceptance/1/checks/prior.test.ts"),
			"prior",
		);
		execFileSync("git", ["init", "-q", f.base]);
		execFileSync("git", ["-C", f.base, "add", "."]);
		execFileSync("git", [
			"-C",
			f.base,
			"-c",
			"user.name=fixture",
			"-c",
			"user.email=fixture@example.com",
			"commit",
			"-qm",
			"suite",
		]);

		const archive = execFileSync("git", [
			"-C",
			f.base,
			"archive",
			"--format=tar.gz",
			"--prefix=root/",
			"HEAD",
		]);

		const result = await f.step(undefined, archive);
		assert.equal(result.kind, "failed");

		if (result.kind === "failed") assert.equal(result.reason, "stale_base");
		assert.equal(f.fake.dispatches, 0);
		assert.equal(f.fake.refs.size, 0);
	});

	it("fails stale_base on a conflicting reapply, publishing nothing", async () => {
		const f = await validationFixture();
		f.fake.main = "e".repeat(40);
		writeFileSync(join(f.base, "src/a.ts"), "export const a = 900;\n");
		execFileSync("git", ["init", "-q", f.base]);
		execFileSync("git", ["-C", f.base, "add", "."]);
		execFileSync("git", [
			"-C",
			f.base,
			"-c",
			"user.name=fixture",
			"-c",
			"user.email=fixture@example.com",
			"commit",
			"-qm",
			"conflict",
		]);

		const archive = execFileSync("git", [
			"-C",
			f.base,
			"archive",
			"--format=tar.gz",
			"--prefix=root/",
			"HEAD",
		]);

		const result = await f.step(undefined, archive);
		assert.equal(result.kind, "failed");

		if (result.kind === "failed") assert.equal(result.reason, "stale_base");
		assert.equal(f.fake.refs.size, 0);
		assert.equal(f.fake.dispatches, 0);
	});
	it("builds a repair tree without published checks, objects or caches", async () => {
		const f = await validationFixture();
		mkdirSync(join(f.base, "test/acceptance/1/checks"), { recursive: true });
		writeFileSync(
			join(f.base, "test/acceptance/1/checks/canary.test.ts"),
			"secret",
		);

		for (const path of ["Test/Acceptance", "TEST/ACCEPTANCE"]) {
			mkdirSync(join(f.base, path), { recursive: true });
			writeFileSync(join(f.base, path, "canary.test.ts"), "secret");
		}

		const repair = join(f.root, "repair");
		await prepareRepairTree(
			f.base,
			repair,
			f.patch.patch,
			f.patch.changedPaths,
			JSON.stringify([
				{ scenario: "S1", criteria: [{ id: "A1", text: "Return 2" }] },
			]),
		);

		for (const path of [
			"test/acceptance",
			"Test/Acceptance",
			"TEST/ACCEPTANCE",
		])
			assert.equal(existsSync(join(repair, path)), false);
		assert.equal(existsSync(join(repair, ".git")), false);
		assert.equal(existsSync(join(repair, "node_modules")), false);
		assert.match(readFileSync(join(repair, "src/a.ts"), "utf8"), /2/);
		assert.doesNotMatch(
			readFileSync(join(repair, ".factory-feedback.json"), "utf8"),
			/secret|canary|test\.ts/,
		);
		assert.equal(
			lstatSync(join(repair, ".factory-feedback.json")).mode & 0o777,
			0o600,
		);
		symlinkSync("/tmp", join(f.base, "escape"));
		await assert.rejects(
			prepareRepairTree(
				f.base,
				join(f.root, "unsafe"),
				f.patch.patch,
				f.patch.changedPaths,
				"[]",
			),
			/unsafe_symlink/,
		);
	});

	it("collects a repair round without the controller's own acceptance removal, and still forbids model edits there", async () => {
		const f = await validationFixture();

		const tracked: [string, string][] = [
			["test/acceptance/561/checks/human-review.test.mjs", "public"],
			["Test/Acceptance/canary.test.ts", "secret"],
		];

		for (const [path, text] of tracked) {
			mkdirSync(join(f.base, path, ".."), { recursive: true });
			writeFileSync(join(f.base, path), text);
		}

		const repair = join(f.root, "repair");
		await prepareRepairTree(
			f.base,
			repair,
			f.patch.patch,
			f.patch.changedPaths,
			"{}",
		);
		rmSync(join(repair, ".factory-feedback.json"));

		const collect = () =>
			collectPatch({ base: f.base, workspace: repair, repairTree: true });

		const clean = await collect();
		assert.ok(clean.kind === "collected");
		assert.equal(clean.policy, "clean");
		assert.deepEqual(clean.changedPaths, f.patch.changedPaths);
		assert.equal(clean.patchDigest, f.patch.patchDigest);
		assert.doesNotMatch(clean.patch.toString(), /acceptance/i);

		for (const path of [
			"test/acceptance/561/checks/human-review.test.mjs",
			"test/acceptance/562/checks/new.test.mjs",
			"Test/Acceptance/canary.test.ts",
		]) {
			mkdirSync(join(repair, path, ".."), { recursive: true });
			writeFileSync(join(repair, path), "model edit");
			const edited = await collect();
			assert.ok(edited.kind === "collected");
			assert.equal(edited.policy, "forbidden");
			assert.ok(edited.changedPaths.includes(path));
			rmSync(join(repair, path.split("/").slice(0, 2).join("/")), {
				recursive: true,
			});
		}

		const initial = await collectPatch({ base: f.base, workspace: repair });
		assert.ok(initial.kind === "collected");
		assert.equal(initial.policy, "forbidden");
	});
});

const ledgerDate = "2026-11-04T12:00:00Z";

const quietApi = (exec: Exec) =>
	new GitHubPublicationApi(
		exec,
		repo,
		EXE_DEV_PLATFORM,
		{},
		async () => true,
		async () => {},
	);

describe("ledger Git API", () => {
	it("candidate ref, prRef and remove refuse factory/ledger before any request", async () => {
		const fake = new LedgerGit();
		const api = quietApi(fake.exec);
		const sha = "c".repeat(40);
		assert.ok(isGitSha(sha));
		fake.refs.set("factory/ledger", sha);

		for (const branch of [
			"factory/ledger",
			"refs/heads/factory/ledger",
			"factory/ledger/x",
		]) {
			await assert.rejects(api.ref(branch), /invalid_branch/);
			await assert.rejects(api.prRef(branch), /invalid_branch/);
			await assert.rejects(api.remove(branch, sha), /invalid_branch/);
			await assert.rejects(api.promotePr(branch, null, sha), /invalid_branch/);
		}

		assert.equal(fake.requests.length, 0);
		assert.equal(fake.refs.get("factory/ledger"), sha);
	});

	it("ledger methods name no branch and write only refs/heads/factory/ledger", async () => {
		const fake = new LedgerGit();
		const api = quietApi(fake.exec);
		const other = candidateBranch(1, runId, 0);
		const otherSha = "d".repeat(40);
		fake.refs.set(other, otherSha);
		assert.equal(ledgerRef.length, 1);
		assert.equal(advanceLedger.length, 3);

		for (const bad of [other, "factory/ledger", "main", "f".repeat(39)])
			await assert.rejects(
				// SAFETY: deliberately passes a non-SHA to prove the runtime guard.
				advanceLedger(api, null, bad as GitSha),
				/invalid_sha/,
			);
		assert.equal(fake.requests.length, 0);

		assert.equal(await ledgerRef(api), null);
		const root = await createLedgerRoot(api, ledgerDate);
		assert.deepEqual(await advanceLedger(api, null, root.sha), {
			kind: "advanced",
			tip: root.sha,
		});

		const child = await createLedgerChild(
			api,
			root,
			Buffer.from("row\n"),
			ledgerDate,
			"factory: ledger child\n",
		);

		assert.deepEqual(await advanceLedger(api, root.sha, child.sha), {
			kind: "advanced",
			tip: child.sha,
		});
		assert.equal(await ledgerRef(api), child.sha);

		const refWrites = fake.writes.filter((w) => w.path.includes("refs"));

		assert.deepEqual(
			refWrites.map((w) => [w.method, w.path, w.body]),
			[
				[
					"POST",
					"git/refs",
					{ ref: "refs/heads/factory/ledger", sha: root.sha },
				],
				[
					"PATCH",
					"git/refs/heads/factory/ledger",
					{ sha: child.sha, force: false },
				],
			],
		);
		assert.ok(
			fake.requests
				.filter((r) => r.includes("git/ref/"))
				.every((r) => r === "GET git/ref/heads/factory/ledger"),
		);
		assert.equal(
			fake.requests.some((r) => r.startsWith("DELETE")),
			false,
		);
		assert.equal(fake.refs.get(other), otherSha);
	});

	it("only ledger root creation omits base_tree, and it has no parents", async () => {
		const fake = new LedgerGit();
		const api = quietApi(fake.exec);
		const root = await createLedgerRoot(api, ledgerDate);

		const child = await createLedgerChild(
			api,
			root,
			Buffer.from("row\n"),
			ledgerDate,
			"factory: ledger child\n",
		);

		const trees = fake.writes.filter((w) => w.path === "git/trees");
		assert.equal(trees.length, 2);
		assert.equal(
			Object.hasOwn(objectOf(trees[0]?.body) ?? {}, "base_tree"),
			false,
		);
		assert.deepEqual(fieldOf(objectOf(trees[0]?.body), "tree"), [
			{
				path: LEDGER_FILE,
				mode: "100644",
				type: "blob",
				sha: gitObjectSha("blob", new Uint8Array()),
			},
		]);
		assert.equal(fieldOf(objectOf(trees[1]?.body), "base_tree"), root.tree);
		assert.deepEqual(root.parents, []);
		assert.deepEqual(fake.commits.get(root.sha), []);
		assert.deepEqual(child.parents, [root.sha]);
		assert.deepEqual(fake.commits.get(child.sha), [root.sha]);

		const read = await readLedgerCommit(api, root.sha);
		assert.deepEqual(read, root);
		const file = await readLedgerFile(api, root.tree);
		assert.equal(file.bytes.length, 0);
		assert.deepEqual(file.paths, ["ledger", LEDGER_FILE]);
		assert.equal(file.blob, gitObjectSha("blob", new Uint8Array()));

		const candidateTrees: JsonValue[] = [];
		const recorded = new GitData();

		recorded.hook = (args) => {
			const file = args[args.indexOf("--input") + 1];

			if (args.includes(`repos/${repo}/git/trees`) && file !== undefined)
				candidateTrees.push(parseJson(readFileSync(file, "utf8")) ?? null);

			return null;
		};

		await publishCandidate(quietApi(recorded.exec), publicationInput);
		assert.equal(candidateTrees.length, 2);

		for (const body of candidateTrees)
			assert.ok(isGitSha(textOf(fieldOf(objectOf(body), "base_tree")) ?? ""));
	});

	it("fast-forwards only, and a sibling advance is rejected with the ref left in place", async () => {
		const fake = new LedgerGit();
		const api = quietApi(fake.exec);
		const root = await createLedgerRoot(api, ledgerDate);
		await advanceLedger(api, null, root.sha);
		const empty = Buffer.alloc(0);
		const a = await createLedgerChild(api, root, empty, ledgerDate, "a\n");
		const b = await createLedgerChild(api, root, empty, ledgerDate, "b\n");
		assert.notEqual(a.sha, b.sha);
		assert.equal(a.tree, root.tree);
		assert.deepEqual(await advanceLedger(api, root.sha, a.sha), {
			kind: "advanced",
			tip: a.sha,
		});
		assert.deepEqual(await advanceLedger(api, root.sha, b.sha), {
			kind: "conflict",
			tip: a.sha,
		});
		assert.equal(fake.refs.get("factory/ledger"), a.sha);

		const otherRoot = await createLedgerRoot(api, "2026-11-04T12:00:01Z");
		assert.deepEqual(await advanceLedger(api, null, otherRoot.sha), {
			kind: "conflict",
			tip: a.sha,
		});
		assert.deepEqual(await advanceLedger(api, null, a.sha), {
			kind: "advanced",
			tip: a.sha,
		});
		assert.equal(fake.refs.get("factory/ledger"), a.sha);

		for (const write of fake.writes.filter((w) => w.method === "PATCH"))
			assert.equal(fieldOf(objectOf(write.body), "force"), false);
		assert.equal(
			fake.requests.some((r) => r.startsWith("DELETE")),
			false,
		);
	});

	it("reconciles a lost write response by reading the ledger ref back", async () => {
		const fake = new LedgerGit();
		const api = quietApi(fake.exec);
		const root = await createLedgerRoot(api, ledgerDate);
		fake.lose = (method) => (method === "POST" ? "after" : null);
		assert.deepEqual(await advanceLedger(api, null, root.sha), {
			kind: "advanced",
			tip: root.sha,
		});
		fake.lose = null;

		const a = await createLedgerChild(
			api,
			root,
			Buffer.alloc(0),
			ledgerDate,
			"a\n",
		);

		fake.lose = (method) => (method === "PATCH" ? "after" : null);
		assert.deepEqual(await advanceLedger(api, root.sha, a.sha), {
			kind: "advanced",
			tip: a.sha,
		});

		const c = await createLedgerChild(
			api,
			a,
			Buffer.alloc(0),
			ledgerDate,
			"c\n",
		);

		fake.lose = (method) => (method === "PATCH" ? "before" : null);
		await assert.rejects(advanceLedger(api, a.sha, c.sha), /github_refused/);
		assert.equal(fake.refs.get("factory/ledger"), a.sha);
		fake.lose = null;

		fake.hook = (method) =>
			method === "PATCH" ? { code: 1, stdout: "", stderr: "HTTP 403" } : null;
		await assert.rejects(advanceLedger(api, a.sha, c.sha), /github_refused/);
		fake.hook = null;

		assert.equal(fake.writes.filter((w) => w.method === "PATCH").length, 3);
		assert.deepEqual(await advanceLedger(api, a.sha, c.sha), {
			kind: "advanced",
			tip: c.sha,
		});
	});

	it("keeps blob, commit and read-back hashes fatal", async () => {
		for (const target of ["git/blobs", "git/commits"]) {
			const fake = new LedgerGit();
			const api = quietApi(fake.exec);

			fake.hook = (method, path) =>
				method === "POST" && path === target
					? {
							code: 0,
							stdout: JSON.stringify({ sha: "f".repeat(40) }),
							stderr: "",
						}
					: null;
			await assert.rejects(
				createLedgerRoot(api, ledgerDate),
				target === "git/blobs" ? /blob_mismatch/ : /commit_mismatch/,
			);
			assert.equal(fake.refs.size, 0);
		}

		const fake = new LedgerGit();
		const api = quietApi(fake.exec);
		const root = await createLedgerRoot(api, ledgerDate);
		const blob = gitObjectSha("blob", new Uint8Array());
		fake.blobs.set(blob, Buffer.from("tampered"));
		await assert.rejects(readLedgerFile(api, root.tree), /blob_mismatch/);

		fake.hook = (method, path) =>
			method === "GET" && path.startsWith("git/trees/")
				? {
						code: 0,
						stdout: JSON.stringify({
							sha: root.tree,
							truncated: true,
							tree: [],
						}),
						stderr: "",
					}
				: null;
		await assert.rejects(readLedgerFile(api, root.tree), /tree_truncated/);

		fake.hook = (method, path) =>
			method === "GET" && path.startsWith("git/trees/")
				? {
						code: 0,
						stdout: JSON.stringify({
							sha: root.tree,
							truncated: false,
							tree: [],
						}),
						stderr: "",
					}
				: null;
		await assert.rejects(readLedgerFile(api, root.tree), /ledger_file_missing/);

		fake.hook = (method, path) =>
			method === "GET" && path.startsWith("git/commits/")
				? {
						code: 0,
						stdout: JSON.stringify({
							sha: "f".repeat(40),
							tree: { sha: root.tree },
							parents: [],
						}),
						stderr: "",
					}
				: null;
		await assert.rejects(readLedgerCommit(api, root.sha), /object_mismatch/);

		fake.hook = (method, path) =>
			method === "GET" && path.startsWith("git/ref/")
				? {
						code: 0,
						stdout: JSON.stringify({
							ref: "refs/heads/factory/ledger-other",
							object: { sha: root.sha },
						}),
						stderr: "",
					}
				: null;
		await assert.rejects(ledgerRef(api), /malformed_ref/);
		fake.hook = null;
		const absent = "a".repeat(40);
		assert.ok(isGitSha(absent));
		await assert.rejects(readLedgerCommit(api, absent), /object_missing/);
	});
});
