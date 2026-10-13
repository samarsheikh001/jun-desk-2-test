import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type FormEvent, type ReactNode } from "react";
import { MAX_CSAT_COMMENT, type Attachment, type ConversationSummary, type CsatRating, type Message } from "../../shared/protocol.ts";
import { offersRating } from "../../shared/inbox.ts";
import { isIntentName, type IntentSpec } from "../../shared/intents.ts";
import { logoFor, radiusVars, textOn, type WidgetLook } from "../../shared/appearance.ts";
import { ACTION_ONLY_BODY, type MessageAction } from "../../shared/actions.ts";
import { actionWaits, restSummary, waitingCardLine } from "../../shared/island.ts";
import { pickOpenWidget, WIDGET_ONLY_BODY, widgetWaiting, widgetSummary, type MessageWidget } from "../../shared/widgets.ts";
import { Composer } from "../components/Composer.tsx";
import { MessageList, type AiAnswerView } from "../components/MessageList.tsx";
import { formatTime, uploadFile, useThread, useTypingSignal, type PendingMessage } from "../lib/thread.ts";
import { playChime, unlockSoundOnInteraction } from "../lib/sound.ts";
import { AiAnswer, RunSteps, runLine } from "./answer.tsx";
import { AUTO_RUN_WITHIN_MS } from "./action.tsx";
import { BarHead, Chips, Glass, Typewriter, useBarFrame } from "./bar.tsx";
import { Badge, MiniCard, useCardFrame } from "./card.tsx";
import { Island, IslandChips, IslandControls, IslandRow, IslandTop, NudgeLine, RestPill, StatusLine, type IslandState } from "./island.tsx";

// The chat UI inside the widget iframe. The visitor's token is created only when they
// first send something, so just opening the chat stores nothing in their browser.
// With consent-aware mode (V-06, `persist=0`) the token lives in memory only until the
// host page calls JunDesk.consent(true).

const storageKey = (key: string) => `jun:visitor:${key}`;
let memoryToken: string | null = null; // fallback when storage is blocked or not consented
let persist = new URLSearchParams(window.location.search).get("persist") !== "0";
/** The desk's Appearance page shows this frame with its unsaved settings (sent by postMessage). */
const preview = new URLSearchParams(window.location.search).get("preview") === "1";

function readToken(key: string): string | null {
  if (!persist) return memoryToken;
  try {
    return localStorage.getItem(storageKey(key)) ?? memoryToken;
  } catch {
    return memoryToken;
  }
}

function writeToken(key: string, token: string | null): void {
  memoryToken = token;
  if (!persist) return;
  try {
    if (token) localStorage.setItem(storageKey(key), token);
    else localStorage.removeItem(storageKey(key));
  } catch {
    // storage blocked: the session still works until the page reloads
  }
}

/** V-06: consent given (or withdrawn) on the host page. */
function setPersist(key: string, next: boolean): void {
  if (next === persist) return;
  persist = next;
  if (next) {
    writeToken(key, memoryToken);
    writeEnded(key, memoryEnded);
  } else {
    try {
      localStorage.removeItem(storageKey(key));
      localStorage.removeItem(endedKey(key));
    } catch {
      // nothing stored
    }
  }
}

// D-46: conversations the visitor ended with the island's ×. They stay open for the team, so after a
// reload the widget would go straight back into the latest one; it skips these instead. A per-browser
// convenience (same consent rules as the token), at most the last 20.
const endedKey = (key: string) => `jun:ended:${key}`;
let memoryEnded: string[] = [];

function readEnded(key: string): string[] {
  if (!persist) return memoryEnded;
  try {
    const list: unknown = JSON.parse(localStorage.getItem(endedKey(key)) ?? "[]");
    return Array.isArray(list) ? list.filter((id): id is string => typeof id === "string") : memoryEnded;
  } catch {
    return memoryEnded;
  }
}

function writeEnded(key: string, ids: string[]): void {
  memoryEnded = ids.slice(-20);
  if (!persist) return;
  try {
    localStorage.setItem(endedKey(key), JSON.stringify(memoryEnded));
  } catch {
    // storage blocked: remembered until the page reloads
  }
}

function markEnded(key: string, id: string): void {
  const ids = readEnded(key);
  if (!ids.includes(id)) writeEnded(key, [...ids, id]);
}

/** The team replied in a chat the visitor ended: it's theirs again (the widget goes back into it). */
function unEnd(key: string, id: string): void {
  const ids = readEnded(key);
  if (ids.includes(id)) writeEnded(key, ids.filter((x) => x !== id));
}

/** An opening message shown before the conversation exists: a proactive nudge or an agent's invite (V-07). */
interface Opener {
  text: string;
  inviteId?: string;
  from?: string;
  /** P-01 page opener: an offer, not about a problem (shown without "tell me what you were trying to do"). */
  page?: boolean;
}

/**
 * AI-20: the host app opened the chat with an intent (JunDesk.open({ intent, onExit })). `spec`: the
 * skill's opening, quick replies and exit (none of them for an intent no skill defines). The exit
 * button shows whenever the spec has one: the chat only starts with it when the host passed onExit.
 */
interface ChatIntent {
  spec: IntentSpec;
}

class WidgetApi {
  readonly key: string;
  token: string | null;
  constructor(key: string) {
    this.key = key;
    this.token = readToken(key);
  }

  async call<T>(path: string, init: { method?: string; body?: unknown; keepalive?: boolean } = {}): Promise<T> {
    const response = await fetch(`/api/widget/${this.key}${path}`, {
      method: init.method ?? (init.body === undefined ? "GET" : "POST"),
      // Outlives this frame when the host page navigates away right after (AI-20's "Cancel anyway").
      ...(init.keepalive ? { keepalive: true } : {}),
      headers: { ...(init.body !== undefined ? { "Content-Type": "application/json" } : {}), ...(this.token ? { "X-Visitor-Token": this.token } : {}) },
      body: init.body === undefined ? null : JSON.stringify(init.body),
    });
    const json = (await response.json().catch(() => ({}))) as { error?: { message: string } };
    if (!response.ok) throw new Error(json.error?.message ?? `Request failed (${response.status})`);
    return json as T;
  }

  /** V-03/V-04: who the host page says its signed-in user is (a JWT); may switch this browser's token. */
  async identify(userToken: string): Promise<void> {
    const { token } = await this.call<{ token: string }>("/identify", { body: { userToken } });
    writeToken(this.key, token);
    this.token = token;
  }

  /** The host app's user signed out: forget this browser's chat identity. */
  forget(): void {
    // AI-24: the server drops their own keys for actions too (best effort; they expire anyway).
    if (this.token) void this.call("/logout", { body: {}, keepalive: true }).catch(() => undefined);
    writeToken(this.key, null);
    this.token = null;
  }

  async ensureVisitor(): Promise<string> {
    if (this.token) return this.token;
    const { token } = await this.call<{ token: string }>("/visitor", { body: {} });
    writeToken(this.key, token);
    this.token = token;
    return token;
  }

  async upload(file: File): Promise<Attachment> {
    const token = await this.ensureVisitor();
    return uploadFile(`/api/widget/${this.key}/files`, file, { "X-Visitor-Token": token });
  }
}

const postToHost = (message: unknown) => window.parent !== window && window.parent.postMessage(message, "*");

/**
 * Asks the loader on the host page for its debug snapshot (recent errors, failed requests,
 * page trail; already masked) and (AI-21) the page's actions. Both undefined if there's no
 * loader or it's slow.
 */
function hostContext(): Promise<{ context?: unknown; actions?: unknown }> {
  if (window.parent === window) return Promise.resolve({});
  const id = crypto.randomUUID();
  return new Promise((resolve) => {
    const done = (value: { context?: unknown; actions?: unknown }) => {
      window.removeEventListener("message", onMessage);
      clearTimeout(timer);
      resolve(value);
    };
    const onMessage = (e: MessageEvent) => {
      if (e.source === window.parent && e.data?.type === "jun:context" && e.data.id === id) done({ context: e.data.context, actions: e.data.actions });
    };
    const timer = setTimeout(() => done({}), 500);
    window.addEventListener("message", onMessage);
    postToHost({ type: "jun:context-request", id });
  });
}
const unread = (c: ConversationSummary) => c.lastMessageAuthor === "agent" && c.lastSeq > c.visitorReadSeq;

interface WidgetConfig extends WidgetLook {
  ai: boolean;
  hours: { open: boolean; back: string | null } | null;
  /** W-12: ask for a rating when a conversation is resolved. */
  csat: boolean;
}

/** In a frame on a host page (the loader's, or the Appearance preview), as the "Ask anything…" bar. */
const asBar = (look: WidgetLook) => look.launcher === "bar" && window.parent !== window;
/** In a frame, as the morphing island (D-39). */
const asIsland = (look: WidgetLook) => look.launcher === "island" && window.parent !== window;
/** The island on its near-black surface (the default; `page` follows the theme). */
const islandDark = (look: WidgetLook) => asIsland(look) && look.islandSurface !== "page";
/** The frame's theme as drawn: `auto` follows the visitor's system, as styles.css does. */
const effectiveTheme = (look: WidgetLook): "light" | "dark" =>
  look.theme === "auto" ? (window.matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light") : look.theme;
/** Re-renders when the visitor's system switches light/dark, so `auto` picks the right logo (W-21). */
function useSystemScheme(): void {
  const [, setDark] = useState(() => window.matchMedia("(prefers-color-scheme: dark)").matches);
  useEffect(() => {
    const query = window.matchMedia("(prefers-color-scheme: dark)");
    const onChange = () => setDark(query.matches);
    query.addEventListener("change", onChange);
    return () => query.removeEventListener("change", onChange);
  }, []);
}
/** A brand colour too dark to read as a button on the near-black island (by textOn's weights). */
function tooDarkForIsland(color: string): boolean {
  if (!/^#[0-9a-f]{6}$/i.test(color)) return false;
  const n = parseInt(color.slice(1), 16);
  return (0.299 * (n >> 16) + 0.587 * ((n >> 8) & 255) + 0.114 * (n & 255)) / 255 < 0.25;
}

/** W-04: brand colour (with readable text on it), light/dark/auto and corner rounding on the frame. */
function applyLook(look: WidgetLook): void {
  const root = document.documentElement;
  if (/^#[0-9a-f]{6}$/i.test(look.color)) {
    root.style.setProperty("--accent", look.color);
    root.style.setProperty("--accent-text", textOn(look.color));
  }
  // The bar has one look (a white bar, the chat on dark glass). Its page stays light: a frame
  // whose colour scheme differs from the host page's gets an opaque backdrop. The island follows
  // the theme like the chat window; its page stays light the same way (widget.css).
  root.classList.toggle("bar", asBar(look));
  root.classList.toggle("island", asIsland(look));
  // D-39: the island's own near-black palette (widget.css, html.island-dark); a near-black brand
  // colour would vanish on it, so its buttons go white there instead.
  root.classList.toggle("island-dark", islandDark(look));
  if (islandDark(look) && tooDarkForIsland(look.color)) {
    root.style.setProperty("--accent", "#f5f5f5");
    root.style.setProperty("--accent-text", "#0c0c0d");
  }
  if (look.theme === "auto" || asBar(look)) delete root.dataset.theme;
  else root.dataset.theme = look.theme;
  for (const [name, value] of Object.entries(radiusVars(look.radius))) root.style.setProperty(name, value);
}

export function WidgetApp({ widgetKey }: { widgetKey: string }) {
  const api = useMemo(() => new WidgetApi(widgetKey), [widgetKey]);
  const [saved, setSaved] = useState<WidgetConfig | null>(null);
  /** Appearance preview only: the desk's unsaved look, on top of the saved config. */
  const [draft, setDraft] = useState<WidgetLook | null>(null);
  const config = useMemo(() => (saved && draft ? { ...saved, ...draft } : saved), [saved, draft]);
  const [conversations, setConversations] = useState<ConversationSummary[]>([]);
  /**
   * The chat opens on the ongoing conversation, or a new one; `list` is the visitor's earlier
   * conversations. `first`: a suggested question the visitor tapped, sent as the new chat's first
   * message; `human`: they asked for the team ("Contact the team"). `mount`: the key a new chat was
   * drawn under, kept once its first message creates the conversation so the thread isn't remounted
   * (no "Loading…", refetch or reconnect in the middle of the visitor's first exchange).
   */
  const [view, setView] = useState<{ kind: "list" } | { kind: "thread"; id: string | null; mount?: string; opener?: Opener; first?: string; human?: boolean; intent?: ChatIntent }>({ kind: "thread", id: null });
  /** Chats started in this frame: each new chat gets its own key (`new<n>`), see `mount`. */
  const [starts, setStarts] = useState(0);
  const threadKey = view.kind === "thread" ? (view.mount ?? view.id ?? `new${starts}`) : "list";
  const [open, setOpen] = useState(window.parent === window);
  /** D-34: the panel's Expand (740px tall), the card hidden for this page (then a "Chat with us" pill), the suggestions dismissed. */
  const [grown, setGrown] = useState(false);
  const [miniHidden, setMiniHidden] = useState(false);
  const [suggestHidden, setSuggestHidden] = useState(false);
  useSystemScheme();
  const closedRef = useRef<HTMLDivElement>(null);
  const shellRef = useRef<HTMLDivElement>(null);
  const [error, setError] = useState<string | null>(null);
  /** The loader's live session (V-01), sent with a new conversation so the visitor list can show it. */
  const [sessionId, setSessionId] = useState<string | null>(null);
  /** Bumped when this browser's identity changes, to reload its conversations. */
  const [identityVersion, setIdentityVersion] = useState(0);
  /** A returning visitor's conversations are loading: skeleton, not the new-chat greeting it may jump from. */
  const [restoring, setRestoring] = useState(() => Boolean(api.token));

  useEffect(() => {
    api.call<WidgetConfig>("/config").then(
      (c) => setSaved(c),
      (e: Error) => setError(e.message),
    );
  }, [api]);

  useEffect(() => {
    if (!api.token) {
      setConversations([]);
      setRestoring(false);
      return;
    }
    let live = true;
    api.call<{ conversations: ConversationSummary[] }>("/conversations").then(
      (r) => {
        setConversations(r.conversations);
        // Go straight back into an ongoing conversation.
        // (Not one the visitor ended with the island's ×, D-46, unless the team has replied there
        // since: that one is un-ended and opened, so the pill says "New reply from …".)
        const ended = readEnded(api.key);
        const replied = r.conversations.filter((c) => ended.includes(c.id) && unread(c));
        for (const c of replied) unEnd(api.key, c.id);
        const active = replied[0] ?? r.conversations.find((c) => c.status !== "resolved" && !ended.includes(c.id));
        setView((v) => (active && !(v.kind === "thread" && (v.id || v.opener || v.intent || v.first || v.human)) ? { kind: "thread", id: active.id } : v));
        // AI-20 hard rule (D-37): an intent's exit button stays for the whole conversation, so after a
        // reload the chat gets its intent back (the host's onExit can't come back: the button then
        // records the exit and closes the chat).
        if (active?.intent && !active.intent.exitedAt) {
          const { name } = active.intent;
          api.call<{ intent: IntentSpec | null }>(`/intents/${name}`).then(
            (res) => {
              const intent: ChatIntent = { spec: res.intent ?? { name, opening: null, replies: [], exit: null } };
              setView((v) => (v.kind === "thread" && v.id === active.id && !v.intent ? { ...v, intent } : v));
            },
            () => {},
          );
        }
      },
      () => {},
    ).finally(() => live && setRestoring(false));
    return () => {
      live = false;
    };
  }, [api, identityVersion]);

  // The loader tells us when the chat is shown or hidden (read receipts only count while shown).
  useEffect(() => {
    /**
     * AI-20: the intent's opening, replies and exit come from its skill (no AI call). Opened again in
     * the same page while its chat is on screen, it carries on there; otherwise it starts a new chat,
     * so an intent never mixes into an unrelated conversation.
     */
    const startIntent = async (name: string, hostExit: boolean) => {
      let spec: IntentSpec | null;
      try {
        spec = (await api.call<{ intent: IntentSpec | null }>(`/intents/${name}`)).intent;
      } catch (err) {
        // Can't tell whether it has an exit: a plain chat, not tagged (the AI would expect the button).
        console.warn(`[Jun Desk] couldn't load intent "${name}": ${(err as Error).message}`);
        setView({ kind: "thread", id: null });
        return;
      }
      // Hard rule (D-37): a flow with an exit button never starts without a way out.
      if (spec?.exit && !hostExit) {
        console.warn(`[Jun Desk] intent "${name}" has an exit ("${spec.exit}") but JunDesk.open() got no onExit function: opening a plain chat.`);
        setView({ kind: "thread", id: null });
        return;
      }
      // No skill defines it: a plain chat, still tagged with the intent (agents and the AI see it).
      const intent: ChatIntent = { spec: spec ?? { name, opening: null, replies: [], exit: null } };
      setView((v) => (v.kind === "thread" && v.intent?.spec.name === name ? { ...v, intent } : { kind: "thread", id: null, intent }));
    };
    const onMessage = (e: MessageEvent) => {
      if (e.source !== window.parent) return;
      const data = e.data as Record<string, unknown> | null;
      // The Appearance page's draft: same origin only (it's the desk itself).
      if (preview && data?.type === "jun:preview" && e.origin === window.location.origin && data.look) {
        setDraft(data.look as WidgetLook);
      }
      if (data?.type === "jun:open") setOpen(true);
      if (data?.type === "jun:close") setOpen(false);
      if (data?.type === "jun:session" || data?.type === "jun:consent") {
        if (typeof data.persist === "boolean") setPersist(api.key, data.persist);
        if (typeof data.sessionId === "string") setSessionId(data.sessionId);
      }
      // Who the host page's signed-in user is (or that they signed out).
      if ((data?.type === "jun:session" && typeof data.userToken === "string") || data?.type === "jun:identify") {
        const userToken = typeof data.userToken === "string" ? data.userToken : null;
        if (userToken) {
          api.identify(userToken).then(
            () => setIdentityVersion((n) => n + 1),
            (err: Error) => console.warn(`[Jun Desk] identify failed: ${err.message}`),
          );
        } else {
          api.forget();
          setView({ kind: "thread", id: null });
          setIdentityVersion((n) => n + 1);
        }
      }
      // The visitor clicked "Chat with us" on a nudge or an agent's invite: a new chat with that opener.
      const opener = data?.type === "jun:proactive" ? (data.opener as Opener | undefined) : undefined;
      // AI-20: the host app opened the chat with an intent.
      const wanted = data?.type === "jun:proactive" ? (data.opener as { intent?: unknown; exit?: unknown } | undefined) : undefined;
      if (wanted && isIntentName(wanted.intent)) {
        if (typeof data!.sessionId === "string") setSessionId(data!.sessionId);
        postToHost({ type: "jun:proactive-shown" });
        void startIntent(wanted.intent, wanted.exit === true);
      } else if (opener && typeof opener.text === "string") {
        if (typeof data!.sessionId === "string") setSessionId(data!.sessionId);
        setView({
          kind: "thread",
          id: null,
          opener: {
            text: opener.text.slice(0, 1000),
            ...(typeof opener.inviteId === "string" ? { inviteId: opener.inviteId } : {}),
            ...(typeof opener.from === "string" ? { from: opener.from.slice(0, 120) } : {}),
            ...(opener.page ? { page: true } : {}),
          },
        });
        postToHost({ type: "jun:proactive-shown" });
      }
    };
    window.addEventListener("message", onMessage);
    // Only now can we hear the loader's reply, so ask for the current state.
    postToHost({ type: "jun:ready" });
    return () => window.removeEventListener("message", onMessage);
  }, [api]);

  // Before paint: the island and the bar size their frame before paint too, and their first paint
  // must already be on the transparent page (html.island / html.bar), not the plain white one.
  useLayoutEffect(() => {
    if (config) applyLook(config);
  }, [config]);

  useEffect(() => {
    postToHost({ type: "jun:unread", count: conversations.filter(unread).length });
  }, [conversations]);

  const upsert = useCallback((c: ConversationSummary) => {
    setConversations((list) => [c, ...list.filter((x) => x.id !== c.id)].sort((a, b) => b.lastMessageAt - a.lastMessageAt));
  }, []);

  // D-46: when the list refreshes with a new team reply in a chat the visitor ended (×), it's
  // un-ended, and opened if nothing else is on screen (a fresh chat), as on load. Only for a reply
  // that arrived since the list last had that conversation (lastSeq grew), so a chat ended just now
  // whose read receipt hasn't come back yet doesn't bounce back.
  const seenSeq = useRef(new Map<string, number>());
  useEffect(() => {
    const ended = readEnded(api.key);
    let back: string | null = null;
    for (const c of conversations) {
      const before = seenSeq.current.get(c.id);
      seenSeq.current.set(c.id, c.lastSeq);
      if (before === undefined || c.lastSeq <= before || !ended.includes(c.id) || !unread(c)) continue;
      unEnd(api.key, c.id);
      back ??= c.id;
    }
    if (!back) return;
    const id = back;
    setView((v) => (v.kind === "thread" && !(v.id || v.opener || v.intent || v.first || v.human) ? { kind: "thread", id } : v));
  }, [api, conversations]);

  // W-04 card launcher (D-34): the frame draws the closed card itself, and sizes itself to it.
  const cardLauncher = Boolean(config && config.launcher === "card" && window.parent !== window);
  const framed = Boolean(config && !asBar(config) && !asIsland(config) && window.parent !== window);
  useCardFrame(cardLauncher, config?.position ?? "right", open && framed, grown && framed, closedRef, miniHidden);
  useLayoutEffect(() => {
    document.documentElement.classList.toggle("mini", cardLauncher && !open);
  }, [cardLauncher, open]);
  // The panel's entrance (the reference's `enter .25s ease-out`), drawn here to keep the loader small.
  // Started before paint, so the frame's first open paint (maybe still card-sized) is transparent.
  useLayoutEffect(() => {
    if (!framed || !open || window.matchMedia("(prefers-reduced-motion: reduce)").matches) return;
    shellRef.current?.animate([{ opacity: 0, transform: "translateY(12px)" }, { opacity: 1, transform: "none" }], { duration: 250, easing: "ease-out" });
  }, [framed, open]);
  // Esc closes the chat, as it did.
  useEffect(() => {
    if (!framed || !open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") postToHost({ type: "jun:close" });
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [framed, open]);

  if (error) return <div className="w-shell"><p className="error pad">{error}</p></div>;
  if (!config) return <div className="w-shell" />;

  const threadProps = {
    api,
    csat: config.csat,
    away: Boolean(config.hours && !config.hours.open),
    placeholder: config.placeholder,
    sessionId,
    aiEnabled: config.ai,
    open,
    sound: config.sound !== false,
    restoring,
    onStarted: (c: ConversationSummary) => {
      upsert(c);
      // Keep the proactive opener at the top of the conversation it started, and the same thread on screen.
      setView((v) => ({
        kind: "thread",
        id: c.id,
        mount: v.kind === "thread" ? (v.mount ?? v.id ?? `new${starts}`) : c.id,
        ...(v.kind === "thread" && v.opener ? { opener: v.opener } : {}),
        ...(v.kind === "thread" && v.human ? { human: true } : {}),
        ...(v.kind === "thread" && v.intent ? { intent: v.intent } : {}),
      }));
      setStarts((n) => n + 1);
    },
    onConversation: upsert,
    // AI-20: after the exit button the loader closes the chat; it reopens as a plain chat.
    endIntent: () => setView((v) => (v.kind === "thread" && v.intent ? { kind: "thread", id: v.id, ...(v.mount ? { mount: v.mount } : {}) } : v)),
  };

  // W-04 bar launcher (D-32) and island (D-39): one conversation at a time, opened from the control itself.
  if (asBar(config) || asIsland(config)) {
    const id = view.kind === "thread" ? view.id : null;
    const setBarOpen = (next: boolean) => {
      setOpen(next);
      postToHost({ type: next ? "jun:open" : "jun:close" });
    };
    const away = config.hours && !config.hours.open ? `back ${config.hours.back ?? "soon"}` : null;
    if (asIsland(config)) {
      const summary = conversations.find((c) => c.id === id) ?? null;
      const cardTheme = islandDark(config) ? "dark" : effectiveTheme(config);
      return (
        <WidgetThread
          key={threadKey}
          {...threadProps}
          conversationId={id}
          summary={summary}
          opener={view.kind === "thread" ? view.opener : undefined}
          intent={view.kind === "thread" ? view.intent : undefined}
          island={{
            name: config.workspaceName,
            logoUrl: logoFor(config, cardTheme === "dark"),
            suggestions: config.suggestions,
            placeholder: config.placeholder,
            neon: config.neon,
            cardTheme,
            unread: Boolean(summary && unread(summary)),
            setOpen: setBarOpen,
            newChat: () => {
              // Older open chats too: after a reload the island starts fresh, not in one of those.
              for (const c of conversations) if (c.status !== "resolved") markEnded(api.key, c.id);
              if (id) markEnded(api.key, id);
              setView({ kind: "thread", id: null });
            },
          }}
        />
      );
    }
    return (
      <WidgetThread
        key={threadKey}
        {...threadProps}
        conversationId={id}
        summary={conversations.find((c) => c.id === id) ?? null}
        opener={view.kind === "thread" ? view.opener : undefined}
        intent={view.kind === "thread" ? view.intent : undefined}
        bar={{
          head: <BarHead name={config.workspaceName} logoUrl={logoFor(config, true)} sub={away} onClose={() => setBarOpen(false)} />,
          suggestions: config.suggestions,
          side: config.position,
          setOpen: setBarOpen,
        }}
      />
    );
  }

  const sub =
    config.hours && !config.hours.open
      ? `We're away${config.hours.back ? ` · back ${config.hours.back}` : ""}${config.ai ? ". The assistant can still help." : ""}`
      : config.replyTime;
  const opener = view.kind === "thread" ? view.opener : undefined;
  /** W-21: the chat window and the card follow the theme; on dark, the dark-background logo. */
  const logoUrl = logoFor(config, effectiveTheme(config) === "dark");
  /** The conversation the chat would show: the one on screen, else the ongoing one. */
  const current = view.kind === "thread" && view.id ? view.id : (conversations.find((c) => c.status !== "resolved")?.id ?? null);
  const openChat = (next?: typeof view) => {
    if (next) setView(next);
    setOpen(true);
    postToHost({ type: "jun:open" });
  };

  // Closed, as the card launcher: the welcome card, or the "Chat with us" pill once it's hidden.
  if (cardLauncher && !open) {
    return (
      <div className="w-closed" ref={closedRef}>
        {miniHidden ? (
          <button className="w-launcher" onClick={() => openChat()}>Chat with us</button>
        ) : (
          <MiniCard
            name={config.workspaceName}
            sub={opener?.from ?? sub}
            logoUrl={logoUrl}
            welcome={opener ? (opener.page || opener.inviteId ? opener.text : `${opener.text} Tell me what you were trying to do and I'll take a look.`) : config.greeting}
            placeholder={config.placeholder}
            onOpen={() => openChat()}
            onContact={() => openChat({ kind: "thread", id: current, human: true })}
            onNewChat={() => openChat({ kind: "thread", id: null })}
            onHide={() => setMiniHidden(true)}
            icon={(d) => <Icon d={d} />}
          />
        )}
      </div>
    );
  }

  return (
    <div className={`w-shell ${view.kind}`} ref={shellRef}>
      <header className="w-head">
        <span className="w-title">
          {view.kind === "thread" && conversations.some((c) => c.id !== view.id) && (
            <button className="w-hdr-btn" aria-label="Your conversations" title="Your conversations" onClick={() => setView({ kind: "list" })}>
              <Icon d="M15 18l-6-6 6-6" />
            </button>
          )}
          <img className="w-agent-icon" src={logoUrl ?? "/jun-agent.svg"} alt="" />
          <span className="w-name-wrap">
            <span className="w-name">{config.workspaceName}</span>
            <span className="w-sub">{sub}</span>
          </span>
        </span>
        {framed && (
          <span className="w-hdr-actions">
            <button className="w-hdr-btn" aria-label={grown ? "Minimize" : "Expand"} title={grown ? "Minimize" : "Expand"} onClick={() => setGrown((g) => !g)}>
              <Icon d={grown ? "M6 9l6 6 6-6" : "M18 15l-6-6-6 6"} />
            </button>
            <button className="w-close" aria-label="Close chat" onClick={() => postToHost({ type: "jun:close" })}>×</button>
          </span>
        )}
      </header>
      {view.kind === "list" ? (
        <div className="w-home">
          <section className="w-history" aria-labelledby="w-history-title">
            <h3 id="w-history-title" className="w-suggest-head">Your conversations</h3>
            <ul>
              {conversations.map((c) => (
                <li key={c.id}>
                  <button className={`w-conv ${unread(c) ? "unread" : ""}`} onClick={() => setView({ kind: "thread", id: c.id })}>
                    <span className="w-conv-text">
                      <span className="w-conv-preview">{c.lastMessagePreview || "Conversation"}</span>
                      <span className="w-conv-meta">{c.status === "resolved" ? "Resolved · " : ""}{formatTime(c.lastMessageAt)}</span>
                    </span>
                    {unread(c) && <span className="w-dot" role="img" aria-label="New reply" />}
                  </button>
                </li>
              ))}
            </ul>
          </section>
          <div className="w-actions">
            <button className="w-action-btn" onClick={() => setView({ kind: "thread", id: null })}>Start a new chat</button>
          </div>
          <Badge />
        </div>
      ) : (
        <WidgetThread
          key={threadKey}
          {...threadProps}
          conversationId={view.id}
          summary={conversations.find((c) => c.id === view.id) ?? null}
          opener={view.opener}
          intent={view.intent}
          first={view.first}
          classic={{
            greeting: config.greeting,
            suggestions: suggestHidden ? [] : config.suggestions,
            hideSuggestions: () => setSuggestHidden(true),
            human: Boolean(view.human),
            askHuman: () => setView((v) => (v.kind === "thread" ? { ...v, human: true } : v)),
            newChat: () => setView({ kind: "thread", id: null }),
          }}
        />
      )}
    </div>
  );
}

/** A line icon on the earlier Jun Desk widget's 24px grid (shown at 18px). */
function Icon({ d }: { d: string }) {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d={d} />
    </svg>
  );
}

function WidgetThread({
  classic,
  api,
  conversationId,
  summary,
  csat,
  away,
  opener,
  first,
  placeholder,
  sessionId,
  aiEnabled,
  open,
  sound,
  restoring,
  onStarted,
  onConversation,
  endIntent,
  intent,
  bar,
  island,
}: {
  api: WidgetApi;
  conversationId: string | null;
  summary: ConversationSummary | null;
  csat: boolean;
  away: boolean;
  opener?: Opener | undefined;
  first?: string | undefined;
  placeholder: string;
  sessionId: string | null;
  aiEnabled: boolean;
  open: boolean;
  /** W-20: chime for a new reply while the visitor isn't looking. */
  sound: boolean;
  /** The app is still finding the visitor's ongoing conversation (a new chat may turn into it). */
  restoring: boolean;
  onStarted: (c: ConversationSummary) => void;
  onConversation: (c: ConversationSummary) => void;
  endIntent: () => void;
  intent?: ChatIntent | undefined;
  /** W-04 bar launcher: the chat panel's header, the suggested questions, and opening or folding it. */
  bar?: { head: ReactNode; suggestions: string[]; side: "left" | "right"; setOpen: (open: boolean) => void };
  /** W-04 island (D-39): what its states show, and opening or closing it. */
  island?: {
    name: string;
    logoUrl: string | null;
    suggestions: string[];
    placeholder: string;
    neon: boolean;
    /** The cards' palette: dark on the near-black surface, else the frame's theme. */
    cardTheme: "light" | "dark";
    unread: boolean;
    setOpen: (open: boolean) => void;
    newChat: () => void;
  };
  /**
   * The chat window (D-34): the greeting a new chat starts with, the suggested questions (until
   * dismissed), and the action row's "Contact the team" (W-07's handoff) and "Start a new chat".
   */
  classic?: { greeting: string; suggestions: string[]; hideSuggestions: () => void; human: boolean; askHuman: () => void; newChat: () => void };
}) {
  const [initial, setInitial] = useState<Message[] | null>(conversationId ? null : []);
  const [error, setError] = useState<string | null>(null);
  /** First message is on its way (no conversation yet): show it, and the AI's dots, right away. */
  const [starting, setStarting] = useState<string | null>(null);
  const handling = summary?.handling ?? null;
  const contact = summary?.contact ?? null;
  /** This thread created its conversation: it already has the first message, no need to load it. */
  const startedHere = useRef(false);

  useEffect(() => {
    if (!conversationId || startedHere.current) return;
    api.call<{ conversation: ConversationSummary; messages: Message[] }>(`/conversations/${conversationId}`).then(
      (r) => {
        setInitial(r.messages);
        onConversation(r.conversation);
      },
      (e: Error) => setError(e.message),
    );
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [api, conversationId]);

  const thread = useThread({
    socketUrl: conversationId && initial ? `/api/widget/${api.key}/conversations/${conversationId}/ws` : null,
    ...(api.token ? { protocols: [api.token] } : {}),
    initialMessages: useMemo(() => initial ?? [], [initial]),
    other: "agent",
    onConversation,
  });
  const onTyping = useTypingSignal(thread.setTyping);

  const lastMessage = thread.messages.at(-1);
  // W-27: a card's press its action's widget_done line answered: the AI won't answer it.
  const pressAnswered = lastMessage?.authorType === "visitor" && Boolean(lastMessage.meta.widgetAction?.tool?.done);
  // An agent's invite starts a conversation with that agent, not the AI.
  const awaitingAi = Boolean(
    (handling === "ai" || (!conversationId && starting && aiEnabled && !opener?.inviteId)) &&
      !thread.aiStream &&
      (thread.pending.length > 0 || (lastMessage?.authorType === "visitor" && !pressAnswered) || starting),
  );

  const latest = lastMessage?.seq ?? 0;
  useEffect(() => {
    if (open && document.visibilityState === "visible" && latest > 0) thread.markRead(latest);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [latest, open, thread.state]);

  // W-20: a soft chime for a new public reply: a teammate's always, the AI's while the visitor isn't
  // looking (the widget folded or closed, or the tab hidden). Messages the thread loaded with it (history) only set
  // where "new" starts; a reply updated in place keeps its seq, so it never chimes twice.
  useEffect(() => {
    if (sound) unlockSoundOnInteraction();
  }, [sound]);
  const heardSeq = useRef<number | null>(null);
  const openRef = useRef(open);
  openRef.current = open;
  useEffect(() => {
    if (initial === null) return; // still loading the history
    const top = thread.messages.at(-1)?.seq ?? 0;
    if (heardSeq.current === null) {
      heardSeq.current = top;
      return;
    }
    const since = heardSeq.current;
    if (top <= since) return;
    heardSeq.current = top;
    const fresh = thread.messages.filter((m) => m.seq > since && !m.internal);
    // A teammate's reply chimes even with the chat open: it comes minutes later, when the visitor has
    // looked away. An AI reply only while they aren't looking (it streams in front of them).
    const teammate = fresh.some((m) => m.authorType === "agent");
    const ai = fresh.some((m) => m.authorType === "ai");
    if (sound && (teammate || (ai && (!openRef.current || document.visibilityState === "hidden")))) playChime();
  }, [thread.messages, initial, sound]);

  const startingId = useRef("");
  // Creating the conversation takes a round trip. Messages sent meanwhile are held (shown as
  // sending, under the ids they'll be saved with) and go into that conversation once its socket is
  // open; without this, each of them started a conversation of its own.
  const creating = useRef(false);
  const [held, setHeld] = useState<PendingMessage[]>([]);
  /** How many are held right now (synchronous, unlike `held`): a message written meanwhile queues behind them. */
  const holding = useRef(0);
  // Messages go out in the order they were written: each waits for the one before it (each first
  // asks the page for its context, and those replies can come back in any order).
  const flushing = useRef<Promise<void>>(Promise.resolve());
  const send = async (body: string, attachments: Attachment[]) => {
    setError(null);
    if (conversationId ? holding.current > 0 : creating.current) {
      holding.current++;
      setHeld((h) => [...h, { clientMsgId: crypto.randomUUID(), body, attachments }]);
      return;
    }
    if (conversationId) {
      thread.setTyping(false);
      flushing.current = flushing.current.then(async () => {
        const { context, actions } = await hostContext();
        thread.send(body, attachments, undefined, context, false, actions);
      });
      return;
    }
    // First message: its bubble shows at once under the id it's saved with, so it stays the same
    // element once saved. Marked before anything is awaited, so a quick second send is held.
    creating.current = true;
    startingId.current = crypto.randomUUID();
    setStarting(body);
    const { context, actions } = await hostContext();
    // Create the visitor (if needed) and the conversation in one go.
    try {
      await api.ensureVisitor();
      const r = await api.call<{ conversation: ConversationSummary; message: Message }>("/conversations", {
        body: {
          clientMsgId: startingId.current,
          body,
          attachments,
          context,
          ...(actions !== undefined ? { actions } : {}),
          ...(opener?.inviteId ? { inviteId: opener.inviteId } : {}),
          ...(intent ? { intent: intent.spec.name } : {}),
          ...(sessionId ? { sessionId } : {}),
        },
      });
      startedHere.current = true;
      setInitial([r.message]);
      setStarting(null);
      onStarted(r.conversation);
    } catch (e) {
      creating.current = false;
      setStarting(null);
      setError((e as Error).message);
    }
  };
  // Still "creating" until the conversation reaches this thread, so nothing slips through the gap.
  useEffect(() => {
    if (conversationId) creating.current = false;
  }, [conversationId]);
  useEffect(() => {
    if (!conversationId || !held.length || thread.state !== "open") return;
    const batch = held;
    setHeld([]);
    holding.current -= batch.length;
    flushing.current = flushing.current.then(async () => {
      const { context, actions } = await hostContext();
      for (const m of batch) thread.send(m.body, m.attachments, m.clientMsgId, context, false, actions);
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [conversationId, held, thread.state]);

  // AI-21: the AI's answers may propose a page action; its card runs it on the host page through
  // the loader (jun:run / jun:undo) and the loader reports back (jun:action).
  const [undoErrors, setUndoErrors] = useState<Record<string, string>>({});
  // Runs started here, until the page reports back (the card hides, the steps list shows a spinner).
  const [running, setRunning] = useState<Record<string, true>>({});
  // Runs started in this window. A run counts as running until the server's copy leaves "pending":
  // the page often answers before the server does, and a card shown again in that gap would start
  // it again (an auto action looped, re-running on the page and flooding the server with results).
  const started = useRef(new Set<string>());
  const startAction = (action: MessageAction, input: Record<string, unknown>) => {
    if (started.current.has(action.runId)) return;
    started.current.add(action.runId);
    setRunning((r) => ({ ...r, [action.runId]: true }));
    postToHost({ type: "jun:run", runId: action.runId, id: action.id, input });
  };
  // D-78: an action that runs without asking starts here, not from its card: in the island a run
  // stays a line and the card isn't drawn. Only the newest message, once, and only live (as the card did).
  const autoAction = lastMessage?.authorType === "ai" ? lastMessage.meta.action : undefined;
  const autoNow = Boolean(autoAction && autoAction.status === "pending" && autoAction.risk === "auto" && !autoAction.missing.length && Date.now() - lastMessage!.createdAt < AUTO_RUN_WITHIN_MS);
  useEffect(() => {
    if (autoNow && autoAction) startAction(autoAction, autoAction.input);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [autoNow, autoAction?.runId]);
  /** A page action running on the page now (started here, or reported running). */
  // D-76: the widget the visitor opened from a chip in the island, for the exchange it belongs to.
  const [pickedWidget, setPickedWidget] = useState<{ exchange: string; id: string } | null>(null);
  // D-78: the exchange whose run the visitor opened (tapped the run's line); else a run stays a line.
  const [runOpened, setRunOpened] = useState<string | null>(null);
  // D-78: how the latest run ended, read after render: a short reply that needs nothing back folds the island.
  const runEnd = useRef<{ busy: boolean; fold: (() => void) | null }>({ busy: false, fold: null });
  const runWasBusy = useRef(false);
  // D-80: the card waiting on the visitor, read after render: a new one opens a collapsed island.
  const waitingCard = useRef<{ key: string | null; fresh: boolean; loaded: boolean; open: (() => void) | null }>({ key: null, fresh: false, loaded: false, open: null });
  const seenCard = useRef<{ key: string | null; loaded: boolean } | undefined>(undefined);
  useEffect(() => {
    const { key, fresh, loaded, open: openIt } = waitingCard.current;
    // Only a card that arrives while the chat is already on screen: not one found as its messages load.
    if (seenCard.current?.loaded && key && key !== seenCard.current.key && fresh && openIt) openIt();
    seenCard.current = { key, loaded };
  });
  useEffect(() => {
    const { busy, fold } = runEnd.current;
    if (runWasBusy.current && !busy && fold) fold();
    runWasBusy.current = busy;
  });
  const actionRunning = (a: MessageAction) => Boolean(running[a.runId]) || (started.current.has(a.runId) && a.status === "pending");
  const actionResult = useRef(thread.actionResult);
  actionResult.current = thread.actionResult;
  useEffect(() => {
    const onMessage = (e: MessageEvent) => {
      const data = e.data as { type?: string; runId?: string; status?: string; result?: string; canUndo?: boolean; data?: string } | undefined;
      if (e.source !== window.parent || data?.type !== "jun:action" || typeof data.runId !== "string") return;
      const runId = data.runId;
      if (data.status === "undo_failed") setUndoErrors((s) => ({ ...s, [runId]: data.result || "Couldn't undo that." }));
      else if (data.status === "ok" || data.status === "error" || data.status === "gone" || data.status === "undone") {
        setRunning((r) => {
          const { [runId]: _done, ...rest } = r;
          return rest;
        });
        actionResult.current(runId, data.status, data.result, data.canUndo, typeof data.data === "string" ? data.data : undefined);
      }
    };
    window.addEventListener("message", onMessage);
    return () => window.removeEventListener("message", onMessage);
  }, []);
  // Follow-ups only while the AI is still the one answering. `cardFirst`: the island's answer view.
  const renderAnswer = (answer: AiAnswerView, cardFirst = false, peeks: { widget: MessageWidget; open: () => void }[] = []) => {
    const action = answer.action;
    return (
      <AiAnswer
        answer={answer}
        peeks={peeks}
        {...(handling === "ai" ? { onFollowUp: (q: string) => void send(q, []) } : {})}
        {...(island ? { cardTheme: island.cardTheme } : {})}
        cardFirst={cardFirst}
        onWidgetAction={(messageId, widget, event) => {
          // W-09: in order with anything typed before it, with the page's context like a typed message.
          const outcome = new Promise<{ ok: boolean; message?: string }>((resolve) => {
            flushing.current = flushing.current.then(async () => {
              const { context, actions } = await hostContext();
              // Not awaited: what's typed next goes out now, not after the action has run.
              resolve(thread.sendWidgetAction(event.label, { messageId, widgetId: widget.id, action: event.action, values: event.values, ...(event.item ? { item: event.item } : {}) }, context, actions));
            });
          });
          // W-27: a refused press (the action's widget_failed line) comes back here; the card says why.
          return outcome;
        }}
        // D-51: ChatKit's handler "client" goes to the host page (the loader's widgetAction event).
        onWidgetClient={(event) => postToHost({ type: "jun:widget", action: { ...event.action, values: event.values, widget: event.widget } })}
        onWidgetChange={(messageId, widget, event) => thread.sendWidgetChange({ messageId, widgetId: widget.id, field: event.field, action: event.action, values: event.values })}
        {...(action
          ? {
              controls: {
                running: Boolean(running[action.runId]) || (started.current.has(action.runId) && action.status === "pending"),
                onInput: (input: Record<string, unknown>) => thread.actionInput(action.runId, input),
                onRun: (input: Record<string, unknown>) => startAction(action, input),
                onCancel: () => thread.actionResult(action.runId, "cancelled"),
                onUndo: () => postToHost({ type: "jun:undo", runId: action.runId }),
                ...(undoErrors[action.runId] ? { undoError: undoErrors[action.runId] } : {}),
              },
            }
          : {})}
      />
    );
  };

  // A tapped suggestion is sent once, as if typed (the ref survives StrictMode's double effect).
  const sentFirst = useRef(false);
  useEffect(() => {
    if (!first || conversationId || sentFirst.current) return;
    sentFirst.current = true;
    void send(first, []);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [first, conversationId]);

  // W-04 bar: the chat panel shows once there's something in it; the frame sizes itself to fit.
  const hasChat = Boolean(conversationId || starting || opener || intent?.spec.opening || intent?.spec.exit);
  const panel = Boolean(bar && open && hasChat);
  const bottom = useRef<HTMLDivElement>(null);
  const pill = useRef<HTMLDivElement>(null);
  useBarFrame(Boolean(bar), bar?.side ?? "right", open, panel, bottom);
  const setBarOpen = bar?.setOpen ?? island?.setOpen;
  const islandState = useIslandState({ island: Boolean(island), open, hasChat, conversationId, opener, intent, handling });
  // The box takes focus when the bar or island opens (and again once a new chat's thread, or
  // another island state, swaps the box in).
  useEffect(() => {
    if (setBarOpen && open) document.querySelector<HTMLTextAreaElement>(".b-pill textarea, .i-view textarea")?.focus();
  }, [setBarOpen, open, islandState.state]);
  // Esc folds the chat back into the bar or island; so does a click on the page while nothing's been asked.
  const sticky = bar ? panel : hasChat;
  useEffect(() => {
    if (!setBarOpen || !open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setBarOpen(false);
    };
    // Not when a file picker or the screen-capture prompt took the focus.
    const onBlur = () => {
      if (!sticky && !document.activeElement?.closest(".composer-plus")) setBarOpen(false);
    };
    document.addEventListener("keydown", onKey);
    window.addEventListener("blur", onBlur);
    return () => {
      document.removeEventListener("keydown", onKey);
      window.removeEventListener("blur", onBlur);
    };
  }, [setBarOpen, open, sticky]);

  // "Contact the team": hand an AI conversation to the team, or start one asking for them.
  const sentHuman = useRef(false);
  const contactTeam = () => {
    if (conversationId) {
      if (handling === "ai") thread.requestHuman();
      return;
    }
    sentHuman.current = true;
    classic?.askHuman();
    void send(TEAM_REQUEST, []);
  };
  const wantsHuman = Boolean(classic?.human);
  useEffect(() => {
    if (!wantsHuman) return;
    if (!conversationId) {
      if (!sentHuman.current) {
        sentHuman.current = true;
        void send(TEAM_REQUEST, []);
      }
    } else if (handling === "ai" && thread.state === "open") thread.requestHuman();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [wantsHuman, conversationId, handling, thread.state]);

  // Skeleton rows while the conversation loads (or a returning visitor's is being found); the
  // composer keeps its place, inert, so nothing jumps when the messages arrive.
  const loading = !error && (initial === null || (restoring && !conversationId && !starting && !opener && !intent && !first && !classic?.human));

  // Once the conversation exists, an invite is its first real message: don't show it twice.
  // AI-20: the intent's fixed opening (not stored); a quick reply is sent as the visitor's own message.
  const opening = intent?.spec.opening;
  const intentMessage = intent && opening ? (
    <div className="msg other ai w-opener">
      <div className="bubble">{opening}</div>
      {!conversationId && !starting && intent.spec.replies.length > 0 && (
        <div className="w-replies" role="group" aria-label="Quick replies">
          {intent.spec.replies.map((r) => (
            <button key={r} type="button" className="w-reply" onClick={() => void send(r, [])}>{r}</button>
          ))}
        </div>
      )}
    </div>
  ) : null;
  const openerMessage = intentMessage ?? (opener && !(opener.inviteId && thread.messages.length > 0) ? (
    opener.inviteId ? (
      <div className="msg other w-opener">
        <div className="meta small muted">{opener.from}</div>
        <div className="bubble">{opener.text}</div>
      </div>
    ) : (
      <div className="msg other ai w-opener">
        <div className="bubble">{opener.page ? opener.text : `${opener.text} Tell me what you were trying to do and I'll take a look.`}</div>
      </div>
    )
  ) : null);
  // AI-20 hard rule (D-37): an intent's exit button ("Cancel anyway") is always on screen for the
  // whole conversation, outside the scrolling chat, and one click: it records the exit (never waited
  // on) and hands back to the host app's onExit through the loader. No confirm step of ours.
  const exitLabel = intent?.spec.exit;
  const exit = () => {
    if (conversationId) api.call(`/conversations/${conversationId}/exit`, { body: {}, keepalive: true }).catch(() => {});
    postToHost({ type: "jun:exit" });
    endIntent();
  };
  const exitBar = exitLabel ? (
    <div className="w-exit">
      <button type="button" className="w-exit-btn" onClick={exit}>{exitLabel}</button>
    </div>
  ) : null;
  const messages = loading ? <ThreadSkeleton /> : (
        <MessageList
          messages={thread.messages}
          pending={[...(starting && !conversationId ? [{ clientMsgId: startingId.current, body: starting, attachments: [] }] : thread.pending), ...held]}
          mine={(m) => m.authorType === "visitor"}
          authorLabel={(m) => (m.authorType === "visitor" ? "You" : m.authorType === "ai" ? "AI assistant" : m.authorName ?? "Support")}
          otherReadSeq={thread.otherReadSeq}
          typing={thread.typing}
          aiStream={thread.aiStream}
          // Show the AI "typing" the instant the visitor sends, not when the server gets going.
          aiThinking={thread.aiThinking || awaitingAi}
          aiTurn={thread.aiTurn}
          pendingAuthor="You"
          aiSteps={thread.aiSteps}
          onRetry={(p) => thread.send(p.body, p.attachments, p.clientMsgId)}
          onDismiss={(p) => thread.dismissPending(p.clientMsgId)}
          renderAi={renderAnswer}
          follow="anchor"
        />
  );
  const extras = (
    <>
      {/* W-07: a person is always one click away while the AI is answering. */}
      {bar && conversationId && handling === "ai" && (
        <div className="w-human">
          <button className="link small" onClick={() => thread.requestHuman()}>Talk to a person</button>
        </div>
      )}
      {/* W-12: rate a resolved conversation someone (the team or the AI) actually answered. */}
      {conversationId && summary && offersRating(csat, summary.status, thread.messages) && (
        <CsatAsk api={api} conversationId={conversationId} rated={summary.csat.ratedThisRound} onConversation={onConversation} />
      )}
      {conversationId && (
        <EmailAsk api={api} conversationId={conversationId} contact={contact} away={away} waiting={handling === "human" ? lastVisitorWaiting(thread.messages) : null} />
      )}
    </>
  );
  // The island's box reads like its pill: a follow-up once there's a conversation (a reply in a teammate's).
  const boxPlaceholder = !island || !(conversationId || starting) ? placeholder : handling === "human" ? "Write a reply…" : "Ask a follow-up…";
  const composer = (
    <div className="w-composer-wrap" inert={loading}>
      <Composer pill placeholder={boxPlaceholder} upload={(file) => api.upload(file)} onTyping={conversationId ? onTyping : undefined} onSend={send} screenshot />
    </div>
  );

  if (island) {
    const { state, showAll, setShowAll, dismissNudge } = islandState;
    const close = () => island.setOpen(false);
    // What the assistant is doing right now: a running tool step's label, else "Thinking…".
    const lastVisitorSeq = [...thread.messages].reverse().find((m) => m.authorType === "visitor")?.seq;
    const turnSteps = (thread.aiTurn ? thread.aiSteps[thread.aiTurn] : undefined) ?? (lastVisitorSeq !== undefined ? thread.aiSteps[`ai:${lastVisitorSeq}`] : undefined) ?? thread.aiSteps["ai:stream"] ?? [];
    const running = [...turnSteps].reverse().find((s) => s.state === "running");
    // Only for a question just asked: an old chat whose last word was the visitor's (the AI never
    // answered) shows as it is, not as a status line forever.
    const justAsked = Boolean(starting) || thread.pending.length > 0 || (lastMessage?.authorType === "visitor" && Date.now() - lastMessage.createdAt < 60_000);
    const thinking = !thread.aiStream?.text && (thread.aiThinking || (awaitingAi && justAsked));
    const teammate = handling === "human" ? ([...thread.messages].reverse().find((m) => m.authorType === "agent")?.authorName ?? null) : null;
    // The latest exchange: the visitor's last message and everything after it. While one is still
    // sending, that one is the latest: the previous exchange goes at once, not when the server
    // confirms it (the island grew to fit both, then shrank).
    const sending = thread.pending.length > 0 || held.length > 0 || Boolean(starting && !conversationId);
    const from = thread.messages.findLastIndex((m) => m.authorType === "visitor");
    const recent = sending ? [] : from >= 0 ? thread.messages.slice(from) : thread.messages.slice(-3);
    // D-75: a chain of website actions is one AI message per step; the answer view keeps every step
    // under one "N steps" header from the first (the one running included), at the first step's
    // place. A step waiting on the customer (Confirm) and any widget stay out of it, shown as ever.
    const chainSteps = recent.filter((m) => m.authorType === "ai" && m.meta.action && !m.meta.widgets?.length && (m.meta.action.status !== "pending" || actionRunning(m.meta.action)));
    const anchor = chainSteps[0];
    // D-77: while the run goes, its line says what's happening; the loader (and its timer) would repeat it.
    // Its words while the AI writes ("I'll set your pickup") would show, then go when the step lands: the
    // line covers them, and the reply that ends the run shows once it's saved.
    // A step that just ended and is the newest message gets a follow-up turn (`continued` once taken):
    // between the two the run is still going, not done.
    const lastStep = recent.at(-1)?.meta.action;
    const followUpDue = Boolean(lastStep && recent.at(-1) === chainSteps.at(-1) && (lastStep.status === "ok" || lastStep.status === "error") && !lastStep.continued && !lastStep.pressed && Date.now() - recent.at(-1)!.createdAt < 60_000);
    const runBusy = Boolean(anchor) && (thread.aiThinking || awaitingAi || Boolean(thread.aiStream) || followUpDue || chainSteps.some((m) => actionRunning(m.meta.action!)));
    const shownRecent = chainSteps.length ? recent.filter((m) => m === anchor || !chainSteps.includes(m)) : recent;
    // D-76: one open widget per exchange: the one the visitor picked, else the newest still waiting
    // on them (a button or field not used yet), else the newest. Every other widget is a chip under it.
    const exchange = recent[0]?.id ?? "";
    const exchangeWidgets = shownRecent.flatMap((m) => (m.authorType === "ai" && m.meta.widgets?.length ? m.meta.widgets.map((widget) => ({ messageId: m.id, widget })) : []));
    const openWidget = pickOpenWidget(exchangeWidgets, pickedWidget?.exchange === exchange ? pickedWidget.id : null);
    const islandAi = (answer: AiAnswerView) => {
      if (!openWidget || !answer.widgets?.length) return renderAnswer(answer, true);
      if (answer.messageId !== openWidget.messageId) {
        // Its widgets are chips under the open one; a reply that was only widgets says nothing more.
        const body = answer.body.trim();
        if (!body || body === WIDGET_ONLY_BODY) return null;
        return renderAnswer({ ...answer, widgets: [] }, true);
      }
      const chips = exchangeWidgets.filter((c) => c !== openWidget).map((c) => ({ widget: c.widget, open: () => setPickedWidget({ exchange, id: c.widget.id }) }));
      return renderAnswer({ ...answer, widgets: [openWidget.widget] }, true, chips);
    };
    // No header bar: Minimize and End in the corner (on hover), the rest in IslandTop when needed.
    const controls = (
      <IslandControls
        // × ends the chat (the next question starts a new one); an intent's chat ends through its exit button.
        onEnd={conversationId && !intent ? () => { island.newChat(); close(); } : null}
        onMinimize={close}
      />
    );
    const exitButton = exitLabel ? { label: exitLabel, run: exit } : null;
    // Earlier exchanges than the one on screen (not counting system notices).
    const earlier = (sending ? thread.messages : thread.messages.slice(0, Math.max(0, from))).some((m) => m.authorType !== "system" && !m.internal);
    // W-07: a person is always one click away while the AI is answering: a quiet chip over the row.
    const human = conversationId && handling === "ai" ? (
      <div className="i-foot">
        <button type="button" className="i-pill-chip" onClick={() => thread.requestHuman()}>Talk to a person</button>
      </div>
    ) : null;
    const row = <IslandRow logoUrl={island.logoUrl}>{composer}</IslandRow>;
    const live = Boolean(thread.aiStream?.text);
    // While the AI thinks, the island is its one line ("Thinking…", a tool step's label), a follow-up
    // too (D-78: the island stays small until there's something to read), and grows with the reply.
    // Never for an intent with an exit button (D-37: the line has no room for it, and it must stay on screen).
    const answered = thread.messages.some((m) => (m.authorType === "ai" || m.authorType === "agent") && !m.internal);
    // D-78: a run of website actions stays the one-line island (its live line) unless the visitor
    // opens it, or something needs them: a Confirm, a widget waiting on them.
    const pendingAction = thread.messages.some((m) => m.authorType === "ai" && m.meta.action?.status === "pending" && m.meta.action.risk !== "auto" && !actionRunning(m.meta.action));
    // An action that runs without asking counts from the moment it arrives, before the page starts it.
    const autoNext = recent.filter((m) => m.authorType === "ai" && m.meta.action?.status === "pending" && m.meta.action.risk === "auto" && !m.meta.action.missing.length && !actionRunning(m.meta.action) && Date.now() - m.createdAt < AUTO_RUN_WITHIN_MS);
    const runPill = state === "answer" && (runBusy || autoNext.length > 0) && !pendingAction && !exchangeWidgets.some((c) => widgetWaiting(c.widget)) && runOpened !== exchange && !exitLabel && !loading;
    const runLabel = runPill ? runLine([...chainSteps, ...autoNext].map((m) => m.meta.action!), actionRunning, true).now : null;
    // When the run ends with a short reply that asks nothing (one line, no widget, no question), the
    // island folds to its pill, which shows that reply; a longer one or a question opens as ever.
    const reply = recent.at(-1);
    const shortDone = Boolean(anchor && reply && reply.authorType === "ai" && !reply.meta.action && !reply.meta.widgets?.length && reply.body.length <= 80 && !reply.body.includes("?"));
    // D-80: the one card waiting on the visitor (a Confirm or missing details, else the open widget
    // while it still waits). The island is then that card, whole, over its row: no question, steps or
    // words around it ("Show chat" has them), and it never folds itself away while the card waits.
    const confirmMsg = recent.findLast((m) => m.authorType === "ai" && actionWaits(m.meta.action) && !actionRunning(m.meta.action));
    const shownWidget = openWidget ?? (exchangeWidgets.length === 1 ? exchangeWidgets[0]! : null);
    const waitingWidget = shownWidget && widgetWaiting(shownWidget.widget) ? shownWidget : null;
    const activeCard = Boolean(confirmMsg || waitingWidget);
    const cardOnly = activeCard && runOpened !== exchange && !loading && !sending;
    // Collapsed, the pill says a card waits ("Confirm ride · tap to finish"); a card that arrives
    // while the island is collapsed opens it (that's when the visitor is needed). Not for an old one
    // found on load.
    const cardMsg = confirmMsg ?? (waitingWidget ? recent.find((m) => m.id === waitingWidget.messageId) : undefined);
    // Before this chat's messages load (a page load with the island folded), the server's line stands in.
    const serverLine = thread.messages.length ? null : (summary?.islandLine ?? null);
    const waitingLine = confirmMsg?.meta.action ? waitingCardLine({ action: confirmMsg.meta.action }) : waitingWidget ? waitingCardLine({ widget: waitingWidget.widget }) : serverLine?.waiting ? serverLine.text : null;
    waitingCard.current = {
      key: activeCard && cardMsg ? `${cardMsg.id}:${waitingWidget?.widget.id ?? "action"}` : null,
      fresh: Boolean(cardMsg && Date.now() - cardMsg.createdAt < 60_000),
      loaded: thread.messages.length > 0,
      open: !open && conversationId && handling === "ai" ? () => island.setOpen(true) : null,
    };
    runEnd.current = { busy: runPill, fold: shortDone && !activeCard && open && handling === "ai" && runOpened !== exchange ? close : null };
    // A reply starts in the line: the island grows once it outgrows one line. The few words a model
    // says before calling an action ("I'll open your usage chart") then never open the card.
    const streamText = thread.aiStream?.text.replace(/[*_`#>]+/g, "").replace(/\s+/g, " ").trim() ?? "";
    const streamLine = state === "answer" && !runPill && streamText && streamText.length <= 60 && !thread.aiStream!.text.includes("\n") && runOpened !== exchange && !exitLabel && !loading ? streamText : null;
    const shown: IslandState = runPill || streamLine ? "thinking" : state === "answer" && thinking && !loading && !exitLabel && runOpened !== exchange ? "thinking" : state;
    // It folds itself once an answer is done and has had time to be read (8 s plus its reading
    // time, at most 30 s), never while anything waits on the visitor or the AI, nor in an intent's
    // or a teammate's chat (useAutoFold has the rest: in use, or scrolled down).
    const actionWaiting = thread.messages.some((m) => m.authorType === "ai" && m.meta.action?.status === "pending");
    const settled = !thinking && !awaitingAi && !thread.aiThinking && !thread.aiStream && !sending && !running && !actionWaiting && !activeCard && !loading && !error;
    const autoFold = open && shown === "answer" && conversationId && !intent && handling === "ai" && answered && settled ? close : null;
    // D-79: a one-line pill hugs its line: the working line, and the folded chat's reply (or an unread
    // teammate reply); the resting pill with its typed-out suggestions keeps its width.
    const folded = restSummary(thread.messages) ?? (serverLine && !serverLine.waiting ? serverLine.text : null);
    const hug = shown === "thinking" || (shown === "rest" && Boolean(island.unread || waitingLine || (conversationId && folded)));
    return (
      <Island state={shown} live={live} neon={island.neon} onOpen={() => island.setOpen(true)} autoFold={autoFold} hug={hug}>
        {shown === "rest" && <RestPill logoUrl={island.logoUrl} suggestions={island.suggestions} placeholder={placeholder} unread={island.unread ? `New reply${teammate ? ` from ${teammate}` : ""}` : null} summary={folded} chat={Boolean(conversationId)} waiting={waitingLine} onOpen={() => island.setOpen(true)} />}
        {shown === "nudge" && opener && <NudgeLine logoUrl={island.logoUrl} text={opener.text} from={opener.from ?? null} onAsk={() => island.setOpen(true)} onDismiss={dismissNudge} />}
        {shown === "open" && (
          <div className="i-open">
            {island.suggestions.length > 0 && <IslandChips questions={island.suggestions} onPick={(q) => void send(q, [])} />}
            {error && <p className="i-error" role="alert">{error}</p>}
            {row}
          </div>
        )}
        {shown === "thinking" && <StatusLine logoUrl={island.logoUrl} label={runLabel ?? streamLine ?? running?.label ?? "Thinking…"} onOpen={runLabel ? () => setRunOpened(exchange) : undefined} />}
        {shown === "answer" && cardOnly && (
          <div className="i-answer i-card">
            <IslandTop who={null} view={{ label: "Show chat", run: () => setRunOpened(exchange) }} exit={exitButton} />
            {/* A card taller than the island opens at its bottom, where its buttons are. */}
            <div className="i-body" role="log" ref={scrollCardOnce}>
              {confirmMsg
                ? renderAnswer({ body: "", sources: [], followUps: [], streaming: false, latest: true, steps: [], action: confirmMsg.meta.action!, createdAt: confirmMsg.createdAt, messageId: confirmMsg.id }, true)
                : waitingWidget && renderAnswer(
                    { body: "", sources: [], followUps: [], streaming: false, latest: true, steps: [], widgets: [waitingWidget.widget], messageId: waitingWidget.messageId },
                    true,
                    exchangeWidgets.filter((c) => c !== waitingWidget).map((c) => ({ widget: c.widget, open: () => setPickedWidget({ exchange, id: c.widget.id }) })),
                  )}
              {error && <p className="i-error" role="alert">{error}</p>}
            </div>
            {row}
            {controls}
          </div>
        )}
        {shown === "answer" && !cardOnly && (
          <div className="i-answer">
            <IslandTop who={null} view={earlier ? { label: "Earlier", run: () => setShowAll(true) } : null} exit={exitButton} />
            <div className="i-body" role="log">
              {!conversationId && openerMessage}
              {loading ? <ThreadSkeleton /> : (
                <MessageList
                  messages={shownRecent}
                  pending={[...(starting && !conversationId ? [{ clientMsgId: startingId.current, body: starting, attachments: [] }] : thread.pending), ...held]}
                  mine={(m) => m.authorType === "visitor"}
                  authorLabel={(m) => (m.authorType === "visitor" ? "You" : m.authorType === "ai" ? "AI assistant" : m.authorName ?? "Support")}
                  otherReadSeq={0}
                  typing={thread.typing}
                  aiStream={runBusy ? undefined : thread.aiStream}
                  aiThinking={(thread.aiThinking || awaitingAi) && !runBusy}
                  aiTurn={thread.aiTurn}
                  pendingAuthor="You"
                  aiSteps={thread.aiSteps}
                  onRetry={(p) => thread.send(p.body, p.attachments, p.clientMsgId)}
                  onDismiss={(p) => thread.dismissPending(p.clientMsgId)}
                  renderAi={(answer) =>
                    anchor && answer.messageId === anchor.id ? (
                      <RunSteps actions={chainSteps.map((m) => m.meta.action!)} isRunning={actionRunning} busy={runBusy} />
                    ) : (
                      islandAi(answer)
                    )
                  }
                  follow="start"
                  ownText={pressTitle}
                />
              )}
              {error && <p className="i-error" role="alert">{error}</p>}
              {extras}
            </div>
            {human}
            {row}
            {controls}
          </div>
        )}
        {shown === "panel" && (
          <div className="i-panel">
            <IslandTop
              who={handling === "human" ? (teammate ? `${teammate} · ${island.name}` : island.name) : null}
              view={handling === "human" || !conversationId ? null : { label: "Latest", run: () => setShowAll(false) }}
              exit={exitButton}
            />
            <div className="i-body i-log" role="log">
              {openerMessage}
              {messages}
              {error && <p className="i-error" role="alert">{error}</p>}
              {extras}
            </div>
            {human}
            {row}
            {controls}
          </div>
        )}
      </Island>
    );
  }

  if (bar) {
    return (
      <div className="b-root">
        {panel && (
          <main className="b-main">
            <Glass />
            <div className="b-panel">
              {bar.head}
              {exitBar}
              <div className="b-tab">
                <div className="b-log" role="log">
                  {openerMessage}
                  {messages}
                  {error && <p className="error small b-pad">{error}</p>}
                  {extras}
                </div>
              </div>
            </div>
          </main>
        )}
        <div className="b-bottom" ref={bottom}>
          <div className="b-sizer">
            {error && !panel && open && <p className="b-error" role="alert">{error}</p>}
            {open && !hasChat && bar.suggestions.length > 0 && <Chips questions={bar.suggestions} onPick={(q) => void send(q, [])} />}
            {/* Closed, the whole bar opens the chat (a click, or Tab into its box). */}
            <div className={`b-pill ${open ? "open" : ""}`} ref={pill} onClick={open ? undefined : () => bar.setOpen(true)} onFocus={open ? undefined : () => bar.setOpen(true)}>
              {composer}
              {!open && <Typewriter phrases={bar.suggestions} fallback={placeholder} />}
            </div>
          </div>
          <div className="b-notice" />
        </div>
      </div>
    );
  }

  if (!classic) {
    return (
      <>
        {exitBar}
        <div className="w-body">
          {openerMessage}
          {messages}
          {error && <p className="error small pad">{error}</p>}
        </div>
        {extras}
        {composer}
      </>
    );
  }

  // A new chat starts with the greeting, as the reference's did (it isn't stored).
  const greet = !loading && !conversationId && !starting && !opener && !opening;
  return (
    <>
      {exitBar}
      <div className="w-body">
        {openerMessage}
        {greet && <p className="w-greet">{classic.greeting}</p>}
        {messages}
        {error && <p className="error small pad">{error}</p>}
      </div>
      {/* Starters: only until the chat begins, so they don't crowd the thread. */}
      {greet && classic.suggestions.length > 0 && (
        <div className="w-suggest" role="group" aria-label="Suggested questions">
          <div className="w-suggest-head">
            <span>Ask us things like:</span>
            <button className="w-x" aria-label="Dismiss" onClick={classic.hideSuggestions}>×</button>
          </div>
          <div className="w-suggest-list">
            {classic.suggestions.map((q) => (
              <button key={q} className="w-suggest-item" disabled={Boolean(starting && !conversationId)} onClick={() => void send(q, [])}>{q}</button>
            ))}
          </div>
        </div>
      )}
      <div className="w-actions">
        {/* W-07: the team is always one click away while the AI is answering. */}
        <button className="w-action-btn" disabled={Boolean(conversationId && handling !== "ai") || Boolean(starting && !conversationId)} onClick={contactTeam}>Contact the team</button>
        <button className="w-action-btn" onClick={classic.newChat}>Start a new chat</button>
      </div>
      {extras}
      {composer}
      <Badge />
    </>
  );
}

/** D-80: a card taller than the island opens scrolled to its bottom (its buttons), once per card view. */
const scrolledCards = new WeakSet<HTMLElement>();
function scrollCardOnce(el: HTMLElement | null) {
  if (!el || scrolledCards.has(el)) return;
  scrolledCards.add(el);
  // After the card has drawn and the island has sized itself.
  setTimeout(() => el.scrollTo({ top: el.scrollHeight }), 120);
}

/** Message-shaped placeholders: the visitor's bubble, a reply's lines, and again. */
function ThreadSkeleton() {
  return (
    <div className="messages w-skel" role="status" aria-label="Loading the conversation">
      <div className="w-skel-row own"><span style={{ width: "52%" }} /></div>
      <div className="w-skel-row"><span style={{ width: "92%" }} /><span style={{ width: "78%" }} /><span style={{ width: "44%" }} /></div>
      <div className="w-skel-row own"><span style={{ width: "36%" }} /></div>
      <div className="w-skel-row"><span style={{ width: "84%" }} /><span style={{ width: "58%" }} /></div>
    </div>
  );
}

/**
 * D-39: which shape the island takes. Closed, it rests, or offers help for a few seconds when a
 * nudge or an agent's invite arrives (the offer still opens the chat later, as the card's does).
 * Open with nothing asked yet it's the question box; with a chat it shows the latest exchange, or
 * the whole conversation once a teammate has it or the visitor asked for it.
 */
function useIslandState({ island, open, hasChat, conversationId, opener, intent, handling }: {
  island: boolean;
  open: boolean;
  hasChat: boolean;
  conversationId: string | null;
  opener: Opener | undefined;
  intent: ChatIntent | undefined;
  handling: ConversationSummary["handling"] | null;
}) {
  const [showAll, setShowAll] = useState(false);
  const [nudgeShown, setNudgeShown] = useState(false);
  const nudgeText = island && !conversationId && !intent && opener ? opener.text : null;
  useEffect(() => {
    if (!nudgeText) return;
    setNudgeShown(true);
    const timer = setTimeout(() => setNudgeShown(false), NUDGE_MS);
    return () => clearTimeout(timer);
  }, [nudgeText]);
  const state: IslandState = !open ? (nudgeText && nudgeShown ? "nudge" : "rest") : !hasChat ? "open" : handling === "human" || showAll ? "panel" : "answer";
  return { state, showAll, setShowAll, dismissNudge: () => setNudgeShown(false) };
}


/**
 * The island's title for a card's button press: the stored body is only the button's label
 * ("Email"), so add the first short string or number of its payload ("Email · INV-1043"), else of
 * the card's fields the visitor filled in ("Save · Asia/Kolkata"). Null
 * (the body as stored) for anything else. Display only: the message itself is unchanged.
 */
function pressTitle(m: Message): string | null {
  const meta = m.meta.widgetAction;
  if (!meta) return null;
  const payload = meta.payload === undefined || meta.payload === null ? [] : typeof meta.payload === "object" ? Object.values(meta.payload) : [meta.payload];
  for (const v of [...payload, ...Object.values(meta.values ?? {})]) {
    if (typeof v !== "string" && !(typeof v === "number" && Number.isFinite(v))) continue;
    const s = String(v).replace(/\s+/g, " ").trim();
    if (s && s.length <= 40 && s !== m.body.trim()) return `${m.body.trim()} · ${s}`;
  }
  return null;
}

/** How long the island's one-line offer of help stays before it rests again. */
const NUDGE_MS = 8_000;

/** What "Contact the team" says when it starts a conversation. */
const TEAM_REQUEST = "I'd like to talk to someone on your team.";

/** The visitor's last message has no team reply after it yet (system notices don't count). */
function lastVisitorWaiting(messages: Message[]): Message | null {
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i]!;
    if (m.authorType === "visitor") return m;
    if (m.authorType === "agent" || m.authorType === "ai") return null;
  }
  return null;
}

/** W-08: ask for an email when the team is away or nobody's online, or nobody has replied for this long. */
const EMAIL_ASK_AFTER_MS = 60_000;

function EmailAsk({
  api,
  conversationId,
  contact,
  away,
  waiting,
}: {
  api: WidgetApi;
  conversationId: string;
  contact: ConversationSummary["contact"] | null;
  away: boolean;
  waiting: Message | null;
}) {
  const [now, setNow] = useState(Date.now());
  const [dismissed, setDismissed] = useState(false);
  const [saved, setSaved] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [nobodyOnline, setNobodyOnline] = useState(false);

  const eligible = Boolean(waiting && contact && !contact.verified && !contact.email);
  // Nobody has the dashboard open: no point making them wait a minute first.
  useEffect(() => {
    if (!eligible || away) return;
    let cancelled = false;
    api.call<{ online: boolean }>("/online").then((r) => !cancelled && setNobodyOnline(!r.online), () => {});
    return () => {
      cancelled = true;
    };
  }, [api, eligible, away, waiting?.id]);

  const due = waiting ? waiting.createdAt + EMAIL_ASK_AFTER_MS : 0;
  useEffect(() => {
    if (!waiting || away || Date.now() >= due) return;
    const timer = setTimeout(() => setNow(Date.now()), due - Date.now() + 50);
    return () => clearTimeout(timer);
  }, [waiting, away, due]);

  if (saved) return <div className="w-email small"><span>Thanks. If you've gone by the time we reply, we'll email you at <strong>{saved}</strong>.</span></div>;
  if (dismissed || !waiting || !contact || contact.verified || contact.email) return null;
  if (!away && !nobodyOnline && now < due) return null;

  const submit = async (e: FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    const email = String(new FormData(e.currentTarget).get("email") ?? "");
    setBusy(true);
    setError(null);
    try {
      setSaved((await api.call<{ email: string }>(`/conversations/${conversationId}/email`, { body: { email } })).email);
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <form className="w-email" onSubmit={submit}>
      <div className="row">
        <span className="small strong">{away ? "We're away right now." : nobodyOnline ? "Nobody's online right now." : "Sorry for the wait."} Get the reply by email?</span>
        <span className="spacer" />
        <button type="button" className="ghost icon small w-x" aria-label="No thanks" onClick={() => setDismissed(true)}>×</button>
      </div>
      <div className="row">
        <input name="email" type="email" required maxLength={320} placeholder="you@company.com" aria-label="Your email" autoComplete="email" />
        <button disabled={busy}>Save</button>
      </div>
      {error && <p className="error small">{error}</p>}
    </form>
  );
}

/** W-12: "How did we do?" under a resolved conversation. Thumbs first, then an optional comment. */
function CsatAsk({
  api,
  conversationId,
  rated,
  onConversation,
}: {
  api: WidgetApi;
  conversationId: string;
  rated: boolean;
  onConversation: (c: ConversationSummary) => void;
}) {
  // Stays mounted through the comment step, after the server already counts it as rated.
  const [rating, setRating] = useState<CsatRating | null>(null);
  const [done, setDone] = useState(false);
  const [dismissed, setDismissed] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const post = async (body: { rating: CsatRating; comment?: string }) => {
    setBusy(true);
    setError(null);
    try {
      onConversation((await api.call<{ conversation: ConversationSummary }>(`/conversations/${conversationId}/rating`, { body })).conversation);
      return true;
    } catch (err) {
      setError((err as Error).message);
      return false;
    } finally {
      setBusy(false);
    }
  };

  if (done) return <div className="w-csat small"><span>Thanks for your feedback.</span></div>;
  if (rating) {
    const submit = async (e: FormEvent<HTMLFormElement>) => {
      e.preventDefault();
      const comment = String(new FormData(e.currentTarget).get("comment") ?? "").trim();
      if (!comment || (await post({ rating, comment }))) setDone(true);
    };
    return (
      <form className="w-csat" onSubmit={submit}>
        <span className="small strong">{rating === "good" ? "Thanks! Anything to add?" : "Thanks for telling us. Anything we could do better?"}</span>
        <textarea name="comment" rows={2} maxLength={MAX_CSAT_COMMENT} placeholder="Optional" aria-label="Your comment" autoFocus />
        <div className="row">
          <span className="spacer" />
          <button type="button" className="ghost small" onClick={() => setDone(true)}>Skip</button>
          <button className="small" disabled={busy}>Send</button>
        </div>
        {error && <p className="error small">{error}</p>}
      </form>
    );
  }
  if (rated || dismissed) return null;

  const rate = async (value: CsatRating) => {
    if (await post({ rating: value })) setRating(value);
  };
  return (
    <div className="w-csat">
      <div className="row">
        <span className="small strong">How did we do?</span>
        <span className="spacer" />
        <button type="button" className="ghost w-thumb" disabled={busy} aria-label="Good" title="Good" onClick={() => void rate("good")}>👍</button>
        <button type="button" className="ghost w-thumb" disabled={busy} aria-label="Bad" title="Bad" onClick={() => void rate("bad")}>👎</button>
        <button type="button" className="ghost icon small w-x" aria-label="No thanks" onClick={() => setDismissed(true)}>×</button>
      </div>
      {error && <p className="error small">{error}</p>}
    </div>
  );
}
