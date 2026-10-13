import { useEffect, useLayoutEffect, useRef, useState, type ReactNode, type RefObject } from "react";
import { Typewriter } from "./bar.tsx";

// W-04 "island" launcher (D-39): one small control at the bottom centre of the page that changes
// shape to fit each moment and always returns to a resting pill. Like the bar (bar.tsx) the frame
// is transparent and always shown; it tells the loader its size and the part of it that's drawn
// (`jun:css`), which the loader applies as the frame's inline style. Everything happens inside
// the frame: the page itself is never touched. Styles: `widget.css` (`html.island`; on the
// near-black surface, the default, also `html.island-dark`).
//
// It is one object, never a box swapped for another: in the open, answer and panel states the
// bottom row is the pill itself (the mark and the input, 54px like the resting pill) and the
// content grows above it. There's no header bar: the visitor's question is the answer's title,
// Minimize and End sit in the top-right corner on hover (IslandControls), and a short top row
// carries what must stay visible (an intent's exit, who's talking, Earlier/Latest).

const postToHost = (message: unknown) => window.parent !== window && window.parent.postMessage(message, "*");
const reducedMotion = () => window.matchMedia("(prefers-reduced-motion: reduce)").matches;

/**
 * rest: the pill (or, with a chat, a one-line summary of its last answer). nudge: a one-line offer
 * of help (P-01, V-07). open: the suggested questions over the pill's row. thinking: one status
 * line while the assistant works (before the first reply, and while a card's button is being
 * handled). answer: the latest exchange, its question as the title, over the pill's row; it folds
 * itself back to rest a few seconds after it's done (`autoFold`). panel: the whole conversation
 * (a teammate's chat, or "Earlier").
 */
export type IslandState = "rest" | "nudge" | "open" | "thinking" | "answer" | "panel";

/** Each state's width; phones cap every width at the frame minus 24px. */
const WIDTHS: Record<IslandState, number> = { rest: 360, nudge: 440, open: 660, thinking: 420, answer: 560, panel: 660 };
/** D-79: a one-line pill that hugs its text stays within these. */
const HUG_MIN = 240;
const HUG_MAX = 480;
/** Room around the island kept visible for its shadow (which `.i-shell` keeps well inside it). */
const GLOW = 32;
/** The island's distance from the bottom of the viewport (matches `.i-root`'s padding). */
const edge = (width: number) => (width < 640 ? 12 : 24);
/** The frame's spring: a slight overshoot, about 0.65s (the proposal's stiffness 380 / damping 30). */
export const SPRING = "cubic-bezier(.34, 1.25, .5, 1)";

/**
 * Sizes the frame: a fixed transparent box at the bottom centre (up to 720×680), clipped to the
 * island's box plus its shadow so the rest of the frame doesn't take the page's clicks. The clip
 * animates with the same curve as the island, so the two stay together.
 */
function useIslandFrame(box: { w: number; h: number }, live: boolean): void {
  useLayoutEffect(() => {
    const motion = reducedMotion() ? "" : `transition:clip-path ${live ? ".25s ease-out" : `.65s ${SPRING}`};`;
    const bottom = edge(window.innerWidth);
    postToHost({
      type: "jun:css",
      css:
        // Room for the tallest answer (720px) plus its edge and glow; the clip-path leaves the rest of
        // the page clickable. Inside, innerHeight is this height: the page's, up to 840px.
        "display:block;top:auto;bottom:0;left:0;right:0;margin:0 auto;width:min(720px,100%);height:min(840px,100%);" +
        `border:0;border-radius:0;background:none;box-shadow:none;color-scheme:normal;${motion}` +
        `clip-path:inset(calc(100% - ${box.h + bottom + GLOW}px) calc(50% - ${box.w / 2 + GLOW}px) ${Math.max(0, bottom - GLOW)}px)`,
    });
  }, [box.w, box.h, live]);
}

/**
 * How long a finished answer stays open, untouched, before the island folds itself: AUTO_FOLD_MS
 * plus the time to read what's on screen (READ_WORDS_PER_S), at most AUTO_FOLD_MAX_MS.
 */
export const AUTO_FOLD_MS = 8_000;
export const AUTO_FOLD_MAX_MS = 30_000;
const READ_WORDS_PER_S = 4;

/** The wait for the answer on screen: the reply's words and its card's text (not the question). */
function foldDelay(el: HTMLElement): number {
  let words = 0;
  for (const msg of el.querySelectorAll(".i-body .msg:not(.own)")) words += (msg.textContent ?? "").split(/\s+/).filter(Boolean).length;
  return Math.min(AUTO_FOLD_MAX_MS, AUTO_FOLD_MS + (words / READ_WORDS_PER_S) * 1000);
}

/**
 * Folds the island foldDelay() after `fold` becomes set (the caller sets it only once an answer
 * is finished and nothing waits on the visitor), unless it's in use: the pointer over it, focus
 * on something in it other than the empty question box (which keeps the focus after sending),
 * text in the box, the "+" menu or a screenshot open, or the answer scrolled away from its top
 * (the visitor is reading further down). Any pointer, key, scroll or focus inside starts the wait
 * again. Reduced motion still folds (the shapes just don't animate).
 */
function useAutoFold(box: RefObject<HTMLDivElement | null>, fold: (() => void) | null): void {
  const latest = useRef(fold);
  latest.current = fold;
  const enabled = Boolean(fold);
  useEffect(() => {
    const el = box.current;
    if (!enabled || !el) return;
    let over = el.matches(":hover");
    let timer: ReturnType<typeof setTimeout> | undefined;
    const inUse = () => {
      if (over) return true;
      const active = document.hasFocus() ? document.activeElement : null;
      const field = el.querySelector<HTMLTextAreaElement>(".i-row textarea");
      if (field?.value.trim()) return true;
      if (el.querySelector(".composer-menu, .composer-shot, .composer-files")) return true;
      if ((el.querySelector<HTMLElement>(".i-body")?.scrollTop ?? 0) > 4) return true;
      return Boolean(active && active !== document.body && el.contains(active) && active !== field);
    };
    const arm = () => {
      clearTimeout(timer);
      timer = setTimeout(() => (inUse() ? arm() : latest.current?.()), foldDelay(el));
    };
    const enter = () => {
      over = true;
    };
    const leave = () => {
      over = false;
      arm();
    };
    el.addEventListener("pointerenter", enter);
    el.addEventListener("pointerleave", leave);
    const pokes = ["pointerdown", "keydown", "input", "focusin", "wheel"] as const;
    for (const type of pokes) document.addEventListener(type, arm, true);
    document.addEventListener("scroll", arm, true);
    arm();
    return () => {
      clearTimeout(timer);
      el.removeEventListener("pointerenter", enter);
      el.removeEventListener("pointerleave", leave);
      for (const type of pokes) document.removeEventListener(type, arm, true);
      document.removeEventListener("scroll", arm, true);
    };
  }, [enabled, box]);
}

/**
 * The morphing container. New content is drawn off to the side at the state's width and measured;
 * the shell then springs to that exact size (measure, then move). A key per state swaps the content,
 * rising into place from the pill's row with a short fade and un-blur. `autoFold`: set while a
 * finished answer may fold itself (see useAutoFold). `hug` (D-79): a one-line pill (the working line,
 * the folded reply) is as wide as its line, within HUG_MIN..HUG_MAX, and springs as the line changes.
 */
export function Island({ state, live, neon, onOpen, autoFold = null, hug = false, children }: { state: IslandState; live: boolean; neon: boolean; onOpen: () => void; autoFold?: (() => void) | null; hug?: boolean; children: ReactNode }) {
  const content = useRef<HTMLDivElement>(null);
  const boxRef = useRef<HTMLDivElement>(null);
  useAutoFold(boxRef, autoFold);
  // "/" opens the resting island from inside the frame too (after Escape the focus is still here;
  // the loader handles the key on the host page).
  useEffect(() => {
    if (state !== "rest" && state !== "nudge") return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "/" && !e.ctrlKey && !e.metaKey) {
        e.preventDefault();
        onOpen();
      }
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [state, onOpen]);
  const [measured, setMeasured] = useState(56);
  const [measuredW, setMeasuredW] = useState(HUG_MAX);
  const [viewport, setViewport] = useState({ w: window.innerWidth, h: window.innerHeight });
  useEffect(() => {
    const onResize = () => setViewport({ w: window.innerWidth, h: window.innerHeight });
    window.addEventListener("resize", onResize);
    return () => window.removeEventListener("resize", onResize);
  }, []);
  const hugMax = Math.min(HUG_MAX, viewport.w - 24);
  const w = hug ? Math.min(Math.max(measuredW, HUG_MIN), hugMax) : Math.min(WIDTHS[state], viewport.w - 24);
  // The panel fills what it's given; everything else is as tall as its content.
  const panelHeight = Math.max(240, Math.min(560, viewport.h - edge(viewport.w) - GLOW));
  useEffect(() => {
    const el = content.current;
    if (!el || state === "panel") return;
    const measure = () => {
      const r = el.getBoundingClientRect();
      setMeasured(Math.ceil(r.height));
      if (hug) setMeasuredW(Math.ceil(r.width));
    };
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(el);
    return () => observer.disconnect();
  }, [state, hug]);
  // An answer grows to fit (a card and its sentence) up to 720px, leaving the top of the page in
  // view; the panel's height when the screen is short. Only taller answers scroll.
  const answerMax = Math.max(panelHeight, Math.min(720, viewport.h - edge(viewport.w) - GLOW - 48));
  const h = state === "panel" ? panelHeight : state === "answer" ? Math.min(measured, answerMax) : measured;
  useIslandFrame({ w, h }, live);
  // An answer taller than the panel scrolls inside: fade its bottom edge while there's more below.
  useEffect(() => {
    if (state !== "answer") return;
    const body = content.current?.querySelector<HTMLElement>(".i-body");
    if (!body) return;
    const check = () => body.classList.toggle("i-more", body.scrollHeight - body.scrollTop - body.clientHeight > 4);
    check();
    const observer = new ResizeObserver(check);
    observer.observe(body);
    if (body.firstElementChild) observer.observe(body.firstElementChild);
    body.addEventListener("scroll", check, { passive: true });
    return () => {
      observer.disconnect();
      body.removeEventListener("scroll", check);
    };
  }, [state]);
  return (
    <div className="i-root">
      {/* The box carries the size and its spring; the neon ring and glow sit on it, outside the clipped shell. */}
      <div ref={boxRef} className={`i-box i-s-${state}${live ? " i-live" : ""}${hug ? " i-hug" : ""}`} style={{ width: w, height: h }}>
        {neon && <div className="i-glow" aria-hidden="true" />}
        {neon && <div className="i-ring" aria-hidden="true" />}
        <div className="i-shell" role="region" aria-label="Chat">
          <div key={state} className="i-view" ref={content} style={{ ...(hug ? { width: "max-content", minWidth: HUG_MIN, maxWidth: hugMax } : { width: w }), ...(state === "panel" ? { height: panelHeight } : state === "answer" ? { maxHeight: answerMax } : {}) }}>
            {children}
          </div>
        </div>
      </div>
    </div>
  );
}

/** The mark: the workspace logo, or the Jun agent mark (as the chat header), pulsing while the assistant works. */
export function Mark({ logoUrl, pulse = false }: { logoUrl: string | null; pulse?: boolean }) {
  return <img className={`i-mark${pulse ? " pulse" : ""}`} src={logoUrl ?? "/jun-agent.svg"} alt="" />;
}

/**
 * Resting: the mark, a hint that types out the suggested questions (or a new reply), and the "/" key;
 * an up arrow instead while a minimized chat is waiting to be opened again ("/" still opens it).
 * Folded with a chat, `summary` (its last answer in a few words) stands in for the typewriter; an
 * unread teammate reply still wins.
 */
export function RestPill({ logoUrl, suggestions, placeholder, unread, summary = null, chat = false, waiting = null, onOpen }: { logoUrl: string | null; suggestions: string[]; placeholder: string; unread: string | null; summary?: string | null; chat?: boolean; waiting?: string | null; onOpen: () => void }) {
  // D-80: a card still waiting on the visitor wins over the reply's summary: what it is, and a nudge.
  const line = unread ?? waiting ?? (chat ? summary : null);
  return (
    <button type="button" className={`i-rest${waiting && !unread ? " i-rest-wait" : ""}`} aria-label={unread ?? (waiting ? `Open: ${waiting}` : chat ? (summary ? `Open the chat: ${summary}` : "Open the chat") : "Ask this page anything")} onClick={onOpen}>
      <Mark logoUrl={logoUrl} pulse={Boolean(unread)} />
      {waiting && !unread && <span className="i-wait-dot" aria-hidden="true" />}
      {line ? <span className={`i-rest-text${unread || waiting ? "" : " i-rest-sum"}`}>{line}</span> : <Typewriter phrases={suggestions} fallback={placeholder} />}
      {chat ? <span className="i-up" aria-hidden="true">{chevron(CHEVRON_UP)}</span> : <kbd className="i-kbd" aria-hidden="true">/</kbd>}
    </button>
  );
}

/** Nudge: a one-line offer with an Ask button; ignored, it goes away on its own. */
export function NudgeLine({ logoUrl, text, from, onAsk, onDismiss }: { logoUrl: string | null; text: string; from: string | null; onAsk: () => void; onDismiss: () => void }) {
  return (
    <div className="i-nudge" role="dialog" aria-label="Need help?">
      <Mark logoUrl={logoUrl} />
      <span className="i-nudge-text">
        {from && <span className="i-nudge-from">{from} · </span>}
        {text}
      </span>
      <button type="button" className="i-ask" onClick={onAsk}>Ask</button>
      <button type="button" className="i-ghost i-x" aria-label="Dismiss" onClick={onDismiss}>×</button>
    </div>
  );
}

/** Thinking: one specific line, the running tool step's label when there is one. */
export function StatusLine({ logoUrl, label, onOpen }: { logoUrl: string | null; label: string; onOpen?: () => void }) {
  // D-78: a run's line opens to its steps and the chat.
  if (onOpen) {
    return (
      <button type="button" className="i-status i-status-btn" aria-label={`${label} Show the steps`} onClick={onOpen}>
        <Mark logoUrl={logoUrl} pulse />
        <span className="i-status-text" role="status">{label}</span>
        <span className="i-up" aria-hidden="true">{chevron(CHEVRON_UP)}</span>
      </button>
    );
  }
  return (
    <div className="i-status" role="status">
      <Mark logoUrl={logoUrl} pulse />
      <span className="i-status-text">{label}</span>
    </div>
  );
}

const chevron = (d: string) => (
  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
    <path d={d} />
  </svg>
);
export const CHEVRON_DOWN = "M6 9l6 6 6-6";
export const CHEVRON_UP = "M6 15l6-6 6 6";

/**
 * The open island's corner: small, over the content (not a row of their own), shown on hover or
 * when tabbed to (always, but quiet, on touch screens). The down arrow folds it back to the pill
 * and keeps the chat (the pill's up arrow brings it back); × ends this chat: the next question
 * starts a new one (the old one stays in the visitor's list). An intent's chat ends through its
 * exit button (IslandTop), so there × only folds it.
 */
export function IslandControls({ onEnd, onMinimize }: {
  /** Ends this conversation (it stays in the visitor's list) and folds the island; null when × only folds it. */
  onEnd: (() => void) | null;
  onMinimize: () => void;
}) {
  return (
    <div className="i-ctl">
      <button type="button" className="i-ghost i-icon" aria-label="Minimize" title="Minimize" onClick={onMinimize}>
        {chevron(CHEVRON_DOWN)}
      </button>
      <button type="button" className="i-ghost i-icon" aria-label={onEnd ? "End chat" : "Close"} title={onEnd ? "End chat (start a new one next time)" : "Close"} onClick={onEnd ?? onMinimize}>
        {chevron("M7 7l10 10M17 7L7 17")}
      </button>
    </div>
  );
}

/**
 * The short row over the content, only when there's something for it: who's talking in a
 * teammate's chat ("Sam · Acme"), the Earlier / Latest switch, and an intent's exit button
 * (AI-20, D-37: always on screen, one click; never hover-only, never folded away by itself).
 */
export function IslandTop({ who, view, exit }: {
  who: string | null;
  view: { label: string; run: () => void } | null;
  exit: { label: string; run: () => void } | null;
}) {
  if (!who && !view && !exit) return null;
  return (
    <div className="i-top">
      {who && <span className="i-who">{who}</span>}
      {view && <button type="button" className="i-pill-chip" onClick={view.run}>{view.label}</button>}
      <span className="i-spacer" />
      {exit && <button type="button" className="i-exit" onClick={exit.run}>{exit.label}</button>}
    </div>
  );
}

/** The pill's row at the bottom of the open shapes: the mark and the question box, 54px like the resting pill. */
export function IslandRow({ logoUrl, pulse = false, children }: { logoUrl: string | null; pulse?: boolean; children: ReactNode }) {
  return (
    <div className="i-row">
      <Mark logoUrl={logoUrl} pulse={pulse} />
      {children}
    </div>
  );
}

/** Open: the suggested questions as chips over the question box. */
export function IslandChips({ questions, onPick }: { questions: string[]; onPick: (q: string) => void }) {
  if (questions.length === 0) return null;
  return (
    <div className="i-chips" role="group" aria-label="Suggested questions">
      {questions.map((q, i) => (
        <button key={q} type="button" className="i-chip" style={{ animationDelay: `${120 + i * 60}ms` }} onClick={() => onPick(q)}>{q}</button>
      ))}
    </div>
  );
}
