import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { parseArgs } from "node:util";
import {
	type PlatformProfile,
	soleRepository,
} from "../../src/trust/platform.ts";
import { isGitSha } from "../../src/config/schema.ts";
import { parseWorkflow } from "../../src/config/parse.ts";
import type { Exec } from "../../src/github/exec.ts";
import { readLock } from "../controller/state.ts";
import { digestOf } from "../../src/core/run.ts";
import {
	checkReplay,
	decideReplayBudget,
	loadReplayCorpus,
	readReplayBudget,
	readReplayRecord,
	REPLAY_CORPUS,
	REPLAY_RUN_CAP,
	replayReport,
	replayRow,
} from "../../src/maintenance/replay.ts";
import { readdir, readlink } from "node:fs/promises";
import { join } from "node:path";
import { manifestDigest } from "../bundle/manifest.ts";
import { type CliIo, EXIT, USAGE } from "./platform.ts";

export async function runReplayCli(
	argv: readonly string[],
	io: CliIo,
	platform: PlatformProfile,
): Promise<number> {
	let parsed;

	try {
		parsed = parseArgs({
			args: [...argv],
			allowPositionals: true,
			strict: true,
			options: {
				json: { type: "boolean" },
				corpus: { type: "string" },
				case: { type: "string" },
				"main-sha": { type: "string" },
				"previous-sha": { type: "string" },
				"candidate-sha": { type: "string" },
				"production-state-dir": { type: "string" },
				"budget-file": { type: "string" },
				"previous-row": { type: "string" },
				"candidate-row": { type: "string" },
				"previous-record": { type: "string" },
				"candidate-record": { type: "string" },
				"bundle-root": { type: "string" },
				side: { type: "string" },
				"previous-assets": { type: "string" },
				"candidate-assets": { type: "string" },
			},
		});
	} catch {
		io.stderr(`unrecognized replay options\n${USAGE}\n`);

		return EXIT.usage;
	}

	const { values: v, positionals } = parsed;
	const [action] = positionals;

	if (
		v.json !== true ||
		positionals.length !== 1 ||
		(action !== "check" && action !== "report")
	) {
		io.stderr(`replay requires check or report and --json\n${USAGE}\n`);

		return EXIT.usage;
	}

	try {
		const corpus = await loadReplayCorpus(resolve(v.corpus ?? REPLAY_CORPUS));

		const selected =
			v.case === undefined ? null : corpus.cases.find((c) => c.id === v.case);

		if (selected === undefined) throw new Error("replay_case_unknown");

		const pin = async (value: string | undefined, fallback: string) => {
			if (value !== undefined) {
				if (!isGitSha(value)) throw new Error("replay_sha_required");

				return value;
			}

			const result = await io.exec("git", [
				"rev-parse",
				"--verify",
				`${fallback}^{commit}`,
			]);

			const sha = result.stdout.trim();

			if (result.code !== 0 || !isGitSha(sha))
				throw new Error("replay_sha_unavailable");

			return sha;
		};

		if (action === "report") {
			if (
				selected === null ||
				v["previous-row"] === undefined ||
				v["candidate-row"] === undefined ||
				v["previous-record"] === undefined ||
				v["candidate-record"] === undefined ||
				v["previous-sha"] === undefined ||
				v["candidate-sha"] === undefined
			)
				throw new Error("replay_report_inputs_required");

			const previous = {
				headSha: await pin(v["previous-sha"], "HEAD"),
				row: replayRow(await readFile(resolve(v["previous-row"]))),
				record: readReplayRecord(
					await readFile(resolve(v["previous-record"]), "utf8"),
				),
			};

			const candidate = {
				headSha: await pin(v["candidate-sha"], "HEAD"),
				row: replayRow(await readFile(resolve(v["candidate-row"]))),
				record: readReplayRecord(
					await readFile(resolve(v["candidate-record"]), "utf8"),
				),
			};

			if (
				previous.record.caseId !== selected.id ||
				candidate.record.caseId !== selected.id
			)
				throw new Error("replay_case_mismatch");

			const previousAssets = v["previous-assets"];
			const candidateAssets = v["candidate-assets"];

			if (
				(previousAssets === undefined) !== (candidateAssets === undefined) ||
				[previousAssets, candidateAssets].some(
					(d) => d !== undefined && !/^[a-f0-9]{64}$/.test(d),
				)
			)
				throw new Error("replay_assets_invalid");
			io.stdout(
				`${JSON.stringify({ caseId: selected.id, expectedRound: selected.expectedRound, ...replayReport({ previous, candidate, expected: selected.expected, history: platform.historicalRepositories, expectedAssets: previousAssets === undefined || candidateAssets === undefined ? undefined : { previous: previousAssets, candidate: candidateAssets } }) }, null, 2)}\n`,
			);

			return EXIT.ok;
		}

		const mainSha = await pin(v["main-sha"], "refs/remotes/origin/main");

		const previousSha = await pin(
			v["previous-sha"],
			"refs/remotes/origin/main",
		);

		const candidateSha = await pin(v["candidate-sha"], "HEAD");

		const report = await checkReplay({
			corpus,
			mainSha,
			previousSha,
			candidateSha,
			exec: io.exec,
		});

		const reasons: string[] = [];
		let production = "not_checked";

		if (v["production-state-dir"] !== undefined) {
			const lock = await readLock(resolve(v["production-state-dir"]));
			production = lock.kind;

			if (lock.kind === "socket_bound")
				reasons.push("production_controller_running");

			if (lock.kind === "unreadable")
				reasons.push("production_lock_unavailable");
		}

		const source = await io.exec("git", [
			"show",
			`${mainSha}:.github/factory/WORKFLOW.md`,
		]);

		const repo = soleRepository(platform);

		if (repo === null) throw new Error("replay_repository_ambiguous");

		const policy =
			source.code === 0
				? parseWorkflow({ text: source.stdout, repo, env: io.env, platform })
				: null;

		const cap =
			policy?.kind === "valid"
				? (policy.config.replay?.maxTokens ?? null)
				: null;

		const budget =
			v["budget-file"] === undefined
				? null
				: await readReplayBudget(resolve(v["budget-file"]));

		const budgetDecision = decideReplayBudget(
			budget ?? {
				v: 1,
				maxTokens: null,
				policyChanges: [],
				reservations: [],
				chargedTokens: 0,
				wallMs: 0,
			},
			cap,
		);

		reasons.push(
			...budgetDecision.reasons.filter(
				(reason) => reason !== "replay_disabled" || selected !== null,
			),
		);

		if (selected !== null) {
			const c = report.cases.find((entry) => entry.id === selected.id);

			if (c?.status !== "ready")
				reasons.push(c?.status ?? "replay_case_unknown");

			if (v["budget-file"] === undefined)
				reasons.push("replay_budget_required");

			if (v["production-state-dir"] === undefined)
				reasons.push("production_lock_required");

			if (report.bundle === "unavailable") reasons.push("bundle_unavailable");

			if (
				v["bundle-root"] !== undefined &&
				v["previous-assets"] !== undefined &&
				v["candidate-assets"] !== undefined &&
				v.side !== undefined
			) {
				await checkReplayBundles({
					root: resolve(v["bundle-root"]),
					previousSha,
					candidateSha,
					previousAssets: v["previous-assets"],
					candidateAssets: v["candidate-assets"],
					side: v.side,
					exec: io.exec,
				});
			} else if (report.bundle === "bundle_switch_required")
				reasons.push("bundle_switch_required");
		}

		io.stdout(
			`${JSON.stringify({ ...report, production, policy: policy?.kind === "valid" ? { workflowSha: mainSha, workflowDigest: digestOf(source.stdout) } : null, budget: { maxTokens: cap, perRunCap: REPLAY_RUN_CAP, chargedTokens: budget?.chargedTokens ?? null, remainingTokens: budget === null ? null : budgetDecision.remainingTokens, pendingPolicyChange: budgetDecision.pendingPolicyChange === null ? null : { ...budgetDecision.pendingPolicyChange, workflowDigest: digestOf(source.stdout), mainSha }, wallMs: budget?.wallMs ?? null }, reasons, allowed: selected === null ? null : reasons.length === 0 }, null, 2)}\n`,
		);

		return reasons.length === 0 &&
			!report.cases.some((c) => c.status === "unavailable")
			? EXIT.ok
			: EXIT.invalid;
	} catch (error) {
		const code =
			error instanceof Error && /^[a-z_]+$/.test(error.message)
				? error.message
				: "replay_input_unavailable";

		io.stdout(`${JSON.stringify({ error: code, promotes: false })}\n`);

		return EXIT.invalid;
	}
}

const DIGEST = /^[a-f0-9]{64}$/;

const RELOCATION_RECIPE = {
	previous: "970b866bc26835ea435130320b0b5ed4a2c50fa393a0e4c94b1f7844134b91f2",
	candidate: "8b6dbcdc438bb3f77bfe88eb4ac4e1108d6e3547e32edd460a086a477c5d1846",
} as const;

function refuse(code: string): never {
	throw new Error(code);
}

/** Installed content is checked with trusted code, never by executing either factory. */
export async function checkReplayBundles(input: {
	readonly root: string;
	readonly previousSha: string;
	readonly candidateSha: string;
	readonly previousAssets: string;
	readonly candidateAssets: string;
	readonly side: string;
	readonly exec: Exec;
}): Promise<void> {
	const recipes: { path: string; digest: string }[] = [];

	for (const [sha, digest] of [
		[input.previousSha, input.previousAssets],
		[input.candidateSha, input.candidateAssets],
	]) {
		if (
			sha === undefined ||
			digest === undefined ||
			!isGitSha(sha) ||
			!DIGEST.test(digest)
		)
			refuse("replay_assets_invalid");
		const bundle = join(input.root, `assets-${digest}`);

		if ((await manifestDigest(bundle)) !== digest)
			refuse("replay_bundle_unavailable");

		const listed = await input.exec("git", [
			"ls-tree",
			"-r",
			"--name-only",
			sha,
			"--",
			"skills",
			"host/bundle/assets",
			"server/sandbox/assets",
		]);

		if (listed.code !== 0 || listed.stdout.trim() === "")
			refuse("replay_bundle_source_unavailable");

		const sourceSkills = listed.stdout
			.trim()
			.split("\n")
			.filter(
				(path) => path.startsWith("skills/") && path.split("/").length === 3,
			)
			.sort();

		const installedSkills: string[] = [];

		for (const skill of await readdir(join(bundle, "skills"), {
			withFileTypes: true,
		})) {
			if (!skill.isDirectory()) refuse("replay_stale_bundle");

			for (const file of await readdir(join(bundle, "skills", skill.name), {
				withFileTypes: true,
			})) {
				if (!file.isFile()) refuse("replay_stale_bundle");
				installedSkills.push(`skills/${skill.name}/${file.name}`);
			}
		}

		if (JSON.stringify(sourceSkills) !== JSON.stringify(installedSkills.sort()))
			refuse("replay_stale_bundle");

		const assetRoot = listed.stdout
			.split("\n")
			.some((path) => path.startsWith("host/bundle/assets/"))
			? "host/bundle/assets"
			: "server/sandbox/assets";

		const assets = new Map([
			[`${assetRoot}/pi.ts`, "sandbox/pi.ts"],
			[`${assetRoot}/stage-init.ts`, "sandbox/stage-init.ts"],
			[`${assetRoot}/package.json`, "pkg/package.json"],
			[`${assetRoot}/package-lock.json`, "pkg/package-lock.json"],
		]);

		const recipePath =
			assetRoot === "host/bundle/assets"
				? "host/install/provision.sh"
				: "server/provision.sh";

		const recipe = await input.exec("git", ["show", `${sha}:${recipePath}`]);

		if (recipe.code !== 0) refuse("replay_bundle_recipe_mismatch");
		recipes.push({ path: recipePath, digest: digestOf(recipe.stdout) });

		for (const path of listed.stdout.trim().split("\n")) {
			const asset =
				path.startsWith("skills/") && path.split("/").length === 3
					? path
					: assets.get(path);

			if (asset === undefined) continue;
			const source = await input.exec("git", ["show", `${sha}:${path}`]);

			if (
				source.code !== 0 ||
				digestOf(await readFile(join(bundle, asset))) !==
					digestOf(source.stdout)
			)
				refuse("replay_stale_bundle");
		}
	}

	const recipe = await input.exec("git", [
		"diff",
		"--name-only",
		input.previousSha,
		input.candidateSha,
		"--",
		"host/install/provision.sh",
		"server/provision.sh",
	]);

	const relocation =
		recipes[0]?.path === "server/provision.sh" &&
		recipes[1]?.path === "host/install/provision.sh" &&
		recipes[0]?.digest === RELOCATION_RECIPE.previous &&
		recipes[1]?.digest === RELOCATION_RECIPE.candidate;

	if (
		recipe.code !== 0 ||
		(recipe.stdout.trim() !== "" &&
			input.previousAssets === input.candidateAssets &&
			!relocation)
	)
		refuse("replay_bundle_recipe_mismatch");

	const expected =
		input.side === "previous"
			? input.previousAssets
			: input.side === "candidate"
				? input.candidateAssets
				: refuse("replay_side_invalid");

	if ((await readlink(join(input.root, "current"))) !== `assets-${expected}`)
		refuse("replay_bundle_switch_required");
}
