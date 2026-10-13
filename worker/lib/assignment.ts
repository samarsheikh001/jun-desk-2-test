import { assignmentSettings } from "../../shared/inbox.ts";
import type { ConversationRef } from "../conversation.ts";

/**
 * I-02: gives a chat that just started needing a person to an online teammate, when the
 * workspace uses round robin. Only touches unassigned, open, human-handled conversations, so a
 * manual assignment or an agent's invite always wins. Returns who got it, or null.
 */
export async function autoAssign(env: Env, ref: ConversationRef): Promise<{ userId: string; name: string } | null> {
  const row = await env.DB.prepare(
    `SELECT i.settings FROM conversations c JOIN inboxes i ON i.id = c.inbox_id
     WHERE c.id = ? AND c.assignee_id IS NULL AND c.status = 'open' AND c.handling = 'human'`,
  )
    .bind(ref.conversationId)
    .first<{ settings: string }>();
  if (!row) return null;
  const { mode, capacity } = assignmentSettings((JSON.parse(row.settings) as { assignment?: unknown }).assignment);
  if (mode !== "round_robin") return null;

  const hub = env.WORKSPACE_HUB.getByName(ref.workspaceId);
  const online = await hub.onlineAgentIds();
  if (online.length === 0) return null;
  // Members only (a removed teammate's tab may still be open), with their open chats.
  const marks = online.map(() => "?").join(",");
  const members = await env.DB.prepare(
    `SELECT m.user_id AS userId, u.name,
       (SELECT COUNT(*) FROM conversations c WHERE c.workspace_id = m.workspace_id AND c.assignee_id = m.user_id AND c.status = 'open') AS open
     FROM members m JOIN users u ON u.id = m.user_id
     WHERE m.workspace_id = ? AND m.user_id IN (${marks})`,
  )
    .bind(ref.workspaceId, ...online)
    .all<{ userId: string; name: string; open: number }>();
  const picked = await hub.claimNextAssignee(members.results.map(({ userId, open }) => ({ userId, open })), capacity);
  if (!picked) return null;

  const claimed = await env.DB.prepare("UPDATE conversations SET assignee_id = ?, updated_at = ? WHERE id = ? AND assignee_id IS NULL")
    .bind(picked, Date.now(), ref.conversationId)
    .run();
  if (claimed.meta.changes === 0) return null;
  return { userId: picked, name: members.results.find((m) => m.userId === picked)?.name ?? "a teammate" };
}
