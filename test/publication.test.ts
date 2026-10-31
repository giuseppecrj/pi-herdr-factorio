import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { execFileSync, spawnSync } from "node:child_process";
import {
	mkdtempSync,
	mkdirSync,
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
	candidateBranch,
	publishCandidate,
	gitObjectSha,
	BOT_EMAIL,
} from "../src/publication.ts";
import { digestOf, REQUIRED_CI_CHECKS } from "../src/run.ts";
import { type Exec, type ExecResult } from "../src/gh.ts";
import {
	fieldOf,
	objectOf,
	parseJson,
	textOf,
	arrayOf,
	type JsonValue,
} from "../server/sandbox/json.ts";
import { isGitSha, isRepoSlug } from "../src/workflow.ts";
import {
	type Contract,
	contractBytes,
	contractDigestOf,
} from "../src/specify.ts";
import { type AcceptanceSuite } from "../src/accept.ts";
import { fileArtifacts } from "../src/artifacts.ts";
import {
	collectPatch,
	storePatch,
	finishPatch,
	prepareRepairTree,
	publicationTree,
} from "../src/build.ts";
import {
	controllerValidator,
	sweepValidation,
	fileRunFiles,
	downloadGateReceipt,
} from "../server/controller.ts";
import { type ValidationState } from "../src/validation.ts";
import { CONTROLLER_LOGIN } from "../src/markers.ts";

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

class GitData {
	main = baseSha;
	refs = new Map<string, string>();
	commits = new Map<
		string,
		{ parent: string; message: string; tree: string }
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
			const parent = textOf(arrayOf(fieldOf(body, "parents"))?.[0]) ?? "";
			const message = textOf(fieldOf(body, "message")) ?? "";
			const actor = objectOf(fieldOf(body, "author"));
			const date = textOf(fieldOf(actor, "date")) ?? "";
			const identity = `${CONTROLLER_LOGIN} <${BOT_EMAIL}> ${Date.parse(date) / 1000} +0000`;
			assert.deepEqual(fieldOf(body, "committer"), actor);

			const sha = gitObjectSha(
				"commit",
				Buffer.from(
					`tree ${tree}\nparent ${parent}\nauthor ${identity}\ncommitter ${identity}\n\n${message}`,
				),
			);

			this.commits.set(sha, { parent, tree, message });

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
	it("publishes patch then suite, and adopts the same branch without moving it", async () => {
		const fake = new GitData();

		const api = new GitHubPublicationApi(
			fake.exec,
			repo,
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
				new GitHubPublicationApi(fake.exec, repo),
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
				new GitHubPublicationApi(fake.exec, repo),
				publicationInput,
			),
			/commit_mismatch/,
		);
		assert.equal(fake.refs.size, 0);
	});
	it("does not accept DELETE 422 while the owned ref still exists", async () => {
		const fake = new GitData();

		const publication = await publishCandidate(
			new GitHubPublicationApi(fake.exec, repo),
			publicationInput,
		);

		fake.hook = (args) =>
			args.includes("DELETE")
				? { code: 1, stdout: "", stderr: "HTTP 422" }
				: null;
		await assert.rejects(
			new GitHubPublicationApi(fake.exec, repo).remove(
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
				counters,
				async () => true,
				async () => {},
			);

			await assert.rejects(api.request("GET", "git/ref/heads/main"));
			assert.equal(fake.requests.length, status === 403 ? 1 : 3);
		}
	});
});

async function validationFixture() {
	const root = fresh();
	const base = join(root, "source");
	mkdirSync(base);
	mkdirSync(join(base, "src"));
	writeFileSync(join(base, "src/a.ts"), "export const a = 1;\n");
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

	const contract: Contract = {
		version: 1,
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
		acceptance: [{ id: "A1", text: "Return 2" }],
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
		version: 1,
		scenarios: [
			{ id: "S1", criteria: ["A1"], checks: ["a.test.ts"], judge: null },
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
	let state: ValidationState | null = null;

	const step = (now = Date.parse("2026-10-31T00:00:00Z"), fetch = archive) =>
		controllerValidator({
			stateDir: root,
			exec: fake.exec,
			fetch: async () => fetch,
			receipt: async () => (fake.receiptMissing ? null : fake.receipt()),
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
		step,
		state: () => state,
		archive,
	};
}

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
			const input = JSON.parse(process.argv[1]);
			const exec = async (_, args) => {
				if (args.includes('DELETE')) process.kill(process.pid, 'SIGKILL');
				const path = args.find(a => a.startsWith('repos/'));
				const value = path.includes('/git/ref/') ? {object:{sha:input.state.publication.candidateSha}} : input.run;
				return {code:0,stdout:JSON.stringify(value),stderr:''};
			};
			await controllerValidator({stateDir:input.root,exec,receipt:async()=>input.receipt})({
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
		await sweepValidation({ stateDir: f.root, exec: f.fake.exec });
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

		await assert.rejects(downloadGateReceipt(exec, repo, 123));
		failures = false;
		assert.equal(
			await downloadGateReceipt(exec, repo, 123),
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
				stateDir: f.root,
				exec: f.fake.exec,
				now: () => start + 30_000,
			});
			assert.equal(f.fake.requests.length, calls + 1);
			assert.equal(f.fake.refs.size, 1);
			await sweepValidation({
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
});
