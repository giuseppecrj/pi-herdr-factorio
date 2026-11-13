import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import {
	mkdtempSync,
	mkdirSync,
	readFileSync,
	rmSync,
	statSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { checkoutBuildWorkspace } from "../../../host/controller/checkout.ts";
import { fileLedgerOutbox } from "../../../host/controller/outbox.ts";
import { fileRunFiles } from "../../../host/controller/run-files.ts";
import { pinVerification } from "../../../host/controller/state.ts";
import { readRunCharges } from "../../../host/controller/terminal.ts";
import { digestOf } from "../../../src/core/run.ts";
import { isGitSha } from "../../../src/config/schema.ts";
import { isRepoSlug } from "../../../src/trust/platform.ts";
import { EXE_DEV_PLATFORM } from "../../../src/trust/platform.ts";
import { TRUSTED_WORKFLOW } from "../../fake-ticket-adapter.ts";

const repo = "nublai/pi-herdr-factorio";
const sha = "a".repeat(40);

if (!isRepoSlug(repo) || !isGitSha(sha)) throw new Error("fixture");

const runId = digestOf("host-controller-pin");

function fixture() {
	const root = mkdtempSync(join(tmpdir(), "host-controller-pin-"));

	return { root, remove: () => rmSync(root, { recursive: true, force: true }) };
}

test("host pin prepares trusted policy and restores pristine checkout without a second fetch", async () => {
	const { root, remove } = fixture();

	try {
		const source = join(root, "source");
		mkdirSync(join(source, "repo/.github/factory/gates"), { recursive: true });
		writeFileSync(
			join(source, "repo/.github/factory/WORKFLOW.md"),
			TRUSTED_WORKFLOW,
		);
		writeFileSync(
			join(source, "repo/.github/factory/gates/gates.json"),
			"{}\n",
		);
		writeFileSync(join(source, "repo/README.md"), "original\n");
		const archive = execFileSync("tar", ["-czf", "-", "-C", source, "repo"]);
		let fetched = 0;

		const fetch = async () => {
			fetched++;

			return archive;
		};

		const state = join(root, "state");
		mkdirSync(state, { mode: 0o700 });
		const files = fileRunFiles(state, { fetch, platform: EXE_DEV_PLATFORM });
		assert.equal(
			await files.prepareRun?.({
				runId,
				repo,
				workflowSha: sha,
				workflowDigest: digestOf(TRUSTED_WORKFLOW),
				startedAt: "2026-11-12T00:00:00.000Z",
				runTokenCap: null,
			}),
			true,
		);
		const policy = await files.accounting?.start(runId);
		assert.equal(policy?.context.kind, "production");
		assert.equal(await files.ensureWorkspace(runId), "created");

		const input = {
			stateDir: state,
			runId,
			repo,
			sha,
			workspace: files.workspacePath(runId),
			fetch,
		};

		const first = await checkoutBuildWorkspace(input);
		assert.equal(first.kind, "ready");

		if (first.kind !== "ready") assert.fail("checkout");
		assert.equal(await first.checkout.read("README.md", 100), "original\n");
		writeFileSync(join(input.workspace, "README.md"), "candidate edit\n");
		const restored = await checkoutBuildWorkspace(input);
		assert.equal(restored.kind, "ready");

		if (restored.kind !== "ready") assert.fail("restore");
		assert.equal(await restored.checkout.read("README.md", 100), "original\n");
		assert.equal(fetched, 2);
		assert.equal(
			statSync(join(state, "build-base/checkouts", `${runId}.json`)).mode &
				0o777,
			0o600,
		);
		assert.equal(
			statSync(join(state, "accounting", runId, "policy.json")).mode & 0o777,
			0o600,
		);
	} finally {
		remove();
	}
});

test("host pin recovers claims, pending terminal outbox and token floors in a fresh process", async () => {
	const { root, remove } = fixture();

	try {
		const files = fileRunFiles(root);

		const claim = {
			runId,
			issue: 42,
			eventId: "99",
			seq: 1,
			status: "failed" as const,
			stage: "build" as const,
			attempt: 1,
			usage: 73,
		};

		assert.equal(await files.writeClaim(claim), true);
		assert.equal(await files.writeLink(runId, null), true);
		const snapshot = { v: 1, terminalObservedAt: "2026-11-12T00:00:00.000Z" };
		const outbox = fileLedgerOutbox(root);
		assert.equal(await outbox.prepare(runId, snapshot), true);
		assert.equal(
			await outbox.retry(runId, {
				attempts: 2,
				nextAt: 500,
				reason: "transport_unavailable",
				blocked: false,
			}),
			true,
		);

		const read = execFileSync(
			process.execPath,
			[
				"--experimental-strip-types",
				"--input-type=module",
				"-e",
				`
			import { fileRunFiles } from ${JSON.stringify(new URL("../../../host/controller/run-files.ts", import.meta.url).href)};
			import { fileLedgerOutbox } from ${JSON.stringify(new URL("../../../host/controller/outbox.ts", import.meta.url).href)};
			import { readRunCharges } from ${JSON.stringify(new URL("../../../host/controller/terminal.ts", import.meta.url).href)};
			const files = fileRunFiles(${JSON.stringify(root)});
			const claims = await files.listClaims();
			console.log(JSON.stringify({ claims, link: await files.readLink(${JSON.stringify(runId)}), jobs: await fileLedgerOutbox(${JSON.stringify(root)}).scan(), charges: await readRunCharges(${JSON.stringify(root)}, ${JSON.stringify(runId)}, 73) }));
		`,
			],
			{ encoding: "utf8" },
		);

		const expected = {
			claims: [claim],
			link: { kind: "unlinked" },
			jobs: await outbox.scan(),
			charges: await readRunCharges(root, runId, 73),
		};

		assert.equal(read, `${JSON.stringify(expected)}\n`);
		assert.equal(
			readFileSync(join(root, "ledger", runId, "terminal.json"), "utf8"),
			`${JSON.stringify(snapshot)}\n`,
		);

		for (const path of [
			join(root, "claims", `${runId}.json`),
			join(root, "links", `${runId}.json`),
			join(root, "ledger", runId, "terminal.json"),
			join(root, "ledger", runId, "retry.json"),
		]) {
			assert.equal(statSync(path).mode & 0o777, 0o600);
		}
	} finally {
		remove();
	}
});

test("host pin keeps corrupt claims out and blocks a corrupt outbox job without dropping its neighbor", async () => {
	const { root, remove } = fixture();

	try {
		const other = digestOf("neighbor");
		const files = fileRunFiles(root);

		const claim = {
			runId,
			issue: 42,
			eventId: "99",
			seq: null,
			status: null,
			stage: null,
			attempt: null,
			usage: null,
		};

		assert.equal(await files.writeClaim(claim), true);
		writeFileSync(join(root, "claims", `${other}.json`), JSON.stringify(claim));
		assert.deepEqual(await files.listClaims(), [claim]);
		const outbox = fileLedgerOutbox(root);

		for (const id of [runId, other])
			assert.equal(
				await outbox.prepare(id, {
					terminalObservedAt: "2026-11-12T00:00:00.000Z",
				}),
				true,
			);
		writeFileSync(join(root, "ledger", runId, "row.json"), "corrupt\n");
		const jobs = await outbox.scan();
		assert.equal(jobs?.length, 2);
		assert.equal(
			jobs?.find((job) => job.runId === runId)?.retry?.reason,
			"state_invalid",
		);
		assert.equal(
			jobs?.find((job) => job.runId === runId)?.retry?.blocked,
			true,
		);
		assert.equal(jobs?.find((job) => job.runId === other)?.retry, null);
	} finally {
		remove();
	}
});

test("host pin binds verification bytes before other state exists", async () => {
	const { root, remove } = fixture();

	try {
		const wanted = { repo, issues: [42, 1, 42], tokenCap: 600_000 };
		const result = await pinVerification(root, wanted);
		assert.equal(result.kind, "pinned");
		const text = `${JSON.stringify({ v: 1, repo, issues: [1, 42], tokenCap: 600_000 })}\n`;
		assert.equal(readFileSync(join(root, "verification.json"), "utf8"), text);
		assert.equal(statSync(join(root, "verification.json")).mode & 0o777, 0o600);
		assert.deepEqual(
			await pinVerification(root, { ...wanted, issues: [1, 42] }),
			result,
		);
		assert.deepEqual(await pinVerification(root, null), {
			kind: "refused",
			reason: "verification_state",
		});
		assert.deepEqual(await pinVerification(root, { ...wanted, tokenCap: 1 }), {
			kind: "refused",
			reason: "verification_manifest_mismatch",
		});
	} finally {
		remove();
	}
});
