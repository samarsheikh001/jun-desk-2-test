import { useEffect, useState } from "react";
import { api } from "../api.ts";
import { actionStatusLine, type SeenPageAction } from "../../shared/actions.ts";
import { Input } from "@/components/ui/input.tsx";
import { cardFromShape } from "../../shared/widgets.ts";
import { widgetPageButtons } from "../../shared/agent-links.ts";
import { Button } from "@/components/ui/button.tsx";
import { NativeSelect, NativeSelectOption } from "@/components/ui/native-select.tsx";
import { PlusIcon, XIcon } from "../components/icons.tsx";
import { go, humanize, slug, WIDGET } from "./parts.tsx";
import { editYaml, readYaml } from "../lib/agentFiles.ts";
import type { AgentConfig } from "./useAgentConfig.ts";

// W-31: website actions are WebMCP tools the customer's own site registers; the AI runs them in the
// customer's browser. The desk never has their code, only what the loader reported when a customer
// chatted (`…/agent/page-actions`: names, descriptions, the card the page names, and the shape of the
// last result, never its values). Here the admin picks the card a result is shown as (the widget
// file's `pageActions`), or makes one from that shape.

let cache: { base: string; actions: SeenPageAction[] } | null = null;

/** The website actions the desk has seen, most recent first (null while loading). */
export function useSeenPageActions(cfg: AgentConfig): SeenPageAction[] | null {
  const [actions, setActions] = useState<SeenPageAction[] | null>(cache?.base === cfg.base ? cache.actions : null);
  useEffect(() => {
    let live = true;
    api<{ actions: SeenPageAction[] }>(`${cfg.base}/page-actions`)
      .then(({ actions }) => {
        cache = { base: cfg.base, actions };
        if (live) setActions(actions);
      })
      .catch(() => live && setActions([]));
    return () => {
      live = false;
    };
  }, [cfg.base]);
  return actions;
}

type Data = Record<string, unknown>;
const readJson = (text: string): Data | null => {
  try {
    const file = JSON.parse(text) as unknown;
    return typeof file === "object" && file !== null && !Array.isArray(file) ? (file as Data) : null;
  } catch {
    return null;
  }
};
const listOf = (file: Data | null): string[] => (Array.isArray(file?.pageActions) ? file.pageActions.filter((n): n is string => typeof n === "string") : []);

/** Widget names in the draft. */
const widgetNames = (draft: Record<string, string>) =>
  Object.keys(draft)
    .map((p) => WIDGET.exec(p)?.[1])
    .filter((n): n is string => Boolean(n))
    .sort();

/** The website actions a widget shows (its file's `pageActions`). */
export function widgetPageActions(draft: Record<string, string>, widget: string): string[] {
  return listOf(readJson(draft[`widgets/${widget}.widget`] ?? ""));
}

/** The card a website action's result is shown as: the desk's choice, else the one its page names. */
export function cardOf(draft: Record<string, string>, action: SeenPageAction | string): { widget: string; by: "desk" | "page" } | null {
  const name = typeof action === "string" ? action : action.name;
  const desk = widgetNames(draft).find((w) => widgetPageActions(draft, w).includes(name));
  if (desk) return { widget: desk, by: "desk" };
  const declared = typeof action === "string" ? undefined : action.widget;
  return declared && `widgets/${declared}.widget` in draft ? { widget: declared, by: "page" } : null;
}

/** W-32: the widgets with a button that runs `action` (`page:<name>`). */
export function pageButtonWidgets(draft: Record<string, string>, action: string): string[] {
  return widgetNames(draft).filter((w) => widgetPageButtons(draft[`widgets/${w}.widget`] ?? "").includes(action));
}

/** The file with `pageActions` set to `names` (removed when empty); other keys keep their order. */
function withPageActions(text: string, names: string[]): string {
  const file = readJson(text) ?? {};
  if (names.length) file.pageActions = names;
  else delete file.pageActions;
  return `${JSON.stringify(file, null, 2)}\n`;
}

/** Shows `action`'s result as `widget` (null: as text): one widget per action, edited in the draft. */
export function setCard(cfg: AgentConfig, action: string, widget: string | null): void {
  for (const w of widgetNames(cfg.draft)) {
    const path = `widgets/${w}.widget`;
    const names = widgetPageActions(cfg.draft, w);
    const next = w === widget ? (names.includes(action) ? names : [...names, action]) : names.filter((n) => n !== action);
    if (next.length !== names.length && readJson(cfg.draft[path]!)) cfg.setFile(path, withPageActions(cfg.draft[path]!, next));
  }
}

/** Makes a first card for the action from its result's shape, linked to it, and opens it. */
function makeCard(cfg: AgentConfig, action: SeenPageAction): void {
  const base = slug(action.name, "_") || "website_card";
  let name = base;
  for (let n = 2; `widgets/${name}.widget` in cfg.draft; n++) name = `${base}_${n}`;
  setCard(cfg, action.name, null);
  cfg.setFile(`widgets/${name}.widget`, cardFromShape(humanize(action.name), action.name, action.shape!));
  go(`/agent/widgets/${name}`);
}

const TEXT = "";

// D-74: how each website action runs, set on the desk (website-actions.yaml: name → auto, confirm or
// human), over what the site asked for (its WebMCP annotations or `risk`).
const RISK_FILE = "website-actions.yaml";
const RISK_HEADER = "# How each action on your website runs, over what your site asked for (D-74).\n# auto: without asking · confirm: the customer confirms first · human: a person does it\n";
type Risk = "auto" | "confirm" | "human";
const RISK_LABEL: Record<Risk, string> = { auto: "Runs without asking", confirm: "Asks the customer first", human: "A person does it" };

/** The desk's setting for each website action (from website-actions.yaml). */
export function riskOverrides(draft: Record<string, string>): Record<string, Risk> {
  return Object.fromEntries(Object.entries(siteSettings(draft)).flatMap(([name, s]) => (s.run ? [[name, s.run]] : [])));
}

const isRisk = (v: unknown): v is Risk => v === "auto" || v === "confirm" || v === "human";

/** D-74 / D-77: the desk's settings per website action: how it runs and the line shown while it does. */
function siteSettings(draft: Record<string, string>): Record<string, { run?: Risk; status?: string }> {
  const data = draft[RISK_FILE] === undefined ? null : readYaml(draft[RISK_FILE]!);
  if (typeof data !== "object" || data === null || Array.isArray(data)) return {};
  const out: Record<string, { run?: Risk; status?: string }> = {};
  for (const [name, v] of Object.entries(data as Record<string, unknown>)) {
    if (isRisk(v)) out[name] = { run: v };
    else if (v && typeof v === "object" && !Array.isArray(v)) {
      const e = v as Record<string, unknown>;
      out[name] = { ...(isRisk(e.run) ? { run: e.run } : {}), ...(typeof e.status === "string" && e.status ? { status: e.status } : {}) };
    }
  }
  return out;
}

/** One action's settings written back: the short form (`name: auto`) unless it has a line too; nothing left, no entry (and no file). */
function setSetting(cfg: AgentConfig, name: string, next: { run?: Risk | null; status?: string | null }): void {
  const current = siteSettings(cfg.draft)[name] ?? {};
  const run = next.run === undefined ? current.run : next.run ?? undefined;
  // Kept as typed (a trailing space is the next word's start); the desk trims it when it reads the file.
  const status = next.status === undefined ? current.status : next.status || undefined;
  const value = status?.trim() ?{ ...(run ? { run } : {}), status } : run ?? "";
  const text = cfg.draft[RISK_FILE] ?? RISK_HEADER;
  const written = editYaml(text.trim() ? text : RISK_HEADER, { op: "set", path: [name], value });
  const left = readYaml(written);
  cfg.setFile(RISK_FILE, left && typeof left === "object" && Object.keys(left).length ? written : undefined);
}

/** Sets (or with null, clears) the desk's setting for one website action. */
function setRisk(cfg: AgentConfig, name: string, risk: Risk | null): void {
  setSetting(cfg, name, { run: risk });
}

/** /agent/actions: the actions on the customer's website, each with the card its result shows as. */
export function WebsiteActions({ cfg, canEdit }: { cfg: AgentConfig; canEdit: boolean }) {
  const seen = useSeenPageActions(cfg);
  const widgets = widgetNames(cfg.draft);
  const risks = riskOverrides(cfg.draft);
  const settings = siteSettings(cfg.draft);
  return (
    <section className="agent-site-actions" aria-labelledby="site-actions-h">
      <div className="agent-site-actions-head">
        <h2 id="site-actions-h">On your website</h2>
        <p>
          Actions your site's code registers (WebMCP or <code>JunDesk.registerAction</code>). The AI runs them in the customer's browser. Choose whether each one
          asks the customer first, and pick a widget to show what one returns.
        </p>
      </div>
      {seen === null ? null : seen.length === 0 ? (
        <p className="muted small">None seen yet. They show up here once a customer chats on a page that registers them.</p>
      ) : (
        <ul className="agent-index-grid">
          {seen.map((a) => {
            const card = cardOf(cfg.draft, a);
            const buttons = pageButtonWidgets(cfg.draft, a.name);
            return (
              <li key={a.name} className="agent-index-card">
                <span className="agent-index-title">{humanize(a.name)}</span>
                <p className="agent-index-sub">{a.description}</p>
                <label className="agent-site-card">
                  <span>When the AI runs it</span>
                  <NativeSelect
                    aria-label={`When the AI runs ${humanize(a.name)}`}
                    size="sm"
                    value={risks[a.name] ?? ""}
                    disabled={!canEdit}
                    onChange={(e) => setRisk(cfg, a.name, (e.target.value || null) as Risk | null)}
                  >
                    <NativeSelectOption value="">{a.risk ? `${RISK_LABEL[a.risk]} (your site's setting)` : "Your site's setting"}</NativeSelectOption>
                    {(["auto", "confirm", "human"] as const).map((r) => (
                      <NativeSelectOption key={r} value={r}>{RISK_LABEL[r]}</NativeSelectOption>
                    ))}
                  </NativeSelect>
                </label>
                <label className="agent-site-card">
                  <span>While it runs, the customer sees</span>
                  <Input
                    aria-label={`While ${humanize(a.name)} runs, the customer sees`}
                    className="h-8"
                    value={settings[a.name]?.status ?? ""}
                    readOnly={!canEdit}
                    maxLength={60}
                    placeholder={actionStatusLine({ name: a.name, ...(a.statusLine ? { statusLine: a.statusLine } : {}) })}
                    onChange={(e) => setSetting(cfg, a.name, { status: e.target.value || null })}
                  />
                </label>
                <label className="agent-site-card">
                  <span>Show what it returns as</span>
                  <NativeSelect
                    aria-label={`Widget for ${humanize(a.name)}`}
                    size="sm"
                    value={card?.widget ?? TEXT}
                    disabled={!canEdit}
                    onChange={(e) => setCard(cfg, a.name, e.target.value || null)}
                  >
                    <NativeSelectOption value={TEXT}>Text (no widget)</NativeSelectOption>
                    {widgets.map((w) => (
                      <NativeSelectOption key={w} value={w}>
                        {humanize(w)}
                      </NativeSelectOption>
                    ))}
                  </NativeSelect>
                </label>
                {card && <p className="agent-index-sub">Every time it runs, its result shows as this widget. To show a widget at a step of a task, use the task's steps instead.</p>}
                {card?.by === "page" && <p className="agent-index-sub">Set in your site's code. Picking another widget here wins.</p>}
                {buttons.length > 0 && (
                  <div className="agent-site-card">
                    <span>Run by buttons in</span>
                    <span className="agent-links-chips">
                      {buttons.map((w) => (
                        <a key={w} className="agent-link-chip" data-kind="widget" href={`/agent/widgets/${w}`} onClick={(e) => { e.preventDefault(); go(`/agent/widgets/${w}`); }}>
                          {humanize(w)}
                        </a>
                      ))}
                    </span>
                  </div>
                )}
                {canEdit && !card && (
                  a.shape ? (
                    <Button variant="outline" size="sm" className="agent-site-make" onClick={() => makeCard(cfg, a)}>
                      <PlusIcon /> Make a widget
                    </Button>
                  ) : (
                    <p className="agent-index-sub">Run it once on your site and you can make a widget from what it returns.</p>
                  )
                )}
              </li>
            );
          })}
        </ul>
      )}
    </section>
  );
}

/** A widget's Details: the website actions whose result it shows. */
export function WidgetPageActions({ cfg, name, canEdit }: { cfg: AgentConfig; name: string; canEdit: boolean }) {
  const seen = useSeenPageActions(cfg);
  const mine = widgetPageActions(cfg.draft, name);
  const fromCode = (seen ?? []).filter((a) => a.widget === name && !mine.includes(a.name) && !cardOf(cfg.draft, a.name)).map((a) => a.name);
  const others = (seen ?? []).filter((a) => !mine.includes(a.name));
  return (
    <div className="agent-wed-group">
      <h3>Website actions</h3>
      <p>Actions on your website whose result shows as this widget.</p>
      {(mine.length > 0 || fromCode.length > 0) && (
        <ul className="agent-site-chips">
          {mine.map((a) => (
            <li key={a} className="agent-link-chip" data-kind="action">
              {humanize(a)}
              {canEdit && (
                <button type="button" data-plain aria-label={`Stop showing ${humanize(a)} as this card`} onClick={() => setCard(cfg, a, null)}>
                  <XIcon />
                </button>
              )}
            </li>
          ))}
          {fromCode.map((a) => (
            <li key={a} className="agent-link-chip" data-kind="action" title="Set in your site's code">
              {humanize(a)} · in your code
            </li>
          ))}
        </ul>
      )}
      {canEdit && (
        <NativeSelect aria-label="Add a website action" size="sm" value="" onChange={(e) => e.target.value && setCard(cfg, e.target.value, name)}>
          <NativeSelectOption value="">{others.length ? "Add a website action…" : seen === null ? "Loading…" : "No other website actions seen yet"}</NativeSelectOption>
          {others.map((a) => (
            <NativeSelectOption key={a.name} value={a.name}>
              {humanize(a.name)}
              {cardOf(cfg.draft, a)?.by === "desk" ? ` (now ${humanize(cardOf(cfg.draft, a)!.widget)})` : ""}
            </NativeSelectOption>
          ))}
        </NativeSelect>
      )}
    </div>
  );
}
