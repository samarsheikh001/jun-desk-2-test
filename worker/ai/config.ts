import { parse as parseYaml } from "yaml";
import { compileTemplate } from "../../shared/jinja.ts";
import { INTENT_NAME, MAX_INTENT_EXIT, MAX_INTENT_OPENING, MAX_INTENT_REPLIES, MAX_INTENT_REPLY, type IntentSpec } from "../../shared/intents.ts";
import { DONE_TOOL } from "../../shared/actions.ts";
import { checkExamples, parseWidgetFile, renderSummary, renderWidget, SHOW_WIDGET_TOOL, TOOL_ACTION, widgetActions, type WidgetSpec } from "../../shared/widgets.ts";
import { FLAG_TOOL, HANDOFF_TOOL } from "./agent.ts";

/** The agent's own tools: a tools/<name>.yaml can't take their names. */
const BUILT_IN_TOOLS = new Set([HANDOFF_TOOL, FLAG_TOOL, DONE_TOOL, SHOW_WIDGET_TOOL, "activate_skill"]);

// Support agent as code (AI-18). A config is a set of text files, the same in git and in the desk:
//   AGENTS.md                 persona, tone, rules; optional frontmatter guardrails
//   skills/<name>/SKILL.md    procedures (Agent Skills format: name + description frontmatter;
//                             optional intent/opening/replies/exit for AI-20 intent-launched chats)
//   tools/<name>.yaml         HTTP lookups the AI may call (AI-05)
//   evals/<name>.yaml         test cases for `jun eval` (AI-19)
//   widgets/<name>.widget     cards a tool's result is shown as (W-09: ChatKit Studio's export)
// Parsing is pure so the Worker, tests and the eval runner share it.

export const MAX_CONFIG_FILES = 200;
export const MAX_CONFIG_BYTES = 256 * 1024;
export const DEFAULT_MAX_REPLIES = 8;

export interface Skill {
  name: string;
  description: string;
  instructions: string;
  /** AI-20: the host app can open a chat with this intent (JunDesk.open({ intent })); this skill is its procedure. */
  intent?: IntentSpec;
}

export interface ToolInput {
  type: "string" | "number" | "integer" | "boolean";
  description?: string;
  required: boolean;
  enum?: string[];
}

export interface ToolSpec {
  name: string;
  description: string;
  method: "GET" | "POST";
  /** "" (W-28): the action only shows its widget, with the widget's example data and the AI's inputs; nothing is called. */
  url: string;
  headers: Record<string, string>;
  query: Record<string, string>;
  body?: unknown;
  input: Record<string, ToolInput>;
  /** Keep only these top-level fields of a JSON response (less noise for the model). */
  pick?: string[];
  /** Canned response used instead of the real call by `jun eval --mock-tools`. */
  mock?: unknown;
  /** What the visitor sees while the AI uses this tool ("Checking your order"); never the tool's name or data. */
  status?: string;
  /** AI-21: offer this tool only on these page paths ("/orders/*"); none means everywhere. */
  pages?: string[];
  /** W-09: show a successful result to the customer as this widget (`widgets/<name>.widget`). */
  widget?: string;
  /**
   * W-27: when a widget's button ran this action, the line the card shows (Jinja over what was
   * entered and the result): `widgetDone` on success (the card folds to it, and the AI doesn't
   * answer the press unless the action shows a widget), `widgetFailed` on an error (the card stays
   * open with it, nothing is sent). Never used when the AI calls the action itself.
   */
  widgetDone?: string;
  widgetFailed?: string;
}

/** `action`: AI-21, the reply proposed a page action (the card), with or without text. */
export type EvalOutcome = "answer" | "handoff" | "escalate" | "action";

/** AI-21: a page action a test case puts on the customer's page (the WebMCP shape, plus `mock`). */
export interface EvalAction {
  name: string;
  description: string;
  inputSchema?: unknown;
  risk?: string;
  context?: unknown;
  key?: string;
  /** What the page would return when it runs; fed back as the result for later turns. */
  mock?: string;
}

export interface EvalCase {
  file: string;
  name: string;
  messages: string[];
  /** AI-20: run the case as a chat the host app opened with this intent (JunDesk.open({ intent })). */
  intent?: string;
  /** AI-21: the actions on the customer's page for every turn of the case. */
  actions?: EvalAction[];
  /** AI-21: the page path the customer is on, for tools and actions with `pages`. */
  page?: string;
  /** `widget`: W-09, the reply shows this card. */
  expect: { outcome?: EvalOutcome; tools?: string[]; criteria?: string; action?: { name: string; input?: Record<string, unknown> }; widget?: string };
}

export interface AgentConfig {
  /** Saved version, or null for the built-in default. */
  version: number | null;
  /** AGENTS.md without frontmatter. */
  persona: string;
  maxReplies: number;
  /** Topics the AI must always hand to a person. */
  handoffTopics: string[];
  skills: Skill[];
  tools: ToolSpec[];
  evals: EvalCase[];
  /** W-09: cards tools can show their results as. */
  widgets: WidgetSpec[];
  /** D-74: website-actions.yaml: how each action on the customer's site runs, over the site's own setting. */
  websiteActionRisk: Record<string, "auto" | "confirm" | "human">;
  /** D-77: website-actions.yaml: the line the customer sees while each one runs (`status:`). */
  websiteActionStatus: Record<string, string>;
}

/**
 * D-74 / D-77: website-actions.yaml, a map of action name → how it runs (auto, confirm or human), or
 * a map with `run:` and `status:` (the line the customer sees while it runs, ≤ 60 characters).
 */
function parseWebsiteActions(path: string, text: string, issues: ConfigIssue[]): { risk: AgentConfig["websiteActionRisk"]; status: AgentConfig["websiteActionStatus"] } {
  const data = yaml(path, text, issues);
  const risk: AgentConfig["websiteActionRisk"] = {};
  const status: AgentConfig["websiteActionStatus"] = {};
  if (data === undefined || data === null) return { risk, status };
  if (!isRecord(data)) {
    issues.push({ path, message: "website-actions.yaml is a map of action name: auto, confirm or human (or run: and status:)." });
    return { risk, status };
  }
  const RUN = "use auto (runs without asking), confirm (the customer confirms first) or human (a person does it)";
  for (const [name, value] of Object.entries(data)) {
    if (!/^[\w.-]{1,64}$/.test(name)) {
      issues.push({ path, message: `${name}: not a website action's name.` });
      continue;
    }
    const entry = isRecord(value) ? value : { run: value };
    unknownKeys(path, entry, ["run", "status"], issues, `${name}: `);
    if (entry.run !== undefined) {
      if (ACTION_RISKS.includes(entry.run as (typeof ACTION_RISKS)[number])) risk[name] = entry.run as (typeof ACTION_RISKS)[number];
      else issues.push({ path, message: `${name}: ${RUN}.` });
    }
    if (entry.status !== undefined) {
      if (typeof entry.status === "string" && entry.status.trim() && entry.status.trim().length <= 60) status[name] = entry.status.trim();
      else issues.push({ path, message: `${name}: status is one short line (at most 60 characters), like "Setting your pickup".` });
    }
  }
  return { risk, status };
}

export interface ConfigIssue {
  path: string;
  message: string;
}

export type ConfigFiles = Record<string, string>;

export const DEFAULT_AGENTS_MD = `---
# Guardrails. Remove a line to use the default.
maxReplies: 8            # AI replies per conversation before a person takes over
handoffTopics:           # always hand these to a person
  - legal or security questions
---
# How to talk to customers

- Be friendly, concise and specific. A few short sentences or a short list.
- Use the customer's name if you know it.
- Don't promise refunds, credits, discounts or timelines unless a procedure says you can.
`;

/** The config a workspace starts with: the old Settings guidance (if any) becomes AGENTS.md. */
export function defaultFiles(instructions = ""): ConfigFiles {
  const extra = instructions.trim() ? `\n# Guidance from the team\n\n${instructions.trim()}\n` : "";
  return { "AGENTS.md": DEFAULT_AGENTS_MD + extra };
}

const SKILL_PATH = /^skills\/([a-z0-9]+(?:-[a-z0-9]+)*)\/SKILL\.md$/;
const TOOL_PATH = /^tools\/([a-z][a-z0-9_]*)\.ya?ml$/;
const EVAL_PATH = /^evals\/([a-zA-Z0-9_-]+)\.ya?ml$/;
const WIDGET_PATH = /^widgets\/([a-z][a-z0-9_-]*)\.widget$/;
/** D-74 / D-77: how each action on the customer's website runs, and its line, set on the desk. */
export const WEBSITE_ACTIONS_PATH = "website-actions.yaml";
const ACTION_RISKS = ["auto", "confirm", "human"] as const;
export const MAX_WIDGETS = 20;
const PLACEHOLDER = /\{([a-zA-Z_][a-zA-Z0-9_.]*)\}/g;

export function isConfigPath(path: string): boolean {
  return path === "AGENTS.md" || path === "README.md" || path === WEBSITE_ACTIONS_PATH || SKILL_PATH.test(path) || TOOL_PATH.test(path) || EVAL_PATH.test(path) || WIDGET_PATH.test(path);
}

/** Splits `---\nyaml\n---\nbody`. Returns null frontmatter when there is none. */
export function splitFrontmatter(text: string): { frontmatter: string | null; body: string } {
  const normalized = text.replace(/\r\n/g, "\n");
  const match = /^---\n([\s\S]*?)\n---[ \t]*(?:\n|$)/.exec(normalized);
  if (!match) return { frontmatter: null, body: normalized };
  return { frontmatter: match[1]!, body: normalized.slice(match[0].length) };
}

function yaml(path: string, source: string, issues: ConfigIssue[]): unknown {
  try {
    return parseYaml(source, { prettyErrors: true }) ?? {};
  } catch (error) {
    issues.push({ path, message: `Invalid YAML: ${(error as Error).message.split("\n")[0]}` });
    return undefined;
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function unknownKeys(path: string, value: Record<string, unknown>, allowed: string[], issues: ConfigIssue[], where = ""): void {
  for (const key of Object.keys(value)) {
    if (!allowed.includes(key)) issues.push({ path, message: `Unknown key "${where}${key}". Allowed: ${allowed.join(", ")}.` });
  }
}

function stringMap(path: string, value: unknown, field: string, issues: ConfigIssue[]): Record<string, string> {
  if (value === undefined) return {};
  if (!isRecord(value)) {
    issues.push({ path, message: `"${field}" must be a map of names to values.` });
    return {};
  }
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(value)) {
    if (typeof v === "string" || typeof v === "number" || typeof v === "boolean") out[k] = String(v);
    else issues.push({ path, message: `"${field}.${k}" must be a string.` });
  }
  return out;
}

function parseAgentsMd(text: string, issues: ConfigIssue[]): Pick<AgentConfig, "persona" | "maxReplies" | "handoffTopics"> {
  const { frontmatter, body } = splitFrontmatter(text);
  const out = { persona: body.trim(), maxReplies: DEFAULT_MAX_REPLIES, handoffTopics: [] as string[] };
  if (frontmatter === null) return out;
  const data = yaml("AGENTS.md", frontmatter, issues);
  if (data === undefined) return out;
  if (!isRecord(data)) {
    issues.push({ path: "AGENTS.md", message: "Frontmatter must be a YAML map." });
    return out;
  }
  unknownKeys("AGENTS.md", data, ["maxReplies", "handoffTopics"], issues);
  if (data.maxReplies !== undefined) {
    const n = data.maxReplies;
    if (typeof n === "number" && Number.isInteger(n) && n >= 1 && n <= 50) out.maxReplies = n;
    else issues.push({ path: "AGENTS.md", message: "maxReplies must be a whole number from 1 to 50." });
  }
  if (data.handoffTopics !== undefined) {
    if (Array.isArray(data.handoffTopics) && data.handoffTopics.every((t) => typeof t === "string" && t.trim())) {
      out.handoffTopics = (data.handoffTopics as string[]).map((t) => t.trim()).slice(0, 30);
    } else {
      issues.push({ path: "AGENTS.md", message: "handoffTopics must be a list of short descriptions." });
    }
  }
  return out;
}

function parseSkill(path: string, folder: string, text: string, issues: ConfigIssue[]): Skill | null {
  const { frontmatter, body } = splitFrontmatter(text);
  if (frontmatter === null) {
    issues.push({ path, message: "SKILL.md needs frontmatter with name and description (---\\nname: …\\ndescription: …\\n---)." });
    return null;
  }
  const data = yaml(path, frontmatter, issues);
  if (!isRecord(data)) {
    if (data !== undefined) issues.push({ path, message: "Frontmatter must be a YAML map." });
    return null;
  }
  // Agent Skills fields we don't use (license, metadata, …) are allowed and ignored.
  const name = typeof data.name === "string" ? data.name.trim() : "";
  const description = typeof data.description === "string" ? data.description.trim() : "";
  if (name !== folder) issues.push({ path, message: `name must match the folder name ("${folder}").` });
  if (!description) issues.push({ path, message: "description is required: say when this procedure applies." });
  else if (description.length > 1024) issues.push({ path, message: "description must be at most 1024 characters." });
  if (!body.trim()) issues.push({ path, message: "The procedure itself (below the frontmatter) is empty." });
  const before = issues.length;
  const intent = parseIntent(path, data, issues);
  if (name !== folder || !description || description.length > 1024 || !body.trim() || issues.length > before) return null;
  return { name, description, instructions: body.trim(), ...(intent ? { intent } : {}) };
}

/** One line of plain text for the widget: shown as is, so no line breaks. */
function oneLine(value: unknown, max: number): string | null {
  const text = typeof value === "string" ? value.trim() : "";
  return text && text.length <= max && !/[^\S ]/.test(text) ? text : null;
}

/** AI-20 frontmatter: `intent` (name), `opening`, `replies`, `exit`. Null when the skill has no intent. */
function parseIntent(path: string, data: Record<string, unknown>, issues: ConfigIssue[]): IntentSpec | null {
  const extras = (["opening", "replies", "exit"] as const).filter((k) => data[k] !== undefined);
  if (data.intent === undefined) {
    if (extras.length) issues.push({ path, message: `${extras.join(", ")} only apply with intent: <name> (the name your app passes to JunDesk.open).` });
    return null;
  }
  if (typeof data.intent !== "string" || !INTENT_NAME.test(data.intent)) {
    issues.push({ path, message: "intent must be a short name of lowercase letters, digits, _ or - (like cancel), at most 40 characters." });
    return null;
  }
  let opening: string | null = null;
  if (data.opening !== undefined) {
    opening = oneLine(data.opening, MAX_INTENT_OPENING);
    if (!opening) issues.push({ path, message: `opening must be one line of text, at most ${MAX_INTENT_OPENING} characters.` });
  }
  let replies: string[] = [];
  if (data.replies !== undefined) {
    const list = Array.isArray(data.replies) ? data.replies.map((r) => oneLine(typeof r === "number" ? String(r) : r, MAX_INTENT_REPLY)) : null;
    if (!list || list.some((r) => r === null) || list.length > MAX_INTENT_REPLIES) {
      issues.push({ path, message: `replies must be a list of at most ${MAX_INTENT_REPLIES} short answers (each at most ${MAX_INTENT_REPLY} characters).` });
    } else {
      replies = [...new Set(list as string[])];
    }
  }
  if (replies.length && !opening) issues.push({ path, message: "replies need an opening (the question they answer)." });
  let exit: string | null = null;
  if (data.exit !== undefined) {
    exit = oneLine(data.exit, MAX_INTENT_EXIT);
    if (!exit) issues.push({ path, message: `exit must be a short button label, like "Cancel anyway" (at most ${MAX_INTENT_EXIT} characters).` });
  }
  return { name: data.intent, opening, replies, exit };
}

const INPUT_TYPES = ["string", "number", "integer", "boolean"] as const;
/** The visitor's label for a tool call without its own `status:`. */
export const DEFAULT_TOOL_STATUS = "Looking that up";
export const MAX_TOOL_STATUS = 60;
/** W-27: a `widget_done` / `widget_failed` template's length. */
export const MAX_TOOL_LINE = 200;

/** An address with a site in it once its {placeholders} are filled ("https://" alone isn't). */
function wholeUrl(url: string): boolean {
  try {
    const parsed = new URL(url.replace(PLACEHOLDER, "x"));
    return parsed.hostname.length > 0 && !parsed.hostname.startsWith(".");
  } catch {
    return false;
  }
}

function parseTool(path: string, name: string, text: string, issues: ConfigIssue[]): ToolSpec | null {
  const data = yaml(path, text, issues);
  if (data === undefined) return null;
  if (!isRecord(data)) {
    issues.push({ path, message: "A tool file must be a YAML map." });
    return null;
  }
  const before = issues.length;
  unknownKeys(path, data, ["description", "method", "url", "headers", "query", "body", "input", "pick", "mock", "status", "pages", "widget", "widget_done", "widget_failed"], issues);
  const pages = Array.isArray(data.pages) && data.pages.length > 0 && data.pages.every((p) => typeof p === "string" && p.startsWith("/")) ? (data.pages as string[]) : undefined;
  if (data.pages !== undefined && !pages) issues.push({ path, message: 'pages must be a list of paths like "/pricing" or "/plans/*".' });
  const widget = typeof data.widget === "string" ? data.widget.trim() : undefined;
  if (data.widget !== undefined && !(widget && /^[a-z][a-z0-9_-]*$/.test(widget))) issues.push({ path, message: "widget must be the name of a file in widgets/ (widget: order_status for widgets/order_status.widget)." });

  const description = typeof data.description === "string" ? data.description.trim() : "";
  if (!description) issues.push({ path, message: "description is required: tell the AI what this returns and when to use it." });

  const method = String(data.method ?? "GET").toUpperCase();
  if (method !== "GET" && method !== "POST") issues.push({ path, message: "method must be GET or POST." });

  const url = typeof data.url === "string" ? data.url.trim() : "";
  // W-28: an action that only shows its widget needs no address; any other needs a whole one.
  if (!url) {
    if (!widget) issues.push({ path, message: "url is required: the address to call, like https://api.acme.com/orders/{order_id}. (Only an action that just shows a widget can leave it out.)" });
  } else if (!/^https?:\/\//.test(url)) {
    issues.push({ path, message: "url must start with https:// (or http://)." });
  } else if (!wholeUrl(url)) {
    issues.push({ path, message: `url "${url}" isn't a whole address yet: add the site and path, like https://api.acme.com/orders/{order_id}.` });
  }

  const input: Record<string, ToolInput> = {};
  if (data.input !== undefined && !isRecord(data.input)) issues.push({ path, message: "input must be a map of parameter names." });
  for (const [key, raw] of Object.entries(isRecord(data.input) ? data.input : {})) {
    if (!/^[a-zA-Z_][a-zA-Z0-9_]*$/.test(key)) {
      issues.push({ path, message: `Input name "${key}" must be letters, digits and underscores.` });
      continue;
    }
    const spec = isRecord(raw) ? raw : { type: raw };
    unknownKeys(path, spec, ["type", "description", "required", "enum"], issues, `input.${key}.`);
    const type = String(spec.type ?? "string");
    if (!(INPUT_TYPES as readonly string[]).includes(type)) {
      issues.push({ path, message: `input.${key}.type must be one of ${INPUT_TYPES.join(", ")}.` });
      continue;
    }
    if (spec.enum !== undefined && !(Array.isArray(spec.enum) && spec.enum.every((v) => typeof v === "string"))) {
      issues.push({ path, message: `input.${key}.enum must be a list of strings.` });
    }
    input[key] = {
      type: type as ToolInput["type"],
      required: spec.required !== false,
      ...(typeof spec.description === "string" ? { description: spec.description } : {}),
      ...(Array.isArray(spec.enum) ? { enum: spec.enum.map(String) } : {}),
    };
  }

  const headers = stringMap(path, data.headers, "headers", issues);
  const query = stringMap(path, data.query, "query", issues);
  if (data.body !== undefined && method !== "POST") issues.push({ path, message: "body is only sent with method: POST." });
  let pick: string[] | undefined;
  if (data.pick !== undefined) {
    if (Array.isArray(data.pick) && data.pick.every((p) => typeof p === "string")) pick = data.pick as string[];
    else issues.push({ path, message: "pick must be a list of field names." });
  }

  // Shown to visitors as is, so plain text only: no placeholders, no line breaks.
  let status: string | undefined;
  if (data.status !== undefined) {
    const value = typeof data.status === "string" ? data.status.trim() : "";
    if (!value) issues.push({ path, message: 'status must be a short text for the customer, like "Checking your order".' });
    else if (/[^\S ]/.test(value)) issues.push({ path, message: "status must be one line of plain text." });
    else if (value.length > MAX_TOOL_STATUS) issues.push({ path, message: `status must be at most ${MAX_TOOL_STATUS} characters.` });
    else if (/[{}]/.test(value)) issues.push({ path, message: "status is shown as is: no {placeholders}." });
    else status = value;
  }

  // W-27: the card's line after a widget's button ran this action: one short Jinja template each.
  const lines: { widgetDone?: string; widgetFailed?: string } = {};
  for (const [key, field] of [["widget_done", "widgetDone"], ["widget_failed", "widgetFailed"]] as const) {
    if (data[key] === undefined) continue;
    const value = typeof data[key] === "string" ? data[key].trim() : "";
    if (!value || value.length > MAX_TOOL_LINE) {
      issues.push({ path, message: `${key} must be one short line for the customer (at most ${MAX_TOOL_LINE} characters), like "Thanks {{ name }}, we'll be in touch."` });
      continue;
    }
    try {
      compileTemplate(value);
      lines[field] = value;
    } catch (error) {
      issues.push({ path, message: `${key}: ${(error as Error).message}` });
    }
  }

  // Every {placeholder} must be an input or a secret.
  const templated = [url, ...Object.values(headers), ...Object.values(query), JSON.stringify(data.body ?? null)];
  for (const source of templated) {
    for (const [, ref] of source.matchAll(PLACEHOLDER)) {
      if (ref!.startsWith("secrets.")) {
        if (!/^secrets\.[A-Z][A-Z0-9_]*$/.test(ref!)) issues.push({ path, message: `{${ref}}: secret names are UPPER_SNAKE_CASE.` });
      } else if (ref!.startsWith("user.secrets.")) {
        // AI-24: the customer's own key, from their identity token's `secrets` claim.
        if (!/^user\.secrets\.[A-Z][A-Z0-9_]*$/.test(ref!)) issues.push({ path, message: `{${ref}}: the customer's key names are UPPER_SNAKE_CASE, like {user.secrets.API_TOKEN}.` });
      } else if (ref!.startsWith("user.")) {
        // The signed-in customer, verified by the host app's identity token (V-03).
        if (!/^user\.[a-zA-Z_][a-zA-Z0-9_]*$/.test(ref!)) issues.push({ path, message: `{${ref}}: use {user.id}, {user.email}, {user.name} or {user.<attribute>}.` });
      } else if (!input[ref!]) {
        issues.push({ path, message: `{${ref}} isn't an input. Add it under input:, {user.id} (signed-in customer), or {secrets.NAME}.` });
      }
    }
  }
  for (const source of [url, ...Object.values(query)]) {
    if (/\{secrets\./.test(source)) issues.push({ path, message: "Put secrets in headers, not the URL or query (URLs end up in logs)." });
  }
  for (const source of [url, ...Object.values(query), JSON.stringify(data.body ?? null)]) {
    if (/\{user\.secrets\./.test(source)) issues.push({ path, message: "Put the customer's keys ({user.secrets.…}) in headers only." });
  }

  if (issues.length > before) return null;
  return {
    name,
    description,
    method: method as ToolSpec["method"],
    url,
    headers,
    query,
    ...(data.body !== undefined ? { body: data.body } : {}),
    ...(pages ? { pages } : {}),
    ...(widget ? { widget } : {}),
    input,
    ...(pick ? { pick } : {}),
    ...(data.mock !== undefined ? { mock: data.mock } : {}),
    ...(status ? { status } : {}),
    ...lines,
  };
}

/** W-09: a `.widget` file. When it carries the data it was designed with (ChatKit Studio does), it must render with it. */
function parseWidget(path: string, name: string, text: string, issues: ConfigIssue[]): WidgetSpec | null {
  try {
    const spec = parseWidgetFile(name, text);
    // W-29: the AI fills the card in the shape of its example data, so it needs some.
    if (spec.aiFill && !spec.sample) throw new Error('aiFill needs example data ("sample"): the AI fills the card in its shape.');
    if (spec.sample) {
      renderWidget(spec, spec.sample);
      renderSummary(spec, spec.sample);
    }
    // W-30: the example data and every named state must fit the schema (when the file has one) and draw.
    checkExamples(spec);
    return spec;
  } catch (error) {
    issues.push({ path, message: (error as Error).message });
    return null;
  }
}

const OUTCOMES: EvalOutcome[] = ["answer", "handoff", "escalate", "action"];

function parseEvals(path: string, text: string, issues: ConfigIssue[]): EvalCase[] {
  const data = yaml(path, text, issues);
  if (data === undefined) return [];
  if (!Array.isArray(data)) {
    issues.push({ path, message: "An eval file is a YAML list of cases (- name: …)." });
    return [];
  }
  const cases: EvalCase[] = [];
  data.forEach((raw, i) => {
    const where = `case ${i + 1}`;
    if (!isRecord(raw)) {
      issues.push({ path, message: `${where}: must be a map with name, message(s) and expect.` });
      return;
    }
    unknownKeys(path, raw, ["name", "message", "messages", "intent", "actions", "page", "expect"], issues, `${where}: `);
    if (raw.page !== undefined && !(typeof raw.page === "string" && raw.page.startsWith("/"))) {
      issues.push({ path, message: `${where}: page must be a path like /pricing.` });
      return;
    }
    const name = typeof raw.name === "string" && raw.name.trim() ? raw.name.trim() : where;
    const messages =
      typeof raw.message === "string" ? [raw.message]
      : Array.isArray(raw.messages) && raw.messages.every((m) => typeof m === "string") ? (raw.messages as string[])
      : [];
    if (!messages.length || messages.some((m) => !m.trim())) {
      issues.push({ path, message: `${name}: give the customer's message (message: "…") or messages (a list).` });
      return;
    }
    if (raw.intent !== undefined && !(typeof raw.intent === "string" && INTENT_NAME.test(raw.intent))) {
      issues.push({ path, message: `${name}: intent must be an intent name (like cancel), as your app passes to JunDesk.open.` });
      return;
    }
    const actions: EvalAction[] = [];
    if (raw.actions !== undefined) {
      if (!Array.isArray(raw.actions)) {
        issues.push({ path, message: `${name}: actions must be a list of page actions (name, description, inputSchema…).` });
        return;
      }
      for (const [j, a] of raw.actions.entries()) {
        if (!isRecord(a) || typeof a.name !== "string" || !a.name.trim() || typeof a.description !== "string" || !a.description.trim()) {
          issues.push({ path, message: `${name}: actions[${j}] needs a name and a description.` });
          return;
        }
        unknownKeys(path, a, ["name", "description", "inputSchema", "risk", "context", "key", "mock", "annotations"], issues, `${name}: actions[${j}].`);
        actions.push({
          name: a.name.trim(),
          description: a.description.trim(),
          ...(a.inputSchema !== undefined ? { inputSchema: a.inputSchema } : {}),
          ...(typeof a.risk === "string" ? { risk: a.risk } : {}),
          ...(a.context !== undefined ? { context: a.context } : {}),
          ...(typeof a.key === "string" ? { key: a.key } : {}),
          ...(typeof a.mock === "string" ? { mock: a.mock } : {}),
        });
      }
    }
    const expect: EvalCase["expect"] = {};
    if (raw.expect !== undefined) {
      if (!isRecord(raw.expect)) {
        issues.push({ path, message: `${name}: expect must be a map.` });
        return;
      }
      unknownKeys(path, raw.expect, ["outcome", "tools", "criteria", "action", "widget"], issues, `${name}: expect.`);
      if (raw.expect.widget !== undefined) {
        if (typeof raw.expect.widget === "string" && raw.expect.widget.trim()) expect.widget = raw.expect.widget.trim();
        else issues.push({ path, message: `${name}: expect.widget must be a widget name (widgets/<name>.widget).` });
      }
      if (raw.expect.outcome !== undefined) {
        if (OUTCOMES.includes(raw.expect.outcome as EvalOutcome)) expect.outcome = raw.expect.outcome as EvalOutcome;
        else issues.push({ path, message: `${name}: expect.outcome must be one of ${OUTCOMES.join(", ")}.` });
      }
      if (raw.expect.tools !== undefined) {
        if (Array.isArray(raw.expect.tools) && raw.expect.tools.every((t) => typeof t === "string")) expect.tools = raw.expect.tools as string[];
        else issues.push({ path, message: `${name}: expect.tools must be a list of tool names.` });
      }
      if (raw.expect.criteria !== undefined) {
        if (typeof raw.expect.criteria === "string" && raw.expect.criteria.trim()) expect.criteria = raw.expect.criteria.trim();
        else issues.push({ path, message: `${name}: expect.criteria must be a sentence describing a good reply.` });
      }
      if (raw.expect.action !== undefined) {
        const a = raw.expect.action;
        if (typeof a === "string" && a.trim()) expect.action = { name: a.trim() };
        else if (isRecord(a) && typeof a.name === "string" && a.name.trim()) {
          unknownKeys(path, a, ["name", "input"], issues, `${name}: expect.action.`);
          expect.action = { name: a.name.trim(), ...(isRecord(a.input) ? { input: a.input } : {}) };
        } else issues.push({ path, message: `${name}: expect.action must be an action name, or a map with name and input.` });
      }
    }
    cases.push({ file: path, name, messages, ...(typeof raw.intent === "string" ? { intent: raw.intent } : {}), ...(actions.length ? { actions } : {}), ...(typeof raw.page === "string" ? { page: raw.page } : {}), expect });
  });
  return cases;
}

/** AI-20: the skill that defines an intent, if any. */
export function intentSkill(config: Pick<AgentConfig, "skills">, name: string): Skill | null {
  return config.skills.find((s) => s.intent?.name === name) ?? null;
}

/** Parses and validates a config. Invalid files are reported and left out; it never throws. */
export function parseConfig(files: ConfigFiles, version: number | null = null): { config: AgentConfig; issues: ConfigIssue[] } {
  const issues: ConfigIssue[] = [];
  const paths = Object.keys(files).sort();
  if (paths.length > MAX_CONFIG_FILES) issues.push({ path: "", message: `At most ${MAX_CONFIG_FILES} files.` });
  const bytes = paths.reduce((n, p) => n + new TextEncoder().encode(files[p]!).length, 0);
  if (bytes > MAX_CONFIG_BYTES) issues.push({ path: "", message: `Config is ${Math.round(bytes / 1024)} KB; the limit is ${MAX_CONFIG_BYTES / 1024} KB.` });
  if (!("AGENTS.md" in files)) issues.push({ path: "AGENTS.md", message: "AGENTS.md is required (persona and rules)." });

  const config: AgentConfig = {
    version,
    ...parseAgentsMd(files["AGENTS.md"] ?? "", issues),
    skills: [],
    tools: [],
    evals: [],
    widgets: [],
    websiteActionRisk: {},
    websiteActionStatus: {},
  };
  for (const path of paths) {
    const text = files[path]!;
    let m: RegExpExecArray | null;
    if (path === "AGENTS.md" || path === "README.md") continue;
    if (path === WEBSITE_ACTIONS_PATH) {
      const parsed = parseWebsiteActions(path, text, issues);
      config.websiteActionRisk = parsed.risk;
      config.websiteActionStatus = parsed.status;
      continue;
    }
    if ((m = SKILL_PATH.exec(path))) {
      const skill = parseSkill(path, m[1]!, text, issues);
      const taken = skill?.intent && config.skills.find((s) => s.intent?.name === skill.intent!.name);
      if (taken) {
        issues.push({ path, message: `Intent "${skill!.intent!.name}" is already defined by skills/${taken.name}/SKILL.md (one skill per intent).` });
        continue;
      }
      if (skill) config.skills.push(skill);
    } else if ((m = TOOL_PATH.exec(path))) {
      if (BUILT_IN_TOOLS.has(m[1]!)) {
        issues.push({ path, message: `"${m[1]}" is a built-in tool name: rename this file.` });
        continue;
      }
      if (config.tools.some((t) => t.name === m![1])) {
        issues.push({ path, message: `Duplicate tool "${m[1]}" (.yaml and .yml).` });
        continue;
      }
      const tool = parseTool(path, m[1]!, text, issues);
      if (tool) config.tools.push(tool);
    } else if (EVAL_PATH.test(path)) {
      config.evals.push(...parseEvals(path, text, issues));
    } else if ((m = WIDGET_PATH.exec(path))) {
      const widget = parseWidget(path, m[1]!, text, issues);
      if (widget) config.widgets.push(widget);
    } else {
      issues.push({
        path,
        message: "Unknown file. Allowed: AGENTS.md, README.md, website-actions.yaml, skills/<name>/SKILL.md, tools/<name>.yaml, evals/<name>.yaml, widgets/<name>.widget (lowercase names).",
      });
    }
  }
  if (config.tools.length > 20) issues.push({ path: "tools/", message: "At most 20 tools." });
  if (config.widgets.length > MAX_WIDGETS) issues.push({ path: "widgets/", message: `At most ${MAX_WIDGETS} widgets.` });
  for (const tool of config.tools) {
    if (tool.widget && !config.widgets.some((w) => w.name === tool.widget)) {
      const file = paths.find((p) => TOOL_PATH.exec(p)?.[1] === tool.name) ?? `tools/${tool.name}.yaml`;
      issues.push({ path: file, message: `widget: there's no widgets/${tool.widget}.widget.` });
      delete tool.widget;
    }
  }
  // W-31: one card per website action.
  const shownBy = new Map<string, string>();
  for (const widget of config.widgets) {
    for (const name of widget.pageActions ?? []) {
      const other = shownBy.get(name);
      if (other) issues.push({ path: `widgets/${widget.name}.widget`, message: `pageActions: widgets/${other}.widget already shows ${name}.` });
      else shownBy.set(name, widget.name);
    }
  }
  // W-17: a button with `tool:<name>` must name a tool (checked on the widget's sample data).
  for (const widget of config.widgets) {
    if (!widget.sample) continue;
    let actions: string[] = [];
    try {
      actions = widgetActions(renderWidget(widget, widget.sample)).map((a) => a.action.type);
    } catch {
      continue; // reported when the file was parsed
    }
    for (const type of new Set(actions)) {
      const name = TOOL_ACTION.exec(type)?.[1];
      if (name && !config.tools.some((t) => t.name === name)) issues.push({ path: `widgets/${widget.name}.widget`, message: `${type}: there's no tools/${name}.yaml.` });
    }
  }
  return { config, issues };
}

/** The customer as verified by the host app (V-03), for {user.*} placeholders. */
export interface ToolUser {
  id: string;
  email: string | null;
  name: string | null;
  attributes: Record<string, string | number | boolean>;
  /** AI-24: their own keys ({user.secrets.NAME}, headers only), from their identity token while it's valid. */
  secrets?: Record<string, string>;
}

export class NotSignedInError extends Error {
  constructor() {
    super("The customer isn't signed in (no verified identity), so their account can't be looked up. Ask them to sign in, or hand off.");
  }
}

/** Values for {placeholders}: tool inputs, the verified customer, and secrets from Worker env vars JUN_SECRET_<NAME>. */
export function fillTemplate(
  template: string,
  input: Record<string, unknown>,
  secrets: (name: string) => string | undefined,
  encode: (s: string) => string = (s) => s,
  user: ToolUser | null = null,
): string {
  return template.replace(PLACEHOLDER, (_, ref: string) => {
    if (ref.startsWith("user.secrets.")) {
      if (!user) throw new NotSignedInError();
      const name = ref.slice("user.secrets.".length);
      const value = user.secrets?.[name];
      // Never the workspace's key instead: this request acts as the customer.
      if (value === undefined) throw new Error(`The customer's ${name} isn't available (their sign-in has expired or doesn't include it). Ask them to reload the page or sign in again.`);
      return value;
    }
    if (ref.startsWith("user.")) {
      if (!user) throw new NotSignedInError();
      const field = ref.slice("user.".length);
      const value = field === "id" ? user.id : field === "email" ? user.email : field === "name" ? user.name : user.attributes[field];
      if (value === undefined || value === null) throw new Error(`The signed-in customer has no ${field}.`);
      return encode(String(value));
    }
    if (ref.startsWith("secrets.")) {
      const value = secrets(ref.slice("secrets.".length));
      if (value === undefined) throw new Error(`The key ${ref.slice(8)} isn't added (on the action's page, or as the Worker secret JUN_SECRET_${ref.slice(8)}).`);
      return value;
    }
    const value = input[ref];
    return value === undefined || value === null ? "" : encode(String(value));
  });
}
