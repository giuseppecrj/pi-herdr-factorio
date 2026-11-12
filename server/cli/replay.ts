import { readFile, readdir, readlink } from "node:fs/promises";
import { join } from "node:path";
import { isGitSha } from "../../src/config/schema.ts";
import { digestOf } from "../../src/core/run.ts";
import type { Exec } from "../../src/github/exec.ts";
import { manifestDigest } from "../sandbox/manifest.ts";

const DIGEST = /^[a-f0-9]{64}$/;

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

		const assets = new Map([
			["server/sandbox/assets/pi.ts", "sandbox/pi.ts"],
			["server/sandbox/assets/stage-init.ts", "sandbox/stage-init.ts"],
			["server/sandbox/assets/package.json", "pkg/package.json"],
			["server/sandbox/assets/package-lock.json", "pkg/package-lock.json"],
		]);

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
		"server/provision.sh",
	]);

	if (
		recipe.code !== 0 ||
		(recipe.stdout.trim() !== "" &&
			input.previousAssets === input.candidateAssets)
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
