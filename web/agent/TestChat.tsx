import { useMemo, useRef, useState, useSyncExternalStore, type FormEvent } from "react";
import type { AiStep } from "../../shared/protocol.ts";
import { MAX_TEST_MESSAGE, testCaseFrom, type TestChatEvent, type TestPress, type TestReply, type TestTurn } from "../../shared/test-chat.ts";
import { markWidgetUsed, type MessageWidget } from "../../shared/widgets.ts";
import { customerRefs } from "../../shared/action-try.ts";
import { editYaml, readYaml } from "../lib/agentFiles.ts";
import { Button } from "@/components/ui/button.tsx";
import { Input } from "@/components/ui/input.tsx";
import { Switch } from "@/components/ui/switch.tsx";
import { ArrowUpIcon, RefreshIcon } from "../components/icons.tsx";
import { PixelLoader } from "../components/PixelLoader.tsx";
import { Markdown } from "../components/Markdown.tsx";
import { parseMarkdown } from "../../shared/markdown.ts";
import { WidgetCard, type WidgetActionEvent, type WidgetActionOutcome, type WidgetClientEvent } from "../widget/chatkit/WidgetCard.tsx";
import {
  MessageScroller,
  MessageScrollerButton,
  MessageScrollerContent,
  MessageScrollerItem,
  MessageScrollerProvider,
  MessageScrollerViewport,
} from "@/components/ui/message-scroller.tsx";
import { EVAL, go, humanize } from "./parts.tsx";
import type { AgentConfig } from "./useAgentConfig.ts";

// AI-29: "Test" on a task's page. The admin types as a customer; each message goes with the chat so far
// and the unsaved draft to …/agent/test-chat, which runs the live chats' runAgent and streams back what
// the customer would see (shared/test-chat.ts). Nothing is stored. Safe by default: look-ups run for
// real, changes are answered without being made; "Use my real systems" makes them too. A chat can be
// kept as a test case (evals/*.yaml). The chat lives for this visit, per task.

interface ChatState {
  turns: TestTurn[];
  real: boolean;
  page: string;
  customer: Record<string, string>;
}

const chats = new Map<string, ChatState>();
const listeners = new Set<() => void>();
const EMPTY: ChatState = { turns: [], real: false, page: "", customer: {} };
const setChat = (key: string, next: ChatState) => {
  chats.set(key, next);
  listeners.forEach((l) => l());
};
function useTestChat(key: string): ChatState {
  return useSyncExternalStore((cb) => (listeners.add(cb), () => listeners.delete(cb)), () => chats.get(key) ?? EMPTY);
}

/** The chat with one card changed (the one a press is on). */
function withCard(turns: TestTurn[], press: TestPress, change: (w: MessageWidget) => MessageWidget): TestTurn[] {
  return turns.map((t, i) => (i === press.turn && t.role === "ai" ? { ...t, reply: { ...t.reply, widgets: t.reply.widgets.map((w) => (w.id === press.widgetId ? change(w) : w)) } } : t));
}

const pageTheme = () => (document.documentElement.dataset.theme === "dark" ? "dark" : "light");
const NEW_TESTS_FILE = "evals/tests.yaml";

/** What happened behind a reply, in a line per call. */
function Calls({ reply }: { reply: TestReply }) {
  const calls = reply.calls.filter((c) => c.tool !== "show_widget");
  if (!calls.length) return null;
  return (
    <details className="tchat-calls">
      <summary>
        {calls.map((c) => `${humanize(c.tool)}${c.pretended ? " (pretended)" : c.status === "error" ? " (failed)" : ""}`).join(" · ")}
      </summary>
      {calls.map((c, i) => (
        <div key={i} className="tchat-call">
          <strong>{humanize(c.tool)}</strong>{" "}
          {c.pretended ? "wasn't made: a test answers changes as if they worked." : c.status === "error" ? `failed${c.httpStatus ? ` (HTTP ${c.httpStatus})` : ""}.` : `ran${c.httpStatus ? ` (HTTP ${c.httpStatus})` : ""}.`}
          <pre>{c.output}</pre>
        </div>
      ))}
    </details>
  );
}

/** AI-30: a card in the test chat; its buttons work as in a real chat (`onPress`), or are shown only. */
interface PressHandlers {
  onPress?: (widget: MessageWidget, event: WidgetActionEvent) => Promise<WidgetActionOutcome>;
  onClient?: (event: WidgetClientEvent) => void;
}

function Reply({ reply, handlers }: { reply: TestReply; handlers: PressHandlers }) {
  return (
    <>
      {reply.widgets.map((w) => (
        <div key={w.id} className="tchat-card">
          <WidgetCard
            widget={w}
            interactive={Boolean(handlers.onPress)}
            theme={pageTheme()}
            {...(handlers.onPress ? { onAction: (event: WidgetActionEvent) => handlers.onPress!(w, event) } : {})}
            {...(handlers.onClient ? { onClientAction: handlers.onClient } : {})}
          />
        </div>
      ))}
      {reply.pressed?.done && <p className="tchat-note">The widget says: {reply.pressed.done}</p>}
      {reply.pressed?.failed && <p className="tchat-note tchat-handoff">The widget opens again and says: {reply.pressed.failed}</p>}
      {reply.text && <div className="tchat-text"><Markdown blocks={parseMarkdown(reply.text)} cite={(n) => { const s = reply.sources?.[n - 1]; return s ? <sup className="cite" title={s.title}>{n}</sup> : `[${n}]`; }} /></div>}
      {reply.pageAction && (
        <p className="tchat-note">
          Asks to run <code>{reply.pageAction.name}</code> on your website{Object.keys(reply.pageAction.input).length ? <> with <code>{JSON.stringify(reply.pageAction.input)}</code></> : null}. A customer would confirm it; here the next message carries on as if it ran.
        </p>
      )}
      {reply.escalate && <p className="tchat-note">Flags a problem for the engineers: {reply.escalate}</p>}
      {reply.handoff !== undefined && <p className="tchat-note tchat-handoff">Hands the chat to a person: {reply.handoff}</p>}
      {reply.sources?.length ? <p className="tchat-sources">From {reply.sources.map((s) => s.title).join(", ")}</p> : null}
      <Calls reply={reply} />
    </>
  );
}

export function TestChat({ cfg, path, name }: { cfg: AgentConfig; path: string; name: string }) {
  const key = path;
  const state = useTestChat(key);
  const [message, setMessage] = useState("");
  const [busy, setBusy] = useState(false);
  const [live, setLive] = useState<{ text: string; steps: AiStep[] }>({ text: "", steps: [] });
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const input = useRef<HTMLTextAreaElement>(null);
  const update = (patch: Partial<ChatState>) => setChat(key, { ...(chats.get(key) ?? EMPTY), ...patch });

  // {user.*} in any action: the test needs a customer to act as.
  const refs = useMemo(() => customerRefs(Object.entries(cfg.draft).filter(([p]) => p.startsWith("tools/")).map(([, t]) => t)), [cfg.draft]);
  const handedOff = state.turns.at(-1)?.role === "ai" && (state.turns.at(-1) as { reply: TestReply }).reply.handoff !== undefined;

  /**
   * `base`: the chat to continue (Try again drops the message that failed and sends it again).
   * AI-30: `press`, a card's button: the turn reads as its label, the card shows as used meanwhile.
   */
  const send = async (text: string, base: TestTurn[] = state.turns, press?: TestPress): Promise<TestReply | null> => {
    const ask = text.trim();
    if (!ask || busy) return null;
    setNotice(null);
    const turns: TestTurn[] = [...base, { role: "customer", text: ask, ...(press ? { press } : {}) }];
    update({ turns });
    setMessage("");
    setBusy(true);
    setError(null);
    setSaved(false);
    setLive({ text: "", steps: [] });
    try {
      const customer: Record<string, unknown> = { attributes: {}, secrets: {} };
      for (const ref of refs) {
        const value = state.customer[ref]?.trim();
        if (!value) continue;
        if (ref.startsWith("secrets.")) (customer.secrets as Record<string, string>)[ref.slice(8)] = value;
        else if (["id", "email", "name"].includes(ref)) customer[ref] = value;
        else (customer.attributes as Record<string, string>)[ref] = value;
      }
      const signedIn = refs.some((r) => state.customer[r]?.trim());
      const response = await fetch(`/api${cfg.base}/test-chat`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        credentials: "same-origin",
        body: JSON.stringify({ files: cfg.draft, turns, real: state.real, ...(signedIn ? { customer } : {}), ...(state.page.trim() ? { page: state.page.trim() } : {}) }),
      });
      if (!response.ok || !response.body) {
        const json = (await response.json().catch(() => ({}))) as { error?: { message?: string } };
        throw new Error(json.error?.message ?? `The test couldn't run (${response.status}).`);
      }
      const reader = response.body.pipeThrough(new TextDecoderStream()).getReader();
      let buffer = "";
      let reply: TestReply | null = null;
      for (;;) {
        const { value, done } = await reader.read();
        if (done) break;
        buffer += value;
        const lines = buffer.split("\n");
        buffer = lines.pop() ?? "";
        for (const line of lines) {
          if (!line.trim()) continue;
          const event = JSON.parse(line) as TestChatEvent;
          if (event.type === "text") setLive((l) => ({ ...l, text: event.text }));
          else if (event.type === "step") setLive((l) => ({ ...l, steps: [...l.steps.filter((s) => s.id !== event.step.id), event.step] }));
          else if (event.type === "done") reply = event.reply;
          else if (event.type === "error") throw new Error(event.message);
        }
      }
      if (!reply) throw new Error("The AI didn't answer.");
      const got: TestReply = reply;
      if (press && got.pressed?.failed) {
        // Its widget_failed line: in a real chat nothing is sent and the card opens again with it.
        update({ turns: base });
        return got;
      }
      // A tool: button's run stays on the press, so later turns give the AI its result.
      const sent = press && got.pressed?.tool ? turns.map((t, i) => (i === turns.length - 1 && t.role === "customer" && t.press ? { ...t, press: { ...t.press, tool: got.pressed!.tool! } } : t)) : turns;
      // Its widget_done line: the card folds to it.
      const folded = press && got.pressed?.done ? withCard(sent, press, (w) => markWidgetUsed(w, got.pressed!.done!, press.item, Date.now())) : sent;
      update({ turns: [...folded, { role: "ai", reply: got }] });
      return got;
    } catch (e) {
      // The message stays, so Try again sends the same chat.
      setError((e as Error).message);
      return null;
    } finally {
      setBusy(false);
      setLive({ text: "", steps: [] });
      input.current?.focus();
    }
  };

  const retry = () => {
    const last = state.turns.at(-1);
    if (last?.role !== "customer") return;
    void send(last.text, state.turns.slice(0, -1), last.press);
  };

  /** AI-30: a card's button pressed in the test chat: sent like a real press; a failed line opens the card again. */
  const press = async (turn: number, widget: MessageWidget, event: WidgetActionEvent): Promise<WidgetActionOutcome> => {
    if (busy) return { ok: false, message: "Wait for the reply first." };
    const p: TestPress = { turn, widgetId: widget.id, action: event.action, values: event.values, ...(event.item ? { item: event.item } : {}) };
    const before = state.turns;
    const marked = withCard(before, p, (w) => markWidgetUsed(w, event.label, event.item, Date.now()));
    const reply = await send(event.label, marked, p);
    if (!reply) {
      update({ turns: before });
      return { ok: false, message: "The test couldn't run this. Try again." };
    }
    if (reply.pressed?.failed) {
      update({ turns: before });
      return { ok: false, message: reply.pressed.failed };
    }
    return { ok: true };
  };

  const handlersFor = (turn: number): PressHandlers =>
    handedOff
      ? {}
      : {
          onPress: (widget, event) => press(turn, widget, event),
          onClient: (event) => setNotice(`"${event.action.type}" went to your website's own code (JunDesk.onWidgetAction). The desk can't see what it does, so nothing more happens in a test.`),
        };

  const saveAsTest = () => {
    const first = state.turns.find((t) => t.role === "customer") as { text: string } | undefined;
    const label = `${humanize(name)}: ${(first?.text ?? "").slice(0, 40)}${(first?.text.length ?? 0) > 40 ? "…" : ""}`;
    const value = testCaseFrom(label, state.turns, state.page.trim() || null);
    if (!value) return;
    const file = Object.keys(cfg.draft).filter((p) => EVAL.test(p)).sort().find((p) => Array.isArray(readYaml(cfg.draft[p]!))) ?? NEW_TESTS_FILE;
    cfg.setFile(file, editYaml(cfg.draft[file] ?? "[]\n", { op: "push", path: [], value }));
    setSaved(true);
  };

  return (
    <div className="wchat tchat">
      <div className="tchat-bar">
        <label className="tchat-switch">
          <Switch checked={state.real} onCheckedChange={(on) => update({ real: on })} aria-label="Use my real systems" />
          <span>{state.real ? <strong>Uses your real systems: changes are made</strong> : "Safe: look-ups are real, changes are pretended"}</span>
        </label>
        <span className="spacer" />
        {state.turns.some((t) => t.role === "ai") && (
          <Button size="sm" variant="ghost" onClick={saveAsTest} disabled={saved}>{saved ? "Saved as a test" : "Save as a test"}</Button>
        )}
        {state.turns.length > 0 && (
          <Button size="sm" variant="ghost" onClick={() => { update({ turns: [] }); setError(null); setSaved(false); }} disabled={busy}>
            <RefreshIcon /> Reset
          </Button>
        )}
      </div>
      <details className="tchat-settings">
        <summary>Customer{refs.length ? " (some of your actions need a signed-in one)" : ""} and page</summary>
        <div className="tchat-fields">
          {refs.map((ref) => (
            <label key={ref}>
              <span>{ref.startsWith("secrets.") ? `Their key ${ref.slice(8)}` : `Their ${humanize(ref).toLowerCase()}`}</span>
              <Input value={state.customer[ref] ?? ""} type={ref.startsWith("secrets.") ? "password" : "text"} autoComplete="off" onChange={(e) => update({ customer: { ...state.customer, [ref]: e.target.value } })} />
            </label>
          ))}
          <label>
            <span>On the page</span>
            <Input value={state.page} placeholder="/billing (for actions offered only on some pages)" onChange={(e) => update({ page: e.target.value })} />
          </label>
        </div>
      </details>
      <MessageScrollerProvider autoScroll defaultScrollPosition="last-anchor" scrollPreviousItemPeek={64}>
        <MessageScroller className="wchat-scroller">
          <MessageScrollerViewport aria-label="Test chat">
            <MessageScrollerContent className="wchat-rows" aria-busy={busy}>
              {state.turns.length === 0 && !busy && (
                <MessageScrollerItem className="wchat-empty">
                  <p className="wchat-empty-title">Try a conversation</p>
                  <p className="wchat-empty-text">
                    Write as a customer would. The AI answers with your unsaved changes, as it would on your website. Nothing is saved and nobody sees it. Buttons on widgets work here too.
                  </p>
                </MessageScrollerItem>
              )}
              {state.turns.map((t, i) =>
                t.role === "customer" ? (
                  <MessageScrollerItem key={i} messageId={`t${i}`} scrollAnchor className="wchat-row-user">
                    <div className="wchat-user">{t.press ? <>Pressed <strong>{t.text}</strong></> : t.text}</div>
                  </MessageScrollerItem>
                ) : (
                  <MessageScrollerItem key={i} messageId={`t${i}`} className="wchat-ai tchat-ai">
                    <Reply reply={t.reply} handlers={handlersFor(i)} />
                  </MessageScrollerItem>
                ),
              )}
              {busy && (
                <MessageScrollerItem messageId="pending" className="wchat-ai wchat-pending tchat-ai" role="status">
                  {live.steps.map((s) => (
                    <p key={s.id} className="tchat-step" data-done={s.state === "done" || undefined}>{s.label}{s.state === "running" ? "…" : ""}</p>
                  ))}
                  {live.steps.flatMap((s) => (s.widget ? [s.widget] : [])).map((w) => (
                    <div key={w.id} className="tchat-card"><WidgetCard widget={w} interactive={false} theme={pageTheme()} /></div>
                  ))}
                  {live.text ? <div className="tchat-text"><Markdown blocks={parseMarkdown(live.text, { streaming: true })} cite={(n) => `[${n}]`} /></div> : <PixelLoader label="The AI is answering" />}
                </MessageScrollerItem>
              )}
              {error && (
                <MessageScrollerItem messageId="error" className="wchat-ai wchat-error">
                  <p>{error}</p>
                  <Button variant="ghost" size="sm" onClick={retry}><RefreshIcon /> Try again</Button>
                </MessageScrollerItem>
              )}
              {notice && (
                <MessageScrollerItem messageId="notice" className="wchat-ai">
                  <p className="tchat-note">{notice}</p>
                </MessageScrollerItem>
              )}
              {saved && (
                <MessageScrollerItem messageId="saved" className="wchat-ai">
                  <p className="tchat-note">Kept as a test. It runs with the others on the <a href="/agent/tests" onClick={(e) => { e.preventDefault(); go("/agent/tests"); }}>Tests</a> page, and goes live when you save.</p>
                </MessageScrollerItem>
              )}
            </MessageScrollerContent>
          </MessageScrollerViewport>
          <MessageScrollerButton />
        </MessageScroller>
      </MessageScrollerProvider>
      {handedOff ? (
        <p className="tchat-ended">In a real chat a person takes over here. Reset to try again.</p>
      ) : (
        <form
          className="wchat-composer"
          onSubmit={(e: FormEvent) => {
            e.preventDefault();
            void send(message);
          }}
        >
          <textarea
            ref={input}
            rows={1}
            value={message}
            placeholder="Write as a customer…"
            aria-label="Write as a customer"
            maxLength={MAX_TEST_MESSAGE}
            onChange={(e) => setMessage(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing) {
                e.preventDefault();
                void send(message);
              }
            }}
          />
          <Button type="submit" size="icon-sm" aria-label="Send" disabled={busy || !message.trim()}>
            <ArrowUpIcon />
          </Button>
        </form>
      )}
    </div>
  );
}
