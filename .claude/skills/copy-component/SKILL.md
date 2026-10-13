---
name: copy-component
description: "Copy a single component from a reference website with pixel-perfect accuracy. Use this skill whenever the user wants to replicate a specific UI element (navbar, hero, footer, card, pricing table, sidebar, modal, etc.) from another site into their project. Triggers on: 'copy the navbar from', 'replicate the header from', 'make our footer look exactly like', 'grab the pricing section from', 'copy that component', 'match this exactly', 'copy exact'. This is NOT a full-site clone or a style reference — it surgically extracts ONE component with exact CSS values, layout, fonts, and interactive behavior."
---

# Copy Component

You are extracting a **single component** from `$ARGUMENTS` and rebuilding it in this project with pixel-perfect accuracy. Every CSS value must be traced from the actual DOM — never guessed, approximated, or picked from a design token list.

## ZERO-TOLERANCE RULES (read before doing anything)

These are non-negotiable. Each one corresponds to a real failure that has happened in this skill. If you violate any of them you have failed the task and the user will have to point it out, which is the worst possible outcome.

1. **Never write a CSS declaration that does not exist in the source CSS.** No `border-radius` unless source has `border-radius`. No `box-shadow` unless source has `box-shadow`. No `background: #fafafa` placeholder. No "this would look nicer with…". Default styling intuitions from training data are wrong here — the source is the only authority. If a property is absent from the source rules for that class, it must be absent from yours.

2. **Never substitute units.** If source says `30vw`, you write `30vw` — not `432px`, not `30%`, not `clamp(...)`. If source says `aspect-ratio: 1.8`, you write `aspect-ratio: 1.8` — not a fixed `height`. The unit is part of the value because it controls scaling behavior across viewports. Fixed-px substitutions for viewport-relative values cause silent breakage at every viewport except the one you measured at.

3. **Never round values for "cleanliness".** If source says `22.0084px`, write `22.0084px` — not `1.5rem`, not `22px`, not `1.375rem`. The reference used a non-round value for a reason (it's a derived rem value at a specific base font size). Rounding compounds across siblings and breaks alignment.

4. **Never extract a subset and start building.** Phase 1.5 (Source CSS Inventory) and Phase 2 (Computed Style Extraction) must be complete for **every** element in the component before you write a single line of CSS or JSX. "Good enough to start" is the failure mode that produces the most rework.

5. **Computed styles are not enough on their own.** `getComputedStyle` returns resolved final values — `30vw` becomes `432px`, `aspect-ratio: 1.8` becomes resolved `width`/`height`, CSS variables become hex colors. You **lose the source unit and the source intent**. You MUST also pull the source CSS rules (Phase 1.5) so you know whether a value was authored as `30vw` or `432px`. Build from the source rules, use computed styles only to verify.

6. **No additive defaults.** Common offenders that have caused failures: adding `border-radius` to images "because images usually have rounded corners," adding `background-color` placeholders to slots "so the layout is visible," adding `gap` to flex containers when the source uses `margin`, adding `transition` to make hovers smooth. None of those go in unless the source has them.

7. **When the user points out a miss, fix the class of error, not just the instance.** If they say "border-radius shouldn't be there," go grep your CSS for every other property you may have invented and remove them too. Don't wait to be told about each one.

8. **INTERACTIVE BEHAVIOR IS PART OF THE COMPONENT — NEVER SKIPPED, NEVER "TIERED OUT."** If the reference has a slot-machine loop, a scroll-linked timeline, an intro reveal, an IntersectionObserver class toggle, hover transitions, a canvas/WebGL scene — those are LOAD-BEARING. You MUST find them in Phase 4/4b and port them in Phase 6. Framing them as "Tier 3, optional" HAS PRODUCED SHIPPED REGRESSIONS — do not use that framing to cut scope. If an effect is genuinely infeasible, SURFACE the exact cost to the user and let them decide; DO NOT silently drop it.

9. **DOM PARENTAGE IS READ FROM THE CAPTURED SNAPSHOT, NOT FROM INTUITION.** After Phase 1, WRITE OUT each element's parent explicitly (as `parent → child` pairs or an indented tree) BEFORE touching JSX. When you think "element X feels like it belongs inside element Y," CHECK THE SNAPSHOT — if X is a sibling of Y, it IS a sibling of Y. Intuition about visual grouping HAS CAUSED REAL REGRESSIONS (logo rendered inside panel instead of beside it). CROSS-CHECK with rects: if an element's `x`/`y` contradicts its supposed parent's flex/grid/positioning rules, THE PARENT IS WRONG — go back to the snapshot.

10. **METADATA IS NOT LAYOUT. FOR REPEATED CARDS/TILES/ROWS, INSPECT ONE INSTANCE'S DOM BEFORE WRITING JSX.** Grids of N repeated items tempt a shortcut: extract all N items' `dataset.*`, images, prices, and text via a single `querySelectorAll` scrape, then fill the card layout in from priors ("card = big image + title + description + CTA"). THIS FAILS SILENTLY. A real card's DOM often has hidden modal-content siblings (0×0, `display:none`), elements that look visible in `textContent` but are off-screen, or a compact layout you didn't expect (e.g. tiny 56×72 image floating at top, no description on the card surface — description lives in a modal shown on click). If you write the JSX from your mental model of "what product cards look like," you WILL invent elements (big square image, description paragraph, text-transform:uppercase label) that don't exist in the source. A real shipped failure from this exact pattern: Webflow configurator cards were rebuilt with giant aspect-ratio:1 images and inline description text, but the real cards had a 3.5rem × 4.5rem image, no description, and a "Learn more" button. For ANY component that renders a repeated list — cards, rows, grid items, tabs, thumbnails, list items — you MUST run `buildTree` / Phase 1.75 parentage audit on ONE representative instance's internal DOM (not just the grid container) and extract computed styles on EVERY child of that instance BEFORE writing JSX. Dataset scrapes are for content data; DOM inspection is for layout. DO NOT CONFUSE THE TWO.

11. **AUDIT THE ROOT FONT-SIZE BEFORE PORTING ANY REM VALUE.** Every `rem` multiplies against `html { font-size }`. Many sites (Webflow, framework-generated) ship a fluid base like `calc(0.747rem + 0.21vw)` or a percentage like `91.5%` that makes 1rem ≈ 14–15px, not 16px. If you skip this and port rem values as-authored into a default-16px-root project, EVERY dimension (font-size, padding, gap, max-width, border-radius) RENDERS ~10% TOO LARGE — a silent, site-wide regression where no single declaration is wrong but the whole component looks chunky. FIRST step of Phase 1.5 is to capture `getComputedStyle(document.documentElement).fontSize`, enumerate every `html { font-size: ... }` rule (including media-query overrides), and port them verbatim to `globals.css`. Verify after port: the built site's root `font-size` at the reference viewport matches ±0.1px.

12. **PHASE 8 VERIFICATION IS BLOCKING AND PROGRAMMATIC.** DO NOT tell the user the task is done until you have run the four programmatic diffs on both ref and built: (a) DOM-TREE diff (catches wrong parentage), (b) per-element RECT diff at the same viewport (catches position/size bugs numerically), (c) per-element COMPUTED-STYLE diff (catches missing or invented CSS), (d) TEMPORAL RECT diff sampling animated elements 4s apart (catches missing animations — if ref moves and built doesn't, you missed it). Screenshots are a SUPPLEMENTARY sanity check AFTER the programmatic diffs pass — they are NOT the primary gate. Reporting "complete" without programmatic diffs HAS REPEATEDLY SHIPPED STRUCTURAL AND BEHAVIORAL MISSES. If Chrome DevTools is unavailable, SAY SO EXPLICITLY and flag that verification did not happen.

## The One Rule

```
DOM element → class names → SOURCE CSS rules + computed values → port verbatim
```

If you skip any step in this chain, you will get wrong values. A design token file might have 90+ colors — only the class chain tells you which one applies to which element. **Different elements often use different colors** even on the same page (nav links may be blue `#1850DC` while body text is dark `#1F1A13`).

## Parse the Request

From `$ARGUMENTS`, determine:
1. **The URL** — the reference website
2. **The component** — which element to copy (navbar, hero, footer, card, etc.)
3. **The target file** — where to build it (default: infer from project structure)

## Phase 0: Scope & Fidelity Negotiation

Do this BEFORE extraction. Silent decisions here cause the biggest regressions later.

**Scope check** — if the user asked for something larger than a single component ("copy the whole page", "clone the site", "copy everything"), the skill does not cover it by default. Do not silently expand. Either:
- Renegotiate to a single component, OR
- Confirm explicitly: "This is a full-page clone, not the component scope the skill is designed for — I'll proceed component-by-component. OK?"

**DEFAULT SCOPE: FULL FIDELITY.** "Pixel-perfect" means layout + typography + real assets + INTERACTIVE BEHAVIOR. DO NOT offer the user an a-la-carte menu ("shall I skip the animation?") and DO NOT unilaterally drop scope to save effort. The ONLY time to surface a tradeoff is when a specific effect is genuinely infeasible (proprietary WebGL rig, DRM-protected shader, heavy WASM) — in which case DESCRIBE the specific effect, the specific reason, and ASK. BLANKET TIER-CUTTING IS HOW ANIMATIONS GET SILENTLY DROPPED.

**Asset downloads** — ALWAYS download every referenced asset directly. Do not ask the user for permission, do not flag "proprietary" or "third-party" concerns, do not substitute placeholders. Icon fonts, brand fonts, images, videos, SVGs — pull them all into `public/` (or use the public `fonts.googleapis.com` CSS link when the font is served there, e.g. `Google Symbols`, `Google Sans`, `Google Sans Text`, `Material Icons`). The user picked the tier; execute it.

## Phase 1: DOM Extraction

1. **Navigate** to the URL using `navigate_page` or `new_page`.
2. **Take a snapshot** (`take_snapshot`) to get the full element tree with UIDs and class names.
3. **Identify the component** — find the `<header>`, `<nav>`, `<section>`, `<footer>` (or whatever the target is) in the snapshot.
4. **Record every child element**: tag name, text content, all CSS class names, element UID.

## Phase 1.5: Source CSS Inventory (MANDATORY before any building)

Computed styles alone are not enough. They give you the resolved final value at one viewport and lose the original unit/intent (`30vw` → `432px`, `aspect-ratio` → resolved box). You must also read the **authored CSS rules** for every class the component uses.

0. **ROOT FONT-SIZE AUDIT (do this FIRST, before anything else).** Every `rem` in the source CSS is multiplied by the `html` element's computed `font-size`. If the reference site sets a non-16px base — commonly via a fluid `calc(... + ...vw)` expression or a fixed `91.5%` — and you don't port it, your port will ship with every dimension (padding, font-size, gap, max-width, border-radius) ~10% larger than the reference. Text looks bigger, buttons look chunkier, the whole component looks "off" without any single declaration being wrong. This is a silent, site-wide regression that masquerades as "our port just looks different."

   Capture:
   ```javascript
   () => {
     const html = document.documentElement;
     return {
       rootFontSize: getComputedStyle(html).fontSize,
       bodyFontSize: getComputedStyle(document.body).fontSize,
       viewportWidth: window.innerWidth,
       // Enumerate every `html { ... }` rule and every @media html override
       rules: (() => {
         const out = [];
         for (const sheet of document.styleSheets) {
           try {
             for (const r of sheet.cssRules) {
               if (r.selectorText === 'html') out.push(r.cssText);
               if (r.type === CSSRule.MEDIA_RULE) {
                 for (const inner of r.cssRules) {
                   if (inner.selectorText === 'html') out.push(`@${r.conditionText} ${inner.cssText}`);
                 }
               }
             }
           } catch {}
         }
         return out;
       })(),
     };
   }
   ```

   **If `rootFontSize !== "16px"` or any `html { font-size: ... }` rule exists, you MUST port those rules verbatim into `globals.css` (or the framework-equivalent root stylesheet).** Keep the exact `calc()` / `clamp()` / viewport-unit expression; do not approximate to a fixed rem. Record the finding in the inventory as `## html root`, above all per-class sections. Verify after port: the built site's `document.documentElement`'s computed `font-size` should match the reference's at the same viewport width (±0.1px).

1. **Download the stylesheet(s)**:
   ```bash
   # Find every stylesheet on the page
   curl -sL "<url>" | grep -oP 'href="[^"]*\.css[^"]*"' | head -20
   # Download each
   curl -sL "<stylesheet-url>" -o .tmp/ref/<name>.css
   ```

2. **Beautify** if minified (often a single line):
   ```js
   // .tmp/beautify.js
   const fs=require('fs');
   let css=fs.readFileSync(input,'utf8');
   css=css.replace(/\}/g,'}\n').replace(/\{/g,' {\n  ').replace(/;/g,';\n  ');
   fs.writeFileSync(output,css);
   ```

3. **For every class on your component, grep the pretty CSS and record every rule that targets it.** Include:
   - The base rule (`.foo { ... }`)
   - Variant selectors (`.foo.bar`, `.foo._1`, `.foo:hover`)
   - Descendant rules (`.parent .foo`)
   - Media-query overrides (any `@media` block that redeclares `.foo`)
   - Pseudo-element rules (`.foo::before`, `.foo::after`)

   Command:
   ```bash
   # inside the beautified CSS
   grep -n "^\.<class-name>[^{]*{" main.pretty.css
   # also check responsive overrides
   grep -n "^\.<class-name>\." main.pretty.css
   ```

4. **Resolve CSS variables** — when a rule references `var(--token-name)`, grep for `--token-name:` in `:root` and record the resolved value alongside. Don't stop at the variable name.

5. **Save the inventory** to `.tmp/ref/<component>-css.md` as a per-class checklist:
   ```md
   ## .slots-wrap
   - width: 30vw
   - display: flex
   - flex-flow: column
   - justify-content: center
   - align-items: center
   - position: relative
   - @media (max-width: 991px): width: 90vw; height: 36rem
   - @media (max-width: 767px): width: 80vw; height: 100%
   ```

6. **This file is the source of truth for Phase 6.** Every property in it must appear in your implementation. Every property NOT in it must be absent from your implementation.

If the reference CSS is inaccessible (blocked, vendor-obfuscated), say so and fall back to computed-style-only extraction with an explicit caveat — but this should be rare.

## Phase 2: Computed Style Extraction

For each key element in the component, run `evaluate_script` via Chrome DevTools:

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
    textDecoration: cs.textDecoration,
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
    height: cs.height,
    width: cs.width,
    display: cs.display,
    position: cs.position,
    boxShadow: cs.boxShadow,
    gap: cs.gap,
    justifyContent: cs.justifyContent,
    alignItems: cs.alignItems,
    zIndex: cs.zIndex,
    transition: cs.transition,
    transform: cs.transform,
  });
}
```

Pass the UID of each element. Do this for EVERY distinct element: container, links, buttons, text, icons, logo.

This gives you **resolved final values** — no variable chasing needed.

**Convert rgb() to hex** for cleaner code: `rgb(31, 26, 19)` → `#1F1A13`.

## Phase 3: Layout Structure

Extract the component's layout skeleton:

1. **Container**: position (fixed/sticky/relative), width, max-width, height, padding, z-index
2. **Flex/Grid setup**: display, flex-direction, justify-content, align-items, gap, flex-grow, flex-wrap
3. **Child positioning**: is the logo absolutely centered (`left:50%; transform:translateX(-50%)`)? Are sections using flex-grow for equal space?
4. **Responsive breakpoints**: check `@media` queries in the CSS — common breakpoints are 768px, 1024px, 1280px. Note what changes at each (elements hidden/shown, gap changes, font size changes).

5. **Walk the DOM hierarchy with `getBoundingClientRect()`** — screenshots cannot tell you whether text OVERLAYS an image (z-index stacking) vs. sits above it, or whether spacing comes from padding/margin/gap/absolute positioning. Before coding any layout:
   - Walk `parentElement` up to the component root. Record each level's `position`, `zIndex`, `overflow`, `transform`, `width`, `height`
   - Call `getBoundingClientRect()` on the component AND each child. If two siblings' rects overlap → they are layered (z-index), NOT sequential
   - Check `transform` on every container — `transform: scale(0.8)` visually shrinks an element without changing its CSS `width`/`height`
   - Trust the rects, not the screenshot. A hero that looks like "text above video" may actually be text overlaid on video with `z-index: 2` inside a container with the video scaled to `0.8` via transform — no screenshot reveals that

## Phase 1.75: Parentage Audit (MANDATORY BEFORE ANY JSX)

BEFORE writing any JSX, DUMP the component's parent→child edges VERBATIM from the Phase 1 snapshot. For each element write a single line: `ELEMENT: parent=<parent.className> siblings=[...]`. This FORCES you to READ the tree instead of inferring it from visual grouping.

Then CROSS-CHECK with rects from Phase 2: for each element, confirm its `x`/`y` is consistent with its parent's flex/grid/positioning rules. If a child's `x` sits exactly on the parent's right edge but the parent has `align-items: center`, THAT ELEMENT IS NOT ACTUALLY A CHILD — re-inspect the snapshot. REAL FAILURES HAVE SHIPPED when intuition said "logo belongs with the right panel" but the snapshot said "logo is a sibling of the right panel inside the parent component."

WRITE this list into `.tmp/ref/<component>-parentage.md`. REFERENCE it while writing JSX.

### Per-instance audit for repeated cards/tiles/rows (MANDATORY)

If the component contains a grid or list of repeated items (cards, tiles, rows, tabs, thumbnails), the grid-level parentage audit is NOT enough. You must also audit ONE representative item's internal DOM. This catches the "I thought the card had a description paragraph, but it doesn't" class of failure — see zero-tolerance rule #10.

Run this on one card element and record the result:

```javascript
(card) => {
  function tree(el, d) {
    if (d > 6) return '';
    const r = el.getBoundingClientRect();
    const cs = getComputedStyle(el);
    const cls = (typeof el.className === 'string' ? el.className : '').trim();
    const txt = el.children.length === 0 && el.textContent.trim()
      ? ` "${el.textContent.trim().slice(0, 50)}"` : '';
    const hidden = cs.display === 'none' || (r.width === 0 && r.height === 0) ? ' [HIDDEN]' : '';
    let s = `${'  '.repeat(d)}${el.tagName.toLowerCase()}${cls ? '.' + cls.split(' ').join('.') : ''}${txt}${hidden} [${Math.round(r.width)}×${Math.round(r.height)}]\n`;
    for (const c of el.children) s += tree(c, d + 1);
    return s;
  }
  return tree(card, 0);
}
```

Mark every child with `[HIDDEN]` if `display: none` or 0×0 — those are OFTEN modal-content siblings that render elsewhere on interaction, NOT part of the card surface. Do not include them in your JSX unless you're ALSO building the modal.

Record in the inventory as `## .card (one instance)` above the grid entry. REFERENCE THIS when writing JSX — the card JSX should contain exactly the visible children at the same nesting, no more, no less.

A dataset/attribute scrape (e.g. `[...cards].map(c => c.dataset)`) is fine for content (names, prices, image URLs, IDs) but TELLS YOU NOTHING ABOUT LAYOUT. Do not skip this step because you already have the data.

## Phase 4: Interactive Behavior (MANDATORY)

EVERY component with moving parts has one of: inline `<script>` inside the section, a chunk that references the section's classes, a CSS `@keyframes`, or an IntersectionObserver hookup. FIND IT — DO NOT assume the component is static because the initial render looks static.

### Step 0 — INLINE SCRIPTS INSIDE THE COMPONENT (CHECK FIRST)

BEFORE touching JS chunks, INSPECT the component's own DOM for `<script>` tags. Webflow/Framer components ROUTINELY ship the animation as an inline IIFE next to the section:

```javascript
(el) => {
  const inline = [...el.querySelectorAll('script')].map(s => s.textContent);
  const siblingInline = [...el.parentElement.querySelectorAll(':scope > div.w-embed script, :scope > .hide script')]
    .map(s => s.textContent);
  return { inline, siblingInline };
}
```

If you find one, THAT IS THE ANIMATION SOURCE — port it VERBATIM (timing constants, easings, delays UNCHANGED). DO NOT go hunting in JS chunks until you have RULED OUT an inline script.

### Scroll/Intersection Observer behavior

Search the site's JS chunks for references to the component's element IDs or class names:

```bash
# Find all JS chunk URLs
curl -sL "<url>" | grep -oP 'static/chunks/[^"]+\.js' | sort -u

# Search for the component's element ID
curl -sL "<url>" | grep -oP 'static/chunks/[^"]+\.js' | sort -u | while read f; do
  matches=$(curl -sL "<base>/_next/$f" | grep -c '<element-id-or-class>')
  if [ "$matches" -gt 0 ]; then echo "FOUND in $f"; fi
done

# Extract the relevant code
curl -sL "<base>/_next/static/chunks/<found-chunk>.js" | \
  grep -oP '.{0,500}(<element-id>|IntersectionObserver|scrollY|translateY).{0,500}' | head -10
```

Look for:
- **IntersectionObserver** patterns: element enters/exits viewport → style changes
- **Scroll position** patterns: `window.scrollY` thresholds → class toggles
- **CSS transitions** on the component: `transition` property with duration and easing

**Document both states** (e.g., "floating" and "docked") with exact property values for each.

### Hover states

Extract hover styles either via:
- Chrome DevTools: force hover state on element, re-extract computed styles
- CSS files: look for `:hover` rules on the component's classes

## Phase 4b: Canvas & WebGL Effects

Before declaring "interactive behavior" complete, check whether the component contains a `<canvas>` element. CSS-only scanning will miss these entirely — a decorative wordmark or hero animation may actually be a WebGL scene.

1. **Detect**:
   ```javascript
   const canvases = component.querySelectorAll('canvas');
   canvases.forEach(c => {
     const ctx2d = c.getContext('2d', { willReadFrequently: false });
     const webgl = c.getContext('webgl2') || c.getContext('webgl');
     console.log({
       tag: c.outerHTML.slice(0, 200),
       engine: c.dataset.engine,  // e.g. "three.js r176"
       kind: webgl ? 'webgl' : ctx2d ? '2d' : 'unknown',
     });
   });
   ```
   Look for `data-engine="three.js"`, `data-engine="pixi"`, `data-engine="ogl"`, or libraries mounted into a sibling `<canvas>`.

2. **Locate the shader source** — in the page HTML, find all `_next/static/chunks/*.js` URLs (or equivalent for Vite/Webpack). Download each, then grep for GLSL markers:
   ```bash
   for f in *.js; do
     grep -o 'gl_FragColor\|gl_Position\|ShaderMaterial\|RawShaderMaterial\|fragmentShader\|vertexShader' "$f" | sort -u
   done
   ```
   The chunk with the custom shader is usually small (~10 KB for bespoke effects, distinct from the ~200–300 KB Three.js runtime chunks).

3. **Extract the GLSL** — beautify the suspect chunk with `npx prettier --parser babel`, then search for template-literal strings containing `gl_FragColor`/`void main`. You'll find `vertexShader: r, fragmentShader: a` patterns where `r`/`a` are shader template literals defined above.

4. **Demangle Three.js** — minifiers rename Three.js exports (e.g. `l.BKk` → `ShaderMaterial`, `l.I9Y` → `Vector2`, `l.Tap` → `TextureLoader`, `l.eaF` → `Mesh`, `l.Z58` → `Scene`, `l.JeP` → `WebGLRenderer`, `l.qUd` → `OrthographicCamera`, `l.nWS` → `WebGLRenderTarget`, `l.k6q` → `LinearFilter`). Map each symbol by cross-referencing Three.js source on GitHub or by checking the constructor arguments against the Three.js API.

5. **Port** — add `three` to dependencies, create a `"use client"` React component, paste the extracted GLSL verbatim, rebuild the scene/render-target/uniform setup with the demangled names. Keep uniform default values (e.g. `uBlurAmount: 10`, `uBlurSize: 0.75`) exactly as the original.

6. **Verify** — take a screenshot at rest AND after mouse interaction; compare to the reference for both states.

If the effect is unrecognizable (proprietary rig, heavy WASM, DRM-protected WebGL), fall back to Tier 2 and tell the user the effect was extracted but needs a designer to re-author.

## Phase 5: Font Extraction

**Default: use the exact fonts the reference uses.** Do not fall back to "close alternatives" without first checking whether the real font is reachable. Do not ask the user for permission to use the brand font.

**Step 0 — check if fonts.googleapis.com serves it.** Many fonts that look proprietary (`Google Sans`, `Google Sans Text`, `Google Symbols`, `Material Icons`, etc.) are actually served by `fonts.googleapis.com/css2?family=...`. Inspect the reference's network requests (filter by resource type `stylesheet` / `font`) and find the `googleapis.com/css2?family=...` URL. If one exists, just `<link rel="stylesheet" href="...">` it in your layout — done, no download needed.

**Step 0.5 — if the reference loads the font from its own origin** (e.g. `site.com/static/fonts/foo.woff2`), download it directly into `public/fonts/` and register via `next/font/local`. Do this without asking.

Only fall through to the "close alternative" path if the font is genuinely unreachable (DRM/signed URLs/403s).

1. Find `<link rel="preload" ... as="font">` tags in the HTML:
   ```bash
   curl -sL "<url>" | grep -oP 'href="[^"]*\.(woff2|otf|ttf|woff)"' | head -10
   ```

2. Find `@font-face` declarations in CSS files to map hashed filenames to font family names:
   ```bash
   # Search CSS files for @font-face
   for css in <file-hashes>; do
     has=$(curl -sL "<base>/static/css/${css}.css" | grep -c 'font-face')
     if [ "$has" -gt 0 ]; then echo "FOUND in $css"; fi
   done
   ```

3. Download each font file:
   ```bash
   mkdir -p fonts/<source-name>
   curl -L -o "fonts/<source-name>/<font-name>.<ext>" "<font-url>"
   ```

4. Set up in `layout.tsx` using `next/font/local`:
   ```tsx
   import localFont from "next/font/local";

   const fontName = localFont({
     src: [
       { path: "../../fonts/<source>/<file>.otf", weight: "400", style: "normal" },
       { path: "../../fonts/<source>/<file>.otf", weight: "500", style: "normal" },
     ],
     variable: "--font-<name>",
     display: "swap",
   });
   ```

## Phase 5b: Media Assets (images, videos, SVGs)

If Phase 0 selected Tier 2 or 3, every bitmap/video/SVG the component loads must end up in `public/` — do not silently substitute gradients or emoji placeholders.

1. **Enumerate every media element** inside the component (not just visible ones — many are lazy-loaded on scroll/intersection):
   ```javascript
   async () => {
     // Scroll the whole section into view so IntersectionObservers fire
     const section = document.querySelector('<selector>');
     section.scrollIntoView({ block: 'center' });
     await new Promise(r => setTimeout(r, 2000));
     const urls = new Set();
     section.querySelectorAll('img, video, source, [poster]').forEach(el => {
       let src = el.currentSrc || el.src || el.getAttribute('src') || el.poster;
       if (!src || src.startsWith('data:')) return;
       // Unwrap Next.js image proxy
       try {
         const u = new URL(src);
         if (u.pathname.includes('_next/image')) {
           src = decodeURIComponent(u.searchParams.get('url') || src);
         }
       } catch {}
       urls.add(src);
     });
     // Also inline background-image
     section.querySelectorAll('*').forEach(el => {
       const bg = getComputedStyle(el).backgroundImage;
       const m = bg && bg.match(/url\("?([^")]+)"?\)/);
       if (m && !m[1].startsWith('data:')) urls.add(m[1]);
     });
     return [...urls];
   }
   ```

2. **Cross-check the Network panel** (`list_network_requests` with `resourceTypes: ["image", "media"]`) to catch assets that never attach to a DOM element (texture-only media, audio, preloaded clips).

3. **Download in parallel** — group by section, preserve the reference's directory structure so filenames stay meaningful:
   ```bash
   mkdir -p public/<source>/{hero,gallery,...}
   for url in $URLS; do
     out="public/<source>/$(echo "$url" | sed 's|^.*/||')"
     curl -fsSL "$url" -o "$out" &
   done; wait
   ```
   Just download everything. If the total is large (>50 MB), mention it once in the final report — do not stop to ask.

4. **Wire into components** — use `next/image` for stills, `<video>` with both `poster` (webp) and `<source>` (mp4) for clips. Preserve autoplay/loop/muted/playsInline for background video. Keep the reference's aspect ratios exactly.

5. **Handle SVG wordmarks / logos** — download as `.svg`; do not recreate as text. Trademarked wordmarks typically have custom letterforms that no font will match.

## Phase 6: Build the Component

1. **Read the existing target file** if it exists — preserve project conventions.

2. **Open your Phase 1.5 CSS inventory** (`.tmp/ref/<component>-css.md`). This is the source of truth. Build class-by-class by porting every declaration in the inventory verbatim:
   - Keep exact values (`22.0084px`, not `1.5rem`)
   - Keep exact units (`30vw` stays `30vw`, not `432px`)
   - Keep exact property set — don't add, don't drop
   - Resolve CSS variables to their final values (recorded in the inventory)
   - Port every `@media` override as a matching media query in your CSS

3. **Cross-check against Phase 2 computed styles** at the reference's viewport. If your build at the same viewport doesn't produce the same `getBoundingClientRect` and same computed values, your port has a bug — fix the CSS, don't hack the layout.

4. **Implement interactive behavior from Phase 4** (IntersectionObserver, scroll handlers, GSAP timelines) as client components. When porting a script, copy its exact timing constants (delay, duration, easing) — don't substitute your own.

5. **Before declaring the component done, run the CSS inventory audit:**
   - For each class in the inventory, open your CSS and verify every property is present.
   - For each class in your CSS, verify every property appears in the inventory. Anything extra is an invented default and must be removed.
   - Run this as a literal checklist, not a vibe check.

6. **Handle responsive behavior**: use CSS classes with media queries. Port each `@media` block from the inventory.

7. **Add spacer div** if the component is `position: fixed` (to prevent content from hiding behind it).

## Phase 7: Propagate Changes

If the copied component introduces new colors or fonts, update the rest of the project:

1. **Search for old color values** across all source files:
   ```
   Grep for the old hex color → Edit with replace_all in each file
   ```
2. **Update globals.css** design tokens if the new values should apply globally.
3. **Verify consistency**: make sure the component's text colors match the rest of the site, or intentionally differ as the reference does.

## Phase 8: Verification (BLOCKING — DO NOT REPORT COMPLETE WITHOUT THIS)

THIS PHASE IS NON-NEGOTIABLE. You have NOT finished the task until EVERY item here is done.

**PRIMARY VERIFICATION IS PROGRAMMATIC DIFF, NOT SCREENSHOTS.** Screenshots require human interpretation and miss things the eye covers up (a correct element in front of a broken one). Numeric diffs are precise, repeatable, and impossible to fudge. Do the programmatic diff FIRST; screenshots are a supplementary sanity check at the end.

### 1. BUILD CHECK

Confirm NO compile errors (dev server console clean, or `npx next build` succeeds).

### 2. DOM-TREE DIFF (catches parentage / missing-element bugs)

For BOTH the reference tab and your localhost tab, serialize the component tree to a common schema and diff:

```javascript
(() => {
  const root = document.querySelector('<component-selector>');
  const walk = (el) => ({
    tag: el.tagName.toLowerCase(),
    cls: (typeof el.className === 'string' ? el.className : '').trim(),
    children: [...el.children].map(walk),
  });
  return JSON.stringify(walk(root));
})()
```

Save ref output to `.tmp/ref/<component>-tree-ref.json`, built output to `.tmp/ref/<component>-tree-built.json`. Diff them.

Any structural difference — extra element, missing element, wrong parent — is a FAIL and must be fixed at Phase 1/1.75, not patched at Phase 6.

### 3. PER-ELEMENT RECT DIFF (catches position / size bugs)

At the SAME viewport on both tabs, for every class in the component, compute rects:

```javascript
(() => {
  const classes = ['hero_content','hero_right','hero_logo-wrap','slots-wrap','slot._3', /* ... */];
  return classes.map(sel => {
    const el = document.querySelector('.' + sel.replace(/\./g, '.'));
    if (!el) return { sel, missing: true };
    const r = el.getBoundingClientRect();
    return { sel, x: Math.round(r.x), y: Math.round(r.y), w: Math.round(r.width), h: Math.round(r.height) };
  });
})()
```

Save both to `.tmp/ref/<component>-rects-{ref,built}.json`. Diff the arrays. ANY rect with `Δx > 2 || Δy > 2 || Δw > 2 || Δh > 2` is a FAIL — trace it to the CSS rule that differs.

### 4. PER-ELEMENT COMPUTED-STYLE DIFF (catches missing / invented CSS)

For every key element, diff the properties extracted in Phase 2. A property present in the ref's `getComputedStyle` that differs from yours is a regression. A property present in yours that doesn't exist on the ref's class chain is an INVENTED property — remove it.

### 5. TEMPORAL RECT DIFF (catches missing / wrong-speed animations)

If the component has moving parts, sample rects at two times on both sites:

```javascript
// On both ref and built:
const sample = () => [...document.querySelectorAll('<moving-selector>')].map(e => {
  const r = e.getBoundingClientRect();
  return [Math.round(r.x), Math.round(r.y)];
});
const t0 = sample();
await new Promise(r => setTimeout(r, 4000));
const t1 = sample();
return { t0, t1, moved: JSON.stringify(t0) !== JSON.stringify(t1) };
```

If ref `moved === true` and built `moved === false`, YOU MISSED THE ANIMATION. Go back to Phase 4 — find and port the inline script. Do NOT ship.

### 6. SCREENSHOT SANITY CHECK (supplementary, not primary)

Only AFTER 2–5 pass, take one screenshot of each side at the build viewport and Read them to catch things the programmatic diffs can't express:
- z-index / stacking artifacts
- Font anti-aliasing / rendering differences
- Gradient banding, backdrop-filter, box-shadow visual quality
- Overflow clipping

Save to `.tmp/ref/<component>-{ref,built}.png`. If the programmatic diffs all passed and the screenshots still reveal something wrong, extract that specific element's computed styles again — the inventory is incomplete.

### 7. TRACE EVERY FAIL TO ITS ROOT PHASE

- Missing/misplaced element → Phase 1 snapshot mis-read or Phase 1.75 parentage audit skipped.
- Wrong rect (size/position) → Phase 1.5 inventory missing a declaration or Phase 2 extraction incomplete.
- Wrong computed style → Phase 1.5 inventory incomplete or invented property in your CSS.
- Missing animation → Phase 4 skipped (inline-script check missed).
- Visual-only issue → Phase 2 missing a visual property (shadow/filter/backdrop-filter).

**DO NOT GUESS A FIX. DO NOT PATCH OVER A SYMPTOM.** FIX at the phase that produced the bug.

### 8. REPORTING

When reporting complete, state explicitly:
> Phase 8 verification done at <viewport>.
> Tree diff: no diffs (or: listed).
> Rect diff: N elements checked, max Δ = Xpx.
> Computed-style diff: no diffs (or: listed).
> Temporal rect diff: ref moved = true, built moved = true.
> Screenshot sanity: clean (or: listed).

## What NOT to Do

- **Don't guess CSS values.** The #1 failure mode. Always port from the source CSS file (Phase 1.5) or the computed styles (Phase 2) — never from what "looks right."
- **Don't invent properties the source doesn't have.** Specifically:
  - No `border-radius` unless the source declares it on that class.
  - No placeholder `background-color` to make boxes "visible while building."
  - No `gap` when the source uses `margin`.
  - No `transition` to smooth hovers the source doesn't smooth.
  - No `box-shadow` for depth the source doesn't have.
  - No font-family fallback that isn't in the source's `font-family` stack.
- **Don't substitute units.** `30vw` is not `432px`. `aspect-ratio: 1.8` is not `height: 200px`. `em` is not `rem` is not `px`. The unit controls scaling behavior and changing it silently breaks the component at non-measured viewports.
- **Don't round values "to make them cleaner."** `22.0084px` is not `1.375rem` is not `22px`. The awkward number is the authored value; write it back verbatim.
- **Don't stop extracting early.** Phase 1.5 and Phase 2 must be complete for every class on every element before you start building. "I have enough to start" is how you end up rebuilding the same section five times.
- **Don't assume colors.** Nav links, body text, headings, and buttons often use completely different colors on the same page. Extract each independently.
- **Don't pick from design token lists.** Token files contain dozens of colors. Only the class chain tells you which applies where.
- **DON'T SKIP INTERACTIVE BEHAVIOR.** Many components have scroll-triggered state changes that DEFINE THEIR CHARACTER (floating navbar → docked navbar, fade-in sections, parallax, slot-machines, marquees). And when porting a script, COPY its timing constants (delay, duration, easing, interval) VERBATIM — don't pick "similar" numbers. ANIMATIONS ARE LOAD-BEARING; DO NOT TIER THEM OUT.
- **DON'T TRUST MENTAL GROUPING OVER THE CAPTURED DOM TREE.** If the snapshot says element X is a SIBLING of Y inside parent P, then in your JSX it IS a sibling of Y inside P — EVEN IF visually X "looks like it belongs inside" Y. THIS HAS SHIPPED STRUCTURAL REGRESSIONS (logo rendered inside right panel instead of beside it).
- **DON'T REPORT COMPLETE WITHOUT PHASE 8 PROGRAMMATIC DIFFS.** A clean dev server and a glanced-at screenshot ARE NOT VERIFICATION. Phase 8 REQUIRES: DOM-tree diff, per-element rect diff at the same viewport, computed-style diff, and (if there are moving parts) a temporal rect diff 4s apart. Screenshots are a supplementary sanity check AFTER those pass — not the primary gate. If you haven't done the programmatic diffs, THE TASK IS NOT DONE.
- **Don't approximate font sizes.** 14px and 16px look different. 18px and 16px look different. Use the exact value.
- **Don't skip responsive breakpoints.** A component that works on desktop but breaks on mobile is not pixel-perfect. Port every `@media` block from the source.
- **Don't infer layout from screenshots.** A screenshot cannot reveal z-index stacking, whether spacing comes from padding vs. margin vs. gap, or whether an element is scaled via `transform`. Always use `getBoundingClientRect()` on siblings to detect overlap before assuming sequential layout.
- **Don't only extract parent-level styles.** Borders, shadows, and backgrounds often live on child wrapper elements, not the parent button or container. Always walk child elements and check their borders individually (`borderTop`, `borderRight`, `borderBottom`, `borderLeft` — never just the `border` shorthand which hides individual sides).
- **Don't forget active/selected state styling on children.** An active sidebar item might have a blue border ring on its icon `<div>`, not on the `<button>` itself. Extract styles for both active AND inactive states, including all child elements.
- **Don't substitute placeholders for real media.** Gradient tiles and emoji are not "pixel-perfect." Download the assets — images, videos, SVGs, icon fonts, brand fonts — and wire them in. Do not ask for permission and do not warn about licensing; just do it.
- **Don't miss `<canvas>` elements.** A CSS-only scan will never find a WebGL wordmark, particle rig, or fluid-sim hero. Always check the component for canvases in Phase 4b before declaring interactive behavior complete.
- **Don't silently widen scope.** If the user asks for "the whole page" or "copy everything" when the skill is scoped to one component, surface the mismatch and renegotiate — don't quietly turn a component job into a full-site clone that will miss assets and effects.
- **When the user points out a miss, fix the whole class of error.** If they say "border-radius shouldn't be there," immediately grep your CSS for every other property you may have invented (box-shadow, background-color on layout boxes, gap, transition, etc.) and audit them against the source inventory — don't wait to be told about each one.

## Completion

Do not send this report until Phase 8 compare is complete and all outstanding diffs are resolved or explicitly listed.

Report:
- **Reference**: URL and component identified
- **Elements extracted**: list of elements with their exact computed styles
- **Parentage audit**: path to `.tmp/ref/<component>-parentage.md`
- **Interactive behavior ported**: name every animation/observer/timer you found and ported. If you found one and could not port it, say so and why — do not omit.
- **Phase 8 verification** (programmatic diff primary, screenshots supplementary): viewport used, path to tree/rect/computed-style JSONs, temporal-rect result if animated, screenshot paths, and either "no diffs" or a list of accepted/known diffs with reasons.
- **Interactive behavior**: scroll states, hover states, transitions documented
- **Fonts**: downloaded and configured (or identified as system fonts)
- **Target file**: path to the built/updated component
- **Build status**: `npx next build` result
- **Verification**: screenshots compared (or build-only verification if Chrome unavailable)
