// W-09 (D-43): ChatKit-compatible widgets. A widget is a small card the AI shows in the chat,
// built from a tool's result: `widgets/<name>.widget` (exported from ChatKit Studio, or written
// by hand) holds a Jinja template that renders to the widget's JSON tree, and a tool with
// `widget: <name>` fills it with its response. The format is OpenAI's ChatKit widget format
// (component names and props per openai/chatkit-python `chatkit/widgets.py` and openai/chatkit-js
// `widgets.d.ts`, both Apache-2.0); the template runs in our own interpreter (shared/jinja.ts) and
// the tree is drawn by our own renderer (web/widget/chatkit/). Pure: Worker, widget and tests.

import { compileTemplate, TemplateError, type Template } from "./jinja.ts";
import { checkData, schemaFromSample, type JsonSchema } from "./widget-schema.ts";

/** Every component the renderer knows. Anything else makes the widget invalid. */
export const WIDGET_COMPONENTS = new Set([
  "Basic", "Card", "ListView", "ListViewItem",
  "Box", "Row", "Col", "Form", "Spacer", "Divider", "Transition",
  "Table", "Table.Row", "Table.Cell",
  "Text", "Title", "Caption", "Markdown", "Label", "Badge", "Icon", "Image", "Chart",
  "Button", "Input", "Textarea", "Select", "DatePicker", "Checkbox", "RadioGroup",
]);
const ROOTS = new Set(["Basic", "Card", "ListView"]);
/** Components that hold a value the visitor enters (sent with a form's action under `name`). */
const FIELDS = new Set(["Input", "Textarea", "Select", "DatePicker", "Checkbox", "RadioGroup"]);

export const MAX_WIDGET_NODES = 400;
export const MAX_WIDGET_DEPTH = 24;
export const MAX_WIDGET_JSON = 48 * 1024;
const MAX_STRING = 4000;
/** D-47: a `summary` template's length, and the rendered line's. */
export const MAX_SUMMARY_TEMPLATE = 200;
export const MAX_SUMMARY = 80;
/** Values the visitor sends with an action: fields, and characters per field. */
export const MAX_ACTION_VALUES = 30;
export const MAX_ACTION_VALUE = 2000;

export class WidgetError extends Error {}

/** What the model reads after a result it was shown as a card. */
export const WIDGET_SHOWN_NOTE = "(The customer already sees this result in the chat, laid out as a card. Don't repeat its details and don't mention the card; answer their question in a short sentence and add only what helps.)";
/** W-31: website actions one widget may show, and a name's length (as the loader sends it). */
export const MAX_WIDGET_PAGE_ACTIONS = 10;
export const MAX_PAGE_ACTION_NAME = 64;

/** One node of a widget tree: `type` plus its props (and `children`). Loose by design: unknown props are ignored. */
export interface WidgetNode {
  type: string;
  children?: WidgetNode[];
  [prop: string]: unknown;
}

/** What a button, list item, form or card confirm/cancel sends: ChatKit's ActionConfig. */
export interface WidgetActionConfig {
  type: string;
  payload?: unknown;
  /**
   * ChatKit: "client" hands the action to the host page (the loader's `widgetAction` event), never
   * to the server; "server" (the default) sends it. Read only in the browser.
   */
  handler?: "server" | "client";
  /** ChatKit: what shows as busy while it's sent ("auto": the pressed control; a card's confirm: the card). */
  loadingBehavior?: "auto" | "none" | "self" | "container";
}

/** ChatKit's `handler: "client"`: the action goes to the host page, never to the server. */
export function isClientAction(value: unknown): boolean {
  return isRecord(value) && value.handler === "client";
}

/** A widget the AI showed (in `meta.widgets` of its message, and live on the tool's step). */
export interface MessageWidget {
  /** Opaque per message, for actions (`w<n>`). */
  id: string;
  /** The widget file's name (`widgets/<name>.widget`); agents see it, the AI's history too. */
  name: string;
  root: WidgetNode;
  /**
   * D-47: the file's own one-line summary (its `summary` template rendered with the same data;
   * plain text, ≤ 80 chars). The island's folded pill shows it before guessing with `widgetSummary`.
   */
  summary?: string;
  /** Set once the visitor used one of the card's own actions (confirm, a form, a button outside a list): it takes no more. */
  used?: { label: string; at: number };
  /** W-17: list items used one by one (by item id, `i<n>`): only that row is done, the rest still work. */
  items?: Record<string, { label: string; at: number }>;
}

/** W-17: `tool:<name>` on a button runs that tool at once (the press is the visitor's yes); the AI then answers. */
export const TOOL_ACTION = /^tool:([a-z][a-z0-9_]*)$/;
/**
 * W-32: `page:<name>` on a button runs a website action (a WebMCP tool on the customer's page) with
 * the button's payload and the card's fields, offered like one the AI chose (confirm per its risk).
 */
export const PAGE_ACTION_BUTTON = /^page:([\w.-]{1,64})$/;
/** W-17: `open_url` with `payload.url` opens an https link (checkout, invoice); handled in the browser, never sent. */
export const OPEN_URL = "open_url";

/** W-27: `dismiss` folds the card on the visitor's side (our own type, like `open_url`); never sent. */
export const DISMISS = "dismiss";

/** The https URL an `open_url` action opens, or null. */
export function actionUrl(action: WidgetActionConfig): string | null {
  if (action.type !== OPEN_URL || !isRecord(action.payload) || typeof action.payload.url !== "string") return null;
  return /^https:\/\/[^\s]+$/i.test(action.payload.url) ? action.payload.url : null;
}

/** On the visitor message an action sends (its body is the action's label). */
export interface WidgetActionMeta {
  widgetId: string;
  widget: string;
  type: string;
  payload?: unknown;
  /** What the visitor entered in the card's fields, by field name. */
  values?: Record<string, string | boolean>;
  /** W-17: the list item it was pressed in (only that row is used). */
  item?: string;
  /**
   * W-17: a `tool:<name>` action ran that tool. `output` is never stored here (meta reaches the
   * visitor): the Conversation object keeps it for the AI's history, agents see it in the audit log.
   * `done` (W-27): the action's `widget_done` line, which answered the press (on the card and under
   * the press), so the AI takes no turn for it. It's what the visitor sees anyway.
   */
  tool?: { name: string; status: "ok" | "error"; output?: string; done?: string };
}

/** A parsed `widgets/<name>.widget`. */
export interface WidgetSpec {
  name: string;
  /** The widget's own title in the file ("Order status"). */
  title: string;
  template: Template;
  /** D-47: optional `summary`, a Jinja template for one plain-text line ("{{ high }} · {{ city }}"). */
  summary?: Template;
  /** The data the widget was designed with (ChatKit Studio's default state), when the file has it. */
  sample?: Record<string, unknown>;
  /** W-29 (ours, `"aiFill": true`): the AI may show this card with data it fills in itself (`show_widget`). */
  aiFill?: boolean;
  /** W-30: the data's JSON Schema (ChatKit Studio's `jsonSchema`), when the file has one. */
  schema?: JsonSchema;
  /** W-30: more named examples (ChatKit Studio's states; ours: `states: [{ name, data }]`). */
  states?: { name: string; data: Record<string, unknown> }[];
  /** W-31 (ours, `"pageActions": ["get_cart"]`): website actions whose result this card shows. */
  pageActions?: string[];
}

/**
 * W-30: the example data and every named state must fit the widget's schema (when it has its own)
 * and draw the card. Throws WidgetError naming which one and why.
 */
export function checkExamples(spec: WidgetSpec): void {
  const examples = [...(spec.sample ? [{ label: "Example data", data: spec.sample }] : []), ...(spec.states ?? []).map((s) => ({ label: `State "${s.name}"`, data: s.data }))];
  for (const { label, data } of examples) {
    const problems = spec.schema ? checkData(spec.schema, data) : [];
    if (problems.length) throw new WidgetError(`${label} doesn't fit the schema: ${problems.join("; ")}.`);
    try {
      renderWidget(spec, data);
    } catch (error) {
      throw new WidgetError(`${label}: ${(error as Error).message}`);
    }
  }
}

/** W-30: at most this many named states per widget. */
export const MAX_WIDGET_STATES = 10;

/** W-30: a widget's parameters: its own schema, else one worked out from its example data. */
export function widgetSchema(spec: Pick<WidgetSpec, "schema" | "sample">): JsonSchema | null {
  return spec.schema ?? (spec.sample ? schemaFromSample(spec.sample) : null);
}

/** W-29: the AI's built-in tool that shows a card it fills in itself (only widgets with `aiFill`). */
export const SHOW_WIDGET_TOOL = "show_widget";



function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Where ChatKit Studio serves the images its own examples use ("/kpop.png"). */
export const STUDIO_ORIGIN = "https://widgets.chatkit.studio";
const STUDIO_IMAGE = /^\/(?!\/)[^\s?#]+\.(?:png|jpe?g|gif|webp|avif|svg)$/i;

/**
 * Studio's example data names its demo images by path ("/album01.png"), which Studio resolves
 * against its own site. Taken as our preview data, those paths would point at the desk: point them
 * at Studio instead. Only Studio's example data; an action's data and an admin's `sample` are as given.
 */
function studioImages(value: unknown, depth = 0): unknown {
  if (depth > 20) return value;
  if (typeof value === "string") return STUDIO_IMAGE.test(value) ? `${STUDIO_ORIGIN}${value}` : value;
  if (Array.isArray(value)) return value.map((v) => studioImages(v, depth + 1));
  if (isRecord(value)) return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, studioImages(v, depth + 1)]));
  return value;
}

/** Base64url (ChatKit Studio's `encodedWidget`) to text, in any runtime. */
function decodeBase64Url(text: string): string {
  const b64 = text.replace(/-/g, "+").replace(/_/g, "/").padEnd(Math.ceil(text.length / 4) * 4, "=");
  const bytes = Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));
  return new TextDecoder().decode(bytes);
}

/**
 * Reads a `.widget` file: `{ version: "1.0", name, template, jsonSchema, … }` (ChatKit Studio's
 * Download). Throws WidgetError with a message for the admin.
 */
export function parseWidgetFile(name: string, text: string): WidgetSpec {
  let file: unknown;
  try {
    file = JSON.parse(text);
  } catch {
    throw new WidgetError("A .widget file is JSON (download it from ChatKit Studio, or write { \"version\": \"1.0\", \"name\": …, \"template\": … }).");
  }
  if (!isRecord(file)) throw new WidgetError("A .widget file is a JSON object.");
  if (file.version !== "1.0") throw new WidgetError(`Unsupported widget version ${JSON.stringify(file.version ?? null)}: only "1.0".`);
  if (typeof file.template !== "string" || !file.template.trim()) throw new WidgetError("template is required: the widget's Jinja template.");
  let template: Template;
  try {
    template = compileTemplate(file.template);
  } catch (error) {
    throw new WidgetError(`template: ${(error as Error).message}`);
  }
  // `summary` (ours, D-47): one line for the island's folded pill, from the same data as the card.
  let summary: Template | undefined;
  if (file.summary !== undefined && file.summary !== null) {
    if (typeof file.summary !== "string") throw new WidgetError('summary is a Jinja template string, like "{{ plan }} · {{ status }}".');
    if (file.summary.length > MAX_SUMMARY_TEMPLATE) throw new WidgetError(`summary is longer than ${MAX_SUMMARY_TEMPLATE} characters.`);
    if (file.summary.trim()) {
      try {
        summary = compileTemplate(file.summary);
      } catch (error) {
        throw new WidgetError(`summary: ${(error as Error).message}`);
      }
    }
  }
  // `sample`: data to preview and check it with (ours; ChatKit ignores it). Else ChatKit Studio's default state.
  let sample: Record<string, unknown> | undefined = isRecord(file.sample) ? file.sample : undefined;
  // W-30: named states: ours (`states: [{ name, data }]`), else ChatKit Studio's (`{ name, value }`).
  const named = (list: unknown, key: "data" | "value") =>
    Array.isArray(list)
      ? list
          .filter((s): s is Record<string, unknown> => isRecord(s) && typeof s.name === "string" && isRecord(s[key]))
          .slice(0, MAX_WIDGET_STATES)
          .map((s) => ({ name: (s.name as string).trim() || "State", data: studioImages(s[key]) as Record<string, unknown> }))
      : [];
  let states = named(file.states, "data");
  // An own list, even an empty one, replaces Studio's (removing the last state in the editor).
  const ownStates = Array.isArray(file.states);
  if (typeof file.encodedWidget === "string" && (!sample || !ownStates)) {
    try {
      const studio = JSON.parse(decodeBase64Url(file.encodedWidget)) as unknown;
      if (!sample && isRecord(studio) && isRecord(studio.defaultState)) sample = studioImages(studio.defaultState) as Record<string, unknown>;
      if (!ownStates && isRecord(studio)) {
        const list = typeof studio.states === "string" ? (JSON.parse(studio.states) as unknown) : studio.states;
        states = named(list, "value");
      }
    } catch {
      // not ours to judge: the sample is only for checking
    }
  }
  // W-31: website actions (WebMCP tools on the customer's page) whose result this card shows.
  let pageActions: string[] = [];
  if (file.pageActions !== undefined && file.pageActions !== null) {
    if (!Array.isArray(file.pageActions) || file.pageActions.some((n) => typeof n !== "string" || !n.trim() || n.trim().length > MAX_PAGE_ACTION_NAME)) {
      throw new WidgetError(`pageActions is a list of website action names (each up to ${MAX_PAGE_ACTION_NAME} characters), like ["get_cart"].`);
    }
    pageActions = [...new Set((file.pageActions as string[]).map((n) => n.trim()))];
    if (pageActions.length > MAX_WIDGET_PAGE_ACTIONS) throw new WidgetError(`pageActions: at most ${MAX_WIDGET_PAGE_ACTIONS} website actions.`);
  }
  // W-30: the data's schema: Studio's `jsonSchema` (an empty one says nothing).
  const schema = isRecord(file.jsonSchema) && (isRecord(file.jsonSchema.properties) || typeof file.jsonSchema.type === "string") ? file.jsonSchema : undefined;
  return {
    name,
    title: typeof file.name === "string" && file.name.trim() ? file.name.trim() : name,
    template,
    ...(summary ? { summary } : {}),
    ...(sample ? { sample } : {}),
    ...(file.aiFill === true ? { aiFill: true } : {}),
    ...(schema ? { schema } : {}),
    ...(states.length ? { states } : {}),
    ...(pageActions.length ? { pageActions } : {}),
  };
}

/**
 * D-47: a widget's `summary` line for this data: whitespace collapsed, cut at `MAX_SUMMARY` with
 * "…"; "" when there's no summary or it renders empty (or only punctuation). Throws WidgetError when the template fails.
 */
export function renderSummary(spec: Pick<WidgetSpec, "summary">, data: unknown): string {
  if (!spec.summary) return "";
  let text: string;
  try {
    text = spec.summary.render(widgetData(data));
  } catch (error) {
    throw new WidgetError(`summary: ${(error as Error).message}`);
  }
  const line = text.replace(/\s+/g, " ").trim();
  // Only separators left (" · " with the data missing) says nothing: no line.
  if (!/[\p{L}\p{N}]/u.test(line)) return "";
  return line.length > MAX_SUMMARY ? `${line.slice(0, MAX_SUMMARY - 1).trimEnd()}…` : line;
}

/** `renderSummary` for a card being shown: a failing summary never fails the card, it's just left out. */
export function summaryFor(spec: Pick<WidgetSpec, "summary">, data: unknown): { summary?: string } {
  try {
    const summary = renderSummary(spec, data);
    return summary ? { summary } : {};
  } catch {
    return {};
  }
}

/** The summary line the dashboard's preview shows (rendered with the sample), or "". */
export function previewSummary(name: string, text: string): string {
  try {
    const spec = parseWidgetFile(name, text);
    return spec.sample ? renderSummary(spec, spec.sample) : "";
  } catch {
    return "";
  }
}

/**
 * A widget's preview: rendered from its sample data, else ChatKit Studio's own render
 * (`outputJsonPreview`). Throws WidgetError when there's nothing to show or it doesn't render.
 */
export function previewWidget(name: string, text: string): WidgetNode {
  const spec = parseWidgetFile(name, text);
  if (spec.sample) return renderWidget(spec, spec.sample);
  const file = JSON.parse(text) as Record<string, unknown>;
  const preview = typeof file.outputJsonPreview === "string" ? (JSON.parse(file.outputJsonPreview) as unknown) : file.outputJsonPreview;
  if (preview === undefined) throw new WidgetError('Add "sample": { … } (data like your tool returns) to see a preview.');
  return checkWidget(preview);
}

/** A starter widget (the dashboard's "Add widget"): a plan summary card, with sample data to preview. */
export function starterWidget(title: string): string {
  const template = [
    '{"type":"Card","size":"sm","children":[',
    '{"type":"Row","children":[{"type":"Title","value":{{ (plan) | tojson }},"size":"sm"},{"type":"Spacer"},',
    '{"type":"Badge","label":{{ (status) | tojson }},"color":{% if status == "active" %}"success"{% else %}"warning"{% endif %}}]},',
    '{"type":"Divider","flush":true},',
    '{"type":"Row","children":[{"type":"Caption","value":"Renews"},{"type":"Spacer"},{"type":"Text","value":{{ (renews_on) | tojson }},"size":"sm"}]},',
    '{"type":"Row","children":[{"type":"Caption","value":"Seats"},{"type":"Spacer"},{"type":"Text","value":{{ (seats_used ~ " of " ~ seats) | tojson }},"size":"sm"}]}',
    '{% if invoice_url is defined %},{"type":"Button","label":"View invoice","iconEnd":"external-link","onClickAction":{"type":"open_url","payload":{"url":{{ (invoice_url) | tojson }}}}}{% endif %}',
    "]}",
  ].join("");
  return `${JSON.stringify(
    {
      version: "1.0",
      name: title,
      template,
      // One line for the chat's folded pill (optional; plain text from the same data).
      summary: "{{ plan }} plan · {{ status }}",
      sample: { plan: "Pro", status: "active", renews_on: "Nov 3, 2026", seats: 10, seats_used: 7 },
    },
    null,
    2,
  )}
`;
}

const SHAPE_FIELD = /^[A-Za-z_]\w*$/;
const fieldLabel = (key: string) => {
  const words = key.replace(/([a-z0-9])([A-Z])/g, "$1 $2").replace(/_+/g, " ").trim().toLowerCase();
  return words ? words[0]!.toUpperCase() + words.slice(1) : key;
};
const typeOf = (schema: unknown): string => (isRecord(schema) && typeof schema.type === "string" ? schema.type : "");
const propsOf = (schema: unknown): [string, unknown][] =>
  isRecord(schema) && isRecord(schema.properties) ? Object.entries(schema.properties).filter(([k]) => SHAPE_FIELD.test(k)) : [];
const SCALARS = new Set(["string", "number", "integer", "boolean"]);

/** Example data in a shape (W-31): words for text, small numbers, lists of two. */
function sampleFor(schema: unknown, key: string, depth = 0): unknown {
  switch (typeOf(schema)) {
    case "object":
      return depth > 4 ? {} : Object.fromEntries(propsOf(schema).map(([k, s]) => [k, sampleFor(s, k, depth + 1)]));
    case "array": {
      const items = isRecord(schema) ? schema.items : undefined;
      return items === undefined || depth > 4 ? [] : [sampleFor(items, key, depth + 1), sampleFor(items, key, depth + 1)];
    }
    case "number":
      return 12.5;
    case "integer":
      return 3;
    case "boolean":
      return true;
    case "null":
      return null;
    default:
      return fieldLabel(key);
  }
}

/**
 * W-31: a first card for a website action's result, from its shape (`resultShape`: field names and
 * types): its title, a row per plain field (8 at most, one level into objects), and a list per list
 * of items (2 at most, each row its first two plain fields). Linked to the action (`pageActions`),
 * with example data in that shape, ready for the AI editor to restyle. AI-25: `action` null for an
 * action of the desk's own (the action's `widget:` links it), `sample` for real example data.
 */
export function cardFromShape(title: string, action: string | null, shape: Record<string, unknown>, sample?: Record<string, unknown>): string {
  const root = typeOf(shape) === "array" ? { type: "object", properties: { items: shape } } : shape;
  const value = (expr: string) => `{{ (${expr} | default("") | string) | tojson }}`;
  const row = (label: string, expr: string) =>
    `,{"type":"Row","children":[{"type":"Caption","value":${JSON.stringify(label)}},{"type":"Spacer"},{"type":"Text","value":${value(expr)},"size":"sm"}]}`;
  const rows: string[] = [];
  const lists: string[] = [];
  const summary: string[] = [];
  for (const [key, schema] of propsOf(root)) {
    const type = typeOf(schema);
    if (SCALARS.has(type)) {
      if (rows.length < 8) rows.push(row(fieldLabel(key), key));
      if (summary.length < 2 && type === "string") summary.push(`{{ ${key} }}`);
    } else if (type === "object") {
      for (const [sub, s] of propsOf(schema)) if (SCALARS.has(typeOf(s)) && rows.length < 8) rows.push(row(fieldLabel(`${key} ${sub}`), `${key}.${sub}`));
    } else if (type === "array" && lists.length < 2) {
      const items = isRecord(schema) ? schema.items : undefined;
      const head = `,{"type":"Divider","flush":true},{"type":"Caption","value":${JSON.stringify(fieldLabel(key))}}`;
      if (SCALARS.has(typeOf(items))) {
        lists.push(`${head}{% for v in ${key} %},{"type":"Text","value":${value("v")},"size":"sm"}{% endfor %}`);
      } else {
        const [a, b] = propsOf(items).filter(([, s]) => SCALARS.has(typeOf(s))).map(([k]) => k);
        if (!a) continue;
        const second = b ? `,{"type":"Spacer"},{"type":"Text","value":${value(`item.${b}`)},"size":"sm","color":"secondary"}` : "";
        lists.push(`${head}{% for item in ${key} %},{"type":"Row","children":[{"type":"Text","value":${value(`item.${a}`)},"size":"sm"}${second}]}{% endfor %}`);
      }
    }
  }
  const template = `{"type":"Card","size":"sm","children":[{"type":"Title","value":${JSON.stringify(title)},"size":"sm"}${rows.join("")}${lists.join("")}]}`;
  return `${JSON.stringify(
    {
      version: "1.0",
      name: title,
      template,
      ...(summary.length ? { summary: summary.join(" · ") } : {}),
      jsonSchema: root,
      sample: sample ?? sampleFor(root, "value"),
      ...(action ? { pageActions: [action] } : {}),
    },
    null,
    2,
  )}\n`;
}

/** A tool's result as the template's data: an object as is, a list as `items`, anything else as `value`. */
export function widgetData(result: unknown): Record<string, unknown> {
  if (isRecord(result)) return result;
  if (Array.isArray(result)) return { items: result };
  return { value: result };
}

/** W-31: how much of a website action's result (JSON) the page may send for its card. */
export const MAX_PAGE_ACTION_DATA = 32 * 1024;

/**
 * W-31: the card for a website action's result: a widget that lists the action in `pageActions`
 * (the desk's choice) wins, else the one the page named when it registered it (`widget`). Null when
 * neither names a widget the desk has.
 */
export function pageActionWidget(widgets: WidgetSpec[], name: string, declared: string | undefined): WidgetSpec | null {
  return widgets.find((w) => w.pageActions?.includes(name)) ?? (declared ? (widgets.find((w) => w.name === declared) ?? null) : null);
}

/**
 * W-31: a website action's result drawn as its card. `data` is the JSON the page sent; anything that
 * isn't JSON, is too big or doesn't draw gives `error` (for the audit log) and no card.
 */
export function pageActionCard(spec: WidgetSpec, data: unknown, id: string): { card: MessageWidget } | { error: string } {
  if (typeof data !== "string" || !data) return { error: "the page sent no data for the card (the action returned plain text)" };
  if (data.length > MAX_PAGE_ACTION_DATA) return { error: `the result is over ${MAX_PAGE_ACTION_DATA / 1024} KB` };
  let parsed: unknown;
  try {
    parsed = JSON.parse(data);
  } catch {
    return { error: "the result isn't JSON" };
  }
  if (typeof parsed !== "object" || parsed === null) return { error: "the result isn't a JSON object or list" };
  try {
    return { card: { id, name: spec.name, root: renderWidget(spec, parsed), ...summaryFor(spec, parsed) } };
  } catch (error) {
    return { error: (error as Error).message };
  }
}

/** Renders a widget with data and checks the tree. Throws WidgetError (template or tree problems). */
export function renderWidget(spec: Pick<WidgetSpec, "template">, data: unknown): WidgetNode {
  let text: string;
  try {
    text = spec.template.render(widgetData(data));
  } catch (error) {
    throw new WidgetError(error instanceof TemplateError ? `template: ${error.message}` : `template failed: ${(error as Error).message}`);
  }
  let tree: unknown;
  try {
    tree = JSON.parse(text);
  } catch {
    throw new WidgetError("The template didn't render valid JSON (a value without | tojson?).");
  }
  return checkWidget(tree);
}

/**
 * Checks a rendered tree: known components, a Card/ListView/Basic root, size limits. Drops null
 * props (the Studio writes `undefined` as null) and null children; cuts very long strings.
 */
export function checkWidget(tree: unknown): WidgetNode {
  if (JSON.stringify(tree)?.length > MAX_WIDGET_JSON) throw new WidgetError(`The widget is larger than ${MAX_WIDGET_JSON / 1024} KB.`);
  let nodes = 0;
  const clean = (value: unknown, depth: number): unknown => {
    if (typeof value === "string") return value.length > MAX_STRING ? `${value.slice(0, MAX_STRING)}…` : value;
    if (Array.isArray(value)) return value.filter((v) => v !== null && v !== undefined).map((v) => clean(v, depth));
    if (isRecord(value)) {
      if (depth > MAX_WIDGET_DEPTH) throw new WidgetError(`The widget is nested deeper than ${MAX_WIDGET_DEPTH} levels.`);
      return Object.fromEntries(Object.entries(value).filter(([, v]) => v !== null && v !== undefined).map(([k, v]) => [k, clean(v, depth + 1)]));
    }
    return value;
  };
  const node = (value: unknown, depth: number, path: string): WidgetNode => {
    if (!isRecord(value) || typeof value.type !== "string") throw new WidgetError(`${path}: every component needs a "type".`);
    if (!WIDGET_COMPONENTS.has(value.type)) throw new WidgetError(`${path}: unknown component "${value.type}".`);
    if (++nodes > MAX_WIDGET_NODES) throw new WidgetError(`The widget has more than ${MAX_WIDGET_NODES} components.`);
    if (depth > MAX_WIDGET_DEPTH) throw new WidgetError(`The widget is nested deeper than ${MAX_WIDGET_DEPTH} levels.`);
    const out: WidgetNode = { type: value.type };
    for (const [key, prop] of Object.entries(value)) {
      if (key === "type" || prop === null || prop === undefined) continue;
      if (key === "children") {
        const list = (Array.isArray(prop) ? prop : [prop]).filter((c) => c !== null && c !== undefined && c !== false);
        out.children = list.map((c, i) => node(c, depth + 1, `${path}.${value.type}[${i}]`));
      } else out[key] = clean(prop, depth + 1);
    }
    return out;
  };
  const root = node(tree, 0, "widget");
  if (!ROOTS.has(root.type)) throw new WidgetError(`The widget's root must be a Card, ListView or Basic (got ${root.type}).`);
  return root;
}

function* walk(node: WidgetNode): Generator<WidgetNode> {
  yield node;
  for (const child of node.children ?? []) yield* walk(child);
}

function actionOf(value: unknown): WidgetActionConfig | null {
  return isRecord(value) && typeof value.type === "string" && value.type.trim() ? { type: value.type, ...(value.payload !== undefined ? { payload: value.payload } : {}) } : null;
}

/**
 * W-17: an id for every ListViewItem, in tree order (`i0`, `i1`, …). The server and the renderer
 * walk the same saved tree, so they agree on which row is which.
 */
export function itemIds(root: WidgetNode): Map<WidgetNode, string> {
  const ids = new Map<WidgetNode, string>();
  for (const node of walk(root)) if (node.type === "ListViewItem") ids.set(node, `i${ids.size}`);
  return ids;
}

/** One action a widget offers: the label the visitor sees on it, and the list item it's in (if any). */
export interface OfferedAction {
  action: WidgetActionConfig;
  label: string;
  item?: string;
}

/** Every action a widget offers. Actions inside a list item belong to that item (W-17); the rest to the card. */
export function widgetActions(root: WidgetNode): OfferedAction[] {
  const out: OfferedAction[] = [];
  const ids = itemIds(root);
  const visit = (node: WidgetNode, item: string | undefined) => {
    const here = ids.get(node) ?? item;
    const at = here ? { item: here } : {};
    const click = isClientAction(node.onClickAction) ? null : actionOf(node.onClickAction);
    if (click) out.push({ action: click, label: typeof node.label === "string" && node.label ? node.label : nodeText(node) || click.type, ...at });
    const submit = isClientAction(node.onSubmitAction) ? null : actionOf(node.onSubmitAction);
    if (submit) {
      const button = [...walk(node)].find((n) => n.type === "Button" && n.submit === true && typeof n.label === "string");
      out.push({ action: submit, label: (button?.label as string | undefined) ?? "Submit", ...at });
    }
    for (const key of ["confirm", "cancel"] as const) {
      const card = node[key];
      const action = isRecord(card) && !isClientAction(card.action) ? actionOf(card.action) : null;
      if (action) out.push({ action, label: isRecord(card) && typeof card.label === "string" ? card.label : key === "confirm" ? "Confirm" : "Cancel", ...at });
    }
    for (const child of node.children ?? []) visit(child, here);
  };
  visit(root, undefined);
  return out;
}

/** AI-28: what one of a card's controls does when pressed (or changed). */
export type CardControlDoes =
  | { kind: "tool"; name: string }
  | { kind: "page"; name: string }
  | { kind: "client"; type: string }
  | { kind: "link" }
  | { kind: "dismiss" }
  | { kind: "ai"; type: string };

/**
 * AI-28: every control on a card that does something, with its label and what it does: runs an
 * action (`tool:`), runs a website action (`page:`), goes to the page's own code (`handler: "client"`),
 * opens a link, folds the card, or goes to the AI (any other type; a field's change only for `tool:`).
 * One entry per label and target.
 */
export function cardControls(root: WidgetNode): { label: string; does: CardControlDoes }[] {
  const out: { label: string; does: CardControlDoes }[] = [];
  const seen = new Set<string>();
  const add = (label: string, raw: unknown, change = false) => {
    const action = actionOf(raw);
    if (!action) return;
    const tool = TOOL_ACTION.exec(action.type)?.[1];
    const page = PAGE_ACTION_BUTTON.exec(action.type)?.[1];
    const does: CardControlDoes = isClientAction(raw)
      ? { kind: "client", type: action.type }
      : tool
        ? { kind: "tool", name: tool }
        : page
          ? { kind: "page", name: page }
          : action.type === OPEN_URL
            ? { kind: "link" }
            : action.type === DISMISS
              ? { kind: "dismiss" }
              : { kind: "ai", type: action.type };
    // A field's onChangeAction runs only for tool:<name> (D-51); anything else does nothing.
    if (change && does.kind !== "tool") return;
    const key = `${label}\u0000${JSON.stringify(does)}`;
    if (seen.has(key)) return;
    seen.add(key);
    out.push({ label, does });
  };
  for (const node of walk(root)) {
    const label = typeof node.label === "string" && node.label ? node.label : nodeText(node) || String(node.name ?? node.type);
    add(label, node.onClickAction);
    add(label, node.onChangeAction, true);
    if (node.onSubmitAction !== undefined) {
      const button = [...walk(node)].find((n) => n.type === "Button" && n.submit === true && typeof n.label === "string");
      add((button?.label as string | undefined) ?? "Submit", node.onSubmitAction);
    }
    for (const key of ["confirm", "cancel"] as const) {
      const card = node[key];
      if (isRecord(card)) add(typeof card.label === "string" ? card.label : key === "confirm" ? "Confirm" : "Cancel", card.action);
    }
  }
  return out;
}

/** The names of the fields the visitor can fill in (sent with the action). */
export function widgetFields(root: WidgetNode): Set<string> {
  const names = new Set<string>();
  for (const node of walk(root)) {
    if (FIELDS.has(node.type) && typeof node.name === "string" && node.name) names.add(node.name);
    if ((node.type === "Text" || node.type === "Title") && isRecord(node.editable) && typeof node.editable.name === "string") names.add(node.editable.name);
  }
  return names;
}

const sameJson = (a: unknown, b: unknown) => JSON.stringify(a ?? null) === JSON.stringify(b ?? null);

/**
 * Checks an action a visitor sent against the widget they saw: it must be one the widget offers
 * (same type and payload, in the list item they say), and only its own fields' values are kept.
 * Null when it isn't. `open_url` never comes here: the browser opens it.
 */
export function matchWidgetAction(
  root: WidgetNode,
  sent: unknown,
  values: unknown,
  item?: unknown,
): { label: string; action: WidgetActionConfig; values: Record<string, string | boolean>; item?: string } | null {
  const want = actionOf(sent);
  if (!want || want.type === OPEN_URL || want.type === DISMISS) return null;
  const same = widgetActions(root).filter((a) => a.action.type === want.type && sameJson(a.action.payload, want.payload));
  // The same action can sit in several rows ("Add" with the same payload): the row the visitor says, else the first.
  const hit = same.find((a) => (a.item ?? null) === (typeof item === "string" ? item : null)) ?? same[0];
  if (!hit) return null;
  return { label: hit.label.slice(0, 200), action: hit.action, values: matchValues(root, values), ...(hit.item ? { item: hit.item } : {}) };
}

/** The fields whose ChatKit `onChangeAction` can run on the server: only `tool:<name>` ones (D-51). */
const CHANGE_FIELDS = new Set(["Select", "Checkbox", "RadioGroup", "DatePicker"]);

/**
 * D-51: checks a field's `onChangeAction` a visitor's change sent. ChatKit sends it on every
 * change; here only a `tool:<name>` action does anything (the tool runs quietly and the card it
 * returns replaces this one), so only those match. `field` is the changed field's name; only the
 * card's own fields' values are kept, as for a press. Null when the card doesn't offer it.
 */
export function matchWidgetChange(
  root: WidgetNode,
  field: unknown,
  sent: unknown,
  values: unknown,
): { action: WidgetActionConfig; field: string; values: Record<string, string | boolean>; item?: string } | null {
  const want = actionOf(sent);
  if (!want || !TOOL_ACTION.test(want.type) || typeof field !== "string") return null;
  const ids = itemIds(root);
  let hit: { action: WidgetActionConfig; item?: string } | null = null;
  const visit = (node: WidgetNode, item: string | undefined) => {
    const here = ids.get(node) ?? item;
    if (!hit && CHANGE_FIELDS.has(node.type) && node.name === field && !isClientAction(node.onChangeAction)) {
      const action = actionOf(node.onChangeAction);
      if (action && action.type === want.type && sameJson(action.payload, want.payload)) hit = { action, ...(here ? { item: here } : {}) };
    }
    for (const child of node.children ?? []) visit(child, here);
  };
  visit(root, undefined);
  if (!hit) return null;
  const found = hit as { action: WidgetActionConfig; item?: string };
  const kept = matchValues(root, values);
  return { action: found.action, field, values: kept, ...(found.item ? { item: found.item } : {}) };
}

function matchValues(root: WidgetNode, values: unknown): Record<string, string | boolean> {
  const fields = widgetFields(root);
  const kept: Record<string, string | boolean> = {};
  if (isRecord(values)) {
    for (const [key, value] of Object.entries(values)) {
      if (!fields.has(key) || Object.keys(kept).length >= MAX_ACTION_VALUES) continue;
      if (typeof value === "boolean") kept[key] = value;
      else if (typeof value === "string" || typeof value === "number") kept[key] = String(value).slice(0, MAX_ACTION_VALUE);
    }
  }
  return kept;
}

/** Whether the action the visitor pressed is already used: the whole card, or (in a list) that row. */
export function widgetActionUsed(widget: MessageWidget, item: string | undefined): boolean {
  return Boolean(widget.used || (item && widget.items?.[item]));
}

/** The widget after a press: that row is used (W-17), or the whole card for its own actions. */
export function markWidgetUsed(widget: MessageWidget, label: string, item: string | undefined, at: number): MessageWidget {
  return item ? { ...widget, items: { ...widget.items, [item]: { label, at } } } : { ...widget, used: { label, at } };
}

/** W-17: a tool action's input: its payload's fields plus what was entered, only names the tool takes. */
export function toolActionInput(action: WidgetActionConfig, values: Record<string, string | boolean>, inputs: Record<string, { type: string }>): Record<string, unknown> {
  const raw: Record<string, unknown> = { ...(isRecord(action.payload) ? action.payload : {}), ...values };
  const out: Record<string, unknown> = {};
  for (const [name, spec] of Object.entries(inputs)) {
    const v = raw[name];
    if (v === undefined || v === null || v === "") continue;
    if (spec.type === "number" || spec.type === "integer") {
      const n = Number(v);
      if (Number.isFinite(n)) out[name] = spec.type === "integer" ? Math.trunc(n) : n;
    } else if (spec.type === "boolean") out[name] = v === true || v === "true" || v === "on";
    else out[name] = typeof v === "string" ? v : JSON.stringify(v);
  }
  return out;
}

/** W-27: a control that runs an action (`tool:<name>`), and which of the action's inputs a press fills. */
export interface ToolButtonInputs {
  /** The button's label, or the field's label or name for a field's `onChangeAction` (`field`). */
  label: string;
  field?: true;
  tool: string;
  /** The action's inputs a press fills: a field of the card or a key of the button's payload. */
  sends: string[];
  /** Required inputs nothing fills (the action runs without them); `like`: a field with a close name. */
  missing: { name: string; like?: string }[];
}

const loose = (s: string) => s.toLowerCase().replace(/[^a-z0-9]/g, "");

/** Edit distance, for "did you mean" (short names only). */
function distance(a: string, b: string): number {
  const row = Array.from({ length: b.length + 1 }, (_, i) => i);
  for (let i = 1; i <= a.length; i++) {
    let prev = row[0]!;
    row[0] = i;
    for (let j = 1; j <= b.length; j++) {
      const next = Math.min(row[j]! + 1, row[j - 1]! + 1, prev + (a[i - 1] === b[j - 1] ? 0 : 1));
      prev = row[j]!;
      row[j] = next;
    }
  }
  return row[b.length]!;
}

/**
 * W-27: for every control of a rendered card that runs an action, which of the action's inputs a
 * press fills. A press sends every field of the card plus the button's payload; the action keeps
 * the names it takes (toolActionInput), so a required input with no field or payload key of that
 * exact name is sent empty. `inputs(tool)` is the action's inputs, or null when there's no such action.
 */
export function toolButtonInputs(root: WidgetNode, inputs: (tool: string) => Record<string, { required: boolean }> | null): ToolButtonInputs[] {
  const fields = [...widgetFields(root)];
  const controls: { label: string; action: WidgetActionConfig; field?: true }[] = widgetActions(root).map((a) => ({ label: a.label, action: a.action }));
  for (const node of walk(root)) {
    const change = isClientAction(node.onChangeAction) ? null : actionOf(node.onChangeAction);
    if (change) controls.push({ label: typeof node.label === "string" && node.label ? node.label : String(node.name ?? node.type), action: change, field: true });
  }
  const out: ToolButtonInputs[] = [];
  const seen = new Set<string>();
  for (const { label, action, field } of controls) {
    const tool = TOOL_ACTION.exec(action.type)?.[1];
    const takes = tool ? inputs(tool) : null;
    if (!tool || !takes) continue;
    const sent = new Set([...fields, ...(isRecord(action.payload) ? Object.keys(action.payload) : [])]);
    const sends = Object.keys(takes).filter((n) => sent.has(n));
    const missing = Object.entries(takes)
      .filter(([n, spec]) => spec.required && !sent.has(n))
      .map(([name]) => {
        // A field that isn't one of the action's inputs, with nearly this name ("e_mail", "Email").
        const like = fields.find((f) => !(f in takes) && (loose(f) === loose(name) || (name.length >= 4 && distance(loose(f), loose(name)) <= 2)));
        return like ? { name, like } : { name };
      });
    // A list's rows repeat the same button: report it once.
    const key = `${label}\n${tool}\n${sends.join()}\n${missing.map((m) => m.name).join()}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({ label, tool, sends, missing, ...(field ? { field } : {}) });
  }
  return out;
}

/** W-27: the most an action's `widget_done` / `widget_failed` line shows (after rendering). */
export const MAX_ACTION_LINE = 140;

/**
 * W-27: an action's `widget_done` or `widget_failed` line for a press: a Jinja template over what
 * the visitor entered and the action's JSON result (its fields win), as one line of plain text cut
 * at MAX_ACTION_LINE. "" when it renders empty or fails: the card then behaves as without one.
 */
export function renderActionLine(template: Template, values: Record<string, unknown>, result: unknown): string {
  let text: string;
  try {
    text = template.render({ ...values, ...(result === undefined || result === null ? {} : widgetData(result)) });
  } catch {
    return "";
  }
  // A value left empty ("Sorry {{ name }}, …") leaves no stray space before the punctuation.
  const line = text.replace(/\s+/g, " ").replace(/ ([,.!?;:])/g, "$1").trim();
  if (!/[\p{L}\p{N}]/u.test(line)) return "";
  return line.length > MAX_ACTION_LINE ? `${line.slice(0, MAX_ACTION_LINE - 1).trimEnd()}…` : line;
}

/** The visible words of a node and its children, in order (for previews and labels). */
export function nodeText(node: WidgetNode, max = 400): string {
  const parts: string[] = [];
  for (const n of walk(node)) {
    for (const key of ["value", "label"] as const) {
      const v = n[key];
      if ((typeof v === "string" || typeof v === "number") && String(v).trim() && n.type !== "Input" && n.type !== "Textarea") parts.push(String(v).trim());
    }
    if (parts.join(" ").length > max) break;
  }
  const text = parts.join(" · ");
  return text.length > max ? `${text.slice(0, max - 1)}…` : text;
}

/**
 * One line for a card folded into the island's pill, like a live activity ("Team plan · active").
 * Card: its first Title (else the first semibold/bold Text; else `status.text`), then the first
 * Caption when that title is a bare number or word (≤ 4 chars: "47° · San Francisco, CA"), then the
 * first Badge; with no Badge after a status-only lead, the first Text or Caption says what it's about.
 * ListView: `status.text` (or "N items" alone) and the item count ("Invoices · 3"). Empty parts are
 * skipped, whitespace collapsed, cut at `max` with "…"; "" when nothing is left.
 */
export function widgetSummary(root: WidgetNode, max = 60): string {
  const clean = (v: unknown): string => (typeof v === "string" || typeof v === "number" ? String(v).replace(/\s+/g, " ").trim() : "");
  const status = isRecord(root.status) ? clean(root.status.text) : "";
  const nodes = [...walk(root)].slice(1);
  const first = (match: (n: WidgetNode) => boolean, key: "value" | "label" = "value"): string => {
    for (const n of nodes) if (match(n) && clean(n[key])) return clean(n[key]);
    return "";
  };
  const parts: string[] = [];
  if (root.type === "ListView") {
    const count = (root.children ?? []).filter((c) => c.type === "ListViewItem").length;
    if (status) parts.push(status, String(count));
    else if (count) parts.push(`${count} ${count === 1 ? "item" : "items"}`);
  } else {
    const title = first((n) => n.type === "Title") || first((n) => n.type === "Text" && (n.weight === "semibold" || n.weight === "bold"));
    const badge = first((n) => n.type === "Badge", "label");
    if (title) {
      parts.push(title);
      if (title.length <= 4) parts.push(first((n) => n.type === "Caption"));
      parts.push(badge);
    } else {
      parts.push(status, badge);
      if (!badge) parts.push(first((n) => n.type === "Text" || n.type === "Caption"));
    }
  }
  const seen = new Set<string>();
  const line = parts.filter((p) => p && !seen.has(p) && seen.add(p)).join(" · ");
  return line.length > max ? `${line.slice(0, Math.max(0, max - 1)).trimEnd()}…` : line;
}

/** The line the AI's history gets for an action the visitor took on a card. */
export function widgetActionLine(label: string, meta: WidgetActionMeta): string {
  const details = [`action ${meta.type}`];
  if (meta.payload !== undefined) details.push(`payload ${JSON.stringify(meta.payload)}`);
  if (meta.values && Object.keys(meta.values).length) details.push(`entered ${JSON.stringify(meta.values)}`);
  const line = `[On the ${meta.widget} card the customer pressed "${label}": ${details.join(", ")}]`;
  if (!meta.tool) return line;
  // W-17: the button ran a tool already; the AI only says what happened (and what's next).
  const output = meta.tool.output ?? "";
  const out = output.length > 1500 ? `${output.slice(0, 1500)}…` : output;
  return `${line}\n[That ran ${meta.tool.name}: ${meta.tool.status === "ok" ? "done" : "failed"}.${out ? ` Result: ${out}` : ""}]`;
}

/** The body of an AI message that only showed cards (the inbox preview; the widget hides it). */
export const WIDGET_ONLY_BODY = "Here's what I found:";

/** D-76: a widget still waiting on the visitor: unused, with a button or field that does something (not just a link or Close). */
export function widgetWaiting(widget: MessageWidget): boolean {
  if (widget.used) return false;
  return widgetActions(widget.root).some((a) => a.action.type !== OPEN_URL && a.action.type !== DISMISS && !(a.item && widget.items?.[a.item]));
}

/**
 * D-76: the island shows one open widget per exchange (the visitor's message and the replies to it):
 * the one the visitor opened from a chip, else the newest still waiting on them, else the newest.
 * Null when there's at most one (nothing to choose).
 */
export function pickOpenWidget<T extends { widget: MessageWidget }>(widgets: T[], picked: string | null): T | null {
  if (widgets.length < 2) return null;
  return widgets.find((c) => c.widget.id === picked) ?? widgets.findLast((c) => widgetWaiting(c.widget)) ?? widgets.at(-1)!;
}
