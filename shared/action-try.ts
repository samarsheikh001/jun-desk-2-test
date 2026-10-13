// AI-25: "Try it" on an action's page. The admin runs the action once for real (…/agent/try-action);
// its JSON answer becomes the card's example data, or a first card of its own. Pure; used by the
// dashboard (and tests).

import { resultShape } from "./actions.ts";
import { cardFromShape, widgetData } from "./widgets.ts";

/** Lists keep this many items in example data. */
const EXAMPLE_ITEMS = 5;
/** Text values are cut to this many characters in example data. */
const EXAMPLE_TEXT = 300;

/** A result as a card's example data: the card's data (`widgetData`), lists cut to 5 items, text to 300 characters, 6 levels. */
export function exampleData(result: unknown): Record<string, unknown> {
  const trim = (v: unknown, depth: number): unknown => {
    if (typeof v === "string") return v.length > EXAMPLE_TEXT ? `${v.slice(0, EXAMPLE_TEXT)}…` : v;
    if (Array.isArray(v)) return depth >= 6 ? [] : v.slice(0, EXAMPLE_ITEMS).map((x) => trim(x, depth + 1));
    if (typeof v === "object" && v !== null) return depth >= 6 ? {} : Object.fromEntries(Object.entries(v).map(([k, x]) => [k, trim(x, depth + 1)]));
    return v;
  };
  return trim(widgetData(result), 0) as Record<string, unknown>;
}

/** A first card for an action's result: `cardFromShape`'s layout, with the result itself as example data. Null when it isn't JSON with fields. */
export function cardFromResult(title: string, result: unknown): string | null {
  const shape = resultShape(result);
  return shape ? cardFromShape(title, null, shape, exampleData(result)) : null;
}

/** Input values typed into the form, as the action's input types (numbers, yes/no); empty ones are left out. */
export function typedInput(values: Record<string, string>, types: Record<string, string>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [name, raw] of Object.entries(values)) {
    const value = raw.trim();
    if (!value) continue;
    const type = types[name] ?? "string";
    if ((type === "number" || type === "integer") && value !== "" && Number.isFinite(Number(value))) out[name] = Number(value);
    else if (type === "boolean") out[name] = value === "true";
    else out[name] = value;
  }
  return out;
}

/** The `{user.…}` fields these texts use (`id`, `email`, `name`, an attribute, `secrets.NAME`), each once. */
export function customerRefs(texts: string[]): string[] {
  return [...new Set(texts.flatMap((t) => [...t.matchAll(/\{user\.([a-zA-Z_][a-zA-Z0-9_.]*)\}/g)].map((m) => m[1]!)))];
}

/** Where an action came from (AI-26: a curl command): its address, query and body with real values. */
export interface RequestExample {
  url: string;
  query: Record<string, string>;
  body?: unknown;
}

const NAME = /\{([a-zA-Z_][a-zA-Z0-9_.]*)\}/;

/**
 * AI-26: Try it's details, read back from the example the action was made from: the action's address
 * `https://api.acme.com/orders/{order_id}` against `https://api.acme.com/orders/1042` gives
 * `order_id: "1042"`; a query or body field that is exactly `{name}` takes the example's value.
 */
export function exampleInputs(action: { url: string; query: Record<string, unknown>; body?: unknown }, example: RequestExample): Record<string, string> {
  const out: Record<string, string> = {};
  const own = (name: string) => !name.includes(".");
  const parts = action.url.split(new RegExp(NAME.source, "g"));
  // parts: literal, name, literal, name, …
  const names: string[] = [];
  let pattern = "^";
  parts.forEach((part, i) => {
    if (i % 2 === 0) pattern += part.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    else {
      names.push(part);
      pattern += "([^/?#]+?)";
    }
  });
  const match = names.length ? new RegExp(`${pattern}$`).exec(example.url) : null;
  if (match) names.forEach((name, i) => {
    if (own(name)) {
      try {
        out[name] = decodeURIComponent(match[i + 1]!);
      } catch {
        out[name] = match[i + 1]!;
      }
    }
  });
  for (const [key, value] of Object.entries(action.query)) {
    const name = typeof value === "string" ? new RegExp(`^${NAME.source}$`).exec(value)?.[1] : undefined;
    if (name && own(name) && example.query[key] !== undefined) out[name] = example.query[key]!;
  }
  const body = example.body;
  if (typeof action.body === "object" && action.body !== null && typeof body === "object" && body !== null) {
    for (const [key, value] of Object.entries(action.body)) {
      const name = typeof value === "string" ? new RegExp(`^${NAME.source}$`).exec(value)?.[1] : undefined;
      const given = (body as Record<string, unknown>)[key];
      if (name && own(name) && given !== undefined && given !== null && typeof given !== "object") out[name] = String(given);
    }
  }
  return out;
}

/** Stopwords left out of a new action's name. */
const FILLER = new Set(["a", "an", "the", "by", "its", "their", "his", "her", "my", "our", "your", "for", "of", "to", "from", "with", "and", "or", "in", "on", "at", "when", "if", "customer", "customers", "customer's", "someone", "someone's", "let", "lets", "them", "it", "ai", "can", "should", "be", "able"]);

/** A new action's file name from what it should do: "Look up an order by its number" → look_up_order. */
export function actionName(sentence: string): string {
  const words = sentence.toLowerCase().replace(/[^a-z0-9' ]+/g, " ").split(/\s+/).filter((w) => w && !FILLER.has(w)).map((w) => w.replace(/'/g, ""));
  const name = words.slice(0, 3).join("_").replace(/^[^a-z]+/, "").slice(0, 40).replace(/_+$/, "");
  return name || "new_action";
}

/** More words a task's "when" sentence has that say nothing about it. */
const WHEN_FILLER = new Set(["asks", "ask", "asking", "wants", "want", "wanting", "needs", "need", "would", "like", "where", "what", "why", "how", "which", "who", "is", "are", "was", "about", "they", "help", "tell", "know", "says", "say", "has", "have", "do", "does", "get", "some", "any", "this", "that"]);

/** AI-27: a task's folder name from when it applies: "The customer asks where their order is" → order. */
export function taskName(when: string): string {
  const words = when.toLowerCase().replace(/[^a-z0-9' ]+/g, " ").split(/\s+/).map((w) => w.replace(/'s$/, "").replace(/'/g, "")).filter((w) => w && !FILLER.has(w) && !WHEN_FILLER.has(w));
  const name = words.slice(0, 3).join("-").replace(/^[^a-z0-9]+/, "").slice(0, 40).replace(/-+$/, "");
  return name || "new-task";
}
