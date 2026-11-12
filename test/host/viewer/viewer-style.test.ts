import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { startViewer } from "../../../host/viewer/server.ts";

const read = (path: string) =>
	readFileSync(new URL(path, import.meta.url), "utf8");

const css = read("../../../host/viewer/style.css").replace(
	/\/\*[\s\S]*?\*\//g,
	"",
);

const tokens = read("../../../host/viewer/design/tokens.css");

/** Every `property: value` in the sheet, innermost blocks included. */
function declarations(sheet: string): { prop: string; value: string }[] {
	return [...sheet.matchAll(/\{([^{}]*)\}/g)].flatMap((m) =>
		(m[1] ?? "")
			.split(";")
			.map((d) => d.trim())
			.filter((d) => d.includes(":"))
			.map((d) => ({
				prop: d.slice(0, d.indexOf(":")).trim(),
				value: d.slice(d.indexOf(":") + 1).trim(),
			})),
	);
}

// CSS Color 4 named colours (and the system colours), lower case.
const NAMED = new Set(
	(
		"aliceblue antiquewhite aqua aquamarine azure beige bisque black blanchedalmond blue blueviolet brown " +
		"burlywood cadetblue chartreuse chocolate coral cornflowerblue cornsilk crimson cyan darkblue darkcyan " +
		"darkgoldenrod darkgray darkgreen darkgrey darkkhaki darkmagenta darkolivegreen darkorange darkorchid " +
		"darkred darksalmon darkseagreen darkslateblue darkslategray darkslategrey darkturquoise darkviolet " +
		"deeppink deepskyblue dimgray dimgrey dodgerblue firebrick floralwhite forestgreen fuchsia gainsboro " +
		"ghostwhite gold goldenrod gray green greenyellow grey honeydew hotpink indianred indigo ivory khaki " +
		"lavender lavenderblush lawngreen lemonchiffon lightblue lightcoral lightcyan lightgoldenrodyellow " +
		"lightgray lightgreen lightgrey lightpink lightsalmon lightseagreen lightskyblue lightslategray " +
		"lightslategrey lightsteelblue lightyellow lime limegreen linen magenta maroon mediumaquamarine " +
		"mediumblue mediumorchid mediumpurple mediumseagreen mediumslateblue mediumspringgreen " +
		"mediumturquoise mediumvioletred midnightblue mintcream mistyrose moccasin navajowhite navy oldlace " +
		"olive olivedrab orange orangered orchid palegoldenrod palegreen paleturquoise palevioletred " +
		"papayawhip peachpuff peru pink plum powderblue purple rebeccapurple red rosybrown royalblue " +
		"saddlebrown salmon sandybrown seagreen seashell sienna silver skyblue slateblue slategray slategrey " +
		"snow springgreen steelblue tan teal thistle tomato turquoise violet wheat white whitesmoke yellow " +
		"yellowgreen accentcolor accentcolortext activetext buttonborder buttonface buttontext canvas " +
		"canvastext field fieldtext graytext highlight highlighttext linktext mark marktext selecteditem " +
		"selecteditemtext visitedtext"
	).split(" "),
);

/** The raw colours in a sheet: hex, the colour functions, and named colours. */
function rawColours(sheet: string): string[] {
	const found: string[] = [];

	for (const { prop, value } of declarations(
		sheet.replace(/\/\*[\s\S]*?\*\//g, ""),
	)) {
		if (prop.startsWith("--")) {
			found.push(`${prop}: custom properties belong in tokens.css`);
			continue;
		}

		const bare = value
			.replace(/var\(--[a-z0-9-]+\)/gi, "")
			.replace(/"[^"]*"|'[^']*'/g, "");

		for (const m of bare.matchAll(/#[0-9a-f]{3,8}\b/gi))
			found.push(`${prop}: ${m[0]}`);

		for (const m of bare.matchAll(
			/\b(?:rgba?|hsla?|hwb|lab|lch|oklab|oklch|color)\(/gi,
		))
			found.push(`${prop}: ${m[0]}`);

		for (const m of bare.matchAll(/[a-z]+/gi))
			if (NAMED.has(m[0].toLowerCase())) found.push(`${prop}: ${m[0]}`);
	}

	return found;
}

function undefinedVariables(sheet: string): string[] {
	const defined = new Set(
		[...tokens.matchAll(/^\s*(--[a-z0-9-]+):/gm)].map((m) => m[1]),
	);

	return [
		...new Set(
			[...sheet.matchAll(/var\(\s*(--[a-z0-9-]+)/gi)].map((m) => m[1] ?? ""),
		),
	].filter((name) => !defined.has(name));
}

test("the style guard detects planted raw colours and unknown tokens", () => {
	assert.deepEqual(
		rawColours(
			"a { color: #fff; background: rgb(1 2 3); border-color: rgba(0,0,0,.5); outline-color: hsl(1 2% 3%); fill: red; }",
		),
		[
			"color: #fff",
			"background: rgb(",
			"border-color: rgba(",
			"outline-color: hsl(",
			"fill: red",
		],
	);
	assert.deepEqual(rawColours("a { background: #000 }"), ["background: #000"]);
	assert.deepEqual(
		rawColours(
			"a { color: currentColor; background: transparent; border-color: inherit; color: var(--color-error); white-space: pre-wrap; }",
		),
		[],
	);
	assert.deepEqual(undefinedVariables("a { color: var(--not-a-token); }"), [
		"--not-a-token",
	]);
});

test("viewer styles use only tokens, remain dark only, never shout and respect reduced motion", () => {
	assert.deepEqual(rawColours(css), []);
	assert.doesNotMatch(css, /prefers-color-scheme/i);
	assert.doesNotMatch(css, /text-transform:\s*uppercase/i);
	assert.ok(css.includes("var("));
	assert.deepEqual(undefinedVariables(css), []);
	assert.match(css, /@media\s*\(prefers-reduced-motion:\s*reduce\)/);
	assert.match(css, /font-variant-numeric:\s*tabular-nums/);
});

test("the served style.css starts with the exact token sheet and keeps the security headers", async () => {
	const stateDir = await mkdtemp(join(tmpdir(), "viewer-style-"));
	const viewer = await startViewer({ stateDir, port: 0 });

	try {
		const response = await fetch(`http://127.0.0.1:${viewer.port}/style.css`);
		assert.equal(response.status, 200);
		assert.equal(
			response.headers.get("content-type"),
			"text/css; charset=utf-8",
		);
		assert.equal(
			await response.text(),
			`${tokens}\n${read("../../../host/viewer/style.css")}`,
		);
		assert.equal(response.headers.get("cache-control"), "no-store");
		assert.equal(response.headers.get("x-content-type-options"), "nosniff");
		assert.equal(response.headers.get("referrer-policy"), "same-origin");
		assert.equal(
			response.headers.get("content-security-policy"),
			"default-src 'none'; style-src 'self'; img-src 'self'; manifest-src 'self'; base-uri 'none'; frame-ancestors 'none'; form-action 'self'",
		);
	} finally {
		await viewer.close();
		await rm(stateDir, { recursive: true, force: true });
	}
});

interface ColourToken {
	ref?: string;
	palette?: string;
	alpha?: number;
	over?: string;
}

interface Tokens {
	palette: Record<string, { value: string }>;
	color: Record<string, ColourToken>;
	contrast: {
		minimums: Record<string, number>;
		pairs: { fg: string; bg: string[]; kind: string }[];
	};
}

const json: Tokens = JSON.parse(
	read("../../../host/viewer/design/tokens.json"),
);

const hex = (value: string): number[] =>
	[1, 3, 5].map((i) => Number.parseInt(value.slice(i, i + 2), 16));

const mix = (top: number[], alpha: number, under: number[]): number[] =>
	top.map((c, i) => c * alpha + (under[i] ?? 0) * (1 - alpha));

interface ResolvedColour {
	rgb: number[];
	alpha: number;
	over: string | undefined;
}

function token(name: string): ResolvedColour {
	const t = json.color[name];
	assert.ok(t, `no colour token ${name}`);

	if (t.ref?.startsWith("color.")) return token(t.ref.slice(6));
	const palette = json.palette[t.palette ?? t.ref ?? ""];
	assert.ok(palette, `no palette for ${name}`);

	return {
		rgb: hex(palette.value),
		alpha: t.alpha ?? 1,
		over: t.over,
	};
}

function opaque(name: string): number[] {
	const t = token(name);

	if (t.alpha === 1) return t.rgb;
	assert.ok(t.over, `${name} has no backdrop`);

	return mix(t.rgb, t.alpha, opaque(t.over));
}

function luminance(rgb: number[]): number {
	const [r = 0, g = 0, b = 0] = rgb.map((c) => {
		const s = c / 255;

		return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
	});

	return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

function ratio(fg: string, bg: string, backdrop?: string): number {
	const background = token(bg);

	const under =
		backdrop === undefined
			? opaque(bg)
			: mix(background.rgb, background.alpha, opaque(backdrop));

	const f = token(fg);
	const a = luminance(f.alpha === 1 ? f.rgb : mix(f.rgb, f.alpha, under));
	const b = luminance(under);

	return (Math.max(a, b) + 0.05) / (Math.min(a, b) + 0.05);
}

function coloursUsed(sheet: string, properties: string[]): Set<string> {
	const names = new Map(
		Object.keys(json.color).map((name) => [
			`--color-${name.replace(/[A-Z]/g, (letter) => `-${letter.toLowerCase()}`)}`,
			name,
		]),
	);

	const definitions = new Map(
		[...tokens.matchAll(/(--[a-z0-9-]+):\s*([^;]+);/g)].map((match) => [
			match[1] ?? "",
			match[2] ?? "",
		]),
	);

	const resolve = (variable: string): string[] => {
		const name = names.get(variable);

		if (name !== undefined) return [name];

		return [
			...(definitions.get(variable) ?? "").matchAll(/var\((--[a-z0-9-]+)\)/g),
		].flatMap((match) => resolve(match[1] ?? ""));
	};

	return new Set(
		declarations(sheet)
			.filter((declaration) => properties.includes(declaration.prop))
			.flatMap(({ value }) =>
				[...value.matchAll(/var\((--[a-z0-9-]+)\)/g)].flatMap((match) =>
					resolve(match[1] ?? ""),
				),
			),
	);
}

test("contrast coverage is discovered from the stylesheet, including component token aliases", () => {
	assert.deepEqual(
		[
			...coloursUsed(
				"a { color: var(--color-attention-text); background: var(--component-card-fill); }",
				["color"],
			),
		],
		["attentionText"],
	);
	assert.deepEqual(
		[
			...coloursUsed("a { background: var(--component-card-fill); }", [
				"background",
			]),
		],
		["surface"],
	);
});

test("every stylesheet text colour meets Shep's contrast minimums on its declared surfaces", () => {
	const foregrounds = coloursUsed(css, ["color"]);
	const backgrounds = coloursUsed(css, ["background", "background-color"]);
	const covered = new Set<string>();
	let checks = 0;

	for (const pair of json.contrast.pairs) {
		if (pair.kind === "decorative" || !foregrounds.has(pair.fg)) continue;

		for (const bg of pair.bg.filter((name) => backgrounds.has(name))) {
			assert.ok(
				ratio(pair.fg, bg) >= (json.contrast.minimums[pair.kind] ?? Number.NaN),
				`${pair.fg} on ${bg}`,
			);
			covered.add(pair.fg);
			checks++;
		}

		if (pair.bg.includes("surface") && backgrounds.has("overlayFaint"))
			assert.ok(
				ratio(pair.fg, "overlayFaint", "surface") >=
					(json.contrast.minimums[pair.kind] ?? Number.NaN),
				`${pair.fg} on a hovered row`,
			);
	}

	assert.ok(checks >= 12, `found ${checks} contrast pairs`);
	assert.deepEqual(
		[...foregrounds].filter((name) => !covered.has(name)),
		[],
		"a stylesheet text colour has no checked contrast pair",
	);
});
