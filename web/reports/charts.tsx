import type { MetricsReport } from "../../shared/metrics.ts";
import { Bar } from "@/components/dither-kit/bar.tsx";
import { BarChart } from "@/components/dither-kit/bar-chart.tsx";
import type { ChartConfig } from "@/components/dither-kit/chart-context.tsx";
import { Grid } from "@/components/dither-kit/grid.tsx";
import { Legend } from "@/components/dither-kit/legend.tsx";
import { Pie } from "@/components/dither-kit/pie.tsx";
import { PieChart } from "@/components/dither-kit/pie-chart.tsx";
import { Radar } from "@/components/dither-kit/radar.tsx";
import { RadarChart } from "@/components/dither-kit/radar-chart.tsx";
import { Sparkline } from "@/components/dither-kit/sparkline.tsx";
import { Tooltip } from "@/components/dither-kit/tooltip.tsx";
import { XAxis } from "@/components/dither-kit/x-axis.tsx";
import { YAxis } from "@/components/dither-kit/y-axis.tsx";
import { DONUT_SLICES, SLICE_COLORS } from "./topic-colors.ts";

// A-01 / A-02: the Dashboard's other Dither Kit charts (share donuts, topics radar, page and team bars),
// lazy-loaded with DayChart so only the Dashboard pays for motion + d3.

/** The Conversations headline's sparkline: chats per day. */
export function KpiSpark({ data }: { data: number[] }) {
  return (
    <div className="dither kpi-spark">
      <Sparkline data={data} color="blue" bloom="low" animate />
    </div>
  );
}

type Topic = MetricsReport["topics"]["list"][number];

/**
 * Share of a whole per item (topics, handoff reasons): the first DONUT_SLICES in colour, the rest
 * one grey slice. Config keys are slice ids, since names can be anything.
 */
export function ShareDonut({ items, total, otherLabel }: { items: { name: string; count: number }[]; total: number; otherLabel: string }) {
  const top = items.slice(0, DONUT_SLICES);
  const other = total - top.reduce((s, t) => s + t.count, 0);
  const data = [
    ...top.map((t, i) => ({ slice: `s${i}`, name: t.name, chats: t.count })),
    ...(other > 0 ? [{ slice: "other", name: otherLabel, chats: other }] : []),
  ];
  const config: ChartConfig = Object.fromEntries(
    data.map((d, i) => [d.slice, { label: d.name, color: d.slice === "other" ? "grey" : SLICE_COLORS[i]! }]),
  );
  return (
    <div className="dither dither-donut">
      <PieChart data={data} config={config} dataKey="chats" nameKey="slice" innerRadius={0.6} bloom="low">
        <Pie variant="gradient" />
        <Tooltip labelKey="name" />
      </PieChart>
    </div>
  );
}

const PAGE_CONFIG: ChartConfig = { chats: { label: "Chats", color: "blue" } };

/** Chats started per page; `label` is short enough for the axis, `page` the full one for the tooltip. */
export function PageBars({ pages }: { pages: { label: string; page: string; chats: number }[] }) {
  return (
    <div className="dither dither-bars short">
      <BarChart data={pages} config={PAGE_CONFIG} bloom="low" margins={{ top: 12 }}>
        <Grid />
        <XAxis dataKey="label" />
        <YAxis tickFormatter={(v) => (Number.isInteger(v) ? v.toLocaleString() : "")} />
        <Tooltip labelKey="page" />
        <Bar dataKey="chats" variant="gradient" />
      </BarChart>
    </div>
  );
}

const RADAR_CONFIG: ChartConfig = {
  chats: { label: "Chats", color: "blue" },
  aiResolved: { label: "Resolved by the AI", color: "green" },
};

/** Each topic is an axis: how many chats it brings, and how many of them the AI resolved alone. Needs 3+ topics. */
export function TopicRadar({ topics, showAi }: { topics: Topic[]; showAi: boolean }) {
  const data = topics.slice(0, 6).map((t) => ({ topic: t.name, chats: t.count, aiResolved: t.aiResolved }));
  return (
    <div className="dither dither-radar">
      <RadarChart data={data} config={showAi ? RADAR_CONFIG : { chats: RADAR_CONFIG.chats! }} nameKey="topic" bloom="low" margins={{ top: 44 }}>
        <Radar dataKey="chats" variant="gradient" />
        {showAi && <Radar dataKey="aiResolved" variant="dotted" />}
        {showAi && <Legend align="left" />}
        <Tooltip labelKey="topic" />
      </RadarChart>
    </div>
  );
}

const TEAM_CONFIG: ChartConfig = {
  replies: { label: "Replies", color: "blue" },
  conversations: { label: "Conversations", color: "purple" },
};

/** Replies and conversations per teammate who replied in the period (most first, up to 8). */
export function TeamBars({ teammates }: { teammates: MetricsReport["teammates"] }) {
  const data = teammates
    .filter((t) => t.replies > 0)
    .slice(0, 8)
    .map((t) => ({ name: t.name.split(" ")[0] || t.name, fullName: t.name, replies: t.replies, conversations: t.conversations }));
  return (
    <div className="dither dither-bars">
      <BarChart data={data} config={TEAM_CONFIG} bloom="low" margins={{ top: 32 }}>
        <Grid />
        <XAxis dataKey="name" />
        <YAxis tickFormatter={(v) => (Number.isInteger(v) ? v.toLocaleString() : "")} />
        <Legend align="left" />
        <Tooltip labelKey="fullName" />
        <Bar dataKey="replies" variant="gradient" />
        <Bar dataKey="conversations" variant="hatched" />
      </BarChart>
    </div>
  );
}
