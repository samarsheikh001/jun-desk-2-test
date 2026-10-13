// I-10: business hours. Pure (Intl only), shared by the Worker, dashboard and widget.

export type Weekday = 0 | 1 | 2 | 3 | 4 | 5 | 6; // 0 = Sunday

export interface DayHours {
  day: Weekday;
  /** "09:00" (24h, in the business's time zone). */
  start: string;
  /** "17:30"; may be "24:00". */
  end: string;
}

export interface BusinessHours {
  enabled: boolean;
  timezone: string;
  /** At most one span per day; days not listed are closed. */
  days: DayHours[];
  /** Sent once per closed period to visitors writing to the team. "{when}" becomes the next opening. */
  awayMessage: string;
}

export const DEFAULT_AWAY_MESSAGE = "Thanks for your message! Our team is away right now and will reply here {when}.";
export const WEEKDAYS = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"] as const;

const TIME = /^([01]\d|2[0-3]):([0-5]\d)$|^24:00$/;
const minutes = (hhmm: string) => Number(hhmm.slice(0, 2)) * 60 + Number(hhmm.slice(3, 5));

export function validTimezone(tz: string): boolean {
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: tz });
    return true;
  } catch {
    return false;
  }
}

/** Validates what the dashboard sends; throws a readable message. */
export function parseHours(raw: unknown): BusinessHours {
  const r = (raw ?? {}) as Record<string, unknown>;
  const timezone = typeof r.timezone === "string" && validTimezone(r.timezone) ? r.timezone : "";
  if (!timezone) throw new Error("Pick a valid time zone.");
  const days: DayHours[] = [];
  for (const d of Array.isArray(r.days) ? r.days : []) {
    const x = (d ?? {}) as Record<string, unknown>;
    const day = Number(x.day);
    const start = String(x.start ?? "");
    const end = String(x.end ?? "");
    if (!Number.isInteger(day) || day < 0 || day > 6) throw new Error("Unknown weekday.");
    if (!TIME.test(start) || !TIME.test(end)) throw new Error(`${WEEKDAYS[day]}: use times like 09:00 and 17:30.`);
    if (minutes(end) <= minutes(start)) throw new Error(`${WEEKDAYS[day]}: closing time must be after opening time.`);
    if (days.some((e) => e.day === day)) throw new Error(`${WEEKDAYS[day]} is listed twice.`);
    days.push({ day: day as Weekday, start, end });
  }
  const awayMessage = typeof r.awayMessage === "string" && r.awayMessage.trim() ? r.awayMessage.trim().slice(0, 500) : DEFAULT_AWAY_MESSAGE;
  return { enabled: r.enabled === true, timezone, days: days.sort((a, b) => a.day - b.day), awayMessage };
}

/** Weekday and minute-of-day at `t` in `timezone`. */
function localTime(t: number, timezone: string): { day: Weekday; minute: number } {
  const parts = new Intl.DateTimeFormat("en-US", { timeZone: timezone, weekday: "short", hour: "2-digit", minute: "2-digit", hourCycle: "h23" }).formatToParts(new Date(t));
  const get = (type: string) => parts.find((p) => p.type === type)?.value ?? "";
  const day = (["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"] as const).indexOf(get("weekday") as "Sun") as Weekday;
  return { day, minute: Number(get("hour")) * 60 + Number(get("minute")) };
}

/** Open right now? Disabled hours mean always open. */
export function isOpen(hours: BusinessHours | null | undefined, t = Date.now()): boolean {
  if (!hours?.enabled) return true;
  const { day, minute } = localTime(t, hours.timezone);
  const today = hours.days.find((d) => d.day === day);
  return Boolean(today && minute >= minutes(today.start) && minute < minutes(today.end));
}

/**
 * When it next opens (epoch ms), or null if it's open now or never opens. Scans forward in
 * 15-minute steps (opening times are whole quarter hours in practice), which also gets DST right.
 */
export function nextOpening(hours: BusinessHours | null | undefined, t = Date.now()): number | null {
  if (!hours?.enabled || isOpen(hours, t) || hours.days.length === 0) return null;
  const step = 15 * 60 * 1000;
  let at = Math.ceil(t / 60_000) * 60_000;
  // First align to a minute that's a multiple of 15 in local time (most zones are whole/half hours).
  for (let i = 0; i < 15 && localTime(at, hours.timezone).minute % 15 !== 0; i++) at += 60_000;
  for (let i = 0; i < 8 * 24 * 4; i++, at += step) if (isOpen(hours, at)) return at;
  return null;
}

/** "Monday at 09:00 (London time)" / "today at 13:00 (London time)". */
export function describeOpening(at: number, timezone: string, now = Date.now()): string {
  const local = (x: number) => new Intl.DateTimeFormat("en-GB", { timeZone: timezone, weekday: "long", hour: "2-digit", minute: "2-digit", hourCycle: "h23" }).formatToParts(new Date(x));
  const part = (p: Intl.DateTimeFormatPart[], type: string) => p.find((x) => x.type === type)?.value ?? "";
  const target = local(at);
  const day = part(target, "weekday");
  const sameDay = day === part(local(now), "weekday") && at - now < 24 * 60 * 60 * 1000;
  const tomorrow = day === part(local(now + 24 * 60 * 60 * 1000), "weekday") && at - now < 48 * 60 * 60 * 1000;
  const city = timezone.split("/").pop()!.replace(/_/g, " ");
  return `${sameDay ? "today" : tomorrow ? "tomorrow" : day} at ${part(target, "hour")}:${part(target, "minute")} (${city} time)`;
}

/** The away auto-reply with {when} filled in. */
export function awayText(hours: BusinessHours, t = Date.now()): string {
  const next = nextOpening(hours, t);
  const when = next ? describeOpening(next, hours.timezone, t) : "as soon as we can";
  // "on Monday at 09:00" reads better than "Monday at 09:00" after "reply here".
  const phrase = /^(today|tomorrow)/.test(when) || !next ? when : `on ${when}`;
  return hours.awayMessage.includes("{when}") ? hours.awayMessage.replace("{when}", phrase) : `${hours.awayMessage} We'll be back ${phrase}.`;
}
