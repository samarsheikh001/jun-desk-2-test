// AI-20 intent-launched conversations (D-37). The host app opens the widget for a purpose,
// JunDesk.open({ intent: "cancel", onExit }), and a skill in the agent config defines that
// intent in its frontmatter (opening line, quick replies, exit action) with the procedure as its
// body. Pure; shared by the Worker (config, prompt, routes), the widget and tests.

/** Intent names: lowercase letters, digits, "_" and "-", at most 40 characters (the loader checks the same). */
export const INTENT_NAME = /^[a-z0-9_-]{1,40}$/;
export const MAX_INTENT_OPENING = 300;
export const MAX_INTENT_REPLIES = 8;
export const MAX_INTENT_REPLY = 60;
export const MAX_INTENT_EXIT = 40;

export function isIntentName(value: unknown): value is string {
  return typeof value === "string" && INTENT_NAME.test(value);
}

/**
 * What the widget needs to start an intent's conversation. `opening`: the fixed first message,
 * shown instantly and never generated or stored; `replies`: quick replies under it, each sent as
 * the visitor's own message; `exit`: the label of the button that ends the flow in the host app.
 */
export interface IntentSpec {
  name: string;
  opening: string | null;
  replies: string[];
  exit: string | null;
}

/** A conversation's intent as agents see it (null for ordinary chats; visitors always get null). */
export interface ConversationIntent {
  name: string;
  /** When the visitor clicked the intent's exit button (epoch ms), or null. */
  exitedAt: number | null;
}

export function conversationIntent(name: string | null, exitedAt: number | null): ConversationIntent | null {
  return name ? { name, exitedAt } : null;
}
