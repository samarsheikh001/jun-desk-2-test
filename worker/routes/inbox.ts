import { Hono } from "hono";
import { MAX_TAGS_PER_CONVERSATION, normalizeTag } from "../../shared/inbox.ts";
import { requireUser } from "../auth/session.ts";
import { loadSummary } from "../lib/conversations.ts";
import { newId } from "../lib/crypto.ts";
import { notifyConversationChanged } from "../lib/realtime.ts";
import { readJson, text } from "../lib/validate.ts";
import { HttpError, type AppContext, type AppEnv } from "../types.ts";

// M7 inbox basics: saved replies (I-06), tags (I-07) and unread @mentions (I-05). Notes
// themselves are messages, sent like replies with `internal: true`.

export async function memberRole(c: AppContext, workspaceId: string): Promise<string> {
  const row = await c.env.DB.prepare("SELECT role FROM members WHERE workspace_id = ? AND user_id = ?").bind(workspaceId, c.get("user").id).first<{ role: string }>();
  if (!row) throw new HttpError(404, "not_found", "Workspace not found.");
  return row.role;
}

export async function requireAdmin(c: AppContext, workspaceId: string): Promise<void> {
  if ((await memberRole(c, workspaceId)) === "agent") throw new HttpError(403, "forbidden", "Only owners and admins can change this.");
}

export const inbox = new Hono<AppEnv>();
inbox.use("/workspaces/:id/saved-replies", requireUser);
inbox.use("/workspaces/:id/saved-replies/*", requireUser);
inbox.use("/workspaces/:id/tags", requireUser);
inbox.use("/workspaces/:id/tags/*", requireUser);
inbox.use("/workspaces/:id/mentions", requireUser);
inbox.use("/conversations/:cid/tags", requireUser);

// ---------- saved replies (shared by the team; any member can add or edit) ----------

interface SavedReplyRow { id: string; title: string; body: string; createdBy: string | null; updatedAt: number }

const savedReply = (body: Record<string, unknown>) => ({ title: text(body, "title", { max: 80 }), body: text(body, "body", { max: 5000 }) });

inbox.get("/workspaces/:id/saved-replies", async (c) => {
  const workspaceId = c.req.param("id");
  await memberRole(c, workspaceId);
  const rows = await c.env.DB.prepare(
    "SELECT id, title, body, created_by AS createdBy, updated_at AS updatedAt FROM saved_replies WHERE workspace_id = ? ORDER BY title COLLATE NOCASE LIMIT 500",
  )
    .bind(workspaceId)
    .all<SavedReplyRow>();
  return c.json({ savedReplies: rows.results });
});

inbox.post("/workspaces/:id/saved-replies", async (c) => {
  const workspaceId = c.req.param("id");
  await memberRole(c, workspaceId);
  const input = savedReply(await readJson(c.req));
  const id = newId("sr");
  const now = Date.now();
  await c.env.DB.prepare("INSERT INTO saved_replies (id, workspace_id, title, body, created_by, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)")
    .bind(id, workspaceId, input.title, input.body, c.get("user").id, now, now)
    .run();
  return c.json({ savedReply: { id, ...input, createdBy: c.get("user").id, updatedAt: now } });
});

inbox.patch("/workspaces/:id/saved-replies/:rid", async (c) => {
  const workspaceId = c.req.param("id");
  await memberRole(c, workspaceId);
  const input = savedReply(await readJson(c.req));
  const result = await c.env.DB.prepare("UPDATE saved_replies SET title = ?, body = ?, updated_at = ? WHERE id = ? AND workspace_id = ?")
    .bind(input.title, input.body, Date.now(), c.req.param("rid"), workspaceId)
    .run();
  if (result.meta.changes === 0) throw new HttpError(404, "not_found", "Saved reply not found.");
  return c.json({ ok: true });
});

inbox.delete("/workspaces/:id/saved-replies/:rid", async (c) => {
  const workspaceId = c.req.param("id");
  await memberRole(c, workspaceId);
  await c.env.DB.prepare("DELETE FROM saved_replies WHERE id = ? AND workspace_id = ?").bind(c.req.param("rid"), workspaceId).run();
  return c.json({ ok: true });
});

// ---------- tags ----------

inbox.get("/workspaces/:id/tags", async (c) => {
  const workspaceId = c.req.param("id");
  await memberRole(c, workspaceId);
  const rows = await c.env.DB.prepare(
    `SELECT t.id, t.name, (SELECT COUNT(*) FROM conversation_tags ct WHERE ct.tag_id = t.id) AS conversations
     FROM tags t WHERE t.workspace_id = ? ORDER BY t.name LIMIT 1000`,
  )
    .bind(workspaceId)
    .all<{ id: string; name: string; conversations: number }>();
  return c.json({ tags: rows.results });
});

inbox.patch("/workspaces/:id/tags/:tagId", async (c) => {
  const workspaceId = c.req.param("id");
  await requireAdmin(c, workspaceId);
  const name = normalizeTag((await readJson(c.req)).name);
  if (!name) throw new HttpError(400, "invalid_field", "Tag names are 1 to 40 characters.");
  try {
    const result = await c.env.DB.prepare("UPDATE tags SET name = ? WHERE id = ? AND workspace_id = ?").bind(name, c.req.param("tagId"), workspaceId).run();
    if (result.meta.changes === 0) throw new HttpError(404, "not_found", "Tag not found.");
  } catch (error) {
    if (error instanceof HttpError) throw error;
    throw new HttpError(409, "tag_exists", `There's already a tag called "${name}".`);
  }
  return c.json({ ok: true });
});

inbox.delete("/workspaces/:id/tags/:tagId", async (c) => {
  const workspaceId = c.req.param("id");
  await requireAdmin(c, workspaceId);
  await c.env.DB.prepare("DELETE FROM tags WHERE id = ? AND workspace_id = ?").bind(c.req.param("tagId"), workspaceId).run();
  return c.json({ ok: true });
});

/** Sets a conversation's tags (the whole list). Unknown names become new tags. */
inbox.put("/conversations/:cid/tags", async (c) => {
  const conversationId = c.req.param("cid");
  const row = await c.env.DB.prepare(
    "SELECT c.workspace_id FROM conversations c JOIN members m ON m.workspace_id = c.workspace_id AND m.user_id = ? WHERE c.id = ?",
  )
    .bind(c.get("user").id, conversationId)
    .first<{ workspace_id: string }>();
  if (!row) throw new HttpError(404, "not_found", "Conversation not found.");
  const workspaceId = row.workspace_id;

  const raw = (await readJson(c.req)).tags;
  if (!Array.isArray(raw)) throw new HttpError(400, "invalid_field", "`tags` must be a list of names.");
  const names = new Map<string, string>();
  for (const value of raw) {
    const name = normalizeTag(value);
    if (!name) throw new HttpError(400, "invalid_field", "Tag names are 1 to 40 characters.");
    if (!names.has(name.toLowerCase())) names.set(name.toLowerCase(), name); // first spelling wins
  }
  if (names.size > MAX_TAGS_PER_CONVERSATION) throw new HttpError(400, "invalid_field", `At most ${MAX_TAGS_PER_CONVERSATION} tags per conversation.`);

  const db = c.env.DB;
  const now = Date.now();
  const wanted = [...names.values()];
  if (wanted.length) await db.batch(wanted.map((name) => db.prepare("INSERT OR IGNORE INTO tags (id, workspace_id, name, created_at) VALUES (?, ?, ?, ?)").bind(newId("tag"), workspaceId, name, now)));
  const placeholders = wanted.map(() => "?").join(",");
  await db.batch([
    db.prepare(`DELETE FROM conversation_tags WHERE conversation_id = ?${wanted.length ? ` AND tag_id NOT IN (SELECT id FROM tags WHERE workspace_id = ? AND name IN (${placeholders}))` : ""}`).bind(
      conversationId,
      ...(wanted.length ? [workspaceId, ...wanted] : []),
    ),
    ...(wanted.length
      ? [
          db.prepare(
            `INSERT OR IGNORE INTO conversation_tags (conversation_id, tag_id, created_at) SELECT ?, id, ? FROM tags WHERE workspace_id = ? AND name IN (${placeholders})`,
          ).bind(conversationId, now, workspaceId, ...wanted),
        ]
      : []),
  ]);
  await notifyConversationChanged(c.env, { conversationId, workspaceId });
  return c.json({ conversation: await loadSummary(db, conversationId) });
});

// ---------- mentions ----------

/** Conversations where I've been @mentioned and haven't looked yet. */
inbox.get("/workspaces/:id/mentions", async (c) => {
  const workspaceId = c.req.param("id");
  await memberRole(c, workspaceId);
  const row = await c.env.DB.prepare("SELECT COUNT(DISTINCT conversation_id) AS n FROM mentions WHERE workspace_id = ? AND user_id = ? AND read_at IS NULL")
    .bind(workspaceId, c.get("user").id)
    .first<{ n: number }>();
  return c.json({ unread: row?.n ?? 0 });
});
