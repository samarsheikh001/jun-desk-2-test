import { lazy, Suspense, useEffect, useMemo, useState, type CSSProperties, type FormEvent, type ReactNode } from "react";
import type { LiveVisitor } from "../../shared/protocol.ts";
import { api, describeError } from "../api.ts";
import { describeBrowser } from "../../shared/debug.ts";
import { Button } from "@/components/ui/button.tsx";
import { Input } from "@/components/ui/input.tsx";
import { globeSpots } from "../lib/globe-spots.ts";
import { DONUT_SLICES, sliceColor } from "../reports/topic-colors.ts";

// MapLibre is big (~220 KB gzipped): only this page loads it.
const VisitorGlobe = lazy(() => import("./VisitorGlobe.tsx"));

// V-01 live visitors and V-07 agent-started chats. The list itself comes from the workspace
// hub socket (Shell keeps it), so it updates as people browse. Laid out like the Dashboard:
// flat sections, numbers in Geist Mono, dithered share rows.

const duration = (ms: number) => {
  const s = Math.max(0, Math.round(ms / 1000));
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  return m < 60 ? `${m}m ${s % 60}s` : `${Math.floor(m / 60)}h ${m % 60}m`;
};

/** "Visitor #4821" from the session id (stable while they browse). */
const sessionLabel = (id: string) => `Visitor #${(parseInt(id.slice(0, 6), 16) % 9000) + 1000}`;
const visitorName = (v: LiveVisitor) => v.contact?.name ?? v.contact?.email ?? sessionLabel(v.sessionId);

const countryName = (() => {
  let names: Intl.DisplayNames | null = null;
  try {
    names = new Intl.DisplayNames(undefined, { type: "region" });
  } catch {}
  return (code: string) => {
    try {
      return names?.of(code) ?? code;
    } catch {
      return code;
    }
  };
})();


function pathOf(url: string): string {
  try {
    const u = new URL(url);
    // The loader masks query values as "…"; show it, not %E2%80%A6.
    return decodeURI(`${u.host}${u.pathname}${u.search}`);
  } catch {
    return url;
  }
}

/** Where they came from: the referrer's host, or null for a direct visit. */
function sourceOf(referrer: string | null): string | null {
  if (!referrer) return null;
  try {
    return new URL(referrer).host.replace(/^www\./, "");
  } catch {
    return referrer;
  }
}

/** Two letters for a known contact, else "#". */
function initials(v: LiveVisitor): string {
  const name = v.contact?.name ?? v.contact?.email;
  if (!name) return "#";
  const parts = name.split(/[\s@.]+/).filter(Boolean);
  return ((parts[0]?.[0] ?? "") + (v.contact?.name ? (parts[1]?.[0] ?? "") : "")).toUpperCase() || "#";
}

/** A steady colour per session, from the Dashboard's slice colours (any id: a hash, never negative). */
function tint(id: string): string {
  let hash = 0;
  for (let i = 0; i < id.length; i++) hash = (hash * 31 + id.charCodeAt(i)) >>> 0;
  return sliceColor(hash % DONUT_SLICES) ?? "var(--stream-2)";
}

/** Counts by key, most first. */
function tally(visitors: LiveVisitor[], key: (v: LiveVisitor) => string | null): [string, number][] {
  const counts = new Map<string, number>();
  for (const v of visitors) {
    const k = key(v);
    if (k) counts.set(k, (counts.get(k) ?? 0) + 1);
  }
  return [...counts].sort((a, b) => b[1] - a[1]);
}

/** The Dashboard's dithered share rows, up to five, each bar against the biggest. */
function ShareRows({ rows, label }: { rows: [string, number][]; label: (key: string) => ReactNode }) {
  const max = rows[0]?.[1] ?? 1;
  return (
    <ul className="dash-rows bars">
      {rows.slice(0, 5).map(([key, n], i) => (
        <li key={key} style={{ "--share": n / max, "--swatch": sliceColor(i) ?? "var(--muted-foreground)" } as CSSProperties}>
          <span className="dash-row-label">{label(key)}</span>
          <span className="dash-row-value">{n}</span>
        </li>
      ))}
    </ul>
  );
}

function InviteForm({ workspaceId, visitor, onDone }: { workspaceId: string; visitor: LiveVisitor; onDone: (sent: boolean) => void }) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const name = visitor.contact?.name?.split(" ")[0];
  const submit = async (e: FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    const body = String(new FormData(e.currentTarget).get("body") ?? "").trim();
    if (!body) return;
    setBusy(true);
    setError(null);
    try {
      await api(`/workspaces/${workspaceId}/visitors/${visitor.sessionId}/invite`, { body: { body } });
      onDone(true);
    } catch (err) {
      setError(describeError(err));
      setBusy(false);
    }
  };
  return (
    <form className="visitor-invite" onSubmit={submit}>
      <Input name="body" autoFocus maxLength={1000} defaultValue={`Hi${name ? ` ${name}` : ""}! Can I help you with anything${visitor.page.title ? ` on ${visitor.page.title}` : ""}?`} />
      <Button disabled={busy}>Send</Button>
      <Button variant="outline" type="button" onClick={() => onDone(false)}>Cancel</Button>
      {error && <span className="error small">{error}</span>}
    </form>
  );
}

export function VisitorsPage({ workspaceId, visitors }: { workspaceId: string; visitors: LiveVisitor[] }) {
  const [now, setNow] = useState(Date.now());
  const [inviting, setInviting] = useState<string | null>(null);
  const [invited, setInvited] = useState<Set<string>>(new Set());
  const [hovered, setHovered] = useState<string | null>(null);
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, []);

  const sorted = [...visitors].sort((a, b) => Number(Boolean(b.contact?.verified)) - Number(Boolean(a.contact?.verified)) || a.startedAt - b.startedAt);
  const spots = useMemo(() => globeSpots(visitors, (v) => (v.contact ? visitorName(v) : v.city ?? (v.country ? countryName(v.country) : sessionLabel(v.sessionId)))), [visitors]);
  const countries = useMemo(() => tally(visitors, (v) => v.country), [visitors]);
  const pages = useMemo(() => tally(visitors, (v) => pathOf(v.page.url)), [visitors]);
  const sources = useMemo(() => tally(visitors, (v) => sourceOf(v.referrer) ?? "Direct"), [visitors]);
  const known = visitors.filter((v) => v.contact).length;
  const chatting = visitors.filter((v) => v.inChat).length;
  const times = visitors.map((v) => now - v.startedAt).sort((a, b) => a - b);
  const medianVisit = times.length ? times[Math.floor((times.length - 1) / 2)]! : null;

  return (
    <div className="content wide visitors-page">
      <div className="row reports-head">
        <h2>Visitors</h2>
        <span className={`live-pill${visitors.length ? "" : " idle"}`}><span className="live-dot" aria-hidden />Live</span>
      </div>

      <section className="dash-card dash-hero visitor-hero">
        <Suspense fallback={<div className="visitor-globe" />}>
          <VisitorGlobe spots={spots} countries={countries.map(([code]) => code)} focus={hovered} />
        </Suspense>
        <div className="visitor-hero-stats">
          <div className="kpi-label">On your site now</div>
          <div className="visitor-live-count">{visitors.length}</div>
          <dl className="visitor-mini">
            <div><dt className="kpi-label">Countries</dt><dd>{countries.length}</dd></div>
            <div><dt className="kpi-label">Signed in</dt><dd>{known}</dd></div>
            <div><dt className="kpi-label">In a chat</dt><dd>{chatting}</dd></div>
            <div><dt className="kpi-label">Median visit</dt><dd>{medianVisit === null ? "–" : duration(medianVisit).split(" ")[0]}</dd></div>
          </dl>
          {countries.length > 0 ? (
            <>
              <h3 className="ratings-sub">Top countries</h3>
              <ShareRows rows={countries} label={(code) => <><span className="visitor-cc">{code}</span>{countryName(code)}</>} />
            </>
          ) : (
            <p className="muted small visitor-hero-note">When someone opens a page with the widget, they light up on the globe.</p>
          )}
        </div>
      </section>

      {visitors.length > 0 && (
        <div className="dash-grid">
          <section className="dash-card">
            <div className="dash-card-head"><h2>Pages they're on</h2></div>
            <ShareRows rows={pages} label={(path) => <span className="page-path">{path}</span>} />
          </section>
          <section className="dash-card">
            <div className="dash-card-head"><h2>Where they came from</h2></div>
            <ShareRows rows={sources} label={(host) => (host === "Direct" ? "Direct" : <span className="page-path">{host}</span>)} />
          </section>
        </div>
      )}

      <section className="dash-card">
        <div className="dash-card-head">
          <h2>Everyone on your site</h2>
          <span className="dash-caption"><span className="strong">{visitors.length}</span> live</span>
        </div>
        <p className="muted small">Signed-in customers show who they are when your site sends an identity token (Settings → Install).</p>
        {sorted.length === 0 ? (
          <div className="visitors-empty">
            <span className="visitors-empty-art" aria-hidden><span /></span>
            <p>Nobody right now. Open your site, or the demo page from Settings, in another tab to see yourself here.</p>
          </div>
        ) : (
          <ul className="visitor-list">
            {sorted.map((v) => (
              <li
                key={v.sessionId}
                className={hovered === v.sessionId ? "focus" : undefined}
                style={{ "--tint": tint(v.sessionId) } as CSSProperties}
                onMouseEnter={() => setHovered(v.sessionId)}
                onMouseLeave={() => setHovered((h) => (h === v.sessionId ? null : h))}
              >
                <span className="visitor-avatar" aria-hidden>
                  {initials(v)}
                  {v.country && <span className="visitor-cc">{v.country}</span>}
                </span>
                <div className="visitor-who">
                  <div className="visitor-name">
                    {visitorName(v)}
                    {v.contact?.verified && <span className="verified" title="Identity verified by your site">✓</span>}
                    {v.inChat && <span className="dash-row-tag">In a chat</span>}
                  </div>
                  <div className="muted small">
                    {v.contact?.name && v.contact.email ? `${v.contact.email} · ` : ""}
                    {[v.city, v.country && countryName(v.country)].filter(Boolean).join(", ") || "Unknown location"} · {describeBrowser(v.userAgent)}
                  </div>
                </div>
                <div className="visitor-page">
                  <div className="visitor-page-title">{v.page.title || "Untitled page"}</div>
                  <code>{pathOf(v.page.url)}</code>
                  <div className="muted small">{v.referrer ? <>from <code>{sourceOf(v.referrer)}</code></> : "Direct visit"}</div>
                </div>
                <div className="visitor-time">
                  <span className="visitor-time-n">{duration(now - v.startedAt)}</span>
                  <span className="muted small">{v.pages} page{v.pages === 1 ? "" : "s"}</span>
                </div>
                <div className="visitor-action">
                  {v.inChat ? null : invited.has(v.sessionId) ? (
                    <span className="muted small">Invite sent</span>
                  ) : inviting === v.sessionId ? null : (
                    <Button variant="outline" size="sm" onClick={() => setInviting(v.sessionId)}>Start chat</Button>
                  )}
                </div>
                {inviting === v.sessionId && (
                  <InviteForm
                    workspaceId={workspaceId}
                    visitor={v}
                    onDone={(sent) => {
                      if (sent) setInvited((s) => new Set(s).add(v.sessionId));
                      setInviting(null);
                    }}
                  />
                )}
              </li>
            ))}
          </ul>
        )}
      </section>
    </div>
  );
}
