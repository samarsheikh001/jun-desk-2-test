// W-04 widget appearance: the options, their defaults and limits. The Worker validates and
// serves them (/config), the dashboard's Appearance page edits them and previews the real
// widget with the unsaved draft, and the widget applies them. Defaults reproduce the look
// from before each option existed, so a desk that never touched them doesn't change.

export type WidgetTheme = "auto" | "light" | "dark";
/**
 * `bar`: an "Ask anything…" bar instead of the round button (the Fin-style launcher, D-32).
 * `island`: a pill at the bottom centre that morphs with each moment (D-39, `web/widget/island.tsx`).
 */
export type LauncherStyle = "button" | "card" | "bar" | "island";
/**
 * What the round button (launcher `button`) shows: the company logo (a chat bubble while none is
 * uploaded), or the words BUTTON_TEXT.
 */
export type ButtonStyle = "logo" | "text";
export const BUTTON_TEXT = "Chat with us";
/**
 * The island launcher's surface: `dark` is always near-black with white text (like Apple's
 * Dynamic Island), whatever the page or theme; `page` follows the widget's `theme`.
 */
export type IslandSurface = "dark" | "page";

export const APPEARANCE_DEFAULTS = {
  color: "#2f5bea",
  position: "right",
  /** Follows the visitor's system setting. */
  theme: "auto",
  radius: 16,
  launcher: "card",
  islandSurface: "dark",
  greeting: "Hi! How can we help?",
  replyTime: "We usually reply in a few minutes",
  placeholder: "Write a message…",
  /** W-20: a soft chime for a new reply while the visitor isn't looking. */
  sound: true,
} as const;

export const RADIUS_MAX = 24;
export const SUGGESTIONS_MAX = 4;
export const SUGGESTION_LIMIT = 80;
export const TEXT_LIMITS = { displayName: 80, greeting: 200, replyTime: 80, placeholder: 60 } as const;

/** What the widget and the loader get from /config (and the Appearance preview sends the frame). */
export interface WidgetLook {
  workspaceName: string;
  greeting: string;
  color: string;
  position: "left" | "right";
  replyTime: string;
  logoUrl: string | null;
  /** W-21: an optional second logo for dark surfaces (the dark island, the dark theme, the bar's glass). */
  logoDarkUrl: string | null;
  theme: WidgetTheme;
  radius: number;
  launcher: LauncherStyle;
  placeholder: string;
  suggestions: string[];
  /** Island launcher (D-39): the turning multi-colour border. On unless turned off. */
  neon: boolean;
  /** Island launcher: near-black (`dark`, the default) or following `theme` (`page`). */
  islandSurface: IslandSurface;
  /** Button launcher: the logo or "Chat with us". */
  buttonStyle: ButtonStyle;
  /** W-20, all launchers: a soft chime for a new reply while the widget is folded or the tab hidden. On unless turned off. */
  sound: boolean;
}

const HEX = /^#[0-9a-f]{6}$/i;
const THEMES: readonly WidgetTheme[] = ["auto", "light", "dark"];
const LAUNCHERS: readonly LauncherStyle[] = ["button", "card", "bar", "island"];
const clean = (s: string) => s.replace(/\s+/g, " ").trim();

/** Readable text on a brand colour (the loader uses the same rule). */
export function textOn(color: string): string {
  if (!HEX.test(color)) return "#ffffff";
  const n = parseInt(color.slice(1), 16);
  return (0.299 * (n >> 16) + 0.587 * ((n >> 8) & 255) + 0.114 * (n & 255)) / 255 > 0.65 ? "#1c1c1a" : "#ffffff";
}

/** Corner rounding for the widget's own parts: 16 (the default) gives the original 14px bubbles and 8px controls. */
export function radiusVars(radius: number): Record<"--r-md" | "--r-sm", string> {
  return { "--r-md": `${Math.round(radius * 0.875)}px`, "--r-sm": `${Math.round(radius * 0.5)}px` };
}

/**
 * The look for stored (or draft) settings. Lenient: anything unreadable falls back to its
 * default, so a hand-edited row or a half-typed colour never breaks a visitor's chat.
 */
export function widgetLook(s: Record<string, unknown>, workspaceName: string, logoUrl: string | null, logoDarkUrl: string | null = null): WidgetLook {
  const text = (v: unknown, fallback: string) => (typeof v === "string" && v.trim() ? v : fallback);
  const radius = Number(s.radius);
  return {
    workspaceName: text(s.displayName, workspaceName),
    greeting: text(s.greeting, APPEARANCE_DEFAULTS.greeting),
    color: typeof s.color === "string" && HEX.test(s.color) ? s.color.toLowerCase() : APPEARANCE_DEFAULTS.color,
    position: s.position === "left" ? "left" : "right",
    replyTime: text(s.replyTime, APPEARANCE_DEFAULTS.replyTime),
    logoUrl,
    logoDarkUrl,
    theme: THEMES.includes(s.theme as WidgetTheme) ? (s.theme as WidgetTheme) : APPEARANCE_DEFAULTS.theme,
    radius: s.radius !== undefined && Number.isInteger(radius) && radius >= 0 && radius <= RADIUS_MAX ? radius : APPEARANCE_DEFAULTS.radius,
    launcher: LAUNCHERS.includes(s.launcher as LauncherStyle) ? (s.launcher as LauncherStyle) : APPEARANCE_DEFAULTS.launcher,
    placeholder: text(s.placeholder, APPEARANCE_DEFAULTS.placeholder),
    suggestions: Array.isArray(s.suggestions)
      ? s.suggestions.filter((q): q is string => typeof q === "string" && q.trim() !== "").map((q) => clean(q).slice(0, SUGGESTION_LIMIT)).slice(0, SUGGESTIONS_MAX)
      : [],
    neon: s.neon !== false,
    islandSurface: s.islandSurface === "page" ? "page" : APPEARANCE_DEFAULTS.islandSurface,
    buttonStyle: s.buttonStyle === "text" ? "text" : "logo",
    sound: s.sound !== false,
  };
}

/**
 * W-21: the logo to draw on a surface: on a dark one the dark-background logo if there is one,
 * else the main logo (null: the caller shows the Jun mark).
 */
export function logoFor(look: Pick<WidgetLook, "logoUrl" | "logoDarkUrl">, dark: boolean): string | null {
  return (dark && look.logoDarkUrl) || look.logoUrl;
}

/**
 * Applies the appearance fields present in a settings update (strict: throws an Error with a
 * message for the admin). Empty text clears a field back to its default.
 */
export function applyAppearance(settings: Record<string, unknown>, body: Record<string, unknown>): void {
  if (body.color !== undefined) {
    if (typeof body.color !== "string" || !HEX.test(body.color)) throw new Error("Colour must look like #2f5bea.");
    settings.color = body.color.toLowerCase();
  }
  if (body.position !== undefined) {
    if (body.position !== "left" && body.position !== "right") throw new Error("Position must be left or right.");
    settings.position = body.position;
  }
  if (body.theme !== undefined) {
    if (!THEMES.includes(body.theme as WidgetTheme)) throw new Error("Theme must be auto, light or dark.");
    settings.theme = body.theme;
  }
  if (body.launcher !== undefined) {
    if (!LAUNCHERS.includes(body.launcher as LauncherStyle)) throw new Error("Launcher must be button, card, bar or island.");
    settings.launcher = body.launcher;
  }
  if (body.buttonStyle !== undefined) {
    if (body.buttonStyle !== "logo" && body.buttonStyle !== "text") throw new Error("The button shows the logo or text.");
    settings.buttonStyle = body.buttonStyle;
  }
  if (body.neon !== undefined) {
    if (typeof body.neon !== "boolean") throw new Error("Neon border must be on or off.");
    settings.neon = body.neon;
  }
  if (body.sound !== undefined) {
    if (typeof body.sound !== "boolean") throw new Error("Sound must be true or false.");
    settings.sound = body.sound;
  }
  if (body.islandSurface !== undefined) {
    if (body.islandSurface !== "dark" && body.islandSurface !== "page") throw new Error("Island surface must be dark or page.");
    settings.islandSurface = body.islandSurface;
  }
  if (body.radius !== undefined) {
    if (typeof body.radius !== "number" || !Number.isInteger(body.radius) || body.radius < 0 || body.radius > RADIUS_MAX) {
      throw new Error(`Corner rounding must be a whole number from 0 to ${RADIUS_MAX}.`);
    }
    settings.radius = body.radius;
  }
  for (const [field, max] of Object.entries(TEXT_LIMITS)) {
    if (body[field] === undefined) continue;
    if (typeof body[field] !== "string") throw new Error(`${field} must be text.`);
    const value = clean(body[field] as string);
    if (value.length > max) throw new Error(`Keep ${field} to ${max} characters.`);
    if (value) settings[field] = value;
    else delete settings[field];
  }
  if (body.suggestions !== undefined) {
    if (!Array.isArray(body.suggestions) || body.suggestions.some((q) => typeof q !== "string")) throw new Error("Suggested questions must be a list of text.");
    const list = (body.suggestions as string[]).map(clean).filter(Boolean);
    if (list.length > SUGGESTIONS_MAX) throw new Error(`Use up to ${SUGGESTIONS_MAX} suggested questions.`);
    const long = list.find((q) => q.length > SUGGESTION_LIMIT);
    if (long) throw new Error(`Keep each suggested question to ${SUGGESTION_LIMIT} characters ("${long.slice(0, 30)}…").`);
    if (list.length) settings.suggestions = list;
    else delete settings.suggestions;
  }
}
