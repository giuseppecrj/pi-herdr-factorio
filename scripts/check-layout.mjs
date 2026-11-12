import { execFileSync } from "node:child_process";
import { lstatSync, readdirSync, readFileSync, realpathSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join, matchesGlob, posix, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

export const CATEGORIES = [
	"imports",
	"classification",
	"readers",
	"shell",
	"discovery",
	"navigation",
	"citations",
];

const CODE = /\.(?:[cm]?[jt]s|tsx)$/;
const TEST = /\.test\.[cm]?[jt]sx?$/;
const CASES = /\.cases\.[cm]?[jt]s$/;
const SKIPPED_DIRS = new Set([".git", "node_modules"]);

const PATH_ROOTS =
	"(?:src|server|host|test|docs|scripts|extension|skills|tools|research|\\.pi|\\.github)\\/[\\w./-]*\\w";

const ROOT_FILES =
	"AGENTS\\.md|README\\.md|DESIGN\\.md|LICENSE|package\\.json|package-lock\\.json|tsconfig\\.json|biome\\.json|\\.oxlintrc\\.json";

const CITED_PATH = `(?<![\\w./@-])(${PATH_ROOTS}|${ROOT_FILES})`;

const COLON_CITATION = new RegExp(
	`${CITED_PATH}:(\\d+)(?:[-–](\\d+))?(?![\\w])`,
	"g",
);

const WORD_CITATION = new RegExp(
	`\`${CITED_PATH}\` lines? (\\d+)(?:(?:-|–| to | and )(\\d+))?`,
	"g",
);

const PINNED_CITATION =
	/(?<![\w./-])([0-9a-f]{7,40}):((?:[\w.-]+\/)*[\w.-]+):(\d+)(?:[-–](\d+))?(?![\w])/g;

const GITHUB_CITATION =
	/https:\/\/github\.com\/nublai\/pi-herdr-factorio\/blob\/([^/\s]+)\/([^\s#)>]+)#L(\d+)(?:-L(\d+))?/g;

const SHELL_TOKEN =
	/(?<![\w.-])(?:\.\/)?(?:src|server|host|test|docs|skills|scripts|extension|tools|research|\.pi|\.github|node_modules)\/[\w./*-]*/g;

const HEREDOC_IMPORT = /import\s*\{([^}]*)\}\s*from\s*'(\.\/[^']+)'/g;

export function repoFiles(root) {
	let top = "";

	try {
		top = execFileSync("git", ["-C", root, "rev-parse", "--show-toplevel"], {
			encoding: "utf8",
			stdio: ["ignore", "pipe", "ignore"],
		}).trim();
	} catch {
		top = "";
	}

	if (top !== "" && realpathSync(top) === realpathSync(root)) {
		const listed = execFileSync(
			"git",
			[
				"-C",
				root,
				"ls-files",
				"-z",
				"--cached",
				"--others",
				"--exclude-standard",
			],
			{ encoding: "utf8", maxBuffer: 64 * 1024 * 1024 },
		)
			.split("\0")
			.filter(
				(path) =>
					path !== "" &&
					!path.split("/").some((part) => SKIPPED_DIRS.has(part)) &&
					exists(join(root, path)),
			);

		return [...new Set(listed)].sort();
	}

	const found = [];

	const walk = (dir) => {
		for (const entry of readdirSync(join(root, dir), { withFileTypes: true })) {
			if (SKIPPED_DIRS.has(entry.name)) continue;
			const path = dir === "" ? entry.name : `${dir}/${entry.name}`;

			if (entry.isDirectory()) walk(path);
			else found.push(path);
		}
	};

	walk("");

	return found.sort();
}

function exists(path) {
	try {
		lstatSync(path);

		return true;
	} catch {
		return false;
	}
}

function lineCount(text) {
	const lines = text.split("\n").length;

	return text.endsWith("\n") ? lines - 1 : lines;
}

function normalized(text) {
	return text.replace(/\s+/g, " ");
}

function occurrences(text, token) {
	let count = 0;

	for (
		let at = text.indexOf(token);
		at >= 0;
		at = text.indexOf(token, at + token.length)
	)
		count++;

	return count;
}

function parsed(path, text) {
	try {
		return JSON.parse(text);
	} catch (error) {
		throw new Error(`${path} is not valid JSON: ${error.message}`);
	}
}

function isText(value) {
	return (
		value !== undefined &&
		value !== null &&
		String(value) === value &&
		value !== ""
	);
}

function context(root) {
	const files = repoFiles(root);
	const set = new Set(files);
	const texts = new Map();

	const read = (path) => {
		if (!texts.has(path))
			texts.set(path, readFileSync(join(root, path), "utf8"));

		return texts.get(path);
	};

	const isDir = (path) =>
		path === "." || files.some((file) => file.startsWith(`${path}/`));

	const kindOf = (path) =>
		set.has(path) ? "file" : isDir(path) ? "dir" : "missing";

	return {
		root,
		files,
		set,
		read,
		kindOf,
		baseline: parsed(
			"scripts/layout-baseline.json",
			read("scripts/layout-baseline.json"),
		),
	};
}

function globbed(path, patterns) {
	return patterns.some((pattern) => matchesGlob(path, pattern));
}

let typescript = null;

function ts() {
	typescript ??= createRequire(import.meta.url)("typescript");

	return typescript;
}

function specifiers(file, text) {
	const api = ts();

	const source = api.createSourceFile(
		file,
		text,
		api.ScriptTarget.Latest,
		true,
	);

	const found = [];

	const visit = (node) => {
		if (
			(api.isImportDeclaration(node) || api.isExportDeclaration(node)) &&
			node.moduleSpecifier !== undefined &&
			api.isStringLiteralLike(node.moduleSpecifier)
		)
			found.push({
				specifier: node.moduleSpecifier.text,
				bare: api.isImportDeclaration(node) && node.importClause === undefined,
			});
		else if (
			api.isImportTypeNode(node) &&
			api.isLiteralTypeNode(node.argument) &&
			api.isStringLiteralLike(node.argument.literal)
		)
			found.push({ specifier: node.argument.literal.text, bare: false });
		else if (
			api.isCallExpression(node) &&
			node.expression.kind === api.SyntaxKind.ImportKeyword &&
			node.arguments[0] !== undefined &&
			api.isStringLiteralLike(node.arguments[0])
		)
			found.push({ specifier: node.arguments[0].text, bare: false });
		api.forEachChild(node, visit);
	};

	visit(source);

	return found;
}

function exportedNames(file, text) {
	const api = ts();

	const source = api.createSourceFile(
		file,
		text,
		api.ScriptTarget.Latest,
		true,
	);

	const names = new Set();

	for (const statement of source.statements) {
		const exported = (statement.modifiers ?? []).some(
			(m) => m.kind === api.SyntaxKind.ExportKeyword,
		);

		if (
			api.isExportDeclaration(statement) &&
			statement.exportClause !== undefined
		) {
			if (api.isNamedExports(statement.exportClause))
				for (const element of statement.exportClause.elements)
					names.add(element.name.text);
		} else if (exported && api.isVariableStatement(statement)) {
			for (const declaration of statement.declarationList.declarations)
				if (api.isIdentifier(declaration.name))
					names.add(declaration.name.text);
		} else if (
			exported &&
			statement.name !== undefined &&
			api.isIdentifier(statement.name)
		)
			names.add(statement.name.text);
	}

	return names;
}

function importGraph(ctx) {
	const { exclude, exceptions } = ctx.baseline.imports;
	const graph = new Map();
	const used = new Set();

	for (const file of ctx.files) {
		if (!CODE.test(file) || file.endsWith(".d.ts") || globbed(file, exclude))
			continue;
		const edges = [];

		for (const { specifier, bare } of specifiers(file, ctx.read(file))) {
			if (!specifier.startsWith("./") && !specifier.startsWith("../")) continue;

			const exception = exceptions.find(
				(e) => e.file === file && e.specifier === specifier,
			);

			if (exception !== undefined) used.add(exception);

			const base =
				exception === undefined ? posix.dirname(file) : exception.resolveFrom;

			const target = posix.normalize(posix.join(base, specifier));
			edges.push({ specifier, target, bare, resolved: ctx.set.has(target) });
		}

		graph.set(file, edges);
	}

	return { graph, used };
}

function checkImports(ctx, problems, { graph, used }) {
	const allowed = new Set(ctx.baseline.imports.reverseEdges);
	const seen = new Set();

	for (const [file, edges] of graph)
		for (const edge of edges) {
			if (!edge.resolved)
				problems.push(
					`imports: ${file} imports ${edge.specifier}, but ${edge.target} does not exist`,
				);

			if (file.startsWith("src/") && /^(?:server|host)\//.test(edge.target)) {
				const pair = `${file} -> ${edge.target}`;
				seen.add(pair);

				if (!allowed.has(pair))
					problems.push(
						`imports: ${pair} is a new reverse edge from src into host code; only removing reverse edges is allowed`,
					);
			}
		}

	for (const pair of allowed)
		if (!seen.has(pair))
			problems.push(
				`imports: ${pair} is listed in reverseEdges but no longer exists; delete it from scripts/layout-baseline.json`,
			);

	for (const exception of ctx.baseline.imports.exceptions)
		if (!used.has(exception))
			problems.push(
				`imports: exception for ${exception.file} importing ${exception.specifier} is no longer used; delete it from scripts/layout-baseline.json`,
			);
}

async function checkClassification(ctx, problems) {
	const { roots, seatReader, files, retired } = ctx.baseline.classification;

	const module = await import(
		pathToFileURL(join(ctx.root, seatReader.module)).href
	);

	const reviewSeats = module[seatReader.export];

	const scoped = ctx.files.filter((file) =>
		roots.some((r) => file.startsWith(`${r}/`)),
	);

	for (const file of scoped)
		if (!Object.hasOwn(files, file))
			problems.push(
				`classification: ${file} is unclassified; add it to scripts/layout-baseline.json with its owner, review seats and source lineage`,
			);

	for (const [file, entry] of Object.entries(files)) {
		if (!ctx.set.has(file)) {
			problems.push(
				`classification: ${file} is classified but missing; move its entry to "retired" or reclassify its new path`,
			);
			continue;
		}

		if (
			!isText(entry.owner) ||
			!Array.isArray(entry.seats) ||
			!Array.isArray(entry.from) ||
			!isText(entry.since)
		) {
			problems.push(
				`classification: ${file} needs owner, seats, from and since`,
			);
			continue;
		}

		const actual = new Set(reviewSeats([file]));

		for (const seat of entry.seats)
			if (!actual.has(seat))
				problems.push(
					`classification: ${file} requires review seat ${seat}, but reviewSeats gives ${[...actual].join(",")}`,
				);

		for (const source of entry.from) {
			const origin = files[source] ?? retired[source];

			if (origin === undefined) {
				problems.push(`classification: ${file} names unknown source ${source}`);
				continue;
			}

			for (const seat of origin.seats)
				if (!entry.seats.includes(seat))
					problems.push(
						`classification: ${file} drops review seat ${seat} inherited from ${source}`,
					);
		}
	}
}

function fsExec(root) {
	return async (command, args) => {
		const spec = command === "git" && args[0] === "show" ? args[1] : undefined;
		const path = spec?.slice(spec.indexOf(":") + 1);

		try {
			if (path === undefined) throw new Error("unsupported");

			return {
				code: 0,
				stdout: readFileSync(join(root, path), "utf8"),
				stderr: "",
			};
		} catch {
			return { code: 128, stdout: "", stderr: "unavailable" };
		}
	};
}

async function checkConstants(ctx, problems, entry) {
	for (const reader of entry.readers) {
		if (!ctx.set.has(reader)) {
			problems.push(`readers: ${entry.id}: reader ${reader} is missing`);
			continue;
		}

		const text = ctx.read(reader);

		for (const declaration of entry.declarations)
			for (const token of [declaration.file, declaration.name])
				if (!text.includes(token))
					problems.push(
						`readers: ${entry.id}: ${reader} no longer names ${token}`,
					);
	}

	const values = {};

	for (const declaration of entry.declarations) {
		if (!ctx.set.has(declaration.file)) {
			problems.push(
				`readers: ${entry.id}: ${declaration.file} is missing, so ${declaration.name} has no declaration`,
			);
			continue;
		}

		const pattern = new RegExp(
			`^export const ${declaration.name} = ([0-9_]+);$`,
			"gm",
		);

		const matches = [...ctx.read(declaration.file).matchAll(pattern)];

		if (matches.length !== 1)
			problems.push(
				`readers: ${entry.id}: ${declaration.file} has ${matches.length} declarations of ${declaration.name}, expected exactly 1`,
			);
		else if (declaration.key !== undefined)
			values[declaration.key] = Number(matches[0][1].replaceAll("_", ""));
	}

	if (entry.run === undefined) return;

	try {
		const module = await import(
			pathToFileURL(join(ctx.root, entry.run.module)).href
		);

		const result = await module[entry.run.export]("HEAD", fsExec(ctx.root));

		if (JSON.stringify(result) !== JSON.stringify(values))
			problems.push(
				`readers: ${entry.id}: ${entry.run.module} ${entry.run.export} read ${JSON.stringify(result)}, expected ${JSON.stringify(values)}`,
			);
	} catch (error) {
		problems.push(
			`readers: ${entry.id}: ${entry.run.module} ${entry.run.export} failed at HEAD: ${error instanceof Error ? error.message : String(error)}`,
		);
	}
}

function checkPaths(ctx, problems, entry) {
	const text = ctx.set.has(entry.reader)
		? normalized(ctx.read(entry.reader))
		: null;

	if (text === null)
		problems.push(`readers: ${entry.id}: reader ${entry.reader} is missing`);

	for (const [token, count] of Object.entries(entry.tokens)) {
		if (text === null) break;
		const found = occurrences(text, normalized(token));

		if (found !== count)
			problems.push(
				`readers: ${entry.id}: ${entry.reader} has ${found} of ${JSON.stringify(token)}, expected ${count}`,
			);
	}

	for (const target of entry.targets) {
		const kind = ctx.kindOf(target.path);

		if (kind !== target.type)
			problems.push(
				`readers: ${entry.id}: ${target.path} is ${kind}, expected ${target.type}`,
			);

		if (target.via === undefined) continue;

		const from =
			target.via.from === "reader"
				? posix.dirname(entry.reader)
				: target.via.from;

		const resolved = posix.normalize(posix.join(from, target.via.path));

		if (resolved !== target.path)
			problems.push(
				`readers: ${entry.id}: ${target.via.path} from ${from} resolves to ${resolved}, expected ${target.path}`,
			);
	}
}

async function checkReaders(ctx, problems) {
	for (const entry of ctx.baseline.readers)
		if (entry.kind === "constants") await checkConstants(ctx, problems, entry);
		else checkPaths(ctx, problems, entry);
}

function checkShell(ctx, problems) {
	const { files: patterns, inventory } = ctx.baseline.shell;
	const actual = ctx.files.filter((file) => globbed(file, patterns));

	for (const file of actual)
		if (!Object.hasOwn(inventory, file))
			problems.push(
				`shell: ${file} is not inventoried; add its path tokens to scripts/layout-baseline.json`,
			);

	for (const [file, entry] of Object.entries(inventory)) {
		if (!ctx.set.has(file)) {
			problems.push(`shell: ${file} is inventoried but missing`);
			continue;
		}

		const text = ctx.read(file);
		const tokens = new Set([...text.matchAll(SHELL_TOKEN)].map((m) => m[0]));

		for (const token of tokens)
			if (!Object.hasOwn(entry.tokens, token))
				problems.push(`shell: ${file} has unclassified path token ${token}`);

		for (const [token, target] of Object.entries(entry.tokens)) {
			if (!tokens.has(token))
				problems.push(`shell: ${file} no longer has path token ${token}`);

			if (target.type === "external") continue;

			const kind =
				target.type === "glob"
					? ctx.files.some((path) => matchesGlob(path, target.path))
						? "glob"
						: "missing"
					: ctx.kindOf(target.path);

			if (kind !== target.type)
				problems.push(
					`shell: ${file} token ${token} names ${target.path}, which is ${kind}, expected ${target.type}`,
				);
		}

		const imports = new Map();

		for (const m of text.matchAll(HEREDOC_IMPORT)) {
			const names = imports.get(m[2]) ?? new Set();

			for (const part of m[1].split(",")) {
				const name = part
					.trim()
					.replace(/^type\s+/, "")
					.split(/\s+as\s+/)[0];

				if (name !== "") names.add(name);
			}

			imports.set(m[2], names);
		}

		const expected = entry.imports ?? {};

		for (const [specifier, names] of imports) {
			const listed = new Set(expected[specifier] ?? []);

			for (const name of names)
				if (!listed.has(name))
					problems.push(
						`shell: ${file} imports ${name} from ${specifier}, which is not inventoried`,
					);
		}

		for (const [specifier, names] of Object.entries(expected)) {
			const target = posix.normalize(specifier);

			if (!ctx.set.has(target)) {
				problems.push(
					`shell: ${file} imports from ${specifier}, but ${target} does not exist`,
				);
				continue;
			}

			const exported = exportedNames(target, ctx.read(target));

			for (const name of names) {
				if (!(imports.get(specifier) ?? new Set()).has(name))
					problems.push(
						`shell: ${file} no longer imports ${name} from ${specifier}`,
					);

				if (!exported.has(name))
					problems.push(
						`shell: ${file} imports ${name} from ${specifier}, but ${target} does not export it`,
					);
			}
		}
	}
}

function runnerGlobs(ctx) {
	const scripts =
		parsed("package.json", ctx.read("package.json")).scripts ?? {};

	return ctx.baseline.discovery.runners.flatMap((name) =>
		(scripts[name] ?? "").split(/\s+/).filter((part) => part.includes("*")),
	);
}

function checkDiscovery(ctx, problems, { graph }) {
	const globs = runnerGlobs(ctx);
	const excluded = ctx.baseline.discovery.exclude;
	const scoped = ctx.files.filter((file) => !globbed(file, excluded));

	const discovered = scoped.filter(
		(file) => TEST.test(file) && globbed(file, globs),
	);

	for (const file of scoped)
		if (TEST.test(file) && !globbed(file, globs))
			problems.push(
				`discovery: ${file} is a test outside runner discovery (${globs.join(", ")})`,
			);

	const closures = new Map();

	for (const test of discovered) {
		const reached = new Set();
		const queue = [test];

		while (queue.length > 0) {
			const next = queue.pop();

			for (const edge of graph.get(next) ?? [])
				if (edge.resolved && !reached.has(edge.target)) {
					reached.add(edge.target);
					queue.push(edge.target);
				}
		}

		closures.set(test, reached);
	}

	for (const cases of scoped.filter((file) => CASES.test(file))) {
		const registrations = [...graph.entries()].flatMap(([file, edges]) =>
			edges
				.filter((edge) => edge.bare && edge.target === cases)
				.map(() => file),
		);

		const runners = discovered.filter((test) => closures.get(test).has(cases));

		if (registrations.length !== 1)
			problems.push(
				`discovery: ${cases} is registered by ${registrations.length} bare imports (${registrations.join(", ") || "none"}), expected exactly 1`,
			);

		if (runners.length !== 1)
			problems.push(
				`discovery: ${cases} runs under ${runners.length} discovered tests (${runners.join(", ") || "none"}), expected exactly 1`,
			);
	}
}

function checkNavigation(ctx, problems) {
	const { required, exempt } = ctx.baseline.navigation;

	const top = new Set(
		ctx.files
			.filter((file) => file.includes("/"))
			.map((file) => file.split("/")[0]),
	);

	for (const dir of [...new Set([...top, ...required])].sort())
		if (!exempt.includes(dir) && !ctx.set.has(`${dir}/README.md`))
			problems.push(`navigation: ${dir}/ has no README.md`);
}

function checkCitations(ctx, problems) {
	const { historical, pinnedDocuments } = ctx.baseline.citations;

	for (const doc of ctx.files) {
		if (!doc.endsWith(".md") || globbed(doc, historical)) continue;
		const pin = pinnedDocuments.find((p) => p.path === doc);
		let text = ctx.read(doc);

		if (pin !== undefined && !text.includes(pin.statement))
			problems.push(
				`citations: ${doc} is listed as pinned to ${pin.revision}, but no longer says ${JSON.stringify(pin.statement)}`,
			);

		const report = (line, message) =>
			problems.push(`citations: ${doc}:${line} ${message}`);

		const lineOf = (index) => text.slice(0, index).split("\n").length;

		const syntax = (index, cited, from, to) => {
			const start = Number(from);
			const end = to === undefined ? start : Number(to);

			if (
				cited.split("/").some((part) => part === ".." || part === "") ||
				start < 1 ||
				end < start
			) {
				report(
					lineOf(index),
					`cites ${cited}:${from}${to === undefined ? "" : `-${to}`}, which is not a valid citation`,
				);

				return false;
			}

			return true;
		};

		const current = (index, cited, from, to) => {
			if (!syntax(index, cited, from, to)) return;

			if (pin !== undefined) return;

			if (!ctx.set.has(cited)) {
				report(lineOf(index), `cites ${cited}, which does not exist`);

				return;
			}

			const count = lineCount(ctx.read(cited));
			const end = Number(to ?? from);

			if (end > count)
				report(
					lineOf(index),
					`cites ${cited}:${from}${to === undefined ? "" : `-${to}`}, but the file has ${count} lines`,
				);
		};

		const blank = (match) => match[0].replace(/[^\n]/g, " ");

		for (const m of text.matchAll(GITHUB_CITATION)) {
			if (/^[0-9a-f]{7,40}$/.test(m[1])) syntax(m.index, m[2], m[3], m[4]);
			else current(m.index, m[2], m[3], m[4]);
		}

		text = text.replace(GITHUB_CITATION, (...m) => blank(m));

		for (const m of text.matchAll(PINNED_CITATION))
			syntax(m.index, m[2], m[3], m[4]);

		text = text.replace(PINNED_CITATION, (...m) => blank(m));

		for (const m of text.matchAll(COLON_CITATION))
			current(m.index, m[1], m[2], m[3]);

		for (const m of text.matchAll(WORD_CITATION))
			current(m.index, m[1], m[2], m[3]);
	}
}

export async function checkLayout(root, only = CATEGORIES) {
	const ctx = context(root);
	const problems = [];
	const needsGraph = only.includes("imports") || only.includes("discovery");
	const graph = needsGraph ? importGraph(ctx) : null;

	if (only.includes("imports")) checkImports(ctx, problems, graph);

	if (only.includes("classification")) await checkClassification(ctx, problems);

	if (only.includes("readers")) await checkReaders(ctx, problems);

	if (only.includes("shell")) checkShell(ctx, problems);

	if (only.includes("discovery")) checkDiscovery(ctx, problems, graph);

	if (only.includes("navigation")) checkNavigation(ctx, problems);

	if (only.includes("citations")) checkCitations(ctx, problems);

	return problems;
}

async function main(argv) {
	let root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
	let only = CATEGORIES;
	let json = false;

	for (let i = 0; i < argv.length; i++) {
		if (argv[i] === "--root") root = resolve(argv[++i] ?? "");
		else if (argv[i] === "--only") only = (argv[++i] ?? "").split(",");
		else if (argv[i] === "--json") json = true;
		else {
			process.stderr.write(
				"usage: node scripts/check-layout.mjs [--root DIR] [--only CATEGORY,...] [--json]\n",
			);
			process.exit(2);
		}
	}

	const unknown = only.filter((category) => !CATEGORIES.includes(category));

	if (unknown.length > 0) {
		process.stderr.write(`unknown categories: ${unknown.join(", ")}\n`);
		process.exit(2);
	}

	const problems = await checkLayout(root, only);

	if (json) process.stdout.write(`${JSON.stringify(problems)}\n`);
	else for (const problem of problems) process.stderr.write(`${problem}\n`);

	process.exitCode = problems.length === 0 ? 0 : 1;
}

if (import.meta.main) await main(process.argv.slice(2));
