---
name: style-reference
description: Copy a reference's visual system from a URL or screenshot into existing components or new pages, including authenticated references, typography, color roles, light/dark modes, spacing, surfaces, and motion. Use for requests such as "style it like", "make it look like", "copy the style of", "create a page inspired by", "design this like", "use the same aesthetic as", or applying a reference across a whole app. Preserve the target project's design-system conventions, especially shadcn semantic tokens, instead of copying the reference's private palette names.
---

# Style Reference

You are extracting the **visual style** from `$ARGUMENTS` and applying it to this project — either restyling existing components or creating a new page/component that matches the aesthetic.

This is NOT a full website clone. You are a **style detective**: extract the design language, then apply it surgically to what the user needs.

## Critical Rule: Element-First Tracing

**NEVER guess a CSS value.** Always trace forward from the actual DOM:

```
HTML element → class names on that element → CSS rule for those classes → resolve CSS variables → final hex/px value
```

If you skip any step in this chain, you WILL get the wrong value. Design token files contain dozens of colors — picking one that "looks right" leads to wrong results. The only reliable path is tracing what class is actually applied to the specific element you're styling.

## Non-Negotiable Acceptance Gates

Do not call the work complete until every applicable gate passes:

1. **Correct browser context:** Inspect the actual reference in the user's connected, logged-in Chrome context when authentication is required. Never substitute a public page, search result, screenshot from another session, or guessed values. If that context cannot be reached, report the block before styling.
2. **Typography parity:** Record computed `font-family`, loaded font files, size, weight, line-height, and letter-spacing for representative elements. Verify the target's computed typography after implementation. Never claim a font match from appearance alone.
3. **Theme parity:** Identify the reference's active color mode and any light/dark behavior. Inspect both modes when the request covers the whole app or includes dark mode.
4. **Native token architecture:** Discover the target's existing design system before editing. If `components.json` or shadcn semantic variables exist, use the `shadcn` skill and shadcn roles such as `background`, `card`, `popover`, `muted`, `accent`, `primary`, `border`, and their foreground pairs.
5. **No palette alias layer:** Never introduce generic numbered app-surface palettes such as `base-100..900`, `accent-500`, `neutral-*`, or utilities such as `bg-base-800` to imitate a reference. Put the reference values behind the target system's semantic variables. Use a narrowly named, scoped custom variable only when no semantic role exists.
6. **No blind replacement:** Map each consumer by UI role and ancestry. Never globally replace one source class/color with one target class without inspecting its element, parent surface, nested surface, and interactive state.
7. **Surface contrast check:** For every page, panel, card, nested control, popover, and hover/selected state, compare computed backgrounds. Adjacent equal colors are allowed only when confirmed in the reference or explicitly intended; accidental collisions must be fixed.
8. **Single token source:** Do not duplicate identical theme values in `:root` and `.dark`. Combine selectors for a dark-only system or keep only mode-specific overrides.
9. **Rendered verification:** Build the project and inspect the exact target routes in Chrome. Source-code inspection alone is not verification.

## What This Skill Does vs. Clone-Website

| | style-reference | clone-website |
|---|---|---|
| Goal | Borrow the aesthetic | Reproduce the full site |
| Scope | Targeted components/pages | Entire website |
| Content | Keep project's own content | Copy site's content verbatim |
| Assets | Minimal (colors, fonts) | Download everything |
| Output | Restyled components in-place | New complete route/app |

## Parse the Request

From `$ARGUMENTS`, determine:
1. **The reference** — a URL, screenshot path, or description of the source style
2. **The target** — what to build or restyle. Could be:
   - A specific existing component (e.g. "the hero section")
   - A page route to create (e.g. "a new /pricing page")
   - General: apply to the whole app's design system

If the target is ambiguous, ask before proceeding.

## Pre-Flight

1. Record the current branch and worktree status. Preserve unrelated user changes.
2. Read the existing target component, route, global stylesheet, layout/font setup, `package.json`, and design-system config such as `components.json`.
3. Inventory current color/font tokens and their consumers before adding anything. Search for semantic variables, hardcoded colors, and custom palette utilities.
4. Determine the correct project build command from `package.json` and run it to establish the baseline. Record pre-existing failures instead of attributing them to the restyle.
5. Open the current target route and record its pre-change screenshot and representative computed styles.
6. If source and localhost disagree after a branch switch or theme change, reload without cache or restart the dev server before drawing conclusions. Do not diagnose from stale framework output.

## Phase 1: Style Extraction

The goal is to extract the **design language**, not the content. You MUST follow the element-first tracing methodology.

### Step 1: Get the DOM Structure

Navigate to the reference URL with Chrome DevTools MCP. If the user says the page is already connected or logged in, first list/select that existing tab and preserve its browser context. Take a snapshot to get the element tree with UIDs and class names.

For each component you need to style (navbar, hero, cards, footer, etc.):
1. Identify the exact HTML elements (the `<a>`, `<p>`, `<button>`, `<div>` tags)
2. Record the **exact CSS class names** on each element
3. Note parent-child relationships (some styles inherit)

### Step 2: Extract Computed Styles per Element

For each key element, use `evaluate_script` to get computed styles:

```javascript
(el) => {
  const cs = getComputedStyle(el);
  return JSON.stringify({
    color: cs.color,
    backgroundColor: cs.backgroundColor,
    fontFamily: cs.fontFamily,
    fontSize: cs.fontSize,
    fontWeight: cs.fontWeight,
    lineHeight: cs.lineHeight,
    letterSpacing: cs.letterSpacing,
    textTransform: cs.textTransform,
    borderRadius: cs.borderRadius,
    border: cs.border,
    borderTop: cs.borderTop,
    borderRight: cs.borderRight,
    borderBottom: cs.borderBottom,
    borderLeft: cs.borderLeft,
    padding: cs.padding,
    paddingTop: cs.paddingTop,
    paddingRight: cs.paddingRight,
    paddingBottom: cs.paddingBottom,
    paddingLeft: cs.paddingLeft,
    margin: cs.margin,
    boxShadow: cs.boxShadow,
    textDecoration: cs.textDecoration,
    width: cs.width,
    height: cs.height,
    display: cs.display,
    position: cs.position,
    gap: cs.gap,
    justifyContent: cs.justifyContent,
    alignItems: cs.alignItems,
    flexDirection: cs.flexDirection,
    overflow: cs.overflow,
    zIndex: cs.zIndex,
    transition: cs.transition,
    cursor: cs.cursor,
  });
}
```

Pass the UID of the specific element. Do this for EACH distinct element type: nav links, headings, body text, buttons, cards, etc.

**This gives you the resolved, final values — no variable chasing needed.**

### Step 3: Extract the Color Palette

```javascript
(() => {
  const colors = new Map();
  [...document.querySelectorAll('*')].slice(0, 500).forEach(el => {
    const cs = getComputedStyle(el);
    ['color','backgroundColor','borderColor','borderTopColor','borderRightColor','borderBottomColor','borderLeftColor'].forEach(prop => {
      const v = cs[prop];
      if (v && v !== 'rgba(0, 0, 0, 0)') {
        colors.set(v, (colors.get(v) || 0) + 1);
      }
    });
  });
  return JSON.stringify([...colors.entries()].sort((a,b) => b[1]-a[1]).slice(0, 20));
})();
```

Map colors to roles: primary, secondary, background, surface, text, muted, accent, border.

### Step 4: Extract Typography

```javascript
(() => {
  const fonts = {};
  ['h1','h2','h3','p','button','a','label','nav a','header a'].forEach(sel => {
    const el = document.querySelector(sel);
    if (!el) return;
    const cs = getComputedStyle(el);
    fonts[sel] = {
      fontFamily: cs.fontFamily,
      fontSize: cs.fontSize,
      fontWeight: cs.fontWeight,
      lineHeight: cs.lineHeight,
      letterSpacing: cs.letterSpacing,
      textTransform: cs.textTransform,
      color: cs.color,
    };
  });
  return JSON.stringify(fonts, null, 2);
})();
```

**Important:** Different elements often use different colors even for the same tag type. Nav links may be blue while body links are dark. Always check per-element, never assume one value applies everywhere.

Also inspect the actual font loading state:

```javascript
(() => ({
  status: document.fonts.status,
  faces: [...document.fonts].map(face => ({
    family: face.family,
    weight: face.weight,
    style: face.style,
    status: face.status,
  })),
  resources: performance.getEntriesByType('resource')
    .map(entry => entry.name)
    .filter(name => /\.(woff2?|ttf|otf)(\?|$)/i.test(name)),
}))();
```

Do not start implementation until the primary UI font has been identified. If the exact font cannot legally or technically be used, tell the user and state the fallback before claiming completion.

### Step 5: Extract Spacing, Surfaces & Motion

- Section padding (top/bottom on main content areas)
- Card internal padding
- Gap between grid/flex items
- Border-radius values (sharp/rounded/pill — and exact px)
- Max-width of content containers
- Button padding and height
- Shadow styles on cards, modals, dropdowns
- Border styles (color, width)
- Background treatments (gradients, noise texture, solid)
- Transition durations and easing curves
- Hover/active state changes

Build a surface hierarchy table for every target route before mapping tokens:

| Element | Parent surface | Resting background | Hover/active background | Border |
|---|---|---|---|---|
| Page | viewport | computed value | n/a | n/a |
| Section/panel | page | computed value | computed value | computed value |
| Card/list item | section | computed value | computed value | computed value |
| Nested input/control | card | computed value | computed value | computed value |

This table prevents a source class name from being mistaken for a semantic role.

### Step 6: Extract Theme Modes

Inspect `document.documentElement.className`, theme-related data attributes, `color-scheme`, and `matchMedia('(prefers-color-scheme: dark)')`. If a toggle exists, capture computed colors and screenshots in every supported mode. Record which mode the user referenced.

### Step 7: Synthesize

Write a one-paragraph description of the design personality:
> "White background with blue primary accents. 18px medium-weight nav links in blue (#1850DC). Pill-shaped buttons (999px radius). 52px fixed navbar with light tan border (#CDC3B8). Clean sans-serif typography (Volte). The overall feel is clean food-delivery SaaS."

### Step 8: Integrate Fonts (if needed)

If the reference uses custom fonts (not Google Fonts):
1. Identify font resources from `document.fonts`, preload tags, stylesheets, and the Network panel.
2. Use an existing licensed project copy when available. Download only when permitted and technically accessible.
3. Store local fonts in the project's established font directory and load them with the framework's native font loader such as `next/font/local`.
4. Set the project's existing font CSS variables rather than inventing parallel font utilities.
5. Verify `document.fonts.check(...)` and computed `fontFamily` on the target route.

## Phase 2: Design Token Mapping

Map what you extracted to this project's token system.

### If restyling the whole app
Locate the actual global stylesheet instead of assuming `src/app/globals.css`. Preserve its structure and update semantic values in place.

If the project uses shadcn, map visual roles as follows:

| Visual role | Preferred shadcn token |
|---|---|
| App/page canvas | `background` / `foreground` |
| Primary content card or shell | `card` / `card-foreground` |
| Menus, dialogs, floating surfaces | `popover` / `popover-foreground` |
| Subtle section or input surface | `muted` / `muted-foreground` |
| Interactive hover/selected surface | `accent` / `accent-foreground` |
| Brand action | `primary` / `primary-foreground` |
| Dividers and outlines | `border`, `input`, `ring` |
| Error state | `destructive` |

Treat source names such as `base-800` only as evidence of a resolved color, never as names to copy. Two elements using the same source class may serve different semantic roles in the target.

Do not blow away existing tokens and do not create a second palette beside them. Search all old colors and custom utilities to inventory consumers, then migrate each occurrence by role. Review parent/child combinations after every broad migration.

For a dark-only app, define the dark semantic values once, for example under `:root, .dark`. For dual-mode apps, keep shared values in `:root` and only actual dark overrides in `.dark`; never repeat identical blocks.

### If creating a new component/page only
Create scoped CSS variables at the component level, or apply Tailwind classes directly. Don't pollute the global design system for a one-off page.

### Font updates
If the reference uses different fonts than the project:
- Check if they're available in `next/font/google`
- If not, download the font files and use `next/font/local`
- Add them to the project's actual root layout with its existing CSS variable names
- Never reference CDN fonts directly in component files
- Verify computed target typography against the reference before moving on

## Phase 3: Build the Target

### Option A: Restyle an Existing Component

1. Read the current component file carefully
2. Keep the component's structure and props intact — only change styling
3. Apply the extracted design tokens (colors, radius, shadow, typography, spacing)
4. Use the **exact computed values** from Phase 1 Step 2 — not approximations
5. Apply the interaction feel (hover states, transitions)
6. Run the project's actual typecheck or build command — fix errors introduced by the change

### Option B: Create a New Page or Component

Design the page structure based on the reference's **layout patterns** (not its content). Extract:
- Layout structure (CSS classes for flex/grid containers, heights, padding, gaps)
- Is it card-heavy or editorial?
- Hero with centered text or asymmetric?
- Navigation style (top bar, sidebar, floating pill)?
- CTA placement and visual weight?
- How is whitespace used (generous/tight)?

**Before coding any layout, verify it with `getBoundingClientRect()`** — screenshots can't tell you whether text OVERLAYS an image vs. sits above it, or whether spacing is padding/margin/gap/absolute positioning. For each section you're borrowing layout from: call `getBoundingClientRect()` on the key elements and their siblings. Overlapping rects = z-index stacking, not sequential flow. Also check `transform` on containers — `scale()` visually shrinks without changing CSS dimensions. Trust the rects, not the screenshot.

Then:
1. Create the file at the appropriate path
2. Use the project's own content/copy — not the reference site's text
3. Apply the extracted visual style with exact values
4. Wire it into the app unless user says otherwise
5. Run the project's actual typecheck or build command — fix errors introduced by the change

## Phase 4: Visual Check

Use Chrome DevTools MCP to view both the reference and your result:
1. Take a screenshot of the reference
2. Take a screenshot of your built component at `localhost:3000`
3. Compare element by element — not just "overall vibe"

For each element, verify:
- [ ] Exact color matches (use eyedropper or compare computed values)
- [ ] Font family, size, weight, line-height match
- [ ] Border radius matches
- [ ] Button style matches (height, padding, radius, colors)
- [ ] Spacing/padding matches
- [ ] Hover states feel similar
- [ ] Layout structure matches (centered logo vs left-aligned, etc.)
- [ ] Active theme mode matches, and both modes work if supported
- [ ] Page, panel, card, list item, and nested control backgrounds preserve the intended hierarchy
- [ ] Transparent children are evaluated by their composed visible background, not reported as though transparent were a separate color
- [ ] No accidental parent/child surface collision was introduced by semantic-token mapping
- [ ] Target computed `fontFamily`, font weight, line-height, and letter-spacing match the extracted reference

After the visual comparison, run a source audit:

- Search for copied numbered palette utilities or definitions (`base-[0-9]`, `accent-[0-9]`, `--color-base-*`, and similar aliases).
- Search for duplicate theme variable blocks.
- Search for raw framework palette colors used for semantic UI states when the project has semantic equivalents.
- Confirm every exact route requested by the user was loaded in the correct authenticated context.

**If something doesn't match**, go back to Phase 1 Step 2 and re-extract the computed style for that specific element. Do NOT guess a fix.

## What NOT to Do

- **Don't guess CSS values** — always trace from the actual DOM element. This is the #1 source of errors.
- **Don't assume one color applies everywhere** — nav links, body text, headings, and buttons often use different colors even on the same page.
- **Don't pick colors from a design token list** — tokens contain many colors; only the class chain tells you which one applies to which element.
- **Don't copy content verbatim** — this is style borrowing, not content copying. Use the project's own content.
- **Don't over-apply** — if the user wants to style one component, don't restyle the whole app.
- **Don't install new UI libraries** unless necessary (the project already has shadcn/ui + Tailwind).
- **Don't rebuild existing components from scratch** when restyling — keep the structure, change the styling.
- **Don't infer layout from screenshots when building new pages** — use `getBoundingClientRect()` to confirm whether elements are sequential or overlaid before coding layout. Overlapping rects = z-index stacking.
- **Don't only extract parent-level styles** — borders, shadows, and backgrounds often live on child wrapper elements, not the parent. Always check child elements too, and extract individual border sides (`borderTop`, `borderRight`, `borderBottom`, `borderLeft`) since the `border` shorthand hides single-side values.
- **Don't forget active/selected state styling on children** — an active item might have a blue border ring on its icon `<div>`, not on the `<button>`. Extract both active and inactive states including all child elements.
- **Don't copy the reference's token vocabulary into the project** — copy resolved visual values into the project's semantic roles.
- **Don't add `bg-base-*`, `text-base-*`, `border-base-*`, or numbered accent utilities to a shadcn project** — use semantic utilities.
- **Don't run a global one-to-one palette replacement** — the same source color can represent a page, card, input, or overlay depending on context.
- **Don't leave identical `:root` and `.dark` token blocks** — consolidate them or keep only real overrides.
- **Don't treat `rgba(0, 0, 0, 0)` as a visible list/card color** — trace the composed background through ancestors.
- **Don't say fonts match without inspecting both loaded font resources and computed target typography.**
- **Don't use an unauthenticated or different browser context when the user explicitly points to a connected logged-in reference.**

## Completion

Report:
- Reference analyzed: `<url or description>`
- Target built/restyled: `<file path>`
- Design tokens extracted and applied: colors, fonts, radius, shadows
- Target semantic mapping used (for example `background`, `card`, `muted`, `primary`)
- Exact values used for key elements (list the hex/px for primary text, heading text, link text, button bg, border, background)
- Computed surface hierarchy for the important routes, including any intentional same-color nesting
- Font verification result and active theme mode(s)
- Any design decisions you made where the reference was ambiguous
- Build status: the project's actual build command and result
- Source audit result: no copied palette aliases, no duplicate theme blocks, and no accidental surface collisions
