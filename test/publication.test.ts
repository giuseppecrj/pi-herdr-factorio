import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
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
} from "../src/build.ts";
import {
	controllerValidator,
	sweepValidation,
	fileRunFiles,
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
			this.refs.delete(path.slice("git/refs/heads/".length));

			return ok();
		}

		if (path.endsWith("/dispatches")) {
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
			receipt: async () => fake.receipt(),
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

				return true;
			},
		});

	return { root, base, patch, fake, step, state: () => state, archive };
}

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
		assert.ok(validation);
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
