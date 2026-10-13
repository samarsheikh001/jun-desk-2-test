import { useEffect, useState, type RefObject } from "react";

// W-04 "bar" launcher (D-32): the widget as an "Ask anything…" bar, after the Fin messenger on
// fin.ai (sizes, colours, glass layers and timings measured from it). The frame is transparent
// and always shown; it tells the loader its size and which part of it is visible (`jun:css`),
// and the loader applies that as the frame's inline style. Styles: `widget.css` (`html.bar`).

const postToHost = (message: unknown) => window.parent !== window && window.parent.postMessage(message, "*");

/**
 * Sizes the frame: 368px wide closed, 592px open (Fin's widths, minus 20px on phones), up to 571px
 * tall, and clipped to what's drawn (the bar, the chips, or the whole chat panel) so the
 * transparent rest of the frame doesn't take the page's clicks.
 */
export function useBarFrame(enabled: boolean, side: "left" | "right", open: boolean, panel: boolean, bottom: RefObject<HTMLElement | null>): void {
  const [height, setHeight] = useState(88);
  useEffect(() => {
    const el = bottom.current;
    if (!enabled || !el) return;
    // Fin's clip shows 2px more than the bar block (86px closed, clipped at 88px).
    const measure = () => setHeight(Math.ceil(el.offsetHeight) + 2);
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(el);
    return () => observer.disconnect();
  }, [enabled, bottom]);
  const clip = open && panel ? "none" : `inset(calc(100% - ${height}px) 0 0)`;
  useEffect(() => {
    if (!enabled) return;
    postToHost({
      type: "jun:css",
      css:
        // The side too: the loader's full-screen rule for phones would pin the frame to the left.
        `display:block;${side === "left" ? "right:auto;left:20px" : "left:auto;right:20px"};bottom:10px;width:min(${open ? 592 : 368}px, 100vw - 20px);height:min(571px, 100% - 40px);` +
        `border-radius:24px;box-shadow:none;background:none;color-scheme:normal;transition:width .4s cubic-bezier(.25,.1,.25,1);clip-path:${clip}`,
    });
  }, [enabled, side, open, clip]);
}

/**
 * The closed bar's hint: types each suggested question out (about 42ms a letter), then the next
 * one every 5.7s, as Fin's does. Without suggestions it shows the placeholder.
 */
export function Typewriter({ phrases, fallback }: { phrases: string[]; fallback: string }) {
  const [index, setIndex] = useState(0);
  const [length, setLength] = useState(0);
  const phrase = phrases.length ? phrases[index % phrases.length]! : fallback;
  const animate = phrases.length > 0 && !window.matchMedia("(prefers-reduced-motion: reduce)").matches;

  useEffect(() => {
    if (!animate) return;
    setLength(0);
    let typed = 0;
    const typer = setInterval(() => {
      typed += 1;
      setLength(typed);
      if (typed >= phrase.length) clearInterval(typer);
    }, 42);
    const next = setTimeout(() => setIndex((i) => i + 1), 5670);
    return () => {
      clearInterval(typer);
      clearTimeout(next);
    };
  }, [animate, phrase]);

  return (
    <div className="b-hint" aria-hidden="true">
      <span key={index} className="b-hint-text">{animate ? phrase.slice(0, length) : phrase}</span>
    </div>
  );
}

/** Fin's frosted panel: tint and blur, a hairline border, film grain and a light sheen at the top. */
export function Glass() {
  return (
    <div className="b-glass" aria-hidden="true">
      <div className="b-glass-border" />
      <div className="b-glass-noise" />
      <div className="b-glass-sheen" />
    </div>
  );
}

/** The chat panel's header: logo, name, and the button that folds the chat back into the bar. */
export function BarHead({ name, logoUrl, sub, onClose }: { name: string; logoUrl: string | null; sub: string | null; onClose: () => void }) {
  return (
    <div className="b-head">
      <div className="b-head-row">
        <div className="b-title">
          {logoUrl && (
            <div className="b-avatar">
              <img src={logoUrl} alt="" />
            </div>
          )}
          <h1>
            <span>{name}</span>
            {sub && <span className="b-sub"> • {sub}</span>}
          </h1>
        </div>
        <div className="b-head-actions">
          <button className="b-close" aria-label="Close chat" onClick={onClose}>
            <svg width="16" height="16" viewBox="0 0 16 16" fill="none" aria-hidden="true">
              <path d="M4 6l4 4 4-4" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" />
            </svg>
          </button>
        </div>
      </div>
    </div>
  );
}

/** Suggested questions above the open bar; they rise in one after another, bottom first. */
export function Chips({ questions, onPick }: { questions: string[]; onPick: (q: string) => void }) {
  return (
    <div className="b-chips" aria-label="Suggested questions">
      {questions.map((q, i) => (
        <button key={q} className="b-chip" style={{ animationDelay: `${100 + (questions.length - i) * 100}ms` }} onClick={() => onPick(q)}>
          {q}
        </button>
      ))}
    </div>
  );
}
