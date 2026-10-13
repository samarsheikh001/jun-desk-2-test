import { useLayoutEffect, useRef, useState } from "react";
import { color, length, type Theme } from "./style.ts";

// W-09: ChatKit's Chart (bar, line and area series over an x axis), as a small SVG that fills the
// card's width. No library: a support card needs a usage trend or a split, not a dashboard.
// Drawn at the measured width in real pixels (text stays its size); the height follows the width
// (half of it) between MIN_H and MAX_H, so a wide card doesn't get a tall chart. A `height` on the
// node wins, within HEIGHT_LIMITS. On a dark card the series use a brighter step (400 over 500).

const SERIES_COLORS: Record<string, string> = {
  blue: "blue-500", purple: "purple-500", orange: "orange-500", green: "green-500", red: "red-500", yellow: "yellow-400", pink: "pink-500",
};
const SERIES_COLORS_DARK: Record<string, string> = {
  blue: "blue-400", purple: "purple-400", orange: "orange-400", green: "green-400", red: "red-400", yellow: "yellow-300", pink: "pink-400",
};
const DEFAULT_ORDER = ["blue", "purple", "orange", "green", "pink", "yellow", "red"];

interface Series {
  type: "bar" | "line" | "area";
  dataKey: string;
  label: string;
  stack: string | null;
  color: string;
}

const DEFAULT_W = 320;
const MIN_H = 120;
const MAX_H = 170;
const HEIGHT_LIMITS = [80, 240] as const;

/** The drawn height: the node's own `height` (px) within limits, else half the width capped to MIN_H..MAX_H. */
export function chartHeight(width: number, height: unknown): number {
  const own = typeof height === "number" ? height : /^\d+(\.\d+)?px$/.test(length(height) ?? "") ? parseFloat(length(height)!) : NaN;
  if (Number.isFinite(own)) return Math.round(Math.min(HEIGHT_LIMITS[1], Math.max(HEIGHT_LIMITS[0], own)));
  return Math.round(Math.min(MAX_H, Math.max(MIN_H, width * 0.5)));
}

function niceMax(value: number): number {
  if (value <= 0) return 1;
  const exp = 10 ** Math.floor(Math.log10(value));
  const n = value / exp;
  return (n <= 1 ? 1 : n <= 2 ? 2 : n <= 2.5 ? 2.5 : n <= 5 ? 5 : 10) * exp;
}

const short = (n: number) => (Math.abs(n) >= 1e6 ? `${+(n / 1e6).toFixed(1)}M` : Math.abs(n) >= 1e3 ? `${+(n / 1e3).toFixed(1)}k` : `${+n.toFixed(2)}`);

export function WidgetChart({ node, theme }: { node: Record<string, unknown>; theme: Theme }) {
  const ref = useRef<HTMLDivElement>(null);
  const [W, setW] = useState(DEFAULT_W);
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    const measure = () => {
      const w = Math.round(el.clientWidth);
      if (w > 0) setW(w);
    };
    measure();
    if (typeof ResizeObserver === "undefined") return;
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    return () => ro.disconnect();
  }, []);
  const H = chartHeight(W, node.height);
  const named = theme === "dark" ? SERIES_COLORS_DARK : SERIES_COLORS;
  const data = (Array.isArray(node.data) ? node.data : []).filter((d): d is Record<string, unknown> => Boolean(d) && typeof d === "object").slice(0, 60);
  const axis = typeof node.xAxis === "string" ? { dataKey: node.xAxis } : ((node.xAxis ?? {}) as { dataKey?: unknown; hide?: unknown; labels?: unknown });
  const xKey = typeof axis.dataKey === "string" ? axis.dataKey : "";
  const labels = axis.labels && typeof axis.labels === "object" ? (axis.labels as Record<string, unknown>) : {};
  const series: Series[] = (Array.isArray(node.series) ? node.series : []).slice(0, 8).flatMap((raw, i) => {
    const s = (raw ?? {}) as Record<string, unknown>;
    if (typeof s.dataKey !== "string" || !["bar", "line", "area"].includes(String(s.type))) return [];
    const own = typeof s.color === "string" && named[s.color] ? named[s.color] : s.color;
    const c = color(own ?? named[DEFAULT_ORDER[i % DEFAULT_ORDER.length]!], theme) ?? "var(--ck-accent)";
    return [{ type: s.type as Series["type"], dataKey: s.dataKey, label: typeof s.label === "string" ? s.label : s.dataKey, stack: typeof s.stack === "string" ? s.stack : null, color: c }];
  });
  if (!data.length || !series.length) return null;

  const num = (v: unknown) => (typeof v === "number" && Number.isFinite(v) ? v : Number(v) || 0);
  const showY = node.showYAxis === true;
  const left = showY ? 34 : 4;
  const bottom = axis.hide === true ? 4 : 20;
  const plotW = W - left - 4;
  const plotH = H - bottom - 6;

  // Stacks add up per x; unstacked bars sit side by side.
  const stackOf = (s: Series) => (s.type === "bar" ? (s.stack ?? `__${s.dataKey}`) : s.type === "area" && s.stack ? s.stack : null);
  const barGroups = [...new Set(series.filter((s) => s.type === "bar").map(stackOf))] as string[];
  let max = 0;
  for (const d of data) {
    const totals = new Map<string, number>();
    for (const s of series) {
      const key = stackOf(s);
      const v = num(d[s.dataKey]);
      if (key) totals.set(key, (totals.get(key) ?? 0) + v);
      else max = Math.max(max, v);
    }
    for (const t of totals.values()) max = Math.max(max, t);
  }
  const top = niceMax(max);
  const y = (v: number) => 6 + plotH - (v / top) * plotH;
  const step = plotW / data.length;
  const cx = (i: number) => left + step * (i + 0.5);
  const groupW = Math.min(step * 0.72, 48);
  const barW = barGroups.length ? groupW / barGroups.length : 0;

  const bars: { x: number; y: number; h: number; color: string; key: string }[] = [];
  const offsets = new Map<string, number>();
  data.forEach((d, i) => {
    offsets.clear();
    for (const s of series.filter((x) => x.type === "bar")) {
      const g = stackOf(s)!;
      const base = offsets.get(g) ?? 0;
      const v = num(d[s.dataKey]);
      offsets.set(g, base + v);
      const gi = barGroups.indexOf(g);
      bars.push({ x: cx(i) - groupW / 2 + gi * barW, y: y(base + v), h: y(base) - y(base + v), color: s.color, key: `${i}-${s.dataKey}` });
    }
  });
  const areaBase = new Map<string, number[]>();
  const lines = series.filter((s) => s.type !== "bar").map((s) => {
    const g = stackOf(s);
    const base = g ? (areaBase.get(g) ?? data.map(() => 0)) : data.map(() => 0);
    const tops = data.map((d, i) => base[i]! + num(d[s.dataKey]));
    if (g) areaBase.set(g, tops);
    const pts = tops.map((v, i) => `${cx(i).toFixed(1)},${y(v).toFixed(1)}`);
    const area = s.type === "area" ? `M${pts.join("L")}L${base.map((v, i) => `${cx(i).toFixed(1)},${y(v).toFixed(1)}`).reverse().join("L")}Z` : null;
    return { s, path: `M${pts.join("L")}`, area };
  });
  const every = Math.max(1, Math.ceil(data.length / 6));
  const legend = node.showLegend !== false && series.length > 1;

  return (
    <div className="ck-chart" ref={ref}>
      {legend && (
        <div className="ck-legend">
          {series.map((s) => (
            <span key={s.dataKey}><i style={{ background: s.color }} />{s.label}</span>
          ))}
        </div>
      )}
      <svg viewBox={`0 0 ${W} ${H}`} width={W} height={H} style={{ height: `${H}px` }} role="img" aria-label={series.map((s) => s.label).join(", ")}>
        {[0, 0.5, 1].map((f) => (
          <g key={f}>
            <line x1={left} x2={W - 4} y1={y(top * f)} y2={y(top * f)} className="ck-grid" />
            {showY && <text x={left - 6} y={y(top * f) + 3} textAnchor="end" className="ck-tick">{short(top * f)}</text>}
          </g>
        ))}
        {bars.map((b) => <rect key={b.key} x={b.x + 0.5} y={b.y} width={Math.max(1, barW - 1)} height={Math.max(0, b.h)} rx={2} fill={b.color} />)}
        {lines.map(({ s, path, area }) => (
          <g key={s.dataKey}>
            {area && <path d={area} fill={s.color} opacity={0.18} />}
            <path d={path} fill="none" stroke={s.color} strokeWidth={2} strokeLinejoin="round" strokeLinecap="round" />
          </g>
        ))}
        {axis.hide !== true &&
          data.map((d, i) =>
            i % every === 0 ? (
              <text key={i} x={cx(i)} y={H - 6} textAnchor="middle" className="ck-tick">
                {String(labels[String(d[xKey])] ?? d[xKey] ?? "").slice(0, 10)}
              </text>
            ) : null,
          )}
      </svg>
    </div>
  );
}
