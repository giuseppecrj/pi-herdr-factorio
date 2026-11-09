// Generates server/viewer/design/tokens.css from the vendored Shep tokens.json (see DESIGN.md).
//
//   node scripts/design-tokens.mjs                 write tokens.css
//   node scripts/design-tokens.mjs --check         exit 1 if tokens.css is not what tokens.json generates
//   node scripts/design-tokens.mjs sync --shep DIR copy DIR/design/system/tokens.json, write SOURCE, regenerate
import { execFileSync } from "node:child_process";
import { copyFileSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const designDir = join(root, "server/viewer/design");
export const paths = {
  json: join(designDir, "tokens.json"),
  css: join(designDir, "tokens.css"),
  source: join(designDir, "SOURCE"),
};
const SHEP_TOKENS = "design/system/tokens.json";

const fail = (path, why) => {
  throw new Error(`design-tokens: ${path}: ${why}`);
};
const kebab = (name) => name.replace(/([a-z0-9])([A-Z])/g, "$1-$2").toLowerCase();
const isObject = (v) => typeof v === "object" && v !== null && !Array.isArray(v);
const isNumber = (v) => typeof v === "number" && Number.isFinite(v);
const num = (n) => String(Math.round(n * 10000) / 10000);
const px = (path, v) =>
  isNumber(v) ? `${num(v)}px` : fail(path, `expected a number, got ${JSON.stringify(v)}`);
/** Lowercased, as biome formats CSS. */
const hex = (path, v) =>
  typeof v === "string" && /^#[0-9A-Fa-f]{6}$/.test(v)
    ? v.toLowerCase()
    : fail(path, `expected #RRGGBB, got ${JSON.stringify(v)}`);

/** Rejects keys outside `allowed`, so a new token shape in Shep fails here instead of being dropped. */
function only(path, token, allowed) {
  if (!isObject(token)) fail(path, `expected an object, got ${JSON.stringify(token)}`);
  for (const key of Object.keys(token)) if (!allowed.includes(key)) fail(path, `unknown key "${key}"`);
}

/** A palette colour, optionally at an alpha: `color-mix(in srgb, <colour> N%, transparent)`. */
function paletteColor(path, tokens, name, alpha) {
  if (typeof name !== "string" || !Object.hasOwn(tokens.palette, name))
    fail(path, `unknown palette "${name}"`);
  const v = `var(--palette-${kebab(name)})`;
  if (alpha === undefined) return v;
  if (!isNumber(alpha) || alpha <= 0 || alpha >= 1) fail(path, `alpha must be in (0, 1), got ${alpha}`);
  return `color-mix(in srgb, ${v} ${num(alpha * 100)}%, transparent)`;
}

/** CSS font weights for Shep's four weight names. */
const WEIGHTS = { regular: 400, medium: 500, semibold: 600, bold: 700 };

/**
 * Easing for each Shep curve name. ease-out is CSS's own. SwiftUI's `.snappy` and the bouncy spring have no CSS
 * equal; these beziers approximate them (snappy: fast start, no overshoot; spring bounce 0.15: a small overshoot).
 */
const CURVES = {
  easeOut: "cubic-bezier(0, 0, 0.58, 1)",
  snappy: "cubic-bezier(0.2, 0.9, 0.3, 1)",
  "spring bounce 0.15": "cubic-bezier(0.34, 1.3, 0.64, 1)",
};

/** Semantic tiers a component token may name as `"<tier>.<name>"`. */
const COMPONENT_REFS = ["color", "space", "radius", "opacity"];

function semanticRef(path, tokens, ref) {
  const m = typeof ref === "string" ? /^([a-z]+)\.([A-Za-z0-9]+)$/.exec(ref) : null;
  if (m === null || !COMPONENT_REFS.includes(m[1]))
    fail(path, `expected "<${COMPONENT_REFS.join("|")}>.<name>", got ${JSON.stringify(ref)}`);
  if (!Object.hasOwn(tokens[m[1]] ?? {}, m[2])) fail(path, `unknown token ${ref}`);
  return `var(--${m[1]}-${kebab(m[2])})`;
}

/** Component values: a semantic ref string, a size in px, `{ref}`, `{palette}`, `{values}` or a nested group. */
function component(path, tokens, name, value) {
  if (typeof value === "string") return [[name, semanticRef(path, tokens, value)]];
  if (isNumber(value)) return [[name, px(path, value)]];
  if (!isObject(value)) fail(path, `unknown shape ${JSON.stringify(value)}`);
  if ("ref" in value) {
    only(path, value, ["ref", "asset", "note"]);
    return [[name, semanticRef(path, tokens, value.ref)]];
  }
  if ("palette" in value) {
    // Shep defines the terminal's text on the palette directly (tokens.json component.terminal).
    only(path, value, ["palette", "alpha", "asset", "note"]);
    return [[name, paletteColor(path, tokens, value.palette, value.alpha)]];
  }
  if ("values" in value) {
    // Content colours (the ANSI set) are literal hex, exempt from the one-meaning rule.
    only(path, value, ["values", "note"]);
    if (!Array.isArray(value.values)) fail(path, "values must be an array");
    return value.values.map((v, i) => [`${name}-${i}`, hex(`${path}.values[${i}]`, v)]);
  }
  return Object.entries(value).flatMap(([k, v]) =>
    component(`${path}.${k}`, tokens, `${name}-${kebab(k)}`, v),
  );
}

/**
 * One row per tokens.json tier: its CSS prefix and how one token becomes `[suffix, value]` pairs.
 * `skip` tiers carry metadata or checks, not values.
 */
const TIERS = {
  meta: { skip: true },
  contrast: { skip: true },
  palette: {
    prefix: "palette",
    emit: (path, _tokens, token) => {
      only(path, token, ["value", "origin", "note"]);
      return [["", hex(path, token.value)]];
    },
  },
  color: {
    prefix: "color",
    emit: (path, tokens, token) => {
      only(path, token, ["ref", "alpha", "over", "asset", "use", "note"]);
      return [["", paletteColor(path, tokens, token.ref, token.alpha)]];
    },
  },
  space: { prefix: "space", emit: (path, _tokens, token) => [["", px(path, token)]] },
  radius: {
    prefix: "radius",
    emit: (path, _tokens, token) => [["", token === "capsule" ? "999px" : px(path, token)]],
  },
  opacity: {
    prefix: "opacity",
    emit: (path, _tokens, token) => [
      ["", isNumber(token) && token >= 0 && token <= 1 ? num(token) : fail(path, `bad opacity ${token}`)],
    ],
  },
  type: {
    prefix: "type",
    emit: (path, _tokens, token) => {
      only(path, token, ["style", "weight", "size", "leading", "design", "note"]);
      if (!Object.hasOwn(WEIGHTS, token.weight)) fail(path, `unknown weight "${token.weight}"`);
      if (token.design !== undefined && token.design !== "monospaced")
        fail(path, `unknown design "${token.design}"`);
      return [
        ["size", px(`${path}.size`, token.size)],
        ["leading", px(`${path}.leading`, token.leading)],
        ["weight", String(WEIGHTS[token.weight])],
        ["family", token.design === "monospaced" ? "var(--font-mono)" : "var(--font-sans)"],
      ];
    },
  },
  motion: {
    prefix: "motion",
    emit: (path, _tokens, token) => {
      only(path, token, ["duration", "curve", "bounce", "use"]);
      if (!isNumber(token.duration)) fail(path, "duration must be a number of seconds");
      const out = [["duration", `${num(token.duration * 1000)}ms`]];
      if (token.curve === undefined) {
        if (token.bounce !== undefined) fail(path, "bounce without a curve");
        return out;
      }
      const key = token.bounce === undefined ? token.curve : `${token.curve} bounce ${token.bounce}`;
      if (!Object.hasOwn(CURVES, key)) fail(path, `no CSS easing for curve "${key}"`);
      return [...out, ["easing", CURVES[key]]];
    },
  },
  component: {
    prefix: "component",
    emit: (path, tokens, group) => {
      if (!isObject(group)) fail(path, "expected a component group");
      return Object.entries(group).flatMap(([k, v]) => component(`${path}.${k}`, tokens, kebab(k), v));
    },
  },
};

const FONTS = [
  [
    "--font-sans",
    '-apple-system, system-ui, BlinkMacSystemFont, "Segoe UI", Roboto, "Helvetica Neue", sans-serif',
  ],
  ["--font-mono", 'ui-monospace, SFMono-Regular, "SF Mono", Menlo, Consolas, "Liberation Mono", monospace'],
];

/** tokens.json text to tokens.css text. Pure and deterministic: tiers and tokens in the JSON's key order. */
export function generate(jsonText) {
  let tokens;
  try {
    tokens = JSON.parse(jsonText);
  } catch (error) {
    throw new Error("design-tokens: tokens.json is not valid JSON", { cause: error });
  }
  if (!isObject(tokens)) fail("(root)", "expected an object");
  const lines = [
    "/* GENERATED by scripts/design-tokens.mjs from tokens.json (Shep's design system, see SOURCE and DESIGN.md).",
    " * Do not edit by hand: run `node scripts/design-tokens.mjs`. */",
    ":root {",
    "  color-scheme: dark;",
    "",
    ...FONTS.map(([k, v]) => `  ${k}: ${v};`),
  ];
  for (const [tier, entries] of Object.entries(tokens)) {
    const row = TIERS[tier] ?? fail(tier, "unknown tier");
    if (row.skip) continue;
    if (!isObject(entries)) fail(tier, "expected an object");
    lines.push("");
    for (const [name, token] of Object.entries(entries)) {
      for (const [suffix, value] of row.emit(`${tier}.${name}`, tokens, token)) {
        const prop = [row.prefix, kebab(name), suffix].filter(Boolean).join("-");
        lines.push(`  --${prop}: ${value};`);
      }
    }
  }
  lines.push("}", "");
  return lines.join("\n");
}

const git = (dir, ...args) => execFileSync("git", ["-C", dir, ...args], { encoding: "utf8" }).trim();

function sync(shepDir) {
  const dir = resolve(shepDir);
  if (git(dir, "status", "--porcelain", "--", SHEP_TOKENS) !== "")
    throw new Error(
      `design-tokens: ${SHEP_TOKENS} has uncommitted changes in ${dir}; sync a committed revision`,
    );
  const commit = git(dir, "rev-parse", "HEAD");
  const source = [
    `repo: ${git(dir, "remote", "get-url", "origin")}`,
    `path: ${SHEP_TOKENS}`,
    `commit: ${commit}`,
    // The Shep commit's date, so a resync of the same revision writes the same file.
    `date: ${git(dir, "log", "-1", "--format=%cs", commit)}`,
    "",
  ].join("\n");
  const css = generate(readFileSync(join(dir, SHEP_TOKENS), "utf8"));
  copyFileSync(join(dir, SHEP_TOKENS), paths.json);
  writeFileSync(paths.source, source);
  writeFileSync(paths.css, css);
  console.log(`synced ${SHEP_TOKENS} at ${commit}`);
}

function main(argv) {
  if (argv[0] === "sync") {
    if (argv[1] !== "--shep" || argv[2] === undefined || argv.length !== 3)
      throw new Error("usage: design-tokens.mjs sync --shep <dir>");
    return sync(argv[2]);
  }
  const css = generate(readFileSync(paths.json, "utf8"));
  if (argv.length === 1 && argv[0] === "--check") {
    let current = "";
    try {
      current = readFileSync(paths.css, "utf8");
    } catch {}
    if (current !== css) {
      console.error(
        "design-tokens: tokens.css is not what tokens.json generates; run node scripts/design-tokens.mjs",
      );
      process.exitCode = 1;
    }
    return;
  }
  if (argv.length !== 0) throw new Error("usage: design-tokens.mjs [--check | sync --shep <dir>]");
  writeFileSync(paths.css, css);
}

if (process.argv[1] !== undefined && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    main(process.argv.slice(2));
  } catch (error) {
    console.error(error instanceof Error ? error.message : error);
    process.exitCode = 1;
  }
}
