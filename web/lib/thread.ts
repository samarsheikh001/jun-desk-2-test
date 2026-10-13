import { useCallback, useEffect, useRef, useState } from "react";
import type { ActionStatus } from "../../shared/actions.ts";
import type { AiStep, Attachment, ClientEvent, ConversationEvent, ConversationSummary, Message, Source } from "../../shared/protocol.ts";
import { LiveSocket, type SocketState } from "./socket.ts";

export interface PendingMessage {
  clientMsgId: string;
  body: string;
  attachments: Attachment[];
  /** An agent's internal note (I-05). */
  internal?: boolean;
  failed?: string;
}

/**
 * Live state of one conversation, shared by the dashboard and the widget: messages
 * (merged by seq, deduped), optimistic sends, the other side's typing and read state.
 */
export function useThread(options: {
  /** null while there's no conversation yet (widget before the first message). */
  socketUrl: string | null;
  protocols?: string[];
  initialMessages: Message[];
  /** Whose typing/read state to show: the dashboard watches the visitor, the widget watches agents. */
  other: "visitor" | "agent";
  onConversation?: (conversation: ConversationSummary) => void;
  /** AI-11: the AI made a tool call (agents only; recorded before the event is sent). */
  onAiAction?: () => void;
}) {
  const [messages, setMessages] = useState<Message[]>(options.initialMessages);
  const [pending, setPending] = useState<PendingMessage[]>([]);
  const [typing, setTyping] = useState<{ name: string | null } | null>(null);
  const [otherReadSeq, setOtherReadSeq] = useState(0);
  const [state, setState] = useState<SocketState>("connecting");
  /** The AI's reply as it streams in, and whether it's working on one. */
  const [aiStream, setAiStream] = useState<{ streamId: string; text: string; sources: Source[] } | null>(null);
  const [aiThinking, setAiThinking] = useState(false);
  /** The clientMsgId the reply being written will be saved under (from the server). */
  const [aiTurn, setAiTurn] = useState<string | null>(null);
  /** Tool steps per AI reply (keyed by its clientMsgId, `ai:<seq>`), this session only: never stored. */
  const [aiSteps, setAiSteps] = useState<Record<string, AiStep[]>>({});
  const socket = useRef<LiveSocket<ConversationEvent> | null>(null);
  const lastSeq = useRef(0);
  const typingTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const onConversation = useRef(options.onConversation);
  onConversation.current = options.onConversation;
  const onAiAction = useRef(options.onAiAction);
  /** D-51: field changes sent, waiting for `widget_change_done`. */
  const changes = useRef(new Map<string, (result: { ok: boolean; message?: string }) => void>());
  /** W-27: card presses sent, by clientMsgId, until saved or refused. */
  const presses = useRef(new Map<string, (result: { ok: boolean; message?: string }) => void>());
  onAiAction.current = options.onAiAction;

  const merge = useCallback((incoming: Message[]) => {
    if (incoming.length === 0) return;
    setMessages((current) => {
      const bySeq = new Map(current.map((m) => [m.seq, m]));
      for (const m of incoming) bySeq.set(m.seq, m);
      const merged = [...bySeq.values()].sort((a, b) => a.seq - b.seq);
      lastSeq.current = merged.at(-1)?.seq ?? 0;
      return merged;
    });
    const ids = new Set(incoming.map((m) => m.clientMsgId));
    setPending((p) => p.filter((m) => !ids.has(m.clientMsgId)));
    for (const id of ids) {
      presses.current.get(id)?.({ ok: true });
      presses.current.delete(id);
    }
  }, []);

  // New initial messages replace the list in the same render (an effect would paint one empty frame first).
  const [initialSeen, setInitialSeen] = useState(options.initialMessages);
  if (initialSeen !== options.initialMessages) {
    setInitialSeen(options.initialMessages);
    setMessages(options.initialMessages);
  }
  useEffect(() => {
    lastSeq.current = options.initialMessages.at(-1)?.seq ?? 0;
  }, [options.initialMessages]);

  useEffect(() => {
    setAiSteps({}); // keyed per conversation
    if (!options.socketUrl) return;
    const base = options.socketUrl;
    const live = new LiveSocket<ConversationEvent>({
      url: () => `${base}${base.includes("?") ? "&" : "?"}since=${lastSeq.current}`,
      ...(options.protocols ? { protocols: options.protocols } : {}),
      onState: setState,
      onEvent: (event) => {
        if (event.type === "messages") merge(event.messages);
        else if (event.type === "message") {
          merge([event.message]);
          if (event.message.authorType === options.other) setTyping(null);
          if (event.message.authorType === "ai") setAiStream(null);
        } else if (event.type === "ai_status") {
          setAiThinking(event.state === "thinking");
          if (event.state === "thinking" && event.turn) setAiTurn(event.turn);
          if (event.state === "idle") {
            setAiStream(null);
            // The turn is over: nothing is still running, even if a "done" got lost.
            setAiSteps((all) => (Object.values(all).some((steps) => steps.some((s) => s.state === "running")) ? Object.fromEntries(Object.entries(all).map(([turn, steps]) => [turn, steps.map((s) => ({ ...s, state: "done" as const }))])) : all));
          }
        } else if (event.type === "ai_step") {
          const { turn, step } = event;
          setAiSteps((all) => {
            const steps = all[turn] ?? [];
            const at = steps.findIndex((s) => s.id === step.id);
            return { ...all, [turn]: at >= 0 ? steps.map((s, i) => (i === at ? step : s)) : [...steps, step] };
          });
        } else if (event.type === "ai_delta") {
          setAiStream((current) =>
            current?.streamId === event.streamId && !event.replace
              ? { streamId: event.streamId, text: current.text + event.text, sources: event.sources ?? current.sources }
              : { streamId: event.streamId, text: event.text, sources: event.sources ?? [] },
          );
        } else if (event.type === "typing" && event.authorType === options.other) {
          clearTimeout(typingTimer.current);
          setTyping(event.typing ? { name: event.name } : null);
          // Don't show "typing…" forever if the stop event gets lost.
          if (event.typing) typingTimer.current = setTimeout(() => setTyping(null), 8_000);
        } else if (event.type === "read" && event.by === options.other) {
          setOtherReadSeq((s) => Math.max(s, event.seq));
        } else if (event.type === "conversation") {
          setOtherReadSeq((s) => Math.max(s, options.other === "visitor" ? event.conversation.visitorReadSeq : event.conversation.agentReadSeq));
          onConversation.current?.(event.conversation);
        } else if (event.type === "ai_action") {
          onAiAction.current?.();
        } else if (event.type === "widget_change_done") {
          changes.current.get(event.requestId)?.({ ok: event.ok, ...(event.message ? { message: event.message } : {}) });
          changes.current.delete(event.requestId);
        } else if (event.type === "error" && event.clientMsgId) {
          const { clientMsgId, message } = event;
          const press = presses.current.get(clientMsgId);
          presses.current.delete(clientMsgId);
          // W-27: the action's widget_failed line belongs on the card, not on a failed bubble.
          if (press && event.code === "action_failed") {
            setPending((p) => p.filter((m) => m.clientMsgId !== clientMsgId));
            press({ ok: false, message });
            return;
          }
          press?.({ ok: false });
          setPending((p) => p.map((m) => (m.clientMsgId === clientMsgId ? { ...m, failed: message } : m)));
        }
      },
    });
    socket.current = live;
    return () => {
      live.close();
      socket.current = null;
      clearTimeout(typingTimer.current);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [options.socketUrl, merge]);

  const sendEvent = useCallback((event: ClientEvent) => socket.current?.send(event) ?? false, []);

  /** Optimistically shows the message and sends it over the socket. Returns false if offline. */
  const send = useCallback(
    (body: string, attachments: Attachment[] = [], clientMsgId: string = crypto.randomUUID(), context?: unknown, internal = false, actions?: unknown) => {
      setPending((p) => [...p.filter((m) => m.clientMsgId !== clientMsgId), { clientMsgId, body, attachments, ...(internal ? { internal } : {}) }]);
      const sent = sendEvent({ type: "send", clientMsgId, body, attachments, ...(context !== undefined ? { context } : {}), ...(internal ? { internal } : {}), ...(actions !== undefined ? { actions } : {}) });
      if (!sent) setPending((p) => p.map((m) => (m.clientMsgId === clientMsgId ? { ...m, failed: "Not connected. Retry when back online." } : m)));
      return sent;
    },
    [sendEvent],
  );

  /**
   * W-09: a card's button, sent as the visitor's message (its label) with which card and what they
   * entered. Resolves once it's saved, or refused (W-27: `message` is the action's widget_failed line).
   */
  const sendWidgetAction = useCallback(
    (label: string, widgetAction: { messageId: string; widgetId: string; action: unknown; values: Record<string, string | boolean>; item?: string }, context?: unknown, actions?: unknown) =>
      new Promise<{ ok: boolean; message?: string }>((resolve) => {
        const clientMsgId = crypto.randomUUID();
        setPending((p) => [...p, { clientMsgId, body: label, attachments: [] }]);
        presses.current.set(clientMsgId, resolve);
        const sent = sendEvent({ type: "send", clientMsgId, body: label, attachments: [], widgetAction, ...(context !== undefined ? { context } : {}), ...(actions !== undefined ? { actions } : {}) });
        if (!sent) {
          presses.current.delete(clientMsgId);
          setPending((p) => p.map((m) => (m.clientMsgId === clientMsgId ? { ...m, failed: "Not connected. Retry when back online." } : m)));
          resolve({ ok: false });
        }
      }),
    [sendEvent],
  );

  /**
   * D-51: a card field's `onChangeAction`, sent quietly (no message). Resolves when the server is
   * done (the updated card arrives as a message), or with why not; offline or no answer in 20 s: not ok.
   */
  const sendWidgetChange = useCallback(
    (change: { messageId: string; widgetId: string; field: string; action: unknown; values: Record<string, string | boolean> }) =>
      new Promise<{ ok: boolean; message?: string }>((resolve) => {
        const requestId = crypto.randomUUID();
        const timer = setTimeout(() => {
          changes.current.delete(requestId);
          resolve({ ok: false, message: "No answer. Try again." });
        }, 20_000);
        changes.current.set(requestId, (result) => {
          clearTimeout(timer);
          resolve(result);
        });
        if (!sendEvent({ type: "widget_change", requestId, ...change })) {
          clearTimeout(timer);
          changes.current.delete(requestId);
          resolve({ ok: false, message: "Not connected." });
        }
      }),
    [sendEvent],
  );

  return {
    messages,
    pending,
    typing,
    otherReadSeq,
    state,
    aiStream,
    aiThinking,
    aiTurn,
    aiSteps,
    /** Visitor asks for a person (W-07). */
    requestHuman: () => sendEvent({ type: "handoff" }),
    /** AI-21: the visitor's answers for a proposed action's missing params. */
    actionInput: (runId: string, input: Record<string, unknown>) => sendEvent({ type: "action_input", runId, input }),
    /** AI-21: what the page did with the action (or that it was cancelled, gone, undone). */
    actionResult: (runId: string, status: Exclude<ActionStatus, "pending">, result?: string, canUndo?: boolean, data?: string) =>
      sendEvent({ type: "action_result", runId, status, ...(result ? { result } : {}), ...(canUndo ? { canUndo } : {}), ...(data ? { data } : {}) }),
    merge,
    send,
    sendWidgetAction,
    sendWidgetChange,
    setTyping: (isTyping: boolean) => sendEvent({ type: "typing", typing: isTyping }),
    markRead: (seq: number) => seq > 0 && sendEvent({ type: "read", seq }),
    dismissPending: (clientMsgId: string) => setPending((p) => p.filter((m) => m.clientMsgId !== clientMsgId)),
  };
}

/**
 * Sends typing=true at most every 3s while the user types, and typing=false after a
 * pause or as soon as the input is emptied.
 */
export function useTypingSignal(setTyping: (typing: boolean) => void) {
  const last = useRef(0);
  const stop = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  useEffect(() => () => clearTimeout(stop.current), []);
  return useCallback((value: string) => {
    if (!value.trim()) {
      clearTimeout(stop.current);
      if (last.current) setTyping(false);
      last.current = 0;
      return;
    }
    const now = Date.now();
    if (now - last.current > 3_000) {
      last.current = now;
      setTyping(true);
    }
    clearTimeout(stop.current);
    stop.current = setTimeout(() => {
      last.current = 0;
      setTyping(false);
    }, 4_000);
  }, [setTyping]);
}

export async function uploadFile(url: string, file: File, headers: Record<string, string> = {}): Promise<Attachment> {
  const response = await fetch(url, {
    method: "POST",
    headers: {
      "Content-Type": file.type || "application/octet-stream",
      "X-File-Name": encodeURIComponent(file.name),
      "X-Jun-Upload": "1",
      ...headers,
    },
    body: file,
  });
  const json = (await response.json().catch(() => ({}))) as { attachment?: Attachment; error?: { message: string } };
  if (!response.ok || !json.attachment) throw new Error(json.error?.message ?? `Upload failed (${response.status})`);
  return json.attachment;
}

export const isImage = (a: Attachment) => ["image/png", "image/jpeg", "image/gif", "image/webp"].includes(a.type);

export function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

export function formatTime(ms: number): string {
  const d = new Date(ms);
  const sameDay = d.toDateString() === new Date().toDateString();
  return sameDay ? d.toLocaleTimeString([], { hour: "numeric", minute: "2-digit" }) : d.toLocaleDateString([], { month: "short", day: "numeric" });
}
