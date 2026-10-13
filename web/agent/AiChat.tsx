import { useEffect, useRef, useState, useSyncExternalStore, type FormEvent } from "react";
import { describeError } from "../api.ts";
import type { WidgetEditTurn } from "../../shared/widget-ai.ts";
import { EDIT_ATTEMPTS, finishWidgetEdit, liveReply, type EditResult } from "../../shared/edit-finish.ts";
import { streamAnswer } from "./editStream.ts";
import { inputsOf } from "./Connections.tsx";
import { Button } from "@/components/ui/button.tsx";
import { ArrowUpIcon, RefreshIcon } from "../components/icons.tsx";
import { PixelLoader } from "../components/PixelLoader.tsx";
import {
  MessageScroller,
  MessageScrollerButton,
  MessageScrollerContent,
  MessageScrollerItem,
  MessageScrollerProvider,
  MessageScrollerViewport,
} from "@/components/ui/message-scroller.tsx";
import type { AgentConfig } from "./useAgentConfig.ts";

// W-22 / W-24: change a widget, an action or a procedure by asking. Each request sends the file (or the
// draft), the request and the chat so far; the answer's file goes into the draft at once (the preview
// or form beside it updates), with Undo on that message. The chat lives for this visit (per file), not
// on the server. D-62: the answer streams in (editStream.ts): its reply shows as it's written, then
// the browser applies and checks the change, asking once more if it doesn't pass.

export type AiEditResult = EditResult;

export interface AiChatProps {
  cfg: AgentConfig;
  path: string;
  /** "widget", "action", "procedure": in the chat's wording. */
  noun: string;
  /** What the empty chat says under its title. */
  intro: string;
  ideas: string[];
  /** `onReply`: the reply so far, while the answer streams. */
  request: (message: string, history: WidgetEditTurn[], file: string, onReply: (reply: string) => void) => Promise<AiEditResult>;
}

interface Turn {
  id: number;
  role: "user" | "assistant" | "error";
  text: string;
  /** The file before this change (Undo puts it back) and after it. */
  before?: string;
  after?: string;
  /** AI-27: other files the change wrote (a task's actions): each one before (undefined: new) and after. */
  others?: { path: string; before: string | undefined; after: string }[];
  undone?: boolean;
}

const chats = new Map<string, Turn[]>();
const listeners = new Set<() => void>();
let nextId = 1;
const setChat = (path: string, turns: Turn[]) => {
  chats.set(path, turns);
  listeners.forEach((l) => l());
};
const EMPTY: Turn[] = [];
function useChat(path: string): Turn[] {
  return useSyncExternalStore((cb) => (listeners.add(cb), () => listeners.delete(cb)), () => chats.get(path) ?? EMPTY);
}

/** AI-26: a first request per file, sent as soon as its chat opens ("New action"). */
const queued = new Map<string, string>();
export function askOnOpen(path: string, text: string): void {
  queued.set(path, text);
}

const WIDGET_IDEAS =["Make it more compact", "Add a status badge in the corner", "Use a dark theme", "Add a button that opens the invoice"];

/** A widget's chat (W-22): its own endpoint, which checks the result renders. */
export function WidgetChat({ cfg, path, name }: { cfg: AgentConfig; path: string; name: string }) {
  return (
    <AiChat
      cfg={cfg}
      path={path}
      noun="widget"
      intro="Describe it in your words. The AI edits this widget and the preview updates; nothing goes live until you save."
      ideas={WIDGET_IDEAS}
      request={async (message, history, file, onReply) => {
        let error: { template: string; message: string } | undefined;
        for (let attempt = 0; attempt < EDIT_ATTEMPTS; attempt++) {
          const { text } = await streamAnswer(cfg.base, "/widget-edit", { name, file, message, history, files: cfg.draft, ...(error ? { error } : {}) }, (t) => onReply(liveReply(t)));
          const done = finishWidgetEdit({ name, file }, text, (tool) => inputsOf(cfg.draft, tool));
          if ("result" in done) return done.result;
          error = done.failed;
        }
        throw new Error(`The AI's change didn't work (${error?.message ?? "no answer"}). Try asking another way.`);
      }}
    />
  );
}

export function AiChat({ cfg, path, noun, intro, ideas, request }: AiChatProps) {
  const turns = useChat(path);
  const [message, setMessage] = useState("");
  const [busy, setBusy] = useState(false);
  // The reply as it streams in, shown in place of the loader.
  const [streaming, setStreaming] = useState("");
  const input = useRef<HTMLTextAreaElement>(null);

  /** `base`: the turns to continue from (Try again drops the failed request and its error). */
  const send = async (text: string, base: Turn[] = turns) => {
    const ask = text.trim();
    if (!ask || busy) return;
    const file = cfg.draft[path] ?? "";
    const history: WidgetEditTurn[] = base.filter((t) => t.role !== "error").map((t) => ({ role: t.role as "user" | "assistant", text: t.text }));
    const withAsk = [...base, { id: nextId++, role: "user" as const, text: ask }];
    setChat(path, withAsk);
    setMessage("");
    setBusy(true);
    setStreaming("");
    try {
      const result = await request(ask, history, file, setStreaming);
      // Applied to the draft as it is now (the request carried the file it was made from).
      const others = Object.entries(result.others ?? {}).map(([p, after]) => ({ path: p, before: cfg.draft[p], after }));
      if (result.changed) {
        cfg.setFile(path, result.file);
        for (const o of others) cfg.setFile(o.path, o.after);
      }
      setChat(path, [...withAsk, { id: nextId++, role: "assistant", text: result.reply, ...(result.changed ? { before: file, after: result.file, ...(others.length ? { others } : {}) } : {}) }]);
    } catch (error) {
      setChat(path, [...withAsk, { id: nextId++, role: "error", text: describeError(error) }]);
    } finally {
      setBusy(false);
      setStreaming("");
      input.current?.focus();
    }
  };

  useEffect(() => {
    const ask = queued.get(path);
    if (!ask) return;
    queued.delete(path);
    void send(ask);
    // Once per queued request, when this file's chat opens.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [path]);

  const undo = (turn: Turn) => {
    if (turn.before === undefined) return;
    cfg.setFile(path, turn.before);
    for (const o of turn.others ?? []) cfg.setFile(o.path, o.before);
    setChat(path, turns.map((t) => (t.id === turn.id ? { ...t, undone: true } : t)));
  };
  const redo = (turn: Turn) => {
    if (turn.after === undefined) return;
    cfg.setFile(path, turn.after);
    for (const o of turn.others ?? []) cfg.setFile(o.path, o.after);
    setChat(path, turns.map((t) => (t.id === turn.id ? { ...t, undone: false } : t)));
  };
  const lastAsk = [...turns].reverse().find((t) => t.role === "user");

  return (
    <div className="wchat">
      {/* shadcn's Message Scroller: a new request settles near the top with 64px of the turn before
          it showing, the answer comes in below; it follows only while you're at the end, and a
          reopened chat opens at its last request. */}
      <MessageScrollerProvider autoScroll defaultScrollPosition="last-anchor" scrollPreviousItemPeek={64}>
        <MessageScroller className="wchat-scroller">
          <MessageScrollerViewport aria-label={`Chat about this ${noun}`}>
            <MessageScrollerContent className="wchat-rows" aria-busy={busy}>
              {turns.length === 0 && !busy && (
                <MessageScrollerItem className="wchat-empty">
                  <p className="wchat-empty-title">What should change?</p>
                  <p className="wchat-empty-text">{intro}</p>
                  <div className="wchat-ideas">
                    {ideas.map((idea) => (
                      <button key={idea} type="button" className="wchat-idea" onClick={() => void send(idea)}>
                        {idea}
                      </button>
                    ))}
                  </div>
                </MessageScrollerItem>
              )}
              {turns.map((turn) =>
                turn.role === "user" ? (
                  <MessageScrollerItem key={turn.id} messageId={String(turn.id)} scrollAnchor className="wchat-row-user">
                    <div className="wchat-user">{turn.text}</div>
                  </MessageScrollerItem>
                ) : turn.role === "error" ? (
                  <MessageScrollerItem key={turn.id} messageId={String(turn.id)} className="wchat-ai wchat-error">
                    <p>{turn.text}</p>
                    {lastAsk && turn === turns[turns.length - 1] && (
                      <Button variant="ghost" size="sm" onClick={() => void send(lastAsk.text, turns.slice(0, -2))}>
                        <RefreshIcon /> Try again
                      </Button>
                    )}
                  </MessageScrollerItem>
                ) : (
                  <MessageScrollerItem key={turn.id} messageId={String(turn.id)} className="wchat-ai">
                    <p>{turn.text}</p>
                    <div className="wchat-meta">
                      {turn.before === undefined ? (
                        <span>No change</span>
                      ) : turn.undone ? (
                        <>
                          <span>Undone</span>
                          <button type="button" className="link-button" onClick={() => redo(turn)}>Redo</button>
                        </>
                      ) : (
                        <>
                          <span>Changed the {noun}</span>
                          <button type="button" className="link-button" onClick={() => undo(turn)}>Undo</button>
                        </>
                      )}
                    </div>
                  </MessageScrollerItem>
                ),
              )}
              {busy && (
                <MessageScrollerItem messageId="pending" className="wchat-ai wchat-pending" role="status">
                  {streaming && <p>{streaming}</p>}
                  <PixelLoader label={streaming ? `Writing the ${noun}` : `Editing the ${noun}`} />
                </MessageScrollerItem>
              )}
            </MessageScrollerContent>
          </MessageScrollerViewport>
          <MessageScrollerButton />
        </MessageScroller>
      </MessageScrollerProvider>
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
          placeholder="Describe a change…"
          aria-label="Describe a change"
          maxLength={2000}
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
    </div>
  );
}
