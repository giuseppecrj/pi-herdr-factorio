import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import {
	mkdtempSync,
	chmodSync,
	readFileSync,
	writeFileSync,
	lstatSync,
	readdirSync,
	rmSync,
	unlinkSync,
	symlinkSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, describe, it } from "node:test";
import {
	ACCEPTANCE_MAX_BYTES,
	writeAcceptance,
	acceptanceDigestOf,
	acceptanceEntries,
	type AcceptanceSuite,
} from "../src/accept.ts";
import { ARTIFACT_ACCESS, fileArtifacts } from "../src/artifacts.ts";
import { digestOf } from "../src/run.ts";
import {
	type Contract,
	contractBytes,
	contractDigestOf,
} from "../src/specify.ts";
import { isGitSha, isRepoSlug } from "../src/workflow.ts";
import { fileRunFiles } from "../server/controller.ts";
import { bwrapArgv } from "../server/sandbox/bwrap.ts";

const repo = "giuseppecrj/pi-herdr-factorio";
const sha = "a".repeat(40);

if (!isRepoSlug(repo) || !isGitSha(sha)) throw new Error("fixture");

const contract: Contract = {
	version: 1,
	runId: digestOf("artifact-run"),
	issue: 1,
	base: { repo, sha },
	snapshot: {
		digest: digestOf("snapshot"),
		source: "unedited",
		eventId: "1",
		eventAt: "2026-10-30T00:00:00Z",
	},
	link: null,
	summary: "Version",
	behavior: ["Print version"],
	acceptance: [{ id: "A1", text: "Print version" }],
	exclusions: [],
	compatibility: [],
	limits: [],
	files: [],
	evidence: [],
};

const digest = contractDigestOf(contractBytes(contract));

const suite: AcceptanceSuite = {
	version: 1,
	scenarios: [
		{
			id: "S1",
			criteria: ["A1"],
			checks: ["a.test.ts", "b.test.ts"],
			judge: null,
		},
	],
	files: [
		{
			path: "a.test.ts",
			type: "node:test",
			content: "test('a', () => assert.ok(true));\n",
		},
		{
			path: "b.test.ts",
			type: "node:test",
			content: "test('b', () => assert.ok(true));\n",
		},
	],
};

const input = {
	contract,
	contractDigest: digest,
	suite,
	model: "openai/gpt-6.1-sol",
	observed: "openai/gpt-6.1-sol",
};

const roots: string[] = [];

const fresh = () => {
	const root = mkdtempSync(join(tmpdir(), "factory-artifacts-"));
	roots.push(root);

	return root;
};

after(() => {
	for (const root of roots) rmSync(root, { recursive: true, force: true });
});

describe("private acceptance artifacts", () => {
	it("hashes the exact named bytes in a stable order, including manifest and canary", () => {
		const reversed: AcceptanceSuite = {
			...suite,
			files: [...suite.files].reverse(),
			scenarios: suite.scenarios.map((s) => ({
				...s,
				checks: [...s.checks].reverse(),
			})),
		};

		assert.equal(
			acceptanceDigestOf(suite, "secret"),
			acceptanceDigestOf(reversed, "secret"),
		);
		assert.notEqual(
			acceptanceDigestOf(suite, "secret"),
			acceptanceDigestOf(suite, "changed"),
		);
		assert.notEqual(
			acceptanceDigestOf(suite, "secret"),
			acceptanceDigestOf(
				{
					...suite,
					files: suite.files.map((f) => ({ ...f, content: `${f.content} ` })),
				},
				"secret",
			),
		);
		assert.equal(
			acceptanceDigestOf(suite, "secret"),
			digestOf(JSON.stringify(acceptanceEntries(suite, "secret"))),
		);
	});
	it("stores once, verifies on restart and keeps every byte private", async () => {
		const root = fresh();
		const stored = await fileArtifacts(root).store(input);
		assert.equal(stored.kind, "found");

		const restored = await fileArtifacts(root).read(
			contract.runId,
			contract,
			digest,
		);

		assert.deepEqual(restored, stored);
		assert.deepEqual(await fileArtifacts(root).store(input), stored);

		const walk = (path: string) => {
			const stat = lstatSync(path);
			assert.equal(stat.mode & 0o777, stat.isDirectory() ? 0o700 : 0o600, path);

			if (stat.isDirectory())
				for (const name of readdirSync(path)) walk(join(path, name));
		};

		walk(join(root, "acceptance"));
		const dir = join(root, "acceptance", contract.runId);
		const canary = readFileSync(join(dir, "canary.txt"), "utf8").trim();
		assert.match(canary, /^factory-holdout-[0-9a-f]{64}$/);

		for (const path of ["suite.json", "checks/a.test.ts", "checks/b.test.ts"])
			assert.ok(readFileSync(join(dir, path), "utf8").includes(canary), path);
		assert.ok(
			!readFileSync(join(dir, "receipt.json"), "utf8").includes(canary),
		);

		if (stored.kind !== "found") throw new Error("not stored");
		assert.equal(stored.receipt.contractDigest, digest);
		assert.equal(
			stored.receipt.isolation,
			"context-isolated, same family, not cross-family",
		);
		assert.equal(stored.receipt.provider, "openai");
	});

	it("stores an exact-limit model payload and reuses it after restart", async () => {
		const paths = ["a.test.ts", "b.test.ts", "c.test.ts", "d.test.ts"];

		const boundary: AcceptanceSuite = {
			version: 1,
			scenarios: [{ id: "S1", criteria: ["A1"], checks: paths, judge: null }],
			files: paths.map((path) => ({ path, type: "node:test", content: "x" })),
		};

		let spare =
			ACCEPTANCE_MAX_BYTES - Buffer.byteLength(JSON.stringify(boundary));

		const files = boundary.files.map((file) => {
			const extra = Math.min(spare, 65535);
			spare -= extra;

			return { ...file, content: file.content + " ".repeat(extra) };
		});

		assert.equal(spare, 0);
		const legal = { ...boundary, files };
		assert.equal(
			Buffer.byteLength(JSON.stringify(legal)),
			ACCEPTANCE_MAX_BYTES,
		);
		assert.equal(
			writeAcceptance(JSON.stringify(legal), contract).kind,
			"suite",
		);
		const root = fresh();
		const stored = await fileArtifacts(root).store({ ...input, suite: legal });
		assert.equal(stored.kind, "found");
		assert.deepEqual(
			await fileArtifacts(root).read(contract.runId, contract, digest),
			stored,
		);
		assert.deepEqual(
			await fileArtifacts(root).store({ ...input, suite: legal }),
			stored,
		);
		assert.deepEqual(writeAcceptance(`${JSON.stringify(legal)} `, contract), {
			kind: "malformed",
			reason: "too_large",
		});
	});

	it("rejects an oversized suite before creating the regeneration guard", async () => {
		const root = fresh();
		assert.deepEqual(
			await fileArtifacts(root).store({
				...input,
				suite: {
					...suite,
					files: suite.files.map((f) => ({
						...f,
						content: "x".repeat(262144),
					})),
				},
			}),
			{ kind: "blocked", reason: "acceptance_invalid" },
		);
		assert.deepEqual(
			await fileArtifacts(root).read(contract.runId, contract, digest),
			{ kind: "absent" },
		);
		assert.equal((await fileArtifacts(root).store(input)).kind, "found");
	});

	it("runs the isolation detector's negative and positive controls", () => {
		const env = { ...process.env };
		delete env.NODE_TEST_CONTEXT;

		const result = spawnSync(
			process.execPath,
			["--test", "docs/prototypes/acceptance-isolation/self-test.mjs"],
			{ encoding: "utf8", env },
		);

		assert.equal(result.status, 0, result.stdout + result.stderr);
	});

	for (const mutation of [
		"changed",
		"missing",
		"manifest",
		"canary",
		"extra",
		"symlink",
		"directory",
		"mode",
		"directory-mode",
		"root-mode",
		"oversize",
	] as const) {
		it(`blocks ${mutation} bytes without regenerating`, async () => {
			const root = fresh();
			const store = fileArtifacts(root);
			assert.equal((await store.store(input)).kind, "found");
			const dir = join(root, "acceptance", contract.runId);
			const file = join(dir, "checks/a.test.ts");

			if (mutation === "changed") writeFileSync(file, "changed");

			if (mutation === "missing") unlinkSync(file);

			if (mutation === "manifest")
				writeFileSync(join(dir, "manifest.json"), "{}");

			if (mutation === "canary")
				writeFileSync(join(dir, "canary.txt"), "changed");

			if (mutation === "extra")
				writeFileSync(join(dir, "extra.txt"), "extra", { mode: 0o600 });

			if (mutation === "symlink") {
				unlinkSync(file);
				symlinkSync("/etc/passwd", file);
			}

			if (mutation === "directory") rmSync(dir, { recursive: true });

			if (mutation === "mode") chmodSync(file, 0o644);

			if (mutation === "directory-mode") chmodSync(join(dir, "checks"), 0o755);

			if (mutation === "root-mode") chmodSync(join(root, "acceptance"), 0o755);

			if (mutation === "oversize") writeFileSync(file, "x".repeat(300000));

			const result = await fileArtifacts(root).read(
				contract.runId,
				contract,
				digest,
			);

			assert.deepEqual(result, {
				kind: "blocked",
				reason:
					mutation === "missing" || mutation === "directory"
						? "acceptance_missing"
						: [
									"symlink",
									"mode",
									"directory-mode",
									"root-mode",
									"oversize",
								].includes(mutation)
							? "acceptance_invalid"
							: "acceptance_changed",
			});
			assert.deepEqual(await store.store(input), result);
		});
	}

	it("rejects a mismatched contract/base and a partial first write", async () => {
		const root = fresh();
		const store = fileArtifacts(root);
		await store.store(input);
		assert.deepEqual(
			await store.read(contract.runId, contract, contractDigestOf("other")),
			{ kind: "blocked", reason: "acceptance_invalid" },
		);
		unlinkSync(join(root, "acceptance", contract.runId, "receipt.json"));
		assert.deepEqual(await store.read(contract.runId, contract, digest), {
			kind: "blocked",
			reason: "acceptance_missing",
		});
	});
	it("checks contract receipt, exact bytes and bindings through RunFiles", async () => {
		const root = fresh();
		const files = fileRunFiles(root);
		assert.equal(
			await files.writeContract({
				contract,
				bytes: contractBytes(contract),
				digest,
			}),
			true,
		);
		assert.deepEqual(await files.readContract(contract.runId), {
			kind: "found",
			contract,
			digest,
		});
		writeFileSync(
			join(root, "contracts", contract.runId, "contract.json"),
			`${contractBytes(contract)} `,
		);
		assert.deepEqual(await files.readContract(contract.runId), {
			kind: "blocked",
			reason: "contract_changed",
		});
	});
	it("recovers a replacement-bearing contract without discarding its authorization", async () => {
		const root = fresh();

		const changed: Contract = {
			...contract,
			replacesTests: [
				{ path: "test/old.test.ts", reason: "Ticket changes this behavior" },
			],
		};

		const bytes = contractBytes(changed);
		const digest = contractDigestOf(bytes);

		assert.equal(
			await fileRunFiles(root).writeContract({
				contract: changed,
				bytes,
				digest,
			}),
			true,
		);
		assert.deepEqual(await fileRunFiles(root).readContract(changed.runId), {
			kind: "found",
			contract: changed,
			digest,
		});
	});
	it("has no oracle mount or inherited context in a build-profile layout", () => {
		assert.deepEqual(ARTIFACT_ACCESS.build, ["contract", "scenario-ids"]);

		const argv = bwrapArgv({
			bundleDir: "/bundle",
			workspaceDir: "/state/workspaces/run",
			workspaceHasGit: false,
			agentDir: "/state/stages/run/build-1/agent-0",
			socketPath: "/state/gw/fresh/gw.sock",
			seccompFd: 10,
			tools: ["read", "grep", "ls", "bash", "write", "edit"],
			command: ["/opt/factory/bin/pi"],
		});

		assert.ok(!argv.join(" ").includes("acceptance"));
		assert.ok(!argv.join(" ").includes("specify-1"));
		assert.ok(!argv.join(" ").includes("accept-1"));
		assert.ok(argv.includes("--clearenv"));
		assert.ok(argv.includes("--unshare-all"));
		assert.ok(argv.includes("--tmpfs"));
		assert.ok(
			!readFileSync("server/sandbox/bwrap.ts", "utf8").includes("acceptance"),
		);
	});
});
