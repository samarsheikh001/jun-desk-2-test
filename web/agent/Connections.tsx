import { useMemo, type ReactNode } from "react";
import { agentLinks, widgetPageButtons } from "../../shared/agent-links.ts";
import { parseWidgetFile, previewWidget, toolButtonInputs, widgetData, widgetSchema, type ToolButtonInputs } from "../../shared/widgets.ts";
import { checkData } from "../../shared/widget-schema.ts";
import { readYaml } from "../lib/agentFiles.ts";
import { Button } from "@/components/ui/button.tsx";
import { PlusIcon } from "../components/icons.tsx";
import { go, humanize } from "./parts.tsx";
import type { AgentConfig } from "./useAgentConfig.ts";
import { useSeenPageActions, widgetPageActions } from "./WebsiteActions.tsx";

// W-25: what an action, a procedure or a widget is connected to (shared/agent-links.ts), from the
// draft, as links: an action's widget, the widget buttons that run it and the procedures that mention
// it; a procedure's actions, and names its steps use as an action that aren't one (a warning, never a
// problem: steps are free text); a widget's actions both ways. W-27: a widget's buttons with the
// action inputs each one fills from the card's fields (a required one with no field is a warning, on
// the widget and on the action), never a problem: saving still works.

type Kind = "action" | "procedure" | "widget";

const ROUTE: Record<Kind, string> = { action: "/agent/actions", procedure: "/agent/tasks", widget: "/agent/widgets" };

function Chip({ kind, name }: { kind: Kind; name: string }) {
  const href = `${ROUTE[kind]}/${name}`;
  return (
    <a className="agent-link-chip" data-kind={kind} href={href} onClick={(e) => { e.preventDefault(); go(href); }}>
      {humanize(name)}
    </a>
  );
}

function Row({ label, kind, names }: { label: string; kind: Kind; names: string[] }) {
  if (!names.length) return null;
  return (
    <div className="agent-links-row">
      <span className="agent-links-label">{label}</span>
      <span className="agent-links-chips">
        {names.map((n) => <Chip key={n} kind={kind} name={n} />)}
      </span>
    </div>
  );
}

const NEW_ACTION = "description: \nstatus: Looking that up\nmethod: GET\nurl: https://\n";

const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);

/** An action's inputs in the draft (required unless it says not), or null when there's no such action. */
export function inputsOf(draft: Record<string, string>, tool: string): Record<string, { required: boolean }> | null {
  const text = draft[`tools/${tool}.yaml`] ?? draft[`tools/${tool}.yml`];
  if (text === undefined) return null;
  let data: unknown;
  try {
    data = readYaml(text);
  } catch {
    return null;
  }
  const input = isRecord(data) && isRecord(data.input) ? data.input : {};
  return Object.fromEntries(Object.entries(input).map(([k, v]) => [k, { required: !(isRecord(v) && v.required === false) }]));
}

/**
 * W-30: what in an action's example response (`mock`) doesn't fit its widget's parameters; [] when
 * it fits, or there's no widget, mock or schema to compare.
 */
function mockMisfit(draft: Record<string, string>, action: string): { widget: string; problems: string[] } | null {
  const text = draft[`tools/${action}.yaml`] ?? draft[`tools/${action}.yml`];
  if (text === undefined) return null;
  let data: unknown;
  try {
    data = readYaml(text);
  } catch {
    return null;
  }
  if (!isRecord(data) || typeof data.widget !== "string" || data.mock === undefined) return null;
  const file = draft[`widgets/${data.widget}.widget`];
  if (file === undefined) return null;
  try {
    const schema = widgetSchema(parseWidgetFile(data.widget, file));
    const mock = typeof data.mock === "string" ? (JSON.parse(data.mock) as unknown) : data.mock;
    const problems = schema ? checkData(schema, widgetData(mock)) : [];
    return problems.length ? { widget: data.widget, problems } : null;
  } catch {
    return null;
  }
}

/** W-27: a widget's buttons that run actions, drawn with its sample data, and the inputs each fills. */
export function widgetButtons(draft: Record<string, string>, widget: string): ToolButtonInputs[] {
  try {
    return toolButtonInputs(previewWidget(widget, draft[`widgets/${widget}.widget`] ?? ""), (t) => inputsOf(draft, t));
  } catch {
    return [];
  }
}

function Missing({ m }: { m: { name: string; like?: string } }) {
  return m.like ? (
    <>
      <code>{m.name}</code> (the field <code>{m.like}</code> would need to be called <code>{m.name}</code>)
    </>
  ) : (
    <code>{m.name}</code>
  );
}

function ButtonRow({ b }: { b: ToolButtonInputs }) {
  return (
    <div className="agent-links-button">
      <span className="agent-links-label">{b.field ? `Changing ${b.label} runs` : `"${b.label}" runs`}</span>
      <span className="agent-links-chips">
        <Chip kind="action" name={b.tool} />
        <span className="agent-links-sends">{b.sends.length ? `fills ${b.sends.join(", ")}` : "fills none of its details"}</span>
      </span>
      {b.missing.length > 0 && (
        <div className="agent-links-warn" role="note">
          <span>
            No field for{" "}
            {b.missing.map((m, i) => (
              <span key={m.name}>
                {i > 0 && ", "}
                <Missing m={m} />
              </span>
            ))}
            . The action needs {b.missing.length === 1 ? "it" : "them"}, so this {b.field ? "field" : "button"} would run it without {b.missing.length === 1 ? "it" : "them"}.
          </span>
        </div>
      )}
    </div>
  );
}

export function Connections({ cfg, kind, name, canEdit }: { cfg: AgentConfig; kind: Kind; name: string; canEdit: boolean }) {
  const links = useMemo(() => agentLinks(cfg.draft), [cfg.draft]);
  const seen = useSeenPageActions(cfg);
  // W-27: a widget's buttons; for an action, the buttons elsewhere that run it without an input it needs.
  const buttons = useMemo(() => (kind === "widget" ? widgetButtons(cfg.draft, name) : []), [cfg.draft, kind, name]);
  const short = useMemo(
    () =>
      kind === "action"
        ? (links.actionRunFrom[name] ?? []).flatMap((w) => widgetButtons(cfg.draft, w).filter((b) => b.tool === name && b.missing.length).map((b) => ({ widget: w, button: b })))
        : [],
    [cfg.draft, kind, name, links],
  );
  const misfit = useMemo(() => (kind === "action" ? mockMisfit(cfg.draft, name) : null), [cfg.draft, kind, name]);
  let rows: ReactNode[] = [];
  let empty = "";
  let missing: string[] = [];
  let pageButtons: string[] = [];
  let unseen: string[] = [];
  if (kind === "action") {
    const widget = links.actionWidget[name];
    rows = [
      <Row key="w" label="Shows its result as" kind="widget" names={widget && links.widgets.includes(widget) ? [widget] : []} />,
      <Row key="r" label="Run by buttons in" kind="widget" names={links.actionRunFrom[name] ?? []} />,
      <Row key="p" label="Used in tasks" kind="procedure" names={links.actionUsedBy[name] ?? []} />,
    ];
    empty = "Nothing points at this action yet. The AI can still use it on its own; to guide it, name it in a task's steps, or give a widget a button that runs it.";
    if (!widget && !links.actionRunFrom[name]?.length && !links.actionUsedBy[name]?.length) rows = [];
  } else if (kind === "procedure") {
    rows = [<Row key="a" label="Uses actions" kind="action" names={links.procedureUses[name] ?? []} />];
    missing = links.procedureMissing[name] ?? [];
    if (!links.procedureUses[name]?.length) rows = [];
    empty = "Its steps don't name an action. Write an action's name in a step (\"check the order with lookup_order\") so the AI knows which one to use.";
  } else {
    const aiFill = /"aiFill"\s*:\s*true/.test(cfg.draft[`widgets/${name}.widget`] ?? "");
    const shownBy = links.widgetShownBy[name] ?? [];
    // W-31: website actions it shows (chosen here, or named in the site's code).
    pageButtons = widgetPageButtons(cfg.draft[`widgets/${name}.widget`] ?? "");
    // A name the desk hasn't seen on the site may be a typo (or no customer has chatted there yet).
    if (seen) unseen = pageButtons.filter((n) => !seen.some((a) => a.name === n));
    const site = [...new Set([...widgetPageActions(cfg.draft, name), ...(seen ?? []).filter((a) => a.widget === name).map((a) => a.name)])];
    rows = [
      // W-29: the AI filling it in itself sits with the actions that show it.
      aiFill ? (
        <div key="s" className="agent-links-row">
          <span className="agent-links-label">Shown by</span>
          <span className="agent-links-chips">
            <span className="agent-link-chip" data-kind="ai">The AI, filled in itself</span>
            {shownBy.map((n) => <Chip key={n} kind="action" name={n} />)}
          </span>
        </div>
      ) : (
        <Row key="s" label="Shown by" kind="action" names={shownBy} />
      ),
      site.length > 0 && (
        <div key="site" className="agent-links-row">
          <span className="agent-links-label">Shown by website actions</span>
          <span className="agent-links-chips">
            {site.map((n) => <span key={n} className="agent-link-chip" data-kind="action">{humanize(n)}</span>)}
          </span>
        </div>
      ),
      ...(buttons.length ? buttons.map((b, i) => <ButtonRow key={`b${i}`} b={b} />) : [<Row key="r" label="Its buttons run" kind="action" names={links.widgetRuns[name]?.filter((a) => links.actions.includes(a)) ?? []} />]),
      // W-32: `page:<name>` buttons run actions on the customer's website.
      pageButtons.length > 0 && (
        <div key="pb" className="agent-links-row">
          <span className="agent-links-label">Its buttons run on your website</span>
          <span className="agent-links-chips">
            {pageButtons.map((n) => <span key={n} className="agent-link-chip" data-kind="action">{humanize(n)}</span>)}
          </span>
        </div>
      ),
    ];
    if (!aiFill && !site.length && !pageButtons.length && !links.widgetShownBy[name]?.length && !links.widgetRuns[name]?.length) rows = [];
    empty = "No action shows it: pick it under \"Show the result as a widget\" on an action, add a website action (below), or let the AI fill it in itself.";
  }

  return (
    <section className="agent-links" aria-label="Connected to">
      <h3>Connected</h3>
      {rows.length ? (
        rows
      ) : kind === "widget" ? (
        // AI-24: a widget nothing can show never reaches a customer; asking for it, the AI guessed.
        <div className="agent-links-warn" role="note">
          <span>The AI can't show this widget yet. {empty}</span>
        </div>
      ) : (
        !missing.length && !short.length && !misfit && <p className="agent-links-empty">{empty}</p>
      )}
      {unseen.map((n) => (
        <div key={`unseen:${n}`} className="agent-links-warn" role="note">
          <span>
            A button runs <code>page:{n}</code>, but the desk hasn't seen a website action called <code>{n}</code> yet. Check the name matches the one your site registers; the button says it isn't available until it does.
          </span>
        </div>
      ))}
      {misfit && (
        <div className="agent-links-warn" role="note">
          <span>
            Its example response (<code>mock</code>) doesn't fit the parameters of <Chip kind="widget" name={misfit.widget} />: {misfit.problems.join("; ")}. The real response needs those fields for the card to show.
          </span>
        </div>
      )}
      {short.map(({ widget, button }) => (
        <div key={`${widget}:${button.label}`} className="agent-links-warn" role="note">
          <span>
            {button.field ? `Changing ${button.label}` : `"${button.label}"`} in <Chip kind="widget" name={widget} /> runs this without{" "}
            {button.missing.map((m, i) => (
              <span key={m.name}>
                {i > 0 && ", "}
                <Missing m={m} />
              </span>
            ))}
            : the widget has no field with that name.
          </span>
        </div>
      ))}
      {missing.map((m) => (
        <div key={m} className="agent-links-warn" role="note">
          <span>
            The steps use <code>{m}</code>, which isn't an action yet. The AI can't run it until it exists.
          </span>
          {canEdit && /^[a-z][a-z0-9_]*$/.test(m) && (
            <Button
              type="button"
              variant="outline"
              size="sm"
              onClick={() => {
                cfg.setFile(`tools/${m}.yaml`, NEW_ACTION);
                go(`/agent/actions/${m}`);
              }}
            >
              <PlusIcon /> Create it
            </Button>
          )}
        </div>
      ))}
    </section>
  );
}
