import type { DayPoint } from "../../shared/metrics.ts";
import { AreaChart } from "@/components/dither-kit/area-chart.tsx";
import { Area } from "@/components/dither-kit/area.tsx";
import type { ChartConfig } from "@/components/dither-kit/chart-context.tsx";
import { Grid } from "@/components/dither-kit/grid.tsx";
import { Legend } from "@/components/dither-kit/legend.tsx";
import { Tooltip } from "@/components/dither-kit/tooltip.tsx";
import { XAxis } from "@/components/dither-kit/x-axis.tsx";
import { YAxis } from "@/components/dither-kit/y-axis.tsx";

// A-01: conversations per day with Dither Kit (motion + d3), lazy-loaded so only the Dashboard pays for it.

const dayLabel = (key: string, opts: Intl.DateTimeFormatOptions) =>
  new Date(`${key}T12:00:00Z`).toLocaleDateString(undefined, { timeZone: "UTC", ...opts });

/** Conversations per day, stacked (Dither Kit): resolved by the AI alone, then the AI's other chats, then the team's. */
const DAY_CONFIG: ChartConfig = {
  aiResolved: { label: "Resolved by the AI", color: "blue" },
  aiThenTeam: { label: "AI, then the team", color: "purple" },
  team: { label: "Team only", color: "grey" },
};
const DAY_CONFIG_NO_AI: ChartConfig = { team: { label: "Conversations", color: "blue" } };

export default function DayChart({ series, showAi, onHover }: { series: DayPoint[]; showAi: boolean; onHover: (day: DayPoint | null) => void }) {
  const short = series.length <= 7;
  const data = series.map((d) => ({
    label: dayLabel(d.day, { weekday: "short", day: "numeric", month: "short" }),
    tick: dayLabel(d.day, short ? { weekday: "short" } : { day: "numeric", month: "short" }),
    aiResolved: d.aiResolved,
    aiThenTeam: d.ai - d.aiResolved,
    team: showAi ? d.conversations - d.ai : d.conversations,
  }));
  return (
    <div className="dither dither-day">
      <AreaChart
        data={data}
        config={showAi ? DAY_CONFIG : DAY_CONFIG_NO_AI}
        stackType="stacked"
        bloom="aura"
        margins={{ top: 36 }}
        onHoverChange={(i) => onHover(i === null ? null : series[i] ?? null)}
      >
        <Grid />
        <XAxis dataKey="tick" maxTicks={short ? 7 : 8} />
        <YAxis tickFormatter={(v) => (Number.isInteger(v) ? v.toLocaleString() : "")} />
        {showAi && <Legend align="left" />}
        <Tooltip labelKey="label" />
        {showAi && <Area dataKey="aiResolved" variant="gradient" />}
        {showAi && <Area dataKey="aiThenTeam" variant="gradient" />}
        <Area dataKey="team" variant="gradient" />
      </AreaChart>
    </div>
  );
}

