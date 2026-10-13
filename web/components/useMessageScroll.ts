import { useCallback, useLayoutEffect, useRef, useState, type RefObject } from "react";

// Transcript scrolling, after shadcn's Message Scroller (ui.shadcn.com/docs/components/base/message-scroller):
// - It follows new content only while the reader is at the bottom (`follow`). Scrolling up by wheel,
//   touch, keys or the scrollbar lets go (`free`); new words never move a reader who scrolled away.
//   Back at the bottom (or the jump button), it follows again.
// - `anchor` mode (the widget): a new message of the visitor's (`data-anchor` on its row) moves near
//   the top with PEEK px of the row before it showing, and the reply streams in below while the view
//   stays put (`anchored`). A spacer under the rows makes room for that while the reply is short;
//   once the reply fills the view, following takes over.
// - It opens at the bottom, or (`anchor`) at the visitor's last message when what follows it is
//   taller than the view, so a returning visitor reads the last answer from its start.
// Never scrollIntoView: in the widget that scrolls the host page too. All of it reads and writes the
// scroll box directly: scrolling and streaming don't re-render anything but the jump button.

/** The reader is "at the bottom" within this many px. */
const EDGE = 8;
/** How much of the row before an anchored message stays visible above it. */
const PEEK = 64;
const UP_KEYS = new Set(["ArrowUp", "PageUp", "Home"]);
const SCROLL_KEYS = new Set(["ArrowUp", "ArrowDown", "PageUp", "PageDown", "Home", "End", " "]);

export type Follow = "end" | "start" | "anchor";
type Mode = "follow" | "free" | "anchored";

/** The nearest ancestor that scrolls: the widget's body, the bar's log, the inbox's ScrollArea viewport. */
function findBox(list: HTMLElement): HTMLElement | null {
  let box = list.parentElement;
  while (box && !/(auto|scroll)/.test(getComputedStyle(box).overflowY)) box = box.parentElement;
  return box;
}

/**
 * Drives the scroll box around `list` (the `.messages` element). `spacer` is an empty element at the
 * end of the list; `reset` (the first row's key) starts over when a different conversation shows.
 * Returns whether the jump-to-latest button should show, and the jump itself.
 */
export function useMessageScroll(
  list: RefObject<HTMLDivElement | null>,
  spacer: RefObject<HTMLDivElement | null>,
  follow: Follow,
  reset: string | undefined,
): { jump: boolean; toLatest: () => void } {
  const [jump, setJump] = useState(false);
  const s = useRef({
    box: null as HTMLElement | null,
    mode: "follow" as Mode,
    /** The anchored row's data-anchor. */
    anchor: null as string | null,
    /** Anchors already handled: only a new one moves the view. */
    seen: new Set<string>(),
    /** The opening position has been applied. */
    placed: false,
    space: 0,
    /** The last scrollTop seen, and the last one we set (to tell the reader's scrolls from ours). */
    lastTop: 0,
    ourTop: -1,
  }).current;
  const active = follow !== "start";

  const box = () => {
    if (!s.box?.isConnected) s.box = list.current ? findBox(list.current) : null;
    return s.box;
  };
  const setSpace = (px: number) => {
    const el = spacer.current;
    const h = Math.max(0, Math.ceil(px));
    if (!el || h === s.space) return;
    s.space = h;
    el.hidden = h === 0;
    el.style.height = `${h}px`;
  };
  /** Where the rows (and whatever follows them in the box) end, without the spacer. */
  const contentEnd = (b: HTMLElement) => b.scrollHeight - s.space;
  const below = (b: HTMLElement) => contentEnd(b) - b.scrollTop - b.clientHeight;
  const setTop = (b: HTMLElement, top: number, smooth = false) => {
    const target = Math.max(0, Math.min(top, b.scrollHeight - b.clientHeight));
    s.ourTop = target;
    if (smooth) b.scrollTo({ top: target, behavior: "smooth" });
    else b.scrollTop = target;
  };
  const sync = (b: HTMLElement) => setJump(s.mode !== "follow" && below(b) > EDGE);
  const row = (id: string) => list.current?.querySelector<HTMLElement>(`[data-anchor="${CSS.escape(id)}"]`) ?? null;
  const offset = (b: HTMLElement, el: HTMLElement) => el.getBoundingClientRect().top - b.getBoundingClientRect().top + b.scrollTop;

  const toEnd = (b: HTMLElement, smooth = false) => {
    setSpace(0);
    s.mode = "follow";
    s.anchor = null;
    setTop(b, b.scrollHeight - b.clientHeight, smooth);
    sync(b);
  };
  const toAnchor = (b: HTMLElement, id: string, el: HTMLElement) => {
    const top = Math.max(0, offset(b, el) - PEEK);
    // Room under the rows so `top` can be scrolled to while the reply is still short.
    setSpace(top + b.clientHeight - contentEnd(b));
    s.mode = "anchored";
    s.anchor = id;
    setTop(b, top);
    sync(b);
  };
  /** Anchored, after a resize: hold the message in place; once the reply fills the view, follow it. */
  const reanchor = (b: HTMLElement) => {
    const el = s.anchor ? row(s.anchor) : null;
    if (!el) {
      s.mode = "free";
      return sync(b);
    }
    const had = s.space;
    toAnchor(b, s.anchor!, el);
    if (had > 0 && s.space === 0) toEnd(b);
  };
  /** Scrolled away: the spacer only shrinks (never below the view, so nothing jumps). */
  const shrink = (b: HTMLElement) => {
    if (s.space > 0) setSpace(Math.min(s.space, b.scrollTop + b.clientHeight - contentEnd(b)));
  };

  const place = (b: HTMLElement) => {
    const ids = [...(list.current?.querySelectorAll<HTMLElement>("[data-anchor]") ?? [])].map((el) => el.dataset.anchor!);
    // Nothing to measure yet (no rows, or the widget is closed): try again on the next change.
    if (!list.current?.querySelector(".msg, .system-msg") || b.clientHeight === 0) return;
    s.placed = true;
    ids.forEach((id) => s.seen.add(id));
    const lastId = follow === "anchor" ? ids.at(-1) : undefined;
    const last = lastId ? row(lastId) : null;
    if (lastId && last && contentEnd(b) - offset(b, last) > b.clientHeight) toAnchor(b, lastId, last);
    else toEnd(b);
  };

  /** After every render (rows added, the reply growing): place, anchor a new message, or follow. */
  const onRows = () => {
    const b = box();
    if (!active || !b) return;
    if (!s.placed) return place(b);
    const fresh: string[] = [];
    for (const el of list.current?.querySelectorAll<HTMLElement>("[data-anchor]") ?? []) {
      const id = el.dataset.anchor!;
      if (!s.seen.has(id)) s.seen.add(id), fresh.push(id);
    }
    const el = follow === "anchor" && fresh.length === 1 ? row(fresh[0]!) : null;
    if (el) return toAnchor(b, fresh[0]!, el);
    if (s.mode === "follow") return toEnd(b);
    if (s.mode === "anchored") return reanchor(b);
    shrink(b);
    sync(b);
  };
  const onRowsRef = useRef(onRows);
  onRowsRef.current = onRows;

  // A different conversation: start over.
  const resetRef = useRef(reset);
  if (resetRef.current !== reset) {
    resetRef.current = reset;
    s.placed = false;
    s.seen.clear();
    s.mode = "follow";
    s.anchor = null;
  }

  // eslint-disable-next-line react-hooks/exhaustive-deps
  useLayoutEffect(() => onRowsRef.current());

  useLayoutEffect(() => {
    const b = active && list.current ? box() : null;
    if (!b || !list.current) return;
    let touchY = 0;
    let frame = 0;
    const letGo = (up: boolean) => {
      // Up always lets go; down only lets go of an anchored message (following stays following).
      if (!up && s.mode !== "anchored") return;
      s.mode = "free";
      s.anchor = null;
      sync(b);
    };
    const onWheel = (e: WheelEvent) => letGo(e.deltaY < 0);
    const onTouchStart = (e: TouchEvent) => (touchY = e.touches[0]?.clientY ?? 0);
    const onTouchMove = (e: TouchEvent) => letGo((e.touches[0]?.clientY ?? 0) > touchY);
    const onKey = (e: KeyboardEvent) => {
      const t = e.target as HTMLElement | null;
      if (!SCROLL_KEYS.has(e.key) || (t && (t.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(t.tagName)))) return;
      letGo(UP_KEYS.has(e.key) || (e.key === " " && e.shiftKey));
    };
    const onScroll = () => {
      const top = b.scrollTop;
      const up = top < s.lastTop - 0.5;
      const ours = Math.abs(top - s.ourTop) <= 1;
      s.lastTop = top;
      if (s.mode === "free") shrink(b);
      const atEnd = below(b) <= EDGE;
      // The scrollbar dragged up (wheel, touch and keys already said so).
      if (up && !ours && !atEnd && s.mode !== "free") s.mode = "free", (s.anchor = null);
      else if (atEnd && s.mode === "free") s.mode = "follow";
      sync(b);
    };
    const onResize = () => {
      cancelAnimationFrame(frame);
      frame = requestAnimationFrame(() => {
        if (!s.placed) return onRowsRef.current();
        if (s.mode === "follow") toEnd(b);
        else if (s.mode === "anchored") reanchor(b);
        else shrink(b), sync(b);
      });
    };
    b.addEventListener("scroll", onScroll, { passive: true });
    b.addEventListener("wheel", onWheel, { passive: true });
    b.addEventListener("touchstart", onTouchStart, { passive: true });
    b.addEventListener("touchmove", onTouchMove, { passive: true });
    b.addEventListener("keydown", onKey);
    // The rows growing (a streamed reply, images, a card) and the box itself (the window, the keyboard).
    const observer = typeof ResizeObserver === "undefined" ? null : new ResizeObserver(onResize);
    observer?.observe(list.current);
    observer?.observe(b);
    return () => {
      cancelAnimationFrame(frame);
      observer?.disconnect();
      b.removeEventListener("scroll", onScroll);
      b.removeEventListener("wheel", onWheel);
      b.removeEventListener("touchstart", onTouchStart);
      b.removeEventListener("touchmove", onTouchMove);
      b.removeEventListener("keydown", onKey);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [active, reset]);

  const toLatest = useCallback(() => {
    const b = s.box;
    if (b) toEnd(b, !window.matchMedia("(prefers-reduced-motion: reduce)").matches);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  return { jump, toLatest };
}
