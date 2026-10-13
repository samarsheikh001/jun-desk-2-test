import { useEffect, useRef, useState, type ReactNode } from "react";
import { actionSummary, checkInput, type ActionParam, type MessageAction } from "../../shared/actions.ts";

// AI-21: the card under an AI answer that proposed a page action (D-40), shown only while the
// action waits on the visitor: it asks for whatever the model left out (fields drawn from the
// action's params: a short list becomes buttons, a date a date picker, an email an email field),
// then shows what will happen with a Confirm button. Once it runs, the answer's steps list shows
// it like a YAML tool (answer.tsx), with the result and Undo. The action itself runs on the host
// page (widget-actions.js); this card only talks to it through WidgetApp.

/** An `auto` action proposed longer ago than this isn't run by itself (a reload, not a live reply). */
export const AUTO_RUN_WITHIN_MS = 30_000;
/** Up to this many choices are buttons; more become a select. */
const CHIP_LIMIT = 6;

const label = (name: string) => name.replace(/[_-]+/g, " ").replace(/([a-z])([A-Z])/g, "$1 $2").toLowerCase();

function Field({ name, param, value, onChange }: { name: string; param: ActionParam; value: unknown; onChange: (v: unknown) => void }) {
  const id = `act-${name}`;
  const text = `${label(name)}${param.description ? ` · ${param.description}` : ""}`;
  if (param.type === "boolean") {
    return (
      <div className="w-act-field" role="group" aria-label={text}>
        <span className="w-act-label">{text}</span>
        <div className="w-act-chips">
          {[true, false].map((v) => (
            <button key={String(v)} type="button" className={`w-act-chip${value === v ? " on" : ""}`} aria-pressed={value === v} onClick={() => onChange(v)}>{v ? "Yes" : "No"}</button>
          ))}
        </div>
      </div>
    );
  }
  if (param.enum && param.enum.length <= CHIP_LIMIT) {
    return (
      <div className="w-act-field" role="group" aria-label={text}>
        <span className="w-act-label">{text}</span>
        <div className="w-act-chips">
          {param.enum.map((v) => (
            <button key={String(v)} type="button" className={`w-act-chip${value === v ? " on" : ""}`} aria-pressed={value === v} onClick={() => onChange(v)}>{String(v)}</button>
          ))}
        </div>
      </div>
    );
  }
  if (param.enum) {
    return (
      <label className="w-act-field" htmlFor={id}>
        <span className="w-act-label">{text}</span>
        <select id={id} value={value === undefined ? "" : String(value)} onChange={(e) => onChange(param.type === "string" ? e.target.value : Number(e.target.value))}>
          <option value="" disabled>Choose…</option>
          {param.enum.map((v) => <option key={String(v)} value={String(v)}>{String(v)}</option>)}
        </select>
      </label>
    );
  }
  const numeric = param.type === "number" || param.type === "integer";
  const type = numeric ? "number" : param.format === "email" ? "email" : param.format === "date" ? "date" : param.format === "url" ? "url" : "text";
  return (
    <label className="w-act-field" htmlFor={id}>
      <span className="w-act-label">{text}</span>
      <input
        id={id}
        type={type}
        value={value === undefined ? "" : String(value)}
        {...(numeric ? { min: param.minimum, max: param.maximum, step: param.type === "integer" ? 1 : "any", inputMode: "numeric" as const } : {})}
        onChange={(e) => onChange(e.target.value)}
      />
    </label>
  );
}

export function ActionCard({
  action,
  latest,
  createdAt,
  onInput,
  onRun,
  onCancel,
}: {
  action: MessageAction;
  /** The newest thing in the thread: only then does an `auto` action start by itself. */
  latest: boolean;
  createdAt: number;
  /** The visitor's answers for the missing params (the server checks them and updates the card). */
  onInput: (input: Record<string, unknown>) => void;
  /** Run it on the page with these inputs. */
  onRun: (input: Record<string, unknown>) => void;
  onCancel: () => void;
}) {
  const [values, setValues] = useState<Record<string, unknown>>({});
  const ran = useRef(false);
  const pending = action.status === "pending";
  const needs = pending && action.missing.length > 0;
  const ready = pending && !needs;

  const run = () => {
    if (ran.current) return;
    ran.current = true;
    onRun(action.input);
  };
  // An action the owner marked safe runs as soon as the reply proposes it, once, and only live.
  const autoNow = ready && action.risk === "auto" && latest && Date.now() - createdAt < AUTO_RUN_WITHIN_MS;
  useEffect(() => {
    if (autoNow) run();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [autoNow]);
  let body: ReactNode;
  if (needs) {
    const check = checkInput(action, { ...action.input, ...values });
    const filled = action.missing.every((k) => k in check.input);
    const errors = Object.entries(check.errors).filter(([k]) => k in values);
    body = (
      <form
        className="w-act-form"
        onSubmit={(e) => {
          e.preventDefault();
          if (filled) onInput(check.input);
        }}
      >
        <p className="w-act-head">A couple of details first</p>
        {action.missing.map((k) => {
          const param = action.params[k];
          return param ? <Field key={k} name={k} param={param} value={values[k]} onChange={(v) => setValues((s) => ({ ...s, [k]: v }))} /> : null;
        })}
        {errors.length > 0 && <p className="w-act-error" role="alert">{errors.map(([k, e]) => `${label(k)} ${e}`).join(". ")}.</p>}
        <div className="w-act-row">
          <button type="submit" className="w-act-btn" disabled={!filled}>Continue</button>
          <button type="button" className="w-act-ghost" onClick={onCancel}>Cancel</button>
        </div>
      </form>
    );
  } else if (ready) {
    body = (
      <>
        {/* D-77: what it does in its own words; what it'll use, small under it. */}
        <p className="w-act-summary">{action.description}</p>
        {actionSummary({ description: "", input: action.input }) && <p className="w-act-inputs">{actionSummary({ description: "", input: action.input }).replace(/^ · /, "").replace(/^(\w)/, (c) => c.toUpperCase())}</p>}
        <div className="w-act-row">
          <button type="button" className="w-act-btn" onClick={run}>{action.risk === "auto" ? "Run" : "Confirm"}</button>
          <button type="button" className="w-act-ghost" onClick={onCancel}>Cancel</button>
        </div>
      </>
    );
  } else {
    return null; // ran, or ended: the answer's steps list tells the story
  }

  return (
    <div className="w-act" data-run={action.runId}>
      {needs && <p className="w-act-title">{action.description}</p>}
      {body}
    </div>
  );
}
