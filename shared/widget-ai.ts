// W-22: edit a widget by chatting (the Agent page's widget editor). The admin asks for a change in
// plain words; the model rewrites the widget's template (and, when the change needs it, its sample
// data and summary line); the result is checked like any widget before it reaches the draft.
// Nothing is saved here: the change lands in the admin's unsaved draft. Pure: prompt, parsing,
// applying the change to the file. The Worker side is worker/ai/widget-edit.ts.

import { jinjaNames } from "./jinja.ts";
import { checkData, keepDescriptions, schemaFromSample, type JsonSchema } from "./widget-schema.ts";

/** Turns of the chat sent back with each request (the latest last). */
export const MAX_EDIT_HISTORY = 12;
export const MAX_EDIT_MESSAGE = 2000;

export interface WidgetEditTurn {
  role: "user" | "assistant";
  text: string;
}

export interface WidgetEdit {
  /** One or two sentences for the admin: what changed. */
  reply: string;
  template: string;
  /** New sample data, when the change needs fields the old sample lacks. */
  sample?: Record<string, unknown>;
  /** A new summary line template ("" removes it), when the change asks for it. */
  summary?: string;
  /** W-30: a new JSON Schema of the data (the widget's parameters), when the change asks for it. */
  schema?: JsonSchema;
}

/**
 * The system prompt: ChatKit Studio's own guide for agents that write widgets (`guide`, the Worker
 * passes worker/ai/chatkit-authoring.ts), then how this desk differs from it and the answer's
 * shape, last so they win where the two disagree. The guide writes widgets in Studio's JSX-like
 * syntax; our files hold the same tree as a Jinja template that renders JSON.
 */
export function widgetEditPrompt(guide: string): string {
  const names = jinjaNames();
  return `You edit one chat widget for a customer support desk. Its widgets use OpenAI's ChatKit widget format, and the admin asks you for one change at a time.

Below is ChatKit's own guide to writing widgets. Follow it for design (small, compact, the complexity budget), the components, their props and values, and the common mistakes. After it come the rules for this desk, which win where the two differ.

=== ChatKit's widget guide ===

${guide}

=== End of ChatKit's guide ===

# How this desk stores a widget (this overrides the guide)

You don't write JSX, and you don't write a zod schema. The widget file holds:
- a template: a Jinja template that renders the component tree as JSON;
- sample: example data in the shape of the action's JSON response, used for the preview;
- optionally jsonSchema: the guide's schema as JSON Schema (its zod schema, converted): the widget's parameters, with a "description" for each field that isn't obvious. The AI and actions fill the card in this shape;
- optionally summary: a one-line plain-text Jinja template from the same data.

Write each JSX element as a JSON object with "type" and its props; child elements go in "children" (a list). Everything else carries over: the same component names ("Table.Row", "ListViewItem"…), props, values and defaults. For example:
- <Text value="Hello" size="sm" /> → {"type": "Text", "value": "Hello", "size": "sm"}
- <Row gap={2}><Icon name="mail" /><Spacer /></Row> → {"type": "Row", "gap": 2, "children": [{"type": "Icon", "name": "mail"}, {"type": "Spacer"}]}
- value={invoice.number} → "value": {{ (invoice.number) | tojson }} (always | tojson, never inside quotes)
- label={\`Pay \${amount}\`} → "label": {{ ("Pay " ~ amount) | tojson }}
- background={item.isNew ? "none" : "surface-secondary"} → "background": {{ ("none" if item.isNew else "surface-secondary") | tojson }}
- {items.map((item) => (<ListViewItem key={item.id}>…</ListViewItem>))} → {% for item in items %}{"type": "ListViewItem", "key": {{ (item.id) | tojson }}, …}{% if not loop.last %},{% endif %}{% endfor %}
- {note && <Caption value={note} />} after another child → {% if note %},{"type": "Caption", "value": {{ (note) | tojson }}}{% endif %} (the comma goes inside the condition)
- Props whose value is an object or list stay JSON: "confirm": {"label": "Add", "action": {"type": "calendar.add"}}, "padding": {"x": 3, "y": 2}.
Data that may be missing must not break the template: {% if field is defined %} or | default(...). Indent the template's JSON so people can read it.

The template engine is a small Jinja, not full Jinja. It has: {{ … }}; {% if %} / {% elif %} / {% else %}; {% for x in list %} (with loop.index, loop.index0, loop.first, loop.last, loop.length, and {% else %} for an empty list); {% set name = … %}; ~ to join text; + - * / // % **; == != < > <= >= in; and / or / not; x if cond else y; list[0], list[1:3], obj.field, obj["field"]; "is" tests. Filters, only these: ${names.filters.join(", ")}. Tests, only these: ${names.tests.join(", ")}. Nothing else: no macros, no include or import, no Python methods (.items(), .get(), .format()), no custom functions. For example, the total of open invoices is {{ (invoices | selectattr("status", "equalto", "open") | sum(attribute="total")) | tojson }}.

# Actions in this desk

An action is {"type": …, "payload": {…}}. "tool:<action name>" (e.g. "tool:add_seats") runs one of the desk's actions (listed with their inputs in the request) with the card's field values and the payload: each input is filled from the field (or payload key) with exactly its name, so name the fields after the inputs, and give every required input a field or a payload value; "page:<website action name>" (e.g. "page:remove_from_cart") runs one of the actions on the customer's own website (listed in the request when the desk has seen them), filled the same way, in the customer's browser; "open_url" with payload {"url": "https://…"} opens a link; "dismiss" folds the card on the customer's side (a "Done" or "Close" button; nothing is sent); any other type is sent to the support AI as the customer's choice; add "handler": "client" to send it to the website instead. Keep the actions and field names a widget already has unless the admin asks to change them: the desk's actions depend on them.

# Images

You have no web search here. Use an image only if its https URL is already in the widget or the sample data, or the admin gives one. Never make up image URLs.

# Your change

- Make exactly the change asked for and keep everything else as it is.
- If the change needs data the sample doesn't have, add just that to the sample with realistic values; keep the sample's other values exactly as they are.
- If the request isn't about this widget or can't be done with these components, leave the template unchanged and say why in the reply.

Answer in exactly this shape, nothing before or after:
<reply>One or two short sentences for the admin: what you changed.</reply>
<template>
the whole new template
</template>
<sample>
the whole sample data as JSON (only if you changed it; else leave this tag out)
</sample>
<summary>a new one-line summary template (only if asked; else leave this tag out)</summary>
<schema>
the whole JSON Schema of the data (only if the widget has one and you changed the data's shape, or the admin asks about its parameters; keep the existing descriptions; else leave this tag out)
</schema>`;
}

/** The user message: the current widget, the chat so far, the request, and a failed attempt's error. */
export function widgetEditInput(input: {
  name: string;
  template: string;
  sample: unknown;
  summary: string | null;
  /** W-30: the widget's own JSON Schema, when it has one. */
  schema?: JsonSchema;
  /** W-27: the desk's actions, described (`describeActions`), for `tool:<name>` buttons. */
  actions?: string;
  /** W-32: the website actions the desk has seen, for `page:<name>` buttons. */
  siteActions?: string;
  history: WidgetEditTurn[];
  message: string;
  error?: { template: string; message: string };
}): string {
  const parts = [
    `Widget: ${input.name}`,
    `Current template:\n<template>\n${input.template}\n</template>`,
    `Current sample data:\n<sample>\n${input.sample === undefined ? "{}" : JSON.stringify(input.sample, null, 2)}\n</sample>`,
    input.summary ? `Current summary line template: ${input.summary}` : "",
    input.schema ? `Current data schema (the widget's parameters):\n<schema>\n${JSON.stringify(input.schema, null, 2)}\n</schema>` : "",
    input.actions ? `The desk's actions:
${input.actions}` : "",
    input.siteActions ? `The website's own actions (for "page:<name>" buttons):
${input.siteActions}` : "",
  ];
  const history = input.history.slice(-MAX_EDIT_HISTORY);
  if (history.length) parts.push(`Earlier in this chat:\n${history.map((t) => `${t.role === "user" ? "Admin" : "You"}: ${t.text}`).join("\n")}`);
  parts.push(`The admin asks: ${input.message}`);
  if (input.error) {
    parts.push(`Your last answer didn't work. Its template was:\n<template>\n${input.error.template}\n</template>\nError: ${input.error.message}\nFix that and answer again in the same shape.`);
  }
  return parts.filter(Boolean).join("\n\n");
}

const tag = (text: string, name: string): string | null => {
  const match = new RegExp(`<${name}>([\\s\\S]*?)</${name}>`).exec(text);
  return match ? match[1]!.replace(/^\n+|\s+$/g, "") : null;
};

/** The model's answer, or null when it has no template. Throws when its sample isn't a JSON object. */
export function parseWidgetEdit(text: string): WidgetEdit | null {
  // Some models wrap the whole answer in a code fence.
  const body = text.replace(/^\s*```[a-z]*\n?|```\s*$/g, "");
  const template = tag(body, "template");
  if (!template?.trim()) return null;
  const reply = (tag(body, "reply") ?? "").replace(/\s+/g, " ").trim().slice(0, 400) || "Done.";
  const out: WidgetEdit = { reply, template: template.replace(/^```[a-z]*\n|\n```$/g, "") };
  const sample = tag(body, "sample");
  if (sample?.trim()) {
    const parsed = JSON.parse(sample.replace(/^```[a-z]*\n|\n```$/g, "")) as unknown;
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) throw new Error("sample must be a JSON object.");
    out.sample = parsed as Record<string, unknown>;
  }
  const summary = tag(body, "summary");
  if (summary !== null) out.summary = summary.replace(/\s+/g, " ").trim();
  const schema = tag(body, "schema");
  if (schema?.trim()) {
    const parsed = JSON.parse(schema.replace(/^```[a-z]*\n|\n```$/g, "")) as unknown;
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) throw new Error("schema must be a JSON Schema object.");
    out.schema = parsed as JsonSchema;
  }
  return out;
}

/** The widget file with the edit applied: its other keys (version, name, ChatKit Studio's) kept, in order. */
export function applyWidgetEdit(fileText: string, edit: Pick<WidgetEdit, "template" | "sample" | "summary" | "schema">): string {
  const file = JSON.parse(fileText) as Record<string, unknown>;
  file.template = edit.template;
  if (edit.sample) file.sample = edit.sample;
  // W-30: a schema the model wrote wins; new example data that no longer fits the file's schema
  // gets one worked out from it, keeping the descriptions of parameters that are still there.
  const old = typeof file.jsonSchema === "object" && file.jsonSchema !== null && !Array.isArray(file.jsonSchema) ? (file.jsonSchema as JsonSchema) : null;
  if (edit.schema) file.jsonSchema = edit.schema;
  else if (edit.sample && old && old.properties && checkData(old, edit.sample).length) file.jsonSchema = keepDescriptions(schemaFromSample(edit.sample), old);
  if (edit.summary !== undefined) {
    if (edit.summary) file.summary = edit.summary;
    else delete file.summary;
  }
  return `${JSON.stringify(file, null, 2)}\n`;
}

/**
 * A template as people read it: the JSON indented, Jinja tags and strings left exactly as they
 * are. Only whitespace outside strings and tags changes, so it renders the same tree.
 */
export function formatTemplate(source: string): string {
  let out = "";
  let depth = 0;
  let i = 0;
  const pad = () => "\n" + "  ".repeat(Math.max(0, depth));
  const nextSolid = (from: number) => {
    let j = from;
    while (j < source.length && /\s/.test(source[j]!)) j++;
    return source[j];
  };
  while (i < source.length) {
    const c = source[i]!;
    const two = source.slice(i, i + 2);
    // Jinja: {{ … }}, {% … %}, {# … #} as written.
    if (two === "{{" || two === "{%" || two === "{#") {
      const close = two === "{{" ? "}}" : two === "{%" ? "%}" : "#}";
      const end = source.indexOf(close, i + 2);
      const stop = end === -1 ? source.length : end + 2;
      out += source.slice(i, stop);
      i = stop;
      continue;
    }
    if (c === '"') {
      let j = i + 1;
      while (j < source.length && source[j] !== '"') j += source[j] === "\\" ? 2 : 1;
      out += source.slice(i, j + 1);
      i = j + 1;
      continue;
    }
    if (/\s/.test(c)) {
      i++;
      continue;
    }
    if (c === "{" || c === "[") {
      const closer = c === "{" ? "}" : "]";
      if (nextSolid(i + 1) === closer) {
        out += c + closer;
        i = source.indexOf(closer, i + 1) + 1;
        continue;
      }
      depth++;
      out += c + pad();
    } else if (c === "}" || c === "]") {
      depth--;
      out = out.replace(/[ \t]+$/, "");
      out += (out.endsWith("\n") ? "  ".repeat(Math.max(0, depth)) : pad()) + c;
    } else if (c === ",") {
      out += "," + pad();
    } else if (c === ":") {
      out += ": ";
    } else {
      out += c;
    }
    i++;
  }
  return out.trim();
}
