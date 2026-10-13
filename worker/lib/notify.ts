import { contactLabel, type NotificationEvent } from "../../shared/notifications.ts";
import type { ConversationRef } from "../conversation.ts";

/**
 * I-14: tells the workspace hub to notify whoever an event concerns (it applies the rules in
 * shared/notifications.ts). The text is the visitor's latest public message, or `note` for a
 * mention; internal text never goes into anything but a mention, which only members receive.
 * Never throws: notifications are a convenience. Run it with waitUntil.
 */
export async function notifyTeam(
  env: Env,
  ref: ConversationRef,
  event: Omit<NotificationEvent, "conversationId">,
  extra: { by?: string | null; note?: string } = {},
): Promise<void> {
  try {
    const row = await env.DB.prepare(
      `SELECT ct.id, ct.name, ct.email,
         (SELECT m.body FROM messages m WHERE m.conversation_id = c.id AND m.author_type = 'visitor' AND m.internal = 0 ORDER BY m.seq DESC LIMIT 1) AS last_visitor
       FROM conversations c JOIN contacts ct ON ct.id = c.contact_id WHERE c.id = ?`,
    )
      .bind(ref.conversationId)
      .first<{ id: string; name: string | null; email: string | null; last_visitor: string | null }>();
    if (!row) return;
    await env.WORKSPACE_HUB.getByName(ref.workspaceId).notify({
      ...event,
      conversationId: ref.conversationId,
      workspaceId: ref.workspaceId,
      contact: contactLabel(row),
      text: event.kind === "mention" ? (extra.note ?? "") : (row.last_visitor ?? ""),
      by: extra.by ?? null,
    });
  } catch (error) {
    console.error("notifying the team failed:", error);
  }
}
