// The island's one-line pill for a chat (D-39, D-80): what it says while folded. Used by the widget
// with the messages it has, and by the widget's `GET /conversations` for a chat whose messages
// aren't loaded yet (after a page load), so the line survives navigation without fetching history.

import { ACTION_ONLY_BODY, actionTitle, type MessageAction } from "./actions.ts";
import type { Message } from "./protocol.ts";
import { pickOpenWidget, WIDGET_ONLY_BODY, widgetSummary, widgetWaiting, type MessageWidget } from "./widgets.ts";

/** D-80: a card waiting longer than this no longer nudges from a fresh page load (it shows as a plain reply). */
export const WAITING_CARD_MS = 30 * 60_000;

/** The folded pill's line: a card waiting on the visitor ("Get a ride · tap to finish"), else the last reply in a few words. */
export interface IslandLine {
  text: string;
  waiting: boolean;
}

const clip = (line: string, max: number) => (line.length > max ? `${line.slice(0, max - 1).trimEnd()}…` : line);

/**
 * D-39: the folded island's line for its chat, like a live activity: the last reply's first card
 * in a few words (the widget file's own `summary` line, D-47, else a guess from the card: "Team
 * plan · active"), else the reply's first sentence without its [n] markers; at most 60
 * characters. Null when there's no reply to sum up.
 */
export function restSummary(messages: Message[], max = 60): string | null {
  const last = messages.findLast((m) => (m.authorType === "ai" || m.authorType === "agent") && !m.internal);
  if (!last) return null;
  const card = last.meta.widgets?.[0];
  const own = card?.summary?.replace(/\s+/g, " ").trim();
  if (own) return clip(own, max);
  const fromCard = card ? widgetSummary(card.root, max) : "";
  if (fromCard) return fromCard;
  if (last.body === ACTION_ONLY_BODY || last.body === WIDGET_ONLY_BODY) return null;
  const text = last.body.replace(/\s*\[\d{1,2}\]/g, "").replace(/[*_`#>]+/g, "").replace(/\s+/g, " ").trim();
  const sentence = /^.+?[.!?](?=\s|$)/.exec(text)?.[0] ?? text;
  if (!sentence) return null;
  return clip(sentence, max);
}

/**
 * D-80: the pill's line for a card waiting on the visitor: the action's own words, or the widget's
 * title only ("Get a ride", not "Get a ride · Scheduled pickup"), so "tap to finish" fits.
 */
export function waitingCardLine(card: { action: MessageAction } | { widget: MessageWidget }): string {
  const name =
    "action" in card
      ? card.action.description || actionTitle(card.action.name)
      : (card.widget.summary?.replace(/\s+/g, " ").trim() || widgetSummary(card.widget.root, 40) || "A card").split(" · ")[0]!;
  return `${clip(name, 40)} · tap to finish`;
}

/** D-80: whether an AI message's page action waits on the visitor (a Confirm, or details the AI couldn't fill). */
export function actionWaits(action: MessageAction | undefined): action is MessageAction {
  return Boolean(action && action.status === "pending" && (action.risk !== "auto" || action.missing.length > 0));
}

/**
 * The pill's line from a chat's latest messages (oldest first), as the server sees them: a card in
 * the latest exchange still waiting on the visitor (and younger than WAITING_CARD_MS), else
 * restSummary. Null when there's nothing to say.
 */
export function islandLine(messages: Message[], now: number): IslandLine | null {
  const visible = messages.filter((m) => !m.internal);
  const from = visible.findLastIndex((m) => m.authorType === "visitor");
  const recent = from >= 0 ? visible.slice(from) : visible;
  const fresh = (m: Message) => now - m.createdAt < WAITING_CARD_MS;
  const confirm = recent.findLast((m) => m.authorType === "ai" && actionWaits(m.meta.action));
  if (confirm && fresh(confirm)) return { text: waitingCardLine({ action: confirm.meta.action! }), waiting: true };
  const widgets = recent.flatMap((m) => (m.authorType === "ai" && m.meta.widgets?.length ? m.meta.widgets.map((widget) => ({ message: m, widget })) : []));
  const shown = pickOpenWidget(widgets, null) ?? (widgets.length === 1 ? widgets[0]! : null);
  if (shown && widgetWaiting(shown.widget) && fresh(shown.message)) return { text: waitingCardLine({ widget: shown.widget }), waiting: true };
  const text = restSummary(visible);
  return text ? { text, waiting: false } : null;
}
