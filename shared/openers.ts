// P-01 page-triggered openers: "after 20 s on /pricing, offer a chat". Pure; used by the
// Worker (settings validation, widget config, the nudge route) and the dashboard.
//
// Page patterns match the page's path (no query or hash), case-sensitively:
//   /pricing     exactly /pricing (a trailing slash on the page doesn't matter)
//   /docs/*      /docs and everything under it
//   */billing    any path ending in /billing
//   *            every page
// `*` matches any characters, including "/". Nothing else is special.

export const MAX_OPENERS = 10;
export const MIN_DELAY_S = 5;
export const MAX_DELAY_S = 600;
export const MAX_OPENER_TEXT = 140;
export const MAX_OPENER_HINT = 200;
export const MAX_PATTERN = 200;

export interface OpenerRule {
  id: string;
  /** Page pattern, see above. */
  path: string;
  /** Seconds of visible time on the page before the card shows. */
  delay: number;
  /** Fixed text, or null to let the AI write the line. */
  text: string | null;
  /** For the AI line: what to offer ("help choosing a plan"). Admins only, never sent to the loader. */
  hint?: string;
}

/** What the loader gets (widget config): the pattern as a regular expression and the delay. */
export interface LoaderOpener {
  id: string;
  match: string;
  delay: number;
}

/** Problem with a pattern, or null when it's usable. */
export function patternError(pattern: string): string | null {
  if (!pattern) return "Enter a page path, like /pricing or /docs/*.";
  if (pattern.length > MAX_PATTERN) return `Page paths can be at most ${MAX_PATTERN} characters.`;
  if (!/^[/*]/.test(pattern)) return `"${pattern}" must start with / or *.`;
  if (/[\s?#]/.test(pattern)) return `"${pattern}" can't contain spaces, ? or # (only the path is matched).`;
  if (/[^\x21-\x7e]/.test(pattern)) return `"${pattern}" has characters that can't be in a path.`;
  return null;
}

/** The pattern as a regular expression source (anchored), for the loader and the server. */
export function patternRegex(pattern: string): string {
  let p = pattern.replace(/\*+/g, "*");
  // "/docs/*" also matches "/docs" itself.
  const under = p.length > 2 && p.endsWith("/*");
  if (under) p = p.slice(0, -2);
  else p = p.replace(/\/+$/, "");
  const body = p
    .split("*")
    .map((part) => part.replace(/[.+?^${}()|[\]\\]/g, "\\$&"))
    .join(".*");
  return `^${body}${under ? "(/.*)?" : "/?"}$`;
}

export function matchesPath(pattern: string, path: string): boolean {
  return new RegExp(patternRegex(pattern)).test(path);
}

const ID = /^op_[A-Za-z0-9_-]{4,40}$/;

/**
 * Admin input → stored rules. Throws Error with a message for the admin. Keeps a valid id,
 * otherwise makes one with `newId`.
 */
export function parseOpeners(raw: unknown, newId: () => string): OpenerRule[] {
  if (!Array.isArray(raw)) throw new Error("Openers must be a list.");
  if (raw.length > MAX_OPENERS) throw new Error(`At most ${MAX_OPENERS} page openers.`);
  const seen = new Set<string>();
  return raw.map((item, i) => {
    const value = (item && typeof item === "object" ? item : {}) as Record<string, unknown>;
    const n = `Opener ${i + 1}`;
    const path = typeof value.path === "string" ? value.path.trim() : "";
    const problem = patternError(path);
    if (problem) throw new Error(`${n}: ${problem}`);
    const delay = value.delay;
    if (typeof delay !== "number" || !Number.isInteger(delay) || delay < MIN_DELAY_S || delay > MAX_DELAY_S) {
      throw new Error(`${n}: the delay must be a whole number of seconds from ${MIN_DELAY_S} to ${MAX_DELAY_S}.`);
    }
    let text: string | null = null;
    if (value.text !== null && value.text !== undefined) {
      if (typeof value.text !== "string") throw new Error(`${n}: the message must be text.`);
      text = value.text.replace(/\s+/g, " ").trim();
      if (!text) throw new Error(`${n}: write a message, or let the AI write it.`);
      if (text.length > MAX_OPENER_TEXT) throw new Error(`${n}: the message can be at most ${MAX_OPENER_TEXT} characters.`);
    }
    const rule: OpenerRule = { id: typeof value.id === "string" && ID.test(value.id) && !seen.has(value.id) ? value.id : newId(), path, delay, text };
    seen.add(rule.id);
    if (text === null && value.hint !== undefined && value.hint !== null) {
      if (typeof value.hint !== "string") throw new Error(`${n}: the hint must be text.`);
      const hint = value.hint.replace(/\s+/g, " ").trim();
      if (hint.length > MAX_OPENER_HINT) throw new Error(`${n}: the hint can be at most ${MAX_OPENER_HINT} characters.`);
      if (hint) rule.hint = hint;
    }
    return rule;
  });
}

/** Stored rules, read leniently (anything unusable is dropped). */
export function storedOpeners(stored: unknown): OpenerRule[] {
  if (!Array.isArray(stored)) return [];
  return stored.flatMap((item) => {
    try {
      return parseOpeners([item], () => "op_invalid");
    } catch {
      return [];
    }
  }).filter((r) => r.id !== "op_invalid");
}

export function forLoader(rules: OpenerRule[]): LoaderOpener[] {
  return rules.map((r) => ({ id: r.id, match: patternRegex(r.path), delay: r.delay }));
}
