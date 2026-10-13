import { Hono } from "hono";
import type { AiAction, ConversationStatus } from "../../shared/protocol.ts";
import { draftSuggestions } from "../ai/suggestions.ts";
import { requireUser } from "../auth/session.ts";
import type { ConversationRef, Participant } from "../conversation.ts";
import { loadDebugContext, loadIssues, loadMessages, loadSummary, SUMMARY_SELECT, toSummary, type SummaryRow } from "../lib/conversations.ts";
import { connectConversation, connectHub, notifyConversationChanged, sendMessage } from "../lib/realtime.ts";
import { applyAppearance } from "../../shared/appearance.ts";
import { parseHours } from "../../shared/hours.ts";
import { parseAssignment } from "../../shared/inbox.ts";
import { notifyTeam } from "../lib/notify.ts";
import { parseOpeners } from "../../shared/openers.ts";
import { newId } from "../lib/crypto.ts";
import { normalizeDomains } from "../lib/origins.ts";
import { object, readJson } from "../lib/validate.ts";
import { HttpError, type AppContext, type AppEnv } from "../types.ts";
import { storeUpload } from "./files.ts";
import { secretScrubber } from "../lib/tool-secrets.ts";

const STATUSES: ConversationStatus[] = ["open", "pending", "snoozed", "resolved"];

export async function requireMember(c: AppContext, workspaceId: string): Promise<void> {
  const row = await c.env.DB.prepare("SELECT 1 FROM members WHERE workspace_id = ? AND user_id = ?").bind(workspaceId, c.get("user").id).first();
  if (!row) throw new HttpError(404, "not_found", "Workspace not found.");
}

/** Resolves a conversation the signed-in agent can access. */
export async function requireConversation(c: AppContext, conversationId: string): Promise<ConversationRef> {
  const row = await c.env.DB.prepare(
    `SELECT c.workspace_id FROM conversations c JOIN members m ON m.workspace_id = c.workspace_id AND m.user_id = ?
     WHERE c.id = ?`,
  )
    .bind(c.get("user").id, conversationId)
    .first<{ workspace_id: string }>();
  if (!row) throw new HttpError(404, "not_found", "Conversation not found.");
  return { conversationId, workspaceId: row.workspace_id };
}

const agent = (c: AppContext): Participant => ({ role: "agent", userId: c.get("user").id, name: c.get("user").name });

export const conversations = new Hono<AppEnv>();
conversations.use("/workspaces/:id/inbox", requireUser);
conversations.use("/workspaces/:id/inbox/suggestions/draft", requireUser);
conversations.use("/workspaces/:id/conversations", requireUser);
conversations.use("/workspaces/:id/files", requireUser);
conversations.use("/workspaces/:id/ws", requireUser);
conversations.use("/conversations/*", requireUser);

conversations.get("/workspaces/:id/inbox", async (c) => {
  const workspaceId = c.req.param("id");
  await requireMember(c, workspaceId);
  const inbox = await c.env.DB.prepare("SELECT id, name, widget_key AS widgetKey, settings FROM inboxes WHERE workspace_id = ? ORDER BY created_at LIMIT 1")
    .bind(workspaceId)
    .first<{ id: string; name: string; widgetKey: string; settings: string }>();
  return c.json({ inbox: inbox && { ...inbox, settings: JSON.parse(inbox.settings) as Record<string, unknown> } });
});

// Widget settings (owners/admins): proactive help, CSAT, branding, hours, allowed websites.
conversations.patch("/workspaces/:id/inbox", async (c) => {
  const workspaceId = c.req.param("id");
  const role = await c.env.DB.prepare("SELECT role FROM members WHERE workspace_id = ? AND user_id = ?").bind(workspaceId, c.get("user").id).first<{ role: string }>();
  if (!role) throw new HttpError(404, "not_found", "Workspace not found.");
  if (role.role === "agent") throw new HttpError(403, "forbidden", "Only owners and admins can change this.");
  const body = await readJson(c.req);
  const inbox = await c.env.DB.prepare("SELECT id, settings FROM inboxes WHERE workspace_id = ? ORDER BY created_at LIMIT 1").bind(workspaceId).first<{ id: string; settings: string }>();
  if (!inbox) throw new HttpError(404, "not_found", "No widget inbox.");
  const settings = JSON.parse(inbox.settings) as Record<string, unknown>;
  if (typeof body.proactive === "boolean") settings.proactive = body.proactive;
  // W-12: ask visitors to rate resolved conversations (on unless turned off).
  if (typeof body.csat === "boolean") settings.csat = body.csat;
  // W-04 appearance.
  try {
    applyAppearance(settings, body);
  } catch (error) {
    throw new HttpError(400, "invalid_field", (error as Error).message);
  }
  // I-10 business hours.
  if (body.hours !== undefined) {
    try {
      settings.hours = parseHours(body.hours);
    } catch (error) {
      throw new HttpError(400, "invalid_field", (error as Error).message);
    }
  }
  // I-02: who new chats that need a person go to.
  if (body.assignment !== undefined) {
    try {
      settings.assignment = parseAssignment(body.assignment);
    } catch (error) {
      throw new HttpError(400, "invalid_field", (error as Error).message);
    }
  }
  // P-01 page openers: the whole list at once.
  if (body.openers !== undefined) {
    try {
      settings.openers = parseOpeners(body.openers, () => newId("op"));
    } catch (error) {
      throw new HttpError(400, "invalid_field", (error as Error).message);
    }
  }
  if (body.allowedDomains !== undefined) {
    const { domains, invalid } = normalizeDomains(body.allowedDomains);
    if (invalid.length) throw new HttpError(400, "invalid_field", `Not a domain: ${invalid.join(", ")}. Use e.g. acme.com or *.acme.com.`);
    settings.allowedDomains = domains;
  }
  await c.env.DB.prepare("UPDATE inboxes SET settings = ? WHERE id = ?").bind(JSON.stringify(settings), inbox.id).run();
  return c.json({ settings });
});

// W-15: suggested questions drafted from the knowledge base (owners/admins). Not saved: the
// Appearance page puts them in its draft for the admin to edit and save.
const SUGGESTION_SKIPS = {
  no_knowledge: "Add a knowledge source first (Knowledge page), then draft questions from it.",
  ai_off: "Turn on the AI assistant first (Settings → AI assistant).",
  cap_reached: "The monthly AI cap is reached, so the AI can't draft questions until next month.",
} as const;

conversations.post("/workspaces/:id/inbox/suggestions/draft", async (c) => {
  const workspaceId = c.req.param("id");
  const role = await c.env.DB.prepare("SELECT role FROM members WHERE workspace_id = ? AND user_id = ?").bind(workspaceId, c.get("user").id).first<{ role: string }>();
  if (!role) throw new HttpError(404, "not_found", "Workspace not found.");
  if (role.role === "agent") throw new HttpError(403, "forbidden", "Only owners and admins can change this.");
  let draft: Awaited<ReturnType<typeof draftSuggestions>>;
  try {
    draft = await draftSuggestions(c.env, workspaceId);
  } catch (error) {
    console.warn("suggested questions draft failed:", (error as Error).message);
    throw new HttpError(502, "ai_failed", "The AI couldn't draft questions just now (it failed or took too long). Try again in a minute.");
  }
  if ("skipped" in draft) throw new HttpError(400, draft.skipped, SUGGESTION_SKIPS[draft.skipped]);
  if (!draft.suggestions.length) throw new HttpError(502, "ai_unusable", "The AI's answer had no usable questions. Try again.");
  return c.json({ suggestions: draft.suggestions });
});

conversations.get("/workspaces/:id/conversations", async (c) => {
  const workspaceId = c.req.param("id");
  await requireMember(c, workspaceId);
  const status = c.req.query("status") ?? "open";
  const assignee = c.req.query("assignee"); // "me" | "unassigned" | "mentions" | undefined
  const tag = c.req.query("tag");
  const topic = c.req.query("topic"); // A-02: a topic id
  const rating = c.req.query("rating"); // W-12: "good" | "bad", the latest rating
  if (rating !== undefined && rating !== "good" && rating !== "bad") throw new HttpError(400, "invalid_field", "rating must be good or bad.");
  if (status !== "all" && !STATUSES.includes(status as ConversationStatus)) throw new HttpError(400, "invalid_field", "Unknown status.");

  // The other filters apply to the per-status counts too (the inbox's tabs); status only to the rows.
  const where = ["c.workspace_id = ?"];
  const params: unknown[] = [workspaceId];
  if (assignee === "me") {
    where.push("c.assignee_id = ?");
    params.push(c.get("user").id);
  } else if (assignee === "unassigned") {
    where.push("c.assignee_id IS NULL");
  } else if (assignee === "mentions") {
    where.push("c.id IN (SELECT conversation_id FROM mentions WHERE user_id = ?)");
    params.push(c.get("user").id);
  }
  if (tag) {
    where.push("c.id IN (SELECT ct.conversation_id FROM conversation_tags ct JOIN tags t ON t.id = ct.tag_id WHERE t.workspace_id = c.workspace_id AND t.name = ?)");
    params.push(tag);
  }
  if (topic) {
    where.push("c.topic_id = ?");
    params.push(topic);
  }
  if (rating) {
    where.push("c.csat_rating = ?");
    params.push(rating);
  }
  const filtered = where.join(" AND ");
  const byStatus = status === "all" ? "" : " AND c.status = ?";
  const [rows, counted] = await c.env.DB.batch([
    c.env.DB.prepare(`${SUMMARY_SELECT} WHERE ${filtered}${byStatus} ORDER BY c.last_message_at DESC LIMIT 100`).bind(...params, ...(byStatus ? [status] : [])),
    c.env.DB.prepare(`SELECT c.status AS status, COUNT(*) AS n FROM conversations c WHERE ${filtered} GROUP BY c.status`).bind(...params),
  ]);
  const statusCounts = counted!.results as { status: string; n: number }[];
  const counts: Record<string, number> = { all: statusCounts.reduce((sum, row) => sum + row.n, 0) };
  for (const row of statusCounts) counts[row.status] = row.n;
  return c.json({ conversations: (rows!.results as SummaryRow[]).map(toSummary), counts });
});

conversations.get("/workspaces/:id/ws", async (c) => {
  const workspaceId = c.req.param("id");
  await requireMember(c, workspaceId);
  return connectHub(c.env, c.req.raw, workspaceId, { userId: c.get("user").id, name: c.get("user").name });
});

conversations.post("/workspaces/:id/files", async (c) => {
  const workspaceId = c.req.param("id");
  await requireMember(c, workspaceId);
  return c.json({ attachment: await storeUpload(c, workspaceId, `user:${c.get("user").id}`) });
});

conversations.get("/conversations/:cid", async (c) => {
  const ref = await requireConversation(c, c.req.param("cid"));
  const [conversation, messages, issues] = await Promise.all([
    loadSummary(c.env.DB, ref.conversationId),
    loadMessages(c.env.DB, ref.conversationId, { includeInternal: true }),
    loadIssues(c.env.DB, ref.conversationId), // S-08
    // Opening the conversation reads my @mentions in it (I-05).
    c.env.DB.prepare("UPDATE mentions SET read_at = ? WHERE conversation_id = ? AND user_id = ? AND read_at IS NULL").bind(Date.now(), ref.conversationId, c.get("user").id).run(),
  ]);
  return c.json({ conversation, messages, issues });
});

// Debug context (S-03): the latest snapshot's environment plus every captured event,
// merged across snapshots (each message sends the loader's whole recent buffer).
conversations.get("/conversations/:cid/context", async (c) => {
  const ref = await requireConversation(c, c.req.param("cid"));
  return c.json(await loadDebugContext(c.env.DB, ref.conversationId));
});

// AI-11: tool calls the AI made in this conversation, newest last.
conversations.get("/conversations/:cid/actions", async (c) => {
  const ref = await requireConversation(c, c.req.param("cid"));
  const rows = await c.env.DB.prepare(
    `SELECT id, message_seq, config_version, tool, input, output, status, http_status, duration_ms, created_at
     FROM ai_actions WHERE conversation_id = ? ORDER BY created_at LIMIT 200`,
  )
    .bind(ref.conversationId)
    .all<{ id: string; message_seq: number; config_version: number | null; tool: string; input: string; output: string | null; status: "ok" | "error"; http_status: number | null; duration_ms: number; created_at: number }>();
  // Rows are scrubbed when written; this also covers rows from before that, or a secret set later.
  const scrub = secretScrubber(c.env);
  const scrubInput = (json: string): Record<string, unknown> => {
    try {
      return JSON.parse(scrub(json)) as Record<string, unknown>;
    } catch {
      return {}; // a secret spanning JSON syntax: show nothing rather than fail
    }
  };
  const actions: AiAction[] = rows.results.map((r) => ({
    id: r.id,
    messageSeq: r.message_seq,
    configVersion: r.config_version,
    tool: r.tool,
    input: scrubInput(r.input),
    output: r.output === null ? null : scrub(r.output),
    status: r.status,
    httpStatus: r.http_status,
    durationMs: r.duration_ms,
    createdAt: r.created_at,
  }));
  return c.json({ actions });
});

conversations.patch("/conversations/:cid", async (c) => {
  const ref = await requireConversation(c, c.req.param("cid"));
  const body = await readJson(c.req);
  const sets: string[] = [];
  const params: unknown[] = [];

  if (body.status !== undefined) {
    if (!STATUSES.includes(body.status as ConversationStatus)) throw new HttpError(400, "invalid_field", "Unknown status.");
    // W-12: becoming resolved starts a new round the visitor can rate, unless they already rated
    // this round and haven't written since (pending → resolved again doesn't ask twice).
    sets.push(
      `resolution = resolution + (CASE WHEN status != 'resolved' AND ? = 'resolved' AND NOT (
         csat_resolution IS NOT NULL AND csat_resolution = resolution AND NOT EXISTS (
           SELECT 1 FROM messages m WHERE m.conversation_id = conversations.id AND m.author_type = 'visitor' AND m.created_at > conversations.csat_at)
       ) THEN 1 ELSE 0 END)`,
      "status = ?",
    );
    params.push(body.status, body.status);
  }
  let newAssignee: string | null = null;
  if (body.assigneeId !== undefined) {
    if (body.assigneeId !== null) {
      const member = await c.env.DB.prepare("SELECT 1 FROM members WHERE workspace_id = ? AND user_id = ?").bind(ref.workspaceId, String(body.assigneeId)).first();
      if (!member) throw new HttpError(400, "invalid_field", "Assignee must be a member of this workspace.");
      // I-14: tell them, unless it was already theirs (or they assigned themselves: the actor is never notified).
      const current = await c.env.DB.prepare("SELECT assignee_id FROM conversations WHERE id = ?").bind(ref.conversationId).first<{ assignee_id: string | null }>();
      if (current?.assignee_id !== body.assigneeId) newAssignee = String(body.assigneeId);
    }
    sets.push("assignee_id = ?");
    params.push(body.assigneeId);
  }
  if (body.handling !== undefined) {
    // "Hand back to AI" (or take over without replying).
    if (body.handling !== "ai" && body.handling !== "human") throw new HttpError(400, "invalid_field", "handling must be ai or human.");
    sets.push("handling = ?");
    params.push(body.handling);
  }
  if (sets.length === 0) throw new HttpError(400, "invalid_body", "Nothing to change.");

  await c.env.DB.prepare(`UPDATE conversations SET ${sets.join(", ")}, updated_at = ? WHERE id = ?`)
    .bind(...params, Date.now(), ref.conversationId)
    .run();
  await notifyConversationChanged(c.env, ref);
  if (newAssignee) {
    const me = c.get("user");
    c.executionCtx.waitUntil(notifyTeam(c.env, ref, { kind: "assigned", actorId: me.id, targets: [newAssignee] }, { by: me.name }));
  }
  return c.json({ conversation: await loadSummary(c.env.DB, ref.conversationId) });
});

// HTTP fallback for sending; the dashboard normally sends over the socket.
conversations.post("/conversations/:cid/messages", async (c) => {
  const ref = await requireConversation(c, c.req.param("cid"));
  const body = await readJson(c.req);
  const message = await sendMessage(c.env, ref, agent(c), {
    clientMsgId: String(body.clientMsgId ?? crypto.randomUUID()),
    body: String(body.body ?? ""),
    attachments: Array.isArray(body.attachments) ? object(body, "attachments") : [],
    internal: body.internal === true,
  });
  return c.json({ message });
});

conversations.get("/conversations/:cid/ws", async (c) => {
  const ref = await requireConversation(c, c.req.param("cid"));
  return connectConversation(c.env, c.req.raw, ref, agent(c));
});
