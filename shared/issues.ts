// S-08: a GitHub issue drafted from a conversation. Pure: the Worker gathers the facts and
// calls the model (routes/issues.ts); this module writes the prompt, parses the model's
// answer, and assembles the Markdown body. The sections that need no model (failing
// requests, errors, environment, footer) are built from the masked debug context only, so
// they can't contain anything the model made up.

import { browserName, describeEvents, describeIssueKind, describeTarget, formatDuration, formatEventTime, isIssue, osName, redact, type DebugContext, type DebugEvent } from "./debug.ts";

/** GitHub's own title limit. */
export const ISSUE_TITLE_MAX = 256;
/** GitHub allows 65,536 characters; we stay below it. */
export const ISSUE_BODY_MAX = 60_000;
export const ISSUE_LABELS_MAX = 10;
const LABEL_MAX = 50;
const UNKNOWN = "Unknown";

export type IssueEnvironment = Omit<DebugContext, "events">;

export interface IssueFacts {
  /** `<desk origin>/inbox/<conversation id>`, for the footer. */
  conversationUrl: string;
  /**
   * Oldest first. Public messages plus the team's internal notes: the draft goes to the
   * team's own engineers and an agent reviews it before filing, so notes help. Never shown
   * to the visitor or the support AI.
   */
  transcript: { who: "Customer" | "Agent" | "AI" | "Team note"; body: string }[];
  /** The visitor's latest browser snapshot (already masked), without events. */
  environment: IssueEnvironment | null;
  /** Masked debug events, oldest first. */
  events: DebugEvent[];
  /** From a verified contact only. Never their email. */
  account: { company: string | null; plan: string | null } | null;
}

/** The parts the model writes. */
export interface IssueNarrative {
  title: string;
  summary: string;
  steps: string[];
  expected: string;
  actual: string;
}

export interface IssueDraft {
  title: string;
  body: string;
}

// ---------- repo setting ----------

/** "owner/name" from "owner/name" or a github.com URL; null if it isn't one. */
export function parseRepo(input: unknown): string | null {
  if (typeof input !== "string") return null;
  const value = input
    .trim()
    .replace(/^https?:\/\/(www\.)?github\.com\//i, "")
    .replace(/\/+$/, "")
    .replace(/\.git$/i, "");
  const match = /^([A-Za-z0-9](?:[A-Za-z0-9-]{0,38}))\/([A-Za-z0-9._-]{1,100})$/.exec(value);
  if (!match || match[2] === "." || match[2] === "..") return null;
  return `${match[1]}/${match[2]}`;
}

// ---------- model prompt + parsing ----------

export function issuePrompt(): string {
  return `You turn a customer support conversation into a GitHub issue for the engineering team.
Use ONLY the facts given (the conversation and what the customer's browser recorded). Never invent anything: no names, emails, IDs, versions, causes, URLs or numbers that aren't in the facts. If something isn't known, write "Unknown".
Don't name the customer and don't include any personal data.
Reply in exactly this format, with these five labels and nothing else:
TITLE: <one line, at most 80 characters: what the customer couldn't do and the symptom, in plain words>
SUMMARY:
<2-4 sentences: what the customer tried, what went wrong, what the browser recorded>
STEPS:
1. <step>
2. <step>
(steps a developer can follow, from the pages visited and the requests the browser made; at most 8)
EXPECTED:
<one or two sentences>
ACTUAL:
<one or two sentences, quoting the failing request or error if there is one>`;
}

/** The facts as text for the model (masked already; transcript capped to the latest part). */
export function issueFactsText(facts: IssueFacts): string {
  const lines: string[] = [];
  let transcript = facts.transcript.map((m) => `${m.who}: ${m.body.slice(0, 1500)}`).join("\n");
  if (transcript.length > 8000) transcript = `…\n${transcript.slice(-8000)}`;
  lines.push("Conversation:", transcript || "(no messages)");
  if (facts.environment) {
    const env = facts.environment;
    lines.push(
      "",
      "Customer's browser:",
      `Page: ${env.page.url}${env.page.title ? ` ("${env.page.title}")` : ""}`,
      `Browser: ${browserName(env.userAgent)}${osName(env.userAgent) ? ` on ${osName(env.userAgent)}` : ""}`,
      "Recorded events (oldest first):",
      ...(facts.events.length ? describeEvents({ ...env, events: facts.events }, { codes: true }).slice(-30) : ["(none)"]),
    );
  } else {
    lines.push("", "Customer's browser: nothing was recorded.");
  }
  if (facts.account?.plan || facts.account?.company) {
    lines.push("", `Customer account: ${[facts.account.company, facts.account.plan && `plan ${facts.account.plan}`].filter(Boolean).join(", ")}`);
  }
  return lines.join("\n");
}

const LABELS = ["TITLE", "SUMMARY", "STEPS", "EXPECTED", "ACTUAL"] as const;

/** Reads the model's answer. Null if it has no usable title (the caller then uses the template). */
export function parseNarrative(raw: string): IssueNarrative | null {
  const sections: Partial<Record<(typeof LABELS)[number], string[]>> = {};
  let current: (typeof LABELS)[number] | null = null;
  for (const line of raw.replace(/\r/g, "").split("\n")) {
    const m = /^\s*[#*_]*\s*(TITLE|SUMMARY|STEPS(?: TO REPRODUCE)?|EXPECTED|ACTUAL)\s*[*_]*\s*:\s*[*_]*\s*(.*)$/i.exec(line);
    if (m) {
      current = m[1]!.toUpperCase().split(" ")[0] as (typeof LABELS)[number];
      sections[current] = m[2] ? [m[2]] : [];
    } else if (current) {
      sections[current]!.push(line);
    }
  }
  const text = (key: (typeof LABELS)[number]) => clean((sections[key] ?? []).join("\n").trim(), 2000) || UNKNOWN;
  let title = clean((sections.TITLE ?? [])[0] ?? "", ISSUE_TITLE_MAX).replace(/^[*_]+|[*_]+$/g, "").trim();
  // Unwrap a quoted title, but keep quotes that are part of it (`Pay fails: "Something went wrong"`).
  const wrapped = /^["“](.*)["”]$/.exec(title);
  if (wrapped && !/["“”]/.test(wrapped[1]!)) title = wrapped[1]!.trim();
  if (!title || title.toLowerCase() === "unknown") return null;
  const steps = (sections.STEPS ?? [])
    .map((l) => l.replace(/^\s*(?:\d+[.)]|[-*•])\s*/, "").trim())
    .filter((l) => l && !/^\(.*\)$/.test(l))
    .slice(0, 12)
    .map((l) => clean(l, 400));
  return { title, summary: text("SUMMARY"), steps: steps.length ? steps : [UNKNOWN], expected: text("EXPECTED"), actual: text("ACTUAL") };
}

/** Masks again (the model might echo something) and caps. */
function clean(value: string, max: number): string {
  return redact(value, max).trim();
}

// ---------- template (no model) ----------

/** What a developer can follow, from the page trail and the first failure (no model). */
export function inferSteps(facts: Pick<IssueFacts, "environment" | "events">): string[] {
  const steps: string[] = [];
  const lastIssue = facts.events.findLastIndex(isIssue);
  const events = lastIssue === -1 ? facts.events : facts.events.slice(0, lastIssue + 1);
  let lastPage = "";
  for (const e of events) {
    if (e.kind === "navigation" && e.url && e.url !== lastPage) {
      steps.push(`Open ${code(e.url)}`);
      lastPage = e.url;
    } else if (e.kind === "network" && isIssue(e)) {
      steps.push(`The page sends ${code(`${e.method ?? "GET"} ${e.url ?? "?"}`)}, which fails with ${e.status ? `HTTP ${e.status}` : `no response${e.message ? ` (${e.message})` : ""}`}`);
    } else if (e.kind === "error") {
      steps.push(`A JavaScript error is thrown: ${code(e.message ?? "unknown error")}`);
    } else if (e.kind === "app_error") {
      steps.push(`The app reports an error: ${appError(e)}`);
    } else if (e.kind === "rage_click") {
      steps.push(`Click ${code(describeTarget(e.target))}: nothing happens (clicked ${e.count ?? 3} times in a second, the page didn't change)`);
    }
  }
  if (!steps.some((s) => s.startsWith("Open ")) && facts.environment?.page.url) steps.unshift(`Open ${code(facts.environment.page.url)}`);
  if (steps.length === 0) return [`${UNKNOWN}: no browser session was recorded for this conversation.`];
  return steps.length > 8 ? steps.slice(-8) : steps;
}

/** A draft without the model (AI off, over the cap, failed or slow): the button always works. */
export function fallbackNarrative(facts: IssueFacts): IssueNarrative {
  const first = facts.transcript.find((m) => m.who === "Customer")?.body ?? "";
  const oneLine = redact(first.replace(/\s+/g, " ").trim(), 400);
  const title = oneLine ? (oneLine.length > 80 ? `${oneLine.slice(0, 79).trimEnd()}…` : oneLine) : "Problem reported in a support conversation";
  // The app's own words say most (S-12); then the failing request; then the last error; then a
  // button that didn't respond (S-02).
  const failure =
    facts.events.findLast((e) => e.kind === "app_error") ??
    facts.events.findLast((e) => e.kind === "network" && isIssue(e)) ??
    facts.events.findLast((e) => e.kind === "error") ??
    facts.events.findLast((e) => e.kind === "rage_click");
  // S-13: they stayed on the page without getting it to work.
  const stuck = facts.events.findLast((e) => e.kind === "stuck");
  const stuckNote = stuck ? ` The customer then stayed on ${code(stuck.url ?? "the page")} for ${formatDuration(stuck.seconds ?? 0)} without a successful submit.` : "";
  const actual = !failure
    ? UNKNOWN
    : failure.kind === "network"
      ? `${code(`${failure.method ?? "GET"} ${failure.url ?? "?"}`)} ${failure.status ? `returned HTTP ${failure.status}` : "got no response"}.`
      : failure.kind === "app_error"
        ? `The app reported: ${appError(failure)}.`
        : failure.kind === "rage_click"
          ? `Clicking ${code(describeTarget(failure.target))} did nothing (clicked ${failure.count ?? 3} times; the page didn't change).`
          : `JavaScript error: ${code(failure.message ?? "unknown error")}.`;
  return {
    title,
    summary: oneLine ? `A customer reported in a support chat: “${oneLine}”` : UNKNOWN,
    steps: inferSteps(facts),
    expected: UNKNOWN,
    actual: actual === UNKNOWN && stuck ? `The customer stayed on ${code(stuck.url ?? "the page")} for ${formatDuration(stuck.seconds ?? 0)} after ${describeIssueKind(stuck.issue)}, without a successful submit.` : actual + stuckNote,
  };
}

// ---------- body ----------

/** Inline code that can't break out of its backticks or the line. */
function code(value: string): string {
  return `\`${value.replace(/`/g, "'").replace(/\s*\n\s*/g, " ").trim()}\``;
}

function at(t: number, timezone: string | undefined): string {
  return formatEventTime(t, timezone);
}

export function failingRequestsSection(events: DebugEvent[], timezone?: string): string {
  const failing = events.filter((e) => e.kind === "network" && isIssue(e)).slice(-20);
  if (failing.length === 0) return "## Failing requests\n\nNone recorded.";
  const rows = failing.map((e) => {
    const status = e.status ? String(e.status) : `no response${e.message ? ` (${e.message.replace(/\|/g, "/")})` : ""}`;
    const request = code(`${e.method ?? "GET"} ${e.url ?? "?"}`).replace(/\|/g, "\\|");
    return `| ${at(e.t, timezone)} | ${request} | ${status} | ${e.durationMs != null ? `${e.durationMs} ms` : "–"} |`;
  });
  return ["## Failing requests", "", "| Time | Request | Status | Duration |", "|---|---|---|---|", ...rows].join("\n");
}

/** The first line of a stack that looks like a frame, else the error's source. */
function topFrame(e: DebugEvent): string | null {
  const frame = e.stack
    ?.split("\n")
    .map((l) => l.trim())
    .find((l) => /^at\s|@|:\d+(:\d+)?\)?$/.test(l) && l !== e.message);
  return frame ?? e.source ?? null;
}

/** "`Row 42: missing email` (code `import.row_invalid`)" for an app_error. */
function appError(e: DebugEvent): string {
  return `${code(e.message || "error")}${e.code ? ` (code ${code(e.code)})` : ""}`;
}

export function errorsSection(events: DebugEvent[], timezone?: string): string {
  const errors = events.filter((e) => e.kind === "error" || e.kind === "app_error").slice(-10);
  if (errors.length === 0) return "## Errors\n\nNone recorded.";
  const items = errors.map((e) => {
    if (e.kind === "app_error") return `- ${at(e.t, timezone)} Reported by the app: ${appError(e)}`;
    const frame = topFrame(e);
    return `- ${at(e.t, timezone)} ${code(e.message || "JavaScript error")}${frame ? `\n  ${code(frame)}` : ""}`;
  });
  return ["## Errors", "", ...items].join("\n");
}

/** "2026-10-05 14:02" in the visitor's timezone when known. */
function dateTime(t: number, timezone: string): string {
  try {
    return new Date(t).toLocaleString("sv-SE", { timeZone: timezone || "UTC", hour12: false }).slice(0, 16);
  } catch {
    return new Date(t).toISOString().slice(0, 16).replace("T", " ");
  }
}

export function environmentSection(environment: IssueEnvironment | null, account: IssueFacts["account"] = null): string {
  const lines: string[] = [];
  if (environment) {
    const os = osName(environment.userAgent);
    lines.push(
      `- Page: ${code(environment.page.url || UNKNOWN)}${environment.page.title ? ` (${environment.page.title.replace(/[\n|]/g, " ")})` : ""}`,
      `- Browser: ${browserName(environment.userAgent)}`,
      `- OS: ${os || UNKNOWN}`,
      `- Screen: ${environment.viewport.w && environment.viewport.h ? `${environment.viewport.w}×${environment.viewport.h}` : UNKNOWN}`,
      `- Locale: ${[environment.language, environment.timezone].filter(Boolean).join(" · ") || UNKNOWN}`,
      `- Recorded: ${dateTime(environment.capturedAt, environment.timezone)}${environment.timezone ? ` (${environment.timezone})` : " (UTC)"}`,
    );
    if (environment.userAgent) lines.push(`- User agent: ${code(environment.userAgent)}`);
  } else {
    lines.push("- No browser details were recorded (the visitor didn't write from a page with the widget).");
  }
  if (account?.company) lines.push(`- Account: ${account.company.replace(/\n/g, " ")}`);
  if (account?.plan) lines.push(`- Plan: ${account.plan.replace(/\n/g, " ")}`);
  return ["## Environment", "", ...lines].join("\n");
}

export function footer(conversationUrl: string): string {
  return `---\nFrom a support conversation in Jun Desk: ${conversationUrl}`;
}

/** The whole draft: the model's narrative (or the template's) plus the factual sections. */
export function buildDraft(narrative: IssueNarrative, facts: IssueFacts): IssueDraft {
  const timezone = facts.environment?.timezone || undefined;
  const parts = [
    `## Summary\n\n${narrative.summary}`,
    `## Steps to reproduce\n\n_Inferred from the visitor's session (pages visited and requests their browser made), not a recording._\n\n${narrative.steps.map((s, i) => `${i + 1}. ${s}`).join("\n")}`,
    `## Expected vs actual\n\n**Expected:** ${narrative.expected}\n\n**Actual:** ${narrative.actual}`,
    failingRequestsSection(facts.events, timezone),
    errorsSection(facts.events, timezone),
    environmentSection(facts.environment, facts.account),
  ];
  const end = footer(facts.conversationUrl);
  let body = parts.join("\n\n");
  const room = ISSUE_BODY_MAX - end.length - 40;
  if (body.length > room) body = `${body.slice(0, room)}\n\n_(truncated)_`;
  return { title: narrative.title.slice(0, ISSUE_TITLE_MAX), body: `${body}\n\n${end}` };
}

// ---------- filing ----------

export interface IssueInput {
  title: string;
  body: string;
  labels: string[];
}

/**
 * Validates what an agent files and masks it again with the debug-context rules: they may
 * have pasted something from the conversation. Throws an Error with a message for the agent.
 */
export function parseIssueInput(raw: Record<string, unknown>): IssueInput {
  if (typeof raw.title !== "string" || !raw.title.trim()) throw new Error("The issue needs a title.");
  const title = raw.title.replace(/\s+/g, " ").trim();
  if (title.length > ISSUE_TITLE_MAX) throw new Error(`Titles are limited to ${ISSUE_TITLE_MAX} characters.`);
  const body = raw.body === undefined || raw.body === null ? "" : raw.body;
  if (typeof body !== "string") throw new Error("The body must be text.");
  if (body.length > ISSUE_BODY_MAX) throw new Error(`The body is limited to ${ISSUE_BODY_MAX.toLocaleString("en-US")} characters.`);
  let labels: string[] = [];
  if (raw.labels !== undefined && raw.labels !== null) {
    if (!Array.isArray(raw.labels) || raw.labels.some((l) => typeof l !== "string")) throw new Error("Labels must be a list of names.");
    labels = [...new Set((raw.labels as string[]).map((l) => l.trim()).filter(Boolean))];
    if (labels.length > ISSUE_LABELS_MAX) throw new Error(`At most ${ISSUE_LABELS_MAX} labels.`);
    if (labels.some((l) => l.length > LABEL_MAX)) throw new Error(`Labels are limited to ${LABEL_MAX} characters.`);
  }
  return { title: redact(title, ISSUE_TITLE_MAX), body: redact(body, ISSUE_BODY_MAX), labels };
}

// ---------- S-14: screenshots in issues ----------

/** At most this many images per issue (the same cap as attachments per message). */
export const ISSUE_IMAGES_MAX = 10;
/** W-06's upload limit: no stored file is bigger, but check anyway. */
export const ISSUE_IMAGE_BYTES_MAX = 10 * 1024 * 1024;
/** The types W-06 shows inline (worker/routes/files.ts). Anything else isn't a screenshot. */
const IMAGE_TYPES = new Set(["image/png", "image/jpeg", "image/gif", "image/webp"]);

export const isImageType = (type: string) => IMAGE_TYPES.has(type.toLowerCase());

/** An image attached to a message in the conversation, as the Create issue dialog lists it. */
export interface IssueImage {
  key: string;
  name: string;
  type: string;
  size: number;
  /** Who sent it. */
  from: "visitor" | "agent";
  /** Attached to an internal note. */
  internal: boolean;
  createdAt: number;
}

/** `images` from the request: file keys, deduplicated, at most ISSUE_IMAGES_MAX. Throws a message for the agent. */
export function parseImageKeys(raw: unknown): string[] {
  if (raw === undefined || raw === null) return [];
  if (!Array.isArray(raw) || raw.some((k) => typeof k !== "string" || !k || k.length > 100)) throw new Error("images must be a list of file keys.");
  const keys = [...new Set(raw as string[])];
  if (keys.length > ISSUE_IMAGES_MAX) throw new Error(`At most ${ISSUE_IMAGES_MAX} images per issue.`);
  return keys;
}

/**
 * The ownership check: every requested key must be an image attached to a message of this
 * conversation (`available`, with the stored file metadata, not what a client claims).
 * Throws a message for the agent otherwise. Keeps the requested order.
 */
export function pickIssueImages<T extends { key: string; type: string; size: number }>(keys: string[], available: T[]): T[] {
  const byKey = new Map(available.map((a) => [a.key, a]));
  return keys.map((key) => {
    const file = byKey.get(key);
    if (!file) throw new Error("That image isn't attached to this conversation.");
    if (!isImageType(file.type)) throw new Error("Only images (PNG, JPEG, GIF, WebP) can be added to an issue.");
    if (file.size > ISSUE_IMAGE_BYTES_MAX) throw new Error("Images are limited to 10 MB.");
    return file;
  });
}

/** Where the desk serves a file (W-06): unguessable, but anyone with the link can open it. */
export const deskFileUrl = (origin: string, key: string) => `${origin.replace(/\/+$/, "")}/api/files/${encodeURIComponent(key)}`;

/** Alt text that can't break out of `![…]`. */
const altText = (name: string) => name.replace(/[[\]\\\r\n]/g, " ").replace(/\s+/g, " ").trim().slice(0, 100) || "screenshot";

/** "## Screenshots" with one Markdown image per entry, or "" for none. */
export function imagesSection(images: { name: string; url: string }[]): string {
  if (!images.length) return "";
  return `## Screenshots\n\n${images.map((i) => `![${altText(i.name)}](${i.url.replace(/[\s()<>]/g, (ch) => `%${ch.charCodeAt(0).toString(16).toUpperCase().padStart(2, "0")}`)})`).join("\n\n")}`;
}

/** The body with the screenshots section added before the "From a support conversation" footer (or at the end). */
export function withImagesSection(body: string, section: string): string {
  if (!section) return body;
  const at = body.lastIndexOf("\n---\nFrom a support conversation");
  if (at === -1) return body.trim() ? `${body.trimEnd()}\n\n${section}` : section;
  return `${body.slice(0, at).trimEnd()}\n\n${section}\n${body.slice(at)}`;
}
