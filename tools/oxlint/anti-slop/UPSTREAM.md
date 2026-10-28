# Upstream

This directory is a vendored copy of the anti-slop Oxlint plugin. This repository owns it from here on.

- Source: https://github.com/dmmulroy/anti-slop (MIT, see `LICENSE`)
- Commit: `13909c9e07590f5a85d93c62712259fe14a883f7`
- Copied from: `skills/install-anti-slop/assets/anti-slop/` at that commit, using `skills/install-anti-slop/scripts/install.mjs`
- Installed at: `tools/oxlint/anti-slop/`
- Generic plugin: `tools/oxlint/anti-slop/index.ts`, registered in `.oxlintrc.json` as `anti-slop`
- Effect plugin: `tools/oxlint/anti-slop/effect/index.ts`, copied but not registered, because this repository has no `effect` dependency
- `LICENSE` is upstream's root `LICENSE`. `vendor/eslint-stylistic/LICENSE` and `vendor/eslint-stylistic/UPSTREAM.md` come with the copied readability rule.
- Dependencies: `oxlint` 1.90.0 and `@oxlint/plugins` 1.90.0, both exact devDependencies

## Local choices

- This directory is outside `tsconfig.json` `include` and outside the biome `format` paths. `.oxlintrc.json` also ignores it. The plugin runs as Oxlint loads it and is not type-checked or formatted as project source.
- Intentional deviations from upstream: none. The copied files match upstream byte for byte, apart from the added root `LICENSE` and this file.
