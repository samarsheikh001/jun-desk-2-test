// W-25: how the agent's parts point at each other, worked out from the files (the saved config or the
// admin's draft), so each page can show what it's connected to:
// - an action shows its result as a widget (`widget:` in tools/<name>.yaml; checked on save),
// - a widget's buttons run actions (`tool:<name>` actions in its template; checked on save),
// - a procedure's steps mention actions by name (free text the AI reads; not checked on save, so
//   names that look like an action but aren't one are reported here as gentle warnings).
// Pure: no rendering, no YAML parsing beyond the one `widget:` line.

const ACTION_FILE = /^tools\/([a-z][a-z0-9_]*)\.ya?ml$/;
const PROCEDURE_FILE = /^skills\/([a-z0-9]+(?:-[a-z0-9]+)*)\/SKILL\.md$/;
const WIDGET_FILE = /^widgets\/([a-z][a-z0-9_-]*)\.widget$/;

export interface AgentLinks {
  actions: string[];
  procedures: string[];
  widgets: string[];
  /** action → the widget it shows its result as. */
  actionWidget: Record<string, string>;
  /** widget → the actions that show their result as it. */
  widgetShownBy: Record<string, string[]>;
  /** widget → the actions its buttons run (`tool:<name>`). */
  widgetRuns: Record<string, string[]>;
  /** action → the widgets with a button that runs it. */
  actionRunFrom: Record<string, string[]>;
  /** procedure → the actions its steps mention. */
  procedureUses: Record<string, string[]>;
  /** action → the procedures that mention it. */
  actionUsedBy: Record<string, string[]>;
  /** procedure → names its steps use as an action ("with apply_save_offer") that aren't one. */
  procedureMissing: Record<string, string[]>;
}

const push = (map: Record<string, string[]>, key: string, value: string) => {
  const list = (map[key] ??= []);
  if (!list.includes(value)) list.push(value);
};

/** The `widget:` an action's YAML names (top-level key only; comments and quotes allowed). */
function widgetOf(yaml: string): string | null {
  const m = /^widget:[ \t]*["']?([a-z][a-z0-9_-]*)["']?[ \t]*(?:#.*)?$/m.exec(yaml);
  return m ? m[1]! : null;
}

/** The actions a widget's buttons run: `tool:<name>` in its template, wherever it sits. */
function widgetTools(file: string): string[] {
  let template = "";
  try {
    const parsed = JSON.parse(file) as { template?: unknown };
    template = typeof parsed.template === "string" ? parsed.template : "";
  } catch {
    return [];
  }
  return [...new Set([...template.matchAll(/tool:([a-z][a-z0-9_]*)/g)].map((m) => m[1]!))];
}

/** W-32: the website actions a widget's buttons run: `page:<name>` in its template. */
export function widgetPageButtons(file: string): string[] {
  let template = "";
  try {
    const parsed = JSON.parse(file) as { template?: unknown };
    template = typeof parsed.template === "string" ? parsed.template : "";
  } catch {
    return [];
  }
  return [...new Set([...template.matchAll(/\bpage:([\w.-]{1,64})/g)].map((m) => m[1]!))];
}

/** A procedure's steps: the text after its frontmatter. */
function stepsOf(text: string): string {
  const m = /^---\r?\n[\s\S]*?\r?\n---\r?\n?/.exec(text);
  return m ? text.slice(m[0].length) : text;
}

// A name used as an action: an @mention (W-26: "@lookup_order", the editor's way; not an email's
// "help@acme.com"), or, written like an action name (lowercase with an underscore), after "with / use /
// using / call / run / via / the … action|tool" or in backticks. Offer codes in prose
// ("offer: discount_50_3m") aren't flagged.
const AS_ACTION = /(?<![\w.@])@([a-z][a-z0-9_]*)|(?:\b(?:with|use|using|call|calls|run|runs|via)\s+(?:the\s+)?`?([a-z][a-z0-9]*_[a-z0-9_]*)`?)|`([a-z][a-z0-9]*_[a-z0-9_]*)`|\b([a-z][a-z0-9]*_[a-z0-9_]*)\s+(?:action|tool)\b/g;

export function agentLinks(files: Record<string, string>): AgentLinks {
  const links: AgentLinks = { actions: [], procedures: [], widgets: [], actionWidget: {}, widgetShownBy: {}, widgetRuns: {}, actionRunFrom: {}, procedureUses: {}, actionUsedBy: {}, procedureMissing: {} };
  const paths = Object.keys(files).sort();
  for (const path of paths) {
    const action = ACTION_FILE.exec(path)?.[1];
    if (action) links.actions.push(action);
    const procedure = PROCEDURE_FILE.exec(path)?.[1];
    if (procedure) links.procedures.push(procedure);
    const widget = WIDGET_FILE.exec(path)?.[1];
    if (widget) links.widgets.push(widget);
  }
  for (const path of paths) {
    const text = files[path]!;
    const action = ACTION_FILE.exec(path)?.[1];
    if (action) {
      const widget = widgetOf(text);
      if (widget) {
        links.actionWidget[action] = widget;
        push(links.widgetShownBy, widget, action);
      }
    }
    const widget = WIDGET_FILE.exec(path)?.[1];
    if (widget) {
      for (const tool of widgetTools(text)) {
        push(links.widgetRuns, widget, tool);
        push(links.actionRunFrom, tool, widget);
      }
    }
    const procedure = PROCEDURE_FILE.exec(path)?.[1];
    if (procedure) {
      const steps = stepsOf(text);
      for (const name of links.actions) {
        if (new RegExp(`(^|[^a-z0-9_])${name}([^a-z0-9_]|$)`).test(steps)) {
          push(links.procedureUses, procedure, name);
          push(links.actionUsedBy, name, procedure);
        }
      }
      for (const m of steps.matchAll(AS_ACTION)) {
        const name = m[1] ?? m[2] ?? m[3] ?? m[4]!;
        // W-29: show_widget is the AI's own tool (cards it fills in itself), not a file.
        if (!links.actions.includes(name) && name !== "show_widget") push(links.procedureMissing, procedure, name);
      }
    }
  }
  return links;
}
