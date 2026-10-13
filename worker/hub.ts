import { DurableObject } from "cloudflare:workers";
import { MAX_SEEN_PAGE_ACTIONS, type SeenPageAction } from "../shared/actions.ts";
import { ChatGPTAuth, type ChatGPTCredentials, type CredentialStore } from "@jun/llm";
import { pickAssignee } from "../shared/inbox.ts";
import { notificationPayload, notificationRecipients, readNotificationPrefs, type NotificationEvent, type NotificationPayload } from "../shared/notifications.ts";
import { SOCKET_PROTOCOL, type HubClientEvent, type HubEvent, type LiveClientEvent, type LiveServerEvent, type LiveVisitor, type PresenceEntry } from "../shared/protocol.ts";
import { upsertIdentified } from "./lib/contacts.ts";
import { newId } from "./lib/crypto.ts";
import { IdentityError, verifyIdentityToken } from "./lib/identity.ts";
import { generateVapidKeys, pushTopic, sendPush, type PushOutcome, type VapidKeys } from "./lib/webpush.ts";

export const HUB_USER_HEADER = "x-jun-user";
export const HUB_VISITOR_HEADER = "x-jun-visitor";

/** What the Worker tells the hub about a visitor's live connection (after checking the widget key). */
export interface VisitorConnect {
  sessionId: string;
  inboxId: string;
  country: string | null;
  city: string | null;
  location: [number, number] | null;
  userAgent: string;
}

/** Stored on each visitor socket (survives hibernation; must stay under 2 KB). */
interface VisitorAttachment {
  kind: "visitor";
  inboxId: string;
  visitor: LiveVisitor;
  /** Epoch ms; with the last ping, how we tell a live socket from a dead one. */
  connectedAt: number;
}

/** `focused`: the tab is visible and focused (the dashboard reports changes), I-14. */
type AgentAttachment = PresenceEntry & { kind?: "agent"; connectedAt: number; focused?: boolean };

/** I-14: what a Conversation object or route asks the hub to notify about. */
export interface NotifyInput extends NotificationEvent {
  workspaceId: string;
  /** "Ana Lima", "ana@acme.test" or "Visitor #1234". */
  contact: string;
  /** The visitor's latest message, or the note for a mention. */
  text: string;
  /** The teammate who assigned or mentioned. */
  by?: string | null;
}

interface SubscriptionRow { id: string; user_id: string; endpoint: string; p256dh: string; auth: string }

/** Push messages wait up to a day for a device that's offline. */
const PUSH_TTL = 24 * 3600;

/**
 * The loader and the dashboard ping every 30 s (answered automatically, even while this object
 * hibernates). A socket with no ping for this long is gone: a tab closed without a close frame,
 * or a connection cut by a deploy. Without this, ghosts stay "live" forever.
 */
const STALE_MS = 75_000;
/** The sweep only closes sockets and tells agents; listings already skip stale ones. */
const SWEEP_MS = 120_000;

const clip = (value: unknown, max: number): string => (typeof value === "string" ? value.slice(0, max) : "");

/**
 * One instance per workspace. Agents' dashboards keep a socket open here to get inbox
 * updates (from Conversation objects) and to see which teammates are online. The widget
 * loader on customers' sites keeps a socket here too (V-01 live visitors, V-07 invites).
 * It also owns dev-only ChatGPT token refresh: refresh tokens rotate, so exactly one place
 * may refresh them.
 */
/** W-31: the most recently seen website actions, at most MAX_SEEN_PAGE_ACTIONS. */
function trimSeen(seen: Record<string, SeenPageAction>): Record<string, SeenPageAction> {
  return Object.fromEntries(Object.entries(seen).sort(([, a], [, b]) => b.seenAt - a.seenAt).slice(0, MAX_SEEN_PAGE_ACTIONS));
}

export class WorkspaceHub extends DurableObject<Env> {
  #chatgpt: ChatGPTAuth | undefined;
  #vapid: Promise<VapidKeys> | undefined;
  /** The sweep alarm is set (saves a storage read per connect; after eviction, setting it again is harmless). */
  #sweepArmed = false;
  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    ctx.setWebSocketAutoResponse(new WebSocketRequestResponsePair("ping", "pong"));
  }

  override async fetch(request: Request): Promise<Response> {
    if (request.headers.get("upgrade")?.toLowerCase() !== "websocket") return new Response("Expected WebSocket", { status: 426 });
    const { 0: client, 1: server } = new WebSocketPair();

    const visitorHeader = request.headers.get(HUB_VISITOR_HEADER);
    if (visitorHeader) {
      const info = JSON.parse(visitorHeader) as VisitorConnect;
      const now = Date.now();
      const attachment: VisitorAttachment = {
        kind: "visitor",
        inboxId: info.inboxId,
        visitor: {
          sessionId: info.sessionId,
          contact: null,
          page: { url: "", title: "" },
          referrer: null,
          pages: 0,
          startedAt: now,
          country: info.country,
          city: info.city,
          location: info.location ?? null,
          userAgent: info.userAgent.slice(0, 200),
          language: null,
          timezone: null,
          inChat: false,
        },
        connectedAt: now,
      };
      await this.#accept(server, ["visitor", `s:${info.sessionId}`], attachment);
      // Announced to agents on its first page event, which carries the page. The loader offers
      // no subprotocol; echo ours if a client offers it (clients reject a missing echo).
      const offered = (request.headers.get("sec-websocket-protocol") ?? "").split(",").map((p) => p.trim());
      return new Response(null, { status: 101, webSocket: client, ...(offered.includes(SOCKET_PROTOCOL) ? { headers: { "Sec-WebSocket-Protocol": SOCKET_PROTOCOL } } : {}) });
    }

    const user = JSON.parse(request.headers.get(HUB_USER_HEADER)!) as PresenceEntry;
    await this.#accept(server, ["agent"], { ...user, kind: "agent", connectedAt: Date.now() } satisfies AgentAttachment);
    this.#send(server, { type: "visitors", visitors: this.#visitors() });
    this.#broadcastPresence();
    return new Response(null, { status: 101, webSocket: client, headers: { "Sec-WebSocket-Protocol": SOCKET_PROTOCOL } });
  }

  /** RPC: a valid ChatGPT access token for this workspace (dev only), refreshing if needed. */
  async chatgptAccessToken(workspaceId: string, forceRefresh: boolean): Promise<string> {
    if (!this.#chatgpt) {
      const db = this.env.DB;
      const store: CredentialStore = {
        async load() {
          const row = await db.prepare("SELECT credentials FROM dev_chatgpt WHERE workspace_id = ?").bind(workspaceId).first<{ credentials: string }>();
          return row ? (JSON.parse(row.credentials) as ChatGPTCredentials) : undefined;
        },
        async save(credentials) {
          await db
            .prepare("INSERT INTO dev_chatgpt (workspace_id, credentials) VALUES (?, ?) ON CONFLICT (workspace_id) DO UPDATE SET credentials = excluded.credentials")
            .bind(workspaceId, JSON.stringify(credentials))
            .run();
        },
      };
      this.#chatgpt = new ChatGPTAuth(store);
    }
    return this.#chatgpt.getAccessToken({ forceRefresh });
  }

  /** RPC: forget the cached auth after credentials change. */
  async resetChatGPT(): Promise<void> {
    this.#chatgpt = undefined;
  }

  /**
   * RPC (S-08): an issue-tracker credential pasted in Settings. Kept in this object's storage,
   * not D1, so it's never in database exports, backups or the D1 console.
   */
  async trackerSecret(name: "github" | "linear"): Promise<string | null> {
    return (await this.ctx.storage.get<string>(`tracker-secret:${name}`)) ?? null;
  }

  /** RPC (S-08): save or (null) remove a tracker credential. */
  async setTrackerSecret(name: "github" | "linear", value: string | null): Promise<void> {
    if (value) await this.ctx.storage.put(`tracker-secret:${name}`, value);
    else await this.ctx.storage.delete(`tracker-secret:${name}`);
  }

  /**
   * RPC (AI-24): the keys actions use ({secrets.NAME}) that an admin pasted on the Agent page, by
   * name. Kept here like the tracker secrets: never D1, never returned by the API.
   */
  async actionSecrets(): Promise<Record<string, string>> {
    const stored = await this.ctx.storage.list<string>({ prefix: "action-secret:" });
    return Object.fromEntries([...stored].map(([key, value]) => [key.slice("action-secret:".length), value]));
  }

  /** RPC (AI-24): save or (null) remove an action key. */
  async setActionSecret(name: string, value: string | null): Promise<void> {
    if (value) await this.ctx.storage.put(`action-secret:${name}`, value);
    else await this.ctx.storage.delete(`action-secret:${name}`);
  }

  /**
   * RPC (W-31): website actions offered on the customer's site, as the Conversation objects saw them
   * (name, description, the card the page names, inputs); `seenAt` is refreshed, the list capped.
   */
  async notePageActions(actions: Omit<SeenPageAction, "seenAt" | "shape">[]): Promise<void> {
    const seen = (await this.ctx.storage.get<Record<string, SeenPageAction>>("page-actions")) ?? {};
    const now = Date.now();
    for (const a of actions) {
      const next: SeenPageAction = { ...seen[a.name], ...a, seenAt: now };
      if (!a.widget) delete next.widget;
      seen[a.name] = next;
    }
    await this.ctx.storage.put("page-actions", trimSeen(seen));
  }

  /** RPC (W-31): the shape of a website action's latest result (field names and types, never values). */
  async notePageActionShape(name: string, shape: Record<string, unknown>): Promise<void> {
    const seen = (await this.ctx.storage.get<Record<string, SeenPageAction>>("page-actions")) ?? {};
    const current = seen[name];
    if (!current || JSON.stringify(current.shape) === JSON.stringify(shape)) return;
    seen[name] = { ...current, shape };
    await this.ctx.storage.put("page-actions", seen);
  }

  /** RPC (W-31): the website actions seen, most recent first. */
  async pageActions(): Promise<SeenPageAction[]> {
    const seen = (await this.ctx.storage.get<Record<string, SeenPageAction>>("page-actions")) ?? {};
    return Object.values(seen).sort((a, b) => b.seenAt - a.seenAt);
  }

  /**
   * RPC (AI-24): a signed-in customer's own keys ({user.secrets.NAME}), from the `secrets` claim of
   * their identity token, until that token expires. Never D1, never shown to agents or the AI.
   */
  async userSecrets(contactId: string): Promise<Record<string, string> | null> {
    const stored = await this.ctx.storage.get<{ values: Record<string, string>; expiresAt: number }>(`user-secrets:${contactId}`);
    if (!stored) return null;
    if (stored.expiresAt <= Date.now()) {
      await this.ctx.storage.delete(`user-secrets:${contactId}`);
      return null;
    }
    return stored.values;
  }

  /** RPC (AI-24): the customer's latest identity token decides: its keys, or none (also on sign-out). */
  async setUserSecrets(contactId: string, values: Record<string, string> | null, expiresAt = 0): Promise<void> {
    if (values && Object.keys(values).length && expiresAt > Date.now()) await this.ctx.storage.put(`user-secrets:${contactId}`, { values, expiresAt });
    else await this.ctx.storage.delete(`user-secrets:${contactId}`);
  }

  /**
   * I-14: this workspace's VAPID key pair (RFC 8292), created on first use. The private key never
   * leaves this object's storage (not D1, not the API), like the tracker secrets above.
   */
  #vapidKeys(): Promise<VapidKeys> {
    if (!this.#vapid) {
      const loading = (async () => {
        const stored = await this.ctx.storage.get<VapidKeys>("push:vapid");
        if (stored) return stored;
        const keys = await generateVapidKeys();
        // Another call may have stored one while we generated: keep the first.
        const raced = await this.ctx.storage.get<VapidKeys>("push:vapid");
        if (raced) return raced;
        await this.ctx.storage.put("push:vapid", keys);
        return keys;
      })();
      this.#vapid = loading;
      loading.catch(() => {
        if (this.#vapid === loading) this.#vapid = undefined;
      });
    }
    return this.#vapid;
  }

  /**
   * RPC (I-14): the public key browsers subscribe with. `origin` is the desk's URL, remembered as
   * the VAPID contact ("sub") push services may use to reach whoever runs this desk.
   */
  async vapidPublicKey(origin: string): Promise<string> {
    if ((await this.ctx.storage.get<string>("push:subject")) !== origin) await this.ctx.storage.put("push:subject", origin);
    return (await this.#vapidKeys()).publicKey;
  }

  /**
   * RPC (I-14): notify the teammates an event concerns. Each gets a `notify` event on their own
   * sockets; those without a focused desk tab also get Web Push on every device they turned it on.
   * Callers run this with waitUntil: nothing user-facing waits for push services.
   */
  async notify(input: NotifyInput): Promise<void> {
    const members = await this.env.DB.prepare("SELECT user_id, notification_prefs FROM members WHERE workspace_id = ?")
      .bind(input.workspaceId)
      .all<{ user_id: string; notification_prefs: string }>();
    const prefs = new Map(members.results.map((m) => [m.user_id, readNotificationPrefs(m.notification_prefs)]));
    const recipients = notificationRecipients(input, [...prefs].map(([userId, p]) => ({ userId, prefs: p })));
    if (recipients.length === 0) return;
    const payload = notificationPayload({
      id: newId("ntf"),
      kind: input.kind,
      conversationId: input.conversationId,
      contact: input.contact,
      text: input.text,
      by: input.by ?? null,
      ...(input.auto ? { auto: true } : {}),
    });

    // Only the recipient's own sockets hear about it (other teammates get the usual inbox events).
    const sockets = this.#live<AgentAttachment>("agent").filter(([, a]) => recipients.includes(a.userId));
    const focused = new Set(sockets.filter(([, a]) => a.focused).map(([, a]) => a.userId));
    for (const [ws, a] of sockets) this.#send(ws, { type: "notify", notification: payload, mode: focused.has(a.userId) ? "toast" : "system", sound: prefs.get(a.userId)?.sound !== false });
    await this.#push(input.workspaceId, recipients.filter((id) => !focused.has(id)), payload);
  }

  /** RPC (I-14): "Send a test notification" to one of the user's own devices. Null if it isn't theirs. */
  async testPush(workspaceId: string, userId: string, subscriptionId: string): Promise<{ status: number; outcome: PushOutcome } | null> {
    const row = await this.env.DB.prepare("SELECT id, user_id, endpoint, p256dh, auth FROM push_subscriptions WHERE id = ? AND workspace_id = ? AND user_id = ?")
      .bind(subscriptionId, workspaceId, userId)
      .first<SubscriptionRow>();
    if (!row) return null;
    const payload: NotificationPayload = { id: newId("ntf"), kind: "test", title: "Notifications are on", body: "This device will tell you when a chat needs you.", url: "/settings", tag: "jun-test" };
    const [result] = await this.#sendAll([row], payload);
    return result!;
  }

  async #push(workspaceId: string, userIds: string[], payload: NotificationPayload): Promise<void> {
    if (userIds.length === 0) return;
    const rows = await this.env.DB.prepare(`SELECT id, user_id, endpoint, p256dh, auth FROM push_subscriptions WHERE workspace_id = ? AND user_id IN (${userIds.map(() => "?").join(",")})`)
      .bind(workspaceId, ...userIds)
      .all<SubscriptionRow>();
    if (rows.results.length) await this.#sendAll(rows.results, payload);
  }

  /** Sends to each subscription in parallel and records the outcome: 404/410 forget it, other failures count. */
  async #sendAll(rows: SubscriptionRow[], payload: NotificationPayload): Promise<{ status: number; outcome: PushOutcome }[]> {
    const keys = await this.#vapidKeys();
    const subject = (await this.ctx.storage.get<string>("push:subject")) ?? "mailto:admin@localhost";
    // A newer undelivered push for the same conversation replaces the older one at the push service.
    const topic = await pushTopic(payload.tag);
    const body = JSON.stringify(payload);
    const results = await Promise.all(rows.map((row) => sendPush(row, body, { keys, subject }, { ttl: PUSH_TTL, urgency: "high", topic })));
    const now = Date.now();
    const db = this.env.DB;
    await db.batch(
      rows.map((row, i) => {
        const { outcome, status } = results[i]!;
        if (outcome !== "ok") console.warn(`push to ${new URL(row.endpoint).host} failed: ${status || "network error"}`);
        return outcome === "ok" ? db.prepare("UPDATE push_subscriptions SET last_success_at = ?, failures = 0 WHERE id = ?").bind(now, row.id)
          : outcome === "gone" ? db.prepare("DELETE FROM push_subscriptions WHERE id = ?").bind(row.id)
          : db.prepare("UPDATE push_subscriptions SET failures = failures + 1 WHERE id = ?").bind(row.id);
      }),
    );
    return results;
  }

  /** RPC: fan an event out to every connected agent. */
  async publish(event: HubEvent): Promise<void> {
    this.#broadcast(JSON.stringify(event));
  }

  /** RPC (I-02): teammates with a dashboard open right now. */
  async onlineAgentIds(): Promise<string[]> {
    return [...new Set(this.#live<AgentAttachment>("agent").map(([, a]) => a.userId))];
  }

  /**
   * RPC (I-02): the round-robin turn. Picks from `candidates` (online, with their open-chat
   * counts) and records the turn, all inside this object, so simultaneous handoffs never pick
   * from the same stale order.
   */
  async claimNextAssignee(candidates: { userId: string; open: number }[], capacity: number): Promise<string | null> {
    const times = await this.ctx.storage.get<Record<string, number>>("assignment:last") ?? {};
    const picked = pickAssignee(candidates.map((c) => ({ ...c, lastAssignedAt: times[c.userId] ?? 0 })), capacity);
    if (picked) await this.ctx.storage.put("assignment:last", { ...times, [picked]: Date.now() });
    return picked;
  }

  /**
   * RPC (A-02): may a lazy topic-labelling pass start? True (and recorded) unless one started in
   * the last `minIntervalMs`; checked and set inside this object, so two callers never both win.
   */
  async claimTopicRun(minIntervalMs: number): Promise<boolean> {
    const last = (await this.ctx.storage.get<number>("topics:last-run")) ?? 0;
    const now = Date.now();
    if (now - last < minIntervalMs) return false;
    await this.ctx.storage.put("topics:last-run", now);
    return true;
  }

  /** RPC (W-08): is any teammate's dashboard open? Visitors only ever get this yes/no. */
  async agentsOnline(): Promise<boolean> {
    return this.#live("agent").length > 0;
  }

  /** RPC (V-07): deliver an agent's invite to a live visitor. False if they've left. */
  async invite(sessionId: string, invite: { id: string; body: string; from: string }): Promise<boolean> {
    const sockets = this.#live(`s:${sessionId}`);
    for (const [ws] of sockets) this.#send(ws, { t: "invite", ...invite } satisfies LiveServerEvent);
    return sockets.length > 0;
  }

  /** RPC: a live visitor started a chat; the list shows it (and who they are, if anonymous). */
  async linkSession(sessionId: string, contactId: string): Promise<void> {
    for (const [ws, a] of this.#live<VisitorAttachment>(`s:${sessionId}`)) {
      a.visitor.inChat = true;
      a.visitor.contact ??= { id: contactId, name: null, email: null, verified: false };
      ws.serializeAttachment(a);
      this.#broadcast(JSON.stringify({ type: "visitor", visitor: a.visitor } satisfies HubEvent));
    }
  }

  override async webSocketMessage(ws: WebSocket, raw: string | ArrayBuffer): Promise<void> {
    const a = ws.deserializeAttachment() as VisitorAttachment | AgentAttachment | null;
    if (!a || typeof raw !== "string" || raw.length > 8000) return;
    if (a.kind !== "visitor") {
      // Agents only say whether their tab is focused (I-14); pings are auto-answered.
      let event: HubClientEvent;
      try {
        event = JSON.parse(raw) as HubClientEvent;
      } catch {
        return;
      }
      if (event?.type === "focus" && typeof event.focused === "boolean" && a.focused !== event.focused) ws.serializeAttachment({ ...a, focused: event.focused });
      return;
    }
    let event: LiveClientEvent;
    try {
      event = JSON.parse(raw) as LiveClientEvent;
    } catch {
      return;
    }
    const v = a.visitor;
    if (event.t === "page") {
      v.page = { url: clip(event.url, 300), title: clip(event.title, 120) };
      v.pages++;
      if (v.pages === 1) {
        v.referrer = clip(event.ref, 200) || null;
        if (typeof event.start === "number" && event.start <= Date.now() && event.start > Date.now() - 86_400_000) v.startedAt = event.start;
        v.language = clip(event.lang, 20) || null;
        v.timezone = clip(event.tz, 60) || null;
      }
    } else if (event.t === "id") {
      const result = await this.#identify(a.inboxId, clip(event.token, 4000));
      this.#send(ws, { t: "id", ok: result.ok, ...(result.ok ? {} : { error: result.error }) } satisfies LiveServerEvent);
      if (!result.ok) return;
      v.contact = { ...result.contact, verified: true };
    } else {
      return;
    }
    ws.serializeAttachment(a);
    if (v.pages > 0) this.#broadcast(JSON.stringify({ type: "visitor", visitor: v } satisfies HubEvent));
  }

  async #identify(inboxId: string, token: string): Promise<{ ok: true; contact: { id: string; name: string | null; email: string | null } } | { ok: false; error: string }> {
    const inbox = await this.env.DB.prepare("SELECT workspace_id, identity_secret FROM inboxes WHERE id = ?").bind(inboxId).first<{ workspace_id: string; identity_secret: string | null }>();
    if (!inbox?.identity_secret) return { ok: false, error: "Identity verification isn't set up for this desk." };
    try {
      const identity = await verifyIdentityToken(token, inbox.identity_secret);
      const id = await upsertIdentified(this.env.DB, inbox.workspace_id, identity);
      await this.setUserSecrets(id, identity.secrets, identity.expiresAt);
      return { ok: true, contact: { id, name: identity.name, email: identity.email } };
    } catch (error) {
      if (error instanceof IdentityError) return { ok: false, error: error.message };
      throw error;
    }
  }

  override async webSocketError(ws: WebSocket): Promise<void> {
    await this.webSocketClose(ws);
  }

  /** While anyone is connected: close sockets that stopped pinging, as if they had closed. */
  override async alarm(): Promise<void> {
    this.#sweepArmed = false;
    for (const ws of this.ctx.getWebSockets()) {
      if (ws.readyState !== WebSocket.OPEN || this.#alive(ws, ws.deserializeAttachment() as { connectedAt?: number } | null)) continue;
      try {
        ws.close(1001, "No ping");
      } catch {
        // already closing
      }
      await this.webSocketClose(ws);
    }
    if (this.ctx.getWebSockets().length > 0) await this.#armSweep();
  }

  /** Accepts a hibernatable socket with its attachment and makes sure the sweep is running. */
  async #accept(server: WebSocket, tags: string[], attachment: VisitorAttachment | AgentAttachment): Promise<void> {
    this.ctx.acceptWebSocket(server, tags);
    server.serializeAttachment(attachment);
    await this.#armSweep();
  }

  async #armSweep(): Promise<void> {
    if (this.#sweepArmed) return;
    if ((await this.ctx.storage.getAlarm()) === null) await this.ctx.storage.setAlarm(Date.now() + SWEEP_MS);
    this.#sweepArmed = true;
  }

  /** Pinged (or connected) within STALE_MS. The ping time is checked first: it needs no attachment. */
  #alive(ws: WebSocket, attachment: { connectedAt?: number } | null): boolean {
    const now = Date.now();
    const pinged = this.ctx.getWebSocketAutoResponseTimestamp(ws)?.getTime() ?? 0;
    return now - pinged < STALE_MS || now - (attachment?.connectedAt ?? 0) < STALE_MS;
  }

  /** Open, live sockets with their attachments. Everything that lists or messages people goes through here. */
  #live<T extends { connectedAt?: number }>(tag: string): [WebSocket, T][] {
    const out: [WebSocket, T][] = [];
    for (const ws of this.ctx.getWebSockets(tag)) {
      if (ws.readyState !== WebSocket.OPEN) continue;
      const a = ws.deserializeAttachment() as T | null;
      if (a && this.#alive(ws, a)) out.push([ws, a]);
    }
    return out;
  }

  override async webSocketClose(ws: WebSocket): Promise<void> {
    const a = ws.deserializeAttachment() as VisitorAttachment | AgentAttachment | null;
    if (a?.kind === "visitor") {
      if (a.visitor.pages > 0) this.#broadcast(JSON.stringify({ type: "visitor_left", sessionId: a.visitor.sessionId } satisfies HubEvent));
      return;
    }
    this.#broadcastPresence(ws);
  }

  #visitors(): LiveVisitor[] {
    // One row per browser session (a reconnect can briefly overlap the old socket): newest wins.
    const out = new Map<string, LiveVisitor>();
    const live = this.#live<VisitorAttachment>("visitor").sort(([, a], [, b]) => a.connectedAt - b.connectedAt);
    for (const [, a] of live) if (a.visitor.pages > 0) out.set(a.visitor.sessionId, a.visitor);
    return [...out.values()];
  }

  #broadcastPresence(closing?: WebSocket): void {
    const online = new Map<string, PresenceEntry>();
    for (const [ws, user] of this.#live<AgentAttachment>("agent")) {
      if (ws !== closing) online.set(user.userId, { userId: user.userId, name: user.name });
    }
    this.#broadcast(JSON.stringify({ type: "presence", online: [...online.values()] } satisfies HubEvent), closing);
  }

  /** To agents only: visitors never see inbox events or other visitors. */
  #broadcast(data: string, except?: WebSocket): void {
    for (const ws of this.ctx.getWebSockets("agent")) {
      if (ws === except || ws.readyState !== WebSocket.OPEN) continue;
      try {
        ws.send(data);
      } catch {
        // closing
      }
    }
  }

  #send(ws: WebSocket, event: HubEvent | LiveServerEvent): void {
    try {
      ws.send(JSON.stringify(event));
    } catch {
      // closing
    }
  }
}
