import { useEffect, useRef, useState } from "react";
import { readYaml } from "../lib/agentFiles.ts";
import { useThemePref } from "../lib/theme.ts";
import { MAX_WIDGET_STATES, parseWidgetFile, previewSummary, previewWidget, renderWidget, starterWidget, widgetSchema, type WidgetNode } from "../../shared/widgets.ts";
import { schemaFromSample, schemaParams, withDescription, withRequired, type JsonSchema } from "../../shared/widget-schema.ts";
import { NativeSelect, NativeSelectOption } from "@/components/ui/native-select.tsx";
import { WidgetCard } from "../widget/chatkit/WidgetCard.tsx";
import { Button } from "@/components/ui/button.tsx";
import { Input } from "@/components/ui/input.tsx";
import { Switch } from "@/components/ui/switch.tsx";
import { Badge } from "@/components/ui/badge.tsx";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog.tsx";
import { Field as UiField, FieldDescription, FieldError, FieldLabel } from "@/components/ui/field.tsx";
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs.tsx";
import type { WidgetTemplate } from "./widget-templates.ts";
import { ExternalLinkIcon, MoonIcon, PlusIcon, SearchIcon, SunIcon, TrashIcon, UploadIcon } from "../components/icons.tsx";
import { formatTemplate } from "../../shared/widget-ai.ts";
import { CodeArea } from "./CodeArea.tsx";
import { WidgetChat } from "./AiChat.tsx";
import { Studio } from "./Studio.tsx";
import { WidgetPageActions, widgetPageActions } from "./WebsiteActions.tsx";
import { Connections } from "./Connections.tsx";
import { AddDialog, CodeEditor, Problems, TOOL, WIDGET, changeOf, go, humanize, slug } from "./parts.tsx";
import type { AgentConfig } from "./useAgentConfig.ts";

// /agent/widgets[/<name>]: widgets/<name>.widget (W-09). /agent/widgets is a gallery of live previews
// (after Chatbase's Widgets page), with ChatKit Studio's own gallery as Templates to start from (W-23).
// A widget's page (W-22, after ChatKit Studio's editor) is AI / Code / Details beside a large preview
// canvas with a light / dark switch, which follows every change.

type Theme = "light" | "dark";

interface WidgetItem {
  name: string;
  path: string;
}

function widgetsOf(cfg: AgentConfig): WidgetItem[] {
  return Object.keys(cfg.draft)
    .map((path) => ({ path, name: WIDGET.exec(path)?.[1] }))
    .filter((x): x is WidgetItem => Boolean(x.name))
    .sort((a, b) => a.name.localeCompare(b.name));
}

/** The actions (tools/*.yaml) that show this widget. */
function usedBy(cfg: AgentConfig, name: string): string[] {
  return Object.keys(cfg.draft)
    .filter((p) => TOOL.test(p))
    .filter((p) => (readYaml(cfg.draft[p]!) as { widget?: unknown } | null)?.widget === name)
    .map((p) => TOOL.exec(p)![1]!);
}

type WidgetState = { name: string; data: Record<string, unknown> };

function render(name: string, text: string, state = -1): { root: WidgetNode | null; problem: string | null } {
  try {
    // W-30: a named state draws with its own data.
    const named = state >= 0 ? parseWidgetFile(name, text).states?.[state] : undefined;
    return { root: named ? renderWidget(parseWidgetFile(name, text), named.data) : previewWidget(name, text), problem: null };
  } catch (error) {
    return { root: null, problem: (error as Error).message };
  }
}

/** W-30: a widget file's named states (Studio's or ours), [] when it has none or doesn't parse. */
function statesOf(name: string, text: string): WidgetState[] {
  try {
    return parseWidgetFile(name, text).states ?? [];
  } catch {
    return [];
  }
}

/** A free name for an uploaded file: its own, else with _2, _3… */
function freeName(cfg: AgentConfig, raw: string): string {
  const base = slug(raw.replace(/\.(widget|json)$/i, ""), "_") || "widget";
  let name = base;
  for (let n = 2; `widgets/${name}.widget` in cfg.draft; n++) name = `${base}_${n}`;
  return name;
}

export function WidgetsView({ cfg, canEdit, selected }: { cfg: AgentConfig; canEdit: boolean; selected: string | null }) {
  const items = widgetsOf(cfg);
  const current = items.find((i) => i.name === selected);
  // A widget that's gone (discarded, removed, another version): back to the gallery.
  const gone = selected !== null && !current && cfg.state !== null;
  useEffect(() => {
    if (gone) go("/agent/widgets");
  }, [gone]);
  if (current) return <WidgetEditor key={current.path} cfg={cfg} canEdit={canEdit} path={current.path} name={current.name} />;
  return <WidgetGallery cfg={cfg} canEdit={canEdit} items={items} />;
}

type GalleryTab = "mine" | "templates";
// The tab, for this visit (coming back from a widget keeps it).
let lastTab: GalleryTab | null = null;

function WidgetGallery({ cfg, canEdit, items }: { cfg: AgentConfig; canEdit: boolean; items: WidgetItem[] }) {
  const [adding, setAdding] = useState(false);
  const [query, setQuery] = useState("");
  const [tab, setTabState] = useState<GalleryTab>(() => lastTab ?? (items.length === 0 && canEdit ? "templates" : "mine"));
  const setTab = (next: GalleryTab) => {
    lastTab = next;
    setTabState(next);
  };
  const upload = useRef<HTMLInputElement>(null);
  useThemePref(); // the tiles follow the dashboard's light / dark
  const q = query.trim().toLowerCase();
  const shown = q ? items.filter((i) => humanize(i.name).toLowerCase().includes(q) || i.name.includes(q)) : items;

  return (
    <div className="agent-gallery">
      <Tabs value={tab} onValueChange={(v) => setTab(v as GalleryTab)}>
        <TabsList className="kb-tabs agent-gallery-tabs" aria-label="Widgets">
          <TabsTrigger value="mine">My widgets</TabsTrigger>
          <TabsTrigger value="templates">Templates</TabsTrigger>
        </TabsList>
      </Tabs>
      <div className="agent-gallery-bar">
        <div className="agent-gallery-search">
          <SearchIcon />
          <Input
            type="search"
            placeholder={tab === "templates" ? "Search templates…" : "Search widgets…"}
            aria-label={tab === "templates" ? "Search templates" : "Search widgets"}
            value={query}
            onChange={(e) => setQuery(e.target.value)}
          />
        </div>
        <span className="spacer" />
        {canEdit && (
          <>
            <Button variant="outline" size="icon" title="Upload a file from ChatKit Studio" aria-label="Upload a .widget file" onClick={() => upload.current?.click()}>
              <UploadIcon />
            </Button>
            <Button onClick={() => setAdding(true)}>
              <PlusIcon /> New widget
            </Button>
            <input
              ref={upload}
              type="file"
              accept=".widget,application/json"
              hidden
              onChange={async (e) => {
                const file = e.target.files?.[0];
                e.target.value = "";
                if (!file) return;
                const name = freeName(cfg, file.name);
                cfg.setFile(`widgets/${name}.widget`, await file.text());
                go(`/agent/widgets/${name}`);
              }}
            />
          </>
        )}
      </div>

      {tab === "templates" ? (
        <TemplateGallery cfg={cfg} canEdit={canEdit} query={q} />
      ) : items.length === 0 ? (
        <div className="agent-gallery-empty">
          <h2>Show results as widgets</h2>
          <p>A widget shows an action's result to the customer as a card, like an order's status or their plan, instead of text. Its buttons can run your actions.</p>
          {canEdit && (
            <div className="row agent-gallery-empty-actions">
              <Button onClick={() => setTab("templates")}>Start from a template</Button>
              <Button variant="outline" onClick={() => setAdding(true)}>
                <PlusIcon /> New widget
              </Button>
            </div>
          )}
        </div>
      ) : shown.length === 0 ? (
        <p className="muted small agent-gallery-none">No widget matches "{query}".</p>
      ) : (
        <ul className="agent-gallery-grid">
          {shown.map((item) => (
            <WidgetTile key={item.path} cfg={cfg} item={item} />
          ))}
        </ul>
      )}

      <AddDialog
        open={adding}
        onClose={() => setAdding(false)}
        title="New widget"
        description="Starts from a simple widget. Or start from a template, or upload a file from ChatKit Studio."
        placeholder="e.g. Order status"
        exists={(raw) => nameProblem(cfg, raw)}
        onAdd={(raw) => {
          const name = slug(raw, "_");
          cfg.setFile(`widgets/${name}.widget`, starterWidget(humanize(name)));
          setAdding(false);
          go(`/agent/widgets/${name}`);
        }}
      />
    </div>
  );
}

/** Why a typed name can't be used for a new widget, or null. */
function nameProblem(cfg: AgentConfig, raw: string): string | null {
  const name = slug(raw, "_");
  if (!name) return "Start with a letter.";
  return `widgets/${name}.widget` in cfg.draft ? "There's already a widget with this name." : null;
}

/** Templates: ChatKit Studio's gallery, loaded when the tab opens; one opens in a dialog to use it. */
function TemplateGallery({ cfg, canEdit, query }: { cfg: AgentConfig; canEdit: boolean; query: string }) {
  const [templates, setTemplates] = useState<WidgetTemplate[] | null>(null);
  const [failed, setFailed] = useState(false);
  const [picked, setPicked] = useState<WidgetTemplate | null>(null);
  useEffect(() => {
    let live = true;
    import("./widget-templates.ts")
      .then((m) => live && setTemplates(m.WIDGET_TEMPLATES))
      .catch(() => live && setFailed(true));
    return () => {
      live = false;
    };
  }, []);
  if (failed) return <p className="error small">The templates didn't load. Reload the page to try again.</p>;
  if (!templates) return <p className="muted small agent-gallery-none">Loading templates…</p>;
  const shown = query ? templates.filter((t) => `${t.name} ${t.description}`.toLowerCase().includes(query)) : templates;
  return (
    <>
      <p className="muted small agent-gallery-note">
        From ChatKit Studio's gallery. Pick one to start from, then change it with the AI or in Code, and show it from an action.
      </p>
      {shown.length === 0 ? (
        <p className="muted small agent-gallery-none">No template matches "{query}".</p>
      ) : (
        <ul className="agent-gallery-grid">
          {shown.map((t) => (
            <TemplateTile key={t.id} template={t} onOpen={() => setPicked(t)} />
          ))}
        </ul>
      )}
      <TemplateDialog cfg={cfg} canEdit={canEdit} template={picked} onClose={() => setPicked(null)} />
    </>
  );
}

function TemplatePreview({ template, theme }: { template: WidgetTemplate; theme: Theme }) {
  const { root, problem } = render(template.id, template.file);
  return root ? <WidgetCard widget={{ id: `template-${template.id}`, name: template.id, root }} interactive={false} theme={theme} /> : <p className="error small">{problem}</p>;
}

function TemplateTile({ template, onOpen }: { template: WidgetTemplate; onOpen: () => void }) {
  return (
    <li className="agent-tile">
      <div className="agent-stage agent-tile-stage" aria-hidden="true" inert>
        <div className="agent-stage-card">
          <TemplatePreview template={template} theme={pageTheme()} />
        </div>
      </div>
      <div className="agent-tile-text">
        {/* data-plain: the desk's pressed nudge (a transform) would shrink the whole-tile ::after to the name mid-click. */}
        <button type="button" className="agent-tile-link" data-plain onClick={onOpen}>
          {template.name}
        </button>
        <span className="agent-tile-sub">{template.description}</span>
      </div>
    </li>
  );
}

/** A template up close: a large preview, what it's for, and a name to add it under. */
function TemplateDialog({ cfg, canEdit, template, onClose }: { cfg: AgentConfig; canEdit: boolean; template: WidgetTemplate | null; onClose: () => void }) {
  const [name, setName] = useState("");
  useEffect(() => {
    if (template) setName(freeName(cfg, template.id));
    // Only when another template opens: the draft changing doesn't reset what's typed.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [template]);
  const problem = name.trim() ? nameProblem(cfg, name) : null;
  const use = () => {
    if (!template || !name.trim() || problem) return;
    const id = slug(name, "_");
    cfg.setFile(`widgets/${id}.widget`, template.file);
    onClose();
    go(`/agent/widgets/${id}`);
  };
  return (
    <Dialog open={template !== null} onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="agent-template-dialog">
        {template && (
          <>
            <div className="agent-stage agent-template-stage">
              <div className="agent-stage-card">
                <TemplatePreview template={template} theme={pageTheme()} />
              </div>
            </div>
            <form
              className="agent-template-side"
              onSubmit={(e) => {
                e.preventDefault();
                use();
              }}
            >
              <DialogHeader>
                <DialogTitle>{template.name}</DialogTitle>
                <DialogDescription>{template.description}</DialogDescription>
              </DialogHeader>
              {canEdit ? (
                <>
                  <UiField data-invalid={problem ? true : undefined}>
                    <FieldLabel htmlFor="agent-template-name">Name</FieldLabel>
                    <Input id="agent-template-name" value={name} onChange={(e) => setName(e.target.value)} maxLength={60} aria-invalid={problem ? true : undefined} />
                    {problem ? <FieldError>{problem}</FieldError> : <FieldDescription>Actions show it by this name. Nothing changes for customers until you save.</FieldDescription>}
                  </UiField>
                  <Button type="submit" disabled={!name.trim() || problem !== null}>
                    Use this template
                  </Button>
                </>
              ) : (
                <p className="muted small">Only admins can add widgets.</p>
              )}
            </form>
          </>
        )}
      </DialogContent>
    </Dialog>
  );
}

/** One widget in the gallery: its live preview (not clickable itself) and a link over the whole tile. */
/** What shows this widget, for its tile: its actions, (W-29) the AI filling it in itself and (W-31) website actions. */
function shownBy(tools: string[], aiFill: boolean, site: string[]): string {
  const who = [...(aiFill ? ["the AI"] : []), ...tools.map(humanize), ...site.map(humanize)];
  return who.length ? `Shown by ${who.join(", ")}` : "Nothing shows it yet";
}

function WidgetTile({ cfg, item }: { cfg: AgentConfig; item: WidgetItem }) {
  const { root, problem } = render(item.name, cfg.draft[item.path] ?? "");
  const tools = usedBy(cfg, item.name);
  const change = changeOf(cfg, item.path);
  const problems = cfg.issuesFor(item.path).length;
  const href = `/agent/widgets/${item.name}`;
  return (
    <li className="agent-tile">
      <div className="agent-stage agent-tile-stage" aria-hidden="true" inert>
        <div className="agent-stage-card">
          {root ? <WidgetCard widget={{ id: `tile-${item.name}`, name: item.name, root }} interactive={false} theme={pageTheme()} /> : <p className="error small">{problem}</p>}
        </div>
      </div>
      <div className="agent-tile-text">
        <a className="agent-tile-link" href={href} onClick={(e) => { e.preventDefault(); go(href); }}>
          {humanize(item.name)}
        </a>
        {problems > 0 && <Badge variant="destructive">{problems === 1 ? "1 problem" : `${problems} problems`}</Badge>}
        {change && <Badge variant="secondary">{change}</Badge>}
        <span className="agent-tile-sub">{shownBy(tools, /"aiFill"\s*:\s*true/.test(cfg.draft[item.path] ?? ""), widgetPageActions(cfg.draft, item.name))}</span>
      </div>
    </li>
  );
}

const pageTheme = (): Theme => (document.documentElement.dataset.theme === "dark" ? "dark" : "light");

/** The .widget file as an object, or null when it isn't a JSON object. */
function readFile(text: string): Record<string, unknown> | null {
  try {
    const file = JSON.parse(text) as unknown;
    return typeof file === "object" && file !== null && !Array.isArray(file) ? (file as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

/** The file with one key set (or removed with undefined); other keys keep their order. */
function withKey(text: string, key: string, value: unknown): string {
  const file = readFile(text) ?? {};
  if (value === undefined) delete file[key];
  else file[key] = value;
  return `${JSON.stringify(file, null, 2)}\n`;
}

function WidgetEditor({ cfg, canEdit, path, name }: { cfg: AgentConfig; canEdit: boolean; path: string; name: string }) {
  const text = cfg.draft[path] ?? "";
  const [theme, setTheme] = useState<Theme>(pageTheme);
  // W-30: which example the preview draws and Code edits: the default (-1) or a named state, as in Studio.
  const states = statesOf(name, text);
  const [state, setState] = useState(-1);
  const shown = state < states.length ? state : -1;
  const { root, problem } = render(name, text, shown);

  return (
    <Studio
      cfg={cfg}
      canEdit={canEdit}
      path={path}
      title={humanize(name)}
      back={{ path: "/agent/widgets", label: "All widgets" }}
      onRemove={() => {
        cfg.setFile(path, undefined);
        go("/agent/widgets");
      }}
      panes={[
        ...(canEdit ? [{ id: "ai" as const, label: "AI", content: <WidgetChat cfg={cfg} path={path} name={name} /> }] : []),
        { id: "code" as const, label: "Code", content: <WidgetCode cfg={cfg} path={path} canEdit={canEdit} states={states} state={shown} setState={setState} /> },
        { id: "details" as const, label: "Details", content: <WidgetDetails cfg={cfg} path={path} name={name} canEdit={canEdit} /> },
      ]}
      right={
        <section className="agent-stage agent-wed-canvas" data-preview={theme} aria-label="Preview">
          {states.length > 0 && (
            <div className="agent-canvas-state">
              <NativeSelect size="sm" aria-label="Example to preview" value={String(shown)} onChange={(e) => setState(Number(e.target.value))}>
                <NativeSelectOption value="-1">Default</NativeSelectOption>
                {states.map((s, i) => <NativeSelectOption key={i} value={String(i)}>{s.name}</NativeSelectOption>)}
              </NativeSelect>
            </div>
          )}
          <div className="agent-canvas-tools" role="group" aria-label="Preview theme">
            <Button variant="ghost" size="icon-sm" aria-label="Light" aria-pressed={theme === "light"} onClick={() => setTheme("light")}>
              <SunIcon />
            </Button>
            <Button variant="ghost" size="icon-sm" aria-label="Dark" aria-pressed={theme === "dark"} onClick={() => setTheme("dark")}>
              <MoonIcon />
            </Button>
          </div>
          <div className="agent-stage-card">
            {root ? <WidgetCard widget={{ id: "preview", name, root }} interactive={false} theme={theme} /> : <p className="agent-canvas-error">{problem}</p>}
          </div>
          <p className="agent-canvas-caption">{shown >= 0 ? `State "${states[shown]!.name}", as a customer sees it` : "With example data, as a customer sees it"}</p>
        </section>
      }
    />
  );
}

/**
 * Code: the template (indented) over the data, like ChatKit Studio: Default and each named state as
 * tabs (+ adds one, copying the default), then Schema, Summary and the whole file.
 */
function WidgetCode({ cfg, path, canEdit, states, state, setState }: { cfg: AgentConfig; path: string; canEdit: boolean; states: WidgetState[]; state: number; setState: (i: number) => void }) {
  const text = cfg.draft[path] ?? "";
  const file = readFile(text);
  const template = typeof file?.template === "string" ? file.template : "";
  const summary = typeof file?.summary === "string" ? file.summary : "";
  const [bottom, setBottom] = useState<"data" | "schema" | "summary" | "file">("data");

  // What the fields show: kept while you type, replaced when the file changes elsewhere (the AI, Undo, Discard).
  const [tpl, setTpl] = useState(() => formatTemplate(template));
  const wroteTpl = useRef(template);
  useEffect(() => {
    if (template !== wroteTpl.current) {
      wroteTpl.current = template;
      setTpl(formatTemplate(template));
    }
  }, [template]);
  const pick = (i: number) => {
    setState(i);
    setBottom("data");
  };
  const addState = () => {
    const taken = new Set(states.map((s) => s.name));
    let n = states.length + 1;
    while (taken.has(`State ${n}`)) n++;
    const sample = typeof file?.sample === "object" && file.sample !== null ? structuredClone(file.sample as Record<string, unknown>) : {};
    cfg.setFile(path, withKey(text, "states", [...states, { name: `State ${n}`, data: sample }]));
    pick(states.length);
  };

  if (!file) {
    return (
      <div className="agent-wed-raw">
        <p className="agent-notice small">This file isn't valid JSON, so it's shown whole. Fix it here and the editor comes back.</p>
        <CodeEditor cfg={cfg} path={path} canEdit={canEdit} />
      </div>
    );
  }
  return (
    <div className="wcode">
      <div className="wcode-top">
        <div className="wcode-label">Template</div>
        <CodeArea
          label="Template"
          value={tpl}
          readOnly={!canEdit}
          onChange={(next) => {
            setTpl(next);
            wroteTpl.current = next;
            cfg.setFile(path, withKey(text, "template", next));
          }}
        />
      </div>
      <div className="wcode-bottom">
        <div className="wcode-tabs" role="tablist" aria-label="Data">
          <button type="button" role="tab" aria-selected={bottom === "data" && state < 0} onClick={() => pick(-1)}>Default</button>
          {states.map((s, i) => (
            <button key={i} type="button" role="tab" aria-selected={bottom === "data" && state === i} onClick={() => pick(i)}>{s.name}</button>
          ))}
          {canEdit && states.length < MAX_WIDGET_STATES && (
            <button type="button" className="wcode-add" aria-label="Add a state" title="Add a state: another example to preview and check" onClick={addState}>
              <PlusIcon />
            </button>
          )}
          <span className="wcode-tabs-gap" />
          <button type="button" role="tab" aria-selected={bottom === "schema"} onClick={() => setBottom("schema")}>Schema</button>
          <button type="button" role="tab" aria-selected={bottom === "summary"} onClick={() => setBottom("summary")}>Summary</button>
          <button type="button" role="tab" aria-selected={bottom === "file"} onClick={() => setBottom("file")}>Whole file</button>
        </div>
        {bottom === "data" ? (
          <ExampleData key={state} cfg={cfg} path={path} canEdit={canEdit} file={file} states={states} state={state} setState={setState} />
        ) : bottom === "schema" ? (
          <SchemaCode cfg={cfg} path={path} canEdit={canEdit} file={file} />
        ) : bottom === "summary" ? (
          <div className="wcode-summary">
            <Input
              aria-label="Summary line"
              className="mono"
              value={summary}
              readOnly={!canEdit}
              maxLength={200}
              placeholder="e.g. {{ plan }} plan · {{ status }}"
              onChange={(e) => cfg.setFile(path, withKey(text, "summary", e.target.value || undefined))}
            />
            <p className="wcode-hint">One plain-text line from the same data. The chat shows it when it folds the widget away.</p>
          </div>
        ) : (
          <CodeEditor cfg={cfg} path={path} canEdit={canEdit} />
        )}
      </div>
      <Problems issues={cfg.issuesFor(path)} raw />
    </div>
  );
}

/**
 * W-30: one example's data, as in Studio's Default and state tabs: the file's `sample`, or a named
 * state's data (written to our own `states`, which then replaces Studio's). A state can be renamed or
 * removed. Written to the file once it parses.
 */
function ExampleData({ cfg, path, canEdit, file, states, state, setState }: { cfg: AgentConfig; path: string; canEdit: boolean; file: Record<string, unknown>; states: WidgetState[]; state: number; setState: (i: number) => void }) {
  const text = cfg.draft[path] ?? "";
  const named = state >= 0 ? states[state] : undefined;
  const current = JSON.stringify(named ? named.data : (file.sample ?? {}), null, 2);
  const [value, setValue] = useState(current);
  const wrote = useRef(current);
  const [error, setError] = useState<string | null>(null);
  const [title, setTitle] = useState(named?.name ?? "");
  useEffect(() => {
    if (current !== wrote.current) {
      wrote.current = current;
      setValue(current);
      setError(null);
    }
  }, [current]);
  // No states left: the key goes, unless an empty list must hide Studio's own.
  const writeStates = (next: WidgetState[]) => cfg.setFile(path, withKey(text, "states", next.length || typeof file.encodedWidget === "string" ? next : undefined));
  return (
    <>
      {named && (
        <div className="wcode-state">
          <Input
            aria-label="State name"
            value={title}
            readOnly={!canEdit}
            maxLength={40}
            onChange={(e) => {
              setTitle(e.target.value);
              const name = e.target.value.trim();
              if (name) writeStates(states.map((s, i) => (i === state ? { ...s, name } : s)));
            }}
          />
          {canEdit && (
            <Button
              variant="ghost"
              size="icon-sm"
              aria-label="Remove this state"
              title="Remove this state"
              onClick={() => {
                writeStates(states.filter((_, i) => i !== state));
                setState(-1);
              }}
            >
              <TrashIcon />
            </Button>
          )}
        </div>
      )}
      <CodeArea
        label={named ? `${named.name} data` : "Example data"}
        value={value}
        readOnly={!canEdit}
        onChange={(next) => {
          setValue(next);
          try {
            const parsed = JSON.parse(next) as unknown;
            if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) throw new Error("Example data is a JSON object: { … }.");
            setError(null);
            wrote.current = JSON.stringify(parsed, null, 2);
            if (named) writeStates(states.map((s, i) => (i === state ? { ...s, data: parsed as Record<string, unknown> } : s)));
            else cfg.setFile(path, withKey(text, "sample", parsed));
          } catch (e) {
            setError(e instanceof SyntaxError ? "Not valid JSON yet." : (e as Error).message);
          }
        }}
      />
      <p className={error ? "wcode-hint error" : "wcode-hint"}>
        {error ?? (named ? "Another example to preview the widget with. It must fit the schema and draw." : "Data shaped like your action's response; the preview uses it.")}
      </p>
    </>
  );
}

/**
 * W-30: Code's Schema tab: the file's `jsonSchema` (shown worked out from the example data when it
 * has none; editing it makes it the widget's own), as JSON, written to the file once it parses.
 */
function SchemaCode({ cfg, path, canEdit, file }: { cfg: AgentConfig; path: string; canEdit: boolean; file: Record<string, unknown> }) {
  const text = cfg.draft[path] ?? "";
  const own = typeof file.jsonSchema === "object" && file.jsonSchema !== null && Object.keys(file.jsonSchema).length > 0;
  const current = JSON.stringify(own ? file.jsonSchema : schemaFromSample(file.sample ?? {}), null, 2);
  const [value, setValue] = useState(current);
  const wrote = useRef(current);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    if (current !== wrote.current) {
      wrote.current = current;
      setValue(current);
      setError(null);
    }
  }, [current]);
  const hint = own
    ? "The widget's parameters as JSON Schema (ChatKit Studio's Schema tab). Actions and the AI fill the widget in this shape."
    : "Worked out from the example data. Edit it to make it the widget's own, with descriptions and optional fields.";
  return (
    <>
      <CodeArea
        label="Schema"
        value={value}
        readOnly={!canEdit}
        onChange={(next) => {
          setValue(next);
          try {
            const parsed = JSON.parse(next) as unknown;
            if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) throw new Error("The schema is a JSON object: { \"type\": \"object\", … }.");
            setError(null);
            wrote.current = JSON.stringify(parsed, null, 2);
            cfg.setFile(path, withKey(text, "jsonSchema", parsed));
          } catch (e) {
            setError(e instanceof SyntaxError ? "Not valid JSON yet." : (e as Error).message);
          }
        }}
      />
      <p className={error ? "wcode-hint error" : "wcode-hint"}>{error ?? hint}</p>
    </>
  );
}

/**
 * W-30: the widget's parameters (its schema, else worked out from the example data): each field's
 * path, type and whether it's needed, with a description to type (what the AI reads when it fills
 * the card). Typing one makes the schema the widget's own (`jsonSchema` in the file).
 */
function Parameters({ cfg, path, name, canEdit, file }: { cfg: AgentConfig; path: string; name: string; canEdit: boolean; file: Record<string, unknown> }) {
  const text = cfg.draft[path] ?? "";
  let schema: JsonSchema | null = null;
  try {
    schema = widgetSchema(parseWidgetFile(name, text));
  } catch {
    schema = null;
  }
  const params = schema ? schemaParams(schema) : [];
  if (!schema || !params.length) {
    return (
      <div className="agent-wed-group">
        <h3>Parameters</h3>
        <p>Add example data in Code: the widget's parameters come from it.</p>
      </div>
    );
  }
  const own = typeof file.jsonSchema === "object" && file.jsonSchema !== null && Object.keys(file.jsonSchema).length > 0;
  return (
    <div className="agent-wed-group">
      <h3>Parameters</h3>
      <p>{own ? "The data this widget draws, from its schema." : "The data this widget draws, worked out from its example data."} Describe a field when its name doesn't say enough: the AI reads it when it fills the card.</p>
      <ul className="agent-params-list">
        {params.map((p) => (
          <li key={p.path} style={{ paddingLeft: `${(p.path.split(".").length - 1) * 14}px` }}>
            <div className="agent-param-head">
              <code>{p.path.split(".").at(-1)}</code>
              <span className="agent-param-type">{p.type}</span>
              {/* W-30: needed or not; the AI may leave an optional one out. */}
              <button
                type="button"
                className="agent-param-optional"
                data-on={p.required ? undefined : ""}
                disabled={!canEdit}
                title={p.required ? "Needed: click to make it optional" : "Optional: click to make it needed"}
                onClick={() => cfg.setFile(path, withKey(text, "jsonSchema", withRequired(schema!, p.path, !p.required)))}
              >
                {p.required ? "needed" : "optional"}
              </button>
            </div>
            <Input
              aria-label={`Description of ${p.path}`}
              value={p.description ?? ""}
              readOnly={!canEdit}
              placeholder="What it is, if the name doesn't say"
              onChange={(e) => cfg.setFile(path, withKey(text, "jsonSchema", withDescription(schema!, p.path, e.target.value)))}
            />
          </li>
        ))}
      </ul>
    </div>
  );
}

/** Details: what it's connected to (W-25), its folded line, ChatKit Studio and uploading a file. */
function WidgetDetails({ cfg, path, name, canEdit }: { cfg: AgentConfig; path: string; name: string; canEdit: boolean }) {
  const text = cfg.draft[path] ?? "";
  const upload = useRef<HTMLInputElement>(null);
  const summary = previewSummary(name, text);
  const file = readFile(text);
  const aiFill = file?.aiFill === true;
  return (
    <div className="agent-wed-details">
      <Connections cfg={cfg} kind="widget" name={name} canEdit={canEdit} />
      {/* W-29: the AI may show this card with data it fills in itself (show_widget). */}
      {file && (
        <div className="agent-wed-group">
          <div className="agent-wed-switch">
            <h3 id="wd-aifill">The AI can fill this widget itself</h3>
            <Switch checked={aiFill} disabled={!canEdit} aria-labelledby="wd-aifill" onCheckedChange={(on) => cfg.setFile(path, withKey(text, "aiFill", on ? true : undefined))} />
          </div>
          <p>
            {aiFill
              ? "The AI may show it whenever it fits, filled with what it knows from the chat, your docs and actions, in the shape of the example data. No action is needed."
              : "Off: the widget only shows an action's result. Turn it on for widgets the AI can rightly fill in, like a summary, a comparison or a contact card. Leave it off for account data such as invoices or plans."}
          </p>
          {aiFill && file.sample === undefined && <p className="agent-wed-warn">Add example data in Code: the AI fills the widget in its shape.</p>}
        </div>
      )}
      {file && <WidgetPageActions cfg={cfg} name={name} canEdit={canEdit} />}
      {file && <Parameters cfg={cfg} path={path} name={name} canEdit={canEdit} file={file} />}
      {summary && (
        <div className="agent-wed-group">
          <h3>Folded</h3>
          <p>When the chat folds the widget away, it reads "{summary}".</p>
        </div>
      )}
      <div className="agent-wed-group">
        <h3>ChatKit Studio</h3>
        <p>You can also design a widget in ChatKit Studio, download the file and upload it here.</p>
        <div className="agent-wed-actions">
          <Button variant="outline" size="sm" nativeButton={false} render={<a href="https://widgets.chatkit.studio" target="_blank" rel="noopener noreferrer" />}>
            <ExternalLinkIcon /> Open ChatKit Studio
          </Button>
          {canEdit && (
            <Button variant="outline" size="sm" onClick={() => upload.current?.click()}>
              <UploadIcon /> Replace with a file
            </Button>
          )}
        </div>
        <input
          ref={upload}
          type="file"
          accept=".widget,application/json"
          hidden
          onChange={async (e) => {
            const file = e.target.files?.[0];
            e.target.value = "";
            if (file) cfg.setFile(path, await file.text());
          }}
        />
      </div>
      <Problems issues={cfg.issuesFor(path)} />
    </div>
  );
}
