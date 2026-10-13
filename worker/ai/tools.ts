import { jsonSchema, tool, type ToolSet } from "ai";
import type { AiStep } from "../../shared/protocol.ts";
import { renderWidget, SHOW_WIDGET_TOOL, summaryFor, WIDGET_SHOWN_NOTE, widgetSchema, type MessageWidget, type WidgetSpec } from "../../shared/widgets.ts";
import { checkData } from "../../shared/widget-schema.ts";
import { scrubValues } from "../lib/scrub.ts";
import { DEFAULT_TOOL_STATUS, fillTemplate, type ToolSpec, type ToolUser } from "./config.ts";

// HTTP tools (AI-05): each tools/<name>.yaml becomes a tool the model can call.
// Every call is reported through onAction for the audit log (AI-11).

export const TOOL_TIMEOUT_MS = 10_000;
/** What the model sees of a response, at most. */
export const MAX_TOOL_OUTPUT = 4000;

export interface ToolAction {
  tool: string;
  input: Record<string, unknown>;
  output: string;
  status: "ok" | "error";
  httpStatus: number | null;
  durationMs: number;
  /** W-09: the widget the result was shown as, or why it couldn't be. */
  widget?: { name: string; error?: string };
  /** AI-29: a test chat answered it without calling anything (a change, in its safe mode). */
  pretended?: true;
}

/** What the model reads after a result the customer sees as a card. */
export { WIDGET_SHOWN_NOTE };

export interface ToolRunOptions {
  /** Worker env vars JUN_SECRET_<NAME>. */
  secrets: (name: string) => string | undefined;
  /** Use each tool's `mock:` response instead of calling it (evals). */
  mock?: boolean;
  /**
   * AI-29: a test chat's safe mode: calls this returns true for (changes) aren't made; they answer
   * with the action's `mock`, else its widget's example data with the inputs, else `{"ok": true}`.
   */
  pretend?: (spec: ToolSpec) => boolean;
  fetch?: typeof fetch;
  onAction?: (action: ToolAction) => void;
  /**
   * What the visitor may see of each call: the tool's `status:` label, running then done (also
   * when it failed). Never its name, inputs, output or errors. Live chats only; evals leave it out.
   */
  onStep?: (step: AiStep) => void;
  /** The verified customer for {user.*}; null when they aren't signed in. */
  user?: ToolUser | null;
  /** W-09: the config's widgets, for tools with `widget:`. */
  widgets?: WidgetSpec[];
  /** W-09: a tool's result became a card for the customer (also on its step, for live chats). */
  onWidget?: (widget: MessageWidget) => void;
}

export function secretsFromEnv(env: object): (name: string) => string | undefined {
  const vars = env as Record<string, unknown>;
  return (name) => {
    const value = vars[`JUN_SECRET_${name}`];
    return typeof value === "string" ? value : undefined;
  };
}

function inputSchema(spec: ToolSpec) {
  const properties: Record<string, Record<string, unknown>> = {};
  for (const [name, input] of Object.entries(spec.input)) {
    properties[name] = {
      type: input.type,
      ...(input.description ? { description: input.description } : {}),
      ...(input.enum ? { enum: input.enum } : {}),
    };
  }
  const required = Object.entries(spec.input).filter(([, i]) => i.required).map(([n]) => n);
  return jsonSchema<Record<string, unknown>>({ type: "object", properties, required, additionalProperties: false });
}

function fillDeep(value: unknown, input: Record<string, unknown>, secrets: ToolRunOptions["secrets"], user: ToolUser | null): unknown {
  if (typeof value === "string") {
    // A value that is exactly "{param}" keeps the input's type (numbers stay numbers).
    const whole = /^\{([a-zA-Z_][a-zA-Z0-9_]*)\}$/.exec(value);
    if (whole?.[1] && whole[1] in input) return input[whole[1]];
    return fillTemplate(value, input, secrets, undefined, user);
  }
  if (Array.isArray(value)) return value.map((v) => fillDeep(v, input, secrets, user));
  if (value && typeof value === "object") return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, fillDeep(v, input, secrets, user)]));
  return value;
}

/** Builds the request for a call. Exported for tests. */
export function buildRequest(spec: ToolSpec, input: Record<string, unknown>, secrets: ToolRunOptions["secrets"], user: ToolUser | null = null): Request {
  const url = new URL(fillTemplate(spec.url, input, secrets, encodeURIComponent, user));
  for (const [key, template] of Object.entries(spec.query)) {
    const value = fillTemplate(template, input, secrets, undefined, user);
    if (value !== "") url.searchParams.set(key, value);
  }
  const headers = new Headers({ accept: "application/json", "user-agent": "JunDesk-Agent/1" });
  for (const [key, template] of Object.entries(spec.headers)) headers.set(key, fillTemplate(template, input, secrets, undefined, user));
  let body: string | undefined;
  if (spec.method === "POST") {
    body = JSON.stringify(spec.body === undefined ? input : fillDeep(spec.body, input, secrets, user));
    if (!headers.has("content-type")) headers.set("content-type", "application/json");
  }
  return new Request(url, { method: spec.method, headers, ...(body !== undefined ? { body } : {}) });
}

/** Shortens a response for the model: picked fields, then a hard length cap. Exported for tests. */
export function shapeOutput(text: string, pick?: string[]): string {
  let out = text;
  if (pick?.length) {
    try {
      const json = JSON.parse(text) as unknown;
      if (json && typeof json === "object" && !Array.isArray(json)) {
        out = JSON.stringify(Object.fromEntries(pick.filter((k) => k in json).map((k) => [k, (json as Record<string, unknown>)[k]])));
      }
    } catch {
      // not JSON: keep the text
    }
  }
  return out.length > MAX_TOOL_OUTPUT ? `${out.slice(0, MAX_TOOL_OUTPUT)}… (truncated)` : out;
}

/** A call's outcome, plus the whole response for a widget (the model gets the shortened `output`). */
type ToolCall = ToolAction & { raw?: string };

async function callTool(spec: ToolSpec, input: Record<string, unknown>, options: ToolRunOptions): Promise<ToolCall> {
  const started = Date.now();
  const action = (status: ToolAction["status"], output: string, httpStatus: number | null, raw?: string): ToolCall => ({
    tool: spec.name,
    input,
    output,
    status,
    httpStatus,
    durationMs: Date.now() - started,
    ...(raw !== undefined ? { raw } : {}),
  });
  if (options.mock) {
    if (spec.mock === undefined) return action("error", "No mock response defined for this tool.", null);
    const mock = typeof spec.mock === "string" ? spec.mock : JSON.stringify(spec.mock);
    return action("ok", shapeOutput(mock, spec.pick), null, mock);
  }
  if (options.pretend?.(spec)) {
    const sample = options.widgets?.find((w) => w.name === spec.widget)?.sample;
    const raw = spec.mock !== undefined ? (typeof spec.mock === "string" ? spec.mock : JSON.stringify(spec.mock)) : JSON.stringify(sample ? { ...sample, ...input } : { ok: true });
    return { ...action("ok", shapeOutput(raw, spec.pick), null, raw), pretended: true };
  }
  // W-28: no address: the action only shows its widget, from the widget's example data and the AI's inputs.
  if (!spec.url) {
    const sample = options.widgets?.find((w) => w.name === spec.widget)?.sample ?? {};
    const raw = JSON.stringify({ ...sample, ...input });
    return action("ok", shapeOutput(raw, spec.pick), null, raw);
  }
  // AI-24: every key this request carries, so an API that echoes one back never gets it shown or kept.
  const used = new Set<string>(Object.values(options.user?.secrets ?? {}));
  const secrets = (name: string) => {
    const value = options.secrets(name);
    if (value) used.add(value);
    return value;
  };
  let request: Request;
  try {
    request = buildRequest(spec, input, secrets, options.user ?? null);
  } catch (error) {
    return action("error", (error as Error).message, null);
  }
  try {
    const response = await (options.fetch ?? fetch)(request, { signal: AbortSignal.timeout(TOOL_TIMEOUT_MS) });
    const text = scrubValues(await response.text(), used);
    const output = shapeOutput(text || `(empty response, HTTP ${response.status})`, response.ok ? spec.pick : undefined);
    return action(response.ok ? "ok" : "error", output, response.status, response.ok ? text : undefined);
  } catch (error) {
    const timedOut = (error as Error).name === "TimeoutError";
    return action("error", timedOut ? `No response within ${TOOL_TIMEOUT_MS / 1000} s.` : `Request failed: ${(error as Error).message}`, null);
  }
}

/**
 * W-09: a successful result as the tool's widget. The whole JSON response fills the template (the
 * model gets the `pick`ed, shortened output); a result that doesn't fit the widget is shown as text
 * only, and the audit log says why.
 */
function showWidget(spec: ToolSpec, call: ToolCall, options: ToolRunOptions, id: string): MessageWidget | null {
  if (!spec.widget || call.status !== "ok" || call.raw === undefined) return null;
  const widget = options.widgets?.find((w) => w.name === spec.widget);
  try {
    if (!widget) throw new Error(`no widgets/${spec.widget}.widget`);
    let data: unknown;
    try {
      data = JSON.parse(call.raw);
    } catch {
      throw new Error("the response isn't JSON");
    }
    const root = renderWidget(widget, data);
    call.widget = { name: widget.name };
    // D-47: the file's own one-line summary, if it has one (a failing summary only drops the line).
    return { id: `w${id.slice(1)}`, name: widget.name, root, ...summaryFor(widget, data) };
  } catch (error) {
    call.widget = { name: spec.widget, error: (error as Error).message };
    console.warn(`[ai] widget ${spec.widget} for ${spec.name}: ${(error as Error).message}`);
    return null;
  }
}

/**
 * W-17: runs a tool for a card's `tool:<name>` button, outside the model's loop (the press is the
 * visitor's confirmation). Same request, secrets, identity, audit and widget as a model call.
 */
export async function runTool(spec: ToolSpec, input: Record<string, unknown>, options: ToolRunOptions, widgetId: string): Promise<{ action: ToolAction; widget: MessageWidget | null; result?: unknown }> {
  const missing = Object.entries(spec.input).filter(([name, i]) => i.required && input[name] === undefined).map(([name]) => name);
  if (missing.length) {
    return { action: { tool: spec.name, input, output: `Missing input: ${missing.join(", ")}.`, status: "error", httpStatus: null, durationMs: 0 }, widget: null };
  }
  const call = await callTool(spec, input, options);
  const widget = showWidget(spec, call, options, widgetId);
  const { raw, ...action } = call;
  // W-27: the whole JSON response, for an action's widget_done / widget_failed line.
  let result: unknown;
  try {
    result = raw === undefined ? undefined : JSON.parse(raw);
  } catch {
    result = undefined;
  }
  return { action, widget: widget ? { ...widget, id: widgetId } : null, ...(result !== undefined ? { result } : {}) };
}

/** W-29: what the visitor sees while the AI puts a card together. */
export const SHOW_WIDGET_STATUS = "Putting that together";
/** How much of a widget's schema and example data the tool's description shows the model, each. */
const MAX_EXAMPLE = 1500;
const cut = (text: string) => (text.length > MAX_EXAMPLE ? `${text.slice(0, MAX_EXAMPLE)}…` : text);

/**
 * W-29: `show_widget`, the AI's own tool for the widgets marked `aiFill`: it fills a card with data it
 * has from the chat, the knowledge or tool results. Nothing is called; the data must draw the card
 * (else the model gets the error and can try again). Shown and recorded like a tool's card.
 */
export function showWidgetTool(widgets: WidgetSpec[], options: Pick<ToolRunOptions, "onAction" | "onStep" | "onWidget">) {
  // W-30: each card's parameters (its JSON Schema, with the admin's descriptions) and an example.
  const cards = widgets.map((w) => `- ${w.name} (${w.title}): data schema ${cut(JSON.stringify(widgetSchema(w) ?? {}))}; example: ${cut(JSON.stringify(w.sample ?? {}))}`).join("\n");
  let calls = 0;
  return tool({
    description: `Show the customer a card you fill in yourself, when a card shows something better than text. Fill it only with what you know from this conversation, the knowledge sources and tool results: never make up account details (amounts, dates, order, payment or plan status). The cards:\n${cards}`,
    inputSchema: jsonSchema<{ widget: string; data: string }>({
      type: "object",
      properties: {
        widget: { type: "string", enum: widgets.map((w) => w.name), description: "Which card." },
        data: { type: "string", description: "The card's data as a JSON object, in that card's shape." },
      },
      required: ["widget", "data"],
      additionalProperties: false,
    }),
    execute: async ({ widget: name, data: text }) => {
      const id = `sv${++calls}`;
      const started = Date.now();
      options.onStep?.({ id, label: SHOW_WIDGET_STATUS, state: "running" });
      const spec = widgets.find((w) => w.name === name);
      let card: MessageWidget | null = null;
      let data: unknown;
      let error = "";
      try {
        if (!spec) throw new Error(`there's no card called ${String(name)}`);
        data = typeof text === "string" ? (JSON.parse(text) as unknown) : text;
        if (typeof data !== "object" || data === null || Array.isArray(data)) throw new Error("data must be a JSON object");
        const schema = widgetSchema(spec);
        const problems = schema ? checkData(schema, data) : [];
        if (problems.length) throw new Error(`it doesn't fit the card's schema: ${problems.join("; ")}`);
        card = { id: `wv${calls}`, name: spec.name, root: renderWidget(spec, data), ...summaryFor(spec, data) };
      } catch (e) {
        error = (e as Error).message;
      } finally {
        options.onStep?.({ id, label: SHOW_WIDGET_STATUS, state: "done", ...(card ? { widget: card } : {}) });
      }
      options.onAction?.({
        tool: SHOW_WIDGET_TOOL,
        input: { widget: name, ...(data !== undefined ? { data } : {}) },
        output: card ? "shown" : error,
        status: card ? "ok" : "error",
        httpStatus: null,
        durationMs: Date.now() - started,
        widget: card ? { name: card.name } : { name: String(name), error },
      });
      if (!card) return `ERROR: the card didn't draw with that data (${error}). Fix the data to the card's shape and call again, or answer in text.`;
      options.onWidget?.(card);
      return WIDGET_SHOWN_NOTE;
    },
  });
}

/** AI SDK tools for a config's HTTP tools. Failed calls return an error the model can explain. */
export function httpTools(specs: ToolSpec[], options: ToolRunOptions): ToolSet {
  const tools: ToolSet = {};
  let calls = 0;
  for (const spec of specs) {
    const label = spec.status ?? DEFAULT_TOOL_STATUS;
    tools[spec.name] = tool({
      description: spec.description,
      inputSchema: inputSchema(spec),
      execute: async (input: Record<string, unknown>) => {
        // An opaque id per call: the model's toolCallId or the tool name would tell the visitor more.
        const id = `s${++calls}`;
        options.onStep?.({ id, label, state: "running" });
        let call: ToolCall | undefined;
        let widget: MessageWidget | null = null;
        try {
          call = await callTool(spec, input, options);
          widget = showWidget(spec, call, options, id);
        } finally {
          // The card travels with the finished step, so it shows as soon as the call is done.
          options.onStep?.({ id, label, state: "done", ...(widget ? { widget } : {}) });
        }
        if (widget) options.onWidget?.(widget);
        const { raw: _raw, ...action } = call;
        options.onAction?.(action);
        if (action.status !== "ok") return `ERROR${action.httpStatus ? ` (HTTP ${action.httpStatus})` : ""}: ${action.output}`;
        return widget ? `${action.output}\n\n${WIDGET_SHOWN_NOTE}` : action.output;
      },
    });
  }
  return tools;
}
