// W-09: ChatKit widget props → CSS values. Spacing is in units of 4 px (gap={3} → 12px), sizes in
// px; colours are named tokens, Tailwind-style palette steps ("red-400"), { light, dark } pairs or
// plain CSS colours. Every string that reaches a style is checked here first: the widget's data
// comes from the customer's API, so nothing but colours, lengths, gradients and https images pass.
// Shapes follow ChatKit's widget props (openai/chatkit-js widgets.d.ts, Apache-2.0); token values
// after @swis/genui-widgets (MIT, © swisnl) and Tailwind's palette, drawn as oklch.

import type { CSSProperties } from "react";

export type Theme = "light" | "dark";

/** Text colours by name; the rest resolve through `color`. */
const TEXT: Record<string, string> = {
  prose: "var(--ck-text)",
  primary: "var(--ck-text)",
  emphasis: "var(--ck-text)",
  default: "var(--ck-text)",
  secondary: "var(--ck-text-2)",
  tertiary: "var(--ck-text-3)",
};
const SURFACE: Record<string, string> = {
  surface: "var(--ck-surface)",
  background: "var(--ck-surface)",
  "surface-elevated": "var(--ck-surface)",
  "surface-secondary": "var(--ck-surface-2)",
  "surface-elevated-secondary": "var(--ck-surface-2)",
  "surface-tertiary": "var(--ck-surface-3)",
  none: "transparent",
  transparent: "transparent",
};
const BORDER: Record<string, string> = {
  default: "var(--ck-border)",
  subtle: "var(--ck-border-soft)",
  strong: "var(--ck-text-3)",
};
/** Semantic colours; `soft` backgrounds mix them into the card. */
export const SEMANTIC: Record<string, string> = {
  primary: "var(--ck-accent)",
  secondary: "var(--ck-text-2)",
  info: "var(--ck-info)",
  discovery: "var(--ck-discovery)",
  success: "var(--ck-success)",
  caution: "var(--ck-caution)",
  warning: "var(--ck-warning)",
  danger: "var(--ck-danger)",
};

/**
 * The text colour on a solid button or badge of this tone: the accent's own text for primary, the
 * card's surface for secondary (light grey on dark, dark grey on light), a theme-aware token for the
 * other semantic tones (bright tones on a dark card take dark text), white for palette colours.
 */
export function onTone(tone: string): string {
  if (tone === "primary") return "var(--ck-accent-text)";
  if (tone === "secondary") return "var(--ck-surface)";
  return SEMANTIC[tone] ? "var(--ck-on-solid)" : "#fff";
}

// Tailwind's palette as oklch: a lightness and chroma curve per step, a hue (and chroma scale) per colour.
const STEPS: Record<string, [number, number]> = {
  "50": [0.97, 0.016], "100": [0.94, 0.035], "200": [0.89, 0.068], "300": [0.82, 0.11], "400": [0.72, 0.16], "500": [0.64, 0.19],
  "600": [0.56, 0.19], "700": [0.48, 0.17], "800": [0.41, 0.14], "900": [0.35, 0.11], "950": [0.26, 0.08],
};
const HUES: Record<string, [number, number]> = {
  red: [25, 1.1], orange: [48, 1], amber: [72, 0.95], yellow: [90, 0.9], lime: [130, 0.95], green: [150, 0.95], emerald: [163, 0.9],
  teal: [182, 0.8], cyan: [212, 0.8], sky: [235, 0.85], blue: [262, 1.05], indigo: [277, 1], violet: [293, 1.05], purple: [305, 1.1],
  fuchsia: [322, 1.1], pink: [354, 1], rose: [12, 1.05], slate: [257, 0.18], gray: [264, 0.14], zinc: [286, 0.08], neutral: [0, 0], stone: [56, 0.08],
};

const SAFE_COLOR = /^(#[0-9a-f]{3,8}|(?:rgba?|hsla?|oklch|oklab|lab|lch)\([\d\s.,%/+-]*\)|[a-z]{3,20})$/i;
// Gradients of colours and https images; no nested functions besides colour ones.
const SAFE_BACKGROUND = /^((linear|radial|conic)-gradient\(([\w\s.,%#/+-]|(rgba?|hsla?|oklch)\([\d\s.,%/+-]*\))*\)|url\((["']?)https:\/\/[^\s"'()\\]+\6\)([\w\s.,%/-]*))$/i;

function palette(value: string): string | null {
  const m = /^([a-z]+)-(\d{2,3})$/.exec(value);
  if (!m) return null;
  const hue = HUES[m[1]!];
  const step = STEPS[m[2]!];
  if (!hue || !step) return null;
  return `oklch(${step[0]} ${(step[1] * hue[1]).toFixed(3)} ${hue[0]})`;
}

/** `alpha-70`: the text colour at 70%. */
function alpha(value: string, base: string): string | null {
  const m = /^alpha-(\d{1,3})$/.exec(value);
  return m ? `color-mix(in srgb, ${base} ${Math.min(100, Number(m[1]))}%, transparent)` : null;
}

/** A colour prop for text, a surface or a border: token, palette step, { light, dark } or a plain CSS colour. */
export function color(value: unknown, theme: Theme, kind: "text" | "surface" | "border" = "text"): string | undefined {
  if (value && typeof value === "object" && !Array.isArray(value)) {
    const pair = value as { light?: unknown; dark?: unknown };
    return color(theme === "dark" ? (pair.dark ?? pair.light) : (pair.light ?? pair.dark), theme, kind);
  }
  if (typeof value !== "string" || !value) return undefined;
  const v = value.trim();
  const named = (kind === "surface" ? SURFACE[v] : kind === "border" ? BORDER[v] : TEXT[v]) ?? SEMANTIC[v];
  if (named) return named;
  if (v === "white") return "#fff";
  if (v === "black") return "#000";
  const a = alpha(v, kind === "surface" ? "var(--ck-text)" : "var(--ck-text)");
  if (a) return a;
  const p = palette(v);
  if (p) return p;
  return SAFE_COLOR.test(v) ? v : undefined;
}

/** A background: a colour, or a gradient / https image. */
export function background(value: unknown, theme: Theme): string | undefined {
  if (typeof value === "string" && SAFE_BACKGROUND.test(value.trim())) return value.trim();
  return color(value, theme, "surface");
}

/** Spacing in units of 4 px; strings like "12px" or "50%" pass as they are. */
export function space(value: unknown): string | undefined {
  if (typeof value === "number" && Number.isFinite(value)) return `${value * 4}px`;
  return length(value);
}

/** A length: numbers are px; "40px", "50%", "auto", "2rem" pass. */
export function length(value: unknown): string | undefined {
  if (typeof value === "number" && Number.isFinite(value)) return `${value}px`;
  if (typeof value === "string" && /^(auto|-?\d+(\.\d+)?(px|%|rem|em|vh|vw|ch)?)$/.test(value.trim())) return /\d$/.test(value.trim()) ? `${value.trim()}px` : value.trim();
  return undefined;
}

const RADII: Record<string, string> = {
  none: "0", "2xs": "2px", xs: "4px", sm: "6px", md: "8px", lg: "12px", xl: "16px", "2xl": "18px", "3xl": "20px", "4xl": "24px", full: "9999px", "100%": "100%",
};
export const radius = (value: unknown): string | undefined => (typeof value === "string" ? RADII[value] : undefined);

/** padding / margin: a number (4 px units), a string, or { x, y, top, right, bottom, left }. */
export function insets(prefix: "padding" | "margin", value: unknown): CSSProperties {
  if (value === undefined || value === null) return {};
  if (typeof value !== "object") {
    const v = space(value);
    return v ? { [prefix]: v } : {};
  }
  const o = value as Record<string, unknown>;
  const out: Record<string, string> = {};
  const sides = { Top: o.top ?? o.y, Right: o.right ?? o.x, Bottom: o.bottom ?? o.y, Left: o.left ?? o.x };
  for (const [side, v] of Object.entries(sides)) {
    const s = space(v);
    if (s) out[`${prefix}${side}`] = s;
  }
  return out as CSSProperties;
}

const BORDER_STYLES = new Set(["solid", "dashed", "dotted", "double", "groove", "ridge", "inset", "outset"]);

function oneBorder(value: unknown, theme: Theme): string | undefined {
  if (typeof value === "number") return value > 0 ? `${value}px solid var(--ck-border)` : "none";
  if (value && typeof value === "object") {
    const b = value as { size?: unknown; color?: unknown; style?: unknown };
    const size = typeof b.size === "number" ? b.size : 1;
    const style = typeof b.style === "string" && BORDER_STYLES.has(b.style) ? b.style : "solid";
    return `${size}px ${style} ${color(b.color, theme, "border") ?? "var(--ck-border)"}`;
  }
  return undefined;
}

/** border: a width, { size, color, style }, or per side ({ top, x, … }). */
export function border(value: unknown, theme: Theme): CSSProperties {
  if (value === undefined || value === null || value === false) return {};
  if (typeof value === "number" || (typeof value === "object" && value !== null && "size" in value)) {
    const b = oneBorder(value, theme);
    return b ? { border: b } : {};
  }
  if (typeof value !== "object") return {};
  const o = value as Record<string, unknown>;
  const out: Record<string, string> = {};
  const sides = { Top: o.top ?? o.y, Right: o.right ?? o.x, Bottom: o.bottom ?? o.y, Left: o.left ?? o.x };
  for (const [side, v] of Object.entries(sides)) {
    const b = oneBorder(v, theme);
    if (b) out[`border${side}`] = b;
  }
  return out as CSSProperties;
}

const ALIGN: Record<string, string> = { start: "flex-start", end: "flex-end", center: "center", baseline: "baseline", stretch: "stretch" };
const JUSTIFY: Record<string, string> = { start: "flex-start", end: "flex-end", center: "center", between: "space-between", around: "space-around", evenly: "space-evenly", stretch: "stretch" };

/** Width, height and their min/max, `size` (both), aspect ratio, radius, margin. */
export function block(p: Record<string, unknown>): CSSProperties {
  const s: CSSProperties = {};
  const w = length(p.size ?? p.width);
  const h = length(p.size ?? p.height);
  if (w) s.width = w;
  if (h) s.height = h;
  const minW = length(p.minSize ?? p.minWidth);
  const minH = length(p.minSize ?? p.minHeight);
  const maxW = length(p.maxSize ?? p.maxWidth);
  const maxH = length(p.maxSize ?? p.maxHeight);
  if (minW) s.minWidth = minW;
  if (minH) s.minHeight = minH;
  if (maxW) s.maxWidth = maxW;
  if (maxH) s.maxHeight = maxH;
  if (typeof p.aspectRatio === "number" || (typeof p.aspectRatio === "string" && /^[\d.\s/]+$/.test(p.aspectRatio))) s.aspectRatio = String(p.aspectRatio);
  const r = radius(p.radius);
  if (r) s.borderRadius = r;
  return { ...s, ...insets("margin", p.margin) };
}

/** A flex container's own props (Box, Row, Col, Form, ListViewItem, Basic). */
export function box(p: Record<string, unknown>, theme: Theme): CSSProperties {
  const s: CSSProperties = { ...block(p), ...insets("padding", p.padding), ...border(p.border, theme) };
  if (typeof p.align === "string" && ALIGN[p.align]) s.alignItems = ALIGN[p.align];
  if (typeof p.justify === "string" && JUSTIFY[p.justify]) s.justifyContent = JUSTIFY[p.justify];
  if (p.wrap === "wrap" || p.wrap === "nowrap" || p.wrap === "wrap-reverse") s.flexWrap = p.wrap;
  if (typeof p.flex === "number") s.flex = `${p.flex} ${p.flex} 0%`;
  else if (p.flex === "auto") s.flex = "1 1 auto";
  else if (p.flex === "none") s.flex = "none";
  else if (typeof p.flex === "string" && /^\d+(\.\d+)?$/.test(p.flex)) s.flex = `${p.flex} ${p.flex} 0%`;
  const gap = space(p.gap);
  if (gap) s.gap = gap;
  const bg = background(p.background, theme);
  if (bg) s.background = bg;
  return s;
}

/** Text props shared by Text, Title, Caption and Label. */
export function text(p: Record<string, unknown>, theme: Theme): CSSProperties {
  const s: CSSProperties = {};
  const c = color(p.color, theme);
  if (c) s.color = c;
  if (p.textAlign === "start" || p.textAlign === "center" || p.textAlign === "end") s.textAlign = p.textAlign;
  if (p.italic === true) s.fontStyle = "italic";
  if (p.lineThrough === true) s.textDecoration = "line-through";
  const w = length(p.width);
  if (w) {
    s.width = w;
    s.flexShrink = 0;
  }
  if (typeof p.maxLines === "number" && p.maxLines > 0) {
    Object.assign(s, { display: "-webkit-box", WebkitLineClamp: p.maxLines, WebkitBoxOrient: "vertical", overflow: "hidden" });
  }
  if (typeof p.minLines === "number" && p.minLines > 0) s.minHeight = `${p.minLines * 1.45}em`;
  return s;
}

/** Only https images (and our own files): data from an API never gets to load script or local URLs. */
export function imageSrc(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const v = value.trim();
  if (/^https:\/\//i.test(v)) return v;
  if (/^\/(?!\/)/.test(v)) return v;
  return null;
}
