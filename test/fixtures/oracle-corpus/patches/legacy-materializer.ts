import { cpSync, existsSync, globSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { materializeFromDirectories } from "../../../../host/gates/materialize.ts";
import type { ReplacedTest } from "../../../../src/contract/contract.ts";

const SOURCE = ["src/", "extension/", "server/", "skills/"];

function documentation(path: string): boolean {
	return (
		path.endsWith(".md") &&
		!path.startsWith(".github/") &&
		!path.startsWith("test/acceptance/") &&
		!SOURCE.some((dir) => path.startsWith(dir))
	);
}

export function legacyMaterialize(input: {
	readonly gateTree: string;
	readonly candidateTree: string;
	readonly dest: string;
	readonly replacements: readonly ReplacedTest[];
	readonly heldoutDir: string;
	readonly heldoutDigest: string;
}) {
	const current = materializeFromDirectories(input);
	const ignored = new Set(current.ignoredChanges);

	const paths = new Set(
		[input.gateTree, input.candidateTree].flatMap((root) =>
			globSync("**/*.md", { cwd: root }).filter(documentation),
		),
	);

	for (const path of paths) {
		const gate = join(input.gateTree, path),
			candidate = join(input.candidateTree, path);

		if (
			existsSync(gate) &&
			existsSync(candidate) &&
			readFileSync(gate).equals(readFileSync(candidate))
		)
			continue;

		if (existsSync(candidate)) ignored.add(path);
		rmSync(join(input.dest, path), { force: true });

		if (existsSync(gate)) cpSync(gate, join(input.dest, path));
	}

	return { ...current, ignoredChanges: [...ignored].sort() };
}
