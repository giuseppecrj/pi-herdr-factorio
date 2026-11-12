import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import {
	cpSync,
	existsSync,
	mkdirSync,
	mkdtempSync,
	readFileSync,
	readdirSync,
	rmSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, posix } from "node:path";
import { after, before, describe, it } from "node:test";
import { fileURLToPath } from "node:url";
import ts from "typescript";

const checkout = fileURLToPath(new URL("..", import.meta.url));

function packed(path: string): string {
	return join(scratch, "package", path);
}

let scratch = "";
let files: string[] = [];

/** Copies a declared dependency and, in turn, the dependencies it declares. */
function install(name: string, into: string): void {
	const target = join(into, name);

	if (existsSync(target)) return;
	const source = join(checkout, "node_modules", name);
	cpSync(source, target, { recursive: true, dereference: true });

	const manifest = JSON.parse(
		readFileSync(join(source, "package.json"), "utf8"),
	);

	for (const dependency of Object.keys(manifest.dependencies ?? {}))
		install(dependency, into);
}

function relativeImports(path: string): string[] {
	const info = ts.preProcessFile(
		readFileSync(packed(path), "utf8"),
		true,
		true,
	);

	return info.importedFiles
		.map((file) => file.fileName)
		.filter((name) => name.startsWith("./") || name.startsWith("../"));
}

describe("packed package", () => {
	before(() => {
		scratch = mkdtempSync(join(tmpdir(), "package-load-"));

		const [result] = JSON.parse(
			execFileSync(
				"npm",
				["pack", "--json", "--pack-destination", scratch, checkout],
				{
					cwd: scratch,
					encoding: "utf8",
					env: {
						...process.env,
						npm_config_cache: join(scratch, "npm-cache"),
						npm_config_update_notifier: "false",
					},
				},
			),
		);

		files = result.files.map((file: { path: string }) => file.path).sort();
		execFileSync("tar", ["-xzf", join(scratch, result.filename)], {
			cwd: scratch,
		});

		const manifest = JSON.parse(readFileSync(packed("package.json"), "utf8"));
		const modules = join(scratch, "package", "node_modules");
		mkdirSync(modules);

		for (const dependency of Object.keys(manifest.dependencies ?? {}))
			install(dependency, modules);
	});

	after(() => rmSync(scratch, { recursive: true, force: true }));

	it("ships the declared files and resolves every relative import inside the tarball", () => {
		assert.deepEqual(
			[...new Set(files.map((path) => path.split("/")[0]))].sort(),
			["LICENSE", "README.md", "extension", "package.json", "skills", "src"],
		);

		const unresolved = files
			.filter((path) => /\.(?:[cm]?[jt]s)$/.test(path))
			.flatMap((path) =>
				relativeImports(path)
					.map((specifier) =>
						posix.normalize(posix.join(posix.dirname(path), specifier)),
					)
					.filter((target) => !files.includes(target))
					.map((target) => `${path} -> ${target}`),
			);

		assert.deepEqual(unresolved, []);
	});

	it("loads every packaged module and registers /factory outside the checkout", () => {
		const modules = files.filter(
			(path) =>
				/^(?:src|extension)\/.*\.ts$/.test(path) && !path.endsWith(".d.ts"),
		);

		assert.ok(modules.includes("extension/index.ts"));
		assert.ok(readdirSync(join(scratch, "package", "node_modules")).length > 0);

		const program = `
const root = "file://" + process.cwd() + "/";
for (const path of ${JSON.stringify(modules)}) await import(new URL(path, root));
const { default: extension } = await import(new URL("extension/index.ts", root));
const commands = [];
extension({
	registerCommand: (name, options) => commands.push({ name, description: options.description }),
	sendMessage: () => {},
	exec: async () => ({ stdout: "", stderr: "", code: 1 }),
});
console.log(JSON.stringify(commands));
`;

		const output = execFileSync(
			process.execPath,
			["--experimental-strip-types", "--input-type=module", "-e", program],
			{
				cwd: join(scratch, "package"),
				encoding: "utf8",
				env: { PATH: process.env.PATH ?? "", HOME: scratch },
			},
		);

		assert.deepEqual(JSON.parse(output.trim().split("\n").at(-1) ?? ""), [
			{
				name: "factory",
				description:
					"Software factory: /factory status, /factory run <issue> (admission dry run)",
			},
		]);
	});
});
