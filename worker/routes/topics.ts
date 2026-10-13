import { Hono } from "hono";
import { normalizeTag } from "../../shared/inbox.ts";
import { MAX_TOPICS } from "../../shared/topics.ts";
import { labelTopics } from "../ai/topics.ts";
import { requireUser } from "../auth/session.ts";
import { readJson } from "../lib/validate.ts";
import { HttpError, type AppContext, type AppEnv } from "../types.ts";
import { memberRole, requireAdmin } from "./inbox.ts";

// A-02: the workspace's topics. Any member can list them (inbox filter, Reports); owners and
// admins rename, merge and delete them and can run a labelling pass now. Agents only: topics
// never reach visitors (forVisitor() drops them).

export const topics = new Hono<AppEnv>();
topics.use("/workspaces/:id/topics", requireUser);
topics.use("/workspaces/:id/topics/*", requireUser);

async function requireTopic(c: AppContext, workspaceId: string, topicId: string): Promise<{ id: string; name: string }> {
  const row = await c.env.DB.prepare("SELECT id, name FROM topics WHERE id = ? AND workspace_id = ?").bind(topicId, workspaceId).first<{ id: string; name: string }>();
  if (!row) throw new HttpError(404, "not_found", "Topic not found.");
  return row;
}

topics.get("/workspaces/:id/topics", async (c) => {
  const workspaceId = c.req.param("id");
  await memberRole(c, workspaceId);
  const rows = await c.env.DB.prepare(
    `SELECT t.id, t.name, (SELECT COUNT(*) FROM conversations c WHERE c.workspace_id = t.workspace_id AND c.topic_id = t.id) AS conversations
     FROM topics t WHERE t.workspace_id = ? ORDER BY t.name LIMIT 500`,
  )
    .bind(workspaceId)
    .all<{ id: string; name: string; conversations: number }>();
  return c.json({ topics: rows.results, max: MAX_TOPICS });
});

topics.patch("/workspaces/:id/topics/:tid", async (c) => {
  const workspaceId = c.req.param("id");
  await requireAdmin(c, workspaceId);
  const topic = await requireTopic(c, workspaceId, c.req.param("tid"));
  const name = normalizeTag((await readJson(c.req)).name);
  if (!name) throw new HttpError(400, "invalid_field", "Topic names are 1 to 40 characters.");
  const clash = await c.env.DB.prepare("SELECT id FROM topics WHERE workspace_id = ? AND name = ? AND id <> ?").bind(workspaceId, name, topic.id).first();
  if (clash) throw new HttpError(409, "topic_exists", `There's already a topic called "${name}". Merge them instead.`);
  await c.env.DB.prepare("UPDATE topics SET name = ? WHERE id = ?").bind(name, topic.id).run();
  return c.json({ topic: { id: topic.id, name } });
});

/** Merge: the source's conversations move to `into`, then the source is deleted. */
topics.post("/workspaces/:id/topics/:tid/merge", async (c) => {
  const workspaceId = c.req.param("id");
  await requireAdmin(c, workspaceId);
  const source = await requireTopic(c, workspaceId, c.req.param("tid"));
  const intoId = (await readJson(c.req)).into;
  if (typeof intoId !== "string") throw new HttpError(400, "invalid_field", "`into` must be a topic id.");
  if (intoId === source.id) throw new HttpError(400, "invalid_field", "Can't merge a topic into itself.");
  const into = await requireTopic(c, workspaceId, intoId);
  const db = c.env.DB;
  const [moved] = await db.batch([
    db.prepare("UPDATE conversations SET topic_id = ? WHERE workspace_id = ? AND topic_id = ?").bind(into.id, workspaceId, source.id),
    db.prepare("DELETE FROM topics WHERE id = ?").bind(source.id),
  ]);
  return c.json({ topic: into, moved: moved!.meta.changes });
});

/** Delete: its conversations become unlabeled, so a later pass may label them again. */
topics.delete("/workspaces/:id/topics/:tid", async (c) => {
  const workspaceId = c.req.param("id");
  await requireAdmin(c, workspaceId);
  const topic = await requireTopic(c, workspaceId, c.req.param("tid"));
  const db = c.env.DB;
  await db.batch([
    db.prepare("UPDATE conversations SET topic_id = NULL, topic_labeled_at = NULL WHERE workspace_id = ? AND topic_id = ?").bind(workspaceId, topic.id),
    db.prepare("DELETE FROM topics WHERE id = ?").bind(topic.id),
  ]);
  return c.json({ ok: true });
});

/** "Label now": one labelling pass right away (also what e2e uses). */
topics.post("/workspaces/:id/topics/label", async (c) => {
  const workspaceId = c.req.param("id");
  await requireAdmin(c, workspaceId);
  // Lazy runs (Reports, cron) then wait their usual interval after this one.
  await c.env.WORKSPACE_HUB.getByName(workspaceId).claimTopicRun(0);
  try {
    return c.json(await labelTopics(c.env, workspaceId));
  } catch (error) {
    console.warn("topic labelling failed:", (error as Error).message);
    throw new HttpError(502, "ai_failed", "The AI couldn't label conversations just now. Try again in a minute.");
  }
});
