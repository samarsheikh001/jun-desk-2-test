// W-30: a widget's parameters, as ChatKit Studio keeps them: a JSON Schema of the data its template
// draws (Studio writes its zod Schema tab to the download as `jsonSchema`). A widget without one
// gets one worked out from its example data (`sample`, Studio's Default state). The schema is what
// the AI fills a card in (`show_widget`), what example data and states are checked against, and the
// Parameters list on the Agent page (descriptions there are the schema's own `description`s).
// Pure; a subset of JSON Schema: type (or a list of types), properties, required, items, enum,
// const, anyOf / oneOf, description. Extra fields in the data are allowed (Studio writes
// `additionalProperties: false`, but a card simply ignores what it doesn't draw).

export type JsonSchema = Record<string, unknown>;

const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);

/** A schema for this example data: every field required, lists typed from their first item, numbers as numbers. */
export function schemaFromSample(value: unknown): JsonSchema {
  if (Array.isArray(value)) return value.length ? { type: "array", items: schemaFromSample(value[0]) } : { type: "array" };
  if (isRecord(value)) {
    const properties = Object.fromEntries(Object.entries(value).map(([k, v]) => [k, schemaFromSample(v)]));
    return { type: "object", properties, required: Object.keys(value) };
  }
  if (value === null) return { type: "null" };
  // Any number, as Studio's z.number(): an example's 22 doesn't mean 22.5 is wrong.
  return { type: typeof value };
}

function kindOf(value: unknown): string {
  if (value === null) return "null";
  if (Array.isArray(value)) return "array";
  return typeof value;
}

function fits(types: string[], value: unknown): boolean {
  const kind = kindOf(value);
  return types.includes(kind) || (kind === "number" && types.includes("integer") && Number.isInteger(value));
}

const MAX_PROBLEMS = 8;

function check(schema: unknown, value: unknown, path: string, out: string[]): void {
  if (out.length >= MAX_PROBLEMS || !isRecord(schema)) return;
  const where = path || "the data";
  const options = Array.isArray(schema.anyOf) ? schema.anyOf : Array.isArray(schema.oneOf) ? schema.oneOf : null;
  if (options) {
    if (!options.some((o) => checkData(o as JsonSchema, value).length === 0)) out.push(`${where} doesn't match any of its allowed shapes`);
    return;
  }
  if ("const" in schema && JSON.stringify(schema.const) !== JSON.stringify(value)) {
    out.push(`${where} must be ${JSON.stringify(schema.const)}`);
    return;
  }
  if (Array.isArray(schema.enum) && !schema.enum.some((e) => JSON.stringify(e) === JSON.stringify(value))) {
    out.push(`${where} must be one of ${schema.enum.map((e) => JSON.stringify(e)).join(", ")}`);
    return;
  }
  const types = typeof schema.type === "string" ? [schema.type] : Array.isArray(schema.type) ? schema.type.filter((t): t is string => typeof t === "string") : [];
  if (types.length && !fits(types, value)) {
    out.push(`${where} should be ${types.join(" or ")}, not ${kindOf(value)}`);
    return;
  }
  if (isRecord(value)) {
    for (const key of Array.isArray(schema.required) ? schema.required : []) {
      if (typeof key === "string" && !(key in value)) out.push(`${path ? `${path}.` : ""}${key} is missing`);
    }
    if (isRecord(schema.properties)) {
      for (const [key, sub] of Object.entries(schema.properties)) if (key in value) check(sub, value[key], path ? `${path}.${key}` : key, out);
    }
  } else if (Array.isArray(value) && schema.items !== undefined) {
    value.slice(0, 50).forEach((item, i) => check(schema.items, item, `${path}[${i}]`, out));
  }
}

/** What doesn't fit the schema ("departure.city is missing"), at most a few; [] when it fits. */
export function checkData(schema: JsonSchema, data: unknown): string[] {
  const out: string[] = [];
  check(schema, data, "", out);
  return out;
}

export interface WidgetParam {
  /** "departure.city", "stats[].label". */
  path: string;
  type: string;
  required: boolean;
  description?: string;
}

function typeLabel(schema: JsonSchema): string {
  const options = Array.isArray(schema.anyOf) ? schema.anyOf : Array.isArray(schema.oneOf) ? schema.oneOf : null;
  if (options) return [...new Set(options.filter(isRecord).map(typeLabel))].join(" or ");
  if (Array.isArray(schema.enum)) return `one of ${schema.enum.map((e) => JSON.stringify(e)).join(", ")}`;
  if ("const" in schema) return JSON.stringify(schema.const);
  const type = Array.isArray(schema.type) ? schema.type.join(" or ") : typeof schema.type === "string" ? schema.type : "any";
  if (type === "array") return isRecord(schema.items) ? `list of ${isRecord(schema.items) && schema.items.type === "object" ? "items" : typeLabel(schema.items)}` : "list";
  return type === "integer" ? "whole number" : type === "object" ? "group" : type;
}

/** The object schema inside an optional (anyOf with null) or a list, for walking into it. */
function inner(schema: JsonSchema): JsonSchema {
  const options = Array.isArray(schema.anyOf) ? schema.anyOf : Array.isArray(schema.oneOf) ? schema.oneOf : null;
  if (options) return (options.find((o) => isRecord(o) && o.type !== "null") as JsonSchema | undefined) ?? schema;
  return schema;
}

/** Every parameter, nested ones by their path, in the schema's order. */
export function schemaParams(schema: JsonSchema, prefix = ""): WidgetParam[] {
  const out: WidgetParam[] = [];
  const s = inner(schema);
  if (!isRecord(s.properties)) return out;
  const required = Array.isArray(s.required) ? s.required : [];
  for (const [key, raw] of Object.entries(s.properties)) {
    if (!isRecord(raw)) continue;
    const path = `${prefix}${key}`;
    out.push({ path, type: typeLabel(raw), required: required.includes(key), ...(typeof raw.description === "string" && raw.description ? { description: raw.description } : {}) });
    const sub = inner(raw);
    if (sub.type === "object") out.push(...schemaParams(sub, `${path}.`));
    else if (sub.type === "array" && isRecord(sub.items) && inner(sub.items).type === "object") out.push(...schemaParams(sub.items, `${path}[].`));
  }
  return out;
}

/** The schema of one parameter by its path (a copy is changed in place by the caller), or null. */
function at(schema: JsonSchema, path: string): JsonSchema | null {
  let node: JsonSchema = schema;
  for (const part of path.split(".")) {
    const list = part.endsWith("[]");
    const key = list ? part.slice(0, -2) : part;
    const props = inner(node).properties;
    if (!isRecord(props) || !isRecord(props[key])) return null;
    node = props[key] as JsonSchema;
    if (list) {
      const items = inner(node).items;
      if (!isRecord(items)) return null;
      node = items;
    }
  }
  return node;
}

/** The schema with one parameter's description set ("" removes it). */
export function withDescription(schema: JsonSchema, path: string, description: string): JsonSchema {
  const copy = structuredClone(schema);
  const node = at(copy, path);
  if (!node) return schema;
  if (description.trim()) node.description = description;
  else delete node.description;
  return copy;
}

/** A new schema keeping the old one's descriptions where the same parameter is still there. */
export function keepDescriptions(next: JsonSchema, old: JsonSchema | null | undefined): JsonSchema {
  if (!old) return next;
  let out = next;
  for (const p of schemaParams(old)) if (p.description) out = withDescription(out, p.path, p.description);
  if (typeof old.description === "string" && !("description" in out)) out = { ...out, description: old.description };
  return out;
}

/** The schema with one parameter required or optional (its parent object's `required` list). */
export function withRequired(schema: JsonSchema, path: string, required: boolean): JsonSchema {
  const copy = structuredClone(schema);
  const dot = path.lastIndexOf(".");
  const parent = dot < 0 ? copy : at(copy, path.slice(0, dot));
  const key = dot < 0 ? path : path.slice(dot + 1);
  if (!parent) return schema;
  const target = inner(parent);
  if (!isRecord(target.properties) || !(key in target.properties)) return schema;
  const list = (Array.isArray(target.required) ? target.required : []).filter((k) => k !== key);
  if (required) list.push(key);
  // Keep the properties' order in the list, as Studio writes it.
  target.required = Object.keys(target.properties).filter((k) => list.includes(k));
  return copy;
}
