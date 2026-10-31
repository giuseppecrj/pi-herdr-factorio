import ts from "typescript";
import { builtinModules } from "node:module";
import { readFileSync } from "node:fs";
import { fieldOf, objectOf, parseJson, textOf, textsOf } from "../../../server/sandbox/json.ts";

export type Signal = { path: string; line: number; rule: string };

export function scanSource(path: string, text: string, changed: ReadonlySet<number>, rulesPath: string): Signal[] {
	const rules = objectOf(parseJson(readFileSync(rulesPath, "utf8")));

	const list = (key: string) => {
		const value = textsOf(fieldOf(rules, key));

		if (value === null) throw new Error("invalid_scan_rules");

		return value;
	};

	const pattern = textOf(fieldOf(rules, "suppression"));

	if (!pattern || fieldOf(rules, "version") !== 1) throw new Error("invalid_scan_rules");
	const suppression = new RegExp(pattern, "i");
	const signals: Signal[] = [];
	text.split("\n").forEach((line, index) => {
		if (changed.has(index + 1) && suppression.test(line)) signals.push({ path, line: index + 1, rule: "suppression_added" });
	});
	const source = ts.createSourceFile(path, text, ts.ScriptTarget.Latest, true);
	const aliases = new Map<string, string>();
	const builtin = (name: string) => builtinModules.includes(name.replace(/^node:/, "")) || builtinModules.includes(name);
	const literal = (node: ts.Node | undefined): string => node && ts.isStringLiteralLike(node) ? node.text : "";

	const member = (node: ts.Node | undefined): string => {
		if (!node) return "";

		if (ts.isIdentifier(node)) return aliases.get(node.text) ?? node.text;

		if (ts.isPropertyAccessExpression(node)) return `${member(node.expression)}.${node.name.text}`;

		if (ts.isElementAccessExpression(node)) return `${member(node.expression)}.${literal(node.argumentExpression)}`;

		if (ts.isParenthesizedExpression(node) || ts.isAwaitExpression(node)) return member(node.expression);

		if (ts.isCallExpression(node) && (member(node.expression) === "require" || node.expression.kind === ts.SyntaxKind.ImportKeyword) && builtin(literal(node.arguments[0]))) return `node:${literal(node.arguments[0]).replace(/^node:/, "")}`;

		return "";
	};

	const bind = (name: ts.BindingName, target: string) => {
		if (ts.isIdentifier(name)) aliases.set(name.text, target);
		else if (ts.isObjectBindingPattern(name)) for (const item of name.elements) {
			if (ts.isIdentifier(item.name)) aliases.set(item.name.text, `${target}.${item.propertyName?.getText(source) ?? item.name.text}`);
		}
	};

	const collect = (node: ts.Node) => {
		if (ts.isImportDeclaration(node)) {
			const name = literal(node.moduleSpecifier);

			if (builtin(name)) {
				const target = `node:${name.replace(/^node:/, "")}`;
				const clause = node.importClause;

				if (clause?.name) aliases.set(clause.name.text, target);
				const bindings = clause?.namedBindings;

				if (bindings && ts.isNamespaceImport(bindings)) aliases.set(bindings.name.text, target);
				else if (bindings) for (const item of bindings.elements) aliases.set(item.name.text, `${target}.${item.propertyName?.text ?? item.name.text}`);
			}
		}

		if (ts.isVariableDeclaration(node) && node.initializer) {
			const target = member(node.initializer);

			if (target) bind(node.name, target);
		}

		ts.forEachChild(node, collect);
	};

	collect(source);
	const processMembers = list("processMembers");
	const processEvents = list("processEvents");
	const loaderCalls = list("loaderCalls");
	const mutators = list("mutators");
	const protectedTarget = (target: string) => target.startsWith("node:") || target.startsWith("require.extensions") || target.startsWith("Module.") || target.startsWith("module.") || /^(?:(?:global|globalThis)\.)?process\.$/.test(target) || processMembers.some(key => ["process", "global.process", "globalThis.process", "node:process"].some(root => target === `${root}.${key}` || target.startsWith(`${root}.${key}.`)));

	const report = (node: ts.Node) => {
		const first = source.getLineAndCharacterOfPosition(node.getStart(source)).line + 1;
		const last = source.getLineAndCharacterOfPosition(node.getEnd()).line + 1;

		for (let line = first; line <= last; line++) if (changed.has(line)) {
			signals.push({ path, line, rule: "runtime_patching" });
			break;
		}
	};

	const visit = (node: ts.Node) => {
		if (ts.isBinaryExpression(node) && node.operatorToken.kind >= ts.SyntaxKind.FirstAssignment && node.operatorToken.kind <= ts.SyntaxKind.LastAssignment && protectedTarget(member(node.left))) report(node);

		if ((ts.isDeleteExpression(node) || ts.isPostfixUnaryExpression(node) || ts.isPrefixUnaryExpression(node)) && protectedTarget(member(ts.isDeleteExpression(node) ? node.expression : node.operand))) report(node);

		if (ts.isCallExpression(node)) {
			const target = member(node.expression);

			if (mutators.includes(target) && protectedTarget(`${member(node.arguments[0])}.${literal(node.arguments[1])}`)) report(node);

			if (loaderCalls.includes(target)) report(node);

			if (/^(?:(?:global|globalThis)\.)?(?:process|node:process)\.(?:on|once|addListener|prependListener|prependOnceListener)$/.test(target) && processEvents.includes(literal(node.arguments[0]))) report(node);
		}

		ts.forEachChild(node, visit);
	};

	visit(source);

	return signals;
}
