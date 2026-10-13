import { useEffect, useId, useRef, useState, type KeyboardEvent, type PointerEvent } from "react";
import type { DayPoint } from "../../shared/metrics.ts";

// A-01: conversations per day as a symmetric stream. Nested bands, outside in: every conversation,
// the AI's, and the ones the AI resolved alone (each a subset of the one around it). Drawn in
// pixels from the measured width so the glow's blur and the curves keep their shape.

const HEIGHT = 240;
/** Room above and below the stream for the marker pills. */
const PAD = 44;
/** Half-thickness each band keeps on an empty day, so the stream reads as one line (outside in). */
const BASE = [3, 2, 1];

const dayLabel = (key: string, opts: Intl.DateTimeFormatOptions) =>
  new Date(`${key}T12:00:00Z`).toLocaleDateString(undefined, { timeZone: "UTC", ...opts });

/** Closed band of half-thickness h[i] around y = mid, smoothed as steps with S-shaped joins. */
function bandPath(xs: number[], h: number[], mid: number, width: number): string {
  // Flat to the card's edges, like the first and last day carry on.
  const px = [0, ...xs, width];
  const ph = [h[0]!, ...h, h[h.length - 1]!];
  const edge = (sign: 1 | -1, order: number[]) => {
    let d = "";
    order.forEach((i, k) => {
      const x = px[i]!;
      const y = mid + sign * ph[i]!;
      if (k === 0) {
        d += `${sign === -1 ? "M" : "L"}${x.toFixed(1)},${y.toFixed(1)}`;
        return;
      }
      const j = order[k - 1]!;
      const cx = (px[j]! + x) / 2;
      d += `C${cx.toFixed(1)},${(mid + sign * ph[j]!).toFixed(1)} ${cx.toFixed(1)},${y.toFixed(1)} ${x.toFixed(1)},${y.toFixed(1)}`;
    });
    return d;
  };
  const idx = px.map((_, i) => i);
  return `${edge(-1, idx)}${edge(1, [...idx].reverse())}Z`;
}

/** Up to `count` evenly spaced indexes, always the first and last. */
function tickIndexes(n: number, count: number): number[] {
  if (n <= count) return Array.from({ length: n }, (_, i) => i);
  const step = (n - 1) / (count - 1);
  return Array.from({ length: count }, (_, i) => Math.round(i * step));
}

export function StreamChart({ series, showAi, onHover }: { series: DayPoint[]; showAi: boolean; onHover: (day: DayPoint | null) => void }) {
  const ref = useRef<HTMLDivElement>(null);
  const [width, setWidth] = useState(0);
  const [hover, setHover] = useState<number | null>(null);
  const glowId = useId().replace(/:/g, "");

  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const ro = new ResizeObserver(([e]) => setWidth(Math.round(e!.contentRect.width)));
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  useEffect(() => onHover(hover === null ? null : series[hover] ?? null), [hover, series, onHover]);

  const n = series.length;
  const mid = HEIGHT / 2;
  const room = mid - PAD;
  const max = Math.max(1, ...series.map((d) => d.conversations));
  // Day centres, inset so the edge days' pills stay on the card.
  const inset = Math.min(44, width / 8);
  const xs = series.map((_, i) => inset + (n === 1 ? (width - 2 * inset) / 2 : (i * (width - 2 * inset)) / (n - 1)));
  const scale = (v: number, base: number) => base + (v / max) * (room - BASE[0]!);
  const bands = showAi
    ? [series.map((d) => scale(d.conversations, BASE[0]!)), series.map((d) => scale(d.ai, BASE[1]!)), series.map((d) => scale(d.aiResolved, BASE[2]!))]
    : [series.map((d) => scale(d.conversations, BASE[0]!))];

  // Markers: the hovered day, else the busiest day and the latest when they're apart.
  const peak = series.reduce((best, d, i) => (d.conversations > series[best]!.conversations ? i : best), 0);
  const marks = hover !== null ? [hover] : series[peak]!.conversations === 0 ? [n - 1] : Math.abs(xs[peak]! - xs[n - 1]!) > 140 ? [peak, n - 1] : [peak];

  const pick = (e: PointerEvent) => {
    const x = e.clientX - e.currentTarget.getBoundingClientRect().left;
    let best = 0;
    xs.forEach((cx, i) => {
      if (Math.abs(cx - x) < Math.abs(xs[best]! - x)) best = i;
    });
    setHover(best);
  };
  const keys = (e: KeyboardEvent) => {
    const step = e.key === "ArrowRight" ? 1 : e.key === "ArrowLeft" ? -1 : 0;
    if (e.key === "Home" || e.key === "End") setHover(e.key === "Home" ? 0 : n - 1);
    else if (step) setHover((h) => Math.min(n - 1, Math.max(0, (h ?? (step > 0 ? -1 : n)) + step)));
    else if (e.key === "Escape") setHover(null);
    else return;
    e.preventDefault();
  };

  const ticks = tickIndexes(n, n <= 7 ? 7 : width < 520 ? 4 : 8);
  const tickOpts: Intl.DateTimeFormatOptions = n <= 7 ? { weekday: "short" } : { day: "numeric", month: "short" };

  return (
    <div className="stream">
      <div
        ref={ref}
        className="stream-plot"
        style={{ height: HEIGHT }}
        tabIndex={0}
        role="img"
        aria-label={`Conversations per day, ${series[0] ? dayLabel(series[0].day, { day: "numeric", month: "short" }) : ""} to ${series[n - 1] ? dayLabel(series[n - 1]!.day, { day: "numeric", month: "short" }) : ""}. Busiest day ${series[peak] ? `${dayLabel(series[peak].day, { weekday: "short", day: "numeric", month: "short" })} with ${series[peak].conversations}` : ""}. Use the arrow keys for each day.`}
        onPointerMove={pick}
        onPointerDown={pick}
        onPointerLeave={(e) => e.pointerType === "mouse" && setHover(null)}
        onKeyDown={keys}
        onBlur={() => setHover(null)}
      >
        {width > 0 && (
          <svg width={width} height={HEIGHT} viewBox={`0 0 ${width} ${HEIGHT}`} aria-hidden="true">
            <defs>
              <filter id={`glow-${glowId}`} x="-20%" y="-60%" width="140%" height="220%">
                <feGaussianBlur stdDeviation="26" />
              </filter>
            </defs>
            <path className="stream-glow" d={bandPath(xs, bands[0]!.map((h) => h + 14), mid, width)} filter={`url(#glow-${glowId})`} />
            <g className="stream-bands">
              {bands.map((h, b) => (
                <path key={b} className={`stream-band b${b}${showAi ? "" : " solo"}`} d={bandPath(xs, h, mid, width)} />
              ))}
            </g>
            {marks.map((i) => (
              <g key={i} className="stream-mark">
                <line x1={xs[i]} x2={xs[i]} y1={PAD - 10} y2={HEIGHT - PAD + 10} className="stream-mark-shadow" />
                <line x1={xs[i]} x2={xs[i]} y1={PAD - 10} y2={HEIGHT - PAD + 10} className="stream-mark-line" />
              </g>
            ))}
          </svg>
        )}
        {width > 0 &&
          marks.map((i) => (
            <div key={i} className="stream-pills" style={{ left: xs[i] }}>
              <span className="stream-pill" style={{ top: PAD - 34 }} title="Conversations">{series[i]!.conversations.toLocaleString()}</span>
              {showAi && (
                <span className="stream-pill" style={{ top: HEIGHT - PAD + 10 }} title="Resolved by the AI">{series[i]!.aiResolved.toLocaleString()}</span>
              )}
            </div>
          ))}
      </div>
      <div className="stream-axis" aria-hidden="true">
        {width > 0 &&
          ticks.map((i) => (
            <span key={i} className={i === hover ? "on" : ""} style={{ left: xs[i] }}>
              {dayLabel(series[i]!.day, tickOpts)}
            </span>
          ))}
      </div>
    </div>
  );
}
