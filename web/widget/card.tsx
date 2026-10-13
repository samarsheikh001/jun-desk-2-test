import { useEffect, useLayoutEffect, useState, type ReactNode, type RefObject } from "react";

// W-04 "card" launcher (D-34): the closed state of the earlier Jun Desk widget, a welcome card
// (its `.mini`) or, once dismissed, a "Chat with us" pill, drawn by the frame itself. Like the
// bar (bar.tsx), the frame tells the loader its size and place (`jun:css`); open, it hands back
// to the loader's panel rules. Styles: `.w-mini*` in widget.css.

const postToHost = (message: unknown) => window.parent !== window && window.parent.postMessage(message, "*");

// The reference's rules, as one inline style the host page evaluates (its viewport, not ours):
// on phones (≤ 768px) the card sits 16px from the edges and is the screen's width less 32px;
// otherwise 22px, and round(min(380, max(300, viewport × .32))) wide. `phone` is a large positive
// length on phones and a large negative one otherwise, which min() and max() turn into the choice.
const phone = "(769px - 100vw) * 1000";
const edge = "max(16px, min(22px, (100vw - 768px) * 1000))";
const cardWidth = `min(100vw - 32px, max(min(380px, max(300px, 32vw)), min(100vw, ${phone})))`;
/** The open panel's grown height (the reference's Expand: 740px; phones stay full screen). */
const grownHeight = `max(min(740px, 100dvh - 44px), min(100dvh, ${phone}))`;

/**
 * Sizes the frame: closed (card launcher), to the card or pill it draws; open, the loader's own
 * panel rules (380×540 at the corner, full screen on phones), or 740px tall when expanded.
 */
export function useCardFrame(card: boolean, side: "left" | "right", open: boolean, grown: boolean, closed: RefObject<HTMLElement | null>, pill: boolean): void {
  const [size, setSize] = useState<{ w: number; h: number } | null>(null);
  useEffect(() => {
    // The card or the pill (the wrapper is the frame's width).
    const el = closed.current?.firstElementChild;
    if (!card || open || !el) return;
    const measure = () => {
      const r = el.getBoundingClientRect();
      setSize({ w: Math.ceil(r.width), h: Math.ceil(r.height) });
    };
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(el);
    return () => observer.disconnect();
  }, [card, open, closed, pill]);
  const other = side === "left" ? "right" : "left";
  const css = open
    ? `display:block${grown ? `;height:${grownHeight}` : ""}`
    : card && size
      ? `display:block;top:auto;bottom:${edge};${side}:${edge};${other}:auto;width:${pill ? `${size.w}px` : cardWidth};height:${size.h}px;` +
        "border:0;border-radius:0;background:none;box-shadow:none;color-scheme:normal;animation:none"
      : null;
  // Before paint: opening, the panel would otherwise be drawn once in the card-sized frame.
  useLayoutEffect(() => {
    if (css !== null) postToHost({ type: "jun:css", css });
  }, [css]);
}

/** The closed welcome card: name and reply time, the welcome, two actions and a message box that opens the chat. */
export function MiniCard({
  name,
  sub,
  logoUrl,
  welcome,
  placeholder,
  onOpen,
  onContact,
  onNewChat,
  onHide,
  icon,
}: {
  name: string;
  sub: string;
  logoUrl: string | null;
  welcome: string;
  placeholder: string;
  onOpen: () => void;
  onContact: () => void;
  onNewChat: () => void;
  onHide: () => void;
  icon: (d: string) => ReactNode;
}) {
  return (
    <div
      className="w-mini"
      role="button"
      tabIndex={0}
      aria-label="Open chat"
      onClick={(e) => {
        if (!(e.target as HTMLElement).closest("button, a")) onOpen();
      }}
      onKeyDown={(e) => {
        if (e.target === e.currentTarget && (e.key === "Enter" || e.key === " ")) {
          e.preventDefault();
          onOpen();
        }
      }}
    >
      <div className={`w-mini-head ${logoUrl ? "has-logo" : ""}`}>
        {logoUrl && <img className="w-mini-logo" src={logoUrl} alt={name} />}
        <span className="w-mini-name">{name}</span>
        <span className="w-mini-sub">{sub}</span>
        <button className="w-mini-x" aria-label="Hide until the next page" title="Hide" onClick={onHide}>{icon("M6 6l12 12M18 6L6 18")}</button>
      </div>
      <p className="w-mini-welcome">{welcome}</p>
      <div className="w-mini-actions">
        <button className="w-mini-act" onClick={onContact}>Contact the team</button>
        <button className="w-mini-act" onClick={onNewChat}>Start a new chat</button>
      </div>
      <button className="w-mini-composer" onClick={onOpen}>
        <span className="w-mini-ph">{placeholder}</span>
        <span className="w-mini-send">{icon("M5 12h14M13 6l6 6-6 6")}</span>
      </button>
      <Badge mini />
    </div>
  );
}

/** "Built with Jun Desk", under the card and the chat (the reference's footer badge, not a link here). */
export function Badge({ mini = false }: { mini?: boolean }) {
  return (
    <span className={`w-badge ${mini ? "mini" : ""}`}>
      <img className="w-badge-logo" src="/jun-agent.svg" alt="" />
      <span>Built with Jun Desk</span>
    </span>
  );
}
