import { startPage } from "../../shared/metrics.ts";
import {
  parseTopicOutput,
  resolveTopics,
  TOPIC_BATCH,
  TOPIC_LOOKBACK_MS,
  TOPIC_QUIET_MS,
  TOPIC_VISITOR_MESSAGES,
  topicExcerpt,
  topicInput,
  topicPagePath,
  topicPrompt,
  type ExcerptMessage,
  type TopicItem,
} from "../../shared/topics.ts";
import { newId } from "../lib/crypto.ts";
import { completeText, createModel, loadAiSettings, type AgentModel } from "./providers.ts";

// A-02: labels quiet conversations with a topic, in batches, off the hot path: from the
// 15-minute cron, lazily when Reports opens (at most every 5 minutes per workspace) and from
// "Label now". Only public messages reach the prompt (never internal notes). Tokens count toward
// ai_usage but a label isn't a reply, so it doesn't use up the reply cap; nothing runs while the
// AI is off or the cap is reached.
//
// Relabelling: a label describes why the customer came, i.e. the opening visitor messages
// (topicExcerpt). A labelled conversation is looked at again only if the visitor wrote more
// after it was labelled AND it had fewer than three visitor messages then (so the text the label
// was based on has changed). That's at most two more passes, usually none.

const LABEL_TIMEOUT_MS = 60_000;
/** Lazy runs (Reports, cron) start at most this often per workspace. */
export const TOPIC_RUN_INTERVAL_MS = 5 * 60_000;
/** Model calls per run: up to 100 conversations, the rest wait for the next run. */
const MAX_BATCHES = 4;

const CANDIDATES = `
  SELECT c.id,
    (SELECT json_extract(d.context, '$.page.url') FROM debug_snapshots d WHERE d.conversation_id = c.id ORDER BY d.created_at LIMIT 1) AS startUrl
  FROM conversations c
  WHERE c.workspace_id = ?1 AND c.created_at >= ?2
    AND (c.status = 'resolved' OR c.last_message_at <= ?3)
    AND (c.topic_labeled_at IS NULL OR (
      c.last_message_at > c.topic_labeled_at
      AND EXISTS (SELECT 1 FROM messages m WHERE m.conversation_id = c.id AND m.author_type = 'visitor' AND m.created_at > c.topic_labeled_at)
      AND (SELECT COUNT(*) FROM messages m WHERE m.conversation_id = c.id AND m.author_type = 'visitor' AND m.created_at <= c.topic_labeled_at) < ${TOPIC_VISITOR_MESSAGES}))
    AND EXISTS (SELECT 1 FROM messages m WHERE m.conversation_id = c.id AND m.author_type = 'visitor')
  ORDER BY c.last_message_at DESC LIMIT ?4`;

export type TopicSkip = "ai_off" | "cap_reached";
export interface TopicRun {
  labeled: number;
  /** The conversations that got a label in this pass. */
  ids: string[];
  /** Looked at but left without a (new) label: the model gave none or the output didn't parse. */
  unlabeled: number;
  skipped?: TopicSkip;
}

const month = () => new Date().toISOString().slice(0, 7);

/** Whether labelling may run now (AI on, under the monthly cap), and the model if so. */
async function topicModel(env: Env, workspaceId: string): Promise<AgentModel | TopicSkip> {
  const [settings, usage] = await Promise.all([
    loadAiSettings(env, workspaceId),
    env.DB.prepare("SELECT replies FROM ai_usage WHERE workspace_id = ? AND month = ?").bind(workspaceId, month()).first<{ replies: number }>(),
  ]);
  if (!settings.enabled) return "ai_off";
  if ((usage?.replies ?? 0) >= settings.monthlyReplyCap) return "cap_reached";
  return createModel(env, workspaceId, settings, "topics");
}

/** Tokens count toward ai_usage; these jobs aren't replies, so they don't use up the reply cap. */
export async function recordUsage(env: Env, workspaceId: string, usage: { inputTokens?: number; outputTokens?: number }): Promise<void> {
  await env.DB.prepare(
    `INSERT INTO ai_usage (workspace_id, month, replies, input_tokens, output_tokens) VALUES (?1, ?2, 0, ?3, ?4)
     ON CONFLICT (workspace_id, month) DO UPDATE SET input_tokens = input_tokens + ?3, output_tokens = output_tokens + ?4`,
  )
    .bind(workspaceId, month(), usage.inputTokens ?? 0, usage.outputTokens ?? 0)
    .run();
}

async function existingTopics(db: D1Database, workspaceId: string): Promise<string[]> {
  const rows = await db.prepare("SELECT name FROM topics WHERE workspace_id = ? ORDER BY created_at, name").bind(workspaceId).all<{ name: string }>();
  return rows.results.map((r) => r.name);
}

/** One model call: labels for the items, or null when the output didn't parse. */
async function ask(env: Env, workspaceId: string, model: AgentModel, items: TopicItem[], existing: string[]) {
  const result = await completeText({
    model: model.model,
    ...model.prompt(topicPrompt(existing)),
    messages: [{ role: "user", content: topicInput(items) }],
    // Room for reasoning models' hidden tokens too; the answer itself is ~15 tokens per item.
    maxOutputTokens: 800 + 30 * items.length,
    temperature: 0,
    abortSignal: AbortSignal.timeout(LABEL_TIMEOUT_MS),
  });
  await recordUsage(env, workspaceId, result.totalUsage);
  const parsed = parseTopicOutput(result.text);
  if (!parsed) console.warn("topic labels: unparseable model output:", result.text.slice(0, 200));
  return parsed;
}

/**
 * One labelling pass for a workspace: up to MAX_BATCHES model calls of TOPIC_BATCH conversations.
 * A model error stops the pass and leaves the rest for the next one.
 */
export async function labelTopics(env: Env, workspaceId: string, options: { now?: number; maxBatches?: number } = {}): Promise<TopicRun> {
  const run: TopicRun = { labeled: 0, ids: [], unlabeled: 0 };
  const model = await topicModel(env, workspaceId);
  if (typeof model === "string") return { ...run, skipped: model };
  const db = env.DB;
  const now = options.now ?? Date.now();
  const seen = new Set<string>();

  for (let batch = 0; batch < (options.maxBatches ?? MAX_BATCHES); batch++) {
    const rows = (
      await db.prepare(CANDIDATES).bind(workspaceId, now - TOPIC_LOOKBACK_MS, now - TOPIC_QUIET_MS, TOPIC_BATCH + seen.size).all<{ id: string; startUrl: string | null }>()
    ).results.filter((r) => !seen.has(r.id)).slice(0, TOPIC_BATCH);
    if (rows.length === 0) break;
    rows.forEach((r) => seen.add(r.id));

    // Public messages only: internal notes never reach the prompt.
    const placeholders = rows.map(() => "?").join(",");
    const messages = await db
      .prepare(
        `SELECT conversation_id AS cid, author_type AS authorType, body FROM (
           SELECT m.conversation_id, m.author_type, m.body, m.seq,
             ROW_NUMBER() OVER (PARTITION BY m.conversation_id ORDER BY m.seq) AS n
           FROM messages m
           WHERE m.conversation_id IN (${placeholders}) AND m.internal = 0 AND m.author_type IN ('visitor', 'ai', 'agent')
         ) WHERE n <= 12 ORDER BY cid, seq`,
      )
      .bind(...rows.map((r) => r.id))
      .all<ExcerptMessage & { cid: string }>();
    const byConversation = new Map<string, ExcerptMessage[]>();
    for (const m of messages.results) byConversation.set(m.cid, [...(byConversation.get(m.cid) ?? []), m]);

    const items: (TopicItem & { conversationId: string })[] = [];
    for (const row of rows) {
      const lines = topicExcerpt(byConversation.get(row.id) ?? []);
      if (lines.length) items.push({ id: String(items.length + 1), conversationId: row.id, page: topicPagePath(startPage(row.startUrl)), lines });
    }

    const existing = await existingTopics(db, workspaceId);
    let labels = new Map<string, string>();
    let created: string[] = [];
    let attempted = items;
    if (items.length) {
      let parsed = await ask(env, workspaceId, model, items, existing);
      // Unparseable: once more with half the conversations; the other half goes back in the queue.
      if (!parsed && items.length > 1) {
        attempted = items.slice(0, Math.ceil(items.length / 2));
        rows.forEach((r) => {
          if (!attempted.some((i) => i.conversationId === r.id) && items.some((i) => i.conversationId === r.id)) seen.delete(r.id);
        });
        parsed = await ask(env, workspaceId, model, attempted, existing);
      }
      if (parsed) ({ labels, created } = resolveTopics(parsed, attempted.map((i) => i.id), existing));
    }

    const stamp = Date.now();
    if (created.length) {
      await db.batch(created.map((name) => db.prepare("INSERT OR IGNORE INTO topics (id, workspace_id, name, created_at) VALUES (?, ?, ?, ?)").bind(newId("top"), workspaceId, name, stamp)));
    }
    const done = new Set(attempted.map((i) => i.conversationId));
    // Conversations with no public text to label (only attachments) count as looked at too.
    for (const row of rows) if (!items.some((i) => i.conversationId === row.id)) done.add(row.id);
    const updates = [...done].map((conversationId) => {
      const item = attempted.find((i) => i.conversationId === conversationId);
      const name = item && labels.get(item.id);
      return name
        ? db.prepare("UPDATE conversations SET topic_id = (SELECT id FROM topics WHERE workspace_id = ? AND name = ?), topic_labeled_at = ? WHERE id = ?").bind(workspaceId, name, stamp, conversationId)
        : db.prepare("UPDATE conversations SET topic_labeled_at = ? WHERE id = ?").bind(stamp, conversationId);
    });
    if (updates.length) await db.batch(updates);
    const labeledNow = attempted.filter((i) => labels.has(i.id));
    run.labeled += labeledNow.length;
    run.ids.push(...labeledNow.map((i) => i.conversationId));
    run.unlabeled += done.size - labeledNow.length;
  }
  return run;
}

/** Lazily (Reports): a labelling pass unless one started in the last 5 minutes. */
export async function kickTopicLabelling(env: Env, workspaceId: string): Promise<void> {
  try {
    if (!(await env.WORKSPACE_HUB.getByName(workspaceId).claimTopicRun(TOPIC_RUN_INTERVAL_MS))) return;
    await labelTopics(env, workspaceId);
  } catch (error) {
    console.warn("topic labelling failed:", (error as Error).message);
  }
}

/** The cron: every workspace with AI replies on. */
export async function labelAllWorkspaces(env: Env): Promise<void> {
  const rows = await env.DB.prepare("SELECT workspace_id AS id FROM ai_settings WHERE enabled = 1").all<{ id: string }>();
  for (const { id } of rows.results) await kickTopicLabelling(env, id);
}

