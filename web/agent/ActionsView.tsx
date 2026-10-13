import { useEffect, useMemo, useState } from "react";
import { agentLinks } from "../../shared/agent-links.ts";
import { editYaml, freshName, readYaml, type Edit } from "../lib/agentFiles.ts";
import { Button } from "@/components/ui/button.tsx";
import { Checkbox } from "@/components/ui/checkbox.tsx";
import { Input } from "@/components/ui/input.tsx";
import { NativeSelect, NativeSelectOption } from "@/components/ui/native-select.tsx";
import { Textarea } from "@/components/ui/textarea.tsx";
import { PlusIcon, TrashIcon } from "../components/icons.tsx";
import { Advanced, Field, ItemIndex, Problems, TextList, TOOL, Unreadable, WIDGET, go, humanize } from "./parts.tsx";
import type { AgentConfig } from "./useAgentConfig.ts";
import { FileStudio } from "./FileStudio.tsx";
import { KeysField, SetupNotice, setupProblems, useActionKeys, type ActionKeys } from "./ActionKeys.tsx";
import { WebsiteActions } from "./WebsiteActions.tsx";
import { TryAction } from "./TryAction.tsx";
import { NewActionDialog } from "./NewActionDialog.tsx";

// /agent/actions[/<name>]: tools/<name>.yaml. An action is a request to the customer's own systems
// the AI can make: look something up (GET) or change something (POST). /agent/actions lists them as
// cards; an action's page is laid out like a widget's (FileStudio): AI and Code on the left, the form
// on the right (W-24).

const TYPES = [
  { value: "string", label: "Text" },
  { value: "number", label: "Number" },
  { value: "integer", label: "Whole number" },
  { value: "boolean", label: "Yes or no" },
];

type Data = Record<string, unknown>;
const isRecord = (v: unknown): v is Data => typeof v === "object" && v !== null && !Array.isArray(v);

export function ActionsView({ cfg, canEdit, selected }: { cfg: AgentConfig; canEdit: boolean; selected: string | null }) {
  const [adding, setAdding] = useState(false);
  const keys = useActionKeys(cfg);
  const items = Object.keys(cfg.draft)
    .map((path) => ({ path, name: TOOL.exec(path)?.[1] }))
    .filter((x): x is { path: string; name: string } => Boolean(x.name))
    .sort((a, b) => a.name.localeCompare(b.name))
    .map(({ path, name }) => {
      const data = readYaml(cfg.draft[path]!);
      // AI-24: one that can't work yet says so on its card.
      const notReady = setupProblems(cfg.draft[path]!, keys).length > 0;
      return { id: name, path, label: humanize(name), sub: isRecord(data) && typeof data.description === "string" ? data.description : "", ...(notReady ? { badge: "Not set up" } : {}) };
    });
  const current = selected === null ? null : (items.find((i) => i.id === selected) ?? null);
  const names = new Set(items.map((i) => i.id));
  // An action that's gone (removed, discarded, another version): back to the list.
  const gone = selected !== null && current === null && cfg.state !== null;
  useEffect(() => {
    if (gone) go("/agent/actions");
  }, [gone]);

  if (current) {
    return (
      <FileStudio
        key={current.path}
        cfg={cfg}
        canEdit={canEdit}
        path={current.path}
        title={current.label}
        kind="action"
        back={{ path: "/agent/actions", label: "All actions" }}
        form={<ActionForm cfg={cfg} canEdit={canEdit} path={current.path} keys={keys} />}
      />
    );
  }
  return (
    <>
      <ItemIndex
        cfg={cfg}
        items={items}
        base="/agent/actions"
        onAdd={() => setAdding(true)}
        addLabel="New action"
        canEdit={canEdit}
        noun="actions"
        empty={{ title: "Let the AI do things", text: "Say what the AI should do, paste a curl command from your API docs if you have one, and the AI sets up the action. Then try it." }}
      />
      <WebsiteActions cfg={cfg} canEdit={canEdit} />
      <NewActionDialog open={adding} onClose={() => setAdding(false)} cfg={cfg} keys={keys} names={names} />
    </>
  );
}

function ActionForm({ cfg, canEdit, path, keys }: { cfg: AgentConfig; canEdit: boolean; path: string; keys: ActionKeys }) {
  const text = cfg.draft[path] ?? "";
  const name = TOOL.exec(path)?.[1] ?? "";
  // W-27: a widget's button runs it, so the card's own lines matter (else they wait under More options).
  const runFrom = useMemo(() => agentLinks(cfg.draft).actionRunFrom[name] ?? [], [cfg.draft, name]);
  const data = readYaml(text);
  const edit = (...edits: Edit[]) => cfg.setFile(path, editYaml(text, ...edits));
  const set = (key: string, value: unknown) => edit({ op: "set", path: [key], value });
  if (!isRecord(data)) {
    return (
      <div className="agent-form">
        <Unreadable />
        <Problems issues={cfg.issuesFor(path)} />
      </div>
    );
  }
  const str = (key: string) => (typeof data[key] === "string" || typeof data[key] === "number" ? String(data[key]) : "");
  const input = isRecord(data.input) ? data.input : {};
  const widgets = Object.keys(cfg.draft).map((p) => WIDGET.exec(p)?.[1]).filter((w): w is string => Boolean(w)).sort();
  const codeOnly = ["body", "pick", "mock"].filter((k) => data[k] !== undefined);
  const method = str("method").toUpperCase() || "GET";
  // A renamed detail keeps its place in the address and query: `{id}` becomes `{order_id}`.
  const rename = (from: string, to: string) => {
    if (!to || to in input) return;
    const swap = (v: string) => v.split(`{${from}}`).join(`{${to}}`);
    const query = isRecord(data.query) ? data.query : {};
    edit(
      { op: "rename", path: ["input"], from, to },
      ...(str("url").includes(`{${from}}`) ? [{ op: "set" as const, path: ["url"], value: swap(str("url")) }] : []),
      ...Object.entries(query).filter(([, v]) => String(v).includes(`{${from}}`)).map(([k, v]) => ({ op: "set" as const, path: ["query", k], value: swap(String(v)) })),
    );
  };

  return (
    <div className="agent-form">
      <SetupNotice problems={setupProblems(text, keys)} />
      <Field label="What it does" hint="The AI reads this to decide when to use it. Say what it returns or changes." htmlFor="act-desc">
        <Textarea id="act-desc" rows={2} value={str("description")} readOnly={!canEdit} placeholder="e.g. Finds an order by its number and returns its status and delivery date." onChange={(e) => set("description", e.target.value)} />
      </Field>
      <Field label="While it runs, the customer sees" htmlFor="act-status">
        <Input id="act-status" value={str("status")} readOnly={!canEdit} maxLength={60} placeholder="e.g. Checking your order" onChange={(e) => set("status", e.target.value)} />
      </Field>
      <Field
        label="Request"
        hint={<>Your developer can give you this address. Put details the AI fills in inside braces: <code>https://api.acme.com/orders/{"{order_id}"}</code>. Only showing a widget? Leave it empty: the widget shows with its example data.</>}
        htmlFor="act-url"
      >
        <div className="agent-request">
          <NativeSelect aria-label="Kind of request" value={method} disabled={!canEdit} onChange={(e) => set("method", e.target.value)}>
            <NativeSelectOption value="GET">Look up (GET)</NativeSelectOption>
            <NativeSelectOption value="POST">Make a change (POST)</NativeSelectOption>
          </NativeSelect>
          <Input id="act-url" className="mono" value={str("url")} readOnly={!canEdit} placeholder="https://" spellCheck={false} onChange={(e) => set("url", e.target.value)} />
        </div>
      </Field>
      <KeysField text={text} keys={keys} canEdit={canEdit} />
      <Field label="Details the AI asks for" hint="What the AI needs from the customer (or the chat) before it can run this, like an order number.">
        <div className="agent-params">
          {Object.entries(input).map(([key, raw], i) => {
            const spec: Data = isRecord(raw) ? raw : { type: raw };
            // `id: string` (the short form) becomes a map before any of its fields change.
            const setSpec = (field: string, value: unknown) =>
              isRecord(raw) ? edit({ op: "set", path: ["input", key, field], value }) : edit({ op: "set", path: ["input", key], value: { ...spec, [field]: value } });
            return (
              <div className="agent-param" key={i}>
                <Input className="mono" aria-label="Name" value={key} readOnly={!canEdit} spellCheck={false} onChange={(e) => rename(key, e.target.value.replace(/[^a-zA-Z0-9_]/g, "_"))} />
                <NativeSelect aria-label="Type" value={String(spec.type ?? "string")} disabled={!canEdit} onChange={(e) => setSpec("type", e.target.value)}>
                  {TYPES.map((t) => <NativeSelectOption key={t.value} value={t.value}>{t.label}</NativeSelectOption>)}
                </NativeSelect>
                <Input aria-label="Description" value={typeof spec.description === "string" ? spec.description : ""} readOnly={!canEdit} placeholder="What it is, e.g. The order number (#1234)" onChange={(e) => setSpec("description", e.target.value)} />
                <label className="agent-param-required small">
                  <Checkbox checked={spec.required !== false} disabled={!canEdit} onCheckedChange={(on) => setSpec("required", on ? "" : false)} />
                  Required
                </label>
                {canEdit && (
                  <Button variant="ghost" size="icon-sm" aria-label={`Remove ${key}`} onClick={() => edit({ op: "set", path: ["input", key], value: "" })}>
                    <TrashIcon />
                  </Button>
                )}
              </div>
            );
          })}
          {canEdit && (
            <Button variant="ghost" size="sm" className="agent-textlist-add" onClick={() => edit({ op: "set", path: ["input", freshName("detail", Object.keys(input))], value: { type: "string", description: "" } })}>
              <PlusIcon /> Add a detail
            </Button>
          )}
        </div>
      </Field>
      <TryAction cfg={cfg} canEdit={canEdit} path={path} name={name} />
      {(runFrom.length > 0 || data.widget_done !== undefined || data.widget_failed !== undefined) && <CardLines str={str} set={set} canEdit={canEdit} runFrom={runFrom} />}
      <Advanced title="More options" defaultOpen={Boolean(data.headers || data.query || data.pages || data.widget)}>
        <Field label="Headers" hint={<>Sent with the request. For your key, write <code>{"{secrets.NAME}"}</code> and add it under Keys (or your developer sets the Worker secret <code>JUN_SECRET_NAME</code>). To act as the signed-in customer with their own key, write <code>{"{user.secrets.NAME}"}</code>: it comes from the <code>secrets</code> claim of their identity token.</>}>
          <Pairs value={isRecord(data.headers) ? data.headers : {}} path={["headers"]} edit={edit} canEdit={canEdit} keyPlaceholder="Authorization" valuePlaceholder="Bearer {secrets.API_KEY}" />
        </Field>
        <Field label="Query parameters" hint="Added to the address after the ?.">
          <Pairs value={isRecord(data.query) ? data.query : {}} path={["query"]} edit={edit} canEdit={canEdit} keyPlaceholder="email" valuePlaceholder="{email}" />
        </Field>
        <Field label="Only on these pages" hint="Offer this action only while the customer is on these pages of your site. Leave empty for everywhere.">
          <TextList values={Array.isArray(data.pages) ? (data.pages as unknown[]).map(String) : []} onChange={(next) => set("pages", next)} placeholder="/billing or /orders/*" label="Page" addLabel="Add a page" disabled={!canEdit} />
        </Field>
        <Field label="Show the result as a widget" htmlFor="act-widget">
          <NativeSelect id="act-widget" value={str("widget")} disabled={!canEdit} onChange={(e) => set("widget", e.target.value)}>
            <NativeSelectOption value="">No widget (the AI describes it)</NativeSelectOption>
            {widgets.map((w) => <NativeSelectOption key={w} value={w}>{humanize(w)}</NativeSelectOption>)}
          </NativeSelect>
        </Field>
        {!(runFrom.length > 0 || data.widget_done !== undefined || data.widget_failed !== undefined) && <CardLines str={str} set={set} canEdit={canEdit} runFrom={runFrom} />}
      </Advanced>
      {codeOnly.length > 0 && <p className="muted small">This action also has settings only shown in Code ({codeOnly.join(", ")}). They stay as they are.</p>}
      <Problems issues={cfg.issuesFor(path)} />
    </div>
  );
}

/**
 * W-27: what a widget's card says after its button ran this action (`widget_done` / `widget_failed`):
 * one line each, `{{ name }}` for what the customer entered (and, when it worked, the result's fields).
 */
function CardLines({ str, set, canEdit, runFrom }: { str: (key: string) => string; set: (key: string, value: unknown) => void; canEdit: boolean; runFrom: string[] }) {
  const from = runFrom.length ? `Buttons in ${runFrom.map(humanize).join(", ")} run this action.` : "For when a widget's button runs this action.";
  return (
    <>
      <Field
        label="When a widget's button runs it, the widget says"
        hint={<>{from} The widget folds to this line and the AI doesn't need to answer. <code>{"{{ name }}"}</code> puts in what the customer typed in the field called name. Leave empty to let the AI answer.</>}
        htmlFor="act-done"
      >
        <Input id="act-done" value={str("widget_done")} readOnly={!canEdit} maxLength={200} placeholder="e.g. Thanks {{ name }}, we'll call you today." onChange={(e) => set("widget_done", e.target.value)} />
      </Field>
      <Field label="If it fails, the widget says" hint="The widget stays open with this line, so they can fix a field and try again. Leave empty to let the AI explain." htmlFor="act-failed">
        <Input id="act-failed" value={str("widget_failed")} readOnly={!canEdit} maxLength={200} placeholder="e.g. That didn't go through. Please try again." onChange={(e) => set("widget_failed", e.target.value)} />
      </Field>
    </>
  );
}

/** Name → value rows (headers, query parameters). */
function Pairs({ value, path, edit, canEdit, keyPlaceholder, valuePlaceholder }: {
  value: Data;
  path: string[];
  edit: (...edits: Edit[]) => void;
  canEdit: boolean;
  keyPlaceholder: string;
  valuePlaceholder: string;
}) {
  return (
    <div className="agent-params">
      {Object.entries(value).map(([key, v], i) => (
        <div className="agent-pair" key={i}>
          <Input className="mono" aria-label="Name" value={key} readOnly={!canEdit} spellCheck={false} placeholder={keyPlaceholder} onChange={(e) => edit({ op: "rename", path, from: key, to: e.target.value })} />
          <Input className="mono" aria-label="Value" value={String(v ?? "")} readOnly={!canEdit} spellCheck={false} placeholder={valuePlaceholder} onChange={(e) => edit({ op: "set", path: [...path, key], value: e.target.value, keep: true })} />
          {canEdit && (
            <Button variant="ghost" size="icon-sm" aria-label={`Remove ${key}`} onClick={() => edit({ op: "set", path: [...path, key], value: "" })}>
              <TrashIcon />
            </Button>
          )}
        </div>
      ))}
      {canEdit && (
        <Button variant="ghost" size="sm" className="agent-textlist-add" onClick={() => edit({ op: "set", path: [...path, freshName(keyPlaceholder, Object.keys(value))], value: valuePlaceholder })}>
          <PlusIcon /> Add
        </Button>
      )}
    </div>
  );
}
