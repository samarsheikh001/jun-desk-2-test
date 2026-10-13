import { lazy, Suspense, useEffect, useState, type CSSProperties, type MouseEvent, type ReactNode } from "react";
import { ArrowDownIcon as ArrowDown, ArrowRightIcon as ArrowRight, ArrowUpIcon as ArrowUp } from "@/components/icons";
import { formatDuration, MAX_METRIC_CONVERSATIONS, METRIC_PERIODS, type DayPoint, type MetricPeriod, type MetricsReport } from "../../shared/metrics.ts";
import { api, describeError } from "../api.ts";
import { navigate } from "../lib/router.ts";
import { Button } from "@/components/ui/button.tsx";
import { sliceColor } from "./topic-colors.ts";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table.tsx";

const DayChart = lazy(() => import("./DayChart.tsx"));
const KpiSpark = lazy(() => import("./charts.tsx").then((m) => ({ default: m.KpiSpark })));
const ShareDonut = lazy(() => import("./charts.tsx").then((m) => ({ default: m.ShareDonut })));
const PageBars = lazy(() => import("./charts.tsx").then((m) => ({ default: m.PageBars })));
const TopicRadar = lazy(() => import("./charts.tsx").then((m) => ({ default: m.TopicRadar })));
const TeamBars = lazy(() => import("./charts.tsx").then((m) => ({ default: m.TeamBars })));

// A-01: core metrics. Days are calendar days in the browser's time zone; the Worker
// aggregates and shared/metrics.ts defines every number (see docs/features.md A-01, A-06).

const timezone = (() => {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC";
  } catch {
    return "UTC";
  }
})();

const percent = (r: number | null) => (r === null ? "–" : `${Math.round(r * 100)}%`);
const duration = (ms: number | null) => (ms === null ? "–" : formatDuration(ms));
const dayLabel = (key: string, weekday = false) =>
  new Date(`${key}T12:00:00Z`).toLocaleDateString(undefined, { timeZone: "UTC", day: "numeric", month: "short", ...(weekday ? { weekday: "short" } : {}) });

/** A headline number: label, the value in mono, a change or detail under it. */
function Kpi({ label, value, change, detail, off, viz }: { label: string; value: string; change?: ReactNode; detail: ReactNode; off?: boolean; viz?: ReactNode }) {
  return (
    <div className="kpi">
      <div className="kpi-label">{label}</div>
      <div className={`kpi-value${off ? " off" : ""}`}>{value}</div>
      <div className="kpi-viz">{viz}</div>
      <div className="kpi-detail">{change}{detail}</div>
    </div>
  );
}

/** A dithered meter: 0–1 in one colour, or a split of two (`split` is the first colour's part). */
function Meter({ value, tone, split, title }: { value?: number | null; tone?: string; split?: number | null; title: string }) {
  const style = { [split !== undefined ? "--split" : "--value"]: (split !== undefined ? split : value) ?? 0 } as CSSProperties;
  return <div className={`meter-dither ${tone ?? ""}${split !== undefined ? " split" : ""}${(split ?? value) == null ? " empty" : ""}`} style={style} role="img" aria-label={title} title={title} />;
}

/** CSAT in full: the 👍/👎 split and the latest 👎 comments, as quotes that open their chat. */
function Ratings({ csat }: { csat: MetricsReport["csat"] }) {
  const total = csat.good + csat.bad;
  return (
    <section className="dash-card">
      <div className="dash-card-head">
        <h2>Ratings</h2>
        {total > 0 && <span className="dash-caption nums">{total.toLocaleString()} rating{total === 1 ? "" : "s"}</span>}
      </div>
      {total === 0 ? (
        <div className="ratings-empty">
          <div className="ratings-empty-art" aria-hidden="true"><span>👍</span><span>👎</span></div>
          <p>
            <span className="strong">No ratings in this period yet.</span>
            <br />
            <span className="muted">When a chat ends, visitors can rate it 👍 or 👎 and add a comment. Comments on 👎 show up here.</span>
          </p>
        </div>
      ) : (
        <>
          <div className="ratings-split">
            <div className="ratings-side good"><span className="ratings-n">{csat.good.toLocaleString()}</span> 👍 {percent(csat.good / total)}</div>
            <div className="ratings-side bad">{percent(csat.bad / total)} 👎 <span className="ratings-n">{csat.bad.toLocaleString()}</span></div>
          </div>
          <Meter split={csat.good / total} title={`${csat.good} good, ${csat.bad} bad`} />
          <h3 className="ratings-sub">Recent 👎 comments</h3>
          {csat.badComments.length === 0 ? (
            <p className="muted small">{csat.bad === 0 ? "No 👎 ratings in this period." : "None of the 👎 ratings came with a comment."}</p>
          ) : (
            <ul className="quotes">
              {csat.badComments.map((x) => (
                <li key={`${x.conversationId}:${x.createdAt}`}>
                  <a href={`/inbox/${x.conversationId}`} onClick={goTo(`/inbox/${x.conversationId}`)}>
                    <span className="quote-text">{x.comment}</span>
                    <span className="quote-meta">{new Date(x.createdAt).toLocaleString(undefined, { day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" })} · Open chat →</span>
                  </a>
                </li>
              ))}
            </ul>
          )}
        </>
      )}
    </section>
  );
}

/** The change against the period before; null without one to compare against. */
function Change({ change, days }: { change: number | null; days: number }) {
  if (change === null) return null;
  const pct = Math.round(Math.abs(change) * 1000) / 10;
  const dir = pct === 0 ? "flat" : change > 0 ? "up" : "down";
  const Icon = dir === "flat" ? ArrowRight : dir === "up" ? ArrowUp : ArrowDown;
  return (
    <span className={`kpi-change ${dir}`} title={`Against the ${days} days before`}>
      <Icon aria-hidden="true" />
      {dir === "flat" ? "0%" : `${pct}%`}
    </span>
  );
}

const goTo = (path: string) => (e: MouseEvent) => {
  e.preventDefault();
  navigate(path);
};

/** A-06: where visitors were when they opened a chat. Paths only when every page is on one site. */
function StartPages({ pages }: { pages: MetricsReport["pages"] }) {
  const origins = new Set(pages.top.map((p) => new URL(p.page).origin));
  const site = origins.size === 1 ? new URL(pages.top[0]!.page).host : null;
  const label = (page: string) => {
    const u = new URL(page);
    let path = u.pathname;
    try {
      path = decodeURI(path);
    } catch {
      // Not valid percent-encoding: show it as stored.
    }
    // Long paths wrap after a slash; with several sites the host stays on one line.
    const parts = (site || path !== "/" ? path : "").split(/(?<=\/)/);
    return (
      <>
        {!site && <span className="page-host">{u.host}</span>}
        {parts.map((part, i) => (
          <span key={i}>
            {part}
            <wbr />
          </span>
        ))}
      </>
    );
  };
  const rest = pages.withPage - pages.top.reduce((s, p) => s + p.count, 0);
  // The bar chart's axis: path (with the host when there are several sites), shortened in the middle.
  const short = (page: string) => {
    const u = new URL(page);
    const text = (site ? "" : u.host) + u.pathname;
    return text.length > 16 ? `${text.slice(0, 7)}…${text.slice(-8)}` : text;
  };
  return (
    <section className="dash-card">
      <div className="dash-card-head">
        <h2>Pages where chats start</h2>
        {site && <span className="muted small nums">{site}</span>}
      </div>
      {pages.top.length === 0 ? (
        <p className="muted small">
          No chats from your site in this period. The widget notes the page a visitor is on when they send their first message.
        </p>
      ) : (
        <>
          {pages.top.length >= 2 && (
            <Suspense fallback={<div className="dither dither-bars short" />}>
              <PageBars pages={pages.top.map((p) => ({ label: short(p.page), page: p.page, chats: p.count }))} />
            </Suspense>
          )}
          <ul className="dash-rows bars">
            {pages.top.map((p) => (
              <li key={p.page} title={p.page} style={{ "--share": p.share } as CSSProperties}>
                <span className="dash-row-label page-path">{label(p.page)}</span>
                <span className="dash-row-share">{percent(p.share)}</span>
                <span className="dash-row-value">{p.count.toLocaleString()}</span>
              </li>
            ))}
          </ul>
          <p className="dash-foot">
            Share of the {pages.withPage.toLocaleString()} chats that started on a known page{rest > 0 ? ` (${rest} on pages not listed)` : ""}.
            {pages.withoutPage > 0 && ` ${pages.withoutPage} had no page (opened outside your site).`} Numbers and ids in paths are grouped as :id.
          </p>
        </>
      )}
    </section>
  );
}

/** Most topics "Top topics" lists. */
const MAX_TOPICS_SHOWN = 8;

/** A-02: what visitors ask about, from the AI's topic labels. A topic opens the inbox filtered by it. */
function TopTopics({ topics, showAi, aiEnabled }: { topics: MetricsReport["topics"]; showAi: boolean; aiEnabled: boolean }) {
  const top = topics.list.slice(0, MAX_TOPICS_SHOWN);
  const rest = topics.list.length - top.length;
  return (
    <section className="dash-card">
      <div className="dash-card-head">
        <h2>Top topics</h2>
        <a className="small" href="/settings/inbox#topics" onClick={goTo("/settings/inbox#topics")}>Manage</a>
      </div>
      {top.length === 0 ? (
        <p className="muted small">
          {!aiEnabled ? (
            <>
              The AI assistant labels each chat with a short topic, like Billing or Login, and AI replies are off.{" "}
              <a href="/settings/ai" onClick={goTo("/settings/ai")}>Turn it on</a>
            </>
          ) : topics.unlabeled > 0
            ? "Topics appear after chats go quiet for a few minutes: the AI gives each one a short label, like Billing or Login."
            : "No chats in this period yet. Topics appear after chats go quiet for a few minutes."}
        </p>
      ) : (
        <>
          <Suspense fallback={<div className="dither dither-donut" />}>
            <ShareDonut items={topics.list} total={topics.labeled} otherLabel="Other topics" />
          </Suspense>
          <ul className="dash-rows links bars">
            {top.map((t, i) => (
              <li key={t.id} style={{ "--share": t.share, "--swatch": sliceColor(i) ?? "var(--muted-foreground)" } as CSSProperties}>
                <a href={`/inbox?topic=${t.id}`} onClick={goTo(`/inbox?topic=${encodeURIComponent(t.id)}`)} title={`Open the ${t.name} conversations in the inbox`}>
                  <span className="dash-row-label"><i className="dash-swatch" aria-hidden="true" />{t.name}</span>
                  {showAi && t.aiResolutionRate !== null && <span className="dash-row-tag" title="Resolved by the AI alone, of this topic's AI chats">AI {percent(t.aiResolutionRate)}</span>}
                  <span className="dash-row-share">{percent(t.share)}</span>
                  <span className="dash-row-value">{t.count.toLocaleString()}</span>
                </a>
              </li>
            ))}
          </ul>
          <p className="dash-foot">
            Share of the {topics.labeled.toLocaleString()} labelled chats{rest > 0 ? ` (${rest} more topic${rest === 1 ? "" : "s"} not listed)` : ""}.
            {showAi && top.some((t) => t.aiResolutionRate !== null) && " AI % is how many of the topic's AI chats the AI resolved alone."}
            {!aiEnabled && " New chats aren't labelled while AI replies are off."}
            {aiEnabled && topics.unlabeled > 0 && ` ${topics.unlabeled} chat${topics.unlabeled === 1 ? " isn't" : "s aren't"} labelled yet (still going, or quiet for less than a few minutes).`}
          </p>
        </>
      )}
    </section>
  );
}

/** A-01's headline card: the conversations stream over the headline numbers. */
function Overview({ r }: { r: MetricsReport }) {
  const [day, setDay] = useState<DayPoint | null>(null);
  const showAi = !r.ai.off;
  return (
    <section className="dash-card dash-hero">
      <div className="dash-card-head">
        <h2>Conversations</h2>
        <span className="dash-caption" aria-live="polite">
          {day ? (
            <>
              <span className="strong">{dayLabel(day.day, true)}</span> · {day.conversations} conversation{day.conversations === 1 ? "" : "s"}
              {showAi && ` · ${day.aiResolved} resolved by the AI`}
            </>
          ) : (
            `Last ${r.days} days`
          )}
        </span>
      </div>
      <Suspense fallback={<div className="dither dither-day" />}>
        <DayChart key={r.days} series={r.conversations.series} showAi={showAi} onHover={setDay} />
      </Suspense>
      <div className="kpis">
        <Kpi
          label="Conversations"
          value={r.conversations.total.toLocaleString()}
          change={<Change change={r.conversations.change} days={r.days} />}
          detail={`${r.conversations.resolved.toLocaleString()} resolved`}
          viz={
            <Suspense fallback={null}>
              <KpiSpark data={r.conversations.series.map((d) => d.conversations)} />
            </Suspense>
          }
        />
        {r.ai.off ? (
          <Kpi
            label="AI assistant"
            value="Off"
            off
            detail={<>Your team answers every chat. <a href="/settings/ai" onClick={goTo("/settings/ai")}>Turn it on</a></>}
          />
        ) : (
          <>
            <Kpi
              label="AI resolved"
              value={percent(r.ai.resolutionRate)}
              detail={`${r.ai.resolved} of ${r.ai.conversations} AI chats`}
              viz={<Meter value={r.ai.resolutionRate} tone="green" title={`AI resolved ${percent(r.ai.resolutionRate)}`} />}
            />
            <Kpi
              label="Handed off"
              value={percent(r.ai.handoffRate)}
              detail={`${r.ai.handedOff} of ${r.ai.conversations} AI chats`}
              viz={<Meter value={r.ai.handoffRate} tone="purple" title={`Handed off ${percent(r.ai.handoffRate)}`} />}
            />
          </>
        )}
        <Kpi
          label="First response"
          value={duration(r.team.firstResponse.median)}
          detail={r.team.firstResponse.p90 === null ? "No team replies yet" : `90% within ${duration(r.team.firstResponse.p90)}`}
          viz={
            <Meter
              value={r.team.firstResponse.p90 ? (r.team.firstResponse.median ?? 0) / r.team.firstResponse.p90 : null}
              tone="orange"
              title="The median first response against the time 90% of first responses come within"
            />
          }
        />
        <Kpi
          label="CSAT"
          value={r.csat.score === null ? "No ratings" : percent(r.csat.score)}
          off={r.csat.score === null}
          detail={`👍 ${r.csat.good} · 👎 ${r.csat.bad}`}
          viz={<Meter split={r.csat.score} title={`${r.csat.good} good, ${r.csat.bad} bad`} />}
        />
      </div>
      <p className="dash-foot">
        {r.conversations.previousTotal !== null && `The change is against the ${r.days} days before (${r.conversations.previousTotal.toLocaleString()} conversations). `}
        First response is the median time from a visitor's first message to the team's first reply.
        {r.ai.firstResponse.median !== null && ` The AI's first answer takes ${duration(r.ai.firstResponse.median)} (median).`}
        {!r.ai.off && !r.ai.enabled && " AI replies are off now; the AI numbers are from earlier in the period."}
        {!r.ai.off && r.ai.passedWhileOff > 0 &&
          ` ${r.ai.passedWhileOff} chat${r.ai.passedWhileOff === 1 ? "" : "s"} reached the AI while it was off and went to the team; ${r.ai.passedWhileOff === 1 ? "it isn't" : "they aren't"} counted as handoffs.`}
      </p>
    </section>
  );
}

export function ReportsPage({ workspaceId }: { workspaceId: string }) {
  const [days, setDays] = useState<MetricPeriod>(7);
  const [report, setReport] = useState<MetricsReport | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let current = true;
    setError(null);
    api<{ report: MetricsReport }>(`/workspaces/${workspaceId}/metrics?days=${days}&tz=${encodeURIComponent(timezone)}`).then(
      (r) => current && setReport(r.report),
      (e) => current && setError(describeError(e)),
    );
    return () => {
      current = false;
    };
  }, [workspaceId, days]);

  const r = report?.days === days ? report : null;
  const empty = r && r.conversations.total === 0 && r.csat.good + r.csat.bad === 0;

  return (
    <div className="content wide reports">
      <div className="row reports-head">
        <h2>Dashboard</h2>
        <span className="spacer" />
        <div className="segmented" role="group" aria-label="Period">
          {METRIC_PERIODS.map((p) => (
            <Button key={p} variant="ghost" size="sm" className={p === days ? "active" : ""} aria-pressed={p === days} onClick={() => setDays(p)}>{p} days</Button>
          ))}
        </div>
      </div>
      {error && <p className="error">{error}</p>}
      {!r ? (
        !error && <div className="dash-card dash-loading" aria-busy="true"><p className="muted">Loading…</p></div>
      ) : empty ? (
        <section className="dash-card">
          <p className="muted">No conversations in the last {days} days. Numbers show up here once visitors start chatting.</p>
        </section>
      ) : (
        <>
          {r.truncated && <p className="muted small">Based on the newest {MAX_METRIC_CONVERSATIONS.toLocaleString()} conversations in this period.</p>}
          <Overview r={r} />

          <div className="dash-grid">
            <TopTopics topics={r.topics} showAi={!r.ai.off} aiEnabled={r.ai.enabled} />
            {r.topics.list.length >= 3 && (
              <section className="dash-card">
                <div className="dash-card-head"><h2>Topics at a glance</h2></div>
                <Suspense fallback={<div className="dither dither-radar" />}>
                  <TopicRadar topics={r.topics.list} showAi={!r.ai.off} />
                </Suspense>
                <p className="dash-foot">
                  Each axis is one of your top {Math.min(6, r.topics.list.length)} topics: how many chats it brought
                  {!r.ai.off && ", and how many of those the AI resolved alone"}.
                </p>
              </section>
            )}
            <StartPages pages={r.pages} />
            {!r.ai.off && (
              <section className="dash-card">
                <div className="dash-card-head"><h2>Top handoff reasons</h2></div>
                {r.ai.reasons.length === 0 ? (
                  <p className="muted small">No handoffs in this period.</p>
                ) : (
                  <>
                    <Suspense fallback={<div className="dither dither-donut" />}>
                      <ShareDonut items={r.ai.reasons.map((x) => ({ name: x.reason, count: x.count }))} total={r.ai.handedOff} otherLabel="Other reasons" />
                    </Suspense>
                    <ul className="dash-rows bars">
                      {r.ai.reasons.map((x, i) => (
                        <li key={x.reason} style={{ "--share": x.count / r.ai.reasons[0]!.count, "--swatch": sliceColor(i) ?? "var(--muted-foreground)" } as CSSProperties}>
                          <span className="dash-row-label"><i className="dash-swatch" aria-hidden="true" />{x.reason}</span>
                          <span className="dash-row-value">{x.count.toLocaleString()}</span>
                        </li>
                      ))}
                    </ul>
                  </>
                )}
              </section>
            )}
            <Ratings csat={r.csat} />
          </div>

          <section className="dash-card">
            <div className="dash-card-head"><h2>Team</h2></div>
            {r.teammates.filter((t) => t.replies > 0).length >= 2 && (
              <Suspense fallback={<div className="dither dither-bars" />}>
                <TeamBars teammates={r.teammates} />
              </Suspense>
            )}
            <Table className="team-table">
              <TableHeader>
                <TableRow>
                  <TableHead>Teammate</TableHead>
                  <TableHead>Replies</TableHead>
                  <TableHead>Conversations</TableHead>
                  <TableHead>First response</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {r.teammates.map((t) => (
                  <TableRow key={t.userId}>
                    <TableCell className="strong">{t.name}</TableCell>
                    <TableCell data-label="Replies">{t.replies.toLocaleString()}</TableCell>
                    <TableCell data-label="Conversations">{t.conversations.toLocaleString()}</TableCell>
                    <TableCell data-label="First response">{duration(t.firstResponse.median)}</TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
            <p className="dash-foot">Replies the teammate sent in this period (not notes), the conversations they replied in, and their median first response when they answered first.</p>
          </section>
        </>
      )}
    </div>
  );
}
