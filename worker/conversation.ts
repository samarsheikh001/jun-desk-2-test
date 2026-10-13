import { DurableObject } from "cloudflare:workers";
import {
  MAX_ATTACHMENTS,
  MAX_MESSAGE_LENGTH,
  SOCKET_PROTOCOL,
  type AiStep,
  type Attachment,
  type AuthorType,
  type ClientEvent,
  type ConversationEvent,
  type Handling,
  type Message,
  type MessageMeta,
  type Source,
} from "../shared/protocol.ts";
import { asksForHuman, briefPrompt, HANDOFF_MESSAGES, resolveCitations, streamCitations } from "./ai/agent.ts";
import type { ToolUser } from "./ai/config.ts";
import { loadAgentConfig } from "./ai/config-store.ts";
import { followUpsInput, followUpsPrompt, parseFollowUpLines } from "./ai/followups.ts";
import { AiUnavailableError, completeText, createModel, loadAiSettings, type AgentModel, type AiSettings } from "./ai/providers.ts";
import type { SearchHit } from "./ai/query.ts";
import { autoAssign } from "./lib/assignment.ts";
import { runAgent } from "./ai/run.ts";
import { DEFAULT_TOOL_STATUS } from "./ai/config.ts";
import { runTool, type ToolAction } from "./ai/tools.ts";
import { ACTION_ONLY_BODY, ACTION_RESULT_STATUSES, checkInput, MAX_ACTION_CHAIN, MAX_ACTION_RESULT, rankActions, resultShape, sanitizeActions, withRiskOverrides, type MessageAction, type PageAction } from "../shared/actions.ts";
import { describeEvents, isIssue, redact, sanitizeContext, type DebugContext } from "../shared/debug.ts";
import { awayText, isOpen, nextOpening, type BusinessHours } from "../shared/hours.ts";
import { forVisitor, loadMessages, loadSummary, MESSAGE_SELECT, preview, toMessage, type MessageRow } from "./lib/conversations.ts";
import { findMentions } from "../shared/inbox.ts";
import { compileTemplate } from "../shared/jinja.ts";
import { markWidgetUsed, matchWidgetAction, matchWidgetChange, MAX_PAGE_ACTION_DATA, PAGE_ACTION_BUTTON, pageActionCard, pageActionWidget, renderActionLine, TOOL_ACTION, toolActionInput, WIDGET_ONLY_BODY, widgetActionUsed, type MessageWidget, type WidgetActionMeta } from "../shared/widgets.ts";
import { AI_OFF_HANDOFF_REASON } from "../shared/metrics.ts";
import { newId } from "./lib/crypto.ts";
import { notifyTeam } from "./lib/notify.ts";
import { loadToolSecrets, secretScrubber } from "./lib/tool-secrets.ts";

/** Who is on the other end of a socket or RPC call. The Worker authenticates before forwarding. */
export type Participant =
  | { role: "agent"; userId: string; name: string }
  | { role: "visitor"; contactId: string };

export interface ConversationRef {
  conversationId: string;
  workspaceId: string;
}

export interface SendInput {
  clientMsgId: string;
  body: string;
  attachments?: Attachment[] | undefined;
  /** Visitor's debug snapshot from the loader; sanitized before storing. */
  context?: unknown;
  /** AI-21: the page actions on the visitor's page right now; sanitized, kept for the AI's next turn. */
  actions?: unknown;
  /** An agent's internal note (I-05). Ignored for visitors. */
  internal?: boolean | undefined;
  /** W-09: the visitor pressed a card's button; checked against the card, then the body is its label. */
  widgetAction?: { messageId: string; widgetId: string; action: unknown; values?: unknown; item?: unknown } | undefined;
}

export type SendResult = { ok: true; message: Message } | { ok: false; code: string; message: string };

export class SendError extends Error {
  readonly code: string;
  constructor(code: string, message: string) {
    super(message);
    this.code = code;
  }
}

/** Headers the Worker sets when forwarding an authenticated socket upgrade. */
export const FORWARD_HEADERS = {
  conversationId: "x-jun-conversation-id",
  workspaceId: "x-jun-workspace-id",
  participant: "x-jun-participant",
} as const;

/** AI-21: the latest page-action list from the visitor's loader, in this object's storage (never D1). */
const PAGE_ACTIONS_KEY = "pageActions";
/** W-17: a card tool's output for the AI (by visitor message id), and a card it returned to show with the next answer (by seq). */
const TOOL_OUTPUT_KEY = "widgetToolOutput:";

/** W-27: a card (or its list row) open again after its action failed. */
function unmarkWidget(widget: MessageWidget, item: string | undefined): MessageWidget {
  if (item) {
    const { [item]: _used, ...items } = widget.items ?? {};
    return { ...widget, items };
  }
  const { used: _used, ...rest } = widget;
  return rest;
}
const PENDING_WIDGETS_KEY = "pendingWidgets:";
/** D-51: how many field changes may run a tool in one conversation (each can call the customer's API). */
const WIDGET_CHANGES_KEY = "widgetChanges";
const MAX_WIDGET_CHANGES = 200;
/** D-51: at least this long between two change runs of one card. */
const WIDGET_CHANGE_GAP_MS = 400;

interface NewMessage {
  authorType: AuthorType;
  authorId: string | null;
  authorName: string | null;
  body: string;
  attachments?: Attachment[];
  clientMsgId: string;
  internal?: boolean;
  meta?: MessageMeta;
}

/**
 * One instance per conversation (D-11): holds the live sockets of the visitor and any
 * agents viewing it, assigns message order, writes through to D1 (the source of truth),
 * relays typing and read receipts, and runs the AI agent's turns. Sockets hibernate, so
 * idle chats cost ~nothing.
 */
export class Conversation extends DurableObject<Env> {
  #ref: ConversationRef | undefined;
  #seqLoaded: Promise<void> | undefined;
  /** The AI reply being streamed right now, so late joiners can catch up. */
  #streaming: { streamId: string; text: string; sources: Source[] } | undefined;
  #thinking = false;
  /** The current AI turn's tool steps (visitor-safe labels only), for late joiners. Never stored. */
  #steps: { turn: string; steps: AiStep[] } | undefined;
  /** The clientMsgId of the reply being written while #thinking. */
  #turn: string | undefined;
  /** Page-action runs whose result was taken: repeats (a looping or retrying page) stop here, before D1. */
  #settled = new Set<string>();
  /** D-51: cards with a field change running, and when each last ran one. */
  #changing = new Set<string>();
  #changedAt = new Map<string, number>();

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    this.#ref = ctx.storage.kv.get<ConversationRef>("ref");
    // Keep-alive pings are answered without waking the object.
    ctx.setWebSocketAutoResponse(new WebSocketRequestResponsePair("ping", "pong"));
  }

  #bind(ref: ConversationRef): ConversationRef {
    if (!this.#ref) {
      this.#ref = ref;
      this.ctx.storage.kv.put("ref", ref);
    }
    return this.#ref;
  }

  /**
   * Next message number. The increment itself is synchronous storage, so concurrent sends
   * can't get the same seq; the one-time load from D1 is shared by all callers.
   */
  async #nextSeq(conversationId: string): Promise<number> {
    if (this.ctx.storage.kv.get<number>("seq") === undefined) {
      this.#seqLoaded ??= (async () => {
        const row = await this.env.DB.prepare("SELECT last_seq FROM conversations WHERE id = ?").bind(conversationId).first<{ last_seq: number }>();
        if (this.ctx.storage.kv.get<number>("seq") === undefined) this.ctx.storage.kv.put("seq", row?.last_seq ?? 0);
      })();
      await this.#seqLoaded;
    }
    const seq = (this.ctx.storage.kv.get<number>("seq") ?? 0) + 1;
    this.ctx.storage.kv.put("seq", seq);
    return seq;
  }

  // ---------- sockets ----------

  override async fetch(request: Request): Promise<Response> {
    if (request.headers.get("upgrade")?.toLowerCase() !== "websocket") return new Response("Expected WebSocket", { status: 426 });
    const ref = this.#bind({
      conversationId: request.headers.get(FORWARD_HEADERS.conversationId)!,
      workspaceId: request.headers.get(FORWARD_HEADERS.workspaceId)!,
    });
    const participant = JSON.parse(request.headers.get(FORWARD_HEADERS.participant)!) as Participant;

    const { 0: client, 1: server } = new WebSocketPair();
    this.ctx.acceptWebSocket(server, [participant.role]);
    server.serializeAttachment(participant);

    // Catch the client up on anything after the last message it has (agents also see internal notes).
    const since = Number(new URL(request.url).searchParams.get("since") ?? 0) || 0;
    const messages = await loadMessages(this.env.DB, ref.conversationId, { since, includeInternal: participant.role === "agent" });
    this.#send(server, { type: "messages", messages });
    if (this.#thinking) this.#send(server, { type: "ai_status", state: "thinking", ...(this.#turn ? { turn: this.#turn } : {}) });
    if (this.#thinking && this.#steps) for (const step of this.#steps.steps) this.#send(server, { type: "ai_step", turn: this.#steps.turn, step });
    if (this.#streaming) this.#send(server, { type: "ai_delta", ...this.#streaming, replace: true });

    return new Response(null, { status: 101, webSocket: client, headers: { "Sec-WebSocket-Protocol": SOCKET_PROTOCOL } });
  }

  override async webSocketMessage(ws: WebSocket, raw: string | ArrayBuffer): Promise<void> {
    const participant = ws.deserializeAttachment() as Participant;
    let event: ClientEvent;
    try {
      event = JSON.parse(typeof raw === "string" ? raw : new TextDecoder().decode(raw)) as ClientEvent;
    } catch {
      return this.#send(ws, { type: "error", code: "bad_json", message: "Expected JSON." });
    }
    const ref = this.#ref;
    if (!ref) return;

    if (event.type === "send") {
      try {
        const message = await this.#addMessage(ref, participant, event);
        // The sender always gets its message back (also on duplicate retries) as the ack.
        this.#send(ws, { type: "message", message });
      } catch (error) {
        const code = error instanceof SendError ? error.code : "send_failed";
        this.#send(ws, { type: "error", code, message: (error as Error).message, clientMsgId: event.clientMsgId });
      }
    } else if (event.type === "typing") {
      const authorType = participant.role;
      const name = participant.role === "agent" ? participant.name : null;
      this.#broadcast({ type: "typing", authorType, name, typing: Boolean(event.typing) }, { except: ws });
    } else if (event.type === "read") {
      await this.#markRead(ref, participant, Number(event.seq));
    } else if (event.type === "handoff" && participant.role === "visitor") {
      await this.#handoff(ref, "The customer asked for a person.", HANDOFF_MESSAGES.default);
    } else if (event.type === "action_input" && participant.role === "visitor") {
      // AI-21: the visitor filled in what the model left out; check it and update the card.
      await this.#updateAction(ref, String(event.runId), (action) => {
        if (action.status !== "pending") return null;
        const { input, missing } = checkInput(action, { ...action.input, ...(typeof event.input === "object" && event.input !== null ? event.input : {}) });
        return { ...action, input, missing };
      });
    } else if (event.type === "action_result" && participant.role === "visitor") {
      await this.#actionResult(ref, event);
    } else if (event.type === "widget_change" && participant.role === "visitor") {
      const requestId = String(event.requestId ?? "").slice(0, 100);
      const done = (ok: boolean, message?: string) => this.#send(ws, { type: "widget_change_done", requestId, ok, ...(message ? { message } : {}) });
      try {
        await this.#widgetChange(ref, event);
        done(true);
      } catch (error) {
        if (!(error instanceof SendError)) console.error("widget_change failed", error);
        done(false, error instanceof SendError ? error.message : "That didn't work. Try again.");
      }
    }
  }

  /**
   * D-51: a card field's `onChangeAction` (`tool:<name>`): checks it against the card (offered, not
   * used), runs the tool as the verified customer (audit row on the AI message that showed the
   * card), and puts the card the tool returns in this card's place, for everyone. No message and no
   * AI turn. One run per card at a time, a short gap between runs, and a cap per conversation.
   */
  async #widgetChange(ref: ConversationRef, event: Extract<ClientEvent, { type: "widget_change" }>): Promise<void> {
    const messageId = typeof event.messageId === "string" ? event.messageId : "";
    const row = messageId
      ? await this.env.DB.prepare(`${MESSAGE_SELECT} WHERE m.conversation_id = ? AND m.id = ? AND m.author_type = 'ai'`).bind(ref.conversationId, messageId).first<MessageRow>()
      : null;
    const message = row ? toMessage(row) : null;
    const widget = message?.meta.widgets?.find((w) => w.id === event.widgetId);
    if (!message || !widget) throw new SendError("widget_gone", "That card is no longer available.");
    if (widget.used) throw new SendError("widget_used", "That card was already used.");
    const match = matchWidgetChange(widget.root, event.field, event.action, event.values);
    if (!match) throw new SendError("bad_widget_action", "That card doesn't offer this action.");
    if (match.item && widget.items?.[match.item]) throw new SendError("widget_used", "That row was already used.");
    const key = `${message.id}:${widget.id}`;
    if (this.#changing.has(key) || Date.now() - (this.#changedAt.get(key) ?? 0) < WIDGET_CHANGE_GAP_MS) throw new SendError("busy", "Still updating. Try again in a moment.");
    const count = (await this.ctx.storage.get<number>(WIDGET_CHANGES_KEY)) ?? 0;
    if (count >= MAX_WIDGET_CHANGES) throw new SendError("too_many", "This card can't update any more in this chat.");
    this.#changing.add(key);
    try {
      await this.ctx.storage.put(WIDGET_CHANGES_KEY, count + 1);
      const run = await this.#runWidgetTool(ref, { widgetId: widget.id, widget: widget.name, type: match.action.type, ...(match.action.payload !== undefined ? { payload: match.action.payload } : {}), values: match.values });
      if (!run) return;
      await this.#recordAction(ref, message.seq, run.configVersion, run.action);
      if (!run.widget) return;
      // The latest copy (another change may have landed meanwhile): swap only this card, keep its id.
      const fresh = await this.env.DB.prepare(`${MESSAGE_SELECT} WHERE m.id = ?`).bind(message.id).first<MessageRow>();
      const latest = fresh ? toMessage(fresh) : message;
      const next = run.widget;
      const meta = { ...latest.meta, widgets: (latest.meta.widgets ?? []).map((w) => (w.id === widget.id ? { ...next, id: widget.id } : w)) };
      await this.env.DB.prepare("UPDATE messages SET meta = ? WHERE id = ?").bind(JSON.stringify(meta), message.id).run();
      this.#broadcast({ type: "message", message: { ...latest, meta } });
    } finally {
      this.#changing.delete(key);
      this.#changedAt.set(key, Date.now());
    }
  }

  override async webSocketClose(ws: WebSocket): Promise<void> {
    const participant = ws.deserializeAttachment() as Participant | null;
    // Clear any typing indicator the closed socket left behind.
    if (participant) {
      this.#broadcast({ type: "typing", authorType: participant.role, name: participant.role === "agent" ? participant.name : null, typing: false }, { except: ws });
    }
  }

  // ---------- RPC from the Worker ----------

  /** Adds a message. Returns a result because error details don't survive RPC. */
  async send(refIn: ConversationRef, participant: Participant, input: SendInput): Promise<SendResult> {
    try {
      return { ok: true, message: await this.#addMessage(refIn, participant, input) };
    } catch (error) {
      if (error instanceof SendError) return { ok: false, code: error.code, message: error.message };
      throw error;
    }
  }

  /** An internal system note for agents (idempotent per clientMsgId), e.g. W-08's captured email or S-08's filed issue. */
  async addNote(refIn: ConversationRef, body: string, clientMsgId: string, meta?: MessageMeta): Promise<void> {
    const ref = this.#bind(refIn);
    await this.#insert(ref, { authorType: "system", authorId: null, authorName: null, body, clientMsgId, internal: true, ...(meta ? { meta } : {}) });
  }

  /** RPC (I-02): a new chat went straight to the team (AI off): give it to an online teammate if the workspace uses round robin. */
  async assignIfNeeded(refIn: ConversationRef): Promise<void> {
    await this.#autoAssign(this.#bind(refIn));
  }

  /** After a status/assignment/handling change: update open threads, and let the AI pick up if handed back. */
  async conversationChanged(refIn: ConversationRef): Promise<void> {
    const ref = this.#bind(refIn);
    await this.#publish(ref);
    await this.ctx.storage.setAlarm(Date.now());
  }

  // ---------- messages ----------

  /** A message from a participant. Idempotent per clientMsgId. */
  async #addMessage(refIn: ConversationRef, participant: Participant, input: SendInput): Promise<Message> {
    const ref = this.#bind(refIn);
    // W-09: a card's button. The card must offer that action and not have been used; the message
    // reads as the button's label (from the card, not the client) and carries what was entered.
    const used = participant.role === "visitor" && input.widgetAction ? await this.#useWidget(ref, input.clientMsgId, input.widgetAction) : null;
    // W-17: a `tool:<name>` button runs the tool now; the AI's turn then says what happened.
    const toolRun = used?.meta ? await this.#runWidgetTool(ref, used.meta) : null;
    if (toolRun && used?.meta && used.card) {
      const { meta, card } = used;
      // W-27: the action's widget_failed line: the card opens again with it and nothing is sent
      // (the visitor can fix a field and press again); the run is still in the audit log.
      if (toolRun.failed) {
        await this.#recordAction(ref, card.seq, toolRun.configVersion, toolRun.action);
        await this.#setCard(ref, card.messageId, meta.widgetId, (w) => unmarkWidget(w, meta.item));
        throw new SendError("action_failed", toolRun.failed);
      }
      // Its widget_done line: the card folds to it, and it answers the press unless a card comes next.
      meta.tool = { name: toolRun.action.tool, status: toolRun.action.status, ...(toolRun.done && !toolRun.widget ? { done: toolRun.done } : {}) };
      if (toolRun.done) await this.#setCard(ref, card.messageId, meta.widgetId, (w) => markWidgetUsed(unmarkWidget(w, meta.item), toolRun.done, meta.item, Date.now()));
    }
    // W-32: a `page:<name>` button offers that website action as the AI would (it must be on the
    // customer's page now); otherwise the card opens again and says why.
    const pageRun = used?.meta && used.card ? await this.#pageButton(ref, used.meta, input.actions) : null;
    if (pageRun && "error" in pageRun && used?.meta && used.card) {
      const { meta, card } = used;
      await this.#setCard(ref, card.messageId, meta.widgetId, (w) => unmarkWidget(w, meta.item));
      throw new SendError("action_failed", pageRun.error);
    }
    const body = used ? used.label : typeof input.body === "string" ? input.body.trim() : "";
    const attachments = await this.#checkAttachments(ref, participant, input.attachments ?? []);
    if (!body && attachments.length === 0) throw new SendError("empty", "Message is empty.");
    if (body.length > MAX_MESSAGE_LENGTH) throw new SendError("too_long", `Messages are limited to ${MAX_MESSAGE_LENGTH} characters.`);
    if (typeof input.clientMsgId !== "string" || !input.clientMsgId || input.clientMsgId.length > 100) {
      throw new SendError("bad_client_msg_id", "clientMsgId is required.");
    }

    // A note (I-05) stays between agents: no takeover, no visitor, no AI.
    const note = participant.role === "agent" && input.internal === true;

    // An agent writing in an AI-handled conversation takes it over (I-04).
    if (participant.role === "agent" && !note) {
      const took = await this.env.DB.prepare("UPDATE conversations SET handling = 'human' WHERE id = ? AND handling = 'ai'").bind(ref.conversationId).run();
      if (took.meta.changes > 0) {
        await this.#insert(ref, {
          authorType: "system",
          authorId: null,
          authorName: null,
          body: `${participant.name} took over from the AI.`,
          clientMsgId: `takeover:${input.clientMsgId}`,
          internal: true,
        });
      }
    }

    const mentions = note ? await this.#mentioned(ref, participant, body) : [];
    const { message, created } = await this.#insertMessage(ref, {
      authorType: participant.role,
      authorId: participant.role === "agent" ? participant.userId : participant.contactId,
      authorName: participant.role === "agent" ? participant.name : null,
      body,
      attachments,
      clientMsgId: input.clientMsgId,
      ...(note ? { internal: true, meta: mentions.length ? { mentions } : {} } : {}),
      ...(used?.meta ? { meta: { widgetAction: used.meta } } : {}),
    });
    if (participant.role === "agent" && mentions.length) await this.#notifyMentions(ref, participant, message);
    if (toolRun && created) {
      await this.#recordAction(ref, message.seq, toolRun.configVersion, toolRun.action);
      // For the AI's history only (meta goes to the visitor); a card the tool shows comes with the AI's answer.
      await this.ctx.storage.put(`${TOOL_OUTPUT_KEY}${message.id}`, toolRun.action.output.slice(0, 4000));
      if (toolRun.widget) await this.ctx.storage.put(`${PENDING_WIDGETS_KEY}${message.seq}`, [{ label: toolRun.label, widget: toolRun.widget }]);
    }
    if (pageRun && "action" in pageRun && created) {
      // A `human` action is a request for the team (as when the AI picks one).
      if (pageRun.human) await this.#handoff(ref, `The customer wants to: ${pageRun.action.description}`, HANDOFF_MESSAGES.default);
      // The answer to the press: the action's card (confirm, or it runs at once), as the AI's reply.
      else await this.#insert(ref, { authorType: "ai", authorId: null, authorName: null, body: ACTION_ONLY_BODY, clientMsgId: `ai:${message.seq}`, meta: { action: pageRun.action } });
    }

    if (participant.role === "visitor" && input.context !== undefined) await this.#storeContext(ref, message.seq, input.context);
    // AI-21: the page's actions travel with each message; the AI turn (an alarm) reads the latest list.
    if (participant.role === "visitor" && input.actions !== undefined) {
      const pageActions = sanitizeActions(input.actions);
      await this.ctx.storage.put(PAGE_ACTIONS_KEY, pageActions);
      this.ctx.waitUntil(this.#notePageActions(ref, pageActions));
    }
    // I-14: the visitor wrote in a chat a teammate has: tell them (not on retries).
    if (participant.role === "visitor" && created) this.ctx.waitUntil(this.#notifyAssignee(ref));

    // The AI answers visitor messages in AI-handled conversations, from an alarm so the
    // sender isn't kept waiting (and so it's retried if the object restarts).
    if (participant.role === "visitor" && !used?.meta?.tool?.done && !pageRun) await this.ctx.storage.setAlarm(Date.now());
    return message;
  }

  /**
   * W-09: checks a card action against the AI message that showed the card and marks the card used
   * (everyone's copy updates in place). A retry of a message already stored passes (no meta: the
   * stored message is returned as is). Throws SendError for a card that's gone, used or forged.
   */
  async #useWidget(
    ref: ConversationRef,
    clientMsgId: string,
    sent: NonNullable<SendInput["widgetAction"]>,
  ): Promise<{ label: string; meta: WidgetActionMeta | null; card?: { messageId: string; seq: number } }> {
    const retry = await this.env.DB.prepare(`${MESSAGE_SELECT} WHERE m.conversation_id = ? AND m.client_msg_id = ?`).bind(ref.conversationId, String(clientMsgId)).first<MessageRow>();
    if (retry) return { label: toMessage(retry).body, meta: null };
    const messageId = typeof sent.messageId === "string" ? sent.messageId : "";
    const row = messageId
      ? await this.env.DB.prepare(`${MESSAGE_SELECT} WHERE m.conversation_id = ? AND m.id = ? AND m.author_type = 'ai'`).bind(ref.conversationId, messageId).first<MessageRow>()
      : null;
    const message = row ? toMessage(row) : null;
    const widget = message?.meta.widgets?.find((w) => w.id === sent.widgetId);
    if (!message || !widget) throw new SendError("widget_gone", "That card is no longer available.");
    const match = matchWidgetAction(widget.root, sent.action, sent.values, sent.item);
    if (!match) throw new SendError("bad_widget_action", "That card doesn't offer this action.");
    // A list item's button uses only that row (W-17); the card's own actions use the whole card.
    if (widgetActionUsed(widget, match.item)) throw new SendError("widget_used", "That card was already used.");
    const at = Date.now();
    const meta = { ...message.meta, widgets: message.meta.widgets!.map((w) => (w.id === widget.id ? markWidgetUsed(w, match.label, match.item, at) : w)) };
    await this.env.DB.prepare("UPDATE messages SET meta = ? WHERE id = ?").bind(JSON.stringify(meta), message.id).run();
    this.#broadcast({ type: "message", message: { ...message, meta } });
    return {
      label: match.label,
      card: { messageId: message.id, seq: message.seq },
      meta: {
        widgetId: widget.id,
        widget: widget.name,
        type: match.action.type,
        ...(match.action.payload !== undefined ? { payload: match.action.payload } : {}),
        ...(Object.keys(match.values).length ? { values: match.values } : {}),
        ...(match.item ? { item: match.item } : {}),
      },
    };
  }

  /**
   * W-17: runs the tool a card's `tool:<name>` button names, with the button's payload and what was
   * entered (only the tool's own inputs), as the verified customer. Null for other actions.
   */
  async #runWidgetTool(
    ref: ConversationRef,
    meta: WidgetActionMeta,
  ): Promise<{ action: ToolAction; widget: MessageWidget | null; label: string; configVersion: number | null; done: string; failed: string } | null> {
    const name = TOOL_ACTION.exec(meta.type)?.[1];
    if (!name) return null;
    const [config, user] = await Promise.all([loadAgentConfig(this.env, ref.workspaceId), this.#verifiedCustomer(ref)]);
    const spec = config.tools.find((t) => t.name === name);
    if (!spec) {
      return { action: { tool: name, input: {}, output: `There's no tool called ${name}.`, status: "error", httpStatus: null, durationMs: 0 }, widget: null, label: DEFAULT_TOOL_STATUS, configVersion: config.version, done: "", failed: "" };
    }
    const input = toolActionInput({ type: meta.type, ...(meta.payload !== undefined ? { payload: meta.payload } : {}) }, meta.values ?? {}, spec.input);
    const { action, widget, result } = await runTool(spec, input, { secrets: await loadToolSecrets(this.env, ref.workspaceId), user, widgets: config.widgets }, `wb${Date.now().toString(36)}`);
    // W-27: the action's own line for the card (the error's body never reaches the visitor).
    const values = meta.values ?? {};
    const ok = action.status === "ok";
    const done = ok && spec.widgetDone ? renderActionLine(compileTemplate(spec.widgetDone), values, result) : "";
    const failed = !ok && spec.widgetFailed ? renderActionLine(compileTemplate(spec.widgetFailed), values, undefined) : "";
    return { action, widget, label: spec.status ?? DEFAULT_TOOL_STATUS, configVersion: config.version, done, failed };
  }

  /**
   * W-32: the website action a card's `page:<name>` button names, from the page's list sent with
   * the press (else the latest one), proposed with the button's payload and the card's fields (only
   * the action's own inputs). Null for other actions; an error when the page doesn't offer it.
   */
  async #pageButton(ref: ConversationRef, meta: WidgetActionMeta, sent: unknown): Promise<{ action: MessageAction; human: boolean } | { error: string } | null> {
    const name = PAGE_ACTION_BUTTON.exec(meta.type)?.[1];
    if (!name) return null;
    const raw = sent !== undefined ? sanitizeActions(sent) : ((await this.ctx.storage.get<PageAction[]>(PAGE_ACTIONS_KEY)) ?? []);
    // D-74: a website action the desk says a person does still hands off when a button runs it (D-77: with the desk's line).
    const desk = await loadAgentConfig(this.env, ref.workspaceId);
    const list = withRiskOverrides(raw, desk.websiteActionRisk, desk.websiteActionStatus);
    const action = list.find((a) => a.id === name) ?? list.find((a) => a.name === name);
    if (!action) return { error: "This page doesn't offer that right now." };
    const input = toolActionInput({ type: meta.type, ...(meta.payload !== undefined ? { payload: meta.payload } : {}) }, meta.values ?? {}, action.params);
    // D-73: the press is the customer's yes (the button said what it does), so it runs at once, not
    // behind a second Confirm; one that still needs an input keeps its card to fill it in.
    const proposed = this.#proposeAction(action, input);
    return { action: { ...proposed, pressed: true, ...(proposed.missing.length ? {} : { risk: "auto" as const }) }, human: action.risk === "human" };
  }

  /** W-27: one card of an AI message changed in place (its latest copy), for everyone. */
  async #setCard(ref: ConversationRef, messageId: string, widgetId: string, next: (widget: MessageWidget) => MessageWidget): Promise<void> {
    const row = await this.env.DB.prepare(`${MESSAGE_SELECT} WHERE m.conversation_id = ? AND m.id = ?`).bind(ref.conversationId, messageId).first<MessageRow>();
    if (!row) return;
    const message = toMessage(row);
    const meta = { ...message.meta, widgets: (message.meta.widgets ?? []).map((w) => (w.id === widgetId ? next(w) : w)) };
    await this.env.DB.prepare("UPDATE messages SET meta = ? WHERE id = ?").bind(JSON.stringify(meta), message.id).run();
    this.#broadcast({ type: "message", message: { ...message, meta } });
  }

  /** W-17: the AI's history gets each card tool's result back (kept out of the visitor's copy of the message). */
  async #withToolOutputs(history: Message[]): Promise<Message[]> {
    const ran = history.filter((m) => m.meta.widgetAction?.tool);
    if (!ran.length) return history;
    const outputs = await this.ctx.storage.get<string>(ran.map((m) => `${TOOL_OUTPUT_KEY}${m.id}`));
    return history.map((m) => {
      const output = m.meta.widgetAction?.tool ? outputs.get(`${TOOL_OUTPUT_KEY}${m.id}`) : undefined;
      return output === undefined ? m : { ...m, meta: { ...m.meta, widgetAction: { ...m.meta.widgetAction!, tool: { ...m.meta.widgetAction!.tool!, output } } } };
    });
  }

  /** I-14: "Ana replied" to the assignee of a chat the team is handling. */
  async #notifyAssignee(ref: ConversationRef): Promise<void> {
    const row = await this.env.DB.prepare("SELECT assignee_id FROM conversations WHERE id = ? AND handling = 'human'").bind(ref.conversationId).first<{ assignee_id: string | null }>();
    if (row?.assignee_id) await notifyTeam(this.env, ref, { kind: "visitor_reply", actorId: null, targets: [row.assignee_id] });
  }

  /** Teammates @mentioned in a note, not counting the author. */
  async #mentioned(ref: ConversationRef, author: Participant & { role: "agent" }, body: string): Promise<string[]> {
    if (!body.includes("@")) return [];
    const members = await this.env.DB.prepare("SELECT u.id, u.name FROM members m JOIN users u ON u.id = m.user_id WHERE m.workspace_id = ?")
      .bind(ref.workspaceId)
      .all<{ id: string; name: string }>();
    return findMentions(body, members.results).filter((id) => id !== author.userId);
  }

  /** Records mentions once per note (retries are no-ops) and pings the mentioned agents' dashboards. */
  async #notifyMentions(ref: ConversationRef, author: Participant & { role: "agent" }, message: Message): Promise<void> {
    const by = author.name;
    const userIds = message.meta.mentions ?? [];
    const results = await this.env.DB.batch(
      userIds.map((userId) =>
        this.env.DB.prepare("INSERT OR IGNORE INTO mentions (message_id, user_id, conversation_id, workspace_id, created_at) VALUES (?, ?, ?, ?, ?)").bind(
          message.id,
          userId,
          ref.conversationId,
          ref.workspaceId,
          message.createdAt,
        ),
      ),
    );
    const fresh = userIds.filter((_, i) => (results[i]?.meta.changes ?? 0) > 0);
    if (fresh.length === 0) return;
    await this.env.WORKSPACE_HUB.getByName(ref.workspaceId).publish({
      type: "mention",
      conversationId: ref.conversationId,
      userIds: fresh,
      by,
      preview: preview(message.body, message.attachments),
    });
    // I-14: also as a notification (members only; the note's text is fine for them).
    this.ctx.waitUntil(notifyTeam(this.env, ref, { kind: "mention", actorId: author.userId, targets: fresh }, { by, note: message.body }));
  }

  /** Stores the visitor's browser snapshot (re-sanitized: never trust the client) for agents and the AI. */
  async #storeContext(ref: ConversationRef, seq: number, raw: unknown): Promise<void> {
    const context = sanitizeContext(raw);
    if (!context) return;
    const json = JSON.stringify(context);
    if (json.length > 64_000) return;
    await this.env.DB.batch([
      this.env.DB.prepare("INSERT INTO debug_snapshots (id, conversation_id, workspace_id, message_seq, context, created_at) VALUES (?, ?, ?, ?, ?, ?)").bind(
        newId("dbg"),
        ref.conversationId,
        ref.workspaceId,
        seq,
        json,
        Date.now(),
      ),
      this.env.DB.prepare("UPDATE conversations SET debug_issue_count = ? WHERE id = ?").bind(context.events.filter(isIssue).length, ref.conversationId),
    ]);
    this.ctx.waitUntil(this.#publish(ref));
  }

  /** Stores a message (idempotent per clientMsgId), broadcasts it and updates inbox lists. */
  async #insert(ref: ConversationRef, input: NewMessage): Promise<Message> {
    return (await this.#insertMessage(ref, input)).message;
  }

  /** Like #insert; `created` is false when it was a retry of a message stored before. */
  async #insertMessage(ref: ConversationRef, input: NewMessage): Promise<{ message: Message; created: boolean }> {
    const db = this.env.DB;
    const findExisting = async () => {
      const row = await db
        .prepare(`${MESSAGE_SELECT} WHERE m.conversation_id = ? AND m.client_msg_id = ?`)
        .bind(ref.conversationId, input.clientMsgId)
        .first<MessageRow>();
      return row ? toMessage(row) : null;
    };
    const existing = await findExisting();
    if (existing) return { message: existing, created: false };

    const seq = await this.#nextSeq(ref.conversationId);
    const now = Date.now();
    const id = newId("msg");
    const attachments = input.attachments ?? [];
    const internal = input.internal ?? false;
    const meta = input.meta ?? {};

    const statements = [
      db.prepare(
        `INSERT INTO messages (id, conversation_id, seq, author_type, author_id, body, attachments, client_msg_id, created_at, internal, meta)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      ).bind(id, ref.conversationId, seq, input.authorType, input.authorId, input.body, JSON.stringify(attachments), input.clientMsgId, now, internal ? 1 : 0, JSON.stringify(meta)),
    ];
    if (!internal) {
      statements.push(
        db.prepare(
          `UPDATE conversations SET
             last_seq = MAX(last_seq, ?1), last_message_at = ?2, last_message_preview = ?3, last_message_author = ?4, updated_at = ?2,
             -- A visitor writing again reopens a resolved/snoozed conversation.
             status = CASE WHEN ?4 = 'visitor' AND status IN ('resolved', 'snoozed') THEN 'open' ELSE status END,
             -- Senders have read everything up to their own message.
             agent_read_seq = CASE WHEN ?4 = 'agent' THEN MAX(agent_read_seq, ?1) ELSE agent_read_seq END,
             visitor_read_seq = CASE WHEN ?4 = 'visitor' THEN MAX(visitor_read_seq, ?1) ELSE visitor_read_seq END
           WHERE id = ?5`,
        ).bind(seq, now, preview(input.body, attachments), input.authorType, ref.conversationId),
      );
      if (input.authorType === "visitor" && input.authorId) {
        statements.push(db.prepare("UPDATE contacts SET last_seen_at = ? WHERE id = ?").bind(now, input.authorId));
      }
    } else {
      statements.push(db.prepare("UPDATE conversations SET last_seq = MAX(last_seq, ?), updated_at = ? WHERE id = ?").bind(seq, now, ref.conversationId));
    }

    try {
      await db.batch(statements);
    } catch (error) {
      // A concurrent retry with the same clientMsgId won the race: return its message.
      const raced = await findExisting();
      if (raced) return { message: raced, created: false };
      throw error;
    }

    const message: Message = {
      id,
      seq,
      authorType: input.authorType,
      authorId: input.authorId,
      authorName: input.authorName,
      body: input.body,
      attachments,
      clientMsgId: input.clientMsgId,
      createdAt: now,
      internal,
      meta,
    };
    this.#broadcast({ type: "message", message }, { agentsOnly: internal });
    this.ctx.waitUntil(this.#publish(ref));
    return { message, created: true };
  }

  async #markRead(ref: ConversationRef, participant: Participant, seq: number): Promise<void> {
    if (!Number.isInteger(seq) || seq < 1) return;
    const column = participant.role === "agent" ? "agent_read_seq" : "visitor_read_seq";
    const result = await this.env.DB.prepare(`UPDATE conversations SET ${column} = ? WHERE id = ? AND ${column} < ? AND last_seq >= ?`)
      .bind(seq, ref.conversationId, seq, seq)
      .run();
    if (result.meta.changes === 0) return; // not newer than what's recorded
    this.#broadcast({ type: "read", by: participant.role, seq });
    if (participant.role === "agent") this.ctx.waitUntil(this.#publish(ref)); // unread badges in inbox lists
  }

  async #checkAttachments(ref: ConversationRef, participant: Participant, attachments: Attachment[]): Promise<Attachment[]> {
    if (!Array.isArray(attachments) || attachments.length === 0) return [];
    if (attachments.length > MAX_ATTACHMENTS) throw new SendError("too_many_files", `At most ${MAX_ATTACHMENTS} files per message.`);
    const uploader = participant.role === "agent" ? `user:${participant.userId}` : `contact:${participant.contactId}`;
    const keys = attachments.map((a) => String(a?.key ?? ""));
    const rows = await this.env.DB.prepare(
      `SELECT key, name, type, size FROM files WHERE workspace_id = ? AND uploaded_by = ? AND key IN (${keys.map(() => "?").join(",")})`,
    )
      .bind(ref.workspaceId, uploader, ...keys)
      .all<Attachment>();
    // Use the stored metadata, not what the client claims.
    const byKey = new Map(rows.results.map((r) => [r.key, r]));
    return keys.map((key) => {
      const file = byKey.get(key);
      if (!file) throw new SendError("unknown_file", "An attachment wasn't found. Upload it again.");
      return { key: file.key, name: file.name, type: file.type, size: file.size };
    });
  }

  // ---------- the AI agent ----------

  override async alarm(): Promise<void> {
    const ref = this.#ref;
    if (!ref) return;
    // Keep answering while the newest public message is an unanswered visitor message.
    for (let i = 0; i < 3; i++) {
      const answered = await this.#aiTurn(ref);
      if (!answered) break;
    }
    // With the team (from the start, or just handed off) and outside business hours: say so.
    await this.#maybeAway(ref);
  }

  /** I-10: one automatic "we're away, back Monday at 09:00" per closed period, for human-handled chats. */
  async #maybeAway(ref: ConversationRef): Promise<void> {
    const row = await this.env.DB.prepare(
      `SELECT c.handling, i.settings,
              (SELECT MAX(created_at) FROM messages m WHERE m.conversation_id = c.id AND m.author_type = 'agent' AND m.internal = 0) AS last_agent_at
       FROM conversations c JOIN inboxes i ON i.id = c.inbox_id WHERE c.id = ?`,
    )
      .bind(ref.conversationId)
      .first<{ handling: Handling; settings: string; last_agent_at: number | null }>();
    if (!row || row.handling !== "human") return;
    const hours = (JSON.parse(row.settings) as { hours?: BusinessHours }).hours;
    const now = Date.now();
    if (!hours?.enabled || isOpen(hours, now)) return;
    // Someone on the team is replying right now anyway.
    if (row.last_agent_at && now - row.last_agent_at < 15 * 60 * 1000) return;
    const until = nextOpening(hours, now) ?? now + 24 * 60 * 60 * 1000;
    // Keyed by the next opening: one per closed period, even if retried.
    await this.#insert(ref, { authorType: "system", authorId: null, authorName: null, body: awayText(hours, now), clientMsgId: `away:${until}`, meta: { away: true } });
  }

  async #handling(ref: ConversationRef): Promise<Handling | null> {
    const row = await this.env.DB.prepare("SELECT handling FROM conversations WHERE id = ?").bind(ref.conversationId).first<{ handling: Handling }>();
    return row?.handling ?? null;
  }

  /** One AI turn. Returns true if it replied (so the caller checks for newer messages). */
  async #aiTurn(ref: ConversationRef): Promise<boolean> {
    const month = new Date().toISOString().slice(0, 7);
    // Independent lookups in parallel: every round trip here delays the first word.
    const [handling, history, settings, usage, config] = await Promise.all([
      this.#handling(ref),
      loadMessages(this.env.DB, ref.conversationId, { includeInternal: false, limit: 40 }),
      loadAiSettings(this.env, ref.workspaceId),
      this.env.DB.prepare("SELECT replies FROM ai_usage WHERE workspace_id = ? AND month = ?").bind(ref.workspaceId, month).first<{ replies: number }>(),
      loadAgentConfig(this.env, ref.workspaceId),
    ]);
    if (handling !== "ai") return false;
    const last = history.at(-1);
    if (!last) return false;
    // The visitor's latest message, and the AI replies to it so far (`ai:<seq>`, `ai:<seq>.<n>`).
    // One sent while the AI was still writing lands before that reply, so "the last message is the
    // visitor's" isn't the test: a message with no reply of its own still gets a turn.
    let visitorAt = history.length - 1;
    while (visitorAt >= 0 && history[visitorAt]!.authorType !== "visitor") visitorAt--;
    const visitor = history[visitorAt];
    if (!visitor) return false;
    // W-27: a card's press its action's widget_done line already answered.
    if (visitor.meta.widgetAction?.tool?.done) return false;
    // A teammate answered it (then handed back to the AI): the AI waits for the visitor's next message.
    if (history.slice(visitorAt + 1).some((m) => m.authorType === "agent")) return false;
    const replyKey = `ai:${visitor.seq}`;
    const chain = history.slice(visitorAt + 1).filter((m) => m.authorType === "ai" && (m.clientMsgId === replyKey || m.clientMsgId.startsWith(`${replyKey}.`))).length;
    // AI-21: after a page action ran (or failed), the AI gets one follow-up turn: the next step of
    // a longer request, or a short confirmation. Never after a cancel, undo or a vanished action.
    // W-32: an action a card's button started answers itself (its step row, its card): no turn.
    const followUp = chain > 0 && last.authorType === "ai" && last.meta.action && (last.meta.action.status === "ok" || last.meta.action.status === "error") && !last.meta.action.continued && !last.meta.action.pressed ? last.meta.action : null;
    if (chain > 0 && !followUp) return false;
    if (followUp && chain >= MAX_ACTION_CHAIN) return false;
    const turnId = chain === 0 ? replyKey : `${replyKey}.${chain}`;

    if (!settings.enabled) {
      // Reports don't count this one as the AI handing off (A-01).
      await this.#handoff(ref, AI_OFF_HANDOFF_REASON, HANDOFF_MESSAGES.default);
      return false;
    }
    if (!followUp && asksForHuman(visitor.body)) {
      await this.#handoff(ref, "The customer asked for a person.", HANDOFF_MESSAGES.default);
      return false;
    }
    // Follow-up turns after actions (ai:<seq>.<n>) don't count: the cap is on answers to the visitor.
    if (history.filter((m) => m.authorType === "ai" && !/\.\d+$/.test(m.clientMsgId)).length >= config.maxReplies) {
      await this.#handoff(ref, `The AI has answered ${config.maxReplies} times without resolving it.`, HANDOFF_MESSAGES.default);
      return false;
    }
    if ((usage?.replies ?? 0) >= settings.monthlyReplyCap) {
      // B-03: never go silent; hand to a human instead.
      await this.#handoff(ref, `Monthly AI reply cap (${settings.monthlyReplyCap}) reached.`, HANDOFF_MESSAGES.limit);
      return false;
    }

    // Mark the follow-up as taken before the model runs, so a retried alarm can't run it twice.
    if (followUp) await this.#updateAction(ref, followUp.runId, (a) => ({ ...a, continued: true }));

    this.#thinking = true;
    this.#turn = turnId;
    this.#broadcast({ type: "ai_status", state: "thinking", turn: turnId });
    // W-17: a card the visitor's button's tool returned shows with this answer, from the start.
    const pendingKey = `${PENDING_WIDGETS_KEY}${visitor.seq}`;
    const pending = chain === 0 ? ((await this.ctx.storage.get<{ label: string; widget: MessageWidget }[]>(pendingKey)) ?? []) : [];
    if (pending.length) {
      this.#steps = { turn: turnId, steps: pending.map((p, i) => ({ id: `p${i}`, label: p.label, state: "done" as const, widget: p.widget })) };
      for (const step of this.#steps.steps) this.#broadcast({ type: "ai_step", turn: turnId, step });
    }
    try {
      let model: AgentModel;
      try {
        model = createModel(this.env, ref.workspaceId, settings, "answer");
      } catch (error) {
        if (error instanceof AiUnavailableError) {
          await this.#handoff(ref, `AI unavailable: ${error.message}`, HANDOFF_MESSAGES.error);
          return false;
        }
        throw error;
      }

      const [workspace, technical, user, intent, pageActions] = await Promise.all([
        this.env.DB.prepare("SELECT name FROM workspaces WHERE id = ?").bind(ref.workspaceId).first<{ name: string }>(),
        this.#technicalContext(ref),
        this.#verifiedCustomer(ref),
        // AI-20: the intent the host app opened the chat with.
        this.env.DB.prepare("SELECT intent FROM conversations WHERE id = ?").bind(ref.conversationId).first<{ intent: string | null }>(),
        // AI-21: what the visitor's page offers right now (from their latest message).
        this.ctx.storage.get<PageAction[]>(PAGE_ACTIONS_KEY),
      ]);

      // Stream the reply as it comes (its decisions are tool calls, nothing to hold back).
      const streamId = newId("str");
      let shown = "";
      let cited = 0;
      const actions: Promise<void>[] = [];
      const result = await runAgent({
        env: this.env,
        workspaceId: ref.workspaceId,
        workspaceName: workspace?.name ?? "this company",
        model,
        config,
        history: await this.#withToolOutputs(history),
        technical: technical.lines,
        ...(technical.timezone ? { timezone: technical.timezone } : {}),
        user,
        intent: intent?.intent ?? null,
        // D-74: the desk's own setting for each website action wins over the site's.
        pageActions: rankActions(withRiskOverrides(pageActions ?? [], config.websiteActionRisk, config.websiteActionStatus), visitor.body),
        pagePath: technical.pagePath,
        followUp: followUp ? { name: followUp.name, status: followUp.status as "ok" | "error", result: followUp.result, ...(followUp.card ? { card: true } : {}) } : null,
        shownWidgets: pending.length,
        // Citations stream already resolved (numbered by first use, with their sources).
        onVisible: (visible, hits) => {
          const { text, sources } = streamCitations(visible, hits);
          if (!text || text === shown) return;
          if (shown && text.startsWith(shown)) {
            this.#broadcast({ type: "ai_delta", streamId, text: text.slice(shown.length), ...(sources.length !== cited ? { sources } : {}) });
          } else {
            this.#broadcast({ type: "ai_delta", streamId, text, replace: true, sources });
          }
          shown = text;
          cited = sources.length;
          this.#streaming = { streamId, text, sources };
        },
        onAction: (action) => actions.push(this.#recordAction(ref, visitor.seq, config.version, action)),
        // Visitors and agents: only the admin's label and an opaque id (ai_action stays agents-only).
        onStep: (step) => {
          const turn = turnId;
          if (this.#steps?.turn !== turn) this.#steps = { turn, steps: [] };
          const steps = this.#steps.steps;
          const at = steps.findIndex((s) => s.id === step.id);
          if (at >= 0) steps[at] = step;
          else steps.push(step);
          this.#broadcast({ type: "ai_step", turn, step });
        },
      });
      await Promise.all([...actions, this.#recordUsage(ref.workspaceId, month, result.usage)]);
      const { outcome, hits } = result;
      const shownWidgets = [...pending.map((p) => p.widget), ...result.widgets];

      // A teammate may have taken over while we were writing: drop the answer.
      if ((await this.#handling(ref)) !== "ai") return false;

      if (outcome.kind === "handoff") {
        // What it said (and showed) before handing off stays as its message, then the notice.
        const said = outcome.text ? resolveCitations(outcome.text, hits) : null;
        const before = said?.text || shownWidgets.length
          ? await this.#insert(ref, {
              authorType: "ai",
              authorId: null,
              authorName: null,
              body: said?.text || WIDGET_ONLY_BODY,
              clientMsgId: turnId,
              meta: {
                ...(said?.sources.length ? { sources: said.sources } : {}),
                ...(config.version !== null ? { configVersion: config.version } : {}),
                ...(shownWidgets.length ? { widgets: shownWidgets } : {}),
              },
            })
          : null;
        if (pending.length) await this.ctx.storage.delete(pendingKey);
        await this.#handoff(ref, outcome.reason, HANDOFF_MESSAGES.default, settings, before ? [...history, before] : history, technical.lines);
        return false;
      }
      // AI-21: a `human` action is a request for the team, not something the page should do.
      if (result.pageAction?.action.risk === "human") {
        await this.#handoff(ref, `The customer wants to: ${result.pageAction.action.description}`, HANDOFF_MESSAGES.default, settings, history, technical.lines);
        return false;
      }
      // Loop breaker: a follow-up that proposes the action that just ran, with the same inputs, is done.
      const repeat = Boolean(followUp && result.pageAction && result.pageAction.action.id === followUp.id && JSON.stringify(checkInput(result.pageAction.action, result.pageAction.input).input) === JSON.stringify(followUp.input));
      if (repeat) return false; // its text would say "I'll do X now" about something already done; the card shows Done
      const action = result.pageAction ? this.#proposeAction(result.pageAction.action, result.pageAction.input) : null;
      const { text, sources } = resolveCitations(outcome.text, hits);
      const widgets = shownWidgets;
      if (!text && !action && !widgets.length) {
        // Nothing to say: fine after an action (the card shows what happened); otherwise the team takes it.
        if (followUp) return false;
        await this.#handoff(ref, "The AI gave an empty reply.", HANDOFF_MESSAGES.error, settings, history, technical.lines);
        return false;
      }
      const body = text || (action ? ACTION_ONLY_BODY : widgets.length ? WIDGET_ONLY_BODY : text);
      const answer = await this.#insert(ref, {
        authorType: "ai",
        authorId: null,
        authorName: null,
        body,
        clientMsgId: turnId, // one answer per visitor message (or per action follow-up), even if this turn is retried
        meta: {
          ...(sources.length ? { sources } : {}),
          ...(config.version !== null ? { configVersion: config.version } : {}),
          ...(action ? { action } : {}),
          ...(widgets.length ? { widgets } : {}),
        },
      });
      if (pending.length) await this.ctx.storage.delete(pendingKey);
      this.#streaming = undefined;
      this.#steps = undefined;
      this.#thinking = false;
      this.#broadcast({ type: "ai_status", state: "idle" });
      if (outcome.escalate) {
        // P1: the AI explained what broke; now the team gets it with the technical details.
        await this.#handoff(ref, `Bug flagged by the AI: ${outcome.escalate}`, HANDOFF_MESSAGES.escalated, settings, [...history, answer], technical.lines);
        return false;
      }
      // Questions the customer might ask next, under an answer from the knowledge (not under a card).
      if (sources.length && text && !action) await this.#addFollowUps(ref, settings, visitor.body, answer, hits);
      return true;
    } catch (error) {
      console.error("AI turn failed:", error);
      await this.#handoff(ref, `AI error: ${(error as Error).message}`.slice(0, 300), HANDOFF_MESSAGES.error);
      return false;
    } finally {
      this.#thinking = false;
      this.#streaming = undefined;
      this.#steps = undefined;
      this.#broadcast({ type: "ai_status", state: "idle" });
    }
  }

  /**
   * Follow-up questions under an answer that used the knowledge: a separate small job after the
   * answer is saved (worker/ai/followups.ts), added to the message in place. Best effort.
   */
  async #addFollowUps(ref: ConversationRef, settings: AiSettings, question: string, answer: Message, hits: SearchHit[]): Promise<void> {
    try {
      const model = createModel(this.env, ref.workspaceId, settings, "followups");
      const { text } = await completeText({
        model: model.model,
        ...model.prompt(followUpsPrompt()),
        messages: [{ role: "user", content: followUpsInput(question, answer.body, hits) }],
        maxOutputTokens: 1000,
        abortSignal: AbortSignal.timeout(15_000),
      });
      const followUps = parseFollowUpLines(text);
      if (!followUps.length) return;
      const meta: MessageMeta = { ...answer.meta, followUps };
      await this.env.DB.prepare("UPDATE messages SET meta = ? WHERE id = ?").bind(JSON.stringify(meta), answer.id).run();
      this.#broadcast({ type: "message", message: { ...answer, meta } });
    } catch (error) {
      console.error("follow-up questions failed:", error);
    }
  }

  /** The customer as the host app verified them (V-03), or null for anonymous visitors. */
  async #verifiedCustomer(ref: ConversationRef): Promise<ToolUser | null> {
    const row = await this.env.DB.prepare(
      `SELECT ct.id, ct.external_id, ct.name, ct.email, ct.attributes FROM conversations c JOIN contacts ct ON ct.id = c.contact_id
       WHERE c.id = ? AND ct.external_id IS NOT NULL AND ct.verified_at IS NOT NULL`,
    )
      .bind(ref.conversationId)
      .first<{ id: string; external_id: string; name: string | null; email: string | null; attributes: string }>();
    if (!row) return null;
    // AI-24: their own keys for actions, from their latest identity token while it's valid.
    let secrets: Record<string, string> | null = null;
    try {
      secrets = await this.env.WORKSPACE_HUB.getByName(ref.workspaceId).userSecrets(row.id);
    } catch (error) {
      console.error("the customer's keys couldn't be loaded:", error);
    }
    return { id: row.external_id, name: row.name, email: row.email, attributes: JSON.parse(row.attributes) as ToolUser["attributes"], ...(secrets ? { secrets } : {}) };
  }

  /** Hands an AI conversation to the team: tells the visitor, and leaves agents a brief (AI-04). */
  /** The visitor's latest browser snapshot as prompt lines (P1). */
  async #technicalContext(ref: ConversationRef): Promise<{ lines: string[]; timezone: string | null; pagePath: string | null }> {
    const row = await this.env.DB.prepare("SELECT context FROM debug_snapshots WHERE conversation_id = ? ORDER BY created_at DESC LIMIT 1")
      .bind(ref.conversationId)
      .first<{ context: string }>();
    if (!row) return { lines: [], timezone: null, pagePath: null };
    const context = JSON.parse(row.context) as DebugContext;
    let pagePath: string | null = null;
    try {
      pagePath = new URL(context.page.url).pathname;
    } catch {
      // not a full URL (masked or odd): no page scoping this turn
    }
    return {
      lines: [`Page: ${context.page.url}${context.page.title ? ` ("${context.page.title}")` : ""}`, ...describeEvents(context).slice(-25)],
      timezone: context.timezone || null,
      pagePath,
    };
  }

  async #handoff(ref: ConversationRef, reason: string, visitorText: string, settings?: AiSettings, history?: Message[], technical: string[] = []): Promise<void> {
    const changed = await this.env.DB.prepare("UPDATE conversations SET handling = 'human', status = 'open' WHERE id = ? AND handling = 'ai'")
      .bind(ref.conversationId)
      .run();
    if (changed.meta.changes === 0) return;
    const key = newId("handoff");
    await this.#insert(ref, { authorType: "system", authorId: null, authorName: null, body: visitorText, clientMsgId: `${key}:visitor`, meta: { handoffReason: reason } });

    let brief = "";
    if (settings && history) {
      try {
        const model = createModel(this.env, ref.workspaceId, settings, "brief");
        const transcript =
          history.map((m) => `${m.authorType === "visitor" ? "Customer" : m.authorType === "ai" ? "AI" : "Agent"}: ${m.body}`).join("\n") +
          (technical.length ? `\n\nTechnical context from the customer's browser:\n${technical.join("\n")}` : "");
        const { text } = await completeText({
          model: model.model,
          ...model.prompt(briefPrompt()),
          messages: [{ role: "user", content: transcript.slice(-6000) }],
          maxOutputTokens: 1500,
          abortSignal: AbortSignal.timeout(20_000),
        });
        brief = text.trim();
      } catch (error) {
        console.error("handoff brief failed:", error);
      }
    }
    await this.#insert(ref, {
      authorType: "system",
      authorId: null,
      authorName: null,
      body: `Handed off to the team. Reason: ${reason}${brief ? `\n\n${brief}` : ""}`,
      clientMsgId: `${key}:brief`,
      internal: true,
      meta: { handoffReason: reason },
    });
    await this.#autoAssign(ref);
  }

  /**
   * The chat just started needing a person (handoff, or a new chat while the AI is off).
   * I-02: round robin to an online teammate, with a note so the team sees why.
   * I-14: notify the assignee, or, if it's still unassigned, everyone who wants to know.
   */
  async #autoAssign(ref: ConversationRef): Promise<void> {
    try {
      const picked = await autoAssign(this.env, ref);
      if (picked) {
        await this.#insert(ref, {
          authorType: "system",
          authorId: null,
          authorName: null,
          body: `Assigned to ${picked.name} automatically (round robin).`,
          clientMsgId: newId("assign"),
          internal: true,
        });
        this.ctx.waitUntil(notifyTeam(this.env, ref, { kind: "assigned", actorId: null, targets: [picked.userId], auto: true }));
        return;
      }
    } catch (error) {
      // Assignment is a convenience: the chat is still in the shared inbox.
      console.error("auto-assignment failed:", error);
    }
    const row = await this.env.DB.prepare("SELECT assignee_id FROM conversations WHERE id = ? AND status = 'open' AND handling = 'human'").bind(ref.conversationId).first<{ assignee_id: string | null }>();
    // Someone may have taken it in the meantime; then they don't need telling.
    if (row && row.assignee_id === null) this.ctx.waitUntil(notifyTeam(this.env, ref, { kind: "needs_person", actorId: null }));
  }

  async #recordUsage(workspaceId: string, month: string, usage: { inputTokens: number; outputTokens: number }): Promise<void> {
    await this.env.DB.prepare(
      `INSERT INTO ai_usage (workspace_id, month, replies, input_tokens, output_tokens) VALUES (?1, ?2, 1, ?3, ?4)
       ON CONFLICT (workspace_id, month) DO UPDATE SET replies = replies + 1, input_tokens = input_tokens + ?3, output_tokens = output_tokens + ?4`,
    )
      .bind(workspaceId, month, usage.inputTokens, usage.outputTokens)
      .run();
  }

  /** AI-11: one row per tool call; agents see them next to the conversation. */
  async #recordAction(ref: ConversationRef, messageSeq: number, configVersion: number | null, action: ToolAction): Promise<void> {
    try {
      const scrub = secretScrubber(this.env);
      await this.env.DB.prepare(
        `INSERT INTO ai_actions (id, workspace_id, conversation_id, message_seq, config_version, tool, input, output, status, http_status, duration_ms, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
        .bind(newId("act"), ref.workspaceId, ref.conversationId, messageSeq, configVersion, action.tool, scrub(JSON.stringify(action.input)), scrub(action.output), action.status, action.httpStatus, action.durationMs, Date.now())
        .run();
      this.#broadcast({ type: "ai_action", tool: action.tool, status: action.status }, { agentsOnly: true });
    } catch (error) {
      console.error("recording AI action failed:", error);
    }
  }

  // ---------- AI-21 page actions ----------

  /** W-31: what the hub was last told, so a chat tells it only when its page's actions change. */
  #notedActions = "";

  /** W-31: the Agent page lists the website actions seen on the customer's site (and picks their cards). */
  async #notePageActions(ref: ConversationRef, actions: PageAction[]): Promise<void> {
    const seen = actions.map((a) => ({ name: a.name, description: a.description, params: Object.keys(a.params), risk: a.risk, ...(a.widget ? { widget: a.widget } : {}), ...(a.statusLine ? { statusLine: a.statusLine } : {}) }));
    const key = JSON.stringify(seen);
    if (!seen.length || key === this.#notedActions) return;
    this.#notedActions = key;
    try {
      await this.env.WORKSPACE_HUB.getByName(ref.workspaceId).notePageActions(seen);
    } catch (error) {
      console.warn("noting page actions failed:", error);
    }
  }

  /** The card for an action the model chose: its inputs checked, the rest asked for by the widget. */
  #proposeAction(action: PageAction, rawInput: Record<string, unknown>): MessageAction {
    const { input, missing } = checkInput(action, rawInput);
    return {
      runId: newId("run"),
      id: action.id,
      name: action.name,
      tool: action.tool,
      description: action.description,
      risk: action.risk === "auto" ? "auto" : "confirm",
      params: action.params,
      required: action.required,
      input,
      missing,
      status: "pending",
      result: null,
      canUndo: false,
      ...(action.widget ? { widget: action.widget } : {}),
      ...(action.statusLine ? { statusLine: action.statusLine } : {}),
    };
  }

  /**
   * Changes a proposed action's card (the AI message's `meta.action`) and sends the message again
   * to everyone: the thread merges by seq, so the card updates in place. `patch` returns null to
   * leave it alone (wrong state, unknown run). Returns the new card.
   */
  async #updateAction(
    ref: ConversationRef,
    runId: string,
    patch: (action: MessageAction) => MessageAction | null,
    /** More of the message's meta to change with it (W-31: the result's card). */
    more?: (meta: MessageMeta) => Partial<MessageMeta>,
  ): Promise<MessageAction | null> {
    if (!/^run_[\w-]{1,64}$/.test(runId)) return null;
    const row = await this.env.DB.prepare(`${MESSAGE_SELECT} WHERE m.conversation_id = ? AND m.author_type = 'ai' AND m.meta LIKE ? ORDER BY m.seq DESC LIMIT 1`)
      .bind(ref.conversationId, `%"runId":"${runId}"%`)
      .first<MessageRow>();
    if (!row) return null;
    const message = toMessage(row);
    const current = message.meta.action;
    if (!current || current.runId !== runId) return null;
    const next = patch(current);
    if (!next) return null;
    const meta: MessageMeta = { ...message.meta, ...more?.(message.meta), action: next };
    await this.env.DB.prepare("UPDATE messages SET meta = ? WHERE id = ?").bind(JSON.stringify(meta), message.id).run();
    this.#broadcast({ type: "message", message: { ...message, meta } });
    return next;
  }

  /**
   * The page ran the action (or couldn't): close the card, keep the audit row, tell the agents.
   * W-31: a result the desk (or the page) gave a widget is drawn as that card on the same message.
   */
  async #actionResult(ref: ConversationRef, event: { runId: string; status: string; result?: unknown; canUndo?: unknown; data?: unknown }): Promise<void> {
    const status = event.status as MessageAction["status"];
    if (!ACTION_RESULT_STATUSES.includes(status)) return;
    const runId = String(event.runId);
    if (status !== "undone") {
      if (this.#settled.has(runId)) return;
      this.#settled.add(runId);
    }
    const result = typeof event.result === "string" && event.result.trim() ? redact(event.result, MAX_ACTION_RESULT) : null;
    const config = status === "cancelled" || status === "gone" ? null : await loadAgentConfig(this.env, ref.workspaceId);
    let card: MessageWidget | null = null;
    let cardNote = "";
    const updated = await this.#updateAction(
      ref,
      runId,
      (action) => {
        // pending → any result; ok → undone. Nothing else moves.
        if (action.status === "pending" && status !== "undone") {
          const next: MessageAction = { ...action, status, result, canUndo: status === "ok" && event.canUndo === true };
          const spec = status === "ok" && config ? pageActionWidget(config.widgets, action.name, action.widget) : null;
          if (spec) {
            const shown = pageActionCard(spec, event.data, `wp${runId.slice(4)}`);
            if ("card" in shown) {
              card = shown.card;
              next.card = spec.name;
            } else cardNote = ` (card ${spec.name} not shown: ${shown.error})`;
          }
          return next;
        }
        if (action.status === "ok" && status === "undone" && action.canUndo) return { ...action, status, canUndo: false };
        return null;
      },
      (meta) => (card ? { widgets: [...(meta.widgets ?? []).filter((w) => w.id !== card!.id), card] } : {}),
    );
    if (!updated) return;
    if (status === "ok" || status === "error") await this.ctx.storage.setAlarm(Date.now());
    // W-31: the result's shape (names and types, no values), so the desk can make a card for it.
    if (status === "ok" && typeof event.data === "string" && event.data.length <= MAX_PAGE_ACTION_DATA) {
      let shape: Record<string, unknown> | null = null;
      try {
        shape = resultShape(JSON.parse(event.data));
      } catch {
        // not JSON: no card to make
      }
      if (shape) this.ctx.waitUntil(this.env.WORKSPACE_HUB.getByName(ref.workspaceId).notePageActionShape(updated.name, shape).catch(() => undefined));
    }
    if (config && (status === "ok" || status === "error" || status === "undone")) {
      const row = await this.env.DB.prepare("SELECT seq FROM messages WHERE conversation_id = ? AND author_type = 'visitor' ORDER BY seq DESC LIMIT 1").bind(ref.conversationId).first<{ seq: number }>();
      await this.#recordAction(ref, row?.seq ?? 0, config.version, {
        tool: `${status === "undone" ? "undo:" : "page:"}${updated.name}`,
        input: updated.input,
        output: (status === "undone" ? "undone by the customer" : (result ?? (status === "ok" ? "done" : "failed"))) + cardNote,
        status: status === "error" ? "error" : "ok",
        httpStatus: null,
        durationMs: 0,
      });
    }
  }

  // ---------- fan-out ----------

  async #publish(ref: ConversationRef): Promise<void> {
    const conversation = await loadSummary(this.env.DB, ref.conversationId);
    if (!conversation) return;
    this.#broadcast({ type: "conversation", conversation }, { agentsOnly: true });
    this.#broadcast({ type: "conversation", conversation: forVisitor(conversation) }, { visitorsOnly: true });
    await this.env.WORKSPACE_HUB.getByName(ref.workspaceId).publish({ type: "conversation", conversation });
  }

  #send(ws: WebSocket, event: ConversationEvent): void {
    try {
      ws.send(JSON.stringify(event));
    } catch {
      // socket already closed
    }
  }

  #broadcast(event: ConversationEvent, options: { except?: WebSocket; agentsOnly?: boolean; visitorsOnly?: boolean } = {}): void {
    const data = JSON.stringify(event);
    for (const ws of this.ctx.getWebSockets(options.agentsOnly ? "agent" : options.visitorsOnly ? "visitor" : undefined)) {
      if (ws === options.except || ws.readyState !== WebSocket.OPEN) continue;
      try {
        ws.send(data);
      } catch {
        // closing
      }
    }
  }
}
