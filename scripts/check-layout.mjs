import { execFileSync } from "node:child_process";
import { lstatSync, readdirSync, readFileSync, realpathSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join, matchesGlob, posix, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

export const CATEGORIES = [
	"imports",
	"classification",
	"readers",
	"literals",
	"shell",
	"discovery",
	"navigation",
	"citations",
];

const CODE = /\.(?:[cm]?[jt]s|tsx)$/;
const TEST = /\.test\.[cm]?[jt]sx?$/;
const CASES = /\.cases\.[cm]?[jt]s$/;
const SKIPPED_DIRS = new Set([".git", "node_modules"]);

const ROOT_DIRS = new Set([
	"src",
	"server",
	"host",
	"test",
	"docs",
	"scripts",
	"extension",
	"skills",
	"tools",
	"research",
	".pi",
	".github",
]);

const ROOT_ALTERNATION = `(?:${[...ROOT_DIRS].map((dir) => dir.replace(".", "\\.")).join("|")})`;

const PATH_ROOTS = `${ROOT_ALTERNATION}\\/[\\w./-]*\\w`;

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

const LITERAL_PATH = new RegExp(
	`(?<![\\w./@-])(?:\\.\\/)?${ROOT_ALTERNATION}\\/[\\w./*{},<>@+-]*`,
	"g",
);

const ROOT_FILE_NAMES = new Set(ROOT_FILES.replaceAll("\\", "").split("|"));

const REGEX_LITERAL =
	/\/((?:\\.|\[(?:\\.|[^\]\\\n])*\]|[^/\\\n[])+)\/([dgimsuvy]*)/g;

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

	const dirs = new Set(["."]);

	for (const file of files)
		for (let at = file.indexOf("/"); at > 0; at = file.indexOf("/", at + 1))
			dirs.add(file.slice(0, at));

	const kindOf = (path) =>
		set.has(path) ? "file" : dirs.has(path) ? "dir" : "missing";

	const sources = new Map();

	const source = (path) => {
		if (!sources.has(path)) {
			const api = ts();

			sources.set(
				path,
				api.createSourceFile(path, read(path), api.ScriptTarget.Latest, true),
			);
		}

		return sources.get(path);
	};

	return {
		root,
		files,
		set,
		read,
		kindOf,
		source,
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

function specifiers(source) {
	const api = ts();
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
				runtime: api.isImportDeclaration(node)
					? node.importClause?.isTypeOnly !== true
					: !node.isTypeOnly,
			});
		else if (
			api.isImportTypeNode(node) &&
			api.isLiteralTypeNode(node.argument) &&
			api.isStringLiteralLike(node.argument.literal)
		)
			found.push({
				specifier: node.argument.literal.text,
				bare: false,
				runtime: false,
			});
		else if (
			api.isCallExpression(node) &&
			node.expression.kind === api.SyntaxKind.ImportKeyword &&
			node.arguments[0] !== undefined &&
			api.isStringLiteralLike(node.arguments[0])
		)
			found.push({
				specifier: node.arguments[0].text,
				bare: false,
				runtime: true,
			});
		api.forEachChild(node, visit);
	};

	visit(source);

	return found;
}

function exportedNames(source) {
	const api = ts();
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

		for (const { specifier, bare, runtime } of specifiers(ctx.source(file))) {
			if (!specifier.startsWith("./") && !specifier.startsWith("../")) continue;

			const exception = exceptions.find(
				(e) => e.file === file && e.specifier === specifier,
			);

			if (exception !== undefined) used.add(exception);

			const base =
				exception === undefined ? posix.dirname(file) : exception.resolveFrom;

			const target = posix.normalize(posix.join(base, specifier));
			edges.push({
				specifier,
				target,
				bare,
				runtime,
				resolved: ctx.set.has(target),
			});
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

	for (const exception of ctx.baseline.imports.exceptions) {
		if (!used.has(exception))
			problems.push(
				`imports: exception for ${exception.file} importing ${exception.specifier} is no longer used; delete it from scripts/layout-baseline.json`,
			);

		checkStagingCaller(ctx, problems, exception);
	}
}

function escaped(text) {
	return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function checkStagingCaller(ctx, problems, exception) {
	const { file, caller, resolveFrom } = exception;

	const report = (message) =>
		problems.push(`imports: exception for ${file}: ${message}`);

	if (!ctx.set.has(caller)) {
		report(`staging caller ${caller} is missing`);

		return;
	}

	const text = ctx.read(caller);

	const copies = [...text.matchAll(/\bcp\s+"([^"]+)"\s+"([^"]+)"/g)].filter(
		(m) => m[1].endsWith(`/${file}`),
	);

	if (copies.length !== 1) {
		report(
			`staging caller ${caller} copies it ${copies.length} times, expected exactly 1`,
		);

		return;
	}

	const [, from, dest] = copies[0];
	const checkout = from.slice(0, -(file.length + 1));

	if (!dest.startsWith(`${checkout}/`)) {
		report(
			`staging caller ${caller} copies it to ${dest}, outside the checkout ${checkout}`,
		);

		return;
	}

	const staged = dest.slice(checkout.length + 1);

	if (posix.dirname(staged) !== resolveFrom)
		report(
			`staging caller ${caller} copies it to ${staged}, which resolves imports from ${posix.dirname(staged)}, not ${resolveFrom}`,
		);

	const runs = new RegExp(
		`cd\\s+"${escaped(checkout)}"\\s*&&\\s*node\\b[^\\n]*\\s${escaped(staged)}(?![\\w.-])`,
	);

	if (!runs.test(text))
		report(
			`staging caller ${caller} never runs ${staged} from the checkout ${checkout}`,
		);
}

function firstLine(error) {
	return (error instanceof Error ? error.message : String(error)).split(
		"\n",
	)[0];
}

async function checkClassification(ctx, problems) {
	const { roots, seatReader, files, retired, routes } =
		ctx.baseline.classification;

	let reviewSeats;

	try {
		const module = await import(
			pathToFileURL(join(ctx.root, seatReader.module)).href
		);

		reviewSeats = module[seatReader.export];
	} catch (error) {
		problems.push(
			`classification: cannot load ${seatReader.module}: ${firstLine(error)}`,
		);

		return;
	}

	checkRoutes(ctx, problems, routes, reviewSeats);

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

function checkRoutes(ctx, problems, routes, reviewSeats) {
	for (const [path, seats] of Object.entries(routes)) {
		if (!ctx.set.has(path))
			problems.push(
				`classification: route ${path} is missing; record a path that the same reviewSeats branch covers`,
			);

		const actual = new Set(reviewSeats([path]));

		for (const seat of seats)
			if (!actual.has(seat))
				problems.push(
					`classification: route ${path} requires review seat ${seat}, but reviewSeats gives ${[...actual].join(",")}`,
				);
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

		for (const declaration of entry.declarations) {
			if (!text.includes(declaration.file))
				problems.push(
					`readers: ${entry.id}: ${reader} no longer names ${declaration.file}`,
				);

			if (entry.run === undefined)
				checkLookup(ctx, problems, entry.id, reader, declaration);
		}
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

function lookupsOf(text, name) {
	const found = [];

	for (const m of text.matchAll(REGEX_LITERAL)) {
		if (!m[1].includes(name)) continue;

		try {
			found.push({
				literal: m[0],
				pattern: new RegExp(m[1], `${m[2].replace("g", "")}g`),
			});
		} catch {
			continue;
		}
	}

	return found;
}

function checkLookup(ctx, problems, id, reader, declaration) {
	const lookups = lookupsOf(ctx.read(reader), declaration.name);

	if (lookups.length !== 1) {
		problems.push(
			`readers: ${id}: ${reader} has ${lookups.length} lookups of ${declaration.name}, expected exactly 1`,
		);

		return;
	}

	if (!ctx.set.has(declaration.file)) return;

	const found = [...ctx.read(declaration.file).matchAll(lookups[0].pattern)];

	if (found.length !== 1)
		problems.push(
			`readers: ${id}: ${reader} lookup ${lookups[0].literal} finds ${found.length} declarations in ${declaration.file}, expected exactly 1`,
		);
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

function literalProblem(ctx, token, open) {
	const raw = token.replace(/^\.\//, "").replace(/[,:;]+$/, "");
	const prefixOf = (path) => ctx.files.some((file) => file.startsWith(path));

	if (/[*{<]/.test(raw)) {
		const glob = raw.replace(/<[^>]*>/g, "*").replace(/\/$/, "/**");

		return ctx.files.some((file) => matchesGlob(file, glob))
			? null
			: { path: raw, problem: "matches no file" };
	}

	const sentence =
		/(?:\/|\.[^/]*)\.$/.test(raw) ||
		(raw.endsWith(".") && ctx.kindOf(raw.slice(0, -1)) !== "missing");

	if (open || (raw.endsWith(".") && !sentence))
		return prefixOf(raw)
			? null
			: { path: raw, problem: "is the prefix of no file" };

	const path = sentence ? raw.slice(0, -1) : raw;

	if (path.endsWith("/"))
		return ctx.kindOf(path.slice(0, -1)) === "dir"
			? null
			: { path, problem: "is not a directory" };

	return ctx.kindOf(path) === "missing"
		? { path, problem: "does not exist" }
		: null;
}

function rootNameProblem(ctx, name) {
	if (ROOT_DIRS.has(name))
		return ctx.kindOf(name) === "dir" ? null : "is not a directory";

	if (ROOT_FILE_NAMES.has(name))
		return ctx.set.has(name) ? null : "does not exist";

	return undefined;
}

function literalTexts(api, source) {
	const found = [];

	const add = (node, text, open) =>
		found.push({
			text,
			open,
			line: source.getLineAndCharacterOfPosition(node.getStart()).line + 1,
		});

	const visit = (node) => {
		if (api.isStringLiteralLike(node) || api.isTemplateTail(node))
			add(node, node.text, false);
		else if (api.isTemplateHead(node) || api.isTemplateMiddle(node))
			add(node, node.text, true);

		if (api.isArrayLiteralExpression(node)) {
			const texts = node.elements
				.filter((element) => api.isStringLiteralLike(element))
				.map((element) => element.text);

			if (texts.some((text) => text.match(LITERAL_PATH) !== null))
				for (const element of node.elements)
					if (api.isStringLiteralLike(element))
						found.push({
							text: element.text,
							root: true,
							line:
								source.getLineAndCharacterOfPosition(element.getStart()).line +
								1,
						});
		}

		api.forEachChild(node, visit);
	};

	visit(source);

	return found;
}

function configTexts(value, key = "") {
	if (isText(value))
		return value
			.split(/\s+/)
			.map((word) => word.replace(/^[!"']+|["']+$/g, ""))
			.filter((word) => word !== "")
			.map((word) => ({ text: word, open: false, root: true, line: key }));

	if (Array.isArray(value))
		return value.flatMap((item, at) => configTexts(item, `${key}[${at}]`));

	if (value instanceof Object)
		return Object.entries(value).flatMap(([name, item]) =>
			configTexts(item, key === "" ? name : `${key}.${name}`),
		);

	return [];
}

function checkLiterals(ctx, problems) {
	const { configs, exclude, allow } = ctx.baseline.literals;
	const used = new Set();

	const allowed = (file, path) =>
		allow.some((entry, at) => {
			if (!globbed(file, entry.files)) return false;

			if ((entry.paths ?? []).includes(path)) {
				used.add(`${at}\0${path}`);

				return true;
			}

			const glob = (entry.globs ?? []).find((g) => matchesGlob(path, g));

			if (glob === undefined) return false;
			used.add(`${at}\0${glob}`);

			return true;
		});

	const inspect = (file, { text, open, root, line }) => {
		const report = (path, problem) => {
			if (!allowed(file, path))
				problems.push(
					`literals: ${file}:${line} names ${path}, which ${problem}; fix the path, or add it to literals.allow in scripts/layout-baseline.json with a reason`,
				);
		};

		if (root) {
			const problem = rootNameProblem(ctx, text);

			if (problem !== undefined) {
				if (problem !== null) report(text, problem);

				return;
			}
		}

		for (const m of text.matchAll(LITERAL_PATH)) {
			const atEnd = m.index + m[0].length === text.length;
			const found = literalProblem(ctx, m[0], open && atEnd);

			if (found !== null) report(found.path, found.problem);
		}
	};

	const api = ts();

	for (const file of ctx.files)
		if (CODE.test(file) && !file.endsWith(".d.ts") && !globbed(file, exclude))
			for (const item of literalTexts(api, ctx.source(file)))
				if (!item.root) inspect(file, item);
				else if (rootNameProblem(ctx, item.text) !== undefined)
					inspect(file, item);

	for (const file of configs) {
		if (!ctx.set.has(file)) {
			problems.push(`literals: config ${file} is missing`);
			continue;
		}

		for (const item of configTexts(parsed(file, ctx.read(file))))
			inspect(file, item);
	}

	checkTsconfigInclude(ctx, problems);

	for (const [at, entry] of allow.entries())
		for (const path of [...(entry.paths ?? []), ...(entry.globs ?? [])])
			if (!used.has(`${at}\0${path}`))
				problems.push(
					`literals: allow entry "${entry.reason}" lists ${path}, which no scanned literal still needs; delete it`,
				);
}

function checkTsconfigInclude(ctx, problems) {
	if (!ctx.set.has("tsconfig.json")) return;

	const { include } = parsed("tsconfig.json", ctx.read("tsconfig.json"));
	const patterns = Array.isArray(include) ? include : [];

	for (const [at, pattern] of patterns.entries()) {
		if (
			!isText(pattern) ||
			rootNameProblem(ctx, pattern) !== undefined ||
			pattern.match(LITERAL_PATH) !== null
		)
			continue;

		const matched = /[*?]/.test(pattern)
			? ctx.files.some((file) => matchesGlob(file, pattern))
			: ctx.kindOf(pattern.replace(/\/$/, "")) !== "missing";

		if (!matched)
			problems.push(
				`literals: tsconfig.json:include[${at}] ${pattern} matches no file, so typecheck silently skips it`,
			);
	}
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

			const exported = exportedNames(ctx.source(target));

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

function trustedTests(ctx, problems) {
	const { manifest, materializer, accepts, predicates } =
		ctx.baseline.discovery.trusted;

	const report = (message) => problems.push(`discovery: ${message}`);

	const audit =
		"audit the moved or changed test selection code, then update discovery.trusted.materializer and discovery.trusted.predicates in scripts/layout-baseline.json";

	if (!ctx.set.has(materializer))
		report(
			`${materializer} is missing, so the trusted test selection cannot be checked; ${audit}`,
		);
	else {
		const text = normalized(ctx.read(materializer));

		for (const expression of [accepts, ...predicates]) {
			const found = occurrences(text, normalized(expression));

			if (found !== 1)
				report(
					`${materializer} has ${found} of the trusted test predicate ${JSON.stringify(expression)}, expected 1; trusted discovery may no longer match the local runner; ${audit}`,
				);
		}
	}

	if (!ctx.set.has(manifest)) {
		report(`${manifest} is missing`);

		return null;
	}

	const globs = parsed(manifest, ctx.read(manifest)).testGlobs;

	if (!Array.isArray(globs) || globs.length === 0 || !globs.every(isText)) {
		report(
			`${manifest} testGlobs is empty or not a list of globs, so the trusted gate refuses the manifest`,
		);

		return [];
	}

	for (const glob of new Set(globs.filter((g, at) => globs.indexOf(g) !== at)))
		report(
			`${manifest} lists testGlob ${glob} more than once, so the trusted gate refuses the manifest`,
		);

	const accepted = new RegExp(accepts.slice(1, accepts.lastIndexOf("/")));

	for (const glob of globs) {
		if (!accepted.test(glob))
			report(
				`${manifest} testGlob ${glob} is refused by ${materializer} (${accepts})`,
			);

		if (!ctx.files.some((file) => matchesGlob(file, glob)))
			report(
				`${manifest} testGlob ${glob} matches no file, so the trusted gate fails with missing_tests`,
			);
	}

	return globs;
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

	const trustedGlobs = trustedTests(ctx, problems);

	if (trustedGlobs !== null) {
		const trusted = new Set(
			scoped.filter((file) => !CASES.test(file) && globbed(file, trustedGlobs)),
		);

		const local = new Set(discovered);
		const listed = trustedGlobs.join(", ") || "none";

		for (const file of local)
			if (!trusted.has(file))
				problems.push(
					`discovery: ${file} runs under the local runner but not under trusted discovery (testGlobs: ${listed})`,
				);

		for (const file of trusted)
			if (!local.has(file))
				problems.push(
					`discovery: ${file} runs under trusted discovery but not under the local runner (${globs.join(", ")})`,
				);
	}

	const closures = new Map();

	for (const test of discovered) {
		const reached = new Set();
		const queue = [test];

		while (queue.length > 0) {
			const next = queue.pop();

			for (const edge of graph.get(next) ?? [])
				if (edge.resolved && edge.runtime && !reached.has(edge.target)) {
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

	for (const dir of [...new Set([...top, ...required])].sort()) {
		if (exempt.includes(dir)) continue;
		const readme = `${dir}/README.md`;

		if (!ctx.set.has(readme))
			problems.push(`navigation: ${dir}/ has no README.md`);
		else if (!hasSentence(ctx.read(readme)))
			problems.push(
				`navigation: ${readme} has no full sentence; say what the folder holds and where new things go`,
			);
	}
}

function hasSentence(text) {
	const prose = text
		.replace(/^```[\s\S]*?^```/gm, "")
		.split("\n")
		.filter((line) => !/^\s*(?:#|\||<!--)/.test(line))
		.join(" ");

	return prose
		.split(/(?<=[.!?])\s/)
		.map((part) => part.trim().replace(/^(?:[-*>]|\d+\.)\s+/, ""))
		.some(
			(part) =>
				/^[A-Z`*_"(]/.test(part) &&
				/[.!?]$/.test(part) &&
				part.split(/\s+/).length >= 3,
		);
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

	const checks = {
		imports: () => checkImports(ctx, problems, graph),
		classification: () => checkClassification(ctx, problems),
		readers: () => checkReaders(ctx, problems),
		literals: () => checkLiterals(ctx, problems),
		shell: () => checkShell(ctx, problems),
		discovery: () => checkDiscovery(ctx, problems, graph),
		navigation: () => checkNavigation(ctx, problems),
		citations: () => checkCitations(ctx, problems),
	};

	for (const category of CATEGORIES) {
		if (!only.includes(category)) continue;

		try {
			await checks[category]();
		} catch (error) {
			problems.push(`${category}: check failed: ${firstLine(error)}`);
		}
	}

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
