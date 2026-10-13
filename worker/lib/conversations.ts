import { conversationIntent } from "../../shared/intents.ts";
import { isIssue, type DebugContext, type DebugEvent } from "../../shared/debug.ts";
import type { Attachment, AuthorType, ConversationIssue, ConversationStatus, CsatRating, ConversationSummary, Handling, Message, MessageMeta } from "../../shared/protocol.ts";

export const SUMMARY_SELECT = `
  SELECT c.id, c.status, c.handling, c.assignee_id, c.last_seq, c.last_message_at, c.last_message_preview,
         c.last_message_author, c.agent_read_seq, c.visitor_read_seq, c.created_at, c.debug_issue_count,
         c.resolution, c.csat_rating, c.csat_resolution, c.intent, c.intent_exited_at,
         c.topic_id, (SELECT tp.name FROM topics tp WHERE tp.id = c.topic_id) AS topic_name,
         ct.id AS contact_id, ct.name AS contact_name, ct.email AS contact_email, ct.verified_at AS contact_verified_at,
         (SELECT json_group_array(t.name) FROM conversation_tags ctg JOIN tags t ON t.id = ctg.tag_id WHERE ctg.conversation_id = c.id) AS tags
  FROM conversations c JOIN contacts ct ON ct.id = c.contact_id`;

export interface SummaryRow {
  id: string;
  status: ConversationStatus;
  handling: Handling;
  assignee_id: string | null;
  last_seq: number;
  last_message_at: number;
  last_message_preview: string | null;
  last_message_author: AuthorType | null;
  agent_read_seq: number;
  visitor_read_seq: number;
  created_at: number;
  debug_issue_count: number;
  resolution: number;
  csat_rating: CsatRating | null;
  csat_resolution: number | null;
  intent: string | null;
  intent_exited_at: number | null;
  topic_id: string | null;
  topic_name: string | null;
  contact_id: string;
  contact_name: string | null;
  contact_email: string | null;
  contact_verified_at: number | null;
  tags: string;
}

export function toSummary(row: SummaryRow): ConversationSummary {
  return {
    id: row.id,
    status: row.status,
    handling: row.handling,
    assigneeId: row.assignee_id,
    contact: { id: row.contact_id, name: row.contact_name, email: row.contact_email, verified: row.contact_verified_at !== null },
    lastSeq: row.last_seq,
    lastMessageAt: row.last_message_at,
    lastMessagePreview: row.last_message_preview,
    lastMessageAuthor: row.last_message_author,
    agentReadSeq: row.agent_read_seq,
    visitorReadSeq: row.visitor_read_seq,
    createdAt: row.created_at,
    debugIssueCount: row.debug_issue_count,
    tags: (JSON.parse(row.tags) as string[]).sort((a, b) => a.localeCompare(b)),
    topic: row.topic_id && row.topic_name ? { id: row.topic_id, name: row.topic_name } : null,
    // Rated since it was last resolved (a reopened conversation isn't, until it's resolved and rated again).
    csat: { rating: row.csat_rating, ratedThisRound: row.status === "resolved" && row.csat_rating !== null && row.csat_resolution === row.resolution },
    intent: conversationIntent(row.intent, row.intent_exited_at),
  };
}

/**
 * What a visitor may see of their conversation: no tags (I-07), topic (A-02) or debug issue count.
 * The intent (AI-20) stays: their own app opened the chat with it, and the widget needs it after a
 * reload to keep the exit button on screen (D-37).
 */
export function forVisitor(summary: ConversationSummary): ConversationSummary {
  return { ...summary, tags: [], topic: null, debugIssueCount: 0 };
}

export async function loadSummary(db: D1Database, conversationId: string): Promise<ConversationSummary | null> {
  const row = await db.prepare(`${SUMMARY_SELECT} WHERE c.id = ?`).bind(conversationId).first<SummaryRow>();
  return row ? toSummary(row) : null;
}

export const MESSAGE_SELECT = `
  SELECT m.id, m.seq, m.author_type, m.author_id, u.name AS author_name, m.body, m.attachments,
         m.client_msg_id, m.created_at, m.internal, m.meta
  FROM messages m LEFT JOIN users u ON m.author_type = 'agent' AND u.id = m.author_id`;

export interface MessageRow {
  id: string;
  seq: number;
  author_type: AuthorType;
  author_id: string | null;
  author_name: string | null;
  body: string;
  attachments: string;
  client_msg_id: string;
  created_at: number;
  internal: number;
  meta: string;
}

export function toMessage(row: MessageRow): Message {
  return {
    id: row.id,
    seq: row.seq,
    authorType: row.author_type,
    authorId: row.author_id,
    authorName: row.author_name,
    body: row.body,
    attachments: JSON.parse(row.attachments) as Attachment[],
    clientMsgId: row.client_msg_id,
    createdAt: row.created_at,
    internal: row.internal === 1,
    meta: JSON.parse(row.meta) as MessageMeta,
  };
}

/**
 * Messages with seq > `since`, oldest first, at most `limit` (the most recent ones).
 * Internal messages (agent-only notes) are included only when `includeInternal`.
 */
export async function loadMessages(
  db: D1Database,
  conversationId: string,
  options: { since?: number; limit?: number; includeInternal: boolean },
): Promise<Message[]> {
  const internal = options.includeInternal ? "" : "AND m.internal = 0";
  const rows = await db
    .prepare(`SELECT * FROM (${MESSAGE_SELECT} WHERE m.conversation_id = ? AND m.seq > ? ${internal} ORDER BY m.seq DESC LIMIT ?) ORDER BY seq`)
    .bind(conversationId, options.since ?? 0, options.limit ?? 200)
    .all<MessageRow>();
  return rows.results.map(toMessage);
}

/** Short one-line preview for inbox lists. */
export function preview(body: string, attachments: Attachment[]): string {
  const text = body.replace(/\s+/g, " ").trim();
  if (text) return text.length > 140 ? `${text.slice(0, 139)}…` : text;
  if (attachments.length) return attachments.length === 1 ? `📎 ${attachments[0]!.name}` : `📎 ${attachments.length} files`;
  return "";
}

/**
 * Debug context (S-03) as agents see it: the latest snapshot's environment plus every captured
 * event, merged across snapshots (each message sends the loader's whole recent buffer), newest first.
 */
export async function loadDebugContext(
  db: D1Database,
  conversationId: string,
): Promise<{ context: Omit<DebugContext, "events"> | null; events: DebugEvent[]; issueCount: number }> {
  const rows = await db.prepare("SELECT context FROM debug_snapshots WHERE conversation_id = ? ORDER BY created_at DESC LIMIT 20").bind(conversationId).all<{ context: string }>();
  if (rows.results.length === 0) return { context: null, events: [], issueCount: 0 };
  const snapshots = rows.results.map((r) => JSON.parse(r.context) as DebugContext);
  const seen = new Set<string>();
  const events: DebugEvent[] = [];
  for (const snapshot of snapshots) {
    for (const e of snapshot.events) {
      const key = `${e.t}|${e.kind}|${e.url ?? ""}|${e.message ?? ""}|${e.status ?? ""}|${e.code ?? ""}`;
      if (seen.has(key)) continue;
      seen.add(key);
      events.push(e);
    }
  }
  events.sort((a, b) => b.t - a.t);
  const { events: _latestEvents, ...latest } = snapshots[0]!;
  return { context: latest, events: events.slice(0, 100), issueCount: events.filter(isIssue).length };
}

/** S-08: issues filed from this conversation, oldest first (only ones the tracker confirmed). */
export async function loadIssues(db: D1Database, conversationId: string): Promise<ConversationIssue[]> {
  const rows = await db
    .prepare(
      `SELECT id, provider, target, external_id, key, url, title, created_by, created_at FROM conversation_issues
       WHERE conversation_id = ? AND url IS NOT NULL ORDER BY created_at`,
    )
    .bind(conversationId)
    .all<{ id: string; provider: ConversationIssue["provider"]; target: string; external_id: string; key: string; url: string; title: string; created_by: string | null; created_at: number }>();
  return rows.results.map((r) => ({
    id: r.id,
    provider: r.provider,
    target: r.target,
    externalId: r.external_id,
    key: r.key,
    url: r.url,
    title: r.title,
    createdBy: r.created_by,
    createdAt: r.created_at,
  }));
}
