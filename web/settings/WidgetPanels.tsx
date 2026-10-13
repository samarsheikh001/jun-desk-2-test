import { useEffect, useState, type FormEvent } from "react";
import { DEFAULT_AWAY_MESSAGE, describeOpening, isOpen, nextOpening, WEEKDAYS, type BusinessHours, type DayHours, type Weekday } from "../../shared/hours.ts";
import { api } from "../api.ts";
import { useAction } from "../useAction.ts";
import { Button } from "@/components/ui/button.tsx";
import { Input } from "@/components/ui/input.tsx";
import { Textarea } from "@/components/ui/textarea.tsx";
import { NativeSelect, NativeSelectOption } from "@/components/ui/native-select.tsx";
import { Switch } from "@/components/ui/switch.tsx";
import { SettingRow, SettingsCard } from "./layout.tsx";

// I-10 business hours (Settings → Inbox). The widget's look (W-04) is on the Widget page's Look tab.

export interface InboxSettings {
  color?: string;
  position?: "left" | "right";
  greeting?: string;
  replyTime?: string;
  displayName?: string;
  logoKey?: string;
  hours?: BusinessHours;
  /** W-12: ask for a rating when a conversation is resolved (default on). */
  csat?: boolean;
}

const ALL_DAYS: Weekday[] = [1, 2, 3, 4, 5, 6, 0];

function zones(): string[] {
  const intl = Intl as unknown as { supportedValuesOf?: (key: string) => string[] };
  // Browsers' lists leave out plain "UTC"; teams spread across zones often want it.
  const list = intl.supportedValuesOf?.("timeZone") ?? [];
  return ["UTC", ...list.filter((z) => z !== "UTC")];
}

export function HoursPanel({ workspaceId, settings, canEdit, onSaved }: { workspaceId: string; settings: InboxSettings; canEdit: boolean; onSaved: (s: InboxSettings) => void }) {
  const initial = settings.hours;
  const [enabled, setEnabled] = useState(initial?.enabled ?? false);
  const [timezone, setTimezone] = useState(initial?.timezone ?? Intl.DateTimeFormat().resolvedOptions().timeZone);
  const [days, setDays] = useState<Record<number, DayHours | null>>(() =>
    Object.fromEntries(ALL_DAYS.map((d) => [d, initial ? initial.days.find((x) => x.day === d) ?? null : d >= 1 && d <= 5 ? { day: d, start: "09:00", end: "17:00" } : null])),
  );
  const [away, setAway] = useState(initial?.awayMessage ?? DEFAULT_AWAY_MESSAGE);
  const [saved, setSaved] = useState(false);
  const [now, setNow] = useState(Date.now());
  const { busy, error, run } = useAction();
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), 30_000);
    return () => clearInterval(t);
  }, []);

  const hours: BusinessHours = { enabled, timezone, days: ALL_DAYS.map((d) => days[d]).filter((d): d is DayHours => Boolean(d)), awayMessage: away };
  let status = "Always open (hours are off)";
  try {
    if (enabled) {
      const next = nextOpening(hours, now);
      status = isOpen(hours, now) ? "Open now" : next ? `Closed now · opens ${describeOpening(next, timezone, now)}` : "Closed (no open days)";
    }
  } catch {
    status = "";
  }

  const save = (e: FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    run(async () => {
      const r = await api<{ settings: InboxSettings }>(`/workspaces/${workspaceId}/inbox`, { method: "PATCH", body: { hours } });
      onSaved(r.settings);
      setSaved(true);
      setTimeout(() => setSaved(false), 2000);
    });
  };

  return (
    <SettingsCard
      title="Business hours"
      description="Outside these hours the AI still answers. When a chat is with your team, the visitor gets your away message once, and the widget says when you're back."
      action={<span className="tag">{status}</span>}
    >
      <form onSubmit={save} className="ai-form">
        <SettingRow label="Use business hours" description="When off, the desk counts as always open.">
          <Switch checked={enabled} onCheckedChange={(value) => setEnabled(value)} disabled={!canEdit} aria-label="Use business hours" />
        </SettingRow>
        <SettingRow label="Time zone" description="The hours below are in this time zone." htmlFor="hours-timezone">
          <NativeSelect id="hours-timezone" value={timezone} onChange={(e) => setTimezone(e.target.value)} disabled={!canEdit}>
            {zones().map((z) => <NativeSelectOption key={z} value={z}>{z.replace(/_/g, " ")}</NativeSelectOption>)}
          </NativeSelect>
        </SettingRow>
        <div className="hours-grid">
          {ALL_DAYS.map((d) => {
            const v = days[d];
            return (
              <div key={d} className="row hours-row">
                <label className="check" style={{ width: 130 }}>
                  <input type="checkbox" checked={Boolean(v)} disabled={!canEdit} onChange={(e) => setDays({ ...days, [d]: e.target.checked ? { day: d, start: "09:00", end: "17:00" } : null })} /> {WEEKDAYS[d]}
                </label>
                {v ? (
                  <>
                    <Input type="time" value={v.start} disabled={!canEdit} onChange={(e) => setDays({ ...days, [d]: { ...v, start: e.target.value } })} aria-label={`${WEEKDAYS[d]} opens`} />
                    <span className="muted">to</span>
                    <Input type="time" value={v.end === "24:00" ? "23:59" : v.end} disabled={!canEdit} onChange={(e) => setDays({ ...days, [d]: { ...v, end: e.target.value === "23:59" ? "24:00" : e.target.value } })} aria-label={`${WEEKDAYS[d]} closes`} />
                  </>
                ) : (
                  <span className="muted small">Closed</span>
                )}
              </div>
            );
          })}
        </div>
        <label className="field">
          <span>Away message <span className="muted">({"{when}"} becomes e.g. "on Monday at 09:00 (London time)")</span></span>
          <Textarea rows={2} value={away} onChange={(e) => setAway(e.target.value)} maxLength={500} disabled={!canEdit} />
        </label>
        {error && <p className="error small">{error}</p>}
        {canEdit && <div className="row"><Button disabled={busy}>Save</Button>{saved && <span className="muted small">Saved ✓</span>}</div>}
      </form>
    </SettingsCard>
  );
}
