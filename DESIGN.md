# Factorio viewer and dashboard design

This page says how the owner dashboard and run viewer look and why. It applies Shep's shared nubl design system to Factorio, as exmach does. Read the cited Shep pages for the full rules; this page does not copy them.

Citations name `shep/design/system/<path>` in `git@github.com:giuseppecrj/shep.git` at commit `df025761ddb25472f0e86cd96911533b1132745e` (`df02576`). All Shep citations below use that pin, recorded in `server/viewer/design/SOURCE`.

## Purpose and status

- **Shep governs the viewer and dashboard.** _Why:_ Factorio, exmach and Shep should look and speak like one product.
- **Dark only.** No light theme or `prefers-color-scheme` switch. _Why:_ Shep is dark only (`shep/design/system/principles.md`, “Out of scope”), and one theme keeps the states small.
- **This PR lays the foundation only. The viewer is not on the tokens yet.** The next PR, the viewer restyle, moves it onto them. No UI changes ship here. _Why:_ the shared rules and drift check should land before the dashboard is built.
- **Pages stay server-rendered, with no client script.** Use native disclosures. _Why:_ the viewer's CSP and small runtime remain useful constraints.

## The four principles on the viewer and dashboard

The order comes from `shep/design/system/principles.md`. A higher principle wins a conflict.

### 1. Calm until it needs you

- **Healthy draws no warning.** “Running · last tick 12s ago” is plain `textSecondary`, with no dot or badge. _Why:_ no warning is the reassurance.
- **Only needs-you orange and error red signal problems.** A stopped controller gets an error Notice. An owner hold gets a neutral info Notice. _Why:_ failure and a deliberate pause are different facts.
- **Token bars stay neutral.** They answer how much of the cap is used, without changing hue as they fill. _Why:_ usage is not a state.
- **Nothing animates.** A running step has a word, not a spinner. _Why:_ the record should be calm to read.

### 2. Native first

- **Use native HTML.** Use `a`, `button`, `form`, `details`, `summary` and `table`, styled with tokens. No component library or CSS framework. _Why:_ native controls bring keyboard, focus and mobile behaviour.
- **Keep 44 px targets, a visible focus ring and text labels.** Use `--space-hit-target`. _Why:_ a phone and a keyboard must both work.
- **The Hold control is one form with one button.** _Why:_ it needs no client script or custom control.

### 3. One meaning per colour

Follow `shep/design/system/status.md` and `shep/design/system/components/status-indicators.md`. Every state has a word. Where it has a glyph, the glyph and word share the state's colour; the rest of the row does not. Colour alone is never enough.

The table uses Shep token names. CSS uses their kebab-case form, such as `attentionText` → `--color-attention-text`.

| F09c state | Shep meaning | Colour | Word | Glyph |
| --- | --- | --- | --- | --- |
| `pr_review` | Needs you | `attentionText` | "Your review" | `alert-circle` |
| `question_asked` | Needs you | `attentionText` | "Your answer" | `help-circle` |
| `spec_review` (not enabled in v1) | Needs you | `attentionText` | "Approve spec" | `alert-circle` |
| `blocked` (owner hold) | Needs you | `attentionText` | "On hold: reason" | `alert-circle` |
| `budget` | Needs you | `attentionText` | "Out of budget" | `alert-circle` |
| `failed` | Not done | `error` | "Failed: class in plain words" | `alert-triangle` |
| `question_answered` | Working, the factory's move | `textSecondary` | "Answered, resuming" | none |
| working (no attention kind) | Working, neutral, never green | `textSecondary` | "Working" | none |
| done (landed or closed) | Finished | `textSecondary` | "Landed", "Closed" | `circle-check` |
| stale (an age, not a state) | n/a | the row's own colour | "Waiting 3 days", "No progress for 6 hours" | none |
| controller stopped | Not done | `error` Notice | "Stopped since 13:02" | `alert-triangle` |
| local hold on | Owner's choice, neutral | Notice in `textSecondary` | "On hold" | none |
| controller healthy | Draws nothing | plain `textSecondary` text | "Running · last tick 12s ago" | none |

- **Stale is an age, not faded data.** Do not use `--opacity-stale` for an old wait. _Why:_ Shep reserves it for data too old to act on.
- **A replaced budget stop is “Stopped: out of tokens” in `error`.** _Why:_ nothing is owed on that old run, but it did not finish.
- **Orange marks the state, never the action.** The primary action uses `accent` with `textOnFill`; secondary actions use an outline. _Why:_ colour finds the problem and shape finds the answer.

### 4. The record is for reading

- **Put issue titles before run IDs.** Give each run a plain sentence in `body`. _Why:_ the owner recognises work by its meaning.
- **Use monospace only for SHAs, run IDs, code and commands.** Turn failure classes into plain words. _Why:_ the dashboard is not a terminal.
- **Keep all evidence readable through Details.** Include receipts, models, seats and routes. _Why:_ a summary must not hide what changes a decision.
- **Chrome steps back.** Cards sit one surface step from the page. _Why:_ text should have the highest contrast.

## Tokens

- `server/viewer/design/tokens.json` is a byte copy of `shep/design/system/tokens.json` at the pinned commit, identical to exmach's copy. `SOURCE` records the repo, path, commit and commit date.
- `scripts/design-tokens.mjs` generates `server/viewer/design/tokens.css`. It is exmach's generator with only paths changed. It uses Node and its standard library.
- Tiers are palette, semantic (`color`, `space`, `radius`, `type`, `motion`, `opacity`), then component. See `shep/design/system/tokens/README.md`.
- Names are `--<tier>-<kebab-name>`. Prefer semantic tokens in page CSS and component tokens where Shep has one, such as `--component-card-*` and `--component-notice-*`.
- Use tokens only, never raw colours in UI CSS. `transparent`, `currentColor` and `inherit` are fine. Never hand-edit `tokens.css`.
- Translucent colours use `color-mix` with palette references. Motion maps to CSS easing; unknown shapes or curves fail generation. Honour `prefers-reduced-motion` if motion is added later.
- `test/design-tokens.test.ts` checks exact generated output and that every variable used by `tokens.css` is defined there. It does not yet enforce the old viewer stylesheet.
- Biome skips these two files because `tokens.json` is a byte copy of Shep and `tokens.css` is generated; the drift test guards them instead.

## Typography on the web

Follow `shep/design/system/foundations/typography.md`.

- **Use system fonts, with no web fonts.** `--font-sans` for reading and chrome; `--font-mono` for machine text. _Why:_ nothing needs to load from the network.
- **Map Shep's type scale through `--type-*`.** Each role has size, leading, weight and family. Regular is 400, medium 500, semibold 600 and bold 700. _Why:_ the hierarchy stays shared.
- **Use `largeTitle` only for “Factory” on home.** Run-page issue titles use `title`. Row titles and step names use `headline`; run sentences use `body`; button labels use `bodyStrong`. Section headers use `label`, times and metadata use `footnote`, count badges use `badge`, and the “Sample” chip uses `caption`. _Why:_ run pages should not compete with the home title.
- **Keep form controls at least 16 px.** `body` is 17 px. Never block browser zoom. _Why:_ small inputs trigger iOS focus zoom; browser zoom is the web's Dynamic Type.
- **Use sentence case, never uppercase transforms.** _Why:_ capitals shout.
- **Use tabular numbers for tokens, ages, times and counts.** _Why:_ ticking values must not move the line.

## Icons

- **Words first.** Glyphs never replace labels. _Why:_ words work without colour or an icon.
- **Use Tabler Icons outline, pinned at `v3.50.0`, under MIT.** Vendor the used SVGs and MIT notice with the viewer restyle PR, not this foundation. No runtime dependency, CDN or icon font. _Why:_ one family keeps one voice and leaves the CSP alone.
- **Do not ship SF Symbols or Shep's exported SVGs.** Map roles from `shep/design/system/symbols.json` instead. _Why:_ the web needs its own licensed assets.
- **Use outlined glyphs, `aria-hidden="true"`, `stroke="currentColor"` and em sizing.** _Why:_ words carry accessibility and glyphs scale with them. See `shep/design/system/foundations/iconography.md`.

| Shep role | Tabler glyph | Viewer role |
| --- | --- | --- |
| `exclamationmark.circle`, needs you | `alert-circle` | Review, hold, budget, spec approval; a step waiting on you |
| `questionmark.circle`, question | `help-circle` | Your answer |
| `exclamationmark.triangle`, error | `alert-triangle` | Failed, Stopped, Can't be read; error Notices; the failed step |
| `checkmark.circle`, done | `circle-check` | Landed, Closed, passed step, Proven |
| `circle`, idle | `circle` | Step not reached, in `textTertiary` |
| `info.circle`, info | `info-circle` | Neutral on-hold Notice |
| `chevron.right`, `chevron.down`, `chevron.left` | `chevron-right`, `chevron-down`, `chevron-left` | Closed/open disclosure; back to All runs |
| none, web-only | `external-link` | GitHub link, in `textTertiary` |

Passed steps use `circle-check` in `textSecondary`. Waiting steps use `alert-circle` in `attentionText` with “Waiting for your review”. Failed steps use `alert-triangle` in `error`. A running step has no glyph, only “Running”.

## Components

All pages in this map are at `df02576`.

| Viewer piece | Shep page | On the web |
| --- | --- | --- |
| Run row | `shep/design/system/components/machine-row.md`, `shep/design/system/status.md` | List item with headline, metadata, state, age, neutral token bar and GitHub action. Selection uses `surfaceSelected`. |
| Row state | `shep/design/system/components/status-indicators.md` | Glyph and word, no tinted pill. |
| Needs-you count | `shep/design/system/patterns/needs-you.md`, `shep/design/system/components/status-indicators.md` | Neutral tile; orange count badge only here. |
| Group header | `shep/design/system/components/section-header.md` | Sentence-case `label`, `textSecondary`, no counts. |
| Notice | `shep/design/system/components/notice.md` | Component fill and radius; error or neutral glyph, `textPrimary` message in `footnote`. |
| Buttons | `shep/design/system/components/buttons.md` | One primary accent capsule for the main needs-you action; secondary outline. |
| Hold form | `shep/design/system/components/form-field.md` | Native form and button, with same-origin action and hidden process token. |
| Empty and error states | `shep/design/system/patterns/states.md`, `shep/design/system/components/empty-state.md` | Keep known content. Unreadable runs get a Notice above the list. Empty problem groups are absent. |
| Cards and evidence | `shep/design/system/principles.md`, `shep/design/system/components/command-block.md` | Component card tokens; native Details keeps evidence readable. |

## The colour legend

This legend belongs here, or behind a small help link, never on the dashboard.

| Colour or token | Meaning |
| --- | --- |
| Orange `attentionText` | Needs your review, answer or intervention; glyph and word, not a row fill |
| Orange `attention` | The needs-you count badge; not an action colour |
| Red `error` | Not done: a failed run, failed stage or stopped controller |
| Neutral `textSecondary` | Working, done, ages, metadata, healthy status and an owner's deliberate hold |
| Lilac `textAccent` | Links |
| Lavender `accent`, `surfaceSelected` | Primary action, selected control or row, focus ring; never a run state |

Green is not used for working, passed or healthy factory states. Shep reserves it for Connected in a machine list (`shep/design/system/status.md`).

## The twelve owner rulings

These rules supersede the v2 mockup where it differs.

1. **Needs-you rows have no tinted pill. Use the orange glyph and word in `attentionText`.** _Why:_ Shep marks the state, not the whole row.
2. **Show the count badge only on the “need you” tile, never on rows.** _Why:_ one count is enough.
3. **Draw links in lilac `textAccent`.** _Why:_ links need the same recognisable treatment everywhere.
4. **Put no counts in group headers.** _Why:_ headers organise the list without repeating the tiles.
5. **Order newest first within each group. Keep age words for old waits.** _Why:_ recent changes are easy to find without hiding old work.
6. **Keep `external-link` on GitHub links. It is web-only.** _Why:_ leaving the viewer should be clear.
7. **Run pages use `title` for the issue title. Only “Factory” on home uses `largeTitle`.** _Why:_ the page hierarchy stays quiet and consistent.
8. **Below the phone breakpoint, put the status line under the title on its own line. Share the header across pages.** _Why:_ phone widths should not squeeze the title and status together.
9. **The “need you” tile uses a neutral surface, not `attentionTint`. Keep the orange badge and word.** _Why:_ Shep reserves that tint for approval and dialog cards.
10. **Absent problems draw nothing. Omit empty groups, including “No failed runs right now”.** _Why:_ reassurance should not compete with work.
11. **Keep the colour legend in DESIGN.md or behind a small help link, not on the dashboard.** _Why:_ it helps learning without becoming permanent chrome.
12. **Put the failure glyph on the stage that failed. `review_input_too_large` marks Review, not PR.** _Why:_ the owner needs the real failure location.

## Settled rules A–H

- **A. “Working” and “Done recently” are display groups, not attention kinds. Keep seven attention kinds.** _Why:_ grouping the page must not change the attention model.
- **B. The “no rendered link leaves `/factory/`” rule applies only to internal navigation. GitHub action links are required.** _Why:_ review and answers still happen on GitHub.
- **C. F09c's file scope includes `server/viewer/style.css`, the web-app manifest and icons, and vendored design files.** _Why:_ the dashboard needs these assets to follow the system from day one. This foundation PR still changes no UI files.
- **D. The hold form requires CSP `form-action 'self'` and a per-process token in a hidden field. This is the only security-posture change.** _Why:_ the one owner control needs same-origin submission and forgery protection without widening other access.
- **E. Read the clean-landing metric from a local controller-written snapshot. Never call GitHub during a page request.** _Why:_ rendering stays local and predictable.
- **F. Dark only. Vendor Shep tokens at `df02576` and Tabler outline glyphs at `v3.50.0` with their MIT notice in this public repo.** _Why:_ reviewed pins make the shared look reproducible without runtime fetches. Glyphs arrive with the restyle.
- **G. Stale is an age, not a state. Put owner-held and out-of-budget runs under Needs you, with distinct reasons. Order groups Needs you, Failed, Working, Done recently; fold the last.** _Why:_ the owner sees obligations first, then failures, then ongoing and completed work.
- **H. Bundle `tokens.css` into the served `/style.css`. Add no route and leave the CSP unchanged for tokens.** _Why:_ the shared styles need no new serving or trust surface. The restyle PR wires this up.

## Updating the tokens

1. Use a Shep checkout at the committed revision to pin.
2. Read `git -C <shep> diff <old-sha> <new-sha> -- design/system/`. Review changed rules as well as values.
3. Run `node scripts/design-tokens.mjs sync --shep <shep>`. This is the only token-update path. It copies the JSON, records HEAD, origin and the commit date in SOURCE, and generates CSS. It refuses uncommitted token changes.
4. Run `node scripts/design-tokens.mjs --check` and `npm run check`. Unknown token shapes fail with their path; extend the generator's tier table rather than dropping values.
5. Commit `tokens.json`, `SOURCE` and `tokens.css` together. Update this page for changed rules and pins. To regenerate CSS from the unchanged vendored JSON, run `node scripts/design-tokens.mjs`.

## Follow-ups

These are plans, not shipped behaviour: the viewer restyle consumes the tokens, vendors the glyphs and checks the page stylesheet. F09c then builds the owner dashboard on that foundation.
