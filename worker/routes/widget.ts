import { Hono } from "hono";
import { SOCKET_PROTOCOL, type Attachment, type CsatRating } from "../../shared/protocol.ts";
import { parseRating } from "../../shared/inbox.ts";
import type { ConversationRef, Participant } from "../conversation.ts";
import { forVisitor, loadMessages, loadSummary, SUMMARY_SELECT, toSummary, type SummaryRow } from "../lib/conversations.ts";
import { createVisitor, findVisitor, identify } from "../lib/contacts.ts";
import { newId, sha256 } from "../lib/crypto.ts";
import { originAllowed } from "../lib/origins.ts";
import { IdentityError, verifyIdentityToken } from "../lib/identity.ts";
import { connectConversation, connectVisitorLive, notifyConversationChanged, offeredProtocols, sendMessage } from "../lib/realtime.ts";
import { readJson } from "../lib/validate.ts";
import { HttpError, type AppContext, type AppEnv } from "../types.ts";
import { sanitizeContext, type DebugEvent } from "../../shared/debug.ts";
import { cleanNudge, cleanOpener, GENERIC_NUDGE, GENERIC_OPENER, nudgeCacheKey, nudgeFacts, nudgePrompt, openerFacts, openerPrompt } from "../ai/nudge.ts";
import { forLoader, matchesPath, storedOpeners } from "../../shared/openers.ts";
import { completeText, createModel, loadAiSettings } from "../ai/providers.ts";
import { describeOpening, isOpen, nextOpening, type BusinessHours } from "../../shared/hours.ts";
import { textOn, widgetLook } from "../../shared/appearance.ts";
import { storeUpload } from "./files.ts";
import { isIntentName, type IntentSpec } from "../../shared/intents.ts";
import { loadAgentConfig } from "../ai/config-store.ts";
import { intentSkill } from "../ai/config.ts";
import { islandLine } from "../../shared/island.ts";

// Public API used by the widget frame. Visitors are anonymous contacts identified by a
// random token their browser keeps (sent as `X-Visitor-Token`, or as the second
// WebSocket subprotocol so it never appears in a URL).

interface WidgetInbox {
  inboxId: string;
  workspaceId: string;
  workspaceName: string;
  settings: Record<string, unknown>;
  identitySecret: string | null;
}

async function widgetInbox(c: AppContext): Promise<WidgetInbox> {
  const row = await c.env.DB.prepare(
    `SELECT i.id AS inboxId, i.workspace_id AS workspaceId, w.name AS workspaceName, i.settings, i.identity_secret AS identitySecret
     FROM inboxes i JOIN workspaces w ON w.id = i.workspace_id WHERE i.widget_key = ?`,
  )
    .bind(c.req.param("key"))
    .first<{ inboxId: string; workspaceId: string; workspaceName: string; settings: string; identitySecret: string | null }>();
  if (!row) throw new HttpError(404, "unknown_widget", "Unknown widget key.");
  return { ...row, settings: JSON.parse(row.settings) as Record<string, unknown> };
}

/** Domain restriction: is this request from a website allowed to use the widget? */
function fromAllowedSite(c: AppContext, inbox: WidgetInbox): boolean {
  const domains = Array.isArray(inbox.settings.allowedDomains) ? (inbox.settings.allowedDomains as string[]) : [];
  return originAllowed(c.req.header("origin"), domains, new URL(c.req.url).origin);
}

async function visitor(c: AppContext, inbox: WidgetInbox, token = c.req.header("x-visitor-token")): Promise<{ contactId: string }> {
  if (!token) throw new HttpError(401, "no_visitor", "Missing visitor token.");
  const found = await findVisitor(c.env.DB, inbox.workspaceId, token);
  if (!found) throw new HttpError(401, "unknown_visitor", "Unknown visitor.");
  return { contactId: found.contactId };
}

async function visitorConversation(c: AppContext, inbox: WidgetInbox, contactId: string): Promise<ConversationRef> {
  const conversationId = c.req.param("cid")!;
  const row = await c.env.DB.prepare("SELECT 1 FROM conversations WHERE id = ? AND contact_id = ? AND inbox_id = ?")
    .bind(conversationId, contactId, inbox.inboxId)
    .first();
  if (!row) throw new HttpError(404, "not_found", "Conversation not found.");
  return { conversationId, workspaceId: inbox.workspaceId };
}

function sendInput(body: Record<string, unknown>) {
  return {
    clientMsgId: String(body.clientMsgId ?? ""),
    body: typeof body.body === "string" ? body.body : "",
    attachments: Array.isArray(body.attachments) ? (body.attachments as Attachment[]) : [],
    // Debug snapshot from the loader (P1); sanitized by the Conversation object.
    context: body.context,
    // AI-21: the page's actions; sanitized by the Conversation object.
    ...(body.actions !== undefined ? { actions: body.actions } : {}),
  };
}

export const widget = new Hono<AppEnv>();

// Public look and status of the widget. The loader reads it on customers' sites (colour,
// position), so it allows any origin; nothing here is secret.
widget.get("/widget/:key/config", async (c) => {
  const inbox = await widgetInbox(c);
  const s = inbox.settings;
  const hours = s.hours as BusinessHours | undefined;
  const now = Date.now();
  const open = isOpen(hours, now);
  const next = open ? null : nextOpening(hours, now);
  const base = `/api/widget/${encodeURIComponent(c.req.param("key"))}`;
  const logoUrl = typeof s.logoKey === "string" ? `${base}/logo?v=${s.logoKey}` : null;
  const logoDarkUrl = typeof s.logoDarkKey === "string" ? `${base}/logo-dark?v=${s.logoDarkKey}` : null;
  const look = widgetLook(s, inbox.workspaceName, logoUrl, logoDarkUrl);
  // The loader's data-color attribute overrides the colour on that site; it sends it as ?color=.
  const override = c.req.query("color");
  return c.json(
    {
      // W-04 appearance: name, greeting, colour, side, logo, theme, rounding, launcher, placeholder, suggestions.
      ...look,
      // Readable text on the button's colour (the loader keeps no colour maths of its own).
      text: textOn(override && /^#[0-9a-f]{6}$/i.test(override) ? override : look.color),
      // P-01: offer help when the page has an error (on unless turned off).
      proactive: s.proactive !== false,
      // P-01 page openers: only the pattern (as a regex), the delay and an id; text and hints stay on the desk.
      openers: s.proactive === false ? [] : forLoader(storedOpeners(s.openers)),
      // W-12: ask for a rating when a conversation is resolved (on unless turned off).
      csat: s.csat !== false,
      /** Whether new chats are answered by the AI first (the widget shows its typing dots right away). */
      ai: (await loadAiSettings(c.env, inbox.workspaceId)).enabled,
      // I-10: shown in the widget header ("Back tomorrow at 09:00 (London time)").
      hours: hours?.enabled ? { open, back: next && hours ? describeOpening(next, hours.timezone, now) : null } : null,
    },
    200,
    { "Access-Control-Allow-Origin": "*", "Cache-Control": "public, max-age=60" },
  );
});

// W-04: the workspace logo shown in the widget header; W-21: the one for dark surfaces.
for (const [path, setting] of [["logo", "logoKey"], ["logo-dark", "logoDarkKey"]] as const) {
  widget.get(`/widget/:key/${path}`, async (c) => {
    const inbox = await widgetInbox(c);
    const key = inbox.settings[setting];
    if (typeof key !== "string") throw new HttpError(404, "not_found", "No logo.");
    const object = await c.env.FILES.get(key);
    if (!object) throw new HttpError(404, "not_found", "No logo.");
    return new Response(object.body, {
      headers: {
        "Content-Type": object.httpMetadata?.contentType ?? "application/octet-stream",
        // The URL changes (?v=) whenever the logo does.
        "Cache-Control": "public, max-age=86400",
        "X-Content-Type-Options": "nosniff",
        "Content-Security-Policy": "default-src 'none'",
        "Access-Control-Allow-Origin": "*",
      },
    });
  });
}

// S-11 / P-01: the loader saw something break and asks what to offer. The AI phrases it from
// the masked failure ("Looks like the usage chart didn't load. Want a hand?"); the generic line
// when the AI is off, over its cap or slow. Called cross-origin from customers' sites.
const NUDGE_CACHE_S = 24 * 60 * 60;
// ChatGPT plan models take ~4 s for this line and sometimes over 6 s from the edge (2026-10-05);
// the loader waits, and the line is cached per failure and page for a day.
const NUDGE_TIMEOUT_MS = 10_000;

widget.post("/widget/:key/nudge", async (c) => {
  const cors = { "Access-Control-Allow-Origin": "*", "Cache-Control": "no-store" };
  const inbox = await widgetInbox(c).catch(() => null);
  if (!inbox || inbox.settings.proactive === false || !fromAllowedSite(c, inbox)) return c.json({ show: false }, 200, cors);
  let raw: Record<string, unknown> = {};
  try {
    raw = JSON.parse(await c.req.text()) as Record<string, unknown>;
  } catch {
    return c.json({ show: false }, 200, cors);
  }
  const opener = raw.event && typeof raw.event === "object" && (raw.event as { kind?: unknown }).kind === "opener" ? (raw.event as { id?: unknown }) : null;
  // Masked again here, whatever the loader sent.
  const context = sanitizeContext({ page: raw.page, events: raw.event && !opener ? [raw.event] : [] });

  // P-01 page opener: the loader saw a rule's page and delay; check the rule and the page again.
  if (opener) {
    const rule = storedOpeners(inbox.settings.openers).find((r) => r.id === opener.id);
    let path = "";
    try {
      path = new URL(context?.page.url ?? "").pathname;
    } catch {
      path = "";
    }
    if (!rule || !path || !matchesPath(rule.path, path)) return c.json({ show: false }, 200, cors);
    // `page`: the chat shows the line as is (no "tell me what you were trying to do").
    if (rule.text) return c.json({ show: true, text: rule.text, page: true }, 200, cors);
    const page = { path, title: context?.page.title ?? "" };
    const text = await aiLine(c, inbox, `opener|${inbox.workspaceId}|${rule.id}|${rule.hint ?? ""}|${path}|${page.title}`, {
      system: openerPrompt(inbox.workspaceName),
      facts: openerFacts(page, rule.hint),
      clean: cleanOpener,
      fallback: GENERIC_OPENER,
    });
    return c.json({ show: true, text, page: true }, 200, cors);
  }

  const event: DebugEvent | undefined = context?.events[0];
  if (!context || !event) return c.json({ show: true, text: GENERIC_NUDGE }, 200, cors);
  const text = await aiLine(c, inbox, nudgeCacheKey(inbox.workspaceId, event, context.page), {
    system: nudgePrompt(inbox.workspaceName),
    facts: nudgeFacts(event, context.page),
    // Numbers the visitor can see (the app's message, a button's label) may appear in the line.
    clean: (line) => cleanNudge(line, event.kind === "app_error" ? event.message : event.kind === "rage_click" ? event.target?.text : undefined),
    fallback: GENERIC_NUDGE,
  });
  return c.json({ show: true, text }, 200, cors);
});

/**
 * One proactive line from the AI (S-11 nudge, P-01 opener): cached per key for a day; the
 * fallback when the AI is off, over its cap, slow, or writes something unusable.
 */
async function aiLine(
  c: AppContext,
  inbox: WidgetInbox,
  cacheKey: string,
  line: { system: string; facts: string; clean: (text: string) => string | null; fallback: string },
): Promise<string> {
  const settings = await loadAiSettings(c.env, inbox.workspaceId);
  const month = new Date().toISOString().slice(0, 7);
  const usage = await c.env.DB.prepare("SELECT replies FROM ai_usage WHERE workspace_id = ? AND month = ?").bind(inbox.workspaceId, month).first<{ replies: number }>();
  if (!settings.enabled || (usage?.replies ?? 0) >= settings.monthlyReplyCap) return line.fallback;

  // The same failure (or opener) on the same page gets the same line: one model call per day, not per visitor.
  const cacheUrl = `https://nudge.jun-desk.internal/${await sha256(cacheKey)}`;
  const cache = (globalThis as unknown as { caches?: { default: Cache } }).caches?.default;
  const cached = await cache?.match(cacheUrl);
  if (cached) return cached.text();

  try {
    const model = createModel(c.env, inbox.workspaceId, settings, "nudge");
    const result = await completeText({
      model: model.model,
      ...model.prompt(line.system),
      messages: [{ role: "user", content: line.facts }],
      maxOutputTokens: 400, // reasoning models spend part of this before the line
      temperature: 0.2,
      abortSignal: AbortSignal.timeout(NUDGE_TIMEOUT_MS),
    });
    const cleaned = line.clean(result.text);
    // Logged so a too-strict filter shows up in `wrangler tail` (the line is already masked).
    if (!cleaned) console.warn("proactive line filtered, using the fallback:", JSON.stringify(result.text.slice(0, 200)));
    const text = cleaned ?? line.fallback;
    c.executionCtx.waitUntil(
      Promise.all([
        cache?.put(cacheUrl, new Response(text, { headers: { "Cache-Control": `max-age=${NUDGE_CACHE_S}` } })),
        // Tokens count toward usage; proactive lines aren't replies, so they don't use up the reply cap.
        c.env.DB.prepare(
          `INSERT INTO ai_usage (workspace_id, month, replies, input_tokens, output_tokens) VALUES (?1, ?2, 0, ?3, ?4)
           ON CONFLICT (workspace_id, month) DO UPDATE SET input_tokens = input_tokens + ?3, output_tokens = output_tokens + ?4`,
        )
          .bind(inbox.workspaceId, month, result.totalUsage.inputTokens ?? 0, result.totalUsage.outputTokens ?? 0)
          .run(),
      ]),
    );
    return text;
  } catch (error) {
    console.warn("proactive line failed, using the fallback:", (error as Error).message);
    return line.fallback;
  }
}

widget.post("/widget/:key/visitor", async (c) => {
  const inbox = await widgetInbox(c);
  return c.json(await createVisitor(c.env.DB, inbox.workspaceId));
});

// V-03/V-04: the host page's signed-in user, proven by a JWT from the host app's backend.
// Returns the browser's visitor token for that user (it may change; the frame stores it).
widget.post("/widget/:key/identify", async (c) => {
  const inbox = await widgetInbox(c);
  if (!inbox.identitySecret) throw new HttpError(400, "identity_not_configured", "Identity verification isn't set up for this desk (Settings → Install).");
  const body = await readJson(c.req);
  if (typeof body.userToken !== "string") throw new HttpError(400, "invalid_field", "userToken is required.");
  let identity;
  try {
    identity = await verifyIdentityToken(body.userToken, inbox.identitySecret);
  } catch (error) {
    if (error instanceof IdentityError) throw new HttpError(401, "bad_identity", error.message);
    throw error;
  }
  const result = await identify(c.env.DB, inbox.workspaceId, identity, c.req.header("x-visitor-token") ?? null);
  // AI-24: the user's own keys for actions, until this token expires (none in it: none kept).
  await c.env.WORKSPACE_HUB.getByName(inbox.workspaceId).setUserSecrets(result.contactId, identity.secrets, identity.expiresAt);
  // Merged conversations now belong to the user: refresh them in agents' inboxes.
  c.executionCtx.waitUntil(Promise.all(result.movedConversations.map((id) => notifyConversationChanged(c.env, { conversationId: id, workspaceId: inbox.workspaceId }))));
  return c.json({ token: result.token, contactId: result.contactId });
});

// AI-24: the host app's user signed out (JunDesk.logout()): forget their own keys for actions now,
// not only when their identity token expires.
widget.post("/widget/:key/logout", async (c) => {
  const inbox = await widgetInbox(c);
  const { contactId } = await visitor(c, inbox);
  await c.env.WORKSPACE_HUB.getByName(inbox.workspaceId).setUserSecrets(contactId, null);
  return c.json({ ok: true });
});

// V-01: the loader's live connection (page views, identity) to the workspace hub. Unlike the
// frame's sockets this comes from the customer's site, so any origin may connect; it can only
// report itself and receive invites addressed to its own session.
widget.get("/widget/:key/live", async (c) => {
  const inbox = await widgetInbox(c);
  if (!fromAllowedSite(c, inbox)) throw new HttpError(403, "site_not_allowed", "This website isn't allowed to use this widget (Settings → Install → Allowed websites).");
  const sessionId = c.req.query("s") ?? "";
  if (!/^[A-Za-z0-9_-]{8,64}$/.test(sessionId)) throw new HttpError(400, "invalid_field", "Bad session id.");
  // T-11: the first time the widget runs on a real site (not the desk's demo page), note it
  // so "Install on your site" ticks itself off.
  const origin = c.req.header("origin");
  if (origin && origin !== new URL(c.req.url).origin && typeof inbox.settings.installedAt !== "number") {
    c.executionCtx.waitUntil(
      c.env.DB.prepare("UPDATE inboxes SET settings = json_set(settings, '$.installedAt', ?, '$.installedOn', ?) WHERE id = ? AND json_extract(settings, '$.installedAt') IS NULL")
        .bind(Date.now(), origin.slice(0, 200), inbox.inboxId)
        .run(),
    );
  }
  const cf = (c.req.raw as Request & { cf?: { country?: string; city?: string; latitude?: string; longitude?: string } }).cf;
  const lat = Number(cf?.latitude);
  const lng = Number(cf?.longitude);
  const round = (n: number) => Math.round(n * 10) / 10;
  return connectVisitorLive(c.env, c.req.raw, inbox.workspaceId, {
    sessionId,
    inboxId: inbox.inboxId,
    country: cf?.country ?? null,
    city: cf?.city ?? null,
    location: cf?.latitude && cf.longitude && Number.isFinite(lat) && Number.isFinite(lng) ? [round(lat), round(lng)] : null,
    userAgent: (c.req.header("user-agent") ?? "").slice(0, 300),
  });
});

widget.get("/widget/:key/conversations", async (c) => {
  const inbox = await widgetInbox(c);
  const { contactId } = await visitor(c, inbox);
  const rows = await c.env.DB.prepare(`${SUMMARY_SELECT} WHERE c.contact_id = ? AND c.inbox_id = ? ORDER BY c.last_message_at DESC LIMIT 50`)
    .bind(contactId, inbox.inboxId)
    .all<SummaryRow>();
  const conversations = rows.results.map((r) => forVisitor(toSummary(r)));
  // D-80: the folded island's line for the ongoing chat (a waiting card, else the last reply), so it
  // shows on a page load without the widget fetching the history. Only its latest messages are read.
  const ongoing = conversations.find((s) => s.status !== "resolved");
  if (ongoing) ongoing.islandLine = islandLine(await loadMessages(c.env.DB, ongoing.id, { limit: 30, includeInternal: false }), Date.now());
  return c.json({ conversations });
});

// Starts a conversation with its first message. With `inviteId` (V-07), the agent's invite
// becomes the first message and the conversation goes to that agent instead of the AI.
widget.post("/widget/:key/conversations", async (c) => {
  const inbox = await widgetInbox(c);
  const { contactId } = await visitor(c, inbox);
  const body = await readJson(c.req);
  const input = sendInput(body);
  if (!input.body.trim() && input.attachments.length === 0) throw new HttpError(400, "empty", "Message is empty.");
  const sessionId = typeof body.sessionId === "string" ? body.sessionId.slice(0, 64) : null;

  const now = Date.now();
  let invite: { id: string; user_id: string; name: string; body: string } | null = null;
  if (typeof body.inviteId === "string") {
    invite = await c.env.DB.prepare(
      `SELECT v.id, v.user_id, u.name, v.body FROM visitor_invites v JOIN users u ON u.id = v.user_id
       WHERE v.id = ? AND v.workspace_id = ? AND v.used_at IS NULL AND v.expires_at > ? AND (? IS NULL OR v.session_id = ?)`,
    )
      .bind(body.inviteId, inbox.workspaceId, now, sessionId, sessionId)
      .first();
    // A stale or foreign invite just starts a normal conversation.
    if (invite) {
      const claimed = await c.env.DB.prepare("UPDATE visitor_invites SET used_at = ? WHERE id = ? AND used_at IS NULL").bind(now, invite.id).run();
      if (claimed.meta.changes === 0) invite = null;
    }
  }

  const ref: ConversationRef = { conversationId: newId("cv"), workspaceId: inbox.workspaceId };
  // The AI answers first when it's enabled; otherwise (or after an agent's invite) the team does.
  const handling = !invite && (await loadAiSettings(c.env, inbox.workspaceId)).enabled ? "ai" : "human";
  // AI-20: the host app opened the chat with an intent (JunDesk.open({ intent })). Recorded even
  // when no skill defines it (the AI is told; agents see it).
  const intent = isIntentName(body.intent) && !invite ? body.intent : null;
  await c.env.DB.prepare(
    `INSERT INTO conversations (id, workspace_id, inbox_id, contact_id, handling, assignee_id, last_message_at, created_at, updated_at, intent)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  )
    .bind(ref.conversationId, inbox.workspaceId, inbox.inboxId, contactId, handling, invite?.user_id ?? null, now, now, now, intent)
    .run();
  const participant: Participant = { role: "visitor", contactId };
  let message;
  try {
    if (invite) {
      await sendMessage(c.env, ref, { role: "agent", userId: invite.user_id, name: invite.name }, { clientMsgId: `invite:${invite.id}`, body: invite.body, attachments: [] });
    }
    message = await sendMessage(c.env, ref, participant, input);
  } catch (error) {
    // Don't leave an empty conversation behind if the first message was rejected.
    await c.env.DB.prepare("DELETE FROM conversations WHERE id = ? AND last_seq = 0").bind(ref.conversationId).run();
    throw error;
  }
  // I-02: straight to the team (AI off): round robin, if the workspace uses it.
  if (handling === "human" && !invite) c.executionCtx.waitUntil(c.env.CONVERSATION.getByName(ref.conversationId).assignIfNeeded(ref));
  // The visitor list shows who is in a chat.
  if (sessionId) c.executionCtx.waitUntil(c.env.WORKSPACE_HUB.getByName(inbox.workspaceId).linkSession(sessionId, contactId));
  const conversation = await loadSummary(c.env.DB, ref.conversationId);
  return c.json({ conversation: conversation && forVisitor(conversation), message });
});

widget.get("/widget/:key/conversations/:cid", async (c) => {
  const inbox = await widgetInbox(c);
  const { contactId } = await visitor(c, inbox);
  const ref = await visitorConversation(c, inbox, contactId);
  const [conversation, messages] = await Promise.all([loadSummary(c.env.DB, ref.conversationId), loadMessages(c.env.DB, ref.conversationId, { includeInternal: false })]);
  return c.json({ conversation: conversation && forVisitor(conversation), messages });
});

widget.post("/widget/:key/conversations/:cid/messages", async (c) => {
  const inbox = await widgetInbox(c);
  const { contactId } = await visitor(c, inbox);
  const ref = await visitorConversation(c, inbox, contactId);
  const message = await sendMessage(c.env, ref, { role: "visitor", contactId }, sendInput(await readJson(c.req)));
  return c.json({ message });
});

// AI-20: how the widget starts a chat the host app opened with an intent: the opening line,
// quick replies and exit label from the skill that defines it. Never an AI call. `intent: null`
// when no skill defines it (the widget then opens a plain chat, still tagged with the intent).
widget.get("/widget/:key/intents/:name", async (c) => {
  const inbox = await widgetInbox(c);
  const name = c.req.param("name");
  if (!isIntentName(name)) throw new HttpError(400, "invalid_field", "Bad intent name.");
  const spec: IntentSpec | null = intentSkill(await loadAgentConfig(c.env, inbox.workspaceId), name)?.intent ?? null;
  c.header("Cache-Control", "no-store");
  return c.json({ intent: spec });
});

// AI-20: the visitor clicked the intent's exit button ("Cancel anyway"). The widget has already
// handed over to the host app's onExit (it never waits for this); here we only record it, once,
// and leave agents a note.
widget.post("/widget/:key/conversations/:cid/exit", async (c) => {
  const inbox = await widgetInbox(c);
  const { contactId } = await visitor(c, inbox);
  const ref = await visitorConversation(c, inbox, contactId);
  const now = Date.now();
  const row = await c.env.DB.prepare("SELECT intent FROM conversations WHERE id = ?").bind(ref.conversationId).first<{ intent: string | null }>();
  if (!row?.intent) throw new HttpError(409, "no_intent", "This conversation wasn't opened with an intent.");
  const updated = await c.env.DB.prepare("UPDATE conversations SET intent_exited_at = ?, updated_at = ? WHERE id = ? AND intent_exited_at IS NULL")
    .bind(now, now, ref.conversationId)
    .run();
  if (updated.meta.changes > 0) {
    const exit = intentSkill(await loadAgentConfig(c.env, inbox.workspaceId), row.intent)?.intent?.exit;
    // The note also refreshes the conversation (and its intent label) in agents' inboxes.
    await c.env.CONVERSATION.getByName(ref.conversationId).addNote(
      ref,
      `The customer clicked ${exit ? `"${exit}"` : "the exit button"} (intent: ${row.intent}) and went on in your app.`,
      `intent-exit:${ref.conversationId}`,
    );
  }
  return c.json({ ok: true });
});

// W-08: whether anyone on the team is online, so the widget knows to ask for an email right away.
widget.get("/widget/:key/online", async (c) => {
  const inbox = await widgetInbox(c);
  c.header("Cache-Control", "no-store");
  return c.json({ online: await c.env.WORKSPACE_HUB.getByName(inbox.workspaceId).agentsOnline() });
});

// W-08: nobody's around, so the visitor leaves an email for the reply. Stored on their contact
// (verified contacts already have theirs from the host app) and noted in the conversation.
widget.post("/widget/:key/conversations/:cid/email", async (c) => {
  const inbox = await widgetInbox(c);
  const { contactId } = await visitor(c, inbox);
  const ref = await visitorConversation(c, inbox, contactId);
  const raw = (await readJson(c.req)).email;
  const email = typeof raw === "string" ? raw.trim().toLowerCase() : "";
  if (email.length > 320 || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) throw new HttpError(400, "invalid_field", "That doesn't look like an email address.");
  const updated = await c.env.DB.prepare("UPDATE contacts SET email = ? WHERE id = ? AND verified_at IS NULL").bind(email, contactId).run();
  if (updated.meta.changes === 0) throw new HttpError(409, "verified", "Your email comes from your account.");
  await c.env.CONVERSATION.getByName(ref.conversationId).addNote(ref, `The customer left their email for a reply: ${email}`, `email:${await sha256(email)}`);
  // Inbox lists show the contact's email: refresh their other conversations too.
  const others = await c.env.DB.prepare("SELECT id FROM conversations WHERE contact_id = ? AND id != ? LIMIT 50").bind(contactId, ref.conversationId).all<{ id: string }>();
  c.executionCtx.waitUntil(Promise.all(others.results.map((r) => notifyConversationChanged(c.env, { conversationId: r.id, workspaceId: inbox.workspaceId }))));
  return c.json({ ok: true, email });
});

// W-12: the visitor rates a resolved conversation, once per resolution (writing again reopens
// it; when it's resolved again they can rate again). Thumbs first: a second call with the same
// rating adds or replaces the comment. Agents get the rating as a note.
widget.post("/widget/:key/conversations/:cid/rating", async (c) => {
  const inbox = await widgetInbox(c);
  const { contactId } = await visitor(c, inbox);
  const ref = await visitorConversation(c, inbox, contactId);
  let input: ReturnType<typeof parseRating>;
  try {
    input = parseRating(await readJson(c.req));
  } catch (error) {
    throw new HttpError(400, "invalid_field", (error as Error).message);
  }
  const { rating, comment } = input;
  if (inbox.settings.csat === false) throw new HttpError(409, "csat_off", "Ratings are turned off for this desk.");

  const db = c.env.DB;
  const row = await db.prepare(
    `SELECT c.status, c.resolution,
            EXISTS (SELECT 1 FROM messages m WHERE m.conversation_id = c.id AND m.internal = 0 AND m.author_type IN ('agent', 'ai')) AS replied
     FROM conversations c WHERE c.id = ?`,
  )
    .bind(ref.conversationId)
    .first<{ status: string; resolution: number; replied: number }>();
  if (row?.status !== "resolved") throw new HttpError(409, "not_resolved", "You can rate this conversation once it's resolved.");
  if (!row.replied) throw new HttpError(409, "nothing_to_rate", "Nobody has replied in this conversation yet.");

  const now = Date.now();
  const id = newId("csat");
  const label = rating === "good" ? "👍 Good" : "👎 Bad";
  // One rating per round: the unique key settles concurrent clicks; the row follows only if this one won.
  const [inserted] = await db.batch([
    db.prepare(
      `INSERT INTO csat_ratings (id, conversation_id, workspace_id, contact_id, resolution, rating, comment, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?) ON CONFLICT (conversation_id, resolution) DO NOTHING`,
    ).bind(id, ref.conversationId, inbox.workspaceId, contactId, row.resolution, rating, comment || null, now, now),
    db.prepare("UPDATE conversations SET csat_rating = ?, csat_at = ?, csat_resolution = ? WHERE id = ? AND EXISTS (SELECT 1 FROM csat_ratings WHERE id = ?)").bind(
      rating,
      now,
      row.resolution,
      ref.conversationId,
      id,
    ),
  ]);
  const note = c.env.CONVERSATION.getByName(ref.conversationId);
  if ((inserted?.meta.changes ?? 0) > 0) {
    await note.addNote(ref, `The customer rated this conversation ${label}${comment ? `: ${comment}` : "."}`, `csat:${row.resolution}`);
  } else {
    // Already rated this round: only a comment on the same rating can follow.
    const existing = await db.prepare("SELECT id, rating, comment FROM csat_ratings WHERE conversation_id = ? AND resolution = ?")
      .bind(ref.conversationId, row.resolution)
      .first<{ id: string; rating: CsatRating; comment: string | null }>();
    if (!existing || !comment || existing.rating !== rating) throw new HttpError(409, "already_rated", "You've already rated this conversation.");
    if (comment !== existing.comment) {
      await db.prepare("UPDATE csat_ratings SET comment = ?, updated_at = ? WHERE id = ?").bind(comment, now, existing.id).run();
      await note.addNote(ref, `The customer commented on their ${label} rating: ${comment}`, `csat:${row.resolution}:${await sha256(comment)}`);
    }
  }
  const conversation = await loadSummary(db, ref.conversationId);
  return c.json({ conversation: conversation && forVisitor(conversation) });
});

widget.get("/widget/:key/conversations/:cid/ws", async (c) => {
  const inbox = await widgetInbox(c);
  // Browsers can't set headers on WebSockets, so the token rides as a subprotocol.
  const token = offeredProtocols(c.req.raw).find((p) => p !== SOCKET_PROTOCOL);
  const { contactId } = await visitor(c, inbox, token);
  const ref = await visitorConversation(c, inbox, contactId);
  return connectConversation(c.env, c.req.raw, ref, { role: "visitor", contactId });
});

widget.post("/widget/:key/files", async (c) => {
  const inbox = await widgetInbox(c);
  const { contactId } = await visitor(c, inbox);
  return c.json({ attachment: await storeUpload(c, inbox.workspaceId, `contact:${contactId}`) });
});
