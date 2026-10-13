import { useMemo, useState } from "react";
import { api } from "../api.ts";
import { cardFromResult, customerRefs, exampleData, exampleInputs, typedInput, type RequestExample } from "../../shared/action-try.ts";
import { parseWidgetFile, renderWidget, widgetSchema, type WidgetNode } from "../../shared/widgets.ts";
import { checkData } from "../../shared/widget-schema.ts";
import { editYaml, readYaml } from "../lib/agentFiles.ts";
import { Button } from "@/components/ui/button.tsx";
import { Input } from "@/components/ui/input.tsx";
import { NativeSelect, NativeSelectOption } from "@/components/ui/native-select.tsx";
import { WidgetCard } from "../widget/chatkit/WidgetCard.tsx";
import { go, humanize, slug } from "./parts.tsx";
import type { AgentConfig } from "./useAgentConfig.ts";

// AI-25: "Try it" on an action's page. The admin types the details, the desk calls the draft's version
// of the action once for real (…/agent/try-action, keys and all) and shows what came back. A JSON
// answer then becomes the card: the action's widget gets it as its example data, or a first card is
// drawn from it (cardFromResult) and kept with one click. No sample or schema written by hand.

interface TryResult {
  status: "ok" | "error";
  httpStatus: number | null;
  durationMs: number;
  output: string;
  result?: unknown;
  tooBig?: boolean;
}

type Data = Record<string, unknown>;
const isRecord = (v: unknown): v is Data => typeof v === "object" && v !== null && !Array.isArray(v);

/** What was typed and what came back, per action, so leaving the page and coming back keeps them. */
/** AI-26: the request an action was made from (a curl command), so Try it starts with its values. */
export const actionExamples = new Map<string, RequestExample>();

const remembered = new Map<string, { values: Record<string, string>; customer: Record<string, string>; result: TryResult | null }>();

const pageTheme = () => (document.documentElement.dataset.theme === "dark" ? "dark" : "light");

/** A widget file with `sample` replaced (other keys keep their order). */
function withSample(text: string, sample: Data): string {
  const file = JSON.parse(text) as Data;
  file.sample = sample;
  return `${JSON.stringify(file, null, 2)}\n`;
}

/** The card drawn with this data, or why it can't be. */
function draw(name: string, text: string, data: Data): { root: WidgetNode; problems: string[] } | { error: string } {
  try {
    const spec = parseWidgetFile(name, text);
    const schema = widgetSchema(spec);
    return { root: renderWidget(spec, data), problems: schema ? checkData(schema, data) : [] };
  } catch (error) {
    return { error: (error as Error).message };
  }
}

/** `compact`: inside a task's list of what it uses (no heading of its own). */
export function TryAction({ cfg, canEdit, path, name, compact = false }: { cfg: AgentConfig; canEdit: boolean; path: string; name: string; compact?: boolean }) {
  const text = cfg.draft[path] ?? "";
  const data = readYaml(text);
  const saved = remembered.get(path);
  const [values, setValues] = useState<Record<string, string>>(saved?.values ?? {});
  const [customer, setCustomer] = useState<Record<string, string>>(saved?.customer ?? {});
  const [result, setResult] = useState<TryResult | null>(saved?.result ?? null);
  const [running, setRunning] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const keep = (next: Partial<{ values: Record<string, string>; customer: Record<string, string>; result: TryResult | null }>) =>
    remembered.set(path, { values, customer, result, ...remembered.get(path), ...next });

  const input = isRecord(data) && isRecord(data.input) ? data.input : {};
  const types = Object.fromEntries(Object.entries(input).map(([k, v]) => [k, String(isRecord(v) ? (v.type ?? "string") : (v ?? "string"))]));
  const refs = useMemo(() => customerRefs([text]), [text]);
  // AI-26: the values from the command the action was made from, until something is typed.
  const example = actionExamples.get(path);
  const fromExample = example && isRecord(data) && typeof data.url === "string" ? exampleInputs({ url: data.url, query: isRecord(data.query) ? data.query : {}, body: data.body }, example) : {};
  const shown: Record<string, string> = { ...fromExample, ...values };
  const method = isRecord(data) && typeof data.method === "string" ? data.method.toUpperCase() : "GET";
  const changes = method === "POST" && isRecord(data) && typeof data.url === "string" && data.url.trim() !== "";

  const run = async () => {
    setRunning(true);
    setError(null);
    try {
      const fields: Data = { attributes: {}, secrets: {} };
      for (const ref of refs) {
        const value = customer[ref]?.trim();
        if (!value) continue;
        if (ref.startsWith("secrets.")) (fields.secrets as Data)[ref.slice(8)] = value;
        else if (["id", "email", "name"].includes(ref)) fields[ref] = value;
        else (fields.attributes as Data)[ref] = value;
      }
      const body = { files: cfg.draft, name, input: typedInput(shown, types), ...(refs.length ? { customer: fields } : {}) };
      const next = await api<TryResult>(`${cfg.base}/try-action`, { body });
      setResult(next);
      keep({ result: next });
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setRunning(false);
    }
  };

  return (
    <section className="agent-try" data-compact={compact || undefined} aria-label={`Try ${name}`}>
      {!compact && <h3>Try it</h3>}
      <p className="muted small">
        Run it once with real details and see what your system sends back.{" "}
        {changes ? <strong>This makes a real change in your system.</strong> : "Nothing changes: it's a look-up."} Uses the draft, so you can try before saving.
      </p>
      {(Object.keys(input).length > 0 || refs.length > 0) && (
        <div className="agent-try-fields">
          {Object.keys(input).map((key) => (
            <label key={key} className="agent-try-field">
              <span>{humanize(key)}</span>
              {types[key] === "boolean" ? (
                <NativeSelect size="sm" value={shown[key] ?? ""} onChange={(e) => { const v = { ...shown, [key]: e.target.value }; setValues(v); keep({ values: v }); }}>
                  <NativeSelectOption value="">(leave out)</NativeSelectOption>
                  <NativeSelectOption value="true">Yes</NativeSelectOption>
                  <NativeSelectOption value="false">No</NativeSelectOption>
                </NativeSelect>
              ) : (
                <Input
                  value={shown[key] ?? ""}
                  inputMode={types[key] === "number" || types[key] === "integer" ? "decimal" : undefined}
                  placeholder={isRecord(input[key]) && typeof (input[key] as Data).description === "string" ? String((input[key] as Data).description) : ""}
                  onChange={(e) => { const v = { ...shown, [key]: e.target.value }; setValues(v); keep({ values: v }); }}
                />
              )}
            </label>
          ))}
          {refs.map((ref) => (
            <label key={`user.${ref}`} className="agent-try-field">
              <span>Customer's {ref.startsWith("secrets.") ? `key ${ref.slice(8)}` : humanize(ref).toLowerCase()}</span>
              <Input
                value={customer[ref] ?? ""}
                type={ref.startsWith("secrets.") ? "password" : "text"}
                autoComplete="off"
                placeholder="A test customer's"
                onChange={(e) => { const v = { ...customer, [ref]: e.target.value }; setCustomer(v); keep({ customer: v }); }}
              />
            </label>
          ))}
        </div>
      )}
      <div>
        <Button size="sm" disabled={running} onClick={run}>
          {running ? "Running…" : changes ? "Run it for real" : "Try it"}
        </Button>
      </div>
      {error && <p className="error small" role="alert">{error}</p>}
      {result && <TryOutcome cfg={cfg} canEdit={canEdit} path={path} name={name} result={result} />}
    </section>
  );
}

function TryOutcome({ cfg, canEdit, path, name, result }: { cfg: AgentConfig; canEdit: boolean; path: string; name: string; result: TryResult }) {
  const text = cfg.draft[path] ?? "";
  const data = readYaml(text);
  const widget = isRecord(data) && typeof data.widget === "string" && data.widget ? data.widget : null;
  const widgetPath = widget ? `widgets/${widget}.widget` : null;
  const json = result.result !== undefined;
  const sample = json ? exampleData(result.result) : null;
  const shown = json ? JSON.stringify(result.result, null, 2) : result.output;
  const facts = [result.httpStatus ? `HTTP ${result.httpStatus}` : null, `${result.durationMs} ms`].filter(Boolean).join(" · ");

  // The card: the action's own widget with this data, else a first card drawn from it.
  const own = widget && widgetPath && sample && cfg.draft[widgetPath] !== undefined ? draw(widget, cfg.draft[widgetPath]!, sample) : null;
  const fresh = !widget && result.status === "ok" && json ? cardFromResult(humanize(name), result.result) : null;
  const freshCard = fresh && sample ? draw(name, fresh, sample) : null;
  const sameSample = useMemo(() => {
    if (!widgetPath || !sample) return false;
    try {
      return JSON.stringify((JSON.parse(cfg.draft[widgetPath] ?? "") as Data).sample) === JSON.stringify(sample);
    } catch {
      return false;
    }
  }, [cfg.draft, widgetPath, sample]);

  const keepCard = () => {
    if (!fresh) return;
    const base = slug(name, "_") || "card";
    let card = base;
    for (let n = 2; `widgets/${card}.widget` in cfg.draft; n++) card = `${base}_${n}`;
    cfg.setFile(`widgets/${card}.widget`, fresh);
    cfg.setFile(path, editYaml(text, { op: "set", path: ["widget"], value: card }));
  };

  return (
    <div className="agent-try-result">
      <p className="agent-try-status" data-ok={result.status === "ok" || undefined}>
        <strong>{result.status === "ok" ? "It worked" : "It didn't work"}</strong> <span className="muted">{facts}</span>
      </p>
      <pre className="agent-try-out">{shown}</pre>
      {result.tooBig && <p className="muted small">The answer is too big to show here or use as a widget's example. The AI gets its first 4,000 characters.</p>}
      {result.status === "ok" && json && (
        <div className="agent-try-card">
          {own && "root" in own ? (
            <>
              <p className="small">
                Shown to the customer as <a href={`/agent/widgets/${widget}`} onClick={(e) => { e.preventDefault(); go(`/agent/widgets/${widget}`); }}>{humanize(widget!)}</a>:
              </p>
              <div className="agent-try-preview"><WidgetCard widget={{ id: `try-${name}`, name: widget!, root: own.root }} interactive={false} theme={pageTheme()} /></div>
              {own.problems.length > 0 ? (
                <p className="muted small">It doesn't match the widget's parameters ({own.problems.slice(0, 2).join("; ")}), so it can't be its example data. Ask the card's AI to fit it to this answer.</p>
              ) : (
                canEdit && (
                  <Button size="sm" variant="secondary" className="agent-try-use" disabled={sameSample} onClick={() => widgetPath && cfg.setFile(widgetPath, withSample(cfg.draft[widgetPath]!, sample!))}>
                    {sameSample ? "This is the widget's example data" : "Use as the widget's example data"}
                  </Button>
                )
              )}
            </>
          ) : own && "error" in own ? (
            <p className="muted small">Its widget ({humanize(widget!)}) can't draw this answer: {own.error}</p>
          ) : freshCard && "root" in freshCard ? (
            <>
              <p className="small">Show it to the customer as a widget, like this:</p>
              <div className="agent-try-preview"><WidgetCard widget={{ id: `try-${name}`, name, root: freshCard.root }} interactive={false} theme={pageTheme()} /></div>
              {canEdit && (
                <div className="agent-try-actions">
                  <Button size="sm" onClick={keepCard}>Show it as this widget</Button>
                  <span className="muted small">You can restyle it after, with the widget's AI. Without one, the AI describes the answer in words.</span>
                </div>
              )}
            </>
          ) : null}
        </div>
      )}
    </div>
  );
}
