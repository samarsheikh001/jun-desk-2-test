// I-14: notifications for agents. Pure rules shared by the Worker (who gets what, the text)
// and the dashboard (labels, settings). No Worker, DOM or Node APIs.

/** What happened. `assigned` covers round robin and a teammate's manual assignment. */
export type NotificationKind = "needs_person" | "assigned" | "visitor_reply" | "mention";

/** Per member, per workspace. Every trigger is on unless turned off. */
export interface NotificationPrefs {
  /** A chat was handed to the team and nobody has it yet. */
  needsPerson: boolean;
  /** A chat was assigned to me (round robin, or by a teammate). */
  assigned: boolean;
  /** The visitor wrote in a chat assigned to me. */
  visitorReply: boolean;
  /** A teammate @mentioned me in a note. */
  mention: boolean;
  /**
   * Not a trigger: a soft chime in the open desk for the events above (not while the focused tab
   * is showing that conversation). Doesn't change who is notified.
   */
  sound: boolean;
}

export const DEFAULT_NOTIFICATION_PREFS: NotificationPrefs = { needsPerson: true, assigned: true, visitorReply: true, mention: true, sound: true };
export const NOTIFICATION_PREF_KEYS = Object.keys(DEFAULT_NOTIFICATION_PREFS) as (keyof NotificationPrefs)[];

/** Stored prefs (JSON text or object) with defaults filled in; unknown keys and non-booleans are ignored. */
export function readNotificationPrefs(stored: unknown): NotificationPrefs {
  let value = stored;
  if (typeof value === "string") {
    try {
      value = JSON.parse(value);
    } catch {
      value = {};
    }
  }
  const prefs = { ...DEFAULT_NOTIFICATION_PREFS };
  if (value && typeof value === "object") {
    for (const key of NOTIFICATION_PREF_KEYS) {
      const v = (value as Record<string, unknown>)[key];
      if (typeof v === "boolean") prefs[key] = v;
    }
  }
  return prefs;
}

/** A PUT body: a partial set of booleans. Throws with a message people can read. */
export function parseNotificationPrefs(input: unknown, current: NotificationPrefs = DEFAULT_NOTIFICATION_PREFS): NotificationPrefs {
  if (!input || typeof input !== "object" || Array.isArray(input)) throw new Error("Expected an object of on/off settings.");
  const next = { ...current };
  for (const [key, value] of Object.entries(input)) {
    if (!(NOTIFICATION_PREF_KEYS as string[]).includes(key)) throw new Error(`Unknown notification setting: ${key}.`);
    if (typeof value !== "boolean") throw new Error(`${key} must be true or false.`);
    next[key as keyof NotificationPrefs] = value;
  }
  return next;
}

export interface NotificationEvent {
  kind: NotificationKind;
  conversationId: string;
  /** The teammate who caused it (never notified), or null for the visitor, the AI or round robin. */
  actorId: string | null;
  /** Who it's about: the assignee or the mentioned teammates. Absent for `needs_person` (everyone). */
  targets?: string[];
  /** `assigned` by round robin right as the chat needed a person: either toggle lets it through. */
  auto?: boolean;
}

/**
 * Who gets notified: current members only, never the actor, each respecting their own toggles.
 * - needs_person: every member who wants it.
 * - assigned: the assignee (round robin: if they want "assigned" or "needs a person").
 * - visitor_reply: the assignee. - mention: the mentioned teammates.
 */
export function notificationRecipients(event: NotificationEvent, members: { userId: string; prefs: NotificationPrefs }[]): string[] {
  const wants = (prefs: NotificationPrefs): boolean => {
    switch (event.kind) {
      case "needs_person":
        return prefs.needsPerson;
      case "assigned":
        return prefs.assigned || (event.auto === true && prefs.needsPerson);
      case "visitor_reply":
        return prefs.visitorReply;
      case "mention":
        return prefs.mention;
    }
  };
  const targets = event.kind === "needs_person" ? null : new Set(event.targets ?? []);
  const out: string[] = [];
  for (const m of members) {
    if (m.userId === event.actorId || out.includes(m.userId)) continue;
    if (targets && !targets.has(m.userId)) continue;
    if (wants(m.prefs)) out.push(m.userId);
  }
  return out;
}

/** What a notification shows. `id` is unique per event: an in-page copy and a push of the same event collapse silently. */
export interface NotificationPayload {
  id: string;
  /** `test`: "Send a test notification" in Settings. */
  kind: NotificationKind | "test";
  title: string;
  body: string;
  /** Path to open on click, e.g. /inbox/cv_123. */
  url: string;
  /** One notification per conversation: newer ones replace older. */
  tag: string;
}

/** Stable short number for anonymous visitors, e.g. "Visitor #4821" (the inbox shows the same). */
export function visitorNumber(contactId: string): string {
  let hash = 2166136261;
  for (let i = 0; i < contactId.length; i++) hash = Math.imul(hash ^ contactId.charCodeAt(i), 16777619);
  return String((hash >>> 0) % 10000).padStart(4, "0");
}

export const contactLabel = (c: { id: string; name: string | null; email: string | null }): string => c.name ?? c.email ?? `Visitor #${visitorNumber(c.id)}`;

/** One line, at most `max` characters. */
export function snippet(text: string, max = 100): string {
  const line = text.replace(/\s+/g, " ").trim();
  return line.length > max ? `${line.slice(0, max - 1)}…` : line;
}

/**
 * The words. `text` is the visitor's latest message, except for mentions, where it's the note
 * (members only ever receive these, and a visitor never does).
 */
export function notificationPayload(input: {
  id: string;
  kind: NotificationKind;
  conversationId: string;
  contact: string;
  text: string;
  by?: string | null;
  auto?: boolean;
}): NotificationPayload {
  const { kind, contact, by } = input;
  const title =
    kind === "needs_person" ? `${contact} needs a person`
    : kind === "assigned" ? (input.auto || !by ? `New chat assigned to you: ${contact}` : `${by} assigned you ${contact}`)
    : kind === "visitor_reply" ? `${contact} replied`
    : `${by ?? "A teammate"} mentioned you (${contact})`;
  return {
    id: input.id,
    kind,
    title: snippet(title, 120),
    body: snippet(input.text) || (kind === "mention" ? "Open the conversation to read the note." : "Open the conversation to reply."),
    url: `/inbox/${input.conversationId}`,
    tag: input.conversationId,
  };
}
