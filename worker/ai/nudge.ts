import { describeIssueKind, formatDuration, type DebugEvent } from "../../shared/debug.ts";

// S-11: the proactive nudge's one-liner, written by the AI from the (masked) failure instead
// of guessed from URL keywords. Pure helpers; the route in routes/widget.ts calls the model.
// Also worded for S-02 rage clicks ("Looks like that button isn't responding.") and S-13
// "stuck on a form" ("Still working on this?").

export const GENERIC_NUDGE = "Looks like something went wrong on this page. Want a hand?";

export function nudgePrompt(workspaceName: string): string {
  return `You write the one-line message a support chat widget on ${workspaceName}'s website shows right after something failed for the visitor.
Rules:
- ONE short, friendly sentence of at most 14 words, then "Want a hand?".
- Say in plain words what the visitor was doing that didn't work (e.g. "your payment didn't go through", "the usage chart didn't load", "saving your changes failed"), using only the facts given.
- If they kept clicking something that didn't respond, say that (e.g. "Looks like the Export button isn't responding."); if they've been stuck on the page for a while, ask if they're still working on it (e.g. "Still working on this?").
- Never mention URLs, status codes, error names, code or technical terms. Never guess the cause. Never promise anything.
- If the facts don't say what the visitor was doing, write: ${GENERIC_NUDGE}
Reply with the message only.`;
}

/** The failure as facts for the model (already masked by the loader and again by the server). */
export function nudgeFacts(event: DebugEvent, page: { url: string; title: string }): string {
  const lines = [`Page: ${page.title || "(untitled)"} (${page.url})`];
  if (event.kind === "app_error") {
    // S-12: the app's own words for the visitor's problem; the code is for engineers, not the line.
    lines.push(`The website told the visitor what didn't work, in its own words: "${event.message ?? ""}"`);
    lines.push("Rephrase that for the visitor, keeping details like a row number or field name.");
  } else if (event.kind === "rage_click") {
    const t = event.target;
    const what = t?.text || t?.label ? `the "${t.text || t.label}" ${t.tag === "a" ? "link" : "button"}` : t && /^(a|button|input)$/.test(t.tag) ? `a ${t.tag === "a" ? "link" : "button"}` : "something on the page";
    lines.push(`The visitor clicked ${what} ${event.count ?? 3} times in a row and nothing happened.`);
  } else if (event.kind === "stuck") {
    lines.push(`The visitor has been on this page for ${formatDuration(event.seconds ?? 0)} after ${describeIssueKind(event.issue)}, and hasn't managed to submit anything since.`);
    lines.push('Gently ask if they are still working on it, like "Still working on this? Want a hand?".');
  } else if (event.kind === "network") {
    lines.push(`A request the page made failed: ${event.method ?? "GET"} ${event.url ?? "?"} → ${event.status ? `HTTP ${event.status}` : "no response"}${event.message ? ` (${event.message})` : ""}`);
  } else {
    lines.push(`A JavaScript error happened: ${event.message ?? "unknown error"}`);
    if (event.source) lines.push(`In: ${event.source}`);
    if (event.stack) lines.push(`Stack (top): ${event.stack.split("\n").slice(0, 3).join(" | ")}`);
  }
  return lines.join("\n");
}

/**
 * The model's line, if it's usable on a customer's page: one short sentence, no technical
 * detail leaking through. Otherwise null (the caller falls back to the generic line).
 */
export function cleanNudge(raw: string, appMessage?: string): string | null {
  let text = raw.trim().split("\n")[0]!.trim().replace(/^["'“”*_\s]+|["'“”*_\s]+$/g, "");
  if (!text) return null;
  if (!/want a hand\?$/i.test(text)) text = `${text.replace(/[.!?]*$/, ".")} Want a hand?`;
  if (text.length > 140) return null;
  // Numbers the app itself told the visitor ("row 142") aren't status codes.
  const appNumbers = new Set(appMessage?.match(/\d+/g) ?? []);
  const check = text.replace(/\d+/g, (n) => (appNumbers.has(n) ? "#" : n));
  // Anything that looks technical stays out of the visitor's sight.
  return looksTechnical(check) ? null : text;
}

function looksTechnical(text: string): boolean {
  return /https?:|\/[a-z0-9_-]+\/|\[(email|token|key|number|redacted)\]|\b[1-5]\d\d\b|\b(error|exception|undefined|null|api|http|status|stack|typeerror|500|404)\b/i.test(text);
}

// ---------- P-01 page openers: an offer on a page the admin picked, not about a problem ----------

export const GENERIC_OPENER = "Have a question? We're happy to help.";

export function openerPrompt(workspaceName: string): string {
  return `You write the one-line message a support chat widget on ${workspaceName}'s website shows to a visitor who has spent a while on a page.
Rules:
- ONE short, friendly sentence or question of at most 16 words that offers help with what the page is about (e.g. "Comparing plans? Happy to help you pick the right one.").
- Use only the facts given. If the site owner says what to offer, follow it.
- Nothing went wrong: never mention errors or problems. Never mention URLs, paths, code or technical terms. Never promise prices, discounts or anything else.
- If the facts don't say what the page is about, write: ${GENERIC_OPENER}
Reply with the message only.`;
}

export function openerFacts(page: { path: string; title: string }, hint?: string): string {
  const lines = [`Page title: ${page.title || "(untitled)"}`, `Page path: ${page.path}`];
  if (hint) lines.push(`What the site owner wants to offer on this page: ${hint}`);
  return lines.join("\n");
}

/** The model's opener if it's usable on a customer's page (one short line, nothing technical or alarming), else null. */
export function cleanOpener(raw: string): string | null {
  const text = raw.trim().split("\n")[0]!.trim().replace(/^["'“”*_\s]+|["'“”*_\s]+$/g, "");
  if (!text || text.length > 140 || looksTechnical(text) || /\b(problems?|wrong|fail\w*|broken|issues?)\b/i.test(text)) return null;
  return /[.!?]$/.test(text) ? text : `${text}.`;
}

/** Same failure on the same page → same line; lets the route cache instead of calling the model. */
export function nudgeCacheKey(workspaceId: string, event: DebugEvent, page: { url: string; title: string }): string {
  const what =
    event.kind === "network"
      ? `${event.method} ${event.url} ${event.status}`
      : event.kind === "app_error"
        ? `${event.message} ${event.code ?? ""}`
        : event.kind === "rage_click"
          ? JSON.stringify(event.target ?? {})
          : event.kind === "stuck"
            ? `${event.url} ${event.issue ?? ""}` // not the seconds: one line per page and issue kind
            : `${event.message} ${event.source ?? ""}`;
  return `${workspaceId}|${page.url}|${page.title}|${event.kind}|${what}`;
}
